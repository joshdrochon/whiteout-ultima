// Rails / grind — candidate A, cycle 2.  Spline projection + inverted-pendulum balance.
//
// ONE MODEL, top to bottom: a grinding rider is an INVERTED PENDULUM whose pivot is
// the rail line.  Every balance number below (instability rate, bail angle, curve
// load, control authority, bail velocity, passive life) falls out of that single
// model plus rider/board geometry.  Nothing here is a second story bolted onto the
// first: there is no "residual fraction of v^2*kappa" AND no separate "hold up to
// 1 g" cap — the curve load IS the pendulum's base acceleration, full stop.
//
// The module writes VELOCITY only (plus the one documented lock-on position snap).
// Physics owns position and heading; `physState.constrained` is held for the WHOLE
// lock so physics runs the rider (crouch charge, prewind, airTime 0, board-to-rail
// yaw alignment) — see CONTRACTS.md "CONSTRAINED STATE".
//
// Constants: every one is either (a) imported from the accepted physics DEFAULTS,
// (b) rider/board geometry from the CONTRACTS.md conventions, or (c) an explicit
// CHOICE, marked as such in `config.derivation` with the cost of moving it.  The (c)s
// are exactly A_BAL, D_ROLL, THETA_SEED, DRAG_SCALE, plus V_MIN_LOCK which is a CHOICE
// anchored on a real-world number rather than a corpus one.  Every number quoted
// in `config.derivation` is interpolated from the same expression the code runs, so
// a stated constant cannot drift from a computed one.
//
// KNOWN, MEASURED CONTRACT CONFLICT — GR-10 vs PC-15.  See config.knownConflict.
// Physics' constrainedStep neither accumulates rotation during a grind nor carries it
// through the constrained takeoff (PC-15 requires the reset in so many words), so a
// module that honours "constrained for the WHOLE lock" has spinDeg == 0 for the whole
// grind and 0 after the pop.  GR-10 is therefore unreachable from inside a rails
// module; it is reachable only by NOT using the constrained state at all, which is
// exactly what this cycle's contract change forbids.  Not tuned around, not faked
// (no coyote propping, no one-frame onRail lag to smuggle a nonzero `after`): the
// rails module is left honest and the conflict is reported upward with numbers.
//
// Pure JS, deterministic, no Date/random.

import { DEFAULTS as PHYS } from '../../../src/physics/physics.mjs';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------------------
// Rider / board geometry (CONTRACTS.md: 1 unit = 1 m, rider 1.8 m / 80 kg)
// ---------------------------------------------------------------------------
const RIDER_H = 1.8;
const H_COM   = 0.55 * RIDER_H;          // 0.99 m — CoM at 55% of stature (standard
                                         // anthropometric fraction), measured from the
                                         // contact, i.e. the pendulum length.
const L_BOARD = RIDER_H - 0.20;          // 1.60 m — standard sizing: board length ~
                                         // rider height less 20 cm (chin height) for a
                                         // 1.8 m rider.
const W_WAIST = 0.25;                    // m, board waist width (standard 250-260 mm
                                         // for this rider size).  Used ONLY as the
                                         // reference rail width for reported figures —
                                         // the rail width the module actually uses is
                                         // whatever env hands it, per rail.

// ---------------------------------------------------------------------------
// Pendulum constants
// ---------------------------------------------------------------------------
const G      = PHYS.G_GROUND;
const W2     = G / H_COM;                // omega_p^2, the toppling rate^2
const OMEGA_P = Math.sqrt(W2);
// theta_bail(w): the rider tips off when the CoM passes outside the rail's support.
// Support half-width = w/2 => bail lean = atan(w/2h).  WIDER RAIL => LARGER
// tolerance AND (below) larger normalised authority per unit steer: a box is
// strictly easier than a bar at every input, which is the direction a bail
// criterion has to move.
const thetaBail = w => Math.atan(w / (2 * H_COM));
const xBail     = w => H_COM * thetaBail(w);   // m — lateral offset budget (~w/2)

// CHOICE 1 — A_BAL: the lateral acceleration the rider can command about the rail by
// moving their body over it.  Set to 1 g, i.e. the 45 deg lean that is the standard
// reference lean in two-wheel dynamics.  This is a CHOICE, not a derivation: nothing
// in the corpus measures a snowboarder's balance authority on a rail.
// COST: a rail of radius R is holdable at speed v only while v^2 <= A_BAL*R.  At the
// [EST] cruise band (research 02 sec 1.6: 14-18 m/s) that is R >= 20-33 m.  Halving
// it makes every curved rail in the game unridable at cruise; doubling it makes
// curved rails free and deletes the mechanic GR-06 is about.
const A_BAL = G;

// CHOICE 2 — D_ROLL: roll-rate damping of the rider/board about the rail (1/s).
// COST, both ends, with the numbers computed in config.derivation.rollDamping_hz:
//   * too low and the correction loop is under-damped at the project's 60 Hz fixed
//     step — its damping ratio falls to the phase margin one sample of delay eats,
//     and a player's own firm stick rings the balance off the rail;
//   * too high and the unstable and stable modes separate so far that balance reads
//     as FIRST-order: correction has no overshoot, there is nothing to feel, and the
//     rider cannot lose a lean they are watching.
// It also sets the passive life (reported below); the GR-05 window is itself a
// declared design choice, so this constant is honestly the same kind of object.
const D_ROLL = 12;

// Modes of  b'' = W2*b - D_ROLL*b' - U.  LAM1 > 0 (the fall), LAM2 < 0 (the arrest).
const ROOT = Math.sqrt(D_ROLL * D_ROLL + 4 * W2);
const LAM1 = (-D_ROLL + ROOT) / 2;
const LAM2 = (-D_ROLL - ROOT) / 2;
// Second-order bail: the rider is gone when the lean PROJECTED FORWARD by the fastest
// arrest the body can perform (1/|LAM2|, the stable mode's time constant) is already
// past the tipping angle — i.e. when recovery is provably impossible, not when the
// lean crosses a line.  This is what gives the balance overshoot you can lose.
const TAU_BAIL = -1 / LAM2;

// CHOICE 3 — THETA_SEED: the lean the rider arrives with.  A rail capture is never
// plumb; this is the residual.  1 degree.
// COST: it is the only thing that sets how long a rider who does NOTHING survives
// (reported as passiveLife_s below).  Ten times smaller adds ~3 s of free grind;
// ten times larger and a clean capture bails before the player can react.
// It is an ABSOLUTE lean, so a wider rail normalises it smaller and lives longer.
const THETA_SEED = 1 * Math.PI / 180;

// CHOICE 4 — DRAG_SCALE: rail resistive law = DRAG_SCALE * (the accepted snow law).
// The source gives an INEQUALITY, not a value: "You go faster boosting on a rail than
// boosting on the snow" (StrategyWiki SSX/Controls, research 02 sec 1.5).  No depth
// or surface argument is offered here, because none in the corpus survives contact
// with the corpus (the Tux Racer terrain table's near-zero-depth row is its HIGHEST
// friction row, so "shallower contact => less drag" is refuted by its own source).
// COST: it is the whole size of the rail's speed reward (computed exit speeds in
// config.derivation.dragScale — roughly double the snow's over 5 s).  At 0.25 a rail
// would beat any line on snow so completely that no other route is worth taking; at
// 0.8 the reward is invisible inside a typical 3 s grind.
const DRAG_SCALE = 0.5;

// Derived, not chosen:
const CAPTURE_R = L_BOARD / 2;           // 0.80 m — the board captures the rail when
                                         // the line passes under ANY part of the board;
                                         // measured at the board centre that is half a
                                         // board length.  (Band GR-02: 0.5-1.5 m.)
const V_MIN_LOCK = 1.4;                  // m/s — average human walking speed.  Below
                                         // walking pace you step onto a rail, you do
                                         // not grind it.  (CHOICE-with-anchor; cost:
                                         // higher and a creeping recovery cannot use a
                                         // rail, lower and a stalled rider sticks.)
const TAU_SNAP = 1 / PHYS.RAIL_YAW_LAMBDA; // 0.111 s — the constraint follows the rail
                                         // at exactly the rate physics turns the BOARD
                                         // to it (RAIL_YAW_LAMBDA).  Baumgarte velocity
                                         // term, never a position write.
const T_COOL = Math.sqrt(2 * CAPTURE_R / PHYS.G_AIR); // 0.50 s — time to fall one
                                         // capture radius under air gravity, i.e. the
                                         // time for a bailed rider to be genuinely out
                                         // of the capture volume.

// ---------------------------------------------------------------------------
// Geometry preparation
// ---------------------------------------------------------------------------
// Lateral unit vector at a tangent: L = up x t (horizontal, left of travel in this
// right-handed Y-up frame).  Sign is arbitrary but consistent everywhere below.
function lateralOf(t) {
  const hx = t[2], hz = -t[0];
  const m = Math.hypot(hx, hz);
  return m > 1e-9 ? [hx / m, 0, hz / m] : [1, 0, 0];
}

function prepRail(r) {
  const pts = r.points.map(p => [p[0], p[1], p[2]]);
  const segs = [];
  let s0 = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-9) continue;
    segs.push({ a, t: [d[0] / L, d[1] / L, d[2] / L], L, s0 });
    s0 += L;
  }
  // VERTEX TANGENTS.  `points` are spline control points (CONTRACTS.md), so the
  // chord of a segment is NOT the tangent of the rail: on a constant-radius arc the
  // chord is off by half the segment's turn.  Using chords made a rider approaching a
  // curved rail dead-on arrive with a phantom 0.48 m/s of perpendicular velocity —
  // a discretisation artifact that seeded 5 /s of roll rate and dropped them in three
  // frames, i.e. the mesh density of the rail decided whether it was ridable.  The
  // tangent at an interior vertex is the bisector of its two chords (exact for a
  // circular arc sampled at the vertices); the ends extrapolate linearly.
  const nS = segs.length;
  const V = new Array(nS + 1);
  const nrm = v => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
  for (let i = 1; i < nS; i++) {
    const p = segs[i - 1].t, c = segs[i].t;
    V[i] = nrm([p[0] + c[0], p[1] + c[1], p[2] + c[2]]);
  }
  if (nS === 1) { V[0] = segs[0].t; V[1] = segs[0].t; }
  else {
    V[0] = nrm([2 * segs[0].t[0] - V[1][0], 2 * segs[0].t[1] - V[1][1], 2 * segs[0].t[2] - V[1][2]]);
    V[nS] = nrm([2 * segs[nS - 1].t[0] - V[nS - 1][0], 2 * segs[nS - 1].t[1] - V[nS - 1][1],
                 2 * segs[nS - 1].t[2] - V[nS - 1][2]]);
  }
  // LATERAL curvature, sampled at each joint: kappa = ((t_i - t_{i-1}) . L) / ds.
  // This is the plain discrete curvature of the polyline the level designer drew —
  // no smoothing filter, so curve difficulty cannot be an artifact of a filter rate
  // (a previous candidate's bend difficulty was set by physics' yaw-aligner constant:
  // raising it made every curved rail 2.2x easier and the mechanic vanished at the
  // limit).  A purely vertical bend contributes zero, as it should: it loads the rail,
  // not the rider's balance.
  const joints = [];
  for (let i = 1; i < segs.length; i++) {
    const tp = segs[i - 1].t, tc = segs[i].t;
    const Lv = lateralOf(tc);
    const ds = 0.5 * (segs[i - 1].L + segs[i].L);
    const dTurn = (tc[0] - tp[0]) * Lv[0] + (tc[2] - tp[2]) * Lv[2];
    joints.push({ s: segs[i].s0, k: ds > 1e-9 ? dTurn / ds : 0 });
  }
  return { id: r.id, width: (r.width > 0 ? r.width : W_WAIST), segs, total: s0, joints, V };
}

// Spline tangent at arc length s: interpolate the two vertex tangents of the segment
// containing s.  On a straight rail this is identically the chord direction.
function tangentAt(rail, s) {
  const segs = rail.segs;
  let i = segs.length - 1;
  for (let k = 0; k < segs.length; k++) if (s < segs[k].s0 + segs[k].L) { i = k; break; }
  const u = clamp((s - segs[i].s0) / segs[i].L, 0, 1);
  const A = rail.V[i], B = rail.V[i + 1];
  const t = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u];
  const m = Math.hypot(t[0], t[1], t[2]);
  return m > 1e-9 ? [t[0] / m, t[1] / m, t[2] / m] : segs[i].t;
}

// Piecewise-linear curvature in s; clamped (not tapered) at the ends so a constant
// radius arc reads as one constant radius end to end.
function curvatureAt(rail, s) {
  const J = rail.joints;
  if (J.length === 0) return 0;
  if (s <= J[0].s) return J[0].k;
  if (s >= J[J.length - 1].s) return J[J.length - 1].k;
  for (let i = 1; i < J.length; i++) {
    if (s <= J[i].s) {
      const u = (s - J[i - 1].s) / Math.max(J[i].s - J[i - 1].s, 1e-9);
      return J[i - 1].k + u * (J[i].k - J[i - 1].k);
    }
  }
  return 0;
}

// Closest point on the polyline.  When locked we only search a window around the
// current arc length, so a rail that folds back on itself cannot teleport the rider
// across the fold.
function project(rail, p, sLo, sHi) {
  let best = null;
  for (const sg of rail.segs) {
    if (sLo !== undefined && (sg.s0 + sg.L < sLo || sg.s0 > sHi)) continue;
    const wx = p[0] - sg.a[0], wy = p[1] - sg.a[1], wz = p[2] - sg.a[2];
    const u = clamp(wx * sg.t[0] + wy * sg.t[1] + wz * sg.t[2], 0, sg.L);
    const q = [sg.a[0] + sg.t[0] * u, sg.a[1] + sg.t[1] * u, sg.a[2] + sg.t[2] * u];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (!best || d < best.d) best = { d, q, t: sg.t, s: sg.s0 + u };
  }
  return best;
}

// Exact solution of dv/dt = a - b*v (Coulomb clamp at 0 on the monotone branch).
// Same closed form as physics' flowSpeed, so a rail and the snow integrate the same
// way and one 100 ms step equals ten 10 ms steps (GR-09).
function flowSpeed(v0, a, b, dt) {
  if (v0 <= 0 && a <= 0) return 0;
  const veq = a / b;
  const v = veq + (v0 - veq) * Math.exp(-b * dt);
  return a <= 0 ? Math.max(v, 0) : v;
}

// ---------------------------------------------------------------------------
export function createRails(env) {
  const rails = (env?.rails ?? []).map(prepRail).filter(r => r.segs.length > 0);
  const byId = new Map(rails.map(r => [r.id, r]));

  const f = (x, n = 3) => Number(x.toFixed(n));
  // Reported figures, computed from the same constants the step uses.
  const passiveLife = (w) => {
    // b(t) from (b0, 0) with U = 0: b = c1 e^{LAM1 t} + c2 e^{LAM2 t}
    const b0 = THETA_SEED / thetaBail(w);
    const c1 = (-LAM2 * b0) / (LAM1 - LAM2), c2 = (LAM1 * b0) / (LAM1 - LAM2);
    let lo = 0, hi = 60;
    const bail = t => {
      const e1 = Math.exp(LAM1 * t), e2 = Math.exp(LAM2 * t);
      const b = c1 * e1 + c2 * e2, bd = c1 * LAM1 * e1 + c2 * LAM2 * e2;
      return Math.abs(b + TAU_BAIL * bd) - 1;
    };
    if (bail(hi) < 0) return Infinity;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bail(m) < 0) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };
  const railExit = (v0, t) => {   // exit speed after t s of grind from v0, flat rail
    const a = DRAG_SCALE * PHYS.MU_BASE * G, b = DRAG_SCALE * PHYS.LAMBDA_LONG;
    return flowSpeed(v0, -a, b, t);
  };
  const snowExit = (v0, t) => flowSpeed(v0, -(PHYS.MU_BASE * G), PHYS.LAMBDA_LONG, t);

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / LAM1,   // DOUBLING time of the unstable lean mode:
                                          // an uncorrected lean doubles this often.
                                          // (The arrest mode's half-life is the other
                                          // number, reported separately below.)
    curveTolerance_rad: thetaBail(W_WAIST),
    minLockSpeed_mps: V_MIN_LOCK,
    // --- the rest of the model, exposed so a probe can normalise against it ---
    comHeight_m: H_COM,
    boardLength_m: L_BOARD,
    topplingRate_hz: OMEGA_P,
    rollDamping_hz: D_ROLL,
    balanceAuthority_mps2: A_BAL,
    arrestHalfLife_s: Math.LN2 / -LAM2,
    bailLookahead_s: TAU_BAIL,
    seedLean_rad: THETA_SEED,
    snapTau_s: TAU_SNAP,
    recaptureCooldown_s: T_COOL,
    boostTarget_mps: PHYS.V_CAP,
    // --- reported consequences (computed, never hand-typed) ---
    passiveLife_s: passiveLife(W_WAIST),
    passiveLifeWide_s: passiveLife(0.6),
    holdableRadiusAtCruise_m: 16 * 16 / A_BAL,
    derivation: {
      captureRadius_m:
        `DERIVED: half a board length. Board = rider height 1.8 m - 0.20 m = ` +
        `${f(L_BOARD, 2)} m (standard sizing), so the rail line passes under some part ` +
        `of the board whenever the board CENTRE is within ${f(CAPTURE_R, 2)} m. ` +
        `Sits inside the [EST] 0.5-1.5 m band of research 02 sec 1.5 without being ` +
        `taken from it. Capture also requires the closest point to be INTERIOR to the ` +
        `polyline, so no rider is ever snapped forward onto a rail head they have not ` +
        `reached, and requires the board to be supported or descending (research 02 ` +
        `sec 1.5: tested "only while airborne-descending or on landing frame").`,
      dragScale:
        `CHOICE (the source gives an inequality, not a value). Whole resistive law ` +
        `x${DRAG_SCALE}: a(v) = ${DRAG_SCALE}*(MU_BASE*g*cos + LAMBDA_LONG*v), both ` +
        `terms imported from physics DEFAULTS. Gravity along the tangent is NOT ` +
        `scaled, so a descending rail accelerates you at full g*sin. From 20 m/s, 5 s: ` +
        `rail ${f(railExit(20, 5), 2)} m/s vs snow ${f(snowExit(20, 5), 2)} m/s. ` +
        `Cost is stated at the constant.`,
      balanceHalfLife_s:
        `DERIVED: ln2/LAM1 where LAM1 = ${f(LAM1)} /s is the unstable root of ` +
        `b'' = (g/h)b - D b'. g/h uses h = 0.55*1.8 = ${f(H_COM, 2)} m (CoM height), ` +
        `giving a toppling rate of ${f(OMEGA_P)} /s. So an uncorrected lean doubles ` +
        `every ${f(Math.LN2 / LAM1)} s; the arrest mode halves every ` +
        `${f(Math.LN2 / -LAM2)} s. Passive life from the seed lean: ` +
        `${f(passiveLife(W_WAIST))} s at w=${W_WAIST} m, ${f(passiveLife(0.6))} s on a ` +
        `0.6 m box, ${f(passiveLife(0.2))} s on a 0.2 m bar — wider is strictly easier.`,
      curveTolerance_rad:
        `DERIVED: atan(w/2h), the lean at which the CoM passes outside the rail's ` +
        `support. Reported at the board-waist reference width ${W_WAIST} m = ` +
        `${f(thetaBail(W_WAIST))} rad (${f(thetaBail(W_WAIST) * 180 / Math.PI, 1)} deg); ` +
        `the module uses each rail's OWN width, so a 0.6 m box tolerates ` +
        `${f(thetaBail(0.6) * 180 / Math.PI, 1)} deg.`,
      minLockSpeed_mps:
        `CHOICE anchored on average human walking speed (1.4 m/s): below walking pace ` +
        `you step onto a rail rather than grind it. Measured along the TANGENT, so a ` +
        `rider crossing a rail at 90 deg cannot lock onto it at any speed.`,
      balanceAuthority_mps2:
        `CHOICE = 1 g. Holdable radius at the [EST] cruise midpoint 16 m/s: ` +
        `R >= ${f(16 * 16 / A_BAL, 1)} m. Multiplied by physics' own CROUCH_STEER ` +
        `(${PHYS.CROUCH_STEER}) while crouched and TUCK_STEER (${PHYS.TUCK_STEER}) ` +
        `while tucked, exactly as groundCore does — so charging a pop on a curved rail ` +
        `costs ${f((1 - PHYS.CROUCH_STEER) * 100, 0)}% of your balance authority and ` +
        `the rail-into-big-air link is a real risk, not a free ride.`,
      rollDamping_hz:
        `CHOICE = ${D_ROLL} /s. Sized against the project's 60 Hz fixed step, not ` +
        `against any probe: a player correcting with a firm proportional stick ` +
        `(steer = k*lean, k ~ 2-4) closes the loop at omega_n = ` +
        `${f(Math.sqrt(3 * A_BAL / xBail(W_WAIST) - W2), 1)} /s for k=3 on the ` +
        `reference width, so the closed loop runs zeta = ` +
        `${f(D_ROLL / (2 * Math.sqrt(3 * A_BAL / xBail(W_WAIST) - W2)))} against the ` +
        `${f((1 / 60) * Math.sqrt(3 * A_BAL / xBail(W_WAIST) - W2) / 2)} of damping ` +
        `one sample of delay eats at 60 Hz. Those two are EQUAL at D = ` +
        `${f((3 * A_BAL / xBail(W_WAIST) - W2) / 60, 1)} /s, which is the floor; the ` +
        `ceiling is where the two modes separate enough that balance stops having ` +
        `overshoot to lose (arrest half-life here is ${f(Math.LN2 / -LAM2)} s against ` +
        `a doubling time of ${f(Math.LN2 / LAM1)} s).`,
      curveLoad:
        `NOT A SEPARATE LAW. The curve enters as the pendulum's own base acceleration: ` +
        `h*theta'' = g*theta - a_x with a_x = v^2*kappa + A_BAL*k*steer. There is no ` +
        `residual fraction and no lateral cap layered on top; at full stick the rider ` +
        `holds exactly v^2*kappa <= A_BAL and not one m/s^2 more.`,
      boost:
        `DERIVED from the one sourced sentence plus accepted constants: rail-boost must ` +
        `exceed snow-boost (V_BOOST = ${PHYS.V_BOOST}), and the only speed above it the ` +
        `game permits is V_CAP = ${PHYS.V_CAP}. So the rail's boost target IS V_CAP, ` +
        `relaxed with physics' own TAU_BOOST (${PHYS.TAU_BOOST} s). Along-rail speed is ` +
        `clamped at V_CAP and never above it.`,
      capture:
        `Full 3D velocity is projected on the 3D tangent (dot(v, t)), NOT horizontal ` +
        `speed: a horizontal-only capture taxes a rider on a descending rail 9.4% at ` +
        `25 deg and 23% at 40 deg, on the exact case a rail is meant to win. The ` +
        `perpendicular component is not discarded either — the rail absorbs it and it ` +
        `becomes roll rate about the rail line (theta' = v_perp/h), so a crooked ` +
        `landing wobbles instead of vanishing.`,
      bail:
        `SECOND ORDER: bail when |b + ${f(TAU_BAIL)}*b'| > 1, the lean projected ` +
        `forward by the fastest arrest the body can perform (1/|LAM2|). A first-order ` +
        `test with high authority has no overshoot and nothing to feel. On bail the ` +
        `rider topples off the side they were leaning at the CoM's own lateral speed ` +
        `(h*theta'), and capture on that rail is disarmed until they are genuinely out ` +
        `of the capture volume AND ${f(T_COOL)} s (fall time of one capture radius ` +
        `under G_AIR) has passed — a bail is a bail, not a pogo.`,
    },
    knownConflict:
      `GR-10 vs PC-15/CONTRACTS "CONSTRAINED STATE". This module holds ` +
      `physState.constrained for the whole lock, as the contract requires. Physics' ` +
      `constrainedStep accumulates no rotation while constrained and its jumpRelease ` +
      `branch calls takeoff(), which zeroes spinDeg/flipDeg — PC-15 requires that ` +
      `reset verbatim ("rotation and air clock reset"). So under the contract a grind ` +
      `has spinDeg 0 throughout AND 0 after the pop, and GR-10's spinPreservedFrac is ` +
      `structurally 0 for ANY module that uses the constrained state. The plain ` +
      `baseline scores 1.01 on GR-10 only because it never sets constrained at all ` +
      `(0 constrained frames in 271 grind frames) — which is also why it never ` +
      `charges, the defect this cycle exists to fix. The fix is one of: let ` +
      `constrainedStep run the air-rotation block, or carry rotation through the ` +
      `constrained takeoff, or re-measure GR-10 across the GRIND rather than across ` +
      `the takeoff. All three are physics/gate-owner changes; none is reachable from ` +
      `a rails module without faking trick state, so none is attempted here.`,
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // internals
      _b: 0, _bd: 0, _s: 0, _cool: 0, _block: null, _kappa: 0, _thetaBail: 0,
    };
  }

  function leave(gs, ps, kind) {
    gs.onRail = false;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    if (kind !== 'bail') gs.balance = 0;   // a bail keeps the lean that lost it
    if (kind !== 'pop') ps.constrained = false;   // a pop already cleared it
    if (kind === 'bail') { gs.bailed = true; gs._cool = T_COOL; gs._block = gs.railId; }
    else { gs.bailed = false; gs._block = null; gs._cool = 0; }
    gs.railId = kind === 'bail' ? gs.railId : null;
  }

  function step(gs, ps, inp = {}, dt) {
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    if (gs.onRail) {
      // Physics consumed a jumpRelease from the constrained state: it has already
      // popped, reset rotation and cleared `constrained`.  Leaving is an observation,
      // not an action — the module must not touch the velocity it left behind (that
      // is what preserves exit speed and prewind, GR-04).
      if (!ps.constrained) { leave(gs, ps, 'pop'); return gs; }
      const rail = byId.get(gs.railId);
      if (!rail) { leave(gs, ps, 'end'); return gs; }
      const reach = Math.abs(gs.alongSpeed) * dt + 2;
      const c = project(rail, ps.pos, gs._s - reach, gs._s + reach) ?? project(rail, ps.pos);
      // Ran off either end.
      if (c.s <= 1e-4 || c.s >= rail.total - 1e-4) { leave(gs, ps, 'end'); return gs; }

      // --- along-rail speed: closed form, gravity along the 3D tangent included ---
      const t3 = tangentAt(rail, c.s);
      const cosSlope = Math.hypot(t3[0], t3[2]);          // |t| horizontal = cos(slope)
      const gAlong = -G * t3[1];                          // +ve when +t descends
      const F0 = DRAG_SCALE * PHYS.MU_BASE * G * cosSlope;
      const b = DRAG_SCALE * PHYS.LAMBDA_LONG;
      let sgn = gs.alongSpeed >= 0 ? 1 : -1;
      let sAbs = Math.abs(gs.alongSpeed);
      let a = sgn * gAlong - F0;
      if (sAbs < 1e-6 && a <= 0) {                        // gravity-driven reversal
        const aRev = -sgn * gAlong - F0;
        if (aRev > 0) { sgn = -sgn; a = aRev; }
      }
      const boostOn = !!inp.boost && (ps.boostMeter ?? 0) > 0;
      if (boostOn) {
        const rt = a > 0 ? a / b : 0;
        const target = Math.max(PHYS.V_CAP, rt);
        sAbs = sAbs < target
          ? target + (sAbs - target) * Math.exp(-dt / PHYS.TAU_BOOST)
          : flowSpeed(sAbs, a, b, dt);
      } else {
        sAbs = flowSpeed(sAbs, a, b, dt);
      }
      gs.alongSpeed = sgn * Math.min(sAbs, PHYS.V_CAP);

      // --- balance: b'' = W2*b - D*b' - (v^2*kappa + A_BAL*k*steer)/xBail ---
      const tb = gs._thetaBail, xb = H_COM * tb;
      const kappa = curvatureAt(rail, c.s);
      const kSteer = (inp.tuck ? PHYS.TUCK_STEER : 1) * (inp.crouch ? PHYS.CROUCH_STEER : 1);
      const steer = clamp(inp.steer ?? 0, -1, 1);
      const aLat = gs.alongSpeed * gs.alongSpeed * kappa + A_BAL * kSteer * steer;
      const U = aLat / xb;
      const bEq = U / W2;
      const e0 = gs._b - bEq, ed0 = gs._bd;
      const c1 = (ed0 - LAM2 * e0) / (LAM1 - LAM2);
      const c2 = (LAM1 * e0 - ed0) / (LAM1 - LAM2);
      const E1 = Math.exp(LAM1 * dt), E2 = Math.exp(LAM2 * dt);
      gs._b = c1 * E1 + c2 * E2 + bEq;
      gs._bd = c1 * LAM1 * E1 + c2 * LAM2 * E2;
      gs._kappa = kappa;

      // --- bail (second order) ---
      if (Math.abs(gs._b + TAU_BAIL * gs._bd) > 1 || Math.abs(gs._b) > 1) {
        const Lv = lateralOf(t3);
        const vLat = H_COM * gs._bd * tb;                 // the CoM's own lateral speed
        ps.vel[0] = t3[0] * gs.alongSpeed + Lv[0] * vLat;
        ps.vel[1] = t3[1] * gs.alongSpeed;
        ps.vel[2] = t3[2] * gs.alongSpeed + Lv[2] * vLat;
        gs.balance = clamp(gs._b, -1, 1);
        leave(gs, ps, 'bail');
        return gs;
      }

      // --- write VELOCITY: tangent flow + Baumgarte constraint stabilisation.
      //     Physics integrates position with the project-wide forward Euler, which on
      //     a curved rail throws the rider outward by v^2*dt/(2R) every step with
      //     nothing to restore it (0.068 m/s at 18 m/s on R=40, unbounded).  This term
      //     is a VELOCITY, never a position write, and holds the line to ~mm.
      ps.vel[0] = t3[0] * gs.alongSpeed + (c.q[0] - ps.pos[0]) / TAU_SNAP;
      ps.vel[1] = t3[1] * gs.alongSpeed + (c.q[1] - ps.pos[1]) / TAU_SNAP;
      ps.vel[2] = t3[2] * gs.alongSpeed + (c.q[2] - ps.pos[2]) / TAU_SNAP;
      ps.constrained = true;

      gs._s = c.s;
      gs.t = rail.total > 0 ? c.s / rail.total : 0;
      gs.balance = clamp(gs._b, -1, 1);
      gs.lockFrames++;
      return gs;
    }

    // --- not on a rail: auto lock-on, no button press (research 02 sec 1.5) ---
    if (gs._block) {
      const rb = byId.get(gs._block);
      const cb = rb ? project(rb, ps.pos) : null;
      if (!cb || cb.d > CAPTURE_R) gs._block = null;      // genuinely clear of it
    }
    if (gs._cool > 0) return gs;
    // Tested only while supported or descending: after a pop you rise off the rail and
    // can only re-take it on the way back down.
    if (!(ps.onGround || ps.vel[1] <= 0)) return gs;

    let bestRail = null, bestC = null;
    for (const rail of rails) {
      if (gs._block === rail.id) continue;
      const c = project(rail, ps.pos);
      if (!c || c.d > CAPTURE_R) continue;
      if (c.s <= 1e-3 || c.s >= rail.total - 1e-3) continue;   // interior only
      c.t = tangentAt(rail, c.s);
      if (Math.abs(dot3(ps.vel, c.t)) < V_MIN_LOCK) continue;
      if (!bestC || c.d < bestC.d) { bestRail = rail; bestC = c; }
    }
    if (!bestC) return gs;

    // LOCK-ON.  The one documented position write in the module: snap to the closest
    // point on the polyline (|snap| <= captureRadius by construction).
    const Lv = lateralOf(bestC.t);
    const offLat = (ps.pos[0] - bestC.q[0]) * Lv[0] + (ps.pos[2] - bestC.q[2]) * Lv[2];
    const vPerp = ps.vel[0] * Lv[0] + ps.vel[2] * Lv[2];
    const tb = thetaBail(bestRail.width);
    ps.pos[0] = bestC.q[0]; ps.pos[1] = bestC.q[1]; ps.pos[2] = bestC.q[2];
    gs.onRail = true; gs.railId = bestRail.id; gs.bailed = false; gs.lockFrames = 0;
    gs._s = bestC.s; gs._thetaBail = tb;
    gs.alongSpeed = dot3(ps.vel, bestC.t);                 // full 3D speed on tangent
    gs._b = (offLat >= 0 ? 1 : -1) * THETA_SEED / tb;      // arrival is never plumb
    gs._bd = (vPerp / H_COM) / tb;                         // absorbed side momentum
    ps.constrained = true;
    return step(gs, ps, inp, dt);                          // run the grind tick now
  }

  return { config, init, step };
}
