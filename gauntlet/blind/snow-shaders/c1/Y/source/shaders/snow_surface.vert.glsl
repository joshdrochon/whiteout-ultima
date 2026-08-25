// Snow surface — vertex stage.
// Displaces geometry DOWN by the persistent trail heightmap (world-XZ toroidal
// window that follows the rider), so trenches change the actual silhouette.
// Trail depth is passed to the fragment stage for trench tint / SSS gating.
// NOTE: position/color attributes + matrices come from the three.js prefix.

uniform sampler2D uTrail;
uniform vec2  uRider;      // rider world XZ (window center)
uniform float uWindow;     // trail window size (m)
uniform float uBand;       // clearing band at the toroidal seam (m)
uniform float uMaxDepth;   // trench depth clamp (m)

varying vec3  vWorld;
varying vec3  vColor;
varying float vDepth;

float trailDepth(vec2 xz) {
  vec2 d = xz - uRider;
  if (max(abs(d.x), abs(d.y)) > 0.5 * uWindow - uBand) return 0.0;
  return min(texture2D(uTrail, fract(xz / uWindow)).r, uMaxDepth);
}

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  float h = trailDepth(wp.xz);
  wp.y -= h;                       // carved groove: real geometric displacement
  vWorld = wp.xyz;
  vDepth = h;
  #ifdef USE_COLOR
    vColor = color;
  #else
    vColor = vec3(1.0);
  #endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
