// Candidate B — rail grinding (SSX Tricky "just land on a rail")
//
// MODEL, in one paragraph. On lock-on the rider stops being a 3-D particle and
// becomes a 1-D state: arclength s along the rail polyline and ds/dt. That 1-D
// state is integrated in CLOSED FORM (dv/dt = D - F0 - lambda*v has an exact
// solution, so one 100 ms step equals ten 10 ms steps — GR-09). The polyline is
// READ ONLY: once to place the rider on the lock frame (the single position
// write GR-07 permits), and thereafter only to look up the point, the tangent
// and the signed curvature at s. The rider is carried along the rail by
// VELOCITY ALONE (vel := tangent*alongSpeed + trackGain*(railPoint - pos));
// heading is never touched, position is never touched again, trick state is
// never touched. Balance is a second state: the unstable eigenmode of a
// linearised inverted pendulum standing on the rail, driven by the centripetal
// lean the bend demands, and pushed back by the stick.
//
// ============================ CONSTANT LEDGER ============================
// Every number below is either (a) read off src/physics/physics.mjs DEFAULTS —
// the accepted physics core this module must live inside, (b) taken from the
// research corpus with a section reference, (c) computed from (a)/(b) by the
// formula shown, or (d) labelled CHOICE with its cost. There are no free
// numbers: nothing here was nudged to move a gate.
//
//  L_COM = 0.99 m         = 0.55 * 1.8 m. Rider height 1.8 m is fixed by
//                           CONTRACTS.md; 0.55*stature is the standard
//                           anthropometric whole-body CoM height. This is the
//                           pendulum length.
//  OMEGA0 = 3.1483 1/s    = sqrt(g/L_COM), g = 9.81 (physics G_GROUND).
//                           Linearised inverted pendulum theta'' = (g/L)theta
//                           has modes exp(+/-OMEGA0 t); after ~0.3 s only the
//                           growing one matters, so `balance` IS that mode's
//                           amplitude and its law is first order:
//                           db/dt = OMEGA0*(b - b_equilibrium).
//  THETA_MAX = 60 deg     = physics DEFAULTS.PHI_MAX, the largest board tilt
//                           the accepted core admits. |balance| = 1 (a bail) is
//                           defined as a lean of THETA_MAX; this is what
//                           normalises every lean angle below into balance
//                           units.
//  DRAG_SCALE = 0.5714    = 0.20/0.35, the ice/snow friction ratio from Tux
//                           Racer's terrains.lst (research 02 sec 3.1). Steel
//                           rail has no plough term at all, so it is at least
//                           as slick as the slickest surface the corpus prices.
//                           This is the whole of "you go faster boosting on a
//                           rail than boosting on the snow" (sec 1.5): the rail
//                           reuses physics' own two-term drag law with both
//                           terms scaled by DRAG_SCALE and NOTHING else changed.
//  MU_RAIL / LAM_RAIL     = DRAG_SCALE * physics MU_BASE / LAMBDA_LONG.
//  BAL_AUTHORITY = 4.0    = physics DEFAULTS.LAMBDA_LAT, the board's lateral
//                           response rate (half-life 0.17 s). Full stick shifts
//                           the contact point under the CoM at the same rate
//                           the board sets an edge; in balance units that is
//                           4.0 per second. Consequence worth stating: on a
//                           straight rail full correct stick (4.0) always beats
//                           the worst instability (OMEGA0*1 = 3.15), so a
//                           straight-rail grind is always recoverable, and on a
//                           bend it is not.
//  TRACK_GAIN = 4.0       = same LAMBDA_LAT, used as the velocity-only pursuit
//                           gain that keeps the rider on the line without ever
//                           writing position.
//  CAPTURE_R = 1.0 m      CHOICE inside a cited band: research 02 sec 1.5 [EST]
//                           gives 0.5-1.5 m ("about one board length"); 1.0 is
//                           the band midpoint. Cost: at 0.5 the rider misses
//                           rails a player expects to catch; at 1.5 the rail
//                           snatches riders passing beside it. Nothing derives
//                           the exact value - the corpus itself marks it [EST].
//  MIN_LOCK = 2.8 m/s     = Tux Racer MIN_FRICT_SPEED (research 02 sec 3.4).
//                           Below it that model produces no friction and hence
//                           no steering; with no steering there is no balance
//                           authority, so a grind cannot be entered.
//  CURVE_TOL = 45 deg     = Tux Racer MAX_TURN_ANGLE (research 02 sec 3.2), the
//                           largest redirect board friction can produce in one
//                           contact. A rider crossing the rail at a wider angle
//                           than that cannot be turned onto it, so no capture.
//  EXIT_POP = 2.1 m/s     = physics DEFAULTS.J_MIN, the uncharged tap-jump
//                           impulse. A rider on a rail is airborne and cannot
//                           accumulate crouch charge, so the exit ollie is
//                           exactly a tap. Vertical only: it cannot touch the
//                           along-rail speed GR-04 measures.
//  RELOCK_COOL = 0.646 s  = 2*EXIT_POP/G_AIR, the hang time of that ollie. The
//                           rider cannot be recaptured before the jump they
//                           just made has finished.
//  BAIL_KEEP = 0.45       = physics DEFAULTS.CRASH_SPEED_KEEP. Losing balance
//                           costs what any crash costs.
//  T_PASSIVE_BAIL = 2.0 s CHOICE, and the ONLY taste number in the file. GR-05
//                           itself declares its 0.8-6 s window a design choice
//                           and not a citation, so the constant that sets it
//                           cannot be anything else. It is not typed in as a
//                           lean: STANCE_BIAS is COMPUTED from it below by
//                           inverting the pendulum solution. 2.0 s is the
//                           middle of the declared window on a log scale. Cost:
//                           lower = rails become a stick-mashing chore; higher
//                           = balance stops being a mechanic and rails become
//                           free speed. The bail time is only logarithmically
//                           sensitive to the bias (a 10x error in the lean moves
//                           the bail by ln10/OMEGA0 = 0.73 s), so this is a feel
//                           dial, not a knife edge.
//  STANCE_BIAS = 0.001844 = 1/(exp(OMEGA0*T_PASSIVE_BAIL) - 1), i.e. the lean
//                           offset for which b(t) = BIAS*(exp(OMEGA0 t) - 1)
//                           reaches 1 at exactly T_PASSIVE_BAIL. In real units
//                           that is 0.11 deg of standing lean, a CoM sitting
//                           1.9 mm off the rail line — which is the honest
//                           content of "there is a light balance element
//                           handled by stance" (research 02 sec 1.5): you are
//                           never exactly over the rail, and an inverted
//                           pendulum turns 2 mm into a bail in two seconds.
//  BOOST_THRUST           = MU_BASE*g + LAMBDA_LONG*V_BOOST = 7.228 m/s^2, the
//                           thrust that holds physics' own boost target (31 m/s)
//                           on flat snow. Boost is modelled as that THRUST, not
//                           as a speed target, so the same push on the rail's
//                           lower drag settles higher - it saturates at physics'
//                           V_CAP 33. That is the sourced claim ("faster
//                           boosting on a rail than on the snow") falling out of
//                           one drag scale instead of being asserted twice.
//
// SPEED DEPENDENCE OF THE INSTABILITY — and one disagreement with my brief.
// The brief asked for a balance model "whose instability grows with speed".
// It does, but only through the bend: the lean a curve demands is
// phi_c = atan(v^2*kappa/g), so the destabilising load grows as v^2 and a rail
// that is holdable at 10 m/s throws you at 20 m/s. On a PERFECTLY straight rail
// the growth rate is sqrt(g/L_COM) and is speed-independent, because gravity
// does not know how fast the rider is going, and I could not derive a speed
// term there without inventing one. Real rails are polylines with real vertex
// curvature, so in practice the v^2 term is present everywhere; an idealised
// straight rail is the one case where speed does not make balance harder, and I
// would rather say so than fake it with a tuned coefficient.
//
// WHAT THIS MODULE NEVER DOES: writes heading (never, GR-07); writes position
// (only the lock-on snap, which is exactly the "snap the character to the
// closest point on the spline" step of the standard implementation in research
// 02 sec 1.5); writes trick state (spinDeg/flipDeg/landing/airTime are read at
// most, and the module deliberately leaves the rider AIRBORNE with physics'
// air clock running, so a grind cannot re-open physics' coyote branch and
// erase a rail spin — GR-10).
//
// Pure JS: no imports, no globals, no Date, no random. Deterministic.

const DEG = Math.PI / 180;

// ---- borrowed verbatim from src/physics/physics.mjs DEFAULTS ---------------
const PH = {
  G: 9.81,               // G_GROUND
  G_AIR: 6.5,            // airborne gravity
  MU_BASE: 0.0305,       // Coulomb term of the snow drag law
  LAMBDA_LONG: 0.2235,   // linear term of the snow drag law (1/s)
  LAMBDA_LAT: 4.0,       // board lateral response rate (1/s)
  PHI_MAX: 60 * DEG,     // max board tilt
  J_MIN: 2.1,            // uncharged tap-jump impulse (m/s)
  V_BOOST: 31,           // boost target speed on snow (m/s)
  V_CAP: 33,             // hard speed clamp (m/s)
  CRASH_SPEED_KEEP: 0.45,
};

// ---- derived, in the order of the ledger above -----------------------------
const L_COM = 0.55 * 1.8;                              // 0.99 m
const OMEGA0 = Math.sqrt(PH.G / L_COM);                // 3.1483 1/s
const THETA_MAX = PH.PHI_MAX;                          // 1.0472 rad == |b| 1
const DRAG_SCALE = 0.20 / 0.35;                        // 0.5714 (Tux ice/snow)
const MU_RAIL = PH.MU_BASE * DRAG_SCALE;
const LAM_RAIL = PH.LAMBDA_LONG * DRAG_SCALE;
const BAL_AUTHORITY = PH.LAMBDA_LAT;                   // 4.0 /s at full stick
const TRACK_GAIN = PH.LAMBDA_LAT;                      // 4.0 /s pursuit gain
const CAPTURE_R = 1.0;                                 // CHOICE in [0.5,1.5]
const MIN_LOCK = 2.8;                                  // Tux MIN_FRICT_SPEED
const CURVE_TOL = 45 * DEG;                            // Tux MAX_TURN_ANGLE
const EXIT_POP = PH.J_MIN;
const RELOCK_COOL = 2 * EXIT_POP / PH.G_AIR;           // 0.6462 s
const BAIL_KEEP = PH.CRASH_SPEED_KEEP;
const T_PASSIVE_BAIL = 2.0;                            // CHOICE (see ledger)
const STANCE_BIAS = 1 / (Math.exp(OMEGA0 * T_PASSIVE_BAIL) - 1);
const BOOST_THRUST = PH.MU_BASE * PH.G + PH.LAMBDA_LONG * PH.V_BOOST;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exact solution of dv/dt = a - b*v over dt, and the distance it covers.
// Both are the analytic flow of the same linear ODE, so both are split-step
// exact: flow(v,a,b,0.1) === flow applied ten times at 0.01 (GR-09).
const flowV = (v0, a, b, dt) => { const q = a / b; return q + (v0 - q) * Math.exp(-b * dt); };
const flowS = (v0, a, b, dt) => { const q = a / b; return q * dt + (v0 - q) * (1 - Math.exp(-b * dt)) / b; };

// Exact solution of db/dt = W*b + K over dt (K constant across the step).
const flowBal = (b0, W, K, dt) => { const q = K / W; return (b0 + q) * Math.exp(W * dt) - q; };

// --------------------------------------------------------------------------
// Rail geometry. Built once per createRails: cumulative arclength, unit segment
// directions, smoothed vertex tangents, and SIGNED discrete curvature.
//
// Sign convention, fixed by the physics core: heading h has forward
// (cos h, 0, sin h), and physics turns with `heading += steer*omega*dt`, so
// POSITIVE STEER INCREASES HEADING, which rotates forward from +x toward +z —
// a RIGHT turn (left = up x forward = (T.z, 0, -T.x)). Therefore:
//   kappaRight = dh/ds > 0  <=>  the rail bends right;
//   balance    > 0          <=>  the rider is falling to their LEFT;
//   a right bend throws you left  =>  positive curvature drives positive
//   balance, and positive steer (turn right, i.e. INTO the bend) cancels it.
// That is exactly the contract's convention (positive steer reduces positive
// balance) and it is also the intuitive one: you hold a bend by steering into
// it, not by fighting it.
// --------------------------------------------------------------------------
function prepRail(rail) {
  const P = (rail.points || []).map(p => [+p[0], +p[1], +p[2]]);
  const n = P.length;
  const dir = [], len = [], cum = [0];
  for (let i = 0; i < n - 1; i++) {
    const dx = P[i + 1][0] - P[i][0], dy = P[i + 1][1] - P[i][1], dz = P[i + 1][2] - P[i][2];
    const l = Math.hypot(dx, dy, dz) || 1e-9;
    dir.push([dx / l, dy / l, dz / l]);
    len.push(l);
    cum.push(cum[i] + l);
  }
  // Vertex tangents: mean of the two adjacent segment directions (C0 tangent
  // field along the polyline; the raw segment direction alone would step the
  // velocity in visible jerks at every control point).
  const vt = [];
  for (let i = 0; i < n; i++) {
    if (i === 0) vt.push(dir[0] ? dir[0].slice() : [0, 0, 1]);
    else if (i === n - 1) vt.push(dir[n - 2].slice());
    else {
      const a = dir[i - 1], b = dir[i];
      const v = [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
      const l = Math.hypot(v[0], v[1], v[2]) || 1e-9;
      vt.push([v[0] / l, v[1] / l, v[2] / l]);
    }
  }
  // Signed curvature at each vertex: turn angle in the horizontal plane divided
  // by the mean adjacent segment length. On the harness' constant-radius arc
  // (24 chords over 80 deg) this returns exactly 1/R at every interior vertex.
  const vk = new Array(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = dir[i - 1], b = dir[i];
    const ah = Math.hypot(a[0], a[2]) || 1e-9, bh = Math.hypot(b[0], b[2]) || 1e-9;
    const ax = a[0] / ah, az = a[2] / ah, bx = b[0] / bh, bz = b[2] / bh;
    const cross = ax * bz - az * bx;          // >0 => heading increased => right
    const dth = Math.atan2(cross, ax * bx + az * bz);
    vk[i] = dth / (0.5 * (len[i - 1] + len[i]));
  }
  // Extend curvature to the end vertices so a constant-radius rail has its true
  // curvature from s=0 (the arrival transient must not read as "straight").
  if (n > 2) { vk[0] = vk[1]; vk[n - 1] = vk[n - 2]; }
  return { id: rail.id, width: rail.width ?? 0.2, P, dir, len, cum, vt, vk, L: cum[n - 1] || 0 };
}

// segment index containing arclength s
function segAt(r, s) {
  let lo = 0, hi = r.len.length - 1;
  if (hi < 0) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (r.cum[m] <= s) lo = m; else hi = m - 1; }
  return lo;
}

// Point / unit tangent / signed curvature at arclength s. READ ONLY.
function evalRail(r, s) {
  const i = segAt(r, clamp(s, 0, r.L));
  const u = clamp((clamp(s, 0, r.L) - r.cum[i]) / (r.len[i] || 1e-9), 0, 1);
  const A = r.P[i], B = r.P[i + 1];
  const pt = [A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, A[2] + (B[2] - A[2]) * u];
  const t0 = r.vt[i], t1 = r.vt[i + 1];
  let tx = t0[0] + (t1[0] - t0[0]) * u, ty = t0[1] + (t1[1] - t0[1]) * u, tz = t0[2] + (t1[2] - t0[2]) * u;
  const tl = Math.hypot(tx, ty, tz) || 1e-9;
  tx /= tl; ty /= tl; tz /= tl;
  const kap = r.vk[i] + (r.vk[i + 1] - r.vk[i]) * u;
  return { pt, tan: [tx, ty, tz], kap };
}

// Closest point on the polyline to p: arclength, 3-D distance, and the SIGNED
// horizontal offset (positive = rider stands to the LEFT of the rail line).
function closestOn(r, p) {
  let best = null;
  for (let i = 0; i < r.len.length; i++) {
    const A = r.P[i], d = r.dir[i];
    const wx = p[0] - A[0], wy = p[1] - A[1], wz = p[2] - A[2];
    const proj = clamp(wx * d[0] + wy * d[1] + wz * d[2], 0, r.len[i]);
    const qx = A[0] + d[0] * proj, qy = A[1] + d[1] * proj, qz = A[2] + d[2] * proj;
    const dist = Math.hypot(p[0] - qx, p[1] - qy, p[2] - qz);
    if (!best || dist < best.dist) best = { dist, s: r.cum[i] + proj, q: [qx, qy, qz] };
  }
  if (!best) return null;
  const e = evalRail(r, best.s);
  const lx = e.tan[2], lz = -e.tan[0];                  // left = up x tangent
  const ll = Math.hypot(lx, lz) || 1e-9;
  best.left = [lx / ll, 0, lz / ll];
  best.lat = (p[0] - best.q[0]) * best.left[0] + (p[2] - best.q[2]) * best.left[2];
  best.tan = e.tan;
  return best;
}

export function createRails(env = {}) {
  const rails = (env.rails || []).map(prepRail);
  const byId = new Map(rails.map(r => [r.id, r]));

  const config = {
    // --- contract-mandated ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    // The balance mode is UNSTABLE, so this is a doubling time, not a decay
    // half-life: an uncorrected lean doubles every ln2/OMEGA0 seconds. Reported
    // under the contract's name because it is the same number a designer wants.
    balanceHalfLife_s: Math.LN2 / OMEGA0,
    curveTolerance_rad: CURVE_TOL,
    minLockSpeed_mps: MIN_LOCK,
    // --- the rest of the ledger, exposed so the numbers can be audited ---
    comHeight_m: L_COM,
    balanceRate_hz: OMEGA0,
    balanceBailAngle_rad: THETA_MAX,
    balanceAuthority_hz: BAL_AUTHORITY,
    trackGain_hz: TRACK_GAIN,
    stanceBias: STANCE_BIAS,
    passiveBailTarget_s: T_PASSIVE_BAIL,
    railMu: MU_RAIL,
    railLambda_hz: LAM_RAIL,
    boostThrust_mps2: BOOST_THRUST,
    speedCap_mps: PH.V_CAP,
    exitPop_mps: EXIT_POP,
    relockCooldown_s: RELOCK_COOL,
    bailSpeedKeep: BAIL_KEEP,
  };

  function init() {
    return {
      onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      // private
      _s: 0, _dir: 1, _cool: 0, _prewind: 0, _kap: 0,
    };
  }

  // Leave the rail. VELOCITY ONLY — never position, never heading.
  function leave(gs, ps, tan, why) {
    const v = gs.alongSpeed;
    const keep = why === 'bail' ? BAIL_KEEP : 1;
    ps.vel[0] = tan[0] * v * keep;
    ps.vel[1] = tan[1] * v * keep;
    ps.vel[2] = tan[2] * v * keep;
    if (why === 'jump') {
      // Uncharged ollie off the rail: vertical only, so the along-rail speed
      // GR-04 measures is carried across the exit frame untouched (loss 0).
      ps.vel[1] += EXIT_POP;
      // ...and the prewind held at lock-on goes into the air with the rider.
      if (gs._prewind) ps.prewound = gs._prewind;
    }
    gs.lastLeaveSpeed = Math.abs(v) * keep;
    gs.onRail = false;
    gs.railId = null;
    gs.bailed = why === 'bail';
    gs.balance = clamp(gs.balance, -1, 1);
    gs._cool = RELOCK_COOL;
  }

  function tryCapture(gs, ps) {
    if (gs._cool > 0 || rails.length === 0) return;
    const sp = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
    if (sp < MIN_LOCK) return;                       // GR-08: too slow to grind
    // Research 02 sec 1.5: capture is tested on contact or while descending
    // onto the rail. A rider climbing past a rail does not hook it.
    if (!ps.onGround && ps.vel[1] > 0) return;
    let pick = null, pickRail = null;
    for (const r of rails) {
      if (r.L <= 0) continue;
      const c = closestOn(r, ps.pos);
      if (!c || c.dist > CAPTURE_R) continue;        // GR-08: too far off line
      // The board can only be redirected onto the rail if the approach is
      // inside the board's own redirect limit (Tux MAX_TURN_ANGLE).
      const vh = Math.hypot(ps.vel[0], ps.vel[2]) || 1e-9;
      const th = Math.hypot(c.tan[0], c.tan[2]) || 1e-9;
      const cosA = (ps.vel[0] * c.tan[0] + ps.vel[2] * c.tan[2]) / (vh * th);
      if (Math.abs(cosA) < Math.cos(CURVE_TOL)) continue;
      const dirSign = cosA >= 0 ? 1 : -1;
      // Must have rail left in the direction of travel (prevents re-hooking the
      // end of a rail the rider has just run off).
      if (dirSign > 0 ? c.s >= r.L - 1e-6 : c.s <= 1e-6) continue;
      if (!pick || c.dist < pick.dist) { pick = c; pickRail = r; pick.dirSign = dirSign; }
    }
    if (!pick) return;

    // ---- LOCK ON. The one position write this module is allowed: snap to the
    // closest point on the polyline (research 02 sec 1.5, standard spline-grind
    // implementation). Speed is carried across MAGNITUDE-PRESERVING, which is
    // the contact law the accepted physics core already uses (retangent()).
    ps.pos[0] = pick.q[0]; ps.pos[1] = pick.q[1]; ps.pos[2] = pick.q[2];
    gs.onRail = true;
    gs.railId = pickRail.id;
    gs._s = pick.s;
    gs._dir = pick.dirSign;
    gs.alongSpeed = sp * pick.dirSign;
    gs.t = pickRail.L > 0 ? pick.s / pickRail.L : 0;
    gs.bailed = false;
    gs.lockFrames = 1;
    gs._prewind = ps.prewound || ps._prewind || 0;
    // Capture residual -> initial lean. The rider arrives with the CoM `lat`
    // metres off the rail line (a lean of atan(lat/L_COM)) and with `vlat` of
    // lateral velocity, which the snap converts into roll rate; a roll rate w
    // seeds the unstable mode with amplitude w/OMEGA0. Both are geometry, not
    // tuning. Clamped short of 1 so a capture is never an instant bail — a
    // capture that bails on its own lock frame is not a capture (CHOICE; cost:
    // the sloppiest legal landing gets a fraction of a second of grace).
    const vlat = ps.vel[0] * pick.left[0] + ps.vel[2] * pick.left[2];
    gs.balance = clamp(
      (Math.atan(pick.lat / L_COM) + (vlat / L_COM) / OMEGA0) / THETA_MAX, -0.9, 0.9);
    const e = evalRail(pickRail, gs._s);
    gs._kap = e.kap;
    ps.vel[0] = e.tan[0] * gs.alongSpeed;
    ps.vel[1] = e.tan[1] * gs.alongSpeed;
    ps.vel[2] = e.tan[2] * gs.alongSpeed;
  }

  function step(gs, ps, input, dt) {
    const inp = input || {};
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);
    if (!gs.onRail) { tryCapture(gs, ps); return gs; }

    const r = byId.get(gs.railId);
    if (!r) { gs.onRail = false; return gs; }
    const dirSign = gs._dir;

    // --- exit first, so the exit frame carries the previous frame's speed
    //     across with no drag step at all (GR-04 compares exactly that pair).
    if (inp.jumpRelease) {
      leave(gs, ps, evalRail(r, gs._s).tan, 'jump');
      return gs;
    }

    // --- 1-D arclength dynamics, closed form (GR-09).
    //     dv/dt = D - MU_RAIL*g - LAM_RAIL*v   with v = |ds/dt|.
    //     No steering term: the rail carries the lateral load, so a grind has
    //     no edge scrub and stick input costs no speed. (It also keeps the
    //     speed integration independent of the balance controller, which is
    //     what makes the dt split exact.)
    const boosting = !!inp.boost && (ps.boostMeter ?? 0) > 0;
    const accel = (boosting ? BOOST_THRUST : 0) - MU_RAIL * PH.G;
    let spd = Math.abs(gs.alongSpeed);
    const ds = flowS(spd, accel, LAM_RAIL, dt);
    spd = Math.min(flowV(spd, accel, LAM_RAIL, dt), PH.V_CAP);
    gs.alongSpeed = spd * dirSign;
    gs._s += ds * dirSign;

    // --- ran out of rail: step off at full speed, no penalty.
    if (gs._s >= r.L || gs._s <= 0) {
      gs._s = clamp(gs._s, 0, r.L);
      gs.t = r.L > 0 ? gs._s / r.L : 0;
      leave(gs, ps, evalRail(r, gs._s).tan, 'end');
      return gs;
    }
    // --- too slow to hold an edge on a steel rail (Tux MIN_FRICT_SPEED).
    if (spd < MIN_LOCK) {
      gs.t = r.L > 0 ? gs._s / r.L : 0;
      leave(gs, ps, evalRail(r, gs._s).tan, 'slow');
      return gs;
    }

    const e = evalRail(r, gs._s);
    gs._kap = e.kap;
    gs.t = r.L > 0 ? gs._s / r.L : 0;

    // --- BALANCE: unstable mode of the linearised inverted pendulum.
    //   db/dt = OMEGA0*(b + bias + curveLoad) - AUTHORITY*steer
    // curveLoad is the lean the bend demands, normalised by the bail angle:
    //   phi_c = atan(v^2*kappaRight/g)   (the motorcycle lean angle; the rail's
    //   lateral reaction acts at the board while the CoM is L_COM above it, so
    //   an unleaning rider is thrown to the OUTSIDE of the bend, harder as v^2)
    // With kappaRight > 0 (right bend) this drives balance positive = falling
    // left = outward, and positive steer (into the bend) is what cancels it.
    const phiC = Math.atan(spd * spd * e.kap / PH.G);
    const load = STANCE_BIAS + phiC / THETA_MAX;
    const steer = clamp(inp.steer ?? 0, -1, 1);
    const K = OMEGA0 * load - BAL_AUTHORITY * steer;
    gs.balance = flowBal(gs.balance, OMEGA0, K, dt);

    if (Math.abs(gs.balance) > 1) {                   // GR-05/GR-06: bail
      leave(gs, ps, e.tan, 'bail');
      return gs;
    }

    // --- carry the rider along the rail with VELOCITY ONLY (GR-07).
    // vel = tangent*alongSpeed + TRACK_GAIN*(railPoint - pos): a pursuit term
    // that cancels the first-order error of stepping a curve along tangents and
    // the sag physics' air gravity puts in between our writes, without the
    // module ever touching pos again. Steady-state offsets are centimetres
    // (2.7 cm of sag; ~1.7 cm outward on a 40 m bend at 18 m/s), and the term
    // is perpendicular to travel, so it cannot inflate the measured speed.
    const err = [e.pt[0] - ps.pos[0], e.pt[1] - ps.pos[1], e.pt[2] - ps.pos[2]];
    const dist = Math.hypot(err[0], err[1], err[2]);
    if (dist > CAPTURE_R) {                           // yanked off the line
      leave(gs, ps, e.tan, 'lost');
      return gs;
    }
    ps.vel[0] = e.tan[0] * gs.alongSpeed + TRACK_GAIN * err[0];
    ps.vel[1] = e.tan[1] * gs.alongSpeed + TRACK_GAIN * err[1];
    ps.vel[2] = e.tan[2] * gs.alongSpeed + TRACK_GAIN * err[2];
    gs.lockFrames++;
    return gs;
  }

  return { config, init, step };
}
