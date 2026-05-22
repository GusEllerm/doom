import { describe, it, expect } from 'vitest';
import { Doors } from '../../src/world/doors';
import { parseLevel } from '../../src/world/level';

const lvl = parseLevel({
  name: 't', width: 3, height: 3,
  tiles: [1, 1, 1, 1, 9, 1, 1, 0, 1],
  textures: {}, spawns: [], music: '', exit: null,
});

describe('Doors', () => {
  it('starts closed and blocks', () => {
    const d = new Doors(lvl);
    expect(d.isBlocking(1, 1)).toBe(true);
  });

  it('opens fully after sufficient time', () => {
    const d = new Doors(lvl);
    d.tryOpen(1, 1);
    d.update(0.3);
    expect(d.isBlocking(1, 1)).toBe(true); // still opening
    d.update(0.5);
    expect(d.isBlocking(1, 1)).toBe(false);
  });

  it('tryOpenNear opens an adjacent door', () => {
    const d = new Doors(lvl);
    expect(d.tryOpenNear(1.5, 2.5)).toBe(true);
  });
});
