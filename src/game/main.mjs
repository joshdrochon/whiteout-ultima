// ===========================================================================
// INTEGRATION RIG — src/game/main.mjs
//
// Assembles the accepted lane winners into one playable rig behind the SAME
// contract as the render lane, so harness/capture.mjs drives it unchanged:
//   boot(canvas) -> { update, render, scene, camera, renderer,
//                     sampleHeight, flythrough }
//
// Wiring:
//   * render.mjs  — accepted render loop (terrain, sky, LOD streaming). Its
//     own flythrough is NOT used; the chase cam owns the camera. Its LOD
//     streamer keys off camera.position, so chunks stream around the chase
//     cam automatically.
//   * physics.mjs — accepted physics core (READ-ONLY copy, byte-identical to
//     src/physics/physics.mjs). env = { sampleHeight } from the render loop.
//   * camera.mjs  — accepted chase cam, mounted on the render camera.
//   * attach.mjs + shaders/ — snow-shaders candidate B (surface, trail RTT,
//     spray), fed the live rider state via riderRef.
//
// Scripted run: a deterministic 25 s input script (straight run-in, carved
// S-turns held on the course line by a heading correction, a tuck segment,
// a crouch-charged pop off a terrain roller for air, then more carving),
// stepped through physics.step at a fixed 60 Hz and precomputed at boot into
// a full state timeline (1501 snapshots).
//
// flythrough(t) seeks the run to t * 25 s. Forward seeks REPLAY every 60 Hz
// step through the chase cam and the snow package (so trail stamps, spray
// and camera smoothing are all real, not teleported); backward seeks restore
// the timeline snapshot and re-settle the camera.
//
// update(dt) advances the same live sim path (physics.step + script input),
// so the rig keeps playing during the harness perf loop and is ready for an
// interactive input source later.
// ===========================================================================

import * as THREE from 'three';
import { boot as bootRender, setRamps } from './render.mjs';
import { createPhysics, riderMode } from './physics.mjs';
import { applyStick } from './input.mjs';
import { createChaseCam } from './camera.mjs';
import { attachSnow } from './attach.mjs';
import { createTricks } from './tricks.mjs';
import { createRun } from './run.mjs';
import { createRivals } from './rivals.mjs';
import { createRails } from './rails.mjs';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { buildRails } from './rails-course.mjs';

const FIXED_DT = 1 / 60;
const DURATION = 27;                    // s of scripted run
const N_STEPS = Math.round(DURATION / FIXED_DT);   // 1500
const DEG = Math.PI / 180;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = (a) => {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

// Course line — duplicated from the render lane's analytic terrain (the
// render module exports only sampleHeight; these two mirror its centerX()).
function centerX(z) {
  return 150 * Math.sin(z * 0.0032) + 65 * Math.sin(z * 0.0011 + 1.7);
}
function centerXSlope(z) {
  return 150 * 0.0032 * Math.cos(z * 0.0032)
       + 65 * 0.0011 * Math.cos(z * 0.0011 + 1.7);
}

// ---------------------------------------------------------------- input script
// Deterministic closed-loop script: pure function of (t, state). Windows:
//   0.0 -  2.0  straight run-in (build speed)
//   2.0 - 13.4  HARD carved S-turns: the target line itself weaves +-7 m
//               around centerX; steer = cos-phase feedforward + line-error
//               correction, hitting full lock (edge01 = 1.0) at every apex.
//               Boost pulses whenever speed sags below 20 m/s so carve drag
//               never bleeds the run down to a crawl.
//  13.4 - 15.6  tuck straight (the S-groove trails behind for the hero shot)
//  19.4 - 23.6  carve S-turns again, building to the jump
//  21.6 - 22.5  crouch (charge) through the last left apex, release at the
//               roller lip -> the BIG AIR: ~2.3 s, ~4.1 m off the deck,
//               clean landing at ~25.6 s at ~29 m/s
//  23.6 - end   tuck; post-landing carve-out closes the run
const T_CARVE1_ON = 2.0, T_CARVE1_OFF = 13.4;
const T_TUCK_ON = 13.4, T_TUCK_OFF = 15.6;
const T_CROUCH_ON = 21.6, T_RELEASE = 22.50;
const T_CARVE2_ON = 19.4, T_CARVE2_OFF = 23.6;
const CARVE_PERIOD = 3.0, CARVE_AMP = 0.85;
const WEAVE_AMP = 7.0;      // m of lateral target-line weave
const STEER_CAP = 1.0;      // full edge lock at the apexes — spray is tuned
                            // to stay readable at edge01 = 1, not capped away

function scriptInput(t, st) {
  const input = {};
  const carving = (t >= T_CARVE1_ON && t < T_CARVE1_OFF)
               || (t >= T_CARVE2_ON && t < T_CARVE2_OFF);
  const phase = (t - T_CARVE1_ON) * (2 * Math.PI / CARVE_PERIOD);
  const eT = carving ? WEAVE_AMP * Math.sin(phase) : 0;   // weaving target line
  const wave = carving ? CARVE_AMP * Math.cos(phase) : 0; // feedforward at the crossing
  // Same router index.html uses: the stick is a carve on the ground, BALANCE on
  // a rail, spin in the air. Testing st.onGround here starved the rail balance
  // channel (measured: 118 bails in 119 grinds, median 40.7 ft in).
  if (riderMode(st) !== 'air') {
    // line correction: aim down the gully at the WEAVING target line, so the
    // S-carves stay centered on the course while hitting full lock
    const z = st.pos[2];
    const e = st.pos[0] - centerX(z) - eT;
    const desired = Math.atan2(1, centerXSlope(z) - clamp(e * 0.10, -0.9, 0.9));
    const corr = clamp(1.8 * wrapPi(desired - st.heading), -0.8, 0.8);
    applyStick(input, st, clamp(wave + corr, -STEER_CAP, STEER_CAP));
  }
  // boost pulses: hold carve speed ~20 m/s against full-lock carve drag, and
  // charge to ~26 m/s into the jump roller
  const spNow = Math.hypot(st.vel[0], st.vel[2]);
  if ((carving && spNow < 20) || (t >= 20.6 && t < T_RELEASE && spNow < 26)) input.boost = true;
  if ((t >= T_TUCK_ON && t < T_TUCK_OFF) || t >= T_CARVE2_OFF) input.tuck = true;
  if (t >= T_CROUCH_ON && t < T_RELEASE && riderMode(st) !== 'air') input.crouch = true;
  if (t >= T_RELEASE && t < T_RELEASE + 0.05) input.jumpRelease = true;
  // 360 in the big air: stick-spin through the first second, released at the
  // apex so AUTO_LEVEL closes the rotation ~0.8 s before the clean touchdown.
  // Gated to t >= 23.45 so the short pop-air before the roller never spins
  // (spinning that one landed 170 deg off-axis = scripted crash).
  if (riderMode(st) === 'air' && t >= 23.45 && t < 24.40) input.spin = 1;
  return input;
}

function cloneState(s) {
  return { ...s, pos: [...s.pos], vel: [...s.vel] };
}

// ---------------------------------------------------------------- rider proxy
// Cheap capsule board+body with SSX-saturated outfit colors. One group,
// MeshBasicMaterial only (the scene is unlit-baked), ~6 draw-call-merged-into-
// scene meshes.
const BOARD = { len: 1.55, wNose: 0.295, wWaist: 0.250, thick: 0.012,
                kick: 0.055, kickRun: 0.20 };

// PROCEDURAL BOARD, one per rival. Extracted from the player's original deck so
// the rivals do not all ride Nyx's board: the modelled snowboard is HERS, and
// four identical copies of it in a race reads as a bug. Takes a topsheet colour
// so the field is tellable apart at distance.
function makeProceduralBoard(topColor) {
    const g = new THREE.Group();
    const SEGS = 24;
    const pos = [], idx = [];
    // half-width along the length: widest at the contact points, narrowest at
    // the waist, rounded off to a nose and tail rather than cut square.
    const halfW = (u) => {                     // u in -1..1, 0 = waist
      const a = Math.abs(u);
      const sidecut = BOARD.wWaist / 2 + (BOARD.wNose / 2 - BOARD.wWaist / 2) * (a * a);
      const roundOff = Math.sqrt(Math.max(0, 1 - Math.pow(Math.max(0, (a - 0.86) / 0.14), 2)));
      return sidecut * (a > 0.86 ? roundOff : 1);
    };
    // rocker: flat through the middle, kicked at the tips
    const rise = (u) => {
      const a = Math.abs(u), s = 1 - BOARD.kickRun / (BOARD.len / 2);
      if (a < s) return 0;
      const k = (a - s) / (1 - s);
      return BOARD.kick * k * k;
    };
    for (let i = 0; i <= SEGS; i++) {
      const u = -1 + (2 * i) / SEGS;
      const x = u * BOARD.len / 2, w = halfW(u), y = rise(u);
      pos.push(x, y + BOARD.thick, -w,  x, y + BOARD.thick, w,   // top
               x, y, -w,             x, y, w);                    // base
    }
    for (let i = 0; i < SEGS; i++) {
      const a = i * 4, b = (i + 1) * 4;
      idx.push(a, b, a + 1, b, b + 1, a + 1);            // top
      idx.push(a + 2, a + 3, b + 2, b + 2, a + 3, b + 3); // base
      idx.push(a, a + 2, b, b, a + 2, b + 2);            // toe edge
      idx.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3); // heel edge
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // Lit, now that the character lights exist — an unlit board next to a lit
    // rider reads as a sticker.
    g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: topColor })));

    // topsheet stripe, inset so it reads as graphic and not as a second slab
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD.len * 0.62, 0.002, BOARD.wWaist * 0.30),
      new THREE.MeshLambertMaterial({
        color: new THREE.Color(topColor).offsetHSL(0, -0.25, 0.28) }));
    stripe.position.y = BOARD.thick + 0.001;
    g.add(stripe);

    // steel edges: a thin dark rail down each side, which is what actually
    // separates a board from a plank at any distance.
    for (const sgn of [-1, 1]) {
      const e = new THREE.Mesh(
        new THREE.BoxGeometry(BOARD.len * 0.90, BOARD.thick * 0.9, 0.006),
        new THREE.MeshLambertMaterial({ color: 0x2a2f3a }));
      e.position.set(0, BOARD.thick / 2, sgn * (BOARD.wWaist / 2 + 0.001));
      g.add(e);
    }

    // bindings: baseplate + two straps each, at real stance width
    const bindMat = new THREE.MeshLambertMaterial({ color: 0x1b1f27 });
    const strapMat = new THREE.MeshLambertMaterial({ color: 0x3a4250 });
    for (const sgn of [-1, 1]) {
      const bx = sgn * 0.24;                       // ~0.48 m stance
      const base = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.015, 0.20), bindMat);
      base.position.set(bx, BOARD.thick + 0.008, 0);
      g.add(base);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.13, 0.19), bindMat);
      back.position.set(bx - sgn * 0.13, BOARD.thick + 0.075, 0);
      g.add(back);
      for (const off of [-0.06, 0.05]) {
        const st = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.21), strapMat);
        st.position.set(bx + off, BOARD.thick + 0.05, 0);
        g.add(st);
      }
    }
    return g;
}

function buildRider() {
  const root = new THREE.Group();          // yaw (world heading)
  const trick = new THREE.Group();         // flip + carve lean
  root.add(trick);
  const mat = (hex) => new THREE.MeshBasicMaterial({ color: hex });

  // ---- the snowboard ------------------------------------------------------
  // Was a 1.58 x 0.09 x 0.30 orange BOX. Nine centimetres thick, straight
  // edges, no nose. Real numbers instead, from an actual freestyle deck:
  //     length 1.55 m, nose/tail width 0.295 m, waist 0.250 m (the sidecut),
  //     core thickness 0.012 m, nose and tail kicked up 0.055 m over the last
  //     0.20 m at each end.
  // Built as a swept outline rather than a box so it has a shape you can read
  // from the chase camera: the sidecut narrows the waist under her feet and the
  // rocker lifts the tips off the snow, which is most of what makes a board
  // look like a board at this distance.
  // The player's fallback deck, used until the modelled snowboard loads (and
  // kept if it fails to). Same builder the rivals use, in the original orange.
  const board = makeProceduralBoard(0xff5f00);
  // DECK_Y (0.135) is where the rider's soles are grounded, so the board's top
  // surface has to land there or she floats above her own bindings.
  board.position.y = 0.135 - BOARD.thick - 0.023;
  trick.add(board);
  // ---- contact shadow -----------------------------------------------------
  // NOT a shadow map. Real shadows would need the terrain to be a shadow
  // receiver, which means giving it a lit material, which is the whole
  // conversion this project deliberately did not do — and SV-13's 60 fps is a
  // HARD gate that already flakes under load. A projected blob costs one quad.
  //
  // Radial falloff drawn into a canvas rather than a flat disc: a hard-edged
  // ellipse reads as a sticker on the snow. Multiply blending so it darkens the
  // snow it sits on instead of painting grey over it.
  const shadow = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g2 = c.getContext('2d');
    const grd = g2.createRadialGradient(64, 64, 0, 64, 64, 64);
    // ALPHA GRADIENT ON A SINGLE COLOUR, and normal blending. The first version
    // used MultiplyBlending, which IGNORES ALPHA — so the outer "transparent"
    // stop rgba(60,80,130,0) still multiplied the snow by 0.24,0.31,0.51 and
    // painted a near-black fan around the rider. Multiply also makes the
    // height fade impossible, because material.opacity does nothing under it.
    grd.addColorStop(0.00, 'rgba(38,54,104,0.62)');
    grd.addColorStop(0.55, 'rgba(38,54,104,0.26)');
    grd.addColorStop(1.00, 'rgba(38,54,104,0)');
    g2.fillStyle = grd;
    g2.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(c);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 2;
    return m;
  })();

  // pose group: crouch/tuck squash + forward fold live here, so the board
  // (in trick) never squashes with the body
  const pose = new THREE.Group();
  trick.add(pose);
  const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.34), mat(0x00d5ff));
  legs.position.y = 0.42;
  pose.add(legs);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.55, 3, 8), mat(0xff1fb3));
  torso.position.y = 1.02;
  pose.add(torso);
  const arms = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 1.05), mat(0xff1fb3));
  arms.position.y = 1.12;
  pose.add(arms);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), mat(0xb4ff00));
  head.position.y = 1.55;
  pose.add(head);
  return { root, trick, pose, arms, shadow, board, proxyBody: [legs, torso, arms, head] };
}

// ================================================================== boot
export async function boot(canvas) {
  // ---- ASSET READINESS ----------------------------------------------------
  // Six GLBs load async: four character poses, the board, and three tree
  // species (the trees share one counter slot each). Until they are in, the
  // game renders the BOX PROXY rider and a bare hillside — which is what the
  // "terrible assets then real assets" pop was. The page holds a cover over
  // everything until this reaches zero, so nobody sees the placeholder state.
  let pending = 0, readyFired = false;
  const readyCbs = [];
  const need = () => { pending++; };
  const done = () => {
    if (--pending > 0 || readyFired) return;
    readyFired = true;
    for (const cb of readyCbs) { try { cb(); } catch {} }
  };
  // Kickers are game content; the gate harnesses measure the ramp-free course.
  setRamps(true);
  const app = await bootRender(canvas);
  const { scene, camera, renderer, sampleHeight } = app;

  const physics = createPhysics({ sampleHeight, surface: 'snow' });
  // VERIFICATION CAMERA. window.__CLOSECAM__ pulls the boom in so a headless
  // screenshot shows the rider big enough to actually judge a pose. Off by
  // default; it changes nothing about the shipped chase cam.
  const chase = createChaseCam(camera, typeof window !== 'undefined' && window.__CLOSECAM__
    ? { seed: 7, boomLength: 2.8, boomHeight: 1.5, fovBase: 55 }
    : { seed: 7 });

  // ---- scripted-run timeline, precomputed at boot ------------------------
  const z0 = 15;
  const x0 = centerX(z0);
  const slope0 = centerXSlope(z0);
  const dl = Math.hypot(slope0, 1);
  const startHeading = Math.atan2(1, slope0);
  const startPos = [x0, sampleHeight(x0, z0), z0];
  const startVel = [8 * slope0 / dl, 0, 8 * 1 / dl];

  const timeline = new Array(N_STEPS + 1);
  {
    const s = physics.init(startPos, startVel, startHeading);
    timeline[0] = cloneState(s);
    for (let k = 0; k < N_STEPS; k++) {
      physics.step(s, scriptInput(k * FIXED_DT, s), FIXED_DT);
      timeline[k + 1] = cloneState(s);
    }
  }

  // ---- live rig state ----------------------------------------------------
  let liveState = cloneState(timeline[0]);
  let liveTime = 0;
  let lastInput = {};
  let prevOnGround = liveState.onGround;
  const riderRef = { state: liveState };

  // ---- sim-parity instrumentation (r3 mustFix: physicsIdentical evidence) --
  // Every advance() folds the post-step physics state (pos, vel, heading)
  // into a running FNV-1a hash over the raw float64 bytes. ?novis=1 boots the
  // rig with the snow package REPLACED BY A STUB (no trail RTT, no spray, no
  // material swap), so driving the identical capture sequence in both modes
  // and comparing hashes proves the visuals never touch the sim.
  const NOVIS = (typeof location !== 'undefined')
    && /[?&]novis=1/.test(location.search || '');
  let simHash = 0x811c9dc5, simHashSteps = 0;
  const hF64 = new Float64Array(7);
  const hU8 = new Uint8Array(hF64.buffer);
  function hashState(s) {
    hF64[0] = s.pos[0]; hF64[1] = s.pos[1]; hF64[2] = s.pos[2];
    hF64[3] = s.vel[0]; hF64[4] = s.vel[1]; hF64[5] = s.vel[2];
    hF64[6] = s.heading;
    for (let i = 0; i < 56; i++) simHash = Math.imul(simHash ^ hU8[i], 16777619);
    simHashSteps++;
  }
  if (typeof window !== 'undefined') {
    window.__physicsHash = () => ({
      steps: simHashSteps, hash: (simHash >>> 0).toString(16), novis: NOVIS });
  }

  const snow = NOVIS ? { update() {} } : await attachSnow(scene, renderer, riderRef);

  // ---- rider proxy mesh --------------------------------------------------
  const rider = buildRider();
  scene.add(rider.root);
  // The shadow lives in the SCENE, not under rider.root: it must stay flat on
  // the snow while she rolls, banks and spins above it. Parenting it to the
  // rider would tilt it with her and it would read as a floating card.
  scene.add(rider.shadow);
  if (typeof window !== 'undefined') window.__RIG__ = rider;   // debug handle

  // ---- MODELLED SNOWBOARD -------------------------------------------------
  // BAKED INTO THE GEOMETRY, not applied as a wrapper rotation.
  //
  // Every earlier attempt failed the same way: a rotation measured in one frame
  // was applied in another. The model carries the loader's root transform, the
  // measurement was taken through matrixWorld, the rotation went onto a wrapper
  // — three frames, and a self-check that passed in the wrong one.
  //
  // There is no frame to get wrong if the transform is BAKED INTO THE VERTICES.
  // Collapse the whole scene to one geometry, measure its axes, bake the
  // alignment in, and what comes out is an axis-aligned board whose bounding
  // box can be asserted against the procedural deck it replaces. The mesh then
  // needs NO rotation at all — it is dropped at exactly the coordinates the old
  // board occupied.
  //
  // The procedural deck it must match: 1.55 m long on X, top surface at the
  // local origin of rider.board, centred on X and Z.
  const BOARD_LEN = 1.55;
  let boardMesh = null;
  need();
  new GLTFLoader().load('/assets/props/snowboard.glb', (gltf) => {
    // 1. collapse to a single geometry with every node transform baked in
    gltf.scene.updateMatrixWorld(true);
    const parts = [];
    let srcMat = null;
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      parts.push(g);
      srcMat = srcMat ?? (Array.isArray(o.material) ? o.material[0] : o.material);
    });
    if (!parts.length) return;
    const geo = parts[0];
    const pos = geo.attributes.position;

    // 2. measure the board's own axes by sweeping directions and taking the
    //    real extent along each. Minimum extent is the thickness; the longest
    //    direction perpendicular to it is the length.
    const P = [];
    for (let i = 0; i < pos.count; i++)
      P.push(new THREE.Vector3().fromBufferAttribute(pos, i));
    const ctr = new THREE.Vector3();
    for (const v of P) ctr.add(v);
    ctr.multiplyScalar(1 / P.length);
    const rel = P.map(v => v.clone().sub(ctr));
    const dirs = [];
    for (let i = 0; i < 64; i++) {
      const y = 1 - (2 * i + 1) / 64, r = Math.sqrt(Math.max(0, 1 - y * y));
      const m = Math.max(4, Math.round(64 * r));
      for (let k = 0; k < m; k++) {
        const a2 = (k / m) * Math.PI * 2;
        dirs.push(new THREE.Vector3(r * Math.cos(a2), y, r * Math.sin(a2)));
      }
    }
    const extent = (d) => {
      let lo = Infinity, hi = -Infinity;
      for (const v of rel) { const t = v.dot(d); if (t < lo) lo = t; if (t > hi) hi = t; }
      return hi - lo;
    };
    let thick = dirs[0], te = Infinity;
    for (const d of dirs) { const e = extent(d); if (e < te) { te = e; thick = d.clone(); } }
    let len = null, le = -Infinity;
    for (const d of dirs) {
      if (Math.abs(d.dot(thick)) > 0.10) continue;
      const e = extent(d); if (e > le) { le = e; len = d.clone(); }
    }

    // 3. bake the alignment: length -> X, thickness -> Y, width -> Z.
    //    Orthonormalised, because the two sweeps are only perpendicular to
    //    within the dot tolerance and makeBasis on skew vectors is not a
    //    rotation at all.
    const X = len.clone().normalize();
    const Y = thick.clone().sub(X.clone().multiplyScalar(thick.dot(X))).normalize();
    const Z = new THREE.Vector3().crossVectors(X, Y).normalize();
    // rows = target axes: this maps the model's axes onto the world axes
    const M = new THREE.Matrix4().set(
      X.x, X.y, X.z, 0,
      Y.x, Y.y, Y.z, 0,
      Z.x, Z.y, Z.z, 0,
      0, 0, 0, 1,
    );
    geo.translate(-ctr.x, -ctr.y, -ctr.z);
    geo.applyMatrix4(M);
    const sc = BOARD_LEN / le;
    geo.scale(sc, sc, sc);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    // 4. seat it: centred on X and Z, top surface on the local origin, exactly
    //    where the procedural deck's top sat.
    geo.translate(-(bb.min.x + bb.max.x) / 2, -bb.max.y, -(bb.min.z + bb.max.z) / 2);
    geo.computeBoundingBox();
    // AND THE SPHERE. Raycaster uses the bounding SPHERE for its early-out, and
    // baking transforms into the vertices leaves it describing the original
    // untransformed mesh — so the board was unpickable, the ray rejecting it
    // before it ever tested a triangle.
    geo.computeBoundingSphere();
    geo.computeVertexNormals();
    const d2 = geo.boundingBox.max.clone().sub(geo.boundingBox.min);
    // 5. ASSERT the result rather than trusting it. A board is long on X, thin
    //    on Y, and narrower than it is long on Z. If this does not hold the
    //    alignment failed and the procedural deck is kept instead of shipping a
    //    board standing on its edge.
    const looksLikeABoard = d2.x > d2.z * 2.5 && d2.y < d2.z;
    console.log('[props] board baked', JSON.stringify({
      len: +d2.x.toFixed(3), thick: +d2.y.toFixed(3), wide: +d2.z.toFixed(3),
      ok: looksLikeABoard,
    }));
    if (!looksLikeABoard) {
      console.warn('[props] board alignment FAILED its shape check — keeping the procedural deck');
      return;
    }
    const mat = new THREE.MeshLambertMaterial({
      map: srcMat?.map ?? null,
      color: srcMat?.map ? 0xffffff : 0xffffff,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    // DIALLED IN THE EDITOR, not derived. The bake above puts the board flat,
    // centred, top surface on the deck line — geometrically correct but not
    // necessarily how it should SIT under her boots. These are the numbers a
    // person read off a running frame with the free camera, and they are the
    // last word: do not "correct" them from geometry.
    const D2 = Math.PI / 180;
    mesh.rotation.set(175.03 * D2, 5.33 * D2, -4.96 * D2);
    mesh.position.set(-0.050, -0.030, 0);
    for (const c of rider.board.children.slice()) rider.board.remove(c);
    rider.board.add(mesh);
    mesh.userData.editable = 'BOARD';
    boardMesh = mesh;
    done();
  }, undefined, (e) => { console.warn('[props] snowboard failed, keeping the procedural deck:', e?.message || e); done(); });

  // ---- TREE LAYERS --------------------------------------------------------
  // Three modelled trees share the hillside with the procedural conifers, and
  // they are separated by SLOPE, not by random draw. Slope is the honest axis:
  // it is what actually decides what grows where on a mountain, and it means no
  // two layers can ever land on the same spot.
  //
  //     0.52 - 0.72   DEAD     steep, wind-scoured, exposed. Standing deadwood
  //                            survives here; healthy trees do not. The cone
  //                            forest rejects everything below 0.72 as too
  //                            steep, so this band was empty.
  //     0.72 - 0.80   (held)   the transition. Reserved for the LEANING tree,
  //                            which is still to come — wind wins here, which
  //                            is exactly why a leaning tree belongs. Cones
  //                            keep it in the meantime.
  //     0.80 - 1.00   TALL     sheltered lower flanks. The cone forest is
  //                            thinned to 40% here (src/render/main.mjs) so the
  //                            two do not sit on top of each other.
  //
  // Each layer is ONE InstancedMesh: a whole species costs one draw call.
  // These live in the RIG, not in src/render/main.mjs — the render lane is
  // gated by the SV suite and loads no GLBs, and a prop layer has no business
  // adding an async dependency to it.
  const slopeY = (x, z) => {
    // The render lane does not export its sampleNormal; a central difference
    // over 3 m is the same measurement.
    const h = 3;
    const dx = (sampleHeight(x + h, z) - sampleHeight(x - h, z)) / (2 * h);
    const dz = (sampleHeight(x, z + h) - sampleHeight(x, z - h)) / (2 * h);
    return 1 / Math.sqrt(1 + dx * dx + dz * dz);
  };
  function placeTrees(url, o) {
    need();
    new GLTFLoader().load(url, (gltf) => {
      let geo = null;
      gltf.scene.updateMatrixWorld(true);
      const mats = [];
      gltf.scene.traverse((n) => {
        if (!n.isMesh) return;
        mats.push(n.material);
        if (!geo) { geo = n.geometry.clone(); geo.applyMatrix4(n.matrixWorld); }
      });
      if (!geo) return;
      // Lit, like the character: the lights are aimed and coloured to match the
      // terrain bake, so a Lambert prop stands in the same sun the snow does.
      // Unlit would make these flat cutouts beside the shaded conifers.
      const mat = new THREE.MeshLambertMaterial({
        map: mats[0]?.map ?? null,
        color: mats[0]?.map ? 0xffffff : o.tint,
      });
      const inst = new THREE.InstancedMesh(geo, mat, o.count);
      let sd = o.seed >>> 0;
      const rnd = () => {
        sd = (sd + 0x6d2b79f5) | 0;
        let t = Math.imul(sd ^ (sd >>> 15), 1 | sd);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion();
      const pv = new THREE.Vector3(), sv = new THREE.Vector3(), e = new THREE.Euler();
      let placed = 0;
      for (let tries = 0; tries < o.count * 60 && placed < o.count; tries++) {
        const x = -900 + rnd() * 1800;
        const z = -200 + rnd() * 3200;
        const d = Math.abs(x - centerX(z));
        if (d < o.near || d > o.far) continue;
        const ny = slopeY(x, z);
        if (ny < o.minSlope || ny >= o.maxSlope) continue;
        const sc = o.scale[0] + rnd() * (o.scale[1] - o.scale[0]);
        // GROUND ON THE LOWEST POINT UNDER THE FOOTPRINT, not on the centre.
        // A trunk placed at the centre height sits with its downhill side in
        // mid-air on any slope, and every one of these bands IS a slope. Eight
        // samples around the base ring, take the minimum, and the whole base is
        // buried. Same trick the procedural cone forest used.
        let baseY = sampleHeight(x, z);
        const fp = o.footprint * sc;
        for (let k = 0; k < 8; k++) {
          const a2 = (k / 8) * Math.PI * 2;
          baseY = Math.min(baseY, sampleHeight(x + Math.cos(a2) * fp, z + Math.sin(a2) * fp));
        }
        // SINK PROPORTIONAL TO THE SLOPE. The ring minimum alone is not enough
        // on steep ground: the terrain keeps falling away past the ring, so a
        // trunk still shows daylight under its downhill side. Measured before
        // this, the dead trees — which live on the steepest band by design —
        // floated on 160 of 160 instances, worst gap 3.32 m. The extra sink is
        // the footprint times the surface gradient, which is exactly how far
        // the ground drops across the base.
        const grad = Math.sqrt(Math.max(0, 1 / (ny * ny) - 1));
        pv.set(x, baseY + o.sink - fp * grad * 0.8, z);
        sv.set(sc, sc * (0.88 + rnd() * 0.3), sc);
        // LEAN DOWNHILL, mostly. A tree leaning INTO the slope looks wrong
        // because it is: wind and creep push them outward and downhill, and a
        // hillside of trees tipped into the mountain reads as broken. The lean
        // is aimed down the local gradient, with a fifth of them left random so
        // the stand does not look combed.
        const h2 = 3;
        const gx2 = (sampleHeight(x + h2, z) - sampleHeight(x - h2, z)) / (2 * h2);
        const gz2 = (sampleHeight(x, z + h2) - sampleHeight(x, z - h2)) / (2 * h2);
        const gl = Math.hypot(gx2, gz2) || 1;
        const wild = rnd() < 0.20;
        const amt = o.lean * (0.55 + 0.45 * rnd());
        e.set(
          wild ? (rnd() - 0.5) * o.lean : (gz2 / gl) * amt,
          rnd() * Math.PI * 2,
          wild ? (rnd() - 0.5) * o.lean : -(gx2 / gl) * amt,
        );
        q.setFromEuler(e);
        inst.setMatrixAt(placed, m4.compose(pv, q, sv));
        placed++;
      }
      inst.count = placed;
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      // The float audit in harness/endmap-probe.html needs the model's REAL
      // contact radius; a blanket radius reports a bare trunk as floating.
      inst.userData.footprint = o.footprint;
      inst.userData.label = o.label;
      scene.add(inst);
      done();
    }, undefined, (err) => { console.warn('[props]', o.label, 'failed:', err?.message || err); done(); });
  }

  placeTrees('/assets/props/dead_tree.glb', {
    label: 'dead trees', count: 160, seed: 0xDEAD7EE5, tint: 0x8a8073,
    // A dead trunk has no skirt to hide the ground join, so it is sunk a little
    // rather than balanced exactly on the sample point.
    minSlope: 0.52, maxSlope: 0.72, near: 45, far: 700,
    scale: [0.62, 1.37], lean: 0.22, sink: -0.35, footprint: 0.55,
  });
  placeTrees('/assets/props/tall_tree.glb', {
    label: 'tall trees', count: 240, seed: 0x7A117EE5, tint: 0x2f6a3a,
    minSlope: 0.80, maxSlope: 1.01, near: 55, far: 720,
    // Barely leaning: these are the sheltered ones, and a tall tree visibly
    // off-plumb reads as a mistake rather than as weather.
    scale: [0.70, 1.25], lean: 0.05, sink: -0.25, footprint: 2.2,
  });
  placeTrees('/assets/props/leaning_tree.glb', {
    label: 'leaning trees', count: 260, seed: 0x1EA71235, tint: 0x2c6340,
    // The transition band: sheltered enough to grow, exposed enough that the
    // wind has had its say. A leaning tree anywhere else reads as a bug.
    minSlope: 0.72, maxSlope: 0.80, near: 50, far: 710,
    // The model already leans. The extra here is jitter on top of it, kept
    // small so they do not all fall the same way OR look randomly scattered.
    scale: [0.72, 1.30], lean: 0.10, sink: -0.30, footprint: 1.5,
  });

  // ---- real rider mesh, swapped in over the proxy -------------------------
  // Async and non-fatal: if the GLB is missing or fails to parse the game keeps
  // running on the box proxy rather than booting to a black screen.
  let nyx = null, mixer = null, clips = {}, curClip = null;
  let nyxCarve = null, nyxTuck = null, nyxGrab = null;

  // ---- LIGHTING, for the character only ----------------------------------
  //
  // The terrain is NOT lit by these. It never will be: its shading is baked
  // per-vertex against a fixed sun and SV-01 grades that wrap-diffuse model, so
  // converting it to real lights would put the whole snow-visuals lane in
  // question and spend frame budget SV-13 does not have. MeshBasicMaterial
  // IGNORES lights entirely, which is what makes this safe — adding lights
  // costs the terrain literally nothing and reaches only materials that ask.
  //
  // She looked flat because she was the ONE thing in the scene not following
  // the baked model, being a textured GLB with no shading of her own. So she
  // gets real lights, aimed and coloured to MATCH the bake rather than to look
  // good on their own. Copied from src/render/main.mjs, not invented:
  //     sun direction   (0.72, 0.48, -0.4) normalised
  //     lit colour      (1.26, 1.16, 1.00)  warm white
  //     shadow colour   (0.14, 0.28, 0.98)  deep saturated blue
  // The hemisphere light is what reproduces that blue shadow fill; a plain
  // ambient would grey her out and she would stop belonging to the mountain.
  const SUN_DIR = new THREE.Vector3(0.72, 0.48, -0.4).normalize();
  {
    const sun = new THREE.DirectionalLight(0xfff1dc, 2.05);
    sun.position.copy(SUN_DIR).multiplyScalar(100);
    scene.add(sun);
    // sky = the terrain's shadow blue, ground = its lit white, so the fill she
    // picks up matches the snow she is standing on.
    scene.add(new THREE.HemisphereLight(0x4a7dfa, 0xdfe6f2, 1.15));
  }

  // Characters take a LIT material. Everything else in this scene is unlit
  // MeshBasicMaterial; a PBR material there renders black, which is exactly how
  // the rails shipped broken.
  function unlit(model) {
    model.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const src = Array.isArray(o.material) ? o.material[0] : o.material;
      // Lambert, not Standard: no metalness/roughness maps come out of Tripo
      // that are worth the cost, and a PBR response would not match a bake that
      // is pure wrap-diffuse anyway.
      o.material = new THREE.MeshLambertMaterial({
        map: src.map ?? null,
        color: src.map ? 0xffffff : (src.color ?? new THREE.Color(0xffffff)),
      });
      o.frustumCulled = false;   // skinned bounds go stale during big rotations
      o.castShadow = o.receiveShadow = false;
    });
  }

  need();
  new GLTFLoader().load('/assets/characters/nyx_rigged.glb', (gltf) => {
    const model = gltf.scene;
    unlit(model);
    // ORIENTATION AND OFFSET — dialled in the pose editor (F), not guessed.
    // Every attempt to reason these out from mesh measurements or from screen
    // grabs was wrong, repeatedly. The editor freezes the game and moves her
    // live against the board, so these are the numbers a human read off a
    // running frame and confirmed. Do not "correct" them from geometry.
    //   rotation.y 70 deg, x/z zero. position x -0.100, z 0.050.
    // position.y is NOT authored here: groundNyx owns it every frame and
    // converges on DECK_Y (0.135), which is exactly what the editor reported.
    model.rotation.set(0, 70 * Math.PI / 180, 0);
    model.position.set(-0.100, 0.135, 0.050);
    // Parented to `trick`, NOT `pose`: the pose group carries the box proxy's
    // crouch hack (a Y-scale squash plus a Z tilt), which is fine for a capsule
    // and deforms a real character. Her crouch comes from bones.
    rider.trick.add(model);
    for (const m of rider.proxyBody) m.visible = false;
    model.userData.editable = 'NEUTRAL';
    nyx = model;
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(model);
      for (const c of gltf.animations) { const a = mixer.clipAction(c); a._clipName = c.name; clips[c.name] = a; }
      const first = clips.ride ?? Object.values(clips)[0];
      if (first) { first.play(); curClip = first; }
    }
    done();
  }, undefined, (e) => { console.warn('[nyx] load failed, keeping proxy:', e?.message || e); done(); });

  // ---- CARVE POSE: a second, separate mesh, swapped in while turning -------
  //
  // Not an animation and not a bone pose. nyx_carve.glb is an UNRIGGED static
  // mesh — a different sculpt of the same character, crouched with the arms
  // out — so "carving" is a visibility swap between two models, not a blend.
  // That is deliberate: every attempt to produce a good pose by rotating bones
  // failed, and a sculpted pose cannot go wrong the same way.
  //
  // SCALE 0.8686 IS MEASURED, NOT CHOSEN. prep_character.py normalises whatever
  // it is given to 1.8 m of bounding height, which is wrong for a crouched
  // figure: a crouched body forced to a standing body's height is scaled up,
  // and she would grow every time you turned. Measured in three (not Blender —
  // Blender reads the rigged file through its armature scale and disagrees by
  // 1.556x), matching the one part of a person that does not change size when
  // they crouch:
  //     neutral  height 1.7923   head diagonal 0.3945
  //     carve    height 1.7962   head diagonal 0.4541   -> 0.8686
  // A shoulder-width proxy said 0.7086 and was discarded: on a carving figure
  // the shoulder band catches the outstretched arms, so it is not a scale
  // signal at all. Head-matched puts her at 1.56 m crouched, which is the right
  // shape for a rider bent into a turn.
  //
  // ROTATION AND OFFSET ARE A FIRST GUESS AND SHOULD BE DIALLED IN THE EDITOR.
  // 70 deg is copied from the neutral model because both sculpts face +Z at
  // rotation 0 (verified in harness/carve-preview.html). It has NOT been
  // confirmed against a running frame. Press F, then N to hold the carve pose
  // on screen while frozen, and dial it the way the neutral one was dialled.
  const CARVE = {
    scale: 0.8543,
    rotY: 70,
    pos: [-0.100, 0.135, 0.050],
    onAt: 0.45,      // |lean| in rad at which the carve pose takes over
    offAt: 0.28,     // and the lower bar it has to fall back through
  };
  need();
  new GLTFLoader().load('/assets/characters/nyx_carve.glb', (gltf) => {
    const m = gltf.scene;
    unlit(m);
    m.scale.setScalar(CARVE.scale);
    m.rotation.set(0, CARVE.rotY * Math.PI / 180, 0);
    m.position.set(...CARVE.pos);
    m.visible = false;
    rider.trick.add(m);
    m.userData.editable = 'CARVE';
    nyxCarve = m;
    console.log('[nyx] carve pose loaded');
  }, undefined, (e) => console.warn('[nyx] carve pose failed, staying on one pose:', e?.message || e));

  // ---- HIGH-SPEED TUCK: the third sculpt, for air and for boost -----------
  //
  // Same idea as the carve mesh — an unrigged sculpt, swapped in, not a blend.
  // SCALE 0.7249 is head-matched the same way and for the same reason: the prep
  // script normalises to 1.8 m of BOUNDING HEIGHT, which on a deep tuck means
  // scaling a folded-up body to a standing body's height. Measured in three:
  //     neutral  head diagonal 0.3945
  //     tuck     head diagonal 0.5442   -> 0.7249, i.e. 1.30 m folded over
  //
  // RE-MEASURED BY SURFACE AREA, which is pose-invariant — a body's skin area
  // does not change when it moves, so scale = sqrt(areaNeutral / areaPose). The
  // head-band method this originally used is unreliable exactly here: the band
  // is the top 8% of HEIGHT, and on a folded sculpt it catches her back rather
  // than her head. The two methods agree within 2% on the carve (0.8543 vs
  // 0.8686) and on the grab (0.6190 vs 0.6106), and disagree by 10% on the
  // tuck — which is the pose bent far enough for the band to lie. Area wins.
  const TUCK = {
    scale: 0.6536,
    rotY: 70,
    pos: [-0.100, 0.135, 0.050],
    releaseHold: 0.12,   // s to keep the pose after the input drops
    // BIG AIR ONLY. A medium hop uses the carve pose, so she does not snap from
    // standing straight to a full speed-tuck the instant she leaves the ground.
    // The cut is on the CHARGE AT TAKEOFF, latched as she leaves the ground —
    // not on accumulated airTime, which would only cross a threshold near the
    // END of a big jump and pop her into a tuck on the way down, and not on
    // launch vertical speed, which is not even monotonic here: measured on the
    // real course it goes NEGATIVE at high charge because the hill drops away
    // under her (charge 0.15 -> vy +1.19, charge 1.20 -> vy -2.44).
    // Charge is clean and monotonic. Measured airtime by charge at the pop:
    //     0.18 -> 1.08 s    0.35 -> 1.35 s    0.59 -> 1.62 s    0.94 -> 1.98 s
    // 0.70 sits above a half-charge hop and below a committed jump, so casual
    // air stays in the carve pose and only a real boost of a jump tucks.
    bigAirCharge: 0.70,
  };
  need();
  new GLTFLoader().load('/assets/characters/nyx_tuck.glb', (gltf) => {
    const m = gltf.scene;
    unlit(m);
    m.scale.setScalar(TUCK.scale);
    m.rotation.set(0, TUCK.rotY * Math.PI / 180, 0);
    m.position.set(...TUCK.pos);
    m.visible = false;
    rider.trick.add(m);
    m.userData.editable = 'TUCK';
    nyxTuck = m;
    done();
  }, undefined, (e) => { console.warn('[nyx] tuck pose failed:', e?.message || e); done(); });

  // ---- NOSE GRAB: held in the air ----------------------------------------
  // Front hand down and forward past the leading foot to the board's nose,
  // trailing arm back as counterweight. Held on the grab input, which in the
  // air is SHIFT — the same key the trick system already reads as input.grab,
  // so the pose and the scoring cannot disagree about whether a grab is
  // happening.
  //
  // Scale 0.6190 by surface area, not by the head band: folded this far the
  // band catches her back and reported 0.6106 -> 1.10 m, which is nonsense.
  const GRAB = { scale: 0.6190, rotY: 70, pos: [-0.100, 0.135, 0.050] };
  need();
  new GLTFLoader().load('/assets/characters/nyx_grab.glb', (gltf) => {
    const m = gltf.scene;
    unlit(m);
    m.scale.setScalar(GRAB.scale);
    m.rotation.set(0, GRAB.rotY * Math.PI / 180, 0);
    m.position.set(...GRAB.pos);
    m.visible = false;
    rider.trick.add(m);
    m.userData.editable = 'GRAB';
    nyxGrab = m;
    done();
  }, undefined, (e) => { console.warn('[nyx] grab pose failed:', e?.message || e); done(); });

  // WHICH MESH IS ON SCREEN. Driven off `lean` — the kinematic bank angle the
  // rig already computes from yawRate and speed for the board roll — because
  // that is the number that actually says "she is carving", and it is already
  // smoothed. Raw steering input is not: a keyboard tap would strobe the swap.
  //
  // HYSTERESIS, not a single threshold. With one bar, a turn held near it makes
  // the two meshes flicker back and forth every frame. onAt/offAt are far apart
  // enough that a steady carve stays committed.
  //
  // PRIORITY: tuck beats carve beats neutral. Holding boost through a turn
  // stays in the tuck — that is the whole point of it, and a carve pose taking
  // over mid-boost would read as her standing up to turn while accelerating.
  let carving = false, tucking = false, grabbing = false, tuckHold = 0;
  let picked = null;   // dev editor: click-selected object
  let lastCharge = 0, launchCharge = 0, wasGroundPose = true;
  let forcePose = 0;   // 0 none (live), 1 carve, 2 tuck — editor only
  function poseSwap(st, inp, dt) {
    if (!nyx) return;
    if (st && inp) {
      // ASK riderMode(), NOT st.onGround. Physics has THREE states, and a rider
      // grinding a rail is CONSTRAINED — neither on the ground nor in the air.
      // Reading onGround directly is what starved the rail balance channel and
      // dropped her through rails after 12.4 m; tests/suite.mjs bans it in this
      // file for that reason. Here it also happens to be the correct answer:
      // a grind must not put her in an air pose.
      const mode = riderMode(st);
      const grounded = mode !== 'air';

      // Latch the charge she actually left the ground with. It is gone from
      // st.charge by the next frame, so it has to be captured on the edge.
      if (grounded) lastCharge = st.charge ?? 0;
      else if (wasGroundPose) launchCharge = lastCharge;
      wasGroundPose = grounded;

      // TUCK: boost held, or big air. Not every jump — a medium hop stays in
      // the carve pose so she does not snap standing -> full squat.
      const bigAir = !grounded && launchCharge >= TUCK.bigAirCharge;
      // GRAB OUTRANKS EVERYTHING IN THE AIR. It is the move the player is
      // deliberately performing and being scored on; a speed tuck taking over
      // mid-grab would show a pose that contradicts the HUD.
      grabbing = !grounded && !!inp.grab;
      const wantTuck = !!inp.boost || bigAir;
      if (wantTuck) tuckHold = TUCK.releaseHold;
      else tuckHold = Math.max(0, tuckHold - (dt ?? 0));
      tucking = wantTuck || tuckHold > 0;

      // CARVE is now the MIDDLE pose in every sense: a hard turn, a jump being
      // charged, or any air that is not big air. Charging is the wind-up — she
      // is already crouching to pop, so standing there bolt upright reads wrong.
      const a = Math.abs(lean);
      if (!carving && a >= CARVE.onAt) carving = true;
      else if (carving && a <= CARVE.offAt) carving = false;
      const charging = grounded && !!inp.crouch;
      carving = carving || charging || (!grounded && !bigAir);
    }
    const showGrab = forcePose === 3 || (forcePose === 0 && grabbing && !!nyxGrab);
    const showTuck = forcePose === 2 || (forcePose === 0 && !showGrab && tucking && !!nyxTuck);
    const showCarve = forcePose === 1 ||
      (forcePose === 0 && !showGrab && !showTuck && carving && !!nyxCarve);
    nyx.visible = !showGrab && !showTuck && !showCarve;
    if (nyxCarve) nyxCarve.visible = showCarve;
    if (nyxTuck) nyxTuck.visible = showTuck;
    if (nyxGrab) nyxGrab.visible = showGrab;
  }

  // ONE POSE. Every pose except the standing stance was wrong in play, so the
  // pose machine is switched off rather than left cycling through bad poses.
  // The clips are still in the GLB; re-enabling means restoring poseFor().
  function driveNyx(st, inp, dt) {
    poseSwap(st, inp, dt);
    if (!mixer) return;
    mixer.update(dt);
    groundNyx();
  }

  // GROUND HER IN THE GAME, not in the exported clip. Poses are rotation-only:
  // baking a hips TRANSLATION into the clips put her 0.85 m through the board in
  // the browser (a bone translation does not survive Blender -> glTF -> three.js
  // faithfully, and re-importing into Blender hid it because the error cancels
  // through the same converter). Here the foot bone's live world position is
  // known exactly, so the offset is measured every frame and is correct for any
  // pose, including ones authored later.
  const NOSE_TRIM = -15 * Math.PI / 180;   // 15 deg nose-down, art call
  const DECK_Y = 0.135;                    // top of the board deck, local to `trick`
  let groundOff = 0;
  const _lo = new THREE.Vector3();
  let _fl = null, _fr = null;
  // Ankle-to-sole: the foot BONE sits at the ankle, 0.099 m above the sole in
  // the source mesh (mesh floor 0.000, footL bone 0.099). Measured once in
  // Blender rather than guessed.
  const ANKLE_TO_SOLE = 0.099;
  function groundNyx() {
    if (!nyx) return;
    if (!_fl) {
      nyx.traverse((o) => {
        if (!o.isBone) return;
        if (o.name === 'footL') _fl = o;
        if (o.name === 'footR') _fr = o;
      });
      if (!_fl) return;
    }
    // Box3.setFromObject uses the BIND-POSE bounds for a SkinnedMesh, not the
    // posed geometry, so it reported a sole 0.47 m too low and shoved her into
    // the air. Bone positions are live and correct.
    let lo = Infinity;
    for (const bn of [_fl, _fr]) {
      if (!bn) continue;
      bn.updateWorldMatrix(true, false);
      _lo.setFromMatrixPosition(bn.matrixWorld);
      rider.trick.worldToLocal(_lo);
      lo = Math.min(lo, _lo.y - ANKLE_TO_SOLE);
    }
    if (!Number.isFinite(lo)) return;
    const want = nyx.position.y + (DECK_Y - lo);
    groundOff += (want - groundOff) * 0.5;
    nyx.position.y = groundOff;
  }
  // Carve BANK: the whole rig rolls about the board's long axis by the real
  // kinematic bank angle atan(a_lat / g) = atan(|yawRate| * speed / g) — the
  // same edge model the spray shader inverts — so a full-lock apex shows an
  // edged board and a body inclined ~50 deg into the turn. Smoothed so stamp
  // noise in yawRate never judders the mesh.
  let lean = 0;
  let tuckAmt = 0;                        // smoothed tuck/crouch pose blend
  function applyRider(st, inp, dt) {
    rider.root.position.set(st.pos[0], st.pos[1] + 0.04, st.pos[2]);
    rider.root.rotation.y = -st.heading;
    const sp = Math.hypot(st.vel[0], st.vel[2]);
    const leanTgt = st.onGround
      ? clamp(Math.atan2((st.yawRate || 0) * sp, 9.81), -0.88, 0.88)
      : lean * 0.4;                       // airborne: mostly level the board
    const k = 1 - Math.exp(-10 * (dt || FIXED_DT));
    lean += (leanTgt - lean) * k;
    rider.trick.rotation.x = -lean;

    // Shadow follows the rider's GROUND position, sits on the terrain, and
    // fades and spreads with height — the two cues that say how far off the
    // snow she is. Sampled from the same sampleHeight the physics uses, so it
    // cannot disagree with the surface she is standing on.
    {
      const sx = st.pos[0], sz = st.pos[2];
      const gy = sampleHeight(sx, sz);
      const h = Math.max(0, st.pos[1] - gy);
      const grow = 1 + Math.min(1.6, h * 0.35);      // spreads as she rises
      const fade = Math.max(0, 1 - h / 7);           // gone by ~7 m up
      rider.shadow.visible = fade > 0.02;
      if (rider.shadow.visible) {
        rider.shadow.position.set(sx, gy + 0.045, sz);
        rider.shadow.scale.set(2.5 * grow, 1.5 * grow, 1);
        rider.shadow.rotation.z = -st.heading;       // aligns with the board
        rider.shadow.material.opacity = fade;
      }
    }
    // flips pitch the rig about the board's lateral axis; in the air a nose-up
    // tweak arc (rise then level) sells the jump even with no flip scripted
    // 0.55 rad is 31 deg of nose-up pitch on the WHOLE rig, board and rider
    // together. On top of the -15 deg trim that swung her hard nose-high in the
    // air and read as the rider being contorted, when the air POSE itself is
    // fine in isolation. Halved to 0.26 rad (15 deg).
    const airTweak = st.onGround ? 0
      : 0.26 * Math.sin(Math.min((st.airTime || 0) * 2.2, Math.PI));
    // NOSE-DOWN TRIM. The whole rig (board AND rider) sits nose-high without
    // this; a rider descending a slope points the nose down the fall line.
    // Sign verified by measuring the board's nose height against its tail.
    rider.trick.rotation.z = (st.flipDeg || 0) * DEG + airTweak + NOSE_TRIM;
    // ---- pose from motion state (r3 mustFix: "bolt-upright T-pose") -------
    // tuck/crouch fold the BODY (not the board): squash + forward fold; the
    // arms bar sweeps back along the body in a tuck and counter-tilts with
    // the carve lean when riding open — never a static horizontal T.
    const tuckTgt = ((inp && (inp.tuck || inp.crouch)) ? 1 : 0)
                  + 0.6 * (st.charge || 0);
    tuckAmt += (clamp(tuckTgt, 0, 1) - tuckAmt) * k;
    const squash = 1 - 0.25 * (st.charge || 0) - 0.30 * tuckAmt;
    rider.pose.scale.set(1, Math.max(squash, 0.45), 1);
    rider.pose.rotation.z = 0.38 * tuckAmt;         // fold chest over the nose
    rider.arms.rotation.x = 0.9 * lean;             // arm bar banks into the turn
    rider.arms.rotation.z = -0.55 * tuckAmt;        // sweep back when tucked
    rider.arms.scale.z = 1 - 0.45 * tuckAmt;        // pull the arms in
    rider.arms.position.y = 1.12 - 0.18 * tuckAmt;
  }

  // ---- one real 60 Hz rig step: physics + chase cam + snow + proxy -------
  let inputSource = scriptInput;
  const tricks = createTricks({});
  let tstate = tricks.init();
  // Run structure: start gate, clock, finish, results — and the corridor that
  // keeps the rider off the 83 m backdrop cells where the visible mesh and the
  // physics ground diverge by up to 76.8 m (the "rides through the world" bug).
  // The module was gated and promoted but never wired into the rig; without it
  // a boosted rider reaches z = 3277, i.e. 527 m past the detailed corridor.
  const runSys = createRun({
    sampleHeight,
    courseCenterX: centerX,
    bounds: { zStart: 0, zFinish: 2400, halfWidth: 120, zBackstop: -80 },
  });
  let rstate = runSys.init();
  // Rails: the module captures against the SAME polylines the renderer draws.
  const railGeom = buildRails(sampleHeight, centerX);
  const railSys = createRails({ sampleHeight, surface: 'snow', rails: railGeom });
  let gstate = railSys.init();
  let wasOnRail = false;
  let frozen = false;

  // ---- FREE CAMERA (dev editor) -------------------------------------------
  // The chase cam is the game's camera and stays exactly as gated. This is a
  // SEPARATE mode: while it is on, chase.update() is skipped and the camera is
  // driven from an orbit around a pivot instead, so an object can be inspected
  // from any angle and distance to confirm exactly where it sits.
  //
  // Spherical about a pivot rather than a fly-through, because the job here is
  // "look at this thing from all sides", not "travel". Zoom moves the eye along
  // the view ray, so it frames tighter without changing what is centred.
  const freeCam = {
    on: false,
    pivot: new THREE.Vector3(),
    yaw: 0, pitch: -0.25, dist: 6,
    minDist: 0.25, maxDist: 400,
  };
  function freeCamApply() {
    const cp = Math.cos(freeCam.pitch), sp = Math.sin(freeCam.pitch);
    camera.position.set(
      freeCam.pivot.x + freeCam.dist * cp * Math.sin(freeCam.yaw),
      freeCam.pivot.y + freeCam.dist * sp,
      freeCam.pivot.z + freeCam.dist * cp * Math.cos(freeCam.yaw),
    );
    camera.lookAt(freeCam.pivot);
    camera.updateMatrixWorld(true);
  }

  // START GRID. Five slots across the fall line, 3.2 m apart, on one z. Slot 2
  // (the middle) is the player's; rivals take the rest, and the whole row
  // leaves at the same speed on the same heading.
  const START_Z = 15, START_PITCH = 3.2, START_SLOTS = 5;
  // startHeading already exists for the scripted timeline; reuse it.
  function startSlot(k) {
    // spread ACROSS the slope, i.e. perpendicular to the fall line, so the row
    // reads as a start line rather than as a queue
    const off = (k - (START_SLOTS - 1) / 2) * START_PITCH;
    const x = centerX(START_Z) + off;
    return [x, sampleHeight(x, START_Z) + 0.05, START_Z];
  }

  // ---- RIVALS ------------------------------------------------------------
  // The module has been gated for three blind cycles and was never wired into
  // anything a player runs — 14 AI gates green against code the game did not
  // call. Same failure as the run module before it (see above).
  //
  // THE CONTRACT IS ENFORCED HERE, not trusted: the module returns INPUTS and
  // this rig owns every rival's physics. It is handed the world read-only and
  // its return value is fed to physics.step exactly like the player's keyboard.
  // Nothing it can return moves anybody directly.
  const RIVAL_ROSTER = [
    { id: 'r1', tier: 'easy' }, { id: 'r2', tier: 'easy' },
    { id: 'r3', tier: 'medium' }, { id: 'r4', tier: 'hard' },
  ];
  const RIVAL_TINT = [0x35c8ff, 0xffcf3a, 0x9d6bff, 0xff4d6d];
  const rivalMod = createRivals({
    sampleHeight,
    courseCenterX: centerX,
    bounds: { zStart: 0, zFinish: 2400, halfWidth: 120 },
    roster: RIVAL_ROSTER.map(r => ({ ...r })),
    // Seeded from the run, not from the clock: same run, same race. A
    // wall-clock seed would make a run unrepeatable and would fail AI-11 if it
    // were ever graded here.
    seed: 7,
    assist: true,
  });
  const rivalCfg = rivalMod.config ?? {};
  let rvState = rivalMod.init();
  const rivals = RIVAL_ROSTER.map((r, i) => {
    const stats = rivalCfg.tiers?.[r.tier]?.stats ?? {};
    const ph = createPhysics({ sampleHeight, surface: 'snow' }, { stats });
    // A PROPER START LINE. They used to be strung along the centreline at a
    // fixed 5 m pitch with the player dropped on top of them, which is why the
    // spawn looked like an accident. Now the whole field — player included —
    // is laid out ACROSS the fall line on one row: same z, even spacing,
    // centred on the course, every rider sitting on the terrain and pointing
    // down the hill. The player takes the middle slot.
    // Same velocity as the player, so the whole row leaves the line together
    // rather than the player rolling away from four parked riders.
    const st = ph.init(startSlot(i < 2 ? i : i + 1), [...startVel], startHeading);
    const grp = new THREE.Group();
    // Placed at spawn, not only inside stepRivals: the group otherwise sits at
    // the world origin — far below the mountain and invisible — until the first
    // physics step happens to run.
    grp.position.set(st.pos[0], st.pos[1], st.pos[2]);
    grp.rotation.y = -st.heading;
    scene.add(grp);
    return { ...r, ph, st, grp, tint: RIVAL_TINT[i % RIVAL_TINT.length], mesh: null };
  });

  // Rivals wear the CARVE sculpt, not the rigged neutral one: it is an unrigged
  // 28k-tri static mesh, so four of them cost no skinning at all, and a rider
  // permanently in a carving pose is the right read for someone racing past.
  // Tinted per rival so you can tell them apart at distance.
  function dressRivals(src) {
    for (const rv of rivals) {
      if (rv.mesh) continue;
      const m = src.clone(true);
      // The source carve mesh lives HIDDEN on the player — it is only shown
      // mid-turn — and clone(true) copies that flag, so every rival spawned
      // invisible. Nothing else was wrong; they were stepping correctly the
      // whole time.
      m.visible = true;
      m.traverse((o) => {
        if (!o.isMesh) return;
        o.material = o.material.clone();
        o.material.color = new THREE.Color(rv.tint);
        o.material.map = null;      // flat tint reads better than a shared texture
      });
      m.scale.setScalar(CARVE.scale);
      m.rotation.set(0, CARVE.rotY * Math.PI / 180, 0);
      m.position.set(...CARVE.pos);
      rv.grp.add(m);
      // THEIR OWN BOARD, not a clone of the player's. The modelled snowboard is
      // Nyx's; four identical copies of it in a race reads as a bug rather than
      // as a field. Each rival gets a procedural deck in its own colour, which
      // is also what makes them tellable apart at 100 m.
      const bd = makeProceduralBoard(rv.tint);
      bd.position.y = 0.135 - 0.012 - 0.023;
      rv.grp.add(bd);
      rv.mesh = m;
      console.log('[rivals] dressed', rv.id, rv.tier);
    }
  }

  function stepRivals(dt) {
    // Dressed lazily rather than from the GLB callback: the mesh loads async and
    // this rig must not depend on which of the two finished first.
    // Dressed only once BOTH the rider mesh and the board model are in, so a
    // rival never gets cloned holding the procedural fallback deck.
    if (nyxCarve && boardMesh) dressRivals(nyxCarve);
    const world = {
      t: liveTime, dt,
      player: liveState,
      rivals: Object.fromEntries(rivals.map(r => [r.id, r.st])),
    };
    const table = rivalMod.step(rvState, world, dt) ?? {};
    if (!stepRivals._logged) {
      stepRivals._logged = true;
      console.log('[rivals] stepping', rivals.map(r => r.id + '@z' + r.st.pos[2].toFixed(0)).join(' '));
    }
    for (const rv of rivals) {
      const inp = table[rv.id] ?? {};
      rv.ph.step(rv.st, inp, dt);
      rv.grp.position.set(rv.st.pos[0], rv.st.pos[1], rv.st.pos[2]);
      rv.grp.rotation.y = -rv.st.heading;
    }
  }
  function advance(dt) {
    const inp = inputSource(liveTime, liveState);
    const wasAir = !liveState.onGround;
    physics.step(liveState, inp, dt);
    stepRivals(dt);
    // trick system observes physics + input each frame; on touchdown its
    // landing override (incomplete uber = crash) replaces the physics verdict
    if (wasAir && liveState.onGround && liveState.landing) {
      const ov = tricks.landingOverride(tstate, liveState);
      if (ov) liveState.landing = ov;
    }
    // rails run AFTER physics and BEFORE the run/trick bookkeeping: the module
    // constrains the rider for this frame, physics integrated it last frame.
    railSys.step(gstate, liveState, inp, dt);
    // GRIND -> SCORE. Nothing read gs.onRail before this, so grinding produced
    // no points, no meter and no HUD award: the mechanic was invisible to the
    // rest of the game. Accrue while locked, bank once on release, and tell the
    // trick system whether she rode it out or bailed.
    if (gstate.onRail) {
      tricks.grind(tstate, dt, gstate.alongSpeed);
      wasOnRail = true;
    } else if (wasOnRail) {
      tricks.grindEnd(tstate, !gstate.bailed);
      wasOnRail = false;
    }
    driveNyx(liveState, inp, dt);
    tricks.step(tstate, liveState, inp, dt);
    runSys.step(rstate, liveState, tstate, dt);
    hashState(liveState);
    liveTime += dt;
    if (liveState.onGround && !prevOnGround) {
      chase.addTrauma(liveState.landing === 'crash' ? 0.5 : 0.2);
    }
    prevOnGround = liveState.onGround;
    riderRef.state = liveState;
    // ground height under the rider: feeds the snow package's blob shadow
    // (strength/radius vs. air height)
    riderRef.groundY = sampleHeight(liveState.pos[0], liveState.pos[2]);
    // The free camera owns the transform while it is on; running the chase rig
    // as well would fight it every frame.
    if (freeCam.on) freeCamApply();
    else { chase.update(liveState, dt); camClamp(); speedFov(); }
    snow.update(dt);
    lastInput = inp;
    applyRider(liveState, inp, dt);
  }

  // Integration-layer ground clearance: the boom points uphill on a ~23 deg
  // slope, so the terrain 6 m behind the rider is ~2.5 m HIGHER — exactly the
  // boom height — and the raw chase position can sit at/under the snow.
  // Clamp above the surface, then re-aim at the chase cam's own look target.
  function camClamp() {
    const cp = camera.position;
    const gy = sampleHeight(cp.x, cp.z) + 1.5;
    if (cp.y < gy) {
      cp.y = gy;
      const la = chase.debug.lookAtTarget;
      camera.lookAt(la[0], la[1], la[2]);
    }
  }

  // Speed-cue FOV kick (round 2 mustFix: "no visible FOV kick ... in any
  // frame"): on top of the chase cam's own conservative CF-07 kick, the
  // composed rig widens the lens hard with horizontal speed — at cruise
  // (~20+ m/s) the frame visibly bows out. Applied AFTER chase.update every
  // step (the chase cam re-asserts its own fov first, so nothing accumulates).
  function speedFov() {
    const sp = Math.hypot(liveState.vel[0], liveState.vel[2]);
    const t = Math.min(sp / 28, 1);
    // airborne: shed most of the kick — the wide lens was shrinking the rider
    // to a speck exactly when the air frame needs the silhouette to read
    const k = liveState.onGround ? 1 : 0.3;
    camera.fov = Math.min(camera.fov + 9 * t * t * k, 96);
    camera.updateProjectionMatrix();
  }

  // settle the camera on the start pose
  riderRef.state = liveState;
  for (let i = 0; i < 45; i++) chase.update(liveState, FIXED_DT);
  camClamp();
  speedFov();
  riderRef.groundY = sampleHeight(liveState.pos[0], liveState.pos[2]);
  snow.update(FIXED_DT);   // primes the rider blob shadow for the t=0 frame
  applyRider(liveState, {});

  // ---- flythrough: seek the scripted run through a HIGHLIGHT REEL --------
  // The capture harness samples t = 0..1 evenly; a linear time map would
  // spend most frames cruising between moments. Instead t is remapped through
  // a keyframe table clustered on the run's beats: five full-lock carve
  // apexes, the tucked hero shot over the S-groove, the carve back in, the
  // big-air apex, the touchdown burst, and the closing carve-out. The map is
  // monotonic, so forward seeks still REPLAY every 60 Hz step (real trail
  // stamps, spray and camera smoothing between frames).
  // (round 4: the old closing frame at 26.75 framed a distant rider buried in
  // his own plume — replaced by a SECOND air frame late in the arc, and the
  // reel now closes on the landed carve at 26.05 where the groove curves away)
  const CAPTURE_TIMES = [6.20, 7.25, 10.60, 12.25, 13.25, 19.80, 20.75, 23.90, 24.35, 26.05];
  function remapT(t) {
    const u = clamp(Number(t) || 0, 0, 1) * (CAPTURE_TIMES.length - 1);
    const i = Math.min(Math.floor(u), CAPTURE_TIMES.length - 2);
    return CAPTURE_TIMES[i] + (u - i) * (CAPTURE_TIMES[i + 1] - CAPTURE_TIMES[i]);
  }
  const MAX_REPLAY = 600;                 // cap replay work per seek (~10 s sim)
  function flythrough(t) {
    const T = clamp(remapT(t), 0, DURATION);
    if (T + 1e-6 < liveTime) {
      // backward seek: restore the snapshot, re-settle the camera
      const idx = Math.max(0, Math.min(Math.round(T / FIXED_DT), N_STEPS));
      liveState = cloneState(timeline[idx]);
      liveTime = idx * FIXED_DT;
      prevOnGround = liveState.onGround;
      riderRef.state = liveState;
      for (let i = 0; i < 90; i++) chase.update(liveState, FIXED_DT);
      camClamp();
      speedFov();
      applyRider(liveState, scriptInput(liveTime, liveState));
      return;
    }
    let steps = Math.round((T - liveTime) / FIXED_DT);
    if (steps > MAX_REPLAY) {
      // jump to a checkpoint MAX_REPLAY*2/3 steps short, then replay for real
      const idx = Math.max(0, Math.min(Math.round(T / FIXED_DT) - 400, N_STEPS));
      liveState = cloneState(timeline[idx]);
      liveTime = idx * FIXED_DT;
      prevOnGround = liveState.onGround;
      riderRef.state = liveState;
      for (let i = 0; i < 60; i++) chase.update(liveState, FIXED_DT);
      steps = Math.round((T - liveTime) / FIXED_DT);
    }
    for (let i = 0; i < steps; i++) advance(FIXED_DT);
  }

  // ---- fixed-step live update (harness + later interactive use) ----------
  let acc = 0;
  function update(dt) {
    // FROZEN: the dev pose editor holds the sim still so the rider can be
    // rotated onto the board by hand. Rendering continues; nothing advances.
    if (frozen) { acc = 0; return; }
    acc += Math.min(Number.isFinite(dt) ? dt : FIXED_DT, 0.1);
    let n = 0;
    while (acc >= FIXED_DT - 1e-9 && n < 6) { advance(FIXED_DT); acc -= FIXED_DT; n++; }
  }

  return {
    update,
    render(alphaMs) { app.render(alphaMs); },
    scene, camera, renderer,
    sampleHeight,
    flythrough,
    // interactive hooks (not part of the harness contract)
    setInputSource(fn) { inputSource = fn ?? scriptInput; },
    riderState: () => liveState,
    trickState: () => tstate,
    // ---- DEV POSE EDITOR hooks (index.html, F key) ------------------------
    // Rotation could not be dialled in by prompting: I cannot judge a 3D pose by
    // looking, and every value I argued for was a coin flip. These let the
    // PERSON who can see it freeze the game and nudge her onto the board, then
    // read exact numbers back.
    // The editor edits WHATEVER IS ON SCREEN. With two meshes, returning the
    // neutral one while the carve pose is showing means the keys move a model
    // the person cannot see — which is exactly the trap the editor exists to
    // avoid.
    riderModel: () => {
      const p = forcePose || (grabbing && nyxGrab ? 3
        : tucking && nyxTuck ? 2 : (carving && nyxCarve ? 1 : 0));
      return p === 3 ? (nyxGrab ?? nyx) : p === 2 ? (nyxTuck ?? nyx)
        : p === 1 ? (nyxCarve ?? nyx) : nyx;
    },
    carveConfig: () => CARVE,
    tuckConfig: () => TUCK,
    grabConfig: () => GRAB,
    // Board orientation, live-tunable. boardMesh is the wrapper the model sits
    // in, so editing it edits exactly what the game renders.
    boardModel: () => boardMesh,
    // ---- CLICK TO PICK (dev editor) --------------------------------------
    // Raycast from normalised device coords and return the nearest EDITABLE
    // object under the cursor. Editable roots are tagged with
    // userData.editable at load; the hit is a leaf mesh, so this walks UP to
    // the tagged ancestor — clicking her jacket should move the whole rider,
    // not one submesh of it.
    //
    // Invisible objects are skipped: the pose meshes that are not currently on
    // screen are still in the graph, and picking one you cannot see would look
    // like the click did nothing.
    pick(ndcX, ndcY) {
      const rc = new THREE.Raycaster();
      rc.setFromCamera({ x: ndcX, y: ndcY }, camera);
      const hits = rc.intersectObjects(scene.children, true);
      for (const h of hits) {
        let o = h.object;
        // An InstancedMesh hit is one tree of hundreds sharing a buffer, so there
        // is nothing single to move — SKIP it and keep looking. Returning here
        // let a tree standing behind the rider swallow the click and report
        // "not movable" while she was the obvious thing under the cursor.
        if (o.isInstancedMesh) continue;
        let vis = true;
        for (let p2 = o; p2; p2 = p2.parent) if (p2.visible === false) { vis = false; break; }
        if (!vis) continue;
        for (let p2 = o; p2; p2 = p2.parent) {
          if (p2.userData?.editable) {
            picked = p2;
            return { name: p2.userData.editable, movable: true,
                     dist: +h.distance.toFixed(2) };
          }
        }
      }
      // SCREEN-SPACE FALLBACK. Raycasting is precise but easy to defeat: a
      // SkinnedMesh is tested against its BIND-POSE bounds, which for this
      // character are metres from where she is drawn, and any geometry whose
      // transform was baked has a stale bounding sphere. Rather than depend on
      // bounds being right everywhere, fall back to "the nearest editable
      // thing to where you clicked, in screen space". For a handful of tagged
      // objects that is exactly as useful and cannot silently fail.
      const cand = [];
      scene.traverse((o) => {
        if (!o.userData?.editable) return;
        let vis = true;
        for (let p2 = o; p2; p2 = p2.parent) if (p2.visible === false) { vis = false; break; }
        if (vis) cand.push(o);
      });
      const v = new THREE.Vector3();
      let best = null, bestD = Infinity;
      for (const o of cand) {
        o.getWorldPosition(v);
        v.project(camera);
        if (v.z > 1) continue;                       // behind the camera
        const d = Math.hypot(v.x - ndcX, v.y - ndcY);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best && bestD < 0.35) {
        picked = best;
        return { name: best.userData.editable, movable: true,
                 dist: +bestD.toFixed(3), via: 'nearest' };
      }
      return null;
    },
    pickedName: () => (picked ? picked.userData.editable : null),
    pickedModel: () => picked,
    clearPick() { picked = null; },
    boardConfig: () => BOARD_MODEL,
    // 0 none (live), 1 carve, 2 tuck. Cycled by N in the editor.
    setForcePose(v) { forcePose = v | 0; poseSwap(); },
    forcePose: () => forcePose,
    poseName: () => (forcePose === 3 ? 'GRAB' : forcePose === 2 ? 'TUCK'
      : forcePose === 1 ? 'CARVE' : 'NEUTRAL'),
    cameraConfig: () => chase.config,   // live-tunable from the pose editor
    // Resolves once every GLB is in — or has failed. index.html holds a cover
    // over the canvas until then so the placeholder state is never seen.
    onReady(cb) { if (readyFired) cb(); else readyCbs.push(cb); },
    setFrozen(v) { frozen = !!v; },
    // ---- free camera, dev editor only -------------------------------------
    freeCam: {
      state: () => ({ on: freeCam.on, dist: +freeCam.dist.toFixed(2),
        yaw: +(freeCam.yaw * 180 / Math.PI).toFixed(1),
        pitch: +(freeCam.pitch * 180 / Math.PI).toFixed(1),
        pivot: freeCam.pivot.toArray().map(v => +v.toFixed(2)) }),
      // Enabling snaps the pivot to whatever is selected, or to the rider, so
      // it always starts looking at something rather than at empty sky.
      toggle(target) {
        freeCam.on = !freeCam.on;
        if (freeCam.on) {
          if (target) target.getWorldPosition(freeCam.pivot);
          else freeCam.pivot.set(liveState.pos[0], liveState.pos[1] + 1, liveState.pos[2]);
          // start from roughly where the chase cam was, so the view does not jump
          const d = camera.position.clone().sub(freeCam.pivot);
          freeCam.dist = Math.max(freeCam.minDist, Math.min(freeCam.maxDist, d.length()));
          freeCam.yaw = Math.atan2(d.x, d.z);
          freeCam.pitch = Math.asin(Math.max(-1, Math.min(1, d.y / (d.length() || 1))));
          freeCamApply();
        }
        return freeCam.on;
      },
      focus(target) {
        if (!freeCam.on) return false;
        if (target) target.getWorldPosition(freeCam.pivot);
        else freeCam.pivot.set(liveState.pos[0], liveState.pos[1] + 1, liveState.pos[2]);
        freeCamApply();
        return true;
      },
      orbit(dYaw, dPitch) {
        if (!freeCam.on) return false;
        freeCam.yaw += dYaw;
        // stop just short of the poles: looking straight down the axis makes
        // lookAt's up-vector flip and the view roll over
        const L = Math.PI / 2 - 0.02;
        freeCam.pitch = Math.max(-L, Math.min(L, freeCam.pitch + dPitch));
        freeCamApply();
        return true;
      },
      // Multiplicative zoom: one notch is the same proportion of the current
      // distance whether you are 0.5 m or 200 m out, which is what makes it
      // usable for both "is this box seated" and "where is that tree".
      zoom(mul) {
        if (!freeCam.on) return false;
        freeCam.dist = Math.max(freeCam.minDist,
          Math.min(freeCam.maxDist, freeCam.dist * mul));
        freeCamApply();
        return true;
      },
      pan(dx, dy, dz) {
        if (!freeCam.on) return false;
        // pan in the camera's own frame, so dragging right always moves right
        const e = new THREE.Vector3(), u = new THREE.Vector3(), f = new THREE.Vector3();
        camera.matrixWorld.extractBasis(e, u, f);
        freeCam.pivot.addScaledVector(e, dx).addScaledVector(u, dy).addScaledVector(f, dz);
        freeCamApply();
        return true;
      },
    },
    isFrozen: () => frozen,
    railState: () => gstate,
    runState: () => rstate,
    runResults: () => runSys.results(rstate, tstate),
    tricksApi: { collectStar: (t) => tricks.collectStar(t), knockdown: () => tricks.knockdown() },
    respawn() {
      tstate = tricks.init();
      rstate = runSys.init();
      gstate = railSys.init();
      wasOnRail = false;
      liveState.constrained = false;
      liveState = cloneState(timeline[0]);
      liveTime = 0; acc = 0; prevOnGround = liveState.onGround;
      riderRef.state = liveState;
      for (let i = 0; i < 90; i++) chase.update(liveState, FIXED_DT);
    },
  };
}
