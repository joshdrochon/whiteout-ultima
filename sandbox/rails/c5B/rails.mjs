// Candidate c5B — rails/grind as a BOUNDED-INPUT CONTROL PROBLEM.
//
// Plant (roll axis, linearised):  th'' = wn^2*th + w - u,  wn = sqrt(g/h).
// Divergent mode  sig = th + th'/wn  obeys  sig' = wn*sig + (w-u)/wn.
// With |u| <= umax the null-controllable set of that mode is |sig| < umax/wn^2.
// `balance` IS that coordinate, normalised: b = sig*wn^2/umax, so
//     b' = wn*(b + aLat/A_AUTH + aTex/A_AUTH - steer),   bail at |b| > 1.
// A_AUTH = umax*h is lateral authority in m/s^2; aLat = v^2*kappa is the curve
// load, so demand rises with the SQUARE of speed. See NOTES.md for what is
// derived (wn) and what is a CHOICE (A_AUTH, texture, drag).
// Along-tangent motion: gravity*(-t_y) minus dragScale * the accepted snow law,
// closed-form (dt-exact), absorbed at V_CAP.

const G = 9.81;
const MU_SNOW = 0.0305;      // physics DEFAULTS.MU_BASE
const LAM_SNOW = 0.2235;     // physics DEFAULTS.LAMBDA_LONG
const V_CAP = 33;            // physics DEFAULTS.V_CAP
const TAU_BOOST = 0.7;       // physics DEFAULTS.TAU_BOOST
const CROUCH_STEER = 0.45;   // physics DEFAULTS.CROUCH_STEER

const H_COM = 0.90;                       // m, rider 1.8 m -> CoM at half height
const OMEGA_N = Math.sqrt(G / H_COM);     // 3.3015 /s, unstable pole
const A_AUTH = 21.0;                      // m/s^2 lateral authority (CHOICE)
const K_STAB = 10.0;                      // 1/s constraint stabilisation
const CURV_REF_M = 6.0;                   // m, reporting length for curveTolerance
const V_REF = 18.0;                       // m/s, research 02 sec 1.6 cruise top

// Rail texture: zero-mean deterministic lateral disturbance indexed by
// ARCLENGTH, so no rail has a systematically good side. It is what makes the
// divergent mode actually diverge for a passive rider.
const TEX_A = 0.42;                       // m/s^2 peak
const TEX_L1 = 160, TEX_P1 = 0.60;        // long swell (quasi-static vs 1/wn)
const TEX_L2 = 13.0, TEX_P2 = 2.10;       // short ripple
const TWO_PI = Math.PI * 2;
const textureAt = s =>
  TEX_A * (Math.sin(TWO_PI * s / TEX_L1 + TEX_P1)
    + 0.25 * Math.sin(TWO_PI * s / TEX_L2 + TEX_P2)) / 1.25;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createRails(env) {
  const cfg = {
    // --- contract-required surface ---
    captureRadius_m: 1.00,        // horizontal, ~one board length (research 02 sec 1.5 [EST])
    dragScale: 0.20,              // rail drag = 0.20 x the accepted snow law
    balanceHalfLife_s: Math.LN2 / OMEGA_N,   // 0.210 s: doubling time of the
                                  // divergent mode (= half-life of its stable twin)
    curveTolerance_rad: (A_AUTH / (V_REF * V_REF)) * CURV_REF_M,  // 0.389 rad of
                                  // rail bend per 6 m at which load == authority
    minLockSpeed_mps: 3.0,
    // --- model ---
    comHeight_m: H_COM, omegaN_rps: OMEGA_N, authority_mps2: A_AUTH,
    texturePeak_mps2: TEX_A, crouchAuthority: CROUCH_STEER,
    captureHalfHeight_m: 0.75, captureAlignDot: 0.5,
    stabGain_hz: K_STAB, vCap_mps: V_CAP, railBoostTarget_mps: V_CAP,
    popCooldown_s: 0.70, bailCooldown_s: 0.70, endCooldown_s: 0.40,
    searchBack_m: 3.0, searchAhead_m: 6.0,
    // Refuse a lock with less than this much rail left ahead: half a second of
    // grind at cruise. Also the only sane answer to a SELF-OVERLAPPING rail
    // (the 720 deg probe arc ends on top of its own start), where the nearest
    // point to an arriving rider is the last two metres of the final loop.
    minGrindLength_m: 8.0,
  };

  // ---------- geometry ----------
  function buildRail(r) {
    const P = r.points;
    const segs = [];
    let acc = 0;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const L = Math.hypot(dx, dy, dz) || 1e-9;
      const Lh = Math.hypot(dx, dz) || 1e-9;
      segs.push({ a, dx, dy, dz, L, s0: acc,
        tx: dx / L, ty: dy / L, tz: dz / L,      // 3D unit tangent
        hx: dx / Lh, hz: dz / Lh });             // horizontal unit tangent
      acc += L;
    }
    const n = segs.length;
    // Signed curvature AT VERTICES (turn angle shared over the adjacent half
    // segments), linearly interpolated in between. A fixed-lookahead probe on a
    // coarse polyline (the 720 deg arc is a 30 deg-per-segment polygon) reads 0
    // mid-segment and 2x at a vertex; this reads the true 1/R everywhere.
    const kv = new Array(n + 1).fill(0);
    for (let i = 1; i < n; i++) {
      const p = segs[i - 1], q = segs[i];
      const turn = Math.atan2(p.hx * q.hz - p.hz * q.hx, p.hx * q.hx + p.hz * q.hz);
      kv[i] = turn / (0.5 * (p.L + q.L));
    }
    if (n >= 2) { kv[0] = kv[1]; kv[n] = kv[n - 1]; }
    const sv = [0];
    for (let i = 0; i < n; i++) sv.push(segs[i].s0 + segs[i].L);
    return { id: r.id, width: r.width ?? 0.2, segs, kv, sv, total: acc };
  }
  const rails = (env?.rails ?? []).map(buildRail).filter(r => r.segs.length > 0);

  function curvatureAt(R, s) {
    const sv = R.sv, kv = R.kv;
    let i = 1;
    while (i < sv.length - 1 && sv[i] < s) i++;
    const span = sv[i] - sv[i - 1];
    const t = span > 1e-9 ? clamp((s - sv[i - 1]) / span, 0, 1) : 0;
    return kv[i - 1] + (kv[i] - kv[i - 1]) * t;
  }

  // Closest point by HORIZONTAL distance. `sLo/sHi` restrict the search to a
  // window of arclength — required because a multi-loop rail (720 deg arc)
  // passes over itself and a global search would teleport `s` between loops.
  function closestOn(R, x, z, sLo, sHi) {
    let best = null;
    for (const sg of R.segs) {
      if (sLo !== undefined && (sg.s0 + sg.L < sLo || sg.s0 > sHi)) continue;
      const ex = sg.dx, ez = sg.dz;
      const den = ex * ex + ez * ez;
      const u = den > 1e-12
        ? clamp(((x - sg.a[0]) * ex + (z - sg.a[2]) * ez) / den, 0, 1) : 0;
      const px = sg.a[0] + ex * u, pz = sg.a[2] + ez * u;
      const d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { d, px, pz, py: sg.a[1] + sg.dy * u,
        s: sg.s0 + sg.L * u, seg: sg, rail: R };
    }
    return best;
  }
  // Best ADMISSIBLE capture point over every rail: inside the capture radius and
  // height window, roughly aligned with travel, moving fast enough, and with
  // enough rail left ahead to be worth grinding.
  function bestCapture(ps) {
    const sp3 = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
    if (sp3 < cfg.minLockSpeed_mps) return null;
    let best = null;
    for (const R of rails) {
      for (const sg of R.segs) {
        const ex = sg.dx, ez = sg.dz;
        const den = ex * ex + ez * ez;
        const u = den > 1e-12
          ? clamp(((ps.pos[0] - sg.a[0]) * ex + (ps.pos[2] - sg.a[2]) * ez) / den, 0, 1) : 0;
        const px = sg.a[0] + ex * u, pz = sg.a[2] + ez * u;
        const d = Math.hypot(ps.pos[0] - px, ps.pos[2] - pz);
        if (d > cfg.captureRadius_m || (best && d >= best.d)) continue;
        const py = sg.a[1] + sg.dy * u;
        if (Math.abs(py - ps.pos[1]) > cfg.captureHalfHeight_m) continue;
        const proj = ps.vel[0] * sg.tx + ps.vel[1] * sg.ty + ps.vel[2] * sg.tz;
        if (Math.abs(proj) < cfg.minLockSpeed_mps) continue;
        if (Math.abs(proj) / sp3 < cfg.captureAlignDot) continue;   // crossing, not riding
        const s = sg.s0 + sg.L * u;
        const ahead = proj >= 0 ? R.total - s : s;
        if (ahead < cfg.minGrindLength_m) continue;
        best = { d, px, py, pz, s, seg: sg, rail: R, proj, sp3 };
      }
    }
    return best;
  }

  function init() {
    return { onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      _rail: null, _s: 0, _dir: 1, _cool: 0, _load: 0, _tex: 0, _kappa: 0 };
  }

  function release(gs, ps, cool, bailed) {
    gs.onRail = false;
    gs.bailed = !!bailed;
    gs.lastLeaveSpeed = gs.alongSpeed;
    gs._cool = cool;
    gs._rail = null;
    ps.constrained = false;
  }

  function step(gs, ps, input, dt) {
    const inp = input ?? {};
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    // ---------- not on a rail: AUTO lock-on, no button ----------
    if (!gs.onRail) {
      if (gs._cool > 0 || rails.length === 0) return gs;
      const c = bestCapture(ps);
      if (!c) return gs;

      // THE ONE LEGAL POSITION WRITE: the documented lock-on snap, bounded by
      // captureRadius horizontally and captureHalfHeight vertically.
      ps.pos[0] = c.px; ps.pos[1] = c.py; ps.pos[2] = c.pz;
      gs.onRail = true; gs.railId = c.rail.id; gs.bailed = false;
      gs.balance = 0; gs.lockFrames = 0;
      gs._rail = c.rail; gs._s = c.s; gs._dir = c.proj >= 0 ? 1 : -1;
      // Entry speed follows the ACCEPTED PHYSICS' own two rules, so a descending
      // rail is not taxed for being descending:
      //   grounded rider crossing onto the rail -> retangent(): magnitude kept;
      //   airborne rider landing on it          -> land():      normal killed.
      gs.alongSpeed = ps.onGround ? c.sp3 : Math.abs(c.proj);
      ps.constrained = true;
    }

    // ---------- on rail ----------
    if (inp.jumpRelease) {                       // pop: speed & prewind kept,
      release(gs, ps, cfg.popCooldown_s, false); // velocity untouched
      return gs;
    }
    if (!ps.constrained && gs.lockFrames > 0) {  // physics released us some other way
      release(gs, ps, cfg.popCooldown_s, false);
      return gs;
    }
    ps.constrained = true;
    gs.lockFrames++;

    const R = gs._rail;
    const c = closestOn(R, ps.pos[0], ps.pos[2],
      gs._s - cfg.searchBack_m, gs._s + cfg.searchAhead_m)
      ?? closestOn(R, ps.pos[0], ps.pos[2]);
    if (!c) { release(gs, ps, cfg.endCooldown_s, false); return gs; }
    gs._s = c.s;
    gs.t = R.total > 0 ? clamp(c.s / R.total, 0, 1) : 0;

    // ran out of rail
    if ((gs._dir > 0 && c.s >= R.total - 0.02) || (gs._dir < 0 && c.s <= 0.02)) {
      release(gs, ps, cfg.endCooldown_s, false);
      return gs;
    }

    const sg = c.seg, d = gs._dir;
    const tx = d * sg.tx, ty = d * sg.ty, tz = d * sg.tz;   // travel direction, 3D
    const cosT = Math.hypot(tx, tz);                        // = cos(inclination)

    // --- along-tangent speed, dt-EXACT closed form of dv/dt = A - B v ---
    // A = -g*t_y (gravity along the rail; positive DESCENDING)
    //     - dragScale * MU * g * cos(theta)          [Coulomb, scaled snow law]
    // B = dragScale * LAMBDA                          [linear, scaled snow law]
    let A = -G * ty - cfg.dragScale * MU_SNOW * G * cosT;
    let B = cfg.dragScale * LAM_SNOW;
    if (inp.boost && (ps.boostMeter ?? 0) > 0) {   // "faster boosting on a rail
      A += cfg.railBoostTarget_mps / TAU_BOOST;    //  than on the snow"
      B += 1 / TAU_BOOST;
    }
    const veq = A / B;
    let v = veq + (gs.alongSpeed - veq) * Math.exp(-B * dt);
    // Both clamps are ABSORBING boundaries on a monotone flow, so one 100 ms
    // step and ten 10 ms steps land on the same value (GR-09 stays exact).
    if (v < 0) v = 0;
    if (v > V_CAP) v = V_CAP;
    gs.alongSpeed = v;

    // --- balance: the divergent mode under bounded input, dt-exact ---
    const kappa = curvatureAt(R, c.s) * d;          // signed, travel-relative
    const aLat = v * v * kappa;                     // m/s^2 toward the rail-left normal
    const load = -aLat / A_AUTH;                    // rider is thrown the other way
    const tex = textureAt(c.s) / A_AUTH;
    const authority = inp.crouch ? CROUCH_STEER : 1;   // charging a pop costs stick
    const steer = clamp(inp.steer ?? 0, -1, 1) * authority;
    const q = OMEGA_N * (load + tex - steer);
    const qw = q / OMEGA_N;
    gs.balance = (gs.balance + qw) * Math.exp(OMEGA_N * dt) - qw;
    gs._kappa = kappa; gs._load = load; gs._tex = tex;

    if (!(Math.abs(gs.balance) <= 1)) {              // catches NaN too
      gs.balance = clamp(gs.balance, -1.5, 1.5);
      release(gs, ps, cfg.bailCooldown_s, true);
      return gs;
    }

    // --- VELOCITY ONLY: physics integrates position and turns the board ---
    let vx = v * tx, vy = v * ty, vz = v * tz;
    // Baumgarte-style constraint stabilisation: the project integrates position
    // with an Euler step, which drifts OUTWARD on a bend (~1 m over 8 s at
    // R=20). Pull the board back to the rail line with VELOCITY, never position.
    const nx = -sg.hz * d, nz = sg.hx * d;          // rail-left unit normal
    const lat = (c.px - ps.pos[0]) * nx + (c.pz - ps.pos[2]) * nz;
    vx += K_STAB * lat * nx; vz += K_STAB * lat * nz;
    vy += K_STAB * (c.py - ps.pos[1]);
    const m = Math.hypot(vx, vy, vz);
    if (m > V_CAP) { const k = V_CAP / m; vx *= k; vy *= k; vz *= k; }
    ps.vel[0] = vx; ps.vel[1] = vy; ps.vel[2] = vz;
    return gs;
  }

  return { config: cfg, init, step };
}
