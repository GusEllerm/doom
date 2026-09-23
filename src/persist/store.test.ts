// persist/store.test.ts — M11-01 acceptance #1 (in-memory adapter full
// behavior: put/get/list/delete, mtime ordering, EMPTYSTRING holes) plus
// the typed failure paths (invalid slot, quota, corrupt record) and the
// settings merge. Node-side per A-10; real-browser IDB rides M11-11's e2e.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { DB_VERSION } from './idb';
import {
  CODEC_VERSION,
  EMPTY_SLOT_TEXT,
  SAVE_SLOT_COUNT,
  openStore,
  type SaveGameInfo,
  type PersistStore
} from './store';

const INFO: SaveGameInfo = { skill: 2, episode: 1, map: 3, leveltime: 1234 };

function bytes(...v: number[]): Uint8Array {
  return new Uint8Array(v);
}

function memoryStore(): Promise<PersistStore> {
  return openStore({ memory: true });
}

/** Thin working fake (both stores present) + forced put errors. */
function fakeIdbStore(errorName?: string): Promise<{ store: PersistStore; arm: () => void }> {
  const maps = new Map<string, Map<string | number, unknown>>([
    ['saves', new Map()],
    ['settings', new Map()]
  ]);
  let failNextPut = false;
  const db = {
    objectStoreNames: { contains: (name: string) => maps.has(name) },
    createObjectStore: (name: string) => maps.set(name, new Map()),
    transaction(name: string) {
      const map = maps.get(name);
      if (!map) throw new Error('NotFoundError');
      return {
        objectStore: () => ({
          get: (key: string | number) => req(map.has(key) ? map.get(key) : undefined),
          put: (value: unknown, key: string | number) => {
            if (failNextPut) return failReq(errorName ?? 'UnknownError');
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
    }
  };
  function req(result: unknown) {
    const request: Record<string, unknown> = { result };
    queueMicrotask(() => (request.onsuccess as (() => void) | null)?.());
    return request;
  }
  function failReq(name: string) {
    const error = new Error(name);
    error.name = name;
    const request: Record<string, unknown> = { error };
    queueMicrotask(() => (request.onerror as (() => void) | null)?.());
    return request;
  }
  const factory = { open: () => req(db) } as unknown as IDBFactory;
  return openStore({ factory }).then((store) => ({
    store,
    arm: () => {
      failNextPut = true;
    }
  }));
}

describe('constants (plan §M11-01 / §0.4)', () => {
  it('10-slot array, EMPTYSTRING face, version stamps', () => {
    expect(SAVE_SLOT_COUNT).toBe(10);
    expect(EMPTY_SLOT_TEXT).toBe('empty slot'); // d_englsh.h:75
    expect(CODEC_VERSION).toBe(1);
  });
});

describe('memory fallback store — full behavior (acceptance #1)', () => {
  it('reports backend memory with a reason', async () => {
    const store = await memoryStore();
    expect(store.backend).toBe('memory');
    expect(store.status().reason).toBe('forced-memory');
  });

  it('saveGame→loadGame round-trip carries bytes + meta + version stamp', async () => {
    const store = await memoryStore();
    const put = await store.saveGame(3, bytes(0xde, 0xad), {
      description: 'E1M3 corridor',
      gameInfo: INFO,
      mtime: 1000
    });
    expect(put.ok).toBe(true);
    const got = await store.loadGame(3);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const record = got.value;
    expect([...record.bytes]).toEqual([0xde, 0xad]);
    expect(record.description).toBe('E1M3 corridor');
    expect(record.gameInfo).toEqual(INFO);
    expect(record.mtime).toBe(1000);
    expect(record.version).toEqual({ dbVersion: DB_VERSION, codecVersion: CODEC_VERSION });
  });

  it('loadGame of a hole is a typed empty-slot result (never throws)', async () => {
    const store = await memoryStore();
    const got = await store.loadGame(5);
    expect(got).toMatchObject({ ok: false, error: { code: 'empty-slot' } });
  });

  it('overwrite of a slot keeps ONE record with the latest mtime', async () => {
    const store = await memoryStore();
    await store.saveGame(1, bytes(1), { description: 'old', gameInfo: INFO, mtime: 10 });
    await store.saveGame(1, bytes(2), { description: 'new', gameInfo: INFO, mtime: 20 });
    const got = await store.loadGame(1);
    expect(got.ok && [...got.value.bytes]).toEqual([2]);
    const rows = await store.listSaves();
    expect(rows.filter((r) => r.slot === 1)).toHaveLength(1);
    expect(rows[1]?.mtime).toBe(20);
  });

  it('deleteSave removes, and reports deleted:false on a hole', async () => {
    const store = await memoryStore();
    await store.saveGame(2, bytes(7), { description: 'x', gameInfo: INFO });
    const del = await store.deleteSave(2);
    expect(del).toEqual({ ok: true, value: { deleted: true } });
    expect((await store.loadGame(2)).ok).toBe(false);
    const again = await store.deleteSave(2);
    expect(again).toEqual({ ok: true, value: { deleted: false } });
  });

  it('listSaves returns all 10 SLOT-ordered rows; holes = EMPTYSTRING', async () => {
    const store = await memoryStore();
    await store.saveGame(7, bytes(1), { description: 'seven', gameInfo: INFO, mtime: 5 });
    await store.saveGame(0, bytes(2), { description: 'zero', gameInfo: INFO, mtime: 9 });
    const rows = await store.listSaves();
    expect(rows).toHaveLength(SAVE_SLOT_COUNT);
    expect(rows.map((r) => r.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rows[0]).toMatchObject({ empty: false, description: 'zero', mtime: 9 });
    expect(rows[7]).toMatchObject({ empty: false, description: 'seven', gameInfo: INFO });
    for (const row of rows) {
      if (row.slot !== 0 && row.slot !== 7) {
        expect(row).toEqual({
          slot: row.slot,
          empty: true,
          description: EMPTY_SLOT_TEXT,
          gameInfo: null,
          mtime: null
        });
      }
    }
  });

  it('listRecentSaves sorts filled rows by mtime DESC (newest first)', async () => {
    const store = await memoryStore();
    await store.saveGame(0, bytes(1), { description: 'a', gameInfo: INFO, mtime: 100 });
    await store.saveGame(4, bytes(2), { description: 'b', gameInfo: INFO, mtime: 300 });
    await store.saveGame(9, bytes(3), { description: 'c', gameInfo: INFO, mtime: 200 });
    const rows = await store.listRecentSaves();
    expect(rows.map((r) => r.slot)).toEqual([4, 9, 0]);
    expect(rows.every((r) => !r.empty)).toBe(true);
  });

  it('invalid slot indices are typed invalid-slot results, nothing stored', async () => {
    const store = await memoryStore();
    for (const slot of [-1, 10, 1.5, Number.NaN]) {
      const put = await store.saveGame(slot, bytes(0), {
        description: 'nope',
        gameInfo: INFO
      });
      expect(put).toMatchObject({ ok: false, error: { code: 'invalid-slot' } });
      const load = await store.loadGame(slot);
      expect(load).toMatchObject({ ok: false, error: { code: 'invalid-slot' } });
      expect(await store.deleteSave(slot).then((r) => !r.ok)).toBe(true);
    }
    expect((await store.listRecentSaves()).length).toBe(0);
  });

  it('settings: merge across putSettings calls; fresh store = {}', async () => {
    const store = await memoryStore();
    const fresh = await store.getSettings();
    expect(fresh).toEqual({ ok: true, value: {} });
    const first = await store.putSettings({ mouse_sensitivity: 5, key_fire: 77 });
    expect(first.ok && first.value).toEqual({ mouse_sensitivity: 5, key_fire: 77 });
    const second = await store.putSettings({ mouse_sensitivity: 8 });
    expect(second.ok && second.value).toEqual({ mouse_sensitivity: 8, key_fire: 77 });
    const read = await store.getSettings();
    expect(read.ok && read.value).toEqual({ mouse_sensitivity: 8, key_fire: 77 });
  });

  it('no structured-clone leak: mutating the caller bytes after save is invisible', async () => {
    const store = await memoryStore();
    const b = bytes(1, 2, 3);
    await store.saveGame(6, b, { description: 'd', gameInfo: INFO });
    b[0] = 255;
    const got = await store.loadGame(6);
    expect(got.ok && [...got.value.bytes]).toEqual([1, 2, 3]);
  });
});

describe('typed failure paths on an idb-shaped backend', () => {
  it('QuotaExceededError surfaces as code quota-exceeded (never throws)', async () => {
    const { store, arm } = await fakeIdbStore('QuotaExceededError');
    expect(store.backend).toBe('idb');
    arm();
    const put = await store.saveGame(0, bytes(1), { description: 'd', gameInfo: INFO });
    expect(put).toMatchObject({ ok: false, error: { code: 'quota-exceeded' } });
  });

  it('other backend errors surface as code io-failure', async () => {
    const { store, arm } = await fakeIdbStore('UnknownError');
    arm();
    const put = await store.saveGame(0, bytes(1), { description: 'd', gameInfo: INFO });
    expect(put).toMatchObject({ ok: false, error: { code: 'io-failure' } });
  });

  it('a stored value failing the record shape is corrupt-record, not a throw', async () => {
    const { store } = await fakeIdbStore();
    // Plant a raw non-conforming value at slot 2 through the same KvStore
    // semantics (Map-backed fake db), then probe via the public API.
    const raw = await openStoreRaw({
      saves: new Map<string | number, unknown>([[2, { hax: true }]])
    });
    const got = await raw.loadGame(2);
    expect(got).toMatchObject({ ok: false, error: { code: 'corrupt-record' } });
    const list = await raw.listSaves();
    expect(list[2]).toMatchObject({ empty: true, description: EMPTY_SLOT_TEXT });
    expect(store.backend).toBe('idb');
  });
});

/** Open a store over a pre-seeded Map-shaped KvStore (corrupt-record probe). */
async function openStoreRaw(seeded: {
  saves: Map<string | number, unknown>;
}): Promise<PersistStore> {
  const maps = new Map<string, Map<string | number, unknown>>([
    ['saves', seeded.saves],
    ['settings', new Map()]
  ]);
  const db = {
    objectStoreNames: { contains: (name: string) => maps.has(name) },
    createObjectStore: (name: string) => maps.set(name, new Map()),
    transaction(name: string) {
      const map = maps.get(name);
      if (!map) throw new Error('NotFoundError');
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
    }
  };
  function req(result: unknown) {
    const request: Record<string, unknown> = { result };
    queueMicrotask(() => (request.onsuccess as (() => void) | null)?.());
    return request;
  }
  const factory = { open: () => req(db) } as unknown as IDBFactory;
  return openStore({ factory });
}
