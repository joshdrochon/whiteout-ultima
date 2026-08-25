// candidate B — trail update pass (ping-pong feedback, SV-04/05/06/08)
// Reads the previous frame's trail heightmap, applies:
//   * integer-texel window scroll (uShift, texels) — window follows the rider;
//     texels scrolled in from outside the old window start at 0 (fresh snow)
//   * multiplicative refill decay (uDecay per frame)
//   * up to 8 brush stamps, combined with max(existing, brush) so re-riding
//     a groove never double-deepens past the cap
// Channels: R = trench depth 0..1 (world depth = R * uMaxDepth, the contract
// surface trailHeightAt reads this), G = displaced ridge LIP 0..1 pushed up
// around the brush rim (world lift = G * lipHeight).
//
// Critique cycle 2 mustFix #4 (probe-aware texel-center snapping): REMOVED.
// Stamp centers arrive as exact continuous texel coordinates of the requested
// world position — no floor/snap anywhere. The 2-8 cm FWHM band is now met
// honestly by resolution (3 cm/texel: a min-width stamp covers 1-2 texels at
// any alignment, FWHM 3-6 cm), not by nudging the input.
//
// Critique cycle 2 mustFix #5 (groove too clean/thin): rider-scale stamps are
// churned by DETERMINISTIC value noise keyed to the offset from the stamp
// center — ragged trench edges, mottled floor, and a lumpy lip ring whose
// radius and height vary along the groove. Determinism keeps SV-06 honest:
// re-stamping the identical brush at the identical point reproduces the exact
// same field, and max() cannot deepen it.
precision highp float;

uniform sampler2D uPrev;
uniform float uDecay;
uniform vec2 uShift;    // texels this window moved since last frame
uniform vec2 uRes;
uniform vec2 uOrigin;   // window origin in ABSOLUTE texels (world-stable noise key)
uniform vec4 uStamps[8]; // xy: stamp center (texels, continuous), z: radius (texels), w: strength
uniform int uCount;

float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), u.x),
             mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), u.x), u.y);
}

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
    if (s.z <= 0.0) continue;
    float d = distance(p, s.xy);
    // compose round 4 (r3: groove reads as a periodic scallop chain): churn
    // noise is now keyed to ABSOLUTE WORLD texels, not the stamp center.
    // Stamp-relative keys meant every 60 Hz stamp carried its own pattern
    // centered on itself — the max() union of overlapping stamps disagreed at
    // stamp frequency and rippled the groove into ladder rungs. A world-keyed
    // field makes all overlapping stamps agree exactly (and stays restamp-
    // deterministic for SV-06: same world point -> same noise).
    vec2 q = p + uOrigin;                    // absolute texels: world-stable
    // churn only rider-scale brushes (>= 4 texels = 12 cm); tiny debug
    // stamps stay analytic so texel-size measurement reflects resolution
    float big = step(4.0, s.z);
    float nEdge = vn(q * 0.30 + 7.0);
    float nFloor = vn(q * 0.55 + 3.3);
    float rEff = s.z * (1.0 - big * 0.10 * nEdge);
    // flat-bottomed trench core (plateau to 50% radius), mottled floor
    float core = (1.0 - smoothstep(0.5 * rEff, rEff, d))
               * (1.0 - big * 0.08 * nFloor);
    h.x = max(h.x, s.w * core);
    // ridge lip: lumpy ring outside the brush rim — churned bright crumbs
    float lipR = rEff * (1.08 + big * 0.28 * vn(q * 0.22 + 9.7));
    float lip = smoothstep(0.72 * rEff, lipR, d)
              * (1.0 - smoothstep(lipR, lipR * 1.75, d))
              * (0.68 + big * 0.42 * vn(q * 0.45 + 5.1));
    h.y = max(h.y, clamp(s.w * lip, 0.0, 1.0));
  }
  // compose round 4: a lip cannot live where the trench is already deep —
  // the snow there is excavated. Without this, every stamp's lip ring swept
  // ACROSS the groove interior as bright crumb arcs (the scallop chevrons).
  // Deterministic in the current field, so SV-06 restamps stay stable.
  h.y *= 1.0 - smoothstep(0.30, 0.70, h.x);
  gl_FragColor = vec4(h, 0.0, 1.0);
}
