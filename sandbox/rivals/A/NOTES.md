# Rivals A — pursuit controller on a precomputed racing line

`node harness/rival-runner.mjs --module sandbox/rivals/A/rivals.mjs` → **13/13, 0 hard fails.**

## What it is

Three stages per frame. Inputs only; the module reads `world` and writes nothing in it.

1. **LINE.** One racing line, built once in `createRivals`, shared by every rival and
   every tier. Nodes every 15 m of z; 260 sweeps of damped Laplacian smoothing of x(z),
   re-clamped each sweep to ±70 m of the centreline. Endpoints pinned.
2. **PURSUIT.** Pure pursuit: the arc through the aim point has curvature `2·sin α / d`,
   so the line asks for a yaw rate `κ·v`. That is divided by the accepted physics' own
   yaw-authority expression (`kSteer · min((v/R_carve + pivot)·edgeF, aLat/max(v,5))`)
   to get the `steer` that delivers it. Feedback on the line, not on heading error.
3. **THROTTLE.** One number per tier — `vBoost`, the speed the rider will spend boost to
   hold. Under it: tuck, and pull the boost trigger on a meter hysteresis cycle. Over
   `vBoost + 3`: scrub. Plus a curvature preview that on this course never binds.

## Honest derivation of the line

It is a **discrete minimum-curvature line inside a lateral corridor**, and nothing more.
It ignores the terrain: no bank, no fall line, no grip budget. It measures curvature
against z rather than arc length. It optimises geometry, not time.

`LINE_ITERS` is the corner-cut knob and it is not arbitrary — Laplacian smoothing is
diffusion, so 260 sweeps is a diffusion length of `sqrt(2·0.9·260)·15 ≈ 320 m` of z. The
line follows centreline features longer than ~320 m and ignores shorter ones, which is
what cutting a corner is.

Measured, over z ∈ [0, 2400]:

| | |
|---|---|
| centreline length | 2573 m |
| this line | 2503 m (**70 m / 2.7 % shorter**) |
| largest offset from centre | 40.4 m (the ±70 m clamp never binds — it is a guard rail) |
| mean height above the trough floor | +2.5 m |
| tightest curvature | 1.26e-3 (790 m radius → asks for 143 m/s) |

Running the smoothing to convergence instead pins the line flat against the clamp for
hundreds of metres and is **measurably worse**: widest line 85.6 m vs 75.6 m, for the
same finish times to 0.3 s.

## Numbers that matter

| gate | value | ceiling / floor | note |
|---|---|---|---|
| AI-04 widest line | **75.6 m** | 120 m | 44 m of wall margin (honest baseline: 101.5 m) |
| AI-05 rubber-band ratio | **1.0634** | ≤ 1.15 | assist-while-leading count 0 |
| AI-09 tier gaps | 10.1 % / 15.8 % | ≥ 3 % | easy 120.6 s, medium 109.7 s, hard 92.7 s vs player 107.6 s |
| AI-10 | 7 charged pops min, 28.0 m lateral std | 3 / 2 m | pop charge 0.49 at release |
| AI-12 min separation | 1.66 m | ≥ 0.6 m | no shepherding (worst close run 0.00 s) |
| AI-13 | 0.0026 ms/frame, 0.20 ms startup | 1.5 / 16.7 | line build is 195 nodes × 260 sweeps |

## Two levers you should know about

**Recovery is not a refinement.** Past 14 m of cross-track error the rider shortens its
lookahead, commits harder, and **stands up out of the tuck** — the physics scales steering
by `TUCK_STEER = 0.6`, so dropping the tuck is worth 67 % more yaw authority, the biggest
single lever the input set has. Disable that branch and the widest line goes from
**75.6 m to 112.8 m**: without it this module rides 7 m from the wall.

**Catch-up size is a dial, and the choice is open.** It is spent through the lookahead and
the boost policy only — never the line, never the scrub threshold, never a grant. While a
rival leads, the assist terms are inside `if (assist > 0)`, so the code path is byte-identical
to `env.assist === false`. `ASSIST_BOOST_LIFT` sets the size:

| lift | AI-05 ratio | AI-12 min separation |
|---|---|---|
| 1.1 m/s | 1.0356 | 2.15 m |
| **2.0 m/s (shipped)** | **1.0634** | **1.66 m** |
| 3.0 m/s | 1.0902 | — |

Shipped at 2.0: a trailing rider claws back ~6 % of its run — feelable — with 8 points of
headroom under a HARD ceiling of 1.15. Take 1.1 if the lane wants maximum headroom.

## Disclosed, not implied

- **AI-12's 1.66 m is not a designed clearance.** There is no separation term in this
  module and no rider-rider term in the accepted physics (the lane's open question). The
  minimum is a chaotic overtake event: small parameter changes swing it between 0.6 m and
  2.2 m. Lane geometry sets the *typical* gap (9 m pitch), not the minimum.
- **The seeds vary the race only mildly.** Per-rider throttle personality is ±2.5 % of
  `vBoost` plus lane, lookahead, weave and pop-phase jitter — enough that AI-11's
  `_seedMatters` holds and the eight seeds are eight races, but easy finishes still span
  only ~2 s across seeds. Deliberate: bigger jitter starts to reorder the tiers.
- **The curvature preview is inert on this course.** The tightest bend on the built line
  asks for 143 m/s against a 33 m/s cap. It is kept because a course with a real corner
  needs it, but on this mountain `vBoost + BRAKE_HEADROOM` is the only threshold that
  governs. Do not read the preview code as doing work here.
- **Rivals do not trick.** Per the lane's second open question, they race only. The pops
  exist for AI-10 and for how the rider reads, not for score.
- **`config.tiers` is a fresh copy per instance**, so a caller editing it cannot turn the
  module-level table into shared mutable state and break AI-11 for later instances.
- **AI-13's "5 rivals sustain 60 fps in the rig" half is not measured here** — browser-only,
  as the runner says on every run. This module's `step` is 0.0026 ms/frame at 5 rivals.

## Robustness beyond the graded matrix

Rosters of 1, 2, 6 and 8 (lane pitch narrows above 5 rivals so the spread stays ≤ 45 m),
an unknown tier string, a roster entry with no `tier`, missing `env.bounds`, missing
`env.courseCenterX`, an empty roster, `world` null/`{}`, and `init()` called twice on one
instance: no crash, no stuck rider, no out-of-domain input, all riders finish.
