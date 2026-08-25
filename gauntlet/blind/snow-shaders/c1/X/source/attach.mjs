// ============================================================================
// snow-shaders candidate A — attach.mjs
//
// Raw-GLSL snow package (ShaderMaterial only, procedural + RTT, no textures):
//
//  SURFACE  one shared ShaderMaterial swapped onto every terrain chunk mesh.
//           Wrap diffuse (NdotL + w)/(1 + w) with w = 0.42, blue-shifted
//           ambient, FBM-warped sastrugi micro-normals, hash-cell glints
//           gated on the half-vector (population turns over on camera moves),
//           exact-sRGB encode at the tail (the shader owns the color pipe).
//
//  TRAIL    1024x1024 RGBA8 ping-pong render-target pair covering a 40 m
//           window that follows the rider (3.9 cm/texel). Stamps are radial
//           brushes drawn with MAX blending (re-riding never deepens past the
//           brush cap); window re-centering is a whole-texel scroll copy from
//           one target into the other (the ping-pong). Vertex shader displaces
//           geometry down by the sampled depth; fragment shader relights from
//           finite differences of the same texture.
//           DOCUMENTED ARCADE CHOICE (SV-05): decay is 1.0/frame — grooves
//           persist for the whole run, PS2-SSX style. uDecay in the copy pass
//           is the refill hook if a slow fill-in is ever wanted.
//
//  SPRAY    GPU-resident particle state: RGBA32F position/life + velocity
//           texture pairs (256x128 = 32768 slots), integrated by fragment
//           passes; emission writes GL points onto the state texels; render
//           pass fetches state in the vertex shader. The CPU only books
//           emission slots (ring allocator + per-slot expiry), which is what
//           makes particleCount()/particleSpeeds() honest without readback.
//           Emission rate = C * speed * tan(edge), edge inferred from the
//           rider state's kinematics (yawRate * speed / g); zero when flat
//           or airborne; landing burst on touchdown.
// ============================================================================
import * as THREE from 'three';

const TRAIL_RES = 1024;
const TRAIL_SIZE = 40;              // m — window edge => 3.906 cm/texel
const TEXEL = TRAIL_SIZE / TRAIL_RES;
const DMAX = 0.4;                   // m — max encoded trail depth
const POOL_W = 256, POOL_H = 128;   // 32768 spray slots
const POOL = POOL_W * POOL_H;
const MAX_EMIT = 2048;              // per update() call
const EMIT_C = 550;                 // particles / (m/s * tanEdge * s)
const G = 9.81;

async function loadText(rel) {
  const r = await fetch(new URL(rel, import.meta.url));
  if (!r.ok) throw new Error('shader fetch failed: ' + rel);
  return r.text();
}

export async function attachSnow(scene, renderer, riderRef) {
  const [surfV, surfF, quadV, copyF, stampV, stampF,
    intPosF, intVelF, emitV, emitPosF, emitVelF, ptsV, ptsF] =
    await Promise.all([
      'snow.vert.glsl', 'snow.frag.glsl', 'quad.vert.glsl', 'trail_copy.frag.glsl',
      'trail_stamp.vert.glsl', 'trail_stamp.frag.glsl',
      'spray_pos.frag.glsl', 'spray_vel.frag.glsl',
      'spray_emit.vert.glsl', 'spray_emit_pos.frag.glsl', 'spray_emit_vel.frag.glsl',
      'spray_points.vert.glsl', 'spray_points.frag.glsl',
    ].map(f => loadText('./shaders/' + f)));

  // ---------------------------------------------------------------- helpers
  const oCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const _clearCol = new THREE.Color();
  function withPasses(fn) {
    const rt = renderer.getRenderTarget();
    const ac = renderer.autoClear;
    renderer.autoClear = false;
    fn();
    renderer.setRenderTarget(rt);
    renderer.autoClear = ac;
  }
  function clearRT(rt) {
    const prev = renderer.getRenderTarget();
    const a = renderer.getClearAlpha();
    renderer.getClearColor(_clearCol);
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.setClearColor(_clearCol, a);
    renderer.setRenderTarget(prev);
  }
  function fsTriangle() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    return g;
  }

  // ---------------------------------------------------------------- trail RTs
  const trailOpts = {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  };
  let trailCur = new THREE.WebGLRenderTarget(TRAIL_RES, TRAIL_RES, trailOpts);
  let trailNext = new THREE.WebGLRenderTarget(TRAIL_RES, TRAIL_RES, trailOpts);
  trailCur.texture.generateMipmaps = false;
  trailNext.texture.generateMipmaps = false;

  // window center, snapped to the texel grid so scrolls never resample
  const st0 = riderRef.state;
  const snap = v => Math.round(v / TEXEL) * TEXEL;
  const center = new THREE.Vector2(snap(st0.pos[0]), snap(st0.pos[2]));

  const copyMat = new THREE.ShaderMaterial({
    vertexShader: quadV, fragmentShader: copyF,
    uniforms: {
      uSrc: { value: trailCur.texture },
      uOffset: { value: new THREE.Vector2(0, 0) },
      uDecay: { value: 1.0 },        // documented arcade choice: no refill
    },
    depthTest: false, depthWrite: false,
  });
  const copyScene = new THREE.Scene();
  const copyMesh = new THREE.Mesh(fsTriangle(), copyMat);
  copyMesh.frustumCulled = false;
  copyScene.add(copyMesh);

  const stampMat = new THREE.ShaderMaterial({
    vertexShader: stampV, fragmentShader: stampF,
    uniforms: {
      uCenterUV: { value: new THREE.Vector2(0.5, 0.5) },
      uRadiusUV: { value: 0.01 },
      uVal: { value: 0.5 },
    },
    depthTest: false, depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.MaxEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    transparent: true,
  });
  const stampScene = new THREE.Scene();
  const stampMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), stampMat);
  stampMesh.frustumCulled = false;
  stampScene.add(stampMesh);

  function scrollTo(nx, nz) {
    const sx = snap(nx), sz = snap(nz);
    if (sx === center.x && sz === center.y) return;
    copyMat.uniforms.uSrc.value = trailCur.texture;
    copyMat.uniforms.uOffset.value.set((sx - center.x) / TRAIL_SIZE, (sz - center.y) / TRAIL_SIZE);
    withPasses(() => {
      renderer.setRenderTarget(trailNext);
      renderer.render(copyScene, oCam);
    });
    const t = trailCur; trailCur = trailNext; trailNext = t;
    center.set(sx, sz);
    surfU.uTrail.value = trailCur.texture;
    surfU.uTrailCenter.value.set(sx, sz);
  }

  function stampWorld(x, z, w, depth) {
    const u = (x - center.x) / TRAIL_SIZE + 0.5;
    const v = (z - center.y) / TRAIL_SIZE + 0.5;
    if (u < 0.005 || u > 0.995 || v < 0.005 || v > 0.995) return;
    const radiusW = Math.max(w * 0.7071, TEXEL * 1.2);   // FWHM == w; min ~1 texel
    stampMat.uniforms.uCenterUV.value.set(u, v);
    stampMat.uniforms.uRadiusUV.value = radiusW / TRAIL_SIZE;
    stampMat.uniforms.uVal.value = Math.min(depth, DMAX) / DMAX;
    withPasses(() => {
      renderer.setRenderTarget(trailCur);
      renderer.render(stampScene, oCam);
    });
  }

  // trailHeightAt: manual bilinear over a 2x2 readback of the live target.
  const readBuf = new Uint8Array(16);
  function trailHeightAt(x, z) {
    const u = (x - center.x) / TRAIL_SIZE + 0.5;
    const v = (z - center.y) / TRAIL_SIZE + 0.5;
    if (u <= 0 || u >= 1 || v <= 0 || v >= 1) return 0;
    const fx = u * TRAIL_RES - 0.5, fy = v * TRAIL_RES - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    if (x0 < 0 || y0 < 0 || x0 > TRAIL_RES - 2 || y0 > TRAIL_RES - 2) return 0;
    renderer.readRenderTargetPixels(trailCur, x0, y0, 2, 2, readBuf);
    const tx = fx - x0, ty = fy - y0;
    const a = readBuf[0], b = readBuf[4], c = readBuf[8], d = readBuf[12];
    const top = a + (b - a) * tx, bot = c + (d - c) * tx;
    return (top + (bot - top) * ty) / 255 * DMAX;
  }

  // -------------------------------------------------------------- surface
  const surfU = {
    uSunDir: { value: new THREE.Vector3(0.45, 0.8, 0.3).normalize() },
    uLitCol: { value: new THREE.Vector3(0.97, 0.95, 0.90) },
    uShadowCol: { value: new THREE.Vector3(0.31, 0.385, 0.44) },
    uWrap: { value: 0.42 },          // GPU Gems wrap: (NdotL + w) / (1 + w)
    uTrail: { value: trailCur.texture },
    uTrailCenter: { value: center.clone() },
    uTrailSize: { value: TRAIL_SIZE },
    uTrailDepthMax: { value: DMAX },
    uTrailTexel: { value: TEXEL },
    uFogColor: { value: new THREE.Vector3(0.52, 0.76, 1.0) },
    uFogNear: { value: 3800 },
    uFogFar: { value: 13000 },
    uGlintDensity: { value: 0.045 },
    uGlintGain: { value: 0.9 },
  };
  const surfMat = new THREE.ShaderMaterial({
    vertexShader: surfV, fragmentShader: surfF,
    uniforms: surfU,
    side: THREE.DoubleSide,
  });

  // swap onto the terrain: the material shared by the largest mesh group
  const groups = new Map();
  scene.traverse(o => {
    if (o.isMesh && o.material && o.geometry && o.geometry.attributes &&
        o.geometry.attributes.position) {
      const k = o.material.uuid;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
  });
  let terrainMeshes = null;
  for (const arr of groups.values()) {
    if (!terrainMeshes || arr.length > terrainMeshes.length) terrainMeshes = arr;
  }
  for (const m of terrainMeshes) m.material = surfMat;

  // -------------------------------------------------------------- spray sim
  const simOpts = {
    format: THREE.RGBAFormat, type: THREE.FloatType,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  };
  let posCur = new THREE.WebGLRenderTarget(POOL_W, POOL_H, simOpts);
  let posNext = new THREE.WebGLRenderTarget(POOL_W, POOL_H, simOpts);
  let velCur = new THREE.WebGLRenderTarget(POOL_W, POOL_H, simOpts);
  let velNext = new THREE.WebGLRenderTarget(POOL_W, POOL_H, simOpts);
  for (const rt of [posCur, posNext, velCur, velNext]) rt.texture.generateMipmaps = false;

  const intPosMat = new THREE.ShaderMaterial({
    vertexShader: quadV, fragmentShader: intPosF,
    uniforms: { uPosTex: { value: null }, uVelTex: { value: null }, uDt: { value: 1 / 60 } },
    depthTest: false, depthWrite: false,
  });
  const intVelMat = new THREE.ShaderMaterial({
    vertexShader: quadV, fragmentShader: intVelF,
    uniforms: { uVelTex: { value: null }, uDt: { value: 1 / 60 } },
    depthTest: false, depthWrite: false,
  });
  const intScene = new THREE.Scene();
  const intMesh = new THREE.Mesh(fsTriangle(), intPosMat);
  intMesh.frustumCulled = false;
  intScene.add(intMesh);

  // emission geometry: MAX_EMIT points, dynamic attributes
  const eGeom = new THREE.BufferGeometry();
  const ePos = new THREE.BufferAttribute(new Float32Array(MAX_EMIT * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const eNdc = new THREE.BufferAttribute(new Float32Array(MAX_EMIT * 2), 2).setUsage(THREE.DynamicDrawUsage);
  const eVel = new THREE.BufferAttribute(new Float32Array(MAX_EMIT * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const eLife = new THREE.BufferAttribute(new Float32Array(MAX_EMIT), 1).setUsage(THREE.DynamicDrawUsage);
  const eGround = new THREE.BufferAttribute(new Float32Array(MAX_EMIT), 1).setUsage(THREE.DynamicDrawUsage);
  eGeom.setAttribute('position', ePos);
  eGeom.setAttribute('aNdc', eNdc);
  eGeom.setAttribute('aVel', eVel);
  eGeom.setAttribute('aLife', eLife);
  eGeom.setAttribute('aGround', eGround);
  eGeom.setDrawRange(0, 0);
  const emitPosMat = new THREE.ShaderMaterial({
    vertexShader: emitV, fragmentShader: emitPosF, depthTest: false, depthWrite: false,
  });
  const emitVelMat = new THREE.ShaderMaterial({
    vertexShader: emitV, fragmentShader: emitVelF, depthTest: false, depthWrite: false,
  });
  const emitScene = new THREE.Scene();
  const emitPoints = new THREE.Points(eGeom, emitPosMat);
  emitPoints.frustumCulled = false;
  emitScene.add(emitPoints);

  // visible pool: one point per slot, index in position.x
  const pGeom = new THREE.BufferGeometry();
  const pIdx = new Float32Array(POOL * 3);
  for (let i = 0; i < POOL; i++) pIdx[i * 3] = i;
  pGeom.setAttribute('position', new THREE.BufferAttribute(pIdx, 3));
  const ptsMat = new THREE.ShaderMaterial({
    vertexShader: ptsV, fragmentShader: ptsF,
    uniforms: {
      uPosTex: { value: posCur.texture },
      uVelTex: { value: velCur.texture },
      uTexDim: { value: new THREE.Vector2(POOL_W, POOL_H) },
      uHalfH: { value: 360 },
    },
    transparent: true, depthWrite: false, depthTest: true,
  });
  const points = new THREE.Points(pGeom, ptsMat);
  points.frustumCulled = false;
  points.renderOrder = 10;
  scene.add(points);

  clearRT(trailCur); clearRT(trailNext);
  clearRT(posCur); clearRT(posNext); clearRT(velCur); clearRT(velNext);

  // CPU emission bookkeeping (what makes count/speeds honest)
  const expiry = new Float32Array(POOL);   // sim-time each slot dies
  const birthSpd = new Float32Array(POOL);
  let nextSlot = 0;
  let simTime = 0;
  let rngState = 0x9e3779b9;
  function rand() {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // stage emitted particles into the attribute arrays; flushed by emitFlush()
  let staged = 0;
  function stage(px, py, pz, vx, vy, vz, life, groundY) {
    if (staged >= MAX_EMIT) return;
    const s = nextSlot;
    nextSlot = (nextSlot + 1) % POOL;
    expiry[s] = simTime + life;
    birthSpd[s] = Math.hypot(vx, vy, vz);
    const tx = s % POOL_W, ty = Math.floor(s / POOL_W);
    eNdc.array[staged * 2] = ((tx + 0.5) / POOL_W) * 2 - 1;
    eNdc.array[staged * 2 + 1] = ((ty + 0.5) / POOL_H) * 2 - 1;
    ePos.array[staged * 3] = px; ePos.array[staged * 3 + 1] = py; ePos.array[staged * 3 + 2] = pz;
    eVel.array[staged * 3] = vx; eVel.array[staged * 3 + 1] = vy; eVel.array[staged * 3 + 2] = vz;
    eLife.array[staged] = life;
    eGround.array[staged] = groundY;
    staged++;
  }
  function emitFlush() {
    if (staged === 0) return;
    for (const a of [ePos, eNdc, eVel, eLife, eGround]) a.needsUpdate = true;
    eGeom.setDrawRange(0, staged);
    withPasses(() => {
      emitPoints.material = emitPosMat;
      renderer.setRenderTarget(posCur);
      renderer.render(emitScene, oCam);
      emitPoints.material = emitVelMat;
      renderer.setRenderTarget(velCur);
      renderer.render(emitScene, oCam);
    });
    staged = 0;
  }
  function integrate(dt) {
    intPosMat.uniforms.uDt.value = dt;
    intVelMat.uniforms.uDt.value = dt;
    intPosMat.uniforms.uPosTex.value = posCur.texture;
    intPosMat.uniforms.uVelTex.value = velCur.texture;
    intVelMat.uniforms.uVelTex.value = velCur.texture;
    withPasses(() => {
      intMesh.material = intPosMat;
      renderer.setRenderTarget(posNext);
      renderer.render(intScene, oCam);
      intMesh.material = intVelMat;
      renderer.setRenderTarget(velNext);
      renderer.render(intScene, oCam);
    });
    let t = posCur; posCur = posNext; posNext = t;
    t = velCur; velCur = velNext; velNext = t;
    ptsMat.uniforms.uPosTex.value = posCur.texture;
    ptsMat.uniforms.uVelTex.value = velCur.texture;
  }

  // ------------------------------------------------------------- update loop
  let lastStamp = null;             // [x, z] of last trail stamp
  let prevOnGround = !!st0.onGround;
  let emitAcc = 0;

  function update(dt) {
    if (!(dt > 0)) dt = 1 / 60;
    simTime += dt;
    const st = riderRef.state;
    const px = st.pos[0], py = st.pos[1], pz = st.pos[2];
    const vx = st.vel[0], vy = st.vel[1], vz = st.vel[2];
    const speed = Math.hypot(vx, vz);
    const onGround = !!st.onGround;
    const yawRate = st.yawRate || 0;
    const edgeTan = onGround ? Math.min(Math.abs(yawRate) * speed / G, 3.7) : 0;
    const k = Math.min(edgeTan, 1.5) / 1.5;

    // trail window follows the rider (hysteresis so we don't blit every frame)
    if (Math.abs(px - center.x) > 0.75 || Math.abs(pz - center.y) > 0.75) {
      scrollTo(px, pz);
    }

    // rider trail: stamps marched along the board's motion
    if (onGround && speed > 2) {
      const wca = 0.34 + 0.5 * k, dca = 0.085 + 0.055 * k;
      if (!lastStamp) {
        lastStamp = [px, pz];
        stampWorld(px, pz, wca, dca);
      } else {
        let dx = px - lastStamp[0], dz = pz - lastStamp[1];
        let dist = Math.hypot(dx, dz);
        let guard = 0;
        while (dist >= 0.15 && guard++ < 64) {
          const s = 0.15 / dist;
          lastStamp[0] += dx * s; lastStamp[1] += dz * s;
          stampWorld(lastStamp[0], lastStamp[1], wca, dca);
          dx = px - lastStamp[0]; dz = pz - lastStamp[1];
          dist = Math.hypot(dx, dz);
        }
      }
    } else {
      lastStamp = null;
    }

    // ---- spray emission -------------------------------------------------
    const heading = st.heading || 0;
    const fx = Math.cos(heading), fz = Math.sin(heading);
    const lx = -fz, lz = fx;                       // board-left
    const outSign = yawRate >= 0 ? -1 : 1;         // fling to the turn's outside
    const gY = py - 0.03;

    let n = 0;
    if (onGround && speed > 3 && edgeTan > 0.02) {
      const rate = EMIT_C * speed * edgeTan;
      emitAcc += rate * dt;
      n = Math.floor(emitAcc);
      emitAcc -= n;
    } else {
      emitAcc = 0;
    }
    let burst = 0;
    if (onGround && !prevOnGround && vy < -1.5) {
      burst = Math.min(1200, Math.round(300 + 80 * Math.abs(vy)));
    }
    prevOnGround = onGround;

    const total = Math.min(n + burst, MAX_EMIT);
    for (let i = 0; i < total; i++) {
      const isBurst = i >= total - burst;
      const r1 = rand(), r2 = rand(), r3 = rand(), r4 = rand();
      const ex = px + fx * (r1 - 0.35) * 1.6 + lx * (r2 - 0.5) * 0.5;
      const ez = pz + fz * (r1 - 0.35) * 1.6 + lz * (r2 - 0.5) * 0.5;
      const ey = py + 0.06 + r3 * 0.1;
      let evx, evy, evz, life;
      if (isBurst) {
        const a = r2 * Math.PI * 2, sp = 2.5 + 5 * r3;
        evx = Math.cos(a) * sp + vx * 0.2;
        evz = Math.sin(a) * sp + vz * 0.2;
        evy = (0.55 + 0.4 * r4) * sp * 0.6 + 1.2;
        life = 0.55 + 0.35 * r1;
      } else if (r4 < 0.18) {
        // sparse fast ballistic grains
        const sp = 10 + 9 * r3;
        evx = lx * outSign * sp * 0.8 + fx * sp * 0.25 + vx * 0.2;
        evz = lz * outSign * sp * 0.8 + fz * sp * 0.25 + vz * 0.2;
        evy = 2.5 + 3.5 * r2;
        life = 1.05 + 0.35 * r1;
      } else {
        // dense slow curtain
        const sp = 1.6 + 2.8 * r3;
        evx = lx * outSign * sp + fx * (r2 - 0.4) * 1.5 + vx * 0.2;
        evz = lz * outSign * sp + fz * (r2 - 0.4) * 1.5 + vz * 0.2;
        evy = 1.2 + 2.4 * r2;
        life = 0.55 + 0.35 * r1;
      }
      stage(ex, ey, ez, evx, evy, evz, life, gY);
    }

    integrate(dt);
    emitFlush();
  }

  // ---------------------------------------------------------------- debug
  function particleCount() {
    let c = 0;
    for (let i = 0; i < POOL; i++) if (expiry[i] > simTime) c++;
    return c;
  }
  function particleSpeeds() {
    const out = [];
    for (let i = 0; i < POOL; i++) if (expiry[i] > simTime) out.push(birthSpd[i]);
    return new Float32Array(out);
  }

  return {
    update,
    uniforms: surfU,
    debug: {
      trailHeightAt,
      stamp(x, z, w) {
        const depth = Math.min(0.10 + 0.05 * w, 0.34);
        stampWorld(x, z, w, depth);
      },
      particleCount,
      particleSpeeds,
      setSunDir(x, y, z) {
        surfU.uSunDir.value.set(x, y, z).normalize();
      },
    },
  };
}
