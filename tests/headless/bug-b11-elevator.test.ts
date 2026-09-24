/**
 * B-11 — E1M2 blazing platform (tag 14, sector 124) regression suite.
 *
 * The filed probe fired pCrossSpecialLine(350) / pUseSpecialLine(1287) and
 * concluded "never engages". SOURCE TRUTH: the enclosing functions are
 *   • p_spec.c:492 P_CrossSpecialLine — contains case 120 at p_spec.c:929
 *     (GR blazing DWUS, NO clear) and case 121 at :754 (W1, clear);
 *   • p_switch.c:276 P_UseSpecialLine — contains case 122 at :479 (the
 *     reuse-0 / S1 block) and case 123 at :616 (reuse-1 / SR block,
 *     P_ChangeSwitchTexture(line,1)).
 * So crossing special 123 and USING special 120 are FAITHFUL no-ops (the
 * probe swapped the dispatchers) and specials-table.ts:385/:349/:298/:299
 * already mirror the C. The suites below pin BOTH halves: the faithful
 * no-ops of the probe recipe, and the live routes that DO move sector 124
 * (walk-over GR line 1287; use-front SR line 350 from the slot 228),
 * incl. the down-wait-up cycle to −16/40 (EV_DoPlat blazeDWUS:
 * low = P_FindLowestFloorSurrounding clamped, high = current 40, speed 8,
 * wait 105 — p_plats.c blazeDWUS branch).
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
import { pCrossSpecialLine, pUseSpecialLine } from '../../src/sim/pspec';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { activePlats } from '../../src/sim/pplats';
import { sectorSpecialData } from '../../src/sim/ptick';
import { pswitchCounts, resetPswitchCounts } from '../../src/sim/pswitch';
import { debugSim } from '../../src/debug';
import type { GameState } from '../../src/sim/state';

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
].find((p): p is string => p !== undefined && existsSync(p));

function e1m2(): GameState {
  const wad = WadFile.parse(readFileSync(WAD_PATH!)!.buffer as ArrayBuffer);
  return gInitGame(buildMapFromData(loadMap(wad, 'E1M2')), 3);
}

/** sector 124 = tag 14 blazing slab; line 350 SR(123) use-front, line 1287
 * GR(120) walk-over; 40 mapunits current floor, −16 = lowest surround. */
const F40 = 40 * 65536;
const F_M16 = -16 * 65536;

function freePlats(): boolean {
  for (let i = 0; i < activePlats.length; i++) if (activePlats[i] !== null) return false;
  return true;
}

describe('B-11 E1M2 blazing lift (tag 14, sector 124)', () => {
  it('probe recipe is a FAITHFUL no-op: cross 123 / use 120 fire nothing', () => {
    const s = e1m2();
    const mo = s.players[0]!.mo;
    // exactly what the filed probe did (BUGS.md B-11 recipe):
    pCrossSpecialLine(s.pmap, 350, 0, mo); // special 123 = USE-side only
    pUseSpecialLine(s, mo, 1287, 0);       // special 120 = CROSS-side only
    for (let i = 0; i < 200; i++) gTicker(s, emptyInput());
    expect(s.sectors.floorZ[124]).toBe(F40);
    expect(s.map.lines.special[350]).toBe(123);
    expect(s.map.lines.special[1287]).toBe(120);
    expect(sectorSpecialData(s.sectors, 124)).toBeNull();
  });

  it('route-correct direct dispatch engages: USE 350 (SR 123) cycles −16 → 40', () => {
    const s = e1m2();
    expect(pUseSpecialLine(s, s.players[0]!.mo, 350, 0)).toBe(true);
    let min = F40;
    for (let i = 0; i < 200; i++) {
      gTicker(s, emptyInput());
      if (s.sectors.floorZ[124]! < min) min = s.sectors.floorZ[124]!;
    }
    expect(min).toBe(F_M16);            // descended to the clamped low
    expect(s.sectors.floorZ[124]).toBe(F40); // DWUS returned and self-removed
    expect(sectorSpecialData(s.sectors, 124)).toBeNull();
    expect(s.map.lines.special[350]).toBe(123); // SR stays armed (reuse, p_switch.c:619)
  });

  it('route-correct direct dispatch engages: CROSS 1287 (GR 120) cycles −16 → 40', () => {
    const s = e1m2();
    pCrossSpecialLine(s.pmap, 1287, 1, s.players[0]!.mo);
    let min = F40;
    for (let i = 0; i < 200; i++) {
      gTicker(s, emptyInput());
      if (s.sectors.floorZ[124]! < min) min = s.sectors.floorZ[124]!;
    }
    expect(min).toBe(F_M16);
    expect(s.sectors.floorZ[124]).toBe(F40);
    expect(s.map.lines.special[1287]).toBe(120); // GR never clears (p_spec.c:929-931)
  });

  it('live route: player walks onto the slab, rides to −16 and back to 40', () => {
    const s = e1m2();
    const mo = s.players[0]!.mo;
    debugSim.attach(s);
    debugSim.warp(128 << 16, (-1196) << 16, undefined, 90); // ledge 219, face north
    debugSim.detach();
    const walk: GameInput = { ...emptyInput(), forward: true };
    let min = F40;
    for (let i = 0; i < 300; i++) {
      gTicker(s, i < 8 ? walk : emptyInput());
      if (s.sectors.floorZ[124]! < min) min = s.sectors.floorZ[124]!;
    }
    expect(min).toBe(F_M16);                    // crossing line 1287 triggered the lift
    expect(s.sectors.floorZ[124]).toBe(F40);    // full DWUS cycle completed
    expect(mo.z).toBe(F40);                     // player rode back to the top
    expect(freePlats()).toBe(true);             // plat self-removed at up-arrival
  });

  it('live route: player in the slot 228 USES line 350 and the lift engages', () => {
    const s = e1m2();
    resetPswitchCounts();
    debugSim.attach(s);
    debugSim.warp(200 << 16, (-1120) << 16, undefined, 180); // front sector, face west
    debugSim.detach();
    const press: GameInput = { ...emptyInput(), use: true };
    let min = F40;
    for (let i = 0; i < 160; i++) {
      // G_PlayerReborn arms usedown (g_game.c:797) — a fresh spawn must hold
      // the key OFF for one tic before a press fires, vanilla semantics.
      gTicker(s, i < 3 ? emptyInput() : press);
      if (s.sectors.floorZ[124]! < min) min = s.sectors.floorZ[124]!;
    }
    expect(pswitchCounts.useSpecial).toBeGreaterThan(0);
    expect(min).toBe(F_M16);
    expect(s.sectors.floorZ[124]).toBe(F40);
  });
});
