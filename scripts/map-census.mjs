// scripts/map-census.mjs — PURE WAD scan for the M12-01 every-map census
// (docs/design/M12-plan.md §M12-01). This script touches NOTHING in src/**;
// it reads the pinned Freedoom Phase 1 IWAD directly (the same 16-bit lump
// layouts R01 §4-10 pin) and reports the WAD-side truth the live test
// (tests/headless/allMapsCensus.test.ts) cross-checks against the running
// engine:
//
//   • geometry counts per map (THINGS/LINEDEFS/…/BLOCKMAP record counts);
//   • the SET of line specials and sector specials USED per map (union is
//     the plan §0.2 perimeter — the fixtures cover families, maps are the
//     real coverage target);
//   • the raw THINGS records (doomednum + option bits + position) so the
//     live per-skill spawn census has an independent WAD reference;
//   • lump-presence for the content surfaces §0.3 lists (MAPNAMES is a
//     compiled-in d_englsh STRING table, so the WAD-side surfaces are the
//     picture lumps M_DOOM/WILV00..08/INTERPIC/TITLEPIC/CREDIT/HELP2 plus
//     the per-map D_ music lump) — presence booleans only, never a decode.
//
// Usage:  node scripts/map-census.mjs [--wad=<path>] [--json=<out>]
// Default --wad resolves wads/freedoom1.wad next to the repo root; default
// --json writes docs/reports/M12-census.json (the committed evidence file).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** The nine shareware-reachable E1 maps (D-12b: E1-only policy). */
export const E1_MAPS = [
  'E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'
];

/** Fixed-size map lumps and their record sizes (mapdata.ts RECORD_SIZE). */
const RECORD_SIZE = {
  THINGS: 10, LINEDEFS: 14, SIDEDEFS: 30, VERTEXES: 4,
  SEGS: 12, SSECTORS: 4, NODES: 28, SECTORS: 26
};
const GEOM_LUMPS = [
  'THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS'
];

/** Content-surface picture lumps §0.3 lists as needed. */
const SURFACE_LUMPS = [
  'M_DOOM', 'TITLEPIC', 'CREDIT', 'HELP2', 'INTERPIC',
  'WILV00', 'WILV01', 'WILV02', 'WILV03', 'WILV04', 'WILV05', 'WILV06', 'WILV07', 'WILV08'
];

/** Vanilla 16-bit little-endian WAD reader (dir: [pos,size,name(8)]). */
function openWad(buf) {
  const view = new DataView(buf);
  const ident = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (ident !== 'IWAD' && ident !== 'PWAD') throw new Error(`not a WAD (${ident})`);
  const numLumps = view.getInt32(4, true);
  const dirOfs = view.getInt32(8, true);
  const bytes = new Uint8Array(buf);
  const entries = [];
  const byName = new Map();
  for (let i = 0; i < numLumps; i++) {
    const ofs = dirOfs + i * 16;
    const pos = view.getInt32(ofs, true);
    const size = view.getInt32(ofs + 4, true);
    let name = '';
    for (let c = 0; c < 8; c++) {
      const ch = bytes[ofs + 8 + c];
      if (ch !== 0) name += String.fromCharCode(ch);
    }
    entries.push({ pos, size, name });
    byName.set(name.toUpperCase(), i); // last definition wins (R01 §15.2)
  }
  return {
    ident, numLumps, entries, byName,
    has: (n) => byName.has(n.toUpperCase()),
    view: (i) => new DataView(buf, entries[i].pos, entries[i].size),
    size: (i) => entries[i].size
  };
}

/** Locate one map's named lumps: the 10-lump marker block after `MAPxx`. */
function mapBlock(wad, mapName) {
  const start = wad.byName.get(mapName.toUpperCase());
  if (start === undefined) throw new Error(`map marker ${mapName} absent`);
  const block = {};
  for (let i = start + 1; i < wad.entries.length; i++) {
    const e = wad.entries[i];
    const n = e.name.toUpperCase();
    if (/^[MS]_[A-Z0-9]+$/.test(n)) continue; // end-of-map data markers
    if (GEOM_LUMPS.includes(n) || n === 'REJECT' || n === 'BLOCKMAP') {
      if (block[n] === undefined) block[n] = i;
    }
  }
  return block;
}

function censusMap(wad, mapName) {
  const block = mapBlock(wad, mapName);
  const counts = {};
  for (const lump of GEOM_LUMPS) {
    counts[lump] = block[lump] !== undefined ? Math.floor(wad.size(block[lump]) / RECORD_SIZE[lump]) : 0;
  }
  // THINGS records: i16 x, i16 y, u16 angle, u16 type, u16 flags.
  const things = [];
  if (block.THINGS !== undefined) {
    const v = wad.view(block.THINGS);
    for (let o = 0; o + 10 <= v.byteLength; o += 10) {
      things.push({
        x: v.getInt16(o, true),
        y: v.getInt16(o + 2, true),
        angle: v.getUint16(o + 4, true),
        type: v.getUint16(o + 6, true),
        flags: v.getUint16(o + 8, true)
      });
    }
  }
  // LINEDEFS: i16 v1, v2, u16 flags, u16 special, u16 tag, i16 s1, s2.
  const lineSpecials = new Set();
  if (block.LINEDEFS !== undefined) {
    const v = wad.view(block.LINEDEFS);
    for (let o = 0; o + 14 <= v.byteLength; o += 14) {
      const sp = v.getUint16(o + 6, true);
      if (sp !== 0) lineSpecials.add(sp);
    }
  }
  // SECTORS: i16 floor, i16 ceil, u16 light, 8 flat, 8 flat, u16 special, u16 tag.
  const sectorSpecials = new Set();
  if (block.SECTORS !== undefined) {
    const v = wad.view(block.SECTORS);
    for (let o = 0; o + 26 <= v.byteLength; o += 26) {
      const sp = v.getUint16(o + 22, true);
      if (sp !== 0) sectorSpecials.add(sp);
    }
  }
  // Distinct doomednums present (raw, before the spawn filter).
  const doomednums = new Set();
  for (const t of things) if (t.type > 4 && t.type !== 11) doomednums.add(t.type);
  // Per-map D_ music lump name (D_E1M1..D_E1M9).
  const music = `D_${mapName}`;
  return {
    name: mapName,
    counts,
    allRequiredLumps: GEOM_LUMPS.concat('REJECT', 'BLOCKMAP').every((n) => block[n] !== undefined),
    lineSpecialsUsed: [...lineSpecials].sort((a, b) => a - b),
    sectorSpecialsUsed: [...sectorSpecials].sort((a, b) => a - b),
    doomednumsUsed: [...doomednums].sort((a, b) => a - b),
    things,
    music: { lump: music, present: wad.has(music) }
  };
}

/** Full census: geometry + specials + things + surfaces (pure WAD read). */
export function runCensus(wadPath) {
  const wad = openWad(readFileSync(wadPath).buffer);
  const surfaces = {};
  for (const lump of SURFACE_LUMPS) surfaces[lump] = wad.has(lump);
  const maps = E1_MAPS.map((m) => censusMap(wad, m));
  const lineUnion = [...new Set(maps.flatMap((m) => m.lineSpecialsUsed))].sort((a, b) => a - b);
  const sectorUnion = [...new Set(maps.flatMap((m) => m.sectorSpecialsUsed))].sort((a, b) => a - b);
  return {
    meta: {
      wad: wadPath, ident: wad.ident, numLumps: wad.numLumps,
      maps: E1_MAPS.length, surfacesChecked: SURFACE_LUMPS.length
    },
    surfaces,
    unions: { lineSpecials: lineUnion, sectorSpecials: sectorUnion },
    maps
  };
}

function defaultWad() {
  const arg = process.argv.find((a) => a.startsWith('--wad='));
  if (arg) return resolve(arg.slice(6));
  return join(repoRoot, 'wads', 'freedoom1.wad');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const wadPath = defaultWad();
  if (!existsSync(wadPath)) {
    console.error(`map-census: WAD not found at ${wadPath} (run: npm run fetch-freedoom)`);
    process.exit(2);
  }
  const census = runCensus(wadPath);
  const outArg = process.argv.find((a) => a.startsWith('--json='));
  if (outArg) {
    const out = resolve(outArg.slice(7));
    writeFileSync(out, `${JSON.stringify(census, null, 1)}\n`);
    console.log(`map-census: wrote ${out}`);
  }
  const lineMax = Math.max(...census.unions.lineSpecials);
  const secMax = Math.max(...census.unions.sectorSpecials);
  console.log(`map-census: ${census.meta.maps} maps, ${census.meta.numLumps} lumps`);
  console.log(`  line-special union: ${census.unions.lineSpecials.length} ids (max ${lineMax})`);
  console.log(`  sector-special union: ${census.unions.sectorSpecials.join(',')}`);
  console.log(`  surfaces present: ${Object.values(census.surfaces).filter(Boolean).length}/${census.meta.surfacesChecked}`);
}
