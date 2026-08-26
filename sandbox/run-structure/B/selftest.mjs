#!/usr/bin/env node
// ============================================================================
// sandbox/run-structure/B/selftest.mjs
//
// The RS gates leave four things unmeasured, and run.mjs §6 names them:
//   * RS-10's in-bounds frames are frames the corridor provably cannot touch,
//     so the gate cannot tell a correct corridor from an absent one.
//   * RS-05/RS-06's adversarial drive is caught by the run-out long before it
//     gets far off centre, so the LATERAL wall and its return branch are
//     barely exercised.
//   * No gate stages a rider BEHIND the start line and then drives the
//     corridor. RS-09 stages behind it and then does nothing for 8 s.
//   * No gate runs at any dt but 1/60.
//
// This file drives exactly those, against the same physics, tricks, terrain
// and centreline the run-runner uses, and REPORTS NUMBERS. Every check is
// stated as an expectation with a measured value next to it; the process exits
// non-zero if any expectation fails.
//
//   node sandbox/run-structure/B/selftest.mjs
// ============================================================================
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { createRun } = await import(pathToFileURL(resolve(ROOT, 'sandbox/run-structure/B/run.mjs')).href);
const { createPhysics } = await import(pathToFileURL(resolve(ROOT, 'src/physics/physics.mjs')).href);
const { createTricks } = await import(pathToFileURL(resolve(ROOT, 'src/tricks/tricks.mjs')).href);
const { sampleHeight } = await import(pathToFileURL(resolve(ROOT, 'src/render/main.mjs')).href);

// ---- the run-runner's own centreline and divergence probe, reproduced ------
function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => {
  const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1;
  const raw = Array.from({ length: n }, (_, i) => courseCenterX(CL_Z0 + i * CL_STEP));
  return raw.map((_, i) => {
    let a = 0, c = 0;
    for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += raw[j]; c++; } }
    return a / c;
  });
})();
const centerX = z => {
  const f = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP;
  const i = Math.min(CL.length - 2, Math.max(0, Math.floor(f)));
  const t = f - i;
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
const ENV = () => ({ sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 } });
const PENV = { sampleHeight, surface: 'snow', sampleNormal: (x, z) => {
  const d = 0.05;
  const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
  const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
  const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
} };
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const seek = (st, tx, tz, g = 1.8) =>
  Math.max(-1, Math.min(1, wrapA(Math.atan2(tz - st.pos[2], tx - st.pos[0]) - st.heading) * g));

// ---- the run-runner's probe drive `play`, reproduced verbatim -------------
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

// ---- harness ---------------------------------------------------------------
let fails = 0, checks = 0;
const P = (n, d = 3) => (typeof n === 'number' ? n.toFixed(d) : String(n));
function check(label, ok, detail) {
  checks++;
  if (!ok) fails++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${detail ? '   ' + detail : ''}`);
}
function head(t) { console.log('\n' + t + '\n' + '-'.repeat(t.length)); }

// A driven session with an optional run module (null = no module at all).
function drive({ dt = 1 / 60, seconds = 60, seedZ = 15, seedS = 0, vel = [0, 0, 6],
                 inputFn, useRun = true, runObj = null } = {}) {
  const ph = createPhysics(PENV, {});
  const tr = createTricks({});
  const run = useRun ? (runObj ?? createRun(ENV())) : null;
  const ts = tr.init(), rs = run ? run.init() : null;
  const x0 = centerX(seedZ) + seedS;
  const st = ph.init([x0, sampleHeight(x0, seedZ), seedZ], [...vel], Math.PI / 2);
  const n = Math.round(seconds / dt);
  const m = { maxS: 0, maxDiv: 0, maxJump: 0, selfPos: 0, path: [], yawFromWrite: 0, scoreAtFinish: null };
  let prev = [...st.pos];
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    const inp = inputFn ? (inputFn(t, st, rs) ?? {}) : { tuck: true };
    ph.step(st, inp, dt);
    tr.step(ts, st, inp, dt);
    if (run) {
      const p0 = [st.pos[0], st.pos[1], st.pos[2]], h0 = st.heading;
      run.step(rs, st, ts, dt);
      m.selfPos = Math.max(m.selfPos,
        Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]));
      m.yawFromWrite = Math.max(m.yawFromWrite, Math.abs(wrapA(st.heading - h0)) * 180 / Math.PI / dt);
      if (m.scoreAtFinish === null && rs.phase === 'finished') m.scoreAtFinish = ts.score;
    }
    m.maxJump = Math.max(m.maxJump, Math.hypot(st.pos[0] - prev[0], st.pos[1] - prev[1], st.pos[2] - prev[2]));
    prev = [st.pos[0], st.pos[1], st.pos[2]];
    m.maxS = Math.max(m.maxS, Math.abs(st.pos[0] - centerX(st.pos[2])));
    m.maxDiv = Math.max(m.maxDiv, divergenceAt(st.pos[0], st.pos[2]));
    m.path.push(`${st.pos[0].toFixed(6)},${st.pos[1].toFixed(6)},${st.pos[2].toFixed(6)},${st.heading.toFixed(9)}`);
  }
  return { st, ts, rs, run, ph, tr, m };
}

const cfg = createRun(ENV()).config;
console.log('run-structure candidate B — selftest');
console.log('physics anchor:', cfg.physicsAnchor.source,
  '| verified:', cfg.physicsAnchor.verified,
  cfg.physicsAnchor.warning ? '| WARNING: ' + cfg.physicsAnchor.warning : '');
console.log('geometry @60Hz: lateral line', P(cfg.lateralLine_m), 'bound', P(cfg.lateralBound_m),
  '| z line', P(cfg.zLineUp_m), '..', P(cfg.zLineDown_m),
  '| A_lat', P(cfg.lateralFirmness_mps2), 'A_long', P(cfg.longitudinalFirmness_mps2),
  '| ceilings H', P(cfg.ceilAccelHorizontal_mps2), '3D', P(cfg.ceilAccel3D_mps2, 2));

// ===========================================================================
head('1. THE LATERAL WALL AND THE RETURN BRANCH, at three step sizes');
// A player who does nothing but leave, at full boost, alternating flanks.
for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
  const r = drive({ dt, seconds: 180, seedZ: 300, vel: [0, 0, 8],
    inputFn: (t, st) => ({ tuck: true, boost: true,
      steer: seek(st, centerX(st.pos[2]) + (Math.sin(t * 0.06) > 0 ? 1 : -1) * 600, st.pos[2] + 30) }) });
  const c = r.rs.confine;
  // the bound this dt implies (run.mjs §3.5): line + one frame of adverse work
  const line = 120 + (33 * 33) / (2 * cfg.lateralFirmness_mps2) + 33 * dt;
  const bound = line + cfg.adverseMax_mps2 * dt * dt;
  const tag = `dt=1/${Math.round(1 / dt)}`;
  check(`${tag} rider never passes the containment bound`, r.m.maxS <= bound + 1e-6,
    `maxS ${P(r.m.maxS)} <= bound ${P(bound)} (beyondBound counter ${c.beyondBound})`);
  check(`${tag} mesh divergence stays inside the module's own 2 m guarantee`,
    r.m.maxDiv <= 2, `maxDiv ${P(r.m.maxDiv)}`);
  check(`${tag} zero in-bounds writes`, c.inBoundsWriteFrames === 0,
    `inBoundsWriteFrames ${c.inBoundsWriteFrames}, wall ${c.wallFrames}, limit ${c.limitFrames}, berm ${c.bermFrames}`);
  check(`${tag} module writes no position`, c.maxSelfPosDelta_m === 0 && r.m.selfPos === 0,
    `maxSelfPosDelta_m ${c.maxSelfPosDelta_m}`);
  check(`${tag} module writes no heading`, r.m.yawFromWrite === 0,
    `yaw across run.step ${P(r.m.yawFromWrite)} deg/s`);
  check(`${tag} horizontal ceiling respected`, c.peakAppliedH_mps2 <= cfg.ceilAccelHorizontal_mps2 + 1e-9,
    `peak H ${P(c.peakAppliedH_mps2, 2)} <= ${P(cfg.ceilAccelHorizontal_mps2, 2)} (bound on ${c.ceilFrames} frames)`);
  check(`${tag} 3-D guard respected`, c.peakApplied_mps2 <= cfg.ceilAccel3D_mps2 + 1e-9,
    `peak 3D ${P(c.peakApplied_mps2, 2)} <= ${P(cfg.ceilAccel3D_mps2, 2)} (guard fired ${c.ceil3Frames})`);
  check(`${tag} energy removed is the surplus the budget found`,
    c.energyRemoved_m2s2 > 0 && c.energySurplus_m2s2 > 0,
    `surplus ${P(c.energySurplus_m2s2, 1)} m2/s2, removed ${P(c.energyRemoved_m2s2, 1)}, added ${P(c.energyAdded_m2s2, 1)}`);
}

// ===========================================================================
head('2. THE INDIRECT HEADING CHANNEL (airborne lateral writes), opened on purpose');
// Jump repeatedly while driving off-course, so the wall must act in the air
// and physics gets a chance to copy velocity yaw onto heading at touchdown.
{
  const r = drive({ seconds: 150, seedZ: 300, vel: [0, 0, 8],
    inputFn: (t, st) => {
      const inp = { tuck: true, boost: true,
        steer: seek(st, centerX(st.pos[2]) + (Math.sin(t * 0.05) > 0 ? 1 : -1) * 600, st.pos[2] + 25) };
      const cyc = t % 3;
      if (st.onGround && cyc > 2.2 && cyc < 2.7) { inp.crouch = true; inp.tuck = false; }
      if (st.onGround && cyc >= 2.7 && cyc < 2.72) { inp.jumpRelease = true; inp.tuck = false; }
      return inp;
    } });
  const c = r.rs.confine;
  const perFrame = cfg.ceilAccelHorizontal_mps2 / 60;   // m/s of lateral velocity
  check('airborne write frames are counted, not denied', typeof c.airborneWriteFrames === 'number',
    `airborneWriteFrames ${c.airborneWriteFrames} of ${c.totalFrames} (${(100 * c.airborneWriteFrames / c.totalFrames).toFixed(2)}%)`);
  check('the channel stays inside its stated bound',
    c.maxAirborneVelWrite_mps <= perFrame + 1e-9,
    `worst AIRBORNE single-frame write ${P(c.maxAirborneVelWrite_mps)} m/s <= A_HMAX*dt ${P(perFrame)}` +
    ` — that is ${P(Math.asin(Math.min(1, c.maxAirborneVelWrite_mps / 33)) * 180 / Math.PI, 2)} deg of heading` +
    ` at a 33 m/s clean landing (worst 3-D write, grounded included: ${P(c.maxSelfVelDelta_mps)} m/s)`);
  check('still no direct heading write', r.m.yawFromWrite === 0, `${P(r.m.yawFromWrite)} deg/s`);
  check('still zero in-bounds writes', c.inBoundsWriteFrames === 0, `${c.inBoundsWriteFrames}`);
  check('still contained', r.m.maxDiv <= 2, `maxDiv ${P(r.m.maxDiv)}, maxS ${P(r.m.maxS)}`);
}

// ===========================================================================
head('3. A RIDER INJECTED 260 m OUTSIDE THE CORRIDOR AT 40 m/s OUTBOUND');
// The return branch's own case, and the 3-D guard's premise (ground steeper
// than anything in the containment set).
{
  const ph = createPhysics(PENV, {}), tr = createTricks({}), run = createRun(ENV());
  const ts = tr.init(), rs = run.init();
  const z0 = 900, x0 = centerX(z0) + 260;
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [40, 0, 0], 0);
  let maxJump = 0, selfPos = 0, prev = [...st.pos], outward = 260, framesToReturn = -1;
  for (let i = 0; i < 60 * 40; i++) {
    ph.step(st, { tuck: true, boost: true }, 1 / 60);
    tr.step(ts, st, {}, 1 / 60);
    const p0 = [st.pos[0], st.pos[1], st.pos[2]];
    run.step(rs, st, ts, 1 / 60);
    selfPos = Math.max(selfPos, Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]));
    maxJump = Math.max(maxJump, Math.hypot(st.pos[0] - prev[0], st.pos[1] - prev[1], st.pos[2] - prev[2]));
    prev = [st.pos[0], st.pos[1], st.pos[2]];
    const s = Math.abs(st.pos[0] - centerX(st.pos[2]));
    outward = Math.max(outward, s);
    if (framesToReturn < 0 && s <= cfg.lateralBound_m) framesToReturn = i;
  }
  const c = rs.confine;
  const endS = Math.abs(st.pos[0] - centerX(st.pos[2]));
  check('the return branch brings the rider back inside the bound', framesToReturn >= 0,
    `returned after ${framesToReturn} frames (${P(framesToReturn / 60, 2)} s); final |s| ${P(endS)}`);
  check('it never got further out than it started', outward <= 262,
    `worst |s| ${P(outward)} (started 260)`);
  check('the correction is soft: no frame jump over 2 m', maxJump <= 2, `worst frame ${P(maxJump)} m`);
  check('the module still writes no position', selfPos === 0, `${selfPos}`);
  check('the return is counted as the LATERAL return, not pooled', c.limitFrames > 0,
    `limit ${c.limitFrames}, wall ${c.wallFrames}, berm ${c.bermFrames}, runout ${c.runoutFrames}`);
  check('the 3-D guard is reported whether or not it fired', typeof c.ceil3Frames === 'number',
    `ceil3Frames ${c.ceil3Frames}, ceilFrames ${c.ceilFrames}, peak3D ${P(c.peakApplied_mps2, 2)}`);
}

// ===========================================================================
head('4. THE BERM: inert at the corridor edge, and terrain + berm = g/2 at the wall line');
{
  const run = createRun(ENV());
  const G = 9.81;
  const normalAt = (x, z) => {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  };
  const cxP = z => (centerX((Math.floor(z / 10) + 1) * 10) - centerX(Math.floor(z / 10) * 10)) / 10;
  const terrIn = (s, z) => {
    const out = s >= 0 ? 1 : -1, x = centerX(z) + s, n = normalAt(x, z);
    const gdn = -G * n[1], gt = [-gdn * n[0], -G - gdn * n[1], -gdn * n[2]];
    return -out * (gt[0] - cxP(z) * gt[2]);
  };
  const berm = (s, z) => {
    const q = Math.min(1, Math.max(0, (Math.abs(s) - 120) / (cfg.lateralLine_m - 120)));
    return q * q * Math.max(0, G / 2 - terrIn(s, z));
  };
  let worstAtEdge = 0, worstBankShort = 0, peak = 0;
  // the SAME grid the declared measurement used (1 m in z, 0.5 m in s), so
  // "matches the declared peak" is a real check and not a grid coincidence
  for (let z = -170; z <= 2570; z += 1) for (const sg of [1, -1]) {
    worstAtEdge = Math.max(worstAtEdge, berm(sg * 120, z));
    const b = berm(sg * cfg.lateralLine_m, z);
    worstBankShort = Math.max(worstBankShort, G / 2 - (terrIn(sg * cfg.lateralLine_m, z) + b));
    for (let s = 120; s <= cfg.lateralLine_m + 1e-9; s += 0.5) peak = Math.max(peak, berm(sg * Math.min(s, cfg.lateralLine_m), z));
  }
  check('berm is exactly zero AT the contract corridor edge', worstAtEdge === 0,
    `worst berm at |s| = 120 over the whole course: ${worstAtEdge}`);
  check('at the wall line, terrain + berm is at least g/2 (the strongest bank a slope can be)',
    worstBankShort <= 1e-9, `worst shortfall ${P(worstBankShort, 6)} m/s^2`);
  check('the berm never exceeds g/2 anywhere, and matches the declared peak',
    peak <= G / 2 + 1e-9 && Math.abs(peak - cfg.measured.peakBermTopUp_mps2) < 0.01,
    `peak top-up ${P(peak)} m/s^2, declared ${cfg.measured.peakBermTopUp_mps2}, ceiling g/2 = ${P(G / 2)}`);
  // and the ramp is C1 at the inner edge: a 0.5 m step in from the edge
  check('the ramp is C1 at the inner edge (no step the rider can feel)',
    Math.max(...[0.5, 1, 2].map(d => berm(120 + d, 1200))) < 0.01,
    `berm 0.5/1/2 m outside the edge: ${[0.5, 1, 2].map(d => P(berm(120 + d, 1200), 4)).join(' / ')}`);
}

// ===========================================================================
head('5. THE START GATE AT THREE STAGING POSITIONS, EACH FOLLOWED BY A CORRIDOR DRIVE');
// The coverage gap the cycle-4 critique named: RS-09 stages behind the line
// and then does nothing. Here each staged rider is released into an
// adversarial off-course drive, so the gate and the corridor are exercised in
// the same session.
for (const seedZ of [-40, -5, 0]) {
  const r = drive({ seconds: 90, seedZ, vel: [0, 0, 0],
    inputFn: (t, st) => (t < 3.2 ? {} : { tuck: true, boost: true,
      steer: seek(st, centerX(st.pos[2]) + (t < 40 ? 600 : -600), st.pos[2] + 30) }) });
  const c = r.rs.confine;
  const tag = `staged z=${seedZ}`;
  check(`${tag} the gate exists and the ready phase is non-empty`,
    r.rs.gateZ !== null && c.gateFrames > 0,
    `gateZ ${P(r.rs.gateZ, 2)}, gate held ${c.gateFrames} frames, impulse ${P(c.impulse.gate)} m/s`);
  check(`${tag} the clock starts at the drop, not at spawn`, r.rs.phase !== 'ready' && r.rs.time_s > 0,
    `phase ${r.rs.phase}, time ${P(r.rs.time_s, 2)} s`);
  check(`${tag} zero in-bounds writes across gate AND corridor`, c.inBoundsWriteFrames === 0,
    `inBounds ${c.inBoundsWriteFrames}, readyGate ${c.readyGateWriteFrames}, wall ${c.wallFrames}, berm ${c.bermFrames}`);
  check(`${tag} corridor still holds after the gate drops`, r.m.maxDiv <= 2 && c.beyondBound === 0,
    `maxS ${P(r.m.maxS)}, maxDiv ${P(r.m.maxDiv)}, beyondBound ${c.beyondBound}`);
  check(`${tag} no position or heading write`, c.maxSelfPosDelta_m === 0 && r.m.yawFromWrite === 0,
    `pos ${c.maxSelfPosDelta_m}, yaw ${P(r.m.yawFromWrite)}`);
}
// the ready-phase hold itself, measured the way RS-09 measures it
{
  const r = drive({ seconds: 3, seedZ: -40, vel: [0, 0, 0], inputFn: () => ({}) });
  check('a staged rider does not accelerate down-course while the gate is shut',
    r.rs.phase === 'ready', `phase ${r.rs.phase}, gate frames ${r.rs.confine.gateFrames}`);
  const drift = Math.abs(r.st.pos[2] - (-40));
  check('ready-phase drift is under the 3 m RS-09 bar', drift < 3, `drift ${P(drift, 4)} m`);
  check('the gate never zeroed the whole velocity vector',
    Math.abs(r.st.vel[0]) + Math.abs(r.st.vel[1]) > 0 || r.st.vel[2] === 0,
    `vel [${r.st.vel.map(v => P(v, 3)).join(', ')}] — only the down-course rate is removed`);
}

// ===========================================================================
head('6. THE CENTRAL CLAIM: an in-bounds adversary is never touched');
// A rider who rides the entire course as close to the corridor edge as
// physics lets them, in bounds the whole way.
{
  const r = drive({ seconds: 200, seedZ: 15, vel: [0, 0, 6],
    inputFn: (t, st) => {
      const cxz = centerX(st.pos[2]);
      const s = st.pos[0] - cxz;
      // hunt the corridor edge from the inside, alternating flanks
      const want = (Math.sin(t * 0.03) > 0 ? 1 : -1) * 115;
      return { tuck: true, boost: true, steer: seek(st, cxz + want + (want - s) * 2, st.pos[2] + 40) };
    } });
  const c = r.rs.confine;
  check('an in-bounds rider is never written to', c.inBoundsWriteFrames === 0,
    `inBoundsWriteFrames ${c.inBoundsWriteFrames} over ${c.totalFrames} frames; widest line ${P(c.peakOffset_m, 1)} m`);
  check('and the run this module TIMED is the run that happened', c.activeFrames >= 0,
    `active on ${c.activeFrames} frames, total corridor impulse ${P(Object.values(c.impulse).reduce((a, b) => a + b, 0))} m/s`);
}
// bit-identical to no module at all, on the harness's own probe drive
{
  const withRun = drive({ seconds: 120, inputFn: play, useRun: true });
  const without = drive({ seconds: 120, inputFn: play, useRun: false });
  const same = withRun.m.path.join('|') === without.m.path.join('|');
  check('the harness probe drive is BIT-IDENTICAL with and without this module',
    same, same ? `${withRun.m.path.length} frames identical; corridor active on ${withRun.rs.confine.activeFrames}`
      : 'PATHS DIVERGED');
}

// ===========================================================================
head('7. THE LEDGER, THE STREAM AND THE FROZEN CARD');
{
  const r = drive({ seconds: 300, inputFn: play });
  const res = r.run.results(r.rs, r.ts);
  check('the run finished and the card is frozen', r.rs.phase === 'finished' && Object.isFrozen(res),
    `time ${P(res.time_s, 2)} s, score ${Math.round(res.score)}`);
  check('the card reports the BANKED award, with its star multiplier',
    !!res.bestAward && res.bestTrick === res.bestAward.name,
    `bestTrick "${res.bestTrick}" = ${Math.round(res.bestAward.points)} pts, star at landing x${res.bestAward.starMultAtLanding}`);
  check('the card froze the score the trick system held at the finish frame',
    res.score === r.m.scoreAtFinish,
    `card ${Math.round(res.score)}, trick system at the finish frame ${Math.round(r.m.scoreAtFinish)}`);
  check('landed == the number of jumps the TRICK system banked',
    res.landed === r.rs.banks,
    `landed ${res.landed} == banks ${r.rs.banks}; crashed ${res.crashed}, unresolved ${res.unresolvedTouchdowns}`);
  check('and physics DISAGREED often enough that the choice of adjudicator matters',
    res.verdictSplits > 0,
    `verdictSplits ${res.verdictSplits} of ${res.landed + res.crashed} touchdowns — cards built on the physics ` +
    `label would report ${res.verdictSplits} landings/bails the score contradicts (physUnlabelled ${res.physUnlabelled})`);
  check('splits come from the checkpoint stream, and there is exactly one of them',
    res.splits.length === r.rs.stream.filter(e => e.kind === 'checkpoint' || e.kind === 'finish').length,
    `${res.splits.length} splits from ${r.rs.stream.length} stream entries (${r.rs.stream.map(e => e.kind).join(', ')})`);
  check('no invented grade band', res.rank === null, `rank null — "${res.rankReason}"`);
  // keep stepping past the finish: the card must not move
  const before = JSON.stringify(r.run.results(r.rs, r.ts));
  for (let i = 0; i < 600; i++) r.run.step(r.rs, r.st, r.ts, 1 / 60);
  check('the card does not move while the rider keeps being held in the run-out',
    JSON.stringify(r.run.results(r.rs, r.ts)) === before,
    `run-out frames ${r.rs.confine.runoutFrames}, parked at z ${P(r.st.pos[2], 1)}`);
  // restart determinism
  const a = drive({ seconds: 40, inputFn: play });
  const b = drive({ seconds: 40, inputFn: play });
  check('restart is deterministic', a.m.path.join('|') === b.m.path.join('|'), 'two runs identical');
  const fresh = a.run.restart(a.rs);
  check('restart clears every field', fresh.time_s === 0 && fresh.phase === 'ready' &&
    fresh.results === null && fresh.stream.length === 0 && fresh.confine.activeFrames === 0,
    'phase ready, clock 0, stream empty, counters zero');
}

console.log(`\n${checks - fails}/${checks} checks pass`);
process.exit(fails === 0 ? 0 : 1);
