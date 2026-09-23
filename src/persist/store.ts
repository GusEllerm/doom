// persist/store.ts — M11-01: typed save/settings store over the IDB zone
// (M11-plan §M11-01). The ONLY API the rest of the port uses for
// persistence; nothing below ever throws across the async boundary for
// EXPECTED failures (empty slot, bad slot index, quota, corrupt record) —
// those come back as typed results (acceptance: "quota/error paths surface
// as typed results, never console.error").
//
// Record shape (plan §M11-01):
//   { bytes: Uint8Array,            // opaque payload (codec is M11-02's)
//     description: string,          // the 24B vanilla field's text face
//     gameInfo: {skill, ep, map, leveltime}, // meta DUPLICATES the header
//                                          fields so M_ReadSaveStrings
//                                          (m_menu.c:511-536) never
//                                          decodes a payload
//     mtime: number,                // ms epoch — write time
//     version: {dbVersion, codecVersion} }   // the plan's version stamp
//
// Slot semantics (§0.4): the array is 10 (savegamestrings[10][24],
// m_menu.c:132); the 1.10 menu EXPOSES six. Holes list as EMPTYSTRING
// "empty slot" (d_englsh.h:75) — never undefined rows.
//
// Degradation (plan §M11-01 / A-10): when IndexedDB is absent or blocked
// (node/vitest, private mode, open SecurityError), the whole store keeps
// FULL behavior on the in-memory adapter from idb.ts — reads, writes,
// listing, deletion, settings merge — with `backend: 'memory'` reported.
// Save/load across a page reload obviously only holds for backend 'idb';
// tests and degraded sessions get a session-persistent store instead.
//
// Zone rule (A-06/D-11g): imports ./idb only; sim imports NOTHING here.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  DB_VERSION,
  openDb,
  type Backend,
  type DbHandle,
  type KvStore,
  type OpenOptions
} from './idb';

/** Save array size — savegamestrings[10][24] (m_menu.c:132, §0.4). */
export const SAVE_SLOT_COUNT = 10;

/** EMPTYSTRING, d_englsh.h:75 — the listing face of a hole (§0.4). */
export const EMPTY_SLOT_TEXT = 'empty slot';

/** Payload-container version (M11-02's DBP1 codec starts at 1). */
export const CODEC_VERSION = 1;

export const SAVE_STORE: 'saves' = 'saves';
export const SETTINGS_STORE: 'settings' = 'settings';

/** Header-field mirror (§0.1 offsets 40/41/42 + 47..49). */
export interface SaveGameInfo {
  skill: number;
  episode: number;
  map: number;
  leveltime: number;
}

/** What a caller supplies to saveGame (mtime defaults to write time). */
export interface SaveMeta {
  description: string;
  gameInfo: SaveGameInfo;
  mtime?: number;
}

export interface SaveRecordVersion {
  dbVersion: number;
  codecVersion: number;
}

/** The stored record (plan §M11-01 record shape). */
export interface SaveRecord {
  bytes: Uint8Array;
  description: string;
  gameInfo: SaveGameInfo;
  mtime: number;
  version: SaveRecordVersion;
}

/** One row of a slot listing. Holes are rows too — EMPTY_SLOT_TEXT. */
export interface SaveRow {
  slot: number;
  empty: boolean;
  description: string;
  gameInfo: SaveGameInfo | null;
  /** null on holes; otherwise the write time (listRecentSaves sorts on it). */
  mtime: number | null;
}

export type PersistErrorCode =
  | 'empty-slot' // hole; not a failure — loadGame of a never-saved slot
  | 'invalid-slot' // non-integer or outside 0..SAVE_SLOT_COUNT-1
  | 'quota-exceeded' // QuotaExceededError from the backend
  | 'io-failure' // any other backend failure (incl. degraded edge cases)
  | 'corrupt-record'; // stored value fails the record shape check

export interface PersistError {
  code: PersistErrorCode;
  message: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: PersistError };

export interface DeleteOutcome {
  deleted: boolean;
}

export interface StoreStatus {
  backend: Backend;
  /** Why the memory backend is in use (undefined on real IDB). */
  reason?: string;
}

export interface PersistStore {
  readonly backend: Backend;
  status(): StoreStatus;
  saveGame(slot: number, bytes: Uint8Array, meta: SaveMeta): Promise<Result<SaveRecord>>;
  loadGame(slot: number): Promise<Result<SaveRecord>>;
  /** All SAVE_SLOT_COUNT rows in SLOT order (menu rows consume this). */
  listSaves(): Promise<SaveRow[]>;
  /** Non-empty rows only, NEWEST mtime first (the "recent saves" face). */
  listRecentSaves(): Promise<SaveRow[]>;
  deleteSave(slot: number): Promise<Result<DeleteOutcome>>;
  getSettings(): Promise<Result<Record<string, unknown>>>;
  /** Merge-write; resolves the merged snapshot (vanilla write-on-quit ≡
   *  write-on-change per D-11b; consumers are M11-07's). */
  putSettings(patch: Record<string, unknown>): Promise<Result<Record<string, unknown>>>;
  close(): void;
}

/** Open the persistence store (idb where available, memory otherwise). */
export async function openStore(options: OpenOptions = {}): Promise<PersistStore> {
  const handle: DbHandle = await openDb(options);
  return buildStore(handle);
}

function buildStore(handle: DbHandle): PersistStore {
  const saves = handle.saves;
  const settings = handle.settings;

  const status = (): StoreStatus => ({ backend: handle.backend, reason: handle.reason });

  async function readRows(): Promise<Map<number, SaveRecord>> {
    const bySlot = new Map<number, SaveRecord>();
    for (const entry of await saves.all()) {
      const slot = typeof entry.key === 'number' ? entry.key : Number(entry.key);
      const record = asSaveRecord(entry.value);
      if (Number.isInteger(slot) && record) bySlot.set(slot, record);
    }
    return bySlot;
  }

  const store: PersistStore = {
    backend: handle.backend,
    status,

    async saveGame(slot, bytes, meta) {
      if (!isSlot(slot)) return invalidSlot(slot);
      const record: SaveRecord = {
        bytes,
        description: meta.description,
        gameInfo: { ...meta.gameInfo },
        mtime: typeof meta.mtime === 'number' ? meta.mtime : now(),
        version: { dbVersion: DB_VERSION, codecVersion: CODEC_VERSION }
      };
      try {
        await saves.put(slot, record);
        return { ok: true, value: record };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async loadGame(slot) {
      if (!isSlot(slot)) return invalidSlot(slot);
      let value: unknown;
      try {
        value = await saves.get(slot);
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
      if (value === undefined) {
        return {
          ok: false,
          error: { code: 'empty-slot', message: `save slot ${slot} is empty` }
        };
      }
      const record = asSaveRecord(value);
      if (!record) {
        return {
          ok: false,
          error: { code: 'corrupt-record', message: `save slot ${slot} failed validation` }
        };
      }
      return { ok: true, value: record };
    },

    async listSaves() {
      const bySlot = await rowsOrEmpty(readRows);
      const rows: SaveRow[] = [];
      for (let slot = 0; slot < SAVE_SLOT_COUNT; slot += 1) {
        const record = bySlot.get(slot);
        rows.push(
          record
            ? {
                slot,
                empty: false,
                description: record.description,
                gameInfo: record.gameInfo,
                mtime: record.mtime
              }
            : { slot, empty: true, description: EMPTY_SLOT_TEXT, gameInfo: null, mtime: null }
        );
      }
      return rows;
    },

    async listRecentSaves() {
      const bySlot = await rowsOrEmpty(readRows);
      return [...bySlot.entries()]
        .map(([slot, record]) => ({
          slot,
          empty: false,
          description: record.description,
          gameInfo: record.gameInfo,
          mtime: record.mtime
        }))
        .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || a.slot - b.slot);
    },

    async deleteSave(slot) {
      if (!isSlot(slot)) return invalidSlot(slot);
      try {
        const existed = (await saves.get(slot)) !== undefined;
        if (existed) await saves.remove(slot);
        return { ok: true, value: { deleted: existed } };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async getSettings() {
      try {
        const snapshot: Record<string, unknown> = {};
        for (const entry of await settings.all()) {
          snapshot[String(entry.key)] = entry.value;
        }
        return { ok: true, value: snapshot };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async putSettings(patch) {
      const current = await store.getSettings();
      if (!current.ok) return current;
      try {
        for (const [key, value] of Object.entries(patch)) {
          await settings.put(key, value);
        }
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
      return { ok: true, value: { ...current.value, ...patch } };
    },

    close() {
      handle.close();
    }
  };
  return store;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now();
}

function isSlot(slot: number): boolean {
  return Number.isInteger(slot) && slot >= 0 && slot < SAVE_SLOT_COUNT;
}

function invalidSlot(slot: number): Result<never> {
  return {
    ok: false,
    error: {
      code: 'invalid-slot',
      message: `slot ${slot} is not an integer in 0..${SAVE_SLOT_COUNT - 1}`
    }
  };
}

/** Backend exception -> typed code (NEVER console.*; acceptance). */
function classify(error: unknown): PersistError {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : '';
  if (name === 'QuotaExceededError' || name === 'QuotaExceededDOMException') {
    return { code: 'quota-exceeded', message: 'storage quota exceeded' };
  }
  return {
    code: 'io-failure',
    message: error instanceof Error ? error.message : 'storage operation failed'
  };
}

function asSaveRecord(value: unknown): SaveRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (!(v.bytes instanceof Uint8Array)) return null;
  if (typeof v.description !== 'string') return null;
  if (typeof v.mtime !== 'number' || !Number.isFinite(v.mtime)) return null;
  const info = v.gameInfo as Record<string, unknown> | undefined;
  if (
    !info ||
    typeof info.skill !== 'number' ||
    typeof info.episode !== 'number' ||
    typeof info.map !== 'number' ||
    typeof info.leveltime !== 'number'
  ) {
    return null;
  }
  const version = v.version as Record<string, unknown> | undefined;
  if (
    !version ||
    typeof version.dbVersion !== 'number' ||
    typeof version.codecVersion !== 'number'
  ) {
    return null;
  }
  return {
    bytes: v.bytes,
    description: v.description,
    gameInfo: {
      skill: info.skill,
      episode: info.episode,
      map: info.map,
      leveltime: info.leveltime
    },
    mtime: v.mtime,
    version: { dbVersion: version.dbVersion, codecVersion: version.codecVersion }
  };
}

/** Listing reads must never reject across the API — degrade to no rows. */
async function rowsOrEmpty(
  read: () => Promise<Map<number, SaveRecord>>
): Promise<Map<number, SaveRecord>> {
  try {
    return await read();
  } catch {
    return new Map();
  }
}

export type { KvStore };
