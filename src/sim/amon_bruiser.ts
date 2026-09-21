// sim/amon_bruiser.ts — M8-09 Family C: Cacodemon / Baron of Hell / Boss
// death (linuxdoom-1.10 p_enemy.c, mirror verified against the released
// 62-.c tree this pass — raw.githubusercontent id-Software/DOOM
// linuxdoom-1.10, line numbers below; docs/design/M8-plan.md §M8-09 is the
// task scope, authoritative).
//
// NAMES ARE SOURCE TRUTH (the dispatch brief's shorthand corrected against
// p_enemy.c/info.h — cites required):
//   * "A_CacDemoAttack" / "MT_CACBALL" DO NOT EXIST in 1.10. The
//     cacodemon's action is A_HeadAttack (p_enemy.c:950, action id 55) and
//     its missile is MT_HEADSHOT (info.c mobjinfo row: damage 5,
//     speed 10*FRACUNIT) — the ONLY projectile the caco fires (:966).
//   * "A_BaronAttack" does not exist: the baron/hell-knight action is
//     A_BruisAttack (p_enemy.c:979, action id 56; the "Bruiser" spelling
//     is verbatim source) firing MT_BRUISERSHOT (:995, speed 15*FRACUNIT,
//     info.c damage 8).
//   * A_HeadAttack (caco) does NOT "face" in the melee line and the BARON
//     has NO A_FaceTarget call at all (:983-986 goes target-check →
//     P_CheckMeleeRange directly) — the facing lives in the state rows:
//     S_BOSS_ATK1/S_BOSS_ATK2 (537/538) + S_KNIGHT_ATK1/2 (566/567) carry
//     A_FaceTarget (id 31) and A_BruisAttack sits on ATK3 (539/568). The
//     caco rows 504/505 likewise face; A_HeadAttack itself is at 506.
//   * MELEE FORMULAS verbatim: caco `damage = (P_Random()%6+1)*10` 10..60
//     (:960, ONE draw, no sound — the caco melee is SILENT); baron
//     `S_StartSound(actor, sfx_claw)` (:988) +
//     `(P_Random()%8+1)*10` = 10..80 (:989). (The A_TroopAttack claw roll
//     is the SAME sfx id — the family-A module already cites it.)
//   * MISSILE DAMAGE = "on touch" truth: the flying rows (S_HTITM/S_MBAL?
//     — states 102-105 HEADSHOT, 522-525 BRUISERSHOT) carry NO action
//     (stateAction census: those rows are 0; A_Explode id 24 lives ONLY on
//     the MT_FIRE/BFG-splat rows 127/811). Touch damage is the
//     PIT_CheckThing MF_MISSILE direct hit `(P_Random()%8+1) *
//     info->damage` (p_map.c:325-328) — ALREADY LIVE as M7-09's
//     pmapHooks.missileHit (pmissiles.ts). So: caco ball 5*(1..8), baron
//     ball 8*(1..8), NO splash from the explosion states ("splash" in the
//     brief = this direct-hit dice, the only damage a 1.10 caco/baron
//     missile does). The same-species skip including the MT_KNIGHT↔
//     MT_BRUISER alias is live too (pmissiles.ts missileThingCheck,
//     p_map.c:301-315) — no alias work needed here.
//   * FLOATING: there is NO A_Float and NO FLOATBOB in 1.10 — verified
//     this pass by grep of the fetched p_enemy.c, p_mobj.c AND p_local.h
//     (zero hits). Float hover/landing is the P_ZMovement
//     `MF_FLOAT && mo->target` target-band (p_mobj.c:259-276) — ALREADY
//     LIVE in pmove.ts:341 (M8-02 consumes it); nothing to add here. The
//     MT_HEAD flags (research 06 §: MF_FLOAT|MF_NOGRAVITY) ride it.
//   * A_CyberAttack (id 63) — the brief's "cyber double rocket?" question:
//     p_enemy.c:969-976 fires a SINGLE MT_ROCKET per call; NOT family-C
//     scope (no MT_CYBORG in E1, plan §0.12) — pinned here as a cite only.
//
// A_BossDeath — p_enemy.c:1609-1756 VERBATIM STRUCTURE (the gate switch
// fetched from the mirror THIS pass, line-exact):
//   if (gamemode == commercial) { gamemap!=7 → return; type!=FATSO &&
//     type!=BABY → return }                                    (:1616-1624)
//   else switch(gameepisode): case 1: map!=8→return, type!=MT_BRUISER→
//     return (:1629-1635 — THE E1 RULE: E1M8's boss is the BARON); case 2:
//     8 + MT_CYBORG; case 3: 8 + MT_SPIDER; case 4: {6: CYBORG, 8: SPIDER};
//   default: gamemap!=8 → return.                              (:1627-1677)
//   then: ≥1 living player (:1683-1688); thinker scan — ANY other same-
//   `type` mobj with health>0 → return (:1692-1705; the port's thinker
//   list is rt.mobjs — every level mobj in spawn order, removed=true for
//   freed ones ≡ the `acp1 != P_MobjThinker` filter + Z_Free); victory:
//   commercial 7 → FATSO: junk.tag=666 EV_DoFloor lowerFloorToLowest
//   (:1712-1717) / BABY: junk.tag=667 EV_DoFloor raiseToTexture
//   (:1719-1724); else switch: case 1 → tag 666 lowerFloorToLowest
//   (:1731-1735 — THE E1M8 EXIT RULE); case 4 {6 → tag 666 EV_DoDoor
//   blazeOpen, 8 → tag 666 lowerFloorToLowest}; fall-out → G_ExitLevel()
//   (:1755 — E2/E5 and the switch's missing cases end the level).
//   NOTE: no special-11/51/13 "ET_StartSpecial" dispatch and no
//   "exDeadtall" exist in THIS file — that machinery is later-source; the
//   brief's "special 11?" question resolves: 1.10 calls the executor
//   directly (and episode 1 is lowerFloorToLowest, NOT an exit special).
//
// SEAMS (M6 machinery, "call how" per the brief):
//   * E1 exit rule floor: M6's evDoFloor (pfloor.ts:295) is LINE-INDEXED
//     (pFindSectorFromLineTag reads s.map.lines.tag[line]); vanilla calls
//     it with a JUNK line whose only live field is tag=666 — the sector
//     scan is purely by SECTOR tag (pspec-helpers.ts:233 scans
//     s.sectors.tag). So this module carries evDoFloorByTag: the same
//     mover loop (pAddThinker + tMoveFloor + specialdata refuse) with the
//     tag taken from the junk line. LowerFloorToLowest + raiseToTexture
//     are the two cases the victory switch can name; both implemented
//     (case-faithful). The call is ALSO recorded in bossSpecialCalls() so
//     the M9 exit-integration and the acceptance test assert the dispatch,
//     not just the floor move.
//   * G_ExitLevel: the live M6-12 seam gExitLevel (pexit.ts, exitSlot →
//     state.exitRequest latch, D013(e)) — M9 drains it.
//   * EV_DoDoor (E4M6 blazeOpen, gameepisode 4): Phase 1 (E1 shareware)
//     NEVER resolves episode 4 — recorded in bossSpecialCalls() with a
//     M9+/M12 note instead of duplicating the door mover (pdoors'
//     evDoDoor is line-indexed like pfloor's; a junk-line door replica is
//     handed to whoever first resolves a doom64 episode).
//   * doomstat: the port has no gameepisode/gamemap globals yet (M9's
//     g_game wiring). resolveBossLevel parses the MAP NAME (E1M8 →
//     episode 1 map 8; non-conforming fixture names → null → the whole
//     action is a recorded no-op) and setBossLevelProbe overrides for
//     tests/M9. commercial is always false in Phase 1 (Doom 1); the
//     probe seam lets a test exercise the MAP7/FATSO/BABY branch anyway.
//
// PRNG ledger (random-sites.ts, same commit): 'amon_bruiser.ts': 2 text
// occurrences (HeadAttack %6 roll, BruisAttack %8 roll). A_BossDeath draws
// NOTHING (pinned by the gate test's stream-identity assert).
// SFX ledger (psound_stub SFX_SITE_LEDGER, same commit):
// 'amon_bruiser.ts': 1 (A_BruisAttack melee sfx_claw, p_enemy.c:988).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { MT } from '../wad/info/mobjinfo';
import { ACT, registerAction } from './a_actions';
import { sfxSlot } from './hooks';
import type { Mobj } from './p_mobj';
import { aFaceTarget, pCheckMeleeRange } from './p_enemy';
import { pPlayerDamage } from './pplayer';
import { pSpawnMissile } from './pmissiles';
import { pRandom } from './prng';
import { SFX_ID } from './psound_stub';
import type { GameState } from './state';

import { gExitLevel } from './pexit';
import { tMoveFloor, textureHeights, type FloorMove, type FloorState } from './pfloor';
import { pFindLowestFloorSurrounding, sectorLineAt, twoSided, type SpecWorld } from './pspec-helpers';
import { makePlaneContext, DIR_DOWN, DIR_UP, type PlaneContext, type PlaneHost } from './pplane';
import { pAddThinker, sectorSpecialData, setSectorSpecialData, type ThinkerFn } from './ptick';
import { FLOOR, VL } from './specials-table';

/* ------------------------------------------------------------------ */
/* A_HeadAttack — p_enemy.c:950-967 (action id 55)                      */
/* ------------------------------------------------------------------ */

/**
 * `A_HeadAttack(actor)` verbatim: bail without a target; face (the SHADOW
 * jitter draws belong to p_enemy.ts's A_FaceTarget ledger); in melee range
 * the SILENT (P_Random()%6+1)*10 = 10..60 hit (:960-961 — no S_StartSound
 * exists in this body), else P_SpawnMissile(MT_HEADSHOT) (:966).
 */
export function aHeadAttack(actor: Mobj): void {
  if (!actor.target) return; // :954-955

  aFaceTarget(actor); // :957

  if (pCheckMeleeRange(actor)) {
    // :958-963
    const damage = (((pRandom(actor.rt.state.rng) % 6) + 1) * 10) | 0; // :960 — 10..60
    pPlayerDamage(actor.target, actor, actor, damage); // :961 P_DamageMobj
    return; // :962
  }

  // launch a missile — MT_HEADSHOT (p_enemy.c:966; MT_CACBALL never existed)
  pSpawnMissile(actor.rt, actor, actor.target, MT.MT_HEADSHOT);
}

/* ------------------------------------------------------------------ */
/* A_BruisAttack — p_enemy.c:979-996 (action id 56)                     */
/* (MT_BRUISER baron AND MT_KNIGHT hell knight — info.c meleestate ==    */
/* missilestate == ATK1 for both, states 537/539 + 566/568)              */
/* ------------------------------------------------------------------ */

/**
 * `A_BruisAttack(actor)` verbatim: NO A_FaceTarget (the ATK1/ATK2 rows
 * face — see the header; this body must NOT change the angle); in melee
 * range sfx_claw + the (P_Random()%8+1)*10 = 10..80 slam, else
 * P_SpawnMissile(MT_BRUISERSHOT).
 */
export function aBruisAttack(actor: Mobj): void {
  if (!actor.target) return; // :983-984

  if (pCheckMeleeRange(actor)) {
    // :986-992
    const rt = actor.rt;
    sfxSlot(rt.state.hooks, SFX_ID.sfx_claw, actor.x, actor.y, actor.z, rt.state.leveltime); // :988
    const damage = (((pRandom(rt.state.rng) % 8) + 1) * 10) | 0; // :989 — 10..80
    pPlayerDamage(actor.target, actor, actor, damage); // :990 P_DamageMobj
    return; // :991
  }

  // launch a missile — MT_BRUISERSHOT (p_enemy.c:995)
  pSpawnMissile(actor.rt, actor, actor.target, MT.MT_BRUISERSHOT);
}

/* ------------------------------------------------------------------ */
/* A_BossDeath — p_enemy.c:1609-1756 (action id 50)                      */
/* ------------------------------------------------------------------ */

/** The doomstat slice A_BossDeath reads (vanilla `gamemode ==
 *  commercial`, `gameepisode`, `gamemap`; g_game.c sets them at
 *  G_InitNew — M9 owns that wiring). */
export interface BossLevel {
  /** `gamemode == commercial` — always false in Phase 1 (Doom 1). */
  readonly commercial: boolean;
  readonly episode: number; // 1..6 (1.10 supports the doom64 packs' 4-6)
  readonly map: number; // gamemap
}

export type BossLevelProbe = (s: GameState) => BossLevel | null;

/** Default probe: E1M8-style map names (the port's level identity until
 *  M9's g_game globals land). null ⇒ unresolved (recorded no-op). */
export const defaultBossLevelProbe: BossLevelProbe = (s) => {
  const m = /^E(\d)M(\d+)$/i.exec(s.map.name);
  if (!m) return null;
  return { commercial: false, episode: Number(m[1]), map: Number(m[2]) };
};

let probe: BossLevelProbe = defaultBossLevelProbe;

/** Install/replace (null ⇒ restore the default) the doomstat probe. */
export function setBossLevelProbe(p: BossLevelProbe | null): void {
  probe = p ?? defaultBossLevelProbe;
}

/* ---------------- victory recorder (M9 seam evidence) -------------- */

/** One victory-action dispatch (tagged special or the level exit). */
export interface BossSpecialCall {
  readonly kind: 'floor' | 'door' | 'exit';
  /** junk.tag (666/667); 0 for the exit. */
  readonly tag: number;
  /** FLOOR.* / VL.* constant (floor/door kinds). */
  readonly actionType: number;
  /** The mover/floor machinery actually ran (false = record-only seam:
   *  the E4M6 door case, unreachable while the probe says episode ≠ 4). */
  readonly executed: boolean;
  readonly tic: number;
}

const bossCalls: BossSpecialCall[] = [];

export function bossSpecialCalls(): readonly BossSpecialCall[] {
  return bossCalls;
}

export function resetBossSpecialCalls(): void {
  bossCalls.length = 0;
}

/* ---------------- EV_DoFloor with a JUNK TAG (vanilla call shape) --- */

/**
 * `EV_DoFloor(&junkline, type)` with `junkline.tag = tag` — the mover
 * loop of pfloor.ts:295 with the sector scan reading sector tags
 * directly (vanilla P_FindSectorFromLineTag scans SECTORS by `line->tag`
 * — pspec-helpers.ts:233 — and the boss junk line contributes ONLY the
 * tag; no linedef carries 666 by necessity). Mover lifecycle is byte-
 * identical: specialdata refuse, pAddThinker + tMoveFloor, sector bind.
 * Only the two types the A_BossDeath victory switch can name are
 * implemented; anything else is an authoring bug (throws).
 */
export function evDoFloorByTag(s: SpecWorld, tag: number, type: number): boolean {
  if (type !== FLOOR.lowerFloorToLowest && type !== FLOOR.raiseToTexture) {
    throw new Error(`evDoFloorByTag: floor type ${type} is not a boss-victory case`);
  }
  const ctx: PlaneContext = makePlaneContext(s as unknown as PlaneHost);
  let secnum = -1;
  let rtn = 0;
  while ((secnum = pFindSectorFromTag(s, tag, secnum)) >= 0) {
    // ALREADY MOVING? IF SO, KEEP GOING... (p_floor.c verbatim)
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;

    rtn = 1;
    const fn: ThinkerFn = (self) => tMoveFloor(s, ctx, self as FloorMove);
    const thinker = pAddThinker(s.thinkers, fn);
    setSectorSpecialData(s.sectors, secnum, thinker);
    const f = Object.assign(thinker, {
      sector: secnum,
      type,
      crush: false,
      direction: 0,
      newspecial: 0,
      texture: '',
      dest: 0,
      speed: 0
    } as FloorState) as FloorMove;
    f.dest = s.sectors.floorZ[secnum]!;

    if (type === FLOOR.lowerFloorToLowest) {
      f.direction = DIR_DOWN;
      f.speed = FRACUNIT; // FLOORSPEED (pfloor.ts:121)
      f.dest = pFindLowestFloorSurrounding(s, secnum);
    } else {
      // raiseToTexture — pfloor.ts:401-427 copy (shortest bottomtexture;
      // textureHeights injectable table, '' = no bottom texture).
      let minsize = 0x7fffffff; // MAXINT
      for (let i = 0; i < s.map.sectors.lineCount[secnum]!; i++) {
        const ln = sectorLineAt(s.map, secnum, i);
        if (!twoSided(s.map, secnum, i)) continue;
        for (let side = 0; side < 2; side++) {
          const sideIdx = side === 0
            ? s.map.lines.sideNumFront[ln]!
            : s.map.lines.sideNumBack[ln]!;
          if (sideIdx < 0) continue;
          const tex = s.map.sides.bottomTexture[sideIdx]!;
          if (tex === '') continue;
          const h = textureHeights.get(tex);
          if (h === undefined) continue; // pfloorCounts.missingTextureHeight++
          if (h < minsize) minsize = h;
        }
      }
      f.direction = DIR_UP;
      f.speed = FRACUNIT;
      f.dest = (s.sectors.floorZ[secnum]! + minsize) | 0;
    }
  }
  return rtn === 1;
}

/** P_FindSectorFromLineTag's SECTOR scan half (pspec-helpers.ts:233-243)
 * with the junk line's tag as the direct argument. */
function pFindSectorFromTag(s: SpecWorld, tag: number, start: number): number {
  const tags = s.sectors.tag;
  for (let i = start + 1; i < s.sectors.count; i++) {
    if (tags[i] === tag) return i;
  }
  return -1;
}

/* ---------------- the body ---------------------------------------- */

/** `A_BossDeath(mo)` — the :1616-1756 body verbatim in structure (see the
 * header's switch map; every `return` and fall-through sits where the
 * source sits). */
export function aBossDeath(actor: Mobj): void {
  const rt = actor.rt;
  const s = rt.state;
  const lv = probe(s);
  if (lv === null) return; // PORT: doomstat unresolved (fixture map name)

  if (lv.commercial) {
    if (lv.map !== 7) return; // :1618-1619

    if (actor.type !== MT.MT_FATSO && actor.type !== MT.MT_BABY) return; // :1621-1623
  } else {
    switch (lv.episode) {
      case 1:
        if (lv.map !== 8) return; // :1630-1631
        if (actor.type !== MT.MT_BRUISER) return; // :1633-1634 — THE E1 RULE
        break;

      case 2:
        if (lv.map !== 8) return;
        if (actor.type !== MT.MT_CYBORG) return;
        break;

      case 3:
        if (lv.map !== 8) return;
        if (actor.type !== MT.MT_SPIDER) return;
        break;

      case 4:
        switch (lv.map) {
          case 6:
            if (actor.type !== MT.MT_CYBORG) return;
            break;
          case 8:
            if (actor.type !== MT.MT_SPIDER) return;
            break;
          default:
            return;
        }
        break;

      default:
        if (lv.map !== 8) return;
        break;
    }
  }

  // make sure there is a player alive for victory (:1682-1688)
  let alive = false;
  for (const p of s.players) {
    if (p.health > 0) {
      alive = true;
      break;
    }
  }
  if (!alive) return; // :1687-1688 "no one left alive, so do not end game"

  // scan the remaining thinkers to see if all bosses are dead
  // (:1690-1705 — rt.mobjs IS the thinker roster: every mobj this level,
  // spawn order; `removed` mobjs are Z_Freed ≡ off the thinker list, and
  // a corpse mobj still on the list fails health>0 exactly like mo2)
  for (const mo2 of rt.mobjs) {
    if (mo2 === actor || mo2.removed) continue;
    if (mo2.type === actor.type && mo2.health > 0) {
      return; // :1702-1703 other boss not dead
    }
  }

  // victory! (:1707-1755)
  if (lv.commercial) {
    if (lv.map === 7) {
      if (actor.type === MT.MT_FATSO) {
        bossCalls.push({ kind: 'floor', tag: 666, actionType: FLOOR.lowerFloorToLowest, executed: evDoFloorByTag(s, 666, FLOOR.lowerFloorToLowest), tic: s.leveltime }); // :1712-1717
        return;
      }
      if (actor.type === MT.MT_BABY) {
        bossCalls.push({ kind: 'floor', tag: 667, actionType: FLOOR.raiseToTexture, executed: evDoFloorByTag(s, 667, FLOOR.raiseToTexture), tic: s.leveltime }); // :1719-1724
        return;
      }
    }
  } else {
    switch (lv.episode) {
      case 1:
        // THE E1M8 EXIT RULE: junk.tag=666; EV_DoFloor lowerFloorToLowest
        // (:1731-1735) — NOT a level-exit special (the "special 11?"
        // question in the brief is later-source; 1.10 moves the floor).
        bossCalls.push({ kind: 'floor', tag: 666, actionType: FLOOR.lowerFloorToLowest, executed: evDoFloorByTag(s, 666, FLOOR.lowerFloorToLowest), tic: s.leveltime });
        return;

      case 4:
        switch (lv.map) {
          case 6:
            // junk.tag=666; EV_DoDoor(&junk, blazeOpen) (:1740-1744).
            // Phase 1 never resolves episode 4; pdoors' EV_DoDoor is
            // line-indexed like pfloor's — junk-line door replica handed
            // to the doom64-episode task (M9+ note). RECORD-ONLY.
            bossCalls.push({ kind: 'door', tag: 666, actionType: VL.blazeOpen, executed: false, tic: s.leveltime });
            return;

          case 8:
            bossCalls.push({ kind: 'floor', tag: 666, actionType: FLOOR.lowerFloorToLowest, executed: evDoFloorByTag(s, 666, FLOOR.lowerFloorToLowest), tic: s.leveltime }); // :1746-1750
            return;
        }
        break;
    }
  }

  // G_ExitLevel() (:1755) — E2M8/E5M8 and every fall-out lands the level
  // through the live M6-12 seam (state.exitRequest latch, D013(e); M9
  // drains it into the real level change).
  bossCalls.push({ kind: 'exit', tag: 0, actionType: 0, executed: true, tic: s.leveltime });
  gExitLevel(s);
}

/* ------------------------------------------------------------------ */
/* Registration (amon_poss idiom — import registers the three ids under  */
/* the MOBJ domain; game.ts's enable stays the e2e task's live wiring).   */
/* ------------------------------------------------------------------ */

export function registerFamilyCActions(): void {
  registerAction(ACT.A_HeadAttack, (ctx) => aHeadAttack(ctx as Mobj), 'mobj'); // id 55
  registerAction(ACT.A_BruisAttack, (ctx) => aBruisAttack(ctx as Mobj), 'mobj'); // id 56
  registerAction(ACT.A_BossDeath, (ctx) => aBossDeath(ctx as Mobj), 'mobj'); // id 50
}

registerFamilyCActions();
