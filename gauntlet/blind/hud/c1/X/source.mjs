// ===========================================================================
// HUD — candidate A: "BROADCAST OVERLAY"
//
// SSX-Tricky loud, read at 120 km/h, built as a sports-broadcast lower-third
// package: corner-anchored clusters on sheared parallelogram plates, italic
// condensed display type, a score rendered as a slot odometer (each digit is
// its own clipped column that rolls when it changes), a segmented boost bar
// with a yellow -> orange -> red tier ladder (rainbow when TRICKY), six
// chevron TRICKY tiles, and award banners that slam in from the left edge on
// a shear.
//
// LAYOUT LAW (HU-10): every painted element lives in the top band (bottom
// < 180 px @720) or the bottom band (top > 540 px @720). The centre 50 % of
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
//                              4.5 s on a slow frame. 2.0 s hold + 0.16 s
//                              fade = gone well inside the window, visible
//                              well inside 0.5 s.
//
// COST (HU-06): no per-frame allocation, no querySelector, no
// getComputedStyle, no getBoundingClientRect. Every DOM write is guarded by a
// cached previous value, so a steady frame touches the DOM zero times.
// ===========================================================================

const STYLE_ID = 'ssx-hud-a-style';

const CSS = `
.ssxA{
  --s: clamp(0.62px, calc(100vh / 720), 1.7px);
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

/* ================= TOP LEFT — SCORE ODOMETER ========================== */
.ssxA .clScore{ position:absolute; left:calc(30*var(--s)); top:calc(16*var(--s)); }
.ssxA .clScore .plate{ padding:calc(7*var(--s)) calc(30*var(--s)) calc(8*var(--s)) calc(16*var(--s)); }
.ssxA .clScore .lbl{ justify-content:space-between; }
.ssxA .clScore .lbl .pts{ color:var(--mag); letter-spacing:calc(2*var(--s)); }
.ssxA .odo{
  display:flex; align-items:flex-end; gap:calc(1*var(--s));
  margin-top:calc(3*var(--s)); font-size:calc(76*var(--s)); line-height:.94;
  color:#fff; letter-spacing:0;
}
.ssxA .odo .dg{
  display:inline-block; overflow:hidden; vertical-align:bottom;
  width:.60em; text-align:center;
  background:linear-gradient(180deg,#131f38 0%,#060a14 62%,#0c1428 100%);
  border-top:calc(2*var(--s)) solid rgba(0,233,255,.55);
  box-shadow:inset 0 calc(-3*var(--s)) calc(8*var(--s)) rgba(0,0,0,.8);
  text-shadow:0 0 calc(14*var(--s)) rgba(0,233,255,.55), 0 calc(2*var(--s)) 0 #000;
}
.ssxA .odo .cm{ display:inline-block; width:.20em; text-align:center; color:var(--cyan);
  text-shadow:0 0 calc(10*var(--s)) var(--cyan); }
@keyframes ssxRollA{ from{ transform:translateY(-78%); opacity:.1 } to{ transform:none; opacity:1 } }
@keyframes ssxRollB{ from{ transform:translateY(-78%); opacity:.1 } to{ transform:none; opacity:1 } }
.ssxA .odo .dg.rA{ animation:ssxRollA .17s cubic-bezier(.18,.92,.24,1) }
.ssxA .odo .dg.rB{ animation:ssxRollB .17s cubic-bezier(.18,.92,.24,1) }

.ssxA .subrow{ display:flex; align-items:center; gap:calc(6*var(--s));
  margin-top:calc(7*var(--s)); height:calc(19*var(--s)); }
.ssxA .subrow .rule{ flex:1; height:calc(5*var(--s)); transform:skewX(-16deg);
  background:linear-gradient(90deg, var(--cyan) 0%, rgba(255,31,179,.85) 45%, rgba(255,31,179,0) 100%); }
.ssxA .chip{
  display:none; align-items:center; gap:calc(5*var(--s)); padding:0 calc(8*var(--s));
  transform:skewX(-12deg); font-family:var(--ui); font-weight:700; font-style:italic;
  font-size:calc(13*var(--s)); letter-spacing:calc(1*var(--s)); line-height:calc(19*var(--s));
}
.ssxA .chip[data-on="1"]{ display:flex; }
.ssxA .chip > *{ transform:skewX(12deg); }
.ssxA .chipJump{ background:linear-gradient(90deg,#ffe000,#ff7a00); color:#1b0f00;
  box-shadow:0 0 calc(14*var(--s)) rgba(255,190,0,.55); }
.ssxA .chipAir{ background:linear-gradient(90deg,#00e9ff,#0077ff); color:#001019;
  box-shadow:0 0 calc(14*var(--s)) rgba(0,220,255,.5); }

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

/* ================= BOTTOM LEFT — SPEED + BOOST ======================== */
.ssxA .clBottom{ position:absolute; left:calc(30*var(--s)); bottom:calc(24*var(--s));
  display:flex; align-items:flex-end; gap:calc(24*var(--s)); }

.ssxA .spd{ position:relative; }
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

.ssxA .boost{ position:relative; }
.ssxA .btHead{ display:flex; align-items:center; justify-content:space-between;
  width:calc(430*var(--s)); margin-bottom:calc(5*var(--s)); }
.ssxA .btTier{ font-size:calc(19*var(--s)); letter-spacing:calc(2*var(--s)); line-height:1;
  color:var(--yel); text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(12*var(--s)) rgba(255,200,0,.6); }
.ssxA .btTrack{
  position:relative; width:calc(430*var(--s)); height:calc(32*var(--s));
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

/* ================= AWARD LOWER-THIRD ================================== */
.ssxA .award{
  position:absolute; left:0; bottom:calc(112*var(--s));
  display:flex; align-items:stretch; white-space:nowrap; max-width:78vw;
  transform:translateX(-118%) skewX(-15deg); opacity:0; visibility:hidden;
  transition:transform .18s cubic-bezier(.12,.9,.2,1.04), opacity .14s linear, visibility 0s linear .2s;
  box-shadow:0 calc(6*var(--s)) calc(26*var(--s)) rgba(0,0,0,.65);
}
.ssxA .award.on{
  transform:translateX(calc(-8*var(--s))) skewX(-15deg); opacity:1; visibility:visible;
  transition:transform .18s cubic-bezier(.12,.9,.2,1.04), opacity .1s linear, visibility 0s linear 0s;
}
.ssxA .awTag{
  display:flex; align-items:center; padding:0 calc(14*var(--s)) 0 calc(24*var(--s));
  background:linear-gradient(160deg,#ff1fb3,#7a00ff);
  font-family:var(--ui); font-weight:700; font-style:italic; color:#fff;
  font-size:calc(13*var(--s)); letter-spacing:calc(3*var(--s));
}
.ssxA .awBody{
  display:flex; align-items:center; gap:calc(14*var(--s));
  padding:calc(6*var(--s)) calc(22*var(--s)) calc(7*var(--s)) calc(18*var(--s));
  background:linear-gradient(120deg, rgba(8,12,24,.97) 0%, rgba(14,22,44,.93) 100%);
  border-top:calc(3*var(--s)) solid var(--cyan);
}
.ssxA .awTag > span, .ssxA .awBody > *{ transform:skewX(15deg); }
.ssxA .awName{ font-size:calc(35*var(--s)); line-height:calc(40*var(--s)); color:#fff;
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(16*var(--s)) rgba(0,233,255,.6); }
.ssxA .awPts{ font-size:calc(27*var(--s)); line-height:calc(40*var(--s)); color:var(--yel);
  text-shadow:0 calc(2*var(--s)) 0 #000, 0 0 calc(14*var(--s)) rgba(255,215,0,.7); }
@keyframes ssxKickA{ 0%{ filter:brightness(2.4) } 100%{ filter:none } }
@keyframes ssxKickB{ 0%{ filter:brightness(2.4) } 100%{ filter:none } }
.ssxA .award.kA .awBody{ animation:ssxKickA .16s linear }
.ssxA .award.kB .awBody{ animation:ssxKickB .16s linear }
`;

const HTML = `
<div class="scrimT"></div>
<div class="scrimB"></div>

<div class="clScore">
  <div class="plate">
    <i class="edge edgeL"></i>
    <div class="inner">
      <div class="lbl"><span><i class="bar"></i>Score</span><span class="pts">Pts</span></div>
      <div class="odo" data-hud="score"></div>
      <div class="subrow">
        <div class="chip chipJump" data-on="0"><i>Jump</i><b class="jv">0</b></div>
        <div class="chip chipAir" data-on="0"><i>Air</i><b class="av">0.0s</b></div>
        <i class="rule"></i>
      </div>
    </div>
  </div>
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
  <div class="awBody"><div class="awName">&mdash;</div><div class="awPts">+0</div></div>
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
    chipAir: q('.chipAir'), av: q('.av'),
    badge: q('.badge'), badgeTxt: q('.badge > span'),
    spdFill: q('.spdBarFill'),
  };

  // ---- cached last-written values: a steady frame writes nothing --------
  let cScore = -1, cScoreStr = '', digits = [];
  let cSpeed = -1, cMeter = -1, cTier = -1, cLit = -1, cTricky = null;
  let cJump = -1, cJumpOn = -1, cAirOn = -1, cAir = -1, cHot = -1, cState = '';
  let awardCount = 0, awardsRef = null, awardT0 = -1, awardOn = false, awardKick = false;
  let prevBoostMeter = -1, boostHold = 0;

  const now = () => (typeof performance !== 'undefined' ? performance.now() : 0);

  // --- score odometer: exactly the digits, nothing else, written now ----
  function setScore(raw) {
    const n = Math.max(0, Math.round(Number(raw) || 0));
    if (n === cScore) return;
    cScore = n;
    const s = commafy(n);
    if (s.length !== cScoreStr.length) {
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

  function showAward(a) {
    const name = (a && a.name) ? String(a.name) : 'Trick';
    const pts = Math.max(0, Math.round(Number(a && a.points) || 0));
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

    // ---- jump / air chips ----------------------------------------------
    const js = Math.max(0, Math.round(Number(t.jumpScore) || 0));
    const jOn = js > 0 ? 1 : 0;
    if (jOn !== cJumpOn) { cJumpOn = jOn; el.chipJump.setAttribute('data-on', String(jOn)); }
    if (jOn && js !== cJump) { cJump = js; el.jv.textContent = '+' + commafy(js); }
    const aOn = r.onGround ? 0 : 1;
    if (aOn !== cAirOn) { cAirOn = aOn; el.chipAir.setAttribute('data-on', String(aOn)); }
    if (aOn) {
      const a = Math.round((Number(r.airTime) || 0) * 10);
      if (a !== cAir) { cAir = a; el.av.textContent = (a / 10).toFixed(1) + 's'; }
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
    if (awardOn && now() - awardT0 > 2000) {
      awardOn = false;
      el.award.className = 'award';
    }
  }

  return { update };
}
