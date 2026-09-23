// persist/idb.ts — M11-01: zero-dependency IndexedDB wrapper (M11-plan §M11-01, D-11g).
//
// The DB: name `doom`, version 1 (M11-plan §M11-01). Object stores:
//   * `saves`    — out-of-line keys: slot int 0..9 (savegamestrings array
//                  size, m_menu.c:132; the 1.10 MENU exposes SIX rows —
//                  load_end = 6, m_menu.c:451-460 — the array stays 10).
//   * `settings` — out-of-line string keys (the default.cfg variable set,
//                  §0.6; written by M11-07 on top of this store).
//
// Design rules honored here:
//   * Promise-based: every op returns a Promise; NO callbacks leak out.
//   * NO IDB access at import time (acceptance #3): the global `indexedDB`
//     is touched only inside openDb(), so importing this module is safe on
//     node/vitest (A-10: L1/L2 tests run headless).
//   * Absent/blocked IDB (node, Safari private mode, SecurityError, hard
//     quota on open) ⇒ graceful degradation: openDb() resolves to an
//     IN-MEMORY Map adapter with the SAME KvStore API and reports
//     backend 'memory' with a `reason` — never throws, never console.error.
//   * Version-migration path (acceptance #2): open always targets
//     DB_VERSION; `upgradeneeded` creates ANY store missing from the
//     existing schema (fresh create AND later version upgrades), via the
//     exported pure `ensureStores` (testable without a browser).
//   * Request failures surface as REJECTS with the DOMException (or a
//     synthesized Error) — classification into typed results is
//     store.ts's job; this layer never swallows or logs.
//
// Zone rule (A-06/D-11g): persist/ touches `indexedDB` (its whole point)
// and no other DOM API; sim imports NOTHING from this zone.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** Database name pinned by the plan (§M11-01). */
export const DB_NAME = 'doom';

/** Database version pinned by the plan (§M11-01). */
export const DB_VERSION = 1;

/** Object-store names of schema v1. */
export type StoreName = 'saves' | 'settings';

export const STORE_NAMES: readonly StoreName[] = ['saves', 'settings'];

/** Key domain: numeric slot ids (saves) or strings (settings). */
export type DbKey = string | number;

export interface KvEntry {
  key: DbKey;
  value: unknown;
}

/** The key-value surface every backend (real IDB / memory) implements. */
export interface KvStore {
  /** Resolves undefined for a missing key (mirrors IDB get miss). */
  get(key: DbKey): Promise<unknown | undefined>;
  put(key: DbKey, value: unknown): Promise<void>;
  remove(key: DbKey): Promise<void>;
  /** All entries, keys in IDB collation order (numbers, then strings). */
  all(): Promise<KvEntry[]>;
}

export type Backend = 'idb' | 'memory';

export interface DbHandle {
  readonly backend: Backend;
  /** Present on the memory backend only: why IDB was not usable. */
  readonly reason?: string;
  readonly saves: KvStore;
  readonly settings: KvStore;
  close(): void;
}

export interface OpenOptions {
  /** Inject a factory (tests / exotic embeds); default: global indexedDB. */
  factory?: IDBFactory | null;
  /** Force the in-memory adapter regardless of environment. */
  memory?: boolean;
}

/** True iff the global IndexedDB factory exists (never touches it). */
export function indexedDbAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function globalFactory(): IDBFactory | null {
  return indexedDbAvailable() ? indexedDB : null;
}

/**
 * Minimal structural view of an IDBDatabase during `upgradeneeded` — a
 * pure function so the migration path is unit-testable without a browser
 * (acceptance #2). Creates every store of the v1 schema that the existing
 * database lacks; returns the names it created.
 */
export interface MigratableDb {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string): unknown;
}

export function ensureStores(db: MigratableDb): string[] {
  const created: string[] = [];
  for (const name of STORE_NAMES) {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name); // out-of-line keys
      created.push(name);
    }
  }
  return created;
}

/** Open (or degrade from) the `doom` database. Never rejects. */
export async function openDb(options: OpenOptions = {}): Promise<DbHandle> {
  if (options.memory) return memoryHandle('forced-memory');
  const factory = options.factory !== undefined ? options.factory : globalFactory();
  if (!factory) return memoryHandle('no-indexeddb');
  try {
    const db = await openWithFactory(factory);
    return idbHandle(db);
  } catch {
    // Private mode / SecurityError / blocked open — degrade gracefully.
    return memoryHandle('idb-open-failed');
  }
}

function openWithFactory(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('indexeddb open threw'));
      return;
    }
    let settled = false;
    request.onupgradeneeded = () => {
      // Fresh create (empty schema) AND version upgrades both land here;
      // ensureStores brings every v1 store into existence (§M11-01).
      ensureStores(request.result);
    };
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(
        request.error instanceof Error
          ? request.error
          : new Error('indexeddb open failed')
      );
    };
  });
}

// ---------------------------------------------------------------------------
// Real IndexedDB backend
// ---------------------------------------------------------------------------

function idbHandle(db: IDBDatabase): DbHandle {
  return {
    backend: 'idb',
    saves: idbKv(db, 'saves'),
    settings: idbKv(db, 'settings'),
    close() {
      db.close();
    }
  };
}

/** One request round-trip: resolve on request success, reject with the error. */
function run<T>(
  db: IDBDatabase,
  store: StoreName,
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const succeed = () => {
      if (settled) return;
      settled = true;
      resolve(request.result as T);
    };
    const fail = (error: Error | null) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(`indexeddb ${store} op failed`));
    };
    let request: IDBRequest;
    try {
      const tx = db.transaction(store, mode);
      tx.onerror = () => fail(tx.error);
      tx.onabort = () => fail(tx.error);
      request = op(tx.objectStore(store));
    } catch (error) {
      fail(error instanceof Error ? error : new Error('indexeddb transaction failed'));
      return;
    }
    request.onsuccess = succeed;
    request.onerror = () => fail(request.error);
  });
}

function normalizeKey(key: IDBValidKey): DbKey {
  return typeof key === 'number' ? key : String(key);
}

function idbKv(db: IDBDatabase, name: StoreName): KvStore {
  return {
    get(key) {
      return run<unknown>(db, name, 'readonly', (store) => store.get(key));
    },
    put(key, value) {
      return run<IDBValidKey>(db, name, 'readwrite', (store) =>
        store.put(value, key)
      ).then(() => undefined);
    },
    remove(key) {
      return run<undefined>(db, name, 'readwrite', (store) => store.delete(key)).then(
        () => undefined
      );
    },
    async all() {
      const keys = await run<IDBValidKey[]>(db, name, 'readonly', (store) =>
        store.getAllKeys()
      );
      const values = await run<unknown[]>(db, name, 'readonly', (store) =>
        store.getAll()
      );
      return keys.map((key, index) => ({
        key: normalizeKey(key),
        value: values[index]
      }));
    }
  };
}

// ---------------------------------------------------------------------------
// In-memory adapter (node/vitest + the degraded-browser path)
// ---------------------------------------------------------------------------

function cloneValue<T>(value: T): T {
  // Mirror IDB structured-clone isolation: callers must never observe later
  // mutation through a reference that crossed the store boundary.
  return typeof structuredClone === 'function' && value !== undefined
    ? structuredClone(value)
    : value;
}

function compareDbKeys(a: DbKey, b: DbKey): number {
  if (typeof a === typeof b) return a < b ? -1 : a > b ? 1 : 0;
  return typeof a === 'number' ? -1 : 1; // IDB order: numbers, then strings
}

function memoryHandle(reason: string): DbHandle {
  const maps: Record<StoreName, Map<DbKey, unknown>> = {
    saves: new Map(),
    settings: new Map()
  };
  const kv = (name: StoreName): KvStore => {
    const map = maps[name];
    return {
      async get(key) {
        return map.has(key) ? cloneValue(map.get(key)) : undefined;
      },
      async put(key, value) {
        map.set(key, cloneValue(value));
      },
      async remove(key) {
        map.delete(key);
      },
      async all() {
        return [...map.keys()]
          .sort(compareDbKeys)
          .map((key) => ({ key, value: cloneValue(map.get(key)) }));
      }
    };
  };
  return {
    backend: 'memory',
    reason,
    saves: kv('saves'),
    settings: kv('settings'),
    close() {
      maps.saves.clear();
      maps.settings.clear();
    }
  };
}
