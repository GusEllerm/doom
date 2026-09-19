// sim/specials-table.ts — the M6-03 special-number REGISTRY (M6-plan
// §M6-03, R05 §2/§3 census). 1.10 has NO special-number data table — every
// special is a hardcoded `case` in one of three giant switch statements:
// P_UseSpecialLine (p_switch.c), P_CrossSpecialLine + P_ShootSpecialLine
// (p_spec.c). This module turns those two giant switches into DATA:
// special number → { use?/cross?/shoot? trigger specs, arg pattern, clear
// flag }. pspec.ts binds the action ids to the family entry points and the
// dispatchers iterate THESE tables — no per-special switch remains.
//
// CLASS VOCABULARY (R05 §1 — reconstructed taxonomy, 1.10 has none):
//   W1  = cross, case ends `line->special = 0`      → cross.clear true
//   WR/GR = cross, no clear                          → cross.clear false
//   S1/SR = use, disarm happens INSIDE P_ChangeSwitchTexture(line,useAgain)
//           → use.gateSwitch/thenSwitch carry the useAgain value; the
//           texture stub (M6-11) owns the actual `special = 0`.
//   Manuals (1,26-28,31-34,117,118) never touch special in the dispatcher
//   (the open-type clear lives inside EV_VerticalDoor — M6-05).
//
// EXCEPTIONS pinned from source (do not "fix"):
//   • cross 52/124 (exits) do NOT clear line->special (p_spec.c);
//   • cross 125 clears ONLY when the !player branch runs (monsterOnly);
//   • use 11/51 call P_ChangeSwitchTexture BEFORE the exit call (switchBefore);
//   • use 62 passes amount=1 to EV_DoPlat(downWaitUpStay) (ignored, pinned);
//   • cross 40 runs TWO actions: ceiling raiseToHighest THEN floor
//     lowerFloorToLowest (second:);
//   • shoot 24/46/47 call P_ChangeSwitchTexture UNCONDITIONALLY (no
//     if-action-returned gate — unlike the use-side S1/SR cases);
//   • 48 never appears in a dispatcher: P_SpawnSpecials collects it
//     (scroll:true) and P_UpdateSpecials pans side 0 by FRACUNIT per tic.
//
// Census (machine-checked by specials-table.test.ts):
//   line specials: numbers 1..141 MINUS the unassigned 78 and 85 = 139 ids,
//   each registered here with ≥1 route (63 use-side, 72 cross-side, 3
//   shoot-side, 1 spawn-only [48]; ids may carry several routes — the
//   family counts sum to more than 139).
//   sector specials: 15 handled ids (1-5,7-14,16,17); 6 and 15 are
//   explicitly EXCLUDED (no case in P_SpawnSpecials nor
//   P_PlayerInSpecialSector — either would reach a 1.10 code path that
//   does not exist; anything left special=6/15 in a map simply does
//   nothing at load and I_Error's at feet in vanilla, mapped to the
//   M6-12 typed throw).
//   E1M8 finale sector special 11 is REGISTERED here as feet DATA only —
//   the finale behaviour (godmode clear + exit at hp≤10) is M6-12 scope.
//
// A-06: imports NOTHING at runtime except the stub-recorder living in this
// file; family stub modules import these types + recordUnimplemented only,
// so pspec.ts → stubs → specials-table.ts is acyclic.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { SpecWorld } from './pspec-helpers';

/* ------------------------------------------------------------------ */
/* p_spec.h family enum values (port codes)                            */
/* ------------------------------------------------------------------ */

/** p_spec.h vldoor_e (raiseIn5Mins only spawned, never dispatched). */
export const VL = {
  normal: 0,
  close30ThenOpen: 1,
  close: 2,
  open: 3,
  raiseIn5Mins: 4,
  blazeRaise: 5,
  blazeOpen: 6,
  blazeClose: 7
} as const;

/** p_spec.h plattype_e. */
export const PLAT = {
  perpetualRaise: 0,
  downWaitUpStay: 1,
  raiseAndChange: 2,
  raiseToNearestAndChange: 3,
  blazeDWUS: 4
} as const;

/** p_spec.h floor_e. */
export const FLOOR = {
  lowerFloor: 0,
  lowerFloorToLowest: 1,
  turboLower: 2,
  raiseFloor: 3,
  raiseFloorToNearest: 4,
  raiseToTexture: 5,
  lowerAndChange: 6,
  raiseFloor24: 7,
  raiseFloor24AndChange: 8,
  raiseFloorCrush: 9,
  raiseFloorTurbo: 10,
  donutRaise: 11,
  raiseFloor512: 12
} as const;

/** p_spec.h ceiling_e. */
export const CEIL = {
  lowerToFloor: 0,
  raiseToHighest: 1,
  lowerAndCrush: 2,
  crushAndRaise: 3,
  fastCrushAndRaise: 4,
  silentCrushAndRaise: 5
} as const;

/** p_spec.h stair_e. */
export const STAIR = { build8: 0, turbo16: 1 } as const;

/** p_spec.h FASTDARK / SLOWDARK (spawn strobe darktime arg). */
export const FASTDARK = 15;
export const SLOWDARK = 35;

/* ------------------------------------------------------------------ */
/* Registry entry shapes                                               */
/* ------------------------------------------------------------------ */

/** Which entry point an action routes to. 'exit' runs exitSlot
 * (G_ExitLevel/G_SecretExitLevel proxy, D013(e)); everything else resolves
 * through pspec.ts's FNS map onto the family modules (stubs until M6-05..11). */
export type ActionId =
  | 'door' // EV_DoDoor(line, vldoor_e)
  | 'floor' // EV_DoFloor(line, floor_e)
  | 'plat' // EV_DoPlat(line, plattype_e, amount)
  | 'ceiling' // EV_DoCeiling(line, ceiling_e)
  | 'stairs' // EV_BuildStairs(line, stair_e)
  | 'donut' // EV_DoDonut(line)                     (1.10 p_spec.c → pfloor.ts, D013(b))
  | 'lightOn' // EV_LightTurnOn(line, bright)
  | 'strobe' // EV_StartLightStrobing(line)
  | 'lightsOff' // EV_TurnTagLightsOff(line)
  | 'crushStop' // EV_CeilingCrushStop(line)
  | 'stopPlat' // EV_StopPlat(line)
  | 'teleport' // EV_Teleport(line, side, thing)
  | 'verticalDoor' // EV_VerticalDoor(line, thing)    (manuals, p_doors.c)
  | 'lockedDoor' // EV_DoLockedDoor(line, blazeOpen, thing) (pswitch, M6-11)
  | 'exit'; // G_ExitLevel / G_SecretExitLevel (arg 0/1)

/** Spawn-only entry points (P_SpawnSpecials sector pass, M6-03 wiring →
 * plights/pdoors bodies land in M6-09/M6-05). */
export type SpawnActionId =
  | 'lightFlash' // P_SpawnLightFlash(sector)
  | 'strobe' // P_SpawnStrobeFlash(sector, arg=darktime, arg2=1 in sync)
  | 'glow' // P_SpawnGlowingLight(sector)
  | 'fireFlicker' // P_SpawnFireFlicker(sector)
  | 'doorCloseIn30' // P_SpawnDoorCloseIn30(sector)
  | 'doorRaiseIn5Mins' // P_SpawnDoorRaiseIn5Mins(sector, i)
  | 'secretCount'; // totalsecret++ (real in M6-03; no stub)

/** One `case`-body action: entry point + its arg pattern (R05 §2). */
export interface ActionSpec {
  readonly action: ActionId;
  /** family enum value / bright level / exit kind (0 normal, 1 secret). */
  readonly arg?: number;
  /** EV_DoPlat amount (raiseAndChange 24/32; 62 pins amount=1). */
  readonly amount?: number;
}

/** A route (one dispatcher's view of a special number). */
export interface TriggerSpec {
  readonly actions: readonly ActionSpec[];
  /** cross W1: `line->special = 0` after the actions (52/124: false). */
  readonly clear?: boolean;
  /** cross: non-player things MAY activate (the {4,10,88,39,97,125,126}
   * ok-list, R05 §1.1). Absent ⇒ false. */
  readonly monsterOk?: boolean;
  /** cross 125/126: fires ONLY for non-players; the W1 clear of 125 runs
   * inside that branch (player crossing leaves the special armed). */
  readonly monsterOnly?: boolean;
  /** use: `if (action) P_ChangeSwitchTexture(line, v)` (the S1/SR gate). */
  readonly gateSwitch?: 0 | 1;
  /** use 138/139 & all shoot cases: ChangeSwitchTexture UNCONDITIONALLY. */
  readonly thenSwitch?: 0 | 1;
  /** use 11/51: ChangeSwitchTexture BEFORE the exit call. */
  readonly switchBefore?: 0 | 1;
  /** use: non-player things may activate (the manual {1,32,33,34} list;
   * ML_SECRET still vetoes first, R05 §1.2). */
  readonly monsterUseOk?: boolean;
}

export interface LineSpecialEntry {
  readonly id: number;
  readonly use?: TriggerSpec;
  readonly cross?: TriggerSpec;
  readonly shoot?: TriggerSpec;
  /** special 48: P_SpawnSpecials collects into linespeciallist; no route. */
  readonly scroll?: boolean;
  /** vanilla comment (census readability). */
  readonly name: string;
}

/** Feet (P_PlayerInSpecialSector) metadata — DATA only in M6-03; the feet
 * dispatch section lands with M6-12 (damage cadence `!(leveltime&0x1f)`,
 * ironfeet gate, randBypass = `|| (P_Random()<5)`, finale = E1M8 11). */
export interface FeetSpec {
  readonly damage?: number;
  readonly randBypass?: boolean;
  readonly secret?: boolean;
  readonly finale?: boolean;
}

export interface SectorSpecialEntry {
  readonly id: number;
  readonly spawn?: { readonly action: SpawnActionId; readonly arg?: number };
  /** value written back after the spawner runs (vanilla: spawners set
   * sector->special = 0; case 4 re-writes 4; 9 untouched). Registry-driven
   * here so M6-03 already reproduces the post-load special values even
   * while the spawner bodies are stubs (documented placement deviation). */
  readonly clearTo?: number;
  readonly feet?: FeetSpec;
  readonly name: string;
}

export interface ExcludedEntry {
  readonly id: number;
  readonly reason: string;
}

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

/** Max line special registered (141). */
export const MAX_LINE_SPECIAL = 141;
/** Max sector special registered (17). */
export const MAX_SECTOR_SPECIAL = 17;

const c = (
  action: ActionId,
  arg?: number,
  amount?: number
): ActionSpec => ({ action, arg, amount });

/** The 139-id line-special registry, indexed by special number (holes:
 * 0/78/85 = null). Built once; frozen. */
function buildLineTable(): (LineSpecialEntry | null)[] {
  const t: (LineSpecialEntry | null)[] = new Array<LineSpecialEntry | null>(
    MAX_LINE_SPECIAL + 1
  ).fill(null);
  const entries: readonly LineSpecialEntry[] = [
    // ---- manuals (use-only; clear lives inside EV_VerticalDoor, M6-05) ----
    { id: 1, name: 'MANUAL DOOR RAISE', use: { actions: [c('verticalDoor')], monsterUseOk: true } },
    { id: 26, name: 'MANUAL BLUE LOCKED', use: { actions: [c('verticalDoor')] } },
    { id: 27, name: 'MANUAL YELLOW LOCKED', use: { actions: [c('verticalDoor')] } },
    { id: 28, name: 'MANUAL RED LOCKED', use: { actions: [c('verticalDoor')] } },
    { id: 31, name: 'MANUAL DOOR OPEN', use: { actions: [c('verticalDoor')] } },
    { id: 32, name: 'MANUAL BLUE OPEN', use: { actions: [c('verticalDoor')], monsterUseOk: true } },
    { id: 33, name: 'MANUAL RED OPEN', use: { actions: [c('verticalDoor')], monsterUseOk: true } },
    { id: 34, name: 'MANUAL YELLOW OPEN', use: { actions: [c('verticalDoor')], monsterUseOk: true } },
    { id: 117, name: 'MANUAL BLAZE RAISE', use: { actions: [c('verticalDoor')] } },
    { id: 118, name: 'MANUAL BLAZE OPEN', use: { actions: [c('verticalDoor')] } },

    // ---- use S1 / SR / exit switches ----
    { id: 7, name: 'S1 BUILD STAIRS', use: { actions: [c('stairs', STAIR.build8)], gateSwitch: 0 } },
    { id: 9, name: 'S1 DONUT', use: { actions: [c('donut')], gateSwitch: 0 } },
    { id: 11, name: 'S1 EXIT', use: { actions: [c('exit', 0)], switchBefore: 0 } },
    { id: 14, name: 'S1 PLAT RAISE&CHANGE 32', use: { actions: [c('plat', PLAT.raiseAndChange, 32)], gateSwitch: 0 } },
    { id: 15, name: 'S1 PLAT RAISE&CHANGE 24', use: { actions: [c('plat', PLAT.raiseAndChange, 24)], gateSwitch: 0 } },
    { id: 18, name: 'S1 FLOOR RAISE TO NEAREST', use: { actions: [c('floor', FLOOR.raiseFloorToNearest)], gateSwitch: 0 } },
    { id: 20, name: 'S1 PLAT RAISE NEAREST&CHANGE', use: { actions: [c('plat', PLAT.raiseToNearestAndChange, 0)], gateSwitch: 0 } },
    { id: 21, name: 'S1 LIFT DWUS', use: { actions: [c('plat', PLAT.downWaitUpStay, 0)], gateSwitch: 0 } },
    { id: 23, name: 'S1 FLOOR LOWER TO LOWEST', use: { actions: [c('floor', FLOOR.lowerFloorToLowest)], gateSwitch: 0 } },
    { id: 29, name: 'S1 DOOR RAISE', use: { actions: [c('door', VL.normal)], gateSwitch: 0 } },
    { id: 41, name: 'S1 CEILING LOWER TO FLOOR', use: { actions: [c('ceiling', CEIL.lowerToFloor)], gateSwitch: 0 } },
    { id: 42, name: 'SR DOOR CLOSE', use: { actions: [c('door', VL.close)], gateSwitch: 1 } },
    { id: 43, name: 'SR CEILING LOWER TO FLOOR', use: { actions: [c('ceiling', CEIL.lowerToFloor)], gateSwitch: 1 } },
    { id: 45, name: 'SR FLOOR LOWER', use: { actions: [c('floor', FLOOR.lowerFloor)], gateSwitch: 1 } },
    { id: 49, name: 'S1 CEILING CRUSH&RAISE', use: { actions: [c('ceiling', CEIL.crushAndRaise)], gateSwitch: 0 } },
    { id: 50, name: 'S1 DOOR CLOSE', use: { actions: [c('door', VL.close)], gateSwitch: 0 } },
    { id: 51, name: 'S1 SECRET EXIT', use: { actions: [c('exit', 1)], switchBefore: 0 } },
    { id: 55, name: 'S1 FLOOR RAISE CRUSH', use: { actions: [c('floor', FLOOR.raiseFloorCrush)], gateSwitch: 0 } },
    { id: 60, name: 'SR FLOOR LOWER TO LOWEST', use: { actions: [c('floor', FLOOR.lowerFloorToLowest)], gateSwitch: 1 } },
    { id: 61, name: 'SR DOOR OPEN', use: { actions: [c('door', VL.open)], gateSwitch: 1 } },
    // amount=1 pinned from p_switch.c case 62 (ignored by EV_DoPlat DWUS).
    { id: 62, name: 'SR LIFT DWUS', use: { actions: [c('plat', PLAT.downWaitUpStay, 1)], gateSwitch: 1 } },
    { id: 63, name: 'SR DOOR RAISE', use: { actions: [c('door', VL.normal)], gateSwitch: 1 } },
    { id: 64, name: 'SR FLOOR RAISE', use: { actions: [c('floor', FLOOR.raiseFloor)], gateSwitch: 1 } },
    { id: 65, name: 'SR FLOOR RAISE CRUSH', use: { actions: [c('floor', FLOOR.raiseFloorCrush)], gateSwitch: 1 } },
    { id: 66, name: 'SR PLAT RAISE&CHANGE 24', use: { actions: [c('plat', PLAT.raiseAndChange, 24)], gateSwitch: 1 } },
    { id: 67, name: 'SR PLAT RAISE&CHANGE 32', use: { actions: [c('plat', PLAT.raiseAndChange, 32)], gateSwitch: 1 } },
    { id: 68, name: 'SR PLAT RAISE NEAREST&CHANGE', use: { actions: [c('plat', PLAT.raiseToNearestAndChange, 0)], gateSwitch: 1 } },
    { id: 69, name: 'SR FLOOR RAISE TO NEAREST', use: { actions: [c('floor', FLOOR.raiseFloorToNearest)], gateSwitch: 1 } },
    { id: 70, name: 'SR FLOOR TURBO LOWER', use: { actions: [c('floor', FLOOR.turboLower)], gateSwitch: 1 } },
    { id: 71, name: 'S1 FLOOR TURBO LOWER', use: { actions: [c('floor', FLOOR.turboLower)], gateSwitch: 0 } },
    { id: 99, name: 'SR LOCKED BLUE BLAZE OPEN', use: { actions: [c('lockedDoor', VL.blazeOpen)], gateSwitch: 1 } },
    { id: 101, name: 'S1 FLOOR RAISE', use: { actions: [c('floor', FLOOR.raiseFloor)], gateSwitch: 0 } },
    { id: 102, name: 'S1 FLOOR LOWER', use: { actions: [c('floor', FLOOR.lowerFloor)], gateSwitch: 0 } },
    { id: 103, name: 'S1 DOOR OPEN', use: { actions: [c('door', VL.open)], gateSwitch: 0 } },
    { id: 111, name: 'S1 DOOR BLAZE RAISE', use: { actions: [c('door', VL.blazeRaise)], gateSwitch: 0 } },
    { id: 112, name: 'S1 DOOR BLAZE OPEN', use: { actions: [c('door', VL.blazeOpen)], gateSwitch: 0 } },
    { id: 113, name: 'S1 DOOR BLAZE CLOSE', use: { actions: [c('door', VL.blazeClose)], gateSwitch: 0 } },
    { id: 114, name: 'SR DOOR BLAZE RAISE', use: { actions: [c('door', VL.blazeRaise)], gateSwitch: 1 } },
    { id: 115, name: 'SR DOOR BLAZE OPEN', use: { actions: [c('door', VL.blazeOpen)], gateSwitch: 1 } },
    { id: 116, name: 'SR DOOR BLAZE CLOSE', use: { actions: [c('door', VL.blazeClose)], gateSwitch: 1 } },
    { id: 122, name: 'S1 PLAT BLAZE DWUS', use: { actions: [c('plat', PLAT.blazeDWUS, 0)], gateSwitch: 0 } },
    { id: 123, name: 'SR PLAT BLAZE DWUS', use: { actions: [c('plat', PLAT.blazeDWUS, 0)], gateSwitch: 1 } },
    { id: 127, name: 'S1 BUILD STAIRS TURBO 16', use: { actions: [c('stairs', STAIR.turbo16)], gateSwitch: 0 } },
    { id: 131, name: 'S1 FLOOR RAISE TURBO', use: { actions: [c('floor', FLOOR.raiseFloorTurbo)], gateSwitch: 0 } },
    { id: 132, name: 'SR FLOOR RAISE TURBO', use: { actions: [c('floor', FLOOR.raiseFloorTurbo)], gateSwitch: 1 } },
    { id: 133, name: 'S1 LOCKED BLUE BLAZE OPEN', use: { actions: [c('lockedDoor', VL.blazeOpen)], gateSwitch: 0 } },
    { id: 134, name: 'SR LOCKED RED BLAZE OPEN', use: { actions: [c('lockedDoor', VL.blazeOpen)], gateSwitch: 1 } },
    { id: 135, name: 'S1 LOCKED RED BLAZE OPEN', use: { actions: [c('lockedDoor', VL.blazeOpen)], gateSwitch: 0 } },
    { id: 136, name: 'SR LOCKED YELLOW BLAZE OPEN', use: { actions: [c('lockedDoor', VL.blazeOpen)], gateSwitch: 1 } },
    { id: 137, name: 'S1 LOCKED YELLOW BLAZE OPEN', use: { actions: [c('lockedDoor', VL.blazeOpen)], gateSwitch: 0 } },
    { id: 138, name: 'SR LIGHT ON 255', use: { actions: [c('lightOn', 255)], thenSwitch: 1 } },
    { id: 139, name: 'SR LIGHT ON 35', use: { actions: [c('lightOn', 35)], thenSwitch: 1 } },
    { id: 140, name: 'S1 FLOOR RAISE 512', use: { actions: [c('floor', FLOOR.raiseFloor512)], gateSwitch: 0 } },

    // ---- cross W1 (clear:true) ----
    { id: 2, name: 'W1 DOOR OPEN', cross: { actions: [c('door', VL.open)], clear: true } },
    { id: 3, name: 'W1 DOOR CLOSE', cross: { actions: [c('door', VL.close)], clear: true } },
    { id: 4, name: 'W1 DOOR RAISE', cross: { actions: [c('door', VL.normal)], clear: true, monsterOk: true } },
    { id: 5, name: 'W1 FLOOR RAISE', cross: { actions: [c('floor', FLOOR.raiseFloor)], clear: true } },
    { id: 6, name: 'W1 CEILING FAST CRUSH&RAISE', cross: { actions: [c('ceiling', CEIL.fastCrushAndRaise)], clear: true } },
    { id: 8, name: 'W1 BUILD STAIRS', cross: { actions: [c('stairs', STAIR.build8)], clear: true } },
    { id: 10, name: 'W1 LIFT DWUS', cross: { actions: [c('plat', PLAT.downWaitUpStay, 0)], clear: true, monsterOk: true } },
    { id: 12, name: 'W1 LIGHT ON BRIGHTEST NEAR', cross: { actions: [c('lightOn', 0)], clear: true } },
    { id: 13, name: 'W1 LIGHT ON 255', cross: { actions: [c('lightOn', 255)], clear: true } },
    { id: 16, name: 'W1 DOOR CLOSE 30 THEN OPEN', cross: { actions: [c('door', VL.close30ThenOpen)], clear: true } },
    { id: 17, name: 'W1 START LIGHT STROBING', cross: { actions: [c('strobe')], clear: true } },
    { id: 19, name: 'W1 FLOOR LOWER', cross: { actions: [c('floor', FLOOR.lowerFloor)], clear: true } },
    { id: 22, name: 'W1 PLAT RAISE NEAREST&CHANGE', cross: { actions: [c('plat', PLAT.raiseToNearestAndChange, 0)], clear: true } },
    { id: 25, name: 'W1 CEILING CRUSH&RAISE', cross: { actions: [c('ceiling', CEIL.crushAndRaise)], clear: true } },
    { id: 30, name: 'W1 FLOOR RAISE TO TEXTURE', cross: { actions: [c('floor', FLOOR.raiseToTexture)], clear: true } },
    { id: 35, name: 'W1 LIGHT ON 35', cross: { actions: [c('lightOn', 35)], clear: true } },
    { id: 36, name: 'W1 FLOOR TURBO LOWER', cross: { actions: [c('floor', FLOOR.turboLower)], clear: true } },
    { id: 37, name: 'W1 FLOOR LOWER&CHANGE', cross: { actions: [c('floor', FLOOR.lowerAndChange)], clear: true } },
    { id: 38, name: 'W1 FLOOR LOWER TO LOWEST', cross: { actions: [c('floor', FLOOR.lowerFloorToLowest)], clear: true } },
    { id: 39, name: 'W1 TELEPORT', cross: { actions: [c('teleport')], clear: true, monsterOk: true } },
    { id: 40, name: 'W1 RAISE CEILING + LOWER FLOOR', cross: { actions: [c('ceiling', CEIL.raiseToHighest), c('floor', FLOOR.lowerFloorToLowest)], clear: true } },
    { id: 44, name: 'W1 CEILING LOWER&CRUSH', cross: { actions: [c('ceiling', CEIL.lowerAndCrush)], clear: true } },
    // 52/124: exits DO NOT clear line->special (p_spec.c).
    { id: 52, name: 'W1 EXIT (no clear)', cross: { actions: [c('exit', 0)], clear: false } },
    { id: 53, name: 'W1 PLAT PERPETUAL RAISE', cross: { actions: [c('plat', PLAT.perpetualRaise, 0)], clear: true } },
    { id: 54, name: 'W1 PLAT STOP', cross: { actions: [c('stopPlat')], clear: true } },
    { id: 56, name: 'W1 FLOOR RAISE CRUSH', cross: { actions: [c('floor', FLOOR.raiseFloorCrush)], clear: true } },
    { id: 57, name: 'W1 CEILING CRUSH STOP', cross: { actions: [c('crushStop')], clear: true } },
    { id: 58, name: 'W1 FLOOR RAISE 24', cross: { actions: [c('floor', FLOOR.raiseFloor24)], clear: true } },
    { id: 59, name: 'W1 FLOOR RAISE 24&CHANGE', cross: { actions: [c('floor', FLOOR.raiseFloor24AndChange)], clear: true } },
    { id: 100, name: 'W1 BUILD STAIRS TURBO 16', cross: { actions: [c('stairs', STAIR.turbo16)], clear: true } },
    { id: 104, name: 'W1 TURN TAG LIGHTS OFF', cross: { actions: [c('lightsOff')], clear: true } },
    { id: 108, name: 'W1 DOOR BLAZE RAISE', cross: { actions: [c('door', VL.blazeRaise)], clear: true } },
    { id: 109, name: 'W1 DOOR BLAZE OPEN', cross: { actions: [c('door', VL.blazeOpen)], clear: true } },
    { id: 110, name: 'W1 DOOR BLAZE CLOSE', cross: { actions: [c('door', VL.blazeClose)], clear: true } },
    { id: 119, name: 'W1 FLOOR RAISE TO NEAREST', cross: { actions: [c('floor', FLOOR.raiseFloorToNearest)], clear: true } },
    { id: 121, name: 'W1 PLAT BLAZE DWUS', cross: { actions: [c('plat', PLAT.blazeDWUS, 0)], clear: true } },
    { id: 124, name: 'W1 SECRET EXIT (no clear; use-side no-op, side-1 gate exception)', cross: { actions: [c('exit', 1)], clear: false } },
    // 125: clear ONLY inside the !player branch (monsterOnly + clear).
    { id: 125, name: 'W1 TELEPORT MONSTER-ONLY', cross: { actions: [c('teleport')], clear: true, monsterOk: true, monsterOnly: true } },
    { id: 130, name: 'W1 FLOOR RAISE TURBO', cross: { actions: [c('floor', FLOOR.raiseFloorTurbo)], clear: true } },
    { id: 141, name: 'W1 CEILING SILENT CRUSH&RAISE', cross: { actions: [c('ceiling', CEIL.silentCrushAndRaise)], clear: true } },

    // ---- cross GR (clear absent) ----
    { id: 72, name: 'GR CEILING LOWER&CRUSH', cross: { actions: [c('ceiling', CEIL.lowerAndCrush)] } },
    { id: 73, name: 'GR CEILING CRUSH&RAISE', cross: { actions: [c('ceiling', CEIL.crushAndRaise)] } },
    { id: 74, name: 'GR CEILING CRUSH STOP', cross: { actions: [c('crushStop')] } },
    { id: 75, name: 'GR DOOR CLOSE', cross: { actions: [c('door', VL.close)] } },
    { id: 76, name: 'GR DOOR CLOSE 30 THEN OPEN', cross: { actions: [c('door', VL.close30ThenOpen)] } },
    { id: 77, name: 'GR CEILING FAST CRUSH&RAISE', cross: { actions: [c('ceiling', CEIL.fastCrushAndRaise)] } },
    { id: 79, name: 'GR LIGHT ON 35', cross: { actions: [c('lightOn', 35)] } },
    { id: 80, name: 'GR LIGHT ON BRIGHTEST NEAR', cross: { actions: [c('lightOn', 0)] } },
    { id: 81, name: 'GR LIGHT ON 255', cross: { actions: [c('lightOn', 255)] } },
    { id: 82, name: 'GR FLOOR LOWER TO LOWEST', cross: { actions: [c('floor', FLOOR.lowerFloorToLowest)] } },
    { id: 83, name: 'GR FLOOR LOWER', cross: { actions: [c('floor', FLOOR.lowerFloor)] } },
    { id: 84, name: 'GR FLOOR LOWER&CHANGE', cross: { actions: [c('floor', FLOOR.lowerAndChange)] } },
    { id: 86, name: 'GR DOOR OPEN', cross: { actions: [c('door', VL.open)] } },
    { id: 87, name: 'GR PLAT PERPETUAL RAISE', cross: { actions: [c('plat', PLAT.perpetualRaise, 0)] } },
    { id: 88, name: 'GR LIFT DWUS', cross: { actions: [c('plat', PLAT.downWaitUpStay, 0)], monsterOk: true } },
    { id: 89, name: 'GR PLAT STOP', cross: { actions: [c('stopPlat')] } },
    { id: 90, name: 'GR DOOR RAISE', cross: { actions: [c('door', VL.normal)] } },
    { id: 91, name: 'GR FLOOR RAISE', cross: { actions: [c('floor', FLOOR.raiseFloor)] } },
    { id: 92, name: 'GR FLOOR RAISE 24', cross: { actions: [c('floor', FLOOR.raiseFloor24)] } },
    { id: 93, name: 'GR FLOOR RAISE 24&CHANGE', cross: { actions: [c('floor', FLOOR.raiseFloor24AndChange)] } },
    { id: 94, name: 'GR FLOOR RAISE CRUSH', cross: { actions: [c('floor', FLOOR.raiseFloorCrush)] } },
    { id: 95, name: 'GR PLAT RAISE NEAREST&CHANGE', cross: { actions: [c('plat', PLAT.raiseToNearestAndChange, 0)] } },
    { id: 96, name: 'GR FLOOR RAISE TO TEXTURE', cross: { actions: [c('floor', FLOOR.raiseToTexture)] } },
    { id: 97, name: 'GR TELEPORT', cross: { actions: [c('teleport')], monsterOk: true } },
    { id: 98, name: 'GR FLOOR TURBO LOWER', cross: { actions: [c('floor', FLOOR.turboLower)] } },
    { id: 105, name: 'GR DOOR BLAZE RAISE', cross: { actions: [c('door', VL.blazeRaise)] } },
    { id: 106, name: 'GR DOOR BLAZE OPEN', cross: { actions: [c('door', VL.blazeOpen)] } },
    { id: 107, name: 'GR DOOR BLAZE CLOSE', cross: { actions: [c('door', VL.blazeClose)] } },
    { id: 120, name: 'GR PLAT BLAZE DWUS', cross: { actions: [c('plat', PLAT.blazeDWUS, 0)] } },
    { id: 126, name: 'GR TELEPORT MONSTER-ONLY (no clear)', cross: { actions: [c('teleport')], monsterOk: true, monsterOnly: true } },
    { id: 128, name: 'GR FLOOR RAISE TO NEAREST', cross: { actions: [c('floor', FLOOR.raiseFloorToNearest)] } },
    { id: 129, name: 'GR FLOOR RAISE TURBO', cross: { actions: [c('floor', FLOOR.raiseFloorTurbo)] } },

    // ---- shoot (P_ShootSpecialLine; ChangeSwitchTexture unconditional) ----
    { id: 24, name: 'SHOOT FLOOR RAISE (switch)', shoot: { actions: [c('floor', FLOOR.raiseFloor)], thenSwitch: 0 } },
    { id: 46, name: 'SHOOT DOOR OPEN (button, monster-allowed)', shoot: { actions: [c('door', VL.open)], thenSwitch: 1 } },
    { id: 47, name: 'SHOOT PLAT RAISE NEAREST&CHANGE (switch)', shoot: { actions: [c('plat', PLAT.raiseToNearestAndChange, 0)], thenSwitch: 0 } },

    // ---- spawn-only ----
    { id: 48, name: 'SCROLL WALL SIDE 1 (spawn-collected, not dispatched)', scroll: true }
  ];
  for (const e of entries) {
    if (t[e.id] !== null) {
      throw new Error(`specials-table: duplicate line special ${e.id}`);
    }
    t[e.id] = e;
  }
  return t;
}

export const LINE_SPECIALS: readonly (LineSpecialEntry | null)[] =
  Object.freeze(buildLineTable());

/** Numbers 1..141 with NO case in any 1.10 dispatcher (R05 §2 — grep of
 * every p_switch.c/p_spec.c switch confirms zero occurrences). */
export const LINE_SPECIALS_EXCLUDED: readonly ExcludedEntry[] = Object.freeze([
  { id: 78, reason: 'no case in any 1.10 dispatcher (p_switch.c/p_spec.c census: unassigned)' },
  { id: 85, reason: 'no case in any 1.10 dispatcher (p_switch.c/p_spec.c census: unassigned)' }
]);

/** The 17-id sector table (15 registered, 6/15 excluded below). */
function buildSectorTable(): (SectorSpecialEntry | null)[] {
  const t: (SectorSpecialEntry | null)[] = new Array<SectorSpecialEntry | null>(
    MAX_SECTOR_SPECIAL + 1
  ).fill(null);
  const entries: readonly SectorSpecialEntry[] = [
    { id: 1, name: 'FLICKERING LIGHTS', spawn: { action: 'lightFlash' }, clearTo: 0 },
    { id: 2, name: 'STROBE FAST', spawn: { action: 'strobe', arg: FASTDARK }, clearTo: 0 },
    { id: 3, name: 'STROBE SLOW', spawn: { action: 'strobe', arg: SLOWDARK }, clearTo: 0 },
    // Death-slime strobe: the spawn pass RE-WRITES 4 (vanilla does this
    // after P_SpawnStrobeFlash cleared it); also feet damage 20 w/ randBypass.
    { id: 4, name: 'STROBE FAST + HURT', spawn: { action: 'strobe', arg: FASTDARK }, clearTo: 4, feet: { damage: 20, randBypass: true } },
    { id: 5, name: 'HELLSLIME DAMAGE', feet: { damage: 10 } },
    { id: 7, name: 'NUKAGE DAMAGE', feet: { damage: 5 } },
    { id: 8, name: 'GLOWING LIGHT', spawn: { action: 'glow' }, clearTo: 0 },
    // Secret sector: totalsecret++ at load, special STAYS 9 until the feet
    // pass (M6-12) counts the find and zeroes it.
    { id: 9, name: 'SECRET SECTOR', spawn: { action: 'secretCount' }, feet: { secret: true } },
    { id: 10, name: 'DOOR CLOSE IN 30', spawn: { action: 'doorCloseIn30' }, clearTo: 0 },
    // E1M8 finale: REGISTERED as data only — behaviour (godmode clear,
    // 20 dmg/32 tics, exit at hp≤10) is M6-12 scope.
    { id: 11, name: 'EXIT SUPER DAMAGE (E1M8 finale — M6-12)', feet: { damage: 20, finale: true } },
    { id: 12, name: 'SYNC STROBE SLOW', spawn: { action: 'strobe', arg: SLOWDARK }, clearTo: 0 },
    { id: 13, name: 'SYNC STROBE FAST', spawn: { action: 'strobe', arg: FASTDARK }, clearTo: 0 },
    { id: 14, name: 'DOOR RAISE IN 5 MINUTES', spawn: { action: 'doorRaiseIn5Mins' }, clearTo: 0 },
    { id: 16, name: 'SUPER HELLSLIME DAMAGE', feet: { damage: 20, randBypass: true } },
    { id: 17, name: 'FIRELIGHT', spawn: { action: 'fireFlicker' }, clearTo: 0 }
  ];
  // sync-flag args (12/13 pass inSync=1 to P_SpawnStrobeFlash) ride in the
  // arg2 of the spawn call built by pspec.ts (action==='strobe' && id>=12).
  for (const e of entries) {
    if (t[e.id] !== null) throw new Error(`specials-table: duplicate sector special ${e.id}`);
    t[e.id] = e;
  }
  return t;
}

export const SECTOR_SPECIALS: readonly (SectorSpecialEntry | null)[] =
  Object.freeze(buildSectorTable());

export const SECTOR_SPECIALS_EXCLUDED: readonly ExcludedEntry[] = Object.freeze([
  { id: 6, reason: 'no case in P_SpawnSpecials nor P_PlayerInSpecialSector (1.10: load no-op; feet pass would I_Error — M6-12 typed throw)' },
  { id: 15, reason: 'no case in P_SpawnSpecials nor P_PlayerInSpecialSector (1.10: load no-op; feet pass would I_Error — M6-12 typed throw)' }
]);

/** Strobe in-sync pin (p_lights.c P_SpawnStrobeFlash 3rd arg): sector
 * specials 12/13 spawn with inSync=1, 2/3/4 with 0. */
export function strobeSyncFlag(sectorSpecial: number): 0 | 1 {
  return sectorSpecial === 12 || sectorSpecial === 13 ? 1 : 0;
}

/* ------------------------------------------------------------------ */
/* Machine-checkable manifest                                          */
/* ------------------------------------------------------------------ */

export interface RegistryManifest {
  /** 139 — every id 1..141 except the excluded {78,85} carries ≥1 route. */
  readonly lineRegistered: number;
  readonly lineExcluded: number;
  readonly lineRouteCounts: {
    readonly use: number;
    readonly cross: number;
    readonly shoot: number;
    readonly scroll: number;
    readonly multiRoute: number;
  };
  readonly lineIds: readonly number[];
  /** 15 — spawn and/or feet registered. */
  readonly sectorRegistered: number;
  readonly sectorExcluded: number;
  readonly sectorIds: readonly number[];
}

export function registryManifest(): RegistryManifest {
  const ids: number[] = [];
  let use = 0;
  let cross = 0;
  let shoot = 0;
  let scroll = 0;
  let multi = 0;
  for (let i = 1; i <= MAX_LINE_SPECIAL; i++) {
    const e = LINE_SPECIALS[i];
    if (!e) continue;
    ids.push(i);
    let routes = 0;
    if (e.use) use++;
    if (e.use) routes++;
    if (e.cross) cross++;
    if (e.cross) routes++;
    if (e.shoot) shoot++;
    if (e.shoot) routes++;
    if (e.scroll) scroll++;
    if (e.scroll) routes++;
    if (routes > 1) multi++;
  }
  const sids: number[] = [];
  for (let i = 1; i <= MAX_SECTOR_SPECIAL; i++) if (SECTOR_SPECIALS[i]) sids.push(i);
  return {
    lineRegistered: ids.length,
    lineExcluded: LINE_SPECIALS_EXCLUDED.length,
    lineRouteCounts: { use, cross, shoot, scroll, multiRoute: multi },
    lineIds: Object.freeze(ids),
    sectorRegistered: sids.length,
    sectorExcluded: SECTOR_SPECIALS_EXCLUDED.length,
    sectorIds: Object.freeze(sids)
  };
}

/* ------------------------------------------------------------------ */
/* unimplementedSpecial — the family-stub recorder                     */
/* ------------------------------------------------------------------ */

export interface UnimplementedEvent {
  readonly fn: string;
  readonly special: number;
  readonly kind: 'line' | 'sector';
  readonly subject: number; // line index or sector index
  readonly arg: number;
  /** EV_DoPlat amount (0 otherwise). */
  readonly amount: number;
  readonly tic: number;
}

/** Cap on the retained log (every call still counts — same idiom as
 * hooks.SlotLog). */
export const UNIMPLEMENTED_LOG_CAP = 4096;

export const unimplementedSpecial = {
  count: 0,
  entries: [] as UnimplementedEvent[],
  /** per-special-number hits (line ids 1..141 and sector ids 1..17 share
   * the space via `kind`; M6-13's "zero hits" gate reads `count`). */
  byLine: new Int32Array(MAX_LINE_SPECIAL + 1),
  bySector: new Int32Array(MAX_SECTOR_SPECIAL + 1),
  byFn: new Map<string, number>()
};

export function resetUnimplementedSpecial(): void {
  unimplementedSpecial.count = 0;
  unimplementedSpecial.entries.length = 0;
  unimplementedSpecial.byLine.fill(0);
  unimplementedSpecial.bySector.fill(0);
  unimplementedSpecial.byFn.clear();
}

/** Family stubs call this: records the hit and lets the coverage test
 * assert "stub hit once per id". Returns nothing; stubs return false
 * (vanilla control flow then leaves switch-arm state untouched). */
export function recordLineStub(
  s: SpecWorld, fn: string, line: number, arg: number, amount = 0
): void {
  const special = s.map.lines.special[line] ?? 0;
  record(s, fn, 'line', special, line, arg, amount);
}

export function recordSectorStub(
  s: SpecWorld, fn: string, sector: number, arg: number
): void {
  const special = s.sectors.special[sector] ?? 0;
  record(s, fn, 'sector', special, sector, arg, 0);
}

function record(
  s: SpecWorld, fn: string, kind: 'line' | 'sector',
  special: number, subject: number, arg: number, amount: number
): void {
  unimplementedSpecial.count++;
  if (kind === 'line' && special >= 0 && special <= MAX_LINE_SPECIAL) {
    unimplementedSpecial.byLine[special] = unimplementedSpecial.byLine[special]! + 1;
  } else if (kind === 'sector' && special >= 0 && special <= MAX_SECTOR_SPECIAL) {
    unimplementedSpecial.bySector[special] = unimplementedSpecial.bySector[special]! + 1;
  }
  unimplementedSpecial.byFn.set(fn, (unimplementedSpecial.byFn.get(fn) ?? 0) + 1);
  if (unimplementedSpecial.entries.length < UNIMPLEMENTED_LOG_CAP) {
    unimplementedSpecial.entries.push({ fn, special, kind, subject, arg, amount, tic: s.leveltime });
  }
}
