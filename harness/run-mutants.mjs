#!/usr/bin/env node
// Gate-law self-test for the run-structure lane.
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
const BASE = join(ROOT, 'harness/baseline-run/run.mjs');
const src = readFileSync(BASE, 'utf8');

// Each mutant breaks exactly one property. `expect` is the gate that MUST fail.
const MUTANTS = [
  { id: 'RS-01', name: 'timer keeps running after the finish',
    patch: s => s.replace("    if (rs.phase === 'running') {\n      rs.time_s += dt;",
                          "    if (rs.phase === 'running' || rs.phase === 'finished') {\n      rs.time_s += dt;") },
  { id: 'RS-02', name: 'finish never latches (phase reverts past the line)',
    // must act OUTSIDE the running-only block, or the mutant can never fire
    patch: s => s.replace("    // confinement: soft velocity push back toward the corridor (no teleports)",
                          "    if (rs.phase === 'finished' && ps.pos[2] > cfg.zFinish + 40) rs.phase = 'running';\n    // confinement: soft velocity push back toward the corridor (no teleports)") },
  { id: 'RS-03', name: 'results recomputed live after the finish',
    patch: s => s.replace("  function results(rs) { return rs.results; }",
                          "  function results(rs, ts) { return rs.results ? { ...rs.results, score: ts ? ts.score : rs.results.score, live: Math.random ? 0 : 0, t: rs.time_s + (rs._n = (rs._n || 0) + 1) } : null; }") },
  { id: 'RS-04', name: 'reported score disagrees with the trick system',
    patch: s => s.replace("        rs.results = { time_s: +rs.time_s.toFixed(2), score: ts.score,",
                          "        rs.results = { time_s: +rs.time_s.toFixed(2), score: ts.score * 1.1 + 5,") },
  { id: 'RS-05', name: 'no confinement (rider reaches backdrop terrain)',
    patch: s => s.replace("    if (Math.abs(dx) > cfg.halfWidth) {", "    if (false) {")
                 .replace("    if (ps.pos[2] > cfg.zFinish + 150) {", "    if (false) {") },
  { id: 'RS-06', name: 'confinement teleports instead of pushing',
    patch: s => s.replace("      const over = Math.abs(dx) - cfg.halfWidth;",
                          "      ps.pos[0] = cx + Math.sign(dx) * cfg.halfWidth * 0.5;   // TELEPORT\n      const over = Math.abs(dx) - cfg.halfWidth;") },
  { id: 'RS-07', name: 'restart does not reset the clock',
    patch: s => s.replace("  function restart(rs) { Object.assign(rs, init()); return rs; }",
                          "  function restart(rs) { const t = rs.time_s; Object.assign(rs, init()); rs.time_s = t; return rs; }") },
  { id: 'RS-09', name: 'start gate does not hold the rider',
    patch: s => s.replace("      else { ps.vel[0] = 0; ps.vel[2] = 0; }        // gate holds the rider",
                          "      else { /* MUTANT: no hold */ }") },
  { id: 'RS-11', name: 'acts on an in-bounds rider (corridor sized with V_CAP, ignoring skew)',
    patch: s => s.replace("    if (Math.abs(dx) > cfg.halfWidth) {",
                          "    if (Math.abs(dx) > cfg.halfWidth * 0.9) {   // MUTANT: fires inside the corridor") },
  { id: 'RS-10', name: 'fall-line steering autopilot',
    patch: s => s.replace("    // confinement: soft velocity push back toward the corridor (no teleports)",
`    { const cxn = env.courseCenterX(ps.pos[2] + 60);
      let d = Math.atan2(60, cxn - ps.pos[0]) - ps.heading;
      while (d > Math.PI) d -= 2*Math.PI; while (d < -Math.PI) d += 2*Math.PI;
      ps.heading += Math.max(-2.8*dt, Math.min(2.8*dt, d)); }
    // confinement: soft velocity push back toward the corridor (no teleports)`) },
];
// RS-08 is a coarse sanity band dominated by the probe drive, not the candidate
// (see its statement) — deliberately not mutation-tested; it cannot discriminate.

function runGates(modPath) {
  const tmp = mkdtempSync(join(tmpdir(), 'rs-mut-'));
  const out = join(tmp, 'r.json');
  try {
    execFileSync(process.execPath, [join(ROOT, 'harness/run-runner.mjs'), '--module', modPath, '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
  } catch { /* non-zero exit is expected for mutants */ }
  let rep = null;
  try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch {}
  rmSync(tmp, { recursive: true, force: true });
  return rep;
}

console.log('baseline (all gates must pass) ...');
const base = runGates('harness/baseline-run/run.mjs');
const baseFails = (base?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
console.log(`  baseline: ${base?.counts?.pass ?? '?'} pass, fails=[${baseFails.join(',')}]`);

const rows = [];
for (const m of MUTANTS) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-cand-'));
  cpSync(join(ROOT, 'harness/baseline-run'), dir, { recursive: true });
  const patched = m.patch(src);
  const applied = patched !== src;
  writeFileSync(join(dir, 'run.mjs'), patched);
  const rep = runGates(join(dir, 'run.mjs'));
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
