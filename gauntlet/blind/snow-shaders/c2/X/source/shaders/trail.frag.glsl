// candidate B — trail update pass (ping-pong feedback, SV-04/05/06/08)
// Reads the previous frame's trail heightmap, applies:
//   * integer-texel window scroll (uShift, texels) — window follows the rider;
//     texels scrolled in from outside the old window start at 0 (fresh snow)
//   * multiplicative refill decay (uDecay per frame)
//   * up to 8 brush stamps, combined with max(existing, brush) so re-riding
//     a groove never double-deepens past the cap
// Channels: R = trench depth 0..1 (world depth = R * uMaxDepth, the contract
// surface trailHeightAt reads this), G = displaced ridge LIP 0..1 pushed up
// around the brush rim (world lift = G * lipHeight). The lip is what makes a
// chase-camera trail read as a carved groove with walls, not a pencil line
// (critique cycle 1, mustFix #1). The lip stamp is a ring just outside the
// brush core; it is also max-combined and decays with the same refill, so it
// inherits every cap/persistence property the depth channel is gated on.
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
  vec2 h = vec2(0.0);
  if (prevUv.x >= 0.0 && prevUv.x <= 1.0 && prevUv.y >= 0.0 && prevUv.y <= 1.0)
    h = texture2D(uPrev, prevUv).rg;
  h *= uDecay;
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    vec4 s = uStamps[i];
    float d = distance(p, s.xy);
    // flat-bottomed trench core: full strength to 55% of the radius, then
    // smooth falloff — a plateau profile stays readable at gameplay distance
    h.x = max(h.x, s.w * (1.0 - smoothstep(0.55 * s.z, s.z, d)));
    // ridge lip: ring from the brush rim to ~1.7 r, peaked just outside it
    float lip = smoothstep(0.75 * s.z, 1.05 * s.z, d)
              * (1.0 - smoothstep(1.05 * s.z, 1.7 * s.z, d));
    h.y = max(h.y, s.w * lip);
  }
  gl_FragColor = vec4(h, 0.0, 1.0);
}
