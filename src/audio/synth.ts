// audio/synth.ts — subtractive-lite GM synth (M10-07, M10-plan §M10-07; ARCHITECTURE A-03;
// docs/research/10-audio.md R10 §4.2/§4.5).
//
// Voice model (plan: "voice = osc(s)→filter→ADSR gain→chGain→chPanner(L/R
// gains, CC10 = same quadratic as §0.3)→musicBus"):
//   * GM patch → family map (128 programs, family = program>>3 — GM's
//     16-family layout): saw / square / triangle single-osc voices plus
//     detuned 2-osc pairs (±7 cents, R10 §4.2 "detuned 2-osc for
//     strings/polysynth"). Bank CC0/CC32 IGNORED — R10 §4 decision (c),
//     plan §M10-07.
//   * Channel 9 (0-based; MIDI "channel 10") = percussion: 4 noise
//     archetypes keyed by GM note ranges (kick/snare/hat/crash, plan
//     §M10-07 "drums ch9 = 4 noise archetypes by GM note ranges").
//   * ADSR (plan table, pinned below; R10 §4.2 "attack ~5 ms" +
//     exponential-decay-to-sustain approximated by piecewise-linear — the
//     same breakpoints drive the offline kernel and the realtime ramps, so
//     the two paths agree envelope-for-envelope).
//   * Panning: CC10 → sep = cc10*2 (0..254, center 128) through the
//     mixer's quadratic L/R law (plan §0.5 addsfx: left = v − v·sep²/65536)
//     implemented as L/R GainNodes — NO StereoPanner (D027).
//   * 32-voice pool + per-channel LRU steal lives in the PLANNER
//     (smfPlayer.planMusic) so offline and realtime share the exact
//     allocation decisions (plan: "renderMusicPlanScript — the pure
//     planning half for L1").
//
// Determinism (L1 golden rule, D-10b): the offline kernel uses NO Math.sin
// and NO Math.pow — MIDI pitch comes from the pinned NOTE_FREQ literal
// table (generated once from 440·2^((n−69)/12); literal doubles so no
// engine-dependent pow can ever enter a golden), phase accumulation is
// plain add/sub, wave shapes are piecewise-linear, the one-pole filter uses
// pinned literal coefficients, and drum noise is a seeded xorshift
// (integer ops). Envelope breakpoints come from exact µs constants divided
// by the integer sample rate.
//
// REALTIME/OFFLINE SEAM (documented, plan §M10-07/D-10f): the same
// MusicPlan (smfPlayer) feeds either the pure-TS kernel here
// (`renderNotesOffline`) or the WebAudio graph (`Synth`) scheduled on
// ctx.currentTime. Divergence surface: (a) realtime applies pitch bend to
// voices started after the bend event (offline ignores pitchBend —
// follow-up); (b) realtime channel CC updates are node ramps, offline bakes
// channel gain/pan at note start (identical values, different granularity).
//
// Zone rule (A-06): imports NOTHING (structural node typings only, like
// context.ts). musicBus access is constructor-injected (`SynthTarget`), so
// the M10-09 composer decides the destination.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Rational } from './smf';

// ---------------------------------------------------------------------------
// Planned note (the shared contract: planner output = kernel input = realtime
// schedule unit). Defined here so the voice/kernel half owns the shape.
// ---------------------------------------------------------------------------

/** One allocated voice: absolute-µs timeline, baked stereo law values. */
export interface PlannedNote {
  /** Global issue order (total tie-break for the plan + render sum order). */
  readonly seq: number;
  /** Pool index 0..31 (plan: 32-voice pool). */
  readonly voice: number;
  readonly channel: number;
  readonly note: number;
  readonly velocity: number;
  /** Absolute start (µs, exact rational — straight off the decoder). */
  readonly t: Rational;
  /** Release point (note-off, CC-off, steal, or plan end / drum decay). */
  readonly releaseT: Rational;
  readonly kind: 'tone' | 'drum';
  readonly family: Family;
  readonly drum: DrumKind;
  readonly program: number;
  /** channelGain(CC7,CC11) × panLaw(CC10).left — baked at note start. */
  readonly gainLeft: number;
  readonly gainRight: number;
  /** True when this note STEALed the voice (plan: LRU steal order test). */
  readonly stolen: boolean;
}

// ---------------------------------------------------------------------------
// Constants (pinned)
// ---------------------------------------------------------------------------

/** Global voice-pool cap (plan §M10-07: "32-voice pool, per-channel LRU steal"). */
export const MAX_VOICES = 32;

/** Static note trim: keeps a 32-voice forté inside [-1, 1] after the sum. */
export const NOTE_TRIM = 0.085;

/** Pair-detune ratio: +7 cents = 2^(7/1200), literal (determinism rule). */
export const DETUNE_RATIO = 1.004051543955916;

/** MIDI note → Hz, pinned literals (generated from 440·2^((n−69)/12)). */
export const NOTE_FREQ: readonly number[] = [
  8.175798915643707, 8.661957218027252, 9.177023997418988, 9.722718241315027,
  10.300861153527183, 10.913382232281373, 11.562325709738577, 12.249857374429663,
  12.978271799373287, 13.75, 14.567617547440307, 15.433853164253883,
  16.351597831287414, 17.323914436054505, 18.354047994837977, 19.445436482630054,
  20.601722307054366, 21.826764464562746, 23.124651419477154, 24.499714748859326,
  25.956543598746574, 27.5, 29.13523509488062, 30.86770632850775,
  32.70319566257483, 34.64782887210902, 36.70809598967594, 38.89087296526011,
  41.20344461410874, 43.653528929125486, 46.24930283895431, 48.999429497718666,
  51.91308719749314, 55, 58.27047018976124, 61.7354126570155,
  65.40639132514966, 69.29565774421803, 73.41619197935188, 77.78174593052022,
  82.40688922821748, 87.30705785825097, 92.49860567790861, 97.99885899543733,
  103.82617439498628, 110, 116.54094037952248, 123.47082531403103,
  130.8127826502993, 138.59131548843604, 146.8323839587038, 155.56349186104043,
  164.81377845643496, 174.61411571650194, 184.99721135581723, 195.99771799087463,
  207.65234878997256, 220, 233.08188075904496, 246.94165062806206,
  261.6255653005986, 277.1826309768721, 293.6647679174076, 311.12698372208087,
  329.6275569128699, 349.2282314330039, 369.99442271163446, 391.99543598174927,
  415.3046975799451, 440, 466.1637615180899, 493.8833012561241,
  523.2511306011972, 554.3652619537442, 587.3295358348151, 622.2539674441618,
  659.2551138257398, 698.4564628660078, 739.9888454232689, 783.9908719634986,
  830.6093951598903, 880, 932.3275230361799, 987.7666025122483,
  1046.5022612023945, 1108.7305239074883, 1174.6590716696303, 1244.5079348883235,
  1318.5102276514797, 1396.9129257320155, 1479.9776908465378, 1567.981743926997,
  1661.2187903197805, 1760, 1864.6550460723597, 1975.533205024496,
  2093.004522404789, 2217.461047814977, 2349.31814333926, 2489.015869776647,
  2637.0204553029594, 2793.825851464031, 2959.9553816930757, 3135.9634878539946,
  3322.437580639561, 3520, 3729.3100921447194, 3951.066410048992,
  4186.009044809578, 4434.922095629954, 4698.63628667852, 4978.031739553294,
  5274.040910605919, 5587.651702928062, 5919.910763386151, 6271.926975707989,
  6644.875161279122, 7040, 7458.620184289437, 7902.132820097988,
  8372.018089619156, 8869.844191259906, 9397.272573357044, 9956.063479106588,
  10548.081821211836, 11175.303405856126, 11839.821526772303, 12543.853951415975,
];

// ---------------------------------------------------------------------------
// Families, ADSR table, GM patch map
// ---------------------------------------------------------------------------

/** Oscillator family ids (drums carry their archetype in `DrumKind`). */
export type Family = 'saw' | 'square' | 'tri' | 'detunedSaw' | 'detunedSquare' | 'detunedTri';

export type DrumKind = 'kick' | 'snare' | 'hat' | 'crash';

export interface Adsr {
  /** Attack length, µs (plan: attack ~5 ms, R10 §4.2). */
  readonly attackUs: number;
  /** Decay-to-sustain length, µs. */
  readonly decayUs: number;
  /** Sustain level 0..1. */
  readonly sustain: number;
  /** Release length, µs (also the planner's voice-freed delay). */
  readonly releaseUs: number;
  /** One-pole lowpass coefficient (state update `y += a*(x−y)`), literal. */
  readonly filterA: number;
}

/** ADSR plan table (M10-plan §M10-07 "ADSR gain"; µs literals). */
export const ADSR: Record<Family, Adsr> = {
  saw: { attackUs: 5_000, decayUs: 80_000, sustain: 0.7, releaseUs: 50_000, filterA: 0.25 },
  square: { attackUs: 5_000, decayUs: 100_000, sustain: 0.6, releaseUs: 80_000, filterA: 0.18 },
  tri: { attackUs: 10_000, decayUs: 150_000, sustain: 0.8, releaseUs: 120_000, filterA: 0.5 },
  detunedSaw: { attackUs: 5_000, decayUs: 100_000, sustain: 0.75, releaseUs: 100_000, filterA: 0.2 },
  detunedSquare: { attackUs: 10_000, decayUs: 120_000, sustain: 0.7, releaseUs: 150_000, filterA: 0.15 },
  detunedTri: { attackUs: 8_000, decayUs: 90_000, sustain: 0.65, releaseUs: 90_000, filterA: 0.4 },
};

/** Percussion decay lengths, µs (note-off ignored; voice frees after this). */
export const DRUM_DECAY_US: Record<DrumKind, number> = {
  kick: 250_000,
  snare: 150_000,
  hat: 60_000,
  crash: 500_000,
};

const BASE_FAMILY: Record<Family, 'saw' | 'square' | 'tri'> = {
  saw: 'saw',
  square: 'square',
  tri: 'tri',
  detunedSaw: 'saw',
  detunedSquare: 'square',
  detunedTri: 'tri',
};

export function baseFamily(f: Family): 'saw' | 'square' | 'tri' {
  return BASE_FAMILY[f];
}

export function oscCount(f: Family): number {
  return f.startsWith('detuned') ? 2 : 1;
}

/**
 * GM program → family (plan §M10-07 "GM program→family map (subset)"): the
 * GM 16-family octave layout, `family = program >> 3`. Programs cited by
 * usage in the fixture corpus + the FM/lead/pad corners: 0/4 (grand/EP
 * piano) → detunedTri, 16-23 (drawbar organ) → tri, 24/25/29 (acoustic/
 * electric/jazz guitar) → saw, 32/33/35 (acoustic/electric/fret bass) →
 * tri, 40-55 (strings/ensemble) → detunedSaw, 56/57 (trumpet/trombone) →
 * saw, 64/65 (soprano/alto sax) → square, 80/81 (DS/fifths saw lead) →
 * saw, 88/89 (new-age/warm pad) → detunedSquare, 96/97 (FX 2/3) → square,
 * 104/105 (agogo/maracas, ethnic row) → tri.
 */
const GM_FAMILIES: readonly Family[] = [
  'detunedTri', // 0-7    piano / EP / harpsichord / clav
  'square', //     8-15   chromatic percussion (celesta, glock, vibes...)
  'tri', //        16-23  organ
  'saw', //        24-31  guitar
  'tri', //        32-39  bass
  'detunedSaw', // 40-47  strings
  'detunedSaw', // 48-55  ensemble
  'saw', //        56-63  brass
  'square', //     64-71  reed
  'square', //     72-79  pipe
  'saw', //        80-87  synth lead
  'detunedSquare', //88-95 synth pad
  'square', //     96-103 synth effects
  'tri', //        104-111 ethnic
  'square', //     112-119 percussive
  'square', //     120-127 sound effects
];

/** 128-row patch map (bank select CC0/CC32 ignored — R10 §4 decision (c)). */
export function gmFamily(program: number): Family {
  return GM_FAMILIES[(program & 0x7f) >> 3]!;
}

/** GM percussion map (subset): 4 noise archetypes by note range, plan §M10-07. */
export function drumKind(note: number): DrumKind {
  if (note >= 32 && note <= 37) return 'kick'; // acoustic/bass drum 1/2
  if (note >= 38 && note <= 41) return 'snare'; // acoustic/snare/electric snare, brush
  if (note >= 42 && note <= 46) return 'hat'; // hi-hat family + open hi-hat
  if (note >= 47 && note <= 57) return 'crash'; // tom set + crash/cymbal
  return 'snare'; // unmapped percussion note: mid-burst default (counted by caller)
}

// ---------------------------------------------------------------------------
// Stereo law (plan §0.5 addsfx quadratic split, float mirror)
// ---------------------------------------------------------------------------

/** CC10 (0..127, center 64) → quadratic L/R gains. L(0)=(1,0), L(64)=(.75,.75), L(127)=(0,1). */
export function panLaw(cc10: number): { left: number; right: number } {
  const sep = cc10 * 2; // 0..254, center 128 (s_sound.c §0.3 sep scale)
  const l = 1 - (sep * sep) / 65536;
  const d = 256 - sep;
  const r = 1 - (d * d) / 65536;
  return { left: l, right: r };
}

/** Channel gain law: CC7 × CC11, both /127 (linear, D-10b mirror of vol_lookup). */
export function channelGain(cc7: number, cc11: number): number {
  return (cc7 / 127) * (cc11 / 127);
}

// ---------------------------------------------------------------------------
// Offline kernel (pure TS, THE golden subject)
// ---------------------------------------------------------------------------

export interface RenderResult {
  readonly sampleRate: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
}

/** floor(t.µs as n/d rational × sampleRate / 1e6), exact BigInt division. */
export function startSampleOf(t: { n: bigint; d: bigint }, sampleRate: number): number {
  const num = t.n * BigInt(sampleRate);
  const den = t.d * 1_000_000n;
  const q = num >= 0n ? num / den : (num - den + 1n) / den; // floor division
  return Number(q);
}

function wave(shape: 'saw' | 'square' | 'tri', p: number): number {
  if (shape === 'saw') return 2 * p - 1;
  if (shape === 'square') return p < 0.5 ? 1 : -1;
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}

/** Piecewise-linear ADSR envelope at note-relative sample k (offline golden path). */
export function envelopeAt(fam: Family, k: number, releaseK: number, sampleRate: number): number {
  const a = ADSR[fam]!;
  const aS = Math.round((a.attackUs * sampleRate) / 1_000_000);
  const dS = Math.round((a.decayUs * sampleRate) / 1_000_000);
  const rS = Math.round((a.releaseUs * sampleRate) / 1_000_000);
  if (k < aS) return aS === 0 ? 1 : k / aS;
  if (k < aS + dS) return 1 + (a.sustain - 1) * ((k - aS) / dS);
  if (k < releaseK) return a.sustain;
  if (k < releaseK + rS) return a.sustain * (1 - (k - releaseK) / rS);
  return 0;
}

/** Total envelope length in samples from note start (release at releaseK). */
export function envelopeLength(fam: Family, releaseK: number, sampleRate: number): number {
  const a = ADSR[fam]!;
  return releaseK + Math.round((a.releaseUs * sampleRate) / 1_000_000);
}

/** Seeded xorshift32 for drum noise (integer ops — deterministic across engines). */
function makeNoise(seed: number): () => number {
  let s = (seed | 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s |= 0;
    return ((s >>> 9) & 0xffff) / 32768 - 1;
  };
}

/** Render one planned note into the shared stereo buffers (additive). */
function renderNote(out: RenderResult, note: PlannedNote, frames: number): void {
  const rate = out.sampleRate;
  const start = startSampleOf(note.t, rate);
  if (start >= frames) return;
  const release = startSampleOf(note.releaseT, rate);
  const { left, right } = out;

  if (note.kind === 'drum') {
    const decayS = Math.max(1, Math.round((DRUM_DECAY_US[note.drum] * rate) / 1_000_000));
    const end = Math.min(frames, start + decayS);
    const noise = makeNoise((note.note * 2654435761) ^ Number((BigInt(start) ^ 0x5bf03635n) & 0xffffffffn));
    let lp = 0;
    let hpLp = 0;
    let phase = 0;
    const incHi = 150 / rate;
    const incLo = 50 / rate;
    for (let i = start; i < end; i++) {
      const k = i - start;
      const e = 1 - k / decayS; // linear body decay
      let s: number;
      switch (note.drum) {
        case 'kick': {
          const inc = incHi + (incLo - incHi) * (k / decayS); // literal linear drop, no pow
          phase += inc;
          if (phase >= 1) phase -= 1;
          s = wave('tri', phase) * e;
          break;
        }
        case 'snare': {
          const n = noise();
          lp += 0.35 * (n - lp);
          s = (n - lp) * e * 0.8 + wave('tri', ((k * (180 / rate)) % 1)) * e * e * 0.4;
          break;
        }
        case 'hat': {
          const n = noise();
          hpLp += 0.6 * (n - hpLp);
          const q = 1 - k / decayS;
          s = (n - hpLp) * q * q;
          break;
        }
        case 'crash': {
          const n = noise();
          lp += 0.05 * (n - lp);
          const q = 1 - k / decayS;
          s = lp * q * q;
          break;
        }
      }
      left[i] = (left[i] ?? 0) + s * note.gainLeft * 0.6;
      right[i] = (right[i] ?? 0) + s * note.gainRight * 0.6;
    }
    return;
  }

  const fam = note.family;
  const shape = baseFamily(fam);
  const a = ADSR[fam]!;
  const freq = NOTE_FREQ[note.note & 0x7f]!;
  const inc1 = freq / rate;
  const inc2 = inc1 * DETUNE_RATIO;
  const pair = oscCount(fam) === 2;
  const y1 = { v: 0 };
  const y2 = { v: 0 };
  let p1 = 0;
  let p2 = 0;
  const releaseK = release - start;
  const total = envelopeLength(fam, releaseK, rate);
  const end = Math.min(frames, start + total);
  for (let i = start; i < end; i++) {
    const k = i - start;
    p1 += inc1;
    if (p1 >= 1) p1 -= 1;
    let x = wave(shape, p1);
    y1.v += a.filterA * (x - y1.v);
    if (pair) {
      p2 += inc2;
      if (p2 >= 1) p2 -= 1;
      const x2 = wave(shape, p2);
      y2.v += a.filterA * (x2 - y2.v);
      x = (y1.v + y2.v) * 0.5; // pair mix (sum/2)
    } else {
      x = y1.v;
    }
    const s = x * envelopeAt(fam, k, releaseK, rate) * NOTE_TRIM * (note.velocity / 127);
    left[i] = (left[i] ?? 0) + s * note.gainLeft;
    right[i] = (right[i] ?? 0) + s * note.gainRight;
  }
}

/**
 * Offline render of planned notes (the pure-TS golden engine half shared
 * with the realtime path via the plan): notes must be pre-expanded for any
 * loops (`expandLoops` in smfPlayer). Output is clamped to [-1, 1].
 */
export function renderNotesOffline(notes: readonly PlannedNote[], sampleRate: number, seconds: number): RenderResult {
  const frames = Math.max(0, Math.round(seconds * sampleRate));
  const out: RenderResult = { sampleRate, left: new Float32Array(frames), right: new Float32Array(frames) };
  const sorted = [...notes].sort((a, b) => startSampleOf(a.t, sampleRate) - startSampleOf(b.t, sampleRate) || a.seq - b.seq);
  for (const n of sorted) renderNote(out, n, frames);
  for (let i = 0; i < frames; i++) {
    out.left[i] = Math.min(1, Math.max(-1, out.left[i]!));
    out.right[i] = Math.min(1, Math.max(-1, out.right[i]!));
  }
  return out;
}

/** Deterministic Int16-quantized FNV-1a hash over a render (golden subject). */
export function mixChecksum(r: RenderResult): string {
  const fnv = (buf: Float32Array): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < buf.length; i++) {
      const q = Math.min(32767, Math.max(-32768, Math.round(buf[i]! * 32767)));
      h ^= q & 0xffff;
      h = Math.imul(h, 0x01000193);
      h ^= (q >> 16) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  };
  return `${fnv(r.left).toString(16).padStart(8, '0')}:${fnv(r.right).toString(16).padStart(8, '0')}`;
}

// ---------------------------------------------------------------------------
// Realtime WebAudio graph (mock-friendly structural typings)
// ---------------------------------------------------------------------------

export interface ParamLike {
  value: number;
  setValueAtTime(v: number, t: number): void;
  linearRampToValueAtTime(v: number, t: number): void;
}

export interface GainLike {
  gain: ParamLike;
  connect(dest: unknown): void;
}

export interface OscLike {
  type: string;
  readonly frequency: ParamLike;
  readonly detune: ParamLike;
  connect(dest: unknown): void;
  start(t: number): void;
  stop(t: number): void;
}

export interface SourceLike {
  buffer: unknown;
  connect(dest: unknown): void;
  start(t: number): void;
  stop(t: number): void;
}

export interface FilterLike {
  type: string;
  readonly frequency: ParamLike;
  readonly Q: ParamLike;
  connect(dest: unknown): void;
}

export interface SynthContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): GainLike;
  createOscillator(): OscLike;
  createBufferSource(): SourceLike;
  createBuffer(channels: number, frames: number, sampleRate: number): unknown;
  createBiquadFilter(): FilterLike;
}

/** Host seam: M10-09's composer injects the musicBus node (plan §M10-07 →musicBus). */
export interface SynthTarget {
  readonly context: SynthContextLike;
  /** Destination node (the musicBus GainNode). Defaults to ctx.destination. */
  readonly musicIn?: unknown;
}

interface ChStrip {
  gain: GainLike;
  left: GainLike;
  right: GainLike;
}

interface LiveVoice {
  sources: (OscLike | SourceLike)[];
  env: GainLike;
  ch: number;
  endT: number;
}

const OSC_TYPE: Record<'saw' | 'square' | 'tri', string> = {
  saw: 'sawtooth',
  square: 'square',
  tri: 'triangle',
};

/** Seconds constant for µs→s (documented lossy escape, realtime-only path). */
const us2s = (us: number): number => us / 1_000_000;

/**
 * Realtime voice engine (plan §M10-07 voice half): osc(s)→filter→ADSR gain
 * →(vel gain)→chGain→L/R gains→musicIn. Channel state (patch, CC7/10/11,
 * bend range) is tracked here; the SmfPlayer replays plan channel-events
 * through `applyChannelEvent` at their exact times.
 */
export class Synth {
  private readonly ctx: SynthContextLike;
  private readonly out: unknown;
  private readonly strips = new Map<number, ChStrip>();
  private readonly state: {
    program: number;
    cc7: number;
    cc11: number;
    cc10: number;
    bendRange: number;
    bend: number;
  }[] = [];
  private readonly voices: LiveVoice[] = [];
  private noiseBuffer: unknown = null;
  voicesStarted = 0; // census for the debug seam / tests

  constructor(target: SynthTarget) {
    this.ctx = target.context;
    this.out = target.musicIn ?? target.context.destination;
    for (let i = 0; i < 16; i++) {
      this.state.push({ program: 0, cc7: 127, cc11: 127, cc10: 64, bendRange: 2, bend: 0 });
    }
  }

  context(): SynthContextLike {
    return this.ctx;
  }

  channelState(ch: number): { program: number; cc7: number; cc11: number; cc10: number; bendRange: number; bend: number } {
    return this.state[ch]!;
  }

  activeVoices(now = this.ctx.currentTime): number {
    this.prune(now);
    return this.voices.length;
  }

  private prune(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      if (this.voices[i]!.endT <= now) this.voices.splice(i, 1);
    }
  }

  private strip(ch: number): ChStrip {
    let s = this.strips.get(ch);
    if (s === undefined) {
      const gain = this.ctx.createGain();
      const left = this.ctx.createGain();
      const right = this.ctx.createGain();
      gain.connect(left);
      gain.connect(right);
      left.connect(this.out);
      right.connect(this.out);
      const st = this.state[ch]!;
      const g = ch === 9 ? 1 : channelGain(st.cc7, st.cc11);
      const p = panLaw(st.cc10);
      gain.gain.value = g;
      left.gain.value = p.left;
      right.gain.value = p.right;
      s = { gain, left, right };
      this.strips.set(ch, s);
    }
    return s;
  }

  private noise(): unknown {
    if (this.noiseBuffer === null) {
      const frames = this.ctx.sampleRate;
      const buf = this.ctx.createBuffer(1, frames, this.ctx.sampleRate);
      const data = (buf as { getChannelData(ch: number): Float32Array }).getChannelData(0);
      const gen = makeNoise(0x1234abcd);
      for (let i = 0; i < frames; i++) data[i] = gen();
      this.noiseBuffer = buf;
    }
    return this.noiseBuffer;
  }

  /** Start a planned voice at absolute context times `when`/`releaseWhen` (all ramps exact). */
  startNote(note: PlannedNote, when: number, releaseWhen: number): void {
    const ch = note.channel;
    const strip = this.strip(ch);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0, when);
    const velGain = this.ctx.createGain();
    velGain.gain.value = note.kind === 'tone' ? note.velocity / 127 : 1;
    velGain.connect(env);
    env.connect(strip.gain);
    const sources: (OscLike | SourceLike)[] = [];
    const rel = releaseWhen; // seconds (caller converted from the plan rational)
    let endT: number;
    if (note.kind === 'tone') {
      const fam = note.family;
      const a = ADSR[fam]!;
      const shape = baseFamily(fam);
      const freq = NOTE_FREQ[note.note & 0x7f]!;
      const n = oscCount(fam);
      for (let i = 0; i < n; i++) {
        const osc = this.ctx.createOscillator();
        osc.type = OSC_TYPE[shape];
        osc.frequency.setValueAtTime(i === 0 ? freq : freq * DETUNE_RATIO, when);
        const st = this.state[ch]!;
        osc.detune.setValueAtTime((st.bend / 8192) * st.bendRange * 100, when); // realtime-only (see header)
        const flt = this.ctx.createBiquadFilter();
        flt.type = 'lowpass';
        flt.frequency.setValueAtTime(a.filterA * this.ctx.sampleRate * 0.5, when);
        osc.connect(flt);
        flt.connect(velGain);
        sources.push(osc);
      }
      const aS = us2s(a.attackUs);
      const dS = us2s(a.decayUs);
      const rS = us2s(a.releaseUs);
      const relT = Math.max(rel, when + aS + dS); // automation must stay monotonic
      env.gain.linearRampToValueAtTime(1, when + aS);
      env.gain.linearRampToValueAtTime(a.sustain, when + aS + dS);
      env.gain.setValueAtTime(a.sustain, relT);
      env.gain.linearRampToValueAtTime(0.0001, relT + rS);
      for (const s of sources) {
        (s as OscLike).start(when);
        (s as OscLike).stop(relT + rS + 0.001);
      }
      endT = relT + rS + 0.001;
    } else {
      const decay = us2s(DRUM_DECAY_US[note.drum]);
      const src = this.ctx.createBufferSource();
      src.buffer = this.noise();
      const flt = this.ctx.createBiquadFilter();
      flt.type = note.drum === 'kick' ? 'lowpass' : 'highpass';
      flt.frequency.setValueAtTime(note.drum === 'kick' ? 150 : note.drum === 'crash' ? 4000 : 7000, when);
      src.connect(flt);
      flt.connect(velGain);
      sources.push(src);
      env.gain.linearRampToValueAtTime(1, when + 0.002);
      env.gain.linearRampToValueAtTime(0.0001, when + decay);
      src.start(when);
      src.stop(when + decay + 0.001);
      endT = when + decay + 0.001;
    }
    this.voices.push({ sources, env, ch, endT });
    this.voicesStarted += 1;
  }

  /** Replay a planned channel event at absolute time `when`. */
  applyChannelEvent(ev: { channel: number; kind: string; controller?: number; value?: number; program?: number }, when: number): void {
    const st = this.state[ev.channel]!;
    if (ev.kind === 'program') {
      st.program = ev.program!;
      return;
    }
    if (ev.kind === 'bend') {
      st.bend = ev.value!;
      return;
    }
    const cc = ev.controller!;
    const v = ev.value!;
    if (cc === 7 || cc === 11) {
      if (cc === 7) st.cc7 = v;
      else st.cc11 = v;
      const s = this.strips.get(ev.channel);
      if (s !== undefined) s.gain.gain.setValueAtTime(channelGain(st.cc7, st.cc11), when);
      return;
    }
    if (cc === 10) {
      st.cc10 = v;
      const s = this.strips.get(ev.channel);
      if (s !== undefined) {
        const p = panLaw(v);
        s.left.gain.setValueAtTime(p.left, when);
        s.right.gain.setValueAtTime(p.right, when);
      }
      return;
    }
    if (cc === 1) st.bendRange = v;
    if (cc === 5) st.bendRange = v;
    if (cc === 120 || cc === 121 || cc === 123) this.notesOff(ev.channel, when);
  }

  /** Per-channel all-notes-off (CC 120/121/123 + stop): 2 ms fade, kill. */
  notesOff(ch: number, now: number): void {
    for (const v of this.voices) {
      if (v.ch !== ch) continue;
      v.env.gain.setValueAtTime(0, now);
      for (const s of v.sources) s.stop(now + 0.002);
      v.endT = now + 0.002;
    }
    this.prune(now + 0.002);
  }

  stopAll(now: number): void {
    for (const v of this.voices) {
      v.env.gain.setValueAtTime(0, now);
      for (const s of v.sources) s.stop(now + 0.002);
    }
    this.voices.length = 0;
  }
}
