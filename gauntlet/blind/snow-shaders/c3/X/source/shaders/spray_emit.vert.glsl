// Spray emission: one GL point per emitted particle, landing exactly on its
// slot's texel in the state textures. `position` carries the emit world pos.
attribute vec2 aNdc;
attribute vec3 aVel;
attribute float aLife;
attribute float aGround;
varying vec3 vPos;
varying vec3 vVel;
varying float vLife;
varying float vGround;
void main() {
  vPos = position;
  vVel = aVel;
  vLife = aLife;
  vGround = aGround;
  gl_Position = vec4(aNdc, 0.0, 1.0);
  gl_PointSize = 1.0;
}
