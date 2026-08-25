// terrain.mjs — tiled heightfield mesh with distance-to-path LOD, merged per LOD level.
//
// Structure (see main.mjs header for the argument): the domain is cut into 160 m tiles;
// each tile's grid resolution is picked by its distance to the course polyline
// (28 -> 14 -> 7 -> 3 verts/side). Every tile gets a downward skirt ring so mixed-res
// seams never show cracks. All tiles of one LOD level are merged into a single
// BufferGeometry => the whole mountain is 4 draw calls.
//
// Lighting is BAKED into vertex colors (sun + blue sky ambient), rendered with
// MeshBasicMaterial: zero real-time lights, SwiftShader-cheap, and gives exact
// control of the SSX palette — bright high-key snow, blue-shifted shadows.

import * as THREE from 'three';
import { sampleHeight, sampleNormal, courseX, hash2ish } from './heightfield.mjs';

export { buildTerrain };

const TILE = 160;
const X_MIN = -2080, X_MAX = 2080;
const Z_MIN = -480, Z_MAX = 3680;
const SKIRT = 30;

function buildTerrain(scene) {
  // Path polyline for LOD distance queries
  const pathPts = [];
  for (let z = -100; z <= 3150; z += 50) pathPts.push([courseX(z), z]);

  const buckets = new Map(); // res -> {pos, col, idx, base}
  const bucketFor = res => {
    let b = buckets.get(res);
    if (!b) { b = { pos: [], col: [], idx: [], base: 0 }; buckets.set(res, b); }
    return b;
  };

  const n = [0, 0, 0], c = [0, 0, 0];

  for (let tx = X_MIN; tx < X_MAX; tx += TILE) {
    for (let tz = Z_MIN; tz < Z_MAX; tz += TILE) {
      const cx = tx + TILE / 2, cz = tz + TILE / 2;
      let d = Infinity;
      for (const p of pathPts) {
        const dd = Math.hypot(p[0] - cx, p[1] - cz);
        if (dd < d) d = dd;
      }
      const res = d < 190 ? 28 : d < 420 ? 14 : d < 820 ? 7 : 3;
      const b = bucketFor(res);
      emitTile(b, tx, tz, res, n, c);
    }
  }

  let tris = 0;
  for (const [, b] of buckets) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
    g.setIndex(b.idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.DoubleSide,
    }));
    m.matrixAutoUpdate = false;
    scene.add(m);
    tris += b.idx.length / 3;
  }
  return { tris, levels: buckets.size };
}

function emitTile(b, x0, z0, res, n, c) {
  const w = res + 1;
  const step = TILE / res;
  const base = b.base;

  // grid vertices
  for (let i = 0; i < w; i++) {
    for (let j = 0; j < w; j++) {
      const x = x0 + j * step, z = z0 + i * step;
      const y = sampleHeight(x, z);
      sampleNormal(x, z, n);
      shade(x, z, y, n, c);
      b.pos.push(x, y, z);
      b.col.push(c[0], c[1], c[2]);
    }
  }
  // grid indices
  for (let i = 0; i < res; i++) {
    for (let j = 0; j < res; j++) {
      const a = base + i * w + j;
      b.idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
    }
  }
  b.base += w * w;

  // skirt: border loop (CCW from above), duplicated SKIRT meters down.
  const loop = [];
  for (let j = 0; j < w; j++) loop.push(base + j);                    // north edge
  for (let i = 1; i < w; i++) loop.push(base + i * w + (w - 1));      // east edge
  for (let j = w - 2; j >= 0; j--) loop.push(base + (w - 1) * w + j); // south edge
  for (let i = w - 2; i >= 1; i--) loop.push(base + i * w);           // west edge

  const skirtBase = b.base;
  for (const vi of loop) {
    const px = b.pos[vi * 3], py = b.pos[vi * 3 + 1], pz = b.pos[vi * 3 + 2];
    b.pos.push(px, py - SKIRT, pz);
    b.col.push(b.col[vi * 3] * 0.75, b.col[vi * 3 + 1] * 0.78, b.col[vi * 3 + 2] * 0.85);
  }
  const L = loop.length;
  for (let k = 0; k < L; k++) {
    const a = loop[k], bb = loop[(k + 1) % L];
    const a2 = skirtBase + k, b2 = skirtBase + ((k + 1) % L);
    b.idx.push(a, bb, b2, a, b2, a2); // DoubleSide material — winding not critical
  }
  b.base += L;
}

// --- baked lighting -------------------------------------------------------
// Sun: warm, high; ambient: saturated sky blue => shadows go blue, never black.
const SUN = [0.58, 0.52, 0.30];   // lower sun => stronger modeling, longer blue shadows
{ const l = 1 / Math.hypot(...SUN); SUN[0] *= l; SUN[1] *= l; SUN[2] *= l; }
const SUN_COL = [1.42, 1.28, 1.00];
const SKY_COL = [0.20, 0.33, 0.66]; // saturated skylight => blue-shifted shadows
const SNOW = [0.95, 0.99, 1.06];
const GROOM = [0.58, 0.86, 1.25];   // clearly cyan groomed corridor
const ROCK = [0.34, 0.29, 0.26];

function shade(x, z, y, n, out) {
  const ndl = Math.max(n[0] * SUN[0] + n[1] * SUN[1] + n[2] * SUN[2], 0);
  const dx = x - courseX(z);
  const gully = Math.exp(-(dx * dx) / (2 * 230 * 230));

  // rock shows through where it is steep (cliff bands on the ridges)
  const steep = Math.min(Math.max((0.58 - n[1]) / 0.16, 0), 1);
  const groom = gully * 0.8;
  // corduroy bands along the corridor so the groomed line reads from the air
  const cord = 1 + Math.sin(dx * 0.9) * 0.10 * gully;

  // per-vertex sparkle so big snowfields do not band
  const sp = (1 + (hash2ish(Math.round(x * 3.1), Math.round(z * 3.1)) - 0.5) * 0.07) * cord;

  for (let k = 0; k < 3; k++) {
    const alb = ((SNOW[k] + (GROOM[k] - SNOW[k]) * groom) * (1 - steep) + ROCK[k] * steep) * sp;
    const light = SUN_COL[k] * ndl + SKY_COL[k] * (0.62 + 0.38 * Math.max(n[1], 0));
    out[k] = alb * light;
  }
  return out;
}
