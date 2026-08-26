// Candidate B — rail grinding (arclength state + inverted-pendulum balance)
//
// MODEL
//   Lock converts the rider to a 1-D state (s, ds/dt) on the rail's arclength.
//   ds/dt obeys the SAME two-term law physics uses on snow, scaled by dragScale
//   and driven by gravity along the tangent, integrated in closed form (dt-exact).
//   The polyline is read only to place the rider (velocity, never position) and
//   to read signed curvature.
//   Balance is an inverted pendulum on a LINE contact: the rider's lean tracks
//   the lean the turn demands (atan(v^2*kappa/g)); the error diverges at
//   sqrt(g_eff/L) and is normalised by the lean error the rider can still
//   recover from. Second order (lean + lean rate) so a correction overshoots and
//   the player can feel it; closed-form 2x2 solution, also dt-exact.
//
// WHAT THIS MODULE WRITES TO PHYSICS
//   velocity, every locked frame;  position ONCE, on the lock frame (the snap);
//   `constrained`, while the rider is crouch-charging on the rail.
//   Never heading. Never charge / airTime / _popDone / spinDeg. Never trick state.
//
// THE ONE DISCLOSED DEFECT — CROUCH FREEZES THE RIDER (measured, not suspected)
//   CONTRACTS "CONSTRAINED STATE" says the owning module supplies all motion
//   while constrained, but the module may not write position (GR-07) and
//   physics' constrainedStep integrates nothing, so there is no legal way to
//   move a constrained rider. Measured against src/physics/physics.mjs:
//   constrained + 20 m/s for 1.0 s => displacement 0.000000 m.
//   Therefore this module holds `constrained` ONLY while `input.crouch` is held
//   (the frames that actually buy charge), and freezes s and alongSpeed with it,
//   which is self-consistent: a held rider is not moving. Cost: crouching on a
//   rail stops the rider dead for the length of the crouch, up to T_CHARGE
//   (0.85 s ~ 15 m of rail at 18 m/s).
//   Setting `constrained` for the WHOLE grind instead is not an option: physics
//   then never advances the rider and never accrues spinDeg, and its release is
//   a true takeoff that zeroes spinDeg — GR-10 measures 0.00 (rail spins gone).
//   FIX belongs to physics, one line in constrainedStep:
//     st.pos[i] += st.vel[i] * dt   (the owning module already supplies vel)
//   With that, this module drops the freeze by deleting one branch (`frozen`).
//   Second, smaller residual from the same root: leaving `constrained` restarts
//   physics' air clock at 0, so a jumpRelease within COYOTE_POP (0.25 s) of
//   RELEASING the crouch — without jumping — takes physics' coyote branch and
//   zeroes spinDeg at J_MIN. Not reachable by any GR probe (none crouch) and not
//   fixable here: airTime / _popDone are physics-owned and forbidden.
//
// Pure math, deterministic, no imports, no Date/random.

const G = 9.81;

// Mirrored from src/physics/physics.mjs DEFAULTS (this module must agree with the
// law it hands the rider back to). Overridable via opts.physics for a retune.
const PHYS = {
  MU_BASE: 0.0305,        // snow Coulomb coefficient
  LAMBDA_LONG: 0.2235,    // 1/s snow linear drag
  V_CAP: 33,              // m/s project-wide hard speed clamp
  TAU_BOOST: 0.7,         // s boost relaxation time constant
  G_AIR: 6.5,             // m/s^2 airborne gravity (used for the relock lockout)
  CRASH_SPEED_KEEP: 0.45, // speed retained through a crash
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };
// exp with a guard: the balance mode is genuinely divergent, and a big dt must
// produce a bail, not an Infinity*0 NaN.
const eexp = x => Math.exp(x > 60 ? 60 : x < -60 ? -60 : x);

// dv/dt = a - b*v, exact over dt (physics' flowSpeed, same clamp rule).
function flowSpeed(v0, a, b, dt) {
  if (v0 <= 0 && a <= 0) return 0;
  const veq = a / b;
  const v = veq + (v0 - veq) * eexp(-b * dt);
  return a <= 0 ? Math.max(v, 0) : v;
}
// exact integral of that flow over dt (distance travelled)
function flowDist(v0, a, b, dt) {
  const veq = a / b;
  const d = veq * dt + (v0 - veq) * (1 - eexp(-b * dt)) / b;
  return d > 0 ? d : 0;
}

export function createRails(env = {}, opts = {}) {
  const P = { ...PHYS, ...(opts.physics ?? {}) };

  // ------------------------------------------------------------------ constants
  // Every number below is either cited, derived from a cited number, or labelled
  // CHOICE with what it costs. config.derivation carries the same list.

  // Rider geometry. CONTRACTS convention: rider 1.8 m / 80 kg.
  const L_COM = 0.95;          // m, CoM height above the board in a grind stance
                               // (0.53 x 1.80; standing CoM is ~0.55 H, a grind
                               // stance is slightly crouched)
  const BOARD_L = 1.55;        // m, board for a 1.8 m rider (chin-to-nose sizing
                               // heuristic, ~0.86 x height)
  const BOARD_W = 0.26;        // m, waist width of a freestyle board

  // Corrective authority: the rider shifts the CoM laterally by D_HIP; about the
  // rail line that is an angular acceleration a = g*D_HIP/L^2.
  const D_HIP = 0.25;          // m  CHOICE. Cost: it sets the recoverable lean
                               // envelope (below) and so how forgiving a grind
                               // feels. 0.15 m => 9 deg envelope (twitchy),
                               // 0.35 m => 21 deg (nearly unloseable).
  const A_CORR = G * D_HIP / (L_COM * L_COM);          // 2.716 rad/s^2

  const ZETA = 0.3;            // CHOICE, damping ratio of the rider's own lean
                               // response. Cost: overshoot on a correction.
                               // 0 = ringing, 1 = dead and unfeelable; 0.3 gives
                               // a visible ~37% overshoot.
  const C_DAMP = 2 * ZETA * Math.sqrt(G / L_COM);      // 1.928 1/s

  const STANCE_M = 0.0012;     // m  CHOICE: residual lateral CoM offset a rider
                               // holds on a 50-50 — the seed of the passive
                               // topple, since a perfect inverted pendulum that
                               // starts exactly upright never falls. It enters
                               // the bail clock LOGARITHMICALLY, so the feel is
                               // robust to it: 0.1 mm -> 3.4 s, 1.2 mm -> 2.4 s,
                               // 10 mm -> 1.5 s passive bail on a straight rail.
                               // Cost: how long a hands-off grind survives.
  const AUTO_LEAN = 0.8;       // CHOICE: fraction of a turn's required lean the
                               // rider's stance supplies without player input.
                               // Cost: at 1.0 curved rails demand nothing (and
                               // the reference's "you will fall off for not
                               // turning" is false); at 0 nothing above walking
                               // pace is rideable. Measured at 0.8, v=18: an
                               // R=40 arc saturates the stick, R=80 asks ~0.48.
  const CATCH_ABSORB = 0.5;    // CHOICE: fraction of a botched catch (lateral
                               // miss + sideways closing speed) that survives the
                               // rider's legs and becomes lean. Cost: how
                               // punishing an off-centre landing is.
  const CATCH_CAP = 0.95;      // never bail ON the lock frame — a catch this bad
                               // topples over the next few frames instead, which
                               // is the readable version of the same event.

  // Drag. Research 02 sec 2: real gliding friction is mu ~ 0.03-0.1, while the
  // arcade snow coefficient (Tux Racer, sec 3.1) is 0.35 because it folds
  // plough/deformation losses in. A steel rail deforms nothing, so a grind keeps
  // only the gliding fraction: 0.03/0.35 = 0.086 .. 0.1/0.35 = 0.286.
  const DRAG_SCALE = 0.19;     // mid-band. Satisfies "you go faster boosting on a
                               // rail than boosting on the snow" (research 1.5).

  // Capture. Research 02 sec 1.5 [EST]: ~0.5-1.0 board length (0.5-1.5 m).
  const CAPTURE_BASE = BOARD_L / 2;   // 0.775 m: the board is over the rail while
                                      // the contact point is within half a board.
  const MIN_LOCK = 2.8;        // m/s. Tux Racer MIN_FRICT_SPEED (research 3.2):
                               // below it there is no steering force at all, so
                               // there is nothing to balance a grind with.
  const CAPTURE_COS = 0.5;     // CHOICE: 60 deg approach cone. Cost: at 1.0 only
                               // a dead-parallel approach catches; at 0 a rider
                               // crossing a rail sideways gets yanked onto it.

  // Constraint bookkeeping (numerical, not design):
  //   K_STAB: physics integrates position with an explicit Euler step, so a rail
  //   held by velocity alone sags g*dt^2 per frame. Steady-state sag = g*dt/K,
  //   so K >= 6.5*(1/60)/0.005 = 21.7 for a 5 mm rail. Applied as an exact
  //   exponential so any dt is stable.
  const K_STAB = 22;           // 1/s cross-track constraint stabilisation
  const K_SYNC = 8;            // 1/s along-track re-sync of s onto the rider
  const E_RESYNC = 0.25;       // m: beyond this the along-track error is not
                               // integration drift (it is a frozen rider) — snap
                               // s to the rider instead of accumulating a lurch.
  const LOCKOUT_S = 0.6;       // s before a rail may be caught again. 2x the time
                               // to fall clear of a 0.3 m rail at G_AIR
                               // (sqrt(2*0.3/6.5) = 0.30 s).
  const BLEND_M = 0.5;         // m, tangent blend half-window across a polyline
                               // joint, so a segmented rail does not kink the
                               // velocity every vertex.

  // ------------------------------------------------------------------- geometry
  const rails = (env.rails ?? []).map((r, idx) => {
    const pts = (r.points ?? []).map(p => [+p[0], +p[1], +p[2]]);
    const tan = [], len = [], cum = [0];
    for (let i = 0; i < pts.length - 1; i++) {
      const d = [pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1], pts[i + 1][2] - pts[i][2]];
      const L = Math.hypot(d[0], d[1], d[2]) || 1e-9;
      tan.push([d[0] / L, d[1] / L, d[2] / L]); len.push(L); cum.push(cum[i] + L);
    }
    // Signed curvature at each interior joint, about world up, in the SAME sense
    // as physics' heading (+x toward +z), so a rail bending in the +steer
    // direction demands +steer.
    const kv = new Array(tan.length).fill(0);
    for (let j = 1; j < tan.length; j++) {
      const a0 = Math.atan2(tan[j - 1][2], tan[j - 1][0]);
      const a1 = Math.atan2(tan[j][2], tan[j][0]);
      kv[j] = wrapPi(a1 - a0) / (0.5 * (len[j - 1] + len[j]));
    }
    // Per-segment curvature = mean of the joints it actually has.
    const kseg = tan.map((_, i) => {
      let acc = 0, n = 0;
      if (i >= 1) { acc += kv[i]; n++; }
      if (i + 1 <= tan.length - 1) { acc += kv[i + 1]; n++; }
      return n ? acc / n : 0;
    });
    return { id: r.id ?? ('rail' + idx), width: r.width ?? 0.2, pts, tan, len, cum,
      kseg, total: cum[cum.length - 1] ?? 0 };
  }).filter(r => r.tan.length > 0);

  const meanWidth = rails.length
    ? rails.reduce((a, r) => a + r.width, 0) / rails.length : 0.2;

  const segAt = (R, s) => {
    let lo = 0, hi = R.tan.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (R.cum[m] <= s) lo = m; else hi = m - 1; }
    return lo;
  };
  const pointAt = (R, s) => {
    const i = segAt(R, s), u = clamp(s - R.cum[i], 0, R.len[i]);
    return [R.pts[i][0] + R.tan[i][0] * u, R.pts[i][1] + R.tan[i][1] * u, R.pts[i][2] + R.tan[i][2] * u];
  };
  // Tangent, blended across joints so the written velocity has no per-vertex kink.
  const tangentAt = (R, s) => {
    const i = segAt(R, s), u = clamp(s - R.cum[i], 0, R.len[i]);
    let t = R.tan[i], w = 0, o = null;
    const half = Math.min(BLEND_M, R.len[i] * 0.5);
    if (u < half && i > 0) { o = R.tan[i - 1]; w = 0.5 * (1 - u / half); }
    else if (R.len[i] - u < half && i < R.tan.length - 1) { o = R.tan[i + 1]; w = 0.5 * (1 - (R.len[i] - u) / half); }
    if (!o) return t;
    const b = [t[0] * (1 - w) + o[0] * w, t[1] * (1 - w) + o[1] * w, t[2] * (1 - w) + o[2] * w];
    const m = Math.hypot(b[0], b[1], b[2]) || 1;
    return [b[0] / m, b[1] / m, b[2] / m];
  };
  const curvAt = (R, s) => R.kseg[segAt(R, s)];

  function closestOnRail(R, p) {
    let best = null;
    for (let i = 0; i < R.tan.length; i++) {
      const A = R.pts[i], T = R.tan[i], L = R.len[i];
      let u = (p[0] - A[0]) * T[0] + (p[1] - A[1]) * T[1] + (p[2] - A[2]) * T[2];
      u = clamp(u, 0, L);
      const q = [A[0] + T[0] * u, A[1] + T[1] * u, A[2] + T[2] * u];
      const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      if (!best || d < best.d) best = { d, s: R.cum[i] + u, q };
    }
    return best;
  }

  // -------------------------------------------------------------------- balance
  // Inverted pendulum on a line contact, in the rider's effective-gravity frame.
  //   g_eff = |(g, v^2*kappa)|          effective gravity magnitude in that frame
  //   w2    = g_eff / L_COM             divergence rate^2 (grows with v^2*kappa)
  //   thMax = A_CORR / w2               the lean error full input can still cancel
  //   balance b = (thC - lean) / thMax  a lean DEFICIT: b > 0 is falling to the
  //                                     OUTSIDE of the turn, which is what
  //                                     positive steer corrects, so the contract's
  //                                     sign convention is the physical one.
  //                                     |b| > 1 is unrecoverable == a bail
  //   b'' = w2*(b - steer) - c*b' + W   (steer enters as authority, hence
  //                                      "positive steer reduces positive balance")
  //   W   = w2 * ((1-AUTO_LEAN)*thC + STANCE_M/L_COM) / thMax
  // W is the steady workload: the part of the turn's required lean the stance
  // does not supply, plus the constant stance offset. On a constant-radius arc it
  // is constant, so holding the arc costs continuous stick — the thing GR-06
  // measures — rather than only an arrival transient.
  function balanceTerms(v, kappa) {
    const aLat = v * v * kappa;
    const gEff = Math.hypot(G, aLat);
    const w2 = gEff / L_COM;
    const thMax = A_CORR / w2;
    const thC = Math.atan2(aLat, G);
    const W = w2 * ((1 - AUTO_LEAN) * thC + STANCE_M / L_COM) / thMax;
    return { w2, thMax, W };
  }
  // Closed-form step of b'' + c b' - w2 b = -(w2*steer) + W over dt.
  function balanceStep(b, bd, w2, W, steer, dt) {
    const disc = Math.sqrt(C_DAMP * C_DAMP + 4 * w2);
    const l1 = (-C_DAMP + disc) / 2;          // > 0, the unstable mode
    const l2 = (-C_DAMP - disc) / 2;          // < 0
    const beq = steer - W / w2;               // (unstable) equilibrium lean
    const u0 = b - beq, u0d = bd;
    const A = (u0d - l2 * u0) / (l1 - l2), B = u0 - A;
    const e1 = eexp(l1 * dt), e2 = eexp(l2 * dt);
    return [beq + A * e1 + B * e2, A * l1 * e1 + B * l2 * e2];
  }

  // --------------------------------------------------------------------- config
  const straight = balanceTerms(0, 0);
  const l1s = (-C_DAMP + Math.sqrt(C_DAMP * C_DAMP + 4 * straight.w2)) / 2;
  const config = {
    // contract-required
    captureRadius_m: +(CAPTURE_BASE + meanWidth / 2).toFixed(4),
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: +(Math.LN2 / l1s).toFixed(4),
    curveTolerance_rad: +straight.thMax.toFixed(4),
    minLockSpeed_mps: MIN_LOCK,
    // model constants
    comHeight_m: L_COM, boardLength_m: BOARD_L, boardWidth_m: BOARD_W,
    hipShift_m: D_HIP, corrAuthority_radps2: +A_CORR.toFixed(4),
    leanDamping_zeta: ZETA, leanDamping_1ps: +C_DAMP.toFixed(4),
    stanceOffset_m: STANCE_M, autoLeanFrac: AUTO_LEAN,
    catchAbsorb: CATCH_ABSORB, captureCos: CAPTURE_COS,
    approachConeDeg: +(Math.acos(CAPTURE_COS) * 180 / Math.PI).toFixed(1),
    relockLockout_s: LOCKOUT_S, stabRate_1ps: K_STAB, syncRate_1ps: K_SYNC,
    bailSpeedKeep: P.CRASH_SPEED_KEEP,
    railMu: +(DRAG_SCALE * P.MU_BASE).toFixed(6),
    railLambda_1ps: +(DRAG_SCALE * P.LAMBDA_LONG).toFixed(6),
    vCap_mps: P.V_CAP,
    derivation: {
      captureRadius_m: 'half a board length (1.55/2 = 0.775, board sized 0.86 x 1.8 m rider) + half the rail width. Research 02 §1.5 [EST] band 0.5-1.5 m.',
      minLockSpeed_mps: 'Tux Racer MIN_FRICT_SPEED = 2.8 m/s (research 02 §3.2): below it friction gives no steering force, so a grind cannot be balanced.',
      dragScale: 'snow drag is mostly plough/deformation; a steel rail deforms nothing, so a grind keeps only the gliding fraction: mu_glide 0.03-0.1 (research 02 §2) / mu_snow_arcade 0.35 (Tux Racer, §3.1) = 0.086-0.286. Mid-band 0.19.',
      alongRailLaw: 'a(v) = g*sin(descent) - dragScale*(MU_BASE*g*cos + LAMBDA_LONG*v), i.e. physics own two-term law scaled. Closed-form flow => dt-exact (GR-09). Gravity along the tangent is included: every harness rail is level, which hides it, and omitting it costs a descending rail the speed rails exist to give.',
      captureSpeed: 'alongSpeed = dot(FULL 3-D velocity, tangent). Horizontal-only capture taxes a descending rider 9.4% at 25 deg / 23% at 40 deg.',
      boostTarget: 'physics boost holds V_BOOST = 31 on snow, i.e. a thrust of 0.299 + 0.2235*31 = 7.23 m/s^2. Against rail drag that same thrust balances at (7.23 - 0.057)/0.0425 = 169 m/s, so the rail boost target is the project clamp V_CAP = 33, not a picked number — and never above it.',
      comHeight_m: '0.53 x 1.80 m rider (CONTRACTS convention); standing CoM ~0.55 H, grind stance slightly lower.',
      corrAuthority_radps2: 'g*D_HIP/L_COM^2 with a D_HIP = 0.25 m lateral hip/arm shift (CHOICE).',
      balanceHalfLife_s: 'NOT a decay: the balance mode is divergent by construction. Reported as ln2 / lambda1, the DOUBLING time of the lean error on a straight rail. The contract field name presumes a first-order model; a first-order balance has no overshoot and cannot be felt, so this model is second order (lean + lean rate).',
      curveTolerance_rad: 'thMax = A_CORR / w2: the lean error at which full corrective authority exactly cancels the topple. Beyond it no input recovers, which is the bail condition (|balance| > 1). 15.1 deg on a straight rail, 11.6 deg on an R=40 arc at 18 m/s.',
      curvatureLoad: 'a turn demands lean thC = atan(v^2*kappa/g); the stance supplies AUTO_LEAN of it and the rider must hold the rest, so effort scales with curvature AND speed squared, and the effective gravity v^2*kappa also raises the divergence rate (instability grows with speed).',
      relockLockout_s: '2 x the time to fall clear of a 0.3 m rail at physics G_AIR: 2*sqrt(2*0.3/6.5) = 0.60 s.',
      stabRate_1ps: 'physics integrates position with explicit Euler, so a velocity-held rail sags g*dt^2/frame; steady sag = g*dt/K, K = 22 gives 5 mm at 60 Hz. Applied as an exact exponential, so any dt is stable.',
      bailSpeedKeep: "physics CRASH_SPEED_KEEP = 0.45 — a rail bail is a crash, so it is charged the same. RESIDUAL: physics charges its own landing penalty when the rider then hits the ground, so a bail can be double-charged; the integration lane owns that.",
      constrainedFreeze: 'MEASURED: physics moves a constrained rider 0.000000 m in 1.0 s at 20 m/s, and there is no legal way for this module to move it (GR-07 forbids position writes). So constrained is held ONLY while crouch is held, and s/alongSpeed freeze with it. See the header for the one-line physics fix.',
      notCoupled_heading: 'board yaw vs rail yaw is deliberately NOT a balance term even though it is physically real: a rail spin (300 deg/s, physics SPIN_STICK) would then destroy its own grind, and the module may not write heading to keep them aligned.',
    },
  };

  // ----------------------------------------------------------------------- step
  function init() {
    return {
      // contract-required
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability for the trick/HUD/run lanes (read-only to them)
      leanRate: 0, curvature: 0, grindTime_s: 0, grindDist_m: 0,
      charging: false, constrained: false, exitReason: null,
      // private
      _s: 0, _r: -1, _cool: 0, _frozen: false,
    };
  }

  function leave(gs, ps, reason, T, keep) {
    if (T) {
      // preserve speed along the rail; vel[1] is left exactly as physics set it,
      // so a charged pop keeps its impulse and a plain roll-off keeps its fall.
      ps.vel[0] = T[0] * gs.alongSpeed * keep;
      ps.vel[2] = T[2] * gs.alongSpeed * keep;
    }
    gs.alongSpeed *= keep;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    gs.onRail = false; gs.railId = null; gs.exitReason = reason;
    gs.charging = false; gs._frozen = false; gs._r = -1;
    gs._cool = LOCKOUT_S;
    if (gs.constrained) { ps.constrained = false; gs.constrained = false; }
  }

  function step(gs, ps, inp = {}, dt) {
    if (!(dt > 0) || !rails.length) return gs;
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    // ---------------------------------------------------------------- on a rail
    if (gs.onRail) {
      const R = rails[gs._r];

      // physics owns the release: a jumpRelease from the constrained state has
      // already turned into a true takeoff before this module runs.
      const released = !!inp.jumpRelease || (gs.constrained && ps.constrained === false);
      if (released) { leave(gs, ps, 'jump', tangentAt(R, gs._s), 1); return gs; }

      // Was the rider FROZEN this physics step? (we asked for constrained last
      // frame, so physics ran constrainedStep and moved nothing)
      const frozen = gs._frozen;

      let T = tangentAt(R, gs._s);
      if (!frozen) {
        // -- along-rail 1-D state, closed form -------------------------------
        const kap = curvAt(R, gs._s);
        const cosT = Math.sqrt(Math.max(0, 1 - T[1] * T[1]));
        const Gt = -G * T[1];                       // + when the rail descends
        let sgn = gs.alongSpeed >= 0 ? 1 : -1;
        let m = Math.abs(gs.alongSpeed);
        const F0 = DRAG_SCALE * P.MU_BASE * G * cosT;
        const b = DRAG_SCALE * P.LAMBDA_LONG;
        let a = sgn * Gt - F0;
        if (m < 1e-6 && a <= 0) {                   // gravity restarts a stalled rider
          const ar = -sgn * Gt - F0;
          if (ar > 0) { sgn = -sgn; a = ar; }
        }
        let m2, adv;
        if (inp.boost && (ps.boostMeter ?? 0) > 0) {
          // boosting on a rail beats boosting on snow (research 02 §1.5): same
          // thrust, a fifth of the drag, so the target is the project clamp.
          // (physics drains the meter itself in airStep — no second economy here)
          const tgt = P.V_CAP;
          m2 = m < tgt ? tgt + (m - tgt) * eexp(-dt / P.TAU_BOOST) : flowSpeed(m, a, b, dt);
          adv = 0.5 * (m + m2) * dt;
        } else {
          m2 = flowSpeed(m, a, b, dt);
          adv = flowDist(m, a, b, dt);
        }
        m2 = Math.min(m2, P.V_CAP);
        gs.alongSpeed = sgn * m2;
        gs._s += sgn * adv;
        gs.grindTime_s += dt; gs.grindDist_m += adv;

        // -- balance, closed form -------------------------------------------
        const steer = clamp(inp.steer ?? 0, -1, 1);
        const bt = balanceTerms(m2, kap);
        const nb = balanceStep(gs.balance, gs.leanRate, bt.w2, bt.W, steer, dt);
        gs.balance = nb[0]; gs.leanRate = nb[1]; gs.curvature = kap;
        T = tangentAt(R, gs._s);
      }

      // -- exits ------------------------------------------------------------
      if (gs._s <= 0 || gs._s >= R.total) {            // ran off an end
        gs._s = clamp(gs._s, 0, R.total);
        leave(gs, ps, 'railEnd', tangentAt(R, gs._s), 1);
        return gs;
      }
      if (Math.abs(gs.balance) > 1) {                  // unrecoverable lean
        gs.bailed = true;
        leave(gs, ps, 'bail', T, P.CRASH_SPEED_KEEP);
        return gs;
      }

      // -- constraint bookkeeping for the NEXT physics step ------------------
      const wantHold = !!inp.crouch;
      if (wantHold !== gs.constrained) { ps.constrained = wantHold; gs.constrained = wantHold; }
      gs.charging = wantHold;
      gs._frozen = wantHold;

      // -- hold the rider on the rail with VELOCITY only --------------------
      const Pt = pointAt(R, gs._s);
      const e = [Pt[0] - ps.pos[0], Pt[1] - ps.pos[1], Pt[2] - ps.pos[2]];
      const eAlong = e[0] * T[0] + e[1] * T[1] + e[2] * T[2];
      // along-track error is not the rail's job: move MY state onto the rider.
      if (Math.abs(eAlong) > E_RESYNC) gs._s -= eAlong;
      else gs._s -= eAlong * (1 - eexp(-K_SYNC * dt));
      if (wantHold) {
        ps.vel[0] = T[0] * gs.alongSpeed;
        ps.vel[1] = T[1] * gs.alongSpeed;
        ps.vel[2] = T[2] * gs.alongSpeed;
      } else {
        const k = (1 - eexp(-K_STAB * dt)) / dt;      // exact, stable at any dt
        ps.vel[0] = T[0] * gs.alongSpeed + (e[0] - eAlong * T[0]) * k;
        ps.vel[1] = T[1] * gs.alongSpeed + (e[1] - eAlong * T[1]) * k;
        ps.vel[2] = T[2] * gs.alongSpeed + (e[2] - eAlong * T[2]) * k;
      }
      gs.t = R.total > 0 ? clamp(gs._s / R.total, 0, 1) : 0;
      gs.lockFrames++;
      return gs;
    }

    // ------------------------------------------------------------- AUTO lock-on
    // No button press (research 02 §1.5: "to grind, just land on a rail").
    if (gs._cool > 0) return gs;
    const v = ps.vel, sp = Math.hypot(v[0], v[1], v[2]);
    if (sp < MIN_LOCK) return gs;

    let hit = null;
    for (let i = 0; i < rails.length; i++) {
      const R = rails[i];
      const radius = CAPTURE_BASE + R.width / 2;
      const c = closestOnRail(R, ps.pos);
      if (!c || c.d > radius) continue;
      const T = tangentAt(R, c.s);
      const along = v[0] * T[0] + v[1] * T[1] + v[2] * T[2];
      if (Math.abs(along) < CAPTURE_COS * sp) continue;          // crossing, not riding
      // must be closing on the rail (or already on it)
      const toward = (c.q[0] - ps.pos[0]) * v[0] + (c.q[1] - ps.pos[1]) * v[1] + (c.q[2] - ps.pos[2]) * v[2];
      if (toward < 0 && c.d > BOARD_W) continue;
      if (!hit || c.d < hit.c.d) hit = { i, R, c, T, along };
    }
    if (!hit) return gs;

    const { R, c, T, along } = hit;

    // The catch, measured BEFORE the snap: the lateral miss and the sideways
    // closing speed the snap is about to kill do not vanish — about a line
    // contact they are an angular offset and an angular rate. The legs absorb
    // CATCH_ABSORB of both. A dead-on catch starts perfectly balanced.
    let lat = [-T[2], 0, T[0]];                       // rail tangent x world up
    const lm = Math.hypot(lat[0], lat[2]);
    lat = lm > 1e-6 ? [lat[0] / lm, 0, lat[2] / lm] : [1, 0, 0];
    const miss = [ps.pos[0] - c.q[0], ps.pos[1] - c.q[1], ps.pos[2] - c.q[2]];
    const missLat = miss[0] * lat[0] + miss[2] * lat[2];
    const vLat = v[0] * lat[0] + v[2] * lat[2];
    const bt0 = balanceTerms(Math.abs(along), curvAt(R, c.s));
    // (sign: balance is a lean DEFICIT — see balanceTerms. A rider whose CoM is
    // already out at +lat has EXCESS lean that way, i.e. negative balance.)
    const lean0 = Math.sign(missLat || 1)
      * Math.atan2(Math.max(0, Math.abs(missLat) - BOARD_W / 2), L_COM);
    const b0 = clamp(-CATCH_ABSORB * lean0 / bt0.thMax, -CATCH_CAP, CATCH_CAP);
    const bd0 = clamp(-CATCH_ABSORB * vLat / (L_COM * bt0.thMax), -20, 20);

    // THE ONE LEGAL POSITION WRITE: the documented lock-on snap, once per lock,
    // magnitude <= captureRadius by construction.
    ps.pos[0] = c.q[0]; ps.pos[1] = c.q[1]; ps.pos[2] = c.q[2];
    ps.vel[0] = T[0] * along; ps.vel[1] = T[1] * along; ps.vel[2] = T[2] * along;

    gs.onRail = true; gs.railId = R.id; gs._r = hit.i; gs._s = c.s;
    gs.alongSpeed = along; gs.balance = b0; gs.leanRate = bd0;
    gs.curvature = curvAt(R, c.s); gs.bailed = false; gs.lockFrames = 1;
    gs.grindTime_s = 0; gs.grindDist_m = 0; gs.exitReason = null;
    gs.t = R.total > 0 ? clamp(c.s / R.total, 0, 1) : 0;
    gs.charging = false; gs._frozen = false;
    if (ps.constrained) { ps.constrained = false; }
    gs.constrained = false;
    return gs;
  }

  return { config, init, step };
}
