// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { placeholderPixel, RENDER_HEIGHT, RENDER_WIDTH } from './placeholder';

describe('placeholderPixel', () => {
  it('is deterministic for the same inputs', () => {
    expect(placeholderPixel(10, 20, 3)).toEqual(placeholderPixel(10, 20, 3));
  });

  it('stays inside 8-bit channel range', () => {
    for (let y = 0; y < RENDER_HEIGHT; y += 7) {
      for (let x = 0; x < RENDER_WIDTH; x += 3) {
        const [r, g, b] = placeholderPixel(x, y, y);
        for (const c of [r, g, b]) {
          expect(Number.isInteger(c)).toBe(true);
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThan(256);
        }
      }
    }
  });

  it('animates over ticks (frame content changes)', () => {
    const a = placeholderPixel(100, 100, 0);
    const b = placeholderPixel(100, 100, 64);
    expect(a).not.toEqual(b);
  });

  it('renders more than one distinct color per frame', () => {
    const colors = new Set<string>();
    for (let y = 0; y < RENDER_HEIGHT; y += 10) {
      for (let x = 0; x < RENDER_WIDTH; x += 10) {
        colors.add(placeholderPixel(x, y, 5).join(','));
      }
    }
    expect(colors.size).toBeGreaterThan(1);
  });
});
