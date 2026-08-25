// Candidate B — render loop for SSX Tricky-style alpine descent.
//
// TERRAIN STRATEGY (deviation from the "radial LOD rings" seed, argued):
// The camera in this game lives on the course, not at a point — so density
// should follow the COURSE LINE, not radiate from a center. Instead of radial
// rings with morph seams, we build:
//   1. A high-density RIBBON mesh parameterized in course space (rows follow
//      the piecewise-cubic centerline, columns are lateral offsets), displaced
//      by sampleHeight. All near-camera detail lives here.
//   2. A coarse full-mountain SHELL (one big displaced grid) biased 0.5 m
//      down, which underlaps the ribbon everywhere. The overlap IS the seam
//      treatment: no morphing, no skirts, no cracks — the fine mesh simply
//      sits on top of the coarse one, and both sample the identical
//      sampleHeight(x,z) field, so the bias is invisible at ribbon's edge.
// This is structurally different from a naive uniform displaced plane (two
// meshes, two parameterizations, density concentrated where gameplay happens)
// and cheaper/simpler than ring morphing for a static course.
//
// Conventions: 1 u = 1 m, +Y up, fixed 60 Hz sim step, render decoupled.
// Deterministic: all randomness is hash-based from SEED. No Math.random.
// Palette: PS2-SSX high-key — saturated sky blue, bright snow, warm sun,
// blue-shifted shadows (baked wrap lighting in vertex colors), no grey fog.

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Deterministic noise (seeded integer hash -> value noise -> fbm / ridge)
// ---------------------------------------------------------------------------
const SEED = 1337;

function hash2(ix, iz) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(SEED, 974634331)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296; // [0,1)
}

function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10); // quintic fade
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

function fbm(x, z, oct) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, z * f);
    norm += amp;
    amp *= 0.5; f *= 2.02;
  }
  return sum / norm; // [0,1]
}

// ---------------------------------------------------------------------------
// Course centerline: piecewise cubic (Catmull-Rom -> Hermite; each segment is
// an exact cubic bezier) x = X(z), z monotonic 0..COURSE_LEN.
// ---------------------------------------------------------------------------
const COURSE_LEN = 3000;
const SEG = 300;
const XW = [0, 70, 190, 130, -60, -190, -90, 90, 210, 110, 0]; // 11 waypoints

function pathX(z) {
  const zc = Math.min(Math.max(z, 0), COURSE_LEN - 0.001);
  const i = Math.floor(zc / SEG);
  const u = (zc - i * SEG) / SEG;
  const p0 = XW[i], p1 = XW[i + 1];
  const m0 = ((XW[i + 1] ?? p0) - (XW[i - 1] ?? p0)) * 0.5;
  const m1 = ((XW[i + 2] ?? p1) - (XW[i] ?? p1)) * 0.5;
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 +
         (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
}
function pathXd(z) { // dX/dz, central difference
  return (pathX(z + 2) - pathX(z - 2)) / 4;
}

const H0 = 1400;           // start altitude (m)
const GRADE = 0.42;        // avg pitch ~22.8 deg — in the SSX 15-35 deg band

function pathY(z) { // groomed course profile: linear descent + rollers
  return H0 - GRADE * z +
    (fbm(z * 0.0015, 3.1, 2) - 0.5) * 2 * 40 +   // long swells
    (fbm(z * 0.006, 7.3, 2) - 0.5) * 2 * 22;     // rollers
}

// ---------------------------------------------------------------------------
// Heightfield — THE terrain authority. Every mesh below displaces from this.
// ---------------------------------------------------------------------------
export function sampleHeight(x, z) {
  // base mountain slab, descending +z, kilometer-scale relief
  let h = H0 - GRADE * z;
  const px = pathX(z);
  const dx = x - px;
  // big relief opens up near the course so the run is a wide piste, not a slot
  const open = 1 - 0.85 * Math.exp(-(dx * dx) / (260 * 260));
  // ridgelines (ridged noise, ~900 m wavelength, up to ~240 m relief)
  const r = 1 - Math.abs(2 * vnoise(x * 0.0011 + 11.7, z * 0.0011 + 3.9) - 1);
  h += r * r * 240 * open;
  // medium hills + fine texture
  h += (fbm(x * 0.004, z * 0.004, 4) - 0.5) * 2 * 70 * open;
  h += (fbm(x * 0.02, z * 0.02, 3) - 0.5) * 2 * 8;
  // valley walls flanking the course -> natural gully the course runs down
  const dxa = Math.max(Math.abs(dx) - 260, 0);
  h += Math.min(dxa * 0.12, 240) * (0.7 + 0.3 * vnoise(x * 0.002 + 51.2, z * 0.002));
  // groom the corridor: blend toward U-shaped course cross-section
  const w = 0.95 * Math.exp(-(dx * dx) / (70 * 70));
  const gy = pathY(z) + Math.min(0.003 * dx * dx, 68) +
             (fbm(x * 0.05 + 9.1, z * 0.05, 2) - 0.5) * 2.6; // moguls
  h = h * (1 - w) + gy * w;
  return h;
}

function sampleNormal(x, z, e = 4) {
  const nx = sampleHeight(x - e, z) - sampleHeight(x + e, z);
  const nz = sampleHeight(x, z - e) - sampleHeight(x, z + e);
  const ny = 2 * e;
  const il = 1 / Math.hypot(nx, ny, nz);
  return [nx * il, ny * il, nz * il];
}

// ---------------------------------------------------------------------------
// Baked lighting (vertex colors, MeshBasicMaterial => cheap under SwiftShader)
// High-key alpine: warm sun, blue-shifted shadow, saturated — never grey.
// ---------------------------------------------------------------------------
// Sun shines DOWN-COURSE (+z component): the descent itself is lit, ridge
// backsides fall into the blue. Down-slope normals tilt +z, so this is the
// high-key orientation.
const SUN = (() => { const v = [0.48, 0.52, 0.46]; const l = Math.hypot(...v); return v.map(c => c / l); })();
const SUN_COL = [1.14, 1.07, 0.97];
const SHADOW_COL = [0.34, 0.47, 0.88]; // blue shadow tint, ~42% luminance

function bakeColor(x, z, out, offset) {
  const [nx, ny, nz] = sampleNormal(x, z, 2.5);
  const ndl = nx * SUN[0] + ny * SUN[1] + nz * SUN[2];
  let wrap = Math.min(Math.max((ndl + 0.22) / 1.22, 0), 1);
  wrap = Math.pow(wrap, 1.4); // deepen the shading curve
  // albedo: snow, groomed corridor slightly cyan-bright, rock on steeps
  let ar = 0.90, ag = 0.95, ab = 1.0;
  const dx = x - pathX(z);
  const cw = Math.exp(-(dx * dx) / (60 * 60));
  const lane = Math.exp(-(dx * dx) / (26 * 26)); // narrow groomed lane
  ar += cw * -0.06 - lane * 0.30; // cyan course line, unmistakable downhill read
  ag += cw * 0.02 - lane * 0.06;
  ab += lane * 0.02;
  const rock = Math.min(Math.max((0.70 - ny) / 0.15, 0), 1); // steep -> rock
  ar = ar * (1 - rock) + 0.30 * rock;
  ag = ag * (1 - rock) + 0.36 * rock;
  ab = ab * (1 - rock) + 0.52 * rock;
  const sparkle = 0.97 + 0.06 * hash2((x * 7) | 0, (z * 7) | 0);
  const lr = SHADOW_COL[0] + (SUN_COL[0] - SHADOW_COL[0]) * wrap;
  const lg = SHADOW_COL[1] + (SUN_COL[1] - SHADOW_COL[1]) * wrap;
  const lb = SHADOW_COL[2] + (SUN_COL[2] - SHADOW_COL[2]) * wrap;
  out[offset] = Math.min(ar * lr * sparkle, 1);
  out[offset + 1] = Math.min(ag * lg * sparkle, 1);
  out[offset + 2] = Math.min(ab * lb * sparkle, 1);
}

// ---------------------------------------------------------------------------
// Geometry builders
// ---------------------------------------------------------------------------
function buildGrid(xs, zs, yOf, biasY) {
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3);
  const col = new Float32Array(nx * nz * 3);
  let k = 0;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = typeof xs[i] === 'function' ? xs[i](zs[j]) : xs[i];
      const z = zs[j];
      pos[k] = x; pos[k + 1] = yOf(x, z) + biasY; pos[k + 2] = z;
      bakeColor(x, z, col, k);
      k += 3;
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  let q = 0;
  for (let j = 0; j < nz - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  return g;
}

function linspace(a, b, n) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = a + (b - a) * (i / (n - 1));
  return out;
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
export async function boot(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  // RL-10: explicit color pipeline — never left to defaults.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x6ebcff);
  scene.fog = new THREE.Fog(0x9fd4ff, 3200, 12000); // saturated blue haze, far only

  const camera = new THREE.PerspectiveCamera(66, 1280 / 720, 0.5, 16000);
  scene.add(camera);

  const terrainMat = new THREE.MeshBasicMaterial({ vertexColors: true });

  // 1. Course-space ribbon: rows follow the centerline, high density.
  {
    const zs = linspace(-60, COURSE_LEN + 60, 440);
    const lat = linspace(-140, 140, 29);
    const nx = lat.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    const col = new Float32Array(nx * nz * 3);
    let k = 0;
    for (let j = 0; j < nz; j++) {
      const z = zs[j], cx = pathX(z);
      for (let i = 0; i < nx; i++) {
        const x = cx + lat[i];
        pos[k] = x; pos[k + 1] = sampleHeight(x, z) + 0.15; pos[k + 2] = z;
        bakeColor(x, z, col, k);
        k += 3;
      }
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let q = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    scene.add(new THREE.Mesh(g, terrainMat));
  }

  // 2. Coarse mountain shell, biased down 0.5 m to underlap the ribbon.
  {
    const g = buildGrid(linspace(-2400, 2400, 130), linspace(-800, 3800, 130),
                        sampleHeight, -0.5);
    scene.add(new THREE.Mesh(g, terrainMat));
  }

  // Sky dome: saturated gradient, zenith deep blue -> bright horizon.
  {
    const g = new THREE.SphereGeometry(9800, 24, 12);
    const posA = g.getAttribute('position');
    const col = new Float32Array(posA.count * 3);
    const zen = [0.10, 0.38, 0.96], hor = [0.55, 0.81, 1.0];
    for (let i = 0; i < posA.count; i++) {
      const t = Math.pow(Math.min(Math.max(posA.getY(i) / 9800, 0), 1), 0.65);
      col[i * 3] = hor[0] + (zen[0] - hor[0]) * t;
      col[i * 3 + 1] = hor[1] + (zen[1] - hor[1]) * t;
      col[i * 3 + 2] = hor[2] + (zen[2] - hor[2]) * t;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.position.set(0, 0, COURSE_LEN / 2);
    scene.add(m);
  }

  // Trees: one InstancedMesh of cones, deterministic hash placement.
  {
    const geo = new THREE.ConeGeometry(3.6, 10, 6);
    geo.translate(0, 5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0x11803c });
    const M = new THREE.Matrix4();
    const placements = [];
    for (let i = 0; i < 4000 && placements.length < 900; i++) {
      const x = (hash2(i, 101) - 0.5) * 3600;
      const z = hash2(i, 202) * COURSE_LEN;
      const dx = Math.abs(x - pathX(z));
      if (dx < 85 || dx > 900) continue;
      const y = sampleHeight(x, z);
      if (y > 950) continue;                       // treeline
      if (sampleNormal(x, z)[1] < 0.72) continue;  // too steep
      placements.push([x, y, z, 0.7 + hash2(i, 303) * 0.7]);
    }
    const inst = new THREE.InstancedMesh(geo, mat, placements.length);
    placements.forEach(([x, y, z, s], i) => {
      M.makeScale(s, s, s).setPosition(x, y - 0.4, z);
      inst.setMatrixAt(i, M);
    });
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
  }

  // Course markers: flag poles at corridor edges, alternating cyan/magenta.
  {
    const geo = new THREE.BoxGeometry(0.8, 7, 0.8);
    geo.translate(0, 3.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const n = 80;
    const inst = new THREE.InstancedMesh(geo, mat, n);
    const M = new THREE.Matrix4();
    const cA = new THREE.Color(0x00e5ff), cB = new THREE.Color(0xff2fd6);
    for (let i = 0; i < n; i++) {
      const z = (i >> 1) * (COURSE_LEN / (n / 2));
      const side = (i & 1) ? 48 : -48;
      const x = pathX(z) + side;
      M.makeTranslation(x, sampleHeight(x, z) - 0.3, z);
      inst.setMatrixAt(i, M);
      inst.setColorAt(i, (i >> 1) % 2 ? cB : cA);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    scene.add(inst);
  }

  // Boost gates: spinning tori along the course. These are the ANIMATED sim
  // objects — their angle advances only in fixed-step update(); render()
  // interpolates prev->curr with alpha. Demonstrates the decoupling (RL-04).
  const gates = { list: [], mesh: null, prevAngle: 0, angle: 0 };
  {
    const geo = new THREE.TorusGeometry(7.5, 0.7, 8, 20);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const N = 9;
    const inst = new THREE.InstancedMesh(geo, mat, N);
    const cols = [new THREE.Color(0xff8a00), new THREE.Color(0xff2fd6), new THREE.Color(0x00e5ff)];
    for (let i = 0; i < N; i++) {
      const z = 250 + i * 300;
      const x = pathX(z);
      const y = sampleHeight(x, z) + 8.5;
      const fwd = new THREE.Vector3(pathXd(z), 0, 1).normalize();
      const qFace = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), fwd);
      gates.list.push({ pos: new THREE.Vector3(x, y, z), qFace });
      inst.setColorAt(i, cols[i % 3]);
    }
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    gates.mesh = inst;
    scene.add(inst);
  }

  // -------------------------------------------------------------------------
  // Fixed-timestep sim (RL-04). The sim NEVER integrates with a variable dt:
  // update(dt) feeds an accumulator; every tick advances exactly FIXED_DT.
  // render(alphaMs) only interpolates visuals — it mutates no sim state.
  // -------------------------------------------------------------------------
  const FIXED_DT = 1 / 60;
  const GATE_SPIN = 1.6; // rad/s
  let accumulator = 0;
  let simTime = 0;

  function simTick() { // dt is ALWAYS FIXED_DT — no argument on purpose
    simTime += FIXED_DT;
    gates.prevAngle = gates.angle;
    gates.angle += GATE_SPIN * FIXED_DT;
  }

  function update(dt) {
    accumulator += (typeof dt === 'number' && isFinite(dt) && dt > 0) ? dt : FIXED_DT;
    let ticks = 0;
    while (accumulator >= FIXED_DT - 1e-9 && ticks < 5) {
      simTick();
      accumulator -= FIXED_DT;
      ticks++;
    }
    if (ticks === 5) accumulator = 0; // spiral-of-death guard
  }

  const _q = new THREE.Quaternion(), _qs = new THREE.Quaternion();
  const _m = new THREE.Matrix4(), _s = new THREE.Vector3(1, 1, 1);
  const _axZ = new THREE.Vector3(0, 0, 1);

  function render(alphaMs) {
    const alpha = Math.min(Math.max((alphaMs ?? 0) / (FIXED_DT * 1000), 0), 1);
    const a = gates.prevAngle + (gates.angle - gates.prevAngle) * alpha;
    for (let i = 0; i < gates.list.length; i++) {
      const g = gates.list[i];
      _qs.setFromAxisAngle(_axZ, a + i * 0.7);
      _q.copy(g.qFace).multiply(_qs);
      _m.compose(g.pos, _q, _s);
      gates.mesh.setMatrixAt(i, _m);
    }
    gates.mesh.instanceMatrix.needsUpdate = true;
    renderer.render(scene, camera);
  }

  // -------------------------------------------------------------------------
  // Resize (RL-09): devicePixelRatio clamped to 2.
  // -------------------------------------------------------------------------
  function onResize() {
    const w = canvas.clientWidth || canvas.width || 1280;
    const h = canvas.clientHeight || canvas.height || 720;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  onResize();

  // -------------------------------------------------------------------------
  // flythrough(t): chase-height sweep down the full course, banked in turns.
  // -------------------------------------------------------------------------
  const _up = new THREE.Vector3(0, 1, 0);
  function flythrough(t) {
    const tt = Math.min(Math.max(t, 0), 1);
    const z = -20 + tt * (COURSE_LEN - 160); // stay on-course at t = 1
    const x = pathX(z);
    const y = sampleHeight(x, z);
    const dxdz = pathXd(z);
    const dydz = (pathY(z + 20) - pathY(z)) / 20;
    const fwd = new THREE.Vector3(dxdz, dydz, 1).normalize();
    camera.position.set(x - fwd.x * 46, y + 27 - fwd.y * 46, z - fwd.z * 46);
    const laz = z + 120;
    const lax = pathX(laz);
    camera.up.copy(_up);
    camera.lookAt(lax, sampleHeight(lax, laz) + 8, laz);
    // bank into upcoming curvature
    const h0 = Math.atan2(pathXd(z), 1), h1 = Math.atan2(pathXd(z + 60), 1);
    const bank = Math.min(Math.max((h1 - h0) * 2.0, -0.5), 0.5);
    camera.rotateZ(bank);
  }
  flythrough(0);

  return { update, render, scene, camera, renderer, sampleHeight, flythrough };
}
