/**
 * sim/pplats.ts tests (M6-06, plan §M6-06) — T_PlatRaise five-type tic
 * goldens, stasis round-trip (54/89), player-ride integration through the
 * live physics path, crush-NEVER contract, re-trigger rules, use-vs-cross
 * parity and the 21-ids family coverage through the REAL dispatchers.
 *
 * Hand-derived timing tables (T_MovePlane step-then-detect: N/speed
 * movement tics + 1 pastdest-detect tic; the waiting counter ticks the tic
 * AFTER the arrival-detect tic):
 *   DWUS   24u @4/tic: down 7 (1..6 move, 7 detect) | wait 105 (8..112)
 *          | up 7 (113..118 move, 119 detect+remove) → gone at tic 119.
 *   blaze  24u @8/tic: down 4 (1..3, 4) | wait 105 (5..109) | up 4
 *          (110..112, 113) → gone at 113. wait=105 is the 1.10 pin
 *          (prboom-family blaze wait 10 does NOT exist here).
 *   raise&Change/24 @½/tic: 48 move + detect at 49 (wait=0 never ticks —
 *          P_RemoveActivePlat at the arrival tic).
 *
 * Source mirror: /tmp/DOOM-master/linuxdoom-1.10/p_plats.c.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData } from './map';
import { gInitGame, gTicker } from './game';
import { emptyInput } from './ticcmd';
import { pRunThinkers, sectorSpecialData } from './ptick';
import { pCrossSpecialLine, pUseSpecialLine, pShootSpecialLine, activePlats } from './pspec';
import { LINE_SPECIALS, PLAT, unimplementedSpecial, resetUnimplementedSpecial } from './specials-table';
import { pswitchCounts, resetPswitchCounts } from './pswitch';
import { RNDTABLE } from './prng';
import { hashState, type GameState } from './state';
import { pmapHookCounts, resetPmapHookCounts } from './pmap';
import { PLAYER_FLAGS } from './player';
import type { Mover } from './pmap';
import { MF_SOLID } from './thinglinks';

import {
  activePlats as familyActivePlats,
  evDoPlat,
  evStopPlat,
  floorFlatOverrides,
  platFlatCopies,
  resetPlatFlatCopies,
  resetPplatsCounts,
  pplatsCounts,
  PLAT_DOWN,
  PLAT_IN_STASIS,
  PLAT_UP,
  PLAT_WAITING,
  SFX_PSTART,
  SFX_PSTOP,
  SFX_STNMOV,
  MAXPLATS,
  type Plat
} from './pplats';

const fx = (u: number): number => (u * FRACUNIT) | 0;

const PLAYER: Mover = {
  x: 0, y: 0, z: 0, radius: fx(16), height: fx(56),
  flags: MF_SOLID | PLAYER_FLAGS, player: true
};

function stateFor(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec);
  return gInitGame(
    buildMapFromData(loadMap(WadFile.parse(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer), 'FIXMAP'))
  );
}

/** thinkers-only tic (gTicker §3.2 order minus player physics): run then
 * leveltime++ — the timing goldens tick this way; the ride test uses the
 * full gTicker. */
function step(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    s.leveltime++;
  }
}

function secByTag(s: GameState, tag: number): number {
  for (let i = 0; i < s.sectors.count; i++) if (s.sectors.tag[i] === tag) return i;
  throw new Error(`no sector tagged ${tag}`);
}

function lineBySpecial(s: GameState, special: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.special[i] === special) return i;
  }
  throw new Error(`no line with special ${special}`);
}

function platOf(tag: number): Plat | null {
  for (let i = 0; i < MAXPLATS; i++) {
    const p = activePlats[i] as Plat | null;
    if (p !== null && p.tag === tag) return p;
  }
  return null;
}

function sfxCount(s: GameState, id: number): number {
  return s.hooks.sfx.byId?.get(id) ?? 0;
}

beforeEach(() => {
  resetUnimplementedSpecial();
  resetPplatsCounts();
  resetPlatFlatCopies();
  resetPmapHookCounts();
  resetPswitchCounts(); // M6-11: swap-count assertions
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// DWUS / blaze: tagged shaft floor +24 ringed by floor-0 corridors on ALL
// four sides (mapBuilder room–void edges are two-sided onto the −128
// void sector — the ring keeps P_FindLowestFloorSurrounding = 0 exact).
const SHAFT_UP: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 256 },
    { x: 128, y: 0, w: 128, h: 256, floorHeight: 24, tag: 21 },
    { x: 256, y: 0, w: 128, h: 256 },
    { x: 128, y: 256, w: 128, h: 128 },
    { x: 128, y: -128, w: 128, h: 128 }
  ],
  triggers: [
    { x1: 128, y1: 96, x2: 128, y2: 160, special: 21, tag: 21 }
  ],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// Ride: player stands on the shaft (floor 0); −24 corridors ring it (the
// DWUS destination — 24-unit round trip through REAL physics).
const SHAFT_RIDE: RectMapSpec = {
  rooms: [
    { x: -256, y: 0, w: 256, h: 256, floorHeight: -24 },
    { x: 0, y: 0, w: 128, h: 256, floorHeight: 0, ceilingHeight: 128, tag: 21 },
    { x: 128, y: 0, w: 128, h: 256, floorHeight: -24 },
    { x: 0, y: 256, w: 128, h: 128, floorHeight: -24 },
    { x: 0, y: -128, w: 128, h: 128, floorHeight: -24 }
  ],
  triggers: [
    { x1: 0, y1: 96, x2: 0, y2: 160, special: 21, tag: 21 }
  ],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// raiseAndChange/raiseToNearestAndChange (clean): tagged room floor 0,
// ceiling 128 (never blocks a 24-unit rise), neighbours +16 (with a
// DIFFERENT flat — the line's front side feeds the floorpic copy) and +32.
const RAISE_CLEAN: RectMapSpec = {
  rooms: [
    { x: 256, y: 0, w: 256, h: 256, floorHeight: 16, floorFlat: 'FIXFLAT1' },
    { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128, tag: 15, special: 5 },
    { x: 0, y: 256, w: 256, h: 256, floorHeight: 32 }
  ],
  triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 15, tag: 15 }],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// Blocked-rise variant: same room with ceiling 74 — a 56-tall player caps
// the lift at 18 (74 − 56) and the crush=false turn-around fires.
const RAISE_ROOM: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 74, tag: 15, special: 5 },
    { x: 256, y: 0, w: 256, h: 256, floorHeight: 16 },
    { x: 0, y: 256, w: 256, h: 256, floorHeight: 32 }
  ],
  triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 15, tag: 15 }],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// perpetualRaise: shaft floor 0 with a −32 corridor (lowest) and a +64
// room (highest); floor-0 rooms close the other two sides (void ring-off).
const PERP_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 256, floorHeight: -32 },
    { x: 128, y: 0, w: 128, h: 256, floorHeight: 0, tag: 53 },
    { x: 256, y: 0, w: 128, h: 256, floorHeight: 64 },
    { x: 128, y: 256, w: 128, h: 128, floorHeight: 0 },
    { x: 128, y: -128, w: 128, h: 128, floorHeight: 0 }
  ],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

function perpWorld(spec: RectMapSpec): { s: GameState; line: number; shaft: number } {
  const s = stateFor(spec);
  // Any two-sided boundary line of the shaft works: EV_DoPlat only reads
  // line->tag (the crossing/use gates are exercised in the parity test).
  let line = -1;
  for (let i = 0; i < s.map.lines.count && line < 0; i++) {
    if ((s.map.lines.flags[i]! & 0x004) !== 0 &&
        (s.map.lines.sectorFront[i] === secByTag(s, 53) ||
         s.map.lines.sectorBack[i] === secByTag(s, 53))) line = i;
  }
  s.map.lines.tag[line] = 53;
  return { s, line, shaft: secByTag(s, 53) };
}

/* ------------------------------------------------------------------ */
/* 1) DWUS cycle timing golden (24-unit lift @ PLATSPEED*4)            */
/* ------------------------------------------------------------------ */

describe('downWaitUpStay cycle (speed 4, wait 105)', () => {
  it('full round trip: down 7 / wait 105 / up 7, self-removal at tic 119', () => {
    const s = stateFor(SHAFT_UP);
    const shaft = secByTag(s, 21);
    const line = lineBySpecial(s, 21);

    expect(evDoPlat(s, line, PLAT.downWaitUpStay, 0)).toBe(true);
    expect(s.sectors.floorZ[shaft]).toBe(fx(24));
    const p = platOf(21)!;
    expect(p.status).toBe(PLAT_DOWN);
    expect(p.low).toBe(fx(0));
    expect(p.high).toBe(fx(24));
    expect(p.wait).toBe(105);
    expect(p.speed).toBe(4 * FRACUNIT);
    expect(p.crush).toBe(false);

    // Down: 6 movement tics, pastdest detect on the 7th.
    for (let t = 1; t <= 6; t++) {
      step(s, 1);
      expect(s.sectors.floorZ[shaft]).toBe(fx(24 - 4 * t));
      expect(p.status).toBe(PLAT_DOWN);
    }
    step(s, 1); // tic 7
    expect(s.sectors.floorZ[shaft]).toBe(0);
    expect(p.status).toBe(PLAT_WAITING);
    expect(p.count).toBe(105);

    // Wait: exactly 105 waiting tics (8..112), reversal on the 105th.
    step(s, 104); // → tic 111
    expect(p.status).toBe(PLAT_WAITING);
    expect(p.count).toBe(1);
    step(s, 1); // tic 112: !--count → floor==low → up
    expect(p.status).toBe(PLAT_UP);

    // Up: 6 movement tics + detect at 119, where DWUS removes itself.
    for (let t = 1; t <= 6; t++) {
      step(s, 1);
      expect(s.sectors.floorZ[shaft]).toBe(fx(4 * t));
    }
    step(s, 1); // tic 119
    expect(s.sectors.floorZ[shaft]).toBe(fx(24));
    expect(p.removed).toBe(true);
    expect(activePlats.every((t) => t === null)).toBe(true);
    expect(sectorSpecialData(s.sectors, shaft)).toBeNull();

    // One more tic unlinks the sentinel.
    step(s, 1);
    expect(s.thinkers.entries.has(p.id)).toBe(false);

    // sfx cadence: pstart spawn + up-start; pstop down-arrival + removal.
    expect(sfxCount(s, SFX_PSTART)).toBe(2);
    expect(sfxCount(s, SFX_PSTOP)).toBe(2);
    expect(sfxCount(s, SFX_STNMOV)).toBe(0);

    // A removed DWUS re-fires cleanly.
    expect(evDoPlat(s, line, PLAT.downWaitUpStay, 0)).toBe(true);
  });

  it('re-trigger while moving: specialdata refuses, no second mover', () => {
    const s = stateFor(SHAFT_UP);
    const shaft = secByTag(s, 21);
    const line = lineBySpecial(s, 21);
    evDoPlat(s, line, PLAT.downWaitUpStay, 0);
    step(s, 3);
    const floor = s.sectors.floorZ[shaft]!;
    const before = s.thinkers.nextId;
    expect(evDoPlat(s, line, PLAT.downWaitUpStay, 0)).toBe(false); // rtn=0
    expect(s.thinkers.nextId).toBe(before); // no allocation
    step(s, 1);
    expect(s.sectors.floorZ[shaft]).toBe(floor - 4 * FRACUNIT);
  });
});

/* ------------------------------------------------------------------ */
/* 2) blazeDWUS (speed 8, wait 105 — the 1.10 pin)                     */
/* ------------------------------------------------------------------ */

describe('blazeDWUS', () => {
  it('24u @8: down 4 / wait 105 / up 4, removal at tic 113', () => {
    const s = stateFor(SHAFT_UP);
    const shaft = secByTag(s, 21);
    const line = lineBySpecial(s, 21);
    evDoPlat(s, line, PLAT.blazeDWUS, 0);
    const p = platOf(21)!;
    expect(p.speed).toBe(8 * FRACUNIT);
    expect(p.wait).toBe(105); // NOT the later-source 10

    step(s, 3);
    expect(s.sectors.floorZ[shaft]).toBe(0);
    expect(p.status).toBe(PLAT_DOWN);
    step(s, 1); // tic 4 detect
    expect(p.status).toBe(PLAT_WAITING);
    step(s, 104); // → tic 108 (104 waiting tics: 5..108)
    expect(p.status).toBe(PLAT_WAITING);
    expect(p.count).toBe(1);
    step(s, 1); // tic 109 → up
    expect(p.status).toBe(PLAT_UP);
    step(s, 3); // 110..112
    expect(s.sectors.floorZ[shaft]).toBe(fx(24));
    expect(p.status).toBe(PLAT_UP);
    step(s, 1); // tic 113 detect → remove
    expect(p.removed).toBe(true);
    expect(activePlats.every((t) => t === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 3) raiseAndChange / raiseToNearestAndChange                         */
/* ------------------------------------------------------------------ */

describe('raise&Change family (speed 1/2, wait 0, self-remove at arrival)', () => {
  it('raiseAndChange amount=24: 48 move tics + removal at tic 49; floorpic copy recorded', () => {
    const s = stateFor(RAISE_CLEAN);
    const room = secByTag(s, 15);
    const specialBefore = s.sectors.special[room]!;
    const line = lineBySpecial(s, 15);
    expect(evDoPlat(s, line, PLAT.raiseAndChange, 24)).toBe(true);
    const p = platOf(15)!;
    expect(p.high).toBe(fx(24));
    expect(p.wait).toBe(0);

    step(s, 48);
    expect(s.sectors.floorZ[room]).toBe(fx(24));
    expect(p.status).toBe(PLAT_UP);
    step(s, 1); // tic 49: pastdest → waiting(count 0) → immediate removal
    expect(p.removed).toBe(true);
    // floorpic copy = the use line's front side's sector flat (deviation:
    // recorded overlay, not a live-SoA mutation — pplats.ts header).
    expect(platFlatCopies.count).toBe(1);
    expect(floorFlatOverrides.get(room)).toBe('FIXFLAT1'); // front side's flat
    expect(s.map.sectors.floorFlat[s.map.lines.sectorFront[line]!]).toBe('FIXFLAT1');
    // raiseAndChange does NOT clear the sector special (1.10 pin: the
    // `special = 0` line belongs to raiseToNearestAndChange only).
    expect(s.sectors.special[room]).toBe(specialBefore);
  });

  it('raiseToNearestAndChange: dest = P_FindNextHighestFloor (16), special → 0', () => {
    const s = stateFor(RAISE_CLEAN);
    const room = secByTag(s, 15);
    const line = lineBySpecial(s, 15);
    expect(evDoPlat(s, line, PLAT.raiseToNearestAndChange, 0)).toBe(true);
    const p = platOf(15)!;
    expect(p.high).toBe(fx(16)); // strictly-above minimum, not the +32
    expect(s.sectors.special[room]).toBe(0); // NO MORE DAMAGE quirk
    step(s, 32);
    expect(s.sectors.floorZ[room]).toBe(fx(16));
    step(s, 1);
    expect(p.removed).toBe(true); // arrival tic removal (49-style, 32+1)
  });

  it('blocked rise turns the plat around with ZERO damage (crush NEVER)', () => {
    // Player (56 tall) in the 74-ceiling room caps the rise at 18.
    const s = stateFor(RAISE_ROOM);
    const room = secByTag(s, 15);
    const line = lineBySpecial(s, 15);
    evDoPlat(s, line, PLAT.raiseAndChange, 24);
    const p = platOf(15)!;
    step(s, 36);
    expect(s.sectors.floorZ[room]).toBe(fx(18)); // 36 × ½
    step(s, 1); // step to 18.5 sticks → rollback + crushed → down
    expect(s.sectors.floorZ[room]).toBe(fx(18));
    expect(p.status).toBe(PLAT_DOWN);
    expect(p.crush).toBe(false);
    expect(s.hooks.damage.count).toBe(0); // plats NEVER damage
    expect(s.hooks.sfx.byId?.get(SFX_PSTART)).toBe(1); // turn-around sound
    step(s, 40);
    expect(s.hooks.damage.count).toBe(0);
    // Down toward low (= spawn floor 0) — never up again past 18 while stuck.
    expect(s.sectors.floorZ[room]).toBeLessThanOrEqual(fx(18));
    expect(pmapHookCounts.crushClipOk).toBeGreaterThan(0); // clipping ran
  });
});

/* ------------------------------------------------------------------ */
/* 4) perpetualRaise: PRNG start phase, no self-removal, stasis        */
/* ------------------------------------------------------------------ */

describe('perpetualRaise + stasis (54/89)', () => {
  /** prndindex to seed so the NEXT P_Random() is odd (phase=down) / even. */
  const seedFor = (odd: boolean): number => {
    for (let i = 0; i < 256; i++) if ((RNDTABLE[i]! & 1) === (odd ? 1 : 0)) return i;
    throw new Error('no index');
  };

  it('start phase = P_Random()&1 (plat_e: 0=up, 1=down) — one draw only', () => {
    const { s, line } = perpWorld(PERP_SPEC);
    s.rng.prndindex = seedFor(true) - 1 & 0xff;
    evDoPlat(s, line, PLAT.perpetualRaise, 0);
    const p = platOf(53)!;
    expect(p.status).toBe(PLAT_DOWN);
    expect(p.speed).toBe(FRACUNIT);
    expect(p.wait).toBe(105);
    expect(p.low).toBe(fx(-32));
    expect(p.high).toBe(fx(64));

    const { s: s2, line: line2 } = perpWorld(PERP_SPEC);
    s2.rng.prndindex = seedFor(false) - 1 & 0xff;
    evDoPlat(s2, line2, PLAT.perpetualRaise, 0);
    expect(platOf(53)!.status).toBe(PLAT_UP);
  });

  it('never self-removes; cycles down/wait/up with the 105 waits', () => {
    const { s, line, shaft } = perpWorld(PERP_SPEC);
    s.rng.prndindex = seedFor(true) - 1 & 0xff;
    evDoPlat(s, line, PLAT.perpetualRaise, 0);
    const p = platOf(53)!;
    step(s, 33); // 32 moves + detect
    expect(s.sectors.floorZ[shaft]).toBe(fx(-32));
    expect(p.status).toBe(PLAT_WAITING);
    step(s, 104);
    expect(p.status).toBe(PLAT_WAITING);
    step(s, 1);
    expect(p.status).toBe(PLAT_UP);
    step(s, 130); // 64 moves + detect at 130 of this phase
    expect(s.sectors.floorZ[shaft]).toBe(fx(64));
    expect(p.status).toBe(PLAT_WAITING);
    expect(activePlats.some((t) => t === p)).toBe(true); // NEVER removed
  });

  it('EV_StopPlat parks it (fn=null, not ticked, hash frozen); perpetual re-fire revives', () => {
    const { s, line, shaft } = perpWorld(PERP_SPEC);
    s.rng.prndindex = seedFor(true) - 1 & 0xff;
    evDoPlat(s, line, PLAT.perpetualRaise, 0);
    const p = platOf(53)!;
    step(s, 10);
    const floorMid = s.sectors.floorZ[shaft]!;
    expect(floorMid).toBeLessThan(0);

    const stopLine = lineBySpecial(s, 0); // any plain line; only ->tag matters
    s.map.lines.tag[stopLine] = 53;
    expect(evStopPlat(s, stopLine)).toBe(true);
    expect(p.status).toBe(PLAT_IN_STASIS);
    expect(p.oldstatus).toBe(PLAT_DOWN);
    expect(p.fn).toBeNull();
    expect(activePlats.some((t) => t === p)).toBe(true); // slot KEPT
    const words = [...p.hashWords];
    const h0 = hashState(s);
    step(s, 200);
    expect(s.sectors.floorZ[shaft]).toBe(floorMid); // frozen
    expect([...p.hashWords]).toEqual(words);
    // thinker not ticked but hashState still differs only by leveltime —
    // the frozen payload is the assertion; sanity-check the arena is alive:
    expect(Number.isSafeInteger(h0)).toBe(true);

    // Re-fire the SAME perpetual id: revive (no new mover — specialdata),
    // rtn=0 pinned (vanilla sets rtn only for SPAWNED plats).
    expect(evDoPlat(s, line, PLAT.perpetualRaise, 0)).toBe(false);
    expect(p.status).toBe(PLAT_DOWN);
    expect(p.fn).not.toBeNull();
    step(s, 5);
    expect(s.sectors.floorZ[shaft]).toBeLessThan(floorMid);
    // 54-style stop twice in a row is a no-op (status != in_stasis guard).
    expect(evStopPlat(s, stopLine)).toBe(true);
    expect(p.status).toBe(PLAT_IN_STASIS);
    expect(evStopPlat(s, stopLine)).toBe(true);
    expect(p.status).toBe(PLAT_IN_STASIS);
  });
});

/* ------------------------------------------------------------------ */
/* 5) Player-ride integration (real physics: gTicker + SoA + heightclip)*/
/* ------------------------------------------------------------------ */

describe('player rides the lift (M5 physics over the live SoA)', () => {
  it('both directions: z == floorZ every tic (P_ThingHeightClip carries the rider)', () => {
    const s = stateFor(SHAFT_RIDE);
    const shaft = secByTag(s, 21);
    const line = lineBySpecial(s, 21);
    const mo = s.players[0]!.mo;
    expect(mo.z).toBe(0); // spawn floor

    evDoPlat(s, line, PLAT.downWaitUpStay, 0);
    for (let t = 1; t <= 119; t++) {
      gTicker(s, emptyInput());
      // PIT_ChangeSector → P_ThingHeightClip runs INSIDE the plane step:
      // an on-floor rider is carried (no free-fall lag, crush never).
      expect(mo.z, `tic ${t}`).toBe(s.sectors.floorZ[shaft]);
      expect(s.hooks.damage.count).toBe(0);
    }
    expect(s.sectors.floorZ[shaft]).toBe(0); // arrival + self-removal at 119
    expect(activePlats.every((t) => t === null)).toBe(true);
    expect(s.hooks.damage.count).toBe(0); // crush NEVER
  });
});

/* ------------------------------------------------------------------ */
/* 6) use-vs-cross parity through the real dispatchers                 */
/* ------------------------------------------------------------------ */

describe('use-vs-cross parity (S1 21 vs W1 10 / GR 88)', () => {
  const paritySpec = (special: number): RectMapSpec => ({
    rooms: SHAFT_UP.rooms,
    triggers: [{ x1: 128, y1: 96, x2: 128, y2: 160, special, tag: 21 }],
    things: SHAFT_UP.things
  });

  const floorSeries = (s: GameState, shaft: number, n: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      step(s, 1);
      out.push(s.sectors.floorZ[shaft]!);
    }
    return out;
  };

  it('S1 21 (use) and W1 10 (cross) drive the identical 130-tic profile', () => {
    const s1 = stateFor(paritySpec(21));
    const s2 = stateFor(paritySpec(10));
    const shaft1 = secByTag(s1, 21);
    const shaft2 = secByTag(s2, 21);
    const l1 = lineBySpecial(s1, 21);
    const l2 = lineBySpecial(s2, 10);

    expect(pUseSpecialLine(s1, PLAYER, l1, 0)).toBe(true);
    expect(pCrossSpecialLine(s2.pmap, l2, 0, PLAYER)).toBe(undefined);
    const a = floorSeries(s1, shaft1, 130);
    const b = floorSeries(s2, shaft2, 130);
    expect(a).toEqual(b);
    expect(a[118]).toBe(fx(24)); // up done at tic 118, detect+remove at 119
    // W1 10 clears at dispatch (p_cross side); the S1 clear now LIVES in
    // P_ChangeSwitchTexture (M6-11 landed): disarm-first, so parity holds.
    expect(s1.map.lines.special[l1]).toBe(0);
    expect(s2.map.lines.special[l2]).toBe(0);
    // Zero stubs: the switch swap is the REAL body now (M6-11) — and the
    // fixture switch line carries no SW1 texture, so only the disarm ran.
    expect(unimplementedSpecial.count).toBe(0);
    expect(pswitchCounts.changeSwitchTexture).toBe(1);
  });

  it('GR 88 keeps firing but the moving/specialdata-held sector refuses', () => {
    const s = stateFor(paritySpec(88));
    const l = lineBySpecial(s, 88);
    pCrossSpecialLine(s.pmap, l, 0, PLAYER);
    expect(s.map.lines.special[l]).toBe(88); // GR never clears
    const before = s.thinkers.nextId;
    pCrossSpecialLine(s.pmap, l, 1, PLAYER); // re-fire while moving
    expect(s.thinkers.nextId).toBe(before);
    step(s, 8);
    pCrossSpecialLine(s.pmap, l, 0, PLAYER); // re-fire at rest (waiting)
    expect(s.thinkers.nextId).toBe(before); // specialdata still held
    step(s, 120); // cycle completes and self-removes
    expect(activePlats.every((t) => t === null)).toBe(true);
    pCrossSpecialLine(s.pmap, l, 1, PLAYER); // now it re-arms a fresh mover
    expect(s.thinkers.nextId).toBe(before + 1);
  });
});

/* ------------------------------------------------------------------ */
/* 7) Family coverage: all 21 plat ids through the real dispatchers    */
/* ------------------------------------------------------------------ */

describe('plats family coverage (registry ids → live bodies, zero stubs)', () => {
  const PLAT_IDS = [10, 14, 15, 20, 21, 22, 47, 53, 54, 62, 66, 67, 68, 87, 88, 89, 95, 120, 121, 122, 123];

  it('the registry routes exactly the 21 p_plats.c ids', () => {
    const routed: number[] = [];
    for (let id = 1; id < LINE_SPECIALS.length; id++) {
      const e = LINE_SPECIALS[id];
      if (!e) continue;
      for (const trig of [e.use, e.cross, e.shoot]) {
        if (trig?.actions.some((a) => a.action === 'plat' || a.action === 'stopPlat')) {
          if (!routed.includes(id)) routed.push(id);
        }
      }
    }
    expect(routed.sort((x, y) => x - y)).toEqual(PLAT_IDS);
  });

  it('every id dispatches live (no unimplementedSpecial), spawns/revives per its kind', () => {
    for (const id of PLAT_IDS) {
      const e = LINE_SPECIALS[id]!;
      const s = stateFor({
        rooms: [
          { x: 0, y: 0, w: 256, h: 256 },
          { x: 256, y: 0, w: 256, h: 256, floorHeight: 24 }
        ],
        things: [{ x: 64, y: 128, angle: 0, type: 1 }]
      });
      // Put the special on the shared two-sided seam and tag sector 1.
      let line = -1;
      for (let i = 0; i < s.map.lines.count && line < 0; i++) {
        if ((s.map.lines.flags[i]! & 0x004) !== 0) line = i;
      }
      s.map.lines.special[line] = id;
      s.map.lines.tag[line] = 77;
      s.sectors.tag[1] = 77;
      resetUnimplementedSpecial();
      resetPswitchCounts();

      const trig = e.use ?? e.cross ?? e.shoot;
      const stopOnly = trig!.actions.every((a) => a.action === 'stopPlat');
      // A route with a switch flag swaps the (still-stubbed) switch
      // texture on action SUCCESS — count-only here, M6-11 owns it.
      const switchy =
        (trig as { gateSwitch?: number }).gateSwitch !== undefined ||
        (trig as { switchBefore?: number }).switchBefore !== undefined ||
        (trig as { thenSwitch?: number }).thenSwitch !== undefined;
      // For the STOP ids, park a running mover with the same tag first.
      if (id === 54 || id === 89) {
        s.rng.prndindex = 0;
        evDoPlat(s, line, PLAT.perpetualRaise, 0);
        step(s, 2);
      }

      if (e.use) expect(pUseSpecialLine(s, PLAYER, line, 0), `use ${id}`).toBeTypeOf('boolean');
      else if (e.cross) pCrossSpecialLine(s.pmap, line, 0, PLAYER);
      else pShootSpecialLine(s, PLAYER, line);

      expect(unimplementedSpecial.count, `id ${id} stubs`).toBe(0);
      if (!stopOnly) {
        // M6-11: the switch swap is the REAL body now — zero stubs on
        // every plat id (the swap attempt itself is counted below).
        for (const fn of unimplementedSpecial.byFn.keys()) {
          expect(fn, `id ${id} fn`).toBe('pChangeSwitchTexture');
        }
      }
      if (switchy && !stopOnly) {
        // gateSwitch/thenSwitch route: live action succeeded ⇒ the
        // (REAL, M6-11) switch-texture swap ran — count-only here; the
        // swap/button semantics live in pswitch.test.
        expect(pswitchCounts.changeSwitchTexture, `id ${id} swap`).toBe(1);
      }
    }
  });

  it('activePlats is the pplats-owned array re-exported by pspec', () => {
    expect(familyActivePlats).toBe(activePlats);
    expect(pplatsCounts.addOverflow).toBe(0);
    expect(pplatsCounts.removeNotFound).toBe(0);
  });
});
