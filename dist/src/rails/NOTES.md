# c5B — grind as a bounded-input control problem

## 1. The plant

Rider on a rail = inverted pendulum in the roll plane, CoM height `h` above the
support line. Linearised about upright, with `u` the rider's commanded roll
acceleration and `w` the disturbance:

```
th'' = wn^2 * th + w - u ,      wn = sqrt(g/h)
```

`h = 0.90 m` (rider 1.8 m, CoM at half height — project convention), so
**wn = 3.3015 /s**. Pole pair at `+-wn`: one divergent, one stable. This is the
only number here that is *derived*.

## 2. The divergent mode and its capture region

Modal coordinates `sig = th + th'/wn` (divergent) and `th - th'/wn` (stable):

```
sig' = wn * sig + (w - u)/wn
```

The stable half takes care of itself. For the divergent half with `|u| <= umax`
and quasi-static `w`, `sig' <= 0` is achievable iff `u >= w + wn^2 * sig`, so the
set from which admissible input can still return `sig` to 0 is

```
|sig| < (umax - |w|) / wn^2      ->   |sig| < umax/wn^2  when w = 0
```

`gstate.balance` **is that coordinate, normalised by the unloaded boundary**:
`b = sig * wn^2 / umax`, so `|b| > 1` is the bail. Writing `A_AUTH = umax * h`
(lateral authority in m/s^2) gives the whole balance law:

```
b' = wn * ( b + aLat/A_AUTH + aTex/A_AUTH - steer ),    aLat = v^2 * kappa
```

Integrated in closed form each frame (`b <- (b + q/wn) e^{wn dt} - q/wn`), so the
balance state is dt-exact too, not just the speed.

**Honesty about "irrecoverable".** The threshold is *exact for the surrogate*:
for a scalar linear unstable system with bounded input, the null-controllable
region really is `|sig| < umax/wn^2`. It is **not** a proof about a snowboarder.
Three things are chosen, not derived:

- `A_AUTH = 21 m/s^2` — tuned so a gain-3 controller saturates between R=25 and
  R=20 at cruise. Cross-check, not derivation: physics' snow lateral ceiling is
  `A_LAT = 26`, and a 0.2 m rail should give less purchase than a full snow edge
  (21 = 0.81 x 26). **CHOICE. Cost:** it makes the boundary `sig* = A_AUTH/g =
  2.1 rad` of roll, which is physically absurd, i.e. `balance` is a *normalised
  control coordinate, not a literal lean angle*. The pendulum fixes the
  time constant; it does not fix the authority. Stated rather than hidden.
- the disturbance spectrum (below).
- treating `w` as quasi-static inside one frame. It is not; over the ~0.3 s
  divergence time it nearly is.

## 3. Disturbance: why a passive rider actually falls

With `w = 0` and `b(0) = 0` the model rides forever — an unstable pole with no
excitation is decoration. So texture is part of the plant: a bounded, **zero-mean
deterministic lateral acceleration indexed by ARCLENGTH** (long 160 m swell +
13 m ripple, peak 0.42 m/s^2). Zero-mean and rail-relative-symmetric, so no rail
has a systematically good side and neither bend direction is favoured — measured
at R=80: 0.186 stick clockwise vs 0.193 counter-clockwise. It is *locally*
signed, as a real rail is. **CHOICE** (amplitude tuned to a ~1.35 s passive bail;
escape time is logarithmic in it, so it is insensitive: halving or doubling the
amplitude moves the bail to 1.49 s / 1.07 s).

## 4. Descending rails

`a(v) = -g*t_y - dragScale*(MU*g*cos(theta) + LAMBDA*v)`, the accepted snow law
scaled by `dragScale = 0.20`, plus gravity along the 3D tangent. Linear in `v`,
so the closed form `v = veq + (v0-veq)e^{-B dt}` is dt-exact. Both clamps (0 and
V_CAP) are absorbing boundaries on a monotone flow, so one 100 ms step and ten
10 ms steps land on the same value — the cap does not cost exactness. Measured
25 deg descent: rail 29.9 m/s horizontal at the bottom vs 15.8 on the snow
beside it, never above 33 m/s. Removing *both* V_CAP clamps overshoots by
+14.9 m/s, so the cap is load-bearing, not decorative.

Lock-on speed follows the accepted physics' own two rules instead of inventing a
third: a **grounded** rider crossing onto the rail keeps speed magnitude
(`retangent()`); an **airborne** rider landing on it loses the normal component
(`land()`). That is why a descending rail is not taxed at the lip.

## 5. Other decisions

| thing | value | why |
|---|---|---|
| `captureRadius_m` | 1.00 horizontal | research 02 §1.5 [EST] 0.5–1.5 m; measured by the runner's bisection at 1.000 |
| capture height window | ±0.75 m | board must be near the rail vertically, not just in plan |
| alignment gate | `|v·t| / |v| >= 0.5` | crossing a rail at 70 deg is not a grind |
| `minGrindLength_m` | 8.0 | refuse a lock with <0.5 s of rail left. Also the only sane answer to a **self-overlapping** rail: the 720 deg probe arc ends on top of its own start, and the nearest point to an arriving rider is the last 2 m of the final loop |
| curvature | per-vertex turn / adjacent half-lengths, lerped | a fixed-lookahead probe on the 30 deg-per-segment 720 deg polyline reads 0 mid-segment and 2x at a vertex; this reads 1/R everywhere |
| closest-point search | windowed to `[s-3, s+6]` once locked | a multi-loop rail passes over itself; a global search teleports `s` between loops |
| stabilisation | `v += 10 * (railPoint - pos)` | project integrates position with Euler, which drifts ~1 m outward over 8 s at R=20. **Velocity only**, never position |
| crouch | `steer *= 0.45` | charging a pop costs balance authority (physics `CROUCH_STEER`) |
| boost | drives toward 33 m/s with rail drag | "you go faster boosting on a rail than on the snow" |

`dragScale = 0.20` is a **CHOICE**. Cost: 18 -> 11.9 m/s over an 8 s grind, so the
long-arc stick means below understate the demand at entry speed (first-2 s means
given too). Snow over the same 8 s falls to ~4.5 m/s.

## 6. Disclosed blind spot in GR-06

GR-06 measures curvature load at **one speed**. A mutant replacing `v^2*kappa`
with `468*kappa` (constant x curvature) still passes all 12 gates. My own
evidence that the load is quadratic in `v`, which the sheet cannot see:

| v (m/s) | tightest R held | 1.5 v^2 / A_AUTH |
|---|---|---|
| 12 | 9 | 10.3 |
| 18 | 21 | 23.1 |
| 25 | 40 | 44.6 |

(measured slightly tighter than predicted because speed decays during the run).
