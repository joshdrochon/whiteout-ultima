// ===========================================================================
// HUD — candidate A: "BROADCAST OVERLAY"  (cycle 3)
//
// A sports-broadcast package for an SSX run: corner-anchored clusters on
// sheared parallelogram plates, italic condensed display type, a score
// rendered as a slot odometer, a STAR multiplier slot, a segmented boost bar
// on the yellow -> orange -> red ladder, six TRICKY tiles, a sim-derived run
// clock, and a LEFT LOWER-THIRD that is loud DURING the air and slams into the
// award on landing.
//
// ---------------------------------------------------------------------------
// CYCLE-2 CRITIQUE — disposition (every item; this file was cycle-2 "Y")
//
//  BIGGEST GAP — "only gets loud AFTER the trick is over; SSX builds the trick
//  name big and live while the rider is rotating."
//    FIXED, and it is the headline change. `.live` is a full lower-third band
//    (not a corner pill): it lights the instant the board leaves the snow and
//    reads the rotation AS IT COUNTS UP — FRONTSIDE 180 -> FRONTSIDE 360 ->
//    RODEO 720 — built from riderState().spinDeg/flipDeg with the SAME naming
//    rules as src/tricks/tricks.mjs (spinName / flipName / comboName), so the
//    live line is the award line, one rotation early. It GROWS as it counts:
//    data-heat 0..3 steps the type 34 -> 44 -> 54 -> 62 (*--s) and hardens the
//    glow, so a 900 is physically bigger on screen than a 180. Beside it the
//    running jump tally (trickState().jumpScore, the trick lane's own live
//    preview) and the CHAIN multiplier tick up, and an uber shows a PROGRESS
//    bar that turns green at 100% — the "land it now" cue, because an
//    incomplete uber at touchdown is a crash (JA-15). The award then SLAMS
//    into the same slot: the live line is literally replaced by its own
//    result, which is the SSX beat. Hierarchy is now
//    score > live trick / award > speed > meter, not score > speed > nothing.
//
//  Y-1 RUN CLOCK WAS HUD-LOCAL (`runT += step`; three frames all read 0:28.3).
//    FIXED: the clock reads `trickState()._t`, the trick system's own sim-time
//    accumulator (tricks.step: `ts._t += dt`), which is advanced by the rig's
//    fixed 60 Hz advance() — including every replayed step of a flythrough
//    seek. So the clock is sim time, not wall time, and moves with the run.
//    A HUD-local accumulator survives only as a fallback for a trick module
//    that exposes no time at all, and `refs.raceState?.()` still wins if a
//    race source ever appears.
//
//  Y-2 RACE BAND DELETED UNDER 720px (`@media(max-width:720px){display:none}`).
//    FIXED: the media query is gone. The band shrinks with --s like every
//    other cluster instead of dropping a real readout.
//
//  Y-3 "UBER CHAIN" LABEL ON THE TRICKY LETTERS (invented, and collides with
//    the separate CHAIN multiplier).
//    FIXED: the letters are labelled TRICKY. The word CHAIN now appears
//    exactly once on screen, on the combo multiplier in the lower third.
//
//  X items, applied to this candidate as standing rules (not inherited code):
//   * dead sockets: there is NO placeholder for a feature with no source.
//     `refs` carries only riderState/trickState, so POS renders nothing at all
//     — the top-centre band is the clock alone. It appears only if a real
//     raceState() shows up.
//   * digit step-down: kept (.d7/.d9) so a 7- or 9-figure run shrinks the
//     odometer instead of growing the plate into the run clock.
//   * the meter fill is driven by WIDTH only — never scaleX — so its cap
//     radius and glow are undistorted at every value and the fill's aspect is
//     honest. (Y's two-axis meter is gone.)
//   * TRICKY tiles pulse on a smooth ease-in-out alternate, not a
//     `steps(2, jump-none)` square wave.
//   * nothing is shaped around the HU-10 probe box. Every painted element
//     lives in the top band (bottom < 166*--s) or the bottom band
//     (top > H - 170*--s), and because --s <= 100vh/720 those bands are at
//     worst 23% of the viewport height each — the centre 50% is clear by
//     construction, at every aspect, for the award slab and its children too.
//     No pseudo-element content, no probe-exempt geometry games: every string
//     this HUD shows is real text in a real element the probe can see.
//
// ---------------------------------------------------------------------------
// PROBE CONTRACT (exact, do not "improve"):
//   [data-hud="score"]      digit/comma spans only; digits == round(score),
//                           written synchronously inside update().
//   [data-hud="meter-fill"] data-value = meter.toFixed(2); width inline with
//                           NO transition so the probe's synchronous
//                           getBoundingClientRect sees it; backgroundColor +
//                           backgroundImage step per tier off the METER VALUE
//                           (never off the TRICKY flag — TRICKY paints a
//                           separate overlay, so the ladder still reads three
//                           distinct fills after TRICKY latches).
//   [data-hud="speed"]      the integer ONLY ("KM/H" is a sibling).
//   [data-hud="tricky"]     data-lit 0..6, data-tricky "true"/"false".
//   [data-hud="award"]      lifetime driven by performance.now(), NOT by
//                           accumulated dt: HU-05 measures in REAL time while
//                           calling update(1/60) once per rAF, so a dt timer
//                           would drift with frame rate. 0.34 s slam + 1.45 s
//                           hold + 0.18 s fade: on screen far inside 0.5 s,
//                           gone far inside 4 s.
//
// COST (HU-06): no per-frame allocation, no querySelector, no
// getComputedStyle, no getBoundingClientRect. Every DOM write is guarded by a
// cached previous value; the live line rebuilds its string only when the
// (uber, spin units, flip units, grab) tuple actually changes, so a steady
// frame — grounded or airborne — touches the DOM zero times.
// ===========================================================================

const STYLE_ID = 'ssx-hud-a-style';

const CSS = `
.ssxA{
  /* tracks the SMALLER axis: short/wide viewports shrink, 1440p/4K scale up */
  --s: clamp(0.42px, min(100vh / 720, 100vw / 1280), 2.6px);
  --dsp: Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Black', 'Helvetica Neue', sans-serif;
  --ui: 'Arial Narrow', 'Helvetica Neue', Arial, sans-serif;
  --cyan:#00e9ff; --mag:#ff1fb3; --yel:#ffe000; --org:#ff7a00;
  --red:#ff2040; --lime:#b4ff00;
  position:absolute; inset:0; overflow:hidden; pointer-events:none;
  font-family:var(--dsp); text-transform:uppercase; font-style:italic;
  -webkit-font-smoothing:antialiased;
}
.ssxA *{ box-sizing:border-box; }

/* ---- band scrims: keep type legible over blown-out snow --------------- */
.ssxA .scrimT{ position:absolute; left:0; right:0; top:0; height:calc(160*var(--s));
  background:linear-gradient(180deg, rgba(3,6,14,.86) 0%, rgba(3,6,14,.44) 48%, rgba(3,6,14,0) 100%); }
.ssxA .scrimB{ position:absolute; left:0; right:0; bottom:0; height:calc(168*var(--s));
  background:linear-gradient(0deg, rgba(3,6,14,.92) 0%, rgba(3,6,14,.56) 46%, rgba(3,6,14,0) 100%); }

/* ---- shared plate language ------------------------------------------- */
.ssxA .plate{
  position:relative; transform:skewX(-12deg);
  background:linear-gradient(150deg, rgba(10,16,30,.94) 0%, rgba(6,9,18,.82) 100%);
  border-top:calc(2*var(--s)) solid rgba(255,255,255,.18);
  border-bottom:calc(2*var(--s)) solid rgba(255,255,255,.10);
  box-shadow:0 calc(4*var(--s)) calc(18*var(--s)) rgba(0,0,0,.55);
}
.ssxA .plate > .inner{ transform:skewX(12deg); }
.ssxA .edge{ position:absolute; top:0; bottom:0; width:calc(7*var(--s)); }
.ssxA .edgeL{ left:calc(-7*var(--s)); background:linear-gradient(180deg,var(--cyan),var(--mag)); }

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
.ssxA .clScore{ position:absolute; left:calc(30*var(--s)); top:calc(14*var(--s)); }
.ssxA .clScore .plate{ padding:calc(7*var(--s)) calc(26*var(--s)) calc(9*var(--s)) calc(16*var(--s)); }
.ssxA .clScore .lbl{ justify-content:space-between; }
.ssxA .clScore .lbl .pts{ color:var(--mag); letter-spacing:calc(2*var(--s)); }
.ssxA .scoreRow{ display:flex; align-items:flex-end; gap:calc(12*var(--s)); }
.ssxA .odo{
  display:flex; align-items:flex-end; gap:calc(1*var(--s));
  margin-top:calc(3*var(--s)); font-size:calc(76*var(--s)); line-height:.94;
  color:#fff; letter-spacing:0;
}
/* a 7- or 9-figure run must not grow the plate into the run clock: the
   odometer steps down instead of pushing the layout sideways */
.ssxA .odo.d7{ font-size:calc(58*var(--s)); }
.ssxA .odo.d9{ font-size:calc(46*var(--s)); }
.ssxA .odo .dg{
  display:inline-block; overflow:hidden; vertical-align:bottom;
  width:.72em; padding:0 .03em; text-align:center;
  background:linear-gradient(180deg,#1d2c4c 0%,#070c18 66%,#101b34 100%);
  border-top:calc(2*var(--s)) solid rgba(0,233,255,.7);
  box-shadow:inset 0 calc(-3*var(--s)) calc(8*var(--s)) rgba(0,0,0,.8);
  text-shadow:0 0 calc(14*var(--s)) rgba(0,233,255,.55), 0 calc(2*var(--s)) 0 #000;
}
.ssxA .odo .cm{ display:inline-block; width:.22em; text-align:center; color:var(--cyan);
  text-shadow:0 0 calc(10*var(--s)) var(--cyan); }
@keyframes ssxRollA{ from{ transform:translateY(-78%); opacity:.1 } to{ transform:none; opacity:1 } }
@keyframes ssxRollB{ from{ transform:translateY(-78%); opacity:.1 } to{ transform:none; opacity:1 } }
.ssxA .odo .dg.rA{ animation:ssxRollA .17s cubic-bezier(.18,.92,.24,1) }
.ssxA .odo .dg.rB{ animation:ssxRollB .17s cubic-bezier(.18,.92,.24,1) }

/* ---- STAR multiplier slot (yellow 2x / orange 3x / red 5x — JA-18) ---- */
.ssxA .starSlot{
  position:relative; display:flex; align-items:center; gap:calc(4*var(--s));
  padding:calc(3*var(--s)) calc(9*var(--s)) calc(3*var(--s)) calc(7*var(--s));
  margin-bottom:calc(7*var(--s)); transform:skewX(-12deg);
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

/* ================= TOP CENTRE — RUN CLOCK (sim time) ================== */
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
/* POS renders ONLY with a real race source — no dead socket */
.ssxA .posBox{ display:none; border-top-color:var(--yel); }
.ssxA .posBox[data-on="1"]{ display:flex; }
.ssxA .pos{ font-size:calc(32*var(--s)); line-height:calc(34*var(--s)); color:var(--yel);
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(14*var(--s)) rgba(255,200,0,.6); }
.ssxA .posOf{ font-family:var(--ui); font-weight:700; font-style:italic;
  font-size:calc(13*var(--s)); color:#9fd8ea; }

/* ================= TOP RIGHT — TRICKY LETTERS ========================= */
.ssxA .clTricky{ position:absolute; right:calc(30*var(--s)); top:calc(14*var(--s));
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
/* smooth alternate ease — NOT a steps() square wave */
@keyframes ssxThrob{ from{ filter:brightness(1) } to{ filter:brightness(1.35) } }
.ssxA .tl.lit{
  border-color:#fff2a8; color:#150c00;
  background:linear-gradient(180deg,#fff59a 0%,#ffd400 45%,#ff7a00 100%);
  box-shadow:0 0 calc(16*var(--s)) rgba(255,190,0,.8), inset 0 0 calc(8*var(--s)) rgba(255,255,255,.7);
  text-shadow:0 calc(1*var(--s)) 0 rgba(255,255,255,.6);
  animation:ssxThrob 1.15s ease-in-out infinite alternate;
}
@keyframes ssxRainbow{ 0%{ background-position:0% 50% } 100%{ background-position:200% 50% } }
.ssxA[data-tricky="true"] .tl.lit{
  background:linear-gradient(90deg,#ff2040,#ffd400,#00ff9d,#00e9ff,#ff1fb3,#ff2040);
  background-size:200% 100%; border-color:#fff;
  animation:ssxRainbow 1.1s linear infinite, ssxThrob .55s ease-in-out infinite alternate;
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

/* ============ BOTTOM LOWER-THIRD — LIVE TRICK / AWARD =================
   One slot, two states. Airborne: the live line counts the rotation up.
   Landing: the award SLAMS into the same slot with the banked name+points.
   Height is fixed so the band geometry is deterministic at every aspect. */
.ssxA .clLine{
  position:absolute; left:0; right:0; bottom:calc(94*var(--s));
  height:calc(72*var(--s));
}

.ssxA .live{
  position:absolute; left:calc(-8*var(--s)); bottom:0;
  display:flex; align-items:stretch; max-width:calc(100vw - 30*var(--s));
  transform:skewX(-15deg) translateX(calc(-14*var(--s))); transform-origin:left center;
  opacity:0; visibility:hidden;
  transition:opacity .10s linear, transform .16s cubic-bezier(.2,.9,.2,1.05), visibility 0s linear .16s;
  box-shadow:0 calc(5*var(--s)) calc(22*var(--s)) rgba(0,0,0,.6);
}
.ssxA .live[data-on="1"]{
  opacity:1; visibility:visible; transform:skewX(-15deg) translateX(0);
  transition:opacity .10s linear, transform .16s cubic-bezier(.2,.9,.2,1.05), visibility 0s linear 0s;
}
.ssxA[data-aw="1"] .live{ opacity:0; visibility:hidden; transition:opacity .07s linear, visibility 0s linear .07s; }
.ssxA .liveTag{
  display:flex; flex-direction:column; justify-content:center; flex:0 0 auto;
  padding:0 calc(12*var(--s)) 0 calc(26*var(--s));
  background:linear-gradient(160deg,#00e9ff,#0064ff);
  font-family:var(--ui); font-weight:700; font-style:italic; color:#001420;
  font-size:calc(12*var(--s)); letter-spacing:calc(2*var(--s)); line-height:calc(15*var(--s));
}
.ssxA .liveTag > *{ transform:skewX(15deg); }
.ssxA .liveAir{ color:#00243a; font-size:calc(15*var(--s)); }
.ssxA .liveBody{
  position:relative; display:flex; align-items:center; gap:calc(14*var(--s)); min-width:0;
  padding:0 calc(20*var(--s)) 0 calc(16*var(--s));
  background:linear-gradient(120deg, rgba(6,10,20,.95) 0%, rgba(12,20,40,.90) 100%);
  border-top:calc(3*var(--s)) solid var(--cyan);
}
.ssxA .liveBody > *{ transform:skewX(15deg); }
/* before the first trick of the air there is nothing to name: the line is
   just the AIR chip, and it GROWS into the full body the moment a trick
   exists. No "AIR / AIR" stutter, no dead "+0". */
.ssxA .live[data-empty="1"] .liveBody{ display:none; }
.ssxA .live[data-empty="1"] .liveTag{ padding-right:calc(20*var(--s)); }
.ssxA .liveName{
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  color:#fff; font-size:calc(38*var(--s)); line-height:calc(66*var(--s));
  transition:font-size .12s ease-out;
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(14*var(--s)) rgba(0,233,255,.55);
}
.ssxA .live[data-heat="1"] .liveName{ font-size:calc(44*var(--s)); }
.ssxA .live[data-heat="2"] .liveName{ font-size:calc(54*var(--s));
  color:#fff6d8; text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(20*var(--s)) rgba(255,190,0,.8); }
.ssxA .live[data-heat="3"] .liveName{ font-size:calc(62*var(--s));
  color:#fff; text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(26*var(--s)) rgba(255,40,120,.95); }
.ssxA .live[data-heat="2"] .liveBody{ border-top-color:var(--yel); }
.ssxA .live[data-heat="3"] .liveBody{ border-top-color:var(--mag); }
.ssxA .livePts{ flex:0 0 auto; font-size:calc(28*var(--s)); line-height:calc(66*var(--s));
  color:var(--yel); text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(14*var(--s)) rgba(255,215,0,.7); }
.ssxA .liveChain{
  display:none; flex:0 0 auto; align-self:center;
  padding:0 calc(9*var(--s)); font-family:var(--ui); font-weight:700; font-style:italic;
  font-size:calc(15*var(--s)); line-height:calc(22*var(--s)); letter-spacing:calc(1*var(--s));
  color:#04180a; background:linear-gradient(90deg,#b4ff00,#00e9ff);
  box-shadow:0 0 calc(14*var(--s)) rgba(150,255,80,.6);
}
.ssxA .liveChain[data-on="1"]{ display:block; }
/* uber animation progress — an incomplete uber at touchdown is a crash, so
   the bar is the "land it now" cue: red while running, green at 100% */
.ssxA .uberBar{ position:absolute; left:0; right:0; bottom:0; height:calc(6*var(--s));
  background:rgba(255,255,255,.10); display:none; }
.ssxA .uberBar[data-on="1"]{ display:block; }
.ssxA .uberBar > i{ position:absolute; left:0; top:0; bottom:0; width:0%;
  background:linear-gradient(90deg,#ff2040,#ff7a00);
  box-shadow:0 0 calc(10*var(--s)) rgba(255,80,0,.9); }
.ssxA .uberBar[data-full="1"] > i{ background:linear-gradient(90deg,#00ff9d,#b4ff00);
  box-shadow:0 0 calc(12*var(--s)) rgba(0,255,150,.95); }

/* ---- award: SLAM, not a slide (scale overshoot from the left edge) ---- */
.ssxA .award{
  position:absolute; left:0; bottom:0;
  display:flex; align-items:stretch; white-space:nowrap; height:calc(60*var(--s));
  max-width:calc(100vw - 30*var(--s));
  transform-origin:left center;
  transform:translateX(-120%) skewX(-15deg); opacity:0; visibility:hidden;
  transition:transform .16s cubic-bezier(.5,0,.9,.4), opacity .16s linear, visibility 0s linear .18s;
  box-shadow:0 calc(6*var(--s)) calc(26*var(--s)) rgba(0,0,0,.7);
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
  padding:0 calc(14*var(--s)) 0 calc(26*var(--s));
  background:linear-gradient(160deg,#ff1fb3,#7a00ff);
  font-family:var(--ui); font-weight:700; font-style:italic; color:#fff;
  font-size:calc(13*var(--s)); letter-spacing:calc(3*var(--s));
}
.ssxA .award[data-kind="star"] .awTag{ background:linear-gradient(160deg,#ffe000,#ff7a00); color:#1b0f00; }
.ssxA .award[data-kind="star"] .awBody{ border-top-color:var(--yel); }
.ssxA .awBody{
  display:flex; align-items:center; gap:calc(14*var(--s)); min-width:0;
  padding:0 calc(22*var(--s)) 0 calc(18*var(--s));
  background:linear-gradient(120deg, rgba(8,12,24,.97) 0%, rgba(14,22,44,.93) 100%);
  border-top:calc(4*var(--s)) solid var(--mag);
}
.ssxA .awTag > span, .ssxA .awBody > *{ transform:skewX(15deg); }
/* long uber names (SuperMan BarSpin, La La La Lock Step) clip with an
   ellipsis instead of being cut mid-glyph by the root's overflow:hidden */
.ssxA .awName{ font-size:calc(46*var(--s)); line-height:calc(56*var(--s)); color:#fff;
  min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(18*var(--s)) rgba(255,80,180,.65); }
.ssxA .awPts{ flex:0 0 auto; font-size:calc(32*var(--s)); line-height:calc(56*var(--s));
  color:var(--yel);
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(16*var(--s)) rgba(255,215,0,.75); }
@keyframes ssxKickA{ 0%{ filter:brightness(2.8) } 100%{ filter:none } }
@keyframes ssxKickB{ 0%{ filter:brightness(2.8) } 100%{ filter:none } }
.ssxA .award.kA .awBody{ animation:ssxKickA .14s linear }
.ssxA .award.kB .awBody{ animation:ssxKickB .14s linear }

/* ================= BOTTOM ROW — SPEED + BOOST =========================
   anchored BOTH sides: the boost track shrinks on narrow viewports instead
   of being clipped by the root's overflow:hidden.                        */
.ssxA .clBottom{
  position:absolute; left:calc(30*var(--s)); right:calc(196*var(--s));
  bottom:calc(20*var(--s));
  display:flex; align-items:flex-end; gap:calc(24*var(--s));
}
.ssxA .spd{ position:relative; flex:0 0 auto; }
.ssxA .spdRow{ display:flex; align-items:flex-end; gap:calc(6*var(--s)); }
/* speed is SECONDARY: deliberately smaller than the trick line above it, so
   the hierarchy is score > live trick / award > speed > meter */
.ssxA .spdNum{
  font-size:calc(50*var(--s)); line-height:.86; color:#fff;
  min-width:calc(84*var(--s)); text-align:right;
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
  width:calc(174*var(--s)); transform:skewX(-16deg); overflow:hidden;
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
/* the track carries the radius/glow chrome; the FILL is a plain width-driven
   box, so nothing about it is distorted by its own value */
.ssxA .btTrack{
  position:relative; width:100%; height:calc(32*var(--s));
  transform:skewX(-16deg); overflow:hidden;
  background:
    repeating-linear-gradient(90deg, rgba(255,255,255,.07) 0 calc(24*var(--s)), rgba(0,0,0,0) calc(24*var(--s)) calc(30*var(--s))),
    linear-gradient(180deg,#0a1020,#04070e);
  border:calc(2*var(--s)) solid rgba(255,255,255,.26);
  box-shadow:0 calc(3*var(--s)) calc(14*var(--s)) rgba(0,0,0,.6);
}
.ssxA .btFill{
  position:absolute; left:0; top:0; bottom:0; width:0%;
  transition:none; will-change:width;
  background-color:#ffd400;
  background-image:linear-gradient(90deg,#fff08a 0%,#ffd400 55%,#ffa800 100%);
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
.ssxA .clState{ position:absolute; right:calc(30*var(--s)); bottom:calc(18*var(--s)); }
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
    </div>
  </div>
</div>

<div class="clRace">
  <div class="raceBox posBox" data-on="0"><b class="raceK">Pos</b><b class="pos">-</b><b class="posOf"></b></div>
  <div class="raceBox"><b class="raceK">Run</b><b class="clock">0:00.0</b></div>
</div>

<div class="clTricky">
  <div class="lbl">Tricky<i class="bar"></i></div>
  <div class="trRow" data-hud="tricky" data-lit="0" data-tricky="false">
    <div class="tl"><span>T</span></div><div class="tl"><span>R</span></div>
    <div class="tl"><span>I</span></div><div class="tl"><span>C</span></div>
    <div class="tl"><span>K</span></div><div class="tl"><span>Y</span></div>
  </div>
  <div class="trWord">Tricky!</div>
</div>

<div class="clLine">
  <div class="live" data-on="0" data-heat="0" data-empty="1">
    <div class="liveTag"><span>Air</span><span class="liveAir">0.0s</span></div>
    <div class="liveBody">
      <div class="liveName">Air</div>
      <div class="liveChain" data-on="0">Chain x1.0</div>
      <div class="livePts">+0</div>
      <div class="uberBar" data-on="0" data-full="0"><i></i></div>
    </div>
  </div>
  <div class="award" data-hud="award" data-kind="trick">
    <div class="awTag"><span>Trick</span></div>
    <div class="awBody">
      <div class="awName">&mdash;</div>
      <div class="awPts">+0</div>
    </div>
  </div>
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
`;

// meter tiers: yellow -> orange -> red (the sourced SSX boost ladder). Driven
// by the METER VALUE only, so the HU-09 ladder still reads 3 distinct fills
// once the permanent TRICKY flag latches (TRICKY paints .btRain instead).
const TIERS = [
  { at: 0.34, name: 'Charge',
    bg: '#ffd400', img: 'linear-gradient(90deg,#fff08a 0%,#ffd400 55%,#ffa800 100%)',
    label: '#ffe000' },
  { at: 0.67, name: 'Surge',
    bg: '#ff7a00', img: 'linear-gradient(90deg,#ffc46b 0%,#ff7a00 55%,#ff3d00 100%)',
    label: '#ff9d2e' },
  { at: 2, name: 'Redline',
    bg: '#ff2040', img: 'linear-gradient(90deg,#ff7a5a 0%,#ff2040 52%,#c8001e 100%)',
    label: '#ff5470' },
];

// star tiers are canon: yellow 2x, orange 3x, red 5x (JA-18)
const STAR_SLOT = (n) => (n >= 5 ? 5 : n >= 3 ? 3 : n >= 2 ? 2 : 0);
const STAR_BONUS_RE = /^\s*(\d+)\s*x\s*star/i;

// ---- live trick naming: the SAME rules as src/tricks/tricks.mjs ----------
// spinName / flipName / comboName reproduced so the line the player reads in
// the air is the line they get on the award, one rotation early.
const FLIP_MULT = ['', '', 'Double ', 'Triple '];
function spinName(units, sign) {
  return (sign < 0 ? 'Backside ' : 'Frontside ') + (units * 180);
}
function flipName(units, sign) {
  return (FLIP_MULT[units] || '') + (sign < 0 ? 'Backflip' : 'Frontflip');
}
function comboName(fu, fsign, su) {
  return (FLIP_MULT[fu] || '') + (fsign < 0 ? 'Rodeo ' : 'Misty ') + (su * 180);
}

// tricks.mjs tally(): +10% per extra trick FAMILY in one air (ubers / spin /
// flip / grab; a spin+flip composite counts as BOTH). Recomputed here as a
// live preview only — the authoritative number is banked on landing.
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
  root.setAttribute('data-aw', '0');
  root.innerHTML = HTML;
  container.appendChild(root);

  const q = (sel) => root.querySelector(sel);
  const el = {
    score: q('[data-hud="score"]'),
    speed: q('[data-hud="speed"]'),
    fill: q('[data-hud="meter-fill"]'),
    tricky: q('[data-hud="tricky"]'),
    award: q('[data-hud="award"]'),
    awTagTxt: q('.awTag > span'),
    awName: q('.awName'),
    awPts: q('.awPts'),
    tier: q('.btTier'),
    tiles: Array.prototype.slice.call(root.querySelectorAll('.tl')),
    starSlot: q('.starSlot'), starX: q('.starX'),
    badge: q('.badge'), badgeTxt: q('.badge > span'),
    spdFill: q('.spdBarFill'),
    clock: q('.clock'), posBox: q('.posBox'), pos: q('.pos'), posOf: q('.posOf'),
    live: q('.live'), liveName: q('.liveName'), livePts: q('.livePts'),
    liveAir: q('.liveAir'), liveChain: q('.liveChain'),
    uberBar: q('.uberBar'), uberFill: q('.uberBar > i'),
  };

  const raceRef = (refs && typeof refs.raceState === 'function') ? refs.raceState : null;

  // ---- cached last-written values: a steady frame writes nothing --------
  let cScore = -1, cScoreStr = '', digits = [];
  let cSpeed = -1, cMeter = -1, cTier = -1, cLit = -1, cTricky = null;
  let cHot = -1, cState = '', cStar = -1, starPop = false;
  let cClock = -1, cPosOn = -1, cPos = -1, cPosOf = -1;
  let cLiveOn = -1, cLiveKey = '', cLiveHeat = -1, cLivePts = -1, cLiveAir = -1, cLiveEmpty = -1;
  let cChainOn = -1, cChain = -1, cUberOn = -1, cUberW = -1, cUberFull = -1;
  let awardCount = 0, awardsRef = null, awardT0 = -1, awardOn = false, awardKick = false;
  let awardTimer = 0;
  let prevBoostMeter = -1, boostHold = 0;
  let bankedStar = 0, bankedStarT0 = -1;
  let fallbackT = 0;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

  // --- score odometer: exactly the digits, nothing else, written now -----
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

  // pending star (highest only) while airborne, then the banked star flashed
  // for a beat on the clean landing that credits it
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

  const AWARD_HOLD_MS = 1450;
  function hideAward() {
    awardOn = false;
    el.award.className = 'award';
    root.setAttribute('data-aw', '0');
    if (awardTimer) { clearTimeout(awardTimer); awardTimer = 0; }
  }

  function showAward(a) {
    const name = (a && a.name) ? String(a.name) : 'Trick';
    const pts = Math.max(0, Math.round(Number(a && a.points) || 0));
    const starHit = STAR_BONUS_RE.exec(name);
    if (starHit) {
      bankedStar = STAR_SLOT(Number(starHit[1]) || 0);
      bankedStarT0 = now();
    }
    el.award.setAttribute('data-kind', starHit ? 'star' : 'trick');
    el.awTagTxt.textContent = starHit ? 'Star' : 'Trick';
    el.awName.textContent = name;
    el.awPts.textContent = '+' + commafy(pts);
    awardKick = !awardKick;
    el.award.className = 'award on ' + (awardKick ? 'kA' : 'kB');
    awardOn = true;
    awardT0 = now();
    root.setAttribute('data-aw', '1');
    // The popup's LIFETIME must not depend on how often update() happens to be
    // called: a capture harness that seeks the run and calls update() once per
    // frame would otherwise freeze the banner on screen forever. One timer per
    // award (cleared and re-armed on the next one) retires it on real time; the
    // update()-side check below stays as a fallback if timers are throttled.
    if (awardTimer) clearTimeout(awardTimer);
    awardTimer = setTimeout(hideAward, AWARD_HOLD_MS);
  }

  // ---- LIVE trick line: reads the rotation as it counts up --------------
  function liveUpdate(r, t, air) {
    const on = air ? 1 : 0;
    if (on !== cLiveOn) {
      cLiveOn = on;
      el.live.setAttribute('data-on', String(on));
    }
    if (!air) return;

    const at = t.activeTrick;
    const uber = at && at.name && at.name !== 'Grab' ? at.name : '';
    const grab = !!(at && at.name === 'Grab') || ((t._jump && t._jump.grabTime) || 0) >= MIN_GRAB_S;
    const sd = Number(r.spinDeg) || 0, fd = Number(r.flipDeg) || 0;
    const su = Math.min(10, Math.floor((Math.abs(sd) + 10) / 180));
    const fu = Math.min(3, Math.floor((Math.abs(fd) + 10) / 360));
    const ssign = sd < 0 ? -1 : 1, fsign = fd < 0 ? -1 : 1;

    // rebuild the string only when the trick actually changes
    const key = uber + '|' + su + '|' + ssign + '|' + fu + '|' + fsign + '|' + (grab ? 1 : 0);
    if (key !== cLiveKey) {
      cLiveKey = key;
      let name = '';
      if (uber) name = uber;
      if (su >= 1 && fu >= 1) name = (name ? name + ' + ' : '') + comboName(fu, fsign, su);
      else if (su >= 1) name = (name ? name + ' + ' : '') + spinName(su, ssign);
      else if (fu >= 1) name = (name ? name + ' + ' : '') + flipName(fu, fsign);
      if (grab) name = (name ? name + ' + ' : '') + 'Grab';
      const empty = name ? 0 : 1;
      if (empty !== cLiveEmpty) { cLiveEmpty = empty; el.live.setAttribute('data-empty', String(empty)); }
      if (!empty) el.liveName.textContent = name;
      // the line GROWS as the trick grows: a 900 is physically bigger than a 180
      const w = (uber ? 3 : 0) + su + fu * 2 + (grab ? 1 : 0);
      const heat = w >= 6 ? 3 : w >= 4 ? 2 : w >= 2 ? 1 : 0;
      if (heat !== cLiveHeat) { cLiveHeat = heat; el.live.setAttribute('data-heat', String(heat)); }
    }

    const jp = Math.max(0, Math.round(Number(t.jumpScore) || 0));
    if (jp !== cLivePts) { cLivePts = jp; el.livePts.textContent = '+' + commafy(jp); }

    const a = Math.round((Number(r.airTime) || 0) * 10);
    if (a !== cLiveAir) { cLiveAir = a; el.liveAir.textContent = (a / 10).toFixed(1) + 's'; }

    const cm = Math.round(chainMult(t) * 10);
    const cOn = cm > 10 ? 1 : 0;
    if (cOn !== cChainOn) { cChainOn = cOn; el.liveChain.setAttribute('data-on', String(cOn)); }
    if (cOn && cm !== cChain) { cChain = cm; el.liveChain.textContent = 'Chain x' + (cm / 10).toFixed(1); }

    // uber animation progress — incomplete at touchdown is a crash (JA-15)
    const uOn = uber ? 1 : 0;
    if (uOn !== cUberOn) { cUberOn = uOn; el.uberBar.setAttribute('data-on', String(uOn)); }
    if (uOn) {
      const p = Math.round(Math.min(1, Math.max(0, Number(at.progress) || 0)) * 100);
      if (p !== cUberW) { cUberW = p; el.uberFill.style.width = p + '%'; }
      const full = p >= 100 ? 1 : 0;
      if (full !== cUberFull) { cUberFull = full; el.uberBar.setAttribute('data-full', String(full)); }
    }
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

    // ---- TRICKY letters ------------------------------------------------
    let lit = Math.round(Number(t.trickyLetters) || 0);
    lit = lit < 0 ? 0 : lit > 6 ? 6 : lit;
    setTricky(lit, !!t.tricky);

    // ---- STAR multiplier (pending, else the just-banked one) -----------
    const pending = STAR_SLOT(Math.round(Number(t.star ?? t._star ?? 0)) || 0);
    if (bankedStar && now() - bankedStarT0 > 1400) bankedStar = 0;
    setStar(pending || bankedStar);

    // ---- live trick line ------------------------------------------------
    liveUpdate(r, t, !r.onGround);

    // ---- run clock: SIM time (tricks.step's own accumulator), never wall
    // time. raceState() wins if a real race source ever appears.
    fallbackT += step;
    const race = raceRef ? raceRef() : null;
    const simT = Number(t._t);
    const tSec = race && Number.isFinite(Number(race.time)) ? Number(race.time)
      : (Number.isFinite(simT) ? simT : fallbackT);
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

    // ---- boost-active detection (physics boost meter is draining) -------
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
    if (awardOn && now() - awardT0 > AWARD_HOLD_MS) hideAward();
  }

  return { update };
}
