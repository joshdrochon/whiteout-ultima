#!/usr/bin/env node
// ============================================================================
// Gate-law self-test for the RIVALS lane (same discipline as rail-mutants.mjs).
//
// WHY THIS EXISTS: a passing baseline proves nothing. A gate is only real if a
// module that breaks THAT property fails THAT gate. This lane's draft law came
// with its own list of the nine mutants to write first; they are all here, plus
// the ones the runner's own design invited, plus — the part that mattered — the
// ones written by ATTACKING THE LAW: copy the honest baseline, remove or fake
// one property, and try to keep all 13 gates green. Four of those attacks
// succeeded on the first version of this sheet:
//
//   * a rival with an INFINITE BOOST METER (self.boostMeter = 1 every frame) on
//     the five seeds AI-01 did not replay: 13/13 green. AI-06 watched
//     pos/vel/heading — the seven numbers a cheat SPENDS — and never looked at
//     the resources it spends them from.
//   * a rival that RUBBER-BANDED at 1.31 on the five seeds AI-05's size clause
//     did not sample: reported 1.08.
//   * a MOVING CONE that twitched the jump key every 2 s with no crouch behind
//     it: 22 "pops", 46.8 s of air, AI-10 green. And a rider welded to a fixed
//     4.5 m offset from the centreline: RMS 18.3 m against a 2 m bar, green.
//   * a rival that burned 250 ms in init() and reported 0.0009 ms/frame, plus
//     one whose input objects burned 400k sqrt per frame inside GETTERS that
//     sanitizeInput evaluated outside the timer.
//
// Every one of those is a mutant below now, and every one of them fails.
//
// usage: node harness/rival-mutants.mjs           (the whole table)
//        node harness/rival-mutants.mjs --full-sheet   (grade all 13 gates per
//                                                       mutant; slower, shows
//                                                       collateral failures)
// ============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = join(ROOT, 'harness/baseline-rivals/rivals.mjs');
const src = readFileSync(BASE, 'utf8');
const FULL_SHEET = process.argv.includes('--full-sheet');

// The line every mutant that needs a hook attaches to: the last thing driveOne
// does before returning its input object.
const RETURN_HOOK = '    if (jumpRelease) inp.jumpRelease = true;\n    return inp;';
// The seed the module can read — the hook for every "cheat only where the probe
// is not looking" mutant.
const SEED_HOOK = 'export function createRivals(env = {}) {';

// Each mutant breaks exactly one property. `id` is the gate that MUST fail.
const MUTANTS = [
  // ---- the draft's own _mutantsToWriteFirst -------------------------------
  { id: 'AI-01', name: 'nudges ps.pos[0] by 0.01 once a second (a cutscene, not a racer)',
    patch: s => s.replace(RETURN_HOOK,
      '    R._nudge = (R._nudge ?? 0) + dt;\n' +
      '    if (R._nudge >= 1) { R._nudge -= 1; self.pos[0] += 0.01; }   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-02', name: 'emits steer: 3.0 on one frame',
    patch: s => s.replace(RETURN_HOOK,
      '    if (Math.abs(t - 20) < 0.009) inp.steer = 3.0;   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-03', name: 'freezes one rival\'s input after 20 s (it never finishes)',
    patch: s => s.replace(RETURN_HOOK,
      '    if (R.tier === \'easy\' && t > 20) return { brake: true };   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-05', name: 'applies catch-up while the rival is AHEAD',
    patch: s => s.replace(
      '      if (behind > ASSIST_DEADBAND_M) {\n        assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);\n      }',
      '      assist = clamp(Math.abs(behind) / ASSIST_RANGE_M, 0, 1);   // MUTANT: sign ignored') },

  { id: 'AI-06', name: 'grants +8 m/s directly when behind',
    patch: s => s.replace(RETURN_HOOK,
      '    if (assist > 0.5 && !R._granted) { R._granted = true;\n' +
      '      const sp = Math.hypot(self.vel[0], self.vel[2]) || 1;\n' +
      '      self.vel[0] *= (sp + 8) / sp; self.vel[2] *= (sp + 8) / sp; }   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-08', name: 'the hard tier is 20% slower (the player always wins)',
    patch: s => s.replace('    boostDuty: 0.42,\n    brakeDuty: 0.02,',
      '    boostDuty: 0.0,\n    brakeDuty: 0.16,   // MUTANT: hard tier gutted') },

  { id: 'AI-09', name: 'all three tiers get identical parameters',
    patch: s => s.replace('const TIERS = {', 'const _T0 = {')
      .replace('};\n\n// Catch-up. BOUNDED',
        '};\nconst TIERS = { easy: _T0.medium, medium: _T0.medium, hard: _T0.medium };   // MUTANT\n\n// Catch-up. BOUNDED') },

  { id: 'AI-10', name: 'pinned to the centreline, never pops (a moving cone)',
    patch: s => s.replace('        lane: laneSlot(i, roster.length) + (rnd() * 2 - 1) * 1.5,',
      '        lane: 0,   // MUTANT: pinned to the centreline')
      .replace('const LANE_WEAVE_M = 4;', 'const LANE_WEAVE_M = 0;   // MUTANT')
      .replace('      if (R.popTimer <= 0 && self.onGround) { R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; }',
        '      /* MUTANT: never pops */') },

  { id: 'AI-11', name: 'seeds the rival RNG from Date.now()',
    patch: s => s.replace('      const rnd = mulberry32(mix(seed, i));',
      '      const rnd = mulberry32(mix(Date.now() | 0, i));   // MUTANT') },

  // ---- mutants the runner's own design invited ----------------------------
  { id: 'AI-02', name: 'emits tuck: 1 instead of true (truthy, but not a key the keyboard produces)',
    patch: s => s.replace('    const inp = { steer, boost, tuck: T.tuck && !crouch };',
      '    const inp = { steer, boost, tuck: (T.tuck && !crouch) ? 1 : 0 };   // MUTANT') },

  { id: 'AI-02', name: 'emits uber: 9 (outside the six uber slots)',
    patch: s => s.replace(RETURN_HOOK,
      '    if (Math.abs(t - 30) < 0.009) inp.uber = 9;   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-01', name: 'writes heading directly (steers the board instead of the rider)',
    patch: s => s.replace(RETURN_HOOK,
      '    self.heading += 0.002;   // MUTANT: direct heading write\n' + RETURN_HOOK) },

  // This one ESCAPED the first time this table was run: the runner's watcher
  // diffed VALUES around mod.step, and a write that lands back on its own value
  // is invisible to a differ. It is caught now by an ASSIGNMENT watcher — the
  // same instrument GR-11 needed in the rails lane, for the same reason.
  { id: 'AI-06', name: 'GRANTS AND CANCELS speed each frame (invisible to a value diff)',
    patch: s => s.replace(RETURN_HOOK,
      '    { const k = self.vel[0]; self.vel[0] = k * 1.5; self.vel[0] = k; }   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-06', name: 'SLOWS THE PLAYER instead of speeding itself up',
    patch: s => s.replace(RETURN_HOOK,
      '    if (player && assist > 0.2) { player.vel[0] *= 0.999; player.vel[2] *= 0.999; }   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-04', name: 'aims 200 m off the centreline (leaves the course)',
    patch: s => s.replace('const CORRIDOR_MARGIN_M = 25;', 'const CORRIDOR_MARGIN_M = -200;   // MUTANT')
      .replace('        lane: laneSlot(i, roster.length) + (rnd() * 2 - 1) * 1.5,',
        '        lane: 200 * (i % 2 ? 1 : -1),   // MUTANT') },

  { id: 'AI-07', name: 'the easy tier is as fast as the hard tier (nothing is beatable)',
    patch: s => s.replace('    boostDuty: 0.00,    // never touches boost\n    brakeDuty: 0.20,',
      '    boostDuty: 0.42,\n    brakeDuty: 0.02,   // MUTANT: easy tier is a hard rival') },

  { id: 'AI-12', name: 'shepherds the player (glues itself to the player\'s position)',
    patch: s => s.replace('    const tx = centerX(tz) + lane;',
      '    const tx = player ? player.pos[0] : centerX(tz) + lane;   // MUTANT: tails the player') },

  // CALIBRATED, not guessed. A first version busy-waited on Date.now() for 1 ms
  // per rival and ESCAPED: once V8 warms the loop the wall time collapses, and
  // 120k sqrt iterations measured 2 ms cold but 0.165 ms warm, so the frame cost
  // came out at 0.66 ms against a 1.5 ms bar. 400k warm iterations per rival is
  // ~0.55 ms each, ~2.2 ms per frame with four rivals.
  { id: 'AI-13', name: 'burns ~2.2 ms of CPU per frame',
    patch: s => s.replace(RETURN_HOOK,
      '    { let q = 0; for (let i = 0; i < 400000; i++) q += Math.sqrt(i + 1); if (q < 0) inp.grab = true; }   // MUTANT\n' + RETURN_HOOK) },

  { id: 'AI-11', name: 'ignores the seed entirely (eight seeds are one run, eight times)',
    patch: s => s.replace('      const rnd = mulberry32(mix(seed, i));',
      '      const rnd = mulberry32(mix(12345, i));   // MUTANT: seed ignored') },

  // =========================================================================
  // THE AUDIT MUTANTS. Every one of these PASSED the first version of this
  // sheet. They are the reason the runner changed; they are kept so it cannot
  // change back.
  // =========================================================================

  // 1. THE RESOURCE GRANT. AI-06 used to diff pos/vel/heading only. This module
  //    never touches any of the three: it refills the boost meter physics owns
  //    and holds the key down. Escaped at 13/13 (hard tier 89.1 s against the
  //    honest 91.2 s). Now: AI-06 diffs the WHOLE state and names the field.
  { id: 'AI-06', name: 'AUDIT: refills self.boostMeter every frame (an infinite meter, no vel write)',
    patch: s => s.replace(SEED_HOOK, SEED_HOOK +
      '\n  const CHEAT = ![1, 2, 5].includes((env.seed ?? 1) | 0);   // MUTANT: only where the old probe never looked')
      .replace(RETURN_HOOK,
        '    if (CHEAT && R.tier === \'hard\') { self.boostMeter = 1; inp.boost = true; }   // MUTANT\n' + RETURN_HOOK) },

  // 2. THE SEED-SHAPED CHEAT. AI-01 replayed 3 of the 40 tapes; this nudges pos
  //    only on a seed that was not one of them.
  { id: 'AI-01', name: 'AUDIT: nudges pos only on seed 7 (the old replay sampled seeds 1, 5 and 2)',
    patch: s => s.replace(SEED_HOOK, SEED_HOOK +
      '\n  const CHEAT7 = ((env.seed ?? 1) | 0) === 7;   // MUTANT')
      .replace(RETURN_HOOK,
        '    if (CHEAT7) { R._n7 = (R._n7 ?? 0) + dt; if (R._n7 >= 1) { R._n7 -= 1; self.pos[0] += 0.01; } }   // MUTANT\n' + RETURN_HOOK) },

  // 3. THE SEED-SHAPED RUBBER BAND. AI-05's size clause used to read one live
  //    seed (3) and two frozenAhead races (1, 2). This one behaves on exactly
  //    those and rubber-bands at 1.31 everywhere else.
  { id: 'AI-05', name: 'AUDIT: rubber-bands hard on seeds 4..8, behaves on the three the old clause sampled',
    patch: s => s.replace(
      '      if (behind > ASSIST_DEADBAND_M) {\n        assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);\n      }',
      '      if (behind > ASSIST_DEADBAND_M && ![1, 2, 3].includes((env.seed ?? 1) | 0) && R.tier === \'medium\') assist = 1;   // MUTANT\n' +
      '      else if (behind > ASSIST_DEADBAND_M) assist = clamp((behind - ASSIST_DEADBAND_M) / ASSIST_RANGE_M, 0, 1);')
      .replace('    const bDuty = T.boostDuty;',
        '    const bDuty = T.boostDuty + 0.45 * assist * (R.tier === \'medium\' ? 1 : 0);   // MUTANT')
      .replace('    const kDuty = T.brakeDuty * (1 - ASSIST_SCRUB_CUT * assist);',
        '    const kDuty = T.brakeDuty * (1 - (R.tier === \'medium\' ? 1 : ASSIST_SCRUB_CUT) * assist);   // MUTANT') },

  // 4. THE TWITCH. AI-10 used to count bare jumpRelease frames; a release at
  //    charge 0 is J_MIN = 2.1 m/s, ~0.22 m of hop. 22 "pops" per run, green.
  { id: 'AI-10', name: 'AUDIT: twitches the jump key every 2 s with no crouch behind it (uncharged hops)',
    patch: s => s.replace('      if (R.popTimer <= 0 && self.onGround) { R.crouchLeft = CROUCH_S; R.popTimer = POP_PERIOD_S; }',
      '      if (R.popTimer <= 0) { R.popTimer = 2.0; if (self.onGround) jumpRelease = true; }   // MUTANT: never charged') },

  // 5. THE FIXED LINE. AI-10 used to grade RMS deviation from the centreline,
  //    which a rider welded to a 4.5 m offset satisfies by standing still in the
  //    lateral sense: measured RMS 18.1 m, lateral STANDARD DEVIATION 1.35 m.
  { id: 'AI-10', name: 'AUDIT: welded to a fixed offset (8 m lookahead, gain 4) — high RMS, no line at all',
    patch: s => s.replace('const LANE_WEAVE_M = 4;', 'const LANE_WEAVE_M = 0;   // MUTANT')
      .replace('        lane: laneSlot(i, roster.length) + (rnd() * 2 - 1) * 1.5,',
        '        lane: laneSlot(i, roster.length),   // MUTANT')
      .replace('    look: 150,          // m of lookahead on the centreline', '    look: 8,   // MUTANT')
      .replace('    look: 130,', '    look: 8,   // MUTANT')
      .replace('    look: 105,', '    look: 8,   // MUTANT')
      .replace('    gain: 1.6,          // steering commitment', '    gain: 4.0,   // MUTANT')
      .replace('    gain: 1.7,', '    gain: 4.0,   // MUTANT')
      .replace('    gain: 1.9,', '    gain: 4.0,   // MUTANT') },

  // 6. THE HITCH THE FRAME TIMER CANNOT SEE. 166 ms in init(), 0.0015 ms/frame.
  { id: 'AI-13', name: 'AUDIT: burns ~170 ms inside init() (a stall at the start gate, not in the frame)',
    patch: s => s.replace('  function init() {\n    const rivals = {};',
      '  function init() {\n    { let q = 0; for (let i = 0; i < 120000000; i++) q += i % 7; if (q < 0) throw 0; }   // MUTANT\n    const rivals = {};') },

  // 7. THE COST BILLED TO THE HARNESS. The input object's getters ran inside
  //    sanitizeInput, outside the hrtime window: 400k sqrt per rival per frame
  //    reported as 0.0011 ms/frame.
  { id: 'AI-13', name: 'AUDIT: returns inputs whose GETTERS burn CPU (cost lands outside mod.step)',
    patch: s => s.replace(RETURN_HOOK,
      '    if (jumpRelease) inp.jumpRelease = true;\n' +
      '    const _s = inp.steer;\n' +
      '    Object.defineProperty(inp, \'steer\', { enumerable: true, configurable: true,\n' +
      '      get() { let q = 0; for (let i = 0; i < 400000; i++) q += Math.sqrt(i + 1); return q < 0 ? 0 : _s; } });   // MUTANT\n' +
      '    return inp;') },
];

// Each mutant is graded on ITS OWN gate (--only), which is the question this
// table asks. It is also what keeps it affordable inside npm test: the CPU-burn
// and getter-burn mutants cost minutes if they are made to drag the other
// twelve gates' races along with them. --full-sheet grades all 13.
function runGates(modPath, gateId) {
  const tmp = mkdtempSync(join(tmpdir(), 'ai-mut-'));
  const out = join(tmp, 'r.json');
  const argv = [join(ROOT, 'harness/rival-runner.mjs'), '--module', modPath, '--out', out];
  if (!FULL_SHEET && gateId) argv.push('--only', gateId);
  try {
    execFileSync(process.execPath, argv,
      { cwd: ROOT, encoding: 'utf8', timeout: 900000, stdio: 'pipe' });
  } catch { /* non-zero exit is expected for mutants */ }
  let rep = null;
  try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch { /* nothing written */ }
  rmSync(tmp, { recursive: true, force: true });
  return rep;
}

console.log('baseline (all 13 gates must pass) ...');
const t0 = Date.now();
const base = runGates('harness/baseline-rivals/rivals.mjs', null);
const baseFails = (base?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
console.log(`  baseline: ${base?.counts?.pass ?? '?'} pass, fails=[${baseFails.join(',')}]  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

const rows = [];
for (const m of MUTANTS) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-cand-'));
  cpSync(join(ROOT, 'harness/baseline-rivals'), dir, { recursive: true });
  const patched = m.patch(src);
  const applied = patched !== src;
  writeFileSync(join(dir, 'rivals.mjs'), patched);
  const t1 = Date.now();
  const rep = runGates(join(dir, 'rivals.mjs'), m.id);
  rmSync(dir, { recursive: true, force: true });
  const own = (rep?.results ?? []).find(r => r.id === m.id);
  const failed = (rep?.results ?? []).filter(r => r.status !== 'pass').map(r => r.id);
  const caught = failed.includes(m.id);
  rows.push({ ...m, applied, caught, failed });
  console.log(`  ${caught ? 'CAUGHT ' : 'ESCAPED'} ${m.id}  ${m.name}` +
    `${applied ? '' : '   [PATCH DID NOT APPLY]'}` +
    `  (${own ? `${own.metric} = ${own.value} want ${own.expect}` : 'NO ROW'}` +
    `${FULL_SHEET ? `; also failed: ${failed.filter(x => x !== m.id).join(',') || 'nothing'}` : ''}` +
    `, ${((Date.now() - t1) / 1000).toFixed(1)} s)`);
}

const escaped = rows.filter(r => !r.caught || !r.applied);
console.log(`\ntotal ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(JSON.stringify({ baselineClean: baseFails.length === 0,
  mutants: rows.length, caught: rows.length - escaped.length,
  escaped: escaped.map(r => r.id) }));
process.exit((baseFails.length === 0 && escaped.length === 0) ? 0 : 2);
