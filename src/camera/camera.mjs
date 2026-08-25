// Chase camera rig — boom-arm model (candidate A, camera-follow lane).
//
// Structure: a smoothed PIVOT chases the rider's position (critically-damped
// exponential, closed-form in dt). The camera hangs off a BOOM behind the pivot
// along a smoothed course azimuth derived from the rider's VELOCITY — never the
// board heading — so spins (ground or air) do not orbit the camera (CF-04/05).
// The boom lengthens AND rises while airborne, and the look-at relaxes toward
// horizontal as airTime grows, so both the rider and the landing zone stay in
// frame at apex (CF-06). FOV kicks with speed and boost tier, capped under +20%,
// easing in faster than out (CF-07/09). Shake is trauma^2 procedural noise added
// at the very end of the chain (CF-08): positional sines with incommensurate
// frequencies whose phases drift under cheap value-noise (no Lissajous buzz),
// plus a rotational judder channel applied as a look-at perturbation (<= 5 deg
// equivalent at trauma 1). Everything upstream is exact exponential damping, so
// one 100 ms step equals ten 10 ms steps (CF-01) and crash jitter is low-passed,
// never snapped through (CF-11).
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

// cheap deterministic 1D value-noise in [-1, 1]: hashed integer lattice,
// smoothstep-interpolated. Pure function of t, so it is trivially dt-exact.
function makeValueNoise(seed) {
  const hash = (i) => {
    let t = (i + seed) | 0;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) >>> 0;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
  return (t) => {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    const a = hash(i);
    return a + (hash(i + 1) - a) * u;
  };
}

export function createChaseCam(camera, opts = {}) {
  const config = {
    posLambda: 8.0,        // pivot position damping, /s (CF-02 band 6-10)
    yawLambda: 3.5,        // course-azimuth damping, /s (CF-03 band 2.5-5, < posLambda)
    boomLength: 6.0,       // m behind pivot along course azimuth
    boomHeight: 2.5,       // m above pivot
    airPullMax: 1.1,       // extra boom length at full air pull, m (CF-06)
    airLambda: 2.0,        // air-pull engage/release damping, /s
    airRiseMax: 1.4,       // extra boom HEIGHT at full air rise, m (CF-06 apex framing)
    airRiseTime: 2.0,      // s of airTime to reach full rise (small hops barely lift)
    airLookRelax: 1.0,     // frac of lookUp shed at full air (pitch relaxes toward
                           // horizontal: raised cam + rider-root look-at keeps both
                           // rider and the landing zone ahead in frame)
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
    shakeFreq1: 42.583,    // rad/s, per-axis carrier frequencies — deliberately
    shakeFreq2: 58.917,    // irrational-ratio (incommensurate) so the three axes
    shakeFreq3: 70.711,    // never phase-lock into a repeating Lissajous figure
    shakeDriftFreq: 1.7,   // Hz of the value-noise that wanders each carrier phase
    shakeDriftDepth: 2.2,  // rad of phase wander at full depth
    shakeMaxRotDeg: 5.0,   // total rotational judder at trauma = 1 (CF-08 spec cap)
    shakeRotFreq: 13.0,    // Hz of the rotational value-noise judder
  };

  const rand = mulberry32((opts.seed ?? 1) * 747796405 + 2891336453);
  const phase1 = rand() * TAU;
  const phase2 = rand() * TAU;
  const phase3 = rand() * TAU;
  const noiseSeed = () => Math.floor(rand() * 2147483647);
  const drift1 = makeValueNoise(noiseSeed());
  const drift2 = makeValueNoise(noiseSeed());
  const drift3 = makeValueNoise(noiseSeed());
  const rotYawNoise = makeValueNoise(noiseSeed());
  const rotPitchNoise = makeValueNoise(noiseSeed());

  const baseFov = camera.fov;

  // rig state
  let initialized = false;
  const pivot = [0, 0, 0];
  let azimuth = 0;          // smoothed course azimuth (world yaw of boom)
  let azimuthTarget = 0;    // last valid velocity azimuth
  let airPull = 0;          // 0..1 smoothed airborne factor
  let airRise = 0;          // m smoothed extra boom height while airborne
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

      // --- air pull-back + rise for apex framing ---
      // The boom both lengthens (airPull) and RISES (airRise) while airborne.
      // The rise target ramps with airTime so small hops barely lift the camera
      // but a big air raises it toward airRiseMax; the smoothed state means
      // touchdown (airTime snapping to 0) releases the rise gradually, never in
      // a single-frame drop.
      const kAir = 1 - Math.exp(-config.airLambda * dt);
      airPull += ((riderState.onGround ? 0 : 1) - airPull) * kAir;
      const riseTarget = riderState.onGround
        ? 0
        : config.airRiseMax * clamp((riderState.airTime || 0) / config.airRiseTime, 0, 1);
      airRise += (riseTarget - airRise) * kAir;

      // --- boom ---
      const dirX = Math.cos(azimuth);
      const dirZ = Math.sin(azimuth);
      const boom = config.boomLength + config.airPullMax * airPull;
      const camX = pivot[0] - dirX * boom;
      const camY = pivot[1] + config.boomHeight + airRise;
      const camZ = pivot[2] - dirZ * boom;

      // --- fov ladder: speed + boost tier, capped, in-fast out-slow ---
      // DELIBERATE: fov reads HORIZONTAL speed only (hSpeed, not |vel|). Vertical
      // speed in drops and big airs would otherwise fisheye the lens exactly when
      // the framing needs to stay stable; perceived "going fast" on a slope is
      // ground-relative, which horizontal speed tracks and fall speed does not.
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
      // During airs the look-at pitch relaxes toward horizontal: the look point
      // sheds its +lookUp offset as airRise grows, so the raised camera looking
      // at rider-root height frames both the rider and the ground ahead where
      // the landing zone is, instead of tilting up and losing the ground.
      const airFactor = config.airRiseMax > 0 ? clamp(airRise / config.airRiseMax, 0, 1) : 0;
      const ahead = config.lookAheadBase + config.lookAheadPerSpeed * hSpeed;
      const lookAt = [
        pivot[0] + dirX * ahead,
        pivot[1] + config.lookUp * (1 - config.airLookRelax * airFactor),
        pivot[2] + dirZ * ahead,
      ];

      // --- trauma shake: amplitude = trauma^2, linear decay, end of chain ---
      // Positional channel: per-axis sine carriers at incommensurate frequencies
      // whose phases WANDER under cheap value-noise, so the offset never settles
      // into a repeating Lissajous figure. Rotational channel: value-noise judder
      // applied as a look-at perturbation, <= shakeMaxRotDeg total at trauma = 1.
      // Both are pure functions of (shakeTime, trauma) — exact accumulations —
      // so dt-exactness (CF-01) is preserved, and both scale as trauma^2 (CF-08).
      trauma = Math.max(0, trauma - config.traumaDecay * dt);
      shakeTime += dt;
      const t2 = trauma * trauma;
      const amp = config.shakeMaxAmp * t2;
      let ox = 0, oy = 0, oz = 0;
      if (amp > 0) {
        const dTime = shakeTime * config.shakeDriftFreq;
        const d = config.shakeDriftDepth;
        ox = amp * Math.sin(config.shakeFreq1 * shakeTime + phase1 + d * drift1(dTime));
        oy = amp * 0.6 * Math.sin(config.shakeFreq2 * shakeTime + phase2 + d * drift2(dTime + 31.7));
        oz = amp * 0.8 * Math.sin(config.shakeFreq3 * shakeTime + phase3 + d * drift3(dTime + 63.1));
        // rotational judder: yaw + pitch perturbation of the look target.
        // Per-axis budget is 0.7 * max so the worst-case vector sum stays within
        // shakeMaxRotDeg (sqrt(2) * 0.7 ≈ 0.99). Small-angle: offset = angle * dist.
        const rotAmp = (config.shakeMaxRotDeg * Math.PI / 180) * 0.7 * t2;
        const rTime = shakeTime * config.shakeRotFreq;
        const yawJ = rotAmp * rotYawNoise(rTime);
        const pitchJ = rotAmp * rotPitchNoise(rTime + 17.3);
        const ldx = lookAt[0] - camX, ldy = lookAt[1] - camY, ldz = lookAt[2] - camZ;
        const lookDist = Math.hypot(ldx, ldy, ldz);
        lookAt[0] += -dirZ * yawJ * lookDist;
        lookAt[2] += dirX * yawJ * lookDist;
        lookAt[1] += pitchJ * lookDist;
      }
      rig.debug.lookAtTarget = lookAt;

      camera.position.set(camX + ox, camY + oy, camZ + oz);
      camera.lookAt(lookAt[0], lookAt[1], lookAt[2]);
    },
  };

  return rig;
}
