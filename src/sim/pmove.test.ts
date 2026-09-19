/**
 * sim/pmove tests (M5-05) — P_XYMovement + P_ZMovement (p_mobj.c movement).
 * Stub placeholder; acceptance vectors land in the implementation commit.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { FRICTION, GRAVITY, MAXMOVE, STOPSPEED } from './pmove';
import { FRACUNIT } from '../core/constants';

describe('pmove constants', () => {
  it('pinned to the 1.10 sources', () => {
    expect(MAXMOVE).toBe(30 * FRACUNIT); // p_local.h:54
    expect(GRAVITY).toBe(FRACUNIT); // p_local.h:53
    expect(STOPSPEED).toBe(0x1000); // p_mobj.c:111
    expect(FRICTION).toBe(0xe800); // p_mobj.c:112
  });
});
