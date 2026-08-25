// Snow surface — fragment.
//  * Wrap diffuse (GPU Gems ch.16):  diff = (NdotL + w) / (1 + w), w = 0.42
//  * Blue-shifted ambient: fully shadowed snow stays saturated blue, never black
//  * Trail relighting: normals finite-differenced from the trail texture
//  * Sastrugi micro-normal: FBM-warped wind banding
//  * Journey-style glints: hash-cell facets gated on the half-vector, so the
//    sparkle population turns over as the camera moves (view-dependent)
// Output is linear light, exact-sRGB encoded at the end (the shader owns the
// whole pipeline; no three tonemap chunks run on ShaderMaterial).
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

  // ---- trail: depth + finite-difference gradient => relit trench walls ----
  float e = uTrailTexel;
  float dc = trailDepth(vWorld.xz);
  float gx = (trailDepth(vWorld.xz + vec2(e, 0.0)) - trailDepth(vWorld.xz - vec2(e, 0.0))) / (2.0 * e);
  float gz = (trailDepth(vWorld.xz + vec2(0.0, e)) - trailDepth(vWorld.xz - vec2(0.0, e))) / (2.0 * e);

  // ---- sastrugi micro-normal: two wind bandings warped by value noise ----
  float w1 = vnoise(vWorld.xz * 0.13);
  float b1 = sin(dot(vWorld.xz, vec2(0.90, -0.55)) * 1.7 + w1 * 6.0);
  float b2 = sin(dot(vWorld.xz, vec2(0.15, 1.00)) * 0.9 + w1 * 4.0);
  vec3 Ns = vec3(b1 * 0.9 + b2 * 0.4, 0.0, b1 * 0.35 - b2 * 0.8) * 0.045;

  vec3 N = normalize(Ng + vec3(gx, 0.0, gz) * 1.6 + Ns);

  // ---- wrap diffuse: (NdotL + w) / (1 + w) ----
  vec3 L = normalize(uSunDir);
  float NdotL = dot(N, L);
  float diff = clamp((NdotL + uWrap) / (1.0 + uWrap), 0.0, 1.0);

  // ---- albedo: bright snow, groomed piste ribbon, carved-groove blue ----
  vec3 alb = vec3(0.94, 0.94, 0.965);
  alb *= 1.0 + (vnoise(vWorld.xz * 2.3) - 0.5) * 0.06;
  float cxl = 150.0 * sin(vWorld.z * 0.0032) + 65.0 * sin(vWorld.z * 0.0011 + 1.7);
  float piste = 1.0 - smoothstep(9.0, 22.0, abs(vWorld.x - cxl));
  alb *= 1.0 + 0.03 * piste;
  float carve = smoothstep(0.01, 0.07, dc);
  alb = mix(alb, alb * vec3(0.74, 0.85, 1.04), carve);
  float ao = 1.0 - 0.5 * clamp(dc / uTrailDepthMax, 0.0, 1.0);

  vec3 col = alb * mix(uShadowCol, uLitCol, diff) * ao;

  // ---- glints: sparse hash-cell facets, half-vector gated ----
  // Density is clustered (drifts of sparkle, calm patches between) and the
  // sparkle dies where a cell's screen footprint gets big (grazing/far), so
  // it never smears into noise bars.
  vec3 H = normalize(L + V + vec3(1e-5));
  float h1 = hash12(floor(vWorld.xz / 0.042));
  float phi = atan(H.z, H.x) * 47.0 + acos(clamp(H.y, -1.0, 1.0)) * 31.0;
  float band = fract(h1 + phi * 0.15915494);
  float clus = 0.4 + 0.6 * smoothstep(0.35, 0.62, vnoise(vWorld.xz * 0.11));
  float dens = uGlintDensity * clus;
  float dist = length(cameraPosition - vWorld);
  float glint = 1.0 - smoothstep(dens * 0.7, dens, band);
  float foot = max(fwidth(vWorld.x), fwidth(vWorld.z));  // world m per pixel
  glint *= 1.0 - smoothstep(0.025, 0.06, foot);
  glint *= 1.0 - smoothstep(30.0, 60.0, dist);  // sparkle is a near-field effect
  glint *= smoothstep(0.08, 0.3, diff);         // only lit snow sparkles
  col += vec3(1.0, 1.0, 0.96) * glint * uGlintGain;

  // ---- aerial haze + encode ----
  col = mix(col, uFogColor, smoothstep(uFogNear, uFogFar, dist));
  col = clamp(col, 0.0, 1.0);
  gl_FragColor = vec4(srgbEncode(col), 1.0);
}
