#!/usr/bin/env node
// ============================================================================
// Rivals / AI-racer gate runner — the OPERATIONAL DEFINITION of the AI gates.
// Pure node: drives the ACCEPTED physics on the REAL course against a candidate
// rivals module. The candidate never legitimately touches physics state: it
// returns INPUTS and nothing else (AI-01).
//
// usage: node harness/rival-runner.mjs --module sandbox/rivals/A/rivals.mjs [--out <json>]
//
// ---------------------------------------------------------------------------
// WHAT THIS RUNNER REFUSES TO DO, AND WHY
//
// 1. IT DOES NOT CONFINE THE RIVALS. src/run/run.mjs is read for the course
//    geometry — zStart / zFinish / halfWidth come from run.config, so there is
//    exactly one definition of the course — but it is NOT stepped on a rival.
//    Two reasons, both fatal if ignored:
//      * AI-04 measures whether the RIVAL stays in bounds. If the run module's
//        corridor were holding it in, AI-04 would pass by construction for
//        every module ever written: a vacuous gate of exactly the kind that let
//        ten rail modules score 12/12 while missing the property.
//      * AI-01 replays the recorded input stream through a fresh createPhysics.
//        That replay is exact only if NOTHING but ph.step touched the rival's
//        state during the recorded run. A confinement write would show up as
//        replay divergence and blame the candidate for the harness.
//    So a rival's state is written by exactly two things: physics, and (if it
//    cheats) the candidate. That is what makes AI-01 and AI-06 discriminating.
//
// 2. IT DOES NOT TRUST A SELF-REPORTED NUMBER. Every metric is measured off the
//    physics state the runner owns, or off the input objects the runner copied
//    before handing them to physics. No metric is read from a module-named
//    field: a module can rename a field and return `?? 0` from both sides of a
//    comparison, which is how a rails candidate reported dtSplitError = 0 while
//    its real error was 500x the threshold.
//
// 3. EVERY PROBE SWEEPS MORE THAN ONE OPERATING POINT. Single-point probes are
//    how ten modules faked the rails sheet. The matrix is 8 seeds x 4 rivals;
//    AI-01 replays all 40 tapes it produces; AI-05 runs three player scenarios
//    over all 8 seeds in both clauses; AI-11 runs two seeds twice with a fresh
//    module each time; AI-13 times a 4-rival and a 5-rival roster and grades
//    the worse one.
//
//    THIS IS NOT A THEORY. The first version of this runner replayed 3 of its
//    40 tapes for AI-01 and measured AI-05's size clause on one live seed. An
//    audit module that cheated only on the seeds those subsets skipped passed
//    all 13 gates. Every probe here now reads the whole matrix.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const modPath = resolve(ROOT, opt('module'));
const outPath = opt('out', null);

// --only AI-13[,AI-06] runs a SUBSET of the sheet. It exists for one reason:
// harness/rival-mutants.mjs has to run the whole runner once per mutant, and a
// mutant that burns CPU on purpose (the AI-13 one) costs minutes if it is made
// to drag every other gate's races along with it. It never changes how a gate
// is measured, and the default is the whole sheet.
const ONLY = (opt('only', null) ?? '').split(',').map(x => x.trim()).filter(Boolean);
const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'rivals' && g.tag !== 'RETIRED')
  .filter(g => ONLY.length === 0 || ONLY.includes(g.id));

const { createRivals } = await import(pathToFileURL(modPath).href);
const { createPhysics, DEFAULTS } = await import(pathToFileURL(resolve(ROOT, 'src/physics/physics.mjs')).href);
const { createRun } = await import(pathToFileURL(resolve(ROOT, 'src/run/run.mjs')).href);
// the real terrain: the same analytic sampler the renderer and the rig use
const { sampleHeight } = await import(pathToFileURL(resolve(ROOT, 'src/render/main.mjs')).href);

const DT = 1 / 60;
const wrapA = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

// ---------------------------------------------------------------------------
// THE COURSE CENTRELINE — identical construction to harness/run-runner.mjs, so
// the two lanes describe the same mountain. Lowest point across the corridor at
// each z, sampled every 10 m, box-smoothed, linearly interpolated. (The raw
// argmin STEPS 40 m near z = 762, where the gully has two near-equal minima; a
// staircase there would make AI-04 fire at riders who never moved.)
// ---------------------------------------------------------------------------
function rawCenterX(z) {
  let best = Infinity, bx = 0;
  for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } }
  return bx;
}
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => {
  const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1;
  const raw = new Array(n);
  for (let i = 0; i < n; i++) raw[i] = rawCenterX(CL_Z0 + i * CL_STEP);
  const sm = new Array(n);
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

// The course, from the ACCEPTED run module: if the run lane moves the finish
// line, this lane moves with it rather than disagreeing with it.
const BOUNDS = { zStart: 0, zFinish: 2400, halfWidth: 120, zBackstop: -80 };
const RUN_CFG = createRun({ sampleHeight, courseCenterX: centerX, bounds: BOUNDS }).config;
const Z_START = RUN_CFG.zStart, Z_FINISH = RUN_CFG.zFinish, HALF_W = RUN_CFG.halfWidth;

const physEnv = {
  sampleHeight,
  sampleNormal: (x, z) => {
    const d = 0.05;
    const dx = (sampleHeight(x + d, z) - sampleHeight(x - d, z)) / (2 * d);
    const dz = (sampleHeight(x, z + d) - sampleHeight(x, z - d)) / (2 * d);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  },
  surface: 'snow',
};

// ---------------------------------------------------------------------------
// THE REFERENCE PLAYER — a scripted MID-SKILL racer, defined ONCE and used by
// BOTH AI-07 and AI-08. The draft is explicit that it must be the same racer in
// both: "AI-07 and AI-08 must BOTH hold. Either alone is trivially satisfiable
// by making the AI uniformly slow or uniformly fast."
//
// Mid-skill means: default stats (20/20/20 — no stat advantage over a medium
// rival), a 120 m lookahead seeker, tuck plus boost once the run is under way,
// and a trick cadence that costs real time — a charge-and-pop every 14 s, which
// is what separates a player from a physics probe. Measured on the real course:
// 107.3 s over 2400 m.
//
// It is DELIBERATELY NOT TUNED against any candidate. Its constants are frozen
// here so a builder cannot move the bar by moving the player.
// ---------------------------------------------------------------------------
const PLAYER_STATS = { speed: 20, edging: 20, trick: 20 };
function seekSteer(st, tx, tz, gain = 1.8) {
  const want = Math.atan2(tz - st.pos[2], tx - st.pos[0]);
  return clamp(wrapA(want - st.heading) * gain, -1, 1);
}
function referencePlayerInput(t, st) {
  const tz = st.pos[2] + 120, tx = centerX(tz);
  const inp = { tuck: true, boost: t > 3, steer: seekSteer(st, tx, tz) };
  const cyc = t % 14;
  if (st.onGround) {
    if (cyc > 13.4 && cyc < 13.8) { inp.crouch = true; inp.tuck = false; }
    if (cyc >= 13.8 && cyc < 13.82) { inp.jumpRelease = true; inp.tuck = false; }
  } else {
    // NO AIR ROTATION. An earlier version spun on every airborne frame, the way
    // run-runner's probe drive does, and the reference player took 286.8 s over
    // a course a plain seeker rides in 107.3 s: it was landing crabbed and
    // eating the crash speed-keep over and over. A mid-skill racer lands its
    // jumps. Tricks belong to the trick lane, and the draft's second open
    // question defers rival tricking entirely.
    inp.tuck = false;
  }
  return inp;
}

// ---------------------------------------------------------------------------
// THE INPUT DOMAIN (AI-02) — exactly the shape the keyboard produces, per
// CONTRACTS.md. Anything else is a value the player could not have pressed.
// ---------------------------------------------------------------------------
const AXIS_KEYS = ['steer', 'spin', 'flip'];
const BOOL_KEYS = ['tuck', 'brake', 'crouch', 'jumpRelease', 'boost', 'grab'];
const INPUT_KEYS = new Set([...AXIS_KEYS, ...BOOL_KEYS, 'uber']);

// Returns { copy, violations }. The COPY is what physics is given and what the
// replay tape records, so a module that mutates its own returned object after
// the runner has looked at it changes nothing at all.
function sanitizeInput(raw, who) {
  if (raw === null || raw === undefined) return { copy: {}, violations: [] };
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { copy: {}, violations: [`${who}: input is not a plain object (${typeof raw})`] };
  const v = [], copy = {};
  for (const k of Object.keys(raw)) {
    const val = raw[k];
    if (!INPUT_KEYS.has(k)) { v.push(`${who}: unknown input key "${k}"`); continue; }
    if (AXIS_KEYS.includes(k)) {
      if (typeof val !== 'number' || !Number.isFinite(val)) { v.push(`${who}: ${k} is not a finite number (${val})`); continue; }
      if (val < -1 || val > 1) { v.push(`${who}: ${k} = ${val} outside [-1,1]`); continue; }
      copy[k] = val;
    } else if (k === 'uber') {
      if (val === 0) { copy[k] = 0; continue; }          // 0 / absent = no uber
      if (!Number.isInteger(val) || val < 1 || val > 6) { v.push(`${who}: uber = ${JSON.stringify(val)} outside 1..6`); continue; }
      copy[k] = val;
    } else {
      // BOOLEANS ACTUALLY BOOLEAN. `tuck: 3` is truthy and would work; it is
      // still a value the keyboard cannot produce, and the draft says so.
      if (typeof val !== 'boolean') { v.push(`${who}: ${k} = ${JSON.stringify(val)} is not a boolean`); continue; }
      copy[k] = val;
    }
  }
  return { copy, violations: v };
}

// ---------------------------------------------------------------------------
// TIER STATS. The module DECLARES per-tier rider stats in config.tiers and the
// RUNNER builds the physics with them — that is the "declared physics
// parameters" half of AI-06. The runner CLAMPS them to the contract's 0..40
// band, so an out-of-range declaration can never buy speed; it is reported in
// AI-02's side fields rather than graded, because burying a second silent gate
// inside another gate's counter is how a sheet stops being readable.
// ---------------------------------------------------------------------------
function tierStats(cfg, tier, report) {
  const raw = cfg?.tiers?.[tier]?.stats ?? {};
  const out = {};
  for (const k of ['speed', 'edging', 'trick']) {
    const v = Number.isFinite(raw[k]) ? raw[k] : 20;
    if (report && (v < 0 || v > 40)) report.push(`${tier}.${k} = ${v} outside 0..40 (clamped)`);
    out[k] = clamp(v, 0, 40);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ONE RACE.
//
// Frame order, and why it is this order:
//   1. snapshot every racer's pos/vel/heading                (the AI-06 watcher)
//   2. mod.step(rvs, world, dt) -> { id: input }             (the module's turn)
//   3. diff the snapshots: anything that moved is a DIRECT WRITE
//   4. sanitize + deep-copy each input, append it to the tape (AI-02 + AI-01)
//   5. ph.step(state, the copied input, dt) for every racer
//
// The module sees LIVE state on purpose. Handing it frozen copies would make
// AI-01 and AI-06 unfalsifiable: a module physically unable to cheat proves
// nothing at all about a module that would.
// ---------------------------------------------------------------------------
const ROSTER_4 = [
  { id: 'r1', tier: 'easy' },
  { id: 'r2', tier: 'easy' },
  { id: 'r3', tier: 'medium' },
  { id: 'r4', tier: 'hard' },
];
const ROSTER_5 = [...ROSTER_4, { id: 'r5', tier: 'medium' }];

// AI-10's two calibrated numbers, both measured on the honest baseline before
// they were written down (see the rides() probe for the measurements).
const CHARGED_POP_MIN = 0.25;   // fraction of T_CHARGE a release must carry to
                                // count as a POP rather than a twitch
const STARTUP_BUDGET_MS = 16.7; // AI-13: createRivals + init must fit in ONE
                                // 60 Hz frame, or the start gate drops a frame
const MAX_RACE_S = 400;      // ~3.7x the reference player's 107.3 s
const START_Z = 15;          // the stage line, just inside zStart
const GATE_SPACING = 5;      // m between stage slots — the START GATE has lanes,
                             // and it is the RUNNER that owns that geometry. A
                             // grid that stacks every racer on one point would
                             // hand AI-12 a separation of 0 on frame 1 and make
                             // it a gate about the harness.
const TRAJ_EVERY = 6;        // trajectory sample stride for AI-01 (10 Hz)

function spawnState(ph, x, z) {
  return ph.init([x, sampleHeight(x, z), z], [0, 0, 6], Math.PI / 2);
}

// ---------------------------------------------------------------------------
// THE STATE SNAPSHOT (AI-06's first instrument).
//
// It snapshots THE WHOLE STATE, not pos/vel/heading. An earlier version watched
// those seven numbers only, and an audit module walked straight through the
// sheet with them untouched: it wrote `self.boostMeter = 1` every frame and
// held the boost key down. 13/13 green, on a rival with an infinite meter.
// pos/vel/heading are what a cheat SPENDS; charge, boostMeter, onGround,
// airTime and landing are the resources it spends, and physics owns every one
// of them. A module writes inputs. It writes nothing else.
//
// Keys the module ADDS to the state are counted too — the diff sees them as
// appearing between the snapshot and the end of mod.step, and nothing but the
// module runs in that window.
// ---------------------------------------------------------------------------
function stateSnap(st) {
  const o = { pos: [st.pos[0], st.pos[1], st.pos[2]], vel: [st.vel[0], st.vel[1], st.vel[2]] };
  for (const k of Object.keys(st)) {
    if (k === 'pos' || k === 'vel') continue;
    const v = st[k], t = typeof v;
    if (t === 'number' || t === 'boolean' || t === 'string' || v === null) o[k] = v;
  }
  return o;
}
function snapDiff(a, st) {
  for (let i = 0; i < 3; i++) if (!Object.is(a.pos[i], st.pos[i])) return `pos[${i}]`;
  for (let i = 0; i < 3; i++) if (!Object.is(a.vel[i], st.vel[i])) return `vel[${i}]`;
  for (const k of Object.keys(a)) { if (k === 'pos' || k === 'vel') continue; if (!Object.is(a[k], st[k])) return k; }
  for (const k of Object.keys(st)) if (!(k in a) && k !== 'pos' && k !== 'vel') return `+${k}`;
  return null;
}

// ---------------------------------------------------------------------------
// THE ASSIGNMENT WATCHER (AI-06's second instrument).
//
// The per-frame snapshot diff compares VALUES, and a value diff cannot see a
// write that lands back where it started. The rails lane learned this the hard
// way: `const s = ps.spinDeg; ps.spinDeg = s + 999; ps.spinDeg = s;` scored a
// clean 0 against a differ and was only caught once GR-11 counted SETS through
// an accessor. The same hole exists here, and the same instrument closes it.
//
// Accessors on pos[0..2], vel[0..2] and EVERY scalar field the state carries
// after init (heading, charge, boostMeter, onGround, airTime, landing, ...)
// count every ASSIGNMENT made while COUNTING is on — which is only during
// mod.step. Physics writes those fields constantly on its own tick and is never
// counted.
//
// KNOWN LIMIT, stated rather than implied: this sees assignment to the watched
// slots only. A module that replaced the whole `pos` array (st.pos = [...])
// would drop the accessors instead of tripping them — the snapshot diff catches
// that case, which is why BOTH instruments are kept.
//
// It is not on in the matrix races: property accessors on the physics hot path
// cost real time, and AI-13 times the module. Two dedicated races carry it.
// ---------------------------------------------------------------------------
let COUNTING = false;
function installWriteWatch(st, bump) {
  for (const arr of [st.pos, st.vel]) {
    for (let i = 0; i < 3; i++) {
      let v = arr[i];
      Object.defineProperty(arr, i, { configurable: true, enumerable: true,
        get() { return v; }, set(nv) { if (COUNTING) bump(); v = nv; } });
    }
  }
  for (const k of Object.keys(st)) {
    if (k === 'pos' || k === 'vel') continue;
    const v0 = st[k], t = typeof v0;
    if (!(t === 'number' || t === 'boolean' || t === 'string' || v0 === null)) continue;
    let v = v0;
    Object.defineProperty(st, k, { configurable: true, enumerable: true,
      get() { return v; }, set(nv) { if (COUNTING) bump(); v = nv; } });
  }
}

// Player scenarios:
//   'reference'    the scripted mid-skill racer (AI-07 / AI-08 / AI-09 / AI-12)
//   'frozenBehind' parked 200 m up-course, never stepped: every rival LEADS
//   'frozenAhead'  parked on the finish line, never stepped: every rival TRAILS
function makePlayer(kind) {
  const ph = createPhysics(physEnv, { stats: PLAYER_STATS });
  if (kind === 'frozenBehind') { const z = Z_START - 200; return { ph, st: spawnState(ph, centerX(z), z), driven: false }; }
  if (kind === 'frozenAhead') { const z = Z_FINISH; return { ph, st: spawnState(ph, centerX(z), z), driven: false }; }
  return { ph, st: spawnState(ph, centerX(START_Z), START_Z), driven: true };
}

function race({ seed, roster = ROSTER_4, assist = true, player = 'reference',
  maxTime = MAX_RACE_S, timeModule = false, watchWrites = false,
  throttleLock = false } = {}) {
  const statNotes = [];
  const env = {
    sampleHeight,
    courseCenterX: centerX,
    bounds: { zStart: Z_START, zFinish: Z_FINISH, halfWidth: HALF_W },
    roster: roster.map(r => ({ ...r })),
    seed,
    assist,
  };
  // THE START-GATE HITCH. createRivals + init are the module's other cost and
  // the frame timer never sees them: an audit module that precomputed its race
  // plan in init() burned 250 ms there and reported 0.0009 ms/frame. Timed here,
  // graded by AI-13.
  const _t0init = process.hrtime.bigint();
  const mod = createRivals(env);
  const cfg = mod.config ?? {};
  const rvs = mod.init();
  const startupMs = Number(process.hrtime.bigint() - _t0init) / 1e6;

  const P = makePlayer(player);
  // Under the throttle lock the START GATE is collapsed too: every rival is
  // spawned at the same x. The 5 m gate pitch is not a line choice, and leaving
  // it in charges a module for a difference the harness handed it — measured,
  // it was most of the one-line train's residual (2.36 m of "line difference"
  // for a field driving one path). Rivals may overlap at t=0 here; AI-12 grades
  // separation on the live matrix, which keeps its real gate.
  const spacing = throttleLock ? 0 : GATE_SPACING;
  const gate0 = centerX(START_Z) - ((roster.length - 1) / 2) * spacing;
  const racers = roster.map((r, i) => {
    // THROTTLE LOCK (AI-14). Every rival gets the SAME stats and, below, has
    // its boost/brake/uber discarded and its tuck pinned. Without this a rider
    // that is merely faster shows a different track through seeker lag alone,
    // and four candidate line metrics all turned out to be reading that lag
    // rather than any decision the module made.
    const stats = throttleLock ? { ...PLAYER_STATS } : tierStats(cfg, r.tier, statNotes);
    const ph = createPhysics(physEnv, { stats });
    const st = spawnState(ph, gate0 + i * spacing, START_Z);
    return { id: r.id, tier: r.tier, ph, st, stats,
      init: { pos: [...st.pos], vel: [...st.vel], heading: st.heading },
      tape: [], traj: [], finishT: null, finished: false,
      maxOob: 0, maxLat: 0, airborne_s: 0, pops: 0, chargedPops: 0, bestCharge: 0,
      latSum: 0, latSq: 0, latN: 0, writeFields: [], line: [],
      moduleWriteFrames: 0, overCapFrames: 0, overRun: 0, maxSpeed: 0, _inp: {} };
  });
  const byId = Object.fromEntries(racers.map(r => [r.id, r]));

  let playerFinishT = null, playerWriteFrames = 0, assignWrites = 0;
  const playerWriteFields = [];
  if (watchWrites) {
    for (const r of racers) installWriteWatch(r.st, () => assignWrites++);
    installWriteWatch(P.st, () => assignWrites++);
  }
  let minSep = Infinity, closeRun_s = 0, worstCloseRun_s = 0;
  const domainViolations = [];
  let modMs = 0, modFrames = 0, modMaxMs = 0;
  const modSamples = [];

  const n = Math.round(maxTime / DT);
  for (let i = 0; i < n; i++) {
    const t = i * DT;

    // ---- 1. snapshot (the AI-06 watcher) ---------------------------------
    const snap = racers.map(r => stateSnap(r.st));
    const psnap = stateSnap(P.st);

    // ---- 2. the module's only turn ---------------------------------------
    const world = { t, dt: DT, player: P.st,
      rivals: Object.fromEntries(racers.map(r => [r.id, r.st])) };
    let raw;
    COUNTING = watchWrites;
    if (timeModule) {
      const t0 = process.hrtime.bigint();
      raw = mod.step(rvs, world, DT);
      // MATERIALISE INSIDE THE TIMER. sanitizeInput reads these keys outside
      // the timed window, so a module that returned inputs whose GETTERS burn
      // CPU had its whole cost billed to the harness — measured 0.0011 ms/frame
      // for a module doing 400k sqrt per rival per frame. Reading them here
      // puts that cost back where it belongs.
      if (raw && typeof raw === 'object') {
        for (const k of Object.keys(raw)) {
          const o = raw[k];
          if (o && typeof o === 'object') for (const kk of Object.keys(o)) void o[kk];
        }
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      modMs += ms; modFrames++; modMaxMs = Math.max(modMaxMs, ms); modSamples.push(ms);
    } else {
      raw = mod.step(rvs, world, DT);
    }
    COUNTING = false;

    // ---- 3. did the module write physics state? --------------------------
    for (let k = 0; k < racers.length; k++) {
      const r = racers[k];
      const which = snapDiff(snap[k], r.st);
      if (which !== null) {
        r.moduleWriteFrames++;
        if (!r.writeFields.includes(which)) r.writeFields.push(which);
      }
    }
    // A module that SLOWS THE PLAYER cheats in exactly the same way, and it is
    // the cheat a rivals lane is most tempted by. Counted separately so the
    // report says which of the two it was.
    { const which = snapDiff(psnap, P.st);
      if (which !== null) { playerWriteFrames++; if (!playerWriteFields.includes(which)) playerWriteFields.push(which); } }

    // ---- 4. sanitize, copy, record ---------------------------------------
    const isMap = raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw);
    if (raw !== null && raw !== undefined && !isMap)
      domainViolations.push(`step() returned ${typeof raw}, not a { id: input } map`);
    const table = isMap ? raw : {};
    for (const k of Object.keys(table))
      if (!byId[k]) domainViolations.push(`unknown rival id "${k}" in the input map`);
    for (const r of racers) {
      const { copy, violations } = sanitizeInput(table[r.id], `${r.id}@t=${t.toFixed(3)}`);
      if (violations.length) domainViolations.push(...violations);
      if (throttleLock) {
        // tuck is a throttle too — it is the aero channel — so it is pinned to
        // one schedule for the whole field rather than left to the module.
        copy.boost = false; copy.brake = false; copy.uber = false;
        copy.tuck = !copy.crouch;
      }
      r.tape.push(copy);
      r._inp = copy;
    }

    // ---- 5. step everyone ------------------------------------------------
    for (const r of racers) {
      const wasDone = r.finished;
      // A POP IS A CHARGED POP. Counting jumpRelease frames alone made AI-10's
      // air clause satisfiable by a rider that twitches the key: charge 0 gives
      // J_MIN = 2.1 m/s, about 0.22 m of hop, which is not "riding the kickers"
      // by any reading. `charge` is written by physics from the module's own
      // crouch inputs and the module may not touch it (AI-06), so this is the
      // rival's own doing, measured off harness-owned state.
      if (!wasDone && r._inp.jumpRelease && r.st.onGround) {
        r.pops++;
        r.bestCharge = Math.max(r.bestCharge, r.st.charge ?? 0);
        if ((r.st.charge ?? 0) >= CHARGED_POP_MIN) r.chargedPops++;
      }
      r.ph.step(r.st, r._inp, DT);
      if (i % TRAJ_EVERY === 0) r.traj.push(r.st.pos[0], r.st.pos[1], r.st.pos[2]);
      if (wasDone) continue;                      // metrics measure the RUN, not the run-out
      // CROSSING THE LINE IS NOT AN EXCURSION. One 60 Hz frame at 26 m/s lands
      // the rider up to 0.44 m past zFinish, and an earlier version of this loop
      // charged that overshoot to AI-04 — the honest baseline failed a bounds
      // gate for finishing the race.
      if (r.st.pos[2] >= Z_FINISH) { r.finished = true; r.finishT = t; continue; }
      if (!r.st.onGround) r.airborne_s += DT;
      // HORIZONTAL speed against V_CAP, and only when it is SUSTAINED.
      //
      // Two measured facts shape this. (1) The accepted physics clamps the 3-D
      // velocity on the ground and leaves the airborne trajectory ballistic, so
      // a long fall legitimately puts the 3-D magnitude above V_CAP — 38.3 m/s
      // on the honest baseline. The cap governs horizontal speed, which airStep
      // never touches. (2) Even horizontally, the magnitude-preserving landing
      // redirect can hand a frame up to ~2.1 m/s over the cap before capVel
      // pulls it back on the NEXT tick: measured on the honest baseline, the
      // longest such excursion is ONE frame, on 9 frames out of ~700k.
      // So the counter starts at the third consecutive frame. A landing
      // transient is one frame; a speed a module granted itself has to be
      // ridden off through the drag law and lasts for seconds.
      const sp = Math.hypot(r.st.vel[0], r.st.vel[2]);
      r.maxSpeed = Math.max(r.maxSpeed, sp);
      if (sp > DEFAULTS.V_CAP + 1e-6) { r.overRun++; if (r.overRun >= 3) r.overCapFrames++; }
      else r.overRun = 0;
      const s = r.st.pos[0] - centerX(r.st.pos[2]);
      r.latSum += s; r.latSq += s * s; r.latN++;
      // AI-14 raw material: lateral offset against z, flat [z, s, z, s, ...].
      // Keyed on z and NOT on time deliberately — two riders at the same instant
      // are at different points on the mountain, so comparing them compares
      // progress, not line.
      if (i % TRAJ_EVERY === 0) { r.line.push(r.st.pos[2], s); }
      r.maxLat = Math.max(r.maxLat, Math.abs(s));
      r.maxOob = Math.max(r.maxOob, Math.abs(s) - HALF_W, Z_START - r.st.pos[2]);
    }
    if (P.driven) {
      P.ph.step(P.st, referencePlayerInput(t, P.st), DT);
      if (playerFinishT === null && P.st.pos[2] >= Z_FINISH) playerFinishT = t;
    }

    // ---- separation telemetry (AI-12) ------------------------------------
    // Only while both parties are still RACING: two riders on the run-out past
    // the finish are not competitors any more, and counting them would make the
    // gate a statement about the apron.
    if (P.driven) {
      const live = racers.filter(r => !r.finished).map(r => r.st.pos);
      const pts = playerFinishT === null ? [...live, P.st.pos] : live;
      for (let a = 0; a < pts.length; a++)
        for (let b = a + 1; b < pts.length; b++)
          minSep = Math.min(minSep, Math.hypot(pts[a][0] - pts[b][0],
            pts[a][1] - pts[b][1], pts[a][2] - pts[b][2]));
      const near = playerFinishT === null && racers.some(r => !r.finished
        && Math.hypot(r.st.pos[0] - P.st.pos[0], r.st.pos[1] - P.st.pos[1],
          r.st.pos[2] - P.st.pos[2]) < 1.0);
      closeRun_s = near ? closeRun_s + DT : 0;
      worstCloseRun_s = Math.max(worstCloseRun_s, closeRun_s);
    }

    if (racers.every(r => r.finished) && (!P.driven || playerFinishT !== null)) break;
  }

  const sorted = modSamples.slice().sort((a, b) => a - b);
  return {
    seed, assist, player, racers, byId, playerFinishT, playerWriteFrames, assignWrites,
    playerWriteFields, startupMs, statNotes, domainViolations, cfg,
    minSep: minSep === Infinity ? null : minSep,
    worstCloseRun_s,
    perf: modFrames ? { meanMs: modMs / modFrames, maxMs: modMaxMs,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p99: sorted[Math.floor(sorted.length * 0.99)], frames: modFrames } : null,
  };
}

// ---------------------------------------------------------------------------
// CACHE. The 8-seed matrix is the workhorse — nine of the thirteen gates read
// it — so it is computed once. A full course at 60 Hz is ~6400 frames and a
// five-racer race costs tens of milliseconds, which is what keeps this sheet
// affordable inside npm test.
// ---------------------------------------------------------------------------
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const _cache = new Map();
const cachedRace = (o) => {
  const k = JSON.stringify([o.seed, o.assist ?? true, o.player ?? 'reference',
    (o.roster ?? ROSTER_4).length, o.timeModule ?? false]);
  if (!_cache.has(k)) _cache.set(k, race(o));
  return _cache.get(k);
};
const matrix = () => SEEDS.map(seed => cachedRace({ seed }));
const lockedMatrix = () => SEEDS.map(seed => cachedRace({ seed, throttleLock: true }));

// ---------------------------------------------------------------------------
// AI-14: DE-LANED LINE DISTANCE.
//
// The question is "do any two rivals ride the same line", so it is measured
// directly: resample each rival's lateral offset onto a shared z grid, subtract
// that rival's own mean — which is its LANE, not its line — and take the RMS
// difference between every pair. The metric is the CLOSEST pair, because one
// duplicated line is enough to fail.
//
// De-meaning is what makes it a line measurement. Raw lateral separation is so
// dominated by lane pitch that it INVERTS: a field of four genuinely different
// lines measured 5.4-7.3 m apart while a one-line train with 9 m lane offsets
// measured 14.6-19.4 m, so a gate reading raw separation would rank the train
// above the real thing.
//
// TWO EARLIER METRICS WERE BUILT HERE AND THROWN AWAY, both on measurement
// against the train mutant, and both are worth not re-attempting:
//   - a signed corner-bias index, de-meaned and sign-corrected by curvature.
//     The train scored 2.09 against a 1.0 threshold — the gate passing its own
//     mutant — because a rider parked 13.5 m off-centre rides a different-
//     RADIUS path through the same corner and its tracking lag reads as bias.
//   - the same index with the lane regressed out across the field. Train 1.78
//     against an honest baseline 1.55: four riders and two fitted parameters is
//     mostly fit noise.
// ---------------------------------------------------------------------------
const GRID_Z0 = 100, GRID_Z1 = 2300, GRID_STEP = 10;
function laneProfile(rv) {
  const b = rv.line;                       // flat [z, s, ...], z increasing
  const out = new Float64Array(Math.floor((GRID_Z1 - GRID_Z0) / GRID_STEP) + 1);
  if (b.length < 4) return out;
  let j = 0, sum = 0;
  for (let g = 0; g < out.length; g++) {
    const z = GRID_Z0 + g * GRID_STEP;
    while (j + 3 < b.length && b[j + 2] <= z) j += 2;
    let v;
    if (z <= b[0]) v = b[1];
    else if (z >= b[b.length - 2]) v = b[b.length - 1];
    else { const t = (z - b[j]) / Math.max(1e-9, b[j + 2] - b[j]);
           v = b[j + 1] * (1 - t) + b[j + 3] * t; }
    out[g] = v; sum += v;
  }
  const m = sum / out.length;
  for (let g = 0; g < out.length; g++) out[g] -= m;   // strip the lane
  return out;
}
function closestLinePair(racers) {
  const prof = racers.map(rv => ({ id: rv.id, p: laneProfile(rv) }));
  let best = Infinity, who = null;
  for (let i = 0; i < prof.length; i++) for (let k = i + 1; k < prof.length; k++) {
    let acc = 0;
    for (let g = 0; g < prof[i].p.length; g++) {
      const d = prof[i].p[g] - prof[k].p[g]; acc += d * d;
    }
    const rms = Math.sqrt(acc / prof[i].p.length);
    if (rms < best) { best = rms; who = `${prof[i].id}/${prof[k].id}`; }
  }
  return { rms: best, who };
}

// Exact frame-by-frame stream comparison, on the COPIES physics was handed.
const tapeKey = tape => JSON.stringify(tape.map(f => {
  const o = {};
  for (const k of Object.keys(f).sort()) o[k] = f[k];
  return o;
}));

// ---------------------------------------------------------------------------
// THE PROBES
// ---------------------------------------------------------------------------
const impl = {

  // AI-01 — replay each recorded input stream through a FRESH createPhysics and
  // compare trajectories. For an honest module this is exactly 0, not 1e-9:
  // physics is pure, the env is shared, the stats are the same declaration, and
  // the recorded input is the very object physics was handed. The comparison is
  // over the whole sampled trajectory, not only the endpoint — a cheat that
  // pushes the rival off line and then rejoins it would leave a small endpoint
  // error and a large mid-course one.
  replay() {
    // EVERY RACE, not three of them. With three, a module that cheated only on
    // the seeds this list left out replayed exactly and scored 0.0 — the
    // single-operating-point failure this runner's own header warns about,
    // committed by the gate that matters most. 8 seeds x 4 rivals + both frozen
    // scenarios = 40 tapes.
    const runs = [...matrix(), cachedRace({ seed: 1, player: 'frozenAhead' }),
      cachedRace({ seed: 1, player: 'frozenBehind' })];
    let worst = 0, who = null;
    const rows = [];
    for (const r of runs) for (const rv of r.racers) {
      const ph = createPhysics(physEnv, { stats: tierStats(r.cfg, rv.tier, null) });
      const st = ph.init([...rv.init.pos], [...rv.init.vel], rv.init.heading);
      let err = 0, k = 0, replayFinishT = null;
      for (let i = 0; i < rv.tape.length; i++) {
        ph.step(st, rv.tape[i], DT);
        if (replayFinishT === null && st.pos[2] >= Z_FINISH) replayFinishT = i * DT;
        if (i % TRAJ_EVERY === 0) {
          err = Math.max(err, Math.hypot(st.pos[0] - rv.traj[k], st.pos[1] - rv.traj[k + 1],
            st.pos[2] - rv.traj[k + 2]));
          k += 3;
        }
      }
      const dtFin = (rv.finishT !== null && replayFinishT !== null)
        ? Math.abs(rv.finishT - replayFinishT) : null;
      rows.push({ seed: r.seed, player: r.player, id: rv.id, err: +err.toFixed(9), dtFinish_s: dtFin });
      if (err > worst) { worst = err; who = `${rv.id}@seed${r.seed}/${r.player}`; }
    }
    return { inputReplayError_m: +worst.toFixed(9), _worst: who ?? 'none (every replay exact)',
      _rows: rows.slice(0, 8), _tapesReplayed: rows.length };
  },

  // AI-02 — every input object, every frame, every rival, over the whole matrix
  // PLUS both frozen-player scenarios. A module that only reaches for an
  // illegal value while rubber-banding is invisible in the matrix alone.
  domain() {
    const runs = [...matrix(), cachedRace({ seed: 1, player: 'frozenAhead' }),
      cachedRace({ seed: 1, player: 'frozenBehind' })];
    const all = runs.flatMap(r => r.domainViolations);
    const frames = runs.reduce((s, r) => s + r.racers.reduce((q, x) => q + x.tape.length, 0), 0);
    return { outOfDomainInputs: all.length, _first: all.slice(0, 6),
      _inputsChecked: frames, _runsChecked: runs.length,
      _statNotes: [...new Set(runs.flatMap(r => r.statNotes))].slice(0, 6) };
  },

  // AI-03 — 8 seeds x 4 rivals = 32 runs, every one must reach zFinish.
  finish() {
    const runs = matrix();
    let ok = 0, tot = 0;
    const stuck = [];
    for (const r of runs) for (const rv of r.racers) {
      tot++;
      if (rv.finished) ok++;
      else stuck.push({ seed: r.seed, id: rv.id, tier: rv.tier, z: +rv.st.pos[2].toFixed(1) });
    }
    const times = runs.flatMap(r => r.racers.filter(x => x.finished).map(x => x.finishT));
    return { finishRate: tot ? ok / tot : 0, _runs: tot, _finished: ok,
      _stuck: stuck.slice(0, 6),
      _slowest_s: times.length ? +Math.max(...times).toFixed(2) : null,
      _fastest_s: times.length ? +Math.min(...times).toFixed(2) : null };
  },

  // AI-04 — worst excursion beyond the corridor over the SAME 32 runs. Nothing
  // confines a rival in this harness, so this measures the module and only the
  // module (see the header).
  //
  // READ _widestLine_m ALONGSIDE THE VERDICT. maxOutOfBounds_m is a cliff: it
  // is 0 until a rider crosses the wall and then it is not. _widestLine_m is
  // how close the module actually came, and it is the number that says whether
  // a pass had margin. The honest baseline reaches 101.5 m against a half-width
  // of 120 — a real pass with 18.5 m to spare, and not a knife edge, since it
  // reproduces across all 32 runs. A candidate reporting 119 m is passing this
  // gate and is one bad landing from failing it.
  bounds() {
    const runs = matrix();
    let worst = 0, who = null, widest = 0;
    for (const r of runs) for (const rv of r.racers) {
      widest = Math.max(widest, rv.maxLat);
      if (rv.maxOob > worst) { worst = rv.maxOob; who = `${rv.id}@seed${r.seed}`; }
    }
    return { maxOutOfBounds_m: +Math.max(0, worst).toFixed(4), _worstAt: who,
      _halfWidth_m: HALF_W, _runs: runs.length * ROSTER_4.length,
      _widestLine_m: +widest.toFixed(2) };
  },

  // AI-05 — TWO clauses, both measured.
  //
  // SIGN. In 'frozenBehind' the player is parked 200 m up-course, so every
  // rival LEADS on every frame. Assistance must therefore be off, and the input
  // streams with assist ON and with assist FORCED OFF must be BYTE-IDENTICAL.
  // That is an exact test with no state divergence to reason about, and it is
  // what catches "apply catch-up while ahead" — which a finish-time ratio
  // cannot see at all.
  //
  // SIZE. In 'frozenAhead' the player is parked on the finish line, so every
  // rival TRAILS on every frame and assistance runs at its maximum. The ratio
  // is taken BOTH WAYS, max(off/on, on/off), because "assisted / unassisted"
  // read literally is satisfied by any module whose assistance actually helps —
  // which is every module, which is a gate that passes by construction.
  rubber() {
    const sign = [];
    for (const seed of SEEDS) {
      const on = cachedRace({ seed, player: 'frozenBehind', assist: true });
      const off = cachedRace({ seed, player: 'frozenBehind', assist: false });
      for (const rv of on.racers) {
        const A = rv.tape, B = off.byId[rv.id].tape;
        if (tapeKey(A) === tapeKey(B)) continue;
        let f = 0;
        while (f < A.length && f < B.length && JSON.stringify(A[f]) === JSON.stringify(B[f])) f++;
        sign.push({ seed, id: rv.id, divergeFrame: f, t: +(f * DT).toFixed(3) });
      }
    }
    let worst = 0;
    const rows = [];
    // ALL EIGHT SEEDS LIVE, not one. The earlier version measured the size
    // clause on seed 3 and on two frozenAhead races; a module that rubber-banded
    // hard on the other seeds and behaved on those three reported 1.08.
    const pairs = [
      ...[1, 2].map(seed => [cachedRace({ seed, player: 'frozenAhead', assist: true }),
        cachedRace({ seed, player: 'frozenAhead', assist: false })]),
      ...SEEDS.map(seed => [cachedRace({ seed }), cachedRace({ seed, assist: false })]),
    ];
    for (const [on, off] of pairs) for (const rv of on.racers) {
      const o = off.byId[rv.id];
      if (!rv.finished || !o.finished) {
        rows.push({ seed: on.seed, player: on.player, id: rv.id, ratio: null, _why: 'did not finish' });
        worst = Infinity; continue;
      }
      const ratio = Math.max(o.finishT / rv.finishT, rv.finishT / o.finishT);
      rows.push({ seed: on.seed, player: on.player, id: rv.id, tier: rv.tier,
        on: +rv.finishT.toFixed(2), off: +o.finishT.toFixed(2), ratio: +ratio.toFixed(4) });
      worst = Math.max(worst, ratio);
    }
    // The sign clause folds into the graded number: a module that assists while
    // leading has catch-up that is not bounded in the direction that matters,
    // and reporting it as a healthy 1.04 would be a lie about the same module.
    return { rubberBandRatio: sign.length ? 999 : +worst.toFixed(4),
      _assistWhileLeadingCount: sign.length, _assistWhileLeading: sign.slice(0, 6),
      _sizeWorstRatio: +worst.toFixed(4), _rows: rows.slice(0, 8) };
  },

  // AI-06 — catch-up must be spent through inputs or declared stats, never
  // granted. Two counters, summed:
  //   * frames where the module itself changed a rival's — or the PLAYER's —
  //     pos/vel/heading between physics steps: a raw grant, which is exactly
  //     the "+8 m/s when behind" mutant, caught on the frame it happens;
  //   * frames where a rival's speed exceeded V_CAP, which the accepted physics
  //     clamps and therefore cannot produce by riding.
  // This is NOT a duplicate of AI-01. AI-01 sees a cheat as metres of
  // divergence after it has had time to grow; a grant that is later cancelled
  // leaves almost no replay error and still shows up here as frames.
  speed() {
    const runs = [...matrix(), cachedRace({ seed: 1, player: 'frozenAhead' }),
      cachedRace({ seed: 1, player: 'frozenBehind' })];
    let writes = 0, over = 0, pwrite = 0, top = 0;
    const fields = new Set();
    for (const r of runs) {
      pwrite += r.playerWriteFrames;
      for (const f of r.playerWriteFields) fields.add('player.' + f);
      for (const rv of r.racers) {
        writes += rv.moduleWriteFrames; over += rv.overCapFrames;
        for (const f of rv.writeFields) fields.add(f);
        top = Math.max(top, rv.maxSpeed);
      }
    }
    // The third instrument: ASSIGNMENTS, not value changes. Two dedicated races
    // (uncached — the accessors change the timing the perf gate reads) at two
    // operating points: one where the rivals race a live player and one where
    // they trail a parked player and catch-up is at full stretch.
    const watched = [race({ seed: 1, watchWrites: true }),
      race({ seed: 2, player: 'frozenAhead', watchWrites: true })];
    const assigns = watched.reduce((s, r) => s + r.assignWrites, 0);
    return { impossibleSpeedFrames: writes + over + pwrite + assigns,
      _stateFieldsWritten: [...fields].slice(0, 8),
      _rivalStateWriteFrames: writes, _playerStateWriteFrames: pwrite,
      _stateAssignmentsDuringStep: assigns,
      _sustainedOverCapFrames: over, _topHorizSpeed_mps: +top.toFixed(3),
      _vCap_mps: DEFAULTS.V_CAP };
  },

  // AI-07 — the reference player finishes ahead of EVERY easy rival on EVERY
  // one of the 8 seeds. "Across 8 seeds" read as "on all of them": a gate that
  // only asks for one good seed is a gate you re-run until green.
  easyTier() {
    const runs = matrix();
    const rows = [];
    let ok = 1;
    for (const r of runs) {
      if (r.playerFinishT === null) { ok = 0; rows.push({ seed: r.seed, _why: 'player never finished' }); continue; }
      for (const rv of r.racers.filter(x => x.tier === 'easy')) {
        const beat = rv.finished ? r.playerFinishT < rv.finishT : true;
        if (!beat) ok = 0;
        rows.push({ seed: r.seed, id: rv.id, player: +r.playerFinishT.toFixed(2),
          rival: rv.finished ? +rv.finishT.toFixed(2) : null, beat });
      }
    }
    const pm = mean(runs.map(r => r.playerFinishT).filter(Number.isFinite));
    return { easyTierBeaten: ok, _playerMean_s: +pm.toFixed(2),
      _worstMargin_s: +Math.min(...rows.filter(x => x.rival !== null && x.rival !== undefined)
        .map(x => x.rival - x.player)).toFixed(2),
      _rows: rows.filter(x => !x.beat).slice(0, 6) };
  },

  // AI-08 — the SAME reference player finishes BEHIND at least one hard rival,
  // on every seed. Same racer as AI-07 by construction: one function, one stat
  // block, defined once at the top of this file.
  hardTier() {
    const runs = matrix();
    const rows = [];
    let ok = 1;
    for (const r of runs) {
      if (r.playerFinishT === null) { ok = 0; rows.push({ seed: r.seed, _why: 'player never finished' }); continue; }
      const hard = r.racers.filter(x => x.tier === 'hard' && x.finished);
      const best = hard.length ? Math.min(...hard.map(x => x.finishT)) : null;
      const wins = best !== null && best < r.playerFinishT;
      if (!wins) ok = 0;
      rows.push({ seed: r.seed, player: +r.playerFinishT.toFixed(2),
        bestHard: best === null ? null : +best.toFixed(2), wins });
    }
    return { hardTierWins: ok, _rows: rows };
  },

  // AI-09 — mean finish time easy > medium > hard, every gap at least 3% of the
  // course time. The denominator is the REFERENCE PLAYER's mean time, not any
  // rival's: a module cannot shrink the yardstick to inflate its own separation.
  tiers() {
    const runs = matrix();
    const by = { easy: [], medium: [], hard: [] };
    for (const r of runs) for (const rv of r.racers) if (rv.finished) by[rv.tier].push(rv.finishT);
    const m = { easy: mean(by.easy), medium: mean(by.medium), hard: mean(by.hard) };
    const course = mean(runs.map(r => r.playerFinishT).filter(Number.isFinite));
    if (!Number.isFinite(course) || !Object.values(m).every(Number.isFinite))
      return { tierSeparationFrac: -1, _why: 'a tier or the player never finished',
        _means_s: m, _n: { easy: by.easy.length, medium: by.medium.length, hard: by.hard.length } };
    const gapEM = (m.easy - m.medium) / course, gapMH = (m.medium - m.hard) / course;
    return { tierSeparationFrac: +Math.min(gapEM, gapMH).toFixed(4),
      _means_s: { easy: +m.easy.toFixed(2), medium: +m.medium.toFixed(2), hard: +m.hard.toFixed(2) },
      _courseTime_s: +course.toFixed(2),
      _gapEasyMedium: +gapEM.toFixed(4), _gapMediumHard: +gapMH.toFixed(4),
      _n: { easy: by.easy.length, medium: by.medium.length, hard: by.hard.length } };
  },

  // AI-10 — PRESENCE of both behaviours, on all 32 runs, so it cannot pass by
  // absence.
  //   AIR:  total airborne time >= 1.5 s AND at least 3 CHARGED pops. The pop
  //         count is not decoration. MEASURED: this terrain hands the reference
  //         player 35.6 s of air over a run in which it presses jump seven times
  //         and would still collect ~30 s if it never pressed it at all. So the
  //         airtime clause ALONE is satisfied by a rider that never leaves the
  //         ground on purpose. And counting bare jumpRelease frames was not
  //         enough either: an audit module that twitched the key every 2 s with
  //         no crouch behind it scored 22 pops and passed. A release at charge 0
  //         is J_MIN = 2.1 m/s, ~0.22 m of hop. So a pop must carry charge >=
  //         0.25 (the honest baseline's 0.35 s crouch carries 0.41).
  //   LINE: the lateral track must VARY, not merely sit off centre. RMS from the
  //         centreline >= 2 m is satisfied by a rider welded to a line 4 m out —
  //         which is the moving cone this gate exists to reject, just parked in a
  //         different place. So the graded number is the STANDARD DEVIATION of
  //         the rival's own lateral offset about its own mean, >= 2 m. MEASURED:
  //         honest baseline 8.5 m worst case, a cone pinned to a fixed lane
  //         1.9 m — and that residual is the seeker's own lag, not a chosen line.
  rides() {
    const runs = matrix();
    let ok = 1, worstAir = Infinity, worstRms = Infinity, worstPops = Infinity;
    const rows = [];
    let worstStd = Infinity, bestCharge = 0;
    for (const r of runs) for (const rv of r.racers) {
      const n = Math.max(1, rv.latN);
      const rms = Math.sqrt(rv.latSq / n);
      const std = Math.sqrt(Math.max(0, rv.latSq / n - (rv.latSum / n) ** 2));
      const airOk = rv.airborne_s >= 1.5 && rv.chargedPops >= 3;
      const lineOk = std >= 2;
      worstAir = Math.min(worstAir, rv.airborne_s);
      worstRms = Math.min(worstRms, rms);
      worstStd = Math.min(worstStd, std);
      worstPops = Math.min(worstPops, rv.chargedPops);
      bestCharge = Math.max(bestCharge, rv.bestCharge);
      if (!(airOk && lineOk)) { ok = 0; rows.push({ seed: r.seed, id: rv.id,
        air_s: +rv.airborne_s.toFixed(2), chargedPops: rv.chargedPops, pops: rv.pops,
        latStd_m: +std.toFixed(2), latRms_m: +rms.toFixed(2) }); }
    }
    return { ridesLikeARider: ok, _minAir_s: +worstAir.toFixed(2),
      _minChargedPops: worstPops, _minLatStd_m: +worstStd.toFixed(2),
      _minLatRms_m: +worstRms.toFixed(2), _bestPopCharge: +bestCharge.toFixed(3),
      _chargedPopMin: CHARGED_POP_MIN, _failures: rows.slice(0, 6) };
  },

  // AI-14 — DO THE RIVALS RIDE LINES OF THEIR OWN? The gap two blind cycles
  // died on, and the one property the other twelve gates cannot see: a module
  // driving ONE shared line, phased on z so the path is byte-identical for all
  // four riders, with constant 9 m lane offsets and tiers separated by throttle
  // alone, scores 13/13 with hardFails 0 on the sheet without this gate.
  //
  // Graded with the throttle channel locked out, so what is left is where a
  // rider CHOSE to be and not how fast it got there. Worst seed of eight.
  //
  // DISCLOSED WEAKNESS: the lock is detectable from inside a module — its
  // riders feel slow — so a module could in principle ride distinct lines only
  // while locked. Nothing here catches that.
  lines() {
    const locked = lockedMatrix();
    let worst = Infinity, worstSeed = null, worstPair = null;
    const rows = [];
    for (const r of locked) {
      const { rms, who } = closestLinePair(r.racers);
      if (rms < worst) { worst = rms; worstSeed = r.seed; worstPair = who; }
      rows.push({ seed: r.seed, closestPair_m: +rms.toFixed(2), pair: who });
    }
    return { closestLinePair_m: +worst.toFixed(3),
      _worstSeed: worstSeed, _worstPair: worstPair,
      _gridZ: [GRID_Z0, GRID_Z1], _perSeed: rows };
  },

  // AI-11 — same seed, FRESH module instance, twice. Finish times and whole
  // input streams must match exactly. The fresh instance is the point: module-
  // level state, or a Date.now() seed, survives a second init() but not a
  // second createRivals().
  seed() {
    let mismatches = 0;
    const rows = [];
    for (const s of [1, 5]) {
      const a = race({ seed: s }), b = race({ seed: s });
      for (const rv of a.racers) {
        const o = b.byId[rv.id];
        const tSame = rv.finishT === o.finishT;
        const sSame = tapeKey(rv.tape) === tapeKey(o.tape);
        if (!tSame) mismatches++;
        if (!sSame) mismatches++;
        if (!tSame || !sSame) rows.push({ seed: s, id: rv.id, tSame, sSame, tA: rv.finishT, tB: o.finishT });
      }
    }
    // A different seed must actually CHANGE something, or "deterministic" is
    // being satisfied by a module that ignores the seed entirely — and then
    // AI-03/AI-04's eight seeds are one run repeated eight times, which is the
    // single-operating-point failure this whole runner is built to avoid.
    const [s1, s2] = [matrix()[0], matrix()[1]];
    const seedMatters = s1.racers.some(rv => tapeKey(rv.tape) !== tapeKey(s2.byId[rv.id].tape));
    if (!seedMatters) mismatches += 1;
    return { seedReplayMismatch: mismatches, _seedMatters: seedMatters, _rows: rows.slice(0, 6) };
  },

  // AI-12 — minimum centre-to-centre separation over the whole matrix, plus the
  // shepherding clause: no rival glued within 1 m of the player for more than
  // 2 s. A shepherd violation collapses the reported separation to 0, because a
  // module that tails the player at 0.9 m for ten seconds is doing the thing
  // this gate exists to forbid and reporting a healthy 0.9 m for it would be a
  // lie about the same module.
  separation() {
    const runs = matrix();
    let worst = Infinity, who = null, shepherd = 0, worstRun = 0;
    for (const r of runs) {
      if (r.minSep !== null && r.minSep < worst) { worst = r.minSep; who = `seed${r.seed}`; }
      worstRun = Math.max(worstRun, r.worstCloseRun_s);
      if (r.worstCloseRun_s > 2.0) shepherd++;
    }
    return { minSeparation_m: shepherd ? 0 : +worst.toFixed(3),
      _rawMinSeparation_m: +worst.toFixed(3), _at: who,
      _shepherdSeeds: shepherd, _worstCloseRun_s: +worstRun.toFixed(2) };
  },

  // AI-13 — the rivals' own update cost, timed with process.hrtime around
  // mod.step and nothing else: physics, terrain sampling and the runner's own
  // bookkeeping all sit outside the timer. Two operating points (4 rivals and
  // 5) and the WORSE mean is graded, so a module cannot pass on the cheaper
  // roster. p99 and max are reported but not graded — a GC pause in a headless
  // node process is not a claim about the module.
  //
  // NOT MEASURED HERE, and disclosed rather than implied: the "5 rivals plus
  // the player sustain 60 fps in the rig" half of the statement. That is a
  // browser measurement and belongs to a capture run (harness/capture.mjs), not
  // to a pure-node gate. This gate grades the update budget only.
  perf() {
    const a = cachedRace({ seed: 1, roster: ROSTER_4, timeModule: true });
    const b = cachedRace({ seed: 1, roster: ROSTER_5, timeModule: true });
    const worse = a.perf.meanMs >= b.perf.meanMs ? a : b;
    const fmt = p => ({ mean: +p.meanMs.toFixed(4), p50: +p.p50.toFixed(4),
      p99: +p.p99.toFixed(4), max: +p.maxMs.toFixed(4), frames: p.frames });
    // THE START-GATE HITCH, folded into the graded number the same way AI-05
    // folds its sign clause: a module that moves its per-frame work into init()
    // has not made the game run at 60 fps, it has moved the stall to the count-
    // down. An audit module burned 250 ms there and reported 0.0009 ms/frame.
    const startup = Math.max(a.startupMs, b.startupMs);
    return { rivalUpdateMs: startup > STARTUP_BUDGET_MS ? 999 : +worse.perf.meanMs.toFixed(4),
      _meanStepMs: +worse.perf.meanMs.toFixed(4),
      _startupMs: +startup.toFixed(3), _startupBudgetMs: STARTUP_BUDGET_MS,
      _rivals4: fmt(a.perf), _rivals5: fmt(b.perf),
      _fpsClause: 'NOT MEASURED HERE (browser-only); this gate grades the update budget' };
  },
};

// ---------------------------------------------------------------------------
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
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err && err.stack).slice(0, 400) };
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
if (outPath) {
  mkdirSync(dirname(resolve(ROOT, outPath)), { recursive: true });
  writeFileSync(resolve(ROOT, outPath), JSON.stringify(report, null, 2));
}
for (const r of results)
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status.toUpperCase()).padEnd(6)} ${r.id.padEnd(6)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + r.value : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? ''}`);
console.log(JSON.stringify({ counts, hardFails }));
process.exit(hardFails === 0 ? 0 : 2);
