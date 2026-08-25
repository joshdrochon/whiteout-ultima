// SSX Tricky-style trick / scoring / boost-meter system — candidate A.
// Pure JS, deterministic (no Date, no Math.random).
//
// ARCHITECTURE
//   1. Explicit finite state machine over the trick lifecycle:
//        grounded -> airborne -> trick-active <-> trick-complete -> landing-pending -> grounded
//      Transition table (driven each step by physState + input):
//        grounded        --!onGround-------------------> airborne        (TAKEOFF)
//        airborne        --uber input rising edge------> trick-active    (UBER_START)
//        airborne        --grab held-------------------> trick-active    (GRAB_START)
//        trick-active    --uber progress >= 1----------> trick-complete  (UBER_COMPLETE)
//        trick-active    --grab released, no uber------> airborne
//        trick-complete  --uber input rising edge------> trick-active
//        any air state   --onGround--------------------> landing-pending (TOUCHDOWN; verdict frozen)
//        landing-pending --next step-------------------> grounded        (LANDING resolved: bank or void)
//        landing-pending --!onGround (bounce)----------> airborne        (resolve first, then TAKEOFF)
//   2. Scoring and meter are pure reducers over emitted events (reduceScore /
//      reduceMeter below); step() only detects transitions and emits.
//
// Landing verdict: judged against nearest straight/fakie orientation (JA-13:
// "clean within +/-40-50 deg of straight OR fakie"), i.e. residual spin folded
// to the nearest multiple of 180 and residual flip folded to the nearest 360.
// Grab held at touchdown or an unfinished uber animation is always a crash
// (JA-14 / JA-15). landingOverride() reports only the uber-incomplete crash,
// per contract ('crash' | null).

// ---------------------------------------------------------------------------
// Uber table — Tricky-native HARD values, Uber Trick Guide (Jay Higa /
// The_JRage), reproduced from references/research/03-jumps-air-tricks.md §5.
// name: [basePoints, difficulty]. Points are stat-independent.
// ---------------------------------------------------------------------------
const UBERS = {
  'Benihana':           [13210,  1.0], 'Blender':            [13210,  1.0],
  'Airwalk':            [13390,  1.2], 'CliffHanger':        [13390,  1.2],
  'Cordova':            [13390,  1.2], 'Dervish':            [13390,  1.2],
  'Hart Attack':        [13390,  1.2], 'Heel Clicker':       [13390,  1.2],
  'LazyBoy':            [13390,  1.2], 'Madonna':            [13390,  1.2],
  'Mulisha':            [13390,  1.2], 'Nac Nac':            [13390,  1.2],
  'Nothing':            [13390,  1.2], 'Sad Sack':           [13390,  1.2],
  'SuperMan':           [13390,  1.2], 'Indian':             [13760,  1.5],
  'Judo':               [13760,  1.5], 'Paddle Wheel':       [13760,  1.5],
  'Scooter':            [13760,  1.5], 'Coffin Roll':        [13940,  1.7],
  'Footloose':          [13940,  1.7], 'Iron Cross':         [14120,  1.9],
  'Can Can':            [14310,  2.1], 'Hand in Hand':       [14310,  2.1],
  'Bar Hop':            [14490,  2.2], 'Triple H':           [15220,  2.9],
  'FloorBoard':         [15410,  3.1], 'FrogHop':            [16140,  3.8],
  'StuntMan':           [16140,  3.8], 'The Rake':           [16140,  3.8],
  'Torpedo':            [16510,  4.2], 'BodyBoard':          [16870,  4.5],
  'GutBuster':          [17240,  4.9], 'Near Miss':          [17240,  4.9],
  'Hang 10 Backflip':   [17290,  4.9], 'Pirouette Grind':    [17290,  4.9],
  'Aerial Spock 540':   [17900,  5.5], 'Proper Propellor':   [19260,  6.8],
  'Magician':           [19990,  7.5], 'Guillotine':         [20750,  8.2],
  'Walking The Dog':    [20960,  8.4], 'Worm':               [21360,  8.8],
  'Headspin2Poseur':    [21770,  9.2], 'Soul Grind':         [21770,  9.2],
  'Bronco Buster':      [22380,  9.8], 'La La La Lock Step': [22380,  9.8],
  'Pommel Me':          [22580, 10.0], 'SuperMan BarSpin':   [22580, 10.0],
};

// Animation length scales with difficulty (guide: "the longer it takes ...
// the more points"). Quick ubers (diff ~1-3) ~= 1.0-1.3 s, character ubers
// (diff ~8-10) ~= 2.0-2.4 s — matches research doc 03 §2 timing estimates.
const uberDuration = diff => +(0.85 + 0.15 * diff).toFixed(3);

// input.uber: 0 | 1..6 — the rider's equipped quick-uber loadout (distinct
// tricks, one per slot; all short enough to finish inside an ordinary
// full-charge jump).
const LOADOUT = ['Benihana', 'Airwalk', 'Indian', 'Coffin Roll', 'Iron Cross', 'Can Can'];

// Non-uber base values (research doc 03 §5 ESTIMATE bands: ~100-300 per 180
// of spin, ~300-600 per full flip, grabs a few hundred + accrual per second;
// composites escalate). Index = completed 180-deg units.
const SPIN_PTS = [0, 200, 450, 750, 1100, 1500, 1950, 2450, 3000, 3600, 4250]; // <= 1800 deg
const FLIP_PTS = [0, 250, 550, 900, 1300, 1750, 2250];                          // <= 1080 deg
const GRAB_FLAT = 300, GRAB_PER_S = 350;   // "hundreds of points per second" of hold

const TUNE = {
  cleanYawWindow_deg: 45,    // vs nearest straight/fakie (JA-13 band 40-50)
  crashYawWindow_deg: 80,    // residual beyond this = crash (JA-13 band 80-100)
  crashFlipWindow_deg: 100,  // residual flip beyond this = crash
  sketchyFillFactor: 0.6,    // sketchy landings bank points but fill less
  repetitionFactor: 0.5,     // x0.5 of the PREVIOUS award per repeat (JA-17)
  comboBonusPerFamily: 0.10, // +10% per extra trick family in one air (combos chain)
  fillMidTier: 0.34,         // flip-class trick: ~3 fill empty->full (JA-21)
  fillSmall: 0.10,           // single 180 / short grab
  fillMedium: 0.15,          // 360+ spin or long grab
  fillBig: 0.50,             // flip+spin+grab combined air (research: 40-60%)
  fillScoreDiv: 60000,       // score-coupled part: repeats fill less
  fillScoreCap: 0.12,
  crashMeterLoss: 0.35,      // falls drain the meter
  idleGrace_s: 3,            // ride this long without banking before decay
  idleDecayPerS: 0.03,       // manual: "the longer you ride without jumping..."
  boostDrainPerS: 0.25,      // spending boost drains the meter (unless TRICKY)
  minGrab_s: 0.15,
};

const fold = (deg, mod) => {
  const r = Math.abs(deg) % mod;
  return Math.min(r, mod - r);
};

// ---------------------------------------------------------------------------
// trick recognition -> award components (pure)
// ---------------------------------------------------------------------------
function spinName(units, sign) {
  return `${sign < 0 ? 'Backside' : 'Frontside'} ${units * 180}`;
}
function flipName(units, sign) {
  const dir = sign < 0 ? 'Back' : 'Front';
  if (units === 1) return `Half ${dir}flip`;
  const full = Math.floor(units / 2), half = units % 2;
  const mult = full === 1 ? '' : full === 2 ? 'Double ' : 'Triple ';
  return `${mult}${dir}flip${half ? ' + 180' : ''}`;
}

// Components of one jump, in performance order. Each has a repetition
// signature: repeating the SAME signature awards x0.5 of its previous award;
// changing direction or degree is a different signature and resets (JA-17).
function components(j) {
  const out = [];
  for (const name of j.completedUbers)
    out.push({ sig: `uber:${name}`, name, base: UBERS[name][0], family: 'uber' });
  const su = Math.min(SPIN_PTS.length - 1, Math.floor((j.peakSpin + 10) / 180));
  if (su >= 1)
    out.push({ sig: `spin:${su}:${j.spinSign}`, family: 'spin',
      name: j.spinMystery ? '???' : spinName(su, j.spinSign), base: SPIN_PTS[su] });
  const fu = Math.min(FLIP_PTS.length - 1, Math.floor((j.peakFlip + 10) / 180));
  if (fu >= 1)
    out.push({ sig: `flip:${fu}:${j.flipSign}`, family: 'flip',
      name: j.flipMystery ? '???' : flipName(fu, j.flipSign), base: FLIP_PTS[fu] });
  if (j.grabTime >= TUNE.minGrab_s)
    out.push({ sig: 'grab', family: 'grab',
      name: j.grabTime >= 1.5 ? 'Tweaked Grab' : 'Grab',
      base: GRAB_FLAT + GRAB_PER_S * j.grabTime });
  return out;
}

// Tally a component list against the repetition registry. commit=false gives
// a live preview (HUD jumpScore) without mutating repetition memory.
function tally(comps, registry, commit) {
  const local = new Map();
  const entries = [];
  let sum = 0;
  for (const c of comps) {
    const prev = local.has(c.sig) ? local.get(c.sig) : registry.get(c.sig);
    const pts = prev != null ? prev * TUNE.repetitionFactor : c.base;
    local.set(c.sig, pts);
    entries.push({ name: c.name, points: pts, family: c.family });
    sum += pts;
  }
  const families = new Set(comps.map(c => c.family)).size;
  const combo = families >= 2 ? 1 + TUNE.comboBonusPerFamily * (families - 1) : 1;
  if (commit) for (const [k, v] of local) registry.set(k, v);
  return { total: sum * combo, entries, families };
}

// ---------------------------------------------------------------------------
// pure reducers over landing/knockdown events
// ---------------------------------------------------------------------------
function reduceScore(ts, ev) {
  if (ev.type !== 'landing') return;
  if (ev.verdict === 'crash') { ts.jumpScore = 0; ts.lastAward = null; return; }
  const banked = ev.total * ev.starMult;
  ts.score += banked;
  ts.jumpScore = banked;
  ts.lastAward = { name: ev.summary, points: banked };
  for (const e of ev.entries) ts.awards.push({ t: ev.t, name: e.name, points: e.points });
  if (ev.starMult > 1)
    ts.awards.push({ t: ev.t, name: `${ev.starMult}x Star Bonus`, points: ev.total * (ev.starMult - 1) });
}

function reduceMeter(ts, ev) {
  if (ev.type === 'knockdown') { ts.meter = 1; return; }        // JA-20
  if (ev.type !== 'landing') return;
  if (ev.verdict === 'crash') { ts.meter = Math.max(0, ts.meter - TUNE.crashMeterLoss); return; }
  if (ev.uberLanded) { ts.meter = 1; return; }                  // landed uber refills
  let fill = ev.families >= 3 ? TUNE.fillBig
    : ev.hasFlip ? TUNE.fillMidTier
    : (ev.bigSpin || ev.longGrab) ? TUNE.fillMedium
    : TUNE.fillSmall;
  fill += Math.min(TUNE.fillScoreCap, ev.total / TUNE.fillScoreDiv); // repeats fill less
  if (ev.verdict === 'sketchy') fill *= TUNE.sketchyFillFactor;
  ts.meter = Math.min(1, ts.meter + fill);
}

function reduceTricky(ts, ev) {
  if (ev.type !== 'landing' || ev.verdict === 'crash') return;
  for (const name of ev.uberNames)
    if (!ts._landedUbers.includes(name)) ts._landedUbers.push(name); // distinct ubers
  ts.trickyLetters = Math.min(6, ts._landedUbers.length);
  if (ts.trickyLetters >= 6) ts.tricky = true;                  // JA-19: permanent
}

// ---------------------------------------------------------------------------
export function createTricks(env = {}) {
  const config = {
    uberTable: Object.fromEntries(Object.entries(UBERS).map(([n, [p]]) => [n, p])),
    uberDuration_s: Object.fromEntries(Object.entries(UBERS).map(([n, [, d]]) => [n, uberDuration(d)])),
    uberLoadout: LOADOUT.slice(),
    starTiers: { yellow: 2, orange: 3, red: 5 },
    meterFillMidTier: TUNE.fillMidTier,
    trickyLettersNeeded: 6,
    spinPointsPer180: SPIN_PTS.slice(),
    flipPointsPer180: FLIP_PTS.slice(),
    grabFlatPoints: GRAB_FLAT, grabPointsPerSecond: GRAB_PER_S,
    ...TUNE,
  };

  let boundTs = null; // collectStar/knockdown have no tstate arg (contract)

  function freshJump() {
    return { peakSpin: 0, spinSign: 1, peakFlip: 0, flipSign: 1,
      spinMystery: false, flipMystery: false,
      grabTime: 0, completedUbers: [], grabHeldAtTouchdown: false };
  }

  function init() {
    const ts = {
      // contract-required public fields
      score: 0, jumpScore: 0, meter: 0, tricky: false, trickyLetters: 0,
      activeTrick: null, lastAward: null, awards: [],
      // internals
      _fsm: 'grounded', _t: 0, _jump: freshJump(),
      _uber: null,               // { name, duration, t } while animating
      _prevUberIn: 0,
      _rep: new Map(),           // signature -> last award (x0.5 chain)
      _landedUbers: [],
      _star: 0,                  // highest pending star multiplier this jump
      _sinceBank: 0,
      _pendingVerdict: null,
    };
    boundTs = ts;
    return ts;
  }

  function takeoff(ts) {
    ts._fsm = 'airborne';
    ts._jump = freshJump();
    ts._uber = null;
    ts.jumpScore = 0;
  }

  function airTick(ts, phys, input, dt) {
    const j = ts._jump;
    // rotation peaks (physics resets spinDeg/flipDeg at takeoff)
    const s = phys.spinDeg ?? 0, f = phys.flipDeg ?? 0;
    if (Math.abs(s) > j.peakSpin) { j.peakSpin = Math.abs(s); j.spinSign = Math.sign(s) || 1; }
    if (Math.abs(f) > j.peakFlip) { j.peakFlip = Math.abs(f); j.flipSign = Math.sign(f) || 1; }
    if (phys.spinCapped) j.spinMystery = true;   // beyond 1800: "???"
    if (phys.flipCapped) j.flipMystery = true;   // beyond 1080: "???"
    // grabs accrue by hold time
    if (input.grab) j.grabTime += dt;
    // uber lifecycle — edge-triggered start; cannot be interrupted once begun
    const uberIn = input.uber | 0;
    if (!ts._uber && uberIn >= 1 && ts._prevUberIn === 0) {
      const name = LOADOUT[Math.min(uberIn, LOADOUT.length) - 1];
      ts._uber = { name, duration: config.uberDuration_s[name], t: 0 };
      ts._fsm = 'trick-active';
    }
    ts._prevUberIn = uberIn;
    if (ts._uber) {
      ts._uber.t += dt;
      if (ts._uber.t >= ts._uber.duration) {          // animation finished mid-air
        j.completedUbers.push(ts._uber.name);
        ts._uber = null;
        ts._fsm = 'trick-complete';
      }
    } else if (ts._fsm !== 'trick-complete') {
      ts._fsm = input.grab ? 'trick-active' : 'airborne';
    }
    // live HUD preview of the jump's running total (no repetition commit)
    ts.jumpScore = tally(components(j), ts._rep, false).total;
    ts.activeTrick = ts._uber
      ? { name: ts._uber.name, progress: Math.min(1, ts._uber.t / ts._uber.duration) }
      : (input.grab ? { name: 'Grab', progress: Math.min(1, j.grabTime / 2) } : null);
  }

  // Verdict frozen at the touchdown step. Judged vs nearest straight/fakie
  // (fold 180) and nearest upright flip orientation (fold 360).
  function judge(ts, phys, input) {
    if (ts._uber && ts._uber.t < ts._uber.duration) return 'crash'; // JA-15
    if (input.grab) return 'crash';                                  // JA-14
    const spinResid = fold(phys.spinDeg ?? 0, 180);
    const flipResid = fold(phys.flipDeg ?? 0, 360);
    if (spinResid >= TUNE.crashYawWindow_deg || flipResid >= TUNE.crashFlipWindow_deg) return 'crash';
    if (spinResid <= TUNE.cleanYawWindow_deg && flipResid <= TUNE.cleanYawWindow_deg) return 'clean';
    return 'sketchy';
  }

  function resolveLanding(ts) {
    const j = ts._jump;
    const verdict = ts._pendingVerdict ?? 'clean';
    const comps = components(j);
    let ev;
    if (verdict === 'crash') {
      ev = { type: 'landing', t: ts._t, verdict, total: 0, entries: [], starMult: 1,
        uberNames: [], uberLanded: false, families: 0, hasFlip: false,
        bigSpin: false, longGrab: false, summary: 'Bailed' };
    } else {
      const { total, entries, families } = tally(comps, ts._rep, true); // commit repetition
      const starMult = verdict === 'clean' && ts._star > 1 ? ts._star : 1; // clean only, highest only
      ev = { type: 'landing', t: ts._t, verdict, total, entries, starMult, families,
        uberNames: j.completedUbers.slice(), uberLanded: j.completedUbers.length > 0,
        hasFlip: j.peakFlip >= 170, bigSpin: j.peakSpin >= 350, longGrab: j.grabTime >= 1,
        summary: entries.map(e => e.name).join(' + ') || 'Air' };
      ts._sinceBank = 0;
    }
    reduceScore(ts, ev);
    reduceMeter(ts, ev);
    reduceTricky(ts, ev);
    ts._star = 0;               // star consumed (voided on crash) — JA-18
    ts._uber = null;
    ts._pendingVerdict = null;
    ts.activeTrick = null;
    ts._fsm = 'grounded';
  }

  function groundTick(ts, input, dt) {
    ts._sinceBank += dt;
    if (!ts.tricky) {
      if (ts._sinceBank > TUNE.idleGrace_s)                 // idle decay
        ts.meter = Math.max(0, ts.meter - TUNE.idleDecayPerS * dt);
      if (input.boost)                                      // spending drains
        ts.meter = Math.max(0, ts.meter - TUNE.boostDrainPerS * dt);
    }
    ts.activeTrick = null;
  }

  function step(ts, phys, input = {}, dt = 1 / 60) {
    ts._t += dt;
    const air = !phys.onGround;
    switch (ts._fsm) {
      case 'grounded':
        if (air) takeoff(ts);
        else groundTick(ts, input, dt);
        break;
      case 'airborne':
      case 'trick-active':
      case 'trick-complete':
        if (!air) {                                  // TOUCHDOWN: freeze verdict,
          ts._jump.grabHeldAtTouchdown = !!input.grab; // resolve next step so the
          ts._pendingVerdict = judge(ts, phys, input); // harness's landingOverride
          ts._fsm = 'landing-pending';                 // pass can run in between
        } else airTick(ts, phys, input, dt);
        break;
      case 'landing-pending':
        resolveLanding(ts);
        if (air) takeoff(ts);
        else groundTick(ts, input, dt);
        break;
    }
    if (air) ts._sinceBank = 0;          // airtime is not idle riding
    if (ts.tricky) ts.meter = 1;         // TRICKY: pinned full, never drains
    return ts;
  }

  return {
    config,
    init,
    step,
    // showoff star pickup: 2 | 3 | 5. Highest single star per jump counts.
    collectStar(tier) {
      if (boundTs && (tier === 2 || tier === 3 || tier === 5))
        boundTs._star = Math.max(boundTs._star, tier);
    },
    // landed rival knockdown/shove -> meter instantly full (JA-20)
    knockdown() {
      if (boundTs) reduceMeter(boundTs, { type: 'knockdown' });
    },
    // Uber animation incomplete at touchdown -> crash, always (JA-15).
    landingOverride(ts, phys) {
      return ts._uber && ts._uber.t < ts._uber.duration ? 'crash' : null;
    },
    // boost input gating for the game loop: spend only with charge (or TRICKY)
    boostAvailable(ts) { return ts.tricky || ts.meter > 0.01; },
  };
}
