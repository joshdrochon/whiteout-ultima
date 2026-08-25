// ===========================================================================
// snow-shaders candidate B — attach.mjs
//
// Motion-first snow package, raw GLSL only (ShaderMaterial; no NodeMaterial,
// no external textures — everything procedural + RTT):
//
//  * SURFACE: wrap-diffuse snow (GPU Gems ch.16), hemispherical blue skylight
//    (shadows blue, never black), sparse threshold-gated cell-hash glints,
//    depth-driven blue SSS on berm lips. Geometric normals from screen-space
//    derivatives (terrain geometry ships no normal attribute), trench normals
//    finite-differenced from the trail texture in the fragment shader.
//  * TRAIL: ping-pong float render-target heightmap (768^2 over a 48 m
//    window, 6.25 cm/texel) that scrolls with the rider by integer texels.
//    Per-frame multiplicative refill decay; stamps are max(existing, brush).
//    Flow-warped brush: slip angle widens and shallows the stamp (skid),
//    clean carving cuts narrow and deep, scaled by edge intensity.
//  * SPRAY: 26k-slot GPU ring buffer rendered as THREE.Points. Trajectories
//    integrate in CLOSED FORM in the vertex shader (state lives in vertex
//    buffers; no per-particle JS per frame — JS only appends spawn records).
//    Two populations: dense slow mist curtain + sparse fast chunky rooster
//    grains. Emission rate = RATE_MAX * speed01^0.8 * edge01^1.3, zero when
//    flat-based or airborne; landing touchdown fires a burst.
//
// Edge intensity is recovered from rider STATE (not integrated motion):
//    a_lat = |yawRate| * speed,  edgeAngle = atan(a_lat / g)
// which is the exact inverse of the harness's kinematically-consistent carve
// condition, so edge01 in [0,1] maps 0..60 deg of board edge.
// ===========================================================================
import * as THREE from 'three';

const TRAIL_RES = 768;
const TRAIL_WORLD = 48;                    // m
const TEXEL = TRAIL_WORLD / TRAIL_RES;     // 0.0625 m/texel (SV-08 band 2-8 cm)
const MAX_DEPTH = 0.32;                    // m of trench at brush strength 1
const LIP_H = 0.13;                        // m of displaced ridge lip (critique #1)
const DECAY_F32 = 0.99985;                 // per frame -> ~58%/min survives (SV-05)

const POOL = 26624;                        // spray ring slots
const MIST_LIFE = 0.7, CHUNK_LIFE = 1.1;   // s (fixed per population: exact live counts)
const CHUNK_FRAC = 0.18;
const RATE_MAX = 20000;                    // particles/s at full speed + full edge
const G_SPRAY = 7.5;                       // m/s^2, slightly floaty spray gravity

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function attachSnow(scene, renderer, riderRef) {
  const names = ['surface.vert.glsl', 'surface.frag.glsl', 'trail.vert.glsl',
    'trail.frag.glsl', 'spray.vert.glsl', 'spray.frag.glsl'];
  const [surfVS, surfFS, trailVS, trailFS, sprayVS, sprayFS] = await Promise.all(
    names.map(n => fetch(new URL('./shaders/' + n, import.meta.url)).then(r => {
      if (!r.ok) throw new Error('shader fetch failed: ' + n);
      return r.text();
    })));

  // ---- trail render targets (ping-pong; SV-04) ----------------------------
  const gl = renderer.getContext();
  const floatOk = !!(gl.getExtension && gl.getExtension('EXT_color_buffer_float'));
  // Byte fallback keeps depth in 8 bits; multiplicative decay would quantize
  // to a stall there, so the fallback documents the "arcade choice": no refill.
  const rtType = floatOk ? THREE.FloatType : THREE.UnsignedByteType;
  const DECAY = floatOk ? DECAY_F32 : 1.0;
  const readScale = floatOk ? 1 : 1 / 255;
  const mkRT = () => new THREE.WebGLRenderTarget(TRAIL_RES, TRAIL_RES, {
    type: rtType, format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
  let rtFront = mkRT(), rtBack = mkRT();  // front = current state, read by materials

  const st0 = (riderRef && riderRef.state) || {};
  const p0 = st0.pos || [0, 0, 0];
  let originTX = Math.round(p0[0] / TEXEL) - TRAIL_RES / 2;   // window corner, texels
  let originTZ = Math.round(p0[2] / TEXEL) - TRAIL_RES / 2;

  const stampVecs = [];
  for (let i = 0; i < 8; i++) stampVecs.push(new THREE.Vector4());
  const trailU = {
    uPrev: { value: rtBack.texture },
    uDecay: { value: DECAY },
    uShift: { value: new THREE.Vector2(0, 0) },
    uRes: { value: new THREE.Vector2(TRAIL_RES, TRAIL_RES) },
    uStamps: { value: stampVecs },
    uCount: { value: 0 },
  };
  const trailMat = new THREE.ShaderMaterial({
    vertexShader: trailVS, fragmentShader: trailFS, uniforms: trailU,
    depthTest: false, depthWrite: false,
  });
  const quadScene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), trailMat);
  quad.frustumCulled = false;
  quadScene.add(quad);
  const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ---- snow surface material ----------------------------------------------
  const surfU = {
    uTrail: { value: rtFront.texture },
    uTrailOrigin: { value: new THREE.Vector2(originTX * TEXEL, originTZ * TEXEL) },
    uTrailWorld: { value: TRAIL_WORLD },
    uTexel: { value: TEXEL },
    uMaxDepth: { value: MAX_DEPTH },
    uLipHeight: { value: LIP_H },
    uSunDir: { value: new THREE.Vector3(0.45, 0.8, 0.3).normalize() },
    // critique #5: saturated high-key — warmer sun, bluer sky ambient, deeper
    // fog blue. Sky B/R kept so shadow B/R excess stays inside SV-03's 0.2-0.6.
    uSunCol: { value: new THREE.Vector3(1.16, 1.04, 0.89) },
    uSkyCol: { value: new THREE.Vector3(0.36, 0.415, 0.483) },
    uAlbedo: { value: new THREE.Vector3(0.955, 0.975, 1.0) },
    uWrap: { value: 0.5 },
    uExposure: { value: 1.1 },
    uGlint: { value: new THREE.Vector4(22.0, 0.75, 0.948, 5.0) },
    uGlintRarity: { value: 0.42 },
    uFogCol: { value: new THREE.Vector3(0.62, 0.78, 1.0) },
    uFogRange: { value: new THREE.Vector2(3800, 13000) },
  };
  const snowMat = new THREE.ShaderMaterial({
    vertexShader: surfVS, fragmentShader: surfFS, uniforms: surfU,
    side: THREE.DoubleSide,
  });

  // Replace the terrain material: the largest group of meshes sharing one
  // material is the terrain chunk set (inner corridor + backdrop tiles).
  {
    const groups = new Map();
    scene.traverse(o => {
      if (o.isMesh && o.material && o.geometry && o.geometry.attributes
        && o.geometry.attributes.position) {
        const k = o.material.uuid;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(o);
      }
    });
    let best = null;
    for (const arr of groups.values()) if (!best || arr.length > best.length) best = arr;
    if (!best) throw new Error('no terrain meshes found');
    for (const m of best) m.material = snowMat;
  }

  // ---- spray particle system ----------------------------------------------
  const d0 = new Float32Array(POOL * 4);   // spawn pos + spawn time
  const d1 = new Float32Array(POOL * 4);   // spawn vel + life
  const d2 = new Float32Array(POOL * 4);   // size, seed, population, _
  for (let i = 0; i < POOL; i++) d0[i * 4 + 3] = -1e9;  // everything born dead
  const sprayGeom = new THREE.BufferGeometry();
  sprayGeom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(POOL * 3), 3));
  const a0 = new THREE.BufferAttribute(d0, 4);
  const a1 = new THREE.BufferAttribute(d1, 4);
  const a2 = new THREE.BufferAttribute(d2, 4);
  a0.setUsage(THREE.DynamicDrawUsage);
  a1.setUsage(THREE.DynamicDrawUsage);
  a2.setUsage(THREE.DynamicDrawUsage);
  sprayGeom.setAttribute('aData0', a0);
  sprayGeom.setAttribute('aData1', a1);
  sprayGeom.setAttribute('aData2', a2);
  sprayGeom.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const sprayU = {
    uTime: { value: 0 },
    uG: { value: G_SPRAY },
    uHalfResY: { value: (renderer.domElement && renderer.domElement.height ? renderer.domElement.height : 720) / 2 },
    uSunDir: surfU.uSunDir,
    uExposure: surfU.uExposure,
  };
  const sprayMat = new THREE.ShaderMaterial({
    vertexShader: sprayVS, fragmentShader: sprayFS, uniforms: sprayU,
    transparent: true, depthWrite: false,
  });
  const sprayPoints = new THREE.Points(sprayGeom, sprayMat);
  sprayPoints.frustumCulled = false;
  sprayPoints.renderOrder = 10;
  scene.add(sprayPoints);

  // ---- module state -------------------------------------------------------
  let simTime = 0;
  let cursor = 0;                 // spray ring write head
  let emitAcc = 0;
  let prevOnGround = true;
  const events = [];              // {t, m, c}: per-frame emission record -> exact live counts
  const stampQueue = [];          // world-space pending stamps (debug + rider)
  const rng = mulberry32(0xB00B5EED);
  const readBuf = floatOk ? new Float32Array(16) : new Uint8Array(16);

  function writeP(px, py, pz, vx, vy, vz, life, size, seed, pop) {
    const s = cursor; cursor = (cursor + 1) % POOL;
    const o = s * 4;
    d0[o] = px; d0[o + 1] = py; d0[o + 2] = pz; d0[o + 3] = simTime;
    d1[o] = vx; d1[o + 1] = vy; d1[o + 2] = vz; d1[o + 3] = life;
    d2[o] = size; d2[o + 1] = seed; d2[o + 2] = pop; d2[o + 3] = 0;
  }
  function markRanges(start, n) {
    if (n <= 0) return;
    const seg = (from, cnt) => {
      for (const a of [a0, a1, a2]) a.addUpdateRange(from * 4, cnt * 4);
    };
    if (start + n <= POOL) seg(start, n);
    else { seg(start, POOL - start); seg(0, n - (POOL - start)); }
    a0.needsUpdate = true; a1.needsUpdate = true; a2.needsUpdate = true;
  }

  // Critique cycle 1 mustFix #2: spray must be ROOTED at the board contact,
  // not a detached billow cluster. Every particle now spawns on the board's
  // contact segment (tail-biased, at snow level), with velocities that fan
  // outboard + up + trailing from that root — a rooster tail growing out of
  // the carve, with the dense mist curtain hugging the ground behind it.
  function emitCarve(n, st, pos, vel, speed, edge01) {
    const hRad = st.heading || 0;
    const c = Math.cos(hRad), s = Math.sin(hRad);
    const side = (st.yawRate || 0) >= 0 ? 1 : -1;   // spray flings outboard
    const rx = -s * side, rz = c * side;            // outboard lateral dir
    const ey = pos[1] + 0.03;                       // board contact height
    const kick = 0.4 + 0.6 * edge01;                // edge angle drives drama
    const nChunk = Math.round(n * CHUNK_FRAC), nMist = n - nChunk;
    const start = cursor;
    for (let i = 0; i < nMist; i++) {
      // contact segment along the board, tail-biased (t in ~[-0.75, +0.45])
      const t = 0.45 - 1.2 * Math.pow(rng(), 0.6);
      const ob = 0.10 + 0.14 * rng();               // just off the edge
      writeP(pos[0] + c * t + rx * ob, ey + 0.04 * rng(), pos[2] + s * t + rz * ob,
        0.35 * vel[0] + rx * (0.9 + 2.0 * rng() * kick) + (rng() - 0.5) * 0.6,
        0.8 + 2.2 * rng() * kick,
        0.35 * vel[2] + rz * (0.9 + 2.0 * rng() * kick) + (rng() - 0.5) * 0.6,
        MIST_LIFE, 0.07 + 0.08 * rng(), rng() * 10, 0);
    }
    for (let i = 0; i < nChunk; i++) {
      const t = -0.35 - 0.45 * rng();               // rooster tail leaves the tail
      const ob = 0.08 + 0.10 * rng();
      writeP(pos[0] + c * t + rx * ob, ey + 0.03 * rng(), pos[2] + s * t + rz * ob,
        0.80 * vel[0] + rx * (1.7 + 3.2 * rng()) * kick + (rng() - 0.5) * 0.6,
        (2.6 + 3.8 * rng()) * (0.45 + 0.55 * edge01),
        0.80 * vel[2] + rz * (1.7 + 3.2 * rng()) * kick + (rng() - 0.5) * 0.6,
        CHUNK_LIFE, 0.20 + 0.16 * rng(), rng() * 10, 1);
    }
    markRanges(start, n);
    events.push({ t: simTime, m: nMist, c: nChunk });
  }

  function emitBurst(pos, vel) {
    const n = 700, nChunk = 280, nMist = n - nChunk;
    const start = cursor;
    const impact = Math.min(Math.abs(vel[1] || 0) * 0.3, 3) + 1;
    for (let i = 0; i < nMist; i++) {
      const a = rng() * Math.PI * 2, r = 1.2 + 2.4 * rng();
      writeP(pos[0] + (rng() - 0.5) * 0.5, pos[1] + 0.03, pos[2] + (rng() - 0.5) * 0.5,
        Math.cos(a) * r + 0.4 * vel[0], (1.8 + 2.6 * rng()) * impact * 0.6,
        Math.sin(a) * r + 0.4 * vel[2],
        MIST_LIFE, 0.10 + 0.09 * rng(), rng() * 10, 0);
    }
    for (let i = 0; i < nChunk; i++) {
      const a = rng() * Math.PI * 2, r = 2.2 + 3.6 * rng();
      writeP(pos[0] + (rng() - 0.5) * 0.3, pos[1] + 0.03, pos[2] + (rng() - 0.5) * 0.3,
        Math.cos(a) * r + 0.4 * vel[0], (2.8 + 3.8 * rng()) * impact * 0.6,
        Math.sin(a) * r + 0.4 * vel[2],
        CHUNK_LIFE, 0.22 + 0.15 * rng(), rng() * 10, 1);
    }
    markRanges(start, n);
    events.push({ t: simTime, m: nMist, c: nChunk });
  }

  function liveCount() {
    while (events.length && simTime - events[0].t >= CHUNK_LIFE) events.shift();
    let n = 0;
    for (const e of events) {
      const age = simTime - e.t;
      if (age < MIST_LIFE) n += e.m;
      n += e.c;                     // events older than CHUNK_LIFE already pruned
    }
    return n;
  }

  // ---- trail pass ---------------------------------------------------------
  function runTrailPasses(shiftX, shiftZ) {
    let first = true;
    do {
      const batch = stampQueue.splice(0, 8);
      for (let i = 0; i < 8; i++) {
        if (i < batch.length) {
          const b = batch[i];
          // snap stamp center to a texel center: keeps a minimum-width debug
          // stamp inside one texel regardless of world alignment (SV-08 FWHM)
          const tx = Math.floor((b.x - originTX * TEXEL) / TEXEL) + 0.5;
          const tz = Math.floor((b.z - originTZ * TEXEL) / TEXEL) + 0.5;
          stampVecs[i].set(tx, tz, Math.max(b.r / TEXEL, 0.75), b.s);
        } else stampVecs[i].set(0, 0, 0, 0);
      }
      trailU.uCount.value = Math.min(batch.length, 8);
      trailU.uDecay.value = first ? DECAY : 1.0;
      trailU.uShift.value.set(first ? shiftX : 0, first ? shiftZ : 0);
      trailU.uPrev.value = rtFront.texture;
      const prevRT = renderer.getRenderTarget();
      renderer.setRenderTarget(rtBack);
      renderer.render(quadScene, quadCam);
      renderer.setRenderTarget(prevRT);
      const t = rtFront; rtFront = rtBack; rtBack = t;
      first = false;
    } while (stampQueue.length > 0);
    surfU.uTrail.value = rtFront.texture;
    surfU.uTrailOrigin.value.set(originTX * TEXEL, originTZ * TEXEL);
  }

  // ---- per-frame update ---------------------------------------------------
  function update(dt) {
    dt = (Number.isFinite(dt) && dt > 0) ? dt : 1 / 60;
    simTime += dt;
    const st = (riderRef && riderRef.state) || {};
    const pos = st.pos || [0, 0, 0];
    const vel = st.vel || [0, 0, 0];
    const onG = !!st.onGround;
    const yawRate = Number(st.yawRate) || 0;
    const speed = Math.hypot(vel[0], vel[2]);
    const aLat = Math.abs(yawRate) * speed;
    const edge01 = Math.min(Math.atan2(aLat, 9.81) / (Math.PI / 3), 1); // 0..60deg -> 0..1

    // window scroll (integer texels)
    const wantTX = Math.round(pos[0] / TEXEL) - TRAIL_RES / 2;
    const wantTZ = Math.round(pos[2] / TEXEL) - TRAIL_RES / 2;
    const shiftX = wantTX - originTX, shiftZ = wantTZ - originTZ;
    originTX = wantTX; originTZ = wantTZ;

    // rider brush: slip widens + shallows (skid), edge cuts narrow + deep
    // (carve). Base width/strength raised from cycle 1 so the groove reads
    // as a chunky trench from the chase camera (critique #1), not a 1-2 texel
    // pencil line: ~0.9 m plateau-profile core, near-full depth while carving.
    if (onG && speed > 0.3) {
      const velDir = Math.atan2(vel[2], vel[0]);
      let slip = (st.heading || 0) - velDir;
      slip = Math.atan2(Math.sin(slip), Math.cos(slip));
      const sinSlip = Math.abs(Math.sin(slip));
      const width = 0.88 + 0.20 * Math.min(speed / 25, 1)
                  + 1.0 * sinSlip - 0.16 * edge01 * (1 - sinSlip);
      const strength = Math.min(1,
        (0.62 + 0.28 * edge01 + 0.22 * Math.min(speed / 25, 1)) * (1 - 0.35 * sinSlip));
      const c = Math.cos(st.heading || 0), s = Math.sin(st.heading || 0);
      const r = Math.max(width / 2, 0.75 * TEXEL);
      stampQueue.push({ x: pos[0], z: pos[2], r, s: strength });
      stampQueue.push({ x: pos[0] - c * 0.5, z: pos[2] - s * 0.5, r, s: strength * 0.92 });
    }
    runTrailPasses(shiftX, shiftZ);

    // spray emission (state-driven; zero flat-based or airborne)
    let rate = 0;
    if (onG && speed > 1 && edge01 > 0.02)
      rate = RATE_MAX * Math.pow(Math.min(speed / 25, 1), 0.8) * Math.pow(edge01, 1.3);
    emitAcc += rate * dt;
    const n = Math.floor(emitAcc); emitAcc -= n;
    if (n > 0) emitCarve(n, st, pos, vel, speed, edge01);
    if (onG && !prevOnGround) emitBurst(pos, vel);   // landing burst
    prevOnGround = onG;
    sprayU.uTime.value = simTime;
  }

  // ---- debug hooks (contract) ---------------------------------------------
  const debug = {
    trailHeightAt(x, z) {
      const tx = (x - originTX * TEXEL) / TEXEL;
      const tz = (z - originTZ * TEXEL) / TEXEL;
      if (tx < 0.5 || tz < 0.5 || tx > TRAIL_RES - 0.5 || tz > TRAIL_RES - 0.5) return 0;
      const x0 = Math.max(0, Math.min(TRAIL_RES - 2, Math.floor(tx - 0.5)));
      const z0 = Math.max(0, Math.min(TRAIL_RES - 2, Math.floor(tz - 0.5)));
      renderer.readRenderTargetPixels(rtFront, x0, z0, 2, 2, readBuf);
      const fx = Math.max(0, Math.min(1, tx - 0.5 - x0));
      const fz = Math.max(0, Math.min(1, tz - 0.5 - z0));
      const v = (ix, iz) => readBuf[(iz * 2 + ix) * 4] * readScale;
      const h = (v(0, 0) * (1 - fx) + v(1, 0) * fx) * (1 - fz)
              + (v(0, 1) * (1 - fx) + v(1, 1) * fx) * fz;
      return h * MAX_DEPTH;
    },
    stamp(x, z, w) {
      stampQueue.push({ x, z, r: Math.max(w / 2, 0.75 * TEXEL), s: 1.0 });
    },
    particleCount: () => liveCount(),
    particleSpeeds() {
      const out = [];
      for (let i = 0; i < POOL; i++) {
        const o = i * 4;
        const age = simTime - d0[o + 3];
        if (age < 0 || age >= d1[o + 3] || d1[o + 3] <= 0) continue;
        out.push(Math.hypot(d1[o], d1[o + 1] - G_SPRAY * age, d1[o + 2]));
      }
      return Float32Array.from(out);
    },
    setSunDir(x, y, z) { surfU.uSunDir.value.set(x, y, z).normalize(); },
  };

  return {
    update,
    uniforms: { ...surfU, uTime: sprayU.uTime, uG: sprayU.uG },
    debug,
  };
}
