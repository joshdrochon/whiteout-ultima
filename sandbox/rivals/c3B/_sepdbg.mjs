import { race } from './_lab.mjs';
const seed = Number(process.env.SEED ?? 2);
const R = race({ seed });
console.log('seed', seed, 'arch', R.racers.map(r => `${r.id}:${r.arch}/${r.tier}`).join(' '), 'minSep', R.minSep.toFixed(3), JSON.stringify(R.sepAt));
