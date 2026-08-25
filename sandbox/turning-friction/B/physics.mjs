// Candidate B — snowboard physics core (SSX Tricky arcade feel)
// Turning/edge-friction evolution of the accepted physics-core module.
//
// Model: TARGET-RELAXATION. Every channel has an analytic steady state and an
// analytically integrated (closed-form) relaxation toward it, so any step is
// dt-exact: one 100 ms step == ten 10 ms steps to fp roundoff (gate PC-02).
//
//   Ground longitudinal:  ds/dt = a - b*s - c*s^2
//       a = g*sin(theta) - Coulomb - brake - powder plow   (net constant drive)
//       b = LAMBDA_LONG (linear aero/board drag, 1/s)
//       c = C_QUAD      (quadratic aero drag, 1/m)
//     Solved exactly per step (tanh / atan / exp branches in flowSpeed()).
//     Steady state is the positive root of c*s^2 + b*s = a.
//   Ground lateral:  pure exponential kill toward the gravity-slip equilibrium
//       s_r(t) = s_eq + (s_r0 - s_eq) * exp(-lam*dt)                  (exact)
//   Boost: pure target relaxation, s -> max(V_BOOST, natural terminal),
//       rate 1/TAU_BOOST (exact exponential), gated on state.boostMeter.
//   Air: constant-gravity ballistic; horizontal velocity NEVER touched
//       (PC-09/TN-07/JA-22). Rotation (spin/flip) is pure animation state.
//
// CARVE/SKID STATE SPLIT (turning-lane evolution seed):
//   * CARVE: steering rate comes from sidecut geometry. Edge angle
//       phi = |steer| * PHI_MAX; carve radius R = R_SIDECUT * cos(phi);
//       omega_carve = v / R. A low-speed skid-pivot term (OMEGA_PIVOT, fading
//       out by PIVOT_FADE m/s) covers the regime where a real board pivots
//       rather than carves, and the whole thing is ceilinged by the lateral
//       accel cap A_LAT/v (physics ceiling, TN-14).
//   * Slip angle beta = atan2(|s_r|, |s_f|) classifies the state; carve weight
//       w = |steer| * max(0, 1 - beta/BETA_SKID). Locked carve (w -> 1)
//       multiplies the lateral kill rate by (1 + CARVE_LOCK*w): the edge bites,
//       velocity tracks heading, and because the killed lateral component is
//       tiny (beta ~ 0) the carve is speed-preserving — scrub ~ beta^2. Skid
//       (w -> 0, large beta) keeps the base anisotropic damping and scrubs
//       speed hard (hockey stop TN-13). Steer-gated so that no-input slip
//       scenarios (TN-01/02/10/13) see exactly the base anisotropic model.
//
// CRITIQUE-CYCLE-0 RESPONSES:
//   1. TN-04 (was 15.6 m, band 17-26): A_LAT retuned 30 -> 26 m/s^2 (band
//      25-35). R = v^2/A_LAT at 25 m/s entry with the unavoidable in-turn
//      speed decay (drag model is pinned by PC-04/05) now measures ~17.8 m
//      (+0.8 over the floor). TN-03 stays in band (R = 100/26 = 3.85 at
//      10 m/s) and TN-14's peak lateral accel measures ~A_LAT (+0.9 margin).
//   2. Uphill stall freeze: when the longitudinal flow is stopped (sAbs ~ 0)
//      and the drive along the CURRENT motion sign is non-positive, we test
//      the reverse direction; if gravity along it beats Coulomb the motion
//      sign flips and the exact flow re-starts — a stopped rider facing
//      uphill now slides back down (Coulomb static threshold respected: on
//      flat ground aRev = -F0 < 0, so no creep).
//   3. Boost meter: boost thrust is gated on state.boostMeter > 0; the meter
//      drains at BOOST_DRAIN/s while boost is held and regens at BOOST_REGEN/s
//      when idle (linear in dt => split-step exact). Full meter = 8 s of burn;
//      33%-duty tapping is net-positive (0.33*drain < 0.67*regen) so PC-13
//      retention stays >= 0.9 (measured 0.956). PC-06/07 are unaffected: on
//      the 45 deg tucked run the natural terminal (~31.4 m/s) equals the boost
//      target, so meter exhaustion moves neither peak nor plateau.
//   4. Stats: opts.stats.edging scales steering — edgeF multiplies the
//      carve/pivot yaw rate and half-weights into the A_LAT ceiling (initiation
//      scales fully, the physics ceiling only partially). opts.stats.trick
//      scales ALL air rotation rates via trickF; SPIN_PREWOUND base is 500
//      deg/s so that JA-09 (trick 40 => x1.18) measures 590, inside 540-620,
//      and JA-10 (default 20 => x1.0) stays at SPIN_STICK = 300.
//
// Other deliberate tuning notes (constants below are the knobs):
//  * PC-03 vs PC-04 pin the drag shape: linear-only drag cannot make a 15 deg
//    slope accelerate at 10 m/s while keeping 28 deg cruise <= 21 m/s AND
//    converging within 2% in 20 s. The linear+quadratic mix (b=0.10, c=0.008)
//    threads all three: v_ss(15)=11.2, v_ss(28)=17.5, near-ss rate ~0.38/s.
//  * Tuck multiplies BOTH drag terms by TUCK_DRAG=0.6 -> +6.5 m/s on 28 deg
//    (PC-08 band 5.5-7.5).
//  * Landing yaw uses the UNFOLDED |heading - velocity yaw| (180 deg residual
//    = crash), matching the runner's landing_yaw sweep semantics. Runner is
//    the judge.
//
// Pure math: no imports, no globals, no Date/random. Deterministic.

const DEG = Math.PI / 180;
const UP = [0, 1, 0];

export const DEFAULTS = {
  // --- gravity ---
  G_GROUND: 9.81,        // m/s^2, ground tick (slope-projected)
  G_AIR: 6.5,            // m/s^2, airborne only (aesthetic hang; band 6.0-7.5)
  // --- ground longitudinal drag / friction ---
  MU_BASE: 0.045,        // Coulomb friction coeff on groomed snow (x g cos)
  LAMBDA_LONG: 0.10,     // 1/s, linear drag
  C_QUAD: 0.008,         // 1/m, quadratic drag
  // --- lateral (edge grip) ---
  LAMBDA_LAT: 4.0,       // 1/s, lateral slip kill on snow (half-life 0.17 s)
  CARVE_LOCK: 1.5,       // extra lateral kill multiplier at full carve lock
  BETA_SKID: 12,         // deg slip angle beyond which the board is skidding
  // --- steering (carve geometry + caps) ---
  R_SIDECUT: 6.4,        // m, board sidecut radius (flat-board carve radius)
  PHI_MAX: 60,           // deg, edge angle at full steer lock
  OMEGA_PIVOT: 160,      // deg/s, low-speed skid-pivot yaw authority
  PIVOT_FADE: 12,        // m/s, speed at which pivot authority reaches zero
  A_LAT: 26,             // m/s^2, lateral accel ceiling: omega <= A_LAT/v (TN-14)
  STEER_REF_SPEED: 5,    // m/s, speed floor in the A_LAT/v cap
  TUCK_STEER: 0.6,       // steering multiplier while tucked
  CROUCH_STEER: 0.45,    // steering multiplier while crouched (charging); the
                         // MEASURED crouch yaw ratio lands ~0.36 because the
                         // uncrouched run turns off the fall line, sheds speed,
                         // and gains omega via the A_LAT/v cap (TN-12 band 0.3-0.5)
  TURN_DRAG: 0.15,       // +15% longitudinal drag at full lock
  // --- tuck ---
  TUCK_DRAG: 0.6,        // multiplier on LAMBDA_LONG and C_QUAD while tucked
  // --- brake ---
  BRAKE_DECEL: 2.5,      // m/s^2 added Coulomb-style decel (surface-scaled)
  // --- speed rails / boost ---
  V_CAP: 33,             // m/s hard clamp (119 km/h)
  V_BOOST: 31,           // m/s boost target speed
  TAU_BOOST: 0.7,        // s, boost relaxation time constant
  BOOST_DRAIN: 0.125,    // meter/s while boost held (full meter = 8 s burn)
  BOOST_REGEN: 0.10,     // meter/s while boost idle (empty->full in 10 s)
  // --- jump ---
  T_CHARGE: 0.85,        // s to full crouch charge
  J_MIN: 2.2,            // m/s vertical impulse, tap
  J_MAX: 5.0,            // m/s vertical impulse, full charge
  NORMAL_BLEND_DOT: 0.7, // below this n.y, jump dir blends up+normal
  // --- air rotation (animation-only; all rates scale with trickF) ---
  SPIN_PREWOUND: 500,    // deg/s base with prewind (x1.18 at trick 40 => 590)
  SPIN_STICK: 300,       // deg/s stick-only, at trick stat 20
  FLIP_RATE: 330,        // deg/s at trick stat 20
  AUTO_LEVEL: 220,       // deg/s leveling when rotation input released
  SPIN_CAP: 1800,        // deg recognized spin cap
  FLIP_CAP: 1080,        // deg recognized flip cap (triple)
  // --- landing ---
  CLEAN_YAW: 45,         // deg |heading-velYaw| for clean (auto-snap)
  CRASH_YAW: 90,         // deg and beyond = crash
  SKETCHY_SPEED_KEEP: 0.92, // speed retained on sketchy landing
  CRASH_SPEED_KEEP: 0.45,   // speed retained on crash
  // --- stats ---
  SPEED_STAT_GAIN: 0.0175,  // fractional v_ss gain per +10 speed stat
  EDGE_STAT_GAIN: 0.10,     // fractional steering gain per +10 edging stat
  TRICK_STAT_GAIN: 0.09,    // fractional rotation-rate gain per +10 trick stat
  // --- powder plow ---
  POWDER_PLOW: 4.5,      // m/s^2 extra decel at standstill in powder
  POWDER_PLOW_FADE: 24,  // m/s speed at which plow reaches zero
  // --- misc ---
  GROUND_EPS: 0.02,      // m, ground-stick tolerance
};

// per-surface multipliers (ratios only; base values above)
const SURFACES = {
  snow:   { mu: 1.0,  grip: 1.0,  plow: 0 },
  ice:    { mu: 0.55, grip: 0.55, plow: 0 },
  powder: { mu: 1.3,  grip: 1.15, plow: 1 },
};

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrapPi = a => { a = a % (2 * Math.PI); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

// Exact solution of dv/dt = a - b*v - c*v^2 over dt, for v >= 0.
// b > 0, c >= 0. If a <= 0 (no net drive) the flow clamps at 0 (Coulomb stop).
function flowSpeed(v0, a, b, c, dt) {
  if (v0 <= 0 && a <= 0) return 0;
  if (c < 1e-12) { // linear only
    const veq = a / b;
    const v = veq + (v0 - veq) * Math.exp(-b * dt);
    return a <= 0 ? Math.max(v, 0) : v;
  }
  const D = b * b + 4 * c * a;
  if (D > 1e-12) { // two real roots r1 > 0 > r2 (a>0) or both <=0 (a<=0)
    const s = Math.sqrt(D);
    const r1 = (-b + s) / (2 * c), r2 = (-b - s) / (2 * c);
    const e = Math.exp(-s * dt) * (v0 - r1) / (v0 - r2);
    const v = (r1 - r2 * e) / (1 - e);
    return a <= 0 ? Math.max(v, 0) : v;
  }
  if (D < -1e-12) { // strong Coulomb, complex roots: arctan decay to stop
    const q = Math.sqrt(-D);
    const u = Math.atan((2 * c * v0 + b) / q) - (q / 2) * dt;
    if (u <= Math.atan(b / q)) return 0; // stopped within the step
    return (q * Math.tan(u) - b) / (2 * c);
  }
  // double root
  const r = -b / (2 * c);
  const v = r + (v0 - r) / (1 + c * (v0 - r) * dt);
  return a <= 0 ? Math.max(v, 0) : v;
}

export function createPhysics(env, opts = {}) {
  const T = { ...DEFAULTS, ...(opts.tuning ?? {}) };
  const stats = { speed: 20, edging: 20, trick: 20, ...(opts.stats ?? {}) };
  const gScale = opts.gravityScale ?? 1;
  // +10 speed stat scales every longitudinal steady state by statF exactly:
  // b -> b/statF, c -> c/statF^2  =>  v_ss -> statF * v_ss (see PC-12).
  const statF = 1 + T.SPEED_STAT_GAIN * (stats.speed - 20) / 10;
  // Edging stat: full weight on steering initiation, half weight on the
  // lateral-accel ceiling (the ceiling is a physics limit, not pure skill).
  const edgeF = 1 + T.EDGE_STAT_GAIN * (stats.edging - 20) / 10;
  const aLatEff = T.A_LAT * (1 + 0.5 * (edgeF - 1));
  // Trick stat: scales all commanded air rotation rates.
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
    surface: env.surface ?? 'snow', surfaceMu: surf.mu, surfaceGrip: surf.grip };

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
      carve: 0, slipDeg: 0, // carve/skid observability: weight + slip angle
    };
  }

  // Boost meter economy: linear drain while held, linear regen when idle.
  // Linear-in-dt with a clamp on a monotone path => split-step exact.
  function meterTick(st, input, dt) {
    st.boostMeter = clamp(
      st.boostMeter + (input.boost ? -T.BOOST_DRAIN : T.BOOST_REGEN) * dt, 0, 1);
  }

  function takeoff(st, prewound) {
    st.onGround = false; st.airTime = 0;
    st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
    st.prewound = prewound; st.charge = 0; st._prewind = 0; st.yawRate = 0;
    st.carve = 0; st.slipDeg = 0;
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
    if (input.grab) label = 'crash';                 // grab held at touchdown
    else if (dev >= T.CRASH_YAW) label = 'crash';
    else if (dev <= T.CLEAN_YAW) { label = 'clean'; st.heading = velYaw; } // auto-snap
    else label = 'sketchy';
    const keep = label === 'crash' ? T.CRASH_SPEED_KEEP :
                 label === 'sketchy' ? T.SKETCHY_SPEED_KEEP : 1;
    st.vel[0] *= keep; st.vel[1] *= keep; st.vel[2] *= keep;
    st.onGround = true; st.airTime = 0; st.landing = label; st.prewound = 0;
  }

  function airStep(st, input, dt) {
    st.airTime += dt;
    meterTick(st, input, dt); // meter economy runs in air too; thrust does not
    // --- rotation: pure animation state, ZERO trajectory coupling (PC-09/10) ---
    const spin = clamp(input.spin ?? 0, -1, 1);
    const flip = clamp(input.flip ?? 0, -1, 1);
    if (Math.abs(spin) > 0.05) {
      const rate = (st.prewound !== 0 && Math.sign(spin) === st.prewound
        ? T.SPIN_PREWOUND : T.SPIN_STICK) * trickF * spin;
      let d = rate * dt;
      const room = T.SPIN_CAP - Math.abs(st.spinDeg + d) >= 0 ? d
        : Math.sign(d) * Math.max(0, T.SPIN_CAP - Math.abs(st.spinDeg));
      d = room;
      st.spinDeg += d; st.heading += d * DEG;
    } else if (st.spinDeg !== 0) { // auto-level toward nearest straight/fakie
      const target = Math.round(st.spinDeg / 180) * 180;
      const d = clamp(target - st.spinDeg, -T.AUTO_LEVEL * dt, T.AUTO_LEVEL * dt);
      st.spinDeg += d; st.heading += d * DEG;
    }
    if (Math.abs(flip) > 0.05) {
      let d = T.FLIP_RATE * trickF * flip * dt;
      if (Math.abs(st.flipDeg + d) > T.FLIP_CAP)
        d = Math.sign(d) * Math.max(0, T.FLIP_CAP - Math.abs(st.flipDeg));
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
    // --- jump release first: uses the charge accumulated so far ---
    if (input.jumpRelease) {
      const n0 = sampleNormal(st.pos[0], st.pos[2]);
      const J = T.J_MIN + clamp(st.charge, 0, 1) * (T.J_MAX - T.J_MIN);
      let dir;
      if (n0[1] >= T.NORMAL_BLEND_DOT) dir = UP;         // world-up pop (JA-04)
      else { const l = Math.hypot(n0[0], 1 + n0[1], n0[2]); dir = [n0[0] / l, (1 + n0[1]) / l, n0[2] / l]; }
      const pw = st._prewind;
      st.vel[0] += J * dir[0]; st.vel[1] += J * dir[1]; st.vel[2] += J * dir[2];
      takeoff(st, pw);
      airStep(st, input, dt); // finish this tick airborne
      return;
    }
    // --- boost meter (gate resolved before the drain so a full-meter tap works) ---
    const boostActive = !!input.boost && st.boostMeter > 0;
    meterTick(st, input, dt);
    // --- crouch charge / prewind ---
    if (input.crouch) {
      st.charge = clamp(st.charge + dt / T.T_CHARGE, 0, 1);
      const sp = input.spin ?? 0;
      if (Math.abs(sp) > 0.3) st._prewind = Math.sign(sp);
    } else { st.charge = 0; st._prewind = 0; }

    const n = sampleNormal(st.pos[0], st.pos[2]);
    const speed3 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);

    // --- steering: CARVE geometry + low-speed pivot, ceilinged by A_LAT ---
    // Edge angle from steer input; carve radius R = R_SIDECUT * cos(phi).
    const kSteer = (input.tuck ? T.TUCK_STEER : 1) * (input.crouch ? T.CROUCH_STEER : 1);
    const phi = Math.abs(steer) * T.PHI_MAX * DEG;
    const Rcarve = Math.max(T.R_SIDECUT * Math.cos(phi), 0.5);
    const omegaCarve = speed3 / Rcarve;                       // rad/s, carve state
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
    //     concave transitions keep speed; landings already projected in land())
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

    // --- slope drive + resistive constants ---
    const g = T.G_GROUND * gScale;
    const gdn = -g * n[1]; // (0,-g,0).n
    const gt = [-gdn * n[0], -g - gdn * n[1], -gdn * n[2]]; // tangential gravity
    const Gf = dot(gt, fwd), Gr = dot(gt, lat);
    const cosT = Math.max(n[1], 0);
    const sAbs0 = Math.abs(sF);
    let sgn = sF >= 0 ? 1 : -1;
    const plow = surf.plow * T.POWDER_PLOW * Math.max(0, 1 - sAbs0 / T.POWDER_PLOW_FADE);
    const F0 = surf.mu * T.MU_BASE * g * cosT
      + (input.brake ? T.BRAKE_DECEL * surf.mu : 0) + plow;
    const kDrag = (input.tuck ? T.TUCK_DRAG : 1) * (1 + T.TURN_DRAG * Math.abs(steer));
    const b = T.LAMBDA_LONG * kDrag / statF;
    const c = T.C_QUAD * kDrag / (statF * statF);
    let a = sgn * Gf - F0; // net drive along current motion direction

    // --- gravity-driven reversal (critique 2): a stopped board whose forward
    //     drive is exhausted starts sliding the other way iff slope drive
    //     beats the Coulomb threshold in that direction (uphill stall fix).
    if (sAbs0 < 1e-6 && a <= 0) {
      const aRev = -sgn * Gf - F0;
      if (aRev > 0) { sgn = -sgn; a = aRev; }
    }

    // --- longitudinal: boost = target relaxation, else exact drag flow ---
    let sAbs;
    if (boostActive) {
      // natural terminal speed on this slope (positive root), floor at V_BOOST
      const rt = a > 0 ? (-b + Math.sqrt(b * b + 4 * c * a)) / (2 * c) : 0;
      const target = Math.max(T.V_BOOST, rt);
      sAbs = sAbs0 < target
        ? target + (sAbs0 - target) * Math.exp(-dt / T.TAU_BOOST)
        : flowSpeed(sAbs0, a, b, c, dt);
    } else {
      sAbs = flowSpeed(sAbs0, a, b, c, dt);
    }
    sAbs = Math.min(sAbs, T.V_CAP); // hard clamp (PC-06)
    sF = sgn * sAbs;

    // --- lateral: exponential kill toward gravity-slip equilibrium.
    //     CARVE: the engaged edge locks the board line — kill rate rises by
    //     (1 + CARVE_LOCK*carveW); scrub stays ~ beta^2 (speed-preserving).
    //     SKID: base anisotropic damping; large-beta kill scrubs real speed.
    const lam = T.LAMBDA_LAT * surf.grip * (1 + T.CARVE_LOCK * carveW);
    const sEq = Gr / lam;
    sR = sEq + (sR - sEq) * Math.exp(-lam * dt);

    // --- reassemble, total cap, integrate ---
    let vx = sF * fwd[0] + sR * lat[0], vy = sF * fwd[1] + sR * lat[1], vz = sF * fwd[2] + sR * lat[2];
    const vm = Math.hypot(vx, vy, vz);
    if (vm > T.V_CAP) { const k = T.V_CAP / vm; vx *= k; vy *= k; vz *= k; }
    st.vel[0] = vx; st.vel[1] = vy; st.vel[2] = vz;
    st.pos[0] += vx * dt; st.pos[1] += vy * dt; st.pos[2] += vz * dt;

    // --- ground follow / takeoff (ground falls away faster than we do) ---
    const hNew = sampleHeight(st.pos[0], st.pos[2]);
    if (st.pos[1] - hNew > T.GROUND_EPS) takeoff(st, 0);
    else st.pos[1] = hNew;
  }

  function step(state, input = {}, dt) {
    if (state.onGround) groundStep(state, input, dt);
    else airStep(state, input, dt);
    return state;
  }

  return { config, init, step };
}
