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
varying float vArcH;

float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec3 aces(vec3 x) { return clamp(x * (2.51 * x + 0.03) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

void main() {
  vec2 q = gl_PointCoord - 0.5;
  float d = length(q);
  float m;
  if (vPop > 0.5) {
    // chunk: jagged per-seed silhouette — radius wobbles with angle.
    // Cycle 5: SOLID interior (edge band only at the rim) — chunks are thrown
    // crud, not translucent puffs.
    float ang = atan(q.y, q.x);
    float rEdge = 0.46 * (0.68 + 0.20 * sin(ang * 3.0 + vSeed * 41.0)
                               + 0.12 * sin(ang * 7.0 + vSeed * 23.0));
    m = 1.0 - smoothstep(rEdge * 0.72, rEdge, d);
    float sp = h21(floor((q + 0.5) * 5.0) + vSeed * 13.7);
    m *= 0.88 + 0.24 * sp;                      // cratered face speckle
  } else {
    // mist: wide OPAQUE core, tight soft rim — a dense curtain, not fog
    m = 1.0 - smoothstep(0.30, 0.5, d);
    float sp = h21(floor((q + 0.5) * 6.0) + vSeed * 13.7);
    m *= 0.92 + 0.16 * sp;
  }
  // Cycle 5 (final critic pass, "translucent cotton puff"): the plume must be
  // an OPAQUE white wall at chase distance. Core alpha holds near 1.0 for most
  // of a particle's life and lets go only at the very end.
  // hold FULL opacity through most of life, then die fast: a slow linear fade
  // left a faint haze of big grown sprites at the plume's trailing edge that
  // washed the silhouette into the bright slope behind it
  float fade = (vPop < 0.5)
    ? smoothstep(0.0, 0.04, vLifeFrac) * (1.0 - smoothstep(0.55, 0.95, vLifeFrac))
    : (1.0 - vLifeFrac * vLifeFrac * vLifeFrac) * (1.0 - smoothstep(0.75, 1.0, vLifeFrac));
  float alpha = min(m * fade * 1.25, 1.0);
  if (alpha < 0.01) discard;
  float sunUp = 0.8 + 0.35 * max(uSunDir.y, 0.0);
  // Contrast against WHITE snow comes from SHADING, not whiteness: hot sunlit
  // top, deep sky-blue occluded underside, steep vertical gradient across the
  // sprite. Overlapping sprites then read as one shaded plume mass with a
  // bright crest and a blue belly (the SSX read).
  vec3 lit = vec3(1.72, 1.66, 1.52);
  vec3 shd = vec3(0.30, 0.48, 1.05);
  // three shading cues summed into one lit/shadow mix:
  //  * per-sprite vertical gradient (steep): every sprite has a hot cap and a
  //    blue underside, so the mass reads sunlit-from-above at any density;
  //  * per-seed tone: dark-vs-bright sprites interleave into the cauliflower
  //    cavity texture of churned snow (pure white-on-white washes out);
  //  * arc height: the rooster tail's crest catches sun, the base sits in
  //    its own occlusion.
  float seedT = h21(vec2(vSeed * 3.1, 9.2));
  float grad = clamp(0.55 * seedT + 0.30 * vArcH + (1.0 - d * 1.7) * 0.30
                     - q.y * 2.8 - 0.10, 0.0, 1.0);
  vec3 col = mix(shd, lit, grad) * sunUp;
  // cool rim: sprite edges pull sky-blue, so even the white crest keeps a
  // readable silhouette against white snow
  col *= mix(vec3(1.0), vec3(0.80, 0.88, 1.08), smoothstep(0.28, 0.5, d));
  col = toSrgb(aces(col * uExposure));
  gl_FragColor = vec4(col, alpha);
}
