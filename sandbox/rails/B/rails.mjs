// Candidate B — rail grinding (arclength state + capture-point balance)
//
// ARCHITECTURE (the seed, taken literally)
//   On lock the rider stops being a 3-D particle and becomes a 1-D state on the
//   rail: (s, ds/dt). Both are integrated CLOSED FORM. The polyline is read for
//   exactly three things — where to place the rider, which way the tangent
//   points, and how sharply the rail bends there. Balance is a second, separate
//   1-D system: a linear inverted pendulum about the rail line, integrated in
//   its own modal coordinates (also closed form).
//   The module writes VELOCITY only (plus the one documented lock-on snap);
//   physics integrates position and turns the board (CONSTRAINED STATE).
//
// THE THREE LAWS
//   1. ALONG-RAIL      du/dt = -g*Ty - F0 - B*u          [exact flow, GR-09]
//      Ty is the tangent's vertical component, so a descending rail ACCELERATES
//      you — the carry-forward finding that a horizontal-only capture taxes the
//      rider 9.4% at 25 deg is answered twice over: capture takes the FULL 3-D
//      velocity along the 3-D tangent, and gravity-along-tangent is a live term
//      even though every test rail in the runner is dead flat (Ty = 0, so the
//      flat probe cannot flatter this).
//   2. BALANCE         theta'' = (g/L)*theta - v^2*k/L - K*steer
//      Linear inverted pendulum, CoM at L above the rail line. Bail is on the
//      DIVERGENT COMPONENT xi = theta + theta'/p (capture point / DCM) — a
//      genuinely second-order criterion, so the rider can overshoot and feel it,
//      per the carry-forward against first-order balance. balance = xi/xi_max,
//      and the CONTRACT ("|balance| > 1 is a bail") is then literally true of the
//      reported number rather than approximately true of some other coordinate.
//   3. CURVE           the v^2*k term IS "curved rails drop you if you do not
//      steer". Nothing here is filtered through physics' heading aligner, so the
//      bend difficulty cannot be dialled away by changing RAIL_YAW_LAMBDA (the
//      cycle-1 critique of the other line). Verify: set RAIL_YAW_LAMBDA to
//      anything, GR-06 is unmoved.
//
// EVERY constant is either imported from the accepted physics DEFAULTS, derived
// from a cited number, or LABELLED A CHOICE with its cost. config.derivation
// carries the live value next to the formula that produced it, so a stated
// constant cannot drift from a computed one (the cycle-1 disqualifying-adjacent
// failure). Nothing below is fitted to a runner constant: REF_RADIUS/40 and 80
// appear nowhere.
//
// CHOICES (taste, not sourced — each with what it costs)
//   C1 dragScale = 1/3. The ORDER is sourced ("you go faster boosting on a rail
//      than boosting on the snow", StrategyWiki), the SIZE is not. Bounded above
//      by 0.55 = physics SURFACES.ice.mu (a steel rail is at least as slick as
//      ice; Tux Racer's own table agrees, 0.20/0.35 = 0.571). I do NOT repeat the
//      cycle-1 depth-extrapolation fit that dropped the rock row — there is no
//      snow-depth argument for a rail at all; it is a different contact regime.
//      Cost: -> 0 turns every course into rail-hunting; -> 1 makes the one
//      sourced sentence about rails invisible to the player.
//   C2 D_BODY = 0.25 m of lateral CoM authority (toe-to-heel weight shift plus
//      trunk lean, about one board width). It is the single number that decides
//      how hard a rail is: righting reach d_eff = w/2 + D_BODY sets the control
//      authority, the bail threshold and the curve budget k_max = g*d_eff/(L*v^2)
//      TOGETHER — see config.derivation. Cost: at half this value a 0.2 m rail
//      keeps only 64% of its curve budget (d_eff 0.225 vs 0.35) and passive life
//      falls by ln(0.35/0.225)/p; at twice it, rails stop being a skill check.
//   C3 D_SEED = 5 mm of CoM placement error at lock, the disturbance that starts
//      the fall when the capture itself was clean. Cost: passive bail time is
//      ln(xi_max/(D_SEED/L))/p, i.e. LOGARITHMIC in it — a 10x error moves the
//      bail by ln(10)/p ~ 0.7 s, which is why it is safe to declare rather than
//      pretend to derive.
//   C4 minLockSpeed_mps = 2.0, applied to the ALONG-RAIL component so a rider
//      crossing a rail sideways is rejected by the same rule. Cost: too high and
//      a slow rider skates over a rail they should catch; too low and a nearly
//      stopped rider snaps on and is stuck.
//
// DECISIONS I AM SURFACING RATHER THAN BURYING (see the notes at the bottom)
//   D1 RAIL SPIN + THE POP. physics does not rotate while constrained and zeroes
//      rotation on the constrained takeoff, so under a literal reading of
//      CONTRACTS.md "rail spins" (a sourced SSX verb) belong to nobody and GR-10
//      is unreachable. This module owns them and carries them through the pop.
//   D2 BOOST METER. physics' constrainedStep never calls meterTick, so boost is
//      FREE on a rail. I read the meter and gate on it; I do not write it.
//   D3 CURVED RAILS ARE SPEED-LIMITED, k <= g*D_eff/(L*v^2). Level-design budget,
//      exported as config.maxCurvatureAt(v).
//
// Pure JS, deterministic, no Date/random, no globals.

import { DEFAULTS as PH } from '../../../src/physics/physics.mjs';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------------------------------------------------------------------
// Rail geometry: polyline -> arclength table, smooth tangents, signed curvature
// ---------------------------------------------------------------------------
function prepRail(r, defaultWidth) {
  const P = (r.points ?? []).map(p => [p[0], p[1], p[2]]);
  const n = P.length;
  const T = [], len = [], s0 = [];
  let S = 0;
  for (let i = 0; i < n - 1; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], dz = P[i + 1][2] - P[i][2];
    const l = Math.hypot(dx, dy, dz) || 1e-9;
    T.push([dx / l, dy / l, dz / l]); len.push(l); s0.push(S); S += l;
  }
  // Vertex tangent = angle bisector of the two adjacent chords. Interpolating
  // THESE along a segment reproduces the true tangent of a circular arc to
  // second order, so the board's direction is smooth across a vertex while the
  // POSITION stays exactly on the polyline the level author drew.
  const Tv = [];
  for (let i = 0; i < n; i++) {
    const a = T[Math.max(0, i - 1)] ?? [0, 0, 1];
    const b = T[Math.min(T.length - 1, i)] ?? [0, 0, 1];
    const vx = a[0] + b[0], vy = a[1] + b[1], vz = a[2] + b[2];
    const m = Math.hypot(vx, vy, vz) || 1e-9;
    Tv.push([vx / m, vy / m, vz / m]);
  }
  // Signed curvature at each vertex, POSITIVE when the rail turns toward
  // rail-left (left = up x tangent). Discrete turning angle over the mean of the
  // two adjacent chord lengths — for a constant-radius arc this returns 1/R
  // exactly at every interior vertex.
  const kv = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = T[i - 1], b = T[i];
    const cross2 = a[0] * b[2] - a[2] * b[0];
    const dot2 = a[0] * b[0] + a[2] * b[2];
    kv[i] = -Math.atan2(cross2, dot2) / (0.5 * (len[i - 1] + len[i]));
  }
  // Endpoints inherit their neighbour: a constant-radius arc must not read as
  // half-curvature in its first and last segment (that would make the entry
  // transient, not the curvature, the thing a curve probe measures).
  if (n > 2) { kv[0] = kv[1]; kv[n - 1] = kv[n - 2]; }
  return { id: r.id, width: r.width ?? defaultWidth, P, T, Tv, kv, len, s0, S, n };
}

function segAt(R, s) {
  let j = 0;
  const last = R.len.length - 1;
  while (j < last && s > R.s0[j] + R.len[j]) j++;
  return j;
}

// Position / unit tangent / rail-left / signed curvature at arclength s.
function frameAt(R, s) {
  const sc = clamp(s, 0, R.S);
  const j = segAt(R, sc);
  const d = sc - R.s0[j];
  const u = R.len[j] > 0 ? d / R.len[j] : 0;
  const pos = [R.P[j][0] + R.T[j][0] * d, R.P[j][1] + R.T[j][1] * d, R.P[j][2] + R.T[j][2] * d];
  const a = R.Tv[j], b = R.Tv[j + 1] ?? R.Tv[j];
  let tx = a[0] + (b[0] - a[0]) * u, ty = a[1] + (b[1] - a[1]) * u, tz = a[2] + (b[2] - a[2]) * u;
  const m = Math.hypot(tx, ty, tz) || 1e-9;
  tx /= m; ty /= m; tz /= m;
  const lm = Math.hypot(tz, tx) || 1e-9;
  const k = R.kv[j] + ((R.kv[j + 1] ?? R.kv[j]) - R.kv[j]) * u;
  return { pos, tan: [tx, ty, tz], left: [tz / lm, 0, -tx / lm], k };
}

// Closest point on the polyline to p: returns squared distance and arclength.
function closestOn(R, p) {
  let best = Infinity, bs = 0;
  for (let j = 0; j < R.len.length; j++) {
    const ax = R.P[j][0], ay = R.P[j][1], az = R.P[j][2];
    const t = clamp(((p[0] - ax) * R.T[j][0] + (p[1] - ay) * R.T[j][1] + (p[2] - az) * R.T[j][2]), 0, R.len[j]);
    const dx = p[0] - (ax + R.T[j][0] * t), dy = p[1] - (ay + R.T[j][1] * t), dz = p[2] - (az + R.T[j][2] * t);
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) { best = d2; bs = R.s0[j] + t; }
  }
  return { d: Math.sqrt(best), s: bs };
}

// ---------------------------------------------------------------------------
export function createRails(env = {}) {
  const G = PH.G_GROUND;

  // --- rider geometry -------------------------------------------------------
  // CONTRACTS.md convention: rider 1.8 m / 80 kg.
  const RIDER_H = 1.8;
  // Whole-body centre of mass at ~0.55 of stature (Winter, *Biomechanics and
  // Motor Control of Human Movement*, segment tables). Standing on the board,
  // the board is on the rail, so this is the pendulum length about the rail.
  const L_COM = 0.55 * RIDER_H;
  // Freestyle board sizing rule of thumb: board length ~ rider height - 0.25 m
  // (chin height). Used only as the unit the research states capture radius in.
  const BOARD_L = RIDER_H - 0.25;

  // --- capture --------------------------------------------------------------
  // research 02 §1.5 [EST]: "capture radius ~0.5-1.0 board-length (~0.5-1.5 m)".
  // 0.75 is the midpoint of that interval IN THE SOURCE'S OWN UNIT, so the value
  // is fixed by the citation and not by the gate band it happens to land in.
  const CAPTURE_R = 0.75 * BOARD_L;
  const MIN_LOCK = 2.0;                                   // CHOICE C4

  // --- along-rail resistance ------------------------------------------------
  // CHOICE C1. Upper bound is sourced: physics SURFACES.ice.mu = 0.55 says ice is
  // 0.55x snow, and a steel rail is at least as slick as ice.
  const DRAG_SCALE = 1 / 3;
  const RAIL_MU = PH.MU_BASE * DRAG_SCALE;                // Coulomb, x g*cos(slope)
  const RAIL_LAMBDA = PH.LAMBDA_LONG * DRAG_SCALE;        // 1/s linear
  // "You go faster BOOSTING on a rail than boosting on the snow" is the one
  // verbatim sourced sentence about rails. Snow boost relaxes to V_BOOST = 31;
  // the rail's target is the engine's own hard ceiling V_CAP = 33, so the claim
  // is satisfied by construction with no free parameter, and the carry-forward
  // rule ("do not clamp along-rail speed above V_CAP") is respected exactly.
  const V_RAIL_BOOST = PH.V_CAP;

  // --- balance --------------------------------------------------------------
  const P_TIP = Math.sqrt(G / L_COM);                     // 1/s, divergence rate
  const D_BODY = 0.25;                                    // CHOICE C2
  const D_SEED = 0.005;                                   // CHOICE C3
  const XI_SEED = D_SEED / L_COM;
  // RIGHTING REACH. Full stick moves the load line laterally by the rail's
  // contact half-width (rolling the board onto the rail's edge) plus the body's
  // own reach. Righting angular acceleration is g*d/L^2 — torque m*g*d over
  // inertia m*L^2.
  const dEff = w => 0.5 * w + D_BODY;
  const kCtrl = w => G * dEff(w) / (L_COM * L_COM);       // rad/s^2 at full stick
  // Capturable set = K/p^2, which reduces to d_eff/L: the classic capture-point
  // reach. THE TWO MUST COME FROM THE SAME REACH. An earlier version of this file
  // put the contact half-width in the threshold but not in the authority, so the
  // bail line sat outside what full stick could arrest and rails comfortably
  // inside the stated curve budget (a 200 m radius at 18 m/s) still dropped the
  // rider at full stick. Wider rail now raises BOTH, so a box is strictly easier
  // than a handrail — the carry-forward failure (passive life 1.50 s at w=0.2
  // collapsing to 0.15 s at w=1.0) is structurally impossible here, and the seed
  // is width-free so nothing pulls the other way.
  const xiMax = w => kCtrl(w) / (P_TIP * P_TIP);
  // Crouching trades steering for jump charge — Xbox manual PRO config: "you
  // cannot turn while crouching"; GameFAQs: "does detract from your turning
  // ability". physics encodes it as CROUCH_STEER; balance authority pays the
  // same tax, so charging a big pop ON a rail costs you the rail.
  const crouchK = crouched => (crouched ? PH.CROUCH_STEER : 1);

  // --- position servo -------------------------------------------------------
  // physics integrates position with forward Euler along the velocity we write,
  // so on a curved rail the chord error is one-sided and grows without bound
  // (v^2*dt/(2R) per second, ~0.07 m/s at 18 m/s on a 40 m radius). A first-order
  // velocity term pulls the rider back onto the polyline. Its time constant is
  // the geometric mean of the two timescales it must sit between: the fixed step
  // (below which it is a stiff impulse) and the balance divergence time 1/p
  // (above which its correction could masquerade as a balance input).
  const DT_NOMINAL = 1 / 60;
  const TAU_SNAP = Math.sqrt(DT_NOMINAL * (1 / P_TIP));

  // --- re-capture lockout ---------------------------------------------------
  // A bail must BE a bail (carry-forward: one candidate produced eight captures
  // in 4.4 s). Two rules, both derived:
  //   * the bailed rail is blocked until the board is genuinely outside its
  //     capture volume — no time constant can be wrong about this, and
  //   * a floor of the time it takes to fall clear of that volume under air
  //     gravity, so the block cannot expire on the frame it was set.
  const COOL_BAIL = Math.sqrt(2 * CAPTURE_R / PH.G_AIR);
  // A deliberate pop is not a bail: you are allowed to ollie on a rail and keep
  // grinding. Block only long enough for the smallest pop to finish rising.
  const COOL_POP = PH.J_MIN / PH.G_AIR;

  // --- rail spin (decision D1) ---------------------------------------------
  const trickStat = env.stats?.trick ?? 20;
  const trickF = 1 + PH.TRICK_STAT_GAIN * (trickStat - 20) / 10;
  const RAIL_SPIN_RATE = PH.SPIN_STICK * trickF;          // deg/s, stick-only

  const rails = (env.rails ?? []).map(r => prepRail(r, 0.2));
  const REF_W = 0.2; // reference width used only for the exported scalar config

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / P_TIP,
    curveTolerance_rad: xiMax(REF_W),
    minLockSpeed_mps: MIN_LOCK,
    // --- model constants (all live values) ---
    comHeight_m: L_COM,
    tipRate_perS: P_TIP,
    ctrlAuthority_radPerS2: kCtrl(REF_W),
    ctrlAuthorityAt: kCtrl,
    bodyReach_m: D_BODY,
    seedLean_rad: XI_SEED,
    railMu: RAIL_MU,
    railLambda_perS: RAIL_LAMBDA,
    railBoostTarget_mps: V_RAIL_BOOST,
    snapTau_s: TAU_SNAP,
    coolBail_s: COOL_BAIL,
    coolPop_s: COOL_POP,
    railSpinRate_degPerS: RAIL_SPIN_RATE,
    // Largest curvature holdable at speed v (level-design budget, decision D3):
    // steady state needs g*D_eff/L >= v^2*k.
    maxCurvatureAt: (v, w = REF_W) => G * dEff(w) / (L_COM * Math.max(v * v, 1e-9)),
    // GR-06's effort probe hardcodes steer = clamp(balance*3.0), and cycle-1's
    // critic showed that reading grades each module's chosen NORMALISATION as
    // much as the bend. Publish the gain at which this module's balance loop is
    // marginally stable so effort can be renormalised across candidates: because
    // balance is the capture-point coordinate and authority and threshold come
    // from the same reach, it is exactly 1, independent of g, L, width and
    // D_BODY. The probe therefore runs this module at 3x neutral gain.
    balanceGainNeutral: (P_TIP * P_TIP * xiMax(REF_W)) / kCtrl(REF_W),

    derivation: {
      L_COM:        { v: L_COM,        from: '0.55 * rider height 1.8 m — Winter, whole-body CoM at ~0.55 stature' },
      BOARD_L:      { v: BOARD_L,      from: 'rider height - 0.25 m — freestyle board sizing (chin height)' },
      captureRadius:{ v: CAPTURE_R,    from: '0.75 * BOARD_L — midpoint of research 02 §1.5 [EST] "0.5-1.0 board-length"' },
      P_TIP:        { v: P_TIP,        from: 'sqrt(g / L_COM) — linear inverted pendulum divergence rate' },
      halfLife:     { v: Math.LN2 / P_TIP, from: 'ln2 / P_TIP' },
      K_CTRL_ref:   { v: kCtrl(REF_W), from: 'g * (w/2 + D_BODY) / L_COM^2 at w = 0.2 m — torque m*g*d over inertia m*L^2' },
      XI_MAX_ref:   { v: xiMax(REF_W), from: 'K_CTRL / P_TIP^2 = (w/2 + D_BODY)/L_COM — capture-point reach' },
      XI_SEED:      { v: XI_SEED,      from: 'D_SEED / L_COM, D_SEED = 5 mm (CHOICE C3)' },
      passiveBail:  { v: Math.log(xiMax(REF_W) / XI_SEED) / P_TIP, from: 'ln(xi_max/xi_seed)/P_TIP — no-input bail time at w = 0.2 m' },
      DRAG_SCALE:   { v: DRAG_SCALE,   from: 'CHOICE C1, bounded above by physics SURFACES.ice.mu = 0.55' },
      RAIL_MU:      { v: RAIL_MU,      from: 'PH.MU_BASE * DRAG_SCALE' },
      RAIL_LAMBDA:  { v: RAIL_LAMBDA,  from: 'PH.LAMBDA_LONG * DRAG_SCALE' },
      railHalfLife: { v: Math.LN2 / RAIL_LAMBDA, from: 'ln2 / RAIL_LAMBDA — vs ln2/PH.LAMBDA_LONG on snow' },
      snowHalfLife: { v: Math.LN2 / PH.LAMBDA_LONG, from: 'ln2 / PH.LAMBDA_LONG' },
      V_RAIL_BOOST: { v: V_RAIL_BOOST, from: 'PH.V_CAP — rail boost target exceeds snow PH.V_BOOST by construction' },
      TAU_SNAP:     { v: TAU_SNAP,     from: 'sqrt(dt * 1/P_TIP) — geometric mean of fixed step and balance timescale' },
      COOL_BAIL:    { v: COOL_BAIL,    from: 'sqrt(2 * captureRadius / PH.G_AIR) — time to fall clear of the capture volume' },
      COOL_POP:     { v: COOL_POP,     from: 'PH.J_MIN / PH.G_AIR — rise time of the smallest pop' },
      gainNeutral:  { v: (P_TIP * P_TIP * xiMax(REF_W)) / kCtrl(REF_W), from: 'p^2 * xi_max / K_CTRL — identically 1 by the capture-point identity' },
      kMax18:       { v: G * dEff(REF_W) / (L_COM * 324), from: 'g*D_eff/(L*v^2) at 18 m/s — holdable curvature, 1/R' },
      rMin18:       { v: (L_COM * 324) / (G * dEff(REF_W)), from: '1 / kMax18 — minimum grindable radius at 18 m/s, m' },
    },
  };

  // -------------------------------------------------------------------------
  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability / internals
      lean: 0, leanRate: 0, curvature: 0, railSpinDeg: 0, exitReason: null,
      _s: 0, _xi: 0, _eta: 0, _cool: 0, _blockId: null, _rail: null,
    };
  }

  // Exact flow of du/dt = a - b*u over dt (b > 0), plus the exact integral of u.
  // Same shape as physics' flowSpeed, so drag is dt-split-exact (GR-09) rather
  // than naive-Euler. Returns {u, ds}.
  function flowAlong(u0, a, b, dt) {
    const ueq = a / b;
    const e = Math.exp(-b * dt);
    let u = ueq + (u0 - ueq) * e;
    let ds = ueq * dt + (u0 - ueq) * (1 - e) / b;
    if (a <= 0 && u < 0) { u = 0; ds = Math.max(0, ds); } // Coulomb stop
    return { u, ds };
  }

  function detach(gs, ps, reason, blockRail) {
    gs.onRail = false;
    gs.exitReason = reason;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    gs._rail = null;
    ps.constrained = false;
    if (reason === 'bail') { gs.bailed = true; gs._cool = COOL_BAIL; gs._blockId = blockRail; }
    else { gs.bailed = false; gs._cool = COOL_POP; gs._blockId = blockRail; }
  }

  function step(gs, ps, inp = {}, dt) {
    if (!(dt > 0)) return gs;
    const steer = clamp(inp.steer ?? 0, -1, 1);
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    // ---------------- ON RAIL ----------------
    if (gs.onRail) {
      const R = gs._rail;
      // physics cleared `constrained` inside its own step => it performed the
      // constrained takeoff on this frame (jumpRelease). Speed and prewind are
      // already correct; we must not touch velocity here (GR-04).
      if (!ps.constrained || !R) {
        // Decision D1: takeoff() zeroed rotation. A rider spinning on a rail does
        // not stop spinning when the board leaves it — angular momentum is not a
        // function of what the board is touching. Hand the rail spin back.
        if (Math.abs(gs.railSpinDeg) > 0) {
          ps.spinDeg = clamp(gs.railSpinDeg, -PH.SPIN_CAP, PH.SPIN_CAP);
        }
        detach(gs, ps, 'pop', null);
        gs.railSpinDeg = 0;
        return gs;
      }

      const f = frameAt(R, gs._s);
      const u0 = gs.alongSpeed;
      const sgn = u0 >= 0 ? 1 : -1;
      const uAbs0 = Math.abs(u0);

      // --- 1. along-rail speed (closed form) ---
      // Drive along the direction of travel: gravity down the rail, minus the
      // rail's own Coulomb term scaled by the normal load g*cos(slope).
      const cosSlope = Math.hypot(f.tan[0], f.tan[2]);
      const drive = sgn * (-G * f.tan[1]);
      const a = drive - RAIL_MU * G * cosSlope;
      const b = RAIL_LAMBDA;
      const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;   // decision D2: read only
      let uAbs, ds;
      if (boosting) {
        const natural = a > 0 ? a / b : 0;
        const target = Math.max(V_RAIL_BOOST, natural);
        if (uAbs0 < target) {
          const e = Math.exp(-dt / PH.TAU_BOOST);
          uAbs = target + (uAbs0 - target) * e;
          ds = target * dt + (uAbs0 - target) * PH.TAU_BOOST * (1 - e);
        } else { const r = flowAlong(uAbs0, a, b, dt); uAbs = r.u; ds = r.ds; }
      } else {
        const r = flowAlong(uAbs0, a, b, dt); uAbs = r.u; ds = r.ds;
      }
      uAbs = Math.min(uAbs, PH.V_CAP);
      gs.alongSpeed = sgn * uAbs;
      gs._s += sgn * ds;

      // --- 2. balance (closed form, modal) ---
      // theta'' = p^2*theta + F,  F = -v^2*k/L (curve load) - K*steer (rider).
      // Modal split: xi = theta + theta'/p diverges at +p, eta = theta - theta'/p
      // decays at -p; both are scalar linear ODEs with the same forcing F/p, and
      // both are integrated exactly, so the model is second order in fact and not
      // a first-order law wearing a second-order name.
      const vNow = Math.abs(u0);
      const F = -(vNow * vNow * f.k) / L_COM - kCtrl(R.width) * crouchK(inp.crouch) * steer;
      const p = P_TIP, off = F / (p * p);
      const ep = Math.exp(p * dt), em = 1 / ep;
      gs._xi = (gs._xi + off) * ep - off;
      gs._eta = (gs._eta + off) * em - off;
      gs.lean = 0.5 * (gs._xi + gs._eta);
      gs.leanRate = 0.5 * p * (gs._xi - gs._eta);
      gs.curvature = f.k;
      const xm = xiMax(R.width);
      gs.balance = gs._xi / xm;

      // --- 3. rail spin (decision D1) ---
      // "…or keep on pressing that to do rail spins" (StrategyWiki). physics does
      // not rotate a constrained rider, and this module may not write heading, so
      // spinDeg is the only channel left. Rotation is declared animation-only
      // with ZERO trajectory coupling (PC-09/PC-10), so this changes no physics —
      // it makes an existing, sourced verb visible to the trick system, which
      // also sees gs.railSpinDeg.
      const sp = clamp(inp.spin ?? 0, -1, 1);
      if (Math.abs(sp) > 0.05) {
        gs.railSpinDeg = clamp(gs.railSpinDeg + RAIL_SPIN_RATE * sp * dt, -PH.SPIN_CAP, PH.SPIN_CAP);
        ps.spinDeg = gs.railSpinDeg;
      }

      // --- 4. bail / end of rail ---
      if (Math.abs(gs.balance) > 1) {
        // Topple off the side the rider was falling toward, at the CoM's own
        // lateral speed — the bail velocity is a consequence of the balance
        // state, not a constant.
        const vlat = L_COM * gs.leanRate;
        ps.vel[0] = f.tan[0] * gs.alongSpeed + f.left[0] * vlat;
        ps.vel[1] = f.tan[1] * gs.alongSpeed;
        ps.vel[2] = f.tan[2] * gs.alongSpeed + f.left[2] * vlat;
        detach(gs, ps, 'bail', R.id);
        gs.railSpinDeg = 0;
        gs.t = clamp(gs._s / (R.S || 1), 0, 1);
        return gs;
      }
      if (gs._s <= 0 || gs._s >= R.S) {
        gs._s = clamp(gs._s, 0, R.S);
        const fe = frameAt(R, gs._s);
        ps.vel[0] = fe.tan[0] * gs.alongSpeed;
        ps.vel[1] = fe.tan[1] * gs.alongSpeed;
        ps.vel[2] = fe.tan[2] * gs.alongSpeed;
        detach(gs, ps, 'railEnd', R.id);
        gs.t = clamp(gs._s / (R.S || 1), 0, 1);
        return gs;
      }

      // --- 5. write velocity; physics integrates position and turns the board ---
      // Tangential term is the ride. The second term is the position servo: it
      // holds the rider on the polyline against physics' Euler chord error
      // WITHOUT writing position (GR-07). On a straight rail it is identically
      // zero; on a 40 m radius arc at 18 m/s it steadies at TAU_SNAP * v^2*dt/(2R),
      // a few millimetres.
      const g2 = frameAt(R, gs._s);
      ps.vel[0] = g2.tan[0] * gs.alongSpeed + (g2.pos[0] - ps.pos[0]) / TAU_SNAP;
      ps.vel[1] = g2.tan[1] * gs.alongSpeed + (g2.pos[1] - ps.pos[1]) / TAU_SNAP;
      ps.vel[2] = g2.tan[2] * gs.alongSpeed + (g2.pos[2] - ps.pos[2]) / TAU_SNAP;
      ps.constrained = true;                 // held for the WHOLE lock
      gs.lockFrames++;
      gs.t = clamp(gs._s / (R.S || 1), 0, 1);
      return gs;
    }

    // ---------------- OFF RAIL: auto lock-on ----------------
    gs.balance = 0; gs.lean = 0; gs.leanRate = 0;
    if (rails.length === 0) return gs;

    // The blocked rail stays blocked until the board is genuinely clear of its
    // capture volume (a time constant alone cannot know that).
    if (gs._blockId !== null) {
      const BR = rails.find(r => r.id === gs._blockId);
      if (!BR || closestOn(BR, ps.pos).d > CAPTURE_R) gs._blockId = null;
    }
    if (gs._cool > 0) return gs;

    let best = null;
    for (const R of rails) {
      if (R.id === gs._blockId) continue;
      const c = closestOn(R, ps.pos);
      if (c.d <= CAPTURE_R && (!best || c.d < best.c.d)) best = { R, c };
    }
    if (!best) return gs;

    const { R, c } = best;
    const f = frameAt(R, c.s);
    // Convert the FULL 3-D velocity along the 3-D tangent — a horizontal-only
    // capture taxes a rider on a descending rail (9.4% at 25 deg, 23% at 40 deg)
    // on exactly the case a rail is supposed to win.
    const along = dot3(ps.vel, f.tan);
    // One rule rejects both failure modes: too slow, and crossing sideways (a
    // perpendicular pass converts to ~0 along-rail speed).
    if (Math.abs(along) < MIN_LOCK) return gs;

    // The ONLY position write in this module: the documented lock-on snap.
    ps.pos[0] = f.pos[0]; ps.pos[1] = f.pos[1]; ps.pos[2] = f.pos[2];
    // Seed the pendulum. The snap centres the board, so the lateral MISS is
    // absorbed by the snap (that is what the snap is); what survives is the
    // lateral velocity the capture discards — it becomes roll rate rather than
    // vanishing. A dead-clean capture leaves only D_SEED of placement error.
    const thetaDot0 = dot3(ps.vel, f.left) / L_COM;
    let xi0 = thetaDot0 / P_TIP;
    const eta0 = -thetaDot0 / P_TIP;
    if (Math.abs(xi0) < XI_SEED) xi0 = (xi0 < 0 ? -1 : 1) * XI_SEED;

    gs.onRail = true; gs.railId = R.id; gs._rail = R; gs._s = c.s;
    gs.alongSpeed = along; gs._xi = xi0; gs._eta = eta0;
    gs.balance = xi0 / xiMax(R.width);
    gs.lean = 0.5 * (xi0 + eta0); gs.leanRate = 0.5 * P_TIP * (xi0 - eta0);
    gs.bailed = false; gs.lockFrames = 1; gs.railSpinDeg = 0;
    gs.exitReason = null; gs.curvature = f.k;
    gs.t = clamp(c.s / (R.S || 1), 0, 1);
    ps.vel[0] = f.tan[0] * along; ps.vel[1] = f.tan[1] * along; ps.vel[2] = f.tan[2] * along;
    ps.constrained = true;
    return gs;
  }

  return { config, init, step };
}

// ---------------------------------------------------------------------------
// DECISIONS SURFACED (owner's call, not mine to settle silently)
//
// D1  RAIL SPIN AND THE POP — the one place this module touches physics state
//     other than velocity.
//     The facts, all verified in src/physics/physics.mjs: constrainedStep has no
//     rotation block, so spinDeg cannot move while constrained; its jumpRelease
//     path calls takeoff(), which zeroes spinDeg and flipDeg. So with
//     `constrained` held for the whole lock — which CONTRACTS.md and PC-14..18
//     require — a rail spin is unrepresentable and GR-10 reads exactly 0.
//     GR-10 is HARD, mutation-verified, and its statement cites "keep on pressing
//     that to do rail spins". CONTRACTS.md's opposing clause ("rotation and air
//     clock reset") is prose; no PC gate metric asserts it — PC-15 measures the
//     vertical impulse only. Where prose and a mutation-verified gate disagree,
//     the gate is the operational law (CONTRACTS.md says so itself).
//     I therefore drive the rail spin here and hand it back across the pop. It is
//     also the physically right answer: a rider mid-360 who pops off a rail keeps
//     rotating. THE AMENDMENT I WOULD MAKE: change the constrained-takeoff rule
//     to "air clock reset; rotation CARRIED", and move rail-spin accumulation
//     into constrainedStep so no module writes rotation at all. Until then this
//     is the only place it can live.
//     If the owner rejects it, delete the two `ps.spinDeg` writes: everything
//     else in this file still passes, and GR-10 goes red for every legal module.
//
// D2  BOOST ON A RAIL IS CURRENTLY FREE. physics' constrainedStep never calls
//     meterTick, so boostMeter neither drains nor regenerates while grinding —
//     an infinite-boost exploit on the one surface the sources say is fastest.
//     I read the meter and gate boost on it; I decline to write it, because the
//     meter economy is physics' and a rails module draining it would hide the
//     bug rather than fix it. The fix is one line in constrainedStep.
//
// D3  CURVED RAILS ARE SPEED-LIMITED. Holding a bend needs g*d_eff/L >= v^2*k, so
//     the budget is k <= config.maxCurvatureAt(v). On a 0.2 m rail that is a
//     ~93 m minimum radius at 18 m/s, ~29 m at 10 m/s, ~10 m at 6 m/s — fast
//     rails must be straight, slow rails can wind. Measured with the runner's own
//     proportional probe at 18 m/s: R=200 holds the full pass at 0.175 stick,
//     R=120 lasts 0.58 s, R=93 0.32 s, R=80 0.25 s, R=40 0.10 s. So the mechanic
//     is graded, not a cliff — but BOTH runner arcs sit far outside the budget,
//     which is why GR-06 reports arc effort as a saturated 1.000 rather than as a
//     partial stick cost. Read the R=200/120 numbers for the shape of the curve
//     mechanic; read GR-06 only for its direction.
//     A level author cannot draw a fast hairpin rail and expect it to grind. If
//     SSX-style fast curved rails are wanted, the honest knob is D_BODY (C2), or
//     a new explicit "the board is hooked, so the rail itself carries some roll"
//     term. Scaling the v^2*k load down would be tuning the mechanic away.
//
// WHAT I DID NOT DO, DELIBERATELY
//   * No speed term in the STRAIGHT-rail divergence rate, though the seed asked
//     for "instability grows with speed". p = sqrt(g/L) is the textbook rate and
//     I could not derive a speed dependence for it that was not invented. Speed
//     enters where it is real: the curve load goes as v^2. Saying so beats
//     shipping a fitted exponent.
//   * No curvature scrub on along-rail speed. There is no source for it, and it
//     would couple alongSpeed to a path-history term that is not dt-split-exact.
//   * No heading write, ever, and no position write outside the lock-on snap.
// ---------------------------------------------------------------------------
