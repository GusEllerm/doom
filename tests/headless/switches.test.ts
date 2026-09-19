/**
 * tests/headless/switches.test.ts — M6-11 debug card channel
 * (`__doom.sim.giveCard`, D013(f): the card grant until M7's real
 * pickups) + the state() snapshot's live `cards` read-out. Zone note:
 * src/debug.ts may only be imported from wiring-level tests (eslint
 * zone rule), hence this file rather than src/sim/pswitch.test.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { WadFile } from '../../src/wad/wadfile';
import { loadMap } from '../../src/wad/mapdata';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { pUseSpecialLine } from '../../src/sim/pspec';
import {
  IT_BLUECARD, IT_REDCARD, IT_REDSKULL, IT_YELLOWCARD
} from '../../src/sim/player';
import { PD_REDO, resetSwitchList, pInitSwitchList } from '../../src/sim/pswitch';
import { TEX_SWITCH_OFF, TEX_SWITCH_ON } from '../fixtures/m6Fixtures';
import { resetHookSlots } from '../../src/sim/hooks';
import { unimplementedSpecial, resetUnimplementedSpecial } from '../../src/sim/specials-table';
import { debugApi, debugSim } from '../../src/debug';

const SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256 }],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

function attachFresh() {
  const bytes = buildFixtureMapWad(SPEC, 'M6CARD');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'M6CARD')));
  debugSim.attach(s);
  resetSwitchList();
  pInitSwitchList([TEX_SWITCH_OFF, TEX_SWITCH_ON]);
  return s;
}

describe('debug giveCard (D013(f) card channel until M7 pickups)', () => {
  it('grants slots, returns the inventory, and reads back via state()', () => {
    attachFresh();
    expect(debugSim.giveCard(IT_REDCARD)).toEqual([0, 0, 1, 0, 0, 0]);
    expect(debugSim.giveCard(IT_REDSKULL)).toEqual([0, 0, 1, 0, 0, 1]);
    const snap = debugApi.state();
    if (!snap.ready) throw new Error('state not ready after attach');
    expect(snap.player.cards).toEqual([0, 0, 1, 0, 0, 1]);
    expect(() => debugSim.giveCard(6)).toThrow(RangeError);
    expect(() => debugSim.giveCard(-1)).toThrow(RangeError);
    expect(() => debugSim.giveCard(1.5)).toThrow(RangeError);
  });

  it('grant unlocks the red lock (no message) where a refusal logged first', () => {
    const s = attachFresh();
    const line = 0; // any line: special is scripted below
    s.map.lines.special[line] = 135; // S1 red locked blaze open
    resetHookSlots(s.hooks);
    resetUnimplementedSpecial();
    expect(pUseSpecialLine(s, s.players[0]!.mo, line, 0)).toBe(true);
    expect(s.hooks.message.byId?.get(PD_REDO)).toBe(1);
    expect(s.players[0]!.message).toBe(PD_REDO);

    debugSim.giveCard(IT_REDCARD);
    resetHookSlots(s.hooks);
    resetUnimplementedSpecial();
    expect(pUseSpecialLine(s, s.players[0]!.mo, line, 0)).toBe(true);
    expect(s.hooks.message.count).toBe(0);
    expect(unimplementedSpecial.byFn.get('evDoDoor') ?? 0).toBe(1);
    // Sanity: the blue/yellow slots are independent (giveCard is per-slot).
    expect(debugSim.giveCard(IT_BLUECARD)[IT_YELLOWCARD]).toBe(0);
    expect(s.players[0]!.cards[IT_BLUECARD]).toBe(1);
  });
});
