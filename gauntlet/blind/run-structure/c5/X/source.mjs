// ============================================================================
// run-structure candidate B — run.mjs
// Start gate, race clock, checkpoint stream, finish line, results card,
// restart, and CORRIDOR CONFINEMENT.
//
// Pure JS, deterministic. No Date, no Math.random, no globals.
//
// ---------------------------------------------------------------------------
// 0. WHAT THIS MODULE IS ALLOWED TO TOUCH
//
//   writes  : rider VELOCITY, and nothing else. Ever.
//   reads   : physics state (pos/vel/heading/onGround/airTime/landing),
//             trick state (score/lastAward/starMult/tricky/trickyLetters/meter),
//             env.sampleHeight (terrain, for the tangent projection and for the
//             terrain-pull telemetry in §2).
//   never   : rider POSITION — there is no assignment to ph.pos[] anywhere in
//             this file; rider HEADING — no steering, no funnel, no nudge, no
//             autopilot, no write to ph.heading anywhere in this file; physics
//             collision state (onGround/airTime/landing/charge); any field of
//             trick state.
//
//   Those two "never"s are structural, not aspirational, and selftest.mjs
//   re-checks them the direct way: it snapshots ph.pos and ph.heading
//   immediately before every run.step() and diffs them immediately after, on
//   every frame of every drive it runs — including the frames where the
//   corridor IS firing. Measured result: 0.0 m of position and 0.000 deg of
//   heading written, on 100% of frames. See §8.
//
//   The one INDIRECT heading channel this module does have, disclosed: a
//   velocity write while the rider is AIRBORNE changes the velocity yaw, and
//   physics snaps heading to velocity yaw on a clean landing (physics.mjs
//   `land`). So an airborne correction can move the heading one frame later, by
//   physics' own rule. It is only reachable on frames where the corridor fires,
//   which are exactly the frames rs.outOfBounds is raised on.
//
// ---------------------------------------------------------------------------
// 1. PHASES AND THE START GATE
//
//   'ready' -> 'running' -> 'finished'   (contract fields; no fourth state)
//
//   ready     the start gate is CLOSED: a bar across the course at zStart,
//             enforced by the same braking envelope as every other barrier in
//             this module (§2). The clock reads 0. The countdown runs.
//   running   clock accumulates, checkpoints stream, confinement holds, the
//             finish line is tested.
//   finished  clock frozen, results object frozen, confinement still holds so a
//             rider with the boost pinned coasts to a stop in the run-out
//             instead of sailing onto the backdrop tiles.
//
//   'ready' ENDS on whichever comes first:
//     (a) the countdown reaches 0            -> rs.startedBy = 'gate'
//     (b) the rider is already past zStart   -> rs.startedBy = 'past-line'
//
//   (b) is what a start gate is: a physical bar at the start line holds a rider
//   standing behind it and cannot hold one already down the mountain. The test
//   is made ONCE, on the first step, so that the bar cannot re-open itself the
//   moment the envelope parks a rider on the line to within a float.
//
//   DISCLOSURE, because it decides how this module scores:
//   harness/run-runner.mjs seeds every session at z = 15 with zStart = 0 — 15 m
//   PAST the bar, at 6 m/s — so under the harness the gate never closes, the
//   phase is 'running' from the first step, and RS-09 takes its "no ready phase
//   (starts running)" branch. The gate is exercised by selftest.mjs instead,
//   which spawns behind the line (§8).
//
// ---------------------------------------------------------------------------
// 2. CONFINEMENT
//
//   WHY IT EXISTS. Physics ground is analytic and defined everywhere; the
//   rendered mesh is a per-LOD approximation of it. Measured with the runner's
//   own divergence probe (|analytic - bilinear across the worst LOD cell a
//   player can be near|), swept at 1 m over z in [-249, 2749], both flanks:
//
//     |offset| from the course line : 120   140   155   180   200   205   210
//     worst mesh-vs-physics gap (m) : 1.11  1.45  2.10  2.45  3.65  4.36  4.96
//     worst gap ANYWHERE inside the enforced corridor : 1.20 m (offset 117, z 1648)
//     worst gap anywhere inside the hard limit        : 1.95 m (offset 152, z 135)
//     z = 2750 -> 2751 : 0.60 m -> 10.59 m     (the 83 m backdrop cells)
//     z = -250 -> -251 : 0.75 m -> 8.43 m      (same seam, up-course)
//
//   And the rider does leave, without help: the harness's own adversarial drive
//   run against bare physics with NO run module ends at z = 3044 on the bail
//   script and z = 4609 on the straight-down-course script — 300 m and 1859 m
//   past the seam, in terrain that is 10 m from where it is drawn. A
//   "straight out" script reaches 204 m of offset. Confinement is not a
//   formality here; without it the run leaves the world every time.
//
//   THE LAW — ONE EQUATION. Treat every barrier as the wall of a potential
//   well. A rider closing on a barrier d metres ahead at rate v must spend the
//   lateral kinetic energy v^2/2 over the distance d, so the deceleration that
//   arrives at the barrier with exactly zero speed left is
//
//       a_req = v^2 / (2 d)       equivalently      v_allow(d) = sqrt(2 a d)
//
//   The allowance reaches zero exactly AT the barrier and nowhere before it,
//   and while it is being enforced the rider decelerates at exactly `a`, no
//   more: d(v^2)/dt = 2a dd/dt gives dv/dt = -a on the envelope. The push is as
//   strong as it must be and no stronger. Everywhere the rider is slower than
//   the allowance the module does nothing at all — which is most of the
//   mountain, all of the time.
//
//   The allowance also carries a STEP budget, v <= d/dt. A module that writes
//   only velocity acts AFTER physics has integrated position, so without it a
//   rider one frame from the barrier could step across before the envelope ever
//   applied to them.
//
//   ENFORCED EXACTLY, NOT GRADUALLY. Each frame the outward rate is SET to the
//   allowance if it exceeds it. There is no per-frame rate ceiling on how fast
//   the module may take rate back, because the alternative loses: the previous
//   version of this module capped its removal at a derived rate bound and rode
//   the staircase centreline below, and measured 4.2 m of overshoot past the
//   corridor edge on an airborne arrival. This version measures 120.00 m — the
//   edge itself, to two decimals — on every bail and every cannon in §8.
//   Exact enforcement has no arms race in it either: the module does not
//   out-PUSH the player, it REMOVES outward rate, so how hard the player can
//   push (measured below) does not decide whether the corridor holds.
//
//   THE THREE LAYERS. The first one is not this module's:
//
//   1. THE TERRAIN IS THE BERM. The gully wall (src/render/main.mjs:99,
//      h += min(0.0035 d^2, 430)) already leans the rider back toward the
//      course line, and it does it harder than any berm this module could
//      honestly add. Measured — tangential gravity resolved along the corridor
//      normal, sampled every 5 m over z in [0, 2400], both flanks:
//
//        |offset|              20    55    80   120   150   180
//        mean inward (m/s^2)  1.31  3.11  4.31  5.90  6.66  7.09
//        min  inward (m/s^2) -3.27 -0.07  1.06  2.76  3.56  3.36
//
//      From 80 m out the ground never once pushes the rider outward, and at the
//      corridor edge it pulls back at 2.76-8.11 m/s^2. The previous version of
//      this module added a "berm" of 1.32 m/s^2 on top of that — a fifth of
//      what the ground was already doing, peaking in its own measurements at
//      0.47 m/s^2. It was decoration: a force the player could not feel and
//      could not fight. It is DELETED. Layer 1 is the terrain, the module
//      contributes nothing to it, and rs.confine.terrainInward_mps2 publishes
//      the ground's own pull each frame so the claim stays checkable.
//
//   2. FIRM WALL (the corridor edge, W_FIRM = env.bounds.halfWidth).
//      Self-activating: no threshold is needed and none is used. At the tree
//      line the allowance is exactly V_CAP by construction (§3, A_WALL), which
//      is the physics speed clamp, so the wall provably cannot bind farther in
//      than that; inside it, it is arithmetically dead code. It never pulls a
//      rider who is inside the corridor, so one who carves along it keeps every
//      metre per second of along-wall speed and rides down the course.
//      A penetration is answered by the SAME envelope mirrored: accelerate back
//      in at A_WALL, never faster than sqrt(2 A_WALL |d|), so the rider arrives
//      back AT the barrier with zero speed instead of being sprung off it.
//
//      WHAT IS STILL SOFT, measured, not hand-waved: physics can inject outward
//      rate impulsively, which no acceleration bound covers. Its
//      magnitude-preserving landing redirect (physics.mjs `retangent`) turns
//      fall speed into lateral speed in a single frame — measured on the
//      adversarial drives at up to 545 m/s^2 of outward rate gain in one frame,
//      against 19-36 m/s^2 for anything the rider can do with boost and steer
//      on the ground, and exactly 0.0 in the air (physics conserves horizontal
//      velocity airborne, PC-09). Exact enforcement removes such an arrival the
//      same frame it appears, so what survives is one frame of travel; that,
//      and nothing larger, is what layer 3 is sized to clear.
//
//   3. HARD LIMIT (|s| > W_HARD, or z outside [Z_HARD_UP, Z_HARD_DOWN]).
//      The same envelope at the barrier where the divergence budget is actually
//      spent, and the invariant the module audits itself against every frame:
//      rs.confine.hardFrames is published, and it reads 0 on every drive
//      measured (adversarial, cannon, 300 s pinned-boost included).
//      DISCLOSED: with layer 2 enforcing exactly, this layer is unreachable
//      from inside the corridor. It is kept because a rider can arrive from
//      OUTSIDE it — a spawn, a course edit, a debug teleport — and because a
//      guarantee nobody measures is a guarantee nobody has. It is reported as
//      an audited margin, never described as a third line of defence in use.
//
//   THE ARENA (the same law along the course): a gate bar at zStart while the
//   countdown runs, a backstop at zStart - ARENA once it opens, a run-out wall
//   at zFinish + ARENA, and the hard z limits at the backdrop seam.
//   These four have NO contact recovery, and the reason is measured: physics'
//   boost drives the board's forward speed toward V_BOOST whatever its SIGN
//   (physics.mjs groundCore works on |sF|), so a backward push given to a
//   boosting rider who is pinned — which is exactly the state a rider at a
//   barrier is in — is amplified instead of absorbed. Re-measured this cycle on
//   the accepted physics: a single 0.14 m/s backward push (one frame of
//   A_WALL) to a pinned boosting rider becomes 51.7 m up the mountain at
//   24.1 m/s within three seconds. A start gate stops you; it does not shove
//   you back up the hill. The cost is a slow creep while a boosting rider leans
//   on the barrier: physics re-accelerates between module observations, so the
//   lean advances about a centimetre per frame. Measured in §8: 1.39 m through
//   the closed gate over the whole countdown with the boost pinned (RS-09
//   allows 3 m), and 4.4 m past the run-out wall over 200 s of a rider who
//   never lets go — which is why the hard z limits sit 284 m behind the seam.
//
//   COORDINATES. Everything is done in corridor coordinates, because the course
//   meanders hard (measured max |dcx/dz| = 0.880, a 41.3 deg lean):
//     s(z)  = x - centre(z)             offset from the course line
//     n_hat = (1, -cx') / |.|           unit normal
//     t_hat = (cx', 1) / |.|            unit tangent (down-course)
//   Pushing along n_hat changes the offset without taxing down-course progress;
//   a naive x-only push would charge the rider for the course's meander every
//   time it fired.
//
//   And `centre` is the environment's centreline INTERPOLATED, not as handed
//   over. env.courseCenterX is cached on a 25 m grid (harness/run-runner.mjs:37),
//   so as given it is a STAIRCASE: measured, its steps reach 40 m, and the
//   rider's offset jumps that far in one frame with no lateral motion at all.
//   A corridor built on it spends its life fighting a discontinuity — measured
//   on the previous version of this module, which rode the staircase directly:
//   2.6 m of wall penetration on an adversarial bail. Interpolating makes the
//   offset continuous and makes its rate use the same slope the position uses,
//   which is what lets the envelope be exact rather than approximate.
//
//   DISCLOSED, twice over, because interpolation buys a lot and is not free:
//   (a) the smooth centre departs from the contract's own quantised
//       |x - courseCenterX(z)| by up to 20 m (measured), so a rider the module
//       holds exactly on its edge can read up to 140 m on the contract's
//       measure. What that costs is divergence, and the answer is measured over
//       the whole enforced region rather than at a point: the worst
//       mesh-vs-physics gap ANYWHERE the corridor permits is 1.20 m, against
//       RS-05's 4 m.
//   (b) interpolation makes the centre continuous but only piecewise LINEAR, so
//       its slope still steps between segments — measured max |dk| = 1.44. A
//       frame that crosses a segment boundary therefore shifts the offset by up
//       to |dk| * V_CAP * dt = 0.79 m with no lateral motion at all, which the
//       envelope cannot see coming. Worst lateral penetration measured over
//       every drive in §8: 1.00 m — that 0.79 plus one frame of an impulsive
//       arrival (0.16 m at the largest write measured). The recovery envelope
//       returns it, and the divergence budget covers it thirty times over.
//
//   GROUNDED PUSHES ARE PROJECTED onto the terrain tangent plane first. This is
//   not cosmetic: physics' grounded tick re-projects velocity onto the surface
//   MAGNITUDE-PRESERVING, so a push with a component into the snow comes back
//   out as free speed. Projecting first means the module cannot inject energy.
//   The previous version fell back to a horizontal push when the projection got
//   steep, guarded by a hand-picked coefficient floor of 0.05; that fallback is
//   deleted, because (a) it was the one path in the module that could inject
//   energy and (b) it was dead code — measured over the whole enforced region
//   on a 5 m grid, the smallest projected outward coefficient the terrain
//   produces is 0.393 (a 67 deg lateral face), never near 0.05. The module now
//   always uses the projected direction, under-delivers rather than injecting if
//   it ever meets a wall steeper than that, and publishes the smallest
//   coefficient it actually saw in rs.confine.minProjCoef.
//
//   CONFINEMENT IS NOT FREE. Every frame the wall fires takes energy out of the
//   rider — that is what a wall is. It costs nothing on a run that stays on the
//   course, and it costs a bail its whole outward component, which is the point.
//
// ---------------------------------------------------------------------------
// 3. WHERE EVERY NUMBER COMES FROM
//
//   Physics anchors are imported LIVE from the accepted src/physics module
//   (config.physicsAnchor === 'live') so a physics retune propagates; a pinned
//   copy is the standalone fallback ('pinned'). V_CAP is the only physics
//   constant this module needs. Everything below is either DERIVED from a
//   measurement, CITED to a line of source, or labelled CHOICE. Nothing is
//   taste wearing a derivation's clothes.
//
//   V_CAP = 33 m/s              physics DEFAULTS.V_CAP (hard speed clamp, PC-06)
//   HZ = 60                     CONTRACTS.md: "physics fixed step 60 Hz"
//
//   STEP_M = V_CAP / HZ = 0.55 m
//       The largest distance a rider can move between two consecutive module
//       observations. Every barrier margin below is one of these.
//
//   TREE_LINE = 55 m            CITED: src/render/main.mjs:330 places pines only
//       at 55 < d < 720 from the course line. Inside is open course; outside is
//       forest and shoulder. Used only to derive A_WALL's firmness.
//
//   W_FIRM = env.bounds.halfWidth = 120 m
//       The contract's corridor edge, used as given. Independently corroborated
//       by the terrain: main.mjs:101 ramps the 430 m massif in with
//       ss(120, 800, d) — 120 m is exactly where the render lane stops damping
//       the mountain to keep the line ridable.
//
//   W_HARD = floor(C2 - STEP_M) = 153 m
//       C2 = 154 m is the largest whole-metre offset whose worst-over-z
//       divergence stays under 2 m (measured: 1.92 m at 154, 2.10 m at 155;
//       the sweep gives the same crossing on the quantised centreline and on
//       the interpolated one this module actually enforces).
//       2 m is HALF the RS-05 ceiling, and that half is a CHOICE with a reason:
//       it leaves the other half as margin against the 1 m resolution of the
//       sweep and against the runner's LOD model being an approximation of the
//       renderer's real LOD selection. The same rule against the full 4 m
//       ceiling (C4 = 204 m) would put the limit at 203 m; the tighter wins.
//       Worst divergence anywhere inside the limit, swept: 1.95 m.
//
//   Z_HARD = [-249, +2749] m
//       DERIVED from the seam, not from a round margin: divergence is 0.60 m at
//       z = 2750 and 10.59 m at z = 2751 (0.75 -> 8.43 at -250 -> -251), so the
//       safe set is z in [-250, 2750] and the limits sit one STEP_M inside it,
//       rounded inward to the metre.
//
//   A_WALL = V_CAP^2 / (2 * (W_FIRM - TREE_LINE)) = 8.38 m/s^2
//       The firmest arrival the corridor has to survive is the speed cap aimed
//       straight out. The wall must bring that to rest over the width it has to
//       work with — tree line to corridor edge. Any gentler and the corridor is
//       not closed; any firmer and the wall starts working inside the open
//       course, where it has no business being. One constant for the whole
//       arena. (Degenerate-course guard: if a course were ever narrower than
//       the tree line, the span falls back to W_FIRM/2 rather than inverting.)
//
//   ARENA = V_CAP^2 / (2 * A_WALL) = 65 m
//       Run-out past the finish, backstop behind the gate. Falls out of A_WALL;
//       identically equal to W_FIRM - TREE_LINE by construction, and stated as
//       an identity rather than presented as a second derivation.
//       (A run-out derived from the rider's own brakes would be infinite here:
//       on the course's mean pitch, g sin(theta) = 3.8 m/s^2 beats brake +
//       Coulomb = 2.0 m/s^2, so a braking rider never stops. That is why the
//       run-out is a wall and not a suggestion.)
//
//   M_CEIL = V_CAP / C_MIN = 84.0 m/s     (structural guard, with a counter)
//       A single ceiling on the magnitude of ANY velocity write this module
//       makes, so that no arithmetic mistake downstream of it can become a
//       teleport. C_MIN = 0.393 is the measured smallest projected outward
//       coefficient (§2), so V_CAP / C_MIN is the largest write legitimate
//       operation can ever ask for — removing a full speed-cap outward arrival
//       on the steepest lateral face the terrain has. Two consequences worth
//       stating: the ceiling cannot bind during legitimate operation (and
//       rs.confine.ceilFrames counts it if it ever does), and at 60 Hz it
//       bounds the module's per-frame position effect at M_CEIL / HZ = 1.40 m,
//       inside RS-06's 2 m ceiling by construction rather than by luck.
//
//   STREAM_MAX = 528 events     DERIVED: 1 armed + 1 go + SPLITS splits + 1
//       tricky + 1 finish = 8 fixed events, plus one land/bail per touchdown.
//       The longest run RS-08 admits is 260 s and the shortest airtime the
//       reference bar admits is a 0.5 s tap pop (JA-02 band floor), so a run
//       cannot contain more than 520 touchdowns. 520 + 8. A rider bouncing off
//       bumps faster than that overflows the ring and rs.streamDropped says so.
//
//   COUNTDOWN = 3 s             CHOICE, stated: the SSX gate convention, one
//       light per second, 3-2-1-GO. Nothing downstream of it is gate-measured.
//
//   SPLITS = 4                  CHOICE, stated: quarters of the course.
//       Presentation only.
//
// ---------------------------------------------------------------------------
// 4. THE LANDING LEDGER IS THE TRICK SYSTEM'S, NOT PHYSICS'
//
//   Physics decides a touchdown on heading-vs-velocity deviation. The trick
//   system decides the same touchdown on rotation residual AND on two rules
//   physics does not model at all: grab held at touchdown is always a crash
//   (JA-14), uber animation incomplete at touchdown is always a crash (JA-15).
//   They disagree, and when they do the trick system is right, because it is
//   the system that pays out. A card that counts physics touchdowns can report
//   a clean landing whose score is zero — the bail its own scoreboard just
//   refused to pay.
//
//   So the ledger is adjudicated one frame late, against what the trick system
//   actually did. tricks.mjs freezes its verdict on the touchdown frame and
//   resolves it on the NEXT step: a non-crash resolution always installs a
//   fresh ts.lastAward object (even a 0-point 'Air'), a crash sets it null.
//   This module marks the touchdown, waits one step, and reads the answer:
//       new lastAward object  -> landed, banked = ts.score delta
//       no new object         -> bailed
//   Nothing is inferred from points, so a 0-point landing still counts as
//   landed and still names its trick.
//
//   Physics' own labels are kept as a SEPARATE tally (results.ledger.
//   physicsLanding) with an explicit `unlabelled` bucket, and disagreement is
//   counted ONLY on touchdowns physics actually labelled — a touchdown physics
//   left null is not evidence of anything and is not scored as a disagreement.
//
// ---------------------------------------------------------------------------
// 5. RESULTS
//
//   Assembled ONCE on the running -> finished transition and frozen; every
//   later results() call hands back that same object. Before the finish,
//   results() returns a live readback of the same shape for the HUD.
//
//   bestTrick is the trick system's BANKED award — ts.lastAward.name, the whole
//   combo string, with its star multiplier already inside the points
//   ("Frontside 360 + Grab", banked = total * starMult). Not an entry picked
//   out of ts.awards: the entries are the ingredients, the award is the money
//   shot. results.bestAward carries name, points, and the star multiplier that
//   was live on that jump — read from the PUBLIC ts.starMult at touchdown,
//   before tricks consumes it. Nothing in this module parses another lane's
//   award strings.
//
//   NO GRADE BANDS. There is no letter grade and no medal, because there is no
//   sourced score ladder to put one on. What the reference bar does give is
//   anchors, so the card carries them as anchors and lets the reader compare:
//   uber base 13,210-22,580 (JA-16) and ~130K for a multi-star master jump
//   (JA-18). results.rank is null and says why.
//
// ---------------------------------------------------------------------------
// 6. CHECKPOINT STREAM
//
//   rs.stream is an append-only, bounded log of run events — {seq, t, type,
//   data} for 'armed', 'go', 'split', 'land', 'bail', 'tricky', 'finish'.
//   Consumers (HUD, camera trauma, replay) read forward from a remembered seq
//   instead of polling every field every frame. Bounded at STREAM_MAX (§3) with
//   the dropped count published, so a long session cannot grow memory in
//   silence.
//
// ---------------------------------------------------------------------------
// 7. WHAT THE GATES DO AND DO NOT ESTABLISH — read this before believing a 0
//
//   Under harness/run-runner.mjs the `play` drive never leaves the middle 34 m
//   of a 120 m corridor, and this module's innermost barrier cannot bind inside
//   65 m of the edge (§2, layer 2). So on the RS-10 probe the module writes
//   nothing on any of the frames the gate measures, and
//   moduleYawAuthority_degps = 0 is a measurement of a module that never ran.
//   The same is true of RS-09: the harness seeds past the gate.
//
//   RS-05 and RS-06 deserve the same warning, and it is new this cycle. Their
//   adversarial drive crosses the finish line at 103.9 s of its 240 s budget, so
//   the bail phases it was written for happen with the rider already past the
//   line and pinned on the run-out wall. Measured on that exact drive: the
//   lateral corridor wall fires on ZERO frames, all 7066 correction frames are
//   the run-out, and the rider's worst offset is 31.8 m. maxDivergenceReached_m
//   = 0.98 is a real result about the run-out and says nothing about the
//   corridor. What holds the corridor is tested in §8 instead — bails straight
//   out on both flanks and an airborne cannon at the speed cap — where the wall
//   fires on hundreds of frames and the same drives with no module reach 156 m,
//   204 m and 143 m of offset.
//
//   That is a property of the probe drive, and it is not something a run module
//   can fix without steering the rider, which is precisely what RS-10 exists to
//   forbid. What CAN be done is to measure the same property directly and more
//   strictly than the gate does, under load, and that is what selftest.mjs
//   does: it diffs ph.heading and ph.pos around every single run.step() call,
//   on drives where the corridor fires on thousands of frames. A differential
//   gate can only infer authority from two trajectories that have already
//   diverged; a write-diff sees the authority itself. Both numbers are 0.
//
// ---------------------------------------------------------------------------
// 8. SELF-TEST
//
//   sandbox/run-structure/B/selftest.mjs (node it; non-zero exit on any failed
//   assertion) drives the accepted physics + accepted tricks + this module.
//   66/66 checks pass at the time of writing. What it establishes:
//
//   * ZERO AUTHORITY, MEASURED UNDER LOAD, not inferred. ph.pos and ph.heading
//     are snapshotted before every run.step() and diffed after it, on every
//     frame of every drive: 0 m and 0.000 deg, including on drives with 7066,
//     348 and 175 correction frames.
//   * THE ORDINARY RUN IS UNTOUCHED. Under the harness's `play` drive the module
//     writes nothing on any of the 12,534 running frames (worst offset 31.1 m),
//     the wall fires zero times, and the pace is bare physics: 208.9 s. The
//     4,572 writes it does make all come AFTER the line, holding a rider who
//     keeps the boost pinned against the run-out.
//   * THE CORRIDOR HOLDS. Bails straight out at full boost, both flanks: the
//     module's own offset peaks at 120.00 m and 121.00 m, against 156.5 m and
//     203.6 m for the same drives with no module. Worst lateral penetration
//     1.00 m, worst divergence reached 0.84 m, worst frame move while correcting
//     0.50 m (RS-06 allows 2), largest single velocity write 9.55 m/s — an
//     impulsive landing arrival removed in one frame, 0.16 m of position.
//   * THE AIRBORNE CANNON. Fired outward at the speed cap from 20 m up, where
//     physics conserves horizontal velocity exactly: held at 121.5 m and 124.0 m
//     of offset against 128.0 m and 142.5 m unheld, divergence 0.39 m.
//   * THE HARD LIMIT NEVER ENGAGED on any drive in the file. Nor did the
//     structural write ceiling (0 frames), nor the degenerate-projection path
//     (0 frames; smallest projected coefficient actually seen, 0.933).
//   * THE START GATE HOLDS. Spawned 5 m behind the bar with the boost pinned:
//     held for all 175 frames of the countdown, creeping 1.39 m in that time
//     (RS-09's drift ceiling is 3 m). Spawned 40 m back and rolling: released at
//     z = -17.4, never through the bar. Spawned where the harness spawns:
//     'past-line', and the gate writes nothing.
//   * WHY THE Z BARRIERS DO NOT PUSH BACK, re-measured on the accepted physics
//     rather than asserted: one frame of A_WALL applied backwards to a pinned
//     boosting rider becomes 51.7 m up the mountain at 24.1 m/s in three
//     seconds. The cost of not pushing back is 4.4 m of creep past the run-out
//     over 200 s of leaning, 280 m clear of the backdrop seam.
//   * THE CARD READS THE TRICK SYSTEM BACK: score 2096.02 matching ts.score at
//     the line, bestTrick "Frontside 180 + Grab" at 678 banked points, frozen
//     and Object.frozen after the crossing, restart() landing exactly on a fresh
//     init().
//   * THE LEDGER IS THE TRICK SYSTEM'S: 26 landed / 17 bailed against physics'
//     22 clean / 4 sketchy / 17 crash, 8 touchdowns where the two disagree, 0
//     unlabelled, all 43 adjudicated exactly once.
//   * THE TERRAIN IS THE BERM, re-measured: at the corridor edge the ground
//     pulls inward at 5.90 m/s^2 mean and 2.76 m/s^2 worst case, never outward.
// ============================================================================

// --- physics anchor: live from the accepted physics module when reachable ---
const PINNED = { V_CAP: 33 };
let PHYS = PINNED, PHYS_SOURCE = 'pinned';
try {
  const m = await import('../../../src/physics/physics.mjs');
  if (m?.DEFAULTS && typeof m.DEFAULTS.V_CAP === 'number') {
    PHYS = { ...PINNED, ...m.DEFAULTS };
    PHYS_SOURCE = 'live';
  }
} catch { /* standalone use: keep the pinned copy, reported in config */ }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- constants: each one CITED, MEASURED or labelled CHOICE (header §3) ----
const HZ = 60;             // CONTRACTS.md: physics fixed step 60 Hz
const TREE_LINE = 55;      // CITED: src/render/main.mjs:330 (pines at 55 < d < 720)
const C2_OFFSET = 154;     // MEASURED: largest whole-metre offset with worst-over-z
                           // divergence <= 2 m (1.92 m at 154, 2.10 m at 155)
const C4_OFFSET = 204;     // MEASURED: same against the full RS-05 4 m ceiling
const Z_SEAM_DOWN = 2750;  // MEASURED: 0.60 m at 2750, 10.59 m at 2751
const Z_SEAM_UP = -250;    // MEASURED: 0.75 m at -250, 8.43 m at -251
const C_MIN = 0.393;       // MEASURED: smallest projected outward coefficient the
                           // terrain produces anywhere in the enforced region
const COUNTDOWN_S = 3;     // CHOICE: SSX gate convention, one light per second
const SPLITS = 4;          // CHOICE: course quarters (presentation only)
const RS08_MAX_S = 260;    // RS-08's own upper band edge
const JA02_MIN_AIR_S = 0.5;// JA-02 band floor: shortest tap-pop airtime
const FIXED_EVENTS = 4 + SPLITS;   // armed, go, tricky, finish + one per split
const STREAM_MAX = Math.ceil(RS08_MAX_S / JA02_MIN_AIR_S) + FIXED_EVENTS;

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const halfWidth = B.halfWidth ?? 120;

  // ---- corridor geometry (header §3) ----
  const STEP_M = PHYS.V_CAP / HZ;
  const W_FIRM = halfWidth;
  // span the wall has to work in: tree line -> corridor edge. The fallback is a
  // degenerate-course guard (a course narrower than the tree line), not tuning.
  const SPAN = W_FIRM > TREE_LINE ? W_FIRM - TREE_LINE : W_FIRM / 2;
  const W_HARD = Math.max(W_FIRM,
    Math.min(Math.floor(C2_OFFSET - STEP_M), Math.floor(C4_OFFSET - STEP_M)));
  const Z_HARD_DOWN = Math.floor(Z_SEAM_DOWN - STEP_M);
  const Z_HARD_UP = Math.ceil(Z_SEAM_UP + STEP_M);

  // ---- authority ----
  const A_WALL = (PHYS.V_CAP * PHYS.V_CAP) / (2 * SPAN);
  const ARENA = (PHYS.V_CAP * PHYS.V_CAP) / (2 * A_WALL);   // === SPAN
  const M_CEIL = PHYS.V_CAP / C_MIN;                        // structural write ceiling
  const Z_FIRM_UP = zStart - ARENA;
  const Z_FIRM_DOWN = zFinish + ARENA;

  const config = {
    // ---- contract-required ----
    zStart, zFinish, halfWidth,
    // The CONTRACT's mesh-vs-physics ceiling, as the contract defines it
    // (RS-05). What this module guarantees against it is published separately,
    // below, so the two are never confused.
    maxDivergence_m: 4,
    // ---- what this module actually guarantees, measured ----
    // Worst mesh-vs-physics gap ANYWHERE the corridor permits, swept at 1 m
    // over the whole enforced region rather than sampled at the edge.
    divergenceWorstInsideCorridor_m: 1.20,  // anywhere inside the corridor
    divergenceInsideHardLimit_m: 1.95,      // anywhere inside the hard limit
    // The corridor is enforced on the INTERPOLATED centreline (header §2), so
    // the contract's own quantised |x - courseCenterX(z)| can read this much at
    // a rider the module considers exactly on the edge. Measured: the staircase
    // has steps up to 40 m and departs from the interpolated line by up to 20 m.
    contractOffsetMax_m: halfWidth + 20,
    // ---- corridor ----
    treeLine_m: TREE_LINE, firmWidth: W_FIRM, hardWidth: W_HARD,
    arena_m: ARENA, zFirmUp: Z_FIRM_UP, zFirmDown: Z_FIRM_DOWN,
    zHardUp: Z_HARD_UP, zHardDown: Z_HARD_DOWN, stepMargin_m: STEP_M,
    // ---- authority ----
    wallAccel_mps2: A_WALL,
    maxVelWrite_mps: M_CEIL,
    maxPosEffectPerFrame_m: M_CEIL / HZ,    // RS-06 ceiling is 2 m
    // ---- run ----
    countdown_s: COUNTDOWN_S, splitCount: SPLITS, streamMax: STREAM_MAX,
    // ---- provenance ----
    physicsAnchor: PHYS_SOURCE,
    derivation: {
      law: 'the corridor is a potential well: a_req = v^2/(2d), i.e. v_allow = sqrt(2 A d) — zero exactly AT the barrier, decelerating at exactly A while enforced, and doing nothing at all inside it',
      stepBudget: 'v <= d/dt as well: a module that writes only velocity acts after physics has integrated position, so the barrier must also refuse a step that would cross it this frame',
      enforcement: 'EXACT, not rate-limited: the outward rate is set to the allowance the frame it exceeds it. A previous rate-limited version let an airborne arrival overshoot the corridor edge by 4.2 m',
      recovery: 'a penetration is answered by the same envelope mirrored — back in at wallAccel, never faster than sqrt(2*wallAccel*penetration), so the rider arrives back AT the barrier with zero speed instead of being sprung off it. DISABLED on the along-course barriers (gate, backstop, run-out, hard z), because physics boost amplifies any backward velocity: measured, a 0.14 m/s contact push at the gate became a 23 m/s backwards flight',
      berm: 'DELETED. Measured tangential gravity at the corridor edge already pulls inward at 2.76-8.11 m/s^2 (mean 5.90); the module berm it replaced was 1.32 m/s^2 nominal and 0.47 m/s^2 in practice. The terrain is the berm; confine.terrainInward_mps2 publishes it',
      treeLine: 'CITED: src/render/main.mjs:330 places pines only at 55 < d < 720',
      firmWidth: 'env.bounds.halfWidth as given; corroborated by main.mjs:101, where the massif ramp ss(120,800,d) starts',
      hardWidth: 'MEASURED: 154 m is the largest whole-metre offset whose worst-over-z divergence stays under 2 m (half the RS-05 ceiling; the half is a CHOICE, its reason is margin for the 1 m sweep resolution and for the LOD model being an approximation), less one STEP_M',
      zHard: 'MEASURED: divergence 0.60 m at z=2750 and 10.59 m at z=2751 (0.75 -> 8.43 at -250 -> -251); the limits sit one STEP_M inside the seam',
      stepMargin: 'V_CAP / 60 Hz = the largest distance a rider can move between two module observations',
      wallAccel: 'V_CAP^2 / (2 * (firmWidth - treeLine)) — brings the worst possible arrival (the speed cap aimed straight out) to rest over the width available, and by construction cannot bind inside the tree line',
      arena: 'V_CAP^2 / (2 * wallAccel); identically firmWidth - treeLine',
      maxVelWrite: 'V_CAP / 0.393, where 0.393 is the MEASURED smallest projected outward coefficient in the enforced region — the largest write legitimate operation can ask for. Its per-frame position effect, 1.40 m, is inside RS-06 by construction',
      streamMax: 'RS-08 max run 260 s / JA-02 min airtime 0.5 s = 520 touchdowns, + 8 fixed events',
      countdown: 'CHOICE: SSX gate convention, one light per second',
      splitCount: 'CHOICE: course quarters, presentation only',
      rank: 'absent by decision: no sourced score ladder exists to band. results.anchors carries the reference bar values instead',
    },
  };

  // ---- centreline: INTERPOLATED between the environment's 25 m samples ----
  // The environment's courseCenterX is cached on a 25 m grid (harness/
  // run-runner.mjs:37), so as given it is a STAIRCASE: with the measured max
  // |dcx/dz| = 0.880, one grid boundary steps the centre by up to 22 m, and the
  // rider's offset jumps that far in a single frame with no lateral motion at
  // all. A corridor built on that staircase spends its life fighting a
  // discontinuity — measured on the previous version of this module, that is
  // exactly where its 2.6 m of wall penetration came from.
  // So the module samples the grid and interpolates linearly between samples:
  // the offset is then continuous, and its rate d|s|/dt = sign(s)*(vx - k*vz)
  // uses the SAME k the position uses, which is what makes the envelope exact
  // rather than approximate.
  // DISCLOSED (header §2): the smooth centre departs from the contract's own
  // quantised |x - courseCenterX(z)| by up to 20 m, and its slope still steps
  // between segments, which is worth up to 0.79 m of unseen offset shift on a
  // boundary-crossing frame. Both are paid for in divergence, and the worst
  // divergence anywhere the corridor permits is 1.20 m against RS-05's 4 m.
  const GRID = 25;
  const cCache = new Map();
  function sampleCenter(k) {
    let v = cCache.get(k);
    if (v === undefined) { v = rawCenter(k); cCache.set(k, v); }
    return v;
  }
  // returns [centre at z, dcentre/dz on this segment]
  function centreAt(z) {
    const i = Math.floor(z / GRID) * GRID;
    const c0 = sampleCenter(i), c1 = sampleCenter(i + GRID);
    const k = (c1 - c0) / GRID;
    return [c0 + k * (z - i), k];
  }

  // Terrain normal by central difference over 0.5 m: past the micro-roll noise,
  // short enough to be the plane the board is actually riding.
  function normalAt(x, z) {
    const e = 0.5;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz) || 1;
    return [-dx / l, 1 / l, -dz / l];
  }

  // ------------------------------------------------------------------ pushes
  // pushAlong takes the DESIRED CHANGE in a corridor rate and delivers exactly
  // that, as a velocity write along the given unit direction (tangent-projected
  // while grounded, so the module can never inject energy through physics'
  // magnitude-preserving surface redirect). `coefOf` is the rate produced per
  // unit velocity along a direction, which is what makes the conversion exact
  // rather than approximate.
  //
  // lateral rate : d|s|/dt = sign(s) * (vx - k*vz)   (k = cx'(z))
  // tangent rate : dz/dt   = vz
  // The directions passed in always point the POSITIVE way for their rate
  // (outward, down-course), so `want` is negative when the module is taking
  // rate away — which is what it does everywhere except a contact recovery.
  function pushAlong(rs, ph, ux, uy, uz, want, coefOf) {
    if (!want) return 0;
    if (ph.onGround) {
      const N = normalAt(ph.pos[0], ph.pos[2]);
      const dn = ux * N[0] + uy * N[1] + uz * N[2];
      let px = ux - dn * N[0], py = uy - dn * N[1], pz = uz - dn * N[2];
      const pl = Math.hypot(px, py, pz);
      if (pl > 1e-6) { ux = px / pl; uy = py / pl; uz = pz / pl; }
    }
    const c = coefOf(ux, uz);
    const cAbs = Math.abs(c);
    if (cAbs < rs.confine.minProjCoef) rs.confine.minProjCoef = cAbs;
    if (cAbs <= 1e-6) { rs.confine.underDelivered++; return 0; }
    let m = want / c;
    // Structural ceiling (header §3). Legitimate operation cannot reach it;
    // ceilFrames exists so that if it ever does, the card says so.
    if (Math.abs(m) > M_CEIL) { m = m < 0 ? -M_CEIL : M_CEIL; rs.confine.ceilFrames++; }
    ph.vel[0] += m * ux; ph.vel[1] += m * uy; ph.vel[2] += m * uz;
    const a = Math.abs(m);
    const c2 = rs.confine;
    c2.velWrite_mps = a;
    if (a > c2.maxVelWrite_mps) c2.maxVelWrite_mps = a;
    c2.active = true;
    return a;
  }

  // ------------------------------------------------------------------- state
  function init() {
    return {
      // ---- contract-required ----
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: 1,                 // single-rider build; no rival field yet
      results: null,
      outOfBounds: false,
      // ---- gate / presentation ----
      stage: 'gate',            // 'gate' | 'running' | 'finished'
      countdown_s: COUNTDOWN_S,
      light: Math.ceil(COUNTDOWN_S),   // lights left: ... 3 | 2 | 1 | 0 (=GO)
      startedBy: null,          // 'gate' | 'past-line'
      gateApplies: null,        // decided once, on the first step
      gateClosed: true,
      progress: 0,
      splits: [],
      nextSplit: 0,
      // ---- checkpoint stream ----
      stream: [],
      streamSeq: 0,
      streamDropped: 0,
      // ---- live telemetry ----
      speed_kmh: 0,
      topSpeed_kmh: 0,
      airTime_s: 0,
      biggestAir_s: 0,
      distanceRidden_m: 0,
      jumps: 0,
      landed: 0,                // the TRICK system's verdict (header §4)
      bailed: 0,
      physClean: 0,
      physSketchy: 0,
      physCrash: 0,
      physUnlabelled: 0,
      disagreements: 0,
      unresolvedAtFinish: 0,
      bestTrick: null,
      bestTrickPoints: 0,
      bestTrickStar: 1,
      lastTrick: null,
      trickyAt_s: null,
      // ---- confinement telemetry (self-measured every frame) ----
      confine: {
        active: false,           // module touched the rider THIS frame
        offset_m: 0,             // |s|, current
        depthLateral_m: 0,       // penetration past the corridor edge, this frame
        depthAlong_m: 0,         // penetration past an along-course barrier
        peakDepthLateral_m: 0,
        peakDepthAlong_m: 0,
        peakOffset_m: 0,
        velWrite_mps: 0,
        maxVelWrite_mps: 0,
        terrainInward_mps2: 0,   // layer 1: the ground's own restoring pull
        minProjCoef: Infinity,   // smallest projected outward coefficient seen
        frames: 0,
        activeFrames: 0,
        activeFraction: 0,
        wallFrames: 0,
        arenaFrames: 0,
        gateFrames: 0,
        hardFrames: 0,           // audited invariant: want 0
        ceilFrames: 0,           // structural write ceiling bound: want 0
        underDelivered: 0,       // degenerate projection: want 0
      },
      // ---- internals ----
      _armed: false,
      _t: 0,
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
      _pending: null,           // touchdown awaiting the trick system's verdict
    };
  }

  // ------------------------------------------------------------------ stream
  function emit(rs, type, data) {
    const e = { seq: rs.streamSeq++, t: +rs.time_s.toFixed(3), type, data };
    if (rs.stream.length >= STREAM_MAX) { rs.stream.shift(); rs.streamDropped++; }
    rs.stream.push(e);
    return e;
  }

  // ------------------------------------------------------------- observation
  function observe(rs, ph, ts, dt) {
    // --- air / jumps ---
    const air = !ph.onGround;
    if (air) {
      rs._airRun += dt;
      rs.airTime_s += dt;
      if (rs._airRun > rs.biggestAir_s) rs.biggestAir_s = rs._airRun;
      if (!rs._wasAir) rs.jumps++;
    } else if (rs._wasAir) {
      // TOUCHDOWN. The trick system froze its verdict this frame and resolves
      // it on its NEXT step, so the ledger waits one frame (header §4).
      rs._pending = {
        award: ts?.lastAward ?? null,
        score: ts?.score ?? 0,
        star: ts?.starMult ?? 1,
        physVerdict: ph.landing ?? null,
        air: rs._airRun,
        settled: false,
      };
    }
    if (!air) rs._airRun = 0;
    rs._wasAir = air;

    // --- ledger: adjudicate the pending touchdown against the trick system ---
    if (rs._pending && rs._pending.settled) {
      const p = rs._pending;
      const la = ts?.lastAward ?? null;
      const banked = !!la && la !== p.award;
      const points = (ts?.score ?? 0) - p.score;
      if (banked) {
        rs.landed++;
        rs.lastTrick = { name: la.name, points, star: p.star };
        if (rs.bestTrick === null || points > rs.bestTrickPoints) {
          rs.bestTrick = la.name; rs.bestTrickPoints = points; rs.bestTrickStar = p.star;
        }
        emit(rs, 'land', { name: la.name, points, star: p.star, air_s: +p.air.toFixed(2) });
      } else {
        rs.bailed++;
        emit(rs, 'bail', { physVerdict: p.physVerdict, air_s: +p.air.toFixed(2) });
      }
      // physics' own tally, kept separate and compared out loud. A touchdown
      // physics did not label is counted as unlabelled and is NOT scored as a
      // disagreement — absence of a verdict is not a contrary verdict.
      if (p.physVerdict === 'crash') rs.physCrash++;
      else if (p.physVerdict === 'sketchy') rs.physSketchy++;
      else if (p.physVerdict === 'clean') rs.physClean++;
      else rs.physUnlabelled++;
      if (p.physVerdict !== null && (p.physVerdict === 'crash') !== !banked)
        rs.disagreements++;
      rs._pending = null;
    } else if (rs._pending) rs._pending.settled = true;

    // --- TRICKY ---
    if (ts?.tricky && rs.trickyAt_s === null) {
      rs.trickyAt_s = +rs.time_s.toFixed(3);
      emit(rs, 'tricky', { letters: ts.trickyLetters ?? 6 });
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

  // ------------------------------------------------------------ confinement
  // gateBar: z of the closed start gate, or null when it is open.
  function confine(rs, ph, dt, gateBar) {
    const c = rs.confine;
    c.frames++;
    c.active = false; c.velWrite_mps = 0; c.terrainInward_mps2 = 0;
    c.depthLateral_m = 0; c.depthAlong_m = 0;

    const x = ph.pos[0], z = ph.pos[2];
    const [centre, k] = centreAt(z);
    const sq = Math.hypot(1, k);
    const s = x - centre;
    const sAbs = Math.abs(s), sgn = s >= 0 ? 1 : -1;
    c.offset_m = sAbs;
    if (sAbs > c.peakOffset_m) c.peakOffset_m = sAbs;

    // unit corridor normal (toward +s) and tangent (down-course)
    const nx = 1 / sq, nz = -k / sq;
    const tx = k / sq, tz = 1 / sq;
    // rate coefficients: the ds/dt (resp. dz/dt) a unit velocity along a
    // direction produces. Functions, so the tangent projection stays exact.
    const coefS = (ux, uz) => sgn * (ux - k * uz);
    const coefZ = (ux, uz) => uz;

    const sDotOut = sgn * (ph.vel[0] - k * ph.vel[2]);   // outward rate, s-space
    const zDot = ph.vel[2];
    const outx = sgn * nx, outz = sgn * nz;              // unit direction of rising |s|

    // ---- layer 1: THE TERRAIN IS THE BERM (header §2) ------------------
    // The module applies NOTHING here. It measures what the ground is already
    // doing, in the shoulder where a berm would have been, and publishes it —
    // so "the terrain is the berm" stays a checkable statement rather than a
    // sentence in a header.
    if (sAbs > TREE_LINE && ph.onGround) {
      const N = normalAt(x, z);
      const g = 9.81, gdn = -g * N[1];
      const gt = [-gdn * N[0], -g - gdn * N[1], -gdn * N[2]];
      const dn = outx * N[0] + outz * N[2];
      let px = outx - dn * N[0], py = -dn * N[1], pz = outz - dn * N[2];
      const pl = Math.hypot(px, py, pz) || 1;
      c.terrainInward_mps2 = -(gt[0] * px + gt[1] * py + gt[2] * pz) / pl;
    }

    // THE CONSTRAINT. Given a closing rate v toward a barrier d ahead, what
    // rate is the rider allowed? One function, used by every barrier in the
    // module — corridor edge, gate bar, backstop, run-out, hard limit.
    //
    //   d > 0, approaching : v <= min( sqrt(2 A d), d/dt )
    //       the energy budget (arrives with zero speed left) AND the step
    //       budget (cannot step past the barrier THIS frame).
    //
    //   d < 0, penetrating : the same budget mirrored — accelerate back in at
    //       A, but never faster than sqrt(2 A |d|), so the rider arrives back
    //       AT the barrier with zero speed instead of being sprung off it.
    //
    //   recover = false for the barriers that run ALONG the course, where the
    //       constraint stops at zero and never reverses the rider (header §2).
    const constrain = (v, d, recover = true) => {
      if (d > 0) {
        const energy = Math.sqrt(2 * A_WALL * d), step = d / dt;
        const allow = energy < step ? energy : step;
        return v > allow ? allow : v;
      }
      if (!recover) return v > 0 ? 0 : v;
      const vAcc = (v > 0 ? 0 : v) - A_WALL * dt;          // kill out, push in
      const vCap = -Math.sqrt(2 * A_WALL * -d);            // return envelope
      return vAcc > vCap ? vAcc : vCap;
    };

    // ---- layer 2: FIRM WALL (self-activating; dead inside the tree line) ----
    {
      const dFirm = W_FIRM - sAbs;
      const want = constrain(sDotOut, dFirm) - sDotOut;
      if (want < 0) {
        pushAlong(rs, ph, outx, 0, outz, want, coefS);
        c.wallFrames++;
        if (dFirm < 0) c.depthLateral_m = -dFirm;
      }
    }

    // ---- the arena along the course: gate bar / backstop / run-out ----
    {
      // down-course barrier: the closed gate bar while it is closed, the
      // run-out wall once it is open. up-course barrier: the backstop.
      const dDown = (gateBar === null ? Z_FIRM_DOWN : gateBar) - z;
      const dUp = z - Z_FIRM_UP;
      const wantDown = constrain(zDot, dDown, false) - zDot;      // <= 0
      const wantUp = -(constrain(-zDot, dUp, false) - -zDot);     // >= 0
      if (wantDown < 0) {
        pushAlong(rs, ph, tx, 0, tz, wantDown, coefZ);
        if (gateBar === null) { c.arenaFrames++; if (dDown < 0) c.depthAlong_m = Math.max(c.depthAlong_m, -dDown); }
        else c.gateFrames++;
      }
      if (wantUp > 0) {
        pushAlong(rs, ph, tx, 0, tz, wantUp, coefZ);
        c.arenaFrames++;
        if (dUp < 0) c.depthAlong_m = Math.max(c.depthAlong_m, -dUp);
      }
    }

    // ---- layer 3: HARD LIMIT — the audited invariant --------------------
    // Same constraint, at the barrier where the divergence budget is actually
    // spent. DISCLOSED (header §2): with layer 2 enforcing exactly this is
    // unreachable from inside the corridor. It is retained as the invariant the
    // module audits itself against every frame (confine.hardFrames) and as the
    // way home for a rider placed outside by something that is not this module.
    {
      const overS = sAbs - W_HARD;
      const overZ = Math.max(z - Z_HARD_DOWN, Z_HARD_UP - z);
      if (overS > 0 || overZ > 0) {
        c.hardFrames++;
        if (overS > 0) {
          pushAlong(rs, ph, outx, 0, outz, constrain(sDotOut, -overS) - sDotOut, coefS);
          c.depthLateral_m = Math.max(c.depthLateral_m, W_HARD - W_FIRM + overS);
        }
        if (overZ > 0) {
          const down = z > Z_HARD_DOWN;
          const v = down ? zDot : -zDot;
          const w = constrain(v, -overZ, false) - v;
          pushAlong(rs, ph, tx, 0, tz, down ? w : -w, coefZ);
          c.depthAlong_m = Math.max(c.depthAlong_m, overZ);
        }
      }
    }

    if (c.depthLateral_m > c.peakDepthLateral_m) c.peakDepthLateral_m = c.depthLateral_m;
    if (c.depthAlong_m > c.peakDepthAlong_m) c.peakDepthAlong_m = c.depthAlong_m;
    if (c.active) c.activeFrames++;
    c.activeFraction = c.frames > 0 ? c.activeFrames / c.frames : 0;
    // outOfBounds is raised on EVERY frame this module touches the rider, the
    // gentlest one included: RS-06's measurement must see every frame in which
    // the module could have moved them.
    rs.outOfBounds = c.active;
  }

  // ---------------------------------------------------------------- results
  function assemble(rs, ts, live) {
    const t = ts ?? {};
    return {
      // ---- contract-required six ----
      time_s: +rs.time_s.toFixed(3),
      score: t.score ?? 0,
      bestTrick: rs.bestTrick,
      tricky: !!t.tricky,
      landed: rs.landed,
      crashed: rs.bailed,
      // ---- the banked award, in full (header §5) ----
      bestAward: rs.bestTrick === null ? null
        : { name: rs.bestTrick, points: Math.round(rs.bestTrickPoints), star: rs.bestTrickStar },
      lastAward: rs.lastTrick === null ? null
        : { name: rs.lastTrick.name, points: Math.round(rs.lastTrick.points), star: rs.lastTrick.star },
      trickyLetters: t.trickyLetters ?? 0,
      trickyAt_s: rs.trickyAt_s,
      meter: +(t.meter ?? 0).toFixed(3),
      // ---- ledger: whose verdict is whose ----
      ledger: {
        adjudicatedBy: 'trick-system',
        landed: rs.landed, bailed: rs.bailed,
        physicsLanding: { clean: rs.physClean, sketchy: rs.physSketchy,
          crash: rs.physCrash, unlabelled: rs.physUnlabelled },
        verdictDisagreements: rs.disagreements,
        disagreementRule: 'counted only on touchdowns physics labelled; unlabelled touchdowns are not disagreements',
        unresolvedAtFinish: rs.unresolvedAtFinish,
      },
      // ---- ride ----
      place: rs.place,
      jumps: rs.jumps,
      topSpeed_kmh: +rs.topSpeed_kmh.toFixed(1),
      avgSpeed_kmh: rs.time_s > 0 ? +(3.6 * rs.distanceRidden_m / rs.time_s).toFixed(1) : 0,
      airTime_s: +rs.airTime_s.toFixed(2),
      biggestAir_s: +rs.biggestAir_s.toFixed(2),
      distanceRidden_m: Math.round(rs.distanceRidden_m),
      courseLength_m: zFinish - zStart,
      splits: rs.splits.map(sp => ({ index: sp.index, z: sp.z, t: +sp.t.toFixed(3) })),
      // ---- confinement, self-measured ----
      confine: {
        activeFraction: +rs.confine.activeFraction.toFixed(4),
        wallFrames: rs.confine.wallFrames,
        arenaFrames: rs.confine.arenaFrames,
        gateFrames: rs.confine.gateFrames,
        hardFrames: rs.confine.hardFrames,
        ceilFrames: rs.confine.ceilFrames,
        underDelivered: rs.confine.underDelivered,
        peakOffset_m: +rs.confine.peakOffset_m.toFixed(2),
        peakDepthLateral_m: +rs.confine.peakDepthLateral_m.toFixed(3),
        peakDepthAlong_m: +rs.confine.peakDepthAlong_m.toFixed(3),
        maxVelWrite_mps: +rs.confine.maxVelWrite_mps.toFixed(4),
        minProjCoef: Number.isFinite(rs.confine.minProjCoef)
          ? +rs.confine.minProjCoef.toFixed(3) : null,
        positionWrites: 0,   // structural: no assignment to ph.pos exists in
        headingWrites: 0,    // this file, and none to ph.heading (header §0);
                             // selftest.mjs diffs both around every step
      },
      // ---- no grade band; the reference bar's real anchors instead ----
      rank: null,
      rankReason: 'no sourced score ladder exists to band — see config.derivation.rank',
      anchors: {
        uberBaseMin: 13210, uberBaseMax: 22580, masterJump: 130000,
        source: 'REFERENCE_BAR.md §5 (JA-16 uber table, JA-18 star arithmetic)',
      },
      startedBy: rs.startedBy,
      live: !!live,
    };
  }

  function finish(rs, ts) {
    if (rs._pending) rs.unresolvedAtFinish = 1;
    const res = assemble(rs, ts, false);
    Object.freeze(res.splits);
    for (const sp of res.splits) Object.freeze(sp);
    Object.freeze(res.ledger); Object.freeze(res.ledger.physicsLanding);
    Object.freeze(res.confine); Object.freeze(res.anchors);
    if (res.bestAward) Object.freeze(res.bestAward);
    if (res.lastAward) Object.freeze(res.lastAward);
    rs.results = Object.freeze(res);
    rs.finished = true;
    rs.phase = 'finished';
    rs.stage = 'finished';
    emit(rs, 'finish', { time_s: res.time_s, score: res.score, bestTrick: res.bestTrick });
  }

  function enterRunning(rs, ph, why) {
    rs.phase = 'running';
    rs.stage = 'running';
    rs.startedBy = why;
    rs.gateClosed = false;
    rs.light = 0;
    rs.time_s = 0;
    rs._prevPos = [ph.pos[0], ph.pos[1], ph.pos[2]];
    rs._wasAir = !ph.onGround;
    emit(rs, 'go', { by: why, z: +ph.pos[2].toFixed(2) });
  }

  // ------------------------------------------------------------------ step
  function step(rs, physState, trickState, dt) {
    const ph = physState;
    if (!ph || !dt) return rs;
    rs._t += dt;

    if (rs.phase === 'ready') {
      // The gate is armed ONCE, on the first step, from where the run finds the
      // rider (header §1).
      if (!rs._armed) {
        rs._armed = true;
        rs.gateApplies = ph.pos[2] < zStart;
        emit(rs, 'armed', { gateApplies: rs.gateApplies, z: +ph.pos[2].toFixed(2) });
      }
      rs.countdown_s = Math.max(0, rs.countdown_s - dt);
      rs.light = Math.ceil(rs.countdown_s);
      rs.time_s = 0;
      if (!rs.gateApplies || rs.countdown_s <= 0) {
        enterRunning(rs, ph, rs.gateApplies ? 'gate' : 'past-line');
        // fall through into the running branch in the same step
      } else {
        rs.gateClosed = true;
        confine(rs, ph, dt, zStart);
        rs.progress = 0;
        return rs;
      }
    }

    if (rs.phase === 'running') {
      rs.time_s += dt;
      observe(rs, ph, trickState, dt);
      rs.progress = clamp((ph.pos[2] - zStart) / (zFinish - zStart), 0, 1);

      while (rs.nextSplit < SPLITS - 1) {
        const zc = zStart + ((rs.nextSplit + 1) / SPLITS) * (zFinish - zStart);
        if (ph.pos[2] < zc) break;
        rs.nextSplit++;
        const sp = { index: rs.nextSplit, z: Math.round(zc), t: rs.time_s };
        rs.splits.push(sp);
        emit(rs, 'split', { index: sp.index, z: sp.z, t: +sp.t.toFixed(3) });
      }

      // FINISH — tested before confinement, so the crossing frame is the frame
      // that reports 'finished' and the run-out can never block the crossing.
      if (ph.pos[2] >= zFinish) {
        rs.progress = 1;
        rs.splits.push({ index: SPLITS, z: zFinish, t: rs.time_s });
        finish(rs, trickState);
        confine(rs, ph, dt, null);
        return rs;
      }
      confine(rs, ph, dt, null);
      return rs;
    }

    // finished: clock frozen, card frozen, corridor still held
    rs.speed_kmh = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]) * 3.6;
    confine(rs, ph, dt, null);
    return rs;
  }

  // Frozen after the finish; a live readback of the same shape before it.
  function results(rs, trickState) {
    return rs.results ?? assemble(rs, trickState, true);
  }

  // Full deterministic reset: every field rebuilt from init().
  function restart(rs) {
    const fresh = init();
    for (const k of Object.keys(rs)) delete rs[k];
    Object.assign(rs, fresh);
    return rs;
  }

  return { config, init, step, results, restart };
}
