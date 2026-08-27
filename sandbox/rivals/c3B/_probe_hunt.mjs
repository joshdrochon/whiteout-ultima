import { pathToFileURL } from 'node:url';
import { dirname, resolve as _res } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = _res(dirname(fileURLToPath(import.meta.url)), '../../..');
const { sampleHeight } = await import(pathToFileURL(ROOT + '/src/render/main.mjs').href);
function rawCenterX(z) { let best = Infinity, bx = 0; for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } } return bx; }
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => { const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1; const raw = new Array(n); for (let i = 0; i < n; i++) raw[i] = rawCenterX(CL_Z0 + i * CL_STEP); const sm = new Array(n); for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += raw[j]; c++; } } sm[i] = a / c; } return sm; })();
const centerX = z => { const f = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP; const i = Math.min(CL.length - 2, Math.max(0, Math.floor(f))); const t = f - i; return CL[i] * (1 - t) + CL[i + 1] * t; };

// 1. true argmin vs smoothed centreline
let s = 0, n = 0, mx = 0;
for (let z = 100; z <= 2300; z += 10) { const d = rawCenterX(z) - centerX(z); s += d * d; n++; mx = Math.max(mx, Math.abs(d)); }
console.log('argmin - smoothed CL: rms', Math.sqrt(s / n).toFixed(2), 'max', mx.toFixed(1));

// 2. drop-hunt: offset maximising h(z+L1) - h(z+L2)
function hunt(z, L1, L2, A, step) {
  let best = -Infinity, bo = 0;
  for (let o = -A; o <= A; o += step) {
    const v = sampleHeight(centerX(z + L1) + o, z + L1) - sampleHeight(centerX(z + L2) + o, z + L2);
    if (v > best) { best = v; bo = o; }
  }
  return bo;
}
for (const [L1, L2, A, st] of [[40, 90, 36, 9], [30, 70, 30, 6], [50, 120, 40, 10]]) {
  let ss = 0, nn = 0, rev = 0, prev = 0; const vals = [];
  for (let z = 100; z <= 2300; z += 10) { const o = hunt(z, L1, L2, A, st); vals.push(o); ss += o * o; nn++; }
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  let d = 0; for (const v of vals) d += (v - m) ** 2;
  for (let i = 1; i < vals.length; i++) if (Math.sign(vals[i] - m) !== Math.sign(vals[i - 1] - m)) rev++;
  console.log(`hunt L1=${L1} L2=${L2} A=${A}: mean ${m.toFixed(1)} demeaned-rms ${Math.sqrt(d / vals.length).toFixed(2)} sign flips ${rev}`);
  console.log('  sample z=100..600:', vals.slice(0, 50).filter((_, i) => i % 5 === 0).join(' '));
}

// 3. how correlated is the drop-hunt with curvature?
const H = 200;
const kv = [], hv = [];
for (let z = 100; z <= 2300; z += 10) { kv.push(Math.max(-1, Math.min(1, ((centerX(z + H) - 2 * centerX(z) + centerX(z - H)) / (H * H)) / 2e-3))); hv.push(hunt(z, 40, 90, 36, 9)); }
const mk = kv.reduce((a, b) => a + b) / kv.length, mh = hv.reduce((a, b) => a + b) / hv.length;
let c = 0, vk = 0, vh = 0;
for (let i = 0; i < kv.length; i++) { c += (kv[i] - mk) * (hv[i] - mh); vk += (kv[i] - mk) ** 2; vh += (hv[i] - mh) ** 2; }
console.log('corr(kappa, hunt)', (c / Math.sqrt(vk * vh)).toFixed(3));
console.log('demeaned rms kappa-sat', Math.sqrt(vk / kv.length).toFixed(3));
