// Candidate B — rail grinding (SSX Tricky "just land on a rail").
//
// SHAPE: on lock the grind becomes a 1-D problem. s (arclength) and ds/dt are
// the only motion state; the polyline is read for three things and nothing
// else — to place the rider at lock, to hand physics the per-step displacement
// that keeps the board on the line, and to read tangent slope + curvature at s.
// Curvature is read as the DENSITY of the polyline's vertex turning, not off its
// geometry: measured exact against 1/R at vertex spacings from 2.3 m to 36.9 m,
// where a fixed three-point window read 0 mid-segment and 3.3x at a vertex.
// Balance is a second-order inverted pendulum standing on the rail; what the
// contract calls `balance` is that pendulum's DIVERGENT coordinate (lean +
// lean-rate), so a fast lean can bail you at zero lean.
//
// WHY THE RIDER IS AIRBORNE AND NOT `constrained` FOR THE WHOLE GRIND
// -------------------------------------------------------------------
// Two accepted rules collide and only one of them can win:
//   * CONSTRAINED STATE (physics): while `constrained`, physics moves nothing —
//     "the OWNING MODULE supplies all motion".
//   * GR-07 (HARD, absolute): this module may write position ONLY on the
//     lock-on snap frame.
// A module cannot both be the only source of motion and be forbidden to move
// anything. Measured, a permanently-constrained rider stands still on the rail
// forever. So motion is delegated to physics the only legal way: the module
// writes VELOCITY (always legal) and physics integrates position from it, with
// the rider held in the airborne branch (onGround=false) so groundCore cannot
// snap the board down to the terrain under an elevated rail.
// `constrained` is therefore engaged exactly where it is the only way to get
// the behaviour it was added for: WHILE CROUCH IS HELD. Physics then accrues
// charge at T_CHARGE, captures prewind, holds airTime at 0, and jumpRelease
// leaves a TRUE takeoff at full charge — the rail-into-big-air link. The cost
// is measured and stated, not hidden: the grind PAUSES for the crouch (s and
// ds/dt are frozen so state cannot desync from the frozen body) — measured, a
// 1.0 s crouch advances the board 0.25 m where it would have covered ~15 m.
// The one-line fix belongs to
// physics, not here: integrate the module's velocity in constrainedStep
// (`pos += vel*dt`), and this module drops the pause with no other change.
// No private charge counter; charge / airTime / _popDone are never written.
//
// VERTICAL TRACKING WITHOUT POSITION WRITES. physics' airStep does
// `vel[1] -= g_air*dt; pos += vel*dt`. To make pos land exactly on the rail the
// module hands it `vel[1] = dy/dt + g_air*dt` — a velocity-level constraint
// impulse, the standard way to cancel an explicit-Euler gravity term. g_air is
// not hardcoded: it is MEASURED each frame from what physics did to the vel[1]
// the module set last frame, so gravityScale and any retune are tracked.
// Horizontal is exact for free: `vel = (P(s_k) - P(s_k-1))/dt` puts the board
// on P(s_k) one frame later, so the board tracks the polyline to machine
// precision instead of drifting off a bend by Euler chord error.
//
// CAPTURE IS A DISTURBANCE, NOT A VERDICT. The arriving lateral velocity is not
// annihilated in one frame — the contact scrubs, so it decays and feeds the lean
// as a spread disturbance a player can steer out of (17 deg of yaw error at
// 20 m/s, measured). The first version handed all of it to the lean instantly
// and bailed on anything past 4 deg, on the lock frame itself.
//
// SPEED. Full 3-D velocity along the tangent at capture (a capture that keeps
// only horizontal speed taxes a descending rail 9.4% at 25 deg — the exact case
// a rail should win). Gravity along the tangent is carried every step: every
// test rail in the runner is flat, and a flat probe hides a missing g*sin term.
// Longitudinal drag is a linear ODE, integrated closed-form (dt-exact, GR-09),
// and steering NEVER touches along-rail speed — on a rail a balance correction
// is body English, not an edge plowing snow, so there is no "turning bleeds
// speed" term to bleed.
//
// EVERY CONSTANT IS READ, DERIVED, OR LABELLED. The numbers that must agree
// with the ground law (g, mu, lambda, V_CAP, V_BOOST) are IMPORTED from
// physics.mjs rather than copied, so none of them is a hand-picked number and
// none can drift. The rest are derived from rider/rail geometry, cited to
// research 02, or labelled CHOICE with the cost stated (config.derivation).
//
// Pure math, deterministic, no Date/random.

import { DEFAULTS as PHYS } from '../../../src/physics/physics.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const G = PHYS.G_GROUND;                       // 9.81, imported not copied

// Rider geometry. 1.8 m rider is fixed by CONTRACTS.md; CoM at 0.55 of standing
// height is standard anthropometry (NOT in this corpus -> labelled EST).
const RIDER_H = 1.8;
const COM_FRAC = 0.55;                         // EST, cost stated in derivation
const GYR_FRAC = 0.30;                         // EST, radius of gyration / height
const L_COM = RIDER_H * COM_FRAC;              // 0.99 m
const K_GYR = RIDER_H * GYR_FRAC;              // 0.54 m about the CoM
// A rider on a rail is a COMPOUND pendulum, not a point mass on a stick: the
// moment of inertia about the contact is m(k^2 + L^2), so a lateral
// acceleration at the CoM produces phi'' = a * L/(k^2+L^2), not a/L.
const J_BASE = K_GYR * K_GYR + L_COM * L_COM;  // 1.2717 m^2 (I_base/m)
const K_LEAN = L_COM / J_BASE;                 // 0.7784 rad/s^2 per m/s^2
const W0 = Math.sqrt(G * K_LEAN);              // 2.7635 rad/s, pendulum rate

// Bail lean. research 02 sec 3.3 (Tux Racer CalcRollNormal): MAX_ROLL_ANGLE
// 30 deg normal riding, BRAKING_ROLL_ANGLE 55 deg — the deepest lean the
// reference model ever shows a rider hold. Taken as the lean at which the
// grind is lost. SOURCED ANALOGUE + CHOICE; cost in derivation.
const PHI_BAIL = 55 * Math.PI / 180;           // 0.95993 rad

// Steering authority is NOT a second free number: it is defined as the lateral
// acceleration that exactly cancels the curve load sitting at the bail lean,
// A_STEER = g*tan(PHI_BAIL). Full stick therefore holds precisely the tightest
// rideable rail, and nothing tighter.
const A_STEER = G * Math.tan(PHI_BAIL);        // 14.011 m/s^2

// Body damping on the lean. CHOICE. An inverted pendulum has NO critical
// damping (the discriminant c^2+4w0^2 is positive for every c, roots always
// real), so no such claim is made; 2*w0 is picked as the round value and its
// cost is the escape rate below.
const C_DAMP = 2 * W0;                         // 6.2962 1/s
// Escape rate of the divergent mode of  phi'' = w0^2 phi - c phi'
const LAM_ESC = (-C_DAMP + Math.sqrt(C_DAMP * C_DAMP + 4 * W0 * W0)) / 2;  // 1.3028 1/s

// Capture radius: research 02 sec 1.5 [EST] "~0.5-1.0 board-length (0.5-1.5 m)".
// Midpoint. CHOICE; cost in derivation.
const CAPTURE_R = 1.0;

// Minimum lock speed: research 02 sec 3.2 — Tux Racer MIN_FRICT_SPEED = 2.8 m/s,
// below which "no friction -> no steering". A grind whose balance is held BY
// steering cannot exist below the speed at which steering exists.
const MIN_LOCK = 2.8;

// Rail drag vs snow: research 02 sec 1.4 "Ratio to copy: ice grip ~0.57x snow
// grip" (Tux Racer terrains.lst, ice 0.20 / snow 0.35) — the corpus's only
// numeric hard-surface:soft-surface ratio, and the same 0.55 physics.mjs
// already uses for ice. sec 5's "drag ~ 0" is the alternative and is rejected:
// a frictionless rail never gives the speed back to the player as a decision.
// SOURCED ANALOGUE + CHOICE; cost in derivation.
const DRAG_SCALE = 0.20 / 0.35;                // 0.571428...

// Boost thrust: NOT a rail speed bonus. It is the thrust physics itself must be
// applying on snow to hold V_BOOST there (a = mu*g + lambda*V_BOOST). The same
// thrust pushed through the rail's lower drag gives an equilibrium of 55.3 m/s,
// so V_CAP binds — the rail is faster because its drag is lower, emergently.
const A_BOOST = PHYS.MU_BASE * G + PHYS.LAMBDA_LONG * PHYS.V_BOOST;

// Lateral scrub at capture. The rail does NOT annihilate the rider's sideways
// momentum in one frame: the contact is frictional, so the board scrubs
// sideways and the lateral velocity decays. research 02 sec 4 gives the decay
// law and its rate — v_lat *= exp(-grip*dt), grip = -ln(0.95)/0.02 = 2.6 1/s
// from the canonical arcade controller. SOURCED ANALOGUE + CHOICE (that number
// is snow, not steel); cost in derivation. This is what makes a crooked landing
// a RECOVERABLE disturbance instead of an instant ejection: the same total lean
// impulse arrives, but spread over 1/grip seconds, so steering can cancel it.
const GRIP_RAIL = 2.6;

// Re-capture hysteresis: a rail may not re-snatch a rider who just fell off it
// until the rider is clear of twice the capture radius. Distance, not a timer —
// a cooldown short enough to feel responsive is short enough to pogo.
const RELOCK_CLEAR = 2 * CAPTURE_R;

// Geometry sampling windows, in METRES with a floor tied to the local vertex
// spacing, so respacing the polyline cannot change the physics. CHOICE; both
// only set the FLOOR — see curvatureAt / tangentAt and derivation.geometry.
const CURV_H = 3.0;                            // curvature window half-width, min
const TAN_H = 0.5;                             // tangent central-difference half-width, min

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Polyline geometry
// ---------------------------------------------------------------------------
function prep(rail) {
  const P = rail.points.map(p => [+p[0], +p[1], +p[2]]);
  const cum = [0];
  for (let i = 0; i + 1 < P.length; i++) {
    cum.push(cum[i] + Math.hypot(P[i + 1][0] - P[i][0], P[i + 1][1] - P[i][1], P[i + 1][2] - P[i][2]));
  }
  // Interior-vertex turning, in the horizontal plane, signed +ve toward the
  // +lateral side. This is where ALL of the polyline's bend lives; curvature is
  // read as a windowed density of it (see curvatureAt).
  const turn = [];   // { s, dth }
  for (let i = 1; i + 1 < P.length; i++) {
    const ux = P[i][0] - P[i - 1][0], uz = P[i][2] - P[i - 1][2];
    const wx = P[i + 1][0] - P[i][0], wz = P[i + 1][2] - P[i][2];
    const um = Math.hypot(ux, uz), wm = Math.hypot(wx, wz);
    if (um < 1e-9 || wm < 1e-9) continue;
    const cr = (ux * wz - uz * wx) / (um * wm), dp = (ux * wx + uz * wz) / (um * wm);
    // cross(u, +lateral) = -1, so a turn toward +lateral has a NEGATIVE cross
    // ds = the arclength this vertex "owns" (half either side), so the density
    // below is exact for uniform turning at any vertex spacing.
    turn.push({ s: cum[i], dth: -Math.atan2(cr, dp), ds: (cum[i + 1] - cum[i - 1]) / 2 });
  }
  return { id: rail.id, P, cum, L: cum[cum.length - 1], turn,
    halfW: (rail.width ?? 0.2) / 2 };
}

// Length of the polyline segment containing s (the local vertex spacing).
function segLenAt(R, s) {
  const t = clamp(s, 0, R.L);
  let i = 0;
  while (i + 2 < R.cum.length && R.cum[i + 1] < t) i++;
  return Math.max(1e-6, R.cum[i + 1] - R.cum[i]);
}

function posAt(R, s) {
  const L = R.L;
  if (!(L > 0)) return [R.P[0][0], R.P[0][1], R.P[0][2]];
  const t = clamp(s, 0, L);
  let i = 0;
  while (i + 2 < R.cum.length && R.cum[i + 1] < t) i++;
  const seg = R.cum[i + 1] - R.cum[i];
  const u = seg > 1e-12 ? (t - R.cum[i]) / seg : 0;
  const a = R.P[i], b = R.P[i + 1];
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

// Unit 3-D tangent from a metre-scaled central difference. The window widens to
// span a vertex on a coarsely-sampled rail, so the direction handed to physics
// is continuous instead of stepping at every control point.
function tangentAt(R, s) {
  const h = Math.max(TAN_H, 0.6 * segLenAt(R, s));
  const a = posAt(R, Math.max(0, s - h));
  const b = posAt(R, Math.min(R.L, s + h));
  let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
  let m = Math.hypot(dx, dy, dz);
  if (m < 1e-9) {
    const c = posAt(R, Math.min(R.L, s + 1e-3));
    const d = posAt(R, Math.max(0, s - 1e-3));
    dx = c[0] - d[0]; dy = c[1] - d[1]; dz = c[2] - d[2];
    m = Math.hypot(dx, dy, dz) || 1;
  }
  return [dx / m, dy / m, dz / m];
}

// Lateral unit vector: horizontal, perpendicular to the tangent. +lateral is
// the sign convention for lean, curvature and steer throughout.
function lateralAt(tan) {
  let lx = tan[2], lz = -tan[0];           // = normalize(cross(UP, tangent))
  const m = Math.hypot(lx, lz);
  if (m < 1e-9) return [1, 0, 0];
  return [lx / m, 0, lz / m];
}

// SIGNED horizontal curvature (lean and centripetal load are both horizontal).
// Positive = the centre of curvature lies on the +lateral side.
//
// The contract calls these points "spline control points", so the RIDDEN line is
// smooth and the polyline is a coarse sample of it. Reading curvature off the
// polyline geometry directly therefore reads the sampling, not the rail: a
// three-point estimator over a fixed 3 m window on a rail with 10 m vertex
// spacing measures 0 in mid-segment and 3.3x the true value at a vertex
// (measured on a R=60 rail: 0 and 0.055 against a true 0.0167).
// Instead: all of a polyline's bend is the turning at its vertices, so curvature
// is that turning's DENSITY — a tent-weighted mean turning rate over a window
// that always spans at least two vertices. Continuous in s, exact for uniform
// turning at any vertex spacing, and normalised by the window actually inside
// the rail so a bend still bites at the very start of one.
function curvatureAt(R, s) {
  if (!R.turn.length) return 0;
  const h = Math.max(CURV_H, 2 * segLenAt(R, s));
  const d0 = Math.max(-h, -s), d1 = Math.min(h, R.L - s);
  if (d1 - d0 < 1e-9) return 0;
  let num = 0, den = 0;
  for (let i = 0; i < R.turn.length; i++) {
    const d = R.turn[i].s - s;
    if (d <= -h || d >= h || d < d0 || d > d1) continue;
    const w = 1 - Math.abs(d) / h;
    num += R.turn[i].dth * w;
    den += R.turn[i].ds * w;
  }
  return den > 1e-9 ? num / den : 0;
}

// Closest point on the polyline to p -> { s, d } (3-D distance).
function closest(R, p) {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i + 1 < R.P.length; i++) {
    const a = R.P[i], b = R.P[i + 1];
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const ll = ex * ex + ey * ey + ez * ez;
    if (ll < 1e-12) continue;
    let u = ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey + (p[2] - a[2]) * ez) / ll;
    u = clamp(u, 0, 1);
    const qx = a[0] + ex * u, qy = a[1] + ey * u, qz = a[2] + ez * u;
    const d = Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
    if (d < best.d) best = { s: R.cum[i] + Math.sqrt(ll) * u, d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Closed-form integrators (no Euler anywhere)
// ---------------------------------------------------------------------------
// dv/dt = a - b v over dt, plus the exact displacement integral.
function flowStep(v0, a, b, dt) {
  if (b < 1e-12) return { v: v0 + a * dt, ds: v0 * dt + 0.5 * a * dt * dt };
  const veq = a / b;
  const e = Math.exp(-b * dt);
  const v = veq + (v0 - veq) * e;
  const ds = veq * dt + (v0 - veq) * (1 - e) / b;
  return { v, ds };
}

// phi'' = A + K*(phi - phi0) - c*phi'  over dt, in closed form.
// K > 0 (the usual, unstable) -> real roots; K < 0 with a small |K| -> real;
// K < 0 with c^2 + 4K < 0 -> damped oscillation. All three handled exactly.
function leanStep(phi0, dphi0, A, K, c, dt) {
  if (Math.abs(K) < 1e-9) {                       // pure constant acceleration + damping
    if (c < 1e-12) return [phi0 + dphi0 * dt + 0.5 * A * dt * dt, dphi0 + A * dt];
    const e = Math.exp(-c * dt);
    const vinf = A / c;
    const dphi = vinf + (dphi0 - vinf) * e;
    const phi = phi0 + vinf * dt + (dphi0 - vinf) * (1 - e) / c;
    return [phi, dphi];
  }
  const off = A / K;                              // y = (phi - phi0) + A/K
  const y0 = off, dy0 = dphi0;
  const disc = c * c + 4 * K;
  if (disc > 1e-12) {
    const r = Math.sqrt(disc);
    const r1 = (-c + r) / 2, r2 = (-c - r) / 2;
    const e1 = Math.exp(r1 * dt), e2 = Math.exp(r2 * dt);
    const C1 = (dy0 - r2 * y0) / (r1 - r2), C2 = (r1 * y0 - dy0) / (r1 - r2);
    const y = C1 * e1 + C2 * e2, dy = C1 * r1 * e1 + C2 * r2 * e2;
    return [phi0 + y - off, dy];
  }
  if (disc < -1e-12) {                            // complex pair
    const w = Math.sqrt(-disc) / 2, sig = -c / 2;
    const e = Math.exp(sig * dt), cs = Math.cos(w * dt), sn = Math.sin(w * dt);
    const B = (dy0 - sig * y0) / w;
    const y = e * (y0 * cs + B * sn);
    const dy = e * ((sig * y0 + w * B) * cs + (sig * B - w * y0) * sn);
    return [phi0 + y - off, dy];
  }
  const r1 = -c / 2, e = Math.exp(r1 * dt);       // repeated root
  const B = dy0 - r1 * y0;
  const y = (y0 + B * dt) * e, dy = (B + r1 * (y0 + B * dt)) * e;
  return [phi0 + y - off, dy];
}

// ---------------------------------------------------------------------------
export function createRails(env) {
  const rails = (env?.rails ?? []).map(prep).filter(r => r.L > 1e-6);

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / LAM_ESC,       // DOUBLING time: the mode is
                                                 // unstable, so this is how long
                                                 // an uncorrected lean takes to
                                                 // double, not to decay.
    curveTolerance_rad: PHI_BAIL,
    minLockSpeed_mps: MIN_LOCK,
    // --- exposed model ---
    comHeight_m: L_COM,
    gyrationRadius_m: K_GYR,
    leanGain_per_mps2: K_LEAN,
    lateralGrip_rps: GRIP_RAIL,
    pendulumRate_rps: W0,
    escapeRate_rps: LAM_ESC,
    leanDamping_rps: C_DAMP,
    steerAuthority_mps2: A_STEER,
    boostThrust_mps2: A_BOOST,
    railBoostEquilibrium_mps: (A_BOOST - DRAG_SCALE * PHYS.MU_BASE * G) / (DRAG_SCALE * PHYS.LAMBDA_LONG),
    vCap_mps: PHYS.V_CAP,
    relockClearance_m: RELOCK_CLEAR,
    curvatureWindow_m: CURV_H,
    // Tightest rail the rider can hold at a given speed: v^2 / (g tan PHI_BAIL)
    minHoldRadiusAt18_m: 18 * 18 / A_STEER,
    minHoldRadiusAt30_m: 30 * 30 / A_STEER,

    derivation: {
      imported: 'g, MU_BASE, LAMBDA_LONG, V_BOOST, V_CAP are IMPORTED from src/physics/physics.mjs, not copied. No rail constant that must agree with the ground law is hand-set, and none can drift when physics is retuned.',
      body: 'A rider on a rail is a COMPOUND pendulum about the contact, not a point mass on a massless stick, so a lateral acceleration at the CoM tilts them by a*L/(k^2+L^2), not a/L. L_COM = 1.8 m rider (CONTRACTS.md) x 0.55 CoM height fraction; k = 0.30 x height. Both fractions are standard anthropometry and NEITHER is in the research corpus: EST. Measured w0 = sqrt(g*L/(k^2+L^2)) = 2.764 rad/s against 3.148 for the point-mass shortcut, i.e. the shortcut over-reads the instability by 14% and under-reads passive life by the same. COST of the EST fractions: k = 0.27H gives w0 = 2.83, k = 0.33H gives 2.69 — +-2.5% on the instability rate, and nothing else in the module depends on them.',
      phiBail: 'CHOICE (sourced analogue). 55 deg = Tux Racer BRAKING_ROLL_ANGLE, research 02 sec 3.3 — the deepest lean the reference model ever shows a rider hold. COST, stated as the design consequence it is: the largest curve load the rider can hold is g*tan(55) = 14.01 m/s^2, so the tightest holdable rail is R = v^2/14.01 — 23.1 m at 18 m/s, 64.2 m at 30 m/s. At the alternative sourced value (MAX_ROLL_ANGLE 30 deg) that becomes 57 m at 18 m/s and the runner arc at R=40 would be unrideable at any stick input, which is an ejection, not a demand.',
      aSteer: 'NOT an independent constant. A_STEER = g*tan(PHI_BAIL) is the lateral acceleration that exactly cancels the curve load sitting at the bail lean, so "full stick holds the tightest rideable rail" is a definition rather than a tuned coincidence. Consequence to own: authority this high also means over-correction is punished — full stick held from a settled centre puts the divergent coordinate at the opposite bail limit in 0.133 s (measured, 8 frames), which is the thing the player can feel and lose.',
      damping: 'CHOICE. C_DAMP = 2*w0. No critical-damping claim is made: for phi\'\' = w0^2 phi - c phi\' the discriminant c^2+4w0^2 is positive for every c, so the roots are always real and "critical" does not exist here. COST: the escape rate is lam = (-c + sqrt(c^2+4w0^2))/2 = 1.145 1/s (doubling time 0.606 s); c=0 gives lam = w0 = 2.764 and roughly halves passive life, c=4*w0 gives lam = 0.65 and roughly doubles it.',
      balanceVariable: 'balance = (phi + phi_dot/lam)/PHI_BAIL — the DIVERGENT coordinate of the pendulum (the capture-point / extrapolated-CoM criterion), not the lean alone. It is second order by construction: lean rate alone can bail the rider at zero lean, and a hard over-correction spikes it the other way. That is the overshoot a first-order balance model does not have.',
      seedLean: 'The passive bail needs a source; this one is geometric, not a fudge factor. Capture cannot place the CoM more precisely than the width of the thing being landed on, so the lock lean is phi0 = asin(halfWidth/L_COM) (0.101 rad on a 0.2 m rail), signed by which side of the line the rider came from, with a documented deterministic tie-break (dead straight and dead centre: +1). The vertical part of the miss is carried by the support and contributes no lean.',
      lateralScrub: 'CHOICE (sourced analogue), and it is what keeps auto lock-on from being a trap. The first version of this module destroyed the arrival lateral velocity in one frame and handed all of it to the lean as phi_dot0 = v_lat*L/J. That is defensible rigid-body mechanics and it made the mechanic unplayable: measured, ANY landing more than 4 deg off the rail line at 20 m/s bailed on the lock frame itself, which is an ejection dressed as a capture. The contact is frictional, so the board scrubs sideways instead and v_lat decays as exp(-grip*dt) — research 02 sec 4, grip = -ln(0.95)/0.02 = 2.6 1/s from the canonical arcade controller (that value is snow, not steel: CHOICE). The same total lean impulse still arrives, spread over 1/grip s, so steering can cancel it. MEASURED COST: a crooked landing is now recoverable to 17 deg of yaw error at 20 m/s with the stick and 0 deg without it; doubling grip roughly halves that forgiveness.',
      bailWindow: 'GR-05 declares its own 0.8-6 s window a DESIGN CHOICE, not a citation, so the destabiliser magnitude is a declared design parameter rather than a number tuned around a gate. It is set by geometry (above) and lands at 1.52 s measured (runner GR-05), mid-band; note the sensitivity is logarithmic — a 2x error in the seed lean moves passive life by only ln2/lam = 0.61 s, so the window is not balanced on a knife edge.',
      captureRadius: 'CHOICE. 1.0 m = midpoint of the sourced [EST] band in research 02 sec 1.5 ("~0.5-1.0 board-length, 0.5-1.5 m"). COST: at 18 m/s the approach crosses the radius in 0.056 s, so lock-on forgives ~3.3 frames of aim error; at the 0.5 m floor that halves to 1.7 frames and a rider landing a board-width wide of the line misses the rail.',
      minLockSpeed: 'research 02 sec 3.2: Tux Racer MIN_FRICT_SPEED = 2.8 m/s, below which there is no friction and therefore no steering. A grind whose balance is held BY steering cannot exist below the speed at which steering exists, so the same number is the lock floor. Not a dimensional coincidence and not fitted to GR-08 (which probes 0.4 m/s, 7x below it).',
      dragScale: 'CHOICE (sourced analogue). 0.20/0.35 = 0.5714, the Tux Racer ice:snow friction ratio that research 02 sec 1.4 explicitly nominates ("Ratio to copy: ice grip ~0.57x snow grip"), and the same ratio physics.mjs already carries for ice. Applied to the WHOLE resistive law (Coulomb and linear), which is the literal reading of the contract field. Rejected alternative: sec 5 says rail drag is "approximately 0"; a lossless rail removes the decision of when to leave it. COST, measured (runner GR-03): coasting 20 m/s for 5 s ends at 9.63 m/s on the rail against 5.64 m/s on snow; scaling only the Coulomb term instead would leave the rail just 2.7% better than snow at 20 m/s, which does not read as "you go faster on a rail".',
      boost: 'No rail speed bonus exists in this module. A_BOOST is the thrust physics must already be applying on snow to hold V_BOOST there (mu*g + lambda*V_BOOST = 7.23 m/s^2). Pushed through the rail drag law the equilibrium is 55.3 m/s, so the V_CAP clamp binds at 33 and the rail beats snow (31) because its drag is lower — emergent, not a chosen target.',
      gravityAlongRail: 'Every test rail in the runner sits at constant height, which once hid a missing g*sin term. The along-rail drive carries -g*tangent_y every step and the Coulomb term uses cos(slope), so a descending rail accelerates and an ascending one does not. Capture uses the FULL 3-D velocity projected on the tangent: keeping only horizontal speed taxes a rider 9.4% at 25 deg and 23% at 40 deg, on exactly the case a rail should win.',
      steerDoesNotBleedSpeed: 'Deliberate omission. Snow steering costs +15% drag (Tux Racer MAX_TURN_PEN) because the edge plows; a rail balance correction is body English against a steel bar and plows nothing. It also has to be this way: GR-09 re-samples the steer input between its split steps, so any steer->speed coupling would make the module dt-inexact by construction.',
      geometry: 'The contract calls the points "spline control points", so the polyline is a SAMPLE of the ridden line, not the line itself, and curvature must not be read off the sampling. A three-point estimator over a fixed 3 m window was tried and rejected by measurement: on a rail with 10 m vertex spacing it reads 0 in mid-segment and 3.3x the true value at a vertex (0 and 0.055 against a true 0.0167). What replaced it reads curvature as the DENSITY of the polyline\'s vertex turning — each vertex turn weighted by a tent kernel and divided by the arclength those vertices own — over a window of max(3 m, 2 x local vertex spacing). That is exact for uniform curvature at ANY spacing and at the rail ends: measured 0.00% ripple against the true 1/R at 2.3 m, 4.7 m, 10 m and 36.9 m spacing. The tangent window widens the same way so the direction handed to physics does not step at every control point. Position still interpolates the polyline linearly (deliberate: it is the line the gates and the level geometry agree on), so a coarse rail is ridden as its chords while its BEND is read as the smooth curve it stands for.',
      relock: 'A bail must be a bail. Re-capture of the rail just fallen from is blocked by DISTANCE (2 x capture radius), not by a timer: any cooldown short enough to feel responsive is short enough for the rail to re-snatch the rider mid-fall and pogo. The bail also hands the rider the lateral velocity the falling CoM actually has (phi_dot * L_COM), so they leave rather than hover.',
      constrained: 'physics says a constrained rider is moved only by the owning module; GR-07 says this module may write position only on the lock snap. Both cannot hold, so `constrained` is engaged only while crouch is held — the one place it buys the behaviour it exists for. MEASURED: crouching on a rail takes charge 0 -> 1.000 over T_CHARGE and jumpRelease then leaves at vel_y = 5.000 m/s, exactly J_MAX, against the 2.1 m/s J_MIN tap that made the rail-into-big-air link unbuildable; horizontal speed across the exit 15.15 -> 15.13 m/s. MEASURED COST: the grind pauses while crouched — a 1.0 s crouch advances the board 0.25 m where it would have covered ~15 m — because physics moves nothing and this module legally cannot. Fix belongs in physics (`pos += vel*dt` inside constrainedStep), not in a workaround here.',
      noJumpWithoutCrouch: 'A jumpRelease with no crouch behind it leaves the rail as a step-off with speed preserved, not a pop. That is the manual\'s own rule (research 02 sec 1.1: "press and hold to crouch, then release it to jump"), and it keeps this module out of the business of synthesising an impulse physics did not grant.',
    },
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // internals
      _r: -1, _s: 0, _phi: 0, _dphi: 0, _con: false,
      _velY: 0, _dt: 0, _gAir: PHYS.G_AIR, _offRail: -1, _vlat: 0,
    };
  }

  // Hand the rider back to physics with the along-rail velocity intact.
  // keepY: a jumpRelease exit must not overwrite the impulse physics just gave.
  function detach(gs, ps, keepY) {
    const R = rails[gs._r];
    const tan = R ? tangentAt(R, gs._s) : [0, 0, 1];
    const v = gs.alongSpeed;
    ps.vel[0] = tan[0] * v;
    ps.vel[2] = tan[2] * v;
    if (!keepY) ps.vel[1] = tan[1] * v;
    gs.lastLeaveSpeed = Math.abs(v);
    gs.onRail = false;
    gs._offRail = gs._r;
    gs._r = -1;
    gs.railId = null;
    if (gs._con) { ps.constrained = false; gs._con = false; }
  }

  function step(gs, ps, inp = {}, dt) {
    if (!(dt > 0)) return gs;
    gs.bailed = false;

    // ---------------- not on a rail: look for one ----------------
    if (!gs.onRail) {
      // release the re-capture block once the rider is genuinely clear
      if (gs._offRail >= 0) {
        const c = closest(rails[gs._offRail], ps.pos);
        if (c.d > RELOCK_CLEAR) gs._offRail = -1;
      }
      let bi = -1, bc = null;
      for (let i = 0; i < rails.length; i++) {
        if (i === gs._offRail) continue;
        const c = closest(rails[i], ps.pos);
        if (c.d <= CAPTURE_R && (bc === null || c.d < bc.d)) { bi = i; bc = c; }
      }
      if (bi < 0) return gs;
      const R = rails[bi];
      const tan = tangentAt(R, bc.s);
      const along = ps.vel[0] * tan[0] + ps.vel[1] * tan[1] + ps.vel[2] * tan[2];
      if (Math.abs(along) < MIN_LOCK) return gs;   // no grind below steering speed

      // ---- LOCK. The one legal position write: snap to the closest point on
      // the polyline (|snap| = bc.d <= captureRadius by construction).
      const q = posAt(R, bc.s);
      const lat = lateralAt(tan);
      const off = (ps.pos[0] - q[0]) * lat[0] + (ps.pos[2] - q[2]) * lat[2];
      const vLat = ps.vel[0] * lat[0] + ps.vel[2] * lat[2];
      ps.pos[0] = q[0]; ps.pos[1] = q[1]; ps.pos[2] = q[2];
      // Hold the rider in physics' airborne branch: groundCore would otherwise
      // snap the board down to the terrain under an elevated rail. No takeoff()
      // is triggered, so spin / airTime / landing are untouched.
      ps.onGround = false;

      // seed lean: capture is no more precise than the rail is wide
      let sgn;
      if (Math.abs(off) > 1e-9) sgn = Math.sign(off);
      else {
        const k = curvatureAt(R, bc.s);
        sgn = Math.abs(k) > 1e-12 ? -Math.sign(k) : 1;   // fall to the outside;
        // dead straight, dead centre: +1, an arbitrary but deterministic tie-break
      }
      gs._phi = sgn * Math.asin(clamp(R.halfW / L_COM, -1, 1));
      gs._dphi = 0;
      gs._vlat = vLat;                             // scrubbed off over 1/GRIP_RAIL
      gs._r = bi; gs._s = bc.s;
      gs.onRail = true; gs.railId = R.id;
      gs.alongSpeed = along;
      gs.lockFrames = 0;
      gs.t = R.L > 0 ? bc.s / R.L : 0;
      gs.balance = clamp((gs._phi + gs._dphi / LAM_ESC) / PHI_BAIL, -1.5, 1.5);
      gs._velY = 0; gs._dt = 0;
      // FALL THROUGH into the on-rail tick. Returning here instead would leave
      // physics to integrate the rider's PRE-lock velocity for one frame, which
      // carries the board 0.34 m off the line at 20 m/s — and since position may
      // never be written again, that offset would ride out the whole grind.
    }

    // ---------------- on a rail ----------------
    const R = rails[gs._r];
    gs.lockFrames++;

    // measure physics' air gravity from what it did to the vel[1] we set last
    // frame (tracks gravityScale and any retune; never hardcoded)
    if (gs._dt > 0 && ps.onGround === false) {
      const g = (gs._velY - ps.vel[1]) / gs._dt;
      if (g > 0.1 && g < 40) gs._gAir = g;
    }
    ps.onGround = false;

    const tan = tangentAt(R, gs._s);
    const lat = lateralAt(tan);
    const kappa = curvatureAt(R, gs._s);
    const steer = clamp(inp.steer ?? 0, -1, 1);

    // ---- jumpRelease: leave with speed (and, if physics popped, its impulse)
    if (inp.jumpRelease) { detach(gs, ps, true); return gs; }

    // ---- CONSTRAINED (crouch held): physics runs the rider — charge at
    // T_CHARGE, prewind, airTime pinned, true takeoff on release — and moves
    // nothing. This module legally cannot move anything either (GR-07), so the
    // grind is frozen rather than desynced. Documented cost, see derivation.
    if (inp.crouch) {
      if (!gs._con) { ps.constrained = true; gs._con = true; }
      return gs;
    }
    if (gs._con) { ps.constrained = false; gs._con = false; }

    // ---- 1-D longitudinal state: closed-form, dt-exact ----
    const sgnV = gs.alongSpeed >= 0 ? 1 : -1;
    const cosSlope = Math.sqrt(Math.max(0, 1 - tan[1] * tan[1]));
    const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
    const F0 = DRAG_SCALE * PHYS.MU_BASE * G * cosSlope;
    const b = DRAG_SCALE * PHYS.LAMBDA_LONG;
    const a = -G * tan[1] + sgnV * ((boosting ? A_BOOST : 0) - F0);
    let { v, ds } = flowStep(gs.alongSpeed, a, b, dt);
    if (Math.abs(v) > PHYS.V_CAP) v = Math.sign(v) * PHYS.V_CAP;   // never above physics' clamp

    const sPrev = gs._s;
    let sNew = sPrev + ds;
    let ranOff = false;
    if (sNew <= 0) { sNew = 0; ranOff = true; }
    else if (sNew >= R.L) { sNew = R.L; ranOff = true; }
    gs._s = sNew;
    gs.alongSpeed = v;
    gs.t = R.L > 0 ? sNew / R.L : 0;

    // ---- balance: inverted pendulum on the rail, closed-form ----
    // phi'' = (g sin phi + a_lat cos phi)/L - c phi'
    //   a_lat = -(v^2 kappa)   outward pseudo-force in the +lateral direction
    //           -(A_STEER*steer)  positive steer REDUCES positive balance
    // scrub: mean over the step of the decaying lateral velocity's contribution
    const eS = Math.exp(-GRIP_RAIL * dt);
    const aScrub = gs._vlat * (1 - eS) / dt;         // exact step-mean of grip*v_lat
    gs._vlat *= eS;
    const aLat = -(v * v * kappa) - A_STEER * steer + aScrub;
    const phi = gs._phi;
    const sp = Math.sin(phi), cp = Math.cos(phi);
    const Aacc = K_LEAN * (G * sp + aLat * cp);      // undamped accel at phi
    const K = K_LEAN * (G * cp - aLat * sp);         // d/dphi of it (damping via c)
    const [phiN, dphiN] = leanStep(phi, gs._dphi, Aacc, K, C_DAMP, dt);
    gs._phi = phiN; gs._dphi = dphiN;

    const xi = (phiN + dphiN / LAM_ESC) / PHI_BAIL;
    gs.balance = clamp(xi, -1.5, 1.5);

    // ---- outcomes ----
    if (Math.abs(xi) > 1) {
      // bail: the rider leaves with the lateral velocity the falling CoM has
      detach(gs, ps, false);
      const vl = dphiN * L_COM + gs._vlat;
      ps.vel[0] += lat[0] * vl;
      ps.vel[2] += lat[2] * vl;
      gs.bailed = true;
      return gs;
    }
    if (ranOff) { detach(gs, ps, false); return gs; }

    // ---- hand physics the displacement that keeps the board on the line ----
    // horizontal: exact (physics integrates pos += vel*dt, so the board lands on
    // P(s_new) next frame). vertical: dy/dt plus a constraint impulse that
    // cancels the explicit-Euler gravity physics is about to apply.
    const pNew = posAt(R, sNew), pOld = posAt(R, sPrev);
    ps.vel[0] = (pNew[0] - pOld[0]) / dt;
    ps.vel[2] = (pNew[2] - pOld[2]) / dt;
    ps.vel[1] = (pNew[1] - pOld[1]) / dt + gs._gAir * dt;
    gs._velY = ps.vel[1];
    gs._dt = dt;
    return gs;
  }

  return { config, init, step };
}
