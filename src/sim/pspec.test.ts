/**
 * sim/pspec.ts + pspec-helpers.ts tests (M6-03) — registry dispatch
 * coverage (all 139 line ids through the REAL dispatchers, stub hit once
 * each), W1-clear/GR-keep/side-gate semantics through the M5 spechit
 * path, P_SpawnSpecials/P_UpdateSpecials wiring, and the P_Find* helper
 * family vs brute-force references (seeded fixture mazes + E1M1 skipIf).
 *
 * Source mirrors: /tmp/DOOM-master/linuxdoom-1.10/{p_spec.c,p_switch.c}.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { FRACUNIT } from '../core/constants';

import { buildFixtureMapWad, ML_SECRET } from '../../tests/fixtures/mapBuilder';
import { M6_SCENES } from '../../tests/fixtures/m6Fixtures';
import type { RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from './map';
import { gInitGame } from './game';
import { pTryMove } from './pmap';
import type { Mover } from './pmap';
import { PLAYER_FLAGS } from './player';
import { MF_MISSILE, MF_SOLID } from './thinglinks';
import type { GameState } from './state';
import { resetUpdateSpecialsCounts, updateSpecialsCounts } from './ptick';
import { ML_TWOSIDED } from './pspec-helpers';

import {
  pCrossSpecialLine, pUseSpecialLine, pShootSpecialLine,
  pSpawnSpecials, pUpdateSpecials, pcrossCounts, resetPcrossCounts,
  pspecCounts, resetPspecCounts, bindSpecialsWorld,
  buttonList, lineSpecialList, activePlats, activeCeilings,
  dispatchTables, BUTTONTIME, BWHERE, SFX_SWTCHN,
  pFindSectorFromLineTag, pFindLowestFloorSurrounding,
  pFindHighestFloorSurrounding, pFindNextHighestFloor,
  pFindLowestCeilingSurrounding, pFindHighestCeilingSurrounding,
  pFindMinSurroundingLight, getNextSector, pspecHelperCounts,
  resetPspecHelperCounts
} from './pspec';
import {
  LINE_SPECIALS, registryManifest, unimplementedSpecial,
  resetUnimplementedSpecial
} from './specials-table';
import type { ActionId, ActionSpec } from './specials-table';

const fx = (u: number): number => (u * FRACUNIT) | 0;

function stateFrom(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

const PLAYER: Mover = {
  x: 0, y: 0, z: 0, radius: fx(16), height: fx(56),
  flags: PLAYER_FLAGS, player: true
};
function monster(flags = MF_SOLID): Mover {
  return { x: 0, y: 0, z: 0, radius: fx(16), height: fx(56), flags, player: false };
}

/** Two rooms side by side joined by a wide two-sided seam (all lines
 * between the rooms are usable carriers for dispatch tests). */
const TWO_ROOMS: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 },
    { x: 256, y: 0, w: 256, h: 256 }
  ],
  things: [{ x: 64, y: 64, angle: 0, type: 1 }]
};

function anyTwoSidedLine(s: GameState): number {
  const L = s.map.lines;
  for (let i = 0; i < L.count; i++) {
    if ((L.flags[i]! & ML_TWOSIDED) !== 0 && L.sectorBack[i]! >= 0) return i;
  }
  throw new Error('no two-sided line');
}

beforeEach(() => {
  resetPcrossCounts();
  resetPspecCounts();
  resetUnimplementedSpecial();
  resetPspecHelperCounts();
  resetUpdateSpecialsCounts();
});

/* ------------------------------------------------------------------ */
/* 1) Coverage: all 139 ids through the real dispatchers                */
/* ------------------------------------------------------------------ */

const FN_OF: Record<ActionId, string | null> = {
  door: 'evDoDoor', floor: 'evDoFloor', plat: 'evDoPlat', ceiling: 'evDoCeiling',
  stairs: 'evBuildStairs', donut: 'evDoDonut', lightOn: 'evLightTurnOn',
  strobe: 'evStartLightStrobing', lightsOff: 'evTurnTagLightsOff',
  crushStop: 'evCeilingCrushStop', stopPlat: 'evStopPlat', teleport: 'evTeleport',
  verticalDoor: 'evVerticalDoor', lockedDoor: 'evDoLockedDoor', exit: null
};

// Families whose stub bodies are REPLACED by the live code (M6 waves 3+;
// each family task adds its action ids here when its bodies land). The
// stub-hit assertion below is a pre-implementation skeleton check only —
// live families are covered by their family test file (plats: pplats.test,
// M6-plan §M6-13.1 replaces this loop with real per-special scenarios).
const LIVE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['plat', 'stopPlat']);
const allLive = (acts: readonly ActionSpec[]): boolean =>
  acts.every((a) => LIVE_ACTIONS.has(a.action));

function hits(fn: string, special: number): number {
  return unimplementedSpecial.entries.filter(
    (e) => e.fn === fn && e.special === special
  ).length;
}

describe('dispatch coverage — every registered id routes to its stub (plan §M6-03.1)', () => {
  const s = stateFrom(TWO_ROOMS);
  const line = anyTwoSidedLine(s);

  const expectActions = (
    acts: readonly ActionSpec[], special: number, side = 0, mover: Mover = PLAYER
  ): void => {
    for (const a of acts) {
      const fn = FN_OF[a.action];
      if (fn === null) continue; // 'exit' asserted via exitRequest
      expect(hits(fn, special), `special ${special} → ${fn}`).toBe(1);
      void side;
      void mover;
    }
  };

  it('cross ids: pCrossSpecialLine hits each route once (monster movers for 125/126)', () => {
    for (let id = 1; id <= 141; id++) {
      const e = LINE_SPECIALS[id];
      if (!e?.cross) continue;
      if (allLive(e.cross.actions)) continue; // live family — see LIVE_ACTIONS
      resetUnimplementedSpecial();
      s.map.lines.special[line] = id;
      s.exitRequest = 'none';
      s.specialexit = false;
      bindSpecialsWorld(s);
      const mover = e.cross.monsterOnly ? monster() : PLAYER;
      pCrossSpecialLine(s.pmap, line, 0, mover);
      expectActions(e.cross.actions, id);
      if (e.cross.actions.some((a) => a.action === 'exit')) {
        expect(s.exitRequest, `cross exit ${id}`).toBe(id === 124 ? 'secret' : 'normal');
      }
      // W1 clears, GR keeps:
      const cleared = s.map.lines.special[line] === 0;
      expect(cleared, `cross ${id} clear`).toBe(e.cross.clear === true);
    }
  });

  it('use ids: pUseSpecialLine hits each route once + the switch stub per flag', () => {
    for (let id = 1; id <= 141; id++) {
      const e = LINE_SPECIALS[id];
      if (!e?.use) continue;
      if (allLive(e.use.actions)) continue; // live family — see LIVE_ACTIONS
      resetUnimplementedSpecial();
      s.map.lines.special[line] = id;
      s.exitRequest = 'none';
      s.specialexit = false;
      bindSpecialsWorld(s);
      expect(pUseSpecialLine(s, PLAYER, line, 0), `use ${id} returns true`).toBe(true);
      expectActions(e.use.actions, id);
      const sw = hits('pChangeSwitchTexture', id);
      const expectSw =
        e.use.switchBefore !== undefined || e.use.thenSwitch !== undefined ? 1 : 0;
      // gateSwitch entries: stub action returned false ⇒ switch NOT swapped
      // (vanilla "failed action leaves switch armed"), pinned:
      expect(sw, `use ${id} switch stub`).toBe(expectSw);
      if (e.use.actions.some((a) => a.action === 'exit')) {
        expect(s.exitRequest, `use exit ${id}`).toBe(id === 51 ? 'secret' : 'normal');
      }
    }
  });

  it('shoot ids 24/46/47: unconditional action + ChangeSwitchTexture', () => {
    for (const id of [24, 46, 47]) {
      if (allLive(LINE_SPECIALS[id]!.shoot!.actions)) continue; // see LIVE_ACTIONS
      resetUnimplementedSpecial();
      s.map.lines.special[line] = id;
      const e = LINE_SPECIALS[id]!.shoot!;
      pShootSpecialLine(s, PLAYER, line);
      expectActions(e.actions, id);
      expect(hits('pChangeSwitchTexture', id), `shoot ${id} switch`).toBe(1);
    }
  });

  it('scroll 48: registered (spawn-collected); zero stubs at dispatch time', () => {
    s.map.lines.special[line] = 48;
    resetUnimplementedSpecial();
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(pspecCounts.unboundDispatch).toBe(0);
    expect(unimplementedSpecial.count).toBe(0);
    s.map.lines.special[line] = 0;
  });

  it('manifest numbers are the ones the registry carries', () => {
    const m = registryManifest();
    expect(m.lineRegistered + m.lineExcluded).toBe(141);
    expect(m.sectorRegistered + m.sectorExcluded).toBe(17);
  });
});

/* ------------------------------------------------------------------ */
/* 2) Cross semantics: W1 clears, GR keeps, gates                       */
/* ------------------------------------------------------------------ */

describe('cross dispatch semantics', () => {
  const s = stateFrom(TWO_ROOMS);
  const line = anyTwoSidedLine(s);

  it('W1 2: fires once, clears; second crossing dispatches but hits nothing', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 2;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(s.map.lines.special[line]).toBe(0);
    expect(hits('evDoDoor', 2)).toBe(1);
    pCrossSpecialLine(s.pmap, line, 1, PLAYER); // special now 0
    expect(pcrossCounts.crossSpecialLine).toBe(2);
    expect(hits('evDoDoor', 0)).toBe(0);
    expect(hits('evDoDoor', 2)).toBe(1);
  });

  it('GR 90: keeps firing across repeated crossings', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 90;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    pCrossSpecialLine(s.pmap, line, 1, PLAYER);
    expect(s.map.lines.special[line]).toBe(90);
    expect(hits('evDoDoor', 90)).toBe(2);
  });

  it('non-player: missile movers never fire; ok-list only; players unaffected', () => {
    bindSpecialsWorld(s);
    const missile: Mover = { ...monster(), flags: MF_SOLID | MF_MISSILE };
    s.map.lines.special[line] = 90;
    pCrossSpecialLine(s.pmap, line, 0, missile);
    pCrossSpecialLine(s.pmap, line, 0, monster());
    expect(unimplementedSpecial.count).toBe(0); // 90 not on the ok-list
    s.map.lines.special[line] = 4; // W1 RAISE DOOR — monster-allowed
    resetUnimplementedSpecial();
    pCrossSpecialLine(s.pmap, line, 0, missile);
    expect(unimplementedSpecial.count).toBe(0);
    pCrossSpecialLine(s.pmap, line, 0, monster());
    expect(hits('evDoDoor', 4)).toBe(1);
  });

  it('125: player crossing is a harmless no-op (keeps special); monster fires+clears', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 125;
    resetUnimplementedSpecial();
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(s.map.lines.special[line]).toBe(125);
    expect(unimplementedSpecial.count).toBe(0);
    pCrossSpecialLine(s.pmap, line, 0, monster());
    expect(hits('evTeleport', 125)).toBe(1);
    expect(s.map.lines.special[line]).toBe(0);
  });

  it('126: monster-only, never clears (player and monster passes)', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 126;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    pCrossSpecialLine(s.pmap, line, 1, monster());
    expect(s.map.lines.special[line]).toBe(126);
    expect(hits('evTeleport', 126)).toBe(1);
  });

  it('teleport wiring passes the crossing side to EV_Teleport (gate body: M6-10)', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 39;
    pCrossSpecialLine(s.pmap, line, 1, PLAYER);
    const ev = unimplementedSpecial.entries.find((e) => e.fn === 'evTeleport');
    expect(ev?.arg).toBe(1); // side recorded; side==1 rejection lands M6-10
  });

  it('use gates: side-1 refusal, 124 side-1 no-op, monster {1,32,33,34} + ML_SECRET', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 21;
    expect(pUseSpecialLine(s, PLAYER, line, 1)).toBe(false);
    expect(unimplementedSpecial.count).toBe(0);
    s.map.lines.special[line] = 124;
    expect(pUseSpecialLine(s, PLAYER, line, 1)).toBe(true); // no-op fall-through
    expect(s.exitRequest).toBe('none');
    s.map.lines.special[line] = 21;
    expect(pUseSpecialLine(s, monster(), line, 0)).toBe(false);
    s.map.lines.flags[line] = s.map.lines.flags[line]! | ML_SECRET;
    s.map.lines.special[line] = 1;
    expect(pUseSpecialLine(s, monster(), line, 0)).toBe(false); // secret: never
    s.map.lines.flags[line] = s.map.lines.flags[line]! & ~ML_SECRET;
    expect(pUseSpecialLine(s, monster(), line, 0)).toBe(true); // manual ok
    s.map.lines.special[line] = 0;
  });

  it('S1 with a stubbed (failed) action leaves the switch armed', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 29; // S1 EV_DoDoor + gateSwitch 0
    pUseSpecialLine(s, PLAYER, line, 0);
    expect(s.map.lines.special[line]).toBe(29);
    expect(hits('evDoDoor', 29)).toBe(1);
    expect(hits('pChangeSwitchTexture', 29)).toBe(0);
  });

  it('cross 40 runs BOTH actions (ceiling then floor)', () => {
    bindSpecialsWorld(s);
    s.map.lines.special[line] = 40;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(hits('evDoCeiling', 40)).toBe(1);
    expect(hits('evDoFloor', 40)).toBe(1);
    expect(s.map.lines.special[line]).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3) spechit call site is LIVE (replaces the M5-03 counted stub)        */
/* ------------------------------------------------------------------ */

describe('pTryMove spechit path drives the real dispatcher', () => {
  it('crossing a W1 2 line through P_TryMove fires once + clears; re-cross silent', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 }
      ],
      doors: [{ x1: 256, y1: 32, x2: 256, y2: 96, special: 2, tag: 0 }],
      things: [{ x: 64, y: 224, angle: 0, type: 1 }]
    });
    let line = -1;
    for (let i = 0; i < s.map.lines.count; i++) {
      if (s.map.lines.special[i] === 2) line = i;
    }
    expect(line).toBeGreaterThan(-1);
    resetUnimplementedSpecial();
    bindSpecialsWorld(s);
    const mo: Mover = {
      x: fx(240), y: fx(64), z: 0, radius: fx(16), height: fx(56),
      flags: PLAYER_FLAGS, player: true
    };
    expect(pTryMove(s.pmap, mo, fx(268), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine).toBe(1);
    expect(hits('evDoDoor', 2)).toBe(1);
    expect(s.map.lines.special[line]).toBe(0);
    // walk back and over again: no spechit dispatch (special cleared)
    expect(pTryMove(s.pmap, mo, fx(244), fx(64))).toBe(true);
    expect(pTryMove(s.pmap, mo, fx(268), fx(64))).toBe(true);
    expect(hits('evDoDoor', 2)).toBe(1);
    expect(pspecCounts.unboundDispatch).toBe(0);
  });

  it('crossing a use-only special (1) counts + dispatches, no cross route, no clear', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 }
      ],
      doors: [{ x1: 256, y1: 32, x2: 256, y2: 96, special: 1, tag: 0 }],
      things: [{ x: 64, y: 224, angle: 0, type: 1 }]
    });
    resetUnimplementedSpecial();
    bindSpecialsWorld(s);
    const mo: Mover = {
      x: fx(240), y: fx(64), z: 0, radius: fx(16), height: fx(56),
      flags: PLAYER_FLAGS, player: true
    };
    expect(pTryMove(s.pmap, mo, fx(268), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine).toBe(1);
    expect(unimplementedSpecial.count).toBe(0); // no cross route for 1
    let line = -1;
    for (let i = 0; i < s.map.lines.count; i++) if (s.map.lines.special[i] === 1) line = i;
    expect(s.map.lines.special[line]).toBe(1); // untouched
  });

  it('foreign/unbound worlds only count (pmap unit-world parity)', () => {
    const a = stateFrom(TWO_ROOMS);
    const b = stateFrom({
      rooms: [{ x: 0, y: 0, w: 128, h: 128 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    // b bound last: dispatch against a's map must not act on b's state
    expect(b.map).not.toBe(a.map);
    const lineA = anyTwoSidedLine(a);
    a.map.lines.special[lineA] = 90;
    resetUnimplementedSpecial();
    pCrossSpecialLine(a.pmap, lineA, 0, PLAYER);
    expect(pcrossCounts.crossSpecialLine).toBe(1);
    expect(pspecCounts.unboundDispatch).toBe(1);
    expect(unimplementedSpecial.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4) P_SpawnSpecials / P_UpdateSpecials wiring                          */
/* ------------------------------------------------------------------ */

describe('P_SpawnSpecials (map setup wiring)', () => {
  it('sector pass: totalsecret counts 9s; spawner stubs hit; clearTo values exact', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128, special: 9 },
        { x: 256, y: 0, w: 128, h: 128, special: 2 },
        { x: 512, y: 0, w: 128, h: 128, special: 4 },
        { x: 768, y: 0, w: 128, h: 128, special: 1 },
        { x: 1024, y: 0, w: 128, h: 128, special: 12 },
        { x: 1280, y: 0, w: 128, h: 128, special: 10 }
      ],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(s.totalsecret).toBe(1);
    // live specials after load: 9 stays 9, 4 re-writes 4, others → 0.
    expect(Array.from(s.sectors.special)).toEqual([0, 9, 0, 4, 0, 0, 0]);
    expect(unimplementedSpecial.bySector[2]).toBe(1);
    expect(unimplementedSpecial.bySector[4]).toBe(1);
    expect(unimplementedSpecial.bySector[12]).toBe(1);
    expect(unimplementedSpecial.bySector[1]).toBe(1);
    expect(unimplementedSpecial.bySector[10]).toBe(1);
    expect(unimplementedSpecial.byFn.get('pSpawnStrobeFlash(35,1)')).toBe(1); // 12 in-sync
    expect(unimplementedSpecial.byFn.get('pSpawnStrobeFlash(15,0)')).toBe(2); // 2 and 4
    expect(unimplementedSpecial.byFn.get('pSpawnDoorCloseIn30')).toBe(1);
  });

  it('line pass collects 48 (linespeciallist), inits the vanilla lists', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 }
      ],
      triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 48 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(lineSpecialList.count).toBe(1);
    const ln = lineSpecialList.lines[0]!;
    expect(s.map.lines.special[ln]).toBe(48);
    expect(activePlats.every((t) => t === null)).toBe(true);
    expect(activeCeilings.every((t) => t === null)).toBe(true);
    expect(buttonList.every((b) => b.btimer === 0 && b.line === -1)).toBe(true);
    expect(pspecCounts.levelTimer).toBe(0); // levelTimer NOT ported

    // P_UpdateSpecials: side-0 textureoffset += FRACUNIT per tic (int32 wrap).
    const side = s.map.lines.sideNumFront[ln]!;
    const before = s.map.sides.offsetX[side]!;
    resetUpdateSpecialsCounts();
    pUpdateSpecials(s);
    pUpdateSpecials(s);
    expect(s.map.sides.offsetX[side]! - before).toBe(2 * FRACUNIT);
    expect(updateSpecialsCounts.calls).toBe(2); // ptick counter still fed
    expect(s.map.lines.special[ln]).toBe(48); // 48 never clears
  });

  it('button tick is live: armed slot reverts side texture + logs sfx at 0', () => {
    const s = stateFrom(TWO_ROOMS);
    const line = anyTwoSidedLine(s);
    const side = s.map.lines.sideNumFront[line]!;
    // Delegate to M6-11's P_StartButton; here arm the shared slot directly.
    const b = buttonList[0]!;
    (s.map.sides.midTexture as string[])[side] = 'SW2MTX';
    b.line = line;
    b.where = BWHERE.middle;
    b.btexture = 'SW1MTX';
    b.btimer = BUTTONTIME;
    s.leveltime = 7;
    pUpdateSpecials(s);
    expect(b.btimer).toBe(BUTTONTIME - 1);
    expect(s.map.sides.midTexture[side]).toBe('SW2MTX');
    pUpdateSpecials(s);
    expect(b.btimer).toBe(BUTTONTIME - 2);
    for (let i = 0; i < BUTTONTIME - 2; i++) pUpdateSpecials(s);
    expect(b.btimer).toBe(0);
    expect(s.map.sides.midTexture[side]).toBe('SW1MTX');
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHN)).toBe(1);
    expect(s.hooks.sfx.entries[0]!.tic).toBe(7); // leveltime frozen in this test
  });

  it('re-spawn (second level start) resets the lists', () => {
    const s = stateFrom(TWO_ROOMS);
    buttonList[3]!.btimer = 5;
    activePlats[2] = { id: 99, fn: null, removed: false, hashWords: [] };
    pSpawnSpecials(s);
    expect(buttonList.every((b) => !b.btimer)).toBe(true);
    expect(activePlats.every((t) => t === null)).toBe(true);
    expect(lineSpecialList.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5) P_Find* helpers vs brute-force references                          */
/* ------------------------------------------------------------------ */

/** Brute-force neighbour set via GLOBAL ascending linedef scan (the
 * independent reference for the CSR iteration order). */
function neighbours(s: GameState, sec: number): number[] {
  const L = s.map.lines;
  const out: number[] = [];
  for (let l = 0; l < L.count; l++) {
    if ((L.flags[l]! & ML_TWOSIDED) === 0) continue;
    const f = L.sectorFront[l]!;
    const b = L.sectorBack[l]!;
    if (f === sec && b >= 0) out.push(b);
    else if (b === sec && f >= 0) out.push(f);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function compareHelpers(s: GameState, label: string): void {
  for (let sec = 0; sec < s.sectors.count; sec++) {
    const nb = neighbours(s, sec);
    const fz = s.sectors.floorZ;
    const cz = s.sectors.ceilingZ;
    const li = s.sectors.light;
    expect(
      pFindLowestFloorSurrounding(s, sec), `${label} lowFloor ${sec}`
    ).toBe(nb.reduce((m, o) => Math.min(m, fz[o]!), fz[sec]!));
    expect(
      pFindHighestFloorSurrounding(s, sec), `${label} highFloor ${sec}`
    ).toBe(nb.length === 0 ? -500 * FRACUNIT : nb.reduce((m, o) => Math.max(m, fz[o]!), -500 * FRACUNIT));
    expect(
      pFindLowestCeilingSurrounding(s, sec), `${label} lowCeil ${sec}`
    ).toBe(nb.length === 0 ? 0x7fffffff : nb.reduce((m, o) => Math.min(m, cz[o]!), 0x7fffffff));
    expect(
      pFindHighestCeilingSurrounding(s, sec), `${label} highCeil ${sec}`
    ).toBe(nb.length === 0 ? 0 : nb.reduce((m, o) => Math.max(m, cz[o]!), 0));
    expect(
      pFindMinSurroundingLight(s, sec, 192), `${label} minLight ${sec}`
    ).toBe(nb.reduce((m, o) => Math.min(m, li[o]!), 192));
    // P_FindNextHighestFloor vs the same algorithm over the reference list
    const cur = fz[sec]!;
    const above = nb.map((o) => fz[o]!).filter((h) => h > cur).slice(0, 20);
    expect(
      pFindNextHighestFloor(s, sec, cur), `${label} nextHigh ${sec}`
    ).toBe(above.length === 0 ? cur : Math.min(...above));
  }
}

describe('P_Find* helpers vs brute force', () => {
  it('seeded random 3×3 sector mazes (5 seeds): all helpers agree', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rnd = mulberry32(seed);
      const rooms = [];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const floor = Math.floor(rnd() * 64) - 32;
          rooms.push({
            x: i * 256, y: j * 256, w: 256, h: 256,
            floorHeight: floor,
            ceilingHeight: floor + 64 + Math.floor(rnd() * 64),
            lightLevel: 16 + Math.floor(rnd() * 16) * 14,
            tag: Math.floor(rnd() * 3)
          });
        }
      }
      const s = stateFrom({ rooms, things: [{ x: 384, y: 384, angle: 0, type: 1 }] });
      compareHelpers(s, `seed ${seed}`);
    }
  });

  it('live SoA authority: helpers read mutated live heights, not the static copy', () => {
    const s = stateFrom(TWO_ROOMS);
    const [a, b] = [1, 2]; // rooms are sectors 1,2 (void = 0)
    s.sectors.floorZ[b] = fx(40);
    // neighbours include the VOID sector (floor −128, two-sided per the
    // fixture wall convention) — the LIVE 40 must beat the static copy:
    expect(pFindLowestFloorSurrounding(s, a)).toBe(fx(-128));
    expect(pFindHighestFloorSurrounding(s, a)).toBe(fx(40));
    expect(pFindNextHighestFloor(s, a, 0)).toBe(fx(40));
    expect(pFindNextHighestFloor(s, a, fx(40))).toBe(fx(40)); // nothing above
    expect(s.map.sectors.floorHeight[b]).toBe(0); // static untouched
  });

  it('tie order is value-irrelevant for min/max, but NextHighestFloor keeps vanilla first-20 order', () => {
    const s = stateFrom(TWO_ROOMS);
    const line = anyTwoSidedLine(s);
    void line;
    s.sectors.floorZ[2] = fx(16);
    expect(pFindNextHighestFloor(s, 1, 0)).toBe(fx(16));
    expect(pFindNextHighestFloor(s, 1, fx(16))).toBe(fx(16)); // nothing above
  });
});

describe('P_FindNextHighestFloor 20-cap (MAX_ADJOINING_SECTORS)', () => {
  it('32 adjoining sectors: scan breaks at 20 collected, overflow counted', () => {
    // center room (256,256,256×256); 8 neighbours per side on the east /
    // west edges + 8 per side on north/south = 32 adjoining sectors.
    const rooms = [
      { x: 256, y: 256, w: 256, h: 256, floorHeight: 0 }
    ];
    for (let i = 0; i < 8; i++) {
      rooms.push({ x: 512, y: 256 + i * 32, w: 256, h: 32, floorHeight: 0 });
      rooms.push({ x: 0, y: 256 + i * 32, w: 256, h: 32, floorHeight: 0 });
    }
    for (let i = 0; i < 8; i++) {
      rooms.push({ x: 256 + i * 32, y: 512, w: 32, h: 256, floorHeight: 0 });
      rooms.push({ x: 256 + i * 32, y: 0, w: 32, h: 256, floorHeight: 0 });
    }
    const s = stateFrom({ rooms, things: [{ x: 384, y: 384, angle: 0, type: 1 }] });
    const center = 1;
    const nb = neighbours(s, center);
    expect(nb.length).toBe(32);
    // Assign live floors so the GLOBAL MIN sits at scan position 31 (the
    // very last adjoining sector): height descends with linedef order.
    for (let k = 0; k < nb.length; k++) {
      s.sectors.floorZ[nb[k]!] = fx(400 - k);
    }
    resetPspecHelperCounts();
    const got = pFindNextHighestFloor(s, center, 0);
    expect(pspecHelperCounts.nextHighestFloorOverflow).toBe(1);
    // first 20 collected by the SAME ascending-linedef-order reference:
    const first20 = nb.slice(0, 20).map((o) => s.sectors.floorZ[o]!);
    expect(got).toBe(Math.min(...first20));
    // …and strictly ABOVE the true global min — proof the cap truncated:
    expect(got).toBeGreaterThan(Math.min(...nb.map((o) => s.sectors.floorZ[o]!)));
  });
});

describe('P_FindSectorFromLineTag order pin', () => {
  it('resumable scan == ascending sector index (no tag-0 fallback)', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128, tag: 0 },
        { x: 256, y: 0, w: 128, h: 128, tag: 7 },
        { x: 512, y: 0, w: 128, h: 128, tag: 3 },
        { x: 768, y: 0, w: 128, h: 128, tag: 7 },
        { x: 1024, y: 0, w: 128, h: 128, tag: 7 }
      ],
      triggers: [{ x1: 1024, y1: 32, x2: 1024, y2: 96, special: 2, tag: 7 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    const line = (() => {
      for (let i = 0; i < s.map.lines.count; i++) {
        if (s.map.lines.tag[i] === 7 && s.map.lines.special[i] === 2) return i;
      }
      throw new Error('tagged line missing');
    })();
    const expected: number[] = [];
    for (let i = 0; i < s.sectors.count; i++) if (s.sectors.tag[i] === 7) expected.push(i);
    const seq: number[] = [];
    for (let k = pFindSectorFromLineTag(s, line, -1); k >= 0; k = pFindSectorFromLineTag(s, line, k)) {
      seq.push(k);
      if (seq.length > 16) break;
    }
    expect(seq).toEqual(expected);
    expect(seq.length).toBe(3);
    expect(pFindSectorFromLineTag(s, line, seq[2]!)).toBe(-1);
  });
});

/* ------------------------------------------------------------------ */
/* Zero-alloc hot dispatch (structural proof)                            */
/* ------------------------------------------------------------------ */

describe('zero-alloc hot dispatch', () => {
  it('dispatch tables are prebuilt, frozen, and identity-stable across calls', () => {
    const t1 = dispatchTables.cross;
    const s = stateFrom(TWO_ROOMS);
    const line = anyTwoSidedLine(s);
    s.map.lines.special[line] = 90;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(dispatchTables.cross).toBe(t1); // module constant, not rebuilt
    expect(Object.isFrozen(t1)).toBe(true);
    expect(Object.isFrozen(t1[90])).toBe(true);
    expect(Object.isFrozen(dispatchTables.use)).toBe(true);
    expect(Object.isFrozen(dispatchTables.shoot)).toBe(true);
    expect(t1.length).toBe(142);
  });
});

/* ------------------------------------------------------------------ */
/* E1M1 (skipIf): helpers vs brute force on real geometry                */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 helper parity', () => {
  it('all six helpers match the global-scan reference on every sector', () => {
    const buf = readFileSync(WAD_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(ab), 'E1M1')));
    compareHelpers(s, 'E1M1');
    // bind sanity: this state re-bound the dispatcher at gInitGame.
    bindSpecialsWorld(s);
    expect(getNextSector(s.map, anyTwoSidedLine(s), 1) >= -1).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* M6-02 fixture families: dispatch smoke (M6DOOR / M6SECT)             */
/* ------------------------------------------------------------------ */

function stateFromNamed(spec: RectMapSpec, name: string): GameState {
  const bytes = buildFixtureMapWad(spec, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), name)));
}

function lineWithSpecial(s: GameState, special: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.special[i] === special) return i;
  }
  throw new Error(`no line with special ${special}`);
}

describe('M6-02 fixture smoke — registry routes the family specials', () => {
  it('M6DOOR: use-lines route manual/locked → EV_VerticalDoor, SR 63 → EV_DoDoor', () => {
    const s = stateFromNamed(M6_SCENES.door, 'M6DOOR');
    bindSpecialsWorld(s);
    expect(pUseSpecialLine(s, PLAYER, lineWithSpecial(s, 1), 0)).toBe(true);
    expect(hits('evVerticalDoor', 1)).toBe(1);
    const l63 = lineWithSpecial(s, 63);
    expect(pUseSpecialLine(s, PLAYER, l63, 0)).toBe(true);
    expect(hits('evDoDoor', 63)).toBe(1);
    expect(hits('pChangeSwitchTexture', 63)).toBe(0); // action failed ⇒ armed
    expect(s.map.lines.special[l63]).toBe(63);
    expect(pUseSpecialLine(s, PLAYER, lineWithSpecial(s, 26), 0)).toBe(true);
    expect(hits('evVerticalDoor', 26)).toBe(1); // lock branch: EV_VerticalDoor body (M6-05)
    // W1 cross 4 (monster-allowed): fires for monsters and clears.
    const l4 = lineWithSpecial(s, 4);
    pCrossSpecialLine(s.pmap, l4, 0, monster());
    expect(hits('evDoDoor', 4)).toBe(1);
    expect(s.map.lines.special[l4]).toBe(0);
  });

  it('M6SECT: cross 90 keeps / 19 clears / 52+124 exits; sector spawn census', () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    bindSpecialsWorld(s);
    // (spawn stub hits already recorded by gInitGame after the beforeEach reset)
    const l90 = lineWithSpecial(s, 90);
    pCrossSpecialLine(s.pmap, l90, 0, PLAYER);
    pCrossSpecialLine(s.pmap, l90, 1, PLAYER);
    expect(hits('evDoDoor', 90)).toBe(2);
    expect(s.map.lines.special[l90]).toBe(90);
    const l19 = lineWithSpecial(s, 19);
    pCrossSpecialLine(s.pmap, l19, 0, PLAYER);
    expect(hits('evDoFloor', 19)).toBe(1);
    expect(s.map.lines.special[l19]).toBe(0);
    const l124 = lineWithSpecial(s, 124);
    expect(s.map.lines.flags[l124]! & ML_SECRET).toBe(ML_SECRET);
    pCrossSpecialLine(s.pmap, l124, 0, PLAYER);
    expect(s.exitRequest).toBe('secret');
    expect(s.specialexit).toBe(true);
    pCrossSpecialLine(s.pmap, lineWithSpecial(s, 52), 0, PLAYER);
    expect(s.exitRequest).toBe('normal'); // last wins (exitSlot)
    expect(s.map.lines.special[l124]).toBe(124); // never cleared

    // P_SpawnSpecials census on the sector family (sectors 1..12):
    expect(s.totalsecret).toBe(1); // one SECTOR_SECRET room
    expect(unimplementedSpecial.bySector[2]).toBe(1); // strobe room + hall? (frag)
    expect(unimplementedSpecial.bySector[12]).toBe(1);
    expect(unimplementedSpecial.bySector[1]).toBe(1);
    expect(unimplementedSpecial.bySector[17]).toBe(1);
    expect(unimplementedSpecial.bySector[4]).toBe(1); // strobe-hurt spawns too
    expect(s.sectors.special[3]).toBe(4); // SECTOR_STROBE_HURT stays 4
    expect(s.sectors.special[2]).toBe(5); // damage-only specials UNTOUCHED
    expect(s.sectors.special[8]).toBe(0); // light-flash cleared at load
    expect(s.sectors.special[10]).toBe(9); // secret kept until feet (M6-12)
    expect(s.sectors.special[11]).toBe(11); // finale untouched (M6-12)
  });
});
