/**
 * Tests for the UI patch census table — M9-01 (plan §M9-01 acceptance 1).
 *
 * L1 audit on freedoom1.wad (skipIf absent): EVERY §0.12-audited UI lump
 *  - exists,
 *  - decodes through patch.ts (whose post walk THROWS unless every column
 *    terminates on a 0xFF topdelta inside the lump — the acceptance's
 *    "posts walk terminates with 0xff on ALL columns" assert, r_defs.h
 *    :285-292),
 *  - and its vvideo.ts decodeVPatch header agrees field-for-field with
 *    the patch.ts reference decode (header-decode reuse check).
 * Plus: per-family counts pinned to the §0.12 measured census, and golden
 * sha256 of decoded column pixels for a 10-lump spot set.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decodePatch } from './patch';
import { UI_PATCH_FAMILIES, resolveUiPatchLumps, uiPatchNames } from './patches2';
import { decodeVPatch } from '../render/vvideo';
import { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Table shape (wad-free)                                              */
/* ------------------------------------------------------------------ */

describe('UI_PATCH_FAMILIES table', () => {
  it('declares every names-family at its declared count, no duplicate members', () => {
    const seen = new Set<string>();
    for (const fam of UI_PATCH_FAMILIES) {
      if (fam.names !== undefined) {
        expect(fam.names.length, fam.what).toBe(fam.count);
        for (const n of fam.names) {
          expect(seen.has(n), `duplicate census member ${n}`).toBe(false);
          seen.add(n);
          expect(n.length, `${n} exceeds the 8-char lump name`).toBeLessThanOrEqual(8);
        }
      }
    }
  });

  it('uiPatchNames is deduplicated and includes the §0.12 anchors', () => {
    const names = new Set(uiPatchNames());
    for (const anchor of ['STBAR', 'STARMS', 'STKEYS0', 'STTNUM9', 'STYSNUM0', 'STGNUM5', 'STFB3', 'STFST42', 'STFGOD0', 'STCFN065', 'M_SKULL2', 'WIMAP2', 'WILV38', 'WINUM9', 'TITLEPIC', 'HELP2']) {
      expect(names.has(anchor), anchor).toBe(true);
    }
    expect(names.size).toBe(uiPatchNames().length);
  });

  it('faces family generates the 42-lump st_stuff.c set (st_stuff.h ST_NUMFACES)', () => {
    const fam = UI_PATCH_FAMILIES.find((f) => f.what === 'face set')!;
    expect(fam.names!.length).toBe(42);
    expect(new Set(fam.names).size).toBe(42);
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad audit (skipped when the WAD is absent)                 */
/* ------------------------------------------------------------------ */

const WAD_PATH = process.env.FREEDOOM1_WAD ?? fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad UI lump audit (acceptance 1)', () => {
  const wad: WadFile | null = hasWad ? WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer) : null;

  it('every explicit census name is present', () => {
    for (const name of uiPatchNames()) {
      expect(wad!.lumpNumByName(name) >= 0, `missing lump ${name}`).toBe(true);
    }
  });

  it('per-family counts match the §0.12 measured census on the pinned wad', () => {
    const rows = resolveUiPatchLumps(wad!);
    const byName = new Map(rows.map((r) => [r.name, r]));
    expect(byName.size).toBe(rows.length);
    for (const fam of UI_PATCH_FAMILIES) {
      const members = rows.filter((r) => r.what === fam.what).length;
      expect(members, `${fam.what} count`).toBe(fam.count);
    }
    // The Crispy superset guard: the wad has 82 M_* lumps but the menu
    // census is the 29-lump vanilla set (§0.12 GOTCHA).
    let mStar = 0;
    for (let n = 0; wad!.lumpNumAt(n) >= 0; n += 1) {
      if (wad!.lumpName(n).toUpperCase().startsWith('M_')) mStar += 1;
    }
    expect(mStar).toBeGreaterThan(29);
  });

  it('ALL census lumps decode: sane headers + post walk terminates on 0xFF in every column', () => {
    let columnsWalked = 0;
    for (const { name } of resolveUiPatchLumps(wad!)) {
      const bytes = wad!.readLumpByName(name);
      const patch = decodePatch(bytes); // throws unless every column hits 0xFF in-lump
      expect(patch.width, name).toBeGreaterThan(0);
      expect(patch.height, name).toBeGreaterThan(0);
      expect(patch.width * patch.height, `${name} area`).toBeLessThanOrEqual(320 * 200);
      expect(patch.columns.length, name).toBe(patch.width);
      columnsWalked += patch.width;
      // header agreement: vvideo's cache decode === patch.ts decode
      const vp = decodeVPatch(bytes, name);
      expect([vp.width, vp.height, vp.leftOffset, vp.topOffset], name).toEqual([
        patch.width,
        patch.height,
        patch.leftOffset,
        patch.topOffset,
      ]);
    }
    expect(columnsWalked).toBeGreaterThan(10000); // ~15k columns audited
  });

  it('10-lump spot set decodes to the golden pixel sha256s', () => {
    // Recorded from wads/freedoom1.wad (sha256 7323bcc1…703d) via the
    // tested decodePatch walk; joined = columns[c] stacked at c*height.
    const GOLDEN: Record<string, { w: number; h: number; lo: number; to: number; sha256: string }> = {
      STBAR: { w: 320, h: 32, lo: 0, to: 0, sha256: '23b3b2eb9162e8d9138b674725c760b2c50ca77018a0c7e4433e6015bc1971d9' },
      STARMS: { w: 38, h: 32, lo: 0, to: 0, sha256: 'ce9f57bfd148ce6ba390b36713a14a1e61f4e852c099df5b75403fa4deddd355' },
      STTNUM0: { w: 13, h: 16, lo: 0, to: 0, sha256: '584d89ee16b70edd52d3e8a92e67ff00590c77bff21bd9704ba4152c625b6b1c' },
      STFST01: { w: 24, h: 29, lo: -5, to: -2, sha256: '86278f59edd43d9fbe8586f88920284c6aa30e552d65b06258ec5497f537c441' },
      STCFN065: { w: 9, h: 7, lo: 0, to: 0, sha256: 'bf90fb79b7ffc541d9effb039f2d4565ad32e714de9002551ec62adc10efc964' },
      M_DOOM: { w: 159, h: 37, lo: 13, to: -16, sha256: '04d36f468e2022577321645be560e161c0df73a9c3faa60f0f7fb61042607c66' },
      M_SKULL1: { w: 20, h: 19, lo: 0, to: -1, sha256: 'eb06192cd931b34dfc34c72e08ba0169ddf90874fcd5d66acbef92332d86393a' },
      WILV00: { w: 123, h: 15, lo: 0, to: 0, sha256: '8fe5795857759b469bc7dccdd7aa9887a3ab940baafd05d9c1b4c96513da441c' },
      WISPLAT: { w: 1, h: 1, lo: 0, to: 0, sha256: '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d' },
      TITLEPIC: { w: 320, h: 200, lo: 0, to: 0, sha256: '8cdb6ac51e21dd5fe054c13ce5770b3795cd9a953a21b0a0e0140b12b49dce45' },
    };
    for (const [name, g] of Object.entries(GOLDEN)) {
      const p = decodePatch(wad!.readLumpByName(name));
      const joined = new Uint8Array(p.width * p.height);
      for (let c = 0; c < p.width; c += 1) joined.set(p.columns[c]!, c * p.height);
      expect(
        { w: p.width, h: p.height, lo: p.leftOffset, to: p.topOffset, sha256: createHash('sha256').update(joined).digest('hex') },
        name,
      ).toEqual(g);
    }
  });
});
