// sim/pdoors.ts — vertical doors (p_doors.c). M6-03 STUB bodies: the
// registry routes hit these slots, record unimplementedSpecial and report
// "nothing moved" (false), reproducing the vanilla control flow where a
// failed action leaves switches armed (M6-plan §M6-03). M6-05 replaces
// THIS FILE's bodies keeping the exact signatures below; M6-09 edits only
// the spawn cases of pspec.ts, not these entry points.
//
// M6-11 ADDITION (p_doors.c:367-411, EV_VerticalDoor's lock-check FRONT
// half): the six locked MANUAL ids 26/27/28/32/33/34 now run the vanilla
// card/skull check BEFORE the (still-stubbed) door body — refusal emits
// p->message = PD_*K + sfx_oof exactly like p_doors.c and returns; a
// monster at 32/33/34 (the use-gate's monster-ok list) returns SILENTLY
// (`if (!player) return;`). The pass-through case still lands in the
// stub (M6-05's body — which NEVER landed on main despite the ledger,
// tracked as an M6-13 follow-up). The message/sfx ids duplicate
// pswitch.ts's PD_*/SFX_OOF on purpose (house style: source-adjacent
// constants, p_doors.c itself repeats the check per file).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { messageSlot, sfxSlot } from './hooks';
import { recordLineStub, recordSectorStub } from './specials-table';
import {
  IT_BLUESKULL, IT_BLUECARD, IT_REDCARD, IT_REDSKULL,
  IT_YELLOWSKULL, IT_YELLOWCARD, type Player
} from './player';
import type { SpecWorld } from './pspec-helpers';
import type { Mover } from './pmap';

/** `EV_DoDoor(line, vldoor_e)` — tagged door actions (p_doors.c). */
export function evDoDoor(s: SpecWorld, line: number, type: number): boolean {
  recordLineStub(s, 'evDoDoor', line, type);
  return false;
}

/** `EV_VerticalDoor(line, thing)` — manuals/locked manuals (p_doors.c).
 * Returns the vanilla int (0/1 = nothing/touched); manuals never disarm
 * here except open-types (inside the real body, M6-05). The LOCK halves
 * (26/32 blue, 27/34 yellow, 28/33 red — card OR skull) are LIVE
 * (M6-11); the mover/height halves behind them are still the stub. */
export function evVerticalDoor(
  s: SpecWorld, line: number, mover: Mover | null
): boolean {
  // `player = thing->player;` + `side = 0; // only front sides can be
  // used` (the side gate lives in the pspec.ts use dispatcher).
  const p = mover?.player
    ? (mover as { playerRef?: Player }).playerRef
    : undefined;

  switch (s.map.lines.special[line]!) {
    case 26: // Blue Lock
    case 32:
      if (!p) return false; // monsters: silent `if (!player) return`
      if (!p.cards[IT_BLUECARD] && !p.cards[IT_BLUESKULL]) {
        refuseDoor(s, p, 'PD_BLUEK');
        return false;
      }
      break;
    case 27: // Yellow Lock
    case 34:
      if (!p) return false;
      if (!p.cards[IT_YELLOWCARD] && !p.cards[IT_YELLOWSKULL]) {
        refuseDoor(s, p, 'PD_YELLOWK');
        return false;
      }
      break;
    case 28: // Red Lock
    case 33:
      if (!p) return false;
      if (!p.cards[IT_REDCARD] && !p.cards[IT_REDSKULL]) {
        refuseDoor(s, p, 'PD_REDK');
        return false;
      }
      break;
    default:
      break; // 1/31/117/118: no lock check at all (p_doors.c)
  }

  recordLineStub(s, 'evVerticalDoor', line, 0);
  return false;
}

/** `player->message = PD_*K; S_StartSound(NULL, sfx_oof);` (p_doors.c:
 * 375-380 family of branches). SFX_OOF = 34 (sounds.h, pswitch.ts pin). */
function refuseDoor(s: SpecWorld, p: Player, messageId: string): void {
  p.message = messageId;
  messageSlot(s.hooks, messageId, s.leveltime);
  sfxSlot(s.hooks, 34, 0, 0, 0, s.leveltime); // origin NULL = listener
}

/** `P_SpawnDoorCloseIn30(sector)` — sector special 10 (sector INDEX
 * argument, like every sector spawner). */
export function pSpawnDoorCloseIn30(s: SpecWorld, sector: number): void {
  recordSectorStub(s, 'pSpawnDoorCloseIn30', sector, 0);
}

/** `P_SpawnDoorRaiseIn5Mins(sector, i)` — sector special 14; `i` is the
 * vanilla sector-index second arg (p_doors.c), carried in the stub log. */
export function pSpawnDoorRaiseIn5Mins(
  s: SpecWorld, sector: number, i: number
): void {
  recordSectorStub(s, 'pSpawnDoorRaiseIn5Mins', sector, i);
}
