# Collision gate law — reasoning

Draft law: `references/COLLISION_GATES.draft.json`. 17 gates, 21 mutants, 20 caught,
1 gate (CL-08) with no mutant written. Nothing in `src/` was touched.

Everything below is measured. The probes are in the session scratchpad at
`coll/{contact.mjs, runner.mjs, mutants.mjs}`; `contact.mjs` is a **reference
solver written only to validate the law**, not a candidate.

Baseline confirmed green before and unaffected after:
`node harness/physics-runner.mjs --module src/physics/physics.mjs` → 62 pass, 0 fail,
0 hardFails.

---

## 1. The shape the law assumes

Collision is **one resolve pass inside the physics step**, run after every rider's
`ph.step`, over the rider set the host supplies **as an array**. Three consequences
are baked into the gates:

- **Contact volume is a vertical cylinder**, not a sphere: horizontal diameter
  0.90 m, vertical extent 1.80 m. Resolution is **horizontal only** — a vertical
  component would push a grounded rider into terrain or launch them off it, and the
  accepted physics owns the vertical axis.
- **Physics owns it.** AI-06 already forbids a rivals module writing any field of any
  rider's state. CL-08 closes the other half: physics must not *export a door* that
  writes state on a module's behalf, which would pass AI-06's whole-state diff
  because the write happens inside physics' own code.
- **Determinism comes from a total order on rider ids**, not from the container.

## 2. The contact radius, and why 0.45 m

A 1.8 m rider's **height** is the wrong number for a horizontal test. What collides
is the swept horizontal disc: shoulder breadth 0.45–0.50 m, arms out in a carve
stance ≈ 0.65 m of body, and a 1.55 m board yawed 30° sweeps 0.78 m. 0.80–0.90 m is
the honest disc. 0.45 m per rider puts two centres at 0.90 m shoulder to shoulder.

| radius | diameter | for | against |
|---|---|---|---|
| 0.30 | 0.60 | AI-12's floor doesn't move | not a body size — it was a *measurement of a field that never touched*; riders visibly overlap |
| **0.45** | **0.90** | **shoulders + arms + a yawed board** | **AI-12's floor must move to 0.88** |
| 0.60 | 1.20 | full arm/board extension | shoulder-to-shoulder riding becomes impossible; the field feels repulsive |

**Lean: 0.90 m.** It is the only one derived from the rider rather than from a prior
measurement.

### AI-12's recommendation (not edited — reported)

`AI-12 minSeparation_m` should become **`gte 0.88`** (0.90 minus CL-01's 0.02 m
allowance), and its `_why` should record that it is now a **consequence of CL-01**,
not an independent property. Today it reads **0.464** on the pre-flight's dense
field. Once contact holds, 3-D centre separation cannot fall below 0.88 while
|Δy| < 1.8 m, and cannot fall below 1.80 m when |Δy| ≥ 1.8 m. The shepherding
clause (no rival within 1.0 m of the player for > 2.0 s) should **stay**: contact
stops interpenetration, it does not stop tailing.

## 3. Gate by gate

| gate | metric | bar | honest | today (no collision) |
|---|---|---|---|---|
| CL-01 separation | `maxPenetrationDepth_m` | ≤ 0.02 | 0.000 | **0.900** |
| CL-01b co-location | `colocatedSeparation_m` | ≥ 0.88 | **0.000 (fails)** | 0.000 |
| CL-02 energy | `maxContactEnergyGainFrac` | ≤ 1e-9 | 0.0 | 0 (vacuous) |
| CL-02b momentum | `maxContactMomentumResidualFrac` | ≤ 1e-9 | 0.0 | 0 (vacuous) |
| CL-03 determinism | `orderPermutationStateDelta` | = 0 | 0 | 0 (vacuous) |
| CL-04a out of bounds | `playerContactOobFrames` | = 0 | **not validated** | 0 (vacuous) |
| CL-04b rail | `playerContactRailBreaks` | = 0 | 0 | 0 (vacuous) |
| CL-04c bulldoze | `maxPlayerContactDeviation_m` | ≤ 2.5 | 2.20 | 0.00 (vacuous) |
| CL-04d lateral speed | `maxPlayerContactLateralSpeed_mps` | ≤ 8.0 | 4.93 | 0.00 (vacuous) |
| CL-05a no free speed | `rammerFinishTimeGain_s` | ≤ 0 | −4.03 | 0.00 (vacuous) |
| CL-05b ramming costs | `contactCostToAggressor_s` | ≥ 1.0 | 4.03 | **0.00** |
| CL-06 jitter | `sustainedContactJitter_m` | ≤ 0.01 | 0.000 | 0.000128 (vacuous) |
| CL-06b drift | `sustainedContactDrift_m` | ≤ 0.02 | 0.000 | **0.60** |
| CL-07 jump the pack | `verticalPassthroughDisturbance_m` | = 0 | 0.0 | 0 (vacuous) |
| CL-08 no write path | `contactApiWritesFromModule` | = 0 | **not implemented** | — |
| CL-09 inert at range | `soloTrajectoryDelta_m` | = 0 | 0.0 | 0 (vacuous) |
| CL-10 role symmetry | `roleSwapAsymmetry_m` | ≤ 1e-9 | 0.0 | 0 (vacuous) |

**12 of 17 metrics pass today with no collision code in the repo.** That is the
calibration headline. It is why every gate needed a mutant against a working
reference before any of it could be trusted.

### CL-04 — the player is not griefable

This is the gate the brief called the most important and the easiest to write badly,
and it is where the law nearly went wrong.

**Where I drew the line: between a *bump* and a *lean*.** Being hit and moved 2 m is
the feature — it reads on screen, and at the accepted `A_LAT` of 26 m/s² you ride out
of it in `2·√(2/26) = 0.55 s`. A rival that can hold its edge against you and walk
you across the course is a different game. Anchors, all measured in the 216-case
adversarial sweep (approach offset × z-lead × steer gain × player speed × 1 or 2
rivals):

| | deviation | corridor-lateral speed | past the bounds line |
|---|---|---|---|
| single clean bump | 0.47 m | — | — |
| **honest reference** (e=0, 0.35 s bump cooldown) | **2.20 m** | **4.93 m/s** | 1.60 m |
| same solver, rival allowed to **lean** | 3.85 m | 4.93 m/s | 2.05 m |
| elastic, e = 1.0 | 5.97 m | 9.86 m/s | 5.37 m |
| restitution 2.0 | 16.26 m | 16.97 m/s | 15.66 m |

**2.5 m** clears the honest reference by 14% and fails the first real abuse by 54%.
Under ~1 m contact is invisible; above ~3 m a rival owns your line.

CL-04d exists because deviation alone is not the whole hit: a solver can keep
deviation small inside a 25 s window and still fire the player sideways at 17 m/s,
which is what the corridor and the camera then have to eat. **8 m/s** sits 1.6× above
honest and 1.2× below the first mutant.

The elastic (e = 1.0) case is the reason CL-02 is **not sufficient on its own**: it
reads 4.4e-16 on the energy gate — perfectly legal — and still punts the player
5.97 m. Energy conservation and non-griefability are independent properties and each
needs its own gate.

## 4. Two things I could not close

### CL-04a: out-of-bounds cannot be vetoed inside the solver — **BLOCK**

The reference carries an explicit boundary veto that refuses any positional
depenetration which would push |s| past `halfWidth`. **The player still ends 1.60 m
out of bounds.** The reason is structural, not a bug: the solver's contribution is a
velocity impulse, and the player crosses the line several frames later under ordinary
integration, where the veto is not running and cannot tell contact-derived momentum
from the player's own steering.

So **CL-04a must be measured with `src/run/run.mjs` in the loop**, graded against
`rs.outOfBounds` and RS-06's 2 m single-frame correction budget. A collision runner
that grades it standalone will either fail every honest candidate or get quietly
weakened until it passes — which is exactly the failure mode that killed four cycles.

There is a good argument the corridor absorbs it: `run.mjs`'s own header says the
lateral allowance at |s| = halfWidth equals the largest corridor-lateral rate a rider
can have, i.e. `V_CAP` = 33 m/s, and contact was measured to add at most 4.93 m/s
(honest) / 16.97 m/s (restitution 2.0). That is what CL-04d's 8 m/s bar is for — it
keeps the contact impulse inside what the corridor was already built for. **But
nobody has measured the corridor under contact and this draft does not claim it.**

### CL-01b: the honest reference fails its own gate

Two riders spawned on **exactly** the same point are never separated: the contact
normal `(b.pos − a.pos)/|b.pos − a.pos|` is undefined and every solver of this shape
skips the pair. Measured `colocatedSeparation_m = 0.000` after 2 s.

Reported rather than fixed, because the fix is an implementation decision with a trap
in it: the tie-break normal must be a **deterministic function of the two rider ids**
or CL-03 falls over. A random or float-noise tie-break trades this bug for a
determinism bug.

Not hypothetical — `harness/rival-runner.mjs` stages racers on a 5 m gate pitch and
**collapses that pitch to 0** under the AI-14 throttle lock, where its own comment
notes rivals may overlap at t = 0.

### CL-08: no mutant written

The gate is specified (enumerate the module's export surface, invoke each with two
rider states, assert nothing changed) but nothing was built or run against it. The
mutant to write is an exported `applyContact(a, b)`. **A gate I have never seen fail
is not evidence, and this one has never been seen at all.**

## 5. Seven escapes on the first pass — all defects in the law

Every one is now baked into the scenario params so it cannot reopen.

| gate | how the mutant escaped | fix |
|---|---|---|
| CL-07 | both riders at the **same x and z** — undefined normal, every solver skips the pair | 0.4 m horizontal offset in the probe |
| CL-07 | metric read **velocity only**; the mutant's disturbance was pure positional depenetration | fold position into the metric |
| CL-10 | probe relabelled **both** riders, so a role rule symmetric in the pair cancelled out | compare a *named* pair against an *anonymous* pair |
| CL-06 | the sustained-contact rig was a gully; riders on the wall run slower down-course, string out in z, and **stop touching after ~2 s** while still reporting a clean 0.000 | drive the press with the riders' own steering — 720/720 contact frames |
| CL-05 | one clause missed a solver that made ramming **free** rather than profitable (−0.90 s against a `lte 0` bar) | split into CL-05a and CL-05b |
| CL-02 | penalty-spring mutant hooked behind the bump cooldown, fired only at near-zero penetration | make it a *pure* penalty solver — what a naive implementation actually looks like |
| CL-09 | long-range mutant widened the contact test but left depenetration guarded by `penetration > 0` | give the mutant a real 1/d² push |

Two of those (CL-06's dead gully, CL-10's cancelling relabel) are exactly the
"sheet could not see the property the cycle was about" failure. Both reported a clean
green number on a probe that was measuring nothing.

## 6. Open decisions

| decision | options | lean |
|---|---|---|
| contact diameter | 0.60 / **0.90** / 1.20 m | **0.90** — the only one derived from the rider |
| rail contact | **fully exempt** / immovable-but-solid / fully collidable | **fully exempt** — the only option with no gate hole; cost is that rivals visibly ghost through a grinding player at 0.51 m |
| lean vs bump | continuous lean / **0.35 s per-pair cooldown** / displacement budget | **cooldown** — measured to bring CL-04c under a defensible bar; stated as a feel constant, not smuggled in as physics |
| CL-04c bar | 1.5 / **2.5** / 4.0 m | **2.5** — clears honest by 14%, fails the first abuse by 54% |

## 7. Before any candidate is asked to hit this

Run `harness/preflight.mjs --lane collision` checks A–D. **D is the one that would
have saved the dead cycles:** build the field the rivals lane actually wants — AI-12
floor at 0.88, rivals contesting the player's line instead of standing 19 m off it —
and check this law *permits* it, before a builder is asked to hit it.

Promotion path: `harness/collision-runner.mjs`,
`harness/baseline-collision/contact.mjs`, `harness/collision-mutants.mjs`, wired into
`tests/suite.mjs` beside the rival gates.
