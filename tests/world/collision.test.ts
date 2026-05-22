import { describe, it, expect } from 'vitest';
import { tryMove } from '../../src/world/collision';
import { parseLevel } from '../../src/world/level';

const lvl = parseLevel({
  name: 't', width: 5, height: 5,
  tiles: [
    1, 1, 1, 1, 1,
    1, 0, 0, 0, 1,
    1, 0, 1, 0, 1,
    1, 0, 0, 0, 1,
    1, 1, 1, 1, 1,
  ],
  textures: {}, spawns: [], music: '', exit: null,
});

describe('tryMove', () => {
  it('moves freely in empty space', () => {
    const out = tryMove(lvl, { x: 1.5, y: 1.5 }, 0.3, 0, 0.2);
    expect(out.x).toBeCloseTo(1.8);
    expect(out.y).toBeCloseTo(1.5);
  });

  it('blocks against a wall on X but slides on Y', () => {
    const out = tryMove(lvl, { x: 1.7, y: 2.5 }, 0.5, 0.2, 0.2);
    expect(out.x).toBeLessThanOrEqual(2 - 0.2 + 1e-9);
    expect(out.y).toBeCloseTo(2.7);
  });
});
