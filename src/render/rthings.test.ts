/**
 * M4-03 — static thing/sprite tables (M4-plan §M4-03 acceptance).
 *
 *  1. Rotation/flip table round-trip vs the `wad/sprites.ts` census:
 *     `PLAYA2A8`-style mirror pair ⇒ same lump in both slots, flip only on
 *     the mirrored half; rot-0 lump fills all 8 slots; duplicate-slot and
 *     rot0/digit tolerance notes survive into `installSprites`; every
 *     census frame tuple equals the installed slice (fixture S_START WAD
 *     and — skipIf — freedoom1).
 *  2. 8-rotation selection `rot = (ang - thingangle + 9·(ANG45/2)) >> 29`
 *     (r_things.c:522-523) vs hand-computed octants, incl. the unsigned
 *     wrap-around cases.
 *  3. E1M1 (skipIf): thing list counts per the P_SpawnMapThing classification
 *     (zero monsters, markers skipped, committed unknown-id list EMPTY),
 *     `floorZ` = containing sector floor for 1000 sampled things via the
 *     merged BSP point locator, sector linked lists consistent.
 *  4. Zero-allocation steady state on the per-frame lookup paths
 *     (buffer-identity + wall-clock probe, cols.test.ts idiom).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WadFile } from '../wad/wadfile';
import { buildSpriteDefs } from '../wad/sprites';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData, mapThingAt } from '../sim/map';
import { sectorAtPoint } from '../sim/bsp';
import { WadBuilder } from '../../tests/fixtures/wadWriter';
import { patch2x2 } from '../../tests/fixtures/smallWads';
import { buildMapLumps, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import {
  buildStaticThings,
  frameFlip,
  frameLump,
  frameRotates,
  installSprites,
  lookupFrame,
  rotationFromAngles,
  thingAngleDegrees,
  thingTypeIndex,
  THING_FRAMES,
  THING_KINDS,
  THING_SPRITE4,
  THING_TYPES,
  KIND_MARKER,
  KIND_MONSTER,
  KIND_STATIC,
  ROTATION_BIAS,
  type InstalledSprites,
} from './rthings';
import { ANG180, ANG45, FRACUNIT } from '../core/constants';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Lumps between S_START/S_END with deterministic pseudo-distinct bytes. */
function spriteWad(names: readonly string[]): WadFile {
  const wad = new WadBuilder('IWAD');
  wad.addLumpMarker('S_START');
  names.forEach((n, i) => wad.addLump(n, patch2x2(0x5a0 + i)));
  wad.addLumpMarker('S_END');
  return WadFile.parse(wad.build().buffer as ArrayBuffer);
}

/** Flatten one installed frame back to the census tuple shape. */
function installedLumps(t: InstalledSprites, gf: number): number[] {
  return Array.from({ length: 8 }, (_, r) => frameLump(t, gf, r));
}
function installedFlips(t: InstalledSprites, gf: number): number[] {
  return Array.from({ length: 8 }, (_, r) => frameFlip(t, gf, r));
}

/* ------------------------------------------------------------------ */
/* 1. Rotation table round-trip (fixture S_START pairs, r_things.c    */
/*    R_InstallSpriteLump control flow)                               */
/* ------------------------------------------------------------------ */

describe('installSprites — census round-trip (fixture S_START)', () => {
  // Mirror pair (PLAYA2A8 style), rot0, dup slot, rot0+digit mix, hole.
  const wad = spriteWad([
    'BON1A0', // rot=0 → all 8 slots
    'PLAYA1',
    'PLAYA2A8', // slot 1 direct + slot 7 mirrored, SAME lump
    'PLAYA3A7',
    'PLAYA4A6',
    'PLAYA5',
    'DUP1A1',
    'DUP1A1A2', // slot 0 + mirrored slot 1
    'DUP1A2', // second claim on slot 1 → first install wins
    'MIX1A0',
    'MIX1A1', // rot0 mixed with a digit → digit skipped, rot0 stands
    'HOLEA1',
    'HOLEA2',
    'HOLEA3',
    'HOLEA4',
    'HOLEA5',
    'HOLEA6',
    'HOLEA7',
    'HOLEA8',
    'HOLEC1', // frame B is a hole (index preserved)
    'HOLEC2',
    'HOLEC3',
    'HOLEC4',
    'HOLEC5',
    'HOLEC6',
    'HOLEC7',
    'HOLEC8',
  ]);
  const census = buildSpriteDefs(wad);
  const t = installSprites(census);

  it('sprite numbering follows census first-lump order', () => {
    expect(t.count).toBe(census.sprites.length);
    expect([...t.name4]).toEqual(census.sprites.map((s) => s.name4));
    expect(t.indexOf.get('PLAY')).toBe(t.indexOf.get(census.sprites[1]!.name4));
  });

  it('PLAYA2A8-style pair: same lump in both slots, flip on the mirror half', () => {
    const play = t.indexOf.get('PLAY')!;
    const gf = lookupFrame(t, play, 0)!;
    const p2a8 = wad.lumpNumByName('PLAYA2A8');
    expect(gf).toBe(1); // second sprite, frame A
    expect(installedLumps(t, gf)).toEqual([
      wad.lumpNumByName('PLAYA1'),
      p2a8,
      wad.lumpNumByName('PLAYA3A7'),
      wad.lumpNumByName('PLAYA4A6'),
      wad.lumpNumByName('PLAYA5'),
      wad.lumpNumByName('PLAYA4A6'),
      wad.lumpNumByName('PLAYA3A7'),
      p2a8,
    ]);
    expect(installedFlips(t, gf)).toEqual([0, 0, 0, 0, 0, 1, 1, 1]);
    expect(frameRotates(t, gf)).toBe(1);
    // Both mirror slots reference the SAME lump (no slot copying).
    expect(frameLump(t, gf, 7)).toBe(frameLump(t, gf, 1));
    expect(frameFlip(t, gf, 7)).toBe(1);
    expect(frameFlip(t, gf, 1)).toBe(0);
  });

  it('rot=0 lump fills all 8 slots unflipped, rotate=false', () => {
    const gf = lookupFrame(t, t.indexOf.get('BON1')!, 0)!;
    expect(frameRotates(t, gf)).toBe(0);
    const bon = wad.lumpNumByName('BON1A0');
    expect(installedLumps(t, gf)).toEqual(Array(8).fill(bon));
    expect(installedFlips(t, gf)).toEqual(Array(8).fill(0));
  });

  it('duplicate slot + rot0-mix tolerance notes survive from the census', () => {
    // r_things.c:132-151 I_Error cases → first install wins + warnings.
    expect(t.warnings.some((w) => w.includes('DUP1') && w.includes('rotation 2'))).toBe(true);
    expect(t.warnings.some((w) => w.includes('MIX1') && w.includes('rot=0'))).toBe(true);
    const dup = lookupFrame(t, t.indexOf.get('DUP1')!, 0)!;
    const dup1a1a2 = wad.lumpNumByName('DUP1A1A2');
    expect(installedLumps(t, dup)).toEqual([
      wad.lumpNumByName('DUP1A1'),
      dup1a1a2, // first claimant keeps slot 1
      -1, -1, -1, -1, -1, -1,
    ]);
    expect(installedFlips(t, dup)).toEqual([0, 1, 0, 0, 0, 0, 0, 0]);
    const mix = lookupFrame(t, t.indexOf.get('MIX1')!, 0)!;
    expect(frameRotates(t, mix)).toBe(0); // rot0 stands, digit rejected
    expect(installedLumps(t, mix)).toEqual(Array(8).fill(wad.lumpNumByName('MIX1A0')));
  });

  it('frame hole keeps its index (HOLEA*/HOLEC* → frame B all -1)', () => {
    const hole = t.indexOf.get('HOLE')!;
    expect(lookupFrame(t, hole, 0)).toBe(t.frameStart[hole]);
    expect(lookupFrame(t, hole, 1)).toBe(t.frameStart[hole]! + 1);
    expect(lookupFrame(t, hole, 2)).toBe(t.frameStart[hole]! + 2);
    expect(lookupFrame(t, hole, 3)).toBe(-1); // past numFrames
    expect(installedLumps(t, lookupFrame(t, hole, 1)!)).toEqual(Array(8).fill(-1));
    expect(frameRotates(t, lookupFrame(t, hole, 1)!)).toBe(0);
    // census warned about the hole; frame C (index 2) is intact.
    expect(t.warnings.some((w) => w.includes('HOLE') && w.includes('frame B'))).toBe(true);
    expect(installedLumps(t, lookupFrame(t, hole, 2)!).filter((l) => l >= 0)).toHaveLength(8);
  });

  it('lookupFrame rejects out-of-range sprite/frame (vanilla RANGECHECK I_Error)', () => {
    expect(lookupFrame(t, -1, 0)).toBe(-1);
    expect(lookupFrame(t, t.count, 0)).toBe(-1);
    expect(lookupFrame(t, 0, -1)).toBe(-1);
    expect(lookupFrame(t, 0, 1)).toBe(-1); // BON1 has only frame A
  });

  it('full round-trip: every census frame tuple equals the installed slice', () => {
    for (let s = 0; s < census.sprites.length; s++) {
      const def = census.sprites[s]!;
      expect(t.frameStart[s + 1] - t.frameStart[s]!).toBe(def.frames.length);
      for (let f = 0; f < def.frames.length; f++) {
        const gf = lookupFrame(t, s, f)!;
        expect(frameRotates(t, gf), `${def.name4} frame ${f} rotate`).toBe(
          def.frames[f]!.rotate ? 1 : 0,
        );
        expect(installedLumps(t, gf), `${def.name4} frame ${f} lumps`).toEqual([
          ...def.frames[f]!.lump,
        ]);
        expect(installedFlips(t, gf), `${def.name4} frame ${f} flips`).toEqual([
          ...def.frames[f]!.flip,
        ]);
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. 8-rotation octant formula (r_things.c:522-523), incl. wrap       */
/* ------------------------------------------------------------------ */

describe('rotationFromAngles — hand-computed octants', () => {
  it('rot = (ang - thingangle + 0x90000000) >>> 29 across the full circle', () => {
    expect(ROTATION_BIAS).toBe(((ANG45 >>> 1) * 9) >>> 0); // 9 × ANG45/2
    // ang = thingangle + 180° + k·45° ⇒ rot = k (viewer in octant k).
    const thing = 0x10000000;
    for (let k = 0; k < 8; k++) {
      const ang = (thing + ANG180 + k * ANG45) >>> 0;
      expect(rotationFromAngles(ang, thing), `octant k=${k}`).toBe(k);
    }
    // Boundaries belong to the NEXT (clockwise) rotation: +22.5° shift.
    expect(rotationFromAngles((thing + ANG180 + ANG45 / 2 + 0) >>> 0, thing)).toBe(1);
    expect(rotationFromAngles((thing + ANG180 + ANG45 / 2 - 1) >>> 0, thing)).toBe(0);
    // Dead-front center.
    expect(rotationFromAngles(thing >>> 0, thing)).toBe(4);
  });

  it('literal hand vectors', () => {
    // ang − thing = 0x90000000-relative values, u32 arithmetic.
    expect(rotationFromAngles(0x90000000, 0x00000000)).toBe(1); // front center + ½ octant
    expect(rotationFromAngles(0x00000000, 0x80000000)).toBe(0); // front view center
    expect(rotationFromAngles(0xb0000000, 0x10000000)).toBe(1); // +180°+45°
    expect(rotationFromAngles(0x10000000, 0xb0000000)).toBe(7); // −180°−45° (mod)
    expect(rotationFromAngles(0x40000000, 0x80000000)).toBe(2); // −180°+90°
    expect(rotationFromAngles(0xc0000000, 0x80000000)).toBe(6); // +180°−90°
  });

  it('unsigned wrap-around: deltas crossing 0 and 2^32', () => {
    // delta = ang − thing ≡ +16 (still dead-center of rot 4).
    expect(rotationFromAngles(16, 0xfffffff0)).toBe(4);
    // delta = −32 ≡ 0xffffffe0 → still rot 4 (mod wrap inside >>>).
    expect(rotationFromAngles(0xfffffff0, 0x10)).toBe(4);
    // delta = +0x10000000 (rot-5 lower edge, inclusive) → 5.
    expect(rotationFromAngles(0x10000000, 0)).toBe(5);
    // delta = 0xefffffff (rot-3 upper edge, exclusive of 4) → 3.
    expect(rotationFromAngles(0xefffffff, 0)).toBe(3);
    // Exhaustive sweep vs BigInt oracle over 4·2^31 sampled deltas.
    const thing = 0x12345678;
    for (let i = 0; i < 4096; i++) {
      const ang = Math.imul(i, 2654435761) >>> 0;
      const delta = (BigInt(ang - thing) & 0xffffffffn) + (1n << 32n);
      const want = Number(((delta + 0x90000000n) % (1n << 32n)) >> 29n);
      expect(rotationFromAngles(ang, thing), `ang=0x${ang.toString(16)}`).toBe(want);
    }
  });
});

describe('thingAngleDegrees — P_SpawnMapThing angle quantization', () => {
  it('ANG45 * (deg/45), C truncation', () => {
    expect(thingAngleDegrees(0)).toBe(0);
    expect(thingAngleDegrees(45)).toBe(ANG45);
    expect(thingAngleDegrees(90)).toBe(ANG180 >>> 1);
    expect(thingAngleDegrees(270)).toBe(0xc0000000);
    expect(thingAngleDegrees(315)).toBe((7 * ANG45) >>> 0);
    expect(thingAngleDegrees(44)).toBe(0); // 44/45 = 0 in C
    expect(thingAngleDegrees(89)).toBe(ANG45);
    expect(thingAngleDegrees(-45)).toBe(0xe0000000); // −ANG45 mod 2^32
  });
});

/* ------------------------------------------------------------------ */
/* 3a. Fixture map: spawn classification, floorZ, linked lists         */
/* ------------------------------------------------------------------ */

function fixtureWadWithThings(spec: RectMapSpec, spriteNames: readonly string[]): WadFile {
  const wad = new WadBuilder('IWAD');
  wad.addLumpMarker('S_START');
  spriteNames.forEach((n, i) => wad.addLump(n, patch2x2(0x700 + i)));
  wad.addLumpMarker('S_END');
  wad.addLumpMarker('FIXMAP');
  for (const lump of buildMapLumps(spec)) wad.addLump(lump.name, lump.data);
  return WadFile.parse(wad.build().buffer as ArrayBuffer);
}

describe('buildStaticThings — fixture map', () => {
  const spec: RectMapSpec = {
    rooms: [
      { x: 0, y: 0, w: 256, h: 256, floorHeight: 0 },
      { x: 512, y: 0, w: 256, h: 256, floorHeight: 64 },
    ],
    things: [
      { x: 128, y: 128, type: 2035, angle: 90, flags: 7 }, // barrel, room 0
      { x: 600, y: 128, type: 2018, angle: 0, flags: 7 }, // green armor, room 1
      { x: 100, y: 100, type: 1, flags: 7 }, // player start
      { x: 101, y: 100, type: 11, flags: 7 }, // deathmatch start
      { x: 102, y: 100, type: 14, flags: 7 }, // teleportman (NOSECTOR marker)
      { x: 103, y: 100, type: 3004, flags: 7 }, // knight (monster)
      { x: 104, y: 100, type: 2005, flags: 7 }, // chainsaw (plan marker list)
      { x: 105, y: 100, type: 4096, flags: 7 }, // unknown id
      { x: 106, y: 100, type: 2014, flags: 16 | 2 }, // solo-skip (options&16)
      { x: 107, y: 100, type: 2015, flags: 1 }, // easy-skill-only at skill 3
      { x: 640, y: 128, type: 2015, angle: 225, flags: 6 }, // bonus, room 1, skill ok
    ],
  };
  const wad = fixtureWadWithThings(spec, ['BAR1A0', 'ARM1A0', 'BON2A0']);
  const map = buildMapFromData(loadMap(wad, 'FIXMAP'));
  const tables = installSprites(buildSpriteDefs(wad));
  const st = buildStaticThings(map, tables);

  it('classifies every thing, in P_SpawnMapThing order', () => {
    expect(map.numThings).toBe(11);
    expect(st.count).toBe(3);
    expect(st.skipped).toEqual({
      playerStart: 1,
      dmStart: 1,
      solo: 1,
      skill: 1,
      monster: 1,
      marker: 2, // teleportman + plan-excluded chainsaw
      unknown: 1,
      missingSprite: 0,
    });
    expect(st.unknownTypes).toEqual([4096]);
    expect(st.warnings.some((w) => w.includes('4096'))).toBe(true);
  });

  it('SoA carries fixed coords, BAM angle, spriteNum, frame letter, floorZ', () => {
    expect(st.x[0]).toBe(128 * FRACUNIT); // fixed = mapunit << 16
    expect(st.y[0]).toBe(128 * FRACUNIT);
    expect(st.angle[0]).toBe(2 * ANG45);
    const barrel = tables.indexOf.get('BAR1')!;
    expect(st.spriteNum[0]).toBe(barrel);
    expect(st.frame[0]).toBe(0); // 'A'
    expect(st.floorZ[0]).toBe(0); // room 0 floor
    // room 1 (floorHeight 64) things take room 1's floor:
    expect(st.floorZ[1]).toBe(64 * FRACUNIT);
    expect(st.floorZ[2]).toBe(64 * FRACUNIT);
    expect(st.spriteNum[1]).toBe(tables.indexOf.get('ARM1'));
    expect(st.spriteNum[2]).toBe(tables.indexOf.get('BON2'));
    expect(st.angle[2]).toBe((5 * ANG45) >>> 0);
  });

  it('sector linked lists visit each static exactly once (R_AddSprites walk)', () => {
    const seen = new Set<number>();
    let walked = 0;
    for (let s = 0; s < map.sectors.count; s++) {
      for (let k = st.sectorHead[s]!; k !== -1; k = st.next[k]!) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
        walked += 1;
      }
    }
    expect(walked).toBe(st.count);
  });

  it('missing sprite lumps are counted + warned, never crash', () => {
    const noArm = installSprites(buildSpriteDefs(fixtureWadWithThings(spec, ['BAR1A0', 'BON2A0'])));
    const st2 = buildStaticThings(map, noArm);
    expect(st2.count).toBe(2);
    expect(st2.skipped.missingSprite).toBe(1);
    expect(st2.warnings.some((w) => w.includes('ARM1'))).toBe(true);
  });

  it('monster roster never draws: table kinds are consistent', () => {
    // The fixture knight (3004) is gone; every table monster row is kind 2.
    expect(thingTypeIndex(3004)).toBeGreaterThanOrEqual(0);
    expect(THING_KINDS[thingTypeIndex(3004)!]).toBe(KIND_MONSTER);
    expect(thingTypeIndex(87)).toBeGreaterThanOrEqual(0); // NOSECTOR boss target
    expect(THING_KINDS[thingTypeIndex(87)!]).toBe(KIND_MARKER);
    expect(thingTypeIndex(11)).toBe(-1); // DM starts precede the table scan
    expect(thingTypeIndex(4)).toBe(-1);
  });
});

describe('THING tables are well-formed', () => {
  it('parallel, sorted, duplicate-free', () => {
    expect(MONSTER_ROWS).toBe(20);
    expect(THING_TYPES.length).toBe(THING_SPRITE4.length);
    expect(THING_TYPES.length).toBe(THING_FRAMES.length);
    expect(THING_TYPES.length).toBe(THING_KINDS.length);
    for (let i = 1; i < THING_TYPES.length; i++) {
      expect(THING_TYPES[i]!).toBeGreaterThan(THING_TYPES[i - 1]!);
    }
    for (let i = 0; i < THING_TYPES.length; i++) {
      expect(THING_SPRITE4[i]).toMatch(/^[A-Z0-9]{4}$/);
      expect(THING_KINDS[i]).toBeLessThanOrEqual(2);
      expect(thingTypeIndex(THING_TYPES[i]!)).toBe(i);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3b. freedoom1 E1M1 (skipIf no IWAD)                                 */
/* ------------------------------------------------------------------ */

const WAD_PATH = (() => {
  const p = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
  return existsSync(p) ? p : undefined;
})();
const hasWad = WAD_PATH !== undefined;

/** Monster-class rows exist in the table but must never be drawn. */
const MONSTER_ROWS = THING_KINDS.filter((k) => k === KIND_MONSTER).length;

describe.skipIf(!hasWad)('freedoom1 E1M1 static thing list', () => {
  const wad = WadFile.parse(readFileSync(WAD_PATH!).buffer as ArrayBuffer);
  const census = buildSpriteDefs(wad);
  const tables = installSprites(census);
  const map = buildMapFromData(loadMap(wad, 'E1M1'));
  const st = buildStaticThings(map, tables);

  it('census + install are clean on a real IWAD', () => {
    expect(census.warnings).toEqual([]);
    expect(tables.warnings).toEqual([]);
    expect(tables.count).toBeGreaterThan(100);
  });

  it('counts: 292 things classify with zero monsters and an EMPTY unknown list', () => {
    expect(map.numThings).toBe(292);
    expect(st.count).toBe(179);
    expect(st.skipped).toEqual({
      playerStart: 4,
      dmStart: 8,
      solo: 28,
      skill: 43, // default skill 3 (sk_medium), vanilla option bits
      monster: 29,
      marker: 1, // the doomednum-2005 chainsaw (plan marker exclusion)
      unknown: 0,
      missingSprite: 0,
    });
    // Committed unknown-id list: EMPTY — every freedoom1 E1M1 thing type is
    // covered by the roster or is an explicitly classified skip.
    expect(st.unknownTypes).toEqual([]);
    expect(st.warnings).toEqual([]);
    const sum =
      st.count +
      st.skipped.playerStart +
      st.skipped.dmStart +
      st.skipped.solo +
      st.skipped.skill +
      st.skipped.monster +
      st.skipped.marker +
      st.skipped.unknown +
      st.skipped.missingSprite;
    expect(sum).toBe(map.numThings);
  });

  it('zero monsters in the draw list (plan §4: monsters arrive with M8)', () => {
    for (let i = 0; i < st.count; i++) {
      const type = mapThingAt(map, st.thing[i]!).type;
      expect(THING_KINDS[thingTypeIndex(type)!], `thing type ${type}`).toBe(KIND_STATIC);
    }
    expect(st.skipped.monster).toBe(29);
  });

  it('floorZ == containing sector floor for 1000 sampled things (bsp point loc)', () => {
    // Deterministic LCG; the list is 179 long, so samples cycle the full
    // list many times — each sample re-locates the point independently via
    // the merged BSP walk (src/sim/bsp.ts).
    let seed = 0x9e3779b9;
    const rnd = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    for (let n = 0; n < 1000; n++) {
      const i = rnd() % st.count;
      const sector = sectorAtPoint(map, st.x[i]!, st.y[i]!);
      expect(st.floorZ[i], `thing ${st.thing[i]} (type id ${
        mapThingAt(map, st.thing[i]!).type
      })`).toBe(map.sectors.floorHeight[sector]);
    }
  });

  it('angles match the ANG45*(deg/45) quantization of the raw THINGS field', () => {
    for (let i = 0; i < st.count; i++) {
      expect(st.angle[i]).toBe(thingAngleDegrees(mapThingAt(map, st.thing[i]!).angle));
    }
  });

  it('sector lists cover the list exactly once', () => {
    let walked = 0;
    for (let s = 0; s < map.sectors.count; s++) {
      let k = st.sectorHead[s]!;
      let guard = st.count;
      while (k !== -1) {
        if (--guard < 0) throw new Error('cycle in sector list');
        walked += 1;
        k = st.next[k]!;
      }
    }
    expect(walked).toBe(st.count);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Zero-allocation per-frame lookup probes                          */
/* ------------------------------------------------------------------ */

describe('zero-alloc steady state (per-frame lookup paths)', () => {
  it('1M rotate/rot/lump/flip lookups reuse the same buffers', () => {
    const wad = spriteWad([
      'BAR1A1',
      'BAR1A2A8',
      'BAR1A3A7',
      'BAR1A4A6',
      'BAR1A5',
      'BAR1B0',
      'PLAYA0',
    ]);
    const t = installSprites(buildSpriteDefs(wad));
    const sprite = t.indexOf.get('BAR1')!;
    const lumpBuf = t.lump.buffer;
    const flipBuf = t.flip.buffer;
    const startBuf = t.frameStart.buffer;

    let sink = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 1_000_000; i++) {
      const gf = lookupFrame(t, sprite, i & 1);
      const rot = rotationFromAngles((i * 2654435761) >>> 0, (i << 20) >>> 0);
      sink += frameRotates(t, gf) + frameLump(t, gf, rot) + frameFlip(t, gf, rot);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(t.lump.buffer).toBe(lumpBuf);
    expect(t.flip.buffer).toBe(flipBuf);
    expect(t.frameStart.buffer).toBe(startBuf);
    expect(Number.isFinite(sink)).toBe(true);
    // 1M × (scalar lookup + octant math); allocation in the loop would
    // blow this up by orders of magnitude (cols.test.ts probe idiom).
    expect(ms, `1M lookups took ${ms.toFixed(0)}ms`).toBeLessThan(1500);
  });

  it('sector walk allocates nothing per node visited', () => {
    const spec: RectMapSpec = {
      rooms: [{ x: 0, y: 0, w: 256, h: 256 }],
      things: Array.from({ length: 50 }, (_, i) => ({
        x: 32 + (i % 10) * 20,
        y: 32 + Math.floor(i / 10) * 40,
        type: 2035,
        flags: 7,
      })),
    };
    const wad = fixtureWadWithThings(spec, ['BAR1A0']);
    const map = buildMapFromData(loadMap(wad, 'FIXMAP'));
    const st = buildStaticThings(map, installSprites(buildSpriteDefs(wad)));
    const nextBuf = st.next.buffer;
    const headBuf = st.sectorHead.buffer;

    let sink = 0;
    const t0 = process.hrtime.bigint();
    for (let frame = 0; frame < 20_000; frame++) {
      for (let s = 0; s < map.sectors.count; s++) {
        for (let k = st.sectorHead[s]!; k !== -1; k = st.next[k]!) sink += k + st.spriteNum[k]!;
      }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(st.next.buffer).toBe(nextBuf);
    expect(st.sectorHead.buffer).toBe(headBuf);
    expect(sink).toBeGreaterThan(0);
    expect(ms, `1M list steps took ${ms.toFixed(0)}ms`).toBeLessThan(1000);
  });
});
