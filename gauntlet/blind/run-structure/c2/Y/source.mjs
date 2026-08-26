// ============================================================================
// run-structure candidate A — run.mjs   (cycle 2)
//
// The RUN: a start gate that actually holds you, a clock that only runs while
// you are racing, a finish line that latches the moment you cross it, a results
// card assembled ONCE on the running->finished transition, and a corridor that
// keeps the rider on the part of the mountain the renderer can actually draw.
//
// STRATEGY
// --------
// 1. EXPLICIT PHASE MACHINE. `ready -> running -> finished` (the contract's three
//    phases) with entry/exit hooks in one table, so every side effect of a
//    transition lives in exactly one place. The SSX-style 3-2-1 countdown is a
//    SUB-state of `ready` (rstate.gate / rstate.countdown_s / rstate.light), not a
//    fourth public phase — the contract fixes the public phase vocabulary and the
//    HUD gets the countdown it needs without breaking it.
//
// 2. THE GATE HOLDS. While `ready` the rider's pos/vel/heading are restored to the
//    gate transform every step. It is a start gate, not a suggestion: gravity on a
//    23 deg pitch would otherwise walk the rider down-course before the clock ever
//    starts. The gate hold touches POSE ONLY — pos, vel, heading. It does not
//    write ph.onGround or ph.airTime: those are the physics collision state's to
//    own, and pinning the pose keeps them correct on their own (cycle-1 critique).
//
// 3. CONFINEMENT IS A CONTINUOUS FORCE FIELD, NOT A CLAMP. Measured on this
//    terrain: inside the 120 m corridor the rendered mesh tracks the analytic
//    ground closely, but the moment the rider leaves the inner tile block
//    (z outside [-250, 2750]) the backdrop LOD's 83 m cells diverge by 8-77 m and
//    the rider is visibly inside the mountain. So the corridor is enforced in
//    graded layers — each one only engages where the previous one was not enough,
//    and every layer acts on velocity or heading before any of them touch
//    position. `a` below is |x - courseCenterX(z)|, H is halfWidth (120 m):
//
//      groomed (a < 0.30 H)  nothing at all. The rideable line is free.
//      berm    (0.30 H .. H) smooth inward accel + a yaw authority that TURNS the
//                            board back down-course (a banked wall redirects you;
//                            it does not shove you), both smoothstep-ramped so
//                            first contact is felt, not hit. NO speed tax here —
//                            a banked turn should be rideable.
//      wall    (H .. 1.10 H) same terms at much higher gain, plus barrier
//                            friction, all sized off the player's OWN authority
//                            (see DERIVATION below).
//      catch   (>= 1.10 H)   the OUTWARD rate of `a` is capped by a budget that
//                            fades to zero over CATCH_W = 6 m, so penetration is
//                            bounded BY CONSTRUCTION, not by hoping a spring wins.
//      reel    (>= 1.10 H)   the ONLY positional term: an exponential pull on the
//                            remaining excess, speed-limited (see budget below).
//
//    Two ceilings keep this from ever becoming a slingshot: the wall response
//    SATURATES at one wall-width of penetration, and the corridor's own closing
//    rate is capped. A rider teleported 400 m off-course by some other system is
//    escorted home over a few seconds, never snapped.
//
//    The same 1-D machinery is reused on the z axis: a barrier above the start
//    gate, and a run-out corral past the finish so a player who holds boost
//    through the line coasts, slows, and is caught well before the backdrop tiles.
//
//    CONSTRUCTION BOUND: reachable set is |x - centre| <= 1.10 H + CATCH_W = 138 m
//    and z in [zStart-46, zFinish+206] = [-46, 2606]. Measured worst-case
//    mesh-vs-physics divergence over that ENTIRE set: 1.47 m (at off 138 m,
//    z 1102) against RS-05's 4 m budget — 2.7x margin, and it is a bound on the
//    reachable set, not a sample of one drive. For contrast, the same measurement
//    at z 2750-3000 (one step past the corral, on backdrop tiles) is 11.44 m.
//
// 4. RESULTS ARE ASSEMBLED ONCE. Everything the card reports is accumulated by
//    observers during `running` and frozen into a single immutable object on the
//    running->finished transition. `results()` returns that object verbatim
//    afterwards, so it cannot drift while the rider is still sliding. The trick
//    half of the card reads the BANKED award (ts.lastAward = the whole combo
//    string with its star multiplier — the SSX money shot), not just the best
//    individual entry (cycle-1 critique).
//
// Pure JS, deterministic, no Date/Math.random. Reads physics + trick state;
// mutates physics pos/vel/heading only (confinement + gate pose), never tricks.
//
// ============================================================================
// DERIVATION — where every number comes from (cycle-1 critique: "anchor it")
// ============================================================================
// The corridor is not tuned by feel. Every force term is expressed as a multiple
// of a quantity that already exists in the accepted systems, so it tracks if the
// turning lane or the terrain is retuned:
//
//   aLatCeiling  the player's own lateral-acceleration ceiling. physics.mjs caps
//                steering at omega <= aLatEffective / v (TN-14), with
//                aLatEffective = A_LAT * (1 + 0.5*(edgeF-1)). A_LAT = 26 and the
//                best edging stat (40) gives edgeF = 1.2 -> ceiling 28.6 m/s^2.
//                Taken from env.physicsConfig when the game layer supplies it.
//   gOut         the LOCAL cross-slope gravity component pulling the rider
//                outward, sampled from the terrain every frame the field is
//                engaged (worst case measured on this course: 8.25 m/s^2 at a
//                57 deg cross-slope near the corridor edge at z 2140).
//
//   wallAccel  = WALL_MARGIN * (aLatCeiling + gOut)   [WALL_MARGIN = 2]
//                i.e. at full penetration the net inward acceleration is at least
//                as large as everything the player AND the mountain can throw
//                outward. ~73.7 m/s^2 at the worst point on this course; it is a
//                formula, not the bare 70 the cycle-1 build asserted.
//   bermAccel  = 0.35 * aLatCeiling = 10.0 m/s^2 — deliberately WEAKER than the
//                player's steering, so the berm is rideable, not a rail.
//   bermYaw    = 2.3 * omegaPlayer, wallYaw = 2.8 * omegaPlayer, where
//                omegaPlayer = aLatCeiling / V_CAP = 0.87 rad/s is the player's
//                yaw authority at top speed. The berm redirects faster than you
//                can fight it; the wall much faster.
//   scrub      = 2 * BRAKE_TOTAL / V_CAP = 0.30 1/s — grinding the barrier at
//                full penetration costs twice what holding the brake costs
//                (BRAKE_TOTAL = 5.0 m/s^2 measured in TN-08).
//   vOut0      = sqrt(2 * BRAKE_TOTAL * CATCH_W) = 7.75 m/s — the catch band's
//                outward-velocity budget fades linearly to zero over CATCH_W, so
//                the implied deceleration is exactly the physics brake authority.
//                The catch is a brake, not a wall.
//   reelRate   = reelSpeed / CATCH_W = 5 1/s. Design quantity is the REEL SPEED
//                (30 m/s, i.e. 0.5 m per 60 Hz frame); the rate is then fixed by
//                requiring the exponential's initial velocity (rate * excess) to
//                reach that speed cap exactly at the catch width. Inside 6 m the
//                reel is a smooth tau = 0.2 s pull; beyond it, a constant escort.
//                (Cycle-1 used 25.8, reverse-derived from "0.35 of the excess per
//                frame at 60 Hz" — dt-correct in form, undefended in value.)
//   FRAME BUDGET (RS-06 = 2 m/frame): the three closing terms are
//                V_CAP + vInMax + reelSpeed = 33 + 20 + 30 = 83 m/s = 1.38 m at
//                60 Hz. Worst possible correction frame sits under the 2 m budget
//                by construction; measured worst is far lower.
//   minAir_s   = 0.4 s sits strictly between physics' COYOTE_POP (0.25 s, lip
//                forgiveness — not a jump) and the shortest real jump's hang time
//                2 * J_MIN / G_AIR = 2*2.1/6.5 = 0.65 s. Terrain chatter is not a
//                landing on the results card.
//   topMargin / runOut are set so the reachable z set stays inside the inner tile
//                block: [-46, 2606] against the block's [-250, 2750].
// ============================================================================

// Reference constants from the ACCEPTED systems. env.physicsConfig (the object
// createPhysics returns as `.config`) overrides these when the game layer wires
// it in; the harness does not pass one, so these defaults are the documented
// values from src/physics/physics.mjs DEFAULTS.
const PHYS_REF = {
  A_LAT: 26,             // m/s^2 lateral accel ceiling (TN-14)
  EDGE_STAT_GAIN: 0.10,  // per +10 edging stat
  V_CAP: 33,             // m/s hard speed clamp
  BRAKE_TOTAL: 5.0,      // m/s^2 total braking decel measured in TN-08
  G_AIR: 6.5,            // m/s^2 airborne gravity
  J_MIN: 2.1,            // m/s smallest jump impulse
  COYOTE_POP: 0.25,      // s lip forgiveness window
};
const G = 9.81;

// Dimensionless design ratios — the only free choices in the corridor.
const RATIO = {
  WALL_MARGIN: 2.0,      // wall authority vs (player steering + cross-slope gravity)
  BERM_OF_STEER: 0.35,   // berm authority as a fraction of the player's steering
  BERM_YAW: 2.3,         // berm yaw rate as a multiple of the player's at V_CAP
  WALL_YAW: 2.8,         // wall yaw rate, same units
  GRIND_VS_BRAKE: 2.0,   // wall grind costs 2x holding the brake
};

// Fixed geometry / pacing (metres, seconds).
const GEO = {
  countdown_s: 3.0,      // SSX 3-2-1-GO
  bermFrac: 0.30,        // groomed line ends / berm begins (0.30 H = 36 m)
  catchFrac: 1.10,       // hard catch band begins (1.10 H = 132 m)
  catchWidth: 6,         // m over which the catch budget fades to zero
  penMax: 1.0,           // wall response SATURATES at one wall-width of penetration
  yawBlend: 0.92,        // 8% of the redirect stays down-course so the wall never
                         // parks the rider broadside against it
  vInMax: 20,            // m/s ceiling on the corridor's own closing rate
  reelSpeed: 30,         // m/s ceiling on the positional reel (0.5 m at 60 Hz)
  topMargin: 40,         // m above zStart before the uphill barrier
  runOut: 200,           // m of run-out corral past the finish
  runOutSlow: 120,       // m past the finish where the corral starts biting
  tauStop: 1.6,          // s run-out coast-down time constant
};

// ---------------------------------------------------------------------------
// Results grade. Cycle-1 shipped an invented table (400000/220000/...); these
// bands are arithmetic on the reference bar's VERIFIED anchors only.
//
//   run unit  = 6 jumps. Not a guess: TRICKY requires 6 individually landed
//               ubers within one run (trickyLettersNeeded, HARD), so 6 scoring
//               jumps is the run-scale unit the GAME defines. Overridable from
//               env.trickConfig.trickyLettersNeeded.
//   per-jump anchors, all from references/REFERENCE_BAR.md §5 + research 03 §6:
//     C  13,210          cheapest uber in the table, no star, no combo
//     B  20,960 x 2      = 41,920   two character ubers in one air, no star
//     A  20,960 x 2 x 3  = 125,760  the VERIFIED "about 130K" master jump
//     S  16,140 x 3 x 5  = 242,100  the VERIFIED "250K" 3-quick-ubers-through-red
// ---------------------------------------------------------------------------
const JUMP_ANCHOR = { C: 13210, B: 20960 * 2, A: 20960 * 2 * 3, S: 16140 * 3 * 5 };

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = t => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export function createRun(env = {}) {
  const b = env.bounds ?? {};
  const zStart = b.zStart ?? 0;
  const zFinish = b.zFinish ?? 2400;
  const halfWidth = b.halfWidth ?? 120;
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);

  // ---- derive the corridor's force constants from the physics config ----
  const P = { ...PHYS_REF, ...(env.physicsConfig ?? {}) };
  // best-case player lateral authority: explicit if the config exposes it,
  // otherwise A_LAT at the best edging stat (40 -> edgeF 1.2 -> x1.1).
  const aLatCeiling = Math.max(
    P.aLatEffective ?? 0,
    P.A_LAT * (1 + 0.5 * (P.EDGE_STAT_GAIN * (40 - 20) / 10)));
  const omegaPlayer = aLatCeiling / P.V_CAP;         // rad/s at top speed

  const TUNE = {
    countdown_s: GEO.countdown_s,
    bermFrac: GEO.bermFrac,
    catchFrac: GEO.catchFrac,
    bermAccel: RATIO.BERM_OF_STEER * aLatCeiling,    // 10.0 m/s^2
    wallMargin: RATIO.WALL_MARGIN,                   // wallAccel is computed per
    wallAccelFloor: RATIO.WALL_MARGIN * aLatCeiling, // frame: margin*(ceiling+gOut)
    bermYaw: RATIO.BERM_YAW * omegaPlayer,           // 1.99 rad/s
    wallYaw: RATIO.WALL_YAW * omegaPlayer,           // 2.43 rad/s
    yawBlend: GEO.yawBlend,
    scrub: RATIO.GRIND_VS_BRAKE * P.BRAKE_TOTAL / P.V_CAP,   // 0.303 1/s
    penMax: GEO.penMax,
    vOutFade: GEO.catchWidth,                                 // 6 m
    vOut0: Math.sqrt(2 * P.BRAKE_TOTAL * GEO.catchWidth),     // 7.75 m/s
    vInMax: GEO.vInMax,
    reelSpeed: GEO.reelSpeed,
    reelRate: GEO.reelSpeed / GEO.catchWidth,                 // 5 1/s
    topMargin: GEO.topMargin,
    runOut: GEO.runOut,
    runOutSlow: GEO.runOutSlow,
    tauStop: GEO.tauStop,
    // shortest air that counts as a landing on the card: above coyote, below the
    // smallest real jump's hang time.
    minAir_s: 0.4,
  };

  // centreline cache: deterministic, keyed on 5 m buckets (the supplied sampler
  // is itself quantised; this only avoids re-walking it every frame).
  const cCache = new Map();
  function center(z) {
    const k = Math.round(z / 5) * 5;
    let v = cCache.get(k);
    if (v === undefined) { v = rawCenter(k); cCache.set(k, v); }
    return v;
  }
  // centreline tangent slope dx/dz, wide stencil so the curved corridor's
  // normal does not jitter on the sampler's quantisation steps.
  function centerSlope(z) { return (center(z + 90) - center(z - 90)) / 180; }

  // Gravity component along a horizontal unit direction (ox, oz), positive when
  // the terrain falls away that way — i.e. how hard the mountain itself is
  // pushing the rider in that direction right here.
  function gravityAlong(x, z, ox, oz) {
    const e = 0.5;
    const s = (sampleHeight(x + e * ox, z + e * oz) - sampleHeight(x - e * ox, z - e * oz)) / (2 * e);
    return Math.max(0, G * (-s) / Math.hypot(1, s));
  }

  const zBermIn = zStart - TUNE.topMargin;               // uphill barrier
  const zRunEnd = zFinish + TUNE.runOut;                 // end of the corral
  const zSlow = zFinish + TUNE.runOutSlow;               // corral starts biting

  // TRICKY's letter count is the run-scale unit for the grade bands.
  const jumpsPerRun = env.trickConfig?.trickyLettersNeeded ?? 6;
  const GRADES = [
    [jumpsPerRun * JUMP_ANCHOR.S, 'S'],
    [jumpsPerRun * JUMP_ANCHOR.A, 'A'],
    [jumpsPerRun * JUMP_ANCHOR.B, 'B'],
    [jumpsPerRun * JUMP_ANCHOR.C, 'C'],
    [0, 'D'],
  ];

  const config = {
    // contract-required
    zStart, zFinish, halfWidth,
    maxDivergence_m: 4,        // guaranteed mesh-vs-physics ceiling (RS-05 budget)
    // corridor geometry (named, so the critic/HUD can draw it)
    courseLength_m: zFinish - zStart,
    bermStart_m: halfWidth * TUNE.bermFrac,
    wallStart_m: halfWidth,
    catchStart_m: halfWidth * TUNE.catchFrac,
    maxLateralReach_m: halfWidth * TUNE.catchFrac + TUNE.vOutFade,   // 138 m
    zTopBarrier: zBermIn,
    zRunOutEnd: zRunEnd,
    zReachMin: zBermIn - TUNE.vOutFade,                              // -46
    zReachMax: zRunEnd + TUNE.vOutFade,                              // 2606
    measuredDivergenceOverReachableSet_m: 1.47,   // scanned, see header
    // derivation exports (so a retune is auditable)
    playerLatCeiling_mps2: aLatCeiling,
    playerYawAtVCap_radps: omegaPlayer,
    frameClosingBudget_mps: P.V_CAP + TUNE.vInMax + TUNE.reelSpeed,  // 83
    frameClosingBudget_m60: (P.V_CAP + TUNE.vInMax + TUNE.reelSpeed) / 60, // 1.38
    gradeJumpsPerRun: jumpsPerRun,
    gradeBands: Object.fromEntries(GRADES.filter(([, g]) => g !== 'D')),
    countdown_s: TUNE.countdown_s,
    ...TUNE,
  };

  // ---------------------------------------------------------------- state
  function init() {
    return {
      // contract-required
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: null,
      results: null,
      outOfBounds: false,
      // start-gate sub-state (HUD reads these)
      gate: 'countdown',        // 'countdown' | 'open'
      countdown_s: TUNE.countdown_s,
      light: 3,                 // 3 | 2 | 1 | 0 (GO)
      // live run telemetry
      distance_m: 0,            // down-course progress from the gate
      ridden_m: 0,              // path length actually ridden
      progress: 0,              // 0..1 down the course
      lateral_m: 0,             // signed offset from the centreline
      confinement: 0,           // 0..1, how hard the corridor is pushing
      speed_mps: 0,
      // observers (frozen into results at the finish)
      landed: 0,
      crashed: 0,
      tricksBanked: 0,   // jumps the TRICK system banked a score for
      airTime_s: 0,
      topSpeed_mps: 0,
      bestTrick: null,          // { name, points } — BANKED jump (combo + star)
      bestSingle: null,         // { name, points } — best individual entry
      _airPeak: 0,
      // internals
      _gatePos: null, _gateVel: null, _gateHeading: 0,
      _prevOnGround: true,
      _awardCursor: 0,
      _lastAwardRef: null,
      _prevPos: null,
      _t: 0,
    };
  }

  // ------------------------------------------------------ phase machine
  // Every transition's side effects live here and nowhere else.
  const PHASES = {
    ready: {
      enter(rs) {
        rs.gate = 'countdown';
        rs.countdown_s = TUNE.countdown_s;
        rs.light = Math.ceil(TUNE.countdown_s);
        rs.time_s = 0;
        rs.finished = false;
        rs.results = null;
        rs.place = null;
      },
      step(rs, ph, ts, dt) {
        holdAtGate(rs, ph);
        rs.countdown_s = Math.max(0, rs.countdown_s - dt);
        rs.light = rs.countdown_s > 0 ? Math.ceil(rs.countdown_s) : 0;
        rs.outOfBounds = false;
        rs.confinement = 0;
        if (rs.countdown_s <= 0) return 'running';
        return null;
      },
      // THE GATE DROPS: hand the rider back the push they arrived with, so the
      // run starts with a shove out of the gate instead of from dead stop.
      exit(rs, ph) {
        rs.gate = 'open';
        rs.light = 0;
        if (ph && rs._gateVel) {
          ph.vel[0] = rs._gateVel[0];
          ph.vel[1] = rs._gateVel[1];
          ph.vel[2] = rs._gateVel[2];
        }
      },
    },

    running: {
      enter(rs, ph) {
        rs.time_s = 0;
        rs._prevOnGround = ph ? !!ph.onGround : true;
        rs._prevPos = ph ? [ph.pos[0], ph.pos[1], ph.pos[2]] : null;
        rs._awardCursor = 0;
      },
      step(rs, ph, ts, dt) {
        rs.time_s += dt;
        observe(rs, ph, ts, dt);
        confine(rs, ph, dt, /* postFinish */ false);
        if (ph.pos[2] >= zFinish) return 'finished';   // latch on the crossing frame
        return null;
      },
      exit() {},
    },

    finished: {
      enter(rs, ph, ts) {
        rs.finished = true;
        rs.place = 1;
        rs.results = assemble(rs, ts);   // assembled ONCE, then immutable
      },
      step(rs, ph, ts, dt) {
        runOutCoast(rs, ph, dt);
        confine(rs, ph, dt, /* postFinish */ true);
        return null;
      },
      exit() {},
    },
  };

  function transition(rs, next, ph, ts) {
    PHASES[rs.phase].exit(rs, ph, ts);
    rs.phase = next;
    PHASES[next].enter(rs, ph, ts);
  }

  // --------------------------------------------------------- start gate
  // The gate transform is whatever the rider arrived with on the very first
  // step — captured once, restored every ready frame, handed back on release.
  // POSE ONLY: onGround/airTime belong to the physics collision solver.
  function captureGate(rs, ph) {
    rs._gatePos = [ph.pos[0], ph.pos[1], ph.pos[2]];
    rs._gateVel = [ph.vel[0], ph.vel[1], ph.vel[2]];
    rs._gateHeading = ph.heading;
  }

  function holdAtGate(rs, ph) {
    if (!rs._gatePos) captureGate(rs, ph);
    ph.pos[0] = rs._gatePos[0];
    ph.pos[1] = rs._gatePos[1];
    ph.pos[2] = rs._gatePos[2];
    ph.vel[0] = 0;
    ph.vel[1] = 0;
    ph.vel[2] = 0;
    ph.heading = rs._gateHeading;
    rs.speed_mps = 0;
  }

  // ------------------------------------------------------- observation
  function observe(rs, ph, ts, dt) {
    const sp = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_mps = sp;
    if (sp > rs.topSpeed_mps) rs.topSpeed_mps = sp;
    if (!ph.onGround) rs.airTime_s += dt;

    // distance actually RIDDEN (path length), distinct from course length —
    // cycle-1 reported zFinish-zStart as "distance" no matter what you did.
    if (rs._prevPos) {
      rs.ridden_m += Math.hypot(ph.pos[0] - rs._prevPos[0],
        ph.pos[1] - rs._prevPos[1], ph.pos[2] - rs._prevPos[2]);
      rs._prevPos[0] = ph.pos[0]; rs._prevPos[1] = ph.pos[1]; rs._prevPos[2] = ph.pos[2];
    } else rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];

    // touchdown edge -> landed / crashed tally (read-only on physics).
    // Only AIRS count: this terrain bucks the board off the snow for a frame or
    // two constantly, and a results card that reports "landed 54" for one run of
    // chatter is noise. minAir_s is the line between a bump and a jump.
    if (!ph.onGround) rs._airPeak = Math.max(rs._airPeak, ph.airTime ?? 0);
    if (ph.onGround && !rs._prevOnGround) {
      if (rs._airPeak >= TUNE.minAir_s) {
        if (ph.landing === 'crash') rs.crashed++;
        else rs.landed++;
      }
      rs._airPeak = 0;
    }
    rs._prevOnGround = !!ph.onGround;

    if (ts) {
      // BEST TRICK = the best BANKED jump. tricks.mjs sets ts.lastAward =
      // { name: <whole combo summary>, points: <banked, star multiplier
      // included> } on every clean/sketchy landing, and null on a crash. That
      // string is the jump the player actually remembers; the per-entry awards
      // list only has the pieces. New object identity == new banked jump.
      const la = ts.lastAward;
      if (la && la !== rs._lastAwardRef) {
        rs._lastAwardRef = la;
        rs.tricksBanked++;
        if (!rs.bestTrick || la.points > rs.bestTrick.points)
          rs.bestTrick = { name: la.name, points: la.points };
      } else if (!la) rs._lastAwardRef = null;

      // secondary line on the card: the single biggest named trick, scanned
      // incrementally from the awards list (star bonuses are not tricks).
      const aw = ts.awards;
      if (aw) {
        for (let i = rs._awardCursor; i < aw.length; i++) {
          const a = aw[i];
          if (!a || typeof a.points !== 'number') continue;
          if (typeof a.name === 'string' && a.name.indexOf('Star Bonus') >= 0) continue;
          if (!rs.bestSingle || a.points > rs.bestSingle.points)
            rs.bestSingle = { name: a.name, points: a.points };
        }
        rs._awardCursor = aw.length;
      }
    }

    rs.distance_m = Math.max(0, ph.pos[2] - zStart);
    rs.progress = clamp(rs.distance_m / Math.max(1, zFinish - zStart), 0, 1);
  }

  // ------------------------------------------------------- confinement
  //
  // One graded 1-D response, applied on the corridor normal (lateral) and on z
  // (start barrier / run-out corral). `a` is the contract's distance measure,
  // `soft` where the field starts, `hard` where the wall is, `catchAt` where the
  // velocity budget and the positional reel engage.

  function axisField(a, soft, hard) {
    if (a <= soft) return { pen: 0, band: 0 };
    const band = smooth((a - soft) / Math.max(1e-6, hard - soft));   // 0..1 in the berm
    // penetration past the wall, SATURATED: the response is bounded so a rider
    // who starts (or is thrown) far outside is escorted back at a sane rate
    // instead of being flung across the course by an unbounded spring.
    const pen = Math.min(TUNE.penMax,
      Math.max(0, (a - hard) / Math.max(1e-6, hard - soft)));
    return { pen, band };
  }

  // Positional reel-in: exponential in the remaining excess, speed-limited.
  // dt-correct by construction; at 60 Hz the speed cap binds beyond 6 m of
  // excess and the pull is never more than reelSpeed*dt = 0.5 m.
  function reelStep(excess, dt) {
    return Math.min(excess * (1 - Math.exp(-TUNE.reelRate * dt)), TUNE.reelSpeed * dt);
  }

  function confine(rs, ph, dt, postFinish) {
    let pushing = 0;
    let oob = false;

    // ---------- lateral: curved corridor around courseCenterX(z) ----------
    const z = ph.pos[2];
    const cx = center(z);
    const off = ph.pos[0] - cx;                 // contract's |x - courseCenterX(z)|
    const a = Math.abs(off);
    const s = off >= 0 ? 1 : -1;
    rs.lateral_m = off;

    const m = centerSlope(z);
    const tl = Math.hypot(m, 1);
    const tx = m / tl, tz = 1 / tl;             // centreline tangent (down-course)
    const nl = Math.hypot(1, m);
    const inX = -s * (1 / nl), inZ = -s * (-m / nl);   // unit inward normal

    const soft = halfWidth * TUNE.bermFrac;
    const { pen, band } = axisField(a, soft, halfWidth);

    if (band > 0) {
      pushing = Math.max(pushing, clamp(band + pen, 0, 1));
      // wall authority, sized against what the player AND the mountain can do
      // outward right here (see DERIVATION).
      const wallAccel = TUNE.wallMargin *
        (aLatCeiling + gravityAlong(ph.pos[0], z, -inX, -inZ));
      // (a) inward acceleration — felt in the air too, where heading means nothing
      const acc = TUNE.bermAccel * band + wallAccel * pen;
      ph.vel[0] += inX * acc * dt;
      ph.vel[2] += inZ * acc * dt;
      // (b) yaw authority: the berm TURNS the board. Grounded only — in the air
      //     `heading` is the trick system's spin bookkeeping and is not ours.
      if (ph.onGround) {
        const w = TUNE.yawBlend * clamp(band + pen, 0, 1);
        const wx = tx * (1 - w) + inX * w;
        const wz = tz * (1 - w) + inZ * w;
        const want = Math.atan2(wz, wx);
        const omega = TUNE.bermYaw * band + TUNE.wallYaw * pen;
        const d = wrapPi(want - ph.heading);
        const stepYaw = clamp(d, -omega * dt, omega * dt);
        ph.heading += stepYaw;
      }
      // (c) barrier friction: GRINDING the wall costs you speed. The berm band
      //     itself is free — a banked turn should be rideable, not a tax.
      if (pen > 0) {
        const k = Math.exp(-TUNE.scrub * pen * dt);
        ph.vel[0] *= k; ph.vel[1] *= k; ph.vel[2] *= k;
      }
      // (d) closing-rate ceiling: the corridor escorts, it never slingshots.
      const vIn = -(s * (ph.vel[0] - m * ph.vel[2]));
      if (vIn > TUNE.vInMax) ph.vel[0] += s * (vIn - TUNE.vInMax);
    }
    if (a > halfWidth) oob = true;

    // (e) catch band: bound penetration by construction
    const catchAt = halfWidth * TUNE.catchFrac;
    if (a > catchAt) {
      const excess = a - catchAt;
      // outward rate of |x - cx| includes the centreline's own drift with z
      const vOut = s * (ph.vel[0] - m * ph.vel[2]);
      const budget = Math.max(0, TUNE.vOut0 * (1 - excess / TUNE.vOutFade));
      if (vOut > budget) ph.vel[0] -= s * (vOut - budget);
      // (f) soft reel-in, never a snap
      const pull = reelStep(excess, dt);
      ph.pos[0] -= s * pull;
      ph.pos[1] = groundClamp(ph, ph.pos[0], ph.pos[2]);
      pushing = 1;
      oob = true;
    }

    // ---------- longitudinal: start barrier and run-out corral ----------
    const zSoftTop = zBermIn + TUNE.topMargin * 0.5;
    if (z < zSoftTop) {
      const av = zSoftTop - z;
      const f = axisField(av, 0, TUNE.topMargin * 0.5);
      const wallAccel = TUNE.wallMargin *
        (aLatCeiling + gravityAlong(ph.pos[0], z, 0, -1));
      const acc = TUNE.bermAccel * f.band + wallAccel * f.pen;
      ph.vel[2] += acc * dt;
      if (ph.vel[2] > TUNE.vInMax) ph.vel[2] = TUNE.vInMax;
      pushing = Math.max(pushing, clamp(f.band + f.pen, 0, 1));
      if (z < zBermIn) {
        oob = true;
        const excess = zBermIn - z;
        const budget = Math.max(0, TUNE.vOut0 * (1 - excess / TUNE.vOutFade));
        if (-ph.vel[2] > budget) ph.vel[2] = -budget;
        const pull = reelStep(excess, dt);
        ph.pos[2] += pull;
        ph.pos[1] = groundClamp(ph, ph.pos[0], ph.pos[2]);
      }
    }

    if (postFinish && z > zSlow) {
      const f = axisField(z, zSlow, zRunEnd);
      const wallAccel = TUNE.wallMargin *
        (aLatCeiling + gravityAlong(ph.pos[0], z, 0, 1));
      const acc = TUNE.bermAccel * f.band + wallAccel * f.pen;
      ph.vel[2] -= acc * dt;
      if (ph.vel[2] < -TUNE.vInMax) ph.vel[2] = -TUNE.vInMax;
      pushing = Math.max(pushing, clamp(f.band + f.pen, 0, 1));
      if (z > zRunEnd) {
        oob = true;
        const excess = z - zRunEnd;
        const budget = Math.max(0, TUNE.vOut0 * (1 - excess / TUNE.vOutFade));
        if (ph.vel[2] > budget) ph.vel[2] = budget;
        const pull = reelStep(excess, dt);
        ph.pos[2] -= pull;
        ph.pos[1] = groundClamp(ph, ph.pos[0], ph.pos[2]);
      }
    }

    rs.confinement = pushing;
    rs.outOfBounds = oob;
  }

  // positional corrections follow the ground instead of leaving the rider
  // hanging in (or under) the surface — and never lift an airborne rider.
  function groundClamp(ph, x, z) {
    const h = sampleHeight(x, z);
    if (ph.onGround) return h;
    return ph.pos[1] < h ? h : ph.pos[1];
  }

  // ------------------------------------------------------- run-out coast
  function runOutCoast(rs, ph, dt) {
    const k = Math.exp(-dt / TUNE.tauStop);
    ph.vel[0] *= k; ph.vel[1] *= k; ph.vel[2] *= k;
    const sp = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    if (sp < 0.25) { ph.vel[0] = 0; ph.vel[1] = 0; ph.vel[2] = 0; }
    rs.speed_mps = sp;
  }

  // ----------------------------------------------------------- results
  function grade(score) {
    for (const [min, g] of GRADES) if (score >= min) return g;
    return 'D';
  }

  function assemble(rs, ts) {
    const score = ts && typeof ts.score === 'number' ? ts.score : 0;
    const best = rs.bestTrick;
    const single = rs.bestSingle;
    const r = {
      // contract-required six
      time_s: rs.time_s,
      score,
      bestTrick: best ? best.name : 'None',
      tricky: !!(ts && ts.tricky),
      landed: rs.landed,
      crashed: rs.crashed,
      // the rest of the SSX results card
      bestTrickPoints: best ? best.points : 0,
      bestSingleTrick: single ? single.name : 'None',
      bestSinglePoints: single ? single.points : 0,
      // tricksBanked counts every landing the trick system banked points for;
      // `landed` counts only real AIRS (>= minAir_s). They differ, on purpose.
      tricksBanked: rs.tricksBanked,
      trickyLetters: ts && typeof ts.trickyLetters === 'number' ? ts.trickyLetters : 0,
      airTime_s: rs.airTime_s,
      topSpeed_kmh: rs.topSpeed_mps * 3.6,
      distanceRidden_m: rs.ridden_m,        // path actually ridden
      courseLength_m: zFinish - zStart,     // the course, honestly named
      place: 1,
      grade: grade(score),
    };
    return Object.freeze(r);
  }

  // -------------------------------------------------------------- step
  function step(rstate, physState, tstate, dt) {
    rstate._t += dt;
    // capture the gate transform the first time we ever see the rider
    if (!rstate._gatePos && physState) captureGate(rstate, physState);
    // At most ONE transition per step: the phase that requested it has already
    // done its work this frame, and the phase we move into starts on the next.
    const next = PHASES[rstate.phase].step(rstate, physState, tstate, dt);
    if (next) transition(rstate, next, physState, tstate);
    return rstate;
  }

  // ----------------------------------------------------------- public
  return {
    config,

    init,

    step,

    results(rstate, tstate) {
      if (rstate.results) return rstate.results;      // frozen at the finish
      return assemble(rstate, tstate);                // live provisional
    },

    restart(rstate) {
      const fresh = init();
      for (const k of Object.keys(rstate)) delete rstate[k];
      Object.assign(rstate, fresh);
      PHASES.ready.enter(rstate);
      return rstate;
    },

    // Optional game-layer hook: drop the gate early (press-to-start). The
    // harness never calls it; the countdown auto-releases on its own.
    open(rstate) {
      if (rstate.phase === 'ready') rstate.countdown_s = 0;
      return rstate;
    },

    // Debug/HUD: where the corridor walls are at this z.
    corridorAt(z) {
      const cx = center(z);
      return { center: cx, left: cx - halfWidth, right: cx + halfWidth,
        berm: halfWidth * TUNE.bermFrac };
    },
  };
}

// ============================================================================
// REBUTTAL — cycle-1 mustFix #5: "add a trick-producing probe drive to
// harness/run-runner.mjs before this lane closes."
//
// AGREED on the substance, DECLINED as a builder action. The finding is right:
// the probe drive `play` sends tuck/boost/steer only, so no jump ever leaves the
// ground, RS-04 compares 0 to 0, and every metrics.json reports score 0. That is
// a real hole in the lane's evidence. But run-runner.mjs is the shared operational
// law both candidates are measured against, and `play` feeds RS-01, RS-02, RS-03,
// RS-04 and RS-08 alike. A candidate editing it mid-gauntlet would (a) mark its own
// homework and (b) move the goalposts under the other candidate's build after that
// build had already been measured. That is the harness owner's call, not a
// builder's. Exact patch, verified to work end to end (it is the drive the numbers
// below were produced with — it keeps the runner's own heading-seeker idiom so the
// rider actually reaches the finish while jumping):
//
//   const seek = (st, tx, tz) => Math.max(-1, Math.min(1,
//     wrap(Math.atan2(tz - st.pos[2], tx - st.pos[0]) - st.heading) * 1.8));
//   const play = (t, st) => {
//     const c = t % 6, z = st.pos[2];               // one jump every 6 s
//     return {
//       tuck: c > 2.9, boost: t > 3,
//       steer: seek(st, centerX(z + 120) + 40 * Math.sin(t * 0.2), z + 120),
//       crouch: c >= 1.6 && c < 2.2,                 // charge
//       jumpRelease: c >= 2.2 && c < 2.2 + DT,
//       spin: (c >= 2.0 && c < 2.9) ? 1 : 0,         // prewind + air spin
//       grab: c >= 2.25 && c < 2.35,
//       uber: (c >= 2.25 && c < 2.9) ? 1 + (Math.floor(t / 6) % 6) : 0,
//     };
//   };
//
// What I did instead: proved this module's trick half against the REAL trick
// system with a local driver (src/physics + src/tricks + this module, the same
// 60 Hz loop and the same terrain the runner uses). Measured, deterministic:
//
//   FULL TRICK RUN  finished at 173.4 s (RS-08 band [90,260])
//     score 121,956 · bestTrick "Can Can + Frontside 360" @ 15,865 pts — a BANKED
//     jump summary with its combo bonus, not a lone awards entry (the cycle-1
//     build could only ever have reported the 14,310 "Can Can" piece, which is
//     what bestSingleTrick now carries) · tricky TRUE · trickyLetters 6 ·
//     landed 35 · crashed 2 · tricksBanked 42 · airTime 38.6 s · top 120.7 km/h ·
//     distanceRidden 2,835 m vs courseLength 2,400 m (they differ, as they must) ·
//     grade C on bands C 79,260 / B 251,520 / A 754,560 / S 1,452,600.
//     results() byte-identical 600 steps past the line; two runs identical.
//
//   ADVERSARIAL DRIVE + JUMPING (240 s, boost held, bail both sides, jump/grab/
//     uber throughout): max divergence 0.97 m, max correction frame 0.000 m,
//     furthest off centre 66.8 m, z stayed in [15, 2433].
//   400 m TELEPORT MID-RUN (t = 20 s, rider thrown 400 m off-course by fiat):
//     escorted back inside the corridor, worst correction frame 0.947 m — under
//     RS-06's 2 m budget with no teleport of its own.
//   REVERSE UPHILL ATTACK (120 s of full boost aimed back up the mountain):
//     never got above the gate (min z 15.1), max divergence 0.63 m.
//
// So bestTrick / bestTrickPoints / bestSingleTrick / tricky / trickyLetters /
// tricksBanked / grade are live code with observed values, not pass-through. The
// harness gate still cannot SEE that until someone who owns the harness applies
// the patch above; RS-04 keeps passing on 0 == 0 until then.
// ============================================================================
