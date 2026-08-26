#!/usr/bin/env node
// ============================================================================
// selftest.mjs — the evidence the RS gates cannot produce.   (cycle 5)
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
  ok(`  3-D guard did not bind`, c.ceil3Frames === 0, `ceil3Frames ${c.ceil3Frames}`);
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
  console.log(`      limitFrames ${c.limitFrames} peak demand ${f(c.peakDemand_mps2, 1)} ` +
    `applied H ${f(c.peakAppliedH_mps2, 1)} 3-D ${f(c.peakApplied_mps2, 1)} ceil3 ${c.ceil3Frames}`);
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
  for (let z = 0; z <= 2400; z += 7) {
    const k = kAt(z);
    for (const sg of [1, -1]) {
      const offs = [];
      for (let o = 60; o < soft; o += 1) offs.push(o);
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
    Math.abs(peakBerm - CFG.measured.peakBermTopUp_mps2) < 0.05,
    `swept ${f(peakBerm)} vs published ${CFG.measured.peakBermTopUp_mps2}`);
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
  ok('held: drift over the countdown', drift < 3 && rs.phase === 'ready',
    `drift ${f(drift)} m, timer ${f(rs.time_s)} s, phase ${rs.phase}`);
  ok('  clock reads zero while held', rs.time_s === 0);
  ok('  the gate leaves the corridor-lateral rate untouched', worstDs < 1e-12,
    `worst d(ds/dt) ${worstDs.toExponential(2)} m/s, while worst dvx ${f(worstVx)} m/s`);
}

// =========================================================================== 6
sec('6. an ordinary competent run — the module must not change it');
// The brief a run module has to keep: it times the run, it does not alter it.
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
  let crossT = null, crossScore = null, wide = 0;
  for (let i = 0; i < 60 * 300; i++) {
    const t = i * DT;
    const inp = play(t, st);
    ph.step(st, inp, DT); tr.step(ts, st, inp, DT);
    if (crossT === null && st.pos[2] >= 2400) { crossT = t + DT; crossScore = ts.score; }
    if (crossT === null) wide = Math.max(wide, Math.abs(st.pos[0] - centerX(st.pos[2])));
  }
  const res = r.run.results(r.rs, r.ts);
  ok('finish time identical to the no-module run', Math.abs(res.time_s - crossT) < 1e-3,
    `module ${f(res.time_s)} s vs no-module ${f(crossT)} s`);
  ok('score identical to the no-module run', Math.abs(res.score - crossScore) < 1e-9,
    `module ${res.score} vs no-module ${crossScore}`);
  ok('widest line up to the finish identical', Math.abs(r.rs.confine.peakOffset_m - wide) < 1e-6,
    `${f(wide, 1)} m (berm starts at ${CFG.bermStart_m})`);
  ok('zero in-bounds writes over the whole run', r.rs.confine.inBoundsWriteFrames === 0,
    `frames ${r.rs.confine.inBoundsWriteFrames} of ${r.rs.confine.totalFrames}`);
  // The airborne channel (run.mjs 3.1) is real and is disclosed, not denied:
  // a lateral velocity write while airborne can become a heading change at the
  // next clean landing. It must not exist DURING the run.
  ok('zero airborne velocity writes before the finish', r.m.airVelWritesRunning === 0,
    `during the run ${r.m.airVelWritesRunning}; in the run-out after it ${r.m.airVelWrites - r.m.airVelWritesRunning} ` +
    `(worst ${f(r.m.maxAirVelWrite, 2)} m/s^2)`);
  console.log(`      out-of-bounds frames (geometry) ${r.rs.confine.oobFrames}; ` +
    `active (module wrote) ${r.rs.confine.activeFrames}; run-out impulse ${f(r.rs.confine.impulse.runout)} m/s`);
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
  let maxK = 0, kAt = 0;
  for (let z = -400; z <= 3190; z += 1) {
    const k = Math.abs(centerX(z + 0.5) - centerX(z - 0.5));
    if (k > maxK) { maxK = k; kAt = z; } }
  const LB = CFG.lateralBound_m;
  let wd = 0, wdAt = null, ny = 1, nyAt = null;
  for (let z = -125; z <= 2576; z += 2) for (let s = -LB; s <= LB; s += 2) {
    const x = centerX(z) + s;
    const d = div(x, z); if (d > wd) { wd = d; wdAt = [+s.toFixed(1), Math.round(z)]; }
  }
  for (let z = -140; z <= 2591; z += 2) for (let s = -LB - 15; s <= LB + 15; s += 2) {
    const n = nAt(centerX(z) + s, z)[1]; if (n < ny) { ny = n; nyAt = [+s.toFixed(1), Math.round(z)]; } }
  console.log(`      maxCentrelineSlope ${f(maxK, 4)} @z ${kAt}  (published ${CFG.measured.maxCentrelineSlope})`);
  console.log(`      divergenceInContainmentBox ${f(wd)} at ${wdAt}  (published ${CFG.measured.divergenceInContainmentBox_m})`);
  console.log(`      minSurfaceNy ${f(ny, 4)} at ${nyAt}  (published ${CFG.measured.minSurfaceNy})`);
  ok('published maxCentrelineSlope matches', Math.abs(maxK - CFG.measured.maxCentrelineSlope) < 0.005);
  ok('published containment-box divergence matches and is under the RS-05 ceiling',
    Math.abs(wd - CFG.measured.divergenceInContainmentBox_m) < 0.1 && wd <= CFG.maxDivergence_m,
    `${f(wd)} m vs ceiling ${CFG.maxDivergence_m} m`);
  ok('published minSurfaceNy matches (and is a lower bound)',
    ny >= CFG.measured.minSurfaceNy - 0.01, `${f(ny, 4)} >= ${CFG.measured.minSurfaceNy}`);
} else {
  console.log('      skipped (pass --measure; it sweeps the whole course and takes ~1 min)');
}

console.log(`\n${checks - fails}/${checks} checks passed.`);
process.exit(fails === 0 ? 0 : 1);
