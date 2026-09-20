/**
 * M8-03 — monster-census fixtures (docs/design/M8-plan.md §M8-03).
 *
 * Two things live here:
 *
 *  1. `censusThings()` — the wad-free THINGS enumerator used by
 *     `tests/headless/monster-census.test.ts`. It reads the raw 10-byte
 *     THINGS records through `src/wad/mapdata.ts` and applies EXACTLY the
 *     vanilla `P_SpawnMapThing` single-player filter (R06 §6, verified):
 *       - types 1-4 (player starts) and 11 (deathmatch starts) are handled
 *         specially by P_SpawnMapThing and never reach the doomednum scan;
 *       - `!netgame && (options & MTF_NOTSINGLEPLAYER)` (bit 16) ⇒ skip;
 *       - `!(options & skillBit(skill))` ⇒ skip — census skill 3 ⇒ bit 4
 *         (`MTF_HARD`), the plan §M8-03 formula `options & (1<<2)`;
 *       - bit 8 (MTF_AMBUSH) and bit 0x20 (unused by vanilla) never affect
 *         spawn eligibility — the 0x20 case is the discriminating fixture
 *         for the §0.12 plan discrepancy (the plan filtered on `!(options
 *         & 0x20)` instead of the real `!(options & 16)`; see m8Roster.ts).
 *     Classification uses the existing `DOOMEDNUM_TO_MT` table (M7-01);
 *     nothing is re-transcribed here.
 *
 *  2. `CENSUS_FIX_SPEC` + `CENSUS_FIX_HAND_COUNTS` — a synthetic one-room
 *     map whose THINGS spell out every filter branch, with hand counts
 *     written next to the thing list (acceptance criterion 2 of §M8-03).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { loadMap, thingAt, thingCount } from '../../src/wad/mapdata';
import type { WadFile } from '../../src/wad/wadfile';
import { DOOMEDNUM_TO_MT } from '../../src/wad/info/mobjinfo';
import { MTF_NOTSINGLEPLAYER, skillBit } from '../../src/sim/thinglinks';
import type { RectMapSpec } from './mapBuilder';
import { CENSUS_SKILL } from './m8Roster';

/* ------------------------------------------------------------------ */
/* WAD census helper                                                   */
/* ------------------------------------------------------------------ */

/** Result of {@link censusThings} for one map lump. */
export interface ThingCensus {
  /** doomednum → record count for every type except starts (<=4, 11). */
  readonly rawByDoomednum: ReadonlyMap<number, number>;
  /** doomednum → count of records that pass the spawn filter (known
   * doomednums only — unknown ones land in {@link unknownDoomednums}). */
  readonly aliveByDoomednum: ReadonlyMap<number, number>;
  /** Sorted unique doomednums that passed the filter but are unknown to
   * `DOOMEDNUM_TO_MT` (vanilla: fatal I_Error; our port: counted skip). */
  readonly unknownDoomednums: readonly number[];
  /** Count of player-start (1-4) + deathmatch-start (11) records. */
  readonly specialThings: number;
  /** Total THINGS records in the lump. */
  readonly totalThings: number;
}

/**
 * Enumerate one map's THINGS lump and census it at `skill` (default
 * {@link CENSUS_SKILL}) for SINGLE PLAYER (`netgame = false`). Pure and
 * side-effect free — emits nothing (acceptance criterion 3).
 */
export function censusThings(wad: WadFile, mapName: string, skill = CENSUS_SKILL): ThingCensus {
  const md = loadMap(wad, mapName);
  const bit = skillBit(skill);
  const raw = new Map<number, number>();
  const alive = new Map<number, number>();
  const unknown = new Set<number>();
  let special = 0;
  const total = thingCount(md);
  for (let i = 0; i < total; i++) {
    const t = thingAt(md, i);
    if (t.type <= 4 || t.type === 11) {
      special++;
      continue;
    }
    raw.set(t.type, (raw.get(t.type) ?? 0) + 1);
    // P_SpawnMapThing order (p_mobj.c): solo bit first, then skill bit,
    // then the doomednum scan.
    if ((t.flags & MTF_NOTSINGLEPLAYER) !== 0) continue;
    if ((t.flags & bit) === 0) continue;
    if (!DOOMEDNUM_TO_MT.has(t.type)) {
      unknown.add(t.type);
      continue;
    }
    alive.set(t.type, (alive.get(t.type) ?? 0) + 1);
  }
  return {
    rawByDoomednum: raw,
    aliveByDoomednum: alive,
    unknownDoomednums: [...unknown].sort((a, b) => a - b),
    specialThings: special,
    totalThings: total
  };
}

/* ------------------------------------------------------------------ */
/* Synthetic hand-count map                                            */
/* ------------------------------------------------------------------ */

/** Option-bit shorthands used by the hand-count map (doomdef.h:140-145). */
const F_ALL = 0x7; // easy|normal|hard — spawns at any census skill
const F_HARD = 0x4; // hard only
const F_EASY_NORMAL = 0x3; // never at skill 3
const F_HARD_NS = 0x4 | 0x10; // hard + "not in single player" (bit 16)
const F_HARD_AMBUSH = 0x4 | 0x8; // ambush bit is NOT a filter (MF_AMBUSH only)
const F_HARD_0x20 = 0x4 | 0x20; // 0x20 unused by vanilla — must still spawn
const F_NORMAL = 0x2; // normal bit only
const F_NORMAL_HARD = 0x6; // normal|hard
const F_NORMAL_HARD_NS = 0x6 | 0x10;
const F_EASY = 0x1; // easy only
const F_NONE = 0x0; // no skill bit — never spawns anywhere

/** One bright 512×512 room; every thing sits inside it. */
function spot(n: number): { x: number; y: number } {
  return { x: 64 + (n % 16) * 24, y: 64 + ((n / 16) | 0) * 24 };
}

let n = 0;
const at = () => spot(n++);

/**
 * Hand-crafted THINGS for `M8CENS` — the hand counts (raw / alive at skill
 * 3, single player) are written per group and re-stated in
 * {@link CENSUS_FIX_HAND_COUNTS}:
 *
 *   starts:     4 player starts (1-4) + 2 DM starts (11)   → 6 specials
 *   3004 POSS:  flags 7, 7, 4, 3, HARD|NS, HARD|NS, HARD|AMBUSH
 *                                                       raw 7 / alive 4
 *   9    SPOS:  flags 7, HARD|NS, NONE                   raw 3 / alive 1
 *   3001 TROO:  flags HARD|0x20, HARD|0x20 (×2)          raw 2 / alive 2
 *   3002 SARG:  flags NORMAL (×3)                        raw 3 / alive 0
 *   58  SHADOWS: flags 6, 6, 6|NS                        raw 3 / alive 2
 *   3006 SKULL: flags HARD                               raw 1 / alive 1
 *   3003 BRUISER: flags 7                                raw 1 / alive 1
 *   2035 BARREL: flags 7, 7, 7, EASY                     raw 4 / alive 3
 *   34    torch (decor, classified non-monster)  flags 7 raw 1 / alive 1
 *
 * TOTAL things = 31 (6 specials + 25 census things).
 */
export const CENSUS_FIX_SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
  things: [
    // --- starts: handled specially, never censused -------------------
    { ...at(), type: 1, angle: 0 },
    { ...at(), type: 2, angle: 90 },
    { ...at(), type: 3, angle: 180 },
    { ...at(), type: 4, angle: 270 },
    { ...at(), type: 11 },
    { ...at(), type: 11 },
    // --- 3004 POSS: 7 records, 4 alive -------------------------------
    { ...at(), type: 3004, flags: F_ALL },
    { ...at(), type: 3004, flags: F_ALL },
    { ...at(), type: 3004, flags: F_HARD },
    { ...at(), type: 3004, flags: F_EASY_NORMAL },
    { ...at(), type: 3004, flags: F_HARD_NS },
    { ...at(), type: 3004, flags: F_HARD_NS },
    { ...at(), type: 3004, flags: F_HARD_AMBUSH },
    // --- 9 SPOS: 3 records, 1 alive ----------------------------------
    { ...at(), type: 9, flags: F_ALL },
    { ...at(), type: 9, flags: F_HARD_NS },
    { ...at(), type: 9, flags: F_NONE },
    // --- 3001 TROO: 2 records, both alive (0x20 is not a filter) -----
    { ...at(), type: 3001, flags: F_HARD_0x20 },
    { ...at(), type: 3001, flags: F_HARD_0x20 },
    // --- 3002 SARG: 3 records, 0 alive (normal bit only) -------------
    { ...at(), type: 3002, flags: F_NORMAL },
    { ...at(), type: 3002, flags: F_NORMAL },
    { ...at(), type: 3002, flags: F_NORMAL },
    // --- 58 SHADOWS: 3 records, 2 alive ------------------------------
    { ...at(), type: 58, flags: F_NORMAL_HARD },
    { ...at(), type: 58, flags: F_NORMAL_HARD },
    { ...at(), type: 58, flags: F_NORMAL_HARD_NS },
    // --- 3006 SKULL / 3003 BRUISER -----------------------------------
    { ...at(), type: 3006, flags: F_HARD },
    { ...at(), type: 3003, flags: F_ALL },
    // --- 2035 barrels: 4 records, 3 alive ----------------------------
    { ...at(), type: 2035, flags: F_ALL },
    { ...at(), type: 2035, flags: F_ALL },
    { ...at(), type: 2035, flags: F_ALL },
    { ...at(), type: 2035, flags: F_EASY },
    // --- decor (classified, not a monster) ---------------------------
    { ...at(), type: 34, flags: F_ALL }
  ]
};

/** Map lump name for {@link CENSUS_FIX_SPEC}. */
export const CENSUS_FIX_MAP = 'M8CENS';

/** Hand counts for {@link CENSUS_FIX_SPEC} (see the table on the spec). */
export const CENSUS_FIX_HAND_COUNTS = {
  totalThings: 31,
  specialThings: 6,
  raw: { 3004: 7, 9: 3, 3001: 2, 3002: 3, 58: 3, 3006: 1, 3003: 1, 2035: 4, 34: 1 },
  alive: { 3004: 4, 9: 1, 3001: 2, 3002: 0, 58: 2, 3006: 1, 3003: 1, 2035: 3, 34: 1 }
} as const;
