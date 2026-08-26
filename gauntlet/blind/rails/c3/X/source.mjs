// Candidate A — rail grinding (spline projection + inverted-pendulum balance)
// cycle 3
// ---------------------------------------------------------------------------
// WHAT THIS MODULE IS
//   Every frame the board is projected onto the rail polyline (closest point +
//   tangent + discrete curvature). Along-rail speed is its OWN state, advanced
//   in closed form (slope drive + boost thrust - rail friction). The board is a
//   compliant body hooked on the rail (state `e`, lateral). The rider is an
//   inverted pendulum standing on that board; the ONLY lateral force in the
//   whole model is the hook force, and that force is what drives the rider's
//   lean. The board is held on the rail through the VELOCITY channel only
//   (GR-07), by a finite-gain pull against a compliant reference.
//
// ===========================================================================
// WHAT CHANGED IN CYCLE 3, AND WHY (one line per critique item)
// ===========================================================================
//  [c2-1] BAIL TEST. "|balance| > 1 is the boundary of the recoverable set"
//         was an assumption wearing a theorem's clothes. It is now an actual
//         theorem about the actual plant, and gstate.balance is the coordinate
//         the theorem is about. See RECOVERABLE SET below. No new constant.
//  [c2-3] CAPTURE ALIGNMENT. Fixed, but NOT with a hand-picked angle: the
//         alignment limit IS the recoverable-set theorem, evaluated at the
//         arrival. A crossing the rider could not survive is not captured at
//         all — no snap, no one-frame "grind", no speed dump (cycle 2 turned an
//         18 m/s crossing at 85 deg into a 1.6 m/s grind; now it rides past at
//         full speed). Measured cone: recovers at 26 deg, refused at 30 deg.
//  [c2-4] "the COM keeps it" comment described code that was not there. It is
//         there now: gs._bv = vLat / W_CTRL, so a hard sideways arrival is a
//         real balance emergency. The 5 mm sway sign hack is gone.
//  [c2-5] SECOND BAIL CHANNEL was unreachable (the rider failed first at
//         R < ~95 m; the hook needed R < 33 m). Raising W_CTRL to its derived
//         value puts them in the right order, and the hook channel is now the
//         one that sets the STEADY cornering limit. MEASURED FIRING: on a
//         clothoid-entered bend at 30 m/s it bails with reason='hook' at
//         a_c = 10.6-11.2 m/s^2 while |balance| is 0.01-0.03 — the rider is
//         perfectly fine and the rail rips the board out. That is the mechanic.
//  [c2-6] BOOST was quoted in the citation block and never implemented. It is
//         implemented, with the thrust derived from the engine's own snow law.
//         Boosted grind 33.0 m/s vs boosted snow 31.0 m/s.
//  [c2-7] BEND ENVELOPE / W_CTRL. W_CTRL is no longer an outside-corpus CHOICE.
//         It is derived from the hook limit, which widens the envelope by 3.3x
//         (a_c 2.97 -> 9.81 m/s^2; measured: full steer rides out a 60 deg arc
//         down to R = 30 m at 18 m/s, and fails at R = 26 m, against R >= ~95 m
//         in cycle 2). The residual design decision is still put to the owner,
//         as a table, below.
//  [c2-8] Comment said "/ wHalf" where the code says W_CTRL. Fixed.
//  [c2-9] Rigid position servo -> finite-gain pull at the hook rate. A board
//         knocked 0.20 m off the line now returns over ~6 frames, not 1.
//  [c2-2] X's spinDeg/flipDeg/landing zeroing: not present here and never was.
//         This module's complete write list is enumerated below.
//
// ===========================================================================
// CONSTANTS — every one is an equation over a cited input, a CHOICE with its
// cost, or a measurement taken from env. There is no "derived" block of dials.
// ===========================================================================
//   G          = PHYS.G_GROUND (9.81)   src/physics/physics.mjs, imported, not
//                                       copied. A grind is CONTACT, so contact
//                                       gravity, not the aesthetic air gravity.
//   H_RIDER    = 1.8 m                  CONTRACTS.md ("rider 1.8 m / 80 kg").
//   COM_FRAC   = 0.55                   OUTSIDE-CORPUS CITATION: whole-body COM
//                                       at ~55% of stature (Winter, Biomechanics
//                                       and Motor Control of Human Movement,
//                                       segment tables). The corpus has no
//                                       anthropometry section. NOT load-bearing:
//                                       see the h_com sweep under BAIL TIME.
//   H_COM      = 0.99 m                 = H_RIDER * COM_FRAC.
//   LAMBDA_P   = sqrt(G/H_COM) = 3.148  inverted-pendulum divergence rate.
//                                       EQUATION, no free parameter, and
//                                       speed-INDEPENDENT: nothing in this model
//                                       is tied to the engine's V_CAP.
//   ZETA_B     = 1.0                    CHOICE (taste): damping ratio of the
//                                       rider's postural loop, expressed against
//                                       the only timescale in the problem, so it
//                                       adds no new number. COST: swept
//                                       0/0.5/1/2/4 -> passive bail
//                                       1.68/2.72/4.06/7.12/13.65 s, so any
//                                       zeta in [0, ~1.63] lands inside GR-05's
//                                       band. The gate does not pin it; taste
//                                       does. Lower = twitchier, faster bail.
//   SWAY_M     = 0.005 m                CHOICE (taste), anchored to quiet-
//                                       standing postural sway (COM RMS
//                                       excursion of order 5 mm; same outside-
//                                       corpus posturography family as
//                                       COM_FRAC). It is the seed of the
//                                       instability: a perfectly centred capture
//                                       would otherwise ride forever, which is
//                                       true of an ideal pendulum and wrong for
//                                       a game. COST: bail time is LOGARITHMIC
//                                       in it — t = ln(W_CTRL/SWAY)/sigma — so
//                                       the whole seed window that lands inside
//                                       GR-05's 1.2-6 s band is 0.40 mm .. 207 mm,
//                                       a factor of 518. I did not invert the
//                                       gate to get it; I took the physical
//                                       anchor and then measured where it landed.
//   CAPTURE_R  = 1.0 m                  CHOICE inside a SOURCED band: research 02
//                                       §1.5 [EST] gives 0.5-1.5 m ("~0.5-1.0
//                                       board length"). 1.0 m is the band centre.
//                                       COST: larger = more forgiving and more
//                                       phantom-feeling; smaller = rails you
//                                       visibly clip but miss.
//   DRAG_SCALE = 0.20/0.35 = 0.5714     CITED RATIO + ACKNOWLEDGED ANALOGY, and
//                                       cycle 2 was right to call the previous
//                                       label ("sourced ratio, not a dial")
//                                       overclaimed. The ratio itself is
//                                       measured: Tux Racer terrains.lst ice mu
//                                       0.20 vs snow mu 0.35 (research 02 §3.1,
//                                       cloned and verified in the corpus), whose
//                                       own summary line is "ice grip ~0.57x snow
//                                       grip". Applying it to STEEL is an
//                                       analogy — the corpus contains no rail
//                                       friction figure at all. It is the
//                                       slickest measured surface in the family
//                                       and the direction is what §1.5 asserts.
//                                       COST: the ratio only has to satisfy
//                                       "rail < snow" (GR-03); it sets HOW much
//                                       faster. Measured margin at the gate:
//                                       9.65 m/s on rail vs 5.64 on snow after
//                                       5 s from 20 m/s. Lowering it widens that
//                                       margin; taking it to 1 kills
//                                       GR-03. The lane can retune it freely —
//                                       it is the one constant here that is a
//                                       feel dial with a sourced direction and
//                                       an unsourced magnitude.
//   OMEGA_C    = sqrt(G/W_half) = 9.90  HOOK stiffness. EQUATION: the rate at
//                                       which an unheld board topples off a rail
//                                       edge of half-width W_half. The hook must
//                                       answer exactly as fast as the escape it
//                                       prevents; that is the marginal,
//                                       non-arbitrary value. Doubles as the pull
//                                       gain (see COMPLIANCE) — the rail cannot
//                                       reassert itself faster than it can lose
//                                       you.
//   ZETA_C     = 1.0                    CHOICE. Critical damping of the hook.
//                                       COST: zeta<1 makes the board visibly
//                                       chatter on and off the rail line.
//   W_half     = rail.width/2           MEASURED FROM env (0.1 m for the harness
//                                       rails). Not a constant.
//   W_CTRL     = H_COM = 0.99 m         DERIVED (was an outside-corpus CHOICE;
//                                       cycle 2 mustFix 7). See below.
//   minLockSpeed = sqrt(2 G dy + V_STALL^2)   EQUATION: the kinetic energy needed
//                                       to climb onto the rail. dy is the actual
//                                       lift of THIS capture; the exported scalar
//                                       is the same law at the worst climb the
//                                       env's rails demand.
//   V_STALL    = MU_RAIL*G/LAMBDA_P     EQUATION: the speed rail friction kills
//                                       inside one balance time constant.
//                                       0.054 m/s — a grind that slow is a
//                                       standstill.
//   D_BOOST    = MU*G + LAMBDA*V_BOOST  EQUATION over the engine's own numbers.
//              = 7.228 m/s^2            See BOOST.
//
// ===========================================================================
// TWO LENGTH SCALES, AND WHY THEY ARE NOW LOCKED TOGETHER  [c2-7]
// ===========================================================================
//   W_half = rail.width/2 (0.1 m here)  — the BOARD's grip on the rail.
//   W_CTRL = 0.99 m                     — the RIDER's lateral control range:
//                                         the COM offset that full steer commands.
//
//   Cycle 2 set W_CTRL = 0.30 m from Horak & Nashner's hip strategy (outside
//   corpus) and the critic was right that the lane cannot ship it: it caps
//   sustained cornering at a_c = G*W_CTRL/H_COM = 2.97 m/s^2, i.e. R >= 109 m at
//   18 m/s, and it makes any misaligned arrival fatal (arrival cone +-7.3 deg at
//   18 m/s — narrower than the harness's OWN curved probe, which arrives 20.1 deg
//   off, so GR-06 would have measured the arrival instead of the curvature).
//
//   The replacement is a derivation, not a bigger guess. The board leaves the
//   rail when the corner demands more lateral acceleration than the hook can
//   supply, and that limit is fully derived: |e| > W_half <=> v^2*kappa > G
//   (because OMEGA_C^2 = G/W_half). So G is the largest lateral acceleration
//   that can exist in this system at all. Authority beyond it is unusable — the
//   board is gone before the rider needs it. Therefore
//       a_max := G,  and  W_CTRL := H_COM * a_max / G = H_COM.
//   The two channels are now marginal with each other by construction, which is
//   the same discipline OMEGA_C already follows. It also removes the
//   Horak & Nashner citation from the model entirely.
//
//   CONSEQUENCES, ALL MEASURED (probe numbers, not predictions):
//     control authority a_max     2.97 -> 9.81 m/s^2
//     holdable bend at 18 m/s     R >= ~95 m -> R >= 30 m  (60 deg arc, full
//                                 steer, entered tangentially: R = 30 ridden
//                                 out, R = 26 bails at the entry)
//     arrival cone at 18 m/s      +-7.3 deg -> +-26 deg (recovers at 26,
//                                 refused at 30)
//     passive bail (GR-05)        3.27 s -> 4.07 s  (band 1.2-6, still inside)
//     max lean before bail        16.9 deg -> 45.0 deg (curveTolerance_rad)
//     hook channel                unreachable -> fires at a_c = 10.6-11.2 m/s^2
//
//   RESIDUAL DECISION FOR THE LANE OWNER (I am not taking it):
//     option                         bend at 18 m/s   cost
//     ---------------------------    --------------   -------------------------
//     ship as derived (a_max = G)    R >= 30 m        a 45 deg lean is a
//                                                     motorcycle, not a
//                                                     snowboarder; the number is
//                                                     forced by the rail, not
//                                                     chosen for the rider
//     lean anticipation (look-ahead) R >= ~20 m       +1 new time constant, and
//       lean for the bend you can                     it softens GR-06 (the
//       see, not the one you are in                   curve stops punishing you)
//     accept gentle rails only       author R >= 60 m no code; the lane's rail
//                                                     geometry is constrained
//                                                     instead
//   MY LEAN: ship as derived. It is the only one of the three with no new number
//   in it; the envelope it produces (30 m radius at 65 km/h) is an authorable
//   rail; and anticipation is a mechanic that deserves its own gate rather than
//   arriving as a fix.
//
// ===========================================================================
// BALANCE LAW  (sign convention per CONTRACTS.md: positive steer reduces
// positive balance)
// ===========================================================================
//   b = x_com / W_CTRL          absolute normalized lean (internal, gs._b)
//   b'' = LAMBDA_P^2 * (b - u) - C_B * b' + F_hook          [u = steer, |u|<=1]
//     * LAMBDA_P^2 * b     inverted pendulum, unstable.
//     * -LAMBDA_P^2 * u    full steer commands the COM to the edge of the
//                          control range: a_max = G*W_CTRL/H_COM, which
//                          normalizes to exactly LAMBDA_P^2. The control gain is
//                          not a dial; it is the same length scale as the range,
//                          so the two are one number by construction.
//     * -C_B * b'          postural damping, C_B = 2*ZETA_B*LAMBDA_P.
//     * F_hook = (OMEGA_C^2 * e + 2*ZETA_C*OMEGA_C * e') / W_CTRL
//                          THE ONLY LATERAL FORCE IN THE MODEL. The rider stands
//                          on the board; the board is pushed only by the hook; so
//                          the rider's base acceleration IS the hook force. Note
//                          W_CTRL, not W_half — the two length scales are
//                          distinct and this term normalizes by the RIDER's.
//                          [c2-8: the cycle-2 comment said W_half; the code said
//                          W_CTRL. The code was right.]
//                          At steady state e = -v^2*kappa/OMEGA_C^2 and e' = 0,
//                          so F_hook = -v^2*kappa/W_CTRL — exactly the curvature
//                          term cycle 2 had, recovered as a special case. What is
//                          new is the transient, and the transient is where a
//                          crooked arrival lives.
//   Integrated in closed form (real distinct roots s1 = SIGMA_B, s2 = -S_FAST;
//   zero-order hold on the forcing, same order as before). Not Euler.
//
//   THE LEAN A CORNER DEMANDS (quasi-static, curvature only — deliberately NOT
//   the instantaneous F_hook, because a transient is a disturbance, not a demand):
//       b_lean = v^2*kappa / (LAMBDA_P^2 * W_CTRL) = a_c * H_COM / (G * W_CTRL)
//   Leaning into a corner is not falling, so the rider is judged on the
//   DEVIATION d = b - b_lean, not on b.
//
// ===========================================================================
// RECOVERABLE SET — the bail test, as an actual theorem  [c2-1]
// ===========================================================================
//   Cycle 2 bailed on |d| > 1 and called that "the boundary of the recoverable
//   set". It is not: |d| = 1 is where full steer holds STATIC equilibrium, which
//   is an identity by construction. The critic's counterexamples were both real
//   (d = 0.99 running outward is already gone; d = 1.2 running inward is fine).
//
//   The correct boundary, in closed form, for THIS plant:
//     d'' = LAMBDA_P^2*(d - u) - C_B*d',  |u| <= 1.
//     Roots: s1 = SIGMA_B = L*(sqrt(1+z^2) - z) > 0,
//            s2 = -S_FAST = -L*(sqrt(1+z^2) + z) < 0,
//            with s1*s2 = -L^2 and s1 + s2 = -C_B.
//     Change coordinates to the UNSTABLE MODE:   w := d + d'/S_FAST.
//     Then, identically,                          w' = SIGMA_B * (w - u).
//       (substitute d'' and use L^2 = SIGMA_B*S_FAST, C_B = S_FAST - SIGMA_B)
//     If |w| > 1 then |w| grows for every admissible u, without exception:
//       w > 1  =>  w' >= SIGMA_B*(w - 1) > 0. Gone.
//     If |w| <= 1 then u = sign(w) drives w monotonically to 0 and holds it.
//     So { |w| <= 1 } is EXACTLY the recoverable set. Not a bound, not an
//     approximation — the set.
//
//   THEREFORE gstate.balance = w. This is not a relabelling: the module now
//   bails on the correct set, so
//     * a rider at d = 0.99 with outward d' > 0.01*S_FAST bails (cycle 2 said
//       "fine"), and
//     * a rider at d = 1.2 with inward d' < -0.2*S_FAST does NOT bail (cycle 2
//       killed them).
//   Both were named as play consequences and both now behave correctly.
//   Positive steer still reduces positive balance (w' = SIGMA_B*(w - u)), so the
//   contract's sign convention is satisfied by the theorem itself.
//   The static-equilibrium limit |d| <= 1 is still exported, as
//   gstate.leanError, for a HUD that wants to show "how hard you are working".
//
//   BAIL TIME (GR-05's band, stated as the identity it is):
//     passive (u = 0, straight rail): w' = SIGMA_B*w exactly, so
//       t_bail = ln(W_CTRL / SWAY_M) / SIGMA_B = ln(198)/1.304 = 4.06 s.
//     This is a ZERO-CURVATURE identity, and it is genuinely speed-independent:
//     speed does not appear in the straight-rail balance law at all. MEASURED at
//     entry speeds 8 / 12 / 18 / 25 / 31 m/s the passive bail is 4.07 s at every
//     one of them, which is why the grind's own deceleration does not disturb it
//     (cycle 2 had to caveat this as a constant-speed identity; it does not need
//     the caveat once W_CTRL stops carrying a v-dependence). On a curved rail the
//     curvature term makes it earlier and the identity is an upper bound:
//     MEASURED aligned passive entry at 18 m/s gives 2.12 / 1.60 / 1.22 / 0.88 /
//     0.65 / 0.33 s at R = 400 / 200 / 120 / 80 / 60 / 40 m, against 4.07 s on a
//     straight rail — so GR-06's mechanic is real and graded, not a timer.
//     h_com sensitivity (W_CTRL follows h_com, so both move): 2.51 / 3.19 / 4.06
//     / 4.89 s at h_com = 0.5 / 0.7 / 0.99 / 1.3 m — all inside GR-05's band, so
//     the COM_FRAC citation is not load-bearing on the gate.
//
// ===========================================================================
// HOOK COMPLIANCE, AND WHAT CAPTURE DOES WITH A CROOKED ARRIVAL  [c2-3/4/5]
// ===========================================================================
//   The board is not pinned to the rail line. It hangs off it by a real
//   second-order state e (metres, lateral):
//       e'' = -OMEGA_C^2 * e - 2*ZETA_C*OMEGA_C * e' - v^2*kappa
//   steady state e* = -v^2*kappa/OMEGA_C^2: the board is dragged to the OUTSIDE
//   of every bend by the centripetal demand over the hook stiffness. If |e|
//   exceeds W_half the board itself is off the rail:
//       |e| > W_half  <=>  v^2*kappa > G.
//
//   WHICH CHANNEL DOES WHAT (the cycle-2 critique said the hook channel never
//   fires; both are now reachable and they do different jobs):
//     * BALANCE channel = TRANSIENTS. A steady bend needs no steering at all
//       once the lean is acquired (d_ss = u, so u = 0 holds any curvature), so
//       what the balance channel actually judges is whether you can acquire and
//       hold lean while the demand CHANGES — the bend entry, a crooked landing,
//       and the postural drift that ends every un-steered grind.
//     * HOOK channel = STEADY STATE. |e| > W_half <=> v^2*kappa > G is the
//       sustained cornering limit, and it is where the rail, not the rider,
//       gives up. MEASURED on a bend whose curvature ramps in over 80 m (so the
//       transient never triggers the balance channel), at 30-33 m/s: bails with
//       reason='hook', |e| = 99 mm of the 100 mm available, at
//       a_c = 10.6 / 11.0 / 11.1 / 11.2 / 11.2 m/s^2 for R = 100 / 90 / 80 / 70
//       / 60 m — a_c = G plus the overshoot of a critically damped second-order
//       hook — while |balance| reads 0.01-0.03. The rider is fine; the rail rips
//       the board out from under them. That is the mechanic, and it is now
//       something a player can meet.
//
//   CAPTURE (this is the [c2-3] fix, and it is not a hand-picked angle). A board
//   arriving at angle theta has cross-rail speed v_lat = v*sin(theta), and:
//     * THE HOOK CANNOT ABSORB IT. Peak excursion of a critically damped hook
//       started at (0, v_lat) is v_lat/(OMEGA_C*e) = v_lat/26.9, so anything past
//       e*sqrt(G*W_half) = 2.69 m/s (config.boardArrivalLimit_mps) exceeds the
//       hook's entire 0.1 m travel. That is below the harness's OWN curved probe
//       entry (6.18 m/s), so routing the arrival into the hook makes every curved
//       rail unrideable — I built that version first and measured it: the harness
//       curve locked for 2 frames whatever the player did. The rail is 0.2 m
//       wide; a board landing across it loses its sideways momentum to an
//       INELASTIC impact, not to a spring.
//     * THE RIDER TAKES THE IMPULSE. The rider is not bolted to the board, so
//       when the rail arrests it the COM keeps going: gs._bv = v_lat / W_CTRL,
//       which is exactly what [c2-4] asked for. In the recoverable coordinate
//       that is delta_w = v_lat / (S_FAST*W_CTRL) = v_lat / 7.52.
//     * THE ALIGNMENT LIMIT IS THE THEOREM, NOT A DIAL. Capture is refused when
//       the arriving state is already outside the recoverable set (|w0| > 1) —
//       you may only start a grind from a state you could still save. That is a
//       SPEED-DEPENDENT cone, +-26 deg at 18 m/s and +-70 deg at 8 m/s, which is
//       the right shape and which a fixed ALIGN_MAX (the sibling's 60 deg) is
//       not. MEASURED at 18 m/s with steering: 5/10/15/20/24/26 deg all lock and
//       hold the full probe; 30 deg is refused and the rider rides past with
//       full speed. Speed cost of a captured crooked landing is bounded by the
//       cone: 17.29 -> 17.16 m/s at 5 deg, 17.22 -> 16.12 at 20 deg, 0% aligned.
//       Cycle 2's 18 -> 1.6 m/s "grind" cannot happen: that arrival is refused.
//   WHAT THIS MODULE STILL CANNOT DO: author a crash. A refused capture means
//   the rider clips the rail and continues; whether hitting a rail sideways
//   should be a bail is trick-lane state and GR-07's neighbours forbid me to
//   write it. Flagged, not silently dropped.
//
// ===========================================================================
// COMPLIANCE / THE PULL  [c2-9]
// ===========================================================================
//   Cycle 1 called the position servo rigid; cycle 2 moved the rigidity down one
//   level (the REFERENCE became compliant, but ps.vel = (tgt - pos)/dt still
//   snapped the board onto that reference in one frame, so a knocked rider
//   teleported back). Now the board is pulled to the reference at a finite rate:
//       v_cmd = v_ref  +  (tgt - pos - v_ref*dt) * (1 - exp(-OMEGA_C*dt))/dt
//   which makes the residual tracking error decay EXACTLY as exp(-OMEGA_C*dt)
//   per step, dt-consistently, with the feed-forward v_ref carrying the motion
//   so there is no steady-state sag. The gain is not a new number: it is
//   OMEGA_C, the hook rate, and the argument is that the rail cannot pull you
//   back faster than it can lose you.
//   MEASURED: a 0.20 m mid-grind displacement decays 0.200 -> 0.170 -> 0.144 ->
//   0.122 -> ... , a per-frame ratio of 0.8478 against exp(-OMEGA_C/60) =
//   0.8478 (exact), reaching 1 mm after 33 frames = 0.55 s, half-life 70 ms,
//   with the rider staying on the rail throughout. Cycle 2 recovered in 1 frame.
//   Steady-state tracking residual with no disturbance: 0.0 m to double
//   precision on both the straight and the curved harness rail (the feed-forward
//   is exact), so compliance costs nothing when nothing is pushing.
//
// ===========================================================================
// BOOST  [c2-6]
// ===========================================================================
//   research 02 §1.5, verbatim: "You go faster boosting on a rail than boosting
//   on the snow." Cycle 2 quoted that line and never read input.boost. Now:
//     * the engine implements boost as relaxation to V_BOOST on snow. The THRUST
//       that implies is fixed by the engine's own flat-snow steady state:
//         D_BOOST = MU_BASE*G + LAMBDA_LONG*V_BOOST = 7.228 m/s^2.
//       No new constant — it is PHYS's numbers rearranged.
//     * the same thrust on the rail, where both resistive terms carry
//       DRAG_SCALE, gives terminal (D_BOOST - MU_RAIL*G)/LAM_RAIL = 55.3 m/s,
//       which the engine's own hard clamp V_CAP cuts to 33.0.
//     * so a boosted grind runs at V_CAP = 33.0 m/s and a boosted snow run at
//       V_BOOST = 31.0 m/s. The source's claim comes out of the engine's own
//       constants; I did not pick either number.
//     * the meter is NOT drained here. Physics sees a grinding rider as
//       airborne and its airStep already runs meterTick every frame, so the
//       drain is the engine's. This module only gates thrust on
//       ps.boostMeter > 0, exactly as groundCore does.
//   V_CAP is also applied to alongSpeed unconditionally (PC-06 is engine-wide);
//   without it a long descending rail would outrun the whole game.
//
// ===========================================================================
// DECISIONS TAKEN, NOT PUNTED
// ===========================================================================
//  1. GETTING ACTUALLY ON THE RAIL. The lock snap is 3-D: x, y AND z go to the
//     closest point on the polyline, so the rider stands 0.30 m up on the rail,
//     not at ground level underneath it. Physics then leaves the ground of its
//     own accord (its predictive constraint release) on the next frame, so the
//     grounded carve tick never runs during a grind.
//  2. DESCENDING RAILS. The along-rail law carries the full slope drive -G*T_y:
//     down makes you faster, up costs you speed, and the 3-D constraint follows
//     the rail's y. Harness rails are flat, so this is measured out of band.
//  3. HEADING ON A CURVED RAIL — ESCALATED, NOT RE-LITIGATED. Both cycle-2
//     candidates escalated this and the critic ruled it a gate-level blocker, so
//     I will not argue it again inside the module: I do not write heading, ever.
//     Two new measurements for whoever resolves it:
//       (a) on the harness curve, ridden with steer, the board's yaw error runs
//           20.1 deg at entry -> 9.2 deg at the far end (the probe's rail starts
//           20 deg off the approach and ends parallel to it), max 20.1 deg. That
//           is CLEAN by physics' own CLEAN_YAW = 45 deg and auto-snaps on
//           landing. Past ~45 deg of unrotated bend it is sketchy, past 90 a
//           crash — unchanged from cycle 2, still the blocker for a 90 deg rail.
//       (b) NEW, and the reason this is not only a landing problem: that same
//           20.1 deg of entry misalignment is what forces the whole crooked-
//           arrival machinery above, and it eats 82% of the rider's balance
//           budget on capture (w0 = 0.83 of 1.0). A module allowed to yaw the
//           board onto the tangent would spend none of it, and GR-06 would then
//           measure curvature rather than arrival. The heading prohibition has a
//           cost INSIDE the rails lane, not just at the landing.
//     gstate.yawError_rad and gstate.yawRateNeeded_radps are exported so a HUD or
//     assist layer can show exactly what the player must supply through the legal
//     spin channel ("keep on pressing that to do rail spins", §1.5): 40 deg/s for
//     a 90 deg / 40 m bend at 18 m/s, which is 0.13 of the stick.
//  4. "TURN SIDEWAYS TO BALANCE EASIER" (StrategyWiki) IS NOT MODELLED, and that
//     is a considered refusal. Neither length scale depends on board yaw: the
//     rail top (0.2 m) is narrower than the board at every board angle, and the
//     rider's control range is their own body. A yaw-angle balance bonus would be
//     a designed gift wearing a sourced label. gstate.yawError_rad is exported;
//     if the lane wants sideways to be safer, it is a design bonus, label it one.
//  5. AIR CLOCK. Physics sees a grinding rider as airborne, so a 6 s grind would
//     score as 6 s of hang time. DECISION: while onRail this module holds
//     ps.airTime at 0. Not heading, not position, not trick state —
//     src/tricks/tricks.mjs reads onGround, spinDeg, flipDeg, spinCapped,
//     flipCapped and landing, and nothing else (re-verified by grep this cycle).
//     Two things fall out, both wanted: a grind reads as contact to every
//     consumer, and the engine's own coyote-pop window stays open, so jumpRelease
//     off a rail is serviced by PHYSICS' ollie — same J_MIN/J_MAX, world-up,
//     carrying st.prewound through untouched. That is how "leaves the rail
//     preserving speed and prewind" is met without duplicating one physics
//     constant. spinDeg/flipDeg are deliberately NOT reset: a board spun on a
//     rail is a rail spin and it is the trick lane's business to score it.
//     STILL OPEN and named: ps.onGround stays false for the whole grind (I must
//     not write it), so the trick lane sees one long air window across a grind.
//     Whether a grind should open and close a trick window is the trick lane's
//     call; gstate.onRail and gstate.grindTime_s are exported for it.
//  6. BAIL VERDICT is NOT taken here. A bail sets gstate.bailed and gives the
//     board its escaping velocity; whether that becomes a 'crash' is trick-lane
//     state and this module is forbidden to write it.
//  7. RE-CAPTURE. Sourced rule (research 02 §1.5 [EST]: capture is "tested only
//     while airborne-descending or on landing frame"): a rail is eligible only
//     when the board is descending or in contact. Every exit EXCEPT a deliberate
//     ollie additionally latches that rail out until the board has been further
//     than captureRadius from it at least once. Without the latch a rider who
//     ran off the END re-locks on the next frame forever: measured 240+
//     lock/unlock transitions in a 10 s run before adding it. An ollie is exempt
//     on purpose, so you can pop and land back on the same rail.
//
// ===========================================================================
// EVERY WRITE THIS MODULE MAKES TO PHYSICS STATE, enumerated
// ===========================================================================
//   ps.vel[0..2]      every on-rail frame (the only legal control channel)
//   ps.pos[0..2]      ONCE per lock, the documented capture snap (GR-07)
//   ps.airTime = 0    every on-rail frame        (decision 5)
//   ps._popDone=false on the lock frame          (decision 5, re-arm the ollie)
//   ps._coyoteCharge  every on-rail frame        (crouch charges the exit ollie)
//   ps.prewound       on-rail frames after a rail prewind (contract: "preserving
//                     ... prewind"); physics ignores crouch in the air, so
//                     nothing else can carry it
//   NEVER: ps.heading (measured illegalWriteMax = 0), ps.onGround, ps.spinDeg,
//   ps.flipDeg, ps.spinCapped, ps.flipCapped, ps.landing, ps.boostMeter, or
//   anything else the trick system reads.
//
// ===========================================================================
// MEASURED (harness + own probes, all reproducible from this file)
// ===========================================================================
//   GATES: 9/9, hardFails 0. Gate law re-verified after this build:
//   harness/rail-mutants.mjs reports 8/8 caught, baseline clean.
//     GR-05 passive bail 4.07 s (config predicts 4.06); active hold 1.00 of the
//           window, |balance| never above 0.018 with steer.
//     GR-03 rail 9.65 m/s vs snow 5.64 m/s over the same 5 s from 20 m/s.
//     GR-04 speed loss 0.018% (one frame of rail drag).
//     GR-07 illegalWriteMax exactly 0, exactly one snap per lock.
//     GR-09 dt split error exactly 0.
//   ON THE RAIL, not under it: y = 0.3000 for every one of 343 grind frames
//   (rail y 0.30, snow y 0.00), lateral residual 0.0e+0 m, airTime 0.000000, and
//   exactly one grounded frame (the lock frame, before physics' own constraint
//   release fires).
//   BOOST: boosted grind pins at 33.00 m/s, boosted snow at 31.00 m/s; the same
//   grind unboosted decays to 2.72 m/s over the same 12 s.
//   CAPTURE: crooked arrivals at 18 m/s, with steering — 5/10/15/20/24/26 deg
//   all lock and hold the full 10 s probe; 30 deg is refused (rides past at full
//   speed). Speed across capture 17.29 -> 17.16 (5 deg), 17.22 -> 16.12 (20 deg).
//   PULL: 0.20 m knock decays at exactly exp(-OMEGA_C*dt) per frame, 1 mm after
//   33 frames, rider stays on.
//   CURVATURE IS A REAL MECHANIC, not a timer: aligned passive entry at 18 m/s
//   drops the rider at 2.12 / 1.60 / 1.22 / 0.88 / 0.65 / 0.33 s for
//   R = 400 / 200 / 120 / 80 / 60 / 40 m, against 4.07 s on a straight rail.
//   BEND ENVELOPE: full steer rides out a 60 deg arc at 18 m/s down to R = 30 m
//   (a_c = 10.8) and fails at R = 26 m. On a clothoid-entered bend the failure
//   moves to the hook channel at a_c = 10.6-11.2 m/s^2 (see WHICH CHANNEL).
//   DESCENDING 12 deg rail: 464 frames, along-rail 17.99 -> 15.90 m/s while the
//   same time on a flat rail decays to 5.43 m/s; the board tracks the rail's y
//   down to -26.6 m.
//   RAIL CHAIN: two rails 20 m apart, one lock each, 3 onRail transitions total
//   (on, off at the end of rail 1, on rail 2 and still on at the end of the sim)
//   — no chatter, versus 240+ before the latch.
//   OLLIE OFF: speed 14.7757 -> 14.7731 (0.018%), physics' own pop delivers
//   vy = 5.00 (full charge) and st.prewound = 1 survives the exit.
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

// closest point on the polyline to p  ->  { s, d, seg, q }
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
  const ROOT = Math.sqrt(1 + ZETA_B * ZETA_B);
  const SIGMA_B = LAMBDA_P * (ROOT - ZETA_B);   // unstable root  s1
  const S_FAST = LAMBDA_P * (ROOT + ZETA_B);    // |stable root|  -s2
  const SWAY_M = 0.005;           // CHOICE, log-insensitive (see header)

  // ---- rail friction / capture ----
  const CAPTURE_R = 1.0;          // CHOICE inside research 02 §1.5's 0.5-1.5 m band
  const DRAG_SCALE = 0.20 / 0.35; // Tux Racer ice/snow mu ratio, research 02 §3.1
  const MU_RAIL = PHYS.MU_BASE * DRAG_SCALE;
  const LAM_RAIL = PHYS.LAMBDA_LONG * DRAG_SCALE;
  const V_STALL = MU_RAIL * G / LAMBDA_P;
  const maxClear = rails.reduce((m, r) => Math.max(m, r.clearance), 0);
  const MIN_LOCK = Math.sqrt(2 * G * maxClear + V_STALL * V_STALL);
  // Boost thrust implied by the engine's own flat-snow boost target (header).
  const D_BOOST = PHYS.MU_BASE * G + PHYS.LAMBDA_LONG * PHYS.V_BOOST;

  // ---- hook compliance ----
  const ZETA_C = 1.0;             // CHOICE (critical damping, no on/off chatter)
  const wHalfRef = rails.length ? rails[0].wHalf : 0.1;
  const OMEGA_C = Math.sqrt(G / wHalfRef);
  // Rider control range, DERIVED from the hook limit (header, TWO LENGTH SCALES):
  // a_max := G  =>  W_CTRL = H_COM * a_max / G = H_COM.
  const W_CTRL = H_COM;

  const config = {
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    // half-life of a balance correction = the fast, stable pendulum mode
    balanceHalfLife_s: Math.LN2 / S_FAST,
    // "exceeding tolerance bails": the lean angle at which the rider's authority
    // and the board's hook both run out at once, atan(W_CTRL / H_COM) = 45 deg
    curveTolerance_rad: Math.atan(W_CTRL / H_COM),
    minLockSpeed_mps: MIN_LOCK,
    // --- observability / derivation trail (all equations, see header) ---
    comHeight_m: H_COM,
    pendulumRate_hz: LAMBDA_P,
    balanceGrowthRate_hz: SIGMA_B,      // SIGMA_B: the rate |balance| diverges at
    balanceFastRate_hz: S_FAST,         // S_FAST: sets the recoverable-set slope
    balanceDampingRatio: ZETA_B,
    swaySeed_m: SWAY_M,
    predictedPassiveBail_s: Math.log(W_CTRL / SWAY_M) / SIGMA_B,
    hookRate_hz: OMEGA_C,
    hookDampingRatio: ZETA_C,
    railMu: MU_RAIL,
    railLambda_hz: LAM_RAIL,
    stallSpeed_mps: V_STALL,
    riderRecovery_m: W_CTRL,
    // a_max = G*W_CTRL/H_COM: the lateral COM acceleration full steer commands.
    // Equal to G by construction (see header).
    controlAuthority_mps2: G * W_CTRL / H_COM,
    // the board leaves the rail when the corner demands more than this much
    // lateral acceleration: |e| > W_half <=> v^2*kappa > G. Divide by v^2 for
    // the curvature limit at a given speed.
    hookLimitLateralAccel_mps2: G,
    // Largest cross-rail arrival speed the BOARD's hook could absorb elastically
    // (2.69 m/s — below any real landing, which is WHY the impact is modelled as
    // inelastic), and the largest the RIDER can absorb, which is the one that
    // actually gates capture (header, CAPTURE). Both are equations.
    boardArrivalLimit_mps: Math.E * Math.sqrt(G * wHalfRef),
    riderArrivalLimit_mps: S_FAST * W_CTRL,
    // boost (header, BOOST)
    boostThrust_mps2: D_BOOST,
    railBoostTerminal_mps: Math.min(PHYS.V_CAP, (D_BOOST - MU_RAIL * G) / LAM_RAIL),
    snowBoostTerminal_mps: PHYS.V_BOOST,
    speedCap_mps: PHYS.V_CAP,
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // observability (never consumed by the gates; view/HUD/trick lanes read these)
      grindTime_s: 0, curvature_invm: 0, yawError_rad: 0, yawRateNeeded_radps: 0,
      leanError: 0, leanErrorRate: 0, lean: 0, leanDemand: 0, leanRad: 0,
      comOffset_m: 0, comVel_mps: 0, hookOffset_m: 0, hookVel_mps: 0,
      boosting: false, lastLeaveReason: null, lastBailReason: null, prewindHint: 0,
      // internals
      charge: 0,
      _s: 0, _b: 0, _bv: 0, _e: 0, _ev: 0, _rail: null,
      _vyCmd: null, _gObs: PHYS.G_AIR, _latch: null,
    };
  }

  // exact solution of  y'' + C y' - L^2 y = 0  (real distinct roots s1, -S_FAST)
  function balanceStep(y0, yv0, dt) {
    const s1 = SIGMA_B, s2 = -S_FAST;
    const A = (yv0 - s2 * y0) / (s1 - s2);
    const B = (s1 * y0 - yv0) / (s1 - s2);
    const e1 = Math.exp(s1 * dt), e2 = Math.exp(s2 * dt);
    return [A * e1 + B * e2, A * s1 * e1 + B * s2 * e2];
  }

  // exact critically-damped hook: e'' = -w^2 (e - eStar) - 2 z w e'   (z = 1)
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

  // Leave the rail. Speed is CONSERVED: the along-rail speed goes down the
  // tangent and the board's live cross-rail speed (hook state) goes down the
  // lateral, so a rider ripped off a rail keeps what he arrived with.
  function leave(gs, ps, reason, tangent, extraLat = 0) {
    if (tangent) {
      const L = [-tangent[2], 0, tangent[0]];
      const lat = gs._ev + extraLat;
      ps.vel[0] = tangent[0] * gs.alongSpeed + L[0] * lat;
      ps.vel[2] = tangent[2] * gs.alongSpeed + L[2] * lat;
      // never clobber the engine's vertical impulse on a deliberate ollie
      if (reason !== 'jump') ps.vel[1] = tangent[1] * gs.alongSpeed;
    }
    gs.lastLeaveSpeed = Math.hypot(ps.vel[0], ps.vel[2]);
    // Every exit EXCEPT a deliberate ollie latches this rail out until the board
    // has been further than captureRadius from it at least once. Without it a
    // rider who runs off the end (or falls off) sits inside the capture sphere
    // of the rail he just left and re-locks on the next frame, forever: measured
    // as 1-frame lock/unlock chatter at the end of every rail before this guard.
    if (reason !== 'jump' && gs._rail) gs._latch = gs._rail.id;
    gs.onRail = false; gs.railId = null; gs._rail = null;
    gs.lastLeaveReason = reason; gs._vyCmd = null;
    gs.grindTime_s = 0; gs.boosting = false;
    gs._e = 0; gs._ev = 0;
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

    // ---- latch bookkeeping: a left rail is ineligible until cleared --------
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

      // --- 2. balance ------------------------------------------------------
      // b'' = L^2 (b - steer) - C_B b' + F_hook,  F_hook = (w^2 e + 2 z w e')/W_CTRL
      // F_hook is the ONLY lateral forcing: the rider stands on the board and
      // the board is pushed only by the hook. Zero-order hold on the start-of-
      // step hook state, so the closed form below is exact for the step.
      const u = clamp(inp.steer ?? 0, -1, 1);
      const fHook = (OMEGA_C * OMEGA_C * gs._e + 2 * ZETA_C * OMEGA_C * gs._ev) / W_CTRL;
      const bStar = u - fHook / (LAMBDA_P * LAMBDA_P);
      const [y, yv] = balanceStep(gs._b - bStar, gs._bv, dt);
      gs._b = y + bStar; gs._bv = yv;

      // the quasi-static lean this corner DEMANDS (curvature only — a transient
      // is a disturbance, not a demand):
      //   b_lean = v^2 kappa / (L^2 W_CTRL) = a_c H_COM / (G W_CTRL)
      const bLean = (v * v * kap) / (LAMBDA_P * LAMBDA_P * W_CTRL);
      const d = gs._b - bLean;      // deviation from the demanded lean
      const dv = gs._bv;            // b_lean is held constant across the step

      // RECOVERABLE SET (header): w = d + d'/S_FAST obeys w' = SIGMA_B (w - u)
      // exactly, so {|w| <= 1} is exactly the set from which bounded steer can
      // still save the rider. That set, not the static-equilibrium line, is what
      // gstate.balance reports and what bails.
      gs.balance = d + dv / S_FAST;
      gs.leanError = d; gs.leanErrorRate = dv;
      gs.lean = gs._b; gs.leanDemand = bLean;

      // --- 3. hook compliance ----------------------------------------------
      const eStar = -(v * v * kap) / (OMEGA_C * OMEGA_C);
      const [e, ev] = hookStep(gs._e, gs._ev, eStar, dt);
      gs._e = e; gs._ev = ev;

      // --- 4. bail tests ---------------------------------------------------
      if (pr.d > CAPTURE_R) {                   // board is no longer on the rail
        gs.lastBailReason = null;
        leave(gs, ps, 'lost', at.tang);
        return gs;
      }
      if (Math.abs(e) > rail.wHalf) {           // hook rip: the arrival or the
        gs.bailed = true;                       // corner beat the rail's geometry
        gs.lastBailReason = 'hook';
        leave(gs, ps, 'bail', at.tang);         // board keeps its cross-rail speed
        return gs;
      }
      if (Math.abs(gs.balance) > 1) {           // outside the recoverable set
        gs.balance = Math.sign(gs.balance);
        gs.bailed = true; gs.lastBailReason = 'balance';
        // the topple carries the COM's own lateral velocity into the fall
        leave(gs, ps, 'bail', at.tang, gs._bv * W_CTRL);
        return gs;
      }

      // --- 5. along-rail speed: slope drive + boost - rail friction --------
      const cosT = Math.sqrt(Math.max(0, 1 - at.tang[1] * at.tang[1]));
      const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
      gs.boosting = boosting;
      const a = -gContact * at.tang[1]
        - Math.sign(v || 1) * MU_RAIL * gContact * cosT
        + (boosting ? D_BOOST : 0);
      let [v1, ds] = flowRail(v, a, LAM_RAIL, dt);
      if (v1 > PHYS.V_CAP) v1 = PHYS.V_CAP;     // engine-wide clamp (PC-06)
      gs.alongSpeed = v1;

      const sNew = pr.s + ds;
      if (sNew >= rail.total || sNew <= 0 || v1 <= 0) {
        leave(gs, ps, sNew >= rail.total ? 'end' : 'stalled', at.tang);
        return gs;
      }
      gs._s = sNew;

      // --- 6. realise the reference through the velocity channel ------------
      // FINITE-GAIN PULL at the hook rate (header, COMPLIANCE): feed-forward the
      // reference's own velocity, then decay the residual tracking error by
      // exactly exp(-OMEGA_C*dt) per step. Not a one-frame snap.
      const nx = evalRail(rail, sNew);
      const L2 = [-nx.tang[2], 0, nx.tang[0]];
      const tgt = [nx.p[0] + L2[0] * e, nx.p[1], nx.p[2] + L2[2] * e];
      const ffx = nx.tang[0] * v1 + L2[0] * ev;
      const ffy = nx.tang[1] * v1;
      const ffz = nx.tang[2] * v1 + L2[2] * ev;
      const kPull = (1 - Math.exp(-OMEGA_C * dt)) / dt;
      ps.vel[0] = ffx + (tgt[0] - ps.pos[0] - ffx * dt) * kPull;
      ps.vel[2] = ffz + (tgt[2] - ps.pos[2] - ffz * dt) * kPull;
      // pre-compensate the gravity the next physics step will apply, so the
      // board neither sags into the rail nor floats off it.
      ps.vel[1] = ffy + (tgt[1] - ps.pos[1] - ffy * dt) * kPull + gs._gObs * dt;
      gs._vyCmd = ps.vel[1];

      // a grind is contact, not hang time (decision 5 in the header)
      ps.airTime = 0;

      // --- 7. observability -------------------------------------------------
      gs.t = rail.total > 0 ? clamp(sNew / rail.total, 0, 1) : 0;
      gs.lockFrames++; gs.grindTime_s += dt;
      gs.curvature_invm = kap;
      gs.comOffset_m = gs._b * W_CTRL;
      gs.comVel_mps = gs._bv * W_CTRL;
      gs.leanRad = Math.atan(gs.comOffset_m / H_COM);
      gs.hookOffset_m = e; gs.hookVel_mps = ev;
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
      if (rail.id === gs._latch) continue;         // just left this one, not clear yet
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

    // CROSS-RAIL ARRIVAL (header, CAPTURE).
    const L = [-at.tang[2], 0, at.tang[0]];
    const vLat = ps.vel[0] * L[0] + ps.vel[2] * L[2];
    // The rider is not bolted to the board: when the rail arrests the board's
    // cross-rail motion the COM keeps going, and that impulse is the whole
    // capture transient. Normalized, it is exactly delta_b' = vLat / W_CTRL.
    const bv0 = vLat / W_CTRL;
    const seedSign = at.kappa !== 0 ? -Math.sign(at.kappa) : 1;
    const b0 = seedSign * (SWAY_M / W_CTRL);
    // ALIGNMENT LIMIT, from the recoverable-set theorem rather than an angle
    // dial: you may only START a grind from a state you could still save.
    // |w0| = |b0 + bv0/S_FAST| <= 1  <=>  |vLat| <~ S_FAST*W_CTRL = 7.52 m/s,
    // a cone of +-26 deg at 18 m/s and +-70 deg at 8 m/s (measured: 26 deg holds
    // the full probe, 30 deg is refused). Outside it the rider clips the rail and
    // rides on with FULL speed — no snap, no one-frame "grind", no speed dump.
    // (This module cannot author a crash; whether clipping a rail sideways
    // should be one is the trick lane's call.)
    const w0 = b0 + bv0 / S_FAST;
    if (Math.abs(w0) > 1) return gs;

    // THE ONE LEGAL POSITION WRITE: the documented lock-on snap, 3-D, magnitude
    // <= captureRadius, exactly once per lock (GR-07).
    ps.pos[0] = pr.q[0]; ps.pos[1] = pr.q[1]; ps.pos[2] = pr.q[2];
    // The cross-rail component is absorbed INELASTICALLY. It cannot go into the
    // hook: the hook's whole travel is W_half = 0.1 m, so its largest absorbable
    // arrival is E*sqrt(G*W_half) = 2.69 m/s (config.boardArrivalLimit_mps) —
    // less than the harness curve's own 6.18 m/s entry. A board landing across a
    // 0.2 m rail loses its sideways momentum to the impact, and the rider takes
    // the impulse (bv0 above). Speed cost is bounded by the alignment cone:
    // at most 1 - cos(26 deg) = 10% at 18 m/s, and 0% for an aligned landing.
    ps.vel[0] = at.tang[0] * along;
    ps.vel[2] = at.tang[2] * along;
    // vertical: rail tangent + the same gravity pre-compensation the pull uses,
    // so the board does not dip into the rail on the first frame. It also
    // guarantees physics' predictive constraint release fires next frame, which
    // is what takes the rider OFF the snow and onto the rail.
    ps.vel[1] = at.tang[1] * along + gs._gObs * dt;
    // re-arm the engine's ollie channel: a rail landing is a fresh takeoff for
    // jump purposes, otherwise a rail-to-rail chain gets exactly one pop. This
    // writes one private physics field, on the lock frame only. The clean fix is
    // a `rearmPop(state)` on the physics module; requested, not assumed.
    ps._popDone = false;

    gs.onRail = true; gs.railId = rail.id; gs._rail = rail;
    gs.alongSpeed = Math.min(Math.abs(along), PHYS.V_CAP) * Math.sign(along);
    gs._s = pr.s; gs.bailed = false;
    gs.t = rail.total > 0 ? clamp(pr.s / rail.total, 0, 1) : 0;
    gs.lockFrames = 1; gs.grindTime_s = 0; gs.charge = 0; gs.prewindHint = 0;

    // Rider state at capture: standing at the lean the rail demands here, plus
    // the postural sway floor, plus the arrival impulse. The sway SIGN is a
    // deterministic tie-break with no effect on magnitude (a real rider's stance
    // would set it); the rider sways toward the outside of the bend under them.
    const bLean0 = (gs.alongSpeed * gs.alongSpeed * at.kappa) / (LAMBDA_P * LAMBDA_P * W_CTRL);
    gs._b = bLean0 + b0;
    gs._bv = bv0;                     // the COM keeps the cross-rail velocity
    gs._e = 0; gs._ev = 0;            // the board is settled on the rail
    gs.balance = w0;
    gs.leanError = b0; gs.leanErrorRate = bv0;
    gs.lean = gs._b; gs.leanDemand = bLean0;
    gs.comOffset_m = gs._b * W_CTRL; gs.comVel_mps = bv0 * W_CTRL;
    gs.leanRad = Math.atan(gs.comOffset_m / H_COM);
    gs.hookOffset_m = 0; gs.hookVel_mps = 0;
    gs.yawError_rad = wrapPi(ps.heading - at.yaw);
    ps.airTime = 0;
    return gs;
  }

  return { config, init, step };
}
