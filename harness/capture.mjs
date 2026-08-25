#!/usr/bin/env node
// Headless render harness: serves a candidate, drives its flythrough, captures
// frames + perf. This is the Critic's eyes — if this fails, the visual loop is broken.
//
// usage: node harness/capture.mjs --dir sandbox/render-loop/A/src [--frames 8] [--out <dir>]
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : dflt;
};
const candDir = resolve(ROOT, opt('dir'));
const nFrames = Number(opt('frames', 8));
const outDir = resolve(ROOT, opt('out', join(candDir, '..', '_capture')));
if (!existsSync(candDir)) { console.error('no such candidate dir: ' + candDir); process.exit(1); }

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.glsl': 'text/plain', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0];
    let file;
    if (url === '/favicon.ico') { res.writeHead(204).end(); return; }
    if (url === '/' || url === '/index.html') file = join(ROOT, 'harness', 'page.html');
    else if (url.startsWith('/candidate/')) file = join(candDir, url.slice('/candidate/'.length));
    else if (url.startsWith('/node_modules/')) file = join(ROOT, url);
    else { res.writeHead(404).end(); return; }
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
         '--use-gl=angle', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage();
await page.setViewport({ width: Number(opt('w', 1280)), height: Number(opt('h', 720)) });
const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push(String(e)));

const result = { ok: false, frames: [], perf: null, errors: [], consoleErrors };
try {
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle0', timeout: 30000 });
  await page.waitForFunction('window.__gauntlet && window.__gauntlet.ready !== false', { timeout: 30000 });
  const boot = await page.evaluate('window.__gauntlet');
  result.errors = boot.errors;
  if (boot.ready === 'failed') throw new Error('candidate boot failed');

  await mkdir(outDir, { recursive: true });
  const evalArg = opt('eval', null);   // print result of an expression over window.__app, then exit
  if (evalArg) {
    const out = await page.evaluate(`(() => { const a = window.__app; return (${evalArg}); })()`);
    console.log(JSON.stringify(out));
    await browser.close(); server.close(); process.exit(0);
  }
  const preArg = opt('pre', null);     // JS over `a` (=__app) run before any shots
  if (preArg) await page.evaluate(`(() => { const a = window.__app; ${preArg}; return true; })()`);
  const poseArg = opt('pose', null);   // "px,py,pz,tx,ty,tz" — free camera shot, skips flythrough
  if (poseArg) {
    // y tokens may be g<offset> = terrain height at that (x,z) + offset
    const [px, py, pz, tx, ty, tz] = poseArg.split(',');
    await page.evaluate(`(() => { const a = window.__app;
      const gy = (x, z, tok) => String(tok).startsWith('g')
        ? a.sampleHeight(x, z) + Number(String(tok).slice(1) || 0) : Number(tok);
      const py = gy(${px}, ${pz}, '${py}'), ty = gy(${tx}, ${tz}, '${ty}');
      a.camera.position.set(${px}, py, ${pz});
      const noUpd = ${args.includes('--noupdate') ? 'true' : 'false'};
      if (!noUpd) for (let i = 0; i < 6; i++) a.update(1/60);   // let LOD streaming settle
      a.camera.position.set(${px}, py, ${pz});
      a.camera.lookAt(${tx}, ty, ${tz});
      a.camera.updateMatrixWorld(true);
      a.render(16.6); return true; })()`);
    const path = join(outDir, 'pose.png');
    await page.screenshot({ path });
    result.frames.push(path);
    result.perf = { posed: true };
    result.ok = result.errors.length === 0 && consoleErrors.length === 0;
    await browser.close(); server.close();
    await writeFile(join(outDir, 'metrics.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: result.ok, pose: poseArg }));
    process.exit(result.ok ? 0 : 2);
  }
  for (let i = 0; i < nFrames; i++) {
    const t = nFrames === 1 ? 0 : i / (nFrames - 1);
    await page.evaluate(`window.__step(${t})`);
    const path = join(outDir, `frame-${String(i).padStart(2, '0')}.png`);
    await page.screenshot({ path });
    result.frames.push(path);
  }
  result.perf = await page.evaluate('window.__perf(3000)');
  result.ok = result.errors.length === 0 && consoleErrors.length === 0;
} catch (err) {
  result.errors.push(String(err && err.message || err));
}

await browser.close();
server.close();
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'metrics.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, frames: result.frames.length,
  perf: result.perf, errors: result.errors.slice(0, 5), consoleErrors: consoleErrors.slice(0, 5) }, null, 2));
process.exit(result.ok ? 0 : 2);
