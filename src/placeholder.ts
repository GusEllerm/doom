/**
 * Deterministic animated placeholder shown before the real renderer exists.
 * Pure function of (x, y, tick): no DOM, no wall-clock, no Math.random.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export const RENDER_WIDTH = 320;
export const RENDER_HEIGHT = 200;

export type RGB = readonly [r: number, g: number, b: number];

/** Deterministic color for one pixel at one simulation tick. */
export function placeholderPixel(x: number, y: number, tick: number): RGB {
  const u = x / RENDER_WIDTH;
  const v = y / RENDER_HEIGHT;
  const phase = tick * 0.1;
  const r = Math.floor(((Math.sin(u * Math.PI * 2 + phase) + 1) / 2) * 255);
  const g = Math.floor(
    ((Math.sin((u + v) * Math.PI * 4 + phase * 2) + 1) / 2) * 255
  );
  const b = Math.floor(64 + v * 128);
  return [r, g, b];
}
