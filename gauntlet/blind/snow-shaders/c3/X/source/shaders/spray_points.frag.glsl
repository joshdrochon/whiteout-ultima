// Soft round snow-spray sprite, cool white. Denser core + soft skirt so the
// plume reads as one opaque mass near the board instead of confetti [C2].
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0 || vAlpha <= 0.004) discard;
  float f = (1.0 - r2) * (1.0 - r2 * 0.45);
  gl_FragColor = vec4(0.96, 0.99, 1.0, vAlpha * f);
}
