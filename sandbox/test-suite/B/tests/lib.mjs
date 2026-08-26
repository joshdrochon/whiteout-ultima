// ===========================================================================
// Shared machinery for the regression suite (candidate B).
// ROOT-relative: the suite runs against whatever repo copy it lives in, so the
// mutation harness can cp -r the tree and run the suite in place.
// ===========================================================================
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const SCRATCH = mkdtempSync(join(tmpdir(), 'sb-suite-B-'));
export const rootPath = (...p) => resolve(ROOT, ...p);
export const importRoot = (p) => import(pathToFileURL(rootPath(p)).href);

// ---- child-process gate runners -------------------------------------------
// REUSE of the existing gate machinery: physics-runner / camera-runner /
// capture / shader-runner are the operational definitions of the gates; we
// spawn them and parse, never reimplement measurement.
export function runNode(scriptRel, args, { timeoutMs = 240000 } = {}) {
  const r = spawnSync(process.execPath, [rootPath(scriptRel), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`${scriptRel} failed to spawn: ${r.error.message}`);
  return r; // { status, stdout, stderr }
}

// Runner reports (physics/camera) are read from --out JSON: per-gate rows.
export function runGateRunner(runnerRel, moduleRel, outName, extraArgs = []) {
  const outAbs = join(SCRATCH, outName);
  const r = runNode(runnerRel, ['--module', moduleRel, '--out', outAbs, ...extraArgs]);
  let report = null;
  try { report = JSON.parse(readFileSync(outAbs, 'utf8')); } catch { /* fall through */ }
  return { proc: r, report };
}

// ---- FNV-1a hashing --------------------------------------------------------
export function fnv1aInit() { return 0x811c9dc5; }
export function fnv1aBytes(h, u8) {
  for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619);
  return h;
}
export const fnvHex = h => (h >>> 0).toString(16).padStart(8, '0');

const _f64 = new Float64Array(8);
const _u8of64 = new Uint8Array(_f64.buffer);
export function hashStateInto(h, st) {
  _f64[0] = st.pos[0]; _f64[1] = st.pos[1]; _f64[2] = st.pos[2];
  _f64[3] = st.vel[0]; _f64[4] = st.vel[1]; _f64[5] = st.vel[2];
  _f64[6] = st.heading; _f64[7] = st.onGround ? 1 : 0;
  return fnv1aBytes(h, _u8of64);
}

// ---- golden scripted physics run ------------------------------------------
// Deterministic 15 s run on the real course terrain: run-in, carved S-turns
// with boost, tuck, crouch-charged pop, air with spin + (no-op) air steer,
// landing, then tuck+boost push toward the speed cap. Exercises the code
// paths every physics mutant touches. Pure function of (t, state).
export const SIM_SECONDS = 15;
export const SIM_DT = 1 / 60;
const centerX = z => 150 * Math.sin(z * 0.0032) + 65 * Math.sin(z * 0.0011 + 1.7);
const centerXSlope = z => 150 * 0.0032 * Math.cos(z * 0.0032)
  + 65 * 0.0011 * Math.cos(z * 0.0011 + 1.7);

export function goldenScript(t, st) {
  const input = {};
  const sp = Math.hypot(st.vel[0], st.vel[2]);
  if (!st.onGround) {
    // airborne: spin plus held steer — steer MUST be a no-op in the air (TN-07)
    input.spin = 1; input.steer = 1;
    return input;
  }
  if (t >= 2 && t < 6) {
    input.steer = 0.85 * Math.sin((t - 2) * (2 * Math.PI / 3));
    if (sp < 20) input.boost = true;
  }
  if (t >= 6 && t < 8) input.tuck = true;
  if (t >= 8 && t < 8.6) input.crouch = true;
  if (t >= 8.6 && t < 8.6 + SIM_DT * 1.5) input.jumpRelease = true;
  if (t >= 10.4) { input.tuck = true; input.boost = true; }  // push at V_CAP
  return input;
}

// Runs the golden script with the given createPhysics + terrain sampleHeight.
// Returns { checkpoints: [hex per second], final: hex, finalState }.
export function runGoldenSim(createPhysics, sampleHeight) {
  const env = { sampleHeight, surface: 'snow', seed: 7 };
  const p = createPhysics(env, {});
  const z0 = 15, x0 = centerX(z0), slope0 = centerXSlope(z0);
  const dl = Math.hypot(slope0, 1);
  const st = p.init([x0, sampleHeight(x0, z0), z0],
    [8 * slope0 / dl, 0, 8 / dl], Math.atan2(1, slope0));
  let h = fnv1aInit();
  const checkpoints = [];
  const n = Math.round(SIM_SECONDS / SIM_DT);
  for (let k = 0; k < n; k++) {
    p.step(st, goldenScript(k * SIM_DT, st), SIM_DT);
    h = hashStateInto(h, st);
    if ((k + 1) % 60 === 0) checkpoints.push(fnvHex(h));
  }
  return {
    checkpoints, final: fnvHex(h),
    finalState: { pos: st.pos.map(v => +v.toFixed(3)), vel: st.vel.map(v => +v.toFixed(3)),
      onGround: st.onGround },
  };
}

// ---- geometry ground-coherence --------------------------------------------
// Chunk combos frozen as the golden set: course-covering inner tiles at
// several LODs/dip masks + an outer backdrop tile. (x0,z0) chosen on the
// 250 m inner grid / 1 km outer grid actually used by the render loop.
export const GEOM_COMBOS = [
  { x0: 0,     z0: 250,  size: 250,  seg: 4,  mask: 0 },
  { x0: 250,   z0: 500,  size: 250,  seg: 8,  mask: 5 },
  { x0: 0,     z0: 0,    size: 250,  seg: 16, mask: 15 },
  { x0: 250,   z0: 750,  size: 250,  seg: 64, mask: 2 },
  { x0: 0,     z0: 500,  size: 250,  seg: 96, mask: 8 },
  { x0: -1000, z0: -250, size: 1000, seg: 12, mask: 15 },
];

export function isDipped(i, j, seg, mask) {
  return ((mask & 1) && i === 0) || ((mask & 2) && i === seg)
      || ((mask & 4) && j === 0) || ((mask & 8) && j === seg);
}

// Checks every grid vertex of one built chunk against sampleHeight.
// Returns null on success or a description of the FIRST violation.
export function checkChunkCoherence(buildChunkGeometry, sampleHeight, combo) {
  const { x0, z0, size, seg, mask } = combo;
  const g = buildChunkGeometry(x0, z0, size, seg, mask);
  const pos = g.getAttribute('position').array;
  const n = seg + 1;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i / seg) * size, z = z0 + (j / seg) * size;
      const p = (j * n + i) * 3;
      const meshY = pos[p + 1];
      const trueY = Math.fround(sampleHeight(x, z));
      if (isDipped(i, j, seg, mask)) {
        if (!(meshY < trueY)) return { i, j, x, z, meshY, trueY,
          why: 'dipped edge vertex must sit strictly BELOW sampleHeight' };
      } else if (meshY !== trueY) {
        return { i, j, x, z, meshY, trueY,
          why: 'non-dipped vertex must equal sampleHeight(x,z) EXACTLY (float32)' };
      }
    }
  }
  return null;
}

export function chunkChecksum(buildChunkGeometry, combo) {
  const { x0, z0, size, seg, mask } = combo;
  const g = buildChunkGeometry(x0, z0, size, seg, mask);
  const pos = g.getAttribute('position').array;
  const idx = g.index.array;
  let h = fnv1aInit();
  h = fnv1aBytes(h, new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength));
  h = fnv1aBytes(h, new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength));
  return fnvHex(h);
}

// ---- attachSnow node-side probe (no GPU) ----------------------------------
// Mocks the renderer + fetch just enough to exercise the debug contract:
// readRenderTargetPixels hands back a FULL-DEPTH trail sample, so an intact
// trailHeightAt must decode it to a positive depth in metres.
export async function probeAttach(attachRel) {
  const THREE = await importRoot('node_modules/three/build/three.module.js');
  const scene = new THREE.Scene();
  const mat = new THREE.MeshBasicMaterial();
  for (let i = 0; i < 2; i++) scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat));
  const renderer = {
    getContext: () => ({ getExtension: () => null }),   // byte-fallback RTT path
    setClearColor() {}, getRenderTarget: () => null, setRenderTarget() {},
    render() {},
    readRenderTargetPixels(rt, x, y, w, hh, buf) {
      buf.fill(buf instanceof Float32Array ? 1 : 255);  // full-depth everywhere
    },
    domElement: { height: 720 },
  };
  const riderRef = { state: { pos: [0, 0, 0], vel: [0, 0, 0], heading: 0, onGround: true } };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = url instanceof URL ? url : new URL(String(url));
    const text = readFileSync(fileURLToPath(u), 'utf8');
    return { ok: true, text: async () => text };
  };
  try {
    const { attachSnow } = await importRoot(attachRel);
    return await attachSnow(scene, renderer, riderRef);
  } finally {
    globalThis.fetch = origFetch;
  }
}

// ---- fixtures --------------------------------------------------------------
export const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf8'));
}

// Compare a gate report against its frozen fixture: every gate that passed at
// fixture time must still pass. Returns list of regression strings.
export function gateRegressions(report, fixture, gatesJson, where) {
  const byId = new Map(gatesJson.gates.map(g => [g.id, g]));
  const now = new Map(report.results.map(r => [r.id, r]));
  const out = [];
  for (const [id, frozen] of Object.entries(fixture.gates)) {
    if (frozen !== 'pass') continue;
    const r = now.get(id);
    if (!r) { out.push(`${id}: gate missing from runner output (was 'pass')`); continue; }
    if (r.status !== 'pass') {
      const g = byId.get(id);
      out.push(`${id} [${r.tag}] ${r.metric ?? ''} = ${r.value ?? r.error ?? '?'}` +
        ` (want ${r.expect ?? '?'}) — invariant: "${g?.statement ?? 'unknown'}" — where: ${where}`);
    }
  }
  return out;
}
