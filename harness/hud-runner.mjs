#!/usr/bin/env node
// HUD gate runner — operational definition of the HU gates in
// references/PHYSICS_GATES.json. Boots the real game rig + a candidate HUD in
// headless Chromium, drives scripted play, and probes the live DOM.
//
// usage: node harness/hud-runner.mjs --module sandbox/hud/A [--out <json>] [--shots <dir>]
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const candDir = resolve(ROOT, opt('module'));
const outPath = opt('out', null);
const shotDir = opt('shots', null);
if (!existsSync(candDir)) { console.error('no such hud dir: ' + candDir); process.exit(1); }

const GATES = JSON.parse(readFileSync(resolve(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'))
  .gates.filter(g => g.lane === 'hud');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glsl': 'text/plain', '.css': 'text/css',
  '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    let file;
    if (url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (url === '/') file = join(ROOT, 'harness', 'hud-page.html');
    else if (url.startsWith('/candidate/')) file = join(candDir, url.slice('/candidate/'.length));
    else if (url.startsWith('/game/')) file = join(ROOT, 'src/game', url.slice('/game/'.length));
    else if (url.startsWith('/node_modules/')) file = join(ROOT, url);
    else { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({ headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
         '--use-gl=angle', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 40000 });
await page.waitForFunction('window.__gauntlet && window.__gauntlet.ready !== false', { timeout: 40000 });
const boot = await page.evaluate('window.__gauntlet');
if (boot.ready === 'failed') {
  console.error('HUD boot failed:', boot.errors.slice(0, 3).join(' | '));
  await browser.close(); server.close(); process.exit(2);
}

// scripted play helper injected once: runs the rig for `sec` seconds of sim time
await page.evaluate(`window.__play = (sec, hudDt) => {
  const n = Math.round(sec * 60);
  for (let i = 0; i < n; i++) { window.__app.update(1/60); window.__hud.update(hudDt ?? 1/60); }
  return true;
};`);

const impl = {
  async score() {
    await page.evaluate('window.__play(4)');
    // NON-TRIVIAL by construction: a scripted run may score 0, and a HUD that
    // hardcodes "0" would pass vacuously (caught by negative control). Drive
    // several distinctive values and require every one to be reflected.
    return await page.evaluate(`(() => {
      const t = window.__app.trickState();
      const el = document.querySelector('[data-hud="score"]');
      if (!el) return { scoreMatches: 0, _why: 'no [data-hud=score]' };
      const seen = [];
      for (const v of [13210, 486300, 7]) {
        t.score = v; window.__hud.update(1/60);
        seen.push(Number(String(el.textContent).replace(/[^0-9]/g, '')));
      }
      const want = [13210, 486300, 7];
      return { scoreMatches: seen.every((s, i) => s === want[i]) ? 1 : 0, _seen: seen };
    })()`);
  },
  async meter() {
    await page.evaluate('window.__play(4)');
    // non-trivial sweep (see score): a stale "0.00" must fail
    return await page.evaluate(`(() => {
      const t = window.__app.trickState();
      const el = document.querySelector('[data-hud="meter-fill"]');
      if (!el) return { meterMatches: 0, _why: 'no [data-hud=meter-fill]' };
      const want = [0.15, 0.63, 1.0], seen = [];
      for (const m of want) { t.meter = m; window.__hud.update(1/60); seen.push(Number(el.getAttribute('data-value'))); }
      const ok = seen.every((v, i) => Math.abs(v - want[i]) <= 0.02);
      // the visual fill must move too, not just the attribute
      t.meter = 0.1; window.__hud.update(1/60); const wLow = el.getBoundingClientRect().width;
      t.meter = 0.9; window.__hud.update(1/60); const wHigh = el.getBoundingClientRect().width;
      return { meterMatches: (ok && wHigh > wLow + 4) ? 1 : 0, _seen: seen, _wLow: Math.round(wLow), _wHigh: Math.round(wHigh) };
    })()`);
  },
  async speed() {
    await page.evaluate('window.__play(5)');
    return page.evaluate(`(() => {
      const s = window.__app.riderState();
      const want = Math.round(Math.hypot(s.vel[0], s.vel[2]) * 3.6);
      const el = document.querySelector('[data-hud="speed"]');
      if (!el) return { speedMatches: 0, _why: 'no [data-hud=speed]' };
      const shown = Number(String(el.textContent).replace(/[^0-9.]/g, ''));
      // guard against vacuity: the scripted rider must actually be moving
      return { speedMatches: (want > 5 && Math.abs(shown - want) <= 1) ? 1 : 0, _shown: shown, _want: want };
    })()`);
  },
  async ultima() {
    // drive the trick state directly: land ubers via the rig's own trick system
    return page.evaluate(`(() => {
      const t = window.__app.trickState();
      const el = document.querySelector('[data-hud="ultima"]');
      if (!el) return { ultimaMatches: 0, _why: 'no [data-hud=ultima]' };
      const checks = [];
      for (const n of [0, 3, 6]) {
        t.ultimaLetters = n; t.ultima = n >= 6;
        window.__hud.update(1/60);
        const lit = Number(el.getAttribute('data-lit'));
        const flag = String(el.getAttribute('data-ultima')) === 'true';
        checks.push(lit === n && flag === (n >= 6));
      }
      return { ultimaMatches: checks.every(Boolean) ? 1 : 0, _checks: checks };
    })()`);
  },
  async award() {
    // real elapsed time (not synchronous stepping) so CSS transitions/animations
    // on the candidate's popup actually run — a purely synchronous loop leaves
    // any transitioned opacity at its start value and would fail honest HUDs
    return await page.evaluate(`(async () => {
      const t = window.__app.trickState();
      const el = document.querySelector('[data-hud="award"]');
      if (!el) return { awardTiming: 0, _why: 'no [data-hud=award]' };
      const vis = () => { const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' &&
               st.display !== 'none' && Number(st.opacity) > 0.05; };
      const run = (ms) => new Promise(res => {
        const t0 = performance.now();
        const tick = (now) => { window.__hud.update(1/60);
          if (now - t0 < ms) requestAnimationFrame(tick); else res(); };
        requestAnimationFrame(tick);
      });
      t.awards.push({ name: 'Double Rodeo 720', points: 4200 });
      t.lastAward = t.awards[t.awards.length - 1];
      await run(500);
      const appeared = vis();
      const named = /Rodeo/i.test(el.textContent || '');
      await run(4000);
      const hidden = !vis();
      return { awardTiming: (appeared && named && hidden) ? 1 : 0, _appeared: appeared, _named: named, _hidden: hidden };
    })()`);
  },
  async perf() {
    // absolute fps here measures the PAGE (DOM overlay + probe rAF), which sits
    // ~50 fps even with a no-op HUD. The gate that matters is the candidate's
    // marginal cost: fps with its update() vs the same page with update disabled.
    const withHud = await page.evaluate('window.__perf(2500)');
    const without = await page.evaluate(`(async () => {
      const real = window.__hud.update.bind(window.__hud);
      window.__hud.update = () => {};
      const r = await window.__perf(2500);
      window.__hud.update = real;
      return r;
    })()`);
    const ratio = without.avgFps > 0 ? withHud.avgFps / without.avgFps : 0;
    return { hudFpsRetained: +(ratio * 100).toFixed(1), _withHud: withHud.avgFps, _noHud: without.avgFps };
  },
  async pointer() {
    return page.evaluate(`(() => {
      const root = document.getElementById('hudroot');
      const bad = [];
      root.querySelectorAll('*').forEach(el => {
        if (getComputedStyle(el).pointerEvents !== 'none') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) bad.push(el.tagName + '.' + el.className);
        }
      });
      const rootOk = getComputedStyle(root).pointerEvents === 'none';
      return { pointerEventsClean: (rootOk && bad.length === 0) ? 1 : 0, _bad: bad.slice(0, 4) };
    })()`);
  },
  async typography() {
    await page.evaluate('window.__play(4)');
    return page.evaluate(`(() => {
      const px = sel => { const el = document.querySelector(sel); if (!el) return 0;
        return parseFloat(getComputedStyle(el).fontSize) || 0; };
      const vals = ['[data-hud="score"]', '[data-hud="speed"]'].map(px);
      return { minGlyphPx: Math.min(...vals), _vals: vals };
    })()`);
  },
  async ladder() {
    return page.evaluate(`(() => {
      const t = window.__app.trickState();
      const el = document.querySelector('[data-hud="meter-fill"]');
      if (!el) return { meterLadder: 0 };
      const seen = new Set();
      for (const m of [0.2, 0.6, 1.0]) {
        t.meter = m; window.__hud.update(1/60);
        const st = getComputedStyle(el);
        seen.add(st.backgroundColor + '|' + st.backgroundImage.slice(0, 60) + '|' + st.color);
      }
      return { meterLadder: seen.size >= 3 ? 1 : 0, _distinct: seen.size };
    })()`);
  },
  async mult() {
    // HARD scoring canon (JA-18): sweep star tiers and require each on screen
    return await page.evaluate(`(() => {
      const t = window.__app.trickState();
      const el = document.querySelector('[data-hud="mult"]');
      if (!el) return { multMatches: 0, _why: 'no [data-hud=mult]' };
      const want = [1, 2, 3, 5], seen = [];
      for (const v of want) { t.starMult = v; window.__hud.update(1/60);
        seen.push(Number(String(el.textContent).replace(/[^0-9]/g, ''))); }
      const vis = () => { const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none'; };
      return { multMatches: (seen.every((v, i) => v === want[i]) && vis()) ? 1 : 0, _seen: seen };
    })()`);
  },
  async responsive() {
    // hand-computed clearance breaks at narrow viewports (blind critic, cycle 3):
    // resize for real and assert nothing overlaps the meter and nothing is clipped
    const probes = ['score', 'speed', 'meter-fill', 'ultima', 'mult'];
    const bad = [];
    for (const [w, h] of [[500, 720], [1280, 720], [2560, 1440]]) {
      await page.setViewport({ width: w, height: h });
      await page.evaluate('window.dispatchEvent(new Event("resize")); window.__play(1)');
      const r = await page.evaluate(`(() => {
        const out = { clipped: [], overlaps: [] };
        const meter = document.querySelector('[data-hud="meter-fill"]');
        const mr = meter ? meter.getBoundingClientRect() : null;
        // the meter's own visible track: its parent box
        const track = meter && meter.parentElement ? meter.parentElement.getBoundingClientRect() : mr;
        for (const p of ${JSON.stringify(probes)}) {
          const el = document.querySelector('[data-hud="' + p + '"]');
          if (!el) { out.clipped.push(p + ':missing'); continue; }
          const b = el.getBoundingClientRect();
          if (b.width < 1 || b.height < 1) { out.clipped.push(p + ':zero-size'); continue; }
          if (b.left < -1 || b.top < -1 || b.right > innerWidth + 1 || b.bottom > innerHeight + 1)
            out.clipped.push(p + ':offscreen(' + Math.round(b.left) + ',' + Math.round(b.top) + ',' +
              Math.round(b.right) + ',' + Math.round(b.bottom) + ')');
        }
        if (track) {
          document.getElementById('hudroot').querySelectorAll('*').forEach(el => {
            const st = getComputedStyle(el);
            if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) < 0.05) return;
            const paints = st.backgroundColor !== 'rgba(0, 0, 0, 0)' || st.backgroundImage !== 'none';
            const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
            if (!paints && !ownText) return;
            if (el.closest('[data-hud="meter-fill"]') || el.contains(document.querySelector('[data-hud="meter-fill"]'))) return;
            const b = el.getBoundingClientRect();
            if (b.width < 2 || b.height < 2) return;
            const ov = Math.min(b.right, track.right) - Math.max(b.left, track.left);
            const oy = Math.min(b.bottom, track.bottom) - Math.max(b.top, track.top);
            if (ov > 2 && oy > 2) out.overlaps.push((el.getAttribute('data-hud') || el.className || el.tagName) + ':' + Math.round(ov) + 'x' + Math.round(oy));
          });
        }
        return out;
      })()`);
      if (r.clipped.length || r.overlaps.length)
        bad.push(`${w}x${h} clipped[${r.clipped.join(',')}] overlaps[${r.overlaps.slice(0, 3).join(',')}]`);
    }
    await page.setViewport({ width: 1280, height: 720 });
    await page.evaluate('window.dispatchEvent(new Event("resize")); window.__play(1)');
    return { responsiveOk: bad.length === 0 ? 1 : 0, _bad: bad.slice(0, 3) };
  },
  async layout() {
    await page.evaluate('window.__play(4)');
    return page.evaluate(`(() => {
      const W = innerWidth, H = innerHeight;
      const box = { x0: W * 0.25, x1: W * 0.75, y0: H * 0.25, y1: H * 0.75 };
      const intruders = [];
      document.getElementById('hudroot').querySelectorAll('*').forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        const st = getComputedStyle(el);
        if (st.visibility === 'hidden' || Number(st.opacity) < 0.05) return;
        // an award popup mid-screen is allowed only if transient; measured at rest
        if (el.getAttribute('data-hud') === 'award') return;
        // ignore layout wrappers: no own text, no painted background/border/image
        const paints = st.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
          st.backgroundImage !== 'none' || parseFloat(st.borderTopWidth) > 0 ||
          parseFloat(st.borderLeftWidth) > 0;
        const ownText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
        if (!paints && !ownText) return;
        if (r.right > box.x0 && r.left < box.x1 && r.bottom > box.y0 && r.top < box.y1)
          intruders.push((el.getAttribute('data-hud') || el.tagName) + ':' + Math.round(r.left) + ',' + Math.round(r.top));
      });
      return { centerClear: intruders.length === 0 ? 1 : 0, _intruders: intruders.slice(0, 4) };
    })()`);
  },
};

const results = [];
for (const g of GATES) {
  const mode = g.scenario?.params?.mode;
  let row;
  try {
    const m = await impl[mode]();
    const val = m[g.metric];
    let pass;
    if (g.op === 'in_range') pass = val >= g.min && val <= g.max;
    else if (g.op === 'lte') pass = val <= g.value;
    else if (g.op === 'gte') pass = val >= g.value;
    else if (g.op === 'eq') pass = Math.abs(val - g.value) < 1e-9;
    const side = Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('_')));
    row = { id: g.id, tag: g.tag, status: pass ? 'pass' : 'fail', metric: g.metric,
      value: typeof val === 'number' ? +Number(val).toPrecision(5) : val,
      expect: g.op === 'in_range' ? `[${g.min}, ${g.max}]` : `${g.op} ${g.value}`, ...side };
  } catch (err) {
    row = { id: g.id, tag: g.tag, status: 'error', error: String(err.message).slice(0, 200) };
  }
  results.push(row);
}

if (shotDir) {
  await mkdir(resolve(ROOT, shotDir), { recursive: true });
  for (const [i, t] of [0.15, 0.45, 0.75].entries()) {
    await page.evaluate(`window.__step(${t}); window.__hud.update(1/60);`);
    await page.screenshot({ path: join(resolve(ROOT, shotDir), `hud-${i}.png`) });
  }
}

const counts = { pass: 0, fail: 0, error: 0 };
let hardFails = 0;
for (const r of results) {
  counts[r.status] = (counts[r.status] ?? 0) + 1;
  if (r.status !== 'pass' && r.tag === 'HARD') hardFails++;
}
await browser.close(); server.close();
const report = { module: candDir, counts, hardFails, consoleErrors: consoleErrors.slice(0, 5), results };
if (outPath) { await mkdir(dirname(resolve(ROOT, outPath)), { recursive: true });
  await writeFile(resolve(ROOT, outPath), JSON.stringify(report, null, 2)); }
for (const r of results)
  console.log(`${(r.status === 'pass' ? 'PASS' : r.status.toUpperCase()).padEnd(6)} ${r.id.padEnd(6)} ${r.tag.padEnd(9)} ${r.metric ?? ''} ${r.value !== undefined ? '= ' + r.value : ''} ${r.expect ? '(want ' + r.expect + ')' : ''} ${r.error ?? ''}`);
console.log(JSON.stringify({ counts, hardFails }));
process.exit(hardFails === 0 ? 0 : 2);
