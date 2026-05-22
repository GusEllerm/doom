// Lightweight menu/list state. Keyboard-first; mouse hover updates selection.

export interface MenuItem<A extends string = string> {
  label: string;
  action: A;
  disabled?: boolean;
}

export interface MenuRow {
  x: number; y: number; w: number; h: number; index: number;
}

export class Menu<A extends string = string> {
  selected = 0;
  private items: MenuItem<A>[];
  rows: MenuRow[] = []; // populated by the renderer each frame for hit-testing

  constructor(items: MenuItem<A>[]) {
    this.items = items;
    this.normalize();
  }

  hitTest(px: number, py: number): number | null {
    for (const r of this.rows) {
      if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) {
        if (this.items[r.index]?.disabled) return null;
        return r.index;
      }
    }
    return null;
  }

  get list(): readonly MenuItem<A>[] { return this.items; }

  replace(items: MenuItem<A>[]) {
    this.items = items;
    this.selected = Math.min(this.selected, items.length - 1);
    this.normalize();
  }

  private normalize() {
    // Skip disabled items.
    if (this.items.length === 0) return;
    const start = this.selected;
    while (this.items[this.selected]?.disabled) {
      this.selected = (this.selected + 1) % this.items.length;
      if (this.selected === start) break;
    }
  }

  next() {
    if (this.items.length === 0) return;
    const start = this.selected;
    do {
      this.selected = (this.selected + 1) % this.items.length;
    } while (this.items[this.selected]?.disabled && this.selected !== start);
  }

  prev() {
    if (this.items.length === 0) return;
    const start = this.selected;
    do {
      this.selected = (this.selected - 1 + this.items.length) % this.items.length;
    } while (this.items[this.selected]?.disabled && this.selected !== start);
  }

  select(idx: number) {
    if (idx >= 0 && idx < this.items.length && !this.items[idx]?.disabled) {
      this.selected = idx;
    }
  }

  current(): MenuItem<A> | undefined { return this.items[this.selected]; }
  activate(): A | undefined {
    const c = this.current();
    return c && !c.disabled ? c.action : undefined;
  }
}
