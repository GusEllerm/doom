/**
 * M1-03 tests — PLAYPAL / COLORMAP decoders.
 *
 * Synthetic byte vectors + golden hashes (deterministic ramps, no external
 * data). Real-IWAD goldens run only when wads/freedoom1.wad is present
 * (auto-skip otherwise; only a few documented palette entries are committed
 * as constants — never bulk WAD content).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  COLORMAP_BYTES,
  NUM_PALETTES,
  PaletteError,
  PLAYPAL_BYTES,
  decodeColormap,
  decodePalettes,
  decodePlaypal,
  paletteToRgba,
  rgbaAt,
} from './palettes';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function sha256(buf: ArrayBufferLike): string {
  return createHash('sha256').update(new Uint8Array(buf)).digest('hex');
}

/** Deterministic synthetic PLAYPAL ramp (same generator as golden hash). */
function synthPlaypal(): Uint8Array {
  const b = new Uint8Array(PLAYPAL_BYTES);
  for (let k = 0; k < b.length; k++) b[k] = (k * 31 + 7) & 0xff;
  return b;
}

/** Deterministic synthetic COLORMAP ramp. */
function synthColormap(): Uint8Array {
  const b = new Uint8Array(COLORMAP_BYTES);
  for (let k = 0; k < b.length; k++) b[k] = (k * 17 + 5) & 0xff;
  return b;
}

function rgbaOf(base: Uint32Array, i: number): { r: number; g: number; b: number; a: number } {
  const v = base[i] as number;
  return { r: (v >>> 16) & 0xff, g: (v >>> 8) & 0xff, b: v & 0xff, a: (v >>> 24) & 0xff };
}

/* ------------------------------------------------------------------ */
/* decodePlaypal                                                      */
/* ------------------------------------------------------------------ */

describe('decodePlaypal', () => {
  it('accepts exactly 14*768 bytes and produces 14*256 entries', () => {
    const base = decodePlaypal(synthPlaypal());
    expect(base).toBeInstanceOf(Uint32Array);
    expect(base.length).toBe(NUM_PALETTES * 256);
  });

  it('packs entries as 0xAARRGGBB with alpha always 0xFF', () => {
    // Hand-built first entry: R=0x11 G=0x22 B=0x33.
    const bytes = new Uint8Array(PLAYPAL_BYTES);
    bytes[0] = 0x11;
    bytes[1] = 0x22;
    bytes[2] = 0x33;
    const base = decodePlaypal(bytes);
    expect(base[0]).toBe(0xff112233);
  });

  it('in memory a little-endian Uint32 0xAARRGGBB is laid out [B,G,R,A]', () => {
    const base = decodePlaypal(new Uint8Array(PLAYPAL_BYTES));
    base[0] = paletteToRgba(0x11, 0x22, 0x33);
    // ImageData blit on canvas needs BGRA->RGBA channel order; the M3+ blit
    // LUT handles that swap, this layer only pins the numeric 0xAARRGGBB value.
    expect(Array.from(new Uint8Array(base.buffer, 0, 4))).toEqual([0x33, 0x22, 0x11, 0xff]);
    expect(base[0]).toBe(0xff112233);
  });

  it('keeps DOOM 0-255 palette values verbatim (no HEXEN 0-254 scaling)', () => {
    const bytes = new Uint8Array(PLAYPAL_BYTES).fill(254);
    bytes[0] = 255;
    const base = decodePlaypal(bytes);
    expect(rgbaOf(base, 0)).toEqual({ r: 255, g: 254, b: 254, a: 255 });
  });

  it('black entry stays opaque black 0xFF000000', () => {
    const base = decodePlaypal(new Uint8Array(PLAYPAL_BYTES));
    expect(base[0]).toBe(0xff000000);
  });

  it('each palette row is offset by 256 entries', () => {
    const bytes = synthPlaypal();
    bytes.set([1, 2, 3], 13 * 768); // radiation row, color 0 (R=1,G=2,B=3)
    const base = decodePlaypal(bytes);
    expect(base[13 * 256]).toBe(0xff010203);
  });

  it('rejects wrong sizes with PaletteError (incl. Hexen 3/4-palette variants)', () => {
    const bad = [0, 3, 3 * 768, 4 * 768, PLAYPAL_BYTES - 1, PLAYPAL_BYTES + 3];
    for (const n of bad) {
      expect(() => decodePlaypal(new Uint8Array(n)), `size ${n}`).toThrowError(PaletteError);
    }
  });

  it('works on a subarray view of a larger buffer', () => {
    const host = new Uint8Array(PLAYPAL_BYTES + 100).fill(0x7f);
    synthPlaypal().forEach((v, i) => {
      host[100 + i] = v;
    });
    const base = decodePlaypal(host.subarray(100, 100 + PLAYPAL_BYTES));
    expect(sha256(base.buffer)).toBe(SYNTH_BASE_SHA256);
  });

  it('golden sha256 of the deterministic synthetic ramp decode', () => {
    expect(sha256(decodePlaypal(synthPlaypal()).buffer)).toBe(SYNTH_BASE_SHA256);
  });
});

/* Golden hash of decodePlaypal(synthPlaypal()).buffer — reproducible from
 * the generators above alone; contains no real-WAD content. */
const SYNTH_BASE_SHA256 = '61324de4558a44b4cb93ed260d3f4a4e1cbee326c344c1c68fe8cdfcdf7c773e';

/* ------------------------------------------------------------------ */
/* decodeColormap                                                     */
/* ------------------------------------------------------------------ */

describe('decodeColormap', () => {
  it('copies all 34*256 bytes and validates size', () => {
    const cm = synthColormap();
    const rows = decodeColormap(cm);
    expect(rows).toBeInstanceOf(Uint8Array);
    expect(rows.length).toBe(COLORMAP_BYTES);
    expect(rows).toEqual(cm);
    expect(rows.buffer).not.toBe(cm.buffer); // defensive copy, not aliasing
  });

  it('row indexing is row*256+color', () => {
    const cm = new Uint8Array(COLORMAP_BYTES);
    cm[32 * 256 + 255] = 0x6f; // inverse-map row, white slot
    expect(decodeColormap(cm)[32 * 256 + 255]).toBe(0x6f);
  });

  it('rejects wrong sizes with PaletteError (32-row variant too short)', () => {
    for (const n of [0, 256, 32 * 256, COLORMAP_BYTES - 1, COLORMAP_BYTES + 1]) {
      expect(() => decodeColormap(new Uint8Array(n)), `size ${n}`).toThrowError(PaletteError);
    }
  });

  it('golden sha256 of the deterministic synthetic ramp', () => {
    expect(sha256(decodeColormap(synthColormap()).buffer)).toBe(SYNTH_COLORMAP_SHA256);
  });
});

const SYNTH_COLORMAP_SHA256 = 'c4155ca1e7b936b3996f48614faa4e0ebe2c862825b8b2252cadbcb29e69a8ce';

/* ------------------------------------------------------------------ */
/* decodePalettes / rgbaAt / paletteToRgba                            */
/* ------------------------------------------------------------------ */

describe('decodePalettes', () => {
  it('assembles the shared Palettes contract', () => {
    const p = decodePalettes(synthPlaypal(), synthColormap());
    expect(p.base.length).toBe(14 * 256);
    expect(p.colormapRows.length).toBe(34 * 256);
    // A bad PLAYPAL or bad COLORMAP propagates the typed error.
    expect(() => decodePalettes(new Uint8Array(10), synthColormap())).toThrowError(PaletteError);
    expect(() => decodePalettes(synthPlaypal(), new Uint8Array(10))).toThrowError(PaletteError);
  });
});

describe('rgbaAt', () => {
  it('reads packed entries', () => {
    const base = decodePlaypal(synthPlaypal());
    expect(rgbaAt(base, 0)).toBe(base[0]);
    expect(rgbaAt(base, 14 * 256 - 1)).toBe(base[14 * 256 - 1]);
  });

  it('throws PaletteError on out-of-range or non-integer indices', () => {
    const base = decodePlaypal(synthPlaypal());
    for (const i of [-1, 14 * 256, 1.5, Number.NaN]) {
      expect(() => rgbaAt(base, i), `index ${i}`).toThrowError(PaletteError);
    }
  });
});

describe('paletteToRgba', () => {
  it('packs 0xFFRRGGBB unsigned', () => {
    expect(paletteToRgba(0, 0, 0)).toBe(0xff000000);
    expect(paletteToRgba(255, 255, 255)).toBe(0xffffffff);
    expect(paletteToRgba(28, 0, 0)).toBe(0xff1c0000);
    expect(paletteToRgba(0, 31, 0)).toBe(0xff001f00);
  });
});

/* ------------------------------------------------------------------ */
/* Real-IWAD goldens (auto-skip when wads/freedoom1.wad is absent)    */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

/** Minimal last-match-wins lump reader (WadFile.parse is still M1-02). */
function readLumpByName(name: string): Uint8Array {
  const buf = readFileSync(WAD_PATH);
  const id = buf.toString('ascii', 0, 4);
  if (id !== 'IWAD' && id !== 'PWAD') throw new Error(`not a WAD: ${id}`);
  const count = buf.readInt32LE(4);
  const dirOfs = buf.readInt32LE(8);
  for (let i = count - 1; i >= 0; i--) {
    const e = dirOfs + i * 16;
    // DOOM dir entry: u32 filepos, u32 length, 8-byte name (R01 §2).
    const lumpName = buf
      .toString('ascii', e + 8, e + 16)
      .replace(/\u0000.*$/s, '')
      .trimEnd()
      .toUpperCase();
    if (lumpName === name) {
      const ofs = buf.readInt32LE(e);
      const len = buf.readInt32LE(e + 4);
      return new Uint8Array(buf.buffer, buf.byteOffset + ofs, len);
    }
  }
  throw new Error(`lump ${name} not found`);
}

describe.skipIf(!hasWad)('freedoom1.wad goldens', () => {
  // Sampled constants verified in R02 §2-3 against freedoom1.wad v0.13.0.
  // 1) palette 0 entry 0 = black; 2) palette 0 entry 255 = white;
  // 3) palette 13 (radiation) entry 0 = RGB(0,31,0);
  // 4) palette 1 entry 0 red channel = 28; 5) palette 8 entry 0 red = 229
  //    (red pain ramp 28,57,86,114,143,172,200,229 — endpoints sampled).
  // NOTE (M1-03 fix): entry-255 and COLORMAP row-0 "identity" expectations
  // were vanilla lore; Freedoom's data (sampled from wads/freedoom1.wad
  // v0.13.0) is pinned below instead.
  it('PLAYPAL exact size + sampled palette entries', () => {
    const bytes = readLumpByName('PLAYPAL');
    expect(bytes.byteLength).toBe(PLAYPAL_BYTES);
    const base = decodePlaypal(bytes);
    expect(base[0]).toBe(0xff000000);
    // Freedoom palette 0 entry 255 is (167,107,107), NOT vanilla white.
    expect(base[255]).toBe(0xffa76b6b);
    expect(base[13 * 256]).toBe(0xff001f00);
    expect((base[1 * 256]! >>> 16) & 0xff).toBe(28);
    expect((base[8 * 256]! >>> 16) & 0xff).toBe(229);
  });

  it('COLORMAP exact size; row 0 mostly identity with Freedoom quirk at 168', () => {
    const bytes = readLumpByName('COLORMAP');
    expect(bytes.byteLength).toBe(COLORMAP_BYTES);
    const rows = decodeColormap(bytes);
    for (const i of [0, 1, 4, 100, 127, 167, 169, 200, 255]) expect(rows[i]).toBe(i);
    // Freedoom's COLORMAP row 0 maps 168 -> 4 (vanilla is pure identity).
    expect(rows[168]).toBe(4);
  });
});
