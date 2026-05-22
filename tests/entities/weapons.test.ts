import { describe, it, expect } from 'vitest';
import { rayHitsCircle, WEAPONS } from '../../src/entities/weapons';

describe('rayHitsCircle', () => {
  it('detects ray hitting circle directly ahead', () => {
    const t = rayHitsCircle(0, 0, 1, 0, 5, 0, 0.4);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(5 - 0.4, 3);
  });

  it('misses when circle is off-axis', () => {
    expect(rayHitsCircle(0, 0, 1, 0, 5, 2, 0.4)).toBeNull();
  });

  it('returns null for circle behind origin', () => {
    expect(rayHitsCircle(0, 0, 1, 0, -5, 0, 0.4)).toBeNull();
  });
});

describe('WEAPONS', () => {
  it('shotgun fires 7 rays', () => {
    const s = WEAPONS.find((w) => w.key === 'shotgun')!;
    expect(s.rays).toBe(7);
  });
  it('pistol uses pistol ammo, shotgun uses shotgun ammo', () => {
    expect(WEAPONS[0]!.ammoKey).toBe('pistol');
    expect(WEAPONS[1]!.ammoKey).toBe('shotgun');
  });
});
