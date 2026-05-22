export type SfxName =
  | 'pistol' | 'shotgun' | 'dryfire'
  | 'enemy_hit' | 'enemy_death_imp' | 'enemy_death_grunt'
  | 'door' | 'pickup' | 'player_hurt';

export class AudioMixer {
  ctx: AudioContext | null = null;
  sfxGain!: GainNode;
  musicGain!: GainNode;
  private playing = new Map<SfxName, number>();
  private musicNodes: AudioNode[] = [];
  private musicTimer: number | null = null;

  init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.sfxGain = this.ctx.createGain();
    this.sfxGain.gain.value = 0.6;
    this.sfxGain.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0.18;
    this.musicGain.connect(this.ctx.destination);
  }

  playSfx(name: SfxName, maxConcurrent = 4) {
    if (!this.ctx) return;
    const c = this.playing.get(name) ?? 0;
    if (c >= maxConcurrent) return;
    this.playing.set(name, c + 1);
    const dec = () => this.playing.set(name, Math.max(0, (this.playing.get(name) ?? 1) - 1));
    SFX[name](this.ctx, this.sfxGain, dec);
  }

  startMusic() {
    if (!this.ctx) return;
    this.stopMusic();
    const ctx = this.ctx;
    const out = this.musicGain;
    const baseFreqs = [55, 73.42, 65.41, 49]; // A1, D2, C2, G1
    const playNote = (freq: number, dur: number, when: number) => {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(0.18, when + 0.05);
      env.gain.linearRampToValueAtTime(0, when + dur);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 600;
      osc.connect(lp).connect(env).connect(out);
      osc.start(when);
      osc.stop(when + dur + 0.05);
      this.musicNodes.push(osc, env, lp);
    };
    const step = () => {
      if (!this.ctx) return;
      const now = ctx.currentTime;
      const beat = 0.6;
      for (let i = 0; i < baseFreqs.length; i++) {
        playNote(baseFreqs[i]!, beat * 0.9, now + i * beat);
      }
      this.musicTimer = self.setTimeout(step, beat * baseFreqs.length * 1000);
    };
    step();
  }

  stopMusic() {
    if (this.musicTimer !== null) { clearTimeout(this.musicTimer); this.musicTimer = null; }
    for (const n of this.musicNodes) { try { (n as OscillatorNode).stop?.(); } catch { /* ignore */ } }
    this.musicNodes = [];
  }
}

type SfxFn = (ctx: AudioContext, out: AudioNode, done: () => void) => void;

const SFX: Record<SfxName, SfxFn> = {
  pistol: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const noise = makeNoiseBuffer(ctx, 0.08);
    const src = ctx.createBufferSource(); src.buffer = noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1200; bp.Q.value = 6;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.9, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    src.connect(bp).connect(env).connect(out);
    src.start(t0); src.stop(t0 + 0.1);
    src.onended = done;
  },
  shotgun: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const noise = makeNoiseBuffer(ctx, 0.25);
    const src = ctx.createBufferSource(); src.buffer = noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800;
    const env = ctx.createGain();
    env.gain.setValueAtTime(1.0, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.25);
    src.connect(lp).connect(env).connect(out);
    src.start(t0); src.stop(t0 + 0.28);
    src.onended = done;
  },
  dryfire: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = 'square'; osc.frequency.value = 200;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.3, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.04);
    osc.connect(env).connect(out);
    osc.start(t0); osc.stop(t0 + 0.06);
    osc.onended = done;
  },
  enemy_hit: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const noise = makeNoiseBuffer(ctx, 0.08);
    const src = ctx.createBufferSource(); src.buffer = noise;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1000;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.5, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.08);
    src.connect(hp).connect(env).connect(out);
    src.start(t0); src.stop(t0 + 0.1);
    src.onended = done;
  },
  enemy_death_imp: (ctx, out, done) => growl(ctx, out, done, 220, 60, 0.5),
  enemy_death_grunt: (ctx, out, done) => growl(ctx, out, done, 160, 50, 0.55),
  door: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const noise = makeNoiseBuffer(ctx, 0.6);
    const src = ctx.createBufferSource(); src.buffer = noise;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(80, t0);
    lp.frequency.linearRampToValueAtTime(300, t0 + 0.5);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.4, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.6);
    src.connect(lp).connect(env).connect(out);
    src.start(t0); src.stop(t0 + 0.65);
    src.onended = done;
  },
  pickup: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = 'triangle';
    osc.frequency.setValueAtTime(660, t0);
    osc.frequency.exponentialRampToValueAtTime(1320, t0 + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.4, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.18);
    osc.connect(env).connect(out);
    osc.start(t0); osc.stop(t0 + 0.2);
    osc.onended = done;
  },
  player_hurt: (ctx, out, done) => {
    const t0 = ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t0);
    osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.2);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.4, t0);
    env.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
    osc.connect(env).connect(out);
    osc.start(t0); osc.stop(t0 + 0.24);
    osc.onended = done;
  },
};

function growl(ctx: AudioContext, out: AudioNode, done: () => void, fStart: number, fEnd: number, dur: number) {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator(); osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(fStart, t0);
  osc.frequency.exponentialRampToValueAtTime(fEnd, t0 + dur);
  const noise = makeNoiseBuffer(ctx, dur);
  const nsrc = ctx.createBufferSource(); nsrc.buffer = noise;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0.45, t0);
  env.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  const ngain = ctx.createGain(); ngain.gain.value = 0.3;
  osc.connect(env).connect(out);
  nsrc.connect(ngain).connect(env);
  osc.start(t0); osc.stop(t0 + dur + 0.05);
  nsrc.start(t0); nsrc.stop(t0 + dur + 0.05);
  osc.onended = done;
}

function makeNoiseBuffer(ctx: AudioContext, dur: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}
