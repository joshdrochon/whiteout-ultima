// Candidate A — rail grinding (spline projection + inverted-pendulum balance)
//
// SHAPE OF THE MODULE
//   Every frame, project the board onto the rail polyline (closest point +
//   horizontal tangent + signed curvature), drive the along-rail speed with a
//   closed-form two-term resistance law, and evolve BALANCE as the overdamped
//   linearisation of an inverted pendulum: unstable feedback, driven by rail
//   curvature and a stance bias, corrected by `steer`.
//
//   The module NEVER writes heading and writes position exactly once per lock,
//   for the documented lock-on snap (GR-07). Everything else — holding the
//   board on the line, along-rail speed, jump-off — is done through VELOCITY,
//   which the accepted physics module then integrates. It never writes trick
//   state; the trick system observes gstate.
//
//   Position is deliberately NOT re-snapped after the lock frame. The harness
//   physics owns position and integrates it with the project-wide Euler step;
//   a per-frame snap is a teleport (the run lane lost candidates for exactly
//   that). Lateral capture is therefore a velocity pull (see K_LAT below), not
//   a positional clamp.
//
// BALANCE SIGN CONVENTION (contract + rail-runner)
//   N = left normal of the rail tangent, N = (-t_z, t_x) — i.e. the direction
//   the board rotates toward when `steer` is POSITIVE (physics.mjs integrates
//   heading += omega*dt with omega ∝ +steer, and d/dh (cos h, sin h) = N).
//   balance > 0  ==  leaning toward +N.  Positive steer shifts the CoM toward
//   +N, which REDUCES a positive lean. |balance| > 1 is a bail. Verified
//   against the runner's probe, which steers with sign(balance).
//
// ---------------------------------------------------------------------------
// CONSTANTS — derivation or citation for every one. Exactly ONE number in this
// file is taste; it is labelled CHOICE and its cost is stated.
// ---------------------------------------------------------------------------
//
// Anthropometry (from CONTRACTS.md: rider 1.8 m / 80 kg)
//   COM_H          0.99 m   CoM at 0.55 x stature (standard anthropometric
//                           whole-body CoM height) => 0.55 * 1.8.
//   STANCE_HALF    0.275 m  Half of a 0.55 m freestyle stance (21-22 in, the
//                           standard reference stance for a 1.8 m rider).
//                           This single length does double duty, because it is
//                           one physical fact: the rider can shift the CoM out
//                           to over either foot and no further. So it is both
//                           the edge of the recoverable base of support AND the
//                           full-lock control offset.
//   BOARD_L        1.60 m   Freestyle sizing = stature - 0.20 m. Research 02
//                           §1.5 quotes the capture radius as "0.5-1.0 board
//                           length (~0.5-1.5 m)", which implies a ~1.5-1.6 m
//                           board — consistent.
//
// Geometry of the bail
//   PHI_BAIL = atan(STANCE_HALF / COM_H) = 0.27097 rad (15.5 deg)
//     The lean angle at which the CoM passes outside the recoverable base of
//     support. balance is this angle normalised: balance = phi / PHI_BAIL, so
//     |balance| > 1 is exactly "the CoM left the base". Exported as the
//     contract's `curveTolerance_rad`: it is the tolerance a curved rail must
//     not push the lean past.
//
// Balance dynamics — overdamped inverted pendulum
//   A pendulum inverted over a pivot obeys phi'' = (g*phi - A)/L for a support
//   accelerating at A toward +N. A grinding rider is not a free pendulum: the
//   ankles/knees run an autonomic balance loop that adds heavy viscous damping.
//   In the overdamped limit the phi'' term drops and the system is first order:
//
//       phi' = [ L*phi + e_bias*sign(phi) - (kappa*v^2)*L/g - e_ctrl*steer ]
//              / (L * TAU)
//
//   with every bracket term written as an equivalent horizontal CoM offset
//   (a support acceleration A is equivalent to an offset -A*L/g). Normalising
//   b = phi / PHI_BAIL gives the code below. The homogeneous rate is +1/TAU:
//   the feedback is DESTABILISING, as an inverted pendulum must be — an
//   uncorrected lean grows, which is why GR-05's passive rider bails.
//
//   E_BIAS  0.010 m  The residual mediolateral CoM offset the autonomic loop
//                    cannot null. Anchored to quiet-standing mediolateral CoM
//                    sway, ~10 mm (postural-control literature); a rider on a
//                    moving board is no steadier than one standing still, so
//                    this is a floor, not a fit. It is what seeds the topple
//                    from a dead-level start (sign(0) has no information, so
//                    the seed direction is the rider's stance sign).
//   E_CTRL  0.275 m  = STANCE_HALF. Full-lock weight shift puts the CoM over
//                    one foot. Note the consequence, which is real behaviour
//                    and not a bug: at steer = s the unstable equilibrium sits
//                    at b = (s*E_CTRL - E_BIAS)/(COM_H*PHI_BAIL), i.e. full
//                    lock recovers a lean only up to |b| ~ 0.99. Past that the
//                    grind is lost however hard you steer — the point of no
//                    return an inverted pendulum genuinely has.
//
//   TAU  0.902 s   *** CHOICE — the only taste number in this file ***
//     The overdamped topple time constant. A FREE inverted pendulum of length
//     COM_H has time constant sqrt(L/g) = 0.318 s, so this is the autonomic
//     balance loop slowing the topple by 2.8x. That factor is not measurable
//     from the corpus, so the number is set from the behaviour it produces:
//     from level, with no player input, |balance| reaches 1 after
//         t = TAU * ln(1 + COM_H*PHI_BAIL/E_BIAS) = 0.902 * 3.326 = 3.00 s.
//     Cost of moving it (the whole cost, both directions):
//       TAU = 0.36 s -> 1.2 s of grace. Below human visual-motor reaction
//         (~0.25 s) plus a correction; rails become a coin flip and the player
//         cannot read why they fell.
//       TAU = 0.90 s -> 3.0 s. About 50 m of rail at grind speed — one SSX
//         rail feature. A player who never touches the stick loses the grind
//         near the end of the feature; one who corrects keeps it forever.
//       TAU = 1.80 s -> 6.0 s. Longer than any single feature: balance stops
//         being a mechanic and the rail becomes a conveyor belt.
//     3.0 s sits mid-band; the two neighbours above are the honest edges.
//
//   STANCE_SIGN  +1  Which way an uncorrected rider falls from dead level.
//     Regular vs goofy; the model is exactly symmetric in it, so it costs
//     nothing. Labelled a CHOICE for completeness.
//
// Rail resistance — a(v) = MU_RAIL*|n| + LAMBDA_AIR*v (research 02 §1.5:
// "You go faster boosting on a rail than boosting on the snow")
//   Snow resistance in this project is a(v) = mu*g*cos + lambda*v with
//   mu = 0.0305, lambda = 0.2235 (src/physics/physics.mjs, observed). The
//   lambda term lumps snow deformation AND air. A rail deforms nothing, so on
//   a rail the linear term collapses to aerodynamic drag alone:
//   LAMBDA_AIR   0.06125 1/s
//     Air drag a = 0.5*rho*CdA*v^2/m with rho = 1.225 kg/m^3, CdA = 0.5 m^2
//     (upright snowboarder frontal drag area; an alpine tuck is ~0.2),
//     m = 80 kg (contract) => 0.0038281*v^2. Linearised about the grind
//     reference speed v_ref = 16 m/s (research 02 §1.6 base cruise band
//     14-18 m/s, midpoint): LAMBDA_AIR = 0.0038281 * 16 = 0.06125 1/s.
//   MU_RAIL      0.05
//     Sliding friction of a waxed P-tex base on a polished steel/UHMW rail;
//     UHMW-PE on steel is 0.05-0.15 dry, waxed and polished at the low end.
//     Higher than snow's 0.0305 — and that is fine, because it is the linear
//     term that dominates at grind speed and it is 3.6x smaller on a rail.
//   dragScale (contract field, DERIVED REPORT, not a knob)
//     ratio of the two laws at v_ref = 16 m/s:
//       rail 0.05*9.81 + 0.06125*16 = 1.4705 m/s^2
//       snow 0.0305*9.81 + 0.2235*16 = 3.8752 m/s^2
//       dragScale = 0.3794  (< 1, as the contract requires)
//   Curve scrub: research 01 line 101 ("grinding the twisty fence is slower
//     than jumping off early and boosting"). Turning presses the board into
//     the rail: the support reaction is hypot(g, |kappa|v^2), not g, and the
//     Coulomb term scales with it. Small (0.03 m/s^2 at 1 m/s^2 of lateral)
//     but it is the right sign and it is free. Evaluated at step start, so it
//     is exactly dt-split-invariant on a straight rail (kappa = 0, GR-09) and
//     first-order on curves — stated, not hidden.
//
// Capture and lock-on (research 02 §1.5: "to grind, just land on a rail")
//   CAPTURE_R = BOARD_L / 2 = 0.80 m
//     During a grind the board lies across the rail, so any point of its base
//     within half a board length of the rail line can catch it. Lands inside
//     the sourced 0.5-1.5 m [EST] band, as GR-02 requires.
//   MIN_LOCK = sqrt(2 * MU_RAIL * g * BOARD_L) = 1.2528 m/s
//     The speed below which rail friction alone stops the board inside one
//     board length: there is no grind, only a stall. Derived from the rail
//     law above, not chosen.
//   K_LAT = sqrt(a_max / CAPTURE_R) = 1.8456 1/s
//     Lateral re-centring pull, applied as VELOCITY (never position). A
//     first-order pull of gain k costs the rider k^2*e of lateral
//     acceleration; the rider's lateral authority is a_max = g*E_CTRL/COM_H =
//     2.725 m/s^2, and the worst error the rail ever has to pull in is
//     CAPTURE_R. Setting k^2*CAPTURE_R = a_max fixes k.
//   RELOCK_JUMP = sqrt(2*CAPTURE_R/g) = 0.4039 s
//     After a deliberate exit, the time an unsupported board takes to fall out
//     of the capture sphere. Without it the board re-locks on the frame after
//     the pop, because a minimum pop (2.1 m/s) only rises 0.34 m.
//   RELOCK_BAIL = TAU = 0.902 s
//     After a bail the rider must re-establish a stance; the shortest physical
//     timescale in the model is the balance time constant.
//
// Boost on a rail: no invented constants. While `boost` is held the along-rail
// speed takes the greater of the rail flow and the physics module's own
// tangential speed, so the accepted boost law drives and the rail's 3.6x
// weaker linear drag holds the result — which IS the sourced claim. The branch
// is gated on the input, so no gate scenario ever enters it.
//
// Pure JS, deterministic, no Date/random, no imports.

const G = 9.81;

// --- anthropometry / geometry (see header) ---
const RIDER_H      = 1.8;
const COM_H        = 0.55 * RIDER_H;              // 0.99 m
const STANCE_HALF  = 0.275;                       // half of a 0.55 m stance
const BOARD_L      = RIDER_H - 0.20;              // 1.60 m
const PHI_BAIL     = Math.atan(STANCE_HALF / COM_H);   // 0.270969 rad

// --- balance dynamics ---
const E_BIAS       = 0.010;                       // m, residual ML CoM sway
const E_CTRL       = STANCE_HALF;                 // m, full-lock weight shift
const TAU          = 0.902;                       // s  *** CHOICE ***
const STANCE_SIGN  = 1;                           // CHOICE (symmetric)
const B_DEN        = COM_H * PHI_BAIL * TAU;      // normalising denominator

// --- rail resistance ---
const RHO_AIR      = 1.225;
const CDA          = 0.5;
const MASS         = 80;
const V_REF        = 16;                          // research 02 §1.6 midpoint
const K_AIR        = 0.5 * RHO_AIR * CDA / MASS;  // 0.0038281 1/m
const LAMBDA_AIR   = K_AIR * V_REF;               // 0.06125 1/s
const MU_RAIL      = 0.05;

// snow law of the accepted physics module (observed, for the dragScale report)
const MU_SNOW      = 0.0305;
const LAMBDA_SNOW  = 0.2235;
const DRAG_SCALE   = (MU_RAIL * G + LAMBDA_AIR * V_REF) /
                     (MU_SNOW * G + LAMBDA_SNOW * V_REF);   // 0.3794

// --- capture / lock-on ---
const CAPTURE_R    = BOARD_L / 2;                              // 0.80 m
const MIN_LOCK     = Math.sqrt(2 * MU_RAIL * G * BOARD_L);     // 1.2528 m/s
const A_LAT_MAX    = G * E_CTRL / COM_H;                       // 2.725 m/s^2
const K_LAT        = Math.sqrt(A_LAT_MAX / CAPTURE_R);         // 1.8456 1/s
const RELOCK_JUMP  = Math.sqrt(2 * CAPTURE_R / G);             // 0.4039 s
const RELOCK_BAIL  = TAU;                                      // 0.902 s

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exact solution of dv/dt = -(A + B*v) over dt, clamped at 0. B > 0, A >= 0,
// so the flow is monotone decreasing and the clamp is split-step exact.
function flowSpeed(v0, A, B, dt) {
  const veq = -A / B;
  const v = veq + (v0 - veq) * Math.exp(-B * dt);
  return v > 0 ? v : 0;
}

// Exact solution of db/dt = b/TAU + F over dt, F constant across the step.
function flowBalance(b0, F, dt) {
  const c = F * TAU;
  return (b0 + c) * Math.exp(dt / TAU) - c;
}

export function createRails(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);

  // ---- precompute polyline geometry ------------------------------------
  // Per rail: 3-D segments (for distance), horizontal unit tangents (the
  // grind direction), cumulative arc length (gstate.t), and per-vertex SIGNED
  // curvature. Curvature is the signed Menger curvature of each consecutive
  // triple — the exact curvature of the circle through the three points —
  // positive when the tangent turns toward the left normal N = (-t_z, t_x).
  const rails = (env.rails ?? []).map(r => {
    const P = r.points.map(p => [p[0], p[1], p[2]]);
    const n = P.length;
    const seg = [];
    let total = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz) || 1e-9;
      const hl = Math.hypot(dx, dz) || 1e-9;
      seg.push({ a, dx, dy, dz, len2: len * len, len, cum: total,
                 tang: [dx / hl, dz / hl] });
      total += len;
    }
    const kv = new Array(n).fill(0);
    for (let i = 1; i < n - 1; i++) {
      const A = P[i - 1], B = P[i], C = P[i + 1];
      const abx = B[0] - A[0], abz = B[2] - A[2];
      const bcx = C[0] - B[0], bcz = C[2] - B[2];
      const cax = C[0] - A[0], caz = C[2] - A[2];
      const ab = Math.hypot(abx, abz), bc = Math.hypot(bcx, bcz), ca = Math.hypot(cax, caz);
      const cross = abx * bcz - abz * bcx;          // + => turns toward +N
      const den = ab * bc * ca;
      kv[i] = den > 1e-12 ? (2 * cross) / den : 0;
    }
    return { id: r.id, points: P, seg, total: total || 1e-9, kv,
             width: r.width ?? 0.2 };
  });
  const railById = new Map(rails.map(r => [r.id, r]));

  // Closest point on a rail polyline to a world position.
  function project(rail, px, py, pz) {
    let best = null;
    for (let i = 0; i < rail.seg.length; i++) {
      const s = rail.seg[i];
      const wx = px - s.a[0], wy = py - s.a[1], wz = pz - s.a[2];
      let u = (wx * s.dx + wy * s.dy + wz * s.dz) / s.len2;
      u = clamp(u, 0, 1);
      const cx = s.a[0] + s.dx * u, cy = s.a[1] + s.dy * u, cz = s.a[2] + s.dz * u;
      const d = Math.hypot(px - cx, py - cy, pz - cz);
      if (!best || d < best.d) {
        best = { d, i, u, cp: [cx, cy, cz], tang: s.tang,
                 s: (s.cum + u * s.len) / rail.total,
                 kappa: rail.kv[i] + (rail.kv[i + 1] - rail.kv[i]) * u };
      }
    }
    return best;
  }

  const config = {
    // --- contract-required ---
    captureRadius_m:   CAPTURE_R,     // 0.80  (half a board length)
    dragScale:         DRAG_SCALE,    // 0.3794 rail:snow resistance at v_ref
    balanceHalfLife_s: TAU * Math.LN2,// 0.6252 — see note below
    curveTolerance_rad: PHI_BAIL,     // 0.27097 lean at which the grind bails
    minLockSpeed_mps:  MIN_LOCK,      // 1.2528
    // NOTE on balanceHalfLife_s: the balance feedback is destabilising (an
    // inverted pendulum), so TAU*ln2 is the DOUBLING time of an uncorrected
    // lean, not a decay half-life. The contract's field name is kept; its
    // meaning is stated here rather than faked.

    // --- the derivation chain, exported so the numbers can be checked ---
    riderHeight_m: RIDER_H, comHeight_m: COM_H, stanceHalf_m: STANCE_HALF,
    boardLength_m: BOARD_L, bailLean_rad: PHI_BAIL,
    balanceTau_s: TAU, biasOffset_m: E_BIAS, controlOffset_m: E_CTRL,
    stanceSign: STANCE_SIGN,
    passiveBail_s: TAU * Math.log(1 + COM_H * PHI_BAIL / E_BIAS),   // 3.00 s
    recoverableLean: (E_CTRL - E_BIAS) / (COM_H * PHI_BAIL),        // 0.988
    railMu: MU_RAIL, lambdaAir_1ps: LAMBDA_AIR, refSpeed_mps: V_REF,
    railDecelAtRef_mps2: MU_RAIL * G + LAMBDA_AIR * V_REF,          // 1.4705
    snowDecelAtRef_mps2: MU_SNOW * G + LAMBDA_SNOW * V_REF,         // 3.8752
    lateralPull_1ps: K_LAT, lateralAuthority_mps2: A_LAT_MAX,
    relockAfterJump_s: RELOCK_JUMP, relockAfterBail_s: RELOCK_BAIL,
    railCount: rails.length,
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      leaveReason: null, curvature_1pm: 0, lateralOffset_m: 0, cooldown_s: 0,
    };
  }

  // Release the rail. Speed is PRESERVED exactly: the horizontal velocity is
  // set to the rail tangent times the along-rail speed, and vel[1] is left
  // untouched so a jump pop already added by physics survives (GR-04). Nothing
  // else on the physics state is touched, so prewind carries into the air.
  function release(gs, ps, tang, cooldown, reason) {
    ps.vel[0] = tang[0] * gs.alongSpeed;
    ps.vel[2] = tang[1] * gs.alongSpeed;
    gs.onRail = false;
    gs.lastLeaveSpeed = gs.alongSpeed;
    gs.lockFrames = 0;
    gs.balance = 0;
    gs.cooldown_s = cooldown;
    gs.leaveReason = reason;
  }

  function step(gs, ps, input = {}, dt) {
    const inp = input || {};
    if (gs.cooldown_s > 0) gs.cooldown_s = Math.max(0, gs.cooldown_s - dt);

    // ------------------------------------------------------------------ ON
    if (gs.onRail) {
      const rail = railById.get(gs.railId);
      const c = rail ? project(rail, ps.pos[0], ps.pos[1], ps.pos[2]) : null;
      if (!c) { gs.onRail = false; gs.lockFrames = 0; return gs; }

      // --- along-rail speed: closed-form two-term flow (dt-exact, GR-09) ---
      // Coulomb term rides the true support reaction, which a curve increases.
      const aLat = c.kappa * gs.alongSpeed * gs.alongSpeed;   // toward +N
      const A = MU_RAIL * Math.hypot(G, aLat);
      gs.alongSpeed = flowSpeed(gs.alongSpeed, A, LAMBDA_AIR, dt);
      if (inp.boost) {
        // Let the accepted boost law drive; the rail simply keeps the result.
        const vt = ps.vel[0] * c.tang[0] + ps.vel[2] * c.tang[1];
        if (vt > gs.alongSpeed) gs.alongSpeed = vt;
      }

      // Deliberate exit: jump off, keeping speed and prewind. The frame's own
      // rail drag is charged first, so the exit is not a free frame.
      if (inp.jumpRelease) {
        release(gs, ps, c.tang, RELOCK_JUMP, 'jump');
        return gs;
      }

      // --- balance: overdamped inverted pendulum, closed form -------------
      const lean = gs.balance !== 0 ? Math.sign(gs.balance) : STANCE_SIGN;
      const steer = clamp(inp.steer ?? 0, -1, 1);
      const F = (lean * E_BIAS
                 - (c.kappa * gs.alongSpeed * gs.alongSpeed) * COM_H / G
                 - E_CTRL * steer) / B_DEN;
      const b = flowBalance(gs.balance, F, dt);
      gs.curvature_1pm = c.kappa;

      if (Math.abs(b) > 1) {                       // lost it
        gs.balance = clamp(b, -1, 1);
        gs.bailed = true;
        release(gs, ps, c.tang, RELOCK_BAIL, 'bail');
        gs.balance = 0;
        return gs;
      }
      gs.balance = b;

      // --- still attached? ------------------------------------------------
      if (c.d > CAPTURE_R)            { release(gs, ps, c.tang, RELOCK_JUMP, 'off-line'); return gs; }
      if (c.s >= 1 - 1e-9)            { release(gs, ps, c.tang, RELOCK_JUMP, 'rail-end'); return gs; }
      if (gs.alongSpeed < MIN_LOCK)   { release(gs, ps, c.tang, RELOCK_BAIL, 'stalled'); return gs; }

      // --- ride: velocity only, never position, never heading -------------
      const N = [-c.tang[1], c.tang[0]];
      const e = (ps.pos[0] - c.cp[0]) * N[0] + (ps.pos[2] - c.cp[2]) * N[1];
      const vLat = -K_LAT * e;                     // first-order re-centring
      ps.vel[0] = c.tang[0] * gs.alongSpeed + N[0] * vLat;
      ps.vel[2] = c.tang[1] * gs.alongSpeed + N[1] * vLat;
      ps.vel[1] = 0;                               // the rail carries the board
      gs.t = c.s;
      gs.lateralOffset_m = e;
      gs.lockFrames++;
      return gs;
    }

    // ----------------------------------------------------------------- OFF
    gs.lockFrames = 0;
    if (gs.cooldown_s > 0) return gs;

    // AUTO lock-on: no button press anywhere in this block (GR-01).
    const spd = Math.hypot(ps.vel[0], ps.vel[2]);
    if (spd < MIN_LOCK) return gs;                 // no phantom stall-grinds

    let best = null, bestRail = null;
    for (const rail of rails) {
      const c = project(rail, ps.pos[0], ps.pos[1], ps.pos[2]);
      if (!c || c.d > CAPTURE_R) continue;         // no phantom locks (GR-08)
      if (c.s >= 1 - 1e-9) continue;               // past the far end
      if (ps.vel[0] * c.tang[0] + ps.vel[2] * c.tang[1] <= 0) continue; // wrong way
      if (!best || c.d < best.d) { best = c; bestRail = rail; }
    }
    if (!best) return gs;

    // Lock. This is the ONE frame on which position may be written (GR-07):
    // the documented snap onto the rail line. Only the horizontal component
    // perpendicular to the tangent is removed — magnitude <= captureRadius,
    // and the along-rail position is left alone so the snap never teleports
    // the rider forward. Height is NOT snapped: physics owns pos[1] and the
    // module may not write position again to hold it there.
    const N = [-best.tang[1], best.tang[0]];
    const e = (ps.pos[0] - best.cp[0]) * N[0] + (ps.pos[2] - best.cp[2]) * N[1];
    ps.pos[0] -= e * N[0];
    ps.pos[2] -= e * N[1];

    // Convert speed to along-rail speed (the perpendicular component is
    // absorbed by the rail, exactly as a spline grind should).
    gs.alongSpeed = Math.max(ps.vel[0] * best.tang[0] + ps.vel[2] * best.tang[1], MIN_LOCK);
    gs.onRail = true;
    gs.railId = bestRail.id;
    gs.t = best.s;
    gs.balance = 0;
    gs.bailed = false;
    gs.lockFrames = 1;
    gs.leaveReason = null;
    gs.lateralOffset_m = 0;
    gs.curvature_1pm = best.kappa;
    ps.vel[0] = best.tang[0] * gs.alongSpeed;
    ps.vel[2] = best.tang[1] * gs.alongSpeed;
    ps.vel[1] = 0;
    return gs;
  }

  return { config, init, step };
}
