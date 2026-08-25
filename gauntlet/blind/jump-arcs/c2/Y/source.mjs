// Candidate A — jump-arcs cycle 2: SPEC-LITERAL DRAG.
//
// Longitudinal ground model is EXACTLY the reference-bar two-term law:
//     a(v) = mu * g * cos(theta) * sign(v)  +  lambda_long * v
// integrated in closed form per step (linear ODE dv/dt = A - b*v has the exact
// solution v = A/b + (v0 - A/b) * exp(-b*dt), Coulomb-clamped at 0). There is
// NO quadratic term, NO soft speed wall, NO uphill relief, NO shaping term of
// any kind. The previous cycle's C_QUAD superlinear term (JA-23 fittedMu -0.008,
// residual 23%) and the overruled V_SOFT/B_WALL wall are both gone.
//
// TUNED CONSTANTS (all inside spec bands) and why they are pinned:
//   MU_BASE     0.032  (band 0.03-0.055; 0.002 above the JA-23 fit floor so the
//                       numerically fitted mu can never dip below 0.03)
//   LAMBDA_LONG 0.222  (band 0.18-0.32). The joint window is thin and real:
//     * PC-03 needs v_ss(15 deg) > 10 m/s  =>  lambda < (g sin15 - mu g cos15)/10
//                                              = 2.2358/10 = 0.2236
//     * PC-04 needs v_ss(28 deg) <= 21     =>  lambda >= 4.3283/21 = 0.2061
//     * PC-04 entry-convergence (5 vs 30 m/s, tail of 20 s) needs
//       25*mean(exp(-lambda t), t in [18,20]) / v_tail <= 0.02  =>  lambda >= ~0.221
//     0.222 sits inside all three: v_ss(15)=10.07, v_ss(28)=19.50, conv=1.92%.
//   TUCK_DRAG   0.735  (band 0.65-0.75): multiplies lambda only =>
//                       delta v_ss(28) = (A/lambda)(1/0.735 - 1) = 7.0 -> measured
//                       ~6.4 with tail bias (PC-08 band 5.5-7.5).
//   J_MIN 2.1 / J_MAX 5.0 (bands 2-2.5 / 4.5-5.5): tap J = 2.61 at the runner's
//                       0.15 s hold -> flat tap airtime 0.82 s / apex 0.50 m
//                       (JA-02), full 1.55 s / 1.88 m (JA-03).
//   G_AIR 6.5, T_CHARGE 0.85, V_CAP 33, V_BOOST 31: reference defend values.
//   Derived, not tuned: JA-24 uphill decel = g sin15 + mu g cos15 + lambda*v
//                       -> mean 4.52 m/s^2 over 1 s from 10 m/s (band 3.9-5.8).
//
// JA-04 (takeoff-frame h-speed discontinuity <= 1% after the runner subtracts
// the median ramp trend): the jump-release tick is a FULL ground tick (slope
// decel included, so the frame's delta-h matches the ramp trend), with the
// world-up pop applied at the instant the board leaves the surface, at the end
// of that tick. Horizontal velocity is untouched by the pop itself.
//
// JA-25 (coyote pop): jumpRelease while airborne is ignored entirely — charge
// is zero in the air and no impulse of any orientation is applied, so
// horizontal (and vertical) velocity are bit-identical with or without it.
//
// ============================ FLAGGED CONFLICT =============================
// JA-06 / JA-07 (TOLERANCE) are numerically infeasible under the JA-23/23b/23c
// HARD spec-drag gates with the harness kicker geometry. Proof:
//   * The runner starts the rider 27 m of FLAT ground before a 6 m-run,
//     30 deg kicker (slope length 6.93 m), entry exactly 18 m/s.
//   * JA-06 apex band 12-18 m needs v_y = sqrt(2*g_air*apex) >= sqrt(2*6.0*12)
//     = 12.0 m/s even at the g_air floor. With the world-up pop capped at
//     J_MAX <= 5.5, v_y = v_lip*sin30 + J => v_lip >= 13.0 m/s at the lip.
//   * Ramp, friction ignored (lower bound): v_base^2 >= v_lip^2 +
//     2*(g sin30)*6.93 = 169 + 68 => v_base >= 15.4 m/s at the ramp base.
//   * Flat approach at the MOST favorable in-band drag (mu 0.03, lambda 0.18):
//     a >= 0.294 + 0.18*15.4 = 3.07 m/s^2 while v >= 15.4; losing <= 2.6 m/s
//     over 27 m needs mean decel <= ~1.6 m/s^2. Contradiction: entry 18 arrives
//     at <= 13.2 m/s < 15.4. So no (mu, lambda, J, g_air) inside the spec bands
//     reaches JA-06's apex band; measured v_lip here is ~5.7 m/s.
//   * The slow rider instead falls into the 60 m harness trough:
//     airtime = solve(g_air/2*t^2 - v_y*t - 60 = 0) >= sqrt(120/g_air) >= 4.0 s
//     even as v_y -> 0 at g_air 7.5 — above JA-07's 3.8 s ceiling and, with
//     v_y ~ 7.9 (full charge), ~5.6 s — above JA-06's 4.8 s ceiling. Crossing
//     the 40 m gap instead needs v_x >= ~10.5 m/s => v_lip >= 12.1, same
//     contradiction. Expected measurements: JA-06 ~5.6 s, JA-07 ~5.2 s (the
//     unmodified src module measures 5.68/5.23 for the same reason).
// Resolution belongs to the gate owner (shorten the flat approach, raise the
// entry speed, or re-band JA-06/07); a drag wall is NOT used to hide it.
// ===========================================================================
//
// Everything else (steering geometry, carve/skid split, lateral kill, boost
// meter, landing rules, rotation caps) carries over from the accepted turning
// winner, with cycle-2 carried items applied:
//   * config.spinCap / config.flipCap exposed; cap saturation reported via
//     state.spinCapped / state.flipCapped / state.trickLabel = '???' (JA-08).
//   * Trick stat scales PREWOUND spin only (JA-09: 500 * 1.18 = 590 at trick
//     40); stick spin is 300 deg/s regardless of stat (JA-10); flip 330,
//     auto-level 220, both stat-independent.
//   * Scoring gates JA-15..21 stay deferred to the trick-system lane.
//
// Pure math: no imports, no globals, no Date/random. Deterministic.

const DEG = Math.PI / 180;
const UP = [0, 1, 0];

export const DEFAULTS = {
  // --- gravity ---
  G_GROUND: 9.81,        // m/s^2, ground tick (slope-projected)
  G_AIR: 6.5,            // m/s^2, airborne only (band 6.0-7.5)
  // --- ground longitudinal drag / friction: THE two-term spec model ---
  MU_BASE: 0.032,        // Coulomb friction coeff (x g cos theta); band 0.03-0.055
  LAMBDA_LONG: 0.222,    // 1/s, linear drag; band 0.18-0.32 (window proof in header)
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
  CROUCH_STEER: 0.45,    // steering multiplier while crouched (TN-12)
  TURN_DRAG: 0.15,       // +15% longitudinal drag at full lock (on lambda)
  // --- tuck ---
  TUCK_DRAG: 0.735,      // multiplier on LAMBDA_LONG while tucked (band 0.65-0.75)
  // --- brake ---
  BRAKE_DECEL: 2.2,      // m/s^2 added Coulomb-style decel (surface-scaled);
                         // measured brake decel = mu g + 2.2 + lambda*v ~ 5.5 (TN-08)
  // --- speed rails / boost ---
  V_CAP: 33,             // m/s hard clamp (119 km/h)
  V_BOOST: 31,           // m/s boost target speed
  TAU_BOOST: 0.7,        // s, boost relaxation time constant
  BOOST_DRAIN: 0.125,    // meter/s while boost held (full meter = 8 s burn)
  BOOST_REGEN: 0.10,     // meter/s while boost idle
  // --- jump ---
  T_CHARGE: 0.85,        // s to full crouch charge (JA-01 clamp at 0.9 in sweep)
  J_MIN: 2.1,            // m/s vertical impulse, tap (band 2-2.5)
  J_MAX: 5.0,            // m/s vertical impulse, full charge (band 4.5-5.5)
  NORMAL_BLEND_DOT: 0.7, // below this n.y, jump dir blends up+normal
  // --- air rotation (animation-only) ---
  SPIN_PREWOUND: 500,    // deg/s base with prewind; x trickF (590 at trick 40)
  SPIN_STICK: 300,       // deg/s stick-only — stat-INDEPENDENT (JA-10 regardless)
  FLIP_RATE: 330,        // deg/s, stat-independent (JA-11)
  AUTO_LEVEL: 220,       // deg/s leveling when rotation input released
  SPIN_CAP: 1800,        // deg recognized spin cap (beyond -> '???')
  FLIP_CAP: 1080,        // deg recognized flip cap (beyond -> '???')
  // --- landing ---
  CLEAN_YAW: 45,         // deg |heading-velYaw| for clean (auto-snap)
  CRASH_YAW: 90,         // deg and beyond = crash
  SKETCHY_SPEED_KEEP: 0.92,
  CRASH_SPEED_KEEP: 0.45,
  // --- stats ---
  SPEED_STAT_GAIN: 0.0175,  // fractional v_ss gain per +10 speed stat (PC-12)
  EDGE_STAT_GAIN: 0.10,     // fractional steering gain per +10 edging stat
  TRICK_STAT_GAIN: 0.09,    // fractional PREWOUND-rate gain per +10 trick stat
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

// Exact solution of dv/dt = A - b*v over dt, v >= 0 (two-term spec drag:
// A = drive - mu*g*cos - ..., b = lambda). Coulomb stop: if the net drive is
// non-positive the flow clamps at 0 instead of going negative.
function flowSpeed(v0, A, b, dt) {
  if (v0 <= 0 && A <= 0) return 0;
  const veq = A / b;
  const v = veq + (v0 - veq) * Math.exp(-b * dt);
  return A <= 0 ? Math.max(v, 0) : v;
}

export function createPhysics(env, opts = {}) {
  const T = { ...DEFAULTS, ...(opts.tuning ?? {}) };
  const stats = { speed: 20, edging: 20, trick: 20, ...(opts.stats ?? {}) };
  const gScale = opts.gravityScale ?? 1;
  // +10 speed stat scales the longitudinal steady state exactly:
  // b -> b/statF => v_ss = statF * A/lambda (PC-12).
  const statF = 1 + T.SPEED_STAT_GAIN * (stats.speed - 20) / 10;
  const edgeF = 1 + T.EDGE_STAT_GAIN * (stats.edging - 20) / 10;
  const aLatEff = T.A_LAT * (1 + 0.5 * (edgeF - 1));
  // Trick stat scales PREWOUND spin only (carried item).
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
      spinCapped: false, flipCapped: false, trickLabel: null, // '???' reporting
    };
  }

  function meterTick(st, input, dt) {
    st.boostMeter = clamp(
      st.boostMeter + (input.boost ? -T.BOOST_DRAIN : T.BOOST_REGEN) * dt, 0, 1);
  }

  function takeoff(st, prewound) {
    st.onGround = false; st.airTime = 0;
    st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
    st.prewound = prewound; st.charge = 0; st._prewind = 0; st.yawRate = 0;
    st.carve = 0; st.slipDeg = 0;
    st.spinCapped = false; st.flipCapped = false; st.trickLabel = null;
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
    st.onGround = true; st.airTime = 0; st.landing = label; st.prewound = 0;
  }

  function airStep(st, input, dt) {
    st.airTime += dt;
    meterTick(st, input, dt); // meter economy runs in air too; thrust does not
    // NOTE: input.jumpRelease is deliberately IGNORED here — a pop released
    // while airborne (coyote or otherwise) applies no impulse at all, so it can
    // never alter horizontal velocity (JA-25).
    // --- rotation: pure animation state, ZERO trajectory coupling (PC-09/10) ---
    const spin = clamp(input.spin ?? 0, -1, 1);
    const flip = clamp(input.flip ?? 0, -1, 1);
    if (Math.abs(spin) > 0.05) {
      const rate = (st.prewound !== 0 && Math.sign(spin) === st.prewound
        ? T.SPIN_PREWOUND * trickF : T.SPIN_STICK) * spin;
      let d = rate * dt;
      if (Math.abs(st.spinDeg + d) > T.SPIN_CAP) {
        d = Math.sign(d) * Math.max(0, T.SPIN_CAP - Math.abs(st.spinDeg));
        st.spinCapped = true; st.trickLabel = '???';   // beyond 1800 -> '???'
      }
      st.spinDeg += d; st.heading += d * DEG;
    } else if (st.spinDeg !== 0) { // auto-level toward nearest straight/fakie
      const target = Math.round(st.spinDeg / 180) * 180;
      const d = clamp(target - st.spinDeg, -T.AUTO_LEVEL * dt, T.AUTO_LEVEL * dt);
      st.spinDeg += d; st.heading += d * DEG;
    }
    if (Math.abs(flip) > 0.05) {
      let d = T.FLIP_RATE * flip * dt;
      if (Math.abs(st.flipDeg + d) > T.FLIP_CAP) {
        d = Math.sign(d) * Math.max(0, T.FLIP_CAP - Math.abs(st.flipDeg));
        st.flipCapped = true; st.trickLabel = '???';   // beyond 1080 -> '???'
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
    // --- jump release: capture charge/prewind NOW; the pop itself is applied
    //     at the END of this (still fully ground-physics) tick, so the takeoff
    //     frame's horizontal decel matches the ramp trend (JA-04) and the
    //     world-up impulse never touches horizontal velocity.
    const releasing = !!input.jumpRelease;
    let relJ = 0, relPrewind = 0, relN = null;
    if (releasing) {
      relJ = T.J_MIN + clamp(st.charge, 0, 1) * (T.J_MAX - T.J_MIN);
      relPrewind = st._prewind;
      relN = sampleNormal(st.pos[0], st.pos[2]); // surface being popped from
    }
    // --- boost meter (gate resolved before the drain so a full-meter tap works) ---
    const boostActive = !!input.boost && st.boostMeter > 0;
    meterTick(st, input, dt);
    // --- crouch charge / prewind ---
    if (input.crouch && !releasing) {
      st.charge = clamp(st.charge + dt / T.T_CHARGE, 0, 1);
      const sp = input.spin ?? 0;
      if (Math.abs(sp) > 0.3) st._prewind = Math.sign(sp);
    } else if (!releasing) { st.charge = 0; st._prewind = 0; }

    const n = sampleNormal(st.pos[0], st.pos[2]);
    const speed3 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);

    // --- steering: CARVE geometry + low-speed pivot, ceilinged by A_LAT ---
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

    // --- redirect velocity along the surface, magnitude-preserving (arcade) ---
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

    // --- slope drive + spec two-term resistance: a(v) = mu g cos + lambda v ---
    const g = T.G_GROUND * gScale;
    const gdn = -g * n[1];
    const gt = [-gdn * n[0], -g - gdn * n[1], -gdn * n[2]]; // tangential gravity
    const Gf = dot(gt, fwd), Gr = dot(gt, lat);
    const cosT = Math.max(n[1], 0);
    const sAbs0 = Math.abs(sF);
    let sgn = sF >= 0 ? 1 : -1;
    const plow = surf.plow * T.POWDER_PLOW * Math.max(0, 1 - sAbs0 / T.POWDER_PLOW_FADE);
    const F0 = surf.mu * T.MU_BASE * g * cosT                // Coulomb: mu g cos(theta)
      + (input.brake ? T.BRAKE_DECEL * surf.mu : 0) + plow;
    const kDrag = (input.tuck ? T.TUCK_DRAG : 1) * (1 + T.TURN_DRAG * Math.abs(steer));
    const b = T.LAMBDA_LONG * kDrag / statF;                 // linear term: lambda v
    let A = sgn * Gf - F0; // net constant drive along current motion direction

    // --- gravity-driven reversal: a stopped board whose forward drive is
    //     exhausted slides the other way iff slope drive beats Coulomb there
    //     (uphill stall; no energy is ever injected — JA-24 has no relief term).
    if (sAbs0 < 1e-6 && A <= 0) {
      const aRev = -sgn * Gf - F0;
      if (aRev > 0) { sgn = -sgn; A = aRev; }
    }

    // --- longitudinal: boost = target relaxation, else exact two-term flow ---
    let sAbs;
    if (boostActive) {
      const rt = A > 0 ? A / b : 0;                 // natural terminal on this slope
      const target = Math.max(T.V_BOOST, rt);
      sAbs = sAbs0 < target
        ? target + (sAbs0 - target) * Math.exp(-dt / T.TAU_BOOST)
        : flowSpeed(sAbs0, A, b, dt);
    } else {
      sAbs = flowSpeed(sAbs0, A, b, dt);
    }
    sAbs = Math.min(sAbs, T.V_CAP); // hard clamp (PC-06)
    sF = sgn * sAbs;

    // --- lateral: exponential kill toward gravity-slip equilibrium ---
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

    // --- apply the pop at the end of the release tick: world-up unless the
    //     launch surface was steep (n.up < 0.7 -> blend up+normal). Horizontal
    //     speed change at the takeoff frame is therefore only the same ground
    //     decel every prior ramp frame had (JA-04 trend-subtraction ~ 0).
    if (releasing) {
      let dir;
      if (relN[1] >= T.NORMAL_BLEND_DOT) dir = UP;
      else { const l = Math.hypot(relN[0], 1 + relN[1], relN[2]); dir = [relN[0] / l, (1 + relN[1]) / l, relN[2] / l]; }
      st.vel[0] += relJ * dir[0]; st.vel[1] += relJ * dir[1]; st.vel[2] += relJ * dir[2];
      takeoff(st, relPrewind);
    }
  }

  function step(state, input = {}, dt) {
    if (state.onGround) groundStep(state, input, dt);
    else airStep(state, input, dt);
    return state;
  }

  return { config, init, step };
}
