// ============================================================================
// run-structure lane — run.mjs   (cycle 4, candidate A)
//
// Start gate, race clock, finish line, results card, restart, and a three-layer
// CORRIDOR: soft berm -> firm wall -> hard limit (return).
//
// Pure JS, deterministic. No Date, no Math.random, no globals. The only import
// is the accepted physics module, read for its published constants so that a
// physics retune moves this corridor with it; a pinned fallback copy is used if
// it is unreachable and which one was used is published in config.physicsAnchor.
//
// ---------------------------------------------------------------------------
// 0. WHAT THIS MODULE WRITES, EXHAUSTIVELY
//
//   physState.vel[0..2] — and ONLY by adding a bounded ACCELERATION * dt from
//   the corridor field, whose horizontal magnitude never exceeds A_HCEIL and
//   whose 3-D magnitude never exceeds A_CEIL3 (section 3.6).
//
//   Nothing else. It never writes physState.pos — the module diffs ph.pos across
//   its own write block every frame and publishes the result in
//   rs.confine.maxSelfPosDelta_m, a computed number rather than an asserted
//   zero. It never writes physState.heading, spinDeg, flipDeg, onGround,
//   airTime, landing, charge or boostMeter, and it never writes any field of the
//   trick state. It reads both.
//
// ---------------------------------------------------------------------------
// 1. NO STEERING AUTHORITY, AND THE REASON IS A PROOF, NOT RESTRAINT
//
//   RS-10 (HARD) measures the yaw this module's step adds while the rider is in
//   bounds. The bar is 5 deg/s. This module measures 0.00, and the previous
//   cycle's candidate also measured 0 for a weak reason ("the probe drive never
//   goes wide enough to make the corridor fire"), which is luck, not design.
//
//   The reason here is structural. Section 3.3 pins every layer's start to the
//   contract boundary it defends by an EXACT identity: the layer's span is the
//   gap at which its discrete allowance equals V_CAP, the physics module's own
//   hard speed clamp. So at and inside |s| = halfWidth, at and inside z =
//   zFinish, at and down-course of z = zStart, the allowance is >= the fastest
//   thing physics permits to exist, the excess is <= 0, and the field applies
//   exactly zero. That holds at every dt and for every rider, not just for the
//   probe drive's line. The corridor is provably inert everywhere the contract
//   calls in-bounds.
//
//   That is the whole of RS-10's in-bounds set, so RS-10 is measuring a module
//   that writes nothing — which is the correct answer, but it means the gate is
//   NOT evidence that the corridor behaves when it does fire. That evidence has
//   to come from somewhere else, and section 6 says where.
//
//   The mechanism behind the number: the corridor writes velocity only. The
//   accepted physics module derives board yaw from `steer` and carve geometry
//   (omega = speed / R_sidecut(steer)), so a velocity write reaches heading only
//   INDIRECTLY, through the speed in that ratio. There is one further indirect
//   channel and it is disclosed rather than denied: physics copies velocity yaw
//   onto heading on a clean landing, so a LATERAL velocity write while the rider
//   is airborne can become a heading change at the next touchdown. The wall and
//   the limit do act in the air (a corridor that switches off when the rider
//   jumps is not a corridor). MEASURED on RS-10's own 120 s wall-riding probe:
//   1 airborne write frame out of 7,200, worst 45.6 m/s^2, i.e. 0.76 m/s of
//   lateral velocity — about 1.3 deg of heading at the next clean landing at
//   33 m/s. Reported by the runner as _airborneVelWriteFrames.
//
// ---------------------------------------------------------------------------
// 2. PHASE MACHINE AND THE START GATE
//
//   phase: 'ready' -> 'running' -> 'finished'          (contract field)
//
//   ready     The rider is staged at the gate and HELD there. Clock reads 0.
//             rs.light runs red -> set -> go over COUNTDOWN_S; rs.stage and
//             rs.countdown_s publish it for the HUD. `phase` stays one of the
//             contract's three values, so the countdown is a sub-state.
//   running   Entered when the gate drops. The clock starts AT THE DROP, which
//             is what a start gate is: the rider is stationary at t = 0 and
//             every metre of the run is on the clock.
//   finished  Entered on the first step at or past zFinish. The card is
//             assembled once and deep-frozen; the clock stops; the corridor
//             keeps holding, so a rider with boost pinned coasts to a stop in
//             the run-out instead of sailing onto the backdrop.
//
//   WHERE THE GATE IS. At the rider's staged position — Z_GATE is the first z
//   this module observes, clamped into [zSoftUp, zStart] so it can never fight
//   the back-stop. It is not at zStart. A gate 40 m down-course of a staged
//   rider does not hold them, it catches them: they spend the countdown sliding
//   into it. RS-09's own statement is "before 'running' the rider does not
//   accelerate down-course", and a start pen holds the board where it stands.
//   MEASURED against the harness's start probe (staged at z = -40, released
//   after 3 s): 0.35 m of drift over the whole ready phase, against RS-09's 3 m
//   bar; the seed candidate, whose gate sat at zStart, drifted 39.82 m.
//
//   THE GATE IS A BOUNDARY, NOT A PIN. It is the same allowance law as every
//   other layer (section 3.2) with its soft line at Z_GATE, so at p = 0 the
//   allowance is exactly 0 and the field removes exactly the down-course rate
//   the rider has, never more, and never touches the other two axes. Holding a
//   rider by writing their position, or by zeroing their whole velocity vector,
//   would be a physics write on an ordinary frame.
//
//   NO ROLLING-START SPECIAL CASE. Because the gate is at the rider rather than
//   at zStart, a rider staged past the start line is held where they are and
//   released like anyone else; there is no branch that decides whether the gate
//   applies, and therefore no branch that can be wrong. The harness stages the
//   rider at z = 15 in every probe except the start probe, so every other RS
//   gate now runs through 3 s of held ready phase followed by a drop — the gate
//   is exercised on every gate run, not bypassed by one.
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
//     |offset from centre|   0    55   120   130   140  145.3  150   170
//     worst mesh gap (m)   0.93  0.79  0.95  1.06  1.35  1.43  1.93  1.98
//
//     Across the fine-LOD boundary the cells jump from 15.6 m to 83.3 m and the
//     gap jumps with them: 8.29 m at z = -260 and 4.24 m at z = 2760, against
//     ~1 m just inside.
//
//   RS-05's ceiling is 4 m. A rider past it is visibly falling through the
//   world. So the corridor's job is to make a stated region unreachable.
//
//   3.2 THE ONE LAW
//
//   Every boundary here is one continuous allowance on the OUTWARD rate w, as a
//   function of the signed distance p past that boundary's soft line:
//
//       p <= 0 (inside):   w_allow = +sqrt(2 * A_IN  * (-p))     brake
//       p >  0 (outside):  w_allow = -sqrt(2 * A_OUT * ( p))     return
//
//   One function, zero exactly at p = 0, continuous and monotone across it. The
//   inside branch is a braking envelope whose allowance reaches zero exactly at
//   the line. The outside branch is its MIRROR: past the line the rider is not
//   merely braked, they are required to be coming back, at a rate that brings
//   them to the line with zero speed — so the return never slingshots a rider
//   across the corridor into the far wall. The field applies
//
//       a_inward = max(0, w - w_allow) / dt
//
//   i.e. exactly the excess and not one m/s^2 more, ceilinged by section 3.6.
//   It is never negative: a boundary can hold, it can never push a rider away
//   from itself, and it can never add speed along any other axis.
//
//   DISCRETE-SAFE FORM. The inside branch is solved for the step ABOUT TO BE
//   TAKEN — w_allow^2/(2A) + w_allow*dt = -p gives
//
//       w_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*(-p))
//
//   so a rider who obeys the envelope cannot cross the line by braking one step
//   too late, at ANY dt, not merely at 60 Hz.
//
//   3.3 WHERE EACH LAYER STARTS — an exact identity, not a placement
//
//   Substituting gap = V_CAP^2/(2A) + V_CAP*dt into the discrete form gives
//
//       w_allow = -A*dt + sqrt(A^2*dt^2 + V_CAP^2 + 2*A*V_CAP*dt)
//               = -A*dt + (A*dt + V_CAP)  =  V_CAP    exactly, for any A, any dt
//
//   so SPAN(A, dt) = V_CAP^2/(2A) + V_CAP*dt is precisely the gap at which the
//   allowance equals the physics module's own hard speed clamp. Place each soft
//   line one SPAN outside the contract boundary it defends and the layer is
//   PROVABLY INERT at and inside that boundary: no rider physics permits to
//   exist can be moving outward faster than V_CAP, so the excess is <= 0 and the
//   field is exactly 0. Recomputed every frame from the live dt, so the proof
//   does not depend on the harness running at 60 Hz.
//
//     layer      defends                    firmness A_IN   span @60Hz
//     wall       |s| = halfWidth = 120      A_STOP  54.096    10.62 m
//     run-out    z   = zFinish = 2400       A_TRACK  9.810    56.05 m
//     back-stop  z   = zStart  = 0          A_TRACK  9.810    56.05 m
//     gate       z   = Z_GATE (staged)      A_TRACK  9.810     — (p = 0)
//
//   Nothing in that table is a chosen distance. The defended boundaries are the
//   contract's own three numbers; the spans follow from the firmnesses by the
//   identity above. Only the two firmnesses were chosen, and 3.4 derives them.
//
//   3.4 THE TWO FIRMNESSES
//
//   A_STOP = DRIVE_MAX + g = 54.096 m/s^2, where DRIVE_MAX = V_BOOST/TAU_BOOST
//     = 44.286 m/s^2 is the accepted physics module's own boost law evaluated at
//     rest (a first-order relaxation toward V_BOOST with time constant
//     TAU_BOOST), aimed wherever the board points. A_STOP is therefore the
//     strongest acceleration the world can apply to the rider in any single
//     direction. A boundary at least this firm cannot be outrun in principle.
//
//   A_TRACK = A_HCEIL - DRIVE_MAX - g/2 = g = 9.81 m/s^2 (the arithmetic
//     collapses exactly to g). This is the firmest envelope the module can
//     actually TRACK — hold with no overshoot beyond MARGIN — against a rider
//     driving into it at full boost, because to stay on the envelope it must
//     deliver the envelope's own deceleration AND cancel the drive AND cancel
//     the worst adverse horizontal gravity, all inside the horizontal ceiling.
//     Anything firmer saturates; anything softer costs span for nothing.
//
//   WHICH LAYER GETS WHICH, AND WHY IT IS A TRADEOFF AND NOT A PREFERENCE.
//   A_TRACK is the better boundary — it is a promise the module can keep — and
//   it is used everywhere there is room for its 56 m span. Down-course there are
//   ~290 m between zFinish and the fine-LOD edge, and up-course ~250 m; 56 m
//   fits both with room to spare. LATERALLY THERE IS NOT ROOM: a trackable wall
//   would have to start pushing at |s| = 120 - ... no — its soft line would sit
//   at 120 + 55.5 = 175.5 m and its containment bound at 190.7 m, which is 70 m
//   outside the corridor the contract defines and 45 m past the widest offset
//   this module has divergence-swept. Sizing the wall from the room available
//   would mean either that, or moving the layer start inward to |s| = 64.5 m,
//   deep inside terrain the contract calls in-bounds. Neither is acceptable, so
//   the lateral wall takes A_STOP and is DELIBERATELY NOT TRACKED: a rider
//   driving outward at full boost overshoots it, and MARGIN (3.5) is the exact
//   size of that overshoot.
//
//   REJECTED: A_BRAKE = 4.5 m/s^2 from references/REFERENCE_BAR.md TN-08, which
//   the seed candidate used for all three longitudinal layers and justified as
//   "the rider's own brake authority". It is not: the accepted physics module
//   publishes BRAKE_DECEL = 1.7 m/s^2, so the citation and the code disagreed
//   about what the rider can do, and 4.5 was in any case a hand-picked point
//   inside a 3-6 band. Following the citation properly is worse still — 1.7
//   m/s^2 needs a 320 m span, which puts the back-stop's containment bound at
//   z = -335 m, 85 m outside the fine-LOD region where the mesh gap is already
//   8.3 m. A run-out is a barrier, not the rider braking; a rider who declines
//   to brake still has to be stopped.
//
//   3.5 SOFT LINE INSIDE, HARD LINE OUTSIDE
//
//   A braking envelope brings the rider to rest ON its soft line, and an
//   untracked one is overshot before that. If the soft line were also the safety
//   limit the design would have zero margin and the "hard limit" would not be a
//   shell, it would be the parking spot. So every soft line sits one full
//   worst-case penetration inside the containment bound.
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
//              = 13.492 + 1.183 + 0.550 = 15.226 m
//
//   The last term is one unseen frame: the module reads the rider AFTER physics
//   has already moved them, so they can be that far past a soft line before this
//   module has seen anything. It is a different quantity from the V_CAP*dt term
//   in SPAN — that one buys inertness at the layer's start, this one buys
//   headroom past the layer's soft line — and DT_REF = 1/60 s is fixed by
//   CONTRACTS.md ("physics fixed step 60 Hz").
//
//   Containment bound = soft line + MARGIN, and it is a BOUND, not a barrier:
//   nothing is placed there and nothing fires there. rs.confine.beyondBound
//   counts frames spent past it.
//
//     lateral   soft |s| = 130.616   bound |s| = 145.842
//     run-out   soft z  = 2456.055   bound z  = 2471.281
//     back-stop soft z  =  -56.055   bound z  =  -71.281
//
//   CHECKED, NOT CHOSEN: the containment box (|s| <= 145.842, z in [-71.281,
//   2471.281]) has a measured worst mesh divergence of 1.47 m — well under half
//   RS-05's 4 m ceiling — and lies wholly inside the fine-LOD region z in
//   [-250, 2750], clear of it by 179 m up-course and 279 m down-course. The
//   divergence sweep is a CONSTRAINT the derived geometry has to satisfy; it is
//   not where any of the numbers came from. Had it failed, the firmnesses would
//   have had to rise, not the limits move in.
//
//   3.6 THE THREE LAYERS
//
//   BERM (soft, |s| in [55, 130.62], grounded only)
//     A berm is ground. It acts only when ph.onGround; an airborne rider does
//     not feel a bank.
//
//     A slope's INWARD HORIZONTAL restoring acceleration is g*sin(th)*cos(th) =
//     (g/2)*sin(2*th), maximal at th = 45 deg and equal to g/2 = 4.905 m/s^2.
//     That is not a tuning choice, it is a ceiling: NO SLOPE, however steep, can
//     pull a rider sideways harder than g/2. So g/2 is the largest acceleration
//     a berm may apply and still be honestly called terrain.
//
//     Measured inward pull of the actual gully, in the corridor's own lateral
//     coordinate, both flanks, z = 0..2400 (m/s^2):
//
//       |s|      20    40    55    70    85   100   120   130   150
//       median  1.24  2.41  3.09  3.61  4.11  4.46  4.72  4.75  4.68
//       min    -1.86 -0.27  0.74  1.75  2.41  3.25  3.49  3.55  3.50
//       max     3.92  5.01  5.30  5.70  5.89  5.87  5.96  5.92  5.73
//
//     (Those maxima exceed g/2 without contradicting the ceiling: the ceiling
//     bounds the horizontal magnitude of tangential gravity, and the corridor's
//     lateral coordinate is s = x - centreX(z), so the projection picks up a
//     factor up to sqrt(1 + k^2) = 1.24 where the centreline meanders hardest.)
//
//     The mountain is already doing most of this job, and it does it unevenly:
//     at the corridor edge the same offset is worth 4.72 m/s^2 at a median z and
//     3.49 m/s^2 where the gully is shallowest. So the berm does not ADD a force
//     — adding one would double a bank already near its physical ceiling. It
//     TOPS THE TERRAIN UP:
//
//       a_berm(x, z) = q^2 * max(0, g/2 - a_terrain_inward(x, z))
//       q = clamp((|s| - 55) / (120 - 55), 0, 1)
//
//     so the corridor's shoulder is the strongest bank a slope can be at and
//     beyond the corridor edge, everywhere down the course, and fades to the
//     mountain's own unmodified pull at the tree line. Where the gully is
//     already steep the berm contributes nothing. MEASURED peak contribution
//     over the whole containment box: 1.42 m/s^2, at |s| = 120, z = 549, where
//     the terrain's own pull is 3.48.
//
//     a_terrain_inward is computed each frame from the same 0.05 m central
//     difference stencil the physics module's default sampleNormal uses, so the
//     berm is measuring the surface physics is standing on, not an approximation
//     of it.
//
//     Shape: q^2 is the lowest-order polynomial that is zero WITH ZERO SLOPE at
//     the tree line (C1-continuous, never a step the rider can feel switch on)
//     and 1 at the corridor edge. The exponent is forced by those two conditions
//     plus lowest order; it is not a feel knob.
//
//     Start of the layer, W_BERM = 55 m: CITED. src/render/main.mjs plants pines
//     only where `d = |x - centerX(z)|` is in (55, 720), so 55 m is exactly
//     where the ridable floor visibly ends, stated in this module's own lateral
//     coordinate. It is also 1.6x the widest line the probe drive takes (34.1 m
//     measured), which is why the corridor never fires in ordinary play.
//
//     Overrule test: g/2 = 4.905 is 18.9% of the physics module's own lateral
//     acceleration ceiling A_LAT = 26 m/s^2, so a rider at full lock still wins
//     and can still take the flank. A berm shapes a line; it never takes the
//     turn.
//
//   WALL (firm, |s| in [120, 130.62])
//     The brake branch at A_STOP. Expressed in corridor coordinates (offset s
//     across, progress z along), so the wall acts purely ACROSS: a rider carving
//     along it keeps every bit of their down-course speed. It cannot pull a
//     rider in — that is the berm's job — and by 3.3 it cannot act at all until
//     the rider is genuinely outrunning the room they have left.
//
//   LIMIT / RETURN (hard, |s| > 130.62, z outside the longitudinal soft lines)
//     The return branch at A_TRACK. Braking alone would only stop the rider
//     going out FAST, not stop them going out: between one clamp and the next
//     the world adds up to A_HCEIL*dt of outward rate. So past the soft line the
//     requirement inverts and the rider is brought back on the mirrored
//     envelope, arriving at the line with zero speed. The return firmness is
//     A_TRACK, not A_STOP, because the return is a promise the module has to
//     keep against a rider still boosting outward, and A_TRACK is the firmest
//     envelope it can hold. Counted: rs.confine.limitFrames. The return
//     requirement is additionally capped at V_CAP so the corridor can never
//     demand a speed physics itself forbids; MEASURED, that cap cannot bind
//     inside the containment bound (sqrt(2*A_TRACK*MARGIN) = 17.3 m/s < 33).
//
//   3.7 THE WRITE CEILINGS — two of them, both published, both enforced
//
//     GROUNDED CORRECTIONS RIDE THE SNOW. You cannot push a board into or out of
//     the ground, only along it. There is exactly one tangent-plane vector whose
//     horizontal shadow is the correction the envelope asked for, and that is
//     the one applied: no authority is lost to a projection and none is invented
//     by a rescale. It also keeps the push out of the physics module's
//     magnitude-preserving grounded redirect, which would otherwise launder a
//     component pointed into the hill back out as forward speed — a confiner
//     that accidentally boosts.
//
//     That lift means one number cannot do the job. Only the HORIZONTAL part of
//     a correction does containment work; the vertical part is bookkeeping that
//     keeps the push on the snow, and on a 62 deg face it is larger than the
//     work. So:
//
//       A_HCEIL = A_STOP + g/2 = 59.001 m/s^2
//         The horizontal ceiling: the firmest boundary plus the strongest berm
//         that can co-fire with it, and not one m/s^2 more. Applied BEFORE the
//         tangent lift, so the lift cannot smuggle horizontal authority in
//         behind it. Every containment derivation in this file uses this number.
//
//       A_CEIL3 = A_HCEIL / NY_MIN = 124.37 m/s^2
//         The absolute 3-D bound on anything this module writes. NY_MIN = 0.4744
//         is the MEASURED minimum surface n_y over |s| <= 150 m, z in [-81,
//         2481] — a superset of the containment set — a 61.7 deg face at
//         s = -150, z = 799. By construction this can only bind on ground
//         steeper than anything in that set, so it is a guard, and
//         rs.confine.ceil3Frames says whether the guard ever fired.
//
//     Publishing only the smaller number would understate what the module
//     writes; publishing only the larger would overstate what it can contain.
//     Both are in config (ceilAccelHorizontal_mps2, ceilAccel3D_mps2).
//
//   3.8 CORRIDOR COORDINATES, AND A DEFECT INHERITED FROM THE SEED
//
//     s = x - centreX(z) is the lateral offset (the coordinate every divergence
//     measurement and the render lane's own tree line are stated in) and z is
//     down-course progress. With k = centreX'(z) their rates are
//         ds/dt = vx - k*vz        dz/dt = vz
//     so a correction that must produce a given (d2s/dt2, d2z/dt2) has exactly
//     one horizontal solution:
//         az = d2z/dt2             ax = d2s/dt2 + k * az
//     The module solves that rather than decomposing onto corridor normal and
//     tangent unit vectors, which would deliver only 1/sqrt(1+k^2) of what it
//     asks for (19% short where the course meanders hardest, k = 0.73) — the
//     kind of quiet slack that lets a guarantee be violated. A purely lateral
//     correction here leaves dz/dt untouched by construction.
//
//     centreX is expensive in the real game (a scan across the corridor), so it
//     is cached. The seed cached it on a 25 m grid and used the nearest node,
//     which MEASURED costs up to 10.17 m of centreline error at z = 788 — the
//     module's idea of the corridor centre stepping 10 m away from the runner's
//     is enough to fire a wall at an in-bounds rider, and it is the same class
//     of bug the runner's own comments record fixing in courseCenterX. This
//     module caches nodes every 10 m and LERPS between them, which is the
//     runner's own construction: measured error against the harness centreline,
//     0.0000 m. k is the exact derivative of that interpolant (the local segment
//     slope), so the coordinate system and its Jacobian cannot disagree.
//
//   3.9 WHAT IS NOT PROMISED
//
//     Confinement is not free, and this module does not pretend it is. Every
//     correction takes energy out of the rider. It is priced at zero for a
//     competent player only because the layers sit outside the line a competent
//     player takes, and section 3.3 makes that a proof rather than an
//     observation. A player who leans on the wall pays for it, by design.
//     Against a player boosting straight at the wall the corrective acceleration
//     is large — up to A_HCEIL, which is what it takes to cancel a boost — and
//     it is a bounded acceleration on the velocity, never a position write, so
//     RS-06's per-frame position jump stays the rider's own travel.
//
//     After the finish, the run-out holds the rider indefinitely: the envelope's
//     allowance is zero at the soft line, so gravity is cancelled frame after
//     frame and the rider stays parked at z = 2456. That is a sustained
//     correction, not a one-off, and it is counted in rs.confine.activeFraction.
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
//            object (identity change), which its reducer does on every non-crash
//            landing, points or no points, so a 0-point 'Air' still counts as
//            landed — or when LEDGER_WINDOW steps pass with no bank, which is
//            what a voided (crashed) jump looks like from outside.
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
//   bestTrick is ts.lastAward.name: the trick system's whole banked jump SUMMARY
//   ("Frontside 360 + Grab"), which is what the player remembers and what the
//   score is actually made of — not one entry picked out of ts.awards. Its
//   banked points (ts.lastAward.points) ALREADY INCLUDE any star multiplier the
//   trick system credited, and that banked figure is the authoritative one on
//   the card.
//
//   The multiplier is reported alongside it as results.starMultAtLanding: the
//   value of the public trickState().starMult on the frame BEFORE the bank —
//   the star the rider carried into that landing. It is labelled "at landing"
//   and not "applied" because the trick system credits a star only on a CLEAN
//   landing, and clean-vs-sketchy is not on its public surface. No string
//   matching against another lane's award names, no reaching into trick
//   internals: this module must work against any candidate in that lane.
//
//   There are no grade bands and no medals. Inventing a letter ladder over an
//   unsettled speed ladder is invention wearing a hat. results.rank is null with
//   the reason attached, and results.anchors carries the REAL anchors from
//   references/REFERENCE_BAR.md (uber base 13,210-22,580; ~130K for a
//   multi-star master jump) so a reader can place a score against something
//   sourced instead of against a band this module made up.
//
// ---------------------------------------------------------------------------
// 6. SELF-CHECK — what the gates measured, and what they could not
//
//   `node harness/run-runner.mjs --module sandbox/run-structure/A/run.mjs`
//     10/10, hardFails 0.
//     moduleYawAuthority_degps  0.00   (RS-10, bar 5)
//     maxDivergenceReached_m    0.98   (RS-05, bar 4)
//     maxCorrectionJump_m       0.43   (RS-06, bar 2 — that is the rider's own
//                                      travel in one frame; nothing is moved)
//     startHolds                1      (RS-09, drift 0.35 m against a 3 m bar)
//     runDuration_s             267.4  (RS-08, band 90-300)
//
//   PACE COST, MEASURED: the same probe drive with a no-op run module attached
//   (a bare timer, no corridor) finishes in 266.4 s. This module's 267.4 s is
//   1.0 s slower, and all of it is the 3 s countdown minus the rolling 6 m/s
//   the harness spawns the rider with. The corridor itself costs zero, because
//   3.3 proves it cannot fire on a line that stays in bounds. (The task brief
//   quotes 208.9 s for that baseline; measured here today it is 266.4 s. The
//   discrepancy is in the physics/trick modules, not the run module — the
//   no-op comparison is the one that isolates this lane.)
//
//   WHAT THOSE GATES DID NOT MEASURE, stated plainly:
//     * RS-10's in-bounds frames are frames in which this module provably writes
//       nothing, so the gate cannot tell a correct corridor from an absent one.
//     * RS-05/RS-06's adversarial drive is held at the run-out and never gets
//       more than ~39 m off centre against this module, so the berm, the wall
//       and the lateral return branch are untouched by it: bermFrames = 0 and
//       wallFrames = 0 on that drive. The confinement it verifies is the
//       longitudinal one.
//     * No gate drives a rider into the lateral wall at all.
//
//   `node sandbox/run-structure/A/selftest.mjs` drives exactly those, and
//   reports numbers rather than pass/fail alone. It exits non-zero on failure.
// ============================================================================

// --- physics anchors: live from the accepted physics module when reachable ---
// Every acceleration below is a function of constants the ACCEPTED physics
// module publishes, so a physics retune moves this corridor with it. The pinned
// copy is the standalone fallback and which one was used is in config.
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
// src/render/main.mjs with the run-runner's own centreline and divergence
// probes. Each is a fact about the terrain or the harness, not a preference.
// ---------------------------------------------------------------------------
const MEASURED = {
  // render lane's tree line: main.mjs plants pines only where
  // d = |x - centerX(z)| is in (55, 720) — this module's own lateral coordinate
  treeLine_m: 55,
  // widest line the harness probe drive `play` takes over a full run, with a
  // no-op run module attached
  probeWidestLine_m: 34.1,
  // minimum surface n_y over |s| <= 150 m, z in [-81, 2481] (a superset of the
  // containment set) — a 61.7 deg face at s = -150, z = 799
  minSurfaceNy: 0.4744,
  // terrain's own INWARD horizontal restoring acceleration along the corridor
  // lateral coordinate, both flanks, z = 0..2400 (m/s^2)
  terrainInwardPull_mps2: {
    20: { median: 1.24, min: -1.86, max: 3.92 }, 40: { median: 2.41, min: -0.27, max: 5.01 },
    55: { median: 3.09, min: 0.74, max: 5.30 }, 70: { median: 3.61, min: 1.75, max: 5.70 },
    85: { median: 4.11, min: 2.41, max: 5.89 }, 100: { median: 4.46, min: 3.25, max: 5.87 },
    120: { median: 4.72, min: 3.49, max: 5.96 }, 130: { median: 4.75, min: 3.55, max: 5.92 },
    150: { median: 4.68, min: 3.50, max: 5.73 },
  },
  // largest top-up the berm law ever asks for, swept over the containment box
  peakBermTopUp_mps2: 1.42,
  // worst mesh-vs-physics divergence at a given lateral offset, 1.5 m grid,
  // over the containment box's z range (the runner's own divergence probe)
  divergenceByOffset_m: { 0: 0.93, 55: 0.79, 120: 0.95, 130: 1.06, 140: 1.35, 145.3: 1.43, 150: 1.93, 170: 1.98 },
  // worst divergence over THIS module's whole containment box
  // (|s| <= 145.842, z in [-71.281, 2471.281])
  divergenceInContainmentBox_m: 1.47,
  // fine-LOD region of the runner's divergence probe, and the gap immediately
  // outside it — the containment box must lie wholly inside
  fineLodZ: [-250, 2750],
  divergenceJustOutsideFineLod_m: { '-260': 8.29, 2760: 4.24 },
  // largest |centreX'(z)| over the course
  maxCentrelineSlope: 0.7314,
  // centreline error of the seed's 25 m nearest-node cache, against the
  // harness centreline; and of this module's 10 m grid + lerp
  centrelineErr25mNearest_m: 10.17,
  centrelineErr10mLerp_m: 0,
  // run duration of the harness probe drive with a NO-OP run module attached
  // (bare timer, no corridor) — the isolation baseline for RS-08
  noopProbeDuration_s: 266.4,
  // ready-phase drift under the harness start probe, this module vs the seed
  startDrift_m: 0.35, seedStartDrift_m: 39.82,
};

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W_WALL = B.halfWidth ?? 120;             // contract corridor edge

  // ---------------- physics-derived firmnesses (header 3.4) -----------------
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
  // The firmest envelope this module can TRACK against a rider at full boost:
  // it must deliver the envelope's own decel AND cancel the drive AND cancel
  // the worst adverse horizontal gravity, inside A_HCEIL. Collapses to g.
  const A_TRACK = A_HCEIL - DRIVE_MAX - A_BERM_MAX;         // 9.81
  // 3-D write ceiling. A grounded push must lie in the tangent plane, so
  // delivering h horizontally costs h/n_y of 3-D magnitude; NY_MIN is the
  // MEASURED steepest ground in the containment set. This is the absolute bound
  // on anything this module writes, published rather than left implicit.
  const NY_MIN = MEASURED.minSurfaceNy;                     // 0.4744
  const A_CEIL3 = A_HCEIL / NY_MIN;                         // 124.37

  // ---------------- spans follow from firmness, exactly (header 3.3) --------
  // SPAN(A, dt) is the gap at which the DISCRETE allowance equals V_CAP exactly:
  //   allow(-SPAN) = -A*dt + sqrt(A^2 dt^2 + V_CAP^2 + 2 A V_CAP dt) = V_CAP
  // so a layer whose soft line sits one SPAN outside the boundary it defends is
  // provably inert at and inside that boundary, at any dt.
  const span = (A, dt) => (V_CAP * V_CAP) / (2 * A) + V_CAP * dt;
  const WALL_SPAN = span(A_STOP, DT_REF);                   // 10.616 m @60Hz
  const Z_SPAN = span(A_TRACK, DT_REF);                     // 56.055 m @60Hz

  // ---------------- soft lines, and the bound one MARGIN outside ------------
  // Worst penetration past a soft line, derived with the drive and the speed
  // COUPLED (they are not independent: physics' boost is a relaxation toward
  // V_BOOST, so an outward rate of w leaves only (V_BOOST-w)/TAU of drive, and
  // at w >= V_BOOST the boost pushes nothing at all).
  //   a(w) = A_HCEIL - max(0,(V_BOOST-w)/TAU) - g/2
  //        = g + w/TAU   for w < V_BOOST;   = A_STOP  for w >= V_BOOST
  //   MARGIN = integral of w/a(w) dw from 0 to V_CAP, plus one unseen frame at
  //   V_CAP — the module reads the rider after physics has already moved them.
  const wB = Math.min(V_BOOST, V_CAP);
  const MARGIN =
      TAU * (wB - G * TAU * Math.log(1 + wB / (G * TAU)))        // 13.492 m
    + Math.max(0, V_CAP * V_CAP - wB * wB) / (2 * A_STOP)        //  1.183 m
    + V_CAP * DT_REF;                                            //  0.550 m
                                                                 // = 15.226 m

  const W_BERM = MEASURED.treeLine_m;                       // 55, cited
  const L_SOFT = W_WALL + WALL_SPAN;                        // 130.616
  const L_BOUND = L_SOFT + MARGIN;                          // 145.842
  const Z_SOFT_DOWN = zFinish + Z_SPAN;                     // 2456.055
  const Z_BOUND_DOWN = Z_SOFT_DOWN + MARGIN;                // 2471.281
  const Z_SOFT_UP = zStart - Z_SPAN;                        // -56.055
  const Z_BOUND_UP = Z_SOFT_UP - MARGIN;                    // -71.281

  const COUNTDOWN_S = env.countdown_s ?? 3;      // CHOICE (presentation only)
  const SPLITS = 3;                              // CHOICE (presentation only)
  const LEDGER_WINDOW = 2;                       // 1 derived + 1 slack (header 4)

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth: W_WALL,
    maxDivergence_m: 4,          // the CONTRACT's ceiling (RS-05), as defined
    // ---- this module's own guarantee, published separately ----
    divergenceInContainmentBox_m: MEASURED.divergenceInContainmentBox_m,
    // ---- corridor geometry (soft lines quoted at DT_REF; the layer starts are
    //      recomputed each frame from the live dt, header 3.3) ----
    bermStart_m: W_BERM, wallStart_m: W_WALL,
    wallSpan_m: WALL_SPAN, zSpan_m: Z_SPAN,
    lateralSoftLine_m: L_SOFT, lateralBound_m: L_BOUND,
    zSoftDown_m: Z_SOFT_DOWN, zBoundDown_m: Z_BOUND_DOWN,
    zSoftUp_m: Z_SOFT_UP, zBoundUp_m: Z_BOUND_UP,
    margin_m: MARGIN,
    // ---- firmnesses ----
    driveMax_mps2: DRIVE_MAX, stopFirmness_mps2: A_STOP,
    trackFirmness_mps2: A_TRACK, bermMax_mps2: A_BERM_MAX,
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
      layerStart: 'EXACT IDENTITY, not a placement. span(A,dt) = V_CAP^2/(2A) + V_CAP*dt is the gap at which the discrete allowance equals V_CAP exactly (substitute and the sqrt collapses to A*dt + V_CAP). Each soft line sits one span outside the CONTRACT boundary it defends — halfWidth for the wall, zFinish for the run-out, zStart for the back-stop — so the layer is provably inert at and inside that boundary at any dt: no rider physics permits can exceed V_CAP, so the excess is <= 0 and the field is exactly 0. This is why moduleYawAuthority is 0 in bounds by construction rather than by luck.',
      returnBranch: 'past the soft line the requirement inverts: the rider must be coming back fast enough to arrive at the line with zero speed. Braking alone only stops a rider going out fast, not going out. Return firmness is A_TRACK, not A_STOP, because the return is a promise that has to be kept against a rider still boosting outward.',
      stopFirmness: 'A_STOP = DRIVE_MAX + g, with DRIVE_MAX = V_BOOST/TAU_BOOST from the accepted physics module\'s own boost law at rest: the strongest acceleration the world can apply in any single direction, so a boundary this firm cannot be outrun in principle. Used for the lateral wall only.',
      trackFirmness: 'A_TRACK = A_HCEIL - DRIVE_MAX - g/2 = g = 9.81 m/s^2, the firmest envelope the module can hold with no overshoot beyond MARGIN against a rider at full boost, because it must deliver the envelope\'s own decel AND cancel the drive AND cancel the worst adverse horizontal gravity inside the horizontal ceiling. Used for the run-out, the back-stop, the gate, and every return branch.',
      whichFirmnessWhere: 'TRADEOFF, stated: A_TRACK is the better boundary and is used wherever its 56 m span fits — down-course there are ~290 m to the fine-LOD edge, up-course ~250 m. Laterally it does not fit: a trackable wall\'s soft line would sit at |s| = 175.5 and its bound at 190.7, 70 m outside the contract corridor, or else the layer would have to start at |s| = 64.5, deep inside terrain the contract calls in-bounds. So the wall takes A_STOP and is deliberately NOT tracked; MARGIN is the exact size of the resulting overshoot.',
      rejectedBrakeFirmness: 'REJECTED: A_BRAKE = 4.5 m/s^2 (REFERENCE_BAR TN-08 band 3-6), which the seed used for all three longitudinal layers and called "the rider\'s own brake authority". The accepted physics module publishes BRAKE_DECEL = 1.7, so the citation and the code disagreed, and 4.5 was a hand-picked point in a band. Following the citation properly is worse: 1.7 needs a 320 m span, putting the back-stop bound at z = -335, 85 m outside the fine-LOD region where the mesh gap is already 8.3 m. A run-out is a barrier, not the rider braking.',
      bermMax: 'g/2. A slope\'s inward horizontal restoring accel is (g/2)*sin(2*theta), maximal at 45 deg. No bank can exceed g/2, so no berm may either. 18.9% of the physics A_LAT ceiling (26), so full lock still overrules it.',
      bermLaw: 'a_berm = q^2 * max(0, g/2 - a_terrain_inward), q = clamp((|s|-55)/(120-55),0,1). MEASURED: the gully already pulls 4.72 m/s^2 (median) / 3.49 (min) inward at |s| = 120, so the berm TOPS UP to the strongest bank a slope can be rather than adding to a bank already near its ceiling. Peak contribution over the containment box: 1.42 m/s^2. q^2 is the lowest-order polynomial zero-with-zero-slope at the tree line and 1 at the corridor edge.',
      bermStart: 'CITED: src/render/main.mjs plants pines only where d = |x - centerX(z)| is in (55, 720) — the render lane\'s tree line, stated in this module\'s own lateral coordinate. Also 1.6x the widest line the probe drive takes (34.1 m measured).',
      startGate: 'the gate sits at the rider\'s STAGED position (first observed z, clamped into [zSoftUp, zStart]), not at zStart, because a gate 40 m down-course of a staged rider catches them instead of holding them. Same allowance law, soft line at Z_GATE, so at p = 0 the field removes exactly the down-course rate the rider has and nothing more. The clock starts at the drop. There is no rolling-start branch: the gate is always at the rider, so it can never drag anyone backwards, and every harness probe therefore exercises it.',
      ceilAccel: 'TWO ceilings, both published and both enforced. Horizontal: A_STOP + g/2 = 59.001, the firmest boundary plus the strongest berm that can co-fire with it, and not one m/s^2 more. 3-D: that divided by NY_MIN = 0.4744, the MEASURED steepest ground in a superset of the containment set, because a grounded push must lie in the tangent plane and delivering h horizontally costs h/n_y. The difference between the two is vertical bookkeeping that keeps the push on the snow; it does no containment work, which is why the containment derivation uses the horizontal number and the disclosure uses the 3-D one.',
      margin: 'the integral of w/a(w) dw from 0 to V_CAP, plus one unseen frame at V_CAP (the module reads the rider after physics has moved them; DT_REF fixed by CONTRACTS.md). a(w) is the NET inward acceleration at outward rate w with the drive and the speed COUPLED: physics\' boost is a relaxation toward V_BOOST, so a rider already leaving at w has only (V_BOOST-w)/TAU of drive left and none at all past V_BOOST. a(w) = g + w/TAU below V_BOOST and A_STOP above it — the berm\'s g/2 ceiling cancels the worst outward gravity exactly, so the residual at w = 0 is exactly g. 13.492 + 1.183 + 0.550 = 15.226 m. Distinct from the V_CAP*dt term in span: that one buys inertness at a layer\'s start, this one buys headroom past its soft line.',
      containmentBound: 'soft line + MARGIN. A BOUND, not a barrier: nothing is placed there, nothing fires there, and rs.confine.beyondBound counts frames past it.',
      divergence: 'CHECKED, NOT CHOSEN: worst mesh-vs-physics divergence over the whole containment box (|s| <= 145.842, z in [-71.281, 2471.281]) is 1.47 m, well under half of RS-05\'s 4 m ceiling, and the box lies wholly inside the fine-LOD region z in [-250, 2750], clear by 179 m up-course and 279 m down-course. Immediately outside that region the gap is 8.29 m (z = -260) and 4.24 m (z = 2760). The sweep is a constraint the derived geometry must satisfy, not the source of any number.',
      centreline: 'cached on a 10 m grid and LERPED, which is the run-runner\'s own construction: measured error against the harness centreline, 0.0000 m. The seed cached on 25 m and used the nearest node, which measures up to 10.17 m of centreline error at z = 788 — enough to fire a wall at an in-bounds rider. k = centreX\'(z) is the exact derivative of the interpolant, so the coordinate system and its Jacobian cannot disagree.',
      choices: 'countdown_s = 3 and splitCount = 3 are CHOICES (presentation only, no physical claim). ledgerWindow_steps = 2 is 1 derived + 1 step of slack (CHOICE). Aiming the divergence check at half of RS-05\'s ceiling rather than at it is a CHOICE. Nothing else in this block is a preference.',
      rank: 'absent by decision: no defensible speed ladder exists yet, and a grade band over an unsettled ladder is invention. results.anchors carries the sourced anchors instead.',
    },
  };

  // ---- corridor centre + its exact derivative, cached on a 10 m grid and
  //      LERPED (header 3.8) ----
  const CX_STEP = 10;
  const cCache = new Map();
  function node(i) {
    let v = cCache.get(i);
    if (v === undefined) { v = rawCenter(i * CX_STEP); cCache.set(i, v); }
    return v;
  }
  function cx(z) {
    const f = z / CX_STEP, i = Math.floor(f), t = f - i;
    return node(i) * (1 - t) + node(i + 1) * t;
  }
  // exact slope of the piecewise-linear interpolant on the segment containing z
  const cxPrime = z => (node(Math.floor(z / CX_STEP) + 1) - node(Math.floor(z / CX_STEP))) / CX_STEP;

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
  // The return requirement is capped at V_CAP so the corridor can never demand a
  // speed the physics module's own hard clamp forbids; measured, that cap cannot
  // bind inside the containment bound.
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
      gateZ: null,            // where the gate physically is (staged position)
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
        wallFrames: 0,          // a brake branch fired
        limitFrames: 0,         // a return branch fired (past a soft line)
        gateFrames: 0,          // the closed gate held the rider
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
        source: 'references/REFERENCE_BAR.md (Uber Trick Guide table; 20,960 x2 x3 ~ 130K master jump)',
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
      // trickState().starMult as of the previous step, because the trick system
      // consumes the star in the same step it banks the jump. The authoritative
      // banked figure is la.points, which already includes any multiplier the
      // trick system actually credited.
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
  // position, heading, or any physics or trick flag. See header 3.8 for the
  // coordinate solve.
  function confine(rs, ph, dt, gateZ) {
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

    // layer starts, recomputed from the LIVE dt so the inertness identity of
    // header 3.3 holds at any step size
    const lSoft = W_WALL + span(A_STOP, dt);
    const zSoftDown = zFinish + span(A_TRACK, dt);
    const zSoftUp = zStart - span(A_TRACK, dt);

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
      // beyond the corridor edge (q = 1) terrain + berm is at least g/2, the
      // strongest bank a slope can be, wherever the mountain is shallower
      c.terrainPull_mps2 = terrIn;
      c.bankTotal_mps2 = terrIn + berm;
      if (berm > 0) {
        aIn += berm;
        c.bermFrames++;
        if (berm > c.peakBerm_mps2) c.peakBerm_mps2 = berm;
      }
    }

    // ---- LAYERS 2 & 3. WALL (brake) and LIMIT (return), one allowance ------
    const pLat = sAbs - lSoft;
    const dLat = demand(pLat, sRate, A_STOP, A_TRACK, dt);
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

    // ---- down-course: the closed gate, or the run-out past the finish ------
    // While the gate is closed its soft line is the gate itself (p = 0 at the
    // staged position), so the field removes exactly the down-course rate the
    // rider has. Once it drops, the run-out takes over one span past zFinish.
    const softDown = gateZ === null ? zSoftDown : gateZ;
    const pDown = z - softDown;
    const dDown = demand(pDown, zRate, A_TRACK, A_TRACK, dt);
    if (dDown > 0) {
      aZ -= dDown;
      if (gateZ !== null) c.gateFrames++;
      else if (pDown > 0) c.limitFrames++; else c.wallFrames++;
      if (dDown > c.peakDemand_mps2) c.peakDemand_mps2 = dDown;
    }
    if (pDown > 0) {
      c.depth_m = Math.max(c.depth_m, pDown);
      if (gateZ === null && z > Z_BOUND_DOWN) c.beyondBound++;
    }

    // ---- up-course back-stop (outward is -z) -------------------------------
    const pUp = zSoftUp - z;
    const dUp = demand(pUp, -zRate, A_TRACK, A_TRACK, dt);
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

    // ---- assemble the world-space correction (exact solve, header 3.8) -----
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

    // ---------- ready: held at the gate, clock reads 0 ----------------------
    if (rs.phase === 'ready') {
      // The gate is where the rider is staged (header 2), fixed on the first
      // step this module ever sees and clamped so it can never fight the
      // back-stop. Not at zStart: a gate down-course of a staged rider catches
      // them instead of holding them.
      // Clamped only into the corridor's own longitudinal soft lines, so the
      // gate can never fight the back-stop or the run-out. There is NO clamp to
      // zStart: clamping there would put the gate up-course of a rider staged
      // past the line and its return branch would drag them backwards to it,
      // which is the one thing a start gate must never do (measured on the seed
      // geometry: 21.6 m of backward drag for a rider staged at z = 15).
      if (rs.gateZ === null) rs.gateZ = clamp(ph.pos[2], Z_SOFT_UP, Z_SOFT_DOWN);
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.gateOpen = rs.countdown_s <= 0;
      rs.light = rs.countdown_s > COUNTDOWN_S / 3 ? 'red' : rs.countdown_s > 0 ? 'set' : 'go';
      rs.progress = 0;
      if (!rs.gateOpen) {
        confine(rs, ph, dt, rs.gateZ);   // gate closed: hold at the staged line
        return rs;
      }
      // THE DROP. The clock starts here, which is what a start gate is.
      rs.phase = 'running'; rs.stage = 'running'; rs.light = 'go';
      rs.time_s = 0;
      rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
      rs.nextSplit = 0; rs.splits = [];
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
      confine(rs, ph, dt, null);
      return rs;
    }

    // ---------- finished: clock frozen, card frozen, corridor still holds ---
    rs.speed_kmh = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6;
    confine(rs, ph, dt, null);
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
