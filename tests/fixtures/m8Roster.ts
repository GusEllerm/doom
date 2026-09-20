/**
 * M8-03 — E1 monster census roster (docs/design/M8-plan.md §M8-03 / §0.12).
 *
 * THE WAD IS THE SOURCE OF TRUTH. Every number here was measured against the
 * pinned `wads/freedoom1.wad` with the in-repo readers (`src/wad/mapdata.ts`
 * 10-byte THINGS records, `src/wad/info/mobjinfo.ts` `DOOMEDNUM_TO_MT`) and
 * the vanilla `P_SpawnMapThing` filter (p_mobj.c, R06 §6):
 *
 *   - skip type <= 4 (player starts) and type 11 (deathmatch starts);
 *   - single player: skip when `options & MTF_NOTSINGLEPLAYER` (bit 16,
 *     `MTF_NOTSINGLEPLAYER` as exported by `src/sim/thinglinks.ts`);
 *   - skill: keep when `options & skillBit(skill)` — with the census skill
 *     number 3 (plan §M8-03 formula `options & (1<<2)`) `skillBit(3)` = 4,
 *     the vanilla `MTF_HARD` bit (doomdef.h:140-145; baby/easy→1, normal→2,
 *     hard→4, nightmare→4).
 *
 * DISCREPANCIES vs the plan §0.12 table (plan is docs; the WAD wins — see
 * task FINDINGS; plan §0.12 applied `!(options & 0x20)` as the "not single"
 * check, but vanilla's check is `!netgame && (options & 16)` — bit 0x20 is
 * unused by vanilla P_SpawnMapThing, while bit 16 marks netgame-only
 * things that never spawn in single player):
 *   - MT_SHOTGUY  (dn 9)    alive: WAD 376,  plan 379 (+3 netgame-only)
 *   - MT_TROOP    (dn 3001) alive: WAD 423,  plan 424 (+1 netgame-only)
 *   - MT_SERGEANT (dn 3002) alive: WAD 142,  plan 145 (+3 netgame-only)
 *   - MT_SHADOWS  (dn 58)   alive: WAD 94,   plan 97  (+3 netgame-only)
 *   - MT_SHADOWS "where": WAD E1M1-E1M7 + E1M9 (8 maps, incl. E1M2 ×12);
 *     plan omitted E1M2.
 *   - MT_BARREL "where": present on 7 of 9 maps (absent E1M5 and E1M8);
 *     plan said "8 of 9 maps".
 *   - "every E1 map" for POSS/SPOS/TROO/SARG: true for E1M1-E1M7 + E1M9;
 *     E1M8 holds NO zombies/imps/sergeants at all (only 4 barons).
 *   - MT_POSSESSED (264), MT_SKULL (11), MT_BRUISER (4) and all raw
 *     "present" totals match §0.12 exactly; the "absent in E1" set (below)
 *     is confirmed 0 across E1M1-E1M9.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { MT } from '../../src/wad/info/mobjinfo';

/** The nine Phase-1 maps, in census order. */
export const E1_MAPS = [
  'E1M1',
  'E1M2',
  'E1M3',
  'E1M4',
  'E1M5',
  'E1M6',
  'E1M7',
  'E1M8',
  'E1M9'
] as const;

export type E1Map = (typeof E1_MAPS)[number];

/** Skill number the census is measured at (plan §M8-03; `skillBit(3)` = 4). */
export const CENSUS_SKILL = 3;

/** One roster entry: a doomednum classified to a concrete MT_ index. */
export interface RosterEntry {
  readonly doomednum: number;
  readonly mt: number;
  readonly name: string;
  /** MF_COUNTKILL membership (mobjinfo), asserted from the table itself. */
  readonly countKill: boolean;
}

/** Monsters that appear in E1M1-E1M9 (plan §0.12 consequence (a)). */
export const E1_MONSTER_ROSTER: readonly RosterEntry[] = [
  { doomednum: 3004, mt: MT.MT_POSSESSED, name: 'MT_POSSESSED', countKill: true },
  { doomednum: 9, mt: MT.MT_SHOTGUY, name: 'MT_SHOTGUY', countKill: true },
  { doomednum: 3001, mt: MT.MT_TROOP, name: 'MT_TROOP', countKill: true },
  { doomednum: 3002, mt: MT.MT_SERGEANT, name: 'MT_SERGEANT', countKill: true },
  { doomednum: 58, mt: MT.MT_SHADOWS, name: 'MT_SHADOWS', countKill: true },
  // Lost souls are monsters but NOT MF_COUNTKILL (§0.12 consequence (b)).
  { doomednum: 3006, mt: MT.MT_SKULL, name: 'MT_SKULL', countKill: false },
  { doomednum: 3003, mt: MT.MT_BRUISER, name: 'MT_BRUISER', countKill: true }
];

/** Tracked non-monster shootable (barrel): counted, never a monster. */
export const E1_BARREL_ROSTER: RosterEntry = {
  doomednum: 2035,
  mt: MT.MT_BARREL,
  name: 'MT_BARREL',
  countKill: false
};

/**
 * Doomednums that must have ZERO records anywhere in E1M1-E1M9
 * (plan §0.12 "absent in E1" set; names resolved through
 * `DOOMEDNUM_TO_MT` — the plan's label for 66 was ambiguous
 * ("CYBER?"); the table says MT_UNDEAD).
 */
export const ABSENT_IN_E1: readonly { doomednum: number; mt: number; name: string }[] = [
  { doomednum: 3005, mt: MT.MT_HEAD, name: 'MT_HEAD' },
  { doomednum: 69, mt: MT.MT_KNIGHT, name: 'MT_KNIGHT' },
  { doomednum: 65, mt: MT.MT_CHAINGUY, name: 'MT_CHAINGUY' },
  { doomednum: 16, mt: MT.MT_CYBORG, name: 'MT_CYBORG' },
  { doomednum: 7, mt: MT.MT_SPIDER, name: 'MT_SPIDER' },
  { doomednum: 71, mt: MT.MT_PAIN, name: 'MT_PAIN' },
  { doomednum: 64, mt: MT.MT_VILE, name: 'MT_VILE' },
  { doomednum: 66, mt: MT.MT_UNDEAD, name: 'MT_UNDEAD' },
  { doomednum: 67, mt: MT.MT_FATSO, name: 'MT_FATSO' },
  { doomednum: 68, mt: MT.MT_BABY, name: 'MT_BABY' },
  { doomednum: 72, mt: MT.MT_KEEN, name: 'MT_KEEN' },
  { doomednum: 84, mt: MT.MT_WOLFSS, name: 'MT_WOLFSS' }
];

/** Per-doomednum counts: `raw` = every THINGS record; `alive` = records that
 * pass the single-player skill-3 spawn filter above. */
export interface CensusCell {
  readonly raw: number;
  readonly alive: number;
}

/**
 * Ground-truth matrix measured on the pinned freedoom1.wad (skill 3,
 * single player). Tracked doomednums only; all other doomednums are
 * decor/items/starts and are covered by the classification integrity test.
 */
export const WAD_CENSUS: Readonly<Record<E1Map, Readonly<Record<number, CensusCell>>>> = {
  E1M1: {
    3004: { raw: 12, alive: 5 },
    9: { raw: 13, alive: 13 },
    3001: { raw: 18, alive: 18 },
    3002: { raw: 9, alive: 9 },
    58: { raw: 1, alive: 1 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 22, alive: 22 }
  },
  E1M2: {
    3004: { raw: 26, alive: 26 },
    9: { raw: 28, alive: 28 },
    3001: { raw: 42, alive: 39 },
    3002: { raw: 21, alive: 18 },
    58: { raw: 12, alive: 12 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 9, alive: 9 }
  },
  E1M3: {
    3004: { raw: 38, alive: 33 },
    9: { raw: 49, alive: 49 },
    3001: { raw: 54, alive: 54 },
    3002: { raw: 8, alive: 8 },
    58: { raw: 3, alive: 3 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 13, alive: 13 }
  },
  E1M4: {
    3004: { raw: 63, alive: 49 },
    9: { raw: 49, alive: 49 },
    3001: { raw: 51, alive: 49 },
    3002: { raw: 13, alive: 12 },
    58: { raw: 7, alive: 5 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 14, alive: 14 }
  },
  E1M5: {
    3004: { raw: 68, alive: 37 },
    9: { raw: 53, alive: 53 },
    3001: { raw: 43, alive: 40 },
    3002: { raw: 15, alive: 7 },
    58: { raw: 10, alive: 10 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 0, alive: 0 }
  },
  E1M6: {
    3004: { raw: 65, alive: 54 },
    9: { raw: 99, alive: 98 },
    3001: { raw: 72, alive: 69 },
    3002: { raw: 30, alive: 24 },
    58: { raw: 25, alive: 25 },
    3006: { raw: 3, alive: 3 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 7, alive: 7 }
  },
  E1M7: {
    3004: { raw: 33, alive: 33 },
    9: { raw: 55, alive: 55 },
    3001: { raw: 110, alive: 109 },
    3002: { raw: 53, alive: 50 },
    58: { raw: 30, alive: 30 },
    3006: { raw: 8, alive: 8 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 16, alive: 16 }
  },
  E1M8: {
    3004: { raw: 0, alive: 0 },
    9: { raw: 0, alive: 0 },
    3001: { raw: 0, alive: 0 },
    3002: { raw: 0, alive: 0 },
    58: { raw: 0, alive: 0 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 4, alive: 4 },
    2035: { raw: 0, alive: 0 }
  },
  E1M9: {
    3004: { raw: 35, alive: 27 },
    9: { raw: 34, alive: 31 },
    3001: { raw: 48, alive: 45 },
    3002: { raw: 17, alive: 14 },
    58: { raw: 11, alive: 8 },
    3006: { raw: 0, alive: 0 },
    3003: { raw: 0, alive: 0 },
    2035: { raw: 15, alive: 13 }
  }
};

/** Cross-map totals of `WAD_CENSUS` (plan §0.12 "present" column + WAD-correct alive column). */
export const WAD_CENSUS_TOTALS: Readonly<Record<number, CensusCell>> = {
  3004: { raw: 340, alive: 264 },
  9: { raw: 380, alive: 376 },
  3001: { raw: 438, alive: 423 },
  3002: { raw: 166, alive: 142 },
  58: { raw: 99, alive: 94 },
  3006: { raw: 11, alive: 11 },
  3003: { raw: 4, alive: 4 },
  2035: { raw: 96, alive: 94 }
};
