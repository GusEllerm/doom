// persist/idb.test.ts — M11-01 acceptance 1..3 for the IDB wrapper.
// Runs on node (vitest environment: node): the real code paths of the
// IndexedDB backend are exercised through an injected FakeIDBFactory (the
// `factory` option), so the wrapper itself — not just the memory adapter —
// is covered headless (A-10). The browser-side real-IndexedDB roundtrip is
// the M11-11 e2e (playwright), per the plan's verify line for this task.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import {
  DB_NAME,
  DB_VERSION,
  STORE_NAMES,
  ensureStores,
  indexedDbAvailable,
  openDb,
  type DbKey
} from './idb';

// ---------------------------------------------------------------------------
// Minimal IndexedDB fake (open/upgradeneeded/transaction/get/put/delete/
// getAll/getAllKeys, Map-backed, optional forced request error).
// ---------------------------------------------------------------------------

interface FakeDbOptions {
  /** Store names that already exist before the open (migration scenario). */
  existingStores?: string[];
  /** open() throws synchronously (legacy Safari private mode). */
  openThrows?: boolean;
  /** open() request fires onerror (blocked/SecurityError class). */
  openFails?: boolean;
  /** Fire onupgradeneeded even for an unchanged schema (forced v bump). */
  fireUpgrade?: boolean;
  /** Next transaction() throws (per-op failure). */
  txFails?: boolean;
  /** Name forced onto every request error (e.g. QuotaExceededError). */
  requestErrorName?: string;
}

class FakeRequest {
  result: unknown = undefined;
  error: Error | null = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
}

class FakeObjectStore {
  constructor(
    private readonly map: Map<DbKey, unknown>,
    private readonly owner: FakeDb
  ) {}

  get(key: DbKey): FakeRequest {
    return this.req(this.map.has(key) ? this.map.get(key) : undefined);
  }

  put(value: unknown, key: DbKey): FakeRequest {
    if (this.owner.failNext) return this.failReq();
    this.map.set(key, value);
    return this.req(key);
  }

  delete(key: DbKey): FakeRequest {
    this.map.delete(key);
    return this.req(undefined);
  }

  getAllKeys(): FakeRequest {
    return this.req([...this.map.keys()].sort(compare));
  }

  getAll(): FakeRequest {
    return this.req([...this.map.keys()].sort(compare).map((k) => this.map.get(k)));
  }

  private req(result: unknown): FakeRequest {
    const request = new FakeRequest();
    request.result = result;
    queueMicrotask(() => request.onsuccess?.());
    return request;
  }

  private failReq(): FakeRequest {
    const request = new FakeRequest();
    request.error = namedError(this.owner.requestErrorName ?? 'UnknownError');
    queueMicrotask(() => request.onerror?.());
    return request;
  }
}

function compare(a: DbKey, b: DbKey): number {
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  return typeof a === 'number' ? -1 : 1;
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

class FakeDb {
  readonly stores = new Map<string, Map<DbKey, unknown>>();
  failNext = false;
  requestErrorName?: string;
  txFails = false;
  created: string[] = [];

  constructor(options: FakeDbOptions) {
    for (const name of options.existingStores ?? []) this.stores.set(name, new Map());
    this.requestErrorName = options.requestErrorName;
    this.txFails = options.txFails ?? false;
  }

  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name)
  };

  createObjectStore(name: string): unknown {
    this.stores.set(name, new Map());
    this.created.push(name);
    return { name };
  }

  transaction(storeName: string): { objectStore: (name: string) => FakeObjectStore } {
    if (this.txFails) throw namedError('TransactionInactiveError');
    const map = this.stores.get(storeName);
    if (!map) throw namedError('NotFoundError');
    const store = new FakeObjectStore(map, this);
    return { objectStore: () => store };
  }
}

function fakeFactory(db: FakeDb | null, options: FakeDbOptions): IDBFactory {
  const factory = {
    open(name: string, version?: number): FakeRequest {
      expect(name).toBe(DB_NAME);
      expect(version).toBe(DB_VERSION);
      const request = new FakeRequest();
      queueMicrotask(() => {
        if (options.openFails) {
          request.error = namedError('SecurityError');
          request.onerror?.();
          return;
        }
        if (db) {
          if (options.fireUpgrade !== false) {
            request.result = db;
            request.onupgradeneeded?.();
          }
          request.result = db;
          request.onsuccess?.();
        } else {
          request.error = namedError('UnknownError');
          request.onerror?.();
        }
      });
      return request;
    }
  };
  return factory as unknown as IDBFactory;
}

function throwFactory(): IDBFactory {
  return {
    open() {
      throw namedError('SecurityError');
    }
  } as unknown as IDBFactory;
}

// ---------------------------------------------------------------------------

describe('import safety on node (acceptance #3)', () => {
  it('module import touches no IDB global; availability reports false', () => {
    expect(typeof (globalThis as Record<string, unknown>).indexedDB).toBe('undefined');
    expect(indexedDbAvailable()).toBe(false);
  });

  it('schema constants match the plan (db doom, version 1, two stores)', () => {
    expect(DB_NAME).toBe('doom');
    expect(DB_VERSION).toBe(1);
    expect([...STORE_NAMES]).toEqual(['saves', 'settings']);
  });
});

describe('graceful degradation (no real IDB — private mode / node)', () => {
  it('no factory in the environment ⇒ memory backend, reason no-indexeddb', async () => {
    const handle = await openDb();
    expect(handle.backend).toBe('memory');
    expect(handle.reason).toBe('no-indexeddb');
  });

  it('open() throwing synchronously (private mode) ⇒ memory fallback', async () => {
    const handle = await openDb({ factory: throwFactory() });
    expect(handle.backend).toBe('memory');
    expect(handle.reason).toBe('idb-open-failed');
  });

  it('open request erroring (blocked/SecurityError) ⇒ memory fallback', async () => {
    const handle = await openDb({ factory: fakeFactory(null, { openFails: true }) });
    expect(handle.backend).toBe('memory');
    expect(handle.reason).toBe('idb-open-failed');
  });

  it('memory adapter round-trips with structured-clone isolation', async () => {
    const handle = await openDb({ memory: true });
    const bytes = new Uint8Array([1, 2, 3]);
    await handle.saves.put(4, { bytes });
    bytes[0] = 99; // post-put mutation must NOT leak into the store
    const got = (await handle.saves.get(4)) as { bytes: Uint8Array };
    expect([...got.bytes]).toEqual([1, 2, 3]);
    expect(await handle.saves.get(7)).toBeUndefined();
    expect((await handle.saves.all()).map((e) => e.key)).toEqual([4]);
    await handle.saves.remove(4);
    expect(await handle.saves.get(4)).toBeUndefined();
  });
});

describe('version migration path (acceptance #2, ensureStores)', () => {
  it('creates BOTH stores on a fresh (empty) database', () => {
    const db = new FakeDb({});
    expect(ensureStores(db)).toEqual(['saves', 'settings']);
    expect(db.created).toEqual(['saves', 'settings']);
  });

  it('creates ONLY the missing store when upgrading an old schema', () => {
    const db = new FakeDb({ existingStores: ['saves'] });
    expect(ensureStores(db)).toEqual(['settings']);
    expect(db.created).toEqual(['settings']);
  });

  it('creates nothing when the schema is already current', () => {
    const db = new FakeDb({ existingStores: ['saves', 'settings'] });
    expect(ensureStores(db)).toEqual([]);
    expect(db.created).toEqual([]);
  });

  it('openDb runs the migration through upgradeneeded', async () => {
    const db = new FakeDb({ existingStores: ['saves'] }); // v0-style db
    const handle = await openDb({ factory: fakeFactory(db, {}) });
    expect(handle.backend).toBe('idb');
    expect(db.created).toEqual(['settings']);
  });

  it('forced upgrade on a current schema is a no-op', async () => {
    const db = new FakeDb({ existingStores: ['saves', 'settings'] });
    const handle = await openDb({ factory: fakeFactory(db, { fireUpgrade: true }) });
    expect(handle.backend).toBe('idb');
    expect(db.created).toEqual([]);
  });
});

describe('real-backend code paths through the fake (idb handle)', () => {
  it('put/get/all/remove round-trip on both stores', async () => {
    const db = new FakeDb({});
    await openDb({ factory: fakeFactory(db, {}) }).then(async (handle) => {
      expect(handle.backend).toBe('idb');
      await handle.saves.put(1, { v: 'a' });
      await handle.saves.put(0, { v: 'b' });
      expect(await handle.saves.get(1)).toEqual({ v: 'a' });
      expect(await handle.saves.get(9)).toBeUndefined();
      expect((await handle.saves.all()).map((e) => e.key)).toEqual([0, 1]); // IDB order
      await handle.settings.put('detaillevel', 1);
      expect(await handle.settings.get('detaillevel')).toBe(1);
      await handle.settings.remove('detaillevel');
      expect(await handle.settings.get('detaillevel')).toBeUndefined();
    });
  });

  it('request failure rejects with the typed error (store.ts classifies)', async () => {
    const db = new FakeDb({ requestErrorName: 'QuotaExceededError' });
    const handle = await openDb({ factory: fakeFactory(db, {}) });
    db.failNext = true;
    await expect(handle.saves.put(0, 'x')).rejects.toMatchObject({
      name: 'QuotaExceededError'
    });
  });

  it('transaction construction failure rejects too', async () => {
    const db = new FakeDb({ txFails: true });
    const handle = await openDb({ factory: fakeFactory(db, {}) });
    await expect(handle.saves.get(0)).rejects.toBeInstanceOf(Error);
  });
});
