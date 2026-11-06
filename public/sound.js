// Game sounds, synthesized with Web Audio (no sound files needed).
// Sound.play(name) plays one; Sound.toggle() mutes/unmutes and remembers the choice.
const Sound = (() => {
  let ctx = null;
  let master = null;
  let muted = false;
  try { muted = localStorage.getItem('mj_muted') === '1'; } catch (e) { /* storage blocked */ }

  // Browsers only allow audio after a user gesture, so start on the first tap or key.
  function unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.6;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  function tone(freq, start, dur, { type = 'sine', vol = 0.3, to = null } = {}) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, start);
    if (to) o.frequency.exponentialRampToValueAtTime(to, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(master);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  function noise(start, dur, { freq = 2500, q = 1.2, vol = 0.5 } = {}) {
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(master);
    src.start(start);
  }

  // A tile knocking on the table: a sharp click plus a short woody thump.
  function clack(t, vol = 1) {
    noise(t, 0.05, { freq: 3200, q: 1.5, vol: 0.7 * vol });
    tone(210, t, 0.07, { type: 'triangle', vol: 0.35 * vol, to: 140 });
  }

  const sounds = {
    discard(t) { clack(t); clack(t + 0.045, 0.45); },
    draw(t) { noise(t, 0.06, { freq: 1800, q: 0.8, vol: 0.25 }); },
    turn(t) { tone(880, t, 0.18, { vol: 0.12 }); tone(1320, t + 0.09, 0.22, { vol: 0.1 }); },
    claimable(t) { tone(660, t, 0.12, { type: 'triangle', vol: 0.18 }); tone(990, t + 0.1, 0.18, { type: 'triangle', vol: 0.18 }); },
    chow(t) { clack(t); clack(t + 0.08, 0.8); clack(t + 0.16, 0.8); tone(520, t, 0.25, { type: 'square', vol: 0.06 }); },
    pung(t) { clack(t); clack(t + 0.06); clack(t + 0.12); tone(392, t, 0.3, { type: 'square', vol: 0.08 }); tone(523, t + 0.08, 0.3, { type: 'square', vol: 0.06 }); },
    kong(t) { for (let i = 0; i < 4; i++) clack(t + i * 0.06); tone(330, t, 0.45, { type: 'sawtooth', vol: 0.06, to: 660 }); },
    flower(t) { [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, t + i * 0.06, 0.5, { vol: 0.1 })); },
    win(t) {
      [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.11, 0.35, { type: 'triangle', vol: 0.22 }));
      [784, 1047, 1319].forEach((f) => tone(f, t + 0.5, 0.9, { type: 'triangle', vol: 0.14 }));
    },
    lose(t) { [392, 330, 262].forEach((f, i) => tone(f, t + i * 0.16, 0.35, { type: 'triangle', vol: 0.15 })); },
    shuffle(t) { for (let i = 0; i < 14; i++) clack(t + i * 0.035 + Math.random() * 0.02, 0.3 + Math.random() * 0.4); },
  };

  return {
    play(name) {
      if (muted || !ctx || ctx.state !== 'running' || !sounds[name]) return;
      sounds[name](ctx.currentTime + 0.01);
    },
    toggle() {
      muted = !muted;
      try { localStorage.setItem('mj_muted', muted ? '1' : '0'); } catch (e) { /* storage blocked */ }
      if (!muted) { unlock(); this.play('turn'); }
      return muted;
    },
    get muted() { return muted; },
  };
})();
