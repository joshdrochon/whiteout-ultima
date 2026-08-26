// Candidate A — rail grinding: spline projection + capture-point balance
// =============================================================================
//
// WHAT THIS MODULE DOES
//   Each frame, while locked, the board is projected onto the rail polyline
//   (closest point + tangent + signed curvature). Along-rail speed is its own
//   state, integrated in CLOSED FORM (dt-exact) from a two-term drag law with a
//   gravity drive. Balance is a separate scalar state: the linear
//   inverted-pendulum "divergent component of motion" (DCM / capture point),
//   which is UNSTABLE, driven by rail curvature and corrected by steer.
//   The rider is held on the rail by a VELOCITY-LEVEL constraint only.
//
// WHAT IT NEVER DOES (GR-07 / contract)
//   * never writes ps.heading — not once, anywhere;
//   * writes ps.pos exactly once per lock, on the lock-on snap frame, by at
//     most captureRadius_m (the snap IS the projection to the closest point);
//   * never writes trick state (spinDeg / flipDeg / prewound / landing /
//     airTime / _popDone / charge). It also never props open physics' coyote
//     branch, because it never touches airTime or _popDone at all (GR-10).
//   Every other frame the ONLY fields it writes on the physics state are
//   ps.vel[0..2]. Position follows because physics integrates that velocity.
//
// WHY THE GRIND IS AIRBORNE (from physics' point of view)
//   The lock-on snap puts the board on the rail line, which is above the
//   terrain. The accepted physics core then releases its ground constraint on
//   the next tick (predictive unilateral release) and runs airStep. That is
//   correct and wanted: a grind is not a snow contact. It also means air
//   rotation accumulates during the grind, which is exactly the sourced "keep
//   on pressing that to do rail spins" behaviour (GR-10). Holding the board on
//   the rail against gravity is then a pure velocity-level constraint:
//
//       v_desired = tangent * alongSpeed + (closestPoint - pos) / dt
//
//   the second term being Baumgarte position stabilisation of a bilateral
//   constraint at beta = 1 (Baumgarte 1972, the standard constraint-drift
//   correction; deadbeat because a rail is a HARD constraint, not a spring).
//   Its steady state leaves the board g*dt^2 (1.8 mm at 60 Hz) under the line —
//   a bounded offset, not an accumulating sag.
//
// =============================================================================
// CONSTANTS: DERIVATION OR CITATION FOR EVERY NUMBER
// -----------------------------------------------------------------------------
// Sources referenced below:
//   [R15]  references/research/02-turning-edge-friction.md sec 1.5
//   [R16]  references/research/02-turning-edge-friction.md sec 1.6 (speeds)
//   [R3]   references/research/02-turning-edge-friction.md sec 1.4/3 (Tux Racer
//          friction ladder: ice 0.20 / snow 0.35 / dirty snow 0.40)
//   [PHYS] src/physics/physics.mjs DEFAULTS — the ACCEPTED physics core of this
//          project (read-only; not imported, to keep this module dependency
//          free, but quoted verbatim so "rail vs snow" is a real comparison)
//   [LIP]  Linear inverted pendulum / capture point: Pratt et al. 2006
//          "Capture Point"; Hof 2008 "extrapolated centre of mass"; Koolen et
//          al. 2012 "Capturability-based analysis". The unstable eigenvalue of
//          a LIP of height L is exactly sqrt(g/L), and the divergent component
//          xi = x + xdot/omega obeys xidot = omega*(xi - u).
//   [ANTH] Winter, "Biomechanics and Motor Control of Human Movement":
//          whole-body CoM at ~0.55 of stature standing.
//
// Anything that is taste is labelled CHOICE with its cost. There is no
// "derived" block of hand-picked numbers here: every value below is either
// computed from the ones above it or carries a citation.
// =============================================================================

const G0 = 9.81;                   // m/s^2 — project convention
const RIDER_H = 1.80;              // m — CONTRACTS.md conventions (rider 1.8 m)

// --- CoM height above the rail -----------------------------------------------
// [ANTH] standing whole-body CoM = 0.55*h = 0.99 m. A grind is ridden crouched,
// which lowers it. CHOICE: 0.50*h = 0.90 m (a 9% crouch).
// Cost of the choice is small and bounded: omega = sqrt(g/L) moves only +-5%
// across the whole plausible band 0.45..0.55*h, and every timing below scales
// as 1/omega, so the model is insensitive to it. A LOWER CoM (deeper crouch)
// makes balance slower and rails easier; a higher one makes them twitchier.
const COM_H = 0.50 * RIDER_H;                       // 0.900 m

// --- board length ------------------------------------------------------------
// Standard freestyle sizing rule: board length ~ rider chin height ~ 0.83*h.
const BOARD_L = 0.83 * RIDER_H;                     // 1.494 m

// --- balance instability rate ------------------------------------------------
// [LIP] the unstable eigenvalue of a linear inverted pendulum of height L.
// This is the ONE number that sets every balance timescale in the module.
const OMEGA_B = Math.sqrt(G0 / COM_H);              // 3.3015 1/s

// --- bail threshold ----------------------------------------------------------
// The rider recovers a lean by swinging the board back under the CoM, rotating
// it about the rail. Its lateral reach doing so is half its length; past that
// excursion nothing can be brought under the CoM and the grind is lost.
// So the capture-point bail radius is half a board length.
const XI_MAX = 0.5 * BOARD_L;                       // 0.747 m
const PHI_BAIL = Math.atan(XI_MAX / COM_H);         // 0.6929 rad = 39.7 deg
// balance state is xi / XI_MAX, so |balance| > 1 is a bail (contract).

// --- capture radius ----------------------------------------------------------
// [R15] "[EST] capture radius ~0.5-1.0 board-length (0.5-1.5 m)". The band is
// itself an estimate, so CHOICE: its midpoint, 1.0 m (= 0.67 board lengths),
// which is also the value furthest from both edges of gate GR-02's band.
// Cost: smaller reads as "the rail rejected me" on near misses; larger snaps
// you onto rails you meant to jump past.
const CAPTURE_R = 1.0;                              // m

// --- minimum speed to lock on ------------------------------------------------
// A grind that ends before the board has passed its own length along the rail
// is not a grind, and the rider only has one balance e-folding time (1/OMEGA_B)
// of grace before the lean has to be actively fought. So require the board to
// cover at least its own length within one e-folding time.
// CHOICE is the rule ("one board length per e-folding"); the number follows.
// Cost: higher and slow technical rail sections become unusable; lower and you
// "grind" at walking pace, which reads as a bug.
const MIN_LOCK_SPEED = BOARD_L * OMEGA_B;           // 4.93 m/s = 17.8 km/h

// --- sustain floor (hysteresis) ----------------------------------------------
// Capture and release must not share a threshold or the lock chatters at the
// boundary (Schmitt trigger; standard practice). CHOICE: release at half the
// capture speed. Cost: a wide gap lets you crawl to a near-stop still locked;
// a narrow one chatters.
const SUSTAIN_FRAC = 0.5;
const MIN_HOLD_SPEED = SUSTAIN_FRAC * MIN_LOCK_SPEED;   // 2.47 m/s

// --- approach alignment cone -------------------------------------------------
// A board crossing a rail nearly broadside is not landing on it. CHOICE: 60 deg
// half-cone, taken on |cos| so riding the rail switch/backwards locks the same.
// Cost: tighter and you cannot drop into a boardslide off a steep approach;
// looser and rails you are merely crossing grab you.
const ALIGN_COS = Math.cos(60 * Math.PI / 180);     // 0.5

// --- stance bias: the symmetry breaker ---------------------------------------
// An inverted pendulum sitting exactly at its unstable equilibrium never falls.
// A real rider is never exactly there: the CoM sits slightly off the rail's
// contact line (stance asymmetry, regular vs goofy) so there is a constant lean
// torque to fight. [R15] "turn sideways to balance easier" is precisely this —
// the default stance has a persistent bias that active balance must cancel.
// Research gives NO magnitude, and the gate's own statement says its 0.8-6 s
// window is a DECLARED DESIGN CHOICE and not a citation. So this is a CHOICE
// inherited from that window: target the log-centre sqrt(0.8*6) = 2.19 s, the
// point furthest (in ratio) from both edges.
//   passive: bdot = OMEGA_B*(b + BIAS)  =>  b(t) = BIAS*(e^(OMEGA_B t) - 1)
//   b = 1 at t = ln(1 + 1/BIAS)/OMEGA_B  =>  invert for BIAS.
// Cost: shorter and rails feel like a punishment; longer and balance is
// decoration you never notice. The SIGN is arbitrary (+ = toe-side lean here).
const PASSIVE_BAIL_TARGET_S = Math.sqrt(0.8 * 6.0);            // 2.1909 s
const BIAS_NORM = 1 / (Math.exp(OMEGA_B * PASSIVE_BAIL_TARGET_S) - 1);  // 7.25e-4
const BIAS_SIGN = 1;

// --- steer authority ---------------------------------------------------------
// Steering while grinding shifts the support back under the CoM: in DCM terms
// it moves u, and bdot picks up -STEER_GAIN*steer (positive steer REDUCES
// positive balance — the contract's sign convention, and also the physical one:
// you steer TOWARD the fall to get back under it, and positive steer in the
// accepted physics core yaws the board toward the rail's LEFT, which is the
// direction positive balance leans).
// Magnitude is set by a DESIGN REQUIREMENT that comes straight out of [R15]:
// "curved rails require steering input while grinding; failing to turn drops
// you off" — i.e. a curved rail must be HOLDABLE with steering, not a death
// sentence. Pick the hardest rail the game asks you to hold, and make it hold
// at exactly full stick:
//     bdot_curve(R,v) = v^2 / (R * OMEGA_B * XI_MAX)      (centrifugal forcing
//                                                          of the LIP, below)
//     STEER_GAIN := bdot_curve(REF_RADIUS, REF_SPEED)
// REF_SPEED 18 m/s is the top of [R16]'s "base cruise, no tuck" band (14-18).
// REF_RADIUS 40 m is the tighter of the two arcs the gate law uses, and is
// about the tightest bend an SSX rail takes.
// CHOICE is only WHICH rail is declared the hardest holdable one. Cost: a
// smaller REF_RADIUS makes the stick feel over-powered and balance trivial; a
// larger one makes every curved rail unholdable, contradicting [R15].
const REF_SPEED = 18;                               // m/s   [R16]
const REF_RADIUS = 40;                              // m     tightest held arc
const STEER_GAIN = (REF_SPEED * REF_SPEED) / (REF_RADIUS * OMEGA_B * XI_MAX);
                                                    // 3.284 1/s

// --- topple speed and relock cooldown ---------------------------------------
// At the instant of a bail the CoM is diverging at xidot = OMEGA_B * XI_MAX.
// That is the lateral velocity the rider actually leaves with, and the time for
// it to carry the board clear of the capture radius is the relock cooldown.
// Both are consequences of numbers already fixed; nothing new is chosen.
// The cooldown applies after EVERY exit, not just bails: the far end of a rail
// is still inside its own capture radius, so without it a rider running off the
// end re-acquires the endpoint on the very next frame and then leaves again,
// strobing the lock (measured: 47 lock-on snaps in one 6 s pass over a 60 m
// rail). It is scoped to the rail just left, so rail-to-rail transfers — an SSX
// staple — are unaffected.
const TOPPLE_SPEED = OMEGA_B * XI_MAX;              // 2.466 m/s
const RELOCK_COOLDOWN_S = CAPTURE_R / TOPPLE_SPEED; // 0.405 s

// --- rail drag ---------------------------------------------------------------
// [R15] verbatim: "You go faster boosting on a rail than boosting on the snow."
// So rail resistance < snow resistance. Research gives no rail coefficient, but
// it does give a friction LADDER for low-friction surfaces [R3]: Tux Racer
// ice 0.20 vs snow 0.35. A waxed base on a steel rail is at least as slick as
// ice, so the ice:snow ratio is the CONSERVATIVE sourced choice for dragScale.
// It multiplies BOTH terms of the accepted snow law, so the shape is unchanged
// and only the rate differs.
const DRAG_SCALE = 0.20 / 0.35;                     // 0.5714  [R3]
// Snow reference law, quoted from [PHYS] DEFAULTS (MU_BASE, LAMBDA_LONG):
//     a(v) = -(MU*g*cos(theta) + LAMBDA*v)      (+ gravity along the tangent)
const SNOW_MU = 0.0305;                             // [PHYS] MU_BASE
const SNOW_LAMBDA = 0.2235;                         // [PHYS] LAMBDA_LONG
const RAIL_MU = SNOW_MU * DRAG_SCALE;               // 0.01743
const RAIL_LAMBDA = SNOW_LAMBDA * DRAG_SCALE;       // 0.12771 1/s

// --- rail ollie (jump off) ---------------------------------------------------
// Leaving a rail is an ollie, so it uses the accepted core's own jump impulse
// ladder rather than a new number: tap = J_MIN, full charge = J_MAX [PHYS].
// It is VERTICAL ONLY, so along-rail speed is carried out untouched (GR-04).
const POP_MIN = 2.1;                                // [PHYS] J_MIN
const POP_MAX = 5.0;                                // [PHYS] J_MAX

// --- reported balance timescale ---------------------------------------------
// The contract asks for balanceHalfLife_s. In an inverted-pendulum model the
// characteristic time is a DOUBLING time, not a decay half-life: same
// magnitude, opposite meaning. Reported under the contract's name, with the
// unambiguous aliases alongside it in config.
const BALANCE_TIME_S = Math.LN2 / OMEGA_B;          // 0.2100 s

// =============================================================================
// small helpers (pure)
// =============================================================================
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Exact solution of dv/dt = A - B*v over dt, for v >= 0.
// Linear ODE => the closed form composes exactly, so one 100 ms step equals
// ten 10 ms steps to floating point (GR-09). When A <= 0 the flow is monotone
// decreasing and the Coulomb clamp at 0 is still split-step exact.
function flow(v0, A, B, dt) {
  if (B <= 1e-12) {
    const v = v0 + A * dt;
    return A <= 0 ? Math.max(v, 0) : v;
  }
  const veq = A / B;
  const v = veq + (v0 - veq) * Math.exp(-B * dt);
  return A <= 0 ? Math.max(v, 0) : v;
}

// =============================================================================
// rail geometry: polyline -> segments, arc length, signed curvature
// =============================================================================

// Signed curvature is measured about the WORLD-UP axis (that is the axis the
// centrifugal lean acts around), positive when the rail turns toward the
// travel-frame LEFT. On a constant-radius arc this returns exactly 1/R on every
// segment including the two end ones, so the gate's constant-curvature probe
// measures curvature and not an arrival transient.
function buildRail(r) {
  const P = r?.points;
  if (!Array.isArray(P) || P.length < 2) return null;
  const segs = [];
  let L = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1];
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-9) continue;
    segs.push({
      a: [a[0], a[1], a[2]],
      dir: [dx / len, dy / len, dz / len],
      len, s0: L, kappa: 0,
    });
    L += len;
  }
  if (!segs.length) return null;

  // horizontal tangent of each segment (curvature about world up)
  const th = segs.map(s => {
    const m = Math.hypot(s.dir[0], s.dir[2]);
    return m > 1e-9 ? [s.dir[0] / m, s.dir[2] / m] : [0, 0];
  });
  // curvature at each interior joint j (between segment j and j+1):
  //   kappa = (signed turn angle) / (mean of the two segment lengths)
  const joint = new Array(Math.max(0, segs.length - 1)).fill(0);
  for (let j = 0; j + 1 < segs.length; j++) {
    const t0 = th[j], t1 = th[j + 1];
    // left normal of t0 in the xz-plane: rotate +90 deg about +Y => (x,z)->(-z,x)
    const nx = -t0[1], nz = t0[0];
    const along = t1[0] * t0[0] + t1[1] * t0[1];
    const side = t1[0] * nx + t1[1] * nz;
    const dTheta = Math.atan2(side, along);            // + = turns left
    const meanLen = 0.5 * (segs[j].len + segs[j + 1].len);
    joint[j] = meanLen > 1e-9 ? dTheta / meanLen : 0;
  }
  // per-segment curvature: mean of the joints it touches, clamped at the ends
  for (let i = 0; i < segs.length; i++) {
    const lo = i - 1 >= 0 ? joint[i - 1] : (joint.length ? joint[0] : 0);
    const hi = i < joint.length ? joint[i] : (joint.length ? joint[joint.length - 1] : 0);
    segs[i].kappa = 0.5 * (lo + hi);
  }
  return { id: r.id, width: Number(r.width) > 0 ? Number(r.width) : 0.2, segs, length: L };
}

// Closest point on one rail polyline to p. Returns the projection, the unit
// tangent there, the signed curvature, the arc length s, and the distance.
function projectOnRail(rail, p) {
  let best = null;
  for (let i = 0; i < rail.segs.length; i++) {
    const sg = rail.segs[i];
    const wx = p[0] - sg.a[0], wy = p[1] - sg.a[1], wz = p[2] - sg.a[2];
    const u = clamp(wx * sg.dir[0] + wy * sg.dir[1] + wz * sg.dir[2], 0, sg.len);
    const cx = sg.a[0] + sg.dir[0] * u,
          cy = sg.a[1] + sg.dir[1] * u,
          cz = sg.a[2] + sg.dir[2] * u;
    const d = Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz);
    if (!best || d < best.d) {
      best = { d, point: [cx, cy, cz], tangent: sg.dir, kappa: sg.kappa, s: sg.s0 + u };
    }
  }
  if (best) { best.rail = rail; best.length = rail.length; }
  return best;
}

function projectOnAll(rails, p) {
  let best = null;
  for (const rl of rails) {
    const pr = projectOnRail(rl, p);
    if (pr && (!best || pr.d < best.d)) best = pr;
  }
  return best;
}

// =============================================================================
// module
// =============================================================================
export function createRails(env = {}) {
  const rails = (env.rails ?? []).map(buildRail).filter(Boolean);
  const byId = new Map(rails.map(r => [r.id, r]));

  const config = {
    // --- contract-required ---
    captureRadius_m: CAPTURE_R,
    dragScale: DRAG_SCALE,              // < 1: rails are faster than snow [R15]
    balanceHalfLife_s: BALANCE_TIME_S,  // see note: this is a DOUBLING time
    curveTolerance_rad: PHI_BAIL,       // lean angle at which the grind is lost
    minLockSpeed_mps: MIN_LOCK_SPEED,
    // --- the physical inputs the above are derived from ---
    riderHeight_m: RIDER_H,
    comHeight_m: COM_H,
    boardLength_m: BOARD_L,
    balanceRate_s: OMEGA_B,             // sqrt(g/L), the unstable eigenvalue
    balanceDoublingTime_s: BALANCE_TIME_S,
    bailExcursion_m: XI_MAX,
    stanceBias_norm: BIAS_NORM,
    passiveBailTarget_s: PASSIVE_BAIL_TARGET_S,
    steerGain_s: STEER_GAIN,
    // --- derived operating limits (reportable, not tuned) ---
    // The tightest radius holdable at full stick, at REF_SPEED:
    holdableRadius_m: REF_SPEED * REF_SPEED / (STEER_GAIN * OMEGA_B * XI_MAX),
    maxHoldableCurvature_1pm: STEER_GAIN * OMEGA_B * XI_MAX / (REF_SPEED * REF_SPEED),
    maxHoldableTurnRate_radps: STEER_GAIN * OMEGA_B * XI_MAX / REF_SPEED,
    // --- speeds / drag ---
    minHoldSpeed_mps: MIN_HOLD_SPEED,
    alignCosMin: ALIGN_COS,
    railMu: RAIL_MU,
    railLambda_s: RAIL_LAMBDA,
    snowMu: SNOW_MU,
    snowLambda_s: SNOW_LAMBDA,
    // --- exit / bail ---
    popMin_mps: POP_MIN,
    popMax_mps: POP_MAX,
    toppleSpeed_mps: TOPPLE_SPEED,
    relockCooldown_s: RELOCK_COOLDOWN_S,
    railCount: rails.length,
  };

  function init() {
    return {
      onRail: false,
      railId: null,
      t: 0,               // 0..1 along the rail
      alongSpeed: 0,      // signed, + = along the polyline's own direction
      balance: 0,         // capture point / XI_MAX; |balance| > 1 = bail
      bailed: false,
      lastLeaveSpeed: 0,
      lockFrames: 0,      // frames in the CURRENT grind (0 while off rail)
      // observability (underscored: not part of the contract surface)
      _kappa: 0,          // signed curvature under the board, 1/m
      _distToRail: Infinity,
      _cool: 0,           // relock lockout on _coolRail, s
      _coolRail: null,    // the rail just left (only that one is locked out)
      _exit: null,        // 'jump' | 'bail' | 'end' | 'slow' | null
      _snaps: 0,          // number of lock-on snaps performed
    };
  }

  // travel-frame left normal (horizontal), for a tangent already multiplied by
  // the travel sign. Rotate (x,z) by +90 deg about +Y: (x,z) -> (-z,x).
  function leftNormal(tang) {
    const m = Math.hypot(tang[0], tang[2]);
    if (m < 1e-9) return [0, 0, 0];
    return [-tang[2] / m, 0, tang[0] / m];
  }

  // Release the rail. VELOCITY ONLY — never pos, never heading, never trick
  // state. Along-rail speed is carried out intact (GR-04); a jump adds a purely
  // vertical ollie so the horizontal speed it leaves with is exactly the speed
  // it had; a bail adds the lateral topple velocity the CoM already had.
  function release(gs, ps, tangTravel, why, popCharge) {
    const leftRail = gs.railId;
    const sp = Math.abs(gs.alongSpeed);
    ps.vel[0] = tangTravel[0] * sp;
    ps.vel[1] = tangTravel[1] * sp;
    ps.vel[2] = tangTravel[2] * sp;
    if (why === 'jump') {
      ps.vel[1] += POP_MIN + clamp(popCharge ?? 0, 0, 1) * (POP_MAX - POP_MIN);
    } else if (why === 'bail') {
      const n = leftNormal(tangTravel);
      const s = gs.balance >= 0 ? 1 : -1;      // topples the way it was leaning
      ps.vel[0] += n[0] * TOPPLE_SPEED * s;
      ps.vel[2] += n[2] * TOPPLE_SPEED * s;
    }
    gs.onRail = false;
    gs.railId = null;
    gs.lastLeaveSpeed = sp;
    gs.bailed = why === 'bail';
    gs.balance = clamp(gs.balance, -1, 1);
    gs.lockFrames = 0;
    gs._exit = why;
    // lock out ONLY the rail just left, for the time it takes the board to
    // clear that rail's capture radius (see RELOCK_COOLDOWN_S).
    gs._cool = RELOCK_COOLDOWN_S;
    gs._coolRail = leftRail;
  }

  function tryCapture(gs, ps, dt) {
    if (!rails.length) return;
    // the rail just left is locked out until the board has cleared it; every
    // OTHER rail stays available, so rail-to-rail transfers still work.
    const avail = gs._cool > 0 ? rails.filter(r => r.id !== gs._coolRail) : rails;
    if (!avail.length) return;
    const v = ps.vel;
    const sp3 = Math.hypot(v[0], v[1], v[2]);
    gs._distToRail = Infinity;
    // GR-08: below the lock speed there is no grind, at any distance.
    if (sp3 < MIN_LOCK_SPEED) return;
    const pr = projectOnAll(avail, ps.pos);
    if (!pr) return;
    gs._distToRail = pr.d;
    // GR-01 / GR-08: automatic, no button — but only inside the capture radius.
    if (pr.d > CAPTURE_R) return;
    // the board must be travelling roughly along the rail (either way round)
    const along = v[0] * pr.tangent[0] + v[1] * pr.tangent[1] + v[2] * pr.tangent[2];
    if (Math.abs(along) < ALIGN_COS * sp3) return;

    // --- lock on -------------------------------------------------------------
    const sgn = along >= 0 ? 1 : -1;
    const tangTravel = [pr.tangent[0] * sgn, pr.tangent[1] * sgn, pr.tangent[2] * sgn];
    const n = leftNormal(tangTravel);
    // The rail absorbs the lateral part of the approach and turns it into LEAN:
    // the capture point is xi = lateral offset + lateral velocity / omega [LIP].
    const latOff = (ps.pos[0] - pr.point[0]) * n[0] + (ps.pos[2] - pr.point[2]) * n[2];
    const latVel = v[0] * n[0] + v[2] * n[2];
    const b0 = clamp((latOff + latVel / OMEGA_B) / XI_MAX, -1, 1);

    // THE ONE LEGAL POSITION WRITE: the documented lock-on snap, magnitude
    // pr.d <= captureRadius_m, once per lock.
    ps.pos[0] = pr.point[0];
    ps.pos[1] = pr.point[1];
    ps.pos[2] = pr.point[2];
    // velocity becomes pure along-rail travel (the lateral part became lean)
    ps.vel[0] = tangTravel[0] * Math.abs(along);
    ps.vel[1] = tangTravel[1] * Math.abs(along);
    ps.vel[2] = tangTravel[2] * Math.abs(along);

    gs.onRail = true;
    gs.railId = pr.rail.id;
    gs.alongSpeed = along;
    gs.balance = b0;
    gs.bailed = false;
    gs.lockFrames = 1;
    gs.t = pr.length > 1e-9 ? clamp(pr.s / pr.length, 0, 1) : 0;
    gs._kappa = pr.kappa;
    gs._exit = null;
    gs._snaps++;
  }

  function onRailStep(gs, ps, inp, dt) {
    const rail = byId.get(gs.railId);
    if (!rail) { release(gs, ps, [0, 0, 0], 'end'); return; }
    const pr = projectOnRail(rail, ps.pos);
    if (!pr) { release(gs, ps, [0, 0, 0], 'end'); return; }
    gs._distToRail = pr.d;

    const sgn = gs.alongSpeed >= 0 ? 1 : -1;
    const tangT = [pr.tangent[0] * sgn, pr.tangent[1] * sgn, pr.tangent[2] * sgn];
    // curvature expressed in the travel frame (both the tangent and the left
    // normal flip when riding the polyline backwards, so the sign flips too)
    const kappaT = pr.kappa * sgn;
    gs._kappa = kappaT;

    // --- along-rail speed: closed-form two-term drag + gravity drive ---------
    // dv/dt = -g*t_y  -  (MU_rail*g*cos(theta) + LAMBDA_rail*v)
    // A and B are constant across the step (tangent taken at the step's start),
    // so the closed form is exact and split-step exact (GR-09).
    const ty = clamp(tangT[1], -1, 1);
    const cosT = Math.sqrt(Math.max(0, 1 - ty * ty));
    const A = -G0 * ty - RAIL_MU * G0 * cosT;
    const B = RAIL_LAMBDA;
    const sp = flow(Math.abs(gs.alongSpeed), A, B, dt);
    gs.alongSpeed = sgn * sp;

    // --- balance: unstable capture-point state ------------------------------
    //   bdot = OMEGA_B*b  +  OMEGA_B*BIAS  -  v^2*kappa/(OMEGA_B*XI_MAX)
    //          -  STEER_GAIN*steer
    // First term: the LIP's divergent mode [LIP]. Second: the stance bias that
    // makes doing nothing lose (see BIAS_NORM). Third: centrifugal forcing —
    // a LIP under lateral acceleration a picks up a/OMEGA_B in xi, and on a
    // rail of signed curvature kappa that acceleration is v^2*kappa toward the
    // travel-frame left, so the rider is thrown the other way. Fourth: the
    // player's correction, with the contract's sign (positive steer REDUCES
    // positive balance).
    // Integrated in closed form for constant drive D:
    //   b(t+dt) = (b + D/OMEGA_B)*exp(OMEGA_B*dt) - D/OMEGA_B
    const steer = clamp(inp.steer ?? 0, -1, 1);
    const D = OMEGA_B * BIAS_NORM * BIAS_SIGN
            - (sp * sp) * kappaT / (OMEGA_B * XI_MAX)
            - STEER_GAIN * steer;
    const k = D / OMEGA_B;
    const bNext = (gs.balance + k) * Math.exp(OMEGA_B * dt) - k;

    // --- exits, in priority order -------------------------------------------
    // 1. the player jumps off: speed and prewind are carried out (GR-04).
    //    prewind survives because this module never touches prewound/_prewind;
    //    the ollie is vertical only, so horizontal speed is untouched.
    if (inp.jumpRelease) {
      gs.balance = clamp(bNext, -1, 1);
      release(gs, ps, tangT, 'jump', ps.charge);
      return;
    }
    // 2. balance lost
    if (!(Math.abs(bNext) <= 1)) {
      gs.balance = bNext;
      release(gs, ps, tangT, 'bail');
      return;
    }
    // 3. ran out of rail (predictive: would leave the polyline this step)
    const sNext = pr.s + gs.alongSpeed * dt;
    if (sNext > pr.length || sNext < 0) {
      gs.balance = bNext;
      release(gs, ps, tangT, 'end');
      return;
    }
    // 4. too slow to still be sliding (hysteresis against MIN_LOCK_SPEED)
    if (sp < MIN_HOLD_SPEED) {
      gs.balance = bNext;
      release(gs, ps, tangT, 'slow');
      return;
    }

    // --- still grinding: velocity-level rail constraint ----------------------
    // v = tangent*alongSpeed + Baumgarte drift correction toward the closest
    // point. VELOCITY ONLY: position is left entirely to physics (GR-07).
    // The correction is capped at one capture radius per step so a large dt or
    // a bad frame can never fling the rider.
    const capC = CAPTURE_R / dt;
    let cx = (pr.point[0] - ps.pos[0]) / dt;
    let cy = (pr.point[1] - ps.pos[1]) / dt;
    let cz = (pr.point[2] - ps.pos[2]) / dt;
    const cm = Math.hypot(cx, cy, cz);
    if (cm > capC) { const s = capC / cm; cx *= s; cy *= s; cz *= s; }
    ps.vel[0] = tangT[0] * sp + cx;
    ps.vel[1] = tangT[1] * sp + cy;
    ps.vel[2] = tangT[2] * sp + cz;

    gs.balance = bNext;
    gs.t = pr.length > 1e-9 ? clamp(pr.s / pr.length, 0, 1) : 0;
    gs.lockFrames++;
    gs._exit = null;
  }

  function step(gstate, physState, input, dt) {
    const gs = gstate;
    const ps = physState;
    if (!gs || !ps || !(dt > 0)) return gs;
    const inp = input || {};
    if (gs._cool > 0) gs._cool = Math.max(0, gs._cool - dt);
    if (gs.onRail) onRailStep(gs, ps, inp, dt);
    else tryCapture(gs, ps, dt);
    return gs;
  }

  return { config, init, step };
}

export default createRails;
