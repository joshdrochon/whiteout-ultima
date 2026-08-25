// Snow surface — fragment stage.
//  * wrap-lighting diffuse (NdotL + w)/(1 + w) — cheap SSS foundation
//  * blue skylight ambient: shadows resolve blue, never gray/black
//  * sparse view-dependent cell-hash glints, threshold-gated, HDR (pre-tonemap
//    output well above 1.0 so the sparkle survives ACES)
//  * trail relight: normals finite-differenced from the trail heightmap, so
//    trench walls catch/lose sun; trench interior packs blue and darkens
//  * back-scatter SSS gated on trail depth (berms/lips glow blue when backlit)
// Geometric normal from screen-space derivatives (terrain carries no normal
// attribute; the probe sphere is tessellated coarsely enough for dFdx normals).

uniform sampler2D uTrail;
uniform vec2  uRider;
uniform float uWindow;
uniform float uBand;
uniform float uMaxDepth;
uniform float uTexel;        // trail texel size in meters
uniform vec3  uSunDir;       // unit vector TOWARD the sun
uniform vec3  uSunColor;
uniform vec3  uSkyColor;     // blue skylight ambient (drives shadow color)
uniform float uWrap;         // wrap-lighting w, 0.3..0.6
uniform float uAlbedoMix;    // how much baked vertex color tints the albedo
uniform float uGlintDensity; // glint cells per meter
uniform float uGlintProb;    // fraction of cells firing for a given view
uniform float uGlintViewQ;   // view-direction quantization (twinkle rate)
uniform float uGlintGain;    // HDR sparkle gain (pre-tonemap, > 1)
uniform float uSssStrength;
uniform vec3  uFogColor;
uniform vec2  uFogRange;

varying vec3  vWorld;
varying vec3  vColor;
varying float vDepth;

// compact 2->1 / 2->3 hashes (Dave Hoskins style, texture-free)
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}

float trailDepth(vec2 xz) {
  vec2 d = xz - uRider;
  if (max(abs(d.x), abs(d.y)) > 0.5 * uWindow - uBand) return 0.0;
  return min(texture2D(uTrail, fract(xz / uWindow)).r, uMaxDepth);
}

void main() {
  vec3 V = normalize(cameraPosition - vWorld);
  vec3 Ng = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  if (dot(Ng, V) < 0.0) Ng = -Ng;                 // double-sided robustness

  // --- trench normals: central finite differences of the trail heightmap ---
  float e  = uTexel;
  float gx = trailDepth(vWorld.xz + vec2(e, 0.0)) - trailDepth(vWorld.xz - vec2(e, 0.0));
  float gz = trailDepth(vWorld.xz + vec2(0.0, e)) - trailDepth(vWorld.xz - vec2(0.0, e));
  // surface y = base - h  =>  normal += (dh/dx, 0, dh/dz)
  vec3 N = normalize(Ng + vec3(gx, 0.0, gz) * (0.85 / (2.0 * e)));

  vec3 L = normalize(uSunDir);
  float ndl   = dot(N, L);
  float wrapD = clamp((ndl + uWrap) / (1.0 + uWrap), 0.0, 1.0);
  float depth01 = vDepth / uMaxDepth;

  // albedo: high-key snow white pulled toward the baked track palette
  vec3 albedo = mix(vec3(1.0), clamp(vColor, 0.0, 2.0) * 0.78, uAlbedoMix);
  albedo *= mix(vec3(1.0), vec3(0.80, 0.88, 1.04), depth01 * 0.85); // packed snow blues
  albedo *= (1.0 - 0.20 * depth01);                                 // trench darkens

  float hemi = 0.75 + 0.25 * max(N.y, 0.0);
  vec3 col = albedo * (uSunColor * wrapD + uSkyColor * hemi);

  // back-scatter SSS through carved lips/berms only (thickness ~ trail depth)
  float back = pow(clamp(dot(V, -L), 0.0, 1.0), 3.0);
  col += back * depth01 * uSssStrength * vec3(0.45, 0.65, 1.10);

  // --- sparse HDR glints: world-space cells; each cell's microfacet fires for
  //     a narrow set of view directions (view direction quantized into the
  //     hash), so sparkle re-rolls as the camera moves — strongly
  //     view-dependent, static for a static camera, sparse by construction.
  vec2 cell = floor(vWorld.xz * uGlintDensity);
  if (wrapD > 0.25) {
    vec2 vb = floor(V.xz * uGlintViewQ);
    float tw = hash12(cell * 1.371 + vb * 57.77);
    if (tw < uGlintProb) {
      float dist = length(cameraPosition - vWorld);
      float fade = smoothstep(140.0, 50.0, dist); // no subpixel shimmer at range
      float shine = 0.7 + 0.6 * hash12(cell + 3.33);
      col += uGlintGain * shine * fade * vec3(1.0, 0.98, 0.92);
    }
  }

  // distance haze to sit with the scene's aerial fog
  float fogT = clamp((length(cameraPosition - vWorld) - uFogRange.x) /
                     (uFogRange.y - uFogRange.x), 0.0, 1.0);
  col = mix(col, uFogColor, fogT);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
