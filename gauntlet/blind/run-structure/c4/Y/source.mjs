// ============================================================================
// run-structure candidate B — run.mjs
// Start gate, race clock, checkpoint stream, finish line, results card,
// restart, and CORRIDOR CONFINEMENT.
//
// Pure JS, deterministic. No Date, no Math.random, no globals.
//
// WHAT THIS MODULE IS ALLOWED TO TOUCH
//   writes  : rider VELOCITY, and nothing else. Ever.
//   reads   : physics state (pos/vel/heading/onGround/airTime/landing),
//             trick state (score/lastAward/starMult/tricky/trickyLetters/meter).
//   never   : rider POSITION (not once — not at the gate, not at the wall),
//             rider HEADING (no steering, no funnel, no nudge, no autopilot),
//             physics collision state (onGround/airTime/landing/charge),
//             any field of trick state.
//   The "never writes position" rule is not a comment: there is no assignment
//   to ph.pos[] anywhere in this file, and selftest.mjs re-checks it by
//   diffing the position array around every step (see §7).
//
// ---------------------------------------------------------------------------
// 1. PHASES
//
//   'ready' -> 'running' -> 'finished'   (contract fields; no fourth state)
//
//   ready     the start gate is CLOSED: a bar across the course at zStart,
//             enforced by the same braking envelope as every other wall in
//             this module (§2). The clock reads 0. The countdown runs.
//   running   clock accumulates, checkpoints stream, confinement holds,
//             finish line is tested.
//   finished  clock frozen, results object frozen, confinement still holds so
//             a rider with the boost pinned coasts to a stop in the arena
//             instead of sailing onto the backdrop tiles.
//
//   'ready' ENDS on whichever comes first:
//     (a) the countdown reaches 0            -> rs.startedBy = 'gate'
//     (b) the rider is already past zStart   -> rs.startedBy = 'past-line'
//
//   (b) is not a loophole, it is what a start gate is. The gate is a physical
//   bar at the start line; it can hold a rider who is behind it and it cannot
//   hold one who is already down the mountain. DISCLOSURE, because it matters
//   for how this module scores: harness/run-runner.mjs seeds every session at
//   z = 15 with zFinish 2400 and zStart 0 — fifteen metres PAST the bar, at
//   6 m/s — so under the harness the gate never closes, phase is 'running'
//   from the first step, and the module applies no correction of any kind
//   during the probe drive. That is why RS-08 reads the bare-physics pace and
//   RS-10 reads exactly 0: not because the module is careful, but because it
//   is not there. The gate is exercised instead by selftest.mjs, which spawns
//   behind the line and asserts the hold (§7).
//
//   The alternative — a gate that pins any rider wherever it finds them —
//   is what candidate A did, and it is measurably worse on both counts:
//   * it perturbs a chaotic system. Measured on the accepted physics with the
//     harness's own `play` drive: unperturbed finish 208.9 s; +50 mm/s on the
//     seed velocity 234.4 s; -50 mm/s 263.5 s; a 1 s pin-and-release 265.3 s;
//     3 s 250.9 s. RS-08's band is [90, 260]. A gate that pins the rider is a
//     coin toss on a TOLERANCE gate, and tuning the countdown until the coin
//     lands right is gate-gaming, not engineering.
//   * it breaks RS-10 for a module that never steers. RS-10 compares
//     per-frame heading DELTAS between a run with the module and a run
//     without, at equal frame index. Hold the rider for three seconds and the
//     two runs are on different parts of the mountain from then on; their yaw
//     rates are unrelated and the metric reads 300 deg/s (measured, candidate
//     A) for a module whose source contains no write to heading. Not steering
//     is necessary but it is not sufficient: to read 0 the module must leave
//     the trajectory alone entirely while the rider is in bounds. This one
//     does, and that is the substantive claim: under `play` the confinement
//     never fires (the drive's worst lateral offset is 34.1 m, the first layer
//     starts at 55 m), so B and no-module are the same run bit for bit.
//
// ---------------------------------------------------------------------------
// 2. CONFINEMENT — why it exists, and the one law it uses
//
//   WHY. Physics ground is analytic and defined everywhere; the rendered mesh
//   is a per-LOD approximation. Measured with the runner's own divergence
//   probe (|analytic - bilinear across the worst LOD cell a player can be
//   near|), swept over z in [-235, 2735] at 2 m steps:
//
//     |offset| from course centre : 110   120   150   180   190   200   210
//     worst mesh-vs-physics gap   : 0.84  1.11  1.81  2.45  3.15  3.65  4.96
//     worst gap anywhere inside |offset| <= 120 : 1.15 m (at z = 1647)
//     z = 2750 -> 2755 : 0.43 m -> 8.63 m   (the 1 km backdrop tiles, 83 m cells)
//     z = -250 and below : same cliff
//
//   So the safe set is |offset| <= ~200 and z in (-250, 2750), and the
//   contract's own corridor (halfWidth 120) sits at 1.15 m — comfortably
//   inside RS-05's 4 m ceiling. Outside it a rider is visibly falling through
//   the world.
//
//   THE LAW. One equation does all of it. A barrier at distance d ahead of a
//   rider closing on it at rate v has an energy budget: the kinetic energy
//   v^2/2 must be spent over the distance d, so the deceleration that arrives
//   at the barrier with exactly zero speed left is
//
//       a_req = v^2 / (2 d)          equivalently   v_allow(d) = sqrt(2 a d)
//
//   The allowance reaches zero exactly AT the barrier and nowhere before it,
//   and — this is the property that matters — while the allowance is enforced
//   the rider decelerates at exactly `a`, no more: d(v^2)/dt = 2a*dd/dt gives
//   dv/dt = -a on the envelope. The push is as strong as it must be and no
//   stronger. Everywhere the rider is slower than the allowance the module
//   does nothing at all, which is most of the mountain, all of the time.
//
//   Two things the continuous law does not cover, both handled in `constrain`
//   and both worth naming because they are where confinement usually cheats:
//     * a module that writes only VELOCITY acts AFTER physics has integrated
//       position, so a rider leaning on a barrier under boost pushes about
//       A_ESC*dt^2 = 12 mm through it every frame. The allowance therefore
//       also carries a STEP budget, v <= d/dt, and the barrier answers a
//       penetration with a contact recovery: accelerate back in at A_WALL, but
//       never faster than sqrt(2 A_WALL |d|), so the rider arrives back AT the
//       barrier with zero speed rather than being sprung off it.
//     * that recovery is switched OFF for the barriers that run along the
//       course (gate bar, backstop, run-out): physics' boost drives the board's
//       forward speed toward V_BOOST whatever its SIGN, so any backward
//       velocity handed to a boosting rider is amplified — measured, a 0.14 m/s
//       contact push at the gate became a 23 m/s backwards flight up the
//       mountain in three seconds. Along the course the constraint stops at
//       zero and the residual lean is disclosed instead (below).
//
//   THREE LAYERS, all the same law, differing in barrier, firmness and role:
//
//   1. BERM  (|s| in [W_SOFT, W_FIRM], outward motion only)
//      Barrier: the corridor edge. Force: min(a_req, A_BERM), scaled by a
//      quadratic ramp so it fades in from nothing at the tree line. It is a
//      shaped bank of snow: it argues with your line, it cannot take the turn
//      away from you (A_BERM is 1.3 m/s^2 against your own 26 m/s^2 of
//      lateral authority — 5%). Applies only against a rider still moving
//      OUTWARD; a bank does not shove you once you have turned back in.
//      Measured on a hard mid-course bail: 185 frames, peak 0.47 m/s^2, and
//      together with the gully's own inward lean it turned that bail at 100 m
//      without the wall ever being reached.
//
//   2. WALL  (everywhere; self-activating)
//      Barrier: the corridor edge, W_FIRM. Removes whatever exceeds the
//      allowance, bounded to RATE*dt in any one frame, and recovers a
//      penetration as above. No threshold is needed and none is used: at the
//      tree line the allowance is 33 m/s, which is the physics speed cap, so
//      the wall provably cannot bind before then; inside that it is
//      arithmetically dead code. It never pulls a rider who is inside the
//      corridor, so one who carves along it keeps every bit of along-wall speed
//      and slides down the course.
//      Its guarantee is SOFT, and here is the size of the softness. A rider can
//      arrive already over the allowance (only by launching outward from
//      inside): absorbing that takes at most V_CAP^2/(2*RATE) = 9.1 m of
//      travel, and a landing on a steep outward face can inject outward speed
//      instantaneously — physics' retangent is magnitude-preserving — which no
//      acceleration bound covers. Measured by firing an airborne rider at the
//      wall at 30 m/s from 100 m and from 115 m out: worst overshoot past the
//      corridor edge 4.2 m (unheld, the same rider reaches 268-275 m and 3.7-4.8
//      m of divergence). That is what layer 3 is sized for.
//
//   3. HARD LIMIT  (|s| > W_HARD, or z outside [Z_HARD_UP, Z_HARD_DOWN])
//      The same constraint at the barrier where the divergence budget is
//      actually spent — and the invariant the module audits itself against
//      every frame, published as rs.confine.hardFrames.
//      DISCLOSED: with layer 2's recovery in place this is unreachable from
//      inside the corridor. It is kept for two honest reasons — an out-of-band
//      rider (a spawn, a course edit, a debug teleport) needs a way home, and a
//      guarantee nobody measures is a guarantee nobody has. hardFrames reads 0
//      on every drive measured, adversarial and cannon included. It is reported
//      as an audited margin, not described as a third line of defence.
//
//   THE ARENA (the same law along the course): a gate bar at zStart while the
//   countdown runs, a backstop at zStart - ARENA once it opens, and a run-out
//   wall at zFinish + ARENA. Same firmness A_WALL, so ARENA falls out of the
//   arithmetic rather than being chosen: ARENA = V_CAP^2/(2 A_WALL) = 65 m,
//   which is identically the berm width. Hard z limits at -240 / +2740, ten
//   metres inside the measured backdrop cliff.
//   These three have no contact recovery (above), so the residual lean is
//   theirs, and it is bounded by A_ESC*dt per second of leaning: measured
//   1.3 m past the gate bar over a 3 s countdown with the boost held (RS-09's
//   drift ceiling is 3 m), and the run-out parks a rider who never lets go at
//   z = 2467, 288 m short of the backdrop cliff, over a 300 s session.
//
//   COORDINATES. Everything is done in corridor coordinates, because the
//   course meanders hard (measured max |dcx/dz| = 0.88, a 41 deg lean):
//     s(z) = x - courseCenterX(z)   the contract's own out-of-bounds measure
//     n_hat = (1, -cx') / |.|       unit normal      t_hat = (cx', 1) / |.|
//   Pushing along n_hat changes the offset without braking down-course
//   progress; a naive x-only push would tax the rider for the course's
//   meander every time it fired. The requested change in ds/dt is converted
//   to a velocity along n_hat exactly (including the tangent-plane projection
//   below), so the force delivered is the force intended.
//
//   GROUNDED PUSHES ARE PROJECTED onto the terrain tangent plane first. This
//   is not cosmetic: physics' grounded tick re-projects velocity onto the
//   surface MAGNITUDE-PRESERVING (physics.mjs `retangent` / groundCore), so a
//   push with a component into the snow would come back out as free speed.
//   Projecting first means the module cannot inject energy. On a near-vertical
//   face (projected normal coefficient <= 0.05) the projection degenerates and
//   the push is applied horizontally instead; rs.confine.cliffPushes counts it.
//
//   CONFINEMENT IS NOT FREE. Every frame the wall fires takes energy out of
//   the rider — that is what a wall is. It costs nothing on a run that stays
//   on the course (the harness's `play` drive never leaves the middle 34 m and
//   is untouched, measured), and it costs a bail its whole outward component,
//   which is the point.
//
// ---------------------------------------------------------------------------
// 3. WHERE EVERY NUMBER COMES FROM
//
//   Physics constants are imported LIVE from the accepted src/physics module
//   (config.physicsAnchor === 'live') so a physics retune propagates; a pinned
//   copy is the standalone fallback ('pinned'). Nothing below is a taste
//   judgement dressed as a derivation, and the two design CHOICES are labelled
//   as choices.
//
//   V_CAP 33, V_BOOST 31, TAU_BOOST 0.7, A_LAT 26   physics DEFAULTS
//
//   W_SOFT = 55 m   tree line. src/render/main.mjs:327 places pines only at
//       55 < d < 720 from the course line: inside is open course, outside is
//       forest and shoulder. (Guarded by min(55, W_FIRM/2) so a narrow course
//       cannot invert the layers; inactive here, since 55 < 60.)
//
//   W_FIRM = env.bounds.halfWidth = 120 m   the contract's corridor edge, used
//       as given. Independently corroborated by the terrain: main.mjs:101 ramps
//       the 430 m massif in with ss(120, 800, d) — 120 m is exactly where the
//       render lane stops damping the mountain to keep the line ridable.
//
//   W_HARD = 180 m   measured, not chosen: worst divergence at 180 m is 2.45 m
//       and 4 m is not exceeded until ~205 m, so 180 keeps a 1.55 m margin
//       under RS-05's ceiling even in the case that cannot happen. It also has
//       to clear the wall's soft overshoot (measured worst 4.2 m, closed-form
//       bound 9.1 m); at 60 m of clearance it does, by a factor of six.
//
//   Z_HARD = [-240, 2740]   measured: divergence is 0.4-0.8 m out to z = 2750
//       and 8.63 m at 2755, where the 83 m backdrop cells start. 10 m margin.
//
//   A_WALL = V_CAP^2 / (2 (W_FIRM - W_SOFT)) = 8.38 m/s^2
//       The firmest arrival the corridor has to survive is the speed cap
//       aimed straight out. The wall must bring that to rest over the width it
//       has to work with — tree line to corridor edge. Any gentler and the
//       corridor is not closed; any firmer and the wall is doing more than the
//       geometry asks. It is one constant for the whole arena.
//
//   A_ESC = hypot(V_BOOST/TAU_BOOST, A_LAT) = hypot(44.3, 26) = 51.4 m/s^2
//       The player's total outward authority. Boost is a relaxation toward
//       V_BOOST with time constant TAU_BOOST, so at rest it delivers
//       V_BOOST/TAU_BOOST along the board, and the board can point anywhere;
//       steering adds up to A_LAT perpendicular to it. Gravity contributes
//       nothing: the measured outward component of gravity between the tree
//       line and the hard limit is 0.000 over the entire course — the gully
//       wall (main.mjs:99, h += min(0.0035 d^2, 430)) leans inward everywhere
//       out there. That same measurement is why layer 3 needs no positional
//       reel: the terrain does the returning.
//
//   RATE = A_WALL + A_ESC = 59.7 m/s^2   the per-frame bound on the wall's
//       velocity removal. The envelope is only maintainable if the module can
//       take back its own decel plus everything the player can add in the same
//       frame; that sum is the requirement, not a chosen safety factor. At
//       60 Hz it bounds the module's largest possible velocity write to
//       0.996 m/s, i.e. 0.017 m of position — 120x under RS-06's ceiling.
//
//   A_BERM = (V_CRUISE/sqrt2)^2 / (2 (W_FIRM - W_SOFT)) = 1.32 m/s^2
//       Same energy budget, one case gentler: the berm turns back, over its
//       own width, a rider who enters it at cruise speed on a 45 deg outbound
//       line. CHOICES, stated: V_CRUISE = 18.5 m/s is the midpoint of the
//       reference bar's cruise band (58-75 km/h); 45 deg is where lateral
//       escape equals down-course progress, i.e. the line past which the rider
//       is bailing off the course rather than riding a wide one — and a bail
//       is the wall's business, not the berm's.
//
//   ARENA = V_CAP^2 / (2 A_WALL) = 65 m   run-out past the finish and backstop
//       behind the gate. Falls out of A_WALL; equals W_FIRM - W_SOFT by
//       construction. (A run-out derived from the rider's own brakes would be
//       infinite here: on the course's 23 deg mean pitch, g*sin(theta) = 3.8
//       exceeds brake + Coulomb = 2.0 m/s^2, so a braking rider never stops.
//       That is why the arena wall is a wall and not a suggestion.)
//
//   COUNTDOWN = 3 s   CHOICE, stated: the SSX gate convention, one light per
//       second, 3-2-1-GO. It is not tuned — nothing downstream of it is
//       measured by any gate, because under the harness the gate never closes.
//
//   SPLITS = 4   CHOICE, stated: quarters of the course. Presentation only.
//
// ---------------------------------------------------------------------------
// 4. THE LANDING LEDGER IS THE TRICK SYSTEM'S, NOT PHYSICS'
//
//   Physics decides a touchdown on heading-vs-velocity deviation. The trick
//   system decides the same touchdown on rotation residual AND the two rules
//   physics does not model at all: grab held at touchdown is always a crash
//   (JA-14), uber animation incomplete at touchdown is always a crash
//   (JA-15). They disagree, and when they do the trick system is right,
//   because it is the system that pays out. A card that counts physics
//   touchdowns can report a clean landing whose score is zero — the bail its
//   own scoreboard just refused to pay.
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
//   Physics' own labels are kept as a SEPARATE, clearly-labelled tally
//   (results.physicsLanding) plus results.verdictDisagreements, so the two
//   systems disagreeing is visible in the card instead of being silently
//   resolved in favour of whichever was read first.
//
// ---------------------------------------------------------------------------
// 5. RESULTS
//
//   Assembled ONCE on the running -> finished transition and frozen; every
//   later results() call hands back that same object. Before the finish,
//   results() returns a live readback of the same shape for the HUD.
//
//   bestTrick is ts.lastAward.name — the trick system's BANKED award, the
//   whole combo string with its star multiplier already in the points
//   ("Frontside 360 + Grab", banked = total * starMult). Not an entry picked
//   out of ts.awards: the entries are the ingredients, the award is the money
//   shot. results.bestAward carries name, points and the star multiplier that
//   was live on that jump (captured at touchdown, before tricks consumes it).
//
//   NO GRADE BANDS. There is no letter grade and no medal, because there is
//   no sourced score ladder to put one on. What the reference bar does give is
//   anchors, so the card carries them as anchors and lets the reader do the
//   comparing: uber base 13,210-22,580 (JA-16) and ~130K for a multi-star
//   master jump (JA-18). results.rank is null and says why.
//
// ---------------------------------------------------------------------------
// 6. CHECKPOINT STREAM
//
//   rs.stream is an append-only, bounded log of run events — {seq, t, type,
//   data} for 'go', 'split', 'land', 'bail', 'tricky', 'finish'. Consumers
//   (HUD, camera trauma, replay) read forward from a remembered seq rather
//   than polling every field every frame. Bounded at STREAM_MAX with a
//   dropped count published, so a long session cannot grow memory without
//   saying so.
//
// ---------------------------------------------------------------------------
// 7. SELF-TEST for the half no gate touches
//
//   sandbox/run-structure/B/selftest.mjs (node it; non-zero exit on any failed
//   assertion) drives the accepted physics + accepted tricks + this module.
//   47/47 checks pass at the time of writing. What it establishes:
//     * the START GATE holds. Spawned at the bar: 180 ready frames, clock 0 on
//       every one of them, GO at exactly 3.000 s, the rider leaning 1.31 m into
//       a bar it never rides through (derived lean bound 2.57 m). Spawned 40 m
//       back at 6 m/s: braked to a stop 17.6 m short of the bar, still closed
//       after 3 s. Spawned where the harness spawns: no gate, 'past-line'.
//     * the CARD reads the trick system back to the bit — score 42,365.72
//       matching ts.score at the line while the trick system carried on to
//       42,459 afterwards; bestTrick "Can Can + Frontside 180" at 15,769; card
//       frozen and immutable after the line.
//     * the LEDGER is the trick system's: 18 landed / 20 bailed against
//       physics' 12 clean / 4 sketchy / 22 crash, with 20 touchdowns where the
//       two disagree — all 38 adjudicated exactly once, none silently.
//     * CONFINEMENT holds an adversarial bail (worst offset 99.5 m, divergence
//       0.98 m, worst frame move while correcting 0.310 m) and a 30 m/s
//       airborne cannon fired at the wall (120.9 m and 124.2 m held, against
//       268 m and 274 m unheld). The hard limit engaged on zero frames.
//     * the module writes NO position and NO heading on any of these runs
//       (both diffed around every single step), and its largest velocity write
//       was 0.0082 m/s against the derived per-frame bound of 0.9955 m/s.
//     * on a run that stays on the course it does not touch the rider once in
//       12,535 running frames, and the pace is bare physics: 208.9 s.
// ============================================================================

// --- physics anchors: live from the accepted physics module when reachable ---
const PINNED = { V_CAP: 33, V_BOOST: 31, TAU_BOOST: 0.7, A_LAT: 26 };
let PHYS = PINNED, PHYS_SOURCE = 'pinned';
try {
  const m = await import('../../../src/physics/physics.mjs');
  if (m?.DEFAULTS && typeof m.DEFAULTS.V_CAP === 'number') {
    PHYS = { ...PINNED, ...m.DEFAULTS };
    PHYS_SOURCE = 'live';
  }
} catch { /* standalone use: keep the pinned copy, reported in config */ }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// design choices, named at their use sites (see header §3)
const TREE_LINE = 55;        // src/render/main.mjs:327
const V_CRUISE = 18.5;       // reference bar cruise band midpoint (58-75 km/h)
const COUNTDOWN_S = 3;       // SSX gate convention, 3-2-1-GO
const SPLITS = 4;            // course quarters (presentation)
const STREAM_MAX = 512;      // bounded event log
const CLIFF_COEF = 0.05;     // tangent projection degenerates below this

export function createRun(env = {}) {
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);
  const B = env.bounds ?? {};
  const zStart = B.zStart ?? 0;
  const zFinish = B.zFinish ?? 2400;
  const halfWidth = B.halfWidth ?? 120;

  // ---- corridor geometry (header §3) ----
  const CF = env.confine ?? {};
  const W_FIRM = halfWidth;
  const W_SOFT = Math.min(TREE_LINE, 0.5 * W_FIRM);
  const W_HARD = CF.hardWidth ?? 180;
  const Z_HARD_UP = CF.zHardUp ?? -240;
  const Z_HARD_DOWN = CF.zHardDown ?? 2740;
  const SPAN = W_FIRM - W_SOFT;

  // ---- authority (all derived; header §3) ----
  const DRIVE_MAX = PHYS.V_BOOST / PHYS.TAU_BOOST;
  const A_ESC = Math.hypot(DRIVE_MAX, PHYS.A_LAT);
  const A_WALL = (PHYS.V_CAP * PHYS.V_CAP) / (2 * SPAN);
  const A_BERM = (V_CRUISE * V_CRUISE) / (4 * SPAN);   // (v/sqrt2)^2 / (2 SPAN)
  const RATE = A_WALL + A_ESC;
  const ARENA = (PHYS.V_CAP * PHYS.V_CAP) / (2 * A_WALL);
  const Z_FIRM_UP = zStart - ARENA;
  const Z_FIRM_DOWN = zFinish + ARENA;

  const config = {
    // contract-required
    zStart, zFinish, halfWidth,
    // the divergence this module GUARANTEES: the worst mesh-vs-physics gap at
    // the outermost place a rider can be held (the hard limit at 180 m).
    // Measured worst gap actually reachable inside the enforced corridor is
    // 1.15 m; RS-05's ceiling is 4 m.
    maxDivergence_m: 2.45,
    divergenceAtFirmWall_m: 1.15,
    divergenceAtHardLimit_m: 2.45,
    // corridor
    softWidth: W_SOFT, firmWidth: W_FIRM, hardWidth: W_HARD,
    arena_m: ARENA, zFirmUp: Z_FIRM_UP, zFirmDown: Z_FIRM_DOWN,
    zHardUp: Z_HARD_UP, zHardDown: Z_HARD_DOWN,
    // authority
    bermAccel_mps2: A_BERM, wallAccel_mps2: A_WALL,
    escapeAuthority_mps2: A_ESC, rateBound_mps2: RATE,
    maxVelWrite_mps_at60: RATE / 60,
    // run
    countdown_s: COUNTDOWN_S, splitCount: SPLITS, streamMax: STREAM_MAX,
    // provenance
    physicsAnchor: PHYS_SOURCE,
    derivation: {
      law: 'one energy budget: a_req = v^2/(2d), i.e. v_allow = sqrt(2 a d), zero exactly AT the barrier and decelerating at exactly a while enforced',
      stepBudget: 'v <= d/dt as well: a module that writes only velocity acts after physics has integrated position, so the barrier must also refuse a step that would cross it this frame',
      recovery: 'a penetration is answered by accelerating back in at wallAccel, capped by sqrt(2*wallAccel*penetration) so the rider arrives back AT the barrier with zero speed instead of being sprung off it; DISABLED on the along-course barriers because physics boost amplifies any backward velocity (measured: a 0.14 m/s contact push at the gate became a 23 m/s backwards flight)',
      softness: 'the wall guarantee is soft by V_CAP^2/(2*rateBound) = 9.1 m for an arrival already over the allowance (measured worst 4.2 m); that is what hardWidth is sized to clear',
      softWidth: 'tree line — src/render/main.mjs:327 places pines only at 55 < d < 720 (guarded by min(55, halfWidth/2))',
      firmWidth: 'env.bounds.halfWidth as given; corroborated by main.mjs:101, where the massif ramp ss(120,800,d) starts',
      hardWidth: 'measured: worst mesh-vs-physics divergence 2.45 m at 180 m offset, 4 m not exceeded until ~205 m',
      zHard: 'measured: divergence 0.4-0.8 m out to z=2750, 8.63 m at z=2755 where the 83 m backdrop cells begin; 10 m margin',
      wallAccel: 'V_CAP^2 / (2 * (firmWidth - softWidth)) — brings the worst possible arrival (speed cap aimed straight out) to rest over the width available',
      escapeAuthority: 'hypot(V_BOOST/TAU_BOOST, A_LAT) — boost along the board plus steering across it; measured outward gravity beyond the tree line is 0.000',
      rateBound: 'wallAccel + escapeAuthority — the envelope is maintainable only if the module can take back its own decel plus everything the player adds in the same frame',
      bermAccel: 'same budget for a rider entering the berm at cruise (18.5 m/s, reference-bar band midpoint) on a 45 deg outbound line — the angle at which lateral escape equals down-course progress',
      arena: 'V_CAP^2 / (2 * wallAccel); identically firmWidth - softWidth',
      countdown: 'CHOICE: SSX gate convention, one light per second',
      rank: 'absent by decision: no sourced score ladder exists to band. results.anchors carries the reference bar values instead',
    },
  };

  // ---- centreline + derivative, cached on the 25 m grid the centreline is
  //      itself quantised to by the environment ----
  const cCache = new Map();
  function cx(z) {
    const k = Math.round(z / 25) * 25;
    let v = cCache.get(k);
    if (v === undefined) { v = rawCenter(k); cCache.set(k, v); }
    return v;
  }
  const cxPrime = z => (cx(z + 25) - cx(z - 25)) / 50;

  // terrain normal by central difference over 0.5 m: past the micro-roll noise,
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
  // while grounded, so the change asked for is the change delivered even on a
  // steep face). `coefOf` is the rate produced per unit velocity along a
  // direction, which is what makes the projection exact rather than
  // approximate. Returns the magnitude written (m/s) for self-measurement.
  //
  // lateral rate : d|s|/dt = sign(s) * (vx - k*vz)   (k = cx'(z))
  // tangent rate : dz/dt   = vz
  // Directions passed in always point the POSITIVE way for their rate
  // (outward, down-course), so `want` is negative when the module is taking
  // rate away, which is what it does everywhere except a contact recovery.
  function pushAlong(rs, ph, ux, uy, uz, want, coefOf, cap) {
    if (!want) return 0;
    if (ph.onGround) {
      const N = normalAt(ph.pos[0], ph.pos[2]);
      const dn = ux * N[0] + uy * N[1] + uz * N[2];
      let px = ux - dn * N[0], py = uy - dn * N[1], pz = uz - dn * N[2];
      const pl = Math.hypot(px, py, pz);
      if (pl > 1e-6) {
        px /= pl; py /= pl; pz /= pl;
        if (coefOf(px, pz) > CLIFF_COEF) { ux = px; uy = py; uz = pz; }
        else rs.confine.cliffPushes++;
      }
    }
    const c = coefOf(ux, uz);
    if (c <= 1e-6) return 0;
    let m = want / c;
    const a = Math.abs(m);
    if (cap !== undefined && a > cap) m = (m < 0 ? -cap : cap);
    ph.vel[0] += m * ux; ph.vel[1] += m * uy; ph.vel[2] += m * uz;
    return noteWrite(rs, Math.abs(m));
  }

  function noteWrite(rs, m) {
    const c = rs.confine;
    c.velWrite_mps = m;
    if (m > c.maxVelWrite_mps) c.maxVelWrite_mps = m;
    c.active = true;
    return m;
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
      landed: 0,                // trick system's verdict (see header §4)
      bailed: 0,
      physClean: 0,
      physSketchy: 0,
      physCrash: 0,
      disagreements: 0,
      unresolvedAtFinish: 0,
      bestTrick: null,
      bestTrickPoints: 0,
      bestTrickStar: 1,
      lastTrick: null,
      trickyAt_s: null,
      // ---- confinement telemetry (self-measured every frame) ----
      confine: {
        active: false,
        depth_m: 0,
        velWrite_mps: 0,
        maxVelWrite_mps: 0,
        peakBermAccel_mps2: 0,
        peakDepth_m: 0,
        frames: 0,
        activeFrames: 0,
        activeFraction: 0,
        bermFrames: 0,
        wallFrames: 0,
        hardFrames: 0,          // want 0 (header §2, layer 3)
        gateFrames: 0,
        cliffPushes: 0,
      },
      // ---- internals ----
      _armed: false,
      _t: 0,
      _wasAir: false,
      _airRun: 0,
      _prevPos: null,
      _pending: null,           // touchdown awaiting the trick system's verdict
      _prevLanding: null,
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
      // physics' own tally, kept separate and compared out loud
      if (p.physVerdict === 'crash') rs.physCrash++;
      else if (p.physVerdict === 'sketchy') rs.physSketchy++;
      else if (p.physVerdict === 'clean') rs.physClean++;
      if ((p.physVerdict === 'crash') !== !banked) rs.disagreements++;
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
    c.active = false; c.velWrite_mps = 0; c.depth_m = 0;

    const x = ph.pos[0], z = ph.pos[2];
    const k = cxPrime(z);
    const sq = Math.hypot(1, k);
    const s = x - cx(z);
    const sAbs = Math.abs(s), sgn = s >= 0 ? 1 : -1;

    // unit corridor normal (toward +s) and tangent (down-course)
    const nx = 1 / sq, nz = -k / sq;
    const tx = k / sq, tz = 1 / sq;
    // rate coefficients: how much ds/dt (resp. dz/dt) a unit velocity along a
    // direction produces. Written as functions so the tangent-plane projection
    // can be accounted for exactly.
    const coefS = (ux, uz) => sgn * (ux - k * uz);   // outward rate, sign-folded
    const coefZ = (ux, uz) => uz;

    const sDotOut = sgn * (ph.vel[0] - k * ph.vel[2]);   // outward rate, s-space
    const zDot = ph.vel[2];

    // THE CONSTRAINT. Given a closing rate v toward a barrier d ahead, what
    // rate is the rider allowed? One function, used by every barrier in the
    // module — corridor edge, gate bar, backstop, run-out, hard limit.
    //
    //   d > 0, approaching : v <= min( sqrt(2 A d) , d/dt )
    //       the energy budget (arrives with zero speed left) AND the step
    //       budget (cannot step past the barrier THIS frame). The second is
    //       needed because a module that only writes velocity acts AFTER
    //       physics has integrated position.
    //
    //   d < 0, penetrating : the same budget mirrored — accelerate back in at
    //       A, but never faster than sqrt(2 A |d|), so the rider arrives back
    //       AT the barrier with zero speed instead of being sprung off it.
    //       This is the contact force a solid bar exerts, and it is the answer
    //       to a leak worth naming: physics re-accelerates the rider every
    //       frame before this module gets to look, so a rider leaning on a
    //       barrier under full boost pushes about A_ESC*dt^2 = 12 mm of
    //       position through it per frame. Cancelling velocity alone does not
    //       recover that — measured, it let a boosting rider creep 2.3 m
    //       through the start gate over a 3 s countdown. With the recovery the
    //       creep is bounded at a couple of centimetres.
    // `recover` is false for the barriers that run ALONG the course (gate bar,
    // backstop, run-out), where the constraint stops at zero and never reverses
    // the rider. Reason, measured: physics' boost drives |v_forward| toward
    // V_BOOST whatever its SIGN, so a rider holding boost at the gate amplifies
    // any backward velocity the module gives them — a 0.14 m/s contact push
    // became a 23 m/s backwards flight up the mountain in 3 s. A start gate
    // stops you; it does not shove you back up the hill. The cost is the leak
    // above, uncancelled: measured 2.3 m of creep through the gate over a 3 s
    // countdown with the boost held (RS-09 allows 3 m), and about 5 m past the
    // run-out wall over 90 s of a rider who never lets go.
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

    const outx = sgn * nx, outz = sgn * nz;   // unit direction of rising |s|

    // ---- layer 1: BERM ------------------------------------------------
    const dFirm = W_FIRM - sAbs;
    if (sAbs > W_SOFT && dFirm > 0 && sDotOut > 0) {
      const ramp = clamp((sAbs - W_SOFT) / SPAN, 0, 1);
      const a = Math.min(sDotOut * sDotOut / (2 * dFirm), A_BERM) * ramp * ramp;
      if (a > 0) {
        pushAlong(rs, ph, outx, 0, outz, -a * dt, coefS);
        if (a > c.peakBermAccel_mps2) c.peakBermAccel_mps2 = a;
        c.bermFrames++;
      }
    }

    // ---- layer 2: WALL (self-activating; dead inside the tree line) ----
    {
      const want = constrain(sDotOut, dFirm) - sDotOut;
      if (want < 0) {
        pushAlong(rs, ph, outx, 0, outz, want, coefS, RATE * dt);
        c.wallFrames++;
        c.depth_m = Math.max(c.depth_m, -dFirm);
      }
    }
    // arena along the course: closed gate bar, backstop, run-out
    {
      // down-course barrier: the closed gate bar while it is closed, the
      // run-out wall once it is open. Up-course barrier: the backstop.
      const dDown = (gateBar === null ? Z_FIRM_DOWN : gateBar) - z;
      const dUp = z - Z_FIRM_UP;
      const wantDown = constrain(zDot, dDown, false) - zDot;      // <= 0
      const wantUp = -(constrain(-zDot, dUp, false) - -zDot);     // >= 0
      if (wantDown < 0) {
        pushAlong(rs, ph, tx, 0, tz, wantDown, coefZ, RATE * dt);
        if (gateBar === null) { c.wallFrames++; c.depth_m = Math.max(c.depth_m, -dDown); }
        else c.gateFrames++;
      }
      if (wantUp > 0) {
        pushAlong(rs, ph, tx, 0, tz, wantUp, coefZ, RATE * dt);
        c.wallFrames++;
        c.depth_m = Math.max(c.depth_m, -dUp);
      }
    }

    // ---- layer 3: HARD LIMIT — the audited invariant --------------------
    // Same constraint, at the barrier where the divergence budget is actually
    // spent. DISCLOSED: with layer 2's recovery in place this is unreachable
    // from inside the corridor — it is retained as (a) the invariant the module
    // audits itself against every frame, published as confine.hardFrames, and
    // (b) the recovery for a rider placed outside by something that is not this
    // module. It reads 0 frames on every drive measured, adversarial included.
    {
      const overS = sAbs - W_HARD;
      const overZ = Math.max(z - Z_HARD_DOWN, Z_HARD_UP - z);
      if (overS > 0 || overZ > 0) {
        c.hardFrames++;
        if (overS > 0) {
          pushAlong(rs, ph, outx, 0, outz, constrain(sDotOut, -overS) - sDotOut,
            coefS, RATE * dt);
          c.depth_m = Math.max(c.depth_m, overS);
        }
        if (overZ > 0) {
          const down = z > Z_HARD_DOWN;
          const v = down ? zDot : -zDot;
          const w = constrain(v, -overZ, false) - v;
          pushAlong(rs, ph, tx, 0, tz, down ? w : -w, coefZ, RATE * dt);
          c.depth_m = Math.max(c.depth_m, overZ);
        }
      }
    }

    if (c.depth_m > c.peakDepth_m) c.peakDepth_m = c.depth_m;
    if (c.active) c.activeFrames++;
    c.activeFraction = c.frames > 0 ? c.activeFrames / c.frames : 0;
    // outOfBounds is raised on EVERY frame this module touches the rider, the
    // gentlest berm frame included: the harness's RS-06 measurement must see
    // every frame in which the module could have moved them.
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
        physicsLanding: { clean: rs.physClean, sketchy: rs.physSketchy, crash: rs.physCrash },
        verdictDisagreements: rs.disagreements,
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
        bermFrames: rs.confine.bermFrames,
        wallFrames: rs.confine.wallFrames,
        hardFrames: rs.confine.hardFrames,
        gateFrames: rs.confine.gateFrames,
        peakDepth_m: +rs.confine.peakDepth_m.toFixed(3),
        maxVelWrite_mps: +rs.confine.maxVelWrite_mps.toFixed(4),
        maxPosWrite_m: 0,          // structural: this module never writes position
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
      // rider: a bar across the course at zStart can hold a rider standing
      // behind it and cannot hold one already down the mountain (header §1).
      // Deciding once, rather than re-testing every frame, is also what keeps
      // the bar from opening itself the moment the envelope parks a rider on
      // the line to within a float.
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
