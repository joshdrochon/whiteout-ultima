// ============================================================================
// Rivals — candidate A. PURSUIT CONTROLLER ON A PRECOMPUTED RACING LINE.
//
// Three parts, in this order every frame:
//   LINE     one racing line, built once in createRivals from env.courseCenterX
//            by constrained curvature smoothing (derivation below). Shared by
//            every rival and every tier; only a small lateral lane offset
//            separates riders.
//   PURSUIT  steer is a pure-pursuit curvature command inverted through the
//            accepted physics' own yaw-authority model, so the rider tracks the
//            line instead of chasing its heading error.
//   THROTTLE tuck / brake / boost from a target-speed + meter-hysteresis
//            policy. THE TIERS LIVE HERE AND NOWHERE ELSE.
//
// AI-01: this module returns INPUTS. It reads world state; it writes none of it.
// Deterministic from env.seed alone. No Date, no Math.random, no module state.
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
const mix = (a, b) => (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b + 1 | 0, 0x165667b1)) >>> 0;

// ---------------------------------------------------------------------------
// THE RACING LINE — HOW IT IS DERIVED, HONESTLY.
//
// Nodes every LINE_DZ metres of z from before the gate to past the finish. Each
// node starts on the centreline. Then LINE_ITERS sweeps of damped Laplacian
// smoothing, x_i <- x_i + w*(mid(x_i-1, x_i+1) - x_i), each sweep re-clamped to
// |x_i - centreline(z_i)| <= LINE_MAXOFF. Endpoints pinned.
//
// That is a discrete minimum-curvature line inside a lateral corridor, in the
// z-parametrisation. It is NOT a true minimum-lap-time line: it ignores the
// terrain entirely (no bank, no fall-line, no grip budget), it measures
// curvature against z rather than arc length, and it optimises geometry rather
// than time. Calling it a racing line means only this: of the lines that stay
// within LINE_MAXOFF of the centre of the gully, it is close to the straightest.
//
// LINE_ITERS IS THE CORNER-CUT KNOB, NOT AN ARBITRARY NUMBER. Damped Laplacian
// smoothing is diffusion, so a finite number of sweeps is a finite diffusion
// length: sqrt(2*w*iters)*LINE_DZ ~ 320 m of z at these settings. The line
// therefore ignores centreline features shorter than about 320 m and follows
// the ones longer than that — which is what cutting a corner means. Running it
// to convergence instead pins the line flat against the clamp for hundreds of
// metres at a time, and MEASURED that is a worse line, not a better one: worst
// lateral excursion over the 32-run matrix 85.6 m converged against 75.6 m here,
// for the same finish times.
//
// WHAT IT ACTUALLY BUYS, MEASURED, NOT ASSUMED. Over z in [0, 2400] the
// centreline is 2573 m long and this line is 2503 m: 70 m shorter, 2.7%. Its
// largest offset from the centre is 40.4 m, so the LINE_MAXOFF clamp at 70 m
// never binds — it is a guard rail, not the shape.
//
// WHAT IT COSTS. The gully is a trough: 60 m off centre is ~14 m up the bank,
// 90 m is ~30 m up. This line averages 2.5 m above the trough floor, so it pays
// a lateral gravity term the centreline does not, and 2.7% of distance is
// therefore not 2.7% of time.
// ---------------------------------------------------------------------------
const LINE_DZ = 15;
const LINE_ITERS = 260;
const LINE_W = 0.9;
const LINE_MAXOFF = 70;

function buildLine(centerX, z0, z1) {
  const n = Math.max(4, Math.round((z1 - z0) / LINE_DZ) + 1);
  const c = new Float64Array(n), x = new Float64Array(n), prev = new Float64Array(n);
  for (let i = 0; i < n; i++) { c[i] = centerX(z0 + i * LINE_DZ); x[i] = c[i]; }
  for (let k = 0; k < LINE_ITERS; k++) {
    prev.set(x);
    for (let i = 1; i < n - 1; i++) {
      let v = prev[i] + LINE_W * (0.5 * (prev[i - 1] + prev[i + 1]) - prev[i]);
      const lo = c[i] - LINE_MAXOFF, hi = c[i] + LINE_MAXOFF;
      x[i] = v < lo ? lo : v > hi ? hi : v;
    }
  }
  // Curvature per node, kappa = |x''| / (1 + x'^2)^1.5 in the z-parametrisation.
  // It is precomputed so the per-frame preview is a table read, not calculus.
  const kap = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const d1 = (x[i + 1] - x[i - 1]) / (2 * LINE_DZ);
    const d2 = (x[i + 1] - 2 * x[i] + x[i - 1]) / (LINE_DZ * LINE_DZ);
    kap[i] = Math.abs(d2) / Math.pow(1 + d1 * d1, 1.5);
  }
  kap[0] = kap[1]; kap[n - 1] = kap[n - 2];
  return { z0, n, x, c, kap };
}
function lineAt(L, z, arr) {
  const f = (z - L.z0) / LINE_DZ;
  let i = Math.floor(f);
  if (i < 0) i = 0; else if (i > L.n - 2) i = L.n - 2;
  const t = clamp(f - i, 0, 1);
  return arr[i] * (1 - t) + arr[i + 1] * t;
}

// ---------------------------------------------------------------------------
// THE TIERS. Throttle only.
//
// The line, the lookahead and the steering gain are IDENTICAL for all three
// tiers, deliberately: on this course a lazy line cuts the meander's corners,
// so tiers separated by the line measure the course rather than the rider, and
// the tier order can come out inverted. Everything that differs below is a
// throttle: the speed the rider is willing to hold, how it manages the boost
// meter, and its declared stats.
//
// ONE NUMBER SEPARATES THEM: vBoost, the speed this rider is willing to spend
// boost to hold. Below it the rider tucks and pulls the boost trigger on its
// meter cycle; above vBoost + BRAKE_HEADROOM it scrubs. The accepted physics'
// tucked terminal speed on this mountain's mean 23.6 deg is about 20.7 m/s, so
// EVERY tier here is boost-limited rather than drag-limited and the ladder is
// monotone by construction.
//
// The boost HYSTERESIS is deliberately the same for all three. It cannot be a
// tier lever: BOOST_DRAIN 0.125 against BOOST_REGEN 0.10 fixes the duty cycle
// of any on/off pair at 0.125^-1 / (0.125^-1 + 0.10^-1) = 44.4%, whatever the
// thresholds are, so widening or narrowing the band changes the period and
// nothing else. 0.50/0.08 gives a 3.4 s / 4.2 s cycle. Holding the key instead
// empties the meter in 8 s and leaves nothing for the remaining 80 s of course.
//
// MEASURED over the 8-seed matrix, against the harness' 107.6 s reference
// player:  easy 120.6 s   medium 109.7 s   hard 92.7 s.
// ---------------------------------------------------------------------------
const S_EASY = 6;
const S_HARD = 34;
// vBoost per tier, m/s. Empirical slope on this course: -3.9 s of finish time
// per +1 m/s, near enough linear across 18..29 m/s.
const V_EASY = 18.5;
const V_MEDIUM = 20.8;
const V_HARD = 26.0;
const BRAKE_HEADROOM = 3.0;
const B_ON = 0.50;
const B_OFF = 0.08;
const TIERS = {
  easy:   { stats: { speed: S_EASY, edging: 12, trick: 20 }, vBoost: V_EASY },
  medium: { stats: { speed: 20, edging: 20, trick: 20 },     vBoost: V_MEDIUM },
  hard:   { stats: { speed: S_HARD, edging: 30, trick: 24 }, vBoost: V_HARD },
};
const BOOST_HYST = { on: B_ON, off: B_OFF };

// Pursuit / physics-model constants. These MIRROR the accepted physics' own
// numbers so the controller can invert its yaw authority; they are read-only
// copies, not a second integrator.
const R_SIDECUT = 6.4, PHI_MAX_COS = 0.5, OMEGA_PIVOT = 160 * Math.PI / 180;
const PIVOT_FADE = 12, A_LAT = 26, STEER_REF_SPEED = 5;
const TUCK_STEER = 0.6, CROUCH_STEER = 0.45;

const LOOK_BASE = 46;            // m of lookahead at a standstill
const LOOK_PER_V = 1.35;         // + m of lookahead per m/s
const LOOK_MIN = 40, LOOK_MAX = 165;
const PURSUIT_GAIN = 1.15;       // commitment on the inverted curvature command
const LANE_PITCH_M = 9;          // lateral spacing between rival lanes
const LANE_SPAN_M = 45;          // and the widest total spread they may use
const LANE_WEAVE_M = 2.5;        // slow weave off the lane, so no rider is welded
const LANE_WEAVE_HZ = 0.05;
const CORRIDOR_MARGIN_M = 30;    // never aim closer than this to the wall
const BRAKE_HYST = 0.7;          // m/s band around the scrub threshold
const PREVIEW_M = [25, 55, 95, 145];  // curvature preview distances
const A_BRAKE = 3.6;             // m/s^2 assumed scrub, for the preview
const GRIP_FRAC = 0.75;          // fraction of A_LAT the preview will spend
const REC_ON_M = 14;             // cross-track error that opens recovery
const REC_OFF_M = 6;             // and the error that closes it again
const REC_LOOK = 0.55;           // lookahead scale while recovering
const REC_GAIN = 1.55;           // pursuit gain scale while recovering
const POP_PERIOD_S = 8;          // one deliberate charged pop per rider per 8 s
const CROUCH_S = 0.40;           // charge held before release (0.47 of T_CHARGE)

// Catch-up (AI-05). BOUNDED, ONE-DIRECTIONAL, and spent through exactly two
// channels: the LOOKAHEAD and the BOOST POLICY. Never a speed grant, never the
// line, and never the scrub threshold. A rival that is not behind takes the
// identical code path env.assist === false takes — the assist terms are inside
// `if (assist > 0)` rather than multiplied by zero — which is what makes the
// two input streams byte-identical while it leads.
//
// THE LIFT IS THE LEVER THAT MATTERS, and it is a straight dial on the gate.
// MEASURED, worst assisted/unassisted finish-time ratio over 8 live seed pairs
// plus 2 frozen-player pairs:
//     ASSIST_BOOST_LIFT 1.1 -> 1.0356      (AI-12 min separation 2.15 m)
//     ASSIST_BOOST_LIFT 2.0 -> 1.0634      <- here (AI-12 1.66 m)
//     ASSIST_BOOST_LIFT 3.0 -> 1.0902
// 2.0 is the choice: a trailing rider claws back about 6% of its run, which is
// a band a player can feel, while keeping 8 points of headroom under a HARD
// ceiling of 1.15. Deepening the meter thresholds is the second channel and is
// nearly inert on its own (the duty cycle is fixed, see the tier note); it
// shortens the cycle so a trailing rider spends the meter sooner.
const ASSIST_DEADBAND_M = 6;
const ASSIST_RANGE_M = 260;
const ASSIST_LOOK_STRETCH = 0.22;   // + fraction of lookahead when fully behind
const ASSIST_BOOST_DEEPEN = 0.30;   // fraction the meter thresholds come down
const ASSIST_BOOST_LIFT = 2.0;      // m/s the boost gate lifts when fully behind

export function createRivals(env = {}) {
  const centerX = typeof env.courseCenterX === 'function' ? env.courseCenterX : (() => 0);
  const bounds = env.bounds ?? {};
  const zStart = Number.isFinite(bounds.zStart) ? bounds.zStart : 0;
  const zFinish = Number.isFinite(bounds.zFinish) ? bounds.zFinish : 2400;
  const halfWidth = Number.isFinite(bounds.halfWidth) ? bounds.halfWidth : 120;
  const roster = Array.isArray(env.roster) ? env.roster : [];
  const seed = (env.seed ?? 1) | 0;
  const assistEnabled = env.assist !== false;

  const LINE = buildLine(centerX, zStart - 120, zFinish + 400);
  const laneCap = Math.max(4, halfWidth - CORRIDOR_MARGIN_M);
  const lanePitch = Math.min(LANE_PITCH_M, LANE_SPAN_M / Math.max(1, roster.length));

  // A FRESH COPY PER INSTANCE. config.tiers is handed to the harness, which
  // installs those stats into each rival's physics; sharing the module-level
  // object would make a caller's edit module-level mutable state and break
  // AI-11 for every instance built afterwards.
  const tiers = {};
  for (const k of Object.keys(TIERS)) tiers[k] = { stats: { ...TIERS[k].stats }, vBoost: TIERS[k].vBoost };

  const config = {
    tiers,
    assistEnabled,
    maxAssistFrac: 0.07,          // this module's declared bound on how much
                                  // catch-up may move a finish time. AI-05
                                  // measures the real one and does not take
                                  // this on trust: measured worst 1.0634.
    assistChannels: ['lookahead', 'boostGate', 'boostThresholds'],
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    line: { dz: LINE_DZ, iters: LINE_ITERS, maxOffset_m: LINE_MAXOFF,
      nodes: LINE.n, derivation: 'constrained minimum-curvature smoothing of env.courseCenterX' },
    lookahead_m: { base: LOOK_BASE, perSpeed: LOOK_PER_V, min: LOOK_MIN, max: LOOK_MAX },
    pursuitGain: PURSUIT_GAIN,
    lanePitch_m: lanePitch,
    corridorMargin_m: CORRIDOR_MARGIN_M,
    popPeriod_s: POP_PERIOD_S,
  };

  // Lane slots straddle the line: nobody's lane is 0, so the rider on the
  // racing line proper does not exist and AI-12's separation never depends on
  // a collision term the accepted physics does not have.
  function laneSlot(i, n) {
    const k = i - (n - 1) / 2;
    return (k < 0 ? k - 0.5 : k + 0.5) * lanePitch;
  }

  function init() {
    const rivals = {};
    roster.forEach((r, i) => {
      const rnd = mulberry32(mix(seed, i));
      const tier = r && r.tier in TIERS ? r.tier : 'medium';
      const T = TIERS[tier];
      const stats = { speed: 20, edging: 20, trick: 20, ...T.stats };
      // The harness installs these stats into this rival's physics, so the
      // controller can and must read its OWN edge factor out of them: a rider
      // that assumes default grip oversteers itself off the line.
      const edgeF = 1 + 0.10 * (stats.edging - 20) / 10;
      rivals[r && r.id !== undefined ? r.id : 'rival' + i] = {
        tier,
        aLatEff: A_LAT * (1 + 0.5 * (edgeF - 1)),
        edgeF,
        lane: laneSlot(i, roster.length) + (rnd() * 2 - 1) * 1.6,
        lookJitter: 0.94 + 0.12 * rnd(),
        // Per-RIDER throttle personality, from the seed alone. It is what makes
        // eight seeds eight races rather than one race run eight times, and it
        // is deliberately small (+/-2.5%) so it never reorders the tiers.
        vBoost: T.vBoost * (0.975 + 0.05 * rnd()),
        weavePhase: rnd() * Math.PI * 2,
        popTimer: 1.2 + rnd() * POP_PERIOD_S,
        braking: false,
        recover: false,
        boosting: false,
        crouchLeft: 0,
        wantPop: false,
      };
    });
    return { t: 0, rivals };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const player = world && world.player ? world.player : null;
    const pool = world && world.rivals ? world.rivals : null;
    if (!pool) return out;
    for (const id of Object.keys(rs.rivals)) {
      const self = pool[id];
      if (!self) continue;
      out[id] = driveOne(rs.rivals[id], self, player, rs.t, dt);
    }
    return out;
  }

  function driveOne(R, self, player, t, dt) {
    const x = self.pos[0], z = self.pos[2];
    const v3 = Math.hypot(self.vel[0], self.vel[1], self.vel[2]);
    const vh = Math.hypot(self.vel[0], self.vel[2]);
    const onGround = !!self.onGround;

    // ---- catch-up: only while BEHIND, only through lookahead + boost --------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - z;
      if (behind > ASSIST_DEADBAND_M) assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
    }

    // ---- THROTTLE (the tier). Decided first: it sets the steering scale. ----
    // Preview: the slowest speed the line ahead asks for, given a scrub of
    // A_BRAKE over the distance to it. On this course the curvature term almost
    // never binds — the tightest bend on the built line has kappa 1.26e-3, a
    // 790 m radius, which asks for 143 m/s — so the rider's own vBoost +
    // BRAKE_HEADROOM is the threshold that actually governs. The preview is kept
    // because a course with a real corner in it would need it, and because a
    // governor with no look-ahead is a rider with its eyes shut.
    let vLimit = R.vBoost + BRAKE_HEADROOM;
    for (let i = 0; i < PREVIEW_M.length; i++) {
      const d = PREVIEW_M[i];
      const k = lineAt(LINE, z + d, LINE.kap);
      if (!(k > 1e-9)) continue;
      const vC = Math.sqrt((GRIP_FRAC * R.aLatEff) / k);
      const vAllowed = Math.sqrt(vC * vC + 2 * A_BRAKE * d);
      if (vAllowed < vLimit) vLimit = vAllowed;
    }
    if (R.braking) { if (vh < vLimit - BRAKE_HYST) R.braking = false; }
    else if (vh > vLimit + BRAKE_HYST) R.braking = true;
    const brake = R.braking && onGround;

    // Boost: one meter-hysteresis cycle, gated by the rider's target speed. The
    // key is never held while the rider is already at target — a policy that
    // brakes and boosts at once is not a policy, it is a fight. BRAKE_HEADROOM
    // is what keeps the two apart: the scrub threshold sits 3 m/s above the
    // boost gate, so catch-up lifting the gate is not immediately undone by the
    // rider's own brake.
    let boost = false;
    {
      let gate = R.vBoost;
      let on = BOOST_HYST.on, off = BOOST_HYST.off;
      if (assist > 0) {
        gate += ASSIST_BOOST_LIFT * assist;
        const d = 1 - ASSIST_BOOST_DEEPEN * assist;
        on *= d; off *= d;
      }
      const m = typeof self.boostMeter === 'number' ? self.boostMeter : 0;
      if (R.boosting) { if (m <= off) R.boosting = false; }
      else if (m >= on) R.boosting = true;
      boost = R.boosting && vh < gate;
    }

    // ---- the deliberate pop (AI-10) ---------------------------------------
    // Charge is accrued by physics from this crouch, and only while the board
    // is supported, so the crouch is held until the rider is actually on the
    // ground. A release at charge 0 is J_MIN, about 0.22 m of hop, which is not
    // riding the kickers.
    let crouch = false, jumpRelease = false;
    if (R.crouchLeft > 0) {
      crouch = true;
      if (onGround) R.crouchLeft -= dt;
      if (R.crouchLeft <= 0) R.wantPop = true;
    } else if (R.wantPop) {
      if (onGround) { jumpRelease = true; R.wantPop = false; }
    } else {
      R.popTimer -= dt;
      if (R.popTimer <= 0 && onGround) { R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; }
    }

    // ---- PURSUIT ----------------------------------------------------------
    // Lookahead grows with speed, as pure pursuit's stability requires; it is
    // the SAME for every tier (see the tier note) and only the seed jitters it
    // per rider.
    const weave = LANE_WEAVE_M * Math.sin(2 * Math.PI * LANE_WEAVE_HZ * t + R.weavePhase);

    // RECOVERY, with hysteresis. A long lookahead is a smooth line and a lazy
    // one: on the tightest bend (z ~ 650-800, where the centreline's lateral
    // rate reaches 0.7 m per m) the rider spends half its frames off the snow
    // and drifts wide of the line it is pursuing. Past REC_ON_M of cross-track
    // error it shortens the lookahead, commits harder and STANDS UP OUT OF THE
    // TUCK — the accepted physics scales steering by TUCK_STEER 0.6, so
    // dropping the tuck is worth 67% more yaw authority, which is the largest
    // single lever the input set has. MEASURED, widest line over the 32-run
    // matrix against a half-width of 120: 112.8 m with this branch disabled,
    // 75.6 m with it. It is not a refinement; without it this module rides 7 m
    // from the wall.
    const lineHere = lineAt(LINE, z, LINE.x) + R.lane + weave;
    const xErr = Math.abs(x - lineHere);
    if (R.recover) { if (xErr < REC_OFF_M) R.recover = false; }
    else if (xErr > REC_ON_M) R.recover = true;

    let look = (LOOK_BASE + LOOK_PER_V * vh) * R.lookJitter;
    if (assist > 0) look *= 1 + ASSIST_LOOK_STRETCH * assist;
    if (R.recover) look *= REC_LOOK;
    look = clamp(look, LOOK_MIN, LOOK_MAX);

    const tuck = !brake && !crouch && !R.recover;
    const tz = z + look;
    // The lane rides on the RACING LINE, and the whole aim point is then held
    // inside the corridor with a margin, so the corner-cut can never walk a
    // rider into the wall even if the line ever ran wider than it does.
    const cAt = lineAt(LINE, tz, LINE.c);
    let tx = lineAt(LINE, tz, LINE.x) + R.lane + weave;
    tx = clamp(tx, cAt - laneCap, cAt + laneCap);

    // Pure pursuit: the arc through the aim point has curvature 2*sin(alpha)/d,
    // so the yaw rate the line asks for is kappa*v. Invert the ACCEPTED
    // physics' own authority model for the steer that delivers it, instead of
    // feeding back raw heading error: the result tracks the line rather than
    // pointing at it.
    const dx = tx - x, dz = tz - z;
    const d = Math.hypot(dx, dz);
    let steer = 0;
    if (d > 1e-6) {
      const alpha = wrapPi(Math.atan2(dz, dx) - self.heading);
      const omegaWant = 2 * v3 * Math.sin(alpha) / d;
      const kSteer = (tuck ? TUCK_STEER : 1) * (crouch ? CROUCH_STEER : 1);
      const omegaCarve = v3 / Math.max(R_SIDECUT * PHI_MAX_COS, 0.5);
      const omegaPivot = OMEGA_PIVOT * Math.max(0, 1 - v3 / PIVOT_FADE);
      const cap = kSteer * Math.min((omegaCarve + omegaPivot) * R.edgeF,
        R.aLatEff / Math.max(v3, STEER_REF_SPEED));
      const gain = PURSUIT_GAIN * (R.recover ? REC_GAIN : 1);
      steer = cap > 1e-6 ? clamp((omegaWant / cap) * gain, -1, 1) : 0;
      if (!Number.isFinite(steer)) steer = 0;
    }

    const inp = { steer, tuck, boost, brake };
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  return { config, init, step };
}
