// heightfield.mjs — deterministic seeded heightfield for an SSX-style alpine descent.
// 1 u = 1 m. No Math.random anywhere in this module: integer-hash value noise only.
//
// Composition (all terms deterministic functions of x,z):
//   base   : constant-grade descent, ~24 deg average pitch over the 3 km course
//   big    : ridged fBm (wavelength ~900 m, amp ~300 m) -> ridgelines / km-scale relief
//   med    : fBm (~170 m, 70 m)                          -> spurs and rolls
//   det    : fBm (~38 m, 9 m)                            -> moguls / chatter
//   bowl   : sides rise away from the course line        -> natural gully the course runs down
//   carve  : gaussian trench on the course line, noise amplitude damped near the line
//            so the corridor reads groomed and rideable.

export const SEED = 0x5e0eb; // fixed seed — deterministic build

function hash2(ix, iz) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(SEED, 69069);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, z, oct) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f + i * 17.31, z * f - i * 9.7);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm; // 0..1
}

function ridged(x, z, oct) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = vnoise(x * f + i * 11.13, z * f + i * 5.71);
    sum += amp * (1 - Math.abs(2 * n - 1)); // sharp crests
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm; // 0..1, ridges near 1
}

// Analytic course centerline (meandering descent along +z, downhill toward z=3000).
export const COURSE_Z0 = 0;
export const COURSE_Z1 = 3000;
export function courseX(z) {
  return 260 * Math.sin(z * (Math.PI * 2) / 1400)
       + 130 * Math.sin(z * (Math.PI * 2) / 610 + 1.7);
}

const DROP_RATE = 0.445; // tan ~24 deg average grade

export function sampleHeight(x, z) {
  const dx = x - courseX(z);
  const gully = Math.exp(-(dx * dx) / (2 * 230 * 230)); // 1 on the line, 0 far away

  const base = (COURSE_Z1 - z) * DROP_RATE;
  const big = (ridged(x / 900, z / 900, 4) - 0.55) * 300;
  const med = (fbm(x / 170, z / 170, 4) - 0.5) * 70;
  const det = (fbm(x / 38, z / 38, 3) - 0.5) * 9;

  const w = Math.min(Math.abs(dx) / 700, 1);
  const bowl = w * w * 120;             // valley walls rise away from the course
  const carve = 45 * gully;             // trench on the line

  return base
    + big * (1 - 0.75 * gully)
    + med * (1 - 0.70 * gully)
    + det * (1 - 0.85 * gully)
    + bowl - carve;
}

export function sampleNormal(x, z, out) {
  const e = 2;
  const hL = sampleHeight(x - e, z), hR = sampleHeight(x + e, z);
  const hD = sampleHeight(x, z - e), hU = sampleHeight(x, z + e);
  let nx = hL - hR, ny = 2 * e, nz = hD - hU;
  const il = 1 / Math.hypot(nx, ny, nz);
  out[0] = nx * il; out[1] = ny * il; out[2] = nz * il;
  return out;
}

// Integer hash exposed for deterministic per-vertex jitter.
export function hash2ish(ix, iz) { return hash2(ix, iz); }

// Seeded PRNG for decor scattering (never Math.random).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
