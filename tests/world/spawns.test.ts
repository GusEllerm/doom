// Catch spawn-in-wall bugs: every spawned entity in every level must be
// in a walkable tile.

import { describe, it, expect } from 'vitest';
import { LEVELS } from '../../src/world/levels';
import { parseLevel } from '../../src/world/level';

describe('LEVELS spawns', () => {
  for (const lvlJSON of LEVELS) {
    const lvl = parseLevel(lvlJSON);
    for (const s of lvlJSON.spawns) {
      it(`${lvlJSON.name}: ${s.type}${s.kind ? '/' + s.kind : ''} at (${s.x}, ${s.y}) is in a walkable cell`, () => {
        expect(lvl.isSolid(s.x, s.y)).toBe(false);
      });
    }
  }
});
