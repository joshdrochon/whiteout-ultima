// Chase camera rig — boom-arm model (candidate A, camera-follow lane).
//
// Structure: a smoothed PIVOT chases the rider's position (critically-damped
// exponential, closed-form in dt). The camera hangs off a BOOM behind the pivot
// along a smoothed course azimuth derived from the rider's VELOCITY — never the
// board heading — so spins (ground or air) do not orbit the camera (CF-04/05).
// The boom lengthens while airborne for apex framing (CF-06). FOV kicks with
// speed and boost tier, capped under +20%, easing in faster than out (CF-07/09).
// Shake is trauma^2 procedural sine noise added at the very end of the chain
// (CF-08); everything upstream is exact exponential damping, so one 100 ms step
// equals ten 10 ms steps (CF-01) and crash jitter is low-passed, never snapped
// through (CF-11).
//
// All smoothing uses x += (target - x) * (1 - exp(-lambda * dt)) — dt-exact.

const TAU = Math.PI * 2;

function wrapAngle(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// tiny deterministic PRNG for seed-derived noise phases
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createChaseCam(camera, opts = {}) {
  const config = {
    posLambda: 8.0,        // pivot position damping, /s (CF-02 band 6-10)
    yawLambda: 3.5,        // course-azimuth damping, /s (CF-03 band 2.5-5, < posLambda)
    boomLength: 6.0,       // m behind pivot along course azimuth
    boomHeight: 2.5,       // m above pivot
    airPullMax: 1.4,       // extra boom length at full air pull, m (CF-06)
    airLambda: 2.0,        // air-pull engage/release damping, /s
    minCourseSpeed: 0.5,   // m/s; below this, hold last azimuth (crash safety)
    fovSpeedKick: 0.10,    // fov frac at full speed norm
    fovSpeedNorm: 32,      // m/s that counts as "full speed" for the kick
    fovTierKick: 0.03,     // fov frac per boost tier (0..3)
    fovKickCap: 0.20,      // hard cap on total fov kick frac (CF-07)
    fovInLambda: 8.0,      // ease-in (widening) damping, /s
    fovOutLambda: 3.0,     // ease-out (narrowing) damping, /s — slower than in
    lookAheadBase: 5.0,    // m ahead of pivot along course
    lookAheadPerSpeed: 0.2,// extra look-ahead per m/s
    lookUp: 1.0,           // look target height above rider root, m
    shakeMaxAmp: 0.3,      // m positional shake at trauma = 1
    traumaDecay: 1.0,      // linear trauma decay, /s
    shakeFreq1: 43.0,      // rad/s, per-axis noise frequencies
    shakeFreq2: 59.0,
    shakeFreq3: 71.0,
  };

  const rand = mulberry32((opts.seed ?? 1) * 747796405 + 2891336453);
  const phase1 = rand() * TAU;
  const phase2 = rand() * TAU;
  const phase3 = rand() * TAU;

  const baseFov = camera.fov;

  // rig state
  let initialized = false;
  const pivot = [0, 0, 0];
  let azimuth = 0;          // smoothed course azimuth (world yaw of boom)
  let azimuthTarget = 0;    // last valid velocity azimuth
  let airPull = 0;          // 0..1 smoothed airborne factor
  let fov = baseFov;
  let boostTier = 0;
  let trauma = 0;
  let shakeTime = 0;

  const rig = {
    config,
    debug: { lookAtTarget: [0, 0, 0] },

    addTrauma(amount) {
      trauma = clamp(trauma + (Number(amount) || 0), 0, 1);
    },

    setBoostTier(tier) {
      boostTier = clamp(Math.round(Number(tier) || 0), 0, 3);
    },

    update(riderState, dt) {
      if (!(dt > 0)) return;
      const p = riderState.pos;
      const v = riderState.vel;
      const hSpeed = Math.hypot(v[0], v[2]);

      if (!initialized) {
        pivot[0] = p[0]; pivot[1] = p[1]; pivot[2] = p[2];
        azimuthTarget = hSpeed >= config.minCourseSpeed
          ? Math.atan2(v[2], v[0])
          : (riderState.heading || 0);
        azimuth = azimuthTarget;
        initialized = true;
      }

      // --- course azimuth: velocity direction only, never board heading ---
      if (hSpeed >= config.minCourseSpeed) {
        azimuthTarget = Math.atan2(v[2], v[0]);
      }
      const kYaw = 1 - Math.exp(-config.yawLambda * dt);
      azimuth = wrapAngle(azimuth + wrapAngle(azimuthTarget - azimuth) * kYaw);

      // --- pivot chases rider position ---
      const kPos = 1 - Math.exp(-config.posLambda * dt);
      pivot[0] += (p[0] - pivot[0]) * kPos;
      pivot[1] += (p[1] - pivot[1]) * kPos;
      pivot[2] += (p[2] - pivot[2]) * kPos;

      // --- air pull-back for apex framing ---
      const kAir = 1 - Math.exp(-config.airLambda * dt);
      airPull += ((riderState.onGround ? 0 : 1) - airPull) * kAir;

      // --- boom ---
      const dirX = Math.cos(azimuth);
      const dirZ = Math.sin(azimuth);
      const boom = config.boomLength + config.airPullMax * airPull;
      const camX = pivot[0] - dirX * boom;
      const camY = pivot[1] + config.boomHeight;
      const camZ = pivot[2] - dirZ * boom;

      // --- fov ladder: speed + boost tier, capped, in-fast out-slow ---
      const speedNorm = clamp(hSpeed / config.fovSpeedNorm, 0, 1);
      const kick = Math.min(
        config.fovKickCap,
        config.fovSpeedKick * speedNorm + config.fovTierKick * boostTier,
      );
      const fovTarget = baseFov * (1 + kick);
      const fovLambda = fovTarget > fov ? config.fovInLambda : config.fovOutLambda;
      fov += (fovTarget - fov) * (1 - Math.exp(-fovLambda * dt));
      camera.fov = fov;
      camera.updateProjectionMatrix();

      // --- look target: ahead of the pivot along course, above rider root ---
      const ahead = config.lookAheadBase + config.lookAheadPerSpeed * hSpeed;
      const lookAt = [
        pivot[0] + dirX * ahead,
        pivot[1] + config.lookUp,
        pivot[2] + dirZ * ahead,
      ];
      rig.debug.lookAtTarget = lookAt;

      // --- trauma shake: amplitude = trauma^2, linear decay, end of chain ---
      trauma = Math.max(0, trauma - config.traumaDecay * dt);
      shakeTime += dt;
      const amp = config.shakeMaxAmp * trauma * trauma;
      let ox = 0, oy = 0, oz = 0;
      if (amp > 0) {
        ox = amp * Math.sin(config.shakeFreq1 * shakeTime + phase1);
        oy = amp * 0.6 * Math.sin(config.shakeFreq2 * shakeTime + phase2);
        oz = amp * 0.8 * Math.sin(config.shakeFreq3 * shakeTime + phase3);
      }

      camera.position.set(camX + ox, camY + oy, camZ + oz);
      camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    },
  };

  return rig;
}
