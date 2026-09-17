/**
 * render/rdata tests (M3-plan §M3-02). STUB — cases in progress.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { loadRenderWorld } from './rdata';

describe('rdata stub', () => {
  it('throws while stubbed', () => {
    expect(() => loadRenderWorld({} as never, new Map())).toThrow();
  });
});
