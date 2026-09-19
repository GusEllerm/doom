/**
 * sim/player tests — P_SpawnPlayer (p_mobj.c) coordinate/angle conversion,
 * the M5-06 mover-side player_t structure (single-source mover fields), and
 * the P_PlayerThink pieces that live on the player seam (noclip flag sync,
 * reactiontime gate, exact `angleturn << 16` BAM integration — bodies now in
 * sim/puser.ts, D009 closure).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { ANG45, ANG90, ANG180, ANG270, FRACUNIT } from '../core/constants';
import { angAdd } from '../core/fixed';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import { buildBlockMap } from './blockmap';
import { buildMapFromData } from './map';
import { pSpawnPlayer, createPlayer } from './player';
import {
  CF_NOCLIP,
  MF_NOCLIP,
  MF_NOGRAVITY,
  ONFLOORZ,
  PLAYER_FLAGS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  PST_LIVE,
  VIEWHEIGHT
} from './player';
import { buildThingLinks } from './thinglinks';
import { pPlayerThink } from './puser';
import { createTiccmd } from './ticcmd';

/* Small fixture world — pPlayerThink reads the map only for the sector
 * special check (dispatch itself is M6); physics needs no world at all. */
const FIX: RectMapSpec = { rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }] };

function fixWorld() {
  const bytes = buildFixtureMapWad(FIX);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const map = buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm);
  return { map, bm, links };
}

describe('pSpawnPlayer (p_mobj.c)', () => {
  it('converts thing units to fixed and degrees to BAM via ANG45*(deg/45)', () => {
    const cases: readonly [number, number][] = [
      [0, 0],
      [45, ANG45],
      [90, ANG90],
      [180, ANG180],
      [270, ANG270],
      [315, 0xe0000000 >>> 0],
      [-90, ANG270] // C: (unsigned)(ANG45 * -2) wraps to 0xC0000000
    ];
    for (const [deg, bam] of cases) {
      const p = createPlayer();
      pSpawnPlayer(p, { x: -416, y: 256, angle: deg, type: 1, flags: 7 });
      expect(p.mo.x, `x for deg=${deg}`).toBe((-416 << 16) | 0);
      expect(p.mo.y, `y for deg=${deg}`).toBe((256 << 16) | 0);
      expect(p.mo.x).toBe(-27262976);
      expect(p.mo.y).toBe(16777216);
      expect(p.mo.angle, `angle for deg=${deg}`).toBe(bam);
      expect(p.mo.angle >>> 0).toBe(bam); // u32-normalized, never negative
    }
  });

  it('sets spawn defaults: ONFLOORZ token, PST_LIVE, viewheight, health 100', () => {
    const p = createPlayer();
    pSpawnPlayer(p, { x: 128, y: 128, angle: 90, type: 1, flags: 7 });
    expect(p.mo.z).toBe(ONFLOORZ); // gInitGame resolves it (P_SpawnMobj tail)
    expect(p.playerstate).toBe(PST_LIVE);
    expect(p.viewheight).toBe(VIEWHEIGHT);
    expect(VIEWHEIGHT).toBe(41 * FRACUNIT);
    expect(p.health).toBe(100);
    expect(p.cmd).toEqual(createTiccmd());
  });

  it('M5-06: spawn clears momentum/mirrors/viewz for a fresh run', () => {
    const p = createPlayer();
    p.mo.momx = 12345;
    p.mo.momy = -6789;
    p.mo.momz = 42;
    p.viewheight = 7;
    p.deltaviewheight = 9;
    p.bob = 11;
    p.forwardmove = 5;
    p.sidemove = 6;
    pSpawnPlayer(p, { x: 0, y: 0, angle: 0, type: 1, flags: 7 });
    expect([p.mo.momx, p.mo.momy, p.mo.momz]).toEqual([0, 0, 0]);
    expect([p.viewheight, p.deltaviewheight, p.bob]).toEqual([VIEWHEIGHT, 0, 0]);
    expect([p.forwardmove, p.sidemove, p.viewz]).toEqual([0, 0, 0]);
  });
});

describe('Player/MobjStub mover structure (M5-06 single source of truth)', () => {
  it('MT_PLAYER geometry/flags from info.c: r16/h56, SOLID|SHOOTABLE|DROPOFF|PICKUP', () => {
    expect(PLAYER_RADIUS).toBe(16 * FRACUNIT);
    expect(PLAYER_HEIGHT).toBe(56 * FRACUNIT);
    expect(PLAYER_FLAGS).toBe(0x2 | 0x4 | 0x400 | 0x800);
    const p = createPlayer();
    expect([p.mo.radius, p.mo.height, p.mo.flags]).toEqual([
      PLAYER_RADIUS,
      PLAYER_HEIGHT,
      PLAYER_FLAGS
    ]);
  });

  it('mo.playerRef IS the player (mobj_t.player pointer), mover fields canonical', () => {
    const p = createPlayer();
    expect(p.mo.playerRef).toBe(p);
    expect(p.mo.player).toBe(true);
    expect(p.mo.linkSlot).toBe(-1); // gInitGame allocates the thinglinks slot
    expect(p.mo.reactiontime).toBe(0); // MT_PLAYER reactiontime 0 (info.c)
    // P_ZMovement writes the squat THROUGH mo.playerRef — same cells:
    p.mo.playerRef.deltaviewheight = -40960;
    expect(p.deltaviewheight).toBe(-40960);
  });
});

describe('pPlayerThink seams (p_user.c, bodies in puser.ts)', () => {
  it('syncs MF_NOCLIP + MF_NOGRAVITY from the CF_NOCLIP cheat bit every tic', () => {
    const w = fixWorld();
    const p = createPlayer();
    pPlayerThink(w, p, 0);
    expect(p.mo.flags & MF_NOCLIP).toBe(0);
    expect(p.mo.flags & MF_NOGRAVITY).toBe(0);
    p.cheats |= CF_NOCLIP;
    pPlayerThink(w, p, 0);
    expect(p.mo.flags & (MF_NOCLIP | MF_NOGRAVITY)).toBe(MF_NOCLIP | MF_NOGRAVITY);
    p.cheats = 0;
    pPlayerThink(w, p, 0);
    expect(p.mo.flags & (MF_NOCLIP | MF_NOGRAVITY)).toBe(0);
    // player base flags untouched by the sync
    expect(p.mo.flags & PLAYER_FLAGS).toBe(PLAYER_FLAGS);
  });

  it('applies mo.angle += cmd.angleturn << 16 with u32 wrap', () => {
    const w = fixWorld();
    const p = createPlayer();
    p.cmd = { ...createTiccmd(), angleturn: 640 };
    const before = p.mo.angle;
    pPlayerThink(w, p, 0);
    expect(p.mo.angle).toBe(angAdd(before, 640 << 16));
    expect(p.mo.angle).toBe(41943040);

    // negative (right key) wraps through zero: start just below 0-delta
    p.cmd = { ...createTiccmd(), angleturn: -640 };
    p.mo.angle = 1000;
    pPlayerThink(w, p, 0);
    expect(p.mo.angle).toBe((1000 + (-640 << 16)) >>> 0);
    expect(p.mo.angle).toBeGreaterThan(4e9);
  });

  it('refreshes the forwardmove/sidemove mirror every tic (p_mobj.c read path)', () => {
    const w = fixWorld();
    const p = createPlayer();
    p.mo.x = 128 << 16;
    p.mo.y = 128 << 16;
    p.cmd = { ...createTiccmd(), forwardmove: 50, sidemove: 24 };
    pPlayerThink(w, p, 0);
    expect([p.forwardmove, p.sidemove]).toEqual([50, 24]);
    expect(p.cmd.forwardmove).toBe(50); // command retained on the player too
  });

  it('reactiontime gates P_MovePlayer (teleport lockout)', () => {
    const w = fixWorld();
    const p = createPlayer();
    p.mo.reactiontime = 3;
    p.cmd = { ...createTiccmd(), angleturn: 640 };
    for (let i = 0; i < 3; i++) {
      pPlayerThink(w, p, i);
      expect(p.mo.angle).toBe(0); // frozen
    }
    expect(p.mo.reactiontime).toBe(0);
    pPlayerThink(w, p, 3); // gate open: now the angle integrates
    expect(p.mo.angle).toBe(640 << 16);
  });

  it('non-live players do not move-think (P_DeathThink is M7+)', () => {
    const w = fixWorld();
    const p = createPlayer();
    p.playerstate = 1; // PST_DEAD
    p.cmd = { ...createTiccmd(), angleturn: 640 };
    pPlayerThink(w, p, 0);
    expect(p.mo.angle).toBe(0);
  });
});
