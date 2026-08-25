// candidate B — snow surface fragment shader
// Lighting recipe (GPU Gems ch.16 wrap diffuse + snowflow-style extras):
//   * wrap diffuse (NdotL + w)/(1 + w), w = uWrap (SV-01)
//   * hemispherical blue skylight ambient -> blue, never-black shadows (SV-03)
//   * cell-hash glints: sparse, threshold-gated, view-dependent, HDR pre-tonemap (SV-02)
//   * trench: albedo compression tint + finite-difference normals from the
//     trail texture so carved walls relight with the sun (SV-07 normals leg)
//   * depth-driven blue SSS back-scatter on berm lips
// Geometric normal comes from screen-space derivatives (terrain chunks carry
// no normal attribute; the harness probe sphere is tessellated coarsely enough
// that derivative normals shade correctly, per shader-page.html).
precision highp float;

uniform sampler2D uTrail;
uniform vec2 uTrailOrigin;
uniform float uTrailWorld;
uniform float uTexel;
uniform float uMaxDepth;
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

float trailD(vec2 w) {
  vec2 uv = (w - uTrailOrigin) / uTrailWorld;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) return 0.0;
  return texture2D(uTrail, uv).r;
}

vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Ng = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(Ng, V) < 0.0) Ng = -Ng;

  // ---- trench depth + normals finite-differenced from the trail texture ----
  float E = uTexel * 1.5;
  float h  = trailD(vWorld.xz);
  float hx = trailD(vWorld.xz + vec2(E, 0.0)) - trailD(vWorld.xz - vec2(E, 0.0));
  float hz = trailD(vWorld.xz + vec2(0.0, E)) - trailD(vWorld.xz - vec2(0.0, E));
  // surface y = y0 - D*h  =>  normal += (D*dh/dx, 0, D*dh/dz)
  vec3 N = normalize(Ng + vec3(uMaxDepth * hx / (2.0 * E), 0.0, uMaxDepth * hz / (2.0 * E)));

  vec3 L = normalize(uSunDir);

  // ---- course-line masks (centerline of the accepted terrain) --------------
  float cxLine = 150.0 * sin(vWorld.z * 0.0032) + 65.0 * sin(vWorld.z * 0.0011 + 1.7);
  float dLine = abs(vWorld.x - cxLine);
  float piste = 1.0 - smoothstep(10.0, 24.0, dLine);
  float rock = (1.0 - smoothstep(0.45, 0.62, Ng.y)) * smoothstep(30.0, 80.0, dLine);

  // ---- albedo: bright snow, sastrugi banding, groomed corduroy on piste ----
  float band = sin(dot(vWorld.xz, vec2(1.5, -1.05)) + vn(vWorld.xz * 0.07) * 6.0);
  float micro = vn(vWorld.xz * 0.55) * 2.0 - 1.0;
  float detail = 1.0 + 0.09 * micro + 0.06 * band * (1.0 - piste * 0.7)
               + 0.025 * sin((vWorld.x - cxLine) * 30.0) * piste;
  vec3 albedo = uAlbedo * detail;
  albedo = mix(albedo, vec3(0.42, 0.34, 0.28), rock);

  // strictly-vertical faces (LOD skirts, cut walls) get hue-neutral strata
  // banding so they read as carved snow walls instead of dead ambient facets
  float wall = 1.0 - smoothstep(0.03, 0.08, Ng.y);
  float strata = 0.5 + 0.5 * sin(vWorld.y * 2.1 + vn(vWorld.xz * 0.9) * 3.0);
  albedo = mix(albedo, albedo * (0.80 + 0.32 * strata), wall * (1.0 - rock));

  // trench interior: compressed snow reads bluer + occluded (carved groove)
  float tr = clamp(h * 3.0, 0.0, 0.9);
  albedo = mix(albedo, albedo * vec3(0.55, 0.70, 1.02), tr);
  albedo *= 1.0 - 0.36 * clamp(h * 2.2, 0.0, 1.0);

  // ---- lighting ------------------------------------------------------------
  // per-pixel NdotL dither breaks the hard facet boundaries of derivative
  // normals into snow-like grain instead of banding
  float ndl = dot(N, L) + (vn(vWorld.xz * 3.1) - 0.5) * 0.10;
  float dif = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);          // wrap diffuse
  // interior/underside views (camera near-clipping through a roller, skirt
  // backfaces): lift toward mid-lit so the cut reads as bright snow mass,
  // not a dead ambient slab. Terrain top faces are front-facing (verified).
  if (!gl_FrontFacing) dif = max(dif, 0.62);
  vec3 amb = uSkyCol * (0.55 + 0.45 * max(N.y, 0.0));                 // blue skylight
  vec3 col = albedo * (uSunCol * dif + amb);

  // specular: icier inside the packed trench
  vec3 Hv = normalize(L + V);
  col += uSunCol * pow(max(dot(N, Hv), 0.0), mix(30.0, 110.0, tr)) * (0.05 + 0.30 * tr);

  // blue SSS back-scatter, thickness driven by carve depth
  float back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0);
  col += vec3(0.45, 0.65, 1.0) * back * (0.06 + 2.8 * h) * 0.35;

  // ---- glints: sparse world-cell microfacets, threshold-gated --------------
  vec3 cell = mod(floor(vWorld * uGlint.x), 512.0);
  float keep = step(1.0 - uGlintRarity, h13(cell + 7.31));
  vec3 gN = normalize(N + (h33(cell) * 2.0 - 1.0) * uGlint.y);
  float alignG = max(dot(reflect(-L, gN), V), 0.0);
  float grz = 0.55 + 0.9 * pow(1.0 - max(dot(N, V), 0.0), 2.0);
  col += (1.0 - rock) * keep * step(uGlint.z, alignG) * uGlint.w * grz * vec3(1.05, 1.0, 0.95);

  col = toSrgb(aces(col * uExposure));
  float fogF = smoothstep(uFogRange.x, uFogRange.y, vViewZ);
  gl_FragColor = vec4(mix(col, uFogCol, fogF), 1.0);
}
