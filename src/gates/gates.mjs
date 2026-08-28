// ============================================================================
// SLALOM GATES — passing through them does something.
//
// The flags have been decorative since they were drawn. This makes them score:
// ride between the posts and you get points, a chunk of boost meter, and a
// combo that grows while you keep hitting them.
//
// WHY BOOST AND NOT JUST POINTS. Points alone are a number that goes up in the
// corner; boost changes what you do next. Threading gates to stay fed with
// boost is a line you choose to ride, which is the whole point of putting them
// on the course. The reward is small per gate (a fifth of the meter) so a run
// that ignores them is still viable — this is a lane to take, not a tax.
//
// PURE MODULE, deliberately: it takes the rider's position each step and
// returns events. It touches no physics state, renders nothing, and plays no
// sound. The rig decides what an event sounds and looks like. That also means
// the whole thing is testable without a browser, which is why the crossing
// maths below can be trusted at all.
// ============================================================================

const DEFAULTS = {
  // A gate is 16 m wide (half 8). Scoring the full width would mean brushing a
  // post counts the same as splitting the middle, so the reward tapers: dead
  // centre pays full, the outer edge pays half.
  centreBonus: 0.5,
  basePoints: 250,
  // Combo grows per consecutive gate and resets on a miss. Capped so a clean
  // run does not end up dominated by gate points.
  comboStep: 0.35,
  comboMax: 3.0,
  boostPerGate: 0.20,     // fraction of the meter, before the combo multiplier
  boostMax: 0.45,         // per-gate ceiling, so a big combo cannot refill it all
};

export function createGates(env = {}) {
  const cfg = { ...DEFAULTS, ...(env.config ?? {}) };
  // Sorted by z so the crossing scan is a single forward walk.
  const gates = (env.gates ?? []).slice().sort((a, b) => a.z - b.z);

  function init() {
    return {
      next: 0,           // index of the next gate ahead
      hit: 0,
      missed: 0,
      combo: 0,
      bestCombo: 0,
      points: 0,
      lastEvent: null,   // { kind, gate, points, boost, combo, offset }
      _prevZ: null,
      _prevX: 0,
    };
  }

  // pos: [x, y, z]. Returns the state; read gs.lastEvent for what happened on
  // THIS step, which is null on the vast majority of steps.
  function step(gs, pos) {
    gs.lastEvent = null;
    const z = pos[2], x = pos[0];
    if (gs._prevZ === null) { gs._prevZ = z; gs._prevX = x; return gs; }
    const prevZ = gs._prevZ, prevX = gs._prevX;
    gs._prevZ = z; gs._prevX = x;
    // Only ever move forward through the list. Riding backwards does not
    // un-score a gate, and it must not let one be scored twice either.
    if (z <= prevZ) return gs;

    while (gs.next < gates.length && gates[gs.next].z <= z) {
      const g = gates[gs.next];
      if (g.z < prevZ) { gs.next++; continue; }   // already behind us

      // WHERE WAS THE RIDER AT THE GATE'S z, not where are they now. At 30 m/s
      // a 60 Hz step covers half a metre, so testing the end-of-step position
      // against a gate plane mis-scores anything taken at an angle. Lerp to the
      // crossing instead.
      const t = (g.z - prevZ) / Math.max(1e-9, z - prevZ);
      const crossX = prevX + (x - prevX) * t;
      gs.next++;
      const off = Math.abs(crossX - g.x);
      if (off <= g.half) {
        gs.combo = Math.min(cfg.comboMax / cfg.comboStep, gs.combo + 1);
        gs.bestCombo = Math.max(gs.bestCombo, gs.combo);
        gs.hit++;
        const mult = Math.min(cfg.comboMax, 1 + (gs.combo - 1) * cfg.comboStep);
        // taper: centre pays full, the post pays half
        const centre = 1 - (off / g.half) * cfg.centreBonus;
        const pts = Math.round(cfg.basePoints * mult * centre);
        gs.points += pts;
        gs.lastEvent = {
          kind: 'hit', gate: g.i, points: pts,
          boost: Math.min(cfg.boostMax, cfg.boostPerGate * mult),
          combo: gs.combo, offset: +off.toFixed(2),
        };
      } else {
        gs.combo = 0;
        gs.missed++;
        gs.lastEvent = { kind: 'miss', gate: g.i, points: 0, boost: 0, combo: 0,
          offset: +off.toFixed(2) };
      }
    }
    return gs;
  }

  return {
    config: { ...cfg, gateCount: gates.length },
    gates,
    init,
    step,
  };
}
