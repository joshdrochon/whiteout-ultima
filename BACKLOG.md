# Backlog

## Done 2026-08-25
- Regression suite promoted (npm test, 14 tests, 0.6s; mutation-verified) — b5da754
- Terrain seam-fix chain reverted to baseline; float + groove gone — see git log
- Real dash fix: light-scaled sparkle/sastrugi in shadeVertex — verified by probe

## Active (ordered)
1. ~~**Promote regression suite**~~ done — see above. 
## Open — wall dash/"seam" artifact (reset 2026-08-25)
All fix attempts reverted to the d3ec260 baseline on user instruction; every attempt
reduced but never eliminated the artifact ON THE USER'S SCREEN. Forensics that survive:
- Raycast at a reproduced dash pixel: 1st hit shadowed wall (458m, dark verts),
  2nd hit sunlit slope (792m, verts ~1.0) -> at least one dash class = lit far slope
  through serrated ridge silhouettes (aliasing-amplified, resolution-dependent).
- NOT: spray (persists with particles hidden), trees (persists in tree-hidden pairs),
  trail RTT wrap (UV-guarded), skirt z-fight color (exact-color test), T-junction
  cracks (geometry present at ray hit), glint dots (light-gating removed a different
  artifact), macro sun-catching vertices (smoothing helped a different artifact).
- Attempts tried + reverted: tile bias, edge dip, skirt depth/color, sparkle light-
  scaling, macro self-shadow, steep-normal smoothing, MSAA, retina DPR, pulled-in fog.
Next attempt must begin by REPRODUCING THE USER'S EXACT SHOT (ask for coords via an
in-game debug key that copies camera pose) and verifying zero-diff against THEIR view
before claiming anything.

## Test coverage (as of 2026-08-25)
`npm test` (tier 1, ~40 s, gates EVERY commit): 17 tests — 58 physics/trick gates,
11 camera, 12 HUD, 14 snow-shader, plus contract-shape, copy-sync, dt-exactness and
ground-coherence. No lane is optional-only any more. Each runner was negative-controlled
(mutate the source -> npm test fails the exact gate -> restore -> green).
`npm run test:full` adds the capture/perf tier.

## Later
- Post-landing camera re-convergence (integration judge, round 4)
- Distant cliff palette pull-in (same)
- Trick-system lane: 7 deferred HARD scoring gates (JA-15..21)
- Sound pass: Sonniss GDC bundles + one dedicated snow-sports library (user sourcing)
- Gate banner close-range appearance (giant slab when camera passes under)
