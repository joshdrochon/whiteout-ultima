#!/usr/bin/env node
// Camera-feel gate runner — operational definition of the CF gates in
// references/PHYSICS_GATES.json. Drives a chase-cam candidate with scripted rider
// trajectories and measures its behavior. Pass/fail only.
//
// usage: node harness/camera-runner.mjs --module sandbox/camera-follow/A/camera.mjs [--out <json>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as THREE from 'three';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modPath = resolve(ROOT, opt('module'));
const outPath = opt('out', null);
const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'camera-feel');
const { createChaseCam } = await import(pathToFileURL(modPath).href);

const DT = 1 / 60;
const mkCam = () => new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000);
const rider = (over = {}) => ({ pos: [0, 0, 0], vel: [15, 0, 0], heading: 0,
  onGround: true, spinDeg: 0, airTime: 0, ...over });
const azimuthTo = (cam, p) => Math.atan2(p[2] - cam.position.z, p[0] - cam.position.x);
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// settle the cam on a steady rider before measuring
function settle(rig, st, seconds = 4) {
  for (let t = 0; t < seconds; t += DT) {
    st.pos[0] += st.vel[0] * DT; st.pos[2] += st.vel[2] * DT;
    rig.update(st, DT);
  }
}
function fitLambda(series, dt = DT) {
  const pts = series.map((v, i) => [i * dt, Math.log(Math.max(v, 1e-9))]).filter(p => Number.isFinite(p[1]));
  const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  return -((n * sxy - sx * sy) / (n * sxx - sx * sx));
}

const impl = {
  camera_step(p) {
    if (p.mode === 'split_step') {
      const run = steps => {
        const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
        const st = rider(); settle(rig, st, 3);
        st.pos[0] += 5; st.pos[2] += 3;          // teleport offset
        for (const dt of steps) rig.update(st, dt);
        return cam.position.clone();
      };
      const a = run([p.stepA_ms / 1000]);
      const b = run(Array(p.stepsB).fill(p.stepB_ms / 1000));
      return { splitStepCameraError: a.distanceTo(b) };
    }
    if (p.stepType === 'position') {
      const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
      const st = rider({ vel: [0, 0, 0] }); settle(rig, st, 5);
      const rest = cam.position.clone();
      st.pos[2] += 4;                           // lateral step, rider then static
      const dist = [];
      for (let t = 0; t < 2; t += DT) { rig.update(st, DT); dist.push(Math.abs(cam.position.distanceTo(rest) - 4) < 1e9 ? Math.abs(4 - (cam.position.z - rest.z)) : 0); }
      return { cameraPositionLambda: fitLambda(dist.slice(0, Math.round(0.8 / DT))) };
    }
    if (p.stepType === 'heading90') {
      const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
      const st = rider({ vel: [p.speed, 0, 0] }); settle(rig, st, 5);
      // course direction turns 90 deg instantly; camera azimuth should converge exponentially
      st.vel = [0, 0, p.speed]; st.heading = Math.PI / 2;
      const target = Math.PI / 2, err = [];
      for (let t = 0; t < 3; t += DT) {
        st.pos[0] += st.vel[0] * DT; st.pos[2] += st.vel[2] * DT;
        rig.update(st, DT);
        err.push(Math.abs(wrap(azimuthTo(cam, st.pos) - target)));
      }
      const yawLam = fitLambda(err.slice(0, Math.round(1.2 / DT)));
      // position lambda for the strict-ordering side assert
      const posLam = impl.camera_step({ stepType: 'position' }).cameraPositionLambda;
      return { cameraYawLambda: yawLam, _yawBelowPosOk: yawLam < posLam };
    }
    if (p.inspect === 'lookAtTarget') {
      const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
      const st = rider({ vel: [p.speed, 0, 0] }); settle(rig, st, 5);
      rig.update(st, DT);
      const lt = rig.debug?.lookAtTarget;
      if (!lt) return { lookAheadDistance_m: -1 };
      // distance ahead of rider along velocity direction
      const ahead = (lt[0] - st.pos[0]) * (st.vel[0] / p.speed) + (lt[2] - st.pos[2]) * (st.vel[2] / p.speed);
      return { lookAheadDistance_m: ahead };
    }
    throw new Error('unknown camera_step variant');
  },
  camera_spin(p) {
    const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
    const st = rider({ vel: [18, 0, 0], onGround: p.grounded });
    settle(rig, st, 5);
    const az0 = azimuthTo(cam, st.pos);
    const spinTime = p.spin_deg / 550;          // prewound-rate spin
    let dev = 0;
    for (let t = 0; t < spinTime + 1; t += DT) {
      st.pos[0] += st.vel[0] * DT;
      if (!p.grounded) { st.airTime += DT; }
      const frac = Math.min(1, t / spinTime);
      st.spinDeg = p.spin_deg * frac;
      st.heading = (p.spin_deg * frac * Math.PI / 180) % (2 * Math.PI);
      rig.update(st, DT);
      dev = Math.max(dev, Math.abs(wrap(azimuthTo(cam, st.pos) - az0)) * 180 / Math.PI);
    }
    return { cameraYawDeviation_deg: dev };
  },
  camera_air(p) {
    const dist = grounded => {
      const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
      const st = rider({ vel: [18, 0, 0] }); settle(rig, st, 5);
      if (grounded) return cam.position.distanceTo(new THREE.Vector3(...st.pos));
      // ballistic arc, sample distance at apex
      const g = 6.5, vy = g * p.airtime_s / 2;
      st.onGround = false; st.vel = [18, vy, 0];
      let apexDist = 0, prevVy = vy;
      for (let t = 0; t < p.airtime_s; t += DT) {
        st.vel[1] -= g * DT;
        st.pos[0] += st.vel[0] * DT; st.pos[1] += st.vel[1] * DT;
        st.airTime += DT;
        rig.update(st, DT);
        if (prevVy > 0 && st.vel[1] <= 0) apexDist = cam.position.distanceTo(new THREE.Vector3(...st.pos));
        prevVy = st.vel[1];
      }
      return apexDist;
    };
    const ground = dist(true), apex = dist(false);
    // asymptotic guard (blind-critic finding): a long air must ALSO stay in band —
    // short-arc passes that over-pull at the asymptote are band-fragile tuning
    const saved = p.airtime_s; p.airtime_s = 5; const apexLong = dist(false); p.airtime_s = saved;
    return { apexExtraDistanceFrac: Math.max(apex, apexLong) / ground - 1 };
  },
  camera_landing(p) {
    // Fly a real ballistic arc, land, and watch the boom come home. The judge
    // saw the rider become a speck on the frame AFTER a big air; that is a
    // transient the steady-state gates (CF-02/03/06) cannot see.
    const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
    const st = rider({ vel: [18, 0, 0] });
    settle(rig, st, 5);
    const D0 = cam.position.distanceTo(new THREE.Vector3(...st.pos));   // steady state
    const g = 6.5, vy = g * p.airtime_s / 2;
    st.onGround = false; st.vel = [18, vy, 0]; st.airTime = 0;
    let peak = 0;
    for (let t = 0; t < p.airtime_s; t += DT) {
      st.vel[1] -= g * DT;
      st.pos[0] += st.vel[0] * DT; st.pos[1] += st.vel[1] * DT;
      st.airTime += DT;
      rig.update(st, DT);
      peak = Math.max(peak, cam.position.distanceTo(new THREE.Vector3(...st.pos)));
    }
    // touchdown
    st.onGround = true; st.pos[1] = 0; st.vel[1] = 0; st.airTime = 0; st.landing = 'clean';
    let reconv = Infinity;
    for (let i = 0; i < Math.round(4 / DT); i++) {
      st.pos[0] += st.vel[0] * DT; st.pos[2] += st.vel[2] * DT;
      rig.update(st, DT);
      const d = cam.position.distanceTo(new THREE.Vector3(...st.pos));
      peak = Math.max(peak, d);
      if (reconv === Infinity && Math.abs(d - D0) <= 0.15 * D0) reconv = i * DT;
    }
    const peakOk = peak <= 2.2 * D0;
    return { reconvergeTime_s: peakOk ? +reconv.toFixed(3) : 99,
      _steady: +D0.toFixed(2), _peak: +peak.toFixed(2), _peakRatio: +(peak / D0).toFixed(2),
      _peakOk: peakOk };
  },
  camera_fov(p) {
    const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
    const base = cam.fov;
    const st = rider(); settle(rig, st, 3);
    if (p.cues) {
      let prev = -Infinity, mono = 1;
      for (const tier of p.boostTiers) {
        rig.setBoostTier?.(tier);
        const st2 = rider({ vel: [25, 0, 0] });
        settle(rig, st2, 3);
        if (cam.fov <= prev) mono = 0;
        prev = cam.fov;
      }
      return { boostLadderMonotonic: rig.setBoostTier ? mono : 0 };
    }
    let maxFov = base;
    for (const v of p.speedSweep) for (const tier of p.boostTiers) {
      rig.setBoostTier?.(tier);
      const st2 = rider({ vel: [v, 0, 0] });
      settle(rig, st2, 3);
      maxFov = Math.max(maxFov, cam.fov);
    }
    return { fovKickMaxFrac: maxFov / base - 1 };
  },
  camera_shake(p) {
    // static rider, settled camera -> any deviation from rest is pure shake
    const amp = trauma => {
      const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
      const st = rider({ vel: [0, 0, 0] });
      for (let t = 0; t < 6; t += DT) rig.update(st, DT);
      const rest = cam.position.clone();
      rig.addTrauma?.(trauma);
      let peak = 0;
      for (let t = 0; t < 0.8; t += DT) {
        rig.update(st, DT);
        peak = Math.max(peak, cam.position.distanceTo(rest));
      }
      return peak;
    };
    const probe = createChaseCam(mkCam(), { seed: 5 });
    if (!probe.addTrauma) return { shakeModelCorrect: 0 };
    const a1 = amp(p.traumaInject[2]);
    if (a1 < 1e-4) return { shakeModelCorrect: 0 };
    const r03 = amp(p.traumaInject[0]) / a1, r06 = amp(p.traumaInject[1]) / a1;
    const ok = Math.abs(r03 - p.expectShakeFrac[0]) < 0.08 && Math.abs(r06 - p.expectShakeFrac[1]) < 0.15;
    return { shakeModelCorrect: ok ? 1 : 0, _r03: +r03.toFixed(3), _r06: +r06.toFixed(3) };
  },
  camera_crash(p) {
    const cam = mkCam(); const rig = createChaseCam(cam, { seed: 5 });
    const st = rider({ vel: [25, 0, 0] }); settle(rig, st, 5);
    // crash: 80% speed loss in one frame + seeded tumble jitter
    st.vel = [5, 0, 0];
    let s = 42; const rnd = () => (s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5;
    let prev = cam.position.clone(), maxJump = 0;
    // first 0.5 s excluded: the camera is legitimately decelerating from follow speed;
    // the gate tests jitter rejection / no snapping, not smooth deceleration
    for (let t = 0; t < p.crashDuration_s; t += DT) {
      st.vel[0] *= Math.exp(-2 * DT);
      st.pos[0] += st.vel[0] * DT + rnd() * 0.4;
      st.pos[1] = Math.abs(rnd()) * 0.3;
      st.pos[2] += rnd() * 0.4;
      rig.update(st, DT);
      if (t > 0.5) maxJump = Math.max(maxJump, cam.position.distanceTo(prev));
      prev = cam.position.clone();
    }
    return { maxPerFrameCameraJump_m: maxJump };
  },
};

const results = [];
for (const g of GATES) {
  const sc = g.scenario?.scenario, params = g.scenario?.params ?? {};
  let row;
  try {
    const m = impl[sc](params);
    const val = m[g.metric];
    let pass;
    if (g.op === 'in_range') pass = val >= g.min && val <= g.max;
    else if (g.op === 'lte') pass = val <= g.value;
    else if (g.op === 'gte') pass = val >= g.value;
    else if (g.op === 'eq') pass = Math.abs(val - g.value) < 1e-9;
    const side = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('_')));
    const sideOk = Object.entries(side).every(([k, v]) => k.endsWith('Ok') ? v !== false : true);
    row = { id: g.id, tag: g.tag, status: (pass && sideOk) ? 'pass' : 'fail',
      metric: g.metric, value: typeof val === 'number' ? +val.toPrecision(5) : val,
      expect: g.op === 'in_range' ? `[${g.min}, ${g.max}]` : `${g.op} ${g.value}`, ...side };
  } catch (err) {
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err.message).slice(0, 160) };
  }
  results.push(row);
}
const counts = { pass: 0, fail: 0, error: 0 };
let hardFails = 0;
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if (r.status !== 'pass' && r.tag === 'HARD') hardFails++;
}
if (outPath) { mkdirSync(dirname(resolve(ROOT, outPath)), { recursive: true }); writeFileSync(resolve(ROOT, outPath), JSON.stringify({ module: modPath, counts, hardFails, results }, null, 2)); }
for (const r of results)
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status.toUpperCase()).padEnd(6)} ${r.id.padEnd(6)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + r.value : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? ''}`);
console.log(JSON.stringify({ counts, hardFails }));
process.exit(hardFails === 0 ? 0 : 2);
