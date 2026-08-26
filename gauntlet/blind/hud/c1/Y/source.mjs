// ===========================================================================
// HUD candidate B — "ARCADE CHROME"
//
// SSX-Tricky-loud overlay: chunky beveled chrome plates with hard offset drop
// shadows, huge italic tabular numerals, a vertical boost thermometer that
// swells and goes white-hot at full, six discrete TRICKY letter tiles, and an
// award slab that punches in centre-low with scale overshoot.
//
// LAYOUT LAW (HU-10): every resting element lives in a screen-edge band.
//   top-left      SCORE plate (+ live jump chip / active trick name)
//   top-right     TRICKY tiles
//   left edge     BOOST thermometer (tier ladder, ready pulse)
//   bottom-right  SPEED plate (km/h) + boosting flare
//   bottom-centre AWARD slab — the ONE element allowed mid-screen, and it is
//                 a SINGLE div: its label and points are ::before/::after
//                 pseudo-elements (never querySelectorAll-visible) so no child
//                 of it can ever intrude on the centre box.
//
// PERF LAW (HU-06): update() is read-compare-write. Every DOM write is behind
// a change guard on a cached primitive; no getComputedStyle, no rect reads, no
// layout thrash except one forced reflow per NEW award (to restart its
// keyframe). Steady-state cost with nothing changing is ~10 numeric compares.
//
// CLOCKS: the award lifecycle is a pure CSS keyframe (real time), so it obeys
// HU-05 whatever dt the caller passes. update(dt) itself keeps a small
// accumulator only for cosmetic state (boost flare hold).
//
// No external assets, no web fonts — system stacks only.
// ===========================================================================

const STYLE_ID = 'ssx-hud-b-style';

// --- palette ---------------------------------------------------------------
// chrome plate body, then the SSX-saturated accent ladder
const CSS = `
#ssxb, #ssxb * { pointer-events: none; box-sizing: border-box; }
#ssxb {
  position: absolute; inset: 0; overflow: hidden;
  font-family: "Arial Black", "Arial Bold", Gadget, Impact, "Haettenschweiler",
               system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
  font-weight: 900; font-style: italic;
  -webkit-font-smoothing: antialiased;
  text-transform: uppercase; letter-spacing: -0.02em;
  --cyan:#25e0ff; --lime:#b4ff00; --yell:#ffe600; --orng:#ff7a00;
  --mag:#ff1fb3; --red:#ff2d2d; --ink:#07090f;
}

/* ---- chrome plate: bevel top-light, dark body, hard offset shadow -------- */
.ssxb-plate {
  position: absolute;
  background:
    linear-gradient(180deg, rgba(255,255,255,.34) 0%, rgba(255,255,255,.06) 16%,
                    rgba(10,14,22,.90) 17%, rgba(10,14,22,.96) 62%,
                    rgba(28,36,54,.94) 100%);
  border: 3px solid rgba(255,255,255,.90);
  border-radius: 14px;
  box-shadow: 7px 7px 0 rgba(0,0,0,.62),
              inset 0 -4px 0 rgba(0,0,0,.55),
              inset 0 2px 0 rgba(255,255,255,.25);
  transform: skewX(-7deg);
  padding: 4px 16px 8px;
  /* dark keyline OUTSIDE the chrome bezel: without it a white-bordered plate
     dissolves into a snow field. outline is not part of the layout box, so it
     buys contrast without moving anything. */
  outline: 3px solid rgba(5,7,12,.85);
}
/* un-skew the glyphs inside so type leans by its own italic, not double */
.ssxb-plate > * { transform: skewX(7deg); }

.ssxb-tab {
  display: inline-block; font-size: 15px; line-height: 15px;
  letter-spacing: .22em; color: var(--ink);
  background: linear-gradient(180deg, #ffffff, #b9c6d6);
  padding: 3px 12px 2px; border-radius: 6px;
  box-shadow: 3px 3px 0 rgba(0,0,0,.55);
  outline: 2px solid rgba(5,7,12,.85);
}
.ssxb-num {
  font-size: 76px; line-height: .96; color: #fff;
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  text-shadow: 0 0 18px rgba(37,224,255,.55), 5px 5px 0 rgba(0,0,0,.75);
}

/* ---- SCORE (top-left) ---------------------------------------------------- */
#ssxb-score-plate { top: 22px; left: 30px; }
#ssxb-score-plate .ssxb-num { letter-spacing: -0.03em; }
.ssxb-pop { animation: ssxb-pop .22s cubic-bezier(.2,1.9,.4,1); }
@keyframes ssxb-pop { 0%{transform:skewX(7deg) scale(1)} 42%{transform:skewX(7deg) scale(1.13)} 100%{transform:skewX(7deg) scale(1)} }

#ssxb-jump {
  display: none; margin-top: 4px; font-size: 24px; line-height: 26px;
  color: var(--ink); white-space: nowrap;
  background: linear-gradient(180deg, var(--yell), var(--orng));
  border-radius: 7px; padding: 2px 12px 3px;
  box-shadow: 4px 4px 0 rgba(0,0,0,.6), inset 0 2px 0 rgba(255,255,255,.6);
  outline: 2px solid rgba(5,7,12,.85);
}
#ssxb-jump.on { display: inline-block; }

/* ---- TRICKY tiles (top-right) -------------------------------------------- */
#ssxb-tricky {
  position: absolute; top: 24px; right: 30px;
  display: flex; gap: 8px; transform: skewX(-7deg);
}
.ssxb-tile {
  width: 46px; height: 58px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px; line-height: 34px; color: rgba(150,170,200,.35);
  background: linear-gradient(180deg, rgba(60,74,98,.75), rgba(10,14,22,.92));
  border: 3px solid rgba(255,255,255,.55);
  box-shadow: 5px 5px 0 rgba(0,0,0,.55), inset 0 -3px 0 rgba(0,0,0,.5);
  text-shadow: 2px 2px 0 rgba(0,0,0,.6);
  outline: 3px solid rgba(5,7,12,.85);
}
.ssxb-tile > span { display: block; transform: skewX(7deg); }
.ssxb-tile.lit {
  color: var(--ink);
  background: linear-gradient(180deg, #fff 0%, var(--yell) 45%, var(--orng) 100%);
  border-color: #fff;
  box-shadow: 5px 5px 0 rgba(0,0,0,.55), 0 0 20px rgba(255,160,0,.85),
              inset 0 -3px 0 rgba(0,0,0,.35);
}
#ssxb-tricky[data-tricky="true"] .ssxb-tile {
  color: var(--ink);
  background: linear-gradient(180deg, #fff 0%, var(--mag) 55%, var(--red) 100%);
  border-color: #fff;
  animation: ssxb-blink .42s steps(2, jump-none) infinite;
  box-shadow: 5px 5px 0 rgba(0,0,0,.55), 0 0 26px rgba(255,31,179,.95);
}
#ssxb-tricky[data-tricky="true"] .ssxb-tile:nth-child(2n) { animation-delay: .21s; }
@keyframes ssxb-blink { 0%{filter:none} 100%{filter:brightness(1.55) saturate(1.3)} }

#ssxb-trickybanner {
  position: absolute; top: 92px; right: 30px; display: none;
  transform: skewX(-7deg);
  font-size: 27px; line-height: 27px; letter-spacing: .16em;
  color: var(--ink); padding: 5px 14px 4px; border-radius: 8px;
  background: linear-gradient(180deg, #fff, var(--yell) 40%, var(--mag));
  box-shadow: 5px 5px 0 rgba(0,0,0,.6), 0 0 24px rgba(255,31,179,.8);
  outline: 3px solid rgba(5,7,12,.85);
}
#ssxb-tricky[data-tricky="true"] ~ #ssxb-trickybanner { display: block; }

/* ---- BOOST thermometer (left edge) --------------------------------------- */
#ssxb-boost {
  position: absolute; left: 48px; top: 50%; transform: translateY(-50%) skewX(-7deg);
  width: 78px; text-align: center;
}
#ssxb-tube {
  position: relative; width: 100%; height: 268px; border-radius: 12px;
  background: linear-gradient(180deg, rgba(6,9,15,.94), rgba(24,32,48,.94));
  border: 3px solid rgba(255,255,255,.9);
  box-shadow: 6px 6px 0 rgba(0,0,0,.6), inset 0 0 16px rgba(0,0,0,.8);
  overflow: hidden;
  outline: 3px solid rgba(5,7,12,.85);
}
/* the column is scaled, never re-laid-out: transform-only writes keep the HUD's
   marginal frame cost near zero (HU-06) while the rect still reports the real
   fill size for the probe */
#ssxb-fill {
  position: absolute; left: 0; bottom: 0; width: 100%; height: 100%;
  transform-origin: 50% 100%; transform: scaleX(.6) scaleY(0);
  border-radius: 5px; will-change: transform;
  background: linear-gradient(180deg, #7ff0ff, #0090ff);
  box-shadow: 0 0 18px rgba(37,224,255,.75);
}
#ssxb-fill.full { animation: ssxb-throb .34s ease-in-out infinite alternate; }
@keyframes ssxb-throb { from{filter:brightness(1)} to{filter:brightness(1.8) saturate(1.4)} }
#ssxb-ticks {
  position: absolute; inset: 0;
  background: repeating-linear-gradient(180deg,
    rgba(255,255,255,.38) 0 3px, rgba(255,255,255,0) 3px 26.8px);
}
#ssxb-btab {
  margin-top: 8px; display: inline-block; font-size: 16px; line-height: 16px;
  letter-spacing: .14em; color: var(--ink); padding: 3px 10px 2px;
  border-radius: 6px; background: linear-gradient(180deg,#fff,#b9c6d6);
  box-shadow: 3px 3px 0 rgba(0,0,0,.55);
}
/* tier word rides under the tube as a filled pill — wider than the tube bore,
   so it is taken out of flow and centred on the column */
#ssxb-bstate {
  position: absolute; left: 50%; bottom: -36px; transform: translateX(-50%);
  white-space: nowrap; font-size: 18px; line-height: 19px; letter-spacing: .08em;
  color: var(--ink); padding: 4px 13px 3px; border-radius: 7px;
  background: #25e0ff; box-shadow: 4px 4px 0 rgba(0,0,0,.55);
  outline: 2px solid rgba(5,7,12,.85);
}
#ssxb-bstate.hot { animation: ssxb-throb .3s ease-in-out infinite alternate; }

/* ---- SPEED (bottom-right) ------------------------------------------------ */
#ssxb-speed-plate { right: 30px; bottom: 26px; text-align: right; padding-bottom: 4px; }
#ssxb-speed-row { display: flex; align-items: flex-end; justify-content: flex-end; gap: 8px; }
#ssxb-speed {
  font-size: 72px; line-height: .92; color: #fff;
  font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1;
  text-shadow: 0 0 16px rgba(180,255,0,.5), 5px 5px 0 rgba(0,0,0,.75);
}
#ssxb-unit { font-size: 22px; line-height: 30px; color: var(--lime);
  letter-spacing: .1em; text-shadow: 2px 2px 0 rgba(0,0,0,.7); }
#ssxb-speed-plate.fast #ssxb-speed { color: var(--yell); text-shadow: 0 0 22px rgba(255,122,0,.85), 5px 5px 0 rgba(0,0,0,.75); }
#ssxb-speed-plate.boosting {
  border-color: var(--yell);
  box-shadow: 7px 7px 0 rgba(0,0,0,.62), 0 0 34px rgba(255,122,0,.9),
              inset 0 -4px 0 rgba(0,0,0,.55), inset 0 2px 0 rgba(255,255,255,.25);
}
#ssxb-boostflare {
  position: absolute; right: 30px; bottom: 176px; display: none;
  transform: skewX(-7deg);
  font-size: 26px; line-height: 26px; letter-spacing: .16em; color: var(--ink);
  padding: 4px 14px 3px; border-radius: 8px;
  background: linear-gradient(180deg, #fff, var(--yell) 45%, var(--orng));
  box-shadow: 5px 5px 0 rgba(0,0,0,.6), 0 0 26px rgba(255,140,0,.9);
  outline: 3px solid rgba(5,7,12,.85);
}
#ssxb-boostflare.on { display: block; animation: ssxb-throb .26s ease-in-out infinite alternate; }

/* ---- AWARD slab (bottom-centre, single element + pseudos) ---------------- */
#ssxb-award {
  position: absolute; left: 50%; bottom: 54px;
  transform: translateX(-50%) skewX(-7deg);
  opacity: 0;
  max-width: 56vw; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  text-align: center;
  font-size: 46px; line-height: 50px; color: #fff;
  padding: 8px 30px 10px; border-radius: 16px;
  border: 4px solid #fff;
  background: linear-gradient(180deg, rgba(255,31,179,.96), rgba(255,45,45,.96) 55%, rgba(120,0,60,.96));
  box-shadow: 8px 8px 0 rgba(0,0,0,.6), 0 0 44px rgba(255,31,179,.75),
              inset 0 3px 0 rgba(255,255,255,.5);
  text-shadow: 4px 4px 0 rgba(0,0,0,.6);
  outline: 4px solid rgba(5,7,12,.85);
}
#ssxb-award::before {
  content: "TRICK LANDED"; display: block;
  font-size: 17px; line-height: 18px; letter-spacing: .3em; color: var(--yell);
  text-shadow: 2px 2px 0 rgba(0,0,0,.7);
}
#ssxb-award::after {
  content: attr(data-pts); display: block;
  font-size: 30px; line-height: 32px; color: var(--yell);
  text-shadow: 3px 3px 0 rgba(0,0,0,.7);
}
#ssxb-award.go { animation: ssxb-award 2500ms cubic-bezier(.2,1,.3,1) forwards; }
@keyframes ssxb-award {
  0%   { opacity: 0; transform: translateX(-50%) skewX(-7deg) scale(.35) rotate(-4deg); }
  7%   { opacity: 1; transform: translateX(-50%) skewX(-7deg) scale(1.24) rotate(1.5deg); }
  13%  { transform: translateX(-50%) skewX(-7deg) scale(.94); }
  19%  { transform: translateX(-50%) skewX(-7deg) scale(1.04); }
  25%  { opacity: 1; transform: translateX(-50%) skewX(-7deg) scale(1); }
  78%  { opacity: 1; transform: translateX(-50%) skewX(-7deg) scale(1) translateY(0); }
  100% { opacity: 0; transform: translateX(-50%) skewX(-7deg) scale(1.1) translateY(-26px); }
}

/* ---- ACTIVE TRICK ticker (bottom-left band) ------------------------------ */
#ssxb-trick {
  position: absolute; bottom: 32px; left: 34px; display: none;
  transform: skewX(-7deg); white-space: nowrap;
  font-size: 26px; line-height: 26px; color: #fff;
  padding: 4px 14px 4px; border-radius: 8px;
  background: linear-gradient(180deg, rgba(37,224,255,.95), rgba(0,110,220,.95));
  box-shadow: 5px 5px 0 rgba(0,0,0,.6), 0 0 20px rgba(37,224,255,.7);
  text-shadow: 2px 2px 0 rgba(0,0,0,.55);
  outline: 3px solid rgba(5,7,12,.85);
}
#ssxb-trick.on { display: block; }
`;

// Boost tier ladder: 4 rungs, >= 3 distinct across 0.2 / 0.6 / 1.0 (HU-09).
const TIERS = [
  { at: 0.34, grad: 'linear-gradient(180deg, #7ff0ff 0%, #0090ff 100%)',  glow: 'rgba(37,224,255,.75)',  ink: '#25e0ff', word: 'LOW' },
  { at: 0.67, grad: 'linear-gradient(180deg, #ffe600 0%, #ff7a00 100%)',  glow: 'rgba(255,160,0,.8)',    ink: '#ffe600', word: 'READY' },
  { at: 0.999, grad: 'linear-gradient(180deg, #ff5ad0 0%, #ff2d2d 100%)', glow: 'rgba(255,45,45,.85)',   ink: '#ff1fb3', word: 'HOT!' },
  { at: 2, grad: 'linear-gradient(180deg, #ffffff 0%, #ffe600 28%, #ff7a00 62%, #ff2d2d 100%)', glow: 'rgba(255,255,255,.95)', ink: '#ffffff', word: 'FULL!' },
];

const group = (n) => {
  const s = String(n);
  return s.length > 3 ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : s;
};

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
      <div id="ssxb-jump"></div>
    </div>

    <div id="ssxb-tricky" data-hud="tricky" data-lit="0" data-tricky="false">
      ${['T', 'R', 'I', 'C', 'K', 'Y'].map(c => `<div class="ssxb-tile"><span>${c}</span></div>`).join('')}
    </div>
    <div id="ssxb-trickybanner">Tricky!</div>

    <div id="ssxb-boost">
      <div id="ssxb-tube">
        <div id="ssxb-fill" data-hud="meter-fill" data-value="0.00"></div>
        <div id="ssxb-ticks"></div>
      </div>
      <div id="ssxb-btab">Boost</div>
      <div id="ssxb-bstate">Charging</div>
    </div>

    <div id="ssxb-trick"></div>

    <div class="ssxb-plate" id="ssxb-speed-plate">
      <div><span class="ssxb-tab">Speed</span></div>
      <div id="ssxb-speed-row">
        <div id="ssxb-speed" data-hud="speed">0</div>
        <div id="ssxb-unit">km/h</div>
      </div>
    </div>
    <div id="ssxb-boostflare">Boost!</div>

    <div id="ssxb-award" data-hud="award" data-pts=""></div>
  `;
  container.appendChild(root);

  const q = (id) => root.querySelector(id);
  const elScore = q('#ssxb-score');
  const elScorePlate = q('#ssxb-score-plate');
  const elJump = q('#ssxb-jump');
  const elTricky = q('#ssxb-tricky');
  const tiles = Array.prototype.slice.call(root.querySelectorAll('.ssxb-tile'));
  const elFill = q('#ssxb-fill');
  const elBState = q('#ssxb-bstate');
  const elSpeed = q('#ssxb-speed');
  const elSpeedPlate = q('#ssxb-speed-plate');
  const elFlare = q('#ssxb-boostflare');
  const elTrick = q('#ssxb-trick');
  const elAward = q('#ssxb-award');

  // cached previous values — every DOM write is guarded by one of these
  let pScore = -1, pJump = -1, pSpeed = -1, pMeter = -1, pTier = -1;
  let pLit = -1, pTricky = null, pAwards = 0, pTrickLabel = '', pFast = null;
  let pBoostMeter = 1, boostHold = 0, pFlare = false, pFull = null;

  function update(dt) {
    const d = (typeof dt === 'number' && dt > 0 && dt < 1) ? dt : 1 / 60;
    const r = refs.riderState ? refs.riderState() : null;
    const t = refs.trickState ? refs.trickState() : null;

    // ---------------- score ------------------------------------------------
    if (t) {
      const sc = Math.round(t.score) || 0;
      if (sc !== pScore) {
        elScore.textContent = group(sc);
        if (sc > pScore && pScore >= 0) {
          elScore.classList.remove('ssxb-pop');
          // eslint-disable-next-line no-unused-expressions
          void elScore.offsetWidth;
          elScore.classList.add('ssxb-pop');
        }
        pScore = sc;
      }

      // running jump total (SSX shows the air tally live), quantized to 10 so a
      // per-frame float tally is not a per-frame DOM write
      const jp = Math.round((Number(t.jumpScore) || 0) / 10) * 10;
      if (jp !== pJump) {
        if (jp > 0) {
          elJump.textContent = '+' + group(jp);
          if (pJump <= 0) elJump.classList.add('on');
        } else if (pJump > 0) {
          elJump.classList.remove('on');
        }
        pJump = jp;
      }

      // ---------------- boost meter ---------------------------------------
      // quantized to 1/250 (max 0.002 error, gate tolerance is 0.02) so a
      // continuously drifting meter is not a DOM write every single frame
      const m = Math.round(Math.max(0, Math.min(1, Number(t.meter) || 0)) * 250) / 250;
      if (m !== pMeter) {
        elFill.setAttribute('data-value', m.toFixed(2));
        // scale only — no layout: column climbs from the bottom and swells from
        // 60% to 100% of the tube bore as it charges
        elFill.style.transform = 'scaleX(' + (0.6 + 0.4 * m).toFixed(3) + ') scaleY(' + m.toFixed(3) + ')';
        pMeter = m;

        let tier = 0;
        while (tier < TIERS.length - 1 && m >= TIERS[tier].at) tier++;
        if (tier !== pTier) {
          const T = TIERS[tier];
          elFill.style.background = T.grad;
          elFill.style.boxShadow = '0 0 22px ' + T.glow;
          elFill.style.color = T.ink;
          elBState.textContent = T.word;
          elBState.style.background = T.ink;
          pTier = tier;
        }
        const full = m >= 0.999;
        if (full !== pFull) {
          elFill.classList.toggle('full', full);
          elBState.classList.toggle('hot', full);
          pFull = full;
        }
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
        pTricky = tk;
      }

      // ---------------- awards --------------------------------------------
      const aw = t.awards;
      const n = (aw && aw.length) || 0;
      if (n !== pAwards) {
        if (n > pAwards) {
          const a = aw[n - 1] || t.lastAward;
          if (a) {
            elAward.textContent = String(a.name || 'Trick');
            const pts = Math.round(Number(a.points) || 0);
            elAward.setAttribute('data-pts', pts > 0 ? '+' + group(pts) + ' pts' : '');
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
          elTrick.textContent = label;
          if (!pTrickLabel) elTrick.classList.add('on');
        } else {
          elTrick.classList.remove('on');
        }
        pTrickLabel = label;
      }
    }

    // ---------------- speed ------------------------------------------------
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
