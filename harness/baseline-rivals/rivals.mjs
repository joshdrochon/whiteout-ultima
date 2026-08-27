// ============================================================================
// HONEST REFERENCE RIVALS — the mutation-testing baseline for the AI gates.
//
// This is NOT a candidate. It exists so harness/rival-mutants.mjs has something
// to break: a gate is only real if a module that violates THAT property fails
// THAT gate, and you cannot show that without a module that passes them all
// first. It is deliberately plain — a lookahead seeker, a lane, a square-wave
// boost duty cycle, and a pop timer. Nothing clever.
//
// THE ONE RULE IT KEEPS (AI-01): it returns INPUTS. It never writes pos, vel or
// heading, on any rival or on the player, on any frame. Everything else — being
// faster, being slower, catching up — is spent through the same nine keys the
// keyboard produces.
//
// Deterministic: seeded from env.seed alone. No Date, no Math.random.
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// mulberry32 — the same small PRNG the render lane uses. Seeded, never wall-clock.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix = (a, b) => (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b + 1 | 0, 0x165667b1)) >>> 0;

// ---------------------------------------------------------------------------
// THE TIERS.
//
// A tier is not a speed multiplier bolted onto the output — that is exactly the
// cheat AI-06 forbids. It is a RIDER: how good the stats are, how far ahead it
// looks, how hard it commits the steering, how much of the run it spends on
// boost, and how much of the run it scrubs away on the brake. Every one of
// those is either a declared physics parameter the runner installs (stats) or
// an input the module presses (all the rest).
//
// THE LINE IS HELD NEARLY CONSTANT ACROSS TIERS ON PURPOSE. An earlier version
// separated the tiers by lookahead and steering gain, and the finish times came
// out INVERTED — hard 109.5 s against easy 96.6 s — because on this course a
// lazier line cuts the meander's corners and a committed one pays turn drag for
// them. Tiers separated by the line are measuring the course, not the rider.
// Throttle separates cleanly and monotonically; the line does not.
//
// MEASURED on the real course, 8 phase variants each, against the harness'
// mid-skill reference player at 107.6 s:
//     easy   135.3 s   (126.4 s when catch-up is helping)
//     medium 121.1 s   (118.5 s assisted)
//     hard    91.3 s   (90.7 s assisted)
// ---------------------------------------------------------------------------
const TIERS = {
  easy: {
    stats: { speed: 6, edging: 10, trick: 20 },
    look: 150,          // m of lookahead on the centreline
    gain: 1.6,          // steering commitment
    boostDuty: 0.00,    // never touches boost
    brakeDuty: 0.20,    // scrubs a fifth of the run away
    tuck: true,
  },
  medium: {
    stats: { speed: 20, edging: 20, trick: 20 },
    look: 130,
    gain: 1.7,
    boostDuty: 0.00,
    brakeDuty: 0.06,
    tuck: true,
  },
  hard: {
    stats: { speed: 34, edging: 32, trick: 24 },
    look: 105,
    gain: 1.9,
    // 0.42 is just under the meter's own sustainable duty: BOOST_DRAIN 0.125
    // against BOOST_REGEN 0.10 balances at 0.10/(0.125+0.10) = 0.444, so a
    // rider who simply HOLDS boost empties the meter in 8 s and then has none
    // for the remaining 80 s of the course. MEASURED: holding boost all the way
    // down finishes in 102.6 s; pulsing it at 0.42 finishes in 89.9 s. Managing
    // the meter is what "hard" means here, and it is spent entirely through the
    // boost key.
    boostDuty: 0.42,
    brakeDuty: 0.02,
    tuck: true,
  },
};

// Catch-up. BOUNDED and ONE-DIRECTIONAL, per AI-05.
const ASSIST_DEADBAND_M = 5;     // inside this, and while LEADING, assist is
                                 // exactly 0 and the code path is the same one
                                 // env.assist === false takes. That is what
                                 // makes the two input streams byte-identical
                                 // when the rival is ahead.
const ASSIST_RANGE_M = 250;      // metres behind at which assist saturates
// THE CATCH-UP CHANNEL: a trailing rider stops scrubbing, up to 60% of its
// tier's brake duty. Nothing else changes — not the boost, not the line, not
// the stats. Boost was tried first and is too coarse a lever to rubber-band
// with: on this course the step from 0 to 0.1 boost duty is 111.9 s to 96.3 s,
// a 14% swing from the smallest touch, and AI-05's whole budget is 15%. Letting
// a struggling rider stop dragging its edge is the subtle version, and it is
// what "catch-up you cannot see" has to mean.
const ASSIST_SCRUB_CUT = 0.26;   // most of the brake duty catch-up may remove.
// RE-MEASURED after the audit widened AI-05 from one live seed to all eight. The
// old probe read 1.09 at a cut of 0.45; the eight-seed sweep reads 1.1295 for the
// same module — the worst seed was simply not in the old sample. The sweep, worst
// ratio over 8 live pairs + 2 frozenAhead pairs:
//     cut 0.45 -> 1.1295   (1.7% of headroom under the 1.15 ceiling)
//     cut 0.35 -> 1.0822
//     cut 0.30 -> 1.0630
// RE-MEASURED AGAIN 2026-08-27, after the per-rider corner appetite landed: a
// rider that commits to its own line spends more of the run turning, and the
// same cut of 0.35 rose to 1.1152 — 3% under a HARD ceiling, which is exactly
// the position this file says a mutation baseline may not occupy. Re-swept:
//     cut 0.30 -> 1.1036   cut 0.26 -> 1.0719   <- here   cut 0.22 -> 1.0986
// Not monotonic, because which of the eight seeds is worst changes between
// them; 0.26 is the floor of the sweep, not a point on a slope.
// The module every mutant is derived from does not get to sit 1.7% under a HARD
// gate, so the cut came down. Catch-up still moves a trailing rival's finish time
// by 8%, which is a rubber band you can feel and not one you can see.

// PER-RIDER CORNER APPETITE — added 2026-08-27 when AI-14 landed.
//
// Before this the baseline separated riders by TIER (lookahead, gain) and by a
// constant lane, which meant the two easy riders differed by their lane alone.
// Under AI-14's throttle lock that field's closest pair measured 4.44 m against
// a 4.0 threshold: passing, but by 11%, and a mutation baseline does not get to
// sit 11% above a gate every mutant is derived from.
//
// A rider's appetite is how far INSIDE (+) or OUTSIDE (-) the corner it wants
// to be, in metres at full corner strength. Drawn per ROSTER SLOT, not per
// tier, so two riders of the same tier are still two different riders. The
// values alternate sign so no pair shares an idea about the mountain.
const CORNER_APPETITE_M = [22, -26, 14, -18, 30];
// The curvature stencil is 200 m and that is not a free parameter. The
// centreline the harness hands out is a 10 m table of a brute-force argmin, so
// its second difference at a short stencil is dominated by the table's own
// piecewise-linear kinks. MEASURED sign reversals over z=0..2400: h=10 -> 108,
// h=30 -> 52, h=80 -> 20, h=150 -> 8, h=200 -> 2. The meander under this
// terrain reverses exactly twice, so 200 is the first stencil that reads the
// mountain. A cycle-2 candidate read it at 30 and derived its corner-strength
// constant from noise.
const CURV_H_M = 200;
const CURV_FULL = 2.0e-3;        // |d2x/dz2| that counts as a full-strength corner

const LANE_PITCH_M = 9;          // lateral spacing between rival lanes
const LANE_WEAVE_M = 4;          // amplitude of the slow weave off the lane
const LANE_WEAVE_HZ = 0.055;
const POP_PERIOD_S = 9;          // one deliberate kicker pop per rider per 9 s
const CROUCH_S = 0.35;           // charge held before the release
const BOOST_CYCLE_S = 4;         // period of the boost duty square wave
const BRAKE_CYCLE_S = 4;         // period of the brake (scrub) duty square wave
const CORRIDOR_MARGIN_M = 25;    // never aim closer than this to the wall
// RECOVERY. A long lookahead cuts the meander's corners, and on the tightest
// bend (z ~ 790, where the centreline's slope reaches 0.857) that carries the
// rider a long way off line. Past RECOVER_OFF_M it shortens its lookahead and
// comes back, which is what a racer who can see the wall does.
//
// HOW MUCH THIS BUYS, MEASURED, NOT ASSUMED: the widest line taken across all
// 32 matrix runs is 101.5 m from the centreline against a corridor half-width
// of 120. Without the recovery band it is 102.1 m; at RECOVER_OFF_M = 35 it is
// 98.8 m and AI-05's ratio worsens from 1.08 to 1.13, because a rider dragged
// back to the line early spends more of the run turning. So the band is worth
// about half a metre and no more.
//
// THE REAL LEVER IS THE LOOKAHEAD, and it trades directly against the tier
// separation AI-09 grades. MEASURED across the tier triple:
//     look 150/130/105 -> widest 101.5 m, easy-medium gap 12.1%
//     look 100/ 90/ 80 -> widest  98.9 m, gap 3.7% and AI-05 at 1.1497
//     look  70/ 65/ 60 -> widest  59.3 m, gap 1.0% — AI-09 FAILS
// A tight line keeps a rider off the wall and makes every tier ride the same
// race. This baseline takes the long line and the 18.5 m of corridor margin
// that comes with it. That margin is the honest number; AI-04's _widestLine_m
// prints it on every run so nobody has to rediscover it.
const RECOVER_OFF_M = 60;
const RECOVER_LOOK_M = 45;

export function createRivals(env = {}) {
  const centerX = env.courseCenterX ?? (() => 0);
  const bounds = env.bounds ?? {};
  const halfWidth = bounds.halfWidth ?? 120;
  const roster = env.roster ?? [];
  const seed = (env.seed ?? 1) | 0;
  // AI-05's explicit off switch. When false, no catch-up is computed anywhere.
  const assistEnabled = env.assist !== false;

  // PER-INSTANCE COPY, not the module-level table. Handing out TIERS by
  // reference meant a caller that wrote to one instance's config poisoned every
  // instance built afterwards in the same process — verified: setting
  // A.config.tiers.easy.stats.speed = 999 showed up in a FRESHLY constructed C.
  // The runner builds each rival's physics from cfg.tiers[tier].stats, so that
  // silently changes every later race. AI-11 passed the whole time and now has
  // an isolation clause that catches it.
  //
  // structuredClone rather than a spread: the leak was two levels down, in
  // .stats, and a shallow copy would have left it exactly where it was while
  // looking like a fix.
  const tiers = structuredClone(TIERS);

  const config = {
    tiers,
    assistEnabled,
    // the module's own published bound on how much catch-up can move a finish
    // time; AI-05 measures the real one and does not take this on trust
    maxAssistFrac: ASSIST_SCRUB_CUT,
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    lanePitch_m: LANE_PITCH_M,
    laneWeave_m: LANE_WEAVE_M,
    popPeriod_s: POP_PERIOD_S,
    corridorMargin_m: CORRIDOR_MARGIN_M,
  };

  // Lane slots: evenly spread about the centreline, in roster order, so the
  // riders never have to cross each other to reach their lanes. The player runs
  // the centreline, so the slots are pushed out by half a pitch — nobody's lane
  // is 0. This is what keeps AI-12's separation honest without any collision
  // handling, which the accepted physics does not have.
  function laneSlot(i, n) {
    const k = i - (n - 1) / 2;                    // ..., -1.5, -0.5, 0.5, 1.5
    return (k < 0 ? k - 0.5 : k + 0.5) * LANE_PITCH_M;
  }

  function init() {
    const rivals = {};
    roster.forEach((r, i) => {
      const rnd = mulberry32(mix(seed, i));
      const T = tiers[r.tier] ?? tiers.medium;
      rivals[r.id] = {
        tier: r.tier in tiers ? r.tier : 'medium',
        lane: laneSlot(i, roster.length) + (rnd() * 2 - 1) * 1.5,
        appetite: CORNER_APPETITE_M[i % CORNER_APPETITE_M.length] * (0.9 + 0.2 * rnd()),
        look: T.look * (0.92 + 0.16 * rnd()),
        weavePhase: rnd() * Math.PI * 2,
        boostPhase: rnd(),
        brakePhase: rnd(),
        popTimer: 1.5 + rnd() * POP_PERIOD_S,
        crouchLeft: 0,
        wantPop: false,
      };
    });
    return { t: 0, rivals };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const player = world?.player ?? null;
    for (const id of Object.keys(rs.rivals)) {
      const self = world?.rivals?.[id];
      if (!self) continue;
      out[id] = driveOne(rs.rivals[id], self, player, rs.t, dt);
    }
    return out;
  }

  function driveOne(R, self, player, t, dt) {
    const T = tiers[R.tier];

    // ---- catch-up: only while BEHIND, only up to a declared ceiling --------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - self.pos[2];
      if (behind > ASSIST_DEADBAND_M) {
        assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
      }
    }

    // ---- the line (identical whether or not catch-up is running) -----------
    const z = self.pos[2], x = self.pos[0];
    const off = Math.abs(x - centerX(z));
    const recover = clamp((off - RECOVER_OFF_M) / RECOVER_OFF_M, 0, 1);
    const tz = z + (R.look + (RECOVER_LOOK_M - R.look) * recover);
    const weave = LANE_WEAVE_M * Math.sin(2 * Math.PI * LANE_WEAVE_HZ * t + R.weavePhase);
    // The rider's own idea about this corner. Faded out by `recover` so a rider
    // already off line comes back rather than arguing with the wall.
    const kv = (centerX(tz + CURV_H_M) - 2 * centerX(tz) + centerX(tz - CURV_H_M)) / (CURV_H_M * CURV_H_M);
    const corner = R.appetite * clamp(kv / CURV_FULL, -1, 1) * (1 - recover);
    const lane = clamp(R.lane + weave + corner, -(halfWidth - CORRIDOR_MARGIN_M), halfWidth - CORRIDOR_MARGIN_M);
    const tx = centerX(tz) + lane;
    const steer = clamp(wrapPi(Math.atan2(tz - z, tx - x) - self.heading) * T.gain, -1, 1);

    // ---- the pop: charge, then release, once per POP_PERIOD ---------------
    // A rider that never leaves the ground on purpose reads as a moving cone,
    // which is what AI-10 is about.
    let crouch = false, jumpRelease = false;
    if (R.crouchLeft > 0) {
      // CHARGE ONLY COUNTS ON THE GROUND. The accepted physics accrues charge from
      // crouch while the board is supported and not while it is falling, so a
      // crouch held through an airborne stretch releases at charge 0 — J_MIN,
      // 2.1 m/s, a hop. Holding the crouch until the rider is actually on the
      // ground is what a rider does, and it is what makes AI-10's charged-pop
      // clause a measurement of intent rather than of luck: MEASURED, the worst
      // rival over the 32-run matrix goes from 4 charged pops to 9.
      if (self.onGround) R.crouchLeft -= dt;
      crouch = true;
      if (R.crouchLeft <= 0) R.wantPop = true;
    } else if (R.wantPop) {
      if (self.onGround) { jumpRelease = true; R.wantPop = false; }
    } else {
      R.popTimer -= dt;
      if (R.popTimer <= 0 && self.onGround) { R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; }
    }

    // ---- throttle: two square waves, one for boost and one for the scrub ---
    const bDuty = T.boostDuty;
    const boost = bDuty >= 1 ? true : ((t / BOOST_CYCLE_S) + R.boostPhase) % 1 < bDuty;
    // The ONLY thing catch-up touches.
    const kDuty = T.brakeDuty * (1 - ASSIST_SCRUB_CUT * assist);
    const brake = kDuty > 0 && ((t / BRAKE_CYCLE_S) + R.brakePhase) % 1 < kDuty;

    // Tuck and crouch fight each other in the accepted physics (both scale
    // steering, and CROUCH_STEER is the tighter of the two), so the charge
    // frame wins and the tuck drops for it.
    const inp = { steer, boost, tuck: T.tuck && !crouch };
    if (brake) inp.brake = true;
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  return { config, init, step };
}
