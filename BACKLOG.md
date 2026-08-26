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

## Rails lane — CLOSED 2026-08-26, with disclosed limits (read them)
Promoted `sandbox/rails/c5B` -> `src/rails/rails.mjs` after five blind cycles.
13/13 GR gates pass, 19/19 rail mutants caught, npm test 22/22.

WIRED, not just promoted: `src/game/main.mjs` imports createRails + buildRails,
`src/run/rails-course.mjs` authors 9 rails along the course, and the RENDERER
draws the same polylines the module captures against (one source of truth, so
you cannot grind a rail that is not where it is drawn). Verified in the running
game: rider locks at t=0.70 s and grinds a 46 m rail for 3.05 s without bailing.
The rig-integration test now fails if any of that is unwired or drifts.

FIXED THIS CYCLE — the critic's single biggest gap: both candidates ERASED
arrival error on capture (balance := 0), so a 0.9 m miss arriving at -3 m/s
lateral bailed at exactly the same time as a dead-centre landing (A 2.63 vs
2.63 s, B 1.37 vs 1.37 s). How you land on a rail cost nothing, which removes
the whole risk/reward of the approach. Now GR-14: the snap removes the lateral
OFFSET but the rider keeps the lateral VELOCITY, and that is what topples them.
Promoted module measures 1.37 s clean vs 0.43 s sloppy (0.93 s cost).

### DISCLOSED: the gate law is a floor, and it is fakeable
Cycle 5's audit built 10 modules that each score 12/12 while missing the
property the gate names. 8 of 12 gates fell. NOT FIXED - a deliberate decision
to stop gate-hardening and ship, because no candidate has ever actually cheated
(the measurer found zero contract violations in cycles 4 and 5) and the real
quality signal has come from the CRITIC, not the sheet.

One bug class explains all ten: EVERY PROBE MEASURES A SINGLE OPERATING POINT.
- GR-11's OWNED list misses boostMeter, _prewind, _coyoteCharge, yawRate, carve,
  slipDeg, onGround. Setting `_prewind` buys a prewound pop off every rail.
- GR-11's accessors install only in writes(): one 8 s flat straight run at
  18 m/s. A cheat gated on speed > 24 scored 5136 deg of free spin.
- GR-04 takes the worst single-FRAME step, so the same total theft spread over
  0.5 s passes: 35.4% lost by 1 s.
- GR-09 is vacuous under a minimum-grind-speed clamp (the probe settles into the
  clamp first); real split error measured 1055x the threshold.
- GR-13 tests ONE slope (25 deg), so a constant aTan = 4.2 is indistinguishable
  from real slope coupling. That module accelerates to V_CAP on a FLAT rail and
  on an ASCENDING one.
- GR-05 passes with no balance state at all: steer +1, 0 and -1 all leave
  balance at 0.1250.
- GR-06 runs every probe at 18 m/s, so hardcoding v = 18 in aLat passes while
  making bends EASIER at speed (32 m/s holds 3x longer than 18).
- GR-02 bisects at one speed; a radius scaling with speed reads 1.00 at 18 m/s
  and 4.02 at 30 m/s.
- GR-08 tests one speed (0.4 m/s); a floor at 0.45 passes and locks at 0.5.

THE FIX IF THIS LANE IS EVER REOPENED: do not patch the ten. Parameterise every
probe over a sweep (speed, slope, offset, curvature, elapsed time) and move the
write-watcher into `attempt()` so it covers every scenario, not just writes().
Estimated ~1 h. Adding more single-point gates makes this worse, not better -
GR-12 and GR-13 were added as single-point gates and both fell immediately.

### Other rails findings kept for the record
- Capture using horizontal speed only taxes a rider on a DESCENDING rail 9.4% at
  25 deg and 23% at 40 deg - exactly where rails should win.
- The promoted module does not read `inp.boost` on a rail. Research 02 sec 1.5
  says verbatim "you go faster boosting on a rail than boosting on the snow".
  NOT IMPLEMENTED. This is the largest known gameplay gap in the shipped lane.
- Its balance texture is not zero-mean over the first 60 m of every rail
  (+0.253 m/s^2, same sign regardless of world orientation), so rails do have a
  mildly favourable side despite NOTES claiming otherwise.

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
