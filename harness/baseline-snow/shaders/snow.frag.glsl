// Baseline snow fragment shader.
// - Wrap diffuse (NdotL + w)/(1 + w), w = 0.55 (SV-01 band 0.3-0.6).
// - Blue ambient so shadowed snow is blue, never black (SV-03).
// - Sparse view-dependent glints: per-cell random facet vs half-vector (SV-02).
// - Normals finite-differenced from the trail texture (SV-07 normals half),
//   layered on screen-space-derivative geometric normals.
// Output is linear light sRGB-encoded in-shader (no three.js tonemap chunks).
precision highp float;

uniform sampler2D uTrail;
uniform vec3 uSunDir;
uniform float uTrailHalf;
uniform float uMaxDepth;
uniform vec2 uTexel;        // 1 / texture resolution
uniform float uGlintThr;    // facet-alignment gate (tuned for 1-5% coverage)
varying vec3 vWorld;
varying vec2 vTrailUV;
varying float vInWin;
varying vec3 vNAttr;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  // attribute normals when the geometry has them; otherwise screen-space
  // derivatives of the (displaced) world pos (terrain chunks ship no normals).
  // Derivative normals break down on sub-4px triangles, so meshes that do
  // carry normals (e.g. probe geometry) must use them.
  vec3 n;
  if (dot(vNAttr, vNAttr) > 0.1) {
    n = normalize(vNAttr);
  } else {
    n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;
  }

  float depth = 0.0;
  if (vInWin > 0.5) {
    depth = texture2D(uTrail, vTrailUV).r;
    // finite-difference the trail texture for fine relighting inside trenches
    float hx1 = texture2D(uTrail, vTrailUV + vec2(uTexel.x, 0.0)).r;
    float hx0 = texture2D(uTrail, vTrailUV - vec2(uTexel.x, 0.0)).r;
    float hz1 = texture2D(uTrail, vTrailUV + vec2(0.0, uTexel.y)).r;
    float hz0 = texture2D(uTrail, vTrailUV - vec2(0.0, uTexel.y)).r;
    float texelWorld = 2.0 * uTrailHalf * uTexel.x;
    vec2 grad = vec2(hx1 - hx0, hz1 - hz0) * uMaxDepth / (2.0 * texelWorld);
    // surface y = base - d  =>  slope contribution is +grad on the normal
    n = normalize(n + vec3(grad.x, 0.0, grad.y) * 1.5);
  }

  vec3 L = normalize(uSunDir);
  float ndl = dot(n, L);
  float w = 0.55;
  float dif = clamp((ndl + w) / (1.0 + w), 0.0, 1.0);

  vec3 albedo = vec3(0.92) * (0.955 + 0.055 * hash(floor(vWorld * 8.0)));
  albedo = mix(albedo, albedo * vec3(0.82, 0.88, 1.0), clamp(depth * 1.5, 0.0, 0.6));

  vec3 sun = vec3(0.62);
  vec3 amb = vec3(0.34, 0.41, 0.475);   // skylight: blue shadows, ~0.4 luminance

  // glints: fixed random facet per ~3.3 cm cell, gated on alignment with the
  // sun/view half-vector -> sparse and strictly view-dependent
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Hv = normalize(L + V);
  vec3 cell = floor(vWorld * 30.0);
  vec3 fn = normalize(vec3(hash(cell) - 0.5, hash(cell + 11.0) * 0.5 + 0.5, hash(cell + 23.0) - 0.5));
  float glint = step(uGlintThr, dot(fn, Hv)) * step(0.25, dif) * 0.9;

  vec3 lin = albedo * (sun * dif + amb) + vec3(glint);
  vec3 srgb = pow(clamp(lin, 0.0, 1.0), vec3(1.0 / 2.2));
  gl_FragColor = vec4(srgb, 1.0);
}
