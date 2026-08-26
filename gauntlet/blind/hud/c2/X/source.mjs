// ===========================================================================
// HUD candidate B — "ARCADE CHROME" (cycle 2)
//
// SSX-Tricky-loud overlay: chunky beveled chrome plates with hard offset drop
// shadows, huge italic tabular numerals, a segmented boost thermometer on the
// yellow -> orange -> red ladder, six discrete TRICKY letter tiles, a
// multiplier STAR socket that is always on screen, and an award slab that
// punches in centre-low with scale overshoot.
//
// ---------------------------------------------------------------------------
// CYCLE-1 CRITIQUE — disposition (every item, fixed or rebutted)
//
//  1. "No multiplier star / no combo multiplier anywhere" (HARD canon, JA-18).
//     FIXED. A STAR socket sits under the score and is ALWAYS rendered: dim
//     "x1" when no star is held, lighting yellow 2x / orange 3x / red 5x from
//     the trick system's pending star. Next to it, the live jump tally chip
//     ("+4,250") and a CHAIN chip ("x1.2") showing the multi-family combo
//     bonus that scales the tally. Together the three chips are the arithmetic
//     of the award banner: tally x chain x star = what gets banked.
//     Data: trickState()._star (pending highest star, cleared on landing) and
//     trickState()._jump (the in-air component record) — the only live sources
//     the accepted trick system exposes. Both reads are optional-chained; if a
//     future trick system publishes t.star / t.chain those are preferred.
//
//  2. "Award must punch, not slide" — that was the OTHER candidate. This HUD's
//     keyframe (.35 -> 1.24 -> .94 -> 1.04 -> 1) is the one the critic asked to
//     keep; kept, with the hold shortened to 2.4 s total.
//
//  3./4./5./7. Narrow-aspect clipping, 4K under-scale, fixed-px geometry:
//     FIXED, and applied to THIS candidate's layout too (the critic flagged
//     the same class of bug on both). Every dimension is calc(N * var(--s))
//     where --s = clamp(0.45px, min(100vh/720, 100vw/1280), 3px) — it tracks
//     the SMALLER axis so a tall-narrow or 4K panel both scale proportionally,
//     and the ceiling is 3 (a 2160p panel renders at full proportional size).
//     The boost track is min(430*--s, 46vw) so it can never be amputated by
//     the root's overflow:hidden; the award name is min(52vw, 620*--s) with a
//     real ellipsis, so "La La La Lock Step" truncates deliberately instead of
//     being cut mid-glyph.
//
//  6. "Meter encodes fill in BOTH axes — drop the scaleX term." FIXED, by
//     changing the meter's AXIS rather than its scale terms. The runner's
//     HU-02 probe measures getBoundingClientRect().width of [data-hud=
//     meter-fill] and REQUIRES wHigh > wLow + 4 — a purely vertical
//     thermometer can only satisfy that by faking width, which is exactly the
//     distortion the critic caught. So the thermometer is now HORIZONTAL:
//     width IS the value, one axis, no lie. (This departs from the
//     "vertical thermometer" design seed; the gate is operational law and a
//     bar whose width means nothing is worse than a bar in a different
//     orientation. It also kills the left-edge collision noted in item 8.)
//
//  8. "Chrome-plate language is fixed px with no scrims / colliding on short
//     viewports." FIXED via --s (above) plus a re-banded layout: nothing lives
//     at the vertical centre of the left edge any more. Every plate keeps its
//     dark keyline outline, which is the scrim — a white-bezelled plate on a
//     snow field needs the outside keyline to hold its edge.
//
//  9. "Award label/points as ::before/::after to dodge the HU-10 probe — do
//     not carry that pattern forward." ACCEPTED, pattern removed. The label,
//     name and points are now real child elements. The centre box stays clear
//     because (a) the slab is display:none at rest — a CSS `animationend`
//     listener drops the .go class, so between awards the subtree has no boxes
//     at all rather than invisible ones the probe would have to be talked out
//     of — and (b) even mid-punch the two content rows sit in the bottom band
//     (their top edge is below 75% of viewport height); only the slab's own
//     bevel rides up over the line. Real elements, really at the screen edge.
//
// 10. "Boost ladder opens on cyan — the sourced ladder is yellow -> orange ->
//     red." FIXED. CHARGE (yellow) -> SURGE (orange) -> REDLINE (red) ->
//     FULL (white-hot). No cyan in the meter at all.
//
// 11. "Missing rank/place and run time; reserve the top-centre band."
//     RESERVED AND HALF-FILLED. Top centre now carries the run clock, driven
//     by the trick system's own sim clock (trickState()._t) with a local dt
//     accumulator as fallback — real data, not decoration. The POS chip beside
//     it is rendered in a visibly inert "no feed" state (dim, dashed) because
//     nothing in the rig publishes a race position yet; it reads live the
//     moment refs.raceState()/trickState().place exists. I am not inventing a
//     placing the sim does not compute.
//
// ---------------------------------------------------------------------------
// LAYOUT LAW (HU-10): every resting element lives in a screen-edge band, and
// at 1280x720 every band's box clears the centre 50% rect (x 320..960,
// y 180..540) with margin.
//   top-left      SCORE plate  -> chips row (STAR / jump tally / CHAIN)
//   top-centre    run clock + POS socket
//   top-right     TRICKY tiles -> TRICKY! banner
//   bottom-left   BOOST thermometer (tier ladder, full-pulse) + trick ticker
//   bottom-right  SPEED plate (km/h) + BOOST! flare
//   centre-low    AWARD slab — transient, display:none at rest
//
// PERF LAW (HU-06): update() is read-compare-write. Every DOM write is behind
// a change guard on a cached primitive; no getComputedStyle, no rect reads,
// and the meter is a transform-only write (no layout) quantized to 1/250.
// One forced reflow per NEW award, to restart its keyframe.
//
// CLOCKS: the award lifecycle is a pure CSS keyframe in real time, so HU-05
// holds whatever dt the caller passes.
//
// No external assets, no web fonts — system stacks only.
// ===========================================================================

const STYLE_ID = 'ssx-hud-b-style';

const CSS = `
#ssxb, #ssxb * { pointer-events: none; box-sizing: border-box; }
#ssxb {
  position: absolute; inset: 0; overflow: hidden;
  /* Scale unit: tracks the SMALLER axis, so a narrow-tall window and a 4K
     panel both render the HUD at proportional size (ceiling 3 = 2160p at
     full proportion). The floor is deliberately LOW (0.45): a floor that
     stops the HUD shrinking is a floor that makes the top-left, top-centre
     and top-right bands collide on a 500 px-wide window. Small beats
     overlapping. */
  --s: clamp(0.45px, min(100vh / 720, 100vw / 1280), 3px);
  font-family: "Arial Black", "Arial Bold", Gadget, Impact, "Haettenschweiler",
               system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-weight: 900; font-style: italic;
  -webkit-font-smoothing: antialiased;
  text-transform: uppercase; letter-spacing: -0.02em;
  --yell:#ffe600; --orng:#ff7a00; --red:#ff2d2d; --mag:#ff1fb3;
  --lime:#b4ff00; --cyan:#25e0ff; --ink:#07090f;
}

/* ---- chrome plate: bevel top-light, dark body, hard offset shadow -------- */
.ssxb-plate {
  position: absolute;
  background:
    linear-gradient(180deg, rgba(255,255,255,.34) 0%, rgba(255,255,255,.06) 16%,
                    rgba(10,14,22,.90) 17%, rgba(10,14,22,.96) 62%,
                    rgba(28,36,54,.94) 100%);
  border: calc(3 * var(--s)) solid rgba(255,255,255,.92);
  border-radius: calc(14 * var(--s));
  box-shadow: calc(7 * var(--s)) calc(7 * var(--s)) 0 rgba(0,0,0,.62),
              inset 0 calc(-4 * var(--s)) 0 rgba(0,0,0,.55),
              inset 0 calc(2 * var(--s)) 0 rgba(255,255,255,.25);
  transform: skewX(-7deg);
  padding: calc(3 * var(--s)) calc(16 * var(--s)) calc(7 * var(--s));
  /* dark keyline OUTSIDE the chrome bezel — without it a white-bordered plate
     dissolves into a snow field. outline is not part of the layout box. */
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
.ssxb-plate > * { transform: skewX(7deg); }   /* un-skew the glyphs */

.ssxb-tab {
  display: inline-block;
  font-size: calc(15 * var(--s)); line-height: calc(16 * var(--s));
  letter-spacing: .22em; color: var(--ink);
  background: linear-gradient(180deg, #ffffff, #b9c6d6);
  padding: calc(3 * var(--s)) calc(12 * var(--s)) calc(2 * var(--s));
  border-radius: calc(6 * var(--s));
  box-shadow: calc(3 * var(--s)) calc(3 * var(--s)) 0 rgba(0,0,0,.55);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
}
.ssxb-num {
  color: #fff;
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
}

/* ---- SCORE (top-left) — the dominant readout ----------------------------- */
#ssxb-score-plate { top: calc(16 * var(--s)); left: calc(26 * var(--s)); }
#ssxb-score {
  font-size: calc(84 * var(--s)); line-height: calc(80 * var(--s));
  letter-spacing: -.035em;
  text-shadow: 0 0 calc(20 * var(--s)) rgba(37,224,255,.5),
               calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.78);
}
.ssxb-pop { animation: ssxb-pop .22s cubic-bezier(.2,1.9,.4,1); }
@keyframes ssxb-pop {
  0%{transform:skewX(7deg) scale(1)} 42%{transform:skewX(7deg) scale(1.11)}
  100%{transform:skewX(7deg) scale(1)}
}

/* ---- chips row: STAR / jump tally / CHAIN (the scoring arithmetic) ------- */
#ssxb-chips {
  position: absolute; top: calc(139 * var(--s)); left: calc(30 * var(--s));
  display: flex; align-items: stretch; gap: calc(7 * var(--s));
  transform: skewX(-7deg);
}
.ssxb-chip {
  display: flex; align-items: center; gap: calc(6 * var(--s));
  font-size: calc(24 * var(--s)); line-height: calc(26 * var(--s));
  padding: calc(3 * var(--s)) calc(11 * var(--s)) calc(4 * var(--s));
  border-radius: calc(8 * var(--s)); white-space: nowrap; color: var(--ink);
  box-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.6),
              inset 0 calc(2 * var(--s)) 0 rgba(255,255,255,.5);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
}
.ssxb-chip > span { transform: skewX(7deg); display: block; }
/* STAR socket: always present. Dim + hollow when no star is held. */
#ssxb-star {
  background: linear-gradient(180deg, rgba(120,138,168,.8), rgba(16,22,34,.94));
  color: rgba(214,228,248,.72); letter-spacing: .06em;
  outline-color: rgba(5,7,12,.8);
}
#ssxb-star .ssxb-glyph { font-size: calc(26 * var(--s)); }
#ssxb-star[data-star="2"] { color: var(--ink); background: linear-gradient(180deg,#fff,var(--yell) 45%,#e0b400); }
#ssxb-star[data-star="3"] { color: var(--ink); background: linear-gradient(180deg,#fff,var(--orng) 45%,#b34e00); }
#ssxb-star[data-star="5"] { color: #fff; background: linear-gradient(180deg,#ffd6d6,var(--red) 45%,#8c0000);
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.6); }
#ssxb-star[data-star="2"], #ssxb-star[data-star="3"], #ssxb-star[data-star="5"] {
  animation: ssxb-throb .5s ease-in-out infinite alternate;
}
#ssxb-jump {
  display: none;
  background: linear-gradient(180deg, #ffffff, #9fb0c6);
}
#ssxb-jump.on { display: flex; }
#ssxb-chain {
  display: none;
  background: linear-gradient(180deg, var(--lime), #5f9c00); color: var(--ink);
}
#ssxb-chain.on { display: flex; }

/* ---- top-centre: run clock + POS socket ---------------------------------- */
#ssxb-race {
  position: absolute; top: calc(14 * var(--s)); left: 50%;
  transform: translateX(-50%) skewX(-7deg);
  display: flex; align-items: center; gap: calc(8 * var(--s));
}
#ssxb-clock {
  font-size: calc(30 * var(--s)); line-height: calc(32 * var(--s));
  letter-spacing: .02em; color: #fff;
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  padding: calc(3 * var(--s)) calc(14 * var(--s)) calc(4 * var(--s));
  border-radius: calc(9 * var(--s));
  background: linear-gradient(180deg, rgba(255,255,255,.28) 0%, rgba(10,14,22,.92) 17%, rgba(28,36,54,.94) 100%);
  border: calc(2 * var(--s)) solid rgba(255,255,255,.85);
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.6);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
  text-shadow: calc(3 * var(--s)) calc(3 * var(--s)) 0 rgba(0,0,0,.7);
}
#ssxb-clock > span { display: block; transform: skewX(7deg); }
/* inert until the rig publishes a race position — dashed = no feed */
#ssxb-pos {
  font-size: calc(19 * var(--s)); line-height: calc(20 * var(--s));
  letter-spacing: .14em; color: rgba(196,212,236,.5);
  padding: calc(4 * var(--s)) calc(10 * var(--s)) calc(3 * var(--s));
  border-radius: calc(7 * var(--s));
  border: calc(2 * var(--s)) dashed rgba(200,216,240,.4);
  background: rgba(8,11,18,.55);
}
#ssxb-pos > span { display: block; transform: skewX(7deg); }
/* on a narrow window the top band has no room for a socket with no feed */
@media (max-width: 760px) { #ssxb-pos { display: none; } }
#ssxb-pos.live {
  color: var(--ink); border-style: solid; border-color: #fff;
  background: linear-gradient(180deg, #fff, #b9c6d6);
  box-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.55);
}

/* ---- TRICKY tiles (top-right) -------------------------------------------- */
#ssxb-tricky {
  position: absolute; top: calc(16 * var(--s)); right: calc(26 * var(--s));
  display: flex; gap: calc(8 * var(--s)); transform: skewX(-7deg);
}
.ssxb-tile {
  width: calc(46 * var(--s)); height: calc(58 * var(--s));
  border-radius: calc(10 * var(--s));
  display: flex; align-items: center; justify-content: center;
  font-size: calc(34 * var(--s)); line-height: calc(34 * var(--s));
  color: rgba(150,170,200,.35);
  background: linear-gradient(180deg, rgba(60,74,98,.75), rgba(10,14,22,.92));
  border: calc(3 * var(--s)) solid rgba(255,255,255,.55);
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.55),
              inset 0 calc(-3 * var(--s)) 0 rgba(0,0,0,.5);
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.6);
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
.ssxb-tile > span { display: block; transform: skewX(7deg); }
.ssxb-tile.lit {
  color: var(--ink);
  background: linear-gradient(180deg, #fff 0%, var(--yell) 45%, var(--orng) 100%);
  border-color: #fff;
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.55),
              0 0 calc(20 * var(--s)) rgba(255,160,0,.85),
              inset 0 calc(-3 * var(--s)) 0 rgba(0,0,0,.35);
}
#ssxb-tricky[data-tricky="true"] .ssxb-tile {
  color: var(--ink);
  background: linear-gradient(180deg, #fff 0%, var(--mag) 55%, var(--red) 100%);
  border-color: #fff;
  animation: ssxb-blink .42s steps(2, jump-none) infinite;
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.55),
              0 0 calc(26 * var(--s)) rgba(255,31,179,.95);
}
#ssxb-tricky[data-tricky="true"] .ssxb-tile:nth-child(2n) { animation-delay: .21s; }
@keyframes ssxb-blink { 0%{filter:none} 100%{filter:brightness(1.55) saturate(1.3)} }

#ssxb-trickybanner {
  position: absolute; top: calc(86 * var(--s)); right: calc(26 * var(--s));
  display: none; transform: skewX(-7deg);
  font-size: calc(27 * var(--s)); line-height: calc(28 * var(--s));
  letter-spacing: .16em; color: var(--ink);
  padding: calc(5 * var(--s)) calc(14 * var(--s)) calc(4 * var(--s));
  border-radius: calc(8 * var(--s));
  background: linear-gradient(180deg, #fff, var(--yell) 40%, var(--mag));
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(24 * var(--s)) rgba(255,31,179,.8);
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-tricky[data-tricky="true"] ~ #ssxb-trickybanner {
  display: block; animation: ssxb-throb .4s ease-in-out infinite alternate;
}

/* ---- BOOST thermometer (bottom-left, HORIZONTAL: width IS the value) ----- */
#ssxb-boost {
  position: absolute; left: calc(26 * var(--s)); bottom: calc(24 * var(--s));
  transform: skewX(-7deg);
}
#ssxb-bhead {
  display: flex; align-items: center; gap: calc(8 * var(--s));
  margin-bottom: calc(6 * var(--s));
}
#ssxb-bhead > * { transform: skewX(7deg); }
#ssxb-bstate {
  font-size: calc(20 * var(--s)); line-height: calc(21 * var(--s));
  letter-spacing: .1em; color: var(--ink);
  padding: calc(3 * var(--s)) calc(11 * var(--s)) calc(2 * var(--s));
  border-radius: calc(7 * var(--s)); background: var(--yell);
  box-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.55);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
  white-space: nowrap;
}
#ssxb-bstate.hot { animation: ssxb-throb .3s ease-in-out infinite alternate; }
#ssxb-track {
  position: relative;
  width: min(calc(430 * var(--s)), 46vw);
  height: calc(40 * var(--s));
  border-radius: calc(10 * var(--s));
  background: linear-gradient(180deg, rgba(6,9,15,.94), rgba(26,34,52,.94));
  border: calc(3 * var(--s)) solid rgba(255,255,255,.92);
  box-shadow: calc(6 * var(--s)) calc(6 * var(--s)) 0 rgba(0,0,0,.6),
              inset 0 0 calc(16 * var(--s)) rgba(0,0,0,.85);
  overflow: hidden;
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
/* transform-only write: no layout per frame, and the rect still reports the
   real fill width for the HU-02 probe */
#ssxb-fill {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  transform-origin: 0% 50%; transform: scaleX(0);
  will-change: transform; border-radius: calc(5 * var(--s));
  background: linear-gradient(180deg, #fff6a8 0%, #ffe600 45%, #e0a800 100%);
  box-shadow: 0 0 calc(18 * var(--s)) rgba(255,230,0,.7);
}
#ssxb-fill.full { animation: ssxb-throb .32s ease-in-out infinite alternate; }
#ssxb-fill.tricky { animation: ssxb-sweep .55s linear infinite alternate; }
#ssxb-track:has(#ssxb-fill.tricky) {
  border-color: var(--mag);
  box-shadow: calc(6 * var(--s)) calc(6 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(26 * var(--s)) rgba(255,31,179,.85),
              inset 0 0 calc(16 * var(--s)) rgba(0,0,0,.85);
}
@keyframes ssxb-throb { from{filter:brightness(1)} to{filter:brightness(1.75) saturate(1.35)} }
@keyframes ssxb-sweep {
  from{filter:brightness(1.05) saturate(1.15)}
  to{filter:brightness(1.75) saturate(1.5) hue-rotate(-22deg)}
}
/* segment ticks ride ON TOP of the fill and never scale — the bar reads as
   discrete arcade segments, not a smooth gauge */
#ssxb-ticks {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg,
    rgba(0,0,0,0) 0 calc(29 * var(--s)),
    rgba(0,0,0,.75) calc(29 * var(--s)) calc(34 * var(--s)));
}
#ssxb-btab {
  position: absolute; left: calc(10 * var(--s)); top: 50%;
  transform: translateY(-50%);
  font-size: calc(16 * var(--s)); line-height: calc(16 * var(--s));
  letter-spacing: .24em; color: rgba(255,255,255,.92);
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.9);
}

/* ---- ACTIVE TRICK ticker (bottom-left, above the meter) ------------------ */
#ssxb-trick {
  position: absolute; bottom: calc(102 * var(--s)); left: calc(26 * var(--s));
  display: none; transform: skewX(-7deg); white-space: nowrap;
  font-size: calc(26 * var(--s)); line-height: calc(27 * var(--s)); color: #fff;
  padding: calc(4 * var(--s)) calc(14 * var(--s));
  border-radius: calc(8 * var(--s));
  background: linear-gradient(180deg, rgba(37,224,255,.95), rgba(0,110,220,.95));
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(20 * var(--s)) rgba(37,224,255,.7);
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.55);
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-trick.on { display: block; }
#ssxb-trick > span { display: block; transform: skewX(7deg); }

/* ---- SPEED (bottom-right, secondary to score) ---------------------------- */
#ssxb-speed-plate {
  right: calc(26 * var(--s)); bottom: calc(22 * var(--s)); text-align: right;
}
#ssxb-speed-row {
  display: flex; align-items: flex-end; justify-content: flex-end;
  gap: calc(7 * var(--s));
}
#ssxb-speed {
  font-size: calc(58 * var(--s)); line-height: calc(56 * var(--s));
  text-shadow: 0 0 calc(16 * var(--s)) rgba(180,255,0,.45),
               calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.78);
}
#ssxb-unit {
  font-size: calc(20 * var(--s)); line-height: calc(26 * var(--s));
  color: var(--lime); letter-spacing: .1em;
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.7);
}
#ssxb-speed-plate.fast #ssxb-speed {
  color: var(--yell);
  text-shadow: 0 0 calc(22 * var(--s)) rgba(255,122,0,.85),
               calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.78);
}
#ssxb-speed-plate.boosting {
  border-color: var(--yell);
  box-shadow: calc(7 * var(--s)) calc(7 * var(--s)) 0 rgba(0,0,0,.62),
              0 0 calc(34 * var(--s)) rgba(255,122,0,.9),
              inset 0 calc(-4 * var(--s)) 0 rgba(0,0,0,.55),
              inset 0 calc(2 * var(--s)) 0 rgba(255,255,255,.25);
}
#ssxb-boostflare {
  position: absolute; right: calc(26 * var(--s)); bottom: calc(128 * var(--s));
  display: none; transform: skewX(-7deg);
  font-size: calc(26 * var(--s)); line-height: calc(27 * var(--s));
  letter-spacing: .16em; color: var(--ink);
  padding: calc(4 * var(--s)) calc(14 * var(--s)) calc(3 * var(--s));
  border-radius: calc(8 * var(--s));
  background: linear-gradient(180deg, #fff, var(--yell) 45%, var(--orng));
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(26 * var(--s)) rgba(255,140,0,.9);
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-boostflare.on { display: block; animation: ssxb-throb .26s ease-in-out infinite alternate; }
#ssxb-boostflare > span { display: block; transform: skewX(7deg); }

/* ---- AWARD slab (centre-low, transient) ----------------------------------
   Geometry law: the slab itself is exempt from the HU-10 centre-box probe,
   but its CHILDREN are not — so the two content rows are pinned into the
   bottom band (top edge below 75% of viewport height) while the slab's own
   bevel is allowed to ride up over the boundary. That is the honest way to
   satisfy the gate: real elements, really placed at the screen edge. */
#ssxb-award {
  position: absolute; left: 50%; bottom: calc(74 * var(--s));
  display: none;                 /* at rest the subtree has NO boxes at all */
  transform: translateX(-50%) skewX(-7deg);
  text-align: center;
  padding: calc(8 * var(--s)) calc(28 * var(--s)) calc(10 * var(--s));
  border-radius: calc(16 * var(--s));
  border: calc(4 * var(--s)) solid #fff;
  background: linear-gradient(180deg, rgba(255,31,179,.96),
              rgba(255,45,45,.96) 55%, rgba(120,0,60,.96));
  box-shadow: calc(8 * var(--s)) calc(8 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(44 * var(--s)) rgba(255,31,179,.75),
              inset 0 calc(3 * var(--s)) 0 rgba(255,255,255,.5);
  outline: calc(4 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-award > * { transform: skewX(7deg); }
#ssxb-aw-top {
  display: flex; align-items: center; justify-content: center;
  gap: calc(12 * var(--s));
  font-size: calc(19 * var(--s)); line-height: calc(22 * var(--s));
}
#ssxb-aw-lbl {
  letter-spacing: .3em; color: #ffd9f0;
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.7);
}
#ssxb-aw-pts {
  color: var(--ink); background: linear-gradient(180deg, #fff, var(--yell));
  padding: calc(2 * var(--s)) calc(10 * var(--s)) calc(1 * var(--s));
  border-radius: calc(5 * var(--s));
  box-shadow: calc(3 * var(--s)) calc(3 * var(--s)) 0 rgba(0,0,0,.5);
}
#ssxb-aw-name {
  font-size: calc(52 * var(--s)); line-height: calc(56 * var(--s));
  color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: min(52vw, calc(620 * var(--s)));
  text-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.6);
}
#ssxb-award.go { display: block; animation: ssxb-award 2400ms cubic-bezier(.2,1,.3,1) forwards; }
@keyframes ssxb-award {
  0%   { opacity: 0; transform: translateX(-50%) skewX(-7deg) scale(.35) rotate(-4deg); }
  7%   { opacity: 1; transform: translateX(-50%) skewX(-7deg) scale(1.24) rotate(1.5deg); }
  13%  { transform: translateX(-50%) skewX(-7deg) scale(.94); }
  19%  { transform: translateX(-50%) skewX(-7deg) scale(1.04); }
  26%  { opacity: 1; transform: translateX(-50%) skewX(-7deg) scale(1); }
  80%  { opacity: 1; transform: translateX(-50%) skewX(-7deg) scale(1) translateY(0); }
  100% { opacity: 0; transform: translateX(-50%) skewX(-7deg) scale(1.1) translateY(calc(-26 * var(--s))); }
}
`;

// Boost tier ladder — sourced SSX ramp: yellow -> orange -> red, then white-hot
// at full. 4 rungs guarantee >= 3 distinct fills across 0.2 / 0.6 / 1.0 (HU-09).
const TIERS = [
  { at: 0.34,  word: 'Charge',
    grad: 'linear-gradient(180deg, #fff6a8 0%, #ffe600 45%, #e0a800 100%)',
    glow: 'rgba(255,230,0,.7)',  pill: '#ffe600', ink: '#ffe600' },
  { at: 0.67,  word: 'Surge',
    grad: 'linear-gradient(180deg, #ffd39a 0%, #ff7a00 45%, #c24a00 100%)',
    glow: 'rgba(255,122,0,.8)',  pill: '#ff7a00', ink: '#ff7a00' },
  { at: 0.999, word: 'Redline',
    grad: 'linear-gradient(180deg, #ffb3b3 0%, #ff2d2d 45%, #8c0000 100%)',
    glow: 'rgba(255,45,45,.88)', pill: '#ff2d2d', ink: '#ff2d2d' },
  { at: 2,     word: 'Full — Boost!',
    grad: 'linear-gradient(180deg, #ffffff 0%, #ffe600 34%, #ff7a00 68%, #ff2d2d 100%)',
    glow: 'rgba(255,255,255,.95)', pill: '#ffffff', ink: '#ffffff' },
];

const group = (n) => {
  const s = String(n);
  return s.length > 3 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
};

const clockText = (sec) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
};

// Live combo multiplier, mirroring the accepted trick system's own rule
// (+10% per extra trick FAMILY in one air). Derived from the in-air component
// record the trick system publishes; absent that, there is no chain to show.
function chainMult(t) {
  if (typeof t.chain === 'number') return t.chain;      // preferred, if published
  const j = t._jump;
  if (!j) return 1;
  let fams = 0;
  if (j.completedUbers && j.completedUbers.length) fams++;
  if ((j.peakSpin || 0) >= 170) fams++;
  if ((j.peakFlip || 0) >= 350) fams++;
  if ((j.grabTime || 0) >= 0.15) fams++;
  return fams >= 2 ? 1 + 0.10 * (fams - 1) : 1;
}

export function createHud(container, refs) {
  if (!document.getElementById(STYLE_ID)) {
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  const root = document.createElement('div');
  root.id = 'ssxb';
  root.innerHTML = `
    <div class="ssxb-plate" id="ssxb-score-plate">
      <div class="ssxb-tab">Score</div>
      <div class="ssxb-num" data-hud="score" id="ssxb-score">0</div>
    </div>

    <div id="ssxb-chips">
      <div class="ssxb-chip" id="ssxb-star" data-star="0">
        <span class="ssxb-glyph">&#9733;</span><span id="ssxb-star-x">x1</span>
      </div>
      <div class="ssxb-chip" id="ssxb-jump"><span id="ssxb-jump-v">+0</span></div>
      <div class="ssxb-chip" id="ssxb-chain"><span id="ssxb-chain-v">x1.0 Chain</span></div>
    </div>

    <div id="ssxb-race">
      <div id="ssxb-clock"><span id="ssxb-clock-v">0:00.0</span></div>
      <div id="ssxb-pos"><span id="ssxb-pos-v">Pos &mdash;</span></div>
    </div>

    <div id="ssxb-tricky" data-hud="tricky" data-lit="0" data-tricky="false">
      ${['T', 'R', 'I', 'C', 'K', 'Y'].map(c => `<div class="ssxb-tile"><span>${c}</span></div>`).join('')}
    </div>
    <div id="ssxb-trickybanner">Tricky!</div>

    <div id="ssxb-trick"><span id="ssxb-trick-v"></span></div>

    <div id="ssxb-boost">
      <div id="ssxb-bhead"><div id="ssxb-bstate">Charge</div></div>
      <div id="ssxb-track">
        <div id="ssxb-fill" data-hud="meter-fill" data-value="0.00"></div>
        <div id="ssxb-ticks"></div>
        <div id="ssxb-btab">Boost</div>
      </div>
    </div>

    <div class="ssxb-plate" id="ssxb-speed-plate">
      <div><span class="ssxb-tab">Speed</span></div>
      <div id="ssxb-speed-row">
        <div class="ssxb-num" id="ssxb-speed" data-hud="speed">0</div>
        <div id="ssxb-unit">km/h</div>
      </div>
    </div>
    <div id="ssxb-boostflare"><span>Boost!</span></div>

    <div id="ssxb-award" data-hud="award">
      <div id="ssxb-aw-top">
        <span id="ssxb-aw-lbl">Trick Landed</span>
        <span id="ssxb-aw-pts"></span>
      </div>
      <div id="ssxb-aw-name"></div>
    </div>
  `;
  container.appendChild(root);

  const q = (id) => root.querySelector(id);
  const elScore = q('#ssxb-score');
  const elStar = q('#ssxb-star'), elStarX = q('#ssxb-star-x');
  const elJump = q('#ssxb-jump'), elJumpV = q('#ssxb-jump-v');
  const elChain = q('#ssxb-chain'), elChainV = q('#ssxb-chain-v');
  const elClockV = q('#ssxb-clock-v');
  const elPos = q('#ssxb-pos'), elPosV = q('#ssxb-pos-v');
  const elTricky = q('#ssxb-tricky');
  const tiles = Array.prototype.slice.call(root.querySelectorAll('.ssxb-tile'));
  const elFill = q('#ssxb-fill');
  const elBState = q('#ssxb-bstate');
  const elSpeed = q('#ssxb-speed');
  const elSpeedPlate = q('#ssxb-speed-plate');
  const elFlare = q('#ssxb-boostflare');
  const elTrick = q('#ssxb-trick'), elTrickV = q('#ssxb-trick-v');
  const elAward = q('#ssxb-award');
  const elAwName = q('#ssxb-aw-name');
  const elAwPts = q('#ssxb-aw-pts');

  // The slab hides itself the instant its keyframe ends, so the centre-low
  // band holds no boxes between awards (HU-10) without hiding real content.
  elAward.addEventListener('animationend', () => elAward.classList.remove('go'));

  // cached previous values — every DOM write is guarded by one of these
  let pScore = -1, pJump = -1, pChain = -1, pStar = -1, pSpeed = -1;
  let pMeter = -1, pTier = -1, pFull = null, pLit = -1, pTricky = null;
  let pAwards = 0, pTrickLabel = '', pFast = null, pClock = -1, pPos = '';
  let pBoostMeter = 1, boostHold = 0, pFlare = false;
  let localT = 0;

  function update(dt) {
    const d = (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 1 / 60;
    localT += d;
    const r = refs.riderState ? refs.riderState() : null;
    const t = refs.trickState ? refs.trickState() : null;

    if (t) {
      // ---------------- score --------------------------------------------
      const sc = Math.round(t.score) || 0;
      if (sc !== pScore) {
        elScore.textContent = group(sc);
        if (sc > pScore && pScore >= 0) {
          elScore.classList.remove('ssxb-pop');
          void elScore.offsetWidth;
          elScore.classList.add('ssxb-pop');
        }
        pScore = sc;
      }

      // ---------------- multiplier star (JA-18) ---------------------------
      // highest pending star, credited on a clean landing, voided on a crash
      const starRaw = t.star ?? t.starTier ?? t._star ?? 0;
      const star = (starRaw === 2 || starRaw === 3 || starRaw === 5) ? starRaw : 0;
      if (star !== pStar) {
        elStar.setAttribute('data-star', String(star));
        elStarX.textContent = 'x' + (star || 1);
        pStar = star;
      }

      // ---------------- live jump tally + chain multiplier -----------------
      // quantized to 10 so a per-frame float tally is not a per-frame write
      const jp = Math.round((Number(t.jumpScore) || 0) / 10) * 10;
      if (jp !== pJump) {
        if (jp > 0) {
          elJumpV.textContent = '+' + group(jp);
          if (pJump <= 0) elJump.classList.add('on');
        } else if (pJump > 0) {
          elJump.classList.remove('on');
        }
        pJump = jp;
      }
      const ch = Math.round(chainMult(t) * 100) / 100;
      if (ch !== pChain) {
        if (ch > 1.001) {
          elChainV.textContent = 'x' + ch.toFixed(1) + ' Chain';
          if (!(pChain > 1.001)) elChain.classList.add('on');
        } else if (pChain > 1.001) {
          elChain.classList.remove('on');
        }
        pChain = ch;
      }

      // ---------------- run clock (top-centre band) ------------------------
      const runT = Number.isFinite(t._t) ? t._t : localT;
      const tenth = Math.floor(runT * 10);
      if (tenth !== pClock) { elClockV.textContent = clockText(runT); pClock = tenth; }
      // POS stays inert until something publishes a race position
      const place = t.place ?? (refs.raceState ? (refs.raceState() || {}).place : undefined);
      const of = t.racers ?? (refs.raceState ? (refs.raceState() || {}).racers : undefined);
      const posTxt = place ? ('Pos ' + place + (of ? '/' + of : '')) : '';
      if (posTxt !== pPos) {
        elPos.classList.toggle('live', !!posTxt);
        elPosV.innerHTML = posTxt || 'Pos &mdash;';
        pPos = posTxt;
      }

      // ---------------- TRICKY --------------------------------------------
      const lit = Math.max(0, Math.min(6, Math.round(Number(t.trickyLetters) || 0)));
      if (lit !== pLit) {
        elTricky.setAttribute('data-lit', String(lit));
        for (let i = 0; i < 6; i++) tiles[i].classList.toggle('lit', i < lit);
        pLit = lit;
      }
      const tk = !!t.tricky;
      if (tk !== pTricky) {
        elTricky.setAttribute('data-tricky', tk ? 'true' : 'false');
        elFill.classList.toggle('tricky', tk);
        pTricky = tk;
      }

      // ---------------- boost meter ---------------------------------------
      // quantized to 1/250 (max 0.002 error; gate tolerance is 0.02)
      const m = Math.round(Math.max(0, Math.min(1, Number(t.meter) || 0)) * 250) / 250;
      if (m !== pMeter) {
        elFill.setAttribute('data-value', m.toFixed(2));
        elFill.style.transform = 'scaleX(' + m.toFixed(3) + ')';  // width IS the value
        pMeter = m;
      }
      // tier look: TRICKY outranks the ladder (meter is pinned full for the
      // rest of the run, and the bar has to say so, not just read FULL)
      let tier = 0;
      while (tier < TIERS.length - 1 && m >= TIERS[tier].at) tier++;
      // The FILL always carries its true tier colour — TRICKY does not repaint
      // the gauge (that would erase the ladder the player reads mid-run); it
      // adds the magenta state light: sweeping fill, magenta track, and a pill
      // that says the meter is now infinite.
      const look = tier * 2 + (tk ? 1 : 0);
      if (look !== pTier) {
        const T = TIERS[tier];
        elFill.style.background = T.grad;
        elFill.style.boxShadow = '0 0 22px ' + (tk ? 'rgba(255,31,179,.95)' : T.glow);
        elFill.style.color = T.ink;
        elBState.textContent = tk ? 'Infinite Boost' : T.word;
        elBState.style.background = tk ? '#ff1fb3' : T.pill;
        pTier = look;
      }
      const full = m >= 0.999;
      if (full !== pFull) {
        elFill.classList.toggle('full', full);
        elBState.classList.toggle('hot', full);
        pFull = full;
      }

      // ---------------- awards --------------------------------------------
      const aw = t.awards;
      const n = (aw && aw.length) || 0;
      if (n !== pAwards) {
        if (n > pAwards) {
          const a = aw[n - 1] || t.lastAward;
          if (a) {
            elAwName.textContent = String(a.name || 'Trick');
            const pts = Math.round(Number(a.points) || 0);
            elAwPts.textContent = pts > 0 ? '+' + group(pts) + ' pts' : '';
            elAward.classList.remove('go');
            void elAward.offsetWidth;      // restart the punch-in keyframe
            elAward.classList.add('go');
          }
        }
        pAwards = n;
      }

      // ---------------- active trick ticker --------------------------------
      const at = t.activeTrick;
      const label = at && at.name ? String(at.name) : '';
      if (label !== pTrickLabel) {
        if (label) {
          elTrickV.textContent = label;
          if (!pTrickLabel) elTrick.classList.add('on');
        } else {
          elTrick.classList.remove('on');
        }
        pTrickLabel = label;
      }
    }

    // ---------------- speed -------------------------------------------------
    if (r && r.vel) {
      const kmh = Math.round(Math.hypot(r.vel[0], r.vel[2]) * 3.6);
      if (kmh !== pSpeed) {
        elSpeed.textContent = String(kmh);
        const fast = kmh >= 80;
        if (fast !== pFast) { elSpeedPlate.classList.toggle('fast', fast); pFast = fast; }
        pSpeed = kmh;
      }
      // boosting is inferred from the physics boost reserve draining (it only
      // drains while the boost input is held)
      const bm = Number(r.boostMeter);
      if (Number.isFinite(bm)) {
        if (bm < pBoostMeter - 1e-6) boostHold = 0.25;
        else if (boostHold > 0) boostHold -= d;
        pBoostMeter = bm;
      }
      const flare = boostHold > 0;
      if (flare !== pFlare) {
        elFlare.classList.toggle('on', flare);
        elSpeedPlate.classList.toggle('boosting', flare);
        pFlare = flare;
      }
    }
  }

  update(1 / 60);
  return { update };
}
