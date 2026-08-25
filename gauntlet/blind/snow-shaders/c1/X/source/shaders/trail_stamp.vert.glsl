// Trail stamp quad: placed in trail-UV space by uniforms.
uniform vec2 uCenterUV;
uniform float uRadiusUV;
varying vec2 vLocal;
void main() {
  vLocal = position.xy;
  vec2 uv = uCenterUV + position.xy * uRadiusUV;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
