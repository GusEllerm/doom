/**
 * persist/crossmap — M11-08 (M11-plan §M11-08 a/c/d + the cross-map
 * matrix cells): persistence proofs that cross a MAP boundary, the
 * save-timing sites, the episode-progress byte asserts, and the
 * load ⇒ RNG pins THROUGH the byte codec + store path.
 *
 * Chain accounting (pSaveg.test.ts 'in-game save→load'): gSaveGame at T
 * ⇒ pack tic ticks T→T+1, drain+capture at the NEXT boundary ⇒ the
 * SNAPSHOT world sits at T+1. A already ticked cont(1) in the drain tic;
 * B's load-drain gTicker is fed cont(1) — both stand at T+2 when their
 * identical futures stream cont(2), cont(3), …
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { GA, gSaveGame, gTicker } from '../../src/sim/game';
import { hashState, type GameState } from '../../src/sim/state';
import { pRandom } from '../../src/sim/prng';
import { attachPsprFields } from '../../src/sim/p_pspr';
import { initPlayerInventory } from '../../src/sim/p_inter_inventory';
import { CF_GODMODE, CF_NOCLIP } from '../../src/sim/player';
import { decodeSave, parsePayload } from '../../src/persist/codec';
import type { SaveSnapshot } from '../../src/sim/pSaveg';
import type { RuntimeMap } from '../../src/sim/map';
import { bindStore, createCaptureHandler, flushWrites } from '../../src/ui/menuSaveLoad';
import { registerCaptureSink } from '../../src/sim/hooks';
import type { PersistStore } from '../../src/persist/store';
import {
  bootCorpus,
  bootE1M1,
  corpusMap,
  e1m1Map,
  hasWad,
  loadThroughBytes,
  matrixRun,
  memStore,
  registerLoader,
  resetM11,
  reopenStore,
  rollMap,
  runIn,
  saveThroughBytes,
  sharedIdb,
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

/* ------------------------------------------------------------------ */
/* 1. Map-name roll: worlddone ⇒ save on the ROLLED map ⇒ load back     */
/* ------------------------------------------------------------------ */

const rollLoader: LoaderFn = (ep, map) => (ep === 1 && map === 2 ? rollMap() : corpusMap());

describe('M11-08 cross-map: the map-name roll', () => {
  it('worlddone roll ⇒ header byte 42 = rolled map; load lands on it; matrix holds', async () => {
    const { factory } = sharedIdb();
    const store = await reopenStore(factory);
    const a = bootCorpus();
    runIn(a, 30, walkIn);
    a.wminfo.next = 1; // G_DoCompleted routing (M9-07/08) lands next=1
    a.gameaction = GA.worlddone;
    registerLoader(rollLoader);
    gTicker(a, walkIn()); // G_DoWorldDone: gamemap = next + 1
    expect(a.gamemap).toBe(2);

    // Save ON the rolled map (chain rides cont(0)/cont(1)).
    const saveBytes = await saveThroughBytes(a, store, 2, 'rolled', cont);
    const dec = decodeSave(saveBytes);
    if (!dec.ok) throw new Error('decode failed');
    expect(dec.header.map).toBe(2); // §0.1 byte 42 rides the roll
    expect(dec.header.episode).toBe(1);

    // A's future.
    const ref: number[] = [];
    for (let k = 0; k < 6; k++) {
      runIn(a, 50, (i) => cont(2 + k * 50 + i));
      ref.push(hashState(a));
    }

    // B: fresh boot (map 1), reload-sim store, load ⇒ lands on map 2.
    resetM11();
    const b = bootCorpus();
    const seen = registerLoader(rollLoader);
    runIn(b, 10, walkIn); // drifted
    const storeB = await reopenStore(factory);
    await loadThroughBytes(b, storeB, 2);
    gTicker(b, cont(1));
    expect(seen.lastRequested()).toBe('1:2'); // loader asked for map 2
    expect(b.gamemap).toBe(2);
    const back: number[] = [];
    for (let k = 0; k < 6; k++) {
      runIn(b, 50, (i) => cont(2 + k * 50 + i));
      back.push(hashState(b));
    }
    expect(back).toEqual(ref);
    store.close();
    storeB.close();
  });

  it.skipIf(!hasWad)('E1M1 save → load into a world standing on map 2 lands back on E1M1', async () => {
    const a = bootE1M1();
    runIn(a, 120, (i) => ({ ...walkIn(i), turnRight: i % 20 === 5 }));
    const contE = (i: number) => ({ ...walkIn(i), turnLeft: i % 25 === 4 });
    const store = await memStore();
    const bytes = await saveThroughBytes(a, store, 3, 'e1m1', contE);
    const dec = decodeSave(bytes);
    if (!dec.ok) throw new Error('decode failed');
    expect(dec.header.map).toBe(1);

    const ref: number[] = [];
    for (let k = 0; k < 6; k++) {
      runIn(a, 50, (i) => contE(2 + k * 50 + i));
      ref.push(hashState(a));
    }

    // ---- B: a world whose CURRENT map is 2 gets the E1M1 save --------
    resetM11();
    const b = bootE1M1();
    b.gamemap = 2; // stand-in for a rolled/live world on E1M2
    registerLoader((ep, map) => (ep === 1 && map === 1 ? e1m1Map() : corpusMap()));
    await loadThroughBytes(b, store, 3);
    gTicker(b, contE(1)); // the load drain re-inits from the SNAPSHOT
    expect(b.gameepisode).toBe(1);
    expect(b.gamemap).toBe(1); // the snapshot's map wins, not the world's
    const back: number[] = [];
    for (let k = 0; k < 6; k++) {
      runIn(b, 50, (i) => contE(2 + k * 50 + i));
      back.push(hashState(b));
    }
    expect(back).toEqual(ref);
    store.close();
  });
});

/* ------------------------------------------------------------------ */
/* 2. Save-timing sites                                                */
/* ------------------------------------------------------------------ */

describe('M11-08 save-timing sites', () => {
  it('save armed at the intermission edge: drain still lands next tic; leveltime frozen at the snapshot', async () => {
    // The M9 intermission phase ticks OUTSIDE gTicker; the GS.INTERMISSION
    // gTicker branch does NOT tick the level — so a save whose two chain
    // tics ride with the gamestate staged away from LEVEL captures a
    // FROZEN world: header leveltime == the arming tic (no +1), and the
    // continuation aligns one tic EARLIER than the in-level pattern (the
    // load-drain tic IS the first future tic).
    const a = bootCorpus();
    runIn(a, 60, walkIn);
    const store = await memStore();
    bindStoreForSave(store);
    gSaveGame(5, 'pre-wi');
    a.gamestate = 1; // GS.INTERMISSION staged between arming and the chain…
    gTicker(a, walkIn()); // …pack tic (world frozen — but does the flag)…
    gTicker(a, walkIn()); // …drain+capture tic (still frozen)
    await flushWrites();
    a.gamestate = 0; // WI done, back to LEVEL
    const res = await store.loadGame(5);
    if (!res.ok) throw new Error('save did not land');
    const dec = decodeSave(res.value.bytes);
    if (!dec.ok) throw new Error('decode failed');
    expect(dec.header.leveltime).toBe(60);
    expect(dec.header.map).toBe(1);
    expect(a.leveltime).toBe(60); // world frozen during the two chain tics…
    expect(a.gamestate).toBe(0);

    // A's future starts NOW (world at 61); B's drain tic is future #1…
    const ref: number[] = [];
    for (let k = 0; k < 6; k++) {
      runIn(a, 50, (i) => cont(k * 50 + i));
      ref.push(hashState(a));
    }
    resetM11();
    const b = bootCorpus();
    registerLoader(corpusLoader);
    await loadThroughBytes(b, store, 5);
    gTicker(b, cont(0)); // restores the frozen snapshot, THEN ticks once
    const back: number[] = [];
    for (let k = 0; k < 6; k++) {
      runIn(b, 50, (i) => cont(1 + k * 50 + i));
      back.push(hashState(b));
    }
    expect(back).toEqual(ref);
    store.close();
  });

  it('saves at three distinct tics of ONE world-run (50/100/150) all matrix through the bytes', async () => {
    for (const T of [50, 100, 150]) {
      resetM11();
      const a = bootCorpus();
      runIn(a, T, walkIn);
      const result = await matrixRun({
        orig: a,
        bootFresh: bootCorpus,
        loader: corpusLoader,
        contInput: cont,
        driftTics: 10,
        slot: 1
      });
      expect(result.back, `save@${T}`).toEqual(result.ref);
      expect(result.back[0]).not.toBe(result.hashAtSave);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. (c) Episode-progress facts ride the BYTES                         */
/* ------------------------------------------------------------------ */

describe('M11-08(c) episode-progress facts through the payload', () => {
  it('kill/item/secret tallies + cheats assert in the payload JSON AND on the restored world', async () => {
    const a = bootCorpus();
    runIn(a, 30, walkIn);
    const p = initPlayerInventory(attachPsprFields(a.players[0]!));
    p.killcount = 7;
    p.itemcount = 2;
    p.secretcount = 1;
    p.cheats = CF_GODMODE | CF_NOCLIP;
    p.cards[0] = 1;
    p.cards[4] = 1;
    p.powers[0] = 30; // powers[0] = PowerInvulnerability (p_inter_pickup.c domain)
    a.totalkills = 11;
    a.totalitems = 4;
    a.totalsecret = 1;
    a.secretcount = 1;

    const store = await memStore();
    const bytes = await saveThroughBytes(a, store, 6, 'tally');

    // Payload face: the facts are ON the bytes (DBP1 JSON section).
    const dec = decodeSave(bytes);
    if (!dec.ok) throw new Error('decode failed');
    const pay = parsePayload(dec.payload);
    if (!pay.ok) throw new Error('payload failed');
    const json = JSON.parse(new TextDecoder().decode(pay.sections[0]!.bytes)) as SaveSnapshot;
    const jp = json.players[0]!;
    expect([jp.killcount, jp.itemcount, jp.secretcount, jp.cheats]).toEqual([
      7, 2, 1, CF_GODMODE | CF_NOCLIP
    ]);
    expect([jp.cards[0], jp.cards[4], jp.powers[0]]).toEqual([1, 1, 30]);
    expect([json.misc.totalkills, json.misc.totalitems, json.misc.totalsecret, json.misc.secretcount]).toEqual([
      11, 4, 1, 1
    ]);

    // Restored-world face (fresh world; the tallies rode the bytes).
    resetM11();
    const b = bootCorpus();
    registerLoader(corpusLoader);
    await loadThroughBytes(b, store, 6);
    gTicker(b, walkIn()); // drain + one tic (invuln rides down by 1)
    const pb = b.players[0]!;
    expect([pb.killcount, pb.itemcount, pb.secretcount, pb.cheats]).toEqual([
      7, 2, 1, CF_GODMODE | CF_NOCLIP
    ]);
    const inv = initPlayerInventory(attachPsprFields(pb));
    expect([inv.cards[0], inv.cards[4], inv.powers[0]]).toEqual([1, 1, 29]);
    expect([b.totalkills, b.totalitems, b.totalsecret, b.secretcount]).toEqual([11, 4, 1, 1]);
    store.close();
  });
});

/* ------------------------------------------------------------------ */
/* 4. (d) RNG pins THROUGH the bytes                                   */
/* ------------------------------------------------------------------ */

describe('M11-08(d) load ⇒ RNG pins at the byte level', () => {
  const stream = (s: GameState): number[] => {
    const out: number[] = [];
    for (let k = 0; k < 100; k++) out.push(pRandom(s.rng));
    return out;
  };

  it('fresh-boot save ⇒ restored stream ignores a 200-tic drifted world (bytes drive the reset stream)', async () => {
    const a = bootCorpus();
    const store = await memStore();
    const bytes = await saveThroughBytes(a, store, 8, 'rng0');
    const dec = decodeSave(bytes);
    if (!dec.ok) throw new Error('decode failed');
    const pay = parsePayload(dec.payload);
    if (!pay.ok) throw new Error('payload failed');
    const json = JSON.parse(new TextDecoder().decode(pay.sections[0]!.bytes)) as SaveSnapshot;

    // b DRIFTS 200 tics first: the load must wipe that stream.
    resetM11();
    const b = bootCorpus();
    registerLoader(corpusLoader);
    runIn(b, 200, walkIn);
    expect(b.rng.prndindex).toBeGreaterThan(0);
    await loadThroughBytes(b, store, 8);
    gTicker(b, walkIn()); // snapshot sits at boot+1 ⇒ b now at boot+2

    const d2 = bootCorpus(); // booted AFTER b finished ticking
    runIn(d2, 2, walkIn);
    expect(b.rng.rndindex).toBe(d2.rng.rndindex);
    expect(b.rng.prndindex).toBe(d2.rng.prndindex);
    expect(stream(b)).toEqual(stream(d2));
    // The payload carries the boot-stream pair an independent boot+1
    // world shows (§0.1: load ⇒ M_ClearRandom via the EXISTING gInitNew
    // site — the indices never leak from the replaced world).
    const d1 = bootCorpus();
    runIn(d1, 1, walkIn);
    expect(json.rng.rndindex).toBe(d1.rng.rndindex);
    expect(json.rng.prndindex).toBe(d1.rng.prndindex);
    store.close();
  });

  it('mid-run save ⇒ the bytes carry the stream; restored draws continue identically', async () => {
    const a = bootCorpus();
    runIn(a, 120, walkIn); // monster AI consumed P_Random
    const store = await memStore();
    const bytes = await saveThroughBytes(a, store, 9, 'rngmid');
    expect(bytes.length).toBeGreaterThan(51);

    resetM11();
    const b = bootCorpus();
    registerLoader(corpusLoader);
    gTicker(b, walkIn()); // b lived 1 tic (drift) — rng now nonzero
    await loadThroughBytes(b, store, 9);
    gTicker(b, walkIn()); // restore@121 + drain tic ⇒ b at 122
    const ref = bootCorpus(); // booted AFTER b ticked (world-bind rule)
    runIn(ref, 122, walkIn);
    expect(b.rng.rndindex).toBe(ref.rng.rndindex);
    expect(b.rng.prndindex).toBe(ref.rng.prndindex);
    expect(stream(b)).toEqual(stream(ref));
    store.close();
  });
});

/* helper: bind the store + production capture sink for a raw gSaveGame
 * chain (the same mount saveThroughBytes uses, minus its chain tics) */
function bindStoreForSave(store: PersistStore): void {
  bindStore(store);
  const handler = createCaptureHandler(store);
  registerCaptureSink((e) => handler(e));
}
