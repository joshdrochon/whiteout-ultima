// ============================================================================
// MUSIC — the soundtrack player.
//
// Deliberately NOT part of the rig's gated contract. Nothing in the physics,
// camera, rails or rivals lanes may depend on this, and it must be safe to
// delete: the game runs silently without it. index.html owns the wiring.
//
// THE ONE THING THAT ACTUALLY MATTERS HERE IS AUTOPLAY. Browsers refuse to
// start audio before a real user gesture, and a rejected play() is a silent
// promise rejection — the classic symptom is "the music works for me and not
// for anyone else", because the developer clicked something first. So nothing
// starts until arm() is called from a genuine gesture, and arm() reports
// whether playback ACTUALLY began — the caller unhooks its arming listeners
// only on a real success, so a blocked attempt is retried on the next gesture
// instead of killing the soundtrack for the session.
//
// Uses plain HTMLAudioElement rather than WebAudio. The whole feature is
// "play a track, then play the next one" — an AudioContext buys nothing here
// and adds its own suspended-until-gesture state to get wrong.
// ============================================================================

const TRACKS = [
  { src: '/assets/audio/whiteout-velocity.mp3', title: 'Whiteout Velocity' },
  { src: '/assets/audio/whiteout-velocity-2.mp3', title: 'Whiteout Velocity 2' },
  { src: '/assets/audio/crystal-night.mp3', title: 'Crystal Night' },
];

const DEFAULTS = {
  // 0.40, down from 0.45. The sound effects landed after this number was
  // chosen and the bed got busier; the music has to sit under them.
  volume: 0.40,
  fadeInMs: 900,    // a track landing at full volume mid-phrase is jarring
  fadeOutMs: 600,
  shuffle: true,
};

export function createMusic(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const tracks = (opts.tracks ?? TRACKS).slice();

  let order = tracks.map((_, i) => i);
  let cursor = 0;
  let el = null;
  let armed = false;
  let muted = false;
  let fadeTimer = null;
  let onTrack = opts.onTrack ?? (() => {});

  // Seeded shuffle so a session is reproducible if a seed is handed in, and
  // random otherwise. Fisher-Yates, not sort(() => Math.random() - 0.5), which
  // is biased and famously so.
  function shuffle(seed) {
    let s = (seed ?? ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0)) >>> 0;
    const rnd = () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  function fadeTo(target, ms) {
    if (!el) return;
    clearInterval(fadeTimer);
    const from = el.volume, t0 = performance.now();
    if (ms <= 0) { el.volume = target; return; }
    fadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      el.volume = from + (target - from) * k;
      if (k >= 1) clearInterval(fadeTimer);
    }, 30);
  }

  function play(i) {
    cursor = ((i % order.length) + order.length) % order.length;
    const t = tracks[order[cursor]];
    if (!el) {
      el = new Audio();
      el.preload = 'auto';
      // No loop: `ended` advances the playlist. Looping one track and calling
      // that a soundtrack is the thing this is meant to avoid.
      el.addEventListener('ended', () => play(cursor + 1));
      // A missing or unplayable file must not take the game down with it.
      el.addEventListener('error', () => {
        console.warn('[music] cannot play', t.src, '- skipping');
        if (order.length > 1) play(cursor + 1);
      });
    }
    el.src = t.src;
    el.volume = 0;
    fadeTo(muted ? 0 : cfg.volume, cfg.fadeInMs);
    // RETURN THE PROMISE. play() rejects when the gesture was not accepted, and
    // the caller has to know: swallowing it here is what made the first version
    // of this unrecoverable — one blocked attempt marked the player armed, the
    // arming listeners unhooked, and the soundtrack never started again for the
    // rest of the session. Silent and indistinguishable from "the music is
    // broken".
    const p = el.play();
    return Promise.resolve(p)
      .then(() => { onTrack(t.title, cursor + 1, order.length); return true; })
      .catch((e) => { console.warn('[music] blocked:', e?.message ?? e); return false; });
  }

  return {
    tracks,
    // Call from a REAL user gesture. Returns a promise for whether playback
    // ACTUALLY started — a synthesized or otherwise untrusted event resolves
    // false and leaves the player unarmed, so the next genuine gesture retries.
    // Safe to call repeatedly.
    async arm(seed) {
      if (armed) return false;
      if (cfg.shuffle) shuffle(seed);
      const ok = await play(0);
      armed = ok;
      return ok;
    },
    isArmed: () => armed,
    next() { if (armed) return play(cursor + 1); return null; },
    prev() { if (armed) return play(cursor - 1); return null; },
    toggleMute() {
      muted = !muted;
      fadeTo(muted ? 0 : cfg.volume, muted ? cfg.fadeOutMs : cfg.fadeInMs);
      return muted;
    },
    isMuted: () => muted,
    setVolume(v) {
      cfg.volume = Math.max(0, Math.min(1, v));
      if (!muted) fadeTo(cfg.volume, 120);
      return cfg.volume;
    },
    volume: () => cfg.volume,
    nowPlaying: () => (armed ? tracks[order[cursor]].title : null),
    config: cfg,
  };
}
