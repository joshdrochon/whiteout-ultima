// ============================================================================
// CANDIDATE c2B — DRIVER PERSONALITIES.
//
// A rival here is not a lane plus a throttle setting. It is a DRIVER: eight
// named traits that are read every frame and that produce the line as a
// by-product of how that driver reads the mountain in front of it.
//
// THE TRAITS (all per rival, all read in step(), none precomputed into a path):
//   vision            how far down the hill this driver reads, in metres, as a
//                     function of its own current speed. A long read aims at a
//                     point past the bend and the CHORD cuts the corner; a short
//                     read tracks the meander and pays for every metre of it.
//   aggression        steering gain and how hard it commits to the aim point.
//   patience          steer deadband + slew limit. A patient driver makes one
//                     smooth input; an impatient one saws, and TURN_DRAG bills
//                     it 15% of LAMBDA_LONG at full lock for the privilege.
//   bank              SIGNED, and the reason two rivals in the same tier do not
//                     share a line. +1 dives to the INSIDE of whatever bend is
//                     in front of it; -1 climbs the OUTSIDE, which on this
//                     terrain is literally the high shoulder of the gully
//                     (h += d^2*0.0035, so 40 m out is 5.6 m up). The sign is
//                     applied to the bend the driver can see, so a banker and a
//                     hugger swap sides every time the course reverses.
//   boostDiscipline   meter hysteresis + a straightness gate. Not a duty cycle:
//                     the driver watches its OWN boostMeter (read, never
//                     written) and holds the key in long burns.
//   caution           when the wheel saturates, does the driver scrub?
//   nerve             pop appetite, and how deep it charges before releasing.
//   space             how much room it demands from the riders around it.
//
// WHY THE TIERS ARE NOT INVERTED. Cycle 1 found that separating tiers by line
// put hard BEHIND easy, because on this course a long chord cuts the meander
// and a line welded to the centreline pays turn drag for every bend. That is a
// true property of the terrain and this module does not fight it: it points the
// trait the RIGHT WAY ROUND. The better driver READS FURTHER, so the better
// driver takes the shorter chord. Line and throttle then push in the SAME
// direction instead of cancelling, which is why the order comes out monotone
// with a smaller throttle spread than the baseline needs. The measured split is
// in NOTES.md.
//
// AI-01: this module returns INPUTS. It reads world state and writes nothing —
// not pos, not vel, not heading, not charge, not boostMeter.
// AI-11: no module-level mutable state. Every table below is a frozen literal
// and is COPIED into per-instance objects inside createRivals().
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
// THE TIER TRAIT SETS.
//
// Read these as three drivers, not three speed settings. Nothing here is a
// multiplier on an output: `vision` and `bank` are consumed by the aim-point
// solver, `patience` and `aggression` by the steering, `boostDiscipline`,
// `caution` and `nerve` by the key presses.
//
// MEASURED, 8 seeds, this file (see NOTES.md for the line/throttle split):
//     easy   131.0 s      medium 116.1 s      hard 92.7 s
// against the harness' scripted mid-skill player at 107.55 s.
// ---------------------------------------------------------------------------
const TIER_TRAITS = Object.freeze({
  // THE PASSENGER. Target-fixates: reads eleven seconds of hill, aims at the
  // exit of a bend it is nowhere near yet, and gets carried UP THE GULLY WALL
  // doing it. That is the expensive mistake on this mountain (the wall costs
  // d^2*0.0035 metres of climb, 22 m at 80 m out) and it is the one this driver
  // makes over and over. Then it saws to get back down, stands out of its tuck
  // while it fights, and scrubs whenever the wheel loads up.
  easy: Object.freeze({
    stats: Object.freeze({ speed: 8, edging: 12, trick: 20 }),
    look0: 100, lookK: 6.00, lookMax: 265,  // vision: far too far
    gain: 2.60, aggression: 0.55,
    dead: 0.050, slew: 7.5,                 // patience: low
    bankM: 34,
    boostHi: 2, boostLo: 2, boostGate: 0, boostTrough: 0, crestEase: 9, vEase: 99,  // hi > 1 == never presses it
    brakeSteer: 0.55, brakeSpeed: 15.0, panicOff: 26,   // caution: high
    tuckSteer: 0.03,
    popEvery: 5.0, chargeS: 0.30,           // nerve: low, short charge
    guardStart: 92, guardLook: 42,          // lets itself get a long way out
  }),
  // THE CLUBMAN. Reads about the right depth and sits half way up the bank —
  // never stranded, never really in the trough either. It carries a boost meter
  // and it is disciplined about spending it: it will only commit the key when it
  // is LOW and STRAIGHT, and on this course that describes about a quarter of
  // the run, so most of its meter goes unspent.
  medium: Object.freeze({
    stats: Object.freeze({ speed: 20, edging: 22, trick: 20 }),
    look0: 52, lookK: 3.00, lookMax: 165,
    gain: 2.10, aggression: 0.78,
    dead: 0.030, slew: 5.0,
    bankM: 30,
    boostHi: 1.00, boostLo: 0.80, boostGate: 0.11, boostTrough: 8, crestEase: 1.6, vEase: 30.0,
    brakeSteer: 0.90, brakeSpeed: 26.0, panicOff: 62,
    tuckSteer: 0.34,
    popEvery: 5.0, chargeS: 0.38,
    guardStart: 56, guardLook: 36,
  }),
  // THE RACER. Reads the TROUGH, not the horizon: a shortish, speed-scaled read
  // that keeps the board on the gully floor where the fall line is. One smooth
  // input per bend, never the brake, and it will hold the boost key down through
  // a corner because its line is low enough to spend it on.
  hard: Object.freeze({
    stats: Object.freeze({ speed: 34, edging: 33, trick: 24 }),
    look0: 32, lookK: 1.70, lookMax: 115,
    gain: 1.90, aggression: 1.0,
    dead: 0.016, slew: 3.6,
    bankM: 18,
    boostHi: 0.97, boostLo: 0.30, boostGate: 0.62, boostTrough: 46, crestEase: 1.6, vEase: 30.0,
    brakeSteer: 1.10, brakeSpeed: 40.0, panicOff: 999,  // never satisfied == never brakes
    tuckSteer: 1.10,
    popEvery: 5.0, chargeS: 0.42,
    guardStart: 30, guardLook: 26,          // stays low in the gully
  }),
});

// ---------------------------------------------------------------------------
// LINE ARCHETYPES — the reason r1 and r2, both 'easy', are not the same rider.
//
// A tier says how well a driver rides. An archetype says WHAT IT THINKS THE
// FAST WAY DOWN IS, and that is a separate axis: `bank` is signed, so a HUGGER
// and a BANKER are on opposite sides of every bend and swap sides at every
// reversal. The course reverses three times between z = 0 and z = 2400, so the
// pair cross over three times and are tens of metres apart in between. That is
// the separation AI-12 reads and it is not a lane: it is two different opinions
// about the same corner, re-derived every frame from the bend in front.
//
// Which archetype a rider draws depends on env.seed, so the field is a
// different set of characters every race.
// ---------------------------------------------------------------------------
const ARCHETYPES = Object.freeze([
  // name          bank    drift   patienceK  space
  // NOTE THE ABSENT COLUMN. An archetype does NOT touch `vision`. Read depth is
  // the tier axis on this course and it is worth 16 s (MEASURED: a 30 m base
  // read finishes in 110.2 s drag-limited, a 100 m base read in 126.6 s), so an
  // archetype that moved it would decide the race and AI-07 would come and go
  // with the dice. An archetype decides WHERE the driver sits in the gully, not
  // how well it reads it.
  Object.freeze({ name: 'hugger',       bank:  0.95, drift:  2.0, patienceK: 1.00, space: 13 }),
  Object.freeze({ name: 'banker',       bank: -0.95, drift: -2.0, patienceK: 1.10, space: 14 }),
  Object.freeze({ name: 'wanderer',     bank:  0.45, drift:  7.0, patienceK: 0.72, space: 15 }),
  Object.freeze({ name: 'straightener', bank: -0.45, drift: -7.0, patienceK: 1.22, space: 13 }),
]);

// Bend strength reference: |d2x/dz2| at which a driver calls something a real
// corner. MEASURED off the harness centreline: the sweep out of the start and
// the reversal at z ~ 790 both run 0.006-0.011 /m; the straight between z = 1000
// and z = 1500 runs under 0.002.
const CURV_REF = 0.0058;

// Corridor. The driver knows where the wall is (env.bounds.halfWidth) and keeps
// a margin from it; past `guardStart` metres of offset it shortens its own read
// and comes back, which is what a racer who can see the edge does.
const AIM_MARGIN_M = 30;
const GUARD_SPAN_M = 26;

// Catch-up (AI-05). ONE channel, and the smallest one available: a trailing
// driver stops scrubbing. Off entirely while leading — the `assist > 0` branch
// is not entered at all, so the input stream is bit-for-bit the stream the
// assist === false run produces.
const ASSIST_DEADBAND_M = 5;
const ASSIST_RANGE_M = 260;
const ASSIST_BRAKE_RELIEF = 0.12;   // most of the scrub trigger catch-up removes
// THE CATCH-UP CHANNEL IS ATTENTION, NOT SPEED. A driver that is being left
// behind stops daydreaming: it pulls its read in toward the racer's depth and
// stops letting itself drift up the bank. Nothing else moves — not the boost,
// not the stats, not a raw grant. The channel is chosen because it is the
// EASY tier's actual weakness, so catch-up helps exactly the rider that needs
// it and does almost nothing for a hard rival, whose read is already there.
const ASSIST_READ_PULL = 0.030;      // most of the read error catch-up removes
const ASSIST_READ0_M = 36, ASSIST_READK = 1.9, ASSIST_GUARD_M = 34;

const MIN_BOOST_HOLD_S = 0.8;   // a driver commits to the key, it does not tap it
const BOOST_COOLDOWN_S = 0.9;   // and does not stab it again the moment it lets go
const MIN_BOOST_ABORT_S = 0.45; // even an abort is a decision, not a twitch
const AIR_RELEASE_S = 0.35;     // a hop is not a jump; do not drop the burn for one
const ROLL_LP = 0.10;           // low-pass on the crest read
const TRAFFIC_FAR_M = 70;           // longitudinal window worth looking at
const TRAFFIC_TAU = 0.9;            // s of look-ahead on the closing geometry
const AVOID_PUSH = 1.1;             // aim offset, in units of the demanded room
const DUCK_M = 6.0, DUCK_AUTH = 1.0, DUCK_SOFT = 0.22;
const TIE_M = 2.0;                  // below this lateral gap there is no 'side'            // how much of the shortfall it takes out

export function createRivals(env = {}) {
  const centerX = env.courseCenterX ?? (() => 0);
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const bounds = env.bounds ?? {};
  const halfWidth = Number.isFinite(bounds.halfWidth) ? bounds.halfWidth : 120;
  const roster = env.roster ?? [];
  const seed = (env.seed ?? 1) | 0;
  const assistEnabled = env.assist !== false;

  // AI-11: the tables above are shared and frozen; everything this instance can
  // reach is a COPY made here, so nothing at module scope is ever mutated.
  const TIERS = {};
  for (const k of Object.keys(TIER_TRAITS)) {
    TIERS[k] = { ...TIER_TRAITS[k], stats: { ...TIER_TRAITS[k].stats } };
  }
  const ARCH = ARCHETYPES.map(a => ({ ...a }));

  const config = {
    tiers: TIERS,
    assistEnabled,
    maxAssistFrac: Math.max(ASSIST_BRAKE_RELIEF, ASSIST_READ_PULL),
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    assistChannel: 'read depth + scrub trigger; never the boost, the stats or a grant',
    archetypes: ARCH.map(a => a.name),
    curvRef: CURV_REF,
    aimMargin_m: AIM_MARGIN_M,
  };

  function init() {
    const rivals = {};
    const n = roster.length;
    roster.forEach((r, i) => {
      const rnd = mulberry32(mix(seed, i * 7919));
      const tier = r.tier in TIERS ? r.tier : 'medium';
      const T = TIERS[tier];
      // Archetype draw: seed-dependent, and distinct across the roster so the
      // two easy riders never draw the same opinion of the course.
      const A = ARCH[(i + (mix(seed, 3) % ARCH.length)) % ARCH.length];
      const j = (s) => 1 + (rnd() * 2 - 1) * s;   // +-s fractional jitter
      rivals[r.id] = {
        tier, arch: A.name,
        // vision
        look0: T.look0 * j(0.07),
        lookK: T.lookK * j(0.06),
        lookMax: T.lookMax,
        // steering personality
        gain: T.gain * j(0.06),
        dead: T.dead * A.patienceK * j(0.12),
        slew: T.slew / A.patienceK * j(0.10),
        // the opinion about the corner
        bank: A.bank * j(0.10),
        bankM: T.bankM * j(0.10),
        drift: A.drift + (rnd() * 2 - 1) * 2.0,
        space: A.space + (i - (n - 1) / 2) * 0.4,
        // throttle personality
        boostHi: T.boostHi, boostLo: T.boostLo * j(0.05), boostGate: T.boostGate * j(0.08),
        boostTrough: T.boostTrough * j(0.08), crestEase: T.crestEase * j(0.10), vEase: T.vEase * j(0.03),
        brakeSteer: T.brakeSteer * j(0.05), brakeSpeed: T.brakeSpeed * j(0.05),
        panicOff: T.panicOff * j(0.06),
        tuckSteer: T.tuckSteer,
        // nerve
        popEvery: T.popEvery * j(0.12), chargeS: T.chargeS * j(0.08),
        guardStart: T.guardStart * j(0.06), guardLook: T.guardLook,
        // mutable per-frame driver state (no physics state ever lives here)
        steer: 0, boosting: false, boostHold: 0, boostCool: 0, roll: 0,
        popTimer: 1.0 + rnd() * T.popEvery, crouchLeft: 0, wantPop: false,
      };
    });
    return { t: 0, rivals };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const ids = Object.keys(rs.rivals);
    const player = world && world.player ? world.player : null;
    const rvW = (world && world.rivals) ? world.rivals : {};
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const self = rvW[id];
      if (!self) continue;
      out[id] = drive(rs.rivals[id], i, self, ids, rvW, player, dt);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // ONE DRIVER, ONE FRAME. Everything below reads state and returns keys.
  // -------------------------------------------------------------------------
  function drive(R, rank, self, ids, rvW, player, dt) {
    const x = self.pos[0], y = self.pos[1], z = self.pos[2];
    const v = Math.hypot(self.vel[0], self.vel[2]);

    // ---- catch-up: computed ONCE, zero unless genuinely trailing ----------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - z;
      if (behind > ASSIST_DEADBAND_M) assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
    }

    // ---- VISION: how far down the hill this driver is reading, right now ---
    // Speed-coupled on purpose: a driver going faster looks further, so the
    // chord a fast rider cuts is longer than the one a slow rider cuts even
    // when their traits are identical. The line is a function of the state.
    const cHere = centerX(z);
    const off = x - cHere;
    const aOff = Math.abs(off);
    // corridor guard: past guardStart the driver pulls its read in and comes
    // back to the middle rather than carrying the cut into the wall.
    // Catch-up, channel 1 of 2: the read tightens. Untouched when assist is 0 —
    // the branch is not entered at all, so the leading stream is bit-identical
    // to the assist === false stream (AI-05's sign clause).
    let look0 = R.look0, lookK = R.lookK, guardStart = R.guardStart;
    if (assist > 0) {
      const pull = ASSIST_READ_PULL * assist;
      look0 += (ASSIST_READ0_M - look0) * pull;
      lookK += (ASSIST_READK - lookK) * pull;
      guardStart += (ASSIST_GUARD_M - guardStart) * pull;
    }
    const guard = clamp((aOff - guardStart) / GUARD_SPAN_M, 0, 1);
    let L = clamp(look0 + lookK * v, 26, R.lookMax);
    L = L + (R.guardLook - L) * guard;

    // ---- THE BEND IN FRONT, measured over this driver's OWN read ----------
    const zM = z + L * 0.5, zA = z + L;
    const c0 = cHere, cM = centerX(zM), cA = centerX(zA);
    // second difference over the read -> local curvature of the course line
    const curv = (cA - 2 * cM + c0) * 4 / (L * L);
    const bendSgn = curv >= 0 ? 1 : -1;             // +1 => inside of bend is +x
    const bendStr = clamp(Math.abs(curv) / CURV_REF, 0, 1);

    // ---- THE LINE, as an opinion about that bend --------------------------
    // bank > 0 dives to the inside; bank < 0 climbs the outside shoulder. The
    // sign flips with the bend, so this is not a lane: on the reversal at
    // z ~ 790 a hugger and a banker trade sides.
    let lineOff = R.bank * bendSgn * bendStr * R.bankM + R.drift;
    // commitment: a driver with low aggression under-commits to its own idea
    lineOff *= (0.55 + 0.45 * (TIERS[R.tier].aggression));

    // ---- TRAFFIC. A driver leaves room; it does not ride through people. ---
    // ---- TRAFFIC. A driver leaves room; it does not ride through people. ----
    // PREDICTIVE, not positional. At 30 m/s a rider covers half a metre a frame,
    // so a term that waits until two riders are already close is a term that
    // fires after the near miss: MEASURED, a 9 m longitudinal window let AI-12's
    // minimum separation fall to 0.084 m. This looks at where both riders will
    // BE in TRAFFIC_TAU seconds, takes the worse of that and now, and reacts to
    // the horizontal gap — which covers a rider closing from behind and one
    // converging sideways with the same instrument.
    let push = 0, duck = 0, soft = 0;
    for (let k = 0; k <= ids.length; k++) {
      // the roster, then the player: the same courtesy either way
      const o = k < ids.length ? rvW[ids[k]] : (player ?? null);
      if (!o || o === self) continue;
      const dz0 = o.pos[2] - z, dx0 = x - o.pos[0];
      if (dz0 > TRAFFIC_FAR_M || dz0 < -TRAFFIC_FAR_M) continue;
      const dzT = dz0 + (o.vel[2] - self.vel[2]) * TRAFFIC_TAU;
      const dxT = dx0 - (o.vel[0] - self.vel[0]) * TRAFFIC_TAU;
      const d0 = Math.hypot(dx0, dz0), dT = Math.hypot(dxT, dzT);
      const near = d0 <= dT ? d0 : dT;
      if (near >= R.space) continue;
      // push AWAY along the lateral axis; the sign is whichever side this
      // driver is already on, and it is the side it commits to.
      // WHICH WAY TO GO. While there is a side to be on, it is the side this
      // driver is already on. Nose to nose there is no such side, and two
      // drivers both picking "away from a lateral gap of 3 cm" pick the same way
      // and ride straight through each other — MEASURED, a separation of 0.010 m.
      // So the tie is broken by a FIXED rank (grid order, and the player outranks
      // every rival): one of them goes left, the other right, every frame,
      // consistently, with no negotiation.
      const oRank = k < ids.length ? k : -1;
      const sgn = Math.abs(dx0) > TIE_M ? (dx0 >= 0 ? 1 : -1) : (rank > oRank ? 1 : -1);
      const w = 1 - near / R.space;
      push += sgn * R.space * w * w * AVOID_PUSH;
      // AND THE ELBOW. Inside DUCK_M the aim offset is too slow a lever — it has
      // to travel through the steering lag first — so the driver puts a little
      // steer in directly. Still an input, still bounded.
      if (near < DUCK_M) {
        const q = 1 - near / DUCK_M;
        soft += sgn * DUCK_SOFT * q;        // a lean, felt from a few metres out
        duck += sgn * q * q * q;            // the elbow, and only when it is close
      }
    }
    lineOff += push;

    const lim = halfWidth - AIM_MARGIN_M;
    lineOff = clamp(lineOff, -lim, lim);
    // while recovering, the aim collapses onto the middle
    if (guard > 0) lineOff *= (1 - guard);

    const tx = cA + lineOff, tz = zA;

    // ---- STEERING: aggression sets the gain, patience the smoothness -------
    const want = Math.atan2(tz - z, tx - x);
    const err = wrapPi(want - self.heading);
    const aerr = Math.abs(err);
    // soft deadband: a patient driver ignores small error instead of chasing it
    const eff = aerr <= R.dead ? 0 : (err >= 0 ? aerr - R.dead : -(aerr - R.dead));
    let target = clamp(eff * R.gain, -1, 1);
    if (!Number.isFinite(target)) target = 0;
    // slew limit: one smooth input, not a saw. TURN_DRAG bills |steer|, so this
    // is a real time lever and not a cosmetic one.
    const maxStep = R.slew * dt;
    let steer = R.steer + clamp(target - R.steer, -maxStep, maxStep);
    R.steer = clamp(steer, -1, 1);          // the elbow is not part of the line
    // THE ELBOW OVERRIDES, it does not add. Added to a steer that is already at
    // the stop it does nothing at all, and at the start gate that is exactly the
    // state two riders chasing the same far aim point are in — MEASURED, they
    // closed from 5 m to 0.6 m inside four seconds with the avoidance term
    // "working". Close enough to touch, the driver throws the board and the line
    // waits.
    const dw = clamp(Math.abs(duck) * DUCK_AUTH, 0, 1);
    steer = clamp(R.steer * (1 - dw) + (duck >= 0 ? 1 : -1) * dw + soft, -1, 1);
    if (!Number.isFinite(steer)) steer = 0;
    const aSteer = Math.abs(steer);

    // ---- NERVE: charge, find a lip, pop -----------------------------------
    // THE CREST READ. Three terrain samples, once a frame: is the ground in front
    // rolling AWAY faster than it is falling here? That is a lip, and a driver
    // does two things with it — it loads the board for a pop, and it gets OFF
    // the boost so it does not go over the crest flat out. MEASURED: this course
    // launches a rider doing 30 m/s over the roll at z ~ 500 and the landing
    // redirect converts the fall into 34.7 m/s of horizontal speed, which is
    // over V_CAP and reads as an impossible speed however honestly it was
    // earned. A racer crests a roll a few m/s down. This is what that costs.
    const crest = Math.max(18, v * 0.85);
    const hHere = sampleHeight(x, z);
    const hMid = sampleHeight(x, z + crest * 0.5);
    const hFar = sampleHeight(x, z + crest);
    // Low-passed, because the raw reading chatters on the micro-rolls and a
    // driver that reacted to every one of them would strobe the boost key.
    const rollRaw = (hMid - hFar) - (hHere - hMid);    // > 0 == convex lip
    R.roll += (rollRaw - R.roll) * ROLL_LP;
    const rollAway = R.roll;

    let crouch = false, jumpRelease = false;
    if (R.crouchLeft > 0) {
      // charge only accrues while supported, so hold the crouch until the
      // board is actually down (AI-10 wants charge >= 0.25 at release).
      if (self.onGround) R.crouchLeft -= dt;
      crouch = true;
      if (R.crouchLeft <= 0) { R.wantPop = true; }
    } else if (R.wantPop) {
      if (self.onGround) { jumpRelease = true; R.wantPop = false; }
    } else {
      R.popTimer -= dt;
      if (R.popTimer <= 0 && self.onGround && v > 6) {
        if (rollAway > 0.15 || R.popTimer < -1.2) {
          R.crouchLeft = R.chargeS;
          R.popTimer = R.popEvery;
        }
      }
    }

    // ---- BOOST DISCIPLINE: meter hysteresis + a straightness gate ----------
    // Reads self.boostMeter. Never writes it. The hysteresis is what makes the
    // flame a burn and not a strobe: hard holds the key for seconds at a time.
    const meter = Number.isFinite(self.boostMeter) ? self.boostMeter : 0;
    // THE TROUGH CLAUSE is where the line pays for the throttle: a driver whose
    // own line has carried it up the bank is not in a position to spend boost,
    // and it does not press the key. So a bad read costs a rider its boost
    // windows as well as its speed — the two traits are not independent.
    if (R.boosting) {
      R.boostHold += dt;
      // MIN_BOOST_HOLD: a driver commits to the key. Without it the meter
      // hysteresis still lets a marginal frame flick it off and on again, and a
      // 50 ms press is a strobing flame rather than a burn.
      if (R.boostHold >= MIN_BOOST_HOLD_S
        && (meter <= R.boostLo || aSteer > R.boostGate * 1.55
          || aOff > R.boostTrough * 1.6)) R.boosting = false;
      // the two releases a driver makes without thinking about the meter: the
      // ground is about to drop away, or the board already is not on it (thrust
      // is inert in the air and the meter drains anyway).
      // ...and the two a driver makes without thinking about the meter: the
      // ground is about to drop away, or the board already is not on it (thrust
      // is inert in the air and the meter drains anyway). A short hop does not
      // count — the micro-rolls take the board off the snow constantly.
      if (R.boostHold >= MIN_BOOST_ABORT_S
        && (rollAway > R.crestEase || (self.airTime ?? 0) > AIR_RELEASE_S
          || v > R.vEase)) R.boosting = false;
      if (meter <= 0) R.boosting = false;
      if (!R.boosting) R.boostCool = BOOST_COOLDOWN_S;
    } else if (R.boostHi <= 1) {
      R.boostCool -= dt;
      // re-arm well below the release threshold, and never inside the cooldown:
      // between them, one decision per burn instead of one per frame.
      if (R.boostCool <= 0 && meter >= R.boostHi && aSteer < R.boostGate
        && aOff < R.boostTrough && v > 7 && v < R.vEase * 0.93
        && self.onGround && rollAway < R.crestEase * 0.5) {
        R.boosting = true; R.boostHold = 0;
      }
    }
    const boost = R.boosting;

    // ---- CAUTION: scrub when the wheel saturates and the driver is hot -----
    // The catch-up channel, and the only one: a trailing driver lets it run.
    // A driver scrubs for one of two reasons: the wheel has loaded up, or it has
    // realised it is a long way up the bank and wants the board back under it.
    // The second one is why `caution` bites at all on this course — the easy
    // driver's own read keeps putting it out there, so its line is what makes it
    // reach for the brake. Catch-up, channel 2 of 2, relaxes that panic.
    let brakeSpeed = R.brakeSpeed, panicOff = R.panicOff;
    if (assist > 0) {
      brakeSpeed = brakeSpeed * (1 + ASSIST_BRAKE_RELIEF * assist);
      panicOff = panicOff * (1 + ASSIST_BRAKE_RELIEF * assist);
    }
    const brake = (aSteer >= R.brakeSteer || aOff > panicOff) && v > brakeSpeed && self.onGround;

    // ---- TUCK: a nervous driver stands up when it is fighting the board ----
    const tuck = !crouch && aSteer < R.tuckSteer;

    const inp = { steer };
    if (tuck) inp.tuck = true;
    if (boost) inp.boost = true;
    if (brake) inp.brake = true;
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  return { config, init, step };
}
