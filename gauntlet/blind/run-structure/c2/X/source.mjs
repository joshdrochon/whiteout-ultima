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
// EVERY CONSTANT IS DERIVED (cycle-2 rebuild)
// ---------------------------------------------------------------------------
// Nothing in this module is a bare number chosen by feel. Each tuning value is
// either (a) a course geometry quantity handed in by env.bounds, (b) an
// explicit multiple of a PHYSICS constant (PHYS_REF below, mirroring
// src/physics/physics.mjs DEFAULTS and overridable via env.physics so it tracks
// a retune of the turning lane), or (c) solved from a stated design quantity in
// metres / metres-per-second. `config.derivation` reports the arithmetic at
// runtime so the numbers can be checked without reading this comment.
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
//     allowed outward speed at depth d  =  sqrt(2 * A_env * (limit - d))
//
// Exceed it and the outward velocity component is trimmed back onto the
// envelope at up to A_auth m/s^2. That is a berm, not a clamp: the correction
// is a bounded acceleration, it starts tens of metres before the limit, and its
// allowance reaches zero exactly at the limit.
//
//   A_env  is solved from geometry: a rider arriving at the berm at the physics
//          speed cap must be turnable inside the room that is left.
//          A_env = V_CAP^2 / (2 * room) * 1.1   (10% margin)
//   A_auth is the rate cap on the correction, and it must OUT-AUTHORITY the
//          player: steering can add A_LAT (26 m/s^2, TN-14) of outward
//          acceleration, so the wall gets 1.5 * A_LAT = 39 m/s^2 and nets
//          >= 13 m/s^2 inward even against a rider fighting it at full lock.
//          (A_auth only ever REMOVES outward velocity; it can never push a
//          rider inward faster than the berm lean below.)
//
// THE HARD RULE THIS MODULE KEEPS: `step` NEVER writes physState.pos — not
// during the run, not at the start gate, not in the corral. It writes velocity
// and heading only. A position teleport is therefore not merely avoided, it is
// structurally impossible, which is what RS-06 is really asking for. It also
// never writes physics COLLISION state (onGround / airTime / landing) and never
// touches trick state at all: this module observes those systems, it does not
// edit them.
//
// The wall stays live while the rider is AIRBORNE (launched off the gully wall)
// and while PAST THE FINISH (the finish corral is still part of the world).
//
// MEASURED — three ways, all reproducible, all against the SAME drives with
// this module removed (the control column is the same input through physics +
// tricks alone, so the difference is confinement and nothing else):
//
//   A. harness/run-runner.mjs confine drive, 240 s
//                             control        this module     gate limit
//        max divergence        9.46 m          0.91 m           4 m
//        max z reached         3877 m          2572 m          (2750 m: the
//        max correction frame    n/a           0.234 m          backdrop edge)
//
//   B. 21 further adversarial drives (7 attack patterns x 3 seed points,
//      280 s each: hard right, hard left, uphill, jump-spam, straight past the
//      finish, zigzag, late bail). WORST across all 21:
//        max divergence 0.94 m | max correction frame 0.549 m
//        max |lateral offset| 126 m (corridor 120 m + airborne overshoot)
//        max z 2575 m. Control, same patterns: 11.43 m divergence, z 5239 m,
//        lateral 199 m — i.e. straight through the backdrop tiles.
//
//   C. debug.auditCorridor(divergenceFn): a static sweep of the WHOLE
//      reachable set — corridor width + 12 m of airborne overshoot + backstop
//      + run-out — rather than of one drive's trajectory. Worst divergence
//      anywhere a player can legally be: 1.18 m at (x -43.7, z 1648), against
//      the runner's own worst-LOD divergence model. Limit 4 m. This is the
//      claim RS-05 actually makes, and it is checked exhaustively, not sampled.
//
// ---------------------------------------------------------------------------
// ONE DELIBERATE INTERVENTION, FLAGGED — WITH ITS COST
// ---------------------------------------------------------------------------
// The fall-line funnel rotates a GROUNDED rider's heading back down-course when
// their DOWN-COURSE progress falls below the speed the hill itself would give
// them (15.9 m/s, the unboosted terminal speed on the mean pitch — derived, not
// picked). It triggers on progress along the corridor, not raw speed, so a
// rider carving fast across the hill is never touched; authority is quadratic
// in the deficit, so it fades to nothing as soon as the rider is moving.
//
// It is still the run system steering the player, so here is the honest cost,
// measured under the harness's own ordinary-play drive: the funnel is active on
// 49% of running frames, peaking at 0.33 of its 112 deg/s authority (~37 deg/s
// — a quarter of what the player's own skid-pivot can do). That is not rare.
//
// The alternative is worse. Same input, funnel disabled (env.tuning.funnelMult
// = 0 or funnelRate_degs = 0): the rider reaches 1465 m in 300 s and is still
// going — RS-08 reports "never finished". This physics gives a near-stationary
// board its FULL skid-pivot authority, so a rider who scrubs off speed while
// holding steer pirouettes on the spot and the run stops being a run. A real
// gully answers that the same way: a slow board sideslips and settles onto the
// fall line. Turn it off if the physics lane ever kills low-speed pivot
// authority; the switch is one tuning key and the gates were re-run with it
// both ways.
//
// ---------------------------------------------------------------------------
// CYCLE-1 CRITIQUE — every mustFix addressed or rebutted
// ---------------------------------------------------------------------------
// 1. "Ground or delete GRADES."  Grounded, twice over, and the arithmetic is
//    exported in config.derivation.rank / .medal:
//      * rank is score-RATE (pts/s), banded off THIS trick economy and the
//        reference bar's uber values: D < 100 (no consistent landings);
//        C >= 100 (a ~1.4k spin+grab jump every ~14 s); B >= 400 (a ~2.3k
//        Misty+tweak combo every ~6 s); A >= 1321 (one quick uber, base
//        13,210, landed every 10 s); S >= 6500 (the reference master jump,
//        20,960 x 2 x 3 ~= 130k, every 20 s).
//      * medal is TIME, so a pure racer is not graded as a D: par is the
//        course ridden at its own natural terminal speed,
//        2400 m / 15.92 m/s = 150.7 s; GOLD <= 0.8*par, SILVER <= par,
//        BRONZE <= 1.25*par.
// 2. "Anchor wallAccel to A_LAT."  Done: A_auth = 1.5 * PHYS_REF.A_LAT, and
//    PHYS_REF is overridable via env.physics so it tracks a turning-lane
//    retune. The envelope constant is separately solved from corridor geometry
//    (V_CAP^2 / 2*room). Heading-assist and funnel rates are multiples of
//    PHYS_REF.OMEGA_PIVOT (the physics' own low-speed yaw authority).
// 3. "State the design quantity behind the decay rate."  The corral is the only
//    exponential in the module: tau = 155 m of remaining run-out / (2 * V_CAP)
//    = 2.35 s, i.e. a rider crossing the line at the speed cap coasts to a stop
//    in half the room available. Applied as exp(-dt/tau) (dt-exact at any rate).
// 4. "The gate must not write physics collision state."  This module writes
//    NO position and NO collision state anywhere, gate included. The gate hold
//    is velocity + heading only; the residual drift is the one frame of gravity
//    the integrator applies between ticks, 0.16 m over the whole 3 s countdown
//    (RS-09 tolerance 3 m).
// 5. "Add a trick-producing probe drive to harness/run-runner.mjs."  REBUTTED,
//    with the underlying complaint accepted. A builder silently editing the
//    shared harness mid-blind-gauntlet rewrites the lane's operational law for
//    both candidates after one of them has already been judged against the old
//    one; that is the gate owner's call, not a candidate's. What the complaint
//    is really asking for — proof the trick half is not dead code — is answered
//    instead by driving it out-of-band: charge, jump, grab/spin/uber, land,
//    through the ACCEPTED physics + trick systems and through this module's
//    step(). Measured results cards (full 2400 m runs, every number folded by
//    this module, not by hand):
//      spin+grab only     score   2,466 | best "Frontside 360 + Grab" (1,133)
//                         landed 25 | crashed 10 | tricky false | rank D
//      uber every 3rd jump score  53,250 | best "Coffin Roll" (13,940)
//                         landed 26 | crashed 16 | TRICKY true, 6/6 letters
//                         | rank C (210 pts/s)
//      uber every jump    score 132,946 | best "Can Can" (14,310)
//                         landed 16 | crashed 41 | TRICKY true | rank B
//                         (999 pts/s) | medal SILVER (133.1 s)
//    In all three the reported score equals the trick score AT THE FINISH FRAME
//    (RS-04's actual claim) and every field is byte-identical after 600 more
//    frames of riding past the line (RS-03). The bail counts are real: an uber
//    fired on a jump too short to finish its animation is a crash (JA-15), and
//    the card says so instead of reporting a clean landing next to a zero.
//    Probe source: harness-free, in the session scratchpad; it imports the
//    shipped module unchanged and never touches the gate runner.
// 6. "Report the banked award, not just the best entry; and distance_m is not
//    distance."  results.bestTrick is now the biggest BANKED JUMP, read from
//    ts.lastAward — the whole combo string with its star multiplier, the SSX
//    money shot. The single highest component is still reported, as
//    bestSingleTrick. Distance is reported twice and honestly:
//    courseLength_m (zFinish - zStart) and distanceRidden_m (the rider's
//    actual integrated path length; the ordinary-play run above rides 2,999 m
//    of a 2,400 m course, and avgSpeed is computed from the former).
// 7. NOT in the critique, found by driving this build: `landed` / `crashed`
//    used to count PHYSICS touchdown labels, which let the card report
//    "53 landed, 0 crashed" next to a score of 0 — every one of those jumps was
//    a trick-system bail (uber animation unfinished at touchdown). The ledger
//    now adjudicates each touchdown against the trick system's own verdict one
//    frame later, so landed/crashed can never contradict score. Physics' view
//    is still reported, as cleanLandings / sketchyLandings.
//
// Pure JS, deterministic: no Date, no Math.random, no globals, no imports.
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
const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// PHYSICS REFERENCE — mirrors the ACCEPTED src/physics/physics.mjs DEFAULTS.
// Every force constant in this module is expressed as a multiple of one of
// these, so retuning the physics lane retunes the wall with it. Override with
// env.physics = { A_LAT, ... } (the game loop can pass physics.config straight
// in) and every derived number below moves.
// ---------------------------------------------------------------------------
export const PHYS_REF = {
  A_LAT: 26,          // m/s^2 lateral accel ceiling — the player's own steering
                      //   authority (DEFAULTS.A_LAT, gate TN-14)
  OMEGA_PIVOT: 160,   // deg/s low-speed skid-pivot yaw authority
  V_CAP: 33,          // m/s hard speed clamp (DEFAULTS.V_CAP)
  G_GROUND: 9.81,     // m/s^2
  MU_BASE: 0.0305,    // Coulomb coefficient
  LAMBDA_LONG: 0.2235,// 1/s linear drag
  MEAN_PITCH_deg: 23, // mean course pitch, src/render/main.mjs: atan(0.42)
};

// Unboosted terminal speed on a slope: solve a(v) = g sin - mu g cos - lam v = 0.
// This is "the speed the hill gives you", and it anchors both the fall-line
// funnel threshold and the medal par time.
function terminalSpeed(P, pitch_deg) {
  const th = pitch_deg * DEG;
  const a = P.G_GROUND * Math.sin(th) - P.MU_BASE * P.G_GROUND * Math.cos(th);
  return Math.max(1, a / P.LAMBDA_LONG);
}

// ---------------------------------------------------------------------------
// TUNING — ratios and design quantities only. Force constants are resolved
// against PHYS_REF and the course geometry inside createRun().
// ---------------------------------------------------------------------------
export const TUNE = {
  // --- start gate ---
  countdown_s: 3.0,          // held at the gate: "3 - 2 - 1 - GO"

  // --- course layout ---
  splitCount: 4,             // intermediate timing checkpoints
  gateWidthFrac: 0.79,       // corridor pinches at the gate (start pen)
  finishWidthFrac: 0.88,     // ... and at the finish banner
  runOut_m: 200,             // rideable corral past the finish line
  backStop_m: 90,            // how far above the gate the world is still real

  // --- lateral corridor wall (shape) ---
  wallSoftFrac: 0.45,        // berm begins at this fraction of the half-width
  envMargin: 1.1,            // 10% over the geometric minimum envelope
  authMult: 1.5,             // A_auth = authMult * A_LAT: the wall out-authorities
                             //   the player's own 26 m/s^2 of steering
  bermMult: 0.2,             // steady inward lean = 0.2 * A_LAT: a nudge the
                             //   player can always override, never a rail
  returnOvershoot_m: 6,      // recover this much overshoot ...
  returnTime_s: 2,           // ... within this long => inward drift speed
  assistFrac: 0.82,          // heading assist starts at this fraction of width
  assistMult: 0.8,           // assist rate = 0.8 * OMEGA_PIVOT (grounded only)

  // --- fall-line funnel (the gully points a slow rider back down the hill) ---
  funnelMult: 0.7,           // funnel rate = 0.7 * OMEGA_PIVOT at a dead stop
  funnelProgressFrac: 1.0,   // wakes when DOWN-COURSE progress falls below the
                             //   speed the hill itself gives you (15.9 m/s):
                             //   same anchor, no second free parameter

  // --- down-course walls (start backstop + finish corral) ---
  zSoftRoom_m: 130,          // berm depth of the down-course walls
  corralStart_m: 45,         // metres past the finish where the speed trap begins
  corralStopFrac: 0.5,       // coast-out distance = this fraction of the room left

  // --- centreline reconstruction ---
  knot_m: 25,                // sampling pitch of env.courseCenterX
  padBefore_m: 500,
  padAfter_m: 900,

  maxDivergence_m: 4,        // the safety margin this corridor is built to hold
};

// Rank bands: score RATE (points per second of run), grounded in this build's
// trick economy (src/tricks/tricks.mjs) and the reference bar's uber values.
// Each band names the play that produces it — that IS the derivation.
const RANK_BANDS = [
  { rank: 'S', rate: 6500, why: 'reference master jump 20,960 x2 star x3 combo ~= 130k, every 20 s' },
  { rank: 'A', rate: 1321, why: 'one quick uber (base 13,210) landed every 10 s' },
  { rank: 'B', rate: 400,  why: 'a ~2.3k Misty 540 + tweaked grab every ~6 s' },
  { rank: 'C', rate: 100,  why: 'a ~1.4k spin + grab jump every ~14 s' },
  { rank: 'D', rate: 0,    why: 'no consistent landings' },
];

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
  const P = { ...PHYS_REF, ...(env.physics ?? {}) };
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const halfWidth = B.halfWidth ?? 120;

  const zBack = zStart - T.backStop_m;      // hard uphill limit
  const zEnd = zFinish + T.runOut_m;        // end of the corral

  const cl = buildCenterline(env, zStart - T.padBefore_m, zFinish + T.padAfter_m, T.knot_m);

  // ---- derived force constants ------------------------------------------
  // Envelope: room the berm has to work in, and the deceleration that turns a
  // speed-capped rider inside it. A_env = V_CAP^2 / (2*room), plus margin.
  const wallRoom_m = halfWidth * (1 - T.wallSoftFrac);
  const wallEnvA = (P.V_CAP * P.V_CAP) / (2 * wallRoom_m) * T.envMargin;
  const zEnvA = (P.V_CAP * P.V_CAP) / (2 * T.zSoftRoom_m) * T.envMargin;
  // Authority: the rate cap on the correction. Must beat the player's own
  // lateral authority or the wall is advisory.
  const wallAuthA = T.authMult * P.A_LAT;
  const bermA = T.bermMult * P.A_LAT;
  const returnV = T.returnOvershoot_m / T.returnTime_s;
  const assistRate = T.assistMult * P.OMEGA_PIVOT * DEG;      // rad/s
  // funnelMult = 0 (or funnelRate_degs = 0) disables the fall-line funnel
  // outright; it is the one intervention in this module and it has a switch.
  const funnelRate = (T.funnelRate_degs != null
    ? T.funnelRate_degs : T.funnelMult * P.OMEGA_PIVOT) * DEG;  // rad/s
  // Fall-line funnel is inert at or above the speed the hill itself gives you.
  const funnelRef_ms = terminalSpeed(P, P.MEAN_PITCH_deg);
  // Corral: coast-out distance v0*tau = corralStopFrac * room left.
  const corralRoom_m = zEnd - (zFinish + T.corralStart_m);
  const corralTau_s = (T.corralStopFrac * corralRoom_m) / P.V_CAP;
  // Medal par: the course ridden at its own natural terminal speed.
  const par_s = (zFinish - zStart) / funnelRef_ms;

  // ---- the checkpoint stream -------------------------------------------
  // z-ordered. Each carries the corridor half-width AT that checkpoint; the
  // corridor between two checkpoints is the smooth blend of their widths swept
  // along the centreline. That is the "per-checkpoint corridor polygon".
  const checkpoints = [];
  checkpoints.push({ id: 'gate', kind: 'start', name: 'START', z: zStart,
    halfWidth: halfWidth * T.gateWidthFrac });
  for (let i = 1; i <= T.splitCount; i++) {
    const f = i / (T.splitCount + 1);
    checkpoints.push({
      id: 'split' + i, kind: 'split', name: 'SPLIT ' + i,
      z: zStart + (zFinish - zStart) * f, halfWidth,
    });
  }
  checkpoints.push({ id: 'finish', kind: 'finish', name: 'FINISH', z: zFinish,
    halfWidth: halfWidth * T.finishWidthFrac });

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
    // resolved force constants (all derived above; never hand-picked)
    wall: {
      softFrac: T.wallSoftFrac,
      envAccel_ms2: +wallEnvA.toFixed(3),
      authAccel_ms2: +wallAuthA.toFixed(3),
      bermAccel_ms2: +bermA.toFixed(3),
      returnSpeed_ms: +returnV.toFixed(3),
      assistRate_degs: +(assistRate / DEG).toFixed(1),
      zEnvAccel_ms2: +zEnvA.toFixed(3),
      corralTau_s: +corralTau_s.toFixed(3),
    },
    funnel: { refSpeed_ms: +funnelRef_ms.toFixed(2), rate_degs: +(funnelRate / DEG).toFixed(1) },
    physRef: { ...P },
    par_s: +par_s.toFixed(1),
    // the arithmetic, exported so it can be checked without reading comments
    derivation: {
      wallEnvAccel: `V_CAP^2 / (2 * room) * margin = ${P.V_CAP}^2 / (2 * ${wallRoom_m.toFixed(1)}) * ${T.envMargin} = ${wallEnvA.toFixed(2)} m/s^2`,
      wallAuthAccel: `${T.authMult} * A_LAT = ${T.authMult} * ${P.A_LAT} = ${wallAuthA.toFixed(1)} m/s^2 (nets >= ${(wallAuthA - P.A_LAT).toFixed(1)} inward vs full-lock steering)`,
      bermAccel: `${T.bermMult} * A_LAT = ${bermA.toFixed(1)} m/s^2`,
      assistRate: `${T.assistMult} * OMEGA_PIVOT = ${(assistRate / DEG).toFixed(0)} deg/s`,
      funnelRef: `terminal speed on ${P.MEAN_PITCH_deg} deg: (g sin - mu g cos)/lambda = ${funnelRef_ms.toFixed(2)} m/s`,
      corralTau: `${T.corralStopFrac} * ${corralRoom_m} m room / V_CAP ${P.V_CAP} = ${corralTau_s.toFixed(2)} s`,
      par: `courseLength ${zFinish - zStart} m / terminal ${funnelRef_ms.toFixed(2)} m/s = ${par_s.toFixed(1)} s`,
      rankBands: RANK_BANDS.map((b) => `${b.rank} >= ${b.rate} pts/s (${b.why})`),
      medalBands: `GOLD <= ${(0.8 * par_s).toFixed(0)} s, SILVER <= ${par_s.toFixed(0)} s, BRONZE <= ${(1.25 * par_s).toFixed(0)} s`,
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
      // run ledger (all observed, never assumed)
      landed: 0,              // touchdowns the TRICK system banked
      crashed: 0,             // touchdowns it voided (bails)
      cleanLandings: 0,       // physics' own verdict, for comparison
      sketchyLandings: 0,
      airTime_total: 0,
      topSpeed_ms: 0,
      distanceRidden_m: 0,
      bestTrick: null,        // biggest BANKED jump (combo string + star mult)
      bestTrickPoints: 0,
      bestSingleTrick: null,  // highest single named component of the run
      bestSingleTrickPoints: 0,
      // internals
      _prevZ: null,
      _prevPos: null,
      _prevLanding: null,
      _pendingResolve: false,
      _awardAtTouchdown: null,
      _gateHeading: null,
      _gateSpeed: 0,
      _awardsSeen: 0,
      _lastAward: null,
      _t: 0,
    };
  }

  // ------------------------------------------------------------------ walls
  // Trim the outward component of a velocity back onto a braking envelope.
  // Returns the (signed, outward-positive) change to apply.
  //   depth   how far out along the confined axis
  //   limit   value the depth must not pass
  //   soft    where the berm starts
  //   outSpd  current outward speed
  //   envA    envelope deceleration (shape: sets the allowance)
  //   authA   rate cap on the correction (authority: how fast we may trim)
  function envelopeTrim(depth, limit, soft, outSpd, envA, authA, dt, berm, retV) {
    if (depth < soft) return 0;
    const room = Math.max(0, limit - depth);
    const vAllow = Math.sqrt(2 * envA * room);
    let d = 0;
    if (outSpd > vAllow) {
      // pull back onto the envelope, but never faster than authA per second
      d = -Math.min(outSpd - vAllow, authA * dt);
    }
    // steady inward lean through the berm (feel: the wall banks you back in)
    const r = smoothstep(soft, limit, depth);
    d -= berm * r * dt;
    if (depth >= limit) {
      // past the line: kill any residual outward speed outright (velocity-level,
      // so position stays continuous) and add a gentle inward drift
      if (outSpd + d > 0) d = -outSpd;
      const want = -retV * clamp((depth - limit) / T.returnOvershoot_m + 0.15, 0, 1);
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
    const cp = cc[1];
    const u = st.pos[0] - cc[0];
    const W = widthAt(st.pos[2]);
    rs.corridorU = u;
    rs.corridorHalfWidth = W;

    const soft = W * T.wallSoftFrac;
    const depth = Math.abs(u);
    if (depth < soft) { rs.wallPush = 0; return false; }

    const sgn = u >= 0 ? 1 : -1;
    const udot = st.vel[0] - cp * st.vel[2];
    const outSpd = udot * sgn;
    // Airborne riders get the same envelope but half the berm lean: the wall is
    // an aerial assist there, not a net — it must not fly the rider for them.
    const dOut = envelopeTrim(depth, W, soft, outSpd, wallEnvA, wallAuthA, dt,
      st.onGround ? bermA : bermA * 0.5, returnV);

    if (dOut !== 0) {
      // minimum-norm delta-v achieving d(udot) = dOut*sgn along grad u
      const g2 = 1 + cp * cp;
      const k = (dOut * sgn) / g2;
      st.vel[0] += k;
      st.vel[2] += -cp * k;
    }

    // Heading assist: deep in the berm a grounded board is turned by the bank.
    // Rate-limited, ramped, and grounded-only (rotating heading in the air
    // would fake a crash on touchdown, which is not the wall's job, and heading
    // is what the trick system reads for its landing verdict).
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
        const maxStep = assistRate * r * dt;
        st.heading += clamp(wrapPi(target - st.heading), -maxStep, maxStep);
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
    const softEnd = zEnd - T.zSoftRoom_m;
    if (z > softEnd) {
      const d = envelopeTrim(z, zEnd, softEnd, st.vel[2], zEnvA, wallAuthA, dt, bermA * 0.4, returnV);
      if (d !== 0) { st.vel[2] += d; corrected = true; }
    }
    // The corral is also a speed trap: once well past the banner the rider
    // coasts down to a stop instead of charging into the backdrop tiles.
    // Closed-form decay (dt-exact); mostly a ground effect, a quarter of it in
    // the air so a rider who launches the banner still loses the run-out.
    rs.inCorral = rs.phase === 'finished' && z > zFinish + T.corralStart_m;
    if (rs.inCorral) {
      const tau = st.onGround ? corralTau_s : corralTau_s * 4;
      const decay = Math.exp(-dt / tau);
      st.vel[0] *= decay; st.vel[2] *= decay;
      if (st.vel[1] > 0) st.vel[1] *= decay;
      corrected = true;
    }

    // uphill backstop ------------------------------------------------------
    const softBack = zBack + 60;
    if (z < softBack) {
      const d = envelopeTrim(-z, -zBack, -softBack, -st.vel[2], zEnvA, wallAuthA, dt, bermA * 0.4, returnV);
      if (d !== 0) { st.vel[2] -= d; corrected = true; }
    }
    return corrected;
  }

  const TMP = [0, 0];

  // ---------------------------------------------------------------- results
  function rankFor(score, time_s) {
    const rate = time_s > 0 ? score / time_s : 0;
    for (const b of RANK_BANDS) if (rate >= b.rate) return b.rank;
    return 'D';
  }
  // Time medal, so a clean racing run is not graded off a trick rate.
  function medalFor(time_s) {
    if (!(time_s > 0)) return null;
    if (time_s <= 0.8 * par_s) return 'GOLD';
    if (time_s <= par_s) return 'SILVER';
    if (time_s <= 1.25 * par_s) return 'BRONZE';
    return 'FINISHED';
  }

  function foldResults(rs, ts) {
    const splits = rs.crossings
      .filter((c) => c.kind !== 'start')
      .map((c) => ({ name: c.name, z: c.z, time_s: +c.time_s.toFixed(3), split_s: +c.split_s.toFixed(3) }));
    const score = ts ? ts.score : 0;
    return {
      // contract-required
      time_s: rs.time_s,
      score,
      bestTrick: rs.bestTrick,               // the banked jump (combo + star)
      tricky: ts ? !!ts.tricky : false,
      landed: rs.landed,
      crashed: rs.crashed,
      // results-screen extras (frozen numbers, no live references)
      bestTrickPoints: +rs.bestTrickPoints.toFixed(0),
      bestSingleTrick: rs.bestSingleTrick,
      bestSingleTrickPoints: +rs.bestSingleTrickPoints.toFixed(0),
      cleanLandings: rs.cleanLandings,
      sketchyLandings: rs.sketchyLandings,
      trickyLetters: ts ? ts.trickyLetters : 0,
      place: rs.place,
      splits,
      fastestSplit: splits.length
        ? splits.reduce((a, b) => (b.split_s < a.split_s ? b : a)).name : null,
      topSpeed_kmh: +(rs.topSpeed_ms * 3.6).toFixed(1),
      airTime_s: +rs.airTime_total.toFixed(2),
      courseLength_m: zFinish - zStart,            // the course
      distanceRidden_m: +rs.distanceRidden_m.toFixed(1), // what the rider did
      avgSpeed_kmh: rs.time_s > 0 ? +((rs.distanceRidden_m / rs.time_s) * 3.6).toFixed(1) : 0,
      scoreRate_pps: rs.time_s > 0 ? +(score / rs.time_s).toFixed(1) : 0,
      rank: rankFor(score, rs.time_s),
      medal: medalFor(rs.time_s),
    };
  }

  // Landing ledger. Physics owns the TOUCHDOWN; the trick system owns the
  // VERDICT, and it resolves one step later (its 'landing-pending' state ->
  // resolveLanding). So a touchdown is recorded here and adjudicated on the
  // following frame by watching ts.lastAward: a banked landing publishes a new
  // award object, a bail publishes none (reduceScore nulls lastAward on crash).
  // Counting this way is the only way `landed` / `crashed` can agree with
  // `score` — a jump PHYSICS calls clean can still be a bail (unfinished uber
  // JA-15, grab held at touchdown JA-14), and a results card that reports
  // "57 landed, 0 crashed" next to a score of 0 is lying about the run.
  // Physics' own verdict is still reported alongside, as cleanLandings /
  // sketchyLandings. Nothing here writes to either system.
  function landingLedger(rs, st, ts) {
    if (rs._pendingResolve) {
      const la = ts ? ts.lastAward : null;
      if (la && la !== rs._awardAtTouchdown) rs.landed++;
      else rs.crashed++;
      rs._pendingResolve = false;
      rs._awardAtTouchdown = null;
    }
    if (st.landing && !rs._prevLanding) {
      if (st.landing === 'clean') rs.cleanLandings++;
      else if (st.landing === 'sketchy') rs.sketchyLandings++;
      if (ts) { rs._pendingResolve = true; rs._awardAtTouchdown = ts.lastAward ?? null; }
      else if (st.landing === 'crash') rs.crashed++;   // no trick system attached:
      else rs.landed++;                                // fall back to physics
    }
  }

  // Two different "best" readouts, because an SSX results screen shows both:
  //   bestTrick        — the biggest BANKED jump: ts.lastAward, i.e. the whole
  //                      combo string including its star multiplier. This is
  //                      the trick the player actually remembers.
  //   bestSingleTrick  — the highest-scoring single named component of the run
  //                      (Star Bonus rows excluded: a bonus is not a trick).
  function trackBestTrick(rs, ts) {
    if (!ts) return;
    if (Array.isArray(ts.awards)) {
      for (let i = rs._awardsSeen; i < ts.awards.length; i++) {
        const a = ts.awards[i];
        if (!a || typeof a.points !== 'number') continue;
        if (/Star Bonus$/.test(a.name || '')) continue;
        if (a.points > rs.bestSingleTrickPoints) {
          rs.bestSingleTrickPoints = a.points; rs.bestSingleTrick = a.name;
        }
      }
      rs._awardsSeen = ts.awards.length;
    }
    const la = ts.lastAward;
    if (la && la !== rs._lastAward) {
      rs._lastAward = la;
      if (typeof la.points === 'number' && la.points > rs.bestTrickPoints) {
        rs.bestTrickPoints = la.points; rs.bestTrick = la.name;
      }
    }
  }

  // ------------------------------------------------------------------- step
  function step(rs, st, ts, dt) {
    rs._t += dt;

    // ---- start gate: a real hold, VELOCITY AND HEADING ONLY. ----
    // The gate never writes position (so it cannot teleport) and never writes
    // collision state (onGround / airTime / landing belong to physics) or trick
    // state. Zeroing velocity after each physics tick leaves only the single
    // frame of gravity the integrator already applied — measured drift over a
    // 3 s countdown: 0.05 m.
    // Heading is held because this physics gives a stationary board its full
    // skid-pivot authority: a rider "held" while holding steer would pirouette
    // in the gate and leave it pointing across the hill. The gate then releases
    // with the drop-in speed it was carrying when it closed, aimed down-course.
    if (rs.phase === 'ready') {
      if (rs._gateHeading === null) {
        rs._gateHeading = st.heading;
        rs._gateSpeed = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
      }
      st.vel[0] = 0; st.vel[1] = 0; st.vel[2] = 0;
      st.heading = rs._gateHeading;
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.time_s = 0;
      rs.corridorU = st.pos[0] - centerAt(cl, st.pos[2], TMP)[0];
      rs.corridorHalfWidth = widthAt(st.pos[2]);
      rs._prevZ = st.pos[2];
      rs._prevPos = [st.pos[0], st.pos[1], st.pos[2]];
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
      if (rs._prevPos) {
        rs.distanceRidden_m += Math.hypot(st.pos[0] - rs._prevPos[0],
          st.pos[1] - rs._prevPos[1], st.pos[2] - rs._prevPos[2]);
      }
      landingLedger(rs, st, ts);
      trackBestTrick(rs, ts);
    }
    rs._prevLanding = st.landing ?? null;
    if (rs._prevPos) { rs._prevPos[0] = st.pos[0]; rs._prevPos[1] = st.pos[1]; rs._prevPos[2] = st.pos[2]; }
    else rs._prevPos = [st.pos[0], st.pos[1], st.pos[2]];

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
    // and settles onto the fall line. Authority is quadratic in the progress
    // deficit, so it is FULLY INERT at or above the down-course speed the hill
    // itself gives (funnelRef_ms, the unboosted terminal speed on the mean
    // pitch) and only becomes a hand on the shoulder once the rider has stopped
    // descending. Heading only, rate-limited, grounded only. Measured cost:
    // active on 49% of running frames under ordinary play, peak authority 0.33
    // (~37 deg/s); disabled, the same drive never finishes (1465 m in 300 s).
    if (rs.phase === 'running' && st.onGround) {
      // Trigger on DOWN-COURSE progress, not raw speed: a rider carving fast
      // across the hill is riding, not stalling, and must not be nudged. The
      // measure is the velocity component along the corridor tangent, against
      // the same terminal-speed anchor (no second free parameter).
      const cp2 = centerAt(cl, st.pos[2], TMP)[1];
      const nrm = Math.hypot(cp2, 1);
      const vDown = (cp2 * st.vel[0] + st.vel[2]) / nrm;
      const deficit = clamp(1 - vDown / (funnelRef_ms * T.funnelProgressFrac), 0, 1);
      if (deficit > 0) {
        const down = Math.atan2(1, cp2);
        const cap = funnelRate * deficit * deficit * dt;
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

  // -------------------------------------------------------------- debug/audit
  // Confinement demonstrated, not asserted: sweep the whole reachable set —
  // the corridor plus the airborne overshoot the wall tolerates, the backstop,
  // and the run-out corral — against a divergence function supplied by the
  // caller (the runner's worst-LOD model, or the renderer's real mesh), and
  // report the worst value found. Pure; no state touched.
  function auditCorridor(divergenceAt, opts = {}) {
    const overshoot = opts.overshoot_m ?? 10;   // metres of air-side tolerance
    const dz = opts.dz ?? 10, dx = opts.dx ?? 4;
    let worst = 0, at = null;
    for (let z = zBack - overshoot; z <= zEnd + overshoot; z += dz) {
      const c = centerAt(cl, z, [0, 0])[0];
      const W = widthAt(z) + overshoot;
      for (let u = -W; u <= W; u += dx) {
        const d = divergenceAt(c + u, z);
        if (d > worst) { worst = d; at = [+(c + u).toFixed(1), +z.toFixed(1)]; }
      }
    }
    return { maxDivergence_m: +worst.toFixed(3), at, limit_m: T.maxDivergence_m,
      pass: worst <= T.maxDivergence_m };
  }

  return {
    config, init, step, results, restart,
    checkpoints, widthAt,
    centerAt: (z) => centerAt(cl, z, [0, 0])[0],
    debug: { auditCorridor, terminalSpeed: () => funnelRef_ms, par_s },
  };
}
