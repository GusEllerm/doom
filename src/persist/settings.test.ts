// persist/settings.test.ts — M11-07 stub smoke; battery follows.
import { describe, expect, it } from 'vitest';

import { SETTINGS_SCHEMA_VERSION } from './settings';

describe('settings stub', () => {
  it('exports the schema version', () => {
    expect(SETTINGS_SCHEMA_VERSION).toBe(1);
  });
});
