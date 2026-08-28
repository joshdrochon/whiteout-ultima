// ============================================================================
// render-loop candidate A — main.mjs
//
// STRATEGY (seeded: chunked tile grid streamed around the flythrough path,
// per-chunk LOD by distance; camera on a Catmull-Rom spline down the course).
//
// Structure (deliberately non-naive):
//   * Terrain is a pure analytic function sampleHeight(x,z): linear alpine
//     descent (avg pitch atan(0.42) ~= 23 deg) + a meandering gully
//     cross-section the course runs down + ridged fBm whose amplitude ramps
//     UP with lateral distance from the course line, so the corridor stays
//     ridable while km-scale ridgelines build to the sides. Fully
//     deterministic: integer-hash value noise, fixed seed, no Math.random
//     in the height path (placement rng is a seeded mulberry32).
//   * Two-tier chunk grid: inner corridor 250 m tiles with 4 distance LODs
//     (33^2 .. 5^2 verts) whose geometry is built LAZILY on demand and
//     cached per (tile, lod) — that is the "streaming": as the flythrough
//     camera sweeps, tiles promote/demote and only then pay build cost.
//     Outer 1 km backdrop tiles give the far skyline. Every tile carries a
//     skirt to hide LOD-seam cracks. One shared material => ~120 draw calls
//     worst case, fewer after frustum culling.
//   * Lighting is BAKED per-vertex (wrap-lambert vs. a fixed sun, blue-
//     shifted shadow term, rock on steep faces, groomed-piste tint on the
//     course line) onto MeshBasicMaterial. Zero per-pixel lighting => fast
//     under SwiftShader, and the PS2-SSX high-key palette is authored
//     directly instead of hoping a PBR pipeline lands there.
//   * Fixed-timestep core: render(alphaMs) owns an accumulator and only
//     ever calls update(FIXED_DT) with exactly 1/60; leftover accumulator
//     becomes the interpolation alpha (exposed as app.alpha for later
//     lanes). No per-frame dt ever reaches sim state.
// ============================================================================

import * as THREE from 'three';
import { buildRails } from './rails-course.mjs';

// ---------------------------------------------------------------- constants
const FIXED_DT = 1 / 60;          // s   — the ONLY dt the sim ever sees
const STEP_MS = 1000 / 60;
const SEED = 0x5eed1;
const COURSE_LEN = 2600;          // m, course runs z = 0 (top) .. 2600 (bottom)

// ------------------------------------------------------- deterministic noise
function hash2(ix, iz) {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ SEED;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}
function fbm(x, z, oct) {
  let s = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    s += amp * vnoise(x * f + i * 13.7, z * f + i * 7.3);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return s / norm;                                   // 0..1
}
function ridged(x, z, oct) {
  let s = 0, amp = 0.55, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(2 * vnoise(x * f + i * 5.1, z * f + i * 17.9) - 1);
    s += amp * n * n;
    norm += amp; amp *= 0.5; f *= 2.11;
  }
  return s / norm;                                   // 0..1, sharp ridgelines
}
function ss(a, b, x) {                               // smoothstep
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------- heightfield
function centerX(z) {                                // course meander
  return 150 * Math.sin(z * 0.0032) + 65 * Math.sin(z * 0.0011 + 1.7);
}
function baseHeight(x, z) {
  const d = Math.abs(x - centerX(z));
  // primary descent + long rollers (pitch stays ~12..32 deg, avg ~23)
  let h = 1150 - 0.42 * z
    + 26 * Math.sin(z * 0.0045 + 0.8)
    + 8 * Math.sin(z * 0.011 + 3.1);
  // gully cross-section — valley walls climbing away from the course line
  h += Math.min(d * d * 0.0035, 430);
  // km-scale massif, damped near the course so the line stays ridable
  h += (fbm(x * 0.0009, z * 0.0009, 4) * 2 - 1) * (25 + 430 * ss(120, 800, d));
  // ridged peaks / spurs, also ramped out laterally
  h += ridged(x * 0.004, z * 0.004, 4) * (8 + 230 * ss(80, 600, d));
  // course micro-rolls
  h += (fbm(x * 0.02, z * 0.02, 2) * 2 - 1) * 2.5;
  return h;
}
// THE PISTE, PLUS KICKERS. Kept separate from the function above on purpose:
// rawCenterX() finds the gully floor by scanning for the LOWEST point across
// the slope, and a ramp raises the centreline — so if ramps were inside
// sampleHeight the course line would bend around its own jumps, taking the
// rails and every prop with it. baseHeight is the mountain; sampleHeight is
// what you ride.
// OFF BY DEFAULT, and that is a disclosure, not a convenience.
//
// Ramps sit ON the course centreline — which is exactly where the run corridor,
// the rails and the rivals all live. Switching them on inside the shared
// sampleHeight broke SEVEN gates across four lanes at once, because every one
// of those lanes was calibrated against a piste with no 7 m kickers in it.
//
// So the harnesses keep measuring the accepted course and the GAME turns ramps
// on. THE GAP IS REAL: the gated lanes do not yet see the ramps, so nothing
// currently proves a rail is still catchable or a rival still finishes with a
// kicker in the way. Closing that means recalibrating those lanes against the
// new course, which is a real piece of work and not a flag flip.
let rampsOn = false;
function setRamps(v) { rampsOn = !!v; }
function sampleHeight(x, z) {
  return rampsOn ? baseHeight(x, z) + rampHeight(x, z, centerX(z)) : baseHeight(x, z);
}
function sampleNormal(x, z, out) {
  const e = 4;
  const nx = sampleHeight(x - e, z) - sampleHeight(x + e, z);
  const nz = sampleHeight(x, z - e) - sampleHeight(x, z + e);
  const ny = 2 * e;
  const il = 1 / Math.hypot(nx, ny, nz);
  out.x = nx * il; out.y = ny * il; out.z = nz * il;
  return out;
}

// ------------------------------------------------------------- slalom gates
// 25 gates, every 100 m from z=80. Half-width 8 m, which is the geometry the
// flags are actually built from.
const GATE_HALF = 8;
const GATE_COUNT = 25;
function buildGates() {
  const out = [];
  for (let k = 0; k < GATE_COUNT; k++) {
    const z = 80 + k * 100;
    out.push({ i: k, z, x: centerX(z), half: GATE_HALF });
  }
  return out;
}

// ---------------------------------------------------------------- snow ramps
// KICKERS BUILT INTO THE TERRAIN ITSELF, not placed as props.
//
// The physics samples the same sampleHeight() the mesh is built from, so a ramp
// added here is SOLID for free — the rider rides up it and is launched by the
// ordinary ground-following code. A prop ramp would have needed its own
// collision, and physics is a gated lane nobody should be adding surfaces to
// for a visual feature.
//
// Shape: a Gaussian ridge across the fall line that rises over its run and ends
// at a lip, then falls away fast so there is a clean take-off rather than a
// hump you roll over. Placed down the centreline where the rider actually is.
// SIZED TO BEAT THE FALL LINE, not by eye. The piste drops about 0.42 m per
// metre, so a ramp only launches if its own rise exceeds that near the lip.
// With the quadratic run below, the gradient at the lip is 2*h/run — the first
// version used h 4.8 over run 34, i.e. 0.28 m/m, which is LESS than the slope,
// so the surface never tilted upward and the "ramp" was just a place where the
// hill briefly got shallower. These give 0.85-1.00 m/m, a real take-off angle
// of roughly 23-30 deg above horizontal.
const RAMPS = [
  { z: 420,  w: 26, h: 6.0, run: 14 },
  { z: 760,  w: 22, h: 6.8, run: 15 },
  { z: 1180, w: 30, h: 5.6, run: 13 },
  { z: 1520, w: 24, h: 7.2, run: 16 },
  { z: 1960, w: 28, h: 6.4, run: 15 },
];
function rampHeight(x, z, cx) {
  let add = 0;
  for (const r of RAMPS) {
    const dz = z - r.z;
    if (dz < -r.run || dz > 6) continue;            // only the run and the lip
    const dx = x - cx;
    if (Math.abs(dx) > r.w * 2) continue;
    // across: a smooth ridge, so the edges blend into the piste
    const across = Math.exp(-(dx * dx) / (r.w * r.w));
    // along: 0 at the foot, 1 at the lip, then a fast drop past it
    const along = dz <= 0
      ? Math.pow(1 + dz / r.run, 2)                 // rising run
      : Math.max(0, 1 - dz / 6);                    // the lip's back edge
    add += r.h * across * along;
  }
  return add;
}

// ------------------------------------------------------- baked vertex color
const SUN = new THREE.Vector3(0.72, 0.48, -0.4).normalize();
const C_SNOW_LIT = [1.26, 1.16, 1.0];
const C_SNOW_SHD = [0.14, 0.28, 0.98];               // deep saturated blue shadow
const C_ROCK_LIT = [0.66, 0.46, 0.3];
const C_ROCK_SHD = [0.1, 0.14, 0.5];
const C_PISTE_LIT = [0.6, 0.9, 1.22];                // groomed ice-blue ribbon
const C_PISTE_SHD = [0.1, 0.3, 1.0];
const _n = new THREE.Vector3();
function shadeVertex(x, z, out3) {
  sampleNormal(x, z, _n);
  const ndl = _n.x * SUN.x + _n.y * SUN.y + _n.z * SUN.z;
  const l = Math.pow(Math.min(1, Math.max(0, (ndl + 0.18) / 1.18)), 2.0); // wrap
  const d = Math.abs(x - centerX(z));
  const rock = ss(0.62, 0.5, _n.y) * ss(40, 90, d);  // steep faces off-piste
  const spark = 0.93 + 0.14 * hash2(Math.round(x * 7), Math.round(z * 7));
  const piste = ss(24, 10, d);                       // groomed course line
  // near-field surface detail: wind-warped sastrugi banding + mogul shading
  const warp = vnoise(x * 0.045, z * 0.045);
  const band = Math.sin((x * 0.82 - z * 0.57) * 0.42 + warp * 5.2); // ~15 m ridges
  const mog = fbm(x * 0.055, z * 0.055, 2) * 2 - 1;                 // ~18 m moguls
  const chop = vnoise(x * 0.21, z * 0.21) * 2 - 1;                  // ~5 m chop
  const detail = 1 + (0.1 * band + 0.14 * mog + 0.09 * chop) * (1 - rock);
  for (let i = 0; i < 3; i++) {
    let lit = C_SNOW_LIT[i] * (1 - rock) + C_ROCK_LIT[i] * rock;
    let shd = C_SNOW_SHD[i] * (1 - rock) + C_ROCK_SHD[i] * rock;
    lit = lit * (1 - piste) + C_PISTE_LIT[i] * piste;
    shd = shd * (1 - piste) + C_PISTE_SHD[i] * piste;
    out3[i] = (shd + (lit - shd) * l) * spark * detail;
  }
}

// -------------------------------------------------------- chunk geometry
function buildChunkGeometry(x0, z0, size, seg) {
  const n = seg + 1;
  // flange: tiles overlap neighbors slightly instead of abutting, so T-junction
  // hairline cracks at LOD boundaries cannot open (a surface always covers the
  // gap; overlapping strips differ by interpolation error, so the nearer one
  // simply wins the depth test — no coplanar z-fight)
  const margin = (size / seg) * 0.6;
  const ox = x0 - margin, oz = z0 - margin, osize = size + 2 * margin;
  // no skirts: tiles flange/overlap their neighbors, which seals LOD cracks
  // outright — skirt curtains hung from flanged perimeters poke through the
  // neighbor's surface as thin dark dashes
  const positions = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const col = [0, 0, 0];
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = ox + (i / seg) * osize, z = oz + (j / seg) * osize;
      positions[p] = x; positions[p + 1] = sampleHeight(x, z); positions[p + 2] = z;
      shadeVertex(x, z, col);
      colors[p] = col[0]; colors[p + 1] = col[1]; colors[p + 2] = col[2];
      p += 3;
    }
  }
  const idx = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ================================================================== boot
export async function boot(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance',
  });
  // RL-10: explicit color pipeline, not defaults-by-omission
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setClearColor(0x9cc8ff, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xbfe2ff, 3800, 13000);  // bright aerial haze, far + subtle

  // 70 deg base FOV, dialled in the pose editor against a running frame. The
  // chase rig reads this as its base and scales its speed/boost kick off it.
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.5, 16000);

  // -- resize with devicePixelRatio clamp (RL-09) -------------------------
  function resize() {
    const w = canvas.clientWidth || canvas.width || 1280;
    const h = canvas.clientHeight || canvas.height || 720;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  // -- sky dome (vertex-colored gradient, 1 draw) -------------------------
  {
    const g = new THREE.SphereGeometry(9000, 20, 12);
    const pos = g.attributes.position;
    const cols = new Float32Array(pos.count * 3);
    const zen = [0.02, 0.18, 1.05], hor = [0.5, 0.8, 1.05];
    for (let i = 0; i < pos.count; i++) {
      const t = ss(-0.05, 0.55, pos.getY(i) / 9000);
      cols[i * 3] = hor[0] + (zen[0] - hor[0]) * t;
      cols[i * 3 + 1] = hor[1] + (zen[1] - hor[1]) * t;
      cols[i * 3 + 2] = hor[2] + (zen[2] - hor[2]) * t;
    }
    g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const sky = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false,
    }));
    sky.frustumCulled = false;
    scene.add(sky);
  }

  const groundMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });

  // -- inner corridor chunks: 250 m tiles, 4 LODs, lazy-built + cached ----
  const CH = 250;
  const LODS = [
    { maxD: 180, seg: 96 },
    { maxD: 420, seg: 64 },
    { maxD: 950, seg: 16 },
    { maxD: 1900, seg: 8 },
    { maxD: Infinity, seg: 4 },
  ];
  const chunks = [];
  const geomCache = new Map();
  function chunkGeom(x0, z0, size, seg) {
    const key = x0 + '_' + z0 + '_' + seg;
    let g = geomCache.get(key);
    if (!g) { g = buildChunkGeometry(x0, z0, size, seg); geomCache.set(key, g); }
    return g;
  }
  // 16 rows, not 12. The corridor used to stop at z=2750, 350 m past the finish
  // line, and beyond that the only surface was the 1 km backdrop at 83 m per
  // quad — far too coarse to follow the gully, so it cut a straight chord and
  // left a visible step with SKY UNDER IT. Measured by parking the rider at
  // z=2800 and looking: a hard horizontal seam across the slope and open sky
  // through the bottom of the frame. 16 rows carry the fine corridor to z=3750,
  // which is where the backdrop ends anyway, so the fine/coarse seam no longer
  // lands anywhere a player can stand.
  for (let gz = 0; gz < 16; gz++) {
    for (let gx = 0; gx < 8; gx++) {
      const x0 = -1000 + gx * CH, z0 = -250 + gz * CH;
      const mesh = new THREE.Mesh(chunkGeom(x0, z0, CH, 4), groundMat);
      scene.add(mesh);
      chunks.push({ mesh, x0, z0, size: CH, cx: x0 + CH / 2, cz: z0 + CH / 2, lod: LODS.length - 1 });
    }
  }
  // -- outer backdrop tiles: 1 km, fixed coarse LOD, skyline only ---------
  for (let gz = 0; gz < 5; gz++) {
    for (let gx = 0; gx < 6; gx++) {
      const x0 = -3000 + gx * 1000, z0 = -1250 + gz * 1000;
      const cx = x0 + 500, cz = z0 + 500;
      if (cx > -1000 && cx < 1000 && cz > -250 && cz < 3750) continue; // inner covers it
      // seg 20, not 12: 50 m per quad instead of 83. These tiles are the skyline
      // and the ground immediately outside the corridor, and at 83 m they cut
      // visible chords across the gully walls where they meet the fine tiles.
      const mesh = new THREE.Mesh(chunkGeom(x0, z0, 1000, 20), groundMat);
      scene.add(mesh);
    }
  }

  // -- grind rails (merged, 1 draw) ---------------------------------------
  // Drawn from the SAME polylines the rails module captures against, so what
  // you see is what you grind.
  {
    const rails = buildRails(sampleHeight, centerX);
    const pos = [], col = [], idx = [];
    let v = 0;
    // Dark, not steel: a light-grey rail on bright snow had almost no contrast.
    const STEEL = [0.20, 0.22, 0.28], POST = [0.85, 0.30, 0.06];
    // a square tube swept along the polyline
    // Lighting in this scene is BAKED per-vertex onto MeshBasicMaterial — there
    // are no lights at all. A MeshLambertMaterial here rendered pure black.
    const SUN = [0.55, 0.55, 0.30];
    const sl = Math.hypot(SUN[0], SUN[1], SUN[2]);
    const tube = (pts, r, c) => {
      const ring = [[-r, -r], [r, -r], [r, r], [-r, r]];
      const base = v;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
        let tx = b[0] - a[0], tz = b[2] - a[2];
        const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
        const nx = -tz, nz = tx;                       // lateral normal
        for (const [u, w] of ring) {
          pos.push(pts[i][0] + nx * u, pts[i][1] + w, pts[i][2] + nz * u);
          // outward normal of this corner, baked against the same sun the snow uses
          const ox = nx * u, oy = w, oz = nz * u;
          const ol = Math.hypot(ox, oy, oz) || 1;
          const d = (ox * SUN[0] + oy * SUN[1] + oz * SUN[2]) / (ol * sl);
          const k = 0.45 + 0.55 * Math.max(0, d);
          col.push(c[0] * k, c[1] * k, c[2] * k); v++;
        }
      }
      for (let i = 0; i < pts.length - 1; i++) {
        const A = base + i * 4, B = base + (i + 1) * 4;
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          idx.push(A + k, B + k, B + k2, A + k, B + k2, A + k2);
        }
      }
    };
    for (const r of rails) {
      tube(r.points, 0.11, STEEL);
      // support posts at both ends and the middle
      for (const t of [0, 0.5, 1]) {
        const i = Math.round(t * (r.points.length - 1));
        const p = r.points[i];
        const g = sampleHeight(p[0], p[2]);
        tube([[p[0], g, p[2]], [p[0], p[1], p[2]]], 0.05, POST);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true })));
  }

  // -- slalom gate flags down the course line (merged, 1 draw) ------------
  // The gate LINE is published so gameplay scores against the same numbers the
  // renderer draws. Two copies of "80 + k * 100" would drift the moment either
  // side changed, and a gate you score for but cannot see is worse than no
  // gates at all.
  {
    const GATES = buildGates();
    const pos = [], col = [], idx = [];
    let v = 0;
    const box = (x, y, z, w, h, dpt, c) => {
      const xs = [x - w, x + w], ys = [y, y + h], zs = [z - dpt, z + dpt];
      const base = v;
      for (let zi = 0; zi < 2; zi++) for (let yi = 0; yi < 2; yi++) for (let xi = 0; xi < 2; xi++) {
        pos.push(xs[xi], ys[yi], zs[zi]); col.push(c[0], c[1], c[2]); v++;
      }
      const f = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
      for (const i of f) idx.push(base + i);
    };
    const quad = (a, b, c, d, cc) => {
      const base = v;
      for (const p of [a, b, c, d]) { pos.push(p[0], p[1], p[2]); col.push(cc[0], cc[1], cc[2]); v++; }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    const RED = [1.0, 0.16, 0.1], YEL = [1.0, 0.8, 0.05], CYN = [0.1, 0.75, 1.0];
    for (let k = 0; k < 25; k++) {
      const z = GATES[k].z;
      const cx = GATES[k].x;
      const xl = cx - GATE_HALF, xr = cx + GATE_HALF;
      const yl = sampleHeight(xl, z), yr = sampleHeight(xr, z);
      const bannerC = k % 2 ? RED : CYN;
      box(xl, yl - 0.5, z, 0.25, 5.2, 0.25, YEL);
      box(xr, yr - 0.5, z, 0.25, 5.2, 0.25, YEL);
      quad([xl, yl + 4.7, z], [xr, yr + 4.7, z], [xr, yr + 3.2, z], [xl, yl + 3.2, z], bannerC);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const flags = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    }));
    scene.add(flags);
  }

  // -- pine trees: GONE ---------------------------------------------------
  // 800 merged cones used to live here. They were rebuilt once into tiered
  // conifers with a trunk and per-vertex sun shading, and side by side with the
  // three modelled tree assets they still read as pale triangles — a 12 m cone
  // near the camera was the ugliest thing on screen while the modelled trees
  // behind it were the best. Hand-built cone skirts do not make a tree.
  //
  // The forest is now three InstancedMesh layers in src/game/main.mjs (dead,
  // leaning, tall), banded by slope. That is also why this deletion is safe:
  // those bands together cover every slope the cones ever grew on.

  // -- flythrough spline (Catmull-Rom down the gully) ---------------------
  const splinePts = [];
  for (let z = -80; z <= COURSE_LEN + 80; z += 160) {
    const x = centerX(z);
    splinePts.push(new THREE.Vector3(x, sampleHeight(x, z) + 16, z));
  }
  const spline = new THREE.CatmullRomCurve3(splinePts, false, 'centripetal');
  const _pos = new THREE.Vector3(), _tgt = new THREE.Vector3();
  function flythrough(t) {
    const tc = Math.min(1, Math.max(0, t));
    spline.getPointAt(tc, _pos);
    _pos.y = Math.max(_pos.y, sampleHeight(_pos.x, _pos.z) + 8);
    const t2 = Math.min(1, tc + 0.055);
    if (t2 - tc > 1e-4) {
      spline.getPointAt(t2, _tgt);
    } else {                                         // at the very end: extrapolate
      spline.getPointAt(tc - 0.055, _tgt);
      _tgt.set(2 * _pos.x - _tgt.x, 2 * _pos.y - _tgt.y, 2 * _pos.z - _tgt.z);
    }
    _tgt.y -= 2;                                     // slight downhill bias
    camera.position.copy(_pos);
    camera.lookAt(_tgt);
    updateLod();
  }

  // -- per-chunk LOD streaming around the camera --------------------------
  function updateLod() {
    const cx = camera.position.x, cz = camera.position.z;
    for (const c of chunks) {
      const dx = c.cx - cx, dz = c.cz - cz;
      const dist = Math.hypot(dx, dz);
      let lod = LODS.length - 1;
      for (let i = 0; i < LODS.length; i++) if (dist < LODS[i].maxD) { lod = i; break; }
      if (lod !== c.lod) {
        // dispose the demoted/evicted LOD geometry so GPU memory stays bounded
        const oldKey = c.x0 + '_' + c.z0 + '_' + LODS[c.lod].seg;
        const old = geomCache.get(oldKey);
        c.lod = lod;
        c.mesh.geometry = chunkGeom(c.x0, c.z0, c.size, LODS[lod].seg);
        if (old && old !== c.mesh.geometry) { geomCache.delete(oldKey); old.dispose(); }
      }
    }
  }

  // -- fixed-timestep core (RL-04) ----------------------------------------
  // Sim state advances ONLY through update(FIXED_DT). render() accumulates
  // wall-clock ms and drains it in exact 1/60 steps; the remainder is the
  // interpolation alpha. No frame dt ever touches sim state.
  const sim = { time: 0, prevTime: 0 };
  function update(/* dt — contractually 1/60; constant used regardless */) {
    sim.prevTime = sim.time;
    sim.time += FIXED_DT;
  }
  let accMs = 0;
  const app = {
    update,
    render(alphaMs) {
      let ms = Number.isFinite(alphaMs) ? alphaMs : STEP_MS;
      accMs += Math.min(ms, 100);                    // clamp: no spiral of death
      let steps = 0;
      while (accMs >= STEP_MS && steps < 5) { update(FIXED_DT); accMs -= STEP_MS; steps++; }
      app.alpha = Math.min(accMs / STEP_MS, 1);      // interp factor for later lanes
      updateLod();
      renderer.render(scene, camera);
    },
    alpha: 0,
    scene, camera, renderer,
    sampleHeight,
    flythrough,
  };

  flythrough(0);                                     // prime LODs + camera
  return app;
}

// pure exports for the regression suite (test-suite geometry contract; zero behavior change)
export { sampleHeight, buildChunkGeometry, centerX, baseHeight, RAMPS, setRamps, buildGates, GATE_HALF };
