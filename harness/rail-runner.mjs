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
  // STRAIGHT LEAD-IN. Without it the rider locks a little way into the bend, so
  // their arrival velocity leans INTO the turn and cancels part of the curve
  // load: R80's passive life read 2.90 s against 1.60 s on a straight rail, and
  // GR-06 graded arrival error instead of curvature. The lead-in lets the rider
  // capture cleanly (seed balance 0) and meet the bend already settled.
  const pts = [];
  const LEAD = 12;                       // m of straight before the arc
  for (let i = 0; i < 4; i++) pts.push([0, RAIL_Y + 0.3, -LEAD + i * (LEAD / 4)]);
  const sweep = sweepDeg * Math.PI / 180;
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * sweep;
    pts.push([sign * radius * (1 - Math.cos(a)), RAIL_Y + 0.3, radius * Math.sin(a)]);
  }
  return { id: 'arc' + radius + (sign > 0 ? 'R' : 'L'), points: pts, width: 0.2 };
}
// DESCENDING rail. Every rail in this runner was built at constant height, which
// hid a missing gravity-along-tangent term for six cycles and let a candidate
// reach 58.8 m/s on a 30 deg descent while the flat sheet showed nothing.
// Ground descends with it so the rail sits a fixed height above the surface.
function descendRail(len = 200, deg = 25) {
  const k = Math.tan(deg * Math.PI / 180);
  const pts = [];
  for (let i = 0; i <= 20; i++) { const z = i * (len / 20); pts.push([0, RAIL_Y + 0.3 - z * k, z]); }
  return { id: 'descend' + deg, points: pts, width: 0.2, _slopeK: k };
}
function descendEnv(rail) {
  const k = rail._slopeK;
  return { sampleHeight: (x, z) => RAIL_Y - Math.max(0, z) * k,
    sampleNormal: () => { const l = Math.hypot(k, 1); return [0, 1 / l, k / l]; },
    surface: 'snow', rails: [rail] };
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
  // Count SETS, not value differences. Diffing before/after rl.step missed
  // write-then-restore entirely: `const s = ps.spinDeg; ps.spinDeg = s + 999;
  // ps.spinDeg = s;` scored 0. An accessor sees every assignment, including one
  // that lands back on the original value.
  // KNOWN LIMIT: in-place mutation of an OBJECT field (st.landing.foo = 1) is
  // still invisible; only assignment to the field itself is counted.
  let counting = false;
  if (watchWrites) {
    for (const k of OWNED) {
      let v = st[k];
      Object.defineProperty(st, k, {
        configurable: true, enumerable: true,
        get() { return v; },
        set(nv) { if (counting) trickWrites++; v = nv; },
      });
    }
  }
  const n = Math.round(duration / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const inp = inputFn ? (inputFn(t, st, gs) ?? {}) : {};
    ph.step(st, inp, DT);
    const p0 = [st.pos[0], st.pos[1], st.pos[2]], v0 = [st.vel[0], st.vel[1], st.vel[2]], h0 = st.heading;
    counting = watchWrites;
    rl.step(gs, st, inp, DT);
    if (watchWrites) {
      const dh = Math.abs(wrapA(st.heading - h0));
      const dp = Math.hypot(st.pos[0] - p0[0], st.pos[1] - p0[1], st.pos[2] - p0[2]);
      counting = false;
      const justLocked = gs.onRail && !prevOnRail;
      // heading writes are never legal. Position has exactly ONE legal write —
      // the lock-on snap — and the contract bounds it by captureRadius. The old
      // line discarded dp entirely on a lock frame, so a mutant teleporting the
      // rider +40 m in z scored illegalWriteMax = 0.
      const snapCap = (rl.config?.captureRadius_m ?? 1.5) + 0.5;   // + rail height slack
      const illegal = Math.max(dh, justLocked ? Math.max(0, dp - snapCap) : dp);
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
    // MEASURE the radius by bisection instead of grading the module's own
    // declared constant. The old probe only asked "locks at 0.7*cfg, misses at
    // 3.0 m", so a module capturing at a true 2.5 m while declaring 1.0 passed
    // in-band: any real radius in (0.7*cfg, 3.0) was invisible.
    let lo = 0, hi = 4.0;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (everLocked(attempt({ offset: mid, inputFn: () => ({}) }))) lo = mid; else hi = mid;
    }
    const measured = (lo + hi) / 2;
    const declared = cfg ?? -1;
    // The band is enforced against MEASURED behaviour; the declaration must also
    // be honest about it (contract requires config to describe the module).
    const honest = declared > 0 && Math.abs(measured - declared) <= 0.25;
    return { captureRadius_m: honest ? +measured.toFixed(3) : -1,
      _measured: +measured.toFixed(3), _declared: declared,
      _declarationHonest: honest };
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
        leftAt = i; speedBefore = r.trace[i - 1].speed;
        // Largest single-frame DROP across the 0.5 s after the exit, not the one
        // frame at the transition. A one-frame check let a module dump 40% of
        // horizontal speed on the NEXT frame and still score 0.00146; taking the
        // window minimum instead measured ordinary drag (4.5% over 0.5 s on the
        // honest baseline) and failed everyone. A dump is a STEP; drag is smooth
        // (~0.4%/frame at 16 m/s), so the worst step separates them cleanly.
        const win = r.trace.slice(i - 1, i + Math.round(0.5 / DT));
        let worst = 0;
        for (let k = 1; k < win.length; k++) {
          const drop = (win[k - 1].speed - win[k].speed) / Math.max(win[k - 1].speed, 1e-6);
          worst = Math.max(worst, drop);
        }
        speedAfter = speedBefore * (1 - worst);
      }
    }
    if (leftAt === null) return { leaveSpeedLossFrac: 1, _why: 'never left the rail' };
    return { leaveSpeedLossFrac: +Math.abs(speedBefore - speedAfter).toFixed(4) / Math.max(speedBefore, 1e-6),
      _before: +speedBefore.toFixed(2), _after: +speedAfter.toFixed(2) };
  },
  balance(p) {
    // GR-05 REWRITTEN for the SSX model. It used to require that a passive rider
    // BAILS off a straight rail in 0.8-6 s — the Tony Hawk balance meter. The
    // reference bar says the opposite: references/research/02 sec 1.5,
    // "To grind, just land on a rail ... lock-on is automatic on contact, there
    // is a light balance element handled by stance." In SSX a straight rail is
    // survivable without a fight. The gate now asserts THAT, plus the thing that
    // still has to be true: balance is not decoration — the stick moves it.
    const LONG = straightRail(400);

    // 1. a straight rail HOLDS with no input at all
    const passive = attempt({ rail: LONG, offset: 0, speed: 18, duration: 10, inputFn: () => ({}) });
    const firstLock = passive.trace.findIndex(f => f.onRail);
    const railEnd = passive.trace.findIndex((f, i) => i > firstLock && f.z > 395);
    const window = (railEnd > 0 ? railEnd : passive.trace.length) - Math.max(firstLock, 0);
    const passiveHeld = lockFrames(passive) / Math.max(1, window);
    const passiveBailed = passive.trace.some(f => f.bailed);

    // 2. the stick still MOVES balance — otherwise it is decoration and a module
    //    could satisfy clause 1 by hardcoding balance to zero
    const env = envFor([LONG]);
    const sample = (steer) => {
      const ph = createPhysics(env, {});
      const rl = createRails(env);
      const gs = rl.init();
      const st = ph.init([0, RAIL_Y, -6], [0, 0, 18], Math.PI / 2);
      for (let i = 0; i < 120; i++) { ph.step(st, { steer }, DT); rl.step(gs, st, { steer }, DT); }
      return gs.onRail ? (gs.balance ?? 0) : NaN;
    };
    const bLeft = sample(-1), bZero = sample(0), bRight = sample(+1);
    const spread = (Number.isFinite(bLeft) && Number.isFinite(bRight))
      ? Math.abs(bLeft - bRight) : 0;
    const responds = spread > 0.15 && Math.sign(bLeft - bZero) !== Math.sign(bRight - bZero);

    return {
      balanceMechanicReal: (passiveHeld > 0.9 && !passiveBailed && responds) ? 1 : 0,
      _passiveHeldFrac: +passiveHeld.toFixed(2), _passiveBailed: passiveBailed,
      _balAtSteerMinus1: Number.isFinite(bLeft) ? +bLeft.toFixed(3) : null,
      _balAtSteer0: Number.isFinite(bZero) ? +bZero.toFixed(3) : null,
      _balAtSteerPlus1: Number.isFinite(bRight) ? +bRight.toFixed(3) : null,
      _stickSpread: +spread.toFixed(3),
    };
  },
  curve(p) {
    // GR-06 REWRITTEN for the SSX model, but the INTENT is unchanged and it is
    // the one balance failure the research actually documents. Same source,
    // references/research/02-turning-edge-friction.md sec 1.5, quoting a Tricky
    // guide: "I kept grinding but didn't turn. You eventually WILL FALL OFF for
    // not turning."
    //
    // So the test is a contrast, not an authority model:
    //   straight rail, no input -> HOLDS   (that is GR-05, restated here as the control)
    //   curved rail,  no input -> COMES OFF
    //   curved rail,  steering -> HOLDS
    // The old gate graded "does a bend cost more stick than a straight" under a
    // divergent mode that made even straights cost stick. Nothing to compare to.
    // TWO RADII, because the model is an equilibrium and the arithmetic is
    // knowable in advance: balance settles at aLat/A_AUTH = v^2/(R*g). At 18 m/s
    // that crosses the bail threshold of 1 when R < 324/9.81 = 33 m. So:
    //   R = 45  a moderate bend a passive rider RIDES OUT (SSX is forgiving)
    //   R = 25  a tight bend that DROPS a passive rider (equilibrium 1.32) and
    //           is rescued by steering (0.32 with full stick)
    // Testing only R=40 would have graded a bend that sits just under the
    // threshold and never drops anyone.
    // MEASURED, not assumed. Balance settles at aLat/A_AUTH, and rail drag bleeds
    // speed on a bend, so a slow rider is loaded far less than the entry speed
    // suggests. Sweeping radius against entry speed:
    //   R=45 @ 18 m/s  passive max|bal| 0.25  holds        (SSX rails are forgiving)
    //   R=25 @ 28 m/s  passive max|bal| 0.99  DROPS, and steering rescues it
    //   R=16 @ 32 m/s  both bail — too tight to be a fair test
    // A slow rider on a tight bend is NOT loaded enough to fall; fast-and-tight
    // is what actually throws you, which is also the right game feel.
    const RAD_HOLD = p?.radiusHold ?? 45, SPD_HOLD = p?.speedHold ?? 18;
    const RAD_DROP = p?.radiusDrop ?? 25, SPD_DROP = p?.speedDrop ?? 28;
    const held = (rail, drive, speed = 18) => {
      const r = attempt({ rail, offset: 0, speed, duration: 14, inputFn: drive, startZ: -18 });
      const first = r.trace.findIndex(f => f.onRail);
      if (first < 0) return { frac: 0, bailed: false, locked: false };
      let last = first;
      for (let i = first; i < r.trace.length; i++) if (r.trace[i].onRail) last = i; else break;
      const bailed = r.trace.slice(first, last + 2).some(f => f.bailed);
      // fraction of the rail actually ridden, by arclength proxy (frames on rail
      // against frames until the rail runs out)
      return { frac: (last - first + 1) / Math.max(1, r.trace.length - first), bailed, locked: true };
    };
    const passive = () => ({});
    const steering = (t, st, gs) =>
      ({ steer: gs && gs.onRail ? Math.max(-1, Math.min(1, (gs.balance || 0) * 3)) : 0 });

    const straightPassive = held(straightRail(400), passive);
    const out = { _straightPassiveBailed: straightPassive.bailed,
      _straightPassiveHeld: +straightPassive.frac.toFixed(2), _arcs: [] };
    let ok = true;
    if (straightPassive.bailed) ok = false;          // control: straights must hold

    for (const sign of [1, -1]) {
      // a moderate bend must be RIDEABLE with no input — SSX rails are forgiving
      const mild = held(arcRail(RAD_HOLD, 240, sign), passive, SPD_HOLD);
      const mildOk = mild.locked && !mild.bailed;
      // a tight bend must DROP a passive rider, and steering must rescue it
      const rail = arcRail(RAD_DROP, 240, sign);
      const pv = held(rail, passive, SPD_DROP), st_ = held(rail, steering, SPD_DROP);
      const dropsWithoutSteer = pv.locked && pv.bailed;
      const holdsWithSteer = st_.locked && !st_.bailed;
      out._arcs.push({ sign,
        mild: `R${RAD_HOLD}@${SPD_HOLD}`, mildBailed: mild.bailed, mildOk,
        tight: `R${RAD_DROP}@${SPD_DROP}`, passiveBailed: pv.bailed,
        steeredBailed: st_.bailed, dropsWithoutSteer, holdsWithSteer });
      if (!(mildOk && dropsWithoutSteer && holdsWithSteer)) ok = false;
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
  descend() {
    const rail = descendRail(400, 25);
    const env = descendEnv(rail);
    const run = (offset) => {
      const ph = createPhysics(env, {});
      const rl = createRails(env);
      const gs = rl.init();
      const st = ph.init([offset, env.sampleHeight(offset, -6), -6], [0, 0, 18], Math.PI / 2);
      let maxSp = 0, locked = false;
      for (let i = 0; i < Math.round(12 / DT); i++) {
        const inp = { steer: gs.onRail ? Math.sign(gs.balance || 0) * 0.7 : 0 };
        ph.step(st, inp, DT); rl.step(gs, st, inp, DT);
        if (gs.onRail) locked = true;
        maxSp = Math.max(maxSp, Math.hypot(st.vel[0], st.vel[1], st.vel[2]));
      }
      return { maxSp, locked, end: Math.hypot(st.vel[0], st.vel[2]) };
    };
    const onRail = run(0), onSnow = run(40);
    const V_CAP = 33;
    return {
      descendOverCap_mps: +Math.max(0, onRail.maxSp - V_CAP).toFixed(3),
      // Presence, not absence: without this GR-12 passed on a module where the
      // rail DECELERATED the rider (18 -> 5.85 m/s) — nothing exceeded the cap
      // because nothing accelerated at all.
      descendBeatsSnow: (onRail.locked && onRail.end > onSnow.end) ? 1 : 0,
      _lockedOnDescent: onRail.locked,
      _railMax: +onRail.maxSp.toFixed(2), _snowMax: +onSnow.maxSp.toFixed(2),
      _railEnd: +onRail.end.toFixed(2), _snowEnd: +onSnow.end.toFixed(2),
    };
  },
  arrival() {
    // GR-14 REWRITTEN for the SSX model. It used to demand that a sloppy arrival
    // BAIL you sooner than a clean one — that only makes sense when balance is a
    // divergent mode, because a settling one recovers. Under SSX a bad landing
    // WOBBLES and settles; it does not end the grind. But it must still be
    // VISIBLE, or how you land is free and the approach carries no risk at all.
    //
    // Two clauses: the sloppy arrival must produce a bigger initial balance
    // excursion than a clean one, AND that excursion must DECAY — the rider
    // recovers rather than being killed by it.
    const rail = straightRail(400);
    const probe = (offset, latVel) => {
      const env = envFor([rail]);
      const ph = createPhysics(env, {});
      const rl = createRails(env);
      const gs = rl.init();
      const st = ph.init([offset, RAIL_Y, -6], [latVel, 0, 18], Math.PI / 2);
      let peak = 0, atLock = null, late = null, locked = false, lockT = 0, bailed = false;
      for (let i = 0; i < Math.round(12 / DT); i++) {
        const t = i * DT;
        ph.step(st, {}, DT); rl.step(gs, st, {}, DT);
        if (gs.bailed) bailed = true;
        if (!gs.onRail) { if (locked) break; continue; }
        const b = Math.abs(gs.balance ?? 0);
        if (!locked) { locked = true; lockT = t; atLock = b; }
        peak = Math.max(peak, b);
        if (t - lockT > 1.2 && late === null) late = b;   // settled value
      }
      return { peak, atLock, late, locked, bailed };
    };
    const clean = probe(0, 0);
    const sloppy = probe(0.9, -3.0);
    if (!clean.locked || !sloppy.locked) {
      return { arrivalErrorCosts_s: -1, _why: 'one arrival never locked',
        _cleanLocked: clean.locked, _sloppyLocked: sloppy.locked };
    }
    // (a) the sloppy landing is VISIBLY worse at the moment of capture
    const excursion = sloppy.peak - clean.peak;
    // (b) and it SETTLES rather than killing the grind
    const settled = sloppy.late !== null && sloppy.late < sloppy.peak * 0.5 && !sloppy.bailed;
    return {
      arrivalWobble: +excursion.toFixed(3),
      arrivalSettles: settled ? 1 : 0,
      _cleanPeak: +clean.peak.toFixed(3), _sloppyPeak: +sloppy.peak.toFixed(3),
      _sloppySettledTo: sloppy.late === null ? null : +sloppy.late.toFixed(3),
      _sloppyBailed: sloppy.bailed,
    };
  },
  phantom() {
    const far = attempt({ offset: 3.0, speed: 18, duration: 6, inputFn: () => ({}) });
    // startZ inside the rail: the old probe started 6 m up-course at 0.4 m/s and
    // ended at z = -5.78, never entering ANY legal capture radius, so
    // everLocked(slow) was false for every module and minLockSpeed was untested.
    // A module declaring minLockSpeed_mps: 0 passed GR-08 at 0.
    const slow = attempt({ offset: 0, speed: 0.4, duration: 6, startZ: 5, inputFn: () => ({}) });
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
      // Grade the rider's ACTUAL speed, not gs.alongSpeed. Reading a module-named
      // field let a module rename it to gs._v and return `?? 0` from BOTH runs:
      // dtSplitError = |0-0| = 0 while the real split error was 4.96e-4, 500x the
      // threshold. The graded number must be the number that moves the rider.
      return Math.hypot(st.vel[0], st.vel[2]);
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
