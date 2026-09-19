// M5-04 stub: P_SlideMove + P_HitSlideLine (p_map.c part 3). Signatures only.

import type { Mover, PMapWorld } from "./pmap";

/**
 * Signature stub for P_SlideMove (p_map.c). Real body lands in this task.
 * Contract: caller (P_XYMovement, M5-05) has already tried P_TryMove on the
 * full delta and failed; this routine slides along blocking walls.
 */
export function pSlideMove(world_: PMapWorld, mover: Mover): void {
  throw new Error("M5-04 stub: pSlideMove not implemented");
}
