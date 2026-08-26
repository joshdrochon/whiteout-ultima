#!/usr/bin/env node
// Self-check for this run-structure module.
//
// The RS gate suite cannot reach several of this module's claims, because the
// harness's own drives never put the rider where the mechanism lives:
//   * the probe drive `play` never leaves ±34.1 m of centre, and the berm
//     starts at 55 m — so RS-10 measures a module that writes nothing.
//   * against this module the adversarial drive never gets more than 38.6 m off
//     centre (it reaches the run-out and is held there), so RS-05/RS-06 exercise
//     neither the berm, nor the wall, nor the return branch.
//   * the harness seeds at z = 15, 15 m PAST zStart, so no start-gate run
//     exists in the lane at all.
//   * the probe never lands a jump physics and the trick system disagree about,
//     so the ledger's adjudication rule is never exercised.
// This file drives all four directly and REPORTS NUMBERS, not just pass/fail.
//
// usage: node sandbox/run-structure/A/selftest.mjs      (exit 0 = all pass)

import { createRun } from './run.mjs';
import { createPhysics } from '../../../src/physics/physics.mjs';
import { createTricks } from '../../../src/tricks/tricks.mjs';
import { sampleHeight } from '../../../src/render/main.mjs';

let fails = 0, checks = 0;
const ok = (cond, label, detail = '') => {
  checks++;
  if (!cond) { fails++; console.log(`FAIL  ${label}  ${detail}`); }
  else console.log(`pass  ${label}  ${detail}`);
};
const note = (label, detail) => console.log(`      ${label}  ${detail}`);

function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CEN = new Map();
const centerX = z => { const k = Math.round(z / 25) * 25; if (!CEN.has(k)) CEN.set(k, courseCenterX(k)); return CEN.get(k); };
const env = () => ({ sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 } });
const physEnv = { sampleHeight, sampleNormal: (x, z) => {
  const d = 0.05;
  const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
  const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
  const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
}, surface: 'snow' };

const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const seek = (st, tx, tz, g = 1.8) =>
  Math.max(-1, Math.min(1, wrapA(Math.atan2(tz - st.pos[2], tx - st.pos[0]) - st.heading) * g));

// the harness's own probe drive, verbatim in behaviour
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

const cfg = createRun(env()).config;
console.log('--- derived geometry -------------------------------------------------');
for (const k of ['driveMax_mps2', 'stopFirmness_mps2', 'brakeFirmness_mps2', 'bermMax_mps2',
  'ceilAccelHorizontal_mps2', 'ceilAccel3D_mps2', 'trackableFirmness_mps2',
  'margin_m', 'bermStart_m', 'wallStart_m', 'lateralSoftLine_m',
  'lateralBound_m', 'zSoftDown_m', 'zBoundDown_m', 'zSoftUp_m', 'zBoundUp_m',
  'runout_m', 'gateSpan_m', 'physicsAnchor'])
  note(k.padEnd(22), String(cfg[k]));

// ---------------------------------------------------------------------------
// 1. STRUCTURAL: the module never writes pos / heading / trick state, and the
//    corridor never exceeds either write ceiling. Driven adversarially so the
//    field is live.
// ---------------------------------------------------------------------------
console.log('\n--- 1. write discipline under a live corridor ------------------------');
function adversarial(D) {
  return (t, st) => {
    const z = st.pos[2], cx = centerX(z);
    let tx, tz;
    if (t < D * 0.45) { tx = centerX(z + 120); tz = z + 120; }
    else if (t < D * 0.7) { tx = cx + 800; tz = z + 40; }
    else if (t < D * 0.85) { tx = cx - 800; tz = z + 40; }
    else { tx = centerX(z + 120); tz = z + 400; }
    return { tuck: true, boost: true, steer: seek(st, tx, tz) };
  };
}

function drive({ duration, inputFn, dt = 1 / 60, seed = null, withRun = true, inject = null,
  forceTravel = false }) {
  const ph = createPhysics(physEnv, {});
  const tr = createTricks({});
  const run = createRun(env());
  const ts = tr.init(), rs = run.init();
  const z0 = seed?.z ?? 15;
  const x0 = seed?.x ?? centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], seed?.v ?? [0, 0, 6], seed?.h ?? Math.PI / 2);
  const trace = [];
  let maxTravel = 0, prev = [...st.pos];
  const n = Math.round(duration / dt);
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const inp = inputFn(t, st) ?? {};
    ph.step(st, inp, dt);
    tr.step(ts, st, inp, dt);
    if (inject) inject(t, st);
    const headBefore = st.heading;
    const posBefore = [...st.pos];
    const tsSnap = JSON.stringify({ s: ts.score, m: ts.meter, l: ts.trickyLetters, a: ts.awards.length });
    if (withRun) run.step(rs, st, ts, dt);
    if (withRun) {
      if (st.heading !== headBefore) throw new Error('module wrote heading');
      if (st.pos[0] !== posBefore[0] || st.pos[1] !== posBefore[1] || st.pos[2] !== posBefore[2])
        throw new Error('module wrote pos');
      if (JSON.stringify({ s: ts.score, m: ts.meter, l: ts.trickyLetters, a: ts.awards.length }) !== tsSnap)
        throw new Error('module wrote trick state');
    }
    const tv = Math.hypot(st.pos[0] - prev[0], st.pos[1] - prev[1], st.pos[2] - prev[2]);
    if ((forceTravel || rs.outOfBounds) && tv > maxTravel) maxTravel = tv;
    prev = [...st.pos];
    trace.push({ t, x: st.pos[0], z: st.pos[2], s: st.pos[0] - centerX(st.pos[2]),
      h: st.heading, oob: !!rs.outOfBounds });
  }
  return { st, ts, rs, run, trace, maxTravel };
}

let A;
try {
  A = drive({ duration: 240, inputFn: adversarial(240) });
  ok(true, 'no pos / heading / trick-state write over 240 s adversarial drive');
} catch (e) { ok(false, 'write discipline', e.message); A = null; }

if (A) {
  const c = A.rs.confine;
  ok(c.maxSelfPosDelta_m === 0, 'maxSelfPosDelta_m (diffed around every write)', String(c.maxSelfPosDelta_m));
  ok(c.peakAppliedH_mps2 <= cfg.ceilAccelHorizontal_mps2 + 1e-9,
    'every horizontal correction <= A_HCEIL',
    `peak ${c.peakAppliedH_mps2.toFixed(2)} <= ${cfg.ceilAccelHorizontal_mps2.toFixed(3)}`);
  ok(c.peakApplied_mps2 <= cfg.ceilAccel3D_mps2 + 1e-9, 'every 3-D write <= A_CEIL3',
    `peak ${c.peakApplied_mps2.toFixed(2)} <= ${cfg.ceilAccel3D_mps2.toFixed(2)}`);
  ok(c.beyondBound === 0, 'frames past a containment bound', String(c.beyondBound));
  ok(A.maxTravel <= 2, 'RS-06 per-frame travel while correcting', `${A.maxTravel.toFixed(3)} m`);
  const maxS = Math.max(...A.trace.map(f => Math.abs(f.s)));
  ok(maxS <= cfg.lateralBound_m, 'widest offset reached vs containment bound',
    `${maxS.toFixed(1)} m vs ${cfg.lateralBound_m.toFixed(1)} m`);
  note('layer frames'.padEnd(22),
    `berm ${c.bermFrames}  wall ${c.wallFrames}  limit ${c.limitFrames}  gate ${c.gateFrames}  ceilH ${c.ceilFrames}  ceil3D ${c.ceil3Frames}  active ${(100 * c.activeFraction).toFixed(1)}%`);
  note('peak berm top-up'.padEnd(22), `${c.peakBerm_mps2.toFixed(3)} m/s^2`);
  note('peak demand pre-ceiling'.padEnd(22), `${c.peakDemand_mps2.toFixed(1)} m/s^2`);
  note('end position'.padEnd(22), `z ${A.st.pos[2].toFixed(1)}  s ${(A.st.pos[0] - centerX(A.st.pos[2])).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// 1b. THE BERM — never fired by any harness drive (they stay inside 38.6 m and
//     the berm starts at 55 m). Driven directly here, and its central claim
//     checked at runtime: at and beyond the corridor edge the corridor's bank
//     is exactly g/2, the strongest bank any slope can be, and it is never
//     stronger than that anywhere.
// ---------------------------------------------------------------------------
console.log('\n--- 1b. berm layer, driven directly ----------------------------------');
{
  const G2 = cfg.bermMax_mps2;
  const samples = [];
  let worstBank = 0, peakTopUp = 0, edgeMin = Infinity, edgeMax = 0, edgeN = 0;
  for (const off of [40, 60, 80, 100, 120, 128]) {
    const ph = createPhysics(physEnv, {});
    const tr = createTricks({});
    const run = createRun(env());
    const ts = tr.init(), rs = run.init();
    const dt = 1 / 60, z0 = 700;
    const x0 = centerX(z0) + off;
    const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 8], Math.PI / 2);
    let bermHere = 0, bankHere = 0, terrHere = 0, nFr = 0;
    for (let i = 0; i < 30; i++) {           // half a second: stay near `off`
      const inp = { tuck: true };
      ph.step(st, inp, dt); tr.step(ts, st, inp, dt); run.step(rs, st, ts, dt);
      if (st.onGround) {
        bermHere = Math.max(bermHere, rs.confine.peakBerm_mps2);
        bankHere = rs.confine.bankTotal_mps2;
        terrHere = rs.confine.terrainPull_mps2;
        nFr++;
      }
    }
    worstBank = Math.max(worstBank, bankHere);
    peakTopUp = Math.max(peakTopUp, bermHere);
    if (off >= cfg.wallStart_m && nFr) { edgeMin = Math.min(edgeMin, bankHere); edgeMax = Math.max(edgeMax, bankHere); edgeN++; }
    samples.push(`|s|=${off}: terrain ${terrHere.toFixed(2)} + berm ${bermHere.toFixed(2)} = ${bankHere.toFixed(2)}`);
  }
  for (const s of samples) note(''.padEnd(22), s);
  ok(peakTopUp > 0, 'the berm actually fires when the rider is on the shoulder',
    `peak top-up ${peakTopUp.toFixed(3)} m/s^2`);
  ok(peakTopUp <= cfg.measured.peakBermTopUp_mps2 + 1e-6,
    'and never exceeds the swept maximum published in config.measured',
    `${peakTopUp.toFixed(3)} <= ${cfg.measured.peakBermTopUp_mps2}`);
  ok(worstBank <= G2 + 1e-6, 'the corridor bank never exceeds g/2 anywhere',
    `${worstBank.toFixed(3)} <= ${G2}`);
  // tolerance 0.01: the rider drifts a little inward over the sampled half
  // second, so q dips just under 1 at the offsets seeded exactly on the edge
  ok(edgeN > 0 && Math.abs(edgeMin - G2) < 0.01 && Math.abs(edgeMax - G2) < 0.01,
    'at and beyond the corridor edge the bank is g/2',
    `${edgeN} offsets, [${edgeMin.toFixed(4)}, ${edgeMax.toFixed(4)}] vs ${G2}`);
}

// ---------------------------------------------------------------------------
// 2. YAW ON CORRIDOR-ACTIVE FRAMES — the frames RS-10 excludes.
//
//    RS-10 compares two whole runs, with and without run.step. That comparison
//    is only meaningful while the two runs are still the same trajectory, which
//    is exactly why the gate throws away out-of-bounds frames: once the corridor
//    fires, the unconfined rider leaves for terrain 800 m away and the heading
//    difference stops being attributable to anything.
//
//    So this measures the same quantity a different way — a per-frame
//    COUNTERFACTUAL. At every frame, the state is forked immediately before
//    run.step, and both the corrected and the uncorrected fork are advanced ONE
//    physics step with the SAME input. The difference in heading delta is the
//    yaw the corridor caused on that frame, from an identical starting state,
//    with no trajectory divergence anywhere in it.
// ---------------------------------------------------------------------------
console.log('\n--- 2. yaw the corridor causes, per frame, counterfactually -----------');
{
  const ph = createPhysics(physEnv, {});
  const tr = createTricks({});
  const run = createRun(env());
  const ts = tr.init(), rs = run.init();
  const dt = 1 / 60, D = 240, inputFn = adversarial(D);
  const z0 = 15, x0 = centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 6], Math.PI / 2);
  const cloneS = s => ({ ...s, pos: [...s.pos], vel: [...s.vel] });
  let worstAll = 0, worstActive = 0, activeN = 0, allN = 0, sumActive = 0;
  for (let i = 0; i < D * 60; i++) {
    const t = i * dt;
    const inp = inputFn(t, st) ?? {};
    ph.step(st, inp, dt);
    tr.step(ts, st, inp, dt);
    const forkU = cloneS(st);            // what physics alone would carry forward
    run.step(rs, st, ts, dt);            // corridor writes velocity here (or not)
    const forkC = cloneS(st);
    const inp2 = inputFn(t + dt, st) ?? {};
    const h0 = forkC.heading;
    ph.step(forkC, inp2, dt);
    ph.step(forkU, inp2, dt);
    const extra = (Math.abs(wrapA(forkC.heading - h0)) - Math.abs(wrapA(forkU.heading - h0)))
      * 180 / Math.PI / dt;
    allN++;
    if (extra > worstAll) worstAll = extra;
    if (rs.outOfBounds) { activeN++; sumActive += Math.max(0, extra); if (extra > worstActive) worstActive = extra; }
  }
  note('frames'.padEnd(22), `${allN} total, ${activeN} corridor-active (${(100 * activeN / allN).toFixed(1)}%)`);
  note('worst added yaw'.padEnd(22), `${worstAll.toFixed(2)} deg/s over ALL frames`);
  note('worst on active'.padEnd(22), `${worstActive.toFixed(2)} deg/s`);
  note('mean on active'.padEnd(22), `${activeN ? (sumActive / activeN).toFixed(3) : '0'} deg/s`);
  ok(worstAll <= 5, 'yaw the corridor causes stays inside RS-10\'s bar on EVERY frame',
    `${worstAll.toFixed(2)} <= 5 deg/s`);
}

// ---------------------------------------------------------------------------
// 3. THE RETURN BRANCH, at three step sizes.
//    Spawn the rider far outside with 40 m/s of outward velocity under full
//    boost — the case physics can produce with a landing redirect and the
//    harness never produces on its own.
// ---------------------------------------------------------------------------
console.log('\n--- 3. return branch under deliberate injection -----------------------');
for (const dt of [1 / 60, 1 / 30, 1 / 120]) {
  const z0 = 1200, out = 260, hz = (1 / dt).toFixed(0);
  const x0 = centerX(z0) + out;
  const seed = { z: z0, x: x0, v: [40, 0, 5], h: 0 };
  const inputFn = (t, st) => ({ tuck: true, boost: true,
    steer: seek(st, centerX(st.pos[2]) + 900, st.pos[2] + 40) });
  const r = drive({ duration: 40, dt, seed, inputFn });
  // baseline: the same drive with NO run module, so a frame in which PHYSICS
  // moves the rider a long way (its landing snap on steep ground) is not
  // charged to this module
  const base = drive({ duration: 40, dt, seed, inputFn, withRun: false, forceTravel: true });
  const sEnd = r.st.pos[0] - centerX(r.st.pos[2]);
  const maxS = Math.max(...r.trace.map(f => Math.abs(f.s)));
  ok(Math.abs(sEnd) < cfg.lateralSoftLine_m + 1e-6,
    `dt=${hz}Hz  rider returned inside the soft line`,
    `end |s| ${Math.abs(sEnd).toFixed(1)} < ${cfg.lateralSoftLine_m.toFixed(1)}`);
  ok(r.maxTravel <= Math.max(2, base.maxTravel + 1e-9),
    `dt=${hz}Hz  no frame moved further than physics moves it unaided`,
    `${r.maxTravel.toFixed(3)} m with module, ${base.maxTravel.toFixed(3)} m without`);
  ok(r.rs.confine.peakAppliedH_mps2 <= cfg.ceilAccelHorizontal_mps2 + 1e-9
    && r.rs.confine.peakApplied_mps2 <= cfg.ceilAccel3D_mps2 + 1e-9,
    `dt=${hz}Hz  both ceilings held`,
    `H ${r.rs.confine.peakAppliedH_mps2.toFixed(2)}/${cfg.ceilAccelHorizontal_mps2.toFixed(2)}, 3D ${r.rs.confine.peakApplied_mps2.toFixed(2)}/${cfg.ceilAccel3D_mps2.toFixed(2)}`);
  note(`dt=${hz}Hz reach`.padEnd(22),
    `max |s| ${maxS.toFixed(1)} m (started at ${out}), limitFrames ${r.rs.confine.limitFrames}, ceil3Frames ${r.rs.confine.ceil3Frames}`);
}

// A rider injected outward from INSIDE the corridor: the penetration past the
// soft line is what MARGIN is supposed to bound.
{
  const z0 = 900;
  const r = drive({ duration: 20, dt: 1 / 60,
    seed: { z: z0, x: centerX(z0) + 125, v: [0, 0, 20], h: Math.PI / 2 },
    inputFn: (t, st) => ({ tuck: true, boost: true, steer: seek(st, centerX(st.pos[2]) + 900, st.pos[2] + 40) }),
    inject: (t, st) => { if (t < 1 / 60 + 1e-9) { st.vel[0] += 33; } } });
  const maxS = Math.max(...r.trace.map(f => Math.abs(f.s)));
  const pen = maxS - cfg.lateralSoftLine_m;
  ok(maxS <= cfg.lateralBound_m, 'one-frame 33 m/s injection stays inside the containment bound',
    `max |s| ${maxS.toFixed(2)} m, penetration ${pen.toFixed(2)} m vs MARGIN ${cfg.margin_m.toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
// 4. THE START GATE — no harness run exercises it (the harness seeds past it).
// ---------------------------------------------------------------------------
console.log('\n--- 4. start gate, driven from upstream of zStart ---------------------');
{
  const z0 = -60;
  const r = drive({ duration: 8, dt: 1 / 60, seed: { z: z0, x: centerX(z0), v: [0, 0, 10], h: Math.PI / 2 },
    inputFn: () => ({ tuck: true, boost: true }) });
  const preGo = r.trace.filter(f => f.t < cfg.countdown_s);
  const maxZpre = Math.max(...preGo.map(f => f.z));
  // The gate is a boundary, not a pin: the rider can nose over the line by the
  // penetration the boundary law allows, which is bounded and reported here.
  ok(maxZpre <= 3, 'rider held at the start line while the light is red/set (RS-09 bar 3 m)',
    `max z before GO ${maxZpre.toFixed(3)} m`);
  ok(r.rs.confine.gateFrames > 0, 'gate actually engaged', `${r.rs.confine.gateFrames} frames`);
  ok(r.rs.phase === 'running', 'phase advances to running once the gate opens', r.rs.phase);
  const crossed = r.trace.find(f => f.z >= 0 && f.t >= cfg.countdown_s);
  ok(crossed && Math.abs(r.rs.time_s - (8 - crossed.t)) < 0.05,
    'clock starts AT THE LINE, not at the countdown',
    `${r.rs.time_s.toFixed(2)} s of clock, line crossed at t = ${crossed ? crossed.t.toFixed(2) : '?'} of 8`);
  ok(r.maxTravel <= 2, 'gate is soft: no frame moved the rider > 2 m', `${r.maxTravel.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// 5. THE LEDGER — physics says 'clean', the trick system voids the jump.
//    JA-15: an uber animation incomplete at touchdown is always a crash.
// ---------------------------------------------------------------------------
console.log('\n--- 5. landing ledger follows the trick system, not physics -----------');
{
  const ph = createPhysics(physEnv, {});
  const tr = createTricks({});
  const run = createRun(env());
  const ts = tr.init(), rs = run.init();
  const dt = 1 / 60, z0 = 400, x0 = centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 18], Math.PI / 2);
  // JA-15: fire an uber LATE in the air so its animation cannot finish before
  // touchdown. Physics knows nothing about uber animations and will label the
  // landing 'clean'; the trick system voids the jump. The ledger must follow
  // the trick system.
  let fired = false, physAtTouchdown = null, wasAir = false, crashedBefore = 0;
  for (let i = 0; i < 60 * 8; i++) {
    const t = i * dt;
    const inp = { tuck: true };
    if (st.onGround && t > 1 && t < 1.9) { inp.crouch = true; inp.tuck = false; }
    if (st.onGround && t >= 1.9 && t < 1.92) { inp.jumpRelease = true; inp.tuck = false; }
    if (!st.onGround && !fired && st.airTime > 0.9) { inp.uber = 6; fired = true; }
    const air = !st.onGround;
    ph.step(st, inp, dt);
    tr.step(ts, st, inp, dt);
    if (fired && air && st.onGround && physAtTouchdown === null) {
      physAtTouchdown = st.landing;
      crashedBefore = rs.crashed;
    }
    run.step(rs, st, ts, dt);
    wasAir = air;
  }
  ok(fired, 'the uber was started late enough that it could not finish');
  ok(physAtTouchdown !== null && physAtTouchdown !== 'crash',
    'physics labelled that touchdown non-crash', `physics said '${physAtTouchdown}'`);
  ok(rs.crashed > crashedBefore, 'ledger recorded it as a crash (the trick verdict)',
    `landed ${rs.landed}, crashed ${rs.crashed}`);
  ok(rs.verdictSplits >= 1, 'the disagreement is reported, not hidden', `verdictSplits ${rs.verdictSplits}`);
  const pending = (rs._ledger ? 1 : 0) + (st.onGround ? 0 : 1);
  ok(rs.landed + rs.crashed + pending === rs.jumps,
    'every touchdown is accounted for',
    `jumps ${rs.jumps} = landed ${rs.landed} + crashed ${rs.crashed} + ${pending} still open`);
  note('score after the bail'.padEnd(22), String(Math.round(ts.score)));
}

// ---------------------------------------------------------------------------
// 6. DETERMINISM + FREEZE
// ---------------------------------------------------------------------------
console.log('\n--- 6. determinism and freeze ----------------------------------------');
{
  const h = r => r.trace.slice(-50).map(f => `${f.x.toFixed(6)}|${f.z.toFixed(6)}`).join(',');
  const a = drive({ duration: 30, inputFn: play });
  const b = drive({ duration: 30, inputFn: play });
  ok(h(a) === h(b), 'identical inputs give an identical trajectory');
  const c = drive({ duration: 30, inputFn: play });
  c.run.restart(c.rs);
  ok(c.rs.time_s === 0 && c.rs.phase === 'ready' && c.rs.results === null && c.rs.landed === 0,
    'restart() rebuilds every field from init()');
  const d = drive({ duration: 240, inputFn: play });
  if (d.rs.phase === 'finished') {
    const j1 = JSON.stringify(d.run.results(d.rs, d.ts));
    for (let i = 0; i < 600; i++) d.run.step(d.rs, d.st, d.ts, 1 / 60);
    ok(j1 === JSON.stringify(d.run.results(d.rs, d.ts)), 'results frozen past the line');
    ok(Object.isFrozen(d.rs.results), 'card is deep-frozen');
    note('card'.padEnd(22), j1.slice(0, 150));
  } else ok(false, 'probe drive finished within 240 s', d.rs.phase);
}

console.log(`\n${checks - fails}/${checks} checks passed`);
process.exit(fails === 0 ? 0 : 1);
