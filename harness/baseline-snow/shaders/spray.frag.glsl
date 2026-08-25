// Soft round spray sprite.
precision mediump float;
varying float vFade;
varying float vKind;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;
  float a = (1.0 - r2 * 4.0) * vFade * mix(0.55, 0.9, vKind);
  gl_FragColor = vec4(0.97, 0.985, 1.0, a);
}
