import { describe, it, expect } from 'vitest';
import { LEVELS } from '../../src/world/levels';
import { parseLevel } from '../../src/world/level';

describe('LEVELS', () => {
  it.each(LEVELS)('$name parses', (j) => {
    expect(() => parseLevel(j)).not.toThrow();
  });

  it.each(LEVELS)('$name has a player spawn', (j) => {
    expect(j.spawns.some((s) => s.type === 'player')).toBe(true);
  });

  it.each(LEVELS)('$name has an exit pad (tile 100) somewhere', (j) => {
    expect(j.tiles.some((t) => t === 100)).toBe(true);
  });
});
