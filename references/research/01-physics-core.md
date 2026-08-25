# 01 — SSX Tricky Core Movement Physics (Reference Bar)

Scope: gravity/air feel, slope acceleration, top speed, tuck, boost, speed retention, slope-angle response.
Purpose: give a blind critic quantified targets to judge a Three.js + JS-physics + GLSL rebuild against.

Confidence tags used throughout:
- **[HARD]** — directly sourced (guide text, patch bytes, published data).
- **[INFERRED]** — derived from hard evidence with stated reasoning.
- **[EST]** — best-estimate target from footage feel / sibling-game data; treat as tolerance band, not gospel.

---

## 1. Simulation model the original games use

- SSX (2000)/Tricky simulate the rider as a **single point mass / rigid body sliding over triangle-mesh (heightfield-like) terrain**, with all trick animation purely cosmetic; EA marketed a "plausible physics engine that emulated the sport" under arcade tuning. [HARD-ish, qualitative] — https://en.wikipedia.org/wiki/SSX_(2000_video_game)
- The games run at a fixed **60 Hz on NTSC PS2** (50 Hz PAL); an SSX On Tour "60 fps patch" exists precisely because later entries dropped to 30, while SSX/Tricky target 60. [HARD] — https://ssx.computernewb.com/wiki/PS2_Patches
- The active decompilation of SSX (2000), `SSXModding/ssxog`, has so far only reconstructed filesystem/audio libs — **no gameplay physics code is decompiled yet** (verified by cloning and grepping the repo 2026-08). Internal named constants are therefore not yet publicly recoverable from source. [HARD] — https://github.com/SSXModding/ssxog

### Gravity constant evidence from the patch/cheat community [INFERRED — best primary lead available]

The SSX Modding Wiki publishes PCSX2 patches by `modeco80`:

| Patch | Address | Word written | As IEEE-754 float |
|---|---|---|---|
| SSX (2000) NTSC-U "Moon Gravity" | `002c203c` | `3a888889` | **+0.00104167 = 1/960** |
| SSX (2000) NTSC-U "Crazy Negative Gravity" | `002c203c` | `bc888889` | **−0.0166667 = −1/60** |
| SSX Tricky NTSC-U "Moon Gravity" | `0012b7f0` | `3c01ff50` (a MIPS `lui $at,0xff50`) | patches the instruction materializing the gravity constant |

Source: https://ssx.computernewb.com/wiki/PS2_Patches

Reading of the SSX (2000) pair: both patches overwrite the **same float data word**, and both patched values share mantissa `0x888889` (= 1.0666667…). The natural original value is `0x3C888889` = **+1/60 ≈ 0.0166667**: "crazy negative" is its exact sign-flip, "moon" is the same float with the exponent dropped 4 (÷16). [INFERRED, medium-high confidence]

Consequences a rebuild can copy:
- Gravity in SSX-era code is a **single scalar float applied per 60 Hz tick** (per-frame velocity increment), not a 9.8 m/s² world constant — the constant is literally `1/60` in the game's internal velocity units. Absolute world-unit scale is unknown (the decomp hasn't reached it), so match **behavior ratios**, not the raw number. [INFERRED]
- "Moon gravity" at 1/16 of normal still produces a playable game — the sim is stable under large gravity scaling, implying simple explicit Euler integration of a constant. [INFERRED]

### Air-feel target (the "floaty" number) [EST]

No measured PS2 value exists publicly. From footage analysis of big kickers (Tokyo Megaplex / Untracked): riders routinely hold **2.5–4 s of airtime** from ramps whose visual lip height/exit speed would give ≈1.5–2 s under character-scaled 9.8 m/s². Target for the rebuild:

- **Effective air gravity ≈ 0.45–0.65 × realistic g** for the visual scale of the scene (i.e., if your character is 1.8 world-units tall, use g ≈ 4.5–6.5 u/s²), OR equivalently keep g realistic and scale jump impulses up — but the *low-g* route matches the slow apex hang SSX is famous for. [EST]
- Air control: yaw/rotation in air is animation-driven and does not alter the ballistic trajectory; horizontal air velocity is conserved (no meaningful air drag visible at gameplay speeds). [EST from footage; consistent with point-mass model]

---

## 2. Slope response: acceleration, friction, damping (the standard arcade formulation)

The community-standard formulation for SSX-likes (point mass on heightfield), which the observed behavior matches:

1. **Slope-projected gravity**: acceleration along the surface = `g · sin(θ)` where θ is local slope angle; reducing θ reduces available acceleration until it is 0 on flat ground. [HARD, textbook] — https://modern-physics.org/snowboard/ , carving math with worked example (α = 20°, g = 9.8, `R_T = R_SC·cos φ`, `a_c = v²/R_T`): https://www.real-world-physics-problems.com/physics-of-snowboarding.html
2. **Coulomb friction**: deceleration = `μ · g · cos(θ)` opposing motion. Real ski/snow μ_k ≈ **0.03–0.05 at low speed rising to ~0.1 at 22 m/s** (lab: 0.041 on ice ≤ 4 m/s). Arcade games use the low end or fold friction into a drag term entirely. [HARD for the real-world numbers] — https://hypertextbook.com/facts/2007/TabraizRasul.shtml , https://www.cambridge.org/core/journals/journal-of-glaciology/article/kinetic-friction-on-snow-and-ice/8DE77EA547D0B5814213D3744660D466
3. **Exponential (speed-proportional) damping** produces the observed soft top speed: with `dv/dt = a_slope − λv`, terminal speed `v_max = a_slope/λ` emerges per-slope with asymptotic approach — matching SSX's behavior where each pitch has its own natural cruise speed and you never hit a hard wall outside boost. Frame-rate-independent form (use this, not per-frame multipliers): `v ← lerp(v, v_target, 1 − exp(−λ·dt))`, decay `a(t+n) = a(t)·e^(−λn)`. [HARD for the math] — https://www.rorydriscoll.com/2016/03/07/frame-rate-independent-damping-using-lerp/
4. Velocity is decomposed into **board-longitudinal vs lateral**; lateral velocity is damped much harder than longitudinal (this is what "edging" scales — see §5). Carving scrubs speed; pointing straight conserves it. [EST/standard formulation; matches guide advice that turning wide loses races]

Recommended rebuild constants at 60 Hz (all [EST], derived to satisfy the testable assertions in §7):

| Quantity | Target |
|---|---|
| Longitudinal damping λ_long | 0.10–0.25 s⁻¹ |
| Lateral damping λ_lat | 2.5–6 s⁻¹ (≥ 15× λ_long) |
| Flat-ground coast from cruise to near-stop | 6–10 s |
| Slope 25–30° steady-state (no tuck/boost) | ~60–75 km/h equivalent |

---

## 3. Top speed & speed classes

SSX Tricky shows no speedometer; absolute km/h figures below use the sibling-game/guide anchors:

- **Tuck bonus: "~25 km"** (km/h) over untucked riding — the one explicit in-game-units number the strategy-guide community states, appearing in gondee's SSX Tricky strategy guide and repeated in the SDA knowledge base: "Hold forward on the stick whenever possible to give your rider a significant speed boost (~25km); they'll tuck in… faster but also slightly harder to turn." [HARD quote, units informal] — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936 , https://kb.speeddemosarchive.com/SSX_(2012)
- **Boosted speed cap ~150 km/h** — SSX (2012) rail-boost speeds "cap slightly lower than land speeds, usually ~150km"; use as the ceiling anchor for the franchise's speed scale. [HARD for SSX 2012; EST as Tricky proxy] — https://kb.speeddemosarchive.com/SSX_(2012)
- Resulting target ladder for the rebuild [EST]:

| State | Target speed band |
|---|---|
| Untucked cruise, medium slope | 55–75 km/h |
| Tucked | +20–30 km/h over cruise (per the "~25km" quote) |
| Boosting (held) | 110–150 km/h, reached in ~1.5–3 s |
| Absolute cap | hard-clamped (see below) |

- **A hard speed cap exists in the engine**: "No Speed Cap" patches exist for both SSX (2000) (`002c10d8`) and SSX Tricky (`0012b348` + `001179fc`). So the original clamps velocity magnitude at a constant; the rebuild should clamp too rather than relying on drag alone. [HARD] — https://ssx.computernewb.com/wiki/PS2_Patches

### Tuck details

- Activation: hold stick/d-pad forward; rider visibly tucks. Effect: higher top speed, **reduced turn authority** ("slightly harder to turn"). [HARD] — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936
- Implement as: raises `v_target` by the tuck bonus and multiplies steering rate by ~0.5–0.7 while held. [EST]

### Boost details

- Boost drains the Uber/boost meter while held; meter refills by landing tricks (bigger/more unique tricks fill more). [HARD] — https://www.giantbomb.com/uber-trick-system/3015-4/ , https://ssx.fandom.com/wiki/SSX_Tricks
- **Tap-boosting**: "tapping the boost button repeatedly (instead of just holding it down) causes your boost to last MUCH longer (almost three times as long) while still maintaining near-top speed" — i.e., boost speed decays slowly after release (exponential decay back to v_target, ~1–2 s time constant [EST]), so duty-cycling ≈ full speed at ⅓ the meter cost. [HARD quote] — http://www.cheatcodes.com/guide/expert-advice-faq-ssx-tricky-ps2-22984/
- **Tricky state**: landing 6 distinct Uber tricks lights all letters of T-R-I-C-K-Y → **unlimited boost** (meter no longer drains) for the rest of the run while maintained; a knockdown of a rival **instantly fills the whole meter**. [HARD] — https://www.giantbomb.com/uber-trick-system/3015-4/ , https://ssx.fandom.com/wiki/SSX_Tricks , http://www.cheatcodes.com/guide/expert-advice-faq-ssx-tricky-ps2-22984/
- Boost visual tiers noted by players: red boost fastest, orange medium, yellow slowest (i.e., boost strength scales with meter/state tier). [HARD, qualitative] — https://www.supercheats.com/playstation2/questions/ssxtricky/204651/how-do-you-use-the-boost-on-ss.htm

---

## 4. Speed retention & loss

- Clean landings (board aligned within a tolerance cone, rotation completed) conserve nearly all speed; sketchy landings visibly stumble and scrub speed; full wipeouts drop the rider to near-zero and cost seconds of get-up animation. [EST/qualitative from guides; guides treat crashes as race-losing]
- Repeated-trick score penalty (each repeat halves points) exists, so meter economics — not speed — is what repeat tricks hurt. [HARD] — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/17492
- Grinding twisty rails can be slower than riding: gondee's racing advice is to bail off fences early "as grinding the twisty fence is slower than jumping off early and boosting". Rails impose their own (lower) speed profile. [HARD, qualitative] — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936
- Landing uphill/flat kills speed via the `g·sin(θ)` term going ≤ 0 — no special-case code needed beyond slope projection. [INFERRED]

---

## 5. Character stats (the tuning knobs the game itself exposes)

Stats are integers on a shared scale (initial → max via career upgrades). Full table from FishEye's Character FAQ [HARD] — https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/16020 :

| Character | Edging | Speed | Stability | Tricks |
|---|---|---|---|---|
| Eddie | 09/34 | 16/38 | 08/34 | 11/34 |
| Elise | 10/32 | 12/38 | 10/34 | 12/36 |
| Marisol | 11/36 | 16/38 | 05/32 | 12/34 |
| Seeiah | 09/34 | 13/36 | 07/30 | 15/40 |
| Luther | 09/34 | 10/34 | 20/40 | 05/32 |
| JP | 07/32 | 12/35 | 09/33 | 16/40 |
| Zoe | 11/34 | 13/36 | 08/34 | 12/36 |
| Moby | 09/34 | 12/34 | 09/36 | 14/36 |
| Mac | 09/32 | 11/34 | 06/34 | 18/40 |
| Kaori | 11/34 | 11/34 | 05/32 | 17/40 |
| Psymon | 06/36 | 15/35 | 12/35 | 11/34 |
| Brodi | 08/36 | 17/40 | 13/36 | 06/28 |

- Semantics (community consensus): **Edging** = carve grip / tighter turns without scrubbing wide; **Speed** = higher v_target/accel; **Stability** = landing tolerance & rail balance; **Tricks** = rotation/meter gain. [HARD, qualitative] — https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/answers/209382-what-exactly-do-the-edging-and-stability-stats-help-with
- Magnitude anchor from SSX (2012): each +10 Speed/Boost stat ≈ **1 second saved per minute of riding** (~1.7% speed per 10 points) — use the same ~0.15–0.2%/point scaling for Tricky's 5–40 range. [HARD for 2012; EST as Tricky proxy] — https://kb.speeddemosarchive.com/SSX_(2012)

---

## 6. Jumping / charge (feeds the gravity feel)

- Hold jump button to crouch; **the longer it is held, the higher the jump**; release at the lip for max air. Prewind: while crouched, hold a direction to pre-load spin; "prewound" jumps get "better air time and faster spins". [HARD] — https://strategywiki.org/wiki/SSX/Controls , https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/faqs/22225
- Rebuild targets [EST]: charge time 0 → full in ~1.0 s; full-charge jump impulse ~1.8–2.2× tap impulse; jump adds vertical velocity in the terrain-normal-biased-up direction and never subtracts horizontal speed.

---

## 7. Testable assertions

Gravity / air:
1. Gravity is applied as a constant per-tick velocity increment (explicit Euler); scaling that single constant by 1/16 must still yield a playable, stable sim ("moon gravity" patch behavior).
2. With scene scale set by a ~1.8-unit rider, effective airborne gravity is 0.45–0.65 × 9.8 u/s²; a full-charge jump off a 30° kicker at cruise speed yields ≥ 2.5 s airtime.
3. Horizontal velocity is unchanged (< 1% drift) over any airborne arc with no input; spinning/grabbing in air changes nothing about the trajectory.

Slope / friction:
4. On-ground longitudinal acceleration equals `g_eff·sin(θ)` minus drag terms: doubling sin(θ) (θ 15°→~31°) at equal speed at least ~doubles net acceleration.
5. On flat ground (θ=0) with no input, speed decays exponentially (log-linear v(t), R² > 0.98), reaching < 10% of cruise in 6–10 s; there is no hard stop discontinuity.
6. Steady-state speed on a constant 25–30° slope, no tuck/boost, converges to a fixed value (±2%) regardless of entry speed (from above or below) — i.e., v_target = a/λ behavior.
7. Lateral (board-sideways) velocity decays ≥ 15× faster than longitudinal; a 90° instant board rotation at speed scrubs most speed within ~0.5 s (hockey-stop), while a straight run does not.

Tuck / boost / caps:
8. Tuck raises steady-state speed by 20–30 km/h-equivalent (~+30–40% over cruise) and multiplies steering rate by 0.5–0.7; both effects end when the input is released.
9. Held boost reaches its elevated v_target in 1.5–3 s; after release, excess speed decays with a ~1–2 s time constant, such that duty-cycled tapping (≈ 33% duty) maintains ≥ 90% of boost top speed while draining the meter at ≈ ⅓ the held rate ("lasts almost three times as long… near-top speed").
10. A global hard speed cap clamps |v|; no combination of slope + boost exceeds it (cap ≈ boost top speed band, 110–150 km/h-equivalent).
11. Boost meter: drains only while boost applied; fills on landed tricks proportional to trick magnitude; 6 distinct Ubers → unlimited-boost Tricky state (drain = 0); repeated identical trick fills half the previous amount each repeat.

Stats / structure:
12. Character Speed/Edging/Stability stats (range ~5–40) monotonically scale v_target, carve grip (lateral damping while edging), and landing tolerance respectively; +10 Speed ≈ +1.5–2% overall course speed.
13. Sim runs on a fixed 60 Hz physics tick (or is provably tick-rate independent via the `1 − exp(−λ·dt)` damping form); halving render frame rate changes race time on a reference slope by < 1%.
14. Rider is a point mass on the heightfield: collision/physics state is position + velocity (+ board yaw); animation state never feeds back into the integrator.

---

## Source list

- SSX Modding Wiki, PS2 patches (gravity/speed-cap/60fps bytes): https://ssx.computernewb.com/wiki/PS2_Patches
- SSX (2000) decompilation (state of): https://github.com/SSXModding/ssxog · org: https://github.com/SSXModding
- gondee, *SSX Tricky Strategy Guide* (tuck ~25km, racing/rail advice): https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14936
- Expert Advice FAQ mirror (tap-boost ≈ 3× duration quote): http://www.cheatcodes.com/guide/expert-advice-faq-ssx-tricky-ps2-22984/
- FishEye, *Character FAQ* (full stat table): https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/16020
- Stat semantics thread: https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/answers/209382-what-exactly-do-the-edging-and-stability-stats-help-with
- Uber Trick System / Tricky state: https://www.giantbomb.com/uber-trick-system/3015-4/ · https://ssx.fandom.com/wiki/SSX_Tricks
- Boost color tiers: https://www.supercheats.com/playstation2/questions/ssxtricky/204651/how-do-you-use-the-boost-on-ss.htm
- SDA Knowledge Base, SSX (2012) (150 km/h rail cap, +10 stat ≈ 1 s/min): https://kb.speeddemosarchive.com/SSX_(2012)
- Controls/charge-jump/prewind: https://strategywiki.org/wiki/SSX/Controls · https://gamefaqs.gamespot.com/gamecube/529307-ssx-tricky/faqs/22225
- Showoff Guide (repeat-trick halving): https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/17492
- Slope/carve physics math: https://www.real-world-physics-problems.com/physics-of-snowboarding.html · https://modern-physics.org/snowboard/
- Snow friction coefficients: https://hypertextbook.com/facts/2007/TabraizRasul.shtml · https://www.cambridge.org/core/journals/journal-of-glaciology/article/kinetic-friction-on-snow-and-ice/8DE77EA547D0B5814213D3744660D466
- Frame-rate-independent exponential damping: https://www.rorydriscoll.com/2016/03/07/frame-rate-independent-damping-using-lerp/
- SSX (2000) background (physics-engine intent, 60Hz era): https://en.wikipedia.org/wiki/SSX_(2000_video_game)
