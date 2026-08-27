# c2A — per-rival line from a cost function

`node harness/rival-runner.mjs --module sandbox/rivals/c2A/rivals.mjs` → **13 PASS / 0 FAIL, hardFails 0.**

## What it is

No shared line. Each rival owns a weight vector over five cost terms — path
length, curvature, gully-floor attraction, apex depth (which side of each bend
it commits to and how far), soft corridor wall — and its line is solved once at
`init` by gradient descent on those weights. Four rivals, four weight vectors,
four different paths. There is no lane, no weave and no common track anywhere in
the module.

The rider then follows its own line with pure pursuit, presses its own throttle,
and keeps off the other racers by shifting its aim point. Inputs only.

## Where the line/time trade actually sits — MEASURED

Solo runs, real course, real physics, pops included, sweeping the apex-depth
weight alone. Negative apex = the OUTSIDE shoulder of each bend, positive = the
INSIDE, i.e. cutting it.

| apex | max offset | no boost, stats 20 | boost, stats 34/32 |
|---|---|---|---|
| −70 | 47 m | 132.5 s | 93.6 s |
| −40 | 26 m | 120.6 s | 91.9 s |
| 0 | 6 m | 114.0 s | 87.8 s |
| +20 | 17 m | **107.5 s** | 87.2 s |
| +45 | 35 m | 112.2 s | 87.4 s |
| +70 | 52 m | 118.8 s | **86.8 s** |
| +100 | 74 m | 125.6 s | 87.3 s |

**The optimum moves with speed.** A gravity-limited rider is fastest on a shallow
cut and pays 11 s to hold the deep one: off the gully floor it rides a
cross-slope, the fall line is no longer under the board, and the height it climbs
is speed it never gets back. A rider held at `V_BOOST` is speed-limited rather
than gravity-limited, so height stops costing it anything and only distance is
left — its optimum walks out to +70 and the deep cut becomes the fastest line on
the hill.

Cycle 1's finding ("a committed line is slower here") is real, and it is half the
curve. The deep cut is not a slower line; it is a line you have to be fast enough
to afford. That is the tier axis, and it is an axis of line:

* **easy** rides a line its speed cannot pay for — `driftsWide` sits on the
  outside shoulder of every bend, `overCuts` straightens the meander until it
  climbs the far wall. Opposite sides of the course at every apex.
* **medium** never commits: the late apex, or the floor just past it.
* **hard** commits to the deep inside cut, which is only fast at its speed.

## The four lines are actually different

Pairwise lateral separation between the rivals' tracks at the same z, 8 seeds:

| pair | mean | max |
|---|---|---|
| r1/r2 (easy/easy) | 65.4 m | 144.1 m |
| r1/r3 | 11.6 m | 35.5 m |
| r1/r4 | 55.2 m | 124.1 m |
| r2/r3 | 56.1 m | 136.0 m |
| r2/r4 | 15.9 m | 49.0 m |
| r3/r4 | 45.5 m | 127.3 m |
| **all pairs** | **41.6 m** | **144.1 m** |

Weakest pair is r1/r3 at 11.6 m mean — `driftsWide` (−74) and `lateApex` (−34)
are both outside-of-the-apex riders, so they share a side. Everything else is
15–65 m apart. Nothing here is a train.

## Tier means, and how much is line vs throttle

8 seeds, 4-rival roster, reference player 107.60 s.

| tier | mean |
|---|---|
| easy | 135.58 s |
| medium | 113.33 s |
| hard | 87.15 s |

Decomposition, in seconds. "One line" re-runs the whole field on the medium
archetype's line with every tier keeping its own throttle, which isolates the
throttle; the line is the residual.

| boundary | gap | from LINE | from THROTTLE |
|---|---|---|---|
| easy → medium | 22.2 s | **9.6 s** | 12.6 s |
| medium → hard | 26.2 s | **4.3 s** | 21.9 s |

**13.9 s of the 48.4 s ladder is line — 29%.** It contributes at both boundaries,
which is the thing worth defending: put hard on the medium rival's line and it
loses 4.3 s, so hard is not fast *only* because it holds boost longer.

Being straight about the ceiling: at hard's speed the whole line axis is worth
about 3 s end to end (85.9 s to 88.6 s across every line family tried), while its
boost is worth ~25 s. No tuning changes that, because a rider pinned at `V_BOOST`
is not being slowed by the mountain. The honest statement is the coupling: the
line is what hard's boost *buys* it, and the same line costs a medium rider 11 s.

## Boost press pattern

Per run, mean over 8 seeds. Cycle 1's candidate A made 269 presses at a 17 ms
median hold — a 3 Hz strobe.

| rival | tier | presses | median hold | duty |
|---|---|---|---|---|
| r1 | easy | 0 | — | 0% |
| r2 | easy | 0 | — | 0% |
| r3 | medium | 2.0 | 2.42 s | 3.5% |
| r4 | hard | 17.5 | 3.47 s | 46.5% |

Boost is a meter hysteresis, not a square wave. `BOOST_DRAIN` 0.125 against
`BOOST_REGEN` 0.10 fixes the sustainable duty at 44%, so every honest policy
lands there; what a policy chooses is the *shape*. A square wave at 42% duty
costs 22 presses at a 1.68 s median hold; the hysteresis reaches the same duty in
11 presses at 3.47 s and is 0.06 s faster.

**A hysteresis alone cannot be a tier.** Measured the hard way on the first build:
medium was given `boostOn 0.995 / boostOff 0.70` on the theory that a rider who
only presses at a brim-full meter would barely boost. It came out at 44% duty and
89.8 s, a tenth of a second off the hard tier, because the *meter* is the binding
constraint and every hysteresis converges to the same sustainable duty whatever
its thresholds are. The tier lever is the **cooldown between bursts**: hard 0 s,
medium 85 s, easy never.

## Two things that broke, and what fixed them

**The start gate.** Every line in this module starts on the centreline, because a
cost function has no opinion about where the gate is. All four riders converged
onto one point at z ≈ 40 and AI-12 read 0.40 m. Fixed by fanning the riders out
of the gate in their roster slots and merging onto their own lines over the first
340 m.

**Crossing lines.** Four riders on four different lines *cross* — a lane-and-weave
field never has to deal with this, because it cannot collide with itself. Fixed
with two-range avoidance: a polite aim-point shift on the 60 m lookahead, plus a
short-range steer bias inside 6 m that answers in a frame. The aim shift alone
bottoms out at 0.21 m however wide its window is opened, and widening it past
~13 m makes it *worse* — two riders on crossing lines each try to reverse the
crossing and end up sliding along one another instead of getting it over with.

## Gate margins, against the honest baseline

| gate | c2A | baseline |
|---|---|---|
| AI-04 widest line | 97.8 m (22.2 m of corridor spare) | 106.9 m (13.1 m) |
| AI-05 rubber-band ratio | 1.0893 | 1.0822 |
| AI-09 tier separation | 0.2078 | — |
| AI-10 min lateral std | 11.9 m | 9.89 m |
| AI-12 min separation | 1.959 m | 1.106 m |
| AI-13 step / startup | 0.0035 ms / 2.9 ms | 0.002 ms / — |

The AI-12 figure is capped by the harness' own start grid: six of eight seeds
bottom out at the 2.502 m the gate slots themselves provide.

## Catch-up

Two channels, both spent through inputs: the trailing rider stops scrubbing (up
to 35% of its brake duty) and blends up to 12% of the way from its own line
toward the apex its tier should have taken. A struggling rival tidies its line.
Inside the 5 m deadband and while leading, `assist` is exactly 0 and the code
takes the same branch `env.assist === false` takes, which is what makes the two
input streams byte-identical in the frozenBehind scenario. The line blend was set
at 0.30 first and AI-05 read 1.1632; at 0.12 it reads 1.0893.

## Cost

`createRivals` + `init`: 2.9 ms against a 16.7 ms budget — 0.70 ms to sample the
terrain table, 0.25 ms per line solved, two lines per rider (its own and its
tier's true apex, for catch-up). Gradient descent converges in ~120 iterations;
the line is identical to 0.00 m against a 2000-iteration solve, and the finish
time is within 0.01 s from 80 iterations on. `step` costs 0.0035 ms/frame with
five rivals.
