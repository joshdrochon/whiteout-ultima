// Candidate B — rail grinding (SSX Tricky "just land on a rail")
//
// SHAPE (seed: arclength state + inverted-pendulum balance)
//   On lock the rider becomes a 1-D system: (s, ds/dt) along the rail's
//   arclength. That 1-D system is integrated in CLOSED FORM every tick; the
//   polyline is read only to place the rider at lock, to get the tangent we
//   hand physics as velocity, and to read signed curvature at s. Nothing about
//   the grind is re-derived from physics' position, so physics' Euler position
//   step can never contaminate the module's own state (GR-09).
//
// DIVISION OF LABOUR (CONTRACTS.md "CONSTRAINED STATE")
//   We write VELOCITY and set physState.constrained for the WHOLE lock.
//   Physics integrates position, turns the board onto the velocity, accrues
//   crouch charge, holds airTime at 0, and performs the true takeoff on
//   jumpRelease. We keep no private charge counter and never write charge,
//   airTime, _popDone, heading, or trick state. The single position write is
//   the documented lock-on snap.
//
// BALANCE — inverted pendulum + capture point (second order, by construction)
//   Lean theta about the rail line, point mass at CoM height L:
//       theta'' = (G/L) * theta  -  A_S * steer  -  F_curve
//   G is the magnitude of the effective gravity in the rail frame. The reported
//   `balance` is NOT theta: it is the CAPTURE POINT (divergent component of
//   motion) xi = theta + theta_dot/omega, normalised by the largest capture
//   point the rider's weight shift can still arrest, xi_max = u_max / L.
//   That is the standard capturability criterion for a linear inverted
//   pendulum, and it is what makes this second order in the way the mechanic
//   needs: a fast lean rate is a bail even at zero lean angle, so there is
//   overshoot to feel and a wrong correction can throw you.
//   Because xi carries theta_dot, a player (or probe) steering proportionally
//   to `balance` is closing a PD loop on the lean without knowing it: with
//   steer = k*balance the closed loop is theta'' + k*omega*theta_dot +
//   (k-1)*omega^2*theta = 0 — stable for k > 1, critically shaped at k = 3
//   (roots -omega, -2*omega). Nothing is tuned to make that happen; it falls
//   out of the choice of state.
//
// EVERY CONSTANT: derived, cited, or labelled CHOICE — see config.derivation.
// Pure math, deterministic, no imports, no Date/random.
//
// GR-10 FAILS AND THE FIX IS NOT IN THIS FILE — measured, not asserted.
//   GR-10 wants air rotation to survive a grind and its exit, citing the rail
//   spin ("keep on pressing that to do rail spins", research 02 §1.5). Under the
//   CONSTRAINED contract nothing rotates the rider on a rail:
//     * physics' constrainedStep has no rotation block at all, so spinDeg stays
//       0 for the whole grind — traced: 180 frames of spin=1 held on the rail,
//       spinDeg 0.00 throughout, so the probe's `before` is 0;
//     * its jumpRelease path calls takeoff(), which ZEROES spinDeg/flipDeg, so
//       `after` is 0 as well. Measured spinPreservedFrac = 0.
//   No legal module can move that number: writing spinDeg is writing trick
//   state, and the only other lever — dropping `constrained` so airStep rotates
//   the rider — is the exact regression the contract's CONSTRAINED STATE section
//   was written to end (no crouch charge on a rail, J_MIN 2.1 m/s pops, a board
//   frozen at its pre-lock yaw, and a rider sinking G_AIR*dt^2 per frame).
//   PROOF that the gate is right and the core is where it must change: with an
//   8-line patch to constrainedStep in a scratch COPY of src/physics/physics.mjs
//   — run airStep's rotation block while constrained, and carry spinDeg/flipDeg
//   across the takeoff() in the jumpRelease branch — THIS FILE, unchanged,
//   scores 815 deg of rail spin and spinPreservedFrac = 1.0045. Handed to the
//   physics owner; not worked around here.

// ---------------------------------------------------------------------------
// Constants adopted from the ACCEPTED physics core (src/physics/physics.mjs).
// Cited, not re-picked: the rail must live in the same world as the snow.
const G_GROUND = 9.81;        // physics DEFAULTS.G_GROUND
const MU_BASE = 0.0305;       // physics DEFAULTS.MU_BASE   (snow Coulomb)
const LAMBDA_LONG = 0.2235;   // physics DEFAULTS.LAMBDA_LONG (snow linear drag)
const V_CAP = 33;             // physics DEFAULTS.V_CAP
const V_BOOST = 31;           // physics DEFAULTS.V_BOOST
const TAU_BOOST = 0.7;        // physics DEFAULTS.TAU_BOOST
const RAIL_YAW_LAMBDA = 9.0;  // physics DEFAULTS.RAIL_YAW_LAMBDA (board->tangent)
const CROUCH_STEER = 0.45;    // physics DEFAULTS.CROUCH_STEER ("you cannot turn
                              // while crouching" — Tricky PRO config, research 02 §1.1)

// Rider/board geometry (project convention: rider 1.8 m / 80 kg).
const RIDER_H = 1.8;
const COM_FRAC = 0.55;                 // standing CoM height fraction (anthropometry)
const L_COM = RIDER_H * COM_FRAC;      // 0.99 m — pendulum length about the rail
const BOARD_LEN = 1.55;                // m, freestyle board for a 1.8 m rider
const BOARD_HALF_W = 0.125;            // m, 250 mm waist -> +/-0.125 m foot shift

// Air-drag share of the snow linear-drag coefficient. Aerodynamic decel
//   a_air(v) = 0.5*rho*CdA*v^2/m, rho = 1.2, CdA = 0.5 m^2 (upright rider),
//   m = 80 -> a_air(v) = 0.00375 v^2; at the 18 m/s reference speed that is
//   1.215 m/s^2, i.e. an equivalent linear coefficient 1.215/18 = 0.0675 /s.
// A grind removes the snow-deformation (plough + edge scrub) share and leaves
// the air share: DRAG_SCALE = 0.0675 / LAMBDA_LONG = 0.302.
const V_DRAG_REF = 18;                 // m/s, research 02 §1.6 base cruise
const A_AIR_COEF = 0.5 * 1.2 * 0.5 / 80;              // 0.00375 /m
const DRAG_SCALE = (A_AIR_COEF * V_DRAG_REF) / LAMBDA_LONG;  // 0.3020...

// Seed lean at lock. A board sits on a round rail canted by its own BASE BEVEL
// — standard tune is 0.5-1 deg — so the rider never arrives exactly plumb.
// This is the whole reason an uncorrected grind ends. Measured passive life on
// a 0.2 m rail: 1.05 s (GR-05's window is a declared 0.8-6 s). Widening the rail
// only ever helps — 0.2/0.5/1.0/1.6 m give 1.05/1.20/1.37/1.50 s — because the
// seed is a fixed physical cant and the bail envelope grows with u_max.
const SEED_LEAN = 0.5 * Math.PI / 180; // rad

// CHOICE: minimum speed to hook a rail, 3.0 m/s (~11 km/h). Cost: below this a
// rider drifting into a rail keeps riding past it instead of snapping on. Lower
// looks like a bug (the board welds itself to rails at walking pace); much
// higher eats legitimate slow technical grinds. Not derived — declared.
const MIN_LOCK_SPEED = 3.0;

// CHOICE: capture radius 1.0 m. Research 02 §1.5 [EST] gives 0.5-1.0 board
// length (~0.5-1.5 m); one board length is 1.55 m and the gate band is
// [0.5, 1.5], so 1.0 m is the middle of the sourced band, ~0.65 board lengths.
// Cost: larger reads as magnetic, smaller makes rails feel missable.
const CAPTURE_R = 1.0;

// CHOICE: bail lockout 1.0 s. Derived floor: falling the 0.3 m from a rail to
// the snow at physics' G_AIR (6.5) takes sqrt(2*0.3/6.5) = 0.30 s, so anything
// under that re-captures the rider mid-fall and produces the pogo a previous
// candidate shipped (eight captures in 4.4 s). The remaining 0.7 s is the
// rider getting their feet back; cost: a bail is unrecoverable for a beat.
const BAIL_LOCKOUT = 1.0;
// After a bail the rider must also CLEAR the rail before that rail will take
// them again (2x capture radius). Without it a bail on a straight rail is a
// pogo stick: the rider falls 0.3 m, is still under the line, and re-hooks.
const REARM_R = 2 * CAPTURE_R;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exact solution of dv/dt = a - b*v on [0, dt] with v >= 0, plus the exact
// integral of v over the same window. Linear ODE => split-step exact (GR-09).
function flow(v0, a, b, dt) {
  if (b <= 1e-12) {
    const v = Math.max(0, v0 + a * dt);
    return { v, ds: 0.5 * (v0 + v) * dt };
  }
  const veq = a / b;
  const e = Math.exp(-b * dt);
  let v = veq + (v0 - veq) * e;
  let ds = veq * dt + (v0 - veq) * (1 - e) / b;
  if (a <= 0 && v < 0) {            // Coulomb stop: monotone path, clamp at 0
    const tStop = Math.log(1 - v0 / veq) / b;   // v(tStop) = 0, veq < 0
    ds = veq * tStop + (v0 - veq) * (1 - Math.exp(-b * tStop)) / b;
    v = 0;
  }
  return { v, ds };
}

// ---------------------------------------------------------------------------
// Polyline geometry, precomputed once.
//
// The contract calls `points` SPLINE CONTROL POINTS, so the tangent field must
// be the smooth curve's, not the chords'. Using chord directions costs a real
// measurement: on the runner's 24-segment 80 deg arc each chord sits half a
// segment-turn (1.67 deg) off the true tangent, so a rider arriving dead
// straight is handed 18*sin(1.67 deg) = 0.52 m/s of fake cross-rail velocity at
// lock — measured balance -0.65 before the grind had started, and the arc then
// "dropped sooner" because of capture misalignment, which is precisely the way
// GR-06's own statement says candidates used to pass it. Vertex tangents are the
// chord bisectors (exact for a circular arc), extrapolated at the open ends, and
// interpolated along each segment.
const leftN = T => { const h = Math.hypot(T[0], T[2]) || 1; return [T[2] / h, 0, -T[0] / h]; };
const norm3 = v => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };

function buildRail(rail) {
  const P = rail.points;
  const segs = [];
  let cum = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], dz = P[i + 1][2] - P[i][2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) continue;
    segs.push({ p: P[i], C: [dx / len, dy / len, dz / len], len, s0: cum });
    cum += len;
  }
  const n = segs.length;
  if (n === 0) return { id: rail.id, width: rail.width ?? 0.2, segs, len: 0 };
  const Tv = new Array(n + 1);
  for (let i = 1; i < n; i++)
    Tv[i] = norm3([segs[i - 1].C[0] + segs[i].C[0], segs[i - 1].C[1] + segs[i].C[1],
                   segs[i - 1].C[2] + segs[i].C[2]]);
  // ends: reflect the interior tangent through the chord (exact for an arc)
  Tv[0] = n > 1 ? norm3([2 * segs[0].C[0] - Tv[1][0], 2 * segs[0].C[1] - Tv[1][1], 2 * segs[0].C[2] - Tv[1][2]])
                : segs[0].C;
  Tv[n] = n > 1 ? norm3([2 * segs[n - 1].C[0] - Tv[n - 1][0], 2 * segs[n - 1].C[1] - Tv[n - 1][1],
                         2 * segs[n - 1].C[2] - Tv[n - 1][2]]) : segs[0].C;
  // signed curvature per segment: k = (dT/ds) . N, positive = turns toward +N.
  // Held constant across a segment, so a uniformly sampled arc reports its true
  // radius everywhere INCLUDING its first segment — a vertex-difference scheme
  // reports 0 at the open ends, which would let a rider enter a bend on a
  // curvature step of zero and mask exactly what GR-06 is measuring.
  for (let i = 0; i < n; i++) {
    const N = leftN(segs[i].C);
    segs[i].Ta = Tv[i]; segs[i].Tb = Tv[i + 1];
    segs[i].k = ((Tv[i + 1][0] - Tv[i][0]) * N[0] + (Tv[i + 1][2] - Tv[i][2]) * N[2]) / segs[i].len;
  }
  return { id: rail.id, width: rail.width ?? 0.2, segs, len: cum };
}

// closest point on the polyline to q, in 3D
function closest(R, q) {
  let best = null;
  for (const sg of R.segs) {
    const wx = q[0] - sg.p[0], wy = q[1] - sg.p[1], wz = q[2] - sg.p[2];
    const proj = clamp(wx * sg.C[0] + wy * sg.C[1] + wz * sg.C[2], 0, sg.len);
    const cx = sg.p[0] + sg.C[0] * proj, cy = sg.p[1] + sg.C[1] * proj, cz = sg.p[2] + sg.C[2] * proj;
    const d = Math.hypot(q[0] - cx, q[1] - cy, q[2] - cz);
    if (!best || d < best.d) best = { d, s: sg.s0 + proj, pos: [cx, cy, cz] };
  }
  return best;
}

// frame (smooth tangent, left normal, signed curvature) at arclength s
function frameAt(R, s) {
  s = clamp(s, 0, R.len);
  let sg = R.segs[R.segs.length - 1];
  for (const c of R.segs) if (s <= c.s0 + c.len) { sg = c; break; }
  const u = sg.len > 1e-9 ? clamp((s - sg.s0) / sg.len, 0, 1) : 0;
  const T = norm3([sg.Ta[0] + (sg.Tb[0] - sg.Ta[0]) * u,
                   sg.Ta[1] + (sg.Tb[1] - sg.Ta[1]) * u,
                   sg.Ta[2] + (sg.Tb[2] - sg.Ta[2]) * u]);
  return { T, N: leftN(T), k: sg.k };
}

export function createRails(env = {}) {
  const rails = (env.rails ?? []).map(buildRail);

  // --- derived rail-drag law -------------------------------------------------
  // Research 02 §1.5: "You go faster boosting on a rail than boosting on the
  // snow"; §5: "drag ~= 0 (rail faster than snow)". Implemented as the SAME
  // two-term snow law scaled by DRAG_SCALE (the air share), so the rail is
  // strictly faster than snow at every speed without inventing a second model.
  const F0_RAIL = MU_BASE * G_GROUND * DRAG_SCALE;   // m/s^2 Coulomb on the rail
  const LAM_RAIL = LAMBDA_LONG * DRAG_SCALE;         // 1/s linear on the rail
  // Boost target on a rail is NOT re-picked: the boost thrust is whatever the
  // snow needs to hold V_BOOST, and the same thrust against rail drag reaches
  //   v = (thrust - F0_RAIL) / LAM_RAIL,
  // clamped by the project speed cap. Faster than the snow's 31 m/s by
  // construction, which is the one verbatim sourced sentence about rails.
  const THRUST = MU_BASE * G_GROUND + LAMBDA_LONG * V_BOOST;
  const V_BOOST_RAIL = Math.min(V_CAP, (THRUST - F0_RAIL) / LAM_RAIL);

  // --- derived balance constants (per rail width, evaluated at reference) ----
  const uMaxOf = halfW => halfW + BOARD_HALF_W;   // support half-width + foot shift
  const xiMaxOf = halfW => uMaxOf(halfW) / L_COM; // largest arrestable capture point
  const OMEGA_0 = Math.sqrt(G_GROUND / L_COM);    // 3.1483 /s, straight-rail rate
  // Curve tolerance: the board's heading lags the rail tangent by
  // dpsi = yawRate / RAIL_YAW_LAMBDA = v*k / RAIL_YAW_LAMBDA (exact steady-state
  // lag of physics' first-order aligner following a ramp). The crab angle at
  // which the resulting load saturates the rider's entire weight-shift budget is
  // sin(dpsi) = u_max/L, i.e. asin(xi_max) — beyond it no stick holds the bend.
  const REF_HALF_W = 0.1;                          // 0.2 m rail: the narrow case
  const CURVE_TOL = Math.asin(clamp(xiMaxOf(REF_HALF_W), 0, 1));

  const config = {
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / OMEGA_0,   // doubling time of an uncorrected lean
    curveTolerance_rad: CURVE_TOL,
    minLockSpeed_mps: MIN_LOCK_SPEED,
    // observability
    railCoulomb_mps2: F0_RAIL,
    railLambda_ps: LAM_RAIL,
    boostTargetOnRail_mps: V_BOOST_RAIL,
    comHeight_m: L_COM,
    seedLean_rad: SEED_LEAN,
    bailLockout_s: BAIL_LOCKOUT,
    rearmRadius_m: REARM_R,
    derivation: {
      dragScale: '0.5*rho*CdA*v^2/m with rho=1.2, CdA=0.5, m=80 -> 0.00375 v^2; ' +
        'at v=18 that is 1.215 m/s^2 = 0.0675/s linear-equivalent; ' +
        '0.0675 / LAMBDA_LONG(0.2235) = 0.3020. A grind deletes the snow-plough ' +
        'share of the snow drag and keeps the air share.',
      railDrag: 'same two-term law as snow, both terms x dragScale: ' +
        'F0 = MU_BASE*g*dragScale, lambda = LAMBDA_LONG*dragScale.',
      boostTargetOnRail: 'thrust = MU_BASE*g + LAMBDA_LONG*V_BOOST (the thrust the ' +
        'snow needs to hold 31 m/s); v_rail = (thrust - F0_RAIL)/LAM_RAIL, capped at V_CAP.',
      pendulum: 'theta_dd = (G/L)*theta - A_S*steer - F_curve; L = 1.8*0.55 = 0.99 m; ' +
        'G = hypot(g, v^2*k) is the effective gravity in the rail frame; ' +
        'A_S = G*u_max/L^2 is the angular authority of a lateral weight shift u_max.',
      uMax: 'rail half-width + board half-waist (0.125 m, 250 mm waist). A WIDER rail ' +
        'raises u_max, which raises BOTH authority and the bail envelope: wider is easier.',
      balance: 'capture point xi = theta + theta_dot/omega, omega = sqrt(G/L), ' +
        'normalised by xi_max = u_max/L = A_S/omega^2 (the largest capture point a ' +
        'full weight shift can still arrest). |balance| > 1 is unrecoverable by definition.',
      seedLean: 'standard snowboard base bevel 0.5-1 deg: the board sits canted on a ' +
        'round rail, so the rider never arrives plumb. 0.5 deg -> 1.05 s measured ' +
        'passive life at 0.2 m width, 1.50 s at 1.6 m: wider is always easier.',
      curveLoad: 'physics aligns heading to the rail with RAIL_YAW_LAMBDA = 9/s, so the ' +
        'board rides a curve crabbed by dpsi = v*k/9 (exact first-order lag on a ramp). ' +
        'The share of the turn load that a crabbed board cannot pass through lean is ' +
        'a_curve = v^2*|k|*sin(dpsi), carried by the weight-shift budget instead.',
      curveTolerance: 'sin(dpsi) = u_max/L saturates that budget: asin(xi_max) at the ' +
        '0.2 m reference rail = ' + (CURVE_TOL * 180 / Math.PI).toFixed(2) + ' deg of crab.',
      captureGate: 'research 02 §1.5 [EST]: capture is tested only while ' +
        'airborne-DESCENDING or on the landing frame -> requires onGround or vel_y <= 0. ' +
        'That also stops a jump-off from re-hooking the rail it just left.',
      choices: 'minLockSpeed 3.0 m/s, captureRadius 1.0 m, bail lockout 1.0 s, ' +
        'rearm radius 2x capture — declared taste, costs stated at each definition.',
    },
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // private 1-D state
      _s: 0, _dir: 1, _ri: -1, _lean: 0, _leanRate: 0,
      _lockout: 0, _bailRail: null, _curveLoad: 0, _crab: 0,
    };
  }

  function release(gs, ps, bailed) {
    gs.onRail = false;
    gs.bailed = bailed;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    gs.balance = clamp(gs.balance, -1, 1);
    if (ps.constrained) ps.constrained = false;
    gs._ri = -1; gs.railId = null;
  }

  function step(gs, ps, input = {}, dt) {
    if (!(dt > 0)) return gs;
    if (gs._lockout > 0) gs._lockout = Math.max(0, gs._lockout - dt);

    // ---- already locked -----------------------------------------------------
    if (gs.onRail) {
      // Physics owns the pop: on jumpRelease it clears `constrained` and performs
      // a true takeoff. Speed and prewind are already correct in ps.vel — the one
      // thing this module must do is NOT touch them (GR-04).
      if (!ps.constrained) { release(gs, ps, false); return gs; }
      const R = rails[gs._ri];
      const spd = Math.abs(gs.alongSpeed);
      const fr = frameAt(R, gs._s);
      const U = [fr.T[0] * gs._dir, fr.T[1] * gs._dir, fr.T[2] * gs._dir]; // travel dir
      const N = [fr.N[0] * gs._dir, 0, fr.N[2] * gs._dir];                 // left of travel
      const k = fr.k * gs._dir;                                            // signed for travel

      // --- 1-D along-rail dynamics, closed form -----------------------------
      // gravity along the tangent (a descending rail accelerates you). Every
      // test rail in the runner is level, so this term is invisible there; it is
      // included because a capture that only converts HORIZONTAL speed taxes the
      // rider 1-cos(25 deg) = 9.4% on exactly the case a rail is meant to win.
      const aG = -G_GROUND * U[1];
      const boosting = !!input.boost && (ps.boostMeter ?? 0) > 0;
      let v;
      if (boosting && spd < V_BOOST_RAIL) {
        // boost = relaxation toward the rail boost speed (exponential, exact)
        const e = Math.exp(-dt / TAU_BOOST);
        v = V_BOOST_RAIL + (spd - V_BOOST_RAIL) * e;
        gs._s += gs._dir * (V_BOOST_RAIL * dt + (spd - V_BOOST_RAIL) * TAU_BOOST * (1 - e));
      } else {
        const f = flow(spd, aG - F0_RAIL, LAM_RAIL, dt);
        v = f.v;
        gs._s += gs._dir * f.ds;
      }
      v = Math.min(v, V_CAP);              // project-wide cap, never above it
      gs.alongSpeed = gs._dir * v;

      // --- balance: inverted pendulum about the rail line --------------------
      const uMax = uMaxOf(R.width * 0.5);
      const xiMax = uMax / L_COM;
      const aLat = v * v * Math.abs(k);                  // turn load, m/s^2
      const G_EFF = Math.hypot(G_GROUND, aLat);          // effective gravity
      const omega = Math.sqrt(G_EFF / L_COM);
      const A_S = G_EFF * uMax / (L_COM * L_COM);        // weight-shift authority
      // curve load: the board rides the bend crabbed by dpsi (physics' aligner
      // lags a ramp by yawRate/RAIL_YAW_LAMBDA); that share of the turn load
      // cannot be passed through lean and must be held by weight shift.
      const dpsi = v * Math.abs(k) / RAIL_YAW_LAMBDA;
      const aCurve = aLat * Math.sin(dpsi) * Math.sign(k);
      const kSteer = input.crouch ? CROUCH_STEER : 1;
      const F = A_S * clamp(input.steer ?? 0, -1, 1) * kSteer + aCurve / L_COM;
      gs._crab = dpsi;
      gs._curveLoad = aCurve;

      // closed form of theta'' = omega^2*theta - F (F constant over the tick)
      const D = F / (omega * omega);
      const ch = Math.cosh(omega * dt), sh = Math.sinh(omega * dt);
      const th0 = gs._lean - D, td0 = gs._leanRate;
      gs._lean = th0 * ch + (td0 / omega) * sh + D;
      gs._leanRate = omega * th0 * sh + td0 * ch;

      const xi = gs._lean + gs._leanRate / omega;        // capture point
      gs.balance = xi / xiMax;

      // --- outcomes ----------------------------------------------------------
      gs.t = R.len > 0 ? clamp(gs._s / R.len, 0, 1) : 0;
      gs.lockFrames++;

      if (Math.abs(gs.balance) > 1) {
        // A bail is a bail: hand physics the rider's real toppling velocity
        // (CoM lateral speed L*theta_dot about the rail line) and lock this rail
        // out until they have both fallen clear and travelled clear of it.
        const vt = L_COM * gs._leanRate;
        ps.vel[0] += N[0] * vt; ps.vel[2] += N[2] * vt;
        gs._lockout = BAIL_LOCKOUT;
        gs._bailRail = R.id;
        release(gs, ps, true);
        return gs;
      }
      if (gs._s >= R.len || gs._s <= 0) {   // ran off the end: speed preserved
        gs._s = clamp(gs._s, 0, R.len);
        release(gs, ps, false);
        return gs;
      }

      // --- hand physics the velocity; it owns position and heading -----------
      ps.vel[0] = U[0] * v; ps.vel[1] = U[1] * v; ps.vel[2] = U[2] * v;
      ps.constrained = true;
      return gs;
    }

    // ---- not locked: AUTO capture (no button press, research 02 §1.5) --------
    gs.balance = 0;
    if (gs._lockout > 0 || rails.length === 0) return gs;
    // capture is tested only while descending or on contact ([EST], §1.5). This
    // is also what stops a jump-off from instantly re-hooking the rail it left.
    if (!ps.onGround && ps.vel[1] > 0) return gs;
    const sp = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
    if (sp < MIN_LOCK_SPEED) return gs;

    let bi = -1, bc = null;
    for (let i = 0; i < rails.length; i++) {
      const c = closest(rails[i], ps.pos);
      if (!c) continue;
      if (rails[i].id === gs._bailRail) {          // cleared the rail we fell off?
        if (c.d > REARM_R) gs._bailRail = null;
        else continue;
      }
      if (c.d <= CAPTURE_R && (!bc || c.d < bc.d)) { bi = i; bc = c; }
    }
    if (bi < 0) return gs;

    const R = rails[bi];
    const fr = frameAt(R, bc.s);
    // FULL velocity along the tangent, not just its horizontal part: converting
    // horizontal-only speed taxes a descending rail by 1-cos(theta): 9.4% at 25 deg.
    const along = ps.vel[0] * fr.T[0] + ps.vel[1] * fr.T[1] + ps.vel[2] * fr.T[2];
    if (Math.abs(along) < MIN_LOCK_SPEED) return gs;    // glancing/perpendicular hit
    // There must be rail left to grind, one board length of it: the board has to
    // sit on the rail before it can slide on it. Without this the tail of every
    // rail is a stutter trap — the rider runs off the end, is still within the
    // capture radius of the last vertex, re-hooks, is SNAPPED BACK to that vertex
    // and released again, forever. Measured before the guard: an 80 deg / R=40
    // arc reported 7.77 s of "grind" on 55.9 m of rail because the rider never
    // got past its end.
    const dir0 = along >= 0 ? 1 : -1;
    if ((dir0 > 0 ? R.len - bc.s : bc.s) < BOARD_LEN) return gs;

    gs._dir = dir0;
    gs._s = bc.s;
    gs._ri = bi;
    gs.railId = R.id;
    gs.onRail = true;
    gs.bailed = false;
    gs.lockFrames = 1;
    gs.alongSpeed = Math.min(Math.abs(along), V_CAP) * gs._dir;
    gs.t = R.len > 0 ? clamp(gs._s / R.len, 0, 1) : 0;

    // lean state at arrival: the base-bevel seed, plus the lean RATE the rider's
    // upper body keeps from whatever cross-rail velocity the rail just absorbed
    // (v_perp / L). Land sideways onto a rail and you are already falling.
    const N = [fr.N[0] * gs._dir, 0, fr.N[2] * gs._dir];
    const vPerp = ps.vel[0] * N[0] + ps.vel[2] * N[2];
    // The bevel cants the board onto whichever edge the standing load presses it
    // toward, which on a bend is the OUTSIDE edge — so the seed reinforces the
    // curve load instead of cancelling it. Sampled half a board ahead, because
    // the board already spans into the bend at the moment it hooks the rail.
    // (With a globally fixed sign the seed cancelled the curve load in one bend
    // direction: measured passive life on the R=80 arc 1.73 s vs 1.03 s on the
    // straight — a rail that curves one way being EASIER than a straight one is
    // the one-sided quirk GR-06 tests both signs to catch.)
    const kAhead = frameAt(R, gs._s + gs._dir * BOARD_LEN * 0.5).k * gs._dir;
    gs._lean = SEED_LEAN * (Math.abs(kAhead) > 1e-9 ? -Math.sign(kAhead) : 1);
    gs._leanRate = vPerp / L_COM;
    const aLat0 = gs.alongSpeed * gs.alongSpeed * Math.abs(kAhead);
    const om0 = Math.sqrt(Math.hypot(G_GROUND, aLat0) / L_COM);
    gs.balance = (gs._lean + gs._leanRate / om0) / xiMaxOf(R.width * 0.5);

    // THE one legal position write: the documented lock-on snap.
    ps.pos[0] = bc.pos[0]; ps.pos[1] = bc.pos[1]; ps.pos[2] = bc.pos[2];
    const T = fr.T, v0 = gs.alongSpeed;
    ps.vel[0] = T[0] * v0; ps.vel[1] = T[1] * v0; ps.vel[2] = T[2] * v0;
    ps.constrained = true;
    return gs;
  }

  return { config, init, step };
}
