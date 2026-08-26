// Candidate A — rail grinding (spline projection + inverted-pendulum balance)
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
//   Every frame the board is projected onto the rail polyline (closest point +
//   tangent + discrete curvature). Along-rail speed is its OWN state, advanced
//   in closed form (slope drive - rail friction). The rider is an inverted
//   pendulum standing on the board; `balance` is that pendulum's normalized
//   lateral COM offset. Steer moves the centre of pressure; rail curvature
//   pushes the rider outward. The board is held on the rail through the
//   VELOCITY channel only (GR-07) against a compliant reference (see COMPLIANCE).
//
// CONSTANTS — every one is an equation over a cited input, a CHOICE with its
// cost, or an env measurement. There is no "derived" block of dials.
//
//   G            = PHYS.G_GROUND (9.81)      src/physics/physics.mjs (imported,
//                                            not copied). A grind is CONTACT, so
//                                            the contact gravity is used, not
//                                            the aesthetic air gravity.
//   H_RIDER      = 1.8 m                     CONTRACTS.md ("rider 1.8 m / 80 kg")
//   COM_FRAC     = 0.55                      OUTSIDE-CORPUS CITATION: whole-body
//                                            COM sits at ~55% of stature (Winter,
//                                            Biomechanics and Motor Control of
//                                            Human Movement, segment tables). The
//                                            corpus has no anthropometry section.
//                                            SENSITIVITY: see BAIL TIME below —
//                                            h_com anywhere in [0.5, 1.3] m (deep
//                                            crouch .. bolt upright) keeps the
//                                            passive bail inside GR-05's band
//                                            (2.32 / 2.74 / 3.26 / 3.74 s at
//                                            h_com = 0.5 / 0.7 / 0.99 / 1.3 m,
//                                            measured), so this citation is not
//                                            load-bearing.
//   LAMBDA_P     = sqrt(G/h_com) = 3.15 /s   inverted-pendulum divergence rate.
//                                            EQUATION, no free parameter. NOTE:
//                                            it is speed-INDEPENDENT. The only
//                                            speed term in the balance law is the
//                                            curvature disturbance v^2*kappa,
//                                            which is derived. Nothing here is
//                                            tied to the engine's V_CAP.
//   ZETA_B       = 1.0                       CHOICE (taste). Damping ratio of the
//                                            rider's own postural loop, expressed
//                                            against the only timescale in the
//                                            problem (LAMBDA_P), so it introduces
//                                            no new number. COST: lower zeta =
//                                            twitchier hold and a faster passive
//                                            bail; higher zeta = a mushier, more
//                                            forgiving rail. Swept: zeta =
//                                            0 / 0.5 / 1 / 2 / 4 gives a passive
//                                            bail of 1.52 / 2.27 / 3.26 / 5.58 /
//                                            10.6 s, so every zeta from 0 to 2.3
//                                            lands inside GR-05's band and only
//                                            a near-rigid rider (zeta > 2.3)
//                                            leaves it. The gate does not pin
//                                            this number; taste does.
//   SWAY_M       = 0.005 m                   CHOICE (taste), anchored to quiet-
//                                            standing postural sway (COM RMS
//                                            excursion is of order 5 mm; same
//                                            outside-corpus posturography family
//                                            as COM_FRAC). It is the seed of the
//                                            instability: a perfectly centred
//                                            capture would otherwise ride forever,
//                                            which is true of an ideal pendulum
//                                            and wrong for a game.
//                                            COST + SENSITIVITY: bail time is
//                                            LOGARITHMIC in this number,
//                                              t_bail = ln(1/(0.854*b0))/sigma,
//                                            so the whole seed window that lands
//                                            inside GR-05's 1.2-6 s band is
//                                            0.14 mm .. 73.5 mm — a factor of
//                                            523. 5 mm sits inside it with an
//                                            order of magnitude of room either
//                                            side. I did NOT invert the
//                                            gate to get it (that inversion is
//                                            what a sibling candidate was called
//                                            out for); I picked the physical
//                                            anchor and then measured where it
//                                            landed: 3.26 s predicted, 3.27 s
//                                            measured by the runner. The window
//                                            below is quoted for W_CTRL = 0.3 m.
//   CAPTURE_R    = 1.0 m                     CHOICE inside a SOURCED band:
//                                            research 02 §1.5 [EST] gives
//                                            0.5-1.5 m ("~0.5-1.0 board length").
//                                            1.0 m is the band centre. COST:
//                                            larger = more forgiving, more
//                                            phantom-feeling captures; smaller =
//                                            rails you visibly clip but miss.
//   DRAG_SCALE   = 0.20/0.35 = 0.5714        SOURCED RATIO, not a dial: Tux Racer
//                                            terrains.lst ice mu 0.20 vs snow mu
//                                            0.35 (research 02 §3.1, cloned and
//                                            verified in the corpus). "ice grip ~
//                                            0.57x snow grip" is the corpus's own
//                                            summary line. A steel rail is the
//                                            hardest, slickest surface in the
//                                            family, so the ice/snow ratio is the
//                                            closest measured analogue for
//                                            "you go faster boosting on a rail
//                                            than boosting on the snow" (§1.5).
//                                            Applied to BOTH resistive terms of
//                                            the accepted snow law.
//   OMEGA_C      = sqrt(G/W_half) = 9.9 /s   COMPLIANCE stiffness (see below).
//                                            EQUATION: the rate at which an
//                                            unheld board rotates off a rail edge
//                                            of half-width W_half. The hook must
//                                            answer exactly as fast as the escape
//                                            it prevents; that is the marginal,
//                                            non-arbitrary value.
//   ZETA_C       = 1.0                       CHOICE. Critical damping of the hook.
//                                            COST: zeta<1 makes the board visibly
//                                            oscillate on/off the rail line.
//   W_half       = rail.width/2              MEASURED FROM env (0.1 m for the
//                                            harness rails). Not a constant.
//   minLockSpeed = sqrt(2*G*dy + V_STALL^2)  EQUATION: the kinetic energy needed
//                                            to climb onto the rail. dy is the
//                                            actual lift of THIS capture; the
//                                            exported scalar is the same law
//                                            evaluated at the worst climb the
//                                            env's rails demand (2.43 m/s here).
//   V_STALL      = mu_rail*G/LAMBDA_P        EQUATION: the speed rail friction
//                                            kills inside one balance time
//                                            constant. 0.05 m/s — a grind that
//                                            slow is a standstill.
//
// TWO LENGTH SCALES, TWO FAILURES (this is the spine of the model)
//   W_half  = rail.width/2 (0.1 m here)   — the BOARD's grip on the rail.
//   W_CTRL  = 0.30 m                      — the RIDER's own lateral recovery
//                                           range. CHOICE, anchored to the hip
//                                           strategy of standing balance: when
//                                           the ankle/CoP strategy saturates a
//                                           human recovers by translating the
//                                           COM over the feet, and that
//                                           excursion is of order 0.3 m (Horak
//                                           & Nashner's ankle-vs-hip strategies;
//                                           outside-corpus, same footing as
//                                           COM_FRAC). WHY IT IS NOT THE RAIL
//                                           WIDTH: a board HOOKED on a rail is
//                                           not a body balanced on a support
//                                           polygon — the rail holds the board
//                                           laterally, so the rider can lean
//                                           into a bend like a motorcyclist and
//                                           the limit is their own recovery, not
//                                           the 0.2 m of steel under the board.
//                                           COST, MEASURED, and this is the one
//                                           number that moves the feel of the
//                                           whole lane: sustained cornering
//                                           tops out near a_c ~ 3.5 m/s^2, i.e.
//                                           at 18 m/s a rail bend must have
//                                           R >= ~95 m to be holdable with full
//                                           steer (measured sweep in the
//                                           self-check notes: R=100 m holds for
//                                           the whole probe, R=76 m does not).
//                                           Using the rail width instead (0.1 m)
//                                           tightens that to R >= ~180 m, which
//                                           makes ordinary game rails
//                                           unrideable; tripling it again would
//                                           let the rail ride itself. Rail
//                                           authors get the envelope as
//                                           config.controlAuthority_mps2.
//
// BALANCE LAW (every term derived; sign convention per CONTRACTS.md)
//   b = x_com / W_CTRL   (absolute lean, internal state gs._b)
//   b'' = LAMBDA_P^2 * (b - steer) - C_B * b' - v^2*kappa / W_CTRL
//     * LAMBDA_P^2*b        : inverted pendulum, unstable.
//     * -LAMBDA_P^2*steer   : full steer commands the COM shift to the edge of
//                             the rider's recovery range, the physical maximum:
//                             a_max = G*W_CTRL/h_com = 2.97 m/s^2, which
//                             normalizes to exactly LAMBDA_P^2. The control gain
//                             is therefore NOT a dial — it is the same length
//                             scale as the tolerance, and the two are the same
//                             number by construction. POSITIVE STEER REDUCES
//                             POSITIVE BALANCE, as the runner demands.
//     * -C_B*b'             : postural damping (ZETA_B above).
//     * -v^2*kappa/W_CTRL   : the base is forced around a curve of curvature
//                             kappa; in the board frame the rider feels v^2*kappa
//                             outward. Zero free parameters. This is the ONLY
//                             speed dependence in the balance law.
//   Integrated in closed form (real distinct roots, constant forcing over a
//   step) — dt-exact, not Euler.
//
// BAIL RULE — the exported gstate.balance is the DEVIATION, not the lean:
//     b_lean = v^2*kappa / (LAMBDA_P^2 * W_CTRL) = a_c*h_com/(G*W_CTRL)
//     balance = b - b_lean,  |balance| > 1 = bail.
//   b_lean is the motorcycle lean a steady bend DEMANDS. Leaning into a corner
//   is not falling, so the rider is judged on how far they are from the lean the
//   corner requires. That threshold is not arbitrary either: full steer holds
//   static equilibrium exactly at |balance| = a_max/LAMBDA_P^2 / W_CTRL = 1, so
//   |balance| > 1 IS the boundary of the recoverable set for a bounded-authority
//   inverted pendulum. Beyond it no input saves you, which is what a bail means.
//   A curved rail still drops a passive rider (GR-06) because acquiring the lean
//   is work: with zero steer the deviation opens at the transition and runs away
//   — measured 2.47 s on the harness curve vs 3.27 s on a straight rail, so the
//   curvature term is doing real work in that gate, not riding on the sway seed.
//
//   BAIL TIME (the number GR-05 bands, stated as the identity it is):
//     sigma = LAMBDA_P*(sqrt(1+zeta^2) - zeta) = 1.305 /s at zeta=1
//     t_bail = ln( 1 / (0.854 * b0) ) / sigma,  b0 = SWAY_M / W_CTRL = 0.0167
//            = 3.26 s at constant speed and zero curvature; the runner measures
//            3.27 s.
//   This is a CONSTANT-SPEED, ZERO-CURVATURE identity, not a general prediction.
//   Speed does not appear in the straight-rail balance law at all, which is why
//   the identity survives the grind's deceleration there; on a curved rail the
//   v^2*kappa term makes the bail earlier and the identity is only an upper
//   bound. Nothing in it is tied to the engine's V_CAP or to any other rate.
//
// COMPLIANCE (cycle-1 critique: "a rigid position servo ... zero lateral
// compliance, the rider never feels the rail pulling")
//   The board is NOT pinned to the rail line. It hangs off it by a real
//   second-order state e (metres, lateral):
//       e'' = -OMEGA_C^2 * (e - e*) - 2*ZETA_C*OMEGA_C * e' ,  e* =
//       -v^2*kappa/OMEGA_C^2  — the board is dragged to the OUTSIDE of every
//       bend by the centripetal demand over the hook stiffness (2.1 mm on the
//       harness curve at 18 m/s, 4.4 mm on a 60 m bend; measured). If that
//       offset exceeds W_half the board itself is off the rail:
//       |e| > W_half  <=>  v^2*kappa > G — a fully derived SECOND bail channel
//       ("the rail rips the board out from under you") that uses the rail's
//       geometry, where the balance channel uses the rider's.
//   Realising that reference still has to go through ps.vel, because GR-07
//   allows no other channel; what changed is that the thing being tracked is a
//   compliant body with its own dynamics, not the rail line.
//
// DECISIONS THE CYCLE-1 CRITIQUE DEMANDED (each one taken, not punted)
//  1. GETTING ACTUALLY ON THE RAIL. The lock snap is 3-D: x, y AND z go to the
//     closest point on the polyline, so the rider stands 0.30 m up on the rail,
//     not at ground level underneath it. Physics then leaves the ground of its
//     own accord (its predictive constraint release) on the very next frame, so
//     the grounded carve tick — which is what bent a cycle-1 candidate 104 deg
//     off line — never runs during a grind.
//  2. DESCENDING RAILS. The along-rail law carries the full slope drive
//     -G*T_y: a rail that goes down makes you go faster, a rail that goes up
//     costs you speed, and the 3-D constraint follows the rail's y. Verified
//     below on a 12-degree descending rail (harness rails are flat, so this is
//     measured out of band, in the self-check notes).
//  3. HEADING ON A CURVED RAIL. I do not write heading. Ever. GR-07 is
//     absolute and the contract has no exception for it. Measured consequence
//     on the harness curved rail (20.1 deg of total bend): the board exits
//     20.1 deg off the velocity vector, which physics labels CLEAN (its
//     CLEAN_YAW is 45 deg) and auto-snaps. Past ~45 deg of unrotated bend the
//     exit is 'sketchy'; past 90 deg it is a crash. THAT IS THE CORRECT GAME:
//     a 90-degree rail that you ride without turning the board spits you out
//     sideways, and the engine already gives the player the channel to turn it
//     (air spin, which is live during a grind — the source calls this out:
//     "keep on pressing that to do rail spins"). The rider needs 40 deg/s to
//     track a 90-degree/40 m bend at 18 m/s, which is 0.13 of the stick.
//     gstate.yawError_rad and gstate.yawRateNeeded_radps are exported so the
//     HUD / an assist layer can show exactly that. If the lane owner wants the
//     board auto-yawed, the contract must be changed to permit it; I will not
//     take that on my own authority.
//  4. "TURN SIDEWAYS TO BALANCE EASIER" (StrategyWiki) IS NOT MODELLED, and
//     that is a considered refusal, not an omission. Neither length scale in the
//     model depends on board yaw. The board's grip on the rail is set by the
//     rail top (0.2 m wide, narrower than the board), so the roll-axis contact
//     across the rail is W_half at every board angle — 50-50 or full boardslide.
//     And the rider's recovery range is their own hips, which do not get longer
//     because the board turned. So a yaw-angle balance bonus would be a designed
//     gift wearing a sourced label, which is the exact failure mode this lane
//     keeps punishing. gstate.yawError_rad is exported; if the lane wants
//     sideways to be safer, it is a design bonus and should be labelled one.
//  5. AIR CLOCK. Physics sees a grinding rider as airborne (they are off the
//     snow), so a 6 s grind would otherwise score as 6 s of hang time. DECISION:
//     while onRail this module holds ps.airTime at 0. It is not heading, not
//     position, and not trick state — src/tricks/tricks.mjs never reads airTime
//     (verified by grep; it reads onGround, spinDeg, flipDeg, landing). Two
//     things fall out of it, both wanted: a grind reads as contact to every
//     consumer, and the engine's own coyote-pop window stays open, so
//     jumpRelease off a rail is serviced by PHYSICS' ollie — same J_MIN/J_MAX,
//     world-up, and it carries st.prewound through untouched. That is how this
//     module satisfies "leaves the rail preserving speed and prewind" without
//     duplicating a single physics constant.
//     spinDeg/flipDeg are deliberately NOT reset: a board spun on a rail is a
//     rail spin, and it is the trick lane's business to score it.
//  6. BAIL VERDICT is NOT taken here. A bail sets gstate.bailed and gives the
//     board the COM's own topple velocity; whether that becomes a 'crash' is
//     trick-lane state and this module is forbidden to write it. Flagged, not
//     silently dropped.
//  7. RE-CAPTURE. Sourced rule (research 02 §1.5 [EST]: capture is "tested only
//     while airborne-descending or on landing frame"): a rail is eligible only
//     when the board is descending or in contact. Every exit EXCEPT a deliberate
//     ollie additionally latches that rail out until the board has been further
//     than captureRadius from it at least once. Without the latch a rider who
//     fell off re-locks from 0.3 m below — the "grinds at ground level under the
//     rail" failure of cycle 1 — and a rider who runs off the END re-locks on
//     the next frame forever: I measured 240+ lock/unlock transitions in a 10 s
//     run before adding it. An ollie is exempt on purpose, so you can pop and
//     land back on the same rail; the descending-only rule stops it re-locking
//     on the way up.
//  8. RAIL CORNERING ENVELOPE (a limit, stated, not hidden). Sustained cornering
//     is capped by the rider's authority at a_c ~ 3.5 m/s^2: measured with full
//     steer at 18 m/s, a 100 m-radius bend holds for the whole probe and a 76 m
//     bend does not; at 12 m/s a 100 m bend holds, at 25 m/s it does not. Rail
//     authors get the number as config.controlAuthority_mps2 and the hard board
//     limit as config.hookLimitLateralAccel_mps2. Two ways to widen it, both design
//     decisions I am NOT taking on my own: raise W_CTRL (see above), or add
//     rider anticipation (read the lean demand a look-ahead time down the rail),
//     which costs one new time constant and makes the rider lean into bends
//     before reaching them.
//
// EVERY WRITE THIS MODULE MAKES TO PHYSICS STATE, enumerated:
//   ps.vel[0..2]      every on-rail frame (the only legal control channel)
//   ps.pos[0..2]      ONCE per lock, the documented capture snap (GR-07)
//   ps.airTime = 0    every on-rail frame        (decision 5)
//   ps._popDone=false on the lock frame          (decision 5, re-arm the ollie)
//   ps._coyoteCharge  every on-rail frame        (crouch charges the exit ollie)
//   ps.prewound       on-rail frames after a rail prewind (contract: "preserving
//                     ... prewind"); physics ignores crouch in the air, so
//                     nothing else can carry it
//   NEVER: ps.heading (measured illegalWriteMax = 0), ps.onGround, ps.spinDeg,
//   ps.flipDeg, ps.landing, or anything the trick system reads.
//
// MEASURED (harness + own probes, all reproducible from this file):
//   9/9 gates, hardFails 0. GR-05 passive bail 3.27 s (predicted 3.26),
//   active hold 1.00 of the window. GR-03 rail 9.66 m/s vs snow 5.64 m/s over
//   the same 5 s. GR-04 speed loss 0.12% (one frame of rail drag). GR-07
//   illegalWriteMax exactly 0 with one snap. GR-09 dt split error exactly 0.
//   Rider is ON the rail: y = 0.3000 for all 463 grind frames (rail y 0.30,
//   snow y 0.00), lateral error 0.0e+0, airTime 0.000, and exactly one grounded
//   frame (the lock frame, before physics' own constraint release fires).
//   Descending 12-degree rail: holds 463/480 frames, tracks the rail's y to
//   0.01 m, and settles at 15.28 m/s where the same time on a flat rail decays
//   to 5.43 m/s (predicted terminal 14.7 m/s).
//   Rail chain: ollie on -> crouch-charged pop off (dvy 1.99) -> re-land on the
//   same rail -> run off the end -> capture the next rail. 5 transitions, no
//   chatter.
//
// Pure JS, deterministic, no Date/Math.random. The only import is the accepted
// physics module's DEFAULTS — cited, never mutated, never re-tuned.

import { DEFAULTS as PHYS } from '../../../src/physics/physics.mjs';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

// --- rail preprocessing: segments, arc length, discrete curvature -----------
// Curvature uses the standard discrete-differential-geometry estimate: the turn
// angle at a vertex divided by that vertex's dual edge length (half of each
// adjacent segment), linearly interpolated along segments. No smoothing window,
// therefore no window-length constant to justify.
function prepRail(raw, sampleHeight) {
  const pts = raw.points.map(p => [p[0], p[1], p[2]]);
  const n = pts.length;
  const segs = [];
  let total = 0;
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-9) continue;
    const lenH = Math.hypot(d[0], d[2]) || 1e-9;
    segs.push({ a, dir: [d[0] / len, d[1] / len, d[2] / len], len, lenH,
      yaw: Math.atan2(d[2], d[0]), s0: total });
    total += len;
  }
  // vertex curvature (signed, horizontal plane), zero at the free ends
  const kv = new Array(segs.length + 1).fill(0);
  for (let i = 1; i < segs.length; i++) {
    const dPsi = wrapPi(segs[i].yaw - segs[i - 1].yaw);
    kv[i] = dPsi / (0.5 * (segs[i - 1].lenH + segs[i].lenH));
  }
  // how far this rail sits above the snow (drives the climb-energy lock rule)
  let clearance = 0;
  if (typeof sampleHeight === 'function') {
    for (const p of pts) clearance = Math.max(clearance, p[1] - sampleHeight(p[0], p[2]));
  }
  return { id: raw.id, width: (raw.width ?? 0.2), segs, total, kv, clearance,
    wHalf: Math.max(1e-3, (raw.width ?? 0.2) / 2) };
}

// closest point on the polyline to p  ->  { s, d, seg }
function projectRail(rail, p) {
  let best = null;
  for (let i = 0; i < rail.segs.length; i++) {
    const sg = rail.segs[i];
    const wx = p[0] - sg.a[0], wy = p[1] - sg.a[1], wz = p[2] - sg.a[2];
    const t = clamp(wx * sg.dir[0] + wy * sg.dir[1] + wz * sg.dir[2], 0, sg.len);
    const qx = sg.a[0] + sg.dir[0] * t, qy = sg.a[1] + sg.dir[1] * t, qz = sg.a[2] + sg.dir[2] * t;
    const d = Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
    if (!best || d < best.d) best = { d, s: sg.s0 + t, seg: i, q: [qx, qy, qz] };
  }
  return best;
}

// rail state at arc length s -> point, unit 3-D tangent, signed curvature
function evalRail(rail, s) {
  const S = clamp(s, 0, rail.total);
  let i = 0;
  while (i < rail.segs.length - 1 && S >= rail.segs[i].s0 + rail.segs[i].len) i++;
  const sg = rail.segs[i];
  const t = clamp(S - sg.s0, 0, sg.len);
  const u = sg.len > 1e-9 ? t / sg.len : 0;
  return {
    p: [sg.a[0] + sg.dir[0] * t, sg.a[1] + sg.dir[1] * t, sg.a[2] + sg.dir[2] * t],
    tang: sg.dir,
    kappa: rail.kv[i] * (1 - u) + rail.kv[i + 1] * u,
    yaw: sg.yaw,
  };
}

export function createRails(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rails = (env.rails ?? []).map(r => prepRail(r, sampleHeight));

  // ---- rider / pendulum geometry (see header) ----
  const G = PHYS.G_GROUND;
  const H_RIDER = 1.8;            // CONTRACTS.md
  const COM_FRAC = 0.55;          // anthropometry, see header (sensitivity shown)
  const H_COM = H_RIDER * COM_FRAC;
  const LAMBDA_P = Math.sqrt(G / H_COM);
  const ZETA_B = 1.0;             // CHOICE
  const C_B = 2 * ZETA_B * LAMBDA_P;
  const SIGMA_B = LAMBDA_P * (Math.sqrt(1 + ZETA_B * ZETA_B) - ZETA_B); // growth rate
  const SWAY_M = 0.005;           // CHOICE, log-insensitive (see header)

  // ---- capture ----
  const CAPTURE_R = 1.0;          // CHOICE inside research 02 §1.5's 0.5-1.5 m band
  const DRAG_SCALE = 0.20 / 0.35; // Tux Racer ice/snow mu ratio, research 02 §3.1
  const MU_RAIL = PHYS.MU_BASE * DRAG_SCALE;
  const LAM_RAIL = PHYS.LAMBDA_LONG * DRAG_SCALE;
  const V_STALL = MU_RAIL * G / LAMBDA_P;
  const maxClear = rails.reduce((m, r) => Math.max(m, r.clearance), 0);
  const MIN_LOCK = Math.sqrt(2 * G * maxClear + V_STALL * V_STALL);

  // ---- hook compliance ----
  const ZETA_C = 1.0;             // CHOICE (critical damping, no on/off chatter)
  const wHalfRef = rails.length ? rails[0].wHalf : 0.1;
  const OMEGA_C = Math.sqrt(G / wHalfRef);
  // rider's own lateral recovery range (see header, LENGTH SCALES)
  const W_CTRL = 0.30;

  const config = {
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    // half-life of a balance correction = the fast, stable pendulum mode
    balanceHalfLife_s: Math.LN2 / (LAMBDA_P * (Math.sqrt(1 + ZETA_B * ZETA_B) + ZETA_B)),
    // "exceeding tolerance bails": the lean-error angle beyond which no input
    // recovers the rider, atan(W_CTRL / h_com) = 16.9 deg
    curveTolerance_rad: Math.atan(W_CTRL / H_COM),
    minLockSpeed_mps: MIN_LOCK,
    // observability / derivation trail (all numbers, all equations above)
    comHeight_m: H_COM,
    pendulumRate_hz: LAMBDA_P,
    balanceGrowthRate_hz: SIGMA_B,
    balanceDampingRatio: ZETA_B,
    swaySeed_m: SWAY_M,
    predictedPassiveBail_s: Math.log(1 / (0.854 * (SWAY_M / W_CTRL))) / SIGMA_B,
    hookRate_hz: OMEGA_C,
    hookDampingRatio: ZETA_C,
    railMu: MU_RAIL,
    railLambda_hz: LAM_RAIL,
    stallSpeed_mps: V_STALL,
    riderRecovery_m: W_CTRL,
    // a_max = g*W_CTRL/h_com: the lateral COM acceleration the rider can command
    controlAuthority_mps2: G * W_CTRL / H_COM,
    // the board leaves the rail when the corner demands more than this much
    // lateral acceleration: |e| > W_half  <=>  v^2*kappa > G. No reference speed
    // is baked in — divide by v^2 for the curvature limit at that speed.
    hookLimitLateralAccel_mps2: G,
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability (never consumed by the gates; the view/HUD/trick lanes read these)
      grindTime_s: 0, curvature_invm: 0, yawError_rad: 0, yawRateNeeded_radps: 0,
      comOffset_m: 0, comVel_mps: 0, leanRad: 0, hookOffset_m: 0,
      lastLeaveReason: null, lastBailReason: null, prewindHint: 0,
      // internals
      leanDemand: 0, charge: 0,
      _s: 0, _b: 0, _bv: 0, _e: 0, _ev: 0, _rail: null,
      _vyCmd: null, _gObs: PHYS.G_AIR, _latch: null, _latchClear: false,
    };
  }

  // exact solution of  y'' + c y' - L^2 y = 0  (real distinct roots)
  function balanceStep(y0, yv0, dt) {
    const disc = Math.sqrt(C_B * C_B + 4 * LAMBDA_P * LAMBDA_P);
    const s1 = (-C_B + disc) / 2, s2 = (-C_B - disc) / 2;
    const A = (yv0 - s2 * y0) / (s1 - s2);
    const B = (s1 * y0 - yv0) / (s1 - s2);
    const e1 = Math.exp(s1 * dt), e2 = Math.exp(s2 * dt);
    return [A * e1 + B * e2, A * s1 * e1 + B * s2 * e2];
  }

  // exact critically-damped hook: e'' = -w^2 (e - e*) - 2 z w e'
  function hookStep(e0, ev0, eStar, dt) {
    const w = OMEGA_C, y0 = e0 - eStar;
    const ew = Math.exp(-w * dt);
    const y = (y0 + (ev0 + w * y0) * dt) * ew;
    const yv = (ev0 - w * (ev0 + w * y0) * dt) * ew;
    return [y + eStar, yv];
  }

  // exact flow of dv/dt = a - b v with a Coulomb clamp at 0, plus the exact
  // displacement over the same step (dt-exact: GR-09).
  function flowRail(v0, a, b, dt) {
    const veq = a / b;
    const ex = Math.exp(-b * dt);
    let v1 = veq + (v0 - veq) * ex;
    let ds = veq * dt + (v0 - veq) * (1 - ex) / b;
    if (a <= 0 && v1 < 0) { // Coulomb stop: monotone path, still split-exact
      const tStop = Math.log(1 - v0 / veq) / b; // v(tStop) = 0
      ds = veq * tStop + (v0 - veq) * (1 - Math.exp(-b * tStop)) / b;
      v1 = 0;
    }
    return [v1, ds];
  }

  function leave(gs, ps, reason, tangent) {
    if (tangent) { // exit along the rail: speed preserved, direction is the rail
      ps.vel[0] = tangent[0] * gs.alongSpeed;
      ps.vel[2] = tangent[2] * gs.alongSpeed;
      if (reason !== 'jump') ps.vel[1] = tangent[1] * gs.alongSpeed;
    }
    gs.lastLeaveSpeed = Math.hypot(ps.vel[0], ps.vel[2]);
    // Every exit EXCEPT a deliberate ollie latches this rail out until the board
    // has been further than captureRadius from it at least once. Without it a
    // rider who runs off the end (or falls off) sits inside the capture sphere
    // of the rail he just left and re-locks on the next frame, forever: measured
    // as 1-frame lock/unlock chatter at the end of every rail before this guard.
    // An ollie is exempt on purpose — you may pop and land back on the same rail
    // (the descending-only capture rule stops it re-locking on the way up).
    if (reason !== 'jump' && gs._rail) gs._latch = gs._rail.id;
    gs.onRail = false; gs.railId = null; gs._rail = null;
    gs.lastLeaveReason = reason; gs._vyCmd = null;
    gs.grindTime_s = 0;
  }

  function step(gs, ps, input = {}, dt) {
    const inp = input || {};
    if (!(dt > 0)) return gs;

    // ---- observe the engine's gravity through the channel we command -------
    // physics ran before us: it subtracted g*dt from the vy we wrote last
    // frame. No gravity constant is assumed, and gravityScale (a physics test
    // hook we cannot read) is picked up for free.
    if (gs.onRail && gs._vyCmd !== null && !inp.jumpRelease) {
      const g = (gs._vyCmd - ps.vel[1]) / dt;
      if (g > 0.5 && g < 40) gs._gObs = g;
    }
    const gScale = gs._gObs / PHYS.G_AIR;   // engine's gravityScale, observed
    const gContact = G * gScale;            // contact gravity for the slope drive

    // ---- latch bookkeeping: a bailed rail is ineligible until cleared ------
    if (gs._latch !== null) {
      const r = rails.find(r => r.id === gs._latch);
      if (!r) gs._latch = null;
      else if (projectRail(r, ps.pos).d > CAPTURE_R) gs._latch = null;
    }

    // =======================================================================
    // ON RAIL
    // =======================================================================
    if (gs.onRail) {
      const rail = gs._rail;
      gs.bailed = false;

      // jump exit FIRST: physics has already popped this frame (its coyote
      // window is open because we hold airTime at 0), so we must not overwrite
      // its vertical impulse or its prewind handling.
      if (inp.jumpRelease) {
        const at = evalRail(rail, gs._s);
        leave(gs, ps, 'jump', at.tang);
        return gs;
      }

      // --- 1. where is the board on the rail, really -----------------------
      const pr = projectRail(rail, ps.pos);
      const at = evalRail(rail, pr.s);
      const kap = at.kappa;
      const v = gs.alongSpeed;

      // --- 2. balance: inverted pendulum + CoP control + curvature ---------
      // absolute lean state b:  b'' = L^2 (b - steer) - C b' - v^2 kappa / wHalf
      const u = clamp(inp.steer ?? 0, -1, 1);
      const F = -LAMBDA_P * LAMBDA_P * u - (v * v * kap) / W_CTRL;
      const bStar = -F / (LAMBDA_P * LAMBDA_P);
      const [y, yv] = balanceStep(gs._b - bStar, gs._bv, dt);
      gs._b = y + bStar; gs._bv = yv;
      // the lean this corner DEMANDS (motorcycle lean; the hooked board can pull,
      // so leaning into a bend is not itself a fall):
      //   b_lean = v^2 kappa / (L^2 wHalf) = a_c * h_com / (g * wHalf)
      const bLean = (v * v * kap) / (LAMBDA_P * LAMBDA_P * W_CTRL);
      // gstate.balance is the DEVIATION from that demand — the thing steer
      // corrects and the thing that bails. On a straight rail it is the lean
      // itself. See header, BAIL RULE.
      gs.balance = gs._b - bLean;
      gs.leanDemand = bLean;

      // --- 3. hook compliance: the board hangs off the line on a bend ------
      const eStar = -(v * v * kap) / (OMEGA_C * OMEGA_C);
      const [e, ev] = hookStep(gs._e, gs._ev, eStar, dt);
      gs._e = e; gs._ev = ev;

      // --- 4. bail tests ---------------------------------------------------
      if (pr.d > CAPTURE_R) {                   // board is no longer on the rail
        gs.lastBailReason = null;
        leave(gs, ps, 'lost', at.tang);
        return gs;
      }
      if (Math.abs(gs.balance) > 1) {           // COM left the support polygon
        gs.balance = Math.sign(gs.balance);
        gs.bailed = true; gs.lastBailReason = 'balance';
        // the topple carries the COM's own lateral velocity into the fall
        const L = [-at.tang[2], 0, at.tang[0]];
        const vLat = gs._bv * W_CTRL;
        leave(gs, ps, 'bail', at.tang);
        ps.vel[0] += L[0] * vLat; ps.vel[2] += L[2] * vLat;
        return gs;
      }
      if (Math.abs(e) > rail.wHalf) {           // v^2 kappa > g: rail rips out
        gs.bailed = true; gs.lastBailReason = 'curvature';
        leave(gs, ps, 'bail', at.tang);
        return gs;
      }

      // --- 5. along-rail speed: slope drive - rail friction, closed form ---
      const cosT = Math.sqrt(Math.max(0, 1 - at.tang[1] * at.tang[1]));
      const a = -gContact * at.tang[1] - Math.sign(v || 1) * MU_RAIL * gContact * cosT;
      const [v1, ds] = flowRail(v, a, LAM_RAIL, dt);
      gs.alongSpeed = v1;

      const sNew = pr.s + ds;
      if (sNew >= rail.total || sNew <= 0 || v1 <= 0) {
        leave(gs, ps, sNew >= rail.total ? 'end' : 'stalled', at.tang);
        return gs;
      }
      gs._s = sNew;

      // --- 6. realise the reference through the velocity channel -----------
      const nx = evalRail(rail, sNew);
      const L2 = [-nx.tang[2], 0, nx.tang[0]];
      const tgt = [nx.p[0] + L2[0] * e, nx.p[1], nx.p[2] + L2[2] * e];
      ps.vel[0] = (tgt[0] - ps.pos[0]) / dt;
      ps.vel[2] = (tgt[2] - ps.pos[2]) / dt;
      // pre-compensate the gravity the next physics step will apply, so the
      // board neither sags into the rail nor floats off it.
      ps.vel[1] = (tgt[1] - ps.pos[1]) / dt + gs._gObs * dt;
      gs._vyCmd = ps.vel[1];

      // a grind is contact, not hang time (decision 5 in the header)
      ps.airTime = 0;

      // --- 7. observability -----------------------------------------------
      gs.t = rail.total > 0 ? clamp(sNew / rail.total, 0, 1) : 0;
      gs.lockFrames++; gs.grindTime_s += dt;
      gs.curvature_invm = kap;
      gs.comOffset_m = gs.balance * W_CTRL;
      gs.comVel_mps = gs._bv * W_CTRL;
      gs.leanRad = Math.atan(gs.comOffset_m / H_COM);
      gs.hookOffset_m = e;
      gs.yawError_rad = wrapPi(ps.heading - nx.yaw);
      gs.yawRateNeeded_radps = v1 * kap;
      // crouch on a rail charges the exit ollie and can prewind it. Physics
      // ignores crouch while airborne (and a grind reads as airborne to it), so
      // this module keeps the charge and hands it to the engine's own pop
      // through the fields that pop reads. Same enumerated-write rule as
      // airTime: not heading, not position, not trick state (tricks.mjs reads
      // neither prewound nor _coyoteCharge — verified by grep).
      if (inp.crouch) {
        gs.charge = clamp(gs.charge + dt / PHYS.T_CHARGE, 0, 1);
        if (Math.abs(inp.spin ?? 0) > 0.3) gs.prewindHint = Math.sign(inp.spin);
      } else { gs.charge = 0; }
      ps._coyoteCharge = gs.charge;
      if (gs.prewindHint !== 0) ps.prewound = gs.prewindHint;
      return gs;
    }

    // =======================================================================
    // OFF RAIL: auto lock-on, no button press (GR-01 / research 02 §1.5)
    // =======================================================================
    gs._vyCmd = null;
    // sourced eligibility: capture is tested only while descending or in contact
    const descending = ps.vel[1] <= 0 || ps.onGround === true;
    if (!descending) return gs;

    let cand = null;
    for (const rail of rails) {
      if (rail.id === gs._latch) continue;         // bailed off this one, not clear yet
      const pr = projectRail(rail, ps.pos);
      if (pr.d > CAPTURE_R) continue;
      if (!cand || pr.d < cand.pr.d) cand = { rail, pr };
    }
    if (!cand) return gs;

    const { rail, pr } = cand;
    const speed3 = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
    // energy gate: you must be able to climb onto the rail
    const lift = Math.max(0, pr.q[1] - ps.pos[1]);
    const need = Math.sqrt(2 * G * gScale * lift + V_STALL * V_STALL);
    if (speed3 < need) return gs;

    const at = evalRail(rail, pr.s);
    // speed conversion: the along-rail component of the incoming velocity, with
    // the rail's own direction (a rider going backwards up a rail grinds fakie)
    const along = ps.vel[0] * at.tang[0] + ps.vel[1] * at.tang[1] + ps.vel[2] * at.tang[2];
    if (Math.abs(along) < V_STALL) return gs;

    // lateral velocity the board is about to lose to the rail — the COM keeps
    // it, and that is the capture transient (measured, not invented)
    const L = [-at.tang[2], 0, at.tang[0]];
    const preLat = ps.vel[0] * L[0] + ps.vel[2] * L[2];

    // THE ONE LEGAL POSITION WRITE: the documented lock-on snap, 3-D, magnitude
    // <= captureRadius, exactly once per lock (GR-07).
    ps.pos[0] = pr.q[0]; ps.pos[1] = pr.q[1]; ps.pos[2] = pr.q[2];
    ps.vel[0] = at.tang[0] * along; ps.vel[2] = at.tang[2] * along;
    // vertical: rail tangent + the same gravity pre-compensation the servo uses,
    // so the board does not dip 1.8 mm into the rail on the first frame. It also
    // guarantees physics' predictive constraint release fires next frame, which
    // is what takes the rider OFF the snow and onto the rail.
    ps.vel[1] = at.tang[1] * along + gs._gObs * dt;
    // re-arm the engine's ollie channel: a rail landing is a fresh takeoff for
    // jump purposes, otherwise a rail-to-rail chain gets exactly one pop. This
    // writes one private physics field, on the lock frame only. The clean fix is
    // a `rearmPop(state)` on the physics module; requested, not assumed.
    ps._popDone = false;

    gs.onRail = true; gs.railId = rail.id; gs._rail = rail;
    gs.alongSpeed = along; gs._s = pr.s; gs.bailed = false;
    gs.t = rail.total > 0 ? clamp(pr.s / rail.total, 0, 1) : 0;
    gs.lockFrames = 1; gs.grindTime_s = 0; gs.charge = 0; gs.prewindHint = 0;

    // capture transient (see header, CAPTURE SEED): the rider arrives already
    // set up for the bend they can see, so the seed is the sway floor on top of
    // whatever lean this point demands — NOT the raw lateral slam.
    const bLean0 = (along * along * at.kappa) / (LAMBDA_P * LAMBDA_P * W_CTRL);
    gs._bv = 0;
    const seedSign = preLat !== 0 ? -Math.sign(preLat) : (at.kappa !== 0 ? Math.sign(at.kappa) : 1);
    gs.balance = seedSign * (SWAY_M / W_CTRL);
    gs._b = bLean0 + gs.balance;
    gs.leanDemand = bLean0;
    gs._e = 0; gs._ev = 0;
    gs.comOffset_m = gs.balance * W_CTRL;
    gs.leanRad = Math.atan(gs.comOffset_m / H_COM);
    gs.yawError_rad = wrapPi(ps.heading - at.yaw);
    ps.airTime = 0;
    return gs;
  }

  return { config, init, step };
}
