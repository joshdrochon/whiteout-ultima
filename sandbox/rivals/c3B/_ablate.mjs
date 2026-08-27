// Ablation / sweep driver. Writes a textually patched copy of rivals.mjs to a
// scratch file and runs _lab.mjs against it in a child process, so the shipped
// module never carries a tuning hook. Every number in NOTES.md's ablation
// table came out of this, and every one of them was re-confirmed against
// harness/rival-runner.mjs for the variants that matter.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, 'rivals.mjs');
const OUT = '/private/tmp/claude-501/-Users-joanmiguel-Desktop-Developer/17d1937a-bfbe-4270-ae51-384ba73ddf39/scratchpad/abl';
mkdirSync(OUT, { recursive: true });

const base = readFileSync(SRC, 'utf8');

// name -> list of [find, replace]
const VARIANTS = {
  none: [],
  'no-dodge': [['const DODGE_STEER = ', 'const DODGE_STEER_UNUSED = ']],
  'no-hunter-gain': [['const HUNT_GAIN = 1.65;', 'const HUNT_GAIN = 0;']],
  'no-arch-amp': [['apex:   { amp:', 'apex:   { amp0:'], ['bank:   { amp:', 'bank:   { amp0:'],
    ['rhythm: { amp:', 'rhythm: { amp0:'], ['hunter: { amp:', 'hunter: { amp0:']],
  'one-archetype': [["const ARCH = ['apex', 'bank', 'rhythm', 'hunter'];", "const ARCH = ['apex', 'apex', 'apex', 'apex'];"]],
  'no-seed-deal': [['const rnd = mulberry32(mix(seed, 0x5eed));', 'const rnd = mulberry32(mix(1, 0x5eed));']],
  'no-lane': [['const LANE_PITCH_M = ', 'const LANE_PITCH_M_UNUSED = ']],
};
// ad-hoc sweeps: --set NAME=VALUE (repeatable), applied to `const NAME = ...;`
const argv = process.argv.slice(2);
const sets = [], names = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--set') sets.push(argv[++i]);
  else names.push(argv[i]);
}
const want = names.length ? names : Object.keys(VARIANTS);

function build(name) {
  let s = base;
  if (name === 'no-dodge') s = s.replace(/const DODGE_STEER = [0-9.]+;/, 'const DODGE_STEER = 0;');
  else if (name === 'no-lane') s = s.replace(/const LANE_PITCH_M = [0-9.]+;/, 'const LANE_PITCH_M = 0;');
  else if (name === 'no-arch-amp') s = s.replace(/\bamp: [0-9.]+/g, 'amp: 0').replace(/const HUNT_GAIN = [0-9.]+;/, 'const HUNT_GAIN = 0;');
  else if (name === 'no-hunter-gain') s = s.replace(/const HUNT_GAIN = [0-9.]+;/, 'const HUNT_GAIN = 0;');
  else if (name === 'one-archetype') s = s.replace("const ARCH = ['apex', 'bank', 'rhythm', 'hunter'];", "const ARCH = ['apex', 'apex', 'apex', 'apex'];");
  else if (name === 'no-seed-deal') s = s.replace('mulberry32(mix(seed, 0x5eed))', 'mulberry32(mix(1, 0x5eed))');
  else if (name === 'no-seed-form') s = s.replace('mulberry32(mix(seed, i * 977 + 13))', 'mulberry32(mix(1, i * 977 + 13))');
  else if (name === 'no-seed-at-all') s = s.replace('mulberry32(mix(seed, 0x5eed))', 'mulberry32(mix(1, 0x5eed))').replace('mulberry32(mix(seed, i * 977 + 13))', 'mulberry32(mix(1, i * 977 + 13))');
  else if (name === 'no-gate-fade') s = s.replace(/const GATE_FADE_M = [0-9.]+;/, 'const GATE_FADE_M = 0.001;');
  else if (name === 'no-assist') s = s.replace(/const ASSIST_SCRUB_CUT = [0-9.]+;/, 'const ASSIST_SCRUB_CUT = 0;').replace(/const ASSIST_BOOST_CUT = [0-9.]+;/, 'const ASSIST_BOOST_CUT = 0;').replace(/const ASSIST_TUCK_GAIN = [0-9.]+;/, 'const ASSIST_TUCK_GAIN = 0;');
  else if (name === 'no-tuck-spread') s = s.replace(/tuckSpread: [0-9.]+/g, 'tuckSpread: 0');
  else if (name === 'no-throttle-form') s = s.replace('0.72 + 0.56 * rnd()', '1.0').replace('0.45 + 1.10 * rnd()', '1.0').replace('-0.06 + 0.20 * rnd()', '0.04');
  else if (name === 'no-swing') s = s.replace('const swing = 0.82 + 0.36 * rnd();', 'const swing = 1;');
  else if (name === 'no-pass-guard') s = s.replace(/const LINE_KEEP_M = [0-9.]+;/, 'const LINE_KEEP_M = 0;').replace(/const PASS_CLEAR_M = [0-9.]+;/, 'const PASS_CLEAR_M = 0;').replace(/const DODGE_STEER = [0-9.]+;/, 'const DODGE_STEER = 0;');
  else if (name === 'no-line-keep') s = s.replace(/const LINE_KEEP_M = [0-9.]+;/, 'const LINE_KEEP_M = 0;');
  else if (/^keepamp\d+(\+swap)?$/.test(name)) { const a = name.slice(7).replace('+swap',''); if (name.endsWith('+swap')) s = s.replace('        tuckBias: T.tuckSpread * rnd(),\n        reserveBias: -0.06 + 0.20 * rnd(),', '        reserveBias: -0.06 + 0.20 * rnd(),\n        tuckBias: T.tuckSpread * rnd(),'); s = s.replace('        if (g < LINE_KEEP_M) want += sd * (LINE_KEEP_M - g) * (1 - afdz / LINE_KEEP_Z);', '        if (g < LINE_KEEP_M) want += sd * (LINE_KEEP_M - g);').replace('apex:   { amp: 26', 'apex:   { amp: ' + a).replace('bank:   { amp: 26', 'bank:   { amp: ' + a); }
  else if (/^amp\d+$/.test(name)) { const a = name.slice(3); s = s.replace(/apex:   \{ amp: [0-9.]+/, 'apex:   { amp: ' + a).replace(/bank:   \{ amp: [0-9.]+/, 'bank:   { amp: ' + a); }
  else if (/^wave\d+$/.test(name)) s = s.replace(/wave: [0-9.]+/, 'wave: ' + name.slice(4));
  else if (name === 'wave520x') s = s.replace('wave: 260', 'wave: 520');
  else if (name === 'assist-in-line') s = s.replace('want *= (1 - recover);', 'want *= (1 - recover) * (1 - 0.8 * assist);');
  else if (name.startsWith('hard-pass')) {
    s = s.replace("          tx += R.passSide * (PASS_CLEAR_M - gap) * (1 - apdz / PASS_Z) * PASS_AIM_K;",
                  "          tx = x + R.passSide * 60;");
    if (name.endsWith('+swap')) s = s.replace('        tuckBias: T.tuckSpread * rnd(),\n        reserveBias: -0.06 + 0.20 * rnd(),', '        reserveBias: -0.06 + 0.20 * rnd(),\n        tuckBias: T.tuckSpread * rnd(),');
  }
  else if (name.startsWith('keep-nofade')) {
    s = s.replace("        if (g < LINE_KEEP_M) want += sd * (LINE_KEEP_M - g) * (1 - afdz / LINE_KEEP_Z);",
                  "        if (g < LINE_KEEP_M) want += sd * (LINE_KEEP_M - g);");
    if (name.endsWith('+swap')) s = s.replace('        tuckBias: T.tuckSpread * rnd(),\n        reserveBias: -0.06 + 0.20 * rnd(),', '        reserveBias: -0.06 + 0.20 * rnd(),\n        tuckBias: T.tuckSpread * rnd(),');
  }
  else if (name === 'swap') s = s.replace('        tuckBias: T.tuckSpread * rnd(),\n        reserveBias: -0.06 + 0.20 * rnd(),', '        reserveBias: -0.06 + 0.20 * rnd(),\n        tuckBias: T.tuckSpread * rnd(),');
  else if (name !== 'none') throw new Error('unknown variant ' + name);
  for (const kv of sets) {
    const [k, v] = kv.split('=');
    const re = new RegExp('const ' + k + ' = [-0-9.eE/ ]+;');
    if (!re.test(s)) throw new Error('no const ' + k);
    s = s.replace(re, `const ${k} = ${v};`);
  }
  const p = resolve(OUT, name.replace(/[^a-z0-9-]/gi, '_') + (sets.length ? '_' + sets.join('_').replace(/[^a-z0-9]/gi, '') : '') + '.mjs');
  writeFileSync(p, s);
  return p;
}

for (const name of want) {
  const p = build(name);
  const txt = execFileSync(process.execPath, [resolve(HERE, '_lab.mjs')],
    { env: { ...process.env, MOD: p }, encoding: 'utf8' });
  const pick = l => (txt.split('\n').find(x => x.startsWith(l)) ?? '').trim();
  console.log(name.padEnd(16), '|', pick('means:'), '|', pick('minSep'), '|', pick('AI-14'), '|', pick('player positions'));
}
