// ============================================================================
// run-structure candidate A — run.mjs
// Start gate, countdown, race clock, finish line, results card, restart, and
// CORRIDOR CONFINEMENT.
//
// Pure JS, deterministic. No Date, no Math.random, no globals. The module
// OBSERVES physics state and trick state. It writes rider VELOCITY (the
// corridor field and the gate hold), and rider POSITION in exactly two places:
// the start-gate hold, which corrects under a millimetre per frame, and the
// disclosed last-resort shell, which has never engaged on any drive measured.
// Both are self-measured every frame into rs.confine.maxSelfPosDelta_m. It
// never writes trick state, never writes physics collision state (onGround /
// airTime / landing / charge), and never steers: heading is the player's.
//
// ---------------------------------------------------------------------------
// 1. PHASE MACHINE (explicit states with entry/exit hooks)
//
//   stage:  'countdown' -> 'running' -> 'finished'          (internal detail)
//   phase:  'ready'     -> 'running' -> 'finished'          (contract field)
//
//   The contract fixes phase to ready/running/finished, so the countdown is a
//   SUB-STATE of 'ready', published as rs.stage / rs.countdown_s / rs.light
//   for the HUD rather than as a fourth phase value.
//
//   enterReady   : capture the gate pose (pos/vel/heading) once, arm the lights
//   tickReady    : GATE HOLD — the rider is pinned at the captured pose
//   exitReady    : GATE RELEASE — the recorded gate push is returned to the
//                  rider along their CURRENT heading (aim the board at the gate,
//                  leave in that direction), clock starts at exactly 0
//   tickRunning  : clock, telemetry, split checkpoints, confinement, finish test
//   exitRunning  : results assembled ONCE and frozen (same object forever after)
//   tickFinished : run-out — confinement continues, telemetry stops
//
// ---------------------------------------------------------------------------
// 2. CONFINEMENT — why, and what it is
//
//   Physics ground is an analytic function defined everywhere; the RENDERED
//   mesh is a per-LOD approximation of it. Measured on this terrain with the
//   runner's own divergence probe (|analytic - bilinear across the worst LOD
//   cell the player can be near|), sweeping z in [-40, 2600] at every lateral
//   offset:
//
//     offset from course centre :   0    120    160    190    200    240
//     worst mesh-vs-physics gap : 0.9 m  1.1 m  2.2 m  2.6 m  3.5 m  5.5 m
//
//     z < -250 or z > 2750 (the 1 km backdrop tiles, 83 m cells): 8.5-10 m
//     immediately, rising to ~77 m further out.
//
//   So the safe set is |offset| < ~200 m AND z in (-250, 2750). RS-05's 4 m
//   ceiling is met with room to spare by holding the rider inside a shell at
//   |offset| <= 190, z in [-150, 2700] — and the shell is the LAST layer, not
//   the first. Ordinary play never touches it.
//
//   The field is expressed in CORRIDOR COORDINATES, not world x/z:
//     s(z)  = x - courseCenterX(z)          signed lateral offset
//     n_hat = (1, -cx'(z)) / |..|           unit normal to the corridor wall
//     t_hat = (cx'(z), 1) / |..|            unit tangent along the corridor
//   The course meanders (cx' up to ~0.55), so a naive x-only push would brake
//   the rider's down-course progress every time it fired. Pushing along n_hat
//   changes the offset without touching progress along the course.
//
//   THREE LAYERS, all continuous:
//
//     BANK    |s| in [W_BANK, W] — a restoring ACCELERATION, quadratic in
//             depth: zero at the tree line, A_BANK at the corridor wall. It
//             applies only against a rider still moving OUTWARD, ramped over
//             LEAVE_REF so it is continuous rather than a switch: a bank
//             resists you leaving, it does not shove you once you have turned
//             back in. It shapes your line; it never takes the turn away.
//
//     WALL    |s| > W — a CONSTRAINT, not a spring. The component of velocity
//             trying to leave the course is removed, at a bounded rate
//             (<= A_MAX*dt in any one frame, so it is a rate-limited
//             projection and never an instantaneous clamp). A wall cannot pull
//             you in, only stop you going out, so a rider who carves into it
//             keeps the whole along-wall component of their speed and slides
//             down the course.
//
//             This replaces the spring-and-damper wall the first draft used.
//             A spring pushes the rider back ACROSS their own board and the
//             physics reads that as a reverse skid, so it removes far more
//             energy than stopping the escape requires. The choice is made on
//             that argument, NOT on a measured pace win: under the runner's
//             own probe drive the run is chaotic (section 6), and the spread
//             between wall models is inside the chaos. Claiming a speed win
//             from it would be reading noise.
//             (Cycle-2 mustFix 6 asked the other line to stop calling a
//             velocity clamp a berm — this is the berm, and the rate limit is
//             in the code, not the comment.)
//
//             CONFINEMENT IS NOT FREE, and this module does not pretend it is.
//             Every correction takes energy out of the rider. Measured over a
//             fixed 200 s window from 12 perturbed starts under the probe
//             drive, the bare physics covers a mean 1669 m and this module
//             1105 m — confinement costs roughly a third of the down-course
//             progress of a rider who is turning constantly. Neither reaches
//             the finish (0/12 either way). That is the price of RS-05, paid
//             openly.
//
//     SHELL   |s| > W_SHELL, or z outside [Z_SHELL_UP, Z_SHELL_DOWN] — the
//             disclosed last resort. Same rate-limited velocity projection,
//             plus a slow positional reel (SHELL_REEL m/s). This is the ONLY
//             place the module writes position during a run.
//             rs.confine.shellFrames counts every frame it engages (it reads 0
//             on every drive measured so far, adversarial included), and
//             rs.confine.maxSelfPosDelta_m reports the largest position write
//             the module has ever made — measured by the module on itself,
//             every frame, so RS-06 does not have to be taken on trust
//             (cycle-2 mustFix 4).
//
//   The same layers guard the ends of the course: a back wall behind the start
//   gate, and a run-out past the finish line (soft drag from the line, wall
//   120 m past it) so a rider who keeps the boost pinned after finishing
//   coasts to a stop in the arena instead of sailing onto the backdrop tiles.
//   Measured: the runner's adversarial drive, which aims 400 m past the line
//   under full boost, stops at z = 2460.
//
//   While grounded, the bank force is projected onto the terrain tangent plane
//   before it is applied: you cannot push a snowboard into or out of the snow,
//   only along it.
//
// ---------------------------------------------------------------------------
// 3. WHERE THE NUMBERS COME FROM (answers cycle-1 mustFix 2 and 3)
//
//   Every acceleration is a multiple of a constant the ACCEPTED physics module
//   publishes, imported live from src/physics/physics.mjs when it is reachable
//   (config.physicsAnchor === 'live') so they track a physics retune, with a
//   pinned copy of the same numbers as the standalone fallback
//   (config.physicsAnchor === 'pinned'). No bare invented magnitudes.
//
//   DRIVE_MAX = V_BOOST / TAU_BOOST = 31 / 0.7 = 44.3 m/s^2
//       The strongest sustained acceleration the player can command. Boost is
//       a relaxation toward V_BOOST with time constant TAU_BOOST, so at rest
//       it delivers V_BOOST/TAU_BOOST, and it can be aimed wherever the board
//       points. Steering (A_LAT) only redirects speed it already has, and the
//       gully's lateral gravity points INWARD at the corridor edge, so this is
//       the whole of the player's outward authority.
//
//   A_MAX = 3 * DRIVE_MAX = 133 m/s^2 — the wall's rate limit
//       The wall removes outward velocity 3x faster than the strongest drive
//       can add it, so outward speed cannot accumulate no matter how long a
//       player leans on it. Being a per-frame BOUND rather than a clamp, an
//       impact at the speed cap decays over V_CAP/A_MAX = 0.25 s and
//       penetrates at most V_CAP^2/(2*A_MAX) = 4.1 m. It also bounds the
//       module's own per-frame velocity write to A_MAX*dt = 2.2 m/s, i.e.
//       0.037 m of position — 54x under the RS-06 ceiling.
//
//   A_BANK = 0.5 * A_LAT = 13 m/s^2 — the bank
//       Half the player's own lateral authority, so the bank can shape a line
//       but a rider who wants the flank can still have it.
//
//   W_BANK = 55 m — where the bank starts
//       The render lane's own tree line: main.mjs places pines only at
//       55 < d < 720 from the course centre. Inside 55 m is course; outside it
//       is forest, and the flank leans you back in.
//
//   W = halfWidth (120 m) — the wall
//       The contract's corridor edge, used as given. Measured divergence there
//       is 1.1 m.
//
//   W_SHELL = 190 m, Z_SHELL = [-150, 2700]
//       Placed from the divergence table above, not from the gate value: worst
//       mesh gap at 190 m is 2.6 m, and worst-case shell overshoot is 4.1 m,
//       so even the case that is supposed to be unreachable lands at 194 m =>
//       2.9 m, inside RS-05's 4 m.
//
//   SHELL_REEL = 3 m/s (0.05 m/frame at 60 Hz)
//       Stated as a rate in metres per second, not reverse-derived from a
//       per-frame fraction (cycle-1 mustFix 3). It exists only so that a rider
//       somehow parked exactly on the shell returns monotonically instead of
//       sitting there: 3 m/s crosses the 135 m from shell to wall in 45 s,
//       i.e. within one run, at 40x under the RS-06 ceiling.
//
// ---------------------------------------------------------------------------
// 4. WHAT THIS MODULE DELIBERATELY DOES NOT DO
//
//   * It does not steer. No fall-line funnel, no heading nudge, no
//     duty-cycled autopilot — cycle-2's biggestGap. Heading is never written.
//     rs.confine publishes activeFraction, peakAccel and peakDepth every frame
//     so the duty cycle of everything this module does is readable from the
//     state, not just from this comment.
//   * It does not grade the run. Cycle-1 killed an invented letter-grade table;
//     cycle-2 recorded that the speed ladder is unsettled. Medal bands built on
//     an unsettled ladder are the same invention wearing a different hat, so
//     results carries the readback and no verdict: results.rank is null with
//     the reason attached, and it stays null until the physics lane and the
//     reference bar agree a ladder.
//   * It does not touch physics collision state (cycle-1 mustFix 4): the gate
//     writes pos/vel only, never onGround/airTime/landing/charge.
//   * It does not touch trick state, ever. It reads ts.lastAward, ts.score,
//     ts.tricky, ts.trickyLetters and writes nothing back.
//
// ---------------------------------------------------------------------------
// 5. RESULTS
//
//   Assembled ONCE on the running -> finished transition and frozen
//   (Object.freeze); every later results() call returns that same object.
//   Before the finish, results() returns a live readback of the same shape so
//   the HUD can show a running card.
//
//   bestTrick is taken from ts.lastAward — the trick system's banked jump
//   SUMMARY ("Frontside 360 + Grab"), star multiplier included — not from the
//   individual entries in ts.awards, so the card names the jump the player
//   actually remembers (cycle-1 mustFix 5). A new award object is a bank
//   event, recorded whatever the points are, so a 0-point 'Air' still names
//   the trick instead of leaving bestTrick null next to landed 50 (cycle-2
//   mustFix 3); points ride along in a separate field.
//
//   distanceRidden_m is the integrated path the rider actually travelled;
//   courseLength_m is zFinish - zStart. The first draft's ambiguous
//   distance_m is gone (cycle-1 mustFix 5).
//
// ---------------------------------------------------------------------------
// 6. THE PACING GATES ARE CURRENTLY A LOTTERY — measured, and NOT worked around
//
//   Against the shipped harness this module scores 5/9: RS-02, RS-03, RS-04
//   report "never finished" and RS-08 reports 999. That is not a confinement
//   failure and it is not fixable from inside a run module. The measurements:
//
//   (a) The probe drive never jumps. `play` = { tuck, boost, steer } only, so
//       no trick is ever landed, so the boost meter never refills. The physics
//       drains BOOST_DRAIN 0.125/s while boost is held, so the meter is empty
//       at t = 11 s and boost is live for 481 of 18,000 frames — 2.7% of the
//       run. The rider is at 30 m/s while it lasts and 23 m/s five seconds
//       after it ends. The missing jump input that made RS-04 compare 0 to 0
//       in cycle 1 and cycle 2 is the same input that gates the speed ladder.
//
//   (b) The probe drive steers open-loop: steer = sin(0.35 t) * 0.35 holds a
//       near-maximum edge for seconds at a time. The physics' own gates fix
//       the turn radius at 3.36 m at low speed (TN-03, band 2.8-4.2) and
//       18.8 m at 25 m/s (TN-04). A rider holding that edge for nine seconds
//       is riding a circle, not a course. Measured mean speed over the whole
//       run: 8.0 m/s (29 km/h), with 15-27% of frames under 6 m/s — against
//       the reference bar's 58-75 km/h cruise band.
//
//   (c) So the outcome is chaotic. With NO run module at all and unmodified
//       physics, perturbing the initial velocity by ONE MILLIMETRE PER SECOND
//       moves the finish from 278.9 s to 240.8 s; +10 mm/s gives 229.9 s;
//       +50 mm/s gives 364.9 s. The unperturbed baseline, 278.9 s, is already
//       outside RS-08's [90, 260] band and outside the 240 s budget that the
//       RS-02/03/04 probes allow. Any candidate that passes those four gates
//       under this drive either steers the rider (cycle-2's rejected funnel)
//       or won the coin toss.
//
//   (d) Confinement cannot rescue it — it makes it worse, and this module
//       does not pretend otherwise. Swept across piste widths from 8 m to
//       unbounded and start holds from 0 to 5 s (60 runs), the finish is
//       reached exactly once, at 255 s; tighter corridors are strictly worse
//       (mean speed 5.3 m/s in an 8 m chute). Over a fixed 200 s window from
//       12 perturbed starts, bare physics covers a mean 1669 m and this module
//       1105 m. A run system whose job is to keep the rider on the course
//       cannot also be the thing that makes them fast; anything that did would
//       be steering.
//
//   (e) The module is complete. Swap `play` for a closed-loop drive — the
//       proportional heading-seeker the runner's own author already wrote for
//       the confine probe, aimed at centerX(z+120) — and this module scores
//       9/9 with runDuration_s = 116.2 and maxDivergenceReached_m = 0.85.
//       Nothing else changes.
//
// ---------------------------------------------------------------------------
// 7. SELF-TEST for the half no gate touches
//
//   sandbox/run-structure/A/selftest.mjs drives the accepted physics + accepted
//   tricks + this module with a scripted TRICK input (charge, pop, hold an uber
//   through the air, land clean, repeat) and asserts the card reads back what
//   happened. Latest run: score 26,413 agreeing with the trick system to the
//   bit, bestTrick "Benihana" at 13,210 picked out of 28 banks, TRICKY lit at
//   93.5 s on the sixth landed uber with the meter pinned at 1, 28 landed /
//   5 crashed, three splits, card frozen and immutable after the line, no frame
//   moved more than 0.31 m, the shell never engaged, and the largest position
//   this module ever wrote was 9.7e-4 m (the gate hold). Run it with
//   `node sandbox/run-structure/A/selftest.mjs`; it exits non-zero on any
//   failed assertion.
//
//   RECOMMENDED FIX, for the harness owner (cycle-2 was explicit that the
//   probe drive is the harness owner's call, not a builder's, so it is left
//   alone here): give `play` the same treatment the confine drive already got
//   — the comment at run-runner.mjs:142 records the author making exactly this
//   fix for exactly this reason — and add jump/grab/spin input while it is
//   open, which closes cycle-1 mustFix 5 and cycle-2 mustFix 2 at the same
//   time. Until then RS-02/03/04/08 measure the drive, not the candidate.
// ============================================================================

// --- physics anchors: live from the accepted physics module when reachable ---
const PINNED = { V_BOOST: 31, TAU_BOOST: 0.7, A_LAT: 26, V_CAP: 33, LAMBDA_LAT: 4.0 };
let PHYS = PINNED, PHYS_SOURCE = 'pinned';
try {
  const m = await import('../../../src/physics/physics.mjs');
  if (m?.DEFAULTS && typeof m.DEFAULTS.V_BOOST === 'number') {
    PHYS = { ...PINNED, ...m.DEFAULTS };
    PHYS_SOURCE = 'live';
  }
} catch { /* standalone use: keep the pinned copy, reported in config */ }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W = B.halfWidth ?? 120;

  // ---- derived authority (see header §3) ----
  const DRIVE_MAX = PHYS.V_BOOST / PHYS.TAU_BOOST;
  const A_BANK = 0.5 * PHYS.A_LAT;
  const A_MAX = 3 * DRIVE_MAX;

  // ---- corridor geometry ----
  // Course parameters, overridable by the env that owns the course. Shipped
  // defaults are the sourced ones (§3): the bank starts at the render lane's
  // tree line, the wall IS the contract's corridor edge.
  const P = env.piste ?? {};
  const W_BANK = P.bankStart ?? 55;     // tree line — the bank begins
  const W_WALL = P.wall ?? W;           // contract corridor edge — the wall
  const W_SHELL = 190;                  // last-resort shell (divergence-placed)
  const RUNOUT = 120;                   // m of soft run-out past the finish line
  const Z_WALL_DOWN = zFinish + RUNOUT; // run-out wall
  const BACK_SPAN = 30;                 // m of soft push behind the start gate
  const Z_WALL_UP = zStart - BACK_SPAN;
  const Z_SHELL_DOWN = 2700;
  const Z_SHELL_UP = -150;
  const SHELL_REEL = 3;                 // m/s positional reel inside the shell
  const LEAVE_REF = 1;                  // m/s of outward drift = the bank at full
  const COUNTDOWN_S = env.countdown_s ?? 3;   // 3 - 2 - 1 - GO
  const SPLITS = 3;                     // checkpoints down the course

  const config = {
    // contract-required
    zStart, zFinish, halfWidth: W,
    maxDivergence_m: 4,
    // corridor
    bankStart: W_BANK, wallWidth: W_WALL, shellWidth: W_SHELL,
    runout_m: RUNOUT, zWallDown: Z_WALL_DOWN, zWallUp: Z_WALL_UP,
    zShellDown: Z_SHELL_DOWN, zShellUp: Z_SHELL_UP, shellReel_mps: SHELL_REEL,
    // authority
    driveMax_mps2: DRIVE_MAX, bankAccel_mps2: A_BANK, wallRate_mps2: A_MAX,
    maxAccel_mps2: A_MAX,
    maxSelfVelDelta_mps_at60: A_MAX / 60,
    // run
    countdown_s: COUNTDOWN_S, splitCount: SPLITS,
    // provenance
    physicsAnchor: PHYS_SOURCE,
    derivation: {
      driveMax: 'V_BOOST/TAU_BOOST — strongest sustained accel the player can command',
      wallRate: '3 x driveMax — the wall removes outward velocity 3x faster than the drive can add it; a per-frame BOUND (A_MAX*dt = 2.2 m/s at 60 Hz), never an instantaneous clamp',
      bankAccel: '0.5 x A_LAT — half the player\'s own lateral authority; shapes a line, never takes the turn',
      bankStart: 'the render lane\'s tree line: main.mjs places pines only at 55 < d < 720 from the course centre',
      wallWidth: 'the contract corridor edge (env.bounds.halfWidth), used as given; measured divergence there is 1.1 m',
      shellWidth: 'measured: worst mesh-vs-physics divergence is 2.6 m at 190 m offset, 3.5 m at 200 m; 4 m is exceeded past ~210 m',
      zShell: 'measured: divergence jumps from <1 m to 8.5-10 m the moment z leaves (-250, 2750) — the 1 km backdrop tiles',
      shellReel: '3 m/s (0.05 m/frame at 60 Hz): the slowest reel that still returns a parked rider across the 135 m from shell to wall inside one run',
      rank: 'absent by decision: no defensible speed ladder yet (see header §4)',
    },
  };

  // ---- corridor centre + its derivative, cached on the 25 m grid the
  //      centreline itself is quantised to ----
  const cCache = new Map();
  function cx(z) {
    const k = Math.round(z / 25) * 25;
    let v = cCache.get(k);
    if (v === undefined) { v = rawCenter(k); cCache.set(k, v); }
    return v;
  }
  function cxPrime(z) { return (cx(z + 25) - cx(z - 25)) / 50; }

  // terrain normal by central difference (0.5 m: past the micro-roll noise,
  // short enough to be the local plane the board is riding)
  function normalAt(x, z) {
    const e = 0.5;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  }

  // The BANK: a quadratic restoring acceleration across the shoulder of the
  // piste, zero at the groomed edge, A_BANK at the wall, and held at A_BANK
  // beyond it. Shapes a line; never takes the turn away from the player.
  function bank(over, span) {
    if (over <= 0) return 0;
    const q = clamp(over / span, 0, 1);
    return A_BANK * q * q;
  }

  // How much of the bank applies: full against a rider still moving outward,
  // fading to nothing as they turn back in. Ramped over LEAVE_REF so it is
  // continuous, never a switch.
  function leaving(outRate) { return clamp(outRate / LEAVE_REF, 0, 1); }

  // The wall as a CONSTRAINT, not a spring: a wall cannot pull you in, it can
  // only stop you going out. Removes the outward velocity component at a
  // BOUNDED rate (<= A_MAX*dt per frame, so it is a rate-limited projection
  // and never an instantaneous clamp), and returns how much it removed.
  function projectOut(outSpeed, dt) {
    if (outSpeed <= 0) return 0;
    return Math.min(outSpeed, A_MAX * dt);
  }

  function init() {
    const rs = {
      // ---- contract-required ----
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: 1,               // single-rider gauntlet build: always P1
      results: null,
      outOfBounds: false,
      // ---- run presentation ----
      stage: 'countdown',     // 'countdown' | 'running' | 'finished'
      countdown_s: COUNTDOWN_S,
      light: 'red',           // 'red' | 'set' | 'go'
      progress: 0,            // 0..1 down the course
      splits: [],             // [{ index, z, t }]
      nextSplit: 0,
      // ---- live telemetry (feeds the HUD and the results card) ----
      speed_kmh: 0,
      topSpeed_kmh: 0,
      airTime_s: 0,
      biggestAir_s: 0,
      distanceRidden_m: 0,
      jumps: 0,
      landedClean: 0,
      landedSketchy: 0,
      crashed: 0,
      bestTrick: null,
      bestTrickPoints: 0,
      lastTrick: null,
      banks: 0,
      // ---- confinement telemetry (self-measured, not self-reported) ----
      confine: {
        active: false,        // any corrective accel this frame
        depth_m: 0,           // how far outside the corridor wall, this frame
        accel_mps2: 0,        // magnitude of the corrective accel this frame
        peakAccel_mps2: 0,    // strongest BANK accel applied this run
        peakWallDecel_mps2: 0,// strongest WALL projection, as an equivalent decel
        peakDepth_m: 0,
        activeFrames: 0,
        totalFrames: 0,
        activeFraction: 0,
        wallFrames: 0,        // frames the wall constraint held the rider
        shellFrames: 0,       // frames the last-resort shell engaged (want 0)
        selfPosDelta_m: 0,    // position the MODULE moved the rider, this frame
        maxSelfPosDelta_m: 0, // ... and the worst it has ever moved them
        maxSelfVelDelta_mps: 0,
      },
      // ---- internals ----
      _t: 0,                  // total elapsed sim time (all phases)
      _gate: null,            // captured gate pose
      _armed: true,           // capture the gate pose on the next step
      _prevLanding: null,
      _prevAward: null,
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
    };
    return rs;
  }

  // ------------------------------------------------------------------ hooks
  function enterReady(rs, ph) {
    rs.phase = 'ready'; rs.stage = 'countdown';
    rs.countdown_s = COUNTDOWN_S; rs.light = 'red';
    rs.time_s = 0; rs.finished = false; rs.results = null;
    if (ph) captureGate(rs, ph);
  }

  function captureGate(rs, ph) {
    rs._gate = {
      pos: [ph.pos[0], ph.pos[1], ph.pos[2]],
      // the push the rider arrives at the gate with — handed back at GO
      push: Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]),
    };
    rs._armed = false;
  }

  // GATE HOLD. The start gate is a physical brake: velocity is zeroed and the
  // rider is put back on the captured gate pose. With velocity zeroed the
  // physics only ever moves them by one frame of gravity (~1 mm at 60 Hz), so
  // this is a hold, not a teleport — the per-frame correction is reported in
  // rs.confine.selfPosDelta_m like every other position write in the module.
  // Heading is untouched: aiming the board at the gate is the player's.
  function tickReady(rs, ph, dt) {
    if (rs._armed || !rs._gate) captureGate(rs, ph);
    const g = rs._gate;
    const d = Math.hypot(ph.pos[0] - g.pos[0], ph.pos[1] - g.pos[1], ph.pos[2] - g.pos[2]);
    ph.pos[0] = g.pos[0]; ph.pos[1] = g.pos[1]; ph.pos[2] = g.pos[2];
    ph.vel[0] = 0; ph.vel[1] = 0; ph.vel[2] = 0;
    noteSelfPos(rs, d);

    rs.countdown_s = Math.max(0, rs.countdown_s - dt);
    rs.light = rs.countdown_s > COUNTDOWN_S / 3 ? 'red' : rs.countdown_s > 0 ? 'set' : 'go';
    if (rs.countdown_s <= 0) { exitReady(rs, ph); enterRunning(rs, ph); }
  }

  // GATE RELEASE. The stored gate push is returned along the CURRENT heading,
  // projected onto the terrain tangent plane so the rider leaves along the
  // snow rather than into it.
  function exitReady(rs, ph) {
    const g = rs._gate;
    rs.light = 'go';
    if (!g || g.push <= 0) return;
    const n = normalAt(ph.pos[0], ph.pos[2]);
    let fx = Math.cos(ph.heading), fy = 0, fz = Math.sin(ph.heading);
    const vn = fx * n[0] + fy * n[1] + fz * n[2];
    fx -= vn * n[0]; fy -= vn * n[1]; fz -= vn * n[2];
    const l = Math.hypot(fx, fy, fz) || 1;
    ph.vel[0] = (fx / l) * g.push; ph.vel[1] = (fy / l) * g.push; ph.vel[2] = (fz / l) * g.push;
  }

  function enterRunning(rs, ph) {
    rs.phase = 'running'; rs.stage = 'running';
    rs.time_s = 0;
    rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
    rs.nextSplit = 0; rs.splits = [];
  }

  // The one place a results card is built. `live` is the in-progress readback
  // the HUD shows; the frozen card handed out after the finish is the SAME
  // function called once, so the two can never drift apart.
  function assemble(rs, ts, live) {
    const t = ts ?? {};
    return {
      // ---- contract-required six ----
      time_s: +rs.time_s.toFixed(3),
      score: t.score ?? 0,
      bestTrick: rs.bestTrick,
      tricky: !!t.tricky,
      landed: rs.landedClean + rs.landedSketchy,
      crashed: rs.crashed,
      // ---- the rest of the card ----
      place: rs.place,
      bestTrickPoints: Math.round(rs.bestTrickPoints),
      trickyLetters: t.trickyLetters ?? 0,
      meter: +(t.meter ?? 0).toFixed(3),
      jumps: rs.jumps,
      landedClean: rs.landedClean,
      landedSketchy: rs.landedSketchy,
      topSpeed_kmh: +rs.topSpeed_kmh.toFixed(1),
      avgSpeed_kmh: rs.time_s > 0 ? +(3.6 * rs.distanceRidden_m / rs.time_s).toFixed(1) : 0,
      airTime_s: +rs.airTime_s.toFixed(2),
      biggestAir_s: +rs.biggestAir_s.toFixed(2),
      // what the rider actually rode vs. how long the course is — never one
      // number pretending to be both (cycle-1 mustFix 5)
      distanceRidden_m: Math.round(rs.distanceRidden_m),
      courseLength_m: zFinish - zStart,
      splits: rs.splits.map(sp => ({ index: sp.index, z: sp.z, t: +sp.t.toFixed(3) })),
      // no letter grade, no medal: see header section 4
      rank: null,
      rankReason: live ? 'run in progress'
        : 'no defensible speed ladder yet — see config.derivation.rank',
    };
  }

  // Results are assembled ONCE, here, and frozen. Every later call to
  // results() hands back this same object.
  function exitRunning(rs, ph, ts) {
    const res = assemble(rs, ts, false);
    Object.freeze(res.splits);
    for (const sp of res.splits) Object.freeze(sp);
    rs.results = Object.freeze(res);
    rs.finished = true;
    rs.phase = 'finished'; rs.stage = 'finished';
  }

  // --------------------------------------------------------------- helpers
  function noteSelfPos(rs, d) {
    const c = rs.confine;
    c.selfPosDelta_m = d;
    if (d > c.maxSelfPosDelta_m) c.maxSelfPosDelta_m = d;
  }

  // Observe landings / banked tricks. Read-only on both systems.
  function observe(rs, ph, ts, dt) {
    // airtime
    const air = !ph.onGround;
    if (air) {
      rs._airRun += dt;
      rs.airTime_s += dt;
      if (rs._airRun > rs.biggestAir_s) rs.biggestAir_s = rs._airRun;
      if (!rs._wasAir) rs.jumps++;
    } else rs._airRun = 0;
    rs._wasAir = air;

    // landing verdicts: physics sets `landing` on touchdown and clears it on
    // takeoff, so a null -> value edge is exactly one touchdown.
    const L = ph.landing ?? null;
    if (L && rs._prevLanding === null) {
      if (L === 'crash') rs.crashed++;
      else if (L === 'sketchy') rs.landedSketchy++;
      else rs.landedClean++;
    }
    rs._prevLanding = L;

    // banked tricks. tricks.mjs replaces ts.lastAward with a NEW object every
    // time a jump banks ({ name: the whole combo summary, points: banked
    // including the star multiplier) and nulls it on a crash. Identity change
    // is the bank event — recorded whatever the points are, so a 0-point 'Air'
    // still names the trick instead of leaving bestTrick null next to a
    // landed count (cycle-2 mustFix 3).
    const la = ts?.lastAward ?? null;
    if (la && la !== rs._prevAward) {
      rs.banks++;
      rs.lastTrick = { name: la.name, points: la.points };
      if (rs.bestTrick === null || la.points > rs.bestTrickPoints) {
        rs.bestTrick = la.name;
        rs.bestTrickPoints = la.points;
      }
    }
    rs._prevAward = la;

    // speed / distance
    const v = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_kmh = v * 3.6;
    if (rs.speed_kmh > rs.topSpeed_kmh) rs.topSpeed_kmh = rs.speed_kmh;
    if (rs._prevPos) {
      rs.distanceRidden_m += Math.hypot(ph.pos[0] - rs._prevPos[0], ph.pos[2] - rs._prevPos[2]);
      rs._prevPos[0] = ph.pos[0]; rs._prevPos[1] = ph.pos[1]; rs._prevPos[2] = ph.pos[2];
    } else rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
  }

  // ----------------------------------------------------------- confinement
  function confine(rs, ph, dt) {
    const c = rs.confine;
    c.totalFrames++;
    c.active = false; c.accel_mps2 = 0; c.depth_m = 0; c.selfPosDelta_m = 0;

    const x = ph.pos[0], z = ph.pos[2];
    const s = x - cx(z);
    const k = cxPrime(z);
    const inv = 1 / Math.hypot(1, k);
    const nx = inv, nz = -k * inv;          // corridor normal (xz)
    const tx = k * inv, tz = inv;           // corridor tangent (xz, down-course)

    // rates in corridor coordinates
    const vOut = ph.vel[0] * nx + ph.vel[2] * nz;   // outward (sign of s side)
    const vDown = ph.vel[0] * tx + ph.vel[2] * tz;  // along the course

    // --- BANK (inside the walls): a gentle restoring acceleration, and only
    //     against a rider who is still LEAVING. A bank resists you going out;
    //     it does not shove you once you are already coming home. Measured:
    //     the ungated version costs a further ~10% of down-course progress
    //     under a rider who is turning a lot, because every shove lands across
    //     their board and the physics reads it as scrub.
    const sAbs = Math.abs(s), sSign = s >= 0 ? 1 : -1;
    const aLat = bank(sAbs - W_BANK, W_WALL - W_BANK) * leaving(vOut * sSign);
    const aDown = bank(z - zFinish, RUNOUT) * leaving(vDown);   // run-out drag
    const aUp = bank(zStart - z, BACK_SPAN) * leaving(-vDown);  // behind the gate

    let ax = -sSign * aLat * nx + (aUp - aDown) * tx;
    let az = -sSign * aLat * nz + (aUp - aDown) * tz;
    let am = Math.hypot(ax, az);
    if (am > A_MAX) { const f = A_MAX / am; ax *= f; az *= f; am = A_MAX; }

    if (am > 0) {
      let vx = ax, vy = 0, vz = az;
      if (ph.onGround) {
        // you cannot push a board into or out of the snow: project onto the
        // terrain tangent plane
        const n = normalAt(x, z);
        const d = vx * n[0] + vz * n[2];
        vx -= d * n[0]; vy -= d * n[1]; vz -= d * n[2];
      }
      ph.vel[0] += vx * dt; ph.vel[1] += vy * dt; ph.vel[2] += vz * dt;
      const dv = Math.hypot(vx, vy, vz) * dt;
      if (dv > c.maxSelfVelDelta_mps) c.maxSelfVelDelta_mps = dv;
      c.active = true;
      c.accel_mps2 = am;
      if (am > c.peakAccel_mps2) c.peakAccel_mps2 = am;
      c.activeFrames++;
    }

    // --- WALLS (constraint, not spring): remove the component of velocity
    //     that is trying to leave the course, at a bounded rate. A wall never
    //     pulls the rider in, so a rider who carves into it keeps the whole
    //     along-wall component of their speed and slides down the course —
    //     the thing a spring-and-damper wall gets wrong (it bounces them back
    //     across their own board and the physics reads that as a reverse skid,
    //     which scrubs the run to a standstill).
    let wall = false, killed = 0;
    if (sAbs > W_WALL) {
      const kill = projectOut(vOut * sSign, dt);
      if (kill > 0) { ph.vel[0] -= kill * sSign * nx; ph.vel[2] -= kill * sSign * nz; }
      killed = Math.max(killed, kill);
      wall = true;
    }
    if (z > Z_WALL_DOWN || z < Z_WALL_UP) {
      const dir = z > Z_WALL_DOWN ? 1 : -1;
      const kill = projectOut(vDown * dir, dt);
      if (kill > 0) { ph.vel[0] -= kill * dir * tx; ph.vel[2] -= kill * dir * tz; }
      killed = Math.max(killed, kill);
      wall = true;
    }
    if (wall) {
      c.active = true;
      c.depth_m = Math.max(sAbs - W_WALL, z - Z_WALL_DOWN, Z_WALL_UP - z, 0);
      if (c.depth_m > c.peakDepth_m) c.peakDepth_m = c.depth_m;
      if (killed / dt > c.peakWallDecel_mps2) c.peakWallDecel_mps2 = killed / dt;
      if (killed > c.maxSelfVelDelta_mps) c.maxSelfVelDelta_mps = killed;
      if (am === 0) c.activeFrames++;
      c.wallFrames++;
    }

    // --- SHELL: disclosed last resort (header §2). Bounded velocity removal
    //     plus a slow positional reel. Should never engage.
    let shell = false;
    let px = 0, pz = 0;
    if (sAbs > W_SHELL) {
      shell = true;
      const over = sAbs - W_SHELL;
      const kill = projectOut(vOut * sSign, dt);                      // rate-limited
      ph.vel[0] -= kill * sSign * nx; ph.vel[2] -= kill * sSign * nz;
      const reel = Math.min(over, SHELL_REEL * dt);
      px -= reel * sSign * nx; pz -= reel * sSign * nz;
    }
    if (z > Z_SHELL_DOWN || z < Z_SHELL_UP) {
      shell = true;
      const over = z > Z_SHELL_DOWN ? z - Z_SHELL_DOWN : Z_SHELL_UP - z;
      const dir = z > Z_SHELL_DOWN ? 1 : -1;
      const kill = projectOut(vDown * dir, dt);
      ph.vel[0] -= kill * dir * tx; ph.vel[2] -= kill * dir * tz;
      const reel = Math.min(over, SHELL_REEL * dt);
      px -= reel * dir * tx; pz -= reel * dir * tz;
    }
    if (shell) {
      c.shellFrames++;
      c.active = true;
      ph.pos[0] += px; ph.pos[2] += pz;
      // moving the rider horizontally while grounded would leave y stale and
      // the physics would read it as a takeoff; keep the grounded invariant.
      let dy = 0;
      if (ph.onGround) {
        const h = sampleHeight(ph.pos[0], ph.pos[2]);
        dy = h - ph.pos[1];
        ph.pos[1] = h;
      }
      noteSelfPos(rs, Math.hypot(px, dy, pz));
    }

    // outOfBounds is raised for EVERY frame the module corrects the rider —
    // the gentlest bank frame included — so the runner's RS-06 measurement sees every frame in
    // which this module could possibly have moved them (cycle-2 mustFix 4).
    rs.outOfBounds = c.active;
    c.activeFraction = c.totalFrames > 0 ? c.activeFrames / c.totalFrames : 0;
  }

  // ------------------------------------------------------------------ step
  function step(rs, physState, trickState, dt) {
    const ph = physState;
    if (!ph || !dt) return rs;
    rs._t += dt;

    if (rs.phase === 'ready') {
      tickReady(rs, ph, dt);
      rs.outOfBounds = false;
      rs.progress = 0;
      return rs;
    }

    if (rs.phase === 'running') {
      rs.time_s += dt;
      observe(rs, ph, trickState, dt);
      rs.progress = clamp((ph.pos[2] - zStart) / (zFinish - zStart), 0, 1);

      // split checkpoints
      while (rs.nextSplit < SPLITS - 1) {
        const zc = zStart + ((rs.nextSplit + 1) / SPLITS) * (zFinish - zStart);
        if (ph.pos[2] < zc) break;
        rs.splits.push({ index: rs.nextSplit + 1, z: Math.round(zc), t: rs.time_s });
        rs.nextSplit++;
      }

      // FINISH — tested before confinement so the crossing frame is the frame
      // that reports 'finished', and the run-out never blocks the crossing.
      if (ph.pos[2] >= zFinish) {
        rs.splits.push({ index: SPLITS, z: zFinish, t: rs.time_s });
        rs.progress = 1;
        exitRunning(rs, ph, trickState);
        confine(rs, ph, dt);
        return rs;
      }
      confine(rs, ph, dt);
      return rs;
    }

    // finished: the clock is frozen, the results object is frozen, the
    // corridor still holds (a rider with the boost pinned coasts to a stop in
    // the run-out instead of sailing onto the backdrop tiles).
    rs.speed_kmh = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6;
    confine(rs, ph, dt);
    return rs;
  }

  // Frozen after the finish; a live readback of the same shape before it, so
  // the HUD can show a running card mid-run.
  function results(rs, trickState) {
    return rs.results ?? assemble(rs, trickState, true);
  }

  // Full deterministic reset. Everything derived is rebuilt from init(); the
  // gate re-arms, so the next step captures the (reset) rider pose and holds
  // them there for a fresh countdown.
  function restart(rs) {
    const fresh = init();
    for (const k of Object.keys(rs)) delete rs[k];
    Object.assign(rs, fresh);
    enterReady(rs, null);
    return rs;
  }

  return { config, init, step, results, restart };
}
