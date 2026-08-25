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
function sampleHeight(x, z) {
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
function sampleNormal(x, z, out) {
  const e = 4;
  const nx = sampleHeight(x - e, z) - sampleHeight(x + e, z);
  const nz = sampleHeight(x, z - e) - sampleHeight(x, z + e);
  const ny = 2 * e;
  const il = 1 / Math.hypot(nx, ny, nz);
  out.x = nx * il; out.y = ny * il; out.z = nz * il;
  return out;
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
  // steep-face normal smoothing: on walls, per-vertex micro-crests catching the
  // sun render as bright dotted chains along mesh diagonals. Blend toward a
  // wide-radius (8 m) normal as steepness grows so lighting varies smoothly.
  {
    const E = 8;
    const dxh = (sampleHeight(x + E, z) - sampleHeight(x - E, z)) / (2 * E);
    const dzh = (sampleHeight(x, z + E) - sampleHeight(x, z - E)) / (2 * E);
    const il = 1 / Math.hypot(dxh, 1, dzh);
    const cx = -dxh * il, cy = il, cz = -dzh * il;
    const steepBlend = Math.min(1, Math.max(0, (0.80 - _n.y) / 0.30));
    _n.x = _n.x * (1 - steepBlend) + cx * steepBlend;
    _n.y = _n.y * (1 - steepBlend) + cy * steepBlend;
    _n.z = _n.z * (1 - steepBlend) + cz * steepBlend;
    const nl = 1 / Math.hypot(_n.x, _n.y, _n.z);
    _n.x *= nl; _n.y *= nl; _n.z *= nl;
  }
  const ndl = _n.x * SUN.x + _n.y * SUN.y + _n.z * SUN.z;
  let l = Math.pow(Math.min(1, Math.max(0, (ndl + 0.18) / 1.18)), 2.0); // wrap
  // macro self-shadowing: on steep faces whose horizontal aspect opposes the
  // sun, micro-crests must not catch full sun — isolated lit vertices there
  // render as thin bright scratch streaks across shadowed walls
  const hLen = Math.hypot(_n.x, _n.z) + 1e-6;
  const opposed = Math.max(0, -(_n.x * SUN.x + _n.z * SUN.z) / hLen);
  const steep = Math.min(1, Math.max(0, (0.72 - _n.y) / 0.35));
  l *= 1 - 0.85 * steep * Math.min(1, opposed * 1.6);
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
  // sparkle/sastrugi contrast follows the light: on shadowed faces the full-strength
  // band crests + glitter read as bright dashed lines at distance (misdiagnosed as
  // geometry seams); keep a floor so shadow walls still have form
  const amp = 0.2 + 0.8 * l * l;  // quadratic: terminator zone stays quiet too
  const sparkE = 1 + (spark - 1) * amp;
  const detailE = 1 + (detail - 1) * amp;
  for (let i = 0; i < 3; i++) {
    let lit = C_SNOW_LIT[i] * (1 - rock) + C_ROCK_LIT[i] * rock;
    let shd = C_SNOW_SHD[i] * (1 - rock) + C_ROCK_SHD[i] * rock;
    lit = lit * (1 - piste) + C_PISTE_LIT[i] * piste;
    shd = shd * (1 - piste) + C_PISTE_SHD[i] * piste;
    out3[i] = (shd + (lit - shd) * l) * sparkE * detailE;
  }
}

// -------------------------------------------------------- chunk geometry
function buildChunkGeometry(x0, z0, size, seg) {
  const n = seg + 1;
  const skirtVerts = 4 * n;                          // perimeter ring, dropped
  const positions = new Float32Array((n * n + skirtVerts) * 3);
  const colors = new Float32Array((n * n + skirtVerts) * 3);
  const col = [0, 0, 0];
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = x0 + (i / seg) * size, z = z0 + (j / seg) * size;
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
  // skirts: duplicate each perimeter edge vertex 12 m down, stitch quads
  let sv = n * n;
  const edge = (getIdx) => {
    const s0 = sv;
    for (let k = 0; k < n; k++) {                    // one skirt vert per edge vert
      const vi = getIdx(k);
      positions[sv * 3] = positions[vi * 3];
      positions[sv * 3 + 1] = positions[vi * 3 + 1] - 12;
      positions[sv * 3 + 2] = positions[vi * 3 + 2];
      // EXACT edge color: skirts z-fight with neighboring tile surfaces along
      // their intersection lines on steep walls; identical colors make the
      // flicker invisible (a tinted skirt paints bright dash chains there)
      colors[sv * 3] = colors[vi * 3];
      colors[sv * 3 + 1] = colors[vi * 3 + 1];
      colors[sv * 3 + 2] = colors[vi * 3 + 2];
      sv++;
    }
    for (let k = 1; k < n; k++) {
      const a = getIdx(k - 1), b = getIdx(k);
      idx.push(a, s0 + k - 1, b, b, s0 + k - 1, s0 + k);
    }
  };
  edge(k => k);                                      // z = z0 edge
  edge(k => seg * n + k);                            // z = z1 edge
  edge(k => k * n);                                  // x = x0 edge
  edge(k => k * n + seg);                            // x = x1 edge
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ================================================================== boot
export async function boot(canvas) {
  // antialias ON: shadowed ridge crests overlap sunlit far slopes; without MSAA
  // the serrated low-poly silhouette pops full-brightness pixel dashes that read
  // as seams/scratches on the wall (resolution-dependent — worse on retina)
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: true, powerPreference: 'high-performance',
  });
  // RL-10: explicit color pipeline, not defaults-by-omission
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  renderer.setClearColor(0x9cc8ff, 1);

  const scene = new THREE.Scene();
  // aerial haze pulled in: lit far slopes seen through shadowed-ridge silhouette
  // slits otherwise punch through at full brightness (the dash/seam read); haze
  // also pulls distant cliffs into the high-key palette (integration backlog)
  scene.fog = new THREE.Fog(0xbfe2ff, 350, 2400);

  const camera = new THREE.PerspectiveCamera(72, 16 / 9, 0.5, 16000);

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
  for (let gz = 0; gz < 12; gz++) {
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
      if (cx > -1000 && cx < 1000 && cz > -250 && cz < 2750) continue; // inner covers it
      const mesh = new THREE.Mesh(chunkGeom(x0, z0, 1000, 12), groundMat);
      scene.add(mesh);
    }
  }

  // -- slalom gate flags down the course line (merged, 1 draw) ------------
  {
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
      const z = 80 + k * 100;
      const cx = centerX(z);
      const xl = cx - 8, xr = cx + 8;
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

  // -- pine trees on the lower flanks (merged cones, 1 draw) --------------
  {
    const rng = mulberry32(SEED ^ 0xf07e57);
    const pos = [], col = [], idx = [];
    let v = 0;
    const nrm = new THREE.Vector3();
    let placed = 0;
    for (let tries = 0; tries < 2600 && placed < 800; tries++) {
      const x = -900 + rng() * 1800;
      const z = -200 + rng() * 2900;
      const d = Math.abs(x - centerX(z));
      if (d < 55 || d > 720) continue;
      sampleNormal(x, z, nrm);
      if (nrm.y < 0.72) continue;                    // too steep for trees
      const y = sampleHeight(x, z);
      const hgt = 7 + rng() * 6, rad = hgt * 0.34;
      // clamp base to the lowest terrain under the footprint ring so the
      // downhill edge never hovers on steep ground (sinks the whole cone)
      let baseY = y;
      for (let s = 0; s < 6; s++) {
        const a = (s / 6) * Math.PI * 2;
        baseY = Math.min(baseY, sampleHeight(x + Math.cos(a) * rad, z + Math.sin(a) * rad));
      }
      const shade = 0.75 + rng() * 0.5;
      const cB = [0.02 * shade, 0.24 * shade, 0.08 * shade];
      const cT = [0.55, 0.68, 0.6];                  // snow-dusted tip
      const base = v;
      pos.push(x, baseY + hgt, z); col.push(cT[0], cT[1], cT[2]); v++;
      const NS = 6;
      for (let s = 0; s < NS; s++) {
        const a = (s / NS) * Math.PI * 2;
        pos.push(x + Math.cos(a) * rad, baseY - 0.5, z + Math.sin(a) * rad);
        col.push(cB[0], cB[1], cB[2]); v++;
      }
      for (let s = 0; s < NS; s++) idx.push(base, base + 1 + s, base + 1 + ((s + 1) % NS));
      placed++;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide })));
  }

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
export { sampleHeight, buildChunkGeometry };
