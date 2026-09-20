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
// P_CheckSight PORT DEVIATION (documented, result-equivalent): 1.10 runs
// reject-table trivial-reject → P_CrossBSPNode/P_CrossSubsector. This port
// keeps the reject check and the EXACT cone-narrowing math of
// P_CrossSubsector but walks the segment with the M5-01 blockmap
// pathTrace (PT_ADDLINES, validcount-deduped) instead of the BSP — the
// crossed-line SET for a segment is identical, so the boolean result is
// identical; the `sightcounts[2]` stat is not reproduced (not observable
// here). Cone init is verbatim 1.10: sightzstart = t1->z + height −
// height/4, topslope/bottomslope START as raw z-DELTAS and narrow via
// FixedDiv(opening − sightzstart, frac) (the 1.10 units quirk, p_sight.c
// :135-244, kept exact).
//
// Vanilla-globals rule: bombspot/bombsource/bombdamage and the sight
// globals are module-level (one radius attack / one LOS in flight, like
// the C file scope); no allocation on the scan path.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG90, FRACBITS, FRACUNIT } from '../core/constants';
import { FixedDiv } from '../core/fixed';
import { MF, MT } from '../wad/info/mobjinfo';

import { ACT, registerAction } from './a_actions';
import { sectorAtPoint } from './bsp';
import { damageSlot } from './hooks';
import { MAPBLOCKSHIFT } from './blockmap';
import { type Mobj, pSpawnMobj, type MobjRuntime } from './p_mobj';
import { linetarget, pAimLineAttack } from './p_shoot';
import {
  opening,
  pLineOpening,
  pPathTraverse,
  PT_ADDLINES,
  type Intercept,
} from './pmaputl';
import { pRandom } from './prng';
import { ML_TWOSIDED } from './pspec-helpers';
import { thingLinksIterator } from './thinglinks';

/* ------------------------------------------------------------------ */
/* P_CheckSight — p_sight.c (ported traversal, see header)              */
/* ------------------------------------------------------------------ */

/** The `mobj_t` slice the LOS reads (an Mobj, or a ThingLinks-grid view). */
export interface SightPoint {
  x: number;
  y: number;
  z: number;
  height: number;
}

/** p_sight.c:39-45 file globals. */
const sight = {
  zstart: 0,
  topslope: 0,
  bottomslope: 0,
  map: null as null | Parameters<typeof pLineOpening>[0],
  live: null as null | Parameters<typeof pLineOpening>[2],
  x2: 0,
  y2: 0,
};

/** PitSeesLine/P_CrossSubsector line logic, verbatim math (p_sight.c:
 * 165-244): !ML_TWOSIDED ⇒ block; equal floors+ceilings ⇒ pass; closed
 * opening ⇒ block; else narrow the cone, collapse ⇒ block. */
function ptrSeesLine(in_: Intercept): boolean {
  if (!in_.isLine) return true; // PT_ADDLINES only — no thing intercepts
  const line = in_.line;
  const map = sight.map!;
  if ((map.lines.flags[line]! & ML_TWOSIDED) === 0) return false; // stop

  pLineOpening(map, line, sight.live);
  const f = map.lines.sectorFront[line]!;
  const b = map.lines.sectorBack[line]!;
  const S = sight.live ? { f: sight.live.floorZ[f]!, fb: sight.live.floorZ[b]!, c: sight.live.ceilingZ[f]!, cb: sight.live.ceilingZ[b]! }
    : { f: map.sectors.floorHeight[f]!, fb: map.sectors.floorHeight[b]!, c: map.sectors.ceilingHeight[f]!, cb: map.sectors.ceilingHeight[b]! };

  // no wall to block sight with?
  if (S.f === S.fb && S.c === S.cb) return true; // continue

  // possible occluder
  if (opening.openbottom >= opening.opentop) return false; // closed door

  if (S.f !== S.fb) {
    const slope = FixedDiv((opening.openbottom - sight.zstart) | 0, in_.frac);
    if (slope > sight.bottomslope) sight.bottomslope = slope;
  }
  if (S.c !== S.cb) {
    const slope = FixedDiv((opening.opentop - sight.zstart) | 0, in_.frac);
    if (slope < sight.topslope) sight.topslope = slope;
  }
  if (sight.topslope <= sight.bottomslope) return false; // stop
  return true;
}

/**
 * `P_CheckSight(t1, t2)` (p_sight.c:299-350): reject-matrix trivial
 * rejection (sector indices via the BSP point lookup), then the LOS cone
 * walk. TRUE = a direct path exists.
 */
export function pCheckSight(rt: MobjRuntime, t1: SightPoint, t2: SightPoint): boolean {
  const st = rt.state;
  const numSectors = st.sectors.count;

  const s1 = sectorAtPoint(st.map, t1.x, t1.y);
  const s2 = sectorAtPoint(st.map, t2.x, t2.y);
  const pnum = s1 * numSectors + s2;
  if ((st.map.reject[pnum >> 3]! & (1 << (pnum & 7))) !== 0) return false; // sightcounts[0]

  sight.zstart = (t1.z + t1.height - (t1.height >> 2)) | 0;
  sight.topslope = ((t2.z + t2.height) - sight.zstart) | 0;
  sight.bottomslope = (t2.z - sight.zstart) | 0;
  sight.map = st.map;
  sight.live = st.sectors;
  sight.x2 = t2.x;
  sight.y2 = t2.y;

  return pPathTraverse(
    st.map,
    st.pmap.bm,
    t1.x,
    t1.y,
    t2.x,
    t2.y,
    PT_ADDLINES,
    ptrSeesLine,
  );
}

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

registerAction(ACT.A_Explode, aExplode);
registerAction(ACT.A_BFGSpray, aBFGSpray);
