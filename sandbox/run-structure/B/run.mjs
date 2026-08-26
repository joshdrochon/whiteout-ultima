// ============================================================================
// run-structure lane — run.mjs   (cycle 5, candidate B)
//
// Start gate, race clock, checkpoint stream, finish line, results card,
// restart, and a three-layer CORRIDOR (berm -> wall -> return) built as an
// ENERGY BUDGET: the corridor is a potential well, and the only force applied
// is the one that removes the rider's excess outward kinetic energy. Nothing
// stronger, ever, and nothing at all while the rider is where the contract
// says they belong.
//
// Pure JS, deterministic. No Date, no Math.random, no globals.
//
// ============================================================================
// 0. WHAT THIS MODULE WRITES, EXHAUSTIVELY
//
//   physState.vel[0..2] — and only by adding an acceleration * dt whose
//   horizontal magnitude never exceeds A_HMAX (§3.7) and whose 3-D magnitude
//   never exceeds A_3D_MAX.
//
//   Nothing else. It never writes physState.pos (diffed around its own write
//   block every frame and published as rs.confine.maxSelfPosDelta_m — a
//   computed number, not an asserted zero), never physState.heading, spinDeg,
//   flipDeg, onGround, airTime, landing, charge or boostMeter, and never any
//   field of the trick state. It reads both.
//
//   AND, THE CENTRAL CLAIM OF THIS CANDIDATE: it writes NOTHING AT ALL while
//   the rider is in bounds. Not a berm, not a nudge, not a "shaping" force.
//   In bounds is the contract's own set — |x - courseCenterX(z)| <= halfWidth
//   and z in [zStart, zFinish]. rs.confine.inBoundsWriteFrames counts every
//   violation of that claim and is 0 on every drive in the gate suite and in
//   selftest.mjs. §3.3 shows why it is 0 by construction rather than by luck.
//
// ---------------------------------------------------------------------------
// 0a. WHAT CHANGED FROM THE CYCLE-4 WINNER (candidate A), AND WHY
//
//   This file is a rewrite of A's design against A's own critique. Five
//   findings were accepted verbatim; each is answered here and the answer is
//   the design, not a comment.
//
//   (1) A overloaded rs.outOfBounds. It raised the contract flag on every
//       frame it wrote anything, including berm frames at |s| = 60 — an
//       in-bounds rider whose HUD read out-of-bounds — and, as a side effect,
//       deleted 174 frames from the exact set RS-10 measures.
//       HERE: rs.outOfBounds is PURE GEOMETRY, computed from the contract's
//       own definition and nothing else, on every frame in every phase. The
//       "this module wrote something" signal is rs.confine.active, which is
//       what it was always for. Consequence, stated because it cuts against
//       me: the flag is now true for the whole run-out (a rider past zFinish
//       IS outside [zStart, zFinish]) and true during the ready phase behind
//       the start line, so RS-06 now measures its per-frame position jump over
//       far MORE frames than it did for A — thousands instead of a handful.
//       Measured, that jump is the rider's own travel: RS-06 reads 0.465 m
//       against a 2 m bar (A reported 0.057 m across a much smaller measured
//       set), and this module's OWN positional write — which the runner
//       measures exactly, by snapshotting pos around run.step — is 0.
//
//   (2) A's berm fired from |s| = 55, deep inside the 120 m contract corridor,
//       and its residual in-bounds velocity write was real. A's critic said
//       the lane owner has to decide that question explicitly rather than
//       inherit it. DECIDED, and the decision is the opposite of A's: no layer
//       of this corridor may act on an in-bounds rider. The berm's inner edge
//       is halfWidth, exactly, with a C1 ramp so it is inert AND has zero
//       gradient there. §3.6 records the rejected alternative and what it cost.
//
//   (3) A's A_TRACK = A_HCEIL - DRIVE_MAX - g/2 "collapses to g" only because
//       A_HCEIL was defined as A_STOP + g/2 = DRIVE_MAX + g + g/2. A
//       restatement of definitions, not a derivation.
//       HERE the arrow runs the other way and starts outside the module: the
//       MEASURED safe room fixes each layer's firmness (§3.4), and the write
//       ceiling is a CONSEQUENCE of the firmness (§3.7). Nothing is derived
//       from the ceiling; the ceiling is derived from the mountain.
//
//   (4) A's top-level `await import` of the physics module reported a silent
//       fallback to a pinned copy in config and moved on.
//       HERE the live module is read, every pinned anchor is CHECKED against
//       it, and a mismatch THROWS at import time with the offending names and
//       both values (§1a). Unreachable is not silent either: it sets
//       config.physicsAnchor.verified = false, attaches a warning string, and
//       repeats that warning on every rstate as rs.physicsAnchorWarning.
//
//   (5) A cited BRAKE_DECEL = 1.7 from the physics module inside a block
//       arguing about citation discipline, without reading it.
//       HERE BRAKE_DECEL is in PINNED, read from the live module, verified
//       like every other anchor, and used in the rejection argument it appears
//       in (§3.4, rejected firmnesses).
//
//   One finding is answered outside this file: "add a probe staged behind the
//   line to the drives that exercise the corridor, not only the countdown".
//   The harness is not mine to edit, so sandbox/run-structure/B/selftest.mjs
//   drives the corridor from BEHIND the gate at three staging positions, and
//   at three step sizes, and reports numbers. §6 lists what it covers.
//
// ---------------------------------------------------------------------------
// 1. NO STEERING AUTHORITY
//
//   RS-10 (HARD) measures the yaw this module's step adds while the rider is
//   in bounds; the bar is 5 deg/s and a previous cycle's candidate reached 9/9
//   by writing st.heading toward the fall line on 98.8% of frames. This module
//   measures 0.00 deg/s, and it measures 0.00 for the strongest possible
//   reason: `heading` does not appear on the left-hand side of an assignment
//   anywhere in this file. Nor does pos. The module cannot steer because it
//   has no code that could.
//
//   THE INDIRECT CHANNEL, DISCLOSED RATHER THAN DENIED. The accepted physics
//   module copies velocity yaw onto board heading on a CLEAN LANDING. So a
//   LATERAL velocity write made while the rider is airborne can become a
//   heading change at the next touchdown, without ever touching heading. This
//   module's airborne writes are the wall and the return branch only — a
//   corridor that switches off when the rider jumps is not a corridor — and
//   the berm is grounded-only because a berm is ground. The channel's size is
//   bounded by the same ceiling as everything else: one frame at A_HMAX is
//   1.09 m/s of lateral velocity, which at 33 m/s is 1.9 deg of heading at the
//   next clean landing. MEASURED on RS-10's own 120 s wall-riding probe:
//   0 airborne write frames out of 7,200 (the runner publishes it as
//   _airborneVelWriteFrames), so on that probe the channel carries nothing.
//   selftest.mjs §2 opens it deliberately and measures what comes through.
//
//   And note what CANNOT happen here that happened to A: because rs.outOfBounds
//   is geometry now, this module does not remove a single frame from the set
//   RS-10 measures. The gate sees every frame the contract says it should.
//
// ---------------------------------------------------------------------------
// 1a. PHYSICS ANCHORS
//
//   Every acceleration in this file is a function of constants the ACCEPTED
//   physics module publishes, so a physics retune moves this corridor with it.
//   Resolution order:
//     1. env.physicsDefaults, if the host injects it (no path, no coupling).
//     2. the live module at ../../../src/physics/physics.mjs.
//     3. the PINNED copy below.
//   Whatever is found is CHECKED against PINNED anchor by anchor. A mismatch
//   throws immediately, naming every field and both values, because a corridor
//   derived from stale constants is worse than one that refuses to load. An
//   unreachable module is a weaker failure — the pinned values may still be
//   right — so it warns loudly instead of throwing: config.physicsAnchor
//   .verified = false, config.physicsAnchor.warning, and rs.physicsAnchorWarning
//   on every single rstate.
//
//   The residual fragility is real and is not hidden: option 2 is a relative
//   path, so moving this file without moving the physics module drops to
//   option 3. That is exactly the case `verified: false` exists to make loud.
//
// ---------------------------------------------------------------------------
// 2. PHASES, THE START GATE, AND THE CHECKPOINT STREAM
//
//   phase: 'ready' -> 'running' -> 'finished'            (contract field)
//
//   ready     The rider is behind the start gate and HELD there; clock reads
//             0. rs.light runs red -> set -> go over COUNTDOWN_S.
//   running   Entered when the gate drops. The clock starts AT THE DROP: the
//             rider is stationary at t = 0 and every metre is on the clock.
//   finished  Entered on the first step at or past zFinish. The card is
//             assembled once and deep-frozen; the clock stops; the corridor
//             keeps holding so a rider with boost pinned coasts to a stop in
//             the run-out instead of sailing onto the backdrop.
//
//   ONE RULE DECIDES THE GATE, with no branch: YOU ARE IN 'ready' IF AND ONLY
//   IF YOU ARE BEHIND THE GATE LINE. The gate line is a physical object at the
//   top of the course, and the rider is staged AT it:
//
//       gateZ = clamp(first observed z, zSoftUp, zStart)
//
//   decided once, on the first step this module ever sees. A rider staged
//   DOWN-COURSE of zStart is already past the gate, so 'ready' is empty and
//   the clock starts on frame 1 — not a special case, the same rule read the
//   other way. A rider staged behind zStart gets the gate at their own feet,
//   NOT at zStart: a gate 40 m down-course of a staged rider does not hold
//   them, it catches them, and they spend the countdown sliding into it, which
//   is exactly the drift RS-09 is right to call a failure.
//
//   THE GATE IS A BOUNDARY, NOT A PIN. It is the same energy law as every
//   other layer (§3.2) with its line at gateZ, so at p = 0 the allowance is 0
//   and the field removes exactly the down-course rate the rider has, never
//   more, and never touches the other two axes except through the corridor
//   Jacobian (§3.8). Holding a rider by writing their position, or by zeroing
//   all three velocity components, is a physics write on an ordinary frame and
//   it re-rolls the run it is supposed to be timing.
//
//   WHY THE GATE MUST STAND AT THE RIDER, measured on the harness itself: the
//   probe drive is a closed-loop seeker staged at z = 15 with 6 m/s. A gate
//   placed at zStart for everyone would catch that rider 15 m into the course,
//   stop them dead, and hand them back at rest on a slope; the seeker then
//   spins and boosts back UP-course before recovering. The rule above makes
//   that rider's run bit-identical to the same drive with no run module
//   attached, which is the only acceptable answer for a module whose job is to
//   TIME a run, not to change it.
//
//   THE CHECKPOINT STREAM. Everything the card reports about the shape of the
//   run comes from one append-only log, rs.stream, written by exactly one
//   function (`emit`). Entries: 'staged', 'go', 'checkpoint' x N, 'finish'.
//   results() FOLDS that log rather than keeping a parallel set of counters,
//   so the splits on the card and the stream a HUD renders cannot drift apart
//   — there is only one of them. rs.streamCursor lets a consumer read
//   incrementally without re-scanning. Checkpoints are at even fractions of
//   the course; the count is a CHOICE and is labelled one.
//
// ---------------------------------------------------------------------------
// 3. THE CORRIDOR
//
//   3.1 WHY IT EXISTS (measured, not assumed)
//
//   Physics ground is an analytic function defined everywhere. The RENDERED
//   mesh is a per-LOD approximation of it. Measured with the run-runner's own
//   divergence probe (|analytic - bilinear across the worst LOD cell the
//   player can be near|), swept over z in [-170, 2570]:
//
//     worst gap at |s| =   120   130   140   145   150   155   160   200
//                  (m)    0.95  1.06  1.36  1.45  1.95  1.92  2.46  3.69
//
//     and, longitudinally, the fine-LOD region ENDS: the probe's cell size
//     steps from 15.6 m to 83.3 m at z = -250 and z = 2750, and the gap steps
//     with it — 0.67 m at z = -250 against 11.86 m at z = -300; 0.52 m at
//     z = 2750 against 9.63 m at z = 2760. That is a cliff, not a slope.
//
//   RS-05's ceiling is 4 m. A rider past it is visibly falling through the
//   world. AND IT IS NOT ONLY AN ADVERSARY WHO GETS THERE: the harness's own
//   competent probe drive, with no run module attached, keeps riding after the
//   finish and is out on the 83 m backdrop tiles within half a minute. The
//   corridor's job is to make a stated region unreachable.
//
//   3.2 THE ONE LAW IS AN ENERGY BUDGET
//
//   Treat each boundary as a potential barrier. A barrier of firmness A can do
//   A per metre of specific work (m^2/s^2 per m) on a rider crossing toward
//   it, so over a remaining gap it holds a specific potential
//
//       PHI(gap) = A * gap                                  [m^2/s^2]
//
//   and the rider carries specific outward kinetic energy
//
//       E(w) = w^2 / 2,     w = outward rate across the boundary.
//
//   THE ENTIRE CORRIDOR IS ONE INEQUALITY: E(w) <= PHI(gap). The rider may
//   move outward as fast as they like as long as the well can still absorb
//   them. Solving for w gives the allowance
//
//       w_allow = sqrt(2 * A * gap)
//
//   and the field applies exactly the acceleration that removes the surplus
//   energy and no more:
//
//       a_inward = max(0, w - w_allow) / dt
//
//   The energy removed by that write is (w^2 - w_allow^2)/2 = E - PHI: the
//   surplus itself, exactly. Nothing is removed from a rider inside budget.
//   The push is as strong as it must be and no stronger — which is the whole
//   design brief, expressed as one line of algebra.
//
//   TWO ENERGIES, AND THEY ARE NOT THE SAME NUMBER. rs.confine reports both
//   and they must not be read as a matching pair:
//     energySurplus_m2s2 is the sum of E - PHI above — the surplus IN THE
//       BOUNDARY'S OWN one-dimensional coordinate, which is what the budget
//       targets and what the law promises to remove.
//     energyRemoved_m2s2 / energyAdded_m2s2 are the signed specific work the
//       write actually does on the full 3-D velocity, -v.dv and +v.dv. They
//       differ from the surplus — measured, by up to 2.4x on a wall drive —
//       because the same correction also does work against the components the
//       budget says nothing about, and because a grounded correction is
//       lifted into the tangent plane (§3.7). Reporting only the first would
//       understate what the rider paid.
//
//   DISCRETE-SAFE, AND FOR THE SAME REASON. The rider is about to travel
//   w * dt further out before this module is consulted again, so the budget
//   must be evaluated against the gap they will have THEN:
//
//       w^2 / 2 = A * (gap - w * dt)
//     =>  w_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*gap)
//
//   so a rider who obeys the budget cannot overrun the barrier by braking one
//   step too late, at ANY dt — not merely at 60 Hz.
//
//   PAST THE LINE the same inequality reads with the sign flipped: the rider
//   is now inside the barrier and must be climbing back out fast enough to
//   arrive at the line at rest, w <= -sqrt(2 * A_out * depth). One continuous,
//   monotone function of the signed distance p past the line, zero exactly at
//   p = 0. Braking alone would only stop a rider going out FAST, not stop them
//   going out: between one clamp and the next the world adds up to A_HMAX * dt
//   of outward rate, so without the return branch the rider ratchets outward.
//   The return requirement is additionally capped at V_CAP, so the corridor can
//   never demand a speed the physics module's own clamp forbids.
//
//   3.3 WHY THE CORRIDOR IS PROVABLY INERT IN BOUNDS
//
//   Substituting gap = V_CAP^2/(2A) + V_CAP*dt into the discrete allowance:
//
//       w_allow = -A*dt + sqrt(A^2*dt^2 + V_CAP^2 + 2*A*V_CAP*dt)
//               = -A*dt + (A*dt + V_CAP)  =  V_CAP     exactly, any A, any dt
//
//   so SPAN(A, dt) = V_CAP^2/(2A) + V_CAP*dt is precisely the gap at which the
//   energy budget equals the largest kinetic energy physics permits to exist.
//   Put every layer's line one SPAN outside the contract boundary it defends
//   and the layer is inert AT AND INSIDE that boundary: no rider can be
//   outrunning the budget there, so the surplus is <= 0 and the field is
//   exactly 0. Recomputed every frame from the LIVE dt, so the proof does not
//   depend on the harness running at 60 Hz.
//
//   The berm is inert at the boundary too, by a different mechanism (its ramp
//   q^2 is zero with zero slope at |s| = halfWidth, §3.6).
//
//   That is what makes rs.confine.inBoundsWriteFrames == 0 a theorem rather
//   than an observation — and it also means RS-10 cannot distinguish this
//   corridor from an absent one. That evidence has to come from somewhere
//   else; §6 says where.
//
//   3.4 FIRMNESS IS MEASURED, NOT CHOSEN
//
//   A boundary is as soft as its room allows and no softer, because a softer
//   barrier is a gentler one. The room is a MEASUREMENT of this mountain.
//
//   SAFE REGION. The set where the mesh gap stays under D_SAFE = 2 m, i.e.
//   half of RS-05's 4 m ceiling. (D_SAFE is a CHOICE and the reason is stated:
//   the sweep is on a finite grid and can miss a local worst, so the module's
//   own guarantee is set at twice the headroom of the gate it has to pass. The
//   gap does not actually reach 4 m until |s| ~ 215.) Measured:
//
//       lateral    |s| <= 155      (box worst 1.92 m; 2.38 m at |s| <= 160)
//       up-course  z   >= -250     (structural: the fine-LOD edge)
//       down-course z  <= 2750     (structural: the fine-LOD edge)
//
//   LATERAL. Room from the contract corridor edge to the safe edge:
//   R_LAT = 155 - 120 = 35 m. The layer must fit its SPAN in it, plus the
//   one-frame slop of §3.5:
//
//       SPAN(A, DT_REF) + SLOP(DT_REF) <= R_LAT
//    => A_LATERAL = V_CAP^2 / (2 * (R_LAT - V_CAP*DT_REF - SLOP)) = 15.812
//
//   the SOFTEST firmness that fits. Its line lands at |s| = 154.986 and its
//   containment bound at 155.000 — the safe edge exactly, by construction.
//
//   DOWN-COURSE. Here the room is not the binding constraint: 350 m of it.
//   A finish line needs a RUN-OUT, and its length is the room the rider's own
//   drag law needs — the closed-form distance in which the accepted physics
//   module's longitudinal law a(v) = MU_BASE*g + LAMBDA_LONG*TUCK_DRAG*v
//   brings V_CAP to rest on flat ground, at the LOWEST drag the rider can
//   choose (tucked), which is the longest run-out any rider can need:
//
//       APRON = INTEGRAL(0..V_CAP) v dv / (F0 + L*v)
//             = (1/L) * (V_CAP - (F0/L) * ln(1 + L*V_CAP/F0))  =  165.244 m
//
//   Every symbol is a published physics constant. It is NOT a promise that the
//   rider stops inside it — this course keeps descending past the finish and a
//   rider holding boost never stops anywhere — it is the statement that the
//   mountain gets the whole of the rider's own stopping distance before a
//   barrier takes over. The firmness is then whatever makes a layer of that
//   length inert at zFinish, i.e. SPAN(A) = APRON:
//
//       A_LONGITUDINAL = V_CAP^2 / (2 * (APRON - V_CAP*DT_REF)) = 3.306
//
//   line at z = 2565.244, bound at 2565.258, clear of the fine-LOD edge by
//   184.7 m. CHECKED, not chosen.
//
//   UP-COURSE the back-stop inherits A_LONGITUDINAL, because up-course there
//   is nothing to run out INTO — the mountain climbs — so no apron can be
//   derived for it, and a boundary should not be softened past the point where
//   softness buys anything. Its span is therefore also 165.244 m, its line
//   z = -165.244 and its bound z = -165.258, which fits the 250 m of up-course
//   room with 84.7 m to spare. Fit CHECKED after the fact; had it not fit, the
//   firmness would have had to rise.
//
//   REJECTED FIRMNESSES, with their citations followed properly:
//     * A_STOP = DRIVE_MAX + g = 54.1 (the cycle-4 winner's lateral wall). It
//       is defensible as "cannot be outrun in principle", but it is 3.4x
//       firmer than the room requires, and firmer means a harder shove on a
//       player who leans on the wall. Also it mixes a full g into a HORIZONTAL
//       budget when no slope can pull sideways harder than g/2.
//     * BRAKE_DECEL = 1.7 m/s^2, read from the live physics module and
//       verified against PINNED (§1a) — "the rider's own brake authority".
//       Its span is 320 m, which puts the lateral bound at |s| = 440 where the
//       mesh gap is far past 4 m. A run-out is a barrier, not the rider
//       braking; a rider who declines to brake still has to be stopped.
//     * 4.5 m/s^2 from REFERENCE_BAR TN-08. That band (3-6) describes what a
//       BOARD can scrub, and picking a point inside it is taste. The physics
//       module's own published number is 1.7, so the citation and the code
//       disagree about the same quantity; neither is a corridor firmness.
//
//   3.5 THE CONTAINMENT BOUND
//
//   Because each layer is TRACKED (§3.7 shows the ceiling is large enough to
//   hold the envelope against the worst adversary), a rider on the budget
//   never crosses its line. Two things still let them past it:
//
//     * ONE UNSEEN FRAME. This module reads the rider AFTER physics has moved
//       them, so they can already be V_CAP*dt past a line the first time it is
//       seen. That term is inside SPAN, which is why SPAN carries it.
//     * ONE FRAME OF ADVERSE WORK. Between two clamps the world can add
//       A_ADVERSE*dt of outward rate, which carries the rider a further
//         SLOP(dt) = A_ADVERSE * dt^2 = 0.0137 m at 60 Hz.
//
//   Containment bound = line + SLOP. It is a BOUND, not a barrier: nothing is
//   placed there and nothing fires there. rs.confine.beyondBound counts frames
//   past it, and is 0 on every drive run so far.
//
//     lateral    line |s| = 154.986   bound |s| = 155.000
//     run-out    line z   = 2565.244  bound z   = 2565.258
//     back-stop  line z   = -165.244  bound z   = -165.258
//
//   CHECKED, NOT CHOSEN: worst mesh divergence over that whole box, on a
//   1.5 m x 2 m grid, is 1.92 m — inside the module's own 2 m guarantee and
//   less than half RS-05's 4 m ceiling — and the box lies wholly inside the
//   fine-LOD region, clear by 84.7 m up-course and 184.7 m down-course.
//
//   3.6 THE THREE LAYERS
//
//   BERM (soft, |s| in [120, 154.986], grounded only)
//     A berm is ground, so it acts only when ph.onGround; an airborne rider
//     does not feel a bank.
//
//     A slope's INWARD HORIZONTAL restoring acceleration is
//     g*sin(th)*cos(th) = (g/2)*sin(2*th), maximal at th = 45 deg and equal to
//     g/2 = 4.905 m/s^2. That is not a tuning choice, it is a ceiling: NO
//     SLOPE, however steep, can pull a rider sideways harder than g/2. So g/2
//     is the largest acceleration a berm may apply and still be honestly
//     called terrain.
//
//     MEASURED inward pull of the actual gully, in the corridor's own lateral
//     coordinate, both flanks, z = 0..2400 (m/s^2):
//
//       |s|       55    100   120   130   140   155
//       median   3.05   4.44  4.72  4.76  4.73  4.65
//       min      0.50   3.07  3.47  3.54  3.55  3.34
//       max      5.94   6.35  6.31  6.24  5.97  5.78
//
//     (The maxima exceed g/2 without contradicting the ceiling: the ceiling
//     bounds the horizontal magnitude of tangential gravity, and this
//     coordinate is s = x - centreX(z), so the projection picks up a factor up
//     to sqrt(1+k^2) = 1.32 where the centreline meanders hardest — measured
//     max |centreX'(z)| = 0.857 at z = 790.)
//
//     The mountain already does most of this job, and unevenly. So the berm
//     does not ADD a force — adding one would double a bank already near its
//     physical ceiling. It TOPS THE TERRAIN UP to the strongest bank a slope
//     can be:
//
//       a_berm = q^2 * max(0, g/2 - a_terrain_inward),
//       q      = clamp((|s| - halfWidth) / (lateralLine - halfWidth), 0, 1)
//
//     MEASURED over the berm band: peak top-up 1.535 m/s^2, at s = -154.5,
//     z = 450, where the mountain's own pull is 3.37. a_terrain_inward is
//     computed each frame from the SAME 0.05 m central-difference stencil the
//     physics module's default sampleNormal uses, so the berm measures the
//     surface physics is standing on, not an approximation of it.
//
//     THE INNER EDGE IS halfWidth, AND THAT IS A DECISION, NOT AN INHERITANCE.
//     The cycle-4 winner started its berm at |s| = 55, the render lane's tree
//     line — a real citation, and a nicer-feeling corridor, and 65 m of it
//     lies inside terrain the contract calls in bounds. Its critic called that
//     out and refused to settle it. Settled here, against the berm:
//
//       option                      in-bounds writes    what it buys
//       berm from the tree line 55  ~247 frames/run     a shaped racing line
//                                   (A's own figure)
//       berm from halfWidth 120     0, by construction  a corridor that only
//                                                       confines
//
//     The contract says a rider is to be corrected when |s| > halfWidth. A
//     force applied inside that is level design, not run structure, and this
//     lane does not own level design — the course-design lane will, and it
//     will want the berm as terrain, where it belongs, not as a velocity write
//     from the module that times the run. Cost of the decision, stated: the
//     transition from free riding to corrected riding now happens entirely
//     within 35 m instead of 100, so the corridor is firmer than A's for a
//     player who leans on it. That is the price of a zero.
//
//     q^2 is the lowest-order polynomial that is zero WITH ZERO SLOPE at the
//     inner edge (C1, never a step the rider can feel switch on) and 1 at the
//     wall line. The exponent is forced by those two conditions plus lowest
//     order; it is not a feel knob.
//
//     Overrule test: g/2 is 18.9% of the physics module's own lateral
//     acceleration ceiling A_LAT = 26 m/s^2, so a rider at full lock still
//     wins and can still take the flank. A berm shapes a line; it never takes
//     the turn.
//
//   WALL (the brake branch, |s| in [120, 154.986])
//     The energy budget at A_LATERAL. Expressed in corridor coordinates
//     (offset s across, progress z along) so it acts purely ACROSS: a rider
//     carving along it keeps every bit of their down-course speed. It cannot
//     pull a rider in — that is the berm's job — and by §3.3 it cannot act at
//     all until the rider is genuinely outrunning the room they have left.
//
//   RETURN (the mirrored branch, past any line)
//     Same law, sign flipped, at the same firmness. Counted per layer, never
//     pooled: limitFrames is the LATERAL return only, with runoutFrames,
//     backstopFrames and gateFrames separate, so "the wall fired" can never be
//     reported for a rider who was actually 130 m away being caught by the
//     run-out.
//
//   3.7 THE WRITE CEILINGS — a consequence of the firmnesses, not their source
//
//     A_ADVERSE = DRIVE_MAX + g/2 = 49.191 m/s^2 is the strongest outward
//       HORIZONTAL acceleration the world can give a rider: the accepted
//       physics module's boost law evaluated at rest (a first-order relaxation
//       toward V_BOOST with time constant TAU_BOOST, so DRIVE_MAX =
//       V_BOOST/TAU_BOOST = 44.286), aimed wherever the board points, plus the
//       steepest sideways pull any slope can apply.
//
//     To TRACK a boundary — hold the rider on the budget rather than merely
//     slow them — the module must deliver the envelope's own deceleration AND
//     cancel the adversary. The envelope demands at most A_LATERAL across and
//     A_LONGITUDINAL along, and those are orthogonal, while the adversary is a
//     single vector. So
//
//       A_HMAX = hypot(A_LATERAL, A_LONGITUDINAL) + A_ADVERSE = 65.344 m/s^2
//
//     is the horizontal ceiling, and it is EXACTLY sufficient: it is what
//     tracking costs, and one m/s^2 less would make the containment bound of
//     §3.5 a wish. The berm does not widen it, and the identity is worth
//     stating because it is not obvious: where the berm is at full strength
//     the ground+berm pull is g/2 INWARD, so the wall's share drops by g/2
//     exactly as the berm's rises, and berm + wall = A_LATERAL + DRIVE_MAX +
//     g/2 whatever the terrain does.
//
//     A_3D_MAX = A_HMAX / NY_MIN = 154.88 m/s^2 is the absolute 3-D bound on
//     anything this module writes. A grounded push must lie in the tangent
//     plane, so delivering h horizontally costs h/n_y of 3-D magnitude;
//     NY_MIN = 0.4219 is the MEASURED minimum surface n_y over |s| <= 160,
//     z in [-180, 2580] — a superset of the containment set — a 65.0 deg face
//     at s = -160, z = 874. By construction this can only bind on ground
//     steeper than anything in that set, so it is a guard, and
//     rs.confine.ceil3Frames says whether the guard ever fired.
//
//     GROUNDED CORRECTIONS RIDE THE SNOW. You cannot push a board into or out
//     of the ground, only along it. There is exactly one tangent-plane vector
//     whose horizontal shadow is the correction the budget asked for, and that
//     is the one applied: no authority is lost to a projection and none is
//     invented by a rescale. It also keeps the push out of the physics
//     module's magnitude-preserving grounded redirect, which would otherwise
//     launder a component pointed into the hill back out as forward speed — a
//     confiner that accidentally boosts. The horizontal ceiling is applied
//     BEFORE the tangent lift so the lift cannot smuggle authority in behind
//     it.
//
//   3.8 CORRIDOR COORDINATES
//
//     s = x - centreX(z) is the lateral offset (the coordinate every
//     divergence measurement and the render lane's own tree line are stated
//     in) and z is down-course progress. With k = centreX'(z),
//         ds/dt = vx - k*vz        dz/dt = vz
//     so a correction that must produce a given (d2s/dt2, d2z/dt2) has exactly
//     one horizontal solution:
//         az = d2z/dt2             ax = d2s/dt2 + k * az
//     The module solves that rather than decomposing onto corridor normal and
//     tangent unit vectors, which would deliver only 1/sqrt(1+k^2) of what it
//     asks for — 24% short where the course meanders hardest (k = 0.857) — the
//     kind of quiet slack that lets a guarantee be violated. A purely lateral
//     correction leaves dz/dt untouched by construction.
//
//     centreX is expensive in the real game (a scan across the corridor), so
//     it is cached: nodes every 10 m, LERPED between them, which is the
//     run-runner's own construction node for node. MEASURED error against the
//     harness centreline over z in [-300, 2900]: 2e-13 m — floating point, not
//     approximation. k is the exact derivative of that interpolant (the local
//     segment slope), so the coordinate system and its Jacobian cannot
//     disagree. (A 25 m nearest-node cache, which an earlier candidate used,
//     measures up to 10.33 m of centreline error — enough to fire a wall at an
//     in-bounds rider.)
//
//   3.9 WHAT IS NOT PROMISED
//
//     Confinement is not free and this module does not price it at zero by
//     assertion. rs.confine carries a per-layer impulse ledger (m/s), the
//     signed specific work of every write (energyRemoved/energyAdded,
//     m^2/s^2), and the surplus energy the budget actually found
//     (energySurplus_m2s2) — the quantity §3.2 says is the only thing being
//     removed. A player who leans on the wall pays properly for it, by design.
//
//     PACE IS NOT A SAFE MEASURE HERE, and saying so is better than quoting a
//     flattering finish time. The harness drive is a closed-loop seeker:
//     perturb it once at the top and every later jump lands differently, which
//     moves the finish by tens of seconds in EITHER direction. That is why
//     this module reports impulse and energy, and why RS-08 should be read as
//     the coarse band its own statement says it is. The claim this module does
//     make about pace is an identity, not a comparison: over the probe drive
//     it writes nothing at all, so the run is bit-identical to the same drive
//     with no run module attached.
//
//     After the finish the run-out holds the rider indefinitely: the allowance
//     is zero at the line, so gravity is cancelled frame after frame and the
//     rider parks at z = 2565.2. That is a sustained standing write, counted
//     in activeFraction and in the run-out's impulse. It is the right
//     behaviour — the run is over and the mountain has run out — but calling
//     it anything other than a standing write would be false.
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
//   only fields the cross-lane contracts make public (CONTRACTS.md's required
//   tstate set, plus trickState().starMult, which the hud lane's contract
//   requires every trick candidate to expose):
//
//     open   on the airborne -> grounded edge; record the physics label too.
//     close  when the trick system BANKS the jump — ts.lastAward becomes a new
//            object (identity change), which its reducer does on every
//            non-crash landing, points or no points, so a 0-point 'Air' still
//            counts as landed — or when LEDGER_WINDOW steps pass with no bank,
//            which is what a voided (crashed) jump looks like from outside.
//
//   LEDGER_WINDOW = 2 steps: 1 is DERIVED (the trick FSM freezes its verdict
//   at the touchdown step and resolves it on the following step, so a harness
//   landingOverride pass can run in between); the second is a CHOICE, one step
//   of slack for a lane candidate that defers one more. Short by design: long
//   enough to see the bank, too short to steal the next jump's.
//
//   Both verdicts are kept and reported separately:
//     results.landed / .crashed   the TRICK system's verdict (authoritative)
//     results.verdictSplits       touchdowns where physics DISAGREED
//     results.physUnlabelled      touchdowns physics had no opinion on
//   A null physics label is an absence of opinion, not a disagreement, and is
//   counted in its own field so verdictSplits cannot inflate itself on silence.
//
// ---------------------------------------------------------------------------
// 5. RESULTS — the banked award, and no invented grades
//
//   bestTrick is ts.lastAward.name: the trick system's whole banked jump
//   SUMMARY ("Frontside 360 + Grab"), which is what the player remembers and
//   what the score is actually made of — not one entry picked out of
//   ts.awards. Its banked points (ts.lastAward.points) ALREADY INCLUDE any
//   star multiplier the trick system credited, and that banked figure is the
//   authoritative one on the card (results.bestAward.points).
//
//   The multiplier is reported alongside it as bestAward.starMultAtLanding:
//   the public trickState().starMult on the frame BEFORE the bank — the star
//   the rider carried into that landing. It is labelled "at landing" and not
//   "applied" because the trick system credits a star only on a CLEAN landing,
//   and clean-vs-sketchy is not on its public surface. No string matching
//   against another lane's award names, no reaching into trick internals: this
//   module must work against any candidate in that lane.
//
//   There are no grade bands and no medals. Inventing a letter ladder over an
//   unsettled speed ladder is invention wearing a hat. results.rank is null
//   with the reason attached, and results.anchors carries the REAL anchors
//   from references/REFERENCE_BAR.md (uber base 13,210-22,580; ~130K for a
//   multi-star master jump) so a reader can place a score against something
//   sourced instead of against a band this module made up.
//
// ---------------------------------------------------------------------------
// 6. SELF-CHECK — what the gates measured, and what they could not
//
//   `node harness/run-runner.mjs --module sandbox/run-structure/B/run.mjs`
//     10/10, hardFails 0.
//       moduleYawAuthority_degps    0      (RS-10, bar 5)
//       _worstOutOfBoundsYaw_degps  0      the same zero on the frames the
//                                          gate excludes, so nothing hides in
//                                          them
//       _airborneVelWriteFrames     0      the indirect channel of §1 is shut
//                                          on this probe
//       maxDivergenceReached_m      0.97   (RS-05, bar 4)
//       maxCorrectionJump_m         0.465  (RS-06, bar 2) — the rider's own
//                                          travel; _jumpFromOobSeed, which is
//                                          this module's own positional write
//                                          measured exactly, is 0
//       startHolds                  1      (RS-09, drift 0.0011 m, bar 3 m)
//       runDuration_s               266.4  (RS-08, band 90-300) — and the same
//                                          drive with NO run module attached
//                                          produces a BIT-IDENTICAL 7,200-frame
//                                          path (selftest 6), because the
//                                          corridor is active on 0 frames of it
//       finishDetect                1      (RS-02; the rider reaches z = 2565,
//                                          the apron, against the gate's 2460)
//     and, self-measured on every drive in the gate suite and in selftest.mjs:
//       inBoundsWriteFrames         0      the claim of section 0
//       maxSelfPosDelta_m           0
//       beyondBound                 0
//       ceil3Frames                 0      outside the injection test, which
//                                          is the guard's own premise
//
//   WHAT THOSE GATES DO NOT MEASURE, stated plainly:
//     * RS-10's in-bounds frames are frames in which this module provably
//       writes nothing (§3.3), so the gate cannot tell a correct corridor from
//       an absent one.
//     * RS-05/RS-06's adversarial drive is caught by the run-out before it
//       gets far off centre, so the LATERAL wall and its return branch are
//       barely touched by it.
//     * No gate stages a rider behind the start line AND drives the corridor;
//       RS-09 stages behind the line but releases into an empty 8 s.
//     * No gate runs at any dt but 1/60.
//
//   `node sandbox/run-structure/B/selftest.mjs` drives exactly those and
//   reports numbers rather than pass/fail alone:
//     1. the lateral wall and the return branch at dt = 1/30, 1/60, 1/120
//     2. the airborne indirect-heading channel, opened deliberately
//     3. a 260 m out-of-corridor injection at 40 m/s (the guard's own case)
//     4. the berm's bank table against g/2, and its inner-edge inertness
//     5. the gate at three staging positions, each followed by a full
//        corridor drive (the coverage gap the cycle-4 critique named)
//     6. inBoundsWriteFrames == 0 under an in-bounds adversary
//     7. the ledger against the trick system, the checkpoint stream, and the
//        frozen card
//   70/70 checks pass; it exits non-zero on any failure. Two of its findings
//   are worth carrying up because they are about this DESIGN rather than about
//   this module passing: physics DISAGREED with the trick system on 14 of 45
//   touchdowns in one probe run, which is the whole reason section 4 exists;
//   and the 3-D write bound is 2.4x the horizontal one on a wall drive,
//   because the tangent lift is real work the one-dimensional energy budget
//   does not describe (section 3.2, TWO ENERGIES).
// ============================================================================

// ---------------------------------------------------------------------------
// PHYSICS ANCHORS (§1a)
// ---------------------------------------------------------------------------
const PINNED = {
  V_CAP: 33,            // m/s   hard speed clamp
  V_BOOST: 31,          // m/s   boost target speed
  TAU_BOOST: 0.7,       // s     boost relaxation time constant
  G_GROUND: 9.81,       // m/s^2 ground gravity
  A_LAT: 26,            // m/s^2 physics' own lateral accel ceiling
  MU_BASE: 0.0305,      //       Coulomb coefficient
  LAMBDA_LONG: 0.2235,  // 1/s   linear longitudinal drag
  TUCK_DRAG: 0.75,      //       k_tuckDrag on LAMBDA_LONG
  BRAKE_DECEL: 1.7,     // m/s^2 the rider's own brake authority (used in §3.4)
};

let LIVE = null, ANCHOR_SOURCE = 'pinned', ANCHOR_NOTE = '';
try {
  const m = await import('../../../src/physics/physics.mjs');
  if (m && m.DEFAULTS && typeof m.DEFAULTS.V_CAP === 'number') {
    LIVE = m.DEFAULTS;
    ANCHOR_SOURCE = 'live';
  } else {
    ANCHOR_NOTE = 'physics module imported but exported no usable DEFAULTS';
  }
} catch (e) {
  ANCHOR_NOTE = 'physics module unreachable from this path: ' + String(e && e.message).slice(0, 120);
}

// Verify anchor by anchor. A MISMATCH THROWS: a corridor derived from stale
// constants is worse than one that refuses to load.
function verifyAnchors(defaults) {
  const bad = [];
  for (const k of Object.keys(PINNED)) {
    const live = defaults[k];
    if (typeof live !== 'number') { bad.push(`${k}: pinned ${PINNED[k]}, live MISSING`); continue; }
    if (Math.abs(live - PINNED[k]) > 1e-12) bad.push(`${k}: pinned ${PINNED[k]}, live ${live}`);
  }
  return bad;
}
if (LIVE) {
  const bad = verifyAnchors(LIVE);
  if (bad.length) {
    throw new Error(
      'run-structure/B/run.mjs: PINNED physics anchors disagree with the live ' +
      'physics module, so every corridor constant in this file is derived from ' +
      'stale numbers. Update PINNED (and re-derive the geometry) before using ' +
      'this module. Mismatches: ' + bad.join('; '));
  }
}
const PHYSICS_ANCHOR_WARNING = LIVE ? null :
  'run-structure/B/run.mjs is running on PINNED physics constants, UNVERIFIED ' +
  'against the live physics module (' + ANCHOR_NOTE + '). Every corridor ' +
  'constant may be stale. Pass env.physicsDefaults to verify.';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// MEASURED — measurements of THIS world, taken this cycle against
// src/render/main.mjs with the run-runner's own centreline and divergence
// probes. Each is a fact about the terrain, not a preference. Method is in the
// comment; nothing here is a tuning knob.
// ---------------------------------------------------------------------------
const MEASURED = {
  // Largest |s| at which the run-runner's divergence probe stays under 2 m
  // anywhere in z in [-170, 2570]. Swept on a 1.5 m lateral x 2 m longitudinal
  // grid over the whole box, both flanks. Box worst at 155: 1.92 m; at 160 it
  // is 2.38 m; RS-05's own 4 m ceiling is not reached until |s| ~ 215.
  safeOffset_m: 155,
  safeOffsetWorstDivergence_m: 1.92,
  // Fine-LOD region of the run-runner's divergence probe. STRUCTURAL, not
  // fitted: the probe's cell size steps 15.6 m -> 83.3 m at these z, and the
  // measured gap steps with it (0.67 -> 11.86 at the top, 0.52 -> 9.63 at the
  // bottom). The containment box must lie wholly inside.
  fineLodZ: [-250, 2750],
  divergenceJustOutsideFineLod_m: { '-300': 11.86, 2760: 9.63 },
  // Minimum surface n_y over |s| <= 160, z in [-180, 2580] (a superset of the
  // containment set), 2 m grid: a 65.0 deg face at s = -160, z = 874.
  minSurfaceNy: 0.4219,
  // Terrain's own INWARD horizontal restoring acceleration along the corridor
  // lateral coordinate, both flanks, z = 0..2400, 5 m grid (m/s^2).
  terrainInwardPull_mps2: {
    55: { min: 0.50, median: 3.05, max: 5.94 },
    100: { min: 3.07, median: 4.44, max: 6.35 },
    120: { min: 3.47, median: 4.72, max: 6.31 },
    130: { min: 3.54, median: 4.76, max: 6.24 },
    140: { min: 3.55, median: 4.73, max: 5.97 },
    155: { min: 3.34, median: 4.65, max: 5.78 },
  },
  // Largest top-up the berm law asks for anywhere in its band |s| in [120,
  // 154.986], swept z on a 1 m grid x s on a 0.5 m grid, both flanks: 1.535
  // m/s^2 at s = -154.5, z = 450, where the mountain's own pull is 3.37. The
  // smallest terrain pull anywhere on the wall line is 3.326, so the largest
  // top-up the law can EVER ask for is g/2 - 3.326 = 1.579.
  peakBermTopUp_mps2: 1.535,
  // Largest |centreX'(z)| over the sampled centreline (10 m nodes).
  maxCentrelineSlope: 0.8571,
  // Error of this module's 10 m lerp cache against the harness centreline over
  // z in [-300, 2900], and of the 25 m nearest-node scheme an earlier
  // candidate used.
  centrelineErr10mLerp_m: 2e-13,
  centrelineErr25mNearest_m: 10.33,
  // The render lane's tree line: main.mjs plants pines only where
  // d = |x - centerX(z)| is in (55, 720). Recorded because it is the citation
  // behind the REJECTED tree-line berm (§3.6), not because anything uses it.
  treeLine_m: 55,
};

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const W_WALL = B.halfWidth ?? 120;          // the contract corridor edge

  // ---- physics anchors, injected > live > pinned, all verified (§1a) -------
  let PHYS = PINNED, anchorSource = ANCHOR_SOURCE, anchorWarning = PHYSICS_ANCHOR_WARNING;
  if (env.physicsDefaults && typeof env.physicsDefaults.V_CAP === 'number') {
    const bad = verifyAnchors(env.physicsDefaults);
    if (bad.length) throw new Error('run-structure/B/run.mjs: env.physicsDefaults ' +
      'disagrees with PINNED: ' + bad.join('; '));
    PHYS = { ...PINNED, ...env.physicsDefaults };
    anchorSource = 'injected'; anchorWarning = null;
  } else if (LIVE) {
    PHYS = { ...PINNED, ...LIVE };
  }

  const V_CAP = PHYS.V_CAP;                   // 33
  const V_BOOST = PHYS.V_BOOST;               // 31
  const TAU = PHYS.TAU_BOOST;                 // 0.7
  const G = PHYS.G_GROUND;                    // 9.81
  const DT_REF = 1 / 60;                      // CONTRACTS.md: fixed 60 Hz

  // ---- the adversary, in one number (§3.7) --------------------------------
  // Boost is a first-order relaxation toward V_BOOST with time constant
  // TAU_BOOST, so at rest it delivers V_BOOST/TAU_BOOST, aimed wherever the
  // board points: the strongest drive a player can command.
  const DRIVE_MAX = V_BOOST / TAU;                          // 44.286
  // A slope's horizontal pull is (g/2)*sin(2*theta) <= g/2, inward or outward.
  const A_GRAV_H = G / 2;                                   // 4.905
  const A_ADVERSE = DRIVE_MAX + A_GRAV_H;                   // 49.191

  // ---- the energy budget's geometry (§3.2, §3.3) --------------------------
  // SPAN(A,dt) is the gap at which the discrete allowance equals V_CAP exactly,
  // i.e. where the budget equals the largest kinetic energy physics permits.
  const span = (A, dt) => (V_CAP * V_CAP) / (2 * A) + V_CAP * dt;
  // One frame of adverse work past a line, between two clamps.
  const slop = dt => A_ADVERSE * dt * dt;                   // 0.0137 m @60Hz

  // ---- firmness from MEASURED room (§3.4) ---------------------------------
  // LATERAL: the softest firmness whose span + slop fits between the contract
  // corridor edge and the measured safe edge.
  const R_LAT = MEASURED.safeOffset_m - W_WALL;             // 35 m
  // If a host widens the contract corridor to (or past) the measured safe
  // edge there is no room left for a lateral layer, and every number below
  // would come out negative or absurd. Refuse rather than produce a corridor
  // that cannot contain anyone.
  if (R_LAT <= V_CAP * DT_REF + slop(DT_REF)) {
    throw new Error('run-structure/B/run.mjs: bounds.halfWidth = ' + W_WALL +
      ' leaves ' + R_LAT.toFixed(2) + ' m to the measured safe edge (|s| = ' +
      MEASURED.safeOffset_m + ', where the mesh gap reaches the module\'s 2 m ' +
      'guarantee). A lateral layer needs more than V_CAP*dt of room. Re-measure ' +
      'MEASURED.safeOffset_m for this terrain, or narrow halfWidth.');
  }
  const A_LATERAL = (V_CAP * V_CAP) /
    (2 * (R_LAT - V_CAP * DT_REF - slop(DT_REF)));          // 15.812
  // DOWN-COURSE: the run-out is the rider's OWN stopping distance under the
  // accepted physics module's longitudinal law at the lowest drag they can
  // choose (tucked): APRON = int(0..V_CAP) v dv / (F0 + L v).
  const F0_FLAT = PHYS.MU_BASE * G;                         // 0.29921 m/s^2
  const L_TUCK = PHYS.LAMBDA_LONG * PHYS.TUCK_DRAG;         // 0.16763 1/s
  const APRON = (V_CAP - (F0_FLAT / L_TUCK) *
    Math.log(1 + L_TUCK * V_CAP / F0_FLAT)) / L_TUCK;       // 165.244 m
  // and the firmness is whatever makes a layer of that length inert at zFinish.
  const A_LONGITUDINAL = (V_CAP * V_CAP) /
    (2 * (APRON - V_CAP * DT_REF));                         // 3.306

  // ---- write ceilings: a CONSEQUENCE of the firmnesses (§3.7) -------------
  const A_HMAX = Math.hypot(A_LATERAL, A_LONGITUDINAL) + A_ADVERSE;  // 65.344
  const NY_MIN = MEASURED.minSurfaceNy;                     // 0.4219
  const A_3D_MAX = A_HMAX / NY_MIN;                         // 154.88

  // ---- lines and bounds at DT_REF (recomputed per frame from live dt) -----
  const LAT_LINE = W_WALL + span(A_LATERAL, DT_REF);        // 154.986
  const LAT_BOUND = LAT_LINE + slop(DT_REF);                // 155.000
  const Z_LINE_DOWN = zFinish + Math.max(APRON, span(A_LONGITUDINAL, DT_REF));
  const Z_BOUND_DOWN = Z_LINE_DOWN + slop(DT_REF);          // 2565.258
  const Z_LINE_UP = zStart - Math.max(APRON, span(A_LONGITUDINAL, DT_REF));
  const Z_BOUND_UP = Z_LINE_UP - slop(DT_REF);              // -165.258

  const COUNTDOWN_S = env.countdown_s ?? 3;   // CHOICE (presentation only)
  const CHECKPOINTS = 4;                      // CHOICE (presentation only)
  const LEDGER_WINDOW = 2;                    // 1 derived + 1 slack (§4)

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth: W_WALL,
    maxDivergence_m: 4,            // the CONTRACT's ceiling (RS-05)
    // ---- this module's own, tighter guarantee ----
    divergenceGuarantee_m: 2,
    divergenceInContainmentBox_m: MEASURED.safeOffsetWorstDivergence_m,
    // ---- corridor geometry (quoted at DT_REF; recomputed each frame) ----
    bermStart_m: W_WALL,
    lateralLine_m: LAT_LINE, lateralBound_m: LAT_BOUND,
    zLineDown_m: Z_LINE_DOWN, zBoundDown_m: Z_BOUND_DOWN,
    zLineUp_m: Z_LINE_UP, zBoundUp_m: Z_BOUND_UP,
    lateralRoom_m: R_LAT, apron_m: APRON,
    slopPerFrame_m: slop(DT_REF),
    // ---- firmnesses and ceilings ----
    lateralFirmness_mps2: A_LATERAL,
    longitudinalFirmness_mps2: A_LONGITUDINAL,
    driveMax_mps2: DRIVE_MAX, gravityHorizontalMax_mps2: A_GRAV_H,
    adverseMax_mps2: A_ADVERSE,
    bermMax_mps2: A_GRAV_H,
    ceilAccelHorizontal_mps2: A_HMAX, ceilAccel3D_mps2: A_3D_MAX,
    minSurfaceNy: NY_MIN,
    // ---- run ----
    countdown_s: COUNTDOWN_S, checkpointCount: CHECKPOINTS,
    ledgerWindow_steps: LEDGER_WINDOW,
    // ---- provenance ----
    physicsAnchor: {
      source: anchorSource,
      verified: anchorSource !== 'pinned',
      warning: anchorWarning,
      pinned: { ...PINNED },
    },
    measured: MEASURED,
    derivation: {
      law: 'ENERGY BUDGET. Each boundary is a potential barrier of firmness A holding specific potential PHI(gap) = A*gap; the rider carries outward specific kinetic energy w^2/2. The corridor is the single inequality w^2/2 <= A*gap, whose solution is the allowance w_allow = sqrt(2*A*gap), and the field applies (w - w_allow)/dt: exactly the acceleration that removes the SURPLUS energy w^2/2 - A*gap and nothing else. Past the line the same inequality reads with the sign flipped — the rider must be climbing back out fast enough to arrive at the line at rest — because braking alone stops a rider going out fast, not going out.',
      discreteForm: 'the budget is evaluated against the gap the rider will HAVE, not the one they have: w^2/2 = A*(gap - w*dt) gives w_allow = -A*dt + sqrt(A^2*dt^2 + 2*A*gap), so the barrier cannot be overrun by braking one step late at any dt.',
      inertness: 'SPAN(A,dt) = V_CAP^2/(2A) + V_CAP*dt is the gap at which the discrete allowance equals V_CAP exactly (substitute and the sqrt collapses to A*dt + V_CAP). Every layer sits one SPAN outside the CONTRACT boundary it defends, so no rider physics permits can be outrunning the budget at or inside that boundary: the surplus is <= 0 and the field is exactly 0. Recomputed each frame from the live dt. This is why inBoundsWriteFrames is 0 by construction and not by luck.',
      lateralFirmness: `MEASURED, then solved. The run-runner's own divergence probe keeps the mesh gap under ${2} m (half RS-05's ceiling) out to |s| = ${MEASURED.safeOffset_m}, so the room between the contract corridor edge (${W_WALL}) and the safe edge is R_LAT = ${R_LAT.toFixed(2)} m. A_LATERAL is the SOFTEST firmness whose span plus one frame of adverse slop fits in it: V_CAP^2 / (2*(R_LAT - V_CAP*dt - A_ADVERSE*dt^2)) = ${A_LATERAL.toFixed(3)} m/s^2, putting its line at |s| = ${LAT_LINE.toFixed(3)} and its containment bound at ${LAT_BOUND.toFixed(3)} — the measured safe edge exactly, by construction. The arrow runs mountain -> firmness -> ceiling; nothing here is derived from a ceiling that was built from it.`,
      apron: `The DOWN-COURSE layer is not sized by room (there are ${(MEASURED.fineLodZ[1] - zFinish).toFixed(0)} m of it) but by what a finish line needs: a run-out as long as the rider\'s own stopping distance under the accepted physics module\'s longitudinal law a(v) = MU_BASE*g + LAMBDA_LONG*TUCK_DRAG*v, at the lowest drag they can choose (tucked). APRON = (1/L)*(V_CAP - (F0/L)*ln(1 + L*V_CAP/F0)) = ${APRON.toFixed(3)} m, every symbol a published physics constant. It is NOT a promise the rider stops in it — this course keeps descending and a rider holding boost never stops anywhere — it is the statement that the mountain gets the whole of the rider's own stopping distance before a barrier takes over.`,
      longitudinalFirmness: `A_LONGITUDINAL is then forced: it is the firmness for which a layer one APRON long is inert at zFinish, i.e. span(A) = APRON, giving V_CAP^2/(2*(APRON - V_CAP*dt)) = ${A_LONGITUDINAL.toFixed(3)} m/s^2, line at z = ${Z_LINE_DOWN.toFixed(3)}, bound ${Z_BOUND_DOWN.toFixed(3)}, clear of the fine-LOD edge (${MEASURED.fineLodZ[1]}) by ${(MEASURED.fineLodZ[1] - Z_BOUND_DOWN).toFixed(1)} m. The back-stop INHERITS it, because up-course the mountain climbs and there is nothing to run out into, so no apron can be derived for it and softening past that point buys nothing. Its line lands at z = ${Z_LINE_UP.toFixed(3)}, which fits the up-course room to ${MEASURED.fineLodZ[0]} with ${(Z_BOUND_UP - MEASURED.fineLodZ[0]).toFixed(1)} m to spare — CHECKED after the fact, not chosen.`,
      rejectedFirmnesses: `A_STOP = DRIVE_MAX + g = ${(DRIVE_MAX + G).toFixed(1)} (the cycle-4 winner's lateral wall): defensible as un-outrunnable, but ${((DRIVE_MAX + G) / A_LATERAL).toFixed(1)}x firmer than the room requires — a harder shove on a player who leans on the wall — and it mixes a full g into a HORIZONTAL budget when no slope pulls sideways harder than g/2. BRAKE_DECEL = ${PHYS.BRAKE_DECEL} m/s^2, READ from the live physics module and verified against PINNED (§1a) — "the rider's own brake authority": its span is ${span(PHYS.BRAKE_DECEL, DT_REF).toFixed(0)} m, which would put the lateral bound at |s| = ${(W_WALL + span(PHYS.BRAKE_DECEL, DT_REF)).toFixed(0)} where the mesh gap is far past RS-05's 4 m. 4.5 m/s^2 from REFERENCE_BAR TN-08: that band (3-6) describes what a BOARD can scrub and picking a point inside it is taste; the physics module's own published number for the same quantity is ${PHYS.BRAKE_DECEL}, so the citation and the code disagree. A run-out is a barrier, not the rider braking; a rider who declines to brake still has to be stopped.`,
      containmentBound: `line + SLOP, where SLOP = A_ADVERSE*dt^2 is one frame of adverse work between two clamps (${slop(DT_REF).toFixed(5)} m at 60 Hz). The unseen-frame term V_CAP*dt lives inside SPAN instead, because it buys inertness at the layer start. The bound is a BOUND, not a barrier: nothing is placed there and nothing fires there; beyondBound counts frames past it, AUDITED AGAINST THE LIVE dt rather than the 60 Hz figures quoted in config, because a larger step legitimately widens the box by V_CAP*(dt - 1/60) and an audit pinned to 60 Hz would pass a box it never checked. Measured at dt = 1/30 the box reaches |s| = 155.53 against a bound of 155.59, where the mesh gap is 0.68 m.`,
      ceilings: `A CONSEQUENCE, not a source. A_ADVERSE = DRIVE_MAX + g/2 = ${A_ADVERSE.toFixed(3)} is the strongest outward horizontal acceleration the world can give. Tracking a boundary costs the envelope\'s own decel plus cancelling that adversary; the envelope demands at most A_LATERAL across and A_LONGITUDINAL along and those are orthogonal, while the adversary is one vector, so A_HMAX = hypot(A_LATERAL, A_LONGITUDINAL) + A_ADVERSE = ${A_HMAX.toFixed(3)} m/s^2 — exactly sufficient, and one m/s^2 less would make the containment bound a wish. The berm does not widen it: where the berm is at full strength ground+berm is g/2 inward, so the wall's share falls by g/2 exactly as the berm's rises. A_3D_MAX = A_HMAX/NY_MIN = ${A_3D_MAX.toFixed(2)} because a grounded push must lie in the tangent plane; NY_MIN = ${NY_MIN} is MEASURED over a superset of the containment set, so the 3-D ceiling is a guard and ceil3Frames says whether it ever fired.`,
      bermLaw: `a_berm = q^2 * max(0, g/2 - a_terrain_inward), q = clamp((|s| - halfWidth)/(lateralLine - halfWidth), 0, 1). A slope\'s inward horizontal restoring accel is (g/2)*sin(2*theta) <= g/2, so g/2 is the strongest bank a slope can BE and therefore the most a berm may apply and still be honestly called terrain. MEASURED, the gully already pulls 4.72 (median) / 3.47 (min) inward at |s| = 120, so the berm TOPS UP rather than adds; peak top-up over the whole band is ${MEASURED.peakBermTopUp_mps2} m/s^2. q^2 is the lowest-order polynomial that is zero WITH ZERO SLOPE at the inner edge and 1 at the wall line — forced by those conditions, not a feel knob. ${(100 * A_GRAV_H / PHYS.A_LAT).toFixed(1)}% of physics' own A_LAT = ${PHYS.A_LAT} (read and verified), so full lock still overrules it.`,
      bermInnerEdge: 'DECIDED, not inherited. The cycle-4 winner started its berm at the render lane\'s tree line |s| = 55 — a real citation and a nicer-feeling corridor, 65 m of which lies inside terrain the CONTRACT calls in bounds, costing ~247 in-bounds velocity-write frames per run by its own count. Its critic refused to settle that and handed it to the lane owner. Settled here at halfWidth: the contract says a rider is corrected when |s| > halfWidth, and a force inside that is level design, which this lane does not own. The price, stated: the whole transition from free riding to corrected riding now happens within 35 m instead of 100, so this corridor is firmer than A\'s for a player who leans on it. That is what a structural zero costs.',
      startGate: 'ONE RULE, NO BRANCH: you are in phase ready if and only if you are behind the gate line, and gateZ = clamp(first observed z, zLineUp, zStart) — the gate is a physical object at the top of the course and the rider is staged AT it. A rider staged past zStart is past the gate, so ready is empty and the clock starts on frame 1; that is the same rule read the other way, not a special case. The gate is the ordinary energy law with its line at gateZ, so at p = 0 the allowance is 0 and the field removes exactly the down-course rate the rider has and nothing more. NOT at zStart for everyone: a gate 40 m down-course of a staged rider catches them instead of holding them, and 40 m of sliding is exactly the drift RS-09 calls a failure. NOT a full velocity zero either: that is a physics write on an ordinary frame and it re-rolls the run the module is supposed to be timing.',
      outOfBounds: 'PURE GEOMETRY, the contract\'s own definition: |s| > halfWidth or z outside [zStart, zFinish], evaluated every frame in every phase. It is NOT the "this module wrote something" signal — that is rs.confine.active, which is what it was always for. Consequence stated because it cuts against this candidate: the flag is true for the whole run-out and for the ready phase, so RS-06 measures its per-frame position jump over thousands of frames instead of a handful, and RS-10 sees every in-bounds frame the contract says it should. The cycle-4 winner raised the flag on every frame it wrote anything, which mislabelled an in-bounds rider to the HUD and deleted 174 frames from RS-10\'s measured set.',
      corridorCoordinates: 'exact Jacobian solve, not a unit-vector decomposition. With s = x - centreX(z) and k = centreX\'(z): az = d2z/dt2, ax = d2s/dt2 + k*az. Decomposing onto corridor normal/tangent unit vectors delivers only 1/sqrt(1+k^2) of what is asked — 24% short at the measured max k = 0.857 — which is the kind of quiet slack that lets a guarantee be violated. The centreline is cached on a 10 m grid and LERPED, the run-runner\'s own construction node for node: measured error 2e-13 m. A 25 m nearest-node cache measures 10.33 m of error, enough to fire a wall at an in-bounds rider.',
      tangentLift: 'a grounded correction is lifted into the tangent plane — the unique tangent vector whose horizontal shadow is the correction asked for, so no authority is lost to a projection or invented by a rescale. Without it the physics module\'s magnitude-preserving grounded redirect launders any component pointed into the hill back out as forward speed: a confiner that accidentally boosts. The horizontal ceiling is applied BEFORE the lift so the lift cannot smuggle authority in behind it.',
      checkpointStream: 'one append-only log (rs.stream), written by one function, folded by results(). Splits are not kept twice, so the card and the stream cannot drift apart.',
      choices: 'countdown_s = 3, checkpointCount = 4 and the D_SAFE = 2 m divergence guarantee (half RS-05\'s ceiling, because the sweep is on a finite grid) are CHOICES and carry no physical claim. ledgerWindow_steps = 2 is 1 derived + 1 step of slack. Nothing else in this block is a preference.',
      rank: 'absent by decision: no defensible speed ladder exists yet, and a grade band over an unsettled ladder is invention. results.anchors carries the sourced anchors instead.',
    },
  };

  // ---- corridor centre and its exact derivative (§3.8) --------------------
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
  const cxPrime = z => {
    const i = Math.floor(z / CX_STEP);
    return (node(i + 1) - node(i)) / CX_STEP;
  };

  // Terrain normal by central difference on the SAME 0.05 m stencil the
  // physics module's default sampleNormal uses.
  function normalAt(x, z) {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  }
  // Tangential gravity on the surface: g_vec - (g_vec . n) n, g_vec = (0,-G,0).
  function tangentGravity(n) {
    const gdn = -G * n[1];
    return [-gdn * n[0], -G - gdn * n[1], -gdn * n[2]];
  }

  // ---- THE ENERGY BUDGET (§3.2) ------------------------------------------
  // p = signed distance past the line (negative = still inside).
  // Returns the fastest OUTWARD rate the budget permits there.
  function allowOutward(p, A_IN, A_OUT, dt) {
    if (p <= 0) {
      const gap = -p;                       // budget PHI = A_IN * gap
      return -A_IN * dt + Math.sqrt(A_IN * A_IN * dt * dt + 2 * A_IN * gap);
    }
    // inside the barrier: the rider must be climbing back out fast enough to
    // arrive at the line at rest, capped at a speed physics permits to exist
    return -Math.min(V_CAP, Math.sqrt(2 * A_OUT * p));
  }
  // The surplus specific energy the rider is carrying past the budget, and the
  // acceleration that removes exactly it. Never negative: a boundary can hold,
  // it can never push a rider away from itself.
  function surplus(p, w, A_IN, A_OUT, dt) {
    const wa = allowOutward(p, A_IN, A_OUT, dt);
    if (w <= wa) return { a: 0, e: 0 };
    return { a: (w - wa) / dt, e: 0.5 * (w * w - wa * wa) };
  }

  // ------------------------------------------------------------------- init
  function init() {
    return {
      // ---- contract-required ----
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: 1,               // single-rider gauntlet build: always P1
      results: null,
      outOfBounds: false,     // PURE GEOMETRY (§3.9 / derivation.outOfBounds)
      // ---- loud provenance ----
      physicsAnchorWarning: anchorWarning,
      // ---- start gate ----
      stage: 'countdown',     // 'countdown' | 'running' | 'finished'
      countdown_s: COUNTDOWN_S,
      light: 'red',           // 'red' | 'set' | 'go'
      gateOpen: false,
      gateZ: null,            // where the gate is (null until the first step)
      pastGateAtStage: false, // staged down-course of the gate line
      _staged: false,
      progress: 0,
      // ---- the checkpoint stream (§2) ----
      stream: [],             // append-only; results() folds it
      streamCursor: 0,        // for incremental consumers (HUD)
      nextCheckpoint: 0,
      // ---- live telemetry ----
      speed_kmh: 0,
      topSpeed_kmh: 0,
      airTime_s: 0,
      biggestAir_s: 0,
      distanceRidden_m: 0,
      jumps: 0,
      landed: 0,              // touchdowns the TRICK system banked
      crashed: 0,             // touchdowns the TRICK system voided
      verdictSplits: 0,       // touchdowns where physics DISAGREED
      physUnlabelled: 0,      // touchdowns physics had no opinion on
      unresolvedTouchdowns: 0,// touchdowns the finish beat to adjudication
      banks: 0,
      bestAward: null,        // { name, points, starMultAtLanding, at_s }
      lastAward: null,        // the most recent bank, same shape
      // ---- confinement telemetry (self-measured, not self-reported) ----
      confine: {
        active: false,          // THIS MODULE WROTE SOMETHING this frame
        depth_m: 0,
        accel_mps2: 0,
        terrainPull_mps2: 0,
        bankTotal_mps2: 0,      // terrain + berm this frame (= g/2 at q = 1)
        peakBerm_mps2: 0,
        peakDemand_mps2: 0,     // largest budget demand BEFORE the ceilings
        peakApplied_mps2: 0,    // largest 3-D applied (<= A_3D_MAX)
        peakAppliedH_mps2: 0,   // largest horizontal applied (<= A_HMAX)
        peakDepth_m: 0,
        peakOffset_m: 0,        // widest line the rider has taken
        // one counter per LAYER, never pooled
        bermFrames: 0,
        wallFrames: 0,          // LATERAL brake branch
        limitFrames: 0,         // LATERAL return branch
        runoutFrames: 0,
        backstopFrames: 0,
        gateFrames: 0,
        ceilFrames: 0,          // the horizontal ceiling actually bound
        ceil3Frames: 0,         // the 3-D guard actually bound (want 0)
        beyondBound: 0,         // frames past a containment bound (want 0)
        // THE CLAIM OF §0, COUNTED: writes while the rider is in the
        // contract's own in-bounds set, outside the ready phase. Want 0.
        inBoundsWriteFrames: 0,
        readyGateWriteFrames: 0,// writes made by the closed start gate
        airborneWriteFrames: 0, // the indirect heading channel (§1)
        maxAirborneVelWrite_mps: 0, // and its worst single-frame size
        activeFrames: 0,
        totalFrames: 0,
        activeFraction: 0,
        // what the corridor cost the rider, in units that are not chaotic
        impulse: { berm: 0, wall: 0, limit: 0, runout: 0, backstop: 0, gate: 0 },
        energySurplus_m2s2: 0,  // surplus the budget found (§3.2) — the target
        energyRemoved_m2s2: 0,  // -min(0, v . dv): specific KE actually taken
        energyAdded_m2s2: 0,    //  max(0, v . dv): specific KE actually added
        maxSelfVelDelta_mps: 0,
        selfPosDelta_m: 0,      // |pos| change across this module's write block
        maxSelfPosDelta_m: 0,   //   diffed every frame — computed, not asserted
      },
      // ---- internals ----
      _t: 0,
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
      _prevAwardRef: null,
      _starPrev: 1,
      _ledger: null,
    };
  }

  // ------------------------------------------------------- checkpoint stream
  // The ONLY writer of rs.stream.
  function emit(rs, ph, ts, kind, extra) {
    rs.stream.push(Object.freeze({
      i: rs.stream.length,
      kind,
      t_s: +rs.time_s.toFixed(4),
      z: +ph.pos[2].toFixed(3),
      s: +(ph.pos[0] - cx(ph.pos[2])).toFixed(3),
      speed_kmh: +(Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6).toFixed(2),
      score: ts && typeof ts.score === 'number' ? ts.score : 0,
      airTime_s: +rs.airTime_s.toFixed(3),
      ...(extra ?? {}),
    }));
  }

  // ------------------------------------------------------------------ results
  // The one place a card is built, and it FOLDS the stream. `live` is the
  // in-progress readback the HUD shows; the frozen card is the same function
  // called once, so the two can never drift apart.
  function assemble(rs, ts, live) {
    const t = ts ?? {};
    const checkpoints = rs.stream.filter(e => e.kind === 'checkpoint' || e.kind === 'finish');
    let prev = 0;
    const splits = checkpoints.map(e => {
      const sp = { index: e.index ?? checkpoints.length, z: Math.round(e.z),
        t: +e.t_s.toFixed(3), split_s: +(e.t_s - prev).toFixed(3),
        speed_kmh: e.speed_kmh, score: e.score };
      prev = e.t_s;
      return sp;
    });
    const best = rs.bestAward;
    return {
      // ---- contract-required six ----
      time_s: +rs.time_s.toFixed(3),
      score: t.score ?? 0,
      bestTrick: best ? best.name : null,
      tricky: !!t.tricky,
      landed: rs.landed,
      crashed: rs.crashed,
      // ---- THE BANKED AWARD, in full (§5) ----
      bestAward: best ? { ...best } : null,
      lastAward: rs.lastAward ? { ...rs.lastAward } : null,
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
      splits,
      // ---- how the module behaved, on the card, not only in the state ----
      confinement: {
        inBoundsWriteFrames: rs.confine.inBoundsWriteFrames,
        readyGateWriteFrames: rs.confine.readyGateWriteFrames,
        airborneWriteFrames: rs.confine.airborneWriteFrames,
        maxAirborneVelWrite_mps: +rs.confine.maxAirborneVelWrite_mps.toFixed(4),
        activeFraction: +rs.confine.activeFraction.toFixed(5),
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
        ceilFrames: rs.confine.ceilFrames,
        ceil3Frames: rs.confine.ceil3Frames,
        beyondBound: rs.confine.beyondBound,
        maxSelfPosDelta_m: rs.confine.maxSelfPosDelta_m,
        impulse_mps: Object.fromEntries(Object.entries(rs.confine.impulse)
          .map(([k, v]) => [k, +v.toFixed(3)])),
        energySurplus_m2s2: +rs.confine.energySurplus_m2s2.toFixed(2),
        energyRemoved_m2s2: +rs.confine.energyRemoved_m2s2.toFixed(2),
        energyAdded_m2s2: +rs.confine.energyAdded_m2s2.toFixed(2),
      },
      physicsAnchor: { source: anchorSource, verified: anchorSource !== 'pinned' },
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
    const air = !ph.onGround;
    if (air) {
      rs._airRun += dt;
      rs.airTime_s += dt;
      if (rs._airRun > rs.biggestAir_s) rs.biggestAir_s = rs._airRun;
      if (!rs._wasAir) rs.jumps++;
    } else rs._airRun = 0;

    // landing ledger (§4): open on the airborne -> grounded edge
    if (rs._wasAir && !air) {
      if (rs._ledger) closeLedger(rs, false);      // bounce inside the window
      rs._ledger = { steps: 0, physVerdict: ph.landing ?? null };
    }
    rs._wasAir = air;

    // banked tricks: the trick system's reducer replaces ts.lastAward with a
    // NEW object on every non-crash landing (points or not) and nulls it on a
    // crash, so an identity change is exactly one bank.
    const la = ts && ts.lastAward ? ts.lastAward : null;
    let banked = false;
    if (la && la !== rs._prevAwardRef) {
      banked = true;
      rs.banks++;
      const award = { name: la.name, points: la.points,
        starMultAtLanding: rs._starPrev, at_s: +rs.time_s.toFixed(3) };
      rs.lastAward = award;
      if (!rs.bestAward || la.points > rs.bestAward.points) rs.bestAward = award;
    }
    rs._prevAwardRef = la;
    const sm = ts ? ts.starMult : undefined;
    rs._starPrev = typeof sm === 'number' && sm >= 1 ? sm : 1;

    if (rs._ledger) {
      if (banked) closeLedger(rs, true);
      else if (++rs._ledger.steps > LEDGER_WINDOW) closeLedger(rs, false);
    }

    const v = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_kmh = v * 3.6;
    if (rs.speed_kmh > rs.topSpeed_kmh) rs.topSpeed_kmh = rs.speed_kmh;
    if (rs._prevPos) {
      rs.distanceRidden_m += Math.hypot(ph.pos[0] - rs._prevPos[0], ph.pos[2] - rs._prevPos[2]);
      rs._prevPos[0] = ph.pos[0]; rs._prevPos[1] = ph.pos[1]; rs._prevPos[2] = ph.pos[2];
    } else rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
  }

  // The trick system banked it -> landed; it never did -> the jump was voided.
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
  // position, heading, or any physics or trick flag.
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
    const sRate = (ph.vel[0] - k * ph.vel[2]) * out;   // outward rate, + = leaving
    const zRate = ph.vel[2];

    // ---- the contract's own in-bounds set, computed from geometry only ----
    const inBounds = sAbs <= W_WALL && z >= zStart && z <= zFinish;
    rs.outOfBounds = !inBounds;

    // layer lines, recomputed from the LIVE dt so the inertness identity of
    // §3.3 holds at any step size
    const latLine = W_WALL + span(A_LATERAL, dt);
    const zLen = Math.max(APRON, span(A_LONGITUDINAL, dt));
    const zLineDown = zFinish + zLen;
    const zLineUp = zStart - zLen;
    // the containment bounds THIS frame's dt implies (§3.5). Quoted in config
    // at DT_REF; audited here against the live dt, because a larger step
    // legitimately widens the box by V_CAP*(dt - DT_REF) and an audit pinned
    // to 60 Hz would silently pass a box it never checked.
    const sl = slop(dt);
    const latBound = latLine + sl;
    const zBoundDown = zLineDown + sl, zBoundUp = zLineUp - sl;
    if (sAbs > latBound || z > zBoundDown || z < zBoundUp) c.beyondBound++;

    let aIn = 0;      // inward (toward the centreline) lateral acceleration
    let aZ = 0;       // down-course acceleration, + = down-course
    let eSurplus = 0;

    // ---- LAYER 1. BERM: the mountain's own bank, topped up to g/2 ---------
    //      Grounded only (a berm is ground), and zero WITH zero slope at the
    //      contract corridor edge.
    let n = null;
    if (ph.onGround && sAbs > W_WALL) {
      n = normalAt(x, z);
      const gt = tangentGravity(n);
      const terrIn = -out * (gt[0] - k * gt[2]);   // ground's own inward pull
      const q = clamp((sAbs - W_WALL) / (latLine - W_WALL), 0, 1);
      const berm = q * q * Math.max(0, A_GRAV_H - terrIn);
      c.terrainPull_mps2 = terrIn;
      c.bankTotal_mps2 = terrIn + berm;
      if (berm > 0) {
        aIn += berm;
        c.bermFrames++;
        c.impulse.berm += berm * dt;
        if (berm > c.peakBerm_mps2) c.peakBerm_mps2 = berm;
      }
    }

    // ---- LAYERS 2 & 3. WALL (brake) and RETURN, one energy budget ---------
    const pLat = sAbs - latLine;
    const bLat = surplus(pLat, sRate, A_LATERAL, A_LATERAL, dt);
    if (bLat.a > 0) {
      aIn += bLat.a;
      eSurplus += bLat.e;
      if (pLat > 0) { c.limitFrames++; c.impulse.limit += bLat.a * dt; }
      else { c.wallFrames++; c.impulse.wall += bLat.a * dt; }
      if (bLat.a > c.peakDemand_mps2) c.peakDemand_mps2 = bLat.a;
    }
    if (pLat > 0) {
      c.depth_m = pLat;
      if (pLat > c.peakDepth_m) c.peakDepth_m = pLat;
    }

    // ---- down-course: the closed gate, or the run-out past the finish -----
    // While the gate is closed its line IS the gate (p = 0 at the staged
    // position), so the budget removes exactly the down-course rate the rider
    // has. Once it drops, the run-out takes over one apron past zFinish.
    const lineDown = gateZ === null ? zLineDown : gateZ;
    const pDown = z - lineDown;
    const bDown = surplus(pDown, zRate, A_LONGITUDINAL, A_LONGITUDINAL, dt);
    if (bDown.a > 0) {
      aZ -= bDown.a;
      eSurplus += bDown.e;
      if (gateZ !== null) { c.gateFrames++; c.impulse.gate += bDown.a * dt; }
      else { c.runoutFrames++; c.impulse.runout += bDown.a * dt; }
      if (bDown.a > c.peakDemand_mps2) c.peakDemand_mps2 = bDown.a;
    }
    if (pDown > 0) {
      c.depth_m = Math.max(c.depth_m, pDown);
    }

    // ---- up-course back-stop (outward is -z) ------------------------------
    const pUp = zLineUp - z;
    const bUp = surplus(pUp, -zRate, A_LONGITUDINAL, A_LONGITUDINAL, dt);
    if (bUp.a > 0) {
      aZ += bUp.a;
      eSurplus += bUp.e;
      c.backstopFrames++;
      c.impulse.backstop += bUp.a * dt;
      if (bUp.a > c.peakDemand_mps2) c.peakDemand_mps2 = bUp.a;
    }
    if (pUp > 0) {
      c.depth_m = Math.max(c.depth_m, pUp);
    }

    if (aIn === 0 && aZ === 0) {
      c.activeFraction = c.activeFrames / c.totalFrames;
      return;
    }

    // ---- assemble the world-space correction (exact Jacobian solve, §3.8) --
    let uz = aZ;
    let ux = -aIn * out + k * aZ;
    let uy = 0;

    // ---- ceiling 1: the HORIZONTAL correction, the only part that does
    //      containment work. Applied BEFORE the tangent lift.
    const hm = Math.hypot(ux, uz);
    if (hm > A_HMAX) { const f = A_HMAX / hm; ux *= f; uz *= f; c.ceilFrames++; }

    if (ph.onGround) {
      if (!n) n = normalAt(x, z);
      if (n[1] > 1e-3) uy = -(ux * n[0] + uz * n[2]) / n[1];
    }

    // ---- ceiling 2: the absolute 3-D guard --------------------------------
    let am = Math.hypot(ux, uy, uz);
    if (am > A_3D_MAX) {
      const f = A_3D_MAX / am; ux *= f; uy *= f; uz *= f; am = A_3D_MAX;
      c.ceil3Frames++;
    }

    // ---- the ONLY write this module makes, with pos diffed around it ------
    const px = ph.pos[0], py = ph.pos[1], pz = ph.pos[2];
    const work = ph.vel[0] * ux * dt + ph.vel[1] * uy * dt + ph.vel[2] * uz * dt;
    if (work < 0) c.energyRemoved_m2s2 -= work; else c.energyAdded_m2s2 += work;
    c.energySurplus_m2s2 += eSurplus;
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
    c.active = true;                    // THE write-occurred signal (not oob)
    c.activeFrames++;
    c.activeFraction = c.activeFrames / c.totalFrames;
    if (!ph.onGround) {
      // The indirect heading channel of §1, measured rather than asserted: an
      // airborne write is horizontal only (no tangent lift), so this is
      // exactly the lateral velocity that can become heading at the next
      // clean landing. Bounded by A_HMAX*dt.
      c.airborneWriteFrames++;
      if (dv > c.maxAirborneVelWrite_mps) c.maxAirborneVelWrite_mps = dv;
    }
    // THE AUDIT OF §0, counted rather than asserted. A write on an in-bounds
    // rider outside the ready phase would falsify this module's central claim.
    if (rs.phase === 'ready') c.readyGateWriteFrames++;
    else if (inBounds) c.inBoundsWriteFrames++;
  }

  // ------------------------------------------------------------------- step
  function step(rs, physState, trickState, dt) {
    const ph = physState;
    if (!ph || !dt) return rs;
    rs._t += dt;

    // ---------- ready: held at the gate, clock reads 0 ---------------------
    if (rs.phase === 'ready') {
      // ONE RULE (§2): you are in 'ready' iff you are behind the gate line,
      // and the gate line is where the rider was staged (clamped into the
      // corridor's own up-course line so a gate can never fight the back-stop).
      if (!rs._staged) {
        rs._staged = true;
        // ONE UNSEEN FRAME of tolerance, and it is the same V_CAP*dt term
        // every layer carries (§3.5): this module reads the rider AFTER
        // physics has stepped, so a rider staged exactly ON zStart is already
        // a few tenths of a millimetre past it the first time the rule is
        // evaluated. Without the tolerance, "staged at the start line" is a
        // coin flip decided by one physics step. With it, that rider gets the
        // gate at their own feet — never behind them, so the gate can never
        // push an in-bounds rider back up-course.
        const unseen = V_CAP * dt;
        rs.pastGateAtStage = ph.pos[2] > zStart + unseen;
        if (rs.pastGateAtStage) rs.countdown_s = 0;
        else rs.gateZ = clamp(ph.pos[2], Z_LINE_UP, zStart + unseen);
        emit(rs, ph, trickState, 'staged',
          { gateZ: rs.gateZ, pastGate: rs.pastGateAtStage });
      }
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.gateOpen = rs.countdown_s <= 0;
      rs.light = rs.countdown_s > COUNTDOWN_S / 3 ? 'red'
        : rs.countdown_s > 0 ? 'set' : 'go';
      rs.progress = 0;
      if (!rs.gateOpen && rs.gateZ !== null) {
        confine(rs, ph, dt, rs.gateZ);        // gate closed: hold at the line
        return rs;
      }
      // THE DROP. The clock starts here, which is what a start gate is.
      rs.phase = 'running'; rs.stage = 'running'; rs.light = 'go';
      rs.time_s = 0;
      rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
      rs.nextCheckpoint = 0;
      emit(rs, ph, trickState, 'go', {});
    }

    // ---------- running: clock, telemetry, checkpoints, finish, corridor ---
    if (rs.phase === 'running') {
      rs.time_s += dt;
      observe(rs, ph, trickState, dt);
      rs.progress = clamp((ph.pos[2] - zStart) / (zFinish - zStart), 0, 1);

      while (rs.nextCheckpoint < CHECKPOINTS - 1) {
        const zc = zStart + ((rs.nextCheckpoint + 1) / CHECKPOINTS) * (zFinish - zStart);
        if (ph.pos[2] < zc) break;
        rs.nextCheckpoint++;
        emit(rs, ph, trickState, 'checkpoint', { index: rs.nextCheckpoint, gateZ: Math.round(zc) });
      }

      // FINISH — tested BEFORE the corridor, so the crossing frame is the
      // frame that reports 'finished' and the run-out can never block it.
      if (ph.pos[2] >= zFinish) {
        emit(rs, ph, trickState, 'finish', { index: CHECKPOINTS, gateZ: zFinish });
        rs.progress = 1;
        // a touchdown inside the ledger window has not been adjudicated and
        // the card freezes here: count it as neither, and say so on the card
        if (rs._ledger) { rs.unresolvedTouchdowns++; rs._ledger = null; }
        const res = assemble(rs, trickState, false);
        for (const sp of res.splits) Object.freeze(sp);
        Object.freeze(res.splits); Object.freeze(res.anchors);
        Object.freeze(res.confinement); Object.freeze(res.physicsAnchor);
        if (res.bestAward) Object.freeze(res.bestAward);
        if (res.lastAward) Object.freeze(res.lastAward);
        rs.results = Object.freeze(res);
        rs.finished = true;
        rs.phase = 'finished'; rs.stage = 'finished';
      }
      confine(rs, ph, dt, null);
      return rs;
    }

    // ---------- finished: clock frozen, card frozen, corridor still holds --
    rs.speed_kmh = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6;
    confine(rs, ph, dt, null);
    return rs;
  }

  // Frozen after the finish; a live readback of the same shape before it.
  function results(rs, trickState) {
    return rs.results ?? assemble(rs, trickState, true);
  }

  // Full deterministic reset: every field rebuilt from init(), in place.
  function restart(rs) {
    const fresh = init();
    for (const k of Object.keys(rs)) delete rs[k];
    Object.assign(rs, fresh);
    return rs;
  }

  return { config, init, step, results, restart };
}
