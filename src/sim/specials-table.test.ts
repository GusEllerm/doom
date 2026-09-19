/**
 * sim/specials-table.ts tests (M6-03) — the registry COMPLETENESS proof:
 * the machine-readable manifest versus an R05 §2/§3 list literal
 * transcribed from p_switch.c / p_spec.c by hand (the "100% coverage"
 * claim's machine check, M6-plan §5.1).
 *
 * Source mirrors: /tmp/DOOM-master/linuxdoom-1.10/{p_switch.c,p_spec.c,
 * p_spec.h}. SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import {
  LINE_SPECIALS, LINE_SPECIALS_EXCLUDED, SECTOR_SPECIALS,
  SECTOR_SPECIALS_EXCLUDED, registryManifest, strobeSyncFlag,
  VL, PLAT, FLOOR, CEIL, STAIR, FASTDARK, SLOWDARK
} from './specials-table';
import type { ActionId } from './specials-table';

/* ------------------------------------------------------------------ */
/* R05 list literals (hand-transcribed; THE arbiter for completeness)   */
/* ------------------------------------------------------------------ */

type Act = readonly [ActionId, number?, number?];

/** p_spec.c P_CrossSpecialLine "TRIGGERS" block (each clears). */
const W1: Readonly<Record<number, Act | readonly Act[]>> = {
  2: ['door', VL.open], 3: ['door', VL.close], 4: ['door', VL.normal],
  5: ['floor', FLOOR.raiseFloor], 6: ['ceiling', CEIL.fastCrushAndRaise],
  8: ['stairs', STAIR.build8], 10: ['plat', PLAT.downWaitUpStay, 0],
  12: ['lightOn', 0], 13: ['lightOn', 255], 16: ['door', VL.close30ThenOpen],
  17: ['strobe'], 19: ['floor', FLOOR.lowerFloor],
  22: ['plat', PLAT.raiseToNearestAndChange, 0], 25: ['ceiling', CEIL.crushAndRaise],
  30: ['floor', FLOOR.raiseToTexture], 35: ['lightOn', 35], 36: ['floor', FLOOR.turboLower],
  37: ['floor', FLOOR.lowerAndChange], 38: ['floor', FLOOR.lowerFloorToLowest],
  39: ['teleport'],
  40: [['ceiling', CEIL.raiseToHighest], ['floor', FLOOR.lowerFloorToLowest]],
  44: ['ceiling', CEIL.lowerAndCrush],
  53: ['plat', PLAT.perpetualRaise, 0], 54: ['stopPlat'], 56: ['floor', FLOOR.raiseFloorCrush],
  57: ['crushStop'], 58: ['floor', FLOOR.raiseFloor24], 59: ['floor', FLOOR.raiseFloor24AndChange],
  100: ['stairs', STAIR.turbo16], 104: ['lightsOff'], 108: ['door', VL.blazeRaise],
  109: ['door', VL.blazeOpen], 110: ['door', VL.blazeClose],
  119: ['floor', FLOOR.raiseFloorToNearest], 121: ['plat', PLAT.blazeDWUS, 0],
  125: ['teleport'], 130: ['floor', FLOOR.raiseFloorTurbo],
  141: ['ceiling', CEIL.silentCrushAndRaise]
};

/** p_spec.c "RETRIGGERS" block (none clears). */
const GR: Readonly<Record<number, Act>> = {
  72: ['ceiling', CEIL.lowerAndCrush], 73: ['ceiling', CEIL.crushAndRaise], 74: ['crushStop'],
  75: ['door', VL.close], 76: ['door', VL.close30ThenOpen], 77: ['ceiling', CEIL.fastCrushAndRaise],
  79: ['lightOn', 35], 80: ['lightOn', 0], 81: ['lightOn', 255],
  82: ['floor', FLOOR.lowerFloorToLowest], 83: ['floor', FLOOR.lowerFloor], 84: ['floor', FLOOR.lowerAndChange],
  86: ['door', VL.open], 87: ['plat', PLAT.perpetualRaise, 0], 88: ['plat', PLAT.downWaitUpStay, 0],
  89: ['stopPlat'], 90: ['door', VL.normal], 91: ['floor', FLOOR.raiseFloor],
  92: ['floor', FLOOR.raiseFloor24], 93: ['floor', FLOOR.raiseFloor24AndChange],
  94: ['floor', FLOOR.raiseFloorCrush], 95: ['plat', PLAT.raiseToNearestAndChange, 0],
  96: ['floor', FLOOR.raiseToTexture], 97: ['teleport'], 98: ['floor', FLOOR.turboLower],
  105: ['door', VL.blazeRaise], 106: ['door', VL.blazeOpen], 107: ['door', VL.blazeClose],
  120: ['plat', PLAT.blazeDWUS, 0], 126: ['teleport'],
  128: ['floor', FLOOR.raiseFloorToNearest], 129: ['floor', FLOOR.raiseFloorTurbo]
};

/** Exits inside the cross switch (NO clear, p_spec.c literal). */
const CROSS_EXIT: Readonly<Record<number, 0 | 1>> = { 52: 0, 124: 1 };

/** p_switch.c: manuals → EV_VerticalDoor (no dispatcher-level clear). */
const MANUALS = [1, 26, 27, 28, 31, 32, 33, 34, 117, 118] as const;
const MONSTER_USE_OK = [1, 32, 33, 34] as const;

/** p_switch.c switch cases: id → [action..., useAgain]. */
const SWITCHES: Readonly<Record<number, [Act, 0 | 1]>> = {
  7: [['stairs', STAIR.build8], 0], 9: [['donut'], 0],
  14: [['plat', PLAT.raiseAndChange, 32], 0], 15: [['plat', PLAT.raiseAndChange, 24], 0],
  18: [['floor', FLOOR.raiseFloorToNearest], 0], 20: [['plat', PLAT.raiseToNearestAndChange, 0], 0],
  21: [['plat', PLAT.downWaitUpStay, 0], 0], 23: [['floor', FLOOR.lowerFloorToLowest], 0],
  29: [['door', VL.normal], 0], 41: [['ceiling', CEIL.lowerToFloor], 0],
  42: [['door', VL.close], 1], 43: [['ceiling', CEIL.lowerToFloor], 1],
  45: [['floor', FLOOR.lowerFloor], 1], 49: [['ceiling', CEIL.crushAndRaise], 0],
  50: [['door', VL.close], 0], 55: [['floor', FLOOR.raiseFloorCrush], 0],
  60: [['floor', FLOOR.lowerFloorToLowest], 1], 61: [['door', VL.open], 1],
  62: [['plat', PLAT.downWaitUpStay, 1], 1], // amount=1 pinned (p_switch.c)
  63: [['door', VL.normal], 1], 64: [['floor', FLOOR.raiseFloor], 1],
  65: [['floor', FLOOR.raiseFloorCrush], 1], 66: [['plat', PLAT.raiseAndChange, 24], 1],
  67: [['plat', PLAT.raiseAndChange, 32], 1], 68: [['plat', PLAT.raiseToNearestAndChange, 0], 1],
  69: [['floor', FLOOR.raiseFloorToNearest], 1], 70: [['floor', FLOOR.turboLower], 1],
  71: [['floor', FLOOR.turboLower], 0],
  99: [['lockedDoor', VL.blazeOpen], 1], 101: [['floor', FLOOR.raiseFloor], 0],
  102: [['floor', FLOOR.lowerFloor], 0], 103: [['door', VL.open], 0],
  111: [['door', VL.blazeRaise], 0], 112: [['door', VL.blazeOpen], 0], 113: [['door', VL.blazeClose], 0],
  114: [['door', VL.blazeRaise], 1], 115: [['door', VL.blazeOpen], 1], 116: [['door', VL.blazeClose], 1],
  122: [['plat', PLAT.blazeDWUS, 0], 0], 123: [['plat', PLAT.blazeDWUS, 0], 1],
  127: [['stairs', STAIR.turbo16], 0], 131: [['floor', FLOOR.raiseFloorTurbo], 0],
  132: [['floor', FLOOR.raiseFloorTurbo], 1],
  133: [['lockedDoor', VL.blazeOpen], 0], 134: [['lockedDoor', VL.blazeOpen], 1],
  135: [['lockedDoor', VL.blazeOpen], 0], 136: [['lockedDoor', VL.blazeOpen], 1],
  137: [['lockedDoor', VL.blazeOpen], 0],
  140: [['floor', FLOOR.raiseFloor512], 0]
};

/** p_switch.c cases 11/51: ChangeSwitchTexture BEFORE the exit. */
const USE_EXIT: Readonly<Record<number, 0 | 1>> = { 11: 0, 51: 1 };

/** p_switch.c 138/139: EV_LightTurnOn + UNCONDITIONAL useAgain=1. */
const LIGHT_BUTTONS: Readonly<Record<number, number>> = { 138: 255, 139: 35 };

/** p_spec.c P_ShootSpecialLine (ChangeSwitchTexture unconditional). */
const SHOOT: Readonly<Record<number, [Act, 0 | 1]>> = {
  24: [['floor', FLOOR.raiseFloor], 0],
  46: [['door', VL.open], 1],
  47: [['plat', PLAT.raiseToNearestAndChange, 0], 0]
};

/** p_spec.c ok-list for non-player CROSS (R05 §1.1). */
const CROSS_MONSTER_OK = new Set([4, 10, 88, 39, 97, 125, 126]);

/** P_SpawnSpecials sector cases (R05 §3.1). */
const SECTOR_SPAWN: Readonly<Record<number, [string, number?]>> = {
  1: ['lightFlash'], 2: ['strobe', FASTDARK], 3: ['strobe', SLOWDARK],
  4: ['strobe', FASTDARK], 8: ['glow'], 9: ['secretCount'],
  10: ['doorCloseIn30'], 12: ['strobe', SLOWDARK], 13: ['strobe', FASTDARK],
  14: ['doorRaiseIn5Mins'], 17: ['fireFlicker']
};

/* ------------------------------------------------------------------ */
/* Completeness: manifest vs the literal                                */
/* ------------------------------------------------------------------ */

describe('registry manifest vs R05 list literal', () => {
  const m = registryManifest();

  it('139 line ids = 1..141 minus unassigned 78/85 (registered or excluded with reason)', () => {
    expect(m.lineRegistered).toBe(139);
    expect(m.lineExcluded).toBe(2);
    expect(LINE_SPECIALS_EXCLUDED.map((e) => e.id)).toEqual([78, 85]);
    for (const e of LINE_SPECIALS_EXCLUDED) expect(e.reason.length).toBeGreaterThan(0);
    const expected: number[] = [];
    for (let i = 1; i <= 141; i++) if (i !== 78 && i !== 85) expected.push(i);
    expect(m.lineIds).toEqual(expected);
  });

  it('every registered line id carries ≥1 route; route totals match the literal', () => {
    const useIds = new Set<number>([...MANUALS, ...Object.keys(SWITCHES).map(Number),
      ...Object.keys(USE_EXIT).map(Number), ...Object.keys(LIGHT_BUTTONS).map(Number)]);
    const crossIds = new Set<number>([
      ...Object.keys(W1).map(Number), ...Object.keys(GR).map(Number),
      ...Object.keys(CROSS_EXIT).map(Number)
    ]);
    const shootIds = new Set(Object.keys(SHOOT).map(Number));
    for (let i = 1; i <= 141; i++) {
      const e = LINE_SPECIALS[i];
      const inLiteral =
        useIds.has(i) || crossIds.has(i) || shootIds.has(i) || i === 48 || i === 78 || i === 85;
      if (i === 78 || i === 85) {
        expect(e, `special ${i}`).toBeNull();
        continue;
      }
      expect(e, `special ${i} registered`).not.toBeNull();
      if (!e) continue;
      expect(inLiteral, `special ${i} in literal`).toBe(true);
      const routes = [e.use, e.cross, e.shoot, e.scroll].filter(Boolean).length;
      expect(routes, `special ${i} ≥1 route`).toBeGreaterThanOrEqual(1);
      // no phantom routes:
      expect(!!e.use, `special ${i} use`).toBe(useIds.has(i));
      expect(!!e.cross, `special ${i} cross`).toBe(crossIds.has(i));
      expect(!!e.shoot, `special ${i} shoot`).toBe(shootIds.has(i));
      expect(!!e.scroll, `special ${i} scroll`).toBe(i === 48);
    }
    expect(m.lineRouteCounts.use).toBe(useIds.size); // 124 has NO use route (commented-out case)
    expect(m.lineRouteCounts.cross).toBe(crossIds.size);
    expect(m.lineRouteCounts.shoot).toBe(3);
    expect(m.lineRouteCounts.scroll).toBe(1);
  });

  it('15 sector specials registered + {6,15} excluded with reason', () => {
    expect(m.sectorRegistered).toBe(15);
    expect(m.sectorExcluded).toBe(2);
    expect(m.sectorIds).toEqual([1, 2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17]);
    expect(SECTOR_SPECIALS_EXCLUDED.map((e) => e.id)).toEqual([6, 15]);
    for (const e of SECTOR_SPECIALS_EXCLUDED) expect(e.reason.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Per-entry fidelity: action id + arg + clear + switch flags            */
/* ------------------------------------------------------------------ */

function acts(e: { actions: readonly { action: ActionId; arg?: number; amount?: number }[] }) {
  return e.actions.map((a) => [a.action, a.arg ?? 0, a.amount ?? 0] as const);
}
const lit = (a: Act) => [a[0], a[1] ?? 0, a[2] ?? 0] as const;

describe('cross-side fidelity (p_spec.c)', () => {
  it('W1: exact actions, clear=true, monsterOk only for the ok-list', () => {
    for (const [id, a] of Object.entries(W1)) {
      const n = Number(id);
      const e = LINE_SPECIALS[n]!.cross!;
      const list: readonly Act[] =
        typeof (a as readonly unknown[])[0] === 'string' ? [a as Act] : (a as readonly Act[]);
      expect(acts(e), `cross ${n}`).toEqual(list.map(lit));
      expect(e.clear, `cross ${n} clear`).toBe(true);
      expect(e.monsterOk === true, `cross ${n} monsterOk`).toBe(CROSS_MONSTER_OK.has(n));
    }
  });

  it('GR: same dispatch without clears; monsterOk per the ok-list', () => {
    for (const [id, a] of Object.entries(GR)) {
      const n = Number(id);
      const e = LINE_SPECIALS[n]!.cross!;
      expect(acts(e), `cross ${n}`).toEqual([lit(a)]);
      expect(e.clear === true, `cross ${n} no-clear`).toBe(false);
      expect(e.monsterOk === true, `cross ${n} monsterOk`).toBe(CROSS_MONSTER_OK.has(n));
    }
  });

  it('exits 52/124: exit actions, NEVER cleared; 125/126 monsterOnly gates', () => {
    for (const [id, kind] of Object.entries(CROSS_EXIT)) {
      const e = LINE_SPECIALS[Number(id)]!.cross!;
      expect(acts(e)).toEqual([['exit', kind, 0]]);
      expect(e.clear).toBe(false);
    }
    expect(LINE_SPECIALS[125]!.cross!.monsterOnly).toBe(true);
    expect(LINE_SPECIALS[125]!.cross!.clear).toBe(true); // clear inside !player
    expect(LINE_SPECIALS[126]!.cross!.monsterOnly).toBe(true);
    expect(LINE_SPECIALS[126]!.cross!.clear).toBeFalsy();
  });

  it('48 is spawn-collected, not dispatched', () => {
    const e = LINE_SPECIALS[48]!;
    expect(e.scroll).toBe(true);
    expect(e.cross ?? e.use ?? e.shoot).toBeUndefined();
  });
});

describe('use-side fidelity (p_switch.c)', () => {
  it('manuals route to EV_VerticalDoor; only {1,32,33,34} monster-usable', () => {
    for (const id of MANUALS) {
      const e = LINE_SPECIALS[id]!.use!;
      expect(acts(e), `manual ${id}`).toEqual([['verticalDoor', 0, 0]]);
      expect(e.gateSwitch ?? e.thenSwitch ?? e.switchBefore).toBeUndefined();
      expect(e.monsterUseOk === true, `manual ${id} monsterUseOk`).toBe(
        (MONSTER_USE_OK as readonly number[]).includes(id)
      );
    }
  });

  it('S1/SR switches: action + gateSwitch(useAgain) exactly as transcribed', () => {
    for (const [id, [a, again]] of Object.entries(SWITCHES)) {
      const e = LINE_SPECIALS[Number(id)]!.use!;
      expect(acts(e), `use ${id}`).toEqual([lit(a)]);
      expect(e.gateSwitch, `use ${id} gate`).toBe(again);
    }
  });

  it('use exits 11/51 disarm-then-exit; 138/139 unconditional button', () => {
    for (const [id, kind] of Object.entries(USE_EXIT)) {
      const e = LINE_SPECIALS[Number(id)]!.use!;
      expect(acts(e)).toEqual([['exit', kind, 0]]);
      expect(e.switchBefore).toBe(0);
    }
    for (const [id, bright] of Object.entries(LIGHT_BUTTONS)) {
      const e = LINE_SPECIALS[Number(id)]!.use!;
      expect(acts(e)).toEqual([['lightOn', bright, 0]]);
      expect(e.thenSwitch).toBe(1);
    }
  });

  it('shoot 24/46/47: action + unconditional ChangeSwitchTexture', () => {
    for (const [id, [a, again]] of Object.entries(SHOOT)) {
      const e = LINE_SPECIALS[Number(id)]!.shoot!;
      expect(acts(e), `shoot ${id}`).toEqual([lit(a)]);
      expect(e.thenSwitch).toBe(again);
    }
  });
});

describe('sector registry fidelity (p_spec.c P_SpawnSpecials + feet data)', () => {
  it('spawn actions + clearTo reproduce the post-load special values', () => {
    for (const [id, [action, arg]] of Object.entries(SECTOR_SPAWN)) {
      const e = SECTOR_SPECIALS[Number(id)]!;
      expect(e.spawn!.action, `sector ${id}`).toBe(action);
      if (arg !== undefined) expect(e.spawn!.arg).toBe(arg);
      if (Number(id) === 9) expect(e.clearTo).toBeUndefined(); // stays 9
      else if (Number(id) === 4) expect(e.clearTo).toBe(4); // STAYS 4 (p_spec.c)
      else expect(e.clearTo, `sector ${id} clear`).toBe(0);
    }
  });

  it('feet data (M6-12 payloads): 5→10, 7→5, 4/16→20+randBypass, 9 secret, 11 finale', () => {
    expect(SECTOR_SPECIALS[5]!.feet).toEqual({ damage: 10 });
    expect(SECTOR_SPECIALS[7]!.feet).toEqual({ damage: 5 });
    expect(SECTOR_SPECIALS[16]!.feet).toEqual({ damage: 20, randBypass: true });
    expect(SECTOR_SPECIALS[4]!.feet).toEqual({ damage: 20, randBypass: true });
    expect(SECTOR_SPECIALS[9]!.feet).toEqual({ secret: true });
    expect(SECTOR_SPECIALS[11]!.feet!.finale).toBe(true);
    expect(SECTOR_SPECIALS[11]!.feet!.damage).toBe(20);
  });

  it('strobe sync flag: 12/13 in-sync, 2/3/4 not', () => {
    expect([12, 13].map(strobeSyncFlag)).toEqual([1, 1]);
    expect([2, 3, 4].map(strobeSyncFlag)).toEqual([0, 0, 0]);
  });
});
