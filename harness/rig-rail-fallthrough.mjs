// ===========================================================================
// RIG RAIL FALL-THROUGH HARNESS — harness/rig-rail-fallthrough.mjs
//
// WHY THIS EXISTS
//   Every other rails test drives createRails + createPhysics on SYNTHETIC
//   FLAT rails. The user rides the REAL course: rails authored by
//   src/run/rails-course.mjs on top of the render lane's analytic terrain,
//   stepped in the order src/game/main.mjs uses:
//
//     physics.step(state, input, dt)            // integrates position
//     railSys.step(gstate, state, input, dt)    // writes velocity
//
//   Same four real pieces as the running game:
//     sampleHeight  <- src/render/main.mjs      (the terrain the renderer draws)
//     buildRails    <- src/run/rails-course.mjs (the 9 authored rails)
//     createRails   <- src/rails/rails.mjs
//     createPhysics <- src/physics/physics.mjs
//
// AXES
//   rail    0..8            the nine authored rails
//   speed   12 / 18 / 25    m/s of entry speed
//   offset  0 / +-0.3 / +-0.7 m lateral miss at the lead-in
//   entry   'ground'        rides on from the snow (onGround === true)
//           'air'           drops onto it from above (onGround === false),
//                           which is how you reach a rail off a roller
//   input   'none'          no stick at all
//           'oracle'        cancels the known load + texture, damps the
//                           divergent mode. Not a player model — it isolates
//                           "does she stay ON the rail geometrically" from
//                           "does she topple", so a geometric fall-through
//                           cannot hide behind a bail.
//           'player'        THE SAME INTENT AS THE ORACLE, delivered through
//                           the SHIPPED ROUTER — applyStick() from
//                           src/game/input.mjs, the one function index.html
//                           and src/game/main.mjs call. This model imports the
//                           routing rather than restating it, so the rig gates
//                           the real code path and not a copy of it. If the
//                           router ever goes back to asking `onGround` first,
//                           this axis starves and this file exits 1.
//
// FALL-THROUGH is defined explicitly, in numbers, not by eye:
//   (a) SINK       dy = rider.y - railY < -SINK_TOL while gs.onRail is true
//   (b) UNEXPLAINED  she leaves the rail with bailed === false and not at
//                    either end
//   (c) PASSTHROUGH  she crosses the DRAWN rail tube from above to below
//                    (horizontal distance <= TUBE_R + BOARD_HALF_W) without
//                    ever locking on — the rail has no collision of its own,
//                    so a refused capture means the rider goes straight
//                    through the thing she can see.
//   (d) STARVED    a locked PLAYER attempt whose stick never reached the
//                  balance channel (input.steer) on a single on-rail frame.
//                  rails.mjs reads only inp.steer for balance authority, so a
//                  starved grind runs the divergent mode with steer === 0 and
//                  toppling is arithmetic, not bad luck. This is the one that
//                  reproduces the user report; (a)-(c) do not.
//                  MEASURED, before the fix: 357 / 690 locks starved; of the
//                  230 player locks, the 119 that captured with the frozen
//                  onGround flag false bailed 118 times, median 12.40 m
//                  (40.7 ft) in, then dropped a median 0.56 m onto the snow
//                  under the rail line and kept riding — silently, because
//                  gs.bailed has no reader in src/.
//                  NOTE the definition is DELIVERY, not the flag. Gating on
//                  "locked while onGround === false" would be a proxy: it can
//                  be satisfied by changing what the flag says instead of by
//                  getting the stick to the rider.
//   (e) BAIL-PARITY  a locked player attempt that BAILS where the oracle —
//                  the identical intent, delivered straight to input.steer —
//                  does not. The two differ only in routing, so any gap is
//                  the router losing the player's input.
//
// Run:  node harness/rig-rail-fallthrough.mjs [--json] [--trace R,SPD,OFF,ENTRY,INPUT]
// Exit code 1 if any fall-through is detected, so this file can gate a fix.
// ===========================================================================

import { sampleHeight } from '../src/render/main.mjs';
import { buildRails } from '../src/run/rails-course.mjs';
import { createRails } from '../src/rails/rails.mjs';
import { createPhysics } from '../src/physics/physics.mjs';

// The router under test. SG_ROUTER_MODULE lets harness/rail-mutants.mjs point
// this at a MUTATED copy of src/game/input.mjs without writing into the tree —
// that is how "the rig would catch a regression here" stops being a claim and
// becomes a measurement. Unset (the normal case) it is the shipped file.
const { applyStick } = await import(
  process.env.SG_ROUTER_MODULE || new URL('../src/game/input.mjs', import.meta.url).href);

const FIXED_DT = 1 / 60;
const SINK_TOL = 0.05;        // m below the drawn rail line, while locked
const TUBE_R = 0.11;          // render/main.mjs: tube(r.points, 0.11, STEEL)
const BOARD_HALF_W = 0.15;    // game/main.mjs rider board BoxGeometry z = 0.30
const HIT_R = TUBE_R + BOARD_HALF_W;   // 0.26 m — board overlaps the drawn tube
const MAX_FRAMES = 900;       // 15 s per attempt
const APPROACH_M = 8;         // metres of run-in before the rail start

// The course line, byte-identical to src/render/main.mjs centerX() (the render
// module does not export it) and to the copy in src/game/main.mjs.
function centerX(z) {
  return 150 * Math.sin(z * 0.0032) + 65 * Math.sin(z * 0.0011 + 1.7);
}

const railGeom = buildRails(sampleHeight, centerX);

// ---------------------------------------------------------------- geometry
// Closest point on a rail polyline by HORIZONTAL distance — the same measure
// createRails uses, so "the rail height under the rider" means the same thing
// here as it does inside the module.
function closestOnRail(points, x, z) {
  let best = null, acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1e-9;
    const den = dx * dx + dz * dz;
    const u = den > 1e-12
      ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / den)) : 0;
    const px = a[0] + dx * u, pz = a[2] + dz * u, py = a[1] + dy * u;
    const d = Math.hypot(x - px, z - pz);
    if (!best || d < best.d) best = { d, px, py, pz, s: acc + L * u };
    acc += L;
  }
  return best;
}
function railTotal(points) {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    acc += Math.hypot(points[i + 1][0] - points[i][0],
                      points[i + 1][1] - points[i][1],
                      points[i + 1][2] - points[i][2]);
  }
  return acc;
}

// The player's stick, delivered by THE SHIPPED ROUTER. The INTENT is identical
// to the oracle's, byte for byte; the only thing under test is where
// applyStick() puts it. Nothing about the routing is restated here — this
// calls src/game/input.mjs, the same function index.html and the scripted demo
// call, so a regression in that file fails this rig instead of hiding from it.
function playerInput(st, gs) {
  const input = {};
  if (!gs.onRail) return input;                 // no stick until she is on it
  const want = Math.max(-1, Math.min(1,
    (gs._load ?? 0) + (gs._tex ?? 0) + 2.2 * gs.balance));
  applyStick(input, st, want);
  return input;
}

// ---------------------------------------------------------------- one attempt
export function attempt({ railIndex, speed, offset, entry = 'ground',
                          input: inputModel = 'none', trace = false,
                          dropHeight = 2.5 }) {
  const rail = railGeom[railIndex];
  const P = rail.points;
  const total = railTotal(P);

  // Aim her along the rail's own lead-in direction, displaced `offset` along
  // the rail's left normal.
  const hx = P[1][0] - P[0][0], hz = P[1][2] - P[0][2];
  const hl = Math.hypot(hx, hz) || 1;
  const tx = hx / hl, tz = hz / hl;
  const nx = -tz, nz = tx;

  const physics = createPhysics({ sampleHeight, surface: 'snow' });
  const railSys = createRails({ sampleHeight, surface: 'snow', rails: railGeom });

  let st;
  if (entry === 'ground') {
    const sx = P[0][0] - tx * APPROACH_M + nx * offset;
    const sz = P[0][2] - tz * APPROACH_M + nz * offset;
    st = physics.init([sx, sampleHeight(sx, sz), sz],
                      [tx * speed, 0, tz * speed], Math.atan2(tz, tx));
  } else {
    // Airborne drop-in: released `dropHeight` above the rail, `APPROACH_M`
    // short of its start, on a ballistic arc that puts her onto the rail line.
    const sx = P[0][0] - tx * APPROACH_M + nx * offset;
    const sz = P[0][2] - tz * APPROACH_M + nz * offset;
    const tFall = APPROACH_M / speed;
    const vy0 = -(dropHeight / tFall) + 0.5 * 9.81 * tFall;   // arrive at rail Y
    st = physics.init([sx, P[0][1] + dropHeight, sz],
                      [tx * speed, vy0, tz * speed], Math.atan2(tz, tx));
    st.onGround = false;
  }
  const gs = railSys.init();

  const rec = {
    rail: rail.id, railIndex, speed, offset, entry, input: inputModel,
    locked: false, lockFrame: -1, lockS: 0, lockOnGround: null,
    frames: 0, seconds: 0, alongTravelled: 0,
    exitReason: null, exitFrame: -1, exitS: 0, exitSpeed: 0, exitBalance: 0,
    minDy: Infinity, minDyFrame: -1, minDyS: 0, maxHorizErr: 0,
    sinkFrame: -1, sinkDy: 0, sinkS: 0,
    passThrough: false, passFrame: -1, passHoriz: 0, passS: 0, passDyBefore: 0,
    passDyAfter: 0,
    railTotal: total, steerSeenOnRail: false, spinSeenOnRail: false,
    samples: [],
  };

  let prevOn = false, lastS = 0, lastBal = 0, prevDy = null, prevHoriz = null;
  for (let f = 0; f < MAX_FRAMES; f++) {
    let input = {};
    if (inputModel === 'oracle' && gs.onRail) {
      input.steer = Math.max(-1, Math.min(1,
        (gs._load ?? 0) + (gs._tex ?? 0) + 2.2 * gs.balance));
    } else if (inputModel === 'player') {
      input = playerInput(st, gs);
    }
    if (gs.onRail) {
      if (input.steer !== undefined) rec.steerSeenOnRail = true;
      if (input.spin !== undefined) rec.spinSeenOnRail = true;
    }

    // ---- the exact src/game/main.mjs advance() order ----
    physics.step(st, input, FIXED_DT);
    railSys.step(gs, st, input, FIXED_DT);

    const c = closestOnRail(P, st.pos[0], st.pos[2]);
    const dy = st.pos[1] - c.py;

    if (gs.onRail) {
      if (!prevOn) {
        rec.locked = true; rec.lockFrame = f; rec.lockS = gs._s;
        rec.lockOnGround = st.onGround;
      }
      rec.frames++;
      if (dy < rec.minDy) { rec.minDy = dy; rec.minDyFrame = f; rec.minDyS = gs._s; }
      if (c.d > rec.maxHorizErr) rec.maxHorizErr = c.d;
      if (dy < -SINK_TOL && rec.sinkFrame < 0) {
        rec.sinkFrame = f; rec.sinkDy = dy; rec.sinkS = gs._s;
      }
      lastS = gs._s; lastBal = gs.balance;
    } else {
      // (c) PASSTHROUGH: crossed the drawn tube top-to-bottom without locking.
      if (!rec.locked && !rec.passThrough && prevDy !== null
          && prevDy > 0 && dy < 0 && c.d <= HIT_R && prevHoriz <= HIT_R + 0.4) {
        rec.passThrough = true; rec.passFrame = f; rec.passHoriz = c.d;
        rec.passS = c.s; rec.passDyBefore = prevDy; rec.passDyAfter = dy;
      }
      if (prevOn) {
        // gs._s advances on the release frame too, so read IT rather than the
        // value cached while she was still flagged onRail (one frame of lag is
        // 0.4 m at 25 m/s and mis-files every end-of-rail as unexplained).
        const sExit = gs._s;
        rec.exitFrame = f; rec.exitS = sExit; rec.exitSpeed = gs.lastLeaveSpeed;
        rec.alongTravelled = Math.abs(sExit - rec.lockS);
        rec.seconds = rec.frames * FIXED_DT;
        const atEnd = sExit >= total - 0.05 || sExit <= 0.05;
        rec.exitReason = gs.bailed ? 'BAIL' : (atEnd ? 'END' : 'UNEXPLAINED');
        rec.exitBalance = lastBal;
        // ---- what happens AFTER she leaves ----
        let minD = dy;
        rec.postExit = { dropBelowRail_m: 0, dropFrames: 0, wentAirborne: false,
                         terrainGapAtExit_m: st.pos[1] - sampleHeight(st.pos[0], st.pos[2]) };
        for (let g = 0; g < 120; g++) {
          physics.step(st, {}, FIXED_DT);
          railSys.step(gs, st, {}, FIXED_DT);
          if (gs.onRail) break;
          if (!st.onGround) rec.postExit.wentAirborne = true;
          const d2 = st.pos[1] - closestOnRail(P, st.pos[0], st.pos[2]).py;
          if (d2 < minD) { minD = d2; rec.postExit.dropFrames = g + 1; }
        }
        rec.postExit.dropBelowRail_m = -minD;
        break;
      }
    }
    if (trace) {
      rec.samples.push({
        f, onRail: gs.onRail, onGround: st.onGround,
        s: +(gs._s ?? 0).toFixed(3),
        y: +st.pos[1].toFixed(4), railY: +c.py.toFixed(4), dy: +dy.toFixed(4),
        horiz: +c.d.toFixed(4), bal: +gs.balance.toFixed(4),
        along: +gs.alongSpeed.toFixed(3), vy: +st.vel[1].toFixed(3),
      });
    }
    prevOn = gs.onRail; prevDy = dy; prevHoriz = c.d;
    if (!gs.onRail && st.pos[2] > P[P.length - 1][2] + 40) break;
  }
  if (rec.locked && rec.exitReason === null) {
    rec.exitReason = 'STILL_ON_AT_TIMEOUT';
    rec.alongTravelled = Math.abs(lastS - rec.lockS);
    rec.seconds = rec.frames * FIXED_DT;
    rec.exitS = lastS;
  }
  if (!rec.locked) rec.exitReason = rec.passThrough ? 'PASSTHROUGH' : 'NO_LOCK';
  if (rec.minDy === Infinity) rec.minDy = NaN;
  rec.fellThrough = rec.sinkFrame >= 0 || rec.exitReason === 'UNEXPLAINED'
                 || rec.passThrough;
  // (d) the balance stick never reached the rider for the whole grind.
  // DELIVERY, measured on the frames she was actually on the rail — not the
  // value of a flag, which a fix could satisfy without moving the stick.
  rec.starved = rec.locked && inputModel === 'player' && !rec.steerSeenOnRail;
  return rec;
}

// ---------------------------------------------------------------- sweep
const SPEEDS = [12, 18, 25];
const OFFSETS = [0, 0.3, -0.3, 0.7, -0.7];
const CASES = [
  { entry: 'ground', input: 'none' },
  { entry: 'ground', input: 'oracle' },
  { entry: 'ground', input: 'player' },
  { entry: 'air', input: 'none' },
  { entry: 'air', input: 'oracle' },
  { entry: 'air', input: 'player' },
];

export function sweep() {
  const out = [];
  for (let r = 0; r < railGeom.length; r++)
    for (const cse of CASES)
      for (const speed of SPEEDS)
        for (const offset of OFFSETS)
          out.push(attempt({ railIndex: r, speed, offset, ...cse }));
  return out;
}

export { railGeom, closestOnRail, railTotal, SINK_TOL, HIT_R, playerInput, centerX };

// ---------------------------------------------------------------- cli
const isMain = process.argv[1] && process.argv[1].endsWith('rig-rail-fallthrough.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf('--trace');
  if (ti >= 0) {
    const [ri, sp, off, entry, inp] = argv[ti + 1].split(',');
    const rec = attempt({ railIndex: +ri, speed: +sp, offset: +off,
                          entry: entry || 'ground', input: inp || 'none',
                          trace: true });
    console.log(JSON.stringify({ ...rec, samples: undefined }, null, 2));
    const s = rec.samples;
    console.log('frame onRail onGnd    s        y       railY      dy     horiz    bal    along     vy');
    for (const e of s) {
      console.log(String(e.f).padStart(5), String(e.onRail).padStart(6),
        String(e.onGround).padStart(6), String(e.s).padStart(7),
        String(e.y).padStart(9), String(e.railY).padStart(9),
        String(e.dy).padStart(8), String(e.horiz).padStart(7),
        String(e.bal).padStart(7), String(e.along).padStart(7),
        String(e.vy).padStart(7));
    }
    process.exit(0);
  }

  const res = sweep();
  if (argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); }
  else {
    console.log('rail  entry  input   spd  off    lock  frames  sec    along_m  exit             minDy   maxHoriz');
    for (const r of res) console.log(
      r.rail.padEnd(6), r.entry.padEnd(6), r.input.padEnd(7),
      String(r.speed).padStart(3), String(r.offset).padStart(5),
      String(r.locked).padStart(6), String(r.frames).padStart(6),
      r.seconds.toFixed(2).padStart(6), r.alongTravelled.toFixed(2).padStart(8),
      String(r.exitReason).padEnd(18),
      (Number.isFinite(r.minDy) ? r.minDy.toFixed(4) : 'n/a').padStart(8),
      r.maxHorizErr.toFixed(4).padStart(8));
  }

  const by = (p) => res.filter(p);
  console.log('\n--- per case ---');
  console.log('entry  input    n   lock  pass  bail   end  medianAlong_m  medianSec');
  for (const c of CASES) {
    const g = by(r => r.entry === c.entry && r.input === c.input);
    const on = g.filter(r => r.locked);
    const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y);
      return b[Math.floor(b.length / 2)]; };
    console.log(c.entry.padEnd(6), c.input.padEnd(8), String(g.length).padStart(3),
      String(on.length).padStart(5),
      String(g.filter(r => r.passThrough).length).padStart(5),
      String(g.filter(r => r.exitReason === 'BAIL').length).padStart(5),
      String(g.filter(r => r.exitReason === 'END').length).padStart(5),
      med(on.map(r => r.alongTravelled)).toFixed(2).padStart(14),
      med(on.map(r => r.seconds)).toFixed(2).padStart(10),
      '  onGroundAtLock=' + (on.length ? on.filter(r => r.lockOnGround).length + '/' + on.length : '-'),
      ' steerReached=' + on.filter(r => r.steerSeenOnRail).length,
      ' spinInstead=' + on.filter(r => r.spinSeenOnRail).length,
      ' medDropAfterExit=' + med(on.filter(r => r.postExit).map(r => r.postExit.dropBelowRail_m)).toFixed(2) + 'm');
  }

  const starved = res.filter(r => r.starved);
  const pl = res.filter(r => r.input === 'player' && r.locked);
  const plS = pl.filter(r => r.starved), plG = pl.filter(r => !r.starved);
  const med = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y);
    return b[Math.floor(b.length / 2)]; };
  console.log('\n--- (d) STARVED: the balance stick never reached input.steer ---');
  console.log(' player locks FED    :', plG.length,
    'bail', plG.filter(r => r.exitReason === 'BAIL').length,
    'end', plG.filter(r => r.exitReason === 'END').length,
    '| median along', med(plG.map(r => r.alongTravelled)).toFixed(2), 'm',
    '| lockOnGround true', plG.filter(r => r.lockOnGround).length, 'false',
    plG.filter(r => r.lockOnGround === false).length);
  console.log(' player locks STARVED:', plS.length,
    'bail', plS.filter(r => r.exitReason === 'BAIL').length,
    'end', plS.filter(r => r.exitReason === 'END').length,
    '| median along', med(plS.map(r => r.alongTravelled)).toFixed(2), 'm',
    '| sent as spin instead', plS.filter(r => r.spinSeenOnRail).length,
    '| median drop below the rail after that bail',
    med(plS.filter(r => r.postExit).map(r => r.postExit.dropBelowRail_m)).toFixed(2), 'm');

  // ---- (e) BAIL PARITY: player routing vs oracle, case for identical case ----
  // Same intent, same rail, same speed, same offset, same entry. The ONLY
  // difference is which input channel applyStick() writes. Any case the player
  // bails and the oracle does not is the router losing the rider's stick.
  const key = (r) => `${r.railIndex}|${r.speed}|${r.offset}|${r.entry}`;
  const oracleBy = new Map(res.filter(r => r.input === 'oracle').map(r => [key(r), r]));
  const parity = [];
  for (const r of res.filter(x => x.input === 'player')) {
    const o = oracleBy.get(key(r));
    if (!o) continue;
    if (r.exitReason === 'BAIL' && o.exitReason !== 'BAIL') parity.push({ r, o });
  }
  console.log('\n--- (e) BAIL PARITY: player bails where the oracle does not ---');
  console.log(' player locks', pl.length,
    '| player bails', pl.filter(r => r.exitReason === 'BAIL').length,
    '| oracle bails', res.filter(r => r.input === 'oracle' && r.locked
      && r.exitReason === 'BAIL').length,
    '| PARITY BREAKS', parity.length);
  for (const { r, o } of parity) console.log(
    `  ${r.rail} ${r.entry} v=${r.speed} off=${r.offset}: player BAIL at`,
    `${r.alongTravelled.toFixed(2)} m / ${r.seconds.toFixed(2)} s, oracle`,
    `${o.exitReason} at ${o.alongTravelled.toFixed(2)} m`,
    `| steerReached=${r.steerSeenOnRail} spinInstead=${r.spinSeenOnRail}`);

  const bad = res.filter(r => r.fellThrough);
  console.log('\nattempts', res.length,
    '| locked', res.filter(r => r.locked).length,
    '| FELL-THROUGH', bad.length,
    '| passThrough', res.filter(r => r.passThrough).length,
    '| sink', res.filter(r => r.sinkFrame >= 0).length,
    '| unexplained', res.filter(r => r.exitReason === 'UNEXPLAINED').length,
    '| bail', res.filter(r => r.exitReason === 'BAIL').length,
    '| end', res.filter(r => r.exitReason === 'END').length,
    '| STARVED', starved.length,
    '| PARITY BREAKS', parity.length);
  if (bad.length) {
    console.log('\nFALL-THROUGH DETAIL:');
    for (const r of bad) console.log(
      ` ${r.rail} ${r.entry}/${r.input} v=${r.speed} off=${r.offset}`,
      r.passThrough
        ? `PASSTHROUGH f=${r.passFrame} horiz=${r.passHoriz.toFixed(3)}m s=${r.passS.toFixed(1)}m dy ${r.passDyBefore.toFixed(3)} -> ${r.passDyAfter.toFixed(3)}`
        : `SINK f=${r.sinkFrame} dy=${r.sinkDy.toFixed(3)} s=${r.sinkS.toFixed(2)} exit=${r.exitReason}`);
  }
  if (bad.length || starved.length || parity.length) {
    console.log('\nFAIL:', bad.length, 'geometric fall-through,',
      starved.length, 'starved locks (the balance stick never reached',
      'input.steer on a single on-rail frame),',
      parity.length, 'bail-parity breaks (player bails where the same intent',
      'delivered straight to input.steer does not).');
    process.exit(1);
  }
  console.log('\nPASS');
}
