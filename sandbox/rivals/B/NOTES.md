# Rivals — candidate B — BEHAVIOUR MIX

`node harness/rival-runner.mjs --module sandbox/rivals/B/rivals.mjs` → **13/13, hardFails 0.**

## The idea

Every frame each rival evaluates five named behaviours. Each returns a desired
steer and/or throttle plus a **weight**, and the input is the weighted sum:

| behaviour | steer | throttle | weight |
|---|---|---|---|
| LINE    | seek lane target at LOOK_M | +1 | 1 (the reference weight) |
| AVOID   | lateral push off the nearest rider | −1 when tailing someone in-lane | 0…5.0 near, 0…0.55 far |
| JUMP    | 0 (holds what it has while loading) | 0 | tier.jumpW while the window is open |
| BOOST   | — | +1 | tier.boostW while the meter is up |
| CAUTION | — | −1 | tier.cautionW × (timid + cornerLoad) |

`steer = Σwᵢsteerᵢ / Σwᵢ`, `thr = Σwᵢthrᵢ / Σwᵢ`. Dividing by the weight sum is
what bounds the mix: no weight, however large, drives the output past what its
own behaviour asked for. The throttle scalar then becomes a **duty cycle** on
the boost and brake keys via two per-rider phase-offset sawtooths — that is how
a fractional demand reaches a binary key.

Tiers are five named parameters (`stats`, `cautionW`/`timid`,
`boostW`/`boostSkill`, `jumpW`). The **line is identical across tiers**:
lookahead is a module constant, not a tier field, because on this course a lazy
line cuts the meander's corners and inverts the tier order.

## Measured (rival-runner, 8-seed × 4-rival matrix)

| | value | gate |
|---|---|---|
| replay error | 0.000 m over 40 tapes | AI-01 ≤ 1e-6 |
| state writes / assignments / over-cap frames | 0 / 0 / 0 | AI-06 = 0 |
| finish rate | 32/32 | AI-03 |
| widest line | **93.9 m** of a 120 m half-width | AI-04, 26 m spare |
| rubber-band ratio | **1.0653**, assist-while-leading 0 | AI-05 ≤ 1.15 |
| tier means | easy 141.4 / medium 101.9 / hard 91.8 s, player 107.6 s | AI-07/08/09 |
| tier gaps | 36.8% and 9.3% of course time | AI-09 ≥ 3% |
| slowest easy vs player | +24.2 s | AI-07 |
| charged pops (worst rival) | 5, best charge 0.49 | AI-10 ≥ 3 @ 0.25 |
| lateral std (worst rival) | 7.49 m | AI-10 ≥ 2 m |
| min separation | 2.501 m (= the start-gate spacing; no in-race pass is closer) | AI-12 ≥ 0.6 |
| step cost | 0.0028 ms/frame (5 rivals); startup 0.029 ms | AI-13 ≤ 1.5 / 16.7 |

## Four things that were wrong and are now measured

1. **The avoid steer had the wrong sign.** The seek is
   `atan2(dz, dx) − heading`, so a positive steer turns toward −x. Repelling
   with `+sign(dx)` made AVOID an *attractor*: two riders 0.018 m apart three
   seconds off the start gate.
2. **The avoid radius must sit inside the lane pitch.** At radius 16 against a
   12 m pitch the two easy rivals were inside each other's radius for the whole
   run and walked 300 m out of the corridor.
3. **Steering is inert in the air**, and this course hands each rider ~35 s of
   it, so a repulsion that only wakes at 10 m sleeps through the encounter. The
   weak wide early term is what actually holds the gap: the worst pass with the
   player went 0.545 m → 2.501 m.
4. **Catch-up must run through the brake, absolutely, not the boost.** Three
   failed channels: fractional caution cut 0.55 → **1.5296**; fractional cut
   0.12 → **1.3753**; boost-key catch-up → **1.1909** *and inconsistent in sign*
   (assisted was slower on 4 of 16 live pairs), because a boost pulse pulls a
   15 m/s rider toward V_BOOST 31 and rewrites every jump after it. An absolute
   0.03 drop of CAUTION weight is worth 4–6% of a trailing rival's finish
   (152.9 → 146.8 s parked-player) and lands at 1.0653.

## Rejected after measuring

- **JUMP steering toward the higher shoulder** (two extra `sampleHeight` probes
  either side of the rider). It pulled riders across the player's track and the
  corridor: AI-12 2.501 m → 0.091 m, widest line 93.9 m → 103.5 m. `sJump` is 0
  on purpose, and the JUMP weight now acts as a steering damper while loading.

## Disclosed

- **The easy tier is a long way off the pace** — 141 s against the player's
  107.6. It is beatable by 24 s, not by a nose. Making it closer means giving it
  throttle authority, and every lever that does that (boost especially) is the
  one that broke AI-05.
- **AI-12 reads 2.501 m because that is the start-gate spacing the harness owns**
  — no rider ever comes closer than the grid does. The medium rival is the one
  that races near the player, and it is the encounter the wide avoid term exists
  for.
- **AI-13's "5 rivals sustain 60 fps in the rig" half is browser-only** and not
  measured by this runner, as the runner itself says on every run.
- `_topHorizSpeed_mps` reads 33.97 against V_CAP 33: landing-redirect
  transients, 0 sustained frames, exactly as the runner's comment describes for
  the honest baseline.
