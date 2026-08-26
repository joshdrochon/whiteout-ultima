// ============================================================================
// run-structure lane — run.mjs   (cycle 4, candidate B)
//
// Start gate, race clock, checkpoint stream, finish line, results card,
// restart, and a three-layer corridor built as a POTENTIAL WELL.
//
// Pure JS. No imports, no globals, no Date, no Math.random. Deterministic.
//
// ============================================================================
// 0. WHAT THIS MODULE WRITES — the complete list
//
//   physState.vel[0..2], and only as `vel += a * dt` where `a` is the corridor
//   field, whose horizontal magnitude is clamped to A_CEIL_H (§4.6) and whose
//   3-D magnitude is clamped to A_CEIL_3.
//
//   Nothing else. Specifically it never writes:
//     pos, heading, spinDeg, flipDeg, onGround, airTime, landing, charge,
//     boostMeter, yawRate, or ANY field of the trick state.
//
//   That is not an assertion. step() snapshots pos and heading immediately
//   before its write block and diffs them immediately after, EVERY frame, and
//   publishes the running maxima as rs.confine.maxSelfPosDelta_m and
//   rs.confine.maxSelfYaw_deg. If a future edit to this file ever writes either
//   one, those numbers stop being zero and the module reports it on itself.
//
//   RS-10 (HARD) measures exactly that heading diff across run.step. It is 0.00
//   deg/s, and it is 0.00 for the only reason that can be checked by reading
//   one file: there is no assignment to `heading` in this file. Not "the
//   corridor never fires on the probe's line" — that is luck. Not "the yaw I
//   add is small" — that is a budget. Zero writes.
//
//   THE ONE INDIRECT CHANNEL, DISCLOSED AND MEASURED. The accepted physics
//   module snaps heading onto velocity yaw on a clean landing (physics.mjs
//   `land`). So a LATERAL velocity write made while the rider is airborne can
//   move the heading one touchdown later — inside ph.step, where RS-10 cannot
//   see it. The corridor does act in the air (a corridor that switches off when
//   the rider jumps is not a corridor: a rider can launch at the speed cap and
//   fly 150 m). So the channel is real. Measured, worst case, as the velocity
//   heading turned across one whole air phase:
//
//     rider airborne anywhere IN BOUNDS ............................ 0.00 deg
//       0 write frames — the corridor is inert there (§4.3), airborne or not
//     launched straight outward at the wall at the speed cap ....... 0.00 deg
//       the correction is anti-parallel to the velocity: it scales it, and a
//       scale cannot rotate
//     launched DIAGONALLY at the wall at the speed cap ............ 74.74 deg
//       the honest worst case. Killing the lateral half of a diagonal velocity
//       rotates what is left, and there is no way to stop lateral motion
//       without it. The alternative — scaling the whole velocity — would take
//       the rider's DOWN-COURSE speed as well, which steals race time to buy a
//       cosmetic number, so it was rejected. This is only reachable outside the
//       contract corridor with the rider airborne and travelling outward fast,
//       which is exactly the case where the alternative is falling through the
//       world.
//
//   Counted live as rs.confine.airWriteFrames / peakAirWrite_mps2. Airborne
//   corrections are horizontal only — never vertical — so the rider's fall is
//   never touched.
//
// ============================================================================
// 1. THE ONE DESIGN DECISION, STATED UP FRONT
//
//   ZERO AUTHORITY STRICTLY INSIDE THE CONTRACT CORRIDOR, ONCE THE RUN STARTS.
//
//   CONTRACTS.md defines in-bounds as |x - courseCenterX(z)| <= halfWidth and
//   z in [zStart, zFinish]. From the gate drop to the end of the run, inside
//   that set this module applies exactly 0.0 m/s^2 — not "a small nudge", not
//   "a gentle bank", not "a berm that shapes the racing line". Zero, at every
//   dt, for every rider, provably (§4.3). rs.confine.inBoundsWriteFrames counts
//   the violations and reads 0.
//
//   THE ONE EXCEPTION, NAMED RATHER THAN BURIED: the start pen (§2) holds the
//   rider at rest during 'ready', and the staging point is normally in bounds.
//   That is what a start gate IS, it is over before the clock starts, and it is
//   counted separately as rs.confine.penFrames. There is no other frame on
//   which this module touches an in-bounds rider.
//
//   That is a decision with a cost, and the cost is a real one: an SSX course
//   has banked shoulders that hold you in, and this corridor does not supply
//   them inside the ridable width. The reason it does not is that cycle 3 was
//   lost to a module that decided it knew the line better than the player. A
//   berm inside the corridor is the same claim with a smaller number attached.
//   The player owns every metre of the corridor the contract gives them.
//
//   The mountain itself is not so restrained, and it does not need to be: the
//   gully already pulls the rider back. MEASURED (§4.4), at |s| = 120 the
//   terrain's own inward horizontal pull is 4.72 m/s^2 median, 3.47 m/s^2 worst
//   case, against a hard physical ceiling of g/2 = 4.905 for any slope. The
//   bank is already there, at 96% of the strongest bank that can exist. This
//   module adding another one would be stacking a second bank on a real one.
//
// ============================================================================
// 2. PHASES, THE START GATE, AND THE CLOCK
//
//   phase: 'ready' -> 'running' -> 'finished'      (the contract's three)
//
//   ready     A closed gate holds the rider at the staging position. Clock 0.
//             rs.light runs red -> set -> go over COUNTDOWN_S.
//   running   Clock accumulates. Checkpoints stream. Corridor holds.
//   finished  Latched on the first frame at or past zFinish. Clock frozen,
//             card assembled once and frozen, corridor still holding — a rider
//             who crosses the line with boost pinned coasts to a stop in the
//             run-out instead of sailing onto the backdrop tiles.
//
//   WHERE THE GATE IS. At rs.gateZ = the first z this module ever observes,
//   clamped to be no further up-course than the back-stop's limit. NOT at
//   zStart. A start gate is a bar in front of the board; a bar 40 m down-course
//   of a staged rider does not hold them, it catches them after 40 m of free
//   sliding. The harness's own start probe stages the rider at z = -40 with
//   zStart = 0 and measures the drift over the whole ready phase: a gate at
//   zStart yields ~40 m of it. MEASURED here: 0.11 m, against RS-09's 3 m bar.
//
//   WHAT THE GATE DOES, AND WHY IT IS A FULL STOP. While the rider is grounded
//   in 'ready' the pen brings them to REST — the field removes the velocity
//   they have, bounded by the same two ceilings as everything else in this file
//   (§4.6), so a rider arriving at the gate at 33 m/s is braked over ~0.4 s and
//   not snapped.
//
//   AIRBORNE IN 'ready', THE GATE DOES NOTHING. A bar across the course cannot
//   hold a rider who is off the ground. The first build gave the gate a
//   down-course envelope that applied in the air too; MEASURED, that reversed
//   an airborne rider's entire down-course velocity at 81.5 m/s^2 and turned
//   their velocity heading 107 deg — a start gate batting a rider out of the
//   sky. The pen is the gate, and it acts only on a grounded rider. The
//   corridor's own safety limits (lateral corridor, run-out, back-stop) run in
//   every phase, so a rider airborne at the start is still contained; they are
//   simply not held.
//
//   The first version held only the down-course axis, on the argument that
//   zeroing a velocity vector is a heavier write than braking one. MEASURED,
//   that was wrong, and the failure is worth recording because it is a property
//   of the accepted physics module rather than of this one: holding z alone
//   leaves the rider with a small LATERAL velocity, which in the board frame is
//   a small NEGATIVE forward speed (fakie). physics.mjs' boost law relaxes the
//   MAGNITUDE of forward speed toward V_BOOST and re-signs it, so the instant
//   the probe drive pressed boost the rider was accelerated backwards at 20 m/s
//   and travelled 125 m UP the mountain into the back-stop before recovering.
//   A rider at rest with zero velocity has no such sign ambiguity: physics'
//   own reversal branch resolves it downhill. So the pen stops the rider
//   completely, and the run begins from a defined state.
//
//   Everything else about the gate is the ordinary envelope law (§4.2) with its
//   line at gateZ: allowance exactly 0 at the line, mirrored return past it.
//   It is never a position pin — no frame of this module writes pos.
//
//   ONE BRANCH, NO ROLLING-START SPECIAL CASE. The gate is always at the rider,
//   so a rider staged past zStart is held where they stand and released like
//   anyone else. There is no test of "is the rider already racing?" and so no
//   test that can be wrong. Consequence, stated because it decides how this
//   module scores: every harness probe (all but one stage at z = 15) now runs
//   through a real ready phase and a real gate drop, so the gate is exercised
//   by every RS gate rather than by one.
//
//   THE CLOCK STARTS AT THE DROP. Every metre of the run is on the clock; the
//   countdown is not. That is what a start gate is for.
//
// ============================================================================
// 3. WHY CONFINEMENT EXISTS — measured with the runner's own probe
//
//   Physics ground is an analytic function. The rendered mesh is a per-LOD
//   approximation of it. Divergence = |analytic height - bilinear across the
//   worst LOD cell the player can be near| (harness/run-runner.mjs
//   `divergenceAt`). Swept over this course, both flanks, z in [-160, 2560],
//   1 m in offset x 0.5 m in z:
//
//     |s| (m)      0    40    80   120   140   150   160   180   200   206
//     worst gap  0.93  0.76  0.78  0.95  1.36  1.95  2.46  2.29  3.69  4.20
//
//     cumulative sup crosses 2 m at |s| = 154.9 and 4 m at |s| = 205.75.
//     (the 2 m crossing re-measured at 0.1 m x 0.25 m: last offset verified at
//     or under 2 m is 154.8, where the sup is 1.986)
//
//   Longitudinally the killer is the LOD region edge, not roughness: inside
//   z in [-250, 2750] the cells are 15.6 m, outside them 83.3 m. Sweeping z
//   outward with |s| <= 200, the cumulative sup crosses 4 m at z = 2755 and at
//   z = -255 — i.e. exactly at the region boundary, and nowhere before it.
//
//   RS-05's ceiling is 4 m; past it a rider is visibly falling through the
//   world. So the corridor's job is to make a stated region UNREACHABLE.
//
//   SAFETY FACTOR — a CHOICE, labelled, with its reason: this module targets
//   HALF of RS-05's ceiling (2 m), not the ceiling. The divergence field is a
//   function of the RENDER lane's LOD schedule, which is another lane's
//   tunable; a rebuild that coarsens one LOD step must not silently break a
//   HARD gate in this one. The cost of the factor is quantified in §4.4 — it
//   is what forces the lateral wall to be firm.
//
// ============================================================================
// 4. THE CORRIDOR
//
//   4.1 THE MODEL: A POTENTIAL WELL
//
//   Confinement is stated as an energy budget, not as a force. Let a(sigma) be
//   the corridor's force ladder — the inward acceleration available at outward
//   coordinate sigma — and let LIMIT be the hard limit. Define the remaining
//   budget, the work per unit mass the corridor can still do on the rider
//   between here and the limit:
//
//       U(s) = integral from s to LIMIT of a(sigma) d sigma
//
//   The rider's outward kinetic energy per unit mass is w^2/2. The rider is
//   inside the well iff w^2/2 <= U(s), i.e. iff
//
//       w <= w_allow(s) = sqrt(2 U(s))
//
//   The field applies exactly the excess over that allowance and nothing else:
//
//       a_inward = max(0, w - w_allow(s)) / dt
//
//   Never negative: a boundary can hold, it can never push a rider away from
//   itself, and it can never add speed along any other axis. This is the whole
//   confinement law. Every layer below is a different a(sigma); there is one
//   piece of code.
//
//   4.2 THE DISCRETE FORM, AND WHY THE ALLOWANCE IS EXACTLY ZERO AT THE LIMIT
//
//   sqrt(2U) is the continuous envelope; a rider who obeys it exactly can still
//   cross the limit by braking one step too late. Solving instead for the step
//   ABOUT TO BE TAKEN — w^2/(2A) + w*dt = gap, with A the local firmness —
//   gives the form used everywhere in this file:
//
//       w_allow = -A*dt + sqrt(A^2*dt^2 + 2*U)
//
//   At U = 0 this is exactly 0 for every A and every dt: the allowance reaches
//   zero exactly AT the limit, not near it. At U = A*gap it is the classical
//   discrete-safe braking envelope for a constant-firmness band.
//
//   4.3 INERTNESS IN BOUNDS IS AN IDENTITY, NOT AN OBSERVATION
//
//   Set the ladder to 0 inside the contract boundary and choose the total
//   budget outside it to be
//
//       BUDGET = V_CAP^2/2 + A0*V_CAP*DT_REF
//
//   where A0 is the firmness of the first band outside the boundary. Substitute
//   into 4.2 at the boundary:
//
//       -A0*dt + sqrt(A0^2*dt^2 + V_CAP^2 + 2*A0*V_CAP*dt)
//     = -A0*dt + sqrt((A0*dt + V_CAP)^2)  =  V_CAP        exactly (dt = DT_REF)
//
//   V_CAP = 33 m/s is the accepted physics module's own hard speed clamp, so no
//   rider physics permits to exist can be moving outward faster than the
//   allowance at the boundary. The excess is <= 0 and the applied field is
//   exactly 0.0 — at the boundary and, since the ladder is zero inside it,
//   everywhere inside. That is why §1's promise is a promise and not a hope.
//   (At dt < DT_REF the allowance is strictly greater than V_CAP, so inertness
//   only strengthens. At dt > DT_REF — a degraded frame, outside CONTRACTS.md's
//   fixed 60 Hz — it weakens by O(dt - DT_REF); stated, not hidden.)
//
//   4.4 GEOMETRY: EVERY BOUNDARY DERIVED, IN ORDER
//
//   The chain runs measurement -> limit -> budget -> firmness. Nothing is
//   placed and then justified.
//
//   SOFT LINE vs HARD LIMIT, and why they are not the same place. A braking
//   envelope brings the rider to REST on the line where its budget runs out.
//   If that line were also the hard limit, the hard limit would not be a shell,
//   it would be the parking spot — and the return branch would chatter against
//   it forever (MEASURED on the first build: 921 frames of it after the
//   finish). So every boundary has two lines one SHELL apart:
//
//       SHELL = V_CAP*DT_REF = 0.550 m      one unseen frame at the speed cap
//
//   Inside the soft line the braking envelope runs; between soft and hard the
//   allowance is exactly 0 (hold, but demand no return); past the hard limit
//   the mirrored return acts. One unseen frame is the right width because it is
//   exactly the distance this module can be surprised by: it reads the rider
//   after physics has already moved them.
//
//   LONGITUDINAL. The strongest deceleration TERRAIN can supply horizontally is
//   g*sin(th)*cos(th) = (g/2)*sin(2 th) <= g/2 = 4.905 m/s^2, maximal at
//   th = 45 deg. That is a ceiling, not a taste: no slope, however steep, brakes
//   a rider harder than g/2. Take it as the run-out's firmness and the LENGTH
//   follows from 4.3 rather than being chosen:
//
//       A_Z     = g/2 = 4.905 m/s^2
//       RUN_OUT = BUDGET / A_Z = 111.559 m
//       soft z  = 2511.56 / -111.56      hard z = 2512.11 / -112.11
//
//   Both sit 238 m and 138 m inside the fine-LOD region measured in §3, so the
//   longitudinal barrier is literally a hill: a rider crosses the finish at
//   full speed with zero interference and coasts to rest 111 m later.
//
//   LATERAL. The same construction wants the same 111.559 m of room outside
//   |s| = 120, i.e. a limit at |s| = 231.6. MEASURED, that is not available:
//   the 4 m surface is at 205.75 m and the 2 m surface at 154.9 m. So:
//
//       HARD  = S2 - SHELL = 154.8 - 0.55 = 154.25 m
//       SOFT  = HARD - SHELL             = 153.70 m
//
//   Room = 33.70 m, and the budget then FORCES the lateral corridor to be
//   firmer than any slope:
//
//       required mean firmness = BUDGET / 33.70 = 16.24 m/s^2 = 3.31 x g/2
//
//   Even spending the whole 85.75 m to the 4 m surface would require 6.38
//   m/s^2 = 1.30 x g/2. THE LATERAL CORRIDOR CANNOT BE TERRAIN. That is a
//   measured fact about this mountain, and it is the reason the layer ladder is
//   asymmetric: down-course the corridor is a hill, across-course it is a wall.
//
//   4.5 THE THREE LAYERS
//
//   BERM      |s| in [120, 136.85).  a = A_BERM = g/2 = 4.905 m/s^2.
//     The band where this module's authority is CAPPED AT WHAT A BANK OF SNOW
//     COULD DO. It is a cap, not an added force: the module contributes only the
//     excess over the allowance, and MEASURED the gully is already pulling
//     3.47-4.72 m/s^2 inward here on its own, so most frames need nothing. The
//     berm's allowance runs from 33.00 m/s at the corridor edge to 30.5 m/s at
//     its outer edge — it engages only on a rider leaving at very nearly full
//     speed, which is the correct trigger for the first thing you feel.
//
//   WALL      |s| in [136.85, 153.70).  a = A_WALL = 27.57 m/s^2.
//     What is left of the budget over what is left of the room:
//       A_WALL = (BUDGET - A_BERM*(BERM_END-120)) / (SOFT-BERM_END)
//     This layer is NOT diegetic and this file will not pretend it is: 27.57
//     m/s^2 is 5.62x the strongest bank physically possible. It is the price of
//     the measured fact in §4.4 and of the safety factor in §3, and it is only
//     reachable 17 m outside the corridor the contract gives the player.
//
//   LIMIT / RETURN   |s| > 154.25, or past a longitudinal hard limit.
//     Braking alone stops a rider going out FAST; it does not stop them going
//     out. Past the hard limit the requirement inverts to a mirrored envelope:
//       w_allow = -min(V_CAP, sqrt(2*A_Z*(s - HARD)))
//     the rider must be COMING BACK fast enough to arrive at the line with zero
//     speed, so the return never slingshots them across the corridor into the
//     far wall. Its firmness is A_Z = g/2 (the gentlest rung), and it is capped
//     at V_CAP so the corridor can never demand a speed physics forbids.
//
//     DISCLOSURE, MEASURED: during a RUN this layer engages ZERO frames, on
//     every drive that could be built — the harness probe drive, the 240 s
//     adversarial drive, riding the wall at full boost on both flanks, the same
//     with jumps, and airborne launches straight and diagonally at the wall at
//     the speed cap. peakBeyondLimit_m is 0.000 in all of them: the envelopes
//     never let a rider past a hard limit. It becomes reachable by PLACING a
//     rider outside one, which is what the runner's own out-of-bounds seed does
//     (+/-200 m and +/-400 m at z = 900; tested here also at +/-900 m), and
//     there it is the layer that brings them home. A shell that never fires
//     during a run is still load-bearing the first time something puts a rider
//     through the wall — but calling it part of the racing experience would be
//     false, so it is counted (rs.confine.returnFrames) rather than claimed.
//
//     ONE HONEST RESIDUE. A rider parked on a soft line is not perfectly still:
//     gravity adds a*dt of outward rate each frame and this module can only
//     remove it after the rider has already moved a*dt^2. MEASURED at the
//     run-out, the parked rider creeps down-course at ~3 cm/s, crosses the 0.55
//     m shell after ~18 s of standing still, and then sits ON the hard limit in
//     a 1 mm limit cycle (peakBeyondLimit 0.0005 m, 2-7 m/s^2, alternating
//     between the shell's hold and the return's pull-back). That is the correct
//     steady state of a hard limit under gravity and it costs nothing — no
//     position is ever written — but it means returnFrames is NOT zero on a
//     session that keeps running long after the finish. Reported rather than
//     tuned away, because widening the shell enough to hide it would mean
//     placing the hard limit somewhere the measurement does not support.
//
//   WHAT ACTUALLY ENGAGES, MEASURED. On every GROUNDED drive built here the
//   berm and the wall engage ZERO frames, including a rider boosting straight
//   at the wall for 120 s, who reaches |s| = 142.9 and comes back on his own.
//   The reason is in §1: the gully's own bank is already pulling 3.5-4.7 m/s^2
//   inward out there and the envelope only bills the EXCESS. The layers engage
//   when the rider is AIRBORNE with a large outward rate — launched outward at
//   the speed cap from the corridor edge, the berm takes 31 frames, the wall 29,
//   and the rider tops out at |s| = 148.3. Launched from inside the wall band at
//   the cap, the rider stops exactly on the soft line, |s| = 153.70, at 30, 60
//   and 120 Hz alike. That is the corridor doing its job, and it is worth saying
//   plainly that on the ground the mountain gets there first.
//
//   BAND SPLIT — a CHOICE, labelled. BERM_END = 120 + room/2 = 136.85 splits
//   the 33.70 m of room evenly between the two layers. The alternatives and
//   their prices, so the choice is legible rather than asserted:
//       berm 0 m  -> A_WALL 16.24, peak demand 70.33 m/s^2, no soft first touch
//       berm half -> A_WALL 27.57, peak demand 81.67 m/s^2  <- taken
//       berm all  -> impossible: g/2 over 33.70 m carries 165 of the 547 needed
//   The even split is the neutral point between a token berm and a wall firmer
//   than it needs to be. It is not derived and is not described as derived.
//
//   4.6 THE WRITE CEILINGS
//
//   A_CEIL_H = A_WALL + A_Z + DRIVE_MAX + g/2 = 81.67 m/s^2  (1.84 x DRIVE_MAX)
//     The largest horizontal correction that can be needed while TRACKING the
//     envelopes, term by term: the lateral envelope's own deceleration, plus
//     the longitudinal envelope's, plus the strongest drive the player can aim
//     (DRIVE_MAX = V_BOOST/TAU_BOOST = 44.286 m/s^2 is the accepted physics
//     module's own boost law — a first-order relaxation toward V_BOOST —
//     evaluated at rest), plus the worst horizontal component of gravity, which
//     is g/2 by the identity in §4.4. Nothing else can push the rider outward,
//     so nothing larger can be needed. MEASURED, it binds in exactly two
//     places: the start pen's first few frames as it brakes the rider the
//     harness spawns already rolling (7 frames), and outside a hard limit,
//     where the return branch is asking for a large one-off correction on a
//     rider who was placed there (36-173 frames on the teleport seeds). Inside
//     the containment box, on a rider who got there by riding, it never binds.
//     rs.confine.ceilFrames counts it.
//
//   A_CEIL_3 = A_CEIL_H / NY_MIN = 176.80 m/s^2, NY_MIN = 0.4619 MEASURED
//     A grounded correction must lie in the TANGENT PLANE. Physics' grounded
//     redirect is magnitude-preserving (physics.mjs `retangent` rescales the
//     tangential projection back to |v|), so a correction with a normal
//     component would be laundered back out as forward speed — a confiner that
//     accidentally boosts. There is exactly one tangent vector whose horizontal
//     shadow is the correction the envelope asked for; that one is applied, so
//     no authority is lost to a projection and none is invented by a rescale.
//     The vertical bookkeeping term costs 3-D magnitude on steep ground: h
//     horizontally costs h/n_y. NY_MIN = 0.4619 is the measured minimum surface
//     n_y (a 62.5 deg face at s = -152.5, z = 797) over a superset of the
//     containment box, so A_CEIL_3 can only bind on ground steeper than
//     anything reachable. It is a guard, and it behaves like one: MEASURED,
//     rs.confine.ceil3Frames is 0 on every drive that stays inside the corridor,
//     and fires once on a rider teleported to |s| = 900 — 746 m outside the
//     hard limit, on terrain the mesh already misrepresents by 7.4 m.
//
//   Publishing only the horizontal number would understate what is written;
//   publishing only the 3-D one would overstate what does containment work.
//   Both are in config.
//
//   4.7 CONTAINMENT BOX, CHECKED NOT CHOSEN
//
//     |s| <= 154.25   z in [-112.11, 2512.11]      (the HARD limits)
//
//   Worst mesh divergence anywhere in it: 1.99 m, on a 0.1 m x 0.25 m sweep of
//   the flanks and a 2.5 m grid inside. That is 2.01x inside RS-05's 4 m ceiling. The
//   sweep is a CONSTRAINT the derived geometry had to satisfy — had it failed,
//   the limits would have moved in and the firmnesses up. It is not the source
//   of any number except S2 itself.
//
//   Reach past a soft line: a rider on the envelope cannot cross it (§4.2). The
//   only excess is the drive+gravity the world adds during the frame this
//   module has not yet seen, at most (DRIVE_MAX + g/2)*dt = 0.82 m/s, worth
//   0.014 m of travel — inside the 0.55 m SHELL. rs.confine.peakOffset_m
//   reports the widest line actually reached and peakBeyondLimit_m the furthest
//   past a hard limit.
//
//   4.8 CORRIDOR COORDINATES
//
//   s = x - centreX(z), and with k = centreX'(z) the rates are
//       ds/dt = vx - k*vz          dz/dt = vz
//   so a correction that must produce (A_s across, A_z along) has exactly one
//   horizontal solution: az = A_z, ax = A_s + k*A_z. That is solved directly
//   rather than decomposed onto unit corridor normal/tangent vectors, which
//   would deliver only 1/sqrt(1+k^2) of what was asked (19% short where this
//   course meanders hardest, k = 0.73) — quiet slack in a guarantee. A purely
//   lateral correction leaves dz/dt untouched by construction. The neglected
//   Jacobian term is k'(z)*vz^2, and k' is zero everywhere except at the cache
//   node crossings, where the centreline interpolant has a corner.
//
//   centreX is a corridor scan in the real game, so it is cached on a 10 m grid
//   anchored at multiples of 10 and linearly interpolated — which is the
//   run-runner's own centreline construction on the same node set, so the
//   module's idea of the corridor centre and the gate law's agree to 0.0000 m.
//   k is the exact slope of that interpolant, so the coordinate system and its
//   Jacobian cannot disagree with each other.
//
//   4.9 WHAT IS NOT PROMISED
//
//   Confinement is not free. Every correction takes energy out of the rider,
//   and against a rider boosting straight at the wall the corrective
//   acceleration is large — up to A_CEIL_H, which is what it costs to cancel a
//   boost. It is priced at zero for a player who stays in bounds only because
//   §4.3 makes that a proof. A player who leans on the wall pays for it.
//
//   After the finish the run-out holds the rider indefinitely: the allowance at
//   the soft line is zero, so gravity is cancelled frame after frame and the
//   rider stays parked at z = 2511.6. MEASURED on the probe drive, that is 1075
//   holding frames plus the limit-cycle frames of §4.5 — a STANDING write, not a
//   one-off, counted in rs.confine.activeFraction (8.6% of the session). It is
//   the right behaviour — the run is over and the mountain has run out — but
//   calling it anything other than a standing write would be false.
//
// ============================================================================
// 5. THE LANDING LEDGER — adjudicated by the TRICK system
//
//   Counting physics touchdowns lets the card contradict its own score.
//   physics.mjs `land` labels a touchdown from board-vs-velocity yaw and a held
//   grab; it knows nothing about uber animations, so a JA-15 bail (uber
//   incomplete at touchdown) is labelled 'clean' by physics while the trick
//   system voids the entire jump. A card built on the physics label reports a
//   clean landing next to a score that says otherwise.
//
//   So every touchdown is adjudicated against the TRICK system, using only
//   fields CONTRACTS.md makes public (score, awards, lastAward, starMult):
//
//     open   on the airborne -> grounded edge; snapshot ts.score,
//            ts.awards.length, ts.lastAward, and record the physics label.
//     close  BANKED if within LEDGER_WINDOW steps the trick system banks the
//            jump — score rose, or awards grew, or lastAward became a different
//            non-null object. A clean 0-point air banks a lastAward of {name:
//            'Air', points: 0}, so a scoreless clean landing still counts as
//            landed. VOIDED otherwise, which is what a crash looks like from
//            outside (the trick reducer sets lastAward to null and banks
//            nothing).
//
//   LEDGER_WINDOW = 2 steps. 1 is DERIVED: the trick FSM freezes its verdict at
//   the touchdown step and resolves it on the following step, so a harness
//   landingOverride pass can run in between. The second is a CHOICE — one step
//   of slack for a trick-lane candidate that defers one more. Short by design:
//   long enough to see the bank, too short to steal the next jump's.
//
//   Both verdicts are kept and reported separately:
//     results.landed / .crashed   the TRICK system's verdict (authoritative)
//     results.verdictSplits       touchdowns where physics DISAGREED
//     results.physUnlabelled      touchdowns physics had no opinion on
//   A null physics label is an absence of opinion, not a disagreement, so it
//   gets its own counter and cannot inflate verdictSplits.
//
// ============================================================================
// 6. RESULTS — the banked award, and no invented grades
//
//   bestTrick is the NAME OF THE BEST BANKED AWARD of the run: ts.lastAward is
//   the trick system's whole banked-jump summary ("Frontside 360 + Grab") and
//   its points ALREADY INCLUDE any star multiplier the trick system credited.
//   The ledger records every bank as it happens and the card reports the
//   highest-scoring one — the SSX money shot — not one entry picked out of
//   ts.awards, and not merely the last one banked. results.lastTrick carries
//   the final bank separately for a HUD that wants it.
//
//   The star is reported as results.bestTrickStarAtLanding: the public
//   trickState().starMult carried into that landing. It is labelled "at
//   landing" and not "applied" because the trick system credits a star only on
//   a CLEAN landing and clean-vs-sketchy is not on its public surface. No
//   string matching against another lane's award names, no reaching into trick
//   internals: this module has to work against any candidate in that lane.
//
//   NO GRADE BANDS, NO MEDALS. Inventing a letter ladder over a speed ladder
//   the reference bar itself marks TOLERANCE is invention wearing a hat.
//   results.rank is null with the reason attached, and results.anchors carries
//   the real anchors from references/REFERENCE_BAR.md (uber base 13,210-22,580;
//   ~130K for a multi-star master jump) so a reader can place a score against
//   something sourced instead of against a band this module made up.
//
// ============================================================================
// 7. SELF-CHECK
//
//   node harness/run-runner.mjs --module sandbox/run-structure/B/run.mjs
//     10/10, hardFails 0.
//     moduleYawAuthority_degps  0.00   (RS-10, bar 5)   <- writes no heading
//     maxDivergenceReached_m    0.85   (RS-05, bar 4)
//     maxCorrectionJump_m       0.157  (RS-06, bar 2)   <- the rider's own
//                                      travel in one frame; the module's own
//                                      positional write is 0.000000 m
//     startHolds                1      (RS-09, drift 0.28 m against a 3 m bar)
//     runDuration_s             260.0  (RS-08, band 90-300)
//
//   PACE COST, MEASURED: the same probe drive with NO run module attached —
//   bare physics + tricks — reaches zFinish at t = 266.4 s. This module's
//   reported run time is 260.0 s, and the clock starts at the gate drop. The
//   corridor cannot cost anything on that line: §4.3 makes it inert in bounds
//   and the drive's widest line is 36.4 m, so it never fires.
//
//   WHAT THE PEN COSTS, MEASURED AND NOT SMOOTHED OVER: released from rest onto
//   a 23 deg roll with boost already pressed, the probe drive over-steers, goes
//   airborne within 0.7 s, spins out and slides about 27 m back up-course (to
//   z = -11.9) before it recovers. That is a consequence of starting a run the
//   way a start gate starts one — from a standstill — meeting a drive whose
//   steering gain was tuned for a rider already rolling. Through every frame of
//   it this module applies EXACTLY 0.00 m/s^2 (asserted in selftest.mjs), and
//   the run still comes in 6.4 s ahead of the no-module baseline. Damping the
//   spin-out would mean steering, so it is left alone and reported.
//
//   BEYOND THE GATES — the drives built here to test what the gates cannot, all
//   of them reporting selfPos 0.000000 m, selfYaw 0.000000 deg/s and
//   inBoundsWriteFrames 0:
//     * boosting straight into each flank for 120 s          |s| max 142.9, 103.5
//     * the same with a jump every 3 s                       |s| max 136.8, 139.3
//     * airborne launch outward at the speed cap, 8 seeds     stops at 153.70
//     * airborne launch DIAGONALLY at the wall                stops at 153.70
//     * the same at 30 Hz / 60 Hz / 120 Hz                    stops at 153.70
//     * teleported to |s| = 200, 400 and 900                  returned, no jump
//   Reproduce all of them: node sandbox/run-structure/B/selftest.mjs (65 checks).
//   peakBeyondLimit_m is 0.000 in every one of them except the parked limit
//   cycle of §4.5 (0.0005 m) and the teleport seeds (which start outside).
//
//   WHAT THE GATES DID NOT MEASURE, stated plainly:
//     * RS-10's in-bounds frames are frames on which this module provably
//       writes nothing, so that gate cannot tell a correct corridor from an
//       absent one. It is a test of restraint, not of confinement.
//     * No RS gate makes the lateral berm or wall fire at all: the harness's
//       adversarial drive reaches only |s| = 69.3 against this module, and even
//       a purpose-built 120 s wall-charge stays inside the envelope because the
//       gully gets there first (§4.5). Every number above about the wall comes
//       from drives written for this file, not from the gate law.
//     * The 74.74 deg of §0 is the one place this module can move a rider's
//       heading, it is invisible to RS-10 by construction (it happens inside
//       ph.step, one frame later), and no gate looks for it.
// ============================================================================

// ---------------------------------------------------------------------------
// PHYSICS ANCHORS — copied from src/physics/physics.mjs DEFAULTS (the accepted
// module). Pinned rather than imported so this file stays a pure standalone
// module with no top-level await; env.physics overrides them, and
// config.physicsRequires publishes the values this corridor was derived
// against so a one-line test can catch a physics retune that invalidates it.
// ---------------------------------------------------------------------------
const PINNED = {
  V_CAP: 33,          // m/s hard speed clamp                (DEFAULTS.V_CAP)
  V_BOOST: 31,        // m/s boost target speed              (DEFAULTS.V_BOOST)
  TAU_BOOST: 0.7,     // s boost relaxation time constant    (DEFAULTS.TAU_BOOST)
  G_GROUND: 9.81,     // m/s^2                               (DEFAULTS.G_GROUND)
};

// ---------------------------------------------------------------------------
// MEASURED — facts about THIS world, taken this session against
// src/render/main.mjs with the run-runner's own centreline and divergence
// probes. Each is a measurement, not a preference; the sweep resolution is
// recorded next to each so a reader can re-run it.
// ---------------------------------------------------------------------------
const MEASURED = {
  // cumulative sup of |analytic - bilinear| vs lateral offset, both flanks,
  // z in [-160, 2560], 1 m x 0.5 m grid (0.25 m near the crossings)
  divergenceByOffset_m: { 0: 0.93, 40: 0.76, 80: 0.78, 120: 0.95, 140: 1.36,
    150: 1.95, 160: 2.46, 180: 2.29, 200: 3.69, 205: 3.88, 206: 4.20 },
  // last offset VERIFIED at or under 2 m on a 0.1 m x 0.25 m sweep of the
  // whole containment z range (sup 1.986 there); the crossing is at 154.9
  lateral2mSurface_m: 154.8,
  lateral4mSurface_m: 205.75,       // cumulative sup first exceeds 4 m
  // z sweep at |s| <= 200: the 4 m crossings land exactly on the fine-LOD
  // region edge (cells 15.6 m inside, 83.3 m outside), nowhere before it
  longitudinal4mSurface_z: { down: 2755, up: -255 },
  fineLodZ: [-250, 2750],
  // worst divergence anywhere in this module's containment box (0.1 m x 0.25 m
  // lateral sweep; 2.5 m grid for the interior)
  divergenceInContainmentBox_m: 1.99,
  // minimum surface n_y over |s| <= 155, z in [-113, 2513] (a superset of the
  // containment box), on the same 0.05 m stencil physics uses: 62.5 deg face
  minSurfaceNy: 0.4619,
  // the gully's OWN inward horizontal pull in corridor coordinates, both
  // flanks, over the containment box (m/s^2) — the bank that is already there
  terrainInwardPull_mps2: {
    0: { min: -3.50, median: 0.00, max: 3.50 },
    20: { min: -2.63, median: 1.32, max: 4.62 },
    40: { min: -0.68, median: 2.39, max: 5.62 },
    60: { min: 0.61, median: 3.23, max: 6.19 },
    80: { min: 2.06, median: 3.92, max: 6.34 },
    100: { min: 3.09, median: 4.45, max: 6.35 },
    120: { min: 3.47, median: 4.72, max: 6.21 },
    140: { min: 3.55, median: 4.74, max: 5.97 },
  },
  // src/render/main.mjs plants pines only where |x - centerX(z)| is in
  // (55, 720) — the render lane's tree line, in this module's own coordinate
  treeLine_m: 55,
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W_CORR = B.halfWidth ?? 120;                  // contract corridor edge

  const P = { ...PINNED, ...(env.physics ?? {}) };
  const PHYS_SOURCE = env.physics ? 'env' : 'pinned';
  const V_CAP = P.V_CAP;
  const G = P.G_GROUND;
  const DT_REF = 1 / 60;                              // CONTRACTS.md: fixed 60 Hz

  // --- firmness ceiling for anything that calls itself terrain (§4.4) -------
  // a slope's inward horizontal accel is (g/2)*sin(2 theta) <= g/2, maximal at
  // 45 deg. No bank can beat it, so no layer claiming to be a bank may either.
  const A_BERM = G / 2;                                        // 4.905
  const A_Z = A_BERM;                                          // run-out = a hill
  // strongest drive the player can aim: physics' own boost relaxation at rest
  const DRIVE_MAX = P.V_BOOST / P.TAU_BOOST;                   // 44.286

  // --- the budget that makes the corridor edge exactly inert (§4.3) --------
  const BUDGET = (V_CAP * V_CAP) / 2 + A_BERM * V_CAP * DT_REF;   // 547.198

  // --- the gap between every soft line and its hard limit (§4.4) -----------
  // one unseen frame at the speed cap: exactly the distance this module can be
  // surprised by, since it reads the rider after physics has moved them.
  const SHELL = V_CAP * DT_REF;                                // 0.550 m

  // --- longitudinal: firmness chosen, length derived ------------------------
  const RUN_OUT = BUDGET / A_Z;                                // 111.559 m
  const Z_SOFT_DN = zFinish + RUN_OUT, Z_HARD_DN = Z_SOFT_DN + SHELL;
  const Z_SOFT_UP = zStart - RUN_OUT, Z_HARD_UP = Z_SOFT_UP - SHELL;

  // --- lateral: limit measured, firmness derived ---------------------------
  // one shell inside the 2 m divergence surface (§3 safety factor, §4.7)
  const L_HARD = MEASURED.lateral2mSurface_m - SHELL;          // 154.25
  const L_SOFT = L_HARD - SHELL;                               // 153.70
  const ROOM = L_SOFT - W_CORR;                                // 33.70
  const BERM_END = W_CORR + ROOM / 2;                          // 136.85  (CHOICE)
  const A_WALL = (BUDGET - A_BERM * (BERM_END - W_CORR)) / (L_SOFT - BERM_END);

  // --- write ceilings (§4.6) ------------------------------------------------
  const A_CEIL_H = A_WALL + A_Z + DRIVE_MAX + A_BERM;
  const NY_MIN = MEASURED.minSurfaceNy;
  const A_CEIL_3 = A_CEIL_H / NY_MIN;

  // --- run presentation ----------------------------------------------------
  const COUNTDOWN_S = env.countdown_s ?? 3;   // CHOICE: the genre's 3-2-1-GO
  const CHECKPOINTS = env.checkpoints ?? 6;   // CHOICE: presentation only
  const LEDGER_WINDOW = 2;                    // 1 derived + 1 slack (§5)

  const cpZ = [];
  for (let i = 1; i <= CHECKPOINTS; i++) cpZ.push(zStart + (zFinish - zStart) * i / (CHECKPOINTS + 1));

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth: W_CORR,
    maxDivergence_m: 4,                       // RS-05's ceiling, as defined
    // ---- this module's own guarantee, published separately ----
    divergenceInContainmentBox_m: MEASURED.divergenceInContainmentBox_m,
    divergenceSafetyFactor: 4 / MEASURED.divergenceInContainmentBox_m,
    // ---- corridor geometry ----
    bermStart_m: W_CORR, bermEnd_m: BERM_END,
    lateralSoftLine_m: L_SOFT, lateralHardLimit_m: L_HARD, shell_m: SHELL,
    runOut_m: RUN_OUT,
    zSoftDown_m: Z_SOFT_DN, zHardDown_m: Z_HARD_DN,
    zSoftUp_m: Z_SOFT_UP, zHardUp_m: Z_HARD_UP,
    budget_m2ps2: BUDGET,
    // ---- firmnesses / ceilings ----
    bermFirmness_mps2: A_BERM, wallFirmness_mps2: A_WALL,
    longitudinalFirmness_mps2: A_Z, returnFirmness_mps2: A_Z,
    driveMax_mps2: DRIVE_MAX,
    ceilAccelHorizontal_mps2: A_CEIL_H, ceilAccel3D_mps2: A_CEIL_3,
    ceilAccelHorizontal_xDriveMax: A_CEIL_H / DRIVE_MAX,
    minSurfaceNy: NY_MIN,
    // ---- run ----
    countdown_s: COUNTDOWN_S, checkpoints: CHECKPOINTS, checkpointZ: cpZ.slice(),
    ledgerWindow_steps: LEDGER_WINDOW,
    // ---- provenance ----
    physicsAnchor: PHYS_SOURCE,
    physicsRequires: { ...PINNED },
    measured: MEASURED,
    derivation: {
      model: 'POTENTIAL WELL. a(sigma) is the corridor force ladder; U(s) = integral of a from s to the limit is the work per unit mass still available; the rider is inside the well iff w^2/2 <= U(s). The field applies max(0, w - sqrt(2U))/dt — exactly the excess in outward kinetic energy and nothing else. One law, three ladders.',
      discreteForm: 'solved for the step about to be taken: w_allow = -A*dt + sqrt(A^2*dt^2 + 2U). At U = 0 this is EXACTLY 0 for every A and every dt, so the allowance reaches zero exactly AT the limit rather than near it, and a rider on the envelope cannot cross by braking one step late.',
      inertness: 'IDENTITY, not observation. The ladder is 0 inside the contract boundary and the budget outside it is BUDGET = V_CAP^2/2 + A0*V_CAP*DT_REF, which makes the discrete allowance at the boundary collapse to -A0*dt + sqrt((A0*dt + V_CAP)^2) = V_CAP exactly. V_CAP is physics own hard clamp, so no rider that can exist exceeds the allowance in bounds; the excess is <= 0 and the applied field is exactly 0.0 m/s^2. This is why moduleYawAuthority is 0 by construction and not by luck. dt < DT_REF only strengthens it; dt > DT_REF (outside CONTRACTS.md fixed 60 Hz) weakens it by O(dt - DT_REF).',
      bermFirmness: 'g/2 = 4.905. A slope inward horizontal accel is (g/2)*sin(2*theta) <= g/2, maximal at 45 deg — a physical ceiling on any bank. The berm band is the band where this module CAPS ITS OWN AUTHORITY at that ceiling; it is not an added force. MEASURED, the gully already pulls 3.47 (worst) to 4.72 (median) m/s^2 inward at |s| = 120, i.e. 96% of the ceiling, so a synthetic bank there would be stacked on a real one.',
      longitudinal: 'firmness chosen as terrain (g/2), LENGTH derived: RUN_OUT = BUDGET/A_Z = 111.559 m. Down-course and up-course limits land 238 m and 138 m inside the measured fine-LOD region, so the longitudinal barrier is literally a hill and the finish line is crossed at full speed with zero interference.',
      lateralLimit: 'MEASURED, then one unseen frame taken out: HARD LIMIT = S2 - SHELL = 154.8 - 0.55 = 154.25 and SOFT LINE = HARD - SHELL = 153.70, where S2 = 154.8 is the widest offset VERIFIED at or under 2 m of cumulative worst mesh-vs-physics divergence on a 0.1 m x 0.25 m sweep (the crossing is at 154.9) (half of RS-05 ceiling — the safety factor, a labelled CHOICE, because the divergence field is the render lane LOD schedule and a coarsening there must not silently break a HARD gate here).',
      lateralFirmnessForced: 'the same terrain-grade construction used down-course needs 111.559 m of room outside |s| = 120, i.e. a limit at 231.6 m. MEASURED it is not there: the 4 m surface is at 205.75 and the 2 m surface at 154.9. Required mean firmness is BUDGET/33.70 = 16.24 m/s^2 = 3.31 x g/2, and even spending every metre to the 4 m surface would need 1.30 x g/2. THE LATERAL CORRIDOR CANNOT BE TERRAIN. The asymmetry between the hill down-course and the wall across-course is measured, not preferred.',
      wallFirmness: 'A_WALL = (BUDGET - A_BERM*(BERM_END-120))/(SOFT-BERM_END) = 27.57 m/s^2 — what is left of the budget over what is left of the room. It is 5.62x the strongest bank that can physically exist and this module does not describe it as terrain; it is a wall, and it starts 17 m outside the corridor the contract gives the player.',
      bandSplit: 'CHOICE, labelled: BERM_END = 120 + room/2 splits the 33.70 m evenly. berm 0 m gives A_WALL 16.24 and peak demand 70.33 with no soft first touch; berm half gives A_WALL 27.57 and peak demand 81.67; berm all is impossible (g/2 over 33.70 m carries 165 of the 547 needed). The even split is the neutral point, is not derived, and is not described as derived.',
      returnBranch: 'past a limit the requirement inverts to the mirror: w_allow = -min(V_CAP, sqrt(2*A_Z*p)), i.e. the rider must be coming back fast enough to arrive at the line with zero speed, so a return never slingshots them into the far wall. Firmness A_Z = g/2, the gentlest rung; capped at V_CAP so the corridor can never demand a speed physics forbids. DISCLOSED, MEASURED: it engages ZERO frames during a run on every drive that could be built (probe drive, 240 s adversarial, 120 s wall charges on both flanks with and without jumps, airborne launches straight and diagonal at the speed cap, 30/60/120 Hz), and becomes reachable only by PLACING a rider outside a hard limit. It does engage after the finish, as the outer half of the 1 mm limit cycle a parked rider settles into once gravity has crept them across the 0.55 m shell — see the honest residue in the header.',
      ceilings: 'TWO, both published and both enforced. Horizontal A_CEIL_H = A_WALL + A_Z + DRIVE_MAX + g/2 = 81.67 — the two envelopes own decelerations plus the strongest drive the player can aim (physics own boost law at rest) plus the worst horizontal gravity, and nothing else can push the rider outward. 3-D A_CEIL_3 = A_CEIL_H/NY_MIN = 176.80 with NY_MIN = 0.4619 MEASURED, because a grounded push must lie in the tangent plane (physics grounded redirect is magnitude-preserving, so a normal component would be laundered back out as forward speed) and delivering h horizontally costs h/n_y. The difference is vertical bookkeeping that does no containment work, which is why the derivations use the horizontal number and the disclosure uses both.',
      startGate: 'the gate sits at the rider STAGED position (the first z observed, clamped no further up-course than the back-stop soft line), not at zStart: a bar 40 m down-course of a staged rider catches them after 40 m of sliding instead of holding them. While grounded in ready the pen brings the rider to REST, bounded by the same two ceilings as everything else here. Holding only the down-course axis was tried and MEASURED wrong: it leaves a lateral residue that the board frame reads as fakie, and physics boost law relaxes the MAGNITUDE of forward speed and re-signs it, so the rider was driven backwards 125 m up the mountain into the back-stop. Airborne in ready the gate does nothing — a bar cannot hold a rider off the ground; giving it an airborne envelope reversed a flying rider whole down-course velocity at 81.5 m/s^2, turning their velocity heading 107 deg. One branch, no rolling-start special case, so every harness probe exercises the gate. The clock starts at the drop.',
      ledger: 'touchdowns are adjudicated against the TRICK system, not physics: physics.land knows nothing about uber animations, so a JA-15 bail reads clean to it while the trick system voids the jump. BANKED iff within 2 steps ts.score rose, ts.awards grew, or ts.lastAward became a different non-null object (a clean 0-point air banks {name: Air, points: 0}, so a scoreless clean landing still counts). Window = 1 derived (the trick FSM resolves one step after touchdown so a landingOverride pass can run between) + 1 step of slack (CHOICE).',
      bestTrick: 'the name of the BEST banked award of the run. ts.lastAward is the whole banked-jump summary and its points already include any star the trick system credited; the ledger records every bank and the card reports the highest. results.lastTrick carries the final bank separately. The star is reported as bestTrickStarAtLanding — the public trickState().starMult carried into that landing — labelled at landing and not applied, because a star is credited only on a CLEAN landing and clean-vs-sketchy is not on the trick system public surface.',
      rank: 'absent by decision. No defensible speed ladder exists yet (the reference bar own pacing numbers are all TOLERANCE), and a grade band over an unsettled ladder is invention. results.anchors carries the sourced anchors instead.',
      choices: 'the complete list of things in this file that are choices rather than derivations, citations or measurements. NUMBERS: the 2x safety factor on the divergence ceiling (reason in section 3); the even berm/wall band split (alternatives and their prices in bandSplit); COUNTDOWN_S = 3 and CHECKPOINTS = 6 (presentation only, no physical claim); the second step of LEDGER_WINDOW. DESIGN DECISIONS, each argued in the header rather than buried: zero corridor authority strictly in bounds once the run starts (section 1); the start pen is a full stop rather than a down-course-only hold (startGate); the gate sits at the staged position rather than at zStart (startGate); the corridor acts while the rider is airborne, which opens the one indirect heading channel this module has (section 0); the airborne correction is lateral-only so it keeps the rider down-course speed, at the price of rotating a diagonal velocity; no rank or grade band (rank). Every other number here is either derived from those, cited to src/physics/physics.mjs, or measured against src/render/main.mjs and recorded in config.measured.',
    },
  };

  // -------------------------------------------------------------- centreline
  // 10 m grid anchored at multiples of 10 + linear interpolation: the same node
  // set and the same construction the run-runner uses, so the two centrelines
  // agree exactly. k is the exact slope of the interpolant (§4.8).
  const CX_STEP = 10;
  const cCache = new Map();
  function node(i) {
    let v = cCache.get(i);
    if (v === undefined) { v = rawCenter(i * CX_STEP); cCache.set(i, v); }
    return v;
  }
  function centre(z) {
    const f = z / CX_STEP, i = Math.floor(f), t = f - i;
    return node(i) * (1 - t) + node(i + 1) * t;
  }
  const centreSlope = z => {
    const i = Math.floor(z / CX_STEP);
    return (node(i + 1) - node(i)) / CX_STEP;
  };

  // Surface normal on the SAME 0.05 m central-difference stencil the physics
  // module's default sampleNormal uses, so the plane this module pushes along
  // is exactly the plane physics will project the result against. Only ever
  // called on a frame that is actually correcting.
  function normalAt(x, z) {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  }

  // ------------------------------------------------------------ the one law
  // U: remaining budget (work per unit mass). A: local band firmness.
  // Returns the fastest OUTWARD rate permitted here — see §4.2.
  const allowInside = (U, A, dt) => -A * dt + Math.sqrt(A * A * dt * dt + 2 * U);
  // Past the limit the requirement mirrors: the rider must be coming back.
  const allowOutside = (p, A) => -Math.min(V_CAP, Math.sqrt(2 * A * p));

  // Lateral ladder: 0 inside the corridor, A_BERM over the berm band, A_WALL
  // over the wall band. Budget = integral of that from s to the SOFT line.
  function lateralBudget(sAbs) {
    if (sAbs >= L_SOFT) return 0;
    const a = sAbs > W_CORR ? sAbs : W_CORR;          // ladder is 0 inside
    const bermPart = A_BERM * (BERM_END - (a < BERM_END ? a : BERM_END));
    const wallPart = A_WALL * (L_SOFT - (a > BERM_END ? a : BERM_END));
    return bermPart + wallPart;
  }
  const lateralFirmness = sAbs => (sAbs < BERM_END ? A_BERM : A_WALL);

  // One boundary, both sides. U is the remaining budget to the soft line (0 at
  // or past it, which makes allowInside return exactly 0 — the shell holds but
  // demands no return); pastHard > 0 switches to the mirrored return branch.
  function boundaryDemand(w, U, A, pastHard, dt) {
    const wAllow = pastHard > 0 ? allowOutside(pastHard, A_Z) : allowInside(U, A, dt);
    return demand(w, wAllow, dt);
  }

  // Demand: exactly the excess of the outward rate over the allowance, over dt.
  // Never negative — a boundary holds, it never pushes a rider away from itself.
  function demand(w, wAllow, dt) {
    const excess = w - wAllow;
    return excess > 0 ? excess / dt : 0;
  }

  // ------------------------------------------------------------------- state
  function init() {
    return {
      // ---- contract-required ----
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: 1,                  // single-rider gauntlet build: always P1
      results: null,
      outOfBounds: false,
      // ---- start gate / presentation ----
      countdown_s: COUNTDOWN_S,
      light: 'red',              // 'red' | 'set' | 'go'
      gateOpen: false,
      gateZ: null,               // where the bar physically is (staged position)
      progress: 0,               // 0..1 down the course
      checkpoints: [],           // [{ index, z, t, speed_kmh, score }]
      nextCheckpoint: 0,
      // ---- live telemetry ----
      speed_kmh: 0,
      topSpeed_kmh: 0,
      airTime_s: 0,
      biggestAir_s: 0,
      distanceRidden_m: 0,
      jumps: 0,
      landed: 0,                 // touchdowns the TRICK system banked
      crashed: 0,                // touchdowns the TRICK system voided
      verdictSplits: 0,          // touchdowns where physics DISAGREED
      physUnlabelled: 0,         // touchdowns physics had no opinion on
      openTouchdowns: 0,         // touchdowns the finish beat to adjudication
      banks: 0,
      bestTrick: null,
      bestTrickPoints: 0,
      bestTrickStar: 1,
      lastTrick: null,
      // ---- confinement telemetry: computed about itself, never asserted ----
      confine: {
        active: false,           // any corrective accel this frame
        depth_m: 0,              // furthest past a boundary this frame
        accel_mps2: 0,           // 3-D magnitude applied this frame
        offset_m: 0,             // |s| this frame
        peakOffset_m: 0,         // widest line the rider has taken
        peakBeyondLimit_m: 0,    // furthest past a hard limit (want ~0)
        peakDemand_mps2: 0,      // largest demand BEFORE the ceilings
        peakAppliedH_mps2: 0,    // largest horizontal applied (<= A_CEIL_H)
        peakApplied3_mps2: 0,    // largest 3-D applied (<= A_CEIL_3)
        bermFrames: 0,           // the berm band was the acting lateral layer
        wallFrames: 0,           // the wall band was
        returnFrames: 0,         // a return branch fired (past a limit)
        penFrames: 0,            // the start pen held a grounded rider at rest
        runOutFrames: 0,         // the down-course run-out held the rider
        backStopFrames: 0,       // the up-course back-stop held the rider
        ceilFrames: 0,           // A_CEIL_H actually bound
        ceil3Frames: 0,          // A_CEIL_3 actually bound (want 0)
        airWriteFrames: 0,       // airborne velocity writes (the yaw channel)
        peakAirWrite_mps2: 0,
        inBoundsWriteFrames: 0,  // writes while strictly in bounds (MUST be 0)
        activeFrames: 0,
        totalFrames: 0,
        activeFraction: 0,
        maxSelfVelDelta_mps: 0,  // largest velocity change this module made
        maxSelfPosDelta_m: 0,    // diffed around this module's own write block
        maxSelfYaw_deg: 0,       //   every frame — computed, not asserted
      },
      // ---- internals ----
      _t: 0,                     // total sim time, all phases
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
      _ledger: null,             // open touchdown awaiting the trick verdict
    };
  }

  // ------------------------------------------------------------------ results
  // The one place a card is built. `results()` before the finish returns the
  // live readback from this same function, so the frozen card and the HUD's
  // running card can never drift apart.
  function assemble(rs, ts) {
    const t = ts ?? {};
    return {
      // ---- contract-required six ----
      time_s: +rs.time_s.toFixed(3),
      score: t.score ?? 0,
      bestTrick: rs.bestTrick,
      tricky: !!t.tricky,
      landed: rs.landed,
      crashed: rs.crashed,
      // ---- the banked award, in full (§6) ----
      bestTrickPoints: Math.round(rs.bestTrickPoints),
      bestTrickStarAtLanding: rs.bestTrickStar,
      lastTrick: rs.lastTrick ? { ...rs.lastTrick } : null,
      banks: rs.banks,
      trickyLetters: t.trickyLetters ?? 0,
      meter: +(t.meter ?? 0).toFixed(3),
      // ---- the run ----
      place: rs.place,
      jumps: rs.jumps,
      verdictSplits: rs.verdictSplits,
      physUnlabelled: rs.physUnlabelled,
      openTouchdowns: rs.openTouchdowns,
      topSpeed_kmh: +rs.topSpeed_kmh.toFixed(1),
      avgSpeed_kmh: rs.time_s > 0 ? +(3.6 * rs.distanceRidden_m / rs.time_s).toFixed(1) : 0,
      airTime_s: +rs.airTime_s.toFixed(2),
      biggestAir_s: +rs.biggestAir_s.toFixed(2),
      distanceRidden_m: Math.round(rs.distanceRidden_m),
      courseLength_m: zFinish - zStart,
      checkpoints: rs.checkpoints.map(c => ({ index: c.index, z: c.z,
        t: +c.t.toFixed(3), speed_kmh: c.speed_kmh, score: c.score })),
      // ---- confinement, self-measured ----
      confinement: {
        activeFraction: +rs.confine.activeFraction.toFixed(4),
        widestLine_m: +rs.confine.peakOffset_m.toFixed(2),
        peakCorrection_mps2: +rs.confine.peakAppliedH_mps2.toFixed(2),
        beyondLimit_m: +rs.confine.peakBeyondLimit_m.toFixed(3),
        inBoundsWriteFrames: rs.confine.inBoundsWriteFrames,
        startPenFrames: rs.confine.penFrames,
        selfPositionWrite_m: +rs.confine.maxSelfPosDelta_m.toFixed(6),
        selfYawWrite_deg: +rs.confine.maxSelfYaw_deg.toFixed(6),
        airWriteFrames: rs.confine.airWriteFrames,
      },
      // ---- no invented grades (§6) ----
      rank: null,
      rankReason: 'no grade bands: the reference bar marks every pacing number TOLERANCE, so a letter ladder over it would be invention. Use the sourced anchors.',
      anchors: {
        uberBaseMin: 13210, uberBaseMax: 22580,
        multiStarMasterJump: 130000,
        source: 'references/REFERENCE_BAR.md sections 3.3 and 5',
      },
    };
  }

  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
    return o;
  }

  // ------------------------------------------------------------------- step
  function step(rs, ph, ts, dt = DT_REF) {
    if (!ph || !ph.pos || !ph.vel || !(dt > 0)) return rs;
    const C = rs.confine;
    C.totalFrames++;
    rs._t += dt;

    // --- SELF-AUDIT SNAPSHOT: pos + heading, diffed after the write block ---
    const px = ph.pos[0], py = ph.pos[1], pz = ph.pos[2];
    const h0 = ph.heading;
    const vx0 = ph.vel[0], vy0 = ph.vel[1], vz0 = ph.vel[2];

    const x = px, z = pz;
    const cx = centre(z), k = centreSlope(z);
    const s = x - cx, sAbs = Math.abs(s), sSign = s >= 0 ? 1 : -1;
    const onGround = !!ph.onGround;

    // ---------------------------------------------------------- phase machine
    if (rs.gateZ === null) rs.gateZ = Math.max(z, Z_SOFT_UP);   // staged position
    if (rs.phase === 'ready') {
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.light = rs.countdown_s > COUNTDOWN_S * (2 / 3) ? 'red'
        : rs.countdown_s > 0 ? 'set' : 'go';
      if (rs.countdown_s <= 0) { rs.phase = 'running'; rs.gateOpen = true; rs.light = 'go'; }
    } else if (rs.phase === 'running') {
      rs.time_s += dt;
      if (z >= zFinish) {
        rs.phase = 'finished';
        rs.finished = true;
        if (rs._ledger) rs.openTouchdowns++;
        rs._ledger = null;
        rs.results = deepFreeze(assemble(rs, ts));
      }
    }

    // ------------------------------------------------------- live telemetry
    const speed = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_kmh = +(speed * 3.6).toFixed(1);
    if (rs.phase === 'running') {
      if (rs.speed_kmh > rs.topSpeed_kmh) rs.topSpeed_kmh = rs.speed_kmh;
      if (rs._prevPos) rs.distanceRidden_m += Math.hypot(
        x - rs._prevPos[0], py - rs._prevPos[1], z - rs._prevPos[2]);
      rs.progress = clamp((z - zStart) / (zFinish - zStart), 0, 1);
      // checkpoint stream
      while (rs.nextCheckpoint < cpZ.length && z >= cpZ[rs.nextCheckpoint]) {
        rs.checkpoints.push({ index: rs.nextCheckpoint + 1,
          z: +cpZ[rs.nextCheckpoint].toFixed(1), t: rs.time_s,
          speed_kmh: rs.speed_kmh, score: ts?.score ?? 0 });
        rs.nextCheckpoint++;
      }
      if (!onGround) { rs._airRun += dt; rs.airTime_s += dt; }
    }
    rs._prevPos = [x, py, z];

    // ------------------------------------------------ landing ledger (§5)
    if (!onGround && !rs._wasAir) {                       // TAKEOFF
      if (rs.phase === 'running') rs.jumps++;
      rs._airRun = 0;
    }
    if (onGround && rs._wasAir) {                         // TOUCHDOWN
      if (rs._airRun > rs.biggestAir_s) rs.biggestAir_s = rs._airRun;
      if (rs._ledger) rs.openTouchdowns++;                // never adjudicated
      rs._ledger = {
        steps: 0,
        physLabel: ph.landing ?? null,
        star: (ts && typeof ts.starMult === 'number') ? ts.starMult : 1,
        score: ts?.score ?? 0,
        awards: ts?.awards?.length ?? 0,
        award: ts?.lastAward ?? null,
      };
    }
    if (rs._ledger && rs.phase !== 'finished') {
      const L = rs._ledger;
      L.steps++;
      const la = ts?.lastAward ?? null;
      const banked = !!la && (la !== L.award
        || (ts?.awards?.length ?? 0) > L.awards
        || (ts?.score ?? 0) > L.score);
      if (banked || L.steps >= LEDGER_WINDOW) {
        const trickCrash = !banked;
        if (banked) {
          rs.landed++; rs.banks++;
          const pts = typeof la.points === 'number' ? la.points : 0;
          rs.lastTrick = { name: la.name ?? 'Air', points: Math.round(pts), star: L.star };
          if (!rs.bestTrick || pts > rs.bestTrickPoints) {
            rs.bestTrick = la.name ?? 'Air';
            rs.bestTrickPoints = pts;
            rs.bestTrickStar = L.star;
          }
        } else rs.crashed++;
        if (L.physLabel === null) rs.physUnlabelled++;
        else if ((L.physLabel === 'crash') !== trickCrash) rs.verdictSplits++;
        rs._ledger = null;
      }
    }
    rs._wasAir = !onGround;

    // ============================================================ CONFINEMENT
    // Outward lateral rate in corridor coordinates: ds/dt = vx - k*vz (§4.8).
    const wLat = (ph.vel[0] - k * ph.vel[2]) * sSign;
    const vz = ph.vel[2];
    let aS = 0;                                   // signed lateral accel (on s)
    let aZ = 0;                                   // signed accel along z
    let axPen = 0, ayPen = 0, azPen = 0;          // the start pen, if it fires
    let depth = 0, layer = null;
    const penning = rs.phase === 'ready' && onGround;

    if (penning) {
      // THE START PEN (§2): hold the rider at REST. Holding only the
      // down-course axis leaves a lateral residue that the board frame reads as
      // fakie, and physics' boost law then drives the rider backwards up the
      // mountain. A rider at rest has no such sign ambiguity.
      axPen = -ph.vel[0] / dt; ayPen = -ph.vel[1] / dt; azPen = -ph.vel[2] / dt;
      if (axPen !== 0 || ayPen !== 0 || azPen !== 0) C.penFrames++;
    } else {
      // ---- lateral: berm -> wall -> return -------------------------------
      const pLat = sAbs - L_HARD;
      const d = boundaryDemand(wLat, lateralBudget(sAbs), lateralFirmness(sAbs), pLat, dt);
      if (d > 0) {
        aS = -sSign * d;
        layer = pLat > 0 ? 'return' : sAbs < BERM_END ? 'berm' : 'wall';
        depth = pLat > 0 ? pLat : Math.max(0, sAbs - W_CORR);
      }
      if (pLat > C.peakBeyondLimit_m) C.peakBeyondLimit_m = pLat;

      // ---- longitudinal: run-out and back-stop, in EVERY phase -----------
      // There is no airborne start gate. A bar across the course cannot hold a
      // rider who is off the ground, and the first build's attempt to do it
      // reversed an airborne rider's whole down-course velocity — 81.5 m/s^2
      // that turned their velocity heading 107 deg. The pen is the gate, and it
      // acts only on a grounded rider. The course limits below are safety and
      // run in every phase, which is also why the up-course limit is live
      // during 'ready' for a rider staged behind the line.
      const pDn = z - Z_HARD_DN;
      const dDn = boundaryDemand(vz, A_Z * Math.max(0, Z_SOFT_DN - Math.max(z, zFinish)), A_Z, pDn, dt);
      if (dDn > 0) {
        aZ -= dDn;
        if (pDn > 0) C.returnFrames++; else C.runOutFrames++;
        const pp = pDn > 0 ? pDn : z - zFinish; if (pp > depth) depth = pp;
      }
      if (pDn > C.peakBeyondLimit_m) C.peakBeyondLimit_m = pDn;

      const pUp = Z_HARD_UP - z;
      const dUp = boundaryDemand(-vz, A_Z * Math.max(0, Math.min(z, zStart) - Z_SOFT_UP), A_Z, pUp, dt);
      if (dUp > 0) {
        aZ += dUp;
        if (pUp > 0) C.returnFrames++; else C.backStopFrames++;
        const pp = pUp > 0 ? pUp : zStart - z; if (pp > depth) depth = pp;
      }
      if (pUp > C.peakBeyondLimit_m) C.peakBeyondLimit_m = pUp;
    }

    // ---- assemble the horizontal correction, apply the ceilings ---------
    C.offset_m = sAbs;
    if (sAbs > C.peakOffset_m) C.peakOffset_m = sAbs;
    const acting = aS !== 0 || aZ !== 0 || axPen !== 0 || ayPen !== 0 || azPen !== 0;
    C.active = acting;
    C.depth_m = acting ? depth : 0;
    C.accel_mps2 = 0;
    rs.outOfBounds = acting;

    if (acting) {
      if (layer === 'berm') C.bermFrames++;
      else if (layer === 'wall') C.wallFrames++;
      else if (layer === 'return') C.returnFrames++;

      // ds/dt = vx - k*vz  =>  ax = A_s + k*A_z, az = A_z (§4.8)
      let ax = penning ? axPen : aS + k * aZ;
      let az = penning ? azPen : aZ;
      let ay = penning ? ayPen : 0;
      const rawH = Math.hypot(ax, az);
      if (rawH > C.peakDemand_mps2) C.peakDemand_mps2 = rawH;

      if (penning) {
        // -vel is already tangent (a grounded velocity is), so a UNIFORM scale
        // is the only shrink that keeps it there. Both ceilings applied at once.
        let f = 1;
        if (rawH > A_CEIL_H) f = A_CEIL_H / rawH;
        const m0 = Math.hypot(ax, ay, az);
        if (m0 * f > A_CEIL_3) { f = A_CEIL_3 / m0; C.ceil3Frames++; }
        if (f < 1) { ax *= f; ay *= f; az *= f; C.ceilFrames++; }
      } else {
        if (rawH > A_CEIL_H) { const f = A_CEIL_H / rawH; ax *= f; az *= f; C.ceilFrames++; }
        if (onGround) {
          // the unique tangent-plane vector whose horizontal shadow is (ax, az):
          // no authority lost to a projection, none invented by a rescale (§4.6)
          const n = normalAt(x, z);
          ay = -(n[0] * ax + n[2] * az) / (n[1] || 1);
          const m3 = Math.hypot(ax, ay, az);
          if (m3 > A_CEIL_3) { const f = A_CEIL_3 / m3; ax *= f; ay *= f; az *= f; C.ceil3Frames++; }
        }
      }

      const h = Math.hypot(ax, az), m3 = Math.hypot(ax, ay, az);
      if (h > C.peakAppliedH_mps2) C.peakAppliedH_mps2 = h;
      if (m3 > C.peakApplied3_mps2) C.peakApplied3_mps2 = m3;
      C.accel_mps2 = m3;

      // strictly-in-bounds writes MUST never happen (§1, §4.3) — counted, not
      // assumed, so a future edit that breaks the identity reports itself
      if (sAbs <= W_CORR && z >= zStart && z <= zFinish && rs.phase !== 'ready')
        C.inBoundsWriteFrames++;

      // ---- THE ONLY WRITE IN THIS FILE ----
      ph.vel[0] += ax * dt;
      ph.vel[1] += ay * dt;
      ph.vel[2] += az * dt;

      if (!onGround) {                            // the disclosed yaw channel
        C.airWriteFrames++;
        if (h > C.peakAirWrite_mps2) C.peakAirWrite_mps2 = h;
      }
      C.activeFrames++;
    }
    C.activeFraction = C.activeFrames / C.totalFrames;

    // --- SELF-AUDIT DIFF: this module writes velocity, and nothing else -----
    const dPos = Math.hypot(ph.pos[0] - px, ph.pos[1] - py, ph.pos[2] - pz);
    if (dPos > C.maxSelfPosDelta_m) C.maxSelfPosDelta_m = dPos;
    let dYaw = Math.abs(ph.heading - h0) % (2 * Math.PI);
    if (dYaw > Math.PI) dYaw = 2 * Math.PI - dYaw;
    dYaw *= 180 / Math.PI;
    if (dYaw > C.maxSelfYaw_deg) C.maxSelfYaw_deg = dYaw;
    const dVel = Math.hypot(ph.vel[0] - vx0, ph.vel[1] - vy0, ph.vel[2] - vz0);
    if (dVel > C.maxSelfVelDelta_mps) C.maxSelfVelDelta_mps = dVel;

    return rs;
  }

  function results(rs, ts) {
    return rs.results ?? assemble(rs, ts);
  }

  function restart(rs) {
    const fresh = init();
    for (const key of Object.keys(rs)) delete rs[key];
    Object.assign(rs, fresh);
    return rs;
  }

  return { config, init, step, results, restart };
}
