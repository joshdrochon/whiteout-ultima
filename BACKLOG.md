# Backlog

## Done
- **Six component lanes + integration** closed by blind gauntlet (render-loop,
  physics-core, turning-friction, jump-arcs, camera-follow, snow-shaders)
- **Trick system** — real Tricky uber table, combos, ×0.5 repeats, stars, TRICKY,
  boost economy; live in the game loop (keys 1-6 fire ubers)
- **HUD** — score + star multiplier, speed, boost ladder, TRICKY tiles, award slabs
- **Regression suite** — `npm test`, 17 tests / ~40 s, all 95 gates across every lane;
  each runner negative-controlled (mutate source → the exact gate fails → restore → green)
- **Wall-seam artifact** — resolved via user P-key poses: backface lift scoped to
  near-camera + flanged tiles (skirts removed). Verified at the user's exact views.
- **Playable build** — keyboard input, build-hash badge, P-key pose capture

## Next up (proposed order)
1. **Run structure** — start gate, finish line, run timer, results screen (score / time /
   best trick / TRICKY status), restart. Turns the demo into a game loop; everything
   below hangs off it. Pure code → gauntlet-friendly, gates are objective.
2. **Rails & grinds** — a core SSX verb entirely missing (lock-on, balance, score-per-
   second, jump-off preserving speed + prewind). Research corpus already covers it.
3. **Rider asset + animation lane** — replace the capsule proxy. Hybrid: imported rigged
   mesh (CC0 / Mixamo) + gauntlet-built animation controller mapping physics state → pose
   (lean / tuck / air / spin / landing / crash).
4. **Sound** — Sonniss GDC bundles + one snow-sports library (user sourcing); engine layer:
   carve loop, spray, takeoff/landing, trick stingers, boost, music duck.
5. **Environment dressing** — cone trees → instanced real props, rocks, course furniture.

## Run lane — residual FIXED 2026-08-26 (kept below for the record)
`bounds.zBackstop` (-80 m) is now the up-course correction line, distinct from the
start gate. RS-12 was written FIRST, reproduced the defect independently at 8.846%,
and now reads 0.006% — identical time (266.42 vs 266.40 s) and identical score
(2099 vs 2099). Mutation-verified: pinning the line back to zStart fails RS-12.

## (historical) Run lane — accepted with one disclosed residual
The promoted module corrects a rider who flies UP-COURSE past zStart mid-run
(measured: 17.34 m back at t=12.3 s after a backwards jump). That correction is
contract-required but it CHANGES THE RUN IT TIMES: 261.5 s / 2284.5 pts with the
module vs 266.4 s / 2099.1 without — 4.9 s faster and +8.8% score, in the
direction that flatters the module. Root cause is MY env definition: `zStart` is a
start GATE, and drifting back over it mid-run is normal play, not out of bounds.
FIX (harness owner, not the module): add `bounds.zBackstop` (e.g. zStart - 80) as
the up-course correction line, distinct from zStart, then re-verify. Until then
the module is honest about it (`derivation.changesTheRun`, selftest section 6).

Also open, deliberately not taken by the candidate: its selftest drives (wall
probe, dt sweep, staged starts) are still self-reported. Folding them into
run-runner would have a candidate editing the gate law of a blind lane — correct
refusal. If those probes are wanted, the harness owner adds them for ALL candidates.

## Rails lane — STOPPED at the cycle cap, NOT closed (2026-08-26)
Six blind cycles across two launches. No candidate promoted; `src/rails` does not
exist and the rail gate in `npm test` stays pending. This is a real stop, not a
quiet pass.

**The gate law is sound now** — it was hardened mid-lane (GR-06 rewritten as
work-on-constant-radius-arcs after the old probe was proved to have zero curvature
where the rider is fastest; GR-10 added to catch trick-state destruction; a dead
dt probe fixed; GR-05's timing band relabelled as a declared choice). 9/9 mutants
caught, baseline 10/10. Later cycles found genuine behavioural defects, not law
artifacts, which is the sign the law is working.

**THE ROOT BLOCKER IS A CONTRACT GAP, and it needs a design decision:**
A grind is airborne, but physics only accumulates crouch charge in its GROUND core
(`physics.mjs` T_CHARGE / groundCore) and zeroes `st.charge` at takeoff
(`physics.mjs:270`). So `ps.charge` is ALWAYS 0 during a grind. Measured: hold
crouch 2.5 s on a rail, release -> vertical impulse 2.1000 m/s, exactly J_MIN,
identical to a bare tap (~0.34 m of air). **The rail-into-big-air link — the SSX
money line — is not expressible under the current contract.** One candidate
worked around it by accumulating charge in its own gstate; the other shipped dead
code plus a comment claiming the opposite.

RESOLVED 2026-08-26: the user chose **(a)** — physics now has a chargeable
CONSTRAINED state. `state.constrained = true` means supported by something other
than terrain: the owning module supplies motion, physics runs the rider (crouch
charges at T_CHARGE, prewind captured, airTime held at 0), and jumpRelease leaves
as a TRUE takeoff at full charge. Measured: 5.00 m/s pop, up from the 2.1 J_MIN
that made the lane unbuildable. Gated by PC-14/15/16, each mutation-verified
(each mutant fails exactly its own gate); all 61 physics gates green.
Wallride / halfpipe / tow inherit this for free — the reason (a) was worth the
risk over (b).

**Other findings worth keeping (both candidates, verified by the critic):**
- Capture that uses horizontal speed only taxes a rider on a descending rail
  9.4% at 25 deg, 23% at 40 deg — on the exact case rails are supposed to win.
- `rail-runner` builds every test rail at constant height, which hid a missing
  gravity-along-tangent term. If the lane resumes, add a DESCENDING rail probe.
- A candidate derived a steering constant from `REF_RADIUS = 40`, which is the
  runner's own `arcRail()` default — a constant taken from the gate it must pass.
- One builder agent died on the 64k output-token limit; long-header candidates in
  this lane run close to it.

## Rails gate law — repaired 2026-08-26 after cycle 4's audit (OPEN ITEM below)
A dedicated law-audit agent found SEVEN GR gates that passed WITHOUT the property
they claim to measure. All seven are fixed and each now has a mutant that fails
exactly it (16/16 caught, baseline clean):
- GR-09 read `gs.alongSpeed ?? 0` — renaming the field returned 0 from both runs
  (real split error 4.96e-4 vs a 1e-6 threshold). Now grades hypot(vel.x, vel.z).
- GR-02 graded the module's own declared constant. Now bisects the TRUE radius
  and separately requires the declaration to match within 0.25 m.
- GR-08's slow-lock probe started 6 m up-course at 0.4 m/s and ended at z=-5.78,
  never reaching any capture radius, so minLockSpeed was untested for everyone.
- GR-04 measured ONE frame at the transition; a 40% dump on the next frame scored
  0.00146. Now the worst single-frame step over 0.5 s (drag is ~0.4%/frame).
- GR-07 discarded the lock-frame position delta entirely; a +40 m teleport scored
  illegalWriteMax 0. Now bounded by captureRadius.
- GR-11 diffed values across rl.step, so write-then-restore was invisible. Now
  counts SETS via accessors. KNOWN LIMIT: in-place mutation of an object field
  (st.landing.foo = 1) is still not seen.
- GR-06's `dropsSooner` had no floor, so an instant ejection satisfied the
  "harder" half maximally. Now also requires cross-radius monotonicity.

NEW: GR-12 (descending rail obeys V_CAP) and GR-13 (descending rail carries
gravity along tangent and beats the snow beside it). Every rail in the runner was
FLAT — recorded at the previous rails stop and not actioned until now. The
baseline itself had no gravity-along-tangent: a 25 deg descent ended at 5.85 m/s
against 15.75 on the snow. Fixed; now 29.91 vs 15.75, capped at V_CAP.

PHYSICS (owner bugs the critic found, both now gated and mutation-verified):
- PC-22: the V_CAP clamp lived only in groundCore, so a constraint owner could
  write any velocity. A candidate reached 58.8 m/s on a descending rail and
  leaked 63.95 m/s into the air. airStep is deliberately NOT clamped — ballistic
  flight legitimately exceeds V_CAP in total speed during a long fall.
- PC-23: constrainedStep never called meterTick, so boost on a rail was free
  (0.971 meter left after 5 s vs 0.375 on snow).

Also fixed: tests/suite.mjs's rail test ran in 0.117 ms and early-returned
because src/rails does not exist — it would have stayed green no matter what
landed. It now runs the full sheet against the baseline (120 ms).

### OPEN — needs a decision, not yet gated
GR-06 has NO ABSOLUTE RIDEABILITY FLOOR. Under a proportional controller the
honest baseline holds a straight rail 7.70 s but only 0.72 s at R80 and 0.30 s at
R40 — a real difficulty CLIFF in the reference module, the exact shape cycle 4's
critic measured in a candidate (R150 7.72 s -> R120 0.58 s). A floor at
0.8*straight fails the baseline, so only monotonicity is enforced today. Fixing
it means redesigning the baseline's curve/balance model. Until then a candidate
can ship the same cliff and pass.

## Polish (small, deferred)
- ~~Post-landing camera re-convergence~~ INVESTIGATED 2026-08-26, NOT A CAMERA BUG.
  Measured: camera-to-rider distance is 9-12.5 m across the whole capture reel
  (steady ~9.5 m), and CF-12 — written to catch exactly this and mutation-verified
  — passes at 0.117 s re-convergence with a 1.23x peak. The boom is not lagging.
  What actually makes the rider small in that frame: the render lane's base FOV is
  72 deg (not 60), the chase kick takes it to ~81, and the boom sits ~10 m back, so
  a 1.8 m rider is ~60-72 px of a 720-tall frame (~8-10%). SSX frames the rider
  nearer 15-20%. That is a LOOK DECISION (shorter boom and/or narrower base lens),
  not a defect, and it changes every composed frame — it belongs to an integration
  judge, not a unilateral retune. CF-12 is kept as the regression guard.
- ~~Distant cliff palette pull-in~~ DONE 2026-08-26 (branch fix/distant-cliff-palette).
  Aerial-perspective far edge 3600 -> 1600 m in the rig's snow package. At the
  valley cliff (~800 m) the old range delivered only ~5% haze. Measured cliff
  region: rgb[117,145,183] lum 141 -> rgb[132,160,194] lum 155 against ~190
  foreground snow. Near edge unchanged (300 m) so the corridor is untouched.
  Residual: src/shaders/attach.mjs (the promoted package) still carries the old
  140/2200 pair in its source text while the rig copy sets 300/1600 live — the two
  copies have DRIFTED and should be reconciled before the shader package is
  reused. Not touched here to keep the change to one lever.
- Gate banner close-range appearance (giant slab when camera passes under)
- Award name ellipsises at ≤500 px width (decorative popup only; fixing it means
  reintroducing the viewport-keyed hand-tuning the critic told us to remove)

## Test coverage (as of 2026-08-25)
`npm test` (tier 1, ~40 s, gates EVERY commit): 17 tests — 58 physics/trick gates,
11 camera, 12 HUD, 14 snow-shader, plus contract-shape, copy-sync, dt-exactness and
ground-coherence. No lane is optional-only. `npm run test:full` adds the capture/perf tier.
