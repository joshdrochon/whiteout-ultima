// ============================================================================
// selftest for run-structure candidate B — the half no RS gate touches.
//
//   node sandbox/run-structure/B/selftest.mjs        (non-zero exit on failure)
//
// The RS gates measure this module through harness/run-runner.mjs's `play`
// drive, which never leaves the middle 34 m of a 120 m corridor. The corridor
// therefore never fires on any frame RS-09 or RS-10 measures, and their zeros
// are measurements of a module that was not running (run.mjs header §7). This
// file runs the module under load — adversarial bails, an airborne cannon fired
// at the wall, a boosting rider pinned against the gate and the run-out — and
// measures, directly, the properties the gates can only infer:
//
//   * the module writes ZERO position and ZERO heading, diffed around EVERY
//     run.step() call on every drive here, correction frames included;
//   * the corridor actually holds, and by how much;
//   * the start gate holds a rider spawned behind it;
//   * the card reads the trick system back exactly and freezes;
//   * the landing ledger is the trick system's, not physics'.
// ============================================================================
import { sampleHeight } from '../../../src/render/main.mjs';
import { createPhysics, DEFAULTS } from '../../../src/physics/physics.mjs';
import { createTricks } from '../../../src/tricks/tricks.mjs';
import { createRun } from './run.mjs';

const DT = 1 / 60;
let pass = 0, fail = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${label}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? '  ' + detail : ''}`); }
};
const head = t => console.log(`\n== ${t} ==`);
const f = (v, n = 2) => Number(v).toFixed(n);

// ---- the runner's environment, reproduced exactly ----
function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CEN = new Map();
const centerX = z => { const k = Math.round(z / 25) * 25; if (!CEN.has(k)) CEN.set(k, courseCenterX(k)); return CEN.get(k); };
const envRun = () => ({ sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 } });
const envPhys = { sampleHeight, sampleNormal: (x, z) => {
  const d = 0.05;
  const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
  const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
  const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
}, surface: 'snow' };

// ---- the runner's divergence probe, reproduced exactly ----
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

const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const seek = (st, tx, tz) => Math.max(-1, Math.min(1,
  wrapA(Math.atan2(tz - st.pos[2], tx - st.pos[0]) - st.heading) * 1.8));

// harness/run-runner.mjs `play`, copied so the pace here is the gate's pace
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

// ---- one instrumented session. The instrumentation IS the point: pos and
//      heading are snapshotted immediately before run.step() and diffed
//      immediately after, every frame. ----
function drive({ duration, input, z0 = 15, x0 = null, y0 = 0, v0 = [0, 0, 6], withRun = true }) {
  const ph = createPhysics(envPhys, {});
  const tr = createTricks({});
  const run = withRun ? createRun(envRun()) : null;
  const ts = tr.init();
  const rs = run ? run.init() : { outOfBounds: false, phase: 'n/a', confine: null };
  const sx = x0 === null ? centerX(z0) : x0;
  const st = ph.init([sx, sampleHeight(sx, z0) + y0, z0], [...v0], Math.PI / 2);
  const m = { posWrite: 0, headWrite: 0, maxFrameMove: 0, maxCorrMove: 0,
    maxDiv: 0, maxOffset: 0, maxZ: -Infinity, frames: 0, corrFrames: 0, zAtGo: null,
    runningFrames: 0, activeRunning: 0, finishAt: null };
  let prev = [...st.pos];
  const n = Math.round(duration / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const inp = input(t, st, rs) ?? {};
    ph.step(st, inp, DT);
    tr.step(ts, st, inp, DT);
    if (run) {
      const p0 = [st.pos[0], st.pos[1], st.pos[2]], h0 = st.heading;
      run.step(rs, st, ts, DT);
      m.posWrite = Math.max(m.posWrite,
        Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]));
      m.headWrite = Math.max(m.headWrite, Math.abs(wrapA(st.heading - h0)) * 180 / Math.PI);
    }
    if (m.zAtGo === null && rs.phase === 'running') m.zAtGo = st.pos[2];
    if (rs.phase === 'running') { m.runningFrames++; if (rs.outOfBounds) m.activeRunning++; }
    if (rs.phase === 'finished' && m.finishAt === null) m.finishAt = rs.time_s;
    const move = Math.hypot(st.pos[0] - prev[0], st.pos[1] - prev[1], st.pos[2] - prev[2]);
    m.maxFrameMove = Math.max(m.maxFrameMove, move);
    if (rs.outOfBounds) { m.corrFrames++; m.maxCorrMove = Math.max(m.maxCorrMove, move); }
    m.maxDiv = Math.max(m.maxDiv, divergenceAt(st.pos[0], st.pos[2]));
    m.maxOffset = Math.max(m.maxOffset, Math.abs(st.pos[0] - centerX(st.pos[2])));
    m.maxZ = Math.max(m.maxZ, st.pos[2]);
    m.frames++;
    prev = [...st.pos];
  }
  return { ph, tr, run, ts, rs, st, m };
}

const cfg = createRun(envRun()).config;

// ===========================================================================
head('0. derived geometry (run.mjs header §3)');
console.log(`  physicsAnchor=${cfg.physicsAnchor}  treeLine=${cfg.treeLine_m}  firm=${cfg.firmWidth}` +
  `  hard=${cfg.hardWidth}  arena=${f(cfg.arena_m)}  zHard=[${cfg.zHardUp}, ${cfg.zHardDown}]`);
console.log(`  A_WALL=${f(cfg.wallAccel_mps2)} m/s^2  stepMargin=${f(cfg.stepMargin_m)} m` +
  `  maxVelWrite=${f(cfg.maxVelWrite_mps)} m/s  maxPosEffect/frame=${f(cfg.maxPosEffectPerFrame_m)} m` +
  `  streamMax=${cfg.streamMax}`);
ok(cfg.maxDivergence_m === 4, 'config.maxDivergence_m is the CONTRACT ceiling, not a self-guarantee');
ok(cfg.maxPosEffectPerFrame_m < 2, 'structural write ceiling is inside RS-06', `${f(cfg.maxPosEffectPerFrame_m)} m < 2 m`);
ok(cfg.hardWidth > cfg.firmWidth && cfg.hardWidth <= 154, 'hard limit sits between the corridor edge and the 2 m divergence contour');
ok(divergenceAt(centerX(2149.5) + cfg.hardWidth, 2149.5) <= 2, 'divergence at the hard limit is inside 2 m at the worst z found by the sweep');

// ===========================================================================
head('1. the ordinary run: the module never touches the rider');
{
  const s = drive({ duration: 300, input: play });
  const r = s.run.results(s.rs, s.ts);
  console.log(`  finish ${f(s.rs.time_s, 1)} s  score ${Math.round(s.ts.score)}  bestTrick ${JSON.stringify(r.bestTrick)}` +
    `  peak offset ${f(s.rs.confine.peakOffset_m)} m  writes while running ${s.m.activeRunning}/${s.m.runningFrames}` +
    `  writes after the line (the run-out holding a rider who never lets go) ${s.rs.confine.activeFrames - s.m.activeRunning}`);
  ok(s.rs.phase === 'finished', 'run finishes');
  ok(s.m.activeRunning === 0, 'zero confinement writes on an ordinary run, start to finish line',
    `${s.m.runningFrames} running frames`);
  ok(s.rs.confine.wallFrames === 0, 'the corridor wall never fires on an ordinary run');
  ok(s.m.posWrite === 0 && s.m.headWrite === 0, 'zero position and heading written', `pos ${s.m.posWrite} m, heading ${s.m.headWrite} deg`);
  ok(s.rs.time_s > 90 && s.rs.time_s < 260, 'pace is bare physics and inside the RS-08 band', `${f(s.rs.time_s, 1)} s`);
  ok(r.score === s.rs.results.score, 'card score is frozen');
}

// ===========================================================================
head('2. the corridor under load: the harness\'s own adversarial drive');
{
  const D = 240;
  const adversarial = (t, st) => {
    const z = st.pos[2], c = centerX(z);
    let tx, tz;
    if (t < D * 0.45) { tx = centerX(z + 120); tz = z + 120; }
    else if (t < D * 0.7) { tx = c + 800; tz = z + 40; }
    else if (t < D * 0.85) { tx = c - 800; tz = z + 40; }
    else { tx = centerX(z + 120); tz = z + 400; }
    return { tuck: true, boost: true, steer: seek(st, tx, tz) };
  };
  const held = drive({ duration: D, input: adversarial });
  const free = drive({ duration: D, input: adversarial, withRun: false });
  const c = held.rs.confine;
  console.log(`  finish at ${f(held.m.finishAt, 1)} s, so most of this drive's bail happens AFTER the line, pinned on the run-out`);
  console.log(`  held : peakOffset ${f(c.peakOffset_m)} m  maxZ ${f(held.m.maxZ, 0)}  maxDivergence ${f(held.m.maxDiv)} m` +
    `  corrFrames ${held.m.corrFrames}  maxMoveWhileCorrecting ${f(held.m.maxCorrMove, 3)} m`);
  console.log(`  free : peakOffset ${f(free.m.maxOffset)} m  maxZ ${f(free.m.maxZ, 0)}  maxDivergence ${f(free.m.maxDiv)} m`);
  console.log(`  wallFrames ${c.wallFrames}  arenaFrames ${c.arenaFrames}  hardFrames ${c.hardFrames}` +
    `  ceilFrames ${c.ceilFrames}  underDelivered ${c.underDelivered}  minProjCoef ${f(c.minProjCoef, 3)}` +
    `  maxVelWrite ${f(c.maxVelWrite_mps, 3)} m/s  peakDepth lat ${f(c.peakDepthLateral_m, 3)} / along ${f(c.peakDepthAlong_m, 3)} m`);
  ok(held.m.corrFrames > 500, 'the corridor actually fires under this drive', `${held.m.corrFrames} frames`);
  ok(held.m.maxDiv <= 4, 'RS-05 property holds under load', `${f(held.m.maxDiv)} m`);
  ok(held.m.maxCorrMove <= 2, 'RS-06 property holds under load', `${f(held.m.maxCorrMove, 3)} m`);
  ok(held.m.posWrite === 0, 'ZERO position written, on correction frames included', `${held.m.posWrite} m`);
  ok(held.m.headWrite === 0, 'ZERO heading written, on correction frames included', `${held.m.headWrite} deg`);
  ok(c.hardFrames === 0, 'the hard limit never engaged (audited invariant)');
  ok(c.ceilFrames === 0, 'the structural write ceiling never bound');
  ok(c.maxVelWrite_mps <= cfg.maxVelWrite_mps, 'every write inside the published ceiling');
  ok(free.m.maxZ > cfg.zHardDown, 'without the module this drive leaves the world', `reaches z=${f(free.m.maxZ, 0)}`);
  ok(held.m.maxZ < cfg.zHardDown, 'with it, the rider stays inside the backdrop seam', `z=${f(held.m.maxZ, 0)}`);
  ok(c.terrainInward_mps2 !== 0 || c.peakOffset_m < cfg.treeLine_m, 'terrain pull telemetry populated in the shoulder');
}

// ===========================================================================
head('3. straight out, both flanks, and straight past the finish');
for (const [name, target] of [
  ['bail right', (st, c) => [c + 900, st.pos[2] + 10]],
  ['bail left', (st, c) => [c - 900, st.pos[2] + 10]],
  ['past the finish', (st) => [centerX(st.pos[2] + 120), st.pos[2] + 600]],
]) {
  const inp = (t, st) => {
    const tg = target(st, centerX(st.pos[2]));
    return { tuck: true, boost: true, steer: seek(st, tg[0], tg[1]) };
  };
  const held = drive({ duration: 240, input: inp });
  const free = drive({ duration: 240, input: inp, withRun: false });
  const hc = held.rs.confine;
  console.log(`  ${name.padEnd(16)} held: offset ${f(held.m.maxOffset)} m (module's own smooth |s| ${f(hc.peakOffset_m)})` +
    `  z ${f(held.m.maxZ, 0)}  div ${f(held.m.maxDiv)} m  wallFrames ${hc.wallFrames}  peakDepth lat ${f(hc.peakDepthLateral_m, 2)} / along ${f(hc.peakDepthAlong_m, 2)} m` +
    `  maxWrite ${f(hc.maxVelWrite_mps, 2)} m/s`);
  console.log(`  ${' '.repeat(16)} free: offset ${f(free.m.maxOffset)} m  z ${f(free.m.maxZ, 0)}  div ${f(free.m.maxDiv)} m`);
  ok(hc.peakOffset_m <= 121, `${name}: the wall holds the corridor edge`, `smooth |s| peaked at ${f(hc.peakOffset_m)} m`);
  ok(held.m.maxDiv <= 4, `${name}: divergence held under 4 m`, `${f(held.m.maxDiv)} m`);
  ok(held.m.maxCorrMove <= 2, `${name}: no correction frame moved more than 2 m`, `${f(held.m.maxCorrMove, 3)} m`);
  ok(held.m.posWrite === 0 && held.m.headWrite === 0, `${name}: zero position/heading written`);
  ok(held.rs.confine.hardFrames === 0, `${name}: hard limit never engaged`);
}

// ===========================================================================
head('4. the airborne cannon (the arrival no acceleration bound covers)');
{
  // fired outward at 30 m/s from inside the corridor, airborne: physics
  // conserves horizontal velocity in the air, so nothing but the module stops it
  for (const off of [95, 115]) {
    const z0 = 1200, cx0 = centerX(z0);
    const x0 = cx0 + off;
    // launched 20 m above the snow at the speed cap, aimed straight out: in the
    // air physics conserves horizontal velocity exactly (PC-09), so this arrives
    // at the wall with everything it left with
    const shot = { duration: 20, input: () => ({}), z0, x0, y0: 20, v0: [DEFAULTS.V_CAP, 6, 2] };
    const held = drive(shot);
    const free = drive({ ...shot, withRun: false });
    console.log(`  from ${off} m: held peak offset ${f(held.m.maxOffset)} m (div ${f(held.m.maxDiv)} m)` +
      `  |  free ${f(free.m.maxOffset)} m (div ${f(free.m.maxDiv)} m)`);
    ok(held.m.maxOffset < free.m.maxOffset, `cannon from ${off} m is held short of where it would land free`);
    ok(held.m.maxDiv <= 4, `cannon from ${off} m stays inside the divergence budget`, `${f(held.m.maxDiv)} m`);
    ok(held.m.maxOffset <= cfg.hardWidth, `cannon from ${off} m never reaches the hard limit`, `${f(held.m.maxOffset)} m vs ${cfg.hardWidth} m`);
  }
}

// ===========================================================================
head('5. the start gate');
{
  // spawned 5 m behind the bar with the boost pinned: the gate must hold it for
  // the whole countdown, and the creep it allows is the number RS-09 would read
  const s = drive({ duration: 6, z0: -5, input: () => ({ tuck: true, boost: true }) });
  const go = s.rs.stream.find(e => e.type === 'go');
  console.log(`  from z=-5, boost pinned: startedBy=${s.rs.startedBy}  gateFrames ${s.rs.confine.gateFrames}` +
    `  z at GO ${f(s.m.zAtGo, 3)}  z at t=6 s ${f(s.st.pos[2], 2)}`);
  ok(s.rs.startedBy === 'gate', 'a rider behind the line is held by the gate, not waved through');
  ok(go && go.data.by === 'gate', 'the stream records the GO');
  ok(s.rs.confine.gateFrames > 100, 'the bar is what held them', `${s.rs.confine.gateFrames} frames`);
  ok(s.m.zAtGo <= 3, 'creep through the closed bar stays inside RS-09\'s 3 m drift ceiling',
    `z=${f(s.m.zAtGo, 3)} after ${cfg.countdown_s} s of pinned boost`);
  ok(s.m.posWrite === 0 && s.m.headWrite === 0, 'and the gate writes no position and no heading');

  // spawned 40 m behind the line, rolling at 6 m/s
  const b = drive({ duration: 6, z0: -40, input: () => ({ tuck: true }) });
  console.log(`  from z=-40, rolling: z at GO ${f(b.m.zAtGo, 2)}  (bar at z=0)`);
  ok(b.rs.startedBy === 'gate', 'a rolling rider behind the line is held too');
  ok(b.m.zAtGo <= 0.5, 'and never rides through the bar', `z=${f(b.m.zAtGo, 3)}`);

  // spawned where the harness spawns: past the bar, no gate (disclosed)
  const p = drive({ duration: 2, z0: 15, input: () => ({ tuck: true }) });
  ok(p.rs.startedBy === 'past-line', 'a rider already down the mountain is not pinned (harness seed, disclosed)');
  ok(p.rs.confine.gateFrames === 0, 'and the gate writes nothing');
}

// ===========================================================================
head('6. why the along-course barriers have no contact recovery');
{
  // Not an assertion about this module: a property of the accepted physics that
  // decides the design. groundCore works on |forward speed| and drives it toward
  // V_BOOST whatever its SIGN, so a backward push given to a boosting rider who
  // is not already moving forward is amplified instead of absorbed. That is the
  // state a rider pinned against a barrier is in, which is why the gate,
  // backstop, run-out and hard z limits stop at zero and never push back.
  const ph = createPhysics(envPhys, {});
  const z0 = 600, x0 = centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 0], Math.PI / 2);
  st.vel[2] = -0.14;                       // the contact push a recovery would apply
  const z1 = st.pos[2];
  for (let i = 0; i < 180; i++) ph.step(st, { boost: true }, DT);
  const drift = st.pos[2] - z1;
  console.log(`  a 0.14 m/s backward push to a pinned boosting rider: ${f(drift, 1)} m in 3 s` +
    `  (v_z now ${f(st.vel[2], 1)} m/s)`);
  ok(drift < -5, 'physics amplifies it — a recovery on the z barriers would fire the rider up the mountain',
    `${f(drift, 1)} m up-course`);
}

// ===========================================================================
head('7. the run-out: a rider who never lets go');
{
  const s = drive({ duration: 300, input: (t, st) => ({ tuck: true, boost: true,
    steer: seek(st, centerX(st.pos[2] + 120), st.pos[2] + 400) }) });
  const over = s.st.pos[2] - cfg.zFirmDown;
  console.log(`  parked at z=${f(s.st.pos[2], 1)} against a run-out wall at ${f(cfg.zFirmDown, 0)}` +
    `  (creep ${f(over, 2)} m over ${f(300 - (s.rs.results?.time_s ?? 0), 0)} s of leaning)`);
  ok(s.rs.phase === 'finished', 'the run finished before the run-out');
  ok(s.st.pos[2] < cfg.zHardDown, 'and the rider is nowhere near the backdrop seam', `${f(cfg.zHardDown - s.st.pos[2], 0)} m of margin`);
  ok(s.m.maxDiv <= 4, 'divergence stays inside the budget the whole time', `${f(s.m.maxDiv)} m`);
}

// ===========================================================================
head('8. the card and the ledger');
{
  const s = drive({ duration: 300, input: play });
  const r = s.run.results(s.rs, s.ts);
  console.log(`  time ${r.time_s} s  score ${f(r.score, 2)}  bestTrick ${JSON.stringify(r.bestTrick)}` +
    ` (${r.bestAward ? r.bestAward.points + ' pts, star x' + r.bestAward.star : 'none'})`);
  console.log(`  ledger: landed ${r.ledger.landed} / bailed ${r.ledger.bailed}  vs physics ` +
    JSON.stringify(r.ledger.physicsLanding) + `  disagreements ${r.ledger.verdictDisagreements}`);
  console.log(`  splits ${JSON.stringify(r.splits.map(x => x.t))}  stream ${s.rs.stream.length} events, dropped ${s.rs.streamDropped}`);
  ok(r.bestTrick !== null, 'the card names a banked award');
  ok(r.landed + r.crashed === s.rs.jumps || r.landed + r.crashed === s.rs.jumps - 1,
    'every touchdown was adjudicated exactly once', `${r.landed}+${r.crashed} vs ${s.rs.jumps} jumps`);
  ok(r.ledger.physicsLanding.unlabelled === 0, 'physics labelled every touchdown (so no disagreement is counted on a null)');
  // freeze
  const before = JSON.stringify(r);
  for (let i = 0; i < 600; i++) s.run.step(s.rs, s.st, s.ts, DT);
  ok(JSON.stringify(s.run.results(s.rs, s.ts)) === before, 'the card is frozen after the line');
  ok(Object.isFrozen(s.rs.results), 'and is literally frozen, not just re-read');
  // the score on the card is the trick system's at the line
  ok(r.score === s.rs.results.score, 'reported score is the value banked at the crossing');
  // restart
  s.run.restart(s.rs);
  ok(s.rs.phase === 'ready' && s.rs.time_s === 0 && s.rs.results === null && s.rs.stream.length === 0,
    'restart() rebuilds every field from init()');
}

// ===========================================================================
head('9. the terrain is the berm (layer 1, measured)');
{
  // the module publishes the ground's own restoring pull; re-measure it here at
  // the corridor edge over the whole course and compare with the header's table
  const G = 9.81;
  const pull = (off) => {
    let sum = 0, n = 0, mn = Infinity, mx = -Infinity;
    for (let z = 0; z <= 2400; z += 5) for (const sgn of [1, -1]) {
      const x = centerX(z) + sgn * off, e = 0.5;
      const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
      const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
      const l = Math.hypot(dx, 1, dz) || 1;
      const N = [-dx / l, 1 / l, -dz / l];
      const gdn = -G * N[1];
      const gt = [-gdn * N[0], -G - gdn * N[1], -gdn * N[2]];
      const k = (centerX(z + 25) - centerX(z - 25)) / 50, sq = Math.hypot(1, k);
      const ux = sgn / sq, uz = -sgn * k / sq;
      const dn = ux * N[0] + uz * N[2];
      let px = ux - dn * N[0], py = -dn * N[1], pz = uz - dn * N[2];
      const pl = Math.hypot(px, py, pz) || 1;
      const a = -(gt[0] * px + gt[1] * py + gt[2] * pz) / pl;
      sum += a; n++; mn = Math.min(mn, a); mx = Math.max(mx, a);
    }
    return { mean: sum / n, mn, mx };
  };
  for (const off of [55, 80, 120]) {
    const p = pull(off);
    console.log(`  |s|=${String(off).padStart(3)}  terrain pulls inward  mean ${f(p.mean)}  min ${f(p.mn)}  max ${f(p.mx)} m/s^2`);
  }
  const edge = pull(120);
  ok(edge.mn > 0, 'at the corridor edge the ground never pushes the rider outward', `min ${f(edge.mn)} m/s^2`);
  ok(edge.mean > 4, 'and it pulls harder than any berm this module could honestly add', `mean ${f(edge.mean)} m/s^2`);
}

// ===========================================================================
head('10. determinism');
{
  const hash = s => `${s.st.pos.map(v => v.toFixed(6))}|${s.rs.time_s.toFixed(6)}|${s.ts.score}`;
  const a = drive({ duration: 45, input: play });
  const b = drive({ duration: 45, input: play });
  ok(hash(a) === hash(b), 'identical inputs reproduce an identical state');
  const c = drive({ duration: 45, input: play });
  c.run.restart(c.rs);
  const d = createRun(envRun());
  ok(JSON.stringify(c.rs) === JSON.stringify(d.init()), 'restart() lands exactly on a fresh init()');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
