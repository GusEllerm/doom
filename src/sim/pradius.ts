// sim/pradius.ts — splash damage: P_RadiusAttack / PIT_RadiusAttack
// (linuxdoom-1.10 p_map.c "RADIUS ATTACK", p_map.c:1150-1245) plus the
// two state actions that reach it — A_Explode (p_enemy.c:1598) and
// A_BFGSpray (p_pspr.c:781) — and the LOS probe P_CheckSight needs
// (p_sight.c). M7-plan §M7-09; R07 §9.2/§9.3.
//
// SPLASH TRUTH (mirror-verified, R07 §9.2): P_ExplodeMissile does NO area
// damage — splash runs ONLY from the two states carrying A_Explode
// (S_EXPLODE1 = MT_ROCKET's deathstate, S_BEXP4 = the barrel chain), and
// plasma/caco/baron/BFG do no splash on impact (BFG sprays via A_BFGSpray
// in S_BFGLAND3 instead). Falloff = damage − chebyshev(dist − radius),
// LOS-gated, MT_CYBORG/MT_SPIDER immune. The scan-box radius is
// `(damage+MAXRADIUS)<<FRACBITS` IN 32-BIT — the MAXRADIUS term wraps
// away (32<<32 ≡ 0 mod 2^32), so the scanned half-width is exactly
// `damage` map units (computed with the wrap preserved: `* 65536 | 0`).
//
// P_CheckSight (M8-01): the LOS probe now lives in psight.ts — the exact
// p_sight.c:300 BSP walk (P_CrossBSPNode/P_CrossSubsector, REJECT via the
// subsector sector indices, sightcounts[2] exposed). This file keeps only
// the one-line delegation below so the splash LOS and every later
// A_Look/A_Chase/range consumer share ONE implementation.
//
// Vanilla-globals rule: bombspot/bombsource/bombdamage and the sight
// globals are module-level (one radius attack / one LOS in flight, like
// the C file scope); no allocation on the scan path.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG90, FRACBITS, FRACUNIT } from '../core/constants';
import { MF, MT } from '../wad/info/mobjinfo';

import { ACT, registerAction } from './a_actions';
import { damageSlot } from './hooks';
import { MAPBLOCKSHIFT } from './blockmap';
import { type Mobj, pSpawnMobj, type MobjRuntime } from './p_mobj';
import { linetarget, pAimLineAttack } from './p_shoot';
import { pRandom } from './prng';
// M8-01 delegation: P_CheckSight is psight.ts (see header); re-exported so
// existing consumers keep working.
import { pCheckSight } from './psight';
import { thingLinksIterator } from './thinglinks';

export { pCheckSight, type SightPoint } from './psight';

/* ------------------------------------------------------------------ */
/* P_RadiusAttack / PIT_RadiusAttack — p_map.c:1160-1245 verbatim       */
/* ------------------------------------------------------------------ */

/** p_map.c:1150 MAXRADIUS = 32*FRACUNIT (wraps out of the scan radius —
 * see header; kept literally so the scan math is transcription). */
export const MAXRADIUS = 32 * FRACUNIT;

/** bombspot/bombsource/bombdamage (p_map.c:1152-1156). */
const bomb = {
  spot: null as Mobj | null,
  source: null as Mobj | null,
  damage: 0,
  rt: null as MobjRuntime | null,
};

function abs32(v: number): number {
  return v === -0x80000000 ? v : v < 0 ? -v : v;
}

/** `PIT_RadiusAttack(thing)` — slot argument (port convention). */
function pitRadiusAttack(slot: number): boolean {
  const rt = bomb.rt!;
  const st = rt.state;
  const links = st.pmap.links;

  if ((links.flags[slot]! & MF.MF_SHOOTABLE) === 0) return true;

  // Boss spider and cyborg take no damage from concussion.
  const thing = rt.slotMobjs.get(slot);
  if (thing && !thing.removed) {
    if (thing.type === MT.MT_CYBORG || thing.type === MT.MT_SPIDER) return true;
  }

  const spot = bomb.spot!;
  const dx = abs32((links.x[slot]! - spot.x) | 0);
  const dy = abs32((links.y[slot]! - spot.y) | 0);
  let dist = dx > dy ? dx : dy;
  dist = ((dist - links.radius[slot]!) >> FRACBITS); // C arithmetic shift
  if (dist < 0) dist = 0;
  if (dist >= bomb.damage) return true; // out of range

  // must be in direct path
  if (
    pCheckSight(rt, { x: links.x[slot]!, y: links.y[slot]!, z: links.z[slot]!, height: links.height[slot]! }, {
      x: spot.x,
      y: spot.y,
      z: spot.z,
      height: spot.height,
    })
  ) {
    // P_DamageMobj(thing, bombspot, bombsource, bombdamage − dist):
    // damageSlot convention (target slot id, source = bombsource's slot
    // id or null, inflictor half not representable — p_shoot.ts note).
    const src = bomb.source && !bomb.source.removed && bomb.source.linkSlot >= 0
      ? bomb.source.linkSlot
      : null;
    damageSlot(st.hooks, slot, (bomb.damage - dist) | 0, src, st.leveltime);
  }
  return true;
}

/**
 * `P_RadiusAttack(spot, source, damage)` — blockmap box scan (y outer,
 * x inner, vanilla loop order). The `(damage+MAXRADIUS)<<FRACBITS` radius
 * keeps the C 32-bit wrap (`* 65536 | 0` — for damage < 32768 the
 * MAXRADIUS term vanishes and the half-width is `damage` units).
 */
export function pRadiusAttack(
  rt: MobjRuntime,
  spot: Mobj,
  source: Mobj | null,
  damage: number,
): void {
  const bm = rt.state.pmap.bm;
  const dist = ((damage + MAXRADIUS) * 65536) | 0; // <<FRACBITS with wrap
  const yh = (spot.y + dist - bm.originY) >> MAPBLOCKSHIFT;
  const yl = (spot.y - dist - bm.originY) >> MAPBLOCKSHIFT;
  const xh = (spot.x + dist - bm.originX) >> MAPBLOCKSHIFT;
  const xl = (spot.x - dist - bm.originX) >> MAPBLOCKSHIFT;

  bomb.spot = spot;
  bomb.source = source;
  bomb.damage = damage;
  bomb.rt = rt;

  for (let y = yl; y <= yh; y++) {
    for (let x = xl; x <= xh; x++) {
      thingLinksIterator(rt.state.pmap.links, x, y, pitRadiusAttack);
    }
  }
}

/* ------------------------------------------------------------------ */
/* State actions (registered at module load — a_actions slot ids 23/24) */
/* ------------------------------------------------------------------ */

/** A_Explode (p_enemy.c:1598-1601): `P_RadiusAttack(thingy, thingy->target, 128)`.
 * Reached ONLY from S_EXPLODE1 (rocket deathstate) and S_BEXP4 (barrel). */
function aExplode(ctx: unknown): void {
  const mo = ctx as Mobj;
  const src = mo.target && !mo.target.removed ? mo.target : null;
  pRadiusAttack(mo.rt, mo, src, 128);
}

/** A_BFGSpray (p_pspr.c:781-813, S_BFGLAND3): 40 rays over a 90° arc,
 * 2.25° apart (`ANG90/40*i` — C integer divide FIRST, 26843545 per step),
 * range `16*64*FRACUNIT`; per HIT ray: MT_EXTRABFG spawn at
 * `z + (height>>2)` (1 P_Random — the spawn lastlook draw), 15 damage
 * draws `(P_Random()&7)+1`, then P_DamageMobj(linetarget, target, target,
 * damage). Rays that miss draw NOTHING (prnd-index arithmetic! the BFG
 * stream pin is 16 draws × hit-rays, in ray order). `mo->target` NULL:
 * vanilla would crash — port skips the spray (deviation, unreachable in
 * single player: the BFG mobj always carries its shooter). */
const ANG90_40 = Math.trunc(ANG90 / 40); // C: ANG90/40 == 26843545

function aBFGSpray(ctx: unknown): void {
  const mo = ctx as Mobj;
  const rt = mo.rt;
  const st = rt.state;
  const origin = mo.target && !mo.target.removed ? mo.target : null;
  if (!origin) return; // documented NULL-target deviation (see above)
  const links = st.pmap.links;

  for (let i = 0; i < 40; i++) {
    const an = (mo.angle - Math.trunc(ANG90 / 2) + ANG90_40 * i) >>> 0;

    // mo->target is the originator (player) of the missile
    pAimLineAttack(origin, an, 16 * 64 * FRACUNIT);
    if (!linetarget.active) continue;

    const tslot = linetarget.slot;
    pSpawnMobj(
      rt,
      linetarget.x,
      linetarget.y,
      (links.z[tslot]! + (links.height[tslot]! >> 2)) | 0,
      MT.MT_EXTRABFG,
    );

    let damage = 0;
    for (let j = 0; j < 15; j++) damage += (pRandom(st.rng) & 7) + 1;

    damageSlot(
      st.hooks,
      tslot,
      damage,
      origin.linkSlot >= 0 ? origin.linkSlot : null,
      st.leveltime,
    );
  }
}

registerAction(ACT.A_Explode, aExplode, 'mobj');
registerAction(ACT.A_BFGSpray, aBFGSpray, 'mobj');
