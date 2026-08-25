#!/usr/bin/env node
// ===========================================================================
// Regenerates the golden-master fixtures from the CURRENT tree.
// Run ONLY on a tree verified good (all gates green, capture ok):
//   node sandbox/test-suite/B/tests/gen-fixtures.mjs
// ===========================================================================
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURES_DIR, GEOM_COMBOS, chunkChecksum, importRoot, runGateRunner,
  runGoldenSim,
} from './lib.mjs';

mkdirSync(FIXTURES_DIR, { recursive: true });
const save = (name, obj) =>
  writeFileSync(join(FIXTURES_DIR, name), JSON.stringify(obj, null, 1) + '\n');

// physics + camera gate statuses
for (const [runner, mod, name] of [
  ['harness/physics-runner.mjs', 'src/physics/physics.mjs', 'physics-gates.json'],
  ['harness/camera-runner.mjs', 'src/camera/camera.mjs', 'camera-gates.json'],
]) {
  const { report } = runGateRunner(runner, mod, 'gen-' + name);
  if (!report) throw new Error('no report from ' + runner);
  const gates = {};
  for (const r of report.results) gates[r.id] = r.status;
  save(name, { generated: new Date().toISOString(), module: mod, gates });
  console.log(name, JSON.stringify(report.counts ?? {}));
}

// geometry checksums (both render copies must agree — assert here too)
{
  const a = await importRoot('src/render/main.mjs');
  const b = await importRoot('src/game/render.mjs');
  const sums = GEOM_COMBOS.map(c => {
    const sa = chunkChecksum(a.buildChunkGeometry, c);
    const sb = chunkChecksum(b.buildChunkGeometry, c);
    if (sa !== sb) throw new Error('render copies disagree on chunk ' + JSON.stringify(c));
    return sa;
  });
  save('geometry.json', { generated: new Date().toISOString(), combos: GEOM_COMBOS, sums });
  console.log('geometry.json', sums.join(','));
}

// golden scripted physics run (state-hash checkpoints)
{
  const { createPhysics } = await importRoot('src/physics/physics.mjs');
  const { sampleHeight } = await importRoot('src/render/main.mjs');
  const trace = runGoldenSim(createPhysics, sampleHeight);
  save('sim-trace.json', { generated: new Date().toISOString(), ...trace });
  console.log('sim-trace.json final=' + trace.final,
    'finalState=' + JSON.stringify(trace.finalState));
}
