/**
 * sim/ptick.ts + sim/hooks.ts tests (M6-01) — thinker arena order,
 * deferred-removal sentinel, add-during-tick-next-tic, sector specialdata,
 * counted hook slots, and the §3.2 P_Ticker order through gTicker.
 *
 * Source mirrors: p_tick.c P_AddThinker/P_RemoveThinker/P_RunThinkers
 * (/tmp/DOOM-master/linuxdoom-1.10/p_tick.c), p_spec.c sector->specialdata
 * idiom, hook-slot contract M6-plan §M6-01/§6.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildFixtureMapWad } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from './map';
import { gInitGame, gTicker } from './game';
import {
  createThinkerArena, pAddThinker, pRemoveThinker, pRunThinkers,
  sectorSpecialData, setSectorSpecialData, thinkerCount,
  resetUpdateSpecialsCounts, updateSpecialsCounts
} from './ptick';
import { pUpdateSpecials } from './pspec';
import {
  createHookSlots, damageSlot, exitSlot, messageSlot, resetHookSlots,
  sfxSlot, HOOK_LOG_CAP
} from './hooks';
import { createLiveSectors, type GameState } from './state';
import { emptyInput } from './ticcmd';
import { FRACUNIT } from '../core/constants';

function freshState(): GameState {
  const bytes = buildFixtureMapWad({
    rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }],
    things: [{ x: 128, y: 128, angle: 0, type: 1 }]
  });
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

/* ------------------------------------------------------------------ */
/* Arena order (p_tick.c list order)                                   */
/* ------------------------------------------------------------------ */

describe('thinker arena tick order = insertion order (§3.5-5)', () => {
  it('ticks A,B,C in add order every run', () => {
    const arena = createThinkerArena();
    const log: string[] = [];
    pAddThinker(arena, () => log.push('A'));
    pAddThinker(arena, () => log.push('B'));
    pAddThinker(arena, () => log.push('C'));
    pRunThinkers(arena);
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'B', 'C', 'A', 'B', 'C']);
  });

  it('null-fn thinker stays linked but is not ticked (p_plats stasis)', () => {
    const arena = createThinkerArena();
    const log: string[] = [];
    pAddThinker(arena, () => log.push('A'));
    const idle = pAddThinker(arena, null);
    pRunThinkers(arena);
    expect(log).toEqual(['A']);
    expect(thinkerCount(arena)).toBe(2); // linked (vanilla: stays in list)
    idle.fn = () => log.push('B');
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'A', 'B']);
  });
});

/* ------------------------------------------------------------------ */
/* Deferred removal sentinel (p_tick.c P_RemoveThinker + RunThinkers)  */
/* ------------------------------------------------------------------ */

describe('deferred removal sentinel', () => {
  it('remove BEFORE the walker reaches it: skipped this run, unlinked', () => {
    const arena = createThinkerArena();
    const log: string[] = [];
    pAddThinker(arena, () => { log.push('A'); pRemoveThinker(b); });
    const b = pAddThinker(arena, () => log.push('B'));
    pRunThinkers(arena);
    expect(log).toEqual(['A']); // B sentinel-removed before its turn
    expect(thinkerCount(arena)).toBe(1);
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'A']); // B gone, never ticked
  });

  it('remove AFTER the walker passed it: stays linked until NEXT run', () => {
    const arena = createThinkerArena();
    const log: string[] = [];
    const a = pAddThinker(arena, () => log.push('A'));
    pAddThinker(arena, () => { log.push('B'); pRemoveThinker(a); });
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'B']); // A already visited — still linked
    expect(arena.entries.has(a.id)).toBe(true); // sentinel pending (§ lazy swap)
    expect(thinkerCount(arena)).toBe(1); // ...but logically dead
    log.length = 0;
    pRunThinkers(arena);
    expect(log).toEqual(['B']); // A unlinked at its visit, not ticked
    expect(arena.entries.has(a.id)).toBe(false);
    expect(thinkerCount(arena)).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Add during a tic → ticks next tic (ARCHITECTURE §3.2 pin)           */
/* ------------------------------------------------------------------ */

describe('add-during-iterate → next tic', () => {
  it('mid-run add is invisible to the current run and first-ticks next', () => {
    const arena = createThinkerArena();
    const log: string[] = [];
    pAddThinker(arena, () => {
      log.push('A');
      if (log.length === 1) pAddThinker(arena, () => log.push('late'));
    });
    pRunThinkers(arena);
    expect(log).toEqual(['A']); // 'late' NOT ticked this tic
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'A', 'late']); // next tic, appended after A
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'A', 'late', 'A', 'late']);
  });

  it('adds outside a run append immediately (vanilla P_AddThinker)', () => {
    const arena = createThinkerArena();
    const log: string[] = [];
    pAddThinker(arena, () => log.push('A'));
    pAddThinker(arena, () => log.push('B'));
    pRunThinkers(arena);
    expect(log).toEqual(['A', 'B']);
  });
});

/* ------------------------------------------------------------------ */
/* Sector specialdata (p_spec.c)                                       */
/* ------------------------------------------------------------------ */

describe('sector specialdata get/set', () => {
  it('null at load; set/get per sector; clear back to null', () => {
    const live = createLiveSectors(buildMapFromData(
      loadMap(WadFile.parse(
        (() => {
          const b = buildFixtureMapWad({ rooms: [
            { x: 0, y: 0, w: 128, h: 128 }, { x: 128, y: 0, w: 128, h: 128 }
          ], things: [{ x: 64, y: 64, angle: 0, type: 1 }] });
          return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
        })()
      ), 'FIXMAP')
    ));
    expect(live.count).toBeGreaterThanOrEqual(2); // 2 rooms + enclosing ring
    expect(sectorSpecialData(live, 0)).toBeNull();
    const arena = createThinkerArena();
    const mover = pAddThinker(arena, null);
    setSectorSpecialData(live, 1, mover);
    expect(sectorSpecialData(live, 1)).toBe(mover);
    expect(sectorSpecialData(live, 0)).toBeNull(); // per-sector isolation
    setSectorSpecialData(live, 1, null); // mover death clears it
    expect(sectorSpecialData(live, 1)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Hook slots (counted no-ops, A-06: zero imports below)               */
/* ------------------------------------------------------------------ */

describe('hook slots', () => {
  it('damage/sfx/message log entries + counts + byId, pure no-ops', () => {
    const h = createHookSlots();
    damageSlot(h, 7, 10, null, 3);
    damageSlot(h, 7, 5, 2, 4);
    sfxSlot(h, 42, 1 << 16, 2 << 16, 0, 5);
    sfxSlot(h, 42, 0, 0, 0, 6);
    sfxSlot(h, 43, 0, 0, 0, 7);
    messageSlot(h, 'PD_BLUEK', 8);
    expect(h.damage.count).toBe(2);
    expect(h.damage.entries).toEqual([
      { thing: 7, amount: 10, source: null, tic: 3 },
      { thing: 7, amount: 5, source: 2, tic: 4 }
    ]);
    expect(h.sfx.count).toBe(3);
    expect(h.sfx.byId?.get(42)).toBe(2);
    expect(h.sfx.byId?.get(43)).toBe(1);
    expect(h.message.entries[0]).toEqual({ id: 'PD_BLUEK', tic: 8 });
    expect(h.exit.count).toBe(0);
    resetHookSlots(h);
    expect(h.damage.count).toBe(0);
    expect(h.sfx.byId?.size ?? 0).toBe(0);
  });

  it('entry log caps at HOOK_LOG_CAP but count keeps counting', () => {
    const h = createHookSlots();
    for (let i = 0; i < HOOK_LOG_CAP + 5; i++) damageSlot(h, 1, 10, null, i);
    expect(h.damage.count).toBe(HOOK_LOG_CAP + 5);
    expect(h.damage.entries.length).toBe(HOOK_LOG_CAP);
  });

  it('exitSlot latches exitRequest (normal then secret, last wins)', () => {
    const host = { exitRequest: 'none' as const, hooks: createHookSlots(), leveltime: 12 };
    exitSlot(host, 'normal');
    expect(host.exitRequest).toBe('normal');
    expect(host.hooks.exit.entries).toEqual([{ kind: 'normal', tic: 12 }]);
    exitSlot(host, 'secret');
    expect(host.exitRequest).toBe('secret');
    expect(host.hooks.exit.count).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* P_Ticker order through gTicker: players → thinkers → specials → ++  */
/* ------------------------------------------------------------------ */

describe('gTicker P_Ticker order (§3.2)', () => {
  it('thinker ticks after playerthink+movement, before leveltime++, and ' +
     'updateSpecials runs once per tic', () => {
    resetUpdateSpecialsCounts();
    const s = freshState();
    const t = freshState(); // twin without the thinker
    const seen: { leveltime: number; x: number }[] = [];
    pAddThinker(s.thinkers, () => {
      seen.push({ leveltime: s.leveltime, x: s.players[0]!.mo.x });
    });
    const fwd = { ...emptyInput(), forward: true };
    const specialsBefore = updateSpecialsCounts.calls;
    for (let i = 0; i < 3; i++) {
      gTicker(s, fwd);
      gTicker(t, fwd);
    }
    // After movement, before the increment: sees leveltime 0,1,2 and the
    // post-P_XYMovement x of that same tic.
    expect(seen.map((r) => r.leveltime)).toEqual([0, 1, 2]);
    expect(s.leveltime).toBe(3);
    expect(updateSpecialsCounts.calls - specialsBefore).toBe(6); // 2 states × 3 tics
    resetUpdateSpecialsCounts();
    expect(updateSpecialsCounts.calls).toBe(0);
    // Side-effect-free thinker ⇒ identical physics twin (tick position
    // after movement is proven by x equality at record time):
    const after = s.players[0]!.mo.x;
    expect(seen[2]!.x).toBe(after);
    expect(t.players[0]!.mo.x).toBe(after);
    expect(t.leveltime).toBe(3);
  });

  it('fresh gInitGame starts with ONLY the player mobj thinker (M7-03)', () => {
    const s = freshState();
    // M7-03: P_SpawnPlayer spawns the MT_PLAYER mobj DURING the thing
    // pass — its (hash-excluded) thinker is the only arena entry at load.
    expect(thinkerCount(s.thinkers)).toBe(1);
    expect([...s.thinkers.entries.values()][0]!.excludeFromHash).toBe(true);
    expect(s.exitRequest).toBe('none');
    expect(s.totalsecret).toBe(0);
    expect(s.secretcount).toBe(0);
    expect(s.specialexit).toBe(false);
  });

  it('pUpdateSpecials body is the M6-03 pspec one (counter kept counting)', () => {
    const s = freshState();
    resetUpdateSpecialsCounts();
    pUpdateSpecials(s);
    pUpdateSpecials(s);
    expect(updateSpecialsCounts.calls).toBe(2);
  });

  it('arena thinker added before the run ticks inside every gTicker tic', () => {
    const s = freshState();
    let n = 0;
    pAddThinker(s.thinkers, () => n++);
    for (let i = 0; i < 5; i++) gTicker(s, emptyInput());
    expect(n).toBe(5);
    expect(s.players[0]!.mo.x).toBe(128 * FRACUNIT); // idle: no drift
  });
});
