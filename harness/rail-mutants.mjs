#!/usr/bin/env node
// Gate-law self-test for the RAILS lane (same discipline as run-mutants.mjs).
//
// WHY THIS EXISTS: this lane burned five cycles because gates passed for the
// wrong reason (RS-03/04 compared 0 to 0; RS-09/10 never fired; RS-10's method
// was chaotic). A passing baseline proves nothing — a gate is only real if a
// module that breaks THAT property fails THAT gate. So: one mutant per gate,
// each derived from the honest baseline, run before any builder starts.
//
// usage: node harness/run-mutants.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'harness/baseline-rails/rails.mjs');
const src = readFileSync(BASE, 'utf8');

// Each mutant breaks exactly one property. `expect` is the gate that MUST fail.
const MUTANTS = [
  { id: 'GR-01', name: 'lock-on requires a button press (not automatic)',
    patch: s => s.replace("      if (gs._cool <= 0 && sp >= cfg.minLockSpeed_mps) {",
                          "      if (gs._cool <= 0 && sp >= cfg.minLockSpeed_mps && inp.grab) {") },
  { id: 'GR-03', name: 'rail drag is WORSE than snow (slower than riding past it)',
    patch: s => s.replace("    const lam = 0.25 * cfg.dragScale;", "    const lam = 0.25 * 3.0;   // MUTANT: rail slower than snow") },
  { id: 'GR-04', name: 'leaving the rail dumps speed',
    patch: s => s.replace("      ps.vel[0] = c.tang[0] * gs.alongSpeed; ps.vel[2] = c.tang[1] * gs.alongSpeed;\n    }\n    gs.t =",
                          "      ps.vel[0] = c.tang[0] * gs.alongSpeed * 0.6; ps.vel[2] = c.tang[1] * gs.alongSpeed * 0.6;\n    }\n    gs.t =") },
  { id: 'GR-05', name: 'balance is decorative (never drifts, never bails)',
    patch: s => s.replace("gs.balance += (drift + curveLoad) * dt - (inp.steer ?? 0) * cfg.balanceGain * dt;",
                          "gs.balance += 0;   // MUTANT: balance never moves") },
  { id: 'GR-06', name: 'curved rail holds the rider with no steering',
    patch: s => s.replace("curv = Math.asin(Math.max(-1, Math.min(1, cross)));",
                          "curv = 0;   // MUTANT: curvature ignored") },
  { id: 'GR-07', name: 'writes heading every frame (steering the board)',
    patch: s => s.replace("    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);",
                          "    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);\n    ps.heading = Math.atan2(c.tang[1], c.tang[0]);   // MUTANT: heading write") },
  { id: 'GR-11', name: 'props open physics coyote branch (airTime pinned while OFF the rail)',
    patch: s => s.replace("    const sp = Math.hypot(ps.vel[0], ps.vel[2]);",
                          "    const sp = Math.hypot(ps.vel[0], ps.vel[2]);\n    ps.airTime = 0; ps._popDone = false;   // MUTANT: coyote branch held open") },
  { id: 'GR-11', name: 'writes trick state directly (buys score the gate sheet cannot see)',
    patch: s => s.replace("    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);",
                          "    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);\n    ps.spinDeg = (ps.spinDeg ?? 0) + 300 * dt;   // MUTANT: direct trick-state write") },
  { id: 'GR-02', name: 'captures at a TRUE 2.5 m while declaring 1.0 (declaration lies)',
    patch: s => s.replace("        if (c && c.d <= cfg.captureRadius_m) {", "        if (c && c.d <= 2.5) {   // MUTANT: real radius != declared") },
  { id: 'GR-04', name: 'dumps 40% of speed one frame AFTER the exit',
    patch: s => s.replace("      gs.onRail = false; gs.lastLeaveSpeed = gs.alongSpeed; gs._cool = 0.5;",
                          "      gs.onRail = false; gs.lastLeaveSpeed = gs.alongSpeed; gs._cool = 0.5; gs._dump = 2;   // MUTANT")
                 .replace("    if (gs._cool > 0) gs._cool -= dt;",
                          "    if (gs._cool > 0) gs._cool -= dt;\n    if (gs._dump > 0) { gs._dump--; if (gs._dump === 0) { ps.vel[0] *= 0.6; ps.vel[2] *= 0.6; } }   // MUTANT") },
  { id: 'GR-07', name: 'teleports the rider +40 m on the lock frame (unbounded snap)',
    patch: s => s.replace("          ps.pos[0] = c.px; ps.pos[2] = c.pz; ps.pos[1] = c.py;",
                          "          ps.pos[0] = c.px; ps.pos[2] = c.pz + 40; ps.pos[1] = c.py;   // MUTANT: unbounded snap") },
  { id: 'GR-09', name: 'naive Euler under a RENAMED speed field (escapes a name-based probe)',
    patch: s => s.replace("gs.alongSpeed = term + (gs.alongSpeed - term) * Math.exp(-lam * dt);",
                          "gs.alongSpeed = gs.alongSpeed + (aTan - lam * gs.alongSpeed) * dt;   // MUTANT: Euler") },
  { id: 'GR-11', name: 'write-then-RESTORE trick state (invisible to a value diff)',
    patch: s => s.replace("    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);",
                          "    ps.vel[1] = gs.alongSpeed * (c.sinTheta ?? 0);\n    { const _s = ps.spinDeg; ps.spinDeg = _s + 999; ps.spinDeg = _s; }   // MUTANT") },
  { id: 'GR-13', name: 'descending rail carries no gravity along the tangent',
    patch: s => s.replace("    const aTan = -9.81 * (c.sinTheta ?? 0);", "    const aTan = 0;   // MUTANT: flat-rail assumption") },
  { id: 'GR-12', name: 'descending rail has no speed cap (leaks 60+ m/s into the air)',
    patch: s => s.replace("    gs.alongSpeed = Math.max(-33, Math.min(33, gs.alongSpeed));", "    // MUTANT: no cap") },
  { id: 'GR-08', name: 'phantom locks (captures from anywhere, at any speed)',
    patch: s => s.replace("        if (c && c.d <= cfg.captureRadius_m) {", "        if (c && c.d <= 50) {   // MUTANT") },
];
// GR-02 (capture radius band) is a declared-config check cross-verified by the
// hit/miss probe inside the gate itself; GR-08's mutant covers the "always locks"
// failure mode that would make it vacuous.

// GR-02 is a coarse sanity band dominated by the probe drive, not the candidate
// (see its statement) — deliberately not mutation-tested; it cannot discriminate.

function runGates(modPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'gr-mut-'));
  const out = join(tmp, 'r.json');
  try {
    execFileSync(process.execPath, [join(ROOT, 'harness/rail-runner.mjs'), '--module', modPath, '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
  } catch { /* non-zero exit is expected for mutants */ }
  let rep = null;
  try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch {}
  rmSync(tmp, { recursive: true, force: true });
  return rep;
}

console.log('baseline (all gates must pass) ...');
const base = runGates('harness/baseline-rails/rails.mjs');
const baseFails = (base?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
console.log(`  baseline: ${base?.counts?.pass ?? '?'} pass, fails=[${baseFails.join(',')}]`);

const rows = [];
for (const m of MUTANTS) {
  const dir = mkdtempSync(join(tmpdir(), 'gr-cand-'));
  cpSync(join(ROOT, 'harness/baseline-rails'), dir, { recursive: true });
  const patched = m.patch(src);
  const applied = patched !== src;
  writeFileSync(join(dir, 'rails.mjs'), patched);
  const rep = runGates(join(dir, 'rails.mjs'));
  rmSync(dir, { recursive: true, force: true });
  const failed = (rep?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
  const caught = failed.includes(m.id);
  rows.push({ ...m, applied, caught, failed });
  console.log(`  ${caught ? 'CAUGHT ' : 'ESCAPED'} ${m.id}  ${m.name}` +
    `${applied ? '' : '   [PATCH DID NOT APPLY]'}  (failed: ${failed.join(',') || 'none'})`);
}

const escaped = rows.filter(r => !r.caught || !r.applied);
console.log(JSON.stringify({ baselineClean: baseFails.length === 0,
  mutants: rows.length, caught: rows.length - escaped.length,
  escaped: escaped.map(r => r.id) }));
process.exit((baseFails.length === 0 && escaped.length === 0) ? 0 : 2);
