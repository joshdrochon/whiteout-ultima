// Candidate B — trick / scoring / boost-meter system (the game's economy).
//
// EVENT-STREAM DESIGN (lane seed): a physics-state OBSERVER watches the raw
// physics state every frame (the runner steps tricks AFTER physics) and emits
// semantic events:
//   takeoff · rotation-180 {count,dir} · flip-360 {count} · grab-start ·
//   grab-end {hold_s} · uber-start {name} · uber-complete {name} ·
//   touchdown {snapshot} · landing-resolved {outcome, tricks[]} ·
//   star-collect {tier} · knockdown
// A JUDGE (part of the observer) folds the in-air stream into a per-jump trick
// list; touchdown only SNAPSHOTS the jump — resolution is deferred one frame so
// the runner's landingOverride verdict is applied first. Independent
// SUBSCRIBERS then fold the same stream:
//   scoringFold — base values, x0.5 repetition, star multiplier, awards log
//   meterFold   — fill on banked tricks, idle decay, boost drain, knockdown
//   trickyFold  — six DISTINCT landed ubers light T-R-I-C-K-Y (meter pinned)
//
// Economy facts are Tricky-native HARD values (references/REFERENCE_BAR.md §5;
// uber table verbatim from references/research/03-jumps-air-tricks.md §5,
// Uber Trick Guide): uber bases 13,210 (Benihana/Blender) .. 22,580 (Pommel
// Me / SuperMan BarSpin); x0.5 per repeat of the SAME trick (direction/degree
// change = new trick); stars yellow 2x / orange 3x / red 5x, highest single
// star only, credited only on clean landing, voided on crash; ~3 mid-tier
// flip tricks fill the meter empty->full; 6 individually landed ubers ->
// TRICKY: infinite boost for the rest of the run; a landed knockdown/shove
// instantly fills the meter; landing mid-uber-animation always crashes.
//
// Landing judgment is the trick system's own (fakie = clean): residual spin
// from the nearest 180 multiple, residual flip from the nearest 360 multiple,
// grab held at touchdown, or an unfinished uber animation decide crash. A
// clean 180/540/900 lands fakie and still banks.
//
// Pure JS, deterministic: no Date, no Math.random, no globals, no imports.

// --- Uber Trick Guide point table (Tricky-native, VERIFIED; research 03 §5) ---
const UBER_TABLE = {
  'Benihana': 13210, 'Blender': 13210,
  'Airwalk': 13390, 'CliffHanger': 13390, 'Cordova': 13390, 'Dervish': 13390,
  'Hart Attack': 13390, 'Heel Clicker': 13390, 'LazyBoy': 13390,
  'Madonna': 13390, 'Mulisha': 13390, 'Nac Nac': 13390, 'Nothing': 13390,
  'Sad Sack': 13390, 'SuperMan': 13390,
  'Indian': 13760, 'Judo': 13760, 'Paddle Wheel': 13760, 'Scooter': 13760,
  'Coffin Roll': 13940, 'Footloose': 13940,
  'Iron Cross': 14120,
  'Can Can': 14310, 'Hand in Hand': 14310,
  'Bar Hop': 14490,
  'Triple H': 15220,
  'FloorBoard': 15410,
  'FrogHop': 16140, 'StuntMan': 16140, 'The Rake': 16140,
  'Torpedo': 16510,
  'BodyBoard': 16870,
  'GutBuster': 17240, 'Near Miss': 17240,
  'Hang 10 Backflip': 17290, 'Pirouette Grind': 17290,
  'Aerial Spock 540': 17900,
  'Proper Propellor': 19260,
  'Magician': 19990,
  'Guillotine': 20750,
  'Walking The Dog': 20960,
  'Worm': 21360,
  'Headspin2Poseur': 21770, 'Soul Grind': 21770,
  'Bronco Buster': 22380, 'La La La Lock Step': 22380,
  'Pommel Me': 22580, 'SuperMan BarSpin': 22580,
};
// Character-signature ubers (need the character's board; ~2x animation length).
const CHARACTER_UBERS = new Set([
  'Hang 10 Backflip', 'Pirouette Grind', 'Aerial Spock 540', 'Guillotine',
  'Walking The Dog', 'Worm', 'Headspin2Poseur', 'Soul Grind', 'Bronco Buster',
  'La La La Lock Step', 'Pommel Me', 'SuperMan BarSpin',
]);
const TRICKY_WORD = ['T', 'R', 'I', 'C', 'K', 'Y'];

export function createTricks(env = {}) {
  const C = {
    // --- contract-required fields ---
    uberTable: UBER_TABLE,
    uberDuration_s: { quick: 1.2, character: 2.3 }, // per-tier animation length
    starTiers: { yellow: 2, orange: 3, red: 5 },    // highest-only, clean landing
    meterFillMidTier: 0.365,   // one mid-tier (flip-class) trick; ~3 fill empty->full
    trickyLettersNeeded: 6,    // six DISTINCT landed ubers light T-R-I-C-K-Y
    // input.uber slot 1..6 -> quick ubers (fit an ordinary full-charge jump)
    uberSlots: ['Benihana', 'Nac Nac', 'Judo', 'Iron Cross', 'Bar Hop', 'Torpedo'],
    // --- non-uber base values (research 03 §5 ESTIMATE bands) ---
    spinBasePer180: 250,       // triangular escalation: 180=250 .. 1080=5250
    flipBasePerFlip: 500,      // 1 flip 500, double 1500, triple 3000
    comboComposeBonus: 1.25,   // spin+flip composite (Misty/Rodeo) > sum of parts
    grabBase: 500, grabPerSecond: 400, // grab accrues by hold time
    // --- repetition (HARD: x0.5 score per repeat of the same trick) ---
    repeatScoreFactor: 0.5,
    fillRepeatFactor: 0.9,     // repeats fill the meter less, gently
    // --- meter economy ---
    fillUber: 0.5,
    fillSpinPer180: 0.08, fillSpinCap: 0.32,
    fillGrabBase: 0.06, fillGrabPerSecond: 0.04, fillGrabCap: 0.2,
    meterDecay_perS: 0.05,     // idle drain once the grace window lapses
    meterDecayGrace_s: 4,      // "the longer you ride without jumping..."
    crashMeterLoss: 0.25,      // falls drain the meter
    boostDrain_perS: 0.125,    // spending: full meter = 8 s of boost
    // --- trick-landing judgment (fakie-aware; independent of physics label) ---
    spinCrashResidual_deg: 80, // from nearest 180 multiple (straight/fakie)
    flipCrashResidual_deg: 90, // from nearest 360 multiple (upright)
  };
  let current = null; // last tstate seen; collectStar()/knockdown() route here

  const newAir = () => ({ s180: 0, f360: 0, grabbing: false, grabT: 0,
    grabs: [], uber: null, ubers: [], prevUber: 0 });
  const spinBase = n => C.spinBasePer180 * n * (n + 1) / 2;
  const flipBase = n => C.flipBasePerFlip * n * (n + 1) / 2;
  const flipName = (deg, n) =>
    `${n >= 3 ? 'Triple ' : n === 2 ? 'Double ' : ''}${deg >= 0 ? 'Backflip' : 'Frontflip'}`;
  const uberDur = name =>
    CHARACTER_UBERS.has(name) ? C.uberDuration_s.character : C.uberDuration_s.quick;

  // ---------- judge: pending snapshot -> landing-resolved event ----------
  function resolvePending(ts, evs) {
    const P = ts._pending;
    ts._pending = null;
    const n180 = Math.round(Math.abs(P.spinDeg) / 180);
    const nFlip = Math.round(Math.abs(P.flipDeg) / 360);
    const spinResid = Math.abs(Math.abs(P.spinDeg) - n180 * 180);
    const flipResid = Math.abs(Math.abs(P.flipDeg) - nFlip * 360);
    const crash = P.uberIncomplete || P.grabHeld
      || spinResid > C.spinCrashResidual_deg
      || flipResid > C.flipCrashResidual_deg;
    const tricks = [];
    if (!crash) {
      for (const u of P.ubers)
        tricks.push({ name: u, base: UBER_TABLE[u] ?? 13210, kind: 'uber' });
      if (n180 >= 1 && nFlip >= 1) {          // composite (Misty/Rodeo class)
        tricks.push({
          name: `${P.flipDeg >= 0 ? 'Rodeo' : 'Misty'} ${n180 * 180}${nFlip > 1 ? ` x${nFlip}` : ''}`,
          base: (spinBase(n180) + flipBase(nFlip)) * C.comboComposeBonus,
          kind: 'flip', n180, nFlip,
        });
      } else if (n180 >= 1) {
        tricks.push({
          name: P.spinCapped ? '???' : `${P.spinDeg >= 0 ? 'FS' : 'BS'} ${n180 * 180}`,
          base: spinBase(n180), kind: 'spin', n180,
        });
      } else if (nFlip >= 1) {
        tricks.push({
          name: P.flipCapped ? '???' : flipName(P.flipDeg, nFlip),
          base: flipBase(nFlip), kind: 'flip', n180: 0, nFlip,
        });
      }
      for (const hold of P.grabs)
        tricks.push({ name: 'Indy Grab',
          base: Math.round(C.grabBase + C.grabPerSecond * hold),
          kind: 'grab', hold });
    }
    evs.push({ type: 'landing-resolved', outcome: crash ? 'crash' : 'clean', tricks });
  }

  // ---------- subscriber: scoring (score, repetition, stars, awards) ----------
  function scoringFold(ts, ev) {
    switch (ev.type) {
      case 'star-collect':
        // highest single star only — keep the best pending pickup
        ts._pendingStar = Math.max(ts._pendingStar, ev.tier);
        break;
      case 'takeoff': ts.jumpScore = 0; break;
      // provisional (pre-penalty, pre-star) running total for the HUD
      case 'rotation-180': ts.jumpScore += C.spinBasePer180; break;
      case 'flip-360': ts.jumpScore += C.flipBasePerFlip; break;
      case 'grab-end':
        ts.jumpScore += Math.round(C.grabBase + C.grabPerSecond * ev.hold_s); break;
      case 'uber-complete': ts.jumpScore += UBER_TABLE[ev.name] ?? 13210; break;
      case 'landing-resolved': {
        if (ev.outcome === 'crash') {
          ts.jumpScore = 0;
          ts._pendingStar = 0;               // star voided on crash
          ts.lastAward = { name: 'CRASHED', points: 0, label: 'CRASHED — tricks voided' };
          ts.awards.push(ts.lastAward);
          break;
        }
        let total = 0;
        for (const tk of ev.tricks) {
          const rep = ts._rep[tk.name] ?? 0;
          const factor = Math.pow(C.repeatScoreFactor, rep); // x0.5 per repeat
          const pts = tk.base * factor;
          ts._rep[tk.name] = rep + 1;
          tk.pts = pts; tk.rep = rep;
          total += pts;
          ts.awards.push({ name: tk.name, points: pts, repeat: rep,
            label: `${tk.name} +${Math.round(pts)}${rep ? ' (repeat)' : ''}` });
        }
        const star = ts._pendingStar > 1 ? ts._pendingStar : 1;
        const banked = total * star;         // multiplier on the jump's summed tricks
        if (star > 1 && total > 0)
          ts.awards.push({ name: `STAR x${star}`, points: banked - total,
            label: `STAR BONUS x${star}` });
        ts.score += banked;
        ts._pendingStar = 0;                 // pickup consumed by the landing
        ts.jumpScore = 0;
        if (ev.tricks.length)
          ts.lastAward = { name: ev.tricks.map(t => t.name).join(' + '),
            points: banked, label: `+${Math.round(banked)}` };
        break;
      }
    }
  }

  // ---------- subscriber: boost meter (fill / knockdown / crash loss) ----------
  function meterFold(ts, ev) {
    switch (ev.type) {
      case 'knockdown':                       // landed shove -> instant full meter
        ts.meter = 1;
        ts.awards.push({ name: 'KNOCKDOWN', points: 0, label: 'KNOCKDOWN — meter full' });
        break;
      case 'landing-resolved': {
        if (ev.outcome === 'crash') {
          if (!ts.tricky) ts.meter = Math.max(0, ts.meter - C.crashMeterLoss);
          break;
        }
        for (const tk of ev.tricks) {
          let fill =
            tk.kind === 'uber' ? C.fillUber :
            tk.kind === 'flip' ? C.meterFillMidTier :          // mid-tier anchor
            tk.kind === 'spin' ? Math.min(C.fillSpinPer180 * tk.n180, C.fillSpinCap) :
            Math.min(C.fillGrabBase + C.fillGrabPerSecond * tk.hold, C.fillGrabCap);
          if (tk.rep > 0) fill *= C.fillRepeatFactor;          // repeats fill less
          ts.meter = Math.min(1, ts.meter + fill);
        }
        if (ev.tricks.length) ts._sinceTrick = 0;              // decay grace resets
        break;
      }
    }
  }

  // ---------- subscriber: TRICKY letters (six distinct landed ubers) ----------
  function trickyFold(ts, ev) {
    if (ev.type !== 'landing-resolved' || ev.outcome !== 'clean') return;
    for (const tk of ev.tricks) {
      if (tk.kind !== 'uber') continue;       // two ubers in one jump = two letters
      if (!ts._uberSet.includes(tk.name)) ts._uberSet.push(tk.name);
    }
    const n = Math.min(ts._uberSet.length, C.trickyLettersNeeded);
    ts.trickyLetters = TRICKY_WORD.slice(0, n);
    if (n >= C.trickyLettersNeeded && !ts.tricky) {
      ts.tricky = true;                       // permanent for the run
      ts.meter = 1;                           // pinned; never drains again
      ts.awards.push({ name: 'TRICKY', points: 0, label: "IT'S TRICKY! Infinite boost" });
    }
  }

  function dispatch(ts, evs) {
    for (const ev of evs) { scoringFold(ts, ev); meterFold(ts, ev); trickyFold(ts, ev); }
  }

  function init() {
    const ts = {
      score: 0, jumpScore: 0, meter: 0.25, tricky: false,
      trickyLetters: [], activeTrick: null, lastAward: null, awards: [],
      _prevG: null, _air: null, _pending: null,
      _rep: {}, _pendingStar: 0, _sinceTrick: 0, _uberSet: [],
    };
    current = ts;
    return ts;
  }

  // ---------- observer: physics state + input -> event stream ----------
  function step(ts, phys, input = {}, dt = 1 / 60) {
    current = ts;
    const evs = [];
    const onG = !!phys.onGround;
    const was = ts._prevG === null ? onG : ts._prevG;

    if (was && !onG) {                        // ---- takeoff ----
      if (ts._pending) resolvePending(ts, evs); // re-launched before settling
      ts._air = newAir();
      ts.activeTrick = null;
      evs.push({ type: 'takeoff' });
    }

    const A = ts._air;
    if (!onG && A) {                          // ---- airborne observation ----
      const s180 = Math.floor(Math.abs(phys.spinDeg ?? 0) / 180);
      while (A.s180 < s180) {
        A.s180++;
        evs.push({ type: 'rotation-180', count: A.s180, dir: Math.sign(phys.spinDeg || 1) });
      }
      const f360 = Math.floor(Math.abs(phys.flipDeg ?? 0) / 360);
      while (A.f360 < f360) { A.f360++; evs.push({ type: 'flip-360', count: A.f360 }); }
      // grab accrues by hold time
      const g = !!input.grab;
      if (g && !A.grabbing) { A.grabbing = true; A.grabT = 0; evs.push({ type: 'grab-start' }); }
      if (A.grabbing) A.grabT += dt;
      if (!g && A.grabbing) {
        A.grabbing = false; A.grabs.push(A.grabT);
        evs.push({ type: 'grab-end', hold_s: A.grabT });
      }
      // uber: edge-triggered start; animation runs to completion, uninterruptible
      const uin = Math.min(Math.max(Math.trunc(input.uber ?? 0), 0), C.uberSlots.length);
      if (uin > 0 && A.prevUber === 0 && !A.uber) {
        const name = C.uberSlots[uin - 1];
        A.uber = { name, t: 0, dur: uberDur(name) };
        evs.push({ type: 'uber-start', name });
      } else if (A.uber) {
        A.uber.t += dt;
        if (A.uber.t >= A.uber.dur) {
          A.ubers.push(A.uber.name);
          evs.push({ type: 'uber-complete', name: A.uber.name });
          A.uber = null;
        }
      }
      A.prevUber = uin;
      // HUD: what is in progress right now
      ts.activeTrick = A.uber
        ? { name: A.uber.name, progress: Math.min(A.uber.t / A.uber.dur, 1) }
        : A.grabbing
          ? { name: 'Indy Grab', progress: Math.min(A.grabT / 2, 1) }
          : null;
    }

    if (!was && onG) {                        // ---- touchdown: snapshot only ----
      const A2 = ts._air ?? newAir();
      if (A2.grabbing) A2.grabs.push(A2.grabT); // grab closed by the ground...
      ts._pending = {
        spinDeg: phys.spinDeg ?? 0, flipDeg: phys.flipDeg ?? 0,
        spinCapped: !!phys.spinCapped, flipCapped: !!phys.flipCapped,
        grabHeld: !!input.grab,               // ...but held through touchdown = crash
        uberIncomplete: !!A2.uber,            // unfinished animation = crash (JA-15)
        ubers: A2.ubers, grabs: A2.grabs,
      };
      ts._air = null;
      ts.activeTrick = null;
      evs.push({ type: 'touchdown', ...ts._pending });
      // resolution deferred one frame: the runner applies landingOverride between
      // this step and the next, and the judge must fold AFTER that verdict.
    } else if (onG && ts._pending) {
      resolvePending(ts, evs);                // ---- settle frame ----
    }

    dispatch(ts, evs);

    // ---- meter housekeeping (time-domain; event folds handle the impulses) ----
    ts._sinceTrick += dt;
    if (ts.tricky) {
      ts.meter = 1;                           // TRICKY: pinned full, never drains
    } else if (input.boost && ts.meter > 0) {
      ts.meter = Math.max(0, ts.meter - C.boostDrain_perS * dt); // spending
    } else if (onG && ts._sinceTrick > C.meterDecayGrace_s) {
      ts.meter = Math.max(0, ts.meter - C.meterDecay_perS * dt); // idle decay
    }

    ts._prevG = onG;
    return ts;
  }

  // Showoff pickup. tier: 2 (yellow) | 3 (orange) | 5 (red).
  function collectStar(tier) {
    if (current) dispatch(current, [{ type: 'star-collect', tier: Math.max(0, Math.trunc(tier) || 0) }]);
  }

  // Rival knockdown landed -> meter instantly full.
  function knockdown() {
    if (current) dispatch(current, [{ type: 'knockdown' }]);
  }

  // Runner hook at touchdown: crash when an uber animation is incomplete
  // (JA-15) or a grab is still held (JA-14). Pure query; folds nothing.
  function landingOverride(ts, phys) {
    const P = ts._pending;
    if (!P) return null;
    return (P.uberIncomplete || P.grabHeld) ? 'crash' : null;
  }

  return { config: C, init, step, collectStar, knockdown, landingOverride };
}
