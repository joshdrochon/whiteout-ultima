# rails c5A — grind as a rigid-body balance

One model: the rider is an inverted pendulum standing on the board's contact
edge. Every balance number falls out of it except the four tagged CHOICE.

## Derived

| quantity | derivation | value |
|---|---|---|
| support half-width `a` | `min(boardWidth 0.25, railWidth)/2` | 0.100 m |
| CoM height `h` | 0.55 x 1.8 m stature (anthropometric CoM) | 0.990 m |
| tip-over lean | `atan(a/h)` | 0.1007 rad = 5.77 deg |
| **bail threshold** | CoM lateral offset `x` leaves the support: `|x| > a`. `balance = x/a` | `|balance| > 1` |
| toppling rate `omega` | point mass at `h` about the edge: `xdd = (g/h)x` | 3.148 /s |
| plant | `xdd = omega^2 x + a_lat - A_ctl*steer - c*xd`, solved in CLOSED FORM each step (exact for any dt, never Euler) | — |
| **steering authority** `A_ctl` | max lean 58 deg against gravity: `g*tan(58)` | 15.70 m/s^2 = 1.60 g |
| curve load | `a_lat = v^2 * kappa` — quadratic in speed, so demand rises with v^2 | — |
| **critical radius** | `v^2 / (A_ctl - omega^2 a)` | 22.0 m at 18 m/s |
| `dragScale` | linear drag scales with contact area: `(railW x boardW)/(boardL x boardW)` | 0.129 |
| `lambdaRail` | `LAMBDA_LONG * dragScale` | 0.0288 /s |

Curvature is measured as **net tangent turn over a +-5 m arclength window** on a
Catmull-Rom resample of the control points. A local 3-point fit reads kappa = 0
inside the 10.35 m straight segments of the runner's R=20/720 deg polyline; the
integral form cannot be fooled by a coarse control polyline.

Descending rails: `aT = -g*sin(slope) - mu*g*cos(slope)`, integrated with the
same closed form; along-rail speed clamped to V_CAP and the written 3-velocity
re-clamped, so nothing leaves the rail above 33 m/s. Capture converts the FULL
3-D speed onto the 3-D tangent — measured tax on a descent: 0.000% at 0/10/25/40 deg.

## CHOICE (and what each costs)

| choice | value | cost |
|---|---|---|
| max lean | 58 deg | sets the critical radius alone: 45 deg (1 g) -> nothing tighter than R=37 m rideable at 18 m/s; 65 deg -> R=16 m |
| body damping `zeta_p` | 1.0 | raising it to 2 lets a proportional controller hold R=20, which GR-06 (d) forbids; lowering it makes every correction ring |
| contact migration | 0.004 m | sets passive bail (2.63 s). Log-sensitive: x2 moves it only 0.53 s. Larger values start to show a toe-side asymmetry |
| `mu_rail` | 0.05 | flat-rail speed loss; halving it makes a flat rail nearly lossless |
| capture radius | 1.0 m | mid of research 02 §1.5 [EST] 0.5–1.5 m; measured true radius 0.954 m (the rail sits 0.3 m above the rider) |
| `minLockSpeed` | 3 m/s | slower approaches slide past instead of locking |
| `CROUCH_STEER` | 0.45 | charging a pop cuts authority, so the critical radius goes 22 m -> 52 m: you cannot charge a big pop inside a tight bend |

**Omission, stated:** the lock-on absorbs the lateral approach velocity — entry
starts at `x = 0, xd = 0`. A crossways arrival is forgiven at entry and only
bites afterwards through curvature. Modelling it (angular momentum about the new
contact line gives `xd = v_perp`) threw the rider off the runner's 720 deg arcs in
0.02 s, because those arcs loop back past the approach line at 16 deg off-tangent.

## Ownership

Writes only `ps.vel`, `ps.constrained`, and `ps.pos` once — the documented
lock-on snap, bounded by the capture radius. Never heading, never trick state.
On `jumpRelease` the module returns BEFORE writing velocity: physics' takeoff
already ran this frame, and overwriting `ps.vel` there erases the vertical
impulse (measured: pop 5.00 m/s and 1.88 m of air after a 1.2 s crouch; 2.10 m/s
uncharged).
