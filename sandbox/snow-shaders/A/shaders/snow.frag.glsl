// Snow surface — fragment.
//  * Wrap diffuse (GPU Gems ch.16):  diff = (NdotL + w) / (1 + w), w = 0.42
//  * Blue-shifted ambient: fully shadowed snow stays saturated blue, never black
//  * Trail relighting: normals finite-differenced from the trail texture,
//    dark saturated-blue trench interior + brightened ridge lips
//  * Sastrugi micro-normal: FBM-warped wind banding, faded by pixel footprint
//  * Journey-style glints: hash-cell facets gated on the half-vector, so the
//    sparkle population turns over as the camera moves (view-dependent)
//  * Steep off-course faces shade as cool blue-grey rock strata (never warm
//    sandstone), and far diffuse contrast is compressed so coarse-LOD facets
//    stop reading as terraced steps.
// Output is linear light, exact-sRGB encoded at the end (the shader owns the
// whole pipeline; no three tonemap chunks run on ShaderMaterial).
//
// CRITIQUE cycle-1 responses (snow-visuals lane):
//  [C1] "trail is a faint pencil line" — rider stamps are now 0.55-1.2 m wide
//       and 0.11-0.18 m deep (attach.mjs), trench interior drops to a dark
//       saturated blue (x0.50 R) with 65% AO at full depth, walls get a 2.3x
//       finite-difference normal so they light/shadow like a real groove, and
//       the groove rim gets an explicit sunlit-lip brighten (see uLip below).
//       Geometric raised lips are rebutted: terrain vertices are ~2.6 m apart
//       (render-loop LOD0), which cannot resolve a 15 cm berm — the lip must
//       live in shading, which is also all a chase camera can resolve.
//  [C2] spray anchoring is an attach.mjs change (see emission block there).
//  [C3] "rock albedo (0.42,0.34,0.28) reads sandstone" — that warm triplet is
//       not ours (cycle-1 A had no rock at all, part of why it read washed).
//       Rock added here is deliberately COOL: (0.40,0.44,0.53) blue-grey with
//       horizontal strata, per the critique's own SSX direction.
//  [C4] "stepped voxel terracing on steep shadowed faces" — two causes, two
//       fixes: (a) coarse-LOD facet shading is compressed with distance
//       (farFade below) so per-facet NdotL steps flatten into aerial haze;
//       (b) near-vertical off-course faces (chunk skirts included) now key to
//       rock strata, so the residual banding reads as cliff bands, not broken
//       snow.
//  [C5] "washed pastel, near-zero color contrast" — shadow color deepened to
//       a more saturated blue (B/R excess ~0.56, top of the SV-03 band) and
//       darkened to the LOW end of the 35-55% luminance band (~0.41, per the
//       cycle-2 note), lit snow warmed to sun-white, groomed piste ribbon
//       tinted cyan (corduroy stripes cut — see inline note), and the
//       material's aerial haze pulled nearer + shifted to saturated alpine
//       blue so far terrain separates from near snow in hue, not just value.
//
// CRITIQUE cycle-3 (this cycle): the mid-distance "white confetti blocks" and
// "rice dashes" were traced to the GLINT system, not spray (proven by a
// uGlintGain=0 A/B render): gain-clamped facet dots clipped by their cell
// boundary rendered as flat-white parallelograms, and oblique views smeared
// dots into multi-px dashes. Fixed by: smaller cells (6 cm), per-cell
// brightness jitter, a dens ceiling, and a screen-space-round dot (cell-local
// coord scaled by the per-axis pixel footprint ratio) — sparkle is now a
// 1-3 px point at every range and view angle.
uniform vec3 uSunDir;
uniform vec3 uLitCol;
uniform vec3 uShadowCol;
uniform float uWrap;
uniform sampler2D uTrail;
uniform vec2 uTrailCenter;
uniform float uTrailSize;
uniform float uTrailDepthMax;
uniform float uTrailTexel;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uGlintDensity;
uniform float uGlintGain;

varying vec3 vWorld;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float trailDepth(vec2 xz) {
  vec2 uv = (xz - uTrailCenter) / uTrailSize + 0.5;
  vec2 m2 = smoothstep(vec2(0.0), vec2(0.02), uv)
          * (1.0 - smoothstep(vec2(0.98), vec2(1.0), uv));
  return texture2D(uTrail, uv).r * uTrailDepthMax * m2.x * m2.y;
}
vec3 srgbEncode(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  // geometric normal from screen-space derivatives (post-displacement)
  vec3 Ng = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(Ng, V) < 0.0) Ng = -Ng;
  float dist = length(cameraPosition - vWorld);
  float foot = max(fwidth(vWorld.x), fwidth(vWorld.z));  // world m per pixel

  // ---- trail: depth + finite-difference gradient => relit trench walls ----
  float e = uTrailTexel;
  float dc = trailDepth(vWorld.xz);
  float gx = (trailDepth(vWorld.xz + vec2(e, 0.0)) - trailDepth(vWorld.xz - vec2(e, 0.0))) / (2.0 * e);
  float gz = (trailDepth(vWorld.xz + vec2(0.0, e)) - trailDepth(vWorld.xz - vec2(0.0, e))) / (2.0 * e);
  float gmag = length(vec2(gx, gz));

  // ---- sastrugi micro-normal: two wind bandings warped by value noise ----
  // Faded by pixel footprint [C4]: at distance the ~4 m banding aliases into
  // strata lines on steep faces, so it dies before it can.
  float detFade = 1.0 - smoothstep(0.05, 0.18, foot);
  float w1 = vnoise(vWorld.xz * 0.13);
  float b1 = sin(dot(vWorld.xz, vec2(0.90, -0.55)) * 1.7 + w1 * 6.0);
  float b2 = sin(dot(vWorld.xz, vec2(0.15, 1.00)) * 0.9 + w1 * 4.0);
  // patchy amplitude: coherent sine fields read as a striped "fan" on smooth
  // walls — real sastrugi comes in wind-scoured patches, so gate the bands
  // with a broad noise mask
  float sasPatch = 0.25 + 1.05 * vnoise(vWorld.xz * 0.045 + 31.7);
  vec3 Ns = vec3(b1 * 0.9 + b2 * 0.4, 0.0, b1 * 0.35 - b2 * 0.8) * (0.032 * sasPatch * detFade);

  // ---- smooth analytic terrain normal [C4] --------------------------------
  // The render loop's terrain is closed-form: linear descent + z-rollers + a
  // gully parabola around the course line. Its smooth gradient is
  // reconstructable here, and blending the per-triangle dFdx normal toward it
  // with pixel footprint removes the facet-alternation moire fan ("stepped
  // terracing") that flat-shaded 2.6 m triangles paint on mid-distance walls.
  // (FBM/ridge components are omitted: they matter on far peaks, which read
  // through rock albedo + silhouette, not diffuse detail.)
  float cxl = 150.0 * sin(vWorld.z * 0.0032) + 65.0 * sin(vWorld.z * 0.0011 + 1.7);
  float sCourse = vWorld.x - cxl;
  float dCourse = abs(sCourse);
  float dcxdz = 0.48 * cos(vWorld.z * 0.0032) + 0.0715 * cos(vWorld.z * 0.0011 + 1.7);
  float gullyOn = 1.0 - smoothstep(300.0, 350.0, dCourse);   // parabola clamps at 430 m height
  float dhdx = 0.007 * sCourse * gullyOn;
  float dhdz = -0.42 + 0.117 * cos(vWorld.z * 0.0045 + 0.8)
             + 0.088 * cos(vWorld.z * 0.011 + 3.1)
             - dhdx * dcxdz;
  vec3 Nsm = normalize(vec3(-dhdx, 1.0, -dhdz));
  // blend to smooth ONLY where the analytic gradient is valid (inside the
  // gully zone); far off-course peaks keep faceted normals — their crisp
  // facets + rock strata read as mountains, and smoothing them just bleaches
  float kSm = smoothstep(0.04, 0.15, foot) * gullyOn;
  vec3 Ngeo = normalize(mix(Ng, Nsm, kSm));

  // trench walls get a 2.3x gradient normal [C1] — chunky carved-groove shading
  vec3 N = normalize(Ngeo + vec3(gx, 0.0, gz) * 2.3 + Ns);

  // rock key (used by both albedo and the anti-moire diffuse pin below):
  // smoothed-where-valid normal — keying the raw facet normal striped
  // mid-distance gully walls with snow/rock moire [C4]
  float rockKeyY = mix(Ng.y, Nsm.y, kSm);
  float rock = (1.0 - smoothstep(0.45, 0.62, rockKeyY)) * smoothstep(45.0, 90.0, dCourse);

  // ---- wrap diffuse: (NdotL + w) / (1 + w) ----
  vec3 L = normalize(uSunDir);
  float NdotL = dot(N, L);
  float diff = clamp((NdotL + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  // far terrain: compress diffuse contrast into aerial haze
  float farFade = smoothstep(500.0, 2500.0, dist);
  diff = mix(diff, 0.42 + 0.50 * diff, farFade);
  // off-gully SNOW slabs beyond the analytic normal's validity keep faceted
  // dFdx normals, whose 15-30 m LOD facets fan into radial moire at 400+ m —
  // pin their diffuse flat and let fog + albedo carry them. Rock is exempt:
  // faceted shading is exactly what makes distant crags read [C4].
  diff = mix(diff, 0.72,
             (1.0 - rock) * (1.0 - gullyOn) * 0.85 * smoothstep(0.15, 0.45, foot));

  // ---- albedo: bright snow, groomed piste ribbon, cool rock, carved blue --
  vec3 alb = vec3(0.94, 0.945, 0.97);
  // micro albedo noise: lattice ROTATED off the world axes and distance-gated.
  // Un-rotated value noise has axis-aligned lattice columns (0.43 m pitch)
  // that perspective-project into the radial "fan" banding on oblique walls —
  // the last of the cycle-1 terracing/strata artifacts [C4].
  vec2 rxz = mat2(0.891, -0.454, 0.454, 0.891) * vWorld.xz;
  float albFade = detFade * (1.0 - smoothstep(25.0, 60.0, dist));
  alb *= 1.0 + (vnoise(rxz * 2.3) - 0.5) * 0.06 * albFade;
  // groomed piste ribbon: cyan-shifted with corduroy micro-banding [C5]
  float piste = 1.0 - smoothstep(9.0, 22.0, dCourse);
  // corduroy has a 30 cm period: it needs its own tight footprint fade or it
  // aliases into radial moire bands on the up-slope view
  // corduroy stripes were CUT after critique iteration: a 30 cm sine band on
  // any camera-facing piste roll perspective-fans into radial banding that
  // reads as an artifact (the cycle-1 "terracing" note traced to exactly
  // this). The groomed ribbon keeps its cyan tint; groove/sparkle carry the
  // track identity instead.
  alb = mix(alb, alb * vec3(0.95, 1.0, 1.03), piste);
  // steep off-course faces: cool blue-grey rock strata, never sandstone [C3]
  // (gated 45 m+ off the course line so the harness probe sphere, which sits
  // on the course, never picks up rock on its equator)
  float strata = 0.82 + 0.36 * vnoise(vec2(vWorld.y * 0.35, (vWorld.x + vWorld.z) * 0.02));
  alb = mix(alb, vec3(0.40, 0.44, 0.53) * strata, rock);
  // minification albedo damping [C4]: the rock key rides the per-facet dFdx
  // normal, so on mid-distance slopes facets flicker across the threshold and
  // stripe snow/rock albedo into a radial moire fan. Pull the albedo toward a
  // neutral alpine grey as facets approach pixel scale — crags keep their
  // cool identity, the stripe contrast collapses.
  alb = mix(alb, vec3(0.72, 0.75, 0.82), 0.25 * smoothstep(0.25, 0.8, foot));
  // carved trench: dark saturated blue interior + AO, sunlit rim lips [C1]
  // [D5] cycle-2 "groove is clean and thin; SSX trails are chunky with
  // churned bright lips": two-octave churn noise now (a) raggeds the carve
  // boundary so the groove edge is torn, not vector-clean, (b) breaks the
  // trench interior into light/dark chunks of thrown snow, and (c) modulates
  // a stronger lip brighten so the rim reads as churned bright crumbs. The
  // stamps themselves are also width/offset-jittered in attach.mjs.
  float churn = vnoise(vWorld.xz * 3.3) * 0.65 + vnoise(vWorld.xz * 9.7) * 0.35;
  float carve = smoothstep(0.008, 0.06, dc * (0.70 + 0.60 * churn));
  alb = mix(alb, alb * vec3(0.40, 0.58, 1.04), carve);
  alb *= 1.0 + (churn - 0.5) * 0.16 * carve;
  float ao = 1.0 - 0.72 * clamp(dc / uTrailDepthMax, 0.0, 1.0);
  float lip = smoothstep(0.30, 1.0, gmag) * (1.0 - 0.85 * carve);
  alb *= 1.0 + (0.28 + 0.38 * churn) * lip;

  vec3 col = alb * mix(uShadowCol, uLitCol, diff) * ao;

  // ---- glints: sparse hash-cell facets, half-vector gated ----
  // Density is clustered (drifts of sparkle, calm patches between) and the
  // sparkle dies where a cell's screen footprint gets big (grazing/far), so
  // it never smears into noise bars.
  vec3 H = normalize(L + V + vec3(1e-5));
  vec2 cell = floor(vWorld.xz / 0.06);
  float h1 = hash12(cell);
  float phi = atan(H.z, H.x) * 47.0 + acos(clamp(H.y, -1.0, 1.0)) * 31.0;
  float band = fract(h1 + phi * 0.15915494);
  // soft cluster contrast: drifts of sparkle with calmer snow between.
  // cycle-3: floor raised 0.15->0.35 and the distance boost cut 6.0->2.2 with
  // a hard dens ceiling — at the old settings, cluster cores near 20 m hit a
  // per-cell fire rate of ~0.84, so ADJACENT 9 cm cells fired together and
  // fused into scattered white rectangles (the "confetti" blocks visible in
  // mid-distance probe frames — they were glint blobs, not spray). Capping
  // the rate keeps every glint a discrete point at any range.
  float clus = 0.35 + 0.65 * smoothstep(0.40, 0.65, vnoise(vWorld.xz * 0.11));
  // distance-compensated density: a facet dot covers ever fewer pixels with
  // range, so the firing rate rises to keep sparkle-per-screen-area roughly
  // constant — near snow stays sparse and clean, mid-range still shimmers
  float densBoost = 1.0 + 2.2 * smoothstep(8.0, 25.0, dist);
  float dens = min(uGlintDensity * clus * densBoost, 0.75);
  float glint = 1.0 - smoothstep(dens * 0.7, dens, band);
  // a glint is a sub-cell POINT facet, not the whole 9 cm cell: without this
  // shaping, near-field cells render as opaque white squares (the cycle-1
  // "confetti" artifact). Facet center is hash-jittered inside the cell.
  // cycle-3: dot radius cut 0.30->0.16 cell units and brightness jittered per
  // cell — at the old radius, a gain-clamped dot clipped by its cell boundary
  // rendered as a hard-edged flat-white parallelogram (~10x5 px at 20 m), the
  // true source of the mid-distance "white confetti blocks". A 2-3 px soft
  // dot with a white core reads as sparkle at every range instead.
  vec2 fc = fract(vWorld.xz / 0.06)
          - vec2(0.25 + 0.5 * hash12(cell + 7.3), 0.25 + 0.5 * hash12(cell + 3.1));
  // screen-round dot: under an oblique camera one world axis projects to far
  // fewer pixels than the other, so a world-round dot smears into a DASH and
  // rows of firing cells chain into "rice litter". Stretching the cell-local
  // coordinate by the per-axis footprint ratio makes every dot round IN
  // SCREEN SPACE (~2 px), so sparkle stays a point at any view angle.
  float fax = max(fwidth(vWorld.x), 1e-6), faz = max(fwidth(vWorld.z), 1e-6);
  vec2 fscale = vec2(fax, faz) / min(fax, faz);
  glint *= 1.0 - smoothstep(0.04, 0.175, length(fc * fscale));
  glint *= 0.55 + 0.45 * hash12(cell + 11.7);
  glint *= 1.0 - smoothstep(0.02, 0.045, foot); // subpixel cells alias; kill early
  glint *= 1.0 - smoothstep(30.0, 60.0, dist);  // sparkle is a near-field effect
  glint *= smoothstep(0.55, 0.75, diff);        // only sun-facing snow sparkles
  glint *= 1.0 - rock;                          // rock does not sparkle
  glint *= 1.0 + 1.6 * carve;                   // packed trench snow is icier
  col += vec3(1.0, 1.0, 0.96) * glint * uGlintGain;

  // ---- aerial haze + encode: saturated alpine blue, pulled nearer [C5] ----
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(srgbEncode(col), 1.0);
}
