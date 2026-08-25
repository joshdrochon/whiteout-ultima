// Baseline chase cam — exists ONLY to validate the camera gate runner. Not a candidate.
export function createChaseCam(camera, opts = {}) {
  const cfg = {
    dist: 5.5, height: 2.4, lookAhead: 6, lookUp: 1.2,
    lamPos: 8, lamYaw: 3.5, airExtra: 0.15, airRamp: 0.8,
    fovBase: camera.fov, fovSpeedKick: 0.10, fovTierKick: 0.03, lamFov: 4,
    shakeMax: 0.35, shakeFreq: 13, traumaDecay: 1.1, maxJitterStep: 0.25,
  };
  let az = null;                      // smoothed course azimuth
  let px = 0, py = 3, pz = -6;        // smoothed pivot (rider-tracking point)
  let trauma = 0, tPhase = 0, tier = 0, fov = cfg.fovBase;
  let seedA = (opts.seed ?? 1) * 977 + 1;
  const noise = t => Math.sin(t * cfg.shakeFreq * 2 * Math.PI + seedA) +
                     0.5 * Math.sin(t * cfg.shakeFreq * 4.7 + seedA * 2.1);
  const relax = (v, target, lam, dt) => target + (v - target) * Math.exp(-lam * dt);
  const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

  const debug = { lookAtTarget: [0, 0, 0] };

  function update(st, dt) {
    const sp = Math.hypot(st.vel[0], st.vel[2]);
    // course azimuth from velocity (NOT board heading -> spins don't drag the camera)
    const courseAz = sp > 1 ? Math.atan2(st.vel[2], st.vel[0]) : (az ?? st.heading);
    if (az === null) az = courseAz;
    az = az + wrap(courseAz - az) * (1 - Math.exp(-cfg.lamYaw * dt));
    // smoothed pivot chases rider position
    px = relax(px, st.pos[0], cfg.lamPos, dt);
    py = relax(py, st.pos[1], cfg.lamPos, dt);
    pz = relax(pz, st.pos[2], cfg.lamPos, dt);
    // boom
    const airFrac = st.onGround ? 0 : Math.min(1, (st.airTime ?? 0) / cfg.airRamp);
    const d = cfg.dist * (1 + cfg.airExtra * airFrac);
    let cx = px - Math.cos(az) * d, cz = pz - Math.sin(az) * d, cy = py + cfg.height;
    // trauma^2 shake
    tPhase += dt; trauma = Math.max(0, trauma - cfg.traumaDecay * dt);
    const sh = trauma * trauma * cfg.shakeMax;
    cx += sh * noise(tPhase); cy += sh * noise(tPhase + 7.3); cz += sh * noise(tPhase + 2.9);
    camera.position.set(cx, cy, cz);
    // fov
    const kick = cfg.fovSpeedKick * Math.min(1, Math.max(0, (sp - 15) / 15)) + cfg.fovTierKick * tier;
    fov = relax(fov, cfg.fovBase * (1 + kick), cfg.lamFov, dt);
    camera.fov = fov; camera.updateProjectionMatrix();
    // look target ahead along course
    debug.lookAtTarget = [st.pos[0] + Math.cos(az) * cfg.lookAhead,
      st.pos[1] + cfg.lookUp, st.pos[2] + Math.sin(az) * cfg.lookAhead];
    camera.lookAt(debug.lookAtTarget[0], debug.lookAtTarget[1], debug.lookAtTarget[2]);
  }

  return {
    update, config: cfg, debug,
    addTrauma: a => { trauma = Math.min(1, trauma + a); },
    setBoostTier: t => { tier = t; },
  };
}
