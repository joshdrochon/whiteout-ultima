// ============================================================================
// CANDIDATE c2B — RIVALS AS DRIVERS, NOT AS THROTTLE SETTINGS.
//
// Cycle 1's verdict was that every rival rode ONE shared line with a lane
// offset, and that the tiers were a throttle ladder on that single track. This
// module has no shared line and no lane. It has SEVEN NAMED TRAITS per rider,
// and the line is what those traits DO to the terrain, decided fresh while the
// rider is moving:
//
//   anticipation   how far ahead it reads, and how often it re-reads
//   cutAppetite    how much it wants the inside of a bend
//   shoulderNerve  how much bank it will climb to hold a line
//   patience       how fast it is willing to move the edge
//   poise          whether it keeps the tuck while it is turning
//   discipline     whether boost is spent on the open stretches or dumped
//   scrub          how readily fear becomes brake
//
// EVERY FRAME each rider scores a handful of candidate aim points across the
// gully and picks one. There is no precomputed path, no lane table, no weave
// oscillator and no per-tier steering multiplier. Two riders with different
// traits leave the same start gate and are 20 m apart by the first bend.
//
// HOW THE TIERS SEPARATE WITHOUT INVERTING (cycle 1's trap), AND WHAT THE LINE
// IS ACTUALLY WORTH ON THIS MOUNTAIN — measured, not argued.
//
// Cycle 1 found that on this course a lazy line cuts the meander's corners and
// a committed one pays turn drag for them, so tier-by-line came out inverted.
// That is real. MEASURED HERE: three riders identical except for the four
// reading traits, on a throttle that never boosts, finish within +-1.2 s of
// each other. THE RACING LINE ON ITS OWN IS WORTH ALMOST NOTHING HERE. The
// gully is 240 m wide, half the run is airborne, and the terrain simply does
// not charge for a bad line.
//
// So the line is not made into a speed axis by fiat. It earns its time through
// three couplings, each of which is a thing the RIDER does:
//   * THE LINE BUYS BOOST WINDOWS. The managed rider's press needs
//     `onGround && fear < boostErr`. A rider that reads well is pointed
//     straight more often, so more of its meter gets lit. Same three riders on
//     that rule: live boost 0.33 -> 0.44, finish 94.9 -> 88.9 s. SIX SECONDS
//     FROM THE LINE ALONE, in the right order.
//   * THE TUCK COMES OFF WHEN A RIDER IS FIGHTING. Tuck is worth 55 s over
//     this course (measured: 113.1 s tucked, 168.7 s not). A rider that reads
//     late and throws the edge in slabs cannot hold it, and pays for its own
//     reading in the throttle without anything being applied to the throttle.
//   * FRIGHT BECOMES BRAKE. `comfort` is 15 m/s for the timid rider and 32 for
//     the one that is not, so the hard rider never reaches its own trigger.
//
// THE WEAK SPOT, NAMED RATHER THAN HIDDEN. The `by feel` boost rule that easy
// and medium use presses below a SPEED threshold, so a rider going faster
// presses less. That is a homeostat and it cancels the line advantage for
// those two tiers: swapping the medium rider's reading for the easy rider's
// makes it 3.1 s FASTER. The hard tier does not have it — its trigger is the
// meter, not its own speed. The fix is a by-feel trigger that is not a proxy
// for how well the rider is doing.
//
// AI-01 / AI-06: this module returns INPUTS. It reads world states and writes
// nothing on them, ever.
// AI-11: no module-level mutable state — the trait table and the aim-offset
// table are COPIED into every instance.
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// mulberry32 — seeded, never wall-clock (AI-11).
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
// THE THREE DRIVERS. Traits are 0..1 personality dials, not speeds. `stats` is
// the one declared physics parameter the contract allows, and it is kept
// deliberately narrow (12 / 20 / 30 speed = about 3 s a tier on this course,
// measured) so the tier gaps are the RIDING, not the rider's kit.
// ---------------------------------------------------------------------------
const TIER_TABLE = {
  easy: {
    stats: { speed: 6, edging: 10, trick: 18 },
    traits: { anticipation: 0.14, cutAppetite: 0.12, shoulderNerve: 0.10,
              patience: 0.05, poise: 0.03, discipline: 0.10, scrub: 0.95 },
  },
  medium: {
    stats: { speed: 20, edging: 20, trick: 20 },
    traits: { anticipation: 0.55, cutAppetite: 0.48, shoulderNerve: 0.42,
              patience: 0.55, poise: 0.52, discipline: 0.37, scrub: 0.32 },
  },
  hard: {
    stats: { speed: 30, edging: 28, trick: 22 },
    traits: { anticipation: 0.95, cutAppetite: 0.82, shoulderNerve: 0.72,
              patience: 0.93, poise: 0.97, discipline: 0.96, scrub: 0.03 },
  },
};

// The aim points a rider considers, as metres either side of the gully floor
// at its reading horizon. Copied per instance.
const AIM_OFFSETS = [-70, -46, -28, -14, -5, 0, 5, 14, 28, 46, 70];

// Corridor discipline: no rider aims closer than this to the wall, whatever
// its traits say. AI-04 is a cliff and the margin is the number that matters.
const WALL_KEEPOUT_M = 45;
const WALL_SOFT_M = 30;          // beyond this the wall term starts biting

// Catch-up (AI-05). ONE channel, and it is a nerve channel: a rider that is
// being left behind stops scrubbing and starts keeping the tuck through the
// corners — it commits, the way a rider under pressure does. Off completely
// while leading, and off completely when env.assist === false, through the
// same branch, so the two input streams are byte-identical when the rival is
// ahead.
const ASSIST_DEADBAND_M = 5;
const ASSIST_RANGE_M = 260;
const ASSIST_SCRUB_CUT = 0.10;   // most of the brake appetite catch-up removes
const ASSIST_POISE_GAIN = 0.06;  // most of the missing tuck poise it lends

// Air. AI-10 wants at least 3 CHARGED pops (charge >= 0.25) and 1.5 s of air.
// A rider hunts the lips it can see: when the ground ahead falls away it sets
// itself, then pops at the edge. LAST_RESORT_S keeps the count honest on a
// stretch with no lip in it — a rider who has not left the ground in that long
// pops off whatever it is standing on.
const LIP_LOOKAHEAD_M = 26;
const LIP_DROP_M = 2.4;          // metres the ground must fall over the probe
const CROUCH_S = 0.40;           // 0.40 / T_CHARGE 0.85 = 0.47 charge at release
const POP_REFRACTORY_S = 5.0;
const MIN_HOLD_S = 0.75;         // a boost is a commitment, not a tap
const MIN_GAP_S = 0.45;
const LAST_RESORT_S = 11.0;

// Racecraft. Rivals pass through each other (user decision), but a racer that
// rides through another racer's back looks broken, so a rider treats occupied
// air ahead as a place it would rather not aim. This is a cost on an aim point,
// not a steering override: an aggressive rider takes the gap, a patient one
// waits behind. AI-12 is what it buys.
const TRAFFIC_WIDTH_M = 7;      // how wide a board's shadow is at an aim point
const DODGE_BUBBLE_M = 24;       // half a course is airborne: start early
const DODGE_AHEAD_M = 30;

export function createRivals(env = {}) {
  const centerX = env.courseCenterX ?? (() => 0);
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const bounds = env.bounds ?? {};
  const halfWidth = bounds.halfWidth ?? 120;
  const roster = env.roster ?? [];
  const seed = (env.seed ?? 1) | 0;
  const assistEnabled = env.assist !== false;

  // ---- PER-INSTANCE COPIES (AI-11: no module-level mutable state) ----------
  const TIERS = {};
  for (const k of Object.keys(TIER_TABLE)) {
    TIERS[k] = { stats: { ...TIER_TABLE[k].stats }, traits: { ...TIER_TABLE[k].traits } };
  }
  const OFFS = AIM_OFFSETS.slice();
  const NOFF = OFFS.length;

  const config = {
    tiers: TIERS,
    assistEnabled,
    maxAssistFrac: ASSIST_SCRUB_CUT,
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    aimOffsets_m: OFFS.slice(),
    wallKeepout_m: WALL_KEEPOUT_M,
    lipLookahead_m: LIP_LOOKAHEAD_M,
    crouch_s: CROUCH_S,
    traitNames: ['anticipation', 'cutAppetite', 'shoulderNerve', 'patience',
                 'poise', 'discipline', 'scrub'],
  };

  // Height of the gully floor at z, cached on a coarse z grid: the floor is
  // the reference every bank cost is measured against and it does not change.
  // 8 m grid, filled lazily — a full precompute would spend the AI-13 startup
  // budget on ground most rivals never look at.
  const floorCache = new Map();
  function floorH(z) {
    const k = Math.round(z / 8);
    let v = floorCache.get(k);
    if (v === undefined) { const zz = k * 8; v = sampleHeight(centerX(zz), zz); floorCache.set(k, v); }
    return v;
  }

  // ---- a rider ------------------------------------------------------------
  function makeRider(id, tier, index, n) {
    const rnd = mulberry32(mix(seed, index * 7 + 1));
    const T = TIERS[tier in TIERS ? tier : 'medium'];
    const jit = (v, w) => clamp(v + (rnd() * 2 - 1) * w, 0.02, 0.99);
    // The seed does not scale a rider, it makes it a DIFFERENT rider inside its
    // tier: two easy riders read the mountain differently and end up metres
    // apart, which is the whole point of the lane.
    const tr = {
      anticipation: jit(T.traits.anticipation, 0.13),
      cutAppetite: jit(T.traits.cutAppetite, 0.20),
      shoulderNerve: jit(T.traits.shoulderNerve, 0.24),
      patience: jit(T.traits.patience, 0.12),
      poise: jit(T.traits.poise, 0.07),
      discipline: jit(T.traits.discipline, 0.10),
      scrub: jit(T.traits.scrub, 0.10),
    };
    // A rider has a GOOD SIDE, and it is never a weak preference: this is what
    // keeps two riders of the same tier from converging on one line. Its sign
    // follows the rider's own slot at the start gate — a racer works with the
    // side of the mountain it was let out on rather than cutting straight
    // across the field in the first hundred metres — and its size is the
    // seed's business. It is a WEIGHT in the line decision, not an offset: a
    // rider with a strong left bias still crosses to the right when the
    // mountain gives it a reason.
    const slot = n > 1 ? index - (n - 1) / 2 : 0;
    const sideBias = (slot < 0 ? -1 : slot > 0 ? 1 : (rnd() < 0.5 ? -1 : 1))
      * (0.45 + 0.55 * rnd());
    return {
      id, tier: tier in TIERS ? tier : 'medium', tr, sideBias,
      // ---- READING -------------------------------------------------------
      // horizon: how far down the mountain the rider is actually looking
      horizon: 62 + 88 * tr.anticipation,
      // refresh: how stale it lets that reading get. A rider who is not
      // looking arrives at the bend with the plan it made before the bend.
      refresh: Math.max(1, Math.round(1 + 11 * (1 - tr.anticipation))),
      // ---- HANDS ---------------------------------------------------------
      edgeRate: 1.9 + 6.0 * (1 - tr.patience),   // how fast the edge is thrown
      gain: 1.15 + 1.05 * tr.patience,
      // ---- NERVE ---------------------------------------------------------
      tuckHold: 0.10 + 0.80 * tr.poise,          // steer above which the tuck drops
      tuckFear: 0.06 + 0.40 * tr.poise,          // heading error that scares it upright
      brakeErr: 0.06 + 0.50 * (1 - tr.scrub),    // heading error that becomes brake
      comfort: 14 + 19 * (1 - tr.scrub),         // m/s it will carry into a fight
      // ---- METER ---------------------------------------------------------
      boostOn: 0.28 + 0.55 * tr.discipline,      // meter it waits for
      boostOff: 0.03 + 0.12 * (1 - tr.discipline),
      boostErr: 0.06 + 0.90 * (1 - tr.discipline), // how straight it wants it first
      slowAt: 26 + 4 * (1 - tr.discipline),      // by feel: presses below this
      fastAt: 33 + 4 * (1 - tr.discipline),      // by feel: lets go above this
      boostLetGo: 0.10 + 0.60 * (1 - tr.discipline) ** 3, // by feel: fright takes the thumb off
      avoid: 1.15 - 0.45 * tr.cutAppetite,       // how wide it gives another rider
      // running state
      plan: 0, planAge: 999, steer: 0,
      crouchLeft: 0, wantPop: false, popCool: 1.2 + 3.5 * rnd(), sinceAir: 0,
      boosting: false, boostLock: 0,
    };
  }

  function init() {
    const rivals = {};
    roster.forEach((r, i) => { rivals[r.id] = makeRider(r.id, r.tier, i, roster.length); });
    return { t: 0, rivals, ids: Object.keys(rivals) };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const player = world?.player ?? null;
    const others = world?.rivals ?? null;
    for (let i = 0; i < rs.ids.length; i++) {
      const id = rs.ids[i];
      const self = others ? others[id] : null;
      if (!self) continue;
      out[id] = drive(rs.rivals[id], self, player, others, dt);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // ONE RIDER, ONE FRAME.
  // -------------------------------------------------------------------------
  function drive(R, self, player, others, dt) {
    const x = self.pos[0], z = self.pos[2], hd = self.heading;
    const tr = R.tr;

    // ---- catch-up: only while BEHIND, and only as nerve -------------------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - z;
      if (behind > ASSIST_DEADBAND_M) assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
    }

    // ---- READ THE MOUNTAIN, and choose where to be --------------------------
    // Re-read on the rider's own cadence: a rider who is not looking keeps the
    // plan it last made, which is exactly what arriving late at a bend means.
    R.planAge += 1;
    if (R.planAge >= R.refresh) { R.plan = choose(R, self, player, others); R.planAge = 0; }
    const H = R.horizon;
    const az = z + H, ax = centerX(az) + R.plan;
    const err = wrapPi(Math.atan2(az - z, ax - x) - hd);

    // ---- the edge. Patience is how fast it is allowed to move. -------------
    const want = clamp(err * R.gain, -1, 1);
    const step = R.edgeRate * dt;
    R.steer = want > R.steer + step ? R.steer + step
            : want < R.steer - step ? R.steer - step : want;
    // ---- racecraft. Rivals pass through each other (the user's decision),
    // but a racer that rides through another racer's back looks broken, so a
    // rider gives room. THREE things make this work where a plain repulsion
    // did not (measured: two same-tier riders converged to 0.108 m):
    //   * ONLY THE TRAILING RIDER YIELDS. Two riders both shoving away from a
    //     sign that flips every frame cancel each other out; the leader holds
    //     its line and the one behind goes round.
    //   * A RIDER IN THE AIR CANNOT YIELD — it has no steering at all — so
    //     the duty passes to whichever board is still on the snow.
    //   * IT STARTS EARLY, 24 m out, because half of this course is airborne
    //     and a rider in the air cannot steer at all.
    let dodge = 0;
    if (others) {
      for (const k in others) {
        const o2 = others[k];
        if (o2 === self) continue;
        dodge += yieldTo(R, self, o2, R.id < k);
      }
    }
    // The player never yields — it is not part of this module — so a rival
    // gives it a wider berth and starts earlier.
    if (player) dodge += yieldTo(R, self, player, true, 1.35);
    const steer = clamp(R.steer + clamp(dodge, -0.7, 0.7), -1, 1);
    const aSteer = steer < 0 ? -steer : steer;

    // ---- air. Hunt the lip you can see; charge, then pop at the edge. ------
    if (!self.onGround) R.sinceAir = 0; else R.sinceAir += dt;
    R.popCool -= dt;
    let crouch = false, jumpRelease = false;
    if (R.crouchLeft > 0) {
      if (self.onGround) R.crouchLeft -= dt;   // charge only accrues supported
      crouch = true;
      if (R.crouchLeft <= 0) R.wantPop = true;
    } else if (R.wantPop) {
      if (self.onGround) { jumpRelease = true; R.wantPop = false; R.popCool = POP_REFRACTORY_S; }
    } else if (self.onGround && R.popCool <= 0) {
      // does the ground fall away inside the next few metres?
      const dzp = LIP_LOOKAHEAD_M;
      const drop = sampleHeight(x, z) - sampleHeight(x + Math.cos(hd) * dzp, z + Math.sin(hd) * dzp);
      if (drop > LIP_DROP_M * (1.6 - 0.9 * tr.anticipation) || R.sinceAir > LAST_RESORT_S) {
        R.crouchLeft = CROUCH_S;
      }
    }

    // ---- nerve: the tuck comes off when the rider is fighting its line ----
    // This is the coupling the whole module turns on. The tuck is worth 55 s
    // over this course; a rider that cannot keep it while it steers pays for
    // its own bad reading, in the throttle, without anything being applied to
    // the throttle.
    const fear = err < 0 ? -err : err;
    const poiseNow = assist > 0 ? R.tuckHold + ASSIST_POISE_GAIN * assist : R.tuckHold;
    const fearNow = assist > 0 ? R.tuckFear + ASSIST_POISE_GAIN * assist : R.tuckFear;
    const tuck = !crouch && aSteer < poiseNow && fear < fearNow;

    // ---- fear: speed the rider does not believe it can steer gets scrubbed -
    // TWO triggers, both off the same trait. A frightened rider brakes because
    // it is fighting the line it chose, AND because it is simply going faster
    // than it is willing to carry. `comfort` is 15 m/s for the timid rider and
    // 32 for the one that is not, so this is a ladder in nerve, not a brake
    // duty cycle: the hard rider never reaches its own trigger.
    const speed = Math.hypot(self.vel[0], self.vel[2]);
    const brakeErrNow = assist > 0 ? R.brakeErr + ASSIST_SCRUB_CUT * assist : R.brakeErr;
    const comfortNow = assist > 0 ? R.comfort * (1 + ASSIST_SCRUB_CUT * assist) : R.comfort;
    const brake = self.onGround && !crouch && speed > comfortNow
      && (fear > brakeErrNow || speed > comfortNow * 1.3);

    // ---- the meter. A HOLD, not a strobe. ---------------------------------
    // The meter is the one resource on the mountain and DISCIPLINE is what a
    // rider does with it. It regenerates at 0.10/s and burns at 0.125/s, so it
    // pays for about 44% of a run — but ONLY to a rider who lets it refill.
    //   Disciplined: waits for a nearly full meter, on the ground, pointed
    //     straight, then spends the whole thing in one long hold, and lets go
    //     over a real float because boost does nothing in the air while the
    //     meter still drains.
    //   Panicky: presses the moment it feels slow, which is in the corner it
    //     just botched, and lets go when it feels quick again. It never lets
    //     the meter refill, so it rides most of the mountain holding a key
    //     that has nothing behind it. That is not a lower boost setting — the
    //     key is DOWN more often than the disciplined rider's — it is the same
    //     key spent where the meter cannot pay for it.
    const meter = self.boostMeter ?? 0;
    // A rider COMMITS to a boost: once the key is down it stays down for at
    // least MIN_HOLD_S and stays up for at least MIN_GAP_S afterwards. Without
    // this the speed trigger chatters across its own threshold and the flame
    // becomes a 3 Hz strobe — 269 presses at a 17 ms hold is what cycle 1's
    // other candidate produced, and it is not a boost, it is a flicker.
    R.boostLock -= dt;
    if (tr.discipline > 0.75) {
      // MANAGED: waits for a nearly full meter, on the snow, pointed straight,
      // spends it in one hold, and lets go over a real float. THE LINE IS WHAT
      // BUYS THE WINDOW — the press needs `onGround && fear < boostErr`, so a
      // rider that reads well is pointed straight more often and gets more of
      // the meter lit. MEASURED, three riders identical but for their reading
      // traits, all on this rule: live boost 0.33 -> 0.44 and 6.0 s of finish
      // time, from the line alone.
      if (R.boosting) {
        if (R.boostLock <= 0 && (meter <= R.boostOff
          || (!self.onGround && (self.airTime ?? 0) > 0.7)
          || fear > R.boostErr * 3)) { R.boosting = false; R.boostLock = MIN_GAP_S; }
      } else if (R.boostLock <= 0 && meter >= R.boostOn
        && self.onGround && fear < R.boostErr) {
        R.boosting = true; R.boostLock = MIN_HOLD_S;
      }
    } else {
      // BY FEEL: presses when it feels slow and lets go when it is quick or
      // frightened. It never looks at the meter, and the meter regenerates
      // ONLY while the key is up — so a rider whose thumb is down 85% of the
      // way down the mountain rides most of it on a dead key. That is not a
      // smaller boost setting: it is the same key, pressed more, worth less.
      if (R.boosting) {
        if (R.boostLock <= 0 && (speed > R.fastAt || fear > R.boostLetGo)) {
          R.boosting = false; R.boostLock = MIN_GAP_S;
        }
      } else if (R.boostLock <= 0 && speed < R.slowAt) {
        R.boosting = true; R.boostLock = MIN_HOLD_S;
      }
    }
    // THE KEY, NOT THE METER. Gating the press on `meter > 0` looks harmless
    // and is a 30 Hz strobe: an empty meter regenerates only while the key is
    // UP, so releasing on empty refills a sliver, which re-presses, which
    // empties it again — measured, 2491 presses at a 20 ms hold. A rider who
    // has decided to boost holds the key down and the meter decides whether
    // anything comes out of it. Setting up a pop is the one thing that always
    // takes the thumb off: nobody holds boost while they crouch into a kicker,
    // and it is what stops a rider who never otherwise lets go from returning
    // one 113-second press for the whole run.
    const boost = R.boosting && !crouch;

    const inp = { steer, tuck };
    if (boost) inp.boost = true;
    if (brake) inp.brake = true;
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  // The room this rider gives ONE other board, as a signed nudge on the edge.
  // `mayYieldLevel` breaks the tie when the two are level: exactly one of any
  // pair moves, so a pair cannot cancel itself out and ride straight through.
  function yieldTo(R, self, o2, mayYieldLevel, pri = 1) {
    // A rider in the air has no steering at all, so it cannot give way and the
    // other board has to. Half of this course is airborne; a yield rule that
    // ignored that handed the duty to whichever rider happened to be flying,
    // and two boards closed to 0.08 m with neither of them able to move.
    if (!self.onGround) return 0;
    const dz = self.pos[2] - o2.pos[2];
    if (dz < -DODGE_AHEAD_M * pri) return 0;
    const otherCanSteer = o2.onGround === true;
    if (dz > 1.5 && otherCanSteer) return 0;       // clearly ahead: hold the line
    if (dz > -1.5 && otherCanSteer && !mayYieldLevel) return 0; // only one of us moves
    const dx = self.pos[0] - o2.pos[0];
    const dy = self.pos[1] - o2.pos[1];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const bub = DODGE_BUBBLE_M * pri;
    if (d >= bub) return 0;
    const k = 1 - d / bub;
    // SIGN. Heading is atan2(dz, dx) and the board's forward is
    // (cos h, sin h), so turning toward +x means DECREASING the heading:
    // positive steer moves a rider running down-course toward -x. The nudge
    // that moves a rider away from a board on its -x side is therefore
    // positive, and the one that moves it toward +x is negative. Getting this
    // backwards is invisible in a code read and steers the two boards into
    // each other; measured, it cost 0.08 m of separation.
    const away = (dx > 0.6 || dx < -0.6) ? (dx > 0 ? -1 : 1) : (R.sideBias >= 0 ? -1 : 1);
    return away * k * k * R.avoid * pri;
  }

  // Cost of aiming at (px, az) with another board on the mountain: carry it
  // forward on its own velocity to az and see whether it lands on the aim.
  function crowd(o2, px, az, w) {
    const vz = o2.vel[2];
    if (vz < 1) return 0;
    const dt2 = (az - o2.pos[2]) / vz;
    if (dt2 < 0 || dt2 > 6) return 0;
    const ox = o2.pos[0] + o2.vel[0] * dt2;
    const ad = px > ox ? px - ox : ox - px;
    return ad < TRAFFIC_WIDTH_M ? (1 - ad / TRAFFIC_WIDTH_M) * 9 * w : 0;
  }

  // -------------------------------------------------------------------------
  // THE LINE DECISION.  // Cost of aiming at (px, az) with another board on the mountain: carry it
  // forward on its own velocity to az and see whether it lands on the aim.
  function crowd(o2, px, az, w) {
    const vz = o2.vel[2];
    if (vz < 1) return 0;
    const dt2 = (az - o2.pos[2]) / vz;
    if (dt2 < 0 || dt2 > 6) return 0;
    const ox = o2.pos[0] + o2.vel[0] * dt2;
    const ad = px > ox ? px - ox : ox - px;
    return ad < TRAFFIC_WIDTH_M ? (1 - ad / TRAFFIC_WIDTH_M) * 9 * w : 0;
  }

  // -------------------------------------------------------------------------
  // THE LINE DECISION.  // Cost of aiming at (px, az) with another board on the mountain: carry it
  // forward on its own velocity to az and see whether it lands on the aim.
  function crowd(o2, px, az, w) {
    const vz = o2.vel[2];
    if (vz < 1) return 0;
    const dt2 = (az - o2.pos[2]) / vz;
    if (dt2 < 0 || dt2 > 6) return 0;
    const ox = o2.pos[0] + o2.vel[0] * dt2;
    const ad = px > ox ? px - ox : ox - px;
    return ad < TRAFFIC_WIDTH_M ? (1 - ad / TRAFFIC_WIDTH_M) * 9 * w : 0;
  }

  // -------------------------------------------------------------------------
  // THE LINE DECISION. Score every aim point across the gully; the traits are
  // the weights. This is the only place the line comes from.
  // -------------------------------------------------------------------------
  function choose(R, self, player, others) {
    const tr = R.tr;
    const x = self.pos[0], z = self.pos[2], hd = self.heading;
    const H = R.horizon;
    const az = z + H;
    const cx1 = centerX(az), fh = floorH(az);
    const cx0 = centerX(z), cx2 = centerX(z + 2 * H);
    // which way the mountain is bending over the reading window
    const curv = cx2 - 2 * cx1 + cx0;
    const inside = curv > 0 ? 1 : curv < 0 ? -1 : 0;
    const bendMag = clamp(Math.abs(curv) / 40, 0, 1);

    // Weights straight off the traits. Everything is scored in METRES so the
    // terms are commensurable: a radian of turn is priced at ~14 m of detour,
    // which is what it costs at racing speed through this gully.
    const wBank = 0.10 + 0.85 * (1 - tr.shoulderNerve);   // per metre of climb
    const wCut = 0.85 * tr.cutAppetite * bendMag;         // per metre of inside
    const wTurn = 13.0 * (0.35 + 0.85 * tr.patience);     // per radian, now
    const wCont = 11.0 * tr.anticipation;                 // per radian, later
    const wSide = 0.35 * (1 - bendMag);
    const wHome = 0.55 - 0.42 * tr.cutAppetite;           // pull to the fall line

    let best = Infinity, bestOff = 0;
    for (let i = 0; i < NOFF; i++) {
      const o = OFFS[i];
      const px = cx1 + o;
      const lat = px - cx1;
      const aLat = lat < 0 ? -lat : lat;
      if (aLat > halfWidth - WALL_KEEPOUT_M) continue;   // never aimed at

      // climb: metres of bank this aim point sits above the gully floor
      const bank = sampleHeight(px, az) - fh;
      // the turn it takes to get there from where the board points now
      const ang = Math.atan2(H, px - x);
      const turn = Math.abs(wrapPi(ang - hd));
      // and the turn it takes to leave again toward the next reading window
      const ang2 = Math.atan2(H, cx2 - px);
      const cont = Math.abs(wrapPi(ang2 - ang));
      // the inside of the bend is the short way round
      const cut = -inside * o;
      // wall
      const over = aLat - WALL_SOFT_M;
      const wall = over > 0 ? over * over * 0.02 : 0;
      // the rider's good side
      const side = -R.sideBias * o;

      // The pull back to the fall line is never zero and it grows fast once a
      // rider is a long way up the bank: this is what keeps AI-04's margin
      // real instead of leaving it to the corridor wall to enforce.
      const far = aLat - 26;
      let c = wBank * bank + wTurn * turn + wCont * cont + wCut * cut
            + wall + wSide * side + wHome * aLat + (far > 0 ? 0.022 * far * far : 0);

      // TRAFFIC, projected properly. Comparing another rider's CURRENT x with
      // an aim point 150 m down the mountain compares two different places; a
      // board is only in the way if it will still be there when this rider
      // arrives, so the other board is carried forward on its own velocity to
      // the aim point's z first.
      if (others) {
        for (const k in others) {
          const o2 = others[k];
          if (o2 === self) continue;
          c += crowd(o2, px, az, 1);
        }
      }
      if (player) c += crowd(player, px, az, 1.5);
      if (c < best) { best = c; bestOff = o; }
    }
    return bestOff;
  }

  return { config, init, step };
}
