// Trail sim — ping-pong heightmap update (read frame N, write frame N+1).
// R channel = carve depth in METERS. Toroidal world-XZ addressing: uv is
// world/window mod 1, texels are unwrapped relative to the rider so the
// window follows the rider; a thin band at the wrap seam is cleared each
// frame so stale trail from one window-length away never resurfaces.
// Refill: multiplicative decay (0.9999/frame @60 => minutes-scale, snowflow).
// Stamps: max(existing, brush) with smoothstep falloff — re-riding a spot
// can never double-deepen past the brush cap.

uniform sampler2D uPrev;
uniform vec2  uRider;       // rider world XZ
uniform float uWindow;      // window size (m)
uniform float uBand;        // seam clearing band (m)
uniform float uDecay;       // per-frame multiplicative refill
uniform int   uNum;         // live stamps this frame
uniform vec4  uStamps[16];  // xy = world XZ, z = brush radius (m), w = depth (m)

varying vec2 vUv;

void main() {
  vec2 base  = vUv * uWindow;
  vec2 delta = mod(base - uRider + 0.5 * uWindow, uWindow) - 0.5 * uWindow;
  vec2 world = uRider + delta;

  float h = texture2D(uPrev, vUv).r * uDecay;

  for (int i = 0; i < 16; i++) {
    if (i >= uNum) break;
    vec4 s = uStamps[i];
    float d = distance(world, s.xy);
    h = max(h, s.w * (1.0 - smoothstep(0.0, s.z, d)));
  }

  if (max(abs(delta.x), abs(delta.y)) > 0.5 * uWindow - uBand) h = 0.0;

  gl_FragColor = vec4(h, 0.0, 0.0, 1.0);
}
