// audio/synth.test.ts — M10-07 synth unit goldens (M10-plan §M10-07
// acceptance 1/3): patch map, ADSR envelope golden samples, offline voice
// render checksums (double-run), pitch table, stereo/gain laws, mock-graph
// realtime op exactness. Pure node; NO AudioContext is ever constructed
// (mock structural types only — plan M10-01 acceptance-3 discipline).
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import {
  ADSR,
  channelGain,
  DETUNE_RATIO,
  drumKind,
  envelopeAt,
  gmFamily,
  MAX_VOICES,
  mixChecksum,
  NOTE_FREQ,
  NOTE_TRIM,
  oscCount,
  panLaw,
  renderNotesOffline,
  Synth,
  type PlannedNote,
  type SynthContextLike,
} from './synth';

// ---------------------------------------------------------------------------
// Mock graph (structural; the same shape is duplicated in smfPlayer.test.ts)
// ---------------------------------------------------------------------------

interface Op {
  op: string;
  target: number;
  when: number;
  value?: number;
}

class MockParam {
  value = 0;
  constructor(private readonly log: Op[], private readonly tag: string) {}
  setValueAtTime(v: number, t: number): void {
    this.value = v;
    this.log.push({ op: `${this.tag}.setValueAtTime`, target: -1, when: t, value: v });
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.value = v;
    this.log.push({ op: `${this.tag}.linearRamp`, target: -1, when: t, value: v });
  }
}

export function mockContext(): { ctx: SynthContextLike; log: Op[]; now: { t: number } } {
  const log: Op[] = [];
  const now = { t: 0 };
  let nextId = 0;
  const param = (tag: string): MockParam => new MockParam(log, tag);
  const ctx: SynthContextLike = {
    sampleRate: 44100,
    get currentTime(): number {
      return now.t;
    },
    destination: 'dest',
    createGain: () => ({ gain: param(`gain${nextId++}`), connect: () => undefined }),
    createOscillator: () => {
      const id = nextId++;
      return {
        type: 'sine',
        frequency: param(`freq${id}`),
        detune: param(`detune${id}`),
        connect: () => undefined,
        start: (t: number) => log.push({ op: 'osc.start', target: id, when: t }),
        stop: (t: number) => log.push({ op: 'osc.stop', target: id, when: t }),
      };
    },
    createBufferSource: () => {
      const id = nextId++;
      return {
        buffer: null,
        connect: () => undefined,
        start: (t: number) => log.push({ op: 'src.start', target: id, when: t }),
        stop: (t: number) => log.push({ op: 'src.stop', target: id, when: t }),
      };
    },
    createBuffer: (channels: number, frames: number, rate: number) => {
      void channels;
      void rate;
      const data = new Float32Array(frames);
      return { getChannelData: () => data };
    },
    createBiquadFilter: () => {
      const id = nextId++;
      return { type: 'lowpass', frequency: param(`flt${id}`), Q: param(`q${id}`), connect: () => undefined };
    },
  };
  return { ctx, log, now };
}

export function toneNote(over: Partial<PlannedNote> = {}): PlannedNote {
  return {
    seq: 0,
    voice: 0,
    channel: 1,
    note: 69,
    velocity: 127,
    t: { n: 0n, d: 1n },
    releaseT: { n: 500_000n, d: 1n },
    kind: 'tone',
    family: 'square',
    drum: 'hat',
    program: 80,
    gainLeft: panLaw(64).left,
    gainRight: panLaw(64).right,
    stolen: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

describe('GM patch map (plan §M10-07 subset; banks CC0/CC32 ignored)', () => {
  it('covers all 128 programs through the 16-family octave layout', () => {
    for (let p = 0; p < 128; p++) {
      expect(['saw', 'square', 'tri', 'detunedSaw', 'detunedSquare', 'detunedTri']).toContain(gmFamily(p));
      expect(gmFamily(p)).toBe(gmFamily((p >> 3) << 3)); // family == GM octave row
    }
    expect(MAX_VOICES).toBe(32);
  });

  it('pins the cited program numbers', () => {
    expect(gmFamily(0)).toBe('detunedTri'); // grand piano
    expect(gmFamily(4)).toBe('detunedTri'); // EP
    expect(gmFamily(16)).toBe('tri'); // drawbar organ
    expect(gmFamily(24)).toBe('saw'); // acoustic guitar
    expect(gmFamily(29)).toBe('saw'); // electric jazz guitar
    expect(gmFamily(33)).toBe('tri'); // electric bass fingers
    expect(gmFamily(48)).toBe('detunedSaw'); // string ensemble 1
    expect(gmFamily(56)).toBe('saw'); // trumpet
    expect(gmFamily(64)).toBe('square'); // soprano sax
    expect(gmFamily(80)).toBe('saw'); // DS saw lead
    expect(gmFamily(88)).toBe('detunedSquare'); // new-age pad
    expect(gmFamily(96)).toBe('square'); // FX 2
    expect(gmFamily(104)).toBe('tri'); // agogo (ethnic row)
  });

  it('detuned pairs are 2-osc, single families 1-osc; DETUNE_RATIO is the 7-cent literal', () => {
    expect(oscCount('saw')).toBe(1);
    expect(oscCount('detunedSaw')).toBe(2);
    expect(oscCount('detunedTri')).toBe(2);
    expect(DETUNE_RATIO).toBe(1.004051543955916);
  });
});

describe('GM percussion (ch 9): 4 noise archetypes by note range', () => {
  it('maps kick/snare/hat/crash and defaults unmapped notes to the mid burst', () => {
    expect(drumKind(35)).toBe('kick');
    expect(drumKind(36)).toBe('kick');
    expect(drumKind(38)).toBe('snare');
    expect(drumKind(40)).toBe('snare');
    expect(drumKind(42)).toBe('hat');
    expect(drumKind(46)).toBe('hat');
    expect(drumKind(49)).toBe('crash');
    expect(drumKind(57)).toBe('crash');
    expect(drumKind(70)).toBe('snare'); // unmapped -> mid-burst default (counted by the planner)
  });
});

describe('pitch table + laws', () => {
  it('pins A4=440 and the equal-tempered corners (literal table, no Math.pow at run time)', () => {
    expect(NOTE_FREQ[69]).toBe(440);
    expect(NOTE_FREQ[60]).toBe(261.6255653005986);
    expect(NOTE_FREQ[21]).toBe(27.5);
    expect(NOTE_FREQ[0]).toBe(8.175798915643707);
    expect(NOTE_FREQ[127]).toBe(12543.853951415975);
    for (let n = 1; n < 128; n++) expect(NOTE_FREQ[n]!).toBeGreaterThan(NOTE_FREQ[n - 1]!);
  });

  it('channelGain is the CC7×CC11 linear law; panLaw is the §0.5 quadratic split', () => {
    expect(channelGain(127, 127)).toBe(1);
    expect(channelGain(0, 127)).toBe(0);
    expect(channelGain(100, 127)).toBeCloseTo(100 / 127, 15);
    expect(panLaw(0)).toEqual({ left: 1, right: 0 });
    expect(panLaw(64)).toEqual({ left: 0.75, right: 0.75 }); // center = 0.75/0.75 (128-sep law)
    expect(panLaw(127).left).toBe(1020 / 65536);
    expect(panLaw(127).right).toBe(1 - 4 / 65536);
    expect(panLaw(96).right).toBe(1 - (256 - 192) ** 2 / 65536);
  });
});

describe('ADSR plan table (golden envelope samples @ 8000 Hz)', () => {
  it('tri family: attack 10 ms linear, decay 150 ms to 0.8, release 120 ms from the gate', () => {
    // 10000us*8000/1e6 = 80 attack samples; 150000us = 1200 decay; 120000us = 960 release.
    const gold: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [40, 0.5],
      [79, 0.9875],
      [80, 1],
      [1280, 0.8],
      [1281, 0.8],
      [8000, 0.8], // sustain holds until the release gate (releaseK = 8000)
      [8479, 0.4008333333333333],
      [8960, 0],
    ];
    for (const [k, v] of gold) expect(envelopeAt('tri', k, 8000, 8000)).toBe(v);
    expect(ADSR.tri.attackUs).toBe(10_000);
    expect(ADSR.tri.releaseUs).toBe(120_000);
    expect(NOTE_TRIM).toBe(0.085);
  });
});

describe('offline voice kernel (pure TS, L1 golden subject)', () => {
  it('single square note @ 8000 Hz: pinned checksum + first samples + double-run bit-equal', () => {
    const note = toneNote();
    const a = renderNotesOffline([note], 8000, 1);
    const b = renderNotesOffline([note], 8000, 1);
    expect(mixChecksum(a)).toBe('c2401d8e:c2401d8e'); // L=R (center pan), double-run equal
    expect(mixChecksum(a)).toBe(mixChecksum(b));
    for (let i = 0; i < a.left.length; i++) expect(Object.is(a.left[i], b.left[i])).toBe(true);
    expect(Array.from(a.left.slice(0, 4))).toEqual([
      0, 0.0005221124738454819, 0.0014300144976004958, 0.0026195428799837828,
    ]);
    // Envelope silence after release: gate 0.5 s + release 80 ms ≈ 4640 samples.
    expect(a.left[5000]!).toBe(0);
    expect(a.left[7999]!).toBe(0);
  });

  it('drums: kick is band-limited body + decays to exact zero by the archetype length', () => {
    const kick: PlannedNote = {
      ...toneNote(), kind: 'drum', drum: 'kick', channel: 9, note: 36, gainLeft: 0.75, gainRight: 0.75,
    };
    const r = renderNotesOffline([kick], 8000, 1);
    expect(mixChecksum(r)).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
    let peak = 0;
    for (let i = 0; i < r.left.length; i++) peak = Math.max(peak, Math.abs(r.left[i]!));
    expect(peak).toBeGreaterThan(0.1);
    expect(r.left[2100]!).toBe(0); // 250 ms decay @ 8 kHz = 2000 samples
    expect(r.left[7999]!).toBe(0);
  });

  it('never exceeds [-1, 1] even at absurd gains (clamp property)', () => {
    const notes: PlannedNote[] = [];
    for (let v = 0; v < 32; v++) {
      notes.push(toneNote({ seq: v, voice: v, gainLeft: 40, gainRight: 40, family: 'saw', t: { n: 0n, d: 1n } }));
    }
    const r = renderNotesOffline(notes, 8000, 0.25);
    for (let i = 0; i < r.left.length; i++) {
      expect(r.left[i]!).toBeLessThanOrEqual(1);
      expect(r.left[i]!).toBeGreaterThanOrEqual(-1);
    }
  });
});

describe('realtime Synth (mock graph): exact node ops (acceptance 3)', () => {
  it('tone note-on: osc(s).start(when) + full ADSR ramps scheduled at start', () => {
    const { ctx, log } = mockContext();
    const synth = new Synth({ context: ctx });
    synth.startNote(toneNote(), 0.5, 1.0);
    const starts = log.filter((o) => o.op === 'osc.start');
    expect(starts).toEqual([{ op: 'osc.start', target: 5, when: 0.5 }]);
    expect(log).toContainEqual({ op: 'gain3.setValueAtTime', target: -1, when: 0.5, value: 0 });
    expect(log).toContainEqual({ op: 'gain3.linearRamp', target: -1, when: 0.505, value: 1 });
    expect(log).toContainEqual({ op: 'gain3.linearRamp', target: -1, when: 0.605, value: ADSR.square.sustain });
    expect(log).toContainEqual({ op: 'gain3.setValueAtTime', target: -1, when: 1.0, value: ADSR.square.sustain });
    expect(log).toContainEqual({ op: 'gain3.linearRamp', target: -1, when: 1.08, value: 0.0001 });
    expect(log).toContainEqual({ op: 'osc.stop', target: 5, when: 1.081 });
    expect(log).toContainEqual({ op: 'freq5.setValueAtTime', target: -1, when: 0.5, value: NOTE_FREQ[69] });
  });

  it('detuned pair: two oscillators, second at f×7-cent literal ratio, both start at when', () => {
    const { ctx, log } = mockContext();
    const synth = new Synth({ context: ctx });
    synth.startNote(toneNote({ family: 'detunedSaw', note: 57 }), 0, 0.25);
    expect(log.filter((o) => o.op === 'osc.start').map((o) => o.when)).toEqual([0, 0]);
    const freqs = log.filter((o) => o.op.startsWith('freq') && o.op.endsWith('setValueAtTime')).map((o) => o.value);
    expect(freqs[1]).toBe(NOTE_FREQ[57]! * DETUNE_RATIO);
  });

  it('channel strip: CC7/CC11 set chGain, CC10 sets the quadratic L/R gains', () => {
    const { ctx, log } = mockContext();
    const synth = new Synth({ context: ctx });
    synth.startNote(toneNote(), 0.5, 1.0); // creates the ch1 strip (gains 0/1/2)
    synth.applyChannelEvent({ channel: 1, kind: 'cc', controller: 7, value: 100 }, 2);
    synth.applyChannelEvent({ channel: 1, kind: 'cc', controller: 10, value: 100 }, 2.25);
    expect(log).toContainEqual({ op: 'gain0.setValueAtTime', target: -1, when: 2, value: channelGain(100, 127) });
    expect(log).toContainEqual({ op: 'gain1.setValueAtTime', target: -1, when: 2.25, value: panLaw(100).left });
    expect(log).toContainEqual({ op: 'gain2.setValueAtTime', target: -1, when: 2.25, value: panLaw(100).right });
  });

  it('per-channel lifecycle: CC123 all-notes-off kills with a 2 ms fade; program updates state', () => {
    const { ctx, log, now } = mockContext();
    const synth = new Synth({ context: ctx });
    synth.startNote(toneNote({ channel: 1 }), 0, 1);
    synth.startNote(toneNote({ channel: 3, note: 60 }), 0, 1);
    expect(synth.activeVoices(0)).toBe(2);
    synth.applyChannelEvent({ channel: 1, kind: 'cc', controller: 123, value: 0 }, 0.3);
    expect(log).toContainEqual({ op: 'gain3.setValueAtTime', target: -1, when: 0.3, value: 0 }); // env of ch1 voice
    const stops = log.filter((o) => o.op === 'osc.stop').map((o) => o.when).sort((a, b) => a - b);
    expect(stops).toEqual([0.302, 1.081, 1.081]); // kill fade + both natural-stop schedules (scheduled at note-on)
    now.t = 2;
    expect(synth.activeVoices(2)).toBe(0); // voices age out past endT (LRU pool, not nodes, caps polyphony)
    synth.applyChannelEvent({ channel: 1, kind: 'program', program: 4 }, 2.5);
    expect(synth.channelState(1).program).toBe(4);
  });

  it('drum note-on schedules a noise source with the archetype filter + decay stop', () => {
    const { ctx, log } = mockContext();
    const synth = new Synth({ context: ctx });
    synth.startNote(toneNote({ channel: 9, kind: 'drum', drum: 'kick', note: 36 }), 0.5, 0.5);
    expect(log).toContainEqual({ op: 'src.start', target: 5, when: 0.5 });
    expect(log).toContainEqual({ op: 'src.stop', target: 5, when: 0.751 }); // 250 ms kick decay
    expect(log).toContainEqual({ op: 'flt6.setValueAtTime', target: -1, when: 0.5, value: 150 });
  });
});
