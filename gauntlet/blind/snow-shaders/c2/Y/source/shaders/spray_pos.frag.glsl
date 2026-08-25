// Spray GPGPU integrate — position/life texture (RGBA32F: xyz = world pos,
// w = remaining life in s).
uniform sampler2D uPosTex;
uniform sampler2D uVelTex;
uniform float uDt;
varying vec2 vUv;
void main() {
  vec4 p = texture2D(uPosTex, vUv);
  vec4 v = texture2D(uVelTex, vUv);
  if (p.w > 0.0) {
    p.xyz += v.xyz * uDt;
    p.w -= uDt;
  }
  gl_FragColor = p;
}
