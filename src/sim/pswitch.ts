// sim/pswitch.ts — switches, buttons, use-lines, locked-door cards
// (p_switch.c + the buttonlist globals p_spec.c declares/externs).
// M6-11 replaces the M6-03 stub bodies.
//
// Source mirrors (/tmp/DOOM-master/linuxdoom-1.10):
//   • P_InitSwitchList      (p_switch.c:96-133) — build in
//     wad/switchlist.ts (name-based switchlist, deviation documented
//     THERE); the scan/`i^1` swap stays here, in P_ChangeSwitchTexture,
//     exactly where vanilla runs it;
//   • P_StartButton         (p_switch.c:138-166) — buttonlist[]
//     (MAXBUTTONS 16, BUTTONTIME 35); the vanilla
//     `I_Error("P_StartButton: no button slots left!")` is a typed
//     counter (p_switch_counts.buttonOverflow) — no throw: vanilla dies,
//     here the 17th button is dropped (spechit-overflow idiom, logged);
//   • P_ChangeSwitchTexture (p_switch.c:174-233) — disarm-first, the
//     SPECIAL-11 QUIRK (clear-before-check ⇒ exit switches play
//     sfx_swtchn, NOT sfx_swtchx — M6-plan §0.9), the top→mid→bottom
//     scan in SWITCHLIST order (per list entry i: top, else mid, else
//     bottom — NOT per slot), `switchlist[i^1]` swap, P_StartButton with
//     the ORIGINAL texture, and the `S_StartSound(buttonlist->soundorg,…)`
//     origin quirk: vanilla reads SLOT 0's soundorg — whatever sector the
//     FIRST button slot last referenced, even for a different line's
//     switch (NULL/listener before any press). Kept faithful via
//     ButtonSlot.soundorgSector;
//   • EV_DoLockedDoor       (p_doors.c:202-270, reached from the
//     p_switch.c dispatcher) — specials 99/133 (blue), 134/135 (red),
//     136/137 (yellow); card OR skull passes; refusal = p->message =
//     PD_*O + S_StartSound(NULL,sfx_oof), special NOT armed/no switch
//     swap (the dispatcher's gateSwitch sees res=false);
//   • P_UseLines + PTR_UseTraverse (p_map.c:1090-1160) — the USE ray:
//     USERANGE = 64*FRACUNIT straight ahead (p_local.h:56; the plan's
//     "USEMASK 8*64" is Heretic folklore — SOURCE TRUTH here),
//     PT_ADDLINES traverse; non-special line: P_LineOpening —
//     openrange <= 0 ⇒ sfx_noway + ABORT (can't use through a wall),
//     else keep checking; special line: side via P_PointOnLineSide
//     (back-side passes side=1 to the dispatcher, which refuses
//     everything but 124) then `return false` — "can't use for than one
//     special line in a row" (p_map.c:1125).
//
// The P_UseSpecialLine DISPATCHER itself stays in pspec.ts (registry
// routing, M6-03 skeleton — the vanilla gate structure there is already
// source-faithful; the card halves are this file + pdoors.ts). pspec
// publishes it through setUseDispatcher() so this module never imports
// pspec back (import graph stays pspec → pswitch, cycle-free).
//
// The manual-door lock branches (26/27/28/32/33/34, EV_VerticalDoor's
// p_doors.c:368-411 check) live in pdoors.ts next to the door body
// (which is STILL the M6-03 stub on main — M6-05 never landed despite
// the ledger; the refusal halves here are complete regardless and the
// success halves route into that stub, tracked as a follow-up).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { finecosine, finesine } from '../core/tables';
import { buildSwitchList } from '../wad/switchlist';

import { messageSlot, sfxSlot } from './hooks';
import { pLineOpening, pPathTraverse, pPointOnLineSide, PT_ADDLINES } from './pmaputl';
import type { Intercept } from './pmaputl';
import { evDoDoor } from './pdoors';
import {
  IT_BLUESKULL, IT_BLUECARD, IT_REDCARD, IT_REDSKULL,
  IT_YELLOWSKULL, IT_YELLOWCARD, type Player
} from './player';

import type { Mover, PMapWorld } from './pmap';
import type { SpecWorld } from './pspec-helpers';

/* ------------------------------------------------------------------ */
/* p_spec.h constants + buttonlist (MOVED from pspec.ts, M6-11 — the     */
/* activeplats precedent: the family file owns its vanilla globals and   */
/* pspec re-exports them)                                               */
/* ------------------------------------------------------------------ */

export const MAXBUTTONS = 16; // p_spec.h
export const BUTTONTIME = 35; // p_spec.h

/** bwhere_e (p_spec.h). */
export const BWHERE = { top: 0, middle: 1, bottom: 2 } as const;

/** sounds.h sfxenum_t ids (pspec.ts's SFX_SWTCHN = 23 pin extended; M10
 * replaces id→lump decoding). */
export const SFX_SWTCHN = 23;
export const SFX_SWTCHX = 24;
export const SFX_OOF = 34;
export const SFX_NOWAY = 81;

/** d_englsh.h PD_* — messageSlot ids (the exact 1.10 strings are pinned
 * in {@link PD_STRINGS}; M9 HUD maps id → string). */
export const PD_BLUEO = 'PD_BLUEO';
export const PD_REDO = 'PD_REDO';
export const PD_YELLOWO = 'PD_YELLOWO';
export const PD_BLUEK = 'PD_BLUEK';
export const PD_REDK = 'PD_REDK';
export const PD_YELLOWK = 'PD_YELLOWK';

/** d_englsh.h:125-130 verbatim (exact-string pin per M6-plan §M6-11
 * acceptance 4; the messageSlot id is the PD_* key). */
export const PD_STRINGS: Readonly<Record<string, string>> = Object.freeze({
  [PD_BLUEO]: 'You need a blue key to activate this object',
  [PD_REDO]: 'You need a red key to activate this object',
  [PD_YELLOWO]: 'You need a yellow key to activate this object',
  [PD_BLUEK]: 'You need a blue key to open this door',
  [PD_REDK]: 'You need a red key to open this door',
  [PD_YELLOWK]: 'You need a yellow key to open this door'
});

/** button_t (p_spec.h) — line by index, where the switch texture lives.
 * `soundorgSector` stands for vanilla's `mobj_t *soundorg`
 * (= &frontsector->soundorg, −1 = the global-zero NULL ⇒ listener);
 * P_ChangeSwitchTexture reads SLOT 0's copy (quirk, file header). */
export interface ButtonSlot {
  line: number; // −1 = free
  where: number; // BWHERE
  btexture: string; // texture to restore when the timer expires
  btimer: number;
  soundorgSector: number;
}

export const buttonList: ButtonSlot[] = Array.from(
  { length: MAXBUTTONS },
  () => ({ line: -1, where: 0, btexture: '', btimer: 0, soundorgSector: -1 })
);

/* ------------------------------------------------------------------ */
/* switchlist[] / numswitches (p_switch.c globals)                       */
/* ------------------------------------------------------------------ */

export const switchList = {
  /** flat [off0, on0, off1, on1, …] — `switchlist[i^1]` is the partner. */
  names: [] as string[],
  numswitches: 0
};

/** Instruments (never hashed). */
export const pswitchCounts = {
  /** P_ChangeSwitchTexture calls (replaces the M6-03 stub recorder the
   * pspec.ts coverage loops assert on). */
  changeSwitchTexture: 0,
  /** scan matched a switch texture (real swap + sfx happened). */
  switchTextureMatch: 0,
  /** P_StartButton fresh starts (slot writes). */
  buttonStarts: 0,
  /** same-line re-press while a button on that line is live (timer kept). */
  buttonRepress: 0,
  /** I_Error("no button slots left!") → counted drop (see header). */
  buttonOverflow: 0,
  /** P_UseLines calls. */
  useLines: 0,
  /** PTR_UseTraverse: non-special line, openrange <= 0 (sfx_noway). */
  useNoWay: 0,
  /** PTR_UseTraverse: special line reached the dispatcher. */
  useSpecial: 0,
  /** use attempted with no bound world (unit PMapWorlds). */
  unboundUse: 0,
  /** EV_DoLockedDoor refusals (message + oof emitted). */
  lockedRefused: 0,
  /** EV_DoLockedDoor with a `player:true` mover carrying no player_t. */
  lockedNoPlayer: 0
};

export function resetPswitchCounts(): void {
  pswitchCounts.changeSwitchTexture = 0;
  pswitchCounts.switchTextureMatch = 0;
  pswitchCounts.buttonStarts = 0;
  pswitchCounts.buttonRepress = 0;
  pswitchCounts.buttonOverflow = 0;
  pswitchCounts.useLines = 0;
  pswitchCounts.useNoWay = 0;
  pswitchCounts.useSpecial = 0;
  pswitchCounts.unboundUse = 0;
  pswitchCounts.lockedRefused = 0;
  pswitchCounts.lockedNoPlayer = 0;
}

/**
 * `P_InitSwitchList()` (call site P_SetupLevel, p_setup.c:702 — here the
 * tests/init code pass the level's texture names; the gInitGame wiring
 * is M6-13's integration line, tracked as follow-up). Episode defaults
 * to `registered` — this port targets Doom1/Freedoom1 (gamemode filter
 * is a name-presence no-op via the directory scan, see wad/switchlist).
 */
export function pInitSwitchList(
  textureNames: readonly string[], episode = 2
): void {
  switchList.names = buildSwitchList(textureNames, episode);
  switchList.numswitches = switchList.names.length / 2;
}

export function resetSwitchList(): void {
  switchList.names = [];
  switchList.numswitches = 0;
}

/* ------------------------------------------------------------------ */
/* P_StartButton — p_switch.c:138-166                                    */
/* ------------------------------------------------------------------ */

/**
 * `P_StartButton(line, where, texture, time)`. The pre-scan keeps a
 * same-line re-press from touching the ORIGINAL timer (vanilla
 * "See if button is already pressed"), then first-free-slot init with
 * `soundorg = &line->frontsector->soundorg`. 17th live button: vanilla
 * I_Error — here counted + dropped (typed-error idiom, M6-plan).
 */
export function pStartButton(
  s: SpecWorld, line: number, where: number, texture: string, time: number
): void {
  // See if button is already pressed.
  for (let i = 0; i < MAXBUTTONS; i++) {
    const b = buttonList[i]!;
    if (b.btimer && b.line === line) {
      pswitchCounts.buttonRepress++;
      return;
    }
  }

  for (let i = 0; i < MAXBUTTONS; i++) {
    const b = buttonList[i]!;
    if (!b.btimer) {
      b.line = line;
      b.where = where;
      b.btexture = texture;
      b.btimer = time;
      // vanilla: (mobj_t *)&line->frontsector->soundorg
      b.soundorgSector = s.map.lines.sectorFront[line] ?? -1;
      pswitchCounts.buttonStarts++;
      return;
    }
  }
  // I_Error("P_StartButton: no button slots left!")
  pswitchCounts.buttonOverflow++;
}

/* ------------------------------------------------------------------ */
/* P_ChangeSwitchTexture — p_switch.c:174-233                            */
/* ------------------------------------------------------------------ */

/**
 * `P_ChangeSwitchTexture(line, useAgain)` — see file header for the
 * three quirks (disarm-first, special-11 sound, slot-0 soundorg). The
 * side mutation lands on the LIVE side SoA (map.sides.*Texture) the
 * renderer re-reads each frame (M6-plan §0.9 — no push API).
 */
export function pChangeSwitchTexture(
  s: SpecWorld, line: number, useAgain: number
): void {
  pswitchCounts.changeSwitchTexture++;

  if (!useAgain) s.map.lines.special[line] = 0; // disarm FIRST (S1)

  const side = s.map.lines.sideNumFront[line]!;
  if (side < 0) return; // vanilla reads sides[garbage] — impossible here

  const sides = s.map.sides;
  const texTop = sides.topTexture[side]!;
  const texMid = sides.midTexture[side]!;
  const texBot = sides.bottomTexture[side]!;

  // EXIT SWITCH? — reads the special AFTER the disarm, so special 11
  // (S1, useAgain 0) plays sfx_swtchn: the plan's §0.9 quirk, kept by
  // evaluation order, NOT by a special case.
  let sound = SFX_SWTCHN;
  if (s.map.lines.special[line] === 11) sound = SFX_SWTCHX;

  const names = switchList.names;
  for (let i = 0; i < switchList.numswitches * 2; i++) {
    const cand = names[i]!;
    let matched = true;
    if (cand === texTop) {
      sfxSwitch(s, sound);
      (sides.topTexture as string[])[side] = names[i ^ 1]!;
    } else if (cand === texMid) {
      sfxSwitch(s, sound);
      (sides.midTexture as string[])[side] = names[i ^ 1]!;
    } else if (cand === texBot) {
      sfxSwitch(s, sound);
      (sides.bottomTexture as string[])[side] = names[i ^ 1]!;
    } else {
      matched = false;
    }
    if (matched) {
      pswitchCounts.switchTextureMatch++;
      if (useAgain) {
        const where =
          cand === texTop ? BWHERE.top : cand === texMid ? BWHERE.middle : BWHERE.bottom;
        pStartButton(s, line, where, cand, BUTTONTIME);
      }
      return; // vanilla returns from inside the scan
    }
  }
}

/** S_StartSound(buttonlist->soundorg, sound) — SLOT 0's soundorg quirk
 * (file header): sector soundorg x/y (P_GroupLines centre, same read as
 * pspec.ts's sfxButton; z 0 pinned there), listener (0,0,0) while slot 0
 * has never been used (vanilla NULL origin). */
function sfxSwitch(s: SpecWorld, sound: number): void {
  const sec = buttonList[0]!.soundorgSector;
  const x = sec >= 0 ? s.map.sectors.soundOrgX[sec]! : 0;
  const y = sec >= 0 ? s.map.sectors.soundOrgY[sec]! : 0;
  sfxSlot(s.hooks, sound, x, y, 0, s.leveltime);
}

/* ------------------------------------------------------------------ */
/* EV_DoLockedDoor — p_doors.c:202-270 (the p_switch.c dispatcher's      */
/* locked-button half: specials 99/133/134/135/136/137)                  */
/* ------------------------------------------------------------------ */

/** The player_t view of a mover (`mobj_t.player`); bare test Movers
 * carry `player: true` without a player_t (ptelept.ts precedent). */
function playerOf(thing: Mover | null): Player | undefined {
  if (!thing || !thing.player) return undefined;
  return (thing as { playerRef?: Player }).playerRef;
}

/**
 * `EV_DoLockedDoor(line, blazeOpen, thing)` → boolean (vanilla int).
 * `thing->player == NULL` ⇒ 0 silently (`if (!p) return 0` — the
 * dispatcher already gated monsters out of these ids). Card OR skull
 * of the line's colour passes; refusal writes p->message + oof(NULL)
 * and returns 0 (switch stays armed — no texture change, special
 * keeps firing: the SR refusals repeat cleanly).
 */
export function evDoLockedDoor(
  s: SpecWorld, line: number, type: number, mover: Mover | null
): boolean {
  const p = playerOf(mover);
  if (!p) {
    if (mover?.player) pswitchCounts.lockedNoPlayer++;
    return false;
  }
  const special = s.map.lines.special[line]!;
  switch (special) {
    case 99: // Blue Lock
    case 133:
      if (!p.cards[IT_BLUECARD] && !p.cards[IT_BLUESKULL]) {
        refuse(s, p, PD_BLUEO);
        return false;
      }
      break;
    case 134: // Red Lock
    case 135:
      if (!p.cards[IT_REDCARD] && !p.cards[IT_REDSKULL]) {
        refuse(s, p, PD_REDO);
        return false;
      }
      break;
    case 136: // Yellow Lock
    case 137:
      if (!p.cards[IT_YELLOWCARD] && !p.cards[IT_YELLOWSKULL]) {
        refuse(s, p, PD_YELLOWO);
        return false;
      }
      break;
    default:
      break; // 1.10 falls through to EV_DoDoor for any other special
  }
  return evDoDoor(s, line, type);
}

/** p->message = PD_*O + S_StartSound(NULL, sfx_oof). */
function refuse(s: SpecWorld, p: Player, messageId: string): void {
  p.message = messageId;
  messageSlot(s.hooks, messageId, s.leveltime);
  sfxSlot(s.hooks, SFX_OOF, 0, 0, 0, s.leveltime); // origin NULL = listener
  pswitchCounts.lockedRefused++;
}

/* ------------------------------------------------------------------ */
/* P_UseLines / PTR_UseTraverse — p_map.c:1090-1160                      */
/* ------------------------------------------------------------------ */

/** p_local.h:56 `#define USERANGE (64*FRACUNIT)`. SOURCE TRUTH over the
 * plan's "USEMASK 8*64" (Heretic's P_RailAttack constant — not 1.10). */
export const USERANGE = 64 * FRACUNIT;
/** The integer-pixel multiplier of the ray endpoint math: vanilla
 * `x2 = x1 + (USERANGE>>FRACBITS)*finecosine[angle]` — 64 (whole px)
 * times the FIXED cosine. */
const USERANGE_PX = USERANGE / FRACUNIT;

/** The bound level (pSpawnSpecials binds through pspec; pmap.bm is the
 * blockmap the traverse walks). */
export interface SwitchWorld extends SpecWorld {
  readonly pmap?: PMapWorld;
}

let boundSwitchWorld: SwitchWorld | null = null;

export function bindSwitchWorld(s: SwitchWorld | null): void {
  boundSwitchWorld = s;
}

/** p_map.c:1088 `static mobj_t *usething;` — same file-scope idiom. */
let useThing: Mover | null = null;

/** The dispatcher half (pspec.ts's pUseSpecialLine registers itself at
 * module load — keeps the import graph one-directional). */
export type UseDispatcher = (
  s: SpecWorld, thing: Mover, line: number, side: number
) => boolean;

let useDispatcher: UseDispatcher | null = null;

export function setUseDispatcher(fn: UseDispatcher | null): void {
  useDispatcher = fn;
}

/**
 * `P_UseLines(player)` — straight-ahead 64 px ray from the player's mo
 * at its angle, PT_ADDLINES. The `usedown` edge (one press = one ray)
 * is p_user.c's caller logic (puser.ts).
 */
export function pUseLines(p: Player): void {
  const s = boundSwitchWorld;
  if (!s || !s.pmap) {
    pswitchCounts.unboundUse++;
    return;
  }
  useThing = p.mo;

  const angle = p.mo.angle >>> ANGLETOFINESHIFT;
  const x1 = p.mo.x;
  const y1 = p.mo.y;
  // vanilla int math: (USERANGE>>FRACBITS)*finecosine[angle] — 64×fixed,
  // |0 wrap kept (no overflow at 64·FRACUNIT = 2^22, but faithful).
  const x2 = (x1 + Math.imul(USERANGE_PX, finecosine[angle]!)) | 0;
  const y2 = (y1 + Math.imul(USERANGE_PX, finesine[angle]!)) | 0;

  pswitchCounts.useLines++;
  pPathTraverse(s.map, s.pmap.bm, x1, y1, x2, y2, PT_ADDLINES, ptrUseTraverse);
}

/**
 * `PTR_UseTraverse(in)` — non-special line: wall ⇒ sfx_noway(usething)
 * + false (abort), open ⇒ true (keep checking); special line: side from
 * P_PointOnLineSide(usething) then the dispatcher, and ALWAYS false —
 * "can't use for than one special line in a row" (p_map.c:1125).
 */
function ptrUseTraverse(in_: Intercept): boolean {
  const s = boundSwitchWorld;
  const thing = useThing;
  if (!s || !thing) return false;
  const line = in_.line;

  if (!s.map.lines.special[line]!) {
    const op = pLineOpening(s.map, line);
    if (op.openrange <= 0) {
      sfxSlot(s.hooks, SFX_NOWAY, thing.x, thing.y, thing.z, s.leveltime);
      pswitchCounts.useNoWay++;
      return false; // can't use through a wall
    }
    return true; // not a special line, but keep checking
  }

  const side = pPointOnLineSide(s.map, thing.x, thing.y, line) === 1 ? 1 : 0;
  pswitchCounts.useSpecial++;
  if (useDispatcher) useDispatcher(s, thing, line, side);
  return false;
}
