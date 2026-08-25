#!/usr/bin/env node
// Seam/dash detector: captures a sweep of views (game flythrough + wall poses),
// then flags bright outlier pixels inside shadowed-snow regions — the signature
// of the dash artifact. Prints per-view counts + hotspot coords. Exit 2 if any
// view exceeds --budget (default 0 after tree masking).
// usage: node harness/seam-scan.mjs [--budget 0] [--keep] [--views game|walls|all]
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const BUDGET = Number(opt('budget', 0));
const VIEWS = opt('views', 'all');
const OUT = resolve(ROOT, 'gauntlet/seam-scan');
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });

const HIDE_TREES = "let last=null; a.scene.traverse(o=>{ if(o.isMesh) last=o; }); last.visible=false";

const shots = [];
if (VIEWS !== 'walls') {
  execFileSync('node', ['harness/capture.mjs', '--dir', 'src/game', '--frames', '8', '--out', `${OUT}/game`], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 8; i++) shots.push({ id: `game-f${i}`, path: `${OUT}/game/frame-0${i}.png` });
}
if (VIEWS !== 'game') {
  const poses = [
    ['wallL-1', '170,g3,300,40,g50,700'], ['wallL-2', '300,g25,520,-120,g140,300'],
    ['wallR-1', '60,g3,120,220,g60,420'], ['wallR-2', '150,g4,700,320,g80,1000'],
    ['back-1', '190,g4,600,60,g90,200'],
  ];
  for (const [id, pose] of poses) {
    // pair: normal + trees-hidden, so tree-tip dashes can be told apart
    execFileSync('node', ['harness/capture.mjs', '--dir', 'src/render', '--out', `${OUT}/${id}`, '--pose', pose], { cwd: ROOT, stdio: 'ignore' });
    execFileSync('node', ['harness/capture.mjs', '--dir', 'src/render', '--out', `${OUT}/${id}-nt`, '--pose', pose, '--pre', HIDE_TREES], { cwd: ROOT, stdio: 'ignore' });
    shots.push({ id, path: `${OUT}/${id}/pose.png`, pair: `${OUT}/${id}-nt/pose.png` });
  }
}

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();

async function analyze(path) {
  const data = readFileSync(path).toString('base64');
  return await page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('img decode failed')); img.src = 'data:image/png;base64,' + b64; });
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const x = c.getContext('2d'); x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
    const lum = i => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const hits = [];
    const S = 2;
    for (let y = 8; y < H - 8; y += S) for (let px = 8; px < W - 8; px += S) {
      const i = (y * W + px) * 4;
      const l = lum(i);
      if (l < 195) continue;
      let nsum = 0, nc = 0;
      for (const [dx, dy] of [[-6,0],[6,0],[0,-6],[0,6],[-5,-5],[5,5],[-5,5],[5,-5]]) {
        const j = ((y + dy) * W + px + dx) * 4; nsum += lum(j); nc++;
      }
      const nm = nsum / nc;
      // sky exclusion: ridge snow against sky is legit silhouette, not an artifact.
      // sky is strongly blue-saturated (b - r > 95); terrain shadow is milder
      let skyN = 0, blueN = 0;
      for (const [dx, dy] of [[-6,0],[6,0],[0,-6],[0,6],[-5,-5],[5,5],[-5,5],[5,-5]]) {
        const j = ((y + dy) * W + px + dx) * 4;
        if (d[j + 2] - d[j] > 95) skyN++;
        if (d[j + 2] > d[j] + 8) blueN++;
      }
      if (nm < 172 && blueN >= 6 && skyN < 2 && l - nm > 32) hits.push([px, y]);
    }
    return { hits: hits.length, sample: hits.slice(0, 12) };
  }, data);
}

let worst = 0;
const report = [];
for (const s of shots) {
  const r = await analyze(s.path);
  let treePart = null;
  if (s.pair && r.hits > 0) {
    const rNoTree = await analyze(s.pair);
    treePart = r.hits - rNoTree.hits;      // hits that vanish with trees hidden
    r.nonTreeHits = rNoTree.hits;
  } else if (s.pair) r.nonTreeHits = 0;
  const effective = s.pair ? r.nonTreeHits : r.hits;
  worst = Math.max(worst, effective);
  report.push({ id: s.id, hits: r.hits, treeTipHits: treePart, nonTreeHits: r.nonTreeHits ?? r.hits, sample: r.sample });
  console.log(`${s.id.padEnd(10)} hits=${String(r.hits).padStart(4)}  nonTree=${String(r.nonTreeHits ?? r.hits).padStart(4)}  ${r.sample.slice(0,4).map(h=>h.join(',')).join(' ')}`);
}
await browser.close();
console.log(JSON.stringify({ worstNonTree: worst, budget: BUDGET }));
if (!args.includes('--keep')) { /* keep outputs for inspection anyway */ }
process.exit(worst > BUDGET ? 2 : 0);
