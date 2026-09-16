/**
 * Unit tests for the viewer's pure helpers (M1-08 acceptance 4): lump
 * classification, patch-header sanity, paging, filtering, hex formatting.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';
import {
  buildRows,
  classifyLump,
  filterRows,
  hexDump,
  looksLikeFlatName,
  looksLikePatchHeader,
  pageSlice,
} from './classify';

describe('classifyLump', () => {
  it('treats zero-size entries as markers', () => {
    expect(classifyLump('S_START', 0)).toBe('marker');
    expect(classifyLump('PLAYPAL', 0)).toBe('marker');
  });

  it('classifies 4096-byte lumps as flat candidates', () => {
    expect(classifyLump('FLAT14', 4096)).toBe('flat');
    expect(classifyLump('F_SKY1', 4096)).toBe('flat');
    expect(classifyLump('WATER1', 4096)).toBe('flat');
  });

  it('classifies everything else as data', () => {
    expect(classifyLump('E1M1', 123456)).toBe('data');
    expect(classifyLump('SPOUSE1', 1024)).toBe('data');
    expect(classifyLump('PLAYPAL', 10752)).toBe('data');
  });
});

describe('looksLikeFlatName', () => {
  it('accepts F-prefixed vanilla flat names', () => {
    for (const n of ['FLAT10', 'F_SKY1', 'F_1', 'FF_1', 'flat23']) {
      expect(looksLikeFlatName(n)).toBe(true);
    }
  });
  it('rejects non-flat names', () => {
    for (const n of ['SPOS_A1', 'DOOR3', 'ROCK1', 'PNAMES', 'WATERFALL1']) {
      expect(looksLikeFlatName(n)).toBe(false);
    }
  });
});

describe('looksLikePatchHeader', () => {
  /** Build a minimal valid patch: width x 1 tall, one column at offset 20. */
  function miniPatch(width: number, columnOfs = 16 + width * 4): Uint8Array {
    const buf = new Uint8Array(columnOfs + 8);
    const v = new DataView(buf.buffer);
    v.setInt16(0, width, true);
    v.setInt16(2, 1, true);
    for (let c = 0; c < width; c++) v.setUint32(16 + c * 4, columnOfs, true);
    // post: topdelta 0, length 4, then 4 pixels + terminator
    buf[columnOfs] = 0;
    buf[columnOfs + 1] = 4;
    return buf;
  }

  it('accepts a well-formed header', () => {
    expect(looksLikePatchHeader(miniPatch(3))).toBe(true);
  });
  it('rejects too-short buffers', () => {
    expect(looksLikePatchHeader(new Uint8Array(10))).toBe(false);
  });
  it('rejects nonsensical dimensions', () => {
    const bad = miniPatch(2000);
    expect(looksLikePatchHeader(bad)).toBe(false);
    const zero = miniPatch(0);
    expect(looksLikePatchHeader(zero)).toBe(false);
  });
  it('rejects unaligned or out-of-range column offsets', () => {
    const unaligned = miniPatch(1, 19);
    expect(looksLikePatchHeader(unaligned)).toBe(false);
  });
  it('rejects columnofs past the lump end', () => {
    const short = new Uint8Array(20);
    const v = new DataView(short.buffer);
    v.setInt16(0, 1, true);
    v.setInt16(2, 1, true);
    v.setUint32(16, 20, true); // ofs === lump length → out of bounds
    expect(looksLikePatchHeader(short)).toBe(false);
  });
});

describe('buildRows + filterRows + pageSlice', () => {
  const names = ['S_START', 'PLAYPAL', 'FLAT14', 'E1M1', 'S_END'];
  const sizes = [0, 10752, 4096, 120000, 0];
  const rows = buildRows(names.length, (i) => names[i]!, (i) => sizes[i]!);

  it('builds one classified row per lump', () => {
    expect(rows.map((r) => r.kind)).toEqual(['marker', 'data', 'flat', 'data', 'marker']);
    expect(rows[2]).toEqual({ num: 2, name: 'FLAT14', size: 4096, kind: 'flat' });
  });

  it('filters case-insensitively on substrings', () => {
    expect(filterRows(rows, 'flat')).toHaveLength(1);
    expect(filterRows(rows, 's_')).toHaveLength(2); // S_START, S_END
    expect(filterRows(rows, '  ')).toHaveLength(5); // empty query = all
    expect(filterRows(rows, 'zzz')).toHaveLength(0);
  });

  it('slices pages with clamping', () => {
    expect(pageSlice(250, 0, 100)).toEqual({ start: 0, end: 100, page: 0, pageCount: 3 });
    expect(pageSlice(250, 2, 100)).toEqual({ start: 200, end: 250, page: 2, pageCount: 3 });
    expect(pageSlice(250, 99, 100).page).toBe(2);
    expect(pageSlice(250, -3, 100).page).toBe(0);
    expect(pageSlice(0, 0, 100)).toEqual({ start: 0, end: 0, page: 0, pageCount: 1 });
  });
});

describe('hexDump', () => {
  it('renders hex + printable ASCII with dot fallback', () => {
    const bytes = Uint8Array.from([0x49, 0x57, 0x41, 0x44, 0x00, 0x01, 0xff, 0x41]);
    const out = hexDump(bytes, 2048);
    expect(out).toContain('49 57 41 44 00 01 ff 41');
    expect(out).toContain('|IWAD...A');
  });
  it('truncates at the limit and reports the remainder', () => {
    const out = hexDump(new Uint8Array(40), 16);
    expect(out.split('\n')).toHaveLength(2); // one line + "... 24 more bytes"
    expect(out).toContain('24 more bytes');
  });
});
