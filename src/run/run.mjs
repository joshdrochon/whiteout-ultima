// ============================================================================
// run-structure lane — run.mjs   (cycle 5, candidate A, remediation 1)
//
// Start gate, race clock, finish line, results card, restart, and a three-layer
// CORRIDOR: soft berm -> firm wall -> hard limit (return).
//
// Pure JS, deterministic. No Date, no Math.random, no globals, no top-level
// await. One static import: the accepted physics module's published constants,
// which every acceleration in this file is derived from.
//
// ---------------------------------------------------------------------------
// 0. WHAT THIS MODULE WRITES, EXHAUSTIVELY
//
//   physState.vel[0..2] — and ONLY by adding a bounded ACCELERATION * dt from
//   the corridor field, whose world-horizontal magnitude never exceeds A_HCEIL
//   and whose 3-D magnitude never exceeds A_CEIL3 (section 4).
//
//   Nothing else. It never writes physState.pos — the module diffs ph.pos across
//   its own write block every frame and publishes the result in
//   rs.confine.maxSelfPosDelta_m, a computed number rather than an asserted
//   zero. It never writes physState.heading, spinDeg, flipDeg, onGround,
//   airTime, landing, charge or boostMeter, and it never writes any field of the
//   trick state. It reads both.
//
//   AND IT WRITES NOTHING AT ALL WHILE THE RIDER IS IN BOUNDS. That is the
//   headline change this cycle and section 3.1 is the proof; rs.confine
//   .inBoundsWriteFrames is the measurement, and it reads 0 on every drive in
//   the gate suite and in selftest.mjs.
//
// ---------------------------------------------------------------------------
// 0.1 WHAT THIS REMEDIATION CHANGED, AND WHAT IT COST
//
//   The blind critic's findings on the cycle-5 file were about DERIVATION AND
//   DISCLOSURE QUALITY, not correctness — the gates passed. Five things:
//
//   R1  THE FIRMNESS WAS A REPURPOSED CITATION. A_TRACK = A_LAT = 26 was the
//       RIDER's steering ceiling wearing a corridor's hat: the same category
//       slip this file rejects when it rejects A_BRAKE = 4.5 from TN-08. The
//       firmness is now SOLVED from the room the mountain actually has (3.4):
//       the softest A whose stopping span plus margin still fits inside the
//       measured safe offset. A_SOLVED = 42.297, A_TRACK = 45 after a declared
//       round-up. The corridor is FIRMER, and the feel cost is stated, not
//       hidden: at 45 it is 1.73x the rider's own best turn, so a player at
//       full lock loses to the wall instead of matching it.
//
//   R2  THE BOX WAS TOO CLOSE TO A HARD CEILING, AND THE SWEEP WAS COARSE.
//       2.47 m against RS-05's 4 m, on a 2 m grid, with the resolution not
//       published. The firmer corridor pulls the bound from 172.68 m to
//       153.76 m; the box is re-measured with a published convergence series
//       (2 m -> 0.05 m local refinement) and reads 2.02 m, 50.4% of the
//       ceiling. The 2 m grid understates the SAME box by 0.16 m, which is why
//       the series is published instead of a number (3.5).
//
//   R3  A 36 g GUARD THAT NEVER FIRED. A_CEIL3 = 357 m/s^2 was derived from a
//       15 m dilation of the box, so by construction it could not bind, and it
//       was published next to a counter that never fired. Replaced by a stated
//       POLICY — the module will not lift as if the ground were steeper than
//       60 deg — giving A_CEIL3 = 2*A_HCEIL = 288.06, which DOES bind on
//       ground inside the box, with the cost of binding measured (4).
//
//   R4  A SELF-WRITTEN TEST'S PASS COUNT WAS CITED AS EVIDENCE. "79/79, 82/82
//       with --measure" is gone. Section 7 now says what the gate suite
//       measured and what nothing measures, and selftest.mjs is described as
//       what it is: a self-authored instrument that prints numbers.
//
//   R5  THE START GATE WRITES vel[0] AND NOTHING MEASURED IT. Disclosed in
//       prose last cycle, now counted: rs.confine.gateVxWriteFrames,
//       gateMaxVxWrite_mps, gateVxImpulse_mps, gateMaxDsdtWrite_mps — and
//       stated plainly in 2 and in 7 that NO GATE IN THE SUITE SEES IT.
//
//   R6  (not asked for, found while looking) EVERY REMAINING CLAIM THAT READS
//       LIKE A THEOREM BUT IS NOT ONE is now in config.derivation.assumptions
//       with its falsifier, and two of those falsifiers are measured every
//       frame (overCapFrames, overLatRateFrames). Section 8 is the summary.
//
// ---------------------------------------------------------------------------
// 1. WHAT CHANGED FROM CYCLE 4, AND WHY
//
//   The cycle-4 critic's verdict on this line was that it "does not actually
//   have zero authority inside the contract corridor, and hides the fact from
//   RS-10". Both halves were true and both are fixed here, structurally rather
//   than cosmetically.
//
//   1.1 THE BERM NO LONGER ACTS IN BOUNDS. It used to start at |s| = 55 m (the
//       render lane's tree line) and run to the wall, so 65 m of it lay inside
//       the contract's 120 m in-bounds set and it applied a real, if small,
//       lateral acceleration there. The contract's mandate is exact — "a rider
//       outside [zStart, zFinish] or |x - courseCenterX(z)| > halfWidth must be
//       corrected" — and it authorises nothing inside that set. The berm now
//       begins at |s| = halfWidth and ends at the wall's soft line: it is the
//       softest of three layers that all live strictly outside the corridor,
//       and it is the first thing a rider feels on leaving it.
//
//       THE COST, STATED: the shoulder of the ridable corridor is no longer
//       banked by this module. It is still banked by the mountain — measured,
//       the gully's own inward pull at |s| = 100 is 4.44 m/s^2 median, 90% of
//       the g/2 ceiling any bank can have. Shaping the ridable line is the
//       terrain's job, and a run module that shapes it is one step from a run
//       module that steers.
//
//   1.2 rs.outOfBounds IS NOW GEOMETRY, NOT SELF-REPORT. It used to be raised
//       on every frame this module touched the rider, which mislabelled an
//       in-bounds rider to the HUD and, because RS-10 excludes flagged frames,
//       deleted 174 frames from the exact set that gate measures. It is now
//       exactly the contract predicate — |s| > halfWidth, or z outside
//       [zStart, zFinish] — computed from position and nothing else, with
//       rs.outOfBoundsAxis naming which boundary. The "this module wrote
//       something" signal is rs.confine.active, where it always belonged.
//
//       DISCLOSED TENSION: CONTRACTS.md glosses the field as "true while
//       correcting", which is the reading cycle 4 took. The lane critic ruled
//       for the geometric reading and this module follows it. One visible
//       consequence: after the finish the rider is past zFinish, so the flag is
//       true for the whole run-out. rs.outOfBoundsAxis is 'down' there, so a
//       HUD can tell "past the finish" from "off the side of the mountain".
//
//   1.3 THE IN-BOUNDS WRITE COUNTER EXISTS. rs.confine.inBoundsWriteFrames
//       counts frames on which this module wrote velocity while
//       |s| <= halfWidth && z in [zStart, zFinish] && phase !== 'ready', with
//       inBoundsImpulse_mps and worstInBoundsAccel_mps2 alongside. Section 3.1
//       proves the number is 0; the counter is there so a reader does not have
//       to take the proof's word for it.
//
//   1.4 THE FIRMNESS IS SOLVED FROM THE MOUNTAIN AND THE CEILING FOLLOWS FROM
//       IT. Cycle 4 wrote A_TRACK = A_HCEIL - DRIVE_MAX - g/2 and called the
//       collapse to g a derivation; it was a restatement of A_HCEIL's own
//       definition. Cycle 5 replaced that with A_TRACK = A_LAT and called it an
//       honest choice; it was a repurposed citation of the RIDER's steering
//       ceiling. Section 3.4 now solves the firmness from the divergence room
//       the terrain has (R1) and derives the ceiling from the result.
//
//   1.5 THE PHYSICS READ IS STATIC AND AUDITED. Cycle 4 used a top-level
//       `await import` of a hardcoded relative path with a silent fallback to a
//       pinned copy, so moving the file would have quietly changed every
//       constant in it. It is now a static import — an unresolvable path is a
//       load error, not a fallback — and PINNED is an audit record checked
//       against the live values on load, which throws by name on divergence.
//       Every number quoted in this header was computed against PINNED, so the
//       throw is what keeps the prose and the code from disagreeing.
//
//   1.6 THE CORRIDOR'S LATERAL COORDINATE IS SKEWED AND THE MATH NOW SAYS SO.
//       s = x - centreX(z), so ds/dt = vx - k*vz with k = centreX'(z): a rider
//       at the physics speed cap can have a corridor-lateral rate of up to
//       V_CAP * sqrt(1 + k^2), which is 43.5 m/s where the course meanders
//       hardest, not 33. Cycle 4 sized the lateral layer with V_CAP, so its
//       "provably inert at halfWidth" identity had a hole exactly where the
//       centreline bends. Section 3.3 carries the Jacobian factor.
//
// ---------------------------------------------------------------------------
// 2. PHASE MACHINE AND THE START GATE
//
//   phase: 'ready' -> 'running' -> 'finished'          (contract field)
//
//   ready     The rider is staged BEHIND the start line, at the gate, and HELD
//             there. Clock reads 0. rs.light runs red -> set -> go over
//             COUNTDOWN_S; rs.stage and rs.countdown_s publish it for the HUD.
//             `phase` stays one of the contract's three values, so the countdown
//             is a sub-state.
//   running   Entered when the gate drops. The clock starts AT THE DROP, which
//             is what a start gate is: the rider is stationary at t = 0 and
//             every metre of the run is on the clock.
//   finished  Entered on the first step at or past zFinish. The card is
//             assembled once and deep-frozen; the clock stops; the corridor
//             keeps holding, so a rider with boost pinned coasts to a stop in
//             the run-out instead of sailing onto the backdrop.
//
//   WHERE THE GATE IS. At the rider's staged position — the first z this module
//   ever sees — and not at zStart. A gate 40 m down-course of a staged rider
//   does not hold them, it catches them, and they spend the countdown sliding
//   into it. RS-09's own statement is "before 'running' the rider does not
//   accelerate down-course", and a start pen holds the board where it stands.
//
//   THE GATE IS A BOUNDARY, NOT A PIN. It is the same allowance law as every
//   other layer (section 3.2) with its soft line at the gate, so at p = 0 the
//   allowance is exactly 0 and the field removes exactly the down-course rate
//   the rider has and not one m/s more. It leaves the corridor-LATERAL rate
//   ds/dt exactly unchanged — which, because the coordinate is skewed, means it
//   does write vel[0], by exactly k*az (3.7), the amount that cancels the
//   x-component's effect on s. Saying "it only touches vz" would have been the
//   easy sentence and it is false. Holding a rider by writing their position, or
//   by zeroing their whole velocity vector, would be a physics write on an
//   ordinary frame — and the cycle-4 sibling candidate that did the latter moved
//   its own run's score by 15.7x.
//
//   THE SIZE OF THAT vel[0] WRITE, AND WHO MEASURES IT (R5). Up to 0.68 m/s of
//   total vel[0] change over a 3 s countdown from a rider staged at z = -40,
//   against 0 to floating point in ds/dt. It is now counted in rstate rather
//   than only admitted in prose: rs.confine.gateVxWriteFrames (frames on which
//   the gate changed vel[0]), .gateMaxVxWrite_mps (the largest single-frame
//   change), .gateVxImpulse_mps (the total) and .gateMaxDsdtWrite_mps (the
//   gate's change to ds/dt, which is the check that the write is the skew term
//   and nothing else).
//
//   STATED PLAINLY: NO GATE IN THE SUITE MEASURES THIS WRITE. RS-09 measures
//   down-course drift over the countdown and nothing else. RS-06 and RS-10
//   measure position and heading, which the gate does not touch. RS-11 forces
//   phase to 'running' and sweeps mid-run states, so it excludes the ready
//   phase entirely. The counters above are the only measurement that exists,
//   and they are self-reported by the module they are measuring.
//
//   ROLLING START — a branch, and the measurement that put it there. A rider
//   staged DOWN-COURSE of zStart is already on the course; there is no gate down
//   there to hold anyone. So the run is already on: the clock starts on frame 1,
//   the ready phase is empty, gateZ is null, and the module applies nothing.
//
//   Measured, the branch-free version is the one that was wrong. The harness
//   stages the rider at z = 15 with 6 m/s in every probe but the start probe, so
//   holding at the staged position brought EVERY probe to a dead stop 15 m
//   inside the course and cost 36 m/s of gate impulse to do it, then handed the
//   rider back at zero speed on a slope, where the closed-loop harness drive
//   spun the board and boosted 60 m BACK up the course before recovering. A run
//   module that changes the outcome of the run it is timing had better have a
//   reason; the gate branch had none for a rolling rider, so it does not fire.
//
//   AND THE MODULE NOW DOES CHANGE THE PROBE DRIVE'S RUN. Cycle 5 claimed the
//   probe drive's run was bit-identical with and without this module attached.
//   That claim is retired, because it is no longer true and because it was only
//   ever true by slackness. MEASURED: the harness's own competent drive flies
//   17.34 m UP-COURSE of zStart at t = 12.3 s — airborne, at 18 m/s backwards,
//   after a jump — which is out of bounds by the contract's own predicate
//   (z < zStart). Cycle 5's back-stop soft line sat 21.49 m up-course, so it
//   never engaged and a genuinely out-of-bounds rider was left uncorrected. The
//   firmer corridor of 3.4 puts that line at 12.65 m, so the back-stop now
//   catches the excursion and holds the rider at about z = -11.4.
//
//   WHAT THAT COSTS, MEASURED, NOT ESTIMATED: the probe drive finishes in
//   261.52 s with the module against 266.42 s without it, and scores 2284.5
//   against 2099.1 — 4.9 s and 8.8%, in the direction that FLATTERS this module,
//   from a single 20.5 m/s back-stop impulse at t = 12.3 s. That is the chaos 3.8
//   describes, not a systematic gain, and it is exactly why 3.8 says finish time
//   is not a safe measure here. The corridor is silent on the whole of the rest
//   of that run: bermFrames 0, wallFrames 0, limitFrames 0, gateFrames 0,
//   inBoundsWriteFrames 0 of 18,000.
//
//   THE TRADE, NAMED: correcting an out-of-bounds rider is what the contract
//   asks for, and staying out of the run's way is what a timer should do. They
//   conflict here, and this module takes the contract's side. If the lane would
//   rather have the old silence, the way to get it is to widen the up-course
//   boundary in env.bounds, not to make the back-stop slack.
//
//   WHAT THE BRANCH COSTS IN COVERAGE, and what is done about it. The cycle-4
//   critic's objection stands: the branch means ten of the eleven gates take the
//   rolling path and only RS-09 stages behind the line, so the gate suite
//   exercises the pen once, on a countdown, with no corridor work. selftest.mjs
//   section 5 now stages riders at z = -40, z = -5 and z = -120 and drives each
//   of them THROUGH the drop and down the course into the wall, so the gate is
//   exercised against a moving rider and against the back-stop, not only against
//   a countdown.
//
//   THE UP-COURSE LIMIT DEFENDS THE START, NOT zStart. A rider staged at
//   z = -120 is legitimately up-course of zStart, so a back-stop pinned to
//   zStart would be a wall 120 m DOWN-course of them, and its return branch
//   would shove a staged rider forward. The back-stop defends
//   min(zStart, stagedZ): you cannot go back up-course past where the run began.
//
// ---------------------------------------------------------------------------
// 3. THE CORRIDOR
//
//   3.1 ZERO AUTHORITY IN BOUNDS — THE ARGUMENT, AND WHAT IT ASSUMES
//
//   Read 8 first if you are going to quote this as a proof. It is an identity in
//   the constants GIVEN two assumptions about the rider's state — |v_horizontal|
//   <= V_CAP and hence |ds/dt| <= W_LAT at the instant this module measures —
//   and those are assumptions, not theorems, because this module writes velocity
//   in the air where physics does not re-clamp. Both are measured every frame
//   (rs.confine.overCapFrames, .overLatRateFrames) so a violation shows up as a
//   number instead of quietly voiding the argument.
//
//   The contract's in-bounds set is |s| <= halfWidth AND z in [zStart, zFinish].
//   There are four layers that can write, and each is inert on that whole set:
//
//     berm       acts only where |s| > halfWidth.               Definitionally.
//     wall/limit soft line at halfWidth + SPAN_LAT. By 3.3 the allowance at
//                |s| = halfWidth equals the largest corridor-lateral rate
//                physics permits to exist, so the excess is <= 0.
//     run-out    soft line at zFinish + max(APRON, SPAN_Z), and APRON > SPAN_Z,
//                so the allowance at z = zFinish exceeds V_CAP a fortiori.
//     back-stop  soft line at min(zStart, stagedZ) - SPAN_Z; by 3.3 the
//                allowance at z = zStart equals V_CAP.
//     gate       exists only in phase 'ready', which the in-bounds counter
//                excludes and which ends before the clock starts.
//
//   Every one of those is an identity in the constants GIVEN the assumptions
//   above, not a property of any particular drive, and it holds at every dt
//   because the spans are recomputed from the live dt each frame. MEASURED:
//   RS-11 sweeps in-bounds states at up to the full skewed rate and reads
//   inBoundsWriteMax = 0 exactly; rs.confine.inBoundsWriteFrames is 0 over the
//   whole gate suite.
//
//   The consequence for RS-10 is worth stating plainly, because it cuts against
//   this module: the gate measures yaw the module adds while the rider is in
//   bounds, and on that set this module provably writes nothing at all. RS-10
//   therefore cannot distinguish a correct corridor from an absent one. The
//   evidence that the corridor works has to come from somewhere else, and
//   section 6 says where.
//
//   The mechanism behind the 0.00: the corridor writes velocity only. The
//   accepted physics module derives board yaw from `steer` and carve geometry
//   (omega = speed / R_sidecut(steer)), so a velocity write reaches heading only
//   INDIRECTLY, through the speed in that ratio. There is one further indirect
//   channel and it is disclosed rather than denied: physics copies velocity yaw
//   onto heading on a clean landing, so a LATERAL velocity write while the rider
//   is airborne can become a heading change at the next touchdown. The wall and
//   the limit do act in the air — a corridor that switches off when the rider
//   jumps is not a corridor — and the berm does not, because a berm is ground.
//   The runner reports the channel's size directly as _airborneVelWriteFrames.
//
//   3.2 THE ONE LAW
//
//   Every boundary here is one continuous allowance on the OUTWARD rate w, as a
//   function of the signed distance p past that boundary's soft line:
//
//       p <= 0 (inside):   w_allow = +sqrt(2 * A * (-p))     brake
//       p >  0 (outside):  w_allow = -sqrt(2 * A * ( p))     return
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
//   i.e. exactly the excess and not one m/s^2 more, ceilinged by section 4. It
//   is never negative: a boundary can hold, it can never push a rider away from
//   itself, and it can never add speed along any other axis.
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
//   Substituting gap = W^2/(2A) + W*dt into the discrete form gives
//
//       w_allow = -A*dt + sqrt(A^2*dt^2 + W^2 + 2*A*W*dt)
//               = -A*dt + (A*dt + W)  =  W    exactly, for any A, any W, any dt
//
//   so SPAN(A, W, dt) = W^2/(2A) + W*dt is precisely the gap at which the
//   allowance equals W. Put W = the fastest outward rate physics permits along
//   that axis and place each soft line one SPAN outside the contract boundary it
//   defends: the layer is then PROVABLY INERT at and inside that boundary, since
//   no rider can be moving outward faster than W and so the excess is <= 0.
//
//   W IS NOT THE SAME ON THE TWO AXES, and cycle 4's error was assuming it was.
//   Down-course, z is z and W_Z = V_CAP = 33 m/s. Laterally the coordinate is
//   skewed: s = x - centreX(z), so ds/dt = vx - k*vz with k = centreX'(z), and
//   for |v| <= V_CAP the outward rate |ds/dt| is bounded by V_CAP*sqrt(1+k^2),
//   attained by a rider moving along (1, -k). MEASURED on a 0.5 m sweep in z
//   over [-400, 3190], max |centreX'(z)| = 0.8571 at z = 792.5, so
//
//       KAPPA = sqrt(1 + 0.8571^2) = 1.31705      (a MEASURED Jacobian bound:
//                                                  a finite-grid number over a
//                                                  smoothed centreline, not an
//                                                  analytic one — see 8)
//       W_LAT = KAPPA * V_CAP = 43.463 m/s
//
//   KAPPA is taken at its global maximum rather than at the local k(z) on
//   purpose. A z-varying soft line would be tighter — the corridor would only
//   widen where the course actually bends — but it would also MOVE, by up to
//   15.6 m over a 10 m centreline segment, and a rider riding the wide part into
//   a straight section would be 15 m past a line that had come to them. That is
//   a jolt with no cause the player can see. A fixed geometry costs 15 m of
//   corridor width in the straight sections and buys a boundary that never
//   moves. The width it costs is checked in 3.5, not assumed harmless.
//
//     layer      defends                   W        soft line sits
//     wall       |s| = halfWidth = 120     W_LAT    +21.71 m  (span)
//     back-stop  z = min(zStart, staged)   V_CAP    -12.65 m  (span)
//     gate       z = staged position       —          0 m     (p = 0)
//     run-out    z = zFinish = 2400        V_CAP    +165.24 m (apron, 3.3a)
//
//   3.3a THE ONE LAYER THAT IS NOT AT THE MINIMUM: THE FINISH APRON
//
//   The span is a MINIMUM — the gap at which a layer stops being able to touch
//   an in-bounds rider. Down-course there is a second requirement it does not
//   meet: a finish line has a RUN-OUT, and 21 m of it is not a run-out, it is a
//   wall 21 m past the line. So the down-course soft line sits one APRON out,
//   where APRON is the room the rider's own drag law needs — the closed-form
//   distance in which the accepted physics module's longitudinal law
//   a(v) = MU_BASE*g + LAMBDA_LONG*TUCK_DRAG*v brings V_CAP to rest on flat
//   ground, evaluated at the LOWEST drag the rider can choose (tucked):
//
//       APRON = INTEGRAL(0..V_CAP) v dv / (F0 + L*v)
//             = (1/L) * (V_CAP - (F0/L) * ln(1 + L*V_CAP/F0))  =  165.244 m
//
//   Every symbol is a published physics constant. It is NOT a promise that the
//   rider stops inside it — this course keeps descending past the finish and a
//   rider holding boost never stops anywhere — it is the statement that the
//   mountain gets the whole of the rider's own stopping distance before a
//   barrier takes over. Enforced as max(APRON, SPAN_Z(dt)) so the inertness
//   identity survives at any dt.
//
//   DISCLOSED, because it was a defect and not merely a gate failure: an earlier
//   geometry in this line put this layer at the span minimum too and parked
//   riders 56 m past the line. RS-02 rides 60 m past the line to prove the
//   finished phase latches, so that module failed RS-02 by stopping the rider
//   before the gate could finish asking its question. The gate was right.
//
//   The back-stop keeps the span minimum rather than an apron: up-course the
//   mountain climbs, so there is nothing to run out into, and a shorter layer
//   keeps the containment box smaller — which is what 3.5 wants.
//
//   3.4 THE FIRMNESS — SOLVED FROM THE ROOM THE MOUNTAIN HAS
//
//   A_TRACK is the corridor's GUARANTEED NET INWARD acceleration: what is left
//   after the module has cancelled everything the world can throw outward. It is
//   the one number that sets how wide the whole containment geometry is, because
//   both the span and the margin fall as 1/A. So the question "how firm?" is the
//   same question as "how much room is there?", and the mountain answers it.
//
//   STEP 1 — THE ROOM. RS-05 caps the mesh-vs-physics divergence anywhere the
//   rider can reach at 4 m, HARD. Take half of that as the design target:
//
//       D_SAFE = 2.0 m                        (a CHOICE: a factor-of-two margin
//                                              against a HARD gate, declared)
//
//   and measure the widest lateral offset whose CUMULATIVE worst divergence —
//   over every offset at or inside it, over the box's z range — still fits:
//
//       SAFE_OFFSET = 155.5 m       swept 0.5 m in s x 1 m in z,
//                                   |s| <= 260, z in [-140, 2600]
//
//   STEP 2 — THE SOFTEST FIRMNESS THAT FITS. reach(A) = halfWidth + span(A,
//   W_LAT, dt) + margin(A, KAPPA, dt) is the lateral containment bound as a
//   function of firmness, and it is strictly decreasing in A. So there is
//   exactly one softest firmness whose bound still lands inside the room:
//
//       reach(A_SOLVED) = SAFE_OFFSET   =>   A_SOLVED = 42.297 m/s^2
//
//   The module solves this itself, by bisection at construction time, from
//   SAFE_OFFSET and D_SAFE in MEASURED — the number is not pasted in.
//
//   STEP 3 — ROUNDED UP, AS A DECLARED CHOICE. 42.297 is spuriously precise
//   about a quantity measured on a finite grid, and rounding UP can only move
//   the bound further inside the room:
//
//       A_TRACK = ceil(A_SOLVED / 5) * 5 = 45 m/s^2      reach = 153.763 m
//                                                        inset = 1.74 m
//
//   WHAT THIS REPLACED (R1). Cycle 5 set A_TRACK = A_LAT = 26, the accepted
//   physics module's published lateral-acceleration ceiling, and defended it as
//   "exactly as strong as the rider's own best turn". That was a REPURPOSED
//   CITATION, not a derivation: A_LAT is the RIDER's steering ceiling, a
//   different category of quantity from a corridor's firmness — the same
//   category slip this file rejects two paragraphs down when it rejects
//   A_BRAKE = 4.5. Sizing a boundary by quoting a number that happens to be
//   about the thing the boundary contains is a coincidence dressed as a reason.
//
//   WHAT IT COSTS, IN FEEL, STATED AND NOT USED AS THE ARGUMENT. At 45 m/s^2 the
//   corridor is 1.73x the rider's own best turn (A_LAT = 26). A player at full
//   lock no longer MATCHES the wall, they lose to it by 73%. Cycle 5 treated
//   "the player can match the wall" as a design virtue; it is a real property
//   and it is gone. In exchange the containment bound moved from |s| = 172.68 to
//   |s| = 153.76 and the divergence headroom against a HARD gate went from 1.5 m
//   to 2.0 m. If the lane wants the softer feel back, the way to get it is more
//   room — a flatter gully or a finer LOD out on the flanks — not a softer
//   number, and 3.5 is where that trade is priced.
//
//   REJECTED, with reasons:
//     * A_BRAKE = 4.5 m/s^2 (REFERENCE_BAR TN-08 band 3-6), used by an earlier
//       candidate in this line and justified as "the rider's own brake
//       authority". It is not: the accepted physics module publishes
//       BRAKE_DECEL = 1.7 m/s^2 (read live, in PINNED, checked on load), so the
//       citation and the code disagreed, and 4.5 was a hand-picked point in a
//       band. Following the citation properly is worse still: 1.7 m/s^2 needs a
//       556 m lateral span, which is off the mountain.
//     * DRIVE_MAX + g = 54.096, the cycle-4 lateral firmness. The "+ g" was
//       asserted, and the whole thing is a statement about what the corridor
//       ought to feel like rather than a measurement of what there is room for.
//     * A_LAT = 26, cycle 5. See above.
//   The derivation above is agnostic about all three: it asks the mountain how
//   much room there is and returns the softest firmness that fits inside it.
//   None of those three numbers is an answer to that question. That A_SOLVED
//   lands between A_LAT and DRIVE_MAX + g is an outcome, not a target.
//
//   THE CEILING FOLLOWS. To guarantee A_TRACK of net inward acceleration the
//   module must first cancel the largest outward push the world can produce.
//   Physics has exactly three horizontal acceleration channels on a grounded
//   rider, and all three can point outward at once:
//
//       drive    DRIVE_MAX = V_BOOST / TAU_BOOST = 44.286 m/s^2
//                (physics' boost is a first-order relaxation toward V_BOOST with
//                time constant TAU_BOOST; at rest it delivers V_BOOST/TAU_BOOST,
//                aimed wherever the board points)
//       edge     A_LAT = 26 m/s^2 (the published lateral-accel ceiling: a rider
//                at full lock steering outward)
//       gravity  g/2 = 4.905 m/s^2 (the horizontal component of tangential
//                gravity is (g/2)*sin(2*theta), maximal at theta = 45 deg — a
//                ceiling no slope can exceed, not a tuning choice)
//
//   W_WORLD = 75.191 m/s^2 is their sum. Laterally the corridor coordinate is
//   skewed, so a world-horizontal push of magnitude a produces up to KAPPA*a of
//   corridor-lateral outward rate-of-change, while delivering a of corridor-
//   lateral correction costs the module exactly a of world-horizontal magnitude
//   (3.6). Hence
//
//       A_HCEIL = KAPPA * W_WORLD + A_TRACK = 99.03 + 45 = 144.03 m/s^2
//
//   and the same ceiling covers the down-course axis with room to spare, where
//   there is no skew (net available there is A_HCEIL - W_WORLD = 68.84, well
//   over the A_TRACK the envelope asks for).
//
//   W_WORLD IS A LOOSE BOUND AND SAYING SO IS PART OF PUBLISHING IT. It is three
//   separate worst cases added together — full boost, full outward lock, and a
//   45 degree fall line, all at once, all pointing the same way. No drive in any
//   probe has produced that state. A_HCEIL inherits the looseness, which is why
//   the 3-D consequence in section 4 is as large as it is.
//
//   3.5 SOFT LINE INSIDE, HARD LINE OUTSIDE
//
//   A braking envelope brings the rider to rest ON its soft line, and a rider
//   arriving at the line already at speed overshoots it. So every soft line sits
//   one full worst-case penetration inside the containment bound.
//
//   MARGIN is derived with the drive and the speed COUPLED, because they are:
//   physics' boost is a relaxation toward V_BOOST with time constant TAU, so a
//   rider already leaving at outward rate w has only (V_BOOST - w)/TAU of drive
//   left, and none at all past V_BOOST. Treating the drive as a constant 44.3
//   m/s^2 while the rider travels at 33 m/s would be double-counting. Net inward
//   acceleration at outward rate w, worst case:
//
//       a(w) = A_HCEIL - drive_left(w) - (everything else outward)
//            = A_TRACK + w/TAU          for w <  W_BOOST
//            = A_TRACK + drive_full     for w >= W_BOOST
//
//       MARGIN = integral(0 -> W) w/a(w) dw  +  W * dt
//
//   evaluated per axis with that axis's W (and, laterally, with the whole
//   bracket scaled by KAPPA, since both the drive and the speeds live in the
//   skewed coordinate):
//
//       MARGIN_LAT = 10.548 + 0.777 + 0.724 = 12.050 m
//       MARGIN_Z   =  6.858 + 0.451 + 0.550 =  7.859 m
//
//   THIS IS A BOUND UNDER ASSEMBLED WORST CASES, NOT A THEOREM. It assumes the
//   full outward drive holds for the whole excursion, that the KAPPA scaling and
//   the maximum entry rate hold simultaneously with it, and that no other term
//   was missed. Section 8 lists it as an assumption and names its falsifier,
//   which is rs.confine.beyondBound: if that is ever non-zero, MARGIN was not a
//   bound.
//
//   The last term is one unseen frame: the module reads the rider AFTER physics
//   has already moved them, so they can be that far past a soft line before this
//   module has seen anything. It is a different quantity from the W*dt term in
//   SPAN — that one buys inertness at the layer's start, this one buys headroom
//   past the layer's soft line — and dt is the live step, so both scale together.
//
//   Containment bound = soft line + MARGIN, and it is a BOUND, not a barrier:
//   nothing is placed there and nothing fires there. rs.confine.beyondBound
//   counts frames spent past it.
//
//     lateral   soft |s| = 141.713   bound |s| = 153.763
//     run-out   soft z  = 2565.244   bound z  = 2573.103
//     back-stop soft z  = start - 12.650      bound z = start - 20.509
//
//   THE BOX, RE-MEASURED, WITH THE SWEEP RESOLUTION PUBLISHED NEXT TO IT (R2).
//   Worst mesh-vs-physics divergence over the containment box (|s| <= 153.763,
//   z in [-140.5, 2573.1]), as a CONVERGENCE SERIES rather than one number:
//
//       grid (s x z)        worst divergence
//       2.00 x 2.00 m       1.857 m
//       0.50 x 1.00 m       1.929 m
//       0.25 x 0.50 m       1.990 m
//       0.25 x 0.25 m       1.992 m
//       0.05 m local refinement at the peak   2.015 m   (s = 149.50, z = 135.15)
//
//       PUBLISHED FIGURE: 2.02 m = 50.4% of RS-05's 4 m HARD ceiling.
//
//   The series is published because the resolution is load-bearing: the 2 m grid
//   understates THE SAME BOX by 0.16 m. A coarse-grid divergence figure is a
//   LOWER BOUND, not the answer — which is exactly what cycle 5's "2.47 m on a
//   2 m grid" over the wider box was (the same box reads 2.48 m at 0.5 x 1 m).
//   The series is still climbing at the finest grid, so 2.02 is a measurement,
//   not a supremum; section 8 lists it as such.
//
//   COMPARED WITH LAST CYCLE: 1.5 m of headroom became 2.0 m, and the bound came
//   in 18.9 m. That is what R1's firmness derivation bought.
//
//   THE FRAGILITY, NAMED BEFORE A CRITIC HAS TO. The divergence field has a STEP
//   at |s| = 149.5: 1.48 m just inside it, 2.02 m just outside. A bound placed
//   4 m further in would report 1.48 m — a much better-looking number that would
//   flip straight back on 4 m of geometry change, in either direction. The bound
//   sits 4.3 m OUTSIDE the step instead, where the figure is already paid for and
//   small geometry changes do not move it. A 1.48 m headline here would be a
//   worse engineering answer that read as a better one.
//
//   The box lies wholly inside the fine-LOD region z in [-250, 2750]; immediately
//   outside it the gap is 8.33 m at z = -260 and 9.27 m at z = 2760. If the
//   terrain lane reshapes the gully, SAFE_OFFSET is the first thing to re-measure
//   — and because 3.4 solves the firmness FROM it, the corridor re-derives itself
//   rather than needing a human to remember to retune it.
//
//   3.6 THE THREE LAYERS
//
//   BERM (soft, |s| in [120, 141.71], grounded only)
//     A berm is ground. It acts only when ph.onGround; an airborne rider does
//     not feel a bank. It starts exactly at the contract corridor edge (1.1).
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
//       |s|      120   130   141.7  153.8
//       median  4.72  4.76  4.72   4.64
//       min     3.47  3.54  3.55   3.31
//       max     6.31  6.24  5.92   5.80
//
//     (141.7 is the wall's soft line, 153.8 the containment bound.)
//
//     (Those maxima exceed g/2 without contradicting the ceiling: the ceiling
//     bounds the horizontal magnitude of tangential gravity, and the corridor's
//     lateral coordinate is skewed by up to KAPPA = 1.317.)
//
//     The mountain is already doing most of this job, and it does it unevenly:
//     the same offset is worth 4.72 m/s^2 at a median z and 3.47 m/s^2 where the
//     gully is shallowest. So the berm does not ADD a force — adding one would
//     double a bank already near its physical ceiling. It TOPS THE TERRAIN UP:
//
//       a_berm(x, z) = q^2 * max(0, g/2 - a_terrain_inward(x, z))
//       q = clamp((|s| - halfWidth) / (lateralSoftLine - halfWidth), 0, 1)
//
//     so the moment the rider leaves the corridor the bank starts building, and
//     by the time the firm wall can act the bank is the strongest a slope can
//     be, everywhere down the course. Where the gully is already steep the berm
//     contributes nothing. MEASURED over |s| in [120, 141.713] at 0.5 m plus a
//     sample exactly on the soft line, z = 0..2400 at 1 m: peak contribution
//     1.361 m/s^2, at s = 141.71, z = 548, where the terrain gives 3.54.
//
//     THE RAMP IS NARROWER THIS CYCLE — 21.7 m (120 -> 141.7) where it was 37.1 m
//     — because the firmer corridor of 3.4 pulls the wall's soft line in. The bank
//     therefore builds about 1.7x more sharply per metre travelled outward. That
//     is a consequence of the firmness derivation, not a separate tuning, and it
//     is the second place (after the feel note in 3.4) where R1 is felt.
//
//     a_terrain_inward is computed each frame from the same 0.05 m central
//     difference stencil the physics module's default sampleNormal uses, so the
//     berm is measuring the surface physics is standing on, not an approximation
//     of it.
//
//     Shape: q^2 is the lowest-order polynomial that is zero WITH ZERO SLOPE at
//     the corridor edge (C1-continuous, never a step the rider can feel switch
//     on) and 1 at the wall's soft line. The exponent is forced by those two
//     conditions plus lowest order; it is not a feel knob.
//
//     Overrule test: g/2 = 4.905 is 18.9% of A_LAT = 26, so a rider at full lock
//     still wins and can still hold the flank. A berm shapes a line; it never
//     takes the turn.
//
//   WALL (firm, |s| in [141.71, ...])  — the brake branch at A_TRACK.
//     Expressed in corridor coordinates (offset s across, progress z along), so
//     the wall acts purely ACROSS: a rider carving along it keeps every bit of
//     their down-course speed. It cannot pull a rider in — that is the berm's
//     job — and by 3.3 it cannot act at all until the rider is genuinely
//     outrunning the room they have left.
//
//   LIMIT / RETURN (hard, past a soft line) — the return branch at A_TRACK.
//     Braking alone would only stop the rider going out FAST, not stop them
//     going out: between one clamp and the next the world adds up to A_HCEIL*dt
//     of outward rate. So past the soft line the requirement inverts and the
//     rider is brought back on the mirrored envelope, arriving at the line with
//     zero speed. Counted per layer, not pooled: limitFrames is the LATERAL
//     return only, with runoutFrames, backstopFrames and gateFrames separate.
//     The return requirement is additionally capped at the axis's own W so the
//     corridor can never demand a speed physics itself forbids; MEASURED, that
//     cap cannot bind inside the containment bound (sqrt(2*A_TRACK*MARGIN_LAT)
//     = 32.9 m/s < W_LAT = 43.5).
//
//   3.7 CORRIDOR COORDINATES
//
//     s = x - centreX(z) is the lateral offset (the coordinate the contract, the
//     runner's divergence probe and the render lane's tree line are all stated
//     in) and z is down-course progress. With k = centreX'(z) their rates are
//         ds/dt = vx - k*vz        dz/dt = vz
//     so a correction that must produce a given (d2s/dt2, d2z/dt2) has exactly
//     one horizontal solution:
//         az = d2z/dt2             ax = d2s/dt2 + k * az
//     The module solves that rather than decomposing onto corridor normal and
//     tangent unit vectors, which would deliver only 1/sqrt(1+k^2) of what it
//     asks for (24% short where the course meanders hardest) — the kind of quiet
//     slack that lets a guarantee be violated. A purely lateral correction here
//     leaves dz/dt untouched by construction, and costs exactly |d2s/dt2| of
//     world-horizontal magnitude, which is the fact 3.4's ceiling algebra uses.
//
//     centreX is expensive in the real game (a scan across the corridor), so it
//     is cached on a 10 m grid and LERPED — the run-runner's own construction,
//     node for node. MEASURED error against the harness centreline over
//     z in [-300, 2900]: 1.4e-13 m, i.e. floating point. A 25 m grid with
//     nearest-node lookup measures up to 10.57 m of error at z = 787.5, which is
//     enough to fire a wall at an in-bounds rider. k is the exact derivative of
//     the interpolant (the local segment slope), so the coordinate system and
//     its Jacobian cannot disagree.
//
//   3.8 WHAT IS NOT PROMISED
//
//     Confinement is not free, and this module does not pretend it is. Every
//     correction takes energy out of the rider, and rs.confine reports how much:
//     a per-layer impulse ledger (m/s) and the signed specific work of every
//     write (energyRemoved/energyAdded, m^2/s^2). Nothing here is priced at zero
//     by assertion. What the layers cost a line that stays INSIDE the contract
//     corridor is zero, because 3.1 makes them inert on that set. What they cost
//     a line that leaves it is not zero, and the sentence cycle 5 wrote here —
//     "what the layers cost a competent line is zero" — quietly conflated the
//     two. The harness's own competent drive leaves the corridor: 2,636 of
//     18,000 frames are geometrically out of bounds, and 17.34 m of that is
//     up-course of zStart. A player who leans on a boundary pays for it, by
//     design, and the ledger is where the bill is printed.
//
//     PACE IS NOT A SAFE MEASURE HERE, and the module says so rather than
//     quoting a flattering finish time. The harness drive is a closed-loop
//     seeker: perturb it once at the top and every later jump lands differently.
//     Measured in an earlier cycle, an early 0.17 s hold moved the finish from
//     266.4 s to 234.6 s in one variant and 264.0 s in another — tens of seconds
//     in EITHER direction from writes totalling under 40 m/s of impulse. THIS
//     CYCLE IT HAPPENED AGAIN, in this module's favour, and it is reported for
//     that reason: one 20.5 m/s back-stop impulse at t = 12.3 s (correcting the
//     up-course excursion described in 2) moved the probe run from 266.42 s to
//     261.52 s and the score from 2099.1 to 2284.5. A module is not entitled to
//     bank a 4.9 s and 8.8% swing that its own write caused. That is why this
//     module reports impulse and energy, and why RS-08 should be read as the
//     coarse band its own statement says it is.
//
//     After the finish, the run-out holds the rider indefinitely: the envelope's
//     allowance is zero at the soft line, so gravity is cancelled frame after
//     frame and the rider stays parked at z = 2565.2. That is a sustained
//     correction, not a one-off, and it is counted in rs.confine.activeFraction
//     and in the run-out's impulse. It is the right behaviour — the run is over
//     and the mountain has run out — but it is a standing write, and calling it
//     anything else would be false.
//
// ---------------------------------------------------------------------------
// 4. THE WRITE CEILINGS — two of them, both published, both enforced
//
//   GROUNDED CORRECTIONS RIDE THE SNOW. You cannot push a board into or out of
//   the ground, only along it. There is exactly one tangent-plane vector whose
//   horizontal shadow is the correction the envelope asked for, and that is the
//   one applied: no authority is lost to a projection and none is invented by a
//   rescale. It also keeps the push out of the physics module's magnitude-
//   preserving grounded redirect, which would otherwise launder a component
//   pointed into the hill back out as forward speed — a confiner that boosts.
//
//   That lift means one number cannot do the job. Only the HORIZONTAL part of a
//   correction does containment work; the vertical part is bookkeeping that keeps
//   the push on the snow, and on a steep face it is the larger half. So:
//
//     A_HCEIL = KAPPA * W_WORLD + A_TRACK = 144.03 m/s^2
//       The world-horizontal ceiling, derived in 3.4. Applied BEFORE the tangent
//       lift, so the lift cannot smuggle horizontal authority in behind it.
//       Every containment derivation in this file uses this number.
//
//     A_CEIL3 = A_HCEIL / NY_FLOOR = 2 * A_HCEIL = 288.06 m/s^2
//       The bound on the 3-D magnitude of anything this module writes, and a
//       DECLARED POLICY rather than a measurement: NY_FLOOR = 0.5 = cos 60 deg,
//       i.e. the module refuses to lift a correction as if the ground were
//       steeper than 60 degrees. Equivalently: it never writes more than twice
//       the 3-D magnitude of its own horizontal ceiling.
//
//   WHY THIS REPLACED THE OLD GUARD (R3). Cycle 5 set A_CEIL3 = A_HCEIL / 0.3502
//   = 357 m/s^2 — 36 g — where 0.3502 was the minimum surface n_y over a 15 m
//   DILATION of the containment box. Deriving the bound from a set strictly
//   larger than the set the module can act in guarantees that the clamp cannot
//   bind, and it was published next to a rs.confine.ceil3Frames counter that
//   never fired, offered as if the zero were reassurance. It is not: an unfired
//   guard at 36 g is an unverified claim, and a counter that CANNOT fire measures
//   nothing at all.
//
//   THIS ONE CAN BIND, AND THE COST OF BINDING IS MEASURED. The containment box
//   contains ground below the floor: min n_y in the box is 0.4533 — a 63.0 deg
//   face at s = -153.8, z = 871.5 — and 352 of 417,956 sample points (0.084% of
//   the box, on a 2 m x 1 m grid) sit under 0.5. Where it binds:
//
//     delivered horizontal   = A_CEIL3 * n_y = 130.6 m/s^2 at the box's steepest
//                              point, against A_HCEIL = 144.03
//     guaranteed firmness    = 45 - 13.4 = 31.6 m/s^2 there, not 45
//     still above A_LAT = 26, so the one invariant that matters — the corridor
//     outholds a rider at full lock — survives the degradation
//     direction            — a shortfall can only make a RETURN slower. It can
//                            never push the rider outward, because the field is
//                            an inward-only excess (3.2) and scaling it down
//                            cannot change its sign.
//
//   rs.confine.ceil3Frames counts the firings and .ceil3WorstShortfall_mps2 the
//   worst horizontal it cost. Outside the box, n_y falls further (0.3971 over a
//   15 m dilation) and the clamp binds harder, for the same bounded reason.
//
//   Publishing only the smaller number would understate what the module writes;
//   publishing only the larger would overstate what it can contain. Both are in
//   config (ceilAccelHorizontal_mps2, ceilAccel3D_mps2), with the policy floor
//   (nyFloorPolicy) and the degraded firmness (trackFirmnessUnderClamp_mps2)
//   next to them.
//
// ---------------------------------------------------------------------------
// 5. THE LANDING LEDGER — adjudicated by the TRICK system, not by physics
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
// 6. RESULTS — the banked award, and no invented grades
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
// 7. EVIDENCE — what the gates measured, what nothing measures, and what a
//    self-written test is worth
//
//   THE ONLY INSTRUMENT HERE THIS MODULE DID NOT WRITE is harness/run-runner.mjs.
//
//   `node harness/run-runner.mjs --module sandbox/run-structure/A/run.mjs`
//     11/11, hardFails 0.  Numbers in config.measured.gateSuite.
//
//   WHAT THOSE GATES DID NOT MEASURE, stated plainly:
//     * RS-10's in-bounds frames are frames in which this module writes nothing
//       at all (3.1), so the gate cannot tell a correct corridor from an absent
//       one. moduleYawAuthority_degps = 0.00 is true and nearly uninformative.
//       RS-11 is the gate that has teeth on that set, and it reads exactly 0.
//     * The adversarial RS-05/RS-06 drive is stopped by the run-out and never
//       reaches the lateral wall at all, so the layer that does the widest
//       containment work is untouched by the gate suite.
//     * Ten of eleven gates take the rolling-start branch; only RS-09 stages
//       behind the line, and it only watches a countdown.
//     * NOTHING MEASURES THE START GATE'S vel[0] WRITE (R5). RS-09 measures
//       drift, RS-06/RS-10 measure position and heading, RS-11 excludes the
//       ready phase. rs.confine.gateVxWriteFrames / .gateMaxVxWrite_mps /
//       .gateVxImpulse_mps are the only measurement of it in existence and they
//       are self-reported by the module they measure. Section 2 gives the size.
//     * NOTHING MEASURES the 3-D clamp's binding set or its cost either; the
//       counters in section 4 are likewise self-reported.
//     * No gate runs at any dt but 1/60.
//
//   `node sandbox/run-structure/A/selftest.mjs` drives exactly those and reports
//   numbers rather than pass/fail alone: the wall and the return branch at
//   dt = 1/30, 1/60 and 1/120; a deliberate out-of-corridor injection at 40 m/s;
//   the berm's bank table against g/2; three staged starts driven THROUGH the
//   drop and down the course into the wall; the run-out and the back-stop; the
//   in-bounds write counter on every drive; the ledger against the trick system;
//   and the frozen card. `--measure` re-derives the MEASURED block from the
//   terrain.
//
//   ITS PASS COUNT IS NOT EVIDENCE AND IS NO LONGER QUOTED (R4). Cycle 5 cited
//   "79/79 checks pass; 82/82 with --measure" in this section as if a
//   self-written test agreeing with the module that wrote it were a result. It
//   is not. Nothing in the gate suite touches that file; its assertions are this
//   module's own opinions about itself, and a count of them is a count of
//   opinions. What selftest.mjs is actually for is producing NUMBERS on drives
//   the gate suite cannot reach — read the numbers, ignore the tally.
//
//   The other option was to fold those drives into harness/run-runner.mjs as
//   real probes. REJECTED, on principle: the harness is the gate law for a BLIND
//   gauntlet, and a candidate editing the law so that its own evidence counts is
//   precisely the conflict of interest the blind protocol exists to prevent. If
//   those probes belong in the suite — and the wall probe and a dt sweep probably
//   do — the harness owner should add them, against every candidate at once.
//
// ---------------------------------------------------------------------------
// 8. THE ASSUMPTION LEDGER — everything that reads like a theorem and is not
//
//   The sibling candidate lost the previous cycle for exactly one thing: stating
//   an assumption as a theorem. It assumed the worst corridor-lateral rate was
//   V_CAP when the coordinate is skewed and the true bound is V_CAP*sqrt(1+k^2)
//   = 43.46 m/s at k = -0.857. This file carries the Jacobian (3.3) — and then
//   has its own claims that read harder than they are. Full text with falsifiers
//   in config.derivation.assumptions; the summary:
//
//   IDENTITIES (algebra, true for any A, W, dt — quote these freely):
//     * SPAN(A,W,dt) = W^2/(2A) + W*dt is exactly the gap at which the discrete
//       allowance equals W. Substitute and the sqrt collapses to A*dt + W (3.3).
//     * The corridor coordinate solve: az = d2z/dt2, ax = d2s/dt2 + k*az is the
//       unique horizontal solution (3.7).
//     * The berm ceiling: (g/2)*sin(2*theta) <= g/2 for every theta (3.6).
//     * A_CEIL3 = 2*A_HCEIL given NY_FLOOR = 0.5 (4).
//
//   ASSUMPTIONS (each with a falsifier this module measures every frame):
//     * |v_horizontal| <= V_CAP AT MEASUREMENT TIME. Physics clamps 3-D speed at
//       the end of every GROUNDED step and leaves horizontal velocity untouched
//       in the AIR — but this module writes velocity in the air too, and physics
//       does not re-clamp there, so across consecutive airborne frames the cap is
//       this module's responsibility. The lateral writes are inward-only, but the
//       down-course layers write a_z and the coordinate solve turns that into
//       k*a_z of vx.  FALSIFIER: rs.confine.overCapFrames (want 0), with
//       .maxHorizSpeed_mps for the margin.
//     * |ds/dt| <= W_LAT = KAPPA*V_CAP. Inherits the above, and adds that KAPPA
//       is a finite-grid measurement (0.5 m in z) over a SMOOTHED centreline, not
//       an analytic bound.  FALSIFIER: rs.confine.overLatRateFrames (want 0),
//       with .maxLateralRate_mps.
//     * The inertness argument in 3.1 is an identity GIVEN those two. Without
//       them it is not a proof, and it is labelled accordingly.
//     * MARGIN is a bound assembled from separate worst cases holding at once
//       (3.5), which is asserted, not proved.  FALSIFIER: .beyondBound (want 0).
//     * The divergence figure (2.02 m) is a grid measurement with a published
//       convergence series, still climbing at the finest grid — a measurement,
//       not a supremum.  FALSIFIER: RS-05 above 4, or any denser sweep exceeding
//       it.
//     * SAFE_OFFSET, and therefore A_TRACK, inherit that. The firmness is
//       derived, but from a measured quantity, so it is exactly as solid as the
//       sweep behind it and no more.
//
//   CHOICES (preferences, defended but not derived): D_SAFE = 2.0, the round-up
//   of A_SOLVED to the next 5, NY_FLOOR = 0.5, KAPPA taken globally rather than
//   per-z, countdown_s = 3, splitCount = 3, ledgerWindow_steps = 2.
// ============================================================================

// --- physics anchors: read live, audited against a pinned copy --------------
// A STATIC import: if this path ever stops resolving the module fails to load,
// loudly, instead of silently substituting different constants. PINNED is the
// set every number quoted in the header above was computed against; any drift
// between it and the live module throws by name, because a retune that moves
// V_BOOST also moves this corridor and the header would otherwise be lying.
// Promoted to src/run/: physics is a sibling package, not three levels up. The
// sandbox-relative path resolved only from sandbox/run-structure/<cand>/ and threw
// on promotion (the cycle-4 critic predicted a silent fallback here; it was worse
// than silent — the module would not load at all).
import { DEFAULTS as PHYS } from '../physics/physics.mjs';

const PINNED = {
  V_CAP: 33, V_BOOST: 31, TAU_BOOST: 0.7, A_LAT: 26, G_GROUND: 9.81,
  MU_BASE: 0.0305, LAMBDA_LONG: 0.2235, TUCK_DRAG: 0.75,
  BRAKE_DECEL: 1.7,   // cited in 3.4's rejection of A_BRAKE = 4.5; read, not asserted
};
{
  const drift = [];
  for (const [k, v] of Object.entries(PINNED)) {
    const live = PHYS?.[k];
    if (typeof live !== 'number') drift.push(`${k}: missing from physics DEFAULTS`);
    else if (Math.abs(live - v) > 1e-12) drift.push(`${k}: physics ${live} vs pinned ${v}`);
  }
  if (drift.length) throw new Error(
    'run-structure/A: the accepted physics module has diverged from the constants this ' +
    'corridor was derived against. Re-derive the geometry (header 3.3-3.5) and update ' +
    'PINNED. Divergences: ' + drift.join('; '));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// MEASURED — measurements of this world, taken this cycle against
// src/render/main.mjs with the run-runner's own centreline and divergence
// probes. Each is a fact about the terrain or the harness, not a preference.
// Reproduce with `node sandbox/run-structure/A/selftest.mjs --measure`.
// ---------------------------------------------------------------------------
const MEASURED = {
  // largest |centreX'(z)| over the harness centreline (10 m nodes, -400..3190),
  // swept at 0.5 m. This is the Jacobian bound KAPPA is built from (header 3.3).
  maxCentrelineSlope: 0.8571,          // at z = 792.5, sweep step 0.5 m
  maxCentrelineSlopeSweep: '0.5 m in z over [-400, 3190]',
  // centreline error of this module's 10 m grid + lerp against the harness
  // centreline, and of a 25 m nearest-node cache, over z in [-300, 2900]
  centrelineErr10mLerp_m: 1.42e-13,
  centrelineErr25mNearest_m: 10.57,    // at z = 787.5
  // terrain's own INWARD horizontal restoring acceleration along the corridor
  // lateral coordinate, both flanks, z = 0..2400, 5 m grid in z (m/s^2)
  terrainInwardPull_mps2: {
    120: { median: 4.72, min: 3.47, max: 6.31 },
    130: { median: 4.76, min: 3.54, max: 6.24 },
    141.7: { median: 4.72, min: 3.55, max: 5.92 },   // the wall's soft line
    153.8: { median: 4.64, min: 3.31, max: 5.80 },   // the containment bound
    // inside the corridor, for the 1.1 disclosure: the mountain banks the
    // shoulder on its own, which is why the berm need not reach in there
    100: { median: 4.44, min: 3.07, max: 6.35 },
  },
  // largest top-up the berm law ever asks for, swept over |s| in [120, 141.713]
  // at 0.5 m plus a sample exactly on the soft line, z = 0..2400 at 1 m:
  // 1.361 m/s^2 at s = 141.71, z = 548, where the terrain's own pull is 3.54
  peakBermTopUp_mps2: 1.361,
  peakBermTopUpSweep: '0.5 m in s (plus the exact soft line) x 1 m in z, z = 0..2400',
  // ---- THE DIVERGENCE SWEEP. Resolution is published next to every figure,
  //      because it matters: the same box reads 1.857 m on a 2 m grid and
  //      2.015 m converged, and the 2 m figure is a LOWER BOUND, not the answer.
  // worst mesh-vs-physics divergence at a given lateral offset, over the
  // containment box's z range (the runner's own divergence probe), 1 m in z
  divergenceByOffset_m: { 0: 0.93, 120: 0.95, 130: 1.06, 141.7: 1.44, 150: 1.92,
    153.8: 1.82, 160: 2.46, 180: 2.29, 200: 3.65, 220: 4.20, 240: 5.56 },
  // SAFE_OFFSET: the widest |s| whose CUMULATIVE worst divergence (over every
  // offset at or inside it, over z in [-140, 2600]) is still <= D_SAFE.
  divergenceSafeTarget_m: 2.0,         // = RS-05's 4 m HARD ceiling / 2
  safeOffset_m: 155.5,                 // measured; the firmness is solved from this
  safeOffsetSweep: '0.5 m in s x 1 m in z, |s| <= 260, z in [-140, 2600]',
  // there is a STEP in the divergence field at |s| = 149.5 (1.48 -> 2.02 m).
  // The bound sits 4.3 m outside it; sitting just inside would report 1.48 m
  // and would flip back on 4 m of geometry change (header 3.5).
  divergenceStepAt_m: 149.5,
  // worst divergence over THIS module's whole containment box
  // (|s| <= 153.763, z in [-140.5, 2573.1]), by grid — a convergence series,
  // not a single number, so the resolution cannot hide behind the figure
  divergenceInBoxByGrid_m: { '2 x 2': 1.857, '0.5 x 1': 1.929, '0.25 x 0.5': 1.990,
    '0.25 x 0.25': 1.992, '0.05 local refine': 2.015 },
  divergenceInContainmentBox_m: 2.02,  // converged, at s = 149.50, z = 135.15
  divergenceInContainmentBoxSweep: '0.25 m x 0.25 m over the box, then 0.05 m local refinement at the peak',
  // the cycle-5 box (|s| <= 172.682) for comparison, at the coarser grid it was
  // published on and at the denser one: 2.47 (2 m) / 2.48 (0.5 m x 1 m)
  divergencePrevBox_m: { '2 x 2': 2.47, '0.5 x 1': 2.48 },
  // fine-LOD region of the runner's divergence probe, and the gap immediately
  // outside it — the containment box must lie wholly inside
  fineLodZ: [-250, 2750],
  divergenceJustOutsideFineLod_m: { '-260': 8.33, 2760: 9.27 },
  // minimum surface n_y INSIDE the containment box, and over a 15 m dilation
  // of it, both on a 0.5 m x 1 m grid
  minSurfaceNyInBox: 0.4533,           // 63.0 deg, at s = -153.76, z = 871.5
  minSurfaceNyDilated15m: 0.3971,      // 66.6 deg, at s = -168.76, z = 859.5
  // how much of the box is steeper than the NY_FLOOR = 0.5 policy line, i.e.
  // where the 3-D clamp CAN bind: 352 of 417,956 samples (0.084%), 2 m x 1 m
  boxSamplesBelowNyFloor: { below: 352, total: 417956, grid: '2 m in z x 1 m in s' },
  // render lane's tree line: src/render/main.mjs plants pines only where
  // d = |x - centerX(z)| is in (55, 720) — this module's own lateral coordinate.
  // NOT used to place any layer this cycle (header 1.1); kept as the landmark
  // the previous cycle's berm start cited, so the change is auditable.
  treeLine_m: 55,
  // gate-suite numbers for this module, from harness/run-runner.mjs — the only
  // numbers in this file produced by an instrument this module did not write
  gateSuite: {
    moduleYawAuthority_degps: 0,       // RS-10, bar 5
    maxDivergenceReached_m: 0.97,      // RS-05, bar 4
    maxCorrectionJump_m: 0.465,        // RS-06, bar 2 (the rider's own travel)
    inBoundsWriteMax: 0,               // RS-11, bar 1e-9
    startHolds: 1,                     // RS-09, bar 3 m drift
    runDuration_s: 261.5,              // RS-08, band 90-300
  },
};

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W_WALL = B.halfWidth ?? 120;             // contract corridor edge

  // ---------------- physics constants (all read, none asserted) -------------
  const V_CAP = PHYS.V_CAP;                      // 33
  const V_BOOST = PHYS.V_BOOST;                  // 31
  const TAU = PHYS.TAU_BOOST;                    // 0.7
  const G = PHYS.G_GROUND;                       // 9.81
  const A_LAT = PHYS.A_LAT;                      // 26

  // ---------------- the three horizontal channels (header 3.4) --------------
  // Boost is a first-order relaxation toward V_BOOST with time constant
  // TAU_BOOST, so at rest it delivers V_BOOST/TAU_BOOST, aimed wherever the
  // board points: the strongest drive a player can command.
  const DRIVE_MAX = V_BOOST / TAU;                          // 44.286
  // A slope's horizontal component of tangential gravity is (g/2)*sin(2*theta),
  // maximal at 45 deg. No bank, and no berm, can exceed this.
  const A_BERM_MAX = G / 2;                                 // 4.905
  // Everything the world can push with, horizontally, at once.
  const W_WORLD = DRIVE_MAX + A_LAT + A_BERM_MAX;           // 75.191

  // ---------------- the corridor's skew (header 3.3) ------------------------
  // s = x - centreX(z) => ds/dt = vx - k*vz, so |ds/dt| <= |v| * sqrt(1+k^2).
  const K_MAX = MEASURED.maxCentrelineSlope;                // 0.8571, measured
  const KAPPA = Math.sqrt(1 + K_MAX * K_MAX);               // 1.31705
  const W_LAT = KAPPA * V_CAP;                              // 43.463 m/s
  const W_Z = V_CAP;                                        // 33 m/s (no skew)

  // ---------------- span and margin, as functions of the firmness -----------
  // SPAN(A, W, dt) is the gap at which the DISCRETE allowance equals W exactly:
  //   allow(-SPAN) = -A*dt + sqrt(A^2 dt^2 + W^2 + 2 A W dt) = W
  const span = (A, W, dt) => (W * W) / (2 * A) + W * dt;
  // MARGIN(A, kappa, dt): worst penetration past a soft line (header 3.5).
  // a(w) = A + w/TAU below the boost knee, A + full drive above it, the whole
  // bracket scaled by kappa on the skewed axis. NOT a theorem — see the
  // assumption ledger, header 8.
  const marginFor = (A, kap, dt) => {
    const wKnee = Math.min(kap * V_BOOST, kap * V_CAP);
    const W = kap * V_CAP;
    const aT = A * TAU;
    return TAU * (wKnee - aT * Math.log(1 + wKnee / aT))
      + Math.max(0, W * W - wKnee * wKnee) / (2 * (A + kap * DRIVE_MAX))
      + W * dt;
  };
  // How far out the corridor's lateral containment bound lands, for a firmness
  // A: the contract edge plus the layer's own span plus the worst penetration
  // past its soft line. Strictly decreasing in A.
  const reachOf = A => W_WALL + span(A, W_LAT, 1 / 60) + marginFor(A, KAPPA, 1 / 60);

  // ---------------- firmness: DERIVED FROM THE MOUNTAIN'S ROOM (header 3.4) --
  // The room is SAFE_OFFSET: the widest |s| at which the mesh-vs-physics
  // divergence the RS-05 gate measures still sits at or under D_SAFE, measured
  // on a stated grid (MEASURED.safeOffsetSweep). D_SAFE = 2 m is half the
  // contract's 4 m HARD ceiling: a factor-of-two safety margin, declared.
  // The firmness is then the SOFTEST A whose reach still fits in that room.
  const D_SAFE = MEASURED.divergenceSafeTarget_m;           // 2.0 m = ceiling/2
  const SAFE_OFFSET = MEASURED.safeOffset_m;                // 155.5 m, measured
  const A_SOLVED = (() => {                                 // 42.297 m/s^2
    let lo = 1, hi = 5000;                                  // reach(1) >> SAFE, reach(5000) << SAFE
    for (let i = 0; i < 120; i++) { const m = (lo + hi) / 2; if (reachOf(m) > SAFE_OFFSET) lo = m; else hi = m; }
    return hi;
  })();
  // ROUNDED UP to the next 5 (a declared choice): the solved root is precise
  // about a quantity measured on a finite grid, and rounding up can only move
  // the bound further inside the room. 42.297 -> 45, buying 1.74 m of inset.
  const A_TRACK = Math.ceil(A_SOLVED / 5) * 5;              // 45 m/s^2
  const A_HCEIL = KAPPA * W_WORLD + A_TRACK;                // 144.03

  // The 3-D bound. NY_FLOOR is a declared POLICY, not a measurement: the module
  // will not lift a correction as if the ground were steeper than 60 deg, so it
  // never writes more than TWICE its own horizontal ceiling in 3-D magnitude.
  // Below the floor the lift is under-delivered — disclosed in header 4.
  const NY_FLOOR = 0.5;                                     // cos 60 deg (policy)
  const A_CEIL3 = A_HCEIL / NY_FLOOR;                       // 288.06 = 2*A_HCEIL

  const SPAN_LAT_REF = span(A_TRACK, W_LAT, 1 / 60);        // 21.713 m @60Hz
  const SPAN_Z_REF = span(A_TRACK, W_Z, 1 / 60);            // 12.650 m @60Hz

  // ---------------- the finish apron (header 3.3a) --------------------------
  // Closed-form distance in which the accepted physics module's longitudinal
  // law a(v) = MU_BASE*g + LAMBDA_LONG*TUCK_DRAG*v brings V_CAP to rest on flat
  // ground, at the LOWEST drag the rider can choose (tucked) — the longest
  // run-out any rider can need. Every symbol is a published physics constant.
  const F0_FLAT = PHYS.MU_BASE * G;                         // 0.2992 m/s^2
  const L_TUCK = PHYS.LAMBDA_LONG * PHYS.TUCK_DRAG;         // 0.1676 1/s
  const APRON = (V_CAP - (F0_FLAT / L_TUCK) * Math.log(1 + L_TUCK * V_CAP / F0_FLAT)) / L_TUCK;
                                                            // 165.244 m

  const MARGIN_LAT = marginFor(A_TRACK, KAPPA, 1 / 60);     // 12.050 m
  const MARGIN_Z = marginFor(A_TRACK, 1, 1 / 60);           //  7.859 m

  // ---------------- quoted geometry at the reference step -------------------
  const L_SOFT = W_WALL + SPAN_LAT_REF;                     // 141.713
  const L_BOUND = L_SOFT + MARGIN_LAT;                      // 153.763 (= reachOf(A_TRACK))
  const Z_SOFT_DOWN = zFinish + Math.max(APRON, SPAN_Z_REF); // 2565.244
  const Z_BOUND_DOWN = Z_SOFT_DOWN + MARGIN_Z;              // 2573.103

  const COUNTDOWN_S = env.countdown_s ?? 3;      // CHOICE (presentation only)
  const SPLITS = 3;                              // CHOICE (presentation only)
  const LEDGER_WINDOW = 2;                       // 1 derived + 1 slack (header 5)

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth: W_WALL,
    maxDivergence_m: 4,          // the CONTRACT's ceiling (RS-05), as defined
    // ---- this module's own guarantee, published separately ----
    divergenceInContainmentBox_m: MEASURED.divergenceInContainmentBox_m,
    // ---- corridor geometry (quoted at 60 Hz; every layer start is recomputed
    //      each frame from the live dt, header 3.3) ----
    bermStart_m: W_WALL, wallStart_m: W_WALL,
    kappa: KAPPA, maxOutwardRateLateral_mps: W_LAT, maxOutwardRateZ_mps: W_Z,
    spanLateral_m: SPAN_LAT_REF, spanZ_m: SPAN_Z_REF, apron_m: APRON,
    lateralSoftLine_m: L_SOFT, lateralBound_m: L_BOUND,
    zSoftDown_m: Z_SOFT_DOWN, zBoundDown_m: Z_BOUND_DOWN,
    // the up-course layer defends min(zStart, stagedZ), so its lines are
    // published as OFFSETS from the start the run actually gets (header 2)
    backstopSoftOffset_m: -SPAN_Z_REF, backstopBoundOffset_m: -(SPAN_Z_REF + MARGIN_Z),
    marginLateral_m: MARGIN_LAT, marginZ_m: MARGIN_Z,
    // ---- firmness + ceilings ----
    driveMax_mps2: DRIVE_MAX, worldPushMax_mps2: W_WORLD,
    trackFirmness_mps2: A_TRACK, bermMax_mps2: A_BERM_MAX,
    // the firmness derivation, published so it can be re-run rather than trusted
    safeOffset_m: SAFE_OFFSET, divergenceSafeTarget_m: D_SAFE,
    trackFirmnessSolved_mps2: A_SOLVED,      // 42.297, the exact root
    trackFirmnessRoundedTo: 5,               // declared choice; A_TRACK = 45
    lateralBoundInsetFromSafeOffset_m: SAFE_OFFSET - (W_WALL + SPAN_LAT_REF + MARGIN_LAT),
    ceilAccelHorizontal_mps2: A_HCEIL, ceilAccel3D_mps2: A_CEIL3,
    nyFloorPolicy: NY_FLOOR,                 // 0.5 = cos 60 deg, a POLICY
    minSurfaceNyInBox: MEASURED.minSurfaceNyInBox,
    // worst horizontal shortfall where the 3-D clamp binds, and the firmness
    // that survives it (header 4): A_TRACK degrades but stays above A_LAT
    worstClampedHorizontal_mps2: A_CEIL3 * MEASURED.minSurfaceNyInBox,
    trackFirmnessUnderClamp_mps2: A_TRACK - (A_HCEIL - A_CEIL3 * MEASURED.minSurfaceNyInBox),
    // ---- run ----
    countdown_s: COUNTDOWN_S, splitCount: SPLITS,
    ledgerWindow_steps: LEDGER_WINDOW,
    // ---- provenance ----
    physicsAnchor: 'live (static import, audited against PINNED on load)',
    physicsPinned: { ...PINNED },
    measured: MEASURED,
    derivation: {
      inBoundsAuthority: 'ZERO, by construction and by counter. The contract\'s in-bounds set is |s| <= halfWidth and z in [zStart, zFinish]; the berm starts AT halfWidth, and every other layer\'s soft line sits one span outside the boundary it defends, where the span identity makes its allowance equal the fastest outward rate physics permits. RS-11 — a gate this module did not write — sweeps in-bounds states at up to the full skewed rate and reads inBoundsWriteMax = 0 exactly, and rs.confine.inBoundsWriteFrames reads 0 across the gate suite. NOTE the argument is an identity GIVEN the two assumptions in `assumptions` (|v_horizontal| <= V_CAP and |ds/dt| <= W_LAT at measurement time), not a free-standing theorem; both are measured every frame. The berm used to start at |s| = 55 (the render lane\'s tree line) and so applied force 65 m inside the corridor; that is the cycle-4 defect this cycle removes. The cost is stated: this module no longer banks the ridable shoulder. The mountain does — measured inward pull at |s| = 100 is 4.44 m/s^2 median, 90% of the g/2 ceiling any bank can have.',
      outOfBoundsField: 'GEOMETRY, not self-report. rs.outOfBounds is exactly the contract predicate (|s| > halfWidth, or z outside [zStart, zFinish]) computed from position; rs.outOfBoundsAxis names which boundary; rs.confine.active is the separate "this module wrote something" signal. CONTRACTS.md glosses the field as "true while correcting" and cycle 4 took that reading, which both mislabelled in-bounds riders to the HUD and removed 174 frames from the set RS-10 measures. The lane critic ruled for the geometric reading. Visible consequence: after the finish the rider is past zFinish, so the flag stands for the whole run-out, with axis "down".',
      law: 'one allowance on the outward rate: +sqrt(2*A*(-p)) inside the soft line, -sqrt(2*A*p) outside it. Zero exactly at the line, continuous across it; the field removes the excess over it and nothing else.',
      discreteForm: 'the inside branch is solved for the step about to be taken: w_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*(-p)), so the line cannot be crossed by braking one step late at any dt.',
      layerStart: 'EXACT IDENTITY, not a placement. span(A,W,dt) = W^2/(2A) + W*dt is the gap at which the discrete allowance equals W exactly (substitute and the sqrt collapses to A*dt + W). Each soft line sits one span outside the CONTRACT boundary it defends, with W = the fastest outward rate physics permits on that axis, so the layer is provably inert at and inside that boundary at any dt.',
      skew: 'W IS NOT V_CAP LATERALLY, and cycle 4 assumed it was. s = x - centreX(z) gives ds/dt = vx - k*vz, so a rider at the speed cap can have a corridor-lateral rate of V_CAP*sqrt(1+k^2). Measured max |centreX\'(z)| = 0.8571 at z = 792.5 (0.5 m sweep in z), so KAPPA = 1.31705 and W_LAT = 43.463 m/s. Taken at the GLOBAL maximum, not the local k(z): a z-varying soft line would be tighter but would move by up to 15.6 m over a 10 m centreline segment, and a rider riding the wide part into a straight section would be 15 m past a line that had come to them. That is a jolt with no visible cause. The width the fixed geometry costs is checked in the divergence sweep, not assumed harmless.',
      firmness: 'DERIVED FROM THE MOUNTAIN\'S ROOM, not cited from the rider. The room is SAFE_OFFSET = 155.5 m: the widest |s| whose cumulative worst mesh-vs-physics divergence (the quantity RS-05 measures) is still at or under D_SAFE = 2.0 m, which is half the contract\'s 4 m HARD ceiling — a declared factor-of-two safety margin. reach(A) = halfWidth + span(A, W_LAT, dt) + margin(A, KAPPA, dt) is strictly decreasing in A, so there is exactly one softest firmness whose containment bound still fits: A_SOLVED = 42.297 m/s^2, found by bisection in the module itself rather than pasted in. A_TRACK is that rounded up to the next 5 = 45 m/s^2 (a declared choice: the root is precise about a grid-measured quantity, and rounding up can only move the bound further inside the room; it buys 1.74 m of inset). WHAT THIS REPLACED, and why: cycle 5 set A_TRACK = A_LAT = 26 and defended it as "exactly as strong as the rider\'s own best turn". That was a REPURPOSED CITATION, not a derivation — A_LAT is the RIDER\'s steering ceiling, a different category from a corridor\'s firmness, and it is the same category slip this module rejects when it rejects A_BRAKE = 4.5 from TN-08. THE FEEL CONSEQUENCE, stated rather than used: at 45 m/s^2 the corridor is 1.73x the rider\'s own best turn, so a player at full lock no longer matches the wall, they lose to it by 73%. That is a real change in how the boundary feels and it is the price of sizing the corridor from the mountain instead of from the rider.',
      rejectedFirmness: 'REJECTED: (a) A_BRAKE = 4.5 m/s^2 (REFERENCE_BAR TN-08 band 3-6), used by an earlier candidate in this line as "the rider\'s own brake authority" — the accepted physics module publishes BRAKE_DECEL = 1.7 (in PINNED, read live, audited on load), so the citation and the code disagreed, and 4.5 was a hand-picked point in a band; following the citation properly needs a 556 m lateral span, which is off the mountain. (b) DRIVE_MAX + g = 54.096, the cycle-4 lateral firmness, whose "+ g" was asserted; defensible as "cannot be outrun in principle" but it is an assertion about what the corridor should feel like, not a measurement of what the mountain has room for. (c) A_LAT = 26, cycle 5 — see `firmness`: a repurposed citation of the rider\'s own steering ceiling. Note that the derivation is agnostic about all three: it asks the mountain how much room there is and returns the softest firmness that fits in it, and A_LAT, A_BRAKE and DRIVE_MAX+g are simply not the answer to that question.',
      ceiling: 'DERIVED FROM THE FIRMNESS, not the other way round. To guarantee A_TRACK of net inward acceleration the module must first cancel the largest outward push the world can produce: physics has exactly three horizontal channels — drive DRIVE_MAX = V_BOOST/TAU_BOOST = 44.286, edge A_LAT = 26, gravity g/2 = 4.905 — summing to W_WORLD = 75.191, and laterally a world-horizontal push produces up to KAPPA times as much corridor-lateral rate while a corridor-lateral correction costs exactly its own magnitude in world-horizontal terms. So A_HCEIL = KAPPA*W_WORLD + A_TRACK = 144.03. The down-course axis has no skew and is covered with room to spare (net available 68.84 against an envelope asking 45). NOTE the sum is a BOUND assembled from three separate worst cases, not an observed state: it assumes full boost, full outward lock and a 45 deg fall line at once. It is deliberately loose, and A_HCEIL is correspondingly loose.',
      ceilAccel3D: 'A DECLARED POLICY WITH A DISCLOSED COST, no longer an unfired guard. A grounded push must lie in the tangent plane, so delivering h horizontally costs h/n_y of 3-D magnitude. Cycle 5 set A_CEIL3 = A_HCEIL / 0.3502 = 357 m/s^2 (36 g) from the minimum n_y over a 15 m DILATION of the box — a number that by construction could never bind, published next to a ceil3Frames counter that never fired. An unfired guard at 36 g is an unverified claim, so it is gone. Now: NY_FLOOR = 0.5 (cos 60 deg) is a POLICY — the module refuses to lift a correction as if the ground were steeper than 60 degrees — and A_CEIL3 = A_HCEIL / NY_FLOOR = 2 * A_HCEIL = 288.06 m/s^2 exactly. THIS ONE CAN BIND: the containment box contains ground below the floor (min n_y in box 0.4533, a 63.0 deg face at s = -153.8, z = 871.5; 352 of 417,956 sample points, 0.084% of the box, on a 2 m x 1 m grid). WHAT IT COSTS WHEN IT BINDS: the delivered horizontal drops to A_CEIL3*n_y = 130.6 m/s^2 at the box\'s steepest point, so the corridor\'s guaranteed firmness there falls from 45 to 31.6 m/s^2 — still above the rider\'s own A_LAT = 26, so the invariant that matters (the corridor outholds the rider) survives; and the shortfall only slows a return, it can never push a rider outward. Outside the box n_y falls further (0.3971 over a 15 m dilation) and the clamp binds harder, for the same bounded reason. rs.confine.ceil3Frames counts the firings; read header 7 before treating a 0 there as evidence.',
      apron: 'The DOWN-COURSE layer does not sit at the inertness minimum. A finish line has a run-out, and its length here is the room the rider\'s own drag law needs: the closed-form distance in which the accepted physics module\'s longitudinal law a(v) = MU_BASE*g + LAMBDA_LONG*TUCK_DRAG*v brings V_CAP to rest on flat ground, at the lowest drag the rider can choose (tucked) — APRON = (1/L)*(V_CAP - (F0/L)*ln(1 + L*V_CAP/F0)) = 165.244 m, every symbol a published physics constant. It is NOT a promise the rider stops in it: this course keeps descending past the finish and a rider holding boost never stops anywhere. It is the statement that the mountain gets the whole of the rider\'s own stopping distance before a barrier takes over. Enforced as max(APRON, span) so the inertness identity still holds at any dt. The back-stop keeps the inertness minimum instead: up-course the mountain climbs, so there is nothing to run out into, and a shorter layer keeps the containment box smaller.',
      apronDefect: 'DISCLOSED: an earlier geometry in this line put the down-course layer at the inertness minimum too and parked the rider 56 m past the finish. That is a real design defect and not only a gate failure — the harness RS-02 probe rides 60 m past the line to prove the finish phase latches, and a 56 m run-out is shorter than the overrun of the drive it is supposed to catch.',
      margin: 'AN ASSUMPTION-LADEN BOUND, not a theorem — see `assumptions`. The integral of w/a(w) dw over the axis\'s whole outward-rate range, plus one unseen frame at the top of it (the module reads the rider after physics has moved them). a(w) is the NET inward acceleration at outward rate w with the drive and the speed COUPLED: physics\' boost is a relaxation toward V_BOOST, so a rider already leaving at w has only (V_BOOST-w)/TAU of drive left and none at all past V_BOOST. a(w) = A_TRACK + w/TAU below the knee and A_TRACK + full drive above it, the whole bracket scaled by KAPPA on the skewed axis. MARGIN_LAT = 12.050 m, MARGIN_Z = 7.859 m. Distinct from the W*dt term in span: that one buys inertness at a layer\'s start, this one buys headroom past its soft line.',
      containmentBound: 'soft line + MARGIN. A BOUND, not a barrier: nothing is placed there, nothing fires there, and rs.confine.beyondBound counts frames past it. It is the quantity the firmness is solved to fit inside SAFE_OFFSET, so the geometry and the divergence budget are one derivation and not two.',
      divergence: 'CHECKED AT A PUBLISHED RESOLUTION, and the headroom went back UP. The containment box is now |s| <= 153.763, z in [-140.5, 2573.1]. Worst mesh-vs-physics divergence over it: 1.857 m on a 2 m grid, 1.929 on 0.5 x 1 m, 1.990 on 0.25 x 0.5 m, 1.992 on 0.25 x 0.25 m, and 2.015 m converged under a 0.05 m local refinement at the peak (s = 149.50, z = 135.15). PUBLISHED FIGURE: 2.02 m, i.e. 50.4% of RS-05\'s 4 m HARD ceiling, with 1.98 m of headroom. The convergence series is published rather than a single number because the resolution matters: the 2 m grid understates the same box by 0.16 m, so a coarse-grid figure is a LOWER BOUND, not the answer — which is exactly what cycle 5\'s "2.47 m on a 2 m grid" over the wider box was (the same box reads 2.48 m on a 0.5 x 1 m grid). THE FRAGILITY, named: the divergence field has a STEP at |s| = 149.5, from 1.48 m just inside it to 2.02 m just outside. Placing the bound 4 m further in would report 1.48 m, and that number would flip back on 4 m of geometry change; the bound sits 4.3 m outside the step instead, where the figure is already paid for. The box lies wholly inside the fine-LOD region z in [-250, 2750]; immediately outside it the gap is 8.33 m (z = -260) and 9.27 m (z = 2760). If the terrain lane reshapes the gully this is the first number to re-measure, and SAFE_OFFSET with it — which re-derives the firmness.',
      berm: 'a_berm = q^2 * max(0, g/2 - a_terrain_inward), q = clamp((|s| - halfWidth)/(lateralSoftLine - halfWidth), 0, 1), grounded only. g/2 is a ceiling, not a taste: a slope\'s inward horizontal restoring accel is (g/2)*sin(2*theta), maximal at 45 deg, so no bank and no berm can exceed it. MEASURED, the gully already pulls 4.72 m/s^2 (median) / 3.47 (min) inward at |s| = 120, so the berm TOPS UP rather than adding to a bank already near its ceiling; peak contribution is 1.361 m/s^2 at s = 141.71, z = 548 (swept 0.5 m in s plus the exact soft line, 1 m in z). q^2 is the lowest-order polynomial that is zero with zero slope at the corridor edge and 1 at the wall\'s soft line. Overrule test: g/2 is 18.9% of A_LAT = 26, so full lock still wins the flank. The ramp is 21.7 m wide now (120 -> 141.7) where it was 37.1 m, because the firmer corridor pulls the wall\'s soft line in; the bank therefore builds more sharply per metre, and that is a consequence of the firmness derivation, not a separate tuning.',
      startGate: 'a rider staged AT OR BEHIND zStart gets a gate at their own staged position (the first z this module sees), not at zStart, because a gate 40 m down-course of a staged rider catches them instead of holding them. Same allowance law, soft line at the gate, so at p = 0 the field removes exactly the down-course rate the rider has and nothing more, and the clock starts at the drop. The up-course back-stop defends min(zStart, stagedZ) for the same reason: a back-stop pinned to zStart would be a wall down-course of a rider staged behind it, and its return branch would shove them forward.',
      startGateWritesVx: 'DISCLOSED PRECISELY, AND UNMEASURED BY THE GATE SUITE. Holding a staged rider is a velocity write, and because the corridor coordinate is skewed it is not confined to vel[2]: the gate demands a_z, and the exact coordinate solve (3.7) turns that into a_x = k*a_z, the amount that leaves ds/dt untouched. So the gate writes vel[0] during the ready phase. MAGNITUDE: measured up to 0.68 m/s of total vel[0] change over a 3 s countdown at z = -40, against 0 to floating point in ds/dt. It is now counted, not merely admitted: rs.confine.gateVxWriteFrames, gateMaxVxWrite_mps (largest single-frame |dvx|), gateVxImpulse_mps (the total), and gateMaxDsdtWrite_mps (which stays at floating-point zero whenever the gate is the only layer acting, and is the check that the write really is the skew term and nothing else — a rider staged outside the corridor also has the berm and the wall on them, and then it is legitimately non-zero and the lateral counters say so). NO GATE MEASURES THIS. RS-09 measures down-course drift over the countdown and nothing else; RS-06 and RS-10 measure position and heading, which this does not touch; RS-11 sweeps mid-run states with phase forced to running, which excludes the ready phase entirely. The counters are the only measurement, and they are self-reported. WHY IT IS STILL RIGHT: the alternatives are worse and both were tried — writing position is a teleport, and zeroing the whole velocity vector is a physics write on an ordinary frame (the cycle-4 sibling that did it moved its own run\'s score by 15.7x).',
      rollingStart: 'A BRANCH, and the measurement that justifies it. A rider staged DOWN-COURSE of zStart is already on the course and there is no gate down there to hold them, so the run is already on: empty ready phase, clock from frame 1, gateZ null, no write. Holding a rolling rider wherever they stand was measured and rejected — it brings every harness probe to a dead stop 15 m inside the course for 36 m/s of gate impulse and hands the rider back at zero speed on a slope, where the closed-loop drive spun and boosted 60 m back up-course. WHAT THE BRANCH COSTS: ten of eleven gates take the rolling path, so the gate suite exercises the pen once, on a countdown, with no corridor work. selftest.mjs section 5 stages riders at z = -40, -5 and -120 and drives each THROUGH the drop and into the wall.',
      changesTheRun: 'RETIRED CLAIM, and the number that retired it. Cycle 5 stated that the probe drive\'s run was bit-identical with and without this module attached, and used it as evidence that the module only times the run. It is no longer true. The harness\'s own competent drive flies 17.34 m UP-COURSE of zStart at t = 12.3 s, airborne at 18 m/s backwards after a jump, which is out of bounds by the contract predicate (z < zStart). Cycle 5\'s back-stop soft line sat 21.49 m up-course and never engaged, so that module left a genuinely out-of-bounds rider alone; the firmer corridor puts the line at 12.65 m and the back-stop now catches it. MEASURED COST: 261.52 s with the module against 266.42 s without, and 2284.5 points against 2099.1 — 4.9 s and 8.8%, in the direction that flatters this module, from one 20.5 m/s back-stop impulse. That is the closed-loop chaos described in header 3.8, not a systematic gain: over the rest of that 18,000-frame run the corridor writes nothing at all (berm/wall/limit/gate frames all 0, inBoundsWriteFrames 0). THE TRADE: correcting an out-of-bounds rider is the contract\'s instruction and staying out of the run\'s way is a timer\'s instinct; they conflict here and this module follows the contract. The way to buy the silence back is a wider up-course boundary in env.bounds, not a slack back-stop.',
      choices: 'countdown_s = 3 and splitCount = 3 are CHOICES (presentation only, no physical claim). ledgerWindow_steps = 2 is 1 derived + 1 step of slack (CHOICE). D_SAFE = 2.0 m (half the RS-05 HARD ceiling) is a CHOICE — the safety factor the firmness is solved against. Rounding A_SOLVED up to the next 5 is a CHOICE. NY_FLOOR = 0.5 is a CHOICE (policy). Taking KAPPA at its global maximum rather than locally is a CHOICE, defended above. Nothing else in this block is a preference.',
      rank: 'absent by decision: no defensible speed ladder exists yet, and a grade band over an unsettled ladder is invention. results.anchors carries the sourced anchors instead.',
      // ---------------------------------------------------------------------
      // THE ASSUMPTION LEDGER. Everything above that reads like a theorem but
      // is not one, with the falsifier for each. The sibling candidate lost its
      // cycle for stating an assumption as a theorem (it assumed the worst
      // corridor-lateral rate was V_CAP when the coordinate is skewed and the
      // true bound is V_CAP*sqrt(1+k^2) = 43.46 m/s at k = -0.857), so this
      // block exists to make the same failure visible here if it occurs.
      // ---------------------------------------------------------------------
      assumptions: {
        horizontalSpeedCap: 'ASSUMPTION (not a theorem): |v_horizontal| <= V_CAP at the instant this module measures the rider. It is what makes the span identity an inertness PROOF; without it the allowance at a layer\'s start is not necessarily >= the rider\'s outward rate. It is well grounded but not free: the accepted physics module clamps the full 3-D speed to V_CAP at the end of every GROUNDED step, and leaves horizontal velocity untouched ballistically in the AIR, so a rider entering the air at or under the cap stays under it. THE HOLE: this module also writes velocity while the rider is airborne (the wall and the limit act in the air by design), and physics does not re-clamp in the air, so across consecutive airborne frames the cap is this module\'s responsibility, not physics\'. The lateral writes are inward-only and cannot raise the outward rate, but the down-course layers write a_z and the coordinate solve turns that into k*a_z of vx, which can raise |v_horizontal|. FALSIFIER, MEASURED EVERY FRAME: rs.confine.maxHorizSpeed_mps and rs.confine.overCapFrames. A non-zero overCapFrames falsifies the inertness proof in 3.1 and the margin bound in 3.5, and the module publishes it rather than assuming it away.',
        lateralRateBound: 'ASSUMPTION: |ds/dt| <= W_LAT = KAPPA*V_CAP. It inherits everything above, and adds that KAPPA is a bound on |centreX\'(z)| measured on a finite sweep (0.5 m in z over [-400, 3190]) of a SMOOTHED centreline. A finer sweep, or a terrain change, can raise it. FALSIFIER: rs.confine.maxLateralRate_mps and rs.confine.overLatRateFrames, measured every frame against W_LAT.',
        kappaGlobalMax: 'ASSUMPTION: 0.8571 is the global max |centreX\'|. It is a finite-grid measurement of a smoothed piecewise-linear interpolant, not an analytic bound on the terrain. Falsified by any z where the module\'s own cxPrime exceeds it; that is what overLatRateFrames catches downstream.',
        marginBound: 'ASSUMPTION, and the loosest thing in the file: MARGIN is the penetration a rider suffers under a worst case assembled from separate worst cases (full outward drive for the whole excursion, the whole bracket scaled by KAPPA, the rider entering at the axis\'s maximum outward rate). It is an upper bound only if every one of those can hold simultaneously with the others, which is asserted, not proved. FALSIFIER: rs.confine.beyondBound counts frames past soft line + MARGIN. A non-zero beyondBound means the bound is not a bound.',
        divergenceSweep: 'ASSUMPTION: 2.02 m is the worst divergence in the box. It is a grid measurement with a published convergence series (2 m -> 0.05 m local refinement), not a supremum. The series is still climbing at the finest grid (1.99 -> 2.02), so the true supremum is >= 2.02 and the honest reading is "about 2 m, half the ceiling", not "exactly 2.02". Falsified by RS-05 reading above 4, or by a denser sweep exceeding it.',
        apronIsNotAStop: 'NOT A CLAIM that the rider stops inside the apron. APRON is the closed-form stopping distance on FLAT ground at the lowest drag the rider can choose; this course keeps descending past the finish and a rider holding boost never stops at all. The claim is only that the mountain gets the whole of that distance before a barrier acts.',
        ceil3Policy: 'NOT a derivation: NY_FLOOR = 0.5 is a policy line. What is derived from it is the consequence — the delivered horizontal, the degraded firmness, and the fraction of the box where it binds (see ceilAccel3D).',
      },
      // ---------------------------------------------------------------------
      // WHAT COUNTS AS EVIDENCE HERE, and what does not.
      // ---------------------------------------------------------------------
      evidence: 'The only instrument in this lane this module did not write is harness/run-runner.mjs, and config.measured.gateSuite carries what it reported. sandbox/run-structure/A/selftest.mjs is a SELF-AUTHORED instrument: it drives the layers no gate reaches (the lateral wall, the return branch, dt != 1/60, staged starts) and prints numbers, and those numbers are useful, but its pass COUNT is not evidence of anything and this file no longer cites one. Cycle 5 quoted "79/79 checks, 82/82 with --measure" as if a self-written test passing its own assertions were a result; it is not, and nothing in the gate suite touches it. The alternative was to fold those drives into harness/run-runner.mjs as real probes, and that was REJECTED on principle: the harness is the gate law for a blind gauntlet, and a candidate editing the law to admit its own evidence is the exact conflict of interest the blind protocol exists to prevent. If those probes belong in the suite, the harness owner should add them, not this module.',
    },
  };

  // ---- corridor centre + its exact derivative, cached on a 10 m grid and
  //      LERPED (header 3.7) ----
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
  // g_vec = (0, -G, 0). The horizontal pair is the pull the ground applies.
  function tangentGravity(n) {
    const gdn = -G * n[1];
    return [-gdn * n[0], -G - gdn * n[1], -gdn * n[2]];
  }

  // THE ALLOWANCE (header 3.2). p = signed distance past the soft line
  // (negative inside). Returns the fastest OUTWARD rate permitted there:
  // positive inside (a braking envelope reaching zero exactly at the line),
  // negative outside (a mirrored return requirement reaching the line at rest).
  // The return requirement is capped at the axis's own W so the corridor can
  // never demand a speed physics itself forbids.
  function allowOutward(p, A, W, dt) {
    if (p <= 0) return -A * dt + Math.sqrt(A * A * dt * dt + 2 * A * (-p));
    return -Math.min(W, Math.sqrt(2 * A * p));
  }

  // Inward acceleration this boundary demands: exactly the excess of the
  // outward rate over the allowance, and nothing else. Never negative — a
  // boundary can hold, it can never push a rider away from itself.
  function demand(p, w, A, W, dt) {
    const excess = w - allowOutward(p, A, W, dt);
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
      outOfBounds: false,     // GEOMETRY: the contract predicate (header 1.2)
      // ---- run presentation ----
      outOfBoundsAxis: null,  // 'lateral' | 'up' | 'down' | null
      stage: 'countdown',     // 'countdown' | 'running' | 'finished'
      countdown_s: COUNTDOWN_S,
      light: 'red',           // 'red' | 'set' | 'go'
      gateOpen: false,
      gateZ: null,            // where the gate physically is (null = none: the
                              // rider was staged past zStart, header 2)
      rollingStart: false,    // staged past zStart: the run was already on
      defendUpZ: zStart,      // the up-course boundary the back-stop defends
      _staged: false,         // the gate decision is made once, on step 1
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
        active: false,          // THIS MODULE WROTE VELOCITY this frame
        depth_m: 0,             // how far past the nearest soft line, this frame
        accel_mps2: 0,          // 3-D magnitude applied this frame
        peakBerm_mps2: 0,       // largest berm top-up actually applied
        terrainPull_mps2: 0,    // the ground's own inward pull, this frame
        bankTotal_mps2: 0,      // terrain + berm, this frame
        peakDemand_mps2: 0,     // largest boundary demand BEFORE the ceilings
        peakApplied_mps2: 0,    // largest 3-D applied, always <= A_CEIL3
        peakAppliedH_mps2: 0,   // largest horizontal applied, always <= A_HCEIL
        peakDepth_m: 0,
        peakOffset_m: 0,        // widest line the rider has taken
        // THE HEADLINE COUNTER (header 1.3): writes while the rider is inside
        // the contract's own in-bounds set, outside the ready phase. Zero by
        // the proof in 3.1; measured here so nobody has to trust the proof.
        inBoundsWriteFrames: 0,
        inBoundsImpulse_mps: 0,
        worstInBoundsAccel_mps2: 0,
        // one counter per LAYER, so a reader can tell which one fired
        bermFrames: 0,          // berm top-up (lateral, grounded)
        wallFrames: 0,          // LATERAL brake branch  (inside the soft line)
        limitFrames: 0,         // LATERAL return branch (past the soft line)
        runoutFrames: 0,        // down-course layer, gate open (the run-out)
        backstopFrames: 0,      // up-course layer
        gateFrames: 0,          // the closed gate held the rider
        // THE START GATE'S vel[0] WRITE, disclosed as a number and not only in
        // prose (config.derivation.startGateWritesVx). NO GATE IN THE SUITE
        // MEASURES THIS: RS-09 watches down-course drift, RS-06/RS-10 watch
        // position and heading, RS-11 excludes the ready phase. These counters
        // are the only measurement of it and they are SELF-REPORTED.
        gateVxWriteFrames: 0,
        gateMaxVxWrite_mps: 0,   // largest single-frame |d vel[0]| from the gate
        gateVxImpulse_mps: 0,    // total |d vel[0]| the gate has applied
        gateMaxDsdtWrite_mps: 0, // the gate's change to ds/dt: must stay ~0
        ceilFrames: 0,          // the horizontal ceiling A_HCEIL actually bound
        ceil3Frames: 0,         // the 3-D policy clamp A_CEIL3 actually bound
        ceil3WorstShortfall_mps2: 0,  // largest horizontal the clamp cost, m/s^2
        beyondBound: 0,         // frames past a containment bound (want 0)
        // THE FALSIFIERS for the two assumptions the inertness proof rests on
        // (config.derivation.assumptions). Measured every frame, before any
        // write, from the rider physics just handed back.
        maxHorizSpeed_mps: 0,   // largest |(vx, vz)| this module has ever seen
        overCapFrames: 0,       // ... frames where that exceeded V_CAP  (want 0)
        maxLateralRate_mps: 0,  // largest |ds/dt| this module has ever seen
        overLatRateFrames: 0,   // ... frames where that exceeded W_LAT  (want 0)
        oobFrames: 0,           // frames the rider was geometrically out of bounds
        activeFrames: 0,
        totalFrames: 0,
        activeFraction: 0,
        // WHAT THE CORRIDOR COST THE RIDER, in units that are not chaotic.
        // Finish times are (header 3.8). Impulse and energy are not.
        impulse: { berm: 0, wall: 0, limit: 0, runout: 0, backstop: 0, gate: 0 },
        energyRemoved_m2s2: 0,  // sum of -min(0, v . dv): specific KE taken out
        energyAdded_m2s2: 0,    // sum of  max(0, v . dv): specific KE put in
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
      // ---- the banked award, in full (header 6) ----
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
        inBoundsWriteFrames: rs.confine.inBoundsWriteFrames,
        inBoundsImpulse_mps: +rs.confine.inBoundsImpulse_mps.toFixed(4),
        worstInBoundsAccel_mps2: +rs.confine.worstInBoundsAccel_mps2.toFixed(4),
        peakOffset_m: +rs.confine.peakOffset_m.toFixed(1),
        peakApplied_mps2: +rs.confine.peakApplied_mps2.toFixed(2),
        peakAppliedH_mps2: +rs.confine.peakAppliedH_mps2.toFixed(2),
        peakBerm_mps2: +rs.confine.peakBerm_mps2.toFixed(2),
        bermFrames: rs.confine.bermFrames,
        wallFrames: rs.confine.wallFrames,
        limitFrames: rs.confine.limitFrames,
        runoutFrames: rs.confine.runoutFrames,
        backstopFrames: rs.confine.backstopFrames,
        gateFrames: rs.confine.gateFrames,
        gateVxWriteFrames: rs.confine.gateVxWriteFrames,
        gateMaxVxWrite_mps: +rs.confine.gateMaxVxWrite_mps.toFixed(4),
        gateVxImpulse_mps: +rs.confine.gateVxImpulse_mps.toFixed(4),
        gateMaxDsdtWrite_mps: rs.confine.gateMaxDsdtWrite_mps,
        ceilFrames: rs.confine.ceilFrames,
        ceil3Frames: rs.confine.ceil3Frames,
        ceil3WorstShortfall_mps2: +rs.confine.ceil3WorstShortfall_mps2.toFixed(3),
        maxHorizSpeed_mps: +rs.confine.maxHorizSpeed_mps.toFixed(3),
        overCapFrames: rs.confine.overCapFrames,
        maxLateralRate_mps: +rs.confine.maxLateralRate_mps.toFixed(3),
        overLatRateFrames: rs.confine.overLatRateFrames,
        beyondBound: rs.confine.beyondBound,
        oobFrames: rs.confine.oobFrames,
        maxSelfPosDelta_m: rs.confine.maxSelfPosDelta_m,
        impulse_mps: Object.fromEntries(Object.entries(rs.confine.impulse)
          .map(([k2, v]) => [k2, +v.toFixed(3)])),
        energyRemoved_m2s2: +rs.confine.energyRemoved_m2s2.toFixed(2),
        energyAdded_m2s2: +rs.confine.energyAdded_m2s2.toFixed(2),
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

    // --- landing ledger (header 5): open on the airborne -> grounded edge ---
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
  // position, heading, or any physics or trick flag. See header 3.7 for the
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

    // --- THE FALSIFIERS. The inertness identity of header 3.1 and the margin
    //     bound of 3.5 both rest on |v_horizontal| <= V_CAP and |ds/dt| <= W_LAT
    //     AT THE INSTANT THIS MODULE MEASURES. Those are assumptions about the
    //     accepted physics module plus this module's own airborne writes, not
    //     theorems (config.derivation.assumptions). Measure them, every frame,
    //     before anything is written, so a violation is visible rather than
    //     silently invalidating the proof. ------------------------------------
    const vHoriz = Math.hypot(ph.vel[0], ph.vel[2]);
    if (vHoriz > c.maxHorizSpeed_mps) c.maxHorizSpeed_mps = vHoriz;
    if (vHoriz > V_CAP + 1e-9) c.overCapFrames++;
    const sRateAbs = Math.abs(sRate);
    if (sRateAbs > c.maxLateralRate_mps) c.maxLateralRate_mps = sRateAbs;
    if (sRateAbs > W_LAT + 1e-9) c.overLatRateFrames++;

    // --- rs.outOfBounds is GEOMETRY (header 1.2): the contract predicate, and
    //     nothing about what this module did. -------------------------------
    const oobLat = sAbs > W_WALL;
    const oobDown = z > zFinish;
    const oobUp = z < zStart;
    rs.outOfBounds = oobLat || oobDown || oobUp;
    rs.outOfBoundsAxis = oobLat ? 'lateral' : oobDown ? 'down' : oobUp ? 'up' : null;
    if (rs.outOfBounds) c.oobFrames++;
    // the exact set RS-10 measures, minus the ready phase (header 1.3)
    const inContract = !rs.outOfBounds && rs.phase !== 'ready';

    // layer starts, recomputed from the LIVE dt so the inertness identity of
    // header 3.3 holds at any step size
    const lSoft = W_WALL + span(A_TRACK, W_LAT, dt);
    // the apron is a fixed length of mountain, but it must never be SHORTER
    // than the inertness minimum, or a large dt would let the run-out push a
    // rider who is still on the course side of the finish line
    const zSoftDown = zFinish + Math.max(APRON, span(A_TRACK, W_Z, dt));
    const zSoftUp = rs.defendUpZ - span(A_TRACK, W_Z, dt);

    let aIn = 0;        // inward (toward the centreline) lateral acceleration
    let aZ = 0;         // down-course acceleration, +ve = down-course

    // ---- LAYER 1. BERM: the terrain's own bank, topped up to g/2 -----------
    //      Grounded only — a berm is ground. Starts AT the contract corridor
    //      edge, so it can never touch an in-bounds rider (header 1.1).
    let n = null;
    if (ph.onGround && sAbs > W_WALL) {
      n = normalAt(x, z);
      const gt = tangentGravity(n);
      // the ground's own inward pull, in the corridor's lateral coordinate
      const terrIn = -out * (gt[0] - k * gt[2]);
      const q = clamp((sAbs - W_WALL) / (lSoft - W_WALL), 0, 1);
      const berm = q * q * Math.max(0, A_BERM_MAX - terrIn);
      c.terrainPull_mps2 = terrIn;
      c.bankTotal_mps2 = terrIn + berm;
      if (berm > 0) {
        aIn += berm;
        c.bermFrames++;
        c.impulse.berm += berm * dt;
        if (berm > c.peakBerm_mps2) c.peakBerm_mps2 = berm;
      }
    }

    // ---- LAYERS 2 & 3. WALL (brake) and LIMIT (return), one allowance ------
    const pLat = sAbs - lSoft;
    const dLat = demand(pLat, sRate, A_TRACK, W_LAT, dt);
    if (dLat > 0) {
      aIn += dLat;
      if (pLat > 0) { c.limitFrames++; c.impulse.limit += dLat * dt; }
      else { c.wallFrames++; c.impulse.wall += dLat * dt; }
      if (dLat > c.peakDemand_mps2) c.peakDemand_mps2 = dLat;
    }
    if (pLat > 0) {
      c.depth_m = pLat;
      if (pLat > c.peakDepth_m) c.peakDepth_m = pLat;
      if (sAbs > lSoft + MARGIN_LAT) c.beyondBound++;
    }

    // ---- down-course: the closed gate, or the run-out past the finish ------
    // While the gate is closed its soft line is the gate itself (p = 0 at the
    // staged position), so the field removes exactly the down-course rate the
    // rider has. Once it drops, the run-out takes over one apron past zFinish.
    const softDown = gateZ === null ? zSoftDown : gateZ;
    const pDown = z - softDown;
    const dDown = demand(pDown, zRate, A_TRACK, W_Z, dt);
    if (dDown > 0) {
      aZ -= dDown;
      if (gateZ !== null) { c.gateFrames++; c.impulse.gate += dDown * dt; }
      else { c.runoutFrames++; c.impulse.runout += dDown * dt; }
      if (dDown > c.peakDemand_mps2) c.peakDemand_mps2 = dDown;
    }
    if (pDown > 0) {
      c.depth_m = Math.max(c.depth_m, pDown);
      if (gateZ === null && pDown > MARGIN_Z) c.beyondBound++;
    }

    // ---- up-course back-stop (outward is -z), defending the run's own start -
    const pUp = zSoftUp - z;
    const dUp = demand(pUp, -zRate, A_TRACK, W_Z, dt);
    if (dUp > 0) {
      aZ += dUp;
      c.backstopFrames++;
      c.impulse.backstop += dUp * dt;
      if (dUp > c.peakDemand_mps2) c.peakDemand_mps2 = dUp;
    }
    if (pUp > 0) {
      c.depth_m = Math.max(c.depth_m, pUp);
      if (pUp > MARGIN_Z) c.beyondBound++;
    }

    if (aIn === 0 && aZ === 0) {
      c.activeFraction = c.activeFrames / c.totalFrames;
      return;
    }

    // ---- assemble the world-space correction (exact solve, header 3.7) -----
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

    // ---- ceiling 2: the 3-D POLICY CLAMP. The module refuses to lift as if
    //      the ground were steeper than NY_FLOOR = 0.5 (60 deg), so it never
    //      writes more than 2*A_HCEIL in 3-D magnitude. It BINDS wherever
    //      n_y < 0.5, which includes ground inside the containment box (min
    //      n_y there is 0.4533), and the cost when it binds is a shortfall in
    //      the delivered horizontal — recorded, not hidden. A shortfall only
    //      slows a return; it can never push the rider outward.
    let am = Math.hypot(ux, uy, uz);
    if (am > A_CEIL3) {
      const hBefore = Math.hypot(ux, uz);
      const f = A_CEIL3 / am; ux *= f; uy *= f; uz *= f; am = A_CEIL3;
      c.ceil3Frames++;
      const lost = hBefore - Math.hypot(ux, uz);
      if (lost > c.ceil3WorstShortfall_mps2) c.ceil3WorstShortfall_mps2 = lost;
    }

    // ---- the ONLY write this module makes, with pos diffed around it -------
    const px = ph.pos[0], py = ph.pos[1], pz = ph.pos[2];
    const vx0 = ph.vel[0], ds0 = (ph.vel[0] - k * ph.vel[2]) * out;
    // specific work this write does on the rider (m^2/s^2 = J/kg), signed:
    // negative is energy taken out of the run, positive is energy put in.
    const work = ph.vel[0] * ux * dt + ph.vel[1] * uy * dt + ph.vel[2] * uz * dt;
    if (work < 0) c.energyRemoved_m2s2 -= work; else c.energyAdded_m2s2 += work;
    ph.vel[0] += ux * dt; ph.vel[1] += uy * dt; ph.vel[2] += uz * dt;
    const moved = Math.abs(ph.pos[0] - px) + Math.abs(ph.pos[1] - py) + Math.abs(ph.pos[2] - pz);
    c.selfPosDelta_m = moved;
    if (moved > c.maxSelfPosDelta_m) c.maxSelfPosDelta_m = moved;

    // ---- the START GATE's vel[0] write, counted (derivation.startGateWritesVx).
    //      On a gate frame the gate is the only down-course source, and the
    //      coordinate solve turns its a_z into k*a_z of a_x: that is the whole
    //      of the vel[0] change, and gateMaxDsdtWrite_mps is the check, because
    //      the skew term is exactly the one that leaves ds/dt alone.
    if (gateZ !== null && dDown > 0) {
      const dvx = Math.abs(ph.vel[0] - vx0);
      if (dvx > 0) {
        c.gateVxWriteFrames++;
        c.gateVxImpulse_mps += dvx;
        if (dvx > c.gateMaxVxWrite_mps) c.gateMaxVxWrite_mps = dvx;
      }
      const dds = Math.abs((ph.vel[0] - k * ph.vel[2]) * out - ds0);
      if (dds > c.gateMaxDsdtWrite_mps) c.gateMaxDsdtWrite_mps = dds;
    }

    // ---- the in-bounds authority counter (header 1.3). Proven 0 by 3.1;
    //      measured here so the proof is not the only evidence.
    if (inContract) {
      c.inBoundsWriteFrames++;
      c.inBoundsImpulse_mps += am * dt;
      if (am > c.worstInBoundsAccel_mps2) c.worstInBoundsAccel_mps2 = am;
    }

    const dv = am * dt;
    if (dv > c.maxSelfVelDelta_mps) c.maxSelfVelDelta_mps = dv;
    if (am > c.peakApplied_mps2) c.peakApplied_mps2 = am;
    const amh = Math.hypot(ux, uz);
    if (amh > c.peakAppliedH_mps2) c.peakAppliedH_mps2 = amh;
    c.accel_mps2 = am;
    c.active = true;
    c.activeFrames++;
    c.activeFraction = c.activeFrames / c.totalFrames;
  }

  // ------------------------------------------------------------------ step
  function step(rs, physState, trickState, dt) {
    const ph = physState;
    if (!ph || !dt) return rs;
    rs._t += dt;

    // ---------- ready: held at the gate, clock reads 0 ----------------------
    if (rs.phase === 'ready') {
      // WHERE THE GATE IS, decided once on the first step this module ever sees
      // (header 2). A start gate is a physical object at the TOP of the course:
      //   * staged at or behind zStart -> the gate is at the rider. AT the
      //     rider, not at zStart: a gate 40 m down-course of a staged rider
      //     does not hold them, it catches them, and the slide into it is
      //     exactly the drift RS-09 is right to call a failure.
      //   * staged PAST zStart -> there is no gate down there to hold anyone.
      //     The rider is already on the course, so the run is already on: the
      //     clock starts on this frame and the ready phase is empty.
      // The up-course back-stop defends min(zStart, stagedZ) for the same
      // reason, so it can never be a wall down-course of a staged rider.
      if (!rs._staged) {
        rs._staged = true;
        rs.rollingStart = ph.pos[2] > zStart;
        if (rs.rollingStart) { rs.countdown_s = 0; rs.defendUpZ = zStart; }
        else { rs.gateZ = ph.pos[2]; rs.defendUpZ = Math.min(zStart, ph.pos[2]); }
      }
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.gateOpen = rs.countdown_s <= 0;
      rs.light = rs.countdown_s > COUNTDOWN_S / 3 ? 'red' : rs.countdown_s > 0 ? 'set' : 'go';
      rs.progress = 0;
      if (!rs.gateOpen && rs.gateZ !== null) {
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
