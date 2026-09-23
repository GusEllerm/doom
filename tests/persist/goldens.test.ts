/**
 * persist/goldens — M11-08 (M11-plan §M11-08 a/b/e): the L1 persistence
 * golden corpus. Artifact class = savegame BYTES (the §0.1 header + DBP1
 * payload the production path writes to the store), double-run
 * byte-equal, sha-pinned .bin blessed under tests/persist/goldens.
 *
 *  (a) capture→encode→decode→restore on the fixture corpus: THE MATRIX
 *      through the byte codec + store path (save@T → fresh world →
 *      reload-sim store → load → 300 tics == original T..T+300), per
 *      scenario — the byte golden scene carries the save bytes, the
 *      matrix assertions live alongside (same world ⇒ same fixture
 *      render function).
 *  (b) E1M1 mid-level golden payload+hash (iwad-gated).
 *  (e) zero-regression: the E1M1 5000-tic scripted sim hash (newly
 *      blessed) AND the EXISTING M8 2000-tic golden (4030522611,
 *      src/sim/game.test.ts) asserted in-suite with zero re-bless.
 *
 * Run:  npx vitest run tests/persist
 *       node scripts/goldens-update.mjs --set persist [--reason|--check]
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { runHeadless } from '../../src/sim/game';
import { decodeSave } from '../../src/persist/codec';
import type { RuntimeMap } from '../../src/sim/map';
import {
  byteGolden,
  corpusMap,
  drainAsync,
  hasWad,
  matrixRun,
  bootCorpus,
  bootE1M1,
  e1m1Map,
  resetM11,
  runIn,
  scenarioToSavePoint,
  SCENARIOS,
  sha256Of,
  walkIn,
  hashBytes
} from '../fixtures/m11Scenarios';

beforeEach(async () => {
  await drainAsync();
  resetM11();
});

/* ------------------------------------------------------------------ */
/* (a) corpus byte goldens + THE MATRIX through the bytes               */
/* ------------------------------------------------------------------ */

const corpusContInput = (i: number) => ({
  ...walkIn(i),
  turnRight: i % 7 === 3,
  attack: i % 40 < 2
});

describe('M11-08(a) fixture-corpus save bytes + matrix', () => {
  for (const sc of SCENARIOS) {
    if (sc.name === 'mover-started-at-save') continue; // FINDING M11-08-F1 below
    byteGolden({
      name: `m11-save-${sc.name}`,
      kind: 'fixture',
      script: `corpus '${sc.name}' → run to save point (${sc.setupTics}+setup+${sc.settleTics}) → gSaveGame → §0.3 chain → codec+store → saved BYTES; hashState at save point + continuation recorded in matrix assertions`,
      render: async () => {
        const result = await matrixRun({
          orig: scenarioToSavePoint(sc),
          bootFresh: bootCorpus,
          loader: corpusLoader,
          contInput: corpusContInput,
          driftTics: 10,
          slot: 4
        });
        // THE MATRIX: loaded world, same inputs ⇒ identical per-50-tic
        // continuation hashes (save@T → load → T..T+300).
        expect(result.back).toEqual(result.ref);
        expect(result.back[0]).not.toBe(result.hashAtSave); // the world moved
        return result.saveBytes;
      }
    });
  }

  // FINDING M11-08-F1 (SIM-side, see tests/persist/matrix.test.ts): the
  // VL.open continuation identity fails post-restore, but the SAVE BYTES
  // are deterministic (double-run byte-equal, sha-pinned) — this golden
  // commits BYTES only; the matrix half lives as the it.failing cell in
  // matrix.test.ts (promote both back when the sim fix lands).
  byteGolden({
    name: 'm11-save-mover-started-at-save',
    kind: 'fixture',
    script: "corpus 'mover-started-at-save' → run to save point (25+setup+0) → gSaveGame → §0.3 chain → codec+store → saved BYTES (FINDING M11-08-F1: continuation identity tracked as it.failing in matrix.test.ts)",
    render: async () => {
      const sc = SCENARIOS.find((s) => s.name === 'mover-started-at-save')!;
      const result = await matrixRun({
        orig: scenarioToSavePoint(sc),
        bootFresh: bootCorpus,
        loader: corpusLoader,
        contInput: corpusContInput,
        driftTics: 10,
        slot: 4
      });
      return result.saveBytes;
    }
  });
});

function corpusLoader(): RuntimeMap {
  return corpusMap();
}

/* ------------------------------------------------------------------ */
/* (a+) cross-map matrix cell: E1M1 save → fresh boot → E1M1 load       */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('M11-08(b) E1M1 mid-level', () => {
  byteGolden({
    name: 'm11-save-e1m1-midlevel',
    kind: 'iwad',
    script:
      'E1M1 gInitGame → 240 scripted tics (walk+turn+fire) → gSaveGame chain → codec+store → saved BYTES; matrix: fresh boot + reload-sim store → load → 300 tics == original',
    render: async () => {
      const a = bootE1M1();
      runIn(a, 240, (i) => ({
        ...walkIn(i),
        turnRight: i % 20 === 5,
        attack: i % 35 < 3
      }));
      const cont = (i: number) => ({
        ...walkIn(i),
        turnLeft: i % 25 === 4,
        attack: i % 50 < 2
      });
      const result = await matrixRun({
        orig: a,
        bootFresh: bootE1M1,
        loader: () => e1m1Map(),
        contInput: cont,
        driftTics: 10,
        reload: true,
        slot: 7
      });
      expect(result.back).toEqual(result.ref);
      expect(result.back[0]).not.toBe(result.hashAtSave);
      const dec = decodeSave(result.saveBytes);
      expect(dec.ok).toBe(true);
      if (dec.ok) {
        expect(dec.header.episode).toBe(1);
        expect(dec.header.map).toBe(1);
      }
      return result.saveBytes;
    }
  });
});

/* ------------------------------------------------------------------ */
/* (e) zero-regression: long scripted sim hashes                       */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('M11-08(e) zero-regression hashes', () => {
  byteGolden({
    name: 'm11-sim-e1m1-5000tic',
    kind: 'iwad',
    artifact: 'bin',
    script: 'E1M1 gInitGame → 5000 no-input tics → hashState (ASCII hex bytes); the save path never perturbs the sim',
    render: () => {
      const s = bootE1M1();
      return hashBytes(runHeadless(s, 5000)); // no-input (runHeadless default)
    }
  });

  it('existing M8 2000-tic E1M1 golden stays byte-equal (4030522611, zero re-bless)', () => {
    // Mirrors src/sim/game.test.ts’s M8 acceptance exactly: fresh boot +
    // 2000 NO-INPUT tics (runHeadless default emptyInput — NOT a walk).
    const s = bootE1M1();
    expect(runHeadless(s, 2000)).toBe(4030522611);
  });
});

/* ------------------------------------------------------------------ */
/* Payload-content sanity inside the goldens (payload section facts)   */
/* ------------------------------------------------------------------ */

describe('M11-08 payload facts (fixture, cheap in-suite asserts)', () => {
  it('save bytes decode to the §0.1 header mirroring the world', async () => {
    const a = scenarioToSavePoint(SCENARIOS[0]!);
    const result = await matrixRun({
      orig: a,
      bootFresh: bootCorpus,
      loader: corpusLoader,
      contInput: corpusContInput,
      driftTics: 0,
      slot: 0
    });
    const dec = decodeSave(result.saveBytes);
    if (!dec.ok) throw new Error('decode failed');
    // Header map/episode mirror the FIXMAP boot; leveltime = save point
    // + the 1-tic snapshot offset (§0.3 chain: gSaveGame at T ⇒ snapshot
    // world sits at T+1 — pSaveg.test.ts accounting).
    const t = SCENARIOS[0]!.setupTics + SCENARIOS[0]!.settleTics;
    expect(dec.header.episode).toBe(1);
    expect(dec.header.map).toBe(1);
    expect(dec.header.leveltime).toBe(t + 1);
    // decodeSave hands back header + payload slices of the file; the
    // payload is the whole file minus the §0.1 header (51 bytes).
    expect(dec.payload.length).toBe(result.saveBytes.length - 51);
    expect(sha256Of(result.saveBytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});
