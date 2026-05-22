import { describe, it, expect } from 'vitest';
import { Input } from '../../src/engine/input';

describe('Input', () => {
  it('snapshot returns axes from currently-pressed keys and resets mouse delta', () => {
    const input = new Input();
    input._press('KeyW');
    input._press('KeyD');
    input._mouseMove(15);
    const s = input.snapshot();
    expect(s.forward).toBe(1);
    expect(s.strafe).toBe(1);
    expect(s.yawDelta).toBe(15);
    const s2 = input.snapshot();
    expect(s2.yawDelta).toBe(0);
  });

  it('fire is latched and clears after read', () => {
    const input = new Input();
    input._press('Space');
    expect(input.snapshot().fire).toBe(true);
    expect(input.snapshot().fire).toBe(true); // still held
    input._release('Space');
    expect(input.snapshot().fire).toBe(false);
  });
});
