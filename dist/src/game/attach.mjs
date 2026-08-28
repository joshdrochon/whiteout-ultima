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
//  * TRAIL: ping-pong float render-target heightmap (1600^2 over a 48 m
//    window, 3 cm/texel) that scrolls with the rider by integer texels.
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

// Critique cycle 2 mustFix #4: the old 6.25 cm texels needed a texel-center
// snap in the stamp path to keep a min-width stamp's FWHM inside SV-08's
// 2-8 cm band. The snap is GONE (stamps are exact world positions now); the
// band is met by resolution instead: at 3 cm/texel a minimum stamp covers
// 1-2 texels at ANY world alignment -> FWHM 3-6 cm.
const TRAIL_RES = 1600;
const TRAIL_WORLD = 48;                    // m
const TEXEL = TRAIL_WORLD / TRAIL_RES;     // 0.03 m/texel (SV-08 band 2-8 cm)
const MAX_DEPTH = 0.44;                    // m of trench at brush strength 1
                                           // (compose round 3: deeper walls so
                                           // the groove relights visibly from
                                           // the chase camera, not a flat stripe)
const LIP_H = 0.07;                        // m of ridge lip (round 2 iter 11: 0.13 m jittered-stamp lips displaced into chains of white balls beside the groove)
const DECAY_F32 = 0.99985;                 // per frame -> ~58%/min survives (SV-05)

// Critique cycle 2 mustFix #2: shorter lives + lower velocity inheritance
// (see emitCarve) keep the plume rooted at the board contact; RATE_MAX rises
// to hold the SV-09 10k+ live floor at the shorter lifetimes.
const POOL = 26624;                        // spray ring slots
const MIST_LIFE = 0.34, CHUNK_LIFE = 0.60; // s (fixed per population: exact live counts)
// Round 2 iter 3: chunks at 60 Hz emission were spacing into neat chains of
// white balls (one cluster every ~0.4 m of travel). Fewer, smaller, shorter-
// lived grains -> granular rooster streak instead of a ball chain.
const CHUNK_FRAC = 0.09;                   // sparse ballistic rooster grains
// Compose round 3: the run now holds edge01 = 1.0 through every apex, so the
// emitter must stay readable at FULL edge (the old 21k/s at full lock was the
// blind rounds' spray whiteout). Rate cut ~half; the plume reads as a fanning
// bimodal rooster, not a screen-filling wall.
const RATE_MAX = 10500;                    // particles/s at full speed + full edge
const G_SPRAY = 9.6;                       // m/s^2, snappy ballistic arcs (no hang)

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
    uOrigin: { value: new THREE.Vector2(originTX, originTZ) },
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
    // Round 2 (blind critic: "no readable sun direction anywhere"): the sun
    // drops from near-zenith to a RAKING angle — lateral +x and downhill +z —
    // so the gully's two walls split into a hot lit face and a blue shadow
    // face, and every roller carries a readable light/shade gradient.
    uSunDir: { value: new THREE.Vector3(0.55, 0.55, 0.30).normalize() },
    // rider board-contact blob shadow: xy = world XZ, z = strength (fades with
    // air height), w = radius (grows slightly with air height)
    uRider: { value: new THREE.Vector4(0, 0, 0, 1.2) },
    // Remediation cycle 4 (converged critique: washed pastel -> SSX high-key):
    // WARM sun (gold-tinted lit snow), sky ambient pushed toward saturated
    // blue with B separated over G (not just B over R), so shadows read
    // unmistakably blue while staying inside SV-03's 0.2-0.6 B/R-excess band
    // (aimed at the saturated end) and the 35-55% shadow-luminance band.
    // Cycle 5: uSkyCol rebalanced against the new shadow-region hue push in
    // surface.frag (x0.86 R, x1.02 G, x1.16 B at full shadow): combined
    // full-shadow B/R lands ~1.50 pre-tonemap, holding SV-03 near the
    // saturated end of its band, while the raised G channel keeps the
    // on-screen shadow an icy blue that survives ACES.
    // Compose pass (blind critic): lit snow was warm cream (R>B ~242/240/237).
    // SSX snow must read WHITE-BLUE in final sRGB, so the composed rig runs a
    // COOL sun (B over R even at full dif) instead of the sandbox's gold sun,
    // and a blue-dominant sky ambient — the old uSkyCol had G ABOVE B, which
    // was the exact green cast the critic flagged in shadows.
    // Round 2 iter 2: sun/sky contrast pushed hard — full-shadow faces drop to
    // ~55% luminance and go decisively blue, lit faces stay high-key white-blue.
    uSunCol: { value: new THREE.Vector3(1.16, 1.24, 1.40) },
    uSkyCol: { value: new THREE.Vector3(0.24, 0.29, 0.42) },
    uAlbedo: { value: new THREE.Vector3(0.92, 0.96, 1.0) },
    uWrap: { value: 0.16 },
    // Round 2 iter 6: exposure pulled out of the ACES shoulder. At 1.0 the
    // lit field sat ~1.05 pre-tonemap where ACES compresses a 40% light cut
    // into ~12 sRGB units — the whole scene read flat pastel no matter what
    // the lighting did. At 0.85 lit snow still lands high-key (~230) but
    // shadows/bands finally separate by 30-50 units.
    uExposure: { value: 0.85 },
    // glints: near-invisible at output exposure -> gain 6 -> 11; radius bump
    // lives in surface.frag. Density/threshold unchanged (pixel frac stays 1-5%).
    // Round 2 iter 3: the 0.95 rarity + gain 11 combo speckled every distant
    // wall like film grain (subpixel cells -> some cell always fires). Sparkle
    // is a NEAR-FIELD cue: far fewer eligible cells, softer gain, and the
    // fragment shader now fades glints out past ~60 m.
    uGlint: { value: new THREE.Vector4(22.0, 0.75, 0.885, 3.0) },
    uGlintRarity: { value: 0.35 },
    // fog tinted deeper blue so shadowed faces stay blue at EVERY distance —
    // the old 0.56/0.77 haze washed far shadow blue toward neutral
    uFogCol: { value: new THREE.Vector3(0.42, 0.65, 0.99) },
    // Compose round 3 ("fog blowout kills the ridgeline"): onset pushed out
    // 140 -> 300 m, far 2200 -> 3600 m, and surface.frag caps fog blend at
    // 0.85 so distant terrain NEVER fully merges into the sky — the upslope
    // ridgeline silhouette survives at every distance.
    // Far edge pulled 3600 -> 1600 m. At the valley cliff (~800 m) the old range
    // delivered only ~5% haze, leaving it rgb[117,145,183] / luminance 141 against
    // ~190 foreground snow — the "flat desaturated grey against the saturated
    // foreground" the integration judge flagged. Near edge unchanged at 300 m, so
    // the corridor and all near-field detail are untouched.
    uFogRange: { value: new THREE.Vector2(300, 1600) },
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

  // ---- sky + fog saturation (cycle 4 palette push) -------------------------
  // The critique's "saturated blue sky gradient" lives on the render loop's
  // vertex-colored sky dome; augment it in place: steepen the gradient so
  // deep saturated blue reaches down toward the horizon, and pull the fog /
  // horizon color to a matching saturated SSX blue. Defensive: only touches
  // a BackSide vertex-colored mesh (the dome); silently skips if absent.
  try {
    scene.traverse(o => {
      if (o.isMesh && o.material && o.material.side === THREE.BackSide
        && o.geometry && o.geometry.attributes && o.geometry.attributes.color
        && o.geometry.attributes.position) {
        const pos = o.geometry.attributes.position;
        const col = o.geometry.attributes.color;
        const r = o.geometry.boundingSphere ? Math.max(o.geometry.boundingSphere.radius, 1) : 9000;
        const zen = [0.02, 0.20, 1.12], hor = [0.09, 0.31, 1.02];
        for (let i = 0; i < pos.count; i++) {
          let t = Math.min(1, Math.max(0, (pos.getY(i) / r + 0.03) / 0.26));
          t = t * t * (3 - 2 * t);
          col.setXYZ(i,
            hor[0] + (zen[0] - hor[0]) * t,
            hor[1] + (zen[1] - hor[1]) * t,
            hor[2] + (zen[2] - hor[2]) * t);
        }
        col.needsUpdate = true;
      }
    });
    if (scene.fog && scene.fog.color) {
      scene.fog.color.setRGB(0.42, 0.65, 0.99);
      scene.fog.near = 300; scene.fog.far = 1600;  // match uFogRange
    }
    if (renderer.setClearColor) renderer.setClearColor(0x3487ec, 1); // horizon fill
  } catch { /* sky augmentation is cosmetic; never fail attach over it */ }

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
  const rngBrush = mulberry32(0x5EEDB0B);   // trail jitter: independent stream
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

  // Critique cycle 2 mustFix #2: spray ROOTED at the board contact. The old
  // emitter inherited 0.35x/0.80x of a 25 m/s rider velocity over 0.7-1.1 s
  // lifetimes — particles drifted 6-22 m downstream, so the plume centroid
  // sat detached behind the board. Now: mist inherits 0.18x over 0.55 s
  // (curtain stays within ~2 m of the contact and dominates the centroid,
  // 80% of particles), chunks inherit 0.50x over 0.9 s (the rooster tail
  // still arcs back with drama but stays visually attached through the dense
  // curtain at its root). Size variance widened (chunk sizes 3x spread);
  // size/opacity falloff over life lives in the spray shaders.
  // Compose pass (blind critic: "spray reads as stationary cumulus"). The old
  // emitter piled huge sprites at the contact; the plume had no motion axis.
  // Now the emission is ELONGATED ALONG RIDER VELOCITY: the mist curtain is a
  // comet streak laid down the travel line behind the board (near-zero
  // inheritance -> the streak is the rider's own motion made visible), and the
  // chunks are sparse ballistic rooster grains flung up/outboard off the tail,
  // ~1-in-7 an OUTLIER crud launched much harder — the classic rooster tail:
  // dense at the board, tapering arc of stragglers behind and above.
  function emitCarve(n, st, pos, vel, speed, edge01) {
    const hRad = st.heading || 0;
    const c = Math.cos(hRad), s = Math.sin(hRad);
    const side = (st.yawRate || 0) >= 0 ? 1 : -1;   // spray flings outboard
    const rx = -s * side, rz = c * side;            // outboard lateral dir
    const ey = pos[1] + 0.03;                       // board contact height
    const kick = 0.4 + 0.6 * edge01;                // edge angle drives drama
    const sp = Math.max(speed, 1);
    const bx = -vel[0] / sp, bz = -vel[2] / sp;     // backward along travel line
    const nChunk = Math.round(n * CHUNK_FRAC), nMist = n - nChunk;
    const start = cursor;
    for (let i = 0; i < nMist; i++) {
      // two mist roles (round 2 iter 5): 65% ground-hugging comet streak laid
      // back down the travel line (motion made visible), 35% CARVE FAN sheet
      // flung hard outboard+up off the edge — the dramatic SSX carve wall.
      const fan = rng() < 0.35;
      // iter 9: fan spawns are SPREAD along ~2 m of the travel line with wide
      // lateral/size/velocity jitter — same-size sprites landing ~0.4 m apart
      // every 60 Hz step were chaining into rows of discrete white balls
      // compose round 4 ("spray fully occludes the rider mid-carve"): spawns
      // biased BEHIND and BESIDE the board — min back offset 0.55/0.85 m and
      // min outboard 0.30 m for the fan — and the fan's up-kick is trimmed so
      // the sheet peaks at hip height, not over the rider's head. The plume
      // stays rooted at the contact but leaves the silhouette readable.
      const back = (fan ? 0.55 : 0.85) + (fan ? 1.8 : 3.0) * Math.pow(rng(), 1.6);
      const w = back / 3.85;
      const ob = fan ? 0.30 + 0.55 * rng() : 0.10 + (0.12 + 0.5 * w) * rng();
      const latV = fan ? (2.6 + 5.0 * rng()) * kick : (0.7 + 1.6 * rng() * kick);
      const upV = fan ? (1.5 + 2.6 * rng()) * kick
                      : (0.9 + 2.1 * rng() * kick) * (1.0 - 0.3 * w);
      writeP(pos[0] + bx * back + rx * ob, ey + (0.04 + 0.4 * w) * rng(),
        pos[2] + bz * back + rz * ob,
        0.08 * vel[0] + rx * latV + (rng() - 0.5) * 1.5,
        upV,
        0.08 * vel[2] + rz * latV + (rng() - 0.5) * 1.5,
        MIST_LIFE, fan ? 0.10 + 0.12 * rng() : 0.10 + 0.10 * rng(), rng() * 10, 0);
    }
    for (let i = 0; i < nChunk; i++) {
      const out = rng() < 0.14;                     // sparse hard-flung crud
      const latK = out ? 1.9 : 1.0, upK = out ? 1.4 : 1.0;
      const t = -0.30 - 0.55 * rng();               // rooster tail leaves the tail
      const ob = 0.06 + 0.10 * rng();
      writeP(pos[0] + c * t + rx * ob, ey + 0.03 * rng(), pos[2] + s * t + rz * ob,
        0.38 * vel[0] + rx * (1.4 + 2.8 * rng()) * kick * latK + (rng() - 0.5) * 1.6,
        (1.6 + 2.6 * rng()) * kick * upK,
        0.38 * vel[2] + rz * (1.4 + 2.8 * rng()) * kick * latK + (rng() - 0.5) * 1.6,
        CHUNK_LIFE, (0.045 + 0.05 * rng()) * (out ? 1.5 : 1.0), rng() * 10, 1);
    }
    markRanges(start, n);
    events.push({ t: simTime, m: nMist, c: nChunk });
  }

  // Compose round 3: burst launch speeds cut ~40% — the big-air touchdown
  // (vy ~ -12 m/s) was firing chunks 10+ m into the sky, which then hung over
  // the next two capture frames as unexplained white balls against the sky.
  // The burst is now a wide LOW curtain around the impact.
  // Compose round 4 (r3 mustFix: "detached spray cloud hovers at head height
  // behind the rider" two frames after touchdown): the burst is now a GROUND-
  // HUGGING splash ring — vertical launch speeds cut to ~40% of round 3's and
  // chunk count trimmed, so every burst particle stays below ~knee height for
  // its whole life instead of loitering as sky balls over the next frames.
  function emitBurst(pos, vel) {
    const n = 420, nChunk = 70, nMist = n - nChunk;
    const start = cursor;
    const impact = Math.min(Math.abs(vel[1] || 0) * 0.18, 1.6) + 1;
    for (let i = 0; i < nMist; i++) {
      const a = rng() * Math.PI * 2, r = 1.2 + 2.4 * rng();
      writeP(pos[0] + (rng() - 0.5) * 0.5, pos[1] + 0.03, pos[2] + (rng() - 0.5) * 0.5,
        Math.cos(a) * r + 0.3 * vel[0], (0.9 + 1.3 * rng()) * impact * 0.4,
        Math.sin(a) * r + 0.3 * vel[2],
        MIST_LIFE, 0.12 + 0.13 * rng(), rng() * 10, 0);
    }
    for (let i = 0; i < nChunk; i++) {
      const a = rng() * Math.PI * 2, r = 1.6 + 2.8 * rng();
      writeP(pos[0] + (rng() - 0.5) * 0.3, pos[1] + 0.03, pos[2] + (rng() - 0.5) * 0.3,
        Math.cos(a) * r + 0.3 * vel[0], (1.1 + 1.6 * rng()) * impact * 0.28,
        Math.sin(a) * r + 0.3 * vel[2],
        CHUNK_LIFE, 0.08 + 0.09 * rng(), rng() * 10, 1);
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
          // EXACT world position -> continuous texel coordinates. No snapping
          // of any kind (critique cycle 2 mustFix #4): the stamp lands where
          // the world-space call requested; the SV-08 texel band is carried by
          // the 3 cm resolution, not by conditioning the input.
          const tx = (b.x - originTX * TEXEL) / TEXEL;
          const tz = (b.z - originTZ * TEXEL) / TEXEL;
          stampVecs[i].set(tx, tz, Math.max(b.r / TEXEL, 0.75), b.s);
        } else stampVecs[i].set(0, 0, 0, 0);
      }
      trailU.uCount.value = Math.min(batch.length, 8);
      trailU.uDecay.value = first ? DECAY : 1.0;
      trailU.uShift.value.set(first ? shiftX : 0, first ? shiftZ : 0);
      trailU.uOrigin.value.set(originTX, originTZ);   // world-stable churn key
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
    // (carve). ~1.05 m plateau-profile core, near-full depth while carving
    // (cycle 1 #1). Cycle 2 #5: per-stamp jitter in radius, strength and
    // lateral offset roughens the groove into churned ragged edges (the trail
    // pass adds deterministic noise on top); this jitter uses its OWN rng so
    // spray behavior is untouched.
    if (onG && speed > 0.3) {
      const velDir = Math.atan2(vel[2], vel[0]);
      let slip = (st.heading || 0) - velDir;
      slip = Math.atan2(Math.sin(slip), Math.cos(slip));
      const sinSlip = Math.abs(Math.sin(slip));
      const width = 1.30 + 0.26 * Math.min(speed / 25, 1)
                  + 1.0 * sinSlip - 0.18 * edge01 * (1 - sinSlip);
      const strength = Math.min(1,
        (0.66 + 0.26 * edge01 + 0.20 * Math.min(speed / 25, 1)) * (1 - 0.35 * sinSlip));
      const c = Math.cos(st.heading || 0), s = Math.sin(st.heading || 0);
      const r0 = Math.max(width / 2, 0.75 * TEXEL);
      // Compose round 3: jitter cut hard (0.16 m lateral / 24% radius -> 0.05 m
      // / 8%). Per-stamp wobble at 60 Hz was breaking the groove into a chain
      // of discrete dots; a steady brush at >= 75% stamp overlap (r ~ 0.65 m
      // vs 0.33 m/step at 20 m/s) fuses into one continuous carved trench.
      const j1 = (rngBrush() - 0.5) * 0.05, j2 = (rngBrush() - 0.5) * 0.05;
      stampQueue.push({ x: pos[0] - s * j1, z: pos[2] + c * j1,
        r: r0 * (0.96 + 0.08 * rngBrush()), s: strength * (0.96 + 0.04 * rngBrush()) });
      stampQueue.push({ x: pos[0] - c * 0.5 - s * j2, z: pos[2] - s * 0.5 + c * j2,
        r: r0 * (0.96 + 0.08 * rngBrush()), s: strength * 0.96 });
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

    // rider blob shadow: grounds the rider on the snow (round 2 mustFix —
    // "every object floats on an unshaded white field"). Strength fades and
    // radius swells as the rider airs out; groundY is fed by the host rig
    // (riderRef.groundY); fall back to the board contact when absent.
    const gy = (riderRef && Number.isFinite(riderRef.groundY)) ? riderRef.groundY : pos[1];
    const hAir = Math.max(0, pos[1] - gy);
    surfU.uRider.value.set(pos[0], pos[2],
      Math.max(0.25, 0.95 - 0.08 * hAir), 1.3 + 0.22 * Math.min(hAir, 4));
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
