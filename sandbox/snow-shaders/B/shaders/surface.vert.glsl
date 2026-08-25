// candidate B — snow surface vertex shader
// World-space trail displacement: any mesh carrying this material (terrain
// chunks, probe geometry) sinks by carve depth (trail R) and rises by the
// displaced ridge lip (trail G) sampled at its world XZ, so the trail changes
// real silhouettes (SV-07 geometry leg) and the groove gets raised walls the
// chase camera can read (critique cycle 1, mustFix #1).
uniform sampler2D uTrail;
uniform vec2 uTrailOrigin;   // world XZ of trail-window texel (0,0) corner
uniform float uTrailWorld;   // window size in meters
uniform float uMaxDepth;     // meters of trench at brush strength 1.0
uniform float uLipHeight;    // meters of ridge lip at lip value 1.0

varying vec3 vWorld;
varying float vViewZ;

vec2 trailDL(vec2 w) {
  vec2 uv = (w - uTrailOrigin) / uTrailWorld;
  if (uv.x < 0.002 || uv.x > 0.998 || uv.y < 0.002 || uv.y > 0.998) return vec2(0.0);
  return texture2D(uTrail, uv).rg;
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 dl = trailDL(wp.xz);
  wp.y += dl.y * uLipHeight - dl.x * uMaxDepth;
  vWorld = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
