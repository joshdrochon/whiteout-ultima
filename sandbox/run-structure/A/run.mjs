// ============================================================================
// run-structure lane — run.mjs   (cycle 5)
//
// Start gate, race clock, finish line, results card, restart, and a three-layer
// CORRIDOR: soft berm -> firm wall -> hard limit (return).
//
// Pure JS, deterministic. No Date, no Math.random, no globals, no imports of
// anything outside this repo's accepted physics module (constants only).
//
// ---------------------------------------------------------------------------
// 0. WHAT THIS MODULE WRITES, EXHAUSTIVELY
//
//   physState.vel[0..2] — and ONLY by adding a bounded ACCELERATION * dt from
//   the corridor field, whose horizontal magnitude never exceeds A_HCEIL and
//   whose 3-D magnitude never exceeds A_CEIL3 (section 3.5).
//
//   Nothing else. It never writes physState.pos (the module diffs ph.pos across
//   its own write block every frame and publishes the result in
//   rs.confine.maxSelfPosDelta_m — a computed number, not an asserted zero), it
//   never writes physState.heading, spinDeg, flipDeg, yawRate, onGround,
//   airTime, landing, charge or boostMeter, and it never writes any field of
//   the trick state. It reads both.
//
// ---------------------------------------------------------------------------
// 1. NO STEERING AUTHORITY. THE MODULE DOES NOT DRIVE.
//
//   RS-10 (HARD) measures, under identical inputs, the extra per-step yaw the
//   run module adds while the rider is in bounds. The bar is 5 deg/s. This
//   module measures 0.0 deg/s, and the honest reason is placement, not
//   restraint: under the harness probe drive `play` the corridor never engages
//   at all, so with and without run.step the two trajectories are bit-identical.
//
//   THE GATE THEREFORE MEASURES A MODULE THAT IS NOT RUNNING, AND THAT IS A
//   REAL WEAKNESS IN THE EVIDENCE — stated here, not left to be discovered.
//   Measured this session, no run module attached: the probe drive's widest
//   line is 34.1 m off the course centre (p99 30.5, p50 6.9). The berm — the
//   first and gentlest layer — starts at 55 m. So RS-10's in-bounds frames are
//   frames in which this module writes nothing.
//
//   What the gate cannot see, this module measures for itself (selftest.mjs
//   section 2) and publishes. Note first WHY the gate throws those frames away:
//   RS-10 compares two whole runs, and that comparison is only meaningful while
//   they are still the same trajectory. Once the corridor fires, the unconfined
//   rider leaves for terrain 800 m away and the heading difference stops being
//   attributable to anything. (Run the gate's own arithmetic over every frame
//   of the adversarial drive and it reports 45.9 deg/s — that number is
//   trajectory divergence, not authority, and it is not evidence of anything.)
//
//   The measurement that IS attributable is a per-frame COUNTERFACTUAL. At
//   every frame the state is forked immediately before run.step, and both the
//   corrected and the uncorrected fork are advanced ONE physics step with the
//   SAME input; the difference in heading delta is the yaw the corridor caused
//   on that frame, from an identical starting state, with no divergence in it.
//   MEASURED over the harness's own 240 s adversarial drive (14,400 frames,
//   1,766 of them corridor-active — 12.3%):
//
//       worst yaw the corridor caused on ANY frame   0.48 deg/s
//       mean over corridor-active frames             0.006 deg/s
//
//   The mechanism behind those numbers: the corridor writes velocity only. The
//   accepted physics module derives board yaw from `steer` and from carve
//   geometry (omega = speed / R_sidecut(steer)), so a velocity write can only
//   reach heading INDIRECTLY, through the speed in that ratio. There is no path
//   from this module to heading that does not go through speed, because the
//   module never writes heading.
//
// ---------------------------------------------------------------------------
// 2. PHASE MACHINE
//
//   phase: 'ready' -> 'running' -> 'finished'          (contract field)
//
//   ready     rider upstream of zStart. Clock reads 0. The gate is a CLOSED
//             GATE: the down-course boundary of section 3 is moved onto the
//             start line while the countdown runs, so a rider behind the line
//             cannot roll onto the course early. rs.stage / rs.countdown_s /
//             rs.light publish the countdown for the HUD; `phase` stays one of
//             the contract's three values, so the countdown is a sub-state.
//   running   entered on the first step at or past zStart — the clock starts AT
//             THE LINE (rolling start). Timer, splits, telemetry, the landing
//             ledger and the corridor all run here.
//   finished  entered on the first step at or past zFinish. The card is
//             assembled once and deep-frozen; the clock stops; the corridor
//             keeps holding, so a rider with boost pinned coasts to a stop in
//             the run-out instead of sailing onto the backdrop.
//
//   THE GATE IS A BOUNDARY, NOT A PIN. Holding a rider by writing their
//   position, or by zeroing their velocity, is a physics write on an ordinary
//   frame and reads as authority (RS-10 scores trajectory divergence: an
//   earlier revision of this file pinned the rider for a 3 s countdown and RS-10
//   reported 300.0 deg/s, the physics yaw cap).
//
//   A rider who starts BEHIND the line is held there, and nosing over the line
//   while the light is red does NOT start the run: the phase advances only when
//   the rider is past zStart AND the gate is open. A rider who starts PAST the
//   line has a rolling start and the gate is behind them — it must never reach
//   forward and drag them back, so which case applies is decided on the first
//   step from the rider's own position and never revisited (rs._startedPast).
//
//   DISCLOSED, NEVER ENGAGES IN-HARNESS: the harness spawns the rider at z = 15,
//   15 m PAST zStart = 0, so on every gate run in this lane the 'ready' phase is
//   empty and the gate is never exercised — RS-09 passes through the runner's
//   own "no ready phase (starts running)" free branch, not through this code.
//   rs.confine.gateFrames counts gate engagements and is 0 on every harness
//   drive. selftest.mjs section 4 drives the gate directly from z = -60 under
//   full boost: MEASURED, the rider never gets closer than 13.7 m to the line
//   while the light is red or set (RS-09's own bar is 3 m of drift), the gate
//   engages for 125 frames, and the clock starts at the line, not at the
//   countdown.
//
// ---------------------------------------------------------------------------
// 3. THE CORRIDOR
//
//   3.1 WHY IT EXISTS (measured, not assumed)
//
//   Physics ground is an analytic function defined everywhere. The RENDERED
//   mesh is a per-LOD approximation of it. Measured with the runner's own
//   divergence probe (|analytic - bilinear across the worst LOD cell the player
//   can be near|), swept on a 1.5 m grid over the whole course:
//
//     |offset from centre|   0    55   120   130   140   150   155
//     worst mesh gap (m)   0.87  1.00  1.13  1.23  1.47  1.81  2.01
//
//     z outside (-250, 2750): backdrop tiles, 83.3 m cells — divergence steps
//     from < 0.4 m to 8.6 m across that boundary and rises to ~77 m beyond.
//
//   RS-05's ceiling is 4 m. A rider past it is visibly falling through the
//   world. So the corridor's job is to make a stated region unreachable.
//
//   3.2 THE ONE LAW, AND WHICH END OF IT IS DEFENDED
//
//   Every boundary here is one continuous allowance on the OUTWARD rate w, as
//   a function of the signed distance p past that boundary's soft line:
//
//       p <= 0 (inside):   w_allow = +sqrt(2 * A_IN  * (-p))     brake
//       p >  0 (outside):  w_allow = -sqrt(2 * A_OUT * ( p))     return
//
//   One function, zero exactly at p = 0, continuous and monotone across it. The
//   inside branch is a braking envelope whose allowance reaches zero exactly at
//   the line. The outside branch is its MIRROR: past the line the rider is not
//   merely braked, they are required to be coming back, at a rate that brings
//   them to the line with zero speed — so the return never slingshots a rider
//   across the corridor into the far wall. The return requirement is capped at
//   V_CAP, the physics module's own hard speed clamp: the corridor may not
//   demand a speed physics itself forbids, and uncapped the mirror would ask
//   for 118 m/s at 130 m out. The field applies
//
//       a_inward = max(0, w - w_allow) / dt
//
//   i.e. exactly the excess and not one m/s^2 more, ceilinged by section 3.5.
//
//   Discrete-safe form. The inside branch is solved for the step ABOUT TO BE
//   TAKEN — w_allow^2/(2A) + w_allow*dt = -p gives
//
//       w_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*(-p))
//
//   so a rider who obeys the envelope cannot cross the line by braking one step
//   too late, at ANY dt, not merely at 60 Hz.
//
//   The identity A = V_CAP^2 / (2 * span) ties a boundary's firmness to its
//   span: at distance `span` from the line the allowance is exactly V_CAP, the
//   fastest thing that can physically exist, so the layer imposes nothing where
//   it starts. Either end can be defended; this module defends the FIRMNESS in
//   every case and lets the span follow, because sizing a barrier from the room
//   that happens to be available is how a barrier ends up unable to hold:
//
//     boundary      firmness A                          defended as         span
//     lateral wall  A_STOP  = 54.096 m/s^2   what the player can push with  10.07 m
//     run-out       A_BRAKE =  4.5   m/s^2   the rider's own brake authority 121.0 m
//     back-stop     A_BRAKE =  4.5   m/s^2   same                            121.0 m
//     closed gate   A_BRAKE =  4.5   m/s^2   same                            121.0 m
//     return (all)  A_STOP  = 54.096 m/s^2   what the player can push with     —
//
//     A_STOP  = DRIVE_MAX + g, where DRIVE_MAX = V_BOOST / TAU_BOOST = 44.286
//               m/s^2 is the accepted physics module's own boost law evaluated
//               at rest (a first-order relaxation toward V_BOOST with time
//               constant TAU_BOOST), aimed wherever the board points. A_STOP is
//               therefore the strongest acceleration the world can apply to the
//               rider in any single direction. A boundary at least this firm
//               cannot be outrun in principle; a softer one can be, and merely
//               borrows room from the next layer.
//     A_BRAKE = 4.5 m/s^2, references/REFERENCE_BAR.md TN-08 "Brake decel
//               defend 4.5, band 3-6". The run-out is where the run is already
//               over; decelerating at exactly the rider's own brake authority
//               is what "coast to a stop" means, and it is the reason the
//               run-out is 121 m long rather than however far the backdrop
//               happens to be. The back-stop and the closed gate are the same
//               object pointed the other way, so they take the same firmness.
//
//   TRACKABILITY — the property that decides which firmness a boundary may
//   have. A boundary is TRACKED (held with negligible overshoot) only if the
//   module can deliver the envelope's own deceleration AND cancel the drive
//   pushing into it, inside the horizontal ceiling:
//
//       A_TRACK = A_HCEIL - DRIVE_MAX - g/2 = g = 9.81 m/s^2
//
//   (the arithmetic collapses exactly to g). A_BRAKE = 4.5 is under it, so the
//   run-out, the back-stop and the closed gate are all tracked and a rider
//   driving into them at full boost is brought to rest ON the line — MEASURED,
//   the gate never lets a rider closer than 13.7 m to the start line while the
//   light is red. A_STOP = 54.096 is five times over it, so the LATERAL WALL IS
//   DELIBERATELY NOT TRACKED: a rider driving outward at full boost overshoots
//   it, and MARGIN (3.3) is the exact size of that overshoot.
//
//   That is a real tradeoff and it is made on room, so it is stated as such: a
//   trackable lateral envelope (A <= g) needs a span of V_CAP^2/(2g) = 55.5 m,
//   and only ~30 m separates the contract's corridor edge (halfWidth 120) from
//   the divergence-safe ceiling. It does not fit. The alternative would be to
//   start pushing at |s| = 74.5 m, deep inside the corridor the CONTRACT
//   defines as in-bounds — a bigger lie than a bounded, derived, measured
//   overshoot.
//
//   3.3 SOFT LINE INSIDE, HARD LINE OUTSIDE
//
//   A braking envelope brings the rider to rest ON its soft line, and an
//   untrackable one is overshot before that. If the soft line is also the safety
//   limit, the design has zero margin and the "hard limit" is not a shell, it is
//   the parking spot. So every soft line here sits one full worst-case
//   penetration INSIDE the containment bound.
//
//   MARGIN is derived with the drive and the speed COUPLED, because they are:
//   physics' boost is a relaxation toward V_BOOST with time constant TAU, so a
//   rider already leaving at outward rate w has only (V_BOOST - w)/TAU of drive
//   left, and none at all past V_BOOST. Treating the drive as a constant 44.3
//   m/s^2 while the rider travels at 33 m/s would be double-counting. Net inward
//   acceleration at outward rate w, worst case, grounded:
//
//       a(w) = A_HCEIL - max(0, (V_BOOST - w)/TAU) - g/2
//            = g + w/TAU        for w <  V_BOOST      (the berm's g/2 ceiling
//            = A_STOP           for w >= V_BOOST       cancels the worst outward
//                                                      gravity exactly, so the
//                                                      residual at w = 0 is g)
//
//       MARGIN = integral(0 -> V_CAP) w/a(w) dw  +  V_CAP * DT_REF
//              = 13.493 + 1.183 + 0.550 = 15.226 m
//
//   The last term is one unseen frame: the module reads the rider AFTER physics
//   has already moved them, and DT_REF = 1/60 s is fixed by CONTRACTS.md
//   ("physics fixed step 60 Hz").
//
//   Containment bound = soft line + MARGIN, and it is a BOUND, not a barrier:
//   nothing is placed there and nothing fires there. rs.confine.beyondBound
//   counts frames spent past it and is 0 on every drive measured, including the
//   deliberate injections in section 6. MEASURED with a full 33 m/s outward
//   velocity injected in a single frame from inside the corridor: the rider
//   peaks at |s| = 144.14, a penetration of 14.07 m against the derived bound
//   of 15.23 m.
//
//     lateral   soft |s| = 130.066   bound |s| = 145.291
//     run-out   soft z  = 2521.0     bound z  = 2536.226
//     back-stop soft z  = -121.0     bound z  = -136.226
//
//   CHECKED, NOT CHOSEN: the containment box (|s| <= 145.291, z in
//   [-136.226, 2536.226]) has a measured worst mesh divergence of 1.507 m —
//   under half of RS-05's 4 m ceiling, and the box lies wholly inside the
//   fine-LOD region (z in [-250, 2750]) with over 100 m to spare at each end.
//   The divergence sweep is a CONSTRAINT the derived geometry has to satisfy; it
//   is not where any of the numbers came from. Had it failed, the firmnesses
//   would have had to rise, not the limits move in.
//
//   3.4 THE THREE LAYERS
//
//   BERM (soft, |s| in [55, 130.07], grounded only)
//     A berm is ground. It acts only when ph.onGround; an airborne rider does
//     not feel a bank.
//
//     A slope's INWARD HORIZONTAL restoring acceleration is g*sin(th)*cos(th) =
//     (g/2)*sin(2*th), which is maximal at th = 45 deg and equals g/2 = 4.905
//     m/s^2. That is not a tuning choice, it is a ceiling: NO SLOPE, however
//     steep, can pull a rider sideways harder than g/2. So g/2 is the largest
//     acceleration a berm may apply and still be honestly called terrain.
//
//     Measured inward pull of the actual gully (horizontal component, along the
//     corridor's lateral coordinate, both flanks, z = 0..2400):
//
//       |s|     20    40    55    70    85   100   120   130   150
//       median 1.23  2.17  2.75  3.28  3.85  4.15  4.39  4.45  4.39
//       min   -0.81  0.47  0.81  2.00  2.38  2.80  3.00  2.99  2.82
//
//     The mountain is already doing most of this job, and it does it unevenly:
//     at the corridor edge the same offset is worth 4.39 m/s^2 at a median z
//     and 3.00 m/s^2 where the gully is shallowest. So the berm does not ADD a
//     force — adding one would double a bank that is already near its physical
//     ceiling. It TOPS THE TERRAIN UP:
//
//       a_berm(x, z) = q^2 * max(0, g/2 - a_terrain_inward(x, z))
//       q = clamp((|s| - 55) / (120 - 55), 0, 1)
//
//     so the corridor's shoulder is the strongest bank a slope can be (g/2) at
//     and beyond the corridor edge, EVERYWHERE down the course, and fades to
//     the mountain's own unmodified pull at the tree line. Where the gully is
//     already steep the berm contributes nothing. MEASURED peak contribution
//     over the whole course: 1.832 m/s^2, at |s| = 120, z = 550, where the
//     terrain's own pull is 3.07.
//
//     a_terrain_inward is computed each frame from the same 0.05 m central
//     difference stencil the physics module's default sampleNormal uses, so the
//     berm is measuring the surface physics is standing on, not an approximation
//     of it.
//
//     Shape: q^2 is the lowest-order polynomial that is zero WITH ZERO SLOPE at
//     the tree line (C1-continuous, never a step the rider can feel switch on)
//     and 1 at the corridor edge. The exponent is forced by those two
//     conditions plus lowest order; it is not a feel knob.
//
//     Start of the layer, W_BERM = 55 m: CITED — the render lane plants pines
//     only at 55 < d < 720 (src/render/main.mjs), so 55 m is where the ridable
//     floor visibly ends. It is also 1.6x the widest line the probe drive takes
//     (34.1 m), which is why the corridor never fires in ordinary play.
//
//     Overrule test: g/2 = 4.905 is 18.9% of the physics module's own lateral
//     acceleration ceiling A_LAT = 26 m/s^2, so a rider at full lock still wins
//     and can still take the flank. A berm shapes a line; it never takes the
//     turn.
//
//     MEASURED under the harness's own 240 s adversarial drive: the berm never
//     fires (bermFrames 0), because that drive never gets more than 38.6 m off
//     centre. selftest.mjs section 1b fires it directly and checks the claim at
//     runtime through rs.confine.terrainPull_mps2 / bankTotal_mps2:
//
//       |s|      60     80    100    120    128
//       terrain  2.69   3.72   3.95   4.51   4.57
//       berm     0.01   0.19   0.48   0.41   0.35
//       total    2.71   3.90   4.41   4.90   4.91  <- g/2 at and past the edge
//
//     The bank never exceeds g/2 anywhere, and at and beyond the corridor edge
//     it is g/2 exactly, whatever the mountain happens to be doing at that z.
//
//   WALL (firm, |s| in [120, 130.07])
//     The brake branch of 3.2 at A_STOP. Its start is not a free constant: the
//     soft line is placed one span (10.07 m) outside the CONTRACT's halfWidth,
//     which makes the allowance exactly V_CAP at |s| = 120 by construction. So
//     the corridor can impose nothing at all inside the region the contract
//     itself calls in-bounds — the layer start is the contract's number, and
//     the only thing this module chose was the firmness.
//     The field is expressed in corridor coordinates (offset s across, progress
//     z along), so the wall acts purely ACROSS: a rider carving along it keeps
//     every bit of their down-course speed. It cannot pull a rider in — that is
//     the berm's job — and it never fires until the rider is genuinely
//     outrunning the room they have left.
//
//   LIMIT / RETURN (hard, |s| > 130.07)
//     The return branch of 3.2 at A_STOP. Reachable only if physics injects
//     outward velocity faster than the wall can take it back within one frame.
//     Braking alone would only stop the rider going out FAST, not stop them
//     going out: between one clamp and the next the world adds up to A_STOP*dt
//     of outward rate. So past the soft line the requirement inverts and the
//     rider is brought back, on the mirrored envelope, arriving at the line with
//     zero speed. Counted and disclosed: rs.confine.limitFrames.
//
//   3.5 THE WRITE CEILINGS — two of them, both published, both enforced
//
//     GROUNDED CORRECTIONS RIDE THE SNOW. You cannot push a board into or out
//     of the ground, only along it. There is exactly one tangent-plane vector
//     whose horizontal shadow is the correction the envelope asked for, and
//     that is the one applied: no authority is lost to a projection and none is
//     invented by a rescale. It also keeps the push out of the physics module's
//     magnitude-preserving grounded redirect, which would otherwise launder a
//     component pointed into the hill back out as forward speed — a confiner
//     that accidentally boosts.
//
//     That lift means one number cannot do the job. Only the HORIZONTAL part of
//     a correction does containment work; the vertical part is bookkeeping that
//     keeps the push on the snow, and on a 63 deg face it is larger than the
//     work. So:
//
//       A_HCEIL = A_STOP + g/2 = 59.001 m/s^2
//         The horizontal ceiling: the firmest boundary plus the strongest berm
//         that can co-fire with it, and not one m/s^2 more. Applied BEFORE the
//         tangent lift, so the lift cannot smuggle horizontal authority in
//         behind it. Every containment derivation in this file uses this number.
//
//       A_CEIL3 = A_HCEIL / NY_MIN = 130.61 m/s^2
//         The absolute 3-D bound on anything this module writes. NY_MIN =
//         0.4517 is the MEASURED minimum surface n_y over |s| <= 150 m,
//         z in [-140, 2541] — a superset of the containment set, a 63.1 deg
//         face. By construction this can only bind on ground steeper than
//         anything in that set, so it is a guard: rs.confine.ceil3Frames says
//         whether the guard ever fired. It is 0 on every harness drive, and it
//         DOES fire (57 frames at 60 Hz) in the self-test that spawns the rider
//         260 m outside the corridor — which is ground outside the containment
//         set, exactly where the guard is supposed to be the binding constraint.
//
//     Publishing only the smaller number would understate what the module
//     writes; publishing only the larger would overstate what it can contain.
//     Both are in config (ceilAccelHorizontal_mps2, ceilAccel3D_mps2) and both
//     are asserted in the self-test.
//
//   3.6 WHAT IS NOT PROMISED
//
//     Confinement is not free, and this module does not pretend it is. Every
//     correction takes energy out of the rider. It is priced at zero for a
//     competent player only because the layers sit outside the line a competent
//     player takes (34.1 m measured, berm at 55 m); a player who leans on the
//     wall pays for it, by design. Against a player boosting straight at the
//     wall the corrective acceleration is large — up to A_HCEIL, which is what
//     it takes to cancel a boost — and it is a bounded acceleration on the
//     velocity, never a position write, so RS-06's per-frame position jump stays
//     the rider's own travel.
//
//     After the finish, the run-out holds the rider indefinitely: the envelope's
//     allowance is zero at the soft line, so gravity is cancelled frame after
//     frame and the rider stays parked at z = 2521. That is a sustained
//     correction, not a one-off, and it is counted (rs.confine.activeFraction:
//     12.3% on the 240 s adversarial drive, almost all of it after the finish).
//     It is the right behaviour — the run is over and the mountain has run out —
//     but it is a standing write, and calling it anything else would be false.
//
// ---------------------------------------------------------------------------
// 4. THE LANDING LEDGER — adjudicated by the TRICK system, not by physics
//
//   Counting physics touchdowns lets the card contradict its own score.
//   physics.land() labels a touchdown from board-vs-velocity yaw and a held
//   grab; it knows nothing about uber animations, so a JA-15 bail (uber
//   incomplete at touchdown) is labelled 'clean' by physics while the trick
//   system voids the jump. A card built on the physics label reports a clean
//   landing next to a score that says otherwise.
//
//   So the ledger adjudicates every touchdown against the TRICK system, using
//   only fields the cross-lane contracts make public (CONTRACTS.md: tstate's
//   required set, plus trickState().starMult, which the hud lane's contract
//   requires every trick candidate to expose):
//
//     open   on the airborne -> grounded edge; record the physics label too.
//     close  when the trick system BANKS the jump — ts.lastAward becomes a new
//            object (identity change), which its reducer does on every
//            non-crash landing, points or no points, so a 0-point 'Air' still
//            counts as landed — or when LEDGER_WINDOW steps pass with no bank,
//            which is what a voided (crashed) jump looks like from outside.
//
//   LEDGER_WINDOW = 2 steps: 1 is DERIVED (the trick FSM freezes its verdict at
//   the touchdown step and resolves it on the following step, so a harness
//   landingOverride pass can run in between); the second is a CHOICE, one step
//   of slack for a lane candidate that defers one more. Short by design: long
//   enough to see the bank, too short to steal the next jump's.
//
//   Both verdicts are kept and reported separately:
//     results.landed / .crashed        the TRICK system's verdict (authoritative)
//     results.verdictSplits            touchdowns where physics DISAGREED
//     results.physUnlabelled           touchdowns physics had no opinion on
//   A null physics label is an absence of opinion, not a disagreement, and is
//   counted in its own field so verdictSplits cannot inflate itself on silence.
//
// ---------------------------------------------------------------------------
// 5. RESULTS — the banked award, and no invented grades
//
//   bestTrick is ts.lastAward.name: the trick system's whole banked jump
//   SUMMARY ("Frontside 360 + Grab"), which is what the player remembers and
//   what the score is actually made of — not one entry picked out of ts.awards.
//   Its banked points (ts.lastAward.points) ALREADY INCLUDE any star multiplier
//   the trick system credited, and that banked figure is the authoritative one
//   on the card.
//
//   The multiplier is reported alongside it as results.starMultAtLanding: the
//   value of the public trickState().starMult on the frame BEFORE the bank —
//   i.e. the star the rider carried into that landing. It is labelled "at
//   landing" and not "applied" because the trick system credits a star only on
//   a CLEAN landing, and clean-vs-sketchy is not on its public surface. No
//   string matching against another lane's award names, no reaching into trick
//   internals: this module must work against any candidate in that lane.
//
//   There are no grade bands and no medals. Inventing a letter ladder over an
//   unsettled speed ladder is invention wearing a hat. results.rank is null with
//   the reason attached, and results.anchors carries the REAL anchors from
//   references/REFERENCE_BAR.md §5 (uber base 13,210-22,580; ~130K for a
//   multi-star master jump) so a reader can place a score against something
//   sourced instead of against a band this module made up.
//
// ---------------------------------------------------------------------------
// 6. SELF-CHECK — what the gates measured, and what they could not
//
//   `node harness/run-runner.mjs --module sandbox/run-structure/A/run.mjs`
//     10/10, hardFails 0.
//     moduleYawAuthority_degps  0        (RS-10, bar 5)
//     maxDivergenceReached_m    0.98     (RS-05, bar 4)
//     maxCorrectionJump_m       0.421    (RS-06, bar 2 — that is the rider's own
//                                        travel in one frame; nothing is moved)
//     runDuration_s             208.9    (RS-08, band 90-260) — identical to the
//                                        same drive with NO run module attached,
//                                        because the corridor never touches a
//                                        competent line.
//
//   WHAT THOSE GATES DID NOT MEASURE, stated plainly:
//     * RS-10's in-bounds frames are frames in which this module writes nothing.
//     * RS-05/RS-06's adversarial drive never gets more than 38.6 m off centre
//       against this module (it reaches the run-out at z = 2521 and is held
//       there), so the berm, the wall and the return branch are all untouched by
//       it. bermFrames = 0 on that drive.
//     * RS-09 passes through the runner's free branch; no gate run exists.
//
//   `node sandbox/run-structure/A/selftest.mjs` drives exactly those, and
//   reports numbers rather than pass/fail alone (36 checks, all passing):
//     1. write discipline under a live corridor — no pos / heading / trick-state
//        write over 240 s; maxSelfPosDelta_m = 0 diffed around every write;
//        peak horizontal 36.28 <= 59.001; peak 3-D 37.98 <= 130.61;
//        beyondBound = 0.
//     1b. the berm, driven directly (no harness drive reaches it) — the bank
//        never exceeds g/2 anywhere and equals g/2 at and beyond the corridor
//        edge, checked at runtime against rs.confine.bankTotal_mps2.
//     2. yaw the corridor causes, per-frame counterfactual: worst 0.48 deg/s
//        over all 14,400 frames, mean 0.006 deg/s over the 1,766 corridor-active
//        ones (section 1).
//     3. the return branch under deliberate injection — spawned 260 m outside at
//        40 m/s outward under full boost, at dt = 1/60, 1/30 and 1/120: returned
//        inside the soft line every time, both ceilings held, and no frame moves
//        the rider further than physics moves them unaided. Plus a full 33 m/s
//        one-frame injection from inside the corridor: peak |s| = 144.14,
//        penetration 14.07 m against the derived MARGIN of 15.23 m.
//     4. the start gate driven from z = -60 under full boost: the rider never
//        gets within 13.7 m of the line while the light is red, the gate engages
//        for 125 frames, and the clock starts at the line.
//     5. a JA-15 bail — physics labels the touchdown 'clean', the trick system
//        voids the jump, and the ledger follows the trick system and reports the
//        disagreement in verdictSplits.
//     6. determinism, restart, and the frozen card.
//   It exits non-zero on any failure.
// ============================================================================

// --- physics anchors: live from the accepted physics module when reachable ---
// Every acceleration below is a function of constants the ACCEPTED physics
// module publishes, so a physics retune moves this corridor with it. The pinned
// copy is the standalone fallback and is reported in config.physicsAnchor.
const PINNED = { V_CAP: 33, V_BOOST: 31, TAU_BOOST: 0.7, A_LAT: 26, G_GROUND: 9.81 };
let PHYS = PINNED, PHYS_SOURCE = 'pinned';
try {
  const m = await import('../../../src/physics/physics.mjs');
  if (m?.DEFAULTS && typeof m.DEFAULTS.V_CAP === 'number') {
    PHYS = { ...PINNED, ...m.DEFAULTS };
    PHYS_SOURCE = 'live';
  }
} catch { /* standalone use: keep the pinned copy, reported in config */ }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// MEASURED — measurements of this world, taken this session against
// src/render/main.mjs. Each is a fact about the terrain or the harness, not a
// preference. Reproduce with the sweeps described in the header.
// ---------------------------------------------------------------------------
const MEASURED = {
  // render lane's tree line: main.mjs plants pines only at 55 < d < 720
  treeLine_m: 55,
  // widest line the harness probe drive `play` takes over a full run, with no
  // run module attached (p99 30.5, p50 6.9)
  probeWidestLine_m: 34.1,
  // minimum surface n_y over |s| <= 150 m, z in [-140, 2541] (a superset of the
  // containment set) — a 63.1 deg face at s = -150, z = 822
  minSurfaceNy: 0.4517,
  // terrain's own INWARD horizontal restoring acceleration along the corridor
  // lateral coordinate, both flanks, z = 0..2400 (m/s^2)
  terrainInwardPull_mps2: {
    20: { median: 1.23, min: -0.81 }, 40: { median: 2.17, min: 0.47 },
    55: { median: 2.75, min: 0.81 }, 70: { median: 3.28, min: 2.00 },
    85: { median: 3.85, min: 2.38 }, 100: { median: 4.15, min: 2.80 },
    120: { median: 4.39, min: 3.00 }, 130: { median: 4.45, min: 2.99 },
    150: { median: 4.39, min: 2.82 },
  },
  // largest top-up the berm law ever asks for, swept over the whole course
  peakBermTopUp_mps2: 1.832,
  // worst mesh-vs-physics divergence at a given lateral offset, 1.5 m grid,
  // full course (the runner's own divergence probe)
  divergenceByOffset_m: { 0: 0.87, 55: 1.00, 120: 1.13, 130: 1.23, 140: 1.47, 150: 1.81, 155: 2.01 },
  // worst divergence over THIS module's whole containment box
  // (|s| <= 145.29, z in [-136.23, 2536.23])
  divergenceInContainmentBox_m: 1.507,
  // fine-LOD region of the runner's divergence probe; the containment box must
  // lie wholly inside it
  fineLodZ: [-250, 2750],
  // yaw this module CAUSES, per-frame counterfactual (fork the state before the
  // write, advance both forks one step with the same input), over the harness's
  // 240 s adversarial drive — including every frame RS-10 excludes
  yawCausedWorst_degps: 0.48,
  yawCausedMeanOnActiveFrames_degps: 0.006,
};

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W_WALL = B.halfWidth ?? 120;             // contract corridor edge

  // ---------------- physics-derived firmnesses (header 3.2) -----------------
  const V_CAP = PHYS.V_CAP;                      // 33
  const V_BOOST = PHYS.V_BOOST;                  // 31
  const TAU = PHYS.TAU_BOOST;                    // 0.7
  const G = PHYS.G_GROUND;                       // 9.81
  const DT_REF = 1 / 60;                         // CONTRACTS.md: fixed 60 Hz
  // Boost is a first-order relaxation toward V_BOOST with time constant
  // TAU_BOOST, so at rest it delivers V_BOOST/TAU_BOOST, aimed wherever the
  // board points: the strongest drive a player can command.
  const DRIVE_MAX = V_BOOST / TAU;                          // 44.286
  // The strongest acceleration the world can apply in any single direction.
  const A_STOP = DRIVE_MAX + G;                             // 54.096
  // A slope's inward HORIZONTAL restoring accel is (g/2)*sin(2*theta) <= g/2.
  // No bank can exceed this, so no berm may either — and by the same identity
  // g/2 is also the worst OUTWARD horizontal pull the mountain can apply, so a
  // berm ceilinged here exactly cancels the worst adverse lateral gravity.
  const A_BERM_MAX = G / 2;                                 // 4.905
  // HORIZONTAL write ceiling: the firmest boundary plus the strongest berm that
  // can co-fire with it, and not one m/s^2 more.
  const A_HCEIL = A_STOP + A_BERM_MAX;                      // 59.001
  // 3-D write ceiling. A grounded push must lie in the tangent plane, so
  // delivering h horizontally costs h/n_y of 3-D magnitude; NY_MIN is the
  // MEASURED steepest ground in the containment set. This is the absolute bound
  // on anything this module writes, published rather than left implicit.
  const NY_MIN = MEASURED.minSurfaceNy;                     // 0.4517
  const A_CEIL3 = A_HCEIL / NY_MIN;                         // 130.61
  // references/REFERENCE_BAR.md TN-08: brake decel defend 4.5 (band 3-6).
  const A_BRAKE = 4.5;

  // ---------------- spans follow from firmness ------------------------------
  const span = A => (V_CAP * V_CAP) / (2 * A);
  const WALL_SPAN = span(A_STOP);                           // 10.066 m
  const RUNOUT = span(A_BRAKE);                             // 121.0 m
  const GATE_SPAN = RUNOUT;                                 // same law, same firmness
  // TRACKABILITY. A boundary is TRACKED — held with negligible overshoot — only
  // if the module can deliver both the envelope's own decel AND cancel the drive
  // that opposes it, inside the horizontal ceiling:
  //     A_TRACK = A_HCEIL - DRIVE_MAX - g/2 = g = 9.81 m/s^2
  // (the arithmetic collapses exactly to g). A_BRAKE = 4.5 is under it, so the
  // run-out, the back-stop and the closed gate are all tracked. A_STOP = 54.1
  // is far over it, so the lateral wall is NOT tracked and the rider overshoots
  // it — MARGIN below is the exact size of that overshoot.
  const A_TRACK = A_HCEIL - DRIVE_MAX - A_BERM_MAX;         // 9.81

  // ---------------- soft lines, and the bound one MARGIN outside ------------
  // Worst penetration past a soft line, derived with the drive and the speed
  // COUPLED (they are not independent: physics' boost is a relaxation toward
  // V_BOOST, so an outward rate of w leaves only (V_BOOST-w)/TAU of drive, and
  // at w >= V_BOOST the boost pushes nothing at all).
  //   net inward accel at outward rate w, worst case, grounded:
  //     a(w) = A_HCEIL - max(0,(V_BOOST-w)/TAU) - g/2
  //          = g + w/TAU                      for w <  V_BOOST
  //          = A_STOP                         for w >= V_BOOST
  //   (the berm's g/2 ceiling cancels the worst outward gravity exactly, which
  //    is why the residual at w = 0 is exactly g)
  //   MARGIN = integral of w/a(w) dw from 0 to V_CAP, plus one unseen frame at
  //   V_CAP — the module reads the rider after physics has already moved them.
  const wB = Math.min(V_BOOST, V_CAP);
  const MARGIN =
      TAU * (wB - G * TAU * Math.log(1 + wB / (G * TAU)))        // 13.493 m
    + Math.max(0, V_CAP * V_CAP - wB * wB) / (2 * A_STOP)        //  1.183 m
    + V_CAP * DT_REF;                                            //  0.550 m
                                                                 // = 15.226 m

  const W_BERM = env.bermStart_m ?? MEASURED.treeLine_m;    // 55, cited
  const L_SOFT = W_WALL + WALL_SPAN;                        // 130.066
  const L_BOUND = L_SOFT + MARGIN;                          // 145.291
  const Z_SOFT_DOWN = zFinish + RUNOUT;                     // 2521.0
  const Z_BOUND_DOWN = Z_SOFT_DOWN + MARGIN;                // 2536.226
  const Z_SOFT_UP = zStart - RUNOUT;                        // -121.0
  const Z_BOUND_UP = Z_SOFT_UP - MARGIN;                    // -136.226

  const COUNTDOWN_S = env.countdown_s ?? 3;      // CHOICE (presentation only)
  const SPLITS = 3;                              // CHOICE (presentation only)
  const LEDGER_WINDOW = 2;                       // 1 derived + 1 slack (header 4)

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth: W_WALL,
    maxDivergence_m: 4,          // the CONTRACT's ceiling (RS-05), as defined
    // ---- this module's own guarantee, published separately ----
    divergenceInContainmentBox_m: MEASURED.divergenceInContainmentBox_m,
    // ---- corridor geometry ----
    bermStart_m: W_BERM, wallStart_m: W_WALL,
    lateralSoftLine_m: L_SOFT, lateralBound_m: L_BOUND,
    zSoftDown_m: Z_SOFT_DOWN, zBoundDown_m: Z_BOUND_DOWN,
    zSoftUp_m: Z_SOFT_UP, zBoundUp_m: Z_BOUND_UP,
    runout_m: RUNOUT, gateSpan_m: GATE_SPAN, margin_m: MARGIN,
    trackableFirmness_mps2: A_TRACK,
    // ---- firmnesses ----
    driveMax_mps2: DRIVE_MAX, stopFirmness_mps2: A_STOP,
    brakeFirmness_mps2: A_BRAKE, bermMax_mps2: A_BERM_MAX,
    ceilAccelHorizontal_mps2: A_HCEIL, ceilAccel3D_mps2: A_CEIL3,
    minSurfaceNy: NY_MIN,
    // ---- run ----
    countdown_s: COUNTDOWN_S, splitCount: SPLITS,
    ledgerWindow_steps: LEDGER_WINDOW,
    // ---- provenance ----
    physicsAnchor: PHYS_SOURCE,
    measured: MEASURED,
    derivation: {
      law: 'one allowance on the outward rate: +sqrt(2*A_IN*(-p)) inside the soft line, -sqrt(2*A_OUT*p) outside it. Zero exactly at the line, continuous across it; the field removes the excess over it and nothing else.',
      discreteForm: 'the inside branch is solved for the step about to be taken: w_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*(-p)), so the line cannot be crossed by braking one step late at any dt',
      returnBranch: 'past the soft line the requirement inverts: the rider must be coming back fast enough to arrive at the line with zero speed. Braking alone only stops a rider going out fast, not going out.',
      firmnessNotSpan: 'A = V_CAP^2/(2*span) ties firmness to span; this module defends the FIRMNESS in every case and lets the span follow. Sizing a barrier from the room that happens to be available is how a barrier ends up unable to hold.',
      stopFirmness: 'DRIVE_MAX + g, with DRIVE_MAX = V_BOOST/TAU_BOOST from the accepted physics module\'s own boost law at rest: the strongest acceleration the world can apply in any single direction, so a boundary this firm cannot be outrun in principle',
      brakeFirmness: 'CITED references/REFERENCE_BAR.md TN-08 brake decel defend 4.5 (band 3-6) — the run-out, the back-stop and the closed gate decelerate at exactly the rider\'s own brake authority, which is what "coast to a stop" means',
      trackability: 'A_HCEIL - DRIVE_MAX - g/2 = g = 9.81 m/s^2 is the firmest boundary the module can TRACK (hold with negligible overshoot) against a rider driving into it at full boost, because it must deliver the envelope\'s own decel AND cancel the drive. A_BRAKE = 4.5 is under it, so the run-out, back-stop and gate are tracked. A_STOP = 54.1 is five times over it, so the lateral wall is deliberately NOT tracked and MARGIN is the size of the overshoot. That choice is forced by room: a trackable lateral envelope needs V_CAP^2/(2g) = 55.5 m of span, and only ~30 m separates the contract halfWidth from the divergence-safe ceiling. The alternative is to start pushing at |s| = 74.5 m, inside the corridor the contract calls in-bounds.',
      returnCap: 'the return requirement is capped at V_CAP, the physics module\'s own hard speed clamp: the corridor may not demand a speed physics itself forbids. Uncapped, the mirrored envelope asks for 118 m/s at 130 m outside.',
      bermMax: 'g/2. A slope\'s inward horizontal restoring accel is (g/2)*sin(2*theta), maximal at 45 deg. No bank can exceed g/2, so no berm may either. 18.9% of the physics A_LAT ceiling (26), so full lock still overrules it.',
      bermLaw: 'a_berm = q^2 * max(0, g/2 - a_terrain_inward), q = clamp((|s|-55)/(120-55),0,1). MEASURED: the gully already pulls 4.39 m/s^2 (median) / 3.00 (min) inward at |s| = 120, so the berm TOPS UP to the strongest bank a slope can be rather than adding to a bank already near its ceiling. Peak contribution measured over the whole course: 1.832 m/s^2. q^2 is the lowest-order polynomial zero-with-zero-slope at the tree line and 1 at the corridor edge.',
      bermStart: 'CITED: the render lane plants pines only at 55 < d < 720 (src/render/main.mjs). Also 1.6x the widest line the probe drive takes (34.1 m measured), which is why the corridor never fires in ordinary play.',
      wallStart: 'the contract halfWidth, not a number of this module\'s own. The soft line is placed one span V_CAP^2/(2*A_STOP) = 10.07 m outside it, so the allowance is exactly V_CAP at |s| = halfWidth by construction and the corridor imposes nothing anywhere the contract calls in-bounds. The only thing chosen here is the firmness.',
      ceilAccel: 'TWO ceilings, both published and both enforced. Horizontal: A_STOP + g/2 = 59.001, the firmest boundary plus the strongest berm that can co-fire with it, and not one m/s^2 more. 3-D: that divided by NY_MIN = 0.4517, the MEASURED steepest ground in the containment set, because a grounded push must lie in the tangent plane and delivering h horizontally costs h/n_y. The difference between the two is vertical bookkeeping that keeps the push on the snow; it does no containment work, which is why the containment derivation uses the horizontal number and the disclosure uses the 3-D one.',
      margin: 'the integral of w/a(w) dw from 0 to V_CAP, plus one unseen frame at V_CAP (the module reads the rider after physics has moved them; DT_REF fixed by CONTRACTS.md). a(w) is the NET inward acceleration at outward rate w with the drive and the speed COUPLED, which they are: physics\' boost is a relaxation toward V_BOOST, so a rider already leaving at w has only (V_BOOST-w)/TAU of drive left and none at all past V_BOOST. a(w) = A_HCEIL - max(0,(V_BOOST-w)/TAU) - g/2 = g + w/TAU below V_BOOST and A_STOP above it — the berm\'s g/2 ceiling cancels the worst outward gravity exactly, so the residual at w = 0 is exactly g. 13.493 + 1.183 + 0.550 = 15.226 m.',
      containmentBound: 'soft line + MARGIN. A BOUND, not a barrier: nothing is placed there, nothing fires there, and rs.confine.beyondBound counts frames past it (0 on every drive measured).',
      divergence: 'CHECKED, NOT CHOSEN: worst mesh-vs-physics divergence over the whole containment box (|s| <= 145.291, z in [-136.226, 2536.226]) is 1.507 m, under half of RS-05\'s 4 m ceiling, and the box lies wholly inside the fine-LOD region z in [-250, 2750]. The sweep is a constraint the derived geometry must satisfy, not the source of any number. Had it failed, the firmnesses would have had to rise.',
      choices: 'countdown_s = 3 and splitCount = 3 are CHOICES (presentation only, no physical claim). ledgerWindow_steps = 2 is 1 derived + 1 step of slack (CHOICE). The 2x safety factor on the divergence check (aiming at half of RS-05\'s ceiling rather than at it) is a CHOICE. Nothing else in this block is a preference.',
      rank: 'absent by decision: no defensible speed ladder exists yet, and a grade band over an unsettled ladder is invention. results.anchors carries the sourced anchors instead.',
    },
  };

  // ---- corridor centre + its derivative, cached on the 25 m grid the
  //      centreline itself is quantised to ----
  const cCache = new Map();
  function cx(z) {
    const k = Math.round(z / 25) * 25;
    let v = cCache.get(k);
    if (v === undefined) { v = rawCenter(k); cCache.set(k, v); }
    return v;
  }
  const cxPrime = z => (cx(z + 25) - cx(z - 25)) / 50;

  // Terrain normal by central difference on the SAME 0.05 m stencil the physics
  // module's default sampleNormal uses, so the plane this module pushes along is
  // exactly the plane physics will project the result against.
  function normalAt(x, z) {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  }

  // Tangential gravity on the surface at (x,z): g_vec - (g_vec . n) n, with
  // g_vec = (0, -G, 0). Returns [gx, gy, gz]; the horizontal pair is the pull
  // the ground itself applies.
  function tangentGravity(n) {
    const gdn = -G * n[1];
    return [-gdn * n[0], -G - gdn * n[1], -gdn * n[2]];
  }

  // THE ALLOWANCE (header 3.2). p = signed distance past the soft line
  // (negative inside). Returns the fastest OUTWARD rate permitted there:
  // positive inside (a braking envelope reaching zero exactly at the line),
  // negative outside (a mirrored return requirement reaching the line at rest).
  // The return requirement is capped at V_CAP: the corridor may not demand a
  // speed the physics module's own hard clamp forbids, and an uncapped mirrored
  // envelope would ask for 118 m/s at 130 m out and deliver a return the rider
  // could never have reached under their own power.
  function allowOutward(p, A_IN, A_OUT, dt) {
    if (p <= 0) {
      const gap = -p;
      return -A_IN * dt + Math.sqrt(A_IN * A_IN * dt * dt + 2 * A_IN * gap);
    }
    return -Math.min(V_CAP, Math.sqrt(2 * A_OUT * p));
  }

  // Inward acceleration this boundary demands: exactly the excess of the
  // outward rate over the allowance, and nothing else. Never negative — a
  // boundary can hold, it can never push a rider away from itself.
  function demand(p, w, A_IN, A_OUT, dt) {
    const excess = w - allowOutward(p, A_IN, A_OUT, dt);
    return excess > 0 ? excess / dt : 0;
  }

  function init() {
    return {
      // ---- contract-required ----
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: 1,               // single-rider gauntlet build: always P1
      results: null,
      outOfBounds: false,
      // ---- run presentation ----
      stage: 'countdown',     // 'countdown' | 'running' | 'finished'
      countdown_s: COUNTDOWN_S,
      light: 'red',           // 'red' | 'set' | 'go'
      gateOpen: false,
      progress: 0,            // 0..1 down the course
      splits: [],             // [{ index, z, t }]
      nextSplit: 0,
      // ---- live telemetry (feeds the HUD and the results card) ----
      speed_kmh: 0,
      topSpeed_kmh: 0,
      airTime_s: 0,
      biggestAir_s: 0,
      distanceRidden_m: 0,
      jumps: 0,
      landed: 0,              // touchdowns the TRICK system banked
      crashed: 0,             // touchdowns the TRICK system voided
      verdictSplits: 0,       // touchdowns where physics DISAGREED with tricks
      physUnlabelled: 0,      // touchdowns physics had no opinion on (not a split)
      unresolvedTouchdowns: 0,// touchdowns the finish line beat to adjudication
      bestTrick: null,
      bestTrickPoints: 0,
      starMultAtLanding: 1,   // public trickState().starMult carried into the bank
      lastTrick: null,
      banks: 0,
      // ---- confinement telemetry (self-measured, not self-reported) ----
      confine: {
        active: false,          // any corrective accel this frame
        depth_m: 0,             // how far past the nearest soft line, this frame
        accel_mps2: 0,          // 3-D magnitude applied this frame
        peakBerm_mps2: 0,       // largest berm top-up actually applied
        terrainPull_mps2: 0,    // the ground's own inward pull, this frame
        bankTotal_mps2: 0,      // terrain + berm, this frame (= g/2 at q = 1)
        peakDemand_mps2: 0,     // largest boundary demand BEFORE the ceilings
        peakApplied_mps2: 0,    // largest 3-D applied, always <= A_CEIL3
        peakAppliedH_mps2: 0,   // largest horizontal applied, always <= A_HCEIL
        peakDepth_m: 0,
        peakOffset_m: 0,        // widest line the rider has taken
        bermFrames: 0,
        wallFrames: 0,          // brake branch fired
        limitFrames: 0,         // return branch fired (past a soft line)
        gateFrames: 0,          // closed gate held the rider (0 in-harness)
        ceilFrames: 0,          // the horizontal ceiling A_HCEIL actually bound
        ceil3Frames: 0,         // the 3-D guard A_CEIL3 actually bound (want 0)
        beyondBound: 0,         // frames past a containment bound (want 0)
        activeFrames: 0,
        totalFrames: 0,
        activeFraction: 0,
        maxSelfVelDelta_mps: 0, // largest velocity change the module has made
        selfPosDelta_m: 0,      // |ph.pos| change across this module's write
        maxSelfPosDelta_m: 0,   //   block, diffed every frame — computed, not asserted
      },
      // ---- internals ----
      _t: 0,                  // total elapsed sim time, all phases
      _startedPast: null,     // rider began past zStart (rolling start)?
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
      _prevAward: null,
      _starPrev: 1,           // trickState().starMult as of the PREVIOUS step
      _ledger: null,          // open touchdown awaiting the trick verdict
    };
  }

  // ------------------------------------------------------------------ results
  // The one place a card is built. `live` is the in-progress readback the HUD
  // shows; the frozen card handed out after the finish is the SAME function
  // called once, so the two can never drift apart.
  function assemble(rs, ts, live) {
    const t = ts ?? {};
    return {
      // ---- contract-required six ----
      time_s: +rs.time_s.toFixed(3),
      score: t.score ?? 0,
      bestTrick: rs.bestTrick,
      tricky: !!t.tricky,
      landed: rs.landed,
      crashed: rs.crashed,
      // ---- the banked award, in full (header 5) ----
      bestTrickPoints: Math.round(rs.bestTrickPoints),
      starMultAtLanding: rs.starMultAtLanding,
      lastTrick: rs.lastTrick ? { ...rs.lastTrick } : null,
      banks: rs.banks,
      trickyLetters: t.trickyLetters ?? 0,
      meter: +(t.meter ?? 0).toFixed(3),
      // ---- the run ----
      place: rs.place,
      jumps: rs.jumps,
      verdictSplits: rs.verdictSplits,
      physUnlabelled: rs.physUnlabelled,
      unresolvedTouchdowns: rs.unresolvedTouchdowns,
      topSpeed_kmh: +rs.topSpeed_kmh.toFixed(1),
      avgSpeed_kmh: rs.time_s > 0 ? +(3.6 * rs.distanceRidden_m / rs.time_s).toFixed(1) : 0,
      airTime_s: +rs.airTime_s.toFixed(2),
      biggestAir_s: +rs.biggestAir_s.toFixed(2),
      distanceRidden_m: Math.round(rs.distanceRidden_m),
      courseLength_m: zFinish - zStart,
      splits: rs.splits.map(sp => ({ index: sp.index, z: sp.z, t: +sp.t.toFixed(3) })),
      // ---- how the module behaved, on the card, not just in the state ----
      confinement: {
        activeFraction: +rs.confine.activeFraction.toFixed(5),
        peakOffset_m: +rs.confine.peakOffset_m.toFixed(1),
        peakApplied_mps2: +rs.confine.peakApplied_mps2.toFixed(2),
        peakAppliedH_mps2: +rs.confine.peakAppliedH_mps2.toFixed(2),
        peakBerm_mps2: +rs.confine.peakBerm_mps2.toFixed(2),
        bermFrames: rs.confine.bermFrames,
        wallFrames: rs.confine.wallFrames,
        limitFrames: rs.confine.limitFrames,
        gateFrames: rs.confine.gateFrames,
        ceilFrames: rs.confine.ceilFrames,
        ceil3Frames: rs.confine.ceil3Frames,
        beyondBound: rs.confine.beyondBound,
        maxSelfPosDelta_m: rs.confine.maxSelfPosDelta_m,
      },
      // ---- no letter grade, no medal: sourced anchors instead ----
      rank: null,
      rankReason: live ? 'run in progress'
        : 'no defensible speed ladder yet — see config.derivation.rank',
      anchors: {
        uberBaseMin: 13210, uberBaseMax: 22580, masterJumpAnchor: 130000,
        source: 'references/REFERENCE_BAR.md §5 (Uber Trick Guide table; 20,960 x2 x3 ~ 130K master jump)',
      },
    };
  }

  // ------------------------------------------------------------- observation
  // Read-only on both systems.
  function observe(rs, ph, ts, dt) {
    // --- airtime ---
    const air = !ph.onGround;
    if (air) {
      rs._airRun += dt;
      rs.airTime_s += dt;
      if (rs._airRun > rs.biggestAir_s) rs.biggestAir_s = rs._airRun;
      if (!rs._wasAir) rs.jumps++;
    } else rs._airRun = 0;

    // --- landing ledger (header 4): open on the airborne -> grounded edge ---
    if (rs._wasAir && !air) {
      if (rs._ledger) closeLedger(rs, false);   // bounce inside the window
      rs._ledger = { steps: 0, physVerdict: ph.landing ?? null };
    }
    rs._wasAir = air;

    // --- banked tricks. The trick system's reducer replaces ts.lastAward with
    //     a NEW object on every non-crash landing (points or no points) and
    //     nulls it on a crash, so an identity change is exactly one bank. ---
    const la = ts?.lastAward ?? null;
    let banked = false;
    if (la && la !== rs._prevAward) {
      banked = true;
      rs.banks++;
      // The star the rider CARRIED INTO this landing: the public
      // trickState().starMult as of the previous step, because the trick
      // system consumes the star in the same step it banks the jump. The
      // authoritative banked figure is la.points, which already includes any
      // multiplier the trick system actually credited.
      const mult = rs._starPrev;
      rs.lastTrick = { name: la.name, points: la.points, starMultAtLanding: mult,
        at_s: +rs.time_s.toFixed(3) };
      if (rs.bestTrick === null || la.points > rs.bestTrickPoints) {
        rs.bestTrick = la.name;
        rs.bestTrickPoints = la.points;
        rs.starMultAtLanding = mult;
      }
    }
    rs._prevAward = la;
    const sm = ts?.starMult;
    rs._starPrev = typeof sm === 'number' && sm >= 1 ? sm : 1;

    // resolve the open touchdown against that verdict
    if (rs._ledger) {
      if (banked) closeLedger(rs, true);
      else if (++rs._ledger.steps > LEDGER_WINDOW) closeLedger(rs, false);
    }

    // --- speed / distance ---
    const v = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_kmh = v * 3.6;
    if (rs.speed_kmh > rs.topSpeed_kmh) rs.topSpeed_kmh = rs.speed_kmh;
    if (rs._prevPos) {
      rs.distanceRidden_m += Math.hypot(ph.pos[0] - rs._prevPos[0], ph.pos[2] - rs._prevPos[2]);
      rs._prevPos[0] = ph.pos[0]; rs._prevPos[1] = ph.pos[1]; rs._prevPos[2] = ph.pos[2];
    } else rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
  }

  // The trick system banked it -> landed; it never did -> the jump was voided.
  // The physics label is kept only to REPORT the disagreement. A null label is
  // an absence of opinion, counted separately so verdictSplits cannot inflate
  // itself on silence.
  function closeLedger(rs, bankedIt) {
    const L = rs._ledger;
    rs._ledger = null;
    if (!L) return;
    if (bankedIt) rs.landed++; else rs.crashed++;
    if (L.physVerdict === null) { rs.physUnlabelled++; return; }
    const physSaysClean = L.physVerdict !== 'crash';
    if (physSaysClean !== bankedIt) rs.verdictSplits++;
  }

  // ----------------------------------------------------------- confinement
  // Applies bounded ACCELERATIONS in corridor coordinates. Never writes
  // position, heading, or any physics flag.
  //
  // COORDINATES. s = x - centreX(z) is the lateral offset (the coordinate every
  // divergence measurement is stated in) and z is down-course progress (the
  // coordinate the finish line and the z-limits are stated in), with
  // k = centreX'(z). Their rates are
  //     ds/dt = vx - k*vz        dz/dt = vz
  // so a correction that must produce a given (d2s/dt2, d2z/dt2) has exactly
  // one horizontal solution:
  //     az = d2z/dt2             ax = d2s/dt2 + k * az
  // The module solves that rather than decomposing onto corridor normal/tangent
  // unit vectors, which would deliver only 1/sqrt(1+k^2) of what it asks for
  // (12% short where the course meanders hardest) — exactly the kind of quiet
  // slack that lets a guarantee be violated. A purely lateral correction here
  // leaves dz/dt untouched by construction.
  function confine(rs, ph, dt, gateClosed) {
    const c = rs.confine;
    c.totalFrames++;
    c.active = false; c.accel_mps2 = 0; c.depth_m = 0; c.selfPosDelta_m = 0;
    c.terrainPull_mps2 = 0; c.bankTotal_mps2 = 0;

    const x = ph.pos[0], z = ph.pos[2];
    const s = x - cx(z);
    const k = cxPrime(z);
    const sAbs = Math.abs(s), out = s >= 0 ? 1 : -1;
    if (sAbs > c.peakOffset_m) c.peakOffset_m = sAbs;
    const sRate = (ph.vel[0] - k * ph.vel[2]) * out;   // outward rate, +ve = leaving
    const zRate = ph.vel[2];

    let aIn = 0;        // inward (toward the centreline) lateral acceleration
    let aZ = 0;         // down-course acceleration, +ve = down-course

    // ---- LAYER 1. BERM: the terrain's own bank, topped up to g/2 -----------
    //      Grounded only — a berm is ground.
    let n = null;
    if (ph.onGround && sAbs > W_BERM) {
      n = normalAt(x, z);
      const gt = tangentGravity(n);
      // the ground's own inward pull, in the corridor's lateral coordinate
      const terrIn = -out * (gt[0] - k * gt[2]);
      const q = clamp((sAbs - W_BERM) / (W_WALL - W_BERM), 0, 1);
      const berm = q * q * Math.max(0, A_BERM_MAX - terrIn);
      // published so the berm's central claim is checkable at runtime: at and
      // beyond the corridor edge (q = 1) terrain + berm is exactly g/2, the
      // strongest bank any slope can be, wherever the mountain is shallower
      c.terrainPull_mps2 = terrIn;
      c.bankTotal_mps2 = terrIn + berm;
      if (berm > 0) {
        aIn += berm;
        c.bermFrames++;
        if (berm > c.peakBerm_mps2) c.peakBerm_mps2 = berm;
      }
    }

    // ---- LAYERS 2 & 3. WALL (brake) and LIMIT (return), one allowance ------
    const pLat = sAbs - L_SOFT;
    const dLat = demand(pLat, sRate, A_STOP, A_STOP, dt);
    if (dLat > 0) {
      aIn += dLat;
      if (pLat > 0) c.limitFrames++; else c.wallFrames++;
      if (dLat > c.peakDemand_mps2) c.peakDemand_mps2 = dLat;
    }
    if (pLat > 0) {
      c.depth_m = pLat;
      if (pLat > c.peakDepth_m) c.peakDepth_m = pLat;
      if (sAbs > L_BOUND) c.beyondBound++;
    }

    // ---- down-course: closed gate, or the run-out past the finish ----------
    const softDown = gateClosed ? zStart : Z_SOFT_DOWN;
    const firmDown = A_BRAKE;   // same law, same firmness: both are tracked
    const pDown = z - softDown;
    const dDown = demand(pDown, zRate, firmDown, A_STOP, dt);
    if (dDown > 0) {
      aZ -= dDown;
      if (gateClosed) c.gateFrames++;
      else if (pDown > 0) c.limitFrames++; else c.wallFrames++;
      if (dDown > c.peakDemand_mps2) c.peakDemand_mps2 = dDown;
    }
    if (pDown > 0) {
      c.depth_m = Math.max(c.depth_m, pDown);
      if (!gateClosed && z > Z_BOUND_DOWN) c.beyondBound++;
    }

    // ---- up-course back-stop (outward is -z) -------------------------------
    const pUp = Z_SOFT_UP - z;
    const dUp = demand(pUp, -zRate, A_BRAKE, A_STOP, dt);
    if (dUp > 0) {
      aZ += dUp;
      if (pUp > 0) c.limitFrames++; else c.wallFrames++;
      if (dUp > c.peakDemand_mps2) c.peakDemand_mps2 = dUp;
    }
    if (pUp > 0) {
      c.depth_m = Math.max(c.depth_m, pUp);
      if (z < Z_BOUND_UP) c.beyondBound++;
    }

    if (aIn === 0 && aZ === 0) {
      c.activeFraction = c.activeFrames / c.totalFrames;
      rs.outOfBounds = false;
      return;
    }

    // ---- assemble the world-space correction (exact solve, see above) ------
    let uz = aZ;
    let ux = -aIn * out + k * aZ;
    let uy = 0;

    // ---- ceiling 1: the HORIZONTAL correction, which is the only part that
    //      does containment work. Applied before the tangent lift so the lift
    //      cannot smuggle horizontal authority in behind it.
    const hm = Math.hypot(ux, uz);
    if (hm > A_HCEIL) { const f = A_HCEIL / hm; ux *= f; uz *= f; c.ceilFrames++; }

    if (ph.onGround) {
      // You cannot push a board into or out of the snow, only along it. There
      // is exactly one tangent-plane vector whose horizontal shadow is the
      // correction the envelope asked for, so take that one — no authority is
      // lost to a projection and none is invented by a rescale. It also keeps
      // the push out of the physics module's magnitude-preserving grounded
      // redirect, which would otherwise launder a component pointed into the
      // hill back out as forward speed: a confiner that accidentally boosts.
      if (!n) n = normalAt(x, z);
      if (n[1] > 1e-3) uy = -(ux * n[0] + uz * n[2]) / n[1];
    }

    // ---- ceiling 2: the absolute 3-D bound on anything this module writes.
    //      By construction it can only bind where n_y < NY_MIN, i.e. on ground
    //      steeper than anything measured in the containment set; it is a guard,
    //      and ceil3Frames says whether the guard ever fired.
    let am = Math.hypot(ux, uy, uz);
    if (am > A_CEIL3) { const f = A_CEIL3 / am; ux *= f; uy *= f; uz *= f; am = A_CEIL3; c.ceil3Frames++; }

    // ---- the ONLY write this module makes, with pos diffed around it -------
    const px = ph.pos[0], py = ph.pos[1], pz = ph.pos[2];
    ph.vel[0] += ux * dt; ph.vel[1] += uy * dt; ph.vel[2] += uz * dt;
    const moved = Math.abs(ph.pos[0] - px) + Math.abs(ph.pos[1] - py) + Math.abs(ph.pos[2] - pz);
    c.selfPosDelta_m = moved;
    if (moved > c.maxSelfPosDelta_m) c.maxSelfPosDelta_m = moved;

    const dv = am * dt;
    if (dv > c.maxSelfVelDelta_mps) c.maxSelfVelDelta_mps = dv;
    if (am > c.peakApplied_mps2) c.peakApplied_mps2 = am;
    const amh = Math.hypot(ux, uz);
    if (amh > c.peakAppliedH_mps2) c.peakAppliedH_mps2 = amh;
    c.accel_mps2 = am;
    c.active = true;
    c.activeFrames++;
    c.activeFraction = c.activeFrames / c.totalFrames;
    // outOfBounds is raised for EVERY frame the module touches the rider — the
    // gentlest berm frame included — so an auditor sees every frame in which
    // this module could possibly have moved them.
    rs.outOfBounds = true;
  }

  // ------------------------------------------------------------------ step
  function step(rs, physState, trickState, dt) {
    const ph = physState;
    if (!ph || !dt) return rs;
    rs._t += dt;

    // ---------- ready: the clock reads 0 and the gate is a boundary ---------
    if (rs.phase === 'ready') {
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.gateOpen = rs.countdown_s <= 0;
      rs.light = rs.countdown_s > COUNTDOWN_S / 3 ? 'red' : rs.countdown_s > 0 ? 'set' : 'go';
      rs.progress = 0;
      // Was the rider ever actually behind the gate? Decided on the first step
      // and never revisited. A rider who starts PAST the line (the harness seeds
      // at z = 15) has a rolling start and the gate is behind them — it must
      // never reach forward and drag them back. A rider who starts behind it is
      // held until the light goes green, and nosing over the line while it is
      // red does not start the run.
      if (rs._startedPast === null) rs._startedPast = ph.pos[2] >= zStart;
      if (ph.pos[2] >= zStart && (rs._startedPast || rs.gateOpen)) {
        rs.phase = 'running'; rs.stage = 'running'; rs.light = 'go';
        rs.gateOpen = true;
        rs.time_s = 0;
        rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
        rs.nextSplit = 0; rs.splits = [];
      } else {
        // still behind the line: the corridor holds, and while the countdown
        // runs its down-course soft line sits on the start line (closed gate)
        confine(rs, ph, dt, !rs.gateOpen);
        return rs;
      }
    }

    // ---------- running: clock, telemetry, splits, finish, corridor ---------
    if (rs.phase === 'running') {
      rs.time_s += dt;
      observe(rs, ph, trickState, dt);
      rs.progress = clamp((ph.pos[2] - zStart) / (zFinish - zStart), 0, 1);

      while (rs.nextSplit < SPLITS - 1) {
        const zc = zStart + ((rs.nextSplit + 1) / SPLITS) * (zFinish - zStart);
        if (ph.pos[2] < zc) break;
        rs.splits.push({ index: rs.nextSplit + 1, z: Math.round(zc), t: rs.time_s });
        rs.nextSplit++;
      }

      // FINISH — tested before the corridor, so the crossing frame is the frame
      // that reports 'finished' and the run-out can never block it.
      if (ph.pos[2] >= zFinish) {
        rs.splits.push({ index: SPLITS, z: zFinish, t: rs.time_s });
        rs.progress = 1;
        // a touchdown inside the ledger window has not been adjudicated yet and
        // the card freezes here — count it as neither landed nor crashed, and
        // say so on the card rather than guessing a verdict
        if (rs._ledger) { rs.unresolvedTouchdowns++; rs._ledger = null; }
        const res = assemble(rs, trickState, false);
        for (const sp of res.splits) Object.freeze(sp);
        Object.freeze(res.splits); Object.freeze(res.anchors);
        Object.freeze(res.confinement);
        if (res.lastTrick) Object.freeze(res.lastTrick);
        rs.results = Object.freeze(res);
        rs.finished = true;
        rs.phase = 'finished'; rs.stage = 'finished';
      }
      confine(rs, ph, dt, false);
      return rs;
    }

    // ---------- finished: clock frozen, card frozen, corridor still holds ---
    rs.speed_kmh = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6;
    confine(rs, ph, dt, false);
    return rs;
  }

  // Frozen after the finish; a live readback of the same shape before it, so the
  // HUD can show a running card mid-run.
  function results(rs, trickState) {
    return rs.results ?? assemble(rs, trickState, true);
  }

  // Full deterministic reset: every field is rebuilt from init(), in place.
  function restart(rs) {
    const fresh = init();
    for (const k of Object.keys(rs)) delete rs[k];
    Object.assign(rs, fresh);
    return rs;
  }

  return { config, init, step, results, restart };
}
