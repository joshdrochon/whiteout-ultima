// Trail ping-pong update pass (SV-04/05/06/08).
// Reads the previous frame's trail state (shifted when the window recenters
// on the rider), applies multiplicative refill decay, and max()-merges this
// frame's stamps so re-riding never double-deepens (SV-06).
precision highp float;

uniform sampler2D uPrev;
uniform vec2 uShift;        // new-uv -> old-uv offset (window scroll)
uniform float uDecay;       // per-frame multiplicative refill (0.9999)
uniform int uStampCount;
uniform vec4 uStamps[16];   // x, z, radius (m), depth (0..1 trail units)
uniform vec2 uCenter;       // world xz of window center
uniform float uHalf;        // window half-extent (m)
uniform float uMinRadius;   // one texel, so tiny debug stamps still land
varying vec2 vUv;

void main() {
  vec2 old = vUv + uShift;
  float h = 0.0;
  if (old.x > 0.0 && old.x < 1.0 && old.y > 0.0 && old.y < 1.0) h = texture2D(uPrev, old).r;
  h *= uDecay;
  vec2 wxz = (vUv - 0.5) * (2.0 * uHalf) + uCenter;
  for (int i = 0; i < 16; i++) {
    if (i >= uStampCount) break;
    vec4 s = uStamps[i];
    float r = length(wxz - s.xy);
    float b = s.w * (1.0 - smoothstep(0.0, max(s.z, uMinRadius), r));
    h = max(h, b);
  }
  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}
