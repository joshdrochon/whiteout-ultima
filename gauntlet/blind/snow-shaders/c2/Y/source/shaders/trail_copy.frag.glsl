// Trail ping-pong scroll pass: re-centers the rider-following window by a
// whole-texel offset. Newly exposed area reads 0 (fresh snow). uDecay is the
// multiplicative refill hook (held at 1.0 — documented arcade choice: trails
// persist for the whole run).
uniform sampler2D uSrc;
uniform vec2 uOffset;
uniform float uDecay;
varying vec2 vUv;
void main() {
  vec2 uv = vUv + uOffset;
  float inb = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  gl_FragColor = texture2D(uSrc, uv) * inb * uDecay;
}
