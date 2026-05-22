import { describe, it, expect } from 'vitest';
import { parseLevel } from '../../src/world/level';

describe('parseLevel', () => {
  it('parses a level with width*height tiles', () => {
    const lvl = parseLevel({
      name: 'test', width: 3, height: 3,
      tiles: [1, 1, 1, 1, 0, 1, 1, 1, 1],
      textures: {}, spawns: [], music: '', exit: null,
    });
    expect(lvl.tileAt(1, 1)).toBe(0);
    expect(lvl.tileAt(0, 0)).toBe(1);
    expect(lvl.isSolid(0, 0)).toBe(true);
    expect(lvl.isSolid(1.5, 1.5)).toBe(false);
  });

  it('rejects tile arrays of wrong length', () => {
    expect(() => parseLevel({
      name: 'x', width: 2, height: 2, tiles: [1, 1, 1],
      textures: {}, spawns: [], music: '', exit: null,
    })).toThrow();
  });

  it('treats out-of-bounds as solid', () => {
    const lvl = parseLevel({
      name: 't', width: 2, height: 2, tiles: [0, 0, 0, 0],
      textures: {}, spawns: [], music: '', exit: null,
    });
    expect(lvl.isSolid(-1, 0)).toBe(true);
    expect(lvl.isSolid(0, 10)).toBe(true);
  });
});
