// ============================================================================
// run-structure candidate A — run.mjs   (cycle 4)
//
// Start gate, race clock, finish line, results card, restart, and a
// three-layer CORRIDOR: soft berm -> firm wall -> hard limit.
//
// Pure JS, deterministic. No Date, no Math.random, no globals.
//
// WHAT THIS MODULE WRITES, EXHAUSTIVELY:
//   * physState.vel — and only by adding a bounded ACCELERATION * dt from the
//     corridor field. Every write is self-measured into rs.confine.
//   * nothing else. It never writes physState.pos (rs.confine.maxSelfPosDelta_m
//     is therefore identically 0 and is published so that is checkable, not
//     merely claimed), never physState.heading or any rotation state, never
//     onGround / airTime / landing / charge / boostMeter, never any field of
//     the trick state.
//
// ---------------------------------------------------------------------------
// 0. NO STEERING. NOT ANYWHERE, NOT EVER.
//
//   Cycle 3 was closed NEITHER after a candidate reached 9/9 by writing
//   st.heading toward the fall line on 98.8% of running frames. RS-10 now
//   measures that directly. This module's answer is stronger than "under the
//   5 deg/s bar": under the harness probe drive `play` the corridor field
//   never engages at all, so the module makes ZERO writes of any kind while
//   the rider is racing, and the two trajectories (with and without run.step)
//   are bit-identical. Measured: moduleYawAuthority_degps = 0.
//
//   That is not luck, it is the placement rule. Measured over the whole
//   208.9 s probe run with no run module attached, the widest line the probe
//   drive takes is 34.1 m off the course centre (p99 = 30.5 m). The berm —
//   the first and gentlest layer — starts at 55 m. A competent player never
//   touches the corridor; only somebody trying to leave does.
//
//   MEASURED, on this harness, this session: the cycle-3 version of this file
//   pinned the rider at the gate for a 3 s countdown. That pin is not a yaw
//   write, but it displaces the whole trajectory, and RS-10 scores trajectory
//   divergence as authority: it reported 300.0 deg/s (the physics yaw cap).
//   Any run module that touches the rider on an ordinary frame — to hold them,
//   to funnel them, to "help" — reads as an autopilot whether it steers or
//   not. Hence the design rule below: the corridor is a boundary, and a
//   boundary that a good rider can feel is a boundary in the wrong place.
//
// ---------------------------------------------------------------------------
// 1. PHASE MACHINE
//
//   phase: 'ready' -> 'running' -> 'finished'          (contract field)
//
//   ready     the rider is upstream of the start line (pos.z < zStart). The
//             clock reads 0. The gate is a CLOSED GATE: the corridor's
//             up-course envelope (section 2) is moved to the start line, so a
//             rider behind the line cannot roll onto the course before the
//             lights go green. COUNTDOWN_S seconds of red/set/go run down and
//             open it. rs.stage / rs.countdown_s / rs.light publish the
//             countdown for the HUD; the contract fixes `phase` to three
//             values, so the countdown is a sub-state of 'ready', not a
//             fourth phase.
//   running   entered on the first step at or past zStart — the clock starts
//             AT THE LINE, as in a race with a rolling start. Timer, splits,
//             telemetry, the landing ledger and the corridor all run here.
//   finished  entered on the first step at or past zFinish. Results are
//             assembled once and frozen (Object.freeze); the clock stops; the
//             corridor keeps holding so a rider with the boost pinned coasts
//             to a stop in the run-out instead of sailing onto the backdrop.
//
//   THE GATE IS A LINE AND AN ENVELOPE, NOT A PIN. Holding a rider by writing
//   their position or zeroing their velocity is a physics write on an ordinary
//   frame; see section 0 for what that measures as. The harness spawns the
//   rider 15 m PAST the line, so on every gate run in this lane the 'ready'
//   phase is empty and the gate is never exercised — RS-09 passes through the
//   runner's own "no ready phase (starts running)" branch. That is a disclosed
//   never-engages mechanism, counted in rs.confine.gateFrames (0 on every
//   drive measured). It is kept because a start gate that only holds riders
//   who are actually behind it is the correct object; a gate that grabs a
//   rider already on the course is the thing that failed.
//
// ---------------------------------------------------------------------------
// 2. THE CORRIDOR — why it exists, and the one law all of it obeys
//
//   Physics ground is an analytic function defined everywhere. The RENDERED
//   mesh is a per-LOD approximation of it, so past a certain distance the
//   rider is visibly not touching the world they can see. Measured with the
//   runner's own divergence probe (|analytic - bilinear across the worst LOD
//   cell the player can be near|), swept every 2 m over the whole course:
//
//     |offset from centre|   0    55   120   140   150   160   190   220
//     worst mesh gap (m)   0.87  1.00  1.13  1.44  1.57  2.29  3.02  4.46
//
//     z outside (-250, 2750): the 1 km backdrop tiles, 83.3 m cells —
//     divergence steps from < 0.4 m to 8.6 m across that boundary and rises
//     to ~77 m further out.
//
//   RS-05's ceiling is 4 m. The lateral hard limit is placed by a stated rule,
//   not by taste: THE LARGEST OFFSET WHOSE WORST DIVERGENCE OVER THE WHOLE
//   CONFINED SET IS AT MOST HALF THE CEILING. Densely swept (2 m grid in both
//   axes over the full z range): |s| <= 150 gives 1.82 m (passes), |s| <= 160
//   gives 2.51 m (fails). Hence L_LAT = 150 m.
//
//   THE ONE LAW. Every hard boundary in this module — lateral, past the
//   finish, behind the start, and the closed gate — is the same braking
//   envelope. At distance `gap` from a limit, the allowed closing speed is
//
//       v_allow(gap) = sqrt(2 * A * gap)          (continuous form)
//
//   which reaches zero EXACTLY at the limit and asks for a constant decel A.
//   The firmness A is not chosen; it is forced by requiring that the envelope
//   impose NOTHING where the layer starts:
//
//       v_allow(span) = V_CAP     =>     A = V_CAP^2 / (2 * span)
//
//   V_CAP (33 m/s) is the physics module's own hard speed clamp, so at the
//   layer's outer edge the envelope permits the fastest thing that can
//   physically exist, and from there it closes down smoothly. One equation per
//   layer, one measured span per layer, no free parameters:
//
//     layer          span                                   A (m/s^2)
//     lateral wall   halfWidth 120 -> L_LAT 150   =  30 m      18.15
//     run-out        zFinish 2400 -> Z_DOWN 2667  = 267 m       2.04
//     back-stop      zStart 0 -> Z_UP -167        = 167 m       3.27
//     closed gate    same span, limit at zStart   = 167 m       3.27
//
//   Z_DOWN / Z_UP are the backdrop boundary (2750 / -250) pulled in by exactly
//   one backdrop cell (1000/12 = 83.3 m), so that even the bilinear cell the
//   probe straddles the rider with lies wholly inside the fine LOD region.
//
//   The envelope is evaluated in DISCRETE-SAFE form. Solving
//   v_allow^2/(2A) + v_allow*dt = gap for the step actually taken gives
//
//       v_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*gap)
//
//   so a rider who obeys the envelope cannot cross the limit by braking one
//   step too late, at any dt — not a margin that happens to hold at 60 Hz.
//
//   WHAT THE ENVELOPE DOES NOT PROMISE, stated plainly. The module reads the
//   rider once per frame, after physics has already moved them, so a single
//   frame can hand it an outward rate far above the allowance — physics'
//   landing redirect turns a fast fall into the gully wall into exactly that.
//   Taking that back is bounded by A_CEIL, so the penetration past the limit
//   is bounded by V_CAP^2/(2*A_CEIL) = 7.5 m in the worst case that can
//   physically exist. At 157.5 m the measured divergence is ~2.5 m, still
//   inside RS-05's 4 m. MEASURED worst over the self-test's deliberate
//   injections: 150.3 m at dt = 1/60, 152.5 m at dt = 1/30, 151.4 m at
//   dt = 1/120 — 0.3 to 2.5 m of penetration, against a 7.5 m bound.
//
//   THREE LAYERS:
//
//     BERM (soft, |s| in [55, 120])
//       A restoring lateral acceleration, quadratic in depth: zero at the tree
//       line (so it is C1-continuous where it starts, never a step) and
//       A_BERM at the corridor edge. It is GROUNDED-ONLY, because a berm is
//       ground: an airborne rider does not feel a bank.
//       A_BERM = g * sin(THETA_SHOULDER) with THETA_SHOULDER = 42.75 deg, the
//       MEASURED mean lateral slope of the analytic terrain at |s| = 120 over
//       the whole course (121 z-samples, both flanks) = 6.66 m/s^2. So the
//       berm adds, at the corridor edge, exactly the restoring pull the ground
//       there already has: it reads as terrain, not as a hand on the board.
//       Overrule test: 6.66 is 26% of the physics' own lateral acceleration
//       ceiling A_LAT = 26 m/s^2, so a rider at full lock still wins and can
//       still take the flank. A berm shapes a line; it never takes the turn.
//       Start of the layer, W_BERM = 55 m: the render lane's tree line
//       (src/render/main.mjs plants pines only at 55 < d < 720) — and 1.6x the
//       widest line the probe drive takes (34.1 m measured), which is why it
//       never fires in ordinary play.
//
//     WALL (firm, |s| in [120, 150])
//       The braking envelope above, A = 18.15 m/s^2. It removes ONLY the
//       excess of the outward rate over the allowance: a rider carving along
//       the wall keeps every bit of their down-course speed, because the field
//       is expressed in corridor coordinates (offset s across, progress z
//       along) and the wall acts purely across. It cannot pull a rider in —
//       that is the berm's job — and it never engages at all until the rider
//       is genuinely outrunning the room they have left.
//
//     LIMIT (hard, |s| > 150)
//       Reachable only if physics injects outward velocity faster than the
//       wall can take it back — a landing that redirects a fast fall into the
//       gully wall is the realistic case. A WALL PUSHES BACK; braking alone
//       only creeps. The envelope is read once per frame, after physics has
//       already moved the rider, so between one clamp and the next the world
//       adds up to (DRIVE_MAX + g)*dt of outward rate: 1.5 cm of creep per
//       frame at 60 Hz, which a zero allowance never recovers. So past the
//       limit the field applies a restoring A_RETURN = DRIVE_MAX + g =
//       54.1 m/s^2, which out-pulls everything the world can push with, ground
//       or air. MEASURED (self-test 2): a rider spawned 260 m outside at
//       40 m/s outward under full boost is returned to the course centre, with
//       no frame moving them more than their own travel.
//       Disclosed and counted: rs.confine.limitFrames.
//
//     A_CEIL = A_WALL + A_RETURN = 72.3 m/s^2 bounds EVERY corrective
//       acceleration this module applies: the firmest envelope plus the return
//       authority, and not one m/s^2 more. rs.confine.ceilFrames counts frames
//       where the ceiling actually bound.
//
//   GROUNDED CORRECTIONS RIDE THE SNOW. You cannot push a snowboard into or
//   out of the ground, only along it. There is exactly one tangent-plane
//   vector whose horizontal shadow is the correction the envelope asked for,
//   and that is the one applied — no authority is lost to a projection and
//   none is invented by a rescale. It also keeps the push out of the physics'
//   magnitude-preserving grounded redirect, which would otherwise launder a
//   component pointed into the hill back out as forward speed: a confiner that
//   accidentally boosts.
//
//   CONFINEMENT IS NOT FREE, and this module does not pretend it is. Every
//   correction takes energy out of the rider. It is priced at zero for a
//   competent player only because the layers sit outside the line a competent
//   player takes; a player who leans on the wall pays for it, by design.
//
// ---------------------------------------------------------------------------
// 3. THE LANDING LEDGER — adjudicated by the TRICK system, not by physics
//
//   Counting physics touchdowns lets the card contradict its own score.
//   physics.land() labels a touchdown from board-vs-velocity yaw and a held
//   grab; it knows nothing about uber animations, so a JA-15 bail (uber
//   incomplete at touchdown) is labelled 'clean' by physics while the trick
//   system voids the jump. A card built on the physics label reports a clean
//   landing next to a score that says otherwise.
//
//   So this ledger adjudicates every touchdown against the trick system's
//   verdict, using only the trick state's PUBLIC surface (the contract's
//   required fields — no reaching into its internals, which would bind this
//   module to one candidate in that lane):
//
//     open   on the airborne -> grounded edge; record the physics label.
//     close  when the trick system BANKS the jump — ts.lastAward becomes a new
//            object (identity change), which its reducer does on every
//            non-crash landing, points or no points, so a 0-point 'Air' still
//            counts as landed — or when LEDGER_WINDOW steps pass with no bank,
//            which is what a voided (crashed) jump looks like from outside.
//
//   LEDGER_WINDOW = 2 steps: the trick FSM freezes its verdict at the
//   touchdown step and resolves it on the following step (so a harness
//   landingOverride pass can run in between), which is 1 step; the second is
//   slack for a lane candidate that defers one more. It is deliberately short
//   — long enough to see the bank, too short to steal the NEXT jump's bank.
//
//   Both verdicts are kept. results.landed / .crashed are the TRICK system's;
//   results.verdictSplits reports how often the physics label disagreed, so
//   the disagreement is visible instead of silently resolved.
//
// ---------------------------------------------------------------------------
// 4. RESULTS — the banked award, and no invented grades
//
//   bestTrick is ts.lastAward.name: the trick system's whole banked jump
//   SUMMARY ("Frontside 360 + Grab"), which is what the player remembers and
//   what the score is actually made of — not one entry picked out of
//   ts.awards. Its banked points INCLUDE the star multiplier, and the
//   multiplier itself is recovered from the trick system's own award trail
//   (the "Nx Star Bonus" entry it appends at bank time), never re-derived
//   here. results.bestTrickStarMult carries it: the SSX money shot.
//
//   There are no grade bands and no medals. Inventing a letter ladder over an
//   unsettled speed ladder is invention wearing a hat. results.rank is null
//   with the reason attached, and results.anchors carries the REAL anchors
//   from references/REFERENCE_BAR.md (uber base 13,210-22,580; ~130K for a
//   multi-star master jump) so a reader can place a score against something
//   sourced instead of against a band this module made up.
//
// ---------------------------------------------------------------------------
// 5. SELF-CHECK
//
//   `node harness/run-runner.mjs --module sandbox/run-structure/A/run.mjs`
//   -> 10/10, moduleYawAuthority_degps = 0, maxDivergenceReached_m = 0.98,
//   maxCorrectionJump_m = 0.183 (that is the rider's own travel in one frame,
//   not a correction: this module never moves anyone), runDuration_s = 208.9 —
//   identical to the same drive with NO run module attached, because the
//   corridor never touches a competent line.
//
//   `node sandbox/run-structure/A/selftest.mjs` covers what the gate suite
//   cannot reach: the harness's adversarial drive never gets further than
//   105 m off the centre (measured, no module attached), i.e. it never touches
//   the wall or the limit, it spawns past the start gate, and it never lands a
//   trick the physics and the trick system disagree about. The self-test
//   drives all of those and asserts the outcomes; it exits non-zero on any
//   failure. All 41 assertions pass.
// ============================================================================

// --- physics anchors: live from the accepted physics module when reachable ---
// Every acceleration below is a multiple of a constant the ACCEPTED physics
// module publishes, so a physics retune moves this corridor with it. The
// pinned copy is the standalone fallback and is reported in config.
const PINNED = { V_CAP: 33, V_BOOST: 31, TAU_BOOST: 0.7, A_LAT: 26, G_GROUND: 9.81 };
let PHYS = PINNED, PHYS_SOURCE = 'pinned';
try {
  const m = await import('../../../src/physics/physics.mjs');
  if (m?.DEFAULTS && typeof m.DEFAULTS.V_CAP === 'number') {
    PHYS = { ...PINNED, ...m.DEFAULTS };
    PHYS_SOURCE = 'live';
  }
} catch { /* standalone use: keep the pinned copy, reported in config */ }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

// MEASURED constants (this session, against src/render/main.mjs terrain).
// Each one is a measurement of the world, not a preference.
const MEASURED = {
  // mean lateral slope of the analytic terrain at |s| = 120 m, both flanks,
  // z = 0..2400 step 20 -> 42.75 deg (p90 46.88)
  shoulderSlope_deg: 42.75,
  // render lane's tree line: main.mjs plants pines only at 55 < d < 720
  treeLine_m: 55,
  // widest line the harness probe drive `play` takes over a full run, with no
  // run module attached: 34.1 m (p99 30.5, p50 6.9)
  probeWidestLine_m: 34.1,
  // runner divergence probe: backdrop tiles are 1000/12 m cells and start at
  // z = -250 / z = 2750
  backdropCell_m: 1000 / 12,
  backdropZ: [-250, 2750],
  // dense divergence sweep (2 m grid, full course): worst gap inside the
  // confined set for a few candidate lateral limits
  divergenceByLimit: { 120: 1.19, 150: 1.82, 160: 2.51 },
};

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W_WALL = B.halfWidth ?? 120;             // the contract's corridor edge

  // ---------------- corridor geometry: spans first, firmness derived --------
  const W_BERM = env.bermStart_m ?? MEASURED.treeLine_m;
  // largest lateral limit whose worst divergence over the confined set is at
  // most half of RS-05's 4 m ceiling (150 -> 1.82 m; 160 -> 2.51 m fails)
  const L_LAT = env.lateralLimit_m ?? 150;
  const Z_DOWN = MEASURED.backdropZ[1] - MEASURED.backdropCell_m;   // 2666.67
  const Z_UP = MEASURED.backdropZ[0] + MEASURED.backdropCell_m;     // -166.67

  // ---------------- the one law: A = V_CAP^2 / (2 * span) -------------------
  const V_CAP = PHYS.V_CAP;
  const G = PHYS.G_GROUND;
  const firmness = span => (V_CAP * V_CAP) / (2 * Math.max(span, 1e-6));
  const A_WALL = firmness(L_LAT - W_WALL);        // 18.15 m/s^2 over 30 m
  const A_DOWN = firmness(Z_DOWN - zFinish);      //  2.04 m/s^2 over 266.7 m
  const A_UP = firmness(zStart - Z_UP);           //  3.27 m/s^2 over 166.7 m

  // ---------------- berm: the terrain's own shoulder, continued -------------
  const A_BERM = G * Math.sin(MEASURED.shoulderSlope_deg * DEG);   // 6.66

  // ---------------- hard limit + the ceiling on every correction -----------
  // DRIVE_MAX: boost is a relaxation toward V_BOOST with time constant
  // TAU_BOOST, so at rest it delivers V_BOOST/TAU_BOOST, aimed wherever the
  // board points — the strongest outward acceleration a player can command.
  const DRIVE_MAX = PHYS.V_BOOST / PHYS.TAU_BOOST;                 // 44.29
  // A_RETURN out-pulls that plus gravity, so past the hard limit the rider is
  // returned rather than merely slowed (see the HARD LIMIT note in confine()).
  const A_RETURN = DRIVE_MAX + G;                                  // 54.10
  // and the field is never allowed more than the firmest envelope plus that.
  const A_CEIL = A_WALL + A_RETURN;                                // 72.25

  const COUNTDOWN_S = env.countdown_s ?? 3;      // 3 - 2 - 1 - GO (presentation)
  const SPLITS = 3;                              // checkpoints down the course
  const LEDGER_WINDOW = 2;                       // steps; see header section 3

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth: W_WALL,
    maxDivergence_m: 4,
    // ---- corridor ----
    bermStart_m: W_BERM, wallStart_m: W_WALL, lateralLimit_m: L_LAT,
    zLimitDown_m: Z_DOWN, zLimitUp_m: Z_UP,
    runout_m: Z_DOWN - zFinish, backstop_m: zStart - Z_UP,
    bermAccel_mps2: A_BERM, wallFirmness_mps2: A_WALL,
    runoutFirmness_mps2: A_DOWN, backstopFirmness_mps2: A_UP,
    driveMax_mps2: DRIVE_MAX, returnAccel_mps2: A_RETURN, ceilAccel_mps2: A_CEIL,
    // ---- run ----
    countdown_s: COUNTDOWN_S, splitCount: SPLITS, ledgerWindow_steps: LEDGER_WINDOW,
    // ---- provenance ----
    physicsAnchor: PHYS_SOURCE,
    measured: MEASURED,
    derivation: {
      law: 'every hard boundary is one braking envelope, v_allow = sqrt(2*A*gap), zero exactly at the limit; A is forced by v_allow(span) = V_CAP so the envelope imposes nothing where its layer starts',
      discreteForm: 'v_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*gap) — solved for the step actually taken, so the limit cannot be crossed at any dt',
      lateralLimit: 'MEASURED: largest lateral offset whose worst mesh-vs-physics divergence over the whole confined set is <= half RS-05\'s 4 m ceiling (150 m -> 1.82 m; 160 m -> 2.51 m fails)',
      zLimits: 'MEASURED: divergence steps from <0.4 m to 8.6 m across the backdrop boundary (z = -250 / 2750); limits pulled one full backdrop cell (1000/12 m) inside it so the probe\'s bilinear cell lies wholly in the fine LOD region',
      wallFirmness: 'V_CAP^2 / (2 * (lateralLimit - halfWidth))',
      runoutFirmness: 'V_CAP^2 / (2 * (zLimitDown - zFinish))',
      backstopFirmness: 'V_CAP^2 / (2 * (zStart - zLimitUp))',
      bermAccel: 'g * sin(42.75 deg), the MEASURED mean lateral slope of the analytic terrain at |s| = halfWidth; the berm adds exactly the restoring pull the ground there already has. 26% of the physics A_LAT ceiling, so full lock still overrules it',
      bermStart: 'the render lane\'s tree line (main.mjs plants pines only at 55 < d < 720), and 1.6x the widest line the probe drive measures (34.1 m) — which is why the corridor never fires in ordinary play',
      returnAccel: 'DRIVE_MAX + g: the hard limit must out-pull the strongest outward acceleration the world can apply (boost drive V_BOOST/TAU_BOOST, aimed anywhere the board points) plus gravity, or a braked rider still creeps outward by (DRIVE_MAX+g)*dt^2 every frame',
      ceilAccel: 'A_WALL + A_RETURN: the firmest envelope plus the return authority, and not one m/s^2 more — anything beyond this is authority with no argument behind it',
      gate: 'the closed gate is the back-stop envelope with its limit moved to zStart; it can only touch a rider who is behind the line, and the harness spawns 15 m past it, so it never engages (rs.confine.gateFrames)',
      rank: 'absent by decision: no defensible speed ladder exists yet, and a grade band over an unsettled ladder is invention. results.anchors carries the sourced anchors instead',
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
  const cxPrime = z => (cx(z + 25) - cx(z - 25)) / 50;

  // Terrain normal by central difference on the SAME 0.05 m stencil the
  // physics module's default sampleNormal uses, so the plane this module
  // pushes along is exactly the plane physics will project the result against.
  function normalAt(x, z) {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  }

  // THE ENVELOPE, discrete-safe: the fastest approach rate that can still be
  // brought to zero exactly at the limit, allowing for the step about to be
  // taken. Zero at and beyond the limit.
  function allowance(gap, A, dt) {
    if (gap <= 0) return 0;
    return -A * dt + Math.sqrt(A * A * dt * dt + 2 * A * gap);
  }

  // Berm profile: quadratic in depth across the shoulder — zero (and with zero
  // slope, so C1-continuous) at the tree line, A_BERM at the corridor edge,
  // held at A_BERM beyond it.
  function bermAccel(over, span) {
    if (over <= 0) return 0;
    const q = clamp(over / span, 0, 1);
    return A_BERM * q * q;
  }

  function init() {
    return {
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
      gateOpen: false,
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
      landed: 0,              // touchdowns the TRICK system banked
      crashed: 0,             // touchdowns the TRICK system voided
      verdictSplits: 0,       // touchdowns where physics disagreed with tricks
      unresolvedTouchdowns: 0,// touchdowns the clock beat to the finish line
      bestTrick: null,
      bestTrickPoints: 0,
      bestTrickStarMult: 1,
      lastTrick: null,
      banks: 0,
      // ---- confinement telemetry (self-measured, not self-reported) ----
      confine: {
        active: false,          // any corrective accel this frame
        depth_m: 0,             // how far outside the corridor edge, this frame
        accel_mps2: 0,          // magnitude of the corrective accel this frame
        peakBerm_mps2: 0,
        peakWallRequest_mps2: 0,// what the envelope ASKED for (may exceed A_CEIL
                                // after a one-frame velocity injection)
        peakApplied_mps2: 0,    // what was actually applied, always <= A_CEIL
        peakDepth_m: 0,
        peakOffset_m: 0,        // widest line the rider has taken
        bermFrames: 0,
        wallFrames: 0,
        limitFrames: 0,         // hard-limit layer engaged (want 0)
        gateFrames: 0,          // closed gate held the rider (want 0 in-harness)
        ceilFrames: 0,          // the A_CEIL ceiling actually bound (want 0)
        activeFrames: 0,
        totalFrames: 0,
        activeFraction: 0,
        maxSelfVelDelta_mps: 0, // largest velocity change the module has made
        selfPosDelta_m: 0,      // identically 0: the module never writes pos
        maxSelfPosDelta_m: 0,   // ... published so that is checkable
      },
      // ---- internals ----
      _t: 0,                  // total elapsed sim time, all phases
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
      _prevAward: null,
      _prevAwardsLen: 0,
      _ledger: null,          // open touchdown awaiting the trick verdict
    };
  }

  // ------------------------------------------------------------------ results
  // The one place a card is built. `live` is the in-progress readback the HUD
  // shows; the frozen card handed out after the finish is the SAME function
  // called once, so the two can never drift apart.
  function assemble(rs, ts, live) {
    const t = ts ?? {};
    return {
      // ---- contract-required six ----
      time_s: +rs.time_s.toFixed(3),
      score: t.score ?? 0,
      bestTrick: rs.bestTrick,
      tricky: !!t.tricky,
      landed: rs.landed,
      crashed: rs.crashed,
      // ---- the banked award, in full ----
      bestTrickPoints: Math.round(rs.bestTrickPoints),
      bestTrickStarMult: rs.bestTrickStarMult,
      lastTrick: rs.lastTrick ? { ...rs.lastTrick } : null,
      banks: rs.banks,
      trickyLetters: t.trickyLetters ?? 0,
      meter: +(t.meter ?? 0).toFixed(3),
      // ---- the run ----
      place: rs.place,
      jumps: rs.jumps,
      verdictSplits: rs.verdictSplits,
      unresolvedTouchdowns: rs.unresolvedTouchdowns,
      topSpeed_kmh: +rs.topSpeed_kmh.toFixed(1),
      avgSpeed_kmh: rs.time_s > 0 ? +(3.6 * rs.distanceRidden_m / rs.time_s).toFixed(1) : 0,
      airTime_s: +rs.airTime_s.toFixed(2),
      biggestAir_s: +rs.biggestAir_s.toFixed(2),
      distanceRidden_m: Math.round(rs.distanceRidden_m),
      courseLength_m: zFinish - zStart,
      splits: rs.splits.map(sp => ({ index: sp.index, z: sp.z, t: +sp.t.toFixed(3) })),
      // ---- how the module behaved, on the card, not just in the state ----
      confinement: {
        activeFraction: +rs.confine.activeFraction.toFixed(5),
        peakOffset_m: +rs.confine.peakOffset_m.toFixed(1),
        peakApplied_mps2: +rs.confine.peakApplied_mps2.toFixed(2),
        bermFrames: rs.confine.bermFrames,
        wallFrames: rs.confine.wallFrames,
        limitFrames: rs.confine.limitFrames,
        ceilFrames: rs.confine.ceilFrames,
        maxSelfPosDelta_m: rs.confine.maxSelfPosDelta_m,
      },
      // ---- no letter grade, no medal: sourced anchors instead ----
      rank: null,
      rankReason: live ? 'run in progress'
        : 'no defensible speed ladder yet — see config.derivation.rank',
      anchors: {
        uberBaseMin: 13210, uberBaseMax: 22580, masterJumpAnchor: 130000,
        source: 'references/REFERENCE_BAR.md §5 (Uber Trick Guide table; 20,960 x2 x3 ~ 130K master jump)',
      },
    };
  }

  // ------------------------------------------------------------- observation
  // Read-only on both systems.
  function observe(rs, ph, ts, dt) {
    // --- airtime ---
    const air = !ph.onGround;
    if (air) {
      rs._airRun += dt;
      rs.airTime_s += dt;
      if (rs._airRun > rs.biggestAir_s) rs.biggestAir_s = rs._airRun;
      if (!rs._wasAir) rs.jumps++;
    } else rs._airRun = 0;

    // --- landing ledger (header section 3) ---
    // open on the airborne -> grounded edge
    if (rs._wasAir && !air) {
      if (rs._ledger) closeLedger(rs, false);   // bounce inside the window
      rs._ledger = { steps: 0, physVerdict: ph.landing ?? null };
    }
    rs._wasAir = air;

    // --- banked tricks. The trick system's reducer replaces ts.lastAward with
    //     a NEW object on every non-crash landing (points or no points) and
    //     nulls it on a crash, so an identity change is exactly one bank. ---
    const la = ts?.lastAward ?? null;
    const awards = ts?.awards ?? [];
    let banked = false;
    if (la && la !== rs._prevAward) {
      banked = true;
      rs.banks++;
      // recover the star multiplier from the trick system's own award trail
      // (the "Nx Star Bonus" entry it appends at bank time) — never re-derived
      let mult = 1;
      for (let i = rs._prevAwardsLen; i < awards.length; i++) {
        const m = /^(\d+)x Star Bonus$/.exec(awards[i]?.name ?? '');
        if (m) mult = Math.max(mult, +m[1]);
      }
      rs.lastTrick = { name: la.name, points: la.points, starMult: mult, at_s: +rs.time_s.toFixed(3) };
      if (rs.bestTrick === null || la.points > rs.bestTrickPoints) {
        rs.bestTrick = la.name;
        rs.bestTrickPoints = la.points;
        rs.bestTrickStarMult = mult;
      }
    }
    rs._prevAward = la;
    rs._prevAwardsLen = awards.length;

    // resolve the open touchdown against that verdict
    if (rs._ledger) {
      if (banked) closeLedger(rs, true);
      else if (++rs._ledger.steps > LEDGER_WINDOW) closeLedger(rs, false);
    }

    // --- speed / distance ---
    const v = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_kmh = v * 3.6;
    if (rs.speed_kmh > rs.topSpeed_kmh) rs.topSpeed_kmh = rs.speed_kmh;
    if (rs._prevPos) {
      rs.distanceRidden_m += Math.hypot(ph.pos[0] - rs._prevPos[0], ph.pos[2] - rs._prevPos[2]);
      rs._prevPos[0] = ph.pos[0]; rs._prevPos[1] = ph.pos[1]; rs._prevPos[2] = ph.pos[2];
    } else rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
  }

  // The trick system banked it -> landed; it never did -> the jump was voided.
  // The physics label is kept only to report the disagreement.
  function closeLedger(rs, bankedIt) {
    const L = rs._ledger;
    rs._ledger = null;
    if (!L) return;
    if (bankedIt) rs.landed++; else rs.crashed++;
    const physSaysClean = L.physVerdict !== 'crash' && L.physVerdict !== null;
    if (physSaysClean !== bankedIt) rs.verdictSplits++;
  }

  // ----------------------------------------------------------- confinement
  // Applies bounded ACCELERATIONS in corridor coordinates. Never writes
  // position, heading, or any physics flag.
  //
  // COORDINATES. s = x - centreX(z) is the lateral offset (the coordinate the
  // divergence measurements above are stated in) and z is down-course progress
  // (the coordinate the finish line and the z-limits are stated in), with
  // k = centreX'(z). Their rates are
  //     ds/dt = vx - k*vz        dz/dt = vz
  // so a correction that must produce a given (d2s/dt2, d2z/dt2) has exactly
  // one horizontal solution:
  //     az = (d2z/dt2)           ax = (d2s/dt2) + k * az
  // The module solves that, rather than pushing along a normal and hoping: a
  // decomposition onto corridor normal/tangent unit vectors delivers only
  // 1/sqrt(1+k^2) of what it asks for (12% short where the course meanders
  // hardest), and that shortfall is exactly the kind of quiet slack that lets
  // a "guarantee" be violated. A purely lateral correction here leaves dz/dt
  // untouched by construction.
  function confine(rs, ph, dt, gateClosed) {
    const c = rs.confine;
    c.totalFrames++;
    c.active = false; c.accel_mps2 = 0; c.depth_m = 0;

    const x = ph.pos[0], z = ph.pos[2];
    const s = x - cx(z);                 // lateral offset
    const k = cxPrime(z);

    const sAbs = Math.abs(s), out = s >= 0 ? 1 : -1;   // `out` = outward sign
    if (sAbs > c.peakOffset_m) c.peakOffset_m = sAbs;
    const sRate = (ph.vel[0] - k * ph.vel[2]) * out;   // outward rate, +ve = leaving
    const zRate = ph.vel[2];

    // ---- 1. BERM: restoring, grounded only (a berm is ground) --------------
    let aOut = 0;                                       // outward accel, -ve = inward
    if (ph.onGround) {
      const berm = bermAccel(sAbs - W_BERM, W_WALL - W_BERM);
      if (berm > 0) {
        aOut -= berm;
        c.bermFrames++;
        if (berm > c.peakBerm_mps2) c.peakBerm_mps2 = berm;
      }
    }

    // ---- 2. WALL: the braking envelope, over the excess only ---------------
    if (sAbs > W_WALL) {
      const excess = sRate - allowance(L_LAT - sAbs, A_WALL, dt);
      if (excess > 0) {
        aOut -= excess / dt;
        c.wallFrames++;
        if (excess / dt > c.peakWallRequest_mps2) c.peakWallRequest_mps2 = excess / dt;
      }
      c.depth_m = sAbs - W_WALL;
      if (c.depth_m > c.peakDepth_m) c.peakDepth_m = c.depth_m;
    }

    // ---- 3. HARD LIMIT: a wall pushes back; braking alone only creeps ------
    //   The envelope is read once per frame, AFTER physics has already moved
    //   the rider, so between one clamp and the next the world adds up to
    //   (DRIVE_MAX + g) * dt of outward rate — 1.5 cm of creep per frame at
    //   60 Hz. Zero allowance stops the rider going out fast; it does not stop
    //   them going out. So past the limit the field applies a RESTORING
    //   acceleration that out-pulls everything the world can push with:
    //   A_RETURN = DRIVE_MAX + g. Ground or air — beyond here the alternative
    //   is a rider falling through the rendered world.
    if (sAbs > L_LAT) {
      aOut -= A_RETURN;
      c.limitFrames++;
    }

    // ---- down-course: run-out past the finish, back-stop behind the start,
    //      and the closed gate (the back-stop with its limit at zStart) ------
    let aZ = 0;
    const limitDown = gateClosed ? zStart : Z_DOWN;
    const firmDown = gateClosed ? A_UP : A_DOWN;
    if (gateClosed || z > zFinish) {
      const excess = zRate - allowance(limitDown - z, firmDown, dt);
      if (excess > 0) {
        aZ -= excess / dt;
        if (gateClosed) c.gateFrames++; else c.wallFrames++;
        c.depth_m = Math.max(c.depth_m, z - limitDown);
      }
      if (z > limitDown) { aZ -= A_RETURN; c.limitFrames++; }
    }
    if (z < zStart) {
      const excess = (-zRate) - allowance(z - Z_UP, A_UP, dt);
      if (excess > 0) { aZ += excess / dt; c.wallFrames++; }
      if (z < Z_UP) { aZ += A_RETURN; c.limitFrames++; }
    }

    if (aOut === 0 && aZ === 0) {
      c.activeFraction = c.activeFrames / c.totalFrames;
      rs.outOfBounds = false;
      return;
    }

    // ---- assemble the world-space correction (exact solve, see above) ------
    let uz = aZ;
    let ux = aOut * out + k * aZ;
    let uy = 0;

    if (ph.onGround) {
      // You cannot push a board into or out of the snow, only along it. There
      // is exactly one tangent-plane vector whose horizontal shadow is the
      // correction the envelope asked for, so take that one — no authority is
      // lost to the projection and none is invented. It also keeps the push
      // out of the physics' magnitude-preserving redirect, which would
      // otherwise launder a component into the hill back out as forward speed:
      // a confiner that accidentally boosts.
      const n = normalAt(x, z);
      if (n[1] > 1e-3) uy = -(ux * n[0] + uz * n[2]) / n[1];
    }

    // ---- the ceiling on everything this module may do ----------------------
    let am = Math.hypot(ux, uy, uz);
    if (am > A_CEIL) { const f = A_CEIL / am; ux *= f; uy *= f; uz *= f; am = A_CEIL; c.ceilFrames++; }

    ph.vel[0] += ux * dt; ph.vel[1] += uy * dt; ph.vel[2] += uz * dt;

    const dv = am * dt;
    if (dv > c.maxSelfVelDelta_mps) c.maxSelfVelDelta_mps = dv;
    if (am > c.peakApplied_mps2) c.peakApplied_mps2 = am;
    c.accel_mps2 = am;
    c.active = true;
    c.activeFrames++;
    c.activeFraction = c.activeFrames / c.totalFrames;
    // outOfBounds is raised for EVERY frame the module touches the rider — the
    // gentlest berm frame included — so an auditor sees every frame in which
    // this module could possibly have moved them.
    rs.outOfBounds = true;
  }

  // ------------------------------------------------------------------ step
  function step(rs, physState, trickState, dt) {
    const ph = physState;
    if (!ph || !dt) return rs;
    rs._t += dt;

    // ---------- ready: the clock reads 0 and the gate is a line -------------
    if (rs.phase === 'ready') {
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.gateOpen = rs.countdown_s <= 0;
      rs.light = rs.countdown_s > COUNTDOWN_S / 3 ? 'red' : rs.countdown_s > 0 ? 'set' : 'go';
      rs.progress = 0;
      if (ph.pos[2] >= zStart) {          // crossed the line: the run is on
        rs.phase = 'running'; rs.stage = 'running'; rs.light = 'go';
        rs.gateOpen = true;
        rs.time_s = 0;
        rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
        rs.nextSplit = 0; rs.splits = [];
      } else {
        // still behind the line: the corridor holds, and while the countdown
        // runs its down-course limit sits on the start line (the closed gate)
        confine(rs, ph, dt, !rs.gateOpen);
        return rs;
      }
    }

    // ---------- running: clock, telemetry, splits, finish, corridor ---------
    if (rs.phase === 'running') {
      rs.time_s += dt;
      observe(rs, ph, trickState, dt);
      rs.progress = clamp((ph.pos[2] - zStart) / (zFinish - zStart), 0, 1);

      while (rs.nextSplit < SPLITS - 1) {
        const zc = zStart + ((rs.nextSplit + 1) / SPLITS) * (zFinish - zStart);
        if (ph.pos[2] < zc) break;
        rs.splits.push({ index: rs.nextSplit + 1, z: Math.round(zc), t: rs.time_s });
        rs.nextSplit++;
      }

      // FINISH — tested before the corridor, so the crossing frame is the
      // frame that reports 'finished' and the run-out can never block it.
      if (ph.pos[2] >= zFinish) {
        rs.splits.push({ index: SPLITS, z: zFinish, t: rs.time_s });
        rs.progress = 1;
        // a touchdown in the last two frames has not been adjudicated yet, and
        // the card freezes here — count it as neither landed nor crashed, and
        // say so on the card rather than guessing a verdict
        if (rs._ledger) { rs.unresolvedTouchdowns++; rs._ledger = null; }
        const res = assemble(rs, trickState, false);
        for (const sp of res.splits) Object.freeze(sp);
        Object.freeze(res.splits); Object.freeze(res.anchors);
        Object.freeze(res.confinement);
        if (res.lastTrick) Object.freeze(res.lastTrick);
        rs.results = Object.freeze(res);
        rs.finished = true;
        rs.phase = 'finished'; rs.stage = 'finished';
      }
      confine(rs, ph, dt, false);
      return rs;
    }

    // ---------- finished: clock frozen, card frozen, corridor still holds ---
    rs.speed_kmh = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6;
    confine(rs, ph, dt, false);
    return rs;
  }

  // Frozen after the finish; a live readback of the same shape before it, so
  // the HUD can show a running card mid-run.
  function results(rs, trickState) {
    return rs.results ?? assemble(rs, trickState, true);
  }

  // Full deterministic reset: every field is rebuilt from init(), in place.
  function restart(rs) {
    const fresh = init();
    for (const k of Object.keys(rs)) delete rs[k];
    Object.assign(rs, fresh);
    return rs;
  }

  return { config, init, step, results, restart };
}
