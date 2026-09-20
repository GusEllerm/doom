// sim/p_enemy.ts — M8-04 AI core: the monster brain (linuxdoom-1.10
// p_enemy.c, sha fea20b31a98061abe6dae84ed11116daff7fbd51, 2008 lines;
// mirror verified 62 .c files, M8-plan §0.0).
//
// SCOPE (M8-plan §M8-04 + §0.2–0.5), VERBATIM with line cites:
//   P_RecursiveSound   p_enemy.c:106   (sector sound flood; P_GroupLines
//                          ascending sec->lines order = M6-§0.4 rule)
//   P_NoiseAlert       p_enemy.c:159   (SINGLE call site in the tree:
//                          p_pspr.c:256 P_FireWeapon → wired here through
//                          psprHooks.noiseAlert, §0.3 — the "monsters dying
//                          alert" reading is FALSE in 1.10: no other sites)
//   P_CheckMeleeRange  p_enemy.c:174   (per-victim info->radius; burns a
//                          P_CheckSight trace — §0.6)
//   P_CheckMissileRange p_enemy.c:197  (sight FIRST — no LOS ⇒ no draw;
//                          MF_JUSTHIT ⇒ clear + true; ONE draw `dist` dice)
//   P_Move             p_enemy.c:272   (+ xspeed/yspeed LUT :264)
//   P_TryWalk          p_enemy.c:349   (movecount = P_Random()&15 on success)
//   P_NewChaseDir      p_enemy.c:363   (opposite[] :70, diags[] :77; the
//                          swap test draws ALWAYS; search-direction draw :448)
//   P_LookForPlayers   p_enemy.c:499   (lastlook ring, c++==2 bail, 180°
//                          gate w/ MELEERANGE override; `sector` local DEAD)
//   A_Look             p_enemy.c:604   (threshold=0 every tic; soundtarget
//                          MF_SHOOTABLE + MF_AMBUSH sight-only; posit%3 /
//                          bgsit%2 seesound draws; SPID/CYB full volume)
//   A_Chase            p_enemy.c:672   (10-step order §0.4; MF_JUSTATTACKED
//                          = 0x80; movecount missile gate; activesound <3)
//   A_FaceTarget       p_enemy.c:782   (clears MF_AMBUSH; SHADOW target ⇒
//                          2 draws (P_Random()-P_Random())<<21)
//
// Pinned reading notes (source arbiter, mirror §0.0):
//  - `actor->info->speed` is a RAW int in 1.10 info.c (8/10/12/15/16) while
//    xspeed[] is fixed ⇒ `speed*xspeed` is a raw int product (8×47000 =
//    376000 for a diagonal = 0.716·speed·FRACUNIT). Math.imul mirrors the
//    int32 product; it is NOT FixedMul (§0.5 "pin the exact expression").
//  - fastparm: no d_main parameter source exists in this port (single-
//    player) ⇒ constant false at both A_Chase gates (documented deviation).
//  - netgame: rt.netgame (false pre-M9) for the `nomissile:` retarget.
//  - MF_JUSTHIT is read/cleared ONLY by P_CheckMissileRange (§0.4 note);
//    the damage side that SETS it belongs to M8-05 — this file never
//    consumes hooks.damageBridge beyond reading flags/health it leaves.
//  - P_NoiseAlert body: plan §0.13 assigns the psprHooks.noiseAlert BODY to
//    "M8-05", but the body IS the p_enemy.c:159 function this task owns —
//    it is wired HERE (deviation note per brief); M8-05 keeps only the
//    damageBridge + p_kill side.
//  - Monster door-opening: P_Move walks tm.spechit DESCENDING on a failed
//    move calling pUseSpecialLine(actor, ld, 0); the ML_BLOCKMONSTERS /
//    monsterUseOk gates are already inside pspec.ts (M6-03) — wired here.
//
// PRNG ledger (random-sites.ts, same commits): TryWalk 1, NewChaseDir swap
// 1 + search 1, A_Look seesound 2, A_Chase activesound 1, A_FaceTarget
// shadow 2, P_CheckMissileRange 1 → 9 `pRandom(` occurrences.
// SFX ledger (psound_stub SFX_SITE_LEDGER): A_Look 2 (full-volume NULL +
// origin), A_Chase attacksound 1 + activesound 1 → 4 `sfxSlot(`.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG270, ANG90, FRACUNIT } from '../core/constants';
import { mobjinfo, MT } from '../wad/info/mobjinfo';
import { DI_NODIR, MELEERANGE, pSetMobjFlags, type Mobj } from './p_mobj';
import { pRandom } from './prng';
import { bumpValidcount, opening, pAproxDistance, pLineOpening } from './pmaputl';
import { pCheckSight, setSectorSoundTarget, SOUND_TARGET_NONE } from './psight';
import { MF_FLOAT, MF_INFLOAT, MF_JUSTHIT, MF_SHOOTABLE } from './thinglinks';
import { MAXSPECIALCROSS, tm } from './pmap';
import { pUseSpecialLine } from './pspec';
import { ML_TWOSIDED, sectorLineAt } from './pspec-helpers';

/** doomdata.h ML_SOUNDBLOCK = 0x002 (no sim-side export exists; matches
 * the mapBuilder fixture constant). */
const ML_SOUNDBLOCK = 0x002;
import { sectorAtPoint } from './bsp';
import type { MobjRuntime } from './p_mobj';
import { asMobj, pSetMobjState } from './p_mobj';
import { ACT, registerAction } from './a_actions';
import { psprHookCounts, registerPsprHook, type PsprPlayer } from './p_pspr';
import { sfxSlot } from './hooks';
import { resolveSfxId, SFX_ID } from './psound_stub';
import { rPointToAngle2 } from './p_shoot';
import { MF_AMBUSH, MF_JUSTATTACKED, MF_SHADOW } from './thinglinks';
import type { MoveMobj } from './pmove';
import type { Player } from './player';

/** p_local.h:30 FLOATSPEED (pmove.ts exports the same value). */
const FLOATSPEED = 4 * FRACUNIT;

/* ------------------------------------------------------------------ */
/* dirtype_t + the P_NewChaseDir LUTs (p_enemy.c:50-80)                  */
/* ------------------------------------------------------------------ */

/** p_enemy.c:45-56 dirtype_t (DI_NODIR=8 re-exported from p_mobj.ts). */
export const DI_EAST = 0;
export const DI_SOUTHEAST = 7; // loop bound DI_SOUTHEAST in the scan
export const NUMDIRS = 9;

/** p_enemy.c:66-69 `dirtype_t opposite[]` — index by olddir. */
const OPPOSITE: readonly number[] = [
  4, 5, 6, 7, 0, 1, 2, 3, DI_NODIR, // W, SW, S, SE, E, NE, N, NW, NODIR
];

/** p_enemy.c:77-80 `dirtype_t diags[]` = {NW, NE, SW, SE}. */
const DIAGS: readonly number[] = [3, 1, 5, 7];

/* ------------------------------------------------------------------ */
/* p_local.h distances (MELEERANGE re-exported from p_mobj.ts)           */
/* ------------------------------------------------------------------ */

/** p_local.h:61 BASETHRESHOLD — written by P_DamageMobj (M8-05); only the
 * A_Chase decay reads it here, so it is NOT drawn against: kept as a doc
 * constant. */
export const BASETHRESHOLD = 100;

/* ------------------------------------------------------------------ */
/* P_CheckMeleeRange — p_enemy.c:174-192                                */
/* ------------------------------------------------------------------ */

/**
 * `P_CheckMeleeRange(actor)` verbatim: `!target` ⇒ false; the range bound
 * is `MELEERANGE − 20*FRACUNIT + victim->info->radius` (per-victim radius,
 * §0.6); then P_CheckSight — a melee attempt burns a sight trace. No PRNG.
 */
export function pCheckMeleeRange(actor: Mobj): boolean {
  if (!actor.target) return false; // :178-180

  const pl = actor.target;
  const dist = pAproxDistance(pl.x - actor.x, pl.y - actor.y); // :183-184

  const bound = (MELEERANGE - 20 * FRACUNIT + mobjinfo[pl.type]!.radius) | 0; // :186
  if (dist >= bound) return false;

  return pCheckSight(actor.rt, actor, actor.target); // :189
}

/* ------------------------------------------------------------------ */
/* P_CheckMissileRange — p_enemy.c:197-260                              */
/* ------------------------------------------------------------------ */

/**
 * `P_CheckMissileRange(actor)` verbatim, INCLUDING the draw order that
 * couples the PRNG stream: no LOS ⇒ false with NO draw; MF_JUSTHIT ⇒
 * clear-the-flag + true (the target just hit us, fight back — §0.8);
 * reactiontime ⇒ false; the dist ladder (−64, −128 without a melee state,
 * `>>16` to map units, VILE/UNDEAD/CYBORG/SPIDER/SKULL tweaks, 200/160
 * clamps) then exactly ONE `P_Random() < dist` draw.
 *
 * The VILE/UNDEAD/CYBORG/SPIDER type tweaks ship transcribed-but-E1-dead
 * (§0.12: no such doomednums in E1M1–E1M9); MT_SKULL is live (E1M6/7).
 */
export function pCheckMissileRange(actor: Mobj): boolean {
  if (!pCheckSight(actor.rt, actor, actor.target!)) return false; // :201

  if (actor.flags & MF_JUSTHIT) {
    // :203-209 "the target just hit the enemy, so fight back!"
    pSetMobjFlags(actor, actor.flags & ~MF_JUSTHIT);
    return true;
  }

  if (actor.reactionTime) return false; // :211 do not attack yet

  // OPTIMIZE: get this from a global checksight (:214-218)
  let dist = (pAproxDistance(actor.x - actor.target!.x, actor.y - actor.target!.y) - 64 * FRACUNIT) | 0;

  if (!mobjinfo[actor.type]!.meleeState) dist = (dist - 128 * FRACUNIT) | 0; // :216 no melee ⇒ fire more

  dist = dist >> 16; // :218 now map units

  if (actor.type === MT.MT_VILE) {
    if (dist > 14 * 64) return false; // :221-225 too far away
  }

  if (actor.type === MT.MT_UNDEAD) {
    if (dist < 196) return false; // :228-231 close for fist attack
    dist = dist >> 1;
  }

  if (
    actor.type === MT.MT_CYBORG ||
    actor.type === MT.MT_SPIDER ||
    actor.type === MT.MT_SKULL
  ) {
    dist = dist >> 1; // :239-245
  }

  if (dist > 200) dist = 200; // :247-248

  if (actor.type === MT.MT_CYBORG && dist > 160) dist = 160; // :250-251

  if (pRandom(actor.rt.state.rng) < dist) return false; // :253 exactly ONE draw

  return true;
}

/* ------------------------------------------------------------------ */
/* P_Move — p_enemy.c:264-330 (+ the xspeed/yspeed LUT :264)            */
/* ------------------------------------------------------------------ */

/** p_enemy.c:264-265 — fixed LUT; DI index order E,NE,N,NW,W,SW,S,SE. */
const XSPEED: readonly number[] = [FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000, 0, 47000];
const YSPEED: readonly number[] = [0, 47000, FRACUNIT, 47000, 0, -47000, -FRACUNIT, -47000];

/**
 * `P_Move(actor)` verbatim. `tryx = x + info->speed*xspeed[movedir]` is a
 * RAW int product (info.c stores speed as a plain int, §0.5) — Math.imul
 * mirrors the int32 multiply exactly (8×65536 = 524288 straight; 8×47000
 * = 376000 diagonal). On a blocked move: MF_FLOAT + tm.floatok ⇒ z ±
 * FLOATSPEED + MF_INFLOAT + true ("adjust height"); else the spechit walk
 * (`while (numspechit--)`, DESCENDING, ends at −1 like C) calls
 * `P_UseSpecialLine(actor, ld, 0)` — monsters open doors by walking into
 * them, the monsterUseOk/ML_BLOCKMONSTERS gates live in pspec.ts.
 * On success: clear MF_INFLOAT and, for non-floaters, `z = floorz`.
 */
export function pMove(actor: Mobj): boolean {
  if (actor.movedir === DI_NODIR) return false; // :290-291

  // :293-294 `if ((unsigned)movedir >= 8) I_Error("Weird actor->movedir!")`
  // — port deviation: throw (same stop-the-run semantics as I_Error).
  if ((actor.movedir >>> 0) >= 8) {
    throw new Error('Weird actor->movedir!');
  }

  const info = mobjinfo[actor.type]!;
  const tryx = (actor.x + Math.imul(info.speed, XSPEED[actor.movedir]!)) | 0; // :296
  const tryy = (actor.y + Math.imul(info.speed, YSPEED[actor.movedir]!)) | 0;

  const tryOk = pTryMoveShim(actor, tryx, tryy); // :298

  if (!tryOk) {
    // open any specials (:301-309)
    if ((actor.flags & MF_FLOAT) !== 0 && tm.floatok) {
      if (actor.z < tm.tmfloorz) actor.z = (actor.z + FLOATSPEED) | 0; // :305-309
      else actor.z = (actor.z - FLOATSPEED) | 0;
      pSetMobjFlags(actor, actor.flags | MF_INFLOAT); // :310
      return true;
    }

    if (!tm.numspechit) return false; // :312-313

    actor.movedir = DI_NODIR; // :315
    let good = false;
    // `while (numspechit--) { ld = spechit[numspechit]; ... }` :316-323 —
    // post-decrement reads spechit[n-1..0]; slots past spechit[7] held
    // adjacent-garbage in vanilla (pmapHookCounts.spechitOverflow), skipped
    // here exactly like pTryMove's own walk. Loop end state: numspechit −1.
    for (let i = tm.numspechit - 1; i >= 0; i--) {
      if (i >= MAXSPECIALCROSS) continue;
      const ld = tm.spechit[i]!;
      if (pUseSpecialLine(actor.rt.state, actor, ld, 0)) good = true;
    }
    tm.numspechit = -1; // vanilla loop-exit state
    return good;
  } else {
    pSetMobjFlags(actor, actor.flags & ~MF_INFLOAT); // :327
  }

  if ((actor.flags & MF_FLOAT) === 0) actor.z = actor.floorz; // :331-332
  return true;
}

/** P_TryMove with this file's world (the mobj runtime's clipping world).
 *  Import-injected lazily to keep the module graph acyclic-free: pmap.ts
 *  does NOT import p_enemy, so the direct import is safe at module eval. */
import { pTryMove } from './pmap';
function pTryMoveShim(actor: Mobj, x: number, y: number): boolean {
  return pTryMove(actor.rt.state.pmap, actor, x, y);
}

/* ------------------------------------------------------------------ */
/* P_TryWalk — p_enemy.c:345-357                                        */
/* ------------------------------------------------------------------ */

/**
 * `P_TryWalk(actor)` verbatim: P_Move, and on success reload the zig-zag
 * timer `movecount = P_Random()&15` — ONE draw per SUCCESSFUL chase step
 * (§0.5 stream coupling).
 */
export function pTryWalk(actor: Mobj): boolean {
  if (!pMove(actor)) return false;
  actor.movecount = pRandom(actor.rt.state.rng) & 15; // :355
  return true;
}

/* ------------------------------------------------------------------ */
/* P_NewChaseDir — p_enemy.c:363-480                                    */
/* ------------------------------------------------------------------ */

/**
 * `P_NewChaseDir(actor)` verbatim — diagonal-first (diags[] indexed
 * `((deltay<0)<<1)+(deltax>0)`, skipping the turnaround), then the
 * d[1]/d[2] axis tries, olddir, the ±8-direction scan whose clockwise
 * choice is ONE `P_Random()&1` draw, and the turnaround last. The swap
 * test `P_Random() > 200 || abs(deltay)>abs(deltax)` draws ALWAYS — the
 * C `||` short-circuits on the LEFT operand, which is the draw itself
 * (§0.5 pin). `olddir === DI_NODIR` ⇒ opposite[8] === DI_NODIR ⇒ no
 * turnaround exclusion. Called with no target vanilla I_Errors; port
 * throws the equivalent.
 */
export function pNewChaseDir(actor: Mobj): void {
  if (!actor.target) throw new Error('P_NewChaseDir: called with no target'); // :375

  const olddir = actor.movedir;
  const turnaround = OPPOSITE[olddir]!; // :378-379

  const deltax = (actor.target.x - actor.x) | 0; // :381-382
  const deltay = (actor.target.y - actor.y) | 0;

  const d: number[] = [0, DI_NODIR, DI_NODIR];
  if (deltax > 10 * FRACUNIT) d[1] = 0; // DI_EAST :384-388
  else if (deltax < -10 * FRACUNIT) d[1] = 4; // DI_WEST
  // else DI_NODIR

  if (deltay < -10 * FRACUNIT) d[2] = 6; // DI_SOUTH :390-393
  else if (deltay > 10 * FRACUNIT) d[2] = 2; // DI_NORTH

  // try direct route :396-402
  if (d[1] !== DI_NODIR && d[2] !== DI_NODIR) {
    actor.movedir = DIAGS[((deltay < 0 ? 1 : 0) << 1) + (deltax > 0 ? 1 : 0)]!;
    if (actor.movedir !== turnaround && pTryWalk(actor)) return;
  }

  // try other directions :405-409 — the draw ALWAYS happens
  if (pRandom(actor.rt.state.rng) > 200 || abs32(deltay) > abs32(deltax)) {
    const tdir = d[1]!;
    d[1] = d[2]!;
    d[2] = tdir;
  }

  if (d[1] === turnaround) d[1] = DI_NODIR; // :411-412
  if (d[2] === turnaround) d[2] = DI_NODIR;

  if (d[1] !== DI_NODIR) {
    actor.movedir = d[1]!; // :415-421
    if (pTryWalk(actor)) return; // either moved forward or attacked
  }

  if (d[2] !== DI_NODIR) {
    actor.movedir = d[2]!; // :423-426
    if (pTryWalk(actor)) return;
  }

  // there is no direct path to the player, so pick another direction :430-435
  if (olddir !== DI_NODIR) {
    actor.movedir = olddir;
    if (pTryWalk(actor)) return;
  }

  // randomly determine direction of search :437-466
  if (pRandom(actor.rt.state.rng) & 1) {
    for (let tdir = 0; tdir <= 7; tdir++) {
      // DI_EAST .. DI_SOUTHEAST
      if (tdir === turnaround) continue;
      actor.movedir = tdir;
      if (pTryWalk(actor)) return;
    }
  } else {
    for (let tdir = 7; tdir !== -1; tdir--) {
      // DI_SOUTHEAST .. DI_EAST
      if (tdir === turnaround) continue;
      actor.movedir = tdir;
      if (pTryWalk(actor)) return;
    }
  }

  if (turnaround !== DI_NODIR) {
    actor.movedir = turnaround; // :468-471
    if (pTryWalk(actor)) return;
  }

  actor.movedir = DI_NODIR; // :473 can not move
}

/** C `abs()` on int32 (wraps at MININT, same reading as pmaputl). */
function abs32(v: number): number {
  return v === -0x80000000 ? v : v < 0 ? -v : v;
}

/* ------------------------------------------------------------------ */
/* P_RecursiveSound / P_NoiseAlert — p_enemy.c:106-169                  */
/* ------------------------------------------------------------------ */

/** p_enemy.c:102 `mobj_t* soundtarget;` — the file global, held as the
 * TARGET's ThingLinks slot (SOUND_TARGET_NONE = the vanilla NULL). */
let soundTargetSlot = SOUND_TARGET_NONE;

/**
 * `P_RecursiveSound(sec, soundblocks)` verbatim. The flood walks the
 * sector's P_GroupLines line list ASCENDING (M6-§0.4 tie rule, via the
 * pspec-helpers CSR view), skips non-ML_TWOSIDED lines, `P_LineOpening`
 * (LIVE heights — a closed door blocks), writes `sec->soundtarget` +
 * `soundtraversed = soundblocks+1` under the shared validcount stamp, and
 * recurses; an ML_SOUNDBLOCK line recurses ONCE with soundblocks=1 (a
 * blocked hop, not a wall) and never again at soundblocks ≥ 1 — the
 * `soundtraversed <= soundblocks+1` guard kills re-entry.
 */
function pRecursiveSound(rt: MobjRuntime, sec: number, soundblocks: number, stamp: number): void {
  const map = rt.state.map;
  const S = map.sectors;

  // wake up all monsters in this sector (:114-119)
  if (S.valid[sec] === stamp && S.soundTraversed[sec]! <= soundblocks + 1) return; // already flooded

  S.valid[sec] = stamp; // :121
  S.soundTraversed[sec] = soundblocks + 1;
  setSectorSoundTarget(map, sec, soundTargetSlot); // :123 → psight seam (M8-01)

  for (let i = 0; i < S.lineCount[sec]!; i++) {
    // :125-131
    const line = sectorLineAt(map, sec, i);
    if ((map.lines.flags[line]! & ML_TWOSIDED) === 0) continue;

    pLineOpening(map, line, rt.state.sectors); // :133
    if (opening.openrange <= 0) continue; // :135 closed door

    // :137-140 sides[sidenum[0]].sector == sec ? back : front — the port's
    // P_GroupLines-resolved sectorFront/sectorBack pair.
    const other =
      map.lines.sectorFront[line] === sec
        ? map.lines.sectorBack[line]!
        : map.lines.sectorFront[line]!;

    if ((map.lines.flags[line]! & ML_SOUNDBLOCK) !== 0) {
      if (soundblocks === 0) pRecursiveSound(rt, other, 1, stamp); // :142-146
    } else {
      pRecursiveSound(rt, other, soundblocks, stamp);
    }
  }
}

/**
 * `P_NoiseAlert(target, emmiter)` verbatim — the ONLY call site in the
 * whole 1.10 tree is p_pspr.c:256 (P_FireWeapon, both args player->mo,
 * §0.3), wired from here through psprHooks.noiseAlert (see registration).
 * Monsters dying/seeing do NOT noise-alert. No PRNG draws.
 */
export function pNoiseAlert(rt: MobjRuntime, target: Mobj, emmiter: Mobj): void {
  soundTargetSlot = target.linkSlot; // :164 `soundtarget = target;`
  const stamp = bumpValidcount(); // :165 validcount++ (shared pmaputl domain)
  pRecursiveSound(rt, sectorAtPoint(rt.state.map, emmiter.x, emmiter.y), 0, stamp); // :166
}

/* ------------------------------------------------------------------ */
/* P_LookForPlayers — p_enemy.c:499-560                                 */
/* ------------------------------------------------------------------ */

/**
 * `P_LookForPlayers(actor, allaround)` verbatim — the `lastlook` ring
 * seeded `P_Random()%MAXPLAYERS` at spawn (p_mobj.c:508, already live),
 * `stop = (lastlook-1)&3`, the `c++ == 2 || lastlook == stop` bail (at
 * most TWO live players examined per call, §0.2), the dead-player skip,
 * the sight gate, and (allaround=false) the 180° rear test
 * `an > ANG90 && an < ANG270` with the "react anyway if really close"
 * MELEERANGE override. The C for-loop's increment runs on EVERY continue
 * — mirrored explicitly. Vanilla's `sector` local is DEAD code (:505),
 * omitted. Single-player consequence (pinned by test): a live-but-
 * unseen player is looked at TWICE per call (the c++==2 wrap needs two
 * extra visits) — two REJECT/sight probes per failed A_Look.
 */
export function pLookForPlayers(actor: Mobj, allaround: boolean): boolean {
  const players = actor.rt.state.players;
  const stop = (actor.lastLook - 1) & 3; // :511-512
  let c = 0;

  for (;;) {
    const lk = actor.lastLook;
    // :515 `if (!playeringame[lastlook]) continue;` — the increment is the
    // for-init, so a dead slot advances and retries:
    if (lk >= players.length) {
      actor.lastLook = (lk + 1) & 3;
      continue;
    }

    if (c++ === 2 || lk === stop) return false; // :518-522 done looking

    const player: Player = players[lk]!;
    if (player.health <= 0) {
      actor.lastLook = (lk + 1) & 3;
      continue; // :527-528 dead
    }
    const pmo = asMobj(player.mo as unknown as MoveMobj);
    if (!pmo) {
      actor.lastLook = (lk + 1) & 3;
      continue; // deviation: stub mover (pre-M7-03 fixture) — unseeable
    }

    if (!pCheckSight(actor.rt, actor, pmo)) {
      actor.lastLook = (lk + 1) & 3;
      continue; // :531-532 out of sight
    }

    if (!allaround) {
      // :535-548 the 180° gate (unsigned BAM wrap on the subtraction)
      const an = (rPointToAngle2(actor.x, actor.y, pmo.x, pmo.y) - actor.angle) >>> 0;
      if (an > ANG90 && an < ANG270) {
        const dist = pAproxDistance((pmo.x - actor.x) | 0, (pmo.y - actor.y) | 0);
        if (dist > MELEERANGE) {
          actor.lastLook = (lk + 1) & 3;
          continue; // behind back (:544-547)
        }
      }
    }

    actor.target = pmo; // :551
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* A_Look — p_enemy.c:604-663 (action id 29)                            */
/* ------------------------------------------------------------------ */

/**
 * `A_Look(actor)` verbatim: `threshold = 0` UNCONDITIONALLY every tic
 * ("any shot will wake up"); the sector `soundtarget` (read via
 * sectorAtPoint — the port's subsector→sector stand-in) with MF_SHOOTABLE
 * arms `target = targ`, MF_AMBUSH adding a P_CheckSight gate that FALLS
 * THROUGH to P_LookForPlayers with the sound target still set (verbatim
 * goto semantics); then the seesound (posit +P_Random()%3, bgsit
 * +P_Random()%2, SPIDER/CYBORG full volume S_StartSound(NULL, …)) and
 * P_SetMobjState(seestate). No sound/transition when neither path hits.
 */
export function aLook(actor: Mobj): void {
  const rt = actor.rt;
  actor.threshold = 0; // :609 any shot will wake up

  const map = rt.state.map;
  const sec = sectorAtPoint(map, actor.x, actor.y);
  const targSlot = map.sectors.soundTarget[sec]!;
  let saw = false;

  if (targSlot !== SOUND_TARGET_NONE) {
    const targ = rt.slotMobjs.get(targSlot);
    if (targ && !targ.removed && (targ.flags & MF_SHOOTABLE) !== 0) {
      actor.target = targ; // :614
      if ((actor.flags & MF_AMBUSH) === 0) {
        saw = true; // :616-620 else-goto seeyou
      } else if (pCheckSight(rt, actor, targ)) {
        saw = true; // :617-619 ambush ⇒ sight-gated
      }
      // ambush-fail: falls through to P_LookForPlayers, target STAYS set
    }
  }

  if (!saw && !pLookForPlayers(actor, false)) return; // :624-625

  aSeeSound(actor); // :seeyou 628-658
  pSetMobjState(actor, mobjinfo[actor.type]!.seeState); // :660
}

/** A_Look's `seeyou:` sound block (p_enemy.c:628-658), shared verbatim —
 * the switch is over the CONSECUTIVE sounds.h ids (sfx_posit1..3,
 * sfx_bgsit1..2), so the +draw variants stay inside the id run. */
function aSeeSound(actor: Mobj): void {
  const token = mobjinfo[actor.type]!.seeSound;
  if (token === 'sfx_None' || token === '0') return; // :628 if (info->seesound)
  const h = actor.rt.state.hooks;
  const tic = actor.rt.state.leveltime;
  let sound = resolveSfxId(token);
  if (
    sound === SFX_ID.sfx_posit1 ||
    sound === SFX_ID.sfx_posit2 ||
    sound === SFX_ID.sfx_posit3
  ) {
    sound = (SFX_ID.sfx_posit1 + (pRandom(actor.rt.state.rng) % 3)) | 0; // :636-640
  } else if (sound === SFX_ID.sfx_bgsit1 || sound === SFX_ID.sfx_bgsit2) {
    sound = SFX_ID.sfx_bgsit1 + (pRandom(actor.rt.state.rng) % 2); // :642-645
  }
  if (actor.type === MT.MT_SPIDER || actor.type === MT.MT_CYBORG) {
    sfxSlot(h, sound, 0, 0, 0, tic); // :650-654 full volume (NULL origin)
  } else {
    sfxSlot(h, sound, actor.x, actor.y, actor.z, tic); // :656
  }
}

/* ------------------------------------------------------------------ */
/* A_Chase — p_enemy.c:672-779 (action id 30, 122 state rows)           */
/* ------------------------------------------------------------------ */

/**
 * `A_Chase(actor)` verbatim, the §0.4 ten-step order:
 *  (1) reactiontime-- ; (2) threshold decay (zeroed on no/dead target);
 *  (3) the 45°-quantised wobble turn toward movedir (`angle &= 7<<29`,
 *      ±ANG90/2 by the SIGNED delta — the u32 BAM wraps exactly like C);
 *  (4) no/unshootable target ⇒ P_LookForPlayers(allaround) else RETURN
 *      TO SPAWNSTATE; (5) MF_JUSTATTACKED clear + P_NewChaseDir (skipped
 *      on nightmare/fastparm) and return; (6) melee (attacksound +
 *      meleestate); (7) missile gated on `gameskill < sk_nightmare &&
 *      !fastparm && movecount` then P_CheckMissileRange ⇒ JUSTATTACKED;
 *  (8) nomissile: netgame-only no-threshold no-LOS retarget; (9) chase:
 *      `--movecount < 0 || !P_Move` ⇒ P_NewChaseDir; (10) activesound at
 *      P_Random() < 3. fastparm ≡ false (no d_main source, header note).
 */
export function aChase(actor: Mobj): void {
  const rt = actor.rt;

  if (actor.reactionTime) actor.reactionTime = (actor.reactionTime - 1) | 0; // :677-678

  // modify target threshold (:681-690)
  if (actor.threshold) {
    if (!actor.target || actor.target.health <= 0) actor.threshold = 0;
    else actor.threshold = (actor.threshold - 1) | 0;
  }

  // turn towards movement direction if not there yet (:693-702)
  if (actor.movedir < 8) {
    actor.angle = (actor.angle & 0xe0000000) >>> 0; // angle &= (7<<29)
    const delta = (actor.angle - ((actor.movedir << 29) >>> 0)) | 0; // signed
    if (delta > 0) actor.angle = (actor.angle - (ANG90 >>> 1)) >>> 0; // ±ANG90/2 = ANG45
    else if (delta < 0) actor.angle = (actor.angle + (ANG90 >>> 1)) >>> 0;
  }

  if (!actor.target || (actor.target.flags & MF_SHOOTABLE) === 0) {
    // look for a new target (:704-712)
    if (pLookForPlayers(actor, true)) return; // got a new target
    pSetMobjState(actor, mobjinfo[actor.type]!.spawnState); // lost target ⇒ stand still
    return;
  }

  // do not attack twice in a row (:715-721)
  if (actor.flags & MF_JUSTATTACKED) {
    pSetMobjFlags(actor, actor.flags & ~MF_JUSTATTACKED);
    if (rt.state.skill !== 4 /* sk_nightmare */ && !FASTPARM) pNewChaseDir(actor);
    return;
  }

  const info = mobjinfo[actor.type]!;

  // check for melee attack (:724-731)
  if (info.meleeState !== 0 && pCheckMeleeRange(actor)) {
    const atk = info.attackSound;
    if (atk !== 'sfx_None' && atk !== '0') {
      sfxSlot(rt.state.hooks, resolveSfxId(atk), actor.x, actor.y, actor.z, rt.state.leveltime);
    }
    pSetMobjState(actor, info.meleeState);
    return;
  }

  // check for missile attack (:734-749)
  if (info.missileState !== 0) {
    if (rt.state.skill < 4 && !FASTPARM && actor.movecount) {
      // goto nomissile
    } else if (pCheckMissileRange(actor)) {
      pSetMobjState(actor, info.missileState);
      pSetMobjFlags(actor, actor.flags | MF_JUSTATTACKED);
      return;
    }
  }

  // nomissile: possibly choose another target (:755-761) — netgame only
  if (
    rt.netgame &&
    actor.threshold === 0 &&
    !pCheckSight(rt, actor, actor.target)
  ) {
    if (pLookForPlayers(actor, true)) return; // got a new target
  }

  // chase towards player (:764-768)
  actor.movecount = (actor.movecount - 1) | 0;
  if (actor.movecount < 0 || !pMove(actor)) pNewChaseDir(actor);

  // make active sound (:771-774)
  const act = info.activeSound;
  if (act !== 'sfx_None' && act !== '0' && pRandom(rt.state.rng) < 3) {
    sfxSlot(rt.state.hooks, resolveSfxId(act), actor.x, actor.y, actor.z, rt.state.leveltime);
  }
}

/** d_fastparm stand-in: no parameter source exists in this port
 * (single-player, no demo/netcode params pre-M9) ⇒ false. */
const FASTPARM = false;

/* ------------------------------------------------------------------ */
/* A_FaceTarget — p_enemy.c:782-800 (action id 31)                      */
/* ------------------------------------------------------------------ */

/**
 * `A_FaceTarget(actor)` verbatim: bails with no target; clears MF_AMBUSH
 * (an ambusher that turns to face has committed); aims via
 * R_PointToAngle2; and when the TARGET is MF_SHADOW (spectre / invisible
 * player) adds the `(P_Random()-P_Random())<<21` jitter — TWO draws.
 */
export function aFaceTarget(actor: Mobj): void {
  if (!actor.target) return; // :784-785

  pSetMobjFlags(actor, actor.flags & ~MF_AMBUSH); // :787

  actor.angle =
    rPointToAngle2(actor.x, actor.y, actor.target.x, actor.target.y) >>> 0; // :789-792

  if (actor.target.flags & MF_SHADOW) {
    const r = actor.rt.state.rng;
    actor.angle = (actor.angle + (((pRandom(r) - pRandom(r)) << 21) | 0)) >>> 0; // :795-796
  }
}

/* ------------------------------------------------------------------ */
/* Registration (self-import idiom — this module's import registers the
/* three action ids + the p_pspr.c:256 noiseAlert body)                 */
/* ------------------------------------------------------------------ */

export function registerEnemyHooks(): void {
  registerAction(ACT.A_Look, (ctx) => aLook(ctx as Mobj));
  registerAction(ACT.A_Chase, (ctx) => aChase(ctx as Mobj));
  registerAction(ACT.A_FaceTarget, (ctx) => aFaceTarget(ctx as Mobj));

  // p_pspr.c:256 `P_NoiseAlert (player->mo, player->mo);` inside
  // P_FireWeapon — the tree's only call site (§0.3). The counter keeps
  // counting (existing golden/test readers) AND the body runs.
  registerPsprHook('noiseAlert', (p: PsprPlayer) => {
    psprHookCounts.noiseAlert++;
    const mo = asMobj(p.mo as unknown as MoveMobj);
    if (!mo) return; // stub mover — counted no-op (pmissiles precedent)
    pNoiseAlert(mo.rt, mo, mo);
  });
}

registerEnemyHooks();


