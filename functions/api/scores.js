// ============================================================================
// GLOBAL LEADERBOARD — Cloudflare Pages Function backed by KV.
//
// GET  /api/scores        -> { rows: [ { name, score, time, gates, place, at } ] }
// POST /api/scores        -> { ok, rank, rows }
//
// WHY KV AND NOT A DATABASE. The board is one small ordered list read far more
// often than it is written. KV is eventually consistent, which for a
// leaderboard means a fresh score can take a moment to appear on another
// continent — that is an acceptable trade for zero servers to run, and the
// alternative (D1) is a real database for a list of twenty rows.
//
// THERE IS NO AUTH, AND THAT IS THE HONEST SHAPE OF THIS. Anyone can POST. The
// validation below is not security, it is a speed bump: it rejects scores and
// times that the game itself cannot produce, so the board survives someone
// opening the console and trying a one-liner. A determined person can still
// forge a plausible run. Making that impossible needs the server to simulate
// the run, which is a different project.
// ============================================================================

const KEY = 'board:v1';
const MAX_ROWS = 20;

// Bounds derived from the game, not guessed:
//   the course is 2400 m and a good run finishes in ~110 s; the fastest rival
//   on record is 87.65 s, so anything under 60 s did not ride the course.
//   Score: a strong run is a few thousand. 25 gates at ~750 (max combo) is
//   ~19k, plus tricks. 500k is far beyond anything reachable and well clear of
//   a legitimate exceptional run.
const LIMITS = {
  minTime: 60,
  maxTime: 3600,
  maxScore: 500000,
  maxGates: 25,
  maxNameLen: 12,
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });

// A run is better if it scores more; a tie goes to the faster run.
function betterThan(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  return (a.time ?? Infinity) < (b.time ?? Infinity);
}

// Names are shown to everyone, so they are sanitised hard: letters, digits,
// spaces and a few marks, collapsed and clipped. Anything else becomes the
// default rather than being rejected — a player who typed an emoji should still
// get on the board.
function cleanName(raw) {
  const s = String(raw ?? '').replace(/[^\p{L}\p{N} _.\-']/gu, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, LIMITS.maxNameLen) || 'RIDER';
}

async function readBoard(env) {
  try {
    const raw = await env.SCORES.get(KEY);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export async function onRequestGet({ env }) {
  if (!env.SCORES) return json({ rows: [], error: 'no store bound' });
  return json({ rows: await readBoard(env) });
}

export async function onRequestOptions() {
  return json({ ok: true });
}

export async function onRequestPost({ request, env }) {
  if (!env.SCORES) return json({ ok: false, error: 'no store bound' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'bad json' }, 400); }

  const score = Number(body?.score);
  const time = Number(body?.time);
  const gates = Number(body?.gates ?? 0);
  const place = Number(body?.place ?? 0);

  // Reject what the game cannot produce. Stated as explicit checks so a
  // rejection says which rule it broke rather than failing mysteriously.
  if (!Number.isFinite(score) || score < 0 || score > LIMITS.maxScore)
    return json({ ok: false, error: 'score out of range' }, 400);
  if (!Number.isFinite(time) || time < LIMITS.minTime || time > LIMITS.maxTime)
    return json({ ok: false, error: 'time out of range' }, 400);
  if (!Number.isFinite(gates) || gates < 0 || gates > LIMITS.maxGates)
    return json({ ok: false, error: 'gates out of range' }, 400);

  const entry = {
    name: cleanName(body?.name),
    score: Math.round(score),
    time: +time.toFixed(2),
    gates: gates | 0,
    place: Number.isFinite(place) && place > 0 ? place | 0 : null,
    at: new Date().toISOString().slice(0, 10),
  };

  const rows = await readBoard(env);
  rows.push(entry);
  rows.sort((a, b) => (betterThan(a, b) ? -1 : 1));
  const kept = rows.slice(0, MAX_ROWS);
  await env.SCORES.put(KEY, JSON.stringify(kept));

  const rank = kept.indexOf(entry);
  return json({ ok: true, rank: rank < 0 ? null : rank + 1, rows: kept });
}
