// Candidate A — rail grinding (spline projection + inverted-pendulum balance)
//
// MODEL (three independent parts, each dt-exact in closed form):
//   1. CAPTURE — project the board onto the rail polyline (closest point +
//      tangent + discrete curvature). Auto lock-on, no button: contact OR an
//      airborne approach that is CLOSING on the rail (research 02 §1.5: "to
//      grind, just land on a rail"; capture "tested only while airborne-
//      descending or on the landing frame"). Capture converts the FULL 3-D
//      velocity along the tangent (v·T), never the horizontal part only — the
//      horizontal-only conversion taxes a rider 9.4% at 25° and 23% at 40° on
//      a descending rail, i.e. exactly where a rail is supposed to win.
//   2. ALONG-RAIL SPEED — the physics two-term law (Coulomb + linear) scaled by
//      dragScale, plus the gravity component along the tangent, integrated in
//      closed form (exponential flow + its exact arclength integral). Boost
//      relaxes to the speed the snow-boost thrust reaches against rail drag,
//      capped at physics V_CAP.
//   3. BALANCE — a SECOND-ORDER state (lean b, lean-rate w) on an unstable
//      inverted pendulum, forced by a stance bias and by rail curvature,
//      corrected by steer, integrated by the exact 2x2 solution. Second-order
//      is deliberate: a first-order balance with real correction authority has
//      no overshoot, so there is nothing for a player to feel or lose.
//      SIGN: positive steer REDUCES positive balance; |b| > 1 bails.
//
// HOW IT TALKS TO PHYSICS
//   * sets physState.constrained = true while locked, clears it on release —
//     physics then accrues crouch charge at T_CHARGE, captures prewind, holds
//     airTime at 0, and turns jumpRelease into a TRUE takeoff at FULL charge
//     (5.00 m/s measured, vs the 2.1 m/s J_MIN tap before CONSTRAINED existed).
//   * NEVER writes charge / airTime / _popDone / spinDeg / flipDeg / landing,
//     never writes heading, and writes position ONCE per lock (the snap).
//     Velocity is the only per-frame write, which is what "the owning module
//     supplies the motion" means for a module bound by GR-07.
//
// TWO THINGS THE PARENT MUST SEE (measured, not guessed — see FINDINGS at the
// bottom of this file): while constrained, physics integrates NOTHING, so a
// GR-07-compliant module cannot translate the rider in world space; and
// constrainedStep never runs the rotation block, so rail spins cannot exist in
// physics state. Both are one-line physics gaps, not rail-module choices.

const G = 9.81;
const UP_Y = 1;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

// ---------------------------------------------------------------------------
// CITED CONSTANTS
// ---------------------------------------------------------------------------
// [P] src/physics/physics.mjs DEFAULTS — the accepted physics module. Copied,
//     not imported, so this file stays relocatable; each is exact as of the
//     accepted build and is re-checkable with one grep.
const P = {
  MU: 0.0305,        // MU_BASE, snow Coulomb coefficient
  LAMBDA: 0.2235,    // LAMBDA_LONG, 1/s snow linear drag
  V_CAP: 33,         // hard speed clamp
  V_BOOST: 31,       // boost target on snow
  TAU_BOOST: 0.7,    // s, boost relaxation constant
  BOOST_DRAIN: 0.125,// meter/s while boost held
  BOOST_REGEN: 0.10, // meter/s while idle
  SPIN_STICK: 300,   // deg/s stick spin rate
  CROUCH_STEER: 0.45,// steering multiplier while crouched
};
// [R] references/research/02-turning-edge-friction.md
const R = {
  // §3.1 Tux Racer terrain table: ice 0.20 / snow 0.35. The slickest surface
  // in the corpus, and a steel rail also drops the depth/compression term
  // (ice depth 0.03 m vs snow 0.11 m) — so this ratio is an UPPER bound on
  // rail resistance, used as-is rather than invented lower.
  ICE_OVER_SNOW: 0.20 / 0.35,
  // §3.2 MAX_TURN_PERP 400 N / TUX_MASS 20 kg — the rider's lateral
  // acceleration ceiling everywhere else in this game's model.
  A_LAT_MAX: 400 / 20,          // m/s^2
  // §3.2 MIN_FRICT_SPEED: below it there is no friction and therefore no
  // steering. A rider who cannot steer cannot balance a rail.
  MIN_FRICT_SPEED: 2.8,         // m/s
  // §3.2 MAX_TURN_ANGLE — the largest direction change the rider's edge can
  // absorb. Used as the capture-alignment limit and the polyline kink limit.
  MAX_TURN_ANGLE: 45 * Math.PI / 180,
};
// [A] Anthropometry + CONTRACTS.md rider (1.8 m / 80 kg). Standing CoM sits at
//     ~0.55 of stature (1.8 * 0.55 = 0.99 m); a grind stance is flexed, so the
//     CoM rides a touch lower — 1.0 m, the round value inside that band.
const H_COM = 1.0;                       // m
// Normalisation angle only: b = lean / THETA_BAIL. It CANCELS — curvature
// forcing and steer authority both carry 1/(H_COM*THETA_BAIL), and the bias is
// solved from a time target — so no behaviour depends on its value. Verified
// by construction, not by taste.
const THETA_BAIL = 20 * Math.PI / 180;

// ---------------------------------------------------------------------------
// DECLARED CHOICES (taste, with the cost stated — none of these is sourced)
// ---------------------------------------------------------------------------
const CH = {
  // Passive bail time on a straight rail. The gate's own 0.8–6 s window is
  // itself declared, not cited (GR-05 statement says so). 2.0 s sits mid-band.
  // COST: shorter reads as punishing/twitchy — you cannot look away from the
  // rail; longer and the balance meter is decoration you never have to touch.
  T_BAIL_STRAIGHT: 2.0,          // s
  // Postural damping half-life of the lean RATE (and of the off-rail lean
  // decay). COST: shorter self-corrects the wobble for the player, killing the
  // overshoot that makes balance feel like a thing; longer rings and chatters.
  BALANCE_HALF_LIFE: 0.35,       // s
  // Capture radius. Corpus [EST] band is 0.5–1.5 m ≈ one board length; a
  // freestyle deck is ~1.5 m, half-length 0.75, plus the rail half-width 0.1
  // → 0.85, taken to 1.0 m (mid-band). COST: larger and rails snatch riders
  // who meant to pass; smaller and lock-on demands pixel-accurate landings.
  CAPTURE_RADIUS: 1.0,           // m
  // Lean at which the rider is judged ready to (re-)mount a rail after a bail.
  // COST: larger re-grinds you while still falling over; smaller strands you.
  B_READY: 0.1,                  // normalised lean
};

// ---------------------------------------------------------------------------
// DERIVED
// ---------------------------------------------------------------------------
// Inverted pendulum about the rail line: theta'' = (g/h) theta. Unstable, and
// that instability is the whole mechanic.
const W0SQ = G / H_COM;                       // 9.81 1/s^2
const C_DAMP = Math.LN2 / CH.BALANCE_HALF_LIFE;   // 1/s, lean-rate damping
// Steer authority: full stick commands the same lateral acceleration ceiling
// the rider gets everywhere else ([R] A_LAT_MAX), expressed as lean accel.
const K_STEER = R.A_LAT_MAX / (H_COM * THETA_BAIL);    // b-units/s^2
// Roots of u'' + c u' - w0^2 u = 0 (always real: c^2 + 4 w0^2 > 0).
const R_DISC = Math.sqrt(C_DAMP * C_DAMP + 4 * W0SQ);
const R_POS = (-C_DAMP + R_DISC) / 2;
const R_NEG = (-C_DAMP - R_DISC) / 2;
// Stance bias A: the residual lean torque the rider's own postural control
// leaves uncorrected (research 02 §1.5 — balance on a rail is "handled by
// stance"). Not picked: SOLVED so that b(T_BAIL_STRAIGHT) = 1 from rest under
// the passive equation w' = w0^2 b + A - c w, b(0) = w(0) = 0:
//   b(T)/A = [ (r- e^{r+T} - r+ e^{r-T}) / (r- - r+) - 1 ] / w0^2
const A_BIAS = (() => {
  const T = CH.T_BAIL_STRAIGHT;
  const shape = (R_NEG * Math.exp(R_POS * T) - R_POS * Math.exp(R_NEG * T)) / (R_NEG - R_POS);
  return W0SQ / (shape - 1);
})();
// Rail drag: the snow law scaled down. dragScale < 1 is the contract's
// requirement and [R] ICE_OVER_SNOW is the sourced magnitude.
const DRAG_SCALE = R.ICE_OVER_SNOW;           // 0.5714
// Boost on a rail: the SAME thrust that holds V_BOOST on snow, balanced
// against rail drag — "you go faster boosting on a rail than boosting on the
// snow" (research 02 §1.5, the one verbatim sentence about rails). Not a
// picked number: solved, then capped by physics V_CAP (never above it).
const BOOST_TARGET = (() => {
  const thrust = P.MU * G + P.LAMBDA * P.V_BOOST;        // 7.228 m/s^2 on snow
  const v = (thrust / DRAG_SCALE - P.MU * G) / P.LAMBDA; // 55.2 m/s unclamped
  return Math.min(P.V_CAP, v);
})();

// ---------------------------------------------------------------------------
// Closed-form integrators (dt-exact: one 100 ms step == ten 10 ms steps)
// ---------------------------------------------------------------------------
// Exact flow of dv/dt = a - b v for v >= 0, with the Coulomb stop at 0, plus
// the exact distance travelled over the step. Same law and same clamp as
// physics' flowSpeed, so a rail and the snow beside it differ only by scale.
function flowStep(v0, a, b, dt) {
  if (v0 <= 0 && a <= 0) return { v: 0, ds: 0 };
  const veq = a / b;
  if (a <= 0) {
    // decaying toward veq < 0: it crosses zero at tStop and stays there
    const ratio = -veq / (v0 - veq);
    const tStop = ratio > 0 && ratio < 1 ? -Math.log(ratio) / b : Infinity;
    const t = Math.min(dt, tStop);
    const e = Math.exp(-b * t);
    const v = t < dt ? 0 : veq + (v0 - veq) * e;
    const ds = veq * t + (v0 - veq) * (1 - e) / b;
    return { v: Math.max(v, 0), ds };
  }
  const e = Math.exp(-b * dt);
  return { v: veq + (v0 - veq) * e, ds: veq * dt + (v0 - veq) * (1 - e) / b };
}
// Exact 2x2 solution of  b' = w,  w' = w0^2 b + F - c w  for constant F.
function balanceStep(b, w, F, dt) {
  const beq = -F / W0SQ;                 // equilibrium lean under this forcing
  const u = b - beq;
  const cP = (w - R_NEG * u) / (R_POS - R_NEG);
  const cN = (R_POS * u - w) / (R_POS - R_NEG);
  const eP = Math.exp(R_POS * dt), eN = Math.exp(R_NEG * dt);
  return [cP * eP + cN * eN + beq, cP * R_POS * eP + cN * R_NEG * eN];
}

// ---------------------------------------------------------------------------
// Rail geometry: polyline -> segments, arclength, signed lateral curvature
// ---------------------------------------------------------------------------
const RAIL_WIDTH_DEFAULT = 0.2;   // m, matches the harness test rails

function prepareRail(raw, index) {
  const pts = (raw.points ?? []).map(p => [p[0], p[1], p[2]]);
  const segs = [];
  let cum = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]);
    if (L < 1e-9) continue;
    segs.push({ a, d, L, s0: cum, t: [d[0] / L, d[1] / L, d[2] / L],
      yaw: Math.atan2(d[2], d[0]) });
    cum += L;
  }
  // Discrete signed LATERAL curvature at each vertex: turn of the horizontal
  // tangent per unit arclength, kappa_i = dtheta_i / mean(L_in, L_out). Exact
  // in the limit (a 24-segment 40 m arc returns 0.02500 = 1/40). Only the yaw
  // turn destabilises the rider; a vertical bend changes normal load, not lean.
  const kv = new Array(segs.length + 1).fill(0);
  const kink = new Array(segs.length + 1).fill(0);
  for (let i = 1; i < segs.length; i++) {
    const dth = wrapPi(segs[i].yaw - segs[i - 1].yaw);
    kink[i] = Math.abs(dth);
    kv[i] = dth / (0.5 * (segs[i - 1].L + segs[i].L));
  }
  // A rail does not straighten at its ends — the polyline is a sampled curve,
  // so the end vertices inherit their neighbour's curvature.
  if (segs.length >= 2) { kv[0] = kv[1]; kv[segs.length] = kv[segs.length - 1]; }
  return { id: raw.id ?? ('rail' + index), index, width: raw.width ?? RAIL_WIDTH_DEFAULT,
    segs, kv, kink, length: cum };
}

// Closest point on the polyline to p: 3-D distance, arclength, tangent.
function project(rail, p) {
  let best = null;
  for (let i = 0; i < rail.segs.length; i++) {
    const S = rail.segs[i];
    const wx = p[0] - S.a[0], wy = p[1] - S.a[1], wz = p[2] - S.a[2];
    const u = clamp((wx * S.d[0] + wy * S.d[1] + wz * S.d[2]) / (S.L * S.L), 0, 1);
    const cx = S.a[0] + S.d[0] * u, cy = S.a[1] + S.d[1] * u, cz = S.a[2] + S.d[2] * u;
    const d = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
    if (!best || d < best.d) best = { d, s: S.s0 + u * S.L, seg: i, point: [cx, cy, cz], tang: S.t };
  }
  return best;
}
// Tangent + interpolated curvature at arclength s.
function frameAt(rail, s) {
  const sc = clamp(s, 0, rail.length);
  let i = 0;
  while (i < rail.segs.length - 1 && sc > rail.segs[i].s0 + rail.segs[i].L) i++;
  const S = rail.segs[i];
  const u = clamp((sc - S.s0) / S.L, 0, 1);
  return { seg: i, tang: S.t, kappa: rail.kv[i] + (rail.kv[i + 1] - rail.kv[i]) * u,
    point: [S.a[0] + S.d[0] * u, S.a[1] + S.d[1] * u, S.a[2] + S.d[2] * u] };
}

// ---------------------------------------------------------------------------
export function createRails(env = {}) {
  const rails = (env.rails ?? []).map(prepareRail).filter(r => r.segs.length > 0);

  const config = {
    // --- contract-required ---
    captureRadius_m: CH.CAPTURE_RADIUS,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: CH.BALANCE_HALF_LIFE,
    curveTolerance_rad: R.MAX_TURN_ANGLE,
    minLockSpeed_mps: R.MIN_FRICT_SPEED,
    // --- resolved model constants ---
    balanceOmegaSq: W0SQ,
    balanceDamping: C_DAMP,
    steerAuthority: K_STEER,
    stanceBias: A_BIAS,
    passiveBailTarget_s: CH.T_BAIL_STRAIGHT,
    boostTarget_mps: BOOST_TARGET,
    railMu: DRAG_SCALE * P.MU,
    railLambda: DRAG_SCALE * P.LAMBDA,
    remountLean: CH.B_READY,
    railSpinRate_dps: P.SPIN_STICK,
    derivation: {
      captureRadius_m: 'CHOICE 1.0 m. research 02 §1.5 [EST] 0.5-1.5 m ~ one board length; deck 1.5 m -> half-length 0.75 + rail half-width 0.1 = 0.85, taken to the mid-band 1.0. Cost: larger snatches riders who meant to pass, smaller demands pixel-accurate landings.',
      dragScale: 'DERIVED 0.5714 = Tux Racer ice 0.20 / snow 0.35 (research 02 §3.1) — the slickest surface in the corpus, and a rail also loses the depth/compression term (0.03 vs 0.11 m), so this is an upper bound on rail resistance. Satisfies "you go faster boosting on a rail than on the snow" (§1.5) and the contract dragScale < 1.',
      balanceHalfLife_s: 'CHOICE 0.35 s postural damping half-life of the lean RATE (also the off-rail lean decay). Cost: shorter self-corrects the wobble and kills the overshoot the player is supposed to feel; longer rings and chatters.',
      curveTolerance_rad: 'DERIVED 45 deg = Tux Racer MAX_TURN_ANGLE (research 02 §3.2), the largest direction change the rider can absorb. Used twice for one physical quantity: capture alignment, and the polyline kink that drops you.',
      minLockSpeed_mps: 'DERIVED 2.8 m/s = Tux Racer MIN_FRICT_SPEED (research 02 §3.2): below it there is no friction and therefore no steering, and a rider who cannot steer cannot balance a rail.',
      balanceOmegaSq: 'DERIVED g/h_com, h_com = 1.0 m (CONTRACTS rider 1.8 m x 0.55 anthropometric CoM = 0.99, flexed grind stance). Inverted pendulum about the rail line: the equilibrium is UNSTABLE, which is the mechanic.',
      balanceDamping: 'DERIVED ln2 / balanceHalfLife_s.',
      steerAuthority: 'DERIVED A_LAT_MAX / (h_com * theta_bail), A_LAT_MAX = MAX_TURN_PERP 400 N / TUX_MASS 20 kg = 20 m/s^2 (research 02 §3.2) — the rider gets the same lateral ceiling on a rail as everywhere else. ALTERNATIVE REJECTED: static board leverage m g (w/2) / (m h^2) = 1.28 m/s^2 would cap the holdable arc at R > 250 m at cruise, i.e. curved rails would be impossible rather than demanding, contradicting the sourced "you eventually will fall off for NOT TURNING". Named because it is the one place two derivations disagree.',
      stanceBias: 'DERIVED, not picked: solved so the passive lean reaches |b| = 1 at exactly passiveBailTarget_s under w\' = w0^2 b + A - c w from rest. Physically the residual lean the rider\'s own postural control leaves uncorrected (research 02 §1.5: balance "handled by stance").',
      passiveBailTarget_s: 'CHOICE 2.0 s, mid-band of the GR-05 window, which that gate\'s own statement declares to be a design choice and not a citation. Cost: shorter is punishing, longer makes balance decoration.',
      boostTarget_mps: 'DERIVED: the snow-boost thrust (MU*g + LAMBDA*V_BOOST = 7.228 m/s^2) balanced against rail drag gives 55.2 m/s, clamped to physics V_CAP 33 (never clamped above it). 33 > snow 31 is the sourced sentence, arrived at rather than assumed.',
      railSpinRate_dps: 'CITED src/physics/physics.mjs SPIN_STICK — rail spin uses the same stick rate as an air spin, so no new constant enters. See FINDINGS: this lives in gstate because physics cannot rotate a constrained rider.',
      theta_bail: 'NOT A TUNABLE: b = lean / 20 deg is a normalisation. Curvature forcing and steer authority both carry 1/(h*theta_bail) and the bias is solved from a time target, so every trajectory is invariant to it.',
    },
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability / trick-system feed (the trick system observes gstate)
      balanceRate: 0, curvature: 0, s_m: 0, railSpinDeg: 0, lastBail: null,
      leaveReason: null, boosting: false,
      _rail: -1, _coyote: false,
    };
  }

  // Release the lock. Velocity is left exactly as the last grind frame wrote
  // it (or as physics' pop left it): jumping off a rail preserves speed, and a
  // bail is not given an invented speed penalty — gstate.bailed is published so
  // the trick lane can score the wipeout it owns.
  function release(gs, ps, reason) {
    gs.onRail = false;
    gs.leaveReason = reason;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    gs._coyote = false;
    gs._rail = -1;
    gs.railId = null;
    if (ps.constrained) ps.constrained = false;
  }

  // Boost meter economy while constrained. Physics' meterTick does not run in
  // the constrained branch, so the rail keeps the SAME law going rather than
  // handing the player a free infinite boost; identical constants, so a grind
  // and the snow beside it drain at the same rate.
  function meterTick(ps, inp, dt) {
    if (typeof ps.boostMeter !== 'number') return;
    ps.boostMeter = clamp(ps.boostMeter + (inp.boost ? -P.BOOST_DRAIN : P.BOOST_REGEN) * dt, 0, 1);
  }

  function step(gs, ps, inp = {}, dt) {
    if (!(dt > 0) || !ps) return gs;
    const steer = clamp(inp.steer ?? 0, -1, 1);

    // ---- 1. locked: has physics already taken the rider off the rail? ------
    // jumpRelease is resolved inside physics (CONSTRAINED STATE): it clears
    // `constrained`, does a true takeoff and applies the charge-scaled pop
    // BEFORE this module runs. The lock must not be torn down in the same
    // frame — physics integrates nothing on the pop frame, so the board has
    // not moved off the rail yet; it is still, literally, on the rail.
    if (gs.onRail && !ps.constrained && !gs._coyote) {
      gs._coyote = true;
      gs.lockFrames++;
      return gs;                       // touch nothing: the pop owns the velocity
    }
    // ---- 2. popped: hold the lock until the board clears the rail ----------
    if (gs.onRail && gs._coyote) {
      const rail = rails[gs._rail];
      const pr = rail ? project(rail, ps.pos) : null;
      if (!pr || pr.d > rail.width * 0.5) release(gs, ps, 'jump');
      else gs.lockFrames++;
      return gs;
    }

    // ---- 3. grinding -------------------------------------------------------
    if (gs.onRail) {
      const rail = rails[gs._rail];
      if (!rail) { release(gs, ps, 'lost'); return gs; }
      const fr = frameAt(rail, gs.s_m);
      const dir = gs.alongSpeed >= 0 ? 1 : -1;
      const speed = Math.abs(gs.alongSpeed);

      meterTick(ps, inp, dt);

      // --- along-rail speed: gravity along the tangent + scaled snow law.
      //     The gravity term is NOT optional: every harness test rail is at
      //     constant height, which once hid a missing gravity-along-tangent
      //     term entirely. A rail descending at 25 deg drives 4.15 m/s^2.
      const gAlong = -G * fr.tang[1] * dir;           // + accelerates the rider
      const cosT = Math.hypot(fr.tang[0], fr.tang[2]);
      const F0 = DRAG_SCALE * P.MU * G * cosT;
      const lam = DRAG_SCALE * P.LAMBDA;
      const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
      let v, ds;
      if (boosting && speed < BOOST_TARGET) {
        // same relaxation shape physics uses for boost, dt-exact
        const e = Math.exp(-dt / P.TAU_BOOST);
        v = BOOST_TARGET + (speed - BOOST_TARGET) * e;
        ds = BOOST_TARGET * dt - (speed - BOOST_TARGET) * P.TAU_BOOST * (e - 1);
      } else {
        ({ v, ds } = flowStep(speed, gAlong - F0, lam, dt));
      }
      v = Math.min(v, P.V_CAP);
      gs.boosting = boosting;
      gs.alongSpeed = dir * v;
      gs.s_m += dir * ds;

      // --- rail spin: physics cannot rotate a constrained rider, so the
      //     grind's own rotation lives here for the trick lane to read
      //     (research 02 §1.5: "keep on pressing that to do rail spins").
      const spin = clamp(inp.spin ?? 0, -1, 1);
      if (Math.abs(spin) > 0.05) gs.railSpinDeg += P.SPIN_STICK * spin * dt;
      // "Turn sideways to balance easier" (§1.5): with the board across the
      // rail the deck straddles it and the stance bias projects to zero. The
      // instability itself remains, so sideways is easier, never free.
      const yawFactor = Math.cos(gs.railSpinDeg * Math.PI / 180);

      // --- balance: unstable pendulum + curvature load - steer correction.
      //     Curvature enters as the lateral acceleration the rail forces on
      //     the contact point, kappa*v^2, converted to lean accel by /h.
      //     Crouching to charge a jump costs steering authority — "you cannot
      //     turn while crouching" / "it does detract from your turning
      //     ability" (research 02 §1.1) — so charging on a rail is a real risk.
      const kSteer = K_STEER * (inp.crouch ? P.CROUCH_STEER : 1);
      const F = A_BIAS * yawFactor
        + fr.kappa * v * v / (H_COM * THETA_BAIL)
        - kSteer * steer;
      gs.curvature = fr.kappa;
      const [b, w] = balanceStep(gs.balance, gs.balanceRate, F, dt);
      gs.balance = b; gs.balanceRate = w;

      // --- write the motion physics is not integrating while constrained ----
      ps.vel[0] = fr.tang[0] * gs.alongSpeed;
      ps.vel[1] = fr.tang[1] * gs.alongSpeed;
      ps.vel[2] = fr.tang[2] * gs.alongSpeed;
      ps.constrained = true;
      gs.t = rail.length > 0 ? clamp(gs.s_m / rail.length, 0, 1) : 0;
      gs.lockFrames++;

      // --- leave conditions -------------------------------------------------
      if (Math.abs(b) > 1) {                       // balance lost
        gs.bailed = true; gs.lastBail = { balance: b, curvature: fr.kappa };
        release(gs, ps, 'bail');
      } else if (gs.s_m >= rail.length || gs.s_m <= 0) {   // ran out of rail
        release(gs, ps, 'end');
      } else if (rail.kink[fr.seg] > R.MAX_TURN_ANGLE) {   // unrideable kink
        gs.bailed = true; release(gs, ps, 'kink');
      } else if (v < R.MIN_FRICT_SPEED * 0.5) {            // stalled on the rail
        release(gs, ps, 'stall');
      }
      return gs;
    }

    // ---- 4. off rail: recover, then look for a capture ---------------------
    // The lean persists off the rail and relaxes toward centred (a full board
    // under both feet is stable, so no instability term out here).
    const k = Math.pow(0.5, dt / CH.BALANCE_HALF_LIFE);
    gs.balance *= k; gs.balanceRate *= k;
    if (ps.constrained) return gs;                 // something else owns the rider
    if (Math.abs(gs.balance) > CH.B_READY) return gs;   // still picking yourself up

    const v3 = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
    if (v3 < R.MIN_FRICT_SPEED) return gs;
    let pick = null;
    for (const rail of rails) {
      const pr = project(rail, ps.pos);
      if (pr.d > CH.CAPTURE_RADIUS) continue;
      // Full 3-D velocity along the tangent — never the horizontal part only.
      const along = ps.vel[0] * pr.tang[0] + ps.vel[1] * pr.tang[1] + ps.vel[2] * pr.tang[2];
      if (Math.abs(along) < R.MIN_FRICT_SPEED) continue;
      // Alignment: the rider cannot absorb a direction change bigger than the
      // edge can take, so a rail hit crossways is not a grind.
      if (Math.abs(along) / v3 < Math.cos(R.MAX_TURN_ANGLE)) continue;
      // AUTO lock-on, no button press: contact, or an airborne approach that
      // is CLOSING on the rail line (research 02 §1.5 — capture is tested
      // "while airborne-descending or on the landing frame"). Receding is
      // never a capture, which is exactly why a pop off a rail flies away
      // instead of being snatched back, and why the rider re-grinds on the
      // way down.
      let closing = !!ps.onGround;
      if (!closing && pr.d > 1e-9) {
        const rx = (ps.pos[0] - pr.point[0]) / pr.d, ry = (ps.pos[1] - pr.point[1]) / pr.d,
          rz = (ps.pos[2] - pr.point[2]) / pr.d;
        closing = (ps.vel[0] * rx + ps.vel[1] * ry + ps.vel[2] * rz) < 0;
      }
      if (!closing) continue;
      if (!pick || pr.d < pick.pr.d) pick = { rail, pr, along };
    }
    if (!pick) return gs;

    // --- LOCK-ON SNAP: the one position write this module is allowed. -------
    const { rail, pr, along } = pick;
    ps.pos[0] = pr.point[0]; ps.pos[1] = pr.point[1]; ps.pos[2] = pr.point[2];
    ps.vel[0] = pr.tang[0] * along; ps.vel[1] = pr.tang[1] * along; ps.vel[2] = pr.tang[2] * along;
    ps.constrained = true;
    gs.onRail = true; gs._rail = rail.index; gs.railId = rail.id;
    gs.s_m = pr.s; gs.t = rail.length > 0 ? clamp(pr.s / rail.length, 0, 1) : 0;
    gs.alongSpeed = along;
    gs.balanceRate = 0;          // the landing squares the rider up; the lean it
                                 // arrived with (|b| <= B_READY) is kept
    gs.bailed = false; gs.leaveReason = null; gs.railSpinDeg = 0;
    gs.lockFrames = 1; gs.curvature = frameAt(rail, pr.s).kappa;
    gs.boosting = false;
    return gs;
  }

  return { config, init, step };
}

// ---------------------------------------------------------------------------
// FINDINGS for the physics lane (measured in this sandbox, not inferred)
//
// F1 — A CONSTRAINED RIDER DOES NOT MOVE. constrainedStep runs accrueCharge and
//   pins airTime; it never integrates pos. GR-07 forbids this module from
//   writing position outside the lock snap. So the contract sentence "the
//   OWNING MODULE supplies all motion" is not satisfiable: velocity is written
//   every frame and nothing consumes it. Measured: 1 s constrained at
//   vel = [0,0,18] leaves pos unchanged at [0,0,0]. This module therefore
//   carries its own arclength s (which is also the implementation the corpus
//   describes: "convert speed to along-spline speed, advance by parameter"),
//   and gstate.t / s_m are truthful while ps.pos is frozen at the lock point.
//   FIX, one line in physics constrainedStep, and every gate here still holds
//   because physics does it inside ph.step, before the GR-07 snapshot:
//       st.pos[0] += st.vel[0]*dt; st.pos[1] += st.vel[1]*dt; st.pos[2] += st.vel[2]*dt;
//
// F2 — RAIL SPINS CANNOT EXIST IN PHYSICS STATE. constrainedStep never runs the
//   rotation block, so spinDeg/flipDeg stay 0 for the whole grind and heading
//   never turns. Measured: 1 s constrained with spin = 1 gives spinDeg 0.
//   GR-10 passes, but vacuously — its `before` is 0, so the gate is asserting
//   that nothing survived nothing. It cannot presently fail for a compliant
//   module and it is NOT evidence that rail spins work. This module publishes
//   gstate.railSpinDeg at physics' own SPIN_STICK rate so the trick lane can
//   score rail spins, but the board will not visually rotate until physics
//   rotates a constrained rider (or heading is delegated).
//
// F3 — BOOST ECONOMY STOPS WHILE CONSTRAINED. meterTick is not called in the
//   constrained branch, so boost would be free on a rail. This module runs the
//   identical law rather than leave the exploit open; it is the one physics
//   field it writes that is not velocity, and it should move back into
//   constrainedStep once F1 is addressed.
// ---------------------------------------------------------------------------
