/**
 * sim/bsp — BSP point-side test + subsector location (M2-05).
 *
 * Source-verified integer forms (linuxdoom-1.10). THREE side tests exist in
 * the 1.10 tree and they are NOT identical — each is replicated verbatim
 * where it belongs:
 *
 *  - `r_main.c:162 R_PointOnSide(x, y, node_t*)` — the BSP walk:
 *      axis fast paths, then the sign-bit fast path
 *      `(node->dy ^ node->dx ^ dx ^ dy) & 0x80000000`, then
 *      `left = FixedMul(node->dy >> FRACBITS, dx); right = FixedMul(dy,
 *      node->dx >> FRACBITS); return right < left ? 0 : 1;`
 *    This is the one R_PointInSubsector/P_PointOnNode-class walks use, so it
 *    backs {@link subsectorAt} here. Note the asymmetry kept verbatim: `dx`
 *    is NOT pre-shifted in the left product (only node->dy is >>FRACBITS),
 *    so the truncation is floor(dy/2^16) * dx, i.e. the test is exact only
 *    when the delta on the node-delta axis is a whole map unit; on-plane
 *    points tie to side 1 (`right < left` fails on equality).
 *  - `p_maputl.c:161 P_PointOnDivlineSide(x, y, divline_t*)` — the tracing
 *    version with the balanced pre-shift `FixedMul(dy >> 8, dx >> 8)`
 *    (keeps the cross product inside 32 bits at the cost of 8-bit truncation
 *    on BOTH deltas). Replicated as {@link pointOnDivlineSide} for M5's
 *    P_PathTraverse/P_RayTraverse (its intercept math consumes this form).
 *  - `p_sight.c:55 P_DivlineSide` — pure integer `(dy>>FRACBITS)*(dx>>
 *    FRACBITS)` products with an extra collinear return 2; NOT needed until
 *    P_CheckSight (M5) — documented, not implemented here.
 *
 * 32-bit wrap analysis (why `FixedMul` is exact-faithful here): in C the
 * products inside FixedMul overflow gcc's `long` exactly like our 16-limb
 * FixedMul wraps mod 2^32 (A-FX1 pinned that against the BigInt oracle);
 * on huge deltas vanilla's `left`/`right` themselves wrap — we reproduce
 * the wrap by reusing FixedMul, not widening to doubles. `x - node->x`
 * differences are `|0`-wrapped to int32 to match C subtraction on `long`s.
 *
 * `R_PointInSubsector` itself is one of the functions MISSING from the
 * released 1.10 sources (only call sites survive: p_map.c:141, p_mobj.c:382,
 * g_game.c:878). Its reconstruction (Doom shareware sources + the
 * r_main.c:813 walk) is: start at the ROOT node `nodes[numnodes-1]`,
 * repeatedly take `children[side = R_PointOnSide(x, y, node)]`; a child with
 * the NF_SUBSECTOR bit (low bit, already split by M2-04 into the tagged
 * {@link NodeChild}) ends the walk. We mirror that exactly via the tagged
 * refs, guarding against child cycles (vanilla would spin/corrupt; we throw
 * a typed error after nodes.count+1 steps — same policy as MapSetupError).
 *
 * Determinism: pure int arithmetic, no allocation, no globals. Tie-breaks
 * are whatever C's `right < left` produces, so points exactly on a splitter
 * deterministically take side 1 at that node (documented test).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { FixedMul, FRACBITS } from '../core/fixed';
import type { NodeArrays, NodeChild, RuntimeMap } from './map';

/** divline_t (p_local.h) — plain record for the tracing side test. */
export interface DivLine {
  /** fixed */
  readonly x: number;
  readonly y: number;
  /** fixed */
  readonly dx: number;
  readonly dy: number;
}

/** Thrown on structurally bad BSP walks (cycles / empty maps). */
export class BspError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BspError';
  }
}

/** 0 = front/right side, 1 = back/left side (vanilla `int` return). */
export type Side = 0 | 1;

/**
 * Shared body of the two 1.10 side tests. `shift` picks the truncation
 * flavour: FRACBITS(16) ⇒ R_PointOnSide's `FixedMul(dy>>16, dx)` pairing
 * (dy pre-shifted in `left`, dx pre-shifted in `right`), 8 ⇒
 * P_PointOnDivlineSide's `FixedMul(dy>>8, dx>>8)` (both pre-shifted).
 * The axis fast paths and the sign-bit fast path are identical in both.
 */
function sideTest(
  x: number,
  y: number,
  lx: number,
  ly: number,
  ldx: number,
  ldy: number,
  shift: number,
): Side {
  if (ldx === 0) {
    if (x <= lx) return ldy > 0 ? 1 : 0;
    return ldy < 0 ? 1 : 0;
  }
  if (ldy === 0) {
    if (y <= ly) return ldx < 0 ? 1 : 0;
    return ldx > 0 ? 1 : 0;
  }

  const dx = (x - lx) | 0; // C `long` sub == int32 wrap for int32 inputs
  const dy = (y - ly) | 0;

  // try to quickly decide by looking at sign bits
  if ((ldy ^ ldx ^ dx ^ dy) & 0x80000000) {
    if ((ldy ^ dx) & 0x80000000) return 1; // (left is negative)
    return 0;
  }

  const left = shift === 8 ? FixedMul(ldy >> 8, dx >> 8) : FixedMul(ldy >> FRACBITS, dx);
  const right = shift === 8 ? FixedMul(dy >> 8, ldx >> 8) : FixedMul(dy, ldx >> FRACBITS);
  return right < left ? 0 : 1; // front : back (on-plane ⇒ back, verbatim)
}

/**
 * `r_main.c R_PointOnSide` verbatim for one node: fixed point (x,y) against
 * node i's partition. Used by {@link subsectorAt}.
 */
export function pointOnSide(x: number, y: number, nodes: NodeArrays, i: number): Side {
  return sideTest(x, y, nodes.x[i]!, nodes.y[i]!, nodes.dx[i]!, nodes.dy[i]!, FRACBITS);
}

/**
 * `p_maputl.c P_PointOnDivlineSide` verbatim (the `>>8` pre-shifted form).
 * For divlines built by P_MakeDivline/P_PathTraverse (M5+); exported now so
 * the BSP golden tests can pin both truncation flavours side by side.
 */
export function pointOnDivlineSide(x: number, y: number, line: DivLine): Side {
  return sideTest(x, y, line.x, line.y, line.dx, line.dy, 8);
}

/**
 * Child pick mirroring `node->children[side]`: side 0 → child 0
 * (`right`/front), side 1 → child 1 (`left`/back).
 */
function childOf(nodes: NodeArrays, i: number, side: Side): NodeChild {
  return side === 0 ? nodes.right[i]! : nodes.left[i]!;
}

/**
 * `R_PointInSubsector(x, y)` — walk from the ROOT node (`nodes[count-1]`,
 * the vanilla root) down via {@link pointOnSide} until a subsector child.
 * A map with zero nodes has one subsector: return 0 (vanilla would read
 * nodes[-1] — the same answer on every real map, minus the UB).
 */
export function subsectorAt(map: RuntimeMap, x: number, y: number): number {
  const nodes = map.nodes;
  if (nodes.count === 0) {
    if (map.subsectors.count === 0) {
      throw new BspError(`map ${map.name}: no nodes and no subsectors`);
    }
    return 0;
  }
  let i = nodes.count - 1;
  let side = pointOnSide(x, y, nodes, i);
  for (let guard = nodes.count; ; guard--) {
    const child = childOf(nodes, i, side);
    if (child.kind === 'subsector') return child.index;
    if (guard < 0) {
      throw new BspError(`map ${map.name}: BSP walk cycle at node ${i} after ${nodes.count} steps`);
    }
    i = child.index;
    side = pointOnSide(x, y, nodes, i);
  }
}

/** Subsector index as the vanilla `subsector_t*`-style walk (alias). */
export const pointInSubsector = subsectorAt;

/** Sector index containing fixed point (x,y) (P_PointInSubsector→sector). */
export function sectorAtPoint(map: RuntimeMap, x: number, y: number): number {
  return map.subsectors.sector[subsectorAt(map, x, y)]!;
}
