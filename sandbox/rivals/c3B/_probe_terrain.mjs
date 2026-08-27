import { pathToFileURL } from 'node:url';
import { dirname, resolve as _res } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = _res(dirname(fileURLToPath(import.meta.url)), '../../..');
const { sampleHeight } = await import(pathToFileURL(ROOT + '/src/render/main.mjs').href);
function rawCenterX(z) { let best = Infinity, bx = 0; for (let x = -320; x <= 420; x += 4) { const h = sampleHeight(x, z); if (h < best) { best = h; bx = x; } } return bx; }
const CL_STEP = 10, CL_Z0 = -400, CL_Z1 = 3200;
const CL = (() => { const n = Math.round((CL_Z1 - CL_Z0) / CL_STEP) + 1; const raw = new Array(n); for (let i = 0; i < n; i++) raw[i] = rawCenterX(CL_Z0 + i * CL_STEP); const sm = new Array(n); for (let i = 0; i < n; i++) { let a = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { a += raw[j]; c++; } } sm[i] = a / c; } return sm; })();
const centerX = z => { const f = (Math.min(Math.max(z, CL_Z0), CL_Z1) - CL_Z0) / CL_STEP; const i = Math.min(CL.length - 2, Math.max(0, Math.floor(f))); const t = f - i; return CL[i] * (1 - t) + CL[i + 1] * t; };
const H = 200;
console.log('z cx kappa*1e3 | h at -80 -40 -20 0 +20 +40 +80');
for (let z = 0; z <= 2400; z += 150) {
  const c = centerX(z);
  const k = (centerX(z + H) - 2 * centerX(z) + centerX(z - H)) / (H * H);
  const h0 = sampleHeight(c, z);
  const row = [-80, -40, -20, 0, 20, 40, 80].map(o => (sampleHeight(c + o, z) - h0).toFixed(1)).join(' ');
  console.log(z, c.toFixed(1), (k * 1e3).toFixed(3), '|', row);
}
let s = 0, n = 0, mx = 0, s2 = 0;
for (let z = 100; z <= 2300; z += 10) { const k = (centerX(z + H) - 2 * centerX(z) + centerX(z - H)) / (H * H); s += k * k; n++; mx = Math.max(mx, Math.abs(k)); const v = Math.max(-1, Math.min(1, k / 2e-3)); s2 += v * v; }
console.log('rms kappa', Math.sqrt(s / n).toExponential(3), 'max', mx.toExponential(3), 'rms sat(k/2e-3)', Math.sqrt(s2 / n).toFixed(3));
let m = 0; for (let z = 0; z <= 2400; z += 10) m = Math.max(m, Math.abs((centerX(z + 10) - centerX(z - 10)) / 20));
console.log('max |dx/dz|', m.toFixed(3));
// how many sign reversals of kappa across the graded grid
let rev = 0, prev = 0;
for (let z = 100; z <= 2300; z += 10) { const k = (centerX(z + H) - 2 * centerX(z) + centerX(z - H)) / (H * H); const s3 = Math.sign(k); if (prev && s3 && s3 !== prev) rev++; if (s3) prev = s3; }
console.log('kappa sign reversals (h=200):', rev);
// cost of one sampleHeight call
const t0 = process.hrtime.bigint(); let acc = 0;
for (let i = 0; i < 200000; i++) acc += sampleHeight(i % 300, (i * 7) % 2400);
console.log('sampleHeight us/call', (Number(process.hrtime.bigint() - t0) / 1e3 / 200000).toFixed(4), acc > -1e18);
