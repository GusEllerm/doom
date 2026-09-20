/**
 * sim/hooks — M8-02 damage-bridge acceptance tests (M8-plan §M8-02 item 4):
 * the damageBridge slot SIGNATURE + registerDamageBridge + the
 * mobjFromSlot resolver live here; p_mobj.ts fills the resolver at runtime
 * create, M8-05 registers the P_DamageMobj BODY. hooks.ts itself imports
 * NOTHING (A-06) — the pure section drives it with fake refs; the
 * integration section boots a fixture and demands REAL Mobj identity.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MT } from '../wad/info/mobjinfo';

import { buildMapFromData } from './map';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame } from './game';
import type { GameState } from './state';
import {
  createHookSlots,
  damageSlot,
  mobjFromSlot,
  registerDamageBridge,
  resetHookSlots,
  type MobjRef,
} from './hooks';

/** Fake "mobjs" — hooks.ts must never care what a ref IS (A-06). */
const fake = (n: number): MobjRef => ({ isMobj: true, n } as unknown as MobjRef);

/* ------------------------------------------------------------------ */
/* Pure slot mechanics                                                  */
/* ------------------------------------------------------------------ */

describe('damageBridge slots (M8-02 acceptance 4, pure)', () => {
  it('no bridge registered: damageSlot is record-only, byte-identical to M6', () => {
    const h = createHookSlots();
    damageSlot(h, 7, 10, 3, 5);
    expect(h.damage.count).toBe(1);
    expect(h.damage.entries[0]).toEqual({ thing: 7, amount: 10, source: 3, tic: 5 });
    expect(h.bridge.damageBridge).toBeUndefined();
    expect(h.bridge.mobjFromSlot).toBeUndefined();
    expect(mobjFromSlot(h, 7)).toBeUndefined();
  });

  it('registered body receives RESOLVED refs (target + source), records stay first', () => {
    const h = createHookSlots();
    const refs = new Map<number, MobjRef>([
      [7, fake(7)],
      [3, fake(3)],
    ]);
    h.bridge.mobjFromSlot = (slot) => refs.get(slot);
    const seen: unknown[] = [];
    registerDamageBridge(h, (target, amount, source, tic) => {
      seen.push([target, amount, source, tic]);
    });
    damageSlot(h, 7, 10, 3, 5);
    expect(h.damage.count).toBe(1); // L2 event log untouched by the bridge
    expect(seen.length).toBe(1);
    const [target, amount, source, tic] = seen[0] as [MobjRef, number, MobjRef, number];
    expect(target).toBe(refs.get(7));
    expect(amount).toBe(10);
    expect(source).toBe(refs.get(3));
    expect(tic).toBe(5);
  });

  it('world damage (source null) resolves to undefined; unresolved TARGET skips the body', () => {
    const h = createHookSlots();
    h.bridge.mobjFromSlot = (slot) => (slot === 7 ? fake(7) : undefined);
    const seen: unknown[] = [];
    registerDamageBridge(h, (_t, _a, source) => seen.push(source));
    damageSlot(h, 7, 20, null, 9);
    expect(seen).toEqual([undefined]); // crusher/floor damage: source undefined
    seen.length = 0;
    damageSlot(h, 8, 20, null, 9); // unresolved slot ⇒ record-only
    expect(seen.length).toBe(0);
    expect(h.damage.count).toBe(2);
  });

  it('registerDamageBridge(h, null) un-registers; resetHookSlots keeps the wiring', () => {
    const h = createHookSlots();
    h.bridge.mobjFromSlot = (slot) => fake(slot);
    let calls = 0;
    registerDamageBridge(h, () => calls++);
    damageSlot(h, 1, 1, null, 0);
    expect(calls).toBe(1);
    registerDamageBridge(h, null);
    damageSlot(h, 1, 1, null, 0);
    expect(calls).toBe(1); // body gone — back to record-only
    expect(h.damage.count).toBe(2);
    // wiring survives an event-log reset (it is wiring, not events)
    registerDamageBridge(h, () => calls++);
    resetHookSlots(h);
    expect(h.damage.count).toBe(0);
    damageSlot(h, 1, 1, null, 0);
    expect(calls).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Integration: the resolver p_mobj.createMobjRuntime registers         */
/* ------------------------------------------------------------------ */

function bootFixture(things: RectMapSpec['things']): GameState {
  const spec: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
    things: [{ x: 32, y: 32, angle: 0, type: 1 }, ...things],
  };
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 2);
}

describe('damageBridge resolver wiring (M8-02 acceptance 4, integration)', () => {
  it('bridge body gets the REAL Mobj objects the slots bind to (identity)', () => {
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const target = s.mobjs.mobjs.find((m) => m.type === MT.MT_BARREL)!;
    const source = s.mobjs.mobjs.find((m) => m.type === MT.MT_PLAYER)!;
    let got: { target: unknown; source: unknown; amount: number; tic: number } | undefined;
    registerDamageBridge(s.hooks, (t, amount, src, tic) => {
      got = { target: t, source: src, amount, tic };
    });
    damageSlot(s.hooks, target.linkSlot, 15, source.linkSlot, 42);
    expect(got).toBeDefined();
    expect(got!.target).toBe(target); // resolved Mobj, not a slot id
    expect(got!.source).toBe(source);
    expect(got!.amount).toBe(15);
    expect(got!.tic).toBe(42);
    expect(s.hooks.damage.count).toBe(1); // L2 log still written
  });
});
