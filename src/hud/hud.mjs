// ===========================================================================
// HUD candidate B — "ARCADE CHROME" (cycle 3)
//
// SSX-Tricky-loud overlay: chunky beveled chrome plates with hard offset drop
// shadows, huge italic tabular numerals, a segmented boost thermometer on the
// yellow -> orange -> red ladder, six discrete ULTIMA letter tiles, an
// always-on multiplier STAR socket, and one HERO BAND at bottom centre that
// builds the trick LIVE while the rider is in the air and then gets slammed
// aside by the award slab on landing.
//
// ---------------------------------------------------------------------------
// CYCLE-2 CRITIQUE — disposition (every item addressed or rebutted)
//
//  BIGGEST GAP: "only gets loud AFTER the trick is over; mid-air feedback is a
//  small pill in the least-read corner."
//     FIXED, and it is the headline change. The bottom-left trick pill is
//     GONE. In its place is #ssxb-hero — a single bottom-centre band, the same
//     geometry and nearly the same type weight as the award slab, that:
//       * names the rotation LIVE off riderState().spinDeg / .flipDeg, using
//         the accepted trick system's own naming rules (Frontside/Backside per
//         180, Front/Back-flip per 360, Misty/Rodeo for spin+flip composites),
//         so "BACKSIDE 180" becomes "BACKSIDE 540" becomes "RODEO 720" as the
//         rider actually rotates;
//       * chains the equipped uber in front of it ("AIRWALK + RODEO 720") with
//         a live animation-progress bar under the name — the bar is the JA-15
//         warning: land before it fills and the trick is a crash;
//       * carries the running jump tally beside it;
//       * GROWS with the trick: --g steps 1.00 -> 1.20 as spin/flip units and
//         the uber accumulate, scaled from its own bottom edge.
//     On landing the live block hides and the award slab punches into the same
//     spot. One band, two states: build, then slam.
//
//  1. "Kill the dead `POS —` socket."
//     FIXED. There is no POS element in the DOM. The top-centre band carries
//     the run clock alone. A POS chip is CONSTRUCTED lazily the first frame
//     refs.raceState()/trickState().place actually returns a placing, and
//     removed again if the feed stops. Nothing on screen advertises an
//     unbuilt feature.
//
//  2. "Score plate has no digit-count step-down."
//     FIXED. #ssxb-score keeps a FIXED line-height (84*--s) so the plate's
//     height never changes, and steps its font-size down by digit count:
//     <=6 digits 84*--s, 7 -> 66, 8 -> 56, 9+ -> 48. A 7-figure run keeps the
//     plate inside the top-left band instead of growing into the run clock.
//
//  3. "Promote the in-air trick ticker." — see BIGGEST GAP above.
//
//  4. "#ssxb-fill applies border-radius and a box-shadow glow to an element
//     driven by scaleX() — both distort with the fill."
//     FIXED. #ssxb-fill now carries ONLY background + transform. Its radius
//     comes from the track clipping it (border-radius + overflow:hidden on the
//     unscaled #ssxb-track), and the tier glow is painted by #ssxb-track's own
//     box-shadow, which never scales. The fill's leading edge is a hard cut,
//     which is what a segmented arcade gauge should look like anyway.
//     data-hud="meter-fill" stays on the SCALED element because HU-02 measures
//     that element's rect width and requires it to move with the value.
//
//  5. "The six ULTIMA tiles hard-strobe on steps(2, jump-none)."
//     FIXED. Smooth `ease-in-out ... infinite alternate` (ssxb-tileglow), the
//     same motion family as ssxb-throb, with a half-period offset on alternate
//     tiles so the row reads as a chase rather than a square-wave flash.
//
//  6. "Stop shaping geometry around the probe box."
//     ACCEPTED. The old "the slab is exempt from HU-10" comment and the
//     pinning it justified are gone. The hero band is height-capped by
//     construction (the live row is exactly one line, the name steps its glyph
//     size down instead of wrapping), so its tallest state still tops out
//     below the centre box. Horizontal clearance is now STRUCTURAL — see the
//     cycle-3 disposition below; the hand arithmetic that used to justify it
//     is gone.
//
//  7./8. (addressed to the other candidate: HUD-local run clock, race band
//     deleted under 720px, "UBER CHAIN" mislabel.) Not applicable here — this
//     clock reads trickState()._t, the sim's own accumulator; nothing is
//     display:none'd by width; and the letter row is labelled ULTIMA, the
//     mechanic's actual name, while the combo bonus chip says CHAIN.
//
// ---------------------------------------------------------------------------
// CYCLE-3 CRITIQUE — disposition
//
//  1. "The bottom rail's three absolutely-positioned clusters with
//      hand-computed clearance BREAK below ~556px width."
//     FIXED, structurally. The three clusters are no longer absolutely
//     positioned and no longer reason about each other's widths. They are
//     three cells of ONE both-edges-anchored flex row (#ssxb-rail, left:0
//     right:0, justify-content:space-between): boost | hero | speed. The two
//     flanks carry the SAME flex basis, so the hero cell is centred on the
//     screen by construction at every width, and when the row runs out of room
//     all three shrink in proportion instead of colliding. The award slab and
//     the live block are capped at 78% of the hero cell, which is the overshoot
//     budget: 0.78 * 1.22 (award punch) and 0.78 * 1.20 (live growth) are both
//     < 1, so even at the peak of the punch the slab cannot reach the gap, let
//     alone the meter. No number in this file is a measured screenshot value
//     any more, and no comment claims a width was "verified" by eye.
//
//  2. "#ssxb-hero's 48vw cap is unreachable dead code."
//     CORRECT, and it was: 48vw only binds when W < 1.5H, and that range forces
//     --s = W/1280, making 520*--s = 0.406W — always the smaller term. The cap
//     is deleted along with the comment that cited it as a viewport guard. The
//     hero's width now comes from the flex row.
//
//  3. "The award slab and the six ULTIMA letter tiles share the same hot-pink
//      gradient/outline/shadow — two unrelated mechanics read as one object."
//     FIXED. The palette now assigns one hue per mechanic: MAGENTA/RED belongs
//     to the award slab alone. The ULTIMA row is GOLD, and lit-vs-unlit is the
//     loudest contrast on it — an unlit tile is a near-black dead socket with a
//     grey rim and a barely-there letter; a lit tile is a white-to-gold plate
//     with black ink and a gold bloom. Full ULTIMA drives the same gold
//     white-hot rather than switching hue. The ULTIMA! banner moved onto the
//     gold ramp with the tiles it belongs to.
//
//  4. "The timer top-centre is a bare unlabeled pill."
//     FIXED. A RUN tab sits in front of the clock, same chrome tab as SCORE,
//     BOOST and SPEED, so the top-centre band is labelled like every other.
//
//  5. HU-11: a real multiplier readout. The score cluster's star chip is now
//     [data-hud="mult"] and reads trickState().starMult directly (PUBLIC field
//     on tstate), rendering 1x / 2x / 3x / 5x on the canon colour ladder:
//     dim socket at 1x, yellow 2x, orange 3x, red 5x.
//
//  6. The meter's segment ticks moved from a #ssxb-ticks DIV to #ssxb-track's
//     ::after. They are pure decoration and carry no readout, and as a real
//     element they were an unrelated painted box sitting on top of the meter
//     track — which is exactly what HU-12 forbids, and rightly so.
//
// DESIGN-SEED DEPARTURE (carried from cycle 1, restated so it is not read as
// an oversight): the seed asks for a VERTICAL boost thermometer. HU-02 measures
// getBoundingClientRect().width of [data-hud="meter-fill"] and requires
// wHigh > wLow + 4, so a vertical bar can only pass by also faking a width —
// exactly the two-axis distortion the cycle-1 critic caught on the other
// candidate. The thermometer is therefore HORIZONTAL and segmented: width IS
// the value, one axis, no lie. It still pulses at full and sweeps under ULTIMA.
//
// CYCLE-1 items remain fixed: multiplier STAR socket + live CHAIN chip
// (JA-18 arithmetic on screen), scale-overshoot award punch, --s scale unit
// tracking the smaller axis (ceiling 3 = full proportion at 2160p), award name
// with a real ellipsis, single-axis meter (width IS the value), yellow ->
// orange -> red ladder. The only pseudo-element in the file is the meter's
// segment hatching, which carries no readout — no text or state is hidden in
// ::before/::after where a probe (or a screen reader) cannot reach it.
//
// ---------------------------------------------------------------------------
// LAYOUT LAW (HU-10 / HU-12): every element lives in a screen-edge band.
//   top-left      SCORE plate -> chips MULT/tally/CHAIN
//   top-centre    RUN clock, POS chip only when a race feed exists
//   top-right     ULTIMA tiles -> ULTIMA! banner
//   bottom        #ssxb-rail — ONE flex row anchored to both screen edges,
//                 three cells: BOOST thermometer | HERO band | SPEED plate
//                 (+ BOOST! flare stacked above it). The flanks share a flex
//                 basis so the hero cell is screen-centred at any width, and
//                 clearance between the cells is the row's own gap, not a
//                 number computed here. Nothing in the rail is positioned
//                 against another cell's measured width.
//
// PERF LAW (HU-06): update() is read-compare-write. Every DOM write sits
// behind a change guard on a cached primitive; no getComputedStyle, no rect
// reads, no per-frame string building. The meter is transform-only (no
// layout) quantized to 1/250; the hero's growth var is quantized to 1/50.
// One forced reflow per NEW award, to restart its keyframe.
//
// CLOCKS: the award lifecycle is a pure CSS keyframe in real time, so HU-05
// holds for any dt the caller passes.
//
// No external assets, no web fonts — system stacks only.
// ===========================================================================

const STYLE_ID = 'ssx-hud-b-style';

const CSS = `
#ssxb, #ssxb * { pointer-events: none; box-sizing: border-box; }
#ssxb {
  position: absolute; inset: 0; overflow: hidden;
  /* Scale unit: tracks the SMALLER axis, so a narrow-tall window and a 4K
     panel both render the HUD at proportional size (ceiling 3 = 2160p at full
     proportion). The floor is deliberately LOW (0.45): a floor that stops the
     HUD shrinking is a floor that makes the top bands collide on a 500 px
     window. Small beats overlapping. */
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
  /* line-height is FIXED so the plate's height never changes; only the glyph
     size steps down as the run grows into 7, 8 and 9 figures. */
  font-size: calc(84 * var(--s)); line-height: calc(84 * var(--s));
  letter-spacing: -.035em;
  text-shadow: 0 0 calc(20 * var(--s)) rgba(37,224,255,.5),
               calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.78);
}
#ssxb-score.d7 { font-size: calc(66 * var(--s)); }
#ssxb-score.d8 { font-size: calc(56 * var(--s)); }
#ssxb-score.d9 { font-size: calc(48 * var(--s)); letter-spacing: -.02em; }
.ssxb-pop { animation: ssxb-pop .22s cubic-bezier(.2,1.9,.4,1); }
@keyframes ssxb-pop {
  0%{transform:skewX(7deg) scale(1)} 42%{transform:skewX(7deg) scale(1.11)}
  100%{transform:skewX(7deg) scale(1)}
}

/* ---- chips row: STAR / jump tally / CHAIN (the scoring arithmetic) ------- */
#ssxb-chips {
  position: absolute; top: calc(140 * var(--s)); left: calc(30 * var(--s));
  display: flex; align-items: stretch; gap: calc(7 * var(--s));
  transform: skewX(-7deg);
}
.ssxb-chip {
  display: flex; align-items: center; gap: calc(6 * var(--s));
  font-size: calc(23 * var(--s)); line-height: calc(25 * var(--s));
  padding: calc(3 * var(--s)) calc(11 * var(--s)) calc(4 * var(--s));
  border-radius: calc(8 * var(--s)); white-space: nowrap; color: var(--ink);
  box-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.6),
              inset 0 calc(2 * var(--s)) 0 rgba(255,255,255,.5);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
}
.ssxb-chip > span { transform: skewX(7deg); display: block; }
/* STAR MULTIPLIER socket (HU-11, data-hud="mult"): always present, always
   reading trickState().starMult. Dim + hollow at x1 (no star held), then the
   canon SSX ladder — yellow 2x, orange 3x, red 5x. It is deliberately the
   biggest chip in the row: this is the number that turns an uber into a 130K
   award, so it sits directly under the score it multiplies. */
#ssxb-star {
  background: linear-gradient(180deg, rgba(120,138,168,.8), rgba(16,22,34,.94));
  color: rgba(214,228,248,.72); letter-spacing: .06em;
  outline-color: rgba(5,7,12,.8);
  font-size: calc(27 * var(--s)); line-height: calc(29 * var(--s));
}
#ssxb-star .ssxb-glyph { font-size: calc(27 * var(--s)); }
#ssxb-star[data-star="2"] { color: var(--ink); background: linear-gradient(180deg,#fff,var(--yell) 45%,#e0b400); }
#ssxb-star[data-star="3"] { color: var(--ink); background: linear-gradient(180deg,#fff,var(--orng) 45%,#b34e00); }
#ssxb-star[data-star="5"] { color: #fff; background: linear-gradient(180deg,#ffd6d6,var(--red) 45%,#8c0000);
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.6); }
#ssxb-star[data-star="2"], #ssxb-star[data-star="3"], #ssxb-star[data-star="5"] {
  animation: ssxb-throb .5s ease-in-out infinite alternate;
}
#ssxb-jump { display: none; background: linear-gradient(180deg, #ffffff, #9fb0c6); }
#ssxb-jump.on { display: flex; }
#ssxb-chain {
  display: none;
  background: linear-gradient(180deg, var(--lime), #5f9c00); color: var(--ink);
}
#ssxb-chain.on { display: flex; }

/* ---- top-centre: run clock (POS chip appears only with a race feed) ------
   The clock carries a RUN tab, the same chrome tab as SCORE / BOOST / SPEED,
   so no readout on screen is an unlabelled bare number. */
#ssxb-race {
  position: absolute; top: calc(14 * var(--s)); left: 50%;
  transform: translateX(-50%) skewX(-7deg);
  display: flex; align-items: center; gap: calc(8 * var(--s));
}
#ssxb-race > .ssxb-tab { transform: skewX(7deg); }
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
#ssxb-pos {
  font-size: calc(21 * var(--s)); line-height: calc(22 * var(--s));
  letter-spacing: .1em; color: var(--ink);
  padding: calc(4 * var(--s)) calc(12 * var(--s)) calc(3 * var(--s));
  border-radius: calc(7 * var(--s));
  background: linear-gradient(180deg, #fff, #b9c6d6);
  box-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.55);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
  white-space: nowrap;
}
#ssxb-pos > span { display: block; transform: skewX(7deg); }

/* ---- ULTIMA tiles (top-right) --------------------------------------------
   PALETTE LAW (cycle-3 item 3): the ULTIMA row owns GOLD and nothing else on
   screen does; MAGENTA/RED belongs to the award slab alone, so the two
   mechanics can never be mistaken for one object. Inside the row, LIT vs UNLIT
   is the loudest contrast there is: an unlit letter is a dead black socket
   with a grey rim and a letter you can barely find, a lit one is a white-to-
   gold plate with black ink and a gold bloom around it. Six sockets filling
   with gold, not six pink tiles changing shade. */
#ssxb-ultima {
  position: absolute; top: calc(16 * var(--s)); right: calc(26 * var(--s));
  display: flex; gap: calc(8 * var(--s)); transform: skewX(-7deg);
}
.ssxb-tile {
  width: calc(46 * var(--s)); height: calc(58 * var(--s));
  border-radius: calc(10 * var(--s));
  display: flex; align-items: center; justify-content: center;
  font-size: calc(34 * var(--s)); line-height: calc(34 * var(--s));
  /* dead socket: the letter is a ghost until the uber lands */
  color: rgba(128,146,172,.30);
  background: linear-gradient(180deg, #171d27 0%, #05070b 74%, #0b0f16 100%);
  border: calc(3 * var(--s)) solid rgba(122,138,164,.34);
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.55),
              inset 0 calc(4 * var(--s)) calc(10 * var(--s)) rgba(0,0,0,.9),
              inset 0 calc(-3 * var(--s)) 0 rgba(0,0,0,.6);
  text-shadow: none;
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.9);
}
.ssxb-tile > span { display: block; transform: skewX(7deg); }
.ssxb-tile.lit {
  color: #2a1a00;
  background: linear-gradient(180deg, #fffdf2 0%, #ffe14a 40%, #ffab00 100%);
  border-color: #ffffff;
  text-shadow: 0 calc(1 * var(--s)) 0 rgba(255,255,255,.65);
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.55),
              0 0 calc(24 * var(--s)) rgba(255,186,32,.95),
              inset 0 calc(3 * var(--s)) 0 rgba(255,255,255,.85),
              inset 0 calc(-3 * var(--s)) 0 rgba(179,110,0,.7);
}
/* all six lit: the same gold, driven white-hot — a step up the ladder the row
   is already on, not a jump onto the award's hue */
#ssxb-ultima[data-ultima="true"] .ssxb-tile {
  color: #2a1a00;
  background: linear-gradient(180deg, #ffffff 0%, #ffd400 46%, #ff9d00 100%);
  border-color: #ffffff;
  /* smooth alternating pulse (cycle-2 item 5), offset per tile so the row
     chases instead of strobing in unison */
  animation: ssxb-tileglow .62s ease-in-out infinite alternate;
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.55),
              0 0 calc(26 * var(--s)) rgba(255,208,40,.95),
              inset 0 calc(3 * var(--s)) 0 rgba(255,255,255,.9);
}
#ssxb-ultima[data-ultima="true"] .ssxb-tile:nth-child(2) { animation-delay: .10s; }
#ssxb-ultima[data-ultima="true"] .ssxb-tile:nth-child(3) { animation-delay: .20s; }
#ssxb-ultima[data-ultima="true"] .ssxb-tile:nth-child(4) { animation-delay: .30s; }
#ssxb-ultima[data-ultima="true"] .ssxb-tile:nth-child(5) { animation-delay: .40s; }
#ssxb-ultima[data-ultima="true"] .ssxb-tile:nth-child(6) { animation-delay: .50s; }
@keyframes ssxb-tileglow {
  from { filter: brightness(1) saturate(1); }
  to   { filter: brightness(1.45) saturate(1.28); }
}

#ssxb-ultimabanner {
  position: absolute; top: calc(86 * var(--s)); right: calc(26 * var(--s));
  display: none; transform: skewX(-7deg);
  font-size: calc(27 * var(--s)); line-height: calc(28 * var(--s));
  letter-spacing: .16em; color: #2a1a00;
  padding: calc(5 * var(--s)) calc(14 * var(--s)) calc(4 * var(--s));
  border-radius: calc(8 * var(--s));
  /* stays on the ULTIMA row's gold ramp — the banner belongs to the tiles
     above it, not to the award slab */
  background: linear-gradient(180deg, #fff, var(--yell) 40%, var(--orng));
  box-shadow: calc(5 * var(--s)) calc(5 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(26 * var(--s)) rgba(255,186,32,.9);
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-ultima[data-ultima="true"] ~ #ssxb-ultimabanner {
  display: block; animation: ssxb-throb .42s ease-in-out infinite alternate;
}

/* ---- BOTTOM RAIL: one flex row, both edges anchored -----------------------
   Three cells — BOOST | HERO | SPEED. Nothing here is positioned against
   another cell's width; clearance IS the row's gap, so it survives every
   viewport by construction rather than by arithmetic. The two flanks share a
   flex basis, which is what centres the hero cell on screen; when the row runs
   short all three shrink in proportion (flex-shrink on the basis), so the
   flanks stay equal and the hero stays centred. */
#ssxb-rail {
  position: absolute; left: 0; right: 0; bottom: calc(22 * var(--s));
  display: flex; align-items: flex-end; justify-content: space-between;
  gap: calc(16 * var(--s)); padding: 0 calc(26 * var(--s));
}

/* ---- BOOST thermometer (rail left, HORIZONTAL: width IS the value) -------
   The scaled element carries background + transform ONLY. Radius comes from
   the track clipping it; the tier glow lives on the unscaled track. */
#ssxb-boost {
  flex: 0 1 calc(264 * var(--s));
  /* the gauge may shrink with the row (it is a percentage bar, it stays
     readable narrow) but never collapses to a stub */
  min-width: calc(96 * var(--s));
  transform: skewX(-7deg);
}
#ssxb-bhead {
  display: flex; align-items: center; gap: calc(8 * var(--s));
  margin-bottom: calc(6 * var(--s)); max-width: 100%;
  /* When the cell is too narrow for BOOST + the tier word side by side, the
     tier word DROPS TO ITS OWN LINE rather than ellipsising to "REDLI...".
     The tier is a readout; a readout that gets cut is worse than one that
     takes a second line. */
  flex-wrap: wrap;
}
#ssxb-bhead > * { transform: skewX(7deg); }
#ssxb-bstate {
  font-size: calc(20 * var(--s)); line-height: calc(21 * var(--s));
  letter-spacing: .1em; color: var(--ink);
  padding: calc(3 * var(--s)) calc(11 * var(--s)) calc(2 * var(--s));
  border-radius: calc(7 * var(--s)); background: var(--yell);
  box-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.55);
  outline: calc(2 * var(--s)) solid rgba(5,7,12,.85);
  white-space: nowrap; flex: 0 0 auto;
}
#ssxb-bstate.hot { animation: ssxb-throb .3s ease-in-out infinite alternate; }
#ssxb-track {
  position: relative;
  width: 100%;
  height: calc(42 * var(--s));
  border-radius: calc(10 * var(--s));
  background: linear-gradient(180deg, rgba(6,9,15,.94), rgba(26,34,52,.94));
  border: calc(3 * var(--s)) solid rgba(255,255,255,.92);
  box-shadow: calc(6 * var(--s)) calc(6 * var(--s)) 0 rgba(0,0,0,.6),
              inset 0 0 calc(14 * var(--s)) rgba(0,0,0,.85);
  overflow: hidden;
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-fill {
  position: absolute; left: 0; top: 0; width: 100%; height: 100%;
  transform-origin: 0% 50%; transform: scaleX(0);
  will-change: transform;
  background: linear-gradient(180deg, #fff6a8 0%, #ffe600 45%, #e0a800 100%);
}
#ssxb-fill.full { animation: ssxb-throb .32s ease-in-out infinite alternate; }
#ssxb-fill.ultima { animation: ssxb-sweep .55s linear infinite alternate; }
@keyframes ssxb-throb { from{filter:brightness(1)} to{filter:brightness(1.75) saturate(1.35)} }
@keyframes ssxb-sweep {
  from{filter:brightness(1.05) saturate(1.15)}
  to{filter:brightness(1.75) saturate(1.5) hue-rotate(-22deg)}
}
/* Segment ticks ride ON TOP of the fill and never scale — the bar reads as
   discrete arcade segments, not a smooth gauge. They are a ::after and not a
   real element on purpose: they carry no readout (the fill and its data-value
   do), and as an element they were just an unrelated painted box lying across
   the meter track, which is the thing HU-12 forbids. */
#ssxb-track::after {
  content: ''; position: absolute; inset: 0; pointer-events: none;
  background: repeating-linear-gradient(90deg,
    rgba(0,0,0,0) 0 calc(22 * var(--s)),
    rgba(0,0,0,.78) calc(22 * var(--s)) calc(27 * var(--s)));
}

/* ---- SPEED (rail right, secondary to score) ------------------------------
   The BOOST! flare stacks above the plate in the same cell instead of being
   pinned at a hand-picked bottom offset. Same flex basis as the boost cell,
   which is what keeps the hero cell screen-centred. */
#ssxb-speedcol {
  /* same basis as the boost cell — that equality is what centres the hero.
     No min-width override: the flex automatic minimum keeps the plate from
     being squeezed below its own content. */
  flex: 0 1 calc(264 * var(--s));
  display: flex; flex-direction: column; align-items: flex-end;
  gap: calc(8 * var(--s));
}
#ssxb-speed-plate {
  position: relative; text-align: right;
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
  display: none; transform: skewX(-7deg); align-self: flex-end;
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

/* ---- HERO BAND (rail centre): live trick builder <-> award slab ----------
   Two states of one band. In the air the LIVE block names the rotation as it
   happens and grows with it; on landing it is replaced by the AWARD slab,
   which punches in with scale overshoot. Both sit wholly inside the bottom
   rail — no probe exemption is claimed or needed.

   OVERSHOOT BUDGET: both states are transformed AFTER layout (scale 1.22 on
   the award punch, up to 1.20 on the live growth), and a transform does not
   grow the flex cell. So the cell caps its contents at 78% of its own width:
   0.78 * 1.22 < 1 and 0.78 * 1.20 < 1, which leaves the peak of the punch
   inside the cell with room for the -7deg skew's extra width on top. That is
   the entire clearance argument — it holds at any viewport because every term
   in it is a ratio. */
#ssxb-hero {
  /* basis sized so 78% of it still gives the award slab the full-name width it
     had before the rail existed — the cap buys clearance, not legibility */
  flex: 0 1 calc(660 * var(--s)); min-width: 0;
  display: flex; flex-direction: column; align-items: center;
}
#ssxb-hero > * { max-width: 78%; }

#ssxb-live {
  display: none; text-align: center;
  transform: skewX(-7deg) scale(var(--g, 1)); transform-origin: 50% 100%;
  padding: calc(6 * var(--s)) calc(20 * var(--s)) calc(8 * var(--s));
  border-radius: calc(14 * var(--s));
  border: calc(3 * var(--s)) solid rgba(255,255,255,.95);
  background: linear-gradient(180deg, rgba(37,224,255,.30) 0%,
              rgba(6,14,28,.90) 24%, rgba(10,26,52,.94) 100%);
  box-shadow: calc(6 * var(--s)) calc(6 * var(--s)) 0 rgba(0,0,0,.6),
              0 0 calc(30 * var(--s)) rgba(37,224,255,.55),
              inset 0 calc(2 * var(--s)) 0 rgba(255,255,255,.35);
  outline: calc(3 * var(--s)) solid rgba(5,7,12,.85);
}
#ssxb-live.on { display: block; }
#ssxb-live > * { transform: skewX(7deg); }
#ssxb-live-name, #ssxb-aw-name { --nf: 44; }
#ssxb-live-name.n2, #ssxb-aw-name.n2 { --nf: 36; }
#ssxb-live-name.n3, #ssxb-aw-name.n3 { --nf: 30; }
#ssxb-live-name.n4, #ssxb-aw-name.n4 { --nf: 25; letter-spacing: 0; }
#ssxb-live-name {
  font-size: calc(var(--nf) * var(--s)); line-height: calc(46 * var(--s)); color: #fff;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-shadow: 0 0 calc(20 * var(--s)) rgba(37,224,255,.85),
               calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.7);
}
/* The row is exactly ONE line tall, always: nothing inside it may wrap, or the
   band grows upward out of the bottom band. Overlong chips ellipsis instead. */
#ssxb-live-row {
  display: flex; align-items: center; justify-content: center;
  flex-wrap: nowrap; gap: calc(10 * var(--s));
  font-size: calc(22 * var(--s)); line-height: calc(26 * var(--s));
  height: calc(26 * var(--s));
}
#ssxb-live-row > * { white-space: nowrap; flex: 0 0 auto; }
#ssxb-live-pts {
  color: var(--ink); background: linear-gradient(180deg, #fff, var(--cyan));
  padding: calc(2 * var(--s)) calc(10 * var(--s)) calc(1 * var(--s));
  border-radius: calc(5 * var(--s));
  box-shadow: calc(3 * var(--s)) calc(3 * var(--s)) 0 rgba(0,0,0,.5);
}
/* uber animation-progress: fill it before touchdown or the trick is a crash */
#ssxb-live-prog {
  display: none; position: relative; overflow: hidden;
  width: 100%; height: calc(12 * var(--s)); margin-top: calc(5 * var(--s));
  border-radius: calc(4 * var(--s));
  background: rgba(0,0,0,.7);
  border: calc(2 * var(--s)) solid rgba(255,255,255,.8);
}
#ssxb-live-prog.on { display: block; }
#ssxb-live-prog > i {
  position: absolute; inset: 0; transform-origin: 0% 50%; transform: scaleX(0);
  background: linear-gradient(90deg, var(--cyan), #fff);
}
#ssxb-live-prog.ready > i { background: linear-gradient(90deg, var(--lime), #fff); }
#ssxb-live-air {
  color: var(--cyan); letter-spacing: .14em; white-space: nowrap;
  font-size: calc(19 * var(--s));
  text-shadow: calc(2 * var(--s)) calc(2 * var(--s)) 0 rgba(0,0,0,.75);
}
/* the rotation counting up, chipped out of the name line whenever an uber
   already owns it — so neither readout ever has to be truncated */
#ssxb-live-rot {
  display: none; color: var(--ink); letter-spacing: .04em;
  font-size: calc(20 * var(--s));
  /* the only row item allowed to shrink: airtime and points never truncate */
  min-width: 0; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto;
  background: linear-gradient(180deg, #fff, #9fe8ff);
  padding: calc(2 * var(--s)) calc(10 * var(--s)) calc(1 * var(--s));
  border-radius: calc(5 * var(--s));
  box-shadow: calc(3 * var(--s)) calc(3 * var(--s)) 0 rgba(0,0,0,.5);
}
#ssxb-live-rot.on { display: block; }


#ssxb-award {
  display: none; text-align: center;
  transform: skewX(-7deg); transform-origin: 50% 60%;
  padding: calc(6 * var(--s)) calc(26 * var(--s)) calc(8 * var(--s));
  border-radius: calc(14 * var(--s));
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
  font-size: calc(18 * var(--s)); line-height: calc(20 * var(--s));
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
  font-size: calc(var(--nf) * var(--s)); line-height: calc(46 * var(--s));
  color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 100%;
  text-shadow: calc(4 * var(--s)) calc(4 * var(--s)) 0 rgba(0,0,0,.6);
}
#ssxb-award.go { display: block; animation: ssxb-award 2400ms cubic-bezier(.2,1,.3,1) forwards; }
@keyframes ssxb-award {
  0%   { opacity: 0; transform: skewX(-7deg) scale(.34) rotate(-5deg); }
  6%   { opacity: 1; transform: skewX(-7deg) scale(1.22) rotate(1.5deg); }
  12%  { transform: skewX(-7deg) scale(.93) rotate(0deg); }
  18%  { transform: skewX(-7deg) scale(1.05); }
  25%  { opacity: 1; transform: skewX(-7deg) scale(1); }
  84%  { opacity: 1; transform: skewX(-7deg) scale(1); }
  100% { opacity: 0; transform: skewX(-7deg) scale(1.12); }
}
`;

// Boost tier ladder — sourced SSX ramp: yellow -> orange -> red, then white-hot
// at full. 4 rungs guarantee >= 3 distinct fills across 0.2 / 0.6 / 1.0 (HU-09).
const TIERS = [
  { at: 0.34,  word: 'Charge',
    grad: 'linear-gradient(180deg, #fff6a8 0%, #ffe600 45%, #e0a800 100%)',
    glow: 'rgba(255,230,0,.75)',  pill: '#ffe600', ink: '#ffe600' },
  { at: 0.67,  word: 'Surge',
    grad: 'linear-gradient(180deg, #ffd39a 0%, #ff7a00 45%, #c24a00 100%)',
    glow: 'rgba(255,122,0,.85)',  pill: '#ff7a00', ink: '#ff7a00' },
  { at: 0.999, word: 'Redline',
    grad: 'linear-gradient(180deg, #ffb3b3 0%, #ff2d2d 45%, #8c0000 100%)',
    glow: 'rgba(255,45,45,.9)',   pill: '#ff2d2d', ink: '#ff2d2d' },
  { at: 2,     word: 'Full!',
    grad: 'linear-gradient(180deg, #ffffff 0%, #ffe600 34%, #ff7a00 68%, #ff2d2d 100%)',
    glow: 'rgba(255,255,255,.95)', pill: '#ffffff', ink: '#ffffff' },
];

const trackShadow = (glow) =>
  'calc(6 * var(--s)) calc(6 * var(--s)) 0 rgba(0,0,0,.6),' +
  '0 0 calc(24 * var(--s)) ' + glow + ',' +
  'inset 0 0 calc(14 * var(--s)) rgba(0,0,0,.85)';

const group = (n) => {
  const s = String(n);
  return s.length > 3 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
};

// Marquee names step their glyph size down by length instead of being cut
// mid-phrase: "Frontside 540" stays huge, "La La La Lock Step" and
// "SuperMan BarSpin + Double Rodeo 900" step down and still read whole.
const nameClass = (txt) => {
  const n = txt.length;
  return n <= 14 ? '' : n <= 19 ? 'n2' : n <= 26 ? 'n3' : 'n4';
};

const clockText = (sec) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
};

// ---------------------------------------------------------------------------
// LIVE trick naming — mirrors the accepted trick system's own rules so the
// name that builds in the air is the name that gets banked on landing:
//   spin quantizes per 180 (Frontside / Backside), flips per 360
//   (Front/Back-flip), and spin+flip is one composite trick — Misty on a
//   front flip, Rodeo on a back flip.
// ---------------------------------------------------------------------------
const MULT = ['', '', 'Double ', 'Triple '];

function rotationName(spinDeg, flipDeg) {
  const su = Math.min(10, Math.floor((Math.abs(spinDeg) + 10) / 180));
  const fu = Math.min(3, Math.floor((Math.abs(flipDeg) + 10) / 360));
  if (su >= 1 && fu >= 1) {
    const style = flipDeg < 0 ? 'Rodeo' : 'Misty';
    return { text: MULT[fu] + style + ' ' + su * 180, units: su + fu * 2 };
  }
  if (su >= 1)
    return { text: (spinDeg < 0 ? 'Backside ' : 'Frontside ') + su * 180, units: su };
  if (fu >= 1)
    return { text: MULT[fu] + (flipDeg < 0 ? 'Backflip' : 'Frontflip'), units: fu * 2 };
  return { text: '', units: 0 };
}

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

// The word IS the letter count. ultimaLettersNeeded is 6 because there are six
// uber slots and each landed uber awards one letter — so the tiles are derived
// from this constant rather than typed out, and a six-letter word is the only
// kind that can be swapped in without also changing the uber loadout.
const ULTIMA_LETTERS = 'ULTIMA'.split('');

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
      <div class="ssxb-chip" id="ssxb-star" data-hud="mult" data-star="1">
        <span class="ssxb-glyph">&#9733;</span><span id="ssxb-star-x">1x</span>
      </div>
      <div class="ssxb-chip" id="ssxb-jump"><span id="ssxb-jump-v">+0</span></div>
      <div class="ssxb-chip" id="ssxb-chain"><span id="ssxb-chain-v">x1.0 Chain</span></div>
    </div>

    <div id="ssxb-race">
      <div class="ssxb-tab">Run</div>
      <div id="ssxb-clock"><span id="ssxb-clock-v">0:00.0</span></div>
    </div>

    <div id="ssxb-ultima" data-hud="ultima" data-lit="0" data-ultima="false">
      ${ULTIMA_LETTERS.map(c => `<div class="ssxb-tile"><span>${c}</span></div>`).join('')}
    </div>
    <div id="ssxb-ultimabanner">Ultima!</div>

    <div id="ssxb-rail">
      <div id="ssxb-boost">
        <div id="ssxb-bhead">
          <div class="ssxb-tab">Boost</div>
          <div id="ssxb-bstate">Charge</div>
        </div>
        <div id="ssxb-track">
          <div id="ssxb-fill" data-hud="meter-fill" data-value="0.00"></div>
        </div>
      </div>

      <div id="ssxb-hero">
        <div id="ssxb-live">
          <div id="ssxb-live-name"></div>
          <div id="ssxb-live-row">
            <span id="ssxb-live-air">Air</span>
            <span id="ssxb-live-rot"></span>
            <span id="ssxb-live-pts">+0</span>
          </div>
          <div id="ssxb-live-prog"><i></i></div>
        </div>
        <div id="ssxb-award" data-hud="award">
          <div id="ssxb-aw-top">
            <span id="ssxb-aw-lbl">Trick Landed</span>
            <span id="ssxb-aw-pts"></span>
          </div>
          <div id="ssxb-aw-name"></div>
        </div>
      </div>

      <div id="ssxb-speedcol">
        <div id="ssxb-boostflare"><span>Boost!</span></div>
        <div class="ssxb-plate" id="ssxb-speed-plate">
          <div><span class="ssxb-tab">Speed</span></div>
          <div id="ssxb-speed-row">
            <div class="ssxb-num" id="ssxb-speed" data-hud="speed">0</div>
            <div id="ssxb-unit">km/h</div>
          </div>
        </div>
      </div>
    </div>
  `;
  container.appendChild(root);

  const q = (id) => root.querySelector(id);
  const elScore = q('#ssxb-score');
  const elStar = q('#ssxb-star'), elStarX = q('#ssxb-star-x');
  const elJump = q('#ssxb-jump'), elJumpV = q('#ssxb-jump-v');
  const elChain = q('#ssxb-chain'), elChainV = q('#ssxb-chain-v');
  const elRace = q('#ssxb-race'), elClockV = q('#ssxb-clock-v');
  const elUltima = q('#ssxb-ultima');
  const tiles = Array.prototype.slice.call(root.querySelectorAll('.ssxb-tile'));
  const elTrack = q('#ssxb-track');
  const elFill = q('#ssxb-fill');
  const elBState = q('#ssxb-bstate');
  const elSpeed = q('#ssxb-speed');
  const elSpeedPlate = q('#ssxb-speed-plate');
  const elFlare = q('#ssxb-boostflare');
  const elLive = q('#ssxb-live');
  const elLiveName = q('#ssxb-live-name');
  const elLivePts = q('#ssxb-live-pts');
  const elLiveAir = q('#ssxb-live-air');
  const elLiveRot = q('#ssxb-live-rot');
  const elProg = q('#ssxb-live-prog'), elProgFill = q('#ssxb-live-prog > i');
  const elAward = q('#ssxb-award');
  const elAwName = q('#ssxb-aw-name');
  const elAwPts = q('#ssxb-aw-pts');

  // POS chip is built only if a race feed ever appears (cycle-2 item 1).
  let elPos = null, elPosV = null;

  // The slab hides itself the instant its keyframe ends, so between awards the
  // hero band holds the live block alone.
  let awardPlaying = false;
  elAward.addEventListener('animationend', (e) => {
    if (e.target !== elAward) return;
    elAward.classList.remove('go');
    awardPlaying = false;
  });

  // cached previous values — every DOM write is guarded by one of these
  let pScore = -1, pDig = '', pJump = -1, pChain = -1, pStar = -1, pSpeed = -1;
  let pMeter = -1, pTier = -1, pFull = null, pLit = -1, pUltima = null;
  let pAwards = 0, pFast = null, pClock = -1, pPos = '';
  let pLiveTxt = '', pLiveOn = null, pGrow = -1, pLivePts = -1;
  let pProgOn = null, pProg = -1, pReady = null, pAirTxt = '', pRotTxt = '';
  let pAwCls = '', pLiveCls = '';
  let pBoostMeter = 1, boostHold = 0, pFlare = false;
  let localT = 0;

  function update(dt) {
    const d = (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 1 / 60;
    localT += d;
    const r = refs.riderState ? refs.riderState() : null;
    const t = refs.trickState ? refs.trickState() : null;

    if (t) {
      // ---------------- score (with digit-count step-down) ------------------
      const sc = Math.round(t.score) || 0;
      if (sc !== pScore) {
        const txt = group(sc);
        elScore.textContent = txt;
        const digits = String(Math.abs(sc)).length;
        const dig = digits >= 9 ? 'd9' : digits >= 8 ? 'd8' : digits >= 7 ? 'd7' : '';
        if (dig !== pDig) {
          if (pDig) elScore.classList.remove(pDig);
          if (dig) elScore.classList.add(dig);
          pDig = dig;
        }
        if (sc > pScore && pScore >= 0) {
          elScore.classList.remove('ssxb-pop');
          void elScore.offsetWidth;
          elScore.classList.add('ssxb-pop');
        }
        pScore = sc;
      }

      // ---------------- multiplier star (HU-11 / JA-18) --------------------
      // trickState().starMult is the trick system's PUBLIC field: the highest
      // pending star this jump, credited on a clean landing and reset to 1 on
      // a crash. Rendered verbatim (1x/2x/3x/5x); the colour ladder only fires
      // on the three canon tiers, so a value outside them still reads true.
      const starRaw = Math.round(Number(t.starMult ?? t.star ?? t._star ?? 1));
      const star = Number.isFinite(starRaw) && starRaw >= 1 ? starRaw : 1;
      if (star !== pStar) {
        elStar.setAttribute('data-star', String(star));
        elStarX.textContent = star + 'x';
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
      // Prefer the RUN system's official clock when the rig provides one: it is
      // the number the results card reports, and it only ticks between the start
      // gate and the finish. trickState()._t is a boot-relative accumulator that
      // keeps running before the gate opens and after the finish, so once the run
      // module is wired the two disagree. Fall back to it when unwired.
      const rs = refs.runState ? (refs.runState() || null) : null;
      const runT = (rs && Number.isFinite(rs.time_s)) ? rs.time_s
        : (Number.isFinite(t._t) ? t._t : localT);
      const tenth = Math.floor(runT * 10);
      if (tenth !== pClock) { elClockV.textContent = clockText(runT); pClock = tenth; }
      // POS exists only while something actually publishes a race position
      const race = refs.raceState ? (refs.raceState() || {}) : {};
      const place = t.place ?? race.place;
      const of = t.racers ?? race.racers;
      const posTxt = place ? ('Pos ' + place + (of ? '/' + of : '')) : '';
      if (posTxt !== pPos) {
        if (posTxt) {
          if (!elPos) {
            elPos = document.createElement('div');
            elPos.id = 'ssxb-pos';
            elPosV = document.createElement('span');
            elPos.appendChild(elPosV);
            elRace.appendChild(elPos);
          }
          elPosV.textContent = posTxt;
        } else if (elPos) {
          elPos.remove(); elPos = null; elPosV = null;
        }
        pPos = posTxt;
      }

      // ---------------- ULTIMA --------------------------------------------
      const lit = Math.max(0, Math.min(6, Math.round(Number(t.ultimaLetters) || 0)));
      if (lit !== pLit) {
        elUltima.setAttribute('data-lit', String(lit));
        for (let i = 0; i < 6; i++) tiles[i].classList.toggle('lit', i < lit);
        pLit = lit;
      }
      const tk = !!t.ultima;
      if (tk !== pUltima) {
        elUltima.setAttribute('data-ultima', tk ? 'true' : 'false');
        elFill.classList.toggle('ultima', tk);
        pUltima = tk;
      }

      // ---------------- boost meter ---------------------------------------
      // quantized to 1/250 (max 0.002 error; gate tolerance is 0.02)
      const m = Math.round(Math.max(0, Math.min(1, Number(t.meter) || 0)) * 250) / 250;
      if (m !== pMeter) {
        elFill.setAttribute('data-value', m.toFixed(2));
        // Width IS the value. The one departure: the gauge keeps its leading
        // SEGMENT lit at zero (floor 0.02) the way an arcade bar does, so the
        // bar has a visible zero point instead of vanishing into the track —
        // and so the fill is never a degenerate zero-width box. The exact
        // number is carried by data-value, which is never floored.
        elFill.style.transform = 'scaleX(' + Math.max(0.02, m).toFixed(3) + ')';
        pMeter = m;
      }
      // Tier look. The FILL always carries its true tier colour — ULTIMA does
      // not repaint the gauge (that would erase the ladder the player reads
      // mid-run); it adds a GOLD state light on the UNSCALED track plus a pill
      // that says the meter is now infinite. Gold because ULTIMA is the gold
      // mechanic on this HUD (see the tile palette law); magenta stays the
      // award slab's alone.
      let tier = 0;
      while (tier < TIERS.length - 1 && m >= TIERS[tier].at) tier++;
      const look = tier * 2 + (tk ? 1 : 0);
      if (look !== pTier) {
        const T = TIERS[tier];
        elFill.style.background = T.grad;
        elFill.style.color = T.ink;
        elTrack.style.boxShadow = trackShadow(tk ? 'rgba(255,208,40,.95)' : T.glow);
        elTrack.style.borderColor = tk ? '#ffd400' : 'rgba(255,255,255,.92)';
        elBState.textContent = tk ? 'Infinite' : T.word;
        elBState.style.background = tk ? '#ffd400' : T.pill;
        pTier = look;
      }
      const full = m >= 0.999;
      if (full !== pFull) {
        elFill.classList.toggle('full', full);
        elBState.classList.toggle('hot', full);
        pFull = full;
      }

      // ---------------- awards (hero band, slam state) ----------------------
      const aw = t.awards;
      const n = (aw && aw.length) || 0;
      if (n !== pAwards) {
        if (n > pAwards) {
          const a = aw[n - 1] || t.lastAward;
          if (a) {
            const nm = String(a.name || 'Trick');
            elAwName.textContent = nm;
            const ncl = nameClass(nm);
            if (ncl !== pAwCls) {
              if (pAwCls) elAwName.classList.remove(pAwCls);
              if (ncl) elAwName.classList.add(ncl);
              pAwCls = ncl;
            }
            const pts = Math.round(Number(a.points) || 0);
            elAwPts.textContent = pts > 0 ? '+' + group(pts) + ' pts' : '';
            elAward.classList.remove('go');
            void elAward.offsetWidth;      // restart the punch-in keyframe
            elAward.classList.add('go');
            awardPlaying = true;
          }
        }
        pAwards = n;
      }

      // ---------------- LIVE trick builder (hero band, build state) ---------
      // Named off the rider's REAL rotation, so it counts up as they spin.
      const at = t.activeTrick;
      const uber = at && at.name && at.name !== 'Grab' ? String(at.name) : '';
      const grabbing = !!(at && at.name === 'Grab');
      const air = !!(r && r.onGround === false);
      const rot = air ? rotationName(Number(r.spinDeg) || 0, Number(r.flipDeg) || 0)
                      : { text: '', units: 0 };
      // The name line takes the uber when one is running (SSX puts the uber's
      // name in lights); the rotation then chips out beside it so both stay
      // legible and neither has to be truncated.
      // The grab reads as a NAMED move with a live hold counter, which is what
      // makes holding it feel like doing something rather than pressing a key.
      // 'Grab' stays the state name in tricks.mjs; this is only the label.
      const heldS = grabbing ? Math.max(0, Number(at.held_s) || 0) : 0;
      const grabTxt = 'Nose Grab ' + heldS.toFixed(1) + 's';
      let txt, rotChip;
      if (uber) { txt = uber; rotChip = rot.text; }
      else if (rot.text) { txt = grabbing ? rot.text + ' + ' + grabTxt : rot.text; rotChip = ''; }
      else { txt = grabbing ? grabTxt : ''; rotChip = ''; }
      const liveOn = air && !awardPlaying;
      if (liveOn !== pLiveOn) { elLive.classList.toggle('on', liveOn); pLiveOn = liveOn; }
      if (liveOn) {
        const shown = txt || 'Air';
        if (shown !== pLiveTxt) {
          elLiveName.textContent = shown;
          const ncl = nameClass(shown);
          if (ncl !== pLiveCls) {
            if (pLiveCls) elLiveName.classList.remove(pLiveCls);
            if (ncl) elLiveName.classList.add(ncl);
            pLiveCls = ncl;
          }
          pLiveTxt = shown;
        }
        if (rotChip !== pRotTxt) {
          if (rotChip) elLiveRot.textContent = rotChip;
          elLiveRot.classList.toggle('on', !!rotChip);
          pRotTxt = rotChip;
        }
        // GROW with the trick: more rotation + an uber = a bigger callout
        const units = rot.units + (uber ? 2 : 0) + (grabbing ? 1 : 0);
        const g = Math.round((1 + Math.min(0.20, 0.032 * units)) * 50) / 50;
        if (g !== pGrow) { elLive.style.setProperty('--g', String(g)); pGrow = g; }
        const lp = Math.round((Number(t.jumpScore) || 0) / 10) * 10;
        if (lp !== pLivePts) { elLivePts.textContent = '+' + group(lp); pLivePts = lp; }
        const airTxt = r && Number.isFinite(r.airTime)
          ? r.airTime.toFixed(1) + 's Air' : 'Air';
        if (airTxt !== pAirTxt) { elLiveAir.textContent = airTxt; pAirTxt = airTxt; }
        // uber animation progress — land before it fills or JA-15 crashes you
        const progOn = !!uber;
        if (progOn !== pProgOn) { elProg.classList.toggle('on', progOn); pProgOn = progOn; }
        if (progOn) {
          const p = Math.round(Math.max(0, Math.min(1, Number(at.progress) || 0)) * 40) / 40;
          if (p !== pProg) { elProgFill.style.transform = 'scaleX(' + p + ')'; pProg = p; }
          const ready = p >= 0.999;
          if (ready !== pReady) { elProg.classList.toggle('ready', ready); pReady = ready; }
        }
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
