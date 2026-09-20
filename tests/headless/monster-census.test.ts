/**
 * M8-03 — E1 monster census (docs/design/M8-plan.md §M8-03, table §0.12).
 *
 * Enumerates every THINGS record of E1M1-E1M9 in the pinned
 * `wads/freedoom1.wad` (auto-skip when absent — the suite skip-passes
 * without the wad), applies the vanilla `P_SpawnMapThing` single-player
 * skill-3 filter through the fixture helper, classifies each doomednum
 * through the existing `DOOMEDNUM_TO_MT` table (M7-01), and asserts the
 * exact per-map matrix committed in `tests/fixtures/m8Roster.ts` —
 * including the "absent in E1" set.
 *
 * THE WAD WINS: the roster numbers are WAD-measured and deviate where the
 * plan §0.12 table was mis-filtered (`!(options & 0x20)` instead of the
 * real "not in single player" bit 16, plus a wrong E1M2/barrel "where");
 * m8Roster.ts documents each disagreement. A clean run prints NOTHING
 * (the census helper and these assertions never touch console — the last
 * two tests enforce that mechanically).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { MF, DOOMEDNUM_TO_MT, MT, mobjinfo } from '../../src/wad/info/mobjinfo';
import { WadFile } from '../../src/wad/wadfile';
import { buildFixtureMapWad } from '../fixtures/mapBuilder';
import {
  CENSUS_FIX_HAND_COUNTS,
  CENSUS_FIX_MAP,
  CENSUS_FIX_SPEC,
  censusThings
} from '../fixtures/m8Fixtures';
import {
  ABSENT_IN_E1,
  E1_BARREL_ROSTER,
  E1_MAPS,
  E1_MONSTER_ROSTER,
  WAD_CENSUS,
  WAD_CENSUS_TOTALS
} from '../fixtures/m8Roster';

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

function wadBytesToBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let wadCache: WadFile | undefined;
function wadFile(): WadFile {
  if (!wadCache) wadCache = WadFile.parse(wadBytesToBuffer(readFileSync(WAD_PATH)));
  return wadCache;
}

/** Doomednums the committed matrix tracks (7 monsters + barrels). */
const TRACKED = [...E1_MONSTER_ROSTER, E1_BARREL_ROSTER].map((r) => r.doomednum);

describe.skipIf(!hasWad)('freedoom1.wad E1 monster census (skill 3, single player)', () => {
  for (const map of E1_MAPS) {
    it(`${map}: per-doomednum raw + alive matrix matches the roster`, () => {
      const census = censusThings(wadFile(), map);
      for (const dn of TRACKED) {
        const cell = WAD_CENSUS[map]![dn]!;
        expect(census.rawByDoomednum.get(dn) ?? 0, `${map} raw ${dn}`).toBe(cell.raw);
        expect(census.aliveByDoomednum.get(dn) ?? 0, `${map} alive ${dn}`).toBe(cell.alive);
      }
    });
  }

  it('cross-map totals match the roster totals column', () => {
    const rawTotals = new Map<number, number>();
    const aliveTotals = new Map<number, number>();
    for (const map of E1_MAPS) {
      const census = censusThings(wadFile(), map);
      for (const dn of TRACKED) {
        rawTotals.set(dn, (rawTotals.get(dn) ?? 0) + (census.rawByDoomednum.get(dn) ?? 0));
        aliveTotals.set(dn, (aliveTotals.get(dn) ?? 0) + (census.aliveByDoomednum.get(dn) ?? 0));
      }
    }
    for (const dn of TRACKED) {
      expect(rawTotals.get(dn) ?? 0, `total raw ${dn}`).toBe(WAD_CENSUS_TOTALS[dn]!.raw);
      expect(aliveTotals.get(dn) ?? 0, `total alive ${dn}`).toBe(WAD_CENSUS_TOTALS[dn]!.alive);
    }
  });

  it('the "absent in E1" doomednums never appear', () => {
    for (const map of E1_MAPS) {
      const census = censusThings(wadFile(), map);
      for (const { doomednum } of ABSENT_IN_E1) {
        expect(census.rawByDoomednum.get(doomednum) ?? 0, `${map} raw ${doomednum}`).toBe(0);
        expect(census.aliveByDoomednum.get(doomednum) ?? 0, `${map} alive ${doomednum}`).toBe(0);
      }
    }
  });

  it('classification integrity: no unknown doomednums, roster MT + COUNTKILL facts hold', () => {
    for (const map of E1_MAPS) {
      expect(censusThings(wadFile(), map).unknownDoomednums, map).toEqual([]);
    }
    for (const r of [...E1_MONSTER_ROSTER, E1_BARREL_ROSTER]) {
      expect(DOOMEDNUM_TO_MT.get(r.doomednum), r.name).toBe(r.mt);
      expect(mobjinfo[r.mt]!.doomednum, r.name).toBe(r.doomednum);
      const ck = (mobjinfo[r.mt]!.flags & MF.MF_COUNTKILL) !== 0;
      expect(ck, r.name).toBe(r.countKill);
    }
    // E1M8 is the baron-only map (plan §0.12 consequence (c)).
    const e1m8 = censusThings(wadFile(), 'E1M8');
    expect(e1m8.aliveByDoomednum.get(3003) ?? 0).toBe(4);
    for (const r of E1_MONSTER_ROSTER) {
      if (r.doomednum === 3003) continue;
      expect(e1m8.aliveByDoomednum.get(r.doomednum) ?? 0, r.name).toBe(0);
    }
    // Lost souls are monsters but never count toward killcount (§0.12 (b)).
    expect(MF.MF_COUNTKILL & mobjinfo[MT.MT_SKULL]!.flags).toBe(0);
  });

  it('census run over all nine maps produces zero console output', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    try {
      for (const map of E1_MAPS) censusThings(wadFile(), map);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe('synthetic hand-count map M8CENS (wad-free)', () => {
  const wad = WadFile.parse(wadBytesToBuffer(buildFixtureMapWad(CENSUS_FIX_SPEC, CENSUS_FIX_MAP)));
  const census = censusThings(wad, CENSUS_FIX_MAP);

  it('thing totals match the hand counts', () => {
    expect(census.totalThings).toBe(CENSUS_FIX_HAND_COUNTS.totalThings);
    expect(census.specialThings).toBe(CENSUS_FIX_HAND_COUNTS.specialThings);
    expect(census.unknownDoomednums).toEqual([]);
  });

  it('raw + alive doomednum counts match the hand counts exactly', () => {
    const hand = CENSUS_FIX_HAND_COUNTS;
    expect([...census.rawByDoomednum.keys()].sort((a, b) => a - b)).toEqual(
      Object.keys(hand.raw)
        .map(Number)
        .sort((a, b) => a - b)
    );
    for (const [dn, want] of Object.entries(hand.raw)) {
      expect(census.rawByDoomednum.get(Number(dn)) ?? 0, `raw ${dn}`).toBe(want);
    }
    for (const [dn, want] of Object.entries(hand.alive)) {
      expect(census.aliveByDoomednum.get(Number(dn)) ?? 0, `alive ${dn}`).toBe(want);
    }
    if (Object.values(hand.alive).every((v) => v > 0)) {
      expect(census.aliveByDoomednum.size).toBe(Object.keys(hand.alive).length);
    }
  });

  it('bit-rule discriminators: 0x20 spawns, bit 16 solo-skips, ambush is not a filter', () => {
    // TROO pair carries the UNUSED 0x20 bit: the plan §0.12 filter would
    // have dropped them (0 alive); vanilla/WAD keeps both. The WAD wins.
    expect(census.aliveByDoomednum.get(3001)).toBe(2);
    // One POSS + one SPOS + one SHADOWS carry bit 16 (not-in-single):
    // never spawned in single player at any skill.
    expect(census.aliveByDoomednum.get(3004)).toBe(4); // 7 raw - 2 × bit16 - 1 × no hard bit
    expect(census.aliveByDoomednum.get(9)).toBe(1);
    expect(census.aliveByDoomednum.get(58)).toBe(2);
    // Ambush (bit 8) only sets MF_AMBUSH; the thing still spawns.
    expect(census.rawByDoomednum.get(3004)).toBe(7);
  });

  it('synthetic census produces zero console output', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    try {
      const fresh = WadFile.parse(
        wadBytesToBuffer(buildFixtureMapWad(CENSUS_FIX_SPEC, CENSUS_FIX_MAP))
      );
      censusThings(fresh, CENSUS_FIX_MAP);
    } finally {
      for (const s of spies) s.mockRestore();
    }
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});
