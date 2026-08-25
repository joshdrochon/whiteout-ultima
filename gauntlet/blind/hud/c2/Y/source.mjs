// ===========================================================================
// HUD — candidate A: "BROADCAST OVERLAY"  (cycle 2)
//
// SSX-Tricky loud, read at 120 km/h, built as a sports-broadcast package:
// corner-anchored clusters on sheared parallelogram plates, italic condensed
// display type, a score rendered as a slot odometer (each digit its own
// clipped column that rolls when it changes), a STAR multiplier slot and a
// live CHAIN multiplier beside the running jump tally, a segmented boost bar
// on a yellow -> orange -> red tier ladder (rainbow overlay when TRICKY), six
// chevron TRICKY tiles, a reserved top-centre race band (run clock + POS),
// and award banners that SLAM in from the left on a shear + scale overshoot.
//
// ---------------------------------------------------------------------------
// CYCLE-1 CRITIQUE — disposition (every item)
//  1. MULTIPLIER STAR + COMBO MULTIPLIER — added. `.starSlot` is always on
//     screen in the score cluster: hollow/grey "x1" at rest, and it lights
//     yellow(2) / orange(3) / red(5) the moment a star is pending, because
//     that is the number that turns a 20,960 uber into a 130K award. Source:
//     trickState()._star (the trick lane's "highest pending star this jump",
//     JA-18) read defensively, plus a banked-flash latched off any
//     "<N>x Star Bonus" entry pushed into awards[] on a clean landing. The
//     lane contract's public tstate has no star/combo field, so the pending
//     value can only come from the internal — read with `?? 0` fallbacks so a
//     trick module without it degrades to a quiet x1 slot instead of NaN.
//     CHAIN: tricks.mjs tally() gives +10% per extra trick FAMILY in one air;
//     recomputed here from _jump (ubers / spin / flip / grab) and shown as
//     "CHAIN x1.2" next to the live JUMP tally, so the banked number is
//     arithmetic the player can verify: jump tally x chain x star.
//  2. AWARD PUNCH — the transition slide is gone. Entry is now a keyframe
//     slam (scale .35 -> 1.24 -> .94 -> 1.04 -> 1) from transform-origin:left
//     so the left-anchored lower-third geometry is kept, and the static hold
//     is cut 2.0s -> 1.5s (total on-screen ~1.7s).
//  3. NARROW ASPECT RATIOS — the bottom cluster is no longer a fixed-width
//     row. .clBottom is anchored left AND right; the boost block is
//     flex:1 with max-width:430*--s, so the track shrinks instead of being
//     amputated by root overflow:hidden. Right anchor reserves the state
//     badge's column.
//  4. --s CEILING — was clamp(.62px, 100vh/720, 1.7px) (57% size on a 4K
//     panel). Now clamp(.45px, min(100vh/720, 100vw/1280), 2.6px): it tracks
//     the SMALLER axis, so short/wide viewports shrink too and 1440p/4K
//     panels get proportional type. The floor also dropped .62 -> .45 so the
//     top-left and top-right clusters keep shrinking below ~560 px wide
//     instead of freezing and colliding (measured: no cluster overlap and no
//     horizontal overflow at 3840x2160, 1600x600, 800x600, 500x900, 420x800).
//  5. AWARD NAME OVERFLOW — .awName now min-width:0 + ellipsis inside a
//     max-width:calc(100vw - 40*--s) banner: "SuperMan BarSpin" clips
//     deliberately with an ellipsis instead of being cut mid-glyph.
//  6. ODOMETER CLIPPING — .dg cells .60em -> .74em with .03em side padding;
//     synthetic-italic Impact leans ~.2em at the top of a 76*--s glyph and
//     now clears the cell edge (verified at 486,300 and 1,204,880). A 7+ digit
//     score also steps the odometer down (.d7/.d9) so a million-point run
//     cannot grow the plate into the top-centre race band.
//  7/8. (Y's two-axis meter, Y's unscaled chrome) — not this candidate's
//     code; nothing adopted from it, so nothing to port. Meter here encodes
//     value in WIDTH ONLY.
//  9. (Y's pseudo-element evasion of HU-10) — not carried forward. Every
//     string this HUD displays is real text in a real element inside the top
//     or bottom band; HU-10 is satisfied by geometry, not by hiding from the
//     probe's querySelectorAll.
// 10. BOOST LADDER — kept: Charge(yellow) -> Surge(orange) -> Redline(red).
// 11. RANK / RUN TIME — top-centre band reserved and populated: run clock
//     always, POS only when a race source exists (refs.raceState?.() ->
//     {place, of}). No invented placement: an unraced run shows the clock
//     alone rather than a fake "1ST".
// ---------------------------------------------------------------------------
//
// LAYOUT LAW (HU-10): every painted element lives in the top band (bottom
// < 180 px @720) or the bottom band (top > 540 px @720). The centre 50% of
// the screen — where the rider and the run line are — is never touched, not
// even by an award banner at full extension.
//
// PROBE CONTRACT (exact, do not "improve"):
//   [data-hud="score"]      -> digit/comma spans only; textContent digits ==
//                              round(trickState().score), written synchronously
//                              inside update() (no tweening, the probe reads
//                              one frame after it writes the value).
//   [data-hud="meter-fill"] -> data-value = meter.toFixed(2); width set
//                              inline with NO css transition, so the probe's
//                              synchronous getBoundingClientRect() sees the
//                              new width; its own background-color AND
//                              background-image change per tier (HU-09) and
//                              are driven by the METER VALUE, never by the
//                              TRICKY flag — TRICKY is a separate overlay
//                              layer, so the colour ladder still reads three
//                              distinct fills after TRICKY latches on.
//   [data-hud="speed"]      -> the integer ONLY (the "KM/H" unit is a sibling,
//                              so the probe's /[^0-9.]/ strip can't pick up a
//                              stray glyph).
//   [data-hud="tricky"]     -> data-lit 0..6, data-tricky "true"/"false".
//   [data-hud="award"]      -> lifetime driven by performance.now(), NOT by
//                              accumulated dt: the HU-05 probe measures in
//                              REAL time while calling update(1/60) once per
//                              rAF, so a dt-driven timer would drift with
//                              frame rate and could still be on screen at
//                              4.5 s on a slow frame. 0.34 s slam + 1.5 s
//                              hold + 0.16 s fade = gone well inside the
//                              window, visible well inside 0.5 s.
//
// COST (HU-06): no per-frame allocation, no querySelector, no
// getComputedStyle, no getBoundingClientRect. Every DOM write is guarded by a
// cached previous value, so a steady frame touches the DOM zero times.
// ===========================================================================

const STYLE_ID = 'ssx-hud-a-style';

const CSS = `
.ssxA{
  /* tracks the SMALLER axis so short/wide viewports shrink and 4K scales up */
  --s: clamp(0.45px, min(100vh / 720, 100vw / 1280), 2.6px);
  --dsp: Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Black', 'Helvetica Neue', sans-serif;
  --ui: 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif;
  --cyan:#00e9ff; --mag:#ff1fb3; --yel:#ffe000; --org:#ff7a00;
  --red:#ff2040; --lime:#b4ff00; --ink:#05070d;
  position:absolute; inset:0; overflow:hidden;
  font-family:var(--dsp); text-transform:uppercase; font-style:italic;
  -webkit-font-smoothing:antialiased;
}
.ssxA *{ box-sizing:border-box; }

/* ---- band scrims: keep type legible over blown-out snow --------------- */
.ssxA .scrimT{ position:absolute; left:0; right:0; top:0; height:calc(166*var(--s));
  background:linear-gradient(180deg, rgba(3,6,14,.84) 0%, rgba(3,6,14,.46) 46%, rgba(3,6,14,0) 100%); }
.ssxA .scrimB{ position:absolute; left:0; right:0; bottom:0; height:calc(170*var(--s));
  background:linear-gradient(0deg, rgba(3,6,14,.90) 0%, rgba(3,6,14,.55) 44%, rgba(3,6,14,0) 100%); }

/* ---- shared plate language ------------------------------------------- */
.ssxA .plate{
  position:relative; transform:skewX(-12deg);
  background:linear-gradient(150deg, rgba(10,16,30,.94) 0%, rgba(6,9,18,.82) 100%);
  border-top:calc(2*var(--s)) solid rgba(255,255,255,.16);
  border-bottom:calc(2*var(--s)) solid rgba(255,255,255,.10);
  box-shadow:0 calc(4*var(--s)) calc(18*var(--s)) rgba(0,0,0,.55);
}
.ssxA .plate > .inner{ transform:skewX(12deg); }
.ssxA .edge{ position:absolute; top:0; bottom:0; width:calc(7*var(--s)); }
.ssxA .edgeL{ left:calc(-7*var(--s)); background:linear-gradient(180deg,var(--cyan),var(--mag)); }
.ssxA .edgeR{ right:calc(-7*var(--s)); background:linear-gradient(180deg,var(--mag),var(--cyan)); }

.ssxA .lbl{
  font-family:var(--ui); font-weight:700; font-style:italic;
  letter-spacing:calc(3*var(--s)); font-size:calc(13*var(--s)); line-height:1;
  color:#dff6ff; text-shadow:0 calc(1*var(--s)) 0 #000;
  display:flex; align-items:center; gap:calc(6*var(--s));
}
.ssxA .lbl > span{ display:flex; align-items:center; gap:calc(6*var(--s)); }
.ssxA .lbl .bar{ width:calc(16*var(--s)); height:calc(4*var(--s)); background:var(--cyan);
  box-shadow:0 0 calc(10*var(--s)) var(--cyan); transform:skewX(-20deg); }

/* ================= TOP LEFT — SCORE ODOMETER + STAR =================== */
.ssxA .clScore{ position:absolute; left:calc(30*var(--s)); top:calc(16*var(--s)); }
.ssxA .clScore .plate{ padding:calc(7*var(--s)) calc(26*var(--s)) calc(8*var(--s)) calc(16*var(--s)); }
.ssxA .clScore .lbl{ justify-content:space-between; }
.ssxA .clScore .lbl .pts{ color:var(--mag); letter-spacing:calc(2*var(--s)); }
.ssxA .scoreRow{ display:flex; align-items:flex-end; gap:calc(12*var(--s)); }
.ssxA .odo{
  display:flex; align-items:flex-end; gap:calc(1*var(--s));
  margin-top:calc(3*var(--s)); font-size:calc(76*var(--s)); line-height:.94;
  color:#fff; letter-spacing:0;
}
/* a 7- or 8-figure run must not grow the plate into the top-centre race
   band: the odometer steps down instead of pushing the layout */
.ssxA .odo.d7{ font-size:calc(58*var(--s)); }
.ssxA .odo.d9{ font-size:calc(46*var(--s)); }
.ssxA .odo .dg{
  display:inline-block; overflow:hidden; vertical-align:bottom;
  width:.74em; padding:0 .03em; text-align:center;
  background:linear-gradient(180deg,#131f38 0%,#060a14 62%,#0c1428 100%);
  border-top:calc(2*var(--s)) solid rgba(0,233,255,.55);
  box-shadow:inset 0 calc(-3*var(--s)) calc(8*var(--s)) rgba(0,0,0,.8);
  text-shadow:0 0 calc(14*var(--s)) rgba(0,233,255,.55), 0 calc(2*var(--s)) 0 #000;
}
.ssxA .odo .cm{ display:inline-block; width:.22em; text-align:center; color:var(--cyan);
  text-shadow:0 0 calc(10*var(--s)) var(--cyan); }
@keyframes ssxRollA{ from{ transform:translateY(-78%); opacity:.1 } to{ transform:none; opacity:1 } }
@keyframes ssxRollB{ from{ transform:translateY(-78%); opacity:.1 } to{ transform:none; opacity:1 } }
.ssxA .odo .dg.rA{ animation:ssxRollA .17s cubic-bezier(.18,.92,.24,1) }
.ssxA .odo .dg.rB{ animation:ssxRollB .17s cubic-bezier(.18,.92,.24,1) }

/* ---- STAR multiplier slot (yellow 2x / orange 3x / red 5x) ------------ */
.ssxA .starSlot{
  position:relative; display:flex; align-items:center; gap:calc(4*var(--s));
  padding:calc(3*var(--s)) calc(9*var(--s)) calc(3*var(--s)) calc(7*var(--s));
  margin-bottom:calc(6*var(--s)); transform:skewX(-12deg);
  background:linear-gradient(180deg, rgba(18,26,44,.92), rgba(6,9,18,.92));
  border:calc(2*var(--s)) solid rgba(255,255,255,.16);
}
.ssxA .starSlot > *{ transform:skewX(12deg); }
.ssxA .star{
  width:calc(26*var(--s)); height:calc(26*var(--s)); flex:0 0 auto;
  clip-path:polygon(50% 0%,61% 34%,98% 35%,68% 57%,79% 92%,50% 70%,21% 92%,32% 57%,2% 35%,39% 34%);
  background:#33405c;
}
.ssxA .starX{ font-size:calc(30*var(--s)); line-height:calc(30*var(--s)); color:#5d6d8c;
  letter-spacing:calc(-1*var(--s)); text-shadow:0 calc(2*var(--s)) 0 #000; }
.ssxA .starSlot[data-tier="2"]{ border-color:#ffe36a; box-shadow:0 0 calc(18*var(--s)) rgba(255,215,0,.6); }
.ssxA .starSlot[data-tier="2"] .star{ background:#ffd400; box-shadow:0 0 calc(14*var(--s)) rgba(255,215,0,.9); }
.ssxA .starSlot[data-tier="2"] .starX{ color:#ffe000; }
.ssxA .starSlot[data-tier="3"]{ border-color:#ffb05a; box-shadow:0 0 calc(20*var(--s)) rgba(255,120,0,.7); }
.ssxA .starSlot[data-tier="3"] .star{ background:#ff7a00; box-shadow:0 0 calc(16*var(--s)) rgba(255,120,0,.95); }
.ssxA .starSlot[data-tier="3"] .starX{ color:#ff9d2e; }
.ssxA .starSlot[data-tier="5"]{ border-color:#ff7a90; box-shadow:0 0 calc(24*var(--s)) rgba(255,40,90,.8); }
.ssxA .starSlot[data-tier="5"] .star{ background:#ff2040; box-shadow:0 0 calc(18*var(--s)) rgba(255,40,90,.95); }
.ssxA .starSlot[data-tier="5"] .starX{ color:#ff5470; }
@keyframes ssxStarPop{ 0%{ transform:skewX(-12deg) scale(1) } 30%{ transform:skewX(-12deg) scale(1.28) }
  60%{ transform:skewX(-12deg) scale(.96) } 100%{ transform:skewX(-12deg) scale(1) } }
.ssxA .starSlot.pA{ animation:ssxStarPop .34s cubic-bezier(.2,.9,.2,1.2) }
.ssxA .starSlot.pB{ animation:ssxStarPop .34s cubic-bezier(.2,.9,.2,1.2) }

/* ---- jump tally / chain / air chips ---------------------------------- */
.ssxA .subrow{ display:flex; align-items:center; gap:calc(6*var(--s));
  margin-top:calc(7*var(--s)); height:calc(19*var(--s)); }
.ssxA .subrow .rule{ flex:1; height:calc(5*var(--s)); transform:skewX(-16deg);
  background:linear-gradient(90deg, var(--cyan) 0%, rgba(255,31,179,.85) 45%, rgba(255,31,179,0) 100%); }
.ssxA .chip{
  display:none; align-items:center; gap:calc(5*var(--s)); padding:0 calc(8*var(--s));
  transform:skewX(-12deg); font-family:var(--ui); font-weight:700; font-style:italic;
  font-size:calc(13*var(--s)); letter-spacing:calc(1*var(--s)); line-height:calc(19*var(--s));
  white-space:nowrap;
}
.ssxA .chip[data-on="1"]{ display:flex; }
.ssxA .chip > *{ transform:skewX(12deg); }
.ssxA .chipJump{ background:linear-gradient(90deg,#ffe000,#ff7a00); color:#1b0f00;
  box-shadow:0 0 calc(14*var(--s)) rgba(255,190,0,.55); }
.ssxA .chipChain{ background:linear-gradient(90deg,#b4ff00,#00e9ff); color:#04180a;
  box-shadow:0 0 calc(14*var(--s)) rgba(150,255,80,.55); }
.ssxA .chipAir{ background:linear-gradient(90deg,#00e9ff,#0077ff); color:#001019;
  box-shadow:0 0 calc(14*var(--s)) rgba(0,220,255,.5); }

/* ================= TOP CENTRE — RACE BAND (POS + CLOCK) =============== */
.ssxA .clRace{ position:absolute; left:50%; top:calc(14*var(--s)); transform:translateX(-50%);
  display:flex; align-items:stretch; gap:calc(6*var(--s)); }
.ssxA .raceBox{
  display:flex; align-items:center; gap:calc(7*var(--s));
  padding:calc(4*var(--s)) calc(14*var(--s)); transform:skewX(-12deg);
  background:linear-gradient(180deg, rgba(10,16,30,.92), rgba(5,8,16,.86));
  border-top:calc(3*var(--s)) solid var(--mag);
  box-shadow:0 calc(3*var(--s)) calc(14*var(--s)) rgba(0,0,0,.5);
}
.ssxA .raceBox > *{ transform:skewX(12deg); }
.ssxA .raceK{ font-family:var(--ui); font-weight:700; font-style:italic;
  font-size:calc(12*var(--s)); letter-spacing:calc(3*var(--s)); color:#9fd8ea; }
.ssxA .clock{ font-size:calc(32*var(--s)); line-height:calc(34*var(--s)); color:#fff;
  letter-spacing:calc(1*var(--s));
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(12*var(--s)) rgba(0,233,255,.5); }
.ssxA .posBox{ display:none; }
.ssxA .posBox[data-on="1"]{ display:flex; }
.ssxA .posBox{ border-top-color:var(--yel); }
.ssxA .pos{ font-size:calc(32*var(--s)); line-height:calc(34*var(--s)); color:var(--yel);
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(14*var(--s)) rgba(255,200,0,.6); }
.ssxA .posOf{ font-family:var(--ui); font-weight:700; font-style:italic;
  font-size:calc(13*var(--s)); color:#9fd8ea; }
@media (max-width: 720px){ .ssxA .clRace{ display:none } }

/* ================= TOP RIGHT — TRICKY LETTERS ========================= */
.ssxA .clTricky{ position:absolute; right:calc(30*var(--s)); top:calc(16*var(--s));
  display:flex; flex-direction:column; align-items:flex-end; gap:calc(7*var(--s)); }
.ssxA .clTricky .lbl{ justify-content:flex-end; }
.ssxA .trRow{ display:flex; gap:calc(5*var(--s)); }
.ssxA .tl{
  width:calc(38*var(--s)); height:calc(44*var(--s));
  display:flex; align-items:center; justify-content:center;
  transform:skewX(-13deg);
  background:linear-gradient(180deg, rgba(16,22,38,.92), rgba(6,9,18,.92));
  border:calc(2*var(--s)) solid rgba(255,255,255,.14);
  font-size:calc(27*var(--s)); color:rgba(190,215,235,.30); line-height:1;
  text-shadow:0 calc(2*var(--s)) 0 #000;
}
.ssxA .tl > span{ transform:skewX(13deg); display:block; }
.ssxA .tl.lit{
  border-color:#fff2a8; color:#150c00;
  background:linear-gradient(180deg,#fff59a 0%,#ffd400 45%,#ff7a00 100%);
  box-shadow:0 0 calc(18*var(--s)) rgba(255,190,0,.85), inset 0 0 calc(8*var(--s)) rgba(255,255,255,.7);
  text-shadow:0 calc(1*var(--s)) 0 rgba(255,255,255,.6);
}
@keyframes ssxRainbow{ 0%{ background-position:0% 50% } 100%{ background-position:200% 50% } }
.ssxA[data-tricky="true"] .tl.lit{
  background:linear-gradient(90deg,#ff2040,#ffd400,#00ff9d,#00e9ff,#ff1fb3,#ff2040);
  background-size:200% 100%; animation:ssxRainbow 1.1s linear infinite;
  border-color:#fff;
}
.ssxA .trWord{
  display:none; margin-top:calc(2*var(--s)); padding:0 calc(10*var(--s));
  transform:skewX(-13deg); font-size:calc(20*var(--s)); line-height:calc(24*var(--s));
  color:#12010a; letter-spacing:calc(2*var(--s));
  background:linear-gradient(90deg,#ff2040,#ffd400,#00ff9d,#00e9ff,#ff1fb3,#ff2040);
  background-size:200% 100%; animation:ssxRainbow .9s linear infinite;
  box-shadow:0 0 calc(22*var(--s)) rgba(255,80,180,.8);
}
.ssxA[data-tricky="true"] .trWord{ display:block; }

/* ================= BOTTOM LEFT — SPEED + BOOST ========================
   anchored BOTH sides: the boost track shrinks on narrow viewports instead
   of being clipped by the root's overflow:hidden (critique item 3).       */
.ssxA .clBottom{
  position:absolute; left:calc(30*var(--s)); right:calc(198*var(--s));
  bottom:calc(24*var(--s));
  display:flex; align-items:flex-end; gap:calc(24*var(--s));
}

.ssxA .spd{ position:relative; flex:0 0 auto; }
.ssxA .spdRow{ display:flex; align-items:flex-end; gap:calc(6*var(--s)); }
.ssxA .spdNum{
  font-size:calc(60*var(--s)); line-height:.86; color:#fff;
  min-width:calc(96*var(--s)); text-align:right;
  text-shadow:0 calc(3*var(--s)) 0 #000, 0 0 calc(18*var(--s)) rgba(0,233,255,.55);
}
.ssxA[data-hot="1"] .spdNum{ color:#fff2c4;
  text-shadow:0 calc(3*var(--s)) 0 #000, 0 0 calc(24*var(--s)) rgba(255,140,0,.95); }
.ssxA .spdUnit{
  font-family:var(--ui); font-weight:700; font-style:italic; font-size:calc(15*var(--s));
  letter-spacing:calc(2*var(--s)); color:var(--cyan); line-height:calc(20*var(--s));
  text-shadow:0 calc(1*var(--s)) 0 #000;
}
.ssxA .spdBar{ position:relative; margin-top:calc(5*var(--s)); height:calc(8*var(--s));
  width:calc(178*var(--s)); transform:skewX(-16deg); overflow:hidden;
  background:rgba(4,8,16,.8); border:calc(1*var(--s)) solid rgba(255,255,255,.22); }
.ssxA .spdBarFill{ position:absolute; left:0; top:0; bottom:0; width:0%; transition:none;
  background:linear-gradient(90deg,#00e9ff 0%,#b4ff00 55%,#ffe000 80%,#ff2040 100%); }
.ssxA .spdBar .pips{ position:absolute; inset:0;
  background:repeating-linear-gradient(90deg, rgba(0,0,0,0) 0 calc(16*var(--s)), rgba(2,4,9,.85) calc(16*var(--s)) calc(19*var(--s))); }

.ssxA .boost{ position:relative; flex:1 1 auto; min-width:calc(88*var(--s));
  max-width:calc(430*var(--s)); }
.ssxA .btHead{ display:flex; align-items:center; justify-content:space-between;
  width:100%; margin-bottom:calc(5*var(--s)); }
.ssxA .btTier{ font-size:calc(19*var(--s)); letter-spacing:calc(2*var(--s)); line-height:1;
  color:var(--yel); text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(12*var(--s)) rgba(255,200,0,.6); }
.ssxA .btTrack{
  position:relative; width:100%; height:calc(32*var(--s));
  transform:skewX(-16deg); overflow:hidden;
  background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.07) 0 calc(24*var(--s)), rgba(0,0,0,0) calc(24*var(--s)) calc(30*var(--s))),
    linear-gradient(180deg,#0a1020,#04070e);
  border:calc(2*var(--s)) solid rgba(255,255,255,.24);
  box-shadow:0 calc(3*var(--s)) calc(14*var(--s)) rgba(0,0,0,.6);
}
.ssxA .btFill{
  position:absolute; left:0; top:0; bottom:0; width:0%;
  transition:none; will-change:width;
  background-color:#ffd400;
  background-image:linear-gradient(90deg,#fff08a 0%,#ffd400 55%,#ffa800 100%);
  box-shadow:0 0 calc(18*var(--s)) rgba(255,210,0,.55);
}
.ssxA .btFill::after{ content:''; position:absolute; right:0; top:0; bottom:0;
  width:calc(5*var(--s)); background:#fff; box-shadow:0 0 calc(16*var(--s)) rgba(255,255,255,.9); }
.ssxA .btRain{ position:absolute; inset:0; opacity:0;
  background:linear-gradient(90deg,#ff2040,#ffd400,#00ff9d,#00e9ff,#ff1fb3,#ff2040);
  background-size:200% 100%; }
.ssxA[data-tricky="true"] .btRain{ opacity:1; animation:ssxRainbow .8s linear infinite; }
.ssxA .btSeg{ position:absolute; inset:0;
  background:repeating-linear-gradient(90deg, rgba(0,0,0,0) 0 calc(24*var(--s)), rgba(2,4,9,.92) calc(24*var(--s)) calc(30*var(--s))); }
.ssxA .btGloss{ position:absolute; left:0; right:0; top:0; height:45%;
  background:linear-gradient(180deg, rgba(255,255,255,.30), rgba(255,255,255,0)); }

/* ================= BOTTOM RIGHT — STATE BADGE ========================= */
.ssxA .clState{ position:absolute; right:calc(30*var(--s)); bottom:calc(20*var(--s)); }
.ssxA .badge{
  visibility:hidden; opacity:0; transform:skewX(-14deg) scale(.86);
  transition:opacity .12s linear, transform .12s cubic-bezier(.2,.9,.2,1.2), visibility 0s linear .12s;
  padding:calc(4*var(--s)) calc(18*var(--s));
  font-size:calc(38*var(--s)); line-height:calc(46*var(--s)); letter-spacing:calc(2*var(--s));
  color:#140800; background:linear-gradient(90deg,#ffe000,#ff7a00);
  box-shadow:0 0 calc(26*var(--s)) rgba(255,150,0,.85);
}
.ssxA .badge > span{ display:block; transform:skewX(14deg); }
.ssxA .badge[data-state="boost"], .ssxA .badge[data-state="tricky"]{
  visibility:visible; opacity:1; transform:skewX(-14deg) scale(1);
  transition:opacity .12s linear, transform .12s cubic-bezier(.2,.9,.2,1.2), visibility 0s linear 0s;
}
@keyframes ssxPulse{ 0%,100%{ transform:skewX(-14deg) scale(1) } 50%{ transform:skewX(-14deg) scale(1.06) } }
.ssxA .badge[data-state="boost"]{ animation:ssxPulse .42s ease-in-out infinite; }
.ssxA .badge[data-state="tricky"]{
  color:#12010a;
  background:linear-gradient(90deg,#ff2040,#ffd400,#00ff9d,#00e9ff,#ff1fb3,#ff2040);
  background-size:200% 100%;
  animation:ssxRainbow .8s linear infinite, ssxPulse .5s ease-in-out infinite;
  box-shadow:0 0 calc(30*var(--s)) rgba(255,80,180,.9);
}

/* ================= AWARD LOWER-THIRD ==================================
   SLAM, not a slide: keyframe scale overshoot from the left edge.        */
.ssxA .award{
  position:absolute; left:0; bottom:calc(112*var(--s));
  display:flex; align-items:stretch; white-space:nowrap;
  max-width:calc(100vw - 40*var(--s));
  transform-origin:left center;
  transform:translateX(-118%) skewX(-15deg); opacity:0; visibility:hidden;
  transition:transform .16s cubic-bezier(.5,0,.9,.4), opacity .14s linear, visibility 0s linear .18s;
  box-shadow:0 calc(6*var(--s)) calc(26*var(--s)) rgba(0,0,0,.65);
}
@keyframes ssxSlamA{
  0%   { transform:translateX(-46%) skewX(-15deg) scale(.35); opacity:0 }
  38%  { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(1.24); opacity:1 }
  60%  { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(.94); opacity:1 }
  80%  { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(1.04); opacity:1 }
  100% { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(1); opacity:1 }
}
@keyframes ssxSlamB{
  0%   { transform:translateX(-46%) skewX(-15deg) scale(.35); opacity:0 }
  38%  { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(1.24); opacity:1 }
  60%  { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(.94); opacity:1 }
  80%  { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(1.04); opacity:1 }
  100% { transform:translateX(calc(-8*var(--s))) skewX(-15deg) scale(1); opacity:1 }
}
.ssxA .award.on{
  transform:translateX(calc(-8*var(--s))) skewX(-15deg); opacity:1; visibility:visible;
  transition:transform .16s linear, opacity .1s linear, visibility 0s linear 0s;
}
.ssxA .award.on.kA{ animation:ssxSlamA .34s cubic-bezier(.16,.9,.24,1.02) }
.ssxA .award.on.kB{ animation:ssxSlamB .34s cubic-bezier(.16,.9,.24,1.02) }
.ssxA .awTag{
  display:flex; align-items:center; flex:0 0 auto;
  padding:0 calc(14*var(--s)) 0 calc(24*var(--s));
  background:linear-gradient(160deg,#ff1fb3,#7a00ff);
  font-family:var(--ui); font-weight:700; font-style:italic; color:#fff;
  font-size:calc(13*var(--s)); letter-spacing:calc(3*var(--s));
}
.ssxA .awBody{
  display:flex; align-items:center; gap:calc(14*var(--s)); min-width:0;
  padding:calc(6*var(--s)) calc(22*var(--s)) calc(7*var(--s)) calc(18*var(--s));
  background:linear-gradient(120deg, rgba(8,12,24,.97) 0%, rgba(14,22,44,.93) 100%);
  border-top:calc(3*var(--s)) solid var(--cyan);
}
.ssxA .awTag > span, .ssxA .awBody > *{ transform:skewX(15deg); }
/* long uber names (SuperMan BarSpin, La La La Lock Step) clip with an
   ellipsis instead of being cut mid-glyph by the root's overflow:hidden */
.ssxA .awName{ font-size:calc(35*var(--s)); line-height:calc(40*var(--s)); color:#fff;
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(16*var(--s)) rgba(0,233,255,.6); }
.ssxA .awPts{ flex:0 0 auto; font-size:calc(27*var(--s)); line-height:calc(40*var(--s));
  color:var(--yel);
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(14*var(--s)) rgba(255,215,0,.7); }
@keyframes ssxKickA{ 0%{ filter:brightness(2.6) } 100%{ filter:none } }
@keyframes ssxKickB{ 0%{ filter:brightness(2.6) } 100%{ filter:none } }
.ssxA .award.kA .awBody{ animation:ssxKickA .14s linear }
.ssxA .award.kB .awBody{ animation:ssxKickB .14s linear }
`;

const HTML = `
<div class="scrimT"></div>
<div class="scrimB"></div>

<div class="clScore">
  <div class="plate">
    <i class="edge edgeL"></i>
    <div class="inner">
      <div class="lbl"><span><i class="bar"></i>Score</span><span class="pts">Pts</span></div>
      <div class="scoreRow">
        <div class="odo" data-hud="score"></div>
        <div class="starSlot" data-tier="0"><i class="star"></i><b class="starX">x1</b></div>
      </div>
      <div class="subrow">
        <div class="chip chipJump" data-on="0"><i>Jump</i><b class="jv">0</b></div>
        <div class="chip chipChain" data-on="0"><i>Chain</i><b class="cv">x1.0</b></div>
        <div class="chip chipAir" data-on="0"><i>Air</i><b class="av">0.0s</b></div>
        <i class="rule"></i>
      </div>
    </div>
  </div>
</div>

<div class="clRace">
  <div class="raceBox posBox" data-on="0"><b class="raceK">Pos</b><b class="pos">-</b><b class="posOf">/-</b></div>
  <div class="raceBox"><b class="raceK">Run</b><b class="clock">0:00.0</b></div>
</div>

<div class="clTricky">
  <div class="lbl">Uber Chain<i class="bar"></i></div>
  <div class="trRow" data-hud="tricky" data-lit="0" data-tricky="false">
    <div class="tl"><span>T</span></div><div class="tl"><span>R</span></div>
    <div class="tl"><span>I</span></div><div class="tl"><span>C</span></div>
    <div class="tl"><span>K</span></div><div class="tl"><span>Y</span></div>
  </div>
  <div class="trWord">Tricky!</div>
</div>

<div class="clBottom">
  <div class="spd">
    <div class="spdRow">
      <div class="spdNum" data-hud="speed">0</div>
      <div class="spdUnit">km/h</div>
    </div>
    <div class="spdBar"><div class="spdBarFill"></div><i class="pips"></i></div>
  </div>
  <div class="boost">
    <div class="btHead">
      <div class="lbl"><i class="bar"></i>Boost</div>
      <div class="btTier">Charge</div>
    </div>
    <div class="btTrack">
      <div class="btFill" data-hud="meter-fill" data-value="0.00"><i class="btRain"></i></div>
      <i class="btSeg"></i><i class="btGloss"></i>
    </div>
  </div>
</div>

<div class="clState"><div class="badge" data-state="off"><span>Boost</span></div></div>

<div class="award" data-hud="award">
  <div class="awTag"><span>Trick</span></div>
  <div class="awBody">
    <div class="awName">&mdash;</div>
    <div class="awPts">+0</div>
  </div>
</div>
`;

// meter tiers: yellow -> orange -> red (reference boost ladder). Driven by the
// METER VALUE only, so the HU-09 ladder still reads 3 distinct fills once the
// permanent TRICKY flag is latched (TRICKY paints the .btRain overlay instead).
const TIERS = [
  { at: 0.34, name: 'Charge',
    bg: '#ffd400', img: 'linear-gradient(90deg,#fff08a 0%,#ffd400 55%,#ffa800 100%)',
    glow: '0 0 18px rgba(255,210,0,.55)', label: '#ffe000' },
  { at: 0.67, name: 'Surge',
    bg: '#ff7a00', img: 'linear-gradient(90deg,#ffc46b 0%,#ff7a00 55%,#ff3d00 100%)',
    glow: '0 0 22px rgba(255,120,0,.7)', label: '#ff9d2e' },
  { at: 2, name: 'Redline',
    bg: '#ff2040', img: 'linear-gradient(90deg,#ff96a6 0%,#ff2040 50%,#ff00a8 100%)',
    glow: '0 0 28px rgba(255,40,90,.85)', label: '#ff5470' },
];

// star tiers are canon: yellow 2x, orange 3x, red 5x (JA-18). Anything else a
// trick module hands us is shown at its nearest legal slot colour.
const STAR_SLOT = (n) => (n >= 5 ? 5 : n >= 3 ? 3 : n >= 2 ? 2 : 0);
const STAR_BONUS_RE = /^\s*(\d+)\s*x\s*star/i;

// Trick FAMILIES in one air, per src/tricks/tricks.mjs components(): ubers,
// spin, flip (a spin+flip composite is BOTH), grab. tally() awards
// +10% per extra family. Recomputed here for a live preview only — the
// authoritative number is banked by the trick lane on landing.
const MIN_GRAB_S = 0.15, COMBO_PER_FAMILY = 0.10;
function chainMult(t) {
  const j = t && t._jump;
  if (!j) return 1;
  const su = Math.floor(((j.peakSpin || 0) + 10) / 180);
  const fu = Math.floor(((j.peakFlip || 0) + 10) / 360);
  let fam = 0;
  if (j.completedUbers && j.completedUbers.length > 0) fam += 1;
  if (su >= 1 && fu >= 1 && !j.spinMystery && !j.flipMystery) fam += 2;
  else { if (su >= 1) fam += 1; if (fu >= 1) fam += 1; }
  if ((j.grabTime || 0) >= MIN_GRAB_S) fam += 1;
  return fam >= 2 ? 1 + COMBO_PER_FAMILY * (fam - 1) : 1;
}

function commafy(n) {
  const s = String(n);
  if (s.length < 4) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}

function clockStr(sec) {
  const s = sec < 0 ? 0 : sec;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

const ORD = ['', '1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th'];

export function createHud(container, refs) {
  // ---- one-time style injection (head, so it never enters the HUD tree) --
  const doc = container.ownerDocument || document;
  if (!doc.getElementById(STYLE_ID)) {
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(st);
  }

  const root = doc.createElement('div');
  root.className = 'ssxA';
  root.setAttribute('data-tricky', 'false');
  root.setAttribute('data-hot', '0');
  root.innerHTML = HTML;
  container.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const el = {
    score: q('[data-hud="score"]'),
    speed: q('[data-hud="speed"]'),
    fill: q('[data-hud="meter-fill"]'),
    tricky: q('[data-hud="tricky"]'),
    award: q('[data-hud="award"]'),
    awName: q('.awName'),
    awPts: q('.awPts'),
    tier: q('.btTier'),
    tiles: Array.prototype.slice.call(root.querySelectorAll('.tl')),
    chipJump: q('.chipJump'), jv: q('.jv'),
    chipChain: q('.chipChain'), cv: q('.cv'),
    chipAir: q('.chipAir'), av: q('.av'),
    starSlot: q('.starSlot'), starX: q('.starX'),
    badge: q('.badge'), badgeTxt: q('.badge > span'),
    spdFill: q('.spdBarFill'),
    clock: q('.clock'), posBox: q('.posBox'), pos: q('.pos'), posOf: q('.posOf'),
  };

  const raceRef = (refs && typeof refs.raceState === 'function') ? refs.raceState : null;

  // ---- cached last-written values: a steady frame writes nothing --------
  let cScore = -1, cScoreStr = '', digits = [];
  let cSpeed = -1, cMeter = -1, cTier = -1, cLit = -1, cTricky = null;
  let cJump = -1, cJumpOn = -1, cAirOn = -1, cAir = -1, cHot = -1, cState = '';
  let cChain = -1, cChainOn = -1, cStar = -1, starPop = false;
  let cClock = -1, cPosOn = -1, cPos = -1, cPosOf = -1;
  let awardCount = 0, awardsRef = null, awardT0 = -1, awardOn = false, awardKick = false;
  let prevBoostMeter = -1, boostHold = 0;
  let bankedStar = 0, bankedStarT0 = -1;
  let runT = 0;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

  // --- score odometer: exactly the digits, nothing else, written now ----
  function setScore(raw) {
    const n = Math.max(0, Math.round(Number(raw) || 0));
    if (n === cScore) return;
    cScore = n;
    const s = commafy(n);
    if (s.length !== cScoreStr.length) {
      const nd = s.length - Math.floor((s.length - 1) / 4);   // digits, sans commas
      el.score.className = nd >= 9 ? 'odo d9' : nd >= 7 ? 'odo d7' : 'odo';
      el.score.textContent = '';
      digits = [];
      for (let i = 0; i < s.length; i++) {
        const d = doc.createElement('span');
        d.className = s[i] === ',' ? 'cm' : 'dg';
        d.textContent = s[i];
        el.score.appendChild(d);
        digits.push(d);
      }
    } else {
      for (let i = 0; i < s.length; i++) {
        if (s[i] === cScoreStr[i]) continue;
        const d = digits[i];
        d.textContent = s[i];
        // alternate keyframe names to restart the roll with no forced reflow
        d.className = d.className === 'dg rA' ? 'dg rB' : 'dg rA';
      }
    }
    cScoreStr = s;
  }

  function setMeter(v) {
    const m = v < 0 ? 0 : v > 1 ? 1 : v;
    if (Math.abs(m - cMeter) > 0.0005) {
      cMeter = m;
      el.fill.setAttribute('data-value', m.toFixed(2));
      el.fill.style.width = (m * 100).toFixed(2) + '%';
    }
    const t = m < TIERS[0].at ? 0 : m < TIERS[1].at ? 1 : 2;
    if (t !== cTier) {
      cTier = t;
      const T = TIERS[t];
      el.fill.style.backgroundColor = T.bg;
      el.fill.style.backgroundImage = T.img;
      el.fill.style.boxShadow = T.glow;
      el.tier.textContent = T.name;
      el.tier.style.color = T.label;
    }
  }

  function setTricky(lit, on) {
    if (lit !== cLit) {
      cLit = lit;
      el.tricky.setAttribute('data-lit', String(lit));
      for (let i = 0; i < 6; i++) el.tiles[i].className = i < lit ? 'tl lit' : 'tl';
    }
    if (on !== cTricky) {
      cTricky = on;
      el.tricky.setAttribute('data-tricky', on ? 'true' : 'false');
      root.setAttribute('data-tricky', on ? 'true' : 'false');
    }
  }

  // The multiplier slot: pending star (highest only) while airborne, then the
  // banked star flashed for a beat on the clean landing that credits it.
  function setStar(tier) {
    if (tier === cStar) return;
    const grew = tier > cStar;
    cStar = tier;
    el.starSlot.setAttribute('data-tier', String(tier));
    el.starX.textContent = 'x' + (tier || 1);
    if (grew) {
      starPop = !starPop;
      el.starSlot.className = 'starSlot ' + (starPop ? 'pA' : 'pB');
    } else if (el.starSlot.className !== 'starSlot') {
      el.starSlot.className = 'starSlot';
    }
  }

  function showAward(a) {
    const name = (a && a.name) ? String(a.name) : 'Trick';
    const pts = Math.max(0, Math.round(Number(a && a.points) || 0));
    const starHit = STAR_BONUS_RE.exec(name);
    if (starHit) {
      bankedStar = STAR_SLOT(Number(starHit[1]) || 0);
      bankedStarT0 = now();
    }
    el.awName.textContent = name;
    el.awPts.textContent = '+' + commafy(pts);
    awardKick = !awardKick;
    el.award.className = 'award on ' + (awardKick ? 'kA' : 'kB');
    awardOn = true;
    awardT0 = now();
  }

  function update(dt) {
    const step = Number(dt) > 0 ? Number(dt) : 1 / 60;
    const r = refs.riderState();
    const t = refs.trickState();
    if (!r || !t) return;

    // ---- score ---------------------------------------------------------
    setScore(t.score);

    // ---- speed (km/h) --------------------------------------------------
    const vx = r.vel ? r.vel[0] : 0, vz = r.vel ? r.vel[2] : 0;
    const kmh = Math.round(Math.sqrt(vx * vx + vz * vz) * 3.6);
    if (kmh !== cSpeed) {
      cSpeed = kmh;
      el.speed.textContent = String(kmh);
      // V_CAP is 33 m/s = ~119 km/h; the strip reads full at the cap
      const f = kmh > 119 ? 100 : (kmh / 119) * 100;
      el.spdFill.style.width = f.toFixed(1) + '%';
    }
    const hot = kmh >= 95 ? 1 : 0;
    if (hot !== cHot) { cHot = hot; root.setAttribute('data-hot', String(hot)); }

    // ---- boost meter + tier ladder -------------------------------------
    setMeter(Number(t.meter) || 0);

    // ---- TRICKY chain --------------------------------------------------
    let lit = Math.round(Number(t.trickyLetters) || 0);
    lit = lit < 0 ? 0 : lit > 6 ? 6 : lit;
    setTricky(lit, !!t.tricky);

    // ---- STAR multiplier (pending, else the just-banked one) -----------
    const pending = STAR_SLOT(Math.round(Number(t.star ?? t._star ?? 0)) || 0);
    if (bankedStar && now() - bankedStarT0 > 1400) bankedStar = 0;
    setStar(pending || bankedStar);

    // ---- jump tally / chain multiplier / air chips ----------------------
    const js = Math.max(0, Math.round(Number(t.jumpScore) || 0));
    const jOn = js > 0 ? 1 : 0;
    if (jOn !== cJumpOn) { cJumpOn = jOn; el.chipJump.setAttribute('data-on', String(jOn)); }
    if (jOn && js !== cJump) { cJump = js; el.jv.textContent = '+' + commafy(js); }
    const cm = Math.round(chainMult(t) * 10);
    const cOn = (cm > 10 && !r.onGround) ? 1 : 0;
    if (cOn !== cChainOn) { cChainOn = cOn; el.chipChain.setAttribute('data-on', String(cOn)); }
    if (cOn && cm !== cChain) { cChain = cm; el.cv.textContent = 'x' + (cm / 10).toFixed(1); }
    const aOn = r.onGround ? 0 : 1;
    if (aOn !== cAirOn) { cAirOn = aOn; el.chipAir.setAttribute('data-on', String(aOn)); }
    if (aOn) {
      const a = Math.round((Number(r.airTime) || 0) * 10);
      if (a !== cAir) { cAir = a; el.av.textContent = (a / 10).toFixed(1) + 's'; }
    }

    // ---- race band: run clock always, POS only with a real source ------
    runT += step;
    const race = raceRef ? raceRef() : null;
    const tSec = race && Number.isFinite(Number(race.time)) ? Number(race.time) : runT;
    const tenth = Math.round(tSec * 10);
    if (tenth !== cClock) { cClock = tenth; el.clock.textContent = clockStr(tenth / 10); }
    const place = race && Number.isFinite(Number(race.place)) ? Math.round(Number(race.place)) : 0;
    const pOn = place > 0 ? 1 : 0;
    if (pOn !== cPosOn) { cPosOn = pOn; el.posBox.setAttribute('data-on', String(pOn)); }
    if (pOn) {
      if (place !== cPos) { cPos = place; el.pos.textContent = ORD[place] || (place + 'th'); }
      const of = race && Number.isFinite(Number(race.of)) ? Math.round(Number(race.of)) : 0;
      if (of !== cPosOf) { cPosOf = of; el.posOf.textContent = of > 0 ? '/' + of : ''; }
    }

    // ---- boost-active detection (physics meter is draining) + TRICKY ----
    const bm = Number(r.boostMeter);
    if (Number.isFinite(bm)) {
      if (prevBoostMeter >= 0 && bm < prevBoostMeter - 1e-7) boostHold = 0.3;
      else boostHold = boostHold > step ? boostHold - step : 0;
      prevBoostMeter = bm;
    }
    const state = t.tricky ? 'tricky' : (boostHold > 0 ? 'boost' : 'off');
    if (state !== cState) {
      cState = state;
      if (state !== 'off') el.badgeTxt.textContent = state === 'tricky' ? 'Tricky' : 'Boost';
      el.badge.setAttribute('data-state', state);
    }

    // ---- award banner (REAL-time lifetime, see header note) -------------
    const list = t.awards;
    if (list !== awardsRef) { awardsRef = list; awardCount = list ? list.length : 0; }
    if (list && list.length > awardCount) {
      awardCount = list.length;
      showAward(list[list.length - 1]);
    } else if (list && list.length < awardCount) {
      awardCount = list.length;
    }
    if (awardOn && now() - awardT0 > 1500) {
      awardOn = false;
      el.award.className = 'award';
    }
  }

  return { update };
}
