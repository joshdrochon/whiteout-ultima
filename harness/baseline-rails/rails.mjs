// Baseline rails — validates the rail runner only. Plain; NOT a candidate.
export function createRails(env) {
  const cfg = { captureRadius_m: 1.0, dragScale: 0.35, balanceHalfLife_s: 2.2,
    curveTolerance_rad: 0.30, minLockSpeed_mps: 3, balanceGain: 1.6, driftRate: 0.55, curveGain: 26 };
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
        if (!best || d < best.d) best = { d, px, pz, py: sg.a[1], id: r.id,
          tang: [dx / (sg.L || 1e-9), dz / (sg.L || 1e-9)], s: sg.s0 + sg.L * t, total: acc };
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
          // documented lock-on snap: the ONLY position write this module makes
          ps.pos[0] = c.px; ps.pos[2] = c.pz; ps.pos[1] = c.py;
          gs.onRail = true; gs.railId = c.id; gs.balance = 0; gs.bailed = false;
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
    if (!c) { gs.onRail = false; return gs; }
    const lam = 0.25 * cfg.dragScale;                       // rail drag < snow drag
    gs.alongSpeed = gs.alongSpeed * Math.exp(-lam * dt);
    ps.vel[0] = c.tang[0] * gs.alongSpeed;
    ps.vel[2] = c.tang[1] * gs.alongSpeed;
    ps.vel[1] = 0;

    // balance: drifts on its own, corrected by steering; curvature pushes it
    const ahead = closest(ps.pos[0] + c.tang[0] * 6, ps.pos[2] + c.tang[1] * 6);
    let curv = 0;
    if (ahead) {
      const cross = c.tang[0] * ahead.tang[1] - c.tang[1] * ahead.tang[0];
      curv = Math.asin(Math.max(-1, Math.min(1, cross)));
    }
    // Stance drift is an INSTABILITY (grows with current lean), and curvature
    // loads the rider outward regardless of bend direction magnitude — a
    // favourable bend must not cancel the drift into an easier-than-straight rail.
    const drift = cfg.driftRate * (Math.abs(gs.balance) < 1e-3 ? 0.35 : Math.sign(gs.balance) * (1 + 2 * Math.abs(gs.balance)));
    const curveLoad = curv * cfg.curveGain * (gs.alongSpeed / 18);
    gs.balance += (drift + curveLoad) * dt - (inp.steer ?? 0) * cfg.balanceGain * dt;
    if (Math.abs(gs.balance) > 1) { gs.onRail = false; gs.bailed = true; gs._cool = 0.8; return gs; }

    // leaving by jumping preserves speed and prewind
    if (inp.jumpRelease) {
      gs.onRail = false; gs.lastLeaveSpeed = gs.alongSpeed; gs._cool = 0.5;
      ps.vel[0] = c.tang[0] * gs.alongSpeed; ps.vel[2] = c.tang[1] * gs.alongSpeed;
    }
    gs.t = c.total ? c.s / c.total : gs.t;
    if (gs.t >= 0.999) { gs.onRail = false; gs._cool = 0.5; }
    return gs;
  }

  return { config: cfg, init, step };
}
