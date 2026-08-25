// ============================================================================
// baseline-snow — deliberately plain but contract-complete shader candidate.
// Exists ONLY to validate harness/shader-runner.mjs end to end. Plain is fine,
// broken is not.
//
//   * Snow surface: raw-GLSL ShaderMaterial replacing the terrain material.
//     Lambert+wrap diffuse (w = 0.55), blue skylight ambient, sparse
//     view-dependent glints, sRGB encode in-shader.
//   * Trail: 1024^2 float ping-pong RTT heightmap over a 40 m window that
//     follows the rider (3.9 cm/texel). max(existing, brush) stamping,
//     0.9999/frame multiplicative refill, vertex displacement + normals
//     finite-differenced from the trail texture in the fragment shader.
//   * Spray: GPU point sprites (16384 ring buffer). Trajectories integrated
//     in the vertex shader from birth state; CPU only writes emitted slots.
//     Emission ~ speed x edge intensity (|yawRate|*speed) when grounded,
//     burst on landing, two populations (dense slow curtain + sparse fast
//     ballistic grains).
//   * Deterministic: seeded mulberry32, no Math.random, no Date reads.
// ============================================================================
import * as THREE from 'three';

const TRES = 1024;          // trail texture resolution
const HALF = 20;            // trail window half-extent (m) -> 40 m / 1024 = 3.9 cm/texel
const MAX_DEPTH = 0.35;     // m of snow displaced at trail value 1
const DECAY = 0.9999;       // per-frame multiplicative refill (snowflow-ish)
const CAP = 16384;          // spray ring-buffer capacity
const SEED = 0xba5e11;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function loadShader(name) {
  const res = await fetch(new URL(`./shaders/${name}`, import.meta.url));
  if (!res.ok) throw new Error(`shader load failed: ${name}`);
  return res.text();
}

export async function attachSnow(scene, renderer, riderRef) {
  const [snowVert, snowFrag, quadVert, trailFrag, sprayVert, sprayFrag] = await Promise.all([
    loadShader('snow.vert.glsl'), loadShader('snow.frag.glsl'),
    loadShader('quad.vert.glsl'), loadShader('trail_update.frag.glsl'),
    loadShader('spray.vert.glsl'), loadShader('spray.frag.glsl'),
  ]);

  // ---- find the terrain: the material shared by the most meshes ------------
  const groups = new Map();
  scene.traverse(o => {
    if (o.isMesh && o.geometry?.attributes?.position && o.material && !Array.isArray(o.material)) {
      const g = groups.get(o.material.uuid) ?? { meshes: [] };
      g.meshes.push(o);
      groups.set(o.material.uuid, g);
    }
  });
  let terrain = null;
  for (const g of groups.values()) if (!terrain || g.meshes.length > terrain.meshes.length) terrain = g;
  if (!terrain || terrain.meshes.length < 2) throw new Error('no terrain mesh group found');

  // ---- trail ping-pong render targets --------------------------------------
  const gl = renderer.getContext();
  const hasFloat = !!gl.getExtension('EXT_color_buffer_float');
  const rtOpts = {
    type: hasFloat ? THREE.FloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  };
  let rtCur = new THREE.WebGLRenderTarget(TRES, TRES, rtOpts);
  let rtNext = new THREE.WebGLRenderTarget(TRES, TRES, rtOpts);
  const prevColor = new THREE.Color();
  const clearRT = rt => {
    const prevRT = renderer.getRenderTarget();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, false, false);
    renderer.setRenderTarget(prevRT);
    renderer.setClearColor(prevColor, prevAlpha);
  };
  clearRT(rtCur); clearRT(rtNext);

  const texelWorld = (2 * HALF) / TRES;
  const snap = v => Math.round(v / texelWorld) * texelWorld;
  const st0 = riderRef?.state ?? {};
  let center = { x: snap(st0.pos?.[0] ?? 0), z: snap(st0.pos?.[2] ?? 0) };

  const trailMat = new THREE.ShaderMaterial({
    vertexShader: quadVert, fragmentShader: trailFrag,
    uniforms: {
      uPrev: { value: rtCur.texture },
      uShift: { value: new THREE.Vector2(0, 0) },
      uDecay: { value: DECAY },
      uStampCount: { value: 0 },
      uStamps: { value: Array.from({ length: 16 }, () => new THREE.Vector4()) },
      uCenter: { value: new THREE.Vector2(center.x, center.z) },
      uHalf: { value: HALF },
      uMinRadius: { value: texelWorld },
    },
    depthTest: false, depthWrite: false,
  });
  const quadGeo = new THREE.BufferGeometry();
  quadGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quadScene = new THREE.Scene();
  const quadMesh = new THREE.Mesh(quadGeo, trailMat);
  quadMesh.frustumCulled = false;
  quadScene.add(quadMesh);
  const quadCam = new THREE.Camera();

  // ---- snow surface material -----------------------------------------------
  const snowMat = new THREE.ShaderMaterial({
    vertexShader: snowVert, fragmentShader: snowFrag,
    uniforms: {
      uTrail: { value: rtCur.texture },
      uTrailCenter: { value: new THREE.Vector2(center.x, center.z) },
      uTrailHalf: { value: HALF },
      uMaxDepth: { value: MAX_DEPTH },
      uTexel: { value: new THREE.Vector2(1 / TRES, 1 / TRES) },
      uSunDir: { value: new THREE.Vector3(0.45, 0.8, 0.3).normalize() },
      uGlintThr: { value: 0.9895 },
    },
    side: THREE.DoubleSide,
  });
  for (const m of terrain.meshes) m.material = snowMat;

  // ---- spray point cloud ---------------------------------------------------
  const posArr = new Float32Array(CAP * 3);
  const velArr = new Float32Array(CAP * 3);
  const birthArr = new Float32Array(CAP * 2);   // birthTime, life (life 0 = dead)
  const kindArr = new Float32Array(CAP);
  for (let i = 0; i < CAP; i++) { posArr[i * 3 + 1] = -9999; birthArr[i * 2 + 1] = 0; }
  const sprayGeo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(posArr, 3);
  const aVel = new THREE.BufferAttribute(velArr, 3);
  const aBirth = new THREE.BufferAttribute(birthArr, 2);
  const aKind = new THREE.BufferAttribute(kindArr, 1);
  sprayGeo.setAttribute('position', aPos);
  sprayGeo.setAttribute('aBirthVel', aVel);
  sprayGeo.setAttribute('aBirth', aBirth);
  sprayGeo.setAttribute('aKind', aKind);
  sprayGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
  const sprayMat = new THREE.ShaderMaterial({
    vertexShader: sprayVert, fragmentShader: sprayFrag,
    uniforms: { uTime: { value: 0 } },
    transparent: true, depthWrite: false,
  });
  const spray = new THREE.Points(sprayGeo, sprayMat);
  spray.frustumCulled = false;
  scene.add(spray);

  // CPU-side birth bookkeeping (for particleCount / particleSpeeds only —
  // motion never runs on the CPU)
  const cpuBirthT = new Float32Array(CAP).fill(-1);
  const cpuLife = new Float32Array(CAP);
  const cpuSpeed = new Float32Array(CAP);
  let cursor = 0;

  const rng = mulberry32(SEED);
  let simTime = 0;
  let emitAcc = 0;
  let prevGround = st0.onGround ?? true;
  const debugStamps = [];

  function emit(n, st) {
    if (n <= 0) return;
    const h = st.heading ?? 0;
    const fwd = [Math.cos(h), 0, Math.sin(h)];
    const side = (st.yawRate ?? 0) >= 0 ? 1 : -1;
    const out = [-Math.sin(h) * -side, 0, Math.cos(h) * -side]; // outside of the turn
    const speed = Math.hypot(st.vel?.[0] ?? 0, st.vel?.[2] ?? 0);
    const sNorm = Math.min(1.3, speed / 25);
    for (let k = 0; k < n; k++) {
      const kind = rng() < 0.15 ? 1 : 0;   // 15% sparse fast ballistic grains
      const s0 = kind === 1 ? 5.5 + 6 * rng() : (1.2 + 2.2 * rng()) * (0.5 + 0.5 * sNorm);
      const upF = kind === 1 ? 0.55 + 0.35 * rng() : 0.35 + 0.3 * rng();
      const outF = Math.sqrt(Math.max(0, 1 - upF * upF));
      const jx = (rng() - 0.5) * 0.6, jz = (rng() - 0.5) * 0.6;
      const vx = (out[0] * outF + jx) * s0 + fwd[0] * speed * 0.15;
      const vy = upF * s0;
      const vz = (out[2] * outF + jz) * s0 + fwd[2] * speed * 0.15;
      const i = cursor;
      posArr[i * 3] = (st.pos?.[0] ?? 0) + (rng() - 0.5) * 0.5;
      posArr[i * 3 + 1] = (st.pos?.[1] ?? 0) + 0.05;
      posArr[i * 3 + 2] = (st.pos?.[2] ?? 0) + (rng() - 0.5) * 0.5;
      velArr[i * 3] = vx; velArr[i * 3 + 1] = vy; velArr[i * 3 + 2] = vz;
      const life = kind === 1 ? 0.7 + 0.4 * rng() : 1.0 + 0.6 * rng();
      birthArr[i * 2] = simTime; birthArr[i * 2 + 1] = life;
      kindArr[i] = kind;
      cpuBirthT[i] = simTime; cpuLife[i] = life; cpuSpeed[i] = Math.hypot(vx, vy, vz);
      cursor = (cursor + 1) % CAP;
    }
    aPos.needsUpdate = true; aVel.needsUpdate = true; aBirth.needsUpdate = true; aKind.needsUpdate = true;
  }

  function runTrailPass(shiftU, shiftV, stamps) {
    trailMat.uniforms.uPrev.value = rtCur.texture;
    trailMat.uniforms.uShift.value.set(shiftU, shiftV);
    trailMat.uniforms.uCenter.value.set(center.x, center.z);
    trailMat.uniforms.uStampCount.value = Math.min(16, stamps.length);
    for (let i = 0; i < Math.min(16, stamps.length); i++) {
      const s = stamps[i];
      trailMat.uniforms.uStamps.value[i].set(s.x, s.z, s.r, s.d);
    }
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(rtNext);
    renderer.render(quadScene, quadCam);
    renderer.setRenderTarget(prevRT);
    const tmp = rtCur; rtCur = rtNext; rtNext = tmp;
    snowMat.uniforms.uTrail.value = rtCur.texture;
    snowMat.uniforms.uTrailCenter.value.set(center.x, center.z);
  }

  function update(dt) {
    simTime += dt;
    const st = riderRef?.state ?? {};
    const pos = st.pos ?? [0, 0, 0];
    const speed = Math.hypot(st.vel?.[0] ?? 0, st.vel?.[2] ?? 0);

    // window recenter (toroidal-in-spirit: content shifted, new area cleared)
    const oldC = { ...center };
    if (Math.hypot(pos[0] - center.x, pos[2] - center.z) > 2) {
      center = { x: snap(pos[0]), z: snap(pos[2]) };
    }
    const shiftU = (center.x - oldC.x) / (2 * HALF);
    const shiftV = (center.z - oldC.z) / (2 * HALF);

    // stamps: rider board when grounded and moving, plus queued debug stamps
    const stamps = [];
    const aLat = Math.abs(st.yawRate ?? 0) * speed;
    if (st.onGround && speed > 0.5) {
      stamps.push({ x: pos[0], z: pos[2], r: 0.22, d: Math.min(1, 0.35 + aLat / 14) });
    }
    while (debugStamps.length && stamps.length < 16) stamps.push(debugStamps.shift());
    runTrailPass(shiftU, shiftV, stamps);

    // spray emission: ~0 flat-based, monotonic in edge x speed, landing burst
    let rate = 0;
    if (st.onGround && speed > 0.8) {
      rate = 9000 * Math.min(1.3, speed / 25) * Math.pow(Math.min(1.4, aLat / 14), 1.3);
    }
    emitAcc += rate * dt;
    let n = Math.floor(emitAcc);
    emitAcc -= n;
    if (!prevGround && st.onGround) {
      n += Math.min(1600, Math.round(140 * Math.abs(st.vel?.[1] ?? 0)) + 150);
    }
    emit(Math.min(n, 700), st);
    prevGround = !!st.onGround;

    sprayMat.uniforms.uTime.value = simTime;
  }

  // ---- debug hooks (contract-required) -------------------------------------
  const readBuf = hasFloat ? new Float32Array(4) : new Uint8Array(4);
  function trailHeightAt(x, z) {
    const u = (x - center.x) / (2 * HALF) + 0.5;
    const v = (z - center.z) / (2 * HALF) + 0.5;
    if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return 0;
    const tx = Math.min(TRES - 1, Math.floor(u * TRES));
    const ty = Math.min(TRES - 1, Math.floor(v * TRES));
    renderer.readRenderTargetPixels(rtCur, tx, ty, 1, 1, readBuf);
    const raw = hasFloat ? readBuf[0] : readBuf[0] / 255;
    return raw * MAX_DEPTH;
  }

  function particleCount() {
    let c = 0;
    for (let i = 0; i < CAP; i++) {
      if (cpuBirthT[i] >= 0 && simTime - cpuBirthT[i] < cpuLife[i]) c++;
    }
    return c;
  }
  function particleSpeeds() {
    const out = [];
    for (let i = 0; i < CAP && out.length < 4000; i++) {
      if (cpuBirthT[i] >= 0 && simTime - cpuBirthT[i] < cpuLife[i]) out.push(cpuSpeed[i]);
    }
    return out;
  }

  return {
    update,
    uniforms: snowMat.uniforms,
    debug: {
      trailHeightAt,
      stamp(x, z, w) { debugStamps.push({ x, z, r: Math.max(w * 0.5, texelWorld * 0.5), d: 1.0 }); },
      particleCount,
      setSunDir(x, y, z) { snowMat.uniforms.uSunDir.value.set(x, y, z).normalize(); },
      particleSpeeds,   // optional hook: SV-11 velocity histogram
    },
  };
}
