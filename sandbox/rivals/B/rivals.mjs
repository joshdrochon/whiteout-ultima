// ============================================================================
// Rivals — candidate B. BEHAVIOUR MIX.
//
// Five named behaviours, each returning a desired steer and/or throttle plus a
// weight. The rival's input is the weighted sum, and nothing else:
//   LINE     hold the racing line           w = 1 (the reference weight)
//   AVOID    keep clear of the other riders  w = proximity-scaled, 0..5.0
//   JUMP     load and pop off a real lip     w = tier.jumpW while the window is open
//   BOOST    spend the meter                 w = tier.boostW while the meter is up
//   CAUTION  scrub for the corner            w = tier.cautionW * (timid + cornerLoad)
// steer = Sum(w_i * steer_i) / Sum(w_i) over LINE/AVOID/JUMP; throttle likewise
// over LINE/AVOID-veto/JUMP/BOOST/CAUTION. The throttle scalar becomes a DUTY
// CYCLE on the boost and brake keys, which is how a fractional demand reaches a
// binary key.
//
// Tiers are five named parameters — stats, cautionW/timid, boostW/boostSkill,
// jumpW — never a scale on the output. Catch-up takes 0.03 of weight off
// CAUTION and touches nothing else: never speed, never state.
// INPUTS ONLY: this module writes no field of any physics state, on any frame.
// Deterministic from env.seed alone.
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix2 = (a, b) => (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b + 1) | 0, 0x165667b1)) >>> 0;

// ---------------------------------------------------------------------------
// THE TIERS — five named parameters each, and NOT a scale on the output.
//
// `stats` are declared physics parameters the harness installs. The other four
// are BEHAVIOUR WEIGHTS: how much the rider defers to the corner (cautionW /
// timid), how much of the run it spends on the meter (boostW / boostSkill), and
// how willing it is to go looking for a lip (jumpW).
//
// THE LINE IS THE SAME FOR ALL THREE TIERS ON PURPOSE (LOOK_M below is a
// constant, not a tier field). Separating tiers by lookahead inverts them on
// this course: a lazy line cuts the meander's corners and a committed one pays
// turn drag for them. Throttle separates monotonically; the line does not.
//
// MEASURED by harness/rival-runner.mjs, 8-seed matrix, against its 107.60 s
// scripted reference player:
//     easy 141.44 s    medium 101.89 s    hard 91.84 s
// Tier gaps 36.8% and 9.3% of the course time (AI-09 wants 3%); the slowest
// easy rival still finishes 24.2 s behind the player (AI-07) and the hard rival
// beats it on all 8 seeds (AI-08).
// ---------------------------------------------------------------------------
const TIERS = {
  easy: {
    stats: { speed: 6, edging: 10, trick: 20 },
    cautionW: 3.0,     // defers heavily to the corner
    timid: 0.305,       // and scrubs a little even on the straights
    boostW: 0.0,       // never reaches for the meter of its own accord
    boostSkill: 0.0,   // and would not know what to do with one
    jumpW: 0.5,
  },
  medium: {
    stats: { speed: 20, edging: 20, trick: 20 },
    cautionW: 0.9,
    timid: 0.10,
    boostW: 0.35,      // touches the meter, badly
    boostSkill: 0.14,
    jumpW: 0.8,
  },
  hard: {
    stats: { speed: 34, edging: 32, trick: 24 },
    cautionW: 0.22,
    timid: 0.02,
    boostW: 1.25,
    // BOOST_DRAIN 0.125 against BOOST_REGEN 0.10 balances at a duty of
    // 0.10/0.225 = 0.444: a rider who simply HOLDS boost empties the meter in
    // 8 s and rides the remaining 80 s with none. MEASURED realised duty at
    // this skill: 0.424, meter never below 0.80. Managing the meter is what
    // "hard" means here, and it is spent entirely through the boost key.
    boostSkill: 0.45,
    jumpW: 1.0,
  },
};

// ---- the line -------------------------------------------------------------
const LOOK_M = 118;             // lookahead on the centreline, ALL tiers
const STEER_GAIN = 1.75;
const LANE_PITCH_M = 12;         // lateral spacing between rival lanes
const LANE_WEAVE_M = 4.0;       // amplitude of the slow weave off the lane
const LANE_WEAVE_HZ = 0.05;     // 20 s period — a sine of this amplitude alone
                                // carries 3.5 m of lateral standard deviation,
                                // which is what AI-10's line clause grades.
const CORRIDOR_MARGIN_M = 25;   // never aim closer than this to the wall
const RECOVER_OFF_M = 50;       // past this far off line, shorten the lookahead
const RECOVER_LOOK_M = 45;      // and come back — what a racer who sees the
                                // wall does. WIDEST LINE MEASURED across all 32
                                // matrix runs: 93.9 m against a 120 m half-
                                // width, so AI-04 passes with 26 m to spare and
                                // not on a knife edge.

// ---- avoid ----------------------------------------------------------------
// THE AVOID RADIUS MUST SIT INSIDE THE LANE PITCH. Measured the hard way: at
// AVOID_R 16 against a 12 m pitch the two easy rivals were inside each other's
// radius for the WHOLE run, pushed apart every frame, and walked 300 m out of
// the corridor. Avoidance is for a genuine near-miss; the lanes do the rest.
const AVOID_R_M = 10;           // full-strength radius (< LANE_PITCH_M)
const AVOID_W_MAX = 5.0;        // weight at zero separation
const AVOID_AHEAD_M = 26;       // a rider this far ahead in z, and in my lane,
const AVOID_LANE_M = 7;         // is something to go down-throttle for, not to
const AVOID_VETO_W = 0.5;       // tail — a THROTTLE weight, never a steer one
const AVOID_MIN_PUSH = 0.35;    // lateral steer when exactly abeam
// THE LONG-RANGE HALF. Steering is INERT IN THE AIR in the accepted physics,
// and this course hands every rider ~37 s of it, so a repulsion that only wakes
// up at 10 m can be asleep for the whole encounter. A weak, early, wide term
// that steers the rider off a converging track while it is still on the snow is
// what actually holds the gap. MEASURED: without it the closest pass with the
// player was 0.545 m on seed 7 (AI-12 wants 0.6); with it, no rider on any seed
// ever comes closer than the 2.501 m the START GATE itself spaces them by.
const AVOID_FAR_Z_M = 45;       // z-window of the early term
const AVOID_FAR_X_M = 14;       // lateral window
const AVOID_FAR_W = 0.55;       // weight at zero lateral offset

// ---- the pop --------------------------------------------------------------
const POP_PERIOD_S = 8.5;       // one deliberate kicker per rider per period
const POP_TIMEOUT_S = 6.0;      // ... and if no lip turns up, pop anyway
const CROUCH_S = 0.40;          // charge held before the release: T_CHARGE is
                                // 0.85 s, so this carries ~0.47 charge, well
                                // over AI-10's 0.25 floor for a real pop.
                                // MEASURED: 0.49 best, and the worst rival over
                                // the 32-run matrix still lands 5 charged pops
const LIP_NEAR_M = 8, LIP_FAR_M = 24;
const LIP_DROP_M = 0.45;        // rollover this steep ahead = a lip worth loading

// ---- throttle mapping -----------------------------------------------------
const BOOST_CYCLE_S = 3.5;      // dither period turning a fractional demand
const BRAKE_CYCLE_S = 4.5;      // into a duty cycle on a binary key
const BOOST_FLOOR = 0.14;       // don't reach for an empty meter

// ---- catch-up: BOUNDED, ONE-DIRECTIONAL, and spent on WEIGHTS -------------
const ASSIST_DEADBAND_M = 5;    // inside this, and while LEADING, assist is not
                                // merely small: the branch is not taken at all,
                                // which is what makes the assist-on and
                                // assist-off input streams byte-identical while
                                // a rival leads (AI-05's sign clause).
const ASSIST_RANGE_M = 250;
// THE DROP IS ABSOLUTE, IN WEIGHT UNITS, NOT A FRACTION, AND IT RUNS THROUGH
// THE BRAKE. Both halves of that were bought with failed versions:
//
//  * FRACTIONAL IS TOO SHARP. The easy rider's pace is set by how much it
//    scrubs, so a proportional cut of its caution weight is a proportional cut
//    of its whole race. MEASURED, worst ratio over AI-05's full sweep (8 live
//    seed pairs + 2 frozenAhead pairs): fractional cut 0.55 -> 1.5296,
//    fractional cut 0.12 -> 1.3753. Both fail a 1.15 gate outright.
//  * BOOST IS THE WRONG KEY FOR A SLOW TIER. A version that handed the trailing
//    easy rider the boost key measured 1.1909, and worse, its sign was not even
//    consistent — assisted was SLOWER than unassisted on 4 of 16 live pairs. A
//    boost pulse pulls a 15 m/s rider toward V_BOOST 31, which changes every
//    jump and landing after it; the finish time then swings on which side of a
//    lip the rider ends up. The baseline module reached the same conclusion by
//    a different route and also spends catch-up on the brake.
//
// The drop is worth 4-6% of a trailing easy rival's finish time (152.9 s -> 146.8 s
// with the player parked on the line), one-directional, and reads at 1.0653
// against the 1.15 ceiling — 13% of headroom, not 2%.
const ASSIST_CAUTION_DROP = 0.03; // weight units taken off CAUTION at full assist

export function createRivals(env = {}) {
  const centerX = env.courseCenterX ?? (() => 0);
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const bounds = env.bounds ?? {};
  const halfWidth = bounds.halfWidth ?? 120;
  const roster = env.roster ?? [];
  const seed = (env.seed ?? 1) | 0;
  const assistEnabled = env.assist !== false;
  const laneCap = halfWidth - CORRIDOR_MARGIN_M;

  const config = {
    tiers: TIERS,
    assistEnabled,
    // the module's own declared ceiling on catch-up. The real one, measured by
    // AI-05 over its full sweep, is 0.0653.
    maxAssistFrac: 0.10,
    weightLine: 1, weightAvoidMax: AVOID_W_MAX, weightAvoidVeto: AVOID_VETO_W,
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    assistCautionDrop: ASSIST_CAUTION_DROP,
    look_m: LOOK_M,
    lanePitch_m: LANE_PITCH_M,
    laneWeave_m: LANE_WEAVE_M,
    popPeriod_s: POP_PERIOD_S,
    corridorMargin_m: CORRIDOR_MARGIN_M,
  };

  // Lane slots spread about the centreline in roster order, pushed out by half
  // a pitch so nobody's lane is 0 — the player rides the centreline. This is
  // what keeps AI-12's separation honest without a collision term, which the
  // accepted physics does not have.
  function laneSlot(i, n) {
    const k = i - (n - 1) / 2;
    return (k < 0 ? k - 0.5 : k + 0.5) * LANE_PITCH_M;
  }

  function init() {
    const rivals = {};
    roster.forEach((r, i) => {
      const rnd = mulberry32(mix2(seed, i));
      rivals[r.id] = {
        tier: r.tier in TIERS ? r.tier : 'medium',
        lane: laneSlot(i, roster.length) + (rnd() * 2 - 1) * 0.8,
        weavePhase: rnd() * Math.PI * 2,
        weaveHz: LANE_WEAVE_HZ * (0.85 + 0.3 * rnd()),
        boostPhase: rnd(),
        brakePhase: rnd(),
        popTimer: 1.2 + rnd() * POP_PERIOD_S,
        hunt: 0,          // s spent hunting for a lip
        crouchLeft: 0,
        wantPop: false,
      };
    });
    return { t: 0, rivals, nb: [] };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const player = world && world.player ? world.player : null;
    const live = (world && world.rivals) || {};
    const nb = rs.nb;
    nb.length = 0;
    if (player) nb.push(player);
    for (const id in live) nb.push(live[id]);
    for (const id in rs.rivals) {
      const self = live[id];
      if (!self) continue;
      out[id] = drive(rs.rivals[id], self, player, nb, rs.t, dt);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // ONE RIVAL, ONE FRAME. Five behaviours, then the mix.
  // -------------------------------------------------------------------------
  function drive(R, self, player, nb, t, dt) {
    const T = TIERS[R.tier];
    const x = self.pos[0], z = self.pos[2];

    // ---- catch-up: only while BEHIND, and it moves WEIGHTS ----------------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - z;
      if (behind > ASSIST_DEADBAND_M) assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
    }

    // ---- BEHAVIOUR 1: LINE ------------------------------------------------
    const off = x - centerX(z);
    const recover = clamp((Math.abs(off) - RECOVER_OFF_M) / RECOVER_OFF_M, 0, 1);
    const look = LOOK_M + (RECOVER_LOOK_M - LOOK_M) * recover;
    const tz = z + look;
    const weave = LANE_WEAVE_M * Math.sin(2 * Math.PI * R.weaveHz * t + R.weavePhase);
    // and give up the lane while recovering: the lane offset is what puts the
    // widest line 24 m further out than the seeker's own excursion, and the
    // wall does not care which of the two put the rider there.
    const lane = clamp((R.lane + weave) * (1 - 0.8 * recover), -laneCap, laneCap);
    const tx = centerX(tz) + lane;
    const sLine = clamp(wrapPi(Math.atan2(tz - z, tx - x) - self.heading) * STEER_GAIN, -1, 1);
    const wLine = 1;

    // ---- BEHAVIOUR 2: AVOID ----------------------------------------------
    // Lateral push away from the nearest rider that matters, plus a throttle
    // veto on tailing someone directly ahead. This is what stops a rival ever
    // sitting in the player's pocket (AI-12's shepherding clause) — it is a
    // behaviour with a weight, not a post-hoc separation clamp.
    let sAvoid = 0, wAvoid = 0, thrAvoid = 0, wVeto = 0;
    for (let i = 0; i < nb.length; i++) {
      const o = nb[i];
      if (o === self) continue;
      const dx = x - o.pos[0], dz = z - o.pos[2];
      const d = Math.hypot(dx, dz);
      const adx = Math.abs(dx);
      if (Math.abs(dz) < AVOID_FAR_Z_M && adx < AVOID_FAR_X_M) {
        const w = AVOID_FAR_W * (1 - adx / AVOID_FAR_X_M);
        if (w > wAvoid) {
          wAvoid = w;
          const lat = adx < 1e-3 ? (R.lane >= 0 ? 1 : -1) : Math.sign(dx);
          sAvoid = -lat * 0.6;
        }
      }
      if (d < AVOID_R_M) {
        const w = AVOID_W_MAX * (1 - d / AVOID_R_M);
        if (w > wAvoid) {
          wAvoid = w;
          // STEER SIGN: the seek above is steer = atan2(dz, dx) - heading, so a
          // POSITIVE steer turns the board toward -x. To move AWAY from a rider
          // on my -x side I therefore want a NEGATIVE steer. Getting this
          // backwards makes the behaviour an ATTRACTOR: measured, it put two
          // riders 0.018 m apart three seconds off the start gate.
          const lat = Math.abs(dx) < 1e-3 ? (R.lane >= 0 ? 1 : -1) : Math.sign(dx);
          sAvoid = -lat * clamp(AVOID_MIN_PUSH + (1 - d / AVOID_R_M), -1, 1);
        }
      }
      // sitting in someone's slipstream: back off rather than ride them down
      if (dz < 0 && -dz < AVOID_AHEAD_M && Math.abs(dx) < AVOID_LANE_M) { thrAvoid = -1; wVeto = AVOID_VETO_W; }
    }

    // ---- BEHAVIOUR 3: JUMP ------------------------------------------------
    // Load the board on a real rollover, not on a clock. The clock only opens
    // the window; the terrain decides the frame, and the timeout guarantees the
    // rider still takes air on a flat stretch.
    // sJump IS DELIBERATELY 0: while it is loading the board the rider holds
    // what it has instead of correcting, so JUMP's weight acts as a steering
    // damper. A version that DID steer for the higher shoulder (two extra
    // sampleHeight probes either side) was measured and dropped: it pulled
    // riders across the player's track and across the corridor, taking AI-12
    // from 2.501 m to 0.091 m and the widest line from 93.9 m to 103.5 m.
    let crouch = false, jumpRelease = false, wJump = 0, sJump = 0, thrJump = 0;
    if (R.crouchLeft > 0) {
      // CHARGE ONLY ACCRUES ON THE GROUND. A crouch held through an airborne
      // stretch releases at charge 0 — J_MIN, 2.1 m/s, a hop that AI-10 does
      // not count. Holding it until the board is down is what a rider does.
      if (self.onGround) R.crouchLeft -= dt;
      crouch = true;
      wJump = T.jumpW; thrJump = 0;
      if (R.crouchLeft <= 0) R.wantPop = true;
    } else if (R.wantPop) {
      if (self.onGround) { jumpRelease = true; R.wantPop = false; }
      wJump = T.jumpW;
    } else {
      R.popTimer -= dt;
      if (R.popTimer <= 0 && self.onGround) {
        R.hunt += dt;
        const near = sampleHeight(x, z + LIP_NEAR_M);
        const far = sampleHeight(x, z + LIP_FAR_M);
        // downhill is -z-ward height loss; a rollover drops away faster than
        // the near ground does
        const rollover = (near - far) - (sampleHeight(x, z) - near) * ((LIP_FAR_M - LIP_NEAR_M) / LIP_NEAR_M);
        if (rollover > LIP_DROP_M || R.hunt > POP_TIMEOUT_S) {
          R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; R.hunt = 0;
        }
        wJump = T.jumpW * 0.5;
      }
    }

    // ---- BEHAVIOUR 4: BOOST ----------------------------------------------
    // self.boostMeter is READ, never written — it is physics-owned, and AI-06
    // names the module that touches it.
    const meterUp = (self.boostMeter ?? 0) > BOOST_FLOOR;
    const wBoost = meterUp ? T.boostW : 0;

    // ---- BEHAVIOUR 5: CAUTION --------------------------------------------
    const cornerLoad = Math.abs(sLine);
    let wCaution = T.cautionW * (T.timid + cornerLoad);
    if (assist > 0) wCaution = Math.max(0, wCaution - ASSIST_CAUTION_DROP * assist);

    // ---- THE MIX ----------------------------------------------------------
    const wsSteer = wLine + wAvoid + wJump;
    const steer = clamp((wLine * sLine + wAvoid * sAvoid + wJump * sJump) / wsSteer, -1, 1);
    const wsThr = wLine + wVeto + wJump + wBoost + wCaution;
    // LINE and BOOST want +1, CAUTION wants -1, AVOID vetoes, JUMP is neutral.
    // The division by the weight sum is what BOUNDS the mix: no weight, however
    // large, can drive the throttle past what its own behaviour asked for.
    const thr = clamp((wLine * 1 + wVeto * thrAvoid + wJump * thrJump
      + wBoost * 1 + wCaution * -1) / wsThr, -1, 1);

    // ---- the mix -> the nine keys ----------------------------------------
    // A binary key carries a fractional demand as a DUTY CYCLE: two
    // phase-offset sawtooths, one per key, seeded per rider.
    const sawB = ((t / BOOST_CYCLE_S) + R.boostPhase) % 1;
    const sawK = ((t / BRAKE_CYCLE_S) + R.brakePhase) % 1;
    const inp = { steer, tuck: thr > 0 && !crouch };
    // THE BOOST KEY IS GATED ON THE BOOST BEHAVIOUR BEING IN THE MIX AT ALL.
    // boostSkill is how WELL a tier spends the meter; wBoost is WHETHER it is
    // reaching for it. Without this gate the easy tier boosted at its skill
    // level with a weight of zero — measured, that alone took easy from 124 s
    // to 110 s and put an easy rival 0.02 s off beating the reference player.
    if (thr > 0 && wBoost > 0 && meterUp && sawB < thr * T.boostSkill) inp.boost = true;
    if (thr < 0 && sawK < -thr) inp.brake = true;
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  return { config, init, step };
}
