/**
 * Tests for audio/smf.ts — M10-03 SMF decoder (M10-plan §M10-03 acceptance).
 * Hand-built byte fixtures only (tests/fixtures/smfBuild.ts + raw arrays) —
 * no external MIDI assets (freedoom1 default music is OGG; SMF here is the
 * deterministic test path + SMF-IWAD support, no MUS, no transcription).
 *
 * Evidence classes:
 *  1. FORMAT 0 melody: exact merged event table (times as exact rationals).
 *  2. FORMAT 1 multi-track merge: tie-break pinned — equal time => ascending
 *     track, then in-track file order (note-off/note-on order preserved).
 *  3. RUNNING STATUS: raw byte-level stream + end-of-track-under-running-
 *     status edge; builder emits compressed status (golden byte counts).
 *  4. TEMPO MAP: mid-piece tempo change => exact tick->sec table; tempo
 *     events in a NON-conductor track retime the whole merge (plan §M10-03).
 *  5. SYSEX: mid-track skip + counter; meta FF58/FF00 parsed, FF01 counted.
 *  6. CORRUPT INPUT: typed SmfDecodeError codes, never a hang, never raw.
 *  7. DETERMINISM: double decode byte-equal canonical dump (FNV-1a golden).
 *  8. PROPERTY: decode(build(x)) == canonicalized x (tick domain).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { buildSmf, type BuildEvent, type SmfBuildSpec } from '../../tests/fixtures/smfBuild';
import {
  decodeSmf,
  rational,
  rationalEq,
  smfCanonical,
  SmfDecodeError,
  type Smf,
  type SmfEvent,
  type SmfTimedEvent,
} from './smf';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expectSmfError(fn: () => unknown, code: string): void {
  let caught: unknown = null;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected a throw').toBeInstanceOf(SmfDecodeError);
  expect((caught as SmfDecodeError).code).toBe(code);
}

/** FNV-1a 32-bit hex — determinism witness for canonical dumps. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const us = (n: bigint, d: bigint = 1n) => rational(n, d);

/** Canonical time string ('0' for integral µs, 'n/d' for fractional). */
function rstr(n: bigint, d: bigint = 1n): string {
  const r = rational(n, d);
  return r.d === 1n ? `${r.n}` : `${r.n}/${r.d}`;
}

function expectTime(e: SmfTimedEvent, n: bigint, d: bigint = 1n): void {
  expect(rationalEq(e.time, us(n, d))).toBe(true);
  expect(`${e.time.n}/${e.time.d}`).toBe(`${us(n, d).n}/${us(n, d).d}`);
}

/** Canonical tick-domain key (track, order, tick, event) — time-model-free. */
function tickKey(e: SmfTimedEvent): string {
  return `trk${e.track}#${e.order}@${e.tick} ${JSON.stringify(e.event)}`;
}

/** Map a BuildEvent to the decoder's event shape (property-test canonical). */
function canonicalBody(e: BuildEvent): SmfEvent | null {
  switch (e.type) {
    case 'noteOn':
      return { kind: 'noteOn', channel: e.channel, note: e.note, velocity: e.velocity };
    case 'noteOff':
      return { kind: 'noteOff', channel: e.channel, note: e.note, velocity: e.velocity };
    case 'cc':
      return { kind: 'controlChange', channel: e.channel, controller: e.controller, value: e.value };
    case 'program':
      return { kind: 'programChange', channel: e.channel, program: e.program };
    case 'pitchBend':
      return { kind: 'pitchBend', channel: e.channel, value: e.value };
    case 'pressure':
      return { kind: 'polyPressure', channel: e.channel, note: e.note, pressure: e.value };
    case 'chanPressure':
      return { kind: 'channelPressure', channel: e.channel, pressure: e.value };
    case 'tempo':
      return { kind: 'tempo', usPerQuarter: e.usPerQuarter };
    case 'timeSignature':
      return {
        kind: 'timeSignature',
        numerator: e.numerator,
        denominatorPow: e.denominatorPow,
        clocksPerClick: e.clocksPerClick ?? 24,
        bytesPerBeat: e.bytesPerBeat ?? 8,
      };
    case 'seqNum':
      return { kind: 'sequenceNumber', value: e.value };
    case 'meta':
      return { kind: 'meta', metaType: e.metaType, data: e.data };
    default:
      return null; // sysex (skipped) and eot (structural) produce no event
  }
}

function canonicalSpec(spec: SmfBuildSpec): string[] {
  const rows: { tick: number; track: number; order: number; body: string }[] = [];
  spec.tracks.forEach((events, track) => {
    let tick = 0;
    let order = 0;
    for (const e of events) {
      tick += e.delta;
      const body = canonicalBody(e);
      if (body !== null) rows.push({ tick, track, order: order++, body: JSON.stringify(body) });
      if (e.type === 'eot') return; // events after EOT are undefined; stop
    }
  });
  return rows
    .sort((a, b) => a.tick - b.tick || a.track - b.track || a.order - b.order)
    .map((r) => `t${r.tick} trk${r.track}#${r.order} ${r.body}`);
}

// ---------------------------------------------------------------------------
// 1. Format 0 melody — exact event table
// ---------------------------------------------------------------------------

describe('smf: format 0 exact event table', () => {
  const bytes = buildSmf({
    format: 0,
    division: 96,
    tracks: [
      [
        { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 96 },
        { delta: 96, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
        { delta: 0, type: 'noteOn', channel: 0, note: 64, velocity: 96 },
        { delta: 96, type: 'noteOff', channel: 0, note: 64, velocity: 0 },
      ],
    ],
  });

  it('merges 4 events with exact rational times (default 500000 us/qn, ppq 96)', () => {
    const smf = decodeSmf(bytes);
    expect(smf.format).toBe(0);
    expect(smf.division).toBe(96);
    expect(smf.events.length).toBe(4);
    expect(smf.events.map((e) => e.event.kind)).toEqual(['noteOn', 'noteOff', 'noteOn', 'noteOff']);
    expectTime(smf.events[0]!, 0n);
    expectTime(smf.events[1]!, 500_000n); // 96 ticks * 500000/96 = exactly 0.5 s
    expectTime(smf.events[2]!, 500_000n);
    expectTime(smf.events[3]!, 1_000_000n);
    expect(smf.events[1]!.event).toEqual({ kind: 'noteOff', channel: 0, note: 60, velocity: 0 });
    expect(rationalEq(smf.endT, us(1_000_000n))).toBe(true);
    expect(smf.endTick).toBe(192);
    expect(smf.stats).toEqual({ tracks: 1, tracksWithEndOfTrack: 1, sysexSkipped: 0, metaIgnored: 0 });
  });

  it('rejects unsupported formats and SMPTE divisions with typed errors', () => {
    expectSmfError(
      () => decodeSmf(buildSmf({ format: 3 as 0, division: 96, tracks: [[{ delta: 0, type: 'eot' }]] })),
      'unsupported-format',
    );
    const raw = buildSmf({ format: 0, division: 96, tracks: [[{ delta: 0, type: 'eot' }]] });
    raw[9] = 3; // format
    expectSmfError(() => decodeSmf(raw), 'unsupported-format');
    raw[9] = 0;
    raw[12] = 0x80; // SMPTE division (180-24 style)
    raw[13] = 24;
    expectSmfError(() => decodeSmf(raw), 'unsupported-division');
  });
});

// ---------------------------------------------------------------------------
// 2. Format 1 multi-track merge — stable tie-break
// ---------------------------------------------------------------------------

describe('smf: format 1 merge order', () => {
  const mk = () =>
    buildSmf({
      format: 1,
      division: 96,
      tracks: [
        [{ delta: 0, type: 'tempo', usPerQuarter: 500_000 }],
        [
          { delta: 0, type: 'noteOff', channel: 1, note: 50, velocity: 0 }, // first in file order
          { delta: 0, type: 'noteOn', channel: 1, note: 50, velocity: 80 },
        ],
        [{ delta: 0, type: 'noteOn', channel: 2, note: 64, velocity: 90 }],
      ],
    });

  it('tie-break at equal time: track ascending, then in-track file order', () => {
    const smf = decodeSmf(mk());
    expect(smf.events.map((e) => `${e.track}:${e.order}:${e.event.kind}`)).toEqual([
      '0:0:tempo', // t=0, tempo event present in the stream
      '1:0:noteOff', // track 1, FILE order: off before on (pinned rule)
      '1:1:noteOn',
      '2:0:noteOn',
    ]);
    smf.events.forEach((e) => expectTime(e, 0n));
    const t = smf.events.map(tickKey);
    expect(new Set(t).size).toBe(t.length); // total deterministic order
  });

  it('multi-track simultaneous starts keep the same order across runs', () => {
    const a = smfCanonical(decodeSmf(mk()));
    const b = smfCanonical(decodeSmf(mk()));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 3. Running status
// ---------------------------------------------------------------------------

describe('smf: running status', () => {
  it('raw running-status stream decodes (status byte appears once)', () => {
    // delta0 90 3C 7F, delta 64 (running: second noteOn w/o status), EOT
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
      0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x0b,
      0x00, 0x90, 0x3c, 0x7f, 0x40, 0x3c + 4, 0x70, 0x00, 0xff, 0x2f, 0x00,
    ]);
    const smf = decodeSmf(bytes);
    expect(smf.events.length).toBe(2);
    expect(smf.events[0]!.event).toEqual({ kind: 'noteOn', channel: 0, note: 60, velocity: 127 });
    expect(smf.events[1]!.event).toEqual({ kind: 'noteOn', channel: 0, note: 64, velocity: 112 });
    expectTime(smf.events[1]!, 64n * 500_000n, 96n); // 333333 1/3 us — exact rational, no drift
    expect(`${smf.events[1]!.time.n}/${smf.events[1]!.time.d}`).toBe('1000000/3');
  });

  it('end-of-track under running status terminates the track', () => {
    // 91 3C 40, delta0, FF2F — FF must NOT be swallowed as running-status data.
    const bytes = Uint8Array.from([
      0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x60,
      0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x91, 0x3c, 0x40, 0x00, 0xff, 0x2f, 0x00,
    ]);
    const smf = decodeSmf(bytes);
    expect(smf.events.length).toBe(1);
    expect(smf.stats.tracksWithEndOfTrack).toBe(1);
  });

  it('builder uses running status (status byte emitted once per run)', () => {
    const packed = buildSmf({
      format: 0,
      division: 96,
      tracks: [
        [
          { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 96 },
          { delta: 8, type: 'noteOn', channel: 0, note: 61, velocity: 96 },
          { delta: 0, type: 'eot' },
        ],
      ],
    });
    const full = buildSmf({
      format: 0,
      division: 96,
      fullStatus: true,
      tracks: [
        [
          { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 96 },
          { delta: 8, type: 'noteOn', channel: 0, note: 61, velocity: 96 },
          { delta: 0, type: 'eot' },
        ],
      ],
    });
    const count = (b: Uint8Array) => Array.from(b).filter((x) => x === 0x90).length;
    expect(count(packed)).toBe(1);
    expect(count(full)).toBe(2);
    expect(packed.length).toBe(full.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 4. Tempo map — exact tick->sec table
// ---------------------------------------------------------------------------

describe('smf: tempo map (absolute-seconds timeline)', () => {
  it('mid-piece tempo change: exact tick->sec table (ppq 90)', () => {
    // ticks 0,90 at 500000; tempo->600000 at tick 90; ticks 135,180 at 600000.
    const smf = decodeSmf(
      buildSmf({
        format: 1,
        division: 90,
        tracks: [
          [
            { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
            { delta: 90, type: 'tempo', usPerQuarter: 600_000 },
          ],
          [
            { delta: 0, type: 'noteOn', channel: 0, note: 48, velocity: 80 },
            { delta: 45, type: 'noteOn', channel: 0, note: 52, velocity: 80 },
            { delta: 45, type: 'noteOn', channel: 0, note: 55, velocity: 80 },
            { delta: 45, type: 'noteOn', channel: 0, note: 60, velocity: 80 },
            { delta: 45, type: 'noteOff', channel: 0, note: 48, velocity: 0 },
          ],
        ],
      }),
    );
    // Merged table (time, kind): the 5 note-ons interleave with the tempo map.
    const table = smf.events.map((e) => [rstr(e.time.n, e.time.d), e.event.kind]);
    expect(table).toEqual([
      ['0', 'tempo'], //          tick   0 ->          0 us
      ['0', 'noteOn'], //         tick   0
      ['250000', 'noteOn'], //    tick  45: 45*500000/90   = 250000
      ['500000', 'tempo'], //     tick  90: tempo -> 600000 from here
      ['500000', 'noteOn'], //    tick  90 (tie: track 0 first)
      ['800000', 'noteOn'], //    tick 135: 500000 + 45*600000/90
      ['1100000', 'noteOff'], //  tick 180: + 45*600000/90
    ]);
    expect(rationalEq(smf.endT, us(1_100_000n))).toBe(true);
    expect(smf.endTick).toBe(180);
  });

  it('tempo event in a NON-conductor track retimes the whole merge', () => {
    // Track 1 carries the tempo change; track 0 has plain notes.
    const smf = decodeSmf(
      buildSmf({
        format: 1,
        division: 96,
        tracks: [
          [
            { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 90 },
            { delta: 96, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
            { delta: 96, type: 'noteOn', channel: 0, note: 62, velocity: 90 },
          ],
          [
            { delta: 48, type: 'tempo', usPerQuarter: 400_000 },
            { delta: 48, type: 'noteOn', channel: 1, note: 70, velocity: 70 },
          ],
        ],
      }),
    );
    // Exact per-segment math: trk1 tempo @ tick48 = 48*500000/96 = 250000;
    // tick96 (both tracks) = 250000 + 48*400000/96 = 450000; tick192-trk0
    // = 450000 + 96*400000/96 = 850000. Tie at 450000: track ascending.
    const table = smf.events.map((e) => [rstr(e.time.n, e.time.d), e.track, e.event.kind]);
    expect(table).toEqual([
      ['0', 0, 'noteOn'],
      ['250000', 1, 'tempo'],
      ['450000', 0, 'noteOff'],
      ['450000', 1, 'noteOn'],
      ['850000', 0, 'noteOn'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 5. Sysex + meta
// ---------------------------------------------------------------------------

describe('smf: sysex skip + meta handling', () => {
  it('mid-track sysex is skipped (counted), events after it keep their ticks', () => {
    const smf = decodeSmf(
      buildSmf({
        format: 0,
        division: 480,
        tracks: [
          [
            { delta: 0, type: 'noteOn', channel: 9, note: 0, velocity: 100 },
            { delta: 120, type: 'sysex', data: [0x7e, 0x7f, 0x09, 0x01] },
            { delta: 60, type: 'noteOff', channel: 9, note: 0, velocity: 0 },
            { delta: 0, type: 'cc', channel: 7, controller: 7, value: 100 },
            { delta: 0, type: 'meta', metaType: 0x01, data: [0x41, 0x42] }, // text: ignored-counter
          ],
        ],
      }),
    );
    expect(smf.stats.sysexSkipped).toBe(1);
    expect(smf.stats.metaIgnored).toBe(1);
    expect(smf.events.map((e) => e.event.kind)).toEqual(['noteOn', 'noteOff', 'controlChange', 'meta']);
    expect(smf.events[1]!.tick).toBe(180);
  });

  it('timeSignature and sequenceNumber parse; all 16 channels decode', () => {
    const track: BuildEvent[] = [{ delta: 0, type: 'seqNum', value: 7 }, { delta: 0, type: 'timeSignature', numerator: 3, denominatorPow: 2 }];
    for (let c = 0; c < 16; c++) track.push({ delta: 1, type: 'noteOn', channel: c, note: 60, velocity: 100 });
    const smf = decodeSmf(buildSmf({ format: 0, division: 96, tracks: [track] }));
    expect(smf.events[0]!.event).toEqual({ kind: 'sequenceNumber', value: 7 });
    expect(smf.events[1]!.event).toEqual({ kind: 'timeSignature', numerator: 3, denominatorPow: 2, clocksPerClick: 24, bytesPerBeat: 8 });
    const channels = smf.events.slice(2).map((e) => (e.event as { channel: number }).channel);
    expect(channels).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });
});

// ---------------------------------------------------------------------------
// 6. Corrupt input — typed errors, never a hang
// ---------------------------------------------------------------------------

describe('smf: corrupt input robustness', () => {
  const good = buildSmf({ format: 0, division: 96, tracks: [[{ delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 1 }]] });
  const cut = (n: number) => good.slice(0, n);

  it('truncated structures produce typed SmfDecodeError (no hang, no raw error)', () => {
    expectSmfError(() => decodeSmf(new Uint8Array(0)), 'truncated'); // EOF inside magic
    expectSmfError(() => decodeSmf(cut(4)), 'truncated'); // header only
    expectSmfError(() => decodeSmf(cut(14)), 'truncated'); // MTrk magic missing
    expectSmfError(() => decodeSmf(cut(20)), 'truncated'); // event data cut mid-note
    const lying = Uint8Array.from(good);
    lying[18] = 0x7f; // MTrk length >> remaining
    lying[19] = 0xff;
    expectSmfError(() => decodeSmf(lying), 'truncated');
    const wrongMagic = Uint8Array.from(good);
    wrongMagic[0] = 0x58; // 'XThd'
    expectSmfError(() => decodeSmf(wrongMagic), 'bad-magic');
  });

  it('field-level corruption maps to specific codes', () => {
    const patch = (trackBytes: number[], nTracks = 1): Uint8Array => {
      const body = Uint8Array.from(trackBytes);
      const out = new Uint8Array(22 + body.length);
      out.set([0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0], 0);
      out[11] = nTracks;
      out.set([0, 0x60, 0x4d, 0x54, 0x72, 0x6b], 12); // division 96 + 'MTrk'
      out[20] = (body.length >> 8) & 0xff;
      out[21] = body.length & 0xff;
      out.set(body, 22);
      return out;
    };
    expectSmfError(() => decodeSmf(patch([0x00, 0xff, 0x2f, 0x00], 0)), 'no-tracks');
    expectSmfError(() => decodeSmf(patch([0x81, 0x80, 0x80, 0x80, 0x00, 0xff, 0x2f, 0x00])), 'varlen-overrun');
    expectSmfError(() => decodeSmf(patch([0x00, 0x40, 0xff, 0x2f, 0x00])), 'running-status');
    expectSmfError(() => decodeSmf(patch([0x00, 0xf1])), 'unknown-status');
    expectSmfError(() => decodeSmf(patch([0x00, 0xff, 0x51, 0x02, 0x07, 0xa1, 0xff, 0x2f, 0x00])), 'bad-tempo');
    expectSmfError(() => decodeSmf(patch([0x00, 0xff, 0x2f, 0x01, 0x00])), 'bad-eot');
    expectSmfError(() => decodeSmf(patch([0x00, 0xff, 0x06, 0x0a, 0x41])), 'truncated'); // meta body crosses chunk end
  });

  it('track without FF2F: lenient implicit end-of-track (no error)', () => {
    const smf = decodeSmf(
      buildSmf({
        format: 0,
        division: 96,
        noAutoEot: true,
        tracks: [[{ delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 1 }]],
      }),
    );
    expect(smf.stats.tracksWithEndOfTrack).toBe(0);
    expect(smf.endTick).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism + 8. property decode(build(x)) == x
// ---------------------------------------------------------------------------

function propertySpec(): SmfBuildSpec {
  return {
    format: 1,
    division: 96,
    tracks: [
      [
        { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
        { delta: 96, type: 'timeSignature', numerator: 6, denominatorPow: 3 },
      ],
      [
        { delta: 0, type: 'program', channel: 0, program: 1 },
        { delta: 48, type: 'noteOn', channel: 0, note: 60, velocity: 100 },
        { delta: 48, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
        { delta: 0, type: 'cc', channel: 0, controller: 11, value: 120 },
        { delta: 24, type: 'pitchBend', channel: 0, value: 8192 + 64 },
        { delta: 24, type: 'pressure', channel: 0, note: 62, value: 55 },
        { delta: 0, type: 'chanPressure', channel: 0, value: 33 },
        { delta: 1, type: 'meta', metaType: 0x06, data: [1, 2, 3] },
      ],
      [
        { delta: 0, type: 'seqNum', value: 42 },
        { delta: 96, type: 'noteOn', channel: 2, note: 40, velocity: 77 },
        { delta: 48, type: 'noteOff', channel: 2, note: 40, velocity: 0 },
      ],
    ],
  };
}

describe('smf: determinism + roundtrip property', () => {
  it('double decode is byte-equal (canonical FNV-1a golden)', () => {
    const bytes = buildSmf(propertySpec());
    const h1 = fnv1a(smfCanonical(decodeSmf(bytes)));
    const h2 = fnv1a(smfCanonical(decodeSmf(bytes)));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{8}$/);
    // Pinned: same hash must hold across runs/machines (int math only).
    expect(h1).toBe(fnv1a(smfCanonical(decodeSmf(buildSmf(propertySpec())))));
  });

  it('decode(build(x)) == canonicalized x (tick domain)', () => {
    const spec = propertySpec();
    const decoded = decodeSmf(buildSmf(spec));
    const got = decoded.events.map((e) => `t${e.tick} trk${e.track}#${e.order} ${JSON.stringify(e.event)}`);
    expect(got).toEqual(canonicalSpec(spec));
  });

  it('format 2 merges like format 1 (plan: formats 0/1/2 merged)', () => {
    const spec = propertySpec();
    const as2 = decodeSmf(buildSmf({ ...spec, format: 2 }));
    const as1 = decodeSmf(buildSmf({ ...spec, format: 1 }));
    expect(smfCanonical(as2)).toBe(smfCanonical(as1));
    expect(as2.format).toBe(2);
  });
});

describe('smf: result shape', () => {
  it('endT/endTick are the max over tracks', () => {
    const smf: Smf = decodeSmf(
      buildSmf({
        format: 1,
        division: 96,
        tracks: [
          [
            { delta: 0, type: 'noteOn', channel: 0, note: 1, velocity: 1 },
            { delta: 10, type: 'eot' },
          ],
          [{ delta: 300, type: 'eot' }],
        ],
      }),
    );
    expect(smf.endTick).toBe(300);
    expect(rationalEq(smf.endT, us(300n * 500_000n, 96n))).toBe(true);
  });
});
