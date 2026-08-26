// Candidate B — rail grinding (arclength state + inverted-pendulum balance)
//
// SHAPE (the seed, taken literally):
//   * On lock the rail becomes a 1-D problem: (s, ds/dt) along the polyline.
//     Both are integrated CLOSED FORM (linear ODE => dt-split exact, GR-09).
//     The polyline is read only to (a) place the rider, (b) read curvature.
//   * Balance is a linearised inverted pendulum in the rail's lateral axis:
//     x_c (CoM lateral offset, m), second order, so it OVERSHOOTS and can be
//     lost by a player watching it. balance = x_c / x_max.
//   * Motion is delivered to physics as VELOCITY ONLY — a spring constraint to
//     the rail point plus the tangent velocity. GR-07 is therefore structural
//     here, not a promise: there is exactly one ps.pos write in this file and
//     it is the lock-on snap.
//
// TWO MEASURED CONTRACT FINDINGS (numbers in config.findings; see the return
// message). Both are about physics' CONSTRAINED branch, not about this module:
//   F1  constrainedStep integrates nothing, so a continuously-constrained
//       grind does not move: 3.0 s constrained at 18 m/s travels 0.000 m.
//   F2  constrainedStep runs no ROTATION either (3.0 s of spin=1 while
//       constrained leaves spinDeg at 0.0), and a constrained jumpRelease is a
//       TRUE takeoff, which zeroes it (spinDeg 815 -> 0.0). GR-10 requires
//       rail spin to survive the exit. Both cannot hold.
//   So `constrained` is set exactly where it pays and cannot harm: while the
//   rider is LOADING a pop (crouch held on the rail). That is the whole reason
//   the state was added — charge on a rail — and during that window the
//   along-rail state is held in lockstep so nothing desynchronises.
//
// Pure math, deterministic, no Date/random, no imports.

const G = 9.81;              // m/s^2, physics G_GROUND
const RIDER_H = 1.8;         // m, contract rider height
const RIDER_M = 80;          // kg, contract rider mass
const LAMBDA_SNOW = 0.2235;  // 1/s, physics LAMBDA_LONG
const MU_SNOW = 0.0305;      // physics MU_BASE
const V_BOOST = 31;          // m/s, physics V_BOOST
const V_CAP = 33;            // m/s, physics V_CAP (never exceeded here)
const TAU_BOOST = 0.7;       // s, physics TAU_BOOST

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------
// Rail geometry: polyline -> arclength table. Built once per rail at create().
// ---------------------------------------------------------------------------
function buildRail(r) {
  const P = r.points.map(p => [p[0], p[1], p[2]]);
  const seg = [];
  let L = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1];
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    if (len < 1e-9) continue;
    seg.push({ a, dir: [d[0] / len, d[1] / len, d[2] / len], len, s0: L });
    L += len;
  }
  return { id: r.id, width: r.width ?? 0.2, seg, L };
}

// Point + unit tangent at arclength s (clamped to the rail).
function atS(R, s) {
  const q = clamp(s, 0, R.L);
  let i = 0;
  while (i + 1 < R.seg.length && R.seg[i].s0 + R.seg[i].len < q) i++;
  const g = R.seg[i], u = clamp(q - g.s0, 0, g.len);
  return {
    p: [g.a[0] + g.dir[0] * u, g.a[1] + g.dir[1] * u, g.a[2] + g.dir[2] * u],
    T: g.dir,
  };
}

// Closest point on the rail to a world position: {s, d, p, T}.
function closest(R, P) {
  let best = null;
  for (const g of R.seg) {
    const w = [P[0] - g.a[0], P[1] - g.a[1], P[2] - g.a[2]];
    const u = clamp(w[0] * g.dir[0] + w[1] * g.dir[1] + w[2] * g.dir[2], 0, g.len);
    const p = [g.a[0] + g.dir[0] * u, g.a[1] + g.dir[1] * u, g.a[2] + g.dir[2] * u];
    const d = Math.hypot(P[0] - p[0], P[1] - p[1], P[2] - p[2]);
    if (!best || d < best.d) best = { s: g.s0 + u, d, p, T: g.dir };
  }
  return best;
}

// Signed lateral (yaw) curvature about world-up, by central difference of the
// chord direction over +/- LOOK metres. A polyline's curvature is impulsive at
// the joints, so it must be read over a window, not per segment; LOOK = one
// board length, the shortest window the board itself can average over.
function curvatureAt(R, s, LOOK) {
  const h = Math.min(LOOK, R.L * 0.5);
  const a = atS(R, s - h).p, b = atS(R, s).p, c = atS(R, s + h).p;
  const t1 = [b[0] - a[0], b[2] - a[2]], t2 = [c[0] - b[0], c[2] - b[2]];
  const l1 = Math.hypot(t1[0], t1[1]), l2 = Math.hypot(t2[0], t2[1]);
  if (l1 < 1e-9 || l2 < 1e-9) return 0;
  const cross = (t1[0] * t2[1] - t1[1] * t2[0]) / (l1 * l2);
  const dpsi = Math.asin(clamp(cross, -1, 1));       // signed turn about +Y
  const arc = Math.min(s + h, R.L) - Math.max(s - h, 0);
  return arc > 1e-9 ? dpsi / arc : 0;                 // 1/m
}

export function createRails(env) {
  const rails = (env.rails ?? []).map(buildRail).filter(R => R.seg.length > 0);

  // =========================== DERIVED CONSTANTS ===========================
  // Every number below is either computed from a project-wide physics constant,
  // from the contract's rider (1.8 m / 80 kg), from the research corpus, or is
  // labelled CHOICE with its cost. Nothing is read from the runner.

  // --- rail resistive law -------------------------------------------------
  // research 02 sec 1.5: "You go faster boosting on a rail than boosting on the
  // snow"; the pseudocode block adds "drag ~ 0 (rail faster than snow)". A rail
  // removes the snow-deformation and ploughing terms entirely; what is left on
  // the rider is aerodynamic drag. Linearise it at the speed the SOURCED claim
  // is about — boost speed, physics V_BOOST = 31 m/s (NOT any probe speed):
  //   a_air(v) = 0.5*rho*CdA*v^2/m ,  rho = 1.0 kg/m^3 (~2000 m alpine),
  //   CdA = 0.6 m^2 (upright rider), m = 80 kg
  //   LAMBDA_RAIL = 0.5*rho*CdA*V_BOOST/m = 0.11625 1/s
  const RHO = 1.0, CDA = 0.6;
  const LAMBDA_RAIL = 0.5 * RHO * CDA * V_BOOST / RIDER_M;      // 0.11625 1/s
  const dragScale = LAMBDA_RAIL / LAMBDA_SNOW;                  // 0.520134 (<1)

  // Boosting on a rail: physics' snow boost relaxes to V_BOOST, i.e. its thrust
  // is exactly what balances SNOW drag at 31 m/s:
  //   D = MU*g + LAMBDA_SNOW*V_BOOST = 7.2277 m/s^2
  // The same thrust against rail drag alone balances at D/LAMBDA_RAIL = 62.2
  // m/s, far above the engine clamp, so the rail boost target IS V_CAP. That is
  // the sourced sentence, delivered without ever exceeding physics' own cap.
  const D_BOOST = MU_SNOW * G + LAMBDA_SNOW * V_BOOST;          // 7.2277
  const V_RAIL_BOOST = Math.min(V_CAP, D_BOOST / LAMBDA_RAIL);  // 33 (clamped)

  // --- capture ------------------------------------------------------------
  // research 02 sec 1.5 [EST]: "capture radius ~0.5-1.0 board-length (~0.5-1.5
  // m)". CHOICE: the centre of the cited band. Cost: 1.5 would feel magnetic
  // and would capture a rider who visibly missed; 0.5 would make an auto-lock
  // verb (no button) frustrating on a fast, imprecise landing.
  const captureRadius_m = 1.0;

  // Board length: standard freestyle sizing is ~0.86 x rider height.
  const BOARD_L = 0.86 * RIDER_H;                               // 1.548 m
  // Pendulum time constant of the rider on the rail (below).
  const L_COM = 0.55 * RIDER_H;                                 // 0.99 m
  const TAU_PEND = Math.sqrt(L_COM / G);                        // 0.3177 s
  // minLockSpeed: below the speed at which the board travels its own length
  // within one pendulum time constant, the rider is standing on a rail, not
  // grinding it — there is no slide to balance against.
  const minLockSpeed_mps = BOARD_L / TAU_PEND;                  // 4.8722 m/s
  // Re-lock cooldown: the time gravity needs to carry a bailed rider one
  // capture radius clear of the line, sqrt(2R/g).
  const RELOCK_COOL = Math.sqrt(2 * captureRadius_m / G);       // 0.4515 s

  // --- balance: linearised inverted pendulum ------------------------------
  //   x_c'' = w0^2 * x_c - c * x_c' + a_dist + a_steer
  // w0^2 = g/L_COM (rider CoM 55% of standing height, standard anthropometry).
  const W0 = Math.sqrt(G / L_COM);                              // 3.1483 rad/s
  // Postural damping at the ankles. Human quiet-stance models put the ankle
  // damping ratio at 0.3-0.7 of the pendulum frequency. CHOICE: band centre
  // 0.5. Cost: lower makes the rail ring for seconds after every correction;
  // higher makes it first-order and unlosable (the failure the carry-forward
  // notes call out).
  const ZETA = 0.5;
  const C_ANKLE = 2 * ZETA * W0;                                // 3.1483 1/s
  // Bail threshold in metres of CoM offset: half the rail's own top width. The
  // board tips off the steel when the CoM leaves the support. Per-rail (env).
  const xMaxOf = R => Math.max(R.width * 0.5, 0.02);
  // curveTolerance_rad = the lean angle at that offset, atan(x_max / L_COM).
  const curveTolerance_rad = Math.atan(0.5 * (rails[0]?.width ?? 0.2) / L_COM);

  // Second damping source, and the one that makes the mechanic PLAYABLE: the
  // board is resting on steel, so lateral CoM drift is scrubbed by contact
  // friction. Coulomb mu_r ~ 0.15 (P-tex/steel edge on steel), linearised at
  // the lateral speed that DEFINES a bail — v_ref = x_max / TAU_PEND, the speed
  // at which the CoM crosses the whole support half-width in one divergence
  // time. c_rail = mu_r*g / v_ref. Wider rail => larger v_ref => less damping
  // per metre but more room, which is the right direction: wide rails forgive.
  // MEASURED CONSEQUENCE (this is why the term is here, not decoration): with
  // ankle damping alone the correction loop LIMIT-CYCLES against the 60 Hz
  // step — a proportional player controller sat at |balance| 0.85 forever,
  // mean stick 0.476 on a STRAIGHT rail, and bounced off at 8.1 s. With rail
  // contact damping the same controller sits at mean stick 0.0067 and holds
  // indefinitely. First-order damping is not cosmetic here.
  const MU_RAIL = 0.15;
  const cDampOf = R => C_ANKLE + MU_RAIL * G / (xMaxOf(R) / TAU_PEND);

  // Correction authority. Correcting on a rail is a WEIGHT SHIFT, not a carve:
  // the board cannot push sideways against a 0.2 m strip of steel (that just
  // slides it off), so the ceiling is the lateral accel a rider generates by
  // leaning, a = g*tan(phi). phi = 30 deg is the corpus' own normal riding lean
  // (research 02 assertion 10: "30 deg normal vs ~55 deg braking lean, Tux
  // Racer"). => 5.664 m/s^2. NOT physics' A_LAT = 26: that is a carving board
  // biting a whole edge into snow, and using it made an R=40 arc cost 11% stick
  // instead of 43% — a curved rail that demands nothing.
  const PHI_LEAN = 30 * Math.PI / 180;
  const A_STEER = G * Math.tan(PHI_LEAN);                       // 5.6644 m/s^2

  // Destabilising bias — WHY A PASSIVE GRIND ENDS.
  //  (a) stance asymmetry: the rider's CoM does not sit exactly over the rail.
  //      CHOICE d0 = 2 mm (2% of the 100 mm half-width). Cost: this single
  //      number sets the passive bail clock (measured 2.87 s at 18 m/s,
  //      3.4 s at rest); halving it adds ~0.62 s, one divergence doubling time.
  //  (b) aerodynamic side force: a rider is not laterally symmetric (shoulders
  //      squared across the board, one arm out). Asymmetric side area
  //      dCdA = 0.02 m^2 gives a_side = 0.5*rho*dCdA*v^2/m — this is the term
  //      that makes instability GROW WITH SPEED, as the seed asks: 0.019 m/s^2
  //      of stance bias vs 0.041 m/s^2 of aero at 18 m/s, 0.12 at 31 m/s.
  const D_STANCE = 0.002;                                       // m
  const A_STANCE = W0 * W0 * D_STANCE;                          // 0.01982 m/s^2
  const DCDA_LAT = 0.02;                                        // m^2
  const K_AERO_LAT = 0.5 * RHO * DCDA_LAT / RIDER_M;            // 1.25e-4 1/m

  // Divergence roots of the UNCORRECTED pendulum: s^2 + c*s - w0^2 = 0.
  // Per rail, because c depends on the rail's support width.
  const rootsOf = (R) => {
    const c = cDampOf(R);
    const disc = Math.sqrt(c * c + 4 * W0 * W0);
    return { c, s1: (-c + disc) / 2, s2: (-c - disc) / 2 };
  };
  const REF_ROOTS = rootsOf(rails[0] ?? { width: 0.2 });          // 0.2 m rail:
  // c = 7.8226, s1 = +1.1094 (unstable), s2 = -8.9320 (decaying)
  // Contract field: the growing mode's |ln2 / root| clock. Balance is UNSTABLE,
  // so this is a doubling time, reported in the field the contract asks for.
  const balanceHalfLife_s = Math.log(2) / REF_ROOTS.s1;           // 0.6249 s

  // Rail constraint stiffness. The rider is held on the rail by a velocity-
  // level spring (position writes are forbidden), relaxation time 3 physics
  // frames at 60 Hz. CHOICE tau = 0.05 s. Cost: stiffer chatters against the
  // 60 Hz step, softer lets gravity sag the rider off an elevated rail. At
  // tau = 0.05 s the steady sag under G_AIR is G_AIR*dt/K = 5.4 mm.
  const TAU_HOLD = 0.05;
  const K_HOLD = 1 / TAU_HOLD;                                   // 20 1/s

  const config = {
    // --- contract-required ---
    captureRadius_m,
    dragScale: +dragScale.toFixed(6),
    balanceHalfLife_s: +balanceHalfLife_s.toFixed(6),
    curveTolerance_rad: +curveTolerance_rad.toFixed(6),
    minLockSpeed_mps: +minLockSpeed_mps.toFixed(6),
    // --- resolved model constants ---
    lambdaRail_perS: +LAMBDA_RAIL.toFixed(6),
    railBoostTarget_mps: V_RAIL_BOOST,
    relockCooldown_s: +RELOCK_COOL.toFixed(6),
    pendulumOmega_radps: +W0.toFixed(6),
    pendulumDamping_perS: +REF_ROOTS.c.toFixed(6),
    ankleDamping_perS: +C_ANKLE.toFixed(6),
    railContactDamping_perS: +(REF_ROOTS.c - C_ANKLE).toFixed(6),
    steerAuthority_mps2: +A_STEER.toFixed(6),
    stanceBias_mps2: +A_STANCE.toFixed(6),
    aeroSideGain_perM: K_AERO_LAT,
    holdStiffness_perS: K_HOLD,
    curvatureWindow_m: +BOARD_L.toFixed(4),
    unstableRoot_perS: +REF_ROOTS.s1.toFixed(6),
    stableRoot_perS: +REF_ROOTS.s2.toFixed(6),

    derivation: {
      dragScale:
        'rail removes snow ploughing; residual resistance is aero. ' +
        'LAMBDA_RAIL = 0.5*rho*CdA*V_BOOST/m = 0.5*1.0*0.6*31/80 = 0.11625 1/s; ' +
        'dragScale = 0.11625 / LAMBDA_LONG(0.2235) = 0.5201. Linearised at ' +
        'V_BOOST because the sourced claim is about BOOSTING on a rail. No ' +
        'Coulomb term on steel (research 02: "drag ~ 0").',
      railBoostTarget:
        'physics snow-boost thrust D = MU*g + LAMBDA_SNOW*V_BOOST = 7.2277; ' +
        'against rail drag alone D/LAMBDA_RAIL = 62.2 m/s, above V_CAP, so the ' +
        'target is V_CAP = 33 > snow 31. "Faster boosting on a rail" falls out ' +
        'of the two drag laws; it is not a hand-set bonus.',
      captureRadius_m:
        'CHOICE at the centre of the cited [EST] band 0.5-1.5 m (research 02 ' +
        'sec 1.5). Cost: 1.5 captures visible misses, 0.5 makes a no-button ' +
        'verb frustrating.',
      minLockSpeed_mps:
        'board length (0.86*1.8 = 1.548 m) / pendulum time constant ' +
        'sqrt(L_COM/g) = 0.3177 s => 4.872 m/s. Below it the board does not ' +
        'travel its own length inside one divergence time: standing, not ' +
        'grinding.',
      balance:
        'linearised inverted pendulum about the rail contact line. ' +
        'L_COM = 0.55*1.8 = 0.99 m (CoM fraction of standing height), ' +
        'w0 = sqrt(g/L_COM) = 3.1483 rad/s. Damping is two terms: ankle ' +
        'damping ratio ZETA = 0.5 (CHOICE, centre of the 0.3-0.7 quiet-stance ' +
        'band) => 3.1483 1/s, PLUS rail contact friction mu_r*g/v_ref = 4.674 ' +
        '1/s with mu_r = 0.15 and v_ref = x_max/TAU_PEND = 0.3147 m/s. ' +
        'c = 7.823, roots +1.1094 / -8.9320: SECOND ORDER, so corrections ' +
        'overshoot and balance can be lost while watching it.',
      whyContactDampingIsNotOptional:
        'MEASURED. With ankle damping alone (c = 3.148) the correction loop is ' +
        'unstable against the 60 Hz step: a proportional controller (the GR-06 ' +
        'effort probe, steer = 3*balance) limit-cycled at |balance| 0.85 with ' +
        'mean stick 0.4763 on a STRAIGHT rail and bounced off at 8.1 s; the ' +
        'bang-bang hold retained only 0.81 of the window. Adding contact ' +
        'damping: mean stick 0.0067 straight, hold 1.00, passive bail 1.72 -> ' +
        '2.87 s. The GR-06 signal-to-noise went from 1.7x to 30-65x.',
      bailThreshold:
        'x_max = rail.width/2 (env-supplied, 0.10 m on the test rails): the ' +
        'CoM leaves the steel it is supported by. curveTolerance_rad is the ' +
        'same limit as a lean angle, atan(x_max/L_COM) = 0.1006 rad.',
      destabiliser:
        'stance offset d0 = 2 mm (CHOICE) => a = w0^2*d0 = 0.0198 m/s^2, plus ' +
        'aero side force 0.5*rho*dCdA*v^2/m with dCdA = 0.02 m^2 => 0.041 at ' +
        '18 m/s, 0.120 at 31 m/s. The aero term is why instability grows with ' +
        'speed. Measured passive bail: 2.87 s at 18 m/s, 3.4 s at rest — mid ' +
        'band of the declared 0.8-6 s window, not against either edge.',
      steerAuthority:
        'g*tan(30 deg) = 5.664 m/s^2. Correcting on a rail is a WEIGHT SHIFT, ' +
        'not a carve — a board cannot push sideways against a 0.2 m strip of ' +
        'steel. 30 deg is the corpus normal riding lean (research 02 assertion ' +
        '10, "30 deg normal vs ~55 deg braking lean"). REJECTED alternative: ' +
        'physics A_LAT = 26 m/s^2 also passes every gate, but it makes an R=40 ' +
        'arc at 18 m/s cost 11% stick instead of 43% — a curved rail that ' +
        'demands nothing. Cost of 5.664: the tightest rail holdable at 25 m/s ' +
        'is R ~ 110 m; tighter kinks need the player to be slower.',
      gravityAlongTangent:
        'ds/dt driven by -g*T_y. Every test rail in the runner is at CONSTANT ' +
        'height so this term is invisible there; it is included because a real ' +
        'rail descends. Capture likewise uses the FULL 3-D velocity along T, ' +
        'not the horizontal part: horizontal-only capture taxes a rider 9.4% ' +
        'at 25 deg and 23% at 40 deg, on the exact case a rail should win.',
      holdStiffness:
        'CHOICE tau = 0.05 s (3 frames at 60 Hz). The rider is pinned to the ' +
        'rail by VELOCITY only — this module writes ps.pos exactly once per ' +
        'lock. Steady vertical sag against G_AIR = G_AIR*dt/K = 5.4 mm.',
    },

    findings: {
      F1_constrainedDoesNotMove:
        'MEASURED: physics constrainedStep integrates nothing. 3.0 s at 18 m/s ' +
        'with constrained=true travels 0.000 m. A grind held constrained ' +
        'end-to-end freezes the rider in place. FIX (one line, in ' +
        'constrainedStep): pos[i] += vel[i]*dt. VERIFIED SAFE: with that line ' +
        'added, harness/physics-runner reports 54 pass / 0 fail / 0 hardFails, ' +
        'unchanged, and PC-14 = 1, PC-15 = 5.00 m/s, PC-16 = 1 all still pass ' +
        '(PC-16 asserts pos[1], vel[1] and airTime only, and a rail-tangent ' +
        'velocity has vel[1] = 0 on the flat rail it tests). I did not apply ' +
        'it: src/physics is observe-only for this lane.',
      F2_constrainedPopVsGR10:
        'MEASURED, two independent halves. (i) constrainedStep runs no rotation: ' +
        '3.0 s of spin=1 while constrained leaves spinDeg at 0.0, so no rail ' +
        'spin accrues at all. (ii) a constrained jumpRelease is a TRUE takeoff ' +
        'and zeroes it: spinDeg 815 -> 0.0 across one release step (PC-15 ' +
        'asserts exactly that reset). GR-10 requires rail spin to SURVIVE the ' +
        'exit (>= 0.9 preserved), citing the reference line "keep on pressing ' +
        'that to do rail spins". CONTRACT CONFLICT: continuous constraint and ' +
        'GR-10 cannot both hold. Unlike F1 this needs a design decision, not a ' +
        'one-line fix — either constrainedStep gains the airStep rotation ' +
        'block and a non-resetting release, or GR-10 exempts a charged exit. ' +
        'Only the gate owner can pick.',
      resolutionUsedHere:
        'constrained = true exactly while the rider LOADS a pop (crouch held ' +
        'on the rail) — the one thing the state was added for. Outside that ' +
        'window the rider is an ordinary airborne body pinned to the rail by a ' +
        'velocity constraint, which is what makes rail spins accrue and ' +
        'survive. The along-rail state is frozen in lockstep with the ' +
        'constrained window so the two never desynchronise; the visible cost ' +
        'is that along-rail travel pauses while loading. F1 fixed, that ' +
        'freeze and this whole special case both delete.',
      verifiedElsewhere:
        'descending-rail probe (the runner has none — every test rail is at ' +
        'constant height, which the BACKLOG notes once hid a missing gravity ' +
        'term). Capture loss vs |v| measured 0.00% at 0/15/25/40 deg; a ' +
        'horizontal-only capture on the same runs would have lost 3.4% at 15 ' +
        'deg, 9.4% at 25 and 23.4% at 40, reproducing the carry-forward ' +
        'numbers exactly. Gravity along tangent: end-of-grind speed 8.6 (flat) ' +
        '/ 19.6 (15 deg) / 26.5 (25 deg) / 33.0 (40 deg, at V_CAP, never ' +
        'above). Boost on a flat rail settles at 33.0 m/s vs physics snow ' +
        'boost 31 — the sourced sentence, delivered by the drag laws.',
      meterNotTicked:
        'constrainedStep does not run meterTick either, so boostMeter neither ' +
        'drains nor regenerates while constrained. This module only READS ' +
        'ps.boostMeter and never writes it.',
    },
  };

  // ------------------------------------------------------------------ state
  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // internals
      _s: 0, _xc: 0, _xd: 0, _s1: REF_ROOTS.s1, _s2: REF_ROOTS.s2,
      _cool: 0, _R: null, _lat: [1, 0, 0],
      _held: false,
    };
  }

  function release(gs, ps, bailed) {
    if (gs.onRail) gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    gs.onRail = false; gs.railId = null; gs.bailed = !!bailed;
    gs._R = null; gs._cool = RELOCK_COOL;
    if (ps.constrained) ps.constrained = false;
    gs._held = false;
  }

  function step(gs, ps, input, dt) {
    const inp = input ?? {};
    if (!(dt > 0)) return gs;

    // Physics ends the grind itself when a charged pop fires out of the
    // constrained state (it clears `constrained` and takes off). Honour it.
    if (gs.onRail && gs._held && ps.constrained === false) {
      release(gs, ps, false);              // speed + prewind already carried by
      return gs;                           // physics; touch NOTHING this frame.
    }

    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    // ------------------------------------------------------------ CAPTURE
    if (!gs.onRail) {
      gs.balance = 0;
      const sp3 = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
      if (gs._cool <= 0 && sp3 >= minLockSpeed_mps) {
        let best = null;
        for (const R of rails) {
          const c = closest(R, ps.pos);
          if (c && c.d <= captureRadius_m && (!best || c.d < best.c.d)) best = { R, c };
        }
        if (best) {
          const { R, c } = best;
          // Along-rail speed from the FULL 3-D velocity along the tangent, so a
          // descending rail is not taxed for its descent.
          const along = ps.vel[0] * c.T[0] + ps.vel[1] * c.T[1] + ps.vel[2] * c.T[2];
          if (Math.abs(along) >= minLockSpeed_mps) {
            // THE ONE POSITION WRITE IN THIS MODULE: the documented lock-on
            // snap to the closest point on the polyline (|snap| <= capture
            // radius by construction).
            ps.pos[0] = c.p[0]; ps.pos[1] = c.p[1]; ps.pos[2] = c.p[2];
            gs.onRail = true; gs.bailed = false; gs.railId = R.id;
            gs._R = R; gs._s = c.s; gs.alongSpeed = along;
            const rt = rootsOf(R); gs._s1 = rt.s1; gs._s2 = rt.s2;
            gs.t = R.L > 0 ? c.s / R.L : 0;
            gs.lockFrames = 0;
            // The snap absorbs the lateral OFFSET but not the lateral
            // MOMENTUM: the rider arrives already tipping if they came in
            // crooked. lat = horizontal normal to the tangent.
            const lh = Math.hypot(c.T[0], c.T[2]) || 1;
            const lat = [-c.T[2] / lh, 0, c.T[0] / lh];
            gs._lat = lat;
            gs._xc = 0;
            gs._xd = ps.vel[0] * lat[0] + ps.vel[2] * lat[2];
            gs.balance = 0;
            gs._held = false;
          }
        }
      }
      return gs;
    }

    // ------------------------------------------------------- ON RAIL
    const R = gs._R;
    const xMax = xMaxOf(R);

    // Loading a pop: hand the rider to physics' CONSTRAINED branch so crouch
    // charge accrues at T_CHARGE and the release is a true, full-charge
    // takeoff. Physics supplies no motion there (finding F1), so the 1-D state
    // is held in lockstep — nothing drifts apart, and it resumes untouched.
    const loading = !!inp.crouch;
    if (loading !== gs._held) { ps.constrained = loading; gs._held = loading; }

    // --- lateral axis at the current arclength ---
    const here = atS(R, gs._s);
    const lh = Math.hypot(here.T[0], here.T[2]) || 1;
    const lat = [-here.T[2] / lh, 0, here.T[0] / lh];
    gs._lat = lat;

    // --- 1-D along-rail dynamics: dv/dt = a - b*v, closed form -------------
    let v = gs.alongSpeed;
    if (!loading) {
      const gTan = -G * here.T[1];                    // gravity along tangent
      const b = LAMBDA_RAIL;
      const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
      if (boosting) {
        // Same relaxation shape physics uses for snow boost, but toward the
        // rail's own (drag-derived) target. Closed form => dt-exact.
        const nat = gTan > 0 ? gTan / b : 0;
        const target = Math.min(V_CAP, Math.max(V_RAIL_BOOST, nat));
        const sgn = v < 0 ? -1 : 1, mag = Math.abs(v);
        const nm = mag < target
          ? target + (mag - target) * Math.exp(-dt / TAU_BOOST)
          : gTan / b + (mag - gTan / b) * Math.exp(-b * dt);
        v = sgn * nm;
      } else {
        const veq = gTan / b;
        v = veq + (v - veq) * Math.exp(-b * dt);
      }
      // Never clamp ABOVE physics' own cap.
      v = clamp(v, -V_CAP, V_CAP);
      // Closed-form arclength advance over the same step (exact integral of the
      // exponential flow, so s is dt-split exact too).
      const v0 = gs.alongSpeed, b2 = LAMBDA_RAIL;
      const veq2 = -G * here.T[1] / b2;
      const ds = veq2 * dt + (v0 - veq2) * (1 - Math.exp(-b2 * dt)) / b2;
      gs._s += ds;
      gs.alongSpeed = v;
    }

    // --- balance: second-order inverted pendulum, exact over the step ------
    const kappa = curvatureAt(R, gs._s, BOARD_L);
    // Cornering throws the CoM to the OUTSIDE of the bend: a = -v^2 * kappa
    // in the lateral axis. Speed-squared, so a fast rail is a demanding rail.
    const aCurve = -v * v * kappa;
    const aBias = A_STANCE + K_AERO_LAT * v * v;      // grows with speed
    const steer = clamp(inp.steer ?? 0, -1, 1);
    // BALANCE SIGN: positive steer must REDUCE positive balance.
    const aSteer = -steer * A_STEER;
    const F = aCurve + aBias + aSteer;

    // x'' = w0^2 x - c x' + F over dt, F constant across the step.
    const xp = -F / (W0 * W0);
    const u0 = gs._xc - xp, ud0 = gs._xd;
    const s1 = gs._s1, s2 = gs._s2, den = s1 - s2;
    const A = (ud0 - s2 * u0) / den, B = (s1 * u0 - ud0) / den;
    const e1 = Math.exp(s1 * dt), e2 = Math.exp(s2 * dt);
    gs._xc = xp + A * e1 + B * e2;
    gs._xd = A * s1 * e1 + B * s2 * e2;
    gs.balance = gs._xc / xMax;

    gs.lockFrames++;
    gs.t = R.L > 0 ? clamp(gs._s / R.L, 0, 1) : 0;

    // --------------------------------------------------------- LEAVE TESTS
    if (Math.abs(gs.balance) > 1) { release(gs, ps, true); return gs; }
    if (inp.jumpRelease) {
      // Speed and prewind are carried by physics: the horizontal velocity we
      // wrote last frame is the rail-tangent velocity and nothing here touches
      // it, so the exit is loss-free by construction.
      release(gs, ps, false); return gs;
    }
    if (gs._s <= 0 || gs._s >= R.L) { release(gs, ps, false); return gs; }
    if (Math.abs(v) < minLockSpeed_mps * 0.5) { release(gs, ps, false); return gs; }

    // ----------------------------------------------- DELIVER MOTION (VEL)
    // While `loading`, physics is in its constrained branch and integrates
    // nothing; leave the velocity exactly as it was so the pop takes off along
    // the rail. Otherwise pin the rider with tangent velocity + a spring
    // constraint back to the rail point. Velocity only — never position.
    if (!loading) {
      const now = atS(R, gs._s);
      ps.vel[0] = now.T[0] * v + K_HOLD * (now.p[0] - ps.pos[0]);
      ps.vel[1] = now.T[1] * v + K_HOLD * (now.p[1] - ps.pos[1]);
      ps.vel[2] = now.T[2] * v + K_HOLD * (now.p[2] - ps.pos[2]);
    }
    return gs;
  }

  return { config, init, step };
}
