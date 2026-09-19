// sim/pspec.ts — special-number registry WIRING + dispatch skeleton
// (p_spec.c + p_switch.c dispatch halves; M6-plan §M6-03). The two giant
// switch statements (P_CrossSpecialLine's ~72 cases, P_UseSpecialLine's
// ~63 cases) live as DATA in specials-table.ts; this module binds the
// registry action ids to the family entry points (stubs until M6-05..11)
// and runs the dispatchers. Replaces pcross.stub.ts: pmap.ts's spechit
// call site now hits pCrossSpecialLine for real (M5-plan §M5-03 /
// M6-plan §0.10).
//
// Dispatch call sites (R05 §Dispatch, p_map.c):
//   cross — P_TryMove spechit loop, `side != oldside` →
//     pCrossSpecialLine(w, linenum, oldside, mover)  (pmap.ts, live);
//   use   — PTR_UseTraverse → pUseSpecialLine(...) — the FULL P_UseSpecialLine
//     (P_UseLines/PathTraverse, cards, buttons) is M6-11's; this is the
//     registry-routing skeleton with the vanilla gate structure;
//   shoot — P_LineAttack traverse → pShootSpecialLine(...) — the line
//     attack call site arrives with M7 weapons.
//
// Tick/load wiring:
//   pSpawnSpecials(state) — called by game.ts gInitGame (map setup, the
//     1.10 site is P_SetupLevel → P_SpawnSpecials, p_setup.c); sector
//     pass + special-48 line collection + activeplats/ceilings/buttonlist
//     init. levelTimer/-timer NOT ported (M6-plan §4 — recorded).
//   pUpdateSpecials(state) — called by game.ts gTicker at the §3.2 slot
//     (replaces the M6-01 ptick.ts placeholder; the updateSpecialsCounts
//     counter stays in ptick.ts so the tick-order test is unmoved).
//   Pic animation (texturetranslation) is renderer-side, not here.
//   P_InitSwitchList: the 1.10 call site is P_SetupLevel (p_setup.c:702);
//     the switchlist build is M6-11's wad/switchlist.ts (pin recorded).
//
// Hot-path discipline (acceptance "zero-alloc hot dispatch"): the CROSS/
// USE/SHOOT tables are module-constant frozen lookup arrays built once
// from the registry; pCrossSpecialLine allocates nothing — primitives
// only, action bodies reached through the frozen FNS map.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';

import { sfxSlot } from './hooks';
import { updateSpecialsCounts } from './ptick';
import { MF_MISSILE } from './thinglinks';
import { ML_SECRET } from './pspec-helpers';

import { evDoDoor, evVerticalDoor, pSpawnDoorCloseIn30, pSpawnDoorRaiseIn5Mins } from './pdoors';
import { activePlats, evDoPlat, evStopPlat } from './pplats';
import { evDoFloor, evBuildStairs, evDoDonut } from './pfloor';
import { activeCeilings, evDoCeiling, evCeilingCrushStop } from './pceilng';
import {
  evLightTurnOn, evStartLightStrobing, evTurnTagLightsOff,
  pSpawnLightFlash, pSpawnStrobeFlash, pSpawnGlowingLight, pSpawnFireFlicker
} from './plights';
import { evTeleport } from './ptelept';
import { pChangeSwitchTexture, evDoLockedDoor } from './pswitch';
import { damageSlot } from './hooks';
import { pRandom } from './prng';
import { gExitLevel, gSecretExitLevel } from './pexit';
import { CF_GODMODE } from './player';

import {
  LINE_SPECIALS, MAX_LINE_SPECIAL, MAX_SECTOR_SPECIAL, SECTOR_SPECIALS,
  strobeSyncFlag
} from './specials-table';
import type { ActionId, ActionSpec, SpawnActionId, TriggerSpec } from './specials-table';

import type { Mover, PMapWorld } from './pmap';
import type { SpecWorld } from './pspec-helpers';

/* Helpers live in pspec-helpers.ts (cycle-free home for the family files);
 * re-exported so `import { pFind* } from './pspec'` reads naturally. */
export {
  sectorLineAt, twoSided, getSector, getNextSector,
  pFindLowestFloorSurrounding, pFindHighestFloorSurrounding,
  pFindNextHighestFloor, pFindLowestCeilingSurrounding,
  pFindHighestCeilingSurrounding, pFindSectorFromLineTag,
  pFindMinSurroundingLight, pspecHelperCounts, resetPspecHelperCounts,
  ML_TWOSIDED, ML_SECRET, MAX_ADJOINING_SECTORS
} from './pspec-helpers';

/* ------------------------------------------------------------------ */
/* pcross.stub.ts replacement: counter + hook slot keep their names      */
/* ------------------------------------------------------------------ */

/** Hook slot; the registry dispatch below IS the body the stub deferred
 * to. The hook still fires for EVERY call (tests observe crossings even
 * for specials with no route on this side). */
export interface PCrossHooks {
  /** p_map.c `P_CrossSpecialLine(linenum, side, thing)` — `side` is the
   * OLD side (p_map.c:530 passes oldside). */
  crossSpecialLine?: (line: number, side: number, thing: Mover) => void;
}

export const pcrossHooks: PCrossHooks = {};

/** Counted bookkeeping, same semantics as the old pcrossCounts (not sim
 * state — hashes never read it). */
export const pcrossCounts = { crossSpecialLine: 0 };

export function resetPcrossCounts(): void {
  pcrossCounts.crossSpecialLine = 0;
}

/** Other dispatcher counts + wiring diagnostics (test instruments). */
export const pspecCounts = {
  useSpecialLine: 0,
  shootSpecialLine: 0,
  /** dispatch attempted with no bound specials world (or a foreign map —
   * pmap unit worlds build no GameState). */
  unboundDispatch: 0,
  /** P_SpawnSpecials hits past MAXLINEANIMS (vanilla: memory corruption;
   * here the extra lines are dropped, same idiom as spechitOverflow). */
  linespecialOverflow: 0,
  /** levelTimer requested (the -avg/-timer parm path) — NOT ported, so
   * this stays 0 forever; kept so the gap is greppable. */
  levelTimer: 0
};

export function resetPspecCounts(): void {
  pspecCounts.useSpecialLine = 0;
  pspecCounts.shootSpecialLine = 0;
  pspecCounts.unboundDispatch = 0;
  pspecCounts.linespecialOverflow = 0;
}

/* ------------------------------------------------------------------ */
/* p_spec.c globals (vanilla file-scope lists; reset per level by        */
/* pSpawnSpecials — the active level binds via bindSpecialsWorld)        */
/* ------------------------------------------------------------------ */

export const MAXBUTTONS = 16; // p_spec.h
// MAXPLATS now LIVES in pplats.ts (M6-06, vanilla defines activeplats in
// p_plats.c); re-exported here for the M6-03 consumers.
export { MAXPLATS, activePlats } from './pplats';
// MAXCEILINGS now LIVES in pceilng.ts (M6-08, vanilla defines
// activeceilings in p_ceilng.c); re-exported here for the M6-03 consumers.
export { MAXCEILINGS, activeCeilings } from './pceilng';
export const MAXLINEANIMS = 64; // p_spec.c
export const BUTTONTIME = 35; // p_spec.h (used by M6-11's P_StartButton)

/** sounds.h sfxenum_t sfx_swtchn (index counting from sfx_None=0). M10
 * replaces id→lump decoding; the id is pinned here for the button tick. */
export const SFX_SWTCHN = 23;

/** bwhere_e (p_spec.h). */
export const BWHERE = { top: 0, middle: 1, bottom: 2 } as const;

/** button_t slot (buttonlist[]). M6-11's P_StartButton fills these; the
 * P_UpdateSpecials tick below is generic and already live. */
export interface ButtonSlot {
  line: number; // −1 = free
  where: number; // BWHERE
  btexture: string; // texture to restore when the timer expires
  btimer: number;
}

export const buttonList: ButtonSlot[] = Array.from(
  { length: MAXBUTTONS },
  () => ({ line: -1, where: 0, btexture: '', btimer: 0 })
);

/** activeplats[] / activeceilings[] — both LIVE in their family files
 * (activeplats pplats.ts M6-06, activeCeilings pceilng.ts M6-08 —
 * re-exported above; the stasis scans index these). */

/** linespeciallist[] / numlinespecials (special-48 scroll collection). */
export const lineSpecialList = { lines: new Int32Array(MAXLINEANIMS), count: 0 };

let boundWorld: SpecWorld | null = null;

/** Bind the active level's specials world (pSpawnSpecials does it; tests
 * may bind explicitly). Null ⇒ dispatchers count and bail (pmap unit
 * worlds have no GameState). */
export function bindSpecialsWorld(s: SpecWorld | null): void {
  boundWorld = s;
}

/** Read handle for the bound level (puser.ts's feet call site — the live
 * sector SoA the vanilla call-site gate reads is per-state, unreachable
 * from the PMapWorld-only P_PlayerThink signature otherwise). */
export function boundSpecialsWorld(): SpecWorld | null {
  return boundWorld;
}

/* ------------------------------------------------------------------ */
/* Action binding: registry action ids → family entry points            */
/* ------------------------------------------------------------------ */

type ActFn = (
  s: SpecWorld, line: number, side: number, mover: Mover | null,
  arg: number, amount: number
) => boolean;

/** Frozen lookup map — the only "switch" left, over ~15 ACTION KINDS,
 * reached by data (no per-special code). */
const FNS: Record<ActionId, ActFn> = Object.freeze({
  door: (s, line, _side, _m, arg) => evDoDoor(s, line, arg),
  floor: (s, line, _side, _m, arg) => evDoFloor(s, line, arg),
  plat: (s, line, _side, _m, arg, amount) => evDoPlat(s, line, arg, amount),
  ceiling: (s, line, _side, _m, arg) => evDoCeiling(s, line, arg),
  stairs: (s, line, _side, _m, arg) => evBuildStairs(s, line, arg),
  donut: (s, line) => evDoDonut(s, line),
  lightOn: (s, line, _side, _m, arg) => evLightTurnOn(s, line, arg),
  strobe: (s, line) => evStartLightStrobing(s, line),
  lightsOff: (s, line) => evTurnTagLightsOff(s, line),
  crushStop: (s, line) => evCeilingCrushStop(s, line),
  stopPlat: (s, line) => evStopPlat(s, line),
  teleport: (s, line, side, mover) => evTeleport(s, line, side, mover),
  verticalDoor: (s, line, _side, mover) => evVerticalDoor(s, line, mover),
  lockedDoor: (s, line, _side, mover, arg) => evDoLockedDoor(s, line, arg, mover),
  exit: (s, _line, _side, _m, arg) => {
    // G_ExitLevel/G_SecretExitLevel proxies (D013(e)/D013(g), pexit.ts):
    // exitSlot latches exitRequest; G_ExitLevel CLEARS specialexit
    // (g_game.c:1004), G_SecretExitLevel sets it (g_game.c:1015).
    if (arg === 1) gSecretExitLevel(s);
    else gExitLevel(s);
    return true;
  }
});

function runActions(
  s: SpecWorld, acts: readonly ActionSpec[], line: number,
  side: number, mover: Mover | null
): boolean {
  let res = true;
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]!;
    // multi-action entries (only cross 40): EVERY action runs; `res`
    // reports the last one (vanilla case bodies ignore the earlier
    // return values — the pairs are fire-and-continue).
    res = FNS[a.action](s, line, side, mover, a.arg ?? 0, a.amount ?? 0);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* Prebuilt dispatch tables (registry × 3 sides), built once, frozen    */
/* ------------------------------------------------------------------ */

export interface Route {
  readonly actions: readonly ActionSpec[];
  readonly clear: boolean;
  readonly monsterOk: boolean;
  readonly monsterOnly: boolean;
  readonly monsterUseOk: boolean;
  readonly gateSwitch: number; // -1 none
  readonly thenSwitch: number; // -1 none
  readonly switchBefore: number; // -1 none
}

function routeOf(t: TriggerSpec | undefined): Route | null {
  if (!t) return null;
  return Object.freeze({
    actions: t.actions,
    clear: t.clear === true,
    monsterOk: t.monsterOk === true,
    monsterOnly: t.monsterOnly === true,
    monsterUseOk: t.monsterUseOk === true,
    gateSwitch: t.gateSwitch ?? -1,
    thenSwitch: t.thenSwitch ?? -1,
    switchBefore: t.switchBefore ?? -1
  });
}

function buildRoutes(
  get: (e: NonNullable<(typeof LINE_SPECIALS)[number]>) => TriggerSpec | undefined
): readonly (Route | null)[] {
  const t: (Route | null)[] = new Array<Route | null>(MAX_LINE_SPECIAL + 1).fill(null);
  for (let i = 1; i <= MAX_LINE_SPECIAL; i++) {
    const e = LINE_SPECIALS[i];
    if (e) t[i] = routeOf(get(e));
  }
  return Object.freeze(t);
}

const CROSS: readonly (Route | null)[] = buildRoutes((e) => e.cross);
const USE: readonly (Route | null)[] = buildRoutes((e) => e.use);
const SHOOT: readonly (Route | null)[] = buildRoutes((e) => e.shoot);

/** Test-visible handle proving the hot tables are built ONCE (frozen
 * module constants — the zero-alloc dispatch claim's structural proof). */
export const dispatchTables: {
  readonly cross: readonly (Route | null)[];
  readonly use: readonly (Route | null)[];
  readonly shoot: readonly (Route | null)[];
} = Object.freeze({ cross: CROSS, use: USE, shoot: SHOOT });

/** p_map.c PIT_CheckLine-style: vanilla gates the six missile mobj TYPES
 * (MT_ROCKET..MT_BRUISERSHOT); in 1.10 every MF_MISSILE mobj is exactly
 * one of those six, so the flag test is equivalent until the M7 mobj
 * roster adds types worth discriminating (deviation note). */
function isMissileMover(t: Mover): boolean {
  return (t.flags & MF_MISSILE) !== 0;
}

/* ------------------------------------------------------------------ */
/* P_CrossSpecialLine — p_spec.c (the pcross.stub.ts call site)         */
/* ------------------------------------------------------------------ */

/**
 * `P_CrossSpecialLine(linenum, side, thing)`. `side` = the OLD side
 * (p_map.c:530). The M5-03 counter + hook keep their exact stub-era
 * semantics; the registry dispatch is now live:
 *  • non-player: the six missile types never fire (MF_MISSILE proxy);
 *    only the ok-list {4,10,88,39,97,125,126} passes (R05 §1.1);
 *  • monsterOnly 125/126: players fall through HARMLESSLY — 125 keeps
 *    its special (the clear is inside the !player branch);
 *  • W1 entries clear line->special AFTER the actions (52/124 never);
 *  • GR entries clear nothing.
 */
export function pCrossSpecialLine(
  w: PMapWorld, line: number, side: number, thing: Mover
): void {
  pcrossCounts.crossSpecialLine++;
  pcrossHooks.crossSpecialLine?.(line, side, thing);

  const s = boundWorld;
  if (!s || s.map !== w.map) {
    pspecCounts.unboundDispatch++;
    return;
  }
  const special = s.map.lines.special[line]!;
  const r = special <= MAX_LINE_SPECIAL ? CROSS[special] : null;
  if (!r) return;

  if (!thing.player) {
    if (isMissileMover(thing)) return;
    if (!r.monsterOk) return;
  }
  if (r.monsterOnly && thing.player) return;

  runActions(s, r.actions, line, side, thing);
  if (r.clear) s.map.lines.special[line] = 0;
}

/* ------------------------------------------------------------------ */
/* P_ShootSpecialLine — p_spec.c IMPACT specials                        */
/* ------------------------------------------------------------------ */

/** `P_ShootSpecialLine(thing, line)` — non-player shooters fire ONLY
 * special 46; 24/46/47 then run UNCONDITIONALLY incl. the button swap
 * (p_spec.c has no if-action gate on the shoot side). Call site:
 * P_LineAttack's traverse (M7 weapons). */
export function pShootSpecialLine(
  s: SpecWorld, thing: Mover, line: number
): void {
  pspecCounts.shootSpecialLine++;
  const special = s.map.lines.special[line]!;
  if (!thing.player && special !== 46) return;
  const r = special <= MAX_LINE_SPECIAL ? SHOOT[special] : null;
  if (!r) return;
  runActions(s, r.actions, line, 0, thing);
  if (r.thenSwitch >= 0) pChangeSwitchTexture(s, line, r.thenSwitch);
}

/* ------------------------------------------------------------------ */
/* P_UseSpecialLine — p_switch.c dispatch skeleton                      */
/* ------------------------------------------------------------------ */

/**
 * Registry-driven `P_UseSpecialLine(thing, line, side)` skeleton
 * (M6-11 owns the full p_switch.c machinery — P_UseLines/PathTraverse,
 * switchlist, cards/messages; the gate structure below is vanilla):
 *  • side==1 fires NOTHING except the 124 fall-through (a commented-out
 *    sliding-door case in 1.10 — a pure no-op here, R05 §2);
 *  • non-players: ML_SECRET vetoes, then only {1,32,33,34} may use;
 *  • S1/SR: `if (action) P_ChangeSwitchTexture(line, useAgain)` — while
 *    the stub actions return false, switches stay armed (the faithful
 *    "failed action keeps the switch" flow);
 *  • 138/139: ChangeSwitchTexture unconditional;
 *  • 11/51: ChangeSwitchTexture BEFORE the exit call;
 *  • manuals never disarm at this level (EV_VerticalDoor owns that).
 * Returns the vanilla boolean (false only via the gates).
 */
export function pUseSpecialLine(
  s: SpecWorld, thing: Mover, line: number, side: number
): boolean {
  pspecCounts.useSpecialLine++;
  const special = s.map.lines.special[line]!;

  if (side !== 0 && special !== 124) return false;

  if (!thing.player) {
    if ((s.map.lines.flags[line]! & ML_SECRET) !== 0) return false;
    const r0 = special <= MAX_LINE_SPECIAL ? USE[special] : null;
    if (!r0 || !r0.monsterUseOk) return false;
  }

  const r = special <= MAX_LINE_SPECIAL ? USE[special] : null;
  if (!r) return true; // vanilla: no case, falls through, returns true

  if (r.switchBefore >= 0) pChangeSwitchTexture(s, line, r.switchBefore);
  const res = runActions(s, r.actions, line, side, thing);
  if (r.gateSwitch >= 0) {
    if (res) pChangeSwitchTexture(s, line, r.gateSwitch);
  } else if (r.thenSwitch >= 0) {
    pChangeSwitchTexture(s, line, r.thenSwitch);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* P_SpawnSpecials — p_spec.c SPECIAL SPAWNING (map setup)              */
/* ------------------------------------------------------------------ */

const SPAWN_FNS: Record<SpawnActionId, (s: SpecWorld, sector: number, arg: number, special: number) => void> =
  Object.freeze({
    lightFlash: (s, sec) => pSpawnLightFlash(s, sec),
    strobe: (s, sec, arg, special) => pSpawnStrobeFlash(s, sec, arg, strobeSyncFlag(special)),
    glow: (s, sec) => pSpawnGlowingLight(s, sec),
    fireFlicker: (s, sec) => pSpawnFireFlicker(s, sec),
    doorCloseIn30: (s, sec) => pSpawnDoorCloseIn30(s, sec),
    doorRaiseIn5Mins: (s, sec) => pSpawnDoorRaiseIn5Mins(s, sec, sec),
    secretCount: (s) => {
      s.totalsecret++; // g_game.c totalsecret — hashed run global (M6-01)
    }
  });

/**
 * `P_SpawnSpecials()` — AFTER the map has been loaded; called by
 * gInitGame. Vanilla order kept: sector specials pass, then the special-48
 * line collection, then activeceilings/activeplats/buttonlist init.
 * levelTimer/-timer parms: NOT ported (M6-plan §4).
 *
 * Placement deviation (recorded): the `sector->special = 0` the spawner
 * BODIES run in vanilla (and case 4's re-write to 4) is executed HERE,
 * from the registry's `clearTo`, so post-load special values are exact
 * even while the spawner bodies are stubs; M6-05/09 real bodies stay
 * clear-agnostic (a double clear is idempotent, case 4 order preserved:
 * spawn first, write after).
 */
export function pSpawnSpecials(s: SpecWorld): void {
  bindSpecialsWorld(s);

  // Init special SECTORs (ascending sector index, p_spec.c).
  for (let i = 0; i < s.sectors.count; i++) {
    const sp = s.sectors.special[i]!;
    if (!sp) continue;
    const e = sp <= SECTOR_SPECIALS.length - 1 ? SECTOR_SPECIALS[sp] : null;
    if (!e || !e.spawn) continue; // 5/7/11/16 (and 6/15): no spawn case
    SPAWN_FNS[e.spawn.action](s, i, e.spawn.arg ?? 0, sp);
    if (e.clearTo !== undefined) s.sectors.special[i] = e.clearTo;
  }

  // Init line EFFECTs — only special 48 is collected (p_spec.c).
  lineSpecialList.count = 0;
  const lines = s.map.lines;
  for (let i = 0; i < lines.count; i++) {
    if (lines.special[i] === 48) {
      if (lineSpecialList.count < MAXLINEANIMS) {
        lineSpecialList.lines[lineSpecialList.count++] = i;
      } else {
        pspecCounts.linespecialOverflow++;
      }
    }
  }

  // Init other misc stuff.
  activePlats.fill(null);
  activeCeilings.fill(null);
  for (const b of buttonList) {
    b.line = -1;
    b.where = 0;
    b.btexture = '';
    b.btimer = 0;
  }
  // vanilla: P_InitSlidingDoorFrames() — `#if 0`'d in 1.10, not ported.
}

/* ------------------------------------------------------------------ */
/* P_UpdateSpecials — p_spec.c per-tic (replaces the ptick.ts slot body) */
/* ------------------------------------------------------------------ */

/**
 * Per-tic specials update at the §3.2 slot. Sections:
 *  • level timer: NOT ported (pspecCounts.levelTimer stays 0);
 *  • flat/texture pic animation: renderer-side (texturetranslation is an
 *    r_data concern — M3/M4), not sim state;
 *  • ANIMATE LINE SPECIALS: special 48 pans side sidenum[0]'s
 *    textureoffset by FRACUNIT (`| 0` int32 wrap, pinned);
 *  • DO BUTTONS: generic timer/restore loop — the slots are filled by
 *    M6-11's P_StartButton (delegation noted in the plan).
 * The updateSpecialsCounts counter (ptick.ts) keeps counting the slot.
 */
export function pUpdateSpecials(s: SpecWorld): void {
  updateSpecialsCounts.calls++;

  for (let i = 0; i < lineSpecialList.count; i++) {
    const line = s.map.lines;
    const ln = lineSpecialList.lines[i]!;
    if (line.special[ln] === 48) {
      const side = line.sideNumFront[ln]!;
      if (side >= 0) {
        s.map.sides.offsetX[side] = (s.map.sides.offsetX[side]! + FRACUNIT) | 0;
      }
    }
  }

  for (let i = 0; i < MAXBUTTONS; i++) {
    const b = buttonList[i]!;
    if (!b.btimer) continue;
    b.btimer--;
    if (b.btimer) continue;
    const side = s.map.lines.sideNumFront[b.line]!;
    if (side >= 0) {
      const sides = s.map.sides;
      if (b.where === BWHERE.top) (sides.topTexture as string[])[side] = b.btexture;
      else if (b.where === BWHERE.middle) (sides.midTexture as string[])[side] = b.btexture;
      else (sides.bottomTexture as string[])[side] = b.btexture;
    }
    const sec = side >= 0 ? s.map.sides.sector[side]! : -1;
    sfxButton(s, sec);
    b.line = -1;
    b.where = 0;
    b.btexture = '';
  }
}

/** S_StartSound(&buttonlist[i].soundorg, sfx_swtchn) — sector soundorg
 * (P_GroupLines centre), z 0 (vanilla reads stack garbage there; 0 pinned). */
function sfxButton(s: SpecWorld, sector: number): void {
  const x = sector >= 0 ? s.map.sectors.soundOrgX[sector]! : 0;
  const y = sector >= 0 ? s.map.sectors.soundOrgY[sector]! : 0;
  sfxSlot(s.hooks, SFX_SWTCHN, x, y, 0, s.leveltime);
}

/* ------------------------------------------------------------------ */
/* P_PlayerInSpecialSector — p_spec.c:1005-1069 (M6-12 feet section)     */
/* ------------------------------------------------------------------ */

/** d_player.h:121-130 powertype_t pw_ironfeet (envirosuit) — the powers[]
 * slot the damage gate reads. The powers ARRAY itself is M7's (items);
 * the feet section only READS slot 2 when the player carries one (see
 * {@link FeetPlayer.powers}). */
export const PW_IRONFEET = 2;

/** The player_t slice the feet dispatch touches (structural — Player
 * satisfies it; `linkSlot` is the ThingLinks-slot damage-thing namespace
 * pmap.ts's crusher cadence already uses, hooks.ts header). */
export interface FeetPlayer {
  mo: { x: number; y: number; z: number; linkSlot?: number };
  health: number;
  cheats: number;
  /** d_player.h `powers[numpowers]`. OPTIONAL here on purpose: player_t's
   * powers array is M7-owned surface (item pickups) — M6-plan wave table
   * keeps player.ts out of this task's files; tests (and M7's field) set
   * it structurally. Absent ⇒ no power. NOT hashed until M7 (deviation
   * note: vanilla powers live in the hashed player_t). */
  powers?: readonly number[];
}

/** Vanilla `I_Error("P_PlayerInSpecialSector: unknown special %i")`
 * (p_spec.c:1066-1067) as a typed throw (M6-plan §M6-12 acceptance); the
 * census-excluded specials 6/15 have NO case in the vanilla switch and
 * reach here the first tic a player stands grounded in them. */
export class UnknownSectorSpecialError extends Error {
  constructor(readonly special: number) {
    super(`P_PlayerInSpecialSector: unknown special ${special}`);
    this.name = 'UnknownSectorSpecialError';
  }
}

/** Feet-dispatch instruments (not sim state — never hashed). */
export const feetCounts = {
  /** vanilla call-site hits (p_user.c:274-275 `if (sector->special)`). */
  calls: 0,
  /** dispatch attempted with no bound/foreign-map specials world. */
  unbound: 0,
  /** the I_Error path (typed throw), counted before throwing. */
  unknownSpecial: 0
};

export function resetFeetCounts(): void {
  feetCounts.calls = 0;
  feetCounts.unbound = 0;
  feetCounts.unknownSpecial = 0;
}

/**
 * `P_PlayerInSpecialSector(player)` — p_spec.c:1009-1069, called every
 * tic from the puser.ts call site (p_user.c:274-275) while the live
 * sector special is nonzero. Vanilla structure kept line-for-line:
 *  • grounded gate `mo->z != sector->floorheight` → return
 *    ("Falling, not all the way down yet?", p_spec.c:1013-1015);
 *  • case 5 HELLSLIME 10 dmg / case 7 NUKAGE 5 dmg /
 *    case 16+4 SUPER HELLSLIME・STROBE HURT 20 dmg — all gated
 *    `(!powers[pw_ironfeet] || (P_Random()<5)) && !(leveltime&0x1f)`
 *    (the P_Random draw happens on EVERY grounded tic with ironfeet,
 *    never without — C's short-circuit, p_spec.c:1023-1043);
 *  • case 9 SECRET: secretcount++ (the single-player `player->
 *    secretcount` proxy lives on state.secretcount, M6-01) and the
 *    sector special zeroes (p_spec.c:1047-1050); no message in 1.10
 *    (R05 §5 — intermission screen only);
 *  • case 11 EXIT SUPER DAMAGE (E1M8 finale): godmode bit CLEARED
 *    unconditionally (:1056), 20 dmg/32 tics, `health <= 10` →
 *    G_ExitLevel (:1061-1062). Health never drops while the damage
 *    slot is a no-op (M7) — hp-clamp fixtures drive the exit;
 *  • default: typed throw + counter (the I_Error above).
 *
 * `sector` is the mover's current sector (the caller's sectorAtPoint —
 * vanilla's `player->mo->subsector->sector`, same value; passed to keep
 * one BSP walk per tic, deviation noted).
 */
export function pPlayerInSpecialSector(
  s: SpecWorld, p: FeetPlayer, sector: number
): void {
  feetCounts.calls++;

  // Falling, not all the way down yet? (p_spec.c:1013)
  if (p.mo.z !== s.sectors.floorZ[sector]) return;

  const special = s.sectors.special[sector]!;
  const e = special <= MAX_SECTOR_SPECIAL ? SECTOR_SPECIALS[special] : null;
  const f = e?.feet;
  if (!f) {
    feetCounts.unknownSpecial++;
    throw new UnknownSectorSpecialError(special); // p_spec.c:1066
  }

  if (f.secret) {
    s.secretcount++; // player->secretcount++ (p_spec.c:1050)
    s.sectors.special[sector] = 0; // sector->special = 0
    return;
  }

  if (f.finale) {
    // p_spec.c:1054-1063 — no ironfeet/cadence-or gate: godmode is
    // stripped, damage lands on the plain 32-tic cadence.
    p.cheats &= ~CF_GODMODE;
    if ((s.leveltime & 0x1f) === 0) {
      damageSlot(s.hooks, p.mo.linkSlot ?? -1, f.damage ?? 20, null, s.leveltime);
    }
    if (p.health <= 10) gExitLevel(s); // :1061-1062
    return;
  }

  const ironfeet = (p.powers?.[PW_IRONFEET] ?? 0) !== 0;
  // `||` short-circuit: randBypass draws ONLY when ironfeet is active.
  if (!ironfeet || (f.randBypass === true && pRandom(s.rng) < 5)) {
    if ((s.leveltime & 0x1f) === 0) {
      damageSlot(s.hooks, p.mo.linkSlot ?? -1, f.damage ?? 0, null, s.leveltime);
    }
  }
}
