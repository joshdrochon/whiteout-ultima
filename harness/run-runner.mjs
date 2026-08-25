#!/usr/bin/env node
// Run-structure gate runner — operational definition of the RS gates.
// Drives the accepted physics + trick systems against a candidate run module,
// in plain node (no browser): the run system is pure logic.
//
// usage: node harness/run-runner.mjs --module sandbox/run-structure/A/run.mjs [--out <json>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modPath = resolve(ROOT, opt('module'));
const outPath = opt('out', null);

const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'run-structure');

const { createRun } = await import(pathToFileURL(modPath).href);
const { createPhysics } = await import(pathToFileURL(resolve(ROOT, 'src/physics/physics.mjs')).href);
const { createTricks } = await import(pathToFileURL(resolve(ROOT, 'src/tricks/tricks.mjs')).href);
// the real terrain: same analytic sampler the renderer and rig use
const render = await import(pathToFileURL(resolve(ROOT, 'src/render/main.mjs')).href);
const { sampleHeight } = render;

const DT = 1 / 60;

// Course centreline, measured from the analytic terrain (lowest point across the
// corridor at each z) — the same definition the rig and the render lane use.
function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CENTER = new Map();
const centerX = z => {
  const k = Math.round(z / 25) * 25;
  if (!CENTER.has(k)) CENTER.set(k, courseCenterX(k));
  return CENTER.get(k);
};

// LOD cell size the RENDERER actually uses at a given distance-from-camera is not
// knowable here, so confinement is judged against the WORST case the player can
// reach: inner corridor tiles are 250 m; outside them the backdrop is 1000 m/seg 12.
// Divergence = |analytic height - bilinear interpolation across that cell|.
const INNER = { x0: -1000, x1: 1000, z0: -250, z1: 2750 };
function divergenceAt(x, z) {
  const inInner = x >= INNER.x0 && x <= INNER.x1 && z >= INNER.z0 && z <= INNER.z1;
  const cell = inInner ? 250 / 16 : 1000 / 12;      // worst LOD the player can be near
  const gx = Math.floor(x / cell) * cell, gz = Math.floor(z / cell) * cell;
  const fx = (x - gx) / cell, fz = (z - gz) / cell;
  const h = (a, b) => sampleHeight(gx + a * cell, gz + b * cell);
  const bi = (h(0, 0) * (1 - fx) + h(1, 0) * fx) * (1 - fz) + (h(0, 1) * (1 - fx) + h(1, 1) * fx) * fz;
  return Math.abs(sampleHeight(x, z) - bi);
}

const env = () => ({ sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 } });

// One driven session: physics + tricks + run module stepped together.
function session({ duration = 120, inputFn = null, seedZ = null } = {}) {
  const e = { sampleHeight, sampleNormal: (x, z) => {
    const d = 0.05;
    const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
    const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
    const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
  }, surface: 'snow' };
  const ph = createPhysics(e, {});
  const tr = createTricks({});
  const run = createRun(env());
  const ts = tr.init();
  const rs = run.init();
  const z0 = seedZ ?? 15, x0 = centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 6], Math.PI / 2);
  const trace = [];
  let prev = [...st.pos];
  let maxJump = 0, maxDiv = 0;
  const n = Math.round(duration / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const inp = inputFn ? (inputFn(t, st, rs) ?? {}) : { tuck: true };
    ph.step(st, inp, DT);
    tr.step(ts, st, inp, DT);
    run.step(rs, st, ts, DT);
    const jump = Math.hypot(st.pos[0] - prev[0], st.pos[1] - prev[1], st.pos[2] - prev[2]);
    // a legitimate fast frame is ~0.6 m at 35 m/s; only count corrections
    if (rs.outOfBounds && jump > maxJump) maxJump = jump;
    maxDiv = Math.max(maxDiv, divergenceAt(st.pos[0], st.pos[2]));
    prev = [...st.pos];
    trace.push({ t, z: st.pos[2], phase: rs.phase, time_s: rs.time_s, score: ts.score });
    if (rs.phase === 'finished' && i > n * 0.02 && !inputFn) break;
  }
  return { st, ts, rs, run, tr, trace, maxJump, maxDiv };
}

const play = (t, st) => ({ tuck: true, boost: t > 3, steer: Math.sin(t * 0.35) * 0.35 });

const impl = {
  timer() {
    const s = session({ duration: 200, inputFn: play });
    const before = s.trace.filter(f => f.phase === 'ready');
    const during = s.trace.filter(f => f.phase === 'running');
    const after = s.trace.filter(f => f.phase === 'finished');
    const zeroBefore = before.every(f => f.time_s === 0);
    const monotonic = during.every((f, i) => i === 0 || f.time_s >= during[i - 1].time_s);
    const frozen = after.length < 2 || after.every(f => Math.abs(f.time_s - after[0].time_s) < 1e-9);
    return { timerPhaseCorrect: (zeroBefore && monotonic && frozen && during.length > 0) ? 1 : 0,
      _phases: { ready: before.length, running: during.length, finished: after.length } };
  },
  finish() {
    const s = session({ duration: 240, inputFn: play });
    const idx = s.trace.findIndex(f => f.phase === 'finished');
    if (idx < 1) return { finishDetect: 0, _why: 'never finished' };
    const zAt = s.trace[idx].z, zPrev = s.trace[idx - 1].z;
    const zF = s.run.config.zFinish;
    // crossed within one step, and the phase latches (never returns to running)
    const oneStep = zPrev < zF && zAt >= zF;
    const latched = s.trace.slice(idx).every(f => f.phase === 'finished');
    return { finishDetect: (oneStep && latched) ? 1 : 0, _zPrev: Math.round(zPrev), _zAt: Math.round(zAt), _zFinish: zF };
  },
  freeze() {
    const s = session({ duration: 260, inputFn: play });
    if (s.rs.phase !== 'finished') return { resultsFrozen: 0, _why: 'never finished' };
    const r1 = JSON.stringify(s.run.results(s.rs, s.ts));
    // keep driving well past the line
    const e2 = { sampleHeight, surface: 'snow', sampleNormal: () => [0, 1, 0] };
    for (let i = 0; i < 600; i++) { s.run.step(s.rs, s.st, s.ts, DT); }
    const r2 = JSON.stringify(s.run.results(s.rs, s.ts));
    return { resultsFrozen: r1 === r2 ? 1 : 0, _r1: r1.slice(0, 90) };
  },
  agree() {
    const s = session({ duration: 240, inputFn: play });
    if (s.rs.phase !== 'finished') return { resultsAgree: 0, _why: 'never finished' };
    const res = s.run.results(s.rs, s.ts);
    const scoreAtFinish = s.trace.find(f => f.phase === 'finished')?.score ?? -1;
    return { resultsAgree: Math.abs(res.score - scoreAtFinish) < 1e-6 ? 1 : 0,
      _reported: Math.round(res.score), _atFinish: Math.round(scoreAtFinish) };
  },
  confine(p) {
    // A player TRYING to leave, not a player spinning in circles: steer is a
    // proportional heading-seeker toward a target, so every phase actually makes
    // progress. (First version used raw hard steer and travelled 302 m in 240 s —
    // the gate passed vacuously because the rider never reached bad terrain.)
    const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    const seek = (st, tx, tz) => {
      const want = Math.atan2(tz - st.pos[2], tx - st.pos[0]);
      return Math.max(-1, Math.min(1, wrap(want - st.heading) * 1.8));
    };
    const D = p.duration;
    const adversarial = (t, st) => {
      const z = st.pos[2], cx = centerX(z);
      let tx, tz;
      if (t < D * 0.45) { tx = centerX(z + 120); tz = z + 120; }          // race down-course
      else if (t < D * 0.7) { tx = cx + 800; tz = z + 40; }               // bail hard RIGHT off-course
      else if (t < D * 0.85) { tx = cx - 800; tz = z + 40; }              // bail hard LEFT off-course
      else { tx = centerX(z + 120); tz = z + 400; }                       // straight past the finish
      return { tuck: true, boost: true, steer: seek(st, tx, tz) };
    };
    const s = session({ duration: D, inputFn: adversarial });
    // record how far the drive actually got — a confine gate that never leaves the
    // start is worthless, so report reach for the critic and for future readers
    const reachZ = Math.max(...s.trace.map(f => f.z));
    return { maxDivergenceReached_m: +s.maxDiv.toFixed(2), maxCorrectionJump_m: +s.maxJump.toFixed(3),
      _endZ: Math.round(s.st.pos[2]), _endX: Math.round(s.st.pos[0]), _reachZ: Math.round(reachZ),
      _phase: s.rs.phase, _driveReachedFinish: reachZ >= 2400 };
  },
  restart() {
    const hash = (s) => s.trace.slice(-40).map(f => `${f.z.toFixed(4)}|${f.time_s.toFixed(4)}|${f.score}`).join(',');
    const a = session({ duration: 60, inputFn: play });
    const b = session({ duration: 60, inputFn: play });
    // and an explicit restart() mid-session must reproduce the same forward path
    const c = session({ duration: 60, inputFn: play });
    c.run.restart(c.rs);
    return { restartDeterministic: (hash(a) === hash(b) && c.rs.time_s === 0 && c.rs.phase !== 'finished') ? 1 : 0,
      _sameHash: hash(a) === hash(b), _resetTime: c.rs.time_s };
  },
  duration() {
    const s = session({ duration: 300, inputFn: play });
    if (s.rs.phase !== 'finished') return { runDuration_s: 999, _why: 'never finished' };
    return { runDuration_s: +s.rs.time_s.toFixed(1) };
  },
  start() {
    // hold at the gate: no down-course progress while phase is 'ready'
    const s = session({ duration: 6, inputFn: (t) => (t < 4 ? {} : { tuck: true }) });
    const ready = s.trace.filter(f => f.phase === 'ready');
    if (!ready.length) return { startHolds: 1, _note: 'no ready phase (starts running)' };
    const drift = Math.abs(ready[ready.length - 1].z - ready[0].z);
    return { startHolds: drift < 3 ? 1 : 0, _driftM: +drift.toFixed(2) };
  },
};

const results = [];
for (const g of GATES) {
  const mode = g.scenario?.params?.mode;
  let row;
  try {
    const m = impl[mode](g.scenario.params);
    const val = m[g.metric];
    let pass;
    if (g.op === 'in_range') pass = val >= g.min && val <= g.max;
    else if (g.op === 'lte') pass = val <= g.value;
    else if (g.op === 'gte') pass = val >= g.value;
    else if (g.op === 'eq') pass = Math.abs(val - g.value) < 1e-9;
    const side = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('_')));
    row = { id: g.id, tag: g.tag, status: pass ? 'pass' : 'fail', metric: g.metric,
      value: typeof val === 'number' ? +Number(val).toPrecision(6) : val,
      expect: g.op === 'in_range' ? `[${g.min}, ${g.max}]` : `${g.op} ${g.value}`, ...side };
  } catch (err) {
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err.message).slice(0, 200) };
  }
  results.push(row);
}

const counts = { pass: 0, fail: 0, error: 0 };
let hardFails = 0;
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if (r.status !== 'pass' && r.tag === 'HARD') hardFails++;
}
const report = { module: modPath, counts, hardFails, results };
if (outPath) { mkdirSync(dirname(resolve(ROOT, outPath)), { recursive: true });
  writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2)); }
for (const r of results)
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status.toUpperCase()).padEnd(6)} ${r.id.padEnd(6)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + r.value : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? ''}`);
console.log(JSON.stringify({ counts, hardFails }));
process.exit(hardFails === 0 ? 0 : 2);
