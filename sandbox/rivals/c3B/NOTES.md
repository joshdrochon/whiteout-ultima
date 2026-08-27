# c3B — rivals. Four riders, four lines.

Every number below was printed by a command. The commands are named beside the
numbers. Nothing here is an estimate.

Files in this directory:

| file | what it is |
|---|---|
| `rivals.mjs` | the module |
| `_lab.mjs` | tuning lab: mirrors the runner's race loop, prints finishing ORDER, boost presses, mean height above the gully floor, the AI-14 pair matrix |
| `_ablate.mjs` | writes a textually patched copy of `rivals.mjs` to scratch and runs `_lab.mjs` against it — every ablation and sweep below |
| `_probe_terrain.mjs`, `_probe_hunt.mjs`, `_probe_hunt2.mjs` | course probes: curvature stencil, drop-seeker shape |
| `_sepdbg.mjs` | prints which pair produced the closest approach on a seed, and whether either was airborne |

The runner is the authority. `_lab.mjs` exists because the runner does not print
finishing order or boost presses; where the two overlap they agree (AI-12 1.197,
AI-14 locked 10.723).

---

## The design in one paragraph

A rider is a **LINE** plus a **THROTTLE**, and the two never touch each other.

The line is an **archetype** — a different idea about where the mountain is fast
— and which archetype a roster slot gets is **dealt from `env.seed`**:

* **APEX** `+amp·sat(κ)` cuts the inside of every bend
* **BANK** `−amp·sat(κ)` runs up the outside and drops in
* **RHYTHM** `amp·sin(2πz/340)` rides a rhythm, not the course
* **HUNTER** a smoothed drop-seeker: it samples the terrain 40 m and 100 m ahead
  across nine lateral probes and chases the biggest drop

The throttle is the **tier** (fixed by the roster) plus a per-rider **form draw**
that is also seeded: how much boost appetite, how long it commits the flame, how
low it is willing to run the meter, how lazy it is about getting into a tuck.
Tiers are separated by TUCK, not by brake — see "what went wrong on the way".

Catch-up lives **entirely in the throttle**. It may not touch the line, and that
is measured: routed through the line instead, AI-14 falls from 10.723 to 4.429
and the module fails the gate.

---

## THE GATE SHEET, as printed

```
$ node harness/rival-runner.mjs --module sandbox/rivals/c3B/rivals.mjs
PASS   AI-01  HARD      inputReplayError_m = 0 (want lte 0.000001)
PASS   AI-02  HARD      outOfDomainInputs = 0 (want eq 0)
PASS   AI-03  HARD      finishRate = 1 (want eq 1)
PASS   AI-04  HARD      maxOutOfBounds_m = 0 (want lte 0)
PASS   AI-05  HARD      rubberBandRatio = 1.0686 (want lte 1.15)
PASS   AI-06  HARD      impossibleSpeedFrames = 0 (want eq 0)
PASS   AI-07  HARD      easyTierBeaten = 1 (want eq 1)
PASS   AI-08  HARD      hardTierWins = 1 (want eq 1)
PASS   AI-09  TOLERANCE tierSeparationFrac = 0.1125 (want gte 0.03)
PASS   AI-10  TOLERANCE ridesLikeARider = 1 (want eq 1)
PASS   AI-11  HARD      seedReplayMismatch = 0 (want eq 0)
PASS   AI-12  TOLERANCE minSeparation_m = 1.197 (want gte 0.6)
PASS   AI-13  HARD      rivalUpdateMs = 0.0046 (want lte 1.5)
PASS   AI-14  TOLERANCE closestLinePair_m = 11.714 (want gte 5)
{"counts":{"pass":14,"fail":0,"error":0},"hardFails":0}
```

Side fields worth reading with the verdicts:

| gate | side field | value |
|---|---|---|
| AI-01 | tapes replayed | 40, worst error exactly 0 |
| AI-02 | inputs checked | 310 632 over 10 runs, 0 stat-range notes |
| AI-03 | fastest / slowest finish | 87.65 s / 143.52 s, 32 of 32 finished |
| AI-04 | widest line vs half-width | 59.52 m vs 120 m (60.5 m of margin) |
| AI-05 | assist-while-leading count | 0 divergent tapes; size clause 1.0686 |
| AI-06 | state fields written | none; assignments during step 0; top horizontal speed 35.883 m/s, 0 sustained over-cap frames |
| AI-07 | worst margin | player beats the nearest easy rival by 7.03 s |
| AI-08 | best hard, all 8 seeds | 87.65 … 90.18 s, all under the player's 107.60 |
| AI-09 | tier means | easy 128.46, medium 101.94, hard 89.84 (course 107.60) |
| AI-10 | min air / min charged pops / min lateral σ | 37.77 s / 5 / 9.43 m |
| AI-12 | shepherd seeds / worst close run | 0 / 0.00 s |
| AI-13 | startup (createRivals + init) | 0.04 ms against a 16.7 ms budget |

`rivalUpdateMs` is a wall-clock timer and moves between runs: three consecutive
full-sheet runs of this module read 0.0046, 0.0041 and 0.0039 ms against a
1.5 ms budget. Every other value on the sheet reproduced exactly.

### AI-14, and a harness detail that changes the number

`--only AI-14` and the full sheet report **different values for the same
module**, and the lower one is the honest one.

```
$ node harness/rival-runner.mjs --module … --only AI-14
PASS   AI-14  TOLERANCE closestLinePair_m = 10.723 (want gte 5)
```

`cachedRace()`'s key is `[seed, assist, player, rosterLength, timeModule]` — it
does **not** include `throttleLock`. `matrix()` runs first on a full sheet and
fills the cache, so `lockedMatrix()` gets the **unlocked** races back and AI-14
is graded on them (11.714). Run alone, `lockedMatrix()` fills the cache first
and the races really are locked (10.723). I did not change the harness. **Every
AI-14 figure quoted in this document and in `rivals.mjs` is the locked one,**
except where the sheet is reproduced verbatim above. Verified on the honest
baseline too: 11.206 on the full sheet, 9.466 with `--only AI-14`.

Per seed, throttle-locked (floor 5.0):

| seed | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| closest pair (m) | 12.84 | **10.72** | 13.09 | 14.44 | 15.61 | 13.42 | 14.64 | 14.99 |
| pair | r1/r2 | r3/r4 | r2/r3 | r1/r4 | r3/r4 | r2/r4 | r1/r4 | r1/r3 |

Worst seed 10.723 m, i.e. **114% above the 5.0 floor**. For calibration, the
gate's own anchors on this course: one line, no lanes 0.00 · one line with 9 m
lanes 2.33 · a crude four-line probe 3.05 · the cycle-2 candidate a human called
inert 3.52 · the honest baseline 11.21 (9.47 locked).

---

## THE 8-SEED FINISHING ORDERS

`node _lab.mjs`. Format `slot(archetype,tier):finish_s`. The reference player is
deterministic and finishes in 107.60 s on every seed.

```
seed | finishing order                                                              | player
1    | r4(apex,h):87.7    r3(rhythm,m):103.8  PLAYER:107.6  r1(bank,e):118.2   r2(hunter,e):119.0 | 3rd
2    | r4(hunter,h):89.5  r3(rhythm,m):97.6   PLAYER:107.6  r1(apex,e):125.3   r2(bank,e):130.9   | 3rd
3    | r4(apex,h):89.0    PLAYER:107.6        r3(hunter,m):108.8  r2(rhythm,e):129.5  r1(bank,e):135.2 | 2nd
4    | r4(rhythm,h):89.5  PLAYER:107.6        r3(apex,m):108.5    r2(bank,e):123.9    r1(hunter,e):133.7 | 2nd
5    | r4(hunter,h):89.7  r3(bank,m):98.7     PLAYER:107.6  r1(rhythm,e):130.5 r2(apex,e):135.9   | 3rd
6    | r4(hunter,h):90.2  r3(apex,m):90.6     PLAYER:107.6  r1(rhythm,e):121.0 r2(bank,e):143.5   | 3rd
7    | r4(hunter,h):92.7  r3(rhythm,m):103.3  PLAYER:107.6  r1(bank,e):127.5   r2(apex,e):133.6   | 3rd
8    | r4(bank,h):90.5    r3(rhythm,m):104.3  PLAYER:107.6  r2(apex,e):114.6   r1(hunter,e):133.0 | 3rd
```

What the seed actually changes:

* **The character on every step of the podium.** The winner is APEX on seeds 1
  and 3, HUNTER on 2, 5, 6 and 7, RHYTHM on 4, BANK on 8; the runner-up is
  RHYTHM on 1, 2, 7 and 8, HUNTER on 3, APEX on 4 and 6, BANK on 5. Every slot
  gets a different archetype on a different seed.
* **The times.** The same roster slot swings a long way: r2 finishes 114.6 s on
  seed 8 and 143.5 s on seed 6; r3 finishes 90.6 s on seed 6 and 108.8 s on
  seed 3 — an 18.2 s swing that is what puts the player 2nd on two seeds and 3rd
  on six.
* **Fourth and fifth place.** r1 and r2 swap: r1 is ahead on seeds 1, 2, 5, 6
  and 7, r2 on 3, 4 and 8.

What it does **not** change is the order by TIER, and that is a limitation, not
a feature — see "what I did not solve".

The ablation that proves the seed is load-bearing (`_ablate.mjs
no-seed-at-all`, both draw streams frozen to seed 1):

```
1    | r4(apex,h):87.7  r3(rhythm,m):103.8  PLAYER:107.6  r1(bank,e):118.2  r2(hunter,e):119.0 | 3rd
2    | r4(apex,h):87.7  r3(rhythm,m):103.8  PLAYER:107.6  r1(bank,e):118.2  r2(hunter,e):119.0 | 3rd
…identical on all eight seeds…
```

That is cycle-2 failure #1 reproduced on purpose.

---

## BOOST — every rider lights the flame

Rising edges of the boost key per race, mean over the 8 seeds (`_lab.mjs`):

| rider | r1 (easy) | r2 (easy) | r3 (medium) | r4 (hard) |
|---|---|---|---|---|
| boost presses / race | 15.0 | 16.0 | 22.4 | 32.0 |

Cycle 2's field measured 0, 0, 2.0, 11.0. The trigger is the **terrain**, not a
clock: a rider lights it where `1 − |sat(κ)|` clears its tier's threshold, it has
meter above its own reserve, and it is on the ground; it holds for its tier's
commitment × its own draw. Without a cooldown and a hysteresis band on the
reserve the hard rider registered **276 presses per race** — a strobe, not a
pattern — because it re-lit on the frame after the meter crossed the reserve.

---

## ABLATIONS

`node _ablate.mjs <variant>`. Shipped values: AI-14 (throttle-locked, worst of 8
seeds) **10.723**, AI-12 **1.197 m**, tier means **128.46 / 101.94 / 89.84**.

### Character axes — AI-14

| ablation | AI-14 | Δ | reading |
|---|---|---|---|
| **all four archetype amplitudes → 0** (riders keep their lanes only) | 2.806 | −7.92 (−74%) | the line axis is the mechanism |
| **all four riders given APEX** | 2.817 | −7.91 (−74%) | four *different* shapes is the mechanism, not "a shape" |
| **per-rider commitment swing frozen at 1** | 8.335 | −2.39 (−22%) | how hard a rider commits to its own line is worth 2.4 m |
| **HUNTER's gain → 0** (it rides its lane) | 10.222 | −0.50 (−5%) | the hunter is the weak axis; disclosed below |
| **catch-up routed through the line instead of the throttle** | 4.429 | −6.29 (−59%) | **fails the gate** — this is why catch-up is throttle-only |
| apex/bank amplitude 22 → 30 or 38 | 10.723 | 0.00 | more amplitude buys nothing here and costs height |

The cycle-2 lesson applied to myself: the two axes I could have called
decorative — the archetype amplitude and the per-rider swing — were ablated and
both moved the metric by more than a factor of two and by 22% respectively. The
hunter's own gain did not, and I say so.

### Traffic axes — AI-12 (floor 0.6 m)

| ablation | AI-12 |
|---|---|
| line-shaping keep-out off | **0.034 m** |
| aim-space pass guard off | 0.278 m |
| per-slot lane off | 0.275 m |
| steer nudge off | 1.364 m |
| per-rider tuck spread off | 0.296 m |
| per-rider throttle draw off | 0.462 m |
| per-rider form draw off entirely | 0.040 m |

Only the line-shaping keep-out is decisive. The steer nudge is nearly free; it
is kept because it costs nothing and it removed a class of gate-line contacts.

### Throttle axes — finish times

| ablation | easy | medium | hard |
|---|---|---|---|
| shipped | 128.46 | 101.94 | 89.84 |
| catch-up off entirely | 130.13 (+1.67) | 102.11 (+0.17) | 89.84 (**+0.00**) |
| per-rider throttle draw frozen | 131.06 | 95.57 (−6.37) | 89.48 |
| per-rider tuck spread → 0 | 124.44 (−4.02) | 102.09 | 89.09 (−0.75) |
| per-rider line-commitment swing → 1 | 127.25 | 94.19 (−7.75) | 89.64 |

The catch-up row is the one to read: the leading tier's mean does not move by a
single centisecond, and the tail gains 1.67 s. That is the sign clause holding
in the live matrix, not just in the frozen-player probe.

### Robustness of AI-12 (this is the honest part)

AI-12 is a chaotic function of almost everything, and getting it to pass by
tuning is not the same as getting it to pass by design. The check I settled on
is: perturb something that **should not matter** and see whether the gate
survives.

| perturbation | AI-12 |
|---|---|
| **shipped** | **1.197** |
| reorder two independent `rnd()` draws in `init()` (changes nothing about the design, only which rider gets which number) | 1.181 |
| `LINE_KEEP_M` 19 → 18 | 0.714 |
| `LINE_KEEP_M` 19 → 20 | 0.731 |
| `LINE_KEEP_Z` 120 → 160 | 0.660 |
| `PASS_AIM_K` 2.2 → 1.8 | 1.319 |
| `PASS_AIM_K` 2.2 → 2.6 | 1.158 |
| `DODGE_STEER` 0.55 → 0.45 | 1.117 |

All still clear the floor, three of them by less than 25%. **An earlier version
of this module did not survive that test**: with the keep-out faded by distance
the sheet read 2.408 m, and the draw reorder alone dropped it to 0.083 m. Making
the keep-out unfaded is what turned a lucky pass into a survivable one. AI-14
across the same seven perturbations stays between 10.598 and 11.994.

---

## WHAT WENT WRONG ON THE WAY (so it is not re-attempted)

* **Separating the tiers by brake duty.** Easy tier mean 177.48 s, and AI-05's
  ratio became a chaotic function of the catch-up constant — a scrub cut of 0.18
  measured 1.2225 and a cut of 0.05 measured 1.1898. A HARD gate passing or
  failing on the third decimal of an unrelated constant. Moved to TUCK, which
  physics.mjs prices at +6.5 m/s of steady state and which is smooth.
* **A rival-rival steer nudge.** It is worse than useless. Four riders pushing
  off each other settle into a mutually-repelling **formation**, which is four
  *parallel* lines, and AI-14 de-means parallel away: the closest pair fell
  7.688 → 3.226 m while AI-12 did not improve at all (0.137 → 0.120). Rival-rival
  separation is left to the lane and to a hold-back on the throttle.
* **Summing the pushes from every neighbour.** The runner stages the player in
  the MIDDLE of the start grid, so the rider beside it was shoved away from the
  player straight into its team-mate; the two shoves added and the easy pair
  came within 0.06 m at the gate.
* **An offset-space pass guard.** It aims at where the player's line is 100 m
  down the hill, which is stale by the time the rider gets there: a medium rival
  and the player passed within 0.017 m at z = 1453 with the guard live.
* **Welding the pass side.** If the player drifts across a rider still committed
  to the side it started on, the shove that is meant to open the gap drives the
  rider back THROUGH the player: 0.034 m, both grounded, mid-course.
* **A full-authority pass (aim 60 m to the side while inside the clearance).**
  Overshoots and oscillates: 0.023 m.

---

## WHAT I DID NOT SOLVE

1. **The order by TIER never changes, and only the times and the characters do.**
   AI-07 (the player must beat every easy rival on every seed), AI-08 (a hard
   rival must beat the player on every seed) and AI-09 (mean easy > medium >
   hard by 3% of course time each) together force the finishing order to be
   `hard, medium/player, player/medium, easy, easy` on essentially every seed —
   and the roster has exactly one hard slot. So r4 wins all eight seeds. The
   closest it came to losing is seed 6, where the hard rider took 90.2 s and the
   medium rider 90.6 s: **0.4 s**. I widened the hard tier's tuck spread
   specifically to make an upset possible and it has not actually happened in
   the 8 graded seeds. If the reviewer wants the top of the podium to change,
   that needs either a second hard slot in the roster or AI-09 to be re-read as
   a per-seed rather than a mean constraint. I did not weaken the tiers to force
   it, because AI-09 is the gate that stops the tiers being indistinguishable.

2. **AI-12 still is not structural.** It passes at 1.197 m and survives every
   perturbation I tried (table above), but three of those land at 0.66–0.73 m
   against a 0.6 m floor. The underlying reason is physical and I could not
   remove it: the accepted physics has **no collision response and no lateral
   air control**, riders are airborne roughly a third of the run, and two riders
   who are both in the air cannot avoid each other at all. Everything in this
   module is prevention — keep the gap open before the kicker. A reviewer should
   treat AI-12 here as "held open by a 19 m keep-out from the player's line",
   not as "guaranteed".

3. **The hunter is the weakest character axis on AI-14.** Turning its gain off
   moves the graded number by only 5% (10.723 → 10.222), because on the worst
   seed the closest pair is r3/r4 and the hunter is neither of them. Its own line
   really does move — ~12 m rms of de-meaned offset — but the gate does not
   reward it on the seed that is graded. If a reviewer wants a fourth axis that
   *is* load-bearing on the metric, this is the one to replace.

4. **The rivals give the player a wide berth, on purpose, and you can see it.**
   `LINE_KEEP_M` is 19 m: while the player is within 120 m of a rival in z, that
   rival's line is pushed to stay 19 m off the player's own lateral offset. It
   is the thing that holds AI-12 open, but it means a rival will not share the
   player's line even when the racing line is where the player is. Nobody will
   ride *through* you; nobody will fight you for the trough either.

5. **Five riders means two share an idea about the mountain.** There are four
   archetypes and `ARCH` is dealt cyclically, so on the 5-rival roster the
   runner times for AI-13, slot 5 gets the first archetype again with its phase
   inverted. AI-14 only grades the 4-rival roster so nothing catches this, and
   the game's own roster size decides whether it matters.

6. **The easy tier is a long way back.** Mean 128.46 s against the player's
   107.60 — the tail of the field finishes 7 to 36 seconds down. AI-07 forces
   the easy riders to lose to the player on *every* seed, and the per-seed spread
   needed to keep the race interesting then pushes the slowest of them out to
   143.5 s. On a long course that reads as two riders who are out of the race by
   the second third. I did not find a way to make the easy tier both reliably
   beatable and close.

7. **The fps half of AI-13 is not measured.** The runner says so itself: it
   grades the update budget (0.0046 ms/frame mean, 0.04 ms of startup) and the
   "5 rivals plus the player sustain 60 fps in the rig" clause is a browser
   measurement that no pure-node gate performs. I did not run a capture.

8. **AI-06's top horizontal speed is 35.883 m/s against V_CAP 33.** That is 0
   *sustained* over-cap frames — the gate's rule is three consecutive frames and
   this module never reaches two — so it is landing-redirect transients, the same
   class the runner's own comment documents for the honest baseline. It is
   reported because a reviewer scanning side fields will see the number.

9. **AI-14 is graded with the throttle locked, and this module cannot tell.**
   The gate's own disclosed weakness is that the lock is detectable from inside
   a module. This one does not attempt to detect it — the line code is identical
   in both cases and the ablations above are run under the lock — but nothing in
   the harness proves that, and a reviewer should not take my word for it.

10. **The wave-length and amplitude constants were picked off measured tables
    that are not smooth.** The AI-14 sweep over `rhythm.wave` goes 7.729, 7.674,
    10.723, 11.432, 12.142 at 140/260/340/440/520 m because the *worst seed*
    changes between points. 340 is a defensible pick (it is where the metric
    stops improving cheaply, and the longer waves push the widest line from
    59.5 m to 82.2 m) but it is not a local optimum of a smooth function, and a
    different 8-seed sample could rank them differently.
