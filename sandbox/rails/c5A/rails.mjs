// Rails c5A — the grind as a RIGID-BODY BALANCE about the board's contact edge.
// Derivations and CHOICEs are in NOTES.md; each CHOICE is tagged inline.
// Owns: along-rail speed, lateral CoM balance, lock/exit, ps.constrained.
// Never writes heading, trick state, or position except the one lock-on snap.

export function createRails(env) {
  const G = 9.81;
  const PI = Math.PI;
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const wrapPi = a => { while (a > PI) a -= 2 * PI; while (a < -PI) a += 2 * PI; return a; };

  // ---------------------------------------------------------------- geometry
  const RIDER_H_M = 1.8;                 // project convention
  const COM_FRAC = 0.55;                 // CoM at 55% of stature (Winter, anthropometry)
  const H_COM = RIDER_H_M * COM_FRAC;    // 0.990 m above the contact edge
  const BOARD_W_M = 0.25;                // waist width of a board for a 1.8 m rider
  const BOARD_L_M = 1.55;                // effective edge length
  const NOM_RAIL_W = 0.20;               // nominal rail top width (runner rails)

  // DERIVED: half-width of the support polygon = half of the narrower of board
  // and rail top. Tip-over lean angle = atan(a / H_COM).
  const halfSupport = railW => Math.min(BOARD_W_M, railW ?? NOM_RAIL_W) / 2;
  const A_NOM = halfSupport(NOM_RAIL_W);                 // 0.100 m
  const TIP_ANGLE_RAD = Math.atan(A_NOM / H_COM);        // 0.1006 rad = 5.77 deg

  // DERIVED: inverted-pendulum toppling rate about the contact edge.
  // xdd = (g/h) x  for a point mass at height h  ->  omega = sqrt(g/h).
  const OMEGA = Math.sqrt(G / H_COM);                    // 3.148 /s

  // CHOICE: body damping ratio zeta_p = 1 on the pendulum's own frequency.
  const ZETA_P = 1.0;
  const C_DAMP = 2 * ZETA_P * OMEGA;                     // 6.297 /s

  // CHOICE: maximum rider lean, 58 deg. Steering authority is the lateral CoM
  // acceleration a lean of that angle buys: a = g*tan(lean).
  const LEAN_MAX_DEG = 58;
  const A_CTL = G * Math.tan(LEAN_MAX_DEG * PI / 180);   // 15.70 m/s^2 = 1.60 g

  // CONTACT MIGRATION: the board ROLLS on the rail, so the pivot is not a fixed
  // line — it walks toward the loaded edge as the rider leans, which lengthens
  // the toppling arm. Magnitude is a CHOICE (bounded above by A_NOM); because it
  // always acts on the falling side it is destabilising in BOTH directions, so
  // no rail gets a good side. At dead centre it breaks the tie toward the
  // rider's TOE edge (stance asymmetry) — rider-relative, so it flips in switch.
  const MIGRATION_M = 0.004;

  // CHOICE: crouching to charge a pop spends the lean range you need to steer.
  const CROUCH_STEER = 0.45;

  // ------------------------------------------------------------- along-rail
  const LAMBDA_SNOW = 0.2235;            // physics LAMBDA_LONG (interface constant)
  // DERIVED: linear drag scales with contact area. Snow = whole base;
  // rail = board width x rail top width.
  const DRAG_SCALE = (NOM_RAIL_W * BOARD_W_M) / (BOARD_L_M * BOARD_W_M); // 0.129
  const LAMBDA_RAIL = LAMBDA_SNOW * DRAG_SCALE;          // 0.0288 /s
  const MU_RAIL = 0.05;                  // CHOICE: base-on-steel Coulomb term
  const V_CAP = 33;                      // physics V_CAP (PC-22 interface constant)

  // ------------------------------------------------------------------ lock
  const CAPTURE_R = 1.0;                 // CHOICE, mid of research 02 §1.5 [EST] 0.5-1.5
  const MIN_LOCK = 3.0;                  // CHOICE: below this a grind stalls
  const COOL_JUMP = 0.6, COOL_BAIL = 1.2;
  const PULL = 10;                       // /s, velocity-level constraint pull

  // curvature is measured as tangent turn over a +-KAPPA_WIN window: the
  // integral of curvature, so a coarse control polyline cannot hide it.
  const KAPPA_WIN = 5.0;
  const RESAMPLE = 0.5;

  const KAPPA_CRIT = (A_CTL - OMEGA * OMEGA * A_NOM) / (18 * 18);  // rad/m at 18 m/s

  const cfg = {
    captureRadius_m: CAPTURE_R,
    dragScale: +DRAG_SCALE.toFixed(4),
    balanceHalfLife_s: +(Math.LN2 / (C_DAMP / 2)).toFixed(4),
    curveTolerance_rad: +(KAPPA_CRIT * 2 * KAPPA_WIN).toFixed(4),
    minLockSpeed_mps: MIN_LOCK,
    comHeight_m: +H_COM.toFixed(3),
    tipHalfWidth_m: +A_NOM.toFixed(3),
    tipAngle_rad: +TIP_ANGLE_RAD.toFixed(4),
    topplingRate_hz: +OMEGA.toFixed(3),
    leanMax_deg: LEAN_MAX_DEG,
    steerAuthority_mps2: +A_CTL.toFixed(3),
    contactMigration_m: MIGRATION_M,
    crouchSteerScale: CROUCH_STEER,
    lambdaRail_hz: +LAMBDA_RAIL.toFixed(5),
    muRail: MU_RAIL,
    vCap_mps: V_CAP,
    critRadius18_m: +(1 / KAPPA_CRIT).toFixed(2),
  };

  // ------------------------------------------------- rail centreline prebuild
  const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function crEval(p0, p1, p2, p3, u) {           // centripetal Catmull-Rom
    const kn = (ti, pi, pj) => ti + Math.max(1e-4, Math.pow(d3(pi, pj), 0.5));
    const t0 = 0, t1 = kn(t0, p0, p1), t2 = kn(t1, p1, p2), t3 = kn(t2, p2, p3);
    const t = t1 + (t2 - t1) * u;
    const mix = (a, b, ta, tb) => {
      const w = (t - ta) / (tb - ta || 1e-9);
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w, a[2] + (b[2] - a[2]) * w];
    };
    const a1 = mix(p0, p1, t0, t1), a2 = mix(p1, p2, t1, t2), a3 = mix(p2, p3, t2, t3);
    const b1 = mix(a1, a2, t0, t2), b2 = mix(a2, a3, t1, t3);
    return mix(b1, b2, t1, t2);
  }

  function buildRail(r) {
    const P = (r.points ?? []).map(p => [+p[0], +p[1], +p[2]]);
    if (P.length < 2) return null;
    const refl = (a, b) => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
    const ext = [refl(P[0], P[1]), ...P, refl(P[P.length - 1], P[P.length - 2])];
    const raw = [];
    for (let i = 0; i + 3 < ext.length; i++) {
      const M = Math.max(4, Math.ceil(d3(ext[i + 1], ext[i + 2]) / 0.2));
      for (let j = 0; j < M; j++) raw.push(crEval(ext[i], ext[i + 1], ext[i + 2], ext[i + 3], j / M));
    }
    raw.push(P[P.length - 1]);
    // uniform arclength resample
    const pts = [raw[0]]; let carry = 0;
    for (let i = 1; i < raw.length; i++) {
      const seg = d3(raw[i - 1], raw[i]);
      if (seg < 1e-9) continue;
      let used = 0;
      while (carry + (seg - used) >= RESAMPLE) {
        used += RESAMPLE - carry; carry = 0;
        const w = used / seg;
        pts.push([raw[i - 1][0] + (raw[i][0] - raw[i - 1][0]) * w,
          raw[i - 1][1] + (raw[i][1] - raw[i - 1][1]) * w,
          raw[i - 1][2] + (raw[i][2] - raw[i - 1][2]) * w]);
      }
      carry += seg - used;
    }
    if (pts.length < 2) return null;
    const n = pts.length;
    const s = new Float64Array(n), psi = new Float64Array(n);
    const tx = new Float64Array(n), ty = new Float64Array(n), tz = new Float64Array(n);
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + d3(pts[i - 1], pts[i]);
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      const L = d3(a, b) || 1e-9;
      tx[i] = (b[0] - a[0]) / L; ty[i] = (b[1] - a[1]) / L; tz[i] = (b[2] - a[2]) / L;
      psi[i] = Math.atan2(tz[i], tx[i]);
    }
    // curvature = net tangent turn over a +-KAPPA_WIN arclength window / span
    const w = Math.max(1, Math.round(KAPPA_WIN / RESAMPLE));
    const kap = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - w), hi = Math.min(n - 1, i + w);
      const span = s[hi] - s[lo];
      kap[i] = span > 1e-6 ? wrapPi(psi[hi] - psi[lo]) / span : 0;
    }
    return { id: r.id, width: r.width ?? NOM_RAIL_W, pts, s, tx, ty, tz, kap,
      total: s[n - 1], n };
  }

  const rails = (env?.rails ?? []).map(buildRail).filter(Boolean);

  // nearest point on a prebuilt rail; searches [i0-win, i0+win] when given a hint
  function nearestOn(rl, x, y, z, hint) {
    let lo = 0, hi = rl.n - 1;
    if (hint !== undefined) { lo = Math.max(0, hint - 40); hi = Math.min(rl.n - 1, hint + 40); }
    let bi = lo, bd = Infinity;
    for (let i = lo; i <= hi; i++) {
      const p = rl.pts[i];
      const dd = (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2;
      if (dd < bd) { bd = dd; bi = i; }
    }
    // refine along the two adjacent segments
    let px = rl.pts[bi][0], py = rl.pts[bi][1], pz = rl.pts[bi][2], ps = rl.s[bi];
    let best = bd;
    for (const j of [bi - 1, bi + 1]) {
      if (j < 0 || j >= rl.n) continue;
      const a = rl.pts[bi], b = rl.pts[j];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const L2 = dx * dx + dy * dy + dz * dz || 1e-12;
      const u = clamp(((x - a[0]) * dx + (y - a[1]) * dy + (z - a[2]) * dz) / L2, 0, 1);
      const qx = a[0] + dx * u, qy = a[1] + dy * u, qz = a[2] + dz * u;
      const dd = (qx - x) ** 2 + (qy - y) ** 2 + (qz - z) ** 2;
      if (dd < best) { best = dd; px = qx; py = qy; pz = qz;
        ps = rl.s[bi] + (rl.s[j] - rl.s[bi]) * u; }
    }
    return { d: Math.sqrt(best), i: bi, px, py, pz, s: ps,
      tx: rl.tx[bi], ty: rl.ty[bi], tz: rl.tz[bi], kap: rl.kap[bi], rail: rl };
  }
  function nearestAny(x, y, z) {
    let best = null;
    for (let k = 0; k < rails.length; k++) {
      const c = nearestOn(rails[k], x, y, z); c.ri = k;
      if (!best || c.d < best.d) best = c;
    }
    return best;
  }

  // --------------------------------------------------- balance, closed form
  // xdd = OMEGA^2*x + F - C_DAMP*xd   (F constant over the step -> exact)
  const W2 = OMEGA * OMEGA;
  const DISC = Math.sqrt(C_DAMP * C_DAMP + 4 * W2);
  const R1 = (-C_DAMP + DISC) / 2, R2 = (-C_DAMP - DISC) / 2;   // R1>0 unstable
  function balanceStep(x, xd, F, dt) {
    const xp = -F / W2;
    const y0 = x - xp, yd0 = xd;
    const c1 = (yd0 - R2 * y0) / (R1 - R2), c2 = (R1 * y0 - yd0) / (R1 - R2);
    const e1 = Math.exp(R1 * dt), e2 = Math.exp(R2 * dt);
    return [c1 * e1 + c2 * e2 + xp, R1 * c1 * e1 + R2 * c2 * e2];
  }

  function init() {
    return { onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      _x: 0, _xd: 0, _i: 0, _r: 0, _cool: 0, _a: A_NOM };
  }

  function release(gs, ps, cool, bailed) {
    gs.onRail = false; gs.bailed = !!bailed; gs._cool = cool;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    ps.constrained = false;
  }

  function step(gs, ps, input, dt) {
    const inp = input ?? {};
    if (gs._cool > 0) gs._cool -= dt;

    // ---------------------------------------------------------- acquisition
    if (!gs.onRail) {
      if (gs._cool > 0 || rails.length === 0) return gs;
      const c = nearestAny(ps.pos[0], ps.pos[1], ps.pos[2]);
      if (!c || c.d > CAPTURE_R) return gs;
      const along = ps.vel[0] * c.tx + ps.vel[1] * c.ty + ps.vel[2] * c.tz;  // 3D:
      // a descending rail must NOT be taxed for using horizontal speed only
      if (Math.abs(along) < MIN_LOCK) return gs;
      // the ONE legal position write: the documented lock-on snap (<= CAPTURE_R)
      ps.pos[0] = c.px; ps.pos[1] = c.py; ps.pos[2] = c.pz;
      ps.constrained = true;
      gs.onRail = true; gs.bailed = false; gs.railId = c.rail.id;
      gs.alongSpeed = along; gs._i = c.i; gs._r = c.ri; gs.lockFrames = 0;
      gs._a = halfSupport(c.rail.width);
      gs.t = c.rail.total ? c.s / c.rail.total : 0;
      // The lock-on ABSORBS the lateral approach: the rider starts centred and
      // at rest laterally. CHOICE (omission), cost stated in NOTES: a crossways
      // arrival is forgiven at entry and only bites later through curvature.
      gs._x = 0; gs._xd = 0; gs.balance = 0;
      return gs;
    }

    // --------------------------------------------------------- riding a rail
    gs.lockFrames++;
    const rl = rails[gs._r] ?? rails[0];
    if (!rl) { release(gs, ps, COOL_BAIL, true); return gs; }
    const c = nearestOn(rl, ps.pos[0], ps.pos[1], ps.pos[2], gs._i);
    gs._i = c.i;
    const a = gs._a;

    // --- POP. Physics' constrainedStep already performed the takeoff THIS frame
    // (world-up charge-scaled impulse, rotation reset, prewind carried), so the
    // module must return before it writes velocity — writing the rail tangent
    // over ps.vel here would erase the whole vertical impulse and the
    // rail-into-big-air link with it.
    if (inp.jumpRelease) { release(gs, ps, COOL_JUMP, false); return gs; }

    // --- along-rail speed: gravity along the tangent + Coulomb + linear drag.
    // dv/dt = aT - LAMBDA*v with aT constant over the step -> closed form,
    // dt-exact (never Euler). ty is dy/ds, i.e. sin(slope), negative descending.
    const cosT = Math.sqrt(Math.max(0, 1 - c.ty * c.ty));
    const sgn = gs.alongSpeed >= 0 ? 1 : -1;
    const gravAlong = -G * c.ty, coul = MU_RAIL * G * cosT;
    const aT = gravAlong - coul * sgn;
    const term = aT / LAMBDA_RAIL;
    let v = term + (gs.alongSpeed - term) * Math.exp(-LAMBDA_RAIL * dt);
    if (sgn * v < 0 && Math.abs(gravAlong) <= coul) v = 0;   // stiction, no reversal
    gs.alongSpeed = clamp(v, -V_CAP, V_CAP);
    if (Math.abs(gs.alongSpeed) < MIN_LOCK * 0.5) { release(gs, ps, COOL_BAIL, true); return gs; }

    // --- balance: inverted pendulum about the contact edge, closed form.
    // The pivot migrates toward whichever edge is loaded, so the extra arm is
    // always destabilising: mirrored bends are bit-identical and no rail has a
    // good side. Dead centre it breaks the tie toward the rider's toe edge,
    // which is rider-relative and flips in switch.
    const toe = (Math.cos(ps.heading) * c.tx + Math.sin(ps.heading) * c.tz) >= 0 ? 1 : -1;
    const lean = Math.abs(gs._x) > 1e-9 ? Math.sign(gs._x) : toe;
    const kap = c.kap;
    const aLat = -gs.alongSpeed * gs.alongSpeed * kap;   // apparent load, outward
    const steer = clamp(inp.steer ?? 0, -1, 1);
    const auth = A_CTL * (inp.crouch ? CROUCH_STEER : 1);
    const F = W2 * (lean * MIGRATION_M) + aLat - auth * steer;
    const [nxb, nxd] = balanceStep(gs._x, gs._xd, F, dt);
    gs._x = nxb; gs._xd = nxd;
    gs.balance = gs._x / a;
    if (Math.abs(gs.balance) > 1) {          // CoM outside the support: tipped
      release(gs, ps, COOL_BAIL, true); return gs;
    }

    // --- velocity: along the 3D tangent, plus a velocity-level pull that keeps
    // the board on the centreline (position is physics' to integrate).
    const ox = c.px - ps.pos[0], oy = c.py - ps.pos[1], oz = c.pz - ps.pos[2];
    let vx = c.tx * gs.alongSpeed + PULL * ox;
    let vy = c.ty * gs.alongSpeed + PULL * oy;
    let vz = c.tz * gs.alongSpeed + PULL * oz;
    const vm = Math.hypot(vx, vy, vz);
    if (vm > V_CAP) { const k = V_CAP / vm; vx *= k; vy *= k; vz *= k; }
    ps.vel[0] = vx; ps.vel[1] = vy; ps.vel[2] = vz;

    gs.t = c.rail.total ? c.s / c.rail.total : gs.t;

    // --- ran out of rail: a clean exit, not a bail.
    if (gs.t >= 0.999 || (c.rail.total - c.s) <= RESAMPLE) { release(gs, ps, COOL_JUMP, false); return gs; }
    return gs;
  }

  return { config: cfg, init, step };
}
