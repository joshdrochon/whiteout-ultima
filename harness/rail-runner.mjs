#!/usr/bin/env node
// Rails/grind gate runner — operational definition of the GR gates.
// Pure node: drives the accepted physics against a candidate rail module.
//
// usage: node harness/rail-runner.mjs --module sandbox/rails/A/rails.mjs [--out <json>]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modPath = resolve(ROOT, opt('module'));
const outPath = opt('out', null);

const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'rails' && g.tag !== 'RETIRED');

const { createRails } = await import(pathToFileURL(modPath).href);
const { createPhysics } = await import(pathToFileURL(resolve(ROOT, 'src/physics/physics.mjs')).href);
const { sampleHeight } = await import(pathToFileURL(resolve(ROOT, 'src/render/main.mjs')).href);

const DT = 1 / 60;
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Two test rails on flat synthetic ground so rail behaviour is isolated from
// terrain: one straight, one curved. Height is constant so gravity does not
// dominate the measurement.
const RAIL_Y = 0;
const flatEnv = {
  sampleHeight: () => RAIL_Y,
  sampleNormal: () => [0, 1, 0],
  surface: 'snow',
};
function straightRail(len = 120) {
  const pts = [];
  for (let i = 0; i <= 12; i++) pts.push([0, RAIL_Y + 0.3, i * (len / 12)]);
  return { id: 'straight', points: pts, width: 0.2 };
}
// Constant-radius arc: curvature is the SAME everywhere, so the probe measures
// curvature and not the arrival transient. (The old sin() curve had zero second
// derivative at t=0 — smallest curvature exactly where the rider is fastest.)
function arcRail(radius = 40, sweepDeg = 80, sign = 1) {
  const pts = [];
  const sweep = sweepDeg * Math.PI / 180;
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * sweep;
    pts.push([sign * radius * (1 - Math.cos(a)), RAIL_Y + 0.3, radius * Math.sin(a)]);
  }
  return { id: 'arc' + radius + (sign > 0 ? 'R' : 'L'), points: pts, width: 0.2 };
}
function curvedRail(len = 120, bend = 28) {
  const pts = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    pts.push([Math.sin(t * Math.PI * 0.5) * bend, RAIL_Y + 0.3, t * len]);
  }
  return { id: 'curved', points: pts, width: 0.2 };
}
const envFor = rails => ({ ...flatEnv, rails });

// One driven grind attempt. offset = lateral miss distance at the rail.
function attempt({ rail = straightRail(), offset = 0, speed = 18, duration = 8,
  inputFn = null, startZ = -6, watchWrites = false } = {}) {
  const env = envFor([rail]);
  const ph = createPhysics(env, {});
  const rl = createRails(env);
  const gs = rl.init();
  const st = ph.init([offset, RAIL_Y, startZ], [0, 0, speed], Math.PI / 2);
  const trace = [];
  let worstIllegal = 0, snaps = 0, prevOnRail = false, trickWrites = 0;
  // Fields the module may never touch. Heading/position are handled separately
  // (position has ONE legal write, the lock snap); these are pass/fail on any
  // change at all. Added after a blind cycle where a candidate bought its whole
  // margin with two `ps.spinDeg = ...` writes that the heading/position watcher
  // could not see.
  const OWNED = ['spinDeg', 'flipDeg', 'airTime', 'charge', '_popDone',
    'spinCapped', 'flipCapped', 'prewound', 'landing'];
  const n = Math.round(duration / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const inp = inputFn ? (inputFn(t, st, gs) ?? {}) : {};
    ph.step(st, inp, DT);
    const p0 = [st.pos[0], st.pos[1], st.pos[2]], v0 = [st.vel[0], st.vel[1], st.vel[2]], h0 = st.heading;
    const o0 = watchWrites ? OWNED.map(k => st[k]) : null;
    rl.step(gs, st, inp, DT);
    if (watchWrites) {
      OWNED.forEach((k, j) => { if (st[k] !== o0[j]) trickWrites++; });
      const dh = Math.abs(wrapA(st.heading - h0));
      const dp = Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]);
      const justLocked = gs.onRail && !prevOnRail;
      // heading writes are never legal; position writes only on the lock frame
      const illegal = Math.max(dh, justLocked ? 0 : dp);
      worstIllegal = Math.max(worstIllegal, illegal);
      if (justLocked) snaps++;
    }
    prevOnRail = gs.onRail;
    trace.push({ t, onRail: !!gs.onRail, bailed: !!gs.bailed,
      speed: Math.hypot(st.vel[0], st.vel[2]), z: st.pos[2], x: st.pos[0],
      air: st.airTime ?? 0, balance: gs.balance ?? 0 });
  }
  return { st, gs, rl, trace, worstIllegal, snaps, trickWrites };
}
// BALANCE SIGN CONVENTION (the runner defines it, the contract states it):
// positive steer REDUCES positive balance. The probe previously used the opposite
// sign and was feeding the drift it meant to correct, so an honest module scored
// 0.42 on GR-05.
const everLocked = r => r.trace.some(f => f.onRail);
const lockFrames = r => r.trace.filter(f => f.onRail).length;

const impl = {
  lock() {
    // dead-on approach, no input at all: must lock without any button press
    const r = attempt({ offset: 0, inputFn: () => ({}) });
    return { autoLockRate: everLocked(r) ? 1 : 0, _lockFrames: lockFrames(r) };
  },
  radius() {
    const rl = createRails(envFor([straightRail()]));
    const cfg = rl.config?.captureRadius_m;
    // trust but verify: the declared radius must match measured behaviour
    const hit = attempt({ offset: (cfg ?? 1) * 0.7, inputFn: () => ({}) });
    const miss = attempt({ offset: 3.0, inputFn: () => ({}) });
    const consistent = everLocked(hit) && !everLocked(miss);
    return { captureRadius_m: consistent ? cfg : -1, _declared: cfg,
      _lockedInside: everLocked(hit), _lockedAt3m: everLocked(miss) };
  },
  drag() {
    const hold = (t, st, gs) => ({ steer: gs && gs.onRail ? Math.sign(gs.balance || 0) * 0.6 : 0 });
    const onRail = attempt({ offset: 0, speed: 20, duration: 5, inputFn: hold });
    const onSnow = attempt({ offset: 40, speed: 20, duration: 5, inputFn: () => ({}) }); // far from rail
    const endRail = onRail.trace.at(-1).speed, endSnow = onSnow.trace.at(-1).speed;
    return { railFasterThanSnow: (everLocked(onRail) && endRail > endSnow) ? 1 : 0,
      _endRail: +endRail.toFixed(2), _endSnow: +endSnow.toFixed(2) };
  },
  leave() {
    let leftAt = null, speedBefore = 0, speedAfter = 0;
    const r = attempt({ offset: 0, speed: 20, duration: 6, inputFn: (t, st, gs) => {
      const inp = { steer: gs && gs.onRail ? Math.sign(gs.balance || 0) * 0.6 : 0 };
      if (gs && gs.onRail && t > 2.0 && t < 2.02) inp.jumpRelease = true;
      return inp;
    } });
    for (let i = 1; i < r.trace.length; i++) {
      if (r.trace[i - 1].onRail && !r.trace[i].onRail && leftAt === null) {
        leftAt = i; speedBefore = r.trace[i - 1].speed; speedAfter = r.trace[i].speed;
      }
    }
    if (leftAt === null) return { leaveSpeedLossFrac: 1, _why: 'never left the rail' };
    return { leaveSpeedLossFrac: +Math.abs(speedBefore - speedAfter).toFixed(4) / Math.max(speedBefore, 1e-6),
      _before: +speedBefore.toFixed(2), _after: +speedAfter.toFixed(2) };
  },
  balance(p) {
    // Long rail: at 18 m/s a 120 m rail ends at 6.7 s, so a 10 s "hold" was
    // impossible and the honest baseline scored 0.43 through no fault of its own.
    const LONG = straightRail(400);
    // no input -> must bail in 1.2-6 s; correcting input -> holds
    const passive = attempt({ rail: LONG, offset: 0, speed: 18, duration: 10, inputFn: () => ({}) });
    let bailT = null;
    for (let i = 1; i < passive.trace.length; i++)
      if (passive.trace[i - 1].onRail && !passive.trace[i].onRail && bailT === null)
        bailT = passive.trace[i].t - (passive.trace.find(f => f.onRail)?.t ?? 0);
    const active = attempt({ rail: LONG, offset: 0, speed: 18, duration: 10,
      inputFn: (t, st, gs) => ({ steer: gs && gs.onRail ? Math.sign(gs.balance || 0) * 0.8 : 0 }) });
    // measure the hold only over frames where rail remains available
    const firstLock = active.trace.findIndex(f => f.onRail);
    const railEnd = active.trace.findIndex((f, i) => i > firstLock && f.z > 395);
    const window = (railEnd > 0 ? railEnd : active.trace.length) - Math.max(firstLock, 0);
    const heldFrac = lockFrames(active) / Math.max(1, window);
    const LO = p?.bailLo ?? 0.8, HI = p?.bailHi ?? 6;   // declared choice, not sourced
    const bailsPassively = bailT !== null && bailT >= LO && bailT <= HI;
    const holdsActively = heldFrac > 0.8;
    return { balanceMechanicReal: (bailsPassively && holdsActively) ? 1 : 0,
      _passiveBailAfter_s: bailT === null ? null : +bailT.toFixed(2), _activeHeldFrac: +heldFrac.toFixed(2) };
  },
  curve(p) {
    // WORK, not a boolean. Time-to-drop with zero input on a constant-radius arc
    // must be strictly shorter than on a straight rail of the same length, AND
    // holding the arc must cost more stick than holding the straight — in BOTH
    // bend directions, so a module cannot pass on a one-sided quirk.
    const holdInput = (t, st, gs) => ({ steer: gs && gs.onRail ? Math.sign(gs.balance || 0) * 0.9 : 0 });
    const survive = (rail) => {
      const r = attempt({ rail, offset: 0, speed: 18, duration: 12, inputFn: () => ({}) });
      const first = r.trace.findIndex(f => f.onRail);
      if (first < 0) return { locked: false, life: 0 };
      let last = first;
      for (let i = first; i < r.trace.length; i++) if (r.trace[i].onRail) last = i; else break;
      return { locked: true, life: (last - first) * DT };
    };
    // Effort = STICK DEMANDED, measured with a PROPORTIONAL controller. A
    // bang-bang probe applies constant stick regardless of the bend, so it can
    // never show that a bend is harder; mean residual |balance| is likewise near
    // zero under any competent correction. Mean |steer| is the thing a player
    // actually spends.
    const effort = (rail) => {
      let acc = 0, n = 0;
      attempt({ rail, offset: 0, speed: 18, duration: 8, inputFn: (t, st, gs) => {
        if (!gs || !gs.onRail) return {};
        const st_ = Math.max(-1, Math.min(1, (gs.balance || 0) * 3.0));
        acc += Math.abs(st_); n++;
        return { steer: st_ };
      } });
      return n ? acc / n : 0;
    };
    const straight = straightRail(300);
    const sLife = survive(straight).life, sEff = effort(straight);
    const out = { _straightLife_s: +sLife.toFixed(2), _straightEffort: +sEff.toFixed(4), _arcs: [] };
    let ok = true;
    for (const R of (p?.radii ?? [40, 80])) {
      for (const sign of [1, -1]) {
        const rail = arcRail(R, 80, sign);
        const a = survive(rail), e = effort(rail);
        const dropsSooner = a.locked && a.life < sLife * 0.9;
        const costsMore = e > sEff * 1.5 + 0.01;
        out._arcs.push({ R, sign, life: +a.life.toFixed(2), effort: +e.toFixed(4), dropsSooner, costsMore });
        if (!(dropsSooner && costsMore)) ok = false;
      }
    }
    return { curveDemandsSteer: ok ? 1 : 0, ...out };
  },
  // trickstate() REMOVED with GR-10 (retired). Rail-spin accrual/reset are
  // PC-19/20/21; module-side coyote damage is GR-11's writes() probe.
  writes() {
    // Spin is DRIVEN here on purpose: a module that only reaches for trick state
    // when a spin input arrives is invisible to an unspun probe.
    //
    // The rider is also POPPED mid-run so there is a genuine AIRBORNE window with
    // airTime > 0 and spinDeg climbing. Without it, airTime is 0 for the whole
    // probe (grounded, then constrained), so a module pinning `airTime = 0` wrote
    // the value that was already there and the watcher saw no change at all - the
    // coyote-branch defect walked straight through a gate written to catch it.
    let popped = false;
    const r = attempt({ offset: 0, speed: 18, duration: 8, watchWrites: true,
      inputFn: (t, st, gs) => {
        const inp = { steer: gs && gs.onRail ? Math.sign(gs.balance || 0) * 0.6 : 0,
          spin: (gs && gs.onRail) || (st && !st.onGround) ? 1 : 0 };
        if (!popped && gs && gs.onRail && t > 1.2) { inp.jumpRelease = true; popped = true; }
        return inp;
      } });
    const airFrames = r.trace.filter(f => f.air > 0).length;
    return { illegalWriteMax: +r.worstIllegal.toFixed(9), trickStateWrites: r.trickWrites,
      _lockSnaps: r.snaps, _airborneFrames: airFrames };
  },
  phantom() {
    const far = attempt({ offset: 3.0, speed: 18, duration: 6, inputFn: () => ({}) });
    const slow = attempt({ offset: 0, speed: 0.4, duration: 6, inputFn: () => ({}) });
    return { phantomLocks: (everLocked(far) ? 1 : 0) + (everLocked(slow) ? 1 : 0),
      _lockedFarOff: everLocked(far), _lockedTooSlow: everLocked(slow) };
  },
  dt() {
    const run = (steps) => {
      const env = envFor([straightRail()]);
      const ph = createPhysics(env, {});
      const rl = createRails(env);
      const gs = rl.init();
      const st = ph.init([0, RAIL_Y, -6], [0, 0, 18], Math.PI / 2);
      // Hold balance while settling AND while stepping: with no input the rider
      // bails off the rail in ~1 s, after which alongSpeed is frozen and both
      // variants return the same value — the gate measured nothing and a naive
      // Euler mutant escaped it.
      const hold = () => ({ steer: gs.onRail ? Math.max(-1, Math.min(1, (gs.balance || 0) * 3.0)) : 0 });
      for (let i = 0; i < 120; i++) { const u = hold(); ph.step(st, u, DT); rl.step(gs, st, u, DT); }
      if (!gs.onRail) return NaN;                     // fail loudly rather than silently
      for (const dt of steps) { const u = hold(); ph.step(st, u, dt); rl.step(gs, st, u, dt); }
      // The module's OWN state. Position cannot be dt-exact here: the module is
      // forbidden to write position (GR-07) and physics integrates position with
      // the project-wide Euler step, so demanding exact position would be
      // demanding something no legal module can deliver.
      return gs.alongSpeed ?? 0;
    };
    const a = run([0.1]);
    const b = run(Array(10).fill(0.01));
    if (Number.isNaN(a) || Number.isNaN(b)) return { dtSplitError: 999, _why: 'rider left the rail before the measurement' };
    return { dtSplitError: +Math.abs(a - b).toFixed(9), _a: a, _b: b };
  },
};

const results = [];
for (const g of GATES) {
  const mode = g.scenario?.params?.mode;
  let row;
  try {
    const m = impl[mode]();
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
