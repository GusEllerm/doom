import { describe, it, expect } from 'vitest';
import { Menu } from '../../src/game/menu';

describe('Menu', () => {
  it('next/prev cycles through items', () => {
    const m = new Menu([
      { label: 'a', action: 'A' },
      { label: 'b', action: 'B' },
      { label: 'c', action: 'C' },
    ]);
    expect(m.selected).toBe(0);
    m.next();
    expect(m.activate()).toBe('B');
    m.next();
    expect(m.activate()).toBe('C');
    m.next();
    expect(m.activate()).toBe('A'); // wraps
    m.prev();
    expect(m.activate()).toBe('C'); // wraps
  });

  it('skips disabled items', () => {
    const m = new Menu([
      { label: 'a', action: 'A' },
      { label: 'b', action: 'B', disabled: true },
      { label: 'c', action: 'C' },
    ]);
    m.next();
    expect(m.activate()).toBe('C');
  });

  it('activates current selection', () => {
    const m = new Menu([
      { label: 'a', action: 'A' },
      { label: 'b', action: 'B' },
    ]);
    expect(m.activate()).toBe('A');
  });
});
