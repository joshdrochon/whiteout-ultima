// GPU spray particles (SV-09/10/11).
// State lives entirely in vertex buffers (birth pos/vel/time/life); each
// frame the trajectory is integrated analytically ON THE GPU from birth
// state + uTime. The CPU only writes newly-emitted ring-buffer slots.
// 'position' attribute = birth position.
attribute vec3 aBirthVel;
attribute vec2 aBirth;      // birthTime, life
attribute float aKind;      // 0 = dense slow curtain, 1 = sparse fast ballistic
uniform float uTime;
varying float vFade;
varying float vKind;

void main() {
  float age = uTime - aBirth.x;
  if (age < 0.0 || aBirth.y <= 0.0 || age > aBirth.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vFade = 0.0; vKind = 0.0;
    return;
  }
  vec3 p = position + aBirthVel * age + vec3(0.0, -4.2, 0.0) * age * age; // floaty snow g/2
  vec4 mv = viewMatrix * vec4(p, 1.0);
  float lifeFrac = age / aBirth.y;
  vFade = 1.0 - lifeFrac;
  vKind = aKind;
  float size = mix(0.16, 0.06, aKind) * (1.0 + lifeFrac * 1.5 * (1.0 - aKind));
  gl_PointSize = clamp(size * 700.0 / max(1.0, -mv.z), 1.0, 24.0);
  gl_Position = projectionMatrix * mv;
}
