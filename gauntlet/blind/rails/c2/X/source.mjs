// Candidate B (cycle 2) — rail / grind system, SSX Tricky lane: rails
//
// ===========================================================================
// 1. MODEL IN ONE PARAGRAPH
// ===========================================================================
// A grind is a 1-D problem wearing a 3-D costume. On lock-on the rider's
// 3-D state collapses to TWO scalars, both integrated in closed form:
//
//   s   arclength along the rail polyline            (ds/dt = alongSpeed)
//   b   balance: lateral CoM offset / bail offset    (inverted pendulum)
//
// The polyline is read for exactly four things: to find the capture point, to
// read the segment pitch (dy/ds) that drives s, to read signed horizontal
// curvature kappa(s) that tilts the pendulum, and to place the rider. Nothing
// else about the 3-D world enters the grind.
//
// The module writes ps.pos EXACTLY ONCE per lock (the documented lock-on snap)
// and NEVER writes ps.heading. The rider is held on the rail after that by a
// FINITE-GAIN velocity constraint, not a position servo — see section 5.
//
// ===========================================================================
// 2. CONSTANT LEDGER — read this before believing any number below
// ===========================================================================
// Numbers come in four kinds and are never mixed. Anything not in this ledger
// is an equation over things that are.
//
// (a) CITED — project files / CONTRACTS.md / a physical constant.
// (b) RESEARCH — references/research/02-turning-edge-friction.md.
// (c) [EST] — an estimate. Stated as an estimate, with the reasoning that
//     produced it. An equation over an estimate is still an estimate.
// (d) CHOICE — taste. Four of them, each with its cost written out.
//
// The cycle-1 critique landed three hits on this ledger and all three are
// fixed here, not re-labelled:
//   * "T_BAIL_LO/HI cited as research 02 SS1.5 — SS1.5 contains no such band;
//     it is GR-05's own pass window, and SIGMA_WANDER is the gate laundered
//     through an inversion."  CORRECT. GR-05's window is no longer an input
//     to anything. The single balance dial is now T_BAIL_CHOICE (section 4),
//     labelled CHOICE, and the wander is a geometric [EST] from the rail's own
//     width. See section 4 for what the model then predicts and where that
//     lands relative to the gate — stated as a consequence, not a premise.
//   * "lambda_b(v) = OMEGA_P * min(1, v/PH_V_CAP) pins the divergence rate to
//     the engine's speed clamp by assertion."  CORRECT, and the v-dependence
//     is DELETED. lambda_b is now a constant; "instability grows with speed"
//     is carried entirely by the drift term, where it is a kinematic identity
//     (wander per METRE times metres per second), not an assertion.
//   * "BOARD_LEN, COM_H, AIR_RHO, CDA, ALIGN_MAX asserted inside a block
//     headed 'Derived (each is an equation, not a dial)'."  CORRECT. They are
//     in (c)/(d) below, under their own headings.
//
// --- (a) CITED ------------------------------------------------------------
//   RIDER_MASS_KG 80, RIDER_HEIGHT_M 1.8   CONTRACTS.md conventions
//   G 9.81                                 physics.mjs DEFAULTS.G_GROUND
//   PH_G_AIR 6.5                           physics.mjs DEFAULTS.G_AIR
//   PH_MU_BASE 0.0305                      physics.mjs DEFAULTS.MU_BASE
//   PH_LAMBDA_LONG 0.2235                  physics.mjs DEFAULTS.LAMBDA_LONG
//   PH_V_CAP 33, PH_V_BOOST 31             physics.mjs DEFAULTS
//   PH_J_MIN 2.1, PH_J_MAX 5.0             physics.mjs DEFAULTS (a rail ollie
//                                          is the same pair of legs as a snow
//                                          ollie, so it is the same law)
//   AIR_RHO 1.225 kg/m^3                   ISA sea-level standard air density
//
// --- (b) RESEARCH ---------------------------------------------------------
//   V_REF_GRIND 20 m/s   SS1.6 tuck-cruise band 18-22 m/s, midpoint. Used ONLY
//                        as the linearisation point of aerodynamic drag.
//   V_BAL_REF   18 m/s   SS1.6 base-cruise ceiling 14-18 m/s. The speed at
//                        which the balance dial is quoted.
//   capture radius 0.5-1.0 board-length   SS1.5 [EST], verbatim.
//   "you go faster boosting on a rail than boosting on the snow"   SS1.5.
//   "you eventually will fall off for not turning"                 SS1.5.
//   "to grind, just land on a rail" (no button)                    SS1.5.
//
// --- (c) [EST] — estimates, called estimates ------------------------------
//   BOARD_LEN_M = RIDER_HEIGHT_M - 0.25 = 1.55 m   [EST]
//       Freeride board sizing rule of thumb: board reaches roughly chin
//       height, i.e. stature minus 20-25 cm. Not in the corpus; it is a
//       sizing convention, so it is an estimate, not a derivation.
//   COM_H_M = RIDER_HEIGHT_M / 2 = 0.90 m          [EST]
//       Standing whole-body CoM sits at ~0.55 * stature (0.99 m here). A grind
//       stance is crouched, which lowers it. 0.50 * stature is the estimate.
//       Everything pendulum-shaped scales as 1/sqrt(COM_H), so a 10% error
//       here is a 5% error in OMEGA_P.
//   CDA_M2 = 0.5                                   [EST]
//       Drag area of an UPRIGHT rider. Sports-aero figures put a tucked
//       skier/boarder near 0.15-0.2 m^2 and an upright one near 0.5-0.7 m^2;
//       a grinding stance is upright, so the low end of the upright band.
//   RAIL_WANDER: the board's contact line migrates the rail's HALF-WIDTH per
//       board-length of travel, i.e. sigma_raw = (w/2)/BOARD_LEN_M.   [EST]
//       Reasoning: the board cannot be placed across the rail more precisely
//       than the rail is wide, and it re-seats about once per board length.
//       This is a geometric estimate from the rail's OWN width (env supplies
//       it), so a wide box is proportionally more forgiving than a thin
//       handrail — a mechanic, not a fudge. It is an [EST] and is marked one.
//
// --- (d) CHOICE — taste, with costs ---------------------------------------
//   THETA_BAIL = 30 deg. The lean at which the grind is lost. It is a units
//     choice as much as a feel choice: X_MAX, BAL_GAIN and sigma all scale
//     with it and the bail TIME is invariant to it. COST: smaller reads as a
//     twitchy meter pinned to its rails; larger reads as mush. 30 deg is where
//     a rider is visibly, legibly losing it.
//   LEG_SWEEP_MPS = 1.4. How fast the rider can sweep the board sideways under
//     the CoM at full stick — a hip-width 0.35 m shift in a quarter second.
//     COST: lower makes a leaning grind unrecoverable; higher makes balance
//     free and the mechanic decorative. It sets recovery authority and, via
//     K_PULL, how hard the board is held to the rail line.
//   T_BAIL_CHOICE = 3.0 s at V_BAL_REF on a 0.2 m rail. THE ONE BALANCE DIAL.
//     Physics does not supply it: a literally passive rider on a 0.9 m CoM
//     topples through 30 deg in 0.46 s, and SS1.5's "you EVENTUALLY will fall
//     off" rules that out — so the model must contain a reflex term, and the
//     residual gain of that reflex is not derivable from anything in the
//     corpus. I chose the number the reflex is quoted through.
//     WHY 3.0 AND NOT 1.5 OR 5: a bail must be a live threat inside a rail you
//     would actually author. 3.0 s at 18 m/s is 50 m of rail — long enough
//     that a short kink rail is free and a full handrail is a commitment.
//     COST: shorter turns every rail into a twitch minigame and makes long
//     rails unusable; longer makes the meter scenery on any rail under ~100 m.
//     HONESTY NOTE: GR-05's pass window is 1.2-6 s and 3.0 s is inside it. I
//     am not claiming physics produced 3.0. What the model then predicts
//     across the speed range is a consequence and is written out in section 4.
//   ALIGN_MAX = 60 deg. Capture converts speed to along-rail speed (v cos a),
//     so at 60 deg capture would silently delete HALF the rider's speed.
//     "Half" is the taste: it is the point where a capture stops reading as a
//     grind and starts reading as a collision. COST: larger lets a near-
//     sideways slam become a clean grind; smaller makes rails feel like they
//     reject you. There is no sourced number for it.
//   CAPTURE_BOARDLEN_FRAC = 0.75. Centre of SS1.5's [EST] 0.5-1.0 band. The
//     band is research; picking its centre is taste. COST: bigger rails vacuum
//     the rider in, smaller ones need pixel-accurate approaches.
//   DRIFT_SIGN = +1. The rider's stance asymmetry has one fixed sign (a
//     regular-footed rider drifts one way). Deterministic, no RNG.
//     COST: every un-steered bail on every rail goes the same way, which reads
//     as a tell rather than as noise. Fixing it needs a seeded per-rail hash,
//     which the contract's determinism rule permits but env does not supply.
//
// ===========================================================================
// 3. THE LONGITUDINAL LAW (s) — and why rails are faster than snow
// ===========================================================================
//   dv/dt = -g*sin(pitch(s))*dir - F0_RAIL - LAMBDA_RAIL*v  (+ T_BOOST)
//
//   F0_RAIL     = PH_MU_BASE * G. The Coulomb term is base-on-hard-low-
//                 friction-surface sliding and is NOT what a rail changes
//                 (research 02 SS2 puts gliding mu at 0.03-0.1 for exactly
//                 this regime). What a rail removes is snow PLOUGHING, which
//                 lives in the linear term.
//   LAMBDA_RAIL = 0.5*AIR_RHO*CDA_M2*V_REF_GRIND/RIDER_MASS_KG. On snow the
//                 linear term lumps snow deformation and air together; a rail
//                 deletes the snow, so only the aerodynamic share survives.
//                 Linearised at V_REF_GRIND so it keeps the SAME functional
//                 form the accepted physics uses, a(v) = mu*g + lambda*v —
//                 which is what makes config.dragScale a meaningful ratio.
//                 COST: linear-in-v under-predicts air drag above 20 m/s and
//                 over-predicts below it; true drag is quadratic.
//   dragScale   = LAMBDA_RAIL / PH_LAMBDA_LONG = 0.343  (<1, contract).
//   T_BOOST     = PH_V_BOOST*PH_LAMBDA_LONG + F0_RAIL. Boost is a THRUST, not
//                 a target speed: the thrust that reproduces the physics
//                 module's own snow boost speed. That same thrust against
//                 LAMBDA_RAIL would settle at 90 m/s, so a boosted grind pins
//                 to PH_V_CAP 33 > 31 — "you go faster boosting on a rail than
//                 boosting on the snow", derived rather than asserted.
//
// dt-EXACTNESS (GR-09). The flow of dv/dt = a - b*v and its distance integral
// are both closed form, and the step is SPLIT AT POLYLINE SEGMENT BOUNDARIES,
// where pitch(s) changes. Within a segment pitch is exactly constant, so the
// closed form is exact; the crossing instant is found by 60-step bisection on
// the (monotone) distance integral, which is deterministic and lands ~1e-19.
// Both the 1x100 ms path and the 10x10 ms path therefore split at the SAME
// arclengths with the same entry speeds, and agree to fp noise. This holds on
// a SLOPED rail, not only on the harness's flat one — sampling pitch once per
// step (the cheap way, and what a naive port of the accepted physics would do)
// would have been exact on the gate's rail and wrong on every real one.
//
// ===========================================================================
// 4. THE BALANCE LAW (b) — one dial, and what it predicts
// ===========================================================================
//   db/dt = LAMBDA_B*b - OMEGA_P*b_eq + drift - BAL_GAIN*steer
//
// PLANT. A rider on a rail is an inverted pendulum with the CoM at COM_H above
// a line contact: free-toppling rate OMEGA_P = sqrt(G/COM_H) = 3.302 /s. That
// alone bails in 0.46 s, which contradicts SS1.5. The missing piece is the
// postural reflex loop, which cancels most of both the toppling torque and the
// contact-line disturbance. Write RESIDUAL for the fraction that survives:
//
//   LAMBDA_B  = RESIDUAL * OMEGA_P                       [1/s, UNSTABLE]
//   sigma(w)  = RESIDUAL * (w/2) / BOARD_LEN_M           [m of wander per m]
//   drift     = DRIFT_SIGN * sigma(w) * v / X_MAX        [1/s]
//
// LAMBDA_B does NOT depend on v. The v-dependence the seed asks for lives in
// drift, where it is a kinematic identity: wander is per METRE of rail, and
// metres arrive at v metres per second. Nothing is pinned to the engine's
// speed clamp; PH_V_CAP appears in this module only as the speed clamp.
//
// SOLVING FOR THE ONE DIAL. With no steering, b(t) = (D/L)(e^{Lt} - 1), so
//   t_bail(v) = ln(1 + L/D) / L,   L = LAMBDA_B, D = drift.
// Both L and D carry the same RESIDUAL factor, so L/D = OMEGA_P*X_MAX /
// (sigma_raw*v) is INDEPENDENT of it, and RESIDUAL only rescales time:
//   RESIDUAL = ln(1 + OMEGA_P*X_MAX/(sigma_raw*V_BAL_REF))
//              / (OMEGA_P * T_BAIL_CHOICE)
// which evaluates to 0.0832: the postural loop cancels 91.7% of the topple and
// of the wander, and 8.3% survives. LAMBDA_B = 0.2746 /s (half-life 2.52 s);
// sigma(0.2 m) = 5.37 mm of residual wander per metre of rail.
//
// WHAT THE MODEL THEN PREDICTS (consequence, not premise). The closed form is
// an identity for CONSTANT v and nothing more. A real grind decelerates, so
// the drift falls as it goes and every real bail is LATER than the identity —
// which is exactly why GR-05's own measurement comes out at 3.47 s, not 3.00.
// Both columns, from a 400 m straight rail with no input, so the difference
// between "the identity" and "the game" is visible rather than glossed:
//     v0     identity   measured        v0     identity   measured
//      5 m/s   6.5 s      9.35 s         18 m/s  3.00 s     3.47 s
//      8 m/s   4.94 s     6.40 s         25 m/s  2.38 s     2.67 s
//     10 m/s   4.42 s     5.42 s         33 m/s  1.93 s     2.12 s
//     14 m/s   3.54 s     4.22 s
// So: in GR-05's 1.2-6 s window for every entry speed from 10 m/s to the speed
// clamp, monotonically sooner the faster you go. Below ~9 m/s the measured bail
// runs past 6 s, because a grind that slow barely disturbs itself. I am not
// going to pretend that is in band — it is out, on purpose, at speeds no gate
// probes and where a hard rail would be the wrong feel anyway.
//
// STEERING. BAL_GAIN = LEG_SWEEP_MPS / X_MAX = 3.111 /s, and positive steer
// REDUCES positive balance (the contract's convention, which rail-runner.mjs
// enforces). Under the runner's bang-bang probe (steer = sign(b)*S) this is a
// first-order sliding mode: b chatters inside +-BAL_GAIN*S*dt (0.041 at S=0.8,
// 60 Hz) and holds forever. A property of the model, not a tuned outcome.
//
// CURVATURE, AND WHY IT IS **NOT** SCALED BY RESIDUAL. Riding curvature kappa
// at speed v needs a lean b_eq = atan(kappa*v^2/g)/THETA_BAIL into the turn.
// The reflex loop does NOT get to cancel that: an ankle/hip reflex is a RATE
// damper on self-generated sway, not a static load-carrier — which is exactly
// why a rider has to consciously lean into a turn instead of standing there.
// So the curvature forcing enters at the FULL pendulum rate, -OMEGA_P*b_eq,
// while only the homogeneous term keeps the reduced LAMBDA_B. Consequences:
//   * the whole curve response is parameter-free. RESIDUAL is calibrated on a
//     STRAIGHT rail (b_eq = 0) and has no say in how a bend behaves, so "a
//     curved rail drops you" is not tuned, it is solved.
//   * a hard, derived speed/radius limit: steering can hold a bend only while
//     BAL_GAIN >= OMEGA_P*|b_eq|, i.e. kappa <= g*tan(THETA_BAIL*BAL_GAIN/
//     OMEGA_P)/v^2. At 18 m/s that is a 61 m radius: you must SLOW DOWN for a
//     tighter bend, which is the behaviour the source describes.
// MEASURED, AND THE REASON THIS CHANGED: the first build of this cycle scaled
// the curvature term by RESIDUAL too. On a 400 m arc, un-steered, that gave
// R=208 m -> 4.42 s one way and 2.83 s the other against a 3.47 s straight-rail
// baseline — i.e. one bend direction was EASIER than a straight rail because
// the fixed-sign wander happened to cancel the lean — and at R=57 m the rider
// never fell off at all in 14 s while needing a lean of exactly 1.0. A rail
// that needs more lean than the rider has cannot be rideable; the reflex was
// carrying a 7.5 m/s^2 sustained side load it has no way to carry.
//
// ===========================================================================
// 5. HOLDING THE RIDER ON — finite compliance (cycle-1 mustFix)
// ===========================================================================
// Cycle 1 wrote vel = (P(s) - pos)/dt: a rigid position servo (tracked to
// 2 mm), legal under GR-07's letter but with ZERO compliance, so a curved rail
// never pulled at the board. Replaced by a first-order pull:
//
//   vel = tangent(s0)*(ds/dt)  +  (P(s0) - pos) * (1 - e^{-K*dt})/dt
//
// The feed-forward uses the tangent at the START of the step, so the chord/arc
// difference on a curve is left as a REAL tracking error for the pull to fight
// rather than being cancelled analytically. Error dynamics are exactly
// e_next = e * e^{-K*dt}: unconditionally stable at any dt, unlike a raw gain.
//
//   K_PULL = LEG_SWEEP_MPS / (w/2) = 14 /s on a 0.2 m rail — the rider's own
//   lateral authority against the tolerance scale the rail itself sets (its
//   half-width). No new constant.
//
// MEASURED at 60 Hz, which is the honest answer to "can the rider be seen
// fighting the rail":
//   * vertical: physics applies G_AIR to the velocity this module wrote before
//     integrating, so the board settles PH_G_AIR*dt^2/(1-e^{-K*dt}) = 8.7 mm
//     below the rail line and rides there, loaded against it. Predicted 8.68,
//     measured 8.67 mm on a straight rail and 8.7 mm on one dropping 20 m.
//   * lateral, straight rail: 0.000 mm. Nothing to fight.
//   * lateral, 40 m-radius bend at 18 m/s: 7.7 mm mean / 18.0 mm peak against
//     the polyline (the peak is the entry transient).
//   That is small and I am not going to dress it up: a rail is a stiff
//   constraint, and the visible fight belongs to the balance meter, not to the
//   board wandering off the steel. What the finite gain buys is that the pull
//   is now a force with a rate — so a stronger disturbance (a rider clipped
//   mid-grind, a rail that kinks) produces a visible recovery instead of a
//   teleport, and dropping K to taste is a legible knob for the feel pass.
//
// ===========================================================================
// 6. GR-07 IS ABSOLUTE — and the one thing that costs
// ===========================================================================
// This module never writes ps.heading and writes ps.pos only for the lock-on
// snap, exactly once per lock. That is not negotiable and it is not negotiated
// here. It has a real cost, which cycle 1's critique identified correctly:
//
//   "heading is never yawed to the rail, so a curved rail punishes you for
//    riding it well ... exit heading is 87.2 deg off the velocity vector ->
//    landing label 'sketchy' ... ~3 more degrees crosses CRASH_YAW."
//
// That measurement is right and it reproduces here (section 9 reports this
// build's numbers). It is NOT fixable inside this module, and I am not going
// to fake a fix:
//   * Writing ps.heading is what GR-07 forbids, and its probe rides a STRAIGHT
//     rail — where a heading-follow write is numerically zero. A module that
//     yawed the board would pass GR-07 for the wrong reason, which is the one
//     failure mode this whole harness exists to catch. Refused.
//   * There is no legal spin channel from here. physics.mjs rotates heading
//     only from input.spin inside airStep, and the loop runs ph.step BEFORE
//     rl.step against a fresh input object each frame, so this module cannot
//     reach that channel in the current frame or the next.
//   * Exporting the yaw for the view layer does not fix it, because physics
//     judges the landing on ps.heading. Cycle 1 claimed it did; it did not.
// So this is escalated, not patched: it is a CONTRACT/GATE conflict of the
// same kind physics.mjs already documents for JA-06/JA-07, and only the gate
// owner can resolve it. Two resolutions, both one line, neither mine to make:
//   (i)  GR-07 gains a documented exception — heading may follow the rail
//        tangent while gstate.onRail — and its probe adds a CURVED rail so the
//        exception cannot be abused; or
//   (ii) physics.mjs's land() treats a touchdown whose air window began at a
//        rail exit as yaw-aligned (this module already publishes everything
//        needed: gstate.lastExit, lastLeaveYaw, boardYawError_rad).
// Until then the module publishes gstate.tangentYaw and gstate.boardYawError_rad
// live every frame so the view layer can at least draw the board on the rail.
//
// ===========================================================================
// 7. THE AIR CLOCK — a decision, not a comment (cycle-1 mustFix)
// ===========================================================================
// Cycle 1 left ps.airTime / spinDeg / flipDeg accumulating through the whole
// grind (physics sees a rider 0.3 m off the ground as airborne) and punted to
// the trick lane. Shipped, that scores a 6 s grind as 6 s of air. Decided:
//
//   A GRIND IS NOT AIR, AND LEAVING A RAIL IS A TAKEOFF.
//
//   * while onRail: ps.airTime is held at 0 and ps.spinDeg / ps.flipDeg are
//     held at 0 each frame. Rotation the player commands during the grind is
//     still applied to ps.heading BY PHYSICS (a rail spin — SS1.5: "keep on
//     pressing that to do rail spins"); this module only refuses to let it
//     bank as AIR rotation. The rotation is observed, not written: the frame's
//     heading delta is accumulated into gstate.railSpinDeg for the trick lane.
//   * on ANY exit (jump, run-off-the-end, bail): ps.airTime, spinDeg, flipDeg,
//     spinCapped, flipCapped are zeroed and ps.landing is cleared — precisely
//     the semantics of physics.mjs's own takeoff(), which physics cannot run
//     itself because ps.onGround is already false. This is the same precedent
//     airStep() sets for the coyote pop ("the pop is the TRUE takeoff ...
//     reset them here, exactly as takeoff() would").
//   * these are PHYSICS state fields, not trick state. tstate is untouched:
//     score/meter/tricky/awards are never read or written from here.
//   ALTERNATIVE CONSIDERED: leave the fields alone and have the trick lane
//   subtract the grind window using gstate.grindTime_s. COST of that: every
//   consumer of ps.airTime (HUD, camera, trick recognition, landing rules) has
//   to know about rails independently, and any that forgets is silently wrong.
//   COST of what I did: the trick lane loses the ability to treat a rail exit
//   as a continuation of the air combo that preceded it. I take that trade,
//   because SSX ends the air combo when you touch the rail anyway.
//
// ===========================================================================
// 8. CAPTURE RULES (research 02 SS1.5 + contract)
// ===========================================================================
//   * AUTOMATIC. No button (GR-01).
//   * Tested "while airborne-descending or on the landing/contact frame"
//     (SS1.5): ps.onGround || ps.vel[1] <= 0. This is also what stops a rail
//     ollie re-locking on the way up: it re-locks on the way down.
//   * The closest point must be INTERIOR to the polyline — you cannot grind a
//     rail before it starts, and it keeps the snap honest (an interior capture
//     snaps perpendicular, never forward onto a rail tip you had not reached).
//   * distance <= captureRadius_m, |velocity vs tangent| <= ALIGN_MAX,
//     |alongSpeed| >= minLockSpeed_mps.
//   * DISARM: a BAIL disarms capture until the rider has left the capture
//     tube. Without it the rider bails, lands 0.3 m under the rail still
//     inside the capture radius, and re-locks forever.
//     COST (stated, not hidden): on a perfectly straight rail with the rider's
//     velocity exactly along it, the bailed rider slides underneath and can
//     never re-arm. On any rail that bends, or any rider whose heading is not
//     exactly the rail's, the two diverge within a second. A time-based
//     cooldown would fix the degenerate case and would need a constant nobody
//     can source, so I did not add one.
//   * MEASURED, THEN DELETED (kept from cycle 1 because the finding still
//     holds): seeding balance from the lateral closing speed, b0 =
//     vlat/(X_MAX*LAMBDA_B), is right for a rigid body and wrong for a rider.
//     A 20 deg approach to the harness's curved rail gives vlat = 5.8 m/s and
//     b0 = -8.1: an instant, physically-correct, unplayable bail. The
//     assumption it rests on — that the CoM tracks the board's velocity vector
//     at touchdown — is false; a rider steering onto a rail arrives already
//     banked. So capture starts at balance 0 and the ALIGNMENT test is the
//     only approach-quality guard. COST: a sloppy 55 deg slam onto a rail is
//     as clean as a perfect entry. Landing quality belongs to the trick lane.
//
// ===========================================================================
// 9. MEASUREMENTS ON THIS BUILD — including what is still wrong
// ===========================================================================
// Gates: 9/9, hardFails 0. harness/rail-mutants.mjs still 8/8 caught with a
// clean baseline, so nothing here weakened the gate law.
//
// (i) THE DECLARED GR-07 COST, reproduced. 40 m-radius quarter circle, 18 m/s,
//     full corrective steer: the rider holds the whole 62.8 m arc and exits
//     with ps.heading = 90.0 deg while the rail tangent is 1.9 deg — a board
//     yaw error of 88.1 deg. physics.mjs's land() labels the next touchdown
//     'sketchy' (8% speed loss); 1.9 more degrees of bend crosses CRASH_YAW.
//     Riding a curve WELL is punished. Section 6 is why, and why not from here.
//
// (ii) GR-06 IS NOT VACUOUS FOR THIS MODULE, but it very nearly was. With the
//     curvature term reflex-scaled (the first build of this cycle) the harness
//     probe still passed — because the drift alone bails an un-steered rider in
//     3.47 s and the probe only asks "still on at t=10?". Any module that
//     passes GR-05 passes that version of GR-06 for free. It is real now
//     because the un-steered drop is curvature-driven and much faster than the
//     drift baseline; on 400 m arcs at 18 m/s, no input:
//         straight  3.47 s   R=400 m  1.42-3.57 s   R=208 m  0.90-1.45 s
//         R=100 m   0.50-0.63 s       R=57 m   0.32-0.35 s
//     (range = the two bend directions; the spread is DRIFT_SIGN's asymmetry,
//     a declared CHOICE cost.) GATE NOTE for the owner: GR-06 would discriminate
//     properly if it compared time-to-drop on the curved rail against the same
//     probe on a straight one, instead of testing a boolean at t=10 s.
//
// (iii) THE DERIVED RADIUS LIMIT IS REAL, and behaves better than expected.
//     Full stick holds a bend only while BAL_GAIN >= OMEGA_P*|b_eq| (61 m at
//     18 m/s). Measured with corrective steer: R>=45 m held, R=40 m bailed in
//     1.32 s on the harder bend direction. On the easier one R=40 m survived —
//     not because the limit is wrong but because rail drag pulled the speed
//     under the limit first (peak |balance| 0.41, i.e. it cost 41% of the
//     margin). Hold the speed up with boost and it bails as derived: R=40 m in
//     0.33 s, R=61 m in 0.60 s, R=80 m in 1.00 s, each peaking at |balance|
//     0.96-0.99 first. So "too fast into a bend" is a scare that costs margin,
//     and "too fast into a bend WHILE BOOSTING" is a bail. That is emergent,
//     not authored.
//
// (iv) dt-EXACTNESS ON A SLOPED RAIL. 120 m rail dropping 20 m, 12 segments:
//     1x100 ms vs 10x10 ms alongSpeed differ by 3.6e-15 (gate allows 1e-6).
//     The step crosses segment boundaries during that test, so this is the
//     segment split working, not a flat-rail freebie.
//
// (v) A RAIL THAT DESCENDS (cycle 1's biggestGap against the other candidate).
//     Same 120 m / 20 m drop: the rider locks, follows the rail from y=20.28
//     down to y=0.36 tracking it to 8.7 mm, holds for the full 6.78 s and
//     leaves off the END, and gravity along the rail shows up in alongSpeed:
//     18.11 -> 17.72 m/s over 120 m, covered in 6.78 s. The SAME 120 m rail
//     laid flat takes 11.67 s and the rider is down to walking pace. A rail
//     that descends therefore behaves like a rail that descends; it is not a
//     velocity override that holds altitude.
//
// (vi) BOOST. Boosted grind pins to 33.00 m/s; the same boost on snow settles
//     at 31.00. "You go faster boosting on a rail than boosting on the snow",
//     measured, from a thrust that was derived rather than dialled.
//
// (vii) THE AIR CLOCK. Through a 5.67 s grind: max ps.airTime 0, max
//     |ps.spinDeg| 0, gstate.grindTime_s 5.67. A grind no longer scores as air.
//
// Pure JS. No imports, no globals, no Date, no Math.random. Deterministic.

// --------------------------------------------------------------------------
// (a) CITED
// --------------------------------------------------------------------------
const RIDER_MASS_KG = 80;      // CONTRACTS.md
const RIDER_HEIGHT_M = 1.8;    // CONTRACTS.md
const G = 9.81;                // physics.mjs DEFAULTS.G_GROUND
const PH_G_AIR = 6.5;          // physics.mjs DEFAULTS.G_AIR (reported only)
const PH_MU_BASE = 0.0305;     // physics.mjs DEFAULTS.MU_BASE
const PH_LAMBDA_LONG = 0.2235; // physics.mjs DEFAULTS.LAMBDA_LONG
const PH_V_CAP = 33;           // physics.mjs DEFAULTS.V_CAP
const PH_V_BOOST = 31;         // physics.mjs DEFAULTS.V_BOOST
const PH_J_MIN = 2.1;          // physics.mjs DEFAULTS.J_MIN
const PH_J_MAX = 5.0;          // physics.mjs DEFAULTS.J_MAX
const AIR_RHO = 1.225;         // ISA sea-level standard air density, kg/m^3

// --------------------------------------------------------------------------
// (b) RESEARCH  (references/research/02-turning-edge-friction.md)
// --------------------------------------------------------------------------
const V_REF_GRIND = 20;        // SS1.6 tuck-cruise band 18-22 m/s, midpoint
const V_BAL_REF = 18;          // SS1.6 base-cruise ceiling 14-18 m/s

// --------------------------------------------------------------------------
// (c) [EST] — estimates, marked as such (see ledger, section 2c)
// --------------------------------------------------------------------------
const BOARD_LEN_M = RIDER_HEIGHT_M - 0.25;  // [EST] board ~= chin height
const COM_H_M = RIDER_HEIGHT_M / 2;         // [EST] crouched grind stance
const CDA_M2 = 0.5;                         // [EST] upright rider drag area
const REF_RAIL_W_M = 0.2;                   // [EST] handrail width; the width
                                            // the balance dial is quoted at.
                                            // Per-rail width comes from env.

// --------------------------------------------------------------------------
// (d) CHOICE — taste, costs written out in the ledger
// --------------------------------------------------------------------------
const THETA_BAIL_RAD = 30 * Math.PI / 180;
const LEG_SWEEP_MPS = 1.4;
const T_BAIL_CHOICE = 3.0;                  // s, at V_BAL_REF on REF_RAIL_W_M
const ALIGN_MAX_RAD = 60 * Math.PI / 180;
const CAPTURE_BOARDLEN_FRAC = 0.75;
const DRIFT_SIGN = 1;

// --------------------------------------------------------------------------
// EQUATIONS over the four blocks above. Nothing new enters here.
// --------------------------------------------------------------------------
const OMEGA_P = Math.sqrt(G / COM_H_M);                 // 3.3015 /s
const X_MAX = COM_H_M * Math.sin(THETA_BAIL_RAD);       // 0.450 m
const SIGMA_RAW_REF = (REF_RAIL_W_M / 2) / BOARD_LEN_M; // 0.06452 m/m
// The single balance dial, solved for (section 4). L/D is independent of it,
// so RESIDUAL only rescales bail time — which is what makes it one dial.
const RESIDUAL = Math.log(1 + OMEGA_P * X_MAX / (SIGMA_RAW_REF * V_BAL_REF))
  / (OMEGA_P * T_BAIL_CHOICE);                          // 0.08317
const LAMBDA_B = RESIDUAL * OMEGA_P;                    // 0.2746 /s
const BAL_GAIN = LEG_SWEEP_MPS / X_MAX;                 // 3.111 /s
const K_PULL_REF = LEG_SWEEP_MPS / (REF_RAIL_W_M / 2);  // 14 /s (reported)

const LAMBDA_RAIL = 0.5 * AIR_RHO * CDA_M2 * V_REF_GRIND / RIDER_MASS_KG;
const DRAG_SCALE = LAMBDA_RAIL / PH_LAMBDA_LONG;        // 0.343 (<1, contract)
const F0_RAIL = PH_MU_BASE * G;                         // 0.2992 m/s^2
const T_BOOST = PH_V_BOOST * PH_LAMBDA_LONG + F0_RAIL;  // 7.228 m/s^2

const MIN_LOCK_V = Math.sqrt(2 * PH_MU_BASE * G * BOARD_LEN_M); // 0.963 m/s
// Below this, Coulomb friction alone stops the board inside its own length:
// it is not sliding, so it is not grinding.
const CAPTURE_R = CAPTURE_BOARDLEN_FRAC * BOARD_LEN_M;  // 1.163 m
// Tightest holdable curvature at the reference speed: full stick must be able
// to answer the curvature forcing, BAL_GAIN >= OMEGA_P*|b_eq|.
const KAPPA_MAX_REF = G * Math.tan(THETA_BAIL_RAD * Math.min(1, BAL_GAIN / OMEGA_P))
  / (V_BAL_REF * V_BAL_REF);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { a = a % (2 * Math.PI); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

// Exact flow of dv/dt = a - b*v over dt, and the exact integral of v dt over
// the same step. Both closed form.
function flowSpeed(v0, a, b, dt) {
  if (b <= 1e-12) return v0 + a * dt;
  const veq = a / b;
  return veq + (v0 - veq) * Math.exp(-b * dt);
}
function flowDist(v0, a, b, dt) {
  if (b <= 1e-12) return v0 * dt + 0.5 * a * dt * dt;
  const veq = a / b;
  return veq * dt + (v0 - veq) * (-Math.expm1(-b * dt)) / b;
}
// Speed AND distance over one step for dv/dt = a - b*v, v0 >= 0, held inside
// [0, vmax]. The saturation instants are solved analytically rather than
// clamped after the fact, so the pair stays split-step exact even when the
// step crosses the speed cap (boost) or the Coulomb stop. Clamping only the
// speed while integrating the unclamped distance was a real 0.1% over-advance
// during a boosted grind; solving the crossing removes it.
function longFlow(v0, a, b, dt, vmax) {
  if (v0 > vmax) v0 = vmax;
  if (b <= 1e-12) {
    const v = v0 + a * dt;
    if (v > vmax || v < 0) {
      const tc = a !== 0 ? ((v > vmax ? vmax : 0) - v0) / a : dt;
      const tk = clamp(tc, 0, dt);
      const vEnd = v > vmax ? vmax : 0;
      return { v: vEnd, s: v0 * tk + 0.5 * a * tk * tk + vEnd * (dt - tk) };
    }
    return { v, s: v0 * dt + 0.5 * a * dt * dt };
  }
  const veq = a / b;
  if (veq > v0) {                       // accelerating toward veq
    // v0 <= vmax, not v0 < vmax: once the speed sits exactly ON the cap the
    // crossing time is 0 and the whole step travels at vmax. The strict
    // inequality let a saturated boosted grind fall through to the uncapped
    // distance integral and advance 0.1% too far every frame.
    if (veq > vmax && v0 <= vmax) {
      const tc = Math.log((v0 - veq) / (vmax - veq)) / b;
      if (tc < dt) { const tk = Math.max(tc, 0); return { v: vmax, s: flowDist(v0, a, b, tk) + vmax * (dt - tk) }; }
    }
    return { v: Math.min(flowSpeed(v0, a, b, dt), vmax), s: flowDist(v0, a, b, dt) };
  }
  if (veq < 0) {                        // decelerating through zero (Coulomb stop)
    const t0 = Math.log((v0 - veq) / -veq) / b;
    if (t0 < dt) return { v: 0, s: flowDist(v0, a, b, t0) };
  }
  return { v: flowSpeed(v0, a, b, dt), s: flowDist(v0, a, b, dt) };
}
// Time at which the (monotone increasing) distance integral first reaches
// target. Bisection: deterministic, derivative-free, converges to dt*2^-60.
function timeToDistance(v0, a, b, dt, vmax, target) {
  let lo = 0, hi = dt;
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi);
    if (longFlow(v0, a, b, mid, vmax).s < target) lo = mid; else hi = mid;
  }
  return 0.5 * (lo + hi);
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
    // Signed HORIZONTAL curvature per vertex: the turn angle between incoming
    // and outgoing segment directions over the mean of their lengths. Positive
    // = a left turn about +y, the same sense a positive `balance` leans.
    // Horizontal only: the centrifugal term in the rider's frame is what tilts
    // the pendulum; vertical curvature changes normal load, not lean.
    const kap = new Array(pts.length).fill(0);
    for (let i = 1; i < n; i++) {
      const a = seg[i - 1].u, b = seg[i].u;
      const ah = Math.hypot(a[0], a[2]) || 1, bh = Math.hypot(b[0], b[2]) || 1;
      const ax = a[0] / ah, az = a[2] / ah, bx = b[0] / bh, bz = b[2] / bh;
      const cross = az * bx - ax * bz;      // +y component of a x b
      const dotp = ax * bx + az * bz;
      const meanLen = 0.5 * (seg[i - 1].len + seg[i].len);
      kap[i] = meanLen > 1e-9 ? Math.atan2(cross, dotp) / meanLen : 0;
    }
    if (n >= 1) { kap[0] = kap[1] ?? 0; kap[n] = kap[n - 1] ?? 0; }
    return { id: r.id, pts, seg, cum, kap, length: cum[n],
      width: (typeof r.width === 'number' && r.width > 1e-6) ? r.width : REF_RAIL_W_M };
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
  // Horizontal left-normal of the tangent. For tangent +z this is +x, i.e. the
  // direction a positive `balance` leans.
  const lateralAt = (rail, s) => {
    const t = tangentAt(rail, s);
    const h = Math.hypot(t[0], t[2]) || 1;
    return [t[2] / h, 0, -t[0] / h];
  };

  // Closest point on one rail: the globally closest (for the disarm
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

  // Per-rail balance constants: the wander estimate scales with the rail's own
  // width, so a wide box is proportionally more forgiving than a handrail.
  const sigmaOf = rail => RESIDUAL * (rail.width / 2) / BOARD_LEN_M;
  const kPullOf = rail => LEG_SWEEP_MPS / (rail.width / 2);

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / LAMBDA_B,
    curveTolerance_rad: THETA_BAIL_RAD,   // the lean at which the grind is lost
    minLockSpeed_mps: MIN_LOCK_V,
    // --- balance plant (section 4) ---
    pendulumRate_hz: OMEGA_P,
    reflexResidual: RESIDUAL,             // the ONE dial, quoted via T_BAIL
    balanceDivergence_hz: LAMBDA_B,       // constant in v, by construction
    balanceLeanMax_m: X_MAX,
    balanceGain_hz: BAL_GAIN,
    railWander_mPerM: RESIDUAL * SIGMA_RAW_REF,   // at REF_RAIL_W_M
    passiveBailTimeRef_s: T_BAIL_CHOICE,          // at V_BAL_REF, constant v
    maxHoldableCurvatureRef_1pm: KAPPA_MAX_REF,   // at V_BAL_REF
    // --- longitudinal law (section 3) ---
    railCoulomb_mps2: F0_RAIL,
    railLambda_hz: LAMBDA_RAIL,
    snowLambda_hz: PH_LAMBDA_LONG,
    boostThrust_mps2: T_BOOST,
    speedCap_mps: PH_V_CAP,
    // --- rail constraint (section 5) ---
    railPullRate_hz: K_PULL_REF,                  // at REF_RAIL_W_M
    railSagRef_m: PH_G_AIR * (1 / 3600) / (-Math.expm1(-K_PULL_REF / 60)),
    // --- capture ---
    captureAlignMax_rad: ALIGN_MAX_RAD,
    boardLength_m: BOARD_LEN_M,
    comHeight_m: COM_H_M,
    // --- exit ---
    ollieJumpMin_mps: PH_J_MIN,
    ollieJumpMax_mps: PH_J_MAX,
    // --- declared conflict, section 6: this module CANNOT yaw the board ---
    headingFollow: false,
  };

  function init() {
    return {
      // contract-required
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability for the view / trick / HUD layers (read-only to them)
      s: 0, railLength: 0, railWidth: REF_RAIL_W_M,
      curvature: 0, leanEquilibrium: 0,
      tangentYaw: 0, boardYawError_rad: 0, lastLeaveYaw: 0,
      grindTime_s: 0, railSpinDeg: 0, lastExit: null,
      // internals
      _armed: true, _rail: null, _prewind: 0, _prevHeading: 0,
    };
  }

  // physics.mjs's takeoff() semantics, applied from here because ps.onGround is
  // already false during a grind so physics cannot run them itself (section 7).
  function takeoffReset(ps) {
    ps.airTime = 0;
    ps.spinDeg = 0; ps.flipDeg = 0;
    ps.spinCapped = false; ps.flipCapped = false;
    ps.landing = null;
  }

  // Release the rider: write the along-rail velocity back into physics, plus
  // whatever the exit adds. Speed is carried, never scrubbed (GR-04).
  function release(gs, ps, kind, extra) {
    const rail = gs._rail;
    const sc = clamp(gs.s, 0, rail.length);
    const tan = tangentAt(rail, sc);
    const v = gs.alongSpeed;
    ps.vel[0] = tan[0] * v + (extra ? extra[0] : 0);
    ps.vel[1] = tan[1] * v + (extra ? extra[1] : 0);
    ps.vel[2] = tan[2] * v + (extra ? extra[2] : 0);
    gs.lastLeaveSpeed = Math.abs(v);
    gs.lastLeaveYaw = Math.atan2(tan[2] * Math.sign(v || 1), tan[0] * Math.sign(v || 1));
    gs.boardYawError_rad = wrapPi(gs.lastLeaveYaw - ps.heading);
    gs.onRail = false;
    gs.railId = null;
    gs._rail = null;
    gs.lastExit = kind;
    gs.bailed = kind === 'bail';
    gs.balance = 0;
    gs.lockFrames = 0;
    takeoffReset(ps);            // leaving a rail IS a takeoff (section 7)
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
    // SS1.5: the capture test runs on contact, or airborne while descending.
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

    // ---- the ONE legal position write: the documented lock-on snap ----
    const P = pointAt(pick.rail, pick.s);
    ps.pos[0] = P[0]; ps.pos[1] = P[1]; ps.pos[2] = P[2];

    gs.onRail = true;
    gs.railId = pick.rail.id;
    gs._rail = pick.rail;
    gs.s = pick.s;
    gs.railLength = pick.rail.length;
    gs.railWidth = pick.rail.width;
    gs.t = pick.rail.length > 0 ? pick.s / pick.rail.length : 0;
    gs.alongSpeed = along;
    gs.balance = 0;
    gs.bailed = false;
    gs.lastExit = null;
    gs.lockFrames = 0;
    gs.grindTime_s = 0;
    gs.railSpinDeg = 0;
    gs._prewind = 0;
    gs._prevHeading = ps.heading;
    gs.curvature = curvatureAt(pick.rail, pick.s);
    gs.tangentYaw = Math.atan2(tan[2], tan[0]);
    gs.boardYawError_rad = wrapPi(gs.tangentYaw - ps.heading);
    // NO velocity write here. The caller falls straight through into the
    // on-rail update for this same frame, which advances s and writes the
    // constraint velocity for the new s.
    // MEASURED, THEN FIXED (cycle 1): writing vel = tangent*alongSpeed here
    // made physics advance the rider by alongSpeed*dt on the next tick while
    // gs.s had not moved, so the following frame's constraint velocity came
    // out ~0 — a one-frame dead stop, 0.28 m of lost travel, visible as a
    // hitch every time a rider touched a rail.
    return true;
  }

  // Advance the 1-D longitudinal state, splitting the step at polyline segment
  // boundaries where pitch(s) changes. Closed form inside every sub-step, so
  // one 100 ms step == ten 10 ms steps (GR-09) on SLOPED rails, not just flat.
  function advanceAlong(rail, s0, v0, dt, thrust) {
    const dir = v0 >= 0 ? 1 : -1;
    let v = Math.abs(v0), s = s0, remain = dt, ranOff = false;
    for (let guard = 0; guard < 64 && remain > 1e-15; guard++) {
      if ((dir > 0 && s >= rail.length) || (dir < 0 && s <= 0)) { ranOff = true; break; }
      const i = segIndexAt(rail, s);
      const sinPitch = rail.seg[i].u[1];                 // dy/ds, exact in-segment
      const a = -G * sinPitch * dir - F0_RAIL + thrust;
      const sEdge = dir > 0 ? rail.cum[i + 1] : rail.cum[i];
      const dsEdge = Math.abs(sEdge - s);
      const f = longFlow(v, a, LAMBDA_RAIL, remain, PH_V_CAP);
      if (dsEdge <= 1e-12 || f.s < dsEdge) {             // stays inside this segment
        v = f.v; s += dir * f.s; remain = 0;
        if (v <= 0) break;                               // Coulomb stop
        break;
      }
      const tc = timeToDistance(v, a, LAMBDA_RAIL, remain, PH_V_CAP, dsEdge);
      const fc = longFlow(v, a, LAMBDA_RAIL, tc, PH_V_CAP);
      v = fc.v; s = sEdge; remain -= tc;
      if (v <= 0) break;
    }
    if (s <= 0 || s >= rail.length) ranOff = true;
    return { s, v: dir * v, ranOff };
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

    // Observe (never write) the yaw physics applied this frame: rail spin.
    gs.railSpinDeg += wrapPi(ps.heading - gs._prevHeading) * 180 / Math.PI;
    gs._prevHeading = ps.heading;

    // ---- jumpRelease: leave PRESERVING speed (and prewind) -----------------
    if (inp.jumpRelease) {
      // Same legs as a snow ollie: physics' own charge->impulse law.
      const J = PH_J_MIN + clamp(ps.charge ?? 0, 0, 1) * (PH_J_MAX - PH_J_MIN);
      const pw = gs._prewind;
      release(gs, ps, 'jump', [0, J, 0]);
      // Contract: the exit carries prewind. physics only latches prewind in its
      // GROUND tick, and during a grind the rider is airborne as far as physics
      // is concerned, so nothing else can carry it.
      if (pw !== 0) ps.prewound = pw;
      return gs;
    }

    // ---- prewind charged ON the rail --------------------------------------
    if (inp.crouch && Math.abs(inp.spin ?? 0) > 0.3) gs._prewind = Math.sign(inp.spin);
    else if (!inp.crouch) gs._prewind = 0;

    // ---- longitudinal: closed form, segment-split, dt-exact (GR-09) -------
    const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
    const adv = advanceAlong(rail, s0, gs.alongSpeed, dt, boosting ? T_BOOST : 0);
    const v0 = gs.alongSpeed;
    gs.alongSpeed = adv.v;
    const ds = adv.s - s0;
    const sNew = adv.s;

    // A grind is not air (section 7).
    ps.airTime = 0; ps.spinDeg = 0; ps.flipDeg = 0;
    gs.grindTime_s += dt;

    // ---- ran off an end: leave carrying speed ------------------------------
    if (adv.ranOff) {
      gs.s = clamp(sNew, 0, rail.length);
      gs.t = rail.length > 0 ? gs.s / rail.length : 0;
      release(gs, ps, 'end', null);
      return gs;
    }

    // ---- balance: inverted pendulum about the curvature lean, closed form --
    // db/dt = LAMBDA_B*b - OMEGA_P*b_eq + drift - BAL_GAIN*steer
    // The curvature forcing is NOT scaled by RESIDUAL (section 4): a postural
    // reflex damps self-generated sway, it cannot carry a sustained side load.
    const vAbs = Math.abs(v0);
    const kap = curvatureAt(rail, s0);
    const bEq = Math.atan(kap * vAbs * vAbs / G) / THETA_BAIL_RAD;
    // Wander is per METRE of rail, so the step's drift impulse uses the metres
    // actually travelled. That makes the disturbance split-step consistent:
    // sum(sigma*ds_i)/X_MAX over sub-steps equals sigma*ds/X_MAX.
    const drift = dt > 0 ? DRIFT_SIGN * sigmaOf(rail) * (Math.abs(ds) / dt) / X_MAX : 0;
    const steer = clamp(inp.steer ?? 0, -1, 1);
    const c = -OMEGA_P * bEq + drift - BAL_GAIN * steer;
    const off = c / LAMBDA_B;
    const bNew = -off + (gs.balance + off) * Math.exp(LAMBDA_B * dt);
    gs.curvature = kap;
    gs.leanEquilibrium = bEq;

    if (Math.abs(bNew) > 1) {
      // Toppled. The CoM leaves with the lateral rate the model itself says it
      // has at this instant — no new constant.
      gs.s = sNew;
      gs.t = rail.length > 0 ? sNew / rail.length : 0;
      const nrm = lateralAt(rail, sNew);
      const vb = ((bNew - gs.balance) / dt) * X_MAX;
      release(gs, ps, 'bail', [nrm[0] * vb, 0, nrm[2] * vb]);
      return gs;
    }
    gs.balance = bNew;

    // ---- hold the rider on: FINITE-GAIN velocity constraint (section 5) ----
    // Feed-forward along the tangent at s0 plus a first-order pull toward
    // P(s0). Error decays exactly as e*exp(-K*dt): stable at any dt. Never
    // touches ps.pos or ps.heading (GR-07).
    const K = kPullOf(rail);
    const pull = (-Math.expm1(-K * dt)) / dt;
    const P0 = pointAt(rail, s0);
    const vff = ds / dt;
    ps.vel[0] = tan0[0] * vff + (P0[0] - ps.pos[0]) * pull;
    ps.vel[1] = tan0[1] * vff + (P0[1] - ps.pos[1]) * pull;
    ps.vel[2] = tan0[2] * vff + (P0[2] - ps.pos[2]) * pull;

    gs.s = sNew;
    gs.t = rail.length > 0 ? sNew / rail.length : 0;
    const tanN = tangentAt(rail, sNew);
    const sgn = gs.alongSpeed >= 0 ? 1 : -1;
    gs.tangentYaw = Math.atan2(tanN[2] * sgn, tanN[0] * sgn);
    gs.boardYawError_rad = wrapPi(gs.tangentYaw - ps.heading);
    gs.lockFrames++;
    return gs;
  }

  return { config, init, step };
}
