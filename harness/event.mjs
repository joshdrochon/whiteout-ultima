#!/usr/bin/env node
// Append one gauntlet event (observability source of truth).
// usage: node harness/event.mjs <lane> <node> <cycle> <event> '<dataJSON>'
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [lane, node, cycle, event, dataRaw] = process.argv.slice(2);
if (!lane || !node || !event) {
  console.error('usage: event.mjs <lane> <node> <cycle> <event> [dataJSON]');
  process.exit(1);
}
let data = {};
try { data = dataRaw ? JSON.parse(dataRaw) : {}; } catch { data = { raw: dataRaw }; }
mkdirSync(join(root, 'gauntlet'), { recursive: true });
const line = JSON.stringify({ t: new Date().toISOString(), lane, node, cycle: Number(cycle) || 0, event, data });
appendFileSync(join(root, 'gauntlet', 'events.jsonl'), line + '\n');
console.log('logged:', line.slice(0, 160));
