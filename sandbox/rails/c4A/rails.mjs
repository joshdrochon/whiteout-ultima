// Rails c4A — balance as the DIVERGENT MODE of an inverted pendulum on the rail.
// s = theta' + LAM*theta obeys s' = LAM*s + u with |u| <= U_MAX; balance is s
// normalised by U_MAX/LAM, so |balance| = 1 is the bounded-input recoverability
// boundary of that mode. Module writes VELOCITY + constrained only (plus the one
// documented lock-on position snap). Full derivation in NOTES.md.

const G = 9.81;

// --- physics constants MIRRORED from src/physics/physics.mjs DEFAULTS. env does
// not expose them; kept in sync by hand, overridable via env.physicsTuning.
const PHYS = { MU_BASE: 0.0305, LAMBDA_LONG: 0.2235, V_CAP: 33, V_BOOST: 31,
  TAU_BOOST: 0.7, CROUCH_STEER: 0.45, TUCK_STEER: 0.6 };

// --- rider geometry -> the unstable eigenvalue (derived) ---
const L_COM = 0.99;                       // m, CoM height over the board: 0.55 * 1.8 m
const LAM = Math.sqrt(G / L_COM);         // 3.1479 /s, unstable eigenvalue
// --- balance authority (CHOICE, see NOTES) ---
const THETA_AUTH = 28 * Math.PI / 180;    // rad, max steady lean the rider can hold
const U_MAX = G * THETA_AUTH / L_COM;     // 4.8425 rad/s^2, bounded corrective input
// balance = LAM * s / U_MAX  =>  a lateral rate of v_lat costs KGAIN * v_lat of balance,
// and a curvature kappa at speed v costs KGAIN * v^2 * kappa per second.
const KGAIN = LAM / (G * THETA_AUTH);     // 0.65662 s/m
// stance bias: FITTED so a straight rail with zero input bails at T_BAIL_FLAT
const T_BAIL_FLAT = 2.0;                  // s (CHOICE; GR-05 window is 0.8..6)
const BETA = LAM / (Math.exp(LAM * T_BAIL_FLAT) - 1);   // 0.005816 /s

const CAPTURE_R = 1.0;                    // m (research 02 sec 1.5 [EST] 0.5-1.5)
const MIN_LOCK_SPEED = 3.0;               // m/s
const DROP_SPEED = 1.5;                   // m/s, grind dies below this
const DRAG_SCALE = 0.35;                  // rail drag vs snow (CHOICE)
const CURV_WINDOW = 4.0;                  // m, half-window for curvature estimation
const LINE_PULL = 8.0;                    // /s, velocity-only correction back to the line
const COOL_BAIL = 1.0, COOL_POP = 0.4, COOL_END = 0.4;   // s re-lock lockouts
const UP_LOCK_VY = 0.5;                   // m/s, never capture while climbing faster

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrapPi = a => { a %= 2 * Math.PI; if (a > Math.PI) a -= 2 * Math.PI; if (a < -Math.PI) a += 2 * Math.PI; return a; };

export function createRails(env) {
  const T = { ...PHYS, ...(env?.physicsTuning ?? {}) };
  const config = {
    // contract-required
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,
    balanceHalfLife_s: Math.LN2 / LAM,      // DOUBLING time of the divergent mode
    curveTolerance_rad: THETA_AUTH,         // lean the rider can hold; beyond = no save
    minLockSpeed_mps: MIN_LOCK_SPEED,
    // published mechanism
    comHeight_m: L_COM,
    unstableEigenvalue_perS: LAM,
    balanceAuthority_radPerS2: U_MAX,
    balanceCaptureGain_sPerM: KGAIN,
    stanceBias_perS: BETA,
    passiveBailFlat_s: T_BAIL_FLAT,
    curvatureWindow_m: CURV_WINDOW,
    // R below which no bounded input holds the arc, at 18 m/s: v^2/(g*theta_auth)
    criticalRadius18_m: 18 * 18 / (G * THETA_AUTH),
    dropSpeed_mps: DROP_SPEED,
  };

  // ---------- rail geometry: arclength-parameterised polylines ----------
  const geo = (env?.rails ?? []).map(r => {
    const segs = []; let total = 0;
    for (let i = 0; i < r.points.length - 1; i++) {
      const a = r.points[i], b = r.points[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-9) continue;
      segs.push({ a, dx, dy, dz, L, s0: total, d: [dx / L, dy / L, dz / L] });
      total += L;
    }
    // curvature window must span at least one vertex either side, or a coarsely
    // tessellated rail reads dead straight inside each segment and the bend load
    // flickers on and off
    const meanSeg = segs.length ? total / segs.length : 0;
    // VERTEX TANGENTS. `points` are spline control points, so the chord of a
    // segment leads/lags the true tangent by half that segment's turn angle. On a
    // coarse arc that bias lands entirely on the capture frame: a rider arriving
    // dead-on reads a phantom lateral closing rate of v*sin(halfTurn) and gets a
    // balance seed that depends on how the rail was TESSELLATED, not on its
    // radius. Averaging adjacent chords at each vertex (and extrapolating
    // 1.5*d0 - 0.5*d1 at the ends, exact to first order on a circular arc)
    // removes it: measured entry seed falls from 0.687 to <0.01 at N = 12.
    const n = segs.length;
    const tv = [];
    for (let i = 0; i <= n; i++) {
      let v;
      if (i === 0) v = n > 1 ? mix(segs[0].d, segs[1].d, 1.5, -0.5) : segs[0].d.slice();
      else if (i === n) v = n > 1 ? mix(segs[n - 1].d, segs[n - 2].d, 1.5, -0.5) : segs[n - 1].d.slice();
      else v = mix(segs[i - 1].d, segs[i].d, 0.5, 0.5);
      tv.push(unit(v));
    }
    return { id: r.id, width: r.width ?? 0.2, segs, total, tv,
      cw: Math.max(CURV_WINDOW, 1.5 * meanSeg) };
  }).filter(g => g.segs.length > 0);

  function mix(a, b, ka, kb) { return [a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb]; }
  function unit(v) { const m = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / m, v[1] / m, v[2] / m]; }

  // closest point on a rail, 3D (the board meets the rail in space, not in plan)
  function closestOn(g, x, y, z) {
    let best = null;
    for (let i = 0; i < g.segs.length; i++) {
      const sg = g.segs[i];
      const u = clamp(((x - sg.a[0]) * sg.dx + (y - sg.a[1]) * sg.dy + (z - sg.a[2]) * sg.dz) / (sg.L * sg.L), 0, 1);
      const px = sg.a[0] + sg.dx * u, py = sg.a[1] + sg.dy * u, pz = sg.a[2] + sg.dz * u;
      const d = Math.hypot(x - px, y - py, z - pz);
      if (!best || d < best.d) best = { d, p: [px, py, pz], s: sg.s0 + sg.L * u,
        dir: unit(mix(g.tv[i], g.tv[i + 1], 1 - u, u)), g };
    }
    return best;
  }
  function closestAny(x, y, z) {
    let best = null;
    for (const g of geo) { const c = closestOn(g, x, y, z); if (c && (!best || c.d < best.d)) best = c; }
    return best;
  }
  // signed curvature (1/m) about +Y, from chord directions over a symmetric
  // arclength window. Exact for a circular arc; clamps gracefully at the ends.
  function curvatureAt(g, s) {
    const W = Math.min(g.cw, g.total * 0.5);
    if (W < 0.25) return 0;
    // slide the window inside the rail rather than truncating it: a truncated
    // window reads the first metres of every bend as straight, which is exactly
    // the free-then-ejected discontinuity this design is trying not to have
    let sB = clamp(s, W, g.total - W);
    const sA = sB - W, sC = sB + W;
    // rate of turn of the SMOOTH tangent field. Chord directions were biased ~12%
    // low on a coarsely tessellated arc (R = 400 read as 450) because a chord that
    // straddles a partial segment is not the tangent at its midpoint.
    const a = dirAt(g, sA), c = dirAt(g, sC);
    return wrapPi(Math.atan2(c[2], c[0]) - Math.atan2(a[2], a[0])) / (sC - sA);
  }
  // smooth unit tangent at arclength s (linear blend of vertex tangents)
  function dirAt(g, s) {
    s = clamp(s, 0, g.total);
    let lo = 0, hi = g.segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g.segs[m].s0 <= s) lo = m; else hi = m - 1; }
    const sg = g.segs[lo], u = clamp((s - sg.s0) / sg.L, 0, 1);
    return unit(mix(g.tv[lo], g.tv[lo + 1], 1 - u, u));
  }

  function init() {
    return { onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      _s: 0, _cool: 0, _kappa: 0, _lat: 0, _stick: 0, _dirSign: 1 };
  }

  function release(gs, ps, cool, bailed) {
    gs.onRail = false; gs.bailed = !!bailed; gs.lastLeaveSpeed = gs.alongSpeed;
    gs._cool = cool; gs.lockFrames = 0; ps.constrained = false;
  }

  function step(gs, ps, input, dt) {
    const inp = input ?? {};
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    // Physics owns the pop: constrainedStep clears `constrained` on jumpRelease and
    // has already performed the true takeoff. Do not touch velocity on that frame —
    // horizontal speed is carried through untouched (GR-04).
    if (gs.onRail && ps.constrained === false) { release(gs, ps, COOL_POP, false); return gs; }

    const vx = ps.vel[0], vy = ps.vel[1], vz = ps.vel[2];
    const speed3 = Math.hypot(vx, vy, vz);

    // ---------------- capture ----------------
    if (!gs.onRail) {
      if (gs._cool > 0 || speed3 < MIN_LOCK_SPEED) return gs;
      if (!ps.onGround && vy > UP_LOCK_VY) return gs;      // no capture while climbing
      const c = closestAny(ps.pos[0], ps.pos[1], ps.pos[2]);
      if (!c || c.d > CAPTURE_R) return gs;
      // travel direction along the rail (a rail is bidirectional)
      const sgn = (vx * c.dir[0] + vy * c.dir[1] + vz * c.dir[2]) >= 0 ? 1 : -1;
      const dir = [c.dir[0] * sgn, c.dir[1] * sgn, c.dir[2] * sgn];
      // lateral closing rate seeds the divergent mode: theta'(0) = v_lat / L_COM
      const nh = latNormal(dir);
      const vlat = vx * nh[0] + vz * nh[2];
      // *** the ONE documented position write: lock-on snap, |dp| <= captureRadius ***
      ps.pos[0] = c.p[0]; ps.pos[1] = c.p[1]; ps.pos[2] = c.p[2];
      gs.onRail = true; gs.railId = c.g.id; gs.bailed = false; gs.lockFrames = 0;
      gs._s = c.s; gs.t = c.g.total ? c.s / c.g.total : 0;
      // speed magnitude is preserved onto the tangent — the FULL 3D speed, not the
      // horizontal projection (a horizontal-only capture taxes a descending rail
      // by 1-cos(theta): 9.4% at 25 deg, 23% at 40 deg)
      gs.alongSpeed = speed3;   // magnitude preserved; `dir` already carries the sign
      gs.balance = clamp(KGAIN * vlat, -0.999, 0.999);
      gs._dirSign = sgn;
      ps.constrained = true;
      ps.vel[0] = dir[0] * gs.alongSpeed;
      ps.vel[1] = dir[1] * gs.alongSpeed;
      ps.vel[2] = dir[2] * gs.alongSpeed;
      return gs;
    }

    // ---------------- on rail ----------------
    ps.constrained = true;
    gs.lockFrames++;
    const g = geo.find(q => q.id === gs.railId);
    if (!g) { release(gs, ps, COOL_END, false); return gs; }
    const c = closestOn(g, ps.pos[0], ps.pos[1], ps.pos[2]);
    const sgn = gs._dirSign ?? 1;
    const dir = [c.dir[0] * sgn, c.dir[1] * sgn, c.dir[2] * sgn];
    gs._s = c.s; gs.t = g.total ? c.s / g.total : gs.t;

    // ran off the end of the rail
    const atEnd = sgn > 0 ? c.s >= g.total - 1e-6 : c.s <= 1e-6;
    if (atEnd) { release(gs, ps, COOL_END, false); return gs; }

    // --- along-rail speed: same two-term law as snow, resistance scaled by
    //     dragScale; slope gravity drives it. Closed-form => dt-exact (GR-09).
    const cosT = Math.hypot(dir[0], dir[2]);          // cos(slope)
    const drive = -G * dir[1];                        // +g sin(theta) when descending
    const F0 = DRAG_SCALE * T.MU_BASE * G * cosT;
    const b = DRAG_SCALE * T.LAMBDA_LONG;
    let a = drive - F0;
    let v = gs.alongSpeed;
    if (inp.boost && (ps.boostMeter ?? 0) > 0) {
      // Boost is a thrust; matching the thrust that holds V_BOOST on flat snow,
      // the rail's lower resistance carries it to a much higher terminal speed —
      // clamped by the project-wide V_CAP. "You go faster boosting on a rail."
      const thrust = T.MU_BASE * G + T.LAMBDA_LONG * T.V_BOOST;
      const target = Math.min(T.V_CAP, Math.max(0, (thrust + drive - F0) / b));
      v = v < target ? target + (v - target) * Math.exp(-dt / T.TAU_BOOST)
                     : flow(v, a, b, dt);
    } else {
      v = flow(v, a, b, dt);
    }
    gs.alongSpeed = Math.min(v, T.V_CAP);

    // --- BALANCE: the divergent mode, normalised so |balance| = 1 is the
    //     bounded-input recoverability boundary.  b' = LAM*b + Phi + BETA - LAM*u
    const kappa = curvatureAt(g, c.s) * sgn;
    gs._kappa = kappa;
    const Phi = -KGAIN * gs.alongSpeed * gs.alongSpeed * kappa;   // centrifugal load
    // crouching to charge a pop costs balance authority, exactly as it costs
    // steering authority on snow (CROUCH_STEER); tucking likewise
    const auth = (inp.crouch ? T.CROUCH_STEER : 1) * (inp.tuck ? T.TUCK_STEER : 1);
    const u = clamp(inp.steer ?? 0, -1, 1) * auth;
    gs._stick = u;
    const A = Phi + BETA - LAM * u;
    // exact solution of b' = LAM*b + A over dt (A frozen across the step)
    const eL = Math.exp(LAM * dt);
    gs.balance = (gs.balance + A / LAM) * eL - A / LAM;

    if (Math.abs(gs.balance) > 1) {
      gs.balance = clamp(gs.balance, -2, 2);
      release(gs, ps, COOL_BAIL, true);
      return gs;
    }
    if (gs.alongSpeed < DROP_SPEED) { release(gs, ps, COOL_END, true); return gs; }

    // --- velocity write: along the tangent, with a VELOCITY-ONLY pull back to the
    //     rail line (physics Euler-integrates position, which drifts outward on a
    //     bend). Direction is blended, magnitude stays exactly alongSpeed, so the
    //     correction can neither add nor remove speed and is identically zero on a
    //     straight rail (keeps GR-09 exact).
    const nh = latNormal(dir);
    const off = (ps.pos[0] - c.p[0]) * nh[0] + (ps.pos[2] - c.p[2]) * nh[2];
    gs._lat = off;
    const dy = c.p[1] - ps.pos[1];
    let wx = dir[0] * gs.alongSpeed - nh[0] * LINE_PULL * off;
    let wy = dir[1] * gs.alongSpeed + clamp(LINE_PULL * dy, -2, 2);
    let wz = dir[2] * gs.alongSpeed - nh[2] * LINE_PULL * off;
    const wm = Math.hypot(wx, wy, wz) || 1;
    const k = gs.alongSpeed / wm;
    ps.vel[0] = wx * k; ps.vel[1] = wy * k; ps.vel[2] = wz * k;
    return gs;
  }

  // horizontal left-normal of a direction, in the xz plane about +Y
  function latNormal(d) {
    const h = Math.hypot(d[0], d[2]) || 1;
    return [-d[2] / h, 0, d[0] / h];
  }
  // exact solution of dv/dt = a - b*v (b > 0), clamped at 0 when there is no drive
  function flow(v0, a, b, dt) {
    if (b <= 1e-12) return Math.max(0, v0 + a * dt);
    const veq = a / b, v = veq + (v0 - veq) * Math.exp(-b * dt);
    return a <= 0 ? Math.max(v, 0) : v;
  }

  return { config, init, step };
}
