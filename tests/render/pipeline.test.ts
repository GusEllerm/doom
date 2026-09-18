/**
 * M4-07 — full-frame pipeline integration (docs/design/M4-plan.md §M4-07).
 *
 * SKELETON (this commit is the ownership stub; the assertions land with the
 * integration commit). The suite proves one `renderFrame` now runs the whole
 * vanilla order — clears → BSP walls (+ plane marks + R_AddSprites) →
 * drawPlanes → vissprites → masked middles — and that the five health
 * counters stay 0 on every fixture/IWAD scene.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

describe('renderFrame (M4-07): full-frame pipeline', () => {
  it('skeleton placeholder (real cases land in the integration commit)', () => {
    expect(true).toBe(true);
  });
});
