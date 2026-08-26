# Rails c4B — the grind as an inverted pendulum

One model: rider + board are an inverted pendulum pivoting about the board's
contact edge on the rail. Everything about balance is supposed to fall out of
two numbers — the support half-base `a` and the CoM height `H`. Where it does
not fall out, it is labelled **CHOICE** and the cost is stated.

Module writes **velocity only**, plus one lock-on position snap and
`ps.constrained`. It never writes heading and never writes trick state.

---

## 1. The model

Support base on the rail is the overlap of board and rail, so
`a = min(rail.width, board width)/2 = 0.10 m` for the 0.20 m rails the runner
uses (the 0.26 m board overhangs; the rail is the limit).

| symbol | value | where from |
|---|---|---|
| `H` CoM height above the board base | **0.90 m** | 1.8 m rider, standing CoM ≈ 0.55·H = 0.99 m (standard anthropometric fraction); grind stance is knees-bent, −13% → 0.86 m; + boot/binding/board stack ≈ 0.04 m. The −13% crouch allowance is a **CHOICE**. |
| `a` support half-base | **0.10 m** | `min(0.20 rail, 0.26 board)/2` — geometry, no choice |
| `θ_max` topple angle | **atan(a/H) = 6.34°** | geometry. **This IS the bail threshold.** `balance = θ/θ_max`, `\|balance\| > 1` means the CoM has left the support base. |
| `λ = √(g/H)` | **3.30 /s** | geometry. The pendulum's own divergence rate; time constant 0.30 s. |

Equation of motion, normalised (`u` = centre-of-pressure offset `p/a`, and
`|u| ≤ 1` because the rider can put his pressure anywhere inside the base and
nowhere outside it):

```
b'' = λ² ( b + L − u )        u = K_P·b + K_D·b'  +  steer·kSteer
```

`u` is split into an **autonomic ankle reflex** (`K_P`, `K_D`, always on) and
the **player's conscious correction** (`steer`). Integrated in closed form per
step from the exact eigenvalues of `b'' + C b' − A b = F`, so the balance state
is dt-exact too (only `alongSpeed` is gated for this, but there was no reason
to be sloppy).

Contract sign convention holds and is also the real ankle strategy: positive
`steer` moves the pressure toward the side you are falling to, which reduces a
positive `balance`.

## 2. What is derived and what is not — the honest ledger

**Derived from the geometry (no freedom):**

- bail threshold `|b| > 1` ⇔ CoM outside the base ⇔ tilt > 6.34°
- pendulum rate `λ = 3.30 /s`, hence `balanceHalfLife_s = ln2/s₊ = 0.611 s`
- curve load. Holding radius `R` at speed `v` needs lateral accel `v²κ`; in the
  board frame that is a pseudo-force pushing the CoM to the outside, which in
  pendulum units is a constant tilt offset
  `L = −κ·v²·H/(a·g)` — algebraically identical to standing on a tilted floor.
  This is why curve difficulty scales as **v²·κ** and why slowing down works.
- arrival lateral velocity → tilt rate: `b' = v_lat/a`, exact kinematics.
- the along-rail drag law shape `ds/dt = −g·t_y − sgn·μ_rail·g·cosθ − λ_rail·s`,
  same two-term form the accepted physics uses on snow, closed-form integrated.

**CHOICE — does not fall out of the pendulum. Each with its cost:**

| constant | value | why, and what it costs |
|---|---|---|
| `K_GRIP` arcade lateral-grip credit | **7.43** | *The big one.* See §3. Cost: a lateral force with no source in the free-body diagram. |
| `K_P`, `K_D` reflex gains | **0.78**, **0.09 s** | The rider is not a passive stick. A bare inverted pendulum at this scale topples in ~0.5 s from *any* realistic disturbance — to sit passively for 0.8–6 s it would need an initial tilt of 0.017°, which is not a physical quantity. So the reflex is modelled as a PD controller supplying 78% of the authority needed for neutral stability, leaving an unstable root `s₊ = 1.134 /s`. This is the one fitted pair in the module. Mitigating: GR-05's own text says the 0.8–6 s window is a *declared design choice, not a citation*, so this is a constant calibrated to a declared window, not a fake derivation. |
| `STANCE_BIAS` | **0.0319** (3.2 mm CoM offset, 0.20° of tilt) | The constant sideways offset that starts the fall. Calibrated so a dead-on hands-off grind topples at 2.2 s, mid-band. Cost: it acts on a fixed side (rail-relative), so a capture that misses to *that* side is genuinely more forgiving than dead-on — see §6. |
| `CAPTURE_R` = 1.0 m | | Half a board length of reach + the lateral shift a rider can make mid-air ≈ 0.98. Gate band is 0.5–1.5, "about one board length". It is forgiveness, not geometry. |
| capture tilt seed `b₀ = miss/CAPTURE_R` | | Linear, hitting exactly 1 (topple) at the edge of the radius. The capture radius is arcade, so the tilt it implies is arcade. |
| `V_ABSORB` = 0.85 | | Fraction of arrival lateral velocity the knees swallow. Without it, `b' = v_lat/a` means 0.5 m/s of sideways arrival = 5 /s of tilt rate = instant death, which no game does. |
| `RAIL_MU` = 0.06, `MIN_LOCK` = 3.0 m/s, `BAIL_KEEP` = 0.75, `ALIGN_COS` = 0.5 (60°) | | Ordinary tuning. Stated, not dressed up. |
| `H`'s −13% crouch allowance | | see table above |

**Not modelled, and I am flagging the disagreement rather than papering over it:**
the reference says *"turn sideways to balance easier"*. My geometry predicts the
opposite — with the board crosswise the rider's feet point *along* the rail and
he loses ankle authority in exactly the direction he falls, and the support base
does not widen (the rail is still 0.2 m across). I have no geometric account of
the reference's claim, so balance authority here is **independent of board
angle**. That also means rail spins (PC-19, physics-owned) cost no balance in
this module. If the bar owner wants sideways-is-easier it has to come in as a
declared arcade term, not as a consequence of this model.

## 3. K_GRIP: the number the pendulum cannot supply

With `K_GRIP = 1` (honest geometry), the curve load at 18 m/s is

```
|L| = v²·H/(a·g·R) = 297.25 / R
```

so `L(R=40) = 7.43`, `L(R=200) = 1.49`, `L(R=1000) = 0.30`. Anything under
`R ≈ 300 m` is *un-ridable at 18 m/s* — which is correct: 18 m/s round a 40 m
radius is 8.1 m/s² of lateral accel, 0.83 g, on a 20 cm bar. The reference bar
has ridable curved rails at speed. So a concession is required and it is
`K_GRIP`.

I checked the obvious physical patch first and rejected it. **Real friction
between board base and rail gives a cliff, not a curve**: with µ_lat ≈ 0.35 the
rail supplies up to `µg = 3.43 m/s²` *subtractively*, so

| R | v²/R | residual after friction | load |
|---|---|---|---|
| 40 | 8.10 | 4.67 | 4.28 |
| 80 | 4.05 | 0.62 | 0.57 |
| 93 | 3.48 | 0.05 | 0.05 |
| 120 | 2.70 | 0 | **0 — free** |

That is exactly the "free until R150, ejected at R120" cliff a previous
candidate in this lane was killed for. So the credit is applied
**multiplicatively** — `|L| = v²κH/(a·g·K_GRIP)` — which cannot produce a free
zone at any radius. `K_GRIP = 7.43` is set so `|L| = 1` (full centre-of-pressure
authority, the edge of the mechanic) lands on **R = 40 m at 18 m/s**.

Cost, stated plainly: 86.5% of the centripetal force on a curved rail has no
source. Friction can honestly account for about the first 1.7× of it; the
remaining ~4.3× is arcade licence bought to match the reference bar.

## 4. Rail drag — why a rail is faster than snow

Same two-term law as snow, both terms re-derived for a steel/plastic rail:

- **Coulomb**: `RAIL_MU = 0.06` (CHOICE) — about 2× snow's 0.0305, because there
  is no self-lubricating meltwater film across a full contact patch, but the
  patch is ~20× smaller.
- **Linear**: on a rail there is **no snow deformation**, so the linear term
  collapses to aerodynamic drag alone. `½ρC_dA/m` with ρ = 1.2, C_dA = 0.3 m²,
  m = 80 kg → `k = 0.00225 /m`, i.e. 0.73 m/s² at cruise. Linearised at
  `V_REF = 18.4 m/s` → `λ_rail = 0.0414 /s`, against snow's 0.2235.

`V_REF = 18.4` is the midpoint of the reference bar's cruise band
(58–75 km/h = 16.1–20.8 m/s). It is **not** taken from the runner — a previous
candidate in this lane died for lifting a constant out of `arcRail()`'s default
argument.

Result: `dragScale = (0.06·g + 0.0414·18.4)/(0.0305·g + 0.2235·18.4) = 0.306`,
i.e. a rail resists at ~31% of snow at cruise. Measured, 20 m/s over 5 s:
**rail 12.90 m/s vs snow 5.64 m/s.**

## 5. The lock-on speed-conversion trap, measured

Speed is converted to along-rail speed with a **3D** projection
`v·t̂₃`, not by projecting horizontal speed onto the horizontal tangent. The
horizontal-only version taxes a rider dropping onto a descending rail by
`1 − cos(slope)` — exactly where the rail is supposed to be the fast line.
Measured on a slope-`d` rail, approach along the rail:

| slope | this module's alongSpeed | horizontal-only would give | tax |
|---|---|---|---|
| 0° | 18.00 | 18.00 | 0.0% |
| 10° | 18.02 | 17.73 | 1.5% |
| 25° | 18.05 | 16.31 | **9.4%** |
| 40° | 18.07 | 13.79 | **23.4%** |

Capture distance is likewise 3D, so a rider under a bridge does not grab the
rail above him.

## 6. Curvature without a magic lookahead length

A polyline has zero curvature inside a segment and infinite curvature at a
vertex. Any fixed-length probe body straddles a varying number of vertices and
produces exactly the free-then-cliff pattern the lane has already been burned
by (traced to a `D_BODY = 0.25 m` choice, not to probe gain).

Instead, curvature is carried on **nodes at segment midpoints**: the turn taken
at vertex *i* is spread over the half-segment either side of it, so

```
κ = turn_i / ((L_i + L_{i+1})/2)
```

This is **exactly 1/R** for any polyline inscribed in a constant-radius arc, at
any vertex spacing, and **exactly 0** on a straight rail. There is no length
constant to tune and no window to straddle.

## 7. Measured: hold time vs radius at 18 m/s

Constant-radius arcs, rider locked on dead-centre. "passive" = no input at all.
"P3" = the runner's own proportional probe (`steer = clamp(3·balance)`).
"PD" = a competent player (`clamp(4b + 0.35b')`). Arcs swept 300° so that
running off the end of the rail is never mistaken for holding it.

| R (m) | passive life (s) | P3 controller | P3 mean stick | PD controller |
|---|---|---|---|---|
| 20 | 0.30 | 0.35 bail | 0.688 | 0.40 bail |
| 30 | 0.37 | 0.48 bail | 0.734 | 0.63 bail |
| 40 | 0.42 | 0.72 bail | 0.798 | **held** |
| 60 | 0.48 | held | 0.304 | held |
| 80 | 0.55 | held | 0.238 | held |
| 120 | 0.63 | held | 0.174 | held |
| 200 | 0.75 | held | 0.127 | held |
| 400 | 0.90 | held | 0.096 | held |
| 1000 | 1.03 | held | 0.081 | held |
| straight | **2.20** | held | 0.034 | held |

(all three columns measured at 18 m/s over one 12 s run per row; the P3 "mean
stick" column is mean |steer| over the first lock, the same quantity GR-06's
effort probe reports)

Monotone, no free zone, no cliff: passive life falls smoothly by a factor of 7
from straight to R = 20, and the stick a held grind demands rises smoothly by a
factor of 8.9 from straight (0.034) to R = 60 (0.304). R = 40 at 18 m/s is deliberately the
ragged edge — the runner's own P3 probe drops it, a better controller holds it.

Because the load is `v²κ`, the mechanic reads as "slow down for the tight one".
Tightest radius a PD controller holds indefinitely:

| speed | 10 | 12 | 14 | 16 | 18 | 20 | 24 | 28 m/s |
|---|---|---|---|---|---|---|---|---|
| tightest holdable R | 10 | 15 | 25 | 30 | 40 | 50 | 80 | 100 m |

That ladder is `R ∝ v²` to within the sampling grid — it is the model, not a
tuning table.

**Crouch costs balance authority**, as the ground does (`CROUCH_STEER = 0.45`,
`TUCK_STEER = 0.60`, both taken from the accepted physics). Measured on an
R = 80 arc under the P3 controller: **3.70 s holding without crouch, 0.78 s with
crouch held**. You cannot charge a full pop off a curved rail for free.

**Sign asymmetry, disclosed.** `STANCE_BIAS` acts on a fixed side, so a capture
that misses to that side is more forgiving than a dead-on one. Passive life vs
lateral miss on a straight rail: 0 m → 2.20 s, +0.2 m → 2.78 s, +0.4 m → 1.43 s,
+0.6 m → 0.90 s, +0.8 m → 0.53 s, +0.95 m → 0.23 s. The bump at 0.2 m is real
and is a consequence of a constant-direction bias, not a bug — but the bias
direction is rail-relative here, where physically it should follow the rider's
toe edge (stance + facing). That is an approximation.

## 8. Ownership boundaries

- **Never** writes `spinDeg, flipDeg, airTime, charge, _popDone, spinCapped,
  flipCapped, prewound, landing` (GR-11: measured 0 writes with spin driven and
  a mid-run pop producing 31 genuinely airborne frames).
- **Never** writes heading. Writes position on exactly one frame per lock, the
  documented snap (GR-07: `illegalWriteMax = 0`).
- Rail spin, rail-spin reset on exit and the mid-spin-pop heading settle are
  PC-19/20/21, i.e. physics. Nothing here touches them. GR-10 is retired and
  nothing here is designed for it.
- The rider is kept on the rail line by a **corrective velocity** toward the
  closest point (`PULL = 8 /s`, capped at 2 m/s), never by a position write.
  Without it, a purely tangential velocity integrated by physics' Euler step
  drifts outward on a curve at `(v·dt)²/2R` per frame.
- Exit by pop: physics' `constrainedStep` sees `jumpRelease`, does the true
  takeoff and clears `constrained` *before* this module runs. The module detects
  the cleared flag and touches nothing — measured leave-speed loss **0.0000**.

## 9. Gate results (self-run)

`node harness/rail-runner.mjs --module sandbox/rails/c4B/rails.mjs`

```
PASS GR-01 autoLockRate = 1
PASS GR-02 captureRadius_m = 1            (band 0.5-1.5)
PASS GR-03 railFasterThanSnow = 1         (rail 12.90 vs snow 5.64 m/s)
PASS GR-04 leaveSpeedLossFrac = 0         (16.46 -> 16.46 m/s)
PASS GR-05 balanceMechanicReal = 1        (passive bail 2.22 s, active held 1.00)
PASS GR-06 curveDemandsSteer = 1          (straight 2.20 s / eff 0.034;
                                           R40 0.42 s eff 0.36-0.43,
                                           R80 0.55-0.58 s eff 0.24-0.31, both signs)
PASS GR-07 illegalWriteMax = 0
PASS GR-08 phantomLocks = 0
PASS GR-09 dtSplitError = 0               (14.522349217231147 vs ...15)
PASS GR-11 trickStateWrites = 0           (31 airborne frames in the probe)
10/10 active gates, 0 hard fails.
```
