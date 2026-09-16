/** Stub test (M2-09). SPDX-License-Identifier: GPL-2.0-or-later */
import { describe, expect, it } from 'vitest';
import { drawAutomapStub } from './automap';

describe('automap stub', () => {
  it('is callable', () => {
    expect(() => drawAutomapStub()).not.toThrow();
  });
});
