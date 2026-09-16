/**
 * M1-09 — fixture↔parser round-trip: everything `WadBuilder`/`buildWad`
 * (M1-05) emits must be re-read identically by the real `WadFile.parse`
 * contract (M1-02). This is the "final integration" M1-05 deferred here:
 * names, directory offsets/ranges, zero-size marker skipping in
 * `lumpRange`, nested + repeated markers, duplicate (last-wins) names,
 * even-offset padding, and the zero-copy `readLump` aliasing guarantee.
 *
 * Independent raw-dir reader below double-checks the bytes themselves, so a
 * bug shared by builder and parser cannot hide (unlike wadWriter.test.ts's
 * pre-M1-02 internal reader, this one only validates the directory).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { WadFile } from '../../src/wad/wadfile';
import { buildWad, WadBuilder } from './wadWriter';
import { buildSmallWad, patch2x2, synthBytes, synthFlat } from './smallWads';

/* ------------------------------------------------------------------ */
/* Test-local raw directory reader (R01 §1-2)                          */
/* ------------------------------------------------------------------ */

interface DirRow {
  offset: number;
  size: number;
  name: string;
}

function readDir(buf: ArrayBuffer): { ident: string; numLumps: number; dirOfs: number; rows: DirRow[] } {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const ident = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  const numLumps = view.getInt32(4, true);
  const dirOfs = view.getInt32(8, true);
  const rows: DirRow[] = [];
  for (let i = 0; i < numLumps; i++) {
    const at = dirOfs + i * 16;
    let name = '';
    for (let c = 0; c < 8; c++) {
      const ch = bytes[at + 8 + c]!;
      if (ch !== 0) name += String.fromCharCode(ch);
    }
    rows.push({ offset: view.getInt32(at, true), size: view.getInt32(at + 4, true), name });
  }
  return { ident, numLumps, dirOfs, rows };
}

/* ------------------------------------------------------------------ */
/* Round-trip goldens                                                  */
/* ------------------------------------------------------------------ */

describe('buildWad → WadFile.parse round-trip', () => {
  it('header and per-lump directory fields agree index-by-index', () => {
    const payload = [
      { name: 'TEXTURE1', data: synthBytes(1234, 1) }, // odd size → padding
      { name: 'PNAMES', data: synthBytes(60, 2) },
      { name: 'F_START' }, // zero-size markers
      { name: 'FIXFLAT', data: synthFlat() },
      { name: 'EVEN', data: synthBytes(4, 3) },
      { name: 'F_END' },
      { name: 'ODD2', data: synthBytes(1, 4) },
    ];
    const buf = buildWad(payload, 'PWAD');
    const raw = readDir(buf);
    const wad = WadFile.parse(buf);

    expect(wad.identification).toBe('PWAD');
    expect(raw.ident).toBe('PWAD');
    expect(raw.numLumps).toBe(payload.length);
    expect(raw.dirOfs).toBe(buf.byteLength - payload.length * 16);

    for (let i = 0; i < payload.length; i++) {
      const row = raw.rows[i]!;
      const wanted = payload[i]!;
      expect(wad.lumpName(i), `name at #${i}`).toBe(wanted.name);
      expect(row.name, `raw dir name at #${i}`).toBe(wanted.name);
      const bytes = wad.readLump(i);
      expect(bytes.byteLength, `size at #${i}`).toBe(row.size);
      expect(bytes.byteLength).toBe(wanted.data?.length ?? 0);
      expect(bytes.byteOffset, `filepos alias at #${i}`).toBe(row.offset);
      expect(row.offset % 2, `dir offset at #${i} is even`).toBe(0);
      if (wanted.data) expect(Array.from(bytes)).toEqual(Array.from(wanted.data));
      else expect(bytes.byteLength).toBe(0);
    }
  });

  it('names round-trip trimmed, uppercased and case-insensitively', () => {
    const buf = buildWad([
      { name: 'lower', data: synthBytes(8, 5) }, // builder uppercases
      { name: 'A-B_C.9', data: synthBytes(2, 6) }, // 8-char raw name
      { name: 'Xy' },
    ]);
    const wad = WadFile.parse(buf);
    expect(wad.lumpName(0)).toBe('LOWER');
    expect(wad.lumpNumByName('lower')).toBe(0);
    expect(wad.lumpNumByName('LOWER')).toBe(0);
    expect(wad.has('a-b_c.9')).toBe(true);
    expect(wad.lumpNumByName('XY')).toBe(2); // zero-size marker is still findable
    expect(wad.lumpNumByName('NOPE')).toBe(-1);
  });

  it('duplicate names: last match wins, earlier copies readable by index', () => {
    const first = synthBytes(10, 0x11);
    const last = synthBytes(10, 0x22);
    const buf = buildWad([
      { name: 'S_START' },
      { name: 'DUP', data: first },
      { name: 'OTHER', data: synthBytes(3, 0x33) },
      { name: 'DUP', data: last },
      { name: 'S_END' },
    ]);
    const wad = WadFile.parse(buf);
    expect(wad.lumpNumByName('DUP')).toBe(3); // last definition (R01 §15.2)
    expect(Array.from(wad.readLumpByName('DUP'))).toEqual(Array.from(last));
    expect(Array.from(wad.readLump(1))).toEqual(Array.from(first)); // by index
    expect(wad.lumpRange('S_START', 'S_END')).toEqual([1, 2, 3]); // dup included
  });

  it('lumpRange skips zero-size markers across nested marker ladders', () => {
    const buf = buildWad([
      { name: 'P_START' },
      { name: 'P1_START' }, // nested markers (freedoom tooling style)
      { name: 'WALL00_1', data: patch2x2(1) },
      { name: 'P1_MID', data: new Uint8Array(0) }, // zero-size non-marker
      { name: 'WALL00_2', data: patch2x2(2) },
      { name: 'P1_END' },
      { name: 'P2_START' },
      { name: 'WALL00_3', data: patch2x2(3) },
      { name: 'P2_END' },
      { name: 'P_END' },
      { name: 'OUTSIDE', data: patch2x2(4) },
    ]);
    const wad = WadFile.parse(buf);
    const names = (nums: number[]) => nums.map((n) => wad.lumpName(n));
    expect(names(wad.lumpRange('P_START', 'P_END'))).toEqual(['WALL00_1', 'WALL00_2', 'WALL00_3']);
    expect(names(wad.lumpRange('P1_START', 'P1_END'))).toEqual(['WALL00_1', 'WALL00_2']);
    expect(names(wad.lumpRange('P2_START', 'P_END'))).toEqual(['WALL00_3']); // EOF/end fallback
    expect(wad.lumpRange('NO_START', 'NO_END')).toEqual([]); // absent marker → []
  });

  it('repeated start markers: lookup is last-wins, range stops at first end', () => {
    const buf = buildWad([
      { name: 'S_START' }, // first (shadowed) range…
      { name: 'OLD1', data: patch2x2(9) },
      { name: 'S_END' },
      { name: 'S_START' }, // …and the real, last-defined one
      { name: 'NEW1', data: patch2x2(8) },
      { name: 'S_FIX0' }, // zero-size marker inside the live range
      { name: 'NEW2', data: patch2x2(7) },
      { name: 'S_END' },
    ]);
    const wad = WadFile.parse(buf);
    expect(wad.lumpNumByName('S_START')).toBe(3); // last-wins start marker
    const names = wad.lumpRange('S_START', 'S_END').map((n) => wad.lumpName(n));
    expect(names).toEqual(['NEW1', 'NEW2']); // marker skipped, first S_END stops
  });

  it('readLump aliases the source buffer (zero copy)', () => {
    const buf = buildWad([{ name: 'DATA', data: synthBytes(6, 0xaa) }]);
    const wad = WadFile.parse(buf);
    const view = new Uint8Array(buf);
    const filepos = readDir(buf).rows[0]!.offset;
    view[filepos] = 0xab; // poke the SOURCE buffer…
    expect(wad.readLump(0)[0]).toBe(0xab); // …visible through readLump
    expect(wad.readLumpByName('DATA').byteOffset).toBe(filepos);
  });

  it('odd-size lumps survive the even-offset NUL padding unharmed', () => {
    const datas = [synthBytes(7, 1), synthBytes(15, 2), synthBytes(33, 3), synthBytes(1, 4)];
    const buf = buildWad(datas.map((d, i) => ({ name: `L${i}`, data: d })));
    const wad = WadFile.parse(buf);
    datas.forEach((d, i) => {
      expect(Array.from(wad.readLump(i)), `lump ${i} bytes`).toEqual(Array.from(d));
    });
    for (const row of readDir(buf).rows) expect(row.offset % 2).toBe(0);
  });

  it('the standard buildSmallWad fixture maps exactly as declared', () => {
    const wad = WadFile.parse(buildSmallWad().buffer as ArrayBuffer);
    expect(wad.identification).toBe('IWAD');
    const expectedNames = [
      'TEXTURE1', 'PNAMES', 'F_START', 'FIXFLAT', 'F_END',
      'P_START', 'FIXP0', 'FIXP1', 'P_END',
      'S_START', 'BON1A0', 'S_FIX0', 'PLAYA2A8', 'S_END', 'DSFIX',
    ];
    expect(expectedNames.map((_, i) => wad.lumpName(i))).toEqual(expectedNames);
    expect(wad.lumpRange('F_START', 'F_END')).toEqual([3]);
    expect(wad.lumpRange('P_START', 'P_END')).toEqual([6, 7]);
    expect(wad.lumpRange('S_START', 'S_END')).toEqual([10, 12]); // S_FIX0 skipped
    expect(wad.readLumpByName('FIXFLAT').byteLength).toBe(4096);
    expect(wad.readLumpByName('DSFIX').byteLength).toBe(37);
    expect(wad.lumpInfo(6)).toEqual({ name: 'FIXP0', lumpnum: 6 });
  });

  it('boundary accessors and errors behave on the built file', () => {
    const buf = buildWad([{ name: 'ONE', data: synthBytes(2, 7) }], 'IWAD');
    const wad = WadFile.parse(buf);
    expect(wad.lumpNumAt(0)).toBe(0);
    expect(wad.lumpNumAt(-1)).toBe(-1);
    expect(wad.lumpNumAt(1)).toBe(-1);
    expect(() => wad.readLump(1)).toThrow(RangeError);
    expect(() => wad.readLumpByName('MISSING')).toThrow(/unknown lump/);
  });

  it('building the same lumps twice yields byte-identical, identically-parsing WADs', () => {
    const lumps = [
      { name: 'A', data: synthBytes(5, 1) },
      { name: 'S_START' },
      { name: 'B', data: patch2x2(2) },
      { name: 'S_END' },
    ];
    const buf1 = buildWad(lumps);
    const buf2 = buildWad(lumps);
    expect(new Uint8Array(buf2)).toEqual(new Uint8Array(buf1));
    const w1 = WadFile.parse(buf1);
    const w2 = WadFile.parse(buf2);
    for (let i = 0; i < 4; i++) {
      expect(w2.lumpName(i)).toBe(w1.lumpName(i));
      expect(w2.readLump(i).byteOffset).toBe(w1.readLump(i).byteOffset);
    }
  });

  it('WadBuilder class API round-trips with insertion-order markers', () => {
    const w = new WadBuilder('PWAD');
    w.addLumpMarker('MARK1');
    w.addLump('MARK1', new Uint8Array(3)); // same name as the marker: dup data later
    w.addLumpMarker('MARK2');
    const buf = w.build().buffer as ArrayBuffer;
    const wad = WadFile.parse(buf);
    expect(wad.identification).toBe('PWAD');
    expect(wad.lumpNumByName('MARK1')).toBe(1); // last-wins even marker→data
    expect(wad.readLump(1).byteLength).toBe(3);
    expect(wad.readLump(0).byteLength).toBe(0);
    expect(wad.lumpName(2)).toBe('MARK2');
  });
});
