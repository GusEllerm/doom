/**
 * persist/matrix — M11-08 (task §M11-08-3): THE matrix.
 *
 * For EVERY scenario of the pSaveg corpus (tests/fixtures
 * /m11Scenarios.SCENARIOS — the pSaveg.test.ts worlds extended with two
 * continuation-shape members): run to the save point → save THROUGH THE
 * BYTE PATH (gSaveGame chain → captureSink → menuSaveLoad
 * createCaptureHandler → DBP1 JSON payload → §0.1 codec → store.put) →
 * boot a FRESH world (10 drifted tics, then the load wipes it) → load
 * (store.get → decode → gRequestLoadGame → next-tic G_DoLoadGame) →
 * run 300 tics ⇒ per-50-tic hashState stream byte-equal to the original
 * run's T..T+300. Plus one reload-sim cell (store reopened over the same
 * bytes = the page reload) and the RNG-reset pin at the drain boundary.
 *
 * Same ordering rule as pSaveg.test.ts: a reference world finishes
 * before a loaded world boots (module world binds = last-setup-wins).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { hashState } from '../../src/sim/state';
import { gTicker } from '../../src/sim/game';
import { decodeSave } from '../../src/persist/codec';
import {
  bootCorpus,
  corpusMap,
  loadThroughBytes,
  matrixRun,
  memStore,
  resetM11,
  runIn,
  scenarioToSavePoint,
  SCENARIOS,
  walkIn,
  type LoaderFn
} from '../fixtures/m11Scenarios';

beforeEach(() => resetM11());

const cont = (i: number) => ({
  ...walkIn(i),
  turnRight: i % 7 === 3,
  attack: i % 40 < 2
});

const corpusLoader: LoaderFn = () => corpusMap();

describe('M11-08 matrix: save@T → bytes → fresh world → load → T..T+300', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.name}: 300-tic continuation identity through the byte codec + store`, async () => {
      const result = await matrixRun({
        orig: scenarioToSavePoint(sc),
        bootFresh: bootCorpus,
        loader: corpusLoader,
        contInput: sc.name === 'turnfire-continuation' ? (i) => ({
          ...walkIn(i),
          turnRight: i % 3 === 0
        }) : cont,
        driftTics: 10,
        slot: 4
      });
      expect(result.back, `${sc.name} continuation hashes`).toEqual(result.ref);
      expect(result.back[0]).not.toBe(result.hashAtSave); // the world moved
      expect(result.saveBytes.length).toBeGreaterThan(51);
    });
  }
});

describe('M11-08 reload-sim cell: fresh store over the SAME bytes (page reload)', () => {
  it('mid-door-move saves, RELOADS the store, loads, and matches the reference 300 tics', async () => {
    const sc = SCENARIOS[0]!;
    const result = await matrixRun({
      orig: scenarioToSavePoint(sc),
      bootFresh: bootCorpus,
      loader: corpusLoader,
      contInput: cont,
      driftTics: 10,
      reload: true,
      slot: 7
    });
    expect(result.back).toEqual(result.ref);
    const dec = decodeSave(result.saveBytes);
    expect(dec.ok).toBe(true);
    if (dec.ok) expect(dec.header.leveltime).toBe(sc.setupTics + sc.settleTics + 1);
  });
});

describe('M11-08 drain-boundary pins', () => {
  it('load arms without touching the world; the drain tic restores AND ticks in order', async () => {
    // A: save at 60 (chain to 62, snapshot at 61).
    const a = bootCorpus();
    runIn(a, 60, walkIn);
    const result = await matrixRun({
      orig: a,
      bootFresh: bootCorpus,
      loader: corpusLoader,
      contInput: walkIn,
      driftTics: 0,
      slot: 3
    });
    // Reference-free identity of the two 300-tic streams is the matrix
    // cell itself; here pin the DRAIN SHAPE instead: a fresh world 10
    // tics into its own life, load-armed, is UNCHANGED until the drain
    // tic (the load is a gameaction, not an event — §0.3).
    const b = bootCorpus();
    runIn(b, 10, walkIn);
    const drifted = hashState(b);
    const store = await memStore();
    // reuse A's bytes: rewrite them into this store at slot 6.
    const { saveBytes } = result;
    await store.saveGame(6, saveBytes, {
      description: 'shape',
      gameInfo: { skill: 2, episode: 1, map: 1, leveltime: 61 }
    });
    await loadThroughBytes(b, store, 6);
    expect(hashState(b)).toBe(drifted); // armed only — nothing moved yet
    gTicker(b, walkIn()); // the drain: G_InitNew + restoreWorld + the tic
    const c = bootCorpus();
    runIn(c, 62, walkIn); // A stands at 62 ⇒ identical
    expect(hashState(b)).toBe(hashState(c));
    store.close();
  });
});
