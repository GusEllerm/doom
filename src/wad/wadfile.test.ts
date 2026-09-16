/**
 * WadFile unit tests (M1-02) — handcrafted byte vectors only, no real WAD
 * files (none in-repo per T01; integration goldens arrive in M1-09).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { WadFile, WadParseError } from './wadfile';

interface LumpSpec {
  name: string;
  /** Absent = zero-size marker lump. */
  data?: Uint8Array;
}

const HEADER_SIZE = 12;
const DIR_ENTRY_SIZE = 16;

function ascii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 8-byte padded entry name (NUL for freedoom, space for older tools, R01 §2). */
function nameBytes(name: string, pad: 0x00 | 0x20): number[] {
  const out = new Array<number>(8).fill(pad);
  for (let i = 0; i < Math.min(8, name.length); i++) {
    out[i] = name.charCodeAt(i);
  }
  return out;
}

/** Minimal valid WAD: 12-byte header, packed lump data, dir at EOF. */
function buildWad(
  lumps: LumpSpec[],
  identification: 'IWAD' | 'PWAD' = 'IWAD',
  pad: 0x00 | 0x20 = 0x00,
): ArrayBuffer {
  const offsets: number[] = [];
  let pos = HEADER_SIZE;
  for (const lump of lumps) {
    offsets.push(pos);
    pos += lump.data?.byteLength ?? 0;
  }
  const dirOfs = pos;
  const buf = new ArrayBuffer(dirOfs + lumps.length * DIR_ENTRY_SIZE);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < 4; i++) bytes[i] = identification.charCodeAt(i);
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, dirOfs, true);
  lumps.forEach((lump, i) => {
    if (lump.data !== undefined) {
      bytes.set(lump.data, offsets[i]!);
    }
    const ofs = dirOfs + i * DIR_ENTRY_SIZE;
    view.setInt32(ofs, offsets[i]!, true);
    view.setInt32(ofs + 4, lump.data?.byteLength ?? 0, true);
    nameBytes(lump.name, pad).forEach((b, c) => {
      bytes[ofs + 8 + c] = b;
    });
  });
  return buf;
}

describe('WadFile.parse — header', () => {
  it('accepts both IWAD and PWAD identifications', () => {
    const iwad = WadFile.parse(buildWad([{ name: 'PLAYPAL', data: ascii('x') }], 'IWAD'));
    const pwad = WadFile.parse(buildWad([{ name: 'PLAYPAL', data: ascii('x') }], 'PWAD'));
    expect(iwad.identification).toBe('IWAD');
    expect(pwad.identification).toBe('PWAD');
    expect(iwad.has('PLAYPAL')).toBe(true);
    expect(pwad.has('PLAYPAL')).toBe(true);
  });

  it('throws WadParseError on a bad identification', () => {
    const buf = buildWad([{ name: 'PLAYPAL', data: ascii('x') }]);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < 4; i++) bytes[i] = 'JOED'.charCodeAt(i);
    expect(() => WadFile.parse(buf)).toThrow(WadParseError);
    expect(() => WadFile.parse(buf)).toThrow(/IWAD\/PWAD/);
  });

  it('throws WadParseError when the dir offset is past EOF', () => {
    const buf = buildWad([{ name: 'PLAYPAL', data: ascii('x') }]);
    new DataView(buf).setInt32(8, buf.byteLength + 100, true);
    expect(() => WadFile.parse(buf)).toThrow(WadParseError);
    expect(() => WadFile.parse(buf)).toThrow(/past EOF/);
  });

  it('throws WadParseError on truncated directory entries', () => {
    const buf = buildWad([{ name: 'PLAYPAL', data: ascii('x') }]);
    new DataView(buf).setInt32(4, 100_000, true); // dir of 100k entries past EOF
    expect(() => WadFile.parse(buf)).toThrow(WadParseError);
  });

  it('throws WadParseError when a lump data range is truncated past EOF', () => {
    const buf = buildWad([{ name: 'PLAYPAL', data: ascii('x') }]);
    const dirOfs = 12 + 1;
    new DataView(buf).setInt32(dirOfs + 4, 9999, true); // entry 0 size past EOF
    expect(() => WadFile.parse(buf)).toThrow(WadParseError);
  });
});

describe('WadFile — name handling (R01 §15.2)', () => {
  it('trims trailing NUL padding from entry names', () => {
    const wad = WadFile.parse(buildWad([{ name: 'E1M1', data: ascii('m') }], 'IWAD', 0x00));
    expect(wad.lumpName(0)).toBe('E1M1');
    expect(wad.lumpNumByName('E1M1')).toBe(0);
  });

  it('trims trailing SPACE padding from entry names', () => {
    const wad = WadFile.parse(
      buildWad(
        [
          { name: 'E1M1', data: ascii('m') }, // space-padded dir name 'E1M1    '
          { name: 'PLAYPAL' },
        ],
        'IWAD',
        0x20,
      ),
    );
    expect(wad.lumpName(0)).toBe('E1M1');
    expect(wad.lumpNumByName('E1M1')).toBe(0);
    expect(wad.lumpName(1)).toBe('PLAYPAL');
  });

  it('looks up case-insensitively, tolerating padded queries', () => {
    const wad = WadFile.parse(buildWad([{ name: 'PLAYPAL', data: ascii('p') }]));
    expect(wad.lumpNumByName('playpal')).toBe(0);
    expect(wad.lumpNumByName('PlAyPaL')).toBe(0);
    expect(wad.lumpNumByName('PLAYPAL\u0000\u0000')).toBe(0);
    expect(wad.has('pLaYpAl')).toBe(true);
    expect(wad.lumpNumByName('MISSING')).toBe(-1);
    expect(wad.has('MISSING')).toBe(false);
  });

  it('resolves duplicate names last-match-wins', () => {
    const wad = WadFile.parse(
      buildWad([
        { name: 'SWITCH', data: ascii('first') },
        { name: 'BODY', data: ascii('old') },
        { name: 'SWITCH', data: ascii('second') },
      ]),
    );
    expect(wad.lumpNumByName('SWITCH')).toBe(2);
    expect(Array.from(wad.readLumpByName('switch'))).toEqual(Array.from(ascii('second')));
    expect(wad.lumpInfo(2)).toEqual({ name: 'SWITCH', lumpnum: 2 });
  });
});

describe('WadFile — indexed access', () => {
  it('lumpNumAt round-trips within the dir and yields -1 outside', () => {
    const wad = WadFile.parse(
      buildWad([
        { name: 'A', data: ascii('a') },
        { name: 'B', data: ascii('b') },
      ]),
    );
    expect(wad.lumpNumAt(0)).toBe(0);
    expect(wad.lumpNumAt(1)).toBe(1);
    expect(wad.lumpName(wad.lumpNumAt(1))).toBe('B');
    expect(wad.lumpNumAt(-1)).toBe(-1);
    expect(wad.lumpNumAt(2)).toBe(-1);
  });

  it('rejects out-of-range lump numbers and unknown names on read', () => {
    const wad = WadFile.parse(buildWad([{ name: 'A', data: ascii('a') }]));
    expect(() => wad.readLump(1)).toThrow(RangeError);
    expect(() => wad.lumpName(-1)).toThrow(RangeError);
    expect(() => wad.lumpInfo(5)).toThrow(RangeError);
    expect(() => wad.readLumpByName('NOPE')).toThrow(RangeError);
  });
});

describe('WadFile.readLump — zero-copy', () => {
  it('aliases the source buffer with exact byteOffset semantics', () => {
    const buf = buildWad([
      { name: 'E1M1' }, // zero-size marker at offset 12 (R01 §15.10)
      { name: 'THINGS', data: ascii('abcd') }, // also at 12: shares the position
      { name: 'LINEDEFS', data: ascii('xy') },
    ]);
    const source = new Uint8Array(buf);
    const wad = WadFile.parse(buf);

    const lump = wad.readLump(1);
    expect(lump.buffer).toBe(buf); // same ArrayBuffer — no copy
    expect(lump.byteOffset).toBe(12); // filepos, not 0
    expect(lump.byteLength).toBe(4);
    expect(Array.from(lump)).toEqual(Array.from(ascii('abcd')));

    lump[0] = 0xff; // write through the view...
    expect(source[12]).toBe(0xff); // ...is visible in the source buffer

    expect(wad.readLump(2).byteOffset).toBe(16);
    expect(wad.readLump(0).byteLength).toBe(0); // marker reads as empty view
  });
});

describe('WadFile.lumpRange — marker scan (R12 §9.7)', () => {
  const vector = (): WadFile =>
    WadFile.parse(
      buildWad([
        { name: 'PLAYPAL', data: ascii('p') },
        { name: 'S_START' },
        { name: 'PLAYA1', data: ascii('a1') },
        { name: 'P1_START' }, // nested zero-size marker inside the range
        { name: 'PLAYA2', data: ascii('a2') },
        { name: 'P1_END' }, // nested zero-size marker inside the range
        { name: 'PLAYA3', data: ascii('a3') },
        { name: 'S_END' },
        { name: 'TEXTURE1', data: ascii('t') },
        { name: 'F_START' },
        { name: 'FLOOR0', data: ascii('f') },
        { name: 'F_END' },
      ]),
    );

  it('collects data lumps between markers, skipping zero-size markers', () => {
    const wad = vector();
    const sprites = wad.lumpRange('S_START', 'S_END');
    expect(sprites).toEqual([2, 4, 6]);
    expect(sprites.map((n) => wad.lumpName(n))).toEqual(['PLAYA1', 'PLAYA2', 'PLAYA3']);
  });

  it('stops at the first end marker even when names repeat later', () => {
    const wad = vector();
    expect(wad.lumpRange('F_START', 'F_END')).toEqual([10]);
    expect(wad.lumpRange('s_start', 's_end')).toEqual([2, 4, 6]); // case-insensitive
  });

  it('returns [] when the start marker is absent', () => {
    expect(vector().lumpRange('NOPE', 'S_END')).toEqual([]);
  });
});
