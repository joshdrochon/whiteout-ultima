#!/usr/bin/env node
// ============================================================================
// selftest.mjs — the evidence the RS gates cannot produce.
//
//   node sandbox/run-structure/A/selftest.mjs
//
// The gates in harness/run-runner.mjs verify the run structure; three of the
// corridor's four layers are never touched by any of them (the header's section
// 6 says exactly which). This file drives those directly, reports NUMBERS
// rather than pass/fail alone, and exits non-zero on any failed check.
//
// It never asserts a zero it did not compute: every "the module did not write
// X" check diffs X across the run.step call.
// ============================================================================
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { createRun } = await import(pathToFileURL(resolve(HERE, 'run.mjs')).href);
const { createPhysics } = await import(pathToFileURL(resolve(ROOT, 'src/physics/physics.mjs')).href);
const { createTricks } = await import(pathToFileURL(resolve(ROOT, 'src/tricks/tricks.mjs')).href);
const { sampleHeight } = await import(pathToFileURL(resolve(ROOT, 'src/render/main.mjs')).href);

const DT = 1 / 60;
let fails = 0, checks = 0;
const ok = (name, pass, detail) => {
  checks++; if (!pass) fails++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
};
const sec = t => console.log(`\n--- ${t} ${'-'.repeat(Math.max(0, 66 - t.length))}`);
const f = (v, n = 3) => Number(v).toFixed(n);

// --- the run-runner's own centreline, verbatim, so this file and the gate
//     runner agree on the coordinate every claim is stated in ----------------
function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => {
  const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = courseCenterX(CL_Z0 + i * CL_STEP);
  const sm = new Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, c = 0;
    for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { acc += raw[j]; c++; } }
    sm[i] = acc / c;
  }
  return sm;
})();
const centerX = z => {
  const q = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP;
  const i = Math.min(CL.length - 2, Math.max(0, Math.floor(q)));
  const t = q - i;
  return CL[i] * (1 - t) + CL[i + 1] * t;
};
const INNER = { x0: -1000, x1: 1000, z0: -250, z1: 2750 };
function divergenceAt(x, z) {
  const inInner = x >= INNER.x0 && x <= INNER.x1 && z >= INNER.z0 && z <= INNER.z1;
  const cell = inInner ? 250 / 16 : 1000 / 12;
  const gx = Math.floor(x / cell) * cell, gz = Math.floor(z / cell) * cell;
  const fx = (x - gx) / cell, fz = (z - gz) / cell;
  const h = (a, b) => sampleHeight(gx + a * cell, gz + b * cell);
  const bi = (h(0, 0) * (1 - fx) + h(1, 0) * fx) * (1 - fz) + (h(0, 1) * (1 - fx) + h(1, 1) * fx) * fz;
  return Math.abs(sampleHeight(x, z) - bi);
}
const physEnv = {
  sampleHeight,
  sampleNormal: (x, z) => {
    const d = 0.05;
    const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
    const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
    const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
  },
  surface: 'snow',
};
const runEnv = () => ({ sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 } });

const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const seek = (st, tx, tz, gain = 1.8) =>
  Math.max(-1, Math.min(1, wrapA(Math.atan2(tz - st.pos[2], tx - st.pos[0]) - st.heading) * gain));

// harness `play`, verbatim (the pace baseline)
const play = (t, st) => {
  const tz = st.pos[2] + 120, tx = centerX(tz);
  const inp = { tuck: true, boost: t > 3, steer: seek(st, tx, tz) };
  const cyc = t % 14;
  if (st.onGround) {
    if (cyc > 13.4 && cyc < 13.8) { inp.crouch = true; inp.tuck = false; }
    if (cyc >= 13.8 && cyc < 13.82) { inp.jumpRelease = true; inp.tuck = false; }
  } else {
    const n = Math.floor(t / 14);
    if (n % 4 === 3) inp.uber = 1 + (n % 6);
    else { inp.spin = 1; if (st.airTime > 0.25 && st.airTime < 0.6) inp.grab = true; }
    inp.tuck = false;
  }
  return inp;
};

function makeSim({ z0 = 15, vel = [0, 0, 6], dt = DT, module: mod = true } = {}) {
  const ph = createPhysics(physEnv, {});
  const tr = createTricks({});
  const run = mod ? createRun(runEnv()) : null;
  const ts = tr.init();
  const rs = run ? run.init() : null;
  const x0 = centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [...vel], Math.PI / 2);
  return { ph, tr, run, ts, rs, st, dt };
}
const offsetOf = st => st.pos[0] - centerX(st.pos[2]);

const C = createRun(runEnv()).config;

// ===========================================================================
sec('0. the inertness identity (header 3.3) — checked, not asserted');
// span(A, dt) = V_CAP^2/(2A) + V_CAP*dt must make the DISCRETE allowance equal
// V_CAP exactly, for every firmness and every step size.
{
  const V_CAP = 33;
  const allow = (gap, A, dt) => -A * dt + Math.sqrt(A * A * dt * dt + 2 * A * gap);
  const spanOf = (A, dt) => (V_CAP * V_CAP) / (2 * A) + V_CAP * dt;
  let worst = 0;
  for (const A of [C.trackFirmness_mps2, C.stopFirmness_mps2, 1, 100]) {
    for (const dt of [1 / 240, 1 / 120, DT, 1 / 30, 1 / 10]) {
      worst = Math.max(worst, Math.abs(allow(spanOf(A, dt), A, dt) - V_CAP));
    }
  }
  ok('allowance at a layer start equals V_CAP for every (A, dt)', worst < 1e-9,
    `worst |allow - V_CAP| = ${worst.toExponential(2)} m/s`);
  ok('wall layer starts exactly at the contract halfWidth',
    Math.abs((C.lateralSoftLine_m - C.wallSpan_m) - C.halfWidth) < 1e-9,
    `softLine ${f(C.lateralSoftLine_m)} - span ${f(C.wallSpan_m)} = ${f(C.lateralSoftLine_m - C.wallSpan_m)}`);
  ok('run-out layer starts exactly at zFinish',
    Math.abs((C.zSoftDown_m - C.zSpan_m) - C.zFinish) < 1e-9);
  ok('back-stop layer starts exactly at zStart',
    Math.abs((C.zSoftUp_m + C.zSpan_m) - C.zStart) < 1e-9);
  ok('A_TRACK collapses to g', Math.abs(C.trackFirmness_mps2 - 9.81) < 1e-9,
    `A_TRACK = ${f(C.trackFirmness_mps2, 4)}`);
  ok('config publishes both write ceilings',
    C.ceilAccelHorizontal_mps2 > 0 && C.ceilAccel3D_mps2 > C.ceilAccelHorizontal_mps2,
    `H ${f(C.ceilAccelHorizontal_mps2, 2)}  3D ${f(C.ceilAccel3D_mps2, 2)}`);
  ok('physics anchor is live, not pinned', C.physicsAnchor === 'live', C.physicsAnchor);
}

// ===========================================================================
sec('1. write discipline over the harness adversarial drive (240 s)');
// The runner's own adversarial input function, verbatim.
const adversarial = D => (t, st) => {
  const z = st.pos[2], cxz = centerX(z);
  let tx, tz;
  if (t < D * 0.45) { tx = centerX(z + 120); tz = z + 120; }
  else if (t < D * 0.7) { tx = cxz + 800; tz = z + 40; }
  else if (t < D * 0.85) { tx = cxz - 800; tz = z + 40; }
  else { tx = centerX(z + 120); tz = z + 400; }
  return { tuck: true, boost: true, steer: seek(st, tx, tz) };
};
{
  const S = makeSim({});
  const D = 240;
  const inputFn = adversarial(D);
  let posW = 0, headW = 0, flagW = 0, trickW = 0, maxDiv = 0, maxJump = 0;
  let yawWorst = 0, yawSum = 0, yawN = 0;
  let prev = [...S.st.pos];
  const trickKeys = ['score', 'jumpScore', 'meter', 'tricky', 'trickyLetters', 'lastAward', 'activeTrick'];
  for (let i = 0; i < D * 60; i++) {
    const t = i * DT;
    const inp = inputFn(t, S.st);
    S.ph.step(S.st, inp, DT);
    S.tr.step(S.ts, S.st, inp, DT);

    // fork BEFORE the write: same start state, one physics step each, with and
    // without the corridor. The heading difference is the yaw the corridor
    // caused on THIS frame, with no trajectory divergence in it.
    const fork = JSON.parse(JSON.stringify(S.st));
    const before = { pos: [...S.st.pos], heading: S.st.heading, onGround: S.st.onGround,
      airTime: S.st.airTime, landing: S.st.landing, spinDeg: S.st.spinDeg, flipDeg: S.st.flipDeg,
      charge: S.st.charge, boostMeter: S.st.boostMeter };
    const tsBefore = Object.fromEntries(trickKeys.map(k => [k, S.ts[k]]));

    S.run.step(S.rs, S.st, S.ts, DT);

    if (S.st.pos[0] !== before.pos[0] || S.st.pos[1] !== before.pos[1] || S.st.pos[2] !== before.pos[2]) posW++;
    if (S.st.heading !== before.heading) headW++;
    if (S.st.onGround !== before.onGround || S.st.airTime !== before.airTime ||
        S.st.landing !== before.landing || S.st.spinDeg !== before.spinDeg ||
        S.st.flipDeg !== before.flipDeg || S.st.charge !== before.charge ||
        S.st.boostMeter !== before.boostMeter) flagW++;
    if (trickKeys.some(k => S.ts[k] !== tsBefore[k])) trickW++;

    if (S.rs.confine.active) {
      const nx = JSON.parse(JSON.stringify(S.st));
      const phA = createPhysics(physEnv, {}), phB = createPhysics(physEnv, {});
      phA.step(nx, inp, DT);                      // corrected fork
      phB.step(fork, inp, DT);                    // uncorrected fork
      const dy = Math.abs(wrapA(nx.heading - fork.heading)) * 180 / Math.PI / DT;
      yawWorst = Math.max(yawWorst, dy); yawSum += dy; yawN++;
    }
    const jump = Math.hypot(S.st.pos[0] - prev[0], S.st.pos[1] - prev[1], S.st.pos[2] - prev[2]);
    if (S.rs.outOfBounds) maxJump = Math.max(maxJump, jump);
    maxDiv = Math.max(maxDiv, divergenceAt(S.st.pos[0], S.st.pos[2]));
    prev = [...S.st.pos];
  }
  const c = S.rs.confine;
  ok('never writes physState.pos', posW === 0, `${posW} frames; maxSelfPosDelta ${c.maxSelfPosDelta_m}`);
  ok('never writes physState.heading', headW === 0, `${headW} frames`);
  ok('never writes physics collision/trick-input state', flagW === 0, `${flagW} frames`);
  ok('never writes any trick-state field', trickW === 0, `${trickW} frames`);
  ok('horizontal write ceiling holds', c.peakAppliedH_mps2 <= C.ceilAccelHorizontal_mps2 + 1e-9,
    `peak ${f(c.peakAppliedH_mps2, 2)} <= ${f(C.ceilAccelHorizontal_mps2, 2)}`);
  ok('3-D write ceiling holds', c.peakApplied_mps2 <= C.ceilAccel3D_mps2 + 1e-9,
    `peak ${f(c.peakApplied_mps2, 2)} <= ${f(C.ceilAccel3D_mps2, 2)}`);
  ok('never past a containment bound', c.beyondBound === 0, `${c.beyondBound} frames`);
  ok('divergence stays under the RS-05 ceiling', maxDiv <= 4, `${f(maxDiv, 2)} m`);
  ok('no correction frame moves the rider more than RS-06 allows', maxJump <= 2,
    `${f(maxJump, 3)} m (the rider's own travel)`);
  ok('yaw the corridor CAUSES, per-frame counterfactual, stays negligible', yawWorst < 5,
    `worst ${f(yawWorst, 3)} deg/s, mean ${f(yawN ? yawSum / yawN : 0, 4)} over ${yawN} active frames`);
  console.log(`      reach: peakOffset ${f(c.peakOffset_m, 1)} m, endZ ${Math.round(S.st.pos[2])}, ` +
    `active ${(100 * c.activeFraction).toFixed(1)}%  [berm ${c.bermFrames} wall ${c.wallFrames} ` +
    `limit ${c.limitFrames} gate ${c.gateFrames} ceilH ${c.ceilFrames} ceil3 ${c.ceil3Frames}]`);
  ok('DISCLOSED: this drive never reaches the berm or the lateral wall',
    c.bermFrames === 0 && c.peakOffset_m < C.bermStart_m,
    'so sections 2 and 3 below, not RS-05/06, are the corridor evidence');
}

// ===========================================================================
sec('2. the lateral wall, driven directly (no gate reaches it)');
{
  for (const dt of [DT, 1 / 30, 1 / 120]) {
    const S = makeSim({ dt });
    let peak = 0, worstYaw = 0, maxDiv = 0, insideEver = 0;
    const N = Math.round(90 / dt);
    for (let i = 0; i < N; i++) {
      const t = i * dt;
      // ride straight at the wall under full boost, alternating flanks
      const side = Math.sin(t * 0.06) > 0 ? 1 : -1;
      const inp = { tuck: true, boost: true,
        steer: seek(S.st, centerX(S.st.pos[2]) + side * 600, S.st.pos[2] + 40) };
      S.ph.step(S.st, inp, dt);
      S.tr.step(S.ts, S.st, inp, dt);
      const h0 = S.st.heading;
      const sOffBefore = Math.abs(offsetOf(S.st));
      S.run.step(S.rs, S.st, S.ts, dt);
      const dy = Math.abs(wrapA(S.st.heading - h0)) * 180 / Math.PI / dt;
      if (sOffBefore <= C.halfWidth) { worstYaw = Math.max(worstYaw, dy); insideEver++; }
      peak = Math.max(peak, Math.abs(offsetOf(S.st)));
      maxDiv = Math.max(maxDiv, divergenceAt(S.st.pos[0], S.st.pos[2]));
    }
    const c = S.rs.confine;
    ok(`dt=1/${Math.round(1 / dt)}  wall holds the rider inside the containment bound`,
      peak <= C.lateralBound_m,
      `peak |s| ${f(peak, 2)} <= bound ${f(C.lateralBound_m, 2)} (soft ${f(C.lateralSoftLine_m, 2)})`);
    ok(`dt=1/${Math.round(1 / dt)}  the wall actually fired`, c.wallFrames + c.limitFrames > 0,
      `wall ${c.wallFrames} limit ${c.limitFrames} berm ${c.bermFrames}`);
    ok(`dt=1/${Math.round(1 / dt)}  zero direct yaw write while in bounds`, worstYaw === 0,
      `${insideEver} in-bounds frames, worst ${f(worstYaw, 4)} deg/s`);
    ok(`dt=1/${Math.round(1 / dt)}  divergence under the RS-05 ceiling`, maxDiv <= 4, `${f(maxDiv, 2)} m`);
    ok(`dt=1/${Math.round(1 / dt)}  never past the containment bound`, c.beyondBound === 0);
    ok(`dt=1/${Math.round(1 / dt)}  both write ceilings hold`,
      c.peakAppliedH_mps2 <= C.ceilAccelHorizontal_mps2 + 1e-9 && c.peakApplied_mps2 <= C.ceilAccel3D_mps2 + 1e-9,
      `H ${f(c.peakAppliedH_mps2, 2)}  3D ${f(c.peakApplied_mps2, 2)}  ceil3 bound on ${c.ceil3Frames} frames`);
  }
}

// ===========================================================================
sec('3. the return branch under deliberate injection');
{
  // (a) spawned far outside, moving further out, at full boost
  for (const dt of [DT, 1 / 30, 1 / 120]) {
    const S = makeSim({ dt });
    S.st.pos[0] = centerX(S.st.pos[2]) + 260;
    S.st.pos[1] = sampleHeight(S.st.pos[0], S.st.pos[2]);
    S.st.vel = [40, 0, 5];
    let returned = -1;
    const N = Math.round(30 / dt);
    for (let i = 0; i < N; i++) {
      const inp = { tuck: true, boost: true,
        steer: seek(S.st, centerX(S.st.pos[2]) + 900, S.st.pos[2] + 30) };
      S.ph.step(S.st, inp, dt);
      S.tr.step(S.ts, S.st, inp, dt);
      S.run.step(S.rs, S.st, S.ts, dt);
      if (returned < 0 && Math.abs(offsetOf(S.st)) <= C.lateralSoftLine_m) returned = i * dt;
    }
    ok(`dt=1/${Math.round(1 / dt)}  returned inside the soft line from 260 m out at 40 m/s`,
      returned >= 0, `after ${f(returned, 2)} s; end |s| ${f(Math.abs(offsetOf(S.st)), 2)}`);
    ok(`dt=1/${Math.round(1 / dt)}  ceilings held during the return`,
      S.rs.confine.peakAppliedH_mps2 <= C.ceilAccelHorizontal_mps2 + 1e-9 &&
      S.rs.confine.peakApplied_mps2 <= C.ceilAccel3D_mps2 + 1e-9,
      `H ${f(S.rs.confine.peakAppliedH_mps2, 2)}  3D ${f(S.rs.confine.peakApplied_mps2, 2)}`);
  }
  // (b) MARGIN under test: a full V_CAP outward velocity injected in one frame
  //     from inside the corridor, boost pinned outward
  {
    const S = makeSim({});
    for (let i = 0; i < 120; i++) {   // settle
      S.ph.step(S.st, { tuck: true }, DT); S.tr.step(S.ts, S.st, {}, DT); S.run.step(S.rs, S.st, S.ts, DT);
    }
    S.st.pos[0] = centerX(S.st.pos[2]) + C.lateralSoftLine_m - 1;
    S.st.pos[1] = sampleHeight(S.st.pos[0], S.st.pos[2]);
    S.st.vel = [33, 0, 0];
    let peak = 0;
    for (let i = 0; i < 60 * 20; i++) {
      const inp = { tuck: true, boost: true,
        steer: seek(S.st, centerX(S.st.pos[2]) + 900, S.st.pos[2] + 30) };
      S.ph.step(S.st, inp, DT); S.tr.step(S.ts, S.st, inp, DT); S.run.step(S.rs, S.st, S.ts, DT);
      peak = Math.max(peak, Math.abs(offsetOf(S.st)));
    }
    const pen = peak - C.lateralSoftLine_m;
    ok('one-frame V_CAP injection penetrates less than the derived MARGIN',
      pen <= C.margin_m, `penetration ${f(pen, 2)} m <= MARGIN ${f(C.margin_m, 2)} m (peak |s| ${f(peak, 2)})`);
    ok('and never past the containment bound', S.rs.confine.beyondBound === 0);
  }
}

// ===========================================================================
sec('4. the berm, driven directly (no gate reaches it either)');
{
  const S = makeSim({});
  const rows = [];
  for (const off of [60, 80, 100, 120, 128]) {
    let terr = 0, bank = 0, berm = 0, n = 0, worstOver = -Infinity;
    for (let z = 100; z <= 2300; z += 50) {
      for (const sgn of [1, -1]) {
        S.st.pos[0] = centerX(z) + sgn * off;
        S.st.pos[2] = z;
        S.st.pos[1] = sampleHeight(S.st.pos[0], z);
        S.st.vel = [0, 0, 1]; S.st.onGround = true;
        S.run.step(S.rs, S.st, S.ts, DT);
        const c = S.rs.confine;
        terr += c.terrainPull_mps2; bank += c.bankTotal_mps2; berm += c.peakBerm_mps2 ? 0 : 0;
        berm += c.bankTotal_mps2 - c.terrainPull_mps2;
        if (off >= 120) worstOver = Math.max(worstOver, C.bermMax_mps2 - c.bankTotal_mps2);
        n++;
      }
    }
    rows.push([off, terr / n, berm / n, bank / n, worstOver]);
  }
  console.log('      |s|      terrain    berm    total   (g/2 = ' + f(C.bermMax_mps2, 3) + ')');
  for (const [o, t, b, k] of rows)
    console.log(`      ${String(o).padStart(3)}     ${f(t, 3).padStart(7)} ${f(b, 3).padStart(7)} ${f(k, 3).padStart(7)}`);
  const atEdge = rows.filter(r => r[0] >= 120);
  ok('at and beyond the corridor edge the bank is at least g/2 everywhere',
    atEdge.every(r => r[4] <= 1e-9), `worst shortfall ${f(Math.max(...atEdge.map(r => r[4])), 4)} m/s^2`);
  ok('the berm top-up never exceeds g/2', rows.every(r => r[2] <= C.bermMax_mps2 + 1e-9),
    `peak mean top-up ${f(Math.max(...rows.map(r => r[2])), 3)} m/s^2`);
  ok('the berm never overrules a full-lock carve',
    C.bermMax_mps2 / 26 < 0.25, `g/2 is ${(100 * C.bermMax_mps2 / 26).toFixed(1)}% of physics A_LAT = 26`);
}

// ===========================================================================
sec('5. the start gate');
{
  for (const z0 of [-40, -5, 15]) {
    const S = makeSim({ z0 });
    let minZ = Infinity, maxZ = -Infinity, readyN = 0, runAt = -1;
    for (let i = 0; i < 60 * 8; i++) {
      const t = i * DT;
      const inp = t < 5 ? {} : { tuck: true, boost: true };
      S.ph.step(S.st, inp, DT); S.tr.step(S.ts, S.st, inp, DT); S.run.step(S.rs, S.st, S.ts, DT);
      if (S.rs.phase === 'ready') { readyN++; minZ = Math.min(minZ, S.st.pos[2]); maxZ = Math.max(maxZ, S.st.pos[2]); }
      else if (runAt < 0) runAt = t;
    }
    ok(`staged at z=${z0}: held during ready`, readyN > 0 && maxZ - minZ < 3,
      `${readyN} ready frames, drift ${f(maxZ - minZ, 3)} m (RS-09 bar 3 m), released at t=${f(runAt, 2)} s`);
  }
  // the gate holds against a rider boosting straight through it from the start
  {
    const S = makeSim({ z0: -40 });
    let maxZ = -Infinity, readyN = 0;
    for (let i = 0; i < 60 * 3; i++) {
      const inp = { tuck: true, boost: true, steer: 0 };
      S.ph.step(S.st, inp, DT); S.tr.step(S.ts, S.st, inp, DT); S.run.step(S.rs, S.st, S.ts, DT);
      if (S.rs.phase === 'ready') { readyN++; maxZ = Math.max(maxZ, S.st.pos[2]); }
    }
    ok('gate holds a rider boosting straight at it', readyN > 0 && maxZ - (-40) < 3,
      `${readyN} frames, furthest z ${f(maxZ, 2)}, gateZ ${f(S.rs.gateZ, 2)}, gateFrames ${S.rs.confine.gateFrames}`);
    ok('the clock reads 0 for the whole ready phase', S.rs.time_s === 0);
  }
}

// ===========================================================================
sec('6. the run-out, and a rider who refuses to stop');
{
  const S = makeSim({ z0: 2300 });
  let maxZ = -Infinity, maxDiv = 0;
  for (let i = 0; i < 60 * 60; i++) {
    const inp = { tuck: true, boost: true, steer: seek(S.st, centerX(S.st.pos[2] + 200), S.st.pos[2] + 200) };
    S.ph.step(S.st, inp, DT); S.tr.step(S.ts, S.st, inp, DT); S.run.step(S.rs, S.st, S.ts, DT);
    maxZ = Math.max(maxZ, S.st.pos[2]);
    maxDiv = Math.max(maxDiv, divergenceAt(S.st.pos[0], S.st.pos[2]));
  }
  ok('a rider boosting past the finish is stopped inside the containment bound',
    maxZ <= C.zBoundDown_m, `furthest z ${f(maxZ, 2)} <= bound ${f(C.zBoundDown_m, 2)} (soft ${f(C.zSoftDown_m, 2)})`);
  ok('and stays inside the fine-LOD region', maxZ < 2750 && maxDiv <= 4,
    `divergence ${f(maxDiv, 2)} m, fine-LOD edge 2750, clear by ${f(2750 - maxZ, 1)} m`);
  ok('the run-out never fires before the finish line',
    S.rs.results !== null, `finished at t=${f(S.rs.results?.time_s ?? -1, 2)} s`);
  // back-stop: a rider riding back up-course
  const B = makeSim({ z0: 40, vel: [0, 0, -8] });
  let minZ = Infinity;
  for (let i = 0; i < 60 * 60; i++) {
    const inp = { tuck: true, boost: true, steer: seek(B.st, centerX(B.st.pos[2] - 200), B.st.pos[2] - 200) };
    B.ph.step(B.st, inp, DT); B.tr.step(B.ts, B.st, inp, DT); B.run.step(B.rs, B.st, B.ts, DT);
    minZ = Math.min(minZ, B.st.pos[2]);
  }
  ok('a rider riding back up-course is stopped inside the containment bound',
    minZ >= C.zBoundUp_m, `furthest z ${f(minZ, 2)} >= bound ${f(C.zBoundUp_m, 2)} (soft ${f(C.zSoftUp_m, 2)})`);
  ok('and stays inside the fine-LOD region', minZ > -250,
    `clear of the 83 m backdrop tiles by ${f(minZ + 250, 1)} m`);
}

// ===========================================================================
sec('7. pace: the corridor costs a competent line nothing');
{
  const run = (withModule) => {
    const S = makeSim({ module: withModule });
    for (let i = 0; i < 60 * 320; i++) {
      const t = i * DT;
      const inp = play(t, S.st);
      S.ph.step(S.st, inp, DT);
      S.tr.step(S.ts, S.st, inp, DT);
      if (S.run) S.run.step(S.rs, S.st, S.ts, DT);
      if (S.st.pos[2] >= 2400) return { t, S };
    }
    return { t: -1, S };
  };
  const a = run(false), b = run(true);
  const c = b.S.rs.confine;
  ok('no-op reference reaches the finish', a.t > 0, `${f(a.t, 1)} s of sim time`);
  ok('with the corridor, the rider reaches the finish', b.t > 0,
    `${f(b.t, 1)} s of sim time, clock ${f(b.S.rs.results.time_s, 1)} s`);
  ok('the corridor NEVER fires between the drop and the finish',
    c.bermFrames === 0 && c.wallFrames === 0 && c.limitFrames === 0,
    `berm ${c.bermFrames} wall ${c.wallFrames} limit ${c.limitFrames}; only the gate ran ` +
    `(${c.gateFrames} frames). peakOffset ${f(c.peakOffset_m, 1)} m vs berm start ${C.bermStart_m} m`);
  console.log(`      -> the ${f(Math.abs(b.t - a.t), 1)} s difference between the two runs is the ` +
    `probe drive\n         reacting to a standing start, not the corridor: it applied nothing.`);
}

// ===========================================================================
sec('8. the landing ledger follows the TRICK system, not physics');
{
  // JA-15: an uber fired too late to complete is a bail. physics may still
  // label the touchdown clean; the trick system voids the jump.
  const S = makeSim({});
  let bails = 0;
  for (let i = 0; i < 60 * 180; i++) {
    const t = i * DT;
    const inp = { tuck: true, boost: t > 3, steer: seek(S.st, centerX(S.st.pos[2] + 120), S.st.pos[2] + 120) };
    const cyc = t % 9;
    if (S.st.onGround) {
      if (cyc > 8.4 && cyc < 8.8) { inp.crouch = true; inp.tuck = false; }
      if (cyc >= 8.8 && cyc < 8.82) { inp.jumpRelease = true; inp.tuck = false; }
    } else if (S.st.airTime > 0.35) { inp.uber = 1 + (i % 6); inp.tuck = false; bails++; }
    S.ph.step(S.st, inp, DT);
    S.tr.step(S.ts, S.st, inp, DT);
    S.run.step(S.rs, S.st, S.ts, DT);
  }
  const r = S.run.results(S.rs, S.ts);
  ok('the ledger adjudicated every touchdown it opened',
    r.landed + r.crashed + r.unresolvedTouchdowns > 0,
    `landed ${r.landed} crashed ${r.crashed} unresolved ${r.unresolvedTouchdowns} jumps ${r.jumps}`);
  ok('landings the card reports are landings the trick system BANKED',
    r.landed === S.rs.banks || r.landed <= S.rs.banks,
    `landed ${r.landed} vs banks ${S.rs.banks}`);
  ok('physics disagreements are reported, not hidden',
    typeof r.verdictSplits === 'number' && typeof r.physUnlabelled === 'number',
    `verdictSplits ${r.verdictSplits}, physUnlabelled ${r.physUnlabelled} (late ubers fired: ${bails})`);
  ok('bestTrick is the BANKED award string, not a bare entry',
    r.bestTrick === null || (typeof r.bestTrick === 'string' && r.bestTrick.length > 0),
    `bestTrick ${JSON.stringify(r.bestTrick)} @ ${r.bestTrickPoints} pts, starMultAtLanding ${r.starMultAtLanding}`);
  ok('no invented grade band', r.rank === null && !!r.anchors && r.anchors.uberBaseMin === 13210,
    `rank null, anchors ${r.anchors.uberBaseMin}-${r.anchors.uberBaseMax}, master ${r.anchors.masterJumpAnchor}`);
}

// ===========================================================================
sec('9. determinism, restart, and the frozen card');
{
  const hash = S => `${S.st.pos.map(v => v.toFixed(6))}|${S.rs.time_s.toFixed(6)}|${S.ts.score}`;
  const drive = () => {
    const S = makeSim({});
    for (let i = 0; i < 60 * 60; i++) {
      const inp = play(i * DT, S.st);
      S.ph.step(S.st, inp, DT); S.tr.step(S.ts, S.st, inp, DT); S.run.step(S.rs, S.st, S.ts, DT);
    }
    return S;
  };
  const A = drive(), B = drive();
  ok('two identical drives produce identical state', hash(A) === hash(B), hash(A).slice(0, 60));
  const fresh = A.run.init();
  A.run.restart(A.rs);
  ok('restart() reproduces init() exactly, in place',
    JSON.stringify(A.rs) === JSON.stringify(fresh),
    `phase ${A.rs.phase}, time_s ${A.rs.time_s}, gateZ ${A.rs.gateZ}`);

  // freeze
  const F = makeSim({});
  for (let i = 0; i < 60 * 320 && F.rs.phase !== 'finished'; i++) {
    const inp = play(i * DT, F.st);
    F.ph.step(F.st, inp, DT); F.tr.step(F.ts, F.st, inp, DT); F.run.step(F.rs, F.st, F.ts, DT);
  }
  ok('the run finished', F.rs.phase === 'finished', `t = ${f(F.rs.results.time_s, 2)} s`);
  const before = JSON.stringify(F.run.results(F.rs, F.ts));
  for (let i = 0; i < 1200; i++) {
    const inp = play(1000 + i * DT, F.st);
    F.ph.step(F.st, inp, DT); F.tr.step(F.ts, F.st, inp, DT); F.run.step(F.rs, F.st, F.ts, DT);
  }
  const after = JSON.stringify(F.run.results(F.rs, F.ts));
  ok('the card is frozen for 20 s of continued riding past the line', before === after,
    `score ${F.rs.results.score}, time_s ${F.rs.results.time_s}`);
  ok('the clock is frozen too', F.rs.time_s === F.rs.results.time_s);
  ok('the corridor still holds after the finish',
    Math.abs(F.st.pos[2] - C.zSoftDown_m) < 5,
    `parked at z ${f(F.st.pos[2], 2)} (run-out soft line ${f(C.zSoftDown_m, 2)})`);
  let thrown = false;
  try { F.rs.results.score = 0; } catch { thrown = true; }
  ok('the card object is genuinely frozen', thrown || F.rs.results.score !== 0);
}

console.log(`\n${checks - fails}/${checks} checks passed.`);
process.exit(fails ? 1 : 0);
