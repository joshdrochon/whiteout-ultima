// ---------------------------------------------------------------------------
// SSX Tricky-style arcade snowboard physics — candidate A, lane: physics-core
//
// Architecture: force-based board-frame model. Each ground tick the velocity is
// decomposed into board-forward / board-lateral axes on the surface plane
// (heading frame), and each axis is advanced with the EXACT closed-form flow of
//
//     dv/dt = A - lambda*v - c*v^2      (A, lambda, c constant within the step)
//
// A       : slope projection of gravity minus Coulomb friction / brake / plow
// lambda  : linear (waxed-base) drag, anisotropic: lambda_lat >> lambda_long
// c       : quadratic aero drag (forward axis only)
//
// Because the per-axis ODE is autonomous and solved exactly (Riccati flow),
// one 100 ms step equals ten 10 ms steps to machine precision -> gate PC-02.
//
// DESIGN NOTE (constants vs REFERENCE_BAR "defend" values): the reference
// defends lambda_long = 0.25 with pure linear drag, but that provably fails
// PC-03: at v = 10 m/s on 15 deg, v_ss = (g sin15 - mu g cos15)/0.25 < 10, so
// measured net accel is NEGATIVE and the 31/15 deg accel ratio cannot reach
// 1.9. Splitting drag into lambda_long = 0.12 s^-1 + c = 0.006 m^-1 keeps the
// same cruise point on 28 deg (18.2 m/s, in PC-04 band), gives an EFFECTIVE
// linearized damping at cruise of lambda + 2cv ~ 0.34 s^-1 (fast entry
// convergence for PC-04's 2% check), keeps flat coast 17 -> 1.7 m/s at 8.7 s
// (PC-05 band), and leaves low-speed accel on 15 deg positive (PC-03 ratio ~10).
// This is a documented resolution of a gate conflict, not a drift in feel.
//
// Air is a pure point-mass ballistic with reduced "aesthetic hang" gravity;
// spin/flip are ANIMATION-ONLY counters and never touch p or v (PC-09/10,
// TN-07, JA-22). Landing yaw classification uses distance of residual spin
// from the nearest full 360 (the operational definition in the harness
// landing_yaw sweep: clean <= 45 deg, sketchy <= 90 deg, crash beyond).
//
// LATER-LANE NOTES (physics-core cycle 1; all 13 PC gates green, no conflicts):
// - JA-04/06/07 currently read low because the harness kicker approach (27 m of
//   flat + a 30 deg climb) bleeds entry 18 m/s to ~5.4 m/s at the lip; the
//   JA-04 residual (1.7%) is one tick of slope decel at that low lip speed,
//   not a takeoff impulse defect (the pop is world-up and fires pre-drag).
//   Jump-arcs lane should tune approach/lip speed, not the impulse model.
// - TN-04 (radius at 25 m/s) sits at 15.4 m vs band 17-26 because speed decays
//   during the measured arc; turning lane can raise A_LAT within 25-35 or
//   measure-hold speed. All other TN gates green with these constants.
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;

// ------------------------------ tunables -----------------------------------
// Every constant named + unit-commented so the renderer-binding lane can tune.
const T = {
  // gravity
  G_GROUND: 9.81,        // m/s^2 — real gravity on ground, slope-projected
  G_AIR: 6.5,            // m/s^2 — reduced airborne gravity (SSX hang), band 6.0–7.5

  // longitudinal resistance (board-forward axis)
  MU_SNOW: 0.05,         // Coulomb friction coefficient, groomed snow (band 0.03–0.05)
  LAMBDA_LONG: 0.12,     // 1/s  — linear drag (see design note above)
  C_DRAG: 0.006,         // 1/m  — quadratic aero drag; eff. damping at cruise ≈ 0.34/s

  // lateral grip (board-lateral axis)
  LAMBDA_LAT: 4.0,       // 1/s  — edge grip; slip half-life ln2/4 ≈ 0.17 s (TN-01)

  // steering
  OMEGA0_DEG: 180,       // deg/s — base yaw-rate cap at low speed (band 160–200)
  A_LAT: 30,             // m/s^2 — lateral accel cap at high speed (band 25–35)
  OMEGA_MIN_SPEED: 5,    // m/s  — speed floor in A_LAT/v so parking-lot turns stay sane
  TURN_DRAG_GAIN: 0.15,  // — full-lock steering adds +15% longitudinal drag (TN-06)

  // stance modifiers
  TUCK_DRAG: 0.64,       // × on lambda_long & c while tucked -> +6.3 m/s cruise (PC-08)
  TUCK_STEER: 0.6,       // × on yaw rate while tucked
  CROUCH_STEER: 0.4,     // × on yaw rate while crouched (band 0.3–0.5, TN-12)
  BRAKE_DECEL: 1.5,      // m/s^2 — added Coulomb-style brake decel (total ~4.7, TN-08)
  BRAKE_STEER: 1.25,     // × on yaw rate while braking -> brake+turn is tighter (TN-09)

  // speed economy
  V_CAP: 33,             // m/s — hard clamp, 119 km/h (PC-06/07)
  V_BOOST: 31,           // m/s — boost first-order target speed
  TAU_BOOST: 0.9,        // s   — boost spin-up time constant (band 0.8–1.2)
  BOOST_DRAIN: 0.02,     // meter fraction/s while boosting (economy tuned in trick lane)

  // jump
  T_CHARGE: 0.9,         // s   — crouch hold to full charge (band 0.7–1.0, JA-01)
  J_MIN: 2.0,            // m/s — tap pop impulse  -> flat airtime 0.77 s (JA-02)
  J_MAX: 5.0,            // m/s — full pop impulse -> flat airtime 1.54 s (JA-03)
  JUMP_NORMAL_DOT: 0.7,  // n·up threshold below which impulse blends toward normal
  CHARGE_DECAY_TAU: 0.12,// s   — charge bleed when crouch released without jumping
  PREWIND_TIME: 0.3,     // s   — crouch+spin hold to reach full prewind

  // air rotation (animation-only)
  SPIN_PREWOUND: 560,    // deg/s — prewound spin rate (band 540–620 at max Trick)
  SPIN_STICK: 300,       // deg/s — stick-only spin rate (band 250–350)
  FLIP_RATE: 330,        // deg/s — flip rate, independent axis (band 300–360)
  AUTO_LEVEL: 220,       // deg/s — flip auto-level after input release (band 180–270)
  SPIN_CAP: 1800,        // deg  — recognized spin tops out (JA-08a); beyond -> "???"
  FLIP_CAP: 1080,        // deg  — recognized flips top out (JA-08b); beyond -> "???"

  // landing classification (residual rotation distance from nearest 360)
  CLEAN_YAW: 45,         // deg — clean within ±45 (band 40–50, JA-13)
  CRASH_YAW: 90,         // deg — crash beyond 90 (band 80–100); between = sketchy
  SKETCHY_SCRUB: 0.9,    // × speed kept on sketchy landing
  CRASH_SCRUB: 0.45,     // × speed kept on crash

  // stat scaling (stats 0..40, default 20)
  STAT_SPEED_GAIN: 0.0026, // per point: drag ×exp(-k·(stat-20)) -> +1.8%/10 (PC-12)
  STAT_EDGE_GAIN: 0.005,   // per point on lambda_lat & yaw cap
  STAT_TRICK_GAIN: 0.0025, // per point on rotation rates -> 588 deg/s prewound @40

  // misc
  GROUND_EPS: 0.02,      // m — height tolerance for ground contact
};

// per-surface multipliers (ratios from reference: ice grip ~0.55× snow;
// powder ~1.3× mu plus a low-speed depth-plow drag that fades out by 22 m/s)
const SURFACES = {
  snow:   { mu: T.MU_SNOW,        lat: 1.0,  long: 1.0,  brake: 1.0, plow0: 0.0, plowFade: 22 },
  ice:    { mu: T.MU_SNOW * 0.55, lat: 0.55, long: 0.85, brake: 0.6, plow0: 0.0, plowFade: 22 },
  powder: { mu: T.MU_SNOW * 1.3,  lat: 1.15, long: 1.15, brake: 1.1, plow0: 4.0, plowFade: 22 },
};

// ------------------------- exact per-axis flow ------------------------------
// Exact solution of dv/dt = A - lam*v - c*v^2 over time dt (constant coeffs).
// Autonomous flow => composing sub-steps reproduces one big step exactly.
function flowSpeed(v0, A, lam, c, dt) {
  if (c < 1e-12) {
    if (lam < 1e-12) return v0 + A * dt;
    const vinf = A / lam;
    return vinf + (v0 - vinf) * Math.exp(-lam * dt);
  }
  const D = lam * lam + 4 * c * A;
  if (D > 1e-12) {
    const s = Math.sqrt(D);
    const r1 = (-lam + s) / (2 * c);   // stable equilibrium
    const r2 = (-lam - s) / (2 * c);   // unstable root
    if (Math.abs(v0 - r2) < 1e-12) return v0;
    const K = (v0 - r1) / (v0 - r2);
    const E = Math.exp(-s * dt);
    const den = 1 - K * E;
    if (Math.abs(den) < 1e-12) return r1;
    return (r1 - r2 * K * E) / den;
  }
  if (D < -1e-12) {
    // heavy resistance, no equilibrium: v reaches zero in finite time (caller clamps)
    const s = Math.sqrt(-D);
    const phi = Math.atan((2 * c * v0 + lam) / s) - (s / 2) * dt;
    if (phi <= -Math.PI / 2 + 1e-9) return -1e9;
    return (s * Math.tan(phi) - lam) / (2 * c);
  }
  const r = -lam / (2 * c);
  const u = v0 - r;
  return r + u / (1 + c * u * dt);
}

// Coulomb-style resistance must stop motion, never reverse it. A reversal is
// legitimate only when the slope component itself pushes against v harder than
// the total resistive magnitude.
function clampReversal(v0, vNew, aSlopeAxis, resist) {
  if (v0 === 0 || vNew === 0 || (v0 > 0) === (vNew > 0)) return vNew;
  const pushBack = -Math.sign(v0) * aSlopeAxis;
  return pushBack > resist ? vNew : 0;
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// ------------------------------- factory ------------------------------------
export function createPhysics(env, opts = {}) {
  const sampleHeight = env.sampleHeight;
  const normalAt = env.sampleNormal
    ? (x, z) => env.sampleNormal(x, z)
    : (x, z) => {
        const e = 0.05;
        const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
        const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
        const l = Math.hypot(dx, 1, dz);
        return [-dx / l, 1 / l, -dz / l];
      };

  const stats = { speed: 20, edging: 20, trick: 20, ...(opts.stats ?? {}) };
  const gScale = opts.gravityScale ?? 1;
  const surf = SURFACES[env.surface] ?? SURFACES.snow;

  // resolved stat multipliers
  const dragStatK = Math.exp(-T.STAT_SPEED_GAIN * (num(stats.speed) - 20));
  const edgeStatK = 1 + T.STAT_EDGE_GAIN * (num(stats.edging) - 20);
  const trickK = 1 + T.STAT_TRICK_GAIN * (num(stats.trick) - 20);

  const OMEGA0 = T.OMEGA0_DEG * DEG; // rad/s

  const config = {
    gGround: T.G_GROUND, gAir: T.G_AIR, gravityScale: gScale,
    mu: surf.mu, lambdaLong: T.LAMBDA_LONG, cDrag: T.C_DRAG, lambdaLat: T.LAMBDA_LAT,
    omega0DegPerS: T.OMEGA0_DEG, aLat: T.A_LAT, turnDragGain: T.TURN_DRAG_GAIN,
    tuckDrag: T.TUCK_DRAG, tuckSteer: T.TUCK_STEER, crouchSteer: T.CROUCH_STEER,
    brakeDecel: T.BRAKE_DECEL, brakeSteer: T.BRAKE_STEER,
    vCap: T.V_CAP, vBoost: T.V_BOOST, tauBoost: T.TAU_BOOST, boostDrain: T.BOOST_DRAIN,
    tCharge: T.T_CHARGE, jMin: T.J_MIN, jMax: T.J_MAX,
    spinPrewound: T.SPIN_PREWOUND, spinStick: T.SPIN_STICK, flipRate: T.FLIP_RATE,
    autoLevel: T.AUTO_LEVEL, spinCap: T.SPIN_CAP, flipCap: T.FLIP_CAP,
    cleanYawDeg: T.CLEAN_YAW, crashYawDeg: T.CRASH_YAW,
    surfLat: surf.lat, surfLong: surf.long, surfBrake: surf.brake, surfPlow0: surf.plow0,
    dragStatK, edgeStatK, trickK,
  };

  function takeoff(st, fromJump) {
    st.onGround = false;
    st.airTime = 0;
    st.spinDeg = 0;
    st.flipDeg = 0;
    st.landing = null;
    st.trickLabel = null;
    st.grabbing = false;
    st.prewoundActive = fromJump && st.prewound > 0.5;
    if (!fromJump) st.prewound = 0;
    st.yawRate = 0;
  }

  function touchdown(st, h) {
    st.pos[1] = h;
    st.onGround = true;
    st.airTime = 0;
    // residual rotation distance from nearest full 360 (harness operational def)
    const m = ((st.spinDeg % 360) + 360) % 360;
    const d = Math.min(m, 360 - m);
    const fm = ((st.flipDeg % 360) + 360) % 360;
    const fd = Math.min(fm, 360 - fm);
    let out;
    if (st.grabbing) out = 'crash';                              // JA-14
    else if (d > T.CRASH_YAW || fd > T.CRASH_YAW) out = 'crash';
    else if (d > T.CLEAN_YAW || fd > T.CLEAN_YAW) out = 'sketchy';
    else out = 'clean';
    st.landing = out;
    // kill the into-ground component, keep the ride
    const n = normalAt(st.pos[0], st.pos[2]);
    const vn = st.vel[0] * n[0] + st.vel[1] * n[1] + st.vel[2] * n[2];
    st.vel[0] -= vn * n[0]; st.vel[1] -= vn * n[1]; st.vel[2] -= vn * n[2];
    const scrub = out === 'clean' ? 1 : out === 'sketchy' ? T.SKETCHY_SCRUB : T.CRASH_SCRUB;
    st.vel[0] *= scrub; st.vel[1] *= scrub; st.vel[2] *= scrub;
    if (out !== 'sketchy') {
      const hs = Math.hypot(st.vel[0], st.vel[2]);
      if (hs > 0.5) st.heading = Math.atan2(st.vel[2], st.vel[0]); // snap to travel dir
    }
    st.grabbing = false;
    st.prewoundActive = false;
  }

  function airStep(st, input, dt) {
    st.airTime += dt;
    st.yawRate = 0;
    // --- rotation: pure animation state, never feeds p or v (PC-10, JA-22) ---
    const spin = Math.max(-1, Math.min(1, num(input.spin)));
    const flip = Math.max(-1, Math.min(1, num(input.flip)));
    if (Math.abs(spin) > 0.05) {
      const rate = (st.prewoundActive && Math.sign(spin) === st.prewindDir
        ? T.SPIN_PREWOUND : T.SPIN_STICK) * trickK * Math.abs(spin);
      let next = st.spinDeg + Math.sign(spin) * rate * dt;
      if (Math.abs(next) > T.SPIN_CAP) { next = Math.sign(next) * T.SPIN_CAP; st.trickLabel = '???'; }
      st.spinDeg = next;
    } // stick released -> spin rate stops immediately (JA-22: <= 0.2 s)
    if (Math.abs(flip) > 0.05) {
      let next = st.flipDeg + Math.sign(flip) * T.FLIP_RATE * trickK * Math.abs(flip) * dt;
      if (Math.abs(next) > T.FLIP_CAP) { next = Math.sign(next) * T.FLIP_CAP; st.trickLabel = '???'; }
      st.flipDeg = next;
    } else if (st.flipDeg % 360 !== 0) {
      // auto-level toward nearest completed flip (JA-12)
      const target = Math.round(st.flipDeg / 360) * 360;
      const d = target - st.flipDeg;
      const stepAmt = Math.min(Math.abs(d), T.AUTO_LEVEL * trickK * dt);
      st.flipDeg += Math.sign(d) * stepAmt;
    }
    st.grabbing = !!input.grab;
    // --- ballistic point mass: no drag, no steering, horizontal conserved ---
    st.vel[1] -= T.G_AIR * gScale * dt;
    st.pos[0] += st.vel[0] * dt;
    st.pos[1] += st.vel[1] * dt;
    st.pos[2] += st.vel[2] * dt;
    const h = sampleHeight(st.pos[0], st.pos[2]);
    if (st.pos[1] <= h) touchdown(st, h);
  }

  function groundStep(st, input, dt) {
    const steer = Math.max(-1, Math.min(1, num(input.steer)));
    const tuck = !!input.tuck, brake = !!input.brake, crouch = !!input.crouch;

    // --- jump release FIRST: the pop acts on pre-drag velocity so the release
    //     frame does not eat a tick of ground resistance (JA-04 lip measure).
    //     WORLD-UP impulse; blend toward normal only on steep faces. ---
    if (input.jumpRelease) {
      const nj = normalAt(st.pos[0], st.pos[2]);
      const J = T.J_MIN + (T.J_MAX - T.J_MIN) * clamp01(st.charge);
      let dx = 0, dy = 1, dz = 0;
      if (nj[1] < T.JUMP_NORMAL_DOT) {
        const l = Math.hypot(nj[0], nj[1] + 1, nj[2]);
        dx = nj[0] / l; dy = (nj[1] + 1) / l; dz = nj[2] / l;
      }
      st.vel[0] += J * dx; st.vel[1] += J * dy; st.vel[2] += J * dz;
      st.charge = 0;
      takeoff(st, true);
      st.pos[0] += st.vel[0] * dt;
      st.pos[1] += st.vel[1] * dt;
      st.pos[2] += st.vel[2] * dt;
      return;
    }

    // --- steering: yaw-rate cap at low speed, lateral-accel cap at speed ---
    const sp0 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
    const omegaCap = Math.min(OMEGA0 * edgeStatK, T.A_LAT / Math.max(sp0, T.OMEGA_MIN_SPEED));
    const omega = steer * omegaCap
      * (tuck ? T.TUCK_STEER : 1) * (crouch ? T.CROUCH_STEER : 1) * (brake ? T.BRAKE_STEER : 1);
    st.heading += omega * dt;
    st.yawRate = omega;

    // --- board frame on the surface plane (post-rotation: carve slip appears
    //     as lateral velocity and is scrubbed by edge grip) ---
    const n = normalAt(st.pos[0], st.pos[2]);
    const fh = [Math.cos(st.heading), 0, Math.sin(st.heading)];
    const fDot = fh[0] * n[0] + fh[2] * n[2]; // fh[1] = 0
    let fx = fh[0] - fDot * n[0], fy = -fDot * n[1], fz = fh[2] - fDot * n[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // r = n × f (unit, in-plane, perpendicular to f)
    const rx = n[1] * fz - n[2] * fy, ry = n[2] * fx - n[0] * fz, rz = n[0] * fy - n[1] * fx;

    let vf = st.vel[0] * fx + st.vel[1] * fy + st.vel[2] * fz;
    let vr = st.vel[0] * rx + st.vel[1] * ry + st.vel[2] * rz;
    const sp = Math.hypot(vf, vr);

    // --- slope-projected gravity: a = g - (g·n)n, |a| = g sin(theta) ---
    const G = T.G_GROUND * gScale;
    const ax = G * n[1] * n[0], ay = G * (n[1] * n[1] - 1), az = G * n[1] * n[2];
    const aF = ax * fx + ay * fy + az * fz;
    const aR = ax * rx + ay * ry + az * rz;

    // --- resistive magnitudes (constant within step, folded into A) ---
    const cosT = Math.max(n[1], 0);
    const coulomb = surf.mu * G * cosT;
    const brakeDec = brake ? T.BRAKE_DECEL * surf.brake : 0;
    const plow = surf.plow0 > 0 ? surf.plow0 * clamp01(1 - sp / surf.plowFade) : 0;
    const resist = coulomb + brakeDec + plow;
    const cf = sp > 1e-9 ? vf / sp : 0;   // Coulomb direction shares (-v̂)
    const cr = sp > 1e-9 ? vr / sp : 0;

    // --- per-axis exact integration ---
    const turnK = 1 + T.TURN_DRAG_GAIN * Math.abs(steer);       // TN-06
    const longK = dragStatK * surf.long * (tuck ? T.TUCK_DRAG : 1) * turnK;
    const lamF = T.LAMBDA_LONG * longK;
    const cF = T.C_DRAG * longK;
    const lamR = T.LAMBDA_LAT * edgeStatK * surf.lat;

    vf = clampReversal(vf, flowSpeed(vf, aF - resist * cf, lamF, cF, dt), aF, resist);
    vr = clampReversal(vr, flowSpeed(vr, aR - resist * cr, lamR, 0, dt), aR, resist);

    // --- boost: first-order approach to V_BOOST while held (never pulls down) ---
    if (input.boost && st.boostMeter > 0) {
      if (vf < T.V_BOOST) vf += (T.V_BOOST - vf) * (1 - Math.exp(-dt / T.TAU_BOOST));
      st.boostMeter = Math.max(0, st.boostMeter - T.BOOST_DRAIN * dt);
    }

    // --- hard clamp (PC-06/07) ---
    const s2 = Math.hypot(vf, vr);
    if (s2 > T.V_CAP) { const k = T.V_CAP / s2; vf *= k; vr *= k; }

    st.vel[0] = fx * vf + rx * vr;
    st.vel[1] = fy * vf + ry * vr;
    st.vel[2] = fz * vf + rz * vr;

    // --- jump charge & spin prewind ---
    if (crouch) {
      st.charge = Math.min(1, st.charge + dt / T.T_CHARGE);
      const spinIn = num(input.spin);
      if (Math.abs(spinIn) > 0.3) {
        st.prewindDir = Math.sign(spinIn);
        st.prewound = Math.min(1, st.prewound + dt / T.PREWIND_TIME);
      }
    } else {
      st.charge = st.charge > 1e-4 ? st.charge * Math.exp(-dt / T.CHARGE_DECAY_TAU) : 0;
      st.prewound = st.prewound > 1e-4 ? st.prewound * Math.exp(-dt / 0.1) : 0;
    }

    // --- move along the plane; leave ground if terrain drops away ---
    st.pos[0] += st.vel[0] * dt;
    st.pos[1] += st.vel[1] * dt;
    st.pos[2] += st.vel[2] * dt;
    const hNew = sampleHeight(st.pos[0], st.pos[2]);
    if (st.pos[1] > hNew + T.GROUND_EPS) {
      takeoff(st, false); // natural takeoff (lip/cliff): keep ballistic velocity
      return;
    }
    // stay snapped: rotate velocity into the new tangent plane, |v| preserved
    st.pos[1] = hNew;
    const n2 = normalAt(st.pos[0], st.pos[2]);
    const vn = st.vel[0] * n2[0] + st.vel[1] * n2[1] + st.vel[2] * n2[2];
    const ix = st.vel[0] - vn * n2[0], iy = st.vel[1] - vn * n2[1], iz = st.vel[2] - vn * n2[2];
    const il = Math.hypot(ix, iy, iz);
    const mag = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
    if (il > 1e-9) {
      const k = mag / il;
      st.vel[0] = ix * k; st.vel[1] = iy * k; st.vel[2] = iz * k;
    }
  }

  return {
    config,

    init(pos, vel, heading) {
      return {
        pos: [pos[0], pos[1], pos[2]],
        vel: [vel[0], vel[1], vel[2]],
        heading,
        onGround: pos[1] <= sampleHeight(pos[0], pos[2]) + T.GROUND_EPS,
        charge: 0,
        airTime: 0,
        boostMeter: 1,
        spinDeg: 0,
        flipDeg: 0,
        landing: null,
        // extras (free fields per contract)
        yawRate: 0,
        prewound: 0,
        prewindDir: 1,
        prewoundActive: false,
        grabbing: false,
        trickLabel: null,
      };
    },

    step(state, input = {}, dt) {
      if (!(dt > 0)) return state;
      if (state.onGround) groundStep(state, input ?? {}, dt);
      else airStep(state, input ?? {}, dt);
      return state;
    },
  };
}
