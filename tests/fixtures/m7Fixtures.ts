/**
 * M7-10 — weapon-suite fixture maps (docs/design/M7-plan.md §M7-10:
 * "fixture maps (tests/fixtures/m7Fixtures.ts: firing range with dummies,
 * pickup loop, hazard+ironfeet room)").
 *
 * Every fixture is a `RectMapSpec` (tests/fixtures/mapBuilder.ts) so the
 * whole L2 corpus stays wad-free and byte-deterministic:
 *
 *  - WEAPON RANGE (`weaponRangeSpec`): one bright 512×512 room, player 1
 *    start at (128,128) facing EAST (angle 0), dummy shootables planted on
 *    the x-axis at known unit spots. Dummies are real map things so they
 *    spawn through P_SpawnMapThing in THINGS order (arena order = the
 *    blessed M7-02 rule); tests raise health via the live-mobj seam to
 *    keep the barrel-explode / death paths out of the measured window.
 *
 *  - STREAM ARENA (`streamArenaSpec`): the M7-10 §2 shared-stream arena —
 *    firing room A with a FLICKERING-LIGHT sector special 1 (P_Random per
 *    flasher flip — the ONE steady-drawing mover class) and an inert
 *    zombie dummy; a USE-RAISED DOOR sector B (closed: floor = ceiling =
 *    0, tag 665) directly NORTH of the start, its y-512 gap line carrying
 *    the regular-door special 1 (the mover load: open-wait-close tics);
 *    room C north of the door with a clip pickup and a W1-TELEPORT line
 *    (special 39, tag 666) on the B/C edge; the teleportman (thing 14)
 *    lands the player back in C facing SOUTH at x = 224, exactly on the
 *    zombie axis, so the rest of the run fires (and eventually ammo-dumps
 *    into the P_CheckAmmo fist ladder) while walking. One scripted 500-tic
 *    run therefore interleaves FIRE + PICKUP + DOOR + FLICKER + TELEPORT
 *    on the ONE shared P stream.
 *
 *  - HAZARD ROOM (`hazardRoomSpec`): sector special 5 (HELLSLIME, 10 per
 *    feet pass) for the invuln/ironfeet damage-rule shots.
 *
 * The visual pack (tests/weapons/visual.test.ts) boots its own
 * sprite-complete wad; these maps carry no graphics requirements.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { RectMapSpec, ThingSpec } from './mapBuilder';

/** Fixed-point unit shorthand (specs use map units). */
export const RANGE_PLAYER_X = 128;
export const RANGE_PLAYER_Y = 128;

/** Doom1 thing numbers used by the suites (p_spawn.h doomednums). */
export const THING_PLAYER1 = 1;
export const THING_BARREL = 2035; // MT_BARREL: MF_SHOOTABLE|MF_NOBLOOD, hp 20
export const THING_ZOMBIE = 3004; // MT_POSSESSED: MF_SHOOTABLE, hp 20
export const THING_CLIP = 2048; // MF_SPECIAL clip (AM_CLIP +1 load)
export const THING_TELEPORT_DEST = 14; // MT_TELEPORTMAN (no flags)

export const STREAM_TAG_DOOR = 665;
export const STREAM_TAG_TELE = 666;

export interface DummySpec {
  readonly x?: number; // default 256 (128 units down the eye line)
  readonly y?: number;
  readonly type?: number; // default barrel
}

/** One bright 512×512 room; player 1 at (128,128) angle 0 (EAST); dummies
 * default to a barrel at (256,128). */
export function weaponRangeSpec(dummies: readonly DummySpec[] = [{}]): RectMapSpec {
  const things: ThingSpec[] = [
    { x: RANGE_PLAYER_X, y: RANGE_PLAYER_Y, angle: 0, type: THING_PLAYER1 }
  ];
  for (const d of dummies) {
    things.push({
      x: d.x ?? 256,
      y: d.y ?? RANGE_PLAYER_Y,
      angle: 0,
      type: d.type ?? THING_BARREL
    });
  }
  return {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 160, ceilingHeight: 128 }],
    things
  };
}

/* ------------------------------------------------------------------ */
/* Shared-stream arena (acceptance 2)                                  */
/* ------------------------------------------------------------------ */

/** Player start / axes (see header). */
export const STREAM_PLAYER = { x: 224, y: 460, angle: 90 } as const;
export const STREAM_ZOMBIE = { x: 224, y: 384 } as const;
export const STREAM_CLIP = { x: 224, y: 600 } as const;
export const STREAM_TELE_DEST = { x: 224, y: 704, angle: 270 } as const;

export function streamArenaSpec(opts: { flicker?: boolean } = {}): RectMapSpec {
  const flicker = opts.flicker !== false;
  return {
    rooms: [
      // 0 FIRING ROOM — flickering light (P-stream mover) + zombie axis.
      { x: 0, y: 0, w: 512, h: 512, lightLevel: 160, special: flicker ? 1 : 0 },
      // 1 DOOR SECTOR — closed at load (floor = ceiling = 0), tag 665.
      { x: 192, y: 512, w: 64, h: 64, floorHeight: 0, ceilingHeight: 0,
        lightLevel: 160, tag: STREAM_TAG_DOOR },
      // 2 OUTER ROOM — clip + teleportman, tag 666 (the teleport target).
      { x: 192, y: 576, w: 64, h: 256, lightLevel: 160, tag: STREAM_TAG_TELE },
      // 3/4 SOLID FLANKERS beside the door sector. Without them the door
      // sector's east/west faces are VOID (default sector ceiling −128),
      // P_FindLowestCeilingSurrounding returns −128 and T_VerticalDoor
      // "opens" the door by 2 units and re-waits at 0 — a closed door
      // that can never open. Flankers give the corridor a real ±128
      // surrounding like every vanilla door.
      { x: 128, y: 512, w: 64, h: 64, lightLevel: 96 },
      { x: 256, y: 512, w: 64, h: 64, lightLevel: 96 }
    ],
    // The A/B gap line IS the door's use line: regular door (1), tag 665.
    doors: [
      { x1: 192, y1: 512, x2: 256, y2: 512, special: 1, tag: STREAM_TAG_DOOR }
    ],
    // B/C edge = W1 teleport (crossing while running north).
    triggers: [
      { x1: 192, y1: 576, x2: 256, y2: 576, special: 39, tag: STREAM_TAG_TELE }
    ],
    things: [
      { x: STREAM_PLAYER.x, y: STREAM_PLAYER.y, angle: STREAM_PLAYER.angle,
        type: THING_PLAYER1 },
      { x: STREAM_ZOMBIE.x, y: STREAM_ZOMBIE.y, angle: 270, type: THING_ZOMBIE },
      { x: STREAM_CLIP.x, y: STREAM_CLIP.y, angle: 0, type: THING_CLIP },
      { x: STREAM_TELE_DEST.x, y: STREAM_TELE_DEST.y, angle: STREAM_TELE_DEST.angle,
        type: THING_TELEPORT_DEST }
    ]
  };
}

/* ------------------------------------------------------------------ */
/* Hazard + ironfeet room (acceptance 5 geometry)                       */
/* ------------------------------------------------------------------ */

/** One room whose ENTIRE floor is sector special 5 (HELLSLIME DAMAGE —
 * damage 10 per P_PlayerInSpecialSector hit pass, specials-table). The
 * invuln/ironfeet shots in tests/weapons/stream.test.ts run the pplayer
 * .ts damage rules against this sector. */
export function hazardRoomSpec(): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 160, special: 5 }],
    things: [{ x: 128, y: 128, angle: 0, type: THING_PLAYER1 }]
  };
}
