// candidate B — snow surface fragment shader
// Lighting recipe (GPU Gems ch.16 wrap diffuse + snowflow-style extras):
//   * wrap diffuse (NdotL + w)/(1 + w), w = uWrap (SV-01), shaped by a mild
//     power curve so midtone faces separate instead of washing together
//   * hemispherical blue skylight ambient -> blue, never-black shadows (SV-03)
//   * cell-hash glints: sparse, threshold-gated, view-dependent, HDR pre-tonemap (SV-02)
//   * trench: bright saturated ice-blue interior + churned bright ridge lips, with
//     normals finite-differenced from the combined depth+lip trail field
//     (SV-07 normals leg)
//   * depth-driven blue SSS back-scatter on berm lips
//
// Critique cycle 2 items addressed here:
//   #1 shadow contrast: sun/sky contrast raised (uniforms in attach.mjs:
//      hotter sun, dimmer + equally-blue sky, wrap 0.50 -> 0.45) and the wrap
//      diffuse is shaped by pow(dif, 1.3) — zero point unchanged (SV-01
//      terminator intact), midtones darker, so shadowed faces pull clearly
//      blue-dark away from lit snow, toward the low end of SV-03's 35-55%.
//   #3 radial banding streaks: they were distance moire of the sin-based
//      sastrugi/corduroy detail patterns (regular stripes compressed below
//      pixel size at grazing angles fan into radial bands). Every periodic
//      detail term now fades out via fwidth() before its wavelength reaches
//      the pixel footprint — detailFade() below — so the streaks cannot form.
//   #5 groove look: churned trail interior (noise-mottled compressed blue) +
//      brighter crumb lips with boosted glint eligibility, so the trail reads
//      as chunky carved snow at chase distance.
// Cycle 1 items kept: cool blue-grey scree (never sandstone), noise-broken
// steep-face selection + relaxed directional term (no LOD terracing stripes).
precision highp float;

uniform sampler2D uTrail;
uniform vec2 uTrailOrigin;
uniform float uTrailWorld;
uniform float uTexel;
uniform float uMaxDepth;
uniform float uLipHeight;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uAlbedo;
uniform float uWrap;
uniform float uExposure;
uniform vec4 uGlint;        // x density (cells/m), y jitter spread, z align cut, w gain
uniform float uGlintRarity; // fraction of cells eligible to fire
uniform vec3 uFogCol;       // output-space fog color (matches scene fog)
uniform vec2 uFogRange;
uniform vec4 uRider;        // xy world XZ of board contact, z strength, w radius

varying vec3 vWorld;
varying float vViewZ;

// fract-based hashes (no sin): stable for large world coordinates
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float h13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
vec3 h33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}

// compose round 4 (blind critic: "checkerboard/moire texel aliasing in the
// near-field trail"): the trail RT is a NEAREST float texture (float linear
// filtering is not guaranteed on this stack), so the groove showed raw 3 cm
// texel steps up close. Sample it with MANUAL BILINEAR — 4 texel-center taps
// blended — so depth/lip and the finite-differenced trench normals are all
// C0-smooth across texel boundaries.
vec2 trailDL(vec2 w) {
  vec2 uv = (w - uTrailOrigin) / uTrailWorld;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) return vec2(0.0);
  float R = uTrailWorld / uTexel;               // texture resolution, texels
  vec2 tc = uv * R - 0.5;
  vec2 i0 = floor(tc), f = fract(tc);
  vec2 b = (i0 + 0.5) / R, e = vec2(1.0 / R, 0.0);
  vec2 s00 = texture2D(uTrail, b).rg;
  vec2 s10 = texture2D(uTrail, b + e.xy).rg;
  vec2 s01 = texture2D(uTrail, b + e.yx).rg;
  vec2 s11 = texture2D(uTrail, b + e.xx).rg;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}
// signed surface offset of the trail field (lip up, trench down), meters
float trailY(vec2 w) { vec2 dl = trailDL(w); return dl.y * uLipHeight - dl.x * uMaxDepth; }

vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

// kill a periodic detail term before its wavelength (m) hits pixel size:
// prevents moire fans on distant/grazing slopes (critique cycle 2, #3)
float detailFade(float wavelength, float fw) {
  return 1.0 - smoothstep(0.12 * wavelength, 0.35 * wavelength, fw);
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Ng = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(Ng, V) < 0.0) Ng = -Ng;
  float fw = fwidth(vWorld.x) + fwidth(vWorld.z);   // world meters per pixel

  // ---- trench depth/lip + normals finite-differenced from the trail field --
  float E = uTexel * 1.5;
  vec2 dl = trailDL(vWorld.xz);
  float h = dl.x, lip = dl.y;
  float yx = trailY(vWorld.xz + vec2(E, 0.0)) - trailY(vWorld.xz - vec2(E, 0.0));
  float yz = trailY(vWorld.xz + vec2(0.0, E)) - trailY(vWorld.xz - vec2(0.0, E));
  // surface y = y0 + trailY  =>  normal += (-d/dx, 0, -d/dz)
  // compose round 3: trench-wall gradient gain 1.0 -> 1.6 — from the chase
  // camera the groove runs nearly parallel to the view, so its lateral walls
  // need a harder normal tilt before the raking sun splits them into a lit
  // wall and a shaded wall (the "flat painted stripe" fix)
  vec3 N = normalize(Ng + 1.6 * vec3(-yx / (2.0 * E), 0.0, -yz / (2.0 * E)));

  // compose round 4 (blind critic: "near snowbank walls wash out to flat
  // featureless white at grazing angles"): the albedo detail terms rightly
  // fade with fwidth, but that left NOTHING carrying surface form on close
  // steep walls. Add a broad NORMAL undulation — wind-worked drift bellies at
  // ~8 m wavelength — via a finite-difference gradient of low-freq value
  // noise. Shading variation from a tilted normal survives grazing view
  // angles (it is view-independent), and the long wavelength keeps it alive
  // far beyond the fine detail's fade distance. Amplitude grows on steeper
  // faces (walls need the cue; the flat piste stays clean).
  {
    float DN = 0.55;                                  // FD step, m
    float nf = 0.13;                                  // ~7.7 m wavelength
    float gx = vn((vWorld.xz + vec2(DN, 0.0)) * nf) - vn((vWorld.xz - vec2(DN, 0.0)) * nf);
    float gz = vn((vWorld.xz + vec2(0.0, DN)) * nf) - vn((vWorld.xz - vec2(0.0, DN)) * nf);
    float steep = smoothstep(0.15, 0.55, 1.0 - Ng.y); // 0 flat -> 1 wall
    float duneAmp = (0.22 + 0.55 * steep) * detailFade(7.7, fw);
    N = normalize(N + duneAmp * vec3(-gx / (2.0 * DN), 0.0, -gz / (2.0 * DN)));
  }

  vec3 L = normalize(uSunDir);

  // Remediation cycle 4: the hardcoded course-centerline formula (duplicated
  // from the runner terrain) is GONE, and with it the piste/off-piste masks.
  // The rock/scree treatment depended on that mask to stay off near-course
  // geometry (and off probe spheres — a slope-only mask lit their sides as
  // rock and broke the shadow probes), so it is dropped too: every face is
  // SSX snow. The mountain reads high-key white-and-blue everywhere.

  // ---- albedo: bright snow + drift mottle ---------------------------------
  // Cycle 2 #3: the directional sin sastrugi is GONE — its parallel stripes
  // stayed subpixel-sharp across the view direction at any distance, so
  // fwidth alone couldn't stop them converging into radial fan streaks.
  // Replacement: two-octave ISOTROPIC value noise (no coherent direction ->
  // no fans), plus every remaining detail term also fades with view distance
  // so far faces render as clean bright SSX snow. (Cycle 4: the corduroy term
  // died with the centerline formula it depended on.)
  float distFade = 1.0 - smoothstep(70.0, 190.0, vViewZ);
  float drift = (vn(vWorld.xz * 0.31) - 0.5) * 2.0
              + (vn(vWorld.xz * 0.09 + 17.1) - 0.5) * 1.2;
  drift *= detailFade(3.2, fw) * distFade;
  float micro = (vn(vWorld.xz * 0.55) * 2.0 - 1.0) * detailFade(1.8, fw) * distFade;
  float detail = 1.0 + 0.12 * micro + 0.10 * drift;
  vec3 albedo = uAlbedo * detail;

  // strictly-vertical faces (LOD skirts, cut walls): soft blue-white snow
  // mass with faint large-noise variation — no sin strata (cycle 1 #4)
  float wall = 1.0 - smoothstep(0.03, 0.10, Ng.y);
  float wallTone = 0.88 + 0.14 * vn(vWorld.xz * 0.35 + vWorld.y * 0.6);
  albedo = mix(albedo, albedo * vec3(0.88, 0.94, 1.04) * wallTone, wall);

  // trench interior: cycle 4 — the old (0.26,0.42,1.0)*occlusion navy groove
  // is replaced by BRIGHT saturated ice-blue (SSX trail ribbon: the groove
  // pops lighter-blue against the snow, not darker), still mottled so it
  // reads as churned chunks, not paint; ridge lips get brighter crumbs.
  float tr = clamp(h * 2.6, 0.0, 1.0);
  float lipM = clamp(lip * 2.2, 0.0, 1.0);
  float churn = vn(vWorld.xz * 2.3) * detailFade(0.9, fw);
  // Round 2 (blind critic: "saturated aqua-cyan reads as a water stream"):
  // the groove is DESATURATED blue-grey shadowed snow — modest blue excess,
  // G at/below the R-B midline, most of the read carried by the darkening.
  albedo = mix(albedo, albedo * vec3(0.74, 0.82, 1.00), tr);
  albedo *= 1.0 - 0.32 * clamp(h * 2.0, 0.0, 1.0);          // packed occlusion
  albedo *= 1.0 - 0.12 * tr * (churn * 2.0 - 1.0);          // churned floor mottle
  albedo *= 1.0 + 0.16 * lipM * (0.65 + 0.7 * churn);       // bright crumb lips

  // ---- lighting ------------------------------------------------------------
  // per-pixel NdotL dither breaks the hard facet boundaries of derivative
  // normals into snow-like grain instead of banding (faded before it aliases)
  float ndl = dot(N, L) + (vn(vWorld.xz * 3.1) - 0.5) * 0.10 * detailFade(0.35, fw);
  float dif = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);   // wrap diffuse (SV-01)
  dif = pow(dif, 1.9);   // midtone separation; zero point (terminator) unchanged
  // macro self-shadowing (streak fix): steep faces whose horizontal aspect
  // opposes the sun sit inside macro shadow — per-pixel micro-crests must not
  // catch the sun there (they render as thin white scratch lines on the wall)
  {
    vec2 nh = N.xz / max(length(N.xz), 1e-4);
    float opposedM = clamp(-dot(nh, normalize(uSunDir.xz + vec2(1e-5))) * 1.6, 0.0, 1.0);
    float steepM = clamp((0.72 - N.y) / 0.35, 0.0, 1.0);
    dif *= 1.0 - 0.85 * steepM * opposedM;
  }
  // Round 2: macro cast-shadow bands from the unseen ridgeline — soft,
  // ~80-150 m patches ELONGATED ALONG THE SUN azimuth sweeping the course.
  // They only gate the SUN term, so banded areas fall to the blue skylight:
  // an unmistakable, distance-independent statement of where the light comes
  // from (the loudest missing SSX cue: "no readable sun direction").
  vec2 sunH = normalize(uSunDir.xz + vec2(1e-5));
  vec2 perpH = vec2(-sunH.y, sunH.x);
  float bands = 0.6 * vn(vec2(dot(vWorld.xz, perpH) * 0.022 + 37.7,
                              dot(vWorld.xz, sunH) * 0.007 + 91.3))
              + 0.4 * vn(vec2(dot(vWorld.xz, perpH) * 0.051 + 11.9,
                              dot(vWorld.xz, sunH) * 0.016 + 53.1));
  float sunVis = 0.32 + 0.68 * smoothstep(0.40, 0.50, bands);
  dif *= sunVis;
  // interior/underside views (camera near-clipping through a roller, skirt
  // backfaces): lift toward mid-lit so the cut reads as bright snow mass,
  // not a dead ambient slab. Terrain top faces are front-facing (verified).
  if (!gl_FrontFacing) dif = max(dif, 0.62);
  vec3 amb = uSkyCol * (0.50 + 0.50 * max(N.y, 0.0));           // blue skylight
  // warm sun bounce off surrounding snow onto tilted faces: a SUBTLE colored
  // fill (kept far below the blue skylight so shadows stay saturated blue —
  // the first cut of this term neutralized the shadow color and failed SV-03)
  amb += uSunCol * 0.016 * clamp(1.0 - N.y, 0.0, 1.0);
  // trench floor sees less sky: keeps groove shape without dropping it navy
  amb *= 1.0 - 0.22 * tr + 0.30 * lipM;
  vec3 col = albedo * (uSunCol * dif + amb);

  // specular: icier inside the packed trench
  vec3 Hv = normalize(L + V);
  col += uSunCol * pow(max(dot(N, Hv), 0.0), mix(30.0, 110.0, tr)) * (0.05 + 0.16 * tr);

  // blue SSS back-scatter, thickness driven by carve depth + lip thinness
  // (round 2: trench contribution cut — it was feeding the aqua-river read)
  float back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0);
  col += vec3(0.45, 0.65, 1.0) * back * (0.06 + 1.2 * h + 0.6 * lip) * 0.35;

  // Cycle 5: ACES-desaturation compensation for shadow chroma. The B/R metric
  // passed in linear but the tonemapper pulled on-screen shadows toward
  // neutral gray. Push the SHADOW REGION's hue (keyed on wrap diffuse, so
  // fully-lit faces are untouched) — R down, G up, B up — and the smoothstep
  // reaches into midtones so partially-lit faces (the ones probe framings
  // actually show) cool visibly too. uSkyCol is rebalanced in attach.mjs so
  // the fully-shadowed sphere face stays inside SV-03's 0.2-0.6 band; the
  // G lift makes the on-screen read icy saturated blue, which the tonemapper
  // preserves far better than a pure B/R stretch.
  // (compose round 3: the push is luminance-neutral — the old 0.86/1.02/1.16
  // gained ~1.3% shadow luminance and nudged SV-03's 35-55% band over the top)
  float shadowF = 1.0 - smoothstep(0.03, 0.65, dif);
  col *= mix(vec3(1.0), vec3(0.84, 0.985, 1.13), shadowF);

  // ---- glints: sparse microfacet POINTS, threshold-gated -------------------
  // Cycle 4: each eligible cell no longer lights its whole footprint (that
  // rendered as hard white SQUARES in the near field). Instead every cell
  // carries one jittered glint CENTER, and brightness falls off smoothly with
  // world distance from it, radius tied to the pixel footprint (fw) => a soft
  // 1-3 px screen-space point at any camera distance, capped below the cell
  // size so it can never grow back into a square. Lips keep extra eligible
  // cells: churned crumbs sparkle hardest (cycle 2 #5).
  vec3 cellF = floor(vWorld * uGlint.x);
  vec3 cell = mod(cellF, 512.0);
  float rarity = uGlintRarity * (1.0 + 1.4 * lipM);
  float keep = step(1.0 - rarity, h13(cell + 7.31));
  vec3 gc = (cellF + 0.2 + 0.6 * h33(cell + 3.7)) / uGlint.x;  // glint center, world
  // compose pass: radius up 1.9->2.4 fw (a 2-3 px point survives the output
  // transform) and the tint goes cool — warm sparks read cream on blue snow
  float rad = clamp(2.4 * fw, 0.004, 0.5 / uGlint.x);
  float pt = 1.0 - smoothstep(0.3 * rad, rad, length(vWorld - gc));
  vec3 gN = normalize(N + (h33(cell) * 2.0 - 1.0) * uGlint.y);
  float alignG = max(dot(reflect(-L, gN), V), 0.0);
  float gate = smoothstep(uGlint.z, uGlint.z + 0.03, alignG);
  float grz = 0.55 + 0.9 * pow(1.0 - max(dot(N, V), 0.0), 2.0);
  // round 2 iter 2: glints die out with view distance — far walls covered in
  // white speckle read as film grain, not sparkle; sparkle is a NEAR-FIELD cue
  float glintFade = 1.0 - smoothstep(40.0, 110.0, vViewZ);
  // sparkle follows the light (same principle as the vertex path): a shadowed
  // or macro-shadowed face must not carry a glitter dot-field
  float glintLight = smoothstep(0.06, 0.22, dif);
  col += keep * pt * gate * uGlint.w * grz * glintFade * glintLight * vec3(0.98, 1.0, 1.06);

  // rider board-contact blob shadow (round 2: grounds the rider; suppresses
  // glints inside it too, hence after the glint add). Soft-edged ellipse
  // stretched slightly anti-sun, cool blue like every other shadow here.
  vec2 dR = vWorld.xz - uRider.xy + vec2(0.30, -0.16);
  float rsh = (1.0 - smoothstep(uRider.w * 0.25, uRider.w * 0.85, length(dR))) * uRider.z;
  col *= mix(vec3(1.0), vec3(0.36, 0.48, 0.80), rsh);

  col = toSrgb(aces(col * uExposure));
  // fog capped at 0.85: distant terrain haze-shifts but NEVER merges fully
  // into the sky — the ridgeline silhouette survives at every distance
  // (compose round 3, "upper slope blows out into the sky")
  float fogF = 0.85 * smoothstep(uFogRange.x, uFogRange.y, vViewZ);
  gl_FragColor = vec4(mix(col, uFogCol, fogF), 1.0);
}
