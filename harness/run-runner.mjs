#!/usr/bin/env node
// Run-structure gate runner — operational definition of the RS gates.
// Drives the accepted physics + trick systems against a candidate run module,
// in plain node (no browser): the run system is pure logic.
//
// usage: node harness/run-runner.mjs --module sandbox/run-structure/A/run.mjs [--out <json>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modPath = resolve(ROOT, opt('module'));
const outPath = opt('out', null);

const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'run-structure');

const { createRun } = await import(pathToFileURL(modPath).href);
const { createPhysics } = await import(pathToFileURL(resolve(ROOT, 'src/physics/physics.mjs')).href);
const { createTricks } = await import(pathToFileURL(resolve(ROOT, 'src/tricks/tricks.mjs')).href);
// the real terrain: same analytic sampler the renderer and rig use
const render = await import(pathToFileURL(resolve(ROOT, 'src/render/main.mjs')).href);
const { sampleHeight } = render;

const DT = 1 / 60;

// Course centreline, measured from the analytic terrain (lowest point across the
// corridor at each z) — the same definition the rig and the render lane use.
function courseCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
// The first version bucketed z to 25 m and returned the raw argmin, which STEPS
// 40.0 m at z=762 (verified) because the gully has two near-equal minima and the
// argmin flips between them. Candidates state their whole corridor geometry in
// this coordinate, so a staircase there fires walls at in-bounds riders. Now:
// sample every 10 m, smooth the flip out, and linearly interpolate.
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => {
  const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = courseCenterX(CL_Z0 + i * CL_STEP);
  const sm = new Array(n);                       // +/-3 sample (30 m) box smooth
  for (let i = 0; i < n; i++) {
    let acc = 0, c = 0;
    for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { acc += raw[j]; c++; } }
    sm[i] = acc / c;
  }
  return sm;
})();
const centerX = z => {
  const f = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP;
  const i = Math.min(CL.length - 2, Math.max(0, Math.floor(f)));
  const t = f - i;
  return CL[i] * (1 - t) + CL[i + 1] * t;
};

// LOD cell size the RENDERER actually uses at a given distance-from-camera is not
// knowable here, so confinement is judged against the WORST case the player can
// reach: inner corridor tiles are 250 m; outside them the backdrop is 1000 m/seg 12.
// Divergence = |analytic height - bilinear interpolation across that cell|.
const INNER = { x0: -1000, x1: 1000, z0: -250, z1: 2750 };
function divergenceAt(x, z) {
  const inInner = x >= INNER.x0 && x <= INNER.x1 && z >= INNER.z0 && z <= INNER.z1;
  const cell = inInner ? 250 / 16 : 1000 / 12;      // worst LOD the player can be near
  const gx = Math.floor(x / cell) * cell, gz = Math.floor(z / cell) * cell;
  const fx = (x - gx) / cell, fz = (z - gz) / cell;
  const h = (a, b) => sampleHeight(gx + a * cell, gz + b * cell);
  const bi = (h(0, 0) * (1 - fx) + h(1, 0) * fx) * (1 - fz) + (h(0, 1) * (1 - fx) + h(1, 1) * fx) * fz;
  return Math.abs(sampleHeight(x, z) - bi);
}

const env = () => ({ sampleHeight, courseCenterX: centerX,
  bounds: { zStart: 0, zFinish: 2400, halfWidth: 120,
    // A start GATE is not a wall. Drifting back over the line mid-run (a
    // backwards jump, a bad landing) is normal play, so the UP-COURSE correction
    // line is its own boundary, well behind the gate. Pinning it to zStart made
    // the corridor correct ordinary play and thereby change the run it timed.
    zBackstop: -80 } });

// One driven session: physics + tricks + run module stepped together.
function session({ duration = 120, inputFn = null, seedZ = null } = {}) {
  const e = { sampleHeight, sampleNormal: (x, z) => {
    const d = 0.05;
    const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
    const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
    const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
  }, surface: 'snow' };
  const ph = createPhysics(e, {});
  const tr = createTricks({});
  const run = createRun(env());
  const ts = tr.init();
  const rs = run.init();
  const z0 = seedZ ?? 15, x0 = centerX(z0);
  const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 6], Math.PI / 2);
  const trace = [];
  let prev = [...st.pos];
  let maxJump = 0, maxDiv = 0;
  const n = Math.round(duration / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const inp = inputFn ? (inputFn(t, st, rs) ?? {}) : { tuck: true };
    ph.step(st, inp, DT);
    tr.step(ts, st, inp, DT);
    run.step(rs, st, ts, DT);
    const jump = Math.hypot(st.pos[0] - prev[0], st.pos[1] - prev[1], st.pos[2] - prev[2]);
    // a legitimate fast frame is ~0.6 m at 35 m/s; only count corrections
    if (rs.outOfBounds && jump > maxJump) maxJump = jump;
    maxDiv = Math.max(maxDiv, divergenceAt(st.pos[0], st.pos[2]));
    prev = [...st.pos];
    trace.push({ t, z: st.pos[2], phase: rs.phase, time_s: rs.time_s, score: ts.score });
    if (rs.phase === 'finished' && i > n * 0.02 && !inputFn) break;
  }
  return { st, ts, rs, run, tr, trace, maxJump, maxDiv };
}

// The probe drive is a COMPETENT player, not a sine wave. The open-loop version
// took 298.1 s to finish the course while bare physics under a closed-loop seeker
// finishes in 108.4 s — so RS-08 was measuring the drive, and a candidate answered
// by building a steering autopilot into the run module to compensate. It also now
// jumps, grabs, spins and fires ubers, so RS-03/RS-04 stop comparing 0 to 0.
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function seekSteer(st, tx, tz, gain = 1.8) {
  const want = Math.atan2(tz - st.pos[2], tx - st.pos[0]);
  return Math.max(-1, Math.min(1, wrapA(want - st.heading) * gain));
}
const play = (t, st) => {
  const tz = st.pos[2] + 120, tx = centerX(tz);
  const inp = { tuck: true, boost: t > 3, steer: seekSteer(st, tx, tz) };
  // trick cadence tuned to a COMPETENT player: mostly tucked, a short charge and
  // pop every 14 s (a long crouch kills tuck and costs the run ~90 s of pace).
  const cyc = t % 14;
  if (st.onGround) {
    if (cyc > 13.4 && cyc < 13.8) { inp.crouch = true; inp.tuck = false; }
    if (cyc >= 13.8 && cyc < 13.82) { inp.jumpRelease = true; inp.tuck = false; }
  } else {
    const n = Math.floor(t / 14);
    if (n % 4 === 3) inp.uber = 1 + (n % 6);
    else { inp.spin = 1; if (st.airTime > 0.25 && st.airTime < 0.6) inp.grab = true; }
    inp.tuck = false;
  }
  return inp;
};

const impl = {
  timer() {
    const s = session({ duration: 300, inputFn: play });
    const before = s.trace.filter(f => f.phase === 'ready');
    const during = s.trace.filter(f => f.phase === 'running');
    const after = s.trace.filter(f => f.phase === 'finished');
    const zeroBefore = before.every(f => f.time_s === 0);
    const monotonic = during.every((f, i) => i === 0 || f.time_s >= during[i - 1].time_s);
    const frozen = after.length < 2 || after.every(f => Math.abs(f.time_s - after[0].time_s) < 1e-9);
    return { timerPhaseCorrect: (zeroBefore && monotonic && frozen && during.length > 0) ? 1 : 0,
      _phases: { ready: before.length, running: during.length, finished: after.length } };
  },
  finish() {
    const s = session({ duration: 300, inputFn: play });
    const idx = s.trace.findIndex(f => f.phase === 'finished');
    if (idx < 1) return { finishDetect: 0, _why: 'never finished' };
    const zAt = s.trace[idx].z, zPrev = s.trace[idx - 1].z;
    const zF = s.run.config.zFinish;
    // crossed within one step, and the phase latches (never returns to running)
    const oneStep = zPrev < zF && zAt >= zF;
    const latched = s.trace.slice(idx).every(f => f.phase === 'finished');
    // A mutant that reverts to 'running' once the rider is well past the line
    // escaped this gate because the drive stopped near the line. Push on: the
    // phase must stay latched deep into the run-out.
    const reachedPast = Math.max(...s.trace.map(f => f.z)) >= zF + 60;
    return { finishDetect: (oneStep && latched && reachedPast) ? 1 : 0,
      _zPrev: Math.round(zPrev), _zAt: Math.round(zAt), _zFinish: zF,
      _maxZ: Math.round(Math.max(...s.trace.map(f => f.z))), _latched: latched, _reachedPast: reachedPast };
  },
  freeze() {
    const s = session({ duration: 320, inputFn: play });
    if (s.rs.phase !== 'finished') return { resultsFrozen: 0, _why: 'never finished' };
    const r1 = JSON.stringify(s.run.results(s.rs, s.ts));
    const scoredRun = s.ts.score > 0;   // freezing a zero result proves nothing
    // keep driving well past the line
    const e2 = { sampleHeight, surface: 'snow', sampleNormal: () => [0, 1, 0] };
    for (let i = 0; i < 600; i++) { s.run.step(s.rs, s.st, s.ts, DT); }
    const r2 = JSON.stringify(s.run.results(s.rs, s.ts));
    return { resultsFrozen: (scoredRun && r1 === r2) ? 1 : 0, _r1: r1.slice(0, 90), _scored: scoredRun };
  },
  agree() {
    const s = session({ duration: 300, inputFn: play });
    if (s.rs.phase !== 'finished') return { resultsAgree: 0, _why: 'never finished' };
    const res = s.run.results(s.rs, s.ts);
    const scoreAtFinish = s.trace.find(f => f.phase === 'finished')?.score ?? -1;
    // NON-VACUOUS: the drive must actually have scored, else 0 === 0 passes blind
    const scored = scoreAtFinish > 0 && !!res.bestTrick;
    return { resultsAgree: (scored && Math.abs(res.score - scoreAtFinish) < 1e-6) ? 1 : 0,
      _reported: Math.round(res.score), _atFinish: Math.round(scoreAtFinish),
      _bestTrick: res.bestTrick, _scored: scored };
  },
  confine(p) {
    // A player TRYING to leave, not a player spinning in circles: steer is a
    // proportional heading-seeker toward a target, so every phase actually makes
    // progress. (First version used raw hard steer and travelled 302 m in 240 s —
    // the gate passed vacuously because the rider never reached bad terrain.)
    const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
    const seek = (st, tx, tz) => {
      const want = Math.atan2(tz - st.pos[2], tx - st.pos[0]);
      return Math.max(-1, Math.min(1, wrap(want - st.heading) * 1.8));
    };
    const D = p.duration;
    const adversarial = (t, st) => {
      const z = st.pos[2], cx = centerX(z);
      let tx, tz;
      if (t < D * 0.45) { tx = centerX(z + 120); tz = z + 120; }          // race down-course
      else if (t < D * 0.7) { tx = cx + 800; tz = z + 40; }               // bail hard RIGHT off-course
      else if (t < D * 0.85) { tx = cx - 800; tz = z + 40; }              // bail hard LEFT off-course
      else { tx = centerX(z + 120); tz = z + 400; }                       // straight past the finish
      return { tuck: true, boost: true, steer: seek(st, tx, tz) };
    };
    const s = session({ duration: D, inputFn: adversarial });
    // The adversarial drive is contained by the corridor, so it rarely triggers a
    // correction — a TELEPORTING mutant escaped RS-06 by never being measured.
    // Place the rider hard outside and watch the module pull it back: that is the
    // only way to measure whether the correction is soft.
    const oobStart = (() => {
      const e2 = { sampleHeight, sampleNormal: (x, z) => {
        const d = 0.05;
        const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
        const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
        const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
      }, surface: 'snow' };
      let worst = 0;
      for (const off of [200, -200, 400, -400]) {
        const ph = createPhysics(e2, {});
        const tr = createTricks({});
        const run = createRun(env());
        const ts = tr.init(), rs = run.init();
        const z0 = 900, cx = centerX(z0), x0 = cx + off;
        const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 8], Math.PI / 2);
        for (let i = 0; i < 60 * 12; i++) {
          ph.step(st, { tuck: true }, DT);
          tr.step(ts, st, {}, DT);
          // EXACT: snapshot position around run.step. Measuring frame-to-frame
          // motion instead would charge the module for the rider's own speed —
          // it false-failed the honest baseline sliding down a steep wall.
          const p0 = [st.pos[0], st.pos[1], st.pos[2]];
          run.step(rs, st, ts, DT);
          worst = Math.max(worst, Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]));
        }
      }
      return worst;
    })();
    // record how far the drive actually got — a confine gate that never leaves the
    // start is worthless, so report reach for the critic and for future readers
    const reachZ = Math.max(...s.trace.map(f => f.z));
    return { maxDivergenceReached_m: +s.maxDiv.toFixed(2),
      maxCorrectionJump_m: +Math.max(s.maxJump, oobStart).toFixed(3),
      _jumpFromDrive: +s.maxJump.toFixed(3), _jumpFromOobSeed: +oobStart.toFixed(3),
      _endZ: Math.round(s.st.pos[2]), _endX: Math.round(s.st.pos[0]), _reachZ: Math.round(reachZ),
      _phase: s.rs.phase, _driveReachedFinish: reachZ >= 2400 };
  },
  restart() {
    const hash = (s) => s.trace.slice(-40).map(f => `${f.z.toFixed(4)}|${f.time_s.toFixed(4)}|${f.score}`).join(',');
    const a = session({ duration: 60, inputFn: play });
    const b = session({ duration: 60, inputFn: play });
    // and an explicit restart() mid-session must reproduce the same forward path
    const c = session({ duration: 60, inputFn: play });
    c.run.restart(c.rs);
    return { restartDeterministic: (hash(a) === hash(b) && c.rs.time_s === 0 && c.rs.phase !== 'finished') ? 1 : 0,
      _sameHash: hash(a) === hash(b), _resetTime: c.rs.time_s };
  },
  duration() {
    const s = session({ duration: 300, inputFn: play });
    if (s.rs.phase !== 'finished') return { runDuration_s: 999, _why: 'never finished' };
    return { runDuration_s: +s.rs.time_s.toFixed(1) };
  },
  autopilot() {
    // EXACT, not counterfactual. Two-trajectory comparison (run twice, diff the
    // headings) is invalid the moment the module acts: the rides diverge and the
    // diff becomes chaos — it read 2510 deg/s for a module that never touches
    // heading. Instead measure the module's DIRECT write: snapshot heading (and
    // velocity) around the run.step call in a single simulation.
    const e = { sampleHeight, sampleNormal: (x, z) => {
      const d = 0.05;
      const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
      const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
      const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
    }, surface: 'snow' };
    const ph = createPhysics(e, {});
    const tr = createTricks({});
    const run = createRun(env());
    const ts = tr.init(), rs = run.init();
    const z0 = 15, x0 = centerX(z0);
    const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 6], Math.PI / 2);
    let worstYaw = 0, worstAtS = 0, active = 0, worstAirVel = 0, airWrites = 0, oobYaw = 0;
    for (let i = 0; i < 60 * 120; i++) {
      const t = i * DT;
      const cx = centerX(st.pos[2]);
      // ride hard into alternating walls so the corridor is genuinely engaged,
      // with jumps so landings happen off-centre (physics copies velocity yaw
      // onto heading on a clean landing — the indirect steering channel)
      const side = Math.sin(t * 0.05) > 0 ? 1 : -1;
      const inp = { tuck: true, boost: true, steer: seekSteer(st, cx + side * 400, st.pos[2] + 60) };
      const cyc = t % 6;
      if (st.onGround && cyc > 5.4 && cyc < 5.8) { inp.crouch = true; inp.tuck = false; }
      if (st.onGround && cyc >= 5.8 && cyc < 5.82) { inp.jumpRelease = true; inp.tuck = false; }
      ph.step(st, inp, DT);
      tr.step(ts, st, inp, DT);
      const hBefore = st.heading, vBefore = [st.vel[0], st.vel[2]], onG = st.onGround;
      run.step(rs, st, ts, DT);
      const sOff = Math.abs(st.pos[0] - centerX(st.pos[2]));
      const dYaw = Math.abs(wrapA(st.heading - hBefore)) * 180 / Math.PI / DT;
      if (rs.outOfBounds) { oobYaw = Math.max(oobYaw, dYaw); active++; }
      else if (dYaw > worstYaw) { worstYaw = dYaw; worstAtS = sOff; }
      // the bypass channel: a lateral velocity write while AIRBORNE becomes a
      // heading write on the next clean landing
      if (!onG) {
        const dv = Math.hypot(st.vel[0] - vBefore[0], st.vel[2] - vBefore[1]);
        if (dv > 1e-9) { airWrites++; worstAirVel = Math.max(worstAirVel, dv / DT); }
      }
    }
    return { moduleYawAuthority_degps: +worstYaw.toFixed(2),
      _corridorActiveFrames: active, _worstInBounds_at_s: +worstAtS.toFixed(1),
      _worstOutOfBoundsYaw_degps: +oobYaw.toFixed(2),
      _airborneVelWriteFrames: airWrites, _worstAirborneVelWrite_mps2: +worstAirVel.toFixed(2) };
  },
  skew(p) {
    // The corridor is a SKEWED coordinate: s = x - centreX(z), so ds/dt = vx - k*vz
    // with k = dcentreX/dz (measured worst -0.857 at z=795). Bounding |vx| by V_CAP
    // does NOT bound |ds/dt|; the true bound is V_CAP*sqrt(1+k^2) = 43.46 m/s.
    // Sweep states that are strictly IN BOUNDS and demand total silence: any write
    // here is the module acting on a rider the contract says is fine.
    const e = { sampleHeight, sampleNormal: (x, z) => {
      const d = 0.05;
      const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
      const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
      const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
    }, surface: 'snow' };
    const B = env().bounds;
    let worst = 0, at = null;
    for (const z of [300, 795, 1200, 1800, 2200]) {
      const cx = centerX(z);
      const k = (centerX(z + 5) - centerX(z - 5)) / 10;
      for (const sAbs of [B.halfWidth - 1, B.halfWidth * 0.75, B.halfWidth * 0.5]) {
        for (const sgn of [1, -1]) {
          for (const frac of [1.0, 0.6, 0.2]) {
            // choose vx,vz so that |ds/dt| = frac * V_CAP*sqrt(1+k^2), outward
            const V = 33, mag = frac * V * Math.sqrt(1 + k * k);
            const vx = sgn * Math.min(V, mag / Math.sqrt(1 + k * k));
            const vz = Math.sqrt(Math.max(0, V * V - vx * vx));
            const ph = createPhysics(e, {});
            const tr = createTricks({});
            const run = createRun(env());
            const ts = tr.init(), rs = run.init();
            const x0 = cx + sgn * sAbs;
            const st = ph.init([x0, sampleHeight(x0, z), z], [vx, 0, vz], Math.atan2(vz, vx));
            rs.phase = 'running';                       // past the gate, mid-run
            const v0 = [st.vel[0], st.vel[1], st.vel[2]];
            const p0 = [st.pos[0], st.pos[1], st.pos[2]];
            const h0 = st.heading;
            run.step(rs, st, ts, DT);
            const dv = Math.hypot(st.vel[0] - v0[0], st.vel[1] - v0[1], st.vel[2] - v0[2]);
            const dp = Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]);
            const dh = Math.abs(wrapA(st.heading - h0));
            const write = Math.max(dv, dp, dh);
            if (write > worst) { worst = write; at = { z, s: +(sgn * sAbs).toFixed(1), k: +k.toFixed(3),
              dsdt: +(vx - k * vz).toFixed(1), dv: +dv.toFixed(3), dp: +dp.toFixed(4), dh: +dh.toFixed(4) }; }
          }
        }
      }
    }
    return { inBoundsWriteMax: +worst.toFixed(6), _worstAt: at };
  },
  neutrality() {
    // The corridor must be a boundary, not a participant: an identical competent
    // run with and without the module must agree on time and score.
    const withRun = session({ duration: 320, inputFn: play });
    const bare = (() => {
      const e = { sampleHeight, sampleNormal: (x, z) => {
        const d = 0.05;
        const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
        const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
        const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l];
      }, surface: 'snow' };
      const ph = createPhysics(e, {});
      const tr = createTricks({});
      const ts = tr.init();
      const z0 = 15, x0 = centerX(z0);
      const st = ph.init([x0, sampleHeight(x0, z0), z0], [0, 0, 6], Math.PI / 2);
      for (let i = 0; i < Math.round(320 / DT); i++) {
        const t = i * DT;
        const inp = play(t, st);
        ph.step(st, inp, DT);
        tr.step(ts, st, inp, DT);
        if (st.pos[2] >= 2400) return { t, score: ts.score };
      }
      return { t: 320, score: ts.score };
    })();
    const tW = withRun.rs.time_s, tB = bare.t;
    const sW = withRun.ts.score, sB = bare.score;
    const dT = Math.abs(tW - tB) / Math.max(tB, 1e-6);
    const dS = Math.abs(sW - sB) / Math.max(sB, 1e-6);
    return { runDeltaFrac: +Math.max(dT, dS).toFixed(5),
      _timeWith: +tW.toFixed(2), _timeBare: +tB.toFixed(2),
      _scoreWith: Math.round(sW), _scoreBare: Math.round(sB),
      _dTimeFrac: +dT.toFixed(5), _dScoreFrac: +dS.toFixed(5) };
  },
  start() {
    // Seed BEHIND the start gate. The old probe seeded at z=15 (already past
    // zStart=0), so every candidate took the runner's "no ready phase" free
    // branch and RS-09 passed by absence for both.
    const s = session({ duration: 8, seedZ: -40, inputFn: (t) => (t < 5 ? {} : { tuck: true }) });
    const ready = s.trace.filter(f => f.phase === 'ready');
    if (!ready.length) return { startHolds: 0, _why: 'no ready phase even when seeded behind zStart' };
    const drift = Math.abs(ready[ready.length - 1].z - ready[0].z);
    return { startHolds: drift < 3 ? 1 : 0, _driftM: +drift.toFixed(2) };
  },
};

const results = [];
for (const g of GATES) {
  const mode = g.scenario?.params?.mode;
  let row;
  try {
    const m = impl[mode](g.scenario.params);
    const val = m[g.metric];
    let pass;
    if (g.op === 'in_range') pass = val >= g.min && val <= g.max;
    else if (g.op === 'lte') pass = val <= g.value;
    else if (g.op === 'gte') pass = val >= g.value;
    else if (g.op === 'eq') pass = Math.abs(val - g.value) < 1e-9;
    const side = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('_')));
    row = { id: g.id, tag: g.tag, status: pass ? 'pass' : 'fail', metric: g.metric,
      value: typeof val === 'number' ? +Number(val).toPrecision(6) : val,
      expect: g.op === 'in_range' ? `[${g.min}, ${g.max}]` : `${g.op} ${g.value}`, ...side };
  } catch (err) {
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err.message).slice(0, 200) };
  }
  results.push(row);
}

const counts = { pass: 0, fail: 0, error: 0 };
let hardFails = 0;
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if (r.status !== 'pass' && r.tag === 'HARD') hardFails++;
}
const report = { module: modPath, counts, hardFails, results };
if (outPath) { mkdirSync(dirname(resolve(ROOT, outPath)), { recursive: true });
  writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2)); }
for (const r of results)
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status.toUpperCase()).padEnd(6)} ${r.id.padEnd(6)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + r.value : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? ''}`);
console.log(JSON.stringify({ counts, hardFails }));
process.exit(hardFails === 0 ? 0 : 2);
