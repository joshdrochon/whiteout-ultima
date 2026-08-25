// Candidate A — turning/edge-friction lane (evolved from accepted physics-core module)
//
// Model: TARGET-RELAXATION + GRIP-CIRCLE. Every channel keeps an analytic steady
// state and a closed-form (dt-exact) relaxation toward it (gate PC-02 preserved).
//
// GRIP-CIRCLE EVOLUTION (this lane's seed): lateral grip and steering are unified
// through a single lateral-acceleration budget A_grip(v):
//
//     A_grip(v) = A_LAT * taper(v) * surf.grip * edgeF
//
//   * CARVE (on-budget): commanded yaw rate is capped at A_grip/v, so a locked
//     carve never demands more lateral accel than the edge can supply — speed is
//     preserved (only TURN_DRAG scrubs, +10-20%, TN-06).
//   * SKID (over-budget): any velocity component not aligned with the board is
//     over-budget by definition; it is scrubbed by the lateral slip channel whose
//     rate is DERIVED from the same budget: LAMBDA_LAT = A_LAT / SKID_SLIP_REF
//     (30 / 7.5 = 4 /s). A hockey-stop (90 deg slip at 15 m/s) starts at
//     lam*|s_r| = 60 m/s^2 of scrub — deep over-budget, speed dumps hard (TN-13).
//   * SURFACES scale the budget: ice grip 0.55x (slower slip kill AND slower
//     rotation authority, TN-10), powder 1.15x bite.
//   * taper(v) softens the budget above A_LAT_TAPER_V0: a real edge chatters out
//     at speed. This is what fixes TN-04 (critique cycle 0, item 1): with a flat
//     30 m/s^2 budget the measured early-arc radius at 25 m/s was 15.6 m because
//     v decays during the arc and omega = A/v re-tightens instantly; tapering the
//     budget to ~23 m/s^2 above 20 m/s runs the boost-speed carve wide (17-26 m)
//     while TN-03 (10 m/s, below the taper) keeps its 2.8-4.2 m radius and TN-14's
//     ceiling is still hit (peak a_lat = 30 in the 15-16 m/s region, band 25-35).
//
//   Ground longitudinal:  ds/dt = a - b*s - c*s^2, solved exactly (flowSpeed()).
//   Ground lateral:  exponential kill toward gravity-slip equilibrium (exact).
//   Boost: target relaxation to max(V_BOOST, natural terminal), exact exponential,
//     now GATED ON state.boostMeter (critique item 3): drains while lit, regens
//     while idle. Capacity ~8 s; 33%-duty tapping is meter-neutral, so PC-13's
//     >= 0.90 retention is untouched, and the PC-06/07 45-deg 30-s hold still
//     plateaus at the natural terminal (~31.4 m/s) after the meter runs dry.
//   Air: constant-gravity ballistic; horizontal velocity NEVER touched
//     (PC-09/TN-07/JA-22). Rotation is pure animation state.
//
// Critique cycle 0 — all four items addressed:
//   1. TN-04 retuned via the budget taper (above); TN-03 untouched (below taper).
//   2. Uphill stall freeze FIXED: from rest, the drive direction is re-derived
//      from gravity (sgn = sign(Gf)); if |Gf| exceeds the Coulomb hold the rider
//      slides back down fakie. Previously sgn defaulted to +1 and flowSpeed
//      clamped at 0 forever. (See "reversal from rest" in groundStep.)
//   3. Boost gated on boostMeter with drain/regen (above).
//   4. Stats wired: opts.stats.edging scales steering authority (edgeF on both
//      the yaw-rate cap and the grip budget); opts.stats.trick scales spin rates
//      (trickF on prewound/stick spin and flip). SPIN_PREWOUND base is 500 so a
//      maxed Trick stat (40) lands at 575 deg/s inside JA-09's 540-620 band, and
//      the default stat (20) keeps stick spin at 300 (JA-10) and flip 330 (JA-11).
//
// Deliberate tuning notes kept from the accepted module:
//  * PC-03 vs PC-04 pin the drag shape: linear+quadratic mix (b=0.10, c=0.008).
//  * Tuck multiplies BOTH drag terms by TUCK_DRAG=0.6 -> +6.4 m/s on 28 deg.
//  * Landing yaw uses the UNFOLDED |heading - velocity yaw|; runner is the judge.
//  * Turn drag stays TURN_DRAG * |steer| (flat), not over-budget-scaled: scaling
//    it with demand would ADD drag at 25 m/s and re-tighten TN-04 — the opposite
//    of what the lane needs — and TN-06's 15 m/s measurement pins the magnitude.
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
  // --- grip circle (single lateral-acceleration budget) ---
  A_LAT: 30,             // m/s^2, base lateral accel budget (band 25-35, TN-14)
  SKID_SLIP_REF: 7.5,    // m/s, slip speed at which skid scrub = full budget
                         //   => LAMBDA_LAT = A_LAT / SKID_SLIP_REF = 4 /s (TN-01/02)
  A_LAT_TAPER_V0: 15,    // m/s, budget starts tapering (edge chatter)
  A_LAT_TAPER_V1: 20,    // m/s, taper fully applied
  A_LAT_TAPER_MAX: 0.22, // fraction of budget shed at/above V1 (A -> 23.4)
  // --- steering ---
  OMEGA0: 180,           // deg/s, base yaw-rate cap (low speed)
  STEER_REF_SPEED: 5,    // m/s, speed floor in the A_grip/v cap
  TUCK_STEER: 0.6,       // steering multiplier while tucked
  CROUCH_STEER: 0.4,     // steering multiplier while crouched (charging)
  TURN_DRAG: 0.15,       // +15% longitudinal drag at full lock
  // --- tuck ---
  TUCK_DRAG: 0.6,        // multiplier on LAMBDA_LONG and C_QUAD while tucked
  // --- brake ---
  BRAKE_DECEL: 2.5,      // m/s^2 added Coulomb-style decel (surface-scaled)
  // --- speed rails ---
  V_CAP: 33,             // m/s hard clamp (119 km/h)
  V_BOOST: 31,           // m/s boost target speed
  TAU_BOOST: 0.7,        // s, boost relaxation time constant
  BOOST_DRAIN: 0.125,    // meter/s while boosting (full meter = 8 s burn)
  BOOST_REGEN: 0.0625,   // meter/s while not boosting (full refill in 16 s)
  // --- jump ---
  T_CHARGE: 0.85,        // s to full crouch charge
  J_MIN: 2.2,            // m/s vertical impulse, tap
  J_MAX: 5.0,            // m/s vertical impulse, full charge
  NORMAL_BLEND_DOT: 0.7, // below this n.y, jump dir blends up+normal
  // --- air rotation (animation-only; scaled by Trick stat, critique item 4) ---
  SPIN_PREWOUND: 500,    // deg/s base with prewind; x trickF (575 at Trick 40, JA-09)
  SPIN_STICK: 300,       // deg/s base stick-only (JA-10 band at default stat)
  FLIP_RATE: 330,        // deg/s base (JA-11 band at default stat)
  AUTO_LEVEL: 220,       // deg/s leveling when rotation input released (stat-free)
  SPIN_CAP: 1800,        // deg recognized spin cap
  FLIP_CAP: 1080,        // deg recognized flip cap (triple)
  // --- landing ---
  CLEAN_YAW: 45,         // deg |heading-velYaw| for clean (auto-snap)
  CRASH_YAW: 90,         // deg and beyond = crash
  SKETCHY_SPEED_KEEP: 0.92, // speed retained on sketchy landing
  CRASH_SPEED_KEEP: 0.45,   // speed retained on crash
  // --- stats ---
  SPEED_STAT_GAIN: 0.0175,  // fractional v_ss gain per +10 speed stat
  EDGE_STEER_GAIN: 0.15,    // fractional steering-authority gain at stat 40 vs 20
  TRICK_SPIN_GAIN: 0.15,    // fractional spin/flip-rate gain at stat 40 vs 20
  // --- powder plow ---
  POWDER_PLOW: 4.5,      // m/s^2 extra decel at standstill in powder
  POWDER_PLOW_FADE: 24,  // m/s speed at which plow reaches zero
  // --- misc ---
  GROUND_EPS: 0.02,      // m, ground-stick tolerance
};

// per-surface multipliers (ratios only; base values above).
// `grip` scales the WHOLE grip-circle budget: slip-kill rate and steering authority.
const SURFACES = {
  snow:   { mu: 1.0,  grip: 1.0,  plow: 0 },
  ice:    { mu: 0.55, grip: 0.55, plow: 0 },   // half grip: slower slip kill + slower rotation (TN-10)
  powder: { mu: 1.3,  grip: 1.15, plow: 1 },   // deep edge bite, plus low-speed plow drag (TN-11)
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
  // Edging stat: steering authority (yaw-rate cap AND grip budget). Trick stat:
  // commanded air rotation rates. Both are 1.0 at the default stat of 20.
  const edgeF = 1 + T.EDGE_STEER_GAIN * (stats.edging - 20) / 20;
  const trickF = 1 + T.TRICK_SPIN_GAIN * (stats.trick - 20) / 20;
  const surf = SURFACES[env.surface] ?? SURFACES.snow;

  // Grip-circle budget: lateral slip kill rate derives from the SAME constant
  // that caps steering, so surfaces (and tuning) move both together.
  const lambdaLat = (T.A_LAT / T.SKID_SLIP_REF) * surf.grip;

  // Speed-tapered lateral budget (edge chatter at speed): full A_LAT below V0,
  // shedding A_LAT_TAPER_MAX of it linearly by V1. Runs high-speed carves wide
  // (TN-04) without touching low-speed snap (TN-03/05) or the a_lat ceiling (TN-14).
  function lateralBudget(v) {
    const t = clamp((v - T.A_LAT_TAPER_V0) / (T.A_LAT_TAPER_V1 - T.A_LAT_TAPER_V0), 0, 1);
    return T.A_LAT * (1 - T.A_LAT_TAPER_MAX * t) * surf.grip * edgeF;
  }

  const sampleHeight = env.sampleHeight;
  const sampleNormal = env.sampleNormal ?? ((x, z) => {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  });

  const config = { ...T, gravityScale: gScale, statSpeedFactor: statF,
    statEdgeFactor: edgeF, statTrickFactor: trickF, lambdaLat,
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
    };
  }

  function takeoff(st, prewound) {
    st.onGround = false; st.airTime = 0;
    st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
    st.prewound = prewound; st.charge = 0; st._prewind = 0; st.yawRate = 0;
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
    // meter regen while the burner is off (boost is inert airborne)
    st.boostMeter = Math.min(1, st.boostMeter + T.BOOST_REGEN * dt);
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
    // --- crouch charge / prewind ---
    if (input.crouch) {
      st.charge = clamp(st.charge + dt / T.T_CHARGE, 0, 1);
      const sp = input.spin ?? 0;
      if (Math.abs(sp) > 0.3) st._prewind = Math.sign(sp);
    } else { st.charge = 0; st._prewind = 0; }

    const n = sampleNormal(st.pos[0], st.pos[2]);
    const speed3 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);

    // --- steering: grip-circle cap. Yaw-rate limited low speed (OMEGA0), budget
    //     limited high speed (A_grip(v)/v). Edging stat scales both (edgeF).
    const kSteer = (input.tuck ? T.TUCK_STEER : 1) * (input.crouch ? T.CROUCH_STEER : 1);
    const omega = steer * kSteer *
      Math.min(T.OMEGA0 * DEG * edgeF, lateralBudget(speed3) / Math.max(speed3, T.STEER_REF_SPEED));
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

    // --- slope drive + resistive constants ---
    const g = T.G_GROUND * gScale;
    const gdn = -g * n[1]; // (0,-g,0).n
    const gt = [-gdn * n[0], -g - gdn * n[1], -gdn * n[2]]; // tangential gravity
    const Gf = dot(gt, fwd), Gr = dot(gt, lat);
    const cosT = Math.max(n[1], 0);
    let sAbs0 = Math.abs(sF), sgn = sF >= 0 ? 1 : -1;
    // Reversal from rest (critique item 2): when stopped, the drive direction is
    // whichever way gravity points along the board, not a frozen +forward. If the
    // slope component beats the Coulomb hold, the rider slides back (fakie).
    if (sAbs0 < 1e-9) { sgn = Gf >= 0 ? 1 : -1; sAbs0 = 0; }
    const plow = surf.plow * T.POWDER_PLOW * Math.max(0, 1 - sAbs0 / T.POWDER_PLOW_FADE);
    const F0 = surf.mu * T.MU_BASE * g * cosT
      + (input.brake ? T.BRAKE_DECEL * surf.mu : 0) + plow;
    const kDrag = (input.tuck ? T.TUCK_DRAG : 1) * (1 + T.TURN_DRAG * Math.abs(steer));
    const b = T.LAMBDA_LONG * kDrag / statF;
    const c = T.C_QUAD * kDrag / (statF * statF);
    const a = sgn * Gf - F0; // net drive along current (or gravity-chosen) direction

    // --- longitudinal: boost = target relaxation, else exact drag flow.
    //     Boost is gated on the meter (critique item 3): no meter, no thrust.
    const boostActive = !!input.boost && st.boostMeter > 1e-9;
    let sAbs;
    if (boostActive) {
      // natural terminal speed on this slope (positive root), floor at V_BOOST
      const rt = a > 0 ? (-b + Math.sqrt(b * b + 4 * c * a)) / (2 * c) : 0;
      const target = Math.max(T.V_BOOST, rt);
      sAbs = sAbs0 < target
        ? target + (sAbs0 - target) * Math.exp(-dt / T.TAU_BOOST)
        : flowSpeed(sAbs0, a, b, c, dt);
      st.boostMeter = Math.max(0, st.boostMeter - T.BOOST_DRAIN * dt);
    } else {
      sAbs = flowSpeed(sAbs0, a, b, c, dt);
      // regen only while the button is RELEASED — holding boost on an empty
      // meter must not oscillate into pulsed half-thrust
      if (!input.boost) st.boostMeter = Math.min(1, st.boostMeter + T.BOOST_REGEN * dt);
    }
    sAbs = Math.min(sAbs, T.V_CAP); // hard clamp (PC-06)
    sF = sgn * sAbs;

    // --- lateral (skid channel): exponential kill toward gravity-slip
    //     equilibrium, rate = grip budget / reference slip (see header).
    const lam = lambdaLat;
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
