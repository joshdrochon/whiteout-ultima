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

## Polish (small, deferred)
- Post-landing camera re-convergence (integration judge, round 4)
- Distant cliff palette pull-in (same)
- Gate banner close-range appearance (giant slab when camera passes under)
- Award name ellipsises at ≤500 px width (decorative popup only; fixing it means
  reintroducing the viewport-keyed hand-tuning the critic told us to remove)

## Test coverage (as of 2026-08-25)
`npm test` (tier 1, ~40 s, gates EVERY commit): 17 tests — 58 physics/trick gates,
11 camera, 12 HUD, 14 snow-shader, plus contract-shape, copy-sync, dt-exactness and
ground-coherence. No lane is optional-only. `npm run test:full` adds the capture/perf tier.
