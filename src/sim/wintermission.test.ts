import { describe, it, expect } from 'vitest';
import { WI_STUB } from './wintermission';

describe('wintermission stub', () => {
  it('loads', () => expect(WI_STUB).toBe(true));
});
