/**
 * sim-facing debug seams (src/debug.ts) — M6-13 finding 3: popInput.
 * The main.ts input wiring is a plain callback hook; headless asserts the
 * seam contract (null while detached, hook result passthrough, clean
 * detach). SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { attachPopInput, debugApi } from './debug';

describe('debugApi.popInput (M6-13 finding 3 seam)', () => {
  it('null while the main.ts input wiring is detached', () => {
    attachPopInput(null);
    expect(debugApi.popInput()).toBeNull();
  });

  it('passes the drain report through and detaches cleanly', () => {
    let dropped = 3;
    attachPopInput(() => {
      const events = dropped;
      dropped = 0; // popped once — a second call reports an empty drain
      return { events, mouse: { x: -7, y: 2 } };
    });
    expect(debugApi.popInput()).toEqual({ events: 3, mouse: { x: -7, y: 2 } });
    expect(debugApi.popInput()).toEqual({ events: 0, mouse: { x: -7, y: 2 } });
    attachPopInput(null);
    expect(debugApi.popInput()).toBeNull();
  });
});
