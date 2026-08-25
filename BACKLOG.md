# Backlog

## Active (ordered)
1. **Promote regression suite** → `tests/` + `npm test` (gauntlet winner A, 8/8 mutant kills; remediation in flight). Every fix runs it before commit.
2. **Revert terrain seam-fix chain** in `src/render/main.mjs` + `src/game/render.mjs` to the
   `d3ec260` baseline (pre-bias, pre-edge-dip). The edge dip renders as a dark groove across
   slopes (user screenshot 2026-08-25 12:21); the original "seam dashes" were misdiagnosed —
   ray-march probe located them mid-tile: sastrugi shading highlights + distant tree tips,
   not T-junction geometry. Run `npm test` after revert.
3. **Real fix for the dash artifact**: attenuate sastrugi-band highlight + glitter amplitude
   by the shading/wrap term in `shadeVertex` (shadowed faces must not sparkle bright).
   Color-only change, no geometry. Verify: probe pose `300,g25,520,-120,g140,300` crop +
   `npm test` + user in-game check.

## Later
- Post-landing camera re-convergence (integration judge, round 4)
- Distant cliff palette pull-in (same)
- Trick-system lane: 7 deferred HARD scoring gates (JA-15..21)
- Sound pass: Sonniss GDC bundles + one dedicated snow-sports library (user sourcing)
- Gate banner close-range appearance (giant slab when camera passes under)
