// candidate B — spray particle fragment shader
// Two looks in one material: soft translucent mist curtain (pop 0) and
// hard-edged IRREGULAR chunky rooster-tail sprites (pop 1). Bright white core
// with a blue-shadowed underside so spray reads as lit snow against snow.
//
// Critique cycle 2 mustFix #2 ("uniform cotton puffs"): chunks now carve an
// irregular per-seed silhouette (angular radius wobble — every chunk a
// different jagged blob) and OPACITY FALLS with age for both populations, so
// the plume is dense and hard at the board contact and dissolves outward,
// reading as thrown snow rather than a cloud cluster.
precision highp float;

uniform vec3 uSunDir;
uniform float uExposure;

varying float vLifeFrac;
varying float vPop;
varying float vSeed;

float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  float m;
  if (vPop > 0.5) {
    // chunk: jagged per-seed silhouette — radius wobbles with angle
    float ang = atan(q.y, q.x);
    float rEdge = 0.46 * (0.68 + 0.20 * sin(ang * 3.0 + vSeed * 41.0)
                               + 0.12 * sin(ang * 7.0 + vSeed * 23.0));
    m = 1.0 - smoothstep(rEdge * 0.55, rEdge, d);
    float sp = h21(floor((q + 0.5) * 5.0) + vSeed * 13.7);
    m *= 0.75 + 0.45 * sp;                      // cratered face speckle
  } else {
    // mist: soft round dapple with a wide opaque core
    m = 1.0 - smoothstep(0.18, 0.5, d);
    float sp = h21(floor((q + 0.5) * 6.0) + vSeed * 13.7);
    m *= 0.85 + 0.30 * sp;
  }
  // opacity falloff over life (both populations), quick fade-in for mist.
  // Cycle 4 overshoot: peak opacities way up (0.50 -> 0.88 mist, chunks to
  // 1.0) — the curtain must read as an opaque white wall at chase distance,
  // dissolving only toward end of life. Cartoon plume, not physical mist.
  float fade = (vPop < 0.5)
    ? 0.95 * pow(1.0 - vLifeFrac, 0.9) * smoothstep(0.0, 0.05, vLifeFrac)
    : 1.00 * (1.0 - vLifeFrac * vLifeFrac);
  float alpha = m * fade;
  if (alpha < 0.01) discard;
  float sunUp = 0.8 + 0.35 * max(uSunDir.y, 0.0);
  // bright white core, strongly blue-shadowed lower half: the cool underside
  // is what makes white spray read against white snow (SSX spray separates
  // from the slope by its shadow tone, not its highlight)
  vec3 lit = vec3(1.60, 1.55, 1.46);
  vec3 shd = vec3(0.55, 0.68, 1.04);
  float grad = clamp(0.42 - q.y * 1.9 + (1.0 - d * 1.8) * 0.45, 0.0, 1.0);
  vec3 col = mix(shd, lit, grad) * sunUp;
  col = toSrgb(aces(col * uExposure));
  gl_FragColor = vec4(col, alpha);
}
