// decor.mjs — sky dome, sun, clouds, forests, rock outcrops, course furniture.
// Everything is instanced or merged: whole decor set is ~8 draw calls.
// All scattering uses the seeded mulberry32 PRNG — deterministic build.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleHeight, sampleNormal, courseX, mulberry32, SEED } from './heightfield.mjs';

export function buildDecor(scene) {
  const rand = mulberry32(SEED ^ 0xbeef);
  buildSky(scene);
  buildSun(scene);
  const cloudGroup = buildClouds(scene, rand);
  buildTrees(scene, rand);
  buildRocks(scene, rand);
  buildGates(scene);
  buildPads(scene);
  buildBackdrop(scene, rand);
  return { cloudGroup };
}

// -- sky: vertex-colored dome, saturated zenith blue -> pale horizon ---------
function buildSky(scene) {
  const g = new THREE.SphereGeometry(6500, 20, 14);
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(Math.max(pos.getY(i) / 6500, 0), 1); // 0 horizon, 1 zenith
    const k = Math.pow(t, 0.55);
    col[i * 3 + 0] = 0.56 + (0.07 - 0.56) * k;
    col[i * 3 + 1] = 0.76 + (0.30 - 0.76) * k;
    col[i * 3 + 2] = 1.06 + (0.98 - 1.06) * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.BackSide, fog: false,
  }));
  m.position.set(0, 400, 1500);
  m.matrixAutoUpdate = false; m.updateMatrix();
  m.frustumCulled = false;
  scene.add(m);
}

function buildSun(scene) {
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(230, 20),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.0, 1.6), fog: false }),
  );
  m.position.set(0.42 * 5600, 400 + 0.72 * 5600, 1500 + 0.32 * 5600);
  m.lookAt(0, 400, 1500);
  m.matrixAutoUpdate = false; m.updateMatrix();
  scene.add(m);
}

function buildClouds(scene, rand) {
  const parts = [];
  for (let i = 0; i < 14; i++) {
    const g = new THREE.IcosahedronGeometry(1, 1);
    g.scale(60 + rand() * 90, 11 + rand() * 9, 28 + rand() * 34);
    g.translate((rand() - 0.5) * 3200, 1550 + rand() * 420, 100 + rand() * 3200);
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  const mesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.35, 1.37, 1.42), fog: false,
  }));
  mesh.frustumCulled = false;
  const group = new THREE.Group();
  group.add(mesh);
  scene.add(group);
  return group;
}

// -- forests below the treeline, off the course corridor ---------------------
function buildTrees(scene, rand) {
  const cone = new THREE.ConeGeometry(2.3, 7.5, 7, 1, true);
  cone.translate(0, 1.0 + 3.75, 0);
  const trunk = new THREE.CylinderGeometry(0.25, 0.38, 1.6, 5);
  trunk.translate(0, 0.8, 0);
  paintConst(cone, 0.05, 0.30, 0.12);
  paintConst(trunk, 0.22, 0.13, 0.07);
  const tree = mergeGeometries([trunk, cone]);

  const N = 520;
  const inst = new THREE.InstancedMesh(tree,
    new THREE.MeshBasicMaterial({ vertexColors: true }), N);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), n = [0, 0, 0];
  let placed = 0, guard = 0;
  while (placed < N && guard++ < 20000) {
    const x = -1900 + rand() * 3800;
    const z = 1500 + rand() * 2100; // lower mountain
    const dx = Math.abs(x - courseX(z));
    if (dx < 250 || dx > 1400) continue;
    const y = sampleHeight(x, z);
    if (y > 780) continue;               // treeline
    sampleNormal(x, z, n);
    if (n[1] < 0.66) continue;           // too steep
    const sc = 0.7 + rand() * 0.8;
    q.setFromAxisAngle(up, rand() * Math.PI * 2);
    s.set(sc, sc * (0.9 + rand() * 0.3), sc);
    M.compose(new THREE.Vector3(x, y - 0.3, z), q, s);
    inst.setMatrixAt(placed++, M);
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  scene.add(inst);
}

// -- rock outcrops on steep high ground --------------------------------------
function buildRocks(scene, rand) {
  const g = new THREE.DodecahedronGeometry(2.6, 0);
  const N = 150;
  const inst = new THREE.InstancedMesh(g,
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.38, 0.40, 0.48) }), N);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const n = [0, 0, 0];
  let placed = 0, guard = 0;
  while (placed < N && guard++ < 20000) {
    const x = -1900 + rand() * 3800;
    const z = -300 + rand() * 3400;
    const dx = Math.abs(x - courseX(z));
    if (dx < 200) continue;
    const y = sampleHeight(x, z);
    if (y < 650) continue;
    sampleNormal(x, z, n);
    if (n[1] > 0.72) continue; // want steep faces
    q.setFromEuler(new THREE.Euler(rand() * 3, rand() * 3, rand() * 3));
    const sc = 1 + rand() * 3.5;
    s.set(sc * (1 + rand()), sc, sc * (1 + rand()));
    M.compose(new THREE.Vector3(x, y, z), q, s);
    inst.setMatrixAt(placed++, M);
  }
  inst.count = placed;
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  scene.add(inst);
}

// -- slalom gates: paired poles + colored banner across the course -----------
function buildGates(scene) {
  const nGates = 24;
  const poles = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.16, 0.16, 6, 5),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.96, 1.0) }),
    nGates * 2);
  const banners = new THREE.InstancedMesh(
    new THREE.BoxGeometry(10.6, 1.15, 0.14),
    new THREE.MeshBasicMaterial({}),
    nGates);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  const red = new THREE.Color(0.92, 0.07, 0.10), yel = new THREE.Color(1.0, 0.72, 0.03);

  for (let i = 0; i < nGates; i++) {
    const z = 120 + i * 120;
    const xc = courseX(z);
    const tX = (courseX(z + 2) - courseX(z - 2)) / 4, tZ = 1;
    const tl = Math.hypot(tX, tZ);
    const px = -tZ / tl, pz = tX / tl; // perpendicular in XZ
    const yaw = Math.atan2(-pz, px) + Math.PI / 2; // box X-axis along perp

    for (const sgn of [-1, 1]) {
      const x = xc + px * 5.3 * sgn, zz = z + pz * 5.3 * sgn;
      const y = sampleHeight(x, zz);
      M.compose(new THREE.Vector3(x, y + 3, zz), q.identity(), one);
      poles.setMatrixAt(i * 2 + (sgn > 0 ? 1 : 0), M);
    }
    const yTop = sampleHeight(xc, z) + 5.4;
    q.setFromAxisAngle(up, yaw);
    M.compose(new THREE.Vector3(xc, yTop, z), q, one);
    banners.setMatrixAt(i, M);
    banners.setColorAt(i, i % 2 ? yel : red);
  }
  poles.instanceMatrix.needsUpdate = true;
  banners.instanceMatrix.needsUpdate = true;
  if (banners.instanceColor) banners.instanceColor.needsUpdate = true;
  poles.frustumCulled = banners.frustumCulled = false;
  scene.add(poles); scene.add(banners);
}

// -- boost pads: dashed bright-orange line straight down the course ----------
function buildPads(scene) {
  const N = 50;
  const inst = new THREE.InstancedMesh(
    new THREE.BoxGeometry(3.6, 0.35, 5.2),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(1.35, 0.55, 0.04) }),
    N);
  const M = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    const z = 40 + i * 59;
    const xc = courseX(z);
    const tX = (courseX(z + 2) - courseX(z - 2)) / 4;
    q.setFromAxisAngle(up, Math.atan2(tX, 1));
    M.compose(new THREE.Vector3(xc, sampleHeight(xc, z) + 0.05, z), q, one);
    inst.setMatrixAt(i, M);
  }
  inst.instanceMatrix.needsUpdate = true;
  inst.frustumCulled = false;
  scene.add(inst);
}

function paintConst(geom, r, g, b) {
  const n = geom.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; }
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
