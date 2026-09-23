// fixtures/smfBuild.ts — tiny deterministic SMF writer for M10-03 fixtures
// (M10-plan §M10-03: "a tiny deterministic SMF writer (header+tracks+meta)
// for fixtures"). Byte output is fully specified — no library, no RNG.
//
// Encoding rules pinned here (and exercised by smf.test.ts):
//   * Channel events reuse running status when consecutive events in a
//     track share the same status byte (set `fullStatus` to disable).
//   * Every track gets a trailing FF2F end-of-track with delta 0 unless one
//     is present in the spec; deltas are MIDI variable-length quantities.
//
// SPDX-License-Identifier: GPL-2.0-or-later

export type BuildEvent =
  | { delta: number; type: 'noteOn'; channel: number; note: number; velocity: number }
  | { delta: number; type: 'noteOff'; channel: number; note: number; velocity: number }
  | { delta: number; type: 'cc'; channel: number; controller: number; value: number }
  | { delta: number; type: 'program'; channel: number; program: number }
  | { delta: number; type: 'pitchBend'; channel: number; value: number }
  | { delta: number; type: 'pressure'; channel: number; note: number; value: number }
  | { delta: number; type: 'chanPressure'; channel: number; value: number }
  | { delta: number; type: 'tempo'; usPerQuarter: number }
  | { delta: number; type: 'timeSignature'; numerator: number; denominatorPow: number; clocksPerClick?: number; bytesPerBeat?: number }
  | { delta: number; type: 'seqNum'; value: number }
  | { delta: number; type: 'meta'; metaType: number; data: number[] }
  | { delta: number; type: 'sysex'; data: number[] }
  | { delta: number; type: 'eot' };

export interface SmfBuildSpec {
  format: 0 | 1 | 2;
  division: number;
  tracks: BuildEvent[][];
  /** Emit full status bytes instead of running status. */
  fullStatus?: boolean;
  /** Suppress the automatic trailing FF2F (for implicit-EOT fixtures). */
  noAutoEot?: boolean;
}

function pushVarLen(out: number[], value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fffffff) {
    throw new RangeError(`smfBuild: delta ${value} outside varlen range`);
  }
  const bytes = [value & 0x7f, (value >>> 7) & 0x7f, (value >>> 14) & 0x7f, (value >>> 21) & 0x7f];
  let i = 3;
  while (i > 0 && bytes[i] === 0) i--;
  for (; i > 0; i--) out.push(bytes[i]! | 0x80);
  out.push(bytes[0]!);
}

function push32(out: number[], v: number): void {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

function push16(out: number[], v: number): void {
  out.push((v >>> 8) & 0xff, v & 0xff);
}

function magic(out: number[], s: string): void {
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
}

function statusByte(e: BuildEvent): number {
  switch (e.type) {
    case 'noteOff':
      return 0x80 | e.channel;
    case 'noteOn':
      return 0x90 | e.channel;
    case 'pressure':
      return 0xa0 | e.channel;
    case 'cc':
      return 0xb0 | e.channel;
    case 'program':
      return 0xc0 | e.channel;
    case 'chanPressure':
      return 0xd0 | e.channel;
    case 'pitchBend':
      return 0xe0 | e.channel;
    default:
      return -1;
  }
}

/** Encode one track's events into bytes (excluding the MTrk header). */
function buildTrackBody(events: BuildEvent[], fullStatus: boolean, autoEot: boolean): number[] {
  const body: number[] = [];
  let running = -1;
  const list: BuildEvent[] = [...events];
  if (autoEot && !list.some((e) => e.type === 'eot')) list.push({ delta: 0, type: 'eot' });
  for (const e of list) {
    pushVarLen(body, e.delta);
    const st = statusByte(e);
    if (st >= 0) {
      if (fullStatus || st !== running) body.push(st);
      running = st;
      switch (e.type) {
        case 'noteOff':
        case 'noteOn':
          body.push(e.note, e.velocity);
          break;
        case 'pressure':
          body.push(e.note, e.value);
          break;
        case 'cc':
          body.push(e.controller, e.value);
          break;
        case 'pitchBend':
          body.push(e.value & 0x7f, (e.value >>> 7) & 0x7f);
          break;
        case 'program':
        case 'chanPressure':
          body.push('program' in e ? e.program : e.value);
          break;
      }
      continue;
    }
    switch (e.type) {
      case 'tempo':
        body.push(0xff, 0x51, 0x03, (e.usPerQuarter >> 16) & 0xff, (e.usPerQuarter >> 8) & 0xff, e.usPerQuarter & 0xff);
        break;
      case 'timeSignature':
        body.push(0xff, 0x58, 0x04, e.numerator, e.denominatorPow, e.clocksPerClick ?? 24, e.bytesPerBeat ?? 8);
        break;
      case 'seqNum':
        body.push(0xff, 0x00, 0x02, (e.value >> 8) & 0xff, e.value & 0xff);
        break;
      case 'meta':
        body.push(0xff, e.metaType);
        pushVarLen(body, e.data.length);
        body.push(...e.data.map((b) => b & 0xff));
        break;
      case 'sysex': {
        // F0 <len> data+F7  (len counts the terminator).
        const data = e.data.length > 0 && e.data[e.data.length - 1] === 0xf7 ? e.data : [...e.data, 0xf7];
        body.push(0xf0);
        pushVarLen(body, data.length);
        body.push(...data.map((b) => b & 0xff));
        break;
      }
      case 'eot':
        body.push(0xff, 0x2f, 0x00);
        break;
    }
  }
  return body;
}

/** Build a complete SMF file from a spec. */
export function buildSmf(spec: SmfBuildSpec): Uint8Array {
  const out: number[] = [];
  magic(out, 'MThd');
  push32(out, 6);
  push16(out, spec.format);
  push16(out, spec.tracks.length);
  push16(out, spec.division);
  for (const track of spec.tracks) {
    const body = buildTrackBody(track, spec.fullStatus ?? false, !(spec.noAutoEot ?? false));
    magic(out, 'MTrk');
    push32(out, body.length);
    out.push(...body);
  }
  return Uint8Array.from(out);
}
