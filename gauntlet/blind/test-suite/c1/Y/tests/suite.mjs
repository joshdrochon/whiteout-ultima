#!/usr/bin/env node
// ===========================================================================
// Regression suite — candidate B (golden-master-first).
//
//   node sandbox/test-suite/B/tests/suite.mjs           # TIER 1 (< 120 s, no GPU)
//   node sandbox/test-suite/B/tests/suite.mjs --full    # + TIER 2 (headless-GPU smoke)
//
// Exit 0 = every test passed, exit 1 = at least one failed (node:test).
// Every failure message states WHAT invariant broke and WHERE.
//
// Fixtures under ./fixtures/ freeze verified behavior; regenerate them ONLY
// from a tree verified good, via ./gen-fixtures.mjs.
// ===========================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, SCRATCH, rootPath, importRoot, runNode, runGateRunner,
  GEOM_COMBOS, checkChunkCoherence, chunkChecksum, isDipped,
  runGoldenSim, loadFixture, gateRegressions, probeAttach,
} from './lib.mjs';

const FULL = process.argv.includes('--full');
const GATES_JSON = JSON.parse(readFileSync(rootPath('references/PHYSICS_GATES.json'), 'utf8'));

// ===========================================================================
// TIER 1
// ===========================================================================

test('contract: src/game/physics.mjs is byte-identical to src/physics/physics.mjs', () => {
  const a = readFileSync(rootPath('src/physics/physics.mjs'));
  const b = readFileSync(rootPath('src/game/physics.mjs'));
  if (!a.equals(b)) {
    let off = 0;
    const n = Math.min(a.length, b.length);
    while (off < n && a[off] === b[off]) off++;
    const line = a.slice(0, off).toString('utf8').split('\n').length;
    assert.fail(
      'CONTRACT broken: src/game/physics.mjs must be a byte-identical READ-ONLY copy of ' +
      'src/physics/physics.mjs (CONTRACTS.md / src/game/main.mjs header). First divergence at ' +
      `byte ${off} (~line ${line}); sizes ${a.length} vs ${b.length}. ` +
      'One copy was edited without the other — the game rig no longer runs the gated physics.');
  }
});

test('contract: physics module shape (createPhysics/init/step/state fields)', async () => {
  const mod = await importRoot('src/physics/physics.mjs');
  assert.equal(typeof mod.createPhysics, 'function',
    'CONTRACT broken: src/physics/physics.mjs must export createPhysics(env, opts) (CONTRACTS.md, physics lane)');
  const env = { sampleHeight: () => 0, surface: 'snow', seed: 7 };
  const p = mod.createPhysics(env, {});
  assert.equal(typeof p.init, 'function', 'CONTRACT: createPhysics(...).init missing (src/physics/physics.mjs)');
  assert.equal(typeof p.step, 'function', 'CONTRACT: createPhysics(...).step missing (src/physics/physics.mjs)');
  assert.equal(typeof p.config, 'object', 'CONTRACT: createPhysics(...).config missing (src/physics/physics.mjs)');
  const st = p.init([0, 0, 0], [10, 0, 0], 0);
  for (const f of ['pos', 'vel', 'heading', 'onGround', 'charge', 'airTime',
    'boostMeter', 'spinDeg', 'flipDeg', 'landing']) {
    assert.ok(f in st,
      `CONTRACT broken: physics state field '${f}' missing from init() result (CONTRACTS.md state list; src/physics/physics.mjs)`);
  }
  assert.equal(st.onGround, true,
    'CONTRACT broken: init() at surface height must set onGround=true (src/physics/physics.mjs init)');
  const air = p.init([0, 5, 0], [10, 0, 0], 0);
  assert.equal(air.onGround, false,
    'CONTRACT broken: init() 5 m above sampleHeight must start AIRBORNE (CONTRACTS.md: "above surface = start airborne"; src/physics/physics.mjs init)');
  assert.equal(p.step(st, {}, 1 / 60), st,
    'CONTRACT broken: step() must MUTATE and return the same state object (src/physics/physics.mjs step)');
});

test('contract: camera module shape (createChaseCam/update/debug/addTrauma/setBoostTier)', async () => {
  const mod = await importRoot('src/camera/camera.mjs');
  assert.equal(typeof mod.createChaseCam, 'function',
    'CONTRACT broken: src/camera/camera.mjs must export createChaseCam(camera, opts) (CONTRACTS.md, camera-follow lane)');
  const THREE = await importRoot('node_modules/three/build/three.module.js');
  const rig = mod.createChaseCam(new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 2000), { seed: 5 });
  for (const f of ['update', 'addTrauma', 'setBoostTier']) {
    assert.equal(typeof rig[f], 'function',
      `CONTRACT broken: chase-cam rig.${f} missing (CONTRACTS.md; src/camera/camera.mjs)`);
  }
  assert.equal(typeof rig.config, 'object', 'CONTRACT: rig.config missing (src/camera/camera.mjs)');
  assert.ok(Array.isArray(rig.debug?.lookAtTarget) && rig.debug.lookAtTarget.length === 3,
    'CONTRACT broken: rig.debug.lookAtTarget must be a world-space [x,y,z] (CONTRACTS.md; src/camera/camera.mjs)');
  rig.update({ pos: [0, 0, 0], vel: [15, 0, 0], heading: 0, onGround: true, spinDeg: 0, airTime: 0 }, 1 / 60);
});

test('contract: render + game modules export boot/sampleHeight/buildChunkGeometry', async () => {
  for (const rel of ['src/render/main.mjs', 'src/game/render.mjs']) {
    const m = await importRoot(rel);
    assert.equal(typeof m.boot, 'function',
      `CONTRACT broken: ${rel} must export boot(canvas) (CONTRACTS.md, render-loop lane)`);
    assert.equal(typeof m.sampleHeight, 'function',
      `CONTRACT broken: ${rel} must export the pure sampleHeight(x,z) sampler (test-suite pure exports)`);
    assert.equal(typeof m.buildChunkGeometry, 'function',
      `CONTRACT broken: ${rel} must export buildChunkGeometry (test-suite pure exports)`);
    const y = m.sampleHeight(0, 15);
    assert.ok(Number.isFinite(y), `CONTRACT broken: ${rel} sampleHeight(0,15) not finite (got ${y})`);
  }
  const game = await importRoot('src/game/main.mjs');
  assert.equal(typeof game.boot, 'function',
    'CONTRACT broken: src/game/main.mjs must export boot(canvas) behind the render-lane contract (its own header)');
  const a = await importRoot('src/render/main.mjs');
  const b = await importRoot('src/game/render.mjs');
  for (const [x, z] of [[0, 15], [139, 170], [-500, 1200], [200.5, 500]]) {
    assert.equal(a.sampleHeight(x, z), b.sampleHeight(x, z),
      `TERRAIN DRIFT: src/render/main.mjs and src/game/render.mjs disagree on sampleHeight(${x},${z}) — the game rig rides different ground than the accepted render lane`);
  }
});

test('contract: snow debug hooks live and trailHeightAt decodes depth (both attach copies)', async () => {
  for (const rel of ['src/shaders/attach.mjs', 'src/game/attach.mjs']) {
    const snow = await probeAttach(rel);
    for (const f of ['trailHeightAt', 'stamp', 'particleCount', 'setSunDir']) {
      assert.equal(typeof snow.debug?.[f], 'function',
        `CONTRACT broken: ${rel} attachSnow(...).debug.${f} missing (CONTRACTS.md, shaders lane — the shader runner probes through these)`);
    }
    // The mock renderer returns a FULL-DEPTH trail texel for every read: an
    // intact trailHeightAt must decode that to a positive depth (~MAX_DEPTH m).
    const h = snow.debug.trailHeightAt(0, 0);
    assert.ok(Number.isFinite(h) && h > 0.05,
      `CONTRACT broken: ${rel} debug.trailHeightAt(0,0) returned ${h} for a full-depth trail sample — ` +
      'it must decode the trail RTT to metres of deformation (SV-04..08 all measure through this hook). ' +
      'A constant/zero return silently blinds every trail gate.');
    assert.equal(typeof snow.debug.particleCount(), 'number',
      `CONTRACT broken: ${rel} debug.particleCount() must return a number`);
  }
});

test('geometry ground-coherence: every non-dipped vertex equals sampleHeight exactly', async () => {
  for (const rel of ['src/render/main.mjs', 'src/game/render.mjs']) {
    const m = await importRoot(rel);
    for (const combo of GEOM_COMBOS) {
      const bad = checkChunkCoherence(m.buildChunkGeometry, m.sampleHeight, combo);
      if (bad) {
        assert.fail(
          `GROUND-COHERENCE broken in ${rel} buildChunkGeometry: chunk(x0=${combo.x0}, z0=${combo.z0}, ` +
          `size=${combo.size}, seg=${combo.seg}, dipMask=${combo.mask}) vertex (i=${bad.i}, j=${bad.j}) ` +
          `at world (${bad.x}, ${bad.z}): mesh y=${bad.meshY}, sampleHeight=${bad.trueY} ` +
          `(delta=${(bad.meshY - bad.trueY).toPrecision(4)}). ${bad.why}. ` +
          'Physics rides sampleHeight; any bias here floats or buries the rider off the visible snow ' +
          '(the exact class of bug that shipped as the terrain-bias rider-float regression).');
      }
      // and the dip rule itself: a mask must dip ONLY its own edge rows
      const n = combo.seg + 1;
      let dippedCount = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (isDipped(i, j, combo.seg, combo.mask)) dippedCount++;
      assert.ok(combo.mask === 0 ? dippedCount === 0 : dippedCount > 0, 'internal: dip mask accounting');
    }
  }
});

test('geometry golden checksums: chunk position+index buffers match frozen fixture', async () => {
  const fx = loadFixture('geometry.json');
  for (const rel of ['src/render/main.mjs', 'src/game/render.mjs']) {
    const m = await importRoot(rel);
    fx.combos.forEach((combo, k) => {
      const sum = chunkChecksum(m.buildChunkGeometry, combo);
      assert.equal(sum, fx.sums[k],
        `GEOMETRY REGRESSION in ${rel}: buildChunkGeometry chunk(x0=${combo.x0}, z0=${combo.z0}, ` +
        `size=${combo.size}, seg=${combo.seg}, dipMask=${combo.mask}) checksum ${sum} != frozen ${fx.sums[k]}. ` +
        'The terrain mesh (positions or triangulation) changed from the verified golden master. ' +
        'If the change is INTENDED and verified, regenerate fixtures via gen-fixtures.mjs.');
    });
  }
});

test('physics gates: harness/physics-runner.mjs — no gate that passed may fail (PC/TN/JA)', () => {
  const { proc, report } = runGateRunner(
    'harness/physics-runner.mjs', 'src/physics/physics.mjs', 'physics-metrics.json');
  assert.ok(report, 'physics-runner produced no report JSON — runner crashed?\nstderr: ' +
    proc.stderr.slice(0, 800));
  const regs = gateRegressions(report, loadFixture('physics-gates.json'), GATES_JSON,
    'src/physics/physics.mjs, measured by harness/physics-runner.mjs');
  assert.equal(regs.length, 0,
    `PHYSICS GATE REGRESSION — ${regs.length} gate(s) that passed at fixture time now fail:\n  ` +
    regs.join('\n  '));
  assert.equal(report.hardFails, 0,
    'PHYSICS HARD-GATE FAILURE(S) reported by harness/physics-runner.mjs on src/physics/physics.mjs — see rows above');
});

test('camera gates: harness/camera-runner.mjs — no gate that passed may fail (CF)', () => {
  const { proc, report } = runGateRunner(
    'harness/camera-runner.mjs', 'src/camera/camera.mjs', 'camera-metrics.json');
  assert.ok(report, 'camera-runner produced no report JSON — runner crashed?\nstderr: ' +
    proc.stderr.slice(0, 800));
  const regs = gateRegressions(report, loadFixture('camera-gates.json'), GATES_JSON,
    'src/camera/camera.mjs, measured by harness/camera-runner.mjs');
  assert.equal(regs.length, 0,
    `CAMERA GATE REGRESSION — ${regs.length} gate(s) that passed at fixture time now fail:\n  ` +
    regs.join('\n  '));
  assert.equal(report.hardFails, 0,
    'CAMERA HARD-GATE FAILURE(S) reported by harness/camera-runner.mjs on src/camera/camera.mjs — see rows above');
});

test('golden scripted run: physics state-hash matches frozen trace bit-for-bit', async () => {
  const fx = loadFixture('sim-trace.json');
  const { createPhysics } = await importRoot('src/physics/physics.mjs');
  const { sampleHeight } = await importRoot('src/render/main.mjs');
  const now = runGoldenSim(createPhysics, sampleHeight);
  if (now.final !== fx.final) {
    let k = 0;
    while (k < fx.checkpoints.length && now.checkpoints[k] === fx.checkpoints[k]) k++;
    assert.fail(
      `GOLDEN-RUN REGRESSION: 15 s scripted run (src/physics/physics.mjs on src/render/main.mjs terrain) ` +
      `no longer reproduces the frozen state trace. First divergence inside t=(${k}..${k + 1}] s ` +
      `(checkpoint ${k + 1}: got ${now.checkpoints[k]}, frozen ${fx.checkpoints[k]}). ` +
      `Final state now pos=[${now.finalState.pos}] vel=[${now.finalState.vel}] vs frozen ` +
      `pos=[${fx.finalState.pos}] vel=[${fx.finalState.vel}]. ` +
      'Windows: 0-2 run-in, 2-6 carve+boost, 6-8 tuck, 8-8.6 crouch charge, ~8.6 pop, ' +
      '8.6-~12 AIR (spin + held steer must be a no-op), then tuck+boost. The window localizes ' +
      'which mechanic drifted. If the physics change is INTENDED and re-verified against the gates, ' +
      'regenerate fixtures via gen-fixtures.mjs.');
  }
});

// ===========================================================================
// TIER 2 (--full): headless-browser capture + shader gates
// ===========================================================================
if (FULL) {
  const smoke = (dirRel, outName) => {
    const r = runNode('harness/capture.mjs',
      ['--dir', dirRel, '--frames', '4', '--out', join(SCRATCH, outName)],
      { timeoutMs: 300000 });
    let m = null;
    try { m = JSON.parse(readFileSync(join(SCRATCH, outName, 'metrics.json'), 'utf8')); } catch {}
    assert.ok(m, `capture smoke of ${dirRel}: no metrics.json — harness/capture.mjs crashed?\n` +
      (r.stderr || r.stdout).slice(0, 800));
    assert.equal(m.ok, true,
      `RENDER SMOKE broken: harness/capture.mjs reports ok=false for ${dirRel} — boot/page errors: ` +
      JSON.stringify([...(m.errors ?? []), ...(m.consoleErrors ?? [])].slice(0, 5)));
    assert.ok(m.perf && m.perf.avgFps >= 55,
      `PERF REGRESSION in ${dirRel}: avgFps ${m.perf?.avgFps} < 55 over the capture perf loop (harness/capture.mjs __perf)`);
    assert.ok(m.perf.drawCalls < 150,
      `PERF REGRESSION in ${dirRel}: drawCalls ${m.perf?.drawCalls} >= 150 (draw-call budget; harness/capture.mjs __perf)`);
  };

  test('tier2: capture smoke of src/render (ok, fps >= 55, drawCalls < 150)', () => {
    smoke('src/render', 'cap-render');
  });

  test('tier2: capture smoke of src/game (ok, fps >= 55, drawCalls < 150)', () => {
    smoke('src/game', 'cap-game');
  });

  test('tier2: shader gates via harness/shader-runner.mjs (no HARD failures)', () => {
    const outAbs = join(SCRATCH, 'shader-metrics.json');
    const r = runNode('harness/shader-runner.mjs',
      ['--module', 'src/shaders', '--out', outAbs], { timeoutMs: 540000 });
    let report = null;
    try { report = JSON.parse(readFileSync(outAbs, 'utf8')); } catch {}
    assert.ok(report, 'shader-runner produced no report JSON — crashed?\n' +
      (r.stderr || r.stdout).slice(0, 800));
    const bad = (report.results ?? []).filter(x => x.tag === 'HARD'
      && x.status !== 'pass' && x.status !== 'deferred');
    assert.equal(bad.length, 0,
      'SHADER HARD-GATE FAILURE(S) on src/shaders (harness/shader-runner.mjs):\n  ' +
      bad.map(x => `${x.id} ${x.metric ?? ''} = ${x.value ?? x.error ?? '?'} (want ${x.expect ?? '?'})`).join('\n  '));
  });
}
