/**
 * Headless loop harness tests (M2-06) — ARCHITECTURE §7 layer 2: boot the
 * sim in Node on real/fixture maps, script tic streams, assert hashes.
 *
 *  - manual G_Ticker loop ≡ runHeadless (the harness is not a second engine);
 *  - 1000-tic scripted determinism golden (fixture map, in src/sim/game
 *    .test.ts) re-checked here end-to-end on freedoom1 E1M1 when present;
 *  - one 35-tic second of held right-turn = exactly 6 slow + 29 normal
 *    angleturn tics → exact BAM delta.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame, gTicker, runHeadless } from '../../src/sim/game';
import { hashState } from '../../src/sim/state';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';

/* ------------------------------------------------------------------ */
/* Manual loop == harness                                              */
/* ------------------------------------------------------------------ */

const FIX_SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }]
};

function fixtureBytes(): Uint8Array {
  return buildFixtureMapWad(FIX_SPEC);
}

function buildState(bytes: Uint8Array, name = 'FIXMAP') {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), name)));
}

const fixState = () => buildState(fixtureBytes());

const turnRight: GameInput = { ...emptyInput(), turnRight: true };

describe('headless harness equivalence', () => {
  it('manual 200-tic gTicker loop hashes identically to runHeadless', () => {
    const a = fixState();
    const b = fixState();
    for (let i = 0; i < 200; i++) gTicker(a, i % 3 === 0 ? turnRight : emptyInput());
    const h = runHeadless(b, 200, (g) => (g % 3 === 0 ? turnRight : emptyInput()));
    expect(h).toBe(hashState(a));
  });

  it('one second (35 tics) of held right-turn is the exact BAM sum', () => {
    const s = fixState();
    const h = runHeadless(s, 35, () => turnRight);
    // tics 1-5 at 320, tics 6-35 at 640 (turnheld ramp), right = negative.
    const expected = (-(5 * (320 << 16)) - (30 * (640 << 16))) >>> 0;
    expect(s.players[0]!.mo.angle).toBe(expected);
    expect(h).toBe(hashState(s));
    expect(s.leveltime).toBe(35);
    expect(s.gametic).toBe(35);
  });

  it('runHeadless(0 tics) returns the pristine hash (no-advance identity)', () => {
    const s = fixState();
    expect(runHeadless(s, 0)).toBe(hashState(s));
    expect(s.leveltime).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad E1M1 (auto-skip when absent)                          */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 sim loop', () => {
  function e1m1State() {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
  }

  it('spawns at the E1M1 start and is deterministic over 1000 scripted tics', () => {
    const a = e1m1State();
    const b = e1m1State();
    // E1M1 player 1 start (-416, 256) angle 0 — pinned in src/sim/map.test.ts
    expect(a.players[0]!.mo.x).toBe(-416 << 16);
    expect(a.players[0]!.mo.y).toBe(256 << 16);

    const input: (g: number) => GameInput = (g) =>
      g % 5 < 2 ? { ...emptyInput(), forward: true } : turnRight;
    const h1 = runHeadless(a, 1000, input);
    const h2 = runHeadless(b, 1000, input);
    expect(h1).toBe(h2);
    // Golden recorded 2026-07 from this implementation on freedoom1.wad
    // (pinned release, scripts/freedoom).
    // RE-BLESSED M5-06 (one-time, reason: 'M5-06: p_user physics replaces
    // D009 fly stub') — real thrust/friction/onground/z instead of the
    // angle-only stub movement.
    // RE-BLESSED M6-01 (one-time, reason: 'M6 world-state fields') — the
    // 333-sector E1M1 SoA + run globals + empty arena extend hashState;
    // value 1134251855 → 3285949243 from the added bytes alone.
    expect(h1).toBe(3285949243);
  });
});
