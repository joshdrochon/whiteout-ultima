// Spray GPGPU integrate — velocity texture (RGBA32F: xyz = velocity,
// w = spare). Gravity slightly under 9.81 (flake drag) + exponential air drag.
uniform sampler2D uVelTex;
uniform float uDt;
varying vec2 vUv;
void main() {
  vec4 v = texture2D(uVelTex, vUv);
  v.y -= 9.0 * uDt;
  v.xyz *= exp(-1.4 * uDt);
  gl_FragColor = v;
}
