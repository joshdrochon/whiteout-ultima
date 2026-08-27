#!/usr/bin/env node
// Dev static server that sends NO-CACHE on everything.
//
// WHY THIS EXISTS: `python3 -m http.server` lets Chrome cache ES modules, and a
// query string on the HTML does not bust the module URLs it imports. That has
// already cost real time twice in this project — once reading a stale hud.mjs
// and concluding a rename had not applied, and once nearly "fixing" a terrain
// bug that was actually a stale module. A dev server that cannot serve stale
// code removes the whole class.
//
// usage: node tools/serve.mjs [port]
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] ?? 8080);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    // normalize + prefix check: no ../ escape out of the repo
    let p = resolve(join(ROOT, normalize(decodeURIComponent(url.pathname))));
    if (!p.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    let s = await stat(p).catch(() => null);
    if (s?.isDirectory()) { p = join(p, 'index.html'); s = await stat(p).catch(() => null); }
    if (!s) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(p);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(p)] ?? 'application/octet-stream',
      // The entire point.
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    }).end(body);
  } catch (e) {
    res.writeHead(500).end(String(e?.message ?? e));
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT} (no-cache)`));
