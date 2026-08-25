// Baseline HUD — validates the hud runner only. Deliberately plain; NOT a candidate.
export function createHud(container, refs) {
  container.style.pointerEvents = 'none';
  container.innerHTML = `
    <div id="bh" style="position:absolute;inset:0;font:700 28px/1.2 ui-monospace,monospace;color:#fff;
      text-shadow:0 2px 6px rgba(0,0,0,.55);pointer-events:none">
      <div style="position:absolute;left:20px;top:16px;pointer-events:none">
        <span data-hud="score" style="font-size:34px">0</span>
      </div>
      <div style="position:absolute;left:20px;bottom:20px;pointer-events:none">
        <span data-hud="speed" style="font-size:28px">0</span><span style="font-size:16px"> km/h</span>
      </div>
      <div style="position:absolute;right:20px;bottom:20px;width:220px;height:18px;
        background:rgba(0,0,0,.35);pointer-events:none">
        <div data-hud="meter-fill" data-value="0" style="height:100%;width:0%;background:#4cc0ff"></div>
      </div>
      <div data-hud="tricky" data-lit="0" data-tricky="false"
        style="position:absolute;right:20px;top:16px;font-size:24px;letter-spacing:.18em;pointer-events:none">TRICKY</div>
      <div data-hud="award" style="position:absolute;left:50%;top:30%;transform:translateX(-50%);
        font-size:30px;opacity:0;transition:opacity .15s;pointer-events:none"></div>
    </div>`;
  const $ = s => container.querySelector(s);
  const elScore = $('[data-hud="score"]'), elSpeed = $('[data-hud="speed"]');
  const elFill = $('[data-hud="meter-fill"]'), elTricky = $('[data-hud="tricky"]'), elAward = $('[data-hud="award"]');
  let shownAwards = 0, awardT = 0;
  return {
    update(dt) {
      const t = refs.trickState(), s = refs.riderState();
      elScore.textContent = String(Math.round(t.score));
      elSpeed.textContent = String(Math.round(Math.hypot(s.vel[0], s.vel[2]) * 3.6));
      const m = Math.max(0, Math.min(1, t.meter));
      elFill.setAttribute('data-value', m.toFixed(2));
      elFill.style.width = (m * 100).toFixed(1) + '%';
      elFill.style.background = m < 0.34 ? '#4cc0ff' : m < 0.7 ? '#ffc24c' : '#ff5a3c';
      elTricky.setAttribute('data-lit', String(t.trickyLetters | 0));
      elTricky.setAttribute('data-tricky', t.tricky ? 'true' : 'false');
      elTricky.style.color = t.tricky ? '#ff3ea5' : '#ffffff';
      if (t.awards.length > shownAwards) {
        shownAwards = t.awards.length; awardT = 2.2;
        elAward.textContent = t.awards[t.awards.length - 1].name ?? 'TRICK';
      }
      if (awardT > 0) { awardT -= dt; elAward.style.opacity = awardT > 0 ? '1' : '0'; }
      else elAward.style.opacity = '0';
    },
  };
}
