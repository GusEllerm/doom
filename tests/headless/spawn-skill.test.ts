/**
 * B-10 regression — G_DeferedInitNew(skill) TABLE test (sim level).
 *
 * The user report: "live E1M1 via New Game menu spawns ~1 monster; census
 * truth = 32 hostiles at skill 3". The prime suspect was the menu→skill
 * plumbing (vanilla passes the MENU CHOICE INDEX 0..4 straight through
 * G_DeferedInitNew → gameskill — m_menu.c:915, g_game.c:1450 — and the
 * P_SpawnMapThing bit is `1<<(gameskill-1)` with baby/easy/nightmare
 * special cases, p_mobj.c:741-748; a missing/double `-1` anywhere in our
 * 1-based seam would read the WRONG bit). This test pins the WHOLE TABLE,
 * every skill, on the exact menu-call-shaped drain:
 *
 *   gInitGame(default) → gDeferedInitNew(raw, 1, 1) → gTicker (ONE tic:
 *   ga_newgame → G_DoNewGame → G_InitNew → clampNewGame → skillToInternal
 *   → P_SetupLevel spawn pass)
 *
 * asserting (a) gameskill == raw (1-based seam domain, gamemode.ts),
 * (b) state.skill == raw-1 (doomdef.h sk_baby=0..sk_nightmare=4), and
 * (c) the LIVE spawned-monster census equals BOTH the committed
 * E1M1_SKILL_ALIVE row AND a freshly recomputed WAD THINGS census — the
 * identical expectation the e2e menu-path spec (e2e/spawn-skill.spec.ts)
 * asserts through the real browser menu. Part (d) kills the "spawning
 * outside the level" theory: every spawned hostile's position resolves to
 * a real BSP subsector/sector (subsectorAt) — no silent drops, no void.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { DOOMEDNUM_TO_MT, MF, MT, mobjinfo } from '../../src/wad/info/mobjinfo';
import { buildMapFromData } from '../../src/sim/map';
import { gDeferedInitNew, gInitGame, gTicker, registerGameFlowHooks, resetGameFlow } from '../../src/sim/game';
import { subsectorAt } from '../../src/sim/bsp';
import { censusThings } from '../fixtures/m8Fixtures';
import { E1M1_SKILL_ALIVE } from '../fixtures/m8Roster';
import { emptyInput } from '../../src/sim/ticcmd';
import { skillBit } from '../../src/sim/thinglinks';

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
].find((p): p is string => p !== undefined && existsSync(p));

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** doomednums the table tracks as monsters (barrel row excluded). */
const MONSTER_DN = [3004, 9, 3001, 3002, 58, 3003, 3006];

afterEach(() => {
  resetGameFlow();
});

describe.skipIf(WAD_PATH === undefined)('B-10 G_DeferedInitNew skill table (E1M1, menu-shaped drain)', () => {
  it.each([1, 2, 3, 4, 5])('menu skill %i: gameskill/skill domain + live census == WAD census', (raw) => {
    const bytes = readFileSync(WAD_PATH!);
    const wad = WadFile.parse(toArrayBuffer(bytes));
    const md = loadMap(wad, 'E1M1');
    registerGameFlowHooks({ levelLoader: () => buildMapFromData(loadMap(wad, 'E1M1')) });
    const state = gInitGame(buildMapFromData(md)); // default skill 2 = the boot skill
    gDeferedInitNew(state, raw, 1, 1); // exactly what M_ChooseSkill does (menu.ts, raw = itemOn+1)
    gTicker(state, emptyInput()); // ONE tic drains ga_newgame → P_SetupLevel

    // (a)+(b): the two skill domains (1-based seam field ↔ 0-based build world)
    expect(state.gameskill, `gameskill for raw ${raw}`).toBe(raw);
    expect(state.skill, `internal skill for raw ${raw}`).toBe(raw - 1);

    // (c): live spawned COUNTKILL monsters, per doomednum
    const live = new Map<number, number>();
    const spots: { x: number; y: number; type: number }[] = [];
    for (const m of state.mobjs.slotMobjs.values()) {
      if (m.removed || (m.flags & MF.MF_COUNTKILL) === 0) continue;
      const dn = mobjinfo[m.type as number]!.doomednum;
      if (!MONSTER_DN.includes(dn)) continue; // barrels etc. counted separately
      live.set(dn, (live.get(dn) ?? 0) + 1);
      spots.push({ x: m.x, y: m.y, type: m.type as number });
    }
    const row = E1M1_SKILL_ALIVE[raw - 1]!;
    for (const dn of MONSTER_DN) {
      expect(live.get(dn) ?? 0, `E1M1 dn=${dn} alive at raw skill ${raw} (bit ${skillBit(raw - 1)})`)
        .toBe(row.byDoomednum[dn] ?? 0);
    }
    let liveTotal = 0;
    for (const n of live.values()) liveTotal += n;
    expect(liveTotal, `E1M1 monster total at raw skill ${raw}`).toBe(row.monsters);

    // (c'): the table row is not stale — recompute the THINGS census live
    const census = censusThings(wad, 'E1M1', raw - 1);
    for (const dn of MONSTER_DN) {
      expect(census.aliveByDoomednum.get(dn) ?? 0, `WAD census dn=${dn} at internal ${raw - 1}`)
        .toBe(row.byDoomednum[dn] ?? 0);
    }

    // (d): "spawning outside the level" theory — every hostile position
    // resolves through the BSP to a real subsector/sector, no silent drops.
    expect(spots.length).toBe(row.monsters);
    for (const s of spots) {
      expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
      const ss = subsectorAt(state.map, s.x >> 16, s.y >> 16);
      expect(ss, `subsector for doomednum ${mobjinfo[s.type]!.doomednum}`).toBeGreaterThanOrEqual(0);
      expect(state.map.subsectors.sector[ss], 'sector behind the subsector').toBeDefined();
    }
  });

  it('the MT↔doomednum mapping is hostile-truth (dn 58 = MT_SHADOWS, dn 9 = MT_SHOTGUY)', () => {
    // B-10 triage cited "SPOS18+TROO9+POSS5" for the bit-4 census; the
    // WAD-measured bit-4 E1M1 set is dn{3001:18 TROOP, 3002:9 SERGEANT,
    // 3004:5 POSSESSED} PLUS dn{9:13 SHOTGUY, 58:1 SHADOWS} = 46 — pin
    // the mapping so nobody "corrects" the count back to 32 again.
    expect(DOOMEDNUM_TO_MT.get(58)).toBe(MT.MT_SHADOWS);
    expect(DOOMEDNUM_TO_MT.get(9)).toBe(MT.MT_SHOTGUY);
    expect(mobjinfo[MT.MT_SHADOWS]!.flags & MF.MF_COUNTKILL).not.toBe(0);
    expect(mobjinfo[MT.MT_SHOTGUY]!.flags & MF.MF_COUNTKILL).not.toBe(0);
  });
});
