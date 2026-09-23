// audio/smf.ts — SMF (Standard MIDI File) decoder: bytes → deterministic
// event list on an absolute-seconds timeline (M10-03, M10-plan §M10-03).
//
// Contract (plan §M10-03, ARCHITECTURE A-03; SMF = the deterministic test
// path + SMF-IWAD support — freedoom1's default music is OGG, no MUS here):
//   * `decodeSmf(bytes) -> Smf`: MThd (formats 0/1/2 — all merged onto one
//     shared timeline per plan), MTrk walk with varlen deltas (the same
//     128-multiplier idiom as the SFX readers), running status (survives
//     meta/sysex per the MIDI 1.0 spec), all 16 channels, sysex skipped and
//     counted, meta FF51 tempo / FF58 time-sig / FF00 seq-num parsed, FF2F
//     end-of-track, other meta ignored-with-counter.
//   * Timeline: ABSOLUTE SECONDS, exact rational microseconds — no float
//     drift. Format-1 tracks share the GLOBAL tick grid (standard SMF
//     semantics), so the tempo map is piecewise in TICKS over the union of
//     FF51 events from ANY track ("tempo events in ANY track retime the
//     merge", plan §M10-03): a tick interval of `d` ticks at `usPerQn`
//     µs/quarter adds `d * usPerQn / division` µs as a reduced BigInt
//     fraction (the `500000*delta/ppq` idiom generalized). No iteration,
//     no pathological cases — the mapping is a pure piecewise-linear
//     function of the tick grid.
//   * Sort: (time, track-order, in-track order). Pinned tie-break: equal
//     absolute times order by ascending track index, then file order
//     within the track (note-off/note-on at the same tick keep file order).
//   * `endT` = max over tracks of the end-of-track time (implicit EOT at
//     the last event if a track omits FF2F).
//   * Malformed input throws `SmfDecodeError` (typed, never a raw range
//     read); truncated chunks are detected, never a hang.
//
// Pure: no imports, no globals, no Date/Math.random (determinism rule).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** SMF default tempo when no FF51 has been seen: 120 BPM. */
export const DEFAULT_US_PER_QUARTER = 500_000;

const MAX_VARLEN_BYTES = 4;
const MAX_TRACKS = 4096;

// ---------------------------------------------------------------------------
// Exact rational microseconds (BigInt fractions, always reduced, d > 0).
// ---------------------------------------------------------------------------

/** An exact time in microseconds as a reduced fraction `n / d`. */
export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

function gcd64(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/** Build a reduced rational (throws only on d === 0 — a programmer error). */
export function rational(n: bigint, d: bigint = 1n): Rational {
  if (d === 0n) throw new RangeError('rational: zero denominator');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd64(n, d);
  return g === 0n ? { n: 0n, d: 1n } : { n: n / g, d: d / g };
}

export function rationalCmp(a: Rational, b: Rational): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export function rationalEq(a: Rational, b: Rational): boolean {
  return rationalCmp(a, b) === 0;
}

export function rationalAdd(a: Rational, b: Rational): Rational {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

/** Lossy escape hatch for consumers that need a plain number (never used internally). */
export function rationalToNumber(r: Rational): number {
  return Number(r.n) / Number(r.d);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type SmfChannelEvent =
  | { kind: 'noteOff'; channel: number; note: number; velocity: number }
  | { kind: 'noteOn'; channel: number; note: number; velocity: number }
  | { kind: 'polyPressure'; channel: number; note: number; pressure: number }
  | { kind: 'controlChange'; channel: number; controller: number; value: number }
  | { kind: 'programChange'; channel: number; program: number }
  | { kind: 'channelPressure'; channel: number; pressure: number }
  | { kind: 'pitchBend'; channel: number; value: number };

export type SmfMetaEvent =
  | { kind: 'tempo'; usPerQuarter: number }
  | { kind: 'timeSignature'; numerator: number; denominatorPow: number; clocksPerClick: number; bytesPerBeat: number }
  | { kind: 'sequenceNumber'; value: number }
  | { kind: 'meta'; metaType: number; data: number[] };

export type SmfEvent = SmfChannelEvent | SmfMetaEvent;

/** One event placed on the merged timeline. */
export interface SmfTimedEvent {
  /** Exact absolute time (µs, reduced fraction). */
  readonly time: Rational;
  /** Absolute tick within the originating track. */
  readonly tick: number;
  /** Track index (MTrk order; 0 for format 0). */
  readonly track: number;
  /** Order of appearance within the track (0-based, channel+meta alike). */
  readonly order: number;
  readonly event: SmfEvent;
}

export interface SmfStats {
  readonly tracks: number;
  readonly tracksWithEndOfTrack: number;
  readonly sysexSkipped: number;
  readonly metaIgnored: number;
}

export interface Smf {
  readonly format: 0 | 1 | 2;
  /** Tick division (ppq; the decoder rejects SMPTE divisions). */
  readonly division: number;
  /** Merged events sorted by (time, track, order) — total, deterministic. */
  readonly events: readonly SmfTimedEvent[];
  /** Max end-of-track tick over all tracks. */
  readonly endTick: number;
  /** Max end-of-track time over all tracks (absolute µs). */
  readonly endT: Rational;
  readonly stats: SmfStats;
}

export type SmfErrorCode =
  | 'bad-magic'
  | 'bad-header'
  | 'unsupported-format'
  | 'unsupported-division'
  | 'no-tracks'
  | 'too-many-tracks'
  | 'bad-track-chunk'
  | 'truncated'
  | 'varlen-overrun'
  | 'running-status'
  | 'unknown-status'
  | 'bad-meta'
  | 'bad-tempo'
  | 'bad-timesig'
  | 'bad-seqnum'
  | 'bad-eot';

export class SmfDecodeError extends Error {
  readonly code: SmfErrorCode;
  constructor(code: SmfErrorCode, message: string) {
    super(`smf:${code}: ${message}`);
    this.name = 'SmfDecodeError';
    this.code = code;
  }
}

function fail(code: SmfErrorCode, msg: string): never {
  throw new SmfDecodeError(code, msg);
}

// ---------------------------------------------------------------------------
// Byte reader (bounds-checked; truncation is a typed error, never a hang)
// ---------------------------------------------------------------------------

class Reader {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  u8(what = 'byte'): number {
    const b = this.bytes[this.pos];
    if (b === undefined) fail('truncated', `unexpected EOF reading ${what}`);
    this.pos += 1;
    return b;
  }

  u16(what = 'u16'): number {
    const hi = this.u8(what);
    const lo = this.u8(what);
    return (hi << 8) | lo;
  }

  u32(what = 'u32'): number {
    const b0 = this.u8(what);
    const b1 = this.u8(what);
    const b2 = this.u8(what);
    const b3 = this.u8(what);
    return b0 * 0x1000000 + ((b1 << 16) | (b2 << 8) | b3);
  }

  expectMagic(magic: string): void {
    for (let i = 0; i < magic.length; i++) {
      if (this.u8('magic') !== magic.charCodeAt(i)) {
        fail('bad-magic', `expected "${magic}" at offset ${this.pos - 1}`);
      }
    }
  }
}

/** SMF variable-length quantity ( MIDI 1.0 §1.1 — 128-multiplier, max 4 bytes). */
function readVarLen(r: Reader): number {
  let value = 0;
  for (let i = 0; i < MAX_VARLEN_BYTES; i++) {
    const b = r.u8('varlen');
    value = value * 128 + (b & 0x7f);
    if ((b & 0x80) === 0) return value;
  }
  return fail('varlen-overrun', 'variable-length quantity exceeds 4 bytes');
}

// ---------------------------------------------------------------------------
// Track parsing (tick domain)
// ---------------------------------------------------------------------------

interface TrackEvent {
  tick: number;
  order: number;
  event: SmfEvent;
}

interface RawTrack {
  events: TrackEvent[];
  /** End-of-track tick (implicit: tick of the last event if FF2F missing). */
  endTick: number;
  hasEndOfTrack: boolean;
}

function parseTrack(r: Reader, stats: { sysexSkipped: number; metaIgnored: number }): RawTrack {
  r.expectMagic('MTrk');
  const len = r.u32('track length');
  if (len > r.remaining) fail('truncated', `MTrk declares ${len} bytes, ${r.remaining} remain`);
  // Parse inside a track-local view: crossing the MTrk end is EOF (typed
  // `truncated`), so no event can read into the NEXT chunk's bytes.
  const view = new Reader(r.bytes.subarray(r.pos, r.pos + len));
  r.pos += len;
  return parseTrackBody(view, stats, len);
}

function parseTrackBody(r: Reader, stats: { sysexSkipped: number; metaIgnored: number }, end: number): RawTrack {
  const events: TrackEvent[] = [];
  let tick = 0;
  let running = -1; // running status (survives F0/FF per MIDI 1.0 spec)
  let order = 0;
  let endTick = 0;
  let hasEndOfTrack = false;

  while (r.pos < end) {
    tick += readVarLen(r);
    let status: number;
    const peek = r.u8('status');
    if (peek >= 0x80) {
      status = peek;
      if (status < 0xf0) running = status; // channel voice — becomes running status
    } else if (running >= 0x80) {
      status = running;
      r.pos -= 1; // running-status data byte: rewind, do not consume
    } else {
      fail('running-status', `data byte 0x${peek.toString(16)} before any status byte`);
    }

    if (status >= 0x80 && status <= 0xef) {
      // Channel voice (all 16 channels).
      const channel = status & 0x0f;
      const hi = status >> 4;
      let event: SmfChannelEvent;
      if (hi === 0xc) event = { kind: 'programChange', channel, program: r.u8('param') };
      else if (hi === 0xd) event = { kind: 'channelPressure', channel, pressure: r.u8('param') };
      else if (hi === 0xe) {
        const lsb = r.u8('param');
        const msb = r.u8('param');
        event = { kind: 'pitchBend', channel, value: ((msb << 7) | lsb) & 0x3fff };
      } else {
        const p1 = r.u8('param');
        const p2 = r.u8('param');
        event =
          hi === 0x8
            ? { kind: 'noteOff', channel, note: p1, velocity: p2 }
            : hi === 0x9
              ? { kind: 'noteOn', channel, note: p1, velocity: p2 }
              : hi === 0xa
                ? { kind: 'polyPressure', channel, note: p1, pressure: p2 }
                : { kind: 'controlChange', channel, controller: p1, value: p2 };
      }
      events.push({ tick, order: order++, event });
      continue;
    }

    switch (status) {
      case 0xff: {
        const metaType = r.u8('meta type');
        const mlen = readVarLen(r);
        if (r.pos + mlen > end) fail('truncated', `meta 0x${metaType.toString(16)} body crosses MTrk end`);
        if (metaType === 0x2f) {
          if (mlen !== 0) fail('bad-eot', `end-of-track with ${mlen} payload bytes`);
          endTick = tick;
          hasEndOfTrack = true;
          r.pos += mlen;
          return { events, endTick, hasEndOfTrack };
        }
        if (metaType === 0x51) {
          if (mlen !== 3) fail('bad-tempo', `FF51 length ${mlen} != 3`);
          const us = (r.bytes[r.pos]! << 16) | (r.bytes[r.pos + 1]! << 8) | r.bytes[r.pos + 2]!;
          if (us === 0) fail('bad-tempo', 'tempo of 0 us/quarter');
          r.pos += 3;
          events.push({ tick, order: order++, event: { kind: 'tempo', usPerQuarter: us } });
          break;
        }
        if (metaType === 0x58) {
          if (mlen !== 4 && mlen !== 5) fail('bad-timesig', `FF58 length ${mlen} not in {4,5}`);
          const numerator = r.bytes[r.pos]!;
          const denominatorPow = r.bytes[r.pos + 1]!;
          const clocksPerClick = r.bytes[r.pos + 2]!;
          const bytesPerBeat = mlen === 5 ? r.bytes[r.pos + 4]! : 8;
          r.pos += mlen;
          events.push({
            tick,
            order: order++,
            event: { kind: 'timeSignature', numerator, denominatorPow, clocksPerClick, bytesPerBeat },
          });
          break;
        }
        if (metaType === 0x00) {
          if (mlen !== 2) fail('bad-seqnum', `FF00 length ${mlen} != 2`);
          const value = (r.bytes[r.pos]! << 8) | r.bytes[r.pos + 1]!;
          r.pos += 2;
          events.push({ tick, order: order++, event: { kind: 'sequenceNumber', value } });
          break;
        }
        // Any other meta: consume, count, surface raw (never affects timing).
        const data: number[] = [];
        for (let i = 0; i < mlen; i++) data.push(r.bytes[r.pos + i]!);
        r.pos += mlen;
        stats.metaIgnored += 1;
        events.push({ tick, order: order++, event: { kind: 'meta', metaType, data } });
        break;
      }
      case 0xf0:
      case 0xf7: {
        // Sysex start / escape-dump continuation: length-prefixed skip.
        const slen = readVarLen(r);
        if (r.pos + slen > end) fail('truncated', 'sysex body crosses MTrk end');
        r.pos += slen;
        stats.sysexSkipped += 1;
        break;
      }
      default:
        fail('unknown-status', `illegal status byte 0x${status.toString(16)} in SMF`);
    }
  }

  // No FF2F: implicit end-of-track at the final position (lenient, no error).
  return { events, endTick: tick, hasEndOfTrack };
}

// ---------------------------------------------------------------------------
// Tempo map + tick->seconds conversion (exact rational, global fixed point)
// ---------------------------------------------------------------------------

interface TempoBreak {
  readonly tick: number;
  readonly usPerQuarter: number;
}

interface TempoPosition {
  readonly tick: number;
  readonly track: number;
  readonly order: number;
  readonly usPerQuarter: number;
}

/**
 * Piecewise-linear exact-rational tick->seconds map over the global tick
 * grid. Breakpoints: every FF51 (any track), ordered by (tick, track,
 * order); a same-tick tie is won by the LATER one (file order).
 */
class TempoMap {
  private readonly breaks: TempoBreak[];
  private readonly secAt: Rational[];
  private readonly dDiv: bigint;

  constructor(tempoPositions: readonly TempoPosition[], division: number) {
    this.dDiv = BigInt(division);
    const sorted = [...tempoPositions].sort(
      (a, b) => a.tick - b.tick || a.track - b.track || a.order - b.order,
    );
    this.breaks = [{ tick: 0, usPerQuarter: DEFAULT_US_PER_QUARTER }];
    for (const p of sorted) {
      const last = this.breaks[this.breaks.length - 1]!;
      if (p.tick === last.tick) this.breaks[this.breaks.length - 1] = { tick: p.tick, usPerQuarter: p.usPerQuarter };
      else this.breaks.push({ tick: p.tick, usPerQuarter: p.usPerQuarter });
    }
    const dDiv = this.dDiv;
    this.secAt = [{ n: 0n, d: 1n }];
    for (let k = 1; k < this.breaks.length; k++) {
      const ticks = BigInt(this.breaks[k]!.tick - this.breaks[k - 1]!.tick);
      this.secAt.push(rationalAdd(this.secAt[k - 1]!, rational(ticks * BigInt(this.breaks[k - 1]!.usPerQuarter), dDiv)));
    }
  }

  at(tick: number): Rational {
    let k = 0;
    for (let i = 1; i < this.breaks.length; i++) {
      if (this.breaks[i]!.tick <= tick) k = i;
      else break;
    }
    const b = this.breaks[k]!;
    const seg = this.secAt[k]!;
    if (tick === b.tick) return seg;
    return rationalAdd(seg, rational(BigInt(tick - b.tick) * BigInt(b.usPerQuarter), this.dDiv));
  }
}


// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function decodeSmf(bytes: Uint8Array): Smf {
  const r = new Reader(bytes);
  r.expectMagic('MThd');
  const hlen = r.u32('header length');
  if (hlen < 6) fail('bad-header', `MThd length ${hlen} < 6`);
  if (hlen > 6) {
    if (hlen > r.remaining + 6) fail('truncated', 'header declares more bytes than remain');
    r.pos += hlen - 6; // extra header bytes: consume (SMF spec: ignore)
  }
  const rawFormat = r.u16('format');
  if (rawFormat > 2) fail('unsupported-format', `SMF format ${rawFormat} not supported (0/1/2 only)`);
  const format = rawFormat as 0 | 1 | 2;
  const nTracks = r.u16('nTracks');
  if (nTracks === 0) fail('no-tracks', 'MThd declares 0 tracks');
  if (nTracks > MAX_TRACKS) fail('too-many-tracks', `${nTracks} tracks exceeds ${MAX_TRACKS}`);
  const division = r.u16('division');
  if ((division & 0x8000) !== 0) fail('unsupported-division', 'SMPTE (frames:subframes) division unsupported');
  if (division === 0) fail('bad-header', 'division of 0');

  const stats = { tracks: 0, tracksWithEndOfTrack: 0, sysexSkipped: 0, metaIgnored: 0 };
  const tracks: RawTrack[] = [];
  for (let i = 0; i < nTracks; i++) {
    const tr = parseTrack(r, stats);
    tracks.push(tr);
    if (tr.hasEndOfTrack) stats.tracksWithEndOfTrack += 1;
  }
  stats.tracks = tracks.length;

  // Global tempo map over the shared tick grid, then the merged event list.
  const tempoPositions: TempoPosition[] = [];
  tracks.forEach((tr, i) => {
    for (const ev of tr.events) {
      if (ev.event.kind === 'tempo') tempoPositions.push({ tick: ev.tick, track: i, order: ev.order, usPerQuarter: ev.event.usPerQuarter });
    }
  });
  const map = new TempoMap(tempoPositions, division);

  const events = tracks
    .flatMap((tr, i) => tr.events.map((ev) => ({ time: map.at(ev.tick), tick: ev.tick, track: i, order: ev.order, event: ev.event })))
    .sort((a, b) => rationalCmp(a.time, b.time) || a.track - b.track || a.order - b.order);

  let endTick = 0;
  for (const tr of tracks) endTick = Math.max(endTick, tr.endTick);
  const endT = map.at(endTick);

  return {
    format,
    division,
    events,
    endTick,
    endT,
    stats: { ...stats },
  };
}

/** Deterministic, hash-friendly canonical dump (one line per merged event). */
export function smfCanonical(smf: Smf): string {
  const lines = smf.events.map(
    (e) => `${e.time.n}/${e.time.d}\tt${e.tick}\ttrk${e.track}\t#${e.order}\t${JSON.stringify(e.event)}`,
  );
  lines.push(`END\ttick=${smf.endTick}\tt=${smf.endT.n}/${smf.endT.d}`);
  return lines.join('\n');
}
