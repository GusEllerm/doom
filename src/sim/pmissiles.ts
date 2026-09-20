// sim/pmissiles.ts — projectile spawns + the missile collision seams
// (linuxdoom-1.10 p_mobj.c "P_CheckMissileSpawn / P_SpawnMissile /
// P_SpawnPlayerMissile", p_mobj.c:103 deathsound seam, and the
// PIT_CheckThing MF_MISSILE branches' mobj-side bodies; M7-plan §M7-09,
// R07 §9.1/§9.4, R08 §3.6). MIRROR (62-.c check): p_mobj.c bodies quoted
// below are verbatim from the mirror tree; the plan's "20*FRACUNIT spawn
// offset?" question resolves: 1.10 has NO xy offset at all — both spawn
// sites place the missile at the SOURCE x/y, z + 4*8*FRACUNIT.
//
// WHAT LIVES HERE (plan §M7-09 "projectile spawn code (p_mobj extension)"):
//  - pCheckMissileSpawn / pSpawnMissile / pSpawnPlayerMissile — movement
//    itself is NOT duplicated: the spawned Mobj ticks through the existing
//    P_MobjThinker → pmove P_XYMovement/P_ZMovement MF_MISSILE branches
//    (M5-05-tested; blocked XY → sky hack / P_ExplodeMissile, floor/ceiling
//    z clip → P_ExplodeMissile — verified wiring, registerPmoveAdapters);
//  - the psprHooks.spawnPlayerMissile FILL for A_FireMissile/A_FirePlasma/
//    A_FireBFG (p_pspr.ts:913-936 call sites, MT ids already pinned there);
//  - the pmapHooks.missileThingCheck / missileHit bodies (p_map.c:291-330:
//    over/under + species rules + `(P_Random()%8+1)*info->damage` direct
//    hit → damageSlot — the p_inter P_DamageMobj convention pinned by
//    p_shoot.ts: `thing` = TARGET's ThingLinks slot id, `source` = the
//    vanilla P_DamageMobj `source` arg (tmthing->target = the shooter's
//    slot id); the inflictor half (tmthing itself) is not representable
//    in the M6-01 slot shape — same documented gap as M7-08 hitscan).
//  - mobjHooks.startSound body: p_mobj.c:103 deathsound + the two
//    `S_StartSound(th, th->info->seesound)` spawn sites emit through the
//    shared hooks.sfx slot (ids from psound_stub's sfxenum table).
//
// ROCKET-JUMP MYTH CHECK (1.10): A_FireRocket (p_pspr.c A_FireMissile) has
// NO recoil/mom write at all (mirror-checked: ammo −−, spawn, done), and
// P_ExplodeMissile damages nothing by itself (splash runs from the
// S_EXPLODE1 death-state A_Explode → P_RadiusAttack, which has NO source
// exclusion — the shooter takes splash normally when in LOS ≤ 128 units).
// "Rockets never hit their shooter" is the PIT_CheckThing same-species
// `thing == tmthing->target` SKIP only (implemented in missileThingCheck
// below); self-SPLASH is real 1.10 behavior (see random-sites.md).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { mobjinfo, MF, MT } from '../wad/info/mobjinfo';

import { damageSlot, sfxSlot } from './hooks';
import {
  asMobj,
  mobjHooks,
  pExplodeMissile,
  pSpawnMobj,
  type Mobj,
  type MobjRuntime,
} from './p_mobj';
import { pmapHooks, pTryMove, type Mover } from './pmap';
import { pAproxDistance } from './pmaputl';
import { psprHookCounts, registerPsprHook, type PsprPlayer } from './p_pspr';
import { linetarget, pAimLineAttack, rPointToAngle2 } from './p_shoot';
import { pRandom } from './prng';
import { resolveSfxId } from './psound_stub';
import type { MoveMobj } from './pmove';

/* ------------------------------------------------------------------ */
/* P_CheckMissileSpawn — p_mobj.c:863-880 verbatim                      */
/* ------------------------------------------------------------------ */

/**
 * `P_CheckMissileSpawn(th)`: `tics −= P_Random()&3` (min 1 — the draw
 * ALWAYS happens), the `mom>>1` prestep (arithmetic shift, C `>>`), and
 * `P_TryMove(th, th->x, th->y)` — blocked ⇒ `P_ExplodeMissile` right
 * there (the pre-explosion thing-hits run inside that pTryMove: the
 * direct-hit damage of a missile spawned INTO a thing is vanilla).
 */
export function pCheckMissileSpawn(th: Mobj): void {
  const rng = th.rt.state.rng;
  th.tics = (th.tics - (pRandom(rng) & 3)) | 0;
  if (th.tics < 1) th.tics = 1;

  // move a little forward so an angle can be computed if it immediately
  // explodes (p_mobj.c:872-874 — `+=` of the >>1 momentum halves)
  th.x = (th.x + (th.momx >> 1)) | 0;
  th.y = (th.y + (th.momy >> 1)) | 0;
  th.z = (th.z + (th.momz >> 1)) | 0;

  if (!pTryMove(th.rt.state.pmap, th, th.x, th.y)) pExplodeMissile(th);
}

/* ------------------------------------------------------------------ */
/* P_SpawnMissile — p_mobj.c:889-925 verbatim                           */
/* ------------------------------------------------------------------ */

/**
 * `P_SpawnMissile(source, dest, type)` — monster/dest-aim variant (M8
 * callers; live here so the missile family is complete). z = source->z +
 * 32*FRACUNIT; angle = R_PointToAngle2 with the `MF_SHADOW` "fuzzy player"
 * jitter `(P_Random()-P_Random())<<20` (2 EXTRA draws, shadow targets
 * only); momz = (dest.z − source.z)/dist with the C int-division
 * truncation (Math.trunc, toward zero).
 */
export function pSpawnMissile(rt: MobjRuntime, source: Mobj, dest: Mobj, type: number): Mobj {
  const rng = rt.state.rng;
  const info = mobjinfo[type]!;

  const th = pSpawnMobj(rt, source.x, source.y, (source.z + 4 * 8 * FRACUNIT) | 0, type);
  if (info.seeSound && info.seeSound !== 'sfx_None' && info.seeSound !== '0') {
    // p_mobj.c:899 S_StartSound(th, seesound)
    sfxSlot(rt.state.hooks, resolveSfxId(info.seeSound), th.x, th.y, th.z, rt.state.leveltime);
  }

  th.target = source; // where it came from
  let an = rPointToAngle2(source.x, source.y, dest.x, dest.y);

  // fuzzy player
  if ((dest.flags & MF.MF_SHADOW) !== 0) {
    an = (an + (((pRandom(rng) - pRandom(rng)) << 20) | 0)) >>> 0;
  }

  th.angle = an;
  const fine = an >>> ANGLETOFINESHIFT;
  th.momx = FixedMul(info.speed, finecosine[fine]!);
  th.momy = FixedMul(info.speed, finesine[fine]!);

  let dist = pAproxDistance((dest.x - source.x) | 0, (dest.y - source.y) | 0);
  dist = Math.trunc(dist / info.speed); // C fixed_t/int, toward zero
  if (dist < 1) dist = 1;
  th.momz = Math.trunc(((dest.z - source.z) | 0) / dist) | 0;

  pCheckMissileSpawn(th);
  return th;
}

/* ------------------------------------------------------------------ */
/* P_SpawnPlayerMissile — p_mobj.c:935-980 verbatim                     */
/* ------------------------------------------------------------------ */

/** `16*64*FRACUNIT` — the P_SpawnPlayerMissile autoaim probe range
 * (p_mobj.c:949; NOT MISSILERANGE — probes short, then flies with momz
 * from the probed slope: `momz = FixedMul(speed, slope)`). */
const MISSILE_AIM_RANGE = 16 * 64 * FRACUNIT;

/**
 * `P_SpawnPlayerMissile(source, type)` — the player launcher/plasma/BFG
 * spawn: 3-probe autoaim (an, an+1<<26, an−2<<26 from probe 2, fallback
 * an = source angle + slope 0), NO xy offset (mirror-verified: 1.10 spawns
 * at source x/y), z + 32*FRACUNIT, momz from the aim slope. Probe COUNT
 * is exact (1, 2 or 3 P_AimLineAttack calls).
 */
export function pSpawnPlayerMissile(rt: MobjRuntime, source: Mobj, type: number): void {
  let an = source.angle >>> 0;
  let slope = pAimLineAttack(source, an, MISSILE_AIM_RANGE);

  if (!linetarget.active) {
    an = (an + (1 << 26)) >>> 0;
    slope = pAimLineAttack(source, an, MISSILE_AIM_RANGE);
    if (!linetarget.active) {
      an = (an - (2 << 26)) >>> 0;
      slope = pAimLineAttack(source, an, MISSILE_AIM_RANGE);
    }
    if (!linetarget.active) {
      an = source.angle >>> 0;
      slope = 0;
    }
  }

  const info = mobjinfo[type]!;
  const x = source.x;
  const y = source.y;
  const z = (source.z + 4 * 8 * FRACUNIT) | 0;

  const th = pSpawnMobj(rt, x, y, z, type);
  if (info.seeSound && info.seeSound !== 'sfx_None' && info.seeSound !== '0') {
    // p_mobj.c:966 S_StartSound(th, seesound) — rocket sfx_rlaunc (14),
    // plasma sfx_plasma (8), BFG '0' = none (never emitted).
    sfxSlot(rt.state.hooks, resolveSfxId(info.seeSound), th.x, th.y, th.z, rt.state.leveltime);
  }

  th.target = source;
  th.angle = an;
  const fine = an >>> ANGLETOFINESHIFT;
  th.momx = FixedMul(info.speed, finecosine[fine]!);
  th.momy = FixedMul(info.speed, finesine[fine]!);
  th.momz = FixedMul(info.speed, slope);

  pCheckMissileSpawn(th);
}

/* ------------------------------------------------------------------ */
/* PIT_CheckThing MF_MISSILE branch bodies (p_map.c:291-330)            */
/* ------------------------------------------------------------------ */

/** ThingLinks slot → live Mobj (removed ones read as "no mobj"). */
function slotMobj(rt: MobjRuntime, slot: number): Mobj | undefined {
  const m = rt.slotMobjs.get(slot);
  return m && !m.removed ? m : undefined;
}

/** p_map.c:301-315 — same-species rule (the MT_KNIGHT↔MT_BRUISER
 * cross-check is in the 1.10 source verbatim; info.h enum indices 17/15). */
function missileThingCheck(slot: number, missile: Mover): 'pass' | 'skip' | 'explode' {
  const mo = asMobj(missile as unknown as MoveMobj);
  if (!mo || mo.removed) return 'pass';
  const target = mo.target;
  if (!target || target.removed) return 'pass';
  const thing = slotMobj(mo.rt, slot);
  if (!thing) return 'pass';

  if (
    target.type === thing.type ||
    (target.type === MT.MT_KNIGHT && thing.type === MT.MT_BRUISER) ||
    (target.type === MT.MT_BRUISER && thing.type === MT.MT_KNIGHT)
  ) {
    // Don't hit same species as originator.
    if (thing === target) return 'skip'; // return true
    if (thing.type !== MT.MT_PLAYER) return 'explode'; // Explode, no damage
  }
  return 'pass';
}

/** p_map.c:325-328 — direct hit: `damage = ((P_Random()%8)+1) *
 * tmthing->info->damage` (ONE draw, always) then
 * P_DamageMobj(thing, tmthing, tmthing->target, damage). The missile's own
 * explode follows from the blocked move in P_XYMovement — NOT here. */
function missileHit(slot: number, missile: Mover): void {
  const mo = asMobj(missile as unknown as MoveMobj);
  if (!mo || mo.removed) return;
  const st = mo.rt.state;
  const damage = (((pRandom(st.rng) % 8) + 1) * mobjinfo[mo.type]!.damage) | 0;

  const src = mo.target && !mo.target.removed && mo.target.linkSlot >= 0
    ? mo.target.linkSlot
    : null;
  damageSlot(st.hooks, slot, damage, src, st.leveltime);
}

/* ------------------------------------------------------------------ */
/* Hook registration (self-registering module load — pslide idiom)      */
/* ------------------------------------------------------------------ */

/** Install the M7-09 slots (idempotent; re-callable after resetPsprHooks
 * / resetPmapHooks the way registerShootPsprHooks is). The spawnPlayer-
 * Missile body resolves the runtime FROM the player's real mobj (M7-03),
 * so no level-bind is needed; a MobjStub player (pre-M7-03 fixtures)
 * counts and no-ops. */
export function registerMissileHooks(): void {
  registerPsprHook('spawnPlayerMissile', (p: PsprPlayer, missileType: number) => {
    psprHookCounts.spawnPlayerMissile++;
    const mo = asMobj(p.mo as unknown as MoveMobj);
    if (!mo) return; // stub mover — counted no-op
    pSpawnPlayerMissile(mo.rt, mo, missileType);
  });

  // p_mobj.c:103 deathsound (P_ExplodeMissile) → hooks.sfx with the mobj
  // origin coords. Token '0'/'sfx_None' never reaches here (call-site
  // guard = vanilla's `if (mo->info->deathsound)`).
  mobjHooks.startSound = (m: Mobj, token: string, tic: number) => {
    sfxSlot(m.rt.state.hooks, resolveSfxId(token), m.x, m.y, m.z, tic);
  };

  pmapHooks.missileThingCheck = missileThingCheck;
  pmapHooks.missileHit = missileHit;
}

registerMissileHooks();
