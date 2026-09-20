// sim/psight.ts — the dedicated LOS tracer: P_CheckSight + its BSP walk
// (linuxdoom-1.10 p_sight.c — P_CheckSight :300, P_DivlineSide :55,
// P_InterceptVector2 :109, P_CrossSubsector :126, P_CrossBSPNode :159;
// mirror verified this task: `ls /tmp/DOOM-master/linuxdoom-1.10/*.c | wc -l`
// == 62, p_sight.c 349 lines read in full). M8-plan §M8-01 / §0.10. This
// file is THE P_CheckSight; pradius.ts keeps a one-line delegation so every
// consumer (splash LOS today; A_Look/A_Chase/P_CheckMeleeRange/
// P_CheckMissileRange from M8-04+) shares one implementation.
//
// QUIRKS KEPT VERBATIM (p_sight.c line cites):
//  * P_DivlineSide :55 returns 0 front / 1 back / 2 ON — a THREE-valued
//    side test, distinct from both R_PointOnSide (bsp.ts) and
//    P_PointOnDivlineSide (pmaputl.ts). Its general path is the pure-integer
//    cross product `(dy>>FRACBITS)*(dx>>FRACBITS)` — plain map-unit integer
//    multiplies, NOT FixedMul, and with NO sign-bit fast path. Math.imul
//    preserves gcc's 32-bit `long` wrap (house int32 rule; products of
//    map-sized deltas never approach 2^31 in practice).
//  * The axis-aligned `!dy` branch tests `x == node->y` (p_sight.c:75) —
//    the vanilla typo comparing the query X against the partition ORIGIN Y.
//    Kept verbatim: for horizontal partitions the "on" return 2 fires for
//    points whose x equals the partition's origin y.
//  * P_CrossSubsector :126 stamps `line->validcount` BEFORE the crossing
//    tests (dedup runs even for lines the trace never crosses), and a
//    NON-two-sided crossed line returns FALSE immediately — the tracer
//    stops at the first one-sided wall, it never keeps going "around" it.
//  * Cone math is on RAW z-deltas (no divide by distance): topslope/
//    bottomslope init from the target extent, narrowed via
//    FixedDiv(opening − sightzstart, frac) — frac from
//    P_InterceptVector2, whose body is the exact same expression as
//    pmaputl's P_InterceptVector (>>8 FixedMul flavour, p_maputl.c:229 vs
//    p_sight.c:109), so that one function is reused; C's reversed (v2, v1)
//    parameter order is matched by calling pInterceptVector(strace, divl).
//  * P_CheckSight :300 eye height `z + height − (height>>2)` (3/4 height),
//    `validcount++` in the SHARED pmaputl counter domain (line stamps are
//    the same lines.valid array the blockmap pathTrace stamps — exactly
//    vanilla's single-global semantics), and the BSP head is the LAST node
//    (`numnodes-1`); a nodes-less map traces subsector 0 (vanilla
//    P_CrossBSPNode(-1) → P_CrossSubsector(0), p_sight.c:163-167).
//  * No PRNG, no MF_SHADOW/stealth test, no range limit: an unobstructed
//    LOS is infinite — only geometry or the REJECT bit stops it (§0.10).
//    sightcounts[0] (trivial reject) / sightcounts[1] (traced) are the
//    p_sight.c:36 file globals, exposed for determinism assertions.
//
// The `sector->soundtarget` STORAGE seam at the bottom serves the §0.3 sound
// wake: the field lives in the map.ts sector SoA (ThingLinks slot id, −1 =
// the vanilla NULL mobj_t*), cleared at level load by the map build; the
// P_NoiseAlert/P_RecursiveSound BODY lands with M8-04 (p_enemy.ts owner) and
// writes through setSectorSoundTarget. Nothing here ticks or draws.
//
// Vanilla-globals rule: strace/t2x/t2y/sightzstart/slopes are module-level
// scratch (one trace in flight, like the C file scope); no allocation on the
// trace path (the two divline records are reused arenas).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FixedDiv } from '../core/fixed';
import { FRACBITS } from '../core/constants';
import { sectorAtPoint } from './bsp';
import type { NodeChild, RuntimeMap } from './map';
import type { DivLineMut } from './pmaputl';
import { bumpValidcount, pInterceptVector } from './pmaputl';
import type { MobjRuntime } from './p_mobj';
import { ML_TWOSIDED } from './pspec-helpers';
import type { LiveSectors } from './state';

/* ------------------------------------------------------------------ */
/* File globals (p_sight.c:28-36)                                       */
/* ------------------------------------------------------------------ */

/** The `mobj_t` slice the LOS reads (an Mobj, a ThingLinks-grid view, or a
 * raw point — same shape pradius.ts has always used). */
export interface SightPoint {
  x: number;
  y: number;
  z: number;
  height: number;
}

/** p_sight.c:36 `int sightcounts[2]` — [0] trivial REJECT hits,
 * [1] full traces. Exposed for L2 determinism assertions (acceptance 3). */
export const sightcounts = new Int32Array(2);

/** strace + the two scratch divlines (no per-line allocation). */
const strace: DivLineMut = { x: 0, y: 0, dx: 0, dy: 0 };
const divl: DivLineMut = { x: 0, y: 0, dx: 0, dy: 0 };
let t2x = 0;
let t2y = 0;
let sightzstart = 0; // eye z of looker
let topslope = 0;
let bottomslope = 0;

let curMap: RuntimeMap | null = null;
let curLive: LiveSectors | null = null;

/* ------------------------------------------------------------------ */
/* P_DivlineSide — p_sight.c:55-89 verbatim                             */
/* ------------------------------------------------------------------ */

/**
 * `P_DivlineSide(x, y, divline)` — 0 front, 1 back, 2 on. Exported for the
 * differential test (and M8-04+); the quirks (including the `x == node->y`
 * typo in the horizontal branch, :75) are verbatim — see header.
 */
export function divlineSide(
  x: number,
  y: number,
  nx: number,
  ny: number,
  ndx: number,
  ndy: number,
): number {
  if (ndx === 0) {
    if (x === nx) return 2;
    if (x <= nx) return ndy > 0 ? 1 : 0; // `return node->dy > 0;`
    return ndy < 0 ? 1 : 0;
  }

  if (ndy === 0) {
    if (x === ny) return 2; // VERBATIM vanilla typo: x compared to node->y
    if (y <= ny) return ndx < 0 ? 1 : 0;
    return ndx > 0 ? 1 : 0;
  }

  const dx = (x - nx) | 0;
  const dy = (y - ny) | 0;

  // pure map-unit integer cross product — NOT FixedMul, no fast path (:82-83)
  const left = Math.imul(ndy >> FRACBITS, dx >> FRACBITS) | 0;
  const right = Math.imul(dy >> FRACBITS, ndx >> FRACBITS) | 0;

  if (right < left) return 0; // front side
  if (left === right) return 2;
  return 1; // back side
}

/* ------------------------------------------------------------------ */
/* P_CrossSubsector — p_sight.c:126-254                                 */
/* ------------------------------------------------------------------ */

function crossSubsector(num: number, stamp: number): boolean {
  const map = curMap!;
  const live = curLive!;
  const ss = map.subsectors;
  const L = map.lines;

  const end = ss.segStart[num]! + ss.segCount[num]!;
  for (let seg = ss.segStart[num]!; seg < end; seg++) {
    const line = map.segLine[seg]!;

    // allready checked other side? (p_sight.c:151-155)
    if (L.valid[line] === stamp) continue;
    L.valid[line] = stamp;

    const v1x = map.verticesX[L.v1[line]!]!;
    const v1y = map.verticesY[L.v1[line]!]!;
    const v2x = map.verticesX[L.v2[line]!]!;
    const v2y = map.verticesY[L.v2[line]!]!;

    let s1 = divlineSide(v1x, v1y, strace.x, strace.y, strace.dx, strace.dy);
    let s2 = divlineSide(v2x, v2y, strace.x, strace.y, strace.dx, strace.dy);
    if (s1 === s2) continue; // line isn't crossed?

    divl.x = v1x;
    divl.y = v1y;
    divl.dx = (v2x - v1x) | 0;
    divl.dy = (v2y - v1y) | 0;
    s1 = divlineSide(strace.x, strace.y, divl.x, divl.y, divl.dx, divl.dy);
    s2 = divlineSide(t2x, t2y, divl.x, divl.y, divl.dx, divl.dy);
    if (s1 === s2) continue; // line isn't crossed?

    // stop because it is not two sided anyway (:179-182)
    if ((L.flags[line]! & ML_TWOSIDED) === 0) return false;

    // crosses a two sided line — seg front/back sectors (P_GroupLines
    // resolved; == the line sides for two-sided lines)
    const front = map.segSectorFront[seg]!;
    const back = map.segSectorBack[seg]!;
    const fFront = live.floorZ[front]!;
    const fBack = live.floorZ[back]!;
    const cFront = live.ceilingZ[front]!;
    const cBack = live.ceilingZ[back]!;

    // no wall to block sight with?
    if (fFront === fBack && cFront === cBack) continue;

    // possible occluder
    const opentop = cFront < cBack ? cFront : cBack;
    const openbottom = fFront > fBack ? fFront : fBack;

    // quick test for totally closed doors
    if (openbottom >= opentop) return false; // stop

    // C: P_InterceptVector2(&strace, &divl) with signature (v2, v1)
    const frac = pInterceptVector(strace, divl);

    if (fFront !== fBack) {
      const slope = FixedDiv((openbottom - sightzstart) | 0, frac);
      if (slope > bottomslope) bottomslope = slope;
    }
    if (cFront !== cBack) {
      const slope = FixedDiv((opentop - sightzstart) | 0, frac);
      if (slope < topslope) topslope = slope;
    }
    if (topslope <= bottomslope) return false; // stop
  }
  // passed the subsector ok
  return true;
}

/* ------------------------------------------------------------------ */
/* P_CrossBSPNode — p_sight.c:159-190                                   */
/* ------------------------------------------------------------------ */

function crossChild(child: NodeChild, stamp: number): boolean {
  if (child.kind === 'subsector') return crossSubsector(child.index, stamp);
  return crossBspNode(child.index, stamp);
}

function crossBspNode(bspnum: number, stamp: number): boolean {
  const n = curMap!.nodes;

  let side = divlineSide(strace.x, strace.y, n.x[bspnum]!, n.y[bspnum]!, n.dx[bspnum]!, n.dy[bspnum]!);
  if (side === 2) side = 0; // an "on" should cross both parts

  // cross the starting side (children[side]; side 0 = right/front child)
  if (!crossChild(side === 0 ? n.right[bspnum]! : n.left[bspnum]!, stamp)) return false;

  // the partition plane is crossed here
  if (side === divlineSide(t2x, t2y, n.x[bspnum]!, n.y[bspnum]!, n.dx[bspnum]!, n.dy[bspnum]!)) {
    return true; // the line doesn't touch the other side
  }

  // cross the ending side
  return crossChild(side === 0 ? n.left[bspnum]! : n.right[bspnum]!, stamp);
}

/* ------------------------------------------------------------------ */
/* P_CheckSight — p_sight.c:299-350                                     */
/* ------------------------------------------------------------------ */

/**
 * The post-reject half of P_CheckSight (the `strace` setup +
 * `P_CrossBSPNode(numnodes-1)`), exposed for the BSP-vs-brute differential
 * test — the REJECT shortcut makes the full function skip the walk, which
 * would otherwise hide geometry bugs. Bumps the shared validcount.
 */
export function pSightTrace(
  map: RuntimeMap,
  live: LiveSectors,
  t1: SightPoint,
  t2: SightPoint,
): boolean {
  curMap = map;
  curLive = live;

  sightzstart = (t1.z + t1.height - (t1.height >> 2)) | 0;
  topslope = ((t2.z + t2.height) - sightzstart) | 0;
  bottomslope = (t2.z - sightzstart) | 0;

  strace.x = t1.x;
  strace.y = t1.y;
  t2x = t2.x;
  t2y = t2.y;
  strace.dx = (t2.x - t1.x) | 0;
  strace.dy = (t2.y - t1.y) | 0;

  const stamp = bumpValidcount(); // vanilla `validcount++` (shared domain)

  // the head node is the last node output; a nodes-less map traces ss 0
  // (vanilla P_CrossBSPNode(-1) → P_CrossSubsector(0)).
  if (map.nodes.count === 0) return crossSubsector(0, stamp);
  return crossBspNode(map.nodes.count - 1, stamp);
}

/**
 * `P_CheckSight(t1, t2)` — TRUE when a straight line between the two
 * things is unobstructed. REJECT trivial rejection first (sector indices
 * via the BSP point lookup, the port stand-in for `t->subsector->sector`,
 * kept from the M7-09 probe), then the dedicated BSP sight walk.
 */
export function pCheckSight(rt: MobjRuntime, t1: SightPoint, t2: SightPoint): boolean {
  const st = rt.state;
  const map = st.map;
  const numSectors = map.sectors.count;

  // Determine subsector entries in REJECT table (p_sight.c:315-316).
  const s1 = sectorAtPoint(map, t1.x, t1.y);
  const s2 = sectorAtPoint(map, t2.x, t2.y);
  const pnum = s1 * numSectors + s2;
  if ((map.reject[pnum >> 3]! & (1 << (pnum & 7))) !== 0) {
    sightcounts[0] = (sightcounts[0]! + 1) | 0;
    return false; // can't possibly be connected
  }

  // An unobstructed LOS is possible. Now look from eyes of t1 to any part of t2.
  sightcounts[1] = (sightcounts[1]! + 1) | 0;
  return pSightTrace(map, st.sectors, t1, t2);
}

/* ------------------------------------------------------------------ */
/* sector->soundtarget storage seam (M8-01; body lands M8-04)            */
/* ------------------------------------------------------------------ */

/** The vanilla NULL mobj_t* in slot form (the SoA is filled with this at
 * level load; P_RecursiveSound writes an emitter's ThingLinks slot). */
export const SOUND_TARGET_NONE = -1;

/** `sec->soundtarget = soundtarget;` (p_enemy.c:140) — storage seam for the
 * M8-04 P_NoiseAlert/P_RecursiveSound body; A_Look (M8-04) is the only
 * reader (§0.3). Not hashed: validcount-domain scratch like soundTraversed. */
export function setSectorSoundTarget(map: RuntimeMap, sector: number, emitterLinkSlot: number): void {
  map.sectors.soundTarget[sector] = emitterLinkSlot;
}
