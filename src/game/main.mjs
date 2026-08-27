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
import { boot as bootRender } from './render.mjs';
import { createPhysics, riderMode } from './physics.mjs';
import { applyStick } from './input.mjs';
import { createChaseCam } from './camera.mjs';
import { attachSnow } from './attach.mjs';
import { createTricks } from './tricks.mjs';
import { createRun } from './run.mjs';
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
function buildRider() {
  const root = new THREE.Group();          // yaw (world heading)
  const trick = new THREE.Group();         // flip + carve lean
  root.add(trick);
  const mat = (hex) => new THREE.MeshBasicMaterial({ color: hex });

  const board = new THREE.Mesh(new THREE.BoxGeometry(1.58, 0.09, 0.30), mat(0xff5f00));
  board.position.y = 0.08;
  trick.add(board);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.02, 0.22), mat(0xffe600));
  deck.position.y = 0.135;
  trick.add(deck);
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
  return { root, trick, pose, arms, proxyBody: [legs, torso, arms, head] };
}

// ================================================================== boot
export async function boot(canvas) {
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
  if (typeof window !== 'undefined') window.__RIG__ = rider;   // debug handle

  // ---- real rider mesh, swapped in over the proxy -------------------------
  // Async and non-fatal: if the GLB is missing or fails to parse the game keeps
  // running on the box proxy rather than booting to a black screen.
  let nyx = null, mixer = null, clips = {}, curClip = null;
  let nyxCarve = null, nyxTuck = null;

  // This scene has NO LIGHTS — everything is unlit MeshBasicMaterial. A PBR
  // material here renders black, which is exactly how the rails shipped broken.
  function unlit(model) {
    model.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      const src = Array.isArray(o.material) ? o.material[0] : o.material;
      o.material = new THREE.MeshBasicMaterial({
        map: src.map ?? null,
        color: src.map ? 0xffffff : (src.color ?? new THREE.Color(0xffffff)),
      });
      o.frustumCulled = false;   // skinned bounds go stale during big rotations
      o.castShadow = o.receiveShadow = false;
    });
  }

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
    nyx = model;
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(model);
      for (const c of gltf.animations) { const a = mixer.clipAction(c); a._clipName = c.name; clips[c.name] = a; }
      const first = clips.ride ?? Object.values(clips)[0];
      if (first) { first.play(); curClip = first; }
    }
    console.log('[nyx] loaded', gltf.animations?.map(a => a.name).join(',') || 'no clips');
  }, undefined, (e) => console.warn('[nyx] load failed, keeping proxy:', e?.message || e));

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
    scale: 0.8686,
    rotY: 70,
    pos: [-0.100, 0.135, 0.050],
    onAt: 0.45,      // |lean| in rad at which the carve pose takes over
    offAt: 0.28,     // and the lower bar it has to fall back through
  };
  new GLTFLoader().load('/assets/characters/nyx_carve.glb', (gltf) => {
    const m = gltf.scene;
    unlit(m);
    m.scale.setScalar(CARVE.scale);
    m.rotation.set(0, CARVE.rotY * Math.PI / 180, 0);
    m.position.set(...CARVE.pos);
    m.visible = false;
    rider.trick.add(m);
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
  // DISCLOSED: the head band is the top 8% of the figure's height, and on a
  // sculpt this folded that band may be catching some of her back rather than
  // only her head. If it is, this number is slightly too small and she will
  // read a touch short. It is dialable in the editor and that is where it
  // should be settled, not here.
  const TUCK = {
    scale: 0.7249,
    rotY: 70,
    pos: [-0.100, 0.135, 0.050],
    releaseHold: 0.12,   // s to keep the pose after the input drops
  };
  new GLTFLoader().load('/assets/characters/nyx_tuck.glb', (gltf) => {
    const m = gltf.scene;
    unlit(m);
    m.scale.setScalar(TUCK.scale);
    m.rotation.set(0, TUCK.rotY * Math.PI / 180, 0);
    m.position.set(...TUCK.pos);
    m.visible = false;
    rider.trick.add(m);
    nyxTuck = m;
    console.log('[nyx] tuck pose loaded');
  }, undefined, (e) => console.warn('[nyx] tuck pose failed:', e?.message || e));

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
  let carving = false, tucking = false, tuckHold = 0;
  let forcePose = 0;   // 0 none (live), 1 carve, 2 tuck — editor only
  function poseSwap(st, inp, dt) {
    if (!nyx) return;
    if (st && inp) {
      // Tuck: airborne OR boost held. Both are discrete, so the only flicker
      // risk is a tapped key — releaseHold keeps the pose for a beat after the
      // input drops rather than strobing on every tap.
      const wantTuck = !st.onGround || !!inp.boost;
      if (wantTuck) tuckHold = TUCK.releaseHold;
      else tuckHold = Math.max(0, tuckHold - (dt ?? 0));
      tucking = wantTuck || tuckHold > 0;

      // Carve: hysteresis on the bank angle, as before.
      const a = Math.abs(lean);
      if (!carving && a >= CARVE.onAt) carving = true;
      else if (carving && a <= CARVE.offAt) carving = false;
    }
    const showTuck = forcePose === 2 || (forcePose === 0 && tucking && !!nyxTuck);
    const showCarve = forcePose === 1 || (forcePose === 0 && !showTuck && carving && !!nyxCarve);
    nyx.visible = !showTuck && !showCarve;
    if (nyxCarve) nyxCarve.visible = showCarve;
    if (nyxTuck) nyxTuck.visible = showTuck;
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
  function advance(dt) {
    const inp = inputSource(liveTime, liveState);
    const wasAir = !liveState.onGround;
    physics.step(liveState, inp, dt);
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
    chase.update(liveState, dt);
    camClamp();
    speedFov();
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
      const p = forcePose || (tucking && nyxTuck ? 2 : (carving && nyxCarve ? 1 : 0));
      return p === 2 ? (nyxTuck ?? nyx) : p === 1 ? (nyxCarve ?? nyx) : nyx;
    },
    carveConfig: () => CARVE,
    tuckConfig: () => TUCK,
    // 0 none (live), 1 carve, 2 tuck. Cycled by N in the editor.
    setForcePose(v) { forcePose = v | 0; poseSwap(); },
    forcePose: () => forcePose,
    poseName: () => (forcePose === 2 ? 'TUCK' : forcePose === 1 ? 'CARVE' : 'NEUTRAL'),
    cameraConfig: () => chase.config,   // live-tunable from the pose editor
    setFrozen(v) { frozen = !!v; },
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
