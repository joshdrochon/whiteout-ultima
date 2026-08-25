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
          bestTrick: rs._best ? rs._best.name : null, tricky: !!ts.tricky,
          landed: ts.awards.length, crashed: rs._crashes };
      }
    }
    // confinement: soft velocity push back toward the corridor (no teleports)
    const cx = env.courseCenterX(ps.pos[2]);
    const dx = ps.pos[0] - cx;
    let oob = false;
    if (Math.abs(dx) > cfg.halfWidth) {
      oob = true;
      const push = -Math.sign(dx) * cfg.pushAccel * dt;
      ps.vel[0] += push;
      // hard stop at 1.25x the wall so nothing can escape at speed
      const hard = cfg.halfWidth * 1.25;
      if (Math.abs(dx) > hard) { ps.pos[0] = cx + Math.sign(dx) * hard; ps.vel[0] *= 0.3; }
    }
    if (ps.pos[2] > cfg.zFinish + 150) {
      oob = true; ps.pos[2] = cfg.zFinish + 150; ps.vel[2] = Math.min(ps.vel[2], 0);
    }
    if (ps.pos[2] < cfg.zStart - 60) { oob = true; ps.vel[2] += cfg.pushAccel * dt; }
    rs.outOfBounds = oob;
    return rs;
  }
  function results(rs) { return rs.results; }
  function restart(rs) { Object.assign(rs, init()); return rs; }
  return { config: cfg, init, step, results, restart };
}
