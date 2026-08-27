import { pathToFileURL } from 'node:url';
import { dirname, resolve as _res } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = _res(dirname(fileURLToPath(import.meta.url)), '../../..');
const { sampleHeight } = await import(pathToFileURL(ROOT + '/src/render/main.mjs').href);
function rawCenterX(z) { let best = Infinity, bx = 0; for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } } return bx; }
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => { const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1; const raw = new Array(n); for (let i = 0; i < n; i++) raw[i] = rawCenterX(CL_Z0 + i * CL_STEP); const sm = new Array(n); for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += raw[j]; c++; } } sm[i] = a / c; } return sm; })();
const centerX = z => { const f = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP; const i = Math.min(CL.length - 2, Math.max(0, Math.floor(f))); const t = f - i; return CL[i] * (1 - t) + CL[i + 1] * t; };

function dropCentroid(z, L1, L2, A, step, temp) {
  let num = 0, den = 0, best = -Infinity;
  const sc = [];
  for (let o = -A; o <= A + 1e-9; o += step) {
    const v = sampleHeight(centerX(z + L1) + o, z + L1) - sampleHeight(centerX(z + L2) + o, z + L2);
    sc.push([o, v]); if (v > best) best = v;
  }
  for (const [o, v] of sc) { const w = Math.exp((v - best) / temp); num += o * w; den += w; }
  return num / den;
}
function stats(vals, label) {
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  let d = 0, rev = 0;
  for (const v of vals) d += (v - m) ** 2;
  for (let i = 1; i < vals.length; i++) if (Math.sign(vals[i] - m) !== Math.sign(vals[i - 1] - m)) rev++;
  let jump = 0; for (let i = 1; i < vals.length; i++) jump = Math.max(jump, Math.abs(vals[i] - vals[i - 1]));
  console.log(`${label}: mean ${m.toFixed(1)} demeaned-rms ${Math.sqrt(d / vals.length).toFixed(2)} flips ${rev} max-step ${jump.toFixed(1)}`);
  return vals.map(v => v - m);
}
const Z = []; for (let z = 100; z <= 2300; z += 10) Z.push(z);
for (const temp of [0.5, 1.5, 4]) {
  const raw = Z.map(z => dropCentroid(z, 40, 100, 34, 8.5, temp));
  stats(raw, `centroid temp=${temp} raw`);
  // exponential smoothing along z, tau in metres
  for (const tau of [40, 80]) {
    const sm = []; let s = raw[0];
    for (let i = 0; i < raw.length; i++) { s += (raw[i] - s) * (10 / tau); sm.push(s); }
    stats(sm, `  temp=${temp} smoothed tau=${tau}m`);
  }
}
// local fall-line follower: track o, scan narrow window at z+L for min height
for (const [L, W, st, rate] of [[60, 30, 5, 0.35], [80, 40, 5, 0.25]]) {
  let o = 0; const vals = [];
  for (const z of Z) {
    let best = Infinity, bo = o;
    for (let d = -W; d <= W + 1e-9; d += st) { const h = sampleHeight(centerX(z + L) + o + d, z + L); if (h < best) { best = h; bo = o + d; } }
    o += (bo - o) * rate; vals.push(o);
  }
  stats(vals, `fallline L=${L} W=${W} rate=${rate}`);
}
