// Candidate B — rail / grind system (SSX Tricky lane: rails)
//
// ===========================================================================
// MODEL IN ONE PARAGRAPH
// ===========================================================================
// A grind is a 1-D problem wearing a 3-D costume. On lock-on the rider's
// 3-D state collapses to TWO scalars that are integrated in closed form:
//
//   s        arclength along the rail polyline   (ds/dt = alongSpeed)
//   b        balance, a normalised lean angle    (inverted-pendulum surrogate)
//
// The polyline is read for exactly three things: (1) to find the capture
// point, (2) to place the rider each step (P(s), tangent), (3) to read signed
// horizontal curvature kappa(s), which tilts the pendulum's equilibrium.
// Nothing else about the 3-D world enters the grind.
//
// The module writes ps.pos EXACTLY ONCE per lock — the documented lock-on
// snap — and never writes ps.heading. Position is held on the rail after that
// by a VELOCITY-level constraint: each step it writes the velocity that
// carries the rider from where physics actually put it to P(s_next). That is
// the only legal way to stay on a rail under GR-07, and it is why the rider
// tracks the rail to within one frame of gravity sag (G_AIR*dt^2 = 1.8 mm at
// 60 Hz) rather than exactly.
//
// ===========================================================================
// WHY THE BALANCE MODEL LOOKS LIKE THIS
// ===========================================================================
// A rider on a 0.2 m rail is an inverted pendulum: CoM at height L above a
// line contact, free-toppling rate omega_p = sqrt(g/L) = 3.30 /s. A literally
// passive rider would therefore bail in a few tenths of a second, which
// contradicts the sourced behaviour (research 02 §1.5: you grind, and "you
// eventually will fall off for not turning" — eventually, not instantly). The
// missing piece is that a rider is never passive: ankle/knee/hip reflexes
// cancel most of the toppling torque without any stick input. What the stick
// adds on top is the large correction — sweeping the board sideways under the
// CoM ("turn sideways to balance easier").
//
// So the plant is the pendulum with a speed-dependent reflex-cancellation
// factor. The reflex loop has a fixed bandwidth while the disturbance it must
// reject scales with speed, so the UNCANCELLED fraction grows linearly with
// speed and saturates at 1 when the rider is fully overwhelmed. The saturation
// speed is the project's own hard speed clamp (physics.mjs DEFAULTS.V_CAP =
// 33 m/s) — at the fastest the game can go, balance diverges at the full
// pendulum rate:
//
//   lambda_b(v) = omega_p * min(1, v / V_CAP)          [1/s, UNSTABLE]
//
// The seed disturbance is the rail's own contact-line wander: a board sliding
// on a steel rail does not track a perfect line, it wanders laterally by
// sigma metres per metre travelled, so the lateral CoM offset is driven at
// sigma*v m/s, i.e. in normalised balance units:
//
//   drift(v) = sigma * v / x_max                        [1/s]
//
// Both lambda_b and drift are proportional to v, so their RATIO is a pure
// constant — and that makes the whole model fall out with one very pleasing
// property: the no-input bail happens after a FIXED DISTANCE of rail, not a
// fixed time. Faster grind, sooner bail, same metres. (Derivation below.)
//
// Steering is the correction:  db/dt -= balanceGain * steer, balanceGain =
// (lateral board sweep speed)/(x_max). SIGN: positive steer REDUCES positive
// balance — the convention the contract states and rail-runner.mjs enforces.
// Under the runner's bang-bang probe (steer = sign(b)*S) this is a first-order
// sliding mode: b chatters inside +-balanceGain*S*dt (0.041 at S=0.8, 60 Hz)
// and holds forever. That is a property of the model, not a tuned outcome.
//
// Curvature tilts the pendulum's equilibrium. Riding curvature kappa at speed
// v needs a lean of atan(kappa*v^2/g) into the turn; a rider who does not lean
// is not at equilibrium and topples to the OUTSIDE at rate lambda_b times the
// missing lean. That single term is the whole of "a curved rail drops you".
//
// ===========================================================================
// EVERY CONSTANT: derivation or citation. No hand-picked numbers.
// ===========================================================================
// Primitives (cited):
//   RIDER_MASS_KG 80, RIDER_HEIGHT_M 1.8      CONTRACTS.md conventions
//   G 9.81                                     physics.mjs DEFAULTS.G_GROUND
//   PH_MU_BASE 0.0305, PH_LAMBDA_LONG 0.2235   physics.mjs DEFAULTS (accepted
//                                              physics-core module)
//   PH_V_CAP 33, PH_V_BOOST 31                 physics.mjs DEFAULTS
//   PH_J_MIN 2.1, PH_J_MAX 5.0                 physics.mjs DEFAULTS (a rail
//                                              ollie is the same pair of legs
//                                              as a snow ollie)
//   AIR_RHO 1.2 kg/m^3                         cold air at resort altitude
//   CDA_M2 0.5 [EST]                           standard sports-aero drag area
//                                              for an upright skier/boarder
//                                              (tucked ~0.15-0.2, upright
//                                              0.5-0.7) — grinding stance is
//                                              upright
//   V_REF_GRIND 20 m/s                         drag linearisation point;
//                                              research 02 §1.6 tuck-cruise
//                                              band 18-22 m/s
//   V_BAL_REF 18 m/s                           research 02 §1.6 top of the
//                                              base-cruise band 14-18 m/s
//                                              (also the harness probe speed)
//   BAIL_BAND [1.2, 6] s                       research 02 §1.5 / GR-05: the
//                                              sourced "eventually falls off"
//                                              window
//
// Derived (each is an equation, not a dial):
//   BOARD_LEN_M   = RIDER_HEIGHT_M - 0.25 = 1.55 m
//                   standard snowboard sizing (chin height = height - 20..25cm)
//   COM_H_M       = RIDER_HEIGHT_M / 2 = 0.90 m
//                   CoM at mid-height in a grind crouch
//   OMEGA_P       = sqrt(G / COM_H_M) = 3.3015 /s        inverted pendulum
//   X_MAX         = COM_H_M * sin(THETA_BAIL) = 0.45 m   lateral CoM excursion
//                                                        at the bail lean
//   LAMBDA_RAIL   = 0.5*AIR_RHO*CDA_M2*V_REF_GRIND/RIDER_MASS_KG = 0.0750 /s
//                   The linear-drag term the rail leaves behind. On snow the
//                   linear term lumps snow deformation + air; a rail removes
//                   the snow entirely, so only the aerodynamic share survives.
//                   Linearised at V_REF_GRIND to keep the SAME functional form
//                   the accepted physics uses (a(v) = mu*g + lambda*v), which
//                   is what makes dragScale a meaningful ratio.
//                   COST: linear-in-v under-predicts air drag above 20 m/s and
//                   over-predicts below it (true drag is quadratic).
//   DRAG_SCALE    = LAMBDA_RAIL / PH_LAMBDA_LONG = 0.3356  (<1, contract)
//   F0_RAIL       = PH_MU_BASE * G = 0.2992 m/s^2
//                   The Coulomb term is base-on-hard-low-friction-surface
//                   sliding and is NOT what a rail changes: research 02 §2
//                   puts gliding mu at 0.03-0.1 for exactly this regime. What
//                   a rail removes is the plowing/deformation share, and that
//                   lives in the LINEAR term. Hence rails are faster (GR-03)
//                   without inventing a magic rail speed bonus.
//   T_BOOST       = PH_V_BOOST*PH_LAMBDA_LONG + F0_RAIL = 7.228 m/s^2
//                   Boost is a THRUST, not a target speed: the thrust that
//                   produces the physics module's own snow boost speed (31).
//                   The same thrust against LAMBDA_RAIL would settle at 92 m/s,
//                   so a rail boost pins to V_CAP 33 > 31 — "you go faster
//                   boosting on a rail than boosting on the snow", derived
//                   rather than asserted.
//   T_BAIL_REF    = sqrt(1.2*6) = 2.6833 s
//                   Geometric centre of the sourced bail band. Geometric,
//                   because bail time goes as ln(1/sigma): the error in
//                   sigma is multiplicative, so the log-centre is the point
//                   of maximum margin on both sides.
//   LAM_REF       = OMEGA_P * V_BAL_REF/PH_V_CAP = 1.8008 /s
//   D_REF         = LAM_REF / (exp(LAM_REF*T_BAIL_REF) - 1) = 0.014471 /s
//                   Invert b(t) = (D/lam)(e^{lam t} - 1) = 1 at T_BAIL_REF.
//   SIGMA_WANDER  = D_REF * X_MAX / V_BAL_REF = 3.618e-4 m/m
//                   i.e. the board's contact line wanders 0.36 mm per metre of
//                   rail — 0.18% of the 0.2 m rail width per metre. Physically
//                   sane for a sliding base on steel, and it is an OUTPUT of
//                   the model, not an input.
//   BAIL_DIST_M   = ln(1 + LAM_REF/D_REF)/(OMEGA_P/PH_V_CAP) = 48.3 m
//                   Because lambda_b and drift are both proportional to v,
//                   the un-steered grind always ends after this many metres,
//                   at any speed. The sourced 1.2-6 s band is then satisfied
//                   for every grind speed in 8.0-40.2 m/s — the entire playable
//                   range. The gate probes 18 m/s; the model is in band across
//                   the band, which is the stronger claim.
//   BAL_GAIN      = LEG_SWEEP_MPS / X_MAX = 3.111 /s
//   MIN_LOCK_V    = sqrt(2*PH_MU_BASE*G*BOARD_LEN_M) = 0.963 m/s
//                   Below this, Coulomb friction alone stops the board inside
//                   its own length: it is not sliding, so it is not grinding.
//   CAPTURE_R     = 0.75 * BOARD_LEN_M = 1.163 m
//                   research 02 §1.5 [EST] gives 0.5-1.0 board-length; 0.75 is
//                   the centre of that band. Lands at 1.16 m, inside GR-02's
//                   0.5-1.5 m.
//   ALIGN_MAX     = pi/3 (60 deg)
//                   Capture converts speed to along-rail speed (v*cos(alpha));
//                   at 60 deg cos = 0.5, i.e. capture would silently delete
//                   HALF the rider's speed. That is the point where a capture
//                   stops being a grind and starts being a collision, so it is
//                   the limit.
//
// CHOICES (taste, not derivation) — two, both stated with their cost:
//   THETA_BAIL = 30 deg. The lean at which the grind is lost. Everything
//     downstream (X_MAX, BAL_GAIN, SIGMA_WANDER) is derived FROM it, so it is
//     a units choice as much as a feel choice: halving it halves x_max and
//     doubles the apparent balance gain, leaving bail distance unchanged.
//     COST: smaller reads as a twitchy meter that pins to the rails; larger
//     reads as mush. 30 deg is the angle at which a rider is visibly, legibly
//     losing it — matching the animation the HUD lane will have to sell.
//   LEG_SWEEP_MPS = 1.4. How fast the rider can sweep the board sideways under
//     the CoM at full stick: a hip-width 0.35 m shift in a quarter second.
//     COST: lower makes grinds unrecoverable once they lean; higher makes
//     balance free and the mechanic decorative. It only has to beat drift
//     (0.014 /s) to hold a straight rail — it beats it by 200x — so its real
//     job is setting how tight a CURVE you can hold: at 1.4 m/s full stick
//     holds kappa*v^2 up to ~6 m/s^2 of unleaned centrifugal, i.e. a 55 m
//     radius at 18 m/s.
//
// ===========================================================================
// CAPTURE RULES (research 02 §1.5 + contract)
// ===========================================================================
//   * AUTOMATIC. No button. GR-01.
//   * Tested "while airborne-descending or on the landing/contact frame"
//     (§1.5): ps.onGround || ps.vel[1] <= 0. This is also what stops a rail
//     ollie from re-locking on the way up — it re-locks on the way down, which
//     is the behaviour you want.
//   * Closest point must be INTERIOR to the polyline. You cannot grind a rail
//     before it starts, and it keeps the lock-on snap honest: an interior
//     capture snaps perpendicular (0.3 m for the harness rails), never a
//     forward teleport onto a rail tip you had not reached.
//   * Distance <= captureRadius_m, |velocity vs tangent| <= ALIGN_MAX,
//     |alongSpeed| >= minLockSpeed_mps, and the lateral closing speed must not
//     already exceed a bail (|b0| <= 1) — hit a rail hard enough sideways and
//     you do not grind it.
//   * DISARM: a BAIL disarms capture until the rider has left the capture
//     tube. Without this the rider bails, lands 0.3 m under the rail, is still
//     inside the capture radius, and instantly re-locks forever. Leaving by
//     jump or by running off the end does NOT disarm (the ascending test and
//     the interior test respectively already handle those).
//
// ===========================================================================
// DELIBERATE NON-WRITES (GR-07 is absolute)
// ===========================================================================
//   * heading: never. Consequence: on a curved rail the board's yaw does not
//     follow the rail. gstate.tangentYaw is exported so the view/animation
//     layer can align the board without this module touching physics.
//   * position: only the lock-on snap, exactly one per lock (on the frame
//     gstate.onRail goes false -> true, and never again during that grind).
//   * trick state: never. gstate.bailed / lastLeaveSpeed / lockFrames are
//     exported for the trick system to observe.
//   * spinDeg/flipDeg/airTime are NOT reset on leaving a rail even though a
//     rail-off is arguably a fresh air window. That is the trick lane's call,
//     not this module's.
//   * ps.prewound is written on a jump-off ONLY when a prewind was actually
//     charged during the grind (crouch + spin held). The contract requires the
//     rail exit to carry prewind, and physics only latches prewind in its
//     GROUND tick — during a grind the rider is airborne as far as physics is
//     concerned, so nothing else can carry it.
//
// Pure JS. No imports, no globals, no Date, no Math.random. Deterministic.

// --------------------------------------------------------------------------
// cited primitives
// --------------------------------------------------------------------------
const RIDER_MASS_KG = 80;      // CONTRACTS.md
const RIDER_HEIGHT_M = 1.8;    // CONTRACTS.md
const G = 9.81;                // physics.mjs DEFAULTS.G_GROUND
const PH_MU_BASE = 0.0305;     // physics.mjs DEFAULTS.MU_BASE
const PH_LAMBDA_LONG = 0.2235; // physics.mjs DEFAULTS.LAMBDA_LONG
const PH_V_CAP = 33;           // physics.mjs DEFAULTS.V_CAP
const PH_V_BOOST = 31;         // physics.mjs DEFAULTS.V_BOOST
const PH_J_MIN = 2.1;          // physics.mjs DEFAULTS.J_MIN
const PH_J_MAX = 5.0;          // physics.mjs DEFAULTS.J_MAX
const AIR_RHO = 1.2;           // kg/m^3, cold air
const CDA_M2 = 0.5;            // [EST] upright rider drag area
const V_REF_GRIND = 20;        // m/s, research 02 §1.6 tuck-cruise band
const V_BAL_REF = 18;          // m/s, research 02 §1.6 base-cruise ceiling
const T_BAIL_LO = 1.2;         // s, research 02 §1.5 / GR-05
const T_BAIL_HI = 6;           // s, research 02 §1.5 / GR-05

// CHOICES (see header)
const THETA_BAIL_RAD = 30 * Math.PI / 180;
const LEG_SWEEP_MPS = 1.4;
const CAPTURE_BOARDLEN_FRAC = 0.75; // centre of the §1.5 [EST] 0.5-1.0 band

// --------------------------------------------------------------------------
// derived — every line is an equation over the block above
// --------------------------------------------------------------------------
const BOARD_LEN_M = RIDER_HEIGHT_M - 0.25;
const COM_H_M = RIDER_HEIGHT_M / 2;
const OMEGA_P = Math.sqrt(G / COM_H_M);
const X_MAX = COM_H_M * Math.sin(THETA_BAIL_RAD);
const LAMBDA_RAIL = 0.5 * AIR_RHO * CDA_M2 * V_REF_GRIND / RIDER_MASS_KG;
const DRAG_SCALE = LAMBDA_RAIL / PH_LAMBDA_LONG;
const F0_RAIL = PH_MU_BASE * G;
const T_BOOST = PH_V_BOOST * PH_LAMBDA_LONG + F0_RAIL;
const T_BAIL_REF = Math.sqrt(T_BAIL_LO * T_BAIL_HI);
const LAM_REF = OMEGA_P * Math.min(1, V_BAL_REF / PH_V_CAP);
const D_REF = LAM_REF / (Math.expm1(LAM_REF * T_BAIL_REF));
const SIGMA_WANDER = D_REF * X_MAX / V_BAL_REF;
const BAL_GAIN = LEG_SWEEP_MPS / X_MAX;
const MIN_LOCK_V = Math.sqrt(2 * PH_MU_BASE * G * BOARD_LEN_M);
const CAPTURE_R = CAPTURE_BOARDLEN_FRAC * BOARD_LEN_M;
const ALIGN_MAX_RAD = Math.PI / 3;
// reported: the invariant of the balance model (see header)
const BAIL_DIST_M = Math.log(1 + LAM_REF / D_REF) * PH_V_CAP / OMEGA_P;
// the rider's stance asymmetry has one fixed sign — deterministic, no random
const DRIFT_SIGN = 1;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exact flow of dv/dt = a - b*v over dt, and the exact integral of v dt over
// the same step. Both closed form => one 100 ms step == ten 10 ms steps to
// machine precision (GR-09).
function flowSpeed(v0, a, b, dt) {
  if (b <= 1e-12) return v0 + a * dt;
  const veq = a / b;
  return veq + (v0 - veq) * Math.exp(-b * dt);
}
function flowDist(v0, a, b, dt) {
  if (b <= 1e-12) return v0 * dt + 0.5 * a * dt * dt;
  const veq = a / b;
  // integral of veq + (v0-veq)e^{-b t} dt  =  veq*dt + (v0-veq)(1-e^{-b dt})/b
  return veq * dt + (v0 - veq) * (-Math.expm1(-b * dt)) / b;
}
// Speed AND distance over one step for dv/dt = a - b*v, v0 >= 0, held inside
// [0, vmax]. The saturation instants are solved analytically rather than
// clamped after the fact, so the pair stays split-step exact even when the
// step crosses the speed cap (boost) or the Coulomb stop. Clamping only the
// speed and integrating the unclamped distance was a real 0.1% over-advance
// during a boosted grind; this removes it.
function longFlow(v0, a, b, dt, vmax) {
  if (v0 > vmax) v0 = vmax;
  if (b <= 1e-12) {
    const v = v0 + a * dt;
    if (v > vmax || v < 0) { // linear fallback: solve the crossing directly
      const tc = a !== 0 ? ((v > vmax ? vmax : 0) - v0) / a : dt;
      const tk = clamp(tc, 0, dt);
      const vEnd = v > vmax ? vmax : 0;
      return { v: vEnd, s: v0 * tk + 0.5 * a * tk * tk + vEnd * (dt - tk) };
    }
    return { v, s: v0 * dt + 0.5 * a * dt * dt };
  }
  const veq = a / b;
  if (veq > v0) {                       // accelerating toward veq
    // v0 <= vmax, not v0 < vmax: once the speed is sitting exactly ON the cap
    // the crossing time is 0 and the whole step is travelled at vmax. Writing
    // the strict inequality here let a saturated boosted grind fall through to
    // the uncapped distance integral and advance 0.1% too far every frame
    // (measured: 33.04 m/s of apparent travel against alongSpeed 33.00).
    if (veq > vmax && v0 <= vmax) {
      const tc = Math.log((v0 - veq) / (vmax - veq)) / b;
      if (tc < dt) return { v: vmax, s: flowDist(v0, a, b, Math.max(tc, 0)) + vmax * (dt - Math.max(tc, 0)) };
    }
    return { v: Math.min(flowSpeed(v0, a, b, dt), vmax), s: flowDist(v0, a, b, dt) };
  }
  if (veq < 0) {                        // decelerating through zero (Coulomb stop)
    const t0 = Math.log((v0 - veq) / -veq) / b;
    if (t0 < dt) return { v: 0, s: flowDist(v0, a, b, t0) };
  }
  return { v: flowSpeed(v0, a, b, dt), s: flowDist(v0, a, b, dt) };
}

export function createRails(env) {
  // ------------------------------------------------------------------------
  // Rail preprocessing. Read ONCE; after this the grind is 1-D.
  // ------------------------------------------------------------------------
  const rails = (env && env.rails ? env.rails : []).map(r => {
    const pts = r.points.map(p => [p[0], p[1], p[2]]);
    const n = pts.length - 1;
    const seg = [];
    const cum = [0];
    for (let i = 0; i < n; i++) {
      const d = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]];
      const len = Math.hypot(d[0], d[1], d[2]);
      const len2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const u = len > 1e-12 ? [d[0] / len, d[1] / len, d[2] / len] : [0, 0, 1];
      seg.push({ d, len, len2, u });
      cum.push(cum[i] + len);
    }
    // Signed HORIZONTAL curvature per vertex: turn angle between the incoming
    // and outgoing segment directions divided by the mean of their lengths.
    // Positive = turning left (+y cross), which is the same sense as a
    // positive rotation about +y — the sense `balance` positive uses.
    // Horizontal only: it is the centrifugal term in the rider's frame that
    // tilts the pendulum. Vertical curvature changes normal load, not lean.
    const kap = new Array(pts.length).fill(0);
    for (let i = 1; i < n; i++) {
      const a = seg[i - 1].u, b = seg[i].u;
      const ah = Math.hypot(a[0], a[2]) || 1, bh = Math.hypot(b[0], b[2]) || 1;
      const ax = a[0] / ah, az = a[2] / ah, bx = b[0] / bh, bz = b[2] / bh;
      const cross = az * bx - ax * bz;      // +y component of a x b
      const dotp = ax * bx + az * bz;
      const turn = Math.atan2(cross, dotp); // signed rad
      const meanLen = 0.5 * (seg[i - 1].len + seg[i].len);
      kap[i] = meanLen > 1e-9 ? turn / meanLen : 0;
    }
    if (n >= 1) { kap[0] = kap[1] ?? 0; kap[n] = kap[n - 1] ?? 0; }
    return { id: r.id, pts, seg, cum, kap, length: cum[n], width: r.width ?? 0.2 };
  });

  const segIndexAt = (rail, s) => {
    const n = rail.seg.length;
    let lo = 0, hi = n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rail.cum[m] <= s) lo = m; else hi = m - 1; }
    return clamp(lo, 0, n - 1);
  };
  const pointAt = (rail, s) => {
    const i = segIndexAt(rail, s);
    const u = rail.seg[i].len > 1e-12 ? clamp((s - rail.cum[i]) / rail.seg[i].len, 0, 1) : 0;
    const P = rail.pts[i], d = rail.seg[i].d;
    return [P[0] + d[0] * u, P[1] + d[1] * u, P[2] + d[2] * u];
  };
  const tangentAt = (rail, s) => rail.seg[segIndexAt(rail, s)].u;
  const curvatureAt = (rail, s) => {
    const i = segIndexAt(rail, s);
    const u = rail.seg[i].len > 1e-12 ? clamp((s - rail.cum[i]) / rail.seg[i].len, 0, 1) : 0;
    return rail.kap[i] * (1 - u) + rail.kap[i + 1] * u;
  };
  // Horizontal left-normal of the tangent: up x tangent, normalised in xz.
  // For tangent +z this is +x, i.e. the direction a positive `balance` leans.
  const lateralAt = (rail, s) => {
    const t = tangentAt(rail, s);
    const h = Math.hypot(t[0], t[2]) || 1;
    return [t[2] / h, 0, -t[0] / h];
  };

  // Closest point on one rail. Returns the globally closest (for the disarm
  // hysteresis) and the closest INTERIOR projection (the only capture site).
  function closest(rail, p) {
    let best = null, bestIn = null;
    for (let i = 0; i < rail.seg.length; i++) {
      const S = rail.pts[i], sg = rail.seg[i];
      if (sg.len2 <= 1e-18) continue;
      const raw = ((p[0] - S[0]) * sg.d[0] + (p[1] - S[1]) * sg.d[1] + (p[2] - S[2]) * sg.d[2]) / sg.len2;
      const u = clamp(raw, 0, 1);
      const qx = S[0] + sg.d[0] * u, qy = S[1] + sg.d[1] * u, qz = S[2] + sg.d[2] * u;
      const dist = Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
      const rec = { dist, s: rail.cum[i] + u * sg.len };
      if (!best || dist < best.dist) best = rec;
      if (raw >= 0 && raw <= 1 && (!bestIn || dist < bestIn.dist)) bestIn = rec;
    }
    return { best, bestIn };
  }

  const config = {
    // contract-required
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / LAM_REF,
    curveTolerance_rad: THETA_BAIL_RAD,
    minLockSpeed_mps: MIN_LOCK_V,
    // the balance plant
    pendulumRate_hz: OMEGA_P,
    balanceSaturationSpeed_mps: PH_V_CAP,
    balanceLeanMax_m: X_MAX,
    balanceGain_hz: BAL_GAIN,
    railWander_mPerM: SIGMA_WANDER,
    passiveBailDistance_m: BAIL_DIST_M,
    // the 1-D drag law: dv/dt = -(railCoulomb + railLambda*v) - g*sin(pitch)
    railCoulomb_mps2: F0_RAIL,
    railLambda_hz: LAMBDA_RAIL,
    snowLambda_hz: PH_LAMBDA_LONG,
    boostThrust_mps2: T_BOOST,
    speedCap_mps: PH_V_CAP,
    // capture
    captureAlignMax_rad: ALIGN_MAX_RAD,
    boardLength_m: BOARD_LEN_M,
    comHeight_m: COM_H_M,
    // exit
    ollieJumpMin_mps: PH_J_MIN,
    ollieJumpMax_mps: PH_J_MAX,
  };

  function init() {
    return {
      // contract-required
      onRail: false,
      railId: null,
      t: 0,
      alongSpeed: 0,
      balance: 0,
      bailed: false,
      lastLeaveSpeed: 0,
      lockFrames: 0,
      // observability for the view / trick layers (read-only to them)
      s: 0,
      railLength: 0,
      curvature: 0,
      tangentYaw: 0,
      leanEquilibrium: 0,
      lastExit: null,      // 'jump' | 'end' | 'bail' | null
      _armed: true,        // capture disarmed after a bail until the tube is left
      _rail: null,
      _prewind: 0,
    };
  }

  // Release the rider: write the along-rail velocity back into physics, plus
  // whatever the exit adds. Speed is carried, never scrubbed (GR-04).
  function release(gs, ps, kind, extra) {
    const rail = gs._rail;
    const tan = tangentAt(rail, clamp(gs.s, 0, rail.length));
    const v = gs.alongSpeed;
    ps.vel[0] = tan[0] * v + (extra ? extra[0] : 0);
    ps.vel[1] = tan[1] * v + (extra ? extra[1] : 0);
    ps.vel[2] = tan[2] * v + (extra ? extra[2] : 0);
    gs.lastLeaveSpeed = Math.abs(v);
    gs.onRail = false;
    gs.railId = null;
    gs._rail = null;
    gs.lastExit = kind;
    gs.bailed = kind === 'bail';
    gs.balance = 0;
    gs.lockFrames = 0;
    if (kind === 'bail') gs._armed = false; // must leave the tube to re-lock
  }

  function tryCapture(gs, ps) {
    const speed3 = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);

    // Re-arm once the rider has genuinely left every capture tube.
    if (!gs._armed) {
      let dmin = Infinity;
      for (const rail of rails) { const c = closest(rail, ps.pos); if (c.best && c.best.dist < dmin) dmin = c.best.dist; }
      if (dmin > CAPTURE_R) gs._armed = true;
      else return false;
    }
    // §1.5: the capture test runs on contact, or airborne while descending.
    if (!ps.onGround && ps.vel[1] > 0) return false;
    if (speed3 < MIN_LOCK_V) return false;

    let pick = null;
    for (const rail of rails) {
      const c = closest(rail, ps.pos);
      if (!c.bestIn || c.bestIn.dist > CAPTURE_R) continue;
      if (!pick || c.bestIn.dist < pick.d) pick = { rail, s: c.bestIn.s, d: c.bestIn.dist };
    }
    if (!pick) return false;

    const tan = tangentAt(pick.rail, pick.s);
    const along = ps.vel[0] * tan[0] + ps.vel[1] * tan[1] + ps.vel[2] * tan[2];
    if (Math.abs(along) < MIN_LOCK_V) return false;
    if (Math.abs(along) / Math.max(speed3, 1e-9) < Math.cos(ALIGN_MAX_RAD)) return false;

    // MEASURED, THEN DELETED: an earlier revision seeded balance from the
    // lateral closing speed (the board is arrested by the rail, the CoM is
    // not), b0 = vlat/(x_max*lambda_b). It is right for a rigid body and wrong
    // for a rider. Approaching the harness' curved rail at only 20 deg gives
    // vlat = 5.8 m/s and therefore b0 = -8.1: an instant, physically-correct,
    // completely unplayable bail, and GR-06 could not even lock on. The
    // assumption it rests on — that the CoM tracks the board's velocity vector
    // at touchdown — is false: a rider steering onto a rail arrives already
    // banked to the rail line. Sources agree (§1.5 "to grind, just land on a
    // rail"; contract: "convert speed to along-rail speed", no angle penalty).
    // So capture starts at balance 0 and the ALIGNMENT test above is the only
    // approach-quality guard.
    // COST: a sloppy 55-deg slam onto a rail is as clean as a perfect entry.
    // A landing-quality penalty belongs to the trick lane (it owns clean /
    // sketchy / crash), not here.

    // ---- the ONE legal position write: the documented lock-on snap ----
    const P = pointAt(pick.rail, pick.s);
    ps.pos[0] = P[0]; ps.pos[1] = P[1]; ps.pos[2] = P[2];

    gs.onRail = true;
    gs.railId = pick.rail.id;
    gs._rail = pick.rail;
    gs.s = pick.s;
    gs.railLength = pick.rail.length;
    gs.t = pick.rail.length > 0 ? pick.s / pick.rail.length : 0;
    gs.alongSpeed = along;
    gs.balance = 0;
    gs.bailed = false;
    gs.lastExit = null;
    gs.lockFrames = 0;
    gs._prewind = 0;
    gs.curvature = curvatureAt(pick.rail, pick.s);
    gs.tangentYaw = Math.atan2(tan[2], tan[0]);
    // NO velocity write here. The caller falls straight through into the
    // on-rail update for this same frame, which advances s and writes the
    // constraint velocity for the new s.
    // MEASURED, THEN FIXED: writing vel = tangent*alongSpeed here instead made
    // physics advance the rider by alongSpeed*dt on the very next tick while
    // gs.s had not moved, so the following frame's constraint velocity came
    // out ~0 — a one-frame dead stop, 0.28 m of lost travel, visible as a
    // hitch every time a rider touches a rail. Falling through removes the
    // special case entirely rather than papering over it.
    return true;
  }

  function step(gstate, physState, input, dt) {
    const gs = gstate, ps = physState, inp = input || {};
    if (!(dt > 0)) return gs;

    // Capture falls THROUGH into the on-rail update on the same frame.
    if (!gs.onRail && !tryCapture(gs, ps)) return gs;
    if (!gs.onRail) return gs;

    const rail = gs._rail;
    const s0 = clamp(gs.s, 0, rail.length);
    const tan0 = tangentAt(rail, s0);

    // ---- jumpRelease: leave PRESERVING speed (and prewind) -----------------
    if (inp.jumpRelease) {
      // Same legs as a snow ollie: physics' own charge->impulse law.
      const J = PH_J_MIN + clamp(ps.charge ?? 0, 0, 1) * (PH_J_MAX - PH_J_MIN);
      const pw = gs._prewind;
      release(gs, ps, 'jump', [0, J, 0]);
      if (pw !== 0) ps.prewound = pw; // contract: the exit carries prewind
      return gs;
    }

    // ---- prewind charged ON the rail (physics only latches it on ground) ---
    if (inp.crouch && Math.abs(inp.spin ?? 0) > 0.3) gs._prewind = Math.sign(inp.spin);
    else if (!inp.crouch) gs._prewind = 0;

    // ---- 1-D longitudinal state: closed-form, dt-exact (GR-09) -------------
    // dv/dt = -g*sin(pitch) - railCoulomb*sign(v) - railLambda*v  [+ boost]
    const v0 = gs.alongSpeed;
    const dir = v0 >= 0 ? 1 : -1;
    const pitchDrive = -G * tan0[1] * dir;          // along +|v|, signed by travel dir
    const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
    const a = pitchDrive - F0_RAIL + (boosting ? T_BOOST : 0);
    const b = LAMBDA_RAIL;
    // PH_V_CAP is physics' own hard speed clamp; the rail obeys the same one.
    const flow = longFlow(Math.abs(v0), a, b, dt, PH_V_CAP);
    gs.alongSpeed = dir * flow.v;
    const sNew = s0 + dir * flow.s;

    // ---- ran off an end: leave carrying speed ------------------------------
    if (sNew <= 0 || sNew >= rail.length) {
      gs.s = clamp(sNew, 0, rail.length);
      gs.t = rail.length > 0 ? gs.s / rail.length : 0;
      release(gs, ps, 'end', null);
      return gs;
    }

    // ---- balance: inverted-pendulum surrogate, closed form -----------------
    // db/dt = lambda_b*(b - b_eq) + drift - balanceGain*steer
    const vAbs = Math.abs(v0);
    const lam = OMEGA_P * Math.min(1, vAbs / PH_V_CAP);
    const kap = curvatureAt(rail, s0);
    // Lean needed to ride this curvature at this speed; sign = into the turn.
    const bEq = Math.atan(kap * vAbs * vAbs / G) / THETA_BAIL_RAD;
    const drift = DRIFT_SIGN * SIGMA_WANDER * vAbs / X_MAX;
    const steer = clamp(inp.steer ?? 0, -1, 1);
    const c = -lam * bEq + drift - BAL_GAIN * steer;
    let bNew;
    if (lam > 1e-9) {
      const off = c / lam;
      bNew = -off + (gs.balance + off) * Math.exp(lam * dt);
    } else {
      bNew = gs.balance + c * dt;
    }
    gs.curvature = kap;
    gs.leanEquilibrium = bEq;

    if (Math.abs(bNew) > 1) {
      // Toppled. The CoM leaves with the lateral rate the model itself says it
      // has at the bail lean: lambda_b * x_max, directed down-lean.
      gs.s = sNew;
      gs.t = rail.length > 0 ? sNew / rail.length : 0;
      gs.balance = Math.sign(bNew);
      const nrm = lateralAt(rail, sNew);
      const vb = lam * X_MAX * Math.sign(bNew);
      release(gs, ps, 'bail', [nrm[0] * vb, 0, nrm[2] * vb]);
      gs.balance = 0;
      return gs;
    }
    gs.balance = bNew;

    // ---- place the rider: VELOCITY-only rail constraint (GR-07) ------------
    // Write the velocity that carries physics' integrator from where it
    // actually put the rider to P(s_new). Never touches pos or heading.
    const P = pointAt(rail, sNew);
    ps.vel[0] = (P[0] - ps.pos[0]) / dt;
    ps.vel[1] = (P[1] - ps.pos[1]) / dt;
    ps.vel[2] = (P[2] - ps.pos[2]) / dt;

    gs.s = sNew;
    gs.t = rail.length > 0 ? sNew / rail.length : 0;
    const tanN = tangentAt(rail, sNew);
    gs.tangentYaw = Math.atan2(tanN[2], tanN[0]);
    gs.lockFrames++;
    return gs;
  }

  return { config, init, step };
}
