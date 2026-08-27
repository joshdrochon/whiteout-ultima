// Tuning lab. Mirrors harness/rival-runner.mjs' race loop (same course, same
// reference player, same throttle-lock rules) and prints the things the runner
// does not: finishing ORDER per seed, boost presses per rider, mean height
// above the gully trough, and the AI-14 pair matrix. The runner is still the
// authority; nothing here is quoted without the runner agreeing.
import { pathToFileURL } from 'node:url';
import { dirname, resolve as _res } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = _res(dirname(fileURLToPath(import.meta.url)), '../../..');
const MOD = process.env.MOD ?? (ROOT + '/sandbox/rivals/c3B/rivals.mjs');
const ABLATE = process.env.ABLATE ?? '';
const { createRivals } = await import(pathToFileURL(MOD).href + (ABLATE ? '?a=' + ABLATE : ''));
const { createPhysics } = await import(pathToFileURL(ROOT + '/src/physics/physics.mjs').href);
const { sampleHeight } = await import(pathToFileURL(ROOT + '/src/render/main.mjs').href);

const DT = 1 / 60;
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
function rawCenterX(z) { let best = Infinity, bx = 0; for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } } return bx; }
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => { const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1; const raw = new Array(n); for (let i = 0; i < n; i++) raw[i] = rawCenterX(CL_Z0 + i * CL_STEP); const sm = new Array(n); for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += raw[j]; c++; } } sm[i] = a / c; } return sm; })();
const centerX = z => { const f = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP; const i = Math.min(CL.length - 2, Math.max(0, Math.floor(f))); const t = f - i; return CL[i] * (1 - t) + CL[i + 1] * t; };
const physEnv = { sampleHeight, sampleNormal: (x, z) => { const d = 0.05; const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d); const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d); const l = Math.hypot(dx, 1, dz); return [-dx / l, 1 / l, -dz / l]; }, surface: 'snow' };
const Z_START = 0, Z_FINISH = 2400, HALF_W = 120;
const PLAYER_STATS = { speed: 20, edging: 20, trick: 20 };
function seekSteer(st, tx, tz, gain = 1.8) { const want = Math.atan2(tz - st.pos[2], tx - st.pos[0]); return clamp(wrapA(want - st.heading) * gain, -1, 1); }
function referencePlayerInput(t, st) {
  const tz = st.pos[2] + 120, tx = centerX(tz);
  const inp = { tuck: true, boost: t > 3, steer: seekSteer(st, tx, tz) };
  const cyc = t % 14;
  if (st.onGround) { if (cyc > 13.4 && cyc < 13.8) { inp.crouch = true; inp.tuck = false; } if (cyc >= 13.8 && cyc < 13.82) { inp.jumpRelease = true; inp.tuck = false; } }
  else inp.tuck = false;
  return inp;
}
const ROSTER_4 = [{ id: 'r1', tier: 'easy' }, { id: 'r2', tier: 'easy' }, { id: 'r3', tier: 'medium' }, { id: 'r4', tier: 'hard' }];
const START_Z = 15, GATE_SPACING = 5, TRAJ_EVERY = 6, MAX_T = 400;
function tierStats(cfg, tier) { const raw = cfg?.tiers?.[tier]?.stats ?? {}; const o = {}; for (const k of ['speed', 'edging', 'trick']) { const v = Number.isFinite(raw[k]) ? raw[k] : 20; o[k] = clamp(v, 0, 40); } return o; }
function spawnState(ph, x, z) { return ph.init([x, sampleHeight(x, z), z], [0, 0, 6], Math.PI / 2); }

export function race({ seed, throttleLock = false, assist = true, drivePlayer = true }) {
  const env = { sampleHeight, courseCenterX: centerX, bounds: { zStart: Z_START, zFinish: Z_FINISH, halfWidth: HALF_W }, roster: ROSTER_4.map(r => ({ ...r })), seed, assist };
  const mod = createRivals(env); const cfg = mod.config ?? {}; const rvs = mod.init();
  const pph = createPhysics(physEnv, { stats: PLAYER_STATS });
  const P = spawnState(pph, centerX(START_Z), START_Z);
  const spacing = throttleLock ? 0 : GATE_SPACING;
  const gate0 = centerX(START_Z) - ((ROSTER_4.length - 1) / 2) * spacing;
  const racers = ROSTER_4.map((r, i) => {
    const stats = throttleLock ? { ...PLAYER_STATS } : tierStats(cfg, r.tier);
    const ph = createPhysics(physEnv, { stats });
    const st = spawnState(ph, gate0 + i * spacing, START_Z);
    return { id: r.id, tier: r.tier, ph, st, finished: false, finishT: null, line: [], boostPress: 0, brakeFrames: 0, boostFrames: 0, prevBoost: false, hSum: 0, hN: 0, maxLat: 0, absLat: 0, arch: rvs.rivals[r.id]?.arch };
  });
  let pFin = null, minSep = Infinity, sepAt = null;
  const n = Math.round(MAX_T / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;
    const world = { t, dt: DT, player: P, rivals: Object.fromEntries(racers.map(r => [r.id, r.st])) };
    const raw = mod.step(rvs, world, DT) ?? {};
    for (const r of racers) {
      const inp = { ...(raw[r.id] ?? {}) };
      if (throttleLock) { inp.boost = false; inp.brake = false; inp.uber = false; inp.tuck = !inp.crouch; }
      if (inp.boost && !r.prevBoost) r.boostPress++;
      if (inp.boost) r.boostFrames++;
      if (inp.brake) r.brakeFrames++;
      r.prevBoost = !!inp.boost;
      r.ph.step(r.st, inp, DT);
      if (r.finished) continue;
      if (r.st.pos[2] >= Z_FINISH) { r.finished = true; r.finishT = t; continue; }
      const s = r.st.pos[0] - centerX(r.st.pos[2]);
      if (i % TRAJ_EVERY === 0) r.line.push(r.st.pos[2], s);
      r.maxLat = Math.max(r.maxLat, Math.abs(s)); r.absLat += Math.abs(s);
      r.hSum += sampleHeight(r.st.pos[0], r.st.pos[2]) - sampleHeight(centerX(r.st.pos[2]), r.st.pos[2]); r.hN++;
    }
    if (process.env.LOGT && t <= Number(process.env.LOGT) && i % 6 === 0)
      console.log('t', t.toFixed(2), racers.map(r => `${r.id}:x=${r.st.pos[0].toFixed(1)},z=${r.st.pos[2].toFixed(0)},s=${(raw[r.id]?.steer ?? 0).toFixed(2)}`).join(' '), 'P:x=' + P.pos[0].toFixed(1) + ',z=' + P.pos[2].toFixed(0), 'c=' + centerX(P.pos[2]).toFixed(1));
    if (drivePlayer) { pph.step(P, referencePlayerInput(t, P), DT); if (pFin === null && P.pos[2] >= Z_FINISH) pFin = t; }
    const live = racers.filter(r => !r.finished);
    const pts = (pFin === null && drivePlayer ? [...live.map(r => r.st), P] : live.map(r => r.st));
    const nm = (pFin === null && drivePlayer ? [...live.map(r => r.id), 'P'] : live.map(r => r.id));
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) { const d = Math.hypot(pts[a].pos[0] - pts[b].pos[0], pts[a].pos[1] - pts[b].pos[1], pts[a].pos[2] - pts[b].pos[2]); if (d < minSep) { minSep = d; sepAt = { t: +t.toFixed(2), pair: nm[a] + '/' + nm[b], z: +pts[a].pos[2].toFixed(0), air: [!pts[a].onGround, !pts[b].onGround], dy: +(pts[a].pos[1] - pts[b].pos[1]).toFixed(2) }; } }
    if (racers.every(r => r.finished) && (!drivePlayer || pFin !== null)) break;
  }
  return { seed, racers, pFin, minSep, sepAt, rvs };
}
const GZ0 = 100, GZ1 = 2300, GS = 10;
export function laneProfile(rv) {
  const b = rv.line, out = new Float64Array(Math.floor((GZ1 - GZ0) / GS) + 1);
  if (b.length < 4) return out;
  let j = 0, sum = 0;
  for (let g = 0; g < out.length; g++) {
    const z = GZ0 + g * GS;
    while (j + 3 < b.length && b[j + 2] <= z) j += 2;
    let v;
    if (z <= b[0]) v = b[1]; else if (z >= b[b.length - 2]) v = b[b.length - 1];
    else { const t = (z - b[j]) / Math.max(1e-9, b[j + 2] - b[j]); v = b[j + 1] * (1 - t) + b[j + 3] * t; }
    out[g] = v; sum += v;
  }
  const m = sum / out.length; for (let g = 0; g < out.length; g++) out[g] -= m;
  return out;
}
export function closestPair(racers) {
  const prof = racers.map(rv => ({ id: rv.id, p: laneProfile(rv) }));
  let best = Infinity, who = null;
  for (let i = 0; i < prof.length; i++) for (let k = i + 1; k < prof.length; k++) {
    let acc = 0; for (let g = 0; g < prof[i].p.length; g++) { const d = prof[i].p[g] - prof[k].p[g]; acc += d * d; }
    const rms = Math.sqrt(acc / prof[i].p.length);
    if (rms < best) { best = rms; who = `${prof[i].id}/${prof[k].id}`; }
  }
  return { rms: best, who };
}

if (process.argv[1].endsWith('_lab.mjs')) {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const byTier = { easy: [], medium: [], hard: [] };
  const bp = { r1: 0, r2: 0, r3: 0, r4: 0 };
  let minSep = Infinity, worstLock = Infinity, worstSeed = 0, worstPair = '', maxLat = 0, worstH = 0;
  console.log('seed | finishing order (name:time)                                  | player');
  const orders = [];
  for (const seed of SEEDS) {
    const R = race({ seed });
    const rows = R.racers.map(r => ({ id: r.id, tier: r.tier, arch: r.arch, t: r.finishT }));
    for (const r of rows) byTier[r.tier].push(r.t);
    for (const r of R.racers) { bp[r.id] += r.boostPress; maxLat = Math.max(maxLat, r.maxLat); worstH = Math.max(worstH, r.hSum / Math.max(1, r.hN)); }
    minSep = Math.min(minSep, R.minSep); if (process.env.SEPDBG) console.log('  sep', seed, R.minSep.toFixed(3), JSON.stringify(R.sepAt));
    const all = [...rows.map(r => ({ n: `${r.id}(${r.arch ?? '?'},${r.tier[0]})`, t: r.t })), { n: 'PLAYER', t: R.pFin }].sort((a, b) => (a.t ?? 9e9) - (b.t ?? 9e9));
    const pos = all.findIndex(a => a.n === 'PLAYER') + 1;
    orders.push(pos);
    console.log(String(seed).padEnd(4), '|', all.map(a => `${a.n}:${a.t === null ? 'DNF' : a.t.toFixed(1)}`).join('  ').padEnd(60), '| P' + pos);
    const L = race({ seed, throttleLock: true });
    const { rms, who } = closestPair(L.racers);
    if (rms < worstLock) { worstLock = rms; worstSeed = seed; worstPair = who; }
  }
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  console.log('means: easy', mean(byTier.easy).toFixed(2), 'medium', mean(byTier.medium).toFixed(2), 'hard', mean(byTier.hard).toFixed(2));
  console.log('boost presses/8 seeds:', JSON.stringify(bp));
  console.log('minSep', minSep.toFixed(3), 'maxLat', maxLat.toFixed(1), 'worst mean height above trough', worstH.toFixed(2));
  console.log('AI-14 locked worst', worstLock.toFixed(3), 'seed', worstSeed, worstPair);
  console.log('player positions:', orders.join(','));
}
