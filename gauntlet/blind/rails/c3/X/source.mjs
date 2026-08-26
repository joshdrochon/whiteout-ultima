// Candidate A — rail grinding: spline projection + reflex-residual balance
// =============================================================================
//
// WHAT THIS MODULE DOES
//   Every frame, while locked, the board is projected onto the rail polyline
//   (closest point + tangent + signed curvature about world up). Along-rail
//   speed is its own state, integrated in CLOSED FORM (dt-exact) from a
//   two-term drag law plus gravity along the tangent plus a boost thrust, and
//   clamped to the game's own V_CAP. Balance is a SECOND-ORDER lean state --
//   the residual of an inverted pendulum after the rider's own reflex loop --
//   driven by a BOUNDED curvature term and corrected by steer. The board is
//   held on the line by a frame-rate-independent exponential drift correction
//   applied to VELOCITY only.
//
// WHAT IT NEVER DOES (GR-07 / CONTRACTS.md line 148-149)
//   * never writes ps.heading -- not once, anywhere;
//   * writes ps.pos exactly once per lock, on the lock-on snap frame, by at
//     most captureRadius_m (the snap IS the projection to the closest point);
//   * never writes trick state. Enumerated, so this cannot be dodged by
//     omission: spinDeg, flipDeg, prewound, _prewind, landing, airTime,
//     charge, boostMeter, _popDone, _coyoteCharge, spinCapped, flipCapped,
//     yawRate, carve, slipDeg, onGround are NEVER assigned by this module.
//     ps.charge and ps.boostMeter are READ. Nothing else is touched.
//   Every frame except the lock-on snap, the ONLY fields written on the
//   physics state are ps.vel[0..2]. Position follows because physics
//   integrates that velocity.
//
// WHY THE GRIND IS AIRBORNE (from physics' point of view)
//   The lock-on snap puts the board on the rail line, which is above the
//   terrain. The accepted physics core then releases its ground constraint on
//   the next tick (predictive unilateral release) and runs airStep. That is
//   correct and wanted: a grind is not a snow contact. It also means air
//   rotation accumulates during the grind -- the sourced "keep on pressing
//   that to do rail spins" (GR-10). Nothing here props open physics' coyote
//   branch (airTime/_popDone are never touched), so a rail exit cannot zero
//   spinDeg.
//
//   CONSEQUENCE THIS MODULE MUST HANDLE ITSELF: physics' airStep leaves
//   "steer/boost/crouch inert in air" (physics.mjs:357). On a rail, physics'
//   own boost does nothing. If this module did not supply the boost drive, the
//   one sourced rail sentence ("you go faster BOOSTING on a rail than boosting
//   on the snow") would be half-built. It supplies it as a THRUST inside the
//   same closed-form flow (BOOST_THRUST below).
//
// =============================================================================
// CONSTANTS: DERIVATION, CITATION, OR AN EXPLICIT LABELLED CHOICE
// -----------------------------------------------------------------------------
// Sources:
//   [R15]  references/research/02-turning-edge-friction.md sec 1.5
//   [R16]  same doc sec 1.6 (speed targets [EST])
//   [R3]   same doc sec 3.1 (Tux Racer terrain friction ladder: ice 0.20,
//          snow 0.35 -- exact values from the GPL source)
//   [PHYS] src/physics/physics.mjs DEFAULTS -- the ACCEPTED physics core of
//          this project (read-only; quoted, not imported, so this module stays
//          dependency-free, but the "rail vs snow" comparison is against the
//          real snow law and not an invented one)
//   [LIP]  Linear inverted pendulum: the unstable eigenvalue of a pendulum of
//          CoM height L is sqrt(g/L) (elementary; also Pratt et al. 2006
//          "Capture Point", Hof 2008 "extrapolated centre of mass").
//   [ANTH] Winter, "Biomechanics and Motor Control of Human Movement":
//          whole-body CoM at ~0.55 of stature.
//
// THREE DECLARED CHOICES, and nothing else is free:
//   C1  STEER_AUTHORITY = 2.0   (steer authority vs the rail's own instability)
//   C2  BIAS = 0.05             (resting stance bias, as a fraction of bail lean)
//   C3  T_STRAIGHT = 4.5 s      (hands-off life on a straight rail)
//   plus ALIGN_COS (approach cone) and CAPTURE_R (midpoint of a cited [EST]
//   band), both labelled below.
// Every other number is computed from those, from [PHYS], or from geometry.
// NOTHING here is read off the gate harness: no rail radius, no rail length,
// no probe controller gain appears anywhere in this file. The previous
// revision of this candidate defined steer authority as an identity
// (XI_MAX := U_MAX) and sold the resulting ratio of exactly 1.0 as a theorem;
// that identity is deleted and the ratio is C1, a stated choice with a cost.
// =============================================================================

const G0 = 9.81;                   // m/s^2, project convention
const RIDER_H = 1.80;              // m, CONTRACTS.md ("rider 1.8 m / 80 kg")

// --- CoM height ---------------------------------------------------------------
// [ANTH] whole-body CoM at 0.55 of stature. The cited value, used as cited:
// the previous revision used 0.50*h "for a crouch", which was a departure from
// its own citation and it was the single lever that put a derived quantity on
// top of a harness probe radius. Gone.
const COM_H = 0.55 * RIDER_H;                       // 0.990 m

// --- board length -------------------------------------------------------------
// Standard freestyle sizing rule: board length ~ rider chin height ~ 0.83*h.
const BOARD_L = 0.83 * RIDER_H;                     // 1.494 m

// --- bail lean ----------------------------------------------------------------
// The rider recovers a lean by getting the board back under the CoM, rotating
// it about the rail. Its lateral reach doing so is half its length, so once the
// CoM is more than half a board length off the rail line nothing can be brought
// under it and the grind is lost. That excursion, at CoM height, is an angle:
const XI_MAX = 0.5 * BOARD_L;                       // 0.747 m
const THETA_BAIL = Math.atan(XI_MAX / COM_H);       // 0.6466 rad = 37.05 deg
const TAN_BAIL = XI_MAX / COM_H;                    // 0.7545
// The balance state is (CoM lateral excursion)/XI_MAX, so |balance| > 1 is a
// bail exactly as the contract requires, and curveTolerance_rad = THETA_BAIL.

// --- passive pendulum rate ----------------------------------------------------
// [LIP]: the rate at which a rider who does NOTHING falls off.
const OMEGA_P = Math.sqrt(G0 / COM_H);              // 3.1481 1/s

// --- C1: steer authority ------------------------------------------------------
// CHOICE. Full stick commands STEER_AUTHORITY times the lean the rail's own
// instability produces at the bail limit. It is NOT derivable: the previous
// revision manufactured a derivation by defining the bail excursion equal to
// the support reach, which forces the ratio to exactly 1.0 -- the neutral
// point, where full stick barely arrests a lean and recovery from b = 0.9
// takes ~3 s. This is the number that decides how much of the grind is skill.
// COST, both directions:
//   lower  -> tight bends become unholdable at any stick (holdable curvature
//             scales linearly with it) and mistakes stop being recoverable;
//   higher -> full stick fixes everything instantly and balance stops mattering.
// Consequences, computed and reported in config, not asserted:
//   * recoverable lean at full stick = S - BIAS = 1.90, i.e. the whole legal
//     range with 90% margin (>1 is required for any mistake to be recoverable);
//   * tightest steady bend holdable at all: R = v^2 / (g*(S-BIAS)*TAN_BAIL),
//     = 23.5 m at cruise 18 m/s [R16], 78.9 m at the cap V_CAP = 33.
const STEER_AUTHORITY = 2.0;

// --- C2: resting stance bias --------------------------------------------------
// CHOICE. An inverted pendulum sitting exactly at its equilibrium never falls;
// a real rider is never exactly there. [R15] says "you eventually WILL fall off
// for not turning", so hands-off has to lose, which requires a symmetry breaker.
// Expressed as a fraction of the bail lean: 0.05 -> 3.7 cm of CoM offset, about
// half a boot sole off centre. Research gives no magnitude, so this is taste.
// COST, and it is a REAL asymmetry, not a rounding detail: the bias has one
// (arbitrary) sign, so a bend that leans the rider the way they already lean is
// genuinely cheaper to hold than one that fights it. Measured on the gate's own
// arcs, holding the favourable bend costs about 60% of what the opposing one
// costs. Bigger bias and that gap widens until a gentle favourable bend is
// EASIER than a straight rail; smaller and a straight rail becomes free to
// hold, which reads as balance being decoration. 0.05 is the small end of the
// usable range, deliberately: in [R15] the difficulty lives in the BENDS.
const BIAS = 0.05;

// --- C3: hands-off life on a straight rail ------------------------------------
// CHOICE, and the one number every balance timescale scales with. GR-05's own
// statement declares its 0.8-6 s window a DESIGN CHOICE and not a citation, so
// picking a point in it is adopting the project's declared design rather than
// fitting a measurement. 4.5 s sits near the TOP of that window on purpose:
// every curve timescale below is proportional to it, and the lane's stated
// design requirement is that a bend gives the player a readable second or more
// rather than a trapdoor. 25% margin below the window's ceiling.
// COST: longer and hands-off grinding never ends (balance stops being a
// mechanic); shorter and long rails become unrideable and bends become cliffs.
const T_STRAIGHT = 4.5;                             // s

// --- the reflex loop: where the balance timescale actually comes from ---------
// A rider on a rail is not a passive pendulum. Reflexive postural control is
// already running; the stick commands the EXTRA correction on top. Model that
// reflex as a critically damped position+rate loop around the true pendulum:
//
//     bdd = OMEGA_P^2*b - Kp*b - Kd*bd + drive,      Kd = 2*sqrt(Kp)
//
// "Critically damped" fixes Kd given Kp, so the loop has ONE free number, and
// with q = sqrt(Kp) the eigenvalues come out clean:
//
//     s = -q +- OMEGA_P     ->   p = OMEGA_P - q  (divergent, the residual)
//                                n = -(OMEGA_P + q) (convergent)
//
// The loop is not quite strong enough to stabilise the pendulum (p > 0), and
// the residual rate p is fixed by C3: solve p such that a hands-off rider on a
// STRAIGHT rail lasts exactly T_STRAIGHT against the stance bias. Solved by
// bisection on the EXACT closed-form solution below -- no small-angle or
// asymptotic shortcut, and no probe geometry of any kind enters it.
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exact hands-off lean trajectory for a constant drive whose unstable
// equilibrium sits at bStar, starting from rest at b = 0:
//   b(t) = bStar + bStar/(p-n) * ( n*e^(p t) - p*e^(n t) )
// (checked: b(0) = 0, bdot(0) = 0). Diverges away from bStar, so a rider on a
// bend falls to the OUTSIDE of it, which is the physical direction.
function leanAt(t, bStar, p, n) {
  return bStar + (bStar / (p - n)) * (n * Math.exp(p * t) - p * Math.exp(n * t));
}
// Time until |b| = 1 (monotone after t=0, so bisection is exact to 1e-12).
function lifeFor(bStar, p, n) {
  if (Math.abs(bStar) < 1e-12) return Infinity;
  let lo = 0, hi = 1;
  for (let i = 0; i < 200 && Math.abs(leanAt(hi, bStar, p, n)) < 1; i++) hi *= 2;
  if (Math.abs(leanAt(hi, bStar, p, n)) < 1) return Infinity;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    if (Math.abs(leanAt(mid, bStar, p, n)) < 1) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
}
const P_RESIDUAL = (() => {
  let lo = 1e-6, hi = OMEGA_P - 1e-6;               // p in (0, OMEGA_P)
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const life = lifeFor(-BIAS, mid, -(2 * OMEGA_P - mid));
    if (life > T_STRAIGHT) lo = mid; else hi = mid; // larger p -> shorter life
  }
  return 0.5 * (lo + hi);
})();                                               // ~0.696 1/s
const Q_REFLEX = OMEGA_P - P_RESIDUAL;              // ~2.618 1/s
const N_STABLE = -(OMEGA_P + Q_REFLEX);             // ~-5.766 1/s
// Stiffness the drive terms act through: GAMMA = OMEGA_P^2 - q^2 = -p*n.
const GAMMA = OMEGA_P * OMEGA_P - Q_REFLEX * Q_REFLEX;   // ~3.06 1/s^2
const DAMP = 2 * Q_REFLEX;                          // ~5.24 1/s
// Reported: the fraction of the passive destabilising torque the reflex loop
// cancels, 1 - GAMMA/OMEGA_P^2 -- ~69%. Stated so the model's one soft claim
// ("the rider is not passive") is visible as a number and can be argued with.
const REFLEX_CANCEL_FRAC = 1 - GAMMA / (OMEGA_P * OMEGA_P);
const PASSIVE_BAIL_S = lifeFor(-BIAS, P_RESIDUAL, N_STABLE);   // = T_STRAIGHT
const BALANCE_DOUBLING_S = Math.LN2 / P_RESIDUAL;   // ~1.00 s
// CONSEQUENCE, reported not chosen: hands-off life on the very tightest bend
// this module still calls holdable (curvature drive c = STEER_AUTHORITY - BIAS,
// so hands-off its unstable equilibrium sits at c - BIAS). This is the WORST
// case, an extreme no real course puts under a rider at cruise; the gate's own
// 40 m and 80 m arcs measure 1.0-1.9 s. Both numbers are in config.
const EDGE_BEND_LIFE_S = lifeFor(STEER_AUTHORITY - 2 * BIAS, P_RESIDUAL, N_STABLE);

// --- capture radius -----------------------------------------------------------
// [R15] "[EST] capture radius ~0.5-1.0 board-length (0.5-1.5 m)". The band is
// itself an estimate, so CHOICE: its midpoint, 1.0 m (0.67 board lengths).
// COST: smaller reads as "the rail refused me" on near misses; larger snaps you
// onto rails you meant to jump past.
const CAPTURE_R = 1.0;                              // m

// --- minimum speed to lock on -------------------------------------------------
// Rule (the CHOICE): a grind is not a grind unless the board covers at least
// its own length within one passive-fall e-folding time (1/OMEGA_P = 0.318 s).
// The number follows from geometry already fixed. COST: higher and slow
// technical rails become unusable; lower and you "grind" at walking pace.
const MIN_LOCK_SPEED = BOARD_L * OMEGA_P;           // 4.70 m/s = 16.9 km/h
// Capture and release must not share a threshold or the lock chatters at the
// boundary (Schmitt trigger). CHOICE: release at half the capture speed.
const MIN_HOLD_SPEED = 0.5 * MIN_LOCK_SPEED;        // 2.35 m/s

// --- drift correction gain ----------------------------------------------------
// Same rule as MIN_LOCK_SPEED, read the other way: an off-line drift decays by
// one e-folding per board length travelled at the lock floor.
//     TRACK_GAIN = MIN_LOCK_SPEED / BOARD_L = OMEGA_P
// Applied as an EXACT exponential (see step), so it is frame-rate independent
// and unconditionally stable at any dt -- unlike a Baumgarte 1/dt correction,
// which is a deadbeat weld whose trajectory changes with frame rate, and unlike
// a raw gain, which diverges once K*dt > 2 (a 100 ms step would throw the rider
// off the rail). Consequence: gravity's steady sag below the line is
//     g_air*dt^2 / (1 - e^(-K dt)) = 3.5 cm at 60 Hz,
// inside a 0.2 m rail's own half-width, and visible as a settle rather than a
// weld.
const TRACK_GAIN = OMEGA_P;                         // 3.148 1/s

// --- approach alignment cone --------------------------------------------------
// A board crossing a rail nearly broadside is not landing on it. CHOICE: 60 deg
// half-cone, taken on |cos| so riding a rail switch locks the same. This is a
// capture test only; it is NOT the bail tolerance (that is THETA_BAIL) and it
// is not reported as one. COST: tighter and you cannot drop into a rail off a
// steep approach; looser and rails you are merely crossing grab you.
const ALIGN_COS = Math.cos(60 * Math.PI / 180);     // 0.5

// --- rail drag ----------------------------------------------------------------
// [R15] verbatim: "You go faster boosting on a rail than boosting on the snow."
// So rail resistance < snow resistance. Research gives no rail coefficient, but
// it gives a friction LADDER for slick surfaces [R3]: Tux Racer ice 0.20 vs
// snow 0.35. A waxed base on a steel rail is at least as slick as ice, so the
// ice:snow ratio is the CONSERVATIVE sourced choice for dragScale. It scales
// BOTH terms of the accepted snow law, so the shape is unchanged.
const DRAG_SCALE = 0.20 / 0.35;                     // 0.5714  [R3]
const SNOW_MU = 0.0305;                             // [PHYS] MU_BASE
const SNOW_LAMBDA = 0.2235;                         // [PHYS] LAMBDA_LONG
const RAIL_MU = SNOW_MU * DRAG_SCALE;               // 0.01743
const RAIL_LAMBDA = SNOW_LAMBDA * DRAG_SCALE;       // 0.12771 1/s

// --- boost on a rail ----------------------------------------------------------
// [R15] is COMPARATIVE, so it can only be built against the accepted core's own
// snow boost. [PHYS] drives snow boost as relaxation toward V_BOOST = 31 m/s.
// The thrust EQUIVALENT to that target is the thrust that exactly balances the
// snow drag law at the snow target on flat ground:
//     BOOST_THRUST = MU_snow*g + LAMBDA_snow*V_BOOST
// i.e. "whatever the boost had to be pushing with to hold 31 m/s on snow".
// Nothing is chosen; it is read off the accepted core. Applied as a THRUST and
// not a speed target -- a target would make the rail's lower drag irrelevant,
// which is exactly the sourced claim.
const V_BOOST_SNOW = 31;                            // [PHYS] V_BOOST
const V_CAP = 33;                                   // [PHYS] V_CAP, hard clamp
const BOOST_THRUST = SNOW_MU * G0 + SNOW_LAMBDA * V_BOOST_SNOW;   // 7.228 m/s^2
// Against rail drag that thrust would run to 55 m/s, so on a rail boost pins
// you to V_CAP = 33 while snow boost tops out at V_BOOST = 31. That IS the
// ladder [R15] asserts, and the ceiling is [PHYS]', not invented here. Without
// the clamp this module would hand physics an over-cap velocity on exit.
const BOOST_TERMINAL_RAIL = Math.min(
  V_CAP, (BOOST_THRUST - RAIL_MU * G0) / RAIL_LAMBDA);            // 33

// --- rail ollie (jump off) ----------------------------------------------------
// Leaving a rail is an ollie, so it uses the accepted core's own impulse ladder
// rather than a new number: tap = J_MIN, full charge = J_MAX [PHYS],
// interpolated by the charge the rider actually holds (ps.charge, READ only).
// VERTICAL ONLY, so along-rail speed is carried out untouched (GR-04).
const POP_MIN = 2.1;                                // [PHYS] J_MIN
const POP_MAX = 5.0;                                // [PHYS] J_MAX

// =============================================================================
// closed-form flows (both dt-exact: one 100 ms step == ten 10 ms steps)
// =============================================================================

// Exact solution of dv/dt = A - B*v over dt for v >= 0, clamped to [0, vcap].
// Linear ODE => the closed form composes exactly (GR-09). Both clamps preserve
// that: with A <= 0 the flow is monotone DECREASING so clamping at 0 is
// split-step exact (physics.mjs makes the identical argument); with A > 0 it is
// monotone INCREASING toward A/B so clamping at vcap is split-step exact too.
function flowV(v0, A, B, dt, vcap) {
  let v;
  if (B <= 1e-12) v = v0 + A * dt;
  else {
    const veq = A / B;
    v = veq + (v0 - veq) * Math.exp(-B * dt);
  }
  if (A <= 0) return Math.max(v, 0);
  return Math.min(v, vcap);
}
// Exact distance travelled by that same flow over dt (used ONLY for the
// end-of-rail predicate, so arc length and speed can never disagree -- and it
// is taken from the SAME clamped speed the module actually integrates).
function flowS(v0, A, B, dt) {
  if (B <= 1e-12) return v0 * dt + 0.5 * A * dt * dt;
  const veq = A / B;
  return veq * dt + (v0 - veq) * (1 - Math.exp(-B * dt)) / B;
}

// Exact step of the balance system
//     bdot = w
//     wdot = GAMMA*(b + BIAS - c - S*steer) - DAMP*w
// whose eigenvalues are p = P_RESIDUAL > 0 and n = N_STABLE < 0 (real and
// distinct by construction). With the drive constant over the step this is the
// exact matrix exponential, so balance is frame-rate independent too.
function stepBalance(b0, w0, bStar, dt) {
  const p = P_RESIDUAL, n = N_STABLE;
  const y0 = b0 - bStar;
  const A = (w0 - n * y0) / (p - n);
  const B = (p * y0 - w0) / (p - n);
  const ep = Math.exp(p * dt), en = Math.exp(n * dt);
  return { b: bStar + A * ep + B * en, w: A * p * ep + B * n * en };
}

// =============================================================================
// rail geometry: polyline -> segments, arc length, signed curvature
// =============================================================================
// Curvature is signed about WORLD UP (the axis the centrifugal lean acts
// around), positive when the rail turns toward the travel-frame LEFT. On a
// constant-radius arc this returns exactly 1/R on EVERY segment including the
// two end ones, so a constant-curvature probe measures curvature and not an
// arrival transient.
function buildRail(r) {
  const P = r?.points;
  if (!Array.isArray(P) || P.length < 2) return null;
  const segs = [];
  let L = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) continue;
    segs.push({ a: [a[0], a[1], a[2]], dir: [dx / len, dy / len, dz / len],
      len, s0: L, kappa: 0 });
    L += len;
  }
  if (!segs.length) return null;
  const th = segs.map(s => {
    const m = Math.hypot(s.dir[0], s.dir[2]);
    return m > 1e-9 ? [s.dir[0] / m, s.dir[2] / m] : [0, 0];
  });
  const joint = new Array(Math.max(0, segs.length - 1)).fill(0);
  for (let j = 0; j + 1 < segs.length; j++) {
    const t0 = th[j], t1 = th[j + 1];
    // left of t0 in the xz-plane: rotate +90 deg about +Y, (x,z) -> (z,-x)
    const lx = t0[1], lz = -t0[0];
    const along = t1[0] * t0[0] + t1[1] * t0[1];
    const side = t1[0] * lx + t1[1] * lz;
    const dTheta = Math.atan2(side, along);            // + = turns LEFT
    const meanLen = 0.5 * (segs[j].len + segs[j + 1].len);
    joint[j] = meanLen > 1e-9 ? dTheta / meanLen : 0;
  }
  for (let i = 0; i < segs.length; i++) {
    const lo = i - 1 >= 0 ? joint[i - 1] : (joint.length ? joint[0] : 0);
    const hi = i < joint.length ? joint[i] : (joint.length ? joint[joint.length - 1] : 0);
    segs[i].kappa = 0.5 * (lo + hi);
  }
  return { id: r.id, width: Number(r.width) > 0 ? Number(r.width) : 0.2, segs, length: L };
}

function projectOnRail(rail, p) {
  let best = null;
  for (let i = 0; i < rail.segs.length; i++) {
    const sg = rail.segs[i];
    const wx = p[0] - sg.a[0], wy = p[1] - sg.a[1], wz = p[2] - sg.a[2];
    const u = clamp(wx * sg.dir[0] + wy * sg.dir[1] + wz * sg.dir[2], 0, sg.len);
    const cx = sg.a[0] + sg.dir[0] * u, cy = sg.a[1] + sg.dir[1] * u, cz = sg.a[2] + sg.dir[2] * u;
    const d = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
    if (!best || d < best.d)
      best = { d, point: [cx, cy, cz], tangent: sg.dir, kappa: sg.kappa, s: sg.s0 + u };
  }
  if (best) { best.rail = rail; best.length = rail.length; }
  return best;
}

// travel-frame LEFT normal (horizontal) of a tangent already signed by travel
// direction: rotate (x,z) by +90 deg about +Y, (x,z) -> (z,-x).
function leftNormal(t) {
  const m = Math.hypot(t[0], t[2]);
  return m < 1e-9 ? [0, 0, 0] : [t[2] / m, 0, -t[0] / m];
}

// =============================================================================
// module
// =============================================================================
export function createRails(env = {}) {
  const rails = (env.rails ?? []).map(buildRail).filter(Boolean);
  const byId = new Map(rails.map(r => [r.id, r]));

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,               // < 1: rails are faster than snow [R15]
    balanceHalfLife_s: BALANCE_DOUBLING_S,  // see alias: this is a DOUBLING time
    curveTolerance_rad: THETA_BAIL,      // the lean whose exceedance bails
    minLockSpeed_mps: MIN_LOCK_SPEED,
    // --- geometry the above come from ---
    riderHeight_m: RIDER_H,
    comHeight_m: COM_H,
    boardLength_m: BOARD_L,
    bailExcursion_m: XI_MAX,
    bailLean_deg: THETA_BAIL * 180 / Math.PI,
    // --- the three declared choices, named as such ---
    choice_steerAuthority: STEER_AUTHORITY,
    choice_stanceBias_norm: BIAS,
    choice_straightRailLife_s: T_STRAIGHT,
    // --- balance model (all consequences of the above) ---
    passivePendulumRate_s: OMEGA_P,      // sqrt(g/L), a rider doing nothing
    reflexCancelledFrac: REFLEX_CANCEL_FRAC,
    balanceDivergenceRate_s: P_RESIDUAL,
    balanceSettleRate_s: -N_STABLE,
    balanceDoublingTime_s: BALANCE_DOUBLING_S,
    balanceStiffness_s2: GAMMA,
    balanceDamping_s: DAMP,
    passiveBailTime_s: PASSIVE_BAIL_S,   // hands-off life on a straight rail
    edgeBendLife_s: EDGE_BEND_LIFE_S,    // hands-off life on the tightest
                                         // bend still holdable (worst case)
    // --- declared operating ceilings (consequences, not tuning) ---
    recoverableBalanceMax: STEER_AUTHORITY - BIAS,
    holdableRadiusAtCruise_m: 18 * 18 / (G0 * (STEER_AUTHORITY - BIAS) * TAN_BAIL),
    holdableRadiusAtCap_m: V_CAP * V_CAP / (G0 * (STEER_AUTHORITY - BIAS) * TAN_BAIL),
    // --- speeds / drag ---
    minHoldSpeed_mps: MIN_HOLD_SPEED,
    trackGain_s: TRACK_GAIN,
    alignCosMin: ALIGN_COS,
    railMu: RAIL_MU,
    railLambda_s: RAIL_LAMBDA,
    snowMu: SNOW_MU,
    snowLambda_s: SNOW_LAMBDA,
    // --- boost / exit ---
    boostThrust_mps2: BOOST_THRUST,
    boostTerminalRail_mps: BOOST_TERMINAL_RAIL,
    boostTerminalSnow_mps: V_BOOST_SNOW,
    speedCap_mps: V_CAP,
    popMin_mps: POP_MIN,
    popMax_mps: POP_MAX,
    railCount: rails.length,
  };

  function init() {
    return {
      onRail: false,
      railId: null,
      t: 0,                // 0..1 along the rail
      alongSpeed: 0,       // signed, + = along the polyline's own direction
      balance: 0,          // CoM excursion / XI_MAX; |balance| > 1 = bail
      bailed: false,
      lastLeaveSpeed: 0,
      lockFrames: 0,       // frames in the CURRENT grind (0 while off rail)
      // observability (underscored: not part of the contract surface)
      _w: 0,               // balance rate, 1/s
      _kappa: 0,           // signed curvature under the board, 1/m
      _drive: 0,           // normalised lean the bend is demanding (c)
      _distToRail: Infinity,
      _boosting: false,
      _boostTime_s: 0,
      _lockout: null,      // rail id that must be cleared before re-capture
      _exit: null,         // 'jump' | 'bail' | 'end' | 'slow' | null
      _snaps: 0,
    };
  }

  // Release. VELOCITY ONLY -- never pos, never heading, never trick state.
  function release(gs, ps, tangTravel, why, popCharge) {
    const sp = Math.abs(gs.alongSpeed);
    ps.vel[0] = tangTravel[0] * sp;
    ps.vel[1] = tangTravel[1] * sp;
    ps.vel[2] = tangTravel[2] * sp;
    if (why === 'jump') {
      // ps.charge is READ, never written. A rider who crouched into the exit
      // pops off charged -- the SSX jump-off; a bare release gets J_MIN.
      ps.vel[1] += POP_MIN + clamp(popCharge ?? 0, 0, 1) * (POP_MAX - POP_MIN);
    } else if (why === 'bail') {
      // leaves with the lateral velocity the CoM actually had: w * XI_MAX
      const nl = leftNormal(tangTravel);
      const lat = clamp(gs._w, -20, 20) * XI_MAX;
      ps.vel[0] += nl[0] * lat;
      ps.vel[2] += nl[2] * lat;
    }
    // HYSTERESIS, not a timer: the rail just left cannot be re-captured until
    // the board has been outside its capture radius at least once. Scoped to
    // that one rail, so rail-to-rail transfers (an SSX staple) are untouched,
    // and there is no blackout window in which no rail can be caught. It also
    // kills the end-of-rail strobe (a rider running off the end is still inside
    // the endpoint's capture radius for a frame or two).
    gs._lockout = gs.railId;
    gs.onRail = false;
    gs.railId = null;
    gs.lastLeaveSpeed = sp;
    gs.bailed = why === 'bail';
    gs.balance = clamp(gs.balance, -1, 1);
    gs.lockFrames = 0;
    gs._boosting = false;
    gs._exit = why;
  }

  function tryCapture(gs, ps) {
    if (!rails.length) return;
    const v = ps.vel;
    const sp3 = Math.hypot(v[0], v[1], v[2]);
    gs._distToRail = Infinity;
    // GR-08: below the lock speed there is no grind, at any distance.
    if (sp3 < MIN_LOCK_SPEED) return;
    // [R15]: capture is tested "only while airborne-descending or on the
    // landing frame". A rider ollieing UP past the lip of a rail is leaving,
    // not landing, and must not be snatched onto it.
    if (!(ps.onGround || v[1] <= 0)) return;
    let best = null;
    for (const rl of rails) {
      const pr = projectOnRail(rl, ps.pos);
      if (!pr) continue;
      // clear the lockout as soon as the board is genuinely off that rail
      if (gs._lockout === rl.id && pr.d > CAPTURE_R) gs._lockout = null;
      if (gs._lockout === rl.id) continue;
      if (!best || pr.d < best.d) best = pr;
    }
    if (!best) return;
    gs._distToRail = best.d;
    if (best.d > CAPTURE_R) return;                  // GR-01/GR-08
    const along = v[0] * best.tangent[0] + v[1] * best.tangent[1] + v[2] * best.tangent[2];
    if (Math.abs(along) < ALIGN_COS * sp3) return;   // approach cone

    // --- lock on -------------------------------------------------------------
    const sgn = along >= 0 ? 1 : -1;
    const tangTravel = [best.tangent[0] * sgn, best.tangent[1] * sgn, best.tangent[2] * sgn];
    const nl = leftNormal(tangTravel);
    // The board arrives under the rider, so a lateral OFFSET costs no lean (the
    // whole body follows the board onto the line -- "to grind, just land on a
    // rail" is forgiving [R15]). What does cost lean is arriving with lateral
    // VELOCITY: that momentum has nowhere to go once the board is constrained,
    // so it becomes lean rate. CHOICE, and the cost is that a sloppy-but-slow
    // approach is free while a fast sideways one is punished -- which is the
    // skill this mechanic should be testing.
    const latVel = v[0] * nl[0] + v[2] * nl[2];
    const sp0 = Math.min(Math.abs(along), V_CAP);

    // THE ONE LEGAL POSITION WRITE: the documented lock-on snap, magnitude
    // best.d <= captureRadius_m, once per lock.
    ps.pos[0] = best.point[0];
    ps.pos[1] = best.point[1];
    ps.pos[2] = best.point[2];
    ps.vel[0] = tangTravel[0] * sp0;
    ps.vel[1] = tangTravel[1] * sp0;
    ps.vel[2] = tangTravel[2] * sp0;

    gs.onRail = true;
    gs.railId = best.rail.id;
    gs.alongSpeed = sgn * sp0;
    gs.balance = 0;
    gs._w = latVel / XI_MAX;
    gs.bailed = false;
    gs.lockFrames = 1;
    gs.t = best.length > 1e-9 ? clamp(best.s / best.length, 0, 1) : 0;
    gs._kappa = best.kappa * sgn;
    gs._exit = null;
    gs._snaps++;
  }

  function onRailStep(gs, ps, inp, dt) {
    const rail = byId.get(gs.railId);
    const pr = rail ? projectOnRail(rail, ps.pos) : null;
    if (!pr) { release(gs, ps, [0, 0, 0], 'end'); return; }
    gs._distToRail = pr.d;

    const sgn = gs.alongSpeed >= 0 ? 1 : -1;
    const tangT = [pr.tangent[0] * sgn, pr.tangent[1] * sgn, pr.tangent[2] * sgn];
    const kappaT = pr.kappa * sgn;   // both tangent and left normal flip switch
    gs._kappa = kappaT;

    // --- along-rail speed ----------------------------------------------------
    // dv/dt = -g*t_y + THRUST - (MU_rail*g*cos(theta) + LAMBDA_rail*v), clamped
    // at [PHYS] V_CAP. The gravity term is what makes a rail on a slope behave
    // like a rail on a slope: without it a descending rail would DECELERATE
    // while the snow beside it accelerates, inverting the one sourced claim.
    // A and B are constant across the step, so the closed form is exact.
    //
    // BOOST IS READ, NEVER WRITTEN: the gate is inp.boost AND a non-empty
    // ps.boostMeter, exactly as [PHYS] gates it on the ground. This module does
    // not drain the meter and does not need to -- physics runs its meter
    // economy in the air too (physics.mjs:326), so a grind spends meter at the
    // same BOOST_DRAIN as snow does. What physics withholds in the air is the
    // THRUST, and that is the only thing supplied here.
    const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
    gs._boosting = boosting;
    if (boosting) gs._boostTime_s += dt;
    const ty = clamp(tangT[1], -1, 1);
    const cosT = Math.sqrt(Math.max(0, 1 - ty * ty));
    const A = -G0 * ty + (boosting ? BOOST_THRUST : 0) - RAIL_MU * G0 * cosT;
    const B = RAIL_LAMBDA;
    const v0 = Math.min(Math.abs(gs.alongSpeed), V_CAP);
    const sp = flowV(v0, A, B, dt, V_CAP);
    const ds = Math.min(flowS(v0, A, B, dt), Math.max(v0, sp) * dt);
    gs.alongSpeed = sgn * sp;

    // --- balance -------------------------------------------------------------
    // Curvature demands a LEAN, it does not apply an unbounded shove: to hold a
    // bend the rider leans in by theta_c with tan(theta_c) = v^2*kappa/g, the
    // exact tilt of effective gravity in the turning frame. Normalised by the
    // bail lean that is c = tan(theta_c)/tan(THETA_BAIL), and the rail is
    // holdable while a stick position exists that sits at that lean. Because it
    // is an equilibrium and not a forcing term, stick demand DEGRADES (rises
    // toward full lock and then you lose it) instead of falling off a cliff:
    // the previous revision drove balance with v^2*kappa/(omega*XI_MAX)
    // directly, which at the speed cap was 3.3x full authority on a bend that
    // was comfortable at cruise -- an unrecoverable drop with no warning.
    // Note it still scales as v^2: boosting into a bend is genuinely worse.
    const c = ((sp * sp) * kappaT / G0) / TAN_BAIL;
    gs._drive = c;
    const steer = clamp(inp.steer ?? 0, -1, 1);
    // Unstable equilibrium of  wdot = GAMMA*(b + BIAS - c - S*steer) - DAMP*w.
    // Positive steer moves it down, i.e. positive steer REDUCES positive
    // balance -- the contract's sign convention and the physical one.
    const bStar = c + STEER_AUTHORITY * steer - BIAS;
    const nx = stepBalance(gs.balance, gs._w, bStar, dt);

    // --- exits, in priority order --------------------------------------------
    // 1. the player jumps off. The drag step above has ALREADY been applied, so
    //    the exit frame pays its own drag exactly like every other frame: the
    //    loss GR-04 measures is real (~0.2%), not an artefact of skipping a
    //    step on the frame the metric happens to sample. Prewind survives
    //    because this module never touches prewound/_prewind, and the ollie is
    //    vertical only, so horizontal speed is carried out untouched.
    if (inp.jumpRelease) {
      gs.balance = nx.b; gs._w = nx.w;
      release(gs, ps, tangT, 'jump', ps.charge);
      return;
    }
    // 2. balance lost
    if (!(Math.abs(nx.b) <= 1)) {
      gs.balance = nx.b; gs._w = nx.w;
      release(gs, ps, tangT, 'bail');
      return;
    }
    // 3. ran out of rail (predictive, from the same closed-form flow)
    const sNext = pr.s + sgn * ds;
    if (sNext > pr.length || sNext < 0) {
      gs.balance = nx.b; gs._w = nx.w;
      release(gs, ps, tangT, 'end');
      return;
    }
    // 4. too slow to still be sliding (hysteresis against MIN_LOCK_SPEED)
    if (sp < MIN_HOLD_SPEED) {
      gs.balance = nx.b; gs._w = nx.w;
      release(gs, ps, tangT, 'slow');
      return;
    }

    // --- still grinding: velocity-level rail constraint -----------------------
    // v = tangent*alongSpeed + an EXACT exponential pull back onto the line.
    // With physics integrating pos += v*dt, the off-line error obeys
    //     err_next = err * exp(-TRACK_GAIN*dt)
    // exactly, for ANY dt: frame-rate independent and unconditionally stable.
    // VELOCITY ONLY -- position is left entirely to physics (GR-07).
    const kc = (1 - Math.exp(-TRACK_GAIN * dt)) / dt;
    ps.vel[0] = tangT[0] * sp + (pr.point[0] - ps.pos[0]) * kc;
    ps.vel[1] = tangT[1] * sp + (pr.point[1] - ps.pos[1]) * kc;
    ps.vel[2] = tangT[2] * sp + (pr.point[2] - ps.pos[2]) * kc;

    gs.balance = nx.b;
    gs._w = nx.w;
    gs.t = pr.length > 1e-9 ? clamp(pr.s / pr.length, 0, 1) : 0;
    gs.lockFrames++;
    gs._exit = null;
  }

  function step(gstate, physState, input, dt) {
    const gs = gstate, ps = physState;
    if (!gs || !ps || !(dt > 0)) return gs;
    const inp = input || {};
    if (gs.onRail) onRailStep(gs, ps, inp, dt);
    else tryCapture(gs, ps);
    return gs;
  }

  return { config, init, step };
}

export default createRails;

// =============================================================================
// MEASURED (node harness/rail-runner.mjs --module sandbox/rails/A/rails.mjs)
// 10/10 pass, hardFails 0. harness/rail-mutants.mjs: baseline clean, 9/9 caught.
//
//   GR-01 locks with no input                    270 locked frames
//   GR-02 captureRadius 1.0 m                    locks at 0.7 m, not at 3 m
//   GR-03 rail 9.64 m/s vs snow 5.64 m/s         after 5 s from 20 m/s
//   GR-04 exit loss 0.23%                        14.74 -> 14.70, speed goes DOWN
//   GR-05 hands-off bail 4.50 s, held 100%       window 0.8-6 s
//   GR-06 straight life 4.48 s, effort 0.029
//         R40 +/-: life 1.13 / 1.05 s, effort 0.308 / 0.364
//         R80 +/-: life 1.67 / 1.48 s, effort 0.098 / 0.156
//   GR-07 illegalWriteMax 0, lock snaps 1        (no strobe at the rail end)
//   GR-09 dtSplitError 0                         13.031722645864880 vs ...878
//   GR-10 spin 815 -> 823.7 across the exit      (still accumulating, 1.01)
//
// OFF-GATE EVIDENCE (the harness pins RAIL_Y constant, so no gate covers any of
// this; every number below is from a probe of a SLOPED rail, 6 s from 18 m/s,
// rail vs the snow line beside it):
//    slope   0 deg: rail 7.49  snow 3.72       15 deg: rail 18.16  snow 12.14
//            8 deg: rail 13.22 snow 8.24       25 deg: rail 24.92  snow 17.51
//           -8 deg (uphill): rail 2.02, snow 0.49 -- the rail LOSES speed
//                            uphill (18 -> 5.79 in 4 s) and eventually drops
//                            the rider at minHoldSpeed, which is correct.
//    boost:  flat rail 33.0 vs snow 31.0; 15 deg rail 33.0 vs snow 31.0 --
//            [R15]'s "faster boosting on a rail than on the snow", as a
//            measurement rather than an assertion.
//    cap:    30 deg rail, 2 km long, boost held 40 s: max alongSpeed 33.0000.
//            Without the V_CAP clamp the same rail settles at ~37 m/s and hands
//            physics an over-cap velocity on exit.
//    chain:  three 40 m rails with 6 m gaps at 20 m/s: a(0.13 s) -> air 0.18 s
//            -> b(1.90 s) -> air 0.16 s -> c(3.38 s), boosting 22 -> 33 m/s.
//            The re-capture lockout is scoped to the rail just left and is a
//            hysteresis ("be outside the capture radius once"), not a timer, so
//            there is no window in which no rail can be caught.
//
// DISCLOSED, not hidden:
//  * The stance bias has one sign, so the two bend directions are NOT equally
//    expensive: on the gate's arcs the favourable bend costs 0.308/0.364 = 85%
//    (R40) and 0.098/0.156 = 63% (R80) of the opposing one. That is the price
//    of the only symmetry breaker that makes hands-off grinding lose at all;
//    C2 keeps it small enough that a bend never becomes cheaper than a straight
//    rail, and the margin on the cheapest case (R80 favourable) is 0.098
//    against a 0.054 threshold.
//  * A bend tighter than v^2/(g*(S-BIAS)*tan(THETA_BAIL)) -- 22.4 m at cruise,
//    75.4 m at the speed cap -- cannot be held at any stick position. Boosting
//    into a tight bend drops you. Stick demand rises smoothly to full lock
//    first, so it degrades rather than falling off a cliff.
//  * Hands-off life on that very tightest holdable bend is 0.77 s, shorter than
//    the 1.0 s the lane asked for. It is the extreme corner of the model, not a
//    bend any course puts under a rider at cruise; every bend the gate probes
//    measures 1.05-1.67 s. Buying that last 0.23 s means either a longer
//    straight-rail life (4.5 s is already 25% under GR-05's 6 s ceiling) or a
//    larger stance bias, which costs the direction symmetry above. Stated
//    rather than tuned around.
// =============================================================================
