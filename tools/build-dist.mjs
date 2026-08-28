#!/usr/bin/env node
// Build a self-contained static bundle in dist/ for any static host.
//
// The game imports bare "three" and "three/addons/" specifiers through an
// importmap that points at /node_modules/. That works locally and does not
// exist on a static host, and shipping node_modules/three would be 18.5 MB for
// three files. This vendors ONLY what the app actually pulls in — verified by
// grepping the source rather than assumed:
//     three.module.js                       650 KB
//     addons/loaders/GLTFLoader.js          the only addon the app imports
//     addons/utils/BufferGeometryUtils.js   GLTFLoader imports it
//     addons/utils/SkeletonUtils.js         GLTFLoader imports it
// and rewrites the importmap to point at /vendor/.
//
// Harness pages, tests, sandbox and tools are NOT copied: they are the
// development apparatus, some of them load fixtures that do not ship, and none
// of them belong on a public URL.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// src/shaders/_capture and _check hold the SV gate's reference screenshots — 3.4 MB of
// PNGs that are test fixtures, not game content, and nothing at runtime reads
// them. Same for any other _capture dir that appears later.
// _capture/_check are shader-gate reference screenshots; assets/mocap holds BVH
// files used once for pose retargeting experiments. Nothing at runtime reads any
// of them — verified by grepping src/ and index.html for 'mocap' and '.bvh'.
const skip = (src) => !/[\\/]_(capture|check)([\\/]|$)/.test(src)
                   && !/[\\/]assets[\\/]mocap([\\/]|$)/.test(src);
for (const d of ['src', 'assets'])
  cpSync(join(ROOT, d), join(OUT, d), { recursive: true, filter: skip });

const V = join(OUT, 'vendor');
mkdirSync(join(V, 'addons', 'loaders'), { recursive: true });
mkdirSync(join(V, 'addons', 'utils'), { recursive: true });
const TM = join(ROOT, 'node_modules/three');

// FOLLOW RELATIVE IMPORTS TRANSITIVELY. Copying a hand-written list is how the
// first bundle shipped broken: three.module.js imports './three.core.js', that
// file was not on the list, and the whole module graph died with "failed to
// fetch dynamically imported module" — served 200, imported nothing. Bare
// specifiers ("three") are left alone; the importmap resolves those.
function vendor(srcFile, dstFile) {
  if (existsSync(dstFile)) return;
  mkdirSync(dirname(dstFile), { recursive: true });
  cpSync(srcFile, dstFile);
  const code = readFileSync(srcFile, 'utf8');
  const re = /from\s+['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(code))) {
    const rel = m[1];
    vendor(resolve(dirname(srcFile), rel), resolve(dirname(dstFile), rel));
  }
}
vendor(join(TM, 'build/three.module.js'), join(V, 'three.module.js'));
for (const f of ['loaders/GLTFLoader.js', 'utils/BufferGeometryUtils.js', 'utils/SkeletonUtils.js'])
  vendor(join(TM, 'examples/jsm', f), join(V, 'addons', f));

// index.html, with the importmap repointed at the vendored copies
let html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const before = html;
html = html
  .replace('/node_modules/three/build/three.module.js', '/vendor/three.module.js')
  .replace('/node_modules/three/examples/jsm/', '/vendor/addons/');
if (html === before) throw new Error('importmap not rewritten — its paths have changed');
writeFileSync(join(OUT, 'index.html'), html);

// SPA-less static hosts still want a 404; point it at the game.
writeFileSync(join(OUT, '_redirects'), '/*  /index.html  200\n');

const size = (p) => { let n = 0;
  for (const e of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, e.name);
    n += e.isDirectory() ? size(q) : statSync(q).size;
  }
  return n; };
console.log(`dist/ built — ${(size(OUT) / 1048576).toFixed(1)} MB`);
for (const d of readdirSync(OUT, { withFileTypes: true }))
  if (d.isDirectory()) console.log(`  ${d.name.padEnd(8)} ${(size(join(OUT, d.name)) / 1048576).toFixed(1)} MB`);
