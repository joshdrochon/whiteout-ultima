// candidate B — trail update pass (ping-pong feedback, SV-04/05/06/08)
// Reads the previous frame's trail heightmap, applies:
//   * integer-texel window scroll (uShift, texels) — window follows the rider;
//     texels scrolled in from outside the old window start at 0 (fresh snow)
//   * multiplicative refill decay (uDecay per frame)
//   * up to 8 brush stamps, combined with max(existing, brush) so re-riding
//     a groove never double-deepens past the cap
// Depth is stored normalized 0..1 in R; world depth = value * uMaxDepth.
precision highp float;

uniform sampler2D uPrev;
uniform float uDecay;
uniform vec2 uShift;    // texels this window moved since last frame
uniform vec2 uRes;
uniform vec4 uStamps[8]; // xy: stamp center (texels), z: radius (texels), w: strength
uniform int uCount;

void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 prevUv = (p + uShift) / uRes;
  float h = 0.0;
  if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0)
    h = texture2D(uPrev, prevUv).r;
  h *= uDecay;
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec4 s = uStamps[i];
    h = max(h, s.w * (1.0 - smoothstep(0.0, s.z, distance(p, s.xy))));
  }
  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}
