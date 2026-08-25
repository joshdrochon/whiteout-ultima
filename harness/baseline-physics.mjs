// Baseline physics module — exists ONLY to validate the gate runner mechanics.
// Deliberately unremarkable arcade model; NOT a gauntlet candidate.
const D2R = Math.PI / 180;

export function createPhysics(env, opts = {}) {
  const stats = { speed: 20, edging: 20, trick: 20, ...(opts.stats ?? {}) };
  const gScale = opts.gravityScale ?? 1;
  const surface = env.surface ?? 'snow';
  const surf = { snow: { grip: 4, mu: 0.05, drag: 0.014 },
                 ice: { grip: 2.2, mu: 0.03, drag: 0.012 },
                 powder: { grip: 4.5, mu: 0.05, drag: 0.014, lowDrag: 2.6 } }[surface];

  const cfg = {
    gGround: 9.81 * gScale, gAir: 6.5 * gScale,
    lambdaLong: 0.25, lambdaLat: surf.grip, mu: surf.mu, quadDrag: surf.drag,
    speedCap: 32, tuckCapBonus: 6.5, tuckLambdaScale: 0.55,
    boostThrust: 6.0, boostDrain: 0.2, boostRegen: 0.02,
    omega0: (170 + (stats.edging - 20) * 0.8) * D2R, aLatMax: 30,
    brakeDecel: 4.2, brakeOmegaScale: 1.35, crouchSteerMul: 0.4,
    fullLockDragMul: 1.15,
    chargeTime: 0.85, jumpV0: 1.9, jumpVFull: 5.0,
    spinRateMax: (300 + stats.trick * 7.25) * 1, stickSpinRate: 300, flipRate: 330,
    autoLevel: 220, spinCap: 1800, flipCap: 1080,
    cleanYaw: 45, crashYaw: 90,
    speedStatFrac: 0.0017, // per stat point on cap & thrust
  };
  const statSpeedMul = 1 + (stats.speed - 20) * cfg.speedStatFrac;

  function init(pos, vel, heading) {
    const grounded = pos[1] <= env.sampleHeight(pos[0], pos[2]) + 0.05;
    return { pos: pos.slice(), vel: vel.slice(), heading, yawRate: 0,
      onGround: grounded, charge: 0, airTime: 0, boostMeter: 1,
      spinDeg: 0, flipDeg: 0, landing: null, prewind: 0 };
  }

  // closed-form v' for dv/dt = a - lambda*v over dt (exact for constant a, lambda)
  const relax = (v, a, lam, dt) => lam < 1e-9 ? v + a * dt : a / lam + (v - a / lam) * Math.exp(-lam * dt);

  function step(st, input, dt) {
    const inp = input ?? {};
    const groundY = env.sampleHeight(st.pos[0], st.pos[2]);
    if (st.onGround) {
      const n = env.sampleNormal ? env.sampleNormal(st.pos[0], st.pos[2]) : [0, 1, 0];
      // gravity projected on surface plane
      const gAlong = [-cfg.gGround * n[0] * n[1], 0, -cfg.gGround * n[2] * n[1]];
      const slopeAccel = [-1 * gAlong[0] * -1, 0, -1 * gAlong[2] * -1]; // = g*sin(theta) downhill
      // decompose velocity into board frame
      const ch = Math.cos(st.heading), sh = Math.sin(st.heading);
      let vF = st.vel[0] * ch + st.vel[2] * sh;      // forward
      let vL = -st.vel[0] * sh + st.vel[2] * ch;     // lateral
      const sp = Math.hypot(vF, vL);
      // steering
      const steer = (inp.steer ?? 0) * (inp.crouch ? cfg.crouchSteerMul : 1) *
        (inp.tuck ? 0.6 : 1) * (inp.brake ? cfg.brakeOmegaScale : 1);
      const omegaCap = sp > 0.5 ? Math.min(cfg.omega0, cfg.aLatMax / sp) : cfg.omega0;
      const om = steer * omegaCap;
      st.heading += om * dt; st.yawRate = om;
      // forward accel: slope component along heading + boost - coulomb - quad drag
      const aSlope = slopeAccel[0] * Math.cos(st.heading) + slopeAccel[2] * Math.sin(st.heading);
      let aF = aSlope - cfg.mu * cfg.gGround * n[1] * Math.sign(vF || 1);
      if (inp.boost && st.boostMeter > 0) { aF += cfg.boostThrust * statSpeedMul; st.boostMeter = Math.max(0, st.boostMeter - cfg.boostDrain * dt); }
      if (inp.brake) aF -= cfg.brakeDecel * Math.sign(vF || 1);
      if (surface === 'powder') aF -= surf.lowDrag * Math.exp(-Math.abs(vF) / 8) * Math.sign(vF || 1);
      const lamF = (cfg.lambdaLong * (inp.tuck ? cfg.tuckLambdaScale : 1) *
        (Math.abs(inp.steer ?? 0) > 0.95 ? cfg.fullLockDragMul : 1)) + cfg.quadDrag * Math.abs(vF);
      vF = relax(vF, aF, lamF, dt);
      vL = relax(vL, 0, cfg.lambdaLat * (inp.brake ? 1.6 : 1), dt);
      // speed cap
      const cap = (cfg.speedCap * statSpeedMul + (inp.tuck ? cfg.tuckCapBonus : 0)) * (inp.boost ? 1.05 : 1);
      const s2 = Math.hypot(vF, vL);
      if (s2 > cap) { vF *= cap / s2; vL *= cap / s2; }
      st.vel[0] = vF * ch - vL * sh; st.vel[2] = vF * sh + vL * ch; st.vel[1] = 0;
      // charge & prewind
      if (inp.crouch) { st.charge = Math.min(1, st.charge + dt / cfg.chargeTime); st.prewind = inp.spin ?? 0; }
      if (inp.jumpRelease) {
        const j = cfg.jumpV0 + (cfg.jumpVFull - cfg.jumpV0) * st.charge;
        st.vel[1] += j;               // world-up impulse; horizontal untouched
        st.onGround = false; st.airTime = 0; st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
        st.spinBoost = st.prewind; st.charge = 0;
      }
      // follow terrain
      st.pos[0] += st.vel[0] * dt; st.pos[2] += st.vel[2] * dt;
      const gy = env.sampleHeight(st.pos[0], st.pos[2]);
      if (st.onGround) {
        if (gy < st.pos[1] - 0.7) { st.onGround = false; st.airTime = 0; st.spinDeg = 0; st.flipDeg = 0; st.landing = null; }
        else st.pos[1] = gy;
      } else st.pos[1] += st.vel[1] * dt;
    } else {
      // airborne: ballistic only
      st.airTime += dt;
      st.vel[1] -= cfg.gAir * dt;
      st.pos[0] += st.vel[0] * dt; st.pos[1] += st.vel[1] * dt; st.pos[2] += st.vel[2] * dt;
      // rotation (visual only, never touches vel/pos)
      const spinIn = inp.spin ?? 0, flipIn = inp.flip ?? 0;
      const rate = (Math.abs(st.spinBoost ?? 0) > 0.5 ? cfg.spinRateMax : cfg.stickSpinRate);
      if (Math.abs(st.spinDeg) < cfg.spinCap && spinIn)
        st.spinDeg += Math.sign(spinIn) * Math.min(rate, (cfg.spinCap - Math.abs(st.spinDeg)) / dt) * dt;
      if (Math.abs(st.flipDeg) < cfg.flipCap && flipIn)
        st.flipDeg += Math.sign(flipIn) * Math.min(cfg.flipRate, (cfg.flipCap - Math.abs(st.flipDeg)) / dt) * dt;
      if (!spinIn && !flipIn) {
        const resid = ((st.spinDeg % 360) + 360) % 360;
        const target = resid > 180 ? 360 - resid : -resid;
        const stepDeg = Math.sign(target) * Math.min(cfg.autoLevel * dt, Math.abs(target));
        st.spinDeg += stepDeg;
        const fresid = ((st.flipDeg % 360) + 360) % 360;
        const ftarget = fresid > 180 ? 360 - fresid : -fresid;
        st.flipDeg += Math.sign(ftarget) * Math.min(cfg.autoLevel * dt, Math.abs(ftarget));
      }
      const gy = env.sampleHeight(st.pos[0], st.pos[2]);
      if (st.pos[1] <= gy && st.vel[1] <= 0) {
        st.pos[1] = gy; st.onGround = true; st.vel[1] = 0;
        let residual = Math.abs(((st.spinDeg % 360) + 360) % 360);
        residual = residual > 180 ? 360 - residual : residual;
        st.landing = (inp.grab) ? 'crash'
          : residual <= cfg.cleanYaw ? 'clean'
          : residual < cfg.crashYaw ? 'sketchy' : 'crash';
        if (st.landing === 'crash') { st.vel[0] *= 0.2; st.vel[2] *= 0.2; }
        st.spinBoost = 0;
      }
    }
    if (!inp.boost) st.boostMeter = Math.min(1, st.boostMeter + cfg.boostRegen * dt);
    return st;
  }

  return { config: cfg, init, step };
}
