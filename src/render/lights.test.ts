/**
 * render/lights tests (M3-01): R_InitLightTables zlight (r_main.c:614-642),
 * the R_ExecuteSetViewSize scalelight rebuild (r_main.c:744-759), and the
 * R_StoreWallRange pancake lightnum (r_segs.c:122-134). R03 §10, R02 §4.
 *
 * CONSUMERS (pinned per M3-plan §M3-01 acceptance 5): walls consume
 * `scalelight` (per-column `rw_scale >> LIGHTSCALESHIFT`, r_segs.c), sprites
 * too (r_things.c); `zlight` is BUILT and golden-tested HERE but consumed by
 * M4 flat planes (`planezlight = zlight[light]`, r_plane.c:436).
 *
 * Golden method (acceptance 1): the sha256 over each table's little-endian
 * bytes must match the sha256 of an INDEPENDENT BigInt recompute — the
 * closed forms zAdd(i,j) = floor(80/(j+1)) and sAdd(i,j) = floor(j/2)
 * (viewwidth 320, detailshift 0), derived from the C chains:
 *   zlight: trunc(trunc(10/(j+1)*2^16) >> 12 >> 1) = floor(2^20/8192/(j+1))
 *           = floor(80/(j+1))          (nested integer floors compose)
 *   scalelight: ((j*320)/320)/2 = floor(j/2)
 * `startmap = ((15-i)*2)*32/16` = (15-i)*4 — the C chain is authoritative
 * (R03 §10's "(15-level)*2" shorthand is off by 2x; corrected here).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { COLORMAP_BYTES } from '../wad/palettes';
import {
  COLORMAP_STRIDE,
  executeSetViewSize,
  initLightTables,
  LIGHTLEVELS,
  LIGHTSEGSHIFT,
  LIGHTSCALESHIFT,
  LIGHTZSHIFT,
  MAXLIGHTSCALE,
  MAXLIGHTZ,
  NUMCOLORMAPS,
  wallLightNum,
  type LightTables
} from './lights';
import { RENDER_WIDTH } from './framebuffer';

// sha256 of the oracle tables (independent BigInt closed forms, computed at
// authoring time by the script in the M3-01 report; re-derived in-test below).
const GOLDEN_ZLIGHT_SHA256 = 'a226656991ad6ce6d2536ec84ab486479bee4158e4585beae5ad7dff38faee00';
const GOLDEN_SCALELIGHT_SHA256 = 'd6c8ecd1d0f13e9aa747af89740128467d51ad913ffb828130db58992ff43902';

function sha256(t: Uint32Array): string {
  return createHash('sha256').update(new Uint8Array(t.buffer)).digest('hex');
}

/** Independent oracle: BigInt closed forms, no reuse of lights.ts code. */
function oracleZlight(): Uint32Array {
  const z = new Uint32Array(LIGHTLEVELS * MAXLIGHTZ);
  for (let i = 0; i < LIGHTLEVELS; i++) {
    const startmap = Number((BigInt((15 - i) * 2) * BigInt(NUMCOLORMAPS)) / BigInt(LIGHTLEVELS));
    for (let j = 0; j < MAXLIGHTZ; j++) {
      let level = startmap - Number(80n / BigInt(j + 1));
      if (level < 0) level = 0;
      if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
      z[i * MAXLIGHTZ + j] = level * 256;
    }
  }
  return z;
}

function oracleScalelight(viewwidth: number = RENDER_WIDTH): Uint32Array {
  const s = new Uint32Array(LIGHTLEVELS * MAXLIGHTSCALE);
  for (let i = 0; i < LIGHTLEVELS; i++) {
    const startmap = Number((BigInt((15 - i) * 2) * BigInt(NUMCOLORMAPS)) / BigInt(LIGHTLEVELS));
    for (let j = 0; j < MAXLIGHTSCALE; j++) {
      let level =
        startmap - Number((BigInt(j * RENDER_WIDTH) / BigInt(viewwidth)) / 2n);
      if (level < 0) level = 0;
      if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
      s[i * MAXLIGHTSCALE + j] = level * 256;
    }
  }
  return s;
}

function synthColormaps(): Uint8Array {
  const rows = new Uint8Array(COLORMAP_BYTES);
  for (let i = 0; i < rows.length; i++) rows[i] = (i * 31 + (i >> 8) * 7) & 0xff;
  return rows;
}

describe('constants (r_main.h:69-75/84, r_main.c:612)', () => {
  it('match vanilla', () => {
    expect({ LIGHTLEVELS, LIGHTSEGSHIFT, MAXLIGHTSCALE, LIGHTSCALESHIFT }).toEqual({
      LIGHTLEVELS: 16,
      LIGHTSEGSHIFT: 4,
      MAXLIGHTSCALE: 48,
      LIGHTSCALESHIFT: 12,
    });
    expect({ MAXLIGHTZ, LIGHTZSHIFT, NUMCOLORMAPS, COLORMAP_STRIDE }).toEqual({
      MAXLIGHTZ: 128,
      LIGHTZSHIFT: 20,
      NUMCOLORMAPS: 32,
      COLORMAP_STRIDE: 256,
    });
  });
});

describe('initLightTables', () => {
  const rows = synthColormaps();
  const t: LightTables = initLightTables(rows);

  // Acceptance 1 — sha256 vs in-test BigInt recompute (+ pinned goldens).
  it('zlight sha256 matches the independent BigInt oracle + pinned golden', () => {
    expect(sha256(t.zlight)).toBe(sha256(oracleZlight()));
    expect(sha256(t.zlight)).toBe(GOLDEN_ZLIGHT_SHA256);
  });
  it('scalelight sha256 matches the independent BigInt oracle + pinned golden', () => {
    expect(sha256(t.scalelight)).toBe(sha256(oracleScalelight()));
    expect(sha256(t.scalelight)).toBe(GOLDEN_SCALELIGHT_SHA256);
  });

  // Acceptance 2 — every level clamped into 0..31.
  it('all offsets are multiples of 256 with level in [0,31]', () => {
    expect(t.zlight.length).toBe(LIGHTLEVELS * MAXLIGHTZ);
    expect(t.scalelight.length).toBe(LIGHTLEVELS * MAXLIGHTSCALE);
    for (const tbl of [t.zlight, t.scalelight]) {
      for (const off of tbl) {
        expect(off % 256).toBe(0);
        expect(off / 256).toBeGreaterThanOrEqual(0);
        expect(off / 256).toBeLessThanOrEqual(NUMCOLORMAPS - 1);
      }
    }
  });

  // Acceptance 3 — row identity: startmap(15) = 0 ⇒ level clamps to 0 across
  // the row, so scalelight[15][j] (and zlight[15][j]) are row 0 (offset 0).
  // startmap C truth: ((15-i)*2)*32/16 = (15-i)*4 (i=0 → 60 → clamps to 31).
  it('row 15 is all-row-0 identity; row 0 saturates dark end', () => {
    for (let j = 0; j < MAXLIGHTSCALE; j++) expect(t.scalelight[15 * MAXLIGHTSCALE + j]).toBe(0);
    for (let j = 0; j < MAXLIGHTZ; j++) expect(t.zlight[15 * MAXLIGHTZ + j]).toBe(0);
    expect(t.scalelight[0]).toBe(31 * 256); // i=0,j=0: 60-0 → clamp 31
    // zlight i=0 j=0: 60 - 80 → 0 (far-distance bright?? no: near→big add→dark… clamps 0)
    expect(t.zlight[0]).toBe(0);
    expect(t.zlight[8 * MAXLIGHTZ + 7]).toBe((28 - 10) * 256); // (15-8)*4 - 80/8
  });

  it('colormaps is the identity pass-through of all 34 rows (R_InitColormaps truth)', () => {
    // r_data.c:631-643 loads the 8704-byte lump verbatim — NOT a 32-row
    // replication; rows 32 (INVERSECOLORMAP) / 33 must survive for
    // fixedcolormap.
    expect(t.colormaps).toBe(rows);
    expect(t.colormaps.length).toBe(COLORMAP_BYTES);
  });

  it('scalelightfixed exists at MAXLIGHTSCALE, zero-filled (fixed in R_SetupFrame, M5)', () => {
    expect(t.scalelightfixed.length).toBe(MAXLIGHTSCALE);
    expect(t.scalelightfixed.every((v) => v === 0)).toBe(true);
  });

  it('rejects malformed inputs', () => {
    expect(() => initLightTables(new Uint8Array(COLORMAP_BYTES - 256))).toThrow(RangeError);
    expect(() => initLightTables(new Uint8Array(32 * 256))).toThrow(RangeError);
    expect(() => initLightTables(rows, 0)).toThrow(RangeError);
    expect(() => executeSetViewSize(t, 1.5)).toThrow(RangeError);
  });
});

describe('executeSetViewSize recompute (acceptance 1, viewwidth parameter)', () => {
  it('halved viewwidth rebuilds scalelight = clamp(startmap - j)', () => {
    const t = initLightTables(synthColormaps());
    const before = sha256(t.scalelight);
    executeSetViewSize(t, 160); // j*320/160/2 = j (detailshift fixed 0)
    expect(sha256(t.scalelight)).not.toBe(before);
    expect(sha256(t.scalelight)).toBe(sha256(oracleScalelight(160)));
    // zlight is view-independent (R_InitLightTables static).
    expect(sha256(t.zlight)).toBe(GOLDEN_ZLIGHT_SHA256);
  });
});

describe('wallLightNum pancake (r_segs.c:122-134)', () => {
  // Acceptance 4 — raw lightnum deltas BEFORE clamp, bucket base 8 (light 128).
  it('horizontal −1, vertical +1, diagonal 0 (raw, pre-clamp)', () => {
    expect(wallLightNum(128, 0, 0, 64, 128, 64)).toEqual({ lightnum: 7, row: 7 }); // v1y==v2y
    expect(wallLightNum(128, 0, 128, 0, 128, 128)).toEqual({ lightnum: 9, row: 9 }); // v1x==v2x
    expect(wallLightNum(128, 0, 0, 0, 128, 128)).toEqual({ lightnum: 8, row: 8 }); // diagonal
  });
  it('extralight adds before the pancake', () => {
    expect(wallLightNum(128, 2, 0, 64, 128, 64).lightnum).toBe(8 + 2 - 1);
  });
  it('clamps: <0 → row 0, >=16 → row 15 (walllights = scalelight[0]/[15])', () => {
    expect(wallLightNum(0, 0, 0, 64, 128, 64)).toEqual({ lightnum: -1, row: 0 });
    expect(wallLightNum(255, 0, 128, 0, 128, 128)).toEqual({ lightnum: 16, row: 15 });
    expect(wallLightNum(255, 2, 128, 0, 128, 128).row).toBe(15);
  });
  it('zero-length line takes the horizontal (−1) branch — C else-if order', () => {
    expect(wallLightNum(128, 0, 10, 10, 10, 10).lightnum).toBe(7);
  });
});
