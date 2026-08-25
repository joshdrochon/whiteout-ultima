// candidate B — spray particle fragment shader
// Two looks in one material: soft translucent mist curtain (pop 0) and
// harder-edged chunky rooster-tail sprites (pop 1). Bright white core with a
// blue-shadowed underside so spray reads as lit snow, plus per-sprite speckle
// on chunks so they read as thrown crud, not bubbles.
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
  float rIn = mix(0.10, 0.28, vPop);
  float m = 1.0 - smoothstep(rIn, 0.5, d);
  // per-sprite speckle: chunky grains get a hard irregular edge, mist gets a
  // soft dapple so a dense curtain never fuses into a uniform slab
  float sp = h21(floor((q + 0.5) * 5.0) + vSeed * 13.7);
  m *= (vPop > 0.5) ? (0.55 + 0.7 * sp) : (0.72 + 0.45 * sp);
  float fade = (vPop < 0.5)
    ? 0.24 * (1.0 - vLifeFrac) * smoothstep(0.0, 0.06, vLifeFrac)
    : 0.92 * (1.0 - vLifeFrac * vLifeFrac);
  float alpha = m * fade;
  if (alpha < 0.01) discard;
  float sunUp = 0.8 + 0.35 * max(uSunDir.y, 0.0);
  // bright white core, gently blue-shadowed lower half
  vec3 lit = vec3(1.38, 1.36, 1.33);
  vec3 shd = vec3(0.78, 0.86, 1.04);
  float grad = clamp(0.5 - q.y * 1.6 + (1.0 - d * 1.8) * 0.5, 0.0, 1.0);
  vec3 col = mix(shd, lit, grad) * sunUp;
  col = toSrgb(aces(col * uExposure));
  gl_FragColor = vec4(col, alpha);
}
