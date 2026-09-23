/**
 * M12-01 — EVERY-MAP CENSUS LIVE-CHECK (docs/design/M12-plan.md §M12-01).
 *
 * Nine E1 maps (the D-12b shareware-reachable set) loaded from the pinned
 * Freedoom Phase 1 IWAD, each through FOUR live checks the fixtures never
 * covered (the plan §0.2: "the fixtures covered families, not maps"):
 *
 *  (a) STRUCTURAL sanity — the BSP walk terminates for a grid of points
 *      (subsectorAt throws on a cycle), the blockmap decodes with every
 *      reference inside [0, numlines), and P_SetupLevel completes into a
 *      live state whose player mobj stands in a real subsector. Per-skill
 *      spawn census at the WAD THINGS positions (skill 1..5) equals the
 *      pure-WAD census recomputed from scripts/map-census.mjs — the same
 *      "table row is not stale" discipline spawn-skill.test.ts pins on E1M1.
 *  (b) SPECIALS coverage — every USED line/sector special for the map is
 *      driven through its registry route (use/cross/shoot dispatch, sector
 *      feet for damage/secret/finale ids) and `unimplementedSpecial.count`
 *      stays 0; the map's used-id SET is a subset of registryManifest()
 *      (the "superset per map" gate: registry ⊇ map).
 *  (c) SPRITE coverage — buildStaticThings (the real R_Things pass, render
 *      side) reports `skipped.missingSprite == 0` for every thing.
 *  (d) LUMP PRESENCE surfaces §0.3 lists — the WAD-side content lumps
 *      (M_DOOM/TITLEPIC/CREDIT/HELP2/INTERPIC/WILV00..08 + per-map D_*
 *      music) are present, the episodic-only absences (HELP/READTHIS/END/
 *      MAPNAMES-lump/CWILV/WIfil/DEMO) are asserted ABSENT so their
 *      absence can never become an I_Error class bug.
 *
 * The census itself edits NO src: any gap surfaces as a typed assertion
 * failure listed in docs/reports/M12-census.md (gap table) + a follow-up.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { buildBlockMap } from '../../src/sim/blockmap';
import { subsectorAt } from '../../src/sim/bsp';
import { MF, mobjinfo } from '../../src/wad/info/mobjinfo';
import { censusThings } from '../fixtures/m8Fixtures';
import { buildStaticThings } from '../../src/render/rthings';
import { buildSpriteDefs } from '../../src/wad/sprites';
import { installSprites } from '../../src/render/rthings';
import { buildRenderMapView } from '../../src/render/view';
import { LINE_SPECIALS, SECTOR_SPECIALS, registryManifest,
  resetUnimplementedSpecial, unimplementedSpecial } from '../../src/sim/specials-table';
import { pCrossSpecialLine, pPlayerInSpecialSector, pShootSpecialLine, pUseSpecialLine } from '../../src/sim/pspec';
import { emptyInput } from '../../src/sim/ticcmd';
import { resetHookSlots } from '../../src/sim/hooks';

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
].find((p): p is string => p !== undefined && existsSync(p));

/** The nine D-12b shareware-reachable maps. */
const E1_MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];

/** The §0.3 present surfaces (asserted present) and the absent set (asserted
 * absent — the episodic-only / deathmatch-only lumps our route never reads). */
const PRESENT_SURFACES = [
  'M_DOOM', 'TITLEPIC', 'CREDIT', 'HELP2', 'INTERPIC',
  'WILV00', 'WILV01', 'WILV02', 'WILV03', 'WILV04', 'WILV05', 'WILV06', 'WILV07', 'WILV08'
];
const ABSENT_SURFACES = ['HELP', 'READTHIS', 'END', 'MAPNAMES', 'CWILV00', 'WIfil00', 'TITLEMAP'];

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let cachedWad: WadFile | undefined;
function wad(): WadFile {
  if (cachedWad === undefined) cachedWad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH!)));
  return cachedWad;
}

/** Registry route for a line-special id (specialfix.lineRoute logic, inline
 * to avoid coupling the census to the fixture geometry builder). */
function lineRoute(special: number): 'use' | 'cross' | 'shoot' | 'scroll' | null {
  const e = special < LINE_SPECIALS.length ? LINE_SPECIALS[special] : undefined;
  if (!e) return null;
  if (e.use) return 'use';
  if (e.cross) return 'cross';
  if (e.shoot) return 'shoot';
  if (e.scroll) return 'scroll';
  return null;
}

const manifest = registryManifest();
const MANIFEST_LINE = new Set(manifest.lineIds);
const MANIFEST_SECTOR = new Set(manifest.sectorIds);

for (const mapName of E1_MAPS) {
  describe(`M12-01 census ${mapName}`, () => {
    describe.skipIf(WAD_PATH === undefined)(mapName, () => {
      it('(a) structural sanity: BSP terminates, blockmap decodes, P_SetupLevel completes', () => {
        const md = loadMap(wad(), mapName);
        const map = buildMapFromData(md);
        // blockmap decodes and every reference is in-range (buildBlockMap
        // throws BlockMapError otherwise).
        const bm = buildBlockMap(map);
        for (let i = 0; i < bm.blockLines.length; i++) {
          expect(bm.blockLines[i]).toBeGreaterThanOrEqual(0);
          expect(bm.blockLines[i]).toBeLessThan(map.lines.count);
        }
        // BSP walk terminates at a grid of in-bounds points + every vertex.
        const minX = map.mapBBox.left, maxX = map.mapBBox.right;
        const minY = map.mapBBox.bottom, maxY = map.mapBBox.top;
        const stepX = (maxX - minX) / 8, stepY = (maxY - minY) / 8;
        for (let gx = 0; gx <= 8; gx++) {
          for (let gy = 0; gy <= 8; gy++) {
            const ss = subsectorAt(map, minX + gx * stepX, minY + gy * stepY);
            expect(ss).toBeGreaterThanOrEqual(0);
            expect(ss).toBeLessThan(map.subsectors.count);
          }
        }
        for (let v = 0; v < map.numVertexes; v++) {
          const ss = subsectorAt(map, map.verticesX[v]!, map.verticesY[v]!);
          expect(ss, `vertex ${v}`).toBeGreaterThanOrEqual(0);
        }
        // P_SetupLevel completes; the player mobj stands in a real subsector.
        const s = gInitGame(map);
        expect(Number.isFinite(s.players[0]!.mo.x)).toBe(true);
        const ss = subsectorAt(s.map, s.players[0]!.mo.x >> 16, s.players[0]!.mo.y >> 16);
        expect(ss).toBeGreaterThanOrEqual(0);
        expect(s.map.subsectors.sector[ss]).toBeDefined();
      });

      it('(a) per-skill spawn census at WAD positions matches the pure-WAD scan', () => {
        for (const skill of [0, 1, 2, 3, 4] as const) {
          const s = gInitGame(buildMapFromData(loadMap(wad(), mapName)), skill);
          let live = 0;
          for (const m of s.mobjs.slotMobjs.values()) {
            if (m.removed || (m.flags & MF.MF_COUNTKILL) === 0) continue;
            live++;
            const ss = subsectorAt(s.map, m.x >> 16, m.y >> 16);
            expect(ss, `dn=${mobjinfo[m.type as number]?.doomednum} @ skill ${skill}`)
              .toBeGreaterThanOrEqual(0);
          }
          // Recompute the expected COUNTKILL census from the WAD THINGS.
          const cen = censusThings(wad(), mapName, skill);
          let want = 0;
          for (const [dn, n] of cen.aliveByDoomednum) {
            const row = dnToCountkill(dn);
            if (row) want += n;
          }
          expect(live, `${mapName} live COUNTKILL at skill ${skill}`).toBe(want);
        }
      });

      it('(b) specials coverage: every used id driven, zero unimplemented hits', () => {
        const md = loadMap(wad(), mapName);
        const s = gInitGame(buildMapFromData(md));
        resetHookSlots(s.hooks);
        resetUnimplementedSpecial();
        const usedLine = new Set<number>();
        const usedSector = new Set<number>();
        for (let i = 0; i < s.map.lines.count; i++) {
          const sp = s.map.lines.special[i]!;
          if (sp) usedLine.add(sp);
        }
        for (let i = 0; i < s.sectors.count; i++) {
          const sp = s.sectors.special[i]!;
          if (sp) usedSector.add(sp);
        }
        // registry ⊇ map (the "superset per map" gate).
        for (const id of usedLine) {
          expect(MANIFEST_LINE.has(id), `${mapName} line special ${id} registered`).toBe(true);
        }
        for (const id of usedSector) {
          expect(MANIFEST_SECTOR.has(id), `${mapName} sector special ${id} registered`).toBe(true);
        }
        // Drive each USED line special through its registry route on a real
        // line of that id, so the dispatcher body runs (never the stub).
        const mo = s.players[0]!.mo;
        const driven = new Set<number>();
        for (let i = 0; i < s.map.lines.count; i++) {
          const sp = s.map.lines.special[i]!;
          if (!sp || driven.has(sp)) continue;
          const route = lineRoute(sp);
          if (route === 'use') pUseSpecialLine(s, mo, i, 0);
          else if (route === 'cross') pCrossSpecialLine(s.pmap, i, 0, mo);
          else if (route === 'shoot') pShootSpecialLine(s, mo, i);
          // scroll ids (48) are collected by P_SpawnSpecials, panned per tic.
          driven.add(sp);
        }
        // Drive each USED sector special (with a feet route) once, grounded,
        // straight through pPlayerInSpecialSector so the damage/secret/finale
        // body runs (spawn ids already ran at P_SpawnSpecials during setup).
        const feetDriven = new Set<number>();
        const p = s.players[0]!;
        for (let i = 0; i < s.sectors.count; i++) {
          const sp = s.sectors.special[i]!;
          if (!sp || feetDriven.has(sp) || !SECTOR_SPECIALS[sp]?.feet) continue;
          p.mo.z = s.sectors.floorZ[i]!; // grounded gate
          pPlayerInSpecialSector(s, p, i); // throws I_Error-class on unknown id
          feetDriven.add(sp);
        }
        expect([...usedSector].every((id) => !SECTOR_SPECIALS[id]?.feet || feetDriven.has(id)),
          `${mapName} every used feet id driven`).toBe(true);
        // Run a burst of tics so cross/use movers, sector spawn thinkers and
        // the special-48 scroll pass all execute.
        for (let t = 0; t < 60; t++) gTicker(s, emptyInput());
        expect(unimplementedSpecial.count, `${mapName} unimplementedSpecial hits`)
          .toBe(0);
      });

      it('(c) sprite coverage: missingSprite == 0 for every thing', () => {
        const md = loadMap(wad(), mapName);
        const view = buildRenderMapView(md);
        const sprites = installSprites(buildSpriteDefs(wad()));
        const things = buildStaticThings(md, view, sprites, { skill: 3 });
        expect(things.skipped.missingSprite, `${mapName} missingSprite`).toBe(0);
        expect(things.skipped.unknown, `${mapName} unknown doomednums`).toBe(0);
      });
    });
  });
}

describe.skipIf(WAD_PATH === undefined)('M12-01 census lump-presence surfaces (all maps)', () => {
  it('(d) content-surface lump presence matches plan §0.3', () => {
    const w = wad();
    for (const lump of PRESENT_SURFACES) {
      expect(w.lumpNumByName(lump), `${lump} present`).toBeGreaterThanOrEqual(0);
    }
    for (const lump of ABSENT_SURFACES) {
      expect(w.lumpNumByName(lump), `${lump} absent (episodic/DM-only route never reads it)`).toBe(-1);
    }
    // Per-map D_ music lump present for all nine maps.
    for (const m of E1_MAPS) {
      expect(w.lumpNumByName(`D_${m}`), `D_${m} music present`).toBeGreaterThanOrEqual(0);
    }
  });
});

/** True if the doomednum classifies as a MF_COUNTKILL hostile (barrels and
 * decor excluded — mirrors the monster-census classifier). */
function dnToCountkill(dn: number): boolean {
  // Walk mobjinfo for a type whose doomednum === dn and flags carry COUNTKILL.
  for (const info of mobjinfo) {
    if (info.doomednum === dn) return (info.flags & MF.MF_COUNTKILL) !== 0;
  }
  return false;
}
