/**
 * sim/pdoors.ts tests (M6-05b re-land of M6-05, plan §M6-05) — step 1:
 * T_VerticalDoor through the SECTOR-SPECIAL SPAWNERS (10 close-in-30,
 * 14 raise-in-5-mins) + the direct state-machine arms.
 *
 * Hand-derived timing tables (T_MovePlane step-then-detect: N/speed
 * movement tics + 1 pastdest-detect tic; the wait countdown ticks the
 * tic it is decremented — `if (!--topcountdown)`):
 *   sector 10 (open slab ceiling 128 → floor 0 @2/tic):
 *     wait 1050 = 30*35 (tics 1..1050; at 1050 direction=-1 + sfx_dorcls)
 *     down 65 (1051..1114 move 128→0, 1115 detect + unlink).
 *   sector 14 (closed slab 0 → topheight 168 @2, ring ceiling 172−4):
 *     init-wait 10500 = 5*60*35 (at 10500 direction 2→1, type BECOMES
 *     normal, sfx_doropn) | up 85 (10501..10584 move, 10585 detect →
 *     top-wait 150) | wait 150 (10586..10735; at 10735 down + dorcls) |
 *     down 85 (10736..10819 move, 10820 detect + unlink).
 *
 * Source mirror: /tmp/DOOM-master/linuxdoom-1.10/p_doors.c:47-176,414-465.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData } from './map';
import { gInitGame } from './game';
import { pRunThinkers, sectorSpecialData, thinkerCount } from './ptick';
import { makePlaneContext } from './pplane';
import { resetUnimplementedSpecial, unimplementedSpecial, VL } from './specials-table';
import {
  pSpawnDoorCloseIn30,
  pSpawnDoorRaiseIn5Mins,
  VDOORSPEED,
  VDOORWAIT,
  DOORHOLD30,
  DOORCLOSE30WAIT,
  DOORRAISE5MIN,
  SFX_DOROPN,
  SFX_DORCLS,
  SFX_BDCLS,
  type Door
} from './pdoors';
import type { GameState } from './state';

const fx = (u: number): number => (u * FRACUNIT) | 0;

function stateFor(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec);
  return gInitGame(
    buildMapFromData(loadMap(WadFile.parse(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer), 'FIXMAP'))
  );
}

/** thinkers-only tic (pplats.test idiom). */
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

function doorOf(s: GameState, sec: number): Door {
  const d = sectorSpecialData(s.sectors, sec);
  if (d === null) throw new Error(`no door thinker on sector ${sec}`);
  return d as Door;
}

function sfxCount(s: GameState, id: number): number {
  return s.hooks.sfx.byId?.get(id) ?? 0;
}

beforeEach(() => {
  resetUnimplementedSpecial();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// Sector-10 door: slab sector ALREADY OPEN (ceiling 128 == surroundings),
// floor 0; ringed on all four sides (sealed ring keeps the geometry
// honest, the heights are the sector's own here).
const OPEN30: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 256 },
    { x: 128, y: 0, w: 128, h: 256, ceilingHeight: 128, special: 10, tag: 10 },
    { x: 256, y: 0, w: 128, h: 256 },
    { x: 128, y: 256, w: 128, h: 128 },
    { x: 128, y: -128, w: 128, h: 128 }
  ],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// Sector-14 door: slab CLOSED (floor 0, ceiling 0) under 172-high ring
// corridors → topheight = 172 − 4 = 168.
const RAISE5: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 256, ceilingHeight: 172 },
    { x: 128, y: 0, w: 128, h: 256, floorHeight: 0, ceilingHeight: 0, special: 14, tag: 14 },
    { x: 256, y: 0, w: 128, h: 256, ceilingHeight: 172 },
    { x: 128, y: 256, w: 128, h: 128, ceilingHeight: 172 },
    { x: 128, y: -128, w: 128, h: 128, ceilingHeight: 172 }
  ],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

/* ------------------------------------------------------------------ */
/* Spawner constants (p_spec.h / p_doors.c pins)                        */
/* ------------------------------------------------------------------ */

describe('pdoors constants', () => {
  it('VDOORSPEED=2·F, VDOORWAIT=150, 1050/1050/10500 waits', () => {
    expect(VDOORSPEED).toBe(2 * FRACUNIT);
    expect(VDOORWAIT).toBe(150);
    expect(DOORHOLD30).toBe(35 * 30);
    expect(DOORCLOSE30WAIT).toBe(30 * 35);
    expect(DOORRAISE5MIN).toBe(5 * 60 * 35);
  });
  it('sfxenum ids (sounds.h index-from-sfx_None=0)', () => {
    expect(SFX_DOROPN).toBe(20);
    expect(SFX_DORCLS).toBe(21);
    expect(SFX_BDCLS).toBe(89);
  });
});

/* ------------------------------------------------------------------ */
/* P_SpawnDoorCloseIn30 — sector special 10                             */
/* ------------------------------------------------------------------ */

describe('P_SpawnDoorCloseIn30 (sector 10, plan acceptance 3 boundary)', () => {
  const s = stateFor(OPEN30);
  const sec = secByTag(s, 10);

  it('spawns WAITING normal door; special cleared by the load pass', () => {
    const d = doorOf(s, sec);
    expect(d.direction).toBe(0);
    expect(d.type).toBe(VL.normal);
    expect(d.speed).toBe(VDOORSPEED);
    expect(d.topcountdown).toBe(1050);
    expect(s.sectors.special[sec]).toBe(0);
  });

  it('timing: wait 1..1050, down 1051..1114, unlink at 1115', () => {
    step(s, 1049);
    expect(doorOf(s, sec).direction, 't=1049 still waiting').toBe(0);
    expect(s.leveltime).toBe(1049);
    step(s, 1); // t=1050: countdown hits 0 → DOWN + sfx_dorcls
    expect(doorOf(s, sec).direction).toBe(-1);
    expect(sfxCount(s, SFX_DORCLS), 'dorcls at the 1050 boundary').toBe(1);
    step(s, 64); // t=1114: 64 moves 128 → 0
    expect(s.sectors.ceilingZ[sec]).toBe(0);
    expect(sectorSpecialData(s.sectors, sec), 'still alive at 1114').not.toBeNull();
    step(s, 1); // t=1115: pastdest-down → unlink
    expect(sectorSpecialData(s.sectors, sec)).toBeNull();
    expect(thinkerCount(s.thinkers), 'sentinel not counted').toBe(0);
    const size = s.thinkers.entries.size;
    step(s, 1); // the lazy sentinel unlinks at the next visit
    expect(s.thinkers.entries.size).toBe(size - 1);
  });

  it('sector special 10 spawn is NOT a stub record (M6-13 flip)', () => {
    resetUnimplementedSpecial();
    stateFor(OPEN30);
    expect(unimplementedSpecial.count).toBe(0);
    expect(unimplementedSpecial.bySector[10]).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* P_SpawnDoorRaiseIn5Mins — sector special 14                          */
/* ------------------------------------------------------------------ */

describe('P_SpawnDoorRaiseIn5Mins (sector 14, plan acceptance 3 boundary)', () => {
  const s = stateFor(RAISE5);
  const sec = secByTag(s, 14);

  it('spawns INITIAL-WAIT (direction 2) door, topheight = 172−4', () => {
    const d = doorOf(s, sec);
    expect(d.direction).toBe(2);
    expect(d.type).toBe(VL.raiseIn5Mins);
    expect(d.topheight).toBe(fx(168));
    expect(d.topwait).toBe(VDOORWAIT);
    expect(d.topcountdown).toBe(10500);
  });

  it('timing: 10500 init | up 85 | wait 150 | down 85 (hashed boundaries)', () => {
    step(s, 10499);
    expect(doorOf(s, sec).direction, 't=10499').toBe(2);
    step(s, 1); // t=10500: UP, type becomes normal
    const d = doorOf(s, sec);
    expect(d.direction).toBe(1);
    expect(d.type, 'raiseIn5Mins → normal').toBe(VL.normal);
    expect(sfxCount(s, SFX_DOROPN)).toBe(1);
    step(s, 83); // t=10583: 83 moves → 166
    expect(s.sectors.ceilingZ[sec]).toBe(fx(166));
    step(s, 1); // t=10584: move → 168
    expect(s.sectors.ceilingZ[sec]).toBe(fx(168));
    step(s, 1); // t=10585: pastdest-up → WAIT 150
    expect(doorOf(s, sec).direction).toBe(0);
    expect(doorOf(s, sec).topcountdown).toBe(150);
    step(s, 149); // t=10734
    expect(doorOf(s, sec).direction).toBe(0);
    step(s, 1); // t=10735: countdown 0 → DOWN + dorcls
    expect(doorOf(s, sec).direction).toBe(-1);
    expect(sfxCount(s, SFX_DORCLS)).toBe(1);
    step(s, 84); // t=10819: 84 moves → floor
    expect(s.sectors.ceilingZ[sec]).toBe(0);
    step(s, 1); // t=10820: pastdest-down → unlink
    expect(sectorSpecialData(s.sectors, sec)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* T_VerticalDoor — direct state-machine arms (blaze + close30 wait     */
/* expiry, initial-wait default, hashWords)                             */
/* ------------------------------------------------------------------ */

describe('T_VerticalDoor state-machine arms (direct)', () => {
  // Fresh OPEN30-style state; the spawner bodies are the ONLY sanctioned
  // door constructors, so arms are set on the spawned payload (the
  // thinker closure is the real T_VerticalDoor).
  function armed(): { s: GameState; sec: number; d: Door } {
    const s = stateFor(OPEN30);
    const sec = secByTag(s, 10);
    pSpawnDoorCloseIn30(s, sec); // second thinker (same sector ref)
    const d = doorOf(s, sec);
    d.type = VL.normal; // reset the spawner's payload for arm tests
    d.topcountdown = 0;
    return { s, sec, d };
  }

  it('WAITING: blazeRaise expiry → DOWN + sfx_bdcls', () => {
    const { s, d } = armed();
    d.type = VL.blazeRaise;
    d.direction = 0;
    d.topcountdown = 2;
    pRunThinkers(s.thinkers); s.leveltime++;
    expect(d.direction).toBe(0);
    pRunThinkers(s.thinkers); s.leveltime++;
    expect(d.direction).toBe(-1);
    expect(sfxCount(s, SFX_BDCLS)).toBe(1);
  });

  it('WAITING: close30ThenOpen expiry → UP + sfx_doropn', () => {
    const { s, d } = armed();
    d.type = VL.close30ThenOpen;
    d.direction = 0;
    d.topcountdown = 1;
    pRunThinkers(s.thinkers); s.leveltime++;
    expect(d.direction).toBe(1);
    expect(sfxCount(s, SFX_DOROPN)).toBe(1);
  });

  it('WAITING: normal expiry → DOWN + sfx_dorcls; unknown type: nothing', () => {
    const { s, d } = armed();
    d.direction = 0;
    d.topcountdown = 1;
    pRunThinkers(s.thinkers); s.leveltime++;
    expect(d.direction).toBe(-1);
    expect(sfxCount(s, SFX_DORCLS)).toBe(1);
    d.direction = 0;
    d.type = 99; // out-of-enum: `default: break`
    d.topcountdown = 1;
    pRunThinkers(s.thinkers); s.leveltime++;
    expect(d.direction).toBe(0);
  });

  it('INITIAL WAIT: only raiseIn5Mins reacts (direction 2, other types idle)', () => {
    const { s, d } = armed();
    d.direction = 2;
    d.type = VL.normal;
    d.topcountdown = 1;
    pRunThinkers(s.thinkers); s.leveltime++;
    expect(d.direction, 'normal never leaves initial wait').toBe(2);
  });

  it('hashWords carry the payload (ARCHITECTURE §3.4)', () => {
    const { s, d } = armed();
    d.topheight = fx(168);
    d.speed = VDOORSPEED;
    d.direction = 1;
    d.topwait = VDOORWAIT;
    d.topcountdown = 7;
    pRunThinkers(s.thinkers); // the thinker fn syncs its words
    expect(d.hashWords.length).toBe(7);
    expect(d.hashWords[0]).toBe(d.sector);
    expect(d.hashWords[3]).toBe(d.direction);
  });
});

/* pmap/thing-crush arms are covered with the EV_* bodies (step 2). */

/* makePlaneContext sanity: a state satisfies PlaneHost (contract probe). */
it('GameState satisfies PlaneHost (pplane contract)', () => {
  const s = stateFor(RAISE5);
  expect(() => makePlaneContext(s)).not.toThrow();
  expect(() => pSpawnDoorRaiseIn5Mins(s, secByTag(s, 14), 1)).not.toThrow();
});
