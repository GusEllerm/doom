import { describe, it, expect, vi } from 'vitest';
import { stepAccumulator } from '../../src/engine/loop';

describe('stepAccumulator', () => {
  it('runs N fixed steps and returns remaining accumulator', () => {
    const tick = vi.fn();
    const remaining = stepAccumulator(50, 16, tick);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(remaining).toBeCloseTo(2, 5);
  });

  it('clamps catch-up to a max number of ticks (spiral of death guard)', () => {
    const tick = vi.fn();
    const remaining = stepAccumulator(10_000, 1000 / 60, tick, 5);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(remaining).toBe(0);
  });
});
