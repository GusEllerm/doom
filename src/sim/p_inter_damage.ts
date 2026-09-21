// sim/p_inter_damage.ts — M8-05: the p_inter.c P_DamageMobj / P_KillMobj
// bodies for NON-PLAYER targets, plus the damageBridge that turns the seven
// hooks.damageSlot call sites into live damage (M8-plan §M8-05/§0.8).
//
// Sources (verbatim targets, 62-file mirror):
//   p_inter.c P_DamageMobj (:775-947) — SHOOTABLE/health guards, the
//     MF_SKULLFLY momentum zero, sk_baby halving (player-only, mirrored in
//     pplayer.ts), the close-combat thrust kick (:826-857, incl. the
//     fall-forwards `P_Random()&1` variant :841-846), `health -= damage` ->
//     P_KillMobj, the painChance roll (:894, 1 draw ALWAYS taken on a
//     non-fatal hit) + MF_JUSTHIT + painstate, reactiontime = 0, and the
//     retarget/infighting rule (:911: BASETHRESHOLD 100, VILE exemption,
//     source != target, spawnstate -> seestate).
//   p_inter.c P_KillMobj (:668-764) — corpse flag bookkeeping, the
//     MF_NOGRAVITY drop (non-SKULL), the killcount bookkeeping (player
//     source + the `!netgame` monster-on-monster fallback), the gib rule
//     (`health < -spawnhealth && xdeathstate`, :721), the
//     `tics -= P_Random()&3` clamp (:725), and the drop table (:730-756)
//     spawning the MF_DROPPED item. THE drop table lives HERE (single
//     source): pplayer.ts's player-target kill keeps its own branch and
//     hits the same `default: return` (players drop nothing in
//     P_KillMobj — that is P_DropWeapon's, still a counted seam).
//   p_local.h:61 BASETHRESHOLD 100.
//
// The bridge (M8-02's `hooks.bridge` wiring): damageSlot records into the
// `hooks.damage` L2 log FIRST (ledger EXACTLY unchanged — zero call-site
// edits) and then dispatches (target, amount, source) with the slots
// already resolved through the resolver p_mobj.createMobjRuntime registers.
// `installDamageBridge(hooks)` attaches this module's body; pplayer.ts's
// bindPplayerLevel calls it on every level boot (gInitGame), so the seven
// sites go live with the map.
//
// Deviations (documented, pinned by p_inter_damage.test.ts):
//  D-m1: PLAYER targets stay record-only at the bridge. The seven sites'
//        player damage (crushers, hazard floors, telefrag, the pspec
//        finale) keeps the pre-M8-05 L2-log-only semantics: wiring the
//        pplayer player half into the bridge would move every M6 specials
//        /mechanics golden in one commit (the plan gate says goldens stay
//        UNMOVED — the player-site activation is a follow-up task with its
//        own re-bless). pPlayerDamage/pKillPlayer stay the live player
//        entries for direct/scripted use, unchanged.
//  D-m2: the bridge signature (M8-02, hooks.ts — frozen) carries no
//        inflictor. Resolution per site: hitscan/telefrag/BFG-spray
//        (inflictor == source, exact), crushers/hazard floors/BFG-spark
//        (source null -> no thrust, exact), missile direct hits (vanilla
//        inflictor = the missile — approximated by the source shooter:
//        same kick axis along the flight line, z from the shooter), and
//        P_RadiusAttack (vanilla inflictor NULL -> this port kicks AWAY
//        from the source; the only site with a direction the source
//        cannot reconstruct exactly — pinned in the test). The
//        fall-forwards `&1` DRAW gate therefore keys on `source.z` at
//        missile/radius sites (draw ORDER unchanged: still only when the
//        earlier &&s pass).
//  D-m3: death-state action BODIES (A_Scream/A_XScream/A_Fall) are M8-06
//        (unmerged at authoring): the state ENTRY here is verbatim
//        P_SetMobjState; the action rows dispatch through the counted
//        a_actions stub recorder (tests assert STATE transitions + stub
//        counts, flip-proof when M8-06 lands; A_Pain already lives in
//        pplayer.ts).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG180, ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';

import { mobjinfo, MF, MT } from '../wad/info/mobjinfo';
import { S } from '../wad/info/states';

import { registerDamageBridge, type HookSlots, type MobjRef } from './hooks';
import { pSetMobjState, pSpawnMobj, type Mobj } from './p_mobj';
import { allocThingSlot, thingUnsetPosition } from './thinglinks';
import { ONFLOORZ } from './player';
import { pRandom } from './prng';
import { pointToAngleOrigin } from './pslide';
import { WP_CHAINSAW, type PsprPlayer } from './p_pspr';

/** p_local.h:61 `#define BASETHRESHOLD 100` (pplayer.ts mirrors; the
 * retarget rule below is the only writer). */
export const BASETHRESHOLD = 100;

/* ------------------------------------------------------------------ */
/* P_KillMobj — p_inter.c:668-764, non-player target                    */
/* ------------------------------------------------------------------ */

/**
 * `P_KillMobj(source, target)` for a NON-player target, order verbatim:
 * corpse flags (SHOOTABLE/FLOAT/SKULLFLY off, NOGRAVITY off unless
 * MT_SKULL, CORPSE|DROPOFF on, `height >>= 2`), the killcount bookkeeping
 * (player source -> `source->player->killcount++` for MF_COUNTKILL; the
 * `!netgame` fallback credits players[0] for monster-on-monster and
 * environmental deaths — pplayer.ts:443's rule, now on the shared path),
 * the DIE/XDIE selection (`health < -spawnhealth && xdeathstate`), the
 * `tics -= P_Random()&3; if < 1 -> 1` clamp (ONE draw, always), and the
 * drop table (:730) spawning the item with MF_DROPPED at ONFLOORZ.
 * The player-target branch stays in pplayer.ts (pKillMobjPlayer routes
 * non-player targets here).
 */
export function pKillMobj(source: Mobj | null, target: Mobj): void {
  const rt = target.rt;

  target.flags = (target.flags & ~(MF.MF_SHOOTABLE | MF.MF_FLOAT | MF.MF_SKULLFLY)) | 0;
  if (target.type !== MT.MT_SKULL) target.flags = (target.flags & ~MF.MF_NOGRAVITY) | 0;
  target.flags = (target.flags | MF.MF_CORPSE | MF.MF_DROPOFF) | 0;
  target.height = (target.height >> 2) | 0;

  const sp = source ? (source.playerRef as { killcount: number } | undefined) : undefined;
  if (sp) {
    // count for intermission (frags need a player victim — none here)
    if (target.flags & MF.MF_COUNTKILL) sp.killcount = (sp.killcount + 1) | 0;
  } else if (!rt.netgame && (target.flags & MF.MF_COUNTKILL) !== 0) {
    // count all monster deaths, even those caused by other monsters
    rt.state.players[0]!.killcount = (rt.state.players[0]!.killcount + 1) | 0;
  }

  // DIE vs X DIE (:721) + the tics clamp (:725) — ONE draw, always.
  pSetDeathStateClamped(target);

  // Drop stuff (:730-756) — the death frame's item spawn, verbatim.
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

/**
 * The gib-rule state selection + the `tics -= P_Random()&3` clamp
 * (p_inter.c:721-727). Shared by pKillMobj above and pplayer.ts's PLAYER
 * branch (single source of the draw; the random-sites ledger counts it
 * HERE, not in pplayer.ts anymore).
 */
export function pSetDeathStateClamped(target: Mobj): void {
  const info = mobjinfo[target.type]!;
  if (target.health < -info.spawnHealth && info.xdeathState !== S.S_NULL) {
    pSetMobjState(target, info.xdeathState);
  } else {
    pSetMobjState(target, info.deathState);
  }
  target.tics = (target.tics - (pRandom(target.rt.state.rng) & 3)) | 0;
  if (target.tics < 1) target.tics = 1;
}

/* ------------------------------------------------------------------ */
/* P_DamageMobj — p_inter.c:775-947, non-player target                  */
/* ------------------------------------------------------------------ */

/**
 * `P_DamageMobj(target, inflictor, source, damage)` for a NON-player
 * target, verbatim order (the player-specific block :861-905 has no
 * part here — D-m1): guards, MF_SKULLFLY momentum zero, thrust kick
 * (:826-857, chainsaw source exempt, MF_NOCLIP exempt, the fall-forwards
 * draw gated by the earlier &&s — draw order matters), `health -=
 * damage` -> P_KillMobj + return, the painChance roll (:894 — the draw
 * is taken EVEN when MF_SKULLFLY suppresses the pain state),
 * reactiontime = 0 and the retarget/infighting rule (:911).
 * `inflictor === undefined` resolves to the source position (D-m2).
 */
export function pDamageMobj(
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

  // (sk_baby halving is player-only — p_mobj.c target->player check; the
  // player half lives in pplayer.ts pPlayerDamage.)

  // Some close combat weapons should not inflict thrust and push the
  // victim out of reach, thus kick away unless using the chainsaw.
  if (
    inflictor &&
    (target.flags & MF.MF_NOCLIP) === 0 &&
    (!source ||
      !source.playerRef ||
      (source.playerRef as PsprPlayer).readyweapon !== WP_CHAINSAW)
  ) {
    let ang = pointToAngleOrigin((target.x - inflictor.x) | 0, (target.y - inflictor.y) | 0);
    // C: `damage*(FRACUNIT>>3)*100/target->info->mass` (trunc toward 0)
    let thrust = Math.trunc((damage * (FRACUNIT >> 3) * 100) / mobjinfo[target.type]!.mass) | 0;

    // make fall forwards sometimes — the draw fires ONLY when the three
    // earlier &&s pass (P_Random ORDER, :841-846).
    if (
      damage < 40 &&
      damage > target.health &&
      target.z - inflictor.z > 64 * FRACUNIT &&
      (pRandom(rng) & 1) !== 0
    ) {
      ang = (ang + ANG180) >>> 0;
      thrust = (thrust * 4) | 0;
    }

    // PORT BRIDGE (M8-04's `promoteMoverSlot`, p_enemy.ts:289, same rule):
    // a load-time THINGS spawn lives in a STATIC grid slot and
    // `thingSetPosition` refuses to reposition it (thinglinks.ts:397).
    // Vanilla has one thing list, so a kicked monster simply slides; the
    // port must promote it to a dynamic mover slot BEFORE the kick lands,
    // otherwise the victim's next P_XYMovement (pmove.ts:247 ->
    // pmap.ts:530) throws. Damage thrust is the ONLY momentum source a
    // never-chased monster/barrel can acquire in this port (no
    // P_PushMobs exists in 1.10 — p_map.c has no push routine at all), so
    // this single site covers the whole class. Promotion moves no hashed
    // bytes and takes no PRNG draw (draw order above/below is untouched).
    promoteMoverSlot(target);

    const fine = ang >>> ANGLETOFINESHIFT;
    target.momx = (target.momx + FixedMul(thrust, finecosine[fine]!)) | 0;
    target.momy = (target.momy + FixedMul(thrust, finesine[fine]!)) | 0;
  }

  // (player-specific block: D-m1 / pplayer.ts.)

  // do the damage
  target.health = (target.health - damage) | 0;
  if (target.health <= 0) {
    pKillMobj(source, target);
    return;
  }

  if (pRandom(rng) < mobjinfo[target.type]!.painChance && (target.flags & MF.MF_SKULLFLY) === 0) {
    target.flags = (target.flags | MF.MF_JUSTHIT) | 0; // fight back!
    pSetMobjState(target, mobjinfo[target.type]!.painState);
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
    const info = mobjinfo[target.type]!;
    if (target.state === info.spawnState && info.seeState !== S.S_NULL) {
      pSetMobjState(target, info.seeState);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Port bridge: static THINGS slot -> dynamic mover slot                */
/* ------------------------------------------------------------------ */

/**
 * Slot promotion, identical control flow to `p_enemy.ts`'s chase-side
 * bridge (p_enemy.ts:289, whose thinglinks.ts header note it implements):
 * unlink from the static CSR membership, clear the old pair, allocate a
 * dynamic slot, carry the doomednum/z over, and rebind `slotMobjs` so the
 * damageBridge resolver, PIT hooks and telefrag still resolve the victim.
 * Idempotent — a mover is returned untouched. Consolidation follow-up:
 * the helper belongs in `p_mobj.ts` (it owns `slotMobjs`); until then the
 * two copies are pinned identical by p_inter_damage.test.ts.
 */
function promoteMoverSlot(m: Mobj): void {
  const links = m.rt.state.pmap.links;
  if (m.linkSlot >= links.staticCount) return;
  const old = m.linkSlot;
  thingUnsetPosition(links, old);
  links.flags[old] = 0;
  const s = allocThingSlot(links, m.radius, m.height, m.flags);
  links.doomednum[s] = links.doomednum[old]!;
  links.z[s] = m.z;
  m.linkSlot = s;
  m.rt.slotMobjs.delete(old);
  m.rt.slotMobjs.set(s, m);
}

/* ------------------------------------------------------------------ */
/* The damageBridge (M8-02 wiring -> M8-05 body)                        */
/* ------------------------------------------------------------------ */

/**
 * The registered body: `MobjRef` -> Mobj (every resolver hit IS an Mobj —
 * p_mobj.ts's resolver reads rt.slotMobjs), PLAYER targets skipped to the
 * record-only semantics (D-m1), everything else into the shared body with
 * the source doubling as the inflictor (D-m2 — the signature is frozen
 * by M8-02; null source -> null inflictor -> no thrust, exact for
 * crushers/hazard floors).
 */
export const damageBridgeBody = (
  target: MobjRef,
  amount: number,
  source: MobjRef | undefined,
  _tic: number
): void => {
  const t = target as Mobj;
  if (t.playerRef !== undefined) return; // D-m1: player sites stay record-only
  const src = source as Mobj | undefined;
  pDamageMobj(t, src ?? null, src ?? null, amount);
};

/**
 * Attach the body to a level's hook slots (idempotent; registerDamageBridge
 * is a plain field write and resetHookSlots never clears the bridge).
 * bindPplayerLevel calls this on every gInitGame, so all seven damageSlot
 * sites dispatch here as soon as the map boots. `null` un-registers.
 */
export function installDamageBridge(hooks: HookSlots, fn: typeof damageBridgeBody | null = damageBridgeBody): void {
  registerDamageBridge(hooks, fn);
}
