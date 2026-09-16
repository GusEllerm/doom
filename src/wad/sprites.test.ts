/**
 * M1-07 tests — sprite lump census + frame/rotation naming.
 *
 * Grammar and install rules are pinned to r_things.c via R02 §8 / R06 §4:
 * `SSSSFR[fr]`, rotation 0 = all 8 views, 1..8 = one octant, chars 6-7 =
 * the same lump installed mirrored. Mirror *pairs* are the bilateral-view
 * sets {2,8} {3,7} {4,6} (plus the self-mirror digits 1 and 5), verified
 * against freedoom1.wad (182 8-char names out of 853 sprite lumps) — the
 * flip flag simply marks which slot draws the patch right-to-left, exactly
 * like vanilla `sprframe->flip[rot]`.
 *
 * Real-IWAD goldens auto-skip when wads/freedoom1.wad is absent.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildSmallWad, patch2x2 } from '../../tests/fixtures/smallWads';
import { WadBuilder, type WadLumpSource } from '../../tests/fixtures/wadWriter';
import { WadFile } from './wadfile';

import {
  buildSpriteDefs,
  frameLetter,
  MAX_SPRITE_FRAMES,
  parseSpriteLumpName,
  SpriteNameError,
  type LumpSite,
  type SpriteCensus,
} from './sprites';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Build an IWAD whose sprite block is exactly `lumps` (markers added here). */
function wadWithSprites(lumps: WadLumpSource[], withEndMarker = true): WadFile {
  const wad = new WadBuilder('IWAD');
  wad.addLumpMarker('S_START');
  for (const lump of lumps) {
    if (lump.data === undefined) wad.addLumpMarker(lump.name);
    else wad.addLump(lump.name, lump.data);
  }
  if (withEndMarker) wad.addLumpMarker('S_END');
  return WadFile.parse(wad.build().buffer as ArrayBuffer);
}

/** Small helper: flip slots as a plain number array. */
function flips(frame: { flip: Uint8Array }): number[] {
  return Array.from(frame.flip);
}

/** Small helper: lump slots of a frame. */
function lumps(frame: { lump: readonly number[] }): number[] {
  return [...frame.lump];
}

/** Mirror-partner rotation digit per r_things.c naming (2↔8, 3↔7, 4↔6, 1↔5). */
function mirrorDigit(digit: number): number {
  return ((9 - digit) % 8) + 1;
}

/**
 * Notes that only say "this fixture frame is not a complete 8-view set".
 * Partial fixture WADs trigger them by design; the tests that care about
 * *other* problems filter them out (a real WAD, like freedoom1, has none).
 */
function incompleteNotes(warnings: readonly string[]): string[] {
  return warnings.filter((w) => /missing rotation|has no lumps/.test(w));
}

/* ------------------------------------------------------------------ */
/* parseSpriteLumpName                                                */
/* ------------------------------------------------------------------ */

describe('parseSpriteLumpName', () => {
  it('parses plain 6-char names (SSSSFR)', () => {
    expect(parseSpriteLumpName('BOSSA1')).toEqual({
      name4: 'BOSS',
      installs: [{ frame: 0, rotation: 1, flip: false }],
    });
    expect(parseSpriteLumpName('BON1A0')).toEqual({
      name4: 'BON1',
      installs: [{ frame: 0, rotation: 0, flip: false }],
    });
    // Frame letter index is letter-'A' (acceptance 4).
    expect(parseSpriteLumpName('PLAYC7')).toEqual({
      name4: 'PLAY',
      installs: [{ frame: 2, rotation: 7, flip: false }],
    });
  });

  it('parses 8-char mirror-pair names (SSSSFRfr), direct install first', () => {
    expect(parseSpriteLumpName('TROOA2A8')).toEqual({
      name4: 'TROO',
      installs: [
        { frame: 0, rotation: 2, flip: false },
        { frame: 0, rotation: 8, flip: true },
      ],
    });
    expect(parseSpriteLumpName('PLAYB2B8')).toEqual({
      name4: 'PLAY',
      installs: [
        { frame: 1, rotation: 2, flip: false },
        { frame: 1, rotation: 8, flip: true },
      ],
    });
    // Chars 6-7 may name a DIFFERENT frame (r_things.c:228-234; R06 §4).
    expect(parseSpriteLumpName('TROOA1B8')).toEqual({
      name4: 'TROO',
      installs: [
        { frame: 0, rotation: 1, flip: false },
        { frame: 1, rotation: 8, flip: true },
      ],
    });
    // The mirrored pair may be listed first (freedoom1 has 24 such names,
    // e.g. 'A8A2'/'A7A3'/'A6A4'); the second pair is still the flipped one.
    expect(parseSpriteLumpName('BOSSA8A2').installs[1]).toEqual({
      frame: 0,
      rotation: 2,
      flip: true,
    });
  });

  it('normalizes case and lump-name padding', () => {
    expect(parseSpriteLumpName('playa2a8')).toMatchObject({ name4: 'PLAY' });
    expect(parseSpriteLumpName('BOSSA1\u0000')).toMatchObject({ name4: 'BOSS' });
    expect(parseSpriteLumpName('BOSSA1  ')).toMatchObject({ name4: 'BOSS' });
    // Mirrored pair digit 0 = "this patch, mirrored, for all views" (r_things.c:121-139).
    expect(parseSpriteLumpName('TROOA1A0').installs[1]).toEqual({
      frame: 0,
      rotation: 0,
      flip: true,
    });
  });

  it('mirror-pair digit table: partner(d) = ((9 - d) % 8) + 1', () => {
    // Geometry: mirroring maps slot i -> (8 - i) % 8, i = digit - 1, so the
    // bilateral pairs are {2,8} {3,7} {4,6} and digits 1/5 mirror themselves.
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(mirrorDigit)).toEqual([1, 8, 7, 6, 5, 4, 3, 2]);
    // The canonical 5-lump sprite therefore carries pairs 2/8, 3/7, 4/6.
    for (const direct of [2, 3, 4]) {
      const name = `TROOA${direct}A${mirrorDigit(direct)}`;
      expect(parseSpriteLumpName(name).installs.map((i) => i.rotation)).toEqual([
        direct,
        mirrorDigit(direct),
      ]);
    }
    // Self-mirror pair: front (1) and back (5) views of a 2-lump sprite.
    expect(parseSpriteLumpName('PLAYA1A5').installs).toEqual([
      { frame: 0, rotation: 1, flip: false },
      { frame: 0, rotation: 5, flip: true },
    ]);
  });

  it('rejects malformed names with a typed error', () => {
    const bad: [string, RegExp][] = [
      ['', /empty/],
      ['TROO', /6 .*8|SSSSFR/],
      ['TROOA', /6 .*8|SSSSFR/],
      ['TROOA1A', /6 .*8|SSSSFR/], // 7 chars: name[7] would be NUL padding
      ['TROOA123456789', /6 .*8|SSSSFR/], // 9 chars cannot exist in a dir entry
      ['TROOA9', /rotation 9/],
      ['TROOA1A9', /rotation 9/],
      ['TROOAA', /rotation character/],
      ['TR!OA1', /sprite name/],
      ['TROO!1', /frame character/],
      ['TROOA1#5', /#/], // 9-char/'#N' tooling variant is not vanilla naming
      ['TROO#1A0', /#/],
    ];
    for (const [name, pattern] of bad) {
      expect(() => parseSpriteLumpName(name), name).toThrow(SpriteNameError);
      expect(() => parseSpriteLumpName(name), name).toThrowError(pattern);
    }
  });

  it('frame letters A-Z are all below the 29-frame cap', () => {
    // `sprtemp[29]` (r_things.c:110-114) is unreachable through an 8-byte
    // lump name because a single letter tops out at 'Z' = 25.
    expect(MAX_SPRITE_FRAMES).toBe(29);
    expect(frameLetter(25)).toBe('Z');
    expect(parseSpriteLumpName('TROOZ0').installs[0]?.frame).toBe(25);
  });
});

/* ------------------------------------------------------------------ */
/* Census on fixture WADs                                             */
/* ------------------------------------------------------------------ */

describe('buildSpriteDefs (fixture WADs)', () => {
  it('small fixture WAD: names → frames → rotations, marker skipped', () => {
    const wad = WadFile.parse(buildSmallWad().buffer as ArrayBuffer);
    const bon1 = wad.lumpNumByName('BON1A0');
    const play = wad.lumpNumByName('PLAYA2A8');
    const marker = wad.lumpNumByName('S_FIX0');

    const census = buildSpriteDefs(wad);
    // PLAYA2A8 alone is an incomplete rotating frame → exactly those 6 notes.
    expect(census.warnings).toEqual([
      'sprite PLAY: frame A is missing rotation 1',
      'sprite PLAY: frame A is missing rotation 3',
      'sprite PLAY: frame A is missing rotation 4',
      'sprite PLAY: frame A is missing rotation 5',
      'sprite PLAY: frame A is missing rotation 6',
      'sprite PLAY: frame A is missing rotation 7',
    ]);
    // Two sprites, first-appearance order; the zero-size marker contributed none.
    expect(census.sprites.map((s) => s.name4)).toEqual(['BON1', 'PLAY']);
    expect([...census.byName.keys()]).toEqual(['BON1', 'PLAY']);
    expect(census.lumpSites.size).toBe(2);
    expect(census.lumpSites.has(marker)).toBe(false);
    expect(census.lumpToSprite.get(marker)).toBeUndefined();
    // Sounds/patches outside the range are not censused.
    expect(census.lumpToSprite.has(wad.lumpNumByName('FIXP0'))).toBe(false);
    expect(census.lumpToSprite.has(wad.lumpNumByName('DSFIX'))).toBe(false);

    const bon = census.byName.get('BON1')!;
    expect(bon.frames).toHaveLength(1);
    expect(bon.frames[0]!.rotate).toBe(false);
    // rot=0 lump fills all 8 slots with the same lump, unflipped.
    expect(lumps(bon.frames[0]!)).toEqual(Array(8).fill(bon1));
    expect(flips(bon.frames[0]!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);

    const pl = census.byName.get('PLAY')!;
    expect(pl.frames[0]!.rotate).toBe(true);
    expect(lumps(pl.frames[0]!)).toEqual([-1, play, -1, -1, -1, -1, -1, play]);
    expect(flips(pl.frames[0]!)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('canonical 5-lump rotating sprite fills 8 views with 3 mirror flags', () => {
    const wad = wadWithSprites(
      ['TROOA1', 'TROOA2A8', 'TROOA3A7', 'TROOA4A6', 'TROOA5'].map((name) => ({
        name,
        data: patch2x2(name.length + 0x5a0),
      })),
    );
    const census = buildSpriteDefs(wad);
    expect(census.warnings).toEqual([]);
    const id = (name: string): number => wad.lumpNumByName(name);
    const frame = census.byName.get('TROO')!.frames[0]!;
    expect(frame.rotate).toBe(true);
    expect(lumps(frame)).toEqual([
      id('TROOA1'),
      id('TROOA2A8'),
      id('TROOA3A7'),
      id('TROOA4A6'),
      id('TROOA5'),
      id('TROOA4A6'), // mirrored 6 = mirrored 4
      id('TROOA3A7'), // mirrored 7 = mirrored 3
      id('TROOA2A8'), // mirrored 8 = mirrored 2
    ]);
    expect(flips(frame)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    // A mirrored install never copies another lump: both slots name the same one.
    const sites = census.lumpSites.get(id('TROOA3A7'))!;
    expect(sites).toHaveLength(2);
    expect(sites.map((s) => [s.rot, s.flip])).toEqual([
      [2, false],
      [6, true],
    ]);
    // Primary reverse mapping prefers the direct (non-mirrored) site.
    expect(census.lumpToSprite.get(id('TROOA3A7'))).toEqual({
      sprite: 0,
      frame: 0,
      rot: 2,
      flip: false,
    } satisfies LumpSite);
  });

  it('self-mirror pair A1A5 yields front + mirrored back views only', () => {
    const wad = wadWithSprites([{ name: 'PLAYA1A5', data: patch2x2(0x11) }]);
    const census = buildSpriteDefs(wad);
    // Digits 2,3,4,6,7,8 stay empty — vanilla would I_Error, we note them.
    expect(incompleteNotes(census.warnings)).toHaveLength(6);
    expect(census.warnings.length).toBe(6);
    const lump = wad.lumpNumByName('PLAYA1A5');
    const frame = census.byName.get('PLAY')!.frames[0]!;
    expect(frame.rotate).toBe(true);
    expect(lumps(frame)).toEqual([lump, -1, -1, -1, lump, -1, -1, -1]);
    expect(flips(frame)).toEqual([0, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('mirrored install may target another frame (TROOA1B8)', () => {
    const wad = wadWithSprites([{ name: 'TROOA1B8', data: patch2x2(0x22) }]);
    const census = buildSpriteDefs(wad);
    const lump = wad.lumpNumByName('TROOA1B8');
    const [frameA, frameB] = census.byName.get('TROO')!.frames;
    // Chars 4-5 install like any direct rotation…
    expect(frameA!.rotate).toBe(true);
    expect(lumps(frameA!)).toEqual([lump, -1, -1, -1, -1, -1, -1, -1]);
    // …while chars 6-7 put the SAME lump, mirrored, in frame B's slot 7.
    expect(lumps(frameB!)).toEqual([-1, -1, -1, -1, -1, -1, -1, lump]);
    expect(flips(frameB!)).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(census.lumpSites.get(lump)).toEqual([
      { sprite: 0, frame: 0, rot: 0, flip: false },
      { sprite: 0, frame: 1, rot: 7, flip: true },
    ] satisfies LumpSite[]);
    // Both frames are incomplete (7 empty views each) → tolerated + noted.
    expect(incompleteNotes(census.warnings)).toHaveLength(14);
    expect(census.warnings.length).toBe(14);
  });

  it('frame index equals letter - A, so a hole keeps later frames in place', () => {
    const wad = wadWithSprites([
      { name: 'TROOA0', data: patch2x2(0x31) },
      { name: 'TROOC0', data: patch2x2(0x32) },
    ]);
    const census = buildSpriteDefs(wad);
    const troo = census.byName.get('TROO')!;
    expect(troo.frames).toHaveLength(3);
    expect(lumps(troo.frames[1]!)).toEqual(Array(8).fill(-1));
    expect(troo.frames[1]!.rotate).toBe(false);
    expect(lumps(troo.frames[2]!)).toEqual(Array(8).fill(wad.lumpNumByName('TROOC0')));
    expect(census.warnings.some((w) => w.includes('frame B has no lumps'))).toBe(true);
    expect(incompleteNotes(census.warnings)).toEqual(census.warnings);
  });

  it('tolerates junk lumps: skip + warnings, keep the good ones', () => {
    const wad = wadWithSprites([
      { name: 'BOSS', data: patch2x2(1) }, // too short
      { name: 'BOSSA', data: patch2x2(2) }, // too short
      { name: 'BOSSAA', data: patch2x2(3) }, // rotation char not a digit
      { name: 'BOSSA9', data: patch2x2(4) }, // rotation 9
      { name: 'BOSGA1A', data: patch2x2(5) }, // 7 chars
      { name: 'BOSGA1#5', data: patch2x2(6) }, // '#' variant suffix
      { name: 'BO!SA1', data: patch2x2(7) }, // bad 4CC
      { name: 'BOSEA1', data: patch2x2(8) }, // good
      { name: 'BOSEA2A8', data: patch2x2(9) }, // good
    ]);
    const census = buildSpriteDefs(wad);
    expect([...census.byName.keys()]).toEqual(['BOSE']);
    // 7 malformed names + 5 empty views of the partial BOSE frame.
    expect(census.warnings).toHaveLength(12);
    expect(incompleteNotes(census.warnings)).toHaveLength(5);
    // Every warning names the offending lump so a tool can report it.
    for (const name of ['BOSS', 'BOSSA', 'BOSSAA', 'BOSSA9', 'BOSGA1A', 'BOSGA1#5', 'BO!SA1']) {
      const lump = wad.lumpNumByName(name);
      expect(census.warnings.some((w) => w.includes(`lump ${lump} '${name}'`)), name).toBe(true);
    }
    const frame = census.byName.get('BOSE')!.frames[0]!;
    expect(lumps(frame)).toEqual([
      wad.lumpNumByName('BOSEA1'),
      wad.lumpNumByName('BOSEA2A8'),
      -1,
      -1,
      -1,
      -1,
      -1,
      wad.lumpNumByName('BOSEA2A8'),
    ]);
  });

  it('conflicts keep the first install and warn (vanilla I_Error cases)', () => {
    // Duplicate rotation slot.
    const dup = wadWithSprites([
      { name: 'PLAYA2', data: patch2x2(0x41) },
      { name: 'PLAYA2', data: patch2x2(0x42) },
    ]);
    const dupCensus = buildSpriteDefs(dup);
    // Directory order: S_START=0, PLAYA2=1, PLAYA2=2, S_END=3 → first wins.
    expect(lumps(dupCensus.byName.get('PLAY')!.frames[0]!)[1]).toBe(1);
    expect(dupCensus.lumpSites.size).toBe(1);
    expect(dupCensus.warnings.some((w) => w.includes('already has lump'))).toBe(true);

    // rot=0 lump mixed into a rotating frame (and vice versa).
    const mixed1 = wadWithSprites([
      { name: 'PLAYA1', data: patch2x2(0x51) },
      { name: 'PLAYA0', data: patch2x2(0x52) },
    ]);
    const mixed1Frame = buildSpriteDefs(mixed1).byName.get('PLAY')!.frames[0]!;
    expect(mixed1Frame.rotate).toBe(true);
    expect(lumps(mixed1Frame)[0]).toBe(mixed1.lumpNumByName('PLAYA1'));

    const mixed2 = wadWithSprites([
      { name: 'PLAYA0', data: patch2x2(0x53) },
      { name: 'PLAYA1', data: patch2x2(0x54) },
    ]);
    const mixed2Census = buildSpriteDefs(mixed2);
    const mixed2Frame = mixed2Census.byName.get('PLAY')!.frames[0]!;
    expect(mixed2Frame.rotate).toBe(false);
    expect(lumps(mixed2Frame)).toEqual(Array(8).fill(mixed2.lumpNumByName('PLAYA0')));
    expect(
      mixed2Census.warnings.some((w) => w.includes('rotations and a rot=0 lump')),
    ).toBe(true);
  });

  it('scans one S_START..S_END group (lumpRange resolves markers last-match-wins)', () => {
    const wad = new WadBuilder('PWAD');
    wad.addLumpMarker('S_START');
    wad.addLump('PLAYA1', patch2x2(0x61));
    wad.addLumpMarker('S_END');
    wad.addLumpMarker('S_START');
    wad.addLump('BOSSA1', patch2x2(0x62));
    wad.addLumpMarker('S_END');
    const census = buildSpriteDefs(WadFile.parse(wad.build().buffer as ArrayBuffer));
    // WadFile resolves markers last-match-wins (R01 §15.2), so the LAST group
    // wins; vanilla's firstspritelump keeps the first. Freedoom (and normal
    // IWAD+PWAD combos) have a single sprite group, so it never bites.
    expect(census.sprites.map((s) => s.name4)).toEqual(['BOSS']);
    // BOSSA1 alone = incomplete frame (7 notes), no other warnings.
    expect(census.warnings).toHaveLength(7);
    expect(incompleteNotes(census.warnings)).toEqual(census.warnings);
  });

  it('a WAD with no sprite markers yields an empty census', () => {
    const wad = WadFile.parse(new WadBuilder('PWAD').addLump('FOO', patch2x2(1)).build().buffer as ArrayBuffer);
    const census = buildSpriteDefs(wad);
    expect(census.sprites).toEqual([]);
    expect(census.byName.size).toBe(0);
    expect(census.lumpToSprite.size).toBe(0);
    expect(census.warnings).toEqual([]);
  });

  it('a missing S_END still scans to EOF', () => {
    const wad = wadWithSprites([{ name: 'PLAYA0', data: patch2x2(0x71) }], false);
    const census = buildSpriteDefs(wad);
    expect(census.sprites.map((s) => s.name4)).toEqual(['PLAY']);
    expect(census.warnings).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Real-IWAD census goldens (auto-skip without wads/freedoom1.wad)    */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

/**
 * Goldens recorded from wads/freedoom1.wad (Freedoom Phase 1, v0.13.0-era
 * file, 3163 lumps) with this exact census code:
 * - 853 lumps between S_START/S_END (matches R02 §10 item 8), 0 warnings;
 * - 113 unique 4CC sprite names (>= 100 required by the task brief);
 * - 440 sprite frames total, 85 of them rotating;
 * - 182 flip slots, i.e. exactly the 182 8-char mirrored names in R02 §10;
 * - TROO: 21 frames, frame A = 5 lumps covering all 8 views with flips
 *   [0,0,0,0,0,1,1,1] (pairs 2/8, 3/7, 4/6), frame I = rot=0 single view.
 */
const GOLDEN_SPRITE_LUMPS = 853;
const GOLDEN_UNIQUE_SPRITES = 113;
const GOLDEN_TOTAL_FRAMES = 440;
const GOLDEN_ROTATING_FRAMES = 85;
const GOLDEN_FLIP_SLOTS = 182;
const GOLDEN_TROO_FRAMES = 21;

describe.skipIf(!hasWad)('freedoom1.wad sprite census goldens', () => {
  // Built lazily: the suite callback is collected even when skipped, and the
  // 28 MB file must not be read when wads/freedoom1.wad is absent.
  let cached: SpriteCensus | undefined;
  function census(): SpriteCensus {
    cached ??= buildSpriteDefs(WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer));
    return cached;
  }

  it('censuses every sprite lump with zero warnings', () => {
    expect(census().warnings).toEqual([]);
    expect(census().lumpSites.size).toBe(GOLDEN_SPRITE_LUMPS);
    expect(census().sprites.length).toBeGreaterThanOrEqual(100);
    expect(census().sprites.length).toBe(GOLDEN_UNIQUE_SPRITES);
  });

  it('frame totals and mirror-slot count match the recorded goldens', () => {
    let totalFrames = 0;
    let rotating = 0;
    let flipSlots = 0;
    for (const sprite of census().sprites) {
      totalFrames += sprite.frames.length;
      for (const frame of sprite.frames) {
        if (frame.rotate) rotating++;
        flipSlots += Array.from(frame.flip).reduce((a, b) => a + b, 0);
        // Freedoom's rotating frames are complete (vanilla would I_Error).
        expect(frame.lump.every((lump) => lump >= 0)).toBe(true);
      }
    }
    expect(totalFrames).toBe(GOLDEN_TOTAL_FRAMES);
    expect(rotating).toBe(GOLDEN_ROTATING_FRAMES);
    expect(flipSlots).toBe(GOLDEN_FLIP_SLOTS);
  });

  it('TROO: 21 frames, 5-lump 8-view frame A, single-view rot=0 frames', () => {
    const troo = census().byName.get('TROO');
    expect(troo).toBeDefined();
    expect(troo!.frames).toHaveLength(GOLDEN_TROO_FRAMES);

    const a = troo!.frames[0]!;
    expect(a.rotate).toBe(true);
    expect(a.lump.every((lump) => lump >= 0)).toBe(true);
    expect(flips(a)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    // 5 distinct lumps cover the 8 views: slots 5,6,7 reuse 3,2,1.
    expect(new Set(a.lump).size).toBe(5);
    expect(a.lump[5]).toBe(a.lump[3]);
    expect(a.lump[6]).toBe(a.lump[2]);
    expect(a.lump[7]).toBe(a.lump[1]);
    const site = census().lumpToSprite.get(a.lump[7] as number)!;
    expect(site).toMatchObject({ frame: 0, rot: 1, flip: false });
    expect(census().lumpSites.get(a.lump[7] as number)).toHaveLength(2);

    // Frame I ('A' + 8) is a rot=0 single-view frame in freedoom's TROO.
    const i = troo!.frames[8]!;
    expect(i.rotate).toBe(false);
    expect(new Set(i.lump).size).toBe(1);
    expect(flips(i)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});
