# Rails c4A — balance as a normalised divergent mode

`node harness/rail-runner.mjs --module sandbox/rails/c4A/rails.mjs` → **10/10 active GR gates pass, 0 hard fails.**
GR-10 is retired and was not designed for. All rail rotation is physics' (PC-19/20/21);
this module writes velocity, `constrained`, and one lock-on position snap. Nothing else.

---

## 1. The mechanic

The rider on a rail is an inverted pendulum whose base is the rail line. Lean `θ` from
vertical, CoM height `L` above the board, corrective input `u` (rad/s², from ankle/hip
torque and counter-rotation):

```
θ'' = (g/L)·θ + u                       (linearised, sinθ ≈ θ)
```

Substituting `λ = sqrt(g/L)` and splitting into modes `s± = θ' ± λθ`:

```
s+' = +λ·s+ + u      DIVERGENT
s-' = −λ·s- + u      convergent — ignored, it takes care of itself
```

**`balance` is `s+` normalised by `u_max/λ`.** Under `|u| ≤ u_max`:

- if `|s+| ≥ u_max/λ`, then `|s+|' = λ|s+| + sgn(s+)·u ≥ λ|s+| − u_max ≥ 0` — the
  magnitude cannot decrease, so it diverges. No input recovers it.
- if `|s+| < u_max/λ`, then `u = −u_max·sgn(s+)` gives `|s+|' ≤ λ|s+| − u_max < 0`,
  so `|s+|` falls monotonically and reaches 0 in finite time.

So `|balance| = 1` is exactly the recoverability boundary **of that mode**, and the
dynamics in balance units are one line:

```
balance' = λ·balance + Φ(curvature) + β(stance bias) − λ·u_steer
```

`u_steer = clamp(steer,−1,1) · (crouch ? 0.45 : 1) · (tuck ? 0.6 : 1)`. Positive steer
reduces positive balance (contract convention). Integrated in closed form
(`b ← (b + A/λ)·e^{λdt} − A/λ`, `A` frozen per step), so it is dt-exact like `alongSpeed`.

### What is proved and what is not

**Proved:** the two lines above, for the scalar mode `s+` under a bounded input. That is
a real result about a real ODE, not a fitted threshold.

**Heuristic — do not call this proved:**
- The full state is `(θ, θ')`; I collapse it to `s+` and ignore both the convergent mode
  and any geometric tip-off limit on `|θ|`. A rider can therefore be inside `|balance|<1`
  while already physically off the rail in a fuller model.
- `u_max` is treated as constant. Real balance authority falls off as the rider runs out
  of lean range.
- The linearisation `sinθ ≈ θ` is 4% optimistic at `θ_auth = 0.489 rad`, so the model
  slightly overstates authority at full lean.

**`|balance| = 1` is a modelled boundary, not a proof of irrecoverability for the rider.**

---

## 2. Every constant: derived, chosen, or fitted

| constant | value | status |
|---|---|---|
| `L_COM` | 0.99 m | **derived** — 0.55 × the project's 1.8 m rider (standard CoM fraction) |
| `LAM` (λ) | 3.1479 /s | **derived** — `sqrt(g/L_COM)`. The unstable eigenvalue. Doubling time `ln2/λ` = 0.220 s |
| `THETA_AUTH` | 28° = 0.4887 rad | **CHOICE** — max steady lean the rider can hold. Cost below |
| `U_MAX` | 4.8425 rad/s² | **derived** — `g·θ_auth/L_COM` (static lean ↔ lateral accel) |
| `KGAIN` | 0.65662 s/m | **derived** — `λ/(g·θ_auth)`; falls out of the normalisation |
| `BETA` (β) | 0.0058158 /s | **FITTED**, not derived — see below |
| `CAPTURE_R` | 1.0 m | **sourced** — research 02 §1.5 marks 0.5–1.5 m `[EST]`; midpoint |
| `DRAG_SCALE` | 0.35 | **CHOICE** — research says only "drag ≈ 0 / faster than snow", no number |
| `MIN_LOCK_SPEED` | 3.0 m/s | **CHOICE** — anti-phantom floor |
| `CURV_WINDOW` | 4 m, ≥1.5× mean segment | **CHOICE** — see §5 |
| `LINE_PULL` | 8 /s | **CHOICE** — direction-only, magnitude-preserving (§4) |
| physics constants | MU 0.0305, LAMBDA 0.2235, V_CAP 33, V_BOOST 31, CROUCH_STEER 0.45 | **mirrored** from `src/physics/physics.mjs` DEFAULTS; `env` exposes none of them. Overridable via `env.physicsTuning`. A physics retune silently desyncs this file. |

### `THETA_AUTH = 28°` — the choice and its cost

It sets the **critical radius**: the tightest arc holdable by *any* bounded input is
`R* = v²/(g·θ_auth)` = **67.6 m at 18 m/s** (linearised; the exact statics would use
`tan θ`). Consequences, both measured in §3:

- an arc at `R = 80` costs 93% of the stick and is barely holdable;
- an arc at `R ≤ 70` at 18 m/s **cannot be held at all**, by anyone. That is the price.
- at 12 m/s `R*` drops to 30 m, so slow rails are far more forgiving — speed is the
  difficulty knob, which is the right shape for the reference bar.

A smaller `θ_auth` moves `R*` out and makes ordinary bends unrideable; a larger one makes
the whole curved-rail mechanic free. 28° is a taste call. It is not sourced.

### `BETA` — honestly a fit, with the physical size reported

Nothing deterministic tips a perfect rider off a perfectly straight rail; real ones are
tipped by rail chatter and neuromuscular noise, and this module may not use randomness.
So a constant stance-bias torque stands in for it — the reference's "turn sideways to
balance easier" is exactly a stance asymmetry. I **fitted** it to the declared passive
bail time rather than deriving it:

```
β = λ / (e^{λ·T_BAIL_FLAT} − 1),  T_BAIL_FLAT = 2.0 s (CHOICE; GR-05's window is 0.8–6 s)
```

Equivalent physical size, so it can be judged: `u_bias = 0.00895 rad/s²`, a static lean
bias of **0.052°**, i.e. the CoM sitting **0.89 mm** off the rail centreline. That is
plausible; if it had come out at 5×10⁻⁵ degrees I would say so. Note `T_BAIL_FLAT` is
only logarithmically sensitive to β — doubling β moves it by 0.22 s.

### Traps deliberately not re-earned

- **Capture uses full 3D speed**, never the horizontal projection. Measured on a
  descending rail: 18.05 m/s in → 18.05 along-rail at 25°, 18.07 → 18.07 at 40°;
  horizontal-only would have handed back 16.36 and 13.84 (**9.4% and 23.4% tax**).
  *No gate rewards this* — the runner's rails are flat, and a horizontal-only mutant
  still scores 10/10. It is in because it is right.
- **No constant is taken from a runner default.** `θ_auth` comes from a feel target,
  `R*` is a consequence of it; `arcRail()`'s default `radius = 40` is never referenced.
- **No two-row curve fit.** Nothing here is fitted to a table.
- **Crouch costs balance authority** (`CROUCH_STEER = 0.45`), tuck likewise — §3.

---

## 3. Measured difficulty curve (the thing that must be a curve, not a cliff)

80° constant-radius arcs, entry at 18 m/s, N = 24 tessellation (the runner's own).
Reproduce with the probe described in §6.

| R (m) | passive hold, no input (s) | mean stick, first 0.5 s | min authority limit that holds 3.5 s | analytic `s* = (β+Φ)/λ` at 18 m/s |
|---|---|---|---|---|
| straight | **2.000** | 0.002 | 0.002 | 0.002 |
| 400 | 0.617 | 0.166 | **0.188** | 0.171 |
| 300 | 0.533 | 0.220 | **0.250** | 0.227 |
| 250 | 0.483 | 0.264 | **0.300** | 0.272 |
| 200 | 0.433 | 0.329 | **0.374** | 0.340 |
| 150 | 0.367 | 0.438 | **0.498** | 0.452 |
| 120 | 0.317 | 0.547 | **0.622** | 0.565 |
| 93 | 0.267 | 0.705 | **0.802** | 0.729 |
| 80 | 0.250 | 0.819 | **0.931** | 0.847 |
| 70 | 0.217 | 0.875 | *unholdable* | 0.967 |
| 60 | 0.200 | 0.892 | *unholdable* | 1.128 |
| 50 | 0.167 | 0.877 | *unholdable* | 1.354 |
| 40 | 0.133 | 0.843 | *unholdable* | 1.691 |

Read the **fourth column**, not the second. Passive hold time is a bad difficulty axis
for a divergent mode: it is `ln(1 + λ/(β+Φ))/λ`, logarithmic, so it compresses a 10×
range of load into a 4× range of time and makes everything look equally doomed. The
stick demand `s*(R) = β/λ + v²/(g·θ_auth·R)` is **linear in 1/R with no threshold and no
deadband**, and the measured column tracks it to ~10% (the gap is speed decay during the
measurement plus the entry transient).

Against the cliff this lane has seen before (R200 7.72 → R150 7.72 → R120 0.58 → R40 0.10
— a plateau, then a wall): here **R = 400 already costs 19% of the stick**, every step
down is monotone, and the unholdable boundary arrives gradually at 0.93 stick, not from
"free".

The straight → R = 400 step in the passive column (2.00 → 0.62) is real and is inherent:
once the bend load exceeds the stance bias, curvature dominates completely. `Φ = β` at
`R ≈ 36 km`. Any bend a level designer draws is curvature-dominated; that is the physics
of an unstable mode, not a tuning gap. The stick column shows the same region as a smooth
ramp from 0.00 to 0.19.

**Tessellation independence** (a rail's difficulty must depend on its radius, not on how
finely it was authored). Every number above is identical to 3 decimals at N = 12, 24, 60
and 120. It was *not* before §5's fix: at N = 12 a dead-on entry to an R = 400 arc used to
seed `balance = 0.687`, versus 0.069 at N = 120. Now 0.045 → 0.044 across that range.

### Crouch and tuck cost balance authority

Min authority limit that holds an arc for 3.5 s:

| R | upright | crouched (charging a pop) | tucked |
|---|---|---|---|
| 400 | 0.188 | 0.526 | 0.353 |
| 250 | 0.300 | 0.837 | 0.562 |
| 200 | 0.374 | **cannot hold** | 0.701 |
| 150 | 0.498 | **cannot hold** | 0.933 |
| 120 | 0.622 | **cannot hold** | cannot hold |

You cannot charge a full pop off a bend tighter than ~R 220 at 18 m/s. Charge on the
straight section, or take the bend uncharged.

---

## 4. What the module writes, and what it refuses to

- **Velocity** — every on-rail frame, direction from the rail tangent, magnitude exactly
  `alongSpeed`.
- **`ps.constrained`** — `true` for the whole lock (contract's declared mechanism), and
  `false` on every exit path: bail, rail end, speed collapse, and physics' own pop.
- **Position — once**, the documented lock-on snap, on the lock frame only.
  GR-07 measures `illegalWriteMax = 0`.
- **Never**: heading, `spinDeg`, `flipDeg`, `airTime`, `charge`, `_popDone`,
  `spinCapped`, `flipCapped`, `prewound`, `landing`. GR-11 measures `trickStateWrites = 0`
  with spin driven *and* an airborne window in the probe.

**Leaving the rail.** Physics' `constrainedStep` consumes `jumpRelease` and performs the
true takeoff before this module runs. The module detects `constrained === false` while
`onRail`, releases, and **writes no velocity that frame** — so the horizontal speed
physics carried through is handed on untouched. GR-04 measures a loss of exactly 0
(16.19 → 16.19 m/s).

**Staying on the line without a position write.** Physics Euler-integrates position, which
drifts outward on a bend. The module blends a corrective term into the velocity
*direction* and then rescales to `alongSpeed`, so the correction can neither add nor
remove speed, and it is identically zero on a straight rail (keeping GR-09 exact at 0).
Measured residual on a held R = 120 arc: **max 11 mm** off the line over 343 frames.

**Speed.** Same two-term law as snow with resistance scaled by `dragScale`, plus gravity
along the tangent, integrated in closed form. Measured 20 m/s for 5 s: rail **12.54** vs
snow **5.64** (GR-03).

**Boost.** `constrainedStep` runs no boost, so the module owns it. Rather than invent a
number: boost is the thrust that holds `V_BOOST` on flat snow,
`D = μg + λ_long·V_BOOST = 7.228 m/s²`. Against the rail's lower resistance that thrust
reaches `(D − F0)/b = 91 m/s`, clamped by the project-wide `V_CAP`. Measured: **rail boost
32.99 m/s vs snow boost 30.99 m/s** — "you go faster boosting on a rail than on the snow",
derived rather than asserted.

### Open decision for the lane owner (flagged, not silently resolved)

`physics.constrainedStep` never calls `meterTick`, so **`boostMeter` does not drain while
grinding**: measured 0.998 remaining after 5 s of rail boost, against 0.375 on snow. Rail
boost is currently free. This module deliberately does **not** patch that, because the
repeated failure in this lane is rail modules writing physics-owned state (the private
charge counter, the `spinDeg` writes). The fix belongs in `constrainedStep` — one
`meterTick(st, input, dt)` call. Say the word and I will drain it here instead; it is not
gated either way.

---

## 5. Two geometry fixes, and why they are not gate-chasing

`CONTRACTS.md` calls `rails[].points` *spline control points*, so the polyline is a
sampling of a smooth rail, not the rail itself. Two consequences were measured and fixed:

1. **Chord tangents are biased by half a segment's turn.** A rider arriving dead-on at an
   arc read a phantom lateral closing rate of `v·sin(halfTurn)` and got a capture seed set
   by the *tessellation*: `balance = 0.687` at N = 12 vs 0.069 at N = 120, on the same
   400 m-radius rail. Fixed with vertex-averaged tangents (ends extrapolated as
   `1.5·d₀ − 0.5·d₁`, exact to first order on a circular arc). Seed is now 0.045 → 0.044
   across N = 12…120.
2. **The curvature window must span a vertex on each side, and must read the tangent
   field, not chords.** A truncated window read the first metres of every bend as dead
   straight — precisely the free-then-ejected discontinuity this design exists to avoid —
   so the window slides inward instead of truncating, and is at least 1.5× the mean
   segment. Chord-pair estimation was separately 12% low on coarse arcs (R = 400 read as
   450); differencing the smooth tangent angle reads **400 as 400 at every N**.

Residual cost: curvature is averaged over ≥4 m, so a bend shorter than that reads softer
than it is.

---

## 6. Self-verification

```
node harness/rail-runner.mjs --module sandbox/rails/c4A/rails.mjs
→ GR-01 pass  GR-02 pass  GR-03 pass  GR-04 pass  GR-05 pass
  GR-06 pass  GR-07 pass  GR-08 pass  GR-09 pass  GR-11 pass
  {"counts":{"pass":10,"fail":0,"error":0},"hardFails":0}
```

Gate side-channels: `GR-05` passive bail **2.02 s** (window 0.8–6), active held fraction
**1.00**. `GR-06` straight life 2.00 s / effort 0.0027; arcs R40 life 0.10 s effort 0.997
and R80 life 0.17 s effort 0.617 — **both bend directions agree to 0.01 s and 0.006
effort**, so nothing here passes on a one-sided quirk. `GR-09` split error 0 (1e-14 in the
raw values). `GR-07` `illegalWriteMax = 0` with 2 lock snaps and 25 airborne frames in the
probe.

**Mutation-checked against my own gates** (each mutant run, then reverted):

| mutation | result |
|---|---|
| `Φ = 0` (kill curvature load) | GR-06 **fails** — the gate is measuring my curvature term, not a capture artifact |
| `β = 0` (kill stance bias) | GR-05 **fails** — the passive bail is the bias, as claimed |
| capture uses horizontal speed only | **still 10/10** — the descending-rail trap is genuinely ungated |

Also measured, no gate involved: 30 s runs with mixed steer/crouch/jumpRelease/boost on
straight, R = 120, R = 60 and a deliberately coarse 7-point arc produce no NaN, no runaway
speed, and no re-lock loop.

**Not verified:** anything off flat ground. Every GR probe uses a constant-height
synthetic surface, so slope-gravity drive along the rail, the tangent-slope `cos θ` term,
and descending capture are exercised only by my own probes above, never by the harness.
