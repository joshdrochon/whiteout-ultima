# c2B — rivals as drivers

`node harness/rival-runner.mjs --module sandbox/rivals/c2B/rivals.mjs` → **13 PASS / 0 FAIL, hardFails 0**.

## The design

Seven named traits per rider, 0..1. Nothing is a speed multiplier and nothing is
applied to the output.

| trait | what it does |
|---|---|
| `anticipation` | reading horizon (62–150 m) and how stale it lets the plan get (1–12 frames) |
| `cutAppetite` | how much it wants the inside of a bend |
| `shoulderNerve` | how much bank it will climb to hold a line |
| `patience` | how fast the edge is allowed to move (1.9–7.9 /s) and the steering gain |
| `poise` | the steer and the heading error above which the tuck comes off |
| `discipline` | whether the meter is managed or chased |
| `scrub` | the heading error and the speed at which fright becomes brake |

**There is no line.** Every frame each rider scores 11 candidate aim points
across the gully at its own horizon — climb above the gully floor, turn needed
now, turn needed to leave again, inside-of-the-bend, wall, its own good side,
traffic projected forward on its own velocity — and rides at the winner. No
precomputed path, no lane table, no weave oscillator, no per-tier steering
multiplier. Tiers are trait sets; the seed makes a *different rider inside the
tier*, not a scaled one.

## How the tiers separate without inverting

Cycle 1 found that separating tiers by line inverts the order on this course.
That is real and this module does not paper over it. Measured here: three riders
identical except for the four reading traits, **on a throttle that never
boosts**, finish within ±1.2 s of each other. The racing line, by itself, is
worth nothing on this mountain.

The mechanism that makes it worth something is the coupling:

* **the line buys boost windows.** The managed rider's press needs
  `onGround && fear < boostErr`. A rider that reads well is pointed straight
  more often, so more of its meter gets lit. Same three riders on the managed
  rule: live boost **0.33 → 0.44**, finish times **94.9 → 88.9 s — 6.0 s from
  the line alone**, correctly ordered.
* **the tuck comes off when a rider is fighting.** Tuck is worth 55 s over this
  course (measured: 113.1 s tucked, 168.7 s not). A rider that cannot hold it
  through its own corrections pays for its bad reading in the throttle without
  anything being applied to the throttle.
* **fright becomes brake.** `comfort` is 15 m/s timid, 32 m/s not, so the hard
  rider never reaches its own trigger.

## Honest weak spot

The `by feel` boost rule (easy and medium) presses below a speed threshold, so a
rider that goes faster presses less. That is a homeostat, and it **cancels and
then inverts the line advantage for those two tiers**: swapping the medium
rider's reading for the easy rider's makes it 3.1 s *faster*. The hard tier does
not have it (its trigger is the meter, not its speed). Named rather than hidden;
the fix is to trigger the by-feel press on something that is not a proxy for how
well the rider is doing, and it was not worth destabilising a passing sheet for.

## Measured, 8 seeds, 4 rivals

```
easy   122.38 s (114.77 – 128.13)     player 107.60 s
medium  97.72 s ( 89.83 – 108.35)     AI-07 worst margin  7.17 s
hard    89.16 s ( 88.05 –  90.32)     AI-08 worst margin 17.28 s
gaps: easy→medium 24.66 s (22.9%)   medium→hard 8.56 s (8.0%)
```

Pairwise **lateral separation at equal z**, mean over 8 seeds: tightest pair
(the two easy riders) **8.6 m**, all pairs **20.8 m** mean, **102.3 m** max.
Lateral std about each rider's own mean: easy 10.7 m, medium 13.6 m, hard 28.4 m
(AI-10 wants ≥ 2). Widest line 76.4 m against a half-width of 120 — **43.6 m of
corridor margin**, against the honest baseline's 13.1 m.

Boost key: easy 23 presses at a 5.03 s median hold (key down 90% of the run,
meter actually burning 14%); medium 23 @ 3.93 s (78% / 25%); hard 25 @ 1.01 s
(42% / 42%). Two strobes were found and killed on the way here — gating the
press on `meter > 0` (2491 presses at 20 ms) and a bare speed threshold with no
commitment timer.
