/**
 * sim-facing debug seams (src/debug.ts) — M6-13 finding 3: popInput.
 * The main.ts input wiring is a plain callback hook; headless asserts the
 * seam contract (null while detached, hook result passthrough, clean
 * detach). SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { attachPopInput, debugApi } from './debug';

describe('debugApi.popInput (M6-13 finding 3 seam)', () => {
  it('null while the main.ts input wiring is detached', () => {
    attachPopInput(null);
    expect(debugApi.popInput()).toBeNull();
  });

  it('passes the drain report through and detaches cleanly', () => {
    let dropped = 3;
    attachPopInput(() => {
      const events = dropped;
      dropped = 0; // popped once — a second call reports an empty drain
      return { events, mouse: { x: -7, y: 2 } };
    });
    expect(debugApi.popInput()).toEqual({ events: 3, mouse: { x: -7, y: 2 } });
    expect(debugApi.popInput()).toEqual({ events: 0, mouse: { x: -7, y: 2 } });
    attachPopInput(null);
    expect(debugApi.popInput()).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* M8-12: state().monsters monster roll-up seam                         */
/* ------------------------------------------------------------------ */

import { buildFixtureMapWad } from '../tests/fixtures/mapBuilder';
import { buildMapFromData } from './sim/map';
import { loadMap } from './wad/mapdata';
import { WadFile } from './wad/wadfile';
import { gInitGame } from './sim/game';
import { debugSim } from './debug';
import type { DebugStateLive } from './types/debug';

describe('debugApi.state().monsters (M8-12 seam)', () => {
  function attachWithMonster(dx: number): void {
    const bytes = buildFixtureMapWad({
      rooms: [{ x: 0, y: 0, w: 512, h: 256, lightLevel: 200 }],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 }, // player 1 start, facing east
        { x: 64 + dx, y: 128, angle: 180, type: 3004 } // MT_POSSESSED facing the player
      ]
    });
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    debugSim.attach(gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'))));
  }

  it('rolls up the MF_COUNTKILL roster (alive/byType/killcount/first views)', () => {
    attachWithMonster(320);
    const s = debugApi.state() as DebugStateLive;
    expect(s.monsters.alive).toBe(1);
    expect(s.monsters.byType).toEqual({ 1: 1 }); // MT_POSSESSED
    expect(s.monsters.barrels).toBe(0);
    expect(s.monsters.killcount).toBe(0);
    expect(s.monsters.mobjs).toHaveLength(1);
    const m = s.monsters.first!;
    expect(m.type).toBe(1);
    expect(m.health).toBe(20);
    expect(m.flagsLite).toEqual({ solid: true, shootable: true, shadow: false, ambush: false, corpse: false });
    expect(m.targetPlayer).toBe(false);
    expect(m.targetSlot).toBeNull();
    debugSim.detach();
  });

  it('the SIGHT wake shows up as targetPlayer=true + see-state at the exact tic', () => {
    attachWithMonster(200); // LOS on the eye line, facing each other
    let wokeAt = -1;
    for (let t = 1; t <= 40; t++) {
      debugSim.runTics(1);
      const s = debugApi.state() as DebugStateLive;
      if (s.monsters.mobjs[0]!.targetPlayer) {
        wokeAt = t;
        break;
      }
    }
    expect(wokeAt).toBeGreaterThan(0);
    const s = debugApi.state() as DebugStateLive;
    expect(s.monsters.mobjs[0]!.state).toBeGreaterThanOrEqual(176); // ≥ S_POSS_RUN1 (see-state row)
    debugSim.detach();
  });
});
