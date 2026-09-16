/**
 * sim/player tests (M2-06) — P_SpawnPlayer coordinate/angle conversion
 * (p_mobj.c) and the P_PlayerThink skeleton (p_user.c): noclip flag sync,
 * reactiontime gate, exact `angleturn << 16` BAM integration.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { ANG45, ANG90, ANG180, ANG270, FRACUNIT } from '../core/constants';
import { angAdd } from '../core/fixed';

import {
  CF_NOCLIP,
  createPlayer,
  MF_NOCLIP,
  ONFLOORZ,
  pPlayerThink,
  pSpawnPlayer,
  PST_LIVE,
  VIEWHEIGHT
} from './player';
import { createTiccmd } from './ticcmd';

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
    expect(p.mo.z).toBe(ONFLOORZ);
    expect(p.playerstate).toBe(PST_LIVE);
    expect(p.viewheight).toBe(VIEWHEIGHT);
    expect(VIEWHEIGHT).toBe(41 * FRACUNIT);
    expect(p.health).toBe(100);
    expect(p.cmd).toEqual(createTiccmd());
  });
});

describe('pPlayerThink (p_user.c skeleton)', () => {
  it('syncs MF_NOCLIP from the CF_NOCLIP cheat bit every tic', () => {
    const p = createPlayer();
    pPlayerThink(p);
    expect(p.mo.flags & MF_NOCLIP).toBe(0);
    p.cheats |= CF_NOCLIP;
    pPlayerThink(p);
    expect(p.mo.flags & MF_NOCLIP).toBe(MF_NOCLIP);
    p.cheats = 0;
    pPlayerThink(p);
    expect(p.mo.flags & MF_NOCLIP).toBe(0);
  });

  it('applies mo.angle += cmd.angleturn << 16 with u32 wrap', () => {
    const p = createPlayer();
    p.cmd = { ...createTiccmd(), angleturn: 640 };
    const before = p.mo.angle;
    pPlayerThink(p);
    expect(p.mo.angle).toBe(angAdd(before, 640 << 16));
    expect(p.mo.angle).toBe(41943040);

    // negative (right key) wraps through zero: start just below 0-delta
    p.cmd = { ...createTiccmd(), angleturn: -640 };
    p.mo.angle = 1000;
    pPlayerThink(p);
    expect(p.mo.angle).toBe((1000 + (-640 << 16)) >>> 0);
    expect(p.mo.angle).toBeGreaterThan(4e9);
  });

  it('reactiontime gates P_MovePlayer (teleport lockout)', () => {
    const p = createPlayer();
    p.mo.reactiontime = 3;
    p.cmd = { ...createTiccmd(), angleturn: 640 };
    for (let i = 0; i < 3; i++) {
      pPlayerThink(p);
      expect(p.mo.angle).toBe(0); // frozen
    }
    expect(p.mo.reactiontime).toBe(0);
    pPlayerThink(p); // gate open: now the angle integrates
    expect(p.mo.angle).toBe(640 << 16);
  });

  it('momentum untouched in M2 (P_Thrust is M2-07)', () => {
    const p = createPlayer();
    p.cmd = { ...createTiccmd(), forwardmove: 50, sidemove: 24 };
    pPlayerThink(p);
    expect(p.mo.momX).toBe(0);
    expect(p.mo.momY).toBe(0);
    expect(p.mo.x).toBe(0);
    expect(p.mo.y).toBe(0);
    // ...but the command itself is retained on the player (d_player.h `cmd`)
    expect(p.cmd.forwardmove).toBe(50);
  });

  it('non-live players do not move-think (P_DeathThink placeholder)', () => {
    const p = createPlayer();
    p.playerstate = 1; // PST_DEAD
    p.cmd = { ...createTiccmd(), angleturn: 640 };
    pPlayerThink(p);
    expect(p.mo.angle).toBe(0);
  });
});
