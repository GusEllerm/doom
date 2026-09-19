// sim/pspec-helpers.ts — the p_spec.c UTILITY functions (M6-03). Kept in
// their own module so the family files (pdoors/pplats/pfloor/pceilng/
// plights/ptelept/pswitch — owned by M6-05..M6-11) can import them without
// an import cycle through pspec.ts (pspec.ts imports the family entry
// points for the registry; families import ONLY this module +
// specials-table.ts). pspec.ts re-exports everything here.
//
// Order pins (R05 §7 / M6-plan §6 "P_Find* tie order"):
//  • neighbour iteration = `sec->lines[i]`, i ascending — mirrored by the
//    map's CSR slice [lineStart[sec], +lineCount[sec]) which P_GroupLines
//    fills in ASCENDING LINEDEF ORDER (map.ts sectorLineIndex). No sort,
//    no rebuild.
//  • P_FindHighestFloorSurrounding seeds at −500*FRACUNIT, Lowest-Ceiling
//    seeds at MAXINT (2^31−1), Highest-Ceiling seeds at 0, Lowest-Floor
//    seeds at the sector's OWN floorheight — all verbatim p_spec.c.
//  • P_FindNextHighestFloor: heightlist cap 20 (MAX_ADJOINING_SECTORS) —
//    the vanilla overflow `break` fires AFTER the push test on EVERY
//    adjoining sector; replicated exactly, overflow counted (the
//    `fprintf(stderr,...)` slot).
//  • P_FindSectorFromLineTag scans sectors[i].tag ascending, resumable
//    from `start+1` — NO tag-0 fallback (R05 preamble).
//
// All helpers are pure int loops over the live SoA — zero allocation per
// call (the heightlist is a module scratch reused across calls; helpers
// never recurse, matching the vanilla stack array's semantics).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';

import type { RuntimeMap } from './map';
import type { LiveSectors } from './state';
import type { ThinkerArena } from './ptick';
import type { HookSlots, ExitKind } from './hooks';
import type { PrngState } from './prng';

/* ------------------------------------------------------------------ */
/* The specials-side world view (GameState satisfies this structurally) */
/* ------------------------------------------------------------------ */

/**
 * What the p_spec.c machinery reads/writes: the static map (lines, sides,
 * line specials — the line SoA IS live state, W1 clears mutate it), the
 * M6-01 live sector SoA, the thinker arena, hook slots, the PRNG and the
 * run counters/globals. Kept structural so this module imports only types.
 */
export interface SpecWorld {
  readonly map: RuntimeMap;
  readonly sectors: LiveSectors;
  readonly thinkers: ThinkerArena;
  readonly hooks: HookSlots;
  readonly rng: PrngState;
  leveltime: number;
  exitRequest: 'none' | ExitKind;
  totalsecret: number;
  secretcount: number;
  specialexit: boolean;
}

/* doomdata.h line flags used by the helpers + gates */
export const ML_TWOSIDED = 0x004;
export const ML_SECRET = 0x020;

/* p_spec.c constants */
export const MAX_ADJOINING_SECTORS = 20;
/** MAXINT (p_spec.c's P_FindLowestCeilingSurrounding seed). */
export const MAXINT32 = 0x7fffffff;

/* ------------------------------------------------------------------ */
/* getSide/getSector/twoSided/getNextSector (p_spec.c utilities)        */
/* ------------------------------------------------------------------ */

/** vanilla `sectors[sec].lines[k]` — the k-th bordering linedef (CSR). */
export function sectorLineAt(map: RuntimeMap, sec: number, k: number): number {
  return map.sectorLineIndex[map.sectors.lineStart[sec]! + k]!;
}

/** `twoSided(currentSector, lineIdx)` — p_spec.c (argument indexes the
 * sector's lines[] list, semantics = the linedef's ML_TWOSIDED flag). */
export function twoSided(map: RuntimeMap, sec: number, k: number): boolean {
  return (map.lines.flags[sectorLineAt(map, sec, k)]! & ML_TWOSIDED) !== 0;
}

/** `getSector(currentSector, lineIdx, side)` — p_spec.c: the sector on the
 * chosen side of the k-th line of `sec` (side 0 = sidenum[0] = front). */
export function getSector(
  map: RuntimeMap, sec: number, k: number, side: number
): number {
  const line = sectorLineAt(map, sec, k);
  return side === 0 ? map.lines.sectorFront[line]! : map.lines.sectorBack[line]!;
}

/**
 * `getNextSector(line, sec)` (p_spec.c) — the sector across `line` from
 * `sec`, or −1 for a one-sided line. `line` here is a GLOBAL linedef
 * index (vanilla takes line_t*).
 */
export function getNextSector(
  map: RuntimeMap, line: number, sec: number
): number {
  if ((map.lines.flags[line]! & ML_TWOSIDED) === 0) return -1;
  // vanilla compares line->frontsector == sec; the port's sectorFront is
  // exactly that resolution (map.ts P_LoadLineDefs).
  return map.lines.sectorFront[line] === sec
    ? map.lines.sectorBack[line]!
    : map.lines.sectorFront[line]!;
}

/* ------------------------------------------------------------------ */
/* P_Find*Surrounding (live SoA reads — movers mutate state.sectors)    */
/* ------------------------------------------------------------------ */

/** `P_FindLowestFloorSurrounding(sec)` — seeds at the sector's OWN floor
 * (so a fully sealed room returns its own height, p_spec.c). */
export function pFindLowestFloorSurrounding(s: SpecWorld, sec: number): number {
  const L = s.map.sectors.lineStart;
  const C = s.map.sectors.lineCount;
  const idx = s.map.sectorLineIndex;
  const fz = s.sectors.floorZ;
  let floor = fz[sec]!;
  for (let i = L[sec]!, n = L[sec]! + C[sec]!; i < n; i++) {
    const other = getNextSector(s.map, idx[i]!, sec);
    if (other < 0) continue;
    if (fz[other]! < floor) floor = fz[other]!;
  }
  return floor;
}

/** `P_FindHighestFloorSurrounding(sec)` — seed −500*FRACUNIT (p_spec.c). */
export function pFindHighestFloorSurrounding(s: SpecWorld, sec: number): number {
  const L = s.map.sectors.lineStart;
  const C = s.map.sectors.lineCount;
  const idx = s.map.sectorLineIndex;
  const fz = s.sectors.floorZ;
  let floor = -500 * FRACUNIT;
  for (let i = L[sec]!, n = L[sec]! + C[sec]!; i < n; i++) {
    const other = getNextSector(s.map, idx[i]!, sec);
    if (other < 0) continue;
    if (fz[other]! > floor) floor = fz[other]!;
  }
  return floor;
}

/** Module scratch for `fixed_t heightlist[20]` (never escapes, reused —
 * helpers do not recurse). */
const heightlist = new Int32Array(MAX_ADJOINING_SECTORS);

/** Overflow bookkeeping (the vanilla `fprintf(stderr, "Sector with more
 * than 20 adjoining sectors")` slot — counted, not printed). */
export const pspecHelperCounts = {
  nextHighestFloorOverflow: 0,
  /** unknown sector special reached in a dispatch (M6-12 wires the throw). */
  unknownSectorSpecial: 0
};

export function resetPspecHelperCounts(): void {
  pspecHelperCounts.nextHighestFloorOverflow = 0;
  pspecHelperCounts.unknownSectorSpecial = 0;
}

/**
 * `P_FindNextHighestFloor(sec, currentheight)` verbatim: collect the
 * surrounding floors STRICTLY ABOVE currentheight in adjoining-linedef
 * order into a 20-slot list, return the minimum; the overflow `break` is
 * checked on EVERY adjoining sector AFTER the push (p_spec.c), aborting
 * the scan at 20 collected entries. No neighbours above ⇒ currentheight.
 */
export function pFindNextHighestFloor(
  s: SpecWorld, sec: number, currentheight: number
): number {
  const L = s.map.sectors.lineStart;
  const C = s.map.sectors.lineCount;
  const idx = s.map.sectorLineIndex;
  const fz = s.sectors.floorZ;
  let h = 0;
  for (let i = L[sec]!, n = L[sec]! + C[sec]!; i < n; i++) {
    const other = getNextSector(s.map, idx[i]!, sec);
    if (other < 0) continue;
    if (fz[other]! > currentheight) {
      if (h < MAX_ADJOINING_SECTORS) heightlist[h] = fz[other]!;
      h++;
    }
    // vanilla `if (h >= MAX_ADJOINING_SECTORS) break;` — checked every
    // adjoining sector after the push attempt.
    if (h >= MAX_ADJOINING_SECTORS) {
      pspecHelperCounts.nextHighestFloorOverflow++;
      break;
    }
  }
  if (h === 0) return currentheight;
  const cap = h > MAX_ADJOINING_SECTORS ? MAX_ADJOINING_SECTORS : h;
  let min = heightlist[0]!;
  for (let i = 1; i < cap; i++) if (heightlist[i]! < min) min = heightlist[i]!;
  return min;
}

/** `P_FindLowestCeilingSurrounding(sec)` — seed MAXINT (p_spec.c; a
 * sealed room returns MAXINT, pinned). */
export function pFindLowestCeilingSurrounding(s: SpecWorld, sec: number): number {
  const L = s.map.sectors.lineStart;
  const C = s.map.sectors.lineCount;
  const idx = s.map.sectorLineIndex;
  const cz = s.sectors.ceilingZ;
  let height = MAXINT32;
  for (let i = L[sec]!, n = L[sec]! + C[sec]!; i < n; i++) {
    const other = getNextSector(s.map, idx[i]!, sec);
    if (other < 0) continue;
    if (cz[other]! < height) height = cz[other]!;
  }
  return height;
}

/** `P_FindHighestCeilingSurrounding(sec)` — seed 0 (p_spec.c). */
export function pFindHighestCeilingSurrounding(s: SpecWorld, sec: number): number {
  const L = s.map.sectors.lineStart;
  const C = s.map.sectors.lineCount;
  const idx = s.map.sectorLineIndex;
  const cz = s.sectors.ceilingZ;
  let height = 0;
  for (let i = L[sec]!, n = L[sec]! + C[sec]!; i < n; i++) {
    const other = getNextSector(s.map, idx[i]!, sec);
    if (other < 0) continue;
    if (cz[other]! > height) height = cz[other]!;
  }
  return height;
}

/**
 * `P_FindSectorFromLineTag(line, start)` — ascending resumable scan of
 * LIVE sector tags (value-identical to the static copy; the live SoA is
 * the hashed authority so the scan reads it). NO tag-0 fallback.
 */
export function pFindSectorFromLineTag(
  s: SpecWorld, line: number, start: number
): number {
  const tag = s.map.lines.tag[line]!;
  const tags = s.sectors.tag;
  for (let i = start + 1; i < s.sectors.count; i++) {
    if (tags[i] === tag) return i;
  }
  return -1;
}

/** `P_FindMinSurroundingLight(sector, max)` — min of adjoining live
 * lightlevels, capped at `max` (p_spec.c). */
export function pFindMinSurroundingLight(
  s: SpecWorld, sec: number, max: number
): number {
  const L = s.map.sectors.lineStart;
  const C = s.map.sectors.lineCount;
  const idx = s.map.sectorLineIndex;
  const li = s.sectors.light;
  let min = max;
  for (let i = L[sec]!, n = L[sec]! + C[sec]!; i < n; i++) {
    const check = getNextSector(s.map, idx[i]!, sec);
    if (check < 0) continue;
    if (li[check]! < min) min = li[check]!;
  }
  return min;
}
