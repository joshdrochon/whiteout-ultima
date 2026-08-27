# Gauntlet Contracts

Fixed interfaces every Builder candidate must implement, so the harness and Critic can
treat candidates as interchangeable black boxes. Conventions: **1 world unit = 1 m,
rider 1.8 m / 80 kg, physics fixed step 60 Hz**, +Y up.

## Lane: physics (physics-core, turning-friction, jump-arcs)

Candidate file: `sandbox/<lane>/<cand>/physics.mjs`

```js
export function createPhysics(env, opts = {}) {
  // env.sampleHeight(x, z) -> y      (heightfield; harness supplies)
  // env.sampleNormal(x, z) -> [nx, ny, nz]   (may be absent; derive from sampleHeight)
  // env.surface -> 'snow' | 'ice' | 'powder'
  // opts.stats -> { speed: 0..40, edging: 0..40, trick: 0..40 }  (default 20)
  // opts.gravityScale -> multiplier on BOTH ground and air gravity (default 1; test hook)
  return {
    config,                       // resolved constants (plain object, all numbers)
    init(pos, vel, heading),      // -> state; MUST set onGround from pos vs
                                  // sampleHeight (above surface = start airborne)
    step(state, input, dt),       // MUTATES state, returns it. Normal play dt = 1/60,
                                  // but step MUST be dt-correct for any dt (gate PC-02:
                                  // one 100 ms step == ten 10 ms steps to 1e-6 — use
                                  // closed-form integration, not naive Euler damping).
  };
}
// state (required fields, others free):
//   pos:[x,y,z], vel:[x,y,z], heading (rad, yaw of board), onGround (bool),
//   constrained (bool) — see CONSTRAINED STATE below,
//   charge (0..1 jump preload), airTime (s, current air), boostMeter (0..1),
//   spinDeg, flipDeg (accumulated air rotation, reset on takeoff),
//   landing ('clean'|'sketchy'|'crash'|null, set on touchdown, cleared on takeoff)
// input (all optional, default 0/false):
//   steer:-1..1, tuck, brake, crouch (jump charge while held), jumpRelease,
//   boost, spin:-1..1, flip:-1..1, grab (bool)
```

### CONSTRAINED STATE (physics)

`state.constrained = true` means the board is supported by something that is NOT
the terrain — a rail today; wallride / halfpipe / tow later. While constrained:

- the OWNING MODULE writes VELOCITY; physics integrates position from it and
  owns heading, exactly as everywhere else. The module may not write position or
  heading (the first version of this state moved nothing at all, which froze the
  rider: 0.00 m of advance over a 0.9 s charge, so crouching to pop stopped you
  dead mid-rail);
- THE BOARD FOLLOWS THE CONSTRAINT: physics converges heading to the velocity
  direction (RAIL_YAW_LAMBDA). A board frozen at its pre-lock yaw exits a curved
  rail crabbed — measured 27.1 deg after 39 deg of sweep — which land() scores
  sketchy, and past 90 deg is a crash the player cannot avoid;
- physics still runs the RIDER: crouch accrues charge at `T_CHARGE` exactly as on
  ground, prewind is captured, and `airTime` is held at 0 (a supported rider is
  not falling);
- `jumpRelease` leaves the state as a TRUE takeoff — full charge-scaled world-up
  impulse, rotation and air clock reset, prewind carried into the air.

This exists because a grind is airborne by every other measure, so before it
`charge` was always 0 on a rail: 2.5 s of crouch released at exactly `J_MIN`
(2.1 m/s, ~0.34 m of air) and the rail-into-big-air link was unbuildable. Gated by
PC-14 (charges), PC-15 (pops at full charge, 5.00 m/s), PC-16 (no gravity),
PC-17 (advances 18 m in 1 s at 18 m/s), PC-18 (board aligns to the rail within
5 deg), each mutation-verified.

Pure math only — no Three.js imports, no globals, no Date/performance reads,
deterministic (no Math.random unless seeded via env.seed). Prewind = crouch held
with spin input before jumpRelease. The runner in `harness/physics-runner.mjs` is
the OPERATIONAL DEFINITION of every gate in `references/PHYSICS_GATES.json` — read
its scenario code to know exactly how each metric is measured.

## Lane: render-loop

Candidate dir: `sandbox/render-loop/<cand>/src/` with `main.mjs`:

```js
export async function boot(canvas) {
  return {
    update(dt),        // fixed-step logic hook (physics lane attaches here later)
    render(alphaMs),   // rAF-driven
    scene, camera, renderer,
    sampleHeight,      // (x,z)->y terrain sampler (physics lane consumes)
    flythrough(t),     // scripted debug camera path, t in [0,1] — harness drives this
  };
}
```

Harness sets `window.__gauntlet = { frames: [], perf: {} }`; candidate must not touch it.

## Lane: trick-system

Candidate file: `sandbox/trick-system/<cand>/tricks.mjs`

```js
export function createTricks(env = {}) {
  return {
    config,   // MUST expose: uberTable {name: basePoints} (Tricky-native HARD values,
              // min 13210 "Benihana"-tier, max 22580), uberDuration_s (per-tier or
              // scalar), starTiers {yellow:2, orange:3, red:5}, meterFillMidTier,
              // trickyLettersNeeded: 6
    init(),                       // -> tstate
    step(tstate, physState, input, dt),
    // observes physics state (onGround, airTime, spinDeg, flipDeg, landing) +
    // input (spin, flip, grab, uber: 0|1..6) and manages:
    //   trick recognition (spins per 180, flips, grabs, ubers), combo scoring,
    //   repetition penalty (x0.5 per repeat of the SAME trick),
    //   star multipliers (collectStar(tier); highest star only; applied to the
    //   jump's summed tricks on CLEAN landing; voided on crash),
    //   boost meter economy (tricks fill; idle decays; drives input.boost gating),
    //   TRICKY state (6 individually landed ubers — REPEATS COUNT, each landed
    //   uber lights a letter per the reference — -> tricky=true: meter pinned
    //   1.0, never drains, for the rest of the run)
    collectStar(tier),            // 2 | 3 | 5 (showoff pickup)
    knockdown(),                  // rival knockdown -> meter instantly full
    landingOverride(tstate, physState) // -> 'crash' | null; MUST return 'crash'
    // when an uber animation is incomplete at touchdown (JA-15)
  };
}
// tstate (required): { score, jumpScore, meter (0..1), tricky, trickyLetters,
//   activeTrick (null | {name, progress}), lastAward, awards: [] }
```

Pure JS, deterministic, no Date/random. `harness/physics-runner.mjs` scoring
scenarios are the operational law (they drive createPhysics + createTricks together).

## Lane: run-structure

Candidate file: `sandbox/run-structure/<cand>/run.mjs`

```js
export function createRun(env) {
  // env: { sampleHeight(x,z), courseCenterX(z),
  //        bounds: {zStart, zFinish, halfWidth, zBackstop} }
  //   zStart is the START GATE, not a wall. zBackstop is the UP-COURSE
  //   correction line, well behind it: drifting back over the gate mid-run (a
  //   backwards jump, a bad landing) is ordinary play. Defending zStart made a
  //   promoted module change the run it timed by 4.9 s / +8.8% (RS-12).
  return {
    config,                       // MUST expose: zStart, zFinish, halfWidth,
                                  // maxDivergence_m (mesh-vs-physics safety margin)
    init(),                       // -> rstate
    step(rstate, physState, tstate, dt),
    // phases: 'ready' -> 'running' -> 'finished'; timer runs only in 'running';
    // detects finish crossing, freezes results, and CONFINES the rider: a rider
    // outside [zStart, zFinish] or |x - courseCenterX(z)| > halfWidth must be
    // corrected. The module MUST NEVER WRITE PHYSICS POSITION OR HEADING —
    // velocity only. RS-06 measures the module's own positional write (exact,
    // snapshotted around run.step) and RS-10 its own yaw write; both must be ~0.
    // A positional clamp is a teleport even when it is called a "hard stop".
    results(rstate, tstate),      // -> { time_s, score, bestTrick, tricky, landed, crashed }
    restart(rstate),              // full deterministic reset
  };
}
// rstate (required): { phase, time_s, finished, place, results (null until finished),
//   outOfBounds (bool, true while correcting) }
```

Pure JS, deterministic. `harness/run-runner.mjs` is the operational law for the RS gates.

## Lane: rails

Candidate file: `sandbox/rails/<cand>/rails.mjs`

```js
export function createRails(env) {
  // env: { sampleHeight(x,z), rails: [ {id, points:[[x,y,z],...], width} ] }
  //   points are a polyline (spline control points) in world space.
  return {
    config,          // MUST expose: captureRadius_m, dragScale (rail drag vs snow,
                     // <1 — "you go faster boosting on a rail than on the snow"),
                     // balanceHalfLife_s, curveTolerance_rad, minLockSpeed_mps
    init(),          // -> gstate
    step(gstate, physState, input, dt),
    // AUTO lock-on (no press-to-grind, per the reference): while airborne or on
    // contact, if the board is within captureRadius of a rail line, snap to the
    // closest point on the polyline, convert speed to along-rail speed, and set
    // gstate.onRail. While on rail: lower drag than snow; steering input drives
    // BALANCE (drift accumulates, corrected by steer; exceeding tolerance bails);
    // a curved rail requires steering or you fall off. jumpRelease leaves the
    // rail PRESERVING speed and prewind.
    // MUST NOT write heading or position except the documented lock-on snap, and
    // MUST NOT write trick state (the trick system observes gstate).
    // CHARGE + MOTION: set physState.constrained = true for the WHOLE lock (not
    // just across a crouch) and clear it on release. Write velocity along the
    // rail each frame; physics integrates position and turns the board to follow. Physics then accrues crouch charge and pops at full charge on
    // jumpRelease (see CONSTRAINED STATE). Do NOT keep a private charge counter
    // and do NOT write physState.charge / airTime / _popDone yourself — a
    // candidate that propped open the coyote branch to fake this zeroed every
    // rail spin (GR-10 now catches it).
  };
}
// gstate (required): { onRail, railId, t (0..1 along rail), alongSpeed, balance
//   (-1..1), bailed, lastLeaveSpeed, lockFrames }
// BALANCE SIGN CONVENTION: positive `steer` must REDUCE positive `balance`.
// |balance| > 1 is a bail. The rail-runner probes steer with sign(balance), so a
// module using the opposite convention will fail GR-05 by driving itself off.
```

Pure JS, deterministic. `harness/rail-runner.mjs` is the operational law for the
GR gates; `harness/rail-mutants.mjs` proves each gate fails its own mutant.

## Lane: rivals (AI racers)

Candidate file: `sandbox/rivals/<cand>/rivals.mjs`

```js
export function createRivals(env) {
  // env: { sampleHeight(x,z), courseCenterX(z),
  //        bounds: { zStart, zFinish, halfWidth },
  //        roster: [ { id, tier } ],   // tier: 'easy' | 'medium' | 'hard'
  //        seed,                       // integer; EVERY variation comes from here
  //        assist }                    // false = catch-up FORCED OFF (AI-05)
  return {
    config,   // MUST expose: tiers { easy|medium|hard: { stats: {speed, edging,
              //   trick} } } — the per-tier rider stats the HARNESS installs when
              //   it builds each rival's physics (0..40 per CONTRACTS' physics
              //   lane; the runner clamps and reports anything outside);
              //   assistEnabled (bool, mirrors env.assist);
              //   maxAssistFrac (the module's own declared bound on catch-up)
    init(),                       // -> rvstate; deterministic from env.seed ALONE
    step(rvstate, world, dt),     // -> { [rivalId]: input }   INPUTS. NOTHING ELSE.
  };
}
// world (read-only by contract, LIVE by construction — see below):
//   { t, dt, player: <physics state>, rivals: { [id]: <physics state> } }
// input: the SAME shape the keyboard produces, and no other:
//   steer/spin/flip: -1..1 finite; tuck/brake/crouch/jumpRelease/boost/grab:
//   real booleans; uber: 0 or an integer 1..6. Absent keys mean "not pressed".
```

**THE CENTRAL RULE (AI-01).** A rival drives the accepted physics through INPUTS
ONLY. It must never write ANY FIELD of a physics state — not `pos`, `vel` or
`heading`, and not `charge`, `boostMeter`, `onGround`, `airTime` or `landing`
either, on a rival or on the player — and it must never keep a private
integrator. The runner records every input object it hands to physics and replays
that tape through a fresh `createPhysics`; an honest module reproduces its own
trajectory to 0.000 m, on all 40 tapes the matrix produces. A module that writes
state directly is not a racer, it is a cutscene.

The resource fields are not a footnote. An audit module that never touched
pos/vel/heading but set `boostMeter = 1` every frame and held the boost key
scored 13/13 against the first version of this sheet. AI-06 now snapshots the
WHOLE state around `step` and names the field that moved.

The `world` states are the LIVE physics objects, deliberately. Handing candidates
frozen copies would make AI-01 and AI-06 unfalsifiable — a module physically
unable to cheat says nothing about a module that would. Read them; do not write
them.

**Catch-up is allowed and bounded (AI-05/AI-06).** SSX Tricky rubber-bands
openly, so the bar is not "no catch-up" but catch-up you cannot see: it must be
OFF while the rival leads the player, it must move a finish time by no more than
15%, and it must be spent through inputs or through the declared per-tier stats —
never as a raw grant. `env.assist === false` must switch it off completely, and
while a rival is leading the two input streams (assist on, assist forced off)
must be BYTE-IDENTICAL, which is how the runner measures the sign clause. BOTH
CLAUSES SWEEP ALL EIGHT SEEDS: an audit module that behaved on the three races
the first version sampled and rubber-banded at 1.31 on the rest reported 1.08.

**Determinism (AI-11).** No `Date`, no `performance`, no unseeded `Math.random`,
no module-level mutable state. Two `createRivals` calls with the same seed must
produce identical input streams and identical finish times. A different seed must
actually change the race, or the 8-seed matrix is one run repeated eight times.

**Tiers (AI-07/AI-08/AI-09).** Mean finish time must run easy > medium > hard with
each gap at least 3% of the course time, the harness' scripted mid-skill player
must beat every easy rival, and at least one hard rival must beat that same
player. Both halves have to hold: either one alone is satisfied by making every
rival uniformly slow or uniformly fast. Separate the tiers by THROTTLE (boost
management, braking, stats), not by the racing line — the honest baseline's first
version separated them by lookahead and steering gain and the finish times came
out inverted, because on this course a lazy line cuts the meander's corners.

**Ride, don't rail (AI-10).** Each rival must take real air off its own CHARGED
pops — at least 3 per run where `charge >= 0.25` at the `jumpRelease` frame, plus
1.5 s airborne — and its line must VARY: standard deviation of its lateral offset
from the centreline, about its own mean, at least 2 m. Both numbers are stricter
than they look, and both were bought with escapes: a module that twitched the
jump key every 2 s with no crouch behind it scored 22 "pops" of 0.22 m each, and
a module welded to a fixed 4.5 m offset scored 18.1 m RMS with 1.35 m of actual
line variation. A rival pinned to a line reads as a moving cone wherever that
line is. Charge is written by physics from your own crouch input; you may not
write it (AI-06).

**Stay on the course (AI-03/AI-04/AI-12).** All 32 matrix runs must reach
`zFinish`, none may leave the corridor, and rivals must keep at least 0.6 m from
each other and from the player with no shepherding (never within 1 m of the
player for more than 2 s). NOTHING CONFINES A RIVAL IN THE HARNESS: the run
module's corridor is not stepped on them, precisely so AI-04 measures the
candidate instead of passing by construction.

**Budget (AI-13).** The module's own `step` must cost at most 1.5 ms/frame with
five rivals, measured with `process.hrtime` around `step` and nothing else — and
`createRivals` + `init` together must fit in ONE 60 Hz frame (16.7 ms), because a
plan precomputed at the start gate is a dropped frame at the start gate, not a
saving. The runner also READS every key of the input objects you return inside
the timed window: work hidden in a getter is your cost, not the harness'.

Pure JS, deterministic. `harness/rival-runner.mjs` is the operational law for the
AI gates — read its probe code to know exactly how each metric is measured;
`harness/rival-mutants.mjs` proves each gate fails its own mutant, and
`harness/baseline-rivals/rivals.mjs` is the honest reference those mutants are
derived from (a reference, NOT a candidate).

**OPEN, and the user's to decide** (carried in `PHYSICS_GATES.json`
→ `rivalsLaneNotes.openQuestions`): whether the player COLLIDES with rivals or
passes through them — the accepted physics has no rider-rider term, so collision
is a physics-contract change, and AI-12 is written as a separation measurement so
it holds either way. Rival TRICKING is deferred: this lane races them only.

## Lane: hud

Candidate dir: `sandbox/hud/<cand>/hud.mjs` (+ optional hud.css imported by it):

```js
export function createHud(container, refs) {
  // container: empty DOM <div> overlaying the game canvas (position:fixed inset:0,
  //   pointer-events:none). Candidate owns its contents/styles entirely.
  // refs: { riderState(), trickState() } — live getters, read every update.
  return { update(dt) };   // called once per rAF after the sim step
}
// REQUIRED probe hooks (the hud runner asserts these):
//   [data-hud="score"]      textContent digits == trickState().score
//   [data-hud="meter-fill"] data-value attr == meter (0..1, 2dp); visual fill tracks it
//   [data-hud="speed"]      textContent number == |v|*3.6 km/h (rounded)
//   [data-hud="tricky"]     data-lit == trickyLetters (0..6); data-tricky="true" when tricky
//   [data-hud="award"]      visible within 0.5s of a new entry in trickState().awards,
//                           shows the award's name, hides within 4s
//   [data-hud="mult"]       textContent digits == trickState().starMult (1|2|3|5)
// RESPONSIVE: at 500x720, 1280x720 and 2560x1440 nothing may overlap the meter
// and every probe element must stay fully on screen (HU-12).
// Style bar (critic-judged): PS2-SSX loud — big italic display type, saturated
// palette, meter color ladder, score/trick text that reads at a glance mid-run.
```

`harness/hud-runner.mjs` is the operational law for the HU gates.

## Lane: camera-follow

Candidate file: `sandbox/camera-follow/<cand>/camera.mjs`

```js
export function createChaseCam(camera, opts = {}) {
  // camera: THREE.PerspectiveCamera (runner constructs it; fov mutable via camera.fov
  // + camera.updateProjectionMatrix()). opts.seed for any noise.
  return {
    update(riderState, dt),   // riderState = physics state (pos, vel, heading, onGround,
                              // spinDeg, ...). MUST be dt-exact (CF-01: one 100 ms step
                              // == ten 10 ms steps to 1e-6 — closed-form damping).
    config,                   // named constants
    debug: { lookAtTarget: [0, 0, 0] },  // updated every update(); world-space look target
    addTrauma(amount),        // 0..1; shake amplitude must scale as trauma^2 (CF-08)
    setBoostTier(tier),       // 0..3; drives fov ladder (CF-07/09)
  };
}
```

Camera must track the COURSE/velocity direction, not board heading, during spins
(CF-04/05); no per-frame position jump > 0.3 m even during crashes (CF-11).
`harness/camera-runner.mjs` is the operational definition of the CF gates.

## Lane: shaders (snow surface, trails, spray)

Candidate dir: `sandbox/snow-shaders/<cand>/` — raw GLSL in `shaders/*.glsl` + `attach.mjs`:

```js
export function attachSnow(scene, renderer, riderRef) {
  // riderRef.state: live physics state {pos, vel, heading, onGround, yawRate, ...}
  // Replaces/augments the snow material of the terrain meshes found in `scene`.
  return {
    update(dt),
    uniforms,                    // exposed material uniforms (plain object)
    debug: {                     // probe hooks — REQUIRED, the shader runner uses these
      trailHeightAt(x, z),       // current trail deformation depth (m) at world xz
      stamp(x, z, w),            // force a trail stamp of width w at world xz
      particleCount(),           // live spray particle count
      setSunDir(x, y, z),        // set light direction (probe)
    },
  };
}
```

Raw GLSL via Three.js `ShaderMaterial`/`RawShaderMaterial` only — no NodeMaterial, no
external textures (procedural + RTT only). `harness/shader-runner.mjs` is the
operational definition of the SV gates.

## Observability (event log)

Every gauntlet actor (builder, harness, critic, orchestrator) appends one JSON line per
node transition to `gauntlet/events.jsonl`:

```json
{"t":"<iso8601>","lane":"physics-core","node":"critic","cycle":2,"event":"verdict",
 "data":{"pick":"X","mapsTo":null,"biggestGap":"...","gatesPassed":9,"gatesTotal":12}}
```

Append with: `node harness/event.mjs <lane> <node> <cycle> <event> '<dataJSON>'`.
`gauntlet/state.json` is the derived checkpoint (orchestrator-maintained); the events
log is the source of truth and feeds the live Control Room artifact.

## Critic protocol (all lanes)

- Receives candidates as **X** and **Y** (shuffled; provenance stripped), plus harness
  outputs (metrics JSON / rendered frames) and `references/REFERENCE_BAR.md`.
- Verdict: `pick` (X | Y | NEITHER), `biggestGap` (single, concrete, imperative),
  per-gate pass/fail table. **No numeric scoring.** Praise is noise; omit it.
- A lane closes only when the critic, blind, judges the winning candidate to meet every
  HARD gate and sit in-band on TOLERANCE gates — i.e. indistinguishable from or better
  than the reference bar on that lane's axis.
