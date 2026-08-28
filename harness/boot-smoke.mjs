#!/usr/bin/env node
// ============================================================================
// BOOT SMOKE TEST — does index.html actually start?
//
// WHY THIS EXISTS. The suite could tell you every module was correct and every
// gate was green while the game itself was a blank screen. Nothing loaded
// index.html and ran it. Two separate breakages shipped that way in one day,
// both the same shape: a function called during init referencing a `const`
// declared further down the file. That is a ReferenceError at module scope —
// it kills the whole script, the loading cover never lifts, and every unit
// test still passes because none of them boot the page.
//
// So this loads the real page in headless Chrome and asserts the game came up:
// window.__app exists, the rider is on the mountain, the loading cover lifted,
// and nothing threw on the way. It is a smoke test, not a gate — it proves the
// thing starts, which is the one property the rest of the suite cannot see.
// ============================================================================
import puppeteer from 'puppeteer';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.mp3': 'audio/mpeg', '.glsl': 'text/plain' };

const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://x').pathname;
    // The page asks for these; the real dev server answers them. Stubbed rather
    // than 404'd so the smoke test fails on REAL errors only.
    if (pathname === '/__build') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
         .end(JSON.stringify({ commit: 'smoke', subject: '', dirty: false }));
      return;
    }
    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    let p = resolve(join(ROOT, normalize(decodeURIComponent(pathname))));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let s = await stat(p).catch(() => null);
    if (s?.isDirectory()) { p = join(p, 'index.html'); s = await stat(p).catch(() => null); }
    if (!s) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store' }).end(await readFile(p));
  } catch (e) { res.writeHead(500).end(String(e)); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
         '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message || e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const out = { ok: false, errors: [], checks: {} };
try {
  await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load', timeout: 60000 });
  // The page boots asynchronously: six GLBs, then the cover lifts, then a
  // countdown. Wait for the app handle rather than a fixed sleep.
  await page.waitForFunction('!!window.__app', { timeout: 45000 });
  out.checks = await page.evaluate(async () => {
    const a = window.__app;
    const st = a.riderState();
    // let the countdown run out so the sim is actually live
    const t0 = Date.now();
    while (a.isFrozen && a.isFrozen() && Date.now() - t0 < 12000)
      await new Promise(r => setTimeout(r, 200));
    const before = a.riderState().pos[2];
    for (let i = 0; i < 240; i++) a.update(1 / 60);
    const after = a.riderState().pos[2];
    // Let the render loop tick so the DOM overlays it drives are current. The
    // place readout is updated in frame(), not by update(), so reading it
    // straight after stepping the sim would read a stale value.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const pe = document.getElementById('place');
    const placeShown = !pe.hidden &&
      /^(1st|2nd|3rd|4th|5th)$/.test(document.getElementById('placenum').textContent.trim());
    const ctrls = document.getElementById('ctrls').getBoundingClientRect();
    let hudTop = Infinity;
    for (const q of document.getElementById('hudroot').querySelectorAll('*')) {
      const r2 = q.getBoundingClientRect();
      if (r2.width < 1 || r2.height < 1) continue;
      if (r2.width >= innerWidth - 2 && r2.height >= innerHeight - 2) continue;
      if (r2.left > innerWidth * 0.42 || r2.top < innerHeight * 0.5) continue;
      hudTop = Math.min(hudTop, r2.top);
    }
    return {
      hasApp: true,
      riderOnMountain: Number.isFinite(st.pos[1]) && st.pos[1] > 0,
      coverGone: !document.getElementById('load'),
      unfroze: !(a.isFrozen && a.isFrozen()),
      advanced: +(after - before).toFixed(1),
      hasGates: (a.gateState?.()?.hit ?? -1) >= 0,
      hasPlace: !!a.placeState?.(),
      // The overlays the rig drives must actually be on screen and not sitting
      // on top of the HUD — both have silently regressed before.
      placeShown,
      controlsClearOfHud: !Number.isFinite(hudTop) || ctrls.bottom <= hudTop + 1,
      ...(await finishRun()),
    };

    // RIDE THE WHOLE COURSE. The finish is where several things only ever
    // happen once — the run phase flips, the leaderboard submits and renders —
    // and none of it is reachable from a unit test. Steering is deliberately
    // absent: this doubles as the guarantee that a passive run still finishes,
    // which is the failure that used to leave the rider pinned at a bend.
    async function finishRun() {
      for (let i = 0; i < 60 * 420 && a.runState().phase !== 'finished'; i++) a.update(1 / 60);
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise((r) => setTimeout(r, 250));
      const lb = document.getElementById('lb');
      const rows = document.getElementById('lbrows');
      return {
        finished: a.runState().phase === 'finished',
        finishedNoSteering: a.runState().phase === 'finished',
        leaderboardShown: !lb.hidden && rows.children.length > 0,
        leaderboardRow: (rows.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    }
  });
  const c = out.checks;
  out.ok = c.hasApp && c.riderOnMountain && c.coverGone && c.unfroze &&
           c.advanced > 5 && c.hasGates && c.hasPlace && c.placeShown &&
           c.controlsClearOfHud && c.finished && c.leaderboardShown &&
           errors.length === 0;
} catch (e) {
  errors.push('harness: ' + String(e.message || e));
}
out.errors = errors.slice(0, 8);

await browser.close();
server.close();
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
