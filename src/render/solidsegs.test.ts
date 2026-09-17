// render/solidsegs tests (M3-03): solidsegs insert/merge vs vanilla
// r_bsp.c control flow + live HOM counters.
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import { MAXSEGS } from './solidsegs';

describe('solidsegs (M3-03 stub)', () => {
  it('exposes MAXSEGS 32 (r_bsp.c:88)', () => {
    expect(MAXSEGS).toBe(32);
  });
});
