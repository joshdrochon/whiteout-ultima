// Candidate A — rails / grind system (spline projection + inverted-pendulum balance)
//
// SHAPE (the seed, kept):
//   every frame -> project the board onto the rail polyline (closest point +
//   tangent) -> drive along-rail speed with CLOSED-FORM drag -> balance is a
//   damped-free second-order state driven by rail curvature and corrected by
//   steer. The module writes VELOCITY ONLY (plus the one documented lock-on
//   snap) and lets physics integrate position; that is the only way to satisfy
//   GR-07 and still move.
//
// THE ONE STRUCTURAL FINDING (read this before judging the constrained flag):
//   `physState.constrained` and GR-07 are jointly unsatisfiable as a permanent
//   state. While `constrained` physics integrates NOTHING (physics.mjs
//   constrainedStep touches only charge/airTime), and GR-07 forbids the module
//   from writing position on any frame except the lock frame. A module that
//   holds `constrained = true` across a grind therefore leaves the rider
//   FROZEN IN PLACE — measured, forcing the flag on every frame: 0.000 m
//   travelled in 3.70 s of grind, against 13.0 m/s mean unconstrained.
//   Second, independent blocker: physics does not accrue rotation while
//   constrained and its takeoff() zeroes spinDeg, so the same run reports
//   spinDeg 0.0 after 4 s of held spin input — GR-10 (HARD) at 0.
//   RESOLUTION SHIPPED: `constrained` is engaged exactly while the rider LOADS
//   the ollie (`input.crouch` held on a rail) and cleared the instant the
//   crouch ends or the rail is left. That buys the whole point of the state —
//   a crouch on a rail charges at T_CHARGE and pops as a TRUE takeoff:
//   measured 0.85 s load -> charge 0.980 -> 4.94 m/s off the rail, and a
//   0.34 s load -> charge 0.373 -> 3.18 m/s, against the flat 2.10 m/s J_MIN
//   tap that made this link unbuildable — at the cost of the rider not
//   advancing during the load (5.02 m of rail un-travelled for the 0.34 s
//   load, 12.81 m for the full 0.85 s). Between the two states the
//   rider is airborne-on-a-rail, so rail spins accumulate in physics'
//   own air rotation (GR-10 passes at 1.0000) and nothing here touches
//   airTime / charge / _popDone.
//   The contract fix that would let `constrained` stay on for the whole grind
//   is one line in physics.mjs constrainedStep — integrate `pos += vel*dt`
//   from the velocity the owning module supplies. It is NOT taken here: that
//   is the physics lane's call, and GR-10 would still need the rail's rotation
//   to accrue somewhere. Flagged, not bridged.
//
// COST OF THE SPLIT STATE (measured, not hidden): a tap-jump off a rail with
//   no crouch produces NO vertical impulse — measured vy 0.00 m/s, horizontal
//   15.103 -> 15.103 m/s. Physics' coyote branch has long since expired
//   (airTime ~ the grind length) and this module refuses to prop it open (that
//   is precisely the GR-10 mutant). The ollie off a rail is charge-gated: you
//   must load it. If the lane wants a free tap-pop off rails, that belongs in
//   physics' constrained state, not in a rail-side fake.
//
// OTHER MEASUREMENTS BEHIND THE CLAIMS BELOW (all from this module + the
//   accepted physics, none of them gate probes):
//   * board tracks the rail line to 1.8e-3 m peak error over a 48 m grind,
//     with zero position writes after the lock snap;
//   * 25 deg DESCENDING rail (the runner has no such probe — every test rail
//     is flat, which once hid a missing gravity term): 15.15 -> 21.14 m/s in
//     3.7 s, i.e. the rail accelerates you, and capture keeps the full 3D
//     speed instead of taxing it 9.4% as a horizontal-only conversion would;
//   * boost held 6 s: 33.00 m/s on the rail vs 31.00 m/s on the snow;
//   * passive bail 2.17 s on a 0.2 m rail, 2.93 s on a 0.6 m fun box.
//
// WHAT IS SOURCED vs CHOSEN — every constant resolves in config.derivation.
//   sourced: auto lock-on with no button (StrategyWiki), rail drag < snow drag
//   and boost-on-rail > boost-on-snow (StrategyWiki, verbatim), curved rails
//   drop you if you do not steer (gondee), capture radius 0.5-1.5 m [EST],
//   closest-point-on-spline capture (Unity/RailGrind), "turn sideways to
//   balance easier" (StrategyWiki), MIN_FRICT_SPEED 2.8 and the ice:snow
//   friction ratio (Tux Racer, research 02 sec 3).
//   chosen (labelled CHOICE, cost stated): passive bail target 2.2 s, the
//   constraint half-life, the heel-side convention, the CoM fraction.
//
// NOT DONE HERE (deliberate): no trick state is written, no scoring, no
//   heading write, no position write outside the lock snap, no private charge
//   counter, no clamp on along-rail speed below physics' V_CAP.

// ---------------------------------------------------------------------------
// Constants. Every one carries its derivation in config.derivation.
// ---------------------------------------------------------------------------
const RIDER_H = 1.8;                 // m — CONTRACTS.md convention (1.8 m / 80 kg)
const COM_FRAC = 0.55;               // CHOICE: standing CoM at 55% of stature
const H_COM = RIDER_H * COM_FRAC;    // 0.990 m — pendulum length above the rail
const BOARD_L = 0.86 * RIDER_H;      // 1.548 m — board sized to chin height
const T_BAIL = 2.2;                  // s — CHOICE: passive bail on a bare rail
const SNAP_HALFLIFE = 0.05;          // s — CHOICE: constraint convergence
const DRAG_RATIO = 0.20 / 0.35;      // Tux Racer ice:snow friction ratio
const MIN_FRICT_SPEED = 2.8;         // m/s — Tux Racer MIN_FRICT_SPEED

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Rail geometry: polyline -> segments with arc length, unit tangents, and the
// window over which curvature can honestly be resolved.
// ---------------------------------------------------------------------------
function prepRail(r) {
  const P = (r.points ?? []).map(p => [+p[0], +p[1], +p[2]]);
  const seg = [];
  let S = 0;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    if (L <= 1e-9) continue;
    seg.push({ a, L, s0: S, u: [d[0] / L, d[1] / L, d[2] / L] });
    S += L;
  }
  const meanSeg = seg.length ? S / seg.length : 0;
  return {
    id: r.id, width: Math.max(r.width ?? 0.2, 1e-3), seg, S, meanSeg,
    // Curvature cannot be resolved below the polyline's own sampling, and the
    // rider cannot feel a bend shorter than their own board: the window is the
    // larger of the two scales.
    curvWin: Math.max(BOARD_L, 2 * meanSeg),
  };
}

// Closest point on the polyline to p. Returns world point, distance, arc
// length s, and the unit tangent of the segment holding it.
function closest(rail, p) {
  let best = null;
  for (let i = 0; i < rail.seg.length; i++) {
    const g = rail.seg[i], a = g.a, u = g.u;
    const w = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const proj = clamp(w[0] * u[0] + w[1] * u[1] + w[2] * u[2], 0, g.L);
    const q = [a[0] + u[0] * proj, a[1] + u[1] * proj, a[2] + u[2] * proj];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (!best || d < best.d) best = { d, q, u, s: g.s0 + proj };
  }
  return best;
}

function tangentAt(rail, s) {
  const seg = rail.seg;
  for (let i = 0; i < seg.length; i++) if (s <= seg[i].s0 + seg[i].L || i === seg.length - 1) return seg[i].u;
  return seg[0].u;
}

// Signed lateral curvature about the horizontal normal n: kappa_n = dt/ds . n,
// evaluated as a central difference over the resolvable window. Exact (1/R) on
// a constant-radius arc, exactly 0 on a straight rail, and independent of the
// polyline's vertex spacing.
function curvatureN(rail, s, n) {
  const w = rail.curvWin;
  const s1 = Math.max(0, s - w), s2 = Math.min(rail.S, s + w);
  const ds = s2 - s1;
  if (ds < 1e-6) return 0;
  const t1 = tangentAt(rail, s1), t2 = tangentAt(rail, s2);
  return ((t2[0] - t1[0]) * n[0] + (t2[2] - t1[2]) * n[2]) / ds;
}

export function createRails(env = {}, opts = {}) {
  // Physics constants this module SCALES rather than re-invents. Read from the
  // accepted module's published DEFAULTS (src/physics/physics.mjs); an embedding
  // host may pass the live resolved config via env.physicsConfig. Hard-coded
  // rather than imported so the file stays relocatable, but they are quotations,
  // not choices: "rails are faster than snow" is only meaningful as a scaling of
  // the SAME snow law physics runs.
  const PH = {
    G_GROUND: 9.81, G_AIR: 6.5, MU_BASE: 0.0305, LAMBDA_LONG: 0.2235,
    J_MIN: 2.1, V_CAP: 33, V_BOOST: 31,
    ...(env.physicsConfig ?? {}), ...(opts.physicsConfig ?? {}),
  };

  const rails = (env.rails ?? []).map(prepRail).filter(r => r.seg.length > 0);

  // --- balance plant (inverted pendulum about the rail axis) ---------------
  const W0 = Math.sqrt(PH.G_GROUND / H_COM);      // 3.148 rad/s
  const W02 = W0 * W0;                            // 9.909 1/s^2
  // Full-stick correction authority: the rider can drive the CoM sideways at
  // about 1 g while braced on the rail -> theta'' = g/h = W02.
  const K_CTRL = W02;
  // Passive damping of the rider's own lean: taken as CRITICAL for the same
  // body hanging rather than balancing (c = 2*w0). Not free — an undamped
  // plant lets any delayed correction pump energy into itself, which is
  // exactly what a player's one-frame-late stick is.
  const C_DAMP = 2 * W0;
  // Real roots of theta'' + c*theta' - w0^2*theta = 0 (always real).
  const RDISC = Math.sqrt(C_DAMP * C_DAMP + 4 * W02);
  const LP = (-C_DAMP + RDISC) / 2;               // unstable root  > 0
  const LM = (-C_DAMP - RDISC) / 2;               // stable root    < 0

  // Exact evolution of theta'' = w0^2*theta - c*theta' + F over dt (F constant
  // across the step): closed form in the two real roots, so dt-split-exact.
  function evolve(th, td, F, dt) {
    const thP = -F / W02;                         // particular (equilibrium)
    const d0 = th - thP;
    const A = (td - LM * d0) / (LP - LM);
    const B = d0 - A;
    const ep = Math.exp(LP * dt), em = Math.exp(LM * dt);
    return [thP + A * ep + B * em, A * LP * ep + B * LM * em];
  }

  // Peak |theta| reachable from (th, td) if the rider applies FULL stick
  // against the lean right now, with the current external forcing left in
  // place. Closed form: theta' = 0 at a single turning point.
  function peakLean(th, td, Fext) {
    const s = th >= 0 ? 1 : -1;                   // work in the outward frame
    const th0 = s * th, td0 = s * td;
    const F = s * Fext - K_CTRL;                  // full stick opposing
    const thP = -F / W02;
    const d0 = th0 - thP;
    const A = (td0 - LM * d0) / (LP - LM);
    const B = d0 - A;
    const num = -B * LM, den = A * LP;
    if (Math.abs(den) < 1e-12) return Infinity;
    const ratio = num / den;
    if (!(ratio > 0)) return Infinity;            // never turns around
    const t = Math.log(ratio) / (LP - LM);
    if (!(t > 0)) return th0;
    return thP + A * Math.exp(LP * t) + B * Math.exp(LM * t);
  }

  // Constant stance bias, fixed by the passive-bail CHOICE: the unit-bias step
  // response from rest must reach theta_bail at T_BAIL. Stated in ANGLE units
  // so a wider rail (bigger theta_bail) really is easier to hold, which a
  // normalised bias would hide.
  const THETA_BAIL_REF = Math.atan(0.5 * 0.2 / H_COM);   // bare 0.2 m rail
  const TAU_BIAS = THETA_BAIL_REF / evolve(0, 0, 1, T_BAIL)[0];

  // --- capture / drag ------------------------------------------------------
  const CAPT = 0.5 * BOARD_L;                     // 0.774 m
  const MIN_LOCK = MIN_FRICT_SPEED;               // 2.8 m/s
  const MU_R = PH.MU_BASE * DRAG_RATIO;           // rail Coulomb term
  const LAM_R = PH.LAMBDA_LONG * DRAG_RATIO;      // rail linear term
  // Boost thrust DEFINED as the thrust that produces physics' V_BOOST on snow.
  // On the rail the same thrust equilibrates far higher -> "you go faster
  // boosting on a rail than boosting on the snow" falls out, no free parameter.
  const A_BOOST = PH.MU_BASE * PH.G_GROUND + PH.LAMBDA_LONG * PH.V_BOOST;
  const K_SNAP = Math.LN2 / SNAP_HALFLIFE;
  // Shortest possible hop off a rail: physics' minimum pop, up and back down.
  // A rider who has jumped is still inside the capture radius on the next
  // frame, so without this the rail re-snatches (and re-snaps) them instantly.
  const T_HOP = 2 * PH.J_MIN / PH.G_AIR;          // 0.646 s

  const config = {
    // --- contract-required ---
    captureRadius_m: +CAPT.toFixed(4),
    dragScale: +DRAG_RATIO.toFixed(4),
    balanceHalfLife_s: +(Math.LN2 / LP).toFixed(4),
    curveTolerance_rad: +THETA_BAIL_REF.toFixed(4),
    minLockSpeed_mps: MIN_LOCK,
    // --- resolved plant ---
    riderCoMHeight_m: +H_COM.toFixed(4),
    boardLength_m: +BOARD_L.toFixed(4),
    pendulumRate_rps: +W0.toFixed(4),
    leanDamping_per_s: +C_DAMP.toFixed(4),
    divergenceRate_per_s: +LP.toFixed(4),
    controlAuthority_rps2: +K_CTRL.toFixed(4),
    stanceBias_rps2: +TAU_BIAS.toFixed(6),
    passiveBailTarget_s: T_BAIL,
    railMu: +MU_R.toFixed(5),
    railLambda: +LAM_R.toFixed(5),
    boostThrust_mps2: +A_BOOST.toFixed(4),
    snapHalfLife_s: SNAP_HALFLIFE,
    vCap_mps: PH.V_CAP,

    derivation: {
      captureRadius_m:
        'Half a board length: the board must OVERLAP the rail line to catch it. ' +
        'Board = 0.86 x rider height (chin-height sizing rule) = 1.548 m at the ' +
        "contract's 1.8 m rider, so radius 0.774 m. Research 02 sec 1.5 [EST] " +
        'gives 0.5-1.0 board-length (0.5-1.5 m); this is the tight end of that band. ' +
        'CHOICE cost: a bigger radius catches sloppier approaches but starts to ' +
        'snatch riders who meant to pass the rail.',
      dragScale:
        'Tux Racer terrain table (research 02 sec 3.1, verified clone): ice mu 0.20, ' +
        'snow mu 0.35 -> 0.571. The corpus says "use those ratios as the target" and ' +
        'this is its only sourced faster-surface ratio. Applied to BOTH terms of the ' +
        "snow law physics actually runs (MU_BASE, LAMBDA_LONG), so 'rails are faster " +
        "than snow' is arithmetic, not tuning: measured, 20 m/s coasting 5 s gives " +
        '9.60 m/s on rail vs 5.64 m/s on snow. CHOICE cost: a lower scale would make rails a ' +
        'bigger speed reward and a more dominant line; 0.571 is the sourced anchor.',
      balanceHalfLife_s:
        'Not a chosen decay rate: it is the plant. Balance is an inverted pendulum of ' +
        'length h = 0.55 x 1.8 m = 0.990 m (CoM at 55% of stature, CHOICE within the ' +
        '55-57% anthropometric range), so w0 = sqrt(g/h) = 3.148 rad/s. With the lean ' +
        'damping below the unstable root is 1.304 /s, i.e. an ignored lean DOUBLES ' +
        'every 0.532 s. That is the number a player feels, and it is second order: ' +
        'the lean has momentum, so a late correction overshoots.',
      leanDamping_per_s:
        'The rider\'s own passive lean damping, c = 2*w0 = 6.296 /s: CHOICE, taken as ' +
        'CRITICAL damping for the same body of the same length hanging rather than ' +
        'balancing. It is not decoration. An undamped inverted pendulum conserves the ' +
        'energy of a sign-feedback corrector exactly, so a stick that is one frame ' +
        'late — which every real stick is, and which the runner\'s own probe is — ' +
        'pumps the limit cycle until it bails: measured, the undamped version of this ' +
        'module held the GR-05 probe only 0.20 of the window and lost GR-10 with it. ' +
        'COST: damping also slows the passive fall, so the stance bias is recalibrated ' +
        'against the damped plant to keep the 2.2 s bail; a much larger c would make ' +
        'the rail feel sticky and a much smaller one makes correction chatter.',
      curveTolerance_rad:
        'Geometric, not tuned: the rider bails when the CoM ground-projection leaves ' +
        'the support. theta_bail = atan(halfBase/h). halfBase = max(rail width, ' +
        'board length x |sin(board-vs-rail angle)|)/2, so a 0.2 m rail with the board ' +
        'aligned gives atan(0.1/0.99) = 0.1006 rad, a 0.6 m fun box is 3x easier, and ' +
        'turning the board sideways puts the whole 1.548 m board across the rail — ' +
        'which is exactly StrategyWiki\'s "turn sideways to balance easier".',
      minLockSpeed_mps:
        'Tux Racer MIN_FRICT_SPEED = 2.8 m/s (research 02 sec 3.2): below it there is ' +
        'no friction and therefore no steering authority. A grind is a friction- ' +
        'mediated balance act, so below that speed there is nothing to balance with ' +
        'and the rider cannot lock on (also kills GR-08 phantom locks at 0.4 m/s).',
      stanceBias_rps2:
        'A rider is not symmetric about the rail: the CoM sits to the heel side of ' +
        'the board centreline (the reason heel-side falls dominate). Direction = ' +
        'heel-side axis projected on the rail normal, so it FLIPS when you grind ' +
        'switch and vanishes when the board is square across the rail. Magnitude is ' +
        'fixed by the one feel CHOICE in the balance model: passive bail at 2.2 s on ' +
        'a bare rail, mid-band of GR-05\'s DECLARED 0.8-6 s window (the gate itself ' +
        'states this is a design choice, not a citation). tau is then whatever the ' +
        'damped plant needs to reach theta_bail from rest in exactly 2.2 s — computed ' +
        'from the closed-form step response at load time, not typed in. Bail time is ' +
        'logarithmic in tau (doubling tau moves it ~0.5 s), so the feel is robust. ' +
        'CHOICE cost: 2.2 s is long enough to enjoy a straight rail and short enough ' +
        'that doing nothing is never a strategy.',
      controlAuthority_rps2:
        'Full stick = about 1 g of lateral CoM acceleration for a braced athlete, so ' +
        'theta_ctrl = g/h = 9.91 rad/s^2 — the same g/h that destabilises the ' +
        'pendulum, i.e. the rider is exactly strong enough to fight their own weight ' +
        'at a 1 rad lean. At the bail limit (0.1 rad) that is ~10x authority, which ' +
        'nulls a full lean in sqrt(2*theta_bail/K) = 0.14 s. It is SECOND order, so ' +
        'it overshoots and has to be released — the first-order high-authority ' +
        'corrector the earlier cycles shipped could not be lost by a player watching ' +
        'it, because it had no overshoot and nothing to feel.',
      bailCondition:
        'Not |balance| > 1 alone (the contract keeps that), but the recoverability ' +
        'form of it: from the current (lean, lean-rate), apply FULL stick against the ' +
        'lean with the current curvature left in place and solve in closed form for ' +
        'the single turning point where lean-rate returns to zero. Bail fires when the ' +
        'lean is moving OUTWARD and that peak is past the edge — i.e. the moment the ' +
        'fall is arithmetically unrecoverable, not when the rider crosses a line. ' +
        'This is what makes the mechanic second order and losable: lean-rate, not ' +
        'lean, is what kills you, so a corner taken late is gone before |balance| ' +
        'looks alarming. ' +
        'On release the toppling CoM velocity (thetaDot x h) is added to the board as ' +
        'a lateral kick, which is what actually carries the rider off the rail.',
      captureConversion:
        'alongSpeed = v . tangent using the FULL 3D velocity, not the horizontal ' +
        'projection: converting horizontal speed only taxes a rider 9.4% on a 25 deg ' +
        'descending rail and 23% at 40 deg — on the exact case a rail is meant to win. ' +
        'The perpendicular component is absorbed by the rail (that is what a rail ' +
        'does) and reappears as the initial lean RATE: thetaDot0 = v_lateral/h. ' +
        'Position error is NOT converted to lean — the legs absorb it, which is what ' +
        'the capture radius physically is.',
      gravityAlongTangent:
        'a_grav = -g * tangent.y, always applied. Every test rail in the runner sits ' +
        'at constant height, which once hid a missing gravity term here; a descending ' +
        'rail must accelerate the rider and an uphill rail must cost speed.',
      boostThrust_mps2:
        'Boost is modelled as a thrust, not a target speed: A_BOOST = the thrust that ' +
        'holds physics\' own V_BOOST (31 m/s) against the SNOW law = mu*g + lambda*31 ' +
        '= 7.23 m/s^2. Applied against the rail law it equilibrates at 55 m/s and is ' +
        "therefore clamped by physics' V_CAP 33 — strictly faster than the 31 it buys " +
        'on snow, which is the one verbatim sourced sentence about rails. No free ' +
        'parameter, and no clamp below V_CAP.',
      snapHalfLife_s:
        'The rail\'s normal force has to be expressed as velocity (GR-07 forbids a ' +
        'position write), so the board is held to the line by a constraint spring of ' +
        'half-life 0.05 s (3 frames) plus an exact cancellation of whatever gravity ' +
        'physics applied last frame, MEASURED as (what I wrote to vel.y) - (what I ' +
        'read back) rather than assumed, so it is correct under any gravityScale and ' +
        'in either physics state. Residual tracking error on a 40 m arc at 18 m/s is ' +
        'the chord sagitta, ~1 mm. CHOICE cost: much longer sags visibly; one frame ' +
        'would be a teleport wearing a velocity costume.',
      curvatureWindow:
        'Curvature is a central difference of the tangent over max(board length, ' +
        '2 x mean segment length): below the polyline\'s own vertex spacing the ' +
        'answer is quantisation noise, and below a board length the rider cannot ' +
        'feel it. Exact 1/R on a constant-radius arc, exact 0 on a straight rail. ' +
        'REF_RADIUS-style borrowing from the gate is avoided: no runner constant ' +
        '(40, 80, 28, 120) appears anywhere in this module.',
      constrainedPolicy:
        'constrained = true only while input.crouch is held on the rail (the ollie ' +
        'load), false otherwise and on every exit path. See the header: permanent ' +
        'constrained freezes the rider (0.000 m in 3.70 s — physics integrates nothing ' +
        'while constrained and GR-07 forbids the module from writing position) and ' +
        'zeroes rail spin (spinDeg 0.0 after 4 s of spin input, GR-10 at 0). Measured ' +
        'here instead: 0.85 s load -> charge 0.980 -> 4.94 m/s pop, 0.34 s load -> ' +
        '0.373 -> 3.18 m/s, vs a flat 2.10 m/s J_MIN without the state, at a cost of ' +
        '12.81 m / 5.02 m of un-travelled rail during the load.',
    },
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // internals
      _idx: -1, _s: 0, _theta: 0, _thetaDot: 0, _thetaBail: THETA_BAIL_REF,
      _tan: [0, 0, 1], _nrm: [1, 0, 0], _kappa: 0, _con: false,
      _lastVy: null, _gComp: 0, _exit: null,
      _blockId: null, _cool: 0, _coolId: null,
    };
  }

  // Horizontal "positive-steer" normal: physics turns the board toward
  // t x yUp for steer > 0, so a lean toward this vector is exactly the lean a
  // positive steer input corrects. (Runner convention: +steer reduces +balance.)
  function normalOf(t) {
    const nx = -t[2], nz = t[0];
    const m = Math.hypot(nx, nz);
    return m > 1e-9 ? [nx / m, 0, nz / m] : [1, 0, 0];
  }

  // Support half-base under the board: the rail always gives its own width; a
  // board turned across the rail gives its own length ("turn sideways to
  // balance easier").
  function halfBase(rail, tan, heading) {
    const th = Math.hypot(tan[0], tan[2]);
    let sinPsi = 0;
    if (th > 1e-9) {
      const fx = Math.cos(heading), fz = Math.sin(heading);
      sinPsi = Math.abs((fx * tan[2] - fz * tan[0]) / th);
    }
    return 0.5 * Math.max(rail.width, BOARD_L * sinPsi);
  }

  // Signed, closed-form along-rail speed: v' = D - sign(v)*F0 - lam*v.
  // Linear ODE, integrated exactly -> one 100 ms step == ten 10 ms steps.
  function flowV(v0, D, F0, lam, dt) {
    const sgn = v0 >= 0 ? 1 : -1;
    const a = D - sgn * F0;
    const veq = a / lam;
    let v = veq + (v0 - veq) * Math.exp(-lam * dt);
    // Coulomb stiction: friction may stop the board but never reverse it.
    if (sgn > 0 && v < 0 && D <= F0) v = 0;
    if (sgn < 0 && v > 0 && -D <= F0) v = 0;
    return clamp(v, -PH.V_CAP, PH.V_CAP);
  }

  function leave(gs, ps, reason, poppedByPhysics) {
    const v = gs.alongSpeed, t = gs._tan;
    if (!poppedByPhysics) {
      // Clean exit: the along-rail velocity is carried out untouched (no drag
      // step on the exit frame) — "jump-off preserves speed".
      ps.vel[0] = t[0] * v; ps.vel[1] = t[1] * v; ps.vel[2] = t[2] * v;
    } else {
      // Physics already ran the TRUE takeoff this frame: its vertical impulse
      // is the jump and must not be overwritten. Horizontal stays tangential.
      ps.vel[0] = t[0] * v; ps.vel[2] = t[2] * v;
    }
    if (reason === 'bail') {
      // The rider topples off with the lateral CoM velocity they had.
      const vLat = gs._thetaDot * H_COM;
      ps.vel[0] += gs._nrm[0] * vLat; ps.vel[2] += gs._nrm[2] * vLat;
      gs.bailed = true;
      // You fell off it: no re-capture of THIS rail until you are clear of it.
      gs._blockId = gs.railId;
      gs._cool = 0;
    } else {
      // You left it deliberately (or ran out of rail): this rail is off limits
      // for the length of the shortest hop, so it cannot re-snatch you.
      gs._blockId = null;
      gs._cool = T_HOP; gs._coolId = gs.railId;
    }
    if (gs._con) ps.constrained = false;   // only ever clear our own flag
    gs._con = false;
    gs.onRail = false; gs.railId = null; gs._idx = -1;
    gs.lastLeaveSpeed = Math.abs(v);
    gs.lockFrames = 0; gs.alongSpeed = 0; gs.balance = 0;
    gs._theta = 0; gs._thetaDot = 0; gs._lastVy = null; gs._gComp = 0;
    gs._exit = reason;
  }

  function step(gs, ps, inp = {}, dt) {
    if (!(dt > 0) || !ps) return gs;
    const steer = clamp(inp.steer ?? 0, -1, 1);

    // ---------------------------------------------------------------- exit --
    if (gs.onRail) {
      // If this module set constrained and physics cleared it, physics has
      // just performed the charged takeoff for us on this very frame.
      const popped = gs._con && ps.constrained === false;
      if (popped || inp.jumpRelease) { leave(gs, ps, 'jump', popped); return gs; }
    }

    // ------------------------------------------------------------- capture --
    if (!gs.onRail) {
      // Never leave OUR stale flag behind — but never clear one we did not set
      // (a wallride/tow module may own it later).
      if (gs._con) { ps.constrained = false; gs._con = false; }
      let best = null, bi = -1;
      for (let i = 0; i < rails.length; i++) {
        const c = closest(rails[i], ps.pos);
        if (c && (!best || c.d < best.d)) { best = c; bi = i; }
      }
      if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);
      if (!best) return gs;
      const rid = rails[bi].id;
      if (best.d > CAPT && gs._blockId === rid) gs._blockId = null;   // clear of it
      const guarded = gs._blockId === rid || (gs._cool > 0 && gs._coolId === rid);
      const along = ps.vel[0] * best.u[0] + ps.vel[1] * best.u[1] + ps.vel[2] * best.u[2];
      // AUTO lock-on: no button. Research 02 sec 1.5 tests capture while
      // airborne-descending or on the contact frame.
      const eligible = ps.onGround || ps.vel[1] <= 0;
      if (best.d <= CAPT && !guarded && eligible && Math.abs(along) >= MIN_LOCK) {
        const rail = rails[bi];
        // THE one documented position write: snap to the closest point.
        ps.pos[0] = best.q[0]; ps.pos[1] = best.q[1]; ps.pos[2] = best.q[2];
        const dir = along >= 0 ? 1 : -1;
        const tan = [best.u[0] * dir, best.u[1] * dir, best.u[2] * dir];
        const nrm = normalOf(tan);
        gs.onRail = true; gs._idx = bi; gs.railId = rail.id;
        gs.alongSpeed = along;                       // FULL 3D speed on tangent
        gs._s = best.s; gs.t = rail.S > 0 ? clamp(best.s / rail.S, 0, 1) : 0;
        gs._tan = tan; gs._nrm = nrm;
        gs.bailed = false; gs.lockFrames = 0; gs._exit = null;
        // The rail absorbs the perpendicular momentum; the rider's CoM does not
        // get the memo, so it arrives as lean RATE.
        gs._theta = 0;
        gs._thetaDot = (ps.vel[0] * nrm[0] + ps.vel[2] * nrm[2]) / H_COM;
        gs._thetaBail = Math.atan(halfBase(rail, tan, ps.heading) / H_COM);
        gs.balance = clamp(gs._theta / gs._thetaBail, -1, 1);
        gs._lastVy = null; gs._gComp = 0;
      } else {
        return gs;
      }
    }

    // ------------------------------------------------------------- on rail --
    const rail = rails[gs._idx];
    const crouching = !!inp.crouch;

    // Measure whatever physics applied to vertical velocity since our last
    // write; that is the rail's normal-force budget for this frame.
    if (gs._lastVy !== null) {
      const applied = gs._lastVy - ps.vel[1];
      gs._gComp = clamp(applied, 0, 2 * PH.G_GROUND * dt);
    }

    // --- project ------------------------------------------------------------
    const c = closest(rail, ps.pos);
    const dir = gs.alongSpeed >= 0 ? 1 : -1;
    const tan = [c.u[0] * dir, c.u[1] * dir, c.u[2] * dir];
    const nrm = normalOf(tan);
    gs._tan = tan; gs._nrm = nrm; gs._s = c.s;
    gs.t = rail.S > 0 ? clamp(c.s / rail.S, 0, 1) : 0;
    gs._thetaBail = Math.atan(halfBase(rail, tan, ps.heading) / H_COM);

    // --- balance: closed-form second order ---------------------------------
    // theta'' = w0^2*theta + F,  F = bias(stance) - a_lateral/h - K*steer
    // Signed curvature about the correction normal; a_lat = v^2 * kappa_n.
    const kap = curvatureN(rail, c.s, nrm);
    gs._kappa = kap;
    const v0 = gs.alongSpeed;
    const aLat = v0 * v0 * kap;
    // Heel side of the board = board forward x yUp. CHOICE of which side is
    // 'heel' (regular vs goofy); flipping it mirrors the drift. Projected on
    // the rail normal, so it vanishes when the board is square across the rail
    // and flips when the rider grinds switch.
    const heelDot = -Math.sin(ps.heading) * nrm[0] + Math.cos(ps.heading) * nrm[2];
    const Fext = TAU_BIAS * heelDot - aLat / H_COM;
    const F = Fext - K_CTRL * steer;
    const ev = evolve(gs._theta, gs._thetaDot, F, dt);
    gs._theta = ev[0]; gs._thetaDot = ev[1];
    gs.balance = clamp(gs._theta / gs._thetaBail, -1, 1);

    // --- bail: the recoverability form of |balance| > 1 --------------------
    const th = gs._theta, td = gs._thetaDot, tb = gs._thetaBail;
    const outward = th * td > 0;
    if (Math.abs(th) > tb ||
        (outward && Math.abs(peakLean(th, td, Fext)) > tb)) {
      leave(gs, ps, 'bail', false); return gs;
    }

    // --- along-rail speed: closed form, dt-exact ---------------------------
    let v = v0;
    if (!gs._con) {                                    // frozen while loading
      const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
      // Gravity along the tangent — resolved in the POLYLINE's frame, which is
      // the frame alongSpeed is signed in (resolving it in the travel frame
      // flips the sign of gravity for a switch/backwards grind). Every test
      // rail in the runner is flat, so nothing here would have caught that.
      let D = -PH.G_GROUND * c.u[1];
      if (boosting) D += A_BOOST * dir;    // thrust acts along travel
      v = flowV(v0, D, MU_R * PH.G_GROUND, LAM_R, dt);
      gs.alongSpeed = v;
    }

    // --- leaving conditions -------------------------------------------------
    if (Math.abs(v) < MIN_LOCK) { leave(gs, ps, 'stall', false); return gs; }
    if (c.d > CAPT) { leave(gs, ps, 'lost', false); return gs; }
    if ((dir > 0 && c.s >= rail.S - 1e-6) || (dir < 0 && c.s <= 1e-6)) {
      if (gs.lockFrames > 0) { leave(gs, ps, 'end', false); return gs; }
    }

    // --- drive: velocity only (position is physics'), plus the constraint ---
    const kSnap = (1 - Math.exp(-K_SNAP * dt)) / dt;    // dt-exact spring rate
    const ex = (c.q[0] - ps.pos[0]) * kSnap;
    const ey = (c.q[1] - ps.pos[1]) * kSnap;
    const ez = (c.q[2] - ps.pos[2]) * kSnap;
    ps.vel[0] = tan[0] * v + ex;
    ps.vel[1] = tan[1] * v + ey + gs._gComp;
    ps.vel[2] = tan[2] * v + ez;
    gs._lastVy = ps.vel[1];

    // --- constrained: engaged only for the ollie load (see header) ----------
    ps.constrained = crouching;
    gs._con = crouching;

    gs.lockFrames++;
    return gs;
  }

  return { config, init, step };
}
