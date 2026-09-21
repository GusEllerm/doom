import { describe, it, expect } from 'vitest';
import { WIDRAW_STUB } from './wiDraw';

describe('wiDraw stub', () => {
  it('loads', () => expect(WIDRAW_STUB).toBe(true));
});
