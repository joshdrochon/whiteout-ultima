// Candidate — jump-arcs cycle 3. SPEC-LITERAL TWO-TERM DRAG.
//
// Longitudinal ground model is EXACTLY the reference-bar equation, nothing else:
//
//     dv/dt = g*sin(theta) - mu*g*cos(theta)*sign(v) - lambda_long*v
//
// integrated in closed form per step (linear ODE: v(t) = v_eq + (v0-v_eq)e^{-b t},
// v_eq = a/b), so any dt is exact (PC-02) and the drag_shape fit recovers
// (mu, lambda) to fp precision with ~0 residual (JA-23/23b/23c). There is no
// quadratic term, no speed wall, no uphill relief, no shaping of any kind.
// Spec-sanctioned multipliers only: k_tuckDrag and k_turnDrag(steer) multiply
// LAMBDA_LONG (never the Coulomb term — that was cycle-2 X's disqualifier);
// surface mu ratios scale the Coulomb term; powder adds the spec depth-plow
// (powder only — the snow model measured by JA-23/24 stays pure two-term).
//
// TUNED KNOBS (all inside spec bands):
//   MU_BASE     0.0302   [0.03, 0.055]   } jointly pinned by PC-03 (needs
//   LAMBDA_LONG 0.223    [0.18, 0.32]    } v_ss(15deg) > 10 => lambda <= 0.225
//                                          at this mu) and PC-04 entry-
//                                          convergence (needs lambda >= ~0.222).
//   TUCK_DRAG   0.73     [0.65, 0.75]    PC-08 delta ~6.6 m/s in [5.5, 7.5]
//   J_MIN/J_MAX 2.2/5.0  [2-2.5/4.5-5.5] JA-02/03 airtime+apex bands
//   G_AIR       6.5      [6.0, 7.5]
//   Ramp efficiency: takeoff redirect is magnitude-preserving (1.0, the arcade
//   maximum) — anything above 1 is energy injection (cycle-2 X's other DQ).
//
// GENUINE GATE CONFLICT (flagged, NOT bridged) — JA-06/JA-07 vs JA-23/23b/24:
//   The runner's kicker gives a 27 m flat approach then a 6 m 30-deg ramp,
//   entry 18 m/s at x=-27. Under the MOST FAVORABLE in-band drag
//   (mu=0.03, lambda=0.18):
//     flat 27 m:  dv/dt = -(0.294 + 0.18 v)  => v_base = 12.6 m/s (t~1.78 s)
//     ramp 6 m:   adds g*sin30 = 4.905      => v_lip ~ 8.6 m/s
//   JA-03 pins (J_MAX, g_air): airtime 2J/g <= 1.6 and apex J^2/2g <= 2.0
//   force J <= 0.8*g and g <= 6.25 => best J_MAX = 5.0 at g_air = 6.25.
//     v_y = 8.6*sin30 + 5.0 = 9.3 m/s => equal-height airtime 2*9.3/6.25 = 2.97 s
//     (band 3.5-4.8 s), apex 6.9 m (band 12-18 m).  JA-06 FAILS.
//     Tap (J_MIN <= 2.5 by JA-02): v_y = 6.8 => airtime 2.17 s (band 2.9-3.8).
//     JA-07 FAILS.
//   Hitting the JA-06 apex floor (12 m) needs v_lip >= 14.5, i.e. v_base >=
//   17.5, i.e. entry >= ~23 m/s at x=-27. Infeasible at entry 18 under ANY
//   in-band (mu, lambda, J, g_air). Matches the cycle-2 critic's independent
//   verification; only the gate owner can resolve (re-band, shorten approach,
//   or define entrySpeed at the lip). Both gates are TOLERANCE; every HARD
//   gate passes.
//   MEASURED manifestation with this module: airtime 5.68 s (JA-06) / 5.22 s
//   (JA-07) — the in-band lip speed (~5.5 m/s horizontal) cannot even clear
//   the runner's 40 m trough (flight reach ~15 m), so the rider falls ~60 m to
//   the trough floor. The long number is the trough drop, not big air.
//
// CYCLE-2 mustFix RESPONSES:
//   * JA-04: the jumpRelease frame now runs the FULL ground tick (slope decel +
//     spec drag + redirect + integrate) and only then adds the world-up pop, so
//     the takeoff frame carries the same per-frame delta-h as the ramp trend the
//     runner subtracts — measured discontinuity ~0 instead of the ~1.9% that a
//     skipped drag frame produces.
//   * JA-25 + lip forgiveness: real coyote pop implemented, not a silent no-op.
//     Falling off a lip (constraint release, not a jump) keeps the charge and
//     arms a COYOTE_TIME (0.12 s) window; jumpRelease inside it adds the charged
//     impulse STRAIGHT WORLD-UP, unconditionally — horizontal velocity is never
//     touched (JA-25 exact-zero), and the pop feel survives late releases.
//   * Predictive constraint release BEFORE the redirect: each grounded tick
//     first probes sampleHeight one step ahead along the current velocity; if
//     the ground falls away (> GROUND_EPS) the frame goes ballistic with the
//     velocity UNTOUCHED — the cliff-contaminated normal stencil at a lip is
//     never used to bend the exit velocity (reactive post-hoc checks were the
//     cycle-2 Y critique).
//   * Spin caps exposed: config.spinCap / config.flipCap, plus
//     state.spinCapped / state.flipCapped set the frame a commanded rotation
//     saturates the cap (drives the "???" label).
//   * Stick-only spin rate does NOT scale with the trick stat (250-350
//     regardless); prewound spin does (JA-09 band measured at trick 40).
//   * JA-15..21 (uber crash rule + scoring economy) stay deferred to the
//     trick-system lane; the runner defers them (7 deferred HARD gates remain
//     lane-open — gate-owner scope, not implementable here).
//
// Inherited, unchanged from the accepted turning winner: carve/skid state split,
// anisotropic lateral kill, boost meter economy, landing yaw windows, rotation
// as pure animation state (PC-09/10, TN-07, JA-22).
//
// Pure math: no imports, no globals, no Date/random. Deterministic.

const DEG = Math.PI / 180;
const UP = [0, 1, 0];

export const DEFAULTS = {
  // --- gravity ---
  G_GROUND: 9.81,        // m/s^2, ground tick (slope-projected)
  G_AIR: 6.5,            // m/s^2, airborne only (band 6.0-7.5)
  // --- ground longitudinal drag / friction: THE two-term spec model ---
  MU_BASE: 0.0302,       // Coulomb coeff (x g cos theta); JA-23 band 0.03-0.055
  LAMBDA_LONG: 0.223,    // 1/s linear drag; JA-23b band 0.18-0.32
  // --- lateral (edge grip) ---
  LAMBDA_LAT: 4.0,       // 1/s lateral slip kill on snow (half-life 0.17 s)
  CARVE_LOCK: 1.5,       // extra lateral kill multiplier at full carve lock
  BETA_SKID: 12,         // deg slip angle beyond which the board is skidding
  // --- steering (carve geometry + caps) ---
  R_SIDECUT: 6.4,        // m board sidecut radius
  PHI_MAX: 60,           // deg edge angle at full steer lock
  OMEGA_PIVOT: 160,      // deg/s low-speed skid-pivot yaw authority
  PIVOT_FADE: 12,        // m/s speed at which pivot authority reaches zero
  A_LAT: 26,             // m/s^2 lateral accel ceiling (TN-14 band 25-35)
  STEER_REF_SPEED: 5,    // m/s speed floor in the A_LAT/v cap
  TUCK_STEER: 0.6,       // steering multiplier while tucked
  CROUCH_STEER: 0.45,    // steering multiplier while crouched
  TURN_DRAG: 0.15,       // k_turnDrag: +15% on LAMBDA_LONG at full lock (spec eq.)
  // --- tuck ---
  TUCK_DRAG: 0.73,       // k_tuckDrag on LAMBDA_LONG only (spec band 0.65-0.75)
  // --- brake ---
  BRAKE_DECEL: 2.5,      // m/s^2 added Coulomb-style decel (surface-scaled)
  // --- speed rails / boost ---
  V_CAP: 33,             // m/s hard clamp
  V_BOOST: 31,           // m/s boost target speed
  TAU_BOOST: 0.7,        // s boost relaxation time constant
  BOOST_DRAIN: 0.125,    // meter/s while boost held
  BOOST_REGEN: 0.10,     // meter/s while boost idle
  // --- jump ---
  T_CHARGE: 0.85,        // s to full crouch charge
  J_MIN: 2.2,            // m/s vertical impulse, tap
  J_MAX: 5.0,            // m/s vertical impulse, full charge
  NORMAL_BLEND_DOT: 0.7, // below this n.y, jump dir blends up+normal
  COYOTE_TIME: 0.12,     // s of lip forgiveness after a falling takeoff
  // --- air rotation (animation-only) ---
  SPIN_PREWOUND: 500,    // deg/s base with prewind (x1.18 at trick 40 => 590)
  SPIN_STICK: 300,       // deg/s stick-only — NOT trick-scaled (250-350 regardless)
  FLIP_RATE: 330,        // deg/s at trick stat 20
  AUTO_LEVEL: 220,       // deg/s leveling when rotation input released
  SPIN_CAP: 1800,        // deg recognized spin cap (beyond => "???")
  FLIP_CAP: 1080,        // deg recognized flip cap (beyond => "???")
  // --- landing ---
  CLEAN_YAW: 45,         // deg |heading-velYaw| for clean (auto-snap)
  CRASH_YAW: 90,         // deg and beyond = crash
  SKETCHY_SPEED_KEEP: 0.92,
  CRASH_SPEED_KEEP: 0.45,
  // --- stats ---
  SPEED_STAT_GAIN: 0.0175,  // fractional v_ss gain per +10 speed stat
  EDGE_STAT_GAIN: 0.10,
  TRICK_STAT_GAIN: 0.09,
  // --- powder plow (powder surface only; snow stays pure two-term) ---
  POWDER_PLOW: 4.5,      // m/s^2 extra decel at standstill in powder
  POWDER_PLOW_FADE: 24,  // m/s speed at which plow reaches zero
  // --- misc ---
  GROUND_EPS: 0.02,      // m ground-stick / constraint-release tolerance
};

// per-surface multipliers (ratios only)
const SURFACES = {
  snow:   { mu: 1.0,  grip: 1.0,  plow: 0 },
  ice:    { mu: 0.55, grip: 0.55, plow: 0 },
  powder: { mu: 1.3,  grip: 1.15, plow: 1 },
};

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrapPi = a => { a = a % (2 * Math.PI); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

// Exact per-step solution of ds/dt = a - b*s for s >= 0 (a already includes the
// signed Coulomb + slope drive). When the net constant drive is non-positive the
// flow clamps at 0 (Coulomb stop — no creep, no reversal here; reversal is
// decided by the caller against the static threshold).
function flowSpeed(v0, a, b, dt) {
  if (v0 <= 0 && a <= 0) return 0;
  const veq = a / b;
  const v = veq + (v0 - veq) * Math.exp(-b * dt);
  return a <= 0 ? Math.max(v, 0) : v;
}

export function createPhysics(env, opts = {}) {
  const T = { ...DEFAULTS, ...(opts.tuning ?? {}) };
  const stats = { speed: 20, edging: 20, trick: 20, ...(opts.stats ?? {}) };
  const gScale = opts.gravityScale ?? 1;
  // +10 speed stat scales lambda -> lambda/statF => v_ss scales by exactly statF
  // (PC-12); the drag SHAPE stays the pure two-term model at every stat.
  const statF = 1 + T.SPEED_STAT_GAIN * (stats.speed - 20) / 10;
  const edgeF = 1 + T.EDGE_STAT_GAIN * (stats.edging - 20) / 10;
  const aLatEff = T.A_LAT * (1 + 0.5 * (edgeF - 1));
  const trickF = 1 + T.TRICK_STAT_GAIN * (stats.trick - 20) / 10;
  const surf = SURFACES[env.surface] ?? SURFACES.snow;

  const sampleHeight = env.sampleHeight;
  const sampleNormal = env.sampleNormal ?? ((x, z) => {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  });

  const config = { ...T, gravityScale: gScale, statSpeedFactor: statF,
    statEdgeFactor: edgeF, statTrickFactor: trickF, aLatEffective: aLatEff,
    surface: env.surface ?? 'snow', surfaceMu: surf.mu, surfaceGrip: surf.grip,
    spinCap: T.SPIN_CAP, flipCap: T.FLIP_CAP };

  function init(pos, vel, heading) {
    const h = sampleHeight(pos[0], pos[2]);
    const onGround = pos[1] <= h + T.GROUND_EPS;
    return {
      pos: [pos[0], onGround ? h : pos[1], pos[2]],
      vel: [vel[0], vel[1], vel[2]],
      heading, onGround,
      charge: 0, airTime: 0, boostMeter: 1,
      spinDeg: 0, flipDeg: 0, landing: null,
      yawRate: 0, prewound: 0, _prewind: 0,
      carve: 0, slipDeg: 0,
      spinCapped: false, flipCapped: false, // "???" label: cap saturation
      _coyote: false,
    };
  }

  function meterTick(st, input, dt) {
    st.boostMeter = clamp(
      st.boostMeter + (input.boost ? -T.BOOST_DRAIN : T.BOOST_REGEN) * dt, 0, 1);
  }

  // Jump takeoff: charge consumed, prewind carried, no coyote window.
  function takeoffJump(st, prewound) {
    st.onGround = false; st.airTime = 0;
    st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
    st.spinCapped = false; st.flipCapped = false;
    st.prewound = prewound; st.charge = 0; st._prewind = 0; st.yawRate = 0;
    st.carve = 0; st.slipDeg = 0; st._coyote = false;
  }

  // Falling takeoff (ground fell away / constraint released): the crouch charge
  // and prewind survive and a coyote window is armed so a slightly-late
  // jumpRelease still pops (world-up only — see airStep).
  function takeoffFall(st) {
    st.onGround = false; st.airTime = 0;
    st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
    st.spinCapped = false; st.flipCapped = false;
    st.prewound = 0; st.yawRate = 0;
    st.carve = 0; st.slipDeg = 0; st._coyote = true;
  }

  function land(st, input) {
    const [x, , z] = st.pos;
    st.pos[1] = sampleHeight(x, z);
    const n = sampleNormal(x, z);
    const vn = dot(st.vel, n); // kill normal component (soft landing, no rebound)
    st.vel[0] -= vn * n[0]; st.vel[1] -= vn * n[1]; st.vel[2] -= vn * n[2];
    const hs = Math.hypot(st.vel[0], st.vel[2]);
    const velYaw = hs > 0.5 ? Math.atan2(st.vel[2], st.vel[0]) : st.heading;
    const dev = Math.abs(wrapPi(st.heading - velYaw)) / DEG;
    let label;
    if (input.grab) label = 'crash';                 // grab held at touchdown (JA-14)
    else if (dev >= T.CRASH_YAW) label = 'crash';
    else if (dev <= T.CLEAN_YAW) { label = 'clean'; st.heading = velYaw; } // auto-snap
    else label = 'sketchy';
    const keep = label === 'crash' ? T.CRASH_SPEED_KEEP :
                 label === 'sketchy' ? T.SKETCHY_SPEED_KEEP : 1;
    st.vel[0] *= keep; st.vel[1] *= keep; st.vel[2] *= keep;
    st.onGround = true; st.airTime = 0; st.landing = label;
    st.prewound = 0; st._coyote = false;
  }

  function airStep(st, input, dt) {
    // --- coyote pop (lip forgiveness): world-up ONLY, unconditionally.
    //     Horizontal velocity is NEVER altered by an airborne release (JA-25).
    if (input.jumpRelease && st._coyote && st.airTime <= T.COYOTE_TIME) {
      const J = T.J_MIN + clamp(st.charge, 0, 1) * (T.J_MAX - T.J_MIN);
      st.vel[1] += J;
      st.prewound = st._prewind; st._prewind = 0;
      st.spinDeg = 0; st.flipDeg = 0; st.airTime = 0; // this is the real takeoff
      st.spinCapped = false; st.flipCapped = false;
      st.charge = 0; st._coyote = false;
    } else if (st.airTime > T.COYOTE_TIME) { st._coyote = false; st.charge = 0; }
    st.airTime += dt;
    meterTick(st, input, dt); // meter economy runs in air too; thrust does not
    // --- rotation: pure animation state, ZERO trajectory coupling (PC-09/10, JA-22) ---
    const spin = clamp(input.spin ?? 0, -1, 1);
    const flip = clamp(input.flip ?? 0, -1, 1);
    if (Math.abs(spin) > 0.05) {
      const rate = (st.prewound !== 0 && Math.sign(spin) === st.prewound
        ? T.SPIN_PREWOUND * trickF : T.SPIN_STICK) * spin;
      let d = rate * dt;
      if (Math.abs(st.spinDeg + d) > T.SPIN_CAP) {
        d = Math.sign(d) * Math.max(0, T.SPIN_CAP - Math.abs(st.spinDeg));
        st.spinCapped = true; // display "???"
      }
      st.spinDeg += d; st.heading += d * DEG;
    } else if (st.spinDeg !== 0) { // auto-level toward nearest straight/fakie
      const target = Math.round(st.spinDeg / 180) * 180;
      const d = clamp(target - st.spinDeg, -T.AUTO_LEVEL * dt, T.AUTO_LEVEL * dt);
      st.spinDeg += d; st.heading += d * DEG;
    }
    if (Math.abs(flip) > 0.05) {
      let d = T.FLIP_RATE * trickF * flip * dt;
      if (Math.abs(st.flipDeg + d) > T.FLIP_CAP) {
        d = Math.sign(d) * Math.max(0, T.FLIP_CAP - Math.abs(st.flipDeg));
        st.flipCapped = true; // display "???"
      }
      st.flipDeg += d;
    } else if (st.flipDeg !== 0) {
      const target = Math.round(st.flipDeg / 360) * 360;
      st.flipDeg += clamp(target - st.flipDeg, -T.AUTO_LEVEL * dt, T.AUTO_LEVEL * dt);
    }
    // --- ballistic: horizontal untouched; steer/boost/crouch inert in air ---
    st.vel[1] -= T.G_AIR * gScale * dt;
    st.pos[0] += st.vel[0] * dt; st.pos[1] += st.vel[1] * dt; st.pos[2] += st.vel[2] * dt;
    if (st.pos[1] <= sampleHeight(st.pos[0], st.pos[2]) + 1e-9) land(st, input);
  }

  function groundStep(st, input, dt) {
    const steer = clamp(input.steer ?? 0, -1, 1);
    const jump = !!input.jumpRelease;
    // --- boost gate resolved before the drain so a full-meter tap works ---
    const boostActive = !!input.boost && st.boostMeter > 0;
    meterTick(st, input, dt);
    // --- crouch charge / prewind (skipped on the release frame: the pop
    //     consumes the charge accumulated so far) ---
    if (!jump) {
      if (input.crouch) {
        st.charge = clamp(st.charge + dt / T.T_CHARGE, 0, 1);
        const sp = input.spin ?? 0;
        if (Math.abs(sp) > 0.3) st._prewind = Math.sign(sp);
      } else { st.charge = 0; st._prewind = 0; }
    }

    // --- PREDICTIVE constraint release, BEFORE any redirect: probe the terrain
    //     one step ahead AND one step behind along the horizontal motion and
    //     test the second difference. A convex break beyond GROUND_EPS (lip,
    //     cliff edge) releases the constraint THIS frame with the velocity
    //     untouched — the cliff-contaminated normal stencil at a lip is never
    //     used to bend the exit velocity. Pure slope changes of the ENTRY
    //     VELOCITY (not yet surface-tangent) do not trigger it, because the
    //     check is a property of the terrain, not of the transient velocity:
    //     on any plane the second difference is identically zero.
    if (!jump) {
      const dx = st.vel[0] * dt, dz = st.vel[2] * dt;
      const hA = sampleHeight(st.pos[0] + dx, st.pos[2] + dz);
      const hB = sampleHeight(st.pos[0] - dx, st.pos[2] - dz);
      if ((st.pos[1] - hB) - (hA - st.pos[1]) > T.GROUND_EPS) {
        takeoffFall(st);
        airStep(st, input, dt);
        return;
      }
    }

    const n = sampleNormal(st.pos[0], st.pos[2]);
    const speed3 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);

    // --- steering: carve geometry + low-speed pivot, ceilinged by A_LAT ---
    const kSteer = (input.tuck ? T.TUCK_STEER : 1) * (input.crouch ? T.CROUCH_STEER : 1);
    const phi = Math.abs(steer) * T.PHI_MAX * DEG;
    const Rcarve = Math.max(T.R_SIDECUT * Math.cos(phi), 0.5);
    const omegaCarve = speed3 / Rcarve;
    const omegaPivot = T.OMEGA_PIVOT * DEG * Math.max(0, 1 - speed3 / T.PIVOT_FADE);
    const omega = steer * kSteer * Math.min(
      (omegaCarve + omegaPivot) * edgeF,
      aLatEff / Math.max(speed3, T.STEER_REF_SPEED));
    st.heading += omega * dt; st.yawRate = omega;

    // --- board frame on the surface ---
    const F = [Math.cos(st.heading), 0, Math.sin(st.heading)];
    let fx = F[0] - dot(F, n) * n[0], fy = -dot(F, n) * n[1], fz = F[2] - dot(F, n) * n[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const fwd = [fx, fy, fz];
    const lat = [n[1] * fz - n[2] * fy, n[2] * fx - n[0] * fz, n[0] * fy - n[1] * fx];

    // --- redirect velocity along the surface, magnitude-preserving (arcade:
    //     concave transitions keep speed — ramp efficiency 1.0, never above) ---
    const vn = dot(st.vel, n);
    let tx = st.vel[0] - vn * n[0], ty = st.vel[1] - vn * n[1], tz = st.vel[2] - vn * n[2];
    const tm = Math.hypot(tx, ty, tz);
    if (tm > 1e-9) { const k = speed3 / tm; tx *= k; ty *= k; tz *= k; }
    let sF = tx * fwd[0] + ty * fwd[1] + tz * fwd[2];
    let sR = tx * lat[0] + ty * lat[1] + tz * lat[2];

    // --- carve/skid classification by slip angle ---
    const slipDeg = Math.atan2(Math.abs(sR), Math.abs(sF)) / DEG;
    const carveW = Math.abs(steer) * clamp(1 - slipDeg / T.BETA_SKID, 0, 1);
    st.slipDeg = slipDeg; st.carve = carveW;

    // --- slope drive + the spec two-term resistance ---
    const g = T.G_GROUND * gScale;
    const gdn = -g * n[1];
    const gt = [-gdn * n[0], -g - gdn * n[1], -gdn * n[2]]; // tangential gravity
    const Gf = dot(gt, fwd);
    const cosT = Math.max(n[1], 0);
    const sAbs0 = Math.abs(sF);
    let sgn = sF >= 0 ? 1 : -1;
    const plow = surf.plow * T.POWDER_PLOW * Math.max(0, 1 - sAbs0 / T.POWDER_PLOW_FADE);
    // Constant term: mu*g*cos(theta) (+ brake, + powder plow). NEVER scaled by
    // tuck/turn (spec: those multiply lambda_long only).
    const F0 = surf.mu * T.MU_BASE * g * cosT
      + (input.brake ? T.BRAKE_DECEL * surf.mu : 0) + plow;
    // Linear term: lambda_long * k_tuckDrag * k_turnDrag(steer), stat-scaled.
    const b = T.LAMBDA_LONG * (input.tuck ? T.TUCK_DRAG : 1)
      * (1 + T.TURN_DRAG * Math.abs(steer)) / statF;
    let a = sgn * Gf - F0; // net constant drive along current motion direction

    // --- gravity-driven reversal: a stopped board slides back down iff slope
    //     drive beats the Coulomb static threshold in that direction ---
    if (sAbs0 < 1e-6 && a <= 0) {
      const aRev = -sgn * Gf - F0;
      if (aRev > 0) { sgn = -sgn; a = aRev; }
    }

    // --- longitudinal: boost = target relaxation, else the exact two-term flow ---
    let sAbs;
    if (boostActive) {
      const rt = a > 0 ? a / b : 0; // natural terminal on this slope
      const target = Math.max(T.V_BOOST, rt);
      sAbs = sAbs0 < target
        ? target + (sAbs0 - target) * Math.exp(-dt / T.TAU_BOOST)
        : flowSpeed(sAbs0, a, b, dt);
    } else {
      sAbs = flowSpeed(sAbs0, a, b, dt);
    }
    sAbs = Math.min(sAbs, T.V_CAP); // hard clamp (PC-06)
    sF = sgn * sAbs;

    // --- lateral: exponential kill toward gravity-slip equilibrium ---
    const Gr = dot(gt, lat);
    const lam = T.LAMBDA_LAT * surf.grip * (1 + T.CARVE_LOCK * carveW);
    const sEq = Gr / lam;
    sR = sEq + (sR - sEq) * Math.exp(-lam * dt);

    // --- reassemble, total cap, integrate ---
    let vx = sF * fwd[0] + sR * lat[0], vy = sF * fwd[1] + sR * lat[1], vz = sF * fwd[2] + sR * lat[2];
    const vm = Math.hypot(vx, vy, vz);
    if (vm > T.V_CAP) { const k = T.V_CAP / vm; vx *= k; vy *= k; vz *= k; }
    st.vel[0] = vx; st.vel[1] = vy; st.vel[2] = vz;
    st.pos[0] += vx * dt; st.pos[1] += vy * dt; st.pos[2] += vz * dt;

    // --- jump release LAST: the full ground tick above (slope decel + spec
    //     drag) already ran this frame, so the takeoff frame's horizontal
    //     delta matches the ramp trend the runner subtracts (JA-04). The pop
    //     is then a pure world-up add (n.y >= 0.7), blending toward the
    //     normal only on walls/quarterpipes. ---
    if (jump) {
      const J = T.J_MIN + clamp(st.charge, 0, 1) * (T.J_MAX - T.J_MIN);
      let dir;
      if (n[1] >= T.NORMAL_BLEND_DOT) dir = UP;
      else { const l = Math.hypot(n[0], 1 + n[1], n[2]); dir = [n[0] / l, (1 + n[1]) / l, n[2] / l]; }
      const pw = st._prewind;
      st.vel[0] += J * dir[0]; st.vel[1] += J * dir[1]; st.vel[2] += J * dir[2];
      takeoffJump(st, pw);
      return;
    }

    // --- ground follow / reactive takeoff backstop ---
    const hNew = sampleHeight(st.pos[0], st.pos[2]);
    if (st.pos[1] - hNew > T.GROUND_EPS) takeoffFall(st);
    else st.pos[1] = hNew;
  }

  function step(state, input = {}, dt) {
    if (state.onGround) groundStep(state, input, dt);
    else airStep(state, input, dt);
    return state;
  }

  return { config, init, step };
}
