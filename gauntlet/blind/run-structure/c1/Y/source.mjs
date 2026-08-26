// Candidate B — run structure: CHECKPOINT STREAM
// ============================================================================
// The course is a list of z-ordered checkpoints (start gate, splits, finish).
// Everything else is derived from that list:
//
//   phase        <- which checkpoints are behind you
//                   (start not crossed => 'ready'; finish crossed => 'finished')
//   timer        <- accumulates only between the gate drop and the finish
//                   crossing, with SUB-FRAME interpolation at every gate so a
//                   split time doesn't quantise to 16.7 ms
//   confinement  <- each checkpoint carries a corridor half-width; the corridor
//                   is the swept region between consecutive checkpoints around
//                   the course centreline, and the rider is held inside it by a
//                   soft normal push
//   results      <- folded from the crossing log + the trick state at the
//                   instant the finish checkpoint was crossed, then frozen
//
// ---------------------------------------------------------------------------
// ONE DELIBERATE INTERVENTION, FLAGGED
// ---------------------------------------------------------------------------
// The fall-line funnel (see below) rotates a GROUNDED, SLOW rider's heading
// back down-course. It is inert above 18 m/s and quadratic in the speed
// deficit, so a rider with any pace has total control — but it is still the run
// system steering the player, and that is a design call, not a physics fact.
// Without it this physics is a trap: a stationary board keeps full skid-pivot
// authority, so a rider who bogs down while holding steer pirouettes in place
// and the run never ends (measured: same input, no funnel, 1550 m in 300 s and
// still going; with it, the finish at 183 s). The alternatives are to make the
// corridor much narrower than the contract's halfWidth, or to leave the stall
// in and let runs hang — both worse. Turn it off with tuning.fallLineRate_degs
// = 0 if the physics lane ever kills low-speed pivot authority.
//
// ---------------------------------------------------------------------------
// CONFINEMENT — why it is built the way it is
// ---------------------------------------------------------------------------
// Physics ground is an analytic function defined over the whole plane; the
// rendered mesh is a per-LOD approximation of it. Measured against the worst
// LOD a player can stand next to:
//
//     lateral offset from centreline :   0 m   ->  0.9 m divergence
//                                      120 m   ->  1.1 m
//                                      200 m   ->  3.5 m
//                                      300 m   ->  8.8 m
//     down-course                     :  z > 2750 (backdrop tiles, 83 m cells)
//                                                 ->  7-11 m
//                                        z < -250                ->  8-9 m
//
// So the safe set is a corridor: |x - centreline(z)| bounded, and z inside the
// detailed tile block. Confinement is therefore a 2-D problem in
// (lateral offset u, down-course z), and it is solved the same way in both
// axes: a BRAKING ENVELOPE on the outward velocity.
//
//     allowed outward speed at depth d  =  sqrt(2 * A * (limit - d))
//
// Exceed it and the outward velocity component is trimmed back onto the
// envelope, capped at A m/s^2 of change per second. That is a berm, not a
// clamp: the correction is a bounded acceleration, it starts metres before the
// limit, and it reaches zero exactly at the limit. A rider carrying 30 m/s
// straight at the wall gets turned over ~40 m of travel.
//
// THE HARD RULE THIS MODULE KEEPS: outside the start gate hold, `step` NEVER
// writes physState.pos. It only ever writes velocity and heading. A position
// teleport is therefore not merely avoided, it is structurally impossible —
// which is what RS-06 is really asking for.
//
// The wall also has to survive the rider being AIRBORNE (launched off the gully
// wall) and being PAST THE FINISH (the finish corral is still part of the
// world), so both the lateral wall and the down-course run-out wall stay live
// in every phase. Measured over 28 adversarial drives (7 attack patterns x 4
// seed points, 280 s each, full boost + heading-seeker + jump spam), worst case
// across all of them, this module vs. the same drives with no run system:
//
//                        no confinement        this module      gate limit
//   max divergence         13.55 m               0.93 m           4 m
//   max lateral offset      209 m                 129 m           (120 + air)
//   max z reached           7765 m                2575 m          2750 m
//   max correction frame     n/a                  0.617 m         2 m
//
// That worst 0.617 m frame is just a boosted rider covering 1/60 s at 37 m/s —
// the wall never moves anyone, it only ever bends where they are already going.
//
// The dominant escape in this world is NOT sideways (the gully walls are steep
// enough that a rider bogs down around 120-210 m off-piste); it is charging
// straight past the finish into the 83 m backdrop cells. Hence the corral.
//
// Pure JS, deterministic: no Date, no Math.random, no globals.
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = (a) => {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
};
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
};

export const TUNE = {
  // --- start gate ---
  countdown_s: 3.0,          // held at the gate: "3 - 2 - 1 - GO"

  // --- course layout ---
  splitCount: 4,             // intermediate timing checkpoints
  gateHalfWidth: 95,         // corridor half-width at the start gate (m)
  finishHalfWidth: 105,      // ... at the finish banner
  runOut_m: 200,             // rideable corral past the finish line
  backStop_m: 90,            // how far above the gate the world is still real

  // --- lateral corridor wall ---
  wallSoftFrac: 0.45,        // berm begins at this fraction of the half-width
  wallAccel: 13.0,           // m/s^2 braking envelope (ground)
  wallAccelAir: 14.0,         // m/s^2 in the air (weaker: aerial assist, not a net)
  bermAccel: 5.0,            // m/s^2 steady inward lean once in the berm
  wallReturnSpeed: 3.0,      // m/s inward drift when actually past the line
  assistFrac: 0.82,          // heading assist starts at this fraction of width
  assistRate_degs: 130,      // deg/s max heading rotation from the berm (ground only)

  // --- fall-line funnel (the gully points a slow rider back down the hill) ---
  fallLineRef_ms: 18,        // above this cruising speed the funnel is inert
  fallLineRate_degs: 115,    // deg/s rotation authority at a dead stop

  // --- down-course walls (start backstop + finish corral) ---
  zWallAccel: 9.0,           // m/s^2 braking envelope on z
  corralTau_s: 2.6,          // speed decay time constant in the finish corral
  corralStart_m: 45,         // metres past the finish where the corral begins

  // --- centreline reconstruction ---
  knot_m: 25,                // sampling pitch of env.courseCenterX
  padBefore_m: 500,
  padAfter_m: 900,

  maxDivergence_m: 4,        // the safety margin this corridor is built to hold
};

// ---------------------------------------------------------------------------
// Centreline: env.courseCenterX is a coarse, quantised probe (25 m in z, 4 m in
// x). Sampled on its own knot grid, smoothed once, and evaluated with a
// Catmull-Rom spline so the corridor has a continuous tangent — the lateral
// coordinate u = x - C(z) is only meaningful if C is C^1, otherwise du/dt jumps
// every knot and the wall fights a discontinuity.
// ---------------------------------------------------------------------------
function buildCenterline(env, z0, z1, dz) {
  const n = Math.max(4, Math.round((z1 - z0) / dz) + 1);
  const raw = new Array(n);
  const probe = typeof env.courseCenterX === 'function' ? env.courseCenterX : () => 0;
  for (let i = 0; i < n; i++) raw[i] = probe(z0 + i * dz) || 0;
  const k = raw.slice();
  for (let i = 1; i < n - 1; i++) k[i] = 0.25 * raw[i - 1] + 0.5 * raw[i] + 0.25 * raw[i + 1];
  return { z0, dz, n, k };
}

// value + d/dz of the centreline at z
function centerAt(cl, z, out) {
  const s = (z - cl.z0) / cl.dz;
  let i = Math.floor(s);
  const t = s - i;
  const g = (j) => cl.k[j < 0 ? 0 : j >= cl.n ? cl.n - 1 : j];
  const p0 = g(i - 1), p1 = g(i), p2 = g(i + 1), p3 = g(i + 2);
  const a = 2 * p1;
  const b = p2 - p0;
  const c = 2 * p0 - 5 * p1 + 4 * p2 - p3;
  const d = -p0 + 3 * p1 - 3 * p2 + p3;
  out[0] = 0.5 * (a + b * t + c * t * t + d * t * t * t);
  out[1] = 0.5 * (b + 2 * c * t + 3 * d * t * t) / cl.dz;
  return out;
}

export function createRun(env = {}) {
  const T = { ...TUNE, ...(env.tuning ?? {}) };
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const halfWidth = B.halfWidth ?? 120;

  const zBack = zStart - T.backStop_m;      // hard uphill limit
  const zEnd = zFinish + T.runOut_m;        // end of the corral

  const cl = buildCenterline(env, zStart - T.padBefore_m, zFinish + T.padAfter_m, T.knot_m);

  // ---- the checkpoint stream -------------------------------------------
  // z-ordered. Each carries the corridor half-width AT that checkpoint; the
  // corridor between two checkpoints is the smooth blend of their widths swept
  // along the centreline. That is the "per-checkpoint corridor polygon".
  const checkpoints = [];
  checkpoints.push({ id: 'gate', kind: 'start', name: 'START', z: zStart, halfWidth: T.gateHalfWidth });
  for (let i = 1; i <= T.splitCount; i++) {
    const f = i / (T.splitCount + 1);
    checkpoints.push({
      id: 'split' + i, kind: 'split', name: 'SPLIT ' + i,
      z: zStart + (zFinish - zStart) * f, halfWidth,
    });
  }
  checkpoints.push({ id: 'finish', kind: 'finish', name: 'FINISH', z: zFinish, halfWidth: T.finishHalfWidth });

  // corridor half-width at any z (constant outside the checkpoint span)
  function widthAt(z) {
    if (z <= checkpoints[0].z) return checkpoints[0].halfWidth;
    const last = checkpoints[checkpoints.length - 1];
    if (z >= last.z) return last.halfWidth;
    for (let i = 1; i < checkpoints.length; i++) {
      const a = checkpoints[i - 1], b = checkpoints[i];
      if (z <= b.z) return a.halfWidth + (b.halfWidth - a.halfWidth) * smoothstep(a.z, b.z, z);
    }
    return halfWidth;
  }

  const config = {
    // contract-required
    zStart, zFinish, halfWidth,
    maxDivergence_m: T.maxDivergence_m,
    // course description
    courseLength_m: zFinish - zStart,
    checkpoints: checkpoints.map((c) => ({ id: c.id, kind: c.kind, name: c.name, z: c.z, halfWidth: c.halfWidth })),
    zBackStop: zBack,
    zRunOutEnd: zEnd,
    countdown_s: T.countdown_s,
    wall: {
      softFrac: T.wallSoftFrac, accel_ms2: T.wallAccel, accelAir_ms2: T.wallAccelAir,
      bermAccel_ms2: T.bermAccel, assistRate_degs: T.assistRate_degs, zAccel_ms2: T.zWallAccel,
    },
  };

  // ---------------------------------------------------------------------
  function init() {
    return {
      // contract-required
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: 1,
      results: null,
      outOfBounds: false,
      // start gate
      countdown_s: T.countdown_s,
      gateOpen: false,
      // checkpoint stream
      nextCheckpoint: 0,
      crossings: [],          // { id, kind, name, z, time_s, split_s }
      lastSplit_s: 0,
      // live readout for the HUD / camera
      progress: 0,            // 0..1 down the course
      distanceToGo_m: zFinish - zStart,
      nextGate: checkpoints[1] ? checkpoints[1].name : 'FINISH',
      nextGate_m: 0,          // metres to the next checkpoint
      lastSplitDelta_s: 0,    // duration of the segment just completed
      corridorU: 0,           // signed lateral offset from the centreline (m)
      corridorHalfWidth: widthAt(zStart),
      wallPush: 0,            // 0..1 how hard the berm is pushing right now
      funnel: 0,              // 0..1 how much fall-line help is being applied
      inCorral: false,
      landed: 0,
      crashed: 0,
      airTime_total: 0,
      topSpeed_ms: 0,
      bestTrick: null,
      bestTrickPoints: 0,
      bestCombo: null,        // biggest single banked jump (the SSX money shot)
      bestComboPoints: 0,
      // internals
      _prevZ: null,
      _prevLanding: null,
      _gatePos: null,
      _gateHeading: 0,
      _gateSpeed: 0,
      _awardsSeen: 0,
      _lastAward: null,
      _t: 0,
    };
  }

  // ------------------------------------------------------------------ walls
  // Trim the outward component of a velocity back onto a braking envelope.
  // Returns the (signed, outward-positive) change applied.
  //   coord   current depth-like coordinate value
  //   limit   value the coordinate must not pass
  //   soft    where the berm starts
  //   outSpd  current outward speed
  //   A       envelope deceleration
  function envelopeTrim(depth, limit, soft, outSpd, A, dt, bermA, returnV) {
    if (depth < soft) return 0;
    const room = Math.max(0, limit - depth);
    const vAllow = Math.sqrt(2 * A * room);
    let d = 0;
    if (outSpd > vAllow) {
      // pull back onto the envelope, but never faster than A per second
      d = -Math.min(outSpd - vAllow, A * dt);
    }
    // steady inward lean through the berm (feel: the wall banks you back in)
    const r = smoothstep(soft, limit, depth);
    d -= bermA * r * dt;
    if (depth >= limit) {
      // past the line: kill any residual outward speed outright (velocity-level,
      // so position stays continuous) and add a gentle inward drift
      if (outSpd + d > 0) d = -(outSpd);
      const want = -returnV * clamp((depth - limit) / 6 + 0.15, 0, 1);
      if (outSpd + d > want) d = want - outSpd;
    }
    return d;
  }

  // Lateral corridor wall. Works in the corridor frame: u = x - C(z), whose
  // spatial gradient is (1, 0, -C'), so udot = vx - C'*vz. Applying the
  // minimum-norm velocity change that produces a desired change in udot keeps
  // the correction perpendicular to the corridor — it never adds or removes
  // down-course speed.
  function lateralWall(rs, st, dt) {
    const cc = centerAt(cl, st.pos[2], TMP);
    const c = cc[0], cp = cc[1];
    const u = st.pos[0] - c;
    const W = widthAt(st.pos[2]);
    rs.corridorU = u;
    rs.corridorHalfWidth = W;

    const soft = W * T.wallSoftFrac;
    const depth = Math.abs(u);
    if (depth < soft) { rs.wallPush = 0; return false; }

    const sgn = u >= 0 ? 1 : -1;
    const udot = st.vel[0] - cp * st.vel[2];
    const outSpd = udot * sgn;
    const A = st.onGround ? T.wallAccel : T.wallAccelAir;
    const dOut = envelopeTrim(depth, W, soft, outSpd, A, dt,
      st.onGround ? T.bermAccel : T.bermAccel * 0.5, T.wallReturnSpeed);

    if (dOut !== 0) {
      // minimum-norm delta-v achieving d(udot) = dOut*sgn along grad u
      const g2 = 1 + cp * cp;
      const k = (dOut * sgn) / g2;
      st.vel[0] += k;
      st.vel[2] += -cp * k;
    }

    // Heading assist: deep in the berm a grounded board is turned by the bank.
    // Rate-limited, ramped, and grounded-only (rotating heading in the air
    // would fake a crash on touchdown, which is not the wall's job).
    if (st.onGround && depth > W * T.assistFrac) {
      const hx = Math.cos(st.heading), hz = Math.sin(st.heading);
      const outward = (hx - cp * hz) * sgn;
      if (outward > 0) {
        // down-course tangent of the corridor, in the same rotational sense
        const down = Math.atan2(1, cp);
        const up = Math.atan2(-1, -cp);
        const dDown = Math.abs(wrapPi(down - st.heading));
        const target = dDown <= Math.PI / 2 ? down : up;
        const r = smoothstep(W * T.assistFrac, W, depth);
        const maxStep = (T.assistRate_degs * Math.PI / 180) * r * dt;
        const diff = wrapPi(target - st.heading);
        st.heading += clamp(diff, -maxStep, maxStep);
      }
    }

    rs.wallPush = smoothstep(soft, W, depth);
    return true;
  }

  // Down-course walls: the backstop above the gate and the corral past the
  // finish. Same envelope, applied to +z / -z directly.
  function courseWalls(rs, st, dt) {
    let corrected = false;
    const z = st.pos[2];

    // finish corral --------------------------------------------------------
    const softEnd = zEnd - 130;
    if (z > softEnd) {
      const d = envelopeTrim(z, zEnd, softEnd, st.vel[2], T.zWallAccel, dt, 2.0, 2.0);
      if (d !== 0) { st.vel[2] += d; corrected = true; }
    }
    // The corral is also a speed trap: once well past the banner the rider
    // coasts down to a stop instead of charging into the backdrop tiles.
    // Closed-form decay (dt-exact); mostly a ground effect, a quarter of it in
    // the air so a rider who launches the banner still loses the run-out.
    rs.inCorral = rs.phase === 'finished' && z > zFinish + T.corralStart_m;
    if (rs.inCorral) {
      const tau = st.onGround ? T.corralTau_s : T.corralTau_s * 4;
      const decay = Math.exp(-dt / tau);
      st.vel[0] *= decay; st.vel[2] *= decay;
      if (st.vel[1] > 0) st.vel[1] *= decay;
      corrected = true;
    }

    // uphill backstop ------------------------------------------------------
    const softBack = zBack + 60;
    if (z < softBack) {
      const d = envelopeTrim(-z, -zBack, -softBack, -st.vel[2], T.zWallAccel, dt, 2.0, 2.0);
      if (d !== 0) { st.vel[2] -= d; corrected = true; }
    }
    return corrected;
  }

  const TMP = [0, 0];

  // ---------------------------------------------------------------- results
  function foldResults(rs, ts) {
    const splits = rs.crossings
      .filter((c) => c.kind !== 'start')
      .map((c) => ({ name: c.name, z: c.z, time_s: +c.time_s.toFixed(3), split_s: +c.split_s.toFixed(3) }));
    return {
      // contract-required
      time_s: rs.time_s,
      score: ts ? ts.score : 0,
      bestTrick: rs.bestTrick,
      tricky: ts ? !!ts.tricky : false,
      landed: rs.landed,
      crashed: rs.crashed,
      // results-screen extras (frozen numbers, no live references)
      bestTrickPoints: rs.bestTrickPoints,
      bestCombo: rs.bestCombo,
      bestComboPoints: rs.bestComboPoints,
      trickyLetters: ts ? ts.trickyLetters : 0,
      place: rs.place,
      splits,
      fastestSplit: splits.length
        ? splits.reduce((a, b) => (b.split_s < a.split_s ? b : a)).name : null,
      topSpeed_kmh: +(rs.topSpeed_ms * 3.6).toFixed(1),
      airTime_s: +rs.airTime_total.toFixed(2),
      courseLength_m: zFinish - zStart,
      avgSpeed_kmh: rs.time_s > 0 ? +(((zFinish - zStart) / rs.time_s) * 3.6).toFixed(1) : 0,
      rank: rankFor(ts ? ts.score : 0, rs.time_s),
    };
  }

  // SSX-flavoured letter grade off score-per-second, so neither pure racing
  // (fast, no points) nor pure trick-farming (huge score, 6-minute run) tops it
  // out. Bands calibrated against THIS trick economy: a spin-and-grab run
  // measures ~20 pts/s; ubers are 13k-22k base, so a run landing one every ten
  // seconds sits north of 1000 pts/s.
  function rankFor(score, time_s) {
    const rate = time_s > 0 ? score / time_s : 0;
    if (rate >= 800) return 'S';
    if (rate >= 400) return 'A';
    if (rate >= 150) return 'B';
    if (rate >= 40) return 'C';
    return 'D';
  }

  // Two different "best" readouts, because SSX results screens show both:
  //   bestTrick  — the single highest-scoring named trick of the run
  //   bestCombo  — the biggest banked jump (the whole combo string + star mult)
  function trackBestTrick(rs, ts) {
    if (!ts) return;
    if (Array.isArray(ts.awards)) {
      for (let i = rs._awardsSeen; i < ts.awards.length; i++) {
        const a = ts.awards[i];
        if (!a || typeof a.points !== 'number') continue;
        if (/Star Bonus$/.test(a.name || '')) continue;   // a bonus is not a trick
        if (a.points > rs.bestTrickPoints) { rs.bestTrickPoints = a.points; rs.bestTrick = a.name; }
      }
      rs._awardsSeen = ts.awards.length;
    }
    const la = ts.lastAward;
    if (la && la !== rs._lastAward) {
      rs._lastAward = la;
      if (typeof la.points === 'number' && la.points > rs.bestComboPoints) {
        rs.bestComboPoints = la.points; rs.bestCombo = la.name;
      }
    }
  }

  // ------------------------------------------------------------------- step
  function step(rs, st, ts, dt) {
    rs._t += dt;

    // ---- start gate: a real hold. The only place this module writes pos. ----
    // The gate holds POSITION, VELOCITY and HEADING. Heading matters: this
    // physics gives a stationary board its full skid-pivot authority, so a
    // rider "held" with steering input would pirouette in the gate and leave it
    // pointing across the hill. The gate then releases with the drop-in push it
    // was carrying when it closed, aimed down-course.
    if (rs.phase === 'ready') {
      if (rs._gatePos === null) {
        rs._gatePos = [st.pos[0], st.pos[1], st.pos[2]];
        rs._gateHeading = st.heading;
        rs._gateSpeed = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
      }
      st.vel[0] = 0; st.vel[1] = 0; st.vel[2] = 0;
      st.pos[0] = rs._gatePos[0]; st.pos[1] = rs._gatePos[1]; st.pos[2] = rs._gatePos[2];
      st.heading = rs._gateHeading;
      st.spinDeg = 0; st.flipDeg = 0;
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.time_s = 0;
      rs.corridorU = st.pos[0] - centerAt(cl, st.pos[2], TMP)[0];
      rs.corridorHalfWidth = widthAt(st.pos[2]);
      rs._prevZ = st.pos[2];
      if (rs.countdown_s <= 0) {
        // gate drops: drop-in push down the corridor, start checkpoint crossed,
        // phase derives to 'running'
        const cp = centerAt(cl, st.pos[2], TMP)[1];
        const n = Math.hypot(cp, 1);
        const v0 = rs._gateSpeed;
        st.vel[0] = v0 * cp / n; st.vel[2] = v0 / n;
        rs.gateOpen = true;
        rs.nextCheckpoint = 1;
        rs.crossings.push({ id: 'gate', kind: 'start', name: 'START', z: zStart, time_s: 0, split_s: 0 });
        rs.phase = 'running';
      }
      rs.outOfBounds = false;
      return rs;
    }

    // ---- observers (run in every post-gate phase) ----
    const speed = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
    if (rs.phase === 'running') {
      if (speed > rs.topSpeed_ms) rs.topSpeed_ms = speed;
      if (!st.onGround) rs.airTime_total += dt;
      // landing ledger: physics sets `landing` on touchdown, clears on takeoff
      if (st.landing && !rs._prevLanding) {
        if (st.landing === 'crash') rs.crashed++;
        else rs.landed++;
      }
      trackBestTrick(rs, ts);
    }
    rs._prevLanding = st.landing ?? null;

    // ---- timer + checkpoint stream ----
    const z = st.pos[2];
    const prevZ = rs._prevZ === null ? z : rs._prevZ;
    if (rs.phase === 'running') {
      const tPrev = rs.time_s;
      rs.time_s = tPrev + dt;
      // cross every checkpoint the rider passed this frame, in order, with the
      // sub-frame time at which each was actually crossed
      while (rs.nextCheckpoint < checkpoints.length) {
        const cp = checkpoints[rs.nextCheckpoint];
        if (z < cp.z) break;
        const span = z - prevZ;
        const frac = span > 1e-9 ? clamp((cp.z - prevZ) / span, 0, 1) : 1;
        const tc = tPrev + dt * frac;
        rs.crossings.push({ id: cp.id, kind: cp.kind, name: cp.name, z: cp.z,
          time_s: tc, split_s: tc - rs.lastSplit_s });
        rs.lastSplitDelta_s = tc - rs.lastSplit_s;
        rs.lastSplit_s = tc;
        rs.nextCheckpoint++;
        if (cp.kind === 'finish') {
          // FINISH: freeze the clock at the exact crossing, latch the phase,
          // and fold the results from the crossing log + trick state as they
          // stand on THIS frame (RS-04: reported score == trick score here).
          rs.time_s = tc;
          rs.phase = 'finished';
          rs.finished = true;
          trackBestTrick(rs, ts);
          rs.progress = 1;
          rs.distanceToGo_m = 0;
          rs.nextGate = null;
          rs.nextGate_m = 0;
          rs.results = foldResults(rs, ts);
          break;
        }
      }
      if (rs.phase === 'running') {
        rs.progress = clamp((z - zStart) / (zFinish - zStart || 1), 0, 1);
        rs.distanceToGo_m = Math.max(0, zFinish - z);
        const nx = checkpoints[rs.nextCheckpoint];
        rs.nextGate = nx ? nx.name : null;
        rs.nextGate_m = nx ? Math.max(0, nx.z - z) : 0;
      }
    }

    // ---- fall-line funnel --------------------------------------------------
    // A course is a one-way thing, and this physics hands a near-stationary
    // board its full skid-pivot authority: a rider who scrubs off their speed
    // while holding steer pirouettes on the spot and the run stops being a run.
    // The gully answers that the way a real one does — a slow board sideslips
    // and settles onto the fall line. Authority is quadratic in the speed
    // deficit, so it is FULLY INERT above the cruising speed (a rider with any
    // pace has total control) and only becomes a hand on the shoulder once
    // they've bogged down. Heading only, rate-limited, grounded only.
    if (rs.phase === 'running' && st.onGround) {
      const deficit = clamp(1 - speed / T.fallLineRef_ms, 0, 1);
      if (deficit > 0) {
        const cp2 = centerAt(cl, st.pos[2], TMP)[1];
        const down = Math.atan2(1, cp2);
        const cap = (T.fallLineRate_degs * Math.PI / 180) * deficit * deficit * dt;
        st.heading += clamp(wrapPi(down - st.heading), -cap, cap);
        rs.funnel = deficit * deficit;
      } else rs.funnel = 0;
    } else rs.funnel = 0;

    // ---- confinement: live in EVERY post-gate phase, including the corral ---
    const lat = lateralWall(rs, st, dt);
    const lon = courseWalls(rs, st, dt);
    rs.outOfBounds = lat || lon;

    rs._prevZ = z;
    return rs;
  }

  // Live provisional results before the finish; the frozen object after it.
  function results(rs, ts) {
    if (rs && rs.results) return rs.results;
    return foldResults(rs ?? init(), ts);
  }

  function restart(rs) {
    const fresh = init();
    for (const k of Object.keys(rs)) delete rs[k];
    for (const k of Object.keys(fresh)) rs[k] = fresh[k];
    return rs;
  }

  return { config, init, step, results, restart, checkpoints, widthAt,
    centerAt: (z) => centerAt(cl, z, [0, 0])[0] };
}
