/**
 * persist/corrupt — M11-08 (task §M11-08-5): the corrupt/truncated save
 * battery AT THE STORE LEVEL. Every codec error path must surface as a
 * UI-VISIBLE failure (a typed Result / a tagged slot row / a counted
 * load-rejected ledger entry), NEVER a throw across an async boundary
 * and NEVER a console.error (store.ts’s acceptance ladder, extended to
 * the byte layer). The vanilla truth lanes mirrored: bad version ⇒
 * SILENT return (g_game.c:1214-1217); bad marker ⇒ I_Error("Bad
 * savegame") (:1240-1241) — the port’s typed record instead (D-11b).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONSISTANCY_MARKER,
  HEADER_SIZE,
  SAVEGAMESIZE,
  VERSION_STRING,
  buildPayload,
  decodeSave,
  describeFailure,
  encodeSave,
  parsePayload,
  type SaveHeader
} from '../../src/persist/codec';
import { EMPTY_SLOT_TEXT, openStore, type PersistStore } from '../../src/persist/store';
import { captureLog, resetCaptureLog, setPendingLoad } from '../../src/sim/hooks';
import { GA, gTicker, resetGameFlow, saveFlow } from '../../src/sim/game';
import { hashState } from '../../src/sim/state';
import { bootCorpus, resetM11, walkIn, runIn } from '../fixtures/m11Scenarios';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const header: SaveHeader = {
  description: 'battery',
  skill: 2,
  episode: 1,
  map: 1,
  playeringame: [1, 0, 0, 0],
  leveltime: 123
};

function goodBytes(payload = buildPayload([{ id: 0, bytes: new TextEncoder().encode('{}') }])): Uint8Array {
  const enc = encodeSave(header, payload);
  if (!enc.ok) throw new Error(`encode failed: ${describeFailure(enc.failure)}`);
  return enc.bytes;
}

/** A store over a shared fake-IDB with the raw saves map exposed for
 * corruption writes. */
async function storeWithMap(): Promise<{
  store: PersistStore;
  saves: Map<string | number, unknown>;
}> {
  const maps = new Map<string, Map<string | number, unknown>>([
    ['saves', new Map()],
    ['settings', new Map()]
  ]);
  const db = {
    objectStoreNames: { contains: (name: string) => maps.has(name) },
    createObjectStore: (name: string) => {
      maps.set(name, new Map());
      return {};
    },
    transaction(name: string) {
      const map = maps.get(name)!;
      const req = <T,>(value: T) => {
        const r = { result: value, onsuccess: null as unknown };
        queueMicrotask(() => (r.onsuccess as ((e: { target: typeof r }) => void) | undefined)?.({ target: r }));
        return r;
      };
      return {
        objectStore: () => ({
          get: (key: string | number) => req(map.has(key) ? map.get(key) : undefined),
          put: (value: unknown, key: string | number) => {
            map.set(key, value);
            return req(key);
          },
          delete: (key: string | number) => {
            map.delete(key);
            return req(undefined);
          },
          getAllKeys: () => req([...map.keys()]),
          getAll: () => req([...map.values()])
        })
      };
    },
    close() {}
  };
  const factory = {
    open(_n: string, _v?: number) {
      const r: Record<string, unknown> = {};
      queueMicrotask(() => {
        r.result = db;
        (r.onupgradeneeded as ((e: { target: typeof r }) => void) | undefined)?.({ target: r });
        (r.onsuccess as ((e: { target: typeof r }) => void) | undefined)?.({ target: r });
      });
      return r;
    }
  } as unknown as IDBFactory;
  const store = await openStore({ factory });
  return { store, saves: maps.get('saves')! };
}

/* ------------------------------------------------------------------ */
/* A. Codec error paths — typed results, never throws                  */
/* ------------------------------------------------------------------ */

describe('battery A — codec typed failures (never throws)', () => {
  it('bad header fields are typed badField results', () => {
    const bads: Array<[Partial<SaveHeader>, string]> = [
      [{ skill: 5 }, 'skill'],
      [{ skill: -1 }, 'skill'],
      [{ episode: 0 }, 'episode'],
      [{ episode: 5 }, 'episode'],
      [{ map: 0 }, 'map'],
      [{ map: 36 }, 'map'],
      [{ leveltime: 0x1000000 }, 'leveltime'],
      [{ playeringame: [1, 2, 0, 0] as SaveHeader['playeringame'] }, 'playeringame[i]'],
      [{ description: 'x'.repeat(23) }, 'description']
    ];
    for (const [patch, field] of bads) {
      const r = encodeSave({ ...header, ...patch }, new Uint8Array(0));
      expect(r.ok, JSON.stringify(patch)).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe('badField');
      if (!r.ok && r.failure.kind === 'badField') expect(r.failure.field).toContain(field);
    }
  });

  it('oversized payload ⇒ bufferOverrun (SAVEGAMESIZE ladder)', () => {
    const r = encodeSave(header, new Uint8Array(SAVEGAMESIZE - HEADER_SIZE + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('bufferOverrun');
    expect(describeFailure({ kind: 'bufferOverrun', length: 99, limit: 1 })).toContain('overrun');
  });

  it('truncated input (any length < 51) ⇒ typed truncated', () => {
    const full = goodBytes();
    for (const len of [0, 1, 24, 50]) {
      const r = decodeSave(full.subarray(0, len));
      expect(r.ok, `len ${len}`).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe('truncated');
    }
    // and the empty/shortest possible buffers never throw:
    expect(decodeSave(new Uint8Array()).ok).toBe(false);
  });

  it('version field tampering ⇒ typed badVersion (vanilla silent-return lane)', () => {
    const tampered = goodBytes();
    for (const [i, c] of [...'version 111'].entries()) tampered[24 + i] = c.charCodeAt(0);
    const r = decodeSave(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'badVersion') expect(r.failure.found).toBe('version 111');
    // A 41-char-zero field decodes as '' — also badVersion, never a throw.
    const blank = goodBytes();
    blank.fill(0, 24, 40);
    expect(decodeSave(blank).ok).toBe(false);
    // The header really is the 16B NUL-padded "version 110":
    expect(new TextDecoder().decode(goodBytes().subarray(24, 35))).toBe(VERSION_STRING);
  });

  it('tail byte != 0x1d ⇒ typed badMarker (the vanilla I_Error lane, ported)', () => {
    const tampered = goodBytes();
    tampered[tampered.length - 1] = 0x00;
    const r = decodeSave(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === 'badMarker') expect(r.failure.found).toBe(0x00);
    expect(goodBytes()[goodBytes().length - 1]).toBe(CONSISTANCY_MARKER);
  });

  it('payload container corruption ⇒ typed payload failures', () => {
    // bad magic
    const badMagic = buildPayload([{ id: 0, bytes: new Uint8Array(1) }]);
    badMagic.set([0x44, 0x42, 0x50, 0x00], 0);
    expect(parsePayload(badMagic).ok).toBe(false);
    // bad container version
    const bv = buildPayload([{ id: 0, bytes: new Uint8Array(1) }], 99);
    const r2 = parsePayload(bv);
    expect(r2.ok).toBe(false);
    if (!r2.ok && r2.failure.kind === 'badPayloadVersion') expect(r2.failure.found).toBe(99);
    // truncated container (header cut)
    expect(parsePayload(badMagic.subarray(0, 4)).ok).toBe(false);
    // section length lying about the remainder (mid-section truncation)
    const full = buildPayload([{ id: 3, bytes: new Uint8Array(64) }]);
    const cut = full.subarray(0, full.length - 20); // section bytes lost
    const r3 = parsePayload(cut);
    expect(r3.ok, 'truncated section bytes').toBe(false);
    // forged huge length ⇒ badSection (never an OOM read, never a throw)
    const forged = buildPayload([{ id: 7, bytes: new Uint8Array(4) }]);
    new DataView(forged.buffer, forged.byteOffset, forged.byteLength).setUint32(9, 0xffffffff, true);
    const r4 = parsePayload(forged);
    expect(r4.ok).toBe(false);
    if (!r4.ok && r4.failure.kind === 'badSection') expect(r4.failure.id).toBe(7);
  });

  it('describeFailure names every lane', () => {
    expect(describeFailure({ kind: 'truncated', needed: 51, have: 10 })).toContain('truncated');
    expect(describeFailure({ kind: 'badVersion', found: 'x' })).toContain('version');
    expect(describeFailure({ kind: 'badMarker', found: 0xff })).toContain('0xff');
    expect(describeFailure({ kind: 'badField', field: 'skill', value: 9 })).toContain('skill');
  });
});

/* ------------------------------------------------------------------ */
/* B. Store-level corruption: typed, listed, console-clean             */
/* ------------------------------------------------------------------ */

describe('battery B — store-level corrupt records', () => {
  it('empty slots: load typed empty-slot; rows list EMPTYSTRING', async () => {
    const { store } = await storeWithMap();
    const r = await store.loadGame(3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('empty-slot');
    const rows = await store.listSaves();
    expect(rows).toHaveLength(10);
    expect(rows[3]!.empty).toBe(true);
    expect(rows[3]!.description).toBe(EMPTY_SLOT_TEXT);
    expect(rows[3]!.gameInfo).toBeNull();
    expect(await store.listRecentSaves()).toEqual([]);
    const d = await store.deleteSave(3);
    expect(d.ok && d.value.deleted).toBe(false);
    store.close();
  });

  it('invalid slot indexes are typed on all three verbs', async () => {
    const { store } = await storeWithMap();
    for (const slot of [-1, 10, 1.5, Number.NaN]) {
      for (const res of [
        await store.saveGame(slot, goodBytes(), { description: 'x', gameInfo: header }),
        await store.loadGame(slot),
        await store.deleteSave(slot)
      ]) {
        expect(res.ok, `slot ${slot}`).toBe(false);
        if (!res.ok) expect(res.error.code).toBe('invalid-slot');
      }
    }
    store.close();
  });

  it('junk records fail the shape check as corrupt-record (five junk shapes)', async () => {
    const { store, saves } = await storeWithMap();
    const junks: unknown[] = [
      null,
      'not a record',
      { description: 'no bytes', mtime: 1, gameInfo: header, version: { dbVersion: 1, codecVersion: 1 } },
      { bytes: 'string not u8', description: 'x', mtime: 1, gameInfo: header, version: { dbVersion: 1, codecVersion: 1 } },
      { bytes: goodBytes(), description: 'x', mtime: Number.NaN, gameInfo: header, version: { dbVersion: 1, codecVersion: 1 } },
      { bytes: goodBytes(), description: 'x', mtime: 1, gameInfo: { skill: 'two' }, version: { dbVersion: 1, codecVersion: 1 } },
      { bytes: goodBytes(), description: 'x', mtime: 1, gameInfo: header }
    ];
    for (const [i, junk] of junks.entries()) {
      saves.set(2, structuredCloneish(junk));
      const r = await store.loadGame(2);
      expect(r.ok, `junk ${i}`).toBe(false);
      if (!r.ok) expect(r.error.code, `junk ${i}`).toBe('corrupt-record');
      const rows = await store.listSaves();
      expect(rows[2]!.empty, `junk ${i} lists empty`).toBe(true);
    }
    store.close();
  });

  it('valid record + corrupt BYTES: store succeeds, decode surfaces typed at the load', async () => {
    const { store, saves } = await storeWithMap();
    // store-level: the record is VALID (bytes pass the shape check)…
    const cut = goodBytes().subarray(0, 30); // truncated FILE inside a valid record
    await store.saveGame(1, cut, { description: 'cut', gameInfo: header });
    const res = await store.loadGame(1);
    expect(res.ok).toBe(true);
    // …the BYTE layer is where the failure becomes visible.
    if (res.ok) expect(decodeSave(res.value.bytes).ok).toBe(false);
    // listSaves still shows the row (descriptions come from the record,
    // the payload is never decoded — M_ReadSaveStrings never reads it).
    const rows = await store.listSaves();
    expect(rows[1]!.empty).toBe(false);
    expect(rows[1]!.description).toBe('cut');
    saves.clear();
    store.close();
  });

  it('backend failure (quota) ⇒ typed quota-exceeded, never a rejection', async () => {
    const failReq = () => {
      const err = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
      const req: {
        error: unknown;
        onsuccess: unknown;
        onerror: ((e: { target: typeof req }) => void) | null;
      } = { error: err, onsuccess: null, onerror: null };
      queueMicrotask(() => req.onerror?.({ target: req }));
      return req;
    };
    const quotaFactory = {
      open(_n: string, _v?: number) {
        const r: Record<string, unknown> = {};
        queueMicrotask(() => {
          r.result = {
            objectStoreNames: { contains: () => true },
            transaction() {
              return {
                objectStore: () => ({
                  put: () => failReq(),
                  get: () => failReq()
                })
              };
            },
            close() {}
          };
          (r.onsuccess as ((e: { target: typeof r }) => void) | undefined)?.({ target: r });
        });
        return r;
      }
    } as unknown as IDBFactory;
    const store = await openStore({ factory: quotaFactory });
    const save = await store.saveGame(0, goodBytes(), { description: 'q', gameInfo: header });
    expect(save.ok).toBe(false);
    if (!save.ok) expect(save.error.code).toBe('quota-exceeded');
    const load = await store.loadGame(0);
    expect(load.ok).toBe(false);
    if (!load.ok) expect(load.error.code).toBe('io-failure');
    store.close();
  });

  it('the whole battery ran console-clean (acceptance: typed, never console.error)', () => {
    // registered first so it sees ONLY this file’s output; every async
    // above already settled (each awaited).
    expect(spy.results.length).toBe(0);
  });
});

function structuredCloneish<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : v;
}

/* ------------------------------------------------------------------ */
/* C. Game-layer silent lanes                                          */
/* ------------------------------------------------------------------ */

describe('battery C — load-rejected lanes are silent (vanilla bad-version)', () => {
  beforeEach(() => {
    resetM11();
    resetCaptureLog();
    setPendingLoad(null);
    resetGameFlow();
  });

  it('a format-2 snapshot drains as a typed load-rejected record; the world ticks a PLAIN tic', () => {
    const s = bootCorpus();
    runIn(s, 10, walkIn);
    const a = hashState(s);
    s.gameaction = GA.loadgame;
    setPendingLoad({ format: 2 });
    gTicker(s, walkIn());
    expect(s.gameaction).toBe(GA.nothing);
    expect(saveFlow.loadsDone).toBe(0);
    expect(captureLog.entries[0]!.kind).toBe('load-rejected');
    const c = bootCorpus();
    runIn(c, 10, walkIn);
    expect(a).toBe(hashState(c)); // pre-load world was a plain 10-tic run
    gTicker(c, walkIn());
    expect(hashState(s)).toBe(hashState(c)); // exactly one plain tic moved it
  });

  it('an empty pendingLoad drains as a counted stub, never a crash', () => {
    const s = bootCorpus();
    s.gameaction = GA.loadgame;
    expect(() => gTicker(s, walkIn())).not.toThrow();
    expect(s.gameaction).toBe(GA.nothing);
  });
});

/* console spy registered at IMPORT time for this file */
const spy = vi.spyOn(console, 'error');
vi.spyOn(console, 'warn');
