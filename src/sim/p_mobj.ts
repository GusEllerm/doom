// sim/p_mobj.ts — the mobj runtime (linuxdoom-1.10 p_mobj.c, M7-02,
// M7-plan §M7-02). Spawn/remove, the P_SetMobjState 0-tic cascade machine,
// P_MobjThinker (momentum via M5-05's pXYMovement/pZMovement + the state/
// tics cycle), P_SpawnMapThing + the level-load thing pass, and the
// puff/blood Z_MISC spawners.
//
// THINKER ORDER (documented rule): mobj thinkers join the ONE M6-01 arena
// (ptick.ts). Vanilla keeps specials and mobjs on the single thinkercap
// list, insertion order = P_AddThinker order; the port preserves that —
// P_SpawnThings appends the map-things in THINGS order during
// P_SetupLevel's spawn phase, THEN P_SpawnSpecials appends the line/sector
// movers, so arena order interleaves specials+mobjs exactly like vanilla
// list order at level load. (Deviation carried from M5/M6: the PLAYER
// mover ticks at the P_PlayerThink position, not in the arena, until
// M7-03 makes it a real mobj; and mid-tic adds tick NEXT tic, ARCH §3.2.)
//
// GRID BINDING: load-time map things reuse the static ThingLinks slots
// built by buildThingLinks (same filter: starts → solo bit → skill bit →
// doomednum table → MF_NOBLOCKMAP), so slot i ↔ thing spawn #i, and the
// per-block iteration order is vanilla's prepend chain to the letter
// (thinglinks.ts header). Dynamic mobjs (puffs, blood, missiles, and the
// MF_NOBLOCKMAP markers) spawn into dynamic slots; P_TryMove relinks
// those every accepted move (P_SetThingPosition link-only rule,
// ARCH §3.5.5). Static-slot mobjs (decor/items) never move in M7.
//
// HASHING: each live mobj contributes ARCHITECTURE §3.4's words
// [x, y, z, stateId, tics, flags, health, targetIndex, movedir|movecount|damage]
// (9th word M8-02, re-bless reason "M8 monster fields") through its
// thinker's hashWords (arena order) — hashState needed no new field. The
// words are refreshed at spawn and at every thinker pass; grid slots own
// x/y/z for slot-bound mobjs so crusher writes stay visible.
//
// Deviations (pinned, tested):
//  - P_SpawnMapThing unknown doomednum: vanilla I_Error → warn-once +
//    skip (counted, R12), keeping custom/trimmed maps loadable.
//  - doomednum ≤ 4 (player starts): the record is captured; P_SpawnPlayer
//    itself is M7-03 (game.ts owns the M5 player stub spawn).
//  - P_SetMobjState's do/while loop gets a MAX_STATE_CHAIN iteration guard
//    (states.ts documents: vanilla would hang) and a removed-mobj bail
//    (vanilla would touch freed memory).
//  - P_NightmareRespawn / P_RespawnSpecials respawn paths are inert:
//    respawnmonsters/deathmatch have no source pre-M9 (M7-02 ships the
//    item-queue bookkeeping P_RemoveMobj performs regardless of mode).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG45, FRACUNIT } from '../core/constants';
import { stateAt, stateNext, S, MAX_STATE_CHAIN } from '../wad/info/states';
import { mobjinfo, MT, MF, DOOMEDNUM_TO_MT } from '../wad/info/mobjinfo';
import { ACT, ACT_NONE, dispatchAction } from './a_actions';

import { sectorAtPoint } from './bsp';
import { mapThingAt, type RuntimeMap } from './map';
import { pXYMovement, pZMovement, pmoveHooks, type MoveMobj } from './pmove';
import {
  allocThingSlot,
  thingSetPosition,
  thingUnsetPosition,
  skillBit,
  MTF_AMBUSH,
  MTF_NOTSINGLEPLAYER,
} from './thinglinks';
import { pAddThinker, pRemoveThinker, type Thinker } from './ptick';
import { pRandom } from './prng';
import type { GameState, LiveSectors } from './state';
import type { MobjRef } from './hooks';

/* ------------------------------------------------------------------ */
/* Constants (p_mobj.c / p_local.h)                                     */
/* ------------------------------------------------------------------ */

/** p_mobj.h:212 ONFLOORZ (MININT) / ONCEILINGZ (MAXINT) z tokens. */
export const ONFLOORZ = -2147483648;
export const ONCEILINGZ = 2147483647;

/** p_mobj.c:660 ITEMQUESIZE / MAXPLAYERS. */
export const ITEMQUESIZE = 128;
export const MAXPLAYERS = 4;

/** p_enemy.c:50-64 dirtype_t DI_NODIR = 8 (the enum lives with
 * P_NewChaseDir, M8-04's file — the mobj field default is pinned HERE so
 * no M8-02 file needs p_enemy). Vanilla Z_Malloc leaves a spawned
 * movedir/movecount undefined; the port pins DI_NODIR/0 (M8-plan §M8-02
 * acceptance 1) — behavior-identical pre-M8-04, nothing reads them yet. */
export const DI_NODIR = 8;

/** p_inter.c:47-48 MELEERANGE/MISSILERANGE — `attackrange` lives HERE until
 * p_inter.ts (M7-04) takes ownership; P_SpawnPuff's melee test reads it. */
export const MELEERANGE = 64 * FRACUNIT;
export const MISSILERANGE = 32 * 64 * FRACUNIT;
/** The p_local.h `attackrange` global (P_AimLineAttack writes it, M7-04+). */
export const attackRange = { value: MISSILERANGE };

/* ------------------------------------------------------------------ */
/* mobj_t (the live object; ARCH §2.3 "plain object, fields per R06")   */
/* ------------------------------------------------------------------ */

/** mapthing_t as captured at spawn (P_SpawnMobj's `spawnpoint` half). */
export interface SpawnPoint {
  /** map units (NOT fixed) — P_NightmareRespawn/P_RespawnSpecials `<< FRACBITS` */
  x: number;
  y: number;
  angle: number;
  /** doomednum */
  type: number;
  /** MTF_* option bits */
  options: number;
}

/**
 * The mobj_t slice this port's mechanics read/write. Satisfies
 * {@link MoveMobj} (pmove.ts) so P_XYMovement/P_ZMovement run the mobj
 * through the exact M5-05-tested code path. `words` is the §3.4 hash
 * payload, aliased into the thinker.
 */
export interface Mobj extends MoveMobj {
  /** marker for the pmove hook adapters (duck-typed isMobj test) */
  readonly isMobj: true;
  /** owning runtime */
  readonly rt: MobjRuntime;
  /** MT_* index (mobjinfo[]) */
  type: number;
  /** fixed momentum + position (mobj_t momx/momy/momz) */
  momx: number;
  momy: number;
  momz: number;
  floorz: number;
  ceilingz: number;
  /** ThingLinks slot — ALWAYS bound at spawn (static or dynamic); the
   * Mover-base optional is narrowed to required here. */
  linkSlot: number;
  /** BAM u32 (ANG45 * (thing.angle/45) at map-thing spawn) */
  angle: number;
  /** states[] row id + the state fields P_SetMobjState copies (p_mobj.c:63-66) */
  state: number;
  tics: number;
  sprite: number;
  frame: number;
  health: number;
  /** mobjinfo reactiontime (skipped on sk_nightmare, p_mobj.c:505) */
  reactionTime: number;
  /** p_mobj.h:258 `int movedir; // 0-7` — chase-direction LUT index
   * (P_Move/P_NewChaseDir, M8-04). Spawn default DI_NODIR (deviation
   * note: vanilla leaves it uninitialized). */
  movedir: number;
  /** p_mobj.h:259 `int movecount; // when 0, select a new dir` — the
   * zig-zag timer (A_Chase decrement / P_TryWalk reload, M8-04) and the
   * nightmare-respawn counter (p_mobj.c:459). */
  movecount: number;
  /** mobjinfo damage row copied at spawn (mobjinfo_t has no mobj_t twin
   * in 1.10 — the port mirrors the row: A_Skullflight/A_SkullAttack
   * reads `info->damage`, §0.7; A_Chase's missile gate reads
   * `actor->movecount`). */
  damage: number;
  /** P_Random()%MAXPLAYERS at spawn (p_mobj.c:508) — consumes the PRNG! */
  lastLook: number;
  /** mobj_t threshold (p_mobj.h) — M7-03 added it for P_DamageMobj's
   * generic retarget branch (runs for player mobjs too, p_inter.c:907-
   * 913); monsters (A_Chase decrement / M7-07) share the field. Not in
   * the §3.4 words (8 words stay blessed). */
  threshold: number;
  target?: Mobj;
  spawnpoint: SpawnPoint | null;
  /** P_RemoveMobj done (the thinker sentinel is ptick's; this is the
   * p_mobj.c "function == -1" check every call site performs after a
   * potential removal). */
  removed: boolean;
  thinker: Thinker;
  /** [x, y, z, state, tics, flags, health, targetIndex, movedir|movecount|damage] — §3.4 (9th word M8-02) */
  words: number[];
}

/* ------------------------------------------------------------------ */
/* MobjRuntime (p_mobj.c module globals + the level roster)             */
/* ------------------------------------------------------------------ */

export interface MobjRuntime {
  readonly state: GameState;
  /** every mobj ever spawned this level, in spawn order (removed entries
   * stay with removed=true — vanilla Z_Frees, the roster keeps indices
   * stable for hashes/target refs; the arena excludes removed thinkers). */
  readonly mobjs: Mobj[];
  /** ThingLinks slot → mobj (PIT hook consumers, M7-04/05/09). */
  readonly slotMobjs: Map<number, Mobj>;

  /* vanilla globals with observable state */
  deathmatchStarts: SpawnPoint[]; // deathmatchstarts[MAXDEATHMATCHSTARTS=10]
  /** playerstarts[4] records; M7-03 additionally SPAWNS through them (the
   * P_SpawnPlayer call sits at the thing's THINGS-lump position, keeping
   * the thinker-arena insertion order of vanilla P_LoadThings). */
  playerStarts: (SpawnPoint | null)[];
  /** M7-03 seam: pplayer.ts registers the real P_SpawnPlayer here
   * (pSpawnMapThing's doomednum-1..4 branch calls it AFTER capturing the
   * record, vanilla's `if (!deathmatch) P_SpawnPlayer (mthing);`). Left
   * unset (standalone p_mobj tests) the capture-only behavior stands. */
  playerSpawnFn?: (rt: MobjRuntime, start: SpawnPoint) => void;
  readonly itemQue: SpawnPoint[]; // itemrespawnque[ITEMQUESIZE]
  readonly itemQueTime: number[]; // itemrespawntime[ITEMQUESIZE]
  iquehead: number;
  iquetail: number;
  totalkills: number;
  totalitems: number;
  /** spawn-flag overrides (vanilla d_main params; SP defaults all false) */
  deathmatch: boolean;
  nomonsters: boolean;
  netgame: boolean;
  respawnmonsters: boolean;
  /** unknown-doomednum census (vanilla I_Error → warn+skip, R12) */
  skippedUnknown: number;
  readonly unknownTypes: number[];
  /** observable counters (never hashed): hook/branch bookkeeping. */
  readonly counts: {
    spawnMobj: number;
    removeMobj: number;
    setState: number;
    killShellCalls: number;
    explodeMissile: number;
    thinkerTic: number;
    respawnSpecials: number;
  };
}

/** gInitGame-side construction (also usable standalone in tests). */
export function createMobjRuntime(state: GameState): MobjRuntime {
  const rt: MobjRuntime = {
    state,
    mobjs: [],
    slotMobjs: new Map(),
    deathmatchStarts: [],
    playerStarts: [null, null, null, null],
    itemQue: [],
    itemQueTime: [],
    iquehead: 0,
    iquetail: 0,
    totalkills: 0,
    totalitems: 0,
    deathmatch: false,
    nomonsters: false,
    netgame: false,
    respawnmonsters: false,
    skippedUnknown: 0,
    unknownTypes: [],
    counts: {
      spawnMobj: 0,
      removeMobj: 0,
      setState: 0,
      killShellCalls: 0,
      explodeMissile: 0,
      thinkerTic: 0,
      respawnSpecials: 0,
    },
  };
  registerPmoveAdapters();
  // M8-02 damage-bridge resolver: register the slot → mobj view of THIS
  // runtime on the state's hook slots (hooks.ts owns the type; the real
  // P_DamageMobj BODY — M8-05's registerDamageBridge — resolves through
  // it, and damageSlot's dispatch below does too). Structural on purpose
  // (MobjRef): no import cycle, hooks.ts stays import-free.
  state.hooks.bridge.mobjFromSlot = (slot: number): MobjRef | undefined =>
    rt.slotMobjs.get(slot) as MobjRef | undefined;
  return rt;
}

/** ThingLinks slot → the live Mobj bound to it (undefined when nothing is
 * bound — unmapped decor slots / removed statics keep no entry after
 * removal is NOT true: removed mobjs stay in the map, matching vanilla's
 * freed-pointer-until-realloc semantics; callers check .removed).
 * The hooks.ts bridge resolver and the M8-05 damage body resolve through
 * this single function (M8-plan §M8-02: p_mobj exports the resolver). */
export function mobjFromSlot(rt: MobjRuntime, slot: number): Mobj | undefined {
  return rt.slotMobjs.get(slot);
}

/* ------------------------------------------------------------------ */
/* P_SpawnMobj — p_mobj.c:483-540                                       */
/* ------------------------------------------------------------------ */

/**
 * `P_SpawnMobj(x, y, z, type)` verbatim, with the port's slot binding:
 * `slot >= 0` REUSES a static grid slot (load-time map things — already
 * linked by buildThingLinks), `slot < 0` allocates a dynamic one
 * (vanilla's Z_Malloc analogue). z tokens ONFLOORZ/ONCEILINGZ resolve
 * against the LIVE sector heights (state.sectors, M6-04 authority).
 * The state fields are copied WITHOUT dispatching the spawnstate's action
 * ("action routines can not be called yet", p_mobj.c:509-510).
 */
export function pSpawnMobj(
  rt: MobjRuntime,
  x: number,
  y: number,
  z: number,
  type: number,
  slot = -1,
  opts: { skipLastLookRandom?: boolean; thinkerId?: number } = {},
): Mobj {
  const info = mobjinfo[type]!;
  const links = rt.state.pmap.links;
  let s = slot;
  if (s < 0) s = allocThingSlot(links, info.radius, info.height, info.flags);

  const row = stateAt(info.spawnState);
  const m: Mobj = {
    isMobj: true,
    rt,
    type,
    x,
    y,
    z: 0,
    momx: 0,
    momy: 0,
    momz: 0,
    radius: info.radius,
    height: info.height,
    flags: info.flags,
    floorz: 0,
    ceilingz: 0,
    linkSlot: s,
    angle: 0,
    state: info.spawnState,
    tics: row.tics,
    sprite: row.sprite,
    frame: row.frame,
    health: info.spawnHealth,
    // p_mobj.c:505 "if (gameskill != sk_nightmare)" — Skill 4 = nightmare
    reactionTime: rt.state.skill !== 4 ? info.reactionTime : 0,
    lastLook: 0,
    threshold: 0,
    // p_mobj.h:258-259 AI movement fields (M8-02; defaults per §M8-02
    // acceptance 1) + the mobjinfo damage row (§0.7 A_SkullAttack).
    movedir: DI_NODIR,
    movecount: 0,
    damage: info.damage,
    spawnpoint: null,
    removed: false,
    words: [0, 0, 0, 0, 0, 0, 0, 0, 0],
    thinker: null as unknown as Thinker,
  };
  // p_mobj.c:508 — EVERY spawn draws one P_Random (stream parity!).
  // M7-03 exception (documented deviation): the PLAYER spawn skips the
  // draw — the M5-era port never drew for the player stub and the blessed
  // feel/headless hashes pin the rng indices; lastlook is never read for
  // players, so the skip is behavior-free (pplayer.ts P_SpawnPlayer).
  if (!opts.skipLastLookRandom) m.lastLook = pRandom(rt.state.rng) % MAXPLAYERS;

  // P_SetThingPosition (p_maputl.c:395): static slots are already linked;
  // dynamic slots link now (MF_NOBLOCKMAP slots stay inert).
  if (s >= links.staticCount) thingSetPosition(links, s, x, y);

  // p_mobj.c:515-523: floorz/ceilingz from the subsector's LIVE sector,
  // then the z token resolves.
  const sec = sectorAtPoint(rt.state.map, x, y);
  m.floorz = liveFloor(rt.state.sectors, rt.state.map, sec);
  m.ceilingz = liveCeil(rt.state.sectors, rt.state.map, sec);
  if (z === ONFLOORZ) m.z = m.floorz;
  else if (z === ONCEILINGZ) m.z = (m.ceilingz - info.height) | 0;
  else m.z = z;
  links.z[s] = m.z;

  m.thinker = pAddThinker(rt.state.thinkers, () => pMobjThinker(m), opts.thinkerId);
  m.thinker.hashWords = m.words;
  syncMobj(m);
  rt.mobjs.push(m);
  rt.slotMobjs.set(s, m);
  rt.counts.spawnMobj++;
  return m;
}

function liveFloor(sectors: LiveSectors, map: RuntimeMap, sec: number): number {
  return sectors.floorZ[sec] ?? map.sectors.floorHeight[sec]!;
}
function liveCeil(sectors: LiveSectors, map: RuntimeMap, sec: number): number {
  return sectors.ceilingZ[sec] ?? map.sectors.ceilingHeight[sec]!;
}

/* ------------------------------------------------------------------ */
/* P_RemoveMobj — p_mobj.c:549-575                                      */
/* ------------------------------------------------------------------ */

/**
 * `P_RemoveMobj` verbatim: the item-respawn queue capture (runs for EVERY
 * non-dropped MF_SPECIAL pickup EXCEPT MT_INV/MT_INS — vanilla performs it
 * regardless of deathmatch; only P_RespawnSpecials is gated), the
 * P_UnsetThingPosition unlink, and the lazy thinker removal. Idempotent
 * (vanilla relies on caller discipline; the removed flag keeps double
 * removes safe through the hook adapters).
 */
export function pRemoveMobj(m: Mobj): void {
  if (m.removed) return;
  const rt = m.rt;
  if (
    (m.flags & MF.MF_SPECIAL) !== 0 &&
    (m.flags & MF.MF_DROPPED) === 0 &&
    m.type !== MT.MT_INV &&
    m.type !== MT.MT_INS
  ) {
    rt.itemQue[rt.iquehead] = m.spawnpoint ?? { x: 0, y: 0, angle: 0, type: 0, options: 0 };
    rt.itemQueTime[rt.iquehead] = rt.state.leveltime;
    rt.iquehead = (rt.iquehead + 1) & (ITEMQUESIZE - 1);
    if (rt.iquehead === rt.iquetail) rt.iquetail = (rt.iquetail + 1) & (ITEMQUESIZE - 1);
  }
  thingUnsetPosition(rt.state.pmap.links, m.linkSlot);
  pRemoveThinker(m.thinker);
  m.removed = true;
  rt.counts.removeMobj++;
}

/* ------------------------------------------------------------------ */
/* P_SetMobjState — p_mobj.c:48-86 (the 0-tic cascade)                  */
/* ------------------------------------------------------------------ */

/**
 * `P_SetMobjState(mobj, state)` — returns true iff the mobj survives.
 * The do/while loop keeps vanilla's LOCAL state cursor (an action that
 * re-enters P_SetMobjState is overwritten by the outer loop exactly like
 * the C original) and the `mobj->tics` loop condition (actions may
 * rewrite tics — the recorder stubs do not). S_NULL ⇒ remove + false.
 * Guards (documented deviations): MAX_STATE_CHAIN cap (vanilla hangs) and
 * a removed-mobj bail (vanilla writes freed memory).
 */
export function pSetMobjState(m: Mobj, state: number): boolean {
  const rt = m.rt;
  rt.counts.setState++;
  let st = state;
  for (let guard = 0; ; guard++) {
    if (guard >= MAX_STATE_CHAIN) {
      throw new Error(`pSetMobjState: 0-tic cascade exceeded ${MAX_STATE_CHAIN} states (vanilla would hang)`);
    }
    if (m.removed) return false; // vanilla: freed memory — documented bail
    if (st === S.S_NULL) {
      m.state = S.S_NULL;
      pRemoveMobj(m);
      return false;
    }
    const row = stateAt(st);
    m.state = st;
    m.tics = row.tics;
    m.sprite = row.sprite;
    m.frame = row.frame;
    // M8-07 domain fix: this machine dispatches the MOBJ-domain identity of
    // every id (vanilla stores the pointer per row; id27 = A_Fall here).
    // M8-fix static-dummy seam: when hooks.aiGate is installed and returns
    // true, the two AI-churn ids (A_Look/A_Chase) skip dispatch HERE only —
    // every other state action (A_Pain, A_Scream, A_Fall, …) runs exactly
    // as production, and unset gates cost nothing (see hooks.ts HookSlots
    // .aiGate for the precise coverage contract).
    if (row.action !== ACT_NONE &&
      !((row.action === ACT.A_Look || row.action === ACT.A_Chase) &&
        rt.state.hooks.aiGate?.())) {
      dispatchAction(row.action, m, 'mobj');
    }
    if (m.removed) return false;
    st = stateNext[st]!;
    if (m.tics !== 0) {
      syncMobj(m);
      return true;
    }
  }
}

/** P_ExplodeMissile's momentum half lives in pmove.ts (M5-05); this is the
 * state/sound/tics half (p_mobj.c:85-99), minus the deathsound (M7-06 sfx
 * slot — counted). The `P_Random()&3` draw happens even when the state set
 * removed the mobj: vanilla reads freed `mo->tics`, but ALWAYS draws —
 * the PRNG stream parity is kept, the tics write is skipped when removed. */
export function pExplodeMissile(m: Mobj): void {
  m.momx = 0;
  m.momy = 0;
  m.momz = 0;
  const rt = m.rt;
  rt.counts.explodeMissile++;
  const alive = pSetMobjState(m, mobjinfo[m.type]!.deathState);
  m.tics = (m.tics - (pRandom(rt.state.rng) & 3)) | 0;
  if (alive && m.tics < 1) m.tics = 1;
  writeFlags(m, m.flags & ~MF.MF_MISSILE);
  // p_mobj.c:103 `if (mo->info->deathsound) S_StartSound (mo, deathsound)`
  // — the M7-09/M7-06 seam (mobjHooks.startSound; pmissiles.ts registers
  // the sfxSlot body, the default is a counted no-op — never silent).
  const dSound = mobjinfo[m.type]!.deathSound;
  if (dSound && dSound !== 'sfx_None' && dSound !== '0') {
    mobjHookCounts.startSound++;
    mobjHooks.startSound?.(m, dSound, rt.state.leveltime);
  }
  syncMobj(m);
}

/* ------------------------------------------------------------------ */
/* mobj-side hook slots (M7-09: the p_mobj.c:103 S_StartSound site)     */
/* ------------------------------------------------------------------ */

/** Typed slots for p_mobj.c side-effect call sites whose bodies live in
 * other modules (same idiom as pmoveHooks / psprHooks). `startSound` is
 * `S_StartSound(mo, token)` — token is the mobjinfo sfx_* string; the
 * registrant resolves it to the sounds.h id and emits through hooks.sfx. */
export const mobjHooks: {
  startSound?: (m: Mobj, token: string, tic: number) => void;
} = {};

/** Counts every call (hook present or not); tests reset. */
export const mobjHookCounts = { startSound: 0 };

export function resetMobjHookCounts(): void {
  mobjHookCounts.startSound = 0;
}

/* ------------------------------------------------------------------ */
/* flags + geometry mirroring (grid slots mirror mobjs and vice versa)  */
/* ------------------------------------------------------------------ */

/** mobj flags are authoritative; the grid copy PIT_CheckThing reads is
 * kept in step (the M5 grid had no flag writers before M7). */
function writeFlags(m: Mobj, v: number): void {
  m.flags = v | 0;
  const links = m.rt.state.pmap.links;
  if (m.linkSlot >= 0) links.flags[m.linkSlot] = v;
}
export { writeFlags as pSetMobjFlags };

/**
 * Refresh the mobj's §3.4 hash words and keep mobj z ↔ grid z consistent.
 * DYNAMIC slots (>= staticCount): the mobj owns its z (missile arcs) and
 * the slot mirrors it. STATIC slots: the grid owns z (the M6 crush path
 * writes links.z) and the mobj adopts it. x/y: movers relink through
 * pTryMove (both sides written), statics are immovable.
 */
export function syncMobj(m: Mobj): void {
  const links = m.rt.state.pmap.links;
  const s = m.linkSlot;
  if (s >= 0) {
    if (s >= links.staticCount) links.z[s] = m.z;
    else if (links.z[s] !== m.z) m.z = links.z[s]!;
  }
  const w = m.words;
  w[0] = s >= 0 ? links.x[s]! : m.x;
  w[1] = s >= 0 ? links.y[s]! : m.y;
  w[2] = links.z[s] ?? m.z;
  w[3] = m.state;
  w[4] = m.tics;
  w[5] = s >= 0 ? links.flags[s]! : m.flags;
  w[6] = m.health;
  w[7] = m.target !== undefined && !m.target.removed ? m.target.thinker.id : 0;
  // M8-02 9th word (ARCH §3.4 extension, re-bless reason "M8 monster
  // fields"): the AI movement trio packed as a bitmask.
  w[8] = (m.movedir | m.movecount | m.damage) | 0;
}

/* ------------------------------------------------------------------ */
/* P_MobjThinker — p_mobj.c:398-451                                     */
/* ------------------------------------------------------------------ */

/**
 * `P_MobjThinker` verbatim mapping:
 *  - momentum movement via the shared pmove.ts pair (M5-05-tested), with
 *    the `thinker.function == -1` removed checks ⇒ {@link Mobj.removed};
 *  - `tics != -1` ⇒ decrement, 0 ⇒ P_SetMobjState(nextstate) (the
 *    states.ts stateAdvance semantics run LIVE here for real mobjs);
 *  - `tics == -1` ⇒ the nightmare-respawn branch — inert while
 *    respawnmonsters is false (no source pre-M9, M7-02 scope).
 */
export function pMobjThinker(m: Mobj): void {
  if (m.removed) return;
  const rt = m.rt;
  rt.counts.thinkerTic++;
  if (m.momx !== 0 || m.momy !== 0 || (m.flags & MF.MF_SKULLFLY) !== 0) {
    pXYMovement(rt.state.pmap, m);
    if (m.removed) return; // mobj was removed (sky-hack missile etc.)
  }
  // D-t4 (M7-03): the PLAYER mobj keeps the M5-06-era UNCONDITIONAL
  // P_ZMovement call — the blessed feel/headless hashes pin it (its
  // only observable: in ceiling < 56 spots the every-tic ceiling clip
  // parks z at ceilingz-height, where vanilla's
  // `if (z != floorz || momz)` guard skips P_ZMovement entirely).
  // Behavior elsewhere is identical (the call is a no-op on a resting
  // mobj). Revisit with the M7-06 blessed hash update.
  if (m.z !== m.floorz || m.momz !== 0 || m.playerRef !== undefined) {
    pZMovement(m);
    if (m.removed) return;
  }
  if (m.tics !== -1) {
    m.tics = (m.tics - 1) | 0;
    if (m.tics === 0 && !pSetMobjState(m, stateNext[m.state]!)) return; // freed itself
  }
  // else: nightmare-respawn check — respawnmonsters false ⇒ return (above).
  syncMobj(m);
}

/* ------------------------------------------------------------------ */
/* P_SpawnMapThing + the load pass — p_mobj.c:704-799, p_setup.c:346    */
/* ------------------------------------------------------------------ */

/** mapthing_t input record (mapThingAt's shape). */
export interface MapThingRec {
  x: number;
  y: number;
  angle: number;
  /** doomednum */
  type: number;
  /** MTF_* options */
  options: number;
}

const MAX_DEATHMATCHSTARTS = 10; // p_setup.c MAXDEATHMATCHSTARTS

function asSpawnPoint(t: MapThingRec): SpawnPoint {
  return { x: t.x, y: t.y, angle: t.angle, type: t.type, options: t.options };
}

/** mapThingAt's record (flags field) → the p_mobj.c mapthing_t view. */
function spawnPointAt(map: RuntimeMap, i: number): SpawnPoint {
  const t = mapThingAt(map, i);
  return { x: t.x, y: t.y, angle: t.angle, type: t.type, options: t.flags };
}

/**
 * `P_SpawnMapThing` verbatim (check order preserved): deathmatch start
 * capture → player start capture (P_SpawnPlayer = M7-03, so the record is
 * stored, not spawned) → solo bit (MTF 16 while !netgame) → skill bit →
 * doomednum linear scan → MF_NOTDMATCH gate → -nomonsters gate →
 * P_SpawnMobj (ONFLOORZ / MF_SPAWNCEILING ⇒ ONCEILINGZ) → spawnpoint →
 * the `1 + P_Random()%tics` desync jitter → COUNTKILL/COUNTITEM totals →
 * ANG45 angle → MTF_AMBUSH. Unknown doomednums: vanilla I_Error → counted
 * skip (deviation note). Dynamic slot (allocThingSlot) when no static
 * grid slot applies — the M7-09 respawn path uses this entry point.
 */
export function pSpawnMapThing(rt: MobjRuntime, t: MapThingRec): Mobj | undefined {
  if (t.type === 11) {
    if (rt.deathmatchStarts.length < MAX_DEATHMATCHSTARTS) {
      rt.deathmatchStarts.push(asSpawnPoint(t));
    }
    return undefined;
  }
  if (t.type <= 4) {
    rt.playerStarts[t.type - 1] = asSpawnPoint(t);
    // p_mobj.c:730-734: `playerstarts[type-1] = *mthing;` then
    // `if (!deathmatch) P_SpawnPlayer (mthing);` — M7-03 registers the
    // real spawn (playerSpawnFn) from pplayer.ts; the arena-insertion
    // position matches vanilla's P_LoadThings order exactly.
    if (rt.playerSpawnFn && !rt.deathmatch) rt.playerSpawnFn(rt, rt.playerStarts[t.type - 1]!);
    return undefined;
  }
  if (!rt.netgame && (t.options & MTF_NOTSINGLEPLAYER) !== 0) return undefined;
  if ((t.options & skillBit(rt.state.skill)) === 0) return undefined;

  const mt = DOOMEDNUM_TO_MT.get(t.type);
  if (mt === undefined) {
    rt.skippedUnknown++;
    if (!rt.unknownTypes.includes(t.type)) rt.unknownTypes.push(t.type);
    return undefined;
  }
  const info = mobjinfo[mt]!;
  if (rt.deathmatch && (info.flags & MF.MF_NOTDMATCH) !== 0) return undefined;
  if (rt.nomonsters && (mt === MT.MT_SKULL || (info.flags & MF.MF_COUNTKILL) !== 0)) {
    return undefined;
  }

  const x = (t.x << 16) | 0;
  const y = (t.y << 16) | 0;
  const z = (info.flags & MF.MF_SPAWNCEILING) !== 0 ? ONCEILINGZ : ONFLOORZ;
  const m = pSpawnMobj(rt, x, y, z, mt);
  finishMapThing(rt, m, t);
  return m;
}

/** The P_SpawnMapThing tail shared by the dynamic and slot-bound paths. */
function finishMapThing(rt: MobjRuntime, m: Mobj, t: MapThingRec): void {
  m.spawnpoint = asSpawnPoint(t);
  if (m.tics > 0) m.tics = 1 + (pRandom(rt.state.rng) % m.tics);
  if ((m.flags & MF.MF_COUNTKILL) !== 0) rt.totalkills++;
  if ((m.flags & MF.MF_COUNTITEM) !== 0) rt.totalitems++;
  m.angle = (ANG45 * ((t.angle / 45) | 0)) >>> 0;
  if ((t.options & MTF_AMBUSH) !== 0) writeFlags(m, m.flags | MF.MF_AMBUSH);
  syncMobj(m);
}

/**
 * The P_SetupLevel/P_LoadThings load pass: P_SpawnMapThing over every
 * THINGS record, in THINGS order (p_setup.c:346). Grid things reuse their
 * static slot (zip-aligned with buildThingLinks' filter — see file
 * header); MF_NOBLOCKMAP things get inert dynamic slots (spawned,
 * thinkers + hash present, never in the chains). Requires
 * deathmatch/nomonsters OFF (the buildThingLinks filter has no such
 * knobs — M9 respawn/difficulty modes rebuild the grid first).
 */
export function pSpawnThings(rt: MobjRuntime): void {
  if (rt.deathmatch || rt.nomonsters) {
    throw new Error('pSpawnThings: deathmatch/nomonsters need a grid rebuild first (M9 follow-up)');
  }
  const map = rt.state.map;
  const links = rt.state.pmap.links;
  const bit = skillBit(rt.state.skill);
  const netgame = rt.netgame;
  let s = 0; // static-slot cursor, zip-aligned with buildThingLinks
  for (let i = 0; i < map.numThings; i++) {
    const rec = spawnPointAt(map, i);
    if (rec.type === 11) {
      if (rt.deathmatchStarts.length < MAX_DEATHMATCHSTARTS) rt.deathmatchStarts.push(rec);
      continue;
    }
    if (rec.type <= 4) {
      rt.playerStarts[rec.type - 1] = rec;
      // p_mobj.c:730-734 (the inlined P_SpawnMapThing this pass mirrors):
      // `if (!deathmatch) P_SpawnPlayer (mthing);` — M7-03 playerSpawnFn.
      if (rt.playerSpawnFn) rt.playerSpawnFn(rt, rec);
      continue;
    }
    if (!netgame && (rec.options & MTF_NOTSINGLEPLAYER) !== 0) continue;
    if ((rec.options & bit) === 0) continue;
    const mt = DOOMEDNUM_TO_MT.get(rec.type);
    if (mt === undefined) {
      rt.skippedUnknown++;
      if (!rt.unknownTypes.includes(rec.type)) rt.unknownTypes.push(rec.type);
      continue;
    }
    const info = mobjinfo[mt]!;
    const x = (rec.x << 16) | 0;
    const y = (rec.y << 16) | 0;
    const z = (info.flags & MF.MF_SPAWNCEILING) !== 0 ? ONCEILINGZ : ONFLOORZ;
    let slot = -1;
    if ((info.flags & MF.MF_NOBLOCKMAP) === 0) {
      slot = s++;
      if (links.thing[slot] !== i) {
        throw new Error(
          `pSpawnThings: static slot ${slot} bound to thing ${links.thing[slot]}, expected ${i} ` +
            '(buildThingLinks/pSpawnThings filters drifted)',
        );
      }
    }
    const m = pSpawnMobj(rt, x, y, z, mt, slot);
    finishMapThing(rt, m, rec);
  }
}

/* ------------------------------------------------------------------ */
/* P_RespawnSpecials — p_mobj.c:587-643 (inert in single player)        */
/* ------------------------------------------------------------------ */

/**
 * `P_RespawnSpecials` — first line `if (deathmatch != 2) return;`: in
 * this port's SP defaults the queue is maintained by P_RemoveMobj but
 * never drained (M9 deathmatch wiring re-enables the body verbatim: MT_IFOG
 * + doomednum scan + spawnpoint respawn + queue tail advance).
 */
export function pRespawnSpecials(rt: MobjRuntime): void {
  rt.counts.respawnSpecials++;
  if (!rt.deathmatch) return; // vanilla: deathmatch != 2 (2 == items mode)
  // (M9): 30-second wait, MT_IFOG, itemrespawnque drain — see header.
}

/* ------------------------------------------------------------------ */
/* P_SpawnPuff / P_SpawnBlood — p_mobj.c:811-862                        */
/* ------------------------------------------------------------------ */

/**
 * `P_SpawnPuff` verbatim: the `(P_Random()-P_Random())<<10` z jitter,
 * momz = FRACUNIT (the ZMISC "rises with no XY" behavior), the
 * `tics -= P_Random()&3` clamp, and the melee variant (attackrange ==
 * MELEERANGE ⇒ S_PUFF3, "don't make punches spark on the wall").
 */
export function pSpawnPuff(rt: MobjRuntime, x: number, y: number, z: number): Mobj {
  z = (z + (((pRandom(rt.state.rng) - pRandom(rt.state.rng)) << 10) | 0)) | 0;
  const th = pSpawnMobj(rt, x, y, z, MT.MT_PUFF);
  th.momz = FRACUNIT;
  th.tics = (th.tics - (pRandom(rt.state.rng) & 3)) | 0;
  if (th.tics < 1) th.tics = 1;
  if (attackRange.value === MELEERANGE) pSetMobjState(th, S.S_PUFF3);
  syncMobj(th);
  return th;
}

/** `P_SpawnBlood` verbatim (damage-picked blood state). */
export function pSpawnBlood(rt: MobjRuntime, x: number, y: number, z: number, damage: number): Mobj {
  z = (z + (((pRandom(rt.state.rng) - pRandom(rt.state.rng)) << 10) | 0)) | 0;
  const th = pSpawnMobj(rt, x, y, z, MT.MT_BLOOD);
  th.momz = 2 * FRACUNIT;
  th.tics = (th.tics - (pRandom(rt.state.rng) & 3)) | 0;
  if (th.tics < 1) th.tics = 1;
  if (damage <= 12 && damage >= 9) pSetMobjState(th, S.S_BLOOD2);
  else if (damage < 9) pSetMobjState(th, S.S_BLOOD3);
  syncMobj(th);
  return th;
}

/* ------------------------------------------------------------------ */
/* P_KillMobj shell (branches owned by M7-03 player / M8 monsters)      */
/* ------------------------------------------------------------------ */

/**
 * M7-02 SHELL only: p_inter/p_teleport callers (M7-03/M7-05/M8) need the
 * entry point + an observable count NOW; the player branch (MF_SOLID off,
 * PST_DEAD, P_DropWeapon drop table) is M7-03/M7-05 and the monster
 * branch (pain/death states, gib loop, MF_COUNTKILL killcount) is M8.
 */
export function pKillMobjShell(m: Mobj): void {
  m.rt.counts.killShellCalls++;
}

/* ------------------------------------------------------------------ */
/* P_SetThingPosition / P_UnsetThingPosition (mobj view)                */
/* ------------------------------------------------------------------ */

/** Re-link a MOVER mobj to its current x/y (link-only re-insert; the
 * static-slot guard throws — statics never move, thinglinks.ts rule). */
export function pSetThingPosition(m: Mobj): void {
  thingSetPosition(m.rt.state.pmap.links, m.linkSlot, m.x, m.y);
}

export function pUnsetThingPosition(m: Mobj): void {
  thingUnsetPosition(m.rt.state.pmap.links, m.linkSlot);
}

/* ------------------------------------------------------------------ */
/* pmove.ts hook adapters (real bodies replace the M5 counters)          */
/* ------------------------------------------------------------------ */

/** Duck-test a MoveMobj for the full mobj runtime. */
export function asMobj(mo: MoveMobj): Mobj | undefined {
  return (mo as Mobj).isMobj === true ? (mo as Mobj) : undefined;
}

let pmoveAdaptersRegistered = false;

/**
 * Wire the pmove.ts slots to the real p_mobj bodies (M5-06-era stub
 * counters keep firing for NON-mobj movers — the player's MobjStub —
 * until M7-03 makes the player a real mobj; every adapter is a no-op for
 * those, so no M5 behavior moves).
 */
export function registerPmoveAdapters(): void {
  if (pmoveAdaptersRegistered) return;
  pmoveAdaptersRegistered = true;
  pmoveHooks.explodeMissile = (mo) => {
    const m = asMobj(mo);
    if (m) pExplodeMissile(m);
  };
  pmoveHooks.removeMobj = (mo) => {
    const m = asMobj(mo);
    if (m) pRemoveMobj(m); // the sky-hack instant removal (p_mobj.c:172-178)
  };
  pmoveHooks.setMobjState = (mo, which) => {
    const m = asMobj(mo);
    if (!m) return; // MobjStub player: counter-only (pmove's own counts)
    if (which === 'spawnstate') pSetMobjState(m, mobjinfo[m.type]!.spawnState);
    else if (which === 'deathstate') pSetMobjState(m, mobjinfo[m.type]!.deathState);
    else if (which === 'play') {
      // p_mobj.c:230 P_XYMovement's stop branch — the walking-frame
      // revert `if ((mobj->state - &states[S_PLAY_RUN1]) < 4) P_SetMobjState
      // (mobj, S_PLAY);` — M7-03: real state window test (player mobjs
      // only; the call site already gates on mo->player).
      if (m.playerRef !== undefined && m.state - S.S_PLAY_RUN1 < 4) {
        pSetMobjState(m, S.S_PLAY);
      }
    }
  };
}
