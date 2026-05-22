import { describe, it, expect } from 'vitest';
import { castRay } from '../../src/render/raycaster';
import { parseLevel } from '../../src/world/level';

const lvl = parseLevel({
  name: 't', width: 5, height: 1,
  tiles: [0, 0, 0, 1, 0],
  textures: {}, spawns: [], music: '', exit: null,
});

describe('castRay', () => {
  it('returns perpendicular distance to wall along +X ray', () => {
    const hit = castRay(lvl, 0.5, 0.5, 1, 0);
    expect(hit.perpDist).toBeCloseTo(2.5, 5);
    expect(hit.tile).toBe(1);
    expect(hit.side).toBe(0);
  });
});
