#!/usr/bin/env node
// Deterministic physics gate runner — the operational definition of the gates in
// references/PHYSICS_GATES.json. Loads a candidate physics module, executes each
// gate's scenario, evaluates pass/fail. No scores.
//
// usage: node harness/physics-runner.mjs --module sandbox/physics-core/A/physics.mjs
//        [--lanes physics-core,turning,jump-arcs] [--out <metrics.json>] [--gates <id,id>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modPath = resolve(ROOT, opt('module'));
const lanes = opt('lanes', 'physics-core,turning,jump-arcs').split(',');
const onlyGates = opt('gates', '') ? opt('gates').split(',') : null;
const outPath = opt('out', null);
const tricksPath = opt('tricks', null);   // trick-system candidate; enables scoring gates
const createTricks = tricksPath
  ? (await import(pathToFileURL(resolve(ROOT, tricksPath)).href)).createTricks
  : null;

const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'));
const { createPhysics } = await import(pathToFileURL(modPath).href);

const DT = 1 / 60;
const DEFERRED_SCENARIOS = createTricks ? new Set() : new Set(['scoring']); // scoring needs --tricks

// ---------- environments ----------
const hf = {
  flat: () => ({ sampleHeight: () => 0 }),
  // downhill along +x: descending plane
  plane: deg => { const k = Math.tan(deg * Math.PI / 180); return { sampleHeight: (x) => -k * x }; },
  // flat approach (x<0), kicker ramp 0..L at kickerDeg, then landing zone flat at
  // lipHeight + landingHeightDelta beyond a 40 m gap trough.
  kicker: (deg, delta = 0) => {
    const L = 6, k = Math.tan(deg * Math.PI / 180), lip = L * k;
    const kApp = Math.tan(15 * Math.PI / 180);      // downhill approach
    return { sampleHeight: (x) =>
      x < 0 ? -x * kApp :
      x <= L ? x * k :
      x <= L + 40 ? lip + delta - 60 :        // trough so flight is unobstructed
      lip + delta };
  },
};
function makeEnv(base, surface = 'snow', seed = 7) {
  const s = base.sampleHeight;
  return {
    sampleHeight: s,
    sampleNormal: (x, z) => {
      const e = 0.05, dx = (s(x + e, z) - s(x - e, z)) / (2 * e), dz = (s(x, z + e) - s(x, z - e)) / (2 * e);
      const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
    },
    surface, seed,
  };
}
const speed = st => Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
const hspeed = st => Math.hypot(st.vel[0], st.vel[2]);
const finite = st => st.pos.every(Number.isFinite) && st.vel.every(Number.isFinite);

function sim(env, opts, { pos = [0, null, 0], vel = [10, 0, 0], heading = 0, duration = 10,
  input = {}, inputFn = null, stopWhen = null, record = null }) {
  const p = createPhysics(env, opts);
  const y0 = pos[1] ?? env.sampleHeight(pos[0], pos[2]);
  const st = p.init([pos[0], y0, pos[2]], vel.slice(), heading);
  const frames = [];
  const n = Math.round(duration / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const inp = inputFn ? inputFn(t, st) : input;
    p.step(st, inp, DT);
    if (record) frames.push(record(st, t));
    if (!finite(st)) return { st, frames, t, diverged: true };
    if (stopWhen && stopWhen(st, t)) return { st, frames, t: t + DT, diverged: false };
  }
  return { st, frames, t: n * DT, diverged: false };
}

// Run on a slope until steady, return avg speed over last `tail` seconds.
function steadySpeed(deg, { opts = {}, input = {}, entry = 10, duration = 20, tail = 2, surface = 'snow' } = {}) {
  const r = sim(makeEnv(hf.plane(deg), surface), opts,
    { vel: [entry, 0, 0], duration, input, record: st => speed(st) });
  const k = Math.round(tail / DT);
  const lastN = r.frames.slice(-k);
  return lastN.reduce((a, b) => a + b, 0) / lastN.length;
}

// Airborne launch over deep flat ground; returns recorded frames.
function airLaunch({ opts = {}, vel = [16, 12, 0], duration = 3, input = {}, inputFn = null }) {
  return sim(makeEnv({ sampleHeight: () => -200 }), opts,
    { pos: [0, 0, 0], vel, duration, input, inputFn,
      record: st => ({ p: st.pos.slice(), v: st.vel.slice(), heading: st.heading, spinDeg: st.spinDeg ?? 0, flipDeg: st.flipDeg ?? 0 }) });
}

// jumpRelease edge-trigger wrapper (single-frame pulse)
function jumpPulse(params) {
  let released = false, pulsed = false;
  const base = params.terrain === 'flat' ? hf.flat() : hf.kicker(params.kickerDeg ?? 30, params.delta ?? 0);
  const env = makeEnv(base);
  const entry = params.entry ?? 15, hold = params.hold ?? 1.2, opts = params.opts ?? {};
  const startX = params.terrain === 'flat' ? 0 : -25;
  let tookOff = null, apexY = -Infinity, takeoffState = null, prevAir = false, lipSpeedBefore = null, lipSpeedAfter = null;
  const r = sim(env, opts, {
    pos: [startX, null, 0], vel: [entry, 0, 0], duration: 15,
    inputFn: (t, st) => {
      const atLip = params.terrain !== 'flat' && st.pos[0] >= 6 - 0.2;
      const ready = params.terrain === 'flat' ? t >= hold : atLip;
      if (params.terrain !== 'flat' && st.pos[0] < 6 - 0.2 && st.onGround) lipSpeedBefore = hspeed(st);
      if (!released && ready) { released = true; }
      if (released && !pulsed) { pulsed = true; return { jumpRelease: true, ...(params.airInput ?? {}) }; }
      if (released) return { ...(params.airInput ?? {}) };
      // kicker approach is a speed servo: boost only BEFORE the ramp and only while
      // below the target entry speed — pins base speed at the entry the bands assume
      const boost = params.terrain !== 'flat' && st.pos[0] < 0 && hspeed(st) < entry;
      const charging = params.terrain === 'flat' ? true
        : (hold >= 1 ? true : (6 - st.pos[0]) / Math.max(hspeed(st), 1) <= hold);
      return { ...(boost ? { boost: true } : {}), ...(charging ? { crouch: true } : {}), ...(params.preInput ?? {}) };
    },
    record: (st, t) => {
      if (!prevAir && !st.onGround) { tookOff = t; takeoffState = { v: st.vel.slice(), p: st.pos.slice() }; apexY = st.pos[1]; lipSpeedAfter = hspeed(st); }
      if (!st.onGround) apexY = Math.max(apexY, st.pos[1]);
      prevAir = !st.onGround;
      return { t, air: !st.onGround, landing: st.landing ?? null, spinDeg: st.spinDeg ?? 0, h: hspeed(st) };
    },
    stopWhen: (st, t) => tookOff != null && st.onGround && t > tookOff + 0.2,
  });
  const airtime = r.frames.filter(f => f.air).length * DT;
  return { airtime, apex: apexY - (takeoffState?.p[1] ?? 0), takeoffState, lipSpeedBefore, lipSpeedAfter,
    landed: r.frames.at(-1)?.landing ?? null, frames: r.frames, diverged: r.diverged };
}

// Fit exponential decay rate lambda of series s (positive, decaying), via log-linear fit.
function fitLambda(series, dt = DT) {
  const pts = series.map((v, i) => [i * dt, Math.log(Math.max(v, 1e-9))]).filter(p => Number.isFinite(p[1]));
  const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
  const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
  return -((n * sxy - sx * sy) / (n * sxx - sx * sx));
}

function turnSim({ speed: v0 = 15, steer = 1, input = {}, opts = {}, duration = 6 }) {
  // gentle slope keeps speed roughly held during the arc
  const r = sim(makeEnv(hf.plane(10)), opts, {
    vel: [v0, 0, 0], duration,
    input: { steer, ...input },
    record: st => ({ p: [st.pos[0], st.pos[2]], heading: st.heading, v: speed(st),
      om: st.yawRate ?? null }),
  });
  return r.frames;
}
function headingDelta(frames) {
  let acc = 0;
  for (let i = 1; i < frames.length; i++) {
    let d = frames[i].heading - frames[i - 1].heading;
    while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    acc += d;
  }
  return Math.abs(acc);
}
function turnRadius(frames) {
  // R = v / omega averaged while heading sweeps 20deg..70deg of accumulated turn
  let acc = 0, samples = [];
  for (let i = 1; i < frames.length; i++) {
    let d = frames[i].heading - frames[i - 1].heading;
    while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    acc += Math.abs(d);
    const om = Math.abs(d) / DT;
    const deg = acc * 180 / Math.PI;
    if (deg > 10 && deg < 45 && om > 1e-4) samples.push(frames[i].v / om);
  }
  return samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : Infinity;
}

// ---------- scenario implementations (metric name -> value) ----------
const impl = {
  tick_independence(p) {
    if (p.mode === 'split_step') {
      const env = makeEnv(hf.flat());
      const mk = () => { const ph = createPhysics(env, {}); return { ph, st: ph.init([0, 0, 0], [17, 0, 0], 0) }; };
      const A = mk(); A.ph.step(A.st, {}, p.stepA_ms / 1000);
      const B = mk(); for (let i = 0; i < p.stepsB; i++) B.ph.step(B.st, {}, p.stepB_ms / 1000);
      const err = Math.hypot(...A.st.vel.map((v, i) => v - B.st.vel[i]));
      return { splitStepVelocityError: err };
    }
    const race = () => {
      const r = sim(makeEnv(hf.plane(p.slopeDeg)), {}, { vel: [8, 0, 0], duration: p.duration,
        stopWhen: st => st.pos[0] >= 150 });
      return r.t;
    };
    const a = race(), b = race();
    return { raceTimeDeltaFrac: Math.abs(a - b) / a };
  },
  slope_accel_pair(p) {
    const acc = deg => {
      const r = sim(makeEnv(hf.plane(deg)), {}, { vel: [p.speed, 0, 0], duration: 1.5, record: st => speed(st) });
      return (r.frames.at(-1) - r.frames[0]) / (r.frames.length * DT);
    };
    return { accelRatio_31deg_over_15deg: acc(p.slopeDegB) / acc(p.slopeDegA) };
  },
  slope_coast(p) {
    if (p.compare) {
      const noTuck = steadySpeed(p.slopeDeg, { duration: p.duration });
      const tuck = steadySpeed(p.slopeDeg, { duration: p.duration, input: { tuck: true } });
      return { tuckSpeedDelta_mps: tuck - noTuck };
    }
    if (p.speedStats) {
      const v = s => steadySpeed(p.slopeDeg, { duration: p.duration, opts: { stats: { speed: s } } });
      const [a, b] = p.speedStats.map(v);
      return { speedGainPer10Stat_frac: (b / a - 1) / ((p.speedStats[1] - p.speedStats[0]) / 10) };
    }
    const vs = (p.entrySpeeds ?? [10]).map(e => steadySpeed(p.slopeDeg, { entry: e, duration: p.duration }));
    const conv = vs.length > 1 ? Math.abs(vs[0] - vs[1]) / vs[0] : 0;
    return { steadyStateSpeed_mps: vs[0], _convergenceFrac: conv,
      _convergenceOk: conv <= (p.convergenceTolFrac ?? 1) };
  },
  flat_coast(p) {
    const r = sim(makeEnv(hf.flat()), {}, { vel: [p.entrySpeed, 0, 0], duration: p.duration,
      record: st => speed(st), stopWhen: st => speed(st) <= p.entrySpeed * 0.1 });
    return { coastTimeTo10pct_s: r.t };
  },
  speed_cap(p) {
    const r = sim(makeEnv(hf.plane(p.slopeDeg)), {}, { vel: [10, 0, 0], duration: p.duration,
      input: { boost: p.boost, tuck: true }, record: st => speed(st) });
    const peak = Math.max(...r.frames);
    const tail = r.frames.slice(-Math.round(5 / DT));
    const plateau = tail.reduce((a, b) => a + b, 0) / tail.length;
    return { maxSpeedExceedsCap: peak > plateau * 1.01 ? 1 : 0, clampedTopSpeed_mps: plateau };
  },
  boost_cycle(p) {
    const run = inputFn => {
      const r = sim(makeEnv(hf.plane(28)), {}, { vel: [15, 0, 0], duration: p.tapDuration,
        inputFn, record: st => speed(st) });
      return r.frames.reduce((a, b) => a + b, 0) / r.frames.length;
    };
    const hold = run(t => ({ boost: t < p.holdDuration }));
    const tap = run(t => ({ boost: (t % (1 / p.tapHz)) < p.tapDuty / p.tapHz }));
    return { tapBoostSpeedRetentionFrac: tap / hold };
  },
  moon_gravity(p) {
    const r = sim(makeEnv(hf.plane(28)), { gravityScale: p.gravityScale },
      { vel: [8, 0, 0], duration: p.duration, record: st => ({ y: st.pos[1], g: st.onGround, s: speed(st) }) });
    const grounded = r.frames.filter(f => f.g);
    const maxDrop = Math.min(...r.frames.map(f => f.y));
    const stable = !r.diverged && grounded.length > r.frames.length * 0.5 && Number.isFinite(maxDrop);
    return { simStableAtSixteenthG: stable ? 1 : 0 };
  },
  air_ballistic(p) {
    if (p.measure === 'fitGravityFromArc') {
      const r = airLaunch({ vel: [16, 12, 0], duration: p.duration });
      const ys = r.frames.map(f => f.p[1]);
      const acc = [];
      for (let i = 1; i < ys.length - 1; i++) acc.push((ys[i + 1] - 2 * ys[i] + ys[i - 1]) / (DT * DT));
      return { airGravity_mps2: -acc.reduce((a, b) => a + b, 0) / acc.length };
    }
    if (p.spinInput) {
      const runs = p.spinInput.map(s => airLaunch({ vel: [16, 12, 0], duration: p.duration, input: { spin: s } }));
      const hv = r => Math.hypot(r.frames.at(-1).v[0], r.frames.at(-1).v[2]);
      return { horizontalDriftFrac: Math.abs(hv(runs[1]) - hv(runs[0])) / hv(runs[0]) };
    }
    if (p.steer != null) {
      const a = airLaunch({ vel: [16, 12, 0], duration: p.duration });
      const b = airLaunch({ vel: [16, 12, 0], duration: p.duration, input: { steer: p.steer } });
      const dv = Math.hypot(...a.frames.at(-1).v.map((v, i) => v - b.frames.at(-1).v[i]));
      return { airborneHeadingCoupledVelChange: dv > 1e-6 ? 1 : 0 };
    }
    if (p.compare && p.compare.includes('animOn')) {
      const a = airLaunch({ vel: [16, 12, 0], duration: p.duration, input: { grab: true } });
      const b = airLaunch({ vel: [16, 12, 0], duration: p.duration });
      const dp = Math.hypot(...a.frames.at(-1).p.map((v, i) => v - b.frames.at(-1).p[i]));
      return { trajectoryDeltaWithAnimation: dp > 1e-6 ? 1 : 0 };
    }
    if (p.compare && p.compare.includes('spin900')) {
      const a = airLaunch({ vel: [16, 12, 0], duration: p.duration, input: { spin: 1 } });
      const b = airLaunch({ vel: [16, 12, 0], duration: p.duration });
      const dp = Math.hypot(...a.frames.at(-1).p.map((v, i) => v - b.frames.at(-1).p[i]));
      return { rotationTrajectoryCoupling: dp > 1e-6 ? 1 : 0 };
    }
    throw new Error('unknown air_ballistic variant');
  },
  slip_decay(p) {
    const a = p.slipAngleDeg * Math.PI / 180;
    const run = (surface) => sim(makeEnv(hf.plane(5), surface), {}, {
      vel: [15 * Math.cos(a), 0, 15 * Math.sin(a)], heading: 0, duration: 3,
      input: p.steer ? { steer: p.steer } : {},
      record: st => ({ lat: Math.abs(st.vel[2] * Math.cos(st.heading) - st.vel[0] * Math.sin(st.heading)), s: speed(st) }),
    });
    const r = run(p.surface ?? 'snow');
    if (p.measureAt_s != null) {
      const i = Math.round(p.measureAt_s / DT);
      return { speedScrubbedFrac_0p5s: 1 - r.frames[i].s / r.frames[0].s };
    }
    const lat = r.frames.map(f => f.lat);
    const half = lat[0] / 2;
    const iHalf = lat.findIndex(v => v <= half);
    if (p.steer) return { steeredSlipHalfLife_s: iHalf >= 0 ? iHalf * DT : Infinity };
    const lambdaLat = fitLambda(lat.slice(0, Math.max(iHalf * 2, 20)));
    if (p.alsoFit === 'lambda_long_from_flat_coast') {
      const fc = sim(makeEnv(hf.flat()), {}, { vel: [17, 0, 0], duration: 8, record: st => speed(st) });
      // fit early segment where the exponential term dominates
      // fit on early segment where v is large and exp term dominates
      const lambdaLong = fitLambda(fc.frames.slice(0, Math.round(3 / DT)));
      return { dampingRatio_latOverLong: lambdaLat / Math.max(lambdaLong, 1e-6) };
    }
    return { slipHalfLife_s: iHalf >= 0 ? iHalf * DT : Infinity };
  },
  turn_radius(p) {
    if (p.measure === 'timeTo90') {
      const fr = turnSim({ speed: p.speed, steer: p.steer });
      let acc = 0, t = Infinity;
      for (let i = 1; i < fr.length; i++) {
        let d = fr[i].heading - fr[i - 1].heading;
        while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
        acc += Math.abs(d);
        if (acc >= Math.PI / 2) { t = i * DT; break; }
      }
      return { timeTo90Deg_s: t };
    }
    if (p.measure === 'peakLateralAccel') {
      let peak = 0;
      for (const v0 of p.speedSweep) {
        const fr = turnSim({ speed: v0, steer: p.steer, duration: 3 });
        for (let i = 1; i < fr.length; i++) {
          let d = fr[i].heading - fr[i - 1].heading;
          while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
          peak = Math.max(peak, fr[i].v * Math.abs(d) / DT);
        }
      }
      return { maxLateralAccel_mps2: peak };
    }
    if (p.compare && p.compare.includes('partialRatio')) {
      const rp = turnRadius(turnSim({ speed: p.speed, steer: p.steer }));
      const rf = turnRadius(turnSim({ speed: p.speed, steer: 1.0 }));
      return { partialOverFullRadiusRatio: rp / rf };
    }
    if (p.compare && p.compare.includes('brake')) {
      const rb = turnRadius(turnSim({ speed: p.speed, steer: p.steer, input: { brake: true } }));
      const rn = turnRadius(turnSim({ speed: p.speed, steer: p.steer }));
      return { brakeTurnRadiusSmaller: rb < rn ? 1 : 0 };
    }
    if (p.compare && p.compare.includes('crouch')) {
      const yaw = fr => headingDelta(fr.slice(0, Math.round(1.5 / DT)));
      const c = yaw(turnSim({ speed: p.speed, steer: p.steer, input: { crouch: true } }));
      const n = yaw(turnSim({ speed: p.speed, steer: p.steer }));
      return { crouchSteerMultiplier: c / n };
    }
    return { turnRadius_m: turnRadius(turnSim({ speed: p.speed, steer: p.steer })) };
  },
  full_lock_drag(p) {
    // friction-multiplier isolation: after each step velocity is re-aligned to heading
    // (magnitude kept), so carve scrub is excluded and only longitudinal drag differs
    const decel = steer => {
      const env = makeEnv(hf.flat());
      const ph = createPhysics(env, {});
      const st = ph.init([0, 0, 0], [p.speed, 0, 0], 0);
      const v0 = speed(st); let vPrev = v0; const n = Math.round(2 / DT);
      for (let i = 0; i < n; i++) {
        ph.step(st, { steer }, DT);
        const sp = Math.hypot(st.vel[0], st.vel[2]);
        st.vel[0] = sp * Math.cos(st.heading); st.vel[2] = sp * Math.sin(st.heading);
        vPrev = sp;
      }
      return (v0 - vPrev) / (n * DT);
    };
    return { fullLockExtraDragFrac: decel(1) / decel(0) - 1 };
  },
  brake(p) {
    const r = sim(makeEnv(hf.plane(p.slopeDeg), p.surface), {}, { vel: [p.entrySpeed, 0, 0],
      duration: 6, input: { brake: true }, record: st => speed(st),
      stopWhen: st => speed(st) <= 8 });
    const d = (p.entrySpeed - 8) / r.t;
    return { brakeDecel_mps2: d };
  },
  surface_compare(p) {
    if (p.surfaces.includes('ice')) {
      const lam = surface => {
        const a = 30 * Math.PI / 180;
        const r = sim(makeEnv(hf.plane(p.slopeDeg), surface), {}, {
          vel: [p.speed * Math.cos(a), 0, p.speed * Math.sin(a)], duration: 2,
          record: st => Math.abs(st.vel[2] * Math.cos(st.heading) - st.vel[0] * Math.sin(st.heading)) });
        return fitLambda(r.frames.slice(0, Math.round(0.8 / DT)));
      };
      return { iceOverSnowGripRatio: lam('ice') / lam('snow') };
    }
    const decel = (surface, v) => {
      const r = sim(makeEnv(hf.flat(), surface), {}, { vel: [v, 0, 0], duration: 1.5, record: st => speed(st) });
      return (r.frames[0] - r.frames.at(-1)) / (r.frames.length * DT);
    };
    return { powderExtraDragLowSpeed_mps2: decel('powder', p.speeds[0]) - decel('snow', p.speeds[0]),
      _highSpeedExtra: decel('powder', p.speeds[1]) - decel('snow', p.speeds[1]) };
  },
  jump_flat(p) {
    if (p.holdSweep_s) {
      const airs = p.holdSweep_s.map(h => jumpPulse({ terrain: 'flat', entry: p.entrySpeed, hold: h }).airtime);
      const max = Math.max(...airs);
      let clamp = Infinity;
      for (let i = 0; i < airs.length; i++) if (airs[i] >= max * 0.99) { clamp = p.holdSweep_s[i]; break; }
      return { chargeClampTime_s: clamp };
    }
    const hold = p.charge === 'tap' ? 0.15 : 1.4;
    const j = jumpPulse({ terrain: 'flat', entry: p.entrySpeed, hold });
    const out = { airtime_s: j.airtime, _apex_m: j.apex };
    if (p.alsoAssert?.apexHeight_m) out._apexInBand =
      j.apex >= p.alsoAssert.apexHeight_m.min && j.apex <= p.alsoAssert.apexHeight_m.max;
    return out;
  },
  jump_kicker(p) {
    const hold = p.charge === 'tap' ? 0.15 : 1.4;
    const j = jumpPulse({ terrain: 'kicker', kickerDeg: p.kickerDeg, delta: p.landingHeightDelta ?? 0,
      entry: p.entrySpeed, hold });
    if (p.measure === 'horizontalSpeedAcrossLip') {
      // isolate the impulse discontinuity: delta-h at the takeoff frame minus the
      // median per-frame delta-h over the preceding grounded ramp frames (legitimate
      // slope decel must not count against the jump impulse)
      const f = j.frames;
      const iTake = f.findIndex(x => x.air);
      if (iTake < 2) return { takeoffHorizontalSpeedChangeFrac: 1 };
      const dTake = f[iTake].h - f[iTake - 1].h;
      const ramp = [];
      for (let i = Math.max(1, iTake - 8); i < iTake; i++) ramp.push(f[i].h - f[i - 1].h);
      ramp.sort((a, b) => a - b);
      const med = ramp[Math.floor(ramp.length / 2)] ?? 0;
      return { takeoffHorizontalSpeedChangeFrac: Math.abs(dTake - med) / f[iTake - 1].h };
    }
    const out = { airtime_s: j.airtime, _apex_m: j.apex };
    if (p.alsoAssert?.apexHeight_m) out._apexInBand =
      j.apex >= p.alsoAssert.apexHeight_m.min && j.apex <= p.alsoAssert.apexHeight_m.max;
    return out;
  },
  spin_rate(p) {
    const maxRate = frames => {
      let peak = 0;
      for (let i = 1; i < frames.length; i++)
        peak = Math.max(peak, Math.abs((frames[i].spinDeg ?? 0) - (frames[i - 1].spinDeg ?? 0)) / DT,
                              Math.abs((frames[i].flipDeg ?? 0) - (frames[i - 1].flipDeg ?? 0)) / DT);
      return peak;
    };
    if (p.assert === 'capAndUnknownLabel') {
      const key = p.commandSpin_deg ? 'spin' : 'flip';
      const r = airLaunch({ vel: [10, 24, 0], duration: 9, input: { [key]: 1 }, opts: { stats: { trick: 40 } } });
      const tot = Math.max(...r.frames.map(f => Math.abs(key === 'spin' ? f.spinDeg : f.flipDeg)));
      return { [key === 'spin' ? 'spinCap_deg' : 'flipCap_deg']: Math.round(tot / 10) * 10 };
    }
    if (p.prewind === 'full') {
      const j = jumpPulse({ terrain: 'flat', entry: 15, hold: 1.4, preInput: { spin: 1 },
        airInput: { spin: 1 }, opts: { stats: { trick: 40 } } });
      const rate = j.frames.length > 2 ? Math.max(...j.frames.slice(1).map((f, i) =>
        Math.abs((f.spinDeg ?? 0) - (j.frames[i].spinDeg ?? 0)) / DT)) : 0;
      return { prewoundSpinRate_degps: rate };
    }
    if (p.prewind === 'none') {
      const r20 = airLaunch({ vel: [10, 14, 0], duration: 2.5, input: { spin: 1 } });
      const r40 = airLaunch({ vel: [10, 14, 0], duration: 2.5, input: { spin: 1 }, opts: { stats: { trick: 40 } } });
      return { stickSpinRate_degps: Math.max(maxRate(r20.frames), maxRate(r40.frames)) };
    }
    if (p.commandFlip_deg && p.simultaneousSpin_deg) {
      const r = airLaunch({ vel: [10, 16, 0], duration: 4, input: { flip: 1, spin: 1 } });
      let peak = 0;
      for (let i = 1; i < r.frames.length; i++)
        peak = Math.max(peak, Math.abs((r.frames[i].flipDeg ?? 0) - (r.frames[i - 1].flipDeg ?? 0)) / DT);
      return { flipRate_degps: peak };
    }
    if (p.measure === 'levelingResponse') {
      const r = airLaunch({ vel: [10, 18, 0], duration: 5,
        inputFn: t => t < 1.5 ? { flip: 1 } : {} });
      let peak = 0;
      const i0 = Math.round(1.5 / DT) + 1;
      for (let i = i0 + 1; i < r.frames.length; i++)
        peak = Math.max(peak, Math.abs((r.frames[i].flipDeg ?? 0) - (r.frames[i - 1].flipDeg ?? 0)) / DT);
      return { autoLevelRate_degps: peak };
    }
    throw new Error('unknown spin_rate variant');
  },
  constrained(p) {
    const env = makeEnv(hf.flat());
    const mk = () => { const ph = createPhysics(env, {}); const st = ph.init([0, 0, 0], [16, 0, 0], 0);
      st.constrained = true; return { ph, st }; };
    if (p.mode === 'charge') {
      const { ph, st } = mk();
      for (let i = 0; i < 60; i++) ph.step(st, { crouch: true }, DT);   // 1.0 s
      return { constrainedChargeAt1s: +st.charge.toFixed(4) };
    }
    if (p.mode === 'pop') {
      const { ph, st } = mk();
      for (let i = 0; i < 90; i++) ph.step(st, { crouch: true, spin: 1 }, DT);  // full charge + prewind
      const vy0 = st.vel[1];
      ph.step(st, { jumpRelease: true }, DT);
      return { constrainedPop_mps: +(st.vel[1] - vy0).toFixed(3),
        _leftConstrained: st.constrained === false, _airborne: st.onGround === false,
        _airTime: +st.airTime.toFixed(3), _spinReset: (st.spinDeg ?? 0) === 0,
        _prewound: st.prewound };
    }
    if (p.mode === 'hold') {
      // NO GRAVITY, not NO MOTION: a level constraint (vy = 0) must neither sink
      // nor gain vertical speed, and the air clock stays 0. Horizontal motion is
      // expected and is PC-17's business.
      const { ph, st } = mk();
      st.vel[1] = 0;
      const y0 = st.pos[1];
      for (let i = 0; i < 300; i++) ph.step(st, {}, DT);                // 5 s held
      const noFall = Math.abs(st.pos[1] - y0) < 1e-9 && Math.abs(st.vel[1]) < 1e-9 && st.airTime === 0;
      return { constrainedNoFall: noFall ? 1 : 0, _dy: +(st.pos[1] - y0).toFixed(9),
        _vy: +st.vel[1].toFixed(9), _airTime: st.airTime };
    }
    if (p.mode === 'advance') {
      const { ph, st } = mk();
      st.vel = [18, 0, 0];
      const p0 = [st.pos[0], st.pos[2]];
      for (let i = 0; i < 60; i++) ph.step(st, {}, DT);                 // 1 s
      return { constrainedAdvance_m: +Math.hypot(st.pos[0] - p0[0], st.pos[2] - p0[1]).toFixed(3) };
    }
    if (p.mode === 'yaw') {
      // the constraint redirects velocity (a bend); the board must follow it
      const { ph, st } = mk();
      st.vel = [18, 0, 0]; st.heading = 0;
      for (let i = 0; i < 30; i++) ph.step(st, {}, DT);
      st.vel = [0, 0, 18];                                              // 90 deg bend
      for (let i = 0; i < 30; i++) ph.step(st, {}, DT);                 // 0.5 s to align
      const velYaw = Math.atan2(st.vel[2], st.vel[0]);
      let d = st.heading - velYaw;
      while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      // Residual to the NEAREST of forward/switch: riding a rail fakie is a legal
      // outcome of a 180 rail spin, and it is not "crabbed" — crabbed means the
      // board points across the direction of travel, which is 90 deg, not 180.
      const res = Math.min(Math.abs(d), Math.PI - Math.abs(d));
      return { railYawResidual_deg: +(res * 180 / Math.PI).toFixed(2), _signed_deg: +(d * 180 / Math.PI).toFixed(2) };
    }
    if (p.mode === 'railspin') {
      // Rail spin ACCRUES during the grind and RESETS on exit (reference: in
      // Tricky a rail spin does not follow you into the air; open-air rotation
      // needs a fresh input or a new prewind).
      const { ph, st } = mk();
      st.vel = [18, 0, 0]; st.heading = 0;
      for (let i = 0; i < 90; i++) ph.step(st, { spin: 1 }, DT);        // 1.5 s of stick
      const onRail = Math.abs(st.spinDeg ?? 0);
      const headingMoved = Math.abs(st.heading) * 180 / Math.PI;
      ph.step(st, { jumpRelease: true }, DT);
      const afterExit = Math.abs(st.spinDeg ?? 0);
      const velYaw = Math.atan2(st.vel[2], st.vel[0]);
      let hd = st.heading - velYaw;
      while (hd > Math.PI) hd -= 2 * Math.PI; while (hd < -Math.PI) hd += 2 * Math.PI;
      return { railSpinDeg: +onRail.toFixed(1), railSpinResetOnExit: afterExit < 1e-9 ? 1 : 0,
        railExitCrab_deg: +Math.abs(hd * 180 / Math.PI).toFixed(2),
        _headingMoved_deg: +headingMoved.toFixed(1) };
    }
    throw new Error('unknown constrained mode');
  },
  drag_shape(p) {
    // decel-vs-speed on flat must fit a = mu*g + lambda*v (two-term spec model)
    const r = sim(makeEnv(hf.flat()), {}, { vel: [p.entrySpeed, 0, 0], duration: p.duration,
      record: st => speed(st), stopWhen: st => speed(st) < 2 });
    const v = r.frames, pts = [];
    for (let i = 5; i < v.length - 5; i++) {
      const a = (v[i - 3] - v[i + 3]) / (6 * DT);           // centered decel
      if (v[i] > 2.5 && a > 0) pts.push([v[i], a]);
    }
    const n = pts.length, sx = pts.reduce((q, u) => q + u[0], 0), sy = pts.reduce((q, u) => q + u[1], 0);
    const sxx = pts.reduce((q, u) => q + u[0] * u[0], 0), sxy = pts.reduce((q, u) => q + u[0] * u[1], 0);
    const lam = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const c0 = (sy - lam * sx) / n;
    const meanA = sy / n;
    const resid = Math.max(...pts.map(u => Math.abs(u[1] - (c0 + lam * u[0])))) / meanA;
    return { fittedMu: c0 / 9.81, fittedLambdaLong: lam, dragShapeResidualFrac: resid };
  },
  uphill_decel(p) {
    // moving uphill (-x on a +x-descending plane): decel >= g*sin(theta)
    const r = sim(makeEnv(hf.plane(p.slopeDeg)), {}, { vel: [-p.entrySpeed, 0, 0],
      heading: Math.PI, duration: 1.2, record: st => speed(st) });
    const k = Math.round(1.0 / DT);
    return { uphillDecel_mps2: (r.frames[0] - r.frames[k]) / (k * DT) };
  },
  coyote_pop(p) {
    if (p.behavior) {
      const run = releaseAt => {
        const env = makeEnv({ sampleHeight: () => -200 });
        const ph = createPhysics(env, {});
        const st = ph.init([0, 0, 0], [16, 4, 0], 0);
        const n = Math.round(1.2 / DT), rel = Math.round(releaseAt / DT);
        let vyBefore = 0, vyAfter = 0, spinAtRel = 0;
        for (let i = 0; i < n; i++) {
          if (i === rel) { vyBefore = st.vel[1]; st.spinDeg = 200; spinAtRel = 200; }
          ph.step(st, i === rel ? { jumpRelease: true } : { spin: i < rel ? 1 : 0 }, DT);
          if (i === rel) vyAfter = st.vel[1];
        }
        return { popped: vyAfter > vyBefore + 0.5, spinReset: Math.abs(st.spinDeg) < spinAtRel };
      };
      const early = run(0.15), late = run(0.6);
      return { coyotePopBehavior: (early.popped && early.spinReset && !late.popped) ? 1 : 0 };
    }
    const run = withPop => {
      const env = makeEnv({ sampleHeight: () => -200 });
      const ph = createPhysics(env, {});
      const st = ph.init([0, 0, 0], [16, 10, 0], 0);
      const n = Math.round(1.5 / DT), rel = Math.round(p.releaseAt_s / DT);
      for (let i = 0; i < n; i++) ph.step(st, i === rel && withPop ? { jumpRelease: true } : {}, DT);
      return Math.hypot(st.vel[0], st.vel[2]);
    };
    return { coyotePopHorizontalChange: Math.abs(run(true) - run(false)) > 1e-9 ? 1 : 0 };
  },
  // ---- trick-system machinery (runner = operational law; drives BOTH modules) ----
  // One flat-ground jump with scripted air inputs; tricks.step runs after physics.step
  // every frame; on touchdown, landingOverride (if any) replaces the physics verdict.
  _trickJump(tr, ts, { hold = 1.2, airFn = null, entry = 15 } = {}) {
    const env = makeEnv(hf.flat());
    const ph = createPhysics(env, {});
    const st = ph.init([0, 0, 0], [entry, 0, 0], 0);
    let released = false, pulsed = false, prevAir = false, tookOff = 0;
    for (let t = 0; t < 12; t += DT) {
      let inp = {};
      if (!released && t >= hold) released = true;
      if (released && !pulsed) { pulsed = true; inp = { jumpRelease: true }; }
      else if (!released) inp = { crouch: true };
      else if (!st.onGround && airFn) inp = airFn(t - tookOff, st) ?? {};
      ph.step(st, inp, DT);
      if (!prevAir && !st.onGround) tookOff = t;
      tr.step(ts, st, inp, DT);
      if (st.onGround && st.landing) {
        const ov = tr.landingOverride(ts, st);
        if (ov) st.landing = ov;
        tr.step(ts, st, {}, DT);           // let the system settle the landing
        break;
      }
      prevAir = !st.onGround;
    }
    return { st, ts };
  },
  scoring(p) {
    const tr = createTricks({});
    const ts = tr.init();
    const S = impl._trickJump.bind(null, tr, ts);
    if (p.mode === 'uberTable') {
      const vals = Object.values(tr.config.uberTable ?? {});
      const ok = vals.length >= 12 && Math.min(...vals) === p.min && Math.max(...vals) === p.max &&
        vals.every(v => v >= p.min && v <= p.max);
      return { uberScoreTableMatches: ok ? 1 : 0 };
    }
    if (p.mode === 'repeatTrick') {
      const award = () => {
        const before = ts.score;
        S({ hold: 1.4, airFn: (ta, st) => ta < 0.7 ? { spin: 1 } : {} });
        return ts.score - before;
      };
      const a1 = award(), a2 = award(), a3 = award();
      const f2 = a2 / a1, f3 = a3 / a1;
      return { repeatPenaltyFactor: +f2.toFixed(3), _thirdOk: Math.abs(f3 - 0.25) < 0.02, _a1Positive: a1 > 0 };
    }
    if (p.mode === 'stars') {
      tr.collectStar(2); tr.collectStar(3);
      const before = ts.score;
      S({ hold: 1.4, airFn: (ta) => ta < 0.7 ? { spin: 1 } : {} });
      const cleanAward = ts.score - before;
      // baseline same trick without stars, fresh system
      const tr2 = createTricks({}); const ts2 = tr2.init();
      impl._trickJump(tr2, ts2, { hold: 1.4, airFn: (ta) => ta < 0.7 ? { spin: 1 } : {} });
      const base = ts2.score;
      const highestOnly = Math.abs(cleanAward - base * 3) < base * 0.05;
      // crash voids: grab held through landing
      const tr3 = createTricks({}); const ts3 = tr3.init();
      tr3.collectStar(5);
      impl._trickJump(tr3, ts3, { hold: 1.4, airFn: () => ({ spin: 1, grab: true }) });
      const voided = ts3.score <= base * 0.2;   // crash awards ~nothing
      return { starMultipliersCorrect: (highestOnly && voided) ? 1 : 0, _clean: cleanAward, _base: base };
    }
    if (p.mode === 'meterFill') {
      // reference: ~3 FRESH mid-tier tricks fill empty->full. Measure the fill of
      // the FIRST (fresh) mid-tier trick; repeats halving is JA-17's business.
      ts.meter = 0;
      S({ hold: 1.4, airFn: (ta) => ta < 0.8 ? { flip: 1 } : {} });
      const perTrick = ts.meter;
      return { midTierTricksToFill: perTrick > 0 ? +(1 / perTrick).toFixed(2) : 99 };
    }
    if (p.mode === 'tricky') {
      // reference: each individually landed uber lights a letter — repeats count.
      // Landing the SAME uber six times must earn TRICKY.
      for (let k = 0; k < 6; k++)
        S({ hold: 1.4, airFn: (ta) => ta < 1.0 ? { uber: 1 } : {} });
      if (!ts.tricky) return { trickyStateCorrect: 0 };
      // meter must never drain again: 30 s idle coast
      const env = makeEnv(hf.plane(10));
      const ph = createPhysics(env, {});
      const st = ph.init([0, null, 0], [10, 0, 0], 0);
      let minM = ts.meter;
      for (let t = 0; t < 30; t += DT) { ph.step(st, {}, DT); tr.step(ts, st, {}, DT); minM = Math.min(minM, ts.meter); }
      return { trickyStateCorrect: minM >= 0.999 ? 1 : 0 };
    }
    if (p.mode === 'knockdown') {
      ts.meter = 0.2;
      tr.knockdown();
      return { knockdownFillsMeter: ts.meter >= 0.999 ? 1 : 0 };
    }
    throw new Error('unknown scoring mode');
  },
  landing_state(p) {
    if (p.uberIncomplete) {
      if (!createTricks) return null; // trick-system lane
      const tr = createTricks({});
      const ts = tr.init();
      // short-air jump; start an uber immediately — cannot complete before touchdown
      const { st } = impl._trickJump(tr, ts, { hold: 0.15, airFn: () => ({ uber: 1 }) });
      return { uberUnfinishedLandingCrashes: st.landing === 'crash' ? 1 : 0 };
    }
    // jump off flat with grab held through touchdown -> must crash
    const j = jumpPulse({ terrain: 'flat', entry: 15, hold: 1.0, airInput: { grab: true } });
    return { grabHeldLandingCrashes: j.landed === 'crash' ? 1 : 0 };
  },
  landing_yaw(p) {
    const outcome = residual => {
      const env = makeEnv(hf.flat());
      const ph = createPhysics(env, {});
      const st = ph.init([0, 0.06, 0], [12, -4, 0], 0); // 1 frame to touchdown: <=1 frame of auto-level assist
      st.spinDeg = residual; // residual un-completed rotation at touchdown
      st.heading = residual * Math.PI / 180;
      for (let t = 0; t < 4; t += DT) { ph.step(st, {}, DT); if (st.onGround && st.landing) break; }
      return st.landing;
    };
    let clean = 0, crash = Infinity;
    // finer sweep near both thresholds: gate sweep alone (…,90,120,…) cannot
    // resolve the 80-100 crash band to better than 30 deg
    const sweep = [...new Set([...p.residualYawSweep_deg, 40, 45, 50, 55, 80, 85, 90, 95, 100, 105, 110])].sort((a, b) => a - b);
    for (const d of sweep) {
      const o = outcome(d);
      if (o === 'clean') clean = Math.max(clean, d);
      if (o === 'crash') crash = Math.min(crash, d);
    }
    const out = { cleanYawThreshold_deg: clean, _crashThreshold_deg: crash };
    if (p.alsoAssert?.crashYawThreshold_deg) out._crashInBand =
      crash >= p.alsoAssert.crashYawThreshold_deg.min && crash <= p.alsoAssert.crashYawThreshold_deg.max;
    return out;
  },
};

// ---------- gate evaluation ----------
const results = [];
for (const g of GATES.gates) {
  if (g.tag === 'RETIRED') continue;   // kept in the file for the record, not graded
  if (!lanes.includes(g.lane)) continue;
  if (onlyGates && !onlyGates.includes(g.id)) continue;
  const sc = g.scenario?.scenario, params = g.scenario?.params ?? {};
  if (DEFERRED_SCENARIOS.has(sc)) { results.push({ id: g.id, tag: g.tag, status: 'deferred' }); continue; }
  if (!impl[sc]) { results.push({ id: g.id, tag: g.tag, status: 'no-impl', scenario: sc }); continue; }
  let row;
  try {
    const m = impl[sc](params);
    if (m === null) { results.push({ id: g.id, tag: g.tag, status: 'deferred' }); continue; }
    const val = m[g.metric];
    let pass;
    if (g.op === 'in_range') pass = val >= g.min && val <= g.max;
    else if (g.op === 'lte') pass = val <= g.value;
    else if (g.op === 'gte') pass = val >= g.value;
    else if (g.op === 'eq') pass = Math.abs(val - g.value) < 1e-9;
    const side = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('_')));
    const sideOk = Object.entries(side).every(([k, v]) => k.endsWith('InBand') || k.endsWith('Ok') ? v !== false : true);
    row = { id: g.id, tag: g.tag, status: (pass && sideOk) ? 'pass' : 'fail',
      metric: g.metric, value: typeof val === 'number' ? +val.toPrecision(5) : val,
      expect: g.op === 'in_range' ? `[${g.min}, ${g.max}]` : `${g.op} ${g.value}`, ...side };
  } catch (err) {
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err.message).slice(0, 200) };
  }
  results.push(row);
}

const counts = { pass: 0, fail: 0, error: 0, deferred: 0, 'no-impl': 0 };
let hardFails = 0;
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if (r.status !== 'pass' && r.status !== 'deferred' && r.tag === 'HARD') hardFails++;
}
const report = { module: modPath, lanes, counts, hardFails, results };
if (outPath) { mkdirSync(dirname(resolve(ROOT, outPath)), { recursive: true }); writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2)); }
for (const r of results)
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status === 'deferred' ? 'DEFER' : r.status.toUpperCase()).padEnd(7)} ${r.id.padEnd(7)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + r.value : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? ''}`);
console.log(JSON.stringify({ counts, hardFails }));
process.exit(hardFails === 0 ? 0 : 2);
