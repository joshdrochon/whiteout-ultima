// Snow surface — vertex. Displaces every vertex DOWN by the trail depth
// sampled from the persistent trail texture (SV-07 geometry: silhouettes
// genuinely move). Works for the terrain chunks and for the harness's
// probe sphere alike: displacement is world-xz addressed.
uniform sampler2D uTrail;
uniform vec2 uTrailCenter;
uniform float uTrailSize;
uniform float uTrailDepthMax;

varying vec3 vWorld;

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 uv = (w.xz - uTrailCenter) / uTrailSize + 0.5;
  vec2 m2 = smoothstep(vec2(0.0), vec2(0.02), uv)
          * (1.0 - smoothstep(vec2(0.98), vec2(1.0), uv));
  float d = texture2D(uTrail, uv).r * uTrailDepthMax * m2.x * m2.y;
  w.y -= d;
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
