# 05 — GLSL / Three.js Snow Rendering Reference

Reference bar for judging generated code: snow surface shading, persistent trail
deformation, carve spray particles, and SSX Tricky's visual style. Facts marked
**[ESTIMATE]** are derived targets, not sourced values; everything else has a URL.

---

## 1. Procedural snow surface shader

### 1.1 Base diffuse: wrap lighting (cheap SSS foundation)

Snow lit with plain Lambert looks chalky-flat. The standard real-time fix is
**wrap lighting**, which lets light bleed past the terminator — Simon Green's
GPU Gems formula:

```glsl
float wrap = 0.5;                       // 0 = Lambert, higher = softer/waxier
float NdotL = dot(N, L);
float diffuse = max(0.0, (NdotL + wrap) / (1.0 + wrap));
```

Source: GPU Gems ch. 16, "Real-Time Approximations to Subsurface Scattering"
(<https://developer.nvidia.com/gpugems/gpugems/part-iii-materials/chapter-16-real-time-approximations-subsurface-scattering>).

Confirmed as the technique of choice for snow specifically: a search summary of
real-time snow SSS notes wrap lighting "efficiently improves snow realism"
because "without subsurface scattering, snow appears overly white and
unrealistic" (<https://therealmjp.github.io/posts/sss-intro/> for the taxonomy
of real-time SSS approximations: screen-space diffusion, pre-integrated LUT,
texture-space diffusion — all overkill for terrain snow; wrap is the terrain-
appropriate one).

The open-source **snowflow demo** (WebGPU/Babylon.js, hand-written WGSL,
fully procedural snow scene) states its snow material exactly:
"wrapped diffuse, a back-scatter subsurface term with depth-dependent blue
tint, GGX specular, SH ambient with a solved snow bounce, and procedural
view-dependent glints gated on grazing angle"
(<https://github.com/Noniv/snowflow_demo>). That one sentence is a complete
recipe for a modern snow BRDF and is the closest open reference to what the
generated code should contain.

**SSS back-scatter term pseudocode** (matching the snowflow description):

```glsl
// depth-dependent blue-tinted back scatter
float backLit = pow(clamp(dot(V, -L), 0.0, 1.0), sssPower);   // view toward light through surface
vec3 sss = backLit * thickness * vec3(0.55, 0.75, 1.0) * sssStrength;
// thickness: from trail-depth texture or a constant for flat snow
```

**[ESTIMATE]** targets: `wrap ∈ [0.3, 0.6]`, `sssPower ∈ [2, 6]`, SSS tint
biased blue (B channel highest).

### 1.2 Sparkle / glints (noise-jittered specular)

The canonical documented implementation is **Journey's glitter**, reverse-
engineered by Alan Zucconi (5-part series,
<https://www.alanzucconi.com/2019/10/08/journey-sand-shader-1/>, glitter part:
<https://www.alanzucconi.com/2019/10/08/journey-sand-shader-5/>). Journey ships
this for sand; the identical math is used for snow glints. Exact technique:

1. A tiled RGB noise texture stores random microfacet normals:
   `float3 G = normalize(tex2D(_GlitterTex, uv).rgb * 2 - 1);`
2. Reflect the light off the random normal: `float3 R = reflect(L, G);`
3. Threshold on view alignment so only rare facets fire:
   `float RdotV = max(0, dot(R, V)); if (RdotV > _GlitterThreshold) return 0;`
   then `return (1 - RdotV) * _GlitterColor;`
4. Output is **added on top of** normal specular and allowed to exceed 1.0 so
   bloom picks it up ("triggering bloom post-processing effects for
   characteristic glow halos" — Zucconi part 5).

John Edwards' GDC talk "Sand Rendering in Journey" adds the mip detail: the
random texture is generated from a **Gaussian distribution** so the dominant
direction stays aligned with the surface normal, and "the size of each
microfacet depends on the scale of the texture and its mipmap level"
(<https://slidetodoc.com/sand-rendering-in-journey-john-edwards-thatgamecompany-shipping/>).

Alternative, texture-free (Shadertoy-style) hash glints — useful because
texture-based sparkle "tends to have aliasing or mip blurring problems"
(Shadertoy discussion; examples: "Sparkly Winter Wonderland"
<https://www.shadertoy.com/view/ml3cDl>, "Glints"
<https://www.shadertoy.com/view/ldVGRh>, efficient snow
<https://www.shadertoy.com/view/ftsGzH>):

```glsl
#define hash21(p) fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453)

vec3 cell   = floor(worldPos * glintDensity);          // e.g. density 40–200 cells/m [ESTIMATE]
vec3 jitterN = normalize(hash33(cell) * 2.0 - 1.0);
vec3 gN     = normalize(mix(N, jitterN, glintSpread)); // spread ~0.3–0.7 [ESTIMATE]
float g     = pow(max(0.0, dot(reflect(-L, gN), V)), glintPower); // power 64–512 [ESTIMATE]
g          *= step(1.0 - glintRarity, hash21(cell.xz + cell.y));  // rarity gate, ~1–5% of cells [ESTIMATE]
color      += g * glintColor * glintGain;              // gain > 1 so bloom catches it
```

snowflow gates its glints "on grazing angle" — i.e. multiply by a Fresnel-ish
`pow(1.0 - NdotV, k)` so sparkle concentrates near glancing view, matching how
real snow sparkles most when looking across it toward the sun
(<https://github.com/Noniv/snowflow_demo>).

Key judgeable properties: glints must be **view-dependent** (shimmer as camera
moves), **sparse** (threshold/rarity gate, not uniform gloss), and **HDR**
(exceed 1.0 pre-tonemap / feed bloom).

### 1.3 Blue-shifted shadows

Physical basis: shadowed snow is lit only by skylight. Direct sun ≈ **5500 K**;
clear-sky skylight ≈ **10,000 K+** (distinctly blue, from Rayleigh scattering);
snow being a near-neutral reflector shows the illuminant color directly
(<https://www.weather-daily.com/why-snow-looks-blue-in-shadows-the-science-behind-winters-color-shifts/>,
<https://www.quora.com/Why-do-shadows-on-snow-appear-blue-in-color>).

Implementation: do **not** darken to gray/black in shadow. Give the ambient/sky
term a blue tint and let the shadow region resolve to it:

```glsl
vec3 sunColor = vec3(1.0, 0.96, 0.90);       // ~5500K
vec3 skyAmbient = vec3(0.45, 0.58, 0.85);    // ~10000K skylight  [ESTIMATE values]
vec3 lit = albedo * (sunColor * diffuse * shadowFactor + skyAmbient * ambientOcclusion);
```

**[ESTIMATE]** target: shadowed-snow pixel hue should sit in the blue range
(B > R by ~20–60% in linear RGB); shadow luminance ~35–55% of lit snow, never
near zero.

---

## 2. Persistent trails / deformation behind the rider

### 2.1 Industry references (the technique the web demos copy)

- **Batman: Arkham Origins**, GDC 2014, Colin Barre-Brisebois (WB Montréal):
  "generates displacement heightmaps at runtime" from character interactions;
  deformation treated as "semi-low frequency detail"; rendered via relief
  mapping on consoles, tessellation displacement on PC; "extremely fast
  performance and low memory footprint."
  Slides: <https://www.slideshare.net/slideshow/gdc2014-deformable-snow-rendering-in-batman-arkham-origins/32839706>,
  GDC Vault: <https://gdcvault.com/play/1020177/Deformable-Snow-Rendering-in-Batman>,
  author's blog: <https://colinbarrebrisebois.com/2014/08/16/deformable-snow-and-directx-11-in-batman-arkham-origins/>.
- **Rise of the Tomb Raider** — "Deferred Snow Deformation," GPU Pro 7 ch. 5
  (Michels & Sikachev): deformation points splatted into a heightmap in a
  deferred pass, snow fill-in over time.
  <https://www.taylorfrancis.com/chapters/edit/10.1201/b21261-5/deferred-snow-deformation-rise-tomb-raider-anton-kai-michels-peter-sikachev>;
  open reimplementation: <https://github.com/vanish87/SnowDeformation>.

### 2.2 Quantified open-source reference: snowflow demo

(<https://github.com/Noniv/snowflow_demo>) — the best numbers available for a
web-tech snow deformation system:

| Fact | Value |
|---|---|
| Deformation buffer | two 2048² **RGBA16F** targets (ping-pong) |
| World coverage | **80 m** window → **3.9 cm/texel**, toroidal addressing (scrolls with rider) |
| Trail persistence | **~71% of trail depth survives one minute** |
| Refill model | anisotropic diffusion — "loose berms slump **3×** faster than a packed trench floor" |
| Terrain heightmap | 4096² RG32F, ~870 m radius, clipmap: 8 rings, 8.5 cm inner spacing |
| Whole-frame GPU cost | 3.22 ms @ 2560×1440 (RTX 5070 Ti), ~353k tris, 15–19 draw calls |

### 2.3 Three.js-specific implementations

- **Codrops "Creating Dynamic Terrain Deformation with React Three Fiber"**
  (<https://tympanus.net/codrops/2024/11/27/creating-dynamic-terrain-deformation-with-react-three-fiber/>,
  demo <https://tympanus.net/Tutorials/DynamicTerrainDeformation/>): CPU-side
  vertex deformation on a 3×3 chunk grid, `displacementScale = 2`, cubic
  falloff `influence = pow((DEFORM_RADIUS - dist) / DEFORM_RADIUS, 3)`,
  `yOffset = influence * 10`, plus a rim wave
  `y += WAVE_AMPLITUDE * sin(WAVE_FREQUENCY * dist)` (raised berm at the trail
  edge). Good for the *shape* of a footprint/trail cross-section; too CPU-heavy
  for a fast rider — use the RTT version below.
- **Codrops "Grid Displacement Texture with GPGPU"**
  (<https://tympanus.net/codrops/2024/08/27/grid-displacement-texture-with-rgb-shift-using-three-js-gpgpu-and-shaders/>):
  the exact RTT trail pattern, using `GPUComputationRenderer`. Quantified:
  per-frame decay `float uRelaxation = 0.965; color.rg *= uRelaxation;`;
  brush falloff `dist = 1. - smoothstep(0., 0.22, dist);`; stamped velocity
  scaled ×80. GPUComputationRenderer "allows output of a computed fragment
  shader as a texture and use this texture as the input of the shader in the
  next frame."
- Ping-pong feedback trail write-ups on the three.js forum:
  <https://discourse.threejs.org/t/recursive-trail-ping-pong-three-js-render-to-texture-feedback/89718>,
  <https://discourse.threejs.org/t/fbo-feedback-mouse-trail/88846> (brush
  stamps + fade, FBO feedback loop with ping-pong WebGLRenderTargets).

### 2.4 Reference architecture (what generated code should look like)

```
// Ping-pong trail heightmap, UV = world XZ within a window following the rider
RT_A, RT_B : WebGLRenderTarget, 512–2048 px, single channel (R16F/R8) or RG16F
             (R = carve depth, optional G = age/pack state)

each frame:
  1. TRAIL PASS (fullscreen quad, reads RT_prev, writes RT_next):
     h = texture(prevTrail, uv).r;
     h *= refillFactor;                       // e.g. 0.999–0.9995/frame for minutes-scale
                                              // persistence; 0.965 = seconds-scale (Codrops)
     d = distance(worldUV, riderUV);
     stamp = (1.0 - smoothstep(0.0, brushRadius, d)) * carveDepth;
     h = max(h, stamp);                       // max() = permanent-until-refill trail
     out = h;
  2. swap RT_A/RT_B
  3. SNOW MATERIAL vertex shader:
     float h = texture(trailTex, trailUV).r;
     pos.y -= h * maxTrenchDepth;             // e.g. 0.1–0.3 m [ESTIMATE]
     // normals: finite-difference the trail texture
     n = normalize(vec3(h_x0 - h_x1, 2.0*texelWorldSize, h_z0 - h_z1));
  4. FRAGMENT: darken/blue-tint trench interior (compressed snow is bluer,
     shadowed), sharpen specular in trench (packed snow is icier). [ESTIMATE]
```

Judgeable properties: trail must **persist across frames** (not respawn),
**deform geometry** (silhouette changes, not just a decal), **recompute
normals** from the trail texture so the trench catches light, and the window
must **follow the rider** (toroidal/scrolling UV or re-centered ortho camera).
An alternative stamping method: render trail-emitting meshes with an
**orthographic top-down camera** into the RT instead of an analytic brush —
this is the Batman/RotTR pattern (runtime heightmap from an ortho view).

---

## 3. Snow spray particles when carving

### 3.1 GPU particle techniques (Three.js)

- Canonical FBO/GPGPU particle write-up: barradeau "FBO particles" —
  simulation pass writes positions to a RenderTarget, render pass reads it as
  vertex texture (<https://barradeau.com/blog/?p=621>).
- `GPUComputationRenderer` (ships in three.js examples) stores positions and
  velocities in ping-ponged float textures; Codrops GPGPU particle tutorial:
  <https://tympanus.net/codrops/2024/12/19/crafting-a-dreamy-particle-effect-with-three-js-and-gpgpu/>;
  Three.js Journey "GPGPU Flow Field Particles":
  <https://threejs-journey.com/lessons/gpgpu-flow-field-particles-shaders>.
- Official example scale reference: **`webgpu_compute_particles_snow` runs
  100,000 snow particles** in a compute-driven sim
  (<https://threejs.org/examples/webgpu_compute_particles_snow.html>). A
  carve-spray budget of 10k–50k GPU particles is comfortably inside proven
  web budgets. Simpler shader-only snowfall: 10,000 particles on GPU
  (<https://soledadpenades.com/articles/three-js-tutorials/rendering-snow-with-shaders/>).

### 3.2 Spray structure (what it should look like)

snowflow's carve wake is **two-layer**: the rooster-tail wall is "a swept mesh,
not a particle effect" (spine in a 96×3 data texture, resampled every 30 cm,
one `curl` parameter morphing bank→overhanging lip; wall peaks at **2.4 m** at
full-speed carve and **collapses 0.88 s** after being laid), while the spray
proper is "a dense slow curtain hugging the crest and ballistic grains flung
clear" (<https://github.com/Noniv/snowflow_demo>). Takeaway for judging: good
spray = **dense slow core near the board edge + sparse fast ballistic
outliers**, not one uniform puff.

### 3.3 Spawn rate tied to edge angle — model **[ESTIMATE, derived]**

No published formula exists for SSX; derive from physics of a carving edge
(displaced snow volume ∝ speed × edge bite):

```glsl
// CPU or compute, per frame
float edgeAngle = angleBetween(boardPlane, snowPlane);      // radians
float carving   = clamp(sin(edgeAngle) * lateralSlip, 0.0, 1.0);
float rate      = baseRate * speed01 * carving;             // particles/sec
// targets [ESTIMATE]: rate ≈ 0 when riding flat-based;
//   ~200–500/s gentle carve; 2000–5000/s full-speed hockey-stop;
//   burst 1000–3000 on landing impact
// emission: at the downhill edge midpoint, initial velocity =
//   riderVel * 0.3–0.7 + edgeNormal * (1–4 m/s) + jitter; gravity applies;
//   lifetime 0.4–1.2 s; size shrinks + alpha fades over life
```

Particles rendered as soft alpha-blended sprites (or additive near-white),
tinted by sun/sky exactly like the snow surface so spray reads as the same
material.

---

## 4. SSX Tricky's actual visual style (target look)

Game facts (SSX Tricky, EA Canada / published under EA's BIG label, PS2/GC/Xbox,
2001 — <https://en.wikipedia.org/wiki/SSX_Tricky>):

- Runs at **(mostly) 60 fps on PS2** (GameFAQs review:
  <https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/reviews/26835>).
- "Everything is presented in bright colour tones," snow textures more detailed
  than SSX1 (<https://darkzero.co.uk/game-reviews/ssx-tricky-ps2/>).
- Persistent board trail: "As you ride through the level you see the trail of
  snow behind you"; **fireworks shoot out when landing a big move**
  (<https://psx2central.com/reviews/psx2ssxtricky.htm>).
- Per-track color/lighting theming: "different colour lighting effects, which
  melt into each other" (colored gradient lighting, not physically correct)
  (<https://darkzero.co.uk/game-reviews/ssx-tricky-ps2/>).
- "Vibrant graphics brought the snowy mountains to life," tracks read as huge
  with no pop-up (<https://gametalkhq.com/ssx-tricky-review/>,
  <https://gamefaqs.gamespot.com/ps2/469884-ssx-tricky/reviews/26835>).
- Modding/tech resources (file formats, memory addresses, tools):
  SSX Modding Wiki <https://ssx.computernewb.com/wiki/Main_Page> (13 articles;
  Tools/Formats hubs, PS2 memory addresses — no rendering internals published),
  SSX Modding Community <https://github.com/SSXModding>,
  mods hub <https://gamebanana.com/games/8226>.

Style translation for a Three.js rebuild **[ESTIMATE, derived from the above +
era conventions]**:

- **Saturation over realism**: punchy saturated palette, high-key lighting;
  per-track colored light gradients are in-style (magenta/orange/teal skies).
- **Exaggerated spray**: PS2-era spray is oversized and opaque relative to
  reality — spray plumes bigger and denser than the physical model suggests;
  landing a trick triggers celebratory FX (fireworks/glow) — non-diegetic
  effects are canon.
- **Visible persistent board trail** is a headline feature reviewers noticed in
  2001 — a rebuild without a trail fails the style bar.
- Vertex-color gradient lighting + unlit-ish bright snow is closer to the PS2
  look than full PBR; keep shadows soft and blue, never black.

---

## 5. Testable assertions

Surface shader:
- Diffuse term uses wrap lighting: shader contains `(NdotL + w) / (1 + w)` (or
  equivalent) with `w > 0`; a face at NdotL = 0 still receives light.
- Sparkle is stochastic and view-dependent: glint intensity at a fixed fragment
  changes when only the camera moves; fraction of glinting pixels on lit snow
  is small (order 1–5%), not uniform gloss.
- Glint output can exceed 1.0 pre-tonemap (HDR/bloom-feedable) OR is threshold-
  gated (`if/step` against a threshold) per the Journey formula.
- Glint normals come from a noise/hash source remapped `*2-1` to [-1,1] (or a
  hashed cell jitter of N).
- Shadowed snow is blue, not gray: in linear RGB, shadowed-snow B > R;
  shadow luminance in ~35–55% of lit snow, never < 10%.
- An SSS/back-scatter term exists: light-facing-away geometry (thin lips,
  trail berms) receives a blue-tinted transmission term.

Trail deformation:
- Trail state lives in a render target that survives frames: writing frame N,
  reading frame N+1 (ping-pong pair or GPUComputationRenderer) — not rebuilt
  from scratch per frame.
- Stamp uses `max(existing, brush)` or additive-with-clamp, with smoothstep
  falloff — a second pass over the same spot must not double-deepen beyond cap.
- Refill: trail decays multiplicatively per frame; factor ≥ ~0.999/frame at
  60 fps if targeting snowflow's minutes-scale persistence (≈71%/min ↔
  ~0.99990/frame), or document a faster arcade choice.
- Vertex shader displaces geometry down by the trail texture (silhouette
  changes); normals recomputed from trail texture via finite differences —
  trench walls shade differently from flat snow.
- Trail window follows the rider (scrolling/toroidal UV or re-centered ortho
  stamp camera); trail resolution in the range ~2–8 cm/texel (snowflow: 3.9 cm).

Spray particles:
- Particle sim runs on GPU (positions/velocities in textures or compute), not
  per-particle JS objects; ≥10k particles sustainable (three.js reference
  example does 100k).
- Spawn rate ≈ 0 when board is flat-based and monotonically increases with
  edge angle and speed; hard carve at speed emits order-of-thousands/s.
- Emission point is at the board's downhill edge; initial velocity inherits a
  fraction of rider velocity plus an edge-normal component; gravity affects
  particles; lifetime O(0.5–1 s) with size/alpha fade.
- Spray has two populations (dense slow curtain + sparse ballistic grains) or
  at minimum wide variance in initial speed.

Style (SSX Tricky):
- Target 60 fps (the PS2 original mostly held 60).
- Persistent visible trail behind rider present at all times while carving.
- Palette saturated/high-key; per-track colored lighting permitted and
  encouraged; shadows blue, never black.
- Landing a big trick triggers celebratory non-diegetic FX (fireworks/glow).
- Spray visually exaggerated: larger/denser than physically derived rates.
