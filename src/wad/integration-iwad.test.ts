/**
 * M1-09 — IWAD integration goldens (M1-plan §M1-09).
 *
 * One consolidated describe.skipIf(!hasWad) exercising all M1 decoders
 * end-to-end against the pinned freedoom1.wad (v0.13.0, sha256
 * 7323bcc1…703d, scripts/freedoom/release.json):
 *   - PLAYPAL bank-0 sha256 + the palette entries pinned in palettes.test.ts
 *   - COLORMAP sha256 + the Freedoom row-0 quirk pinned there
 *   - PNAMES / TEXTURE1 / TEXTURE2 record counts (texture.test.ts goldens)
 *   - sprite census totals (sprites.test.ts goldens)
 *   - one patch column-bytes sha256 (patch.test.ts WALL00_3)
 *   - one composed-texture sha256 (texture.test.ts BIGDOOR1)
 *
 * ALL values below are the ACTUAL freedoom1-pinned values already green in
 * the per-decoder tests — NOT vanilla-DOOM lore (R01 §14 numbers are lore
 * except where it verified freedoom itself; see divergences there).
 * mapdata/E1M1 counts are NOT consolidated here: src/wad/mapdata.ts had not
 * merged at the time of writing (M2 owns map parsing) — FOLLOW-UP.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { TextureDef } from './types';
import { WadFile } from './wadfile';
import {
  COLORMAP_BYTES,
  PLAYPAL_BYTES,
  decodeColormap,
  decodePlaypal,
} from './palettes';
import { decodePatch } from './patch';
import { buildSpriteDefs } from './sprites';
import { decodePnames, decodeTextures, texturesFromWad } from './texture';

/* ------------------------------------------------------------------ */
/* Helpers (same patterns as the per-decoder golden tests)             */
/* ------------------------------------------------------------------ */

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Patch column-bytes joined column-major (identical to patch.test.ts). */
function shaOfPatchColumns(wad: WadFile, name: string): string {
  const patch = decodePatch(wad.readLumpByName(name));
  const joined = new Uint8Array(patch.width * patch.height);
  for (let c = 0; c < patch.width; c += 1) joined.set(patch.columns[c]!, c * patch.height);
  return sha256(joined);
}

/** Texture composed columns joined column-major (identical to texture.test.ts). */
function sha256Columns(def: TextureDef): string {
  const joined = new Uint8Array(def.width * def.height);
  for (let c = 0; c < def.width; c += 1) joined.set(def.columns[c]!, c * def.height);
  return sha256(joined);
}

/* ------------------------------------------------------------------ */
/* Real-IWAD integration (auto-skip when wads/freedoom1.wad is absent) */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad integration goldens (M1-09)', () => {
  // Built lazily so a skipped suite never reads the 28 MB file.
  let cached: WadFile | undefined;
  function wad(): WadFile {
    cached ??= WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    return cached;
  }

  it('PLAYPAL: exact size, bank-0 sha256, palettes.test.ts sampled entries', () => {
    const bytes = wad().readLumpByName('PLAYPAL');
    expect(bytes.byteLength).toBe(PLAYPAL_BYTES); // 14 × 768 (R01 §14 ✓ exact)
    expect(sha256(bytes.subarray(0, 768))).toBe(
      'fd895921b5d0a394612bb29852ed003d44d69f76dec31c0dc6b5d5fc7d63f7bb',
    );
    const base = decodePlaypal(bytes);
    // Same sampled constants as palettes.test.ts 'freedoom1.wad goldens'.
    expect(base[0]).toBe(0xff000000); // palette 0 entry 0 = black
    expect(base[255]).toBe(0xffa76b6b); // palette 0 entry 255 — Freedoom salmon, NOT vanilla white
    expect(base[13 * 256]).toBe(0xff001f00); // radiation palette entry 0
    expect((base[1 * 256]! >>> 16) & 0xff).toBe(28); // red ramp first red
    expect((base[8 * 256]! >>> 16) & 0xff).toBe(229); // red ramp last red
  });

  it('COLORMAP: exact size, sha256, Freedoom row-0 quirk at index 168', () => {
    const bytes = wad().readLumpByName('COLORMAP');
    expect(bytes.byteLength).toBe(COLORMAP_BYTES); // 34 × 256 (R01 §14 ✓ exact)
    expect(sha256(bytes)).toBe(
      '82a12cab7416a89e7a7791da2dc4e69c118c9a41a3a930dfd0dc01cb35626cda',
    );
    const rows = decodeColormap(bytes);
    for (const i of [0, 1, 4, 100, 127, 167, 169, 200, 255]) expect(rows[i]).toBe(i);
    expect(rows[168]).toBe(4); // Freedoom quirk; vanilla row 0 is pure identity
  });

  it('PNAMES + TEXTURE1 + TEXTURE2 counts (texture.test.ts goldens)', () => {
    expect(wad().readLumpByName('PNAMES').byteLength).toBe(4 + 8 * 1049); // stride 8
    expect(decodePnames(wad().readLumpByName('PNAMES')).length).toBe(1049);
    expect(decodeTextures(wad(), 'TEXTURE1').size).toBe(801);
    expect(decodeTextures(wad(), 'TEXTURE2').size).toBe(162);
    expect(texturesFromWad(wad()).size).toBe(963); // 801 + 162, no dup names
  });

  it('sprite census totals (sprites.test.ts goldens)', () => {
    const census = buildSpriteDefs(wad());
    expect(census.warnings).toEqual([]);
    expect(census.sprites.length).toBe(113); // unique 4CC names
    expect(census.lumpSites.size).toBe(853); // lumps between S_START/S_END
    let totalFrames = 0;
    let rotating = 0;
    let flipSlots = 0;
    for (const sprite of census.sprites) {
      totalFrames += sprite.frames.length;
      for (const frame of sprite.frames) {
        if (frame.rotate) rotating++;
        flipSlots += Array.from(frame.flip).reduce((a, b) => a + b, 0);
      }
    }
    expect(totalFrames).toBe(440);
    expect(rotating).toBe(85);
    expect(flipSlots).toBe(182); // the 182 eight-char mirrored names (R02 §10)
  });

  it('patch golden: WALL00_3 shape + column-bytes sha256 (patch.test.ts)', () => {
    const patch = decodePatch(wad().readLumpByName('WALL00_3'));
    expect([patch.width, patch.height, patch.leftOffset, patch.topOffset]).toEqual([16, 128, 8, 123]);
    expect(shaOfPatchColumns(wad(), 'WALL00_3')).toBe(
      'f2bdf067c09848524c32f81453b05114ac92fa6e9667999bffe5e8b686213de1',
    );
  });

  it('composed-texture golden: BIGDOOR1 dimensions + columns sha256', () => {
    const big = texturesFromWad(wad()).get('BIGDOOR1')!;
    expect([big.width, big.height, big.patches.length]).toEqual([128, 96, 5]);
    expect(sha256Columns(big)).toBe(
      'e736eab3cc661a00a3bca630db050985163338fdd1b34010fef5eb09c1286ff7',
    );
  });
});
