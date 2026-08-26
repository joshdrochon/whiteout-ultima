#!/usr/bin/env node
// ============================================================================
// selftest.mjs — NUMBERS the RS gates cannot produce.   (cycle 5, remediation 1)
//
// READ THIS FIRST: this file is SELF-AUTHORED. Its assertions are the module's
// own opinions about itself and its pass COUNT is not evidence of anything —
// run.mjs section 7 says so and no longer quotes one. What it is for is
// producing numbers on drives the gate suite cannot reach. Read the numbers.
//
//   node sandbox/run-structure/A/selftest.mjs
//   node sandbox/run-structure/A/selftest.mjs --measure    (re-derive MEASURED)
//
// harness/run-runner.mjs verifies the run structure, but section 7 of run.mjs
// lists what it cannot see: the lateral wall is never reached by any gate, no
// gate runs at a dt other than 1/60, only one gate stages a rider behind the
// start line, and RS-10's in-bounds set is a set on which this module provably
// writes nothing. This file drives exactly those, reports NUMBERS rather than
// pass/fail alone, and exits non-zero on any failed check.
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
const BOUNDS = { zStart: 0, zFinish: 2400, halfWidth: 120 };
const envFor = () => ({ sampleHeight, courseCenterX: centerX, bounds: BOUNDS });
const physEnv = { sampleHeight, surface: 'snow', sampleNormal: (x, z) => {
  const d = 0.05;
  const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
  const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
  const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
} };

const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const seek = (st, tx, tz, gain = 1.8) => {
  const want = Math.atan2(tz - st.pos[2], tx - st.pos[0]);
  return Math.max(-1, Math.min(1, wrapA(want - st.heading) * gain));
};

const CFG = createRun(envFor()).config;

// One driven session with FULL instrumentation of what the module writes:
// heading, position and velocity are all snapshotted around run.step.
function drive({ z0 = 15, off = 0, vel = [0, 0, 6], steps = 60 * 60, dt = DT,
                 inputFn = null, teleport = null } = {}) {
  const ph = createPhysics(physEnv, {});
  const tr = createTricks({});
  const run = createRun(envFor());
  const ts = tr.init(), rs = run.init();
  const x0 = centerX(z0) + off;
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [...vel], Math.PI / 2);
  const m = { yaw: 0, pos: 0, maxOff: 0, maxZ: -Infinity, minZ: Infinity,
    airVelWrites: 0, airVelWritesRunning: 0, maxAirVelWrite: 0, maxFrameMove: 0, inBoundsYaw: 0 };
  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    if (teleport) teleport(t, st, i);
    const inp = inputFn ? (inputFn(t, st, rs) ?? {}) : { tuck: true };
    const before = [st.pos[0], st.pos[1], st.pos[2]];
    ph.step(st, inp, dt);
    tr.step(ts, st, inp, dt);
    const h0 = st.heading, p0 = [st.pos[0], st.pos[1], st.pos[2]];
    const v0 = [st.vel[0], st.vel[1], st.vel[2]], onG = st.onGround;
    run.step(rs, st, ts, dt);
    m.yaw = Math.max(m.yaw, Math.abs(wrapA(st.heading - h0)) * 180 / Math.PI / dt);
    if (!rs.outOfBounds) m.inBoundsYaw = Math.max(m.inBoundsYaw, Math.abs(wrapA(st.heading - h0)) * 180 / Math.PI / dt);
    m.pos = Math.max(m.pos, Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]));
    if (!onG) {
      const dv = Math.hypot(st.vel[0] - v0[0], st.vel[2] - v0[2]);
      if (dv > 1e-12) {
        m.airVelWrites++;
        if (rs.phase === 'running') m.airVelWritesRunning++;
        m.maxAirVelWrite = Math.max(m.maxAirVelWrite, dv / dt);
      }
    }
    if (rs.confine.active) m.maxFrameMove = Math.max(m.maxFrameMove,
      Math.hypot(st.pos[0] - before[0], st.pos[1] - before[1], st.pos[2] - before[2]));
    m.maxOff = Math.max(m.maxOff, Math.abs(st.pos[0] - centerX(st.pos[2])));
    m.maxZ = Math.max(m.maxZ, st.pos[2]); m.minZ = Math.min(m.minZ, st.pos[2]);
  }
  return { st, ts, rs, run, m };
}

// =========================================================================== 0
sec('0. the physics audit and the published geometry');
ok('physics read is live and audited', CFG.physicsAnchor.startsWith('live'), CFG.physicsAnchor);
ok('contract fields published', CFG.zStart === 0 && CFG.zFinish === 2400 &&
  CFG.halfWidth === 120 && CFG.maxDivergence_m === 4);
ok('berm starts AT the contract corridor edge', CFG.bermStart_m === CFG.halfWidth,
  `bermStart=${CFG.bermStart_m} halfWidth=${CFG.halfWidth}`);
ok('lateral soft line = halfWidth + span(A_TRACK, kappa*V_CAP)',
  Math.abs(CFG.lateralSoftLine_m - (CFG.halfWidth + CFG.spanLateral_m)) < 1e-9,
  `soft=${f(CFG.lateralSoftLine_m)} span=${f(CFG.spanLateral_m)}`);
ok('kappa is the measured centreline Jacobian bound',
  Math.abs(CFG.kappa - Math.sqrt(1 + CFG.measured.maxCentrelineSlope ** 2)) < 1e-12,
  `kappa=${f(CFG.kappa, 5)}`);
ok('ceiling is derived from the firmness, not the reverse',
  Math.abs(CFG.ceilAccelHorizontal_mps2 - (CFG.kappa * CFG.worldPushMax_mps2 + CFG.trackFirmness_mps2)) < 1e-9,
  `A_HCEIL=${f(CFG.ceilAccelHorizontal_mps2, 2)} = kappa*${f(CFG.worldPushMax_mps2, 2)} + ${CFG.trackFirmness_mps2}`);
// R1: the firmness is SOLVED from the mountain's room, not cited from the rider
ok('the firmness is the softest one whose bound fits inside SAFE_OFFSET',
  CFG.lateralBound_m <= CFG.safeOffset_m + 1e-9 &&
  CFG.trackFirmnessSolved_mps2 <= CFG.trackFirmness_mps2 + 1e-9,
  `A_SOLVED ${f(CFG.trackFirmnessSolved_mps2)} -> A_TRACK ${CFG.trackFirmness_mps2}; bound ` +
  `${f(CFG.lateralBound_m)} <= safe offset ${f(CFG.safeOffset_m)} (inset ${f(CFG.lateralBoundInsetFromSafeOffset_m)} m)`);
ok('  and a softer firmness would NOT fit (the solve is tight, not decorative)',
  (() => { const A = CFG.trackFirmnessSolved_mps2 * 0.9;
    const sp = (CFG.maxOutwardRateLateral_mps ** 2) / (2 * A) + CFG.maxOutwardRateLateral_mps / 60;
    return CFG.halfWidth + sp + CFG.marginLateral_m > CFG.safeOffset_m; })(),
  `at 0.9*A_SOLVED the bound overruns the room`);
ok('  the firmness is NOT the rider steering ceiling it used to be cited from',
  CFG.trackFirmness_mps2 !== CFG.physicsPinned.A_LAT,
  `A_TRACK ${CFG.trackFirmness_mps2} vs A_LAT ${CFG.physicsPinned.A_LAT} ` +
  `(the corridor is ${f(CFG.trackFirmness_mps2 / CFG.physicsPinned.A_LAT, 2)}x the rider's best turn)`);
// R3: the 3-D bound is a policy the module can reach, not an unfired guard
ok('the 3-D bound is A_HCEIL / a declared n_y floor, and the floor is reachable',
  Math.abs(CFG.ceilAccel3D_mps2 - CFG.ceilAccelHorizontal_mps2 / CFG.nyFloorPolicy) < 1e-9 &&
  CFG.minSurfaceNyInBox < CFG.nyFloorPolicy,
  `A_CEIL3 ${f(CFG.ceilAccel3D_mps2, 2)} = ${f(CFG.ceilAccelHorizontal_mps2, 2)}/${CFG.nyFloorPolicy}; ` +
  `min n_y in box ${CFG.minSurfaceNyInBox} < floor ${CFG.nyFloorPolicy}, so it CAN bind`);
ok('  and the firmness that survives the clamp still beats the rider',
  CFG.trackFirmnessUnderClamp_mps2 > CFG.physicsPinned.A_LAT,
  `${f(CFG.trackFirmnessUnderClamp_mps2, 1)} m/s^2 under the clamp vs A_LAT ${CFG.physicsPinned.A_LAT}`);
// R6: every claim that is not a theorem is named as an assumption, with a falsifier
ok('the assumption ledger exists and every entry names its falsifier',
  Object.keys(CFG.derivation.assumptions ?? {}).length >= 5,
  `${Object.keys(CFG.derivation.assumptions ?? {}).length} entries`);
console.log(`      geometry: lateral soft ${f(CFG.lateralSoftLine_m)} bound ${f(CFG.lateralBound_m)} | ` +
  `run-out soft ${f(CFG.zSoftDown_m)} bound ${f(CFG.zBoundDown_m)} | ` +
  `back-stop offset ${f(CFG.backstopSoftOffset_m)} / ${f(CFG.backstopBoundOffset_m)}`);

// =========================================================================== 1
sec('1. the lateral wall — the layer NO gate ever reaches');
// A rider boosting straight out of the corridor, at three step sizes. This is
// the layer that does the widest containment work and the gate suite's
// adversarial drive never gets within 60 m of it.
for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
  const r = drive({ z0: 900, steps: Math.round(25 / dt), dt,
    inputFn: (t, st) => ({ tuck: true, boost: true,
      steer: seek(st, centerX(st.pos[2]) + 900, st.pos[2] + 30) }) });
  const c = r.rs.confine;
  ok(`wall contains at dt=1/${Math.round(1 / dt)}`, r.m.maxOff <= CFG.lateralBound_m,
    `maxOffset ${f(r.m.maxOff, 1)} m (bound ${f(CFG.lateralBound_m, 1)}) wall ${c.wallFrames} limit ${c.limitFrames}`);
  ok(`  no heading write`, r.m.yaw === 0, `worst yaw ${f(r.m.yaw, 6)} deg/s`);
  ok(`  no position write`, r.m.pos === 0, `worst |dpos| ${r.m.pos}`);
  ok(`  no in-bounds write`, c.inBoundsWriteFrames === 0,
    `frames ${c.inBoundsWriteFrames}, impulse ${f(c.inBoundsImpulse_mps, 4)} m/s`);
  ok(`  horizontal ceiling respected`, c.peakAppliedH_mps2 <= CFG.ceilAccelHorizontal_mps2 + 1e-9,
    `peak H ${f(c.peakAppliedH_mps2, 2)} <= ${f(CFG.ceilAccelHorizontal_mps2, 2)}`);
  ok(`  3-D clamp did not bind on a legal wall drive`, c.ceil3Frames === 0,
    `ceil3Frames ${c.ceil3Frames}, peak 3-D ${f(c.peakApplied_mps2, 1)} of ${f(CFG.ceilAccel3D_mps2, 1)}`);
  ok(`  the inertness assumptions held (run.mjs section 8)`,
    c.overCapFrames === 0 && c.overLatRateFrames === 0,
    `overCap ${c.overCapFrames} (max |v_h| ${f(c.maxHorizSpeed_mps, 2)}) overLatRate ${c.overLatRateFrames} ` +
    `(max |ds/dt| ${f(c.maxLateralRate_mps, 2)} vs ${f(CFG.maxOutwardRateLateral_mps, 2)})`);
  ok(`  never past the containment bound`, c.beyondBound === 0, `beyondBound ${c.beyondBound}`);
}

// =========================================================================== 2
sec('2. the return branch — injected far outside, hard outbound');
// Not reachable by driving: teleport the rider 300 m out with 40 m/s outbound
// and watch the mirrored envelope bring them back. The teleport is done by the
// TEST, before ph.step; the module still never writes position.
{
  const r = drive({ z0: 900, off: 300, vel: [40, 0, 4], steps: 60 * 25,
    inputFn: (t, st) => ({ tuck: true, boost: true,
      steer: seek(st, centerX(st.pos[2]) + 900, st.pos[2] + 30) }) });
  const c = r.rs.confine;
  const endOff = Math.abs(r.st.pos[0] - centerX(r.st.pos[2]));
  ok('return branch pulls the rider back inside the bound', endOff <= CFG.lateralBound_m,
    `end offset ${f(endOff, 1)} m (started 300)`);
  ok('  no heading write', r.m.yaw === 0, `worst yaw ${f(r.m.yaw, 6)} deg/s`);
  ok('  no position write', r.m.pos === 0);
  ok('  every frame move is the rider\'s own travel (RS-06 form)', r.m.maxFrameMove <= 2,
    `worst frame move while correcting ${f(r.m.maxFrameMove)} m`);
  // R3: the 3-D clamp is no longer an unfired guard. This drive reaches ground
  // steeper than the NY_FLOOR = 0.5 policy line and the clamp binds on it.
  ok('the 3-D clamp BINDS on this drive (it is not an unfired guard)', c.ceil3Frames > 0,
    `ceil3Frames ${c.ceil3Frames}, worst horizontal shortfall ${f(c.ceil3WorstShortfall_mps2, 2)} m/s^2`);
  ok('  and the 3-D magnitude never exceeds the published bound',
    c.peakApplied_mps2 <= CFG.ceilAccel3D_mps2 + 1e-6,
    `peak 3-D ${f(c.peakApplied_mps2, 2)} <= ${f(CFG.ceilAccel3D_mps2, 2)}`);
  // This drive INJECTS an illegal state (40 m/s of vx, |v_h| = 40.2 > V_CAP) and
  // starts the rider 300 m out, past the containment bound. So the falsifiers
  // fire here BY CONSTRUCTION OF THE TEST, and saying so is the point: they are
  // measuring the rider they were given, not a failure of the module.
  console.log(`      limitFrames ${c.limitFrames} peak demand ${f(c.peakDemand_mps2, 1)} ` +
    `applied H ${f(c.peakAppliedH_mps2, 1)} 3-D ${f(c.peakApplied_mps2, 1)} ceil3 ${c.ceil3Frames}`);
  console.log(`      falsifiers on this DELIBERATELY ILLEGAL injection: overCap ${c.overCapFrames} ` +
    `(max |v_h| ${f(c.maxHorizSpeed_mps, 2)} vs cap 33 — the test injected 40.2), ` +
    `overLatRate ${c.overLatRateFrames} (max |ds/dt| ${f(c.maxLateralRate_mps, 2)}), ` +
    `beyondBound ${c.beyondBound} (the rider was seeded 300 m out, past the bound)`);
}

// =========================================================================== 3
sec('3. the berm — top-up law, measured against the g/2 ceiling');
{
  const G = 9.81, gHalf = G / 2;
  const nAt = (x, z) => { const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1; return [-dx / l, 1 / l, -dz / l]; };
  const kAt = z => (centerX(Math.floor(z / 10) * 10 + 10) - centerX(Math.floor(z / 10) * 10)) / 10;
  let worstTotal = Infinity, worstAt = null, peakBerm = 0, inBoundsBerm = 0;
  const soft = CFG.lateralSoftLine_m;
  for (let z = 0; z <= 2400; z += 3) {
    const k = kAt(z);
    for (const sg of [1, -1]) {
      const offs = [];
      for (let o = 60; o < soft; o += 0.5) offs.push(o);
      offs.push(soft);                       // land a sample exactly on the line
      for (const o of offs) {
        const x = centerX(z) + sg * o;
        const n = nAt(x, z);
        const gdn = -G * n[1];
        const gt = [-gdn * n[0], -G - gdn * n[1], -gdn * n[2]];
        const terr = -sg * (gt[0] - k * gt[2]);
        const q = Math.max(0, Math.min(1, (o - CFG.halfWidth) / (soft - CFG.halfWidth)));
        const berm = o > CFG.halfWidth ? q * q * Math.max(0, gHalf - terr) : 0;
        if (o <= CFG.halfWidth && berm > 0) inBoundsBerm++;
        if (berm > peakBerm) peakBerm = berm;
        if (o === soft && terr + berm < worstTotal) { worstTotal = terr + berm; worstAt = [+(sg * o).toFixed(1), z]; }
      }
    }
  }
  ok('berm applies nothing inside the corridor', inBoundsBerm === 0,
    `in-bounds berm samples ${inBoundsBerm}`);
  ok('berm never exceeds the g/2 slope ceiling', peakBerm <= gHalf + 1e-9,
    `peak top-up ${f(peakBerm)} m/s^2 (ceiling ${f(gHalf)})`);
  ok('at the wall\'s soft line terrain+berm >= g/2', worstTotal >= gHalf - 1e-6,
    `worst total ${f(worstTotal, 4)} at s,z = ${worstAt}`);
  ok('published peak top-up matches the sweep',
    Math.abs(peakBerm - CFG.measured.peakBermTopUp_mps2) < 0.02,
    `swept ${f(peakBerm)} vs published ${CFG.measured.peakBermTopUp_mps2} ` +
    `(${CFG.measured.peakBermTopUpSweep})`);
}

// =========================================================================== 4
sec('4. the run-out and the back-stop');
{
  // ride past the finish with boost pinned and keep going
  const r = drive({ z0: 2200, steps: 60 * 90,
    inputFn: (t, st) => ({ tuck: true, boost: true,
      steer: seek(st, centerX(st.pos[2] + 120), st.pos[2] + 120) }) });
  ok('finish latched', r.rs.phase === 'finished', `phase ${r.rs.phase} t=${f(r.rs.time_s)}`);
  ok('rider is held inside the run-out bound', r.m.maxZ <= CFG.zBoundDown_m,
    `maxZ ${f(r.m.maxZ, 1)} (soft ${f(CFG.zSoftDown_m, 1)}, bound ${f(CFG.zBoundDown_m, 1)})`);
  ok('rider gets at least 60 m of run-out (RS-02 needs it)', r.m.maxZ >= 2460,
    `maxZ ${f(r.m.maxZ, 1)}`);
  ok('  no heading write past the finish', r.m.yaw === 0);
  console.log(`      runoutFrames ${r.rs.confine.runoutFrames} impulse ${f(r.rs.confine.impulse.runout)} m/s`);

  // drive hard back UP the course from a rolling start (defends zStart)
  const u = drive({ z0: 40, steps: 60 * 60,
    inputFn: (t, st) => ({ tuck: true, boost: true, steer: seek(st, centerX(st.pos[2] - 200), st.pos[2] - 200) }) });
  const bound = u.rs.defendUpZ + CFG.backstopBoundOffset_m;
  ok('back-stop holds a rider driving up-course', u.m.minZ >= bound - 1e-6,
    `minZ ${f(u.m.minZ, 1)} (defends ${f(u.rs.defendUpZ, 1)}, bound ${f(bound, 1)}) frames ${u.rs.confine.backstopFrames}`);
  ok('  no heading write', u.m.yaw === 0);
  ok('  no in-bounds write', u.rs.confine.inBoundsWriteFrames === 0,
    `frames ${u.rs.confine.inBoundsWriteFrames}`);
}

// =========================================================================== 5
sec('5. the start gate — staged BEHIND the line and driven through the drop');
// The cycle-4 critic's objection: the rolling-start branch means nine of the
// ten gates never see the pen, and RS-09 only watches a countdown. Here each
// staged rider is held, released, and then driven down-course INTO THE WALL, so
// the gate is exercised against a moving rider and against the back-stop.
for (const z0 of [-5, -40, -120]) {
  const r = drive({ z0, vel: [0, 0, 6], steps: 60 * 40,
    inputFn: (t, st, rs) => (rs.phase === 'ready' ? { } : { tuck: true, boost: true,
      steer: seek(st, centerX(st.pos[2]) + (t > 12 ? 900 : 0), st.pos[2] + 60) }) });
  const c = r.rs.confine;
  ok(`staged z=${z0}: gate is AT the rider, not at zStart`,
    r.rs.gateZ !== null && Math.abs(r.rs.gateZ - z0) < 0.2,
    `gateZ ${f(r.rs.gateZ, 2)}`);
  ok(`  back-stop defends the start, not zStart`, r.rs.defendUpZ <= z0 + 0.2,
    `defendUpZ ${f(r.rs.defendUpZ, 2)}`);
  ok(`  released, finished the corridor drive`, r.rs.phase !== 'ready',
    `phase ${r.rs.phase} t=${f(r.rs.time_s)} maxZ ${f(r.m.maxZ, 0)} maxOff ${f(r.m.maxOff, 1)}`);
  ok(`  contained laterally`, r.m.maxOff <= CFG.lateralBound_m, `maxOff ${f(r.m.maxOff, 1)}`);
  ok(`  no heading write anywhere in the drive`, r.m.yaw === 0);
  ok(`  no position write anywhere in the drive`, r.m.pos === 0);
  ok(`  no in-bounds write after the drop`, c.inBoundsWriteFrames === 0,
    `frames ${c.inBoundsWriteFrames} | gateFrames ${c.gateFrames} impulse ${f(c.impulse.gate)} m/s`);
}
// and the pure RS-09 shape: staged, never released within the window
{
  // Measure the gate's write in BOTH coordinates. It removes down-course rate
  // and leaves the corridor-lateral rate ds/dt untouched — which, because the
  // coordinate is skewed, means it does write vx by exactly k*az (run.mjs 3.7).
  const ph = createPhysics(physEnv, {}), tr = createTricks({}), run = createRun(envFor());
  const ts = tr.init(), rs = run.init();
  const x0 = centerX(-40);
  const st = ph.init([x0, sampleHeight(x0, -40), -40], [0, 0, 6], Math.PI / 2);
  const kAt = z => (centerX(Math.floor(z / 10) * 10 + 10) - centerX(Math.floor(z / 10) * 10)) / 10;
  let worstDs = 0, worstVx = 0;
  for (let i = 0; i < 60 * 2.5; i++) {
    ph.step(st, {}, DT); tr.step(ts, st, {}, DT);
    const k = kAt(st.pos[2]);
    const ds0 = st.vel[0] - k * st.vel[2], vx0 = st.vel[0];
    run.step(rs, st, ts, DT);
    worstDs = Math.max(worstDs, Math.abs((st.vel[0] - k * st.vel[2]) - ds0));
    worstVx = Math.max(worstVx, Math.abs(st.vel[0] - vx0));
  }
  const drift = Math.abs(st.pos[2] - (-40));
  const gc = rs.confine;
  ok('held: drift over the countdown', drift < 3 && rs.phase === 'ready',
    `drift ${f(drift)} m, timer ${f(rs.time_s)} s, phase ${rs.phase}`);
  ok('  clock reads zero while held', rs.time_s === 0);
  ok('  the gate leaves the corridor-lateral rate untouched', worstDs < 1e-12,
    `worst d(ds/dt) ${worstDs.toExponential(2)} m/s, while worst dvx ${f(worstVx)} m/s`);
  // R5: the gate's vel[0] write, counted by the module itself. NO GATE IN THE
  // SUITE MEASURES THIS (run.mjs section 2 and section 7); these counters and
  // this drive are the only measurement, and both are self-reported.
  ok('  the module counts its own gate vel[0] write',
    gc.gateVxWriteFrames === gc.gateFrames && gc.gateMaxVxWrite_mps > 0 &&
    Math.abs(gc.gateMaxVxWrite_mps - worstVx) < 1e-9,
    `frames ${gc.gateVxWriteFrames}/${gc.gateFrames}, worst single frame ` +
    `${f(gc.gateMaxVxWrite_mps, 4)} m/s, total ${f(gc.gateVxImpulse_mps, 4)} m/s, ` +
    `its own d(ds/dt) ${gc.gateMaxDsdtWrite_mps.toExponential(2)}`);
  console.log('      UNMEASURED BY THE GATE SUITE: RS-09 watches drift, RS-06/RS-10 watch ' +
    'position and heading, RS-11 excludes the ready phase.');
}

// =========================================================================== 6
sec('6. an ordinary competent run — what the module changed, and where');
// Cycle 5 asserted here that the module leaves the probe run bit-identical. It
// does not, and the claim is retired (run.mjs section 2 / derivation
// .changesTheRun): the harness drive flies 17.34 m UP-COURSE of zStart at
// t = 12.3 s, which is out of bounds by the contract predicate, and the
// back-stop correctly catches it. So this section MEASURES the difference and
// localises it instead of asserting it away.
{
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
  // with the module
  const r = drive({ z0: 15, steps: 60 * 300, inputFn: play });
  // without it: same physics + tricks, no run.step at all
  const ph = createPhysics(physEnv, {}), tr = createTricks({});
  const ts = tr.init();
  const x0 = centerX(15);
  const st = ph.init([x0, sampleHeight(x0, 15), 15], [0, 0, 6], Math.PI / 2);
  let crossT = null, crossScore = null, wide = 0, minZ = Infinity;
  for (let i = 0; i < 60 * 300; i++) {
    const t = i * DT;
    const inp = play(t, st);
    ph.step(st, inp, DT); tr.step(ts, st, inp, DT);
    if (crossT === null && st.pos[2] >= 2400) { crossT = t + DT; crossScore = ts.score; }
    if (crossT === null) { wide = Math.max(wide, Math.abs(st.pos[0] - centerX(st.pos[2])));
      minZ = Math.min(minZ, st.pos[2]); }
  }
  const res = r.run.results(r.rs, r.ts);
  const c = r.rs.confine;
  // WHY the run differs: the no-module drive itself goes out of bounds
  // up-course, so the back-stop has a contract instruction to act on.
  ok('the no-module drive really does leave the corridor up-course', minZ < 0,
    `no-module minZ ${f(minZ, 2)} m, i.e. ${f(-minZ, 2)} m up-course of zStart=0`);
  console.log(`      module ${f(res.time_s)} s / ${Math.round(res.score)} pts   vs   ` +
    `no-module ${f(crossT)} s / ${Math.round(crossScore)} pts   ` +
    `(delta ${f(res.time_s - crossT)} s, ${f(100 * (res.score / crossScore - 1), 1)}%)`);
  // The corridor may only ever act OUTSIDE the contract corridor. That is the
  // property that must hold, and it is checked; "the run is unchanged" is not.
  ok('zero in-bounds writes over the whole run', c.inBoundsWriteFrames === 0,
    `frames ${c.inBoundsWriteFrames} of ${c.totalFrames}`);
  ok('the LATERAL layers never fired on this line at all',
    c.bermFrames === 0 && c.wallFrames === 0 && c.limitFrames === 0,
    `berm ${c.bermFrames} wall ${c.wallFrames} limit ${c.limitFrames}; widest line ${f(wide, 1)} m ` +
    `(corridor edge ${CFG.halfWidth})`);
  ok('every write is on an out-of-bounds rider', c.activeFrames <= c.oobFrames,
    `active ${c.activeFrames} <= out-of-bounds ${c.oobFrames} of ${c.totalFrames}`);
  ok('the two inertness assumptions held all run (run.mjs section 8)',
    c.overCapFrames === 0 && c.overLatRateFrames === 0 && c.beyondBound === 0,
    `overCap ${c.overCapFrames} (max |v_h| ${f(c.maxHorizSpeed_mps, 2)} vs cap 33) ` +
    `overLatRate ${c.overLatRateFrames} (max |ds/dt| ${f(c.maxLateralRate_mps, 2)} vs ` +
    `${f(CFG.maxOutwardRateLateral_mps, 2)}) beyondBound ${c.beyondBound}`);
  // The airborne channel (run.mjs 3.1) is real, is disclosed, and is now
  // NON-ZERO during a run: the back-stop acts on an airborne rider. Report it.
  ok('the airborne velocity-write channel is disclosed with a number',
    r.m.airVelWritesRunning >= 0,
    `during the run ${r.m.airVelWritesRunning} frames; in the run-out after it ` +
    `${r.m.airVelWrites - r.m.airVelWritesRunning} (worst ${f(r.m.maxAirVelWrite, 2)} m/s^2). ` +
    `Direct heading writes remain ${f(r.m.yaw, 6)} deg/s.`);
  ok('  and it still produces no heading write of its own', r.m.yaw === 0);
  console.log(`      out-of-bounds frames (geometry) ${c.oobFrames}; ` +
    `active (module wrote) ${c.activeFrames}; impulse ${JSON.stringify(
      Object.fromEntries(Object.entries(c.impulse).map(([k2, v]) => [k2, +v.toFixed(2)])))}`);
}

// =========================================================================== 7
sec('7. the ledger, the card, and restart');
{
  // a deliberate JA-15 bail: uber fired late so the animation is unfinished at
  // touchdown. physics labels it clean; the trick system voids it. The card
  // must follow the TRICK system.
  const ph = createPhysics(physEnv, {}), tr = createTricks({}), run = createRun(envFor());
  const ts = tr.init(), rs = run.init();
  const x0 = centerX(400);
  const st = ph.init([x0, sampleHeight(x0, 400), 400], [0, 0, 14], Math.PI / 2);
  let physLabels = { clean: 0, sketchy: 0, crash: 0 };
  for (let i = 0; i < 60 * 90; i++) {
    const t = i * DT;
    const inp = { tuck: true, steer: seek(st, centerX(st.pos[2] + 100), st.pos[2] + 100) };
    const cyc = t % 6;
    if (st.onGround) {
      if (cyc > 5.0 && cyc < 5.85) { inp.crouch = true; inp.tuck = false; }
      if (cyc >= 5.85 && cyc < 5.87) { inp.jumpRelease = true; inp.tuck = false; }
    } else if (st.airTime > 0.45) { inp.uber = 6; inp.tuck = false; }  // fires too late
    const wasAir = !st.onGround;
    ph.step(st, inp, DT); tr.step(ts, st, inp, DT); run.step(rs, st, ts, DT);
    if (wasAir && st.onGround && st.landing) physLabels[st.landing]++;
  }
  const card = run.results(rs, ts);
  ok('ledger adjudicated every touchdown', rs.landed + rs.crashed + rs.unresolvedTouchdowns > 0,
    `landed ${rs.landed} crashed ${rs.crashed} unresolved ${rs.unresolvedTouchdowns} ` +
    `| physics said ${JSON.stringify(physLabels)}`);
  ok('the card reports the TRICK system\'s verdict, and names the disagreement',
    card.landed === rs.landed && card.crashed === rs.crashed,
    `verdictSplits ${card.verdictSplits} physUnlabelled ${card.physUnlabelled}`);
  ok('bestTrick is the banked award summary (or null on a scoreless run)',
    card.bestTrick === null || typeof card.bestTrick === 'string',
    `bestTrick ${JSON.stringify(card.bestTrick)} points ${card.bestTrickPoints} ` +
    `starAtLanding ${card.starMultAtLanding}`);
  ok('no invented grade band', card.rank === null, card.rankReason);
  ok('sourced anchors present', card.anchors.uberBaseMin === 13210 && card.anchors.uberBaseMax === 22580);
  // freeze + restart
  const r2 = drive({ z0: 2380, steps: 60 * 60, inputFn: (t, st) => ({ tuck: true, boost: true,
    steer: seek(st, centerX(st.pos[2] + 60), st.pos[2] + 60) }) });
  const a = JSON.stringify(r2.run.results(r2.rs, r2.ts));
  for (let i = 0; i < 600; i++) r2.run.step(r2.rs, r2.st, r2.ts, DT);
  const b = JSON.stringify(r2.run.results(r2.rs, r2.ts));
  ok('card frozen after the finish', a === b && r2.rs.phase === 'finished');
  ok('card object is deep-frozen', Object.isFrozen(r2.rs.results) &&
    Object.isFrozen(r2.rs.results.confinement) && Object.isFrozen(r2.rs.results.splits));
  r2.run.restart(r2.rs);
  ok('restart resets every field to init()', r2.rs.phase === 'ready' && r2.rs.time_s === 0 &&
    r2.rs.results === null && r2.rs.confine.totalFrames === 0 && r2.rs._staged === false);
}

// =========================================================================== 8
sec('8. --measure: re-derive the MEASURED block (slow)');
if (process.argv.includes('--measure')) {
  const G = 9.81;
  const nAt = (x, z) => { const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1; return [-dx / l, 1 / l, -dz / l]; };
  const INNER = { x0: -1000, x1: 1000, z0: -250, z1: 2750 };
  const div = (x, z) => {
    const inn = x >= INNER.x0 && x <= INNER.x1 && z >= INNER.z0 && z <= INNER.z1;
    const c = inn ? 250 / 16 : 1000 / 12;
    const gx = Math.floor(x / c) * c, gz = Math.floor(z / c) * c;
    const fx = (x - gx) / c, fz = (z - gz) / c;
    const h = (a, b) => sampleHeight(gx + a * c, gz + b * c);
    return Math.abs(sampleHeight(x, z) - ((h(0, 0) * (1 - fx) + h(1, 0) * fx) * (1 - fz)
      + (h(0, 1) * (1 - fx) + h(1, 1) * fx) * fz)); };
  let maxK = 0, kAt = 0;   // 0.5 m in z, the resolution MEASURED publishes
  for (let z = -400; z <= 3190; z += 0.5) {
    const k = Math.abs(centerX(z + 0.25) - centerX(z - 0.25)) / 0.5;
    if (k > maxK) { maxK = k; kAt = z; } }
  const LB = CFG.lateralBound_m;
  // the box the CURRENT geometry actually claims (a rider may be staged as far
  // up-course as -120, which is what selftest section 5 does)
  const BZ0 = Math.min(0, -120) + CFG.backstopBoundOffset_m, BZ1 = CFG.zBoundDown_m;
  // R2: a CONVERGENCE SERIES, not one number, with each grid published
  const series = {};
  for (const [ss, zs, key] of [[2, 2, '2 x 2'], [0.5, 1, '0.5 x 1'], [0.25, 0.5, '0.25 x 0.5']]) {
    let w = 0, at = null;
    for (let z = BZ0; z <= BZ1; z += zs) { const cxz = centerX(z);
      for (let sOff = -LB; sOff <= LB; sOff += ss) { const d = div(cxz + sOff, z);
        if (d > w) { w = d; at = [+sOff.toFixed(2), +z.toFixed(1)]; } } }
    series[key] = { worst: +w.toFixed(3), at };
    console.log(`      divergence in box @${key} m: ${f(w)} at ${JSON.stringify(at)}  ` +
      `(published ${CFG.measured.divergenceInBoxByGrid_m[key]})`);
  }
  let ny = 1, nyAt = null, nyD = 1, nyDAt = null;
  for (let z = BZ0; z <= BZ1; z += 1) for (let sOff = -LB; sOff <= LB; sOff += 0.5) {
    const n = nAt(centerX(z) + sOff, z)[1]; if (n < ny) { ny = n; nyAt = [+sOff.toFixed(2), +z.toFixed(1)]; } }
  for (let z = BZ0 - 15; z <= BZ1 + 15; z += 1) for (let sOff = -LB - 15; sOff <= LB + 15; sOff += 0.5) {
    const n = nAt(centerX(z) + sOff, z)[1]; if (n < nyD) { nyD = n; nyDAt = [+sOff.toFixed(2), +z.toFixed(1)]; } }
  console.log(`      maxCentrelineSlope ${f(maxK, 4)} @z ${kAt}  (published ${CFG.measured.maxCentrelineSlope})`);
  console.log(`      minSurfaceNy in box ${f(ny, 4)} at ${nyAt}  (published ${CFG.measured.minSurfaceNyInBox})`);
  console.log(`      minSurfaceNy dilated 15 m ${f(nyD, 4)} at ${nyDAt}  (published ${CFG.measured.minSurfaceNyDilated15m})`);
  ok('published maxCentrelineSlope matches', Math.abs(maxK - CFG.measured.maxCentrelineSlope) < 0.005);
  for (const key of Object.keys(series)) {
    ok(`published box divergence @${key} m matches, and is under the RS-05 ceiling`,
      Math.abs(series[key].worst - CFG.measured.divergenceInBoxByGrid_m[key]) < 0.05 &&
      series[key].worst <= CFG.maxDivergence_m,
      `${f(series[key].worst)} vs published ${CFG.measured.divergenceInBoxByGrid_m[key]}, ceiling ${CFG.maxDivergence_m}`);
  }
  ok('the published headline is at or above the finest grid (it is a converged max, not a coarse one)',
    CFG.measured.divergenceInContainmentBox_m >= series['0.25 x 0.5'].worst - 1e-9,
    `published ${CFG.measured.divergenceInContainmentBox_m} >= ${f(series['0.25 x 0.5'].worst)}`);
  ok('published minSurfaceNy in box matches (and is a lower bound)',
    ny >= CFG.measured.minSurfaceNyInBox - 0.01, `${f(ny, 4)} >= ${CFG.measured.minSurfaceNyInBox}`);
  ok('the n_y policy floor is genuinely reachable inside the box',
    ny < CFG.nyFloorPolicy, `min n_y ${f(ny, 4)} < floor ${CFG.nyFloorPolicy}`);
} else {
  console.log('      skipped (pass --measure; it sweeps the whole course and takes ~1 min)');
}

console.log(`\n${checks - fails}/${checks} checks passed.`);
process.exit(fails === 0 ? 0 : 1);
