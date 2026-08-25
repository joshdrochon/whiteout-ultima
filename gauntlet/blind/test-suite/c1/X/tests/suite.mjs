#!/usr/bin/env node
// ============================================================================
// Regression test suite — candidate A (invariant/property-first)
//
// Run:  node sandbox/test-suite/A/tests/suite.mjs           (TIER 1, no GPU)
//       node sandbox/test-suite/A/tests/suite.mjs --full    (adds TIER 2)
//
// Exit 0 = every test passed, 1 = any failure. node:test prints one summary
// line per test; every assertion message states WHAT invariant broke and WHERE.
//
// TIER 1 (< 120 s, pure Node):
//   * contract shape          — modules export what CONTRACTS.md promises
//   * copy sync               — src/game/physics.mjs byte-identical to
//                               src/physics/physics.mjs (+ render/camera copies)
//   * dt-exactness            — closed-form damping property, direct
//   * GEOMETRY GROUND-COHERENCE — every NON-dipped vertex produced by
//                               buildChunkGeometry equals sampleHeight(x,z)
//                               exactly (fp32); dipped edge verts strictly below.
//                               This is the test that catches a terrain bias
//                               (rider floating off the physics ground) in ms.
//   * trailHeightAt contract  — debug hook converts trail texels to meters
//                               (mock-GL, no GPU): nonzero + linear in texel value
//   * physics gates           — spawns harness/physics-runner.mjs (operational
//                               definition of PC/TN/JA gates), requires 0 fails
//   * camera gates            — spawns harness/camera-runner.mjs, 0 fails
//
// TIER 2 (--full, needs headless Chrome):
//   * capture smoke src/render and src/game: ok, fps >= 55, drawCalls < 150
//   * shader-runner SV gates on src/shaders
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FULL = process.argv.includes('--full');
const R = (p) => resolve(ROOT, p);
const imp = (p) => import(pathToFileURL(R(p)).href);

// ---------------------------------------------------------------- helpers
function runNode(cmdArgs, timeoutMs) {
  const r = spawnSync(process.execPath, cmdArgs, {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = r.stdout || '';
  const lines = stdout.trim().split('\n');
  let summary = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const j = JSON.parse(lines[i]); if (j && j.counts) { summary = j; break; } } catch { /* keep looking */ }
  }
  const failLines = lines.filter((l) => /^(FAIL|ERROR)\b/.test(l));
  return { status: r.status, signal: r.signal, error: r.error, stdout, stderr: r.stderr || '', summary, failLines };
}

function assertGateRunnerClean(name, res) {
  assert.ok(!res.error, `${name}: runner did not execute (${res.error}) — harness invariant broken at ${name}`);
  assert.ok(res.summary, `${name}: no {counts,...} summary line on stdout — runner crashed or contract changed.\nstderr:\n${res.stderr.slice(0, 2000)}`);
  const c = res.summary.counts;
  const detail = res.failLines.length ? `\nFailing gates:\n${res.failLines.join('\n')}` : '';
  assert.equal(c.error ?? 0, 0, `${name}: ${c.error} gate scenario(s) threw — the candidate module broke the runner's operational contract.${detail}`);
  assert.equal(c['no-impl'] ?? 0, 0, `${name}: ${c['no-impl']} gate(s) have no scenario impl — runner/gates drifted apart.${detail}`);
  assert.equal(res.summary.hardFails, 0, `${name}: ${res.summary.hardFails} HARD gate(s) failed — a HARD physics/camera invariant is broken.${detail}`);
  assert.equal(c.fail ?? 0, 0, `${name}: ${c.fail} gate(s) out of band (pristine tree passes all 0-fail) — a reference-bar invariant regressed.${detail}`);
  assert.equal(res.status, 0, `${name}: runner exit ${res.status} (signal ${res.signal}) — expected 0.${detail}`);
}

// ============================================================================
// TIER 1
// ============================================================================

// ---- contract shape: physics ------------------------------------------------
test('contract-shape: src/physics/physics.mjs exports createPhysics per CONTRACTS.md', async () => {
  const m = await imp('src/physics/physics.mjs');
  assert.equal(typeof m.createPhysics, 'function',
    'CONTRACTS.md promises `export function createPhysics(env, opts)` in src/physics/physics.mjs — export missing');
  const env = { sampleHeight: () => 0, surface: 'snow' };
  const p = m.createPhysics(env, {});
  assert.equal(typeof p.config, 'object', 'createPhysics(...).config must be a plain object of resolved constants');
  for (const [k, v] of Object.entries(p.config)) {
    assert.ok(typeof v === 'number' || k === 'surface',
      `config.${k} is ${typeof v} — CONTRACTS.md: config values are all numbers (surface excepted)`);
  }
  assert.equal(typeof p.init, 'function', 'physics candidate must export init(pos, vel, heading)');
  assert.equal(typeof p.step, 'function', 'physics candidate must export step(state, input, dt)');

  const st = p.init([0, 0, 0], [5, 0, 0], 0);
  for (const f of ['pos', 'vel', 'heading', 'onGround', 'charge', 'airTime', 'boostMeter', 'spinDeg', 'flipDeg', 'landing']) {
    assert.ok(f in st, `state.${f} missing after init() — required state field per CONTRACTS.md physics lane`);
  }
  assert.equal(st.onGround, true, 'init at surface height must set onGround=true (pos vs sampleHeight)');
  const stAir = p.init([0, 10, 0], [5, 0, 0], 0);
  assert.equal(stAir.onGround, false, 'init 10 m above surface must start airborne (CONTRACTS.md: above surface = start airborne)');
  const ret = p.step(st, {}, 1 / 60);
  assert.equal(ret, st, 'step(state, input, dt) must MUTATE and return the same state object');
});

// ---- contract shape: camera -------------------------------------------------
test('contract-shape: src/camera/camera.mjs exports createChaseCam per CONTRACTS.md', async () => {
  const m = await imp('src/camera/camera.mjs');
  assert.equal(typeof m.createChaseCam, 'function',
    'CONTRACTS.md promises `export function createChaseCam(camera, opts)` in src/camera/camera.mjs — export missing');
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
  const rig = m.createChaseCam(cam, { seed: 5 });
  assert.equal(typeof rig.update, 'function', 'chase cam must expose update(riderState, dt)');
  assert.equal(typeof rig.config, 'object', 'chase cam must expose config (named constants)');
  assert.ok(Array.isArray(rig.debug?.lookAtTarget) && rig.debug.lookAtTarget.length === 3,
    'chase cam must expose debug.lookAtTarget as a world-space [x,y,z]');
  assert.equal(typeof rig.addTrauma, 'function', 'chase cam must expose addTrauma(amount)');
  assert.equal(typeof rig.setBoostTier, 'function', 'chase cam must expose setBoostTier(tier)');
  const rider = { pos: [0, 0, 0], vel: [15, 0, 0], heading: 0, onGround: true, spinDeg: 0, airTime: 0 };
  for (let i = 0; i < 30; i++) rig.update(rider, 1 / 60);
  assert.ok(rig.debug.lookAtTarget.every(Number.isFinite),
    'debug.lookAtTarget must hold finite numbers after update() — camera contract broken in src/camera/camera.mjs');
});

// ---- contract shape: render / shaders / game rig ---------------------------
test('contract-shape: render, shader, and game-rig module exports', async () => {
  for (const p of ['src/render/main.mjs', 'src/game/render.mjs']) {
    const m = await imp(p);
    assert.equal(typeof m.boot, 'function', `${p} must export boot(canvas) (CONTRACTS.md render-loop lane)`);
    assert.equal(typeof m.sampleHeight, 'function',
      `${p} must export the pure sampleHeight(x,z) terrain sampler (test-suite geometry contract)`);
    assert.ok(Number.isFinite(m.sampleHeight(0, 0)), `${p} sampleHeight(0,0) must be a finite height`);
    assert.equal(typeof m.buildChunkGeometry, 'function',
      `${p} must export the pure buildChunkGeometry(x0,z0,size,seg,dipMask) (test-suite geometry contract)`);
  }
  for (const p of ['src/shaders/attach.mjs', 'src/game/attach.mjs']) {
    const m = await imp(p);
    assert.equal(typeof m.attachSnow, 'function', `${p} must export attachSnow(scene, renderer, riderRef) (CONTRACTS.md shader lane)`);
  }
  const g = await imp('src/game/main.mjs');
  assert.equal(typeof g.boot, 'function', 'src/game/main.mjs must export boot(canvas) behind the render-loop contract');
});

// ---- copy sync --------------------------------------------------------------
test('copy-sync: src/game/physics.mjs is byte-identical to src/physics/physics.mjs', () => {
  const a = readFileSync(R('src/physics/physics.mjs'));
  const b = readFileSync(R('src/game/physics.mjs'));
  assert.ok(a.equals(b),
    'src/game/physics.mjs has drifted from src/physics/physics.mjs — the game rig promises a READ-ONLY byte-identical copy of the accepted physics core; the two files differ');
});

test('copy-sync: src/game/render.mjs is byte-identical to src/render/main.mjs', () => {
  const a = readFileSync(R('src/render/main.mjs'));
  const b = readFileSync(R('src/game/render.mjs'));
  assert.ok(a.equals(b),
    'src/game/render.mjs has drifted from src/render/main.mjs — the game rig terrain must be the accepted render-lane terrain; the two files differ');
});

test('copy-sync: src/game/camera.mjs is byte-identical to src/camera/camera.mjs', () => {
  const a = readFileSync(R('src/camera/camera.mjs'));
  const b = readFileSync(R('src/game/camera.mjs'));
  assert.ok(a.equals(b),
    'src/game/camera.mjs has drifted from src/camera/camera.mjs — the game rig chase cam must be the accepted camera-lane winner; the two files differ');
});

// ---- dt-exactness property (direct, complements PC-02/CF-01) ----------------
test('dt-exactness: physics damping is closed-form — one 100 ms step == ten 10 ms steps', async () => {
  const { createPhysics } = await imp('src/physics/physics.mjs');
  const env = { sampleHeight: () => 0, surface: 'snow' };
  const mk = () => { const p = createPhysics(env, {}); return { p, st: p.init([0, 0, 0], [17, 0, 0], 0) }; };
  const A = mk(); A.p.step(A.st, {}, 0.1);
  const B = mk(); for (let i = 0; i < 10; i++) B.p.step(B.st, {}, 0.01);
  const err = Math.hypot(A.st.vel[0] - B.st.vel[0], A.st.vel[1] - B.st.vel[1], A.st.vel[2] - B.st.vel[2]);
  assert.ok(err <= 1e-6,
    `dt-exactness invariant broken in src/physics/physics.mjs step(): one 0.1 s step and ten 0.01 s steps diverge by |dv| = ${err.toExponential(3)} m/s (allowed 1e-6). ` +
    'Damping must integrate closed-form (1 - exp(-lambda*dt)), not naive Euler (v *= 1 - lambda*dt).');
});

// ---- GEOMETRY GROUND-COHERENCE ---------------------------------------------
// Every NON-dipped vertex buildChunkGeometry emits must sit EXACTLY at
// sampleHeight(x,z) (to fp32 storage). Any uniform bias (the rider-float bug)
// or per-vertex warp shows up here in milliseconds, long before a screenshot.
test('geometry: non-dipped vertices of buildChunkGeometry equal sampleHeight(x,z) exactly', async () => {
  const combos = [
    { size: 250, seg: 4, dipMask: 0 },
    { size: 250, seg: 4, dipMask: 15 },
    { size: 250, seg: 8, dipMask: 3 },
    { size: 250, seg: 16, dipMask: 5 },
    { size: 1000, seg: 12, dipMask: 15 },   // outer backdrop tile shape
  ];
  const tiles = [[-1000, -250], [0, 500], [250, 2250]];
  for (const modPath of ['src/render/main.mjs', 'src/game/render.mjs']) {
    const { sampleHeight, buildChunkGeometry } = await imp(modPath);
    for (const { size, seg, dipMask } of combos) {
      for (const [x0, z0] of tiles) {
        const g = buildChunkGeometry(x0, z0, size, seg, dipMask);
        const pos = g.getAttribute('position').array;
        const n = seg + 1;
        const bad = [];
        let dippedChecked = 0;
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const x = x0 + (i / seg) * size, z = z0 + (j / seg) * size;
            const y = pos[(j * n + i) * 3 + 1];
            const want = Math.fround(sampleHeight(x, z));
            const dipped = ((dipMask & 1) && i === 0) || ((dipMask & 2) && i === seg) ||
                           ((dipMask & 4) && j === 0) || ((dipMask & 8) && j === seg);
            if (dipped) {
              dippedChecked++;
              if (!(y < want)) bad.push(`DIPPED vertex (i=${i},j=${j}) at (${x},${z}): y=${y} must sit strictly BELOW sampleHeight=${want}`);
            } else if (y !== want) {
              bad.push(`vertex (i=${i},j=${j}) at (${x},${z}): mesh y=${y} but sampleHeight=${want} (delta ${(y - want).toFixed(6)} m)`);
            }
          }
        }
        assert.equal(bad.length, 0,
          `GROUND-COHERENCE broken in ${modPath} buildChunkGeometry(tile x0=${x0}, z0=${z0}, size=${size}, seg=${seg}, dipMask=${dipMask}): ` +
          `${bad.length} vertex(es) do not match the physics ground sampleHeight — the visual terrain and the physics heightfield have separated ` +
          `(this is exactly the rider-floats-off-the-ground bug). First offenders:\n  ${bad.slice(0, 4).join('\n  ')}`);
        if (dipMask) assert.ok(dippedChecked > 0, `combo seg=${seg} dipMask=${dipMask}: no dipped vertices found — dip-edge logic in ${modPath} changed shape`);
      }
    }
    // spot property: sampleHeight itself is deterministic & finite over the course
    for (const [x, z] of [[0, 0], [centerProbe(0), 0], [100, 1300], [-400, 2600]]) {
      assert.ok(Number.isFinite(sampleHeight(x, z)), `${modPath} sampleHeight(${x},${z}) is not finite — terrain function broken`);
    }
  }
  function centerProbe(z) { return 150 * Math.sin(z * 0.0032) + 65 * Math.sin(z * 0.0011 + 1.7); }
});

test('geometry: render-lane and game-rig terrain samplers agree exactly', async () => {
  const a = await imp('src/render/main.mjs');
  const b = await imp('src/game/render.mjs');
  for (const [x, z] of [[0, 15], [-120, 400], [80, 1337.5], [310, 2599]]) {
    assert.equal(a.sampleHeight(x, z), b.sampleHeight(x, z),
      `sampleHeight(${x},${z}) differs between src/render/main.mjs and src/game/render.mjs — the game rig would place the rider on a different ground than the renderer draws`);
  }
});

// ---- shader debug contract: trailHeightAt (no GPU; mock renderer) ----------
// attachSnow's debug.trailHeightAt(x,z) must convert trail-texture samples into
// a deformation depth in meters: nonzero for a nonzero texel, and linear in the
// texel value. A stubbed-out hook (return 0 always) breaks the SV trail gates'
// probe contract — caught here without a GPU.
async function trailDebugProbe(modPath) {
  const { attachSnow } = await imp(modPath);
  // fetch shim: attach.mjs fetches its GLSL relative to its own module URL
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('file:')) {
      const body = readFileSync(fileURLToPath(u), 'utf8');
      return { ok: true, text: async () => body };
    }
    return realFetch(url);
  };
  try {
    let texelValue = 0;
    const renderer = {
      getContext: () => ({ getExtension: () => ({}) }),          // float RTs "available"
      getRenderTarget: () => null,
      setRenderTarget() {}, render() {}, setClearColor() {},
      domElement: { height: 720 },
      readRenderTargetPixels(_rt, _x, _y, _w, _h, buf) {
        for (let i = 0; i < buf.length; i += 4) { buf[i] = texelValue; buf[i + 1] = 0; buf[i + 2] = 0; buf[i + 3] = 1; }
      },
    };
    const scene = new THREE.Scene();
    const terrain = new THREE.Mesh(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3)),
      new THREE.MeshBasicMaterial());
    scene.add(terrain);
    const riderRef = { state: { pos: [0, 0, 0], vel: [0, 0, 0], heading: 0, onGround: false } };
    const snow = await attachSnow(scene, renderer, riderRef);
    assert.equal(typeof snow.debug?.trailHeightAt, 'function', `${modPath}: debug.trailHeightAt missing — SV probe contract (CONTRACTS.md shader lane)`);
    assert.equal(typeof snow.debug?.stamp, 'function', `${modPath}: debug.stamp missing — SV probe contract`);
    assert.equal(typeof snow.debug?.particleCount, 'function', `${modPath}: debug.particleCount missing — SV probe contract`);
    assert.equal(typeof snow.debug?.setSunDir, 'function', `${modPath}: debug.setSunDir missing — SV probe contract`);

    texelValue = 0.5;
    const hHalf = snow.debug.trailHeightAt(0, 0);
    texelValue = 1.0;
    const hFull = snow.debug.trailHeightAt(0, 0);
    assert.ok(hHalf > 0,
      `${modPath}: debug.trailHeightAt(0,0) returned ${hHalf} for a trail texel of 0.5 — the hook must report the trail deformation depth in meters, ` +
      'never a constant 0; with it dead every SV trail gate (SV-04/05/06/07) measures a fake pristine surface');
    assert.ok(Number.isFinite(hFull) && Math.abs(hFull - 2 * hHalf) <= 1e-6 * Math.max(1, hFull),
      `${modPath}: trailHeightAt must be linear in the trail texel value (texel 1.0 -> ${hFull}, texel 0.5 -> ${hHalf}; expected exactly 2x) — depth decoding in debug.trailHeightAt is warped`);
    texelValue = 0.5;
    const far = snow.debug.trailHeightAt(1e6, 1e6);
    assert.equal(far, 0, `${modPath}: trailHeightAt outside the trail window must return 0, got ${far}`);
  } finally {
    globalThis.fetch = realFetch;
  }
}
test('shader-debug: src/shaders/attach.mjs trailHeightAt reports real trail depth', () => trailDebugProbe('src/shaders/attach.mjs'));
test('shader-debug: src/game/attach.mjs trailHeightAt reports real trail depth', () => trailDebugProbe('src/game/attach.mjs'));

// ---- physics gates via the operational runner -------------------------------
test('physics gates: harness/physics-runner.mjs on src/physics/physics.mjs — all measured gates pass', () => {
  const res = runNode([R('harness/physics-runner.mjs'), '--module', 'src/physics/physics.mjs'], 90_000);
  assertGateRunnerClean('physics-runner(src/physics/physics.mjs)', res);
});

// ---- camera gates via the operational runner --------------------------------
test('camera gates: harness/camera-runner.mjs on src/camera/camera.mjs — all measured gates pass', () => {
  const res = runNode([R('harness/camera-runner.mjs'), '--module', 'src/camera/camera.mjs'], 90_000);
  assertGateRunnerClean('camera-runner(src/camera/camera.mjs)', res);
});

// ============================================================================
// TIER 2 (--full): GPU / headless-Chrome checks
// ============================================================================
if (FULL) {
  const smoke = (dir, outName) => {
    const res = runNode([R('harness/capture.mjs'), '--dir', dir, '--frames', '4',
      '--out', `sandbox/test-suite/A/_capture/${outName}`], 300_000);
    assert.ok(!res.error, `capture(${dir}): harness did not execute (${res.error})`);
    let out = null;
    const lines = res.stdout.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { try { const j = JSON.parse(lines.slice(i).join('\n')); if ('ok' in j) { out = j; break; } } catch { /* multi-line JSON: keep widening */ } }
    assert.ok(out, `capture(${dir}): no JSON result on stdout — boot or harness crashed.\nstderr:\n${res.stderr.slice(0, 2000)}`);
    assert.equal(out.ok, true,
      `capture(${dir}): ok=false — boot/render errors: ${JSON.stringify(out.errors)} console: ${JSON.stringify(out.consoleErrors)}`);
    assert.ok(out.perf && out.perf.avgFps >= 55,
      `capture(${dir}): sustained avgFps ${out.perf?.avgFps} < 55 — perf invariant broken (reference bar SV-13 territory)`);
    assert.ok(out.perf.drawCalls < 150,
      `capture(${dir}): drawCalls ${out.perf.drawCalls} >= 150 — draw-call budget invariant broken`);
  };
  test('TIER2 capture smoke: src/render boots, renders, holds fps >= 55 and drawCalls < 150', () => smoke('src/render', 'render'));
  test('TIER2 capture smoke: src/game boots, renders, holds fps >= 55 and drawCalls < 150', () => smoke('src/game', 'game'));

  test('TIER2 shader gates: harness/shader-runner.mjs on src/shaders — no HARD fail, no error', () => {
    const res = runNode([R('harness/shader-runner.mjs'), '--module', 'src/shaders',
      '--out', 'sandbox/test-suite/A/_capture/sv-metrics.json'], 480_000);
    assert.ok(!res.error, `shader-runner: did not execute (${res.error})`);
    assert.ok(res.summary, `shader-runner: no {counts,...} summary on stdout — runner crashed.\nstderr:\n${res.stderr.slice(0, 2000)}`);
    const c = res.summary.counts;
    const detail = res.failLines.length ? `\nFailing gates:\n${res.failLines.join('\n')}` : '';
    assert.equal(c.error ?? 0, 0, `shader-runner: ${c.error} SV gate scenario(s) threw.${detail}`);
    assert.equal(res.summary.hardFails, 0, `shader-runner: ${res.summary.hardFails} HARD SV gate(s) failed — a snow-visuals invariant is broken.${detail}`);
    assert.equal(c.fail ?? 0, 0, `shader-runner: ${c.fail} SV gate(s) out of band.${detail}`);
  });
}
