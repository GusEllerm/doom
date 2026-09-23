// sim/pSaveg.ts — M11-04: the p_saveg.c EQUIVALENT (M11-plan §M11-04,
// source truths §0.1/§0.2/§0.3). Structured capture/restore of the LIVE
// WORLD in the vanilla four-pass ORDER:
//
//   P_ArchivePlayers → P_ArchiveWorld → P_ArchiveThinkers → P_ArchiveSpecials
//                                             (capture side, g_game.c:1296-1299)
//   G_InitNew(skill,ep,map) → leveltime → P_UnArchivePlayers → World →
//   Thinkers → Specials → marker        (restore side, g_game.c:1201-1251)
//
// STRUCTURED, NOT BYTES (D-11a): this module produces/consumes a canonical
// port snapshot (the `payload` M11-02's codec wraps). The sim imports
// NOTHING from src/persist (A-06/D-11g); bytes are persist's job.
//
// ---------------------------------------------------------------------------
// CLASSIFIER (P_ArchiveSpecials' function-pointer identity, §0.2 → port
// equivalent): our thinker fn is a per-world closure, so identity maps to
// the payload-shape identity — each family's state struct is unique:
//   mobj            — arena entry owned by an rt.mobjs record (tc_mobj=1)
//   ceiling_t       — `olddirection` + `revive`        (tc_ceiling)
//   door_t          — `topwait`/`topcountdown`         (tc_door)
//   floormove_t     — `dest` + `newspecial`            (tc_floor)
//   plat_t          — `oldstatus` + `revive`           (tc_plat)
//   fireflicker_t   — kind 'fireflicker'               (PORT-EXTRA: 1.10
//                      P_ArchiveSpecials has NO T_FireFlicker classifier and
//                      silently drops fire-flicker thinkers on load; the
//                      port's canonical snapshot keeps them — deviation,
//                      report §FOLLOW-UPS)
//   lightflash_t    — kind 'lightflash'                (tc_flash)
//   strobe_t        — kind 'strobe'                    (tc_strobe)
//   glow_t          — kind 'glow'                      (tc_glow)
// Dormant-repeat survival (the ceiling/plat `if (thinker.function.acp1)`
// guards, §0.2): thinker.fn === null is captured as active=0 and rebuilt
// fn-null with the revive closure re-fabricated from the exported T_* bodies.
//
// RESTORE STRATEGY (plan §M11-04 "restore = the G_DoLoadGame order EXACTLY"):
// the caller (game.ts gDoLoadGame) runs gInitNew(skill,ep,map) FIRST — the
// full level rebuild with M_ClearRandom — then restoreWorld() applies the
// four passes over the fresh world:
//   1. players struct  (P_UnArchivePlayers: nulls mo/message/attacker — we
//      instead resolve those references through roster/player indices)
//   2. world           (P_UnArchiveWorld: heights/light/special + line/side
//      state + the flat-override channel; specialdata is re-linked by the
//      thinker passes via thinker-id back-refs)
//   3. mobj thinkers   (P_UnArchiveThinkers: REMOVE ALL thinkers/mobjs,
//      rebuild the roster in spawn order at the captured thinker ids
//      (pSpawnMobj opts.thinkerId / the reserved player ids), target and
//      player links rebound by index, floorz/ceilingz recomputed from the
//      ALREADY-restored sectors exactly like vanilla's P_SetThingPosition
//      half)
//   4. specials        (P_UnArchiveSpecials: rebuild the 7+1 classes with
//      fn re-fabricated from the exported T_* bodies, re-link specialdata,
//      re-register P_AddActiveCeiling/P_AddActivePlat — dormant ones
//      included, §0.2 swizzle case)
//   (+) RNG indices are REAPPLIED at the tail (port deviation, deliberate
//      and documented: 1.10 archives NO rng and G_InitNew's M_ClearRandom
//      resets both streams on every load, §0.1 — faithful for a BYTE-FROM-
//      BYTE .dsg, but our canonical GameState payload carries rndindex/
//      prndindex so the save→load→continue hash identity (M11 exit line 1)
//      holds on maps with mid-run P_Random draws. The vanilla reset still
//      happens (gInitNew ran it); reapplication is the payload's own value
//      landing AFTER it, exactly where P_UnArchive* land. Captured at a
//      fresh boot, restore reproduces the reset-stream byte-identically.)
//
// ARENA ORDER: hashState walks the arena Map in insertion order, so the
// snapshot pins the LIVE-entry order (arenaOrder) and restore rebuilds the
// Map in exactly that order after the mobj/special respawns.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { pAddThinker, pRemoveThinker, type Thinker } from './ptick';
import { pSetMobjFlags, pSpawnMobj, syncMobj, type Mobj, type SpawnPoint } from './p_mobj';
import { thingSetPosition, thingUnsetPosition, MF_NOBLOCKMAP } from './thinglinks';

import { tVerticalDoor, type Door } from './pdoors';
import { tMoveFloor, type FloorMove } from './pfloor';
import {
  tPlatRaise, pAddActivePlat, activePlats, floorFlatOverrides, type Plat
} from './pplats';
import {
  tMoveCeiling, pAddActiveCeiling, activeCeilings, type Ceiling
} from './pceilng';
import {
  tFireFlicker, tLightFlash, tStrobeFlash, tGlow, LIGHT_THINKER_KINDS,
  type LightThinker
} from './plights';
import { makePlaneContext } from './pplane';
import { buttonList, MAXBUTTONS } from './pswitch';

import { attachPsprFields, type PsprFields } from './p_pspr';
import { initPlayerInventory, type InventoryFields } from './p_inter_inventory';
import type { SpecWorld } from './pspec-helpers';
import type { GameState } from './state';
import type { Player } from './player';

/* ------------------------------------------------------------------ */
/* Snapshot layout (the canonical structured payload)                   */
/* ------------------------------------------------------------------ */

export interface SaveSnapshot {
  readonly format: 1;
  /** g_game.c:1282-1294 header block equivalent (§0.1). */
  header: {
    skill: number; // 1-based deferred-init domain (state.gameskill)
    episode: number;
    map: number;
    playeringame: number[]; // MAXPLAYERS, 0/1
    leveltime: number;
  };
  /** Port-extra (§ header note). */
  rng: { rndindex: number; prndindex: number };
  players: PlayerSnap[];
  sectors: {
    floorZ: number[];
    ceilingZ: number[];
    light: number[];
    special: number[];
    tag: number[];
    /** sector.specialData → live thinker id, 0 = null (re-linked by the
     * thinker passes exactly like P_UnArchiveSpecials re-linking it). */
    specialData: number[];
  };
  /** P_UnArchiveWorld line/side half: flags/special/tag + the animatable
   * side channels (special-48 offsetX pan, button switch textures). */
  lines: { flags: number[]; special: number[]; tag: number[] };
  sides: {
    offsetX: number[];
    top: (string | -1)[];
    bottom: (string | -1)[];
    mid: (string | -1)[];
  };
  /** pplats.floorFlatOverrides channel (live floorpic, deviation-gap
   * shared by pfloor/pplats — canonical state, §0.2 note). */
  flats: [number, string][];
  /** p_switch.c buttonlist[] (vanilla leaves them out of .dsg files; the
   * port's pSpawnSpecials full-reset makes capture-restore the faithful
   * port-level equivalent). */
  buttons: { line: number; where: number; btexture: string; btimer: number }[];
  /** P_ArchiveThinkers: rt.mobjs in SPAWN ORDER (removed slots kept as
   * 1-field tombstone records — roster index == target back-ref domain). */
  mobjs: MobjSnap[];
  /** P_ArchiveSpecials: live non-mobj thinkers in ARENA order. */
  specials: SpecialSnap[];
  /** Live arena entries (all, hash-excluded included) in Map order. */
  arenaOrder: number[];
  /** Run globals + respawn queue + state.ts misc (canonical GameState
   * fields the four vanilla passes do not cover but hashState/tests do). */
  misc: {
    totalsecret: number;
    secretcount: number;
    specialexit: number;
    exitRequest: 0 | 1 | 2;
    totalkills: number;
    totalitems: number;
    turnheld: number;
    gametic: number;
    /** thinker arena id counter (mid-run spawn ids must not collide with
     * the captured reserved ids). */
    nextId: number;
    itemQue: SpawnPoint[];
    itemQueTime: number[];
    iquehead: number;
    iquetail: number;
  };
}

type PlayerSnap = {
  playerstate: number;
  health: number;
  cheats: number;
  viewz: number;
  viewheight: number;
  deltaviewheight: number;
  bob: number;
  damagecount: number;
  bonuscount: number;
  usedown: number;
  forwardmove: number;
  sidemove: number;
  killcount: number;
  itemcount: number;
  frags: number[];
  cmd: [number, number, number, number]; // fwd, side, angleturn, buttons
  attacker: [number, number]; // [kind, index] kind 0 none / 1 mobj / 2 player
  // inventory + psprite slice (P_ArchivePlayers' raw player_t memcpy):
  cards: number[];
  ammo: number[];
  maxammo: number[];
  weaponowned: number[];
  powers: number[];
  armorpoints: number;
  armortype: number;
  backpack: number;
  secretcount: number;
  readyweapon: number;
  pendingweapon: number;
  attackdown: number;
  refire: number;
  extralight: number;
  fixedcolormap: number;
  psprites: [number, number, number, number][]; // state,tics,sx,sy
};

type MobjSnap = {
  thinkerId: number;
  type: number;
  removed: 0 | 1;
  linkSlot: number;
  x: number;
  y: number;
  z: number;
  /** full-field record (kept for tombstones too — inert but comparable) */
  f: {
    momx: number; momy: number; momz: number;
    floorz: number; ceilingz: number;
    angle: number; state: number; tics: number; sprite: number; frame: number;
    flags: number; health: number; reactionTime: number; movedir: number;
    movecount: number; damage: number; lastLook: number; threshold: number;
    radius: number; height: number;
    spawnpoint: SpawnPoint | null;
    target: number; // roster index, -1 = null
    player: number; // player index + 1, 0 = none
    excludeFromHash: 0 | 1;
  };
};

type SpecialSnap =
  | { tc: 'ceiling' | 'plat'; thinkerId: number; active: 0 | 1; sector: number;
      speed: number; crush: number; direction: number; tag: number; type: number;
      // ceiling:
      bottomheight?: number; topheight?: number; olddirection?: number;
      // plat:
      low?: number; high?: number; wait?: number; count?: number;
      status?: number; oldstatus?: number;
      words: number[] }
  | { tc: 'door'; thinkerId: number; sector: number; topheight: number;
      speed: number; direction: number; topwait: number; topcountdown: number;
      type: number; words: number[] }
  | { tc: 'floor'; thinkerId: number; sector: number; type: number;
      crush: number; direction: number; newspecial: number; texture: string;
      dest: number; speed: number; words: number[] }
  | { tc: 'light'; thinkerId: number; kind: LightThinker['kind'];
      sector: number; maxlight: number; minlight: number; count: number;
      maxtime: number; mintime: number; darktime: number; brighttime: number;
      direction: number; words: number[] };

const LIGHT_TO_KIND: Record<string, number> = {
  fireflicker: LIGHT_THINKER_KINDS.fireFlicker,
  lightflash: LIGHT_THINKER_KINDS.lightFlash,
  strobe: LIGHT_THINKER_KINDS.strobe,
  glow: LIGHT_THINKER_KINDS.glow
};

/* ------------------------------------------------------------------ */
/* capture — P_Archive{Players,World,Thinkers,Specials}                 */
/* ------------------------------------------------------------------ */

/** Structured player-field view (all three attach layers are live on any
 * booted player; attach calls below are idempotent no-ops when present). */
type FullPlayer = Player & PsprFields & InventoryFields;

function fullPlayer(p: Player): FullPlayer {
  return initPlayerInventory(attachPsprFields(p)) as FullPlayer;
}

function snapshotPlayer(p: Player, state: GameState): PlayerSnap {
  const q = fullPlayer(p);
  let attacker: [number, number] = [0, 0];
  const a = p.attacker as unknown as Mobj | Player | null;
  if (a !== null && a !== undefined) {
    const moIdx = state.mobjs.mobjs.findIndex((m) => m === (a as Mobj));
    if (moIdx >= 0) attacker = [1, moIdx];
    else {
      const pIdx = state.players.indexOf(a as Player);
      if (pIdx >= 0) attacker = [2, pIdx];
    }
  }
  return {
    playerstate: p.playerstate,
    health: p.health,
    cheats: p.cheats,
    viewz: p.viewz,
    viewheight: p.viewheight,
    deltaviewheight: p.deltaviewheight,
    bob: p.bob,
    damagecount: p.damagecount,
    bonuscount: p.bonuscount,
    usedown: p.usedown ? 1 : 0,
    forwardmove: p.forwardmove,
    sidemove: p.sidemove,
    killcount: p.killcount,
    itemcount: p.itemcount,
    frags: Array.from(p.frags),
    cmd: [p.cmd.forwardmove, p.cmd.sidemove, p.cmd.angleturn, p.cmd.buttons],
    attacker,
    cards: Array.from(p.cards),
    ammo: Array.from(q.ammo),
    maxammo: Array.from(q.maxammo),
    weaponowned: Array.from(q.weaponowned),
    powers: Array.from(q.powers),
    armorpoints: q.armorpoints,
    armortype: q.armortype,
    backpack: q.backpack ? 1 : 0,
    secretcount: q.secretcount,
    readyweapon: q.readyweapon,
    pendingweapon: q.pendingweapon,
    attackdown: q.attackdown ? 1 : 0,
    refire: q.refire,
    extralight: q.extralight,
    fixedcolormap: q.fixedcolormap,
    psprites: q.psprites.map((s) => [s.state, s.tics, s.sx, s.sy])
  };
}

function mobjSnap(m: Mobj, state: GameState): MobjSnap {
  const target = m.target;
  return {
    thinkerId: m.thinker.id,
    type: m.type,
    removed: m.removed ? 1 : 0,
    linkSlot: m.linkSlot,
    x: m.x,
    y: m.y,
    z: m.z,
    f: {
    momx: m.momx,
    momy: m.momy,
    momz: m.momz,
    floorz: m.floorz,
    ceilingz: m.ceilingz,
    angle: m.angle,
    state: m.state,
    tics: m.tics,
    sprite: m.sprite,
    frame: m.frame,
    flags: m.flags,
    health: m.health,
    reactionTime: m.reactionTime,
    movedir: m.movedir,
    movecount: m.movecount,
    damage: m.damage,
    lastLook: m.lastLook,
    threshold: m.threshold,
    radius: m.radius,
    height: m.height,
    spawnpoint: m.spawnpoint ? { ...m.spawnpoint } : null,
    target:
      target !== undefined && !target.removed
        ? state.mobjs.mobjs.indexOf(target as Mobj)
        : -1,
    player: m.player ? state.players.indexOf(m.playerRef as Player) + 1 : 0,
    excludeFromHash: m.thinker.excludeFromHash ? 1 : 0
    }
  };
}

function thinkerWords(t: Thinker): number[] {
  return Array.from(t.hashWords);
}

function classifySpecial(
  t: Thinker
): { snap: SpecialSnap } | null {
  const o = t as unknown as Record<string, unknown>;
  const thinkerId = t.id;
  const words = thinkerWords(t);
  if (typeof o.kind === 'string' && o.kind in LIGHT_TO_KIND) {
    const l = t as unknown as LightThinker;
    return {
      snap: {
        tc: 'light', thinkerId, kind: l.kind, sector: l.sector,
        maxlight: (l as unknown as { maxlight: number }).maxlight,
        minlight: (l as unknown as { minlight: number }).minlight,
        count: (l as unknown as { count?: number }).count ?? 0,
        maxtime: (l as unknown as { maxtime?: number }).maxtime ?? 0,
        mintime: (l as unknown as { mintime?: number }).mintime ?? 0,
        darktime: (l as unknown as { darktime?: number }).darktime ?? 0,
        brighttime: (l as unknown as { brighttime?: number }).brighttime ?? 0,
        direction: (l as unknown as { direction?: number }).direction ?? 0,
        words
      }
    };
  }
  if ('olddirection' in o && 'revive' in o) {
    const c = t as Ceiling;
    return {
      snap: {
        tc: 'ceiling', thinkerId, active: t.fn !== null ? 1 : 0,
        sector: c.sector, speed: c.speed, crush: c.crush ? 1 : 0,
        direction: c.direction, tag: c.tag, type: c.type,
        bottomheight: c.bottomheight, topheight: c.topheight,
        olddirection: c.olddirection, words
      }
    };
  }
  if ('oldstatus' in o && 'revive' in o) {
    const p = t as Plat;
    return {
      snap: {
        tc: 'plat', thinkerId, active: t.fn !== null ? 1 : 0,
        sector: p.sector, speed: p.speed, crush: p.crush ? 1 : 0,
        direction: p.status, tag: p.tag, type: p.type,
        low: p.low, high: p.high, wait: p.wait, count: p.count,
        status: p.status, oldstatus: p.oldstatus, words
      }
    };
  }
  if ('topwait' in o) {
    const d = t as Door;
    return {
      snap: {
        tc: 'door', thinkerId, sector: d.sector, topheight: d.topheight,
        speed: d.speed, direction: d.direction, topwait: d.topwait,
        topcountdown: d.topcountdown, type: d.type, words
      }
    };
  }
  if ('dest' in o && 'newspecial' in o) {
    const f = t as FloorMove;
    return {
      snap: {
        tc: 'floor', thinkerId, sector: f.sector, type: f.type,
        crush: f.crush ? 1 : 0, direction: f.direction,
        newspecial: f.newspecial, texture: f.texture, dest: f.dest,
        speed: f.speed, words
      }
    };
  }
  return null;
}

/** P_Archive* equivalent — pure READ of the live world into the canonical
 * snapshot; zero mutation, zero PRNG (capture never advances the sim). */
export function captureWorld(state: GameState): SaveSnapshot {
  const rt = state.mobjs;
  const mobjByThinker = new Map<number, Mobj>();
  for (const m of rt.mobjs) mobjByThinker.set(m.thinker.id, m);

  const specials: SpecialSnap[] = [];
  const arenaOrder: number[] = [];
  let unknownThinkers = 0;
  for (const t of state.thinkers.entries.values()) {
    if (t.removed) continue;
    arenaOrder.push(t.id);
    if (mobjByThinker.has(t.id)) continue; // tc_mobj rides `mobjs`
    const cls = classifySpecial(t);
    if (cls === null) {
      unknownThinkers++;
      continue; // vanilla P_ArchiveThinkers' silent drop (§0.2)
    }
    specials.push(cls.snap);
  }
  if (unknownThinkers > 0) {
    throw new SavegError(
      `captureWorld: ${unknownThinkers} thinker(s) outside the mobj+special ` +
      'classes (a new thinker family needs a §0.2 classifier row)'
    );
  }

  const sec = state.sectors;
  const lines = state.map.lines;
  const sides = state.map.sides;
  return {
    format: 1,
    header: {
      skill: state.gameskill,
      episode: state.gameepisode,
      map: state.gamemap,
      playeringame: [0, 1, 2, 3].map((i) => (i < state.players.length ? 1 : 0)),
      leveltime: state.leveltime
    },
    rng: { rndindex: state.rng.rndindex, prndindex: state.rng.prndindex },
    players: state.players.map((p) => snapshotPlayer(p, state)),
    sectors: {
      floorZ: Array.from(sec.floorZ),
      ceilingZ: Array.from(sec.ceilingZ),
      light: Array.from(sec.light),
      special: Array.from(sec.special),
      tag: Array.from(sec.tag),
      specialData: sec.specialData.map((t) => (t === null || t === undefined ? 0 : t.id))
    },
    lines: {
      flags: Array.from(lines.flags),
      special: Array.from(lines.special),
      tag: Array.from(lines.tag)
    },
    sides: {
      offsetX: Array.from(sides.offsetX),
      top: Array.from(sides.topTexture),
      bottom: Array.from(sides.bottomTexture),
      mid: Array.from(sides.midTexture)
    },
    flats: Array.from(floorFlatOverrides.entries()),
    buttons: buttonList.slice(0, MAXBUTTONS).map((b) => ({
      line: b.line, where: b.where, btexture: b.btexture, btimer: b.btimer
    })),
    mobjs: rt.mobjs.map((m) => mobjSnap(m, state)),
    specials,
    arenaOrder,
    misc: {
      totalsecret: state.totalsecret,
      secretcount: state.secretcount,
      specialexit: state.specialexit ? 1 : 0,
      exitRequest:
        state.exitRequest === 'none' ? 0 : state.exitRequest === 'normal' ? 1 : 2,
      totalkills: rt.totalkills,
      totalitems: rt.totalitems,
      turnheld: state.turnheld,
      gametic: state.gametic,
      nextId: state.thinkers.nextId,
      itemQue: rt.itemQue.map((s) => ({ ...s })),
      itemQueTime: Array.from(rt.itemQueTime),
      iquehead: rt.iquehead,
      iquetail: rt.iquetail
    }
  };
}

/* ------------------------------------------------------------------ */
/* restore — the P_UnArchive* passes over an ALREADY rebuilt world      */
/* ------------------------------------------------------------------ */

export class SavegError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SavegError';
  }
}

/** Apply pass 1 (and the post-thinker re-apply): the player_t struct.
 * mo/attacker/psprite re-pointing follows the thinker pass (vanilla binds
 * player->mo in P_UnArchiveThinkers, §0.2). */
function unarchivePlayers(state: GameState, snaps: PlayerSnap[]): void {
  for (let i = 0; i < snaps.length && i < state.players.length; i++) {
    const s = snaps[i]!;
    const p = state.players[i]!;
    const q = fullPlayer(p);
    p.playerstate = s.playerstate;
    p.health = s.health;
    p.cheats = s.cheats;
    p.viewz = s.viewz;
    p.viewheight = s.viewheight;
    p.deltaviewheight = s.deltaviewheight;
    p.bob = s.bob;
    p.damagecount = s.damagecount;
    p.bonuscount = s.bonuscount;
    p.usedown = s.usedown !== 0;
    p.forwardmove = s.forwardmove;
    p.sidemove = s.sidemove;
    // p_saveg.c:96 — P_SerializePlayers NULLS player->message
    // (never archived); our P_SpawnPlayerFromStart pass already cleared it
    // through its registered write site, so nothing to restore here.
    p.killcount = s.killcount;
    p.itemcount = s.itemcount;
    for (let f = 0; f < p.frags.length && f < s.frags.length; f++) p.frags[f] = s.frags[f]!;
    p.cmd.forwardmove = s.cmd[0];
    p.cmd.sidemove = s.cmd[1];
    p.cmd.angleturn = s.cmd[2];
    p.cmd.buttons = s.cmd[3];
    for (let c = 0; c < p.cards.length && c < s.cards.length; c++) p.cards[c] = s.cards[c]!;
    copyArr(q.ammo, s.ammo);
    copyArr(q.maxammo, s.maxammo);
    copyArr(q.weaponowned, s.weaponowned);
    copyArr(q.powers, s.powers);
    q.armorpoints = s.armorpoints;
    q.armortype = s.armortype;
    q.backpack = s.backpack !== 0;
    q.secretcount = s.secretcount;
    q.readyweapon = s.readyweapon;
    q.pendingweapon = s.pendingweapon;
    q.attackdown = s.attackdown !== 0;
    q.refire = s.refire;
    q.extralight = s.extralight;
    q.fixedcolormap = s.fixedcolormap;
    for (let sIdx = 0; sIdx < q.psprites.length && sIdx < s.psprites.length; sIdx++) {
      const w = s.psprites[sIdx]!;
      const d = q.psprites[sIdx]!;
      d.state = w[0];
      d.tics = w[1];
      d.sx = w[2];
      d.sy = w[3];
    }
  }
}

function copyArr(dst: Int32Array, src: number[]): void {
  for (let i = 0; i < dst.length && i < src.length; i++) dst[i] = src[i]!;
}

/** Pass 2 (P_UnArchiveWorld): heights/light/special + tag + the line/side
 * state + the flat channel. specialdata is CLEARED here (§0.2 zeroes it)
 * and re-linked by the thinker passes via the sector record's ids. */
function unarchiveWorld(state: GameState, snap: SaveSnapshot): void {
  const sec = state.sectors;
  copyArr(sec.floorZ, snap.sectors.floorZ);
  copyArr(sec.ceilingZ, snap.sectors.ceilingZ);
  copyArr(sec.light, snap.sectors.light);
  copyArr(sec.special, snap.sectors.special);
  copyArr(sec.tag, snap.sectors.tag);
  sec.specialData.fill(null);
  copyArr(state.map.lines.flags, snap.lines.flags);
  copyArr(state.map.lines.special, snap.lines.special);
  copyArr(state.map.lines.tag, snap.lines.tag);
  copyArr(state.map.sides.offsetX, snap.sides.offsetX);
  for (let i = 0; i < state.map.sides.count; i++) {
    if (i < snap.sides.top.length) (state.map.sides.topTexture as string[])[i] = snap.sides.top[i] as string;
    if (i < snap.sides.bottom.length) (state.map.sides.bottomTexture as string[])[i] = snap.sides.bottom[i] as string;
    if (i < snap.sides.mid.length) (state.map.sides.midTexture as string[])[i] = snap.sides.mid[i] as string;
  }
  floorFlatOverrides.clear();
  for (const [sector, flat] of snap.flats) floorFlatOverrides.set(sector, flat);
  for (let i = 0; i < MAXBUTTONS; i++) {
    const b = buttonList[i]!;
    const c = snap.buttons[i];
    if (!c) {
      b.line = -1;
      b.where = 0;
      b.btexture = '';
      b.btimer = 0;
      continue;
    }
    b.line = c.line;
    b.where = c.where;
    b.btexture = c.btexture;
    b.btimer = c.btimer;
  }
}

/** Pass 3 (P_UnArchiveThinkers): remove ALL thinkers + mobjs, rebuild the
 * roster in spawn order at the captured thinker ids, rebind target/player
 * references. Player mobjs respawn through pplayer's P_SpawnPlayer (the
 * reserved id + the state-only thinker fn + the player<->mobj links stay
 * exactly where production puts them), everything else through
 * pSpawnMobj (static things re-enter their ORIGINAL static grid slot so
 * the crush z-authority rule — grid owns static z — survives reload). */
function unarchiveThinkers(state: GameState, snap: SaveSnapshot): void {
  const rt = state.mobjs;
  const links = state.pmap.links;

  // P_RemoveAllThinkers + the mobj roster purge. Direct (NOT pRemoveMobj —
  // that would feed the item-respawn queue we are about to restore wholesale).
  for (const m of rt.mobjs) {
    if (!m.removed && m.linkSlot >= 0) thingUnsetPosition(links, m.linkSlot);
  }
  rt.slotMobjs.clear();
  rt.mobjs.length = 0;
  state.thinkers.entries.clear();
  state.thinkers.pending.length = 0;
  activeCeilings.fill(null);
  activePlats.fill(null);

  for (const rec of snap.mobjs) {
    const isStatic = rec.linkSlot >= 0 && rec.linkSlot < links.staticCount;
    let m: Mobj;
    if (rec.f !== undefined && rec.f.player > 0) {
      // Player mobj — P_SpawnPlayer path for the fn/links, fields below.
      const pIdx = rec.f.player - 1;
      const p = state.players[pIdx];
      if (!p) throw new SavegError(`player mobj for missing player ${pIdx}`);
      const start: SpawnPoint = {
        x: rec.x >> 16, y: rec.y >> 16, angle: 0, type: pIdx + 1, options: 0
      };
      const spawn = rt.playerSpawnFn;
      if (spawn === undefined) throw new SavegError('playerSpawnFn unbound');
      spawn(rt, start);
      m = rt.mobjs[rt.mobjs.length - 1]!;
      // Exact geometry: the P_SpawnPlayer start is UNIT-granular (<<16 of
      // a truncated >>16) — re-position to the captured fixed point.
      m.x = rec.x;
      m.y = rec.y;
      m.z = rec.z;
      thingUnsetPosition(links, m.linkSlot);
      thingSetPosition(links, m.linkSlot, rec.x, rec.y);
      links.z[m.linkSlot] = rec.z;
    } else {
      m = pSpawnMobj(
        rt, rec.x, rec.y, rec.z, rec.type,
        isStatic ? rec.linkSlot : -1,
        { skipLastLookRandom: true, thinkerId: rec.thinkerId }
      );
      if (isStatic && (links.flags[rec.linkSlot]! & MF_NOBLOCKMAP) === 0) {
        links.linked[rec.linkSlot] = 1; // static CSR cell membership returns
      }
    }
    if (rec.removed) rt.slotMobjs.delete(m.linkSlot);
    const f = rec.f;
    m.momx = f.momx;
    m.momy = f.momy;
    m.momz = f.momz;
    m.floorz = f.floorz;
    m.ceilingz = f.ceilingz;
    m.angle = f.angle;
    m.state = f.state;
    m.tics = f.tics;
    m.sprite = f.sprite;
    m.frame = f.frame;
    pSetMobjFlags(m, f.flags); // mirrors into the grid slot (words[5])
    m.health = f.health;
    m.reactionTime = f.reactionTime;
    m.movedir = f.movedir;
    m.movecount = f.movecount;
    m.damage = f.damage;
    m.lastLook = f.lastLook;
    m.threshold = f.threshold;
    m.radius = f.radius;
    m.height = f.height;
    m.spawnpoint = f.spawnpoint ? { ...f.spawnpoint } : null;
    const target = f.target >= 0 ? rt.mobjs[f.target] : undefined;
    if (target !== undefined && !target.removed) m.target = target;
    else m.target = undefined;
    if (f.player > 0) {
      const p = state.players[f.player - 1]!;
      m.player = true;
      (m as Mobj & { playerRef?: Player }).playerRef = p;
      m.thinker.excludeFromHash = true;
      // pplayer also writes the player-side `reactiontime` spelling:
      (m as Mobj & { reactiontime?: number }).reactiontime = f.reactionTime;
    }
    syncMobj(m);
    if (rec.removed) {
      // Tombstone bookkeeping AFTER the fields (inert roster placeholder
      // keeping target indices stable — p_mobj.ts header rule).
      if (m.linkSlot >= 0) thingUnsetPosition(links, m.linkSlot);
      pRemoveThinker(m.thinker);
      m.removed = true;
      rt.slotMobjs.delete(m.linkSlot);
    }
  }
}

/** Pass 4 (P_UnArchiveSpecials): rebuild the family thinkers, re-fabricate
 * the fn closures from the exported T_* bodies (function-identity ≡
 * family-identity, §0.2), re-register the active ceiling/plat lists
 * (dormant ones included), and re-link sector.specialdata by id. */
function unarchiveSpecials(state: GameState, snap: SaveSnapshot): void {
  const s = state as unknown as SpecWorld;
  const ctx = makePlaneContext(state as unknown as Parameters<typeof makePlaneContext>[0]);
  const byId = new Map<number, Thinker>();

  const newSpecial = (
    thinkerId: number,
    fn: Thinker['fn'],
    fields: Record<string, unknown>
  ): Thinker => {
    const t = pAddThinker(state.thinkers, fn, thinkerId);
    Object.assign(t, fields);
    byId.set(thinkerId, t);
    return t;
  };

  for (const sp of snap.specials) {
    switch (sp.tc) {
      case 'ceiling': {
        const revive: Thinker['fn'] = (self) => tMoveCeiling(s, ctx, self as Ceiling);
        const t = newSpecial(sp.thinkerId, sp.active ? revive : null, {
          sector: sp.sector,
          bottomheight: sp.bottomheight,
          topheight: sp.topheight,
          speed: sp.speed,
          crush: sp.crush !== 0,
          direction: sp.direction,
          tag: sp.tag,
          olddirection: sp.olddirection,
          type: sp.type,
          revive,
          hashWords: [...sp.words]
        }) as Ceiling;
        pAddActiveCeiling(s, t);
        break;
      }
      case 'plat': {
        const revive: Thinker['fn'] = (self) => tPlatRaise(s, ctx, self as Plat);
        const t = newSpecial(sp.thinkerId, sp.active ? revive : null, {
          sector: sp.sector,
          speed: sp.speed,
          low: sp.low,
          high: sp.high,
          wait: sp.wait,
          count: sp.count,
          status: sp.status ?? sp.direction,
          oldstatus: sp.oldstatus ?? sp.direction,
          crush: sp.crush !== 0,
          tag: sp.tag,
          type: sp.type,
          revive,
          hashWords: [...sp.words]
        }) as Plat;
        pAddActivePlat(s, t);
        break;
      }
      case 'door': {
        newSpecial(sp.thinkerId, (self) => tVerticalDoor(s, ctx, self as Door), {
          sector: sp.sector,
          topheight: sp.topheight,
          speed: sp.speed,
          direction: sp.direction,
          topwait: sp.topwait,
          topcountdown: sp.topcountdown,
          type: sp.type,
          hashWords: [...sp.words]
        });
        break;
      }
      case 'floor': {
        newSpecial(sp.thinkerId, (self) => tMoveFloor(s, ctx, self as FloorMove), {
          sector: sp.sector,
          type: sp.type,
          crush: sp.crush !== 0,
          direction: sp.direction,
          newspecial: sp.newspecial,
          texture: sp.texture,
          dest: sp.dest,
          speed: sp.speed,
          hashWords: [...sp.words]
        });
        break;
      }
      case 'light': {
        const kindCode = LIGHT_TO_KIND[sp.kind]!;
        const fn: Thinker['fn'] =
          sp.kind === 'fireflicker'
            ? (self) => tFireFlicker(s, self)
            : sp.kind === 'lightflash'
              ? (self) => tLightFlash(s, self)
              : sp.kind === 'strobe'
                ? (self) => tStrobeFlash(s, self)
                : (self) => tGlow(s, self);
        const words = [kindCode, sp.words[1] ?? 0];
        newSpecial(sp.thinkerId, fn, {
          kind: sp.kind,
          sector: sp.sector,
          maxlight: sp.maxlight,
          minlight: sp.minlight,
          count: sp.count,
          maxtime: sp.maxtime,
          mintime: sp.mintime,
          darktime: sp.darktime,
          brighttime: sp.brighttime,
          direction: sp.direction,
          words,
          hashWords: words
        });
        break;
      }
    }
  }

  // sector->specialdata re-link (§0.2: the thinker passes re-link it).
  for (let i = 0; i < state.sectors.specialData.length; i++) {
    const id = snap.sectors.specialData[i]!;
    if (id === 0) continue;
    const t = resolveThinker(state, byId, id);
    if (t === undefined) throw new SavegError(`specialdata → missing thinker ${id}`);
    state.sectors.specialData[i] = t;
  }

  // player->attacker rebind (vanilla binds references after the passes).
  for (let i = 0; i < snap.players.length && i < state.players.length; i++) {
    const [kind, idx] = snap.players[i]!.attacker;
    const p = state.players[i]!;
    if (kind === 0) p.attacker = null;
    else if (kind === 1) {
      const m = state.mobjs.mobjs[idx];
      p.attacker = m !== undefined && !m.removed ? m : null;
    } else p.attacker = (state.players[idx] ?? null) as unknown as Player['attacker'];
  }

  // Arena insertion-order rebuild (hashState walks Map order; §3.5-6).
  const arena = state.thinkers;
  const all = new Map<number, Thinker>();
  const collect = (t: Thinker) => all.set(t.id, t);
  for (const m of state.mobjs.mobjs) if (!m.removed) collect(m.thinker);
  for (const t of byId.values()) collect(t);
  arena.entries.clear();
  for (const id of snap.arenaOrder) {
    const t = all.get(id) ?? resolveThinker(state, byId, id);
    if (t === undefined) throw new SavegError(`arena order → missing thinker ${id}`);
    arena.entries.set(id, t);
  }
}

/** Look a captured thinker id up across both respawn passes. */
function resolveThinker(
  state: GameState, specials: Map<number, Thinker>, id: number
): Thinker | undefined {
  const m = state.mobjs.mobjs.find((mo) => mo.thinker.id === id && !mo.removed);
  return m?.thinker ?? specials.get(id);
}

/**
 * The four P_UnArchive* passes + the g_game.c:1233 leveltime + the payload
 * RNG tail. REQUIRES the caller to have rebuilt the level FIRST
 * (gInitNew(skill,ep,map), the g_game.c:1226 site — game.ts's gDoLoadGame
 * does exactly that) onto the SAME state identity, on the same map the
 * snapshot's header names.
 */
export function restoreWorld(state: GameState, snap: SaveSnapshot): void {
  if (snap.format !== 1) throw new SavegError(`unsupported snapshot format ${String(snap.format)}`);
  if (
    snap.header.skill !== state.gameskill ||
    snap.header.episode !== state.gameepisode ||
    snap.header.map !== state.gamemap
  ) {
    throw new SavegError(
      `restoreWorld: snapshot header skill/ep/map ${snap.header.skill}/${snap.header.episode}/${snap.header.map} ` +
      `!= rebuilt world ${state.gameskill}/${state.gameepisode}/${state.gamemap} — run gInitNew first`
    );
  }
  attachPsprFields(state.players[0]!);
  for (const p of state.players) initPlayerInventory(p);
  unarchivePlayers(state, snap.players); // pass 1
  unarchiveWorld(state, snap); // pass 2
  state.leveltime = snap.header.leveltime; // g_game.c:1233 (post-InitNew)
  unarchiveThinkers(state, snap); // pass 3
  unarchiveSpecials(state, snap); // pass 4
  unarchivePlayers(state, snap.players); // re-apply after pplayer's clears
  // (P_UnArchiveThinkers binds player->mo; pSpawnPlayerFromStart clears
  // viewheight/message/refire/extralight/psprites — the canonical values
  // land AFTER, mirroring vanilla's memcpy-the-struct semantics.)

  // RNG tail (port deviation documented at the header — the reset already
  // ran inside gInitNew; the payload's captured indices land last).
  state.rng.rndindex = snap.rng.rndindex;
  state.rng.prndindex = snap.rng.prndindex;

  const rt = state.mobjs;
  state.totalsecret = snap.misc.totalsecret;
  state.secretcount = snap.misc.secretcount;
  state.specialexit = snap.misc.specialexit !== 0;
  state.exitRequest = snap.misc.exitRequest === 0 ? 'none' : snap.misc.exitRequest === 1 ? 'normal' : 'secret';
  state.turnheld = snap.misc.turnheld;
  // gametic rides the payload (port-extra: hashState hashes gametic, and
  // the golden property demands continuation — the vanilla process-global
  // notion of gametic has no browser-run analogue).
  state.gametic = snap.misc.gametic;
  // id counter PAST every captured id (mid-run spawns must never reuse a
  // live reserved id — Map.set would silently replace).
  state.thinkers.nextId = Math.max(state.thinkers.nextId, snap.misc.nextId);
  rt.totalkills = snap.misc.totalkills;
  rt.totalitems = snap.misc.totalitems;
  for (let i = 0; i < snap.misc.itemQue.length; i++) rt.itemQue[i] = { ...snap.misc.itemQue[i]! };
  for (let i = 0; i < snap.misc.itemQueTime.length; i++) rt.itemQueTime[i] = snap.misc.itemQueTime[i]!;
  rt.iquehead = snap.misc.iquehead;
  rt.iquetail = snap.misc.iquetail;
}
