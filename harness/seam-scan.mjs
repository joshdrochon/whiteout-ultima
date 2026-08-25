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
  const NF = Number(opt('frames', 40));
  execFileSync('node', ['harness/capture.mjs', '--dir', 'src/game', '--frames', String(NF), '--out', `${OUT}/game`], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < NF; i++) shots.push({ id: `game-f${i}`, path: `${OUT}/game/frame-${String(i).padStart(2,'0')}.png` });
}
if (VIEWS !== 'game') {
  // course centerline (z, cx) measured from the heightfield
  const CL = [[100,110],[300,170],[500,200],[700,155],[900,70],[1100,-35],[1300,-130],[1500,-160],[1700,-135],[1900,-65]];
  const poses = [];
  for (let i = 0; i < CL.length - 1; i++) {
    const [z, cx] = CL[i], [z2, cx2] = CL[i + 1];
    // grazing views like gameplay: from the course, looking down-course, biased
    // into each wall so the wall fills the frame
    poses.push([`L-z${z}`, `${cx + 15},g3,${z},${cx2 - 90},g60,${z2 + 100}`]);
    poses.push([`R-z${z}`, `${cx - 15},g3,${z},${cx2 + 90},g60,${z2 + 100}`]);
  }
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
    // streak clustering: seams/scratches are ELONGATED chains of hits; glints,
    // snowfall and spray are isolated points. Union hits within 5 px, keep
    // components with >= 5 members whose bbox aspect ratio >= 3.
    const parent = hits.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < hits.length; i++) for (let j = i + 1; j < hits.length; j++) {
      const dx = hits[i][0] - hits[j][0], dy = hits[i][1] - hits[j][1];
      if (dx * dx + dy * dy <= 25) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
    const comps = new Map();
    for (let i = 0; i < hits.length; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(hits[i]); }
    const streaks = [];
    for (const pts of comps.values()) {
      if (pts.length < 5) continue;
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
      const w = Math.max(...xs) - Math.min(...xs) + 2, h2 = Math.max(...ys) - Math.min(...ys) + 2;
      const asp = Math.max(w, h2) / Math.min(w, h2);
      if (asp >= 3 && Math.max(w, h2) >= 14) streaks.push({ n: pts.length, at: pts[0], len: Math.max(w, h2) });
    }
    return { hits: hits.length, streaks: streaks.length, streakInfo: streaks.slice(0, 6), sample: hits.slice(0, 12) };
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
  worst = Math.max(worst, r.streaks ?? 0);
  report.push({ id: s.id, hits: r.hits, streaks: r.streaks, nonTreeHits: r.nonTreeHits ?? r.hits });
  console.log(`${s.id.padEnd(10)} hits=${String(r.hits).padStart(4)}  streaks=${String(r.streaks).padStart(3)}  ${(r.streakInfo??[]).map(k=>k.at.join(',')+'/L'+k.len).join(' ')}`);
}
await browser.close();
console.log(JSON.stringify({ worstStreaks: worst, budget: BUDGET }));
if (!args.includes('--keep')) { /* keep outputs for inspection anyway */ }
process.exit(worst > BUDGET ? 2 : 0);
