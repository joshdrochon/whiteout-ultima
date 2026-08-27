// Candidate B — snowboard physics core (SSX Tricky arcade feel)
// Jump-arcs cycle 3: constraint-based contact (cycle-1 seed) + EXACT two-term
// spec drag. No walls, no relief terms, no quadratic term, no shaping.
//
// CONTACT (cycle-3 revision — addresses the cycle-2 rejection of the
// horizontal-preserving impulse):
//   * Grounded velocity redirect is MAGNITUDE-PRESERVING projection: v is
//     projected onto the local tangent plane and rescaled to its previous
//     magnitude. Kinetic energy is conserved across every surface transition;
//     the flat->ramp base transition yields flow = v*1 (NOT v_h/cos(theta) —
//     the cycle-2 energy injection is gone; NOT v*cos(theta) energy loss
//     either, the arcade magnitude-keep the winning cycle-2 candidate used).
//   * Takeoff is a PREDICTIVE unilateral-constraint release, checked BEFORE
//     any surface work: if following the current tangent velocity for one
//     step leaves the ground behind (yFree - hNext > eps), the constraint
//     force went negative -> free flight with the velocity kept as-is. The
//     cliff-contaminated normal stencil past a lip is never consulted, so the
//     exit velocity can never be bent by it (cycle-2 mustFix for the winner).
//   * jumpRelease while grounded runs the FULL grounded tick first (the
//     takeoff frame carries the same ramp decel trend as its predecessors —
//     JA-04 measures the residual vs the median ramp trend), then adds the
//     pop using the PRE-TICK riding normal for the steep-wall blend test.
//
// DRAG — exact two-term spec model (JA-23/23b/23c/24):
//   a(v) = mu*g*cos(theta) + lambda_long*v   (+ brake Coulomb add + powder
//   plow on those surfaces only; NONE active in any drag_shape/uphill run)
//   Integrated in closed form per tick (linear ODE => dt-exact, PC-02;
//   Coulomb clamp at 0 when net drive <= 0). Uphill is the SAME law with
//   gravity opposing motion: decel = g*sin + mu*g*cos + lambda*v (JA-24).
//   Per the spec equation sheet, tuck (k_tuckDrag=0.75) and full-lock turn
//   drag (k_turnDrag = 1 + 0.15*|steer|, spec defend +15%) multiply
//   LAMBDA_LONG ONLY — the Coulomb term is never scaled by either (this was
//   the cycle-2 disqualifying deviation; deleted).
//
//   Constant corridor (forced, not preferred) for a(v) = mu*g + lambda*v:
//     * PC-03 (HARD) needs net accel > 0 at 10 m/s on 15 deg:
//         9.476*mu + 10*lambda < 2.539     (v_ss(15deg) > 10)
//     * PC-04 entry-5/entry-30 tails within 2% after 20 s: convergence rate
//       is exactly lambda => lambda >= ~0.219
//     * JA-23/23b (HARD): mu in [0.03,0.055], lambda in [0.18,0.32]
//   Intersection: lambda in [0.219, 0.2255], mu in [0.03, ~0.032].
//   Chosen: MU_BASE = 0.0305, LAMBDA_LONG = 0.2235.
//     v_ss(15)=10.07 (PC-03 ratio ~170), v_ss(28)=19.4 (PC-04), tail
//     convergence 1.9%, flat coast 17->1.7 in 8.0 s (PC-05); drag_shape fit
//     returns mu=0.0305, lambda=0.2235, residual ~0 (the model IS the fit).
//
// DOCUMENTED GATE CONFLICT (numbers, not shaping) — JA-06/JA-07 vs
// JA-23/23b + JA-24 + the harness kicker geometry (unchanged since cycle 2;
// only the gate owner can resolve it — re-band, shorten the approach, or
// define entrySpeed 18 at the lip):
//   jump_kicker inits at x = -27 m with 18 m/s, then climbs a 6.93 m 30-deg
//   ramp. With ANY (mu, lambda) inside the JA-23 bands:
//     flat approach 27 m: dv/dt = -(mu*g + lambda*v); from 18 m/s this
//       delivers 11.4 m/s at the ramp base (12.6 even at band floor
//       mu=.03, lambda=.18).
//     base transition: magnitude-preserving => flow stays 11.4 (the cycle-2
//       h-preserving 11.4/cos30 = 13.2 was rejected as energy injection).
//     ramp, spec uphill law (JA-24): dv/ds = -(4.905 + 0.259 + .2235*v)/v
//       over 6.93 m => lip flow ~5.7 m/s.
//     takeoff: v_y = 5.7*sin30 + J_MAX = 2.85 + 5.0 = 7.85 m/s; equal-height
//       airtime 2*7.85/6.5 = 2.42 s, apex 7.85^2/13 = 4.7 m vs 12-18 (JA-06);
//       horizontal 4.94*2.42 = 12 m << the 40 m gap, so the rider drops into
//       the -60 m trough and the measured airtime lands ~5.7 s vs 3.5-4.8
//       (JA-06) and ~5.2 s vs 2.9-3.8 (JA-07).
//   Passing JA-06 needs ~15 m/s AT THE LIP => mean flat-approach decel
//   <= ~1.3 m/s^2 at ~17 m/s => lambda <= ~0.06, 3x below JA-23b's HARD
//   floor of 0.18. Infeasible for every candidate; flagged, NOT bridged.
//
// CYCLE-2 CRITIQUE RESPONSES (X = this line's cycle-2 ancestor, rejected):
//   * "vertical-only contact impulse at the base raises speed to v_h/cos"
//     -> redirect is now magnitude-preserving projection (energy-conserving,
//     the accepted contact law); tangentDecompose is DELETED.
//   * "TURN_DRAG 0.12 + tuck/turn scaling of the Coulomb term deviate from
//     the spec equation" -> k_tuck/k_turn now multiply LAMBDA_LONG only,
//     TURN_DRAG restored to the spec defend 0.15; Coulomb is bare
//     mu*g*cos(theta). TN-06 measures ~0.15 (0.15*lambda*v plus the real
//     per-step carve scrub); PC-08 tuck delta 6.5 (lambda*0.75 only).
//   * "adopt a predictive constraint-release check before the redirect"
//     -> present since cycle 2 (groundStep checks release FIRST).
//   * "no coyote pop at all is a feel regression" -> kept: jumpRelease
//     within 0.1 s of a constraint takeoff still pops, using the charge held
//     at takeoff, world-up UNCONDITIONALLY (vertical-only, never consults a
//     normal) so it can never alter horizontal velocity (JA-25). Gating the
//     forgiveness window itself is the gate owner's call; this candidate is
//     compliant either way.
//   * JA-15..21 (uber crash rules / scoring economy): deferred to the
//     trick-system lane per lane instructions — not implemented here.
//   * Carried: config.spinCap/flipCap exported; state.spinCapped/flipCapped
//     report cap saturation for the "???" label; trick stat scales prewound
//     spin (500 deg/s * 1.18 at trick 40 = 590, JA-09); stick spin 300
//     (JA-10) regardless of prewind.
//
// Retuned to the spec-shaped resistive set (all verified by the runner):
//   TUCK_DRAG 0.75 (on lambda only) => tuck delta +6.5 m/s on 28 deg (PC-08)
//   TURN_DRAG 0.15 (on lambda only) => TN-06 ~+15% incl. carve scrub
//   BRAKE_DECEL 1.7 (added Coulomb-style, surface-scaled) => TN-08 total
//     measured decel ~5.0 m/s^2 (band 3-6; spec defend 4.5 is the TOTAL,
//     which includes mu*g + lambda*v already present)
//   J_MIN 2.1 => JA-02 tap (charge 0.18) apex 0.52 m / airtime 0.80 s
//
// Pure math: no imports, no globals, no Date/random. Deterministic.

const DEG = Math.PI / 180;
const UP = [0, 1, 0];

export const DEFAULTS = {
  // --- gravity ---
  G_GROUND: 9.81,        // m/s^2, ground tick (slope-projected)
  G_AIR: 6.5,            // m/s^2, airborne only (aesthetic hang; band 6.0-7.5)
  // --- ground longitudinal drag: a(v) = MU*g*cos + LAMBDA*v (spec) ---
  MU_BASE: 0.0305,       // Coulomb coeff (spec band 0.03-0.055; see corridor)
  LAMBDA_LONG: 0.2235,   // 1/s linear drag (spec band 0.18-0.32; see corridor)
  // --- lateral (edge grip) ---
  LAMBDA_LAT: 4.0,       // 1/s, lateral slip kill on snow (half-life 0.17 s)
  CARVE_LOCK: 1.5,       // extra lateral kill multiplier at full carve lock
  BETA_SKID: 12,         // deg slip angle beyond which the board is skidding
  // --- steering (carve geometry + caps) ---
  R_SIDECUT: 6.4,        // m, board sidecut radius (flat-board carve radius)
  PHI_MAX: 60,           // deg, edge angle at full steer lock
  OMEGA_PIVOT: 160,      // deg/s, low-speed skid-pivot yaw authority
  PIVOT_FADE: 12,        // m/s, speed at which pivot authority reaches zero
  A_LAT: 26,             // m/s^2, lateral accel ceiling: omega <= A_LAT/v (TN-14)
  STEER_REF_SPEED: 5,    // m/s, speed floor in the A_LAT/v cap
  TUCK_STEER: 0.6,       // steering multiplier while tucked
  CROUCH_STEER: 0.45,    // steering multiplier while crouched (TN-12)
  TURN_DRAG: 0.15,       // k_turnDrag = 1 + 0.15*|steer| on LAMBDA only (spec
                         // defend +15%; TN-06 band 10-20% incl. carve scrub)
  // --- tuck ---
  TUCK_DRAG: 0.75,       // k_tuckDrag on LAMBDA only (spec band 0.65-0.75)
  // --- brake ---
  BRAKE_DECEL: 1.7,      // m/s^2 ADDED Coulomb-style decel (surface-scaled);
                         // measured TN-08 total ~5.0 incl. mu*g + lambda*v
  // --- speed rails / boost ---
  V_CAP: 33,             // m/s hard clamp (119 km/h)
  V_BOOST: 31,           // m/s boost target speed
  TAU_BOOST: 0.7,        // s, boost relaxation time constant
  BOOST_DRAIN: 0.125,    // meter/s while boost held (full meter = 8 s burn)
  BOOST_REGEN: 0.10,     // meter/s while boost idle
  // --- jump ---
  T_CHARGE: 0.85,        // s to full crouch charge
  RAIL_YAW_LAMBDA: 9.0,  // /s, board->rail-tangent alignment while constrained
  J_MIN: 2.1,            // m/s vertical impulse, tap (band 2-2.5)
  J_MAX: 5.0,            // m/s vertical impulse, full charge
  NORMAL_BLEND_DOT: 0.7, // below this n.y a GROUNDED jump blends up+normal;
                         // an airborne pop is world-up unconditionally (JA-25)
  COYOTE_POP: 0.25,      // s after leaving ground in which jumpRelease still
                         // pops (lip forgiveness; world-up only) — JA-26
  // --- air rotation (animation-only; all rates scale with trickF) ---
  SPIN_PREWOUND: 500,    // deg/s base with prewind (x1.18 at trick 40 => 590)
  SPIN_STICK: 300,       // deg/s stick-only, at trick stat 20
  FLIP_RATE: 330,        // deg/s at trick stat 20
  AUTO_LEVEL: 220,       // deg/s leveling when rotation input released
  SPIN_CAP: 1800,        // deg recognized spin cap (beyond = "???")
  FLIP_CAP: 1080,        // deg recognized flip cap (triple; beyond = "???")
  // --- landing ---
  CLEAN_YAW: 45,         // deg |heading-velYaw| for clean (auto-snap)
  CRASH_YAW: 90,         // deg and beyond = crash
  SKETCHY_SPEED_KEEP: 0.92, // speed retained on sketchy landing
  CRASH_SPEED_KEEP: 0.45,   // speed retained on crash
  // --- stats ---
  SPEED_STAT_GAIN: 0.0175,  // fractional v_ss gain per +10 speed stat
  EDGE_STAT_GAIN: 0.10,     // fractional steering gain per +10 edging stat
  TRICK_STAT_GAIN: 0.09,    // fractional rotation-rate gain per +10 trick stat
  // --- powder plow ---
  POWDER_PLOW: 4.5,      // m/s^2 extra decel at standstill in powder
  POWDER_PLOW_FADE: 24,  // m/s speed at which plow reaches zero
  // --- misc ---
  GROUND_EPS: 0.02,      // m, ground-stick / constraint-release tolerance
};

// per-surface multipliers (ratios only; base values above)
const SURFACES = {
  snow:   { mu: 1.0,  grip: 1.0,  plow: 0 },
  ice:    { mu: 0.55, grip: 0.55, plow: 0 },
  powder: { mu: 1.3,  grip: 1.15, plow: 1 },
};

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const wrapPi = a => { a = a % (2 * Math.PI); if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

// Exact solution of dv/dt = a - b*v over dt, for v >= 0 (b > 0).
// If a <= 0 (no net drive) the flow clamps at 0 (Coulomb stop) and, being
// monotone-decreasing, the clamped flow is still split-step exact.
function flowSpeed(v0, a, b, dt) {
  if (v0 <= 0 && a <= 0) return 0;
  const veq = a / b;
  const v = veq + (v0 - veq) * Math.exp(-b * dt);
  return a <= 0 ? Math.max(v, 0) : v;
}

// ---------------------------------------------------------------- RIDER MODE
// THE ONE OWNER of the three-way "which state is the rider in" question.
// step() dispatches through it, and every consumer outside physics must ask
// here rather than re-deriving it from a flag.
//
// MEASURED, rails cycle: `onGround` is NOT that question. constrainedStep()
// does not write it, so it freezes at whatever value it held on the capture
// frame and holds it for the whole grind. index.html asked `if (st.onGround)`
// FIRST and physics asks `if (st.constrained)` FIRST, so the two disagreed on
// every grind that locked on with the flag false. The rider's carve stick was
// delivered as `spin`, the balance channel received literally nothing, and the
// divergent balance mode toppled her: 118 bails in 119 such locks, median
// 12.40 m (40.7 ft) along the rail, then a silent 0.56 m drop onto the snow
// under the rail line — the user's "falls right through the rail after a few
// feet". Routing the same intent through this function instead: 0 bails.
//
// The precedence is not a preference. CONSTRAINED beats onGround because a
// constrained rider is supported by something that is not the terrain, and
// physics' own dispatch below has always said so.
export function riderMode(state) {
  return state.constrained ? 'constrained' : state.onGround ? 'ground' : 'air';
}

export function createPhysics(env, opts = {}) {
  const T = { ...DEFAULTS, ...(opts.tuning ?? {}) };
  const stats = { speed: 20, edging: 20, trick: 20, ...(opts.stats ?? {}) };
  const gScale = opts.gravityScale ?? 1;
  // +10 speed stat: b -> b/statF scales every longitudinal steady state
  // (D - F0)/b by exactly statF (drive and Coulomb untouched) — PC-12.
  // drag_shape runs at default stats (statF = 1) so JA-23 sees base constants.
  const statF = 1 + T.SPEED_STAT_GAIN * (stats.speed - 20) / 10;
  // Edging stat: full weight on steering initiation, half weight on the
  // lateral-accel ceiling (the ceiling is a physics limit, not pure skill).
  const edgeF = 1 + T.EDGE_STAT_GAIN * (stats.edging - 20) / 10;
  const aLatEff = T.A_LAT * (1 + 0.5 * (edgeF - 1));
  // Trick stat: scales all commanded air rotation rates.
  const trickF = 1 + T.TRICK_STAT_GAIN * (stats.trick - 20) / 10;
  const surf = SURFACES[env.surface] ?? SURFACES.snow;

  const sampleHeight = env.sampleHeight;
  const sampleNormal = env.sampleNormal ?? ((x, z) => {
    const e = 0.05;
    const dx = (sampleHeight(x + e, z) - sampleHeight(x - e, z)) / (2 * e);
    const dz = (sampleHeight(x, z + e) - sampleHeight(x, z - e)) / (2 * e);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  });

  const config = { ...T, gravityScale: gScale, statSpeedFactor: statF,
    statEdgeFactor: edgeF, statTrickFactor: trickF, aLatEffective: aLatEff,
    surface: env.surface ?? 'snow', surfaceMu: surf.mu, surfaceGrip: surf.grip,
    // explicit rotation-cap exports for the UI "???" label
    spinCap: T.SPIN_CAP, flipCap: T.FLIP_CAP };

  // Magnitude-preserving tangent redirect: project the velocity onto the
  // local tangent plane and rescale to the previous magnitude. Kinetic
  // energy is conserved across every surface transition (no injection, no
  // artificial loss); identity whenever the velocity is already tangent.
  function retangent(st) {
    const n = sampleNormal(st.pos[0], st.pos[2]);
    const vn = dot(st.vel, n);
    const m0 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
    let tx = st.vel[0] - vn * n[0], ty = st.vel[1] - vn * n[1], tz = st.vel[2] - vn * n[2];
    const tm = Math.hypot(tx, ty, tz);
    if (tm > 1e-9 && m0 > 1e-9) {
      const k = m0 / tm;
      st.vel[0] = tx * k; st.vel[1] = ty * k; st.vel[2] = tz * k;
    }
  }

  function init(pos, vel, heading) {
    const h = sampleHeight(pos[0], pos[2]);
    const onGround = pos[1] <= h + T.GROUND_EPS;
    const st = {
      pos: [pos[0], onGround ? h : pos[1], pos[2]],
      vel: [vel[0], vel[1], vel[2]],
      heading, onGround, constrained: false,
      charge: 0, airTime: 0, boostMeter: 1,
      spinDeg: 0, flipDeg: 0, landing: null,
      yawRate: 0, prewound: 0, _prewind: 0,
      carve: 0, slipDeg: 0, // carve/skid observability: weight + slip angle
      spinCapped: false, flipCapped: false, // "???" label feeds
      _coyoteCharge: 0, _popDone: false,
    };
    // Establish the grounded invariant: velocity tangent to the surface at
    // the spawn speed (spawn placement, not a contact transition).
    if (onGround) retangent(st);
    return st;
  }

  // Boost meter economy: linear drain while held, linear regen when idle.
  // Linear-in-dt with a clamp on a monotone path => split-step exact.
  // PC-06 hard cap, applied wherever velocity can be set — not just groundCore.
  function capVel(st) {
    const vm = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);
    if (vm > T.V_CAP) { const k = T.V_CAP / vm; st.vel[0] *= k; st.vel[1] *= k; st.vel[2] *= k; }
  }

  function meterTick(st, input, dt) {
    st.boostMeter = clamp(
      st.boostMeter + (input.boost ? -T.BOOST_DRAIN : T.BOOST_REGEN) * dt, 0, 1);
  }

  function takeoff(st, prewound) {
    st.onGround = false; st.airTime = 0;
    st.spinDeg = 0; st.flipDeg = 0; st.landing = null;
    st.prewound = prewound;
    st._coyoteCharge = st.charge; st._popDone = false;
    st.charge = 0; st._prewind = 0; st.yawRate = 0;
    st.carve = 0; st.slipDeg = 0;
    st.spinCapped = false; st.flipCapped = false;
  }

  // Jump pop. Airborne (coyote / post-takeoff) pops are world-up
  // UNCONDITIONALLY — vertical-only, never consults the surface normal, so a
  // pop released in the air can never alter horizontal velocity (JA-25).
  // Only a still-GROUNDED jump off a steep wall (n.y < 0.7) blends up+normal,
  // using the PRE-TICK normal the board was actually riding (a stencil that
  // straddles a lip cliff must never rotate the pop).
  function jumpImpulse(st, charge, airborne, n0) {
    const J = T.J_MIN + clamp(charge, 0, 1) * (T.J_MAX - T.J_MIN);
    let dir = UP;
    if (!airborne && n0 && n0[1] < T.NORMAL_BLEND_DOT) {
      const l = Math.hypot(n0[0], 1 + n0[1], n0[2]);
      dir = [n0[0] / l, (1 + n0[1]) / l, n0[2] / l];
    }
    st.vel[0] += J * dir[0]; st.vel[1] += J * dir[1]; st.vel[2] += J * dir[2];
    st._popDone = true;
  }

  function land(st, input) {
    const [x, , z] = st.pos;
    st.pos[1] = sampleHeight(x, z);
    const n = sampleNormal(x, z);
    const vn = dot(st.vel, n); // kill normal component (soft landing, no rebound)
    st.vel[0] -= vn * n[0]; st.vel[1] -= vn * n[1]; st.vel[2] -= vn * n[2];
    const hs = Math.hypot(st.vel[0], st.vel[2]);
    const velYaw = hs > 0.5 ? Math.atan2(st.vel[2], st.vel[0]) : st.heading;
    const dev = Math.abs(wrapPi(st.heading - velYaw)) / DEG;
    let label;
    if (input.grab) label = 'crash';                 // grab held at touchdown
    else if (dev >= T.CRASH_YAW) label = 'crash';
    else if (dev <= T.CLEAN_YAW) { label = 'clean'; st.heading = velYaw; } // auto-snap
    else label = 'sketchy';
    const keep = label === 'crash' ? T.CRASH_SPEED_KEEP :
                 label === 'sketchy' ? T.SKETCHY_SPEED_KEEP : 1;
    st.vel[0] *= keep; st.vel[1] *= keep; st.vel[2] *= keep;
    st.onGround = true; st.airTime = 0; st.landing = label; st.prewound = 0;
  }

  function airStep(st, input, dt) {
    // coyote pop: jumpRelease arriving just after a constraint takeoff still
    // pops, using the charge held at takeoff. World-up, vertical-only (JA-25).
    if (input.jumpRelease && !st._popDone && st.airTime <= T.COYOTE_POP && st.landing === null) {
      // The pop is the TRUE takeoff (JA-26): rotation and the air clock
      // accumulated before it belong to the aborted slide off the lip, not to
      // the popped jump — reset them here, exactly as takeoff() would.
      const pw = st.prewound || st._prewind;
      st.spinDeg = 0; st.flipDeg = 0; st.airTime = 0;
      st.spinCapped = false; st.flipCapped = false;
      jumpImpulse(st, st._coyoteCharge, true);
      st.prewound = pw;
    }
    st.airTime += dt;
    meterTick(st, input, dt); // meter economy runs in air too; thrust does not
    // --- rotation: pure animation state, ZERO trajectory coupling (PC-09/10) ---
    const spin = clamp(input.spin ?? 0, -1, 1);
    const flip = clamp(input.flip ?? 0, -1, 1);
    if (Math.abs(spin) > 0.05) {
      // Trick stat scales PREWOUND spin only (JA-09); stick spin is a flat
      // 300 deg/s at every trick stat (JA-10, measured at trick 20 AND 40).
      const rate = (st.prewound !== 0 && Math.sign(spin) === st.prewound
        ? T.SPIN_PREWOUND * trickF : T.SPIN_STICK) * spin;
      let d = rate * dt;
      if (Math.abs(st.spinDeg + d) >= T.SPIN_CAP) {
        d = Math.sign(d) * Math.max(0, T.SPIN_CAP - Math.abs(st.spinDeg));
        st.spinCapped = true; // recognized rotation saturated: display "???"
      }
      st.spinDeg += d; st.heading += d * DEG;
    } else if (st.spinDeg !== 0) { // auto-level toward nearest straight/fakie
      const target = Math.round(st.spinDeg / 180) * 180;
      const d = clamp(target - st.spinDeg, -T.AUTO_LEVEL * dt, T.AUTO_LEVEL * dt);
      st.spinDeg += d; st.heading += d * DEG;
    }
    if (Math.abs(flip) > 0.05) {
      let d = T.FLIP_RATE * trickF * flip * dt;
      if (Math.abs(st.flipDeg + d) >= T.FLIP_CAP) {
        d = Math.sign(d) * Math.max(0, T.FLIP_CAP - Math.abs(st.flipDeg));
        st.flipCapped = true; // recognized flips saturated: display "???"
      }
      st.flipDeg += d;
    } else if (st.flipDeg !== 0) {
      const target = Math.round(st.flipDeg / 360) * 360;
      st.flipDeg += clamp(target - st.flipDeg, -T.AUTO_LEVEL * dt, T.AUTO_LEVEL * dt);
    }
    // --- ballistic: horizontal untouched; steer/boost/crouch inert in air ---
    st.vel[1] -= T.G_AIR * gScale * dt;
    st.pos[0] += st.vel[0] * dt; st.pos[1] += st.vel[1] * dt; st.pos[2] += st.vel[2] * dt;
    if (st.pos[1] <= sampleHeight(st.pos[0], st.pos[2]) + 1e-9) land(st, input);
  }

  // The full grounded tick: steering, magnitude-preserving redirect, spec
  // two-term drag flow, integration, ground follow. Never touches the pop.
  // Crouch charge is a RIDER action, not a ground action: it accrues wherever the
  // board is supported. Shared by groundCore and the constrained state so a rider
  // crouching on a rail arrives at the lip charged (option (a): a grind is
  // supported, not free-falling, so it charges exactly as the ground does).
  function accrueCharge(st, input, dt) {
    if (input.crouch) {
      st.charge = clamp(st.charge + dt / T.T_CHARGE, 0, 1);
      const sp = input.spin ?? 0;
      if (Math.abs(sp) > 0.3) st._prewind = Math.sign(sp);
    } else { st.charge = 0; st._prewind = 0; }
  }

  function groundCore(st, input, dt) {
    const steer = clamp(input.steer ?? 0, -1, 1);
    // --- boost meter (gate resolved before the drain so a full-meter tap works) ---
    const boostActive = !!input.boost && st.boostMeter > 0;
    meterTick(st, input, dt);
    // --- crouch charge / prewind ---
    accrueCharge(st, input, dt);

    const n = sampleNormal(st.pos[0], st.pos[2]);
    const speed3 = Math.hypot(st.vel[0], st.vel[1], st.vel[2]);

    // --- steering: CARVE geometry + low-speed pivot, ceilinged by A_LAT ---
    const kSteer = (input.tuck ? T.TUCK_STEER : 1) * (input.crouch ? T.CROUCH_STEER : 1);
    const phi = Math.abs(steer) * T.PHI_MAX * DEG;
    const Rcarve = Math.max(T.R_SIDECUT * Math.cos(phi), 0.5);
    const omegaCarve = speed3 / Rcarve;                       // rad/s, carve state
    const omegaPivot = T.OMEGA_PIVOT * DEG * Math.max(0, 1 - speed3 / T.PIVOT_FADE);
    const omega = steer * kSteer * Math.min(
      (omegaCarve + omegaPivot) * edgeF,
      aLatEff / Math.max(speed3, T.STEER_REF_SPEED));
    st.heading += omega * dt; st.yawRate = omega;

    // --- board frame on the surface ---
    const F = [Math.cos(st.heading), 0, Math.sin(st.heading)];
    let fx = F[0] - dot(F, n) * n[0], fy = -dot(F, n) * n[1], fz = F[2] - dot(F, n) * n[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    const fwd = [fx, fy, fz];
    const lat = [n[1] * fz - n[2] * fy, n[2] * fx - n[0] * fz, n[0] * fy - n[1] * fx];

    // --- redirect: MAGNITUDE-PRESERVING projection onto the tangent plane.
    //     Energy-conserving at every transition (no v_h/cos injection);
    //     identity on constant planes once tangent.
    const vn = dot(st.vel, n);
    let tx = st.vel[0] - vn * n[0], ty = st.vel[1] - vn * n[1], tz = st.vel[2] - vn * n[2];
    const tm = Math.hypot(tx, ty, tz);
    if (tm > 1e-9) { const k = speed3 / tm; tx *= k; ty *= k; tz *= k; }
    let sF = tx * fwd[0] + ty * fwd[1] + tz * fwd[2];
    let sR = tx * lat[0] + ty * lat[1] + tz * lat[2];

    // --- carve/skid classification by slip angle ---
    const slipDeg = Math.atan2(Math.abs(sR), Math.abs(sF)) / DEG;
    const carveW = Math.abs(steer) * clamp(1 - slipDeg / T.BETA_SKID, 0, 1);
    st.slipDeg = slipDeg; st.carve = carveW;

    // --- slope drive + resistive constants (spec two-term model) ---
    const g = T.G_GROUND * gScale;
    const gdn = -g * n[1]; // (0,-g,0).n
    const gt = [-gdn * n[0], -g - gdn * n[1], -gdn * n[2]]; // tangential gravity
    const Gf = dot(gt, fwd), Gr = dot(gt, lat);
    const cosT = Math.max(n[1], 0);
    const sAbs0 = Math.abs(sF);
    let sgn = sF >= 0 ? 1 : -1;
    const plow = surf.plow * T.POWDER_PLOW * Math.max(0, 1 - sAbs0 / T.POWDER_PLOW_FADE);
    // Spec shape: Coulomb term is NEVER scaled by tuck/turn; k_tuckDrag and
    // k_turnDrag multiply LAMBDA_LONG only (reference-bar equation sheet).
    const F0 = surf.mu * T.MU_BASE * g * cosT
      + (input.brake ? T.BRAKE_DECEL * surf.mu : 0) + plow;
    const kTuck = input.tuck ? T.TUCK_DRAG : 1;
    const kTurn = 1 + T.TURN_DRAG * Math.abs(steer);
    const b = T.LAMBDA_LONG * kTuck * kTurn / statF;
    // Uphill and downhill obey the SAME law: full g*sin(theta) opposes uphill
    // motion (JA-24). No relief term, no wall, no quadratic term.
    let a = sgn * Gf - F0;

    // --- gravity-driven reversal: a stopped board whose forward drive is
    //     exhausted slides the other way iff slope drive beats Coulomb.
    if (sAbs0 < 1e-6 && a <= 0) {
      const aRev = -sgn * Gf - F0;
      if (aRev > 0) { sgn = -sgn; a = aRev; }
    }

    // --- longitudinal: boost = target relaxation, else exact two-term flow ---
    let sAbs;
    if (boostActive) {
      const rt = a > 0 ? a / b : 0; // natural terminal speed on this slope
      const target = Math.max(T.V_BOOST, rt);
      sAbs = sAbs0 < target
        ? target + (sAbs0 - target) * Math.exp(-dt / T.TAU_BOOST)
        : flowSpeed(sAbs0, a, b, dt);
    } else {
      sAbs = flowSpeed(sAbs0, a, b, dt);
    }
    sAbs = Math.min(sAbs, T.V_CAP); // hard clamp (PC-06)
    sF = sgn * sAbs;

    // --- lateral: exponential kill toward gravity-slip equilibrium.
    //     CARVE: edge locks the line, kill rate rises by (1 + CARVE_LOCK*w).
    //     SKID: base anisotropic damping scrubs real speed (TN-13).
    const lam = T.LAMBDA_LAT * surf.grip * (1 + T.CARVE_LOCK * carveW);
    const sEq = Gr / lam;
    sR = sEq + (sR - sEq) * Math.exp(-lam * dt);

    // --- reassemble, total cap, integrate ---
    let vx = sF * fwd[0] + sR * lat[0], vy = sF * fwd[1] + sR * lat[1], vz = sF * fwd[2] + sR * lat[2];
    const vm = Math.hypot(vx, vy, vz);
    if (vm > T.V_CAP) { const k = T.V_CAP / vm; vx *= k; vy *= k; vz *= k; }
    st.vel[0] = vx; st.vel[1] = vy; st.vel[2] = vz;
    st.pos[0] += vx * dt; st.pos[1] += vy * dt; st.pos[2] += vz * dt;

    // --- ground follow / takeoff (ground falls away faster than we do) ---
    const hNew = sampleHeight(st.pos[0], st.pos[2]);
    if (st.pos[1] - hNew > T.GROUND_EPS) takeoff(st, 0);
    else st.pos[1] = hNew;
  }

  function groundStep(st, input, dt) {
    // --- jump release: run the FULL grounded tick first (the takeoff frame
    //     carries the same ramp trend as its predecessors — JA-04), then add
    //     the pop.
    if (input.jumpRelease) {
      const charge = st.charge, pw = st._prewind;
      const n0 = sampleNormal(st.pos[0], st.pos[2]); // pre-tick riding normal
      groundCore(st, input, dt);
      const wasGrounded = st.onGround; // lip may have released the constraint
      if (wasGrounded) takeoff(st, pw); else st.prewound = pw;
      // Still-grounded release = deliberate jump (wall blend allowed, judged
      // on the pre-tick normal); constraint already released = airborne pop,
      // world-up unconditionally (JA-25 / JA-04).
      jumpImpulse(st, charge, !wasGrounded, n0);
      return;
    }
    // --- PREDICTIVE unilateral-constraint release, BEFORE any surface work:
    //     if following the current (tangent) velocity leaves the ground
    //     behind, the constraint force went negative -> free flight this
    //     tick. Velocity kept as-is; the cliff-contaminated normal stencil
    //     past a lip is never consulted.
    const yFree = st.pos[1] + st.vel[1] * dt;
    const hNext = sampleHeight(st.pos[0] + st.vel[0] * dt, st.pos[2] + st.vel[2] * dt);
    if (yFree - hNext > T.GROUND_EPS) {
      const pw = st._prewind;
      takeoff(st, pw);
      airStep(st, input, dt);
      return;
    }
    groundCore(st, input, dt);
  }

  // CONSTRAINED: the board is supported by something that is not the terrain (a
  // rail today; wallride / halfpipe / tow later). The owning module supplies the
  // motion; physics still runs the RIDER: crouch charges, prewind is captured,
  // and the air clock is held at 0 because the rider is not falling. Releasing a
  // charged jump from here is a normal takeoff — that is what makes the
  // rail-into-big-air link expressible (BACKLOG option (a)).
  function constrainedStep(st, input, dt) {
    // Capture charge/prewind BEFORE the tick, exactly as the grounded release
    // path does (a release frame carries no crouch, so accruing first would zero
    // the charge the release is supposed to spend — this cost PC-15 a J_MIN pop).
    if (input.jumpRelease) {
      const charge = st.charge, pw = st._prewind;
      // ROTATION STATE RESETS ON EXIT (reference: in Tricky a rail spin does not
      // follow you into the air — open-air rotation needs a fresh input or a new
      // prewind). takeoff() zeroes spinDeg/flipDeg; heading must settle to the
      // direction of travel in the same breath, or a rider who pops mid-rail-spin
      // leaves crabbed and land() scores a crash they could not avoid.
      const hs0 = Math.hypot(st.vel[0], st.vel[2]);
      if (hs0 > 0.5) st.heading = Math.atan2(st.vel[2], st.vel[0]);
      st.constrained = false;
      takeoff(st, pw);                        // true takeoff: rotation + air clock reset
      jumpImpulse(st, charge, false, null);   // world-up, charge-scaled
      return;
    }
    accrueCharge(st, input, dt);
    meterTick(st, input, dt);   // the boost economy runs on a rail too: without
    // this the meter never drained while constrained (measured 0.971 left after
    // 5 s of rail boost vs 0.375 on snow) — boost on a rail was free.
    st.airTime = 0;
    // OWNERSHIP. constrainedStep used to leave st.onGround at whatever value it
    // held on the capture frame, for the whole grind, so the SAME grind read
    // "grounded" or "airborne" depending on how the rider arrived — measured on
    // the real course: rail0 ground-entry 145 on-rail frames all flagged
    // grounded, rail3 ground-entry 152 frames all flagged airborne. Five
    // consumers read that flag (camera air-pull, snow spray, run walls/berms,
    // the trick FSM, the HUD) and every one of them was reading a leftover.
    // A constrained rider is NOT supported by the terrain, so the flag is
    // false; "which state is the rider in" is riderMode()'s question, not this
    // flag's. Measured after: 0/22 npm tests, 0/19 rail mutants, and all six
    // probe landing verdicts unchanged; the trick FSM now reads the same on
    // every rail. Capture-frame semantics are untouched — physics runs
    // ground/air step on the frame rails.mjs locks, so the
    // `ps.onGround ? c.sp3 : |c.proj|` entry-speed rule still sees the arrival
    // state (rig medians identical: 51.48 m before and after).
    st.onGround = false;
    // PC-06 is "nothing exceeds V_CAP, ALWAYS". The clamp lived only in
    // groundCore, so a module writing velocity here could hand any speed to
    // physics: a candidate reached 58.8 m/s on a descending rail and leaked
    // 63.95 m/s into the air. The owning module writes velocity, but it does not
    // get to opt out of the cap.
    capVel(st);
    // The constraint owner writes VELOCITY (it may not write position — that is
    // physics' job everywhere else too), so physics integrates it. Omitting this
    // froze the rider solid: measured 0.00 m of advance over a 0.9 s charge, i.e.
    // crouching to pop stopped you dead mid-rail. PC-16 encoded the bug, asserting
    // position never changed AT ALL rather than that gravity is absent.
    st.pos[0] += st.vel[0] * dt;
    st.pos[1] += st.vel[1] * dt;
    st.pos[2] += st.vel[2] * dt;
    // The board points along the rail. Physics owns heading (modules are banned
    // from writing it), and on a curved rail a board frozen at its pre-lock yaw
    // exits crabbed — measured 27.1 deg after only 39 deg of sweep, which land()
    // then scores sketchy or, past 90 deg, a crash the player cannot avoid.
    // --- RAIL SPIN: the player can rotate the board on the rail (this is how you
    // land in switch). Same shape as the air block, at the flat stick rate — no
    // prewind bonus, because a prewind is spent on the pop, not on the grind.
    // While the stick is held the tangent aligner below is SUPPRESSED, otherwise
    // it fights the spin and the board never leaves the rail line.
    const rspin = clamp(input.spin ?? 0, -1, 1);
    const spinning = Math.abs(rspin) > 0.05;
    if (spinning) {
      let d = T.SPIN_STICK * rspin * dt;
      if (Math.abs(st.spinDeg + d) >= T.SPIN_CAP) {
        d = Math.sign(d) * Math.max(0, T.SPIN_CAP - Math.abs(st.spinDeg));
        st.spinCapped = true;
      }
      st.spinDeg += d; st.heading += d * DEG;
      st.yawRate = T.SPIN_STICK * rspin * DEG;
    }
    // The board points along the rail. Physics owns heading (modules are banned
    // from writing it), and on a curved rail a board frozen at its pre-lock yaw
    // exits crabbed — measured 27.1 deg after only 39 deg of sweep, which land()
    // then scores sketchy or, past 90 deg, a crash the player cannot avoid.
    const hs = Math.hypot(st.vel[0], st.vel[2]);
    if (!spinning && hs > 0.5) {
      const velYaw = Math.atan2(st.vel[2], st.vel[0]);
      // Settle to the NEAREST of forward/switch: after a 180 the rider is riding
      // fakie down the rail and must stay there, not be dragged back to forward.
      const d = wrapPi(velYaw - st.heading);
      const half = wrapPi(d + Math.PI);
      // strict margin so a 90 deg tie resolves to FORWARD deterministically
      const use = Math.abs(half) < Math.abs(d) - 1e-9 ? half : d;
      st.heading += use * (1 - Math.exp(-T.RAIL_YAW_LAMBDA * dt));
      st.yawRate = use * T.RAIL_YAW_LAMBDA;
    }
  }

  function step(state, input = {}, dt) {
    const mode = riderMode(state);           // same precedence every consumer sees
    if (mode === 'constrained') constrainedStep(state, input, dt);
    else if (mode === 'ground') groundStep(state, input, dt);
    else airStep(state, input, dt);
    return state;
  }

  return { config, init, step };
}
