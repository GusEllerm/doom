/**
 * M1-06 tests — flat decoder.
 *
 * Facts pinned by R02 §6: flats are raw 4096-byte (64x64, row-major, first
 * byte top-left) lumps; freedoom1.wad's flat lumps all have size 4096.
 * Real-IWAD goldens auto-skip when wads/freedoom1.wad is absent.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { synthFlat } from '../../tests/fixtures/smallWads';
import { decodeFlat, FlatDecodeError, FLAT_BYTES } from './flat';
import { WadFile } from './wadfile';

describe('decodeFlat', () => {
  it('decodes exactly 4096 raw bytes, identity, row-major', () => {
    const bytes = synthFlat();
    const flat = decodeFlat(bytes, 'FIXFLAT');
    expect(flat.name).toBe('FIXFLAT');
    expect(flat.pixels.length).toBe(FLAT_BYTES);
    expect(flat.pixels).toEqual(bytes); // raw passthrough, no transpose
  });

  it('copies the pixels (never aliases a zero-copy WadFile subarray)', () => {
    const bytes = synthFlat(0xabcd); // deterministic seed: bytes[0] is non-zero
    const flat = decodeFlat(bytes, 'F');
    expect(flat.pixels[0]).not.toBe(0); // guard: seed must produce a visible byte
    bytes[0] = 0;
    expect(flat.pixels[0]).not.toBe(0);
  });

  it('rejects any size other than 4096 with a typed error', () => {
    for (const size of [0, 4095, 4097, 8192]) {
      expect(() => decodeFlat(new Uint8Array(size), 'BAD')).toThrowError(FlatDecodeError);
    }
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad golden (auto-skip when absent)                        */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad flat golden', () => {
  it('FLAT1 decodes to the committed 4096-byte content', () => {
    const wad = WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    expect(wad.readLumpByName('FLAT1').length).toBe(FLAT_BYTES); // R02 §6: size 4096
    const flat = decodeFlat(wad.readLumpByName('FLAT1'), 'FLAT1');
    // Recorded 2026-07 from wads/freedoom1.wad (v0.13.0, pinned in
    // scripts/freedoom/release.json).
    expect(createHash('sha256').update(flat.pixels).digest('hex')).toBe(
      '8f74e1657c89996882ce2a3bee0e1d266658dfd49e97f38fc9603fa220163dd7',
    );
  });
});
