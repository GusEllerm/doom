/**
 * sim/p_mobj — M7-02 acceptance tests (M7-plan §M7-02):
 *  1. state cascade truth table (0-tic chain runs N actions in ONE set,
 *     S_NULL removes mid-tic and the caller bails);
 *  2. ZMISC: the puff rises via momz with NO XY motion and dies at state
 *     end (P_SetMobjState → S_NULL → removal through the arena);
 *  3. thinglinks round-trip under move + split-MAXMOVE (grid == brute
 *     force after every step — the M5-05 wall invariant, now with real
 *     mobj movers) and link/unlink on spawn/remove;
 *  4. pathTrace PT_ADDTHINGS hits planted dummies in the same intercept
 *     order as a brute-force reference;
 *  5. spawn census (E1M1 per-doomednum counts + the skill-filter matrix +
 *     AMBUSH/DM-start bookkeeping), doomednum round-trip over the full
 *     table, ONFLOORZ/ONCEILINGZ live-sector resolution, the PRNG stream
 *     the spawn pass draws, and the double-run E1M1 hash WITH mobjs
 *     (hash contribution = the thinker-arena payload words, ARCH §3.4).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { mobjinfo, MT, MF, DOOMEDNUM_TO_MT } from '../wad/info/mobjinfo';
import { S, stateAt } from '../wad/info/states';
import { ACT, registerAction, resetActions, unimplementedActions } from './a_actions';

import { buildMapFromData, mapThingAt } from './map';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame, runHeadless } from './game';
import { hashState, type GameState, type Skill } from './state';
import { pAddThinker, pRunThinkers, thinkerCount } from './ptick';
import { pXYMovement, pZMovement } from './pmove';
import { pTryMove } from './pmap';
import { pPathTraverse, pInterceptVector, PT_ADDTHINGS, type Intercept } from './pmaputl';
import { pointOnDivlineSide } from './bsp';
import { sectorAtPoint } from './bsp';
import {
  skillBit,
  MF_SPECIAL,
  MF_MISSILE,
  MTF_AMBUSH,
  MF_AMBUSH,
  MF_JUSTHIT,
  MF_JUSTATTACKED,
  MF_CORPSE,
  MF_INFLOAT,
  MF_SKULLFLY,
  isNetGameStartMarker,
} from './thinglinks';
import { mobjFromSlot as hooksMobjFromSlot } from './hooks';
import {
  DI_NODIR,
  mobjFromSlot,
  pSetMobjFlags,
  syncMobj,
  pExplodeMissile,
  pRemoveMobj,
  pRespawnSpecials,
  pSetMobjState,
  pSpawnBlood,
  pSpawnMapThing,
  pSpawnMobj,
  pSpawnPuff,
  MELEERANGE,
  MISSILERANGE,
  ONCEILINGZ,
  ONFLOORZ,
  attackRange,
  type Mobj,
  type MobjRuntime,
} from './p_mobj';

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

/** 512×512 flat room, spawn far from the test band, decor row at y=250. */
function roomSpec(things: RectMapSpec['things']): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
    things: [{ x: 32, y: 32, angle: 0, type: 1 }, ...(things ?? [])],
  };
}

function bootFixture(things: RectMapSpec['things'], skill: Skill = 2): GameState {
  const spec = roomSpec(things);
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

function e1m1(skill: Skill = 2): GameState {
  const buf = readFileSync(WAD_PATH).buffer.slice(0) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')), skill);
}

/** Live (non-removed) mobjs of a runtime. */
function liveMobjs(rt: MobjRuntime): Mobj[] {
  return rt.mobjs.filter((m) => !m.removed);
}

beforeEach(() => {
  resetActions();
  attackRange.value = MISSILERANGE;
});

/* ================================================================== */
/* 1. P_SetMobjState — the 0-tic cascade truth table                    */
/* ================================================================== */

describe('P_SetMobjState — cascade truth table (acceptance 1)', () => {
  it('0-tic chain executes EVERY entry action in one call, in order', () => {
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const m = liveMobjs(s.mobjs)[0]!; // the barrel
    const seen: number[] = [];
    registerAction(ACT.A_VileStart, () => seen.push(36));
    registerAction(ACT.A_FaceTarget, () => seen.push(31));
    // S_VILE_ORIGIN=255: tics 0, action 36 → next 256 (tics 10, action 31).
    const alive = pSetMobjState(m, 255);
    expect(alive).toBe(true);
    expect(seen, 'both actions fired inside the ONE set call').toEqual([36, 31]);
    expect(m.state).toBe(256);
    expect(m.tics).toBe(10);
  });

  it('a tics-0 row whose nextstate is S_NULL removes the mobj: false + unlink + thinker sentinel', () => {
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const m = liveMobjs(s.mobjs)[0]!;
    let fired = 0;
    registerAction(ACT.A_Light0, () => fired++);
    // state 1 = S_LIGHTDONE: tics 0, action A_Light0, nextstate S_NULL.
    const alive = pSetMobjState(m, 1);
    expect(alive).toBe(false);
    expect(fired).toBe(1); // the action ran BEFORE the removal
    expect(m.removed).toBe(true);
    expect(m.thinker.removed).toBe(true);
    expect(s.pmap.links.linked[m.linkSlot]).toBe(0);
    // caller bails: a second set on the removed mobj is a silent false
    expect(pSetMobjState(m, 1)).toBe(false);
  });

  it('unregistered actions are recorded stubs, in execution order (36-stub observability)', () => {
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const m = liveMobjs(s.mobjs)[0]!;
    // 255 →(A_VileStart) 256 →(A_FaceTarget, tics 10) — no registration.
    pSetMobjState(m, 255);
    const rec = unimplementedActions();
    expect(rec.get('A_VileStart')).toBe(1);
    expect(rec.get('A_FaceTarget')).toBe(1);
  });

  it('the spawnstate action NEVER fires at spawn (p_mobj.c:509-510)', () => {
    const s = bootFixture([]);
    pSpawnMobj(s.mobjs, 100 << 16, 100 << 16, ONFLOORZ, MT.MT_POSSESSED);
    // S_POSS_STAND (174) carries A_Look — spawn copies it without dispatch.
    expect(unimplementedActions().get('A_Look')).toBeUndefined();
    // …but the tic cycle DOES dispatch it when the state is re-entered.
    const m = liveMobjs(s.mobjs).find((x) => x.type === MT.MT_POSSESSED)!;
    for (let t = 0; t < 21; t++) pRunThinkers(s.thinkers);
    expect(unimplementedActions().get('A_Look')).toBe(2); // 174→175→174
    expect([174, 175]).toContain(m.state);
  });
});

/* ================================================================== */
/* 2. Z_MOVES: the puff rises with momz, no XY, dies at state end       */
/* ================================================================== */

describe('ZMISC mover — puff/blood (acceptance 2)', () => {
  it('puff: z rises by momz every tic, x/y EXACTLY constant, removed at chain end', () => {
    const s = bootFixture([]);
    const x0 = 128 << 16;
    const y0 = 128 << 16;
    const m = pSpawnPuff(s.mobjs, x0, y0, s.sectors.floorZ[0]! + 8 * FRACUNIT);
    expect(m.type).toBe(MT.MT_PUFF);
    expect(m.momz).toBe(FRACUNIT);
    expect(m.flags & MF.MF_NOGRAVITY).toBe(MF.MF_NOGRAVITY); // 528 = SC|NG
    expect(m.tics).toBeGreaterThanOrEqual(1);
    expect(m.tics).toBeLessThanOrEqual(4); // 4 − P_R&3, clamp 1
    const z0 = m.z;
    const gridX = s.pmap.links.x[m.linkSlot]!;
    let tics = 0;
    while (!m.removed && tics < 64) {
      pRunThinkers(s.thinkers);
      tics++;
      expect(m.x).toBe(x0);
      expect(m.y).toBe(y0);
      expect(s.pmap.links.x[m.linkSlot]).toBe(gridX); // grid untouched
    }
    expect(m.removed, 'S_PUFF4.nextstate = S_NULL').toBe(true);
    expect(m.z).toBeGreaterThan(z0); // it rose
    expect(s.pmap.links.linked[m.linkSlot]).toBe(0);
    pRunThinkers(s.thinkers); // lazy unlink
    // M7-03: the fixture's PLAYER mobj thinker persists (arena lives);
    // the puff's own thinker is unlinked.
    expect(thinkerCount(s.thinkers)).toBe(1);
  });

  it('puff melee variant: attackrange == MELEERANGE ⇒ S_PUFF3 (no wall spark)', () => {
    const s = bootFixture([]);
    attackRange.value = MELEERANGE;
    const m = pSpawnPuff(s.mobjs, 100 << 16, 100 << 16, ONFLOORZ);
    expect(m.state).toBe(S.S_PUFF3);
    attackRange.value = MISSILERANGE;
    const m2 = pSpawnPuff(s.mobjs, 100 << 16, 100 << 16, ONFLOORZ);
    expect(m2.state).toBe(S.S_PUFF1);
  });

  it('blood: momz = 2*FRACUNIT, damage picks S_BLOOD2/3', () => {
    const s = bootFixture([]);
    const b10 = pSpawnBlood(s.mobjs, 100 << 16, 100 << 16, ONFLOORZ, 10);
    expect(b10.momz).toBe(2 * FRACUNIT);
    expect(b10.state).toBe(S.S_BLOOD2);
    const b5 = pSpawnBlood(s.mobjs, 100 << 16, 120 << 16, ONFLOORZ, 5);
    expect(b5.state).toBe(S.S_BLOOD3);
    const b20 = pSpawnBlood(s.mobjs, 100 << 16, 140 << 16, ONFLOORZ, 20);
    expect(b20.state).toBe(S.S_BLOOD1);
  });

  it('P_ExplodeMissile: deathstate + A_Explode stub recorded, tics clamp, MF_MISSILE cleared (grid mirror too)', () => {
    const s = bootFixture([]);
    const m = pSpawnMobj(s.mobjs, 100 << 16, 100 << 16, ONFLOORZ, MT.MT_ROCKET);
    m.momx = FRACUNIT;
    pExplodeMissile(m);
    expect(m.state).toBe(127); // S_ROCKETEXP1
    expect(m.momx).toBe(0);
    expect(m.tics).toBeGreaterThanOrEqual(1);
    expect(m.tics).toBeLessThanOrEqual(8);
    expect(m.flags & MF_MISSILE).toBe(0);
    expect(s.pmap.links.flags[m.linkSlot]).toBe(m.flags); // PIT sees the same
    expect(unimplementedActions().get('A_Explode')).toBe(1);
  });
});

/* ================================================================== */
/* 3. thinglinks round-trip: spawn/remove/move vs brute grid            */
/* ================================================================== */

describe('thinglinks round-trip via the mobj runtime (acceptance 3)', () => {
  /** grid cells → slot sets, recomputed from coords (brute force). */
  function bruteGrid(s: GameState): Map<number, number[]> {
    const { links } = s.pmap;
    const g = new Map<number, number[]>();
    for (let slot = 0; slot < links.nextDynamic; slot++) {
      if (!links.linked[slot]) continue;
      const cx = Math.floor((links.x[slot]! - links.bm.originX) / (128 * FRACUNIT));
      const cy = Math.floor((links.y[slot]! - links.bm.originY) / (128 * FRACUNIT));
      const cell = cy * links.bm.width + cx;
      const arr = g.get(cell) ?? [];
      arr.push(slot);
      g.set(cell, arr);
    }
    return g;
  }

  function chainGrid(s: GameState): Map<number, number[]> {
    const { links } = s.pmap;
    const g = new Map<number, number[]>();
    for (let cy = 0; cy < links.bm.height; cy++) {
      for (let cx = 0; cx < links.bm.width; cx++) {
        const cell = cy * links.bm.width + cx;
        const found: number[] = [];
        for (let slot = links.cellHead[cell]!; slot !== -1; slot = links.next[slot]!) found.push(slot);
        const end = links.blockStart[cell + 1]!;
        for (let k = links.blockStart[cell]!; k < end; k++) {
          if (links.linked[links.blockThings[k]!] === 1) found.push(links.blockThings[k]!);
        }
        if (found.length) g.set(cell, found);
      }
    }
    return g;
  }

  function assertGridMatchesBrute(s: GameState, note: string): void {
    const brute = bruteGrid(s);
    const chain = chainGrid(s);
    const bKeys = [...brute.keys()].sort((a, b) => a - b);
    expect([...chain.keys()].sort((a, b) => a - b), note).toEqual(bKeys);
    for (const k of bKeys) {
      expect([...chain.get(k)!].sort((a, b) => a - b), note).toEqual(
        [...brute.get(k)!].sort((a, b) => a - b),
      );
    }
  }

  it('spawn → linked, remove → unlinked; mover moves keep grid coords == mobj coords', () => {
    const s = bootFixture([{ x: 300, y: 300, angle: 0, type: 2035 }]);
    assertGridMatchesBrute(s, 'after load');
    // MT_PUFF is MF_NOBLOCKMAP in 1.10 — a mover that actually links.
    const mover = pSpawnMobj(s.mobjs, 64 << 16, 64 << 16, ONFLOORZ, MT.MT_TROOP);
    assertGridMatchesBrute(s, 'after dynamic spawn');

    // split-MAXMOVE: momx 40 units > 30 → the pmove split loop runs.
    mover.momx = 40 * FRACUNIT;
    pXYMovement(s.pmap, mover);
    assertGridMatchesBrute(s, 'after split-MAXMOVE');
    expect(s.pmap.links.x[mover.linkSlot]).toBe(mover.x);
    // momx clamps to MAXMOVE=30 FIRST (p_mobj.c:127-128) — the split loop
    // then covers the clamped 30-unit stride.
    expect(mover.x).toBeGreaterThan(64 * FRACUNIT + 29 * FRACUNIT);

    pRemoveMobj(mover);
    assertGridMatchesBrute(s, 'after remove');
    expect(s.pmap.links.linked[mover.linkSlot]).toBe(0);

    const barrel = liveMobjs(s.mobjs).find((m) => m.type === MT.MT_BARREL)!;
    expect(barrel.linkSlot).toBeLessThan(s.pmap.links.staticCount); // static binding
    expect(s.pmap.links.doomednum[barrel.linkSlot]).toBe(2035);
  });

  it('a mover mobj moving across cells re-links (link-only, order rule intact)', () => {
    const s = bootFixture([]);
    const m = pSpawnMobj(s.mobjs, 40 << 16, 250 << 16, ONFLOORZ, MT.MT_TROOP);
    for (let i = 0; i < 8; i++) {
      pTryMove(s.pmap, m, ((40 + i * 40) << 16) | 0, 250 << 16);
      assertGridMatchesBrute(s, `cross-cell ${i}`);
      expect(s.pmap.links.x[m.linkSlot]).toBe(m.x);
    }
  });
});

/* ================================================================== */
/* 4. pathTrace PT_ADDTHINGS vs a brute-force reference                 */
/* ================================================================== */

describe('PT_ADDTHINGS — thing intercepts (acceptance 4)', () => {
  it('planted dummies: same intercept set/order as a brute-force scan', () => {
    const s = bootFixture([
      { x: 120, y: 260, angle: 0, type: 2035 }, // static barrel ON the trace
      { x: 300, y: 244, angle: 0, type: 2035 }, // corners straddle y=250
    ]);
    // trace: (60,250) → (420,250) fixed-point
    const x1 = 60 << 16, y1 = 250 << 16, x2 = 420 << 16, y2 = 250 << 16;

    const got: { frac: number; thing: number }[] = [];
    const ok = pPathTraverse(
      s.map, s.pmap.bm, x1, y1, x2, y2, PT_ADDTHINGS,
      (i: Intercept) => { got.push({ frac: i.frac, thing: i.thing }); return true; },
      s.pmap.links,
    );
    expect(ok).toBe(true);

    // brute force: every linked slot, corner-to-corner crossection math
    const { links } = s.pmap;
    const trace = { x: x1, y: y1, dx: (x2 - x1) | 0, dy: (y2 - y1) | 0 };
    const tracepositive = (trace.dx ^ trace.dy) > 0;
    const ref: { frac: number; thing: number }[] = [];
    for (let slot = 0; slot < links.nextDynamic; slot++) {
      if (!links.linked[slot]) continue;
      const r = links.radius[slot]!;
      const tx1 = (links.x[slot]! - r) | 0;
      const tx2 = (links.x[slot]! + r) | 0;
      const ty1 = tracepositive ? (links.y[slot]! + r) | 0 : (links.y[slot]! - r) | 0;
      const ty2 = tracepositive ? (links.y[slot]! - r) | 0 : (links.y[slot]! + r) | 0;
      if (
        pointOnDivlineSide(tx1, ty1, trace) === pointOnDivlineSide(tx2, ty2, trace)
      ) continue;
      const dl = { x: tx1, y: ty1, dx: (tx2 - tx1) | 0, dy: (ty2 - ty1) | 0 };
      const frac = pInterceptVector(trace, dl);
      if (frac >= 0) ref.push({ frac, thing: slot });
    }
    ref.sort((a, b) => a.frac - b.frac); // fracs are distinct by construction

    expect(got.length, `dummies planted on the trace (ref=${ref.length})`).toBe(ref.length);
    expect(got.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < got.length; i++) {
      expect(got[i]!.thing).toBe(ref[i]!.thing);
      expect(got[i]!.frac).toBe(ref[i]!.frac);
    }
  });

  it('a dynamic mobj is hit too, and early-out stops the scan', () => {
    // MT_PUFF is MF_NOBLOCKMAP (never linked, vanilla) — use monsters.
    const s = bootFixture([]);
    const a = pSpawnMobj(s.mobjs, 100 << 16, 250 << 16, ONFLOORZ, MT.MT_TROOP);
    const b = pSpawnMobj(s.mobjs, 300 << 16, 250 << 16, ONFLOORZ, MT.MT_TROOP);
    expect(b.linkSlot).not.toBe(a.linkSlot);
    expect(s.pmap.links.linked[a.linkSlot]).toBe(1);
    const seen: number[] = [];
    const ok = pPathTraverse(
      s.map, s.pmap.bm, 60 << 16, 250 << 16, 420 << 16, 250 << 16, PT_ADDTHINGS,
      (i) => { seen.push(i.thing); return i.thing !== a.linkSlot ? true : false; },
      s.pmap.links,
    );
    void ok;
    expect(seen[0]).toBe(a.linkSlot); // first in frac order
    expect(seen.length).toBe(1); // early out before b
  });
});

/* ================================================================== */
/* 5. P_SpawnMapThing — census, skill matrix, doomednum round-trip      */
/* ================================================================== */

describe('P_SpawnMapThing / P_SpawnThings (acceptance: census + round-trip)', () => {
  it('fixture: things spawn in THINGS order bound 1:1 to static slots', () => {
    const s = bootFixture([
      { x: 100, y: 300, angle: 90, type: 2035 },
      { x: 140, y: 300, angle: 0, type: 3001 }, // trooper (COUNTKILL)
      { x: 180, y: 300, angle: 45, type: 2014 }, // raysuit? — item w/ ambush bit below
    ]);
    const live = liveMobjs(s.mobjs);
    const spawned = live.filter((m) => m.spawnpoint !== null);
    expect(spawned.length).toBe(3);
    expect(spawned.map((m) => m.linkSlot)).toEqual([0, 1, 2]);
    expect(s.pmap.links.thing[0]).toBe(1); // thing record indices (0 = player start)
    expect(spawned[1]!.type).toBe(MT.MT_TROOP);
    expect(spawned[0]!.angle).toBe(0x40000000 >>> 0); // 90° → ANG45 * (90/45)
    expect(s.mobjs.mobjs.length).toBe(4); // +1 = the player mobj (M7-03)
  });

  it('MTF_AMBUSH sets MF_AMBUSH (grid mirror too); skill bits filter', () => {
    const s = bootFixture([]);
    const m = pSpawnMapThing(s.mobjs, { x: 200, y: 200, angle: 0, type: 3001, options: 1 | 2 | 4 | 8 });
    expect(m!.flags & MF.MF_AMBUSH).not.toBe(0);
    expect(s.pmap.links.flags[m!.linkSlot]! & MF.MF_AMBUSH).not.toBe(0);
    // skill filter: bit 4 only, playing skill 1 (bit 1) ⇒ no spawn
    expect(pSpawnMapThing(s.mobjs, { x: 200, y: 220, angle: 0, type: 3001, options: 4 })).toBeUndefined();
    // solo bit (16) is skipped single-player
    expect(pSpawnMapThing(s.mobjs, { x: 200, y: 240, angle: 0, type: 3001, options: 15 | 16 })).toBeUndefined();
    // deathmatch starts are captured, never spawned
    expect(pSpawnMapThing(s.mobjs, { x: 1, y: 2, angle: 0, type: 11, options: 0 })).toBeUndefined();
    expect(s.mobjs.deathmatchStarts.length).toBe(1);
    // player starts captured, spawn owned by M5 stub / M7-03
    expect(pSpawnMapThing(s.mobjs, { x: 3, y: 4, angle: 0, type: 2, options: 0 })).toBeUndefined();
    expect(s.mobjs.playerStarts[1]).not.toBeNull();
    // unknown doomednum: counted skip (vanilla I_Error)
    expect(pSpawnMapThing(s.mobjs, { x: 5, y: 6, angle: 0, type: 9999, options: 15 })).toBeUndefined();
    expect(s.mobjs.skippedUnknown).toBe(1);
    expect(s.mobjs.unknownTypes).toEqual([9999]);
  });

  it('full-table doomednum → MT round-trip sweep (first-match scan semantics)', () => {
    const s = bootFixture([]);
    let i = 0;
    for (const [dn, mt] of [...DOOMEDNUM_TO_MT]) {
      if (isNetGameStartMarker(dn)) {
        // B-02/B-03 gate: netgame-start doomednums are captured, never
        // spawned (the table entry exists for the doomednum round-trip
        // only — DOOM.EXE's spawn switch intercepted them first).
        expect(pSpawnMapThing(s.mobjs, { x: 64 + (i % 12), y: 400 + (i % 7), angle: 0, type: dn, options: 15 }), `doomednum ${dn}`).toBeUndefined();
        continue;
      }
      const m = pSpawnMapThing(s.mobjs, { x: 64 + (i % 12), y: 400 + (i % 7), angle: 0, type: dn, options: 15 });
      expect(m, `doomednum ${dn}`).not.toBeUndefined();
      expect(m!.type, `doomednum ${dn}`).toBe(mt);
      i++;
    }
    expect(i).toBeGreaterThan(100); // the whole spawnable roster ran
  });

  it('spawn pass draws P_Random exactly: one lastlook per mobj + one tics jitter per animated spawn', () => {
    const s = bootFixture([
      { x: 100, y: 300, angle: 0, type: 2035 }, // tics 6 ⇒ jitter draw
      { x: 140, y: 300, angle: 0, type: 3001 }, // tics 10 ⇒ jitter draw
      { x: 180, y: 300, angle: 0, type: 14 }, // teleport dest, NOBLOCKMAP, tics −1
    ]);
    const spawned = liveMobjs(s.mobjs).filter((m) => m.spawnpoint !== null);
    expect(spawned.length).toBe(3);
    // gInitGame: mClearRandom() ⇒ prndindex 0 before pSpawnThings; one draw
    // per mobj (lastlook) + one per animated spawn (the 1+P_R%tics jitter).
    const animated = spawned.filter((m) => stateAt(mobjinfo[m.type]!.spawnState).tics > 0).length;
    expect(s.rng.prndindex).toBe(3 + animated);
  });

  it('ONFLOORZ/ONCEILINGZ resolve the LIVE sector heights', () => {
    const s = bootFixture([]);
    const px = 200 << 16;
    const sec = sectorAtPoint(s.map, px, px);
    s.sectors.floorZ[sec] = (s.sectors.floorZ[sec]! + 64 * FRACUNIT) | 0;
    const m = pSpawnMobj(s.mobjs, px, px, ONFLOORZ, MT.MT_BARREL);
    expect(m.z).toBe(s.sectors.floorZ[sec]);
    expect(m.floorz).toBe(s.sectors.floorZ[sec]);
    const c = pSpawnMobj(s.mobjs, (200 + 20) << 16, px, ONCEILINGZ, MT.MT_BARREL);
    expect(c.z).toBe((c.ceilingz - mobjinfo[MT.MT_BARREL]!.height) | 0);
    expect(s.pmap.links.z[c.linkSlot]).toBe(c.z);
  });

  describe.skipIf(!hasWad)('E1M1 census (freedoom1)', () => {
    it('per-doomednum counts + skill matrix + AMBUSH/DM bookkeeping', () => {
      const s = e1m1(2);
      const rt = s.mobjs;

      // brute spawn filter straight off the THINGS lump:
      const bitFor = (skill: Skill) => skillBit(skill);
      const countFor = (skill: Skill): number => {
        let n = 0;
        for (let i = 0; i < s.map.numThings; i++) {
          const t = mapThingAt(s.map, i);
          if (t.type <= 4 || t.type === 11) continue;
          if (isNetGameStartMarker(t.type)) continue; // captured, never spawned (B-02/B-03)
          if (t.flags & 16) continue; // solo
          if (!(t.flags & bitFor(skill))) continue;
          if (!DOOMEDNUM_TO_MT.has(t.type)) continue;
          n++;
        }
        return n;
      };
      expect(rt.mobjs.length).toBe(countFor(2) + 1); // +1 = player mobj (M7-03)
      for (const skill of [0, 1, 2, 3, 4] as Skill[]) {
        const g = e1m1(skill);
        expect(g.mobjs.mobjs.length, `skill ${skill}`).toBe(countFor(skill) + 1); // player
      }
      // monotone matrix sanity: baby ⊇ easy ⊇ normal ⊇ nightmare spawns… bits differ,
      // only assert the pinned normal count is in range and stable across double boot
      const again = e1m1(2);
      expect(again.mobjs.mobjs.length).toBe(rt.mobjs.length);

      // per-doomednum census: brute recount
      const brute = new Map<number, number>();
      for (let i = 0; i < s.map.numThings; i++) {
        const t = mapThingAt(s.map, i);
        if (t.type <= 4 || t.type === 11 || t.flags & 16 || !(t.flags & bitFor(2))) continue;
        if (isNetGameStartMarker(t.type)) continue; // captured, never spawned (B-02/B-03)
        if (!DOOMEDNUM_TO_MT.has(t.type)) {
          brute.set(t.type, (brute.get(t.type) ?? 0) + 1);
          continue;
        }
        brute.set(t.type, (brute.get(t.type) ?? 0) + 1);
      }
      const got = new Map<number, number>();
      for (const m of liveMobjs(rt)) {
        if (m.spawnpoint === null) continue;
        got.set(m.spawnpoint.type, (got.get(m.spawnpoint.type) ?? 0) + 1);
      }
      const sumBrute = [...brute.values()].reduce((a, b) => a + b, 0);
      const sumGot = [...got.values()].reduce((a, b) => a + b, 0);
      expect(sumGot + rt.skippedUnknown).toBe(sumBrute);
      // barrels + items present (the M7-02 grid fill in one glance)
      expect(got.get(2035) ?? 0).toBeGreaterThan(0);
      let specials = 0;
      for (const m of liveMobjs(rt)) if (m.flags & MF_SPECIAL) specials++;
      expect(specials).toBeGreaterThan(20); // E1M1 is not empty of items

      // AMBUSH: mobjs carrying MF_AMBUSH == brute count of ambush things spawned
      let ambush = 0;
      for (let i = 0; i < s.map.numThings; i++) {
        const t = mapThingAt(s.map, i);
        if (t.type <= 4 || t.type === 11) continue;
        if (isNetGameStartMarker(t.type)) continue; // never spawned (B-02/B-03)
        if (t.flags & 16 || !(t.flags & bitFor(2))) continue;
        if (!(t.flags & MTF_AMBUSH)) continue;
        if (DOOMEDNUM_TO_MT.has(t.type)) ambush++;
      }
      let ambushGot = 0;
      for (const m of liveMobjs(rt)) if (m.flags & MF.MF_AMBUSH) ambushGot++;
      expect(ambushGot).toBe(ambush);

      // deathmatch starts captured (capped), no player mobjs
      let dm = 0;
      for (let i = 0; i < s.map.numThings; i++) if (mapThingAt(s.map, i).type === 11) dm++;
      expect(rt.deathmatchStarts.length).toBe(Math.min(dm, 10));
      // M7-03: exactly ONE MT_PLAYER mobj in the roster — the player's
      // own (P_SpawnPlayer via the player-start thing, spawnpoint null:
      // it is NOT a thing spawn); no doomednum ever maps to MT_PLAYER.
      const playerMobjs = liveMobjs(rt).filter((m) => m.type === MT.MT_PLAYER);
      expect(playerMobjs.length).toBe(1);
      expect(playerMobjs[0]!.spawnpoint).toBeNull();
    });

    it('double-run E1M1 with mobjs: identical hash, mobj words hashed (§3.4)', () => {
      const a = e1m1(2);
      const b = e1m1(2);
      const h1 = runHeadless(a, 200);
      const h2 = runHeadless(b, 200);
      expect(h1).toBe(h2);
      // §3.4 payload check: every live mobj's words ARE its thinker words
      for (const m of liveMobjs(a.mobjs)) {
        expect(m.thinker.hashWords).toBe(m.words);
        const links = a.pmap.links;
        expect(m.words[0]).toBe(m.linkSlot >= 0 ? links.x[m.linkSlot] : m.x);
        expect(m.words[3]).toBe(m.state); // stateId
        expect(m.words[6]).toBe(m.health); // health
      }
      // mobjs in world state: ticking a state change moves the hash
      const before = hashState(a);
      const m = liveMobjs(a.mobjs).find((x) => x.spawnpoint === null) ?? liveMobjs(a.mobjs)[0]!;
      pSpawnMobj(a.mobjs, 128 << 16, 128 << 16, ONFLOORZ, MT.MT_PUFF);
      expect(hashState(a)).not.toBe(before);
      void m;
    });
  });
});

/* ================================================================== */
/* Thinker arena: order rule + lifecycle                                */
/* ================================================================== */

describe('mobj thinkers in the M6-01 arena', () => {
  it('mobj thinker ids are the first arena ids, in THINGS spawn order', () => {
    const s = bootFixture([
      { x: 100, y: 300, angle: 0, type: 2035 },
      { x: 140, y: 300, angle: 0, type: 3001 },
    ]);
    const ids = liveMobjs(s.mobjs)
      .filter((m) => m.spawnpoint !== null)
      .map((m) => m.thinker.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(Math.max(...ids)).toBe(ids.length); // specials would start at ids+1
  });

  it('removed mobjs leave the arena on the NEXT run (lazy sentinel), hashed-out at once', () => {
    const s = bootFixture([]);
    const m = pSpawnMobj(s.mobjs, 100 << 16, 100 << 16, ONFLOORZ, MT.MT_PUFF);
    const linked0 = s.thinkers.entries.size;
    const h0 = hashState(s);
    pRemoveMobj(m);
    // sentinel: still LINKED, but excluded from the live count + the hash
    expect(s.thinkers.entries.size).toBe(linked0);
    expect(thinkerCount(s.thinkers)).toBe(linked0 - 1);
    expect(hashState(s)).not.toBe(h0);
    pRunThinkers(s.thinkers); // vanilla: Z_Free at the visit
    expect(s.thinkers.entries.size).toBe(linked0 - 1);
  });

  it('mid-tic spawns tick NEXT tic (§3.2 deviation, specials rule inherited)', () => {
    const s = bootFixture([]);
    let duringRun: number | undefined;
    let spawnedDuring: Mobj | undefined;
    pAddThinker(s.thinkers, () => {
      // a thinker that spawns a mobj while the arena is walking
      spawnedDuring = pSpawnMobj(s.mobjs, 200 << 16, 200 << 16, ONFLOORZ, MT.MT_PUFF);
      duringRun = thinkerCount(s.thinkers);
    });
    pRunThinkers(s.thinkers);
    expect(spawnedDuring).not.toBeUndefined();
    // mid-run the new thinker sat in `pending`, not in the live count…
    expect(duringRun).toBe(2); // spawner + player mobj (M7-03)
    // …and after the merge it is live but UNticked this tic (tics untouched):
    expect(thinkerCount(s.thinkers)).toBe(3); // + player (M7-03)
    expect(spawnedDuring!.tics).toBe(stateAt(mobjinfo[MT.MT_PUFF]!.spawnState).tics);
  });

  it('P_RespawnSpecials is inert in single player; P_RemoveMobj still queues items', () => {
    const s = bootFixture([{ x: 100, y: 300, angle: 0, type: 2011 }]); // stimpack
    const item = liveMobjs(s.mobjs).find((m) => m.flags & MF.MF_SPECIAL)!;
    expect(item).not.toBeUndefined();
    pRemoveMobj(item);
    expect(s.mobjs.iquehead).toBe(1);
    expect(s.mobjs.itemQueTime[0]).toBe(s.leveltime);
    expect(s.mobjs.itemQue[0]!.type).toBe(2011);
    pRespawnSpecials(s.mobjs);
    expect(s.mobjs.iquehead).toBe(1); // queue untouched (deathmatch off)
    // MT_INV/MT_INS are NOT queued (p_mobj.c:553-555)
    const inv = pSpawnMobj(s.mobjs, 200 << 16, 200 << 16, ONFLOORZ, MT.MT_INV);
    pRemoveMobj(inv);
    expect(s.mobjs.iquehead).toBe(1);
  });
});

/* ================================================================== */
/* M8-02 — AI fields, flags, corpse friction, skullfly z-bounce        */
/* ================================================================== */

/** A[0..128] floor 0 | pit B[128..256] floor −8 (the pmove.test edge, now
 * booted through gInitGame so real mobjs live on it). */
const pitRoom: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128 },
    { x: 128, y: 0, w: 128, h: 128, floorHeight: -8 },
  ],
  things: [{ x: 32, y: 32, angle: 0, type: 1 }],
};

function bootPit(): GameState {
  const bytes = buildFixtureMapWad(pitRoom, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 2);
}

/** Dynamic-slot POSS parked at x=140 — box [120.5..160.5] straddles the
 * step linedef at x=128 ⇒ P_TryMove republishes floorz = 0 (room-A edge)
 * while the SUBSECTOR is the pit (floor −8): the p_mobj.c:207 "halfway
 * off a step" state (same construction as pmove.test's mover, M5-05). */
function edgePoss(s: GameState, extraFlags: number, yUnits = 64): Mobj {
  const m = pSpawnMobj(s.mobjs, (140 << 16) | 0, (yUnits << 16) | 0, 0, MT.MT_POSSESSED);
  m.z = 0; // z is a raw arg here (not ONFLOORZ): pit-floor spawn lifted to the step
  pSetMobjFlags(m, m.flags | extraFlags);
  m.momx = FRACUNIT;
  return m;
}

describe('M8-02 — AI fields + flags + hash word (M8-plan §M8-02)', () => {
  it('acceptance 1: movedir/movecount/damage exist, default DI_NODIR/0/mobjinfo-row', () => {
    expect(DI_NODIR).toBe(8); // p_enemy.c:50-64 dirtype_t DI_NODIR
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const barrel = liveMobjs(s.mobjs).find((m) => m.type === MT.MT_BARREL)!;
    expect(barrel.movedir).toBe(DI_NODIR);
    expect(barrel.movecount).toBe(0);
    expect(barrel.damage).toBe(mobjinfo[MT.MT_BARREL]!.damage); // 0
    const skull = pSpawnMobj(s.mobjs, 300 << 16, 300 << 16, ONFLOORZ, MT.MT_SKULL);
    expect(skull.movedir).toBe(DI_NODIR);
    expect(skull.movecount).toBe(0);
    expect(skull.damage).toBe(3); // info.c MT_SKULL damage row (§0.11)
    // 9th §3.4 word: movedir|movecount|damage, refreshed by syncMobj
    expect(skull.words.length).toBe(9);
    expect(skull.words[8]).toBe((DI_NODIR | 0 | 3) | 0);
    skull.movedir = 2;
    skull.movecount = 5;
    syncMobj(skull);
    expect(skull.words[8]).toBe((2 | 5 | 3) | 0);
  });

  it('M8-02 MF_* constants carry the exact p_mobj.h values', () => {
    expect([MF_AMBUSH, MF_JUSTHIT, MF_JUSTATTACKED, MF_CORPSE, MF_INFLOAT]).toEqual([
      32, 64, 128, 0x100000, 0x200000,
    ]);
    // parity with the mobjinfo.ts MF table (single source of truth)
    expect(MF.MF_AMBUSH).toBe(MF_AMBUSH);
    expect(MF.MF_JUSTHIT).toBe(MF_JUSTHIT);
    expect(MF.MF_JUSTATTACKED).toBe(MF_JUSTATTACKED);
    expect(MF.MF_CORPSE).toBe(MF_CORPSE);
    expect(MF.MF_INFLOAT).toBe(MF_INFLOAT);
  });

  it('acceptance 2: MF_CORPSE friction exemption — a corpse halfway off a step keeps sliding', () => {
    const s = bootPit();
    const corpse = edgePoss(s, MF_CORPSE, 48);
    pXYMovement(s.pmap, corpse);
    // move happened; floorz republished to the step (0) while the subsector
    // floor is −8 ⇒ p_mobj.c:207-220 returns BEFORE stop/friction
    expect(corpse.momx).toBe(FRACUNIT);
    expect(corpse.floorz).toBe(0);
    // control: identical state WITHOUT MF_CORPSE takes the friction
    // (own lane: the corpse mobj still sits at y=64 and would BLOCK it)
    const ctrl = edgePoss(s, 0, 96);
    pXYMovement(s.pmap, ctrl);
    expect(ctrl.momx).toBe(FixedMul(FRACUNIT, 0xe800)); // FRICTION decay
  });

  it('acceptance 3: MF_SKULLFLY z-bounce in P_ZMovement (p_mobj.c:246 floor hit)', () => {
    const s = bootFixture([]);
    const skull = pSpawnMobj(s.mobjs, 200 << 16, 200 << 16, ONFLOORZ, MT.MT_POSSESSED);
    pSetMobjFlags(skull, skull.flags | MF_SKULLFLY);
    skull.momz = -(2 * FRACUNIT);
    pZMovement(skull);
    expect(skull.momz).toBe(2 * FRACUNIT); // reversed, NOT zeroed (bounce)
    expect(skull.z).toBe(skull.floorz); // z still clipped to the floor
    // control without the flag: the floor hit swallows the momentum
    const plain = pSpawnMobj(s.mobjs, 200 << 16, 200 << 16, ONFLOORZ, MT.MT_POSSESSED);
    plain.momz = -(2 * FRACUNIT);
    pZMovement(plain);
    expect(plain.momz).toBe(0);
  });

  it('acceptance 4a: createMobjRuntime registers the slot→mobj resolver on the hook slots', () => {
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const barrel = liveMobjs(s.mobjs).find((m) => m.type === MT.MT_BARREL)!;
    expect(mobjFromSlot(s.mobjs, barrel.linkSlot)).toBe(barrel);
    expect(hooksMobjFromSlot(s.hooks, barrel.linkSlot)).toBe(barrel);
    expect(mobjFromSlot(s.mobjs, 9999)).toBeUndefined();
  });
});
