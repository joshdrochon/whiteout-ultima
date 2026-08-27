// Baseline run structure — validates the run runner only. Plain; NOT a candidate.
export function createRun(env) {
  const B = env.bounds;
  const cfg = { zStart: B.zStart, zFinish: B.zFinish, halfWidth: B.halfWidth,
    maxDivergence_m: 4, pushAccel: 26, holdGrace_s: 0.5 };
  function init() {
    return { phase: 'ready', time_s: 0, finished: false, place: 1, results: null,
      outOfBounds: false, _score: 0, _best: null, _crashes: 0, _landed: 0 };
  }
  function step(rs, ps, ts, dt) {
    if (rs.phase === 'ready') {
      if (ps.pos[2] >= cfg.zStart) { rs.phase = 'running'; }
      else { ps.vel[0] = 0; ps.vel[2] = 0; }        // gate holds the rider
    }
    if (rs.phase === 'running') {
      rs.time_s += dt;
      if (ps.pos[2] >= cfg.zFinish) {
        rs.phase = 'finished'; rs.finished = true;
        rs._score = ts.score; rs._best = ts.awards.length ? ts.awards[ts.awards.length - 1] : null;
        rs.results = { time_s: +rs.time_s.toFixed(2), score: ts.score,
          bestTrick: rs._best ? rs._best.name : null, ultima: !!ts.ultima,
          landed: ts.awards.length, crashed: rs._crashes };
      }
    }
    // confinement: soft velocity push back toward the corridor (no teleports)
    const cx = env.courseCenterX(ps.pos[2]);
    const dx = ps.pos[0] - cx;
    let oob = false;
    if (Math.abs(dx) > cfg.halfWidth) {
      oob = true;
      // VELOCITY ONLY — the module never writes physics position. Strength grows
      // with how far out you are, so a deep excursion is pulled back hard without
      // ever being snapped (a positional clamp here teleported the rider 250 m in
      // one frame and failed RS-06, correctly).
      const over = Math.abs(dx) - cfg.halfWidth;
      const strength = cfg.pushAccel * (1 + Math.min(6, over / 40));
      ps.vel[0] += -Math.sign(dx) * strength * dt;
      if (Math.sign(ps.vel[0]) === Math.sign(dx)) ps.vel[0] *= Math.exp(-3.5 * dt);   // damp outward drift
    }
    if (ps.pos[2] > cfg.zFinish + 150) {
      oob = true;                                   // run-out: velocity only, no snap
      const overZ = ps.pos[2] - (cfg.zFinish + 150);
      ps.vel[2] -= cfg.pushAccel * (1 + Math.min(6, overZ / 40)) * dt;
      if (ps.vel[2] > 0) ps.vel[2] *= Math.exp(-3.5 * dt);
    }
    if (ps.pos[2] < cfg.zStart - 60) { oob = true; ps.vel[2] += cfg.pushAccel * dt; }
    rs.outOfBounds = oob;
    return rs;
  }
  function results(rs) { return rs.results; }
  function restart(rs) { Object.assign(rs, init()); return rs; }
  return { config: cfg, init, step, results, restart };
}
