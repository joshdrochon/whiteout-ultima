// candidate B — snow surface vertex shader
// World-space trail displacement: any mesh carrying this material (terrain
// chunks, probe geometry) sinks by carve depth sampled at its world XZ, so
// the trail changes real silhouettes (SV-07 geometry leg).
uniform sampler2D uTrail;
uniform vec2 uTrailOrigin;   // world XZ of trail-window texel (0,0) corner
uniform float uTrailWorld;   // window size in meters
uniform float uMaxDepth;     // meters of trench at brush strength 1.0

varying vec3 vWorld;
varying float vViewZ;

float trailDepthV(vec2 w) {
  vec2 uv = (w - uTrailOrigin) / uTrailWorld;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) return 0.0;
  return texture2D(uTrail, uv).r;
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  wp.y -= trailDepthV(wp.xz) * uMaxDepth;
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
