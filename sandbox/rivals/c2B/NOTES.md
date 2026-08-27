# c2B — driver personalities

`node harness/rival-runner.mjs --module sandbox/rivals/c2B/rivals.mjs`
→ **13 PASS / 0 FAIL / 0 ERROR, hardFails 0.**

## What this is

Eight named traits per driver — vision, aggression, patience, bank,
boostDiscipline, caution, nerve, space — read every frame. The line is not
stored anywhere: the aim point is re-derived each frame from the driver's own
speed-scaled read of the centreline in front of it, so a rider's line at
30 m/s is not the line it takes at 12 m/s. `init()` costs 0.041 ms; there is no
plan in it.

Two axes, deliberately separate:

* **Tier** = how well a driver reads the *trough*. That is the line axis.
* **Archetype** (hugger / banker / wanderer / straightener, drawn from
  `env.seed`) = which side of a bend it believes in. `bank` is signed and is
  applied to the bend the driver can currently see, so a hugger and a banker are
  on opposite sides of every corner and **trade sides at every reversal**. That
  is what makes r1 and r2 — both `easy` — two different riders.

## 1. Pairwise lateral separation (the cycle-1 gap)

Every pair, sampled on a shared 20 m z-grid, all 8 seeds, both riders racing:

| pair | mean | max |
|---|---|---|
| r1–r2 (easy–easy) | **13.9 m** | 46.7 m |
| r1–r3 | 27.3 m | 80.6 m |
| r1–r4 | 33.6 m | 108.6 m |
| r2–r3 | 26.1 m | 75.9 m |
| r2–r4 | 28.5 m | 96.2 m |
| r3–r4 (medium–hard) | 14.6 m | 65.5 m |

Overall mean **23.98 m**; the *tightest* pair still averages 13.9 m. This is not
a train, and it is not a lane pitch either — the offsets are multiplied by the
sign of the bend in front, so the same pair swaps sides wherever the course
changes hand (x runs 68 → 205 at z 440 → −167 at z 1560 → 94 at the line).

AI-12 minimum 3-D separation is **1.647 m** (baseline 1.106), shepherd seeds 0.

## 2. Tier means, and the line/throttle split in seconds

8 seeds × 4 rivals. Reference player 107.60 s.

| tier | mean | boost duty | presses/race | median hold |
|---|---|---|---|---|
| easy | **133.88 s** | 0.0% | 0 | — |
| medium | **99.15 s** | 4.5% | 4.6 | 800 ms |
| hard | **90.32 s** | 15.7% | 12.1 | 900 ms |

AI-09 gaps: easy→medium 32.3% of course time, medium→hard 8.2% (need 3%).
Worst easy margin over the player 17.9 s; hard beats the player on all 8 seeds.

### The split, by 2×2 factorial

Each cell grafts one tier's LINE traits (`look0 lookK lookMax gain aggression
dead slew bankM guardStart guardLook`) onto another tier's THROTTLE traits
(`boostHi boostLo boostGate boostTrough crestEase vEase brakeSteer brakeSpeed
panicOff tuckSteer` + stats), everything else held.

**easy → medium (34.9 s total)**

| | easy throttle | medium throttle |
|---|---|---|
| **easy line** | 134.05 s | 110.77 s |
| **medium line** | 114.34 s | 102.46 s |

* LINE main effect **14.0 s**
* THROTTLE main effect **17.6 s**
* interaction 5.7 s (the line is worth 19.7 s when nobody is boosting and 8.3 s
  when somebody is)

**medium → hard (8.8 s total)**

| | medium throttle | hard throttle |
|---|---|---|
| **medium line** | 99.15 s | 90.13 s |
| **hard line** | 100.36 s | 90.32 s |

* LINE main effect **−0.7 s**
* THROTTLE main effect **9.5 s**

So: the easy→medium step is 40% line by seconds, the medium→hard step is
essentially all throttle. Across the whole field (133.9 → 90.3 = 43.6 s), the
line carries about 14 s and the throttle about 27 s.

### Why the second table reads that way, and why it is not fixable

Boost is a **speed target**, not a force: `sAbs → max(V_BOOST, a/b)` with
`TAU_BOOST = 0.7 s`. While the key is down, every drag difference a line creates
is erased inside a second. Measured directly — give the medium tier the easy
tier's line and it costs **19.7 s** with the boost off and **8.3 s** with it on;
give the *hard* tier the easy line and it costs **0.1 s**. Any pair of tiers
where one of the two spends meaningful boost will separate by throttle, whatever
their lines are. That is a property of the accepted physics, and the honest thing
is to name it rather than tune around it.

## 3. Where cycle 1 was wrong about the terrain

Cycle 1 read the inversion (hard 109.5 s vs easy 96.6 s when tiers were split by
lookahead) as "a long chord cuts the meander, so reading further is faster", and
retreated. Swept properly on the real course, **drag-limited** so drag actually
governs, read depth is not monotone — it has an optimum:

| base read | 20 m | 26 m | **30 m** | 34 m | 46 m | 62 m | 80 m | 100 m | 120 m |
|---|---|---|---|---|---|---|---|---|---|
| finish | 116.6 | 112.6 | **110.2** | 110.8 | 112.3–113.4 | 114.4 | 123.5 | 126.6 | 126.1 |
| widest line | 13 m | 16 m | 19 m | 18 m | 24–26 m | 36 m | 56 m | 80 m | 74 m |

Reading *too far* is worse than reading too short, and the widest-line column
says why: the far-reading rider aims across the bowl at a point it is nowhere
near and gets carried up the gully wall to get there. The wall is the cost —
`h += d²·0.0035`, so 80 m out is 22 m up. **The fast line here is the low one.**

So the tier axis is not "how far ahead" but *how well a driver reads the
trough*, which points the right way round: hard reads 32 + 1.7·v and is hauled
back at 30 m out; easy reads 118 + 6.9·v and lets itself go to 100 m. Order
comes out monotone with no throttle help at all (114.3 vs 134.1 at matched
throttle).

## 4. Boost press pattern

Across the field, **16.8 presses per race** (4 rivals), **833 ms median hold**,
shortest 467 ms. Per tier: hard 12.1 presses at a 900 ms median, medium 4.6 at
800 ms, easy none. Cycle 1's candidate A made 269 presses at a 17 ms median.

Four things keep it a burn and not a strobe, and all four were needed:
meter hysteresis (`boostHi`/`boostLo`), a `MIN_BOOST_HOLD_S` of 0.8 s
(0.45 s for an abort), a 0.9 s cooldown before re-pressing, and a low-pass on
the crest read — which chatters badly on the micro-rolls and, unfiltered, took
the median hold to 250 ms.

## 5. Margins on the rest of the sheet

| gate | value | bar | note |
|---|---|---|---|
| AI-01 replay | 0.000000000 m | ≤ 1e-6 | 40 tapes, all exact |
| AI-04 widest line | **82.68 m** | of 120 | 37 m of margin (baseline 106.89, 13 m) |
| AI-05 rubber band | 1.0938 | ≤ 1.15 | assist-while-leading count 0 |
| AI-06 | 0 frames | = 0 | no state writes, no sustained over-cap |
| AI-10 lat std (worst) | 7.22 m | ≥ 2 | charged pops worst 9, best charge 0.549 |
| AI-12 separation | 1.647 m | ≥ 0.6 | shepherd seeds 0 |
| AI-13 step / startup | 0.0064 ms / 0.041 ms | ≤ 1.5 / 16.7 | 234× and 400× under |

## 6. Catch-up (AI-05)

Two channels, both inputs, both exactly zero while leading (the `assist > 0`
branches are simply not entered, so the leading input stream is bit-identical to
the `assist === false` stream):

1. **attention** — a trailing driver pulls its read in toward the racer's depth
   and stops letting itself drift up the bank (`ASSIST_READ_PULL` 0.03);
2. **scrub relief** — it stops panicking about being out there
   (`ASSIST_BRAKE_RELIEF` 0.12).

Neither touches boost, stats or the physics state. The channel was chosen
because over-reading is the easy tier's *actual* weakness, so catch-up helps the
rider that needs it and does close to nothing for a hard rival. At an earlier
strength (0.34 / 0.40) it read 1.1984 and pulled an easy rival ahead of the
reference player — AI-05 and AI-07 caught it together.

## 7. Bugs this cost, all found by measurement

* `bendSgn` was computed and never used, so `bank` was a constant-sign offset
  scaled by bend strength — a lane in disguise, not an opinion about a corner.
* The avoidance steer was applied with the **wrong sign**. Positive steer turns
  the board toward −x (heading π/2 faces +z, `F = [cos h, 0, sin h]`), and the
  avoidance terms are in +x metres. It was a homing missile: two riders 5 m
  apart out of the gate closed to 0.048 m. Fixing the sign took AI-12 from
  0.084 m to 1.647 m.
* The elbow was *added* to the steer. Added to a command already at the stop it
  does nothing, which is exactly the state two riders chasing the same far aim
  point are in at the gate. It now blends over the line command instead.
* A 9 m longitudinal avoidance window is too late at 30 m/s. The term is now
  predictive (closest approach over 0.9 s, worse of that and now).
* Rivals landing off a 30 m/s launch at z ≈ 500 came out at 34.7 m/s horizontal
  and rode it off over 49 frames — AI-06's sustained-over-cap counter, earned
  honestly and still an impossible speed. The crest read fixed it.

## 8. Known weaknesses, disclosed

* **The easy tier is slow, 133.9 s against the baseline's 134.9.** It is that
  slow because it is bad at three things at once (read, tuck, panic-scrub). A
  critic who wants a tighter field would take the read back toward 90 + 5·v; the
  cost is AI-07 margin, which is currently 17.9 s at its worst and was 2.4 s
  before easy's tuck came off.
* **Only two of four rivals ever press boost.** That is a consequence of using
  boost duty as the throttle axis while the line carries the easy→medium step.
  Giving easy a boost allowance would erase its line penalty (see §2) — the
  alternative design, tiers separated by line alone with nobody boosting, was
  rejected on a measurement: the hard tier's LINE with the boost taken away
  finishes in **116.48 s**, nine seconds behind the reference player's 107.60 s,
  so a line-only ladder fails AI-08 outright. Boost is the only lever on this
  course that puts a rival ahead of that player.
* **`_topHorizSpeed_mps` is 34.711**, above V_CAP. It is a one-and-two-frame
  landing transient, which is what AI-06's 3-frame rule exists to allow; the
  sustained counter is 0. It is not zero margin, and a future change that adds
  airtime at speed should re-read that field.
* Archetype draw is `(i + hash(seed)) % 4`, so with a 4-rival roster every race
  fields all four characters and only the pairing changes. A 5-rival roster
  repeats one.
