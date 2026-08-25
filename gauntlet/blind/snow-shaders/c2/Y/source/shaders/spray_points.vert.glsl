// Spray render: pool of GL points; each vertex fetches its particle from the
// position texture (position.x carries the slot index). Dead particles are
// clipped in the vertex stage so the idle pool costs no fill.
uniform sampler2D uPosTex;
uniform sampler2D uVelTex;
uniform vec2 uTexDim;
uniform float uHalfH;
varying float vAlpha;
float hash11(float n) { return fract(sin(n * 127.1) * 43758.5453); }
void main() {
  float idx = position.x;
  vec2 uv = (vec2(mod(idx, uTexDim.x), floor(idx / uTexDim.x)) + 0.5) / uTexDim;
  vec4 p = texture2D(uPosTex, uv);
  vec4 vt = texture2D(uVelTex, uv);   // w = ground height at emission
  vAlpha = 0.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  gl_PointSize = 1.0;
  if (p.w > 0.0) {
    vec4 mv = viewMatrix * vec4(p.xyz, 1.0);
    if (mv.z < -0.1) {
      // CRITIQUE [C2]: bigger sprites near the board so the rooted plume has
      // real body at chase distance (PS2 spray is oversized and opaque).
      float size = mix(0.11, 0.32, hash11(idx));
      float ps = clamp(size * projectionMatrix[1][1] * uHalfH / -mv.z, 1.5, 42.0);
      gl_PointSize = ps;
      gl_Position = projectionMatrix * mv;
      // distant/tiny sprites fade OUT entirely (no alpha floor) so far-flung
      // grains dissolve into the field instead of reading as white confetti
      vAlpha = 0.9 * smoothstep(0.0, 0.4, p.w) * smoothstep(1.0, 5.5, ps);
      // grains that sank below the snow surface melt into it visually
      vAlpha *= smoothstep(-0.35, -0.05, p.y - vt.w);
    }
  }
}
