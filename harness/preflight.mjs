#!/usr/bin/env node
// ============================================================================
// LANE PRE-FLIGHT — attack the LAW before spending a cycle on candidates.
//
// WHY THIS EXISTS. Four blind cycles in a row died on defects in my own gate
// law rather than on bad candidates:
//   cycle 1  the rivals law had five escapes
//   cycle 2  the sheet could not see the property the cycle was about — a
//            module driving one shared line at four throttles scored 13/13
//   cycle 3  AI-14 graded UNLOCKED races, because the run cache keyed on
//            everything except throttleLock
// Every one was found by an adversary, an hour of agents after it should have
// been caught. None was found by the mutant table, because a mutant table only
// covers failure modes somebody already imagined.
//
// This is not a replacement for the mutant table. It checks the things that sit
// UNDERNEATH the gates — plumbing, coverage, and whether the law is even
// satisfiable at the bar the critic will judge against.
//
//   A. ORDER INDEPENDENCE. Every gate must read the same value run alone as it
//      does in a full sheet. This is exactly the cycle-3 bug, generalised from
//      the one gate that had it to all of them.
//   B. METRIC WIRING. Every metric named in PHYSICS_GATES.json must actually
//      come back as a number from the runner. A typo'd metric name reads
//      undefined, and undefined fails every comparison silently.
//   C. MUTANT COVERAGE. Every gate must have at least one mutant that fails it.
//      A gate nobody has ever seen fail is not evidence of anything.
//   D. SATISFIABILITY AT THE BAR. The one that would have saved a whole cycle:
//      take the thing the critic says it wants, build it, and check the law
//      permits it. If the law forbids the bar, no candidate can ever win and
//      three cycles of builders get crushed between them.
//
// usage: node harness/preflight.mjs [--lane rivals] [--skip A,B,C,D]
// ============================================================================
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const LANE = opt('lane', 'rivals');
const SKIP = (opt('skip', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const LANES = {
  rivals: {
    runner: 'harness/rival-runner.mjs',
    baseline: 'harness/baseline-rivals/rivals.mjs',
    mutants: 'harness/rival-mutants.mjs',
    prefix: 'AI-',
  },
};
const L = LANES[LANE];
if (!L) { console.error(`no pre-flight defined for lane "${LANE}"`); process.exit(2); }

const GATES = JSON.parse(readFileSync(join(ROOT, 'references/PHYSICS_GATES.json'), 'utf8'));
const gateList = (GATES.gates ?? GATES).filter(g => String(g.id).startsWith(L.prefix));

const findings = [];
const note = (check, severity, msg) => {
  findings.push({ check, severity, msg });
  console.log(`  ${severity === 'BLOCK' ? 'BLOCK  ' : 'note   '} ${msg}`);
};
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';

function sheet(modulePath, only = null) {
  const tmp = mkdtempSync(join(tmpdir(), 'preflight-'));
  const out = join(tmp, 'r.json');
  const argv = [join(ROOT, L.runner), '--module', modulePath, '--out', out];
  if (only) argv.push('--only', only);
  try {
    execFileSync(process.execPath, argv, { cwd: ROOT, encoding: 'utf8', timeout: 1800000, stdio: 'pipe' });
  } catch { /* non-zero exit just means a gate failed */ }
  let rep = null;
  try { rep = JSON.parse(readFileSync(out, 'utf8')); } catch { /* runner died */ }
  rmSync(tmp, { recursive: true, force: true });
  return rep;
}

console.log(`\n=== LANE PRE-FLIGHT: ${LANE} — attacking the law, not the candidates ===\n`);

// ---------------------------------------------------------------------------
// A. ORDER INDEPENDENCE
// ---------------------------------------------------------------------------
let full = null;
if (!SKIP.includes('A')) {
  console.log(`[A] order independence — every gate must read the same alone as in a full sheet`);
  full = sheet(L.baseline);
  if (!full) note('A', 'BLOCK', 'the runner produced no report for the baseline at all');
  else {
    for (const g of gateList) {
      // RUN ALONE TWICE. Some gates are wall-clock timings and are simply noisy:
      // AI-13 measured 0.0020 / 0.0015 / 0.0026 on three identical invocations.
      // Comparing one alone-run against the full sheet flagged that as run-order
      // dependence, which is a FALSE POSITIVE — and a pre-flight that cries wolf
      // is one you learn to ignore, which is how a check like this rots. The
      // second alone-run establishes the gate's own noise floor, and only a gap
      // WIDER than that noise counts as order dependence.
      const a1 = sheet(L.baseline, g.id)?.results?.find(r => r.id === g.id);
      const f = full.results.find(r => r.id === g.id);
      if (!a1 || !f) { note('A', 'BLOCK', `${g.id} missing from one of the two reports`); continue; }
      if (JSON.stringify(a1.value) === JSON.stringify(f.value)) continue;
      const a2 = sheet(L.baseline, g.id)?.results?.find(r => r.id === g.id);
      const nums = [a1.value, a2?.value, f.value].every(v => typeof v === 'number');
      if (nums) {
        const noise = Math.abs(a1.value - a2.value);
        const gap = Math.abs(f.value - a1.value);
        if (gap <= noise) {
          console.log(`  ok     ${g.id} differs by ${gap.toPrecision(2)} but repeats itself by ` +
            `${noise.toPrecision(2)} — noise, not order`);
          continue;
        }
        note('A', 'BLOCK', `${g.id} DEPENDS ON RUN ORDER: ${f.value} in a full sheet vs ${a1.value} alone, ` +
          `gap ${gap.toPrecision(3)} against a repeat-noise floor of ${noise.toPrecision(3)} ` +
          `— a cached run from an earlier gate is being reused with the wrong parameters`);
      } else {
        note('A', 'BLOCK', `${g.id} DEPENDS ON RUN ORDER: ${f.value} in a full sheet vs ${a1.value} alone`);
      }
    }
    console.log(`  ...${gateList.length} gates checked (${secs()})`);
  }
}

// ---------------------------------------------------------------------------
// B. METRIC WIRING
// ---------------------------------------------------------------------------
if (!SKIP.includes('B')) {
  console.log(`\n[B] metric wiring — every declared metric must come back as a number`);
  full = full ?? sheet(L.baseline);
  for (const g of gateList) {
    const r = full?.results?.find(x => x.id === g.id);
    if (!r) { note('B', 'BLOCK', `${g.id} produced no row`); continue; }
    if (r.status === 'error') { note('B', 'BLOCK', `${g.id} ERRORED: ${String(r.error).slice(0, 140)}`); continue; }
    if (r.value === undefined || r.value === null || Number.isNaN(r.value)) {
      note('B', 'BLOCK', `${g.id} metric "${g.metric}" came back ${r.value} — the runner does not return that key, ` +
        `and undefined silently fails every comparison`);
    }
  }
  console.log(`  ...done (${secs()})`);
}

// ---------------------------------------------------------------------------
// C. MUTANT COVERAGE
// ---------------------------------------------------------------------------
if (!SKIP.includes('C')) {
  console.log(`\n[C] mutant coverage — every gate needs a mutant that fails it`);
  const src = readFileSync(join(ROOT, L.mutants), 'utf8');
  const covered = new Set([...src.matchAll(/\{\s*id:\s*'([A-Z]+-\d+)'/g)].map(m => m[1]));
  for (const g of gateList) {
    if (!covered.has(g.id)) {
      note('C', 'BLOCK', `${g.id} has NO MUTANT. It has never been seen to fail, so passing it means nothing. ` +
        `Its statement is: ${String(g.statement).slice(0, 110)}...`);
    }
  }
  console.log(`  ...${covered.size} gate ids referenced by mutants (${secs()})`);
}

// ---------------------------------------------------------------------------
// D. SATISFIABILITY AT THE BAR
// ---------------------------------------------------------------------------
// THE CHECK THAT WOULD HAVE SAVED A CYCLE. AI-07/08/09 require a tier ladder —
// hard beats the player, easy is beatable, tiers separate by >= 3%. The critic
// then demands a race whose winner you cannot predict. With one hard slot in a
// four-rider roster those two things pull against each other, and three cycles
// of candidates were crushed in between with no gate able to report it.
//
// So: BUILD THE THING THE BAR ASKS FOR and see whether the law permits it. Not
// a candidate — a deliberately crude probe. If it cannot pass, the finding is
// about the LAW, and no amount of builder effort will fix it.
if (!SKIP.includes('D')) {
  console.log(`\n[D] satisfiability — can a module that meets the critic's bar pass the law at all?`);
  const base = readFileSync(join(ROOT, L.baseline), 'utf8');
  const probes = [
    { name: 'THE UPSET: medium tier strong enough to beat hard on some seeds',
      why: 'the critic wants a winner you cannot predict; AI-08/AI-09 may forbid it',
      patch: s => s.replace("  medium: {\n    stats: { speed: 20, edging: 20, trick: 20 },",
                            "  medium: {\n    stats: { speed: 31, edging: 30, trick: 22 },   // PROBE: nearly hard") },
    { name: 'THE CLOSE FIELD: every tier within a few seconds of the player',
      why: 'the critic wants the player mid-pack and pressured; AI-09 needs 3% tier separation',
      patch: s => s.replace("    brakeDuty: 0.20,    // scrubs a fifth of the run away",
                            "    brakeDuty: 0.09,    // PROBE: easy tier brought close") },
  ];
  const dir = mkdtempSync(join(tmpdir(), 'preflight-sat-'));
  for (const p of probes) {
    const src = p.patch(base);
    if (src === base) { note('D', 'BLOCK', `probe "${p.name}" did not apply — its anchor has moved, so this check is DEAD and silently passing`); continue; }
    const pd = join(dir, p.name.replace(/\W+/g, '_'));
    mkdirSync(pd, { recursive: true });
    const f = join(pd, 'rivals.mjs');
    writeFileSync(f, src);
    const rep = sheet(f);
    const fails = (rep?.results ?? []).filter(r => r.status !== 'pass');
    if (!rep) { note('D', 'BLOCK', `probe "${p.name}" produced no report`); continue; }
    if (fails.length) {
      note('D', 'BLOCK', `THE LAW FORBIDS THE BAR — "${p.name}" (${p.why}) fails ` +
        fails.map(r => `${r.id} ${r.metric}=${r.value} want ${r.expect}`).join('; ') +
        `. No candidate can satisfy both the law and the critic here; the LAW is what has to change.`);
    } else {
      console.log(`  ok     "${p.name}" passes the full sheet — the bar is reachable`);
    }
  }
  rmSync(dir, { recursive: true, force: true });
  console.log(`  ...done (${secs()})`);
}

// ---------------------------------------------------------------------------
const blocks = findings.filter(f => f.severity === 'BLOCK');
console.log(`\n=== PRE-FLIGHT ${blocks.length ? 'FOUND ' + blocks.length + ' BLOCKER(S)' : 'CLEAN'} in ${secs()} ===`);
for (const b of blocks) console.log(`  [${b.check}] ${b.msg}`);
console.log(JSON.stringify({ lane: LANE, blockers: blocks.length,
  findings: findings.map(f => ({ check: f.check, msg: f.msg })) }));
process.exit(blocks.length ? 1 : 0);
