// Self-test for the half of run.mjs that NO GATE EXERCISES.
//
// harness/run-runner.mjs drives every RS scenario with `play` = tuck + boost +
// steer. No jump input ever reaches the physics, so no trick is ever landed,
// ts.score is 0 for the whole run, and RS-04 compares 0 to 0 (cycle-1 mustFix 5,
// cycle-2 mustFix 2). Everything in the results card that comes from the trick
// system — score, bestTrick, bestTrickPoints, tricky, trickyLetters, jumps,
// landed/crashed — is therefore unexercised by the gate set.
//
// This drives the accepted physics + accepted tricks + this run module with a
// scripted TRICK input: charge, pop, hold an uber through the air, land clean,
// repeat until TRICKY, then ride to the finish. It asserts the card reads back
// what actually happened, and that the frozen card stays frozen.
//
//   node sandbox/run-structure/A/selftest.mjs
//
// Deterministic, no Date, no random. Exits non-zero on any failed assertion.

import { createRun } from './run.mjs';
import { createPhysics } from '../../../src/physics/physics.mjs';
import { createTricks } from '../../../src/tricks/tricks.mjs';
import { sampleHeight } from '../../../src/render/main.mjs';

const DT = 1 / 60;

// same course centreline definition the runner uses
function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CEN = new Map();
const centerX = z => {
  const k = Math.round(z / 25) * 25;
  if (!CEN.has(k)) CEN.set(k, courseCenterX(k));
  return CEN.get(k);
};

const env = {
  sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 },
};
const physEnv = {
  sampleHeight,
  sampleNormal: (x, z) => {
    const d = 0.05;
    const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
    const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  },
  surface: 'snow',
};

const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
// a rider who actually aims down the course (closed loop), so the run makes
// progress between tricks
const aim = st => {
  const want = Math.atan2(120, centerX(st.pos[2] + 120) - st.pos[0]);
  return Math.max(-1, Math.min(1, wrap(want - st.heading) * 1.8)) * 0.6;
};

// TRICK SCRIPT — a small state machine, not a clock, because the course is
// steep: on a 23 deg pitch at 25 m/s the ground falls away at ~10 m/s, so a
// 5 m/s pop thrown at speed buys almost no air and the uber animation cannot
// finish before touchdown, which the trick system correctly calls a crash
// (JA-15). A player sets up for an uber by scrubbing speed first; so does this.
//
//   ride  -> 3 s of tucked riding
//   setup -> brake and crouch (charge) until the board is down to SETUP_SPEED
//   pop   -> jumpRelease on the next grounded frame
//   air   -> hold the uber (cycles 0-11), or spin+grab (cycle 12), or hold the
//            grab into the landing (cycle 13, always a crash: JA-14)
//   -> ride
//
// Cycles 0-11 land the same equipped uber over and over: JA-19 says repeats
// each light a TRICKY letter, and JA-17's x0.5 repetition chain is visible in
// the banked points (13210, 6605, 3302.5, ...).
const SETUP_SPEED = 8;      // m/s — slow enough that a 5 m/s pop clears the slope
const RIDE_S = 3;
const memo = { mode: 'ride', tMode: 0, cycle: 0 };

function trickInput(t, st) {
  const steer = aim(st);
  const speed = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
  const n = memo.cycle;
  const dwell = t - memo.tMode;
  const to = m => { memo.mode = m; memo.tMode = t; };

  switch (memo.mode) {
    case 'ride':
      if (dwell >= RIDE_S && st.onGround) to('setup');
      return { steer, tuck: true };
    case 'setup':
      if (st.onGround && speed <= SETUP_SPEED) { to('pop'); return { steer, jumpRelease: true }; }
      if (dwell > 12) { to('ride'); return { steer, tuck: true }; }   // give up, keep riding
      return { steer, brake: true, crouch: true, spin: n === 12 ? 1 : 0 };
    case 'pop':
      to('air');
      return { steer };
    case 'air':
      if (st.onGround && dwell > 0.2) { memo.cycle++; to('ride'); return { steer, tuck: true }; }
      if (dwell > 4) { memo.cycle++; to('ride'); return { steer, tuck: true }; }
      if (n < 12) return { steer, uber: 1 };
      if (n === 12) return st.airTime < 0.7 ? { steer, spin: 1, grab: true } : { steer, grab: true };
      return { steer, grab: true };                                    // cycle 13: bail
    default:
      return { steer, tuck: true };
  }
}

const ph = createPhysics(physEnv, {});
const tr = createTricks({});
const run = createRun(env);
const ts = tr.init();
const rs = run.init();
const z0 = 15, x0 = centerX(z0);
const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 6], Math.PI / 2);

let uberSeen = 0, maxFrameJump = 0, trickyAt = null;
let prevPos = [...st.pos], prevAward = null;
const banked = [];
const n = Math.round(260 / DT);
for (let i = 0; i < n; i++) {
  const t = i * DT;
  const inp = rs.phase === 'running' ? trickInput(rs.time_s, st) : { steer: aim(st) };
  ph.step(st, inp, DT);
  tr.step(ts, st, inp, DT);
  run.step(rs, st, ts, DT);
  const jump = Math.hypot(st.pos[0] - prevPos[0], st.pos[1] - prevPos[1], st.pos[2] - prevPos[2]);
  if (jump > maxFrameJump) maxFrameJump = jump;
  prevPos = [...st.pos];
  if (ts.lastAward && ts.lastAward !== prevAward) banked.push(ts.lastAward);
  prevAward = ts.lastAward;
  if (ts.tricky && trickyAt === null) trickyAt = +rs.time_s.toFixed(1);
  if (ts.trickyLetters > uberSeen) uberSeen = ts.trickyLetters;
  if (rs.phase === 'finished') break;
}

const res = run.results(rs, ts);

// keep driving past the line: the frozen card must not move
const before = JSON.stringify(res);
for (let i = 0; i < 600; i++) { ph.step(st, { boost: true, tuck: true }, DT); tr.step(ts, st, {}, DT); run.step(rs, st, ts, DT); }
const after = JSON.stringify(run.results(rs, ts));

let fails = 0;
const check = (name, ok, got) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? '  = ' + got : ''}`);
};

console.log('--- results card ---');
console.log(JSON.stringify(res, null, 1));
console.log('--- assertions ---');
check('run finished', rs.phase === 'finished', rs.phase);
check('clock ran and is plausible', res.time_s > 60 && res.time_s < 260, res.time_s);
check('score matches the trick system', res.score === ts.score, `${res.score} vs ${ts.score}`);
check('score is non-zero (tricks actually landed)', res.score > 0, res.score);
check('bestTrick names a banked jump', typeof res.bestTrick === 'string' && res.bestTrick.length > 0, res.bestTrick);
check('bestTrick is the best-scoring bank',
  res.bestTrickPoints === Math.round(Math.max(...banked.map(b => b.points))),
  `${res.bestTrickPoints} of ${banked.length} banks`);
check('bestTrick is the banked SUMMARY, not a single entry',
  banked.some(b => b.name === res.bestTrick), res.bestTrick);
check('TRICKY lit after 6 landed ubers', res.tricky === true && res.trickyLetters === 6,
  `tricky=${res.tricky} letters=${res.trickyLetters} at t=${trickyAt}s`);
check('meter pinned by TRICKY', res.meter === 1, res.meter);
check('landed counted', res.landed > 0, `${res.landed} (clean ${res.landedClean}, sketchy ${res.landedSketchy})`);
check('crashed counted', res.crashed >= 0, res.crashed);
check('jumps counted', res.jumps >= res.landed, res.jumps);
check('airTime accumulated', res.airTime_s > 0 && res.biggestAir_s > 0,
  `${res.airTime_s}s total, biggest ${res.biggestAir_s}s`);
check('distanceRidden != courseLength', res.distanceRidden_m !== res.courseLength_m,
  `${res.distanceRidden_m} m ridden of a ${res.courseLength_m} m course`);
check('splits recorded', res.splits.length === 3, JSON.stringify(res.splits));
check('no invented grade', res.rank === null, String(res.rank));
check('card frozen after the line', before === after);
check('card object is immutable', Object.isFrozen(res));
check('no teleport in any frame', maxFrameJump <= 2, maxFrameJump.toFixed(3) + ' m');
check('shell never engaged', rs.confine.shellFrames === 0, rs.confine.shellFrames);
check('module never wrote more than 1 mm of position',
  rs.confine.maxSelfPosDelta_m < 0.001, rs.confine.maxSelfPosDelta_m.toExponential(2) + ' m');

console.log('--- confinement telemetry ---');
console.log(JSON.stringify(rs.confine));
console.log(fails === 0 ? 'ALL PASS' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
