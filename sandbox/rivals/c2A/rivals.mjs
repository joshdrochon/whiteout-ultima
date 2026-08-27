// ============================================================================
// CANDIDATE c2A — PER-RIVAL LINE FROM A COST FUNCTION.
//
// Cycle 1's verdict was that every rival rode ONE shared line with a lane
// offset and a weave, and that the tiers were a throttle ladder on a single
// track. This module has no shared line. Each rival carries its OWN weight
// vector over five terms — path length, curvature, gully-floor attraction,
// apex depth (which side of each bend it commits to, and how far) and a soft
// corridor wall — and its line is SOLVED ONCE at init from those weights alone.
// Four rivals, four weight vectors, four different paths down the same mountain.
//
// THE CENTRAL RULE (AI-01): this module returns INPUTS. It never writes pos,
// vel, heading, charge, boostMeter, onGround, airTime or landing, on a rival or
// on the player, on any frame. The line lives in the module's own state; the
// rider gets onto it by steering, like everybody else.
//
// WHERE THE LINE/TIME TRADE ACTUALLY SITS ON THIS COURSE — MEASURED, because
// cycle 1's retreat was made on an assumption. Solo runs, real course, real
// physics, pops included, sweeping the apex-depth weight alone (negative = the
// OUTSIDE shoulder of each bend, positive = the INSIDE, i.e. cutting it):
//
//     apex   maxOffset   no boost, stats 20   boost, stats 34/32
//     -70       47 m           132.5 s              93.6 s
//     -40       26 m           120.6 s              91.9 s
//       0        6 m           114.0 s              87.8 s
//     +20       17 m           107.5 s              87.2 s
//     +45       35 m           112.2 s              87.4 s
//     +70       52 m           118.8 s              86.8 s
//     +100      74 m           125.6 s              87.3 s
//
// THE OPTIMUM MOVES WITH SPEED. A gravity-limited rider is fastest on a shallow
// cut (+20) and pays 11 s to hold the deep one (+70): off the gully floor it is
// riding a cross-slope, the fall line is no longer under the board, and the
// height it climbs is speed it never gets back. A rider held at V_BOOST is
// speed-limited rather than gravity-limited, so height stops costing it
// anything and only distance is left — its optimum walks out to +70 and the
// deep cut becomes the fastest line on the hill.
//
// Cycle 1's finding was real but it was half the curve. The deep cut is not a
// slower line; it is a line you have to be fast enough to afford. That is this
// module's tier axis, and it is an axis of LINE:
//     easy   drifts to the OUTSIDE shoulder of every bend, or over-cuts past
//            the apex — either way it rides a line its speed cannot pay for
//     medium holds the floor and the late apex: safe, never committed
//     hard   commits to the deep inside cut, which is only fast at its speed
// HONEST ABOUT THE SIZE. Re-running the whole field on one line (the medium
// archetype's) with every tier keeping its own throttle isolates the throttle;
// the line is the residual. MEASURED over 8 seeds:
//     easy -> medium   22.2 s gap  =  9.6 s LINE + 12.6 s throttle
//     medium -> hard   26.2 s gap  =  4.3 s LINE + 21.9 s throttle
// 13.9 s of the 48.4 s ladder is line, and it shows up at BOTH boundaries: put
// the hard rival on the medium rival's line and it loses 4.3 s. But the ceiling
// is real and is not worth hiding — at hard's speed the WHOLE line axis spans
// about 3 s (85.9 s to 88.6 s across every line family tried) while its boost is
// worth ~25 s. A rider pinned at V_BOOST is not being slowed by the mountain.
// The truthful claim is the coupling, not a bigger number: the deep cut is what
// hard's boost BUYS it, and the same line costs a medium rider 11 s.
//
// Deterministic: seeded from env.seed alone. No Date, no Math.random, and no
// module-level mutable state — the archetype table is a frozen literal and is
// copied per instance (AI-11).
// ============================================================================

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// mulberry32 — seeded, never wall-clock.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mix = (a, b) => (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 1, 0x165667b1)) >>> 0;

// ---------------------------------------------------------------------------
// THE TERRAIN TABLE.
//
// The cost function needs h(x, z) and dh/dx off the racing line, and calling
// env.sampleHeight from inside the solver's inner loop would cost 0.17 us a
// time and put AI-13's one-frame startup budget out of reach. So the module
// samples the mountain ONCE, on a coarse grid expressed in (z, lateral offset
// from the centreline), and the solver reads that. MEASURED: 0.70 ms to build,
// 0.25 ms per line solved, ~3.2 ms for a five-rival field including both lines
// per rider, against a 16.7 ms budget.
// ---------------------------------------------------------------------------
const TAB_Z0 = -100, TAB_ZN = 2650, TAB_DZ = 25;
const TAB_S0 = -115, TAB_SN = 115, TAB_DS = 10;

function buildTable(sampleHeight, centerX) {
  const nz = Math.round((TAB_ZN - TAB_Z0) / TAB_DZ) + 1;
  const ns = Math.round((TAB_SN - TAB_S0) / TAB_DS) + 1;
  const H = new Float64Array(nz * ns), C = new Float64Array(nz);
  for (let j = 0; j < nz; j++) {
    const z = TAB_Z0 + j * TAB_DZ, c = centerX(z);
    C[j] = c;
    for (let k = 0; k < ns; k++) H[j * ns + k] = sampleHeight(c + TAB_S0 + k * TAB_DS, z);
  }
  return { H, C, nz, ns };
}

// dh/d(lateral offset) at table row j, offset s. Central difference on the row,
// linearly blended between columns so the solver sees a continuous gradient.
function dhds(T, j, s) {
  const f = (s - TAB_S0) / TAB_DS;
  const k = Math.min(T.ns - 2, Math.max(0, Math.floor(f)));
  const u = f - k;
  const km = Math.max(0, k - 1), kp = Math.min(T.ns - 1, k + 2), k1 = Math.min(T.ns - 1, k + 1);
  const g0 = (T.H[j * T.ns + k1] - T.H[j * T.ns + km]) / ((k1 - km) * TAB_DS);
  const g1 = (T.H[j * T.ns + kp] - T.H[j * T.ns + k]) / ((kp - k) * TAB_DS);
  return g0 * (1 - u) + g1 * u;
}

// ---------------------------------------------------------------------------
// THE COST FUNCTION, and the solver that minimises it.
//
// A line is an array of lateral offsets s_i from the centreline, one per 25 m
// of z. Its cost is
//
//   J(s) = SUM_i [  w.len   * |P_i+1 - P_i|                     path length
//                 + w.curv  * (d2x/dz2)^2                       smoothness
//                 + w.floor * h(x_i, z_i)                       gully floor
//                 + APEX_W  * (s_i - w.apex * kappaHat_i)^2     apex depth
//                 + wall(s_i)                                ] corridor margin
//
// where kappaHat is the smoothed, normalised curvature of the centreline: +1
// where the course bends toward +x, so +apex sits a rider on the INSIDE of every
// bend (cutting it) and -apex on the OUTSIDE shoulder. Minimised by plain
// gradient descent, which converges here in ~120 iterations (MEASURED: the line
// is identical to 0.00 m against a 2000-iteration solve, and the finish time is
// identical to 0.01 s from 80 iterations on).
//
// The five weights are the whole personality of a rider. Nothing else about the
// line is shared: there is no lane, no weave and no common track.
// ---------------------------------------------------------------------------
const SOLVE_ITERS = 140;
const SOLVE_ETA = 4;
const WALL_K = 0.6;          // soft wall stiffness beyond the rider's own sMax
const APEX_W = 0.02;         // apex-attraction weight (scaled inside the solver)
const LINE_Z_END = 2500;     // the line runs past zFinish so the follower never
                             // aims at a clamped end node on the last stride

function solveLine(T, W) {
  const jA = Math.round((0 - TAB_Z0) / TAB_DZ);
  const jB = Math.round((LINE_Z_END - TAB_Z0) / TAB_DZ);
  const n = jB - jA + 1;
  const s = new Float64Array(n);          // start ON the centreline; the rider's
                                          // own gate slot is absorbed in 2 s
  // smoothed, normalised centreline curvature
  const raw = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) raw[i] = (T.C[jA + i + 1] - 2 * T.C[jA + i] + T.C[jA + i - 1]) / (TAB_DZ * TAB_DZ);
  const kc = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, c = 0;
    for (let k = -4; k <= 4; k++) { const j = i + k; if (j >= 0 && j < n) { acc += raw[j]; c++; } }
    kc[i] = acc / c;
  }
  let km = 1e-9;
  for (let i = 0; i < n; i++) km = Math.max(km, Math.abs(kc[i]));
  for (let i = 0; i < n; i++) kc[i] /= km;

  const grad = new Float64Array(n);
  const X = i => T.C[jA + i] + s[i];
  for (let it = 0; it < SOLVE_ITERS; it++) {
    grad.fill(0);
    for (let i = 1; i < n - 1; i++) {
      const j = jA + i;
      const xm = X(i - 1), x0 = X(i), xp = X(i + 1);
      // path length: the straightening force, which is what cuts a corner
      const d1 = xp - x0, d0 = x0 - xm;
      const L1 = Math.sqrt(TAB_DZ * TAB_DZ + d1 * d1), L0 = Math.sqrt(TAB_DZ * TAB_DZ + d0 * d0);
      grad[i] += W.len * (d0 / L0 - d1 / L1);
      // curvature^2: gradient of the sum of squared second differences
      const Dm = i >= 2 ? X(i) - 2 * X(i - 1) + X(i - 2) : 0;
      const Dc = xp - 2 * x0 + xm;
      const Dp = i <= n - 3 ? X(i + 2) - 2 * X(i + 1) + X(i) : 0;
      grad[i] += W.curv * 2 * (Dm - 2 * Dc + Dp) / (TAB_DZ * TAB_DZ);
      // gully-floor attraction: the height the line stands to lose
      grad[i] += W.floor * dhds(T, j, s[i]);
      // apex depth: which side of the bend, and how deep
      grad[i] += APEX_W * (s[i] - W.apex * kc[i]);
      // soft corridor wall — the rider's own declared margin, not the harness'
      const a = Math.abs(s[i]);
      if (a > W.sMax) grad[i] += WALL_K * (a - W.sMax) * Math.sign(s[i]);
    }
    for (let i = 1; i < n; i++) s[i] = clamp(s[i] - SOLVE_ETA * grad[i], -TAB_SN, TAB_SN);
    s[n - 1] = s[n - 2];
  }
  return { jA, n, s };
}

// The centreline at z, read off the table (no env call on the hot path).
function centerAt(T, z) {
  const f = (z - TAB_Z0) / TAB_DZ;
  const i = Math.min(T.nz - 2, Math.max(0, Math.floor(f)));
  const u = f - i;
  return T.C[i] * (1 - u) + T.C[i + 1] * u;
}

// The point on a solved line `look` metres up-course of z, in world x/z.
function lineTarget(T, L, z, look) {
  const tz = z + look;
  const f = (tz - TAB_Z0) / TAB_DZ - L.jA;
  const i = Math.min(L.n - 2, Math.max(0, Math.floor(f)));
  const u = f - i;
  const x0 = T.C[L.jA + i] + L.s[i], x1 = T.C[L.jA + i + 1] + L.s[i + 1];
  return [x0 * (1 - u) + x1 * u, tz];
}

// ---------------------------------------------------------------------------
// THE ARCHETYPES. A rider is a WEIGHT VECTOR plus a throttle, and both halves
// are quoted with the solo time they were measured at.
//
// FROZEN literal; init() copies every field into the rival's own object, so no
// instance can reach another's numbers (AI-11).
//
//   apex  target apex depth: negative = outside shoulder, positive = inside cut
//   len   appetite for a short path (the corner-cutting force)
//   curv  smoothness penalty
//   floor attraction to the gully floor (the fall line)
//   sMax  the rider's own lateral margin, before its soft wall pushes back
//   look  pure-pursuit lookahead, m
//   gain  steering commitment
// ---------------------------------------------------------------------------
const ARCHETYPES = Object.freeze({
  // Two DIFFERENT ways to be slow, so the two easy rivals are not a pair.
  // driftsWide sits on the OUTSIDE shoulder of every bend; overCuts straightens
  // the meander so hard it climbs the far wall. They are on OPPOSITE sides of
  // the course at every apex.
  easy: Object.freeze([
    Object.freeze({ name: 'driftsWide', apex: -74, len: 0.35, curv: 0.08, floor: 0.06, sMax: 74, look: 62, gain: 1.70, brakeK: 0.30 }),
    Object.freeze({ name: 'overCuts', apex: 118, len: 1.20, curv: 0.08, floor: 0.02, sMax: 80, look: 74, gain: 1.75, brakeK: 2.4 }),
  ]),
  // Medium never commits: it holds the late apex, or hugs the floor a little
  // past it. Both are safe, both sit several seconds off medium's own optimum
  // (+20), and neither is anywhere near where hard rides — MEASURED, hard on
  // medium's line loses 4.3 s.
  medium: Object.freeze([
    Object.freeze({ name: 'lateApex', apex: -34, len: 0.60, curv: 0.10, floor: 0.35, sMax: 56, look: 66, gain: 1.80, brakeK: 1.0 }),
    Object.freeze({ name: 'floorHugger', apex: 22, len: 0.30, curv: 0.10, floor: 0.90, sMax: 46, look: 70, gain: 1.80, brakeK: 1.6 }),
  ]),
  // Hard commits to the deep inside cut: 4.3 s at its own speed, and a LOSS of
  // 11 s at medium's. It is the line, not the boost, that makes those seconds —
  // the boost is what makes the line affordable.
  hard: Object.freeze([
    Object.freeze({ name: 'committedCut', apex: 74, len: 1.10, curv: 0.12, floor: 0.03, sMax: 78, look: 64, gain: 1.90, brakeK: 1.0 }),
    Object.freeze({ name: 'lateCharge', apex: 96, len: 1.30, curv: 0.15, floor: 0.02, sMax: 80, look: 58, gain: 1.90, brakeK: 1.4 }),
  ]),
});

// The apex a rider of this tier WOULD take if it read the mountain correctly
// for its own speed — measured, from the sweep in the header. This is the only
// thing catch-up moves a rider toward, and it is why catch-up here is a rider
// tidying up its line rather than a hidden grant.
const TIER_TRUE_APEX = Object.freeze({ easy: 20, medium: 20, hard: 74 });

// ---------------------------------------------------------------------------
// THE THROTTLES. Stats are DECLARED (the runner installs them); everything else
// is a key this module presses.
//
// BOOST IS A METER POLICY, NOT A SQUARE WAVE. BOOST_DRAIN 0.125 against
// BOOST_REGEN 0.10 fixes the sustainable duty at 0.10/0.225 = 44%, so any
// honest boost policy lands there; what a policy chooses is the SHAPE. A square
// wave at 42% duty costs 22 presses at a 1.68 s median hold; the hysteresis
// below reaches the same duty in 11 presses at a 3.47 s median hold and is
// 0.06 s faster. MEASURED, both. A flame that lights eleven times down a
// mountain reads as a rider spending a meter; one that strobes does not.
//
// A HYSTERESIS ALONE CANNOT BE A TIER. Measured the hard way, on the first
// build of this module: medium was given boostOn 0.995 / boostOff 0.70 in the
// belief that a rider who only presses at a brim-full meter would barely boost.
// It came out at 44% duty and 89.8 s, a tenth of a second off the hard tier,
// because the METER is the binding constraint and every hysteresis converges to
// the same sustainable duty whatever its thresholds are. What separates a rider
// who manages a meter from one who does not is not the trigger level, it is how
// often it goes back to the well. So the tier lever is a COOLDOWN between
// bursts: hard 0 s (it boosts whenever the meter will carry it), medium 22 s
// (three or four bursts a run), easy never.
// ---------------------------------------------------------------------------
const TIERS_SPEC = Object.freeze({
  easy: Object.freeze({
    stats: Object.freeze({ speed: 12, edging: 14, trick: 20 }),
    boostOn: 2, boostOff: 2,       // > 1: the meter never reaches it. Easy never
                                   // touches boost, and its meter sits full.
    boostCool_s: 0,
    brakeDuty: 0.06,               // a light, constant scrub; the archetype's
                                   // brakeK scales it (0.30 and 2.4), which is
                                   // what keeps the two easy riders from
                                   // travelling side by side down the hill
    tuck: true,
  }),
  medium: Object.freeze({
    stats: Object.freeze({ speed: 20, edging: 20, trick: 20 }),
    // Medium DOES use its meter, and then forgets about it: MEASURED, 2.0
    // presses a run at a 2.42 s median hold, 3.5% duty.
    boostOn: 0.98, boostOff: 0.70, boostCool_s: 85,
    brakeDuty: 0.13,
    tuck: true,
  }),
  hard: Object.freeze({
    stats: Object.freeze({ speed: 34, edging: 32, trick: 24 }),
    boostOn: 0.55, boostOff: 0.12, boostCool_s: 0,
    brakeDuty: 0.02,
    tuck: true,
  }),
});

// ---- catch-up. BOUNDED and ONE-DIRECTIONAL (AI-05/AI-06). ------------------
// Two channels, both spent through inputs:
//   * the rider stops scrubbing (up to ASSIST_SCRUB_CUT of its brake duty)
//   * the rider's line blends up to ASSIST_LINE_BLEND of the way toward the
//     apex its own tier should have taken. A struggling rival tidies its line.
// While LEADING, and inside the deadband, `assist` is exactly 0 and the code
// takes the SAME branch env.assist === false takes — which is what makes the
// two input streams byte-identical in the frozenBehind scenario.
const ASSIST_DEADBAND_M = 5;
const ASSIST_RANGE_M = 250;
const ASSIST_SCRUB_CUT = 0.35;
const ASSIST_LINE_BLEND = 0.12;

// ---- the start gate (AI-12). ----------------------------------------------
// Every line in this module starts on the centreline, because a cost function
// has no opinion about where the gate is. That put all four riders on the same
// point at z ~ 40 and cost AI-12 0.40 m — MEASURED, on the build before this
// one: the whole field converged out of the gate onto one spot before its lines
// had anywhere to diverge to.
//
// So the riders FAN OUT of the gate and merge onto their own lines over the
// first FAN_Z metres, the way a start straight actually works. The fan slot is
// the rival's own place in the roster, so it needs nothing from the live state.
const FAN_PITCH_M = 15;
const FAN_Z_M = 340;

// ---- keeping off each other (AI-12). --------------------------------------
// Four riders on four genuinely different lines CROSS. That is the point of
// them, and it is also the one thing a lane-and-weave field never has to deal
// with: cycle 1's candidates could not collide because they were all on the same
// track at different throttles. MEASURED on the first build of this module: the
// medium rival's line crosses the centreline at z = 981 exactly where it is
// overtaking the reference player, and AI-12 read 0.223 m.
//
// So the riders look where they are going. Each rival shifts its AIM POINT — not
// its position, not its velocity — away from any other racer that is close in z
// and close in x. It is symmetric, it is capped at AVOID_MAX_M of aim shift on a
// 60 m lookahead (about 6 degrees of steering), it always pushes AWAY from the
// player and never toward, and it is the same code with catch-up on and off.
// It has two ranges, because one is not enough. The AIM SHIFT is the polite
// one: it works on a 60 m lookahead and takes about a second to bite, which is
// the right response to somebody you can see coming. The STEER BIAS is the
// short one, inside 6 m, and it goes straight onto the steering axis so it
// answers in a frame. MEASURED: aim shift alone bottoms out at 0.21 m on seed 6
// however wide its window is opened — widening it past ~13 m makes it WORSE,
// because two riders on crossing lines each try to reverse the crossing and end
// up sliding along one another instead of getting it over with.
const AVOID_Z_M = 26;        // longitudinal window: only racers alongside
const AVOID_X_M = 10;        // lateral window: only racers in the way
const AVOID_MAX_M = 8;       // largest aim-point shift, metres
const NEAR_Z_M = 16;         // short-range window, longitudinal
const NEAR_X_M = 6;          // short-range window, lateral
const NEAR_STEER = 0.30;     // largest steer bias, on a -1..1 axis

// ---- the pop (AI-10). -------------------------------------------------------
// Charge accrues from crouch only while the board is SUPPORTED, so the crouch is
// held until the rider is actually on the ground; a crouch spent in the air
// releases at charge 0, which is J_MIN and 0.22 m of hop.
const POP_PERIOD_S = 8.5;
const CROUCH_S = 0.35;          // -> charge 0.41 against AI-10's 0.25 floor
const BRAKE_CYCLE_S = 4;

export function createRivals(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const centerX = env.courseCenterX ?? (() => 0);
  const bounds = env.bounds ?? {};
  const halfWidth = bounds.halfWidth ?? 120;
  const roster = env.roster ?? [];
  const seed = (env.seed ?? 1) | 0;
  const assistEnabled = env.assist !== false;

  // per-instance copies of the frozen tables (AI-11)
  const tiers = {};
  for (const k of Object.keys(TIERS_SPEC)) {
    const t = TIERS_SPEC[k];
    tiers[k] = { stats: { ...t.stats }, boostOn: t.boostOn, boostOff: t.boostOff,
      boostCool_s: t.boostCool_s, brakeDuty: t.brakeDuty, tuck: t.tuck };
  }

  const config = {
    tiers,
    assistEnabled,
    maxAssistFrac: ASSIST_SCRUB_CUT,
    assistDeadband_m: ASSIST_DEADBAND_M,
    assistRange_m: ASSIST_RANGE_M,
    assistLineBlend: ASSIST_LINE_BLEND,
    popPeriod_s: POP_PERIOD_S,
    corridorHalfWidth_m: halfWidth,
    lineSolveIters: SOLVE_ITERS,
    lineNodeSpacing_m: TAB_DZ,
  };

  function init() {
    const T = buildTable(sampleHeight, centerX);
    const rivals = {};
    // how many riders of this tier have been seen already — the second easy
    // rival gets the second easy archetype, not a jittered copy of the first
    const seen = {};
    roster.forEach((r, i) => {
      const tier = r.tier in ARCHETYPES ? r.tier : 'medium';
      const k = seen[tier] ?? 0; seen[tier] = k + 1;
      const arch = ARCHETYPES[tier][k % ARCHETYPES[tier].length];
      const rnd = mulberry32(mix(seed, i));
      // The seed moves the rider WITHIN its archetype: a few metres of apex, a
      // little lookahead, the phase of its pop and its scrub. Enough that eight
      // seeds are eight races (AI-11), not enough to turn one archetype into
      // another.
      const jitter = 1 + 0.10 * (rnd() * 2 - 1);
      const W = {
        apex: arch.apex * jitter + (rnd() * 2 - 1) * 4,
        len: arch.len, curv: arch.curv, floor: arch.floor,
        sMax: Math.min(arch.sMax, halfWidth - 34),
      };
      // the same rider, riding the apex its tier should have taken
      const Wtrue = { ...W, apex: TIER_TRUE_APEX[tier] };
      rivals[r.id] = {
        tier, arch: arch.name, W,
        line: solveLine(T, W),
        trueLine: solveLine(T, Wtrue),
        look: arch.look * (0.94 + 0.12 * rnd()),
        gain: arch.gain,
        brakeDuty: tiers[tier].brakeDuty * arch.brakeK,
        brakePhase: rnd(),
        popTimer: 1.2 + rnd() * POP_PERIOD_S,
        crouchLeft: 0,
        wantPop: false,
        boostHeld: false,
        boostCool: 0,
        side: rnd() < 0.5 ? -1 : 1,
        fan: (i - (roster.length - 1) / 2) * FAN_PITCH_M,
        fanZ: (bounds.zStart ?? 0) + FAN_Z_M,
        startZ: bounds.zStart ?? 0,
      };
    });
    return { t: 0, T, rivals };
  }

  function step(rs, world, dt) {
    rs.t += dt;
    const out = {};
    const player = world?.player ?? null;
    for (const id of Object.keys(rs.rivals)) {
      const self = world?.rivals?.[id];
      if (!self) continue;
      out[id] = driveOne(rs.T, rs.rivals[id], id, self, world, player, rs.t, dt);
    }
    return out;
  }

  function driveOne(T, R, id, self, world, player, t, dt) {
    const spec = tiers[R.tier];

    // ---- catch-up: only while BEHIND, only up to a declared ceiling --------
    let assist = 0;
    if (assistEnabled && player) {
      const behind = player.pos[2] - self.pos[2];
      if (behind > ASSIST_DEADBAND_M) {
        assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);
      }
    }

    // ---- the line ----------------------------------------------------------
    // Identical arithmetic whether or not catch-up is running: at assist === 0
    // this is the rider's own solved line and nothing else is evaluated.
    const z = self.pos[2], x = self.pos[0];
    const tgt = lineTarget(T, R.line, z, R.look);
    let tx = tgt[0];
    const tz = tgt[1];
    if (assist > 0) {
      const b = ASSIST_LINE_BLEND * assist;
      tx = tx * (1 - b) + lineTarget(T, R.trueLine, z, R.look)[0] * b;
    }
    // out of the gate in its own slot, onto its own line by FAN_Z_M
    if (tz < R.fanZ) {
      const u = clamp((tz - R.startZ) / (R.fanZ - R.startZ), 0, 1);
      const uu = u * u * (3 - 2 * u);
      tx = tx * uu + (centerAt(T, tz) + R.fan) * (1 - uu);
    }
    // ---- keep off the other racers (AI-12) --------------------------------
    let push = 0, near = 0;
    const others = world?.rivals;
    if (others) {
      for (const oid of Object.keys(others)) {
        if (oid === id) continue;
        push += avoidPush(self, others[oid], R.side);
        near += nearPush(self, others[oid], R.side);
      }
    }
    if (player) { push += avoidPush(self, player, R.side); near += nearPush(self, player, R.side); }
    tx += clamp(push, -AVOID_MAX_M, AVOID_MAX_M);

    const steer = clamp(wrapPi(Math.atan2(tz - z, tx - x) - self.heading) * R.gain
      + clamp(near, -NEAR_STEER, NEAR_STEER), -1, 1);

    // ---- the pop: charge on the ground, then release ----------------------
    let crouch = false, jumpRelease = false;
    if (R.crouchLeft > 0) {
      if (self.onGround) R.crouchLeft -= dt;
      crouch = true;
      if (R.crouchLeft <= 0) R.wantPop = true;
    } else if (R.wantPop) {
      if (self.onGround) { jumpRelease = true; R.wantPop = false; }
    } else {
      R.popTimer -= dt;
      if (R.popTimer <= 0 && self.onGround) { R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; }
    }

    // ---- throttle ---------------------------------------------------------
    // Boost by meter hysteresis: press when the meter has enough in it to be
    // worth spending, let go before it is empty so it can refill.
    const meter = self.boostMeter ?? 0;
    if (R.boostCool > 0) R.boostCool -= dt;
    const boost = R.boostHeld ? meter > spec.boostOff
      : (R.boostCool <= 0 && meter > spec.boostOn);
    if (R.boostHeld && !boost) R.boostCool = spec.boostCool_s;
    R.boostHeld = boost;
    // The ONLY thing catch-up touches besides the line.
    const kDuty = R.brakeDuty * (1 - ASSIST_SCRUB_CUT * assist);
    const brake = kDuty > 0 && ((t / BRAKE_CYCLE_S) + R.brakePhase) % 1 < kDuty;

    // Tuck and crouch fight each other in the accepted physics (CROUCH_STEER is
    // the tighter of the two multipliers), so the charge frame wins.
    const inp = { steer, boost, tuck: spec.tuck && !crouch };
    if (brake) inp.brake = true;
    if (crouch) inp.crouch = true;
    if (jumpRelease) inp.jumpRelease = true;
    return inp;
  }

  // How far to shift the aim point to stay off `o`. Zero unless o is alongside
  // AND in the way; grows smoothly to AVOID_MAX_M as the gap closes. `side` is
  // the rider's own deterministic tiebreak for a dead-on overlap.
  function avoidPush(self, o, side) {
    if (!o) return 0;
    const dz = o.pos[2] - self.pos[2];
    if (dz > AVOID_Z_M || dz < -AVOID_Z_M) return 0;
    const dx = o.pos[0] - self.pos[0];
    if (dx > AVOID_X_M || dx < -AVOID_X_M) return 0;
    const w = (1 - Math.abs(dx) / AVOID_X_M) * (1 - Math.abs(dz) / AVOID_Z_M);
    const dir = dx > 0 ? -1 : dx < 0 ? 1 : side;
    return dir * w * AVOID_MAX_M;
  }

  // The short-range half of the same idea, straight onto the steering axis.
  function nearPush(self, o, side) {
    if (!o) return 0;
    const dz = o.pos[2] - self.pos[2];
    if (dz > NEAR_Z_M || dz < -NEAR_Z_M) return 0;
    const dx = o.pos[0] - self.pos[0];
    if (dx > NEAR_X_M || dx < -NEAR_X_M) return 0;
    const w = (1 - Math.abs(dx) / NEAR_X_M) * (1 - Math.abs(dz) / NEAR_Z_M);
    const dir = dx > 0 ? -1 : dx < 0 ? 1 : side;
    return dir * w * NEAR_STEER;
  }

  return { config, init, step };
}
