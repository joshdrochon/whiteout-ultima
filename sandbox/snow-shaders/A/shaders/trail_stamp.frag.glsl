// Radial brush, written with MAX blending (SV-06: max(existing, brush) —
// re-stamping the same spot can never double-deepen).
// Falloff 1 - r^2 puts half-depth at r = 0.707 => FWHM equals the brush width.
uniform float uVal;
varying vec2 vLocal;
void main() {
  float f = max(0.0, 1.0 - dot(vLocal, vLocal));
  gl_FragColor = vec4(uVal * f, 0.0, 0.0, 1.0);
}
