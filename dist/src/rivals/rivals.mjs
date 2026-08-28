// ============================================================================
// c3B — FOUR RIDERS, FOUR LINES.
//
// Returns INPUTS ONLY. Nothing in this file writes pos, vel, heading, charge,
// boostMeter, onGround, airTime or landing, on a rival or on the player. It
// reads that state and presses the nine keys a keyboard produces.
//
// THE ORGANISING IDEA: a rider is a LINE plus a THROTTLE, and the two are
// separate axes.
//   * The LINE is an ARCHETYPE — a different idea about where the mountain is
//     fast. Which archetype a roster slot gets is DEALT FROM env.seed, so the
//     same four characters turn up in every race in a different order.
//   * The THROTTLE is the TIER, which the roster fixes, plus a per-rider form
//     draw that is also seeded.
// Nothing crosses between them: catch-up lives entirely in the throttle,
// because AI-14 grades the lines with the throttle locked out and a catch-up
// that touched the line would delete the field's character exactly when the
// gate is looking. That is measured, not argued — see ASSIST_* below.
//
// EVERY NUMBER IN THESE COMMENTS WAS PRINTED. Gate figures come from
// `node harness/rival-runner.mjs --module sandbox/rivals/c3B/rivals.mjs`; the
// rest from _lab.mjs, _ablate.mjs and the two _probe_*.mjs scripts beside this
// file. Where a constant has alternatives, the alternatives were run and the
// result is quoted.
//
// FINAL SHEET: 14/14, hardFails 0.
//   AI-05 1.086   AI-09 0.0936   AI-12 2.408 m   AI-13 0.005 ms
//   AI-14 11.878 m with the throttle actually locked (see NOTES.md on the
//   runner's race cache, which does not key on throttleLock).
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// mulberry32, seeded from env.seed alone. No Date, no Math.random, no
// performance, no process, no globalThis. All mutable state lives in the object
// init() returns, so two instances built from the same env cannot touch each
// other.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix = (a, b) => (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b + 1) | 0, 0x165667b1)) >>> 0;

// ---------------------------------------------------------------------------
// THE CURVATURE STENCIL.
//
// The centreline the harness hands out is a 10 m table of a brute-force argmin,
// box-smoothed over 7 taps, so its second difference at a short stencil is the
// table's own kinks and not the mountain. MEASURED sign reversals of d2x/dz2
// over z = 100..2300 (_probe_terrain.mjs): h = 200 m gives 2, and the meander
// under this terrain turns exactly twice. Shorter stencils count noise.
//
// MEASURED at h = 200 over the same grid: rms|kappa| 1.090e-3, max 1.814e-3.
// CURV_FULL = 2.0e-3 therefore saturates only at the tightest bend, and the rms
// of sat(kappa/CURV_FULL) is 0.545 — that 0.545 is the factor every apex/bank
// amplitude below is multiplied by before AI-14 ever sees it.
// ---------------------------------------------------------------------------
const CURV_H_M = 200;
const CURV_FULL = 2.0e-3;

// ---------------------------------------------------------------------------
// THE FOUR LINES.
//
// Each archetype maps z to a WANTED LATERAL OFFSET from the centreline. AI-14
// subtracts each rider's own mean, so a constant lane earns nothing there and
// none of these is a constant lane.
//
//   APEX    +amp * sat(kappa)          cuts the inside of every bend
//   BANK    -amp * sat(kappa)          runs up the outside and drops in
//   RHYTHM   amp * sin(2*pi*z/wave)    rides a rhythm, not the course
//   HUNTER   smoothed drop-seeker      chases the biggest drop ahead
//
// WHY FOUR SHAPES AND NOT FOUR PHASES OF ONE. kappa reverses twice in 2400 m,
// so a "late apex" built by shifting APEX along z is nearly the same profile —
// a 150 m shift of a 1200 m feature — and AI-14 would read the pair as one
// line. APEX and BANK are opposite in SIGN; RHYTHM is a spatial frequency the
// meander does not contain; HUNTER is driven by the terrain sampler and its
// correlation with sat(kappa) MEASURED over the graded grid is 0.102, i.e.
// effectively orthogonal. Orthogonal shapes add in quadrature, which is why the
// closest pair sits at 11.878 m and not at 5-and-a-bit.
//
// PROOF THAT THIS IS THE MECHANISM AND NOT DECORATION (_ablate.mjs, AI-14
// throttle-locked, worst of 8 seeds, floor 5.0):
//   as shipped                                    11.878
//   every archetype amplitude set to 0              2.194   (-82%)
//   all four riders given APEX                      2.171   (-82%)
//   HUNTER's gain set to 0 (it rides its lane)      9.246   (-22%)
//
// HUNTER's smoothing is not decoration either. The raw argmax of the drop is a
// saturated square wave: MEASURED 54 sign flips over 220 grid points with jumps
// of 48 m between adjacent samples (_probe_hunt.mjs). A rider cannot ride that
// and it reads as a convulsion. A softmax centroid at temperature 0.5 m plus an
// 80 m first-order lag gives de-meaned rms 7.34 m, 22 flips, worst step 6.1 m —
// a wandering line that bends about every 100 m. Temperatures 1.5 and 4.0 were
// also run: rms 3.28 and 1.26, too quiet to be a character.
// ---------------------------------------------------------------------------
const ARCH = ['apex', 'bank', 'rhythm', 'hunter'];

const ARCH_CFG = {
  // amp: metres of offset at full corner strength.
  // MEASURED against 16 and 38, whole lab run each:
  //   16 -> widest line 53.5 m, worst rider 3.33 m above the trough, AI-14 9.76
  //   26 -> widest line 61.5 m, worst rider 3.79 m,                  AI-14 11.88
  //   38 -> widest line 72.4 m, worst rider 4.96 m,                  AI-14 11.88
  // The AI-14 worst pair on most seeds is RHYTHM/HUNTER, so this amplitude is
  // not what holds the graded number up above 26 — it sets how far up the gully
  // wall the apex and bank riders live. 26 is the largest value that keeps the
  // worst rider's whole-run mean height under 4 m.
  apex:   { amp: 22, look: 118, gain: 1.75 },
  bank:   { amp: 22, look: 118, gain: 1.75 },
  // wave: metres per full S. MEASURED sweep of AI-14 (throttle-locked, worst
  // seed) with everything else fixed:
  //   140 -> 8.255   260 -> 7.563   340 -> 11.878   400 -> 10.632
  //   460 -> 10.803 (AI-12 falls to 0.319)          520 -> 12.106
  //   600 -> 13.636 (AI-12 falls to 0.193)
  // 340 is the best AI-14 that does not cost AI-12; the two longest waves score
  // higher and put a rider next to the player. The sweep is NOT smooth — the
  // worst seed changes between points — so this is a pick off a measured table,
  // not a point on a slope.
  rhythm: { amp: 17, wave: 340, look: 78, gain: 1.9 },
  // amp is 1 here: HUNTER's metres come from HUNT_GAIN below.
  hunter: { amp: 1, look: 84, gain: 1.9 },
};
const HUNT_L1 = 40;      // m ahead: the lip it is looking at
const HUNT_L2 = 100;     // m ahead: the landing it wants to be under
const HUNT_SCAN = 34;    // m either side of the centreline
const HUNT_STEP = 8.5;   // 9 probes -> 18 sampleHeight calls per recompute.
                         // MEASURED sampleHeight cost 0.204 us/call, so a
                         // recompute is ~3.7 us and AI-13 reads 0.005 ms/frame
                         // for the whole five-rival field.
const HUNT_TEMP = 0.5;   // softmax temperature, in metres of drop
const HUNT_TAU_S = 3.2;  // first-order lag on the aim point (~80 m at 25 m/s)
const HUNT_GAIN = 1.65;  // scales the smoothed centroid off its 7.34 m rms
const HUNT_EVERY_S = 1 / 20;  // recompute at 20 Hz, lag-smoothed in between

// ---------------------------------------------------------------------------
// THE THREE THROTTLES.
//
// Stats are a DECLARED physics parameter (the runner installs them) and they
// are a SMALL lever: SPEED_STAT_GAIN is 0.0175 per 10 points, so the whole
// legal 0..40 band is about a 7% spread in steady-state speed. The tiers are
// therefore separated by keys, and the key that does the work is TUCK.
//
// TUCK, NOT BRAKE, IS THE TIER LEVER. physics.mjs multiplies the linear drag
// term by TUCK_DRAG = 0.75 while tucked, which its own PC-08 note measures at
// +6.5 m/s of steady state on 28 degrees. That is a big lever and, unlike the
// brake, a SMOOTH one. An earlier version of this file separated the tiers by
// brake duty: the easy tier landed at a mean of 177.48 s, and worse, AI-05's
// ratio became a chaotic function of the catch-up constant — a scrub cut of
// 0.18 measured 1.2225 and a cut of 0.05 measured 1.1898, i.e. a HARD gate
// being passed or failed by luck. Moving the separation onto tuck fixed both.
//
// A rider stands up in the bends and gets low on the straights; how straight it
// needs the run before it commits is the tier. MEASURED finish means over the
// 8-seed matrix, against the reference player's 107.60 s:
//     easy 127.26 s    medium 99.70 s    hard 89.63 s
// which puts the PLAYER 3rd of 5 on 7 of the 8 seeds and 2nd on one.
//
// BOOST IS TERRAIN-TRIGGERED, NOT A SQUARE WAVE. A rider lights it where the
// run ahead is straight and it has meter in hand, and holds it for its tier's
// commitment. MEASURED boost PRESSES per race, mean over the 8 seeds:
//     r1 15.0   r2 16.9   r3 23.0   r4 31.5
// Every rival lights the flame, keyed to the mountain rather than to a clock.
// The cycle-2 field measured 0, 0, 2.0 and 11.0.
//
// BRAKE IS CORNER SCRUB and it is now a small residue — only the tightest
// bends, plus the channel that gets out of the way behind traffic.
// ---------------------------------------------------------------------------
const TIERS = {
  easy: {
    stats: { speed: 7, edging: 13, trick: 20 },
    tuckNeed: 0.62, tuckSpread: 0.25,  // needs a near-straight run to get low
    boostStraight: 0.72,               // and a very straight one to light up
    boostReserve: 0.55,                // will not spend below half a meter
    boostHold_s: 0.9,
    brakeCorner: 0.88,
    brakeDepth: 0.45,
    look: 1.00, gain: 1.00,
  },
  medium: {
    stats: { speed: 22, edging: 22, trick: 20 },
    tuckNeed: 0.34, tuckSpread: 0.10,
    boostStraight: 0.45,
    boostReserve: 0.22,
    boostHold_s: 1.6,
    brakeCorner: 0.94,
    brakeDepth: 0.35,
    look: 1.00, gain: 1.06,
  },
  hard: {
    stats: { speed: 36, edging: 33, trick: 24 },
    tuckNeed: 0.00, tuckSpread: 0.30,  // tucked, unless it is having an off day
    boostStraight: 0.30,
    boostReserve: 0.06,
    boostHold_s: 2.6,
    brakeCorner: 0.99,
    brakeDepth: 0.30,
    look: 1.00, gain: 1.12,
  },
};

// ---------------------------------------------------------------------------
// CATCH-UP (AI-05). Bounded, one-directional, and it lives entirely in the
// THROTTLE.
//
// IT MAY NOT LIVE IN THE LINE, and that is measured rather than asserted.
// AI-14 grades with the throttle locked out, which leaves the reference player
// ahead of almost every rival, so a catch-up that straightened a trailing
// rider's line would fire on nearly every graded frame. Built that way — fading
// the archetype out by 80% at full assist — the closest line pair falls from
// 11.878 m to 4.050 m, i.e. under the gate (_ablate.mjs assist-in-line).
//
// While LEADING, or inside the deadband, assist is exactly 0 and the arithmetic
// is the arithmetic env.assist === false runs, so the two input tapes are
// byte-identical. AI-05's sign clause reads 0 divergences.
//
// WHAT IT IS WORTH, MEASURED, live-matrix means with all three cuts at 0:
//     easy 127.26 -> 130.08 s   medium 99.70 -> 100.16 s   hard 89.63 -> 89.63
// The leader gains nothing at all, to the centisecond, and the tail gains
// 2.8 s. Against a player parked on the finish line (AI-05's frozenAhead) the
// same channel is worth up to 8.6%, and the graded worst ratio is 1.086.
// ---------------------------------------------------------------------------
const ASSIST_DEADBAND_M = 5;
const ASSIST_RANGE_M = 260;
const ASSIST_SCRUB_CUT = 0.05;   // corner scrub catch-up may remove
const ASSIST_BOOST_CUT = 0.03;   // boost reserve catch-up may free
const ASSIST_TUCK_GAIN = 0.18;   // how much easier it is to get low.
// 0.30 here measured 1.1134 on AI-05 — 3% under a HARD ceiling, which is not a
// place to sit. 0.18 measures 1.086.

// ---------------------------------------------------------------------------
// MEASURED without the cooldown and the hysteresis: the hard rider registered
// 276 boost PRESSES in one race. It re-lit the flame on the frame after the
// meter crossed its reserve, every time, which is a strobe and not a pattern
// anyone can read. With them, the same meter budget comes out as 31.5 visible
// bursts per race.
const BOOST_COOLDOWN_S = 1.4;
const BOOST_HYST = 0.06;

const POP_PERIOD_S = 8.5;        // one deliberate kicker pop per rider
const CROUCH_S = 0.35;           // held on the GROUND. physics accrues charge
                                 // only while supported, so a crouch carried
                                 // through a flight releases at J_MIN — a
                                 // 0.22 m hop, which AI-10 does not count.
                                 // MEASURED: worst rival 6 charged pops.
const BRAKE_CYCLE_S = 3.5;       // period of the scrub duty dither in a bend
const CORRIDOR_MARGIN_M = 30;    // never aim closer than this to the wall
// RECOVERY. 45 m, because the widest archetype aims 26 m out and the seeker's
// own lag adds to that; a tighter band clips the character off the riders
// rather than saving them from a wall they were not going to hit. MEASURED
// across the 32-run matrix: widest line 61.5 m against a half-width of 120, so
// AI-04 passes with 58.5 m to spare and not on a knife edge.
const RECOVER_OFF_M = 45;
const RECOVER_LOOK_M = 46;

// ---------------------------------------------------------------------------
// TRAFFIC. The accepted physics has NO collision response: two riders in the
// same metre simply interpenetrate, and AI-12 grades the closest approach over
// the whole matrix against a 0.6 m floor. Four things hold it open, and the
// ablations say what each is worth (AI-12, floor 0.6, as shipped 2.408 m):
//     LINE_KEEP off   0.035 m      the line-shaping keep-out
//     PASS_* off      0.200 m      the aim-space pass guard
//     LANE off        0.116 m      the per-slot lane
//     DODGE off       1.635 m      the steer nudge (the least of the four)
//
// WHY THE KEEP-OUT IS IN THE LINE AND NOT ONLY IN A REFLEX: nobody steers in
// mid-air. The last near-miss a pure reflex could not clear was a medium rival
// and the player 0.028 m apart with BOTH AIRBORNE at z = 1535 — two seconds of
// flight in which neither could do anything about it. Shaping the line from
// 200 m out is what has the gap already open before the kicker.
// ---------------------------------------------------------------------------
const LINE_KEEP_M = 19;          // m the rider's LINE stays off the player's
const LINE_KEEP_Z = 120;         // m of z over which it shapes that in
const PASS_CLEAR_M = 7;          // m the AIM stays off the player alongside
const PASS_Z = 26;               // m of z inside which that guard is live
const PASS_YIELD_M = 2;          // m the other side must be won by before the
                                 // rider accepts it and stops fighting back
const PASS_AIM_K = 2.2;          // how hard the aim is shoved off the shortfall
const DODGE_STEER = 0.55;        // steer added at full overlap
const DODGE_WINDOW_Z = 18;       // default z window for the lean-off
const DODGE_WINDOW_X = 7;        // default lateral window
const DODGE_LEAD_S = 0.40;       // s of lead in the PREDICTED lateral gap
const PLAYER_WINDOW_X = 8;       // the player gets a wider berth than a rival
const PLAYER_WINDOW_Z = 24;      // and is seen from further up the hill
const HOLD_Z = 14;               // m: a rival this close AHEAD gets sat behind
const HOLD_X = 3.5;              // m: ...and this close across
// GATE DISCIPLINE. The runner stages the field 5 m apart at z = 15 with the
// player in the MIDDLE of the grid. Four riders all reaching for their own line
// inside the first two seconds cross each other: MEASURED, that is where AI-12's
// worst approach kept landing (0.32 m at t = 2.4 s, z = 25 m, the two easy
// riders). A rider therefore holds the slot it was given for 120 m, moves onto
// its lane, and only then fades onto its line. AI-14's graded grid starts at
// z = 100, so the discipline costs about 9% of the graded span.
const GATE_FADE_M = 120;
const ARCH_FADE_M = 180;
const LANE_PITCH_M = 5;          // per-slot lane. The slots SKIP 0 (-2p, -p,
                                 // +p, +2p) so no rider's lane is the player's
                                 // centreline.
const GATE_LOOK_M = 30;          // aim point while still on the grid. A 100 m
                                 // aim cannot hold a 5 m slot — 5 m over 100 m
                                 // is 3 degrees of heading and the field simply
                                 // drifts together.

export function createRivals(env = {}) {
  const centerX = env.courseCenterX ?? (() => 0);
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const bounds = env.bounds ?? {};
  const halfWidth = bounds.halfWidth ?? 120;
  const zGate = bounds.zStart ?? 0;
  const roster = env.roster ?? [];
  const seed = (env.seed ?? 1) | 0;
  const assistEnabled = env.assist !== false;

  // PER-INSTANCE COPY, not the module-level table. Handing out TIERS by
  // reference means a caller that writes into one instance's config poisons
  // every instance built afterwards in the same process, and the runner builds
  // each rival's physics from cfg.tiers[tier].stats — so the leak silently
  // changes every later race. AI-11's isolation clause catches it; this module
  // was written before that clause existed and failed it on promotion.
  // structuredClone, not a spread: the leak is two levels down in .stats and a
  // shallow copy would look like a fix while changing nothing.
  const tiers = structuredClone(TIERS);

  const config = {
    tiers,
    assistEnabled,
    archetypes: ARCH,
    // The module's own published bound on catch-up, stated as all three
    // channels rather than as one number. AI-05 measures the real one and does
    // not take any of this on trust.
    assistScrubCut: ASSIST_SCRUB_CUT,
    assistBoostCut: ASSIST_BOOST_CUT,
    assistTuckGain: ASSIST_TUCK_GAIN,
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    corridorMargin_m: CORRIDOR_MARGIN_M,
    popPeriod_s: POP_PERIOD_S,
  };

  const sat = z => clamp(((centerX(z + CURV_H_M) - 2 * centerX(z) + centerX(z - CURV_H_M))
    / (CURV_H_M * CURV_H_M)) / CURV_FULL, -1, 1);

  // ------------------------------------------------------------------------
  // THE DRAW. This is the thing cycle 2 did not do. The archetypes are DEALT to
  // the roster slots from env.seed — a Fisher-Yates over the four names — and
  // then each slot draws its own form from the same stream. Ablating the deal
  // and the form together (_ablate.mjs no-seed-at-all) gives eight byte-
  // identical races: r4 87.7, r3 103.8, player 107.6, r1 118.2, r2 119.0 on
  // every seed. That is the cycle-2 procession, reproduced on purpose so the
  // difference can be measured rather than claimed.
  //
  // A 5-slot roster (the runner times one for AI-13) reuses the first name with
  // its phase inverted, so with five riders two share an idea about the
  // mountain. Disclosed in NOTES.md.
  // ------------------------------------------------------------------------
  function dealArchetypes(n) {
    const rnd = mulberry32(mix(seed, 0x5eed));
    const bag = ARCH.slice();
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }
    const out = [];
    for (let i = 0; i < n; i++) out.push(bag[i % bag.length]);
    return out;
  }

  function init() {
    const deal = dealArchetypes(roster.length);
    const rivals = {};
    roster.forEach((r, i) => {
      const rnd = mulberry32(mix(seed, i * 977 + 13));
      const tier = r.tier in TIERS ? r.tier : 'medium';
      const T = tiers[tier];
      const arch = deal[i];
      const A = ARCH_CFG[arch];
      // FORM ON THE DAY: how far this rider commits to its line. MEASURED with
      // the swing frozen at 1, the medium tier's mean drops 99.70 -> 93.21 s, so
      // over- and under-committing to your own line is paid for in seconds and
      // not only in shape.
      const swing = 0.82 + 0.36 * rnd();
      rivals[r.id] = {
        tier, arch,
        amp: A.amp * swing * (arch === 'bank' ? -1 : 1),
        wave: (A.wave ?? 0) * (0.9 + 0.2 * rnd()),
        phase: rnd() * Math.PI * 2 * (i >= ARCH.length ? -1 : 1),
        look: A.look * T.look * (0.94 + 0.12 * rnd()),
        gain: A.gain * T.gain,
        // APPETITE FOR THE THROTTLE, drawn per rider. MEASURED with these three
        // frozen at their midpoints the medium tier's mean drops 99.70 ->
        // 93.88 s: the throttle draw is most of why the same slot finishes
        // 91.5 s on one seed and 110.1 s on another.
        boostBias: 0.72 + 0.56 * rnd(),
        holdBias: 0.45 + 1.10 * rnd(),
        // HOW LAZY THIS RIDER IS ABOUT GETTING LOW, spread per TIER. The hard
        // tier gets the widest spread on purpose: with the tuck threshold fixed
        // per tier the hard slot won all 8 seeds by at least 2.8 s; with it, the
        // margin on seed 6 is 1.7 s. It still has not actually lost one —
        // disclosed in NOTES.md.
        tuckBias: T.tuckSpread * rnd(),
        reserveBias: -0.06 + 0.20 * rnd(),
        brakeBias: 0.80 + 0.42 * rnd(),
        brakePhase: rnd(),
        popTimer: 1.2 + rnd() * POP_PERIOD_S,
        crouchLeft: 0,
        wantPop: false,
        // lane slots skip 0: ..., -2p, -p, +p, +2p
        lane: (() => { const k = i - (roster.length - 1) / 2; return (k < 0 ? k - 0.5 : k + 0.5) * LANE_PITCH_M; })(),
        startOff: null,    // lateral offset of the slot the gate handed it
        passSide: 0,       // 0 = not engaged; +/-1 = committed to a side
        hunt: 0,           // smoothed hunter aim, metres off the centreline
        huntRaw: 0,
        huntTimer: 0,
        boostLeft: 0,      // seconds left in the current boost commitment
        boostWait: 0,      // seconds before it may light the flame again
      };
    });
    return { t: 0, rivals };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const player = world && world.player ? world.player : null;
    for (const id of Object.keys(rs.rivals)) {
      const self = world && world.rivals ? world.rivals[id] : null;
      if (!self) continue;
      out[id] = driveOne(rs.rivals[id], id, self, player, world.rivals, rs.t, dt);
    }
    return out;
  }

  // THE DROP-SEEKER. Softmax centroid over 9 probes of (height at the lip minus
  // height at the landing): a big positive score is ground that falls away.
  // Recomputed at 20 Hz and lag-smoothed, for the reasons in the header.
  function huntAim(R, z) {
    const z1 = z + HUNT_L1, z2 = z + HUNT_L2;
    const c1 = centerX(z1), c2 = centerX(z2);
    let best = -Infinity;
    const sc = [], os = [];
    for (let k = -4; k <= 4; k++) {
      const o = k * HUNT_STEP;
      const v = sampleHeight(c1 + o, z1) - sampleHeight(c2 + o, z2);
      os.push(o); sc.push(v);
      if (v > best) best = v;
    }
    let num = 0, den = 0;
    for (let k = 0; k < sc.length; k++) {
      const w = Math.exp((sc[k] - best) / HUNT_TEMP);
      num += os[k] * w; den += w;
    }
    return clamp((num / den) * HUNT_GAIN, -HUNT_SCAN, HUNT_SCAN);
  }

  // THE LEAN-OFF, weighted by how much of BOTH windows the other body occupies.
  // The gap it reads is PREDICTED, not present: MEASURED without the
  // prediction, on seed 2 the two easy riders were still 2.5 m apart with the
  // nudge already at full deflection and closed to 0.21 m anyway, because a
  // rider crossing the fall line off the gate carries ~10 m/s of lateral speed
  // that a steering input cannot cancel inside half a second.
  function push(o, self, x, z, wx, wz) {
    const dz = o.pos[2] - z;
    const WZ = wz ?? DODGE_WINDOW_Z;
    const az = dz < 0 ? -dz : dz; if (az >= WZ) return 0;
    const dx = (o.pos[0] - x) + (o.vel[0] - self.vel[0]) * DODGE_LEAD_S;
    const W = wx ?? DODGE_WINDOW_X;
    const ax = dx < 0 ? -dx : dx; if (ax >= W) return 0;
    return -(dx >= 0 ? 1 : -1) * (1 - ax / W) * (1 - az / WZ);
  }

  function driveOne(R, myId, self, player, others, t, dt) {
    const T = tiers[R.tier];
    const z = self.pos[2], x = self.pos[0];

    // ---- catch-up: only while BEHIND, only through the throttle -----------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - z;
      if (behind > ASSIST_DEADBAND_M) assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
    }

    // ---- the line ---------------------------------------------------------
    const off = x - centerX(z);
    const recover = clamp((Math.abs(off) - RECOVER_OFF_M) / RECOVER_OFF_M, 0, 1);
    const launch = clamp((z - zGate) / GATE_FADE_M, 0, 1);
    const lookBase = GATE_LOOK_M + (R.look - GATE_LOOK_M) * launch;
    const look = lookBase + (RECOVER_LOOK_M - lookBase) * recover;
    const tz = z + look;

    let want;
    if (R.arch === 'rhythm') {
      want = R.amp * Math.sin((2 * Math.PI * tz) / R.wave + R.phase);
    } else if (R.arch === 'hunter') {
      R.huntTimer -= dt;
      if (R.huntTimer <= 0) { R.huntRaw = huntAim(R, z); R.huntTimer += HUNT_EVERY_S; }
      R.hunt += (R.huntRaw - R.hunt) * clamp(dt / HUNT_TAU_S, 0, 1);
      want = R.hunt * R.amp;
    } else {
      want = R.amp * sat(tz);          // apex (+) and bank (-); the sign is in R.amp
    }
    // A rider already off line comes back rather than arguing with the wall.
    want *= (1 - recover);
    if (R.startOff === null) R.startOff = off;
    const onLine = clamp((z - zGate - GATE_FADE_M) / ARCH_FADE_M, 0, 1);
    want = want * onLine + R.lane * launch + R.startOff * (1 - launch);

    // ---- keep off the player's LINE, long before the encounter -------------
    if (player) {
      const fdz = player.pos[2] - z, afdz = fdz < 0 ? -fdz : fdz;
      if (afdz < LINE_KEEP_Z) {
        const po = player.pos[0] - centerX(player.pos[2]);
        const rel0 = want - po;
        const sd = R.passSide !== 0 ? R.passSide : (rel0 >= 0 ? 1 : -1);
        const g = rel0 * sd;
        if (g < LINE_KEEP_M) want += sd * (LINE_KEEP_M - g);
      }
    }

    const lane = clamp(want, -(halfWidth - CORRIDOR_MARGIN_M), halfWidth - CORRIDOR_MARGIN_M);
    let tx = centerX(tz) + lane;

    // ---- the pass ---------------------------------------------------------
    // While the player is alongside the rider picks a side, holds it, and never
    // aims closer than PASS_CLEAR_M to it. The correction is applied to the AIM
    // POINT IN THE RIDER'S OWN FRAME, not to its lane offset: an offset-space
    // guard aims at where the player's line is 100 m down the hill, which is
    // stale by the time the rider gets there. MEASURED with the offset-space
    // version, a medium rival and the player finished 0.7 s apart on seed 7 and
    // passed within 0.017 m at z = 1453.
    if (player) {
      const pdz = player.pos[2] - z, apdz = pdz < 0 ? -pdz : pdz;
      if (apdz < PASS_Z) {
        const rel = x - player.pos[0];
        if (R.passSide === 0) R.passSide = rel >= 0 ? 1 : -1;
        // ...and it gives the side up once it is CLEARLY on the other one.
        // Without this the guard is a trap: the player drifts across a rider
        // still committed to the side it started on, and the shove meant to
        // open the gap drives it straight back THROUGH the player. MEASURED
        // with the side welded, at PASS_AIM_K = 2.6: 0.034 m on seed 3, both
        // riders grounded, mid-course.
        else if (rel * R.passSide < -PASS_YIELD_M) R.passSide = -R.passSide;
        const gap = rel * R.passSide;
        if (gap < PASS_CLEAR_M)
          tx += R.passSide * (PASS_CLEAR_M - gap) * (1 - apdz / PASS_Z) * PASS_AIM_K;
      } else R.passSide = 0;
    }

    // ---- the lean-off, and holding station behind traffic ------------------
    // ONE BODY IS ANSWERED, AND IT IS THE PLAYER. An earlier version summed a
    // push from every neighbour and put the two easy riders 0.06 m apart at the
    // gate on seed 4: the runner stages the player in the MIDDLE of the grid, so
    // the rider beside it was shoved away from the player straight into its
    // team-mate and the two shoves added. A rival-rival nudge was then tried on
    // its own and it is worse than useless — it locks the four riders into a
    // mutually-repelling FORMATION, which is four PARALLEL lines, and AI-14
    // de-means parallel away: the closest pair fell 7.688 -> 3.226 m while AI-12
    // did not improve (0.137 -> 0.120). Rival-rival separation is left to the
    // lane and to the hold-back below.
    let dodge = 0;
    if (player) {
      const p = push(player, self, x, z, PLAYER_WINDOW_X, PLAYER_WINDOW_Z);
      if (p !== 0) dodge = p;
    }
    let held = false;
    if (others) for (const oid of Object.keys(others)) {
      if (oid === myId) continue;
      const o = others[oid];
      const dz = o.pos[2] - z, dx = o.pos[0] - x;
      if (dz > 0 && dz < HOLD_Z && dx < HOLD_X && dx > -HOLD_X) held = true;
    }
    const steer = clamp(wrapPi(Math.atan2(tz - z, tx - x) - self.heading) * R.gain
      + clamp(dodge, -1, 1) * DODGE_STEER, -1, 1);

    // ---- the pop ----------------------------------------------------------
    let crouch = false, jumpRelease = false;
    if (R.crouchLeft > 0) {
      if (self.onGround) R.crouchLeft -= dt;   // charge only accrues grounded
      crouch = true;
      if (R.crouchLeft <= 0) R.wantPop = true;
    } else if (R.wantPop) {
      if (self.onGround) { jumpRelease = true; R.wantPop = false; }
    } else {
      R.popTimer -= dt;
      if (R.popTimer <= 0 && self.onGround) { R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; }
    }

    // ---- throttle ---------------------------------------------------------
    const straight = 1 - Math.abs(sat(tz));
    const reserve = clamp(T.boostReserve + R.reserveBias, 0, 0.95) * (1 - ASSIST_BOOST_CUT * assist);
    let boost = false;
    if (R.boostLeft > 0) {
      R.boostLeft -= dt;
      boost = (self.boostMeter ?? 0) > 0.02;
      if (!boost) { R.boostLeft = 0; R.boostWait = BOOST_COOLDOWN_S; }
    } else if (R.boostWait > 0) {
      R.boostWait -= dt;
    } else if (straight >= T.boostStraight * R.boostBias
      && (self.boostMeter ?? 0) > reserve + BOOST_HYST && self.onGround) {
      R.boostLeft = T.boostHold_s * R.holdBias;
      boost = true;
    }
    if (!boost && R.boostLeft <= 0 && R.boostWait <= 0 && (self.boostMeter ?? 0) <= reserve)
      R.boostWait = BOOST_COOLDOWN_S;

    const bite = Math.abs(sat(tz));
    const thresh = T.brakeCorner * R.brakeBias;
    const depth = T.brakeDepth * (1 - ASSIST_SCRUB_CUT * assist);
    const brake = held || (self.onGround && bite > thresh
      && ((t / BRAKE_CYCLE_S) + R.brakePhase) % 1 < depth);

    // Tuck and crouch fight each other in the accepted physics (CROUCH_STEER is
    // tighter than TUCK_STEER), so the charge frame wins and the tuck drops.
    const tuck = !crouch && !brake && straight >= T.tuckNeed + R.tuckBias - ASSIST_TUCK_GAIN * assist;
    const inp = { steer, tuck };
    if (boost && !held) inp.boost = true;
    if (brake) inp.brake = true;
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  return { config, init, step };
}
