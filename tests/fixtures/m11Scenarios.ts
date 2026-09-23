/**
 * fixtures/m11Scenarios — M11-08 (M11-plan §M11-08): the shared corpus +
 * harness for the persistence golden corpus. Everything the tests under
 * tests/persist need lives here:
 *
 *  - the pSaveg scenario corpus RE-EXPORTED as data (the eight fixture-map
 *    scenarios of pSaveg.test.ts, so the byte-path matrix runs THE SAME
 *    worlds THROUGH the codec+store instead of in-memory snapshots);
 *  - fixture/E1M1 boot helpers + a levelLoader registry (map-name roll);
 *  - the PRODUCTION byte path: `saveThroughBytes` = gSaveGame → the
 *    two-stage deferral → hooks.captureSink = menuSaveLoad
 *    createCaptureHandler (JSON snapshot → DBP1 payload → §0.1 header
 *    codec) → store.saveGame; `loadThroughBytes` = store.loadGame →
 *    menuSaveLoad loadSlot (decode → gRequestLoadGame) — NOTHING
 *    hand-rolls a codec call, the tests ride the shipped seams;
 *  - THE MATRIX (`matrixScenario`): save@T → fresh world (drifted) →
 *    load → 300 tics == original T..T+300, asserted per-50;
 *  - the goldens plumbing (audio-class artifact: savegame BYTES,
 *    double-run byte-equal + sha-pinned bin), mirroring
 *    tests/fixtures/m10Scenarios.audioGolden.
 *
 * Ordering rule inherited from pSaveg.test.ts: module-level world binds
 * are last-setup-wins — two worlds NEVER tick interleaved. Every matrix
 * finishes world A completely BEFORE world B boots.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { WadFile } from '../../src/wad/wadfile';
import { loadMap } from '../../src/wad/mapdata';
import { buildMapFromData, type RuntimeMap } from '../../src/sim/map';
import {
  GA,
  gInitGame,
  gSaveGame,
  gTicker,
  registerGameFlowHooks,
  resetFlowStubHits,
  resetGameFlow,
  resetSaveFlow,
  saveFlow,
  flowStubHits
} from '../../src/sim/game';
import { hashState, type GameState } from '../../src/sim/state';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import type { SaveSnapshot } from '../../src/sim/pSaveg';
import {
  captureLog,
  registerCaptureSink,
  resetCaptureLog,
  resetGameactionLog,
  resetSfxStubLog,
  setPendingLoad
} from '../../src/sim/hooks';
import { pRemoveMobj, pSpawnMobj, type Mobj } from '../../src/sim/p_mobj';
import { pKillMobj } from '../../src/sim/p_inter_damage';
import { evDoCeiling } from '../../src/sim/pceilng';
import { evDoDoor } from '../../src/sim/pdoors';
import { evDoPlat } from '../../src/sim/pplats';
import { resetPlatFlatCopies } from '../../src/sim/pplats';
import { CEIL, PLAT, VL } from '../../src/sim/specials-table';
import { CF_GODMODE, CF_NOCLIP } from '../../src/sim/player';
import { attachPsprFields, WP_NOCHANGE } from '../../src/sim/p_pspr';
import { initPlayerInventory } from '../../src/sim/p_inter_inventory';
import { openStore, type PersistStore } from '../../src/persist/store';
import {
  bindStore,
  createCaptureHandler,
  flushWrites,
  loadSlot,
  resetSaveLoad
} from '../../src/ui/menuSaveLoad';
import { buildFixtureMapWad, type RectMapSpec } from './mapBuilder';

/* ------------------------------------------------------------------ */
/* wad discovery                                                       */
/* ------------------------------------------------------------------ */

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

export const WAD_PATH = findWad();
export const hasWad = WAD_PATH !== undefined;

let wadSingleton: WadFile | undefined;
export function iwad(): WadFile {
  if (wadSingleton === undefined) {
    if (WAD_PATH === undefined) throw new Error('no IWAD discovered');
    const bytes = readFileSync(WAD_PATH);
    wadSingleton = WadFile.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    );
  }
  return wadSingleton;
}

export function iwadSha256(): string {
  if (WAD_PATH === undefined) throw new Error('no IWAD discovered');
  return sha256Of(readFileSync(WAD_PATH));
}

/* ------------------------------------------------------------------ */
/* Fixture maps                                                        */
/* ------------------------------------------------------------------ */

/** The pSaveg.test.ts corpus map (identical SPEC — same worlds). */
export const CORPUS_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // 0: player start
    { x: 256, y: 0, w: 256, h: 256, tag: 1 }, // 1: mover target
    { x: 512, y: 0, w: 256, h: 256, special: 17 }, // 2: fireflicker
    { x: 0, y: 256, w: 256, h: 256, special: 2 }, // 3: strobe (spawn draw)
    { x: 256, y: 256, w: 256, h: 256, special: 9 }, // 4: secret count
    { x: 512, y: 256, w: 256, h: 256, special: 1 } // 5: lightflash (draw)
  ],
  triggers: [{ x1: 256, y1: 64, x2: 256, y2: 192, tag: 1 }],
  things: [
    { x: 64, y: 128, angle: 0, type: 1 },
    { x: 150, y: 60, type: 3004 }, // possessed (AI churn = P_Random draws)
    { x: 190, y: 200, type: 3004 },
    { x: 128, y: 160, type: 2045 }, // stimpack (item-respawn queue)
    { x: 48, y: 208, type: 2007 } // clip
  ]
};

export const CORPUS_WAD = buildFixtureMapWad(CORPUS_SPEC);
export const CORPUS_WAD_BUF = CORPUS_WAD.buffer.slice(
  CORPUS_WAD.byteOffset,
  CORPUS_WAD.byteOffset + CORPUS_WAD.byteLength
) as ArrayBuffer;

/** A visually distinct second map (different volumes) for the map-roll
 * proofs — name-parameterized so cross-map loads are observable. */
export const ROLL_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 512 }, // 0: player start (wide)
    { x: 512, y: 0, w: 256, h: 256, tag: 1 } // 1: tagged mover target
  ],
  triggers: [{ x1: 512, y1: 64, x2: 512, y2: 192, tag: 1 }],
  things: [
    { x: 96, y: 96, angle: 90, type: 1 },
    { x: 300, y: 300, type: 3004 },
    { x: 200, y: 420, type: 2045 }
  ]
};

export const ROLL_WAD = buildFixtureMapWad(ROLL_SPEC, 'FIXMK2');
export const ROLL_WAD_BUF = ROLL_WAD.buffer.slice(
  ROLL_WAD.byteOffset,
  ROLL_WAD.byteOffset + ROLL_WAD.byteLength
) as ArrayBuffer;

export function corpusMap(): RuntimeMap {
  return buildMapFromData(loadMap(WadFile.parse(CORPUS_WAD_BUF), 'FIXMAP'));
}

export function rollMap(): RuntimeMap {
  return buildMapFromData(loadMap(WadFile.parse(ROLL_WAD_BUF), 'FIXMK2'));
}

export function e1m1Map(): RuntimeMap {
  return buildMapFromData(loadMap(iwad(), 'E1M1'));
}

export function bootCorpus(): GameState {
  return gInitGame(corpusMap());
}

export function bootRoll(): GameState {
  return gInitGame(rollMap());
}

export function bootE1M1(): GameState {
  return gInitGame(e1m1Map());
}

/** Register the levelLoader a load/worlddone drain needs. Returns the
 * map name most recently requested (map-name-roll observability). */
export type LoaderFn = (ep: number, map: number) => RuntimeMap | null;

export function registerLoader(loader: LoaderFn): {
  lastRequested: () => string | null;
} {
  const box = { last: null as string | null };
  registerGameFlowHooks({
    levelLoader: (_s: GameState, ep: number, map: number) => {
      box.last = `${ep}:${map}`;
      return loader(ep, map);
    }
  });
  return { lastRequested: () => box.last };
}

/* ------------------------------------------------------------------ */
/* Input helpers                                                       */
/* ------------------------------------------------------------------ */

export const walkIn = (_i = 0): GameInput => {
  void _i;
  return { ...emptyInput(), forward: true };
};

export function runIn(s: GameState, tics: number, input: (i: number) => GameInput = walkIn): void {
  for (let i = 0; i < tics; i++) gTicker(s, input(i));
}

/* ------------------------------------------------------------------ */
/* The scenario corpus (data — pSaveg.test.ts `scenario(...)` calls)    */
/* ------------------------------------------------------------------ */

export interface ScenarioSpec {
  name: string;
  setupTics: number;
  setup: (s: GameState) => void;
  settleTics: number;
  input: (i: number) => GameInput;
}

function taggedLine(s: GameState): number {
  const li = Array.from(s.map.lines.tag).findIndex((t) => t === 1);
  if (li < 0) throw new Error('fixture: no tag-1 line');
  return li;
}

const attackWalk = (i: number): GameInput => ({ ...walkIn(i), attack: i % 20 < 3 });
const turnWalk = (i: number): GameInput => ({ ...walkIn(i), turnRight: i % 3 === 0 });

export const SCENARIOS: readonly ScenarioSpec[] = [
  {
    name: 'mid-door-move',
    setupTics: 20,
    setup: (s) => {
      expect(evDoDoor(s, taggedLine(s), VL.close)).toBeTruthy();
    },
    settleTics: 15,
    input: walkIn
  },
  {
    name: 'plat-mid-travel',
    setupTics: 20,
    setup: (s) => {
      expect(evDoPlat(s, taggedLine(s), PLAT.downWaitUpStay, 0)).toBeTruthy();
    },
    settleTics: 12,
    input: walkIn
  },
  {
    name: 'crush-mid-travel',
    setupTics: 20,
    setup: (s) => {
      pSpawnMobj(s.mobjs, 300 << 16, 64 << 16, 0, 1);
      pSpawnMobj(s.mobjs, 300 << 16, 128 << 16, 0, 1);
      expect(evDoCeiling(s, taggedLine(s), CEIL.crushAndRaise)).toBeTruthy();
    },
    settleTics: 40,
    input: walkIn
  },
  {
    name: 'fire-and-lights',
    setupTics: 0,
    setup: () => {
      /* pure light specials ticking (fireflicker/flash/strobe draws) */
    },
    settleTics: 60,
    input: walkIn
  },
  {
    name: 'corpse-field',
    setupTics: 40,
    setup: (s) => {
      const targets = s.mobjs.mobjs.filter((m) => !m.removed && m.type === 1) as Mobj[];
      expect(targets.length).toBeGreaterThanOrEqual(2);
      pKillMobj(null, targets[0]!);
      pKillMobj(null, targets[1]!);
      const stim = s.mobjs.mobjs.find((m) => m.type === 31 && !m.removed);
      if (stim) pRemoveMobj(stim);
    },
    settleTics: 30,
    input: walkIn
  },
  {
    name: 'weapon-in-hand-powerups',
    setupTics: 10,
    setup: (s) => {
      const p = initPlayerInventory(attachPsprFields(s.players[0]!));
      p.weaponowned[2] = 1; // shotgun
      p.readyweapon = 2;
      p.pendingweapon = WP_NOCHANGE;
      p.ammo[1] = 21;
      p.powers[0] = 30; // invulnerability riding down
      p.powers[1] = 60; // invisibility
      p.cheats = CF_GODMODE | CF_NOCLIP;
      p.cards[0] = 1;
      p.cards[4] = 1;
      p.armorpoints = 150;
      p.armortype = 2;
    },
    settleTics: 10,
    input: attackWalk
  },
  {
    name: 'secret-counts-tallies',
    setupTics: 30,
    setup: (s) => {
      expect(s.totalsecret).toBe(1); // the special-9 room counted at load
      s.secretcount = 2;
      s.players[0]!.killcount = 3;
      s.players[0]!.itemcount = 5;
    },
    settleTics: 10,
    input: walkIn
  },
  {
    name: 'projectiles-and-corpses',
    setupTics: 30,
    setup: (s) => {
      const r = pSpawnMobj(s.mobjs, 150 << 16, 128 << 16, 48 << 16, 33);
      r.momx = 2097152;
      r.angle = 0;
      const victim = s.mobjs.mobjs.find((m) => m.type === 1 && !m.removed)!;
      pKillMobj(null, victim);
    },
    settleTics: 25,
    input: walkIn
  },
  {
    // Ninth member: a MOVER crossing the save boundary INSIDE the 300-tic
    // continuation (door armed at the save point, not before) — the
    // Think_S chain of a mover must be rebuilt purely from the bytes.
    name: 'mover-started-at-save',
    setupTics: 25,
    setup: (s) => {
      expect(evDoDoor(s, taggedLine(s), VL.open, 0)).toBeTruthy();
    },
    settleTics: 0,
    input: walkIn
  },
  {
    // Tenth member: movement-heavy continuation (turns + strafe + fire) —
    // momentum, psprite state and AI churn all straddle the boundary.
    name: 'turnfire-continuation',
    setupTics: 15,
    setup: () => {},
    settleTics: 15,
    input: turnWalk
  }
];

/** Run a scenario up to its save point (deterministic, no store). */
export function scenarioToSavePoint(sc: ScenarioSpec): GameState {
  const s = bootCorpus();
  runIn(s, sc.setupTics, sc.input);
  sc.setup(s);
  runIn(s, sc.settleTics, sc.input);
  return s;
}

/* ------------------------------------------------------------------ */
/* Reset: every module-global slot the byte path touches               */
/* ------------------------------------------------------------------ */

export function resetM11(): void {
  resetGameFlow();
  resetFlowStubHits();
  resetSaveFlow();
  resetCaptureLog();
  resetGameactionLog();
  resetSfxStubLog();
  resetPlatFlatCopies();
  registerCaptureSink(null);
  setPendingLoad(null);
  resetSaveLoad();
}

/* ------------------------------------------------------------------ */
/* Store fixtures (reload-sim = shared-maps fake IDB)                   */
/* ------------------------------------------------------------------ */

/** Structured-clone-lite: deep-copy plain data, KEEP Uint8Array instances
 * (the real IDB clone policy preserves ArrayBufferViews; a blind
 * structuredClone turns them into plain objects and breaks
 * asSaveRecord). */
function cloneValue<T>(value: T): T {
  if (value instanceof Uint8Array) return value.slice() as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneValue(v);
    return out as T;
  }
  return value;
}

function req<T>(value: T): {
  result?: T;
  error?: unknown;
  onerror: ((ev: { target: { error?: unknown } }) => void) | null;
  onsuccess: ((ev: { target: { result?: T } }) => void) | null;
} {
  const r = { result: value, error: undefined as unknown, onerror: null, onsuccess: null };
  queueMicrotask(() => r.onsuccess?.({ target: r }));
  return r;
}

/** Shared-maps fake IDB: TWO openStore() calls over the same `maps` are
 * the PAGE RELOAD (fresh store hydrate over the same bytes). The `saves`
 * map is also returned raw — the corruption battery writes junk through
 * it (what a half-written record on disk looks like). */
export interface SharedIdb {
  factory: IDBFactory;
  saves: Map<string | number, unknown>;
}

export function sharedIdb(): SharedIdb {
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
      return {
        objectStore: () => ({
          get: (key: string | number) =>
            req(map.has(key) ? cloneValue(map.get(key)) : undefined),
          put: (value: unknown, key: string | number) => {
            map.set(key, cloneValue(value));
            return req(key);
          },
          delete: (key: string | number) => {
            map.delete(key);
            return req(undefined);
          },
          getAllKeys: () => req([...map.keys()]),
          getAll: () => req([...map.values()]),
          openCursor: () => req(undefined)
        })
      };
    },
    close() {}
  };
  return {
    open(_name: string, _version?: number) {
      const r: {
        result?: unknown;
        error?: unknown;
        onerror: ((ev: { target: { error?: unknown } }) => void) | null;
        onsuccess: ((ev: { target: { result?: unknown } }) => void) | null;
        onupgradeneeded: ((ev: { target: { result?: unknown } }) => void) | null;
      } = { onerror: null, onsuccess: null, onupgradeneeded: null };
      queueMicrotask(() => {
        r.result = db;
        r.onupgradeneeded?.({ target: r });
        r.onsuccess?.({ target: r });
      });
      return r;
    }
  } as unknown as IDBFactory;
}

export function memStore(): Promise<PersistStore> {
  return openStore({ memory: true });
}

/** Fresh store over the SAME bytes = the reload. */
export function reopenStore(factory: IDBFactory): Promise<PersistStore> {
  return openStore({ factory });
}

/* ------------------------------------------------------------------ */
/* THE PRODUCTION BYTE PATH (menuSaveLoad seams — nothing hand-rolled) */
/* ------------------------------------------------------------------ */

/** Wire the production capture sink (menuSaveLoad createCaptureHandler →
 * JSON snapshot → DBP1 → §0.1 header codec → store.saveGame). */
export function mountCapture(store: PersistStore): void {
  const handler = createCaptureHandler(store);
  registerCaptureSink((e) => handler(e));
}

/** gSaveGame + the two-stage deferral (pack tic, drain tic) + the async
 * write flush. The two chain tics tick the world with drainIn(0/1)
 * (§0.3 timing; the snapshot world sits BEFORE drainIn(1) ticks). */
export async function saveThroughBytes(
  s: GameState,
  store: PersistStore,
  slot: number,
  description = 'm11',
  drainIn: (i: number) => GameInput = walkIn
): Promise<Uint8Array> {
  bindStore(store);
  mountCapture(store);
  gSaveGame(slot, description);
  for (let i = 0; i < 2; i++) gTicker(s, drainIn(i));
  await flushWrites();
  const res = await store.loadGame(slot);
  if (!res.ok) throw new Error(`saveThroughBytes: store miss slot ${slot}`);
  return res.value.bytes;
}

/** Load bytes into the CURRENT world through the production load path
 * (store.get → codec → gRequestLoadGame — arms ga_loadgame; the NEXT
 * gTicker executes G_DoLoadGame, §0.3). */
export async function loadThroughBytes(s: GameState, store: PersistStore, slot: number): Promise<void> {
  bindStore(store);
  const outcome = await loadSlot(s, slot);
  expect(outcome.action).toBe('clear-menus');
}

/* ------------------------------------------------------------------ */
/* THE MATRIX: save@T → fresh world → load → 300 == original T..T+300  */
/* ------------------------------------------------------------------ */

export interface MatrixResult {
  /** Reference hashes every 50 tics (6 entries: +50 … +300). */
  ref: number[];
  /** Loaded-world hashes every 50 tics (must equal `ref`). */
  back: number[];
  /** hashState at the capture point (must differ from ref[0]). */
  hashAtSave: number;
  saveBytes: Uint8Array;
}

/**
 * One matrix cell. `orig` is the prepared world AT the save point (run up
 * to T by the caller). Save timing (§0.3, pSaveg.test.ts 'in-game
 * save→load' accounting): the snapshot world sits at position T+1 —
 * AFTER contInput(0) ticked and BEFORE contInput(1) ticks. Both worlds
 * therefore stand at T+2 when their IDENTICAL futures begin (A: already
 * ticked contInput(1) during the drain tic; B: the load-drain gTicker is
 * fed contInput(1)). Futures start at contInput(2) on both sides and
 * hash every 50 tics. Sequence (world-order rule honored):
 *   A: saveThroughBytes (chain tics contInput(0/1)) → 300 continuation
 *      tics, hash each 50 → A DONE FOREVER.
 *   B: fresh boot (bootFresh), optionally drifted, THEN: reload-sim
 *      (store reopened over the same bytes, capture sink cleared), load,
 *      drain gTicker (contInput(1)), 300 continuation tics, hash each 50.
 * `orig` must finish before B boots (module world binds are
 * last-setup-wins).
 */
export async function matrixRun(opts: {
  orig: GameState;
  bootFresh: () => GameState;
  loader: LoaderFn;
  contInput: (i: number) => GameInput;
  driftTics?: number;
  reload?: boolean;
  tics?: number;
  slot?: number;
}): Promise<MatrixResult> {
  const tics = opts.tics ?? 300;
  const slot = opts.slot ?? 4;
  const { factory } = sharedIdb();
  const store = await reopenStore(factory);

  // Shared input cursor: the save chain consumes 0/1, futures 2.. on
  // BOTH worlds (same counter object ⇒ same stream by construction).
  let cursor = 0;
  const stream = (_i: number): GameInput => opts.contInput(cursor++);

  const hashAtSave = hashState(opts.orig);
  const saveBytes = await saveThroughBytes(opts.orig, store, slot, 'm11', stream);

  const ref: number[] = [];
  for (let k = 0; k < tics / 50; k++) {
    runIn(opts.orig, 50, stream);
    ref.push(hashState(opts.orig));
  }

  // ---- world B: ONLY after A is done forever -------------------------
  resetM11();
  const b = opts.bootFresh();
  registerGameFlowHooks({ levelLoader: opts.loader });
  if (opts.driftTics) runIn(b, opts.driftTics, walkIn);

  const storeB = opts.reload ? await reopenStore(factory) : store;
  await loadThroughBytes(b, storeB, slot);
  cursor = 1; // B stands where A stood: T+1 before, T+2 after this tic
  gTicker(b, opts.contInput(cursor++)); // the ga_loadgame drain ticks too
  const back: number[] = [];
  for (let k = 0; k < tics / 50; k++) {
    runIn(b, 50, stream);
    back.push(hashState(b));
  }
  store.close();
  if (opts.reload && storeB !== store) storeB.close();
  return { ref, back, hashAtSave, saveBytes };
}

/* ------------------------------------------------------------------ */
/* goldens plumbing (audio-class artifact: the savegame BYTES)          */
/* ------------------------------------------------------------------ */

export const META_PATH = fileURLToPath(new URL('../persist/goldens/meta.json', import.meta.url));
export const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
export const MODE = process.env['GOLDENS_MODE'] ?? '';

export function sha256Of(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface ByteGoldenOpts {
  name: string;
  kind: 'fixture' | 'iwad';
  script: string;
  /** THE render — called TWICE (double-run byte-equality first). */
  render: () => Promise<Uint8Array> | Uint8Array;
  /** 'bin' (default) commits `<name>.bin`; 'none' commits the sha only. */
  artifact?: 'bin' | 'none';
  /** Extra facts recorded in meta (hashes, counts — provenance notes). */
  notes?: Record<string, unknown>;
}

/** One byte golden: double-run byte-equality ALWAYS; then dump (update/
 * check modes) and/or sha-assert vs meta.json (naked run). */
export function byteGolden(opts: ByteGoldenOpts): void {
  it(opts.name, async () => {
    const a = await opts.render();
    const b = await opts.render();
    expect(Buffer.from(b).equals(Buffer.from(a)), `${opts.name}: double-run byte equality`).toBe(
      true
    );
    const sha = sha256Of(a);
    const record = {
      kind: opts.kind,
      script: opts.script,
      format: 'dsg-bytes',
      bytes: a.length,
      ...(opts.notes ?? {}),
      ...(opts.kind === 'iwad' ? { wadSha256: iwadSha256() } : {})
    };
    if (DUMP_DIR !== null) {
      writeFileSync(
        `${DUMP_DIR}/${opts.name}.json`,
        JSON.stringify({ name: opts.name, indexSha256: sha, ...record })
      );
      if (opts.artifact !== 'none') writeFileSync(`${DUMP_DIR}/${opts.name}.bin`, a);
    }
    if (MODE === 'update') return;
    if (!existsSync(META_PATH)) {
      throw new Error(
        `persist goldens not blessed (no ${META_PATH}); run: node scripts/goldens-update.mjs --set persist --reason "..."`
      );
    }
    const meta = JSON.parse(readFileSync(META_PATH, 'utf8')) as {
      scenes: Record<string, { indexSha256: string; kind?: string }>;
    };
    const entry = meta.scenes[opts.name];
    if (entry === undefined) {
      if (opts.kind === 'iwad' && !hasWad) return; // goldens-update skip-log covers it
      throw new Error(`persist golden '${opts.name}' missing from meta.json`);
    }
    expect(entry.indexSha256, `${opts.name}: sha vs blessed meta.json`).toBe(sha);
  });
}

/** hashState is a u32; canonical 8-char hex string for byte artifacts. */
export function hashBytes(h: number): Uint8Array {
  return new TextEncoder().encode((h >>> 0).toString(16).padStart(8, '0'));
}

/** The pSaveg-style "snapshot at capture time == what bytes decode to"
 * header equality (skill/episode/map/leveltime mirror §0.1 bytes). */
export function headerOf(snap: SaveSnapshot): { skill: number; episode: number; map: number; leveltime: number } {
  return {
    skill: snap.header.skill,
    episode: snap.header.episode,
    map: snap.header.map,
    leveltime: snap.header.leveltime
  };
}

/** gTicker a save-request through the worlddone drain (map-name roll
 * helper): sets wminfo.next and drains GA.worlddone. */
export function rollToNextMap(s: GameState, next: number): void {
  s.wminfo.next = next;
  s.gameaction = GA.worlddone;
  gTicker(s, emptyInput());
}
