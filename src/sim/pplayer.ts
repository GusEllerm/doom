// sim/pplayer.ts — M7-03: player mobj states, pain/death flow, reborn.
//
// Sources (verbatim targets, line numbers against the 62-file mirror):
//   p_mobj.c  P_SpawnPlayer (:642-703) — real MT_PLAYER mobj via
//             P_SpawnMobj, MF_TRANSSHIFT translations, player<->mobj link,
//             the PST_REBORN -> G_PlayerReborn branch, P_SetupPsprites.
//   p_mobj.c  P_MobjThinker (:415-451) — the player mobj ticks IN the
//             M7-02 arena (registered through the playerSpawnFn seam at
//             the player-start thing's THINGS-lump position, so the
//             vanilla thinker-list position is exact).
//   p_user.c  P_DeathThink (:180-232) — death cam: psprites tick,
//             viewheight -> 6*FRACUNIT, ANG5 turn-to-attacker with the
//             damagecount fade, BT_USE -> PST_REBORN.
//   p_inter.c P_KillMobj (:668-764) PLAYER branch — MF_SHOOTABLE/FLOAT/
//             SKULLFLY off, MF_CORPSE|MF_DROPOFF on, height >>= 2,
//             MF_SOLID off + PST_DEAD + P_DropWeapon (M7-04 hook) +
//             self-frag on env kills, XDIE1 vs DIE1 via
//             health < -spawnhealth, the `tics -= P_Random()&3` clamp.
//   p_inter.c P_DamageMobj (:775-947) player-reachable half — thrust kick,
//             sector-11 hell hack, CF_GODMODE/pw_invulnerability gate,
//             health mirror (player.health EXISTS in this port, d_player.h
//             slice), damagecount/attacker, pain-chance draw
//             (P_Random() < 255 = mobjinfo MT_PLAYER), MF_JUSTHIT +
//             S_PLAY_PAIN, reactiontime = 0, the generic retarget.
//   g_game.c  G_PlayerReborn (:800-831) — the exact respawn clears list
//             (everything memset EXCEPT frags/killcount/itemcount/
//             secretcount; usedown/attackdown=true; MAXHEALTH; pistol).
//   p_enemy.c A_Pain / A_PlayerScream / A_Fall / A_XScream — the
//             S_PLAY_* state-table actions ONLY (info.c:292-309 action
//             column: S_PLAY_PAIN2 A_Pain, S_PLAY_DIE2 A_PlayerScream,
//             S_PLAY_DIE3/XDIE3 A_Fall, S_PLAY_XDIE2 A_XScream;
//             A_Light0/1/2 arrived with M7-01 p_pspr.ts).
//
// Hash rule (ARCHITECTURE §3.4, gates): the player mobj's thinker is
// `excludeFromHash` (ptick.ts) — the player serializes through the ONE
// players[] block exactly as in the M5-M6 goldens; the mobj's state/tics
// join the blessed serialization with the M7-06 hash update (follow-up).
//
// Deviations (documented, pinned by tests):
//  D-t1: the player spawn skips the P_SpawnMobj lastlook P_Random draw
//        (p_mobj.c:508) — the blessed feel/headless hashes pin the rng
//        indices and lastlook is never read for players.
//  D-t2: P_DropWeapon is a counted hook (its body lives in p_inter.c,
//        M7-04's file); AM_Stop/ST_Start/HU_Start are counted seams (HUD/
//        automap state is M9). Armor (armortype/armorpoints) and
//        I_Tactile have no field/sink in this port's Player slice yet —
//        M7-04/M10.
//  D-t3: G_DoReborn's gameaction=ga_level level reload is the game-layer
//        loop (M7-08); pPlayerReborn is the verbatim clears list and
//        pSpawnPlayerFromStart reproduces the vanilla reborn SPAWN
//        (P_SetupLevel -> P_LoadThings -> P_SpawnPlayer) on demand.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  ANG180,
  ANG45,
  ANG90,
  ANGLETOFINESHIFT,
  FRACUNIT
} from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';

import { mobjinfo, MF, MF_TRANSSHIFT, MT } from '../wad/info/mobjinfo';
import { S } from '../wad/info/states';

import { sectorAtPoint } from './bsp';
import { pRandom } from './prng';
import {
  asMobj,
  pSetMobjState,
  pSpawnMobj,
  type Mobj,
  type MobjRuntime,
  type SpawnPoint
} from './p_mobj';
import {
  AM_CLIP,
  attachPsprFields,
  bindPsprWorld,
  pMovePsprites,
  psprGlobals,
  psprHooks,
  pSetupPsprites,
  WP_CHAINSAW,
  WP_FIST,
  WP_PISTOL,
  type PsprPlayer
} from './p_pspr';
import { pCalcHeight, puserGlobals, puserHooks } from './puser';
import { pointToAngleOrigin } from './pslide';
import { ACT, registerAction } from './a_actions';
import {
  CF_GODMODE,
  ONFLOORZ,
  PST_DEAD,
  PST_LIVE,
  PST_REBORN,
  VIEWHEIGHT,
  type MobjStub,
  type Player
} from './player';
import type { MoveMobj } from './pmove';
import { BT_USE, createTiccmd } from './ticcmd';
import type { GameState } from './state';

/** p_local.h:61 `#define BASETHRESHOLD 100`. */
export const BASETHRESHOLD = 100;

/** Reserved thinker-id range for player mobjs (ptick.ts reservedId):
 * stays OFF the hashed id counter so the blessed M7-02 thinker ids of
 * everything else never shift (their ids proxy the vanilla list
 * position; the player entry is hash-excluded AND must not displace
 * the numbering). */
const PLAYER_THINKER_ID_BASE = 0x40000000;
let playerThinkerSeq = 0;

/** p_user.c:176 `#define ANG5 (ANG90/18)` — the death-cam turn step. */
export const ANG5 = (ANG90 / 18) | 0;

/** d_player.h `#define MAXHEALTH 100` (G_PlayerReborn health). */
export const MAXHEALTH = 100;

/** doomdef.h:214-222 powertype_t — pw_invulnerability = 0 (the
 * P_DamageMobj gate; NOTE: p_pspr.ts PW_STRENGTH=0 disagrees with the
 * source enum (pw_strength=1) — flagged to M7-05 as a follow-up). */
export const PW_INVULNERABILITY = 0;

/* ------------------------------------------------------------------ */
/* Observability (counted, never hashed)                                */
/* ------------------------------------------------------------------ */

export const pplayerHookCounts = {
  /** P_SpawnPlayer calls (spawn + scripted reborn spawns). */
  spawnPlayer: 0,
  /** G_PlayerReborn calls (via the PST_REBORN spawn branch). */
  playerReborn: 0,
  /** P_KillMobj player-branch entries. */
  killPlayer: 0,
  /** P_DamageMobj pain-state sets on the player. */
  painStates: 0,
  /** P_DropWeapon hook (M7-04 fills; p_inter.c body owner). */
  dropWeapon: 0,
  /** AM_Stop gate (automapactive arrives with the M9 automap state). */
  amStop: 0,
  /** ST_Start + HU_Start (M9 HUD). */
  stHudStart: 0,
  /** P_KillMobj on NON-player targets (generic path ran; drop table and
   * monster pain/death STATE tables are M7-07/M8). */
  killNonPlayer: 0
};

export function resetPplayerHookCounts(): void {
  for (const k of Object.keys(pplayerHookCounts) as (keyof typeof pplayerHookCounts)[]) {
    pplayerHookCounts[k] = 0;
  }
}

/** S_StartSound seam for the player-state actions (M7-06 slot / M10
 * audio): register to receive (mobj, sfx_* token, leveltime). */
export const pplayerHooks: {
  startSound?: (mo: Mobj, token: string, tic: number) => void;
} = {};

export const pplayerSoundLog: { token: string; tic: number }[] = [];
const SOUND_LOG_CAP = 256;

function playSound(mo: Mobj, token: string): void {
  if (token === 'sfx_None' || token === '0') return; // info.c '0' == None
  const tic = mo.rt.state.leveltime;
  if (pplayerSoundLog.length < SOUND_LOG_CAP) pplayerSoundLog.push({ token, tic });
  pplayerHooks.startSound?.(mo, token, tic);
}

export function resetPplayerSoundLog(): void {
  pplayerSoundLog.length = 0;
}

/* ------------------------------------------------------------------ */
/* Level bind (gInitGame wiring; game.ts -> bindPplayerLevel)           */
/* ------------------------------------------------------------------ */

/**
 * Wire one level: attach the p_pspr fields (M7-01 seam), bind the p_pspr
 * world (rng + leveltime), register the player mobj spawn hook on the
 * mobj runtime (pSpawnMapThing calls it AT the player-start thing's
 * position — vanilla P_LoadThings thinker order). Idempotent per level.
 */
export function bindPplayerLevel(state: GameState): void {
  for (const p of state.players) attachPsprFields(p);
  bindPsprWorld({ rng: state.rng, leveltime: state.leveltime });
  state.mobjs.playerSpawnFn = playerSpawnHook;
}

/** pSpawnMapThing's `if (!deathmatch) P_SpawnPlayer (mthing);` (M7-03
 * seam, p_mobj.ts). `playeringame[type-1]` == the slot exists in
 * `state.players` (single player = slot 0 only in this port). */
function playerSpawnHook(rt: MobjRuntime, start: SpawnPoint): void {
  const p = rt.state.players[start.type - 1];
  if (!p) return; // playeringame gate
  pSpawnPlayerFromStart(rt, p, start);
}

/* ------------------------------------------------------------------ */
/* P_SpawnPlayer — p_mobj.c:642-703                                     */
/* ------------------------------------------------------------------ */

/**
 * `P_SpawnPlayer(mthing)` verbatim: G_PlayerReborn on PST_REBORN, the
 * MT_PLAYER P_SpawnMobj (ONFLOORZ), player>1 MF_TRANSSHIFT color
 * translations, `ANG45 * (mthing->angle/45)` (C truncating division,
 * unsigned multiply), the player<->mobj links, `mobj->health = p->health`,
 * the clears (refire/message/damagecount/bonuscount/extralight/
 * fixedcolormap/viewheight), P_SetupPsprites, deathmatch cards, ST/HU.
 *
 * Port notes: (a) `fixedcolormap` has no Player field yet (M7-06 view
 * state) — the clear is a no-op; (b) ST_Start/HU_Start count; (c) the
 * thinker hash dedup per the header (players[] already serializes x/y/z/
 * angle/mom — double-hashing would move every blessed golden).
 */
export function pSpawnPlayerFromStart(rt: MobjRuntime, p: Player, start: SpawnPoint): Mobj {
  pplayerHookCounts.spawnPlayer++;
  if (p.playerstate === PST_REBORN) pPlayerReborn(p); // p_mobj.c:656-657

  const x = (start.x << 16) | 0;
  const y = (start.y << 16) | 0;
  // D-t1: skipLastLookRandom — the one documented rng deviation.
  const m = pSpawnMobj(rt, x, y, ONFLOORZ, MT.MT_PLAYER, -1, {
    skipLastLookRandom: true,
    thinkerId: PLAYER_THINKER_ID_BASE + playerThinkerSeq++
  });

  if (start.type > 1) m.flags = (m.flags | ((start.type - 1) << MF_TRANSSHIFT)) | 0;
  // p_mobj.c:665 `mobj->angle = ANG45 * (mthing->angle/45);`
  m.angle = Math.imul(ANG45, Math.trunc(start.angle / 45)) >>> 0;

  // mobj->player = p; — playerRef stands for the pointer (pmove.ts rule).
  const mo = m as Mobj & { playerRef?: Player; reactiontime?: number };
  mo.playerRef = p;
  // The port's player-side reactiontime spelling (puser/ptelept read it;
  // MT_PLAYER mobjinfo reactionTime is 0, so the spawn values agree —
  // teleports' 18 lands on the field p_user.c:272 reads).
  mo.reactiontime = 0;
  m.player = true;
  m.health = p.health;

  // Hash dedup: players[] serializes this mobj's mover fields (state.ts).
  m.thinker.excludeFromHash = true;

  p.mo = m as unknown as MobjStub;
  p.playerstate = PST_LIVE;
  const pp = attachPsprFields(p);
  pp.refire = 0;
  p.message = '';
  p.damagecount = 0;
  p.bonuscount = 0;
  pp.extralight = 0;
  // (fixedcolormap: no field in this slice yet — doc note (a).)
  p.viewheight = VIEWHEIGHT;
  p.deltaviewheight = 0;

  // setup gun psprite
  pSetupPsprites(pp);

  // give all cards in death match mode
  if (rt.deathmatch) p.cards.fill(1);

  if (start.type - 1 === 0 /* consoleplayer (single-player port) */) {
    pplayerHookCounts.stHudStart++; // ST_Start() + HU_Start() (M9)
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* G_PlayerReborn — g_game.c:800-831 (the respawn clears list)           */
/* ------------------------------------------------------------------ */

/**
 * `G_PlayerReborn(player)` verbatim: preserve frags/killcount/itemcount/
 * secretcount, `memset(p, 0, sizeof(*p))`, restore the four, then
 * usedown=attackdown=true, PST_LIVE, health=MAXHEALTH,
 * readyweapon=pendingweapon=wp_pistol, fists+pistol owned, 50 clips,
 * maxammo reset.
 *
 * memset mapping (every field of this port's Player slice, ONE source):
 * secretcount lives game-level (state.secretcount — untouched; the
 * per-player count joins the M7-08 intermission), maxammo has no field
 * yet (M7-05 ammo economy — flagged), `p->mo` is NOT touched: vanilla
 * memsets it to NULL and P_SpawnPlayer immediately assigns the new mobj
 * — same here via the caller chain, and the OLD mobj keeps its
 * playerRef -> p, reproducing vanilla's dying-corpse back-pointer quirk.
 */
export function pPlayerReborn(p: Player): void {
  pplayerHookCounts.playerReborn++;

  const pp = attachPsprFields(p);
  // "memset(p, 0, sizeof(*p))":
  p.viewz = 0;
  p.viewheight = 0; // memset value; P_SpawnPlayer re-sets VIEWHEIGHT
  p.deltaviewheight = 0;
  p.bob = 0;
  p.forwardmove = 0;
  p.sidemove = 0;
  p.cmd = createTiccmd(); // memset(&cmd, 0)
  p.cheats = 0; // G_PlayerReborn KILLS cheats (vanilla)
  p.cards.fill(0);
  p.message = '';
  p.damagecount = 0;
  p.bonuscount = 0;
  p.attacker = null;
  pp.attackdown = true; // "don't do anything immediately"
  pp.refire = 0;
  pp.extralight = 0;
  pp.powers.fill(0);
  pp.ammo.fill(0);
  pp.weaponowned.fill(0);
  // restores + g_game.c:820-830 (frags/killcount/itemcount never touched
  // above = preserved ✓; secretcount preserved at game level):
  p.usedown = true;
  p.playerstate = PST_LIVE;
  p.health = MAXHEALTH;
  pp.readyweapon = WP_PISTOL;
  pp.pendingweapon = WP_PISTOL;
  pp.weaponowned[WP_FIST] = 1;
  pp.weaponowned[WP_PISTOL] = 1;
  pp.ammo[AM_CLIP] = 50;
  // (maxammo[i] = maxammo[i]: no field yet — M7-05.)
}

/* ------------------------------------------------------------------ */
/* P_DeathThink — p_user.c:180-232                                      */
/* ------------------------------------------------------------------ */

/**
 * `P_DeathThink(player)` verbatim: P_MovePsprites, the viewheight sink
 * to 6*FRACUNIT, deltaviewheight=0, the onground write (p_user.c's own
 * definition, read back by P_CalcHeight), the ANG5 turn-toward-attacker
 * with the `delta < ANG5 || delta > (unsigned)-ANG5` facing window
 * (facing the killer fades damagecount), the no-attacker fade, and
 * BT_USE -> PST_REBORN. Registered on the puser seam at module load.
 */
export function pDeathThink(p: Player, leveltime: number): void {
  const pp = p as Partial<PsprPlayer> as PsprPlayer;
  if (pp.psprites !== undefined) pMovePsprites(pp, leveltime);

  // fall to the ground
  if (p.viewheight > 6 * FRACUNIT) p.viewheight = (p.viewheight - FRACUNIT) | 0;
  if (p.viewheight < 6 * FRACUNIT) p.viewheight = 6 * FRACUNIT;

  p.deltaviewheight = 0;
  puserGlobals.onground = p.mo.z <= p.mo.floorz;
  pCalcHeight(p, leveltime);

  const att = p.attacker;
  if (att && att !== (p.mo as unknown as MoveMobj)) {
    const angle = pointToAngleOrigin((att.x - p.mo.x) | 0, (att.y - p.mo.y) | 0) >>> 0;
    const delta = (angle - p.mo.angle) >>> 0;
    if (delta < ANG5 || delta > ((0 - ANG5) >>> 0)) {
      // Looking at killer, so fade damage flash down.
      p.mo.angle = angle;
      if (p.damagecount) p.damagecount--;
    } else if (delta < 0x80000000) {
      p.mo.angle = (p.mo.angle + ANG5) >>> 0;
    } else {
      p.mo.angle = (p.mo.angle - ANG5) >>> 0;
    }
  } else if (p.damagecount) {
    p.damagecount--;
  }

  if (p.cmd.buttons & BT_USE) p.playerstate = PST_REBORN;
}

puserHooks.deathThink = pDeathThink;

/* ------------------------------------------------------------------ */
/* P_KillMobj — p_inter.c:668-764                                       */
/* ------------------------------------------------------------------ */

/**
 * `P_KillMobj(source, target)` — shared body, PLAYER branch complete
 * (monster pain/death STATE selection is inert for the generic path:
 * non-player targets run the same flag/health bookkeeping, count
 * `killNonPlayer`, and the death-state tables arrive fully with
 * M7-07/M8; the item-drop switch below IS verbatim). Source order kept
 * INCLUDING the `tics -= P_Random()&3` clamp AFTER the deathstate set.
 */
export function pKillMobjPlayer(source: Mobj | null, target: Mobj): void {
  const rt = target.rt;
  const tp = target.playerRef as Player | undefined;
  if (tp) pplayerHookCounts.killPlayer++;
  else pplayerHookCounts.killNonPlayer++;

  target.flags = (target.flags & ~(MF.MF_SHOOTABLE | MF.MF_FLOAT | MF.MF_SKULLFLY)) | 0;
  if (target.type !== MT.MT_SKULL) target.flags = (target.flags & ~MF.MF_NOGRAVITY) | 0;
  target.flags = (target.flags | MF.MF_CORPSE | MF.MF_DROPOFF) | 0;
  target.height = (target.height >> 2) | 0;

  const sp = source ? (source.playerRef as Player | undefined) : undefined;

  if (sp) {
    // count for intermission
    if (target.flags & MF.MF_COUNTKILL) sp.killcount = (sp.killcount + 1) | 0;
    if (tp) {
      const victimIdx = rt.state.players.indexOf(tp);
      if (victimIdx >= 0) sp.frags[victimIdx] = (sp.frags[victimIdx]! + 1) | 0;
    }
  } else if (!rt.netgame && (target.flags & MF.MF_COUNTKILL) !== 0) {
    // count all monster deaths, even those caused by other monsters
    rt.state.players[0]!.killcount = (rt.state.players[0]!.killcount + 1) | 0;
  }

  if (tp) {
    // count environment kills against you
    if (!source) {
      const selfIdx = rt.state.players.indexOf(tp);
      if (selfIdx >= 0) tp.frags[selfIdx] = (tp.frags[selfIdx]! + 1) | 0;
    }
    target.flags = (target.flags & ~MF.MF_SOLID) | 0;
    tp.playerstate = PST_DEAD;
    // P_DropWeapon (p_inter.c — M7-04's file): the death-drop table with
    // MF_DROPPED items. Counted hook until then (D-t2).
    pplayerHookCounts.dropWeapon++;
    // AM_Stop: `automapactive` has no state in this port yet (M9) —
    // pplayerHookCounts.amStop will count when it exists.
  }

  // DIE vs X DIE: health < -spawnhealth AND an xdeathstate exists.
  const info = mobjinfo[target.type]!;
  if (target.health < -info.spawnHealth && info.xdeathState !== S.S_NULL) {
    pSetMobjState(target, info.xdeathState);
  } else {
    pSetMobjState(target, info.deathState);
  }
  target.tics = (target.tics - (pRandom(rt.state.rng) & 3)) | 0;
  if (target.tics < 1) target.tics = 1;

  //	Drop stuff. — the death frame's item spawn (verbatim switch;
  // players hit `default: return` — no player weapon drop here, that is
  // P_DropWeapon's, M7-04).
  let item = -1;
  switch (target.type) {
    case MT.MT_WOLFSS:
    case MT.MT_POSSESSED:
      item = MT.MT_CLIP;
      break;
    case MT.MT_SHOTGUY:
      item = MT.MT_SHOTGUN;
      break;
    case MT.MT_CHAINGUY:
      item = MT.MT_CHAINGUN;
      break;
    default:
      return;
  }
  const mo = pSpawnMobj(rt, target.x, target.y, ONFLOORZ, item);
  mo.flags = (mo.flags | MF.MF_DROPPED) | 0; // special versions of items
}

/** Scripted player death (acceptance: "scripted death via direct
 * P_KillMobj"). */
export function pKillPlayer(p: Player, source: Mobj | null = null): void {
  const m = asMobj(p.mo);
  if (!m) throw new Error('pKillPlayer: player has no real mobj (M7-03 spawn required)');
  pKillMobjPlayer(source, m);
}

/* ------------------------------------------------------------------ */
/* P_DamageMobj — p_inter.c:775-947, player-reachable half               */
/* ------------------------------------------------------------------ */

/**
 * `P_DamageMobj(target, inflictor, source, damage)` restricted to what
 * this port's Player slice supports — M7-04's p_inter.ts will host the
 * full entry point and route player targets here (armor and I_Tactile
 * have no fields/sink yet, D-t2). Order verbatim: SHOOTABLE/health
 * guards, sk_baby halving, the close-combat thrust kick (fall-forwards
 * variant included), the sector-11 hell hack, the GOD/INVUL gate, the
 * health mirror `player->health -= damage` (player.health EXISTS —
 * plan §4's health-field check resolved: the decrement lives HERE),
 * attacker/damagecount, `target->health -= damage` -> P_KillMobj, the
 * pain-chance draw, reactiontime=0 and the generic retarget (vanilla
 * runs it for player mobjs too).
 */
export function pPlayerDamage(
  target: Mobj,
  inflictor: Mobj | null,
  source: Mobj | null,
  damage: number
): void {
  const rt = target.rt;
  const rng = rt.state.rng;
  if ((target.flags & MF.MF_SHOOTABLE) === 0) return; // shouldn't happen...
  if (target.health <= 0) return;

  if (target.flags & MF.MF_SKULLFLY) {
    target.momx = target.momy = target.momz = 0;
  }

  const player = target.playerRef as Player | undefined;
  if (!player) throw new Error('pPlayerDamage: target is not a player mobj (M7-07 owns monsters)');
  const pp = attachPsprFields(player);
  if (rt.state.skill === 0 /* sk_baby */) damage = (damage >> 1) | 0;

  // Some close combat weapons should not inflict thrust...
  if (
    inflictor &&
    (target.flags & MF.MF_NOCLIP) === 0 &&
    (!source ||
      !source.playerRef ||
      (source.playerRef as PsprPlayer).readyweapon !== WP_CHAINSAW)
  ) {
    let ang = pointToAngleOrigin((target.x - inflictor.x) | 0, (target.y - inflictor.y) | 0);
    // C: `damage*(FRACUNIT>>3)*100/target->info->mass` (32-bit wrap kept)
    let thrust = Math.trunc((damage * (FRACUNIT >> 3) * 100) / mobjinfo[target.type]!.mass) | 0;
    // make fall forwards sometimes
    if (
      damage < 40 &&
      damage > target.health &&
      target.z - inflictor.z > 64 * FRACUNIT &&
      (pRandom(rng) & 1) !== 0
    ) {
      ang = (ang + ANG180) >>> 0;
      thrust = (thrust * 4) | 0;
    }
    const fine = ang >>> ANGLETOFINESHIFT;
    target.momx = (target.momx + FixedMul(thrust, finecosine[fine]!)) | 0;
    target.momy = (target.momy + FixedMul(thrust, finesine[fine]!)) | 0;
  }

  // player specific
  {
    // end of game hell hack (LIVE sector special, M6-04 authority)
    const sec = sectorAtPoint(rt.state.map, target.x, target.y);
    const special = rt.state.sectors.special[sec] ?? rt.state.map.sectors.special[sec]!;
    if (special === 11 && damage >= player.health) damage = (player.health - 1) | 0;

    // Below certain threshold, ignore damage in GOD mode or INVUL.
    if (damage < 1000 && ((player.cheats & CF_GODMODE) !== 0 || pp.powers[PW_INVULNERABILITY]!)) {
      return;
    }

    // (armor: armortype/armorpoints arrive with M7-04 pickups — the
    //  saved = damage/3|/2 block is inert until then, D-t2.)

    player.health = (player.health - damage) | 0; // mirror mobj health for Dave
    if (player.health < 0) player.health = 0;

    player.attacker = source as MoveMobj | null;
    player.damagecount = (player.damagecount + damage) | 0; // after armor/invuln
    if (player.damagecount > 100) player.damagecount = 100; // teleport stomp does 10k

    // I_Tactile(40, 10, 40+min(damage,100)*2): no haptics sink (M10).
  }

  // do the damage
  target.health = (target.health - damage) | 0;
  if (target.health <= 0) {
    pKillMobjPlayer(source, target);
    return;
  }

  if (pRandom(rng) < mobjinfo[target.type]!.painChance && (target.flags & MF.MF_SKULLFLY) === 0) {
    target.flags = (target.flags | MF.MF_JUSTHIT) | 0; // fight back!
    pplayerHookCounts.painStates++;
    if (!pSetMobjState(target, mobjinfo[target.type]!.painState)) return;
  }

  target.reactionTime = 0; // we're awake now...

  if (
    (target.threshold === 0 || target.type === MT.MT_VILE) &&
    source &&
    source !== target &&
    source.type !== MT.MT_VILE
  ) {
    // if not intent on another player, chase after this one
    target.target = source;
    target.threshold = BASETHRESHOLD;
    if (
      target.state === mobjinfo[target.type]!.spawnState &&
      mobjinfo[target.type]!.seeState !== S.S_NULL
    ) {
      pSetMobjState(target, mobjinfo[target.type]!.seeState);
    }
  }
}

/** Scripted pain entry (acceptance: pain gating matrix without M7-04's
 * full P_DamageMobj): null inflictor == environmental (slime-style: no
 * thrust, no retarget), null source == no attacker turn. */
export function pHurtPlayer(
  p: Player,
  damage: number,
  source: Mobj | null = null,
  inflictor: Mobj | null = null
): void {
  const m = asMobj(p.mo);
  if (!m) throw new Error('pHurtPlayer: player has no real mobj (M7-03 spawn required)');
  pPlayerDamage(m, inflictor, source, damage);
}

/* ------------------------------------------------------------------ */
/* Player-side A_* fills (S_PLAY_* action column, info.c:285-309)        */
/* ------------------------------------------------------------------ */

/** A_Pain — p_enemy.c: `if (actor->info->painsound) S_StartSound` (the
 * MT_PLAYER painsound is sfx_plpain). Body is generic: M7-07 monsters
 * reuse it through the same registration. */
function aPain(ctx: unknown): void {
  const mo = ctx as Mobj;
  const token = mobjinfo[mo.type]?.painSound;
  if (token) playSound(mo, token);
}

/** A_PlayerScream — p_enemy.c: sfx_pldeth, or sfx_pdiehi in COMMERCIAL
 * mode when the player dies below -50 WITHOUT gibbing. */
function aPlayerScream(ctx: unknown): void {
  const mo = ctx as Mobj;
  let token = 'sfx_pldeth';
  if (psprGlobals.gamemode === 2 /* commercial */ && mo.health < -50) {
    token = 'sfx_pdiehi';
  }
  playSound(mo, token);
}

/** A_Fall — p_enemy.c: `actor->flags &= ~MF_SOLID` — the ONLY effect
 * ("So change this if corpse objects are meant to be obstacles."). */
function aFall(ctx: unknown): void {
  const mo = ctx as Mobj;
  mo.flags = (mo.flags & ~MF.MF_SOLID) | 0;
}

/** A_XScream — p_enemy.c: S_StartSound(actor, sfx_slop). */
function aXScream(ctx: unknown): void {
  playSound(ctx as Mobj, 'sfx_slop');
}

registerAction(ACT.A_Pain, aPain);
registerAction(ACT.A_PlayerScream, aPlayerScream);
registerAction(ACT.A_Fall, aFall);
registerAction(ACT.A_XScream, aXScream);

/* The p_pspr seams p_mobj/pplayer own (p_pspr.ts registration map):
 * P_SetPsprite's S_PLAY_ATK1/2 writes and A_WeaponReady's attack-state
 * compares run through the real mobj (M7-03). */
psprHooks.setMobjState = (p, statenum) => {
  const m = asMobj(p.mo);
  if (m) pSetMobjState(m, statenum);
};
psprHooks.moStateIs = (p, statenum) => {
  const m = asMobj(p.mo);
  return m !== undefined && m.state === statenum;
};
