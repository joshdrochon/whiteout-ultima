// Soft round snow-spray sprite, cool white.
varying float vAlpha;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0 || vAlpha <= 0.004) discard;
  gl_FragColor = vec4(0.95, 0.98, 1.0, vAlpha * (1.0 - r2));
}
