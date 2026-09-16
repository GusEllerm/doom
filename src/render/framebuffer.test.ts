/** Stub test (M2-09). SPDX-License-Identifier: GPL-2.0-or-later */
import { describe, expect, it } from 'vitest';
import { RENDER_WIDTH } from './framebuffer';

describe('framebuffer stub', () => {
  it('has width', () => {
    expect(RENDER_WIDTH).toBe(320);
  });
});
