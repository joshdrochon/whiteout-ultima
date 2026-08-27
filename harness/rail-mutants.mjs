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
import { fileURLToPath, pathToFileURL } from 'node:url';

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
  { id: 'GR-14', name: 'erases arrival error on capture (how you land costs nothing)',
    patch: s => s.replace("          gs.balance = Math.max(-0.95, Math.min(0.95, seed));",
                          "          gs.balance = 0;   // MUTANT: arrival error erased") },
  { id: 'GR-05', name: 'balance is decoration (pinned to zero, stick does nothing)',
    patch: s => s.replace("    gs.balance = bEq + (gs.balance - bEq) * Math.exp(-cfg.settleRate * dt);",
                          "    gs.balance = 0;   // MUTANT: balance never responds to anything") },
  { id: 'GR-06', name: 'curves are FREE (no curve load, so no bend ever drops you)',
    patch: s => s.replace("      (aLat / A_AUTH) * cfg.curveLoadGain - (inp.steer ?? 0) * cfg.balanceGain));",
                          "      0 * aLat - (inp.steer ?? 0) * cfg.balanceGain));   // MUTANT: curvature free") },
  { id: 'GR-06', name: 'infinite authority (A_AUTH so large no bend can load the rider)',
    patch: s => s.replace("  const A_AUTH = 18.0;", "  const A_AUTH = 4000.0;   // MUTANT: curves cost nothing") },
  { id: 'GR-15', name: 'arrival wobble NEVER settles (a bad landing is permanent)',
    patch: s => s.replace("    gs.balance = bEq + (gs.balance - bEq) * Math.exp(-cfg.settleRate * dt);",
                          "    gs.balance = bEq + (gs.balance - bEq) * Math.exp(-0.001 * dt);   // MUTANT: no settling") },
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

// ===========================================================================
// SECOND LANE: the RAIL-OWNERSHIP gates, which do not live in rails.mjs.
//
// The user defect "the player literally falls right through the rail after a
// few feet" was NOT in the rails module and no GR mutant could have caught it:
// geometry, capture and constraint all held (690 locks, 0 fall-through, worst
// sink 0.021 m against a 0.11 m tube). The rider's carve stick never reached
// rails.mjs at all. Two files owned that, so two mutant sets:
//
//   PC-24  physics owns the rider's MODE — src/physics/physics.mjs, measured by
//          harness/physics-runner.mjs. physics.mjs has no imports, so a mutant
//          runs from a temp copy.
//   RIG    the shipped ROUTER — src/game/input.mjs, measured by
//          harness/rig-rail-fallthrough.mjs on the 9 real course rails. The rig
//          imports the router through SG_ROUTER_MODULE so a mutant never has to
//          be written into the tree.
// ===========================================================================
const PHYS = readFileSync(join(ROOT, 'src/physics/physics.mjs'), 'utf8');
const ROUTER = readFileSync(join(ROOT, 'src/game/input.mjs'), 'utf8');

const PHYS_MUTANTS = [
  { id: 'PC-24', name: 'constrainedStep leaves onGround frozen at its capture-frame value',
    patch: s => s.replace('    st.onGround = false;\n', '    // MUTANT: nobody owns the flag during a grind\n') },
  { id: 'PC-24', name: "step() dispatches on onGround BEFORE constrained (index.html's old order)",
    patch: s => s.replace("    if (mode === 'constrained') constrainedStep(state, input, dt);\n    else if (mode === 'ground') groundStep(state, input, dt);",
                          "    if (state.onGround) groundStep(state, input, dt);   // MUTANT: wrong precedence\n    else if (state.constrained) constrainedStep(state, input, dt);") },
  { id: 'PC-24', name: 'riderMode() reports ground for a rider who locked on from the snow',
    patch: s => s.replace("  return state.constrained ? 'constrained' : state.onGround ? 'ground' : 'air';",
                          "  return state.onGround ? 'ground' : state.constrained ? 'constrained' : 'air';   // MUTANT") },
];

const ROUTER_MUTANTS = [
  { id: 'RIG', name: 'stick routed on onGround FIRST (the shipped defect: balance channel starved)',
    patch: s => s.replace("  return riderMode(state) === 'air' ? 'spin' : 'steer';",
                          "  return state.onGround ? 'steer' : 'spin';   // MUTANT: the original bug") },
  { id: 'RIG', name: 'a grind counts as air, so the stick is spin for the whole rail',
    patch: s => s.replace("  return riderMode(state) === 'air' ? 'spin' : 'steer';",
                          "  return riderMode(state) === 'ground' ? 'steer' : 'spin';   // MUTANT") },
];

console.log('\nsecond lane: rail-ownership mutants (PC-24 + the shipped router) ...');
const rows2 = [];

// PHYSICS BASELINE, from the same temp location the mutants run from. Running
// physics-runner outside the tree makes JA-15..21 (which need the tricks module
// wired) fail for reasons that have nothing to do with the mutant, so the only
// honest question is whether PC-24 itself is clean here.
let physBaselineFails = [];
{
  const dir = mkdtempSync(join(tmpdir(), 'pc-base-'));
  const f = join(dir, 'physics.mjs'), out = join(dir, 'r.json');
  writeFileSync(f, PHYS);
  try {
    execFileSync(process.execPath, [join(ROOT, 'harness/physics-runner.mjs'), '--module', f, '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
  } catch { /* JA-15..21 are expected to fail outside the tree */ }
  let rep = null;
  try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch {}
  physBaselineFails = (rep?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
  rmSync(dir, { recursive: true, force: true });
}
const physBaselineClean = !physBaselineFails.includes('PC-24');
console.log(`  physics baseline: PC-24 ${physBaselineClean ? 'passes' : 'FAILS'}` +
  `  (location-only fails, ignored: ${physBaselineFails.filter(id => id !== 'PC-24').join(',') || 'none'})`);

for (const m of PHYS_MUTANTS) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-mut-'));
  const f = join(dir, 'physics.mjs');
  const patched = m.patch(PHYS);
  writeFileSync(f, patched);
  const out = join(dir, 'r.json');
  try {
    execFileSync(process.execPath, [join(ROOT, 'harness/physics-runner.mjs'), '--module', f, '--out', out],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
  } catch { /* non-zero exit expected */ }
  let rep = null;
  try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch {}
  rmSync(dir, { recursive: true, force: true });
  const failed = (rep?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
  const caught = failed.includes('PC-24');
  rows2.push({ ...m, applied: patched !== PHYS, caught, failed });
  console.log(`  ${caught ? 'CAUGHT ' : 'ESCAPED'} ${m.id}  ${m.name}` +
    `${patched !== PHYS ? '' : '   [PATCH DID NOT APPLY]'}  (failed: ${failed.join(',') || 'none'})`);
}

for (const m of ROUTER_MUTANTS) {
  const dir = mkdtempSync(join(tmpdir(), 'rig-mut-'));
  // the router imports ./physics.mjs — give the mutant a real one to import
  cpSync(join(ROOT, 'src/game/physics.mjs'), join(dir, 'physics.mjs'));
  const patched = m.patch(ROUTER);
  writeFileSync(join(dir, 'input.mjs'), patched);
  let rigExit = 0;
  try {
    execFileSync(process.execPath, [join(ROOT, 'harness/rig-rail-fallthrough.mjs')],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe',
        env: { ...process.env, SG_ROUTER_MODULE: pathToFileURL(join(dir, 'input.mjs')).href } });
  } catch (e) { rigExit = e.status ?? 1; }
  rmSync(dir, { recursive: true, force: true });
  const caught = rigExit !== 0;   // the rig exits 1 on starvation / bail-parity
  rows2.push({ ...m, applied: patched !== ROUTER, caught, failed: caught ? ['RIG'] : [] });
  console.log(`  ${caught ? 'CAUGHT ' : 'ESCAPED'} ${m.id}  ${m.name}` +
    `${patched !== ROUTER ? '' : '   [PATCH DID NOT APPLY]'}  (rig exit: ${rigExit})`);
}

// the rig must PASS on the honest router, or "caught" above means nothing
let rigBaseline = 0;
try {
  execFileSync(process.execPath, [join(ROOT, 'harness/rig-rail-fallthrough.mjs')],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, stdio: 'pipe' });
} catch (e) { rigBaseline = e.status ?? 1; }
console.log(`  rig baseline on the shipped router: exit ${rigBaseline}` +
  `${rigBaseline === 0 ? '' : '  [BASELINE DIRTY]'}`);

const allRows = [...rows, ...rows2];
const escaped = allRows.filter(r => !r.caught || !r.applied);
console.log(JSON.stringify({ baselineClean: baseFails.length === 0 && rigBaseline === 0 && physBaselineClean,
  mutants: allRows.length, caught: allRows.length - escaped.length,
  escaped: escaped.map(r => r.id) }));
process.exit((baseFails.length === 0 && rigBaseline === 0 && physBaselineClean
  && escaped.length === 0) ? 0 : 2);
