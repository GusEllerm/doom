import { describe, it, expect } from 'vitest';
import { CODEC_STUB } from './codec';
describe('persist/codec', () => {
  it('stub exists', () => { expect(CODEC_STUB).toBe(true); });
});
