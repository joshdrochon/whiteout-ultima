# Reference: Turning, Edge Friction, Carve/Skid — SSX Tricky + Arcade Snowboard Math

Research doc for the reference bar. Every claim carries a source. Values marked **[EST]** are
best-estimate targets derived from footage/guide descriptions, not extracted game data — the
SSX (2000/Tricky) decompilation ([SSXModding/ssxog](https://github.com/SSXModding/ssxog)) is
still early-stage (support libs only, no gameplay physics code as of 2026-08, verified by clone
+ grep), and the [SSX Modding Wiki memory-address page](https://ssx.computernewb.com/wiki/PS2_Memory_Addresses)
documents only bone/camera addresses, no physics constants.

---

## 1. SSX Tricky ground rules (documented behavior)

### 1.1 Controls that matter for turning

From the official SSX Tricky Xbox manual (OCR text, [Internet Archive](https://archive.org/details/xboxmanual_Ssx_Tricky)):

- Stick/D-pad left/right = **turn**; down = **"Speed check"** (brake); up = **"Build speed"**.
- **Crouch/Jump**: "press and hold … to crouch, then release it to jump"; "The longer you
  stay in the crouch position the higher you fly."
- PRO controller configuration: **"you cannot turn while crouching"** (crouch trades steering
  for jump charge).
- HUD shows **"Current Speed"** — the game displays a live speed readout during runs.
- Rider stats are **Edging, Speed, Stability, Tricks**; medals award experience points
  distributed among them. Board classes: Freestyle (tricks), Alpine (speed), BX (mix).

From brian_sulpher's GameFAQs guide ([GameFAQs 22225](https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/faqs/22225), via search excerpt):

- "you go faster while crouching to jump than standing, though it **does detract from your
  turning ability**" — i.e. the pre-jump crouch is simultaneously a speed tuck and a steering
  nerf. This is the "hard-carve/pre-jump crouch" tradeoff to reproduce.
- Holding a direction while crouched **prewinds** the jump (spin/flip that way on release).
  gondee's guide uses "prewind" 13+ times as core technique ([GameFAQs 14936 via Wayback](https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936)).

### 1.2 Edging stat = turn tightness

- GameFAQs Q&A: "**Edging helps when you go around a corner so you don't make too wide a
  turn**" ([GameFAQs answers 209382](https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/answers/209382-what-exactly-do-the-edging-and-stability-stats-help-with)).
- Corkscrew's FAQ: "**Edging will help on such courses as Alaska and Mesablanca, which have a
  great deal of sharp turns**"; Speed + Tricks matter most early, Edging/Stability can lag
  ([GameFAQs 14943 via Wayback](https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14943)).
- 6 stat points per gold medal, 4 stats (Edging, Speed, Stability, Tricks); stats run 1–7 per
  category in-game **[EST on the 1–7 scale]** (same sources).
- Implementation implication: max yaw rate / grip coefficient should scale with an "edging"
  parameter.

### 1.3 Turning bleeds speed; braking

- Corkscrew's race walkthroughs treat hard turns as speed loss events: "The turn … is very
  sharp, so you've got to **brake a bit** and take it easy", "followed by a **hard brake** to
  keep from riding up the wall" ([GameFAQs 14943 via Wayback](https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14943)).
- SSX (series) wiki: "If the player presses the brakes and turn buttons, [the rider] will
  perform a tight turn" — brake+turn = tightest turn, standard arcade pattern
  (cf. [StrategyWiki SSX/Controls](https://strategywiki.org/wiki/SSX/Controls); same pattern
  in Tux Racer, §3).
- Grokipedia SSX Tricky summary: "sharp turns or collisions can disrupt flow and trigger
  slowdowns"; tucking increases speed ([Grokipedia](https://grokipedia.com/page/SSX_Tricky)).
- SSX 3 term (same engine family): "**Trip Turn** — the act of doing a sharp turn away from
  the character's facing direction that results in an **instant trip wipeout**"
  ([speedrun.com SSX 3 Terminology](https://www.speedrun.com/ssx3/guides/k4cyq)) — i.e. there
  is a max safe steering-reversal rate; exceeding it at speed = crash, not just speed loss.

### 1.4 Surfaces: powder vs ice/groomed

- gondee's guide, Merqury City: "**You should be going too fast for the powder to slow you
  down**, so feel free to cut dogleg corners by going off the path" — powder applies extra
  drag that matters at low speed and is worth eating at high speed
  ([GameFAQs 14936 via Wayback](https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936)).
- Same guide repeatedly describes off-track "deep/thick powder" shortcut segments that are
  slower per-meter but shorter (Snowdream, Elysium, Alaska sections).
- Wolf_Feather's FAQ on Alaska: hardest venue "partly due to the **fast, mostly-ice
  surfaces**" plus ice tunnels with the tightest turns
  ([GameFAQs 14817 via Wayback](https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14817))
  — ice = faster and harder to turn on.
- Tux Racer encodes the identical design numerically (§3): ice friction 0.2 / snow 0.35 /
  dirty snow 0.4, and steering torque comes *from* friction, so low-friction ice both speeds
  you up and turns worse. Use those ratios as the target.

### 1.5 Rail/grind lock-on

- StrategyWiki (SSX, same engine/design as Tricky): "**To grind, just land on a rail**, turn
  sideways to balance easier … or keep on pressing that to do rail spins", and "**You go
  faster boosting on a rail than boosting on the snow**"
  ([StrategyWiki SSX/Controls](https://strategywiki.org/wiki/SSX/Controls)).
  So: lock-on is automatic on contact (no press-to-grind), there is a light balance element
  handled by stance, and rails have *lower* effective drag than snow.
- Curved rails require steering input while grinding; failing to turn on a curved rail drops
  you off: "I kept grinding but didn't turn. You eventually **will fall off for not turning**"
  ([gondee guide, Aloha Ice Jam glitch report, via Wayback](https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936)).
- Standard implementation (Unity spline-grind tutorials/demos): on contact, find **closest
  point on rail spline**, snap the character there, convert speed to along-spline speed,
  advance by parameter; jump exits with speed carried over
  ([Unity discussions](https://discussions.unity.com/t/spline-based-rail-grinding/197647),
  [SGTADMAN/RailGrind demo](https://github.com/SGTADMAN/RailGrind)).
  **[EST]** capture radius ~0.5–1.0 board-length (≈0.5–1.5 m) around the rail line, tested
  only while airborne-descending or on landing frame.

### 1.6 Speed targets **[EST]**

SSX Tricky shows a HUD speed but no dump of its values was found. Best-estimate targets from
footage + manual ("Blast down the tracks at all-out speeds"):

- Base cruise, no tuck, groomed snow: **~50–65 km/h** (14–18 m/s) **[EST]**
- Tuck/crouch cruise: **~65–80 km/h** (18–22 m/s) **[EST]**
- Boost (red adrenaline): **~85–110 km/h** (24–31 m/s) **[EST]**
- Powder unboosted: **~35–50 km/h** (10–14 m/s) **[EST]**
- Boost tiers exist and are ordered: "**Red boost is the fastest, orange is medium and yellow
  is the slowest**"; speed pickup = red boost ~5 s
  ([StrategyWiki SSX/Controls](https://strategywiki.org/wiki/SSX/Controls)).

---

## 2. Real-world carving math (for the carve model)

- Carve radius from sidecut: **R_turn ≈ R_sidecut · cos(φ)** where φ = edge/tilt angle
  ([Wikipedia: Carved turn](https://en.wikipedia.org/wiki/Carved_turn),
  [real-world-physics-problems.com](https://www.real-world-physics-problems.com/physics-of-snowboarding.html)).
  Flat board: R_turn = R_sidecut. More edge angle → tighter turn.
- Typical sidecut radius: modern skis 7–15 m; snowboards similar order (≈7–9 m freestyle)
  ([Wikipedia: Carved turn](https://en.wikipedia.org/wiki/Carved_turn)). **[EST]** for an
  arcade board use effective R_sidecut ≈ 6–10 m before arcade scaling.
- "A (perfect) **carved turn does not lose any speed** because there is no braking action";
  skidding turns "primarily use the skidding effect to **reduce speed**" — the plowing action
  generates resistance "significantly more" than gliding
  ([Wikipedia: Carved turn](https://en.wikipedia.org/wiki/Carved_turn),
  [real-world-physics-problems.com](https://www.real-world-physics-problems.com/physics-of-snowboarding.html)).
- No-slip (hold the carve) condition: applied-force angle δ ≥ 90° − φ
  ([real-world-physics-problems.com](https://www.real-world-physics-problems.com/physics-of-snowboarding.html)).
- Ski–snow sliding friction is small; the physics-of-skiing literature treats μ ≈ 0.03–0.1
  for gliding ([arXiv physics/0310086](https://arxiv.org/pdf/physics/0310086)). Arcade games
  use far larger values (see Tux Racer ice 0.2 / snow 0.35) because they fold plowing/skid
  losses into one coefficient.

---

## 3. Tux Racer / Extreme Tux Racer — full open-source arcade turning model (exact values)

Source: `src/physics.h`, `src/physics.cpp`, `data/terrains/terrains.lst` of
[lutris/extremetuxracer](https://github.com/lutris/extremetuxracer) (GPL, constants unchanged
from Jasmin Patry's original 2000 Tux Racer). Verified by cloning 2026-08-24.

### 3.1 Terrain table (`terrains.lst`)

| Terrain | friction μ | depth (m) |
|---|---|---|
| ice (all variants) | **0.20** | 0.03 |
| snow | **0.35** | 0.11 |
| strike_snow | 0.30 | 0.04 |
| dirty_snow | 0.40 | 0.07 |
| thin_snow | 0.40 | 0.05 |
| rock | **0.70** | 0.01 |
| default | 0.50 | — |

Ratio to copy: **ice grip ≈ 0.57× snow grip**; soft/deep surfaces get *higher* μ + deeper
compression (depth also feeds a spring/compression force → powder feel).

### 3.2 Steering = rotated friction force (`CalcFrictionForce`)

```c
fric_f_mag = min(|N| * frict_coeff, MAX_FRICT_FORCE);        // MAX_FRICT_FORCE = 800 N
steer_angle = turn_fact * MAX_TURN_ANGLE;                     // MAX_TURN_ANGLE = 45 deg, turn_fact ∈ [-1,1]
// cap the sideways component of friction:
if (|fric_f_mag * sin(steer_angle)| > MAX_TURN_PERP)          // MAX_TURN_PERP = 400 N
    steer_angle = asin(MAX_TURN_PERP / fric_f_mag) * sign(turn_fact);
frictforce = rotate(frictforce, surf_normal, steer_angle);
return (1.0 + MAX_TURN_PEN) * frictforce;                     // MAX_TURN_PEN = 0.15
```

Key properties a critic can test:
- Turning is friction-mediated: **no friction (airborne, or speed < MIN_FRICT_SPEED = 2.8 m/s)
  → no steering**.
- The lateral (turning) force is **capped at 400 N** regardless of grip → lateral acceleration
  cap → **turn radius grows with speed** (R = v²/a_lat).
- Steering multiplies total friction by **1.15** → **turning bleeds speed by construction**
  (15% extra drag at full lock).
- Mass **TUX_MASS = 20 kg**, gravity **9.81**, brake force **200 N** (`BRAKE_FORCE`), so with
  μ=0.35 on flat: a_lat_max = 400/20 = **20 m/s²**; at 20 m/s that is R = v²/a ≈ 20 m.

### 3.3 Body roll (visual lean) (`CalcRollNormal`)

```c
roll_angle = MAX_ROLL_ANGLE = 30 deg;            // 55 deg while braking (BRAKING_ROLL_ANGLE)
angle = turn_fact * roll_angle
      * clamp01(frict_coeff / IDEAL_ROLL_FRIC)   // IDEAL_ROLL_FRIC = 0.35 → less lean on ice
      * clamp01((speed - min_speed) / (IDEAL_ROLL_SPEED - min_speed));  // IDEAL_ROLL_SPEED = 6 m/s
```

Lean-in scales with turn input, surface grip, and speed; full lean by 6 m/s. Brake+turn shows
a deeper 55° lean = the "hard carve" pose.

### 3.4 Other exact constants worth copying

`physics.h`: MIN_TUX_SPEED 1.4 m/s, INIT_TUX_SPEED 3.0 m/s, MAX_PADDLING_SPEED 60/3.6 =
16.7 m/s, MAX_PADD_FORCE 122.5 N, PADDLING_DURATION 0.40 s, BRAKE_FORCE 200 N, wind drag via
Reynolds-number table (`airdrag[]` in physics.cpp), ODE step clamped 0.01–0.10 s.

---

## 4. Anisotropic-friction steering (the standard arcade formula)

The canonical arcade drift/carve controller (car or board), from the Yarsa Labs Unity
tutorial ([blog.yarsalabs.com](https://blog.yarsalabs.com/basic-2d-arcade-car-controller-in-unity/)):

```csharp
// split velocity into board-frame components each physics tick:
Vector2 vFwd = forward * Dot(v, forward);
Vector2 vLat = right   * Dot(v, right);
v = vFwd + vLat * driftFactor;        // driftFactor = 0.95, recommended 0.90–0.95
// steering: yaw applied directly
rotationAngle -= steeringInput * turnFactor;   // turnFactor = 2 deg per tick
```

- At Unity's 50 Hz physics tick, `vLat *= 0.95` per tick ⇒ continuous form
  **v_lat *= exp(−grip·dt)** with **grip = −ln(0.95)/0.02 ≈ 2.6 s⁻¹** (half-life of sideways
  velocity ≈ 0.27 s). driftFactor 0.90 ⇒ grip ≈ 5.3 s⁻¹.
- Equivalent first-order form used everywhere: `v_lateral *= (1 - grip*dt)` for small
  grip·dt. **Carve = high grip (5–10 s⁻¹ [EST]); powder-skid/drift = low grip
  (1–3 s⁻¹ [EST]); ice between but with lower yaw authority.**
- Forward speed is preserved by construction — killing v_lat converts a skid into a carve
  without an explicit turning force. Energy removed = ½m·(1−k²)·v_lat² per tick = the "skid
  bleeds speed" knob if you *don't* re-add it to forward.

### 4.1 Yaw rate limited by speed (composite steering law)

Combine the two open-source patterns into the testable steering law:

```
omega_cmd   = steerInput * omega_max(v)
omega_max(v)= min(OMEGA_BASE, A_LAT_MAX / max(v, v_min))     // rad/s
```

- Low speed: yaw-rate cap dominates (OMEGA_BASE ≈ 2.0–3.5 rad/s ≈ 115–200°/s **[EST]** for
  SSX-feel snappiness).
- High speed: lateral-accel cap dominates (Tux Racer's exact A_LAT_MAX = 20 m/s²;
  arcade-plausible range 10–25 m/s²), giving R = v²/a_lat, i.e. **turn radius grows
  quadratically with speed once past the crossover** (crossover at v = A_LAT_MAX/OMEGA_BASE
  ≈ 6–10 m/s).
- Crouch (pre-jump) multiplies omega_max by **~0.3–0.5 [EST]** (manual: crouch "detracts from
  turning ability"; PRO config: no turning at all → multiplier 0).
- Brake+turn multiplies omega_max by **~1.5–2.0 [EST]** and adds brake decel (Tux Racer:
  200 N/20 kg = 10 m/s²) — "brake and turn = tight turn" behavior.
- Edging stat maps linearly onto grip and omega_max (e.g. ±20% across the stat range **[EST]**).

---

## 5. Suggested composite model for the rebuild (derived, all-estimate tuning)

Per ground tick, in board local frame (forward f, lateral r, from yaw):

```
// 1. steering
omega = steer * min(OMEGA_BASE * edgeStat * crouchMul * brakeMul, A_LAT_MAX / v)
yaw  += omega * dt

// 2. anisotropic friction (surface-dependent)
vLat *= exp(-grip[surface] * edgeStat * dt)      // grip: snow 6, ice 3.5, powder 2  [EST, s^-1]
vFwd -= (mu[surface] * g * cos(slope) + turnDrag*|steer|) * dt
                                                  // mu ratios from Tux Racer: ice 0.2, snow 0.35, powder ~0.45
                                                  // turnDrag = 15% of friction at full lock (Tux Racer 1.15x)
// 3. powder extra: quadratic plow term  F = k_powder * v * depth  — negligible at high v
//    relative to momentum, matching "too fast for the powder to slow you down"
```

Rail grind: on landing within capture radius of rail spline → project to closest spline
point, v := |v| along tangent, drag ≈ 0 (rail faster than snow), steer input required to
follow curvature past a threshold or detach; jump exits with v preserved + prewind spin.

---

## Testable assertions

1. Turn radius is speed-dependent: at ≤5 m/s a full-lock turn completes 90° of heading change
   in ≤1 s; at 25 m/s the same input yields a radius ≥4× the low-speed radius (lateral-accel
   cap, Tux Racer A_LAT_MAX pattern).
2. Lateral acceleration during a full-lock carve on snow never exceeds a fixed cap
   (reference value 20 m/s², Tux Racer 400 N / 20 kg); assert |a_lat| ≤ cap ± 10%.
3. Anisotropic friction: with the board at 30° slip angle, lateral velocity decays
   exponentially with half-life 0.1–0.3 s on groomed snow, while forward velocity in the same
   interval loses <10% (excluding gravity/drag).
4. `v_lateral *= (1 - grip*dt)` (or exp form) is applied only when grounded: airborne frames
   show zero heading-coupled velocity change (Tux Racer: no friction ⇒ no steering in air).
5. Full-lock steering adds measurable drag: straight-running deceleration vs full-turn
   deceleration on the same slope differ by ~10–20% (Tux Racer: exactly +15%).
6. Ice vs snow: effective grip/friction on ice ≈ 0.5–0.6× snow (Tux Racer 0.20 vs 0.35);
   terminal speed on ice > terminal speed on snow; time to rotate heading 90° at 20 m/s is
   longer on ice.
7. Powder: adds a drag term that scales with compression depth; at low speed (<12 m/s [EST])
   powder decelerates the rider noticeably (>2 m/s² extra), but at high speed (>22 m/s [EST])
   the per-second speed loss is a small fraction of current speed ("too fast for the powder
   to slow you down").
8. Crouch (jump preload): forward speed increases (tuck) and max yaw rate drops to ≤50% of
   normal (to 0% in "pro" fidelity mode); releasing crouch jumps, with jump strength
   monotonic in hold time.
9. Prewind: holding a direction during crouch causes spin in that direction on jump release;
   no direction held ⇒ no spin.
10. Brake+turn produces the minimum turn radius in the game (smaller than turn alone), and
    braking shows a deeper lean/roll animation (30° normal vs ~55° braking lean, Tux Racer).
11. Body roll in a carve scales with turn input × speed (saturating around 6 m/s) × surface
    grip; on ice the lean angle at identical input/speed is visibly smaller (≤0.6×).
12. Rail lock-on: landing within the capture radius of a rail auto-snaps the rider to the
    closest point on the rail spline (no button required); speed magnitude is preserved onto
    the tangent; deceleration while grinding < deceleration while riding snow at the same
    speed ("faster boosting on a rail than on the snow").
13. Curved rails require steering input to follow; without input past a curvature threshold
    the rider detaches ("fall off for not turning").
14. Jumping off a rail preserves speed and allows prewind spins.
15. Reversing steer hard at high speed (steer against current heading > threshold rate)
    triggers a trip/wipeout state rather than an instant tight turn (SSX 3 "Trip Turn").
16. Edging stat scales turn tightness: max stat vs min stat changes steady-state turn radius
    by a measurable factor (target ~±20% [EST]); it does not change straight-line top speed.
17. Carve vs skid energy: a pure-carve S-turn sequence (low slip angle) loses <5% speed per
    turn; a skidded turn (high slip angle held) loses >15% per turn (carved turns lose ~no
    speed; skid plow bleeds it).
18. Carve radius tightens with lean: R ∝ cos(edge angle) for the carve component
    (R = R_sidecut·cos φ), so more lean ⇒ monotonically tighter carve until the slip
    threshold.

## Source list

- SSX Tricky Xbox manual OCR — https://archive.org/details/xboxmanual_Ssx_Tricky
- StrategyWiki SSX/Controls — https://strategywiki.org/wiki/SSX/Controls
- gondee, SSX Tricky Strategy Guide (shortcuts/showoff) — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936
- Corkscrew, SSX Tricky FAQ/Walkthrough — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14943
- Wolf_Feather, SSX Tricky FAQ — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14817
- brian_sulpher, SSX Tricky Guide — https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/faqs/22225
- GameFAQs Q&A, edging/stability stats — https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/answers/209382-what-exactly-do-the-edging-and-stability-stats-help-with
- speedrun.com SSX 3 Terminology (Rithek) — https://www.speedrun.com/ssx3/guides/k4cyq
- Extreme Tux Racer source — https://github.com/lutris/extremetuxracer (src/physics.h, src/physics.cpp, data/terrains/terrains.lst)
- Yarsa Labs arcade car controller (anisotropic damping) — https://blog.yarsalabs.com/basic-2d-arcade-car-controller-in-unity/
- Unity spline rail-grinding discussions — https://discussions.unity.com/t/spline-based-rail-grinding/197647 ; https://github.com/SGTADMAN/RailGrind
- Wikipedia, Carved turn — https://en.wikipedia.org/wiki/Carved_turn
- Physics of snowboarding — https://www.real-world-physics-problems.com/physics-of-snowboarding.html
- Physics of skiing (arXiv) — https://arxiv.org/pdf/physics/0310086
- Grokipedia SSX Tricky — https://grokipedia.com/page/SSX_Tricky
- SSX Modding Wiki — https://ssx.computernewb.com/wiki/Main_Page ; PS2 memory addresses page
- SSXModding/ssxog decompilation — https://github.com/SSXModding/ssxog
