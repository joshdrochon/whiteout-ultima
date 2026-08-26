// Candidate B (cycle 3) — rail / grind system, SSX Tricky lane: rails
//
// ===========================================================================
// 0. WHAT CHANGED THIS CYCLE, AND WHY
// ===========================================================================
// The cycle-2 critique disqualified this line for writing ps.spinDeg /
// ps.flipDeg / ps.spinCapped / ps.flipCapped / ps.landing. That judgement is
// correct and I am not going to argue the naming: src/tricks/tricks.mjs reads
// phys.spinDeg (l.264, l.301), phys.flipDeg (l.264, l.302), phys.spinCapped and
// phys.flipCapped (l.267-268). Zeroing them 60 times a second during a grind
// deletes the trick system's only rotation input, and the mechanic it deletes
// is the one research 02 SS1.5 names: "keep on pressing that to do rail spins".
//
//   THIS MODULE NOW WRITES EXACTLY THREE THINGS INTO PHYSICS STATE:
//     * ps.vel        every on-rail frame (the constraint)  — permitted
//     * ps.pos        once per lock (the documented snap)   — permitted, GR-07
//     * ps.prewound   once, on a jumpRelease exit           — contract-required
//                     ("jumpRelease leaves the rail PRESERVING speed and
//                      prewind"); tricks.mjs never reads it.
//   Nothing else. No heading, ever. No rotation state, no landing verdict, no
//   air clock. Section 7 is the air-clock decision that replaces the one that
//   got this line disqualified.
//
// Two model corrections are also in this build and both are stated as
// corrections, not quietly swapped (sections 4 and 8):
//   * I was wrong about the curvature forcing coefficient. Cycle 2 entered it
//     at the FULL pendulum rate (OMEGA_P * b_eq) on a prose argument that a
//     postural reflex "cannot carry a static load". Doing the reduction
//     properly (section 4) gives LAMBDA_B * b_eq — a rate damper does not move
//     an equilibrium, it only slows the approach to it. The cycle-2 number was
//     12x too large and the prose was covering for it. Fixed, and the design
//     claim it supported ("a hard, derived speed/radius limit") is WITHDRAWN.
//   * Capture now seeds the balance state from the lateral closing speed, as
//     the singular-perturbation initial-slip of the same plant. Cycle 2 wrote
//     a comment about the CoM keeping its lateral momentum above code that
//     threw it away. Now the code does it, with no new constant.
//
// ===========================================================================
// 1. MODEL IN ONE PARAGRAPH
// ===========================================================================
// A grind is a 1-D problem wearing a 3-D costume. On lock-on the rider's 3-D
// state collapses to TWO scalars, both integrated in closed form:
//
//   s   arclength along the rail polyline            (ds/dt = alongSpeed)
//   b   balance: lateral CoM offset / bail offset    (inverted pendulum)
//
// The polyline is read for exactly four things: to find the capture point, to
// read the segment pitch (dy/ds) that drives s, to read signed horizontal
// curvature kappa(s) that loads the pendulum, and to place the rider. Nothing
// else about the 3-D world enters the grind. The rider is held on the rail by
// a FINITE-GAIN velocity constraint, not a position servo — see section 5.
//
// ===========================================================================
// 2. CONSTANT LEDGER — read this before believing any number below
// ===========================================================================
// Numbers come in four kinds and are never mixed. Anything not in this ledger
// is an equation over things that are.
//
// (a) CITED — project files / CONTRACTS.md / a physical constant.
// (b) RESEARCH — references/research/02-turning-edge-friction.md.
// (c) [EST] — an estimate, stated as an estimate, with the reasoning that
//     produced it. An equation over an estimate is still an estimate.
// (d) CHOICE — taste. Six of them, each with its cost written out.
//
// GATE WINDOWS ARE NOT INPUTS. No GR gate's pass band appears on the
// right-hand side of any expression in this file. (Cycle 1 caught this line
// citing GR-05's own 1.2-6 s window as if it were research and then inverting
// the balance ODE to land inside it. The one balance dial is now T_BAIL_CHOICE,
// labelled CHOICE, chosen for a stated design reason, and where it lands
// relative to GR-05 is reported in section 9 as a consequence.)
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
//   "keep on pressing that to do rail spins"                       SS1.5.
//
// --- (c) [EST] — estimates, called estimates ------------------------------
//   BOARD_LEN_M = RIDER_HEIGHT_M - 0.25 = 1.55 m   [EST]
//       Board sizing rule of thumb: the board reaches about chin height, i.e.
//       stature minus 20-25 cm. Not in the corpus; it is a sizing convention,
//       so it is an estimate, not a derivation.
//   COM_H_M = RIDER_HEIGHT_M / 2 = 0.90 m          [EST]
//       Standing whole-body CoM sits near 0.55*stature (0.99 m here); a grind
//       stance is crouched, which lowers it. 0.50*stature is the estimate.
//       Everything pendulum-shaped scales as 1/sqrt(COM_H), so a 10% error
//       here is a 5% error in OMEGA_P.
//   BOARD_WAIST_M = 0.25 m                         [EST]
//       Snowboard waist widths run about 24-26 cm. A sizing convention, not a
//       corpus number, so it is an estimate.
//   CDA_M2 = 0.5                                   [EST]
//       Drag area of an UPRIGHT rider. Sports-aero figures put a tucked
//       skier/boarder near 0.15-0.2 m^2 and an upright one near 0.5-0.7 m^2;
//       a grinding stance is upright, so the low end of the upright band.
//   RAIL_WANDER: the board's contact line migrates its own HALF-WAIST per
//       board-length of travel: sigma_raw = (BOARD_WAIST_M/2)/BOARD_LEN_M
//       = 0.0806 m/m.                                                 [EST]
//       Reasoning: the board re-seats about once per board length and cannot
//       be re-seated more precisely than its own edge-to-edge width. It is a
//       property of the BOARD, so it does not vary with the rail — see 4a for
//       why that matters and what the previous version of this estimate got
//       backwards.
//
// --- (d) CHOICE — taste, with costs ---------------------------------------
//   THETA_BAIL = 30 deg. The lean at which the board's contact patch leaves
//     the rail. It is a units choice as much as a feel choice: X_MAX, BAL_GAIN
//     and sigma all scale with it and the bail TIME is invariant to it.
//     COST: smaller reads as a twitchy meter pinned to its rails; larger reads
//     as mush. 30 deg is where a rider is visibly, legibly losing it.
//   LEG_SWEEP_MPS = 1.4. How fast the rider can sweep the board sideways under
//     the CoM at full stick — a hip-width 0.35 m shift in a quarter second.
//     COST: lower makes a leaning grind unrecoverable; higher makes balance
//     free and the mechanic decorative. It sets recovery authority and, via
//     K_PULL, how hard the board is held to the rail line.
//   T_BAIL_CHOICE = 3.0 s at V_BAL_REF on a 0.2 m rail. THE ONE BALANCE DIAL.
//     Physics does not supply it: a literally passive rider on a 0.9 m CoM
//     topples through 30 deg in 0.46 s, and SS1.5's "you EVENTUALLY will fall
//     off" rules that out — so the model must contain a postural loop, and the
//     residual gain of that loop is not derivable from anything in the corpus.
//     I chose the number the loop is quoted through.
//     WHY 3.0 AND NOT 1.5 OR 5: a bail must be a live threat inside a rail you
//     would actually author. 3.0 s at 18 m/s is 50 m of rail — long enough that
//     a short kink rail is free and a full handrail is a commitment.
//     COST: shorter turns every rail into a twitch minigame and makes long
//     rails unusable; longer makes the meter scenery on any rail under ~100 m.
//   ALIGN_MAX = 60 deg. Capture converts speed to along-rail speed (v cos a),
//     so at 60 deg capture would silently delete HALF the rider's speed.
//     "Half" is the taste: it is the point where a capture stops reading as a
//     grind and starts reading as a collision. COST: larger lets a near-
//     sideways slam become a clean grind; smaller makes rails feel like they
//     reject you. There is no sourced number for it. (It is not the only
//     alignment guard — see section 8; the other one is derived and is the
//     binding one at high speed.)
//   CAPTURE_BOARDLEN_FRAC = 0.75. Centre of SS1.5's [EST] 0.5-1.0 band. The
//     band is research; picking its centre is taste. COST: bigger rails vacuum
//     the rider in, smaller ones need pixel-accurate approaches.
//   DRIFT_SIGN = +1. See section 4 ("the stance asymmetry is not a bug").
//
// ===========================================================================
// 3. THE LONGITUDINAL LAW (s) — and why rails are faster than snow
// ===========================================================================
//   dv/dt = -g*sin(pitch(s))*dir - F0_RAIL - LAMBDA_RAIL*v  (+ T_BOOST)
//
//   F0_RAIL     = PH_MU_BASE * G. The Coulomb term is hard-low-friction
//                 sliding and is NOT what a rail changes (research 02 SS2 puts
//                 gliding mu at 0.03-0.1 for exactly this regime). What a rail
//                 removes is snow PLOUGHING, which lives in the linear term.
//   LAMBDA_RAIL = 0.5*AIR_RHO*CDA_M2*V_REF_GRIND/RIDER_MASS_KG. On snow the
//                 linear term lumps snow deformation and air together; a rail
//                 deletes the snow, so only the aerodynamic share survives.
//                 Linearised at V_REF_GRIND so it keeps the SAME functional
//                 form the accepted physics uses, a(v) = mu*g + lambda*v —
//                 which is what makes config.dragScale a meaningful ratio.
//                 COST: linear-in-v under-predicts air drag above 20 m/s and
//                 over-predicts below it; true drag is quadratic.
//                 This is a DERIVATION, not an analogy to another game's
//                 surface table: the ratio comes from deleting one physical
//                 loss channel, and it is falsifiable — if the accepted
//                 physics ever splits its own lambda into snow + air, this
//                 number must equal the air part.
//   dragScale   = LAMBDA_RAIL / PH_LAMBDA_LONG = 0.343  (<1, contract).
//   T_BOOST     = PH_V_BOOST*PH_LAMBDA_LONG + F0_RAIL. Boost is a THRUST, not
//                 a target speed: the thrust that reproduces the physics
//                 module's own snow boost speed. That same thrust against
//                 LAMBDA_RAIL would settle at 90 m/s, so a boosted grind pins
//                 to PH_V_CAP 33 > snow 31 — "you go faster boosting on a rail
//                 than boosting on the snow", derived rather than asserted.
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
// is exact on the gate's rail and wrong on every real one.
//
// ===========================================================================
// 4. THE BALANCE LAW (b) — the plant, the reduction, and the one dial
// ===========================================================================
// PLANT. A rider on a rail is an inverted pendulum: CoM at COM_H above a line
// contact, free-toppling rate OMEGA_P = sqrt(G/COM_H) = 3.302 /s. In lateral
// CoM offset x, with a rate-damping postural loop of gain C and a lateral base
// load a_lat (from curvature) and a contact-line disturbance:
//
//   x'' = OMEGA_P^2 * x  -  C * x'  -  a_lat            (+ disturbance)
//
// A pure RATE damper is the whole postural model. That is deliberate: a
// proportional term large enough to nearly cancel gravity would be an
// unsourced structure doing all the work, which is the failure mode this
// harness exists to catch. Rate damping is the one thing a reflex loop
// demonstrably does.
//
// REDUCTION. The roots of x'' + Cx' - OMEGA_P^2 x = 0 are
//   L_slow = (-C + sqrt(C^2 + 4*OMEGA_P^2))/2  ->  OMEGA_P^2 / C   (C >> OMEGA_P)
//   L_fast = -(C + sqrt(C^2 + 4*OMEGA_P^2))/2  ->  -C
// so for stiff damping the plant is one slow UNSTABLE mode plus one fast decay.
// Dropping x'' (singular perturbation) gives the first-order law this module
// integrates, in normalised b = x / X_MAX:
//
//   db/dt = LAMBDA_B * (b - b_eq)  +  drift  -  BAL_GAIN * steer
//   LAMBDA_B = OMEGA_P^2 / C  = RESIDUAL * OMEGA_P     [1/s, UNSTABLE]
//   b_eq     = atan(kappa * v^2 / G) / THETA_BAIL      [the lean the bend demands]
//   drift    = DRIFT_SIGN * SIGMA * v / X_MAX(w)       [1/s]
//   SIGMA    = RESIDUAL * sigma_raw                    [m of wander per m]
//   X_MAX(w) = COM_H*sin(THETA_BAIL) + w/2             [the bail offset, 4a]
//
// THE CURVATURE COEFFICIENT IS LAMBDA_B, NOT OMEGA_P — the cycle-2 correction.
// Substituting a_lat = v^2*kappa into the reduction gives db/dt term
// -a_lat/(C*X_MAX), and since X_MAX = COM_H*sin(THETA_BAIL) and
// b_eq ~ (a_lat/G)/THETA_BAIL, that term is exactly -LAMBDA_B*b_eq. A rate
// damper does not move an equilibrium; it slows the approach to it. Writing
// -OMEGA_P*b_eq (cycle 2) inflated the bend load by 1/RESIDUAL = 12x, which is
// how that build got a "derived speed/radius limit". The limit was an artefact.
// WITHDRAWN. What survives is weaker and true: a bend is a bias on the
// divergence, it is always answerable by steering, and the answer must be
// continuous — which is exactly what SS1.5 says ("you eventually will fall off
// for not turning"), and nothing more than that.
//
// LAMBDA_B does NOT depend on v. The v-dependence the design brief asks for
// enters twice and kinematically, never by assertion: drift is wander per
// METRE times metres per second (linear in v), and b_eq carries v^2. Nothing
// is pinned to the engine's speed clamp; PH_V_CAP appears in this module only
// as the speed clamp. (Cycle 1 caught this line tying the divergence rate to
// V_CAP. That coupling is gone and has not come back.)
//
// SOLVING FOR THE ONE DIAL. Straight rail, no steering: b(t) = (D/L)(e^{Lt}-1),
//   t_bail(v) = ln(1 + L/D) / L,   L = LAMBDA_B, D = drift.
// Both L and D carry the same RESIDUAL factor, so L/D = OMEGA_P*X_MAX /
// (sigma_raw*v) is INDEPENDENT of it, and RESIDUAL only rescales time — which
// is what makes it ONE dial rather than a pair:
//   RESIDUAL = ln(1 + OMEGA_P*X_MAX_REF/(sigma_raw*V_BAL_REF)) / (OMEGA_P*T_BAIL_CHOICE)
// = 0.08192. So the postural loop cancels 91.8% of the topple and of the
// wander and 8.2% survives; LAMBDA_B = 0.2704 /s (e-fold 3.70 s); SIGMA =
// 6.61 mm of residual wander per metre of rail.
//
// HONEST CAVEAT ON C. The implied damping is C = OMEGA_P/RESIDUAL = 40.3 /s,
// i.e. a 25 ms time constant. Long-latency postural reflexes in humans are
// nearer 100 ms, so C is NOT literal reflex physiology — it stands for board +
// boot + ankle mechanical damping AND the reflex together. Two consequences I
// am not going to hide: (i) 25 ms is only 1.5 frames at 60 Hz, so the fast mode
// is not cleanly separated from the timestep and the reduction is weakest
// during the first frame or two after a violent capture; (ii) C also sets the
// capture seed (section 8), so if a later feel pass changes T_BAIL it changes
// how much a sloppy entry hurts, in the same direction.
//
// WHAT |b| > 1 IS, AND WHAT IT IS NOT. It is a KINEMATIC bail: b is lean
// normalised by THETA_BAIL, so |b| > 1 means the CoM has passed the angle at
// which the board's contact patch leaves the rail. It is NOT a claim about
// recoverability, and I want that on the record because it is the class of
// claim this lane keeps losing candidates for. For THIS plant the recoverable
// set is easy to state and much larger: the law is first order, so full
// corrective steer holds any |b| <= BAL_GAIN/LAMBDA_B = 9.4 — a rider is
// mechanically recoverable nine bail-widths outside the bail line, and we drop
// them anyway because their board is no longer on the steel. There is no
// (b, b') switching curve here because there is no b' state: the fast mode was
// reduced out, and its only surviving trace is the capture seed. That is the
// price of the first-order model and it is stated, not sold as a theorem.
//
// STEERING. BAL_GAIN = LEG_SWEEP_MPS / X_MAX(w) = 2.545 /s on a 0.2 m rail,
// and positive steer REDUCES positive balance (the contract's convention,
// which rail-runner.mjs enforces). Under the runner's bang-bang probe
// (steer = sign(b)*S) this is a first-order sliding mode: b chatters inside
// +-BAL_GAIN*S*dt (0.034 at S=0.8, 60 Hz; measured max |b| 0.036) and holds
// forever. A property of the model, not a tuned outcome.
//
// A DESIGN DECISION THIS EXPOSES, FOR THE LANE OWNER. Because steer is a rate
// input with a lot of authority, holding a bend is cheap: the steady stick
// fraction needed at 18 m/s is 0.10 at R=400 m, 0.15 at R=100 m, 0.19 at
// R=57 m and 0.29 at R=20 m — against 0.085 just to cancel the stance drift on
// a straight rail. So bends are not a test of skill in this model, they are a
// test of ATTENTION, which is exactly the failure the source describes ("I kept
// grinding but didn't turn"). If a bend should also be physically demanding,
// the dial is LEG_SWEEP_MPS (a declared CHOICE) and the options are:
//   keep 1.4 m/s   bends are free to hold, the mechanic is remembering to steer
//   drop to ~0.5   full stick is needed near R=30 m at 18 m/s; a mistimed bend
//                  is unrecoverable, and straight-rail correction gets tense too
//                  (the same constant sets both)
//   split it       separate steer authority from the K_PULL scale, which costs
//                  one new constant and breaks "no new constants"
// My lean: keep 1.4. The source only ever claims that not turning drops you,
// and the second option makes straight rails worse to buy bend difficulty.
// It is a taste call and it is not mine to make; the number is one line.
//
// THE STANCE ASYMMETRY IS NOT A BUG. drift has a fixed sign, so one bend
// direction is harder than the other and an un-steered rider always falls the
// same way. A regular-footed rider IS asymmetric — heelside and toeside are
// not the same edge — and SSX riders have a stance, so this is a property to
// keep, not noise to randomise. It has a real consequence, measured in section
// 9: there is one bend radius per speed at which the bend load exactly cancels
// the stance drift and an un-steered rider holds. It is a single point in a
// continuum and a real grind decelerates off it within a frame, but it exists.
//
// ===========================================================================
// 4a. RAIL WIDTH — a mechanic that was pointing the wrong way
// ===========================================================================
// Cycles 1 and 2 of this line claimed "a wide box is proportionally more
// forgiving than a thin handrail — a mechanic, not a fudge". I measured it this
// cycle and it was FALSE IN THE CODE: bail time at 18 m/s ran 5.35 s on a 0.1 m
// rail and 0.92 s on a 1.0 m box. The wander estimate scaled with the rail's
// width, so a wider rail was a bigger disturbance and nothing else changed.
// Wrong sign, and the prose was covering for it for two cycles.
//
// Fixed by putting the width where it belongs. Two separate facts:
//   * the DISTURBANCE is the board re-seating itself, so its scale is the
//     BOARD's waist, not the rail's width. SIGMA is now width-independent.
//   * the BAIL OFFSET grows with the rail. On a line contact the rider topples
//     about the contact line and the offset is COM_H*sin(THETA_BAIL). On a box
//     the support is a polygon of width w, so the unstable pivot is its
//     downhill EDGE, w/2 further out:  X_MAX(w) = COM_H*sin(THETA_BAIL) + w/2.
// X_MAX(w) then rescales everything b is measured in — the drift, the steer
// gain BAL_GAIN = LEG_SWEEP/X_MAX(w), and the capture seed — consistently.
//
// SIMPLIFICATION, DECLARED: a real support polygon gives STATIC stability
// inside it (no toppling at all while the CoM is over the box), i.e. a
// dead-band, not a wider bail line. I lump it into the offset instead, which
// keeps the law first-order and closed-form and gets both limits right (w -> 0
// is exactly the line-contact pendulum; a wide box is proportionally harder to
// fall off). COST: inside the dead-band the model still diverges, slowly, so a
// very wide box is forgiving but never free. Modelling the dead-band properly
// means a piecewise ODE and I judged the closed form worth more.
// MEASURED after the fix, straight rail, no input, 18 m/s: 3.25 s at w=0.1,
// 3.47 s at w=0.2, 4.08 s at w=0.5, 4.95 s at w=1.0. Correct direction, and
// mild — width is a texture, not a difficulty switch.
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
//     below the rail line and rides there, loaded against it.
//   * lateral, straight rail: 0.000 mm. Nothing to fight.
//   * lateral, 40 m-radius bend at 18 m/s: single-digit mm, section 9.
//   That is small and I am not going to dress it up: a rail is a stiff
//   constraint, and the visible fight belongs to the balance meter, not to the
//   board wandering off the steel. What the finite gain buys is that the pull
//   is a force with a rate — so a stronger disturbance (a rider clipped
//   mid-grind, a rail that kinks) produces a visible recovery instead of a
//   teleport, and K is a legible knob for the feel pass.
//
// ===========================================================================
// 6. GR-07 IS ABSOLUTE — and the one thing that costs
// ===========================================================================
// This module never writes ps.heading and writes ps.pos only for the lock-on
// snap, exactly once per lock. The cost is real and cycle 1 measured it: the
// board is never yawed to the rail, so after a bend the exit heading is far
// from the velocity vector and physics.mjs's land() labels the next touchdown
// 'sketchy' (8% speed loss), or 'crash' past CRASH_YAW = 90 deg. Riding a curve
// well is punished.
//
// BOTH candidates escalated this in cycle 2 and the cycle-2 critique ruled it
// the lane's blocker, to be resolved at gate level and NOT re-litigated inside
// a module. So: not re-litigated. This module stays clean, publishes
// gstate.tangentYaw / gstate.boardYawError_rad / gstate.lastLeaveYaw live every
// frame, and reports its own number in section 9(i) so the gate owner has the
// current magnitude. The two one-line resolutions on the table are unchanged:
//   (i)  GR-07 gains a documented exception — heading may follow the rail
//        tangent while gstate.onRail — with a CURVED probe added so the
//        exception cannot be abused; or
//   (ii) physics.mjs's land() treats a touchdown whose air window began at a
//        rail exit as yaw-aligned (this module publishes everything needed).
//
// ===========================================================================
// 7. THE AIR CLOCK — the decision, reversed and stated (cycle-1 + cycle-2)
// ===========================================================================
// Cycle 1 said "airTime and spinDeg accumulate across the whole grind — needs a
// decision, not a comment." Cycle 2 decided it inside the module by zeroing
// those fields, and that decision was disqualifying. Reversed. The decision now:
//
//   THE MODULE PUBLISHES THE GRIND WINDOW. IT DOES NOT WRITE PHYSICS STATE.
//
// Taken field by field, because they are not the same question:
//
//   * ps.spinDeg / ps.flipDeg: LEFT ALONE, ON PURPOSE, and this is the part I
//     had backwards. During a grind physics.mjs sees an airborne rider, so
//     input.spin rotates ps.heading and banks ps.spinDeg. That IS the rail
//     spin — SS1.5: "keep on pressing that to do rail spins" — and rail spins
//     score in SSX. Zeroing them does not clean up the trick state, it deletes
//     the mechanic. The trick lane already has everything it needs to label
//     them rail spins rather than air spins: gstate.onRail is live, and this
//     module additionally accumulates gstate.railSpinDeg by OBSERVING the
//     frame's heading delta (read-only; the module never writes heading).
//   * ps.landing / ps.spinCapped / ps.flipCapped: LEFT ALONE. Verdict and cap
//     state belong to physics and to the trick lane.
//   * ps.airTime: LEFT ALONE, AND THIS ONE IS STILL WRONG AS SHIPPED. Physics
//     counts the grind as air because ps.onGround is false throughout, so a 6 s
//     grind reads as 6 s of airTime to any consumer that does not check
//     gstate.onRail. I publish gstate.grindTime_s and gstate.airTimeAtLock_s so
//     the fix is one line in the consumer, and I name the consumers rather than
//     leave it vague: nothing in src/tricks/tricks.mjs reads phys.airTime today
//     (it reads spinDeg, flipDeg, spinCapped, flipCapped, onGround only), so
//     the live risk is the HUD/camera lanes and any future air-trick timing.
//   RECOMMENDED RESOLUTION for the lane owner, one line, in physics or in the
//   consumer, NOT here: treat `!onGround && rails.onRail` as its own state.
//   COST of doing it my way: until someone takes that line, a HUD that shows
//   air time will show it climbing during a grind.
//   COST of doing it the cycle-2 way (writing the fields): rail spins stop
//   existing. That trade is not close, which is why this reversed.
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
//   * distance <= captureRadius_m and |alongSpeed| >= minLockSpeed_mps.
//   * TWO ALIGNMENT GUARDS, one taste and one derived:
//       (1) |velocity vs tangent| <= ALIGN_MAX = 60 deg (CHOICE: at 60 deg
//           capture already deletes half the rider's speed).
//       (2) the capture seed must be inside the bail line, |b0| < 1. A capture
//           that is already a bail is not a capture, it is a collision.
//     Guard (2) is derived and is the BINDING one at speed, because b0 grows
//     with the lateral closing speed: the effective alignment limit is
//     asin(X_MAX(w)*C/v) — guard 1 binds up to 25.6 m/s on a 0.2 m rail, then
//     guard 2 takes over and reaches 42 deg at PH_V_CAP. Arriving fast means
//     arriving straight. That falls out of the plant; no new constant.
//   * THE CAPTURE SEED (cycle-2 correction). At capture the board is snapped
//     to the rail but the CoM keeps the lateral velocity it arrived with. For
//     the plant of section 4 an impulsive x'(0) = v_lat is absorbed by the fast
//     mode within ~1/C and leaves the slow mode offset by exactly v_lat / C:
//         b0 = (v_lat / X_MAX) / C_REFLEX,     C_REFLEX = OMEGA_P / RESIDUAL
//     So a hard sideways arrival IS a balance emergency and a clean one is not,
//     with no new constant and no invented "landing quality" term. Cycle 1
//     tried the rigid-body version of this (b0 = v_lat/(X_MAX*LAMBDA_B), i.e.
//     divided by the SLOW rate) and measured b0 = -8.1 on a 20 deg approach:
//     an instant unplayable bail, and it was abandoned. It was wrong because
//     it fed an impulse into the slow mode — it overstates the seed by
//     C/LAMBDA_B = 149x. Dividing by C is the correct initial slip and gives
//     0.28 for the same approach at 18 m/s.
//   * DISARM: a BAIL disarms capture until the rider has left the capture tube.
//     Without it the rider bails, lands under the rail still inside the capture
//     radius, and re-locks forever.
//     COST (stated, not hidden): on a perfectly straight rail with the rider's
//     velocity exactly along it, the bailed rider slides underneath and can
//     never re-arm. On any rail that bends, or any rider whose heading is not
//     exactly the rail's, the two diverge within a second. A time-based
//     cooldown would fix the degenerate case and needs a constant nobody can
//     source, so I did not add one.
//
// ===========================================================================
// 8a. LEAVING BY JUMPING (GR-04 + contract "preserves speed and prewind")
// ===========================================================================
// Exit velocity is tangent*alongSpeed plus a vertical pop. Two details that
// only show up if you actually drive the thing:
//   * THE CHARGE IS OURS. physics.mjs accumulates ps.charge in its GROUND tick
//     only, and a grinding rider is airborne to physics, so ps.charge is 0 for
//     the entire grind. Reading it would make every rail ollie a J_MIN tap.
//     The module runs physics' own law (dt / T_CHARGE, clamped) on its own
//     gs._charge while crouch is held on the rail and publishes it as
//     gs.railCharge. Measured pop off a flat rail: 2.03 m/s tapped, 4.94 at
//     0.85 s of crouch, 5.00 (J_MAX) saturated. No physics state written.
//   * THE COYOTE OVERLAP. A grind shorter than physics' COYOTE_POP window
//     (0.25 s) is still inside it, so physics' airStep pops the rider a few
//     lines before this module runs. Two bugs live there and both are handled
//     by reading ps._popDone / ps._coyoteCharge (observation): double-jumping,
//     and — the one I actually measured — the release overwriting ps.vel[1]
//     and DELETING physics' pop, which left a jump 0.05 s into a grind with
//     vel[1] = 0. The pop is now continuous across the boundary: 2.15 m/s at
//     0.05 s of crouch, 2.72 at 0.20 s, 2.95 at 0.27 s (past the window),
//     4.94 at 0.85 s.
//   * PREWIND: ps.prewound is set on the exit frame when the player prewound
//     on the rail. It is the one contract-required physics write and
//     src/tricks/tricks.mjs never reads it (physics uses it to pick the air
//     spin rate, which IS "carries prewind"). Measured: prewound = 1 out of a
//     crouch+spin grind, 0 otherwise.
//   * Horizontal speed loss across the exit frame: 0.08% (GR-04 allows 2%).
//
// ===========================================================================
// 9. MEASUREMENTS ON THIS BUILD — including what is still wrong
// ===========================================================================
// Gates: 9/9, hardFails 0. harness/rail-mutants.mjs still reports 8/8 caught
// with a clean baseline, so nothing here weakened the gate law.
//
// (i) THE WRITE AUDIT — the cycle-2 disqualification, checked by measurement
//     rather than by assertion. Every field of the physics state
//     (heading, onGround, charge, airTime, boostMeter, spinDeg, flipDeg,
//     landing, yawRate, prewound, carve, slipDeg, spinCapped, flipCapped) is
//     snapshotted before rl.step and compared after, every frame:
//       8 s grind with corrective steer, 480 frames:  0 fields changed.
//       6 s grind ending in a jumpRelease exit:       0 fields changed.
//       same grind with crouch+spin held (prewind):   prewound, 1 frame.
//       position writes: exactly 1 per lock. heading writes: 0.
//     So the only physics field this module ever changes, across every probe,
//     is ps.prewound on a prewound exit — the contract-required one (8a).
//
// (ii) GR-05, straight 400 m rail, no input. Identity is the CONSTANT-SPEED
//     closed form and nothing more; a real grind decelerates, so the drift
//     falls as it goes and every measured bail is LATER:
//       v0     identity  measured        v0     identity  measured
//        5 m/s  6.31 s    9.45 s         18 m/s  3.00 s    3.47 s
//        8 m/s  4.95 s    6.43 s         25 m/s  2.37 s    2.67 s
//       10 m/s  4.36 s    5.45 s         33 m/s  1.92 s    2.12 s
//       14 m/s  3.54 s    4.22 s
//     In GR-05's 1.2-6 s window for every entry speed from 10 m/s to the speed
//     clamp, monotonically sooner the faster you go. Below ~9 m/s the measured
//     bail runs past 6 s, because a grind that slow barely disturbs itself.
//     That is out of band on purpose, at speeds no gate probes.
//     Active hold: 580/580 frames over 10 s, max |b| 0.036 (predicted chatter
//     bound BAL_GAIN*0.8*dt = 0.034).
//
// (iii) GR-06, AND WHAT THE PROBE ACTUALLY MEASURES. On the harness's own
//     curved rail the rider bails at 5.65 s (the rail would not run out until
//     ~11 s, so this is a bail, not a run-off). But that rail's curvature is
//     essentially zero where the rider is fast: x = 28 sin(t*pi/2) has zero
//     second derivative at t=0, so max |b_eq| over the whole grind is 0.053.
//     What the probe is really measuring on that geometry is the 20 deg
//     misalignment at capture (seed b0 = -0.28) plus stance drift.
//     Curvature does bite on rails a designer would author. 18 m/s, no input,
//     constant-radius arcs, both bend directions (the spread is the stance
//     asymmetry of section 4):
//       straight 3.47 s | R=400 m 3.92/3.12 | R=200 m 4.48/2.82
//       R=100 m 6.17/2.37 | R=76 m 8.05/2.15 | R=57 m held-to-end/1.92
//       R=30 m 3.78/1.45
//     GATE NOTE for the owner: GR-06 would discriminate far better if it
//     compared time-to-drop on a curved rail against the same probe on a
//     straight one, instead of testing a boolean at t=10 s on a rail whose
//     curvature is smallest exactly where the rider is fastest.
//
// (iv) THE CANCELLATION POINT IS REAL AND IS NOT A BUG. Identity: b* = 0 when
//     the bend load exactly cancels the stance drift, kappa = 0.01313 /m,
//     i.e. R = 76.1 m at 18 m/s. Measured on 2.2-radian arcs bending toward the
//     drift: R=100 m 6.28 s, R=85 m 7.08 s, R=76 m 8.05 s, R=70 m 9.08 s,
//     R=60 m 13.45 s — a clear ridge at the predicted radius, and finite
//     everywhere because the grind decelerates off the cancellation point.
//
// (v) CAPTURE SEED vs approach angle (b0 at the lock frame; "rej" = the
//     capture was refused by one of the two guards in section 8):
//       approach  0    10    20    30    45    60    75 deg
//       12 m/s   0.00  0.10  0.19  0.27  0.37  0.44  rej
//       18 m/s   0.00  0.14  0.28  0.41  0.57  0.69  rej
//       25 m/s   0.00  0.20  0.39  0.57  0.79  0.96  rej
//       33 m/s   0.01  0.27  0.52  0.75  rej   rej   rej
//     A violent arrival and a perfect one are no longer the same grind, and
//     arriving fast forces you to arrive straight.
//
// (vi) HOLDING THE RIDER ON. Straight rail: vertical sag 8.68 mm (predicted
//     8.68), lateral error 0.0000 mm. R=40 m bend: mean total offset from the
//     polyline 9.5 mm, peak 16.5 mm (of which 8.7 mm is the sag). A 25 cm
//     sideways knock mid-grind recovers as 250 -> 198 -> 157 -> 124 -> 98 ->
//     78 -> 62 -> 49 -> 39 -> 31 -> 24 -> 19 mm, i.e. exactly e^{-K*dt} per
//     frame — a visible recovery over ~12 frames, not a teleport.
//
// (vii) RAIL WIDTH, after the section-4a fix: 3.25 s at w=0.1, 3.47 s at
//     w=0.2, 4.08 s at w=0.5, 4.95 s at w=1.0. Before the fix the same
//     sweep ran 5.35 / 3.47 / 1.70 / 0.92 s — backwards.
//
// (viii) A RAIL THAT DESCENDS. 120 m rail dropping 20 m: the rider locks,
//     follows it from y=20.29 down to y=0.37 tracking to 8.7 mm, holds the
//     full 6.78 s and leaves off the END, and gravity along the rail shows in
//     alongSpeed (18.11 -> 17.72 m/s over 120 m). The SAME rail laid flat takes
//     13.68 s. A rail that descends behaves like one; this is not a velocity
//     override holding altitude.
//
// (ix) dt-EXACTNESS ON A SLOPED RAIL. Same 120 m / -20 m rail, 12 segments:
//     1x100 ms vs 10x10 ms alongSpeed differ by 3.6e-15 (gate allows 1e-6).
//     The step crosses segment boundaries during that test, so this is the
//     segment split working, not a flat-rail freebie. The gate's own flat
//     probe reports exactly 0.
//
// (x) SPEED. GR-03: after 5 s at 20 m/s the rail rider is at 11.77 m/s and the
//     snow rider at 5.64 m/s. Boost: a boosted grind reaches PH_V_CAP 33.00 m/s
//     in 2.47 s; the same boost on snow settles at 31.00 m/s. Both from the
//     derived thrust, not a dialled target.
//
// (xi) THE DECLARED GR-07 COST, reproduced. 40 m-radius quarter circle,
//     18 m/s, corrective steer: the rider holds the whole 62.8 m arc and
//     leaves off the end with ps.heading 90.0 deg against a rail tangent of
//     0.8 deg — 89.2 deg of board yaw error, which is 0.8 deg short of
//     physics.mjs's CRASH_YAW. Section 6; escalated, not patched.
//
// (xii) THE AIR CLOCK, AS SHIPPED. Through a 5.67 s grind: ps.airTime 5.65 s
//     (physics counts the grind as air), gstate.grindTime_s 5.67,
//     gstate.airTimeAtLock_s 0.00. With spin held on the rail: ps.spinDeg
//     1095 deg and gstate.railSpinDeg 1095 deg — the rail spin exists and is
//     labelled, and the module wrote neither number. Section 7 is the decision.
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
const PH_T_CHARGE = 0.85;      // physics.mjs DEFAULTS.T_CHARGE (s to full)
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
const BOARD_WAIST_M = 0.25;                 // [EST] snowboard waist width
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
const LEAN_MAX_M = COM_H_M * Math.sin(THETA_BAIL_RAD);  // 0.450 m, line contact
// Bail offset on a rail of width w (section 4a). Line contact recovers
// LEAN_MAX_M exactly; a box adds its own support half-width.
const xMaxFor = w => LEAN_MAX_M + w / 2;
const X_MAX_REF = xMaxFor(REF_RAIL_W_M);                // 0.550 m
// Contact-line wander per metre of rail, BEFORE the reflex residual. Set by
// the BOARD's own geometry, not the rail's — see section 4a.
const SIGMA_RAW = (BOARD_WAIST_M / 2) / BOARD_LEN_M;    // 0.08065 m/m
// The single balance dial, solved for (section 4). L/D is independent of it,
// so RESIDUAL only rescales bail time — which is what makes it one dial.
const RESIDUAL = Math.log(1 + OMEGA_P * X_MAX_REF / (SIGMA_RAW * V_BAL_REF))
  / (OMEGA_P * T_BAIL_CHOICE);                          // 0.08191
const SIGMA = RESIDUAL * SIGMA_RAW;                     // 6.61 mm per m of rail
const LAMBDA_B = RESIDUAL * OMEGA_P;                    // 0.2704 /s (unstable)
const C_REFLEX = OMEGA_P / RESIDUAL;                    // 40.31 /s, = OMEGA_P^2/LAMBDA_B
const balGainFor = w => LEG_SWEEP_MPS / xMaxFor(w);     // 2.545 /s at 0.2 m
const K_PULL_REF = LEG_SWEEP_MPS / (REF_RAIL_W_M / 2);  // 14 /s (reported)
// Largest lateral closing speed whose capture seed is still inside the bail
// line (section 8, guard 2). Derived; binds above ~22 m/s on a 0.2 m rail.
const vLatMaxFor = w => xMaxFor(w) * C_REFLEX;          // 22.17 m/s at 0.2 m

const LAMBDA_RAIL = 0.5 * AIR_RHO * CDA_M2 * V_REF_GRIND / RIDER_MASS_KG;
const DRAG_SCALE = LAMBDA_RAIL / PH_LAMBDA_LONG;        // 0.343 (<1, contract)
const F0_RAIL = PH_MU_BASE * G;                         // 0.2992 m/s^2
const T_BOOST = PH_V_BOOST * PH_LAMBDA_LONG + F0_RAIL;  // 7.228 m/s^2

const MIN_LOCK_V = Math.sqrt(2 * PH_MU_BASE * G * BOARD_LEN_M); // 0.963 m/s
// Below this, Coulomb friction alone stops the board inside its own length:
// it is not sliding, so it is not grinding.
const CAPTURE_R = CAPTURE_BOARDLEN_FRAC * BOARD_LEN_M;  // 1.163 m

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
    // = a turn toward the rail's left-normal, the same sense a positive
    // `balance` leans. Horizontal only: the centrifugal term in the rider's
    // frame is what tilts the pendulum; vertical curvature changes normal
    // load, not lean.
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
    const width = (typeof r.width === 'number' && r.width > 1e-6) ? r.width : REF_RAIL_W_M;
    return { id: r.id, pts, seg, cum, kap, length: cum[n], width,
      xMax: xMaxFor(width), balGain: balGainFor(width), vLatMax: vLatMaxFor(width) };
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

  // Per-rail balance constants. The disturbance SIGMA is width-independent
  // (board geometry); the bail offset, the steer gain and the capture limit
  // all widen with the rail, so a box is more forgiving than a handrail —
  // section 4a, and measured in section 10(vii).
  const kPullOf = rail => LEG_SWEEP_MPS / (rail.width / 2);

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    // The balance mode is UNSTABLE, so this is a doubling time, not a decay
    // half-life. Named per the contract; sign stated so nobody reads it as damping.
    balanceHalfLife_s: Math.LN2 / LAMBDA_B,
    curveTolerance_rad: THETA_BAIL_RAD,   // the lean at which the grind is lost
    minLockSpeed_mps: MIN_LOCK_V,
    // --- balance plant (section 4) ---
    pendulumRate_hz: OMEGA_P,
    reflexResidual: RESIDUAL,             // the ONE dial, quoted via T_BAIL
    reflexDamping_hz: C_REFLEX,           // OMEGA_P^2 / LAMBDA_B (25 ms; see caveat)
    balanceDivergence_hz: LAMBDA_B,       // constant in v, by construction
    balanceLeanMax_m: X_MAX_REF,          // bail offset at REF_RAIL_W_M; per-rail
    balanceLeanLineContact_m: LEAN_MAX_M, // the w -> 0 limit
    balanceGain_hz: balGainFor(REF_RAIL_W_M),
    // Full-steer static hold limit. NOT the bail line (which is |b| > 1, a
    // kinematic fact); this is how far outside it a rider is still recoverable.
    balanceRecoverableTo: balGainFor(REF_RAIL_W_M) / LAMBDA_B,
    railWander_mPerM: SIGMA,                      // width-independent (board geometry)
    passiveBailTimeRef_s: T_BAIL_CHOICE,          // at V_BAL_REF, constant v
    // --- longitudinal law (section 3) ---
    railCoulomb_mps2: F0_RAIL,
    railLambda_hz: LAMBDA_RAIL,
    snowLambda_hz: PH_LAMBDA_LONG,
    boostThrust_mps2: T_BOOST,
    speedCap_mps: PH_V_CAP,
    // --- rail constraint (section 5) ---
    railPullRate_hz: K_PULL_REF,                  // at REF_RAIL_W_M
    railSagRef_m: PH_G_AIR * (1 / 3600) / (-Math.expm1(-K_PULL_REF / 60)),
    // --- capture (section 8) ---
    captureAlignMax_rad: ALIGN_MAX_RAD,           // CHOICE guard
    captureLatSpeedMax_mps: vLatMaxFor(REF_RAIL_W_M), // derived guard, per-rail
    boardLength_m: BOARD_LEN_M,
    boardWaist_m: BOARD_WAIST_M,
    comHeight_m: COM_H_M,
    // --- exit ---
    ollieJumpMin_mps: PH_J_MIN,
    ollieJumpMax_mps: PH_J_MAX,
    // --- declared conflict, section 6: this module CANNOT yaw the board ---
    headingFollow: false,
    // --- section 7: what this module does NOT write, declared for consumers ---
    writesAirTime: false,
    writesRotationState: false,
  };

  function init() {
    return {
      // contract-required
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability for the view / trick / HUD layers (read-only to them)
      s: 0, railLength: 0, railWidth: REF_RAIL_W_M,
      curvature: 0, leanEquilibrium: 0, captureLean: 0,
      tangentYaw: 0, boardYawError_rad: 0, lastLeaveYaw: 0,
      // the grind window (section 7): consumers subtract, this module never writes
      grindTime_s: 0, airTimeAtLock_s: 0, lastExitAirTime_s: 0, railCharge: 0,
      railSpinDeg: 0, lastExit: null,
      // internals
      _armed: true, _rail: null, _prewind: 0, _charge: 0, _prevHeading: 0,
    };
  }

  // Release the rider: write the along-rail velocity back into physics, plus
  // whatever the exit adds. Speed is carried, never scrubbed (GR-04).
  // ps.vel is the ONLY physics field this touches (plus ps.prewound at the
  // jumpRelease call site, which the contract requires).
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
    gs.lastExitAirTime_s = ps.airTime ?? 0;   // observed, for the trick lane
    gs.onRail = false;
    gs.railId = null;
    gs._rail = null;
    gs.lastExit = kind;
    gs.bailed = kind === 'bail';
    gs.balance = 0;
    gs.lockFrames = 0;
    if (kind === 'bail') gs._armed = false;   // must leave the tube to re-lock
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
    // Guard 1 (CHOICE): a capture may not delete more than half the speed.
    if (Math.abs(along) / Math.max(speed3, 1e-9) < Math.cos(ALIGN_MAX_RAD)) return false;
    // Guard 2 (derived): the CoM keeps the lateral closing speed; the fast mode
    // of the plant absorbs it into an immediate lean of v_lat/C (section 8).
    // A capture whose seed is already outside the bail line is a collision.
    const nrm = lateralAt(pick.rail, pick.s);
    const vLat = ps.vel[0] * nrm[0] + ps.vel[2] * nrm[2];
    const b0 = (vLat / pick.rail.xMax) / C_REFLEX;
    if (Math.abs(b0) >= 1) return false;

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
    gs.balance = b0;
    gs.captureLean = b0;
    gs.bailed = false;
    gs.lastExit = null;
    gs.lockFrames = 0;
    gs.grindTime_s = 0;
    gs.railSpinDeg = 0;
    gs.airTimeAtLock_s = ps.airTime ?? 0;   // observed, never written
    gs._prewind = 0;
    gs._charge = 0;
    gs.railCharge = 0;
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
        break;
      }
      const tc = timeToDistance(v, a, LAMBDA_RAIL, remain, PH_V_CAP, dsEdge);
      const fc = longFlow(v, a, LAMBDA_RAIL, tc, PH_V_CAP);
      v = fc.v; s = sEdge; remain -= tc;
      if (v <= 0) break;                                 // Coulomb stop
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

    // OBSERVE (never write) the yaw physics applied this frame. During a grind
    // physics treats the rider as airborne, so input.spin turns the board:
    // that is the rail spin (SS1.5), and this is the module reporting it, not
    // producing it. ps.heading is read here and nowhere written.
    gs.railSpinDeg += wrapPi(ps.heading - gs._prevHeading) * 180 / Math.PI;
    gs._prevHeading = ps.heading;

    // ---- jumpRelease: leave PRESERVING speed (and prewind) -----------------
    if (inp.jumpRelease) {
      // Same legs as a snow ollie: physics' own charge->impulse law. The
      // charge is the module's own (gs._charge), NOT ps.charge: physics only
      // accumulates charge in its GROUND tick, and a grinding rider is
      // airborne to physics, so ps.charge is pinned at 0 for the whole grind.
      // Reading it would make every rail ollie a J_MIN tap. Accumulating our
      // own with physics' own T_CHARGE law gives the rail the same
      // crouch-to-pop the snow has, without writing physics state.
      const jFull = PH_J_MIN + clamp(gs._charge ?? 0, 0, 1) * (PH_J_MAX - PH_J_MIN);
      // A grind shorter than physics' coyote window (COYOTE_POP = 0.25 s) is
      // still inside it, so physics' own airStep popped the rider a few lines
      // before this ran and ps._popDone records it. Reading that (observation
      // only) is what stops a short grind from double-jumping — and what stops
      // the release below from silently DELETING physics' pop by overwriting
      // ps.vel[1]. Measured before this branch existed: a jump 0.05 s into a
      // grind left the rider with vel[1] = 0. Now the two add to exactly
      // jFull, whatever physics already contributed.
      const alreadyPopped = ps._popDone === true;
      const jPhys = alreadyPopped
        ? PH_J_MIN + clamp(ps._coyoteCharge ?? 0, 0, 1) * (PH_J_MAX - PH_J_MIN) : 0;
      const vyPre = ps.vel[1];
      const pw = gs._prewind;
      release(gs, ps, 'jump', [0, alreadyPopped ? 0 : jFull, 0]);
      if (alreadyPopped) ps.vel[1] = vyPre + Math.max(0, jFull - jPhys);
      // Contract: the exit carries prewind. physics only latches prewind in its
      // GROUND tick, and during a grind the rider is airborne as far as physics
      // is concerned, so nothing else can carry it. ps.prewound is not trick
      // state — src/tricks/tricks.mjs never reads it; physics uses it to pick
      // the air spin rate, which is exactly the "carries prewind" requirement.
      if (pw !== 0) ps.prewound = pw;
      return gs;
    }

    // ---- crouch charge + prewind, ON the rail (physics' own laws) ----------
    if (inp.crouch) {
      gs._charge = clamp((gs._charge ?? 0) + dt / PH_T_CHARGE, 0, 1);
      if (Math.abs(inp.spin ?? 0) > 0.3) gs._prewind = Math.sign(inp.spin);
    } else { gs._charge = 0; gs._prewind = 0; }
    gs.railCharge = gs._charge;

    // ---- longitudinal: closed form, segment-split, dt-exact (GR-09) -------
    const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
    const adv = advanceAlong(rail, s0, gs.alongSpeed, dt, boosting ? T_BOOST : 0);
    const v0 = gs.alongSpeed;
    gs.alongSpeed = adv.v;
    const ds = adv.s - s0;
    const sNew = adv.s;
    gs.grindTime_s += dt;

    // ---- ran off an end: leave carrying speed ------------------------------
    if (adv.ranOff) {
      gs.s = clamp(sNew, 0, rail.length);
      gs.t = rail.length > 0 ? gs.s / rail.length : 0;
      release(gs, ps, 'end', null);
      return gs;
    }

    // ---- balance: slow mode of the rate-damped pendulum, closed form -------
    // db/dt = LAMBDA_B*(b - b_eq) + drift - BAL_GAIN(w)*steer      (section 4)
    // b_eq is the lean the bend demands; the coefficient on it is LAMBDA_B
    // (NOT OMEGA_P — a rate damper slows the approach to an equilibrium, it
    // does not move it; cycle-2 correction, section 0).
    const vAbs = Math.abs(v0);
    const kap = curvatureAt(rail, s0);
    const bEq = Math.atan(kap * vAbs * vAbs / G) / THETA_BAIL_RAD;
    // Wander is per METRE of rail, so the step's drift impulse uses the metres
    // actually travelled. That keeps the disturbance split-step consistent:
    // sum(SIGMA*ds_i)/X_MAX(w) over sub-steps equals SIGMA*ds/X_MAX(w).
    const drift = DRIFT_SIGN * SIGMA * (Math.abs(ds) / dt) / rail.xMax;
    const steer = clamp(inp.steer ?? 0, -1, 1);
    const c = -LAMBDA_B * bEq + drift - rail.balGain * steer;
    const off = c / LAMBDA_B;
    const bNew = -off + (gs.balance + off) * Math.exp(LAMBDA_B * dt);
    gs.curvature = kap;
    gs.leanEquilibrium = bEq;

    if (Math.abs(bNew) > 1) {
      // Toppled: the CoM passed THETA_BAIL, so the contact patch is off the
      // rail. The rider leaves with the lateral rate the model itself says
      // they have at this instant — no new constant.
      gs.s = sNew;
      gs.t = rail.length > 0 ? sNew / rail.length : 0;
      const nrm = lateralAt(rail, sNew);
      const vb = ((bNew - gs.balance) / dt) * rail.xMax;
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
