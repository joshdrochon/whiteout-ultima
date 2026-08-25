# 04 — Chase Camera & Game-Feel Reference (SSX Tricky target)

Research reference for judging a Three.js + JS physics + GLSL rebuild of SSX Tricky-style
snowboarding. Part of the reference bar: a critic compares generated code against the facts,
estimates, and parameter targets below.

Legend: **[FACT]** = directly sourced. **[ESTIMATE]** = derived from footage descriptions /
secondary analysis; exact PS2 values were not findable. Estimates carry a target value the
critic should treat as a starting point ± the stated tolerance, not gospel.

---

## 1. What is documented about SSX's camera system (primary sources)

### 1.1 The engine has a family of named chase-camera modes [FACT]

The SSX Modding Wiki documents a patch for SSX 3 (same EA Canada lineage/engine family as
Tricky) at address `0015D08C` that switches the camera algorithm by ID. Documented modes:

| ID | Mode |
|------|------|
| 0x7 | idle |
| 0xd | **lazy chase** |
| 0xb | manual / replay manual camera |
| 0x20 | look back |
| 0x21–0x27 | **relative chase variations** (7 variants) |
| 0x29 | matrix camera |
| 0x44 | POST_RACE_1 — "close perspective with slow rotation" |

Source: https://ssx.computernewb.com/wiki/PS2_Patches (patch by Modeco80).

Implications for a rebuild:
- The shipped gameplay camera is a **chase camera relative to the rider**, with multiple
  tuned variants (the 0x21–0x27 range) — i.e. distance/height/lag presets, not one hardcoded rig.
- "Lazy chase" existing as a distinct named mode confirms the design vocabulary: a chase cam
  with deliberately loose (laggy) yaw tracking.

### 1.2 Player-adjustable camera views [FACT]

SSX Tricky lets the player change camera view from the pause menu Options, and with the
"Pro" control scheme the viewpoint can be changed during play via L1 + D-pad / L1 + left
stick. So the game ships multiple discrete follow distances/zooms, not a single fixed rig.
Source: https://www.hometheaterforum.com/community/threads/how-do-you-zoom-in-the-viewpoint-in-ssx-tricky-ps2.32799/ (thread summary via search; page itself is 403).

### 1.3 Boost tiers (drives the speed-sense presentation) [FACT]

Boost color communicates magnitude: **yellow = slowest, orange = medium, red = fastest**;
the lightning-ring pickup grants **red boost for ~5 seconds**. Boost is spent with Square
after tricks. Camera/FX intensity in a rebuild should scale with this 3-tier ladder plus the
"Tricky" infinite-boost state.
Source: https://www.supercheats.com/playstation2/questions/ssxtricky/204651/how-do-you-use-the-boost-on-ss.htm

### 1.4 Rider/board pivot behavior the camera has to frame [FACT — community analysis]

In SSX the character's **hip area is the pivot**; the board slides laterally away from the
turn direction ("the characters would push the board sidewards before it bit the snow…
really noticeable in the trail the board left in the snow"), unlike Amped where "the board
stuck like an ice skate." The camera frames the hips, not the board, and the lateral board
slide reads as drift *within* the frame — i.e. the camera does NOT hard-lock to board yaw.
Source: https://steamcommunity.com/app/2743850/discussions/0/597390873150422477/ (Tricky Madness community analysis of SSX movement).

### 1.5 Engine numeric context [FACT]

SSX Tricky NTSC-U has documented patches for gravity (`0012b7f0` → `3c01ff50`, "Moon
Gravity") and speed cap removal (`0012b348` / `001179fc` → `3c014f51`, "No Speed Cap") —
i.e. the sim has an explicit speed cap the camera FX ladder saturates against.
Source: https://ssx.computernewb.com/wiki/PS2_Patches

---

## 2. SSX Tricky camera behavior — footage-derived targets [ESTIMATE unless noted]

Exact PS2 tuning values are not public (no decomp of the camera code found; the modding wiki
documents no FOV/distance patches for Tricky). The following are targets derived from how
the game reads in footage and from the documented mode names above. A critic should test the
rebuild for these *behaviors* and treat numbers as ±30% starting points.

### 2.1 Ground follow (the "relative chase")

- **Follow distance:** ~4.5–6 m behind the rider (rider fills roughly 1/6–1/5 of frame
  height). Target: **5.5 m**. [ESTIMATE]
- **Camera height:** ~1.5–2.5 m above the rider's board, looking slightly down (~8–15° pitch
  below horizontal) so the slope ahead dominates the upper 2/3 of frame. Target: **2.0 m
  above rider root, pitch ≈ −10°**. [ESTIMATE]
- **Look-at:** at/above the rider's chest and biased downhill (look-ahead), never at the
  board — consistent with hip-pivot framing (§1.4). Target: **rider root + 1.0 m up + 4–8 m
  along smoothed velocity**. [ESTIMATE]
- **Yaw follows velocity heading, not board yaw.** During a carve the rider visibly rotates
  and slides laterally in frame while the camera keeps pointing broadly downhill and swings
  around lazily. This is the "lazy chase" (§1.1). Yaw catch-up reads as a time constant of
  roughly **0.2–0.4 s** (camera closes ~63% of a step heading change in that time).
  [ESTIMATE]
- **Position tracking is much tighter than yaw** — the rider never drifts more than ~10–15%
  of screen width off-center even in hard carves. Position lag time constant target:
  **0.1–0.15 s**. [ESTIMATE]

### 2.2 Airtime and tricks

- **The camera does not orbit with the rider's spin.** During spins/flips/uber tricks the
  camera holds its heading (approximately the takeoff/velocity heading) and keeps following
  the rider's position; the rider rotates *within* the frame. This is what makes spin counts
  readable. [ESTIMATE — universally visible in footage; also implied by air controls being
  described relative to a stable frame: https://strategywiki.org/wiki/SSX/Controls]
- **Pitch relaxes toward horizontal in air** so the landing zone stays visible at the bottom
  of frame (players are told to judge landings by the rider's shadow, which the camera must
  keep on screen: https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14943). [ESTIMATE]
- **Distance eases out slightly on big air** (~+10–20% at apex of multi-second airtime) to
  frame the full trick silhouette. [ESTIMATE]
- Uber tricks hold the same chase framing (no cinematic cut in normal play); the trick
  itself is the spectacle. Sources on ubers describe board-off animations, not camera cuts:
  https://ssx.fandom.com/wiki/List_of_Uber_Tricks_in_SSX_Tricky. [ESTIMATE]

### 2.3 Landing and crashes

- **Clean landing:** brief compression — camera dips with the rider and recovers in ~0.3 s;
  small shake proportional to fall height. Target: shake amplitude ≤ ~3° rotational
  equivalent, fully decayed within ~0.5 s. [ESTIMATE]
- **Crash:** camera detaches from tight chase, holds/eases while the rider ragdolls, then
  re-acquires chase on recovery. Crashing during a trick costs the boost meter
  (https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14943), and camera language
  (looser, longer framing) marks the state change. [ESTIMATE]

### 2.4 Speed sense

- FX intensity ladder tracks boost tier (yellow→orange→red→Tricky, §1.3):
  snow spray/particle streaks near camera, board trail, wind audio; FOV widening at
  boost/top speed. PS2-era Tricky's speed read comes mostly from **particles + camera,
  not full-screen motion blur** (real motion blur was not a PS2 Tricky feature; a rebuild
  should prefer FOV + particles + optional radial blur shader kept subtle). [ESTIMATE]
- FOV kick target: see §3.4 — **+8–15% of base FOV at max boost**, eased both ways.

---

## 3. Implementation reference bar (well-sourced gamedev standards)

The critic should verify the rebuild uses these *forms*, since they are the accepted
correct math; the constants are tunable.

### 3.1 Frame-rate-independent damped follow [FACT]

Naive `pos.lerp(target, 0.1)` per frame is framerate-dependent. Correct exponential form:

```
t = 1 - exp(-λ * dt)          // λ = damping rate (1/s)
current = lerp(current, target, t)
```

Equivalent: `current = target + (current - target) * exp(-λ*dt)`. Splitting an interval into
many small steps gives the identical result — the property that makes it framerate-safe.
Sources:
- https://www.rorydriscoll.com/2016/03/07/frame-rate-independent-damping-using-lerp/
- https://www.gamedeveloper.com/programming/improved-lerp-smoothing-
- https://www.ryanjuckett.com/damped-springs/ (full critically-damped spring derivation when
  velocity continuity matters)

**Known-good concrete values:**
- SimonDev's Three.js third-person camera uses `t = 1.0 - Math.pow(0.001, dt)` — i.e.
  λ = −ln(0.001) ≈ **6.9 /s** for both position and look-at.
  Source: https://github.com/simondevyoutube/ThreeJS_Tutorial_ThirdPersonCamera (main.js).
- Eiserloh (GDC 2016) asymptotic averaging `x += (target − x) * w` per 60 fps frame with
  guidance: **w = 0.01 slow-motion, 0.1 reasonably fast, 0.5 incredibly fast**
  (w = 0.1@60fps ≡ λ ≈ 6.3 /s).
  Source: https://archive.org/stream/GDC2016Eiserloh/GDC2016-Eiserloh_djvu.txt
  (slides: http://www.mathforgameprogrammers.com/gdc2016/GDC2016_Eiserloh_Squirrel_JuicingYourCameras.pdf)

**SSX-feel mapping [ESTIMATE]:** position λ ≈ 6–10 /s (tight), heading/yaw λ ≈ 2.5–5 /s
(lazy chase lag, §2.1), FOV λ ≈ 3–5 /s, air-distance ease λ ≈ 2 /s.

### 3.2 Rig structure (offset rotated by heading + smoothed look-at) [FACT]

Standard Three.js pattern (SimonDev): compute `idealOffset` and `idealLookat` in
character-local space, rotate both by the target's quaternion, add target position, then
exponentially damp current position and current look-at separately. His demo constants:
offset `(-15, 20, -30)`, lookat `(0, 10, 50)` (arbitrary world scale — the *ratios* matter:
look-at is far ahead of the character, ~1.7× the follow distance, giving built-in
look-ahead).
Source: https://github.com/simondevyoutube/ThreeJS_Tutorial_ThirdPersonCamera

**For SSX feel the rotation source must be the smoothed velocity heading, not the board/rig
yaw** (§2.1, §2.2) — a critic should check the camera code never feeds raw character yaw
into the offset rotation during carves or spins.

### 3.3 Camera shake — trauma model [FACT]

Eiserloh, GDC 2016 "Juicing Your Cameras With Math":
- Keep `trauma ∈ [0,1]`; events add trauma (**+0.2 small, +0.5 large**); trauma **decays
  linearly** over time.
- `shake = trauma²` (or trauma³) — trauma 0.3/0.6/0.9 → 3%/22%/73% shake (quadratic-cubic
  perceptual ramp).
- 3D application (rotational shake dominates in 3D):
  ```
  yaw    = maxYaw    * shake * noise1(t)
  pitch  = maxPitch  * shake * noise2(t)
  roll   = maxRoll   * shake * noise3(t)
  offset = maxOffset * shake * noise4..6(t)   // optional translational
  ```
  with **Perlin noise per axis (different seeds) instead of white random** for smoother,
  more physical shake.
Source: https://archive.org/stream/GDC2016Eiserloh/GDC2016-Eiserloh_djvu.txt

**Landing-shake targets for this project [ESTIMATE]:** maxPitch/maxRoll ≈ 3–5°, maxYaw ≈
2–3°, maxOffset ≈ 0.15–0.3 m, noise frequency ≈ 15–25 Hz, trauma add =
`clamp(impactSpeed_normal / 20 m·s⁻¹, 0, 0.5)`, linear decay ≈ 1.5–2.5 trauma/s (shake gone
in ≤ 0.5 s for clean landings, §2.3).

### 3.4 FOV kick at speed/boost [FACT + ESTIMATE]

Documented magnitudes from shipped/valued implementations:
- Minecraft sprint: FOV increase reported ≈ **+20** (FOV units) to sell sprint speed.
  Source: https://minecraft-archive.fandom.com/wiki/Sprinting
- BeamNG "Enhanced Chase Camera": dynamic FOV capped at **max +8%** scaling with speed —
  "better sense of speed without distorting the image."
  Source: https://www.beamng.com/resources/enhanced-chase-camera-fix-adaptive-height-refined-fov.37135/
- FOV-kick components structure the effect as: kick amount (degrees) + kick-in duration/ease
  + kick-out duration/ease.
  Source: https://docs.zigurous.com/com.zigurous.camerasystem/manual/fov-kick/
- Make the kick **relative** (`baseFOV + Δ` or `baseFOV * k`), never a hardcoded absolute.
  Source: https://forums.unrealengine.com/t/sprint-fov-question/2468387

**Formula target for this project [ESTIMATE]:**
```
speedT   = clamp((speed - v0) / (vmax - v0), 0, 1)
boostT   = boostActive ? tier/3 : 0            // yellow=1/3 … red=1, Tricky=1
targetFOV = baseFOV * (1 + 0.10 * speedT + 0.08 * boostT)   // cap ≈ +18%
fov += (targetFOV - fov) * (1 - exp(-4 * dt))
```
Base vertical FOV ≈ 55–60°. Kick-in faster than kick-out (≈0.25 s in, ≈0.6 s out) so boost
"punches."

### 3.5 Design guardrails (Nesky, GDC 2014 "50 Camera Mistakes") [FACT]

From the Journey camera designer: dynamic third-person cameras are "the hardest to design";
keep line of sight to what the player needs (here: the slope, the next jump, the landing
shadow) at all times; avoid motion the player didn't cause; prefer simpler rigs over broken
dynamic ones.
Sources: https://gdcvault.com/play/1020460/50-Camera ·
https://www.gameanim.com/2016/04/09/50-game-camera-mistakes/

---

## 4. Consolidated parameter starting table

| Parameter | Start value | Confidence |
|---|---|---|
| Base vertical FOV | 55–60° | ESTIMATE |
| FOV at max speed+boost | base × 1.15–1.18 | ESTIMATE (BeamNG +8%, Minecraft +20 bracketing) |
| FOV smoothing λ | 3–5 /s (in faster than out) | ESTIMATE |
| Follow distance (ground) | 5.5 m | ESTIMATE ±30% |
| Follow height above rider | 2.0 m | ESTIMATE ±30% |
| Camera pitch (ground) | −10° | ESTIMATE |
| Look-at | rider +1.0 m up, +4–8 m along velocity | ESTIMATE |
| Position damping λ | 6–10 /s | FACT-anchored (SimonDev 6.9, Eiserloh 6.3) |
| Yaw/heading damping λ | 2.5–5 /s | ESTIMATE ("lazy chase") |
| Air: extra distance at apex | +10–20% | ESTIMATE |
| Air: camera yaw | frozen to takeoff/velocity heading | ESTIMATE (footage-universal) |
| Landing trauma add | up to +0.5, ∝ impact speed | FACT-form (Eiserloh) |
| Shake = trauma² | maxPitch/Roll 3–5°, maxOffset 0.15–0.3 m | FACT-form, ESTIMATE-magnitude |
| Trauma decay | linear, 1.5–2.5 /s | ESTIMATE |
| Shake noise | Perlin, per-axis seeds, 15–25 Hz | FACT-form (Eiserloh) |
| Boost tiers driving FX | yellow < orange < red; pickup = 5 s red | FACT |

---

## Testable assertions

A critic can turn each into a unit test or frame check:

1. **Framerate independence:** advancing the camera by one 100 ms step vs ten 10 ms steps
   toward a fixed target yields positions equal within 1e-6 — smoothing must use
   `1 − exp(−λ·dt)` (or an exact spring), never a constant per-frame lerp factor.
2. **Damping form:** after a step change in target position, remaining error decays
   exponentially: error(t) ≈ error(0)·e^(−λt), with position λ in 6–10 /s.
3. **Lazy yaw:** after an instantaneous 90° heading change at constant speed, the camera yaw
   closes 63% of the gap in 0.2–0.4 s — and yaw λ is strictly less than position λ.
4. **Velocity-heading rig:** during a carve, camera yaw derives from smoothed velocity
   direction; feeding a spinning character yaw (720° spin) into the rig produces < 15° of
   camera yaw deviation.
5. **No orbit in air:** during a jump with a 900° spin, camera world-space yaw changes by
   less than ~10° between takeoff and landing (excluding shake).
6. **Air framing:** follow distance at airtime apex exceeds ground follow distance by
   10–20%; camera pitch moves toward horizontal so the ground/landing zone stays in frame
   (rider's shadow position projects inside the viewport).
7. **FOV kick:** FOV is monotonic in speed above threshold, caps at ≤ +18–20% of base, is
   applied relative to base FOV, and eases in faster than it eases out.
8. **Boost ladder:** activating a higher boost tier strictly increases at least two speed
   cues (FOV target, particle emission rate); the 5 s pickup grants top tier.
9. **Trauma shake:** shake magnitude equals trauma² (0.3→3%, 0.6→22% within rounding);
   trauma clamps to [0,1]; decay is linear in time; a clean landing's shake fully decays
   within 0.5 s.
10. **Shake noise:** per-axis shake signals are smooth (Perlin-like — bounded derivative),
    uncorrelated across axes, and rotational shake ≤ 5° at trauma = 1.
11. **Look-ahead:** look-at point sits above rider root (≈ +1 m) and ahead along velocity
    (≥ 4 m at speed), never at the board.
12. **Recovery:** after a crash state ends, the camera re-converges to the standard chase
    pose with no cut > 30 cm/frame (no teleport pops).

## Source list

- https://ssx.computernewb.com/wiki/PS2_Patches — SSX 3 camera-mode IDs; Tricky gravity/speed-cap patches
- https://www.supercheats.com/playstation2/questions/ssxtricky/204651/how-do-you-use-the-boost-on-ss.htm — boost tiers/pickup
- https://steamcommunity.com/app/2743850/discussions/0/597390873150422477/ — SSX hip-pivot/board-slide analysis
- https://www.hometheaterforum.com/community/threads/how-do-you-zoom-in-the-viewpoint-in-ssx-tricky-ps2.32799/ — Tricky camera view options
- https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/faqs/14943 — landing/shadow judgment, crash boost loss
- https://strategywiki.org/wiki/SSX/Controls — air control frame of reference
- https://ssx.fandom.com/wiki/List_of_Uber_Tricks_in_SSX_Tricky — uber trick presentation
- https://archive.org/stream/GDC2016Eiserloh/GDC2016-Eiserloh_djvu.txt — trauma shake + asymptotic averaging (GDC 2016)
- http://www.mathforgameprogrammers.com/gdc2016/GDC2016_Eiserloh_Squirrel_JuicingYourCameras.pdf — slides
- https://www.rorydriscoll.com/2016/03/07/frame-rate-independent-damping-using-lerp/ — 1−exp(−λdt) derivation
- https://www.gamedeveloper.com/programming/improved-lerp-smoothing- — improved lerp smoothing
- https://www.ryanjuckett.com/damped-springs/ — critically damped spring math
- https://github.com/simondevyoutube/ThreeJS_Tutorial_ThirdPersonCamera — Three.js rig + `1−0.001^dt`
- https://www.beamng.com/resources/enhanced-chase-camera-fix-adaptive-height-refined-fov.37135/ — +8% speed FOV
- https://minecraft-archive.fandom.com/wiki/Sprinting — sprint FOV kick magnitude
- https://docs.zigurous.com/com.zigurous.camerasystem/manual/fov-kick/ — FOV kick parameterization
- https://forums.unrealengine.com/t/sprint-fov-question/2468387 — relative-FOV practice
- https://gdcvault.com/play/1020460/50-Camera — Nesky, 50 Camera Mistakes
- https://www.gameanim.com/2016/04/09/50-game-camera-mistakes/ — Nesky summary
