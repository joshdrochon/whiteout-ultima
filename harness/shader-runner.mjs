#!/usr/bin/env node
// ============================================================================
// Shader-lane gate runner — the OPERATIONAL DEFINITION of the 14 snow-visuals
// (SV) gates in references/PHYSICS_GATES.json. Serves the accepted render loop
// (src/render) + a candidate snow module, drives harness/shader-page.html in
// headless Chrome, and evaluates every gate from in-page gl.readPixels
// analysis and the candidate's contract debug hooks. No scores; pass/fail.
//
// usage: node harness/shader-runner.mjs --module harness/baseline-snow
//        [--gates SV-01,SV-07] [--out <metrics.json>] [--real-gpu]
//        [--perf-seconds N] [--decay-frames N]
//
// Every measurement's operational definition is documented at its impl below.
// Gates that cannot be measured in this environment (SV-13 on software GL)
// or without an optional hook (SV-11 without particleSpeeds) are reported as
// 'deferred' with the reason — never silently passed.
// ============================================================================
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const flag = n => args.includes('--' + n);

const modDir = resolve(ROOT, opt('module', 'harness/baseline-snow'));
const onlyGates = opt('gates', '') ? opt('gates').split(',') : null;
const outPath = resolve(ROOT, opt('out', join(modDir, '_capture', 'metrics.json')));
const outDir = dirname(outPath);
const realGpu = flag('real-gpu');
const perfSeconds = Number(opt('perf-seconds', realGpu ? 20 : 5));
const decayFrames = Number(opt('decay-frames', 3600));
if (!existsSync(modDir)) { console.error('no such candidate dir: ' + modDir); process.exit(1); }

const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'snow-visuals');

// ---------- static server: probe page + render loop + candidate -------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glsl': 'text/plain', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    let file;
    if (url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (url === '/' || url === '/index.html') file = join(ROOT, 'harness', 'shader-page.html');
    else if (url.startsWith('/render/')) file = join(ROOT, 'src', 'render', url.slice('/render/'.length));
    else if (url.startsWith('/candidate/')) file = join(modDir, url.slice('/candidate/'.length));
    else if (url.startsWith('/node_modules/')) file = join(ROOT, url);
    else { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: realGpu
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist']
    : ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
       '--use-gl=angle', '--ignore-gpu-blocklist'],
});

const consoleErrors = [];
let rendererString = null;
let siteInfo = null;

// Fresh page per gate: full isolation (trail state, spray state, RNG stream,
// camera) so gate order can never influence a measurement.
async function newProbePage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 300)));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(
    '(window.__probe && window.__probe.ready === true) || (window.__gauntlet && window.__gauntlet.ready === "failed")',
    { timeout: 90000 });
  const boot = await page.evaluate('window.__gauntlet');
  if (boot.ready === 'failed') throw new Error('boot failed: ' + boot.errors.join(' | ').slice(0, 500));
  const hooks = await page.evaluate('window.__probe.hooks');
  for (const h of ['stamp', 'trailHeightAt', 'particleCount', 'setSunDir'])
    if (!hooks[h]) throw new Error(`candidate missing required debug hook: ${h}`);
  if (!rendererString) rendererString = await page.evaluate('window.__probe.rendererString()');
  if (!siteInfo) siteInfo = await page.evaluate('window.__probe.site');
  return page;
}
const ev = (page, expr, arg) => arg === undefined
  ? page.evaluate(expr)
  : page.evaluate(new Function('p', `return (${expr})(p)`), arg);
async function steps(page, n, dt = 1 / 60) {   // chunked so no evaluate runs too long
  let left = n;
  while (left > 0) { const k = Math.min(300, left); await page.evaluate(`__probe.snowSteps(${k}, ${dt})`); left -= k; }
}
async function shot(page, name) {
  await mkdir(outDir, { recursive: true });
  await page.evaluate('__probe.render()');
  await page.screenshot({ path: join(outDir, name) });
}

// ---------- gate implementations (metric objects, physics-runner style) -----
// Keys starting with '_' are side data; '_...Ok' / '_...InBand' === false
// fails the row even when the headline metric is in band.
const impl = {

  // SV-01 (HARD). OPERATIONAL DEFINITION: terminator position on a side-lit
  // probe sphere carrying the candidate's snow material. Wrap diffuse
  // (NdotL+w)/(1+w) pushes the lit->ambient boundary into the geometric dark
  // half by ~w of the disk radius; pure lambert keeps it at the center line.
  // Pass iff the luminance profile's 6%-rise point sits at xf in [-0.75,
  // -0.13] (terminator visibly past center, consistent with w in ~0.2-0.65),
  // the profile genuinely rises (lit side > ambient + 0.1 linear), the dark
  // cap is not black (> 0.05), and a backlit center is < 60% of a front-lit
  // face (diffuse actually responds to sun direction — an always-lit fake
  // fails here, an unlit-at-NdotL=0 lambert fails the terminator position).
  async 'shader_probe:wrapDiffuse'(p, page) {
    const r = await ev(page, '__probe.wrapProbe', {});
    const pass = r.xfRise !== null
      && r.xfRise <= -0.13 && r.xfRise >= -0.75
      && (r.litMax - r.ambient) > 0.1
      && r.ambient > 0.05
      && r.centerLum < 0.6 * r.frontLum;
    return { wrapLightingPresent: pass ? 1 : 0, _terminatorXf: r.xfRise,
      _ambient: r.ambient, _litMax: r.litMax,
      _centerLum: r.centerLum, _frontLum: r.frontLum };
  },

  // SV-02 (TOLERANCE). OPERATIONAL DEFINITION: top-down view of lit snow;
  // glint pixel := linear luminance > max(1.45 * ROI median, median + 0.10).
  // Metric = glint fraction of the ROI (gate band 1-5%). Side check
  // (_viewDependentOk): the same ~1600 world points sampled through a camera
  // moved 12 deg in azimuth must lose >= 30% of their bright members —
  // separates view-dependent sparkle from static bright albedo speckle.
  async 'shader_probe:glints'(p, page) {
    const r = await ev(page, '__probe.glintProbe', {});
    await shot(page, 'probe-sv02-glints.png');
    return { glintPixelFrac: r.glintFrac, _lossFrac: r.lossFrac, _nGlintPts: r.nGlintPts,
      _viewDependentOk: r.lossFrac >= 0.3 };
  },

  // SV-03 (TOLERANCE). OPERATIONAL DEFINITION: probe sphere lit from the
  // side; outer quarter of the dark half = fully shadowed snow, outer quarter
  // of the bright half = fully lit. Pixels are inverse-sRGB-decoded to linear
  // before ratios. Metric = shadow B/R - 1 (gate band 0.2-0.6). Side checks:
  // shadow/lit luminance 35-55% (_shadowLumInBand), never < 10%
  // (_neverBlackOk).
  async 'shader_probe:shadowColor'(p, page) {
    const r = await ev(page, '__probe.shadowProbe', {});
    await shot(page, 'probe-sv03-shadow.png');
    const lumMin = p.alsoAssert?.shadowLuminanceFrac?.min ?? 0.35;
    const lumMax = p.alsoAssert?.shadowLuminanceFrac?.max ?? 0.55;
    return { shadowBlueOverRedFrac: r.bOverR - 1, _shadowLumFrac: r.lumFrac,
      _shadowLumInBand: r.lumFrac >= lumMin && r.lumFrac <= lumMax,
      _neverBlackOk: r.lumFrac >= 0.10 };
  },

  // SV-14 (STYLE). OPERATIONAL DEFINITION (partial, documented): machine-
  // checkable subset = (a) high-key: median linear luminance of a scenic
  // down-course framing >= 0.30; (b) shadows blue never black: SV-03's
  // measurements with a widened band (B/R excess 0.15-0.7, luminance >= 10%).
  // "Per-track gradient lighting" is permissive (no check); "big-trick
  // celebratory FX" is not observable through the attach contract and is left
  // to the blind critic — recorded in _notAssessed.
  async 'shader_probe:styleChecklist'(p, page) {
    const sh = await ev(page, '__probe.shadowProbe', {});
    const sty = await ev(page, '__probe.styleProbe', {});
    await shot(page, 'probe-sv14-style.png');
    const highKey = sty.p50Lum >= 0.30;
    const blueOk = (sh.bOverR - 1) >= 0.15 && (sh.bOverR - 1) <= 0.7 && sh.lumFrac >= 0.10;
    return { styleChecklistPasses: (highKey && blueOk) ? 1 : 0,
      _p50Lum: sty.p50Lum, _shadowBExcess: sh.bOverR - 1, _shadowLumFrac: sh.lumFrac,
      _notAssessed: 'celebratory FX (critic judges from gameplay captures)' };
  },

  // SV-04 (HARD). OPERATIONAL DEFINITION: stamp once, then run 60 update()
  // frames with NO further stamping. Trail persists iff trailHeightAt still
  // reports >= 50% of the initial depth (and > 5 mm) AND the rendered frame
  // still shows the stamp (>= 40 changed pixels vs the pre-stamp render of
  // the identical camera). A per-frame-rebuilt trail loses the stamp; a
  // decayed-to-nothing trail fails the 50% floor at 60 frames (0.9999^60 =
  // 0.994, so honest decay passes easily).
  async 'trail_probe:persistence'(p, page) {
    const s = siteInfo;
    await ev(page, `(o)=>{__probe.placeRider(o.x,o.z,{speed:0});
      const g=__probe.groundY(o.x+2,o.z);
      __probe.setCam(o.x+2,g+12,o.z-5,o.x+2,g,o.z,45);
      __probe.snap('pre'); return true}`, { x: s.x, z: s.z });
    const d0 = await ev(page, `(o)=>{__probe.stampAt(o.x+2,o.z,1.0);__probe.snowSteps(1);
      return __probe.trailAt(o.x+2,o.z)}`, { x: s.x, z: s.z });
    await steps(page, 59);
    const d1 = await ev(page, `(o)=>__probe.trailAt(o.x+2,o.z)`, { x: s.x, z: s.z });
    const diff = await ev(page, `(o)=>{__probe.snap('post');
      const c=__probe.project(o.x+2,__probe.groundY(o.x+2,o.z),o.z);
      return __probe.diffStats('pre','post',{x0:c[0]-140,x1:c[0]+140,y0:c[1]-140,y1:c[1]+140},10)}`,
      { x: s.x, z: s.z });
    const pass = d0 > 0.01 && d1 >= 0.5 * d0 && d1 > 0.005 && diff.count >= 40;
    return { trailPersistsAcrossFrames: pass ? 1 : 0,
      _depthAfterStamp_m: d0, _depthAfter60f_m: d1, _changedPixels: diff.count };
  },

  // SV-05 (TOLERANCE). OPERATIONAL DEFINITION: stamp once, run N=3600
  // update(1/60) calls (candidates own their trail pass inside update()),
  // then decayPerFrame := (d_N / d_0)^(1/N). Gate: >= 0.999. No decay at all
  // (ratio 1.0) also passes — that is the "documented arcade choice" branch.
  // Depth reaching 0 is reported as the measured floor and fails honestly.
  async 'trail_probe:decay'(p, page) {
    const s = siteInfo;
    const N = Math.min(decayFrames, p.frames ?? 3600);
    await ev(page, `(o)=>__probe.placeRider(o.x,o.z,{speed:0})`, { x: s.x, z: s.z });
    const d0 = await ev(page, `(o)=>{__probe.stampAt(o.x-3,o.z,1.0);__probe.snowSteps(1);
      return __probe.trailAt(o.x-3,o.z)}`, { x: s.x, z: s.z });
    await steps(page, N);
    const dN = await ev(page, `(o)=>__probe.trailAt(o.x-3,o.z)`, { x: s.x, z: s.z });
    if (d0 <= 0) throw new Error('stamp produced no depth; cannot measure decay');
    const decay = dN <= 0 ? 0 : Math.pow(dN / d0, 1 / N);
    return { trailDecayPerFrame: decay, _d0: d0, _dN: dN, _frames: N };
  },

  // SV-06 (HARD). OPERATIONAL DEFINITION: stamp the same world point twice
  // (one update apart). Double-deepening := depth after the second stamp
  // exceeds depth after the first by > 5% + 1 mm. max(existing, brush) and
  // additive-with-clamp both pass; naive accumulation fails.
  async 'trail_probe:stampCap'(p, page) {
    const s = siteInfo;
    await ev(page, `(o)=>__probe.placeRider(o.x,o.z,{speed:0})`, { x: s.x, z: s.z });
    const d1 = await ev(page, `(o)=>{__probe.stampAt(o.x+4,o.z+3,0.8);__probe.snowSteps(1);
      return __probe.trailAt(o.x+4,o.z+3)}`, { x: s.x, z: s.z });
    const d2 = await ev(page, `(o)=>{__probe.stampAt(o.x+4,o.z+3,0.8);__probe.snowSteps(1);
      return __probe.trailAt(o.x+4,o.z+3)}`, { x: s.x, z: s.z });
    if (d1 <= 0.005) throw new Error('stamp produced no measurable depth');
    return { stampDoubleDeepens: d2 > d1 * 1.05 + 0.001 ? 1 : 0, _d1: d1, _d2: d2 };
  },

  // SV-07 (HARD). The gate statement "deforms geometry AND normals" is
  // operationalized as three independently-measured conditions (all required):
  //  (a) DEPTH: after a debug stamp, trailHeightAt reports 0.02-0.6 m.
  //  (b) GEOMETRY: a probe sphere carrying the candidate's snow material
  //      floats 3.5 m above ground; stamping under its footprint must move
  //      its top silhouette row DOWN >= 2 px (found by diffing against a
  //      sphere-less render of the identical camera; ~165 px/m here, so real
  //      displacement moves it tens of px). Albedo/normal-only "trails"
  //      cannot move a silhouette.
  //  (c) NORMALS: a trench stamped on real terrain must show left/right
  //      luminance asymmetry that FLIPS SIGN when the sun is mirrored +X/-X
  //      (|asym| > 0.01 both sides). Static albedo darkening is sun-invariant
  //      and cannot produce the flip; only normals recomputed from the trail
  //      texture can.
  async 'trail_probe:displacementAndNormals'(p, page) {
    const r = await ev(page, '__probe.displacementProbe', {});
    await shot(page, 'probe-sv07-trench.png');
    const depthOk = r.depth >= 0.02 && r.depth <= 0.6;
    const geomOk = r.deltaRows >= 2;
    const normOk = (r.a1 * r.a2 < 0) && Math.min(Math.abs(r.a1), Math.abs(r.a2)) > 0.01;
    return { trailDeformsGeometryAndNormals: (depthOk && geomOk && normOk) ? 1 : 0,
      _depth_m: r.depth, _silhouetteDeltaRows: r.deltaRows, _sunFlipAsym: [r.a1, r.a2],
      _depthOk: depthOk, _geometryOk: geomOk, _normalsOk: normOk };
  },

  // SV-08 (TOLERANCE). OPERATIONAL DEFINITION: texel size := FWHM (along x,
  // 4 mm scan of trailHeightAt) of a minimum-width (2 cm) debug stamp —
  // assumes the candidate clamps tiny brushes to >= 1 texel, which the
  // contract's stamp hook implies. Gate band 2-8 cm/texel. Side check
  // (_windowFollowsOk): after a scripted 200 m straight run, a stamp at the
  // rider's new position must still register (> 1 cm) — the window moved with
  // the rider. A full-course static texture at this texel size would need a
  // >60k-texel edge, so a working stamp after 200 m implies a moving window.
  async 'trail_probe:windowFollow'(p, page) {
    const s = siteInfo;
    await ev(page, `(o)=>__probe.placeRider(o.x,o.z,{speed:0})`, { x: s.x, z: s.z });
    const scan = await ev(page, `(o)=>__probe.texelScan({x:o.x+6,z:o.z-2})`, { x: s.x, z: s.z });
    const run = await ev(page, `()=>__probe.driveCarve({seconds:10,speed:20,ampDeg:0,periodS:2.5})`, {});
    const far = await ev(page, `(e)=>{__probe.stampAt(e.x,e.z,0.6);__probe.snowSteps(1);
      return __probe.trailAt(e.x,e.z)}`, run.end);
    return { trailTexelSize_cm: scan.fwhm_m * 100,
      _scanMaxDepth_m: scan.maxDepth, _depthAtRiderAfter200m: far,
      _windowFollowsOk: far > 0.01 };
  },

  // SV-12 (STYLE). OPERATIONAL DEFINITION: a 10 s scripted carve run (speed
  // 15, +/-25 deg serpentine) with NO debug stamps — the candidate must lay
  // trail from riderRef state on its own. Pass iff >= 60% of the last-40 m
  // path samples report depth > 1 cm AND the rendered view over that segment
  // differs from its pre-run render by >= 300 px (camera framed identically
  // via a dry-run path; spray is let die for 3 s before the post render so
  // the diff is trail, not particles).
  async 'trail_probe:visible'(p, page) {
    const s = siteInfo;
    await ev(page, `(o)=>__probe.placeRider(o.x,o.z,{speed:0})`, { x: s.x, z: s.z });
    const dry = await ev(page, `(o)=>__probe.driveCarve({seconds:${p.carveRun_s ?? 10},speed:15,ampDeg:25,periodS:2.5,dry:true})`, {});
    const seg = dry.path.slice(-12);
    const cx = seg.reduce((a, q) => a + q.x, 0) / seg.length;
    const cz = seg.reduce((a, q) => a + q.z, 0) / seg.length;
    await ev(page, `(o)=>{const g=__probe.groundY(o.cx,o.cz);
      __probe.setCam(o.cx,g+30,o.cz-14,o.cx,g,o.cz,50); __probe.snap('pre'); return true}`, { cx, cz });
    const real = await ev(page, `(o)=>__probe.driveCarve({seconds:${p.carveRun_s ?? 10},speed:15,ampDeg:25,periodS:2.5})`, {});
    // park the rider (speed 0) and wait 3 s so spray dies; a windowed trail
    // must still be there. Depth is sampled over the last 5 path samples
    // (~19 m) — within any contract-legal >= 40 m trail window.
    await ev(page, `(e)=>__probe.placeRider(e.x,e.z,{speed:0})`, real.end);
    await steps(page, 180);
    const depthFrac = await ev(page, `()=>__probe.pathDepthFrac(5, 0.01)`, {});
    const diff = await ev(page, `()=>{__probe.snap('post');
      return __probe.diffStats('pre','post',{x0:200,x1:1080,y0:100,y1:620},10)}`, {});
    await shot(page, 'probe-sv12-trail.png');
    return { trailVisibleWhileCarving: (depthFrac >= 0.6 && diff.count >= 300) ? 1 : 0,
      _pathDepthFrac: depthFrac, _changedPixels: diff.count };
  },

  // SV-09 (TOLERANCE). OPERATIONAL DEFINITION: metric = MINIMUM live
  // particleCount over 2 s of a sustained full-speed hard carve (25 m/s,
  // 55 deg edge, after 4 s of spin-up) — must stay >= 10k. "Sustainable" on
  // software GL cannot mean 60 fps, so the side check is RELATIVE
  // (_overheadOk): mean frame cost while rendering 10k+ particles must be
  // <= max(2.2x, +9 ms) of the same scene's particle-free render cost.
  // True GPU residency (buffers/VS integration, not per-particle JS) is a
  // code-inspection item for the critic; this gate measures budget.
  async 'spray_rate:gpuBudget'(p, page) {
    const s = siteInfo;
    await ev(page, `(o)=>{__probe.placeRider(o.x,o.z,{speed:0});
      const g=__probe.groundY(o.x,o.z);
      __probe.setCam(o.x+10,g+8,o.z-12,o.x,g+1,o.z,50); return true}`, { x: s.x, z: s.z });
    const baseMs = await ev(page, `()=>__probe.timeRenders(30)`, {});
    await ev(page, `()=>__probe.spinCondition({speed:25,edgeDeg:55,seconds:4})`, {});
    const r = await ev(page, `()=>__probe.sustainLoop({seconds:2,speed:25,edgeDeg:55})`, {});
    await shot(page, 'probe-sv09-spray.png');
    const overheadOk = r.msPerFrame <= Math.max(2.2 * baseMs, baseMs + 9);
    return { sustainableGpuParticles: r.minCount, _meanCount: Math.round(r.meanCount),
      _baseMs: +baseMs.toFixed(2), _withParticlesMs: +r.msPerFrame.toFixed(2),
      _overheadOk: overheadOk };
  },

  // SV-10 (HARD). OPERATIONAL DEFINITION: for each (speed, edge) in the gate
  // sweep, hold a kinematically-consistent carve condition (yawRate =
  // g*tan(edge)/speed, grounded) for 2.5 s and take the mean live count over
  // the last 0.5 s; a 2.5 s zero-edge drain runs between conditions. With
  // lifetime fixed per candidate, steady live count is proportional to
  // emission rate, so:  (1) flat-based: edge-0 counts <= max(5% of peak, 20);
  // (2) monotonic in edge at each speed (pairwise >= 0.85x - 10 slack, and
  // hardest edge materially above flat); (3) monotonic in speed at the
  // hardest edge; (4) order-thousands proxy: peak live count >= 800 (>= 1600/s
  // emission at any lifetime <= 0.5 s... documented as a lifetime-agnostic
  // floor); (5) landing burst: touchdown after 0.75 s airborne raises the
  // live count by >= 100 within 4 frames. All five required.
  async 'spray_rate:sweep'(p, page) {
    const s = siteInfo;
    const edges = p.edgeAngleSweep_deg ?? [0, 15, 30, 45, 60];
    const speeds = p.speeds ?? [5, 15, 25];
    await ev(page, `(o)=>__probe.placeRider(o.x,o.z,{speed:0})`, { x: s.x, z: s.z });
    const matrix = {};
    for (const spd of speeds) {
      matrix[spd] = {};
      for (const e of edges) {
        await ev(page, `()=>__probe.spinCondition({speed:0,edgeDeg:0,seconds:2.5})`, {}); // drain
        const c = await ev(page, `(o)=>__probe.spinCondition(o)`, { speed: spd, edgeDeg: e, seconds: 2.5 });
        matrix[spd][e] = Math.round(c.meanCount);
      }
    }
    const all = speeds.flatMap(v => edges.map(e => matrix[v][e]));
    const peak = Math.max(...all);
    const flatMax = Math.max(...speeds.map(v => matrix[v][edges[0]]));
    const flatOk = flatMax <= Math.max(0.05 * peak, 20);
    let monoEdgeOk = true;
    for (const v of speeds) {
      const row = edges.map(e => matrix[v][e]);
      for (let i = 1; i < row.length; i++) if (row[i] < row[i - 1] * 0.85 - 10) monoEdgeOk = false;
      if (row[row.length - 1] < Math.max(row[0] * 3, row[0] + 100)) monoEdgeOk = false;
    }
    const top = edges[edges.length - 1];
    const col = speeds.map(v => matrix[v][top]);
    let monoSpeedOk = true;
    for (let i = 1; i < col.length; i++) if (col[i] < col[i - 1] * 0.9) monoSpeedOk = false;
    const magnitudeOk = peak >= 800;
    await ev(page, `()=>__probe.spinCondition({speed:0,edgeDeg:0,seconds:2.5})`, {}); // drain
    const burst = await ev(page, `()=>__probe.landingSeq()`, {});
    const burstOk = (burst.after - burst.before) >= 100;
    const pass = flatOk && monoEdgeOk && monoSpeedOk && magnitudeOk && burstOk;
    return { sprayRateMonotonicGated: pass ? 1 : 0, _matrix: matrix,
      _flatOk: flatOk, _monoEdgeOk: monoEdgeOk, _monoSpeedOk: monoSpeedOk,
      _magnitudeOk: magnitudeOk, _burst: burst.after - burst.before, _burstOk: burstOk };
  },

  // SV-11 (STYLE). OPERATIONAL DEFINITION: birth-speed distribution of live
  // particles during a hard carve, via the OPTIONAL debug.particleSpeeds()
  // hook (SV-11 is not measurable through the required contract surface —
  // candidates without the hook get 'deferred', judged visually by the
  // critic). Bimodal := 3-45% of particles faster than 2x median speed, OR
  // coefficient of variation > 0.5 (the gate's "wide variance" alternative).
  async 'spray_rate:velocityHistogram'(p, page) {
    const hooks = await ev(page, 'window.__probe.hooks');
    if (!hooks.particleSpeeds) return null; // deferred
    const s = siteInfo;
    await ev(page, `(o)=>__probe.placeRider(o.x,o.z,{speed:0})`, { x: s.x, z: s.z });
    await ev(page, `()=>__probe.spinCondition({speed:25,edgeDeg:55,seconds:2})`, {});
    const sp = await ev(page, `()=>__probe.speeds()`, {});
    if (!sp || sp.length < 200) throw new Error('too few particles to form a histogram: ' + (sp?.length ?? 0));
    const sorted = [...sp].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const fastFrac = sp.filter(v => v > 2 * median).length / sp.length;
    const mean = sp.reduce((a, b) => a + b, 0) / sp.length;
    const cv = Math.sqrt(sp.reduce((a, b) => a + (b - mean) ** 2, 0) / sp.length) / mean;
    const pass = (fastFrac >= 0.03 && fastFrac <= 0.45) || cv > 0.5;
    return { sprayBimodal: pass ? 1 : 0, _n: sp.length, _medianSpeed: +median.toFixed(2),
      _fastFrac: +fastFrac.toFixed(3), _cv: +cv.toFixed(3) };
  },

  // SV-13 (HARD). The gate demands 60 fps on REFERENCE HARDWARE. Under
  // headless SwiftShader (software GL) absolute fps measures the rasterizer,
  // not the candidate, so the gate is reported 'deferred' with the measured
  // proxy numbers recorded. On a real GPU: metric = 1%-low fps over
  // --perf-seconds of a scripted carve with spray live, after a 1.5 s
  // untimed warmup (shader compile + LOD builds are setup cost, not
  // sustained-rate evidence). rAF is vsync-locked, so frames <= 17.5 ms
  // count as exactly 60 fps; frames beyond one vsync interval keep their
  // real cost — a candidate that ever misses vsync in >1% of frames fails.
  async 'perf_capture:default'(p, page) {
    const s = siteInfo;
    await ev(page, `(o)=>{__probe.placeRider(o.x,o.z,{speed:0});
      const g=__probe.groundY(o.x,o.z);
      __probe.setCam(o.x+10,g+8,o.z-12,o.x,g+1,o.z,50); return true}`, { x: s.x, z: s.z });
    const r = await ev(page, `()=>__probe.perfLoop(${perfSeconds})`, {});
    const software = /swiftshader|llvmpipe|software/i.test(rendererString || '');
    if (software) {
      return { __defer: `software GL (${(rendererString || '').slice(0, 60)}); ` +
        `proxy avg ${r.avgFps} fps, 1%-low ${r.low1Fps} fps over ${perfSeconds}s — rerun with --real-gpu` };
    }
    return { sustainedFps: r.low1Fps, _avgFps: r.avgFps, _frames: r.frames };
  },
};

// ---------- run all gates ---------------------------------------------------
const results = [];
for (const g of GATES) {
  if (onlyGates && !onlyGates.includes(g.id)) continue;
  const sc = g.scenario?.scenario, params = g.scenario?.params ?? {};
  const key = sc === 'perf_capture' ? 'perf_capture:default' : `${sc}:${params.check ?? 'sweep'}`;
  if (!impl[key]) { results.push({ id: g.id, tag: g.tag, status: 'no-impl', scenario: key }); continue; }
  let row, page = null;
  try {
    page = await newProbePage();
    const m = await impl[key](params, page);
    if (m === null) {
      row = { id: g.id, tag: g.tag, status: 'deferred',
        note: 'optional particleSpeeds hook absent; critic judges visually' };
    } else if (m.__defer) {
      row = { id: g.id, tag: g.tag, status: 'deferred', note: m.__defer };
    } else {
      const val = m[g.metric];
      let pass;
      if (g.op === 'in_range') pass = val >= g.min && val <= g.max;
      else if (g.op === 'lte') pass = val <= g.value;
      else if (g.op === 'gte') pass = val >= g.value;
      else if (g.op === 'eq') pass = Math.abs(val - g.value) < 1e-9;
      const side = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('_')));
      const sideOk = Object.entries(side).every(([k, v]) =>
        (k.endsWith('Ok') || k.endsWith('InBand')) ? v !== false : true);
      row = { id: g.id, tag: g.tag, status: (pass && sideOk) ? 'pass' : 'fail',
        metric: g.metric, value: typeof val === 'number' ? +val.toPrecision(5) : val,
        expect: g.op === 'in_range' ? `[${g.min}, ${g.max}]` : `${g.op} ${g.value}`, ...side };
    }
  } catch (err) {
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err && err.message || err).slice(0, 240) };
  } finally {
    if (page) await page.close().catch(() => {});
  }
  results.push(row);
  const r = row;
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status === 'deferred' ? 'DEFER' : r.status.toUpperCase()).padEnd(7)} ${r.id.padEnd(7)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + JSON.stringify(r.value) : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? r.note ?? ''}`);
}

const counts = { pass: 0, fail: 0, error: 0, deferred: 0, 'no-impl': 0 };
let hardFails = 0;
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if (r.status !== 'pass' && r.status !== 'deferred' && r.tag === 'HARD') hardFails++;
}
const report = { module: modDir, lane: 'snow-visuals', renderer: rendererString,
  counts, hardFails, results, consoleErrors: consoleErrors.slice(0, 20) };
await mkdir(outDir, { recursive: true });
await writeFile(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ counts, hardFails, renderer: (rendererString || '').slice(0, 60) }));

await browser.close();
server.close();
process.exit(hardFails === 0 ? 0 : 2);
