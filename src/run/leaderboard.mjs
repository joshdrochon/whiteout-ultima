// ============================================================================
// LEADERBOARD — best runs, kept in the browser.
//
// LOCAL, and that is a real limitation rather than a shortcut worth hiding: the
// game is a static site with no backend, so there is nowhere to put a shared
// board. These scores live in this browser only. They do not travel between
// devices, they do not survive clearing site data, and nobody else can see
// them. A global board needs a server; this is honest about being neither.
//
// Pure module: it takes entries and returns entries. Storage is injected, so it
// is testable in node without a browser and cannot half-work behind a try/catch
// nobody reads.
// ============================================================================

const KEY = 'wu.leaderboard.v1';
const MAX = 10;

// A run is better if it scores more. Time breaks ties — same score, faster run
// wins, which is the only ordering that makes sense when the score is the
// headline and the clock is the discipline.
export function betterThan(a, b) {
  if (a.score !== b.score) return a.score > b.score;
  return (a.time ?? Infinity) < (b.time ?? Infinity);
}

export function createLeaderboard(opts = {}) {
  const max = opts.max ?? MAX;
  const key = opts.key ?? KEY;
  // Injected so tests do not need a browser, and so a browser that refuses
  // storage (private mode, blocked site data) degrades to an in-memory board
  // for the session rather than throwing on every read.
  const store = opts.storage ?? (() => {
    try {
      const probe = '__wu_probe__';
      globalThis.localStorage.setItem(probe, '1');
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    } catch {
      let mem = null;
      return { getItem: () => mem, setItem: (_k, v) => { mem = v; } };
    }
  })();

  function load() {
    try {
      const raw = store.getItem(key);
      if (!raw) return [];
      const rows = JSON.parse(raw);
      if (!Array.isArray(rows)) return [];
      // Never trust what came out of storage: it survives across versions and
      // can be edited by hand. Drop anything malformed instead of rendering
      // NaN into the HUD.
      return rows
        .filter(r => r && Number.isFinite(r.score) && r.score >= 0)
        .map(r => ({
          score: Math.round(r.score),
          time: Number.isFinite(r.time) ? +Number(r.time).toFixed(2) : null,
          place: Number.isFinite(r.place) ? r.place | 0 : null,
          gates: Number.isFinite(r.gates) ? r.gates | 0 : 0,
          at: typeof r.at === 'string' ? r.at : null,
        }))
        .sort((a, b) => (betterThan(a, b) ? -1 : 1))
        .slice(0, max);
    } catch {
      return [];
    }
  }

  function save(rows) {
    try { store.setItem(key, JSON.stringify(rows)); return true; }
    catch { return false; }
  }

  return {
    max,
    list: load,
    // Returns { rows, rank } — rank is the 1-based position of the submitted
    // run, or null if it did not make the board.
    submit(entry) {
      const e = {
        score: Math.max(0, Math.round(entry.score ?? 0)),
        time: Number.isFinite(entry.time) ? +Number(entry.time).toFixed(2) : null,
        place: Number.isFinite(entry.place) ? entry.place | 0 : null,
        gates: Number.isFinite(entry.gates) ? entry.gates | 0 : 0,
        at: entry.at ?? null,
      };
      const rows = load();
      rows.push(e);
      rows.sort((a, b) => (betterThan(a, b) ? -1 : 1));
      const kept = rows.slice(0, max);
      save(kept);
      const idx = kept.indexOf(e);
      return { rows: kept, rank: idx < 0 ? null : idx + 1 };
    },
    clear() { save([]); return []; },
  };
}
