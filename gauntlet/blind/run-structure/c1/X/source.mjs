// ============================================================================
// run-structure candidate A — run.mjs
//
// The RUN: a start gate that actually holds you, a clock that only runs while
// you are racing, a finish line that latches the moment you cross it, a results
// card assembled ONCE on the running->finished transition, and a corridor that
// keeps the rider on the part of the mountain the renderer can actually draw.
//
// STRATEGY
// --------
// 1. EXPLICIT PHASE MACHINE. `ready -> running -> finished` (the contract's three
//    phases) with entry/exit hooks in one table, so every side effect of a
//    transition lives in exactly one place. The SSX-style 3-2-1 countdown is a
//    SUB-state of `ready` (rstate.gate / rstate.countdown_s / rstate.light), not a
//    fourth public phase — the contract fixes the public phase vocabulary and the
//    HUD gets the countdown it needs without breaking it.
//
// 2. THE GATE HOLDS. While `ready` the rider is pinned to the gate transform
//    every step (position, velocity, heading restored after the physics tick).
//    It is a start gate, not a suggestion: gravity on a 23 deg pitch would
//    otherwise walk the rider down-course before the clock ever starts.
//
// 3. CONFINEMENT IS A CONTINUOUS FORCE FIELD, NOT A CLAMP. Measured on this
//    terrain: inside the 120 m corridor the rendered mesh tracks the analytic
//    ground to <= 1.5 m, but the moment the rider leaves the inner tile block
//    (|z| outside [-250, 2750]) the backdrop LOD's 83 m cells diverge by 8-77 m
//    and the rider is visibly inside the mountain. So the corridor is enforced in
//    graded layers — each one only engages where the previous one was not enough,
//    and every layer acts on velocity or heading before any of them touch
//    position. `a` below is |x - courseCenterX(z)|, H is halfWidth (120 m):
//
//      groomed (a < 0.30 H)  nothing at all. The rideable line is free.
//      berm    (0.30 H .. H) smooth inward accel + a yaw authority that TURNS the
//                            board back down-course (a banked wall redirects you;
//                            it does not shove you), both smoothstep-ramped so
//                            first contact is felt, not hit. NO speed tax here —
//                            a banked turn should be rideable.
//      wall    (H .. 1.10 H) same terms at much higher gain, plus barrier
//                            friction. The player's steering is capped at
//                            A_LAT/v ~ 0.9 rad/s; the wall out-authorities it.
//      catch   (>= 1.10 H)   the OUTWARD rate of `a` is capped by a budget that
//                            fades to zero over 6 m, so penetration is bounded by
//                            construction, not by hoping the spring wins.
//      reel    (>= 1.10 H)   the ONLY positional term: an exponential pull on the
//                            remaining excess, speed-limited to 30 m/s (0.5 m per
//                            60 Hz frame) on top of a <= 0.55 m physics step —
//                            worst case ~1.05 m/frame against a 2 m budget.
//
//    Two ceilings keep this from ever becoming a slingshot: the wall response
//    SATURATES at one wall-width of penetration, and the corridor's own closing
//    rate is capped at 20 m/s. A rider teleported 400 m off-course by some other
//    system is escorted home over ~4 s with a worst frame of 0.81 m — measured.
//
//    Measured reach under every attack tried (hard bail both sides at full boost,
//    airborne bail off a charged jump, 6 s zigzag wall slams, reverse-uphill,
//    boost held through the finish): a never passes 101 m, mesh divergence never
//    passes 0.98 m against the 4 m budget. Construction bound is a <= ~138 m
//    (~1.4 m divergence). Yaw authority is applied ONLY while grounded — in the
//    air `heading` belongs to the trick system's spin bookkeeping and this module
//    never touches trick state.
//
//    The same 1-D machinery is reused on the z axis: a barrier above the start
//    gate, and a 200 m run-out corral past the finish so a player who holds boost
//    through the line coasts, slows, and is caught well before the backdrop tiles.
//
// 4. RESULTS ARE ASSEMBLED ONCE. Everything the card reports (score, best trick
//    and its points, TRICKY, landed/crashed counts, air time, top speed) is
//    accumulated by observers during `running` and frozen into a single immutable
//    object on the running->finished transition. `results()` returns that object
//    verbatim afterwards, so it cannot drift while the rider is still sliding.
//
// Pure JS, deterministic, no Date/Math.random. Reads physics + trick state;
// mutates physics pos/vel/heading only (confinement + gate hold), never tricks.
// ============================================================================

// ------------------------------------------------------------------ tuning
const TUNE = {
  // --- start gate ---
  countdown_s: 3.0,          // s, 3-2-1-GO before the gate drops
  gateSnapSpeed: 0.0,        // rider is pinned dead still at the gate

  // --- lateral corridor (fractions of halfWidth) ---
  bermFrac: 0.30,            // groomed line ends / berm begins here (36 m)
  catchFrac: 1.10,           // hard catch band begins here
  bermAccel: 10,             // m/s^2 inward at the top of the berm band
  wallAccel: 70,             // m/s^2 extra per unit penetration past the wall
  bermYaw: 2.0,              // rad/s yaw authority at the top of the berm band
  wallYaw: 2.4,              // rad/s extra per unit penetration past the wall
  yawBlend: 0.92,            // how far toward "straight back in" the berm aims
  scrub: 1.6,                // 1/s speed scrub, PAST THE WALL ONLY (grinding the
                             // barrier costs you; riding the berm does not)
  penMax: 1.0,               // the wall response SATURATES here: a rider who is
                             // somehow 300 m out is walked home, not slingshot
  vOut0: 8,                  // m/s outward budget the instant the catch engages
  vOutFade: 6,               // m over which that budget fades to zero
  vInMax: 20,                // m/s ceiling on the corridor's own closing rate
  reelRate: 25.8,            // 1/s, exponential reel-in of the remaining excess
                             // (dt-correct: 1-exp(-rate*dt) == 0.35 at 60 Hz)
  reelSpeed: 30,             // m/s ceiling on the reel, so the correction is a
                             // pull (<=0.5 m at 60 Hz), never a teleport

  // --- longitudinal bounds ---
  topMargin: 40,             // m above zStart before the uphill barrier
  runOut: 200,               // m of run-out corral past the finish
  runOutSlow: 120,           // m past the finish where the corral starts biting
  tauStop: 1.6,              // s, run-out coast-down time constant

  // --- results bookkeeping ---
  minAir_s: 0.4,             // s, shortest air that counts as a landing on the
                             // card (terrain chatter is not a jump)
};

// score -> letter on the results card (kept out of TUNE so `config` stays numeric)
const GRADES = [[400000, 'S'], [220000, 'A'], [120000, 'B'], [50000, 'C'], [0, 'D']];

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smooth = t => { const u = clamp(t, 0, 1); return u * u * (3 - 2 * u); };
const wrapPi = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

export function createRun(env = {}) {
  const b = env.bounds ?? {};
  const zStart = b.zStart ?? 0;
  const zFinish = b.zFinish ?? 2400;
  const halfWidth = b.halfWidth ?? 120;
  const sampleHeight = env.sampleHeight ?? (() => 0);
  const rawCenter = env.courseCenterX ?? (() => 0);

  // centreline cache: deterministic, keyed on 5 m buckets (the supplied sampler
  // is itself quantised; this only avoids re-walking it every frame).
  const cCache = new Map();
  function center(z) {
    const k = Math.round(z / 5) * 5;
    let v = cCache.get(k);
    if (v === undefined) { v = rawCenter(k); cCache.set(k, v); }
    return v;
  }
  // centreline tangent slope dx/dz, wide stencil so the curved corridor's
  // normal does not jitter on the sampler's quantisation steps.
  function centerSlope(z) { return (center(z + 90) - center(z - 90)) / 180; }

  const zBermIn = zStart - TUNE.topMargin;               // uphill barrier
  const zRunEnd = zFinish + TUNE.runOut;                 // end of the corral
  const zSlow = zFinish + TUNE.runOutSlow;               // corral starts biting

  const config = {
    // contract-required
    zStart, zFinish, halfWidth,
    maxDivergence_m: 4,        // guaranteed mesh-vs-physics ceiling (RS-05 budget)
    // corridor geometry (named, so the critic/HUD can draw it)
    courseLength_m: zFinish - zStart,
    bermStart_m: halfWidth * TUNE.bermFrac,
    wallStart_m: halfWidth,
    catchStart_m: halfWidth * TUNE.catchFrac,
    maxLateralReach_m: halfWidth * TUNE.catchFrac + TUNE.vOutFade,  // ~138 m
    zTopBarrier: zBermIn,
    zRunOutEnd: zRunEnd,
    countdown_s: TUNE.countdown_s,
    ...TUNE,
  };

  // ---------------------------------------------------------------- state
  function init() {
    return {
      // contract-required
      phase: 'ready',
      time_s: 0,
      finished: false,
      place: null,
      results: null,
      outOfBounds: false,
      // start-gate sub-state (HUD reads these)
      gate: 'countdown',        // 'countdown' | 'open'
      countdown_s: TUNE.countdown_s,
      light: 3,                 // 3 | 2 | 1 | 0 (GO)
      // live run telemetry
      distance_m: 0,
      progress: 0,              // 0..1 down the course
      lateral_m: 0,             // signed offset from the centreline
      confinement: 0,           // 0..1, how hard the corridor is pushing
      speed_mps: 0,
      // observers (frozen into results at the finish)
      landed: 0,
      crashed: 0,
      airTime_s: 0,
      topSpeed_mps: 0,
      _airPeak: 0,
      bestTrick: null,          // { name, points }
      // internals
      _gatePos: null, _gateVel: null, _gateHeading: 0,
      _prevOnGround: true,
      _awardCursor: 0,
      _t: 0,
    };
  }

  // ------------------------------------------------------ phase machine
  // Every transition's side effects live here and nowhere else.
  const PHASES = {
    ready: {
      enter(rs) {
        rs.gate = 'countdown';
        rs.countdown_s = TUNE.countdown_s;
        rs.light = Math.ceil(TUNE.countdown_s);
        rs.time_s = 0;
        rs.finished = false;
        rs.results = null;
        rs.place = null;
      },
      step(rs, ph, ts, dt) {
        holdAtGate(rs, ph);
        rs.countdown_s = Math.max(0, rs.countdown_s - dt);
        rs.light = rs.countdown_s > 0 ? Math.ceil(rs.countdown_s) : 0;
        rs.outOfBounds = false;
        rs.confinement = 0;
        if (rs.countdown_s <= 0) return 'running';
        return null;
      },
      // THE GATE DROPS: hand the rider back the push they arrived with, so the
      // run starts with a shove out of the gate instead of from dead stop.
      exit(rs, ph) {
        rs.gate = 'open';
        rs.light = 0;
        if (ph && rs._gateVel) {
          ph.vel[0] = rs._gateVel[0];
          ph.vel[1] = rs._gateVel[1];
          ph.vel[2] = rs._gateVel[2];
        }
      },
    },

    running: {
      enter(rs, ph) {
        rs.time_s = 0;
        rs._prevOnGround = ph ? !!ph.onGround : true;
        rs._awardCursor = 0;
      },
      step(rs, ph, ts, dt) {
        rs.time_s += dt;
        observe(rs, ph, ts, dt);
        confine(rs, ph, dt, /* postFinish */ false);
        if (ph.pos[2] >= zFinish) return 'finished';   // latch on the crossing frame
        return null;
      },
      exit() {},
    },

    finished: {
      enter(rs, ph, ts) {
        rs.finished = true;
        rs.place = 1;
        rs.results = assemble(rs, ts);   // assembled ONCE, then immutable
      },
      step(rs, ph, ts, dt) {
        runOutCoast(rs, ph, dt);
        confine(rs, ph, dt, /* postFinish */ true);
        return null;
      },
      exit() {},
    },
  };

  function transition(rs, next, ph, ts) {
    PHASES[rs.phase].exit(rs, ph, ts);
    rs.phase = next;
    PHASES[next].enter(rs, ph, ts);
  }

  // --------------------------------------------------------- start gate
  // The gate transform is whatever the rider arrived with on the very first
  // step — captured once, restored every ready frame, handed back on release.
  function captureGate(rs, ph) {
    rs._gatePos = [ph.pos[0], ph.pos[1], ph.pos[2]];
    rs._gateVel = [ph.vel[0], ph.vel[1], ph.vel[2]];
    rs._gateHeading = ph.heading;
  }

  function holdAtGate(rs, ph) {
    if (!rs._gatePos) captureGate(rs, ph);
    ph.pos[0] = rs._gatePos[0];
    ph.pos[1] = rs._gatePos[1];
    ph.pos[2] = rs._gatePos[2];
    ph.vel[0] = TUNE.gateSnapSpeed;
    ph.vel[1] = 0;
    ph.vel[2] = TUNE.gateSnapSpeed;
    ph.heading = rs._gateHeading;
    ph.onGround = true;
    ph.airTime = 0;
    rs.speed_mps = 0;
  }

  // ------------------------------------------------------- observation
  function observe(rs, ph, ts, dt) {
    const sp = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    rs.speed_mps = sp;
    if (sp > rs.topSpeed_mps) rs.topSpeed_mps = sp;
    if (!ph.onGround) rs.airTime_s += dt;

    // touchdown edge -> landed / crashed tally (read-only on physics).
    // Only AIRS count: this terrain bucks the board off the snow for a frame or
    // two constantly, and a results card that reports "landed 54" for one run of
    // chatter is noise. minAir_s is the line between a bump and a jump.
    if (!ph.onGround) rs._airPeak = Math.max(rs._airPeak, ph.airTime ?? 0);
    if (ph.onGround && !rs._prevOnGround) {
      if (rs._airPeak >= TUNE.minAir_s) {
        if (ph.landing === 'crash') rs.crashed++;
        else rs.landed++;
      }
      rs._airPeak = 0;
    }
    rs._prevOnGround = !!ph.onGround;

    // best trick: scan only awards appended since last step
    const aw = ts && ts.awards ? ts.awards : null;
    if (aw) {
      for (let i = rs._awardCursor; i < aw.length; i++) {
        const a = aw[i];
        if (!a || typeof a.points !== 'number') continue;
        if (typeof a.name === 'string' && a.name.indexOf('Star Bonus') >= 0) continue;
        if (!rs.bestTrick || a.points > rs.bestTrick.points)
          rs.bestTrick = { name: a.name, points: a.points };
      }
      rs._awardCursor = aw.length;
    }

    rs.distance_m = Math.max(0, ph.pos[2] - zStart);
    rs.progress = clamp(rs.distance_m / Math.max(1, zFinish - zStart), 0, 1);
  }

  // ------------------------------------------------------- confinement
  //
  // One graded 1-D response, applied on the corridor normal (lateral) and on z
  // (start barrier / run-out corral). `a` is the contract's distance measure,
  // `soft` where the field starts, `hard` where the wall is, `catchAt` where the
  // velocity budget and the positional reel engage.

  function axisField(a, soft, hard) {
    if (a <= soft) return { pen: 0, band: 0 };
    const band = smooth((a - soft) / Math.max(1e-6, hard - soft));   // 0..1 in the berm
    // penetration past the wall, SATURATED: the response is bounded so a rider
    // who starts (or is thrown) far outside is escorted back at a sane rate
    // instead of being flung across the course by an unbounded spring.
    const pen = Math.min(TUNE.penMax,
      Math.max(0, (a - hard) / Math.max(1e-6, hard - soft)));
    return { pen, band };
  }

  // Positional reel-in: exponential in the remaining excess, speed-limited.
  // dt-correct by construction — at 60 Hz this is 0.35 of the excess, <= 0.5 m.
  function reelStep(excess, dt) {
    return Math.min(excess * (1 - Math.exp(-TUNE.reelRate * dt)), TUNE.reelSpeed * dt);
  }

  function confine(rs, ph, dt, postFinish) {
    let pushing = 0;
    let oob = false;

    // ---------- lateral: curved corridor around courseCenterX(z) ----------
    const z = ph.pos[2];
    const cx = center(z);
    const off = ph.pos[0] - cx;                 // contract's |x - courseCenterX(z)|
    const a = Math.abs(off);
    const s = off >= 0 ? 1 : -1;
    rs.lateral_m = off;

    const m = centerSlope(z);
    const tl = Math.hypot(m, 1);
    const tx = m / tl, tz = 1 / tl;             // centreline tangent (down-course)
    const nl = Math.hypot(1, m);
    const inX = -s * (1 / nl), inZ = -s * (-m / nl);   // unit inward normal

    const soft = halfWidth * TUNE.bermFrac;
    const { pen, band } = axisField(a, soft, halfWidth);

    if (band > 0) {
      pushing = Math.max(pushing, clamp(band + pen, 0, 1));
      // (a) inward acceleration — felt in the air too, where heading means nothing
      const acc = TUNE.bermAccel * band + TUNE.wallAccel * pen;
      ph.vel[0] += inX * acc * dt;
      ph.vel[2] += inZ * acc * dt;
      // (b) yaw authority: the berm TURNS the board. Grounded only — in the air
      //     `heading` is the trick system's spin bookkeeping and is not ours.
      if (ph.onGround) {
        const w = TUNE.yawBlend * clamp(band + pen, 0, 1);
        const wx = tx * (1 - w) + inX * w;
        const wz = tz * (1 - w) + inZ * w;
        const want = Math.atan2(wz, wx);
        const omega = TUNE.bermYaw * band + TUNE.wallYaw * pen;
        const d = wrapPi(want - ph.heading);
        const step = clamp(d, -omega * dt, omega * dt);
        ph.heading += step;
      }
      // (c) barrier friction: GRINDING the wall costs you speed. The berm band
      //     itself is free — a banked turn should be rideable, not a tax.
      if (pen > 0) {
        const k = Math.exp(-TUNE.scrub * pen * dt);
        ph.vel[0] *= k; ph.vel[1] *= k; ph.vel[2] *= k;
      }
      // (d) closing-rate ceiling: the corridor escorts, it never slingshots.
      const vIn = -(s * (ph.vel[0] - m * ph.vel[2]));
      if (vIn > TUNE.vInMax) ph.vel[0] += s * (vIn - TUNE.vInMax);
    }
    if (a > halfWidth) oob = true;

    // (e) catch band: bound penetration by construction
    const catchAt = halfWidth * TUNE.catchFrac;
    if (a > catchAt) {
      const excess = a - catchAt;
      // outward rate of |x - cx| includes the centreline's own drift with z
      const vOut = s * (ph.vel[0] - m * ph.vel[2]);
      const budget = Math.max(0, TUNE.vOut0 * (1 - excess / TUNE.vOutFade));
      if (vOut > budget) ph.vel[0] -= s * (vOut - budget);
      // (f) soft reel-in, never a snap
      const pull = reelStep(excess, dt);
      ph.pos[0] -= s * pull;
      ph.pos[1] = groundClamp(ph, ph.pos[0], ph.pos[2]);
      pushing = 1;
      oob = true;
    }

    // ---------- longitudinal: start barrier and run-out corral ----------
    const zSoftTop = zBermIn + TUNE.topMargin * 0.5;
    if (z < zSoftTop) {
      const av = zSoftTop - z;
      const f = axisField(av, 0, TUNE.topMargin * 0.5);
      const acc = TUNE.bermAccel * f.band + TUNE.wallAccel * f.pen;
      ph.vel[2] += acc * dt;
      if (ph.vel[2] > TUNE.vInMax) ph.vel[2] = TUNE.vInMax;
      pushing = Math.max(pushing, clamp(f.band + f.pen, 0, 1));
      if (z < zBermIn) {
        oob = true;
        const excess = zBermIn - z;
        const budget = Math.max(0, TUNE.vOut0 * (1 - excess / TUNE.vOutFade));
        if (-ph.vel[2] > budget) ph.vel[2] = -budget;
        const pull = reelStep(excess, dt);
        ph.pos[2] += pull;
        ph.pos[1] = groundClamp(ph, ph.pos[0], ph.pos[2]);
      }
    }

    if (postFinish && z > zSlow) {
      const f = axisField(z, zSlow, zRunEnd);
      const acc = TUNE.bermAccel * f.band + TUNE.wallAccel * f.pen;
      ph.vel[2] -= acc * dt;
      if (ph.vel[2] < -TUNE.vInMax) ph.vel[2] = -TUNE.vInMax;
      pushing = Math.max(pushing, clamp(f.band + f.pen, 0, 1));
      if (z > zRunEnd) {
        oob = true;
        const excess = z - zRunEnd;
        const budget = Math.max(0, TUNE.vOut0 * (1 - excess / TUNE.vOutFade));
        if (ph.vel[2] > budget) ph.vel[2] = budget;
        const pull = reelStep(excess, dt);
        ph.pos[2] -= pull;
        ph.pos[1] = groundClamp(ph, ph.pos[0], ph.pos[2]);
      }
    }

    rs.confinement = pushing;
    rs.outOfBounds = oob;
  }

  // positional corrections follow the ground instead of leaving the rider
  // hanging in (or under) the surface — and never lift an airborne rider.
  function groundClamp(ph, x, z) {
    const h = sampleHeight(x, z);
    if (ph.onGround) return h;
    return ph.pos[1] < h ? h : ph.pos[1];
  }

  // ------------------------------------------------------- run-out coast
  function runOutCoast(rs, ph, dt) {
    const k = Math.exp(-dt / TUNE.tauStop);
    ph.vel[0] *= k; ph.vel[1] *= k; ph.vel[2] *= k;
    const sp = Math.hypot(ph.vel[0], ph.vel[1], ph.vel[2]);
    if (sp < 0.25) { ph.vel[0] = 0; ph.vel[1] = 0; ph.vel[2] = 0; }
    rs.speed_mps = sp;
  }

  // ----------------------------------------------------------- results
  function grade(score) {
    for (const [min, g] of GRADES) if (score >= min) return g;
    return 'D';
  }

  function assemble(rs, ts) {
    const score = ts && typeof ts.score === 'number' ? ts.score : 0;
    const best = rs.bestTrick;
    const r = {
      // contract-required six
      time_s: rs.time_s,
      score,
      bestTrick: best ? best.name : 'None',
      tricky: !!(ts && ts.tricky),
      landed: rs.landed,
      crashed: rs.crashed,
      // the rest of the SSX results card
      bestTrickPoints: best ? best.points : 0,
      trickyLetters: ts && typeof ts.trickyLetters === 'number' ? ts.trickyLetters : 0,
      airTime_s: rs.airTime_s,
      topSpeed_kmh: rs.topSpeed_mps * 3.6,
      distance_m: zFinish - zStart,
      place: 1,
      grade: grade(score),
    };
    return Object.freeze(r);
  }

  // -------------------------------------------------------------- step
  function step(rstate, physState, tstate, dt) {
    rstate._t += dt;
    // capture the gate transform the first time we ever see the rider
    if (!rstate._gatePos && physState) captureGate(rstate, physState);
    // At most ONE transition per step: the phase that requested it has already
    // done its work this frame, and the phase we move into starts on the next.
    const next = PHASES[rstate.phase].step(rstate, physState, tstate, dt);
    if (next) transition(rstate, next, physState, tstate);
    return rstate;
  }

  // ----------------------------------------------------------- public
  return {
    config,

    init,

    step,

    results(rstate, tstate) {
      if (rstate.results) return rstate.results;      // frozen at the finish
      return assemble(rstate, tstate);                // live provisional
    },

    restart(rstate) {
      const fresh = init();
      for (const k of Object.keys(rstate)) delete rstate[k];
      Object.assign(rstate, fresh);
      PHASES.ready.enter(rstate);
      return rstate;
    },

    // Optional game-layer hook: drop the gate early (press-to-start). The
    // harness never calls it; the countdown auto-releases on its own.
    open(rstate) {
      if (rstate.phase === 'ready') rstate.countdown_s = 0;
      return rstate;
    },

    // Debug/HUD: where the corridor walls are at this z.
    corridorAt(z) {
      const cx = center(z);
      return { center: cx, left: cx - halfWidth, right: cx + halfWidth,
        berm: halfWidth * TUNE.bermFrac };
    },
  };
}
