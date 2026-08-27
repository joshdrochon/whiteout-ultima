// Baseline rails — validates the rail runner only. Plain; NOT a candidate.
export function createRails(env) {
  // A_AUTH is the lateral acceleration the rider can hold on a rail at full
  // stick — 1 g. It is what makes a bend a DIFFICULTY CURVE instead of a cliff:
  // the old model charged curv * 26 * (v/18), which is linear in curvature and
  // linear in v, so load overran the 1.6/s steering authority between R150
  // (1.04/s, free) and R80 (1.95/s, impossible). Real lateral load is v^2 * k.
  // 18 m/s^2, not 1 g. Sized against the gate's tight bend: R=25 at 28 m/s puts
  // aLat near 31 m/s^2, so at 1 g the equilibrium sits at 3.2 and even full stick
  // (0.9) cannot bring it under the bail threshold — the bend was unsurvivable
  // rather than demanding. At 18 the passive equilibrium is 1.74 (drops you) and
  // steering brings it to 0.84 (holds), which is the behaviour the research
  // describes: you fall off for NOT turning.
  const A_AUTH = 18.0;
  const LOOKAHEAD_M = 6;
  const cfg = { captureRadius_m: 1.0, dragScale: 0.35, balanceHalfLife_s: 2.2,
    // the bend angle over LOOKAHEAD_M at which load reaches authority, at 18 m/s
    curveTolerance_rad: 0.23, minLockSpeed_mps: 3, balanceGain: 0.9,
    settleRate: 3.30, curveLoadGain: 1.0 };
  const rails = env.rails ?? [];

  // closest point on a polyline; returns {d, p, tang, s (arclength), total}
  function closest(x, z) {
    let best = null;
    for (const r of rails) {
      let acc = 0;
      const segs = [];
      for (let i = 0; i < r.points.length - 1; i++) {
        const a = r.points[i], b = r.points[i + 1];
        const L = Math.hypot(b[0] - a[0], b[2] - a[2]);
        segs.push({ a, b, L, s0: acc }); acc += L;
      }
      for (const sg of segs) {
        const dx = sg.b[0] - sg.a[0], dz = sg.b[2] - sg.a[2];
        const t = Math.max(0, Math.min(1, ((x - sg.a[0]) * dx + (z - sg.a[2]) * dz) / (dx * dx + dz * dz || 1e-9)));
        const px = sg.a[0] + dx * t, pz = sg.a[2] + dz * t;
        const d = Math.hypot(x - px, z - pz);
        const dy = sg.b[1] - sg.a[1];
        const L3 = Math.hypot(sg.L, dy) || 1e-9;
        if (!best || d < best.d) best = { d, px, pz, py: sg.a[1] + dy * t, id: r.id,
          tang: [dx / (sg.L || 1e-9), dz / (sg.L || 1e-9)],
          // 3D slope of this segment: sin(theta), negative when DESCENDING
          sinTheta: dy / L3, s: sg.s0 + sg.L * t, total: acc };
      }
    }
    return best;
  }

  function init() {
    return { onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0, _cool: 0 };
  }

  function step(gs, ps, input, dt) {
    const inp = input ?? {};
    const sp = Math.hypot(ps.vel[0], ps.vel[2]);
    if (gs._cool > 0) gs._cool -= dt;

    if (!gs.onRail) {
      if (gs._cool <= 0 && sp >= cfg.minLockSpeed_mps) {
        const c = closest(ps.pos[0], ps.pos[2]);
        if (c && c.d <= cfg.captureRadius_m) {
          // ARRIVAL ERROR IS CARRIED, NOT ERASED. The snap removes the lateral
          // OFFSET, but the rider keeps the lateral VELOCITY they arrived with,
          // and that is what topples them. Zeroing balance here made a 0.9 m
          // miss at -3 m/s bail at exactly the same time as a perfect landing.
          const nx = -c.tang[1], nz = c.tang[0];                  // rail normal, XZ
          const off = (ps.pos[0] - c.px) * nx + (ps.pos[2] - c.pz) * nz;
          const latV = ps.vel[0] * nx + ps.vel[2] * nz;
          // documented lock-on snap: the ONLY position write this module makes
          ps.pos[0] = c.px; ps.pos[2] = c.pz; ps.pos[1] = c.py;
          gs.onRail = true; gs.railId = c.id; gs.bailed = false;
          // A miss is a miss whichever side it is on, so the offset term takes
          // the sign of the velocity rather than cancelling against it.
          const sgnV = latV >= 0 ? 1 : -1;
          const seed = latV / 6.0 * 0.70
            + sgnV * Math.abs(off) / Math.max(cfg.captureRadius_m, 1e-6) * 0.30;
          gs.balance = Math.max(-0.95, Math.min(0.95, seed));
          ps.constrained = true;   // supported by non-terrain: physics runs the rider
          gs.alongSpeed = Math.abs(ps.vel[0] * c.tang[0] + ps.vel[2] * c.tang[1]) || sp;
          gs.t = c.total ? c.s / c.total : 0;
          gs.lockFrames = 0;
        }
      }
      return gs;
    }

    // on rail: advance along the polyline with reduced drag, velocity only
    gs.lockFrames++;
    const c = closest(ps.pos[0], ps.pos[2]);
    if (!c) { gs.onRail = false; ps.constrained = false; return gs; }
    const lam = 0.25 * cfg.dragScale;                       // rail drag < snow drag
    // GRAVITY ALONG THE TANGENT. Every rail in the runner used to be flat, so
    // this term was missing for six cycles and a descending rail SLOWED the
    // rider (measured 5.85 m/s at the bottom of a 25 deg descent against 15.75
    // on the snow beside it). dt-exact, same closed form as physics' drag:
    //   v = a/lam + (v - a/lam) * exp(-lam*dt)
    const aTan = -9.81 * (c.sinTheta ?? 0);                 // descending -> positive
    const term = aTan / lam;
    gs.alongSpeed = term + (gs.alongSpeed - term) * Math.exp(-lam * dt);
    // physics caps total velocity in the constrained state (PC-22), but keep the
    // module's own bookkeeping honest too
    gs.alongSpeed = Math.max(-33, Math.min(33, gs.alongSpeed));
    const horiz = gs.alongSpeed * Math.sqrt(Math.max(0, 1 - (c.sinTheta ?? 0) ** 2));
    ps.vel[0] = c.tang[0] * horiz;
    ps.vel[2] = c.tang[1] * horiz;
    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);          // follow the rail down

    // balance: drifts on its own, corrected by steering; curvature pushes it
    const ahead = closest(ps.pos[0] + c.tang[0] * 6, ps.pos[2] + c.tang[1] * 6);
    let curv = 0;
    if (ahead) {
      const cross = c.tang[0] * ahead.tang[1] - c.tang[1] * ahead.tang[0];
      curv = Math.asin(Math.max(-1, Math.min(1, cross)));
    }
    // Lateral load as a fraction of authority: k = bend angle / lookahead, and
    // aLat = v^2 * k. Demand rises with the SQUARE of speed.
    const k = curv / LOOKAHEAD_M;                              // rad/m, signed
    const aLat = gs.alongSpeed * gs.alongSpeed * k;            // m/s^2, signed

    // SSX MODEL, converted 2026-08-27 with the gate law. This used to be a
    // stance DRIFT that grew with the current lean — an instability the rider
    // had to fight even on a straight rail. That is the Tony Hawk balance meter,
    // not the reference bar: references/research/02 sec 1.5 says SSX lock-on is
    // automatic and the balance element is "handled by stance". Balance now
    // SETTLES toward an equilibrium set by the curve load, so a straight rail is
    // stable and only a bend can take you off.
    // balanceGain is capped BELOW the bail threshold on purpose: full stick on a
    // STRAIGHT rail must not throw the rider off. At the old 1.6 the equilibrium
    // sat at +-1.6 and steering alone bailed instantly, so GR-05's stick-response
    // clause read null. Steering offsets curve load; it does not create failure.
    const bEq = Math.max(-3, Math.min(3,
      (aLat / A_AUTH) * cfg.curveLoadGain - (inp.steer ?? 0) * cfg.balanceGain));
    gs.balance = bEq + (gs.balance - bEq) * Math.exp(-cfg.settleRate * dt);
    if (Math.abs(gs.balance) > 1) { gs.onRail = false; gs.bailed = true; gs._cool = 0.8; ps.constrained = false; return gs; }

    // leaving by jumping preserves speed and prewind
    if (inp.jumpRelease) {
      gs.onRail = false; gs.lastLeaveSpeed = gs.alongSpeed; gs._cool = 0.5;
      ps.constrained = false;   // physics' constrainedStep already took off this frame
      ps.vel[0] = c.tang[0] * gs.alongSpeed; ps.vel[2] = c.tang[1] * gs.alongSpeed;
    }
    gs.t = c.total ? c.s / c.total : gs.t;
    if (gs.t >= 0.999) { gs.onRail = false; ps.constrained = false; gs._cool = 0.5; }
    return gs;
  }

  return { config: cfg, init, step };
}
