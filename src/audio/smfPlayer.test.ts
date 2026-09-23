// audio/smfPlayer.test.ts — M10-07 SMF player goldens (M10-plan §M10-07
// acceptance 1/2 + lifecycle/loop/mock-clock items): voice-allocation
// tables for three hand-built fixture songs (from the M10-03 smfBuild
// writer), exact rational tempo-change retiming, loop restart at endT
// (+0 gap), 40-note LRU steal order, offline golden renders with
// double-run bit-equality, realtime lookahead scheduling on a mock clock,
// note-off / all-notes-off lifecycle.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { buildSmf, type BuildEvent } from '../../tests/fixtures/smfBuild';
import { decodeSmf, rationalCmp, type Rational } from './smf';
import {
  expandLoops,
  LOOKAHEAD_S,
  planMusic,
  renderPlanOffline,
  SmfPlayer,
  type MusicPlan,
} from './smfPlayer';
import { mixChecksum, Synth, type SynthContextLike } from './synth';

const rat = (t: Rational): string => `${t.n}/${t.d}`;

function canonical(p: MusicPlan): string {
  return p.notes
    .map(
      (n) =>
        `v${n.voice} ch${n.channel} n${n.note} vel${n.velocity} t=${rat(n.t)} rel=${rat(n.releaseT)} ` +
        `${n.kind === 'drum' ? 'drum:' + n.drum : 'fam:' + n.family} p${n.program} st=${n.stolen ? 1 : 0} ` +
        `g=${n.gainLeft.toFixed(6)}/${n.gainRight.toFixed(6)}`,
    )
    .join('\n');
}

// Fixture songs (hand-built, same style as smf.test.ts):
//   A: format 0, div 480 — lead line + late bass note (voice-recycle proof).
//   B: format 1, div 96 — conductor tempo CHANGE at tick 96 + 2 player tracks
//      (exact rational retiming + CC7/CC10 baking).
//   C: format 1, div 480 — channel-9 percussion incl. an unmapped note.
const songA: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
    { delta: 0, type: 'program', channel: 0, program: 80 },
    { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 100 },
    { delta: 240, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 0, note: 64, velocity: 90 },
    { delta: 240, type: 'noteOff', channel: 0, note: 64, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 1, note: 48, velocity: 80 },
    { delta: 480, type: 'noteOff', channel: 1, note: 48, velocity: 0 },
    { delta: 0, type: 'eot' },
  ],
];

const songB: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
    { delta: 96, type: 'tempo', usPerQuarter: 250_000 },
    { delta: 96, type: 'eot' },
  ],
  [
    { delta: 0, type: 'program', channel: 1, program: 4 },
    { delta: 0, type: 'cc', channel: 1, controller: 7, value: 100 },
    { delta: 0, type: 'cc', channel: 1, controller: 10, value: 96 },
    { delta: 0, type: 'noteOn', channel: 1, note: 72, velocity: 110 },
    { delta: 96, type: 'noteOff', channel: 1, note: 72, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 1, note: 76, velocity: 100 },
    { delta: 24, type: 'noteOff', channel: 1, note: 76, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 1, note: 79, velocity: 100 },
    { delta: 24, type: 'noteOff', channel: 1, note: 79, velocity: 0 },
    { delta: 0, type: 'eot' },
  ],
  [
    { delta: 0, type: 'program', channel: 4, program: 33 },
    { delta: 0, type: 'noteOn', channel: 4, note: 36, velocity: 120 },
    { delta: 192, type: 'noteOff', channel: 4, note: 36, velocity: 0 },
    { delta: 0, type: 'eot' },
  ],
];

const songC: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 125_000 },
    { delta: 0, type: 'eot' },
  ],
  [
    { delta: 0, type: 'noteOn', channel: 9, note: 36, velocity: 120 },
    { delta: 0, type: 'noteOn', channel: 9, note: 38, velocity: 100 },
    { delta: 0, type: 'noteOn', channel: 9, note: 42, velocity: 90 },
    { delta: 0, type: 'noteOn', channel: 9, note: 49, velocity: 110 },
    { delta: 0, type: 'noteOn', channel: 9, note: 70, velocity: 60 },
    { delta: 240, type: 'noteOff', channel: 9, note: 36, velocity: 0 },
    { delta: 0, type: 'eot' },
  ],
];

const planA = (): MusicPlan => planMusic(decodeSmf(buildSmf({ format: 0, division: 480, tracks: songA })));
const planB = (): MusicPlan => planMusic(decodeSmf(buildSmf({ format: 1, division: 96, tracks: songB })));
const planC = (): MusicPlan => planMusic(decodeSmf(buildSmf({ format: 1, division: 480, tracks: songC })));

// ---------------------------------------------------------------------------
// Plan goldens (acceptance 1: voice-allocation tables, retiming, loops)
// ---------------------------------------------------------------------------

describe('planMusic allocation goldens', () => {
  it('song A: voice recycle after release, exact µs, saw lead + piano bass', () => {
    const p = planA();
    expect(rat(p.endT)).toBe('1000000/1');
    expect(p.endTick).toBe(960);
    expect(canonical(p)).toBe(
      [
        'v0 ch0 n60 vel100 t=0/1 rel=250000/1 fam:saw p80 st=0 g=0.750000/0.750000',
        'v1 ch0 n64 vel90 t=250000/1 rel=500000/1 fam:saw p80 st=0 g=0.750000/0.750000',
        'v0 ch1 n48 vel80 t=500000/1 rel=1000000/1 fam:detunedTri p0 st=0 g=0.750000/0.750000',
      ].join('\n'),
    );
    expect(p.stats).toEqual({ steals: 0, capped: 0, drumUnmapped: 0 });
  });

  it('song B: tempo change retimes EXACTLY (96 tick/qr: 500000 -> 250000 us/qr at tick 96)', () => {
    const p = planB();
    expect(rat(p.endT)).toBe('750000/1'); // 96@500000/96 + 96@250000/96 = 500000+250000
    // t(96 ticks) = 96*500000/96 = 500000 us; +24 ticks @ 250000/96 = +62500 us.
    expect(canonical(p)).toBe(
      [
        'v0 ch1 n72 vel110 t=0/1 rel=500000/1 fam:detunedTri p4 st=0 g=0.344488/0.738189',
        'v1 ch4 n36 vel120 t=0/1 rel=750000/1 fam:tri p33 st=0 g=0.750000/0.750000',
        'v2 ch1 n76 vel100 t=500000/1 rel=562500/1 fam:detunedTri p4 st=0 g=0.344488/0.738189',
        'v3 ch1 n79 vel100 t=562500/1 rel=625000/1 fam:detunedTri p4 st=0 g=0.344488/0.738189',
      ].join('\n'),
    );
    // CC7=100 + CC10=96 baked: 100/127 x panLaw(96) — exact match against the laws.
    const n0 = p.notes[0]!;
    expect(n0.gainLeft).toBe((100 / 127) * (1 - 192 * 192 / 65536) * 1);
    expect(n0.gainRight).toBe((100 / 127) * (1 - 64 * 64 / 65536) * 1);
  });

  it('song C: ch-9 percussion auto-releases at t (note-off ignored), unmapped note counted', () => {
    const p = planC();
    expect(rat(p.endT)).toBe('62500/1');
    expect(canonical(p)).toBe(
      [
        'v0 ch9 n36 vel120 t=0/1 rel=0/1 drum:kick p0 st=0 g=0.750000/0.750000',
        'v1 ch9 n38 vel100 t=0/1 rel=0/1 drum:snare p0 st=0 g=0.750000/0.750000',
        'v2 ch9 n42 vel90 t=0/1 rel=0/1 drum:hat p0 st=0 g=0.750000/0.750000',
        'v3 ch9 n49 vel110 t=0/1 rel=0/1 drum:crash p0 st=0 g=0.750000/0.750000',
        'v4 ch9 n70 vel60 t=0/1 rel=0/1 drum:snare p0 st=0 g=0.750000/0.750000',
      ].join('\n'),
    );
    expect(p.stats).toEqual({ steals: 0, capped: 0, drumUnmapped: 1 }); // n70 unmapped
  });

  it('is deterministic: two plan runs, identical canonical text', () => {
    expect(canonical(planB())).toBe(canonical(planB()));
  });

  it('32-voice cap: 40 simultaneous notes steal per-channel LRU in order v0..v7', () => {
    const ev: BuildEvent[] = [{ delta: 0, type: 'tempo', usPerQuarter: 500_000 }];
    for (let i = 0; i < 40; i++) ev.push({ delta: 0, type: 'noteOn', channel: 2, note: 40 + i, velocity: 100 });
    ev.push({ delta: 0, type: 'eot' });
    const p = planMusic(decodeSmf(buildSmf({ format: 0, division: 480, tracks: [ev] })));
    expect(p.notes.length).toBe(40);
    expect(p.notes.slice(0, 32).map((n) => n.voice)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(p.notes.slice(0, 32).every((n) => !n.stolen)).toBe(true);
    expect(p.notes.slice(32).map((n) => `${n.note}->v${n.voice}st${n.stolen ? 1 : 0}`)).toEqual([
      '72->v0st1', '73->v1st1', '74->v2st1', '75->v3st1', '76->v4st1', '77->v5st1', '78->v6st1', '79->v7st1',
    ]);
    expect(p.stats.steals).toBe(8);
  });

  it('loop expansion restarts EXACTLY at endT with +0 gap (vanilla restart semantics)', () => {
    const p = planB();
    const looped = expandLoops(p, 2);
    expect(looped.notes.length).toBe(2 * p.notes.length);
    const cycle1 = looped.notes.filter((n) => rationalCmp(n.t, p.endT) >= 0);
    expect(cycle1.length).toBe(p.notes.length);
    expect(rat(cycle1[0]!.t)).toBe('750000/1'); // == endT, no gap
    expect(looped.notes[0]!.t).toEqual(p.notes[0]!.t);
  });
});

// ---------------------------------------------------------------------------
// Offline golden renders (same engine, rational tempo math; no wall clock)
// ---------------------------------------------------------------------------

function renderTwice(plan: MusicPlan, seconds: number, loops = 1): [string, string] {
  const a = renderPlanOffline(plan, { sampleRate: 8000, seconds, loops });
  const b = renderPlanOffline(plan, { sampleRate: 8000, seconds, loops });
  for (let i = 0; i < a.left.length; i++) {
    if (!Object.is(a.left[i], b.left[i]) || !Object.is(a.right[i], b.right[i])) return [mixChecksum(a), 'DOUBLE-RUN MISMATCH'];
  }
  return [mixChecksum(a), mixChecksum(b)];
}

describe('offline golden renders (fixture songs, 8 kHz)', () => {
  it('song A renders bit-identical across double-run; checksum pinned', () => {
    const [h1, h2] = renderTwice(planA(), 1.5);
    expect(h1).toBe('6ac42a2c:6ac42a2c');
    expect(h1).toBe(h2);
  });

  it('song B (tempo change) checksum pinned', () => {
    const [h1, h2] = renderTwice(planB(), 1.25);
    expect(h1).toBe('f7b8bd73:36861099');
    expect(h1).toBe(h2);
  });

  it('song C (percussion) checksum pinned', () => {
    const [h1, h2] = renderTwice(planC(), 0.6);
    expect(h1).toBe('9ce654d1:9ce654d1');
    expect(h1).toBe(h2);
  });

  it('song B x2 loops checksum pinned (loop expansion inside the same engine)', () => {
    const [h1, h2] = renderTwice(planB(), 2.0, 2);
    expect(h1).toBe('2c757b9f:8f654c5f');
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle (per-note-off / all-notes-off)
// ---------------------------------------------------------------------------

describe('lifecycle', () => {
  it('note-on velocity 0 releases at its exact time (SMF convention)', () => {
    const track: BuildEvent[] = [
      { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
      { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 90 },
      { delta: 120, type: 'noteOn', channel: 0, note: 60, velocity: 0 },
      { delta: 0, type: 'eot' },
    ];
    const p = planMusic(decodeSmf(buildSmf({ format: 0, division: 480, tracks: [track] })));
    expect(rat(p.notes[0]!.t)).toBe('0/1');
    expect(rat(p.notes[0]!.releaseT)).toBe('125000/1'); // 120 ticks @ 500000/480
  });

  it('CC 121 all-notes-off releases every held note on that channel at t', () => {
    const track: BuildEvent[] = [
      { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
      { delta: 0, type: 'noteOn', channel: 3, note: 60, velocity: 90 },
      { delta: 0, type: 'noteOn', channel: 3, note: 64, velocity: 90 },
      { delta: 480, type: 'cc', channel: 3, controller: 121, value: 0 },
      { delta: 0, type: 'noteOn', channel: 3, note: 60, velocity: 90 },
      { delta: 480, type: 'eot' },
    ];
    const p = planMusic(decodeSmf(buildSmf({ format: 0, division: 480, tracks: [track] })));
    const held = p.notes.filter((n) => n.note !== 60 || rat(n.t) === '0/1');
    expect(held.length).toBeGreaterThanOrEqual(2);
    for (const n of p.notes.slice(0, 2)) expect(rat(n.releaseT)).toBe('500000/1'); // released by CC121
    expect(p.channelEvents.some((c) => c.kind === 'cc' && c.controller === 121)).toBe(true);
    // Notes started AFTER the CC are unaffected: last note releases at endT.
    expect(rat(p.notes[2]!.releaseT)).toBe('1000000/1');
  });

  it('re-articulating a held pitch releases the previous voice at t (pinned tie rule)', () => {
    const track: BuildEvent[] = [
      { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
      { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 90 },
      { delta: 240, type: 'noteOn', channel: 0, note: 60, velocity: 95 },
      { delta: 240, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
      { delta: 0, type: 'eot' },
    ];
    const p = planMusic(decodeSmf(buildSmf({ format: 0, division: 480, tracks: [track] })));
    expect(p.notes.length).toBe(2);
    expect(rat(p.notes[0]!.releaseT)).toBe('250000/1');
    expect(rat(p.notes[1]!.releaseT)).toBe('500000/1');
  });
});

// ---------------------------------------------------------------------------
// Realtime scheduling (acceptance: lookahead, mock clock)
// ---------------------------------------------------------------------------

function mockGraph(): { ctx: SynthContextLike; starts: number[]; kills: Array<{ v: number; when: number }> } {
  const starts: number[] = [];
  const kills: Array<{ v: number; when: number }> = [];
  const param = () => ({
    value: 0,
    setValueAtTime(v: number, t: number): void {
      if (v === 0) kills.push({ v, when: t });
    },
    linearRampToValueAtTime(): void {
      /* not asserted here */
    },
  });
  const src = () => ({
    buffer: null,
    connect: () => undefined,
    start: (t: number) => starts.push(t),
    stop: () => undefined,
  });
  const ctx: SynthContextLike = {
    sampleRate: 44100,
    currentTime: 0,
    destination: 'dest',
    createGain: () => ({ gain: param(), connect: () => undefined }),
    createOscillator: () => ({
      type: 'sine',
      frequency: param(),
      detune: param(),
      connect: () => undefined,
      start: (t: number) => starts.push(t),
      stop: () => undefined,
    }),
    createBufferSource: src,
    createBuffer: (_c: number, frames: number) => {
      const data = new Float32Array(frames);
      return { getChannelData: () => data };
    },
    createBiquadFilter: () => ({ type: 'lowpass', frequency: param(), Q: param(), connect: () => undefined }),
  };
  return { ctx, starts, kills };
}

describe('realtime SmfPlayer (mock clock, 100 ms lookahead)', () => {
  it('schedules each note at base + plan-time, nothing beyond the window', () => {
    const { ctx, starts } = mockGraph();
    const player = new SmfPlayer(new Synth({ context: ctx }));
    player.playPlan(planA(), false, 0);
    expect(player.pump(0)).toBe(2); // program (state-only) + first note at when 0
    expect(starts).toEqual([0]);
    player.pump(0.2);
    expect(starts).toEqual([0, 0.25]); // 250000 us -> exactly 0.25 s
    player.pump(0.45);
    expect(starts).toEqual([0, 0.25, 0.5, 0.5]); // the ch1 bass is a detuned PAIR (2 oscs)
    expect(player.playing).toBe(false); // plan exhausted, non-looping
    expect(LOOKAHEAD_S).toBe(0.1);
  });

  it('looping re-arms at endT (+0 gap): cycle-1 notes schedule from endT onward', () => {
    const { ctx, starts } = mockGraph();
    const player = new SmfPlayer(new Synth({ context: ctx }));
    player.playPlan(planB(), true, 0);
    player.pump(0);
    player.pump(0.5); // cycle 0 notes at 0, 0.5, 0.5625 (0.75 endT not yet reached at pump(0.5))
    player.pump(0.72);
    expect(starts).toContain(0.75); // loop restart exactly at endT
    expect(player.playing).toBe(true);
  });

  it('pause freezes the timeline; resume shifts the base (schedule kept)', () => {
    const { ctx, starts } = mockGraph();
    const player = new SmfPlayer(new Synth({ context: ctx }));
    player.playPlan(planA(), false, 0);
    player.pump(0);
    player.pause(0.05);
    expect(player.pump(0.2)).toBe(0); // paused: no scheduling
    player.resume(0.45); // consumed-playback stays 0.05 s
    expect(player.position(0.5)).toBeCloseTo(0.1, 12);
    player.pump(0.6);
    expect(starts).toEqual([0, 0.65]); // 0.25 plan-time + 0.4 shifted base
  });

  it('stop tears down: active sources killed at now, playing false', () => {
    const { ctx, starts, kills } = mockGraph();
    const player = new SmfPlayer(new Synth({ context: ctx }));
    player.playPlan(planA(), true, 0);
    player.pump(0);
    expect(starts).toEqual([0]);
    player.stop(0.1);
    expect(kills.some((k) => k.when === 0.1)).toBe(true);
    expect(player.playing).toBe(false);
    expect(player.pump(0.2)).toBe(0);
  });

  it('percussion song schedules 5 noise voices at when 0', () => {
    const { ctx, starts } = mockGraph();
    const player = new SmfPlayer(new Synth({ context: ctx }));
    player.playPlan(planC(), false, 0);
    expect(player.pump(0)).toBe(5);
    expect(starts).toEqual([0, 0, 0, 0, 0]);
  });
});
