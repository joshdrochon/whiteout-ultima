// Baseline snow vertex shader.
// Displaces vertices downward by the trail heightmap (SV-07 geometry half).
// Works on any geometry (terrain chunks, probe meshes): displacement is a
// pure function of WORLD xz, sampled from the windowed trail texture.
uniform sampler2D uTrail;
uniform vec2 uTrailCenter;   // world xz of the trail window center
uniform float uTrailHalf;    // half-extent of the window (m)
uniform float uMaxDepth;     // trail depth at texture value 1.0 (m)
varying vec3 vWorld;
varying vec2 vTrailUV;
varying float vInWin;
varying vec3 vNAttr;   // world-space attribute normal; zero when the geometry
                       // has no normal attribute (the terrain chunks don't)

void main() {
  vNAttr = mat3(modelMatrix) * normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 tuv = (wp.xz - uTrailCenter) / (2.0 * uTrailHalf) + 0.5;
  float inWin = step(0.002, tuv.x) * step(tuv.x, 0.998) * step(0.002, tuv.y) * step(tuv.y, 0.998);
  float d = texture2D(uTrail, tuv).r * uMaxDepth * inWin;
  wp.y -= d;
  vWorld = wp.xyz;
  vTrailUV = tuv;
  vInWin = inWin;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
