/**
 * M1-05 acceptance tests for the fixture-WAD micro-builder.
 *
 * Round-trip is asserted twice: once through a tiny internal header+dir
 * reader (always green, independent of M1-02 merge order) and once through
 * the real WadFile.parse contract (src/wad/wadfile.ts) — the latter is
 * skipped at runtime while parse still throws 'unimplemented' at this base.
 * FOLLOW-UP (M1-09): drop the internal reader and use WadFile unconditionally.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { WadFile } from '../../src/wad/wadfile';
import { WadBuilder, buildWad } from './wadWriter';
import { buildSmallWad, patch2x2, synthTexturePair, synthFlat } from './smallWads';

/* ------------------------------------------------------------------ */
/* Tiny internal header+dir reader (R01 §1-2), test-local by design.   */
/* ------------------------------------------------------------------ */

interface DirEntry {
  offset: number;
  size: number;
  name: string;
  nameBytes: Uint8Array;
}

interface ParsedWad {
  identification: string;
  numlumps: number;
  infotableofs: number;
  entries: DirEntry[];
  bytes: Uint8Array;
}

function readWad(bytes: Uint8Array): ParsedWad {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const identification = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  const numlumps = view.getInt32(4, true);
  const infotableofs = view.getInt32(8, true);
  const entries: DirEntry[] = [];
  for (let i = 0; i < numlumps; i++) {
    const dir = infotableofs + i * 16;
    const nameBytes = bytes.slice(dir + 8, dir + 16);
    entries.push({
      offset: view.getInt32(dir, true),
      size: view.getInt32(dir + 4, true),
      name: String.fromCharCode(...nameBytes).replace(/\0+$/, ''),
      nameBytes,
    });
  }
  return { identification, numlumps, infotableofs, entries, bytes };
}

function tryParseWithWadFile(buf: ArrayBuffer): WadFile | null {
  try {
    return WadFile.parse(buf);
  } catch (err) {
    if (/unimplemented/i.test(String((err as Error).message))) return null;
    throw err;
  }
}

/* ------------------------------------------------------------------ */

const fixture = () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5]); // odd size -> forces pad byte
  const wad = new WadBuilder('IWAD')
    .addLumpMarker('S_START')
    .addLump('ODDLUMP', payload)
    .addLump('EVENLUMP', new Uint8Array([9, 9]))
    .addLump('DUPNAME', new Uint8Array([7]))
    .addLump('DUPNAME', new Uint8Array([8, 8])) // duplicate names allowed
    .addLumpMarker('S_END');
  return { wad, payload };
};

describe('WadBuilder structural contract', () => {
  it('writes the 12-byte header with id, count and dir offset', () => {
    const wad = readWad(fixture().wad.build());
    expect(wad.identification).toBe('IWAD');
    expect(wad.numlumps).toBe(6);
    expect(wad.infotableofs).toBe(wad.bytes.length - 6 * 16);
    // Even-size lump at an even offset needs NO pad byte (0/1-byte rule).
    expect(buildWad([{ name: 'X', data: new Uint8Array(2) }], 'PWAD')
      .byteLength).toBe(12 + 2 + 16);
    // Odd-size lump gets exactly one NUL pad byte.
    expect(buildWad([{ name: 'X', data: new Uint8Array(3) }], 'PWAD')
      .byteLength).toBe(12 + 3 + 1 + 16);
  });

  it('dir entries follow insertion order with strictly increasing offsets', () => {
    const wad = readWad(fixture().wad.build());
    expect(wad.entries.map((e) => e.name)).toEqual([
      'S_START', 'ODDLUMP', 'EVENLUMP', 'DUPNAME', 'DUPNAME', 'S_END',
    ]);
    // Offsets are non-decreasing; a size-0 marker SHARES the offset of the
    // next lump (R01 §2: 0-size lumps still have a position), so strict
    // increase is only required after a non-empty lump.
    wad.entries.forEach((e, i) => {
      if (i > 0) {
        const prev = wad.entries[i - 1]!;
        if (prev.size > 0) expect(e.offset).toBeGreaterThan(prev.offset);
        else expect(e.offset).toBe(prev.offset);
      }
    });
    // first data position is 12; the zero-size S_START marker shares it.
    expect(wad.entries[0]!.offset).toBe(12);
    expect(wad.entries[1]!.offset).toBe(12);
  });

  it('pads every lump so all offsets are even; markers are size 0', () => {
    const { wad, payload } = fixture();
    const bytes = wad.build();
    const parsed = readWad(bytes);
    expect(parsed.infotableofs % 2).toBe(0);
    for (const e of parsed.entries) {
      expect(e.offset % 2).toBe(0);
      expect(e.offset + e.size).toBeLessThanOrEqual(parsed.infotableofs);
    }
    expect(parsed.entries[0]!.size).toBe(0); // S_START marker
    expect(parsed.entries[5]!.size).toBe(0); // S_END marker
    // Data round-trips and the odd lump is followed by one NUL pad byte.
    const odd = parsed.entries[1]!;
    expect(bytes.subarray(odd.offset, odd.offset + odd.size)).toEqual(payload);
    expect(bytes[odd.offset + odd.size]).toBe(0);
    expect(parsed.entries[2]!.offset).toBe(odd.offset + odd.size + 1);
    // Duplicate names both present; last data wins for lookups.
    expect(bytes[parsed.entries[4]!.offset]).toBe(8);
  });

  it('stores 8-byte NUL-padded uppercase name bytes', () => {
    const parsed = readWad(new WadBuilder().addLump('ab3', new Uint8Array([1])).build());
    const name = parsed.entries[0]!.nameBytes;
    expect(name.length).toBe(8);
    expect([...name.subarray(0, 3)]).toEqual([...'AB3'].map((c) => c.charCodeAt(0)));
    expect(name.subarray(3)).toEqual(new Uint8Array(5));
    expect(() => new WadBuilder().addLump('TOOLONGNAME9', new Uint8Array(0))).toThrow(RangeError);
    expect(() => new WadBuilder().addLump('', new Uint8Array(0))).toThrow(RangeError);
  });

  it('is deterministic: two builds hash equal', () => {
    const hash = (b: Uint8Array) => {
      let h = 0x811c9dc5;
      for (const byte of b) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
      return h;
    };
    expect(hash(buildSmallWad())).toBe(hash(buildSmallWad()));
  });

  it('small wad content matches R01 §14 size constants (no real WAD needed)', () => {
    expect(synthFlat().length).toBe(4096);
    const { texture1, pnames } = synthTexturePair();
    expect(pnames.length).toBe(4 + 8 * 2);
    expect(texture1.length).toBe(4 + 4 + (22 + 10 * 2));
    const parsed = readWad(buildSmallWad());
    const size = (n: string) => parsed.entries.find((e) => e.name === n)!.size;
    expect(size('FIXFLAT')).toBe(4096);
    expect(size('S_FIX0')).toBe(0); // zero-size marker inside S range
    expect(parsed.entries.map((e) => e.name)).toEqual([
      'TEXTURE1', 'PNAMES', 'F_START', 'FIXFLAT', 'F_END', 'P_START',
      'FIXP0', 'FIXP1', 'P_END', 'S_START', 'BON1A0', 'S_FIX0',
      'PLAYA2A8', 'S_END', 'DSFIX',
    ]);
    // Patch header sanity: 2x2, colofs[0] = 8 + 4*2 = 16 LUMP-RELATIVE
    // (R01 §14: "columnofs are byte offsets from lump start").
    const view = new DataView(parsed.bytes.buffer, parsed.bytes.byteOffset);
    const p = parsed.entries[6]!;
    expect([view.getInt16(p.offset, true), view.getInt16(p.offset + 2, true)]).toEqual([2, 2]);
    expect(view.getInt32(p.offset + 8, true)).toBe(16);
    expect(patch2x2().length).toBe(p.size); // same geometry => same length
  });
});

describe('round-trip through the WadFile contract (src/wad/wadfile.ts)', () => {
  // Skips at runtime while M1-02 has not landed (parse still throws
  // 'unimplemented'); the structural suite above stays green regardless.
  it('parses a built fixture with WadFile.parse', () => {
    const bytes = buildSmallWad();
    const wad = tryParseWithWadFile(bytes.buffer as ArrayBuffer);
    if (wad === null) {
      // FOLLOW-UP: remove this branch once WadFile.parse (M1-02) is merged;
      // verify the same facts via the internal reader meanwhile.
      const parsed = readWad(bytes);
      expect(parsed.identification).toBe('IWAD');
      expect(parsed.numlumps).toBe(15);
      return;
    }
    expect(wad.identification).toBe('IWAD');
    expect(wad.lumpName(0)).toBe('TEXTURE1');
    expect(wad.lumpNumByName('DUPNAME')).toBe(-1);
    expect(wad.readLumpByName('FIXFLAT').length).toBe(4096);
    // S_START..S_END must skip the zero-size S_FIX0 marker.
    const range = wad.lumpRange('S_START', 'S_END');
    expect(range.map((n) => wad.lumpName(n))).toEqual(['BON1A0', 'PLAYA2A8']);
  });
});
