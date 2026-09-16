/**
 * M1-06 tests — PNAMES / TEXTURE1 / TEXTURE2 decoders.
 *
 * Handcrafted vectors pin the three R01 §14/§15 divergences: PNAMES stride
 * 8 (not the 16 some docs claim), width@12/height@14/patchcount@20 (not the
 * width@8/patchcount@14 of the Unofficial Specs), and int16 PNAMES indices
 * with stepdir/colormap garbage ignored. Real-IWAD goldens auto-skip when
 * wads/freedoom1.wad is absent.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { synthPnames } from '../../tests/fixtures/smallWads';
import { WadBuilder } from '../../tests/fixtures/wadWriter';
import { buildPatchFromColumns } from './patch';
import type { TextureDef } from './types';
import {
  decodePnames,
  decodeTextures,
  MissingPatchError,
  PnamesError,
  TextureDecodeError,
  TextureOffsetError,
  TexturePatchIndexError,
  TextureRecordError,
  texturesFromWad,
} from './texture';
import { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Solid patch of value `v`, with optional per-[col,row] holes (0 pixels). */
function solidPatch(w: number, h: number, v: number, holes: [number, number][] = []): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c += 1) {
    cols.push(Array.from({ length: h }, () => v));
  }
  for (const [c, r] of holes) cols[c]![r] = 0;
  return buildPatchFromColumns(cols);
}

interface TexSpec {
  name: string;
  width: number;
  height: number;
  /** Raw 4 bytes at record offset 8 (on-disk struct-copy slot; ignored). */
  flag?: number;
  /** [originX, originY, pnamesIndex]. */
  patches: [number, number, number][];
}

/** Handcrafted TEXTURE lump (R02 §7 offsets); `opts` injects malformations. */
function textureLump(
  specs: TexSpec[],
  opts: { count?: number; offsets?: number[] } = {},
): Uint8Array {
  const recs = specs.map((s) => {
    const out = new Uint8Array(22 + 10 * s.patches.length);
    const v = new DataView(out.buffer);
    for (let c = 0; c < s.name.length; c += 1) out[c] = s.name.charCodeAt(c);
    v.setUint32(8, s.flag ?? 0, true); // masked-slot, incl. junk / 0x8000 folklore
    v.setInt16(12, s.width, true);
    v.setInt16(14, s.height, true);
    v.setInt16(20, s.patches.length, true);
    s.patches.forEach(([x, y, p], i) => {
      const a = 22 + i * 10;
      v.setInt16(a, x, true);
      v.setInt16(a + 2, y, true);
      v.setInt16(a + 4, p, true);
      v.setInt16(a + 6, 7); // stepdir garbage: never read (r_data.c:536-538)
      v.setInt16(a + 8, 0x1234); // colormap garbage: never read
    });
    return out;
  });
  const size = 4 + 4 * specs.length + recs.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(opts.count !== undefined ? 4 : size);
  const v = new DataView(out.buffer);
  v.setInt32(0, opts.count ?? specs.length, true);
  let cursor = 4 + 4 * specs.length;
  specs.forEach((_, i) => {
    if (out.length < cursor + recs[i]!.length) return;
    v.setInt32(4 + i * 4, opts.offsets?.[i] ?? cursor, true);
    out.set(recs[i]!, cursor);
    cursor += recs[i]!.length;
  });
  if (opts.offsets) for (let i = 0; i < specs.length; i += 1) v.setInt32(4 + i * 4, opts.offsets[i]!, true);
  return out;
}

/** WAD with PNAMES + optional TEXTURE1/TEXTURE2 + named patch lumps. */
function wadWith(opts: {
  pnames?: string[] | Uint8Array | null;
  texture1?: Uint8Array | null;
  texture2?: Uint8Array | null;
  patches?: [string, Uint8Array][];
  patchesOutsideRange?: [string, Uint8Array][];
}): WadFile {
  const wad = new WadBuilder('IWAD');
  if (opts.texture1) wad.addLump('TEXTURE1', opts.texture1);
  if (opts.texture2) wad.addLump('TEXTURE2', opts.texture2);
  if (opts.pnames !== null && opts.pnames !== undefined) {
    wad.addLump('PNAMES', Array.isArray(opts.pnames) ? synthPnames(opts.pnames) : opts.pnames);
  }
  wad.addLumpMarker('P_START');
  for (const [n, d] of opts.patches ?? []) wad.addLump(n, d);
  wad.addLumpMarker('P_END');
  for (const [n, d] of opts.patchesOutsideRange ?? []) wad.addLump(n, d); // R02 §1: still findable
  return WadFile.parse(wad.build().buffer as ArrayBuffer);
}

function sha256Columns(def: TextureDef): string {
  const joined = new Uint8Array(def.width * def.height);
  for (let c = 0; c < def.width; c += 1) joined.set(def.columns[c]!, c * def.height);
  return createHash('sha256').update(joined).digest('hex');
}

/* ------------------------------------------------------------------ */
/* decodePnames                                                        */
/* ------------------------------------------------------------------ */

describe('decodePnames', () => {
  it('parses the stride-8 layout (names NUL-padded, uppercased)', () => {
    const bytes = new Uint8Array(4 + 8 * 3);
    const v = new DataView(bytes.buffer);
    v.setInt32(0, 3, true);
    for (const [i, n] of ['fixp0', 'WALL03_1', 'A'].entries()) {
      for (let c = 0; c < n.length; c += 1) bytes[4 + i * 8 + c] = n.charCodeAt(c);
    }
    expect(bytes.length).toBe(4 + 8 * 3); // stride 8, NOT 16 (R01 §14: freedoom1 size 8396 exact)
    expect(decodePnames(bytes)).toEqual(['FIXP0', 'WALL03_1', 'A']);
  });

  it('throws typed PnamesError on truncation or impossible counts', () => {
    expect(() => decodePnames(new Uint8Array(3))).toThrowError(PnamesError);
    const big = new Uint8Array(4 + 8);
    new DataView(big.buffer).setInt32(0, 99, true);
    expect(() => decodePnames(big)).toThrowError(PnamesError);
    const neg = new Uint8Array(8);
    new DataView(neg.buffer).setInt32(0, -1, true);
    expect(() => decodePnames(neg)).toThrowError(PnamesError);
  });
});

/* ------------------------------------------------------------------ */
/* decodeTextures                                                      */
/* ------------------------------------------------------------------ */

describe('decodeTextures', () => {
  it('composes a 64x64 texture from two side-by-side patches (hand-computed)', () => {
    const wad = wadWith({
      pnames: ['LEFTE', 'RIGHTE'],
      texture1: textureLump([{ name: 'FIXTEX0', width: 64, height: 64, patches: [[0, 0, 0], [32, 0, 1]] }]),
      patches: [['LEFTE', solidPatch(32, 64, 3)], ['RIGHTE', solidPatch(32, 64, 4)]],
    });
    const tex = decodeTextures(wad).get('FIXTEX0')!;
    expect(tex).toMatchObject({ name: 'FIXTEX0', width: 64, height: 64 });
    expect(tex.patches).toEqual([
      { originX: 0, originY: 0, patchNum: wad.lumpNumByName('LEFTE') },
      { originX: 32, originY: 0, patchNum: wad.lumpNumByName('RIGHTE') },
    ]);
    expect(tex.columns[0]![0]).toBe(3);
    expect(tex.columns[31]![63]).toBe(3);
    expect(tex.columns[32]![0]).toBe(4);
    expect(tex.columns[63]![63]).toBe(4);
  });

  it('draws patches in TABLE order (later wins); holes expose earlier pixels', () => {
    // R02 §7 does NOT reorder masked patches last — r_data.c:252-256 is one
    // plain table-order loop — and the on-disk flag byte is ignored.
    const wad = wadWith({
      pnames: ['UNDER', 'OVER'],
      texture1: textureLump([
        { name: 'FIXMASK', width: 4, height: 4, flag: 0x8000, patches: [[0, 0, 0], [0, 0, 1]] },
      ]),
      patches: [
        ['UNDER', solidPatch(4, 4, 5, [[1, 1]])],
        ['OVER', solidPatch(4, 4, 6, [[0, 0]])],
      ],
    });
    const tex = decodeTextures(wad).get('FIXMASK')!;
    expect(tex.columns[0]![0]).toBe(5); // OVER hole (0,0): UNDER shows through
    expect(tex.columns[1]![1]).toBe(6); // UNDER hole (1,1): OVER drew 6 there
    expect(tex.columns[2]![2]).toBe(6); // overlap: table-later OVER overwrote 5
    expect(tex.columns[3]![3]).toBe(6);
  });

  it('clips out-of-texture placement (vanilla: no wrap in compositing)', () => {
    const wad = wadWith({
      pnames: ['DOT', 'STRIP'],
      texture1: textureLump([
        { name: 'FIXCLIP', width: 8, height: 8, patches: [[-1, -1, 0], [6, 6, 1]] },
      ]),
      patches: [['DOT', solidPatch(2, 2, 9)], ['STRIP', solidPatch(4, 4, 3)]],
    });
    const tex = decodeTextures(wad).get('FIXCLIP')!;
    expect(tex.columns[0]![0]).toBe(9); // DOT at (-1,-1): top-left pixel lands at (0,0)
    expect(tex.columns[1]![0]).toBe(0); // the rest of DOT clips at x/y=0…
    expect(tex.columns[0]![7]).toBe(0); // …and does NOT wrap to row 7 (far edge)
    expect(tex.columns[6]![6]).toBe(3); // STRIP at (6,6): rows/cols past 8 dropped
    expect(tex.columns[7]![7]).toBe(3);
    let dots = 0;
    for (const col of tex.columns) for (const p of col) if (p === 9) dots += 1;
    expect(dots).toBe(1);
  });

  it('resolves PNAMES names globally: case-insensitive, last-match wins, anywhere', () => {
    const wad = wadWith({
      pnames: ['dupme', 'outside'], // lowercase entries
      texture1: textureLump([{ name: 'FIXLOOK', width: 1, height: 1, patches: [[0, 0, 0], [0, 0, 1]] }]),
      patches: [
        ['DUPME', solidPatch(1, 1, 11)], // shadowed by the later duplicate
        ['DUPME', solidPatch(1, 1, 12)], // WadFile last-match-wins == vanilla
        ['OUTSIDE', solidPatch(1, 1, 13)], // outside P_START..P_END, still found
      ],
    });
    const tex = decodeTextures(wad).get('FIXLOOK')!;
    expect(tex.columns[0]![0]).toBe(13); // both resolved by global lookup
    expect(wad.lumpName(tex.patches[0]!.patchNum)).toBe('DUPME');
  });

  it('first duplicate texture name wins (vanilla forwards scan)', () => {
    const wad = wadWith({
      pnames: ['PX'],
      texture1: textureLump([
        { name: 'FIXDUP', width: 8, height: 4, patches: [[0, 0, 0]] },
        { name: 'FIXDUP', width: 8, height: 16, patches: [[0, 0, 0]] },
      ]),
      patches: [['PX', solidPatch(8, 4, 2)]],
    });
    expect(decodeTextures(wad).get('FIXDUP')!.height).toBe(4);
  });

  it('throws typed errors for malformed lumps and records', () => {
    const good = wadWith({
      pnames: ['PX'],
      texture1: textureLump([{ name: 'T', width: 4, height: 4, patches: [[0, 0, 0]] }]),
      patches: [['PX', solidPatch(4, 4, 2)]],
    });
    expect(decodeTextures(good).size).toBe(1);
    const noTex1 = () => decodeTextures(wadWith({ pnames: ['PX'] }));
    expect(noTex1).toThrowError(TextureOffsetError); // TEXTURE1 absent
    const noPnames = () =>
      decodeTextures(wadWith({ texture1: textureLump([{ name: 'T', width: 4, height: 4, patches: [] }]) }));
    expect(noPnames).toThrowError(PnamesError); // PNAMES absent
    const rec = { name: 'T', width: 4, height: 4, patches: [[0, 0, 0] as [number, number, number]] };
    const badWad = (t: Uint8Array, names: string[] = ['PX']) =>
      wadWith({ pnames: names, texture1: t, patches: [['PX', solidPatch(4, 4, 2)]] });
    // Offset-table/count malformations (the divergences R01 §14 flags).
    expect(() => decodeTextures(badWad(textureLump([rec], { count: 70000 })))).toThrowError(TextureOffsetError);
    expect(() => decodeTextures(badWad(textureLump([rec], { offsets: [1e6] })))).toThrowError(TextureOffsetError);
    expect(() => decodeTextures(badWad(textureLump([rec], { offsets: [-4] })))).toThrowError(TextureOffsetError);
    const badOffRec = badWad(textureLump([{ ...rec, width: 0 }], { offsets: [-4] }));
    expect(() => decodeTextures(badOffRec)).toThrowError(TextureOffsetError); // offset checked first
    expect(() => decodeTextures(badWad(textureLump([{ ...rec, width: 0 }])))).toThrowError(TextureRecordError);
    expect(() => decodeTextures(badWad(textureLump([{ ...rec, height: -8 }])))).toThrowError(TextureRecordError);
    // patchcount huge: record starts at lump offset 8 (count + 1 offset), pc@+20
    const huge = textureLump([rec]);
    new DataView(huge.buffer).setInt16(8 + 20, 999, true);
    expect(() => decodeTextures(badWad(huge))).toThrowError(TextureRecordError);
    const idxHi = textureLump([{ name: 'T', width: 4, height: 4, patches: [[0, 0, 1]] }]);
    expect(() => decodeTextures(badWad(idxHi))).toThrowError(TexturePatchIndexError); // index == pnames.length
    const idxNeg = textureLump([{ name: 'T', width: 4, height: 4, patches: [[0, 0, -1]] }]);
    expect(() => decodeTextures(badWad(idxNeg))).toThrowError(TexturePatchIndexError);
    const missingPatch = () =>
      decodeTextures(
        wadWith({
          pnames: ['MISSING'],
          texture1: textureLump([rec]),
          patches: [['PX', solidPatch(4, 4, 2)]],
        }),
      );
    expect(missingPatch).toThrowError(MissingPatchError); // vanilla I_Error("Missing patch")
    // Every failure above shares the typed base class:
    expect(missingPatch).toThrowError(TextureDecodeError);
  });
});

/* ------------------------------------------------------------------ */
/* texturesFromWad                                                     */
/* ------------------------------------------------------------------ */

describe('texturesFromWad', () => {
  const t1 = textureLump([{ name: 'FIXONE', width: 8, height: 8, patches: [[0, 0, 0]] }]);
  const t2 = textureLump([{ name: 'FIXTWO', width: 8, height: 8, patches: [[0, 0, 0]] }]);
  const t2dup = textureLump([{ name: 'FIXONE', width: 8, height: 16, patches: [[0, 0, 0]] }]);
  const patches: [string, Uint8Array][] = [['PX', solidPatch(8, 8, 2)]];

  it('merges TEXTURE1 then TEXTURE2', () => {
    const wad = wadWith({ pnames: ['PX'], texture1: t1, texture2: t2, patches });
    expect([...texturesFromWad(wad).keys()]).toEqual(['FIXONE', 'FIXTWO']);
  });

  it('skips missing lumps without throwing', () => {
    expect(texturesFromWad(wadWith({ pnames: ['PX'], texture1: t1, patches })).size).toBe(1); // no TEXTURE2
    expect(texturesFromWad(wadWith({ pnames: ['PX'], texture2: t2, patches })).size).toBe(1); // TEXTURE2 only
    expect(texturesFromWad(wadWith({}))).toEqual(new Map()); // neither present
  });

  it('TEXTURE1 wins duplicate names (vanilla concatenates, scans forwards)', () => {
    const wad = wadWith({ pnames: ['PX'], texture1: t1, texture2: t2dup, patches });
    expect(texturesFromWad(wad).get('FIXONE')!.height).toBe(8);
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad goldens (auto-skip when absent)                       */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad texture goldens', () => {
  let cached: WadFile | undefined;
  function wad(): WadFile {
    cached ??= WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    return cached;
  }

  // Recorded 2026-07 from wads/freedoom1.wad (v0.13.0, sha256 7323bcc1…703d,
  // pinned in scripts/freedoom/release.json). Counts match R01 §14 (1049
  // pnames; 801 + 162 textures). DOOR1/AASTINKY/BIGDOOR1 all exist in the
  // list (EXITWALL1 does NOT exist in freedoom1).
  it('PNAMES + TEXTURE1 + TEXTURE2 parse fully', () => {
    expect(decodePnames(wad().readLumpByName('PNAMES')).length).toBe(1049);
    const t1 = decodeTextures(wad(), 'TEXTURE1');
    const t2 = decodeTextures(wad(), 'TEXTURE2');
    expect(t1.size).toBe(801); // all records sane: decodeTextures threw on no
    expect(t2.size).toBe(162); // width/height/patchcount/index malformation
    for (const def of [...t1.values(), ...t2.values()]) {
      expect(def.width).toBeGreaterThan(0);
      expect(def.height).toBeGreaterThan(0);
      for (const p of def.patches) expect(p.patchNum).toBeGreaterThanOrEqual(0);
    }
    expect(texturesFromWad(wad()).size).toBe(963); // no cross-lump duplicate names
  });

  it('composes pinned textures (dimensions + sha256 of columns)', () => {
    const tex = texturesFromWad(wad());
    const door = tex.get('DOOR1')!; // 1 patch (WALL03_1 @ 0,0)
    expect([door.width, door.height]).toEqual([64, 72]);
    expect(sha256Columns(door)).toBe('cfca6116e8779f5a0eb2006fe26e180914d401032693e57b0de61e2c86e96da9');
    const aas = tex.get('AASTINKY')!; // 3 overlapping patches
    expect([aas.width, aas.height]).toEqual([32, 72]);
    expect(sha256Columns(aas)).toBe('cf4479efe5b0b440dfcaedaa87169e60ffd98f9d66868a989f8de1737a3b7c1a');
    const big = tex.get('BIGDOOR1')!; // 5 patches, name-cache lookup
    expect([big.width, big.height, big.patches.length]).toEqual([128, 96, 5]);
    expect(sha256Columns(big)).toBe('e736eab3cc661a00a3bca630db050985163338fdd1b34010fef5eb09c1286ff7');
  });
});
