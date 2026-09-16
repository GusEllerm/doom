/**
 * sim/map tests (M2-04 — p_setup equivalent).
 *
 * Layer 1: FIXMAP fixture maps (tests/fixtures/mapBuilder) through
 * loadMap → buildMapFromData — sector line-list exactness, line↔sector
 * backlinks, subsector→sector resolution via a test-local bbox walker,
 * player starts, tag indexes, P_CheckSectors-style checks, typed errors.
 * Layer 2: freedoom1.wad E1M1 structural goldens (auto-skip when absent) —
 * counts, the sector-linecount SUM identity, sector-0/sector geometry pins.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import {
  buildMapFromData,
  mapThingAt,
  MapSetupError,
  sectorsWithTag,
  ST_VERTICAL,
  type NodeChild,
  type RuntimeMap,
} from './map';
import { NF_SUBSECTOR } from '../wad/mapdata';
import type { MapData } from '../wad/types';
import { WadFile } from '../wad/wadfile';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function wadMap(bytes: Uint8Array, name = 'FIXMAP'): MapData {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return loadMap(WadFile.parse(buf), name);
}

const FX = 65536;

/** Two adjacent rooms + an isolated L-ish third room; door gap tagged 5. */
const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200, tag: 5 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 },
    { x: 0, y: 512, w: 128, h: 128, floorHeight: 64, lightLevel: 255 },
  ],
  doors: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 1, tag: 5 }],
};

const map = buildMapFromData(wadMap(buildFixtureMapWad(SPEC)));

/**
 * Test-local reference walker. Descent by SPLIT-SIDE test (front = the
 * x>splitx / y>splity half, children[0]=front per tests/fixtures/bspSplit),
 * NOT by child bbox: the fixture NODES encoder writes bbox words as
 * [x0,y0,x1,y1] while vanilla/R01 (and our decoder, verified on E1M1) are
 * [top,bottom,left,right] — a fixture encoder bug, filed as follow-up.
 * Splits are axis-aligned, so the cross-product side test (front/right
 * child ⇔ cross < 0, the vanilla P_PointOnDivideSide sign) is exact.
 */
function pointInSsector(m: RuntimeMap, xUnits: number, yUnits: number): number {
  const x = xUnits * FX;
  const y = yUnits * FX;
  const go = (c: NodeChild): number => {
    if (c.kind === 'subsector') return c.index;
    const i = c.index;
    const cross = m.nodes.dx[i]! * (y - m.nodes.y[i]!) - m.nodes.dy[i]! * (x - m.nodes.x[i]!);
    return go(cross < 0 ? m.nodes.right[i]! : m.nodes.left[i]!);
  };
  return go({ kind: 'node', index: m.nodes.count - 1 });
}

/** Lines bordering sector s per the CSR lists (ascending linedef order). */
function sectorList(m: RuntimeMap, s: number): number[] {
  const start = m.sectors.lineStart[s]!;
  const out: number[] = [];
  for (let i = start; i < start + m.sectors.lineCount[s]!; i++) out.push(m.sectorLineIndex[i]!);
  return out;
}

/* ------------------------------------------------------------------ */
/* Layer 1 — fixture map                                               */
/* ------------------------------------------------------------------ */

describe('buildMapFromData (FIXMAP fixture)', () => {
  it('counts + bounds', () => {
    expect(map.sectors.count).toBe(4); // void + 3 rooms
    expect(map.numVertexes).toBeGreaterThan(0);
    expect(map.mapBBox).toEqual({
      left: 0 * FX,
      right: 512 * FX,
      top: 640 * FX,
      bottom: 0 * FX,
    });
  });

  it('every linedef borders exactly the sectors whose lists contain it', () => {
    // Reconstruct per-line occurrence counts from the sector lists.
    const occurrences = new Map<number, number[]>();
    for (let s = 0; s < map.sectors.count; s++) {
      for (const l of sectorList(map, s)) {
        (occurrences.get(l) ?? occurrences.set(l, []).get(l)!).push(s);
      }
    }
    for (let l = 0; l < map.lines.count; l++) {
      const f = map.lines.sectorFront[l]!;
      const b = map.lines.sectorBack[l]!;
      const expected = b === -1 || b === f ? [f] : [Math.min(f, b), Math.max(f, b)];
      expect(occurrences.get(l)?.slice().sort((p, q) => p - q) ?? [], `line ${l}`).toEqual(expected);
      // sector line lists are in ascending linedef order (vanilla scan)
      expect(sectorList(map, f)).toEqual([...sectorList(map, f)].sort((p, q) => p - q));
    }
    // SUM identity: each line counted once, plus once more per distinct back
    let sum = 0;
    for (let s = 0; s < map.sectors.count; s++) sum += map.sectors.lineCount[s]!;
    const backDiff = [...Array(map.lines.count).keys()].filter(
      (l) => map.lines.sectorBack[l] !== -1 && map.lines.sectorBack[l] !== map.lines.sectorFront[l],
    ).length;
    expect(sum).toBe(map.lines.count + backDiff);
  });

  it('line↔side↔sector backlinks; one-sided ⇒ backSector −1', () => {
    for (let l = 0; l < map.lines.count; l++) {
      expect(map.lines.sectorFront[l]).toBe(map.sides.sector[map.lines.sideFront[l]!]);
      if (map.lines.sideBack[l] === -1) {
        expect(map.lines.sectorBack[l]).toBe(-1);
        expect(map.lines.sideNumBack[l]).toBe(-1);
      } else {
        expect(map.lines.sectorBack[l]).toBe(map.sides.sector[map.lines.sideBack[l]!]);
      }
    }
  });

  it('subsector→sector resolves to the owning room via the node tree', () => {
    const samples: [number, number, number][] = [
      [128, 128, 1], // room 0 → sector 1
      [384, 128, 2], // room 1 → sector 2
      [64, 576, 3], // room 2 → sector 3
    ];
    for (const [x, y, sector] of samples) {
      const ssec = pointInSsector(map, x, y);
      expect(map.subsectors.sector[ssec], `point ${x},${y}`).toBe(sector);
    }
    // every subsector: all its segs agree on the front sector
    for (let s = 0; s < map.subsectors.count; s++) {
      const first = map.subsectors.sector[s]!;
      for (let g = 0; g < map.subsectors.segCount[s]!; g++) {
        expect(map.segSectorFront[map.subsectors.segStart[s]! + g]).toBe(first);
      }
    }
  });

  it('node children are tagged refs and form a full tree', () => {
    let nodeRefs = 0;
    let leafRefs = 0;
    for (let i = 0; i < map.nodes.count; i++) {
      for (const c of [map.nodes.right[i]!, map.nodes.left[i]!]) {
        if (c.kind === 'node') {
          nodeRefs++;
          expect(c.index).toBeLessThan(map.nodes.count);
        } else {
          leafRefs++;
          expect(c.index).toBeLessThan(map.subsectors.count);
        }
      }
    }
    expect(nodeRefs).toBe(map.nodes.count - 1);
    expect(leafRefs).toBe(map.nodes.count + 1);
  });

  it('sector bbox/soundorg/blockbox', () => {
    const room = 1; // room 0: (0,0)-(256,256)
    expect(map.sectors.bboxLeft[room]).toBe(0);
    expect(map.sectors.bboxRight[room]).toBe(256 * FX);
    expect(map.sectors.soundOrgX[room]).toBe(128 * FX);
    expect(map.sectors.soundOrgY[room]).toBe(128 * FX);
    for (let s = 0; s < map.sectors.count; s++) {
      expect(map.sectors.blockBoxLeft[s]).toBeGreaterThanOrEqual(0);
      expect(map.sectors.blockBoxLeft[s]).toBeLessThan(map.blockmapWidth);
      expect(map.sectors.blockBoxBottom[s]).toBeGreaterThanOrEqual(0);
      expect(map.sectors.blockBoxTop[s]).toBeLessThan(map.blockmapHeight);
    }
  });

  it('heights/flats/lights decoded to fixed point', () => {
    expect(map.sectors.floorHeight[1]).toBe(0);
    expect(map.sectors.ceilingHeight[1]).toBe(128 * FX);
    expect(map.sectors.floorHeight[3]).toBe(64 * FX);
    expect(map.sectors.lightLevel[1]).toBe(200);
    expect(map.sectors.floorFlat[1]).toBe('FIXFLAT0');
    expect(map.sectors.ceilingFlat[3]).toBe('FIXFLAT1');
  });

  it('slopetype of the shared vertical wall edge is ST_VERTICAL somewhere', () => {
    let sawVertical = false;
    for (let l = 0; l < map.lines.count; l++) if (map.lines.slopetype[l] === ST_VERTICAL) sawVertical = true;
    expect(sawVertical).toBe(true);
  });

  it('player starts + deathmatch starts + unknown kinds skipped', () => {
    const withDm = buildMapFromData(
      wadMap(
        buildFixtureMapWad({
          ...SPEC,
          things: [
            { x: 64, y: 64, type: 1, angle: 90 },
            { x: 96, y: 64, type: 2 },
            { x: 64, y: 96, type: 11 },
            { x: 200, y: 200, type: 2005 }, // barrel: ignored here
          ],
        }),
      ),
    );
    expect(withDm.playerStarts[0]).toMatchObject({ x: 64, y: 64, angle: 90, type: 1 });
    expect(withDm.playerStarts[1]!.type).toBe(2);
    expect(withDm.playerStarts[2]).toBeNull();
    expect(withDm.deathmatchStarts).toHaveLength(1);
    expect(withDm.deathmatchStarts[0]!.type).toBe(11);
    expect(withDm.numThings).toBe(4);
    expect(mapThingAt(withDm, 3).type).toBe(2005);
    expect(() => mapThingAt(withDm, 4)).toThrow(MapSetupError);
  });

  it('tag indexes in scan order', () => {
    expect(sectorsWithTag(map, 5)).toEqual([1]); // room 0 sector
    expect(sectorsWithTag(map, 0)).toEqual([]);
    const doorLines = map.linesByTag.get(5)!;
    expect(doorLines.length).toBeGreaterThan(0);
    expect([...doorLines]).toEqual([...doorLines].sort((a, b) => a - b));
    for (const l of doorLines) expect(map.lines.special[l]).toBe(1);
  });

  it('P_CheckSectors-style lightlevel clamp', () => {
    const md = wadMap(buildFixtureMapWad(SPEC));
    md.sectors[1] = { ...md.sectors[1]!, lightLevel: 300 };
    md.sectors[2] = { ...md.sectors[2]!, lightLevel: -7 };
    const m = buildMapFromData(md);
    expect(m.sectors.lightLevel[1]).toBe(255);
    expect(m.sectors.lightLevel[2]).toBe(0);
  });

  it('same-sector two-sided line is counted once per sector', () => {
    const md = wadMap(buildFixtureMapWad(SPEC));
    // pick a two-sided line and collapse its back side onto the front sector
    const l = md.lineDefs.findIndex((ld) => ld.back !== -1);
    const before = buildMapFromData(md);
    let sumBefore = 0;
    for (let s = 0; s < before.sectors.count; s++) sumBefore += before.sectors.lineCount[s]!;
    md.sideDefs[md.lineDefs[l]!.back] = { ...md.sideDefs[md.lineDefs[l]!.back]!, sector: md.sideDefs[md.lineDefs[l]!.front]!.sector };
    const after = buildMapFromData(md);
    let sumAfter = 0;
    for (let s = 0; s < after.sectors.count; s++) sumAfter += after.sectors.lineCount[s]!;
    expect(sumAfter).toBe(sumBefore - 1);
    expect(after.lines.sectorBack[l]).toBe(after.lines.sectorFront[l]);
    // it still appears exactly ONCE in that sector's list
    const list = sectorList(after, after.lines.sectorFront[l]!);
    expect(list.filter((x) => x === l)).toHaveLength(1);
  });

  it('typed errors: miniseg, −1 sidenum ref, seg sector disagreement, bad child ref', () => {
    const base = (): MapData => wadMap(buildFixtureMapWad(SPEC));

    const mini = base();
    mini.segs[0] = { ...mini.segs[0]!, line: -1 };
    expect(() => buildMapFromData(mini)).toThrow(/miniseg/);

    const oneSided = base();
    const victim = oneSided.lineDefs.findIndex((ld) => ld.back !== -1);
    oneSided.lineDefs[victim] = { ...oneSided.lineDefs[victim]!, back: -1 };
    // a seg on the (now missing) back side of a one-sided line must be caught
    const segIdx = oneSided.segs.findIndex((sg) => sg.side === 0);
    oneSided.segs[segIdx] = { ...oneSided.segs[segIdx]!, line: victim, side: 1 };
    expect(() => buildMapFromData(oneSided)).toThrow(/sidenum/);

    const disagree = base();
    const ss = disagree.ssectors.find((s) => s.numsegs > 1)!;
    const seg0 = disagree.segs[ss.firstseg]!;
    const seg0Line = disagree.lineDefs[seg0.line]!;
    const ownSector =
      disagree.sideDefs[seg0.side === 0 ? seg0Line.front : seg0Line.back]!.sector;
    const other = disagree.lineDefs.findIndex(
      (ld) => disagree.sideDefs[ld.front]!.sector !== ownSector,
    );
    disagree.segs[ss.firstseg + 1] = { ...disagree.segs[ss.firstseg + 1]!, line: other, side: 0 };
    expect(() => buildMapFromData(disagree)).toThrow(/disagree/);

    const badChild = base();
    badChild.nodes[0] = { ...badChild.nodes[0]!, left: NF_SUBSECTOR | 9999 };
    expect(() => buildMapFromData(badChild)).toThrow(/subsector .* out of range/);
  });
});

/* ------------------------------------------------------------------ */
/* Layer 2 — freedoom1.wad E1M1 structural goldens                     */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 runtime-map goldens', () => {
  // Recorded 2026-07 from wads/freedoom1.wad (pinned release, scripts/freedoom).
  const e1m1 = () => {
    const bytes = readFileSync(WAD_PATH);
    return buildMapFromData(wadMap(bytes, 'E1M1'));
  };
  const m = e1m1();

  it('counts match the decoder goldens', () => {
    expect(m.sectors.count).toBe(182);
    expect(m.lines.count).toBe(1175);
    expect(m.numSegs).toBe(2057);
    expect(m.subsectors.count).toBe(682);
    expect(m.nodes.count).toBe(681);
    expect(m.numVertexes).toBe(1196);
    expect(m.numThings).toBe(292);
  });

  it('sector linecount SUM identity: SUM == numLines + distinct-back lines', () => {
    let sum = 0;
    let backDiff = 0;
    let twoSided = 0;
    for (let l = 0; l < m.lines.count; l++) {
      if (m.lines.sideBack[l] !== -1) twoSided++;
      if (m.lines.sectorBack[l] !== -1 && m.lines.sectorBack[l] !== m.lines.sectorFront[l]) backDiff++;
    }
    for (let s = 0; s < m.sectors.count; s++) sum += m.sectors.lineCount[s]!;
    expect(twoSided).toBe(654);
    expect(backDiff).toBe(647); // 7 two-sided lines face the SAME sector both ways
    expect(sum).toBe(1822);
    expect(sum).toBe(m.lines.count + backDiff);
  });

  it('sector 0 pins (heights, light, flats, bbox, blockbox)', () => {
    expect(m.sectors.floorHeight[0]).toBe(-160 * FX);
    expect(m.sectors.ceilingHeight[0]).toBe(376 * FX);
    expect(m.sectors.lightLevel[0]).toBe(202);
    expect(m.sectors.lineCount[0]).toBe(13);
    expect(m.sectors.floorFlat[0]).toBe('RROCK18');
    expect(m.sectors.ceilingFlat[0]).toBe('CEIL5_1');
    expect([
      m.sectors.bboxLeft[0],
      m.sectors.bboxRight[0],
      m.sectors.bboxTop[0],
      m.sectors.bboxBottom[0],
    ]).toEqual([1152 * FX, 1312 * FX, 1616 * FX, 439 * FX]);
    expect([
      m.sectors.blockBoxLeft[0],
      m.sectors.blockBoxRight[0],
      m.sectors.blockBoxTop[0],
      m.sectors.blockBoxBottom[0],
    ]).toEqual([14, 16, 21, 11]);
  });

  it('map bbox from vertices + blockmap header agree', () => {
    expect(m.mapBBox).toEqual({
      left: -704 * FX,
      right: 3248 * FX,
      top: 2336 * FX,
      bottom: -1064 * FX,
    });
    expect(m.blockmapWidth).toBe(32);
    expect(m.blockmapHeight).toBe(27);
  });

  it('starts: player 1 at (-416,256), 8 deathmatch starts', () => {
    expect(m.playerStarts[0]).toMatchObject({ x: -416, y: 256, angle: 0, type: 1, flags: 7 });
    expect(m.playerStarts.map((p) => p?.x)).toEqual([-416, -416, -464, -416]);
    expect(m.deathmatchStarts).toHaveLength(8);
  });

  it('root node children + first subsectors pin', () => {
    expect(m.nodes.right[0]).toEqual({ kind: 'subsector', index: 1 });
    expect(m.nodes.left[0]).toEqual({ kind: 'subsector', index: 2 });
    expect([m.subsectors.sector[0], m.subsectors.sector[1], m.subsectors.sector[2]]).toEqual([122, 122, 122]);
  });

  it('global invariants hold on the real map', () => {
    for (let l = 0; l < m.lines.count; l++) {
      expect(m.lines.sectorFront[l]).toBe(m.sides.sector[m.lines.sideFront[l]!]);
    }
    for (let s = 0; s < m.subsectors.count; s++) {
      const first = m.subsectors.sector[s]!;
      for (let g = 1; g < m.subsectors.segCount[s]!; g++) {
        expect(m.segSectorFront[m.subsectors.segStart[s]! + g]).toBe(first);
      }
    }
  });
});
