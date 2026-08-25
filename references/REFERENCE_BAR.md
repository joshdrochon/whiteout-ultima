# REFERENCE BAR — SSX Tricky-style Rebuild (Canonical)

Synthesized 2026-08-24 from `references/research/01–05` plus three adversarial
verifier passes (pure-math refutation; source-verification against Tux Racer /
snowflow / patch bytes / archived guides; independent re-derivation + speedrun
pacing). **Where a verifier contradicted the corpus, the verifier wins.** All
disputes between verifiers were resolved by dimensional coherence first,
provenance second; unresolved items are listed in *Open Disputes*.

**Scoring rule: NO 1-to-10 scores anywhere. Every gate is pass/fail
(HARD), in-band/out-of-band (TOLERANCE), or a presentation check (STYLE).**

- **HARD** — sourced or structurally required. Fail = reject.
- **TOLERANCE** — tuning band. Out-of-band = flag, in-band = pass.
- **STYLE** — presentation/feel check, judged present/absent.

Machine-readable twin: `references/PHYSICS_GATES.json`.

---

## 1. Declared Conventions

| Convention | Value |
|---|---|
| World unit | **1 u = 1 m** |
| Rider height | **1.8 m** (scale anchor) |
| Reference mass | **80 kg** (forces quoted as accelerations; mass cancels) |
| Physics step | **fixed 60 Hz** (dt = 1/60 s), explicit Euler, tick-rate-independent damping via `1 − exp(−λ·dt)` |
| Ground gravity | **9.81 m/s²**, slope-projected (`g·sin θ`) |
| Air gravity | **separate constant `g_air`** (reduced, aesthetic hang — airborne only) |
| Speeds | m/s internally; km/h in prose = m/s × 3.6 |

Resolved design decisions (were buried in the corpus, surfaced by verifiers):

1. **Low-g applies AIRBORNE ONLY.** Ground uses real 9.81 with λ_long
   0.20–0.30 s⁻¹; this is the only pairing that hits the cruise band. (Verifier
   1 showed λ_long 0.10 + 9.81 predicts 133–162 km/h unboosted — absurd.)
2. **Jump impulse is a WORLD-UP vertical add**, blending toward surface normal
   only when `n·up < 0.7` (walls/quarterpipes). Ramp-normal pop subtracts
   ~5–10% horizontal speed on a 30° lip, contradicting the sourced "never
   subtracts horizontal speed" behavior; the only source-verified arcade
   reference (Tux Racer `CalcJumpForce`) is also world-vertical.
3. **Flat-coast log-linearity test is DELETED.** The model keeps a Coulomb
   term (`μ·g·cos θ`), which breaks log-linearity at low speed; corpus doc 01
   asserted both, which is mutually exclusive. Gate is coast *time*, not
   curve shape.

---

## 2. Physics Model Spec (canonical update equations)

State: position `p`, velocity `v`, board yaw `ψ`. Animation state never feeds
the integrator. All per-tick, dt = 1/60.

### Ground tick

```
θ  = slope angle from surface normal n
d  = normalize(g_vec − (g_vec·n)n)                     // downhill direction

// 1. Steering (yaw-rate cap at low speed, lateral-accel cap at high speed)
ω  = steer · min(Ω0 · k_edge · k_tuck · k_crouch · k_brake,  A_LAT / max(|v|, 5))
ψ += ω · dt

// 2. Slope accel + Coulomb friction
v += 9.81 · sin(θ) · d · dt
v -= μ[surface] · 9.81 · cos(θ) · v̂ · dt               // μ base 0.03–0.05

// 3. Anisotropic exponential damping in board frame (f = forward, r = lateral)
v_f *= exp(−λ_long · k_tuckDrag · k_turnDrag(steer) · dt)
v_r *= exp(−λ_lat  · k_edge · dt)

// 4. Boost (first-order approach while held and v_f < v_boost)
v_f += (v_boost − v_f) · (1 − exp(−dt / τ_boost))

// 5. Hard clamp
|v| = min(|v|, V_CAP)

p += v · dt;  snap p to heightfield
```

### Air tick

```
v.y −= g_air · dt
p   += v · dt
// rotation (spin/flip) is pure animation state: spin += rate·dt.
// ZERO trajectory coupling; horizontal velocity untouched (< 1% drift).
```

### Jump (on crouch release)

```
J   = lerp(J_min, J_max, min(t_hold / T_charge, 1))
dir = up                    if n·up ≥ 0.7
      normalize(up + n)     otherwise
v  += J · dir               // horizontal-speed change at takeoff < 1% on ramps
```

### Canonical constants (defend value; tolerance bands are the gates below)

| Constant | Defend | Band |
|---|---|---|
| g_air | **6.5 m/s²** | 6.0–7.5 (0.61–0.76 g) |
| λ_long | **0.25 s⁻¹** | 0.20–0.30 |
| λ_lat | **4 s⁻¹** | 3–6 (pairing rule λ_lat ≥ 10·λ_long) |
| μ base (groomed) | **0.04** | 0.03–0.05; ice 0.5–0.6×, powder ~1.3× + depth plow |
| Ω0 (base yaw rate) | **180 °/s** | 160–200 |
| A_LAT (lateral accel cap) | **30 m/s²** | 25–35 |
| Tuck | λ_long × **0.7**, steering × **0.6** | drag ×0.65–0.75; steer ×0.5–0.7 |
| Crouch steering | × **0.4** | 0.3–0.5 (0 in "pro" mode) |
| v_boost | **31 m/s** | 29–33 |
| V_CAP | **33 m/s (119 km/h)** | 30.5–34.7 |
| τ_boost (spin-up) | **1.0 s** | 0.8–1.2; post-release decay τ 1.2–1.8 s |
| T_charge | **0.85 s** | 0.7–1.0 |
| J_min / J_max | **2.2 / 5.0 m/s** | 2–2.5 / 4.5–5.5 |
| Full-lock turn drag | **+15%** | +10–20% |
| Brake decel | **4.5 m/s²** | 3–6 (surface-scaled) |
| Spin prewound / stick-only / flip / auto-level | **600 / 300 / 330 / 220 °/s** | 540–620 / 250–350 / 300–360 / 180–270 |

Speed ladder (unified; corpus docs 01/02 contradicted each other):
**cruise 58–75 km/h · tuck +20–27 · boost 105–125 · hard cap ~119 km/h.**
Anchored on Garibaldi/Alaska WR pacing (boost-heavy WR *averages* 89 km/h —
a 150 km/h cap is incoherent with that; 150 was an SSX-2012 rail figure).

Discarded numeric anchors (per all three verifiers):
- **Gravity = 1/60 per tick** — scale-free without SSX's internal unit, and
  from SSX (2000), not Tricky. Kept only structurally: single scalar, explicit
  Euler, stable at ×1/16.
- **Tux Racer absolute forces/μ** — tuned for a 20 kg penguin; μ = 0.35 in
  this model yields 17 km/h cruise (refuted by computation). Only ratios
  transfer: ice ≈ 0.57× snow grip, +15% turn drag, lateral-cap steering shape.
- **Tuck "~25km" quote** — verified to be an SSX (2012) statement (gondee's
  Tricky guide contains neither "tuck" nor "25km"). Band kept as EST proxy.

---

## 3. Gate Tables

Test methods reference scenarios runnable by the deterministic node harness
(exact params in `PHYSICS_GATES.json`).

### 3.1 Lane: physics-core

| ID | Statement | Target | Tag | Test method | Provenance |
|---|---|---|---|---|---|
| PC-01 | Fixed 60 Hz physics step; sim results independent of render rate | race time delta < 1% at halved render rate | **HARD** | `tick_independence`: run 10 s slope descent at 60 Hz vs 30 Hz render / fixed sim; compare finish time | 60 Hz NTSC PS2 (patch wiki); damping-form math |
| PC-02 | All damping uses `exp(−λ·dt)` form | one 100 ms step ≡ ten 10 ms steps within 1e−6 | **HARD** | `tick_independence` sub-check on velocity decay | Driscoll frame-rate-independent damping; verifier 3 confirmed |
| PC-03 | Ground accel = `9.81·sin θ` minus friction/drag | doubling sin θ (15°→31°) at equal speed ≥ ~2× net accel | **HARD** | `slope_accel_pair`: measure a at 15° and 31°, same v | Textbook slope projection; all verifiers |
| PC-04 | Steady-state cruise on 28° slope, no tuck/boost | 14–21 m/s, entry-independent ±2% | TOLERANCE | `slope_coast` 28°, 20 s, entry from 5 and from 30 m/s | λ_long 0.20–0.30 + real g (verifiers 1,3); WR pacing |
| PC-05 | Flat coast from cruise (17 m/s) to <10% | 5.5–10 s, no stop discontinuity | TOLERANCE | `flat_coast` entry 17 m/s, measure t to 1.7 m/s | Re-derived with Coulomb + λ (verifier 1 correction; log-linear test deleted) |
| PC-06 | A hard velocity clamp exists; nothing exceeds it | \|v\| ≤ V_CAP always (boost + 45° slope) | **HARD** | `speed_cap` 45° slope, boost held 30 s | No-Speed-Cap patches for SSX AND Tricky (patch bytes verified) |
| PC-07 | V_CAP magnitude | 30.5–34.7 m/s | TOLERANCE | `speed_cap` measure clamped speed | WR pacing coherence (verifier 3); 150 km/h rejected as 2012 proxy |
| PC-08 | Tuck raises steady-state speed and cuts steering | Δv +5.5 to +7.5 m/s; steering ×0.5–0.7; both revert on release | TOLERANCE | `slope_coast` 28° tucked vs not; `turn_radius` tucked | "~25km" quote (2012 proxy, EST); tuck = λ×0.7 model (verifier 3) |
| PC-09 | Airborne horizontal velocity conserved | < 1% drift over any arc, spins irrelevant | **HARD** | `air_ballistic`: launch 20 m/s, 3 s arc, with and without spin input | Point-mass model; Tux (no friction airborne); all verifiers |
| PC-10 | Rider is point mass on heightfield; animation never feeds integrator | state = p, v, ψ only | **HARD** | code inspection + `air_ballistic` spin invariance | Engine-lineage evidence; verifier 3 re-derivation |
| PC-11 | Sim stable under gravity ×1/16 | playable, no NaN/explosion, moon-float behavior | **HARD** | `moon_gravity`: g_air/16, 60 s auto-run | Moon Gravity patch behavior (structural claim only — 1/60 numeric discarded) |
| PC-12 | Speed stat scaling | +10 stat ≈ +1.5–2% course speed, monotonic | TOLERANCE | `slope_coast` at stat 10 vs 20, compare v_ss | SSX-2012 "+10 ≈ 1 s/min" (proxy, EST); arithmetic verified |
| PC-13 | Boost dynamics | reaches v_boost in 1.5–3 s; release decay τ 1.2–1.8 s; 33%-duty tap holds ≥ 90% of boost top speed | TOLERANCE | `boost_cycle`: hold 5 s, release, then 1 Hz tap 10 s | Tap-boost "3× longer near top speed" quote; verifier 1 & 3 math |

### 3.2 Lane: turning / edge-friction

| ID | Statement | Target | Tag | Test method | Provenance |
|---|---|---|---|---|---|
| TN-01 | Lateral slip decays exponentially on groomed snow | half-life 0.10–0.25 s (λ_lat 3–6 s⁻¹) | TOLERANCE | `slip_decay`: 30° slip at 15 m/s, fit half-life | driftFactor 0.90–0.95 conversion (verified to 2 dp); hockey-stop feel |
| TN-02 | Anisotropy ratio | λ_lat / λ_long ≥ 10 | **HARD** | `slip_decay` + `flat_coast`, compare fitted λ | Verifier 1 correction (corpus "≥15×" contradicted its own bands) |
| TN-03 | Turn radius at 10 m/s full lock | R = 2.8–4.2 m | TOLERANCE | `turn_radius` v = 10, steer = 1 | ω_max = min(Ω0, A_LAT/v) law (verifier 3 steering fix) |
| TN-04 | Turn radius at 25 m/s full lock | R = 17–26 m (boost runs turn wide) | TOLERANCE | `turn_radius` v = 25, steer = 1 | A_LAT 25–35 m/s²; Tux 20 m/s² rejected as sluggish (64 °/s at cruise) |
| TN-05 | Low-speed snappiness | 90° heading change ≤ 1.0 s at 5 m/s full lock | TOLERANCE | `turn_radius` v = 5, time to 90° | Ω0 160–200 °/s; verifier 1 arithmetic confirmed |
| TN-06 | Full-lock steering adds drag | straight vs full-lock decel differ +10–20% | TOLERANCE | `full_lock_drag`: 28° slope, steer 0 vs 1, compare decel | Tux ×1.15 turn penalty (source-verified; ratio transfers) |
| TN-07 | No steering / lateral grip while airborne | zero heading-coupled velocity change in air | **HARD** | `air_ballistic` with full steer held | Tux: no friction ⇒ no steering airborne (source-verified) |
| TN-08 | Brake decel | 3–6 m/s² on groomed snow, surface-scaled | TOLERANCE | `brake`: entry 20 m/s flat, full brake | Tux `mu·BRAKE_FORCE` (corpus's 10 m/s² was wrong: source reads μ·200 N) |
| TN-09 | Brake+turn = tightest turn | R(brake+turn) < R(turn alone), always | **HARD** | `turn_radius` v = 15 with and without brake | Manual/StrategyWiki pattern; Tux braking-roll evidence |
| TN-10 | Ice vs snow | ice grip 0.5–0.6× snow; ice terminal speed > snow; 90° rotation slower on ice | TOLERANCE | `surface_compare`: same slope, ice vs snow | Tux terrains.lst 0.20/0.35 (source-verified; RATIO only transfers) |
| TN-11 | Powder | > 2 m/s² extra drag below 12 m/s; small fraction of v at > 22 m/s | TOLERANCE | `surface_compare` powder at 10 and 24 m/s | gondee "too fast for the powder to slow you down"; depth-plow model |
| TN-12 | Crouch steering nerf | steering ×0.3–0.5 while crouched (0 in pro mode) | TOLERANCE | `turn_radius` crouched vs not | Manual: "cannot turn while crouching" (PRO); guide text |
| TN-13 | Hockey stop | ≥ 70% of speed scrubbed within 0.5 s of instant 90° board rotation | TOLERANCE | `slip_decay` 90° slip at 15 m/s, speed at t = 0.5 | e^(−0.5λ) = 0.05–0.29 surviving for λ 2.5–6 (verifier 1 confirmed) |
| TN-14 | Lateral accel ceiling | \|a_lat\| never exceeds 25–35 m/s² band | TOLERANCE | `turn_radius` sweep v = 5..30, log a_lat | Demoted Tux 400 N/20 kg; re-set for SSX turn feel (verifiers 1+3) |

### 3.3 Lane: jump-arcs

| ID | Statement | Target | Tag | Test method | Provenance |
|---|---|---|---|---|---|
| JA-01 | Charge-and-release jump; height monotonic in hold time, clamps | T_charge 0.7–1.0 s; tap ≈ 40–50% of full J | TOLERANCE | `jump_flat` hold sweep 0.1–1.5 s, apex monotonic then flat | Manual + guides (mechanic HARD, numbers EST) |
| JA-02 | Tap pop on flat | airtime 0.5–0.85 s; apex 0.25–0.55 m | TOLERANCE | `jump_flat` charge = tap, entry 15 m/s | J_min 2–2.5 m/s under g_air 6.0–7.5 (derived, coherent set) |
| JA-03 | Full-charge pop on flat | airtime 1.3–1.6 s; apex 1.4–2.0 m | TOLERANCE | `jump_flat` charge = full, entry 15 m/s | Corpus's "1.0–1.2 s AND 1.5–2 m" was internally incoherent; re-derived at g_air 6.5 |
| JA-04 | Jump adds world-up velocity; horizontal preserved | horizontal-speed change at takeoff < 1% (n·up ≥ 0.7) | **HARD** | `jump_kicker` 30°, compare horizontal v across lip | Tux CalcJumpForce world-vertical (source-verified); resolves docs 01/03 contradiction |
| JA-05 | Air gravity | g_air 6.0–7.5 m/s² (0.61–0.76 × 9.81) | TOLERANCE | `air_ballistic` fit g from arc | Re-derived (verifier 3); corpus 0.45–0.65 g rejected (moon-bouncy flat pops) |
| JA-06 | Full charge off 30° kicker at cruise 18 m/s | airtime 3.5–4.8 s to equal height; apex 12–18 m | TOLERANCE | `jump_kicker` 30°, 18 m/s, full charge | Ballistics at g_air band; monster-tier anchor (EST, never HARD) |
| JA-07 | Tap off 30° kicker at cruise 18 m/s | airtime 2.9–3.8 s to equal height | TOLERANCE | `jump_kicker` 30°, 18 m/s, tap | Same ballistics, J_min |
| JA-08 | Rotation caps | spin ≤ 1800°; flips ≤ 3 (1080°); beyond displays "???" | **HARD** | `spin_rate` command 2160° spin, assert cap/??? | LLCoolDave Spins & Flips Guide (Tricky-native, VERIFIED) |
| JA-09 | Max prewound spin rate | 540–620 °/s | TOLERANCE | `spin_rate` full prewind, high Trick stat | Three convergent feel derivations; NO primary measurement — never HARD |
| JA-10 | Stick-only spin rate | 250–350 °/s | TOLERANCE | `spin_rate` no prewind | ~half prewound (EST) |
| JA-11 | Flip rate | 300–360 °/s max; independent axis from spin | TOLERANCE | `spin_rate` flip command; simultaneous spin+flip | 1080 in ~3.2 s air (EST); axes verified independent (Ligament 900) |
| JA-12 | Auto-level on input release | engages ≤ 0.2 s; levels at 180–270 °/s | TOLERANCE | `spin_rate` release mid-spin, measure leveling | Guide "release early, land clean" loop (EST rates) |
| JA-13 | Landing yaw window | clean within ±40–50° of straight/fakie; crash beyond 80–100° of incomplete commanded rotation; small under-rotations auto-snap | TOLERANCE | `landing_yaw` sweep residual yaw 0–180° | Uber Guide "botch small rotations" note (window EST) |
| JA-14 | Landing with grab held → crash, always | pass/fail | **HARD** | `landing_state` grab held at touchdown | Manual + Uber Trick Guide (VERIFIED) |
| JA-15 | Landing mid-uber-animation → crash, always | pass/fail | **HARD** | `landing_state` uber incomplete at touchdown | Uber Trick Guide (VERIFIED) |
| JA-16 | Uber base scores match table, min 13,210 max 22,580, stat-independent | exact table (research doc 03 §5) | **HARD** | `scoring` perform each uber, assert base value | Uber Trick Guide point table (Tricky-native, VERIFIED) |
| JA-17 | Repetition penalty | each repeat awards ×0.5 of previous award; direction/degree change resets | **HARD** | `scoring` same trick ×3, assert 1, 0.5, 0.25 | Wolf_Feather + manual (VERIFIED) |
| JA-18 | Star multipliers | yellow 2×, orange 3×, red 5×; highest single star only; credited only on clean landing | **HARD** | `scoring` multi-star jump, crash vs clean | Wolf_Feather; master-run arithmetic checks (20,960×2×3 ≈ 130K ✓) |
| JA-19 | TRICKY state | 6 individually landed ubers → infinite boost + permanent uber-ready for the run; two ubers in one jump = two letters; resets between events | **HARD** | `scoring` land 6 ubers, assert meter never drains | Uber Trick Guide (VERIFIED) |
| JA-20 | Landed knockdown/shove instantly fills meter | pass/fail | **HARD** | `scoring` shove event, meter = 100% | Uber Trick Guide + brian_sulpher (VERIFIED) |
| JA-21 | Meter economy | ~3 mid-tier flip tricks fill empty→full; drains over time / on falls; repeats fill less | TOLERANCE | `scoring` land 3 misty-class tricks from empty | Wolf_Feather fill anchor (VERIFIED anchor, EST amounts) |
| JA-22 | Rotation is animation-only | trajectory identical with/without spin; rotation stops ≤ 0.2 s after input release | **HARD** | `air_ballistic` + `spin_rate` | Point-mass model; all verifiers |

### 3.4 Lane: camera-feel

| ID | Statement | Target | Tag | Test method | Provenance |
|---|---|---|---|---|---|
| CF-01 | Camera smoothing is frame-rate independent | 1×100 ms ≡ 10×10 ms within 1e−6 | **HARD** | `camera_step` split-step comparison | Driscoll/Eiserloh form (FACT) |
| CF-02 | Position damping | λ_pos 6–10 s⁻¹ | TOLERANCE | `camera_step` fit decay after position step | SimonDev 6.9 / Eiserloh 6.3 anchors |
| CF-03 | Lazy yaw | yaw λ 2.5–5 s⁻¹ AND strictly < position λ; 63% of a 90° heading step closed in 0.2–0.4 s | TOLERANCE | `camera_step` heading step at constant speed | "Lazy chase" named mode (SSX 3 patch wiki) + footage (EST) |
| CF-04 | Rig yaw follows smoothed VELOCITY heading, not board yaw | 720° ground spin → < 15° camera yaw deviation | **HARD** | `camera_spin` feed spinning yaw, assert deviation | Hip-pivot/board-slide analysis; mode vocabulary |
| CF-05 | No orbit in air | 900° air spin → camera world yaw change < 10° takeoff→landing | **HARD** | `camera_spin` airborne | Footage-universal; makes spin counts readable |
| CF-06 | Air framing | follow distance +10–20% at apex; pitch relaxes toward horizontal, landing zone in frame | STYLE | `camera_air` apex distance/pitch check | Footage-derived (EST ±30%) |
| CF-07 | FOV kick | relative to base, monotonic in speed, cap ≤ +20% of base, eases in faster than out | TOLERANCE | `camera_fov` speed sweep + boost toggle | BeamNG +8% / Minecraft +20 bracketing (FACT-anchored bounds) |
| CF-08 | Trauma shake | shake = trauma² (0.3→3%, 0.6→22%); linear decay; clean-landing shake gone ≤ 0.5 s; rotational ≤ 5° at trauma 1 | TOLERANCE | `camera_shake` inject trauma, fit curve | Eiserloh GDC 2016 (FACT-form, EST magnitudes) |
| CF-09 | Boost FX ladder | higher tier strictly increases ≥ 2 speed cues (FOV target, particles); yellow<orange<red<Tricky; pickup = top tier ~5 s | STYLE | `camera_fov` + particle rate per tier | Boost color tiers (sourced qualitative) |
| CF-10 | Look-ahead | look-at ≈ rider root +1 m up, ≥ 4 m along velocity at speed; never at the board | STYLE | `camera_step` inspect look-at target | Hip framing + SimonDev ratio pattern (EST) |
| CF-11 | Crash recovery without pops | re-converge to chase pose, no frame-to-frame camera jump > 30 cm | **HARD** | `camera_crash` end crash state, max per-frame delta | Nesky guardrails; footage |

### 3.5 Lane: snow-visuals

| ID | Statement | Target | Tag | Test method | Provenance |
|---|---|---|---|---|---|
| SV-01 | Diffuse uses wrap lighting | `(NdotL + w)/(1 + w)` with w 0.3–0.6; NdotL = 0 face still lit | **HARD** | shader static check + rendered probe | GPU Gems ch.16; snowflow recipe (repo verified to exist) |
| SV-02 | Glints sparse, view-dependent, HDR | glinting fraction ~1–5% of lit pixels; intensity changes on camera-only move; exceeds 1.0 pre-tonemap or threshold-gated | TOLERANCE | rendered probe: two camera positions, pixel stats | Journey glitter (Zucconi/Edwards); snowflow grazing gate |
| SV-03 | Blue shadows | shadowed snow linear B > R by 20–60%; shadow luminance 35–55% of lit, never < 10% | TOLERANCE | rendered probe pixel stats | Skylight ~10,000 K physics (EST bands) |
| SV-04 | Trail state persists across frames | ping-pong RT (or GPGPU) read frame N+1, written frame N — never rebuilt per frame | **HARD** | code inspection + two-frame diff | Batman/RotTR pattern; Codrops; snowflow |
| SV-05 | Trail refill rate | multiplicative decay ≥ 0.999/frame at 60 fps for minutes-scale persistence (snowflow: ~71%/min ↔ 0.99990/frame), or a documented faster arcade choice | TOLERANCE | trail pixel decay over 3600 frames | snowflow README L81 (verified verbatim); conversion math checked |
| SV-06 | Stamp is capped | `max(existing, brush)` or additive-with-clamp; re-riding a spot never double-deepens past cap | **HARD** | stamp same UV twice, assert depth | Codrops/snowflow stamp pattern |
| SV-07 | Trail deforms geometry + relights | vertex displacement (silhouette changes); normals finite-differenced from trail texture | **HARD** | mesh probe: silhouette + normal delta in trench | All industry references agree |
| SV-08 | Trail window follows rider | toroidal/scrolling UV or re-centered ortho stamp; resolution 2–8 cm/texel | TOLERANCE | ride 200 m, trail still under rider | snowflow 80 m window / 3.9 cm/texel |
| SV-09 | Spray is GPU-simulated | ≥ 10k particles sustainable (positions/velocities in textures/compute, not JS objects) | TOLERANCE | perf probe at 10k | three.js `webgpu_compute_particles_snow` (100k reference) |
| SV-10 | Spray rate physics-gated | ≈ 0 flat-based; monotonic in edge angle × speed; hard carve at speed = order thousands/s; landing burst | **HARD** | `spray_rate` edge-angle sweep | Derived carve model (form HARD, magnitudes EST) |
| SV-11 | Spray structure | two populations: dense slow curtain + sparse fast ballistic grains (or wide speed variance) | STYLE | particle velocity histogram | snowflow two-layer wake (verified description) |
| SV-12 | Persistent visible board trail always present while carving | present/absent | STYLE | visual check any run | 2001 reviewer-headline feature — "a rebuild without a trail fails the style bar" |
| SV-13 | 60 fps render target | sustained 60 on reference hardware | **HARD** | perf capture, 1% lows | PS2 original mostly held 60 |
| SV-14 | SSX palette | saturated high-key; per-track colored gradient lighting allowed; shadows blue never black; big-trick celebratory FX (fireworks/glow) | STYLE | visual check | Reviews (darkzero, psx2central) — non-diegetic FX are canon |

---

## 4. Open Disputes (recorded, not silently resolved)

1. **g_air band.** Verifier 1 (pure math): 4.41–6.38 m/s² survives its kicker
   checks. Verifier 3: 6.0–7.5, because 4.5 makes a flat full pop hang 2.2 s
   (moon-bouncy). **Adopted 6.0–7.5 (defend 6.5)** on dimensional coherence —
   the flat-pop constraint binds harder than the big-air one. Revisit if big
   airs feel short after tuning.
2. **Hard-cap magnitude.** Verifier 1: 140–150 km/h; Verifier 3: ~119 km/h
   from WR pacing (boost-heavy WR averages 89 km/h). **Adopted 30.5–34.7 m/s**
   — pacing is a coherence argument, 150 is wrong-game provenance. Caveat:
   course lengths are flavor-grade (±30%), so this band is TOLERANCE, never HARD.
3. **Monster airtime ceiling.** Verifier 1 unified tiers to 4–5.5 s top;
   Verifier 3 re-derived 3–4.5 s at the adopted g_air. **Adopted 3–4.5 s**
   (coheres with adopted g_air); the 4.8 s upper edge of JA-06 acknowledges
   the overlap.
4. **A_LAT band.** Verifier 1: 20–30 m/s²; Verifier 3: 25–35. **Adopted
   25–35** (turn-feel argument at cruise); the shared 25–30 sub-band is the
   safest tuning start.
5. **Flat full-pop numbers.** Verifier 1: T 1.0–1.2 s / v_y 2.6–3.9 m/s;
   Verifier 3: T 1.3–1.6 s / J 4.5–5.5 m/s. Follows mechanically from dispute
   1; **adopted the verifier-3 set** for consistency with g_air 6.5.
6. **Speedrun-pacing evidence quality.** All speed-ladder bands lean on
   listed course lengths that include a physically absurd stat (2300 m drop
   over 3150 m). Every pacing-derived number is therefore TOLERANCE.

---

## 5. Trick/Boost Economy — hard-sourced summary (gates JA-16..JA-21)

| Fact | Value | Status |
|---|---|---|
| Uber base scores | 13,210 (Benihana/Blender) … 22,580 (Pommel Me / SuperMan BarSpin); full 49-entry table in research doc 03 §5 | HARD (Uber Trick Guide) |
| Repetition | ×0.5 of previous award per repeat | HARD |
| Multiplier stars | yellow 2× / orange 3× / red 5×, highest only, clean landing only | HARD |
| TRICKY | 6 individually landed ubers → infinite boost, permanent for run, reset between events | HARD |
| Knockdown | landed shove = instant full meter | HARD |
| Rotation caps | 1800° spin / 1080° flip; beyond = "???" | HARD |
| Meter fill anchor | ~3 mid-tier flip tricks empty→full | HARD anchor, EST amounts |
