/**
 * sim/ptelept.ts tests (M6-10, plan §M6-10) — EV_Teleport (p_telept.c) in
 * full: the two silent gates and their ORDER, the destination search order
 * (sector index outer / spawn order inner, sectors without a teleportman
 * skipped, *** NO candidate-retry loop ***), the telefrag damage slot
 * (player) vs the blocked move (monster), z = destination floor with NO
 * headroom test, the destination angle (including P_SpawnMapThing's `ANG45 *
 * (angle/45)` truncation and the "players keep no angle of their own" truth),
 * reactiontime 18 / viewz, the two MT_TFOG slot events + 2× sfx_telept, the
 * cross-side dispatch for 39/97/125/126 (use-side teleports do NOT exist in
 * 1.10), the skill gate on destination things, and double-run determinism.
 *
 * Source mirror: /tmp/DOOM-master/linuxdoom-1.10/p_telept.c (one function),
 * p_map.c:75-177 (P_TeleportMove/PIT_StompThing), p_mobj.c:708-780
 * (P_SpawnMapThing: skill gate + `ANG45 * (angle/45)`), info.c
 * (MT_TELEPORTMAN doomednum 14), sounds.h (sfx_telept).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { FRACUNIT, ANG45, ANG90 } from '../core/constants';
import { angToFine } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData } from './map';
import { sectorAtPoint } from './bsp';
import { gInitGame } from './game';
import { pTryMove } from './pmap';
import { hashState } from './state';
import type { GameState, Skill } from './state';
import { buildThingLinks, MF_MISSILE, MF_SOLID } from './thinglinks';
import { pTeleportMove, pmapHookCounts, resetPmapHookCounts } from './pmap';
import { resetHookSlots } from './hooks';
import {
  bindSpecialsWorld, pCrossSpecialLine, resetPcrossCounts
} from './pspec';
import { LINE_SPECIALS, resetUnimplementedSpecial } from './specials-table';
import { mapThingAt } from './map';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { M6_SCENES, THING_TELEPORT_DEST, LINE_TELEPORT_W1_MONSTER } from '../../tests/fixtures/m6Fixtures';

import {
  evTeleport,
  scanTeleportDest,
  teleportDestinations,
  teleportCounts,
  teleportFog,
  resetTeleportCounts,
  FOG_OFFSET,
  MT_TELEPORTMAN_DOOMEDNUM,
  SFX_TELEPT,
  TELEPORT_REACTIONTIME,
  type TeleportDestinations,
  type TeleportMover
} from './ptelept';

const fx = (u: number): number => (u * FRACUNIT) | 0;

function stateFor(spec: RectMapSpec, skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(spec);
  return gInitGame(
    buildMapFromData(loadMap(WadFile.parse(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer), 'FIXMAP')),
    skill
  );
}

/** A monster-ish mover: no player_t slice, not a player for PIT_StompThing. */
function monster(x = 0, y = 0, angle = 0): TeleportMover {
  return {
    x, y, z: 0, radius: fx(16), height: fx(56),
    flags: MF_SOLID, player: false, angle, momx: 1, momy: 1, momz: 1
  };
}

/** Any line of the map (teleport bodies read ONLY its tag + the caller's
 * side, so geometry is irrelevant to the unit tests). */
function anyLine(s: GameState): number {
  if (s.map.lines.count === 0) throw new Error('fixture map has no linedefs');
  return 0;
}

/** Arm `special`/`tag` on a line and bind the world for dispatch. */
function armTeleportLine(s: GameState, special: number, tag: number): number {
  const line = anyLine(s);
  s.map.lines.special[line] = special;
  s.map.lines.tag[line] = tag;
  bindSpecialsWorld(s);
  return line;
}

function secOf(s: GameState, ux: number, uy: number): number {
  return sectorAtPoint(s.map, fx(ux), fx(uy));
}

/** One destination room (tag 7, floor 64) + a source room; the destination
 * holds TWO teleportmen so the spawn-order pick is observable. */
const TWO_DESTS: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // source (tag 0)
    { x: 256, y: 0, w: 256, h: 256, tag: 7, floorHeight: 64 } // destination
  ],
  things: [
    { x: 64, y: 64, angle: 0, type: 1 },
    { x: 320, y: 128, angle: 90, type: THING_TELEPORT_DEST },
    { x: 448, y: 128, angle: 270, type: THING_TELEPORT_DEST }
  ]
};

beforeEach(() => {
  resetTeleportCounts();
  resetPcrossCounts();
  resetUnimplementedSpecial();
  resetPmapHookCounts();
});

function freshHooks(s: GameState): void {
  resetHookSlots(s.hooks);
}

/* ------------------------------------------------------------------ */
/* 1) The destination list (THINGS-derived stand-in for MT_TELEPORTMAN) */
/* ------------------------------------------------------------------ */

describe('teleport destination list', () => {
  it('collects doomednum 14 things in THINGS order with fixed coords + BAM angle', () => {
    const s = stateFor(TWO_DESTS);
    const d = teleportDestinations(s);
    expect(d.dests.length).toBe(2);
    expect(d.dests.map((t) => t.thingIndex)).toEqual([1, 2]);
    expect(d.dests[0]!.x).toBe(fx(320));
    expect(d.dests[0]!.y).toBe(fx(128));
    expect(d.dests[0]!.angle).toBe(ANG90);
    expect(d.dests[1]!.angle).toBe(Math.imul(ANG45, 270 / 45) >>> 0);
    expect(d.dests[0]!.sector).toBe(secOf(s, 384, 128));
    // both live in the SAME sector → firstInSector points at the FIRST.
    expect(d.firstInSector[d.dests[0]!.sector]).toBe(0);
    expect(d.firstInSector.filter((v) => v >= 0)).toHaveLength(1);
  });

  it('P_SpawnMapThing angle truncation: ANG45 * (angle/45), 30° → ANG0', () => {
    const s = stateFor({
      rooms: [{ x: 0, y: 0, w: 256, h: 256, tag: 5 }],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 128, y: 128, angle: 30, type: THING_TELEPORT_DEST },
        { x: 128, y: 192, angle: 315, type: THING_TELEPORT_DEST }
      ]
    });
    const d = teleportDestinations(s);
    expect(d.dests[0]!.angle).toBe(0); // 30/45 = 0 — the destination faces EAST
    expect(d.dests[1]!.angle).toBe(Math.imul(ANG45, 7) >>> 0); // 315 → ANG315
  });

  it('skill gate (p_mobj.c:744): a destination for another skill never exists', () => {
    const spec: RectMapSpec = {
      rooms: [{ x: 0, y: 0, w: 256, h: 256, tag: 5 }],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 128, y: 128, angle: 0, type: THING_TELEPORT_DEST, flags: 0x1 }
      ]
    };
    const easy = stateFor(spec, 1);
    expect(teleportDestinations(easy).dests).toHaveLength(1);
    const hard = stateFor(spec, 4);
    const d = teleportDestinations(hard);
    expect(d.dests).toHaveLength(0);
    expect(d.skippedSkill).toBe(1);
    // …and with no candidate the teleport silently fails.
    const line = armTeleportLine(hard, LINE_TELEPORT_W1_MONSTER, 5);
    expect(evTeleport(hard, line, 0, hard.players[0]!.mo)).toBe(false);
    expect(teleportCounts.noDestination).toBe(1);
  });

  // B-10 regression: sk_baby (internal skill 0) must read the bit-1 gate
  // (p_mobj.c:741 `if (gameskill == sk_baby) bit = 1;`). The old local
  // skillBit fell through to `1 << (0 - 1)` = `1 << -1` — JS masks the
  // shift mod 32 (1<<31, negative), so bit matched NOTHING and every
  // doomednum-14 destination silently vanished at Come get some!.
  it('skill 0 (sk_baby) reads the bit-1 gate (p_mobj.c:741) — no negative shift', () => {
    const spec: RectMapSpec = {
      rooms: [{ x: 0, y: 0, w: 256, h: 256, tag: 5 }],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 128, y: 128, angle: 0, type: THING_TELEPORT_DEST, flags: 0x1 }
      ]
    };
    const baby = stateFor(spec, 0);
    expect(teleportDestinations(baby).dests).toHaveLength(1);
    expect(teleportDestinations(baby).skippedSkill).toBe(0);
  });

  it('selection equivalence: firstInSector == the verbatim chain scan', () => {
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256, tag: 7 },
        { x: 512, y: 0, w: 256, h: 256, tag: 7 }
      ],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 560, y: 128, angle: 0, type: THING_TELEPORT_DEST },
        { x: 300, y: 128, angle: 0, type: THING_TELEPORT_DEST },
        { x: 620, y: 128, angle: 0, type: THING_TELEPORT_DEST }
      ]
    });
    const d = teleportDestinations(s);
    for (let i = 0; i < s.sectors.count; i++) {
      expect(d.firstInSector[i], `sector ${i}`).toBe(scanTeleportDest(d.dests, i));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2) EV_Teleport: gates, pick order, silent failures                   */
/* ------------------------------------------------------------------ */

describe('EV_Teleport gates and destination search', () => {
  it('MF_MISSILE gate runs BEFORE the side gate (both true → missile counted)', () => {
    const s = stateFor(TWO_DESTS);
    freshHooks(s);
    const mo = monster(0, 0);
    mo.flags = MF_SOLID | MF_MISSILE;
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 1, mo)).toBe(false);
    expect(teleportCounts.missileRejected).toBe(1);
    expect(teleportCounts.backSideRejected).toBe(0);
    expect(mo.x).toBe(0);
    expect(teleportFog.count).toBe(0);
    expect(s.hooks.sfx.count).toBe(0);
  });

  it('side == 1 (crossing from the back side) is a silent no-op', () => {
    const s = stateFor(TWO_DESTS);
    freshHooks(s);
    const mo = s.players[0]!.mo;
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 1, mo)).toBe(false);
    expect(teleportCounts.backSideRejected).toBe(1);
    expect(mo.x).toBe(fx(64)); // unchanged (P_SpawnPlayer position)
    expect(teleportFog.count).toBe(0);
  });

  it('teleports: position, z = destination floor, momentum zeroed, angle = dest angle', () => {
    const s = stateFor(TWO_DESTS);
    freshHooks(s);
    const mo = s.players[0]!.mo;
    mo.momx = fx(10);
    mo.momy = -fx(4);
    mo.momz = fx(3);
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(mo.x).toBe(fx(320)); // the FIRST teleportman in THINGS order
    expect(mo.y).toBe(fx(128));
    expect(mo.z).toBe(fx(64)); // thing->z = thing->floorz (destination floor)
    expect(mo.floorz).toBe(fx(64));
    expect(mo.momx).toBe(0);
    expect(mo.momy).toBe(0);
    expect(mo.momz).toBe(0);
    expect(mo.angle).toBe(ANG90);
    expect(teleportCounts.teleported).toBe(1);
  });

  it('a PLAYER keeps no angle of its own: angle := destination angle (verbatim)', () => {
    const s = stateFor({
      rooms: [{ x: 0, y: 0, w: 512, h: 256, tag: 9 }],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 384, y: 128, angle: 270, type: THING_TELEPORT_DEST }
      ]
    });
    const mo = s.players[0]!.mo;
    mo.angle = ANG90; // whatever angle the player had is DISCARDED
    const line = armTeleportLine(s, 97, 9);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(mo.angle).toBe(Math.imul(ANG45, 6) >>> 0); // 270°
  });

  it('reactiontime 18 + viewz = z + viewheight for players (mobj field, not player_t)', () => {
    const s = stateFor(TWO_DESTS);
    const p = s.players[0]!;
    p.viewz = 12345;
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, p.mo)).toBe(true);
    expect(p.mo.reactiontime).toBe(TELEPORT_REACTIONTIME);
    expect(p.viewz).toBe(fx(64) + p.viewheight);
  });

  it('reactiontime 18 is PLAYERS ONLY (`if (thing->player)` on the mobj field)', () => {
    const s = stateFor(TWO_DESTS);
    const mo = monster(fx(64), fx(64));
    mo.reactiontime = 7; // mobjinfo reactiontime (8 for monsters, info.c)
    const line = armTeleportLine(s, 97, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(mo.reactiontime).toBe(7); // untouched — the gate is `thing->player`
    expect(mo.momx).toBe(0); // momentum zeroing is NOT player-gated
    expect(teleportCounts.playerSliceMissing).toBe(0); // no player_t arm taken
  });

  it('two fog events: source at the OLD xyz, dest 20 units along the dest angle', () => {
    const s = stateFor(TWO_DESTS);
    freshHooks(s);
    const mo = s.players[0]!.mo;
    const old = { x: mo.x, y: mo.y, z: mo.z };
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(teleportFog.count).toBe(2);
    expect(teleportFog.entries.map((e) => e.at)).toEqual(['source', 'dest']);
    expect(teleportFog.entries[0]).toEqual({ ...old, at: 'source', tic: s.leveltime });
    const an = angToFine(ANG90);
    expect(teleportFog.entries[1]!.x).toBe((fx(320) + Math.imul(FOG_OFFSET, finecosine[an]!)) | 0);
    expect(teleportFog.entries[1]!.y).toBe((fx(128) + Math.imul(FOG_OFFSET, finesine[an]!)) | 0);
    expect(teleportFog.entries[1]!.z).toBe(fx(64));
    // S_StartSound(fog, sfx_telept) per fog — at the FOG positions.
    expect(s.hooks.sfx.count).toBe(2);
    expect(s.hooks.sfx.byId?.get(SFX_TELEPT)).toBe(2);
    expect(s.hooks.sfx.entries[0]!.x).toBe(old.x);
    expect(s.hooks.sfx.entries[1]!.x).toBe(teleportFog.entries[1]!.x);
  });

  it('sectors WITHOUT a teleportman are skipped; the pick is the lowest tagged ' +
    'sector index, then THINGS order (source truth: sectors outer / thinkers inner)', () => {
      const s = stateFor({
        rooms: [
          { x: 0, y: 0, w: 256, h: 256 }, // 1: source
          { x: 256, y: 0, w: 256, h: 256, tag: 7 }, // 2: tagged, EMPTY of dests
          { x: 512, y: 0, w: 256, h: 256, tag: 7, floorHeight: 32 } // 3: dest room
        ],
        things: [
          { x: 64, y: 64, angle: 0, type: 1 },
          { x: 320, y: 128, angle: 0, type: THING_TELEPORT_DEST, flags: 0 }, // never spawned
          { x: 700, y: 160, angle: 0, type: THING_TELEPORT_DEST }, // wins: first spawned here
          { x: 600, y: 64, angle: 0, type: THING_TELEPORT_DEST } // later THINGS record
        ]
      });
      // sector 2 has no spawnable teleportman → the search moves on to the
      // next tagged sector; inside it the FIRST thinker (THINGS order) wins.
      const mo = s.players[0]!.mo;
      const line = armTeleportLine(s, 97, 7);
      expect(evTeleport(s, line, 0, mo)).toBe(true);
      expect(mo.x).toBe(fx(700));
      expect(mo.y).toBe(fx(160));
      expect(mo.z).toBe(fx(32)); // that sector's floor
    });

  it('tag 0 is matched literally (no tag-0 fallback): the lowest tag-0 sector with a dest', () => {
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 }, // tag 0
        { x: 256, y: 0, w: 256, h: 256 } // tag 0 too
      ],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 320, y: 128, angle: 0, type: THING_TELEPORT_DEST },
        { x: 128, y: 128, angle: 0, type: THING_TELEPORT_DEST }
      ]
    });
    const mo = monster(fx(64), fx(64));
    const line = armTeleportLine(s, 97, 0);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    // (128,128) sits in sector 1 (the lower index) even though its THINGS
    // record is LATER — sector order beats spawn order.
    expect(mo.x).toBe(fx(128));
    expect(mo.y).toBe(fx(128));
  });

  it('NO candidate-retry loop: an occupied first candidate blocks the teleport ' +
    'even though a free one follows (verbatim `return 0`)', () => {
      const s = stateFor({
        rooms: [{ x: 0, y: 0, w: 512, h: 256, tag: 7 }],
        things: [
          { x: 64, y: 64, angle: 0, type: 1 },
          { x: 320, y: 128, angle: 0, type: THING_TELEPORT_DEST },
          { x: 320, y: 128, angle: 0, type: 2035 }, // barrel ON the first dest
          { x: 448, y: 128, angle: 0, type: THING_TELEPORT_DEST } // free
        ]
      });
      freshHooks(s);
      const mo = monster(fx(64), fx(64));
      const line = armTeleportLine(s, 97, 7);
      expect(evTeleport(s, line, 0, mo)).toBe(false);
      expect(teleportCounts.blocked).toBe(1);
      expect(teleportCounts.teleported).toBe(0);
      expect(mo.x).toBe(fx(64));
      expect(teleportFog.count).toBe(0);
      expect(s.hooks.sfx.count).toBe(0);
      // monsters never stomp (p_map.c:113) → no damage attempt at all
      expect(pmapHookCounts.telefrag).toBe(0);
      expect(s.hooks.damage.count).toBe(0);
    });

  it('silent fail: nothing tagged → no move, no fog, no sound', () => {
    const s = stateFor(TWO_DESTS); // dests exist but tag 42 matches nothing
    freshHooks(s);
    const mo = s.players[0]!.mo;
    const line = armTeleportLine(s, 39, 42);
    expect(evTeleport(s, line, 0, mo)).toBe(false);
    expect(teleportCounts.noDestination).toBe(1);
    expect(mo.x).toBe(fx(64));
    expect(teleportFog.count).toBe(0);
    expect(s.hooks.sfx.count).toBe(0);
  });

  it('live floors win: the z comes from the LIVE sector SoA, not the load copy', () => {
    const s = stateFor(TWO_DESTS);
    const dest = secOf(s, 384, 128);
    s.sectors.floorZ[dest] = fx(128);
    const mo = s.players[0]!.mo;
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(mo.z).toBe(fx(128));
  });
});

/* ------------------------------------------------------------------ */
/* 3) Telefrag (P_TeleportMove → PIT_StompThing → P_DamageMobj 10000)   */
/* ------------------------------------------------------------------ */

describe('telefrag', () => {
  const FRAG: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 512, h: 256, tag: 7 }],
    things: [
      { x: 64, y: 64, angle: 0, type: 1 },
      { x: 320, y: 128, angle: 0, type: THING_TELEPORT_DEST },
      { x: 320, y: 128, angle: 0, type: 2035 } // MF_SOLID|MF_SHOOTABLE occupant
    ]
  };

  it('player stomp: damage slot 10000 on the victim, move still succeeds', () => {
    const s = stateFor(FRAG);
    freshHooks(s);
    const mo = s.players[0]!.mo;
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(teleportCounts.telefrag).toBe(1);
    expect(teleportCounts.teleported).toBe(1);
    expect(s.hooks.damage.count).toBe(1);
    const e = s.hooks.damage.entries[0]!;
    expect(e.amount).toBe(10000);
    expect(e.source).toBe(mo.linkSlot); // inflictor == source == the teleporter
    const barrel = ((): number => {
      const L = s.pmap.links;
      for (let slot = 0; slot < L.staticCount; slot++) {
        if (L.x[slot] === fx(320) && L.y[slot] === fx(128)) return slot;
      }
      throw new Error('barrel slot not found');
    })();
    expect(e.thing).toBe(barrel);
    expect(mo.x).toBe(fx(320));
  });

  it('the damage slot is armed for teleport moves ONLY (other callers keep M5-04 no-op)', () => {
    const s = stateFor(FRAG);
    freshHooks(s);
    // A mover moved by pTeleportMove directly (no EV_Teleport) must keep
    // M5-04's documented default: the stomp is counted, the slot is NOT hit.
    expect(pTeleportMove(s.pmap, s.players[0]!.mo, fx(320), fx(128))).toBe(true);
    expect(pmapHookCounts.telefrag).toBe(1);
    expect(teleportCounts.telefragUnarmed).toBe(1);
    expect(s.hooks.damage.count).toBe(0);
    expect(evTeleport(s, armTeleportLine(s, 97, 7), 0, null)).toBe(false);
    expect(teleportCounts.noThing).toBe(1);
  });

  // M8-05: the second stomp no longer logs. PIT_StompThing (p_map.c:573-577)
  // starts with `if (!(tflags & MF_SHOOTABLE) && !(tflags & MF_MISSILE))
  // return true;` and the live P_DamageMobj body's P_KillMobj clears
  // MF_SHOOTABLE on the first stomp's death — so an already-dead occupant is
  // skipped instead of being stomped a second time (pre-M8-05 the flag write
  // never reached the ThingLinks mirror the trace reads).
  it('self-skip: a mover is never its own victim (a stomped corpse is skipped)', () => {
      const s = stateFor(FRAG);
      freshHooks(s);
      const mo = s.players[0]!.mo;
      const line = armTeleportLine(s, 97, 7);
      expect(evTeleport(s, line, 0, mo)).toBe(true);
      expect(evTeleport(s, line, 0, mo)).toBe(true); // same spot, self-skip
      expect(s.hooks.damage.count).toBe(1);
      for (const e of s.hooks.damage.entries) expect(e.thing).not.toBe(mo.linkSlot);
    });
});

/* ------------------------------------------------------------------ */
/* 4) No headroom / fit test inside P_TeleportMove                      */
/* ------------------------------------------------------------------ */

describe('destination geometry', () => {
  it('a 32-unit-high destination still moves (no ceiling fit test pre-clip)', () => {
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256, tag: 7, floorHeight: 0, ceilingHeight: 32 }
      ],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 320, y: 128, angle: 0, type: THING_TELEPORT_DEST }
      ]
    });
    const mo = s.players[0]!.mo; // height 56 > 32
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(mo.z).toBe(0);
    expect(mo.ceilingz).toBe(fx(32)); // written by P_TeleportMove, never compared
    expect(teleportCounts.blocked).toBe(0);
  });

  it('crossing a WALL is irrelevant: the teleport lands across the void', () => {
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 1024, y: 0, w: 256, h: 256, tag: 7, floorHeight: 16 } // unreachable
      ],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 1152, y: 128, angle: 0, type: THING_TELEPORT_DEST }
      ]
    });
    const mo = s.players[0]!.mo;
    const line = armTeleportLine(s, 39, 7);
    expect(evTeleport(s, line, 0, mo)).toBe(true);
    expect(mo.x).toBe(fx(1152));
    expect(mo.z).toBe(fx(16));
  });
});

/* ------------------------------------------------------------------ */
/* 5) Dispatch integration (cross side; 1.10 has NO use-side teleport)  */
/* ------------------------------------------------------------------ */

describe('special dispatch integration (39 / 97 / 125 / 126)', () => {
  const FIX: RectMapSpec = {
    rooms: [
      { x: 0, y: 0, w: 256, h: 256 },
      { x: 256, y: 0, w: 256, h: 256, tag: 31, floorHeight: 64 }
    ],
    things: [
      { x: 64, y: 64, angle: 0, type: 1 },
      { x: 320, y: 128, angle: 90, type: THING_TELEPORT_DEST }
    ]
  };

  it('39 W1: teleports and clears the special', () => {
    const s = stateFor(FIX);
    const line = armTeleportLine(s, 39, 31);
    const mo = s.players[0]!.mo;
    pCrossSpecialLine(s.pmap, line, 0, mo);
    expect(s.map.lines.special[line]).toBe(0);
    expect(mo.x).toBe(fx(320));
    expect(teleportCounts.teleported).toBe(1);
  });

  it('39 W1 clears even when the teleport itself fails (side-1 crossing)', () => {
    const s = stateFor(FIX);
    const line = armTeleportLine(s, 39, 31);
    const mo = s.players[0]!.mo;
    pCrossSpecialLine(s.pmap, line, 1, mo); // OLD side 1 → body rejects
    expect(teleportCounts.backSideRejected).toBe(1);
    expect(teleportCounts.teleported).toBe(0);
    expect(mo.x).toBe(fx(64));
    expect(s.map.lines.special[line]).toBe(0); // p_spec.c clears regardless
  });

  it('wired live: a REAL P_TryMove crossing (p_map.c spechit → P_CrossSpecialLine) teleports', () => {
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 },
        { x: 512, y: 0, w: 256, h: 256, tag: 31, floorHeight: 64 }
      ],
      triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 39, tag: 31 }],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 },
        { x: 640, y: 128, angle: 90, type: THING_TELEPORT_DEST }
      ]
    });
    bindSpecialsWorld(s);
    const mo = s.players[0]!.mo;
    // 24-unit steps: landing exactly ON the trigger (x=256) keeps side ==
    // oldside (no crossing), and a 32-unit jump to x=288 puts the r=16 bbox
    // [272,304] past the line's blockmap box (never spechit'd). x=264 is the
    // first landing with side != oldside AND a box that still touches x=256
    // (same spacing pin as pspec.test.ts's 244 → 268 pair).
    for (let x = 96; x <= 336; x += 24) {
      pTryMove(s.pmap, mo, fx(x), fx(128));
      if (teleportCounts.teleported > 0) break;
    }
    expect(teleportCounts.evTeleport).toBe(1);
    expect(teleportCounts.teleported).toBe(1);
    expect(mo.x).toBe(fx(640));
    expect(mo.y).toBe(fx(128));
    expect(mo.z).toBe(fx(64));
    expect(mo.angle).toBe(ANG90);
    expect(mo.reactiontime).toBe(TELEPORT_REACTIONTIME);
    expect(s.hooks.sfx.byId?.get(SFX_TELEPT)).toBe(2);
  });

  it('97 GR: keeps the special and teleports again on every crossing', () => {
    const s = stateFor(FIX);
    const line = armTeleportLine(s, 97, 31);
    const mo = s.players[0]!.mo;
    pCrossSpecialLine(s.pmap, line, 0, mo);
    pCrossSpecialLine(s.pmap, line, 1, mo); // side 1 → rejected, still armed
    pCrossSpecialLine(s.pmap, line, 0, mo);
    expect(s.map.lines.special[line]).toBe(97);
    expect(teleportCounts.teleported).toBe(2);
  });

  it('125 W1 monster-only: player no-ops (armed), monster teleports + clears', () => {
    const s = stateFor(FIX);
    const line = armTeleportLine(s, 125, 31);
    pCrossSpecialLine(s.pmap, line, 0, s.players[0]!.mo);
    expect(s.map.lines.special[line]).toBe(125);
    expect(teleportCounts.teleported).toBe(0);
    const mo = monster(fx(64), fx(64));
    pCrossSpecialLine(s.pmap, line, 0, mo);
    expect(mo.x).toBe(fx(320));
    expect(s.map.lines.special[line]).toBe(0);
  });

  it('126 GR monster-only: teleports for monsters, never clears, players never', () => {
    const s = stateFor(FIX);
    const line = armTeleportLine(s, 126, 31);
    pCrossSpecialLine(s.pmap, line, 0, s.players[0]!.mo);
    const mo = monster(fx(64), fx(64));
    pCrossSpecialLine(s.pmap, line, 0, mo);
    pCrossSpecialLine(s.pmap, line, 1, mo);
    expect(s.map.lines.special[line]).toBe(126);
    expect(teleportCounts.teleported).toBe(1); // the side-1 pass is rejected
    expect(teleportCounts.backSideRejected).toBe(1);
  });

  it('missile movers never teleport through the dispatcher (ok-list + gate)', () => {
    const s = stateFor(FIX);
    const line = armTeleportLine(s, 97, 31);
    const shot = monster(fx(64), fx(64));
    shot.flags = MF_SOLID | MF_MISSILE;
    pCrossSpecialLine(s.pmap, line, 0, shot);
    expect(shot.x).toBe(fx(64));
    expect(teleportCounts.evTeleport).toBe(0); // pspec.ts's missile filter first
    expect(teleportCounts.missileRejected).toBe(0);
  });

  it('registry truth: all four teleport ids are CROSS-side only (no use route)', () => {
    for (const id of [39, 97, 125, 126]) {
      const e = LINE_SPECIALS[id]!;
      expect(e.cross, `${id} cross`).toBeDefined();
      expect(e.use, `${id} use (p_switch.c has none)`).toBeUndefined();
      expect(e.cross!.actions.map((a) => a.action)).toEqual(['teleport']);
      expect(e.cross!.monsterOk).toBe(true);
    }
    expect(LINE_SPECIALS[39]!.cross!.clear).toBe(true);
    expect(LINE_SPECIALS[97]!.cross!.clear, 'GR entries omit the flag').toBeFalsy();
    expect(LINE_SPECIALS[125]!.cross!.clear).toBe(true);
    expect(LINE_SPECIALS[126]!.cross!.clear).toBeFalsy();
  });

  it('M6TELE fixture: 97 → tag 31 and 39/125 → tag 32 rooms, per the M6-02 map', () => {
    const s = stateFor(M6_SCENES.teleport);
    bindSpecialsWorld(s);
    let g97 = -1;
    let g39 = -1;
    for (let i = 0; i < s.map.lines.count; i++) {
      if (s.map.lines.special[i] === 97) g97 = i;
      if (s.map.lines.special[i] === 39) g39 = i;
    }
    expect(g97).toBeGreaterThan(-1);
    expect(g39).toBeGreaterThan(-1);
    const a = monster(fx(128), fx(128));
    pCrossSpecialLine(s.pmap, g97, 0, a);
    expect(a.x).toBe(fx(128)); // tag 31 room destination (128,384)
    expect(a.y).toBe(fx(384));
    expect(a.angle).toBe(ANG90);
    const b = monster(fx(128), fx(128));
    pCrossSpecialLine(s.pmap, g39, 0, b); // W1 monsterOk: monsters teleport
    expect(b.y).toBe(fx(384));
    expect(b.x).toBe(fx(384));
    expect(s.map.lines.special[g39]).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 6) Determinism + real-WAD parity                                     */
/* ------------------------------------------------------------------ */

function runTeleportScenario(): { hash: number; fog: number; sfx: number } {
  const s = stateFor(TWO_DESTS);
  const line = armTeleportLine(s, 97, 7);
  const mo = s.players[0]!.mo;
  for (let tic = 0; tic < 4; tic++) {
    if (tic === 1) pCrossSpecialLine(s.pmap, line, 0, mo);
    s.leveltime++;
  }
  return { hash: hashState(s), fog: teleportFog.count, sfx: s.hooks.sfx.count };
}

it('double-run determinism: identical hashes and identical fog/sfx counts', () => {
  const a = runTeleportScenario();
  resetTeleportCounts();
  const b = runTeleportScenario();
  expect(a.hash).toBe(b.hash);
  expect(a.fog).toBe(b.fog);
  expect(a.sfx).toBe(2);
});

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad destination parity', () => {
  it('the destination list matches an independent THINGS scan of E1M1', () => {
    const ab = readFileSync(WAD_PATH).buffer as ArrayBuffer;
    const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(ab), 'E1M1')));
    const d: TeleportDestinations = teleportDestinations(s);
    const raw: number[] = [];
    for (let i = 0; i < s.map.numThings; i++) {
      const t = mapThingAt(s.map, i);
      if (t.type === MT_TELEPORTMAN_DOOMEDNUM && (t.flags & 2) !== 0) raw.push(i);
    }
    expect(d.dests.map((x) => x.thingIndex)).toEqual(raw);
    for (const dest of d.dests) {
      const t = mapThingAt(s.map, dest.thingIndex)!;
      expect(dest.x).toBe((t.x << 16) | 0);
      expect(dest.angle).toBe(Math.imul(ANG45, Math.trunc(t.angle / 45)) >>> 0);
      expect(dest.sector).toBe(sectorAtPoint(s.map, dest.x, dest.y));
    }
    // the grid never receives teleportmen (MF_NOBLOCKMAP) — the destination
    // list is the ONLY place doomednum 14 exists in the sim.
    const links = buildThingLinks(s.map, s.pmap.bm, { skill: 2 });
    for (let slot = 0; slot < links.staticCount; slot++) {
      expect(links.doomednum[slot]).not.toBe(MT_TELEPORTMAN_DOOMEDNUM);
    }
  });
});
