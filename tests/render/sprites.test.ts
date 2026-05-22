import { describe, it, expect } from 'vitest';
import { spriteCameraTransform } from '../../src/render/sprites';

describe('spriteCameraTransform', () => {
  it('returns positive z for sprite in front of camera (angle 0)', () => {
    const t = spriteCameraTransform(3, 0, 0, 0, 0);
    expect(t.z).toBeCloseTo(3);
    expect(t.x).toBeCloseTo(0);
  });

  it('returns negative z for sprite behind camera (angle 0)', () => {
    const t = spriteCameraTransform(-3, 0, 0, 0, 0);
    expect(t.z).toBeLessThan(0);
  });

  it('z stays positive when sprite is in front along arbitrary angle', () => {
    // Camera at origin facing +y (angle = PI/2). Sprite at (0, 4) is in front.
    const t = spriteCameraTransform(0, 4, 0, 0, Math.PI / 2);
    expect(t.z).toBeCloseTo(4);
  });
});
