// ============================================================================
// SOUND EFFECTS — synthesised, not sampled.
//
// WHY NO FILES. Every sound here is generated with Web Audio at runtime. That
// is not a compromise: it means no downloads, no licence to track, nothing
// added to the 20 MB the build already ships, and no attribution to get wrong
// on a public URL. Snow, wind and impacts are broadband noise shaped by an
// envelope, which is exactly what a synthesiser is good at — a recorded carve
// would be a worse fit for a game where the carve is continuous and varies with
// speed.
//
// Everything is built from three primitives:
//   noise()  a shared, looping white-noise buffer, filtered per voice
//   tone()   an oscillator with a pitch envelope
//   env()    an attack/decay gain envelope
//
// AUTOPLAY, same rule as the music: an AudioContext starts 'suspended' and only
// a real user gesture may resume it. arm() reports whether it actually did, so
// the caller can retry rather than assume.
// ============================================================================

const DEFAULTS = {
  master: 0.55,
  carveMax: 0.30,     // the carve bed is continuous; it must sit UNDER the music
};

export function createSfx(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  let ctx = null, master = null, noiseBuf = null;
  let carveSrc = null, carveGain = null, carveFilt = null;
  let grindSrc = null, grindGain = null;
  let armed = false;

  function build() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = cfg.master;
    master.connect(ctx.destination);
    // One second of white noise, looped. Regenerating noise per effect would
    // allocate a buffer on every landing.
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }

  const now = () => ctx.currentTime;

  // one-shot filtered noise burst
  function burst({ gain = 0.3, dur = 0.25, type = 'lowpass', freq = 900, q = 1,
                   sweepTo = null, attack = 0.005 } = {}) {
    if (!ctx) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    if (sweepTo != null) f.frequency.exponentialRampToValueAtTime(
      Math.max(40, sweepTo), now() + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now());
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), now() + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now() + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(); src.stop(now() + dur + 0.02);
  }

  // one-shot pitched tone
  function tone({ gain = 0.25, dur = 0.18, from = 660, to = null,
                  type = 'triangle', delay = 0 } = {}) {
    if (!ctx) return;
    const t0 = now() + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t0);
    if (to != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  return {
    // Call from a REAL gesture. Returns whether the context is actually running.
    async arm() {
      if (armed) return true;
      if (!ctx && !build()) return false;
      try { await ctx.resume(); } catch { /* blocked */ }
      if (ctx.state !== 'running') return false;
      armed = true;
      // the continuous carve bed, started silent and ridden by setCarve()
      carveSrc = ctx.createBufferSource();
      carveSrc.buffer = noiseBuf; carveSrc.loop = true;
      carveFilt = ctx.createBiquadFilter();
      carveFilt.type = 'bandpass'; carveFilt.frequency.value = 700; carveFilt.Q.value = 0.7;
      carveGain = ctx.createGain(); carveGain.gain.value = 0;
      carveSrc.connect(carveFilt); carveFilt.connect(carveGain); carveGain.connect(master);
      carveSrc.start();
      return true;
    },
    isArmed: () => armed,
    setMaster(v) { if (master) master.gain.value = Math.max(0, Math.min(1, v)); },

    // CONTINUOUS: the sound of the board on snow. Louder and brighter with
    // speed, louder again when the edge is loaded — that is what makes a carve
    // audibly different from running straight.
    setCarve(speed01, edge01, grounded) {
      if (!armed || !carveGain) return;
      const s = Math.max(0, Math.min(1, speed01));
      const e = Math.max(0, Math.min(1, edge01));
      const target = grounded ? cfg.carveMax * (0.18 + 0.5 * s + 0.45 * e) * (0.3 + 0.7 * s) : 0;
      carveGain.gain.setTargetAtTime(target, now(), 0.08);
      carveFilt.frequency.setTargetAtTime(420 + 1500 * s + 900 * e, now(), 0.08);
    },

    // CONTINUOUS: metal on metal while grinding.
    setGrind(on, speed01 = 0.5) {
      if (!armed) return;
      if (on && !grindSrc) {
        grindSrc = ctx.createBufferSource();
        grindSrc.buffer = noiseBuf; grindSrc.loop = true;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 6;
        grindGain = ctx.createGain(); grindGain.gain.value = 0;
        grindSrc.connect(f); f.connect(grindGain); grindGain.connect(master);
        grindSrc.start();
        grindSrc._f = f;
      }
      if (!grindSrc) return;
      grindGain.gain.setTargetAtTime(on ? 0.10 + 0.10 * speed01 : 0, now(), 0.05);
      grindSrc._f.frequency.setTargetAtTime(2200 + 1600 * speed01, now(), 0.05);
      if (!on) {
        const s = grindSrc; grindSrc = null;
        setTimeout(() => { try { s.stop(); } catch {} }, 250);
      }
    },

    // ---- one-shots ---------------------------------------------------------
    jump()   { burst({ gain: 0.22, dur: 0.30, type: 'lowpass', freq: 1800, sweepTo: 260 }); },
    land(hard) {
      burst({ gain: hard ? 0.45 : 0.26, dur: hard ? 0.34 : 0.20,
              type: 'lowpass', freq: hard ? 700 : 480, sweepTo: 120 });
      if (hard) tone({ gain: 0.12, dur: 0.16, from: 90, to: 45, type: 'sine' });
    },
    crash()  {
      burst({ gain: 0.5, dur: 0.6, type: 'lowpass', freq: 1200, sweepTo: 90 });
      tone({ gain: 0.14, dur: 0.4, from: 150, to: 40, type: 'sawtooth' });
    },
    // A gate scored. Pitch climbs with the combo so a run of gates sings up a
    // scale — the combo is audible without looking at the HUD.
    gate(combo = 1) {
      const step = Math.min(11, Math.max(0, combo - 1));
      const f = 660 * Math.pow(2, step / 12);
      tone({ gain: 0.20, dur: 0.13, from: f, to: f * 1.5, type: 'triangle' });
      tone({ gain: 0.10, dur: 0.16, from: f * 2, to: f * 3, type: 'sine', delay: 0.03 });
    },
    gateMiss() { tone({ gain: 0.10, dur: 0.16, from: 240, to: 150, type: 'sine' }); },
    trick()  {
      tone({ gain: 0.16, dur: 0.12, from: 520, to: 780, type: 'square' });
      tone({ gain: 0.12, dur: 0.18, from: 780, to: 1180, type: 'triangle', delay: 0.09 });
    },
    countdown(last) {
      if (last) {
        tone({ gain: 0.30, dur: 0.42, from: 880, to: 1320, type: 'triangle' });
      } else {
        tone({ gain: 0.22, dur: 0.16, from: 440, to: 440, type: 'triangle' });
      }
    },
    finish() {
      [0, 4, 7, 12].forEach((semi, i) =>
        tone({ gain: 0.20, dur: 0.5, from: 523.25 * Math.pow(2, semi / 12),
               type: 'triangle', delay: i * 0.11 }));
    },
  };
}
