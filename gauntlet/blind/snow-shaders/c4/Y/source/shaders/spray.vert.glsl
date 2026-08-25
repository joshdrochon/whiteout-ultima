// candidate B — spray particle vertex shader (GPU-resident sim)
// Particle state lives entirely in vertex buffers; the trajectory is
// integrated in CLOSED FORM here (ballistic + mist drift), so per-frame cost
// on the CPU is zero — JS only writes new spawn records into the ring buffer.
// aData0 = spawn position xyz, spawn time
// aData1 = spawn velocity xyz, lifetime
// aData2 = size (m), seed, population (0 = mist curtain, 1 = chunk), unused
//
// Critique cycle 2 mustFix #2 (plume detached, uniform cotton puffs):
//  * spawn anchoring + much lower downstream velocity inheritance live in
//    attach.mjs emitCarve — the mist curtain now stays within ~2 m of the
//    board contact and the plume centroid sits on the carve;
//  * SIZE FALLOFF here: chunks SHRINK over life (thrown crud disperses),
//    mist grows only mildly while fading — no more ballooning puffs;
//  * per-particle size variance is widened at emit (chunk sizes 3x spread).
precision highp float;

attribute vec4 aData0;
attribute vec4 aData1;
attribute vec4 aData2;

uniform float uTime;
uniform float uG;        // spray gravity (slightly floaty for hang)
uniform float uHalfResY; // viewport half-height in px

varying float vLifeFrac;
varying float vPop;
varying float vSeed;

void main() {
  float age = uTime - aData0.w;
  float life = aData1.w;
  vSeed = aData2.y;
  if (age < 0.0 || age >= life || life <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -3.0, 1.0);  // clipped: dead slot
    gl_PointSize = 0.0;
    vLifeFrac = 1.0; vPop = 0.0;
    return;
  }
  float lf = age / life;
  vec3 p = aData0.xyz + aData1.xyz * age;
  p.y -= 0.5 * uG * age * age;
  if (aData2.z < 0.5) {                        // mist: mild swirl, stays a sheet
    p.x += 0.06 * age * sin(aData2.y * 37.0 + age * 7.0);
    p.z += 0.06 * age * cos(aData2.y * 53.0 + age * 6.0);
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  // size falloff: mist dissipates outward a little as it fades; chunks shrink
  // (cycle 4: sprite cap raised 56 -> 120 px so the near-field plume can be
  // BIG — the cap only exists to stop degenerate close-up fill)
  float grow = (aData2.z < 0.5) ? (1.0 + 0.9 * lf) : (1.0 - 0.30 * lf);
  gl_PointSize = clamp(aData2.x * grow * projectionMatrix[1][1] * uHalfResY / max(-mv.z, 0.5), 1.0, 120.0);
  gl_Position = projectionMatrix * mv;
  vLifeFrac = lf;
  vPop = aData2.z;
}
