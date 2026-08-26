// Rails c4B — the grind modelled as an INVERTED PENDULUM about the board's
// contact edge on the rail. Support half-base a = min(rail width, board
// width)/2, CoM height H: the topple angle atan(a/H) IS the bail threshold and
// sqrt(g/H) IS the timescale. A curve spends lean budget as v^2*kappa.
// Writes VELOCITY only, plus ONE lock-on position snap and ps.constrained.
// Physics owns position, heading, rotation, charge. See NOTES.md for which
// constants derive and which are labelled CHOICE.

const G = 9.81;

// ---------------------------------------------------------------- geometry --
const H_COM = 0.90;     // m, CoM height above the board base in a grind stance.
                        // 1.8 m rider, standing CoM 0.55*H = 0.99 m (Winter,
                        // Biomechanics, anthropometric tables); grind stance is
                        // knees-bent, dropping it ~13% -> 0.86 m, plus the
                        // boot+binding+board stack ~0.04 m. CHOICE: the 13%
                        // crouch allowance. Everything below scales with H.
const BOARD_W = 0.26;   // m, freestyle board waist+ width
const BOARD_L = 1.55;   // m, effective edge length (reported only)
const RAIL_W_DEF = 0.20; // m, used when a rail carries no width

// ------------------------------------------------------------ rail surface --
// Rail longitudinal resistance, same a(v) = mu*g*cos(th) + lambda*v shape the
// accepted physics uses on snow (src/physics/physics.mjs: MU_BASE 0.0305,
// LAMBDA_LONG 0.2235), with both terms re-derived for a steel/plastic rail:
//   RAIL_MU: P-tex base on a wet steel box rail. CHOICE, 0.06 — roughly 2x
//     snow's Coulomb term because there is no self-lubricating meltwater film
//     over a full contact patch, but the patch is ~20x smaller.
//   RAIL_LAMBDA: on a rail there is NO snow deformation, so the linear term
//     collapses to AERODYNAMIC drag alone. 0.5*rho*Cd*A/m with rho 1.2,
//     Cd*A 0.3 m^2 (upright rider), m 80 kg -> k = 0.00225 /m, i.e. 0.73 m/s^2
//     at the reference cruise speed. Linearised at V_REF as lambda = k*V_REF.
const RAIL_MU = 0.06;
const V_REF = 18.4;      // m/s, midpoint of the reference bar's cruise band
                         // (58-75 km/h = 16.1-20.8 m/s). NOT a runner default.
const RAIL_LAMBDA = 0.00225 * V_REF;   // 0.0414 /s
const SNOW_MU = 0.0305, SNOW_LAMBDA = 0.2235;   // physics.mjs, for the ratio

// ------------------------------------------------------------- lock-on -----
const CAPTURE_R = 1.0;   // m. CHOICE (see NOTES): half a board length of reach
                         // plus the mid-air lateral shift a rider can produce.
                         // Gate band is 0.5-1.5 ("about one board length").
const MIN_LOCK = 3.0;    // m/s. CHOICE: below this the board catches instead of
                         // sliding; also the anti-phantom floor.
const ALIGN_COS = 0.5;   // 60 deg: past this you are crossing the rail, not
                         // landing along it.
const COOL_BAIL = 0.8;   // s re-lock lockout after a bail
const COOL_POP = 0.5;    // s re-lock lockout after a pop / rail end
const DETACH = 1.6;      // m, 3D distance at which the lock is considered lost
const PULL = 8.0;        // 1/s, corrective VELOCITY toward the rail line (not a
                         // position write) — cancels the outward Euler drift a
                         // purely tangential velocity accumulates on a curve
const PULL_MAX = 2.0;    // m/s cap on that correction
const BAIL_KEEP = 0.75;  // CHOICE: speed kept through a bail

// ---------------------------------------------------- balance / pendulum ----
// b = theta / theta_max, theta_max = atan(a/H). |b| > 1 = the CoM has left the
// support base = topple = bail (contract's |balance| > 1).
//   b'' = LAM2 * ( b + L - u ),  LAM2 = g/H = 10.90 /s^2
// u is the normalised centre-of-pressure offset p/a, |u| <= 1 (the rider can
// put his pressure anywhere inside the base and nowhere outside it).
//   u = K_P*b + K_D*b'      autonomic ankle reflex (always on)
//     + steer*kSteer        the player's conscious correction
// K_P/K_D are the ONE fitted pair in this module; see NOTES.
const LAM2 = G / H_COM;
const K_P = 0.78;        // reflex proportional gain (fraction of base travel)
const K_D = 0.09;        // s, reflex rate gain
const AA = LAM2 * (1 - K_P);   // residual (destabilising) stiffness, 1/s^2
const CC = LAM2 * K_D;         // closed-loop damping, 1/s
const SP = (-CC + Math.sqrt(CC * CC + 4 * AA)) / 2;   // unstable root, >0
const SM = (-CC - Math.sqrt(CC * CC + 4 * AA)) / 2;   // stable root, <0
const STANCE_BIAS = 0.0319;    // CHOICE: constant CoM offset off the rail
                               // centreline = 3.2 mm = 0.20 deg of tilt.
                               // Calibrated so a dead-on, hands-off grind
                               // topples at 2.2 s, mid-band of GR-05's
                               // DECLARED 0.8-6 s window.
const K_GRIP = 7.43;     // CHOICE, the big one: arcade lateral-grip credit on
                         // the rail/board interface. Honest geometry (K = 1)
                         // makes every curve in the bar unridable — see NOTES.
const V_ABSORB = 0.85;   // CHOICE: fraction of arrival lateral velocity the
                         // knees/ankles swallow instead of turning into tilt
const CROUCH_STEER = 0.45;  // physics.mjs CROUCH_STEER — charging a pop on a
const TUCK_STEER = 0.60;    // rail costs the same balance authority it costs
                            // steering on the ground
const B_CLAMP = 2.5;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function createRails(env) {
  const rails = (env && env.rails) ? env.rails.map(prep) : [];

  // Polyline -> 3D segments + an arclength curvature profile. Curvature is
  // carried on NODES AT SEGMENT MIDPOINTS: the turn taken at vertex i is spread
  // over the half-segment on each side of it, so kappa = turn/((L_i+L_{i+1})/2)
  // is EXACTLY 1/R for any polyline inscribed in a constant-radius arc and
  // exactly 0 for a straight one, at any vertex spacing. There is no lookahead
  // distance to tune — the previous lane's "free until R150, ejected at R120"
  // cliff came from a fixed 0.25 m probe body straddling vertices.
  function prep(r) {
    const P = r.points, segs = [];
    let acc = 0;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const L = Math.hypot(dx, dy, dz);
      if (L < 1e-9) continue;
      segs.push({ a, t: [dx / L, dy / L, dz / L], L, s0: acc });
      acc += L;
    }
    const nodes = segs.map(s => s.s0 + s.L * 0.5), kap = [];
    for (let i = 0; i < segs.length - 1; i++) {
      const t0 = segs[i].t, t1 = segs[i + 1].t;
      const cr = t0[0] * t1[2] - t0[2] * t1[0];
      const dp = t0[0] * t1[0] + t0[2] * t1[2];
      kap.push(Math.atan2(cr, dp) / (nodes[i + 1] - nodes[i]));
    }
    const w = Math.min(r.width ?? RAIL_W_DEF, BOARD_W);
    return { id: r.id, segs, total: acc, nodes, kap, halfBase: Math.max(w, 0.04) / 2 };
  }

  function kappaAt(R, s) {
    if (!R.kap.length) return 0;
    if (s <= R.nodes[0]) return R.kap[0];
    if (s >= R.nodes[R.nodes.length - 1]) return R.kap[R.kap.length - 1];
    for (let i = 0; i < R.kap.length; i++)
      if (s < R.nodes[i + 1]) return R.kap[i];
    return R.kap[R.kap.length - 1];
  }

  // Closest point on any rail, in 3D. Horizontal-only search would put a rider
  // under a bridge on the rail above him.
  function closest(x, y, z, only) {
    let best = null;
    for (const R of rails) {
      if (only && R.id !== only) continue;
      for (const sg of R.segs) {
        const ax = sg.a[0], ay = sg.a[1], az = sg.a[2];
        const u = clamp(((x - ax) * sg.t[0] + (y - ay) * sg.t[1] + (z - az) * sg.t[2]), 0, sg.L);
        const px = ax + sg.t[0] * u, py = ay + sg.t[1] * u, pz = az + sg.t[2] * u;
        const d = Math.hypot(x - px, y - py, z - pz);
        if (!best || d < best.d) best = { d, R, p: [px, py, pz], t: sg.t, s: sg.s0 + u };
      }
    }
    return best;
  }

  // Balance axis: the rail tangent rotated +90 deg in the xz plane. b > 0 means
  // the CoM has tipped toward +bAxis. Positive `steer` moves the centre of
  // pressure the same way, which REDUCES a positive b — the contract's sign
  // convention, and also the real ankle strategy (to stop falling left you put
  // your pressure left).
  function bAxis(t) {
    const h = Math.hypot(t[0], t[2]) || 1e-9;
    return [-t[2] / h, 0, t[0] / h];
  }

  // Exact step of b'' + CC b' - AA b = F over dt (F constant across the step).
  function balStep(b, bd, F, dt) {
    const bp = -F / AA, x0 = b - bp;
    const c1 = (bd - SM * x0) / (SP - SM), c2 = x0 - c1;
    const e1 = Math.exp(SP * dt), e2 = Math.exp(SM * dt);
    return [clamp(bp + c1 * e1 + c2 * e2, -B_CLAMP, B_CLAMP),
            clamp(c1 * SP * e1 + c2 * SM * e2, -60, 60)];
  }

  function init() {
    return { onRail: false, railId: null, t: 0, alongSpeed: 0, balance: 0,
      bailed: false, lastLeaveSpeed: 0, lockFrames: 0,
      _bd: 0, _cool: 0, _a: BOARD_W / 2, _kappa: 0, _load: 0, _s: 0 };
  }

  function release(gs, ps, cool) {
    gs.onRail = false; gs.railId = null; gs.lockFrames = 0;
    gs.lastLeaveSpeed = Math.abs(gs.alongSpeed);
    gs._cool = cool; ps.constrained = false;
  }

  function step(gs, ps, input, dt) {
    const inp = input || {};
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);

    if (gs.onRail) {
      // Physics pops us off the rail itself: constrainedStep sees jumpRelease,
      // does the true takeoff (world-up impulse, rotation reset, heading
      // squared to the direction of travel) and clears `constrained` BEFORE we
      // run. Touch nothing here — every m/s of horizontal speed physics kept is
      // speed the exit preserves (GR-04).
      if (!ps.constrained) { gs.bailed = false; release(gs, ps, COOL_POP); return gs; }

      const c = closest(ps.pos[0], ps.pos[1], ps.pos[2], gs.railId);
      if (!c || c.d > DETACH) { gs.bailed = true; release(gs, ps, COOL_BAIL); return gs; }
      gs.lockFrames++;
      gs._s = c.s; gs.t = c.R.total ? c.s / c.R.total : 0;

      // --- rail end: ride off it with the speed you had -------------------
      if (c.s >= c.R.total - 1e-6) { gs.bailed = false; release(gs, ps, COOL_POP); return gs; }

      // --- along-rail speed: closed form, so one 100 ms step == ten 10 ms ---
      // ds/dt = -g*t_y - sgn*mu*g*cos(theta) - lambda*s   (linear in s)
      const sgn = gs.alongSpeed >= 0 ? 1 : -1;
      const cosT = Math.sqrt(Math.max(0, 1 - c.t[1] * c.t[1]));
      const A0 = -G * c.t[1] - sgn * RAIL_MU * G * cosT;
      const veq = A0 / RAIL_LAMBDA;
      gs.alongSpeed = veq + (gs.alongSpeed - veq) * Math.exp(-RAIL_LAMBDA * dt);

      // --- velocity write (the only channel this module drives) -----------
      // tangent flow + a corrective pull toward the rail line. The pull is a
      // VELOCITY, never a position write: physics still integrates.
      let vx = c.t[0] * gs.alongSpeed, vy = c.t[1] * gs.alongSpeed, vz = c.t[2] * gs.alongSpeed;
      let ex = (c.p[0] - ps.pos[0]) * PULL, ey = (c.p[1] - ps.pos[1]) * PULL, ez = (c.p[2] - ps.pos[2]) * PULL;
      const em = Math.hypot(ex, ey, ez);
      if (em > PULL_MAX) { const k = PULL_MAX / em; ex *= k; ey *= k; ez *= k; }
      ps.vel[0] = vx + ex; ps.vel[1] = vy + ey; ps.vel[2] = vz + ez;

      // --- balance ---------------------------------------------------------
      // Curve load: holding radius R at speed v needs lateral accel v^2*kappa,
      // which in the board frame is a pseudo-force pushing the CoM to the
      // OUTSIDE. In pendulum units that is a constant offset of the tilt
      //   L = -kappa * v^2 * H / (a * g * K_GRIP)
      // exactly the same way a tilted floor would be. K_GRIP = 1 is honest
      // geometry and makes every arc in the reference bar unridable; see NOTES.
      const kap = kappaAt(c.R, c.s);
      const v = gs.alongSpeed;
      const load = -kap * v * v * H_COM / (gs._a * G * K_GRIP);
      gs._kappa = kap; gs._load = load;

      const kSteer = (inp.tuck ? TUCK_STEER : 1) * (inp.crouch ? CROUCH_STEER : 1);
      const u = clamp((inp.steer ?? 0), -1, 1) * kSteer;
      const F = LAM2 * (load + STANCE_BIAS - u);
      const [b1, bd1] = balStep(gs.balance, gs._bd, F, dt);
      gs.balance = b1; gs._bd = bd1;

      if (Math.abs(gs.balance) > 1) {           // CoM outside the support base
        gs.balance = clamp(gs.balance, -1.2, 1.2);
        ps.vel[0] *= BAIL_KEEP; ps.vel[1] *= BAIL_KEEP; ps.vel[2] *= BAIL_KEEP;
        gs.alongSpeed *= BAIL_KEEP;
        gs.bailed = true; release(gs, ps, COOL_BAIL);
      }
      return gs;
    }

    // ------------------------------------------------------------ capture --
    if (gs._cool > 0) return gs;
    const sp3 = Math.hypot(ps.vel[0], ps.vel[1], ps.vel[2]);
    if (sp3 < MIN_LOCK) return gs;
    const c = closest(ps.pos[0], ps.pos[1], ps.pos[2], null);
    if (!c || c.d > CAPTURE_R) return gs;

    // Speed converted to along-rail speed in 3D. Projecting the HORIZONTAL
    // speed onto the horizontal tangent instead costs a rider dropping onto a
    // descending rail (1 - cos slope): 9.4% at 25 deg, 23% at 40 deg — a tax
    // levied exactly where a rail is supposed to be the fast line.
    const along = ps.vel[0] * c.t[0] + ps.vel[1] * c.t[1] + ps.vel[2] * c.t[2];
    if (Math.abs(along) < MIN_LOCK) return gs;
    if (Math.abs(along) < ALIGN_COS * sp3) return gs;   // crossing, not landing

    const B = bAxis(c.t);
    const off = (ps.pos[0] - c.p[0]) * B[0] + (ps.pos[2] - c.p[2]) * B[2];
    const vlat = ps.vel[0] * B[0] + ps.vel[1] * B[1] + ps.vel[2] * B[2];

    gs._a = c.R.halfBase;
    // The DOCUMENTED LOCK-ON SNAP — the one position write this module makes.
    ps.pos[0] = c.p[0]; ps.pos[1] = c.p[1]; ps.pos[2] = c.p[2];
    ps.constrained = true;
    gs.onRail = true; gs.railId = c.R.id; gs.bailed = false; gs.lockFrames = 0;
    gs.alongSpeed = along;
    gs._s = c.s; gs.t = c.R.total ? c.s / c.R.total : 0;
    // Seed: the board is snapped to the rail, the rider's mass is not. The
    // residual tilt scales with how far off the line the capture was, reaching
    // the topple threshold at the edge of the capture radius (CHOICE — the
    // capture radius is itself arcade forgiveness, so the tilt it implies is
    // too). Arrival lateral velocity becomes tilt RATE, mostly absorbed by the
    // knees; b' = v_lat/a is the exact kinematic conversion before absorption.
    gs.balance = clamp(off / CAPTURE_R, -1, 1);
    gs._bd = clamp((1 - V_ABSORB) * vlat / gs._a, -8, 8);
    gs._kappa = kappaAt(c.R, c.s); gs._load = 0;
    return gs;
  }

  const thetaMax = Math.atan((RAIL_W_DEF / 2) / H_COM);
  const config = {
    // contract-required
    captureRadius_m: CAPTURE_R,
    dragScale: +(((RAIL_MU * G + RAIL_LAMBDA * V_REF) /
                  (SNOW_MU * G + SNOW_LAMBDA * V_REF))).toFixed(4),
    balanceHalfLife_s: +(Math.LN2 / SP).toFixed(4),   // divergence half-life
    curveTolerance_rad: +thetaMax.toFixed(4),         // the lean budget a curve spends
    minLockSpeed_mps: MIN_LOCK,
    // the pendulum, exposed
    comHeight_m: H_COM, boardWidth_m: BOARD_W, boardLength_m: BOARD_L,
    railHalfBase_m: RAIL_W_DEF / 2, toppleAngle_deg: +(thetaMax * 180 / Math.PI).toFixed(3),
    pendulumRate_hz: +Math.sqrt(LAM2).toFixed(4),
    reflexKp: K_P, reflexKd_s: K_D, unstableRoot_hz: +SP.toFixed(4),
    stanceBias: STANCE_BIAS, gripCredit: K_GRIP, vAbsorb: V_ABSORB,
    // max holdable curvature at the reference cruise speed (|load| == 1)
    kappaMax_perM: +((RAIL_W_DEF / 2) * G * K_GRIP / (V_REF * V_REF * H_COM)).toFixed(5),
    railMu: RAIL_MU, railLambda_hz: +RAIL_LAMBDA.toFixed(4),
    snowMu: SNOW_MU, snowLambda_hz: SNOW_LAMBDA, refSpeed_mps: V_REF,
    bailSpeedKeep: BAIL_KEEP, crouchSteer: CROUCH_STEER, alignCos: ALIGN_COS,
  };

  return { config, init, step };
}
