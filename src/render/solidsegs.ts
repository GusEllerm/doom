// render/solidsegs.ts — M3-03 stub: solidsegs occlusion ledger + HOM counters.
// Faithful port of r_bsp.c R_ClipSolidWallSegment / R_ClipPassWallSegment /
// R_ClearClipSegs (see implementation commit for line citations).
//
// SPDX-License-Identifier: GPL-2.0-or-later

export interface RenderCounters {
  hom: number;
  drawsegOverflow: number;
  solidsegDrops: number;
}

export const MAXSEGS = 32;

export function clearClipSegs(viewwidth?: number): void {
  void viewwidth;
  throw new Error('M3-03: not implemented');
}

export function clipSolidWallSegment(first: number, last: number): number {
  void first;
  void last;
  throw new Error('M3-03: not implemented');
}

export function clipPassWallSegment(first: number, last: number): number {
  void first;
  void last;
  throw new Error('M3-03: not implemented');
}

export function fragCount(): number {
  throw new Error('M3-03: not implemented');
}

export function fragStart(i: number): number {
  void i;
  throw new Error('M3-03: not implemented');
}

export function fragStop(i: number): number {
  void i;
  throw new Error('M3-03: not implemented');
}

export function solidsegsLength(): number {
  throw new Error('M3-03: not implemented');
}

export function solidsegsFirst(i: number): number {
  void i;
  throw new Error('M3-03: not implemented');
}

export function solidsegsLast(i: number): number {
  void i;
  throw new Error('M3-03: not implemented');
}

export function solidsegsDrawseg(i: number): number {
  void i;
  throw new Error('M3-03: not implemented');
}

export function setSolidsegsDrawseg(i: number, ref: number): void {
  void i;
  void ref;
  throw new Error('M3-03: not implemented');
}

export function getRenderCounters(): RenderCounters {
  throw new Error('M3-03: not implemented');
}

export function resetRenderCounters(): void {
  throw new Error('M3-03: not implemented');
}

export function noteDrawsegOverflow(): void {
  throw new Error('M3-03: not implemented');
}

export function noteBadStoreRange(start: number, stop: number): boolean {
  void start;
  void stop;
  throw new Error('M3-03: not implemented');
}
