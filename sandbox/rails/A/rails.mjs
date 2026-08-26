// Candidate A — rail grinding (spline projection + banked-pendulum balance)
//
// SHAPE OF THE MODULE (three laws, everything else is bookkeeping):
//   1. GEOMETRY   every frame, project pos onto the rail polyline -> closest
//      point, 3D unit tangent, signed horizontal curvature, arc length.
//   2. MOTION     the module owns ONE scalar, alongSpeed, integrated in closed
//      form (dv/dt = A - B v, A = gravity-along-tangent + boost thrust -
//      Coulomb, B = linear rail drag). It is written to physics as VELOCITY
//      only: v = T*alongSpeed + (P_rail - pos)/TAU_SNAP. The second term is
//      Baumgarte constraint stabilisation — it is how a constraint is held
//      without teleporting, and it is why this module writes position exactly
//      once per lock (the documented snap) and never again (GR-07).
//   3. BALANCE    a second-order inverted-pendulum state about the rail axis,
//      destabilised by gravity, loaded by rail curvature, corrected by steer.
//      |balance| > 1 = the CoM has passed the rail edge = bail.
//
// WHY THE RIDER IS AIRBORNE WHILE GRINDING: the lock snap puts the board on the
// rail line, which is above the terrain, so physics runs its AIR path. That is
// deliberate: airStep leaves horizontal velocity untouched (so the exit
// preserves speed exactly, GR-04) and still spins the board (so rail spins are
// real, GR-10). The ground path would carve the board under us every frame.
//
// CONSTRAINED STATE — read this before judging it. physics' constrainedStep
// supplies NO motion at all (verified: PC-16 requires pos and vel literally
// unchanged over 5 s), and GR-07 forbids this module from writing position.
// Holding ps.constrained every on-rail frame would therefore PARK the rider on
// the rail: nothing would integrate position. So constrained is held exactly
// where its services are the whole point and its cost is bounded — while the
// rider is loading a pop (crouch held, plus 2 frames of grace so the
// jumpRelease frame lands inside it). Physics then accrues charge at T_CHARGE,
// captures prewind, holds airTime at 0, and turns jumpRelease into a TRUE
// full-charge takeoff. MEASURED, straight rail, 0.85 s load then release:
// charge 1.000, pop 5.108 m/s (J_MAX 5.0 + 0.108 of constraint correction),
// 2.01 m apex, prewind carried, horizontal speed changed by 0.00%. A 0.20 s
// load gives charge 0.216 and a 0.62 m pop. The rail-into-big-air link works.
// COST, measured: the along-rail advance stalls for the duration of the crouch
// — over one full 0.85 s load the rider reaches z = 27.5 m instead of 39.3 m,
// i.e. 11.8 m of rail eaten. A jumpRelease with NO crouch frame at all gets no
// impulse (physics never saw a charge to spend); it still leaves at exactly the
// speed it was carrying.
// THE FIX BELONGS IN PHYSICS, and it is one line: `st.pos[i] += st.vel[i]*dt`
// in constrainedStep. VERIFIED by running physics-runner's own constrained
// scenarios against a patched copy: PC-14 charge 1.0 at 1 s, PC-15 pop 5.000
// with airTime 0 / spin reset / prewound 1, PC-16 noFall still TRUE (it asserts
// pos[1] and vel[1], which a tangent velocity leaves alone) — and the rider
// advances 80 m in 5 s at 16 m/s instead of standing still. With that line
// present this module can hold constrained continuously and the stall vanishes;
// it is written so either behaviour works, because position is RE-PROJECTED
// every frame and never integrated here.
//
// CONSTANTS: every number is derived from the project conventions (rider 1.8 m,
// g, 60 Hz), from the rail's OWN geometry (its width, its curvature), or from
// physics.mjs' exported DEFAULTS — which are IMPORTED, not copied, so they
// cannot drift. FOUR numbers are taste (X_SEED, ZETA_B, TAU_SNAP, BOARD_L);
// each is labelled CHOICE below and in config.derivation, with its cost in
// units a player feels.
//
// Pure JS, deterministic, no Date/random.

import { DEFAULTS as PHYS } from '../../../src/physics/physics.mjs';

const G = PHYS.G_GROUND;      // 9.81 m/s^2
const H_RIDER = 1.8;          // m — CONTRACTS.md conventions ("rider 1.8 m / 80 kg")
const D_COM = H_RIDER / 2;    // m — CoM height above the rail for a uniform rod

// --- derived balance constants (see config.derivation) -----------------------
// Uniform rod of height H pivoting on the rail axis: I = m H^2/3, moment arm
// H/2, so theta'' = (g (H/2) / (H^2/3)) theta = (3g/2H) theta.
const W2_INST = 1.5 * G / H_RIDER;          // 8.175 s^-2  (instability)
const W_INST = Math.sqrt(W2_INST);          // 2.859 rad/s
// Control authority: the rider moves the centre of pressure within the rail's
// half-width b = w/2. theta'' = (3 g b / H^2). Normalised by the bail lean
// theta_max = b/(H/2) = w/H this is (3gb/H^2)/(w/H) = 1.5 g/H == W2_INST.
// Full stick therefore exactly cancels the instability AT the bail lean — the
// mechanic is marginal by construction, not by tuning.
const K_CTRL = W2_INST;                     // 8.175 s^-2, in balance units
// Curvature load. A curve accelerates the contact laterally by a = v^2 kappa.
// Unbanked, the rider holds only a = g theta_max. A rider who banks into the
// curve holds a full g (45 deg lean = 1 g, the standard bicycle reference —
// CHOICE, cost below). Residual fraction (1-eta) = theta_max, so the load in
// balance units is (1.5 (1-eta)/w) a = 1.5 a / H: the rail width cancels.
const C_LOAD = 1.5 / H_RIDER;               // 0.8333 m^-1
const A_LAT_HOLD = K_CTRL / C_LOAD;         // 9.81 m/s^2 = g, by construction

// --- CHOICES (four; costs stated) -------------------------------------------
const X_SEED = 0.01;    // m  CHOICE: CoM cross-rail offset the instant you land
const TAU_SNAP = 0.10;  // s  CHOICE: constraint-stabilisation time constant
const BOARD_L = 1.55;   // m  CHOICE: board length (0.86*H, the chin-height rule)
const ZETA_B = 0.4;     //    CHOICE: lean-rate damping, as a fraction of W_INST
const C_DAMP = 2 * ZETA_B * W_INST;   // 2.287 s^-1
// NOTE: this is NOT critical damping and there is no such thing here. The
// characteristic equation is lam^2 + C_DAMP*lam - W2_INST = 0, whose
// discriminant C_DAMP^2 + 4*W2_INST is positive for every C_DAMP: an inverted
// pendulum always has two real roots, one of them positive. Damping slows the
// divergence, it never removes it.
const RDISC = Math.sqrt(C_DAMP * C_DAMP + 4 * W2_INST);
const LAM1 = (-C_DAMP + RDISC) / 2;   // > 0, the divergence
const LAM2 = (-C_DAMP - RDISC) / 2;   // < 0

// --- rail drag ---------------------------------------------------------------
// Tux Racer's terrain table (research 02 sec 3.1) is the only sourced friction
// data in the corpus, and it carries a CONTACT DEPTH column: ice mu=0.20 at
// 0.03 m, snow mu=0.35 at 0.11 m. A rail does not deform at all -> depth 0.
// Extrapolating the ice->snow line to zero depth: mu(0) = 0.20 - 1.875*0.03 =
// 0.14375, i.e. 0.4107x snow. This is a MODEL, not a measurement: the table has
// no rail row, and research 02 sec 5's only rail statement is "drag ~ 0", which
// taken literally makes a rail a frictionless accelerator.
const DRAG_SCALE = (0.20 - (0.35 - 0.20) / (0.11 - 0.03) * 0.03) / 0.35; // 0.410714
// Tux Racer MIN_FRICT_SPEED (research 02 sec 3.2): below it there is no
// steering authority at all. A grind with no steering authority is not a grind.
const MIN_LOCK = 2.8;   // m/s
// Boost: physics holds V_BOOST on snow, so the thrust it applies is
// F0_snow + lambda_snow*V_BOOST. The SAME thrust on the rail meets the rail's
// smaller drag; where it settles is emergent (and clamps at V_CAP).
const THRUST_BOOST = PHYS.MU_BASE * G + PHYS.LAMBDA_LONG * PHYS.V_BOOST;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Exact flow of dv/dt = a - b v (v >= 0). Coulomb-style clamp at 0 on a
// monotone-decreasing path, so one big step == many small ones (GR-09).
function flow(v0, a, b, dt) {
  if (b <= 1e-12) { const v = v0 + a * dt; return a <= 0 ? Math.max(v, 0) : v; }
  const veq = a / b;
  const v = veq + (v0 - veq) * Math.exp(-b * dt);
  return a <= 0 ? Math.max(v, 0) : v;
}

// ---------------------------------------------------------------------------
// Geometry: polyline preprocessing. Arc length, 3D unit tangents, and a signed
// horizontal curvature per vertex.
// ---------------------------------------------------------------------------
function prep(rail) {
  const P = rail.points.map(p => [p[0], p[1], p[2]]);
  const n = P.length - 1;
  const seg = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], dz = P[i + 1][2] - P[i][2];
    const L = Math.hypot(dx, dy, dz) || 1e-9;
    const hL = Math.hypot(dx, dz) || 1e-9;
    seg.push({ s0: total, L, tan: [dx / L, dy / L, dz / L], ang: Math.atan2(dz / hL, dx / hL) });
    total += L;
  }
  // Signed horizontal curvature at each vertex: turn angle between the two
  // adjacent chords divided by the mean half-chord spacing. On a polyline
  // sampling a circle of radius R with per-segment sweep da this returns
  // (1/R)(1 + da^2/6 + ...) — an O(da^2) ESTIMATE, not an exact 1/R.
  const kv = new Array(n + 1).fill(0);
  for (let i = 1; i < n; i++) {
    const turn = wrapPi(seg[i].ang - seg[i - 1].ang);
    kv[i] = turn / (0.5 * (seg[i - 1].L + seg[i].L));
  }
  if (n >= 2) { kv[0] = kv[1]; kv[n] = kv[n - 1]; }
  // Per-vertex tangents = normalised sum of the two adjacent chords. A CHORD is
  // NOT the tangent: on a curve it is rotated by half the segment's sweep, and
  // that bias is not physics — it is the sampling. On the runner's own arc it
  // was worth 0.52 m/s of fake cross-track velocity at the capture frame (a
  // lean-rate seed of 4.9/s, which ejected the rider in 9 frames and would have
  // read as "curved rails are brutal"). At a vertex of a circle the bisector of
  // the two chords IS the exact tangent; on a straight rail it is the identity.
  const unit = v => { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; };
  const tv = new Array(n + 1);
  for (let i = 1; i < n; i++) {
    const a = seg[i - 1].tan, b = seg[i].tan;
    tv[i] = unit([a[0] + b[0], a[1] + b[1], a[2] + b[2]]);
  }
  // End vertices have only one chord, and that chord carries the FULL half-sweep
  // bias — which is exactly where capture happens, so it cannot be waved off.
  // Extrapolate from the first interior tangent: t0 = 2*chord0 - t1.
  tv[0] = n >= 2 ? unit([2 * seg[0].tan[0] - tv[1][0], 2 * seg[0].tan[1] - tv[1][1],
    2 * seg[0].tan[2] - tv[1][2]]) : seg[0].tan;
  tv[n] = n >= 2 ? unit([2 * seg[n - 1].tan[0] - tv[n - 1][0], 2 * seg[n - 1].tan[1] - tv[n - 1][1],
    2 * seg[n - 1].tan[2] - tv[n - 1][2]]) : seg[0].tan;
  return { id: rail.id, P, seg, kv, tv, length: total, width: rail.width ?? 0.2 };
}

// Closest point on the polyline to p. Returns arc length, point, 3D tangent,
// signed curvature (linearly interpolated between vertex values), distance,
// and whether the projection ran off an end.
function closest(R, p) {
  let best = null;
  for (let i = 0; i < R.seg.length; i++) {
    const a = R.P[i], s = R.seg[i];
    const wx = p[0] - a[0], wy = p[1] - a[1], wz = p[2] - a[2];
    let u = (wx * s.tan[0] + wy * s.tan[1] + wz * s.tan[2]) / s.L;
    const raw = u;
    u = clamp(u, 0, 1);
    const q = [a[0] + s.tan[0] * u * s.L, a[1] + s.tan[1] * u * s.L, a[2] + s.tan[2] * u * s.L];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
    if (!best || d < best.d) {
      const t0 = R.tv[i], t1 = R.tv[i + 1];
      const tx = t0[0] + (t1[0] - t0[0]) * u, ty = t0[1] + (t1[1] - t0[1]) * u,
        tz = t0[2] + (t1[2] - t0[2]) * u;
      const tm = Math.hypot(tx, ty, tz) || 1;
      best = { d, i, u, raw, pt: q, s: s.s0 + u * s.L, tan: [tx / tm, ty / tm, tz / tm],
        kap: R.kv[i] + (R.kv[i + 1] - R.kv[i]) * u };
    }
  }
  best.pastEnd = (best.i === R.seg.length - 1 && best.raw >= 1) ? 1 :
                 (best.i === 0 && best.raw <= 0) ? -1 : 0;
  return best;
}

export function createRails(env = {}) {
  const rails = (env.rails ?? [])
    .filter(r => r && Array.isArray(r.points) && r.points.length >= 2)
    .map(prep);

  const captureRadius_m = BOARD_L / 2;   // the board reaches the rail if the
  // rail line passes under its footprint; worst orientation (board ACROSS the
  // rail, which is the grind stance) makes that half a board length.
  const wRef = rails.length ? rails[0].width : 0.2;
  const thetaMaxRef = wRef / H_RIDER;

  // Per-rail balance scaling. theta_max = (w/2)/(H/2) = w/H is the lean at
  // which the CoM passes outside the rail edge. A wide box is forgiving; a
  // 0.2 m round rail is not. Nothing here is a tuned number.
  const thetaMax = R => R.width / H_RIDER;
  const seedOf = R => X_SEED / (R.width / 2);      // lean seed in balance units
  const rateScale = R => 1 / (D_COM * thetaMax(R)); // cross-track m/s -> balance/s

  const config = {
    // --- contract-required ---
    captureRadius_m,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / LAM1,
    curveTolerance_rad: (K_CTRL / (C_LOAD * 400)) * BOARD_L,
    minLockSpeed_mps: MIN_LOCK,
    // --- exposed model constants ---
    balanceInstability_radps: W_INST,
    balanceDamping_s: C_DAMP,
    balanceDivergenceRate_s: LAM1,
    balanceControl_s2: K_CTRL,
    curveLoadCoeff_perm: C_LOAD,
    maxHeldLateralAccel_mps2: A_LAT_HOLD,
    balanceSeed: X_SEED,
    constraintTau_s: TAU_SNAP,
    boardLength_m: BOARD_L,
    railThrustBoost_mps2: THRUST_BOOST,
    vCap_mps: PHYS.V_CAP,
    railMu: PHYS.MU_BASE * DRAG_SCALE,
    railLambda_s: PHYS.LAMBDA_LONG * DRAG_SCALE,
    referenceRailWidth_m: wRef,
    referenceBailLean_rad: thetaMaxRef,
    derivation: {
      captureRadius_m:
        'BOARD_L/2 = 0.775 m. The capture test is on the board CENTRE; the board ' +
        'touches the rail whenever the rail line passes under its footprint, and in ' +
        'the grind stance the board lies ACROSS the rail, so the reach is half a ' +
        'board length. Lands inside research 02 sec 1.5 [EST] 0.5-1.5 m without ' +
        'being read off it. BOARD_L = 1.55 m is a CHOICE (0.86*H, the chin-height ' +
        'sizing rule; the corpus has no board dimension). Cost: +-0.1 m of board ' +
        'length moves the capture radius +-0.05 m, i.e. the miss you can still ' +
        'convert into a grind.',
      dragScale:
        '0.4107 = mu(depth 0)/mu(snow) from Tux Racer terrain table (research 02 ' +
        'sec 3.1), extrapolating the ice(0.20 @ 0.03 m) -> snow(0.35 @ 0.11 m) ' +
        'line to zero contact depth, which is what a rail is. MODEL, not a ' +
        'measurement — the table has no rail row, and sec 5 only says rail drag is ' +
        '"approximately 0", which taken literally is a perpetual accelerator. It ' +
        'scales BOTH terms of the physics-lane law (mu*g + lambda*v). Cost, ' +
        'measured on the flat: from 20 m/s a rail holds 12.1 m/s after 5 s where ' +
        'snow holds 5.6 m/s; the ice ratio 0.571 would give 9.9 m/s and a literal ' +
        '0 would give 20.0 m/s forever.',
      minLockSpeed_mps:
        '2.8 = Tux Racer MIN_FRICT_SPEED (research 02 sec 3.2): below it friction, ' +
        'and therefore steering authority, is zero. A grind you cannot steer is ' +
        'not a grind, so it is also the floor for capture. Cost: a rider dribbling ' +
        'onto a rail at walking pace slides past it instead of locking.',
      balanceHalfLife_s:
        'ln2/LAM1 = 0.358 s. THE NAME IS THE CONTRACT\'S, not the mechanic\'s: ' +
        'this model has no first-order decay, so the honest quantity under that ' +
        'key is the DOUBLING time of an unattended lean. LAM1 = 1.936 s^-1 is the ' +
        'positive root of lam^2 + C_DAMP*lam - W2_INST = 0; undamped it would be ' +
        'W_INST = sqrt(3g/2H) = 2.859 rad/s, the inverted-pendulum rate of a ' +
        'uniform 1.8 m rod pivoting on the rail axis (I = mH^2/3, arm H/2).',
      curveTolerance_rad:
        '0.0380 rad = (K_CTRL/(C_LOAD v^2)) * BOARD_L at v = 20 m/s (mid of the ' +
        'tuck-cruise band, research 02 sec 1.6 [EST]): the rail bend ' +
        'PER BOARD LENGTH that full stick can still hold at cruise. Equivalent ' +
        'R_min = v^2/9.81 = 40.8 m at 20 m/s, 82 m at 28.4 m/s (boost). Speed-' +
        'dependent by construction (R = v^2/a), so the single scalar is quoted at ' +
        'a reference speed, not a property of the rail.',
      balanceModel:
        'b\'\' = W2_INST*b - C_LOAD*(v^2 kappa) - K_CTRL*steer, b = lean/theta_max, ' +
        'theta_max = w/H (CoM passes the rail edge). W2_INST = K_CTRL = 1.5g/H = ' +
        '8.175 s^-2: the control term is the centre-of-pressure bound 3gb/H^2 ' +
        'normalised by theta_max, and it EQUALS the instability, so full stick ' +
        'exactly cancels a full-threshold lean. Genuinely SECOND order — the ' +
        'state carries lean rate, so a correction overshoots and there is ' +
        'something to feel; a first-order balance with high authority cannot be ' +
        'lost by a player who is watching it. Integrated in closed form over ' +
        'each step with the forcing held constant (two real distinct roots ' +
        'LAM1 > 0 > LAM2); an inverted pendulum has no critical damping and none ' +
        'is claimed. NOTHING in this law reads ps.heading: nothing rotates the ' +
        'board toward the rail during a grind, so a threshold built on heading ' +
        'would drift, not measure.',
      curveLoad:
        'C_LOAD = 1.5/H = 0.833 m^-1. A curve accelerates the contact laterally by ' +
        'a = v^2 kappa. Unbanked the rider holds only a = g*theta_max (~1.1 m/s^2 ' +
        'on a 0.2 m rail) — no curved rail would be rideable. A rider who banks ' +
        'into it holds a full g: 45 deg of lean is 1 g, the standard bicycle ' +
        'reference. That is the CHOICE. It fixes the bank-compensated fraction at ' +
        'eta = 1 - theta_max and cancels the rail width out of the load, leaving ' +
        '1.5/H. Cost: R_min = v^2/g — 33 m at 18 m/s, 82 m at 28 m/s; tighter than ' +
        'that and no amount of stick holds it. A 30 deg bank cap would give ' +
        'R_min = v^2/5.66 and make every curve in the game unrideable at speed.',
      balanceSeed:
        'X_SEED = 0.01 m CHOICE: the CoM cross-rail offset at the instant of ' +
        'capture, i.e. 1 cm off-centre on a 20 cm rail. In balance units that is ' +
        'X_SEED/(w/2) = 0.10 on a 0.2 m rail and 0.033 on a 0.6 m box. It exists ' +
        'because a dead-centre capture with zero cross-track velocity has NO ' +
        'physical perturbation and would ride a straight rail forever; GR-05 ' +
        'declares (in its own statement) that the passive-bail window is a design ' +
        'choice and not a citation, and this is the number that sets it. Cost, ' +
        'measured: passive life on a straight rail 1.40 s at 1 cm (the runner ' +
        'reads 1.40 s against its declared 0.8-6 s window), ~1.8 s at 0.5 cm, ' +
        '~1.0 s at 2 cm. Capture with cross-track velocity adds a REAL rate seed, ' +
        'v_perp/(D_COM*theta_max), on top of it — land sideways on a rail and you ' +
        'are already falling.',
      constraintTau_s:
        'TAU_SNAP = 0.10 s CHOICE: Baumgarte constraint stabilisation. The module ' +
        'may not write position after the lock snap, so the rail is held by a ' +
        'velocity term (P_rail - pos)/TAU that drags residual drift out. Cost: the ' +
        'board rides a steady TAU*g_air*dt = 1.1 cm below the rail line at 60 Hz ' +
        '(the sag where the correction balances one Euler gravity step), and a ' +
        'capture error decays with a 0.1 s time constant. Shorter is stiffer and ' +
        'noisier; longer lets the board visibly hang off a curved rail.',
      alongRail:
        'dv/dt = -g*T_y (gravity along the 3D tangent — included because every ' +
        'test rail in the runner is level and a missing term would not show) ' +
        '+ THRUST_BOOST*[boost] - dragScale*(MU_BASE*g + LAMBDA_LONG*v), clamped ' +
        'at physics V_CAP = 33 and never above it. Closed-form, so one 100 ms step ' +
        'equals ten 10 ms steps exactly. THRUST_BOOST = MU_BASE*g + LAMBDA_LONG*' +
        'V_BOOST = 7.23 m/s^2 is the thrust physics itself must be applying to ' +
        'hold V_BOOST on snow; the rail terminal speed is then emergent (77 m/s ' +
        'unclamped, so V_CAP binds) rather than a second hand-set target. All of ' +
        'MU_BASE/LAMBDA_LONG/V_BOOST/V_CAP are IMPORTED from physics.mjs, not ' +
        'copied, so they cannot drift out of step.',
      balanceDamping:
        'ZETA_B = 0.4 CHOICE -> C_DAMP = 2*ZETA_B*W_INST = 2.287 s^-1, the ' +
        'rider\'s lean-RATE correction (proprioception is rate-dominant; the ' +
        'corpus says nothing about it, so this is taste). It is NOT critical ' +
        'damping: lam^2 + C_DAMP*lam - W2_INST = 0 has discriminant ' +
        'C_DAMP^2 + 4*W2_INST, positive for every value, so the roots are always ' +
        'real and one is always positive. Cost, measured: passive life on a ' +
        'straight rail 1.05 s undamped -> 1.40 s at ZETA_B 0.4, and the ' +
        'permanent wobble goes away — undamped, a corrected lean keeps ringing ' +
        'at its seed amplitude forever, which costs the player 0.29 of mean ' +
        'stick on a STRAIGHT rail (measured) for nothing.',
      captureClosing:
        'Capture also requires the board to be CLOSING on the rail at more than ' +
        '0.05 m/s, per research 02 sec 1.5 [EST] ("tested only while airborne-' +
        'descending or on landing frame"). Two failure modes die with it: the ' +
        'rail re-snatching a rider who just popped off it (measured without the ' +
        'rule: off@1.90 LOCK@1.92, a 5.0 m/s pop reduced to 0.11 m/s), and a ' +
        'rail grabbing a rider running parallel to it half a metre to the side. ' +
        'A rider who pops and falls back onto the same rail is closing again and ' +
        'lands it (measured: off@1.90, re-lock@3.28).',
      capture:
        'alongSpeed = v . T_3D (the FULL velocity dotted with the FULL 3D unit ' +
        'tangent). Projecting only horizontal speed taxes a rider dropping onto a ' +
        'descending rail by 1-cos(theta): 9.4% at 25 deg, 23% at 40 deg — on the ' +
        'exact case a rail is supposed to win.',
    },
  };

  function init() {
    return { onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      _ri: -1, _dir: 1, _bdot: 0, _con: 0, _blockId: null };
  }

  // Release. `why`: 'jump' (rider left under power — velocity is physics' and
  // is left ALONE, so speed and prewind carry), 'end' (ran out of rail — same),
  // 'bail' (lost balance — the CoM's lateral velocity becomes real velocity and
  // the rail is blocked until the rider is clear of it, so a bail is a bail and
  // not a pogo stick).
  function release(gs, ps, R, c, why) {
    gs.onRail = false;
    gs.lastLeaveSpeed = gs.alongSpeed;
    gs.bailed = (why === 'bail');
    gs.railId = null;
    if (gs._con) { ps.constrained = false; gs._con = 0; }
    if (why === 'bail' && R && c) {
      const T = [c.tan[0] * gs._dir, c.tan[1] * gs._dir, c.tan[2] * gs._dir];
      const N = [-T[2], 0, T[0]];               // left normal of travel (horizontal)
      const nl = Math.hypot(N[0], N[2]) || 1;
      // theta_dot * D_COM is the CoM's cross-rail speed as it topples.
      const vLat = clamp(gs._bdot * thetaMax(R) * D_COM, -6, 6);
      ps.vel[0] = T[0] * gs.alongSpeed + (N[0] / nl) * vLat;
      ps.vel[1] = T[1] * gs.alongSpeed;
      ps.vel[2] = T[2] * gs.alongSpeed + (N[2] / nl) * vLat;
      gs._blockId = R.id;
    } else {
      gs._blockId = null;
    }
    gs._ri = -1;
  }

  function step(gs, ps, inp = {}, dt) {
    if (!ps || !Array.isArray(ps.pos) || dt <= 0) return gs;
    const steer = clamp(inp.steer ?? 0, -1, 1);

    // ---------------- ON RAIL ----------------
    if (gs.onRail) {
      const R = rails[gs._ri];
      if (!R) { gs.onRail = false; return gs; }

      // physics turned a charged jumpRelease into a real takeoff and cleared the
      // flag itself: that is the rider leaving under power.
      if (gs._con && ps.constrained === false) { release(gs, ps, R, null, 'jump'); return gs; }
      if (inp.jumpRelease) { release(gs, ps, R, null, 'jump'); return gs; }

      const c = closest(R, ps.pos);
      gs.t = clamp(c.s / R.length, 0, 1);

      // ran off the end (in the direction of travel), or the constraint lost
      // the board entirely
      if ((c.pastEnd === 1 && gs._dir > 0) || (c.pastEnd === -1 && gs._dir < 0) ||
          c.d > captureRadius_m * 3) { release(gs, ps, R, c, 'end'); return gs; }

      gs.lockFrames++;

      // While physics holds us CONSTRAINED it supplies no motion at all, so
      // neither do we: the rider is parked, loading. Balance keeps running —
      // standing still on a rail is not the same as being safe.
      if (ps.constrained) {
        advanceBalance(gs, R, 0, steer, dt);
        if (Math.abs(gs.balance) > 1) { release(gs, ps, R, c, 'bail'); return gs; }
        const owned = gs._con > 0;                 // did WE raise this flag?
        gs._con = Math.max(0, gs._con - 1);
        if (inp.crouch) gs._con = 3;
        // Never clear a flag this module did not set: some other constraint
        // (wallride, tow) may own the rider, and clearing it would drop them.
        if (owned && gs._con === 0) ps.constrained = false;
        return gs;
      }

      // --- along-rail speed: closed form, so dt-exact -----------------------
      const gAlong = -G * c.tan[1] * gs._dir;                 // gravity along travel
      const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
      const A = gAlong + (boosting ? THRUST_BOOST : 0) - PHYS.MU_BASE * G * DRAG_SCALE;
      const B = PHYS.LAMBDA_LONG * DRAG_SCALE;
      gs.alongSpeed = Math.min(flow(gs.alongSpeed, A, B, dt), PHYS.V_CAP);

      // --- balance ----------------------------------------------------------
      advanceBalance(gs, R, gs.alongSpeed * gs.alongSpeed * c.kap * gs._dir, steer, dt);
      if (Math.abs(gs.balance) > 1) { release(gs, ps, R, c, 'bail'); return gs; }
      if (gs.alongSpeed < MIN_LOCK * 0.5) { release(gs, ps, R, c, 'end'); return gs; }

      // --- write VELOCITY only: tangent flow + constraint stabilisation ------
      const T = [c.tan[0] * gs._dir, c.tan[1] * gs._dir, c.tan[2] * gs._dir];
      let ex = c.pt[0] - ps.pos[0], ey = c.pt[1] - ps.pos[1], ez = c.pt[2] - ps.pos[2];
      const em = Math.hypot(ex, ey, ez);
      const cap = captureRadius_m / TAU_SNAP;
      const k = em / TAU_SNAP > cap ? cap / (em / TAU_SNAP) : 1;
      ps.vel[0] = T[0] * gs.alongSpeed + (ex / TAU_SNAP) * k;
      ps.vel[1] = T[1] * gs.alongSpeed + (ey / TAU_SNAP) * k;
      ps.vel[2] = T[2] * gs.alongSpeed + (ez / TAU_SNAP) * k;

      // --- hand the rider to physics for the next frame if a pop is loading --
      if (inp.crouch) gs._con = 3;
      else gs._con = Math.max(0, gs._con - 1);
      if (gs._con > 0) ps.constrained = true;
      return gs;
    }

    // ---------------- OFF RAIL: auto capture, no button ----------------
    for (let i = 0; i < rails.length; i++) {
      const R = rails[i];
      const c = closest(R, ps.pos);
      if (R.id === gs._blockId) {                 // the rail we just fell off
        if (c.d > captureRadius_m * 2) gs._blockId = null;
        continue;
      }
      if (c.d > captureRadius_m) continue;
      const vt = ps.vel[0] * c.tan[0] + ps.vel[1] * c.tan[1] + ps.vel[2] * c.tan[2];
      if (Math.abs(vt) < MIN_LOCK) continue;
      // The board must be CLOSING on the rail. Research 02 sec 1.5 [EST]:
      // capture is tested "while airborne-descending or on landing frame". Two
      // things fall out of it that a pure radius test gets wrong: a rider who
      // has just popped OFF this rail is separating, so the rail cannot snatch
      // them back on the next frame and eat the jump (measured before this
      // rule: off@1.90 LOCK@1.92, the 5.0 m/s pop reduced to 0.11 m/s); and a
      // rider running parallel half a metre to the side is not closing, so a
      // rail beside the line you are riding never grabs you. A rider who pops
      // and comes back DOWN onto the same rail is closing again, and lands it.
      if (c.d > 1e-6) {
        const rate = ((ps.pos[0] - c.pt[0]) * ps.vel[0] + (ps.pos[1] - c.pt[1]) * ps.vel[1] +
          (ps.pos[2] - c.pt[2]) * ps.vel[2]) / c.d;
        if (rate > -0.05) continue;
      }

      const dir = vt >= 0 ? 1 : -1;
      gs.onRail = true; gs.railId = R.id; gs._ri = i; gs._dir = dir;
      gs.alongSpeed = Math.abs(vt);               // FULL 3D velocity onto the tangent
      gs.t = clamp(c.s / R.length, 0, 1);
      gs.bailed = false; gs.lockFrames = 1;

      // balance seed: the cross-track velocity the CoM keeps through the
      // capture (real), plus the 1 cm off-centre landing (CHOICE).
      const T = [c.tan[0] * dir, c.tan[1] * dir, c.tan[2] * dir];
      const N = [-T[2], 0, T[0]];
      const nl = Math.hypot(N[0], N[2]) || 1;
      const vPerp = (ps.vel[0] * N[0] + ps.vel[2] * N[2]) / nl;
      gs._bdot = vPerp * rateScale(R);
      gs.balance = seedOf(R) * (Math.abs(vPerp) > 1e-6 ? Math.sign(vPerp) : 1);

      // THE ONE DOCUMENTED POSITION WRITE: snap the board to the closest point
      // on the polyline (<= captureRadius by construction). Everything after
      // this frame is velocity.
      ps.pos[0] = c.pt[0]; ps.pos[1] = c.pt[1]; ps.pos[2] = c.pt[2];
      ps.vel[0] = T[0] * gs.alongSpeed;
      ps.vel[1] = T[1] * gs.alongSpeed;
      ps.vel[2] = T[2] * gs.alongSpeed;
      if (inp.crouch) { gs._con = 3; ps.constrained = true; }
      return gs;
    }
    if (gs._blockId !== null) {
      const R = rails.find(r => r.id === gs._blockId);
      if (!R || closest(R, ps.pos).d > captureRadius_m * 2) gs._blockId = null;
    }
    return gs;
  }

  // b'' + C_DAMP*b' - W2_INST*b = Lo,  Lo = -(C_LOAD*aLat + K_CTRL*steer)
  // Closed form over the step with the forcing held constant (two real roots).
  function advanceBalance(gs, R, aLat, steer, dt) {
    const Lo = -C_LOAD * aLat - K_CTRL * steer;
    const C = Lo / W2_INST;
    const u0 = gs.balance + C, du0 = gs._bdot;
    const A = (du0 - LAM2 * u0) / (LAM1 - LAM2);
    const B = (LAM1 * u0 - du0) / (LAM1 - LAM2);
    const e1 = Math.exp(LAM1 * dt), e2 = Math.exp(LAM2 * dt);
    gs.balance = A * e1 + B * e2 - C;
    gs._bdot = A * LAM1 * e1 + B * LAM2 * e2;
  }

  return { config, init, step };
}
