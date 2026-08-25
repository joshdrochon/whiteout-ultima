// Candidate B — SSX-style lazy chase camera.
//
// Model: dual-target damped rig. Camera position and look-target are two
// independently damped points with different lambdas (position tight, yaw/look
// lazy), each tracking an analytic target built from the rider's COURSE
// (smoothed velocity azimuth) — never board heading, so spins read on the
// rider, not the camera. FOV rides its own damped channel (fast in, slow out).
// Trauma shake is additive on top of the smooth core (position + look-target
// judder), amplitude = trauma^2, linear trauma decay.
//
// All damping is closed-form exp(-lambda*dt), and shake is a pure function of
// accumulated time, so any partition of a time interval into sub-steps lands
// on the identical camera state (CF-01 split-step exact).
//
// Velocity feed-forward (v / lambda) is added to each target so the settled
// camera sits exactly at its offset with zero steady-state lag at any speed.

export function createChaseCam(camera, opts = {}) {
  const config = {
    // position channel
    LAMBDA_POS: 8.0,        // /s  (CF-02 band 6-10)
    FOLLOW_DIST: 6.0,       // m behind rider along course
    FOLLOW_HEIGHT: 2.2,     // m above rider root
    // yaw (course) channel — lazy chase
    LAMBDA_YAW: 3.3,        // /s  (CF-03 band 2.5-5, strictly < LAMBDA_POS)
    MIN_COURSE_SPEED: 0.5,  // m/s; below this, hold last course azimuth
    // air framing
    AIR_PULLBACK: 1.155,    // follow-offset multiplier target while airborne
    LAMBDA_AIR: 2.5,        // /s ease of the pullback
    // look-target channel
    LAMBDA_LOOK: 10.0,      // /s
    LOOK_UP: 1.0,           // m above rider root
    LOOK_GAIN: 0.35,        // s — look-ahead = LOOK_GAIN * ground speed
    LOOK_MAX: 8.0,          // m look-ahead clamp
    // fov channel
    FOV_SPEED_MAX: 0.10,    // max fractional kick from speed alone
    FOV_SPEED_REF: 33.0,    // m/s at which the speed kick saturates (~V_CAP)
    FOV_BOOST_STEP: 0.03,   // fractional kick per boost tier (0..3)
    FOV_KICK_CAP: 0.20,     // never fisheye: total kick <= +20% of base
    FOV_LAMBDA_IN: 6.0,     // /s widening (ease in faster...)
    FOV_LAMBDA_OUT: 2.5,    // /s narrowing (...than out)
    // trauma shake
    TRAUMA_DECAY: 0.65,     // /s linear decay (clean landing ~0.3 gone in <0.5 s)
    SHAKE_AMP: 0.35,        // m positional amplitude at trauma 1
    SHAKE_LOOK: 0.30,       // m look-target judder at trauma 1 (~2.5 deg at rig dist)
    BOOST_PICKUP_TIER: 3,   // pickup grants top tier
    BOOST_PICKUP_TIME: 5.0, // s (game-side hook; not driven by this rig)
  };

  const TAU = Math.PI * 2;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  // seeded phases for the shake noise (deterministic per seed)
  let s = ((opts.seed ?? 1) >>> 0) || 1;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const NOISE_F = [11.3, 13.1, 9.7, 8.9, 12.3, 10.1]; // Hz
  const NOISE_P = NOISE_F.map(() => rand() * TAU);
  const noise = (i, t) => Math.sin(TAU * NOISE_F[i] * t + NOISE_P[i]);

  // state
  let initialized = false;
  const P = { x: 0, y: 0, z: 0 };   // smooth camera-position point
  const L = { x: 0, y: 0, z: 0 };   // smooth look-target point
  let thetaS = 0;                   // smoothed course azimuth (rad)
  let airM = 1;                     // air pull-back multiplier
  const baseFov = camera.fov;
  let fovState = camera.fov;
  let trauma = 0;
  let tNoise = 0;
  let boostTier = 0;

  const debug = { lookAtTarget: [0, 0, 0] };

  function update(st, dt) {
    if (!(dt > 0)) dt = 0;
    const px = st.pos[0], py = st.pos[1], pz = st.pos[2];
    const vx = st.vel[0], vy = st.vel[1], vz = st.vel[2];
    const hSpeed = Math.hypot(vx, vz);
    const speed = Math.hypot(vx, vy, vz);

    // --- course azimuth: smoothed VELOCITY heading; board heading never enters
    if (!initialized) thetaS = hSpeed > config.MIN_COURSE_SPEED ? Math.atan2(vz, vx) : 0;
    else if (hSpeed > config.MIN_COURSE_SPEED) {
      const err = wrap(Math.atan2(vz, vx) - thetaS);
      thetaS = wrap(thetaS + err * (1 - Math.exp(-config.LAMBDA_YAW * dt)));
    }
    const fx = Math.cos(thetaS), fz = Math.sin(thetaS);

    // --- air pull-back (eases toward AIR_PULLBACK while airborne)
    const airTarget = st.onGround ? 1 : config.AIR_PULLBACK;
    airM += (airTarget - airM) * (1 - Math.exp(-config.LAMBDA_AIR * dt));

    // --- position point: behind + above along course, velocity feed-forward
    const dx = px - fx * config.FOLLOW_DIST * airM + vx / config.LAMBDA_POS;
    const dy = py + config.FOLLOW_HEIGHT * airM + vy / config.LAMBDA_POS;
    const dz = pz - fz * config.FOLLOW_DIST * airM + vz / config.LAMBDA_POS;
    if (!initialized) { P.x = dx; P.y = dy; P.z = dz; }
    else {
      const k = 1 - Math.exp(-config.LAMBDA_POS * dt);
      P.x += (dx - P.x) * k;
      P.y += (dy - P.y) * k;
      P.z += (dz - P.z) * k;
    }

    // --- look-target point: ahead along velocity, ~1 m above rider root
    let ax = fx, az = fz;
    if (hSpeed > config.MIN_COURSE_SPEED) { ax = vx / hSpeed; az = vz / hSpeed; }
    const ahead = Math.min(config.LOOK_MAX, config.LOOK_GAIN * hSpeed);
    const lx = px + ax * ahead + vx / config.LAMBDA_LOOK;
    const ly = py + config.LOOK_UP + vy / config.LAMBDA_LOOK;
    const lz = pz + az * ahead + vz / config.LAMBDA_LOOK;
    if (!initialized) { L.x = lx; L.y = ly; L.z = lz; }
    else {
      const k = 1 - Math.exp(-config.LAMBDA_LOOK * dt);
      L.x += (lx - L.x) * k;
      L.y += (ly - L.y) * k;
      L.z += (lz - L.z) * k;
    }

    // --- fov: speed + boost-tier ladder, capped, fast in / slow out
    const kick = Math.min(
      config.FOV_KICK_CAP,
      config.FOV_SPEED_MAX * Math.min(1, speed / config.FOV_SPEED_REF) +
      config.FOV_BOOST_STEP * boostTier,
    );
    const fovTarget = baseFov * (1 + kick);
    const lf = fovTarget >= fovState ? config.FOV_LAMBDA_IN : config.FOV_LAMBDA_OUT;
    fovState += (fovTarget - fovState) * (1 - Math.exp(-lf * dt));

    // --- trauma shake: amplitude = trauma^2, linear decay, additive on core
    tNoise += dt;
    trauma = Math.max(0, trauma - config.TRAUMA_DECAY * dt);
    const a = config.SHAKE_AMP * trauma * trauma;
    const sx = a * noise(0, tNoise);
    const sy = a * noise(1, tNoise);
    const sz = a * noise(2, tNoise);
    const al = config.SHAKE_LOOK * trauma * trauma;
    const jx = al * noise(3, tNoise);
    const jy = al * noise(4, tNoise);
    const jz = al * noise(5, tNoise);

    camera.position.set(P.x + sx, P.y + sy, P.z + sz);
    debug.lookAtTarget[0] = L.x + jx;
    debug.lookAtTarget[1] = L.y + jy;
    debug.lookAtTarget[2] = L.z + jz;
    camera.lookAt(debug.lookAtTarget[0], debug.lookAtTarget[1], debug.lookAtTarget[2]);
    camera.fov = fovState;
    camera.updateProjectionMatrix();

    initialized = true;
  }

  function addTrauma(amount) {
    trauma = Math.min(1, trauma + Math.max(0, amount));
  }

  function setBoostTier(tier) {
    boostTier = Math.max(0, Math.min(3, tier | 0));
  }

  return { update, config, debug, addTrauma, setBoostTier };
}
