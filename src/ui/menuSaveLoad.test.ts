/**
 * ui/menuSaveLoad tests — M11-05 (M11-plan §M11-05, §0.4). Acceptance:
 *  1. label rendering matrix (empty / filled / error rows);
 *  2. save/load ROUND-TRIP via the memory store, INCLUDING a page-reload
 *     simulation (fresh store hydrate over the same bytes → load →
 *     world-restore hash assert — the pSaveg corpus scenario, reused);
 *  3. F-key paths (F2/F3 openers + guards, F6/F9 quicksave/quickload with
 *     the -1/-2/-N quickSaveSlot semantics, m_menu.c:685-745).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import { buildMapFromData, type RuntimeMap } from '../sim/map';
import {
  GA,
  gInitGame,
  gTicker,
  registerGameFlowHooks,
  resetFlowStubHits,
  resetGameFlow,
  resetSaveFlow,
  saveFlow,
} from '../sim/game';
import { hashState, type GameState } from '../sim/state';
import { emptyInput, type GameInput } from '../sim/ticcmd';
import {
  registerCaptureSink,
  resetCaptureLog,
  resetGameactionLog,
  resetSfxStubLog,
  setPendingLoad,
} from '../sim/hooks';
import { resetPlatFlatCopies } from '../sim/pplats';
import { menuSeams } from './menu';
import { KEY_BACKSPACE, KEY_ENTER, KEY_ESCAPE } from '../input/keyboard';
import { buildPayload, encodeSave } from '../persist/codec';
import { openStore, type PersistStore } from '../persist/store';

import {
  LOAD_END,
  QLOADNET,
  QLPROMPT,
  QSAVESPOT,
  QSPROMPT,
  SAVEDEAD,
  LOADNET,
  SLOT_COUNT,
  bindQuickSlot,
  bindStore,
  captureErrors,
  refreshSlotLabels,
  createCaptureHandler,
  createMenuGlue,
  doSave,
  flushWrites,
  getQuickSaveSlot,
  labelsGeneration,
  loadMenuOpener,
  loadSlot,
  quickLoad,
  quickPromptResponse,
  quickSave,
  resetSaveLoad,
  saveMenuOpener,
  saveStringResponder,
  saveStringState,
  selectSaveSlot,
  setQuickSaveSlot,
  setSeams,
  slotRows,
} from './menuSaveLoad';

/* ------------------------------------------------------------------ */
/* Fixture (the pSaveg corpus map — reused per the task brief)          */
/* ------------------------------------------------------------------ */

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // 0: player start
    { x: 256, y: 0, w: 256, h: 256, tag: 1 }, // 1: mover target
    { x: 512, y: 0, w: 256, h: 256, special: 17 }, // 2: fireflicker
    { x: 0, y: 256, w: 256, h: 256, special: 2 }, // 3: strobe
    { x: 256, y: 256, w: 256, h: 256, special: 9 }, // 4: secret count
    { x: 512, y: 256, w: 256, h: 256, special: 1 }, // 5: lightflash
  ],
  triggers: [{ x1: 256, y1: 64, x2: 256, y2: 192, tag: 1 }],
  things: [
    { x: 64, y: 128, angle: 0, type: 1 },
    { x: 150, y: 60, type: 3004 },
    { x: 190, y: 200, type: 3004 },
    { x: 128, y: 160, type: 2045 },
    { x: 48, y: 208, type: 2007 },
  ],
};

const WAD = buildFixtureMapWad(SPEC);
const WAD_BUF = WAD.buffer.slice(
  WAD.byteOffset,
  WAD.byteOffset + WAD.byteLength
) as ArrayBuffer;

function scenarioMap(): RuntimeMap {
  return buildMapFromData(loadMap(WadFile.parse(WAD_BUF), 'FIXMAP'));
}

function boot(): GameState {
  return gInitGame(scenarioMap());
}

const walkIn = (): GameInput => ({ ...emptyInput(), forward: true });

function runIn(s: GameState, tics: number): void {
  for (let i = 0; i < tics; i++) gTicker(s, walkIn());
}

/* ------------------------------------------------------------------ */
/* Store fixtures                                                      */
/* ------------------------------------------------------------------ */

function memoryStore(): Promise<PersistStore> {
  return openStore({ memory: true });
}

/** Shared-maps fake IDB: TWO openStore() calls over the same `maps` =
 * the page-reload simulation (fresh store hydrate over the same bytes). */
function sharedIdb(): {
  factory: IDBFactory;
  saves: Map<string | number, unknown>;
} {
  const maps = new Map<string, Map<string | number, unknown>>([
    ['saves', new Map()],
    ['settings', new Map()],
  ]);
  const saves = maps.get('saves')!;
  const db = {
    objectStoreNames: { contains: (name: string) => maps.has(name) },
    createObjectStore: (name: string) => maps.set(name, new Map()),
    transaction(name: string) {
      const map = maps.get(name)!;
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
          getAll: () => req([...map.values()]),
        }),
      };
    },
  };
  function req(result: unknown) {
    const request: Record<string, unknown> = { result };
    queueMicrotask(() => (request.onsuccess as (() => void) | null)?.());
    return request;
  }
  const factory = {
    open: () => req(db),
  } as unknown as IDBFactory;
  return { factory, saves };
}

/** A codec-valid record for direct store seeding (label matrix tests). */
function validBytes(): Uint8Array {
  const enc = encodeSave(
    {
      description: 'seeded',
      skill: 1,
      episode: 1,
      map: 1,
      playeringame: [1, 0, 0, 0],
      leveltime: 42,
    },
    buildPayload([{ id: 0, bytes: new TextEncoder().encode('{}') }])
  );
  if (!enc.ok) throw new Error('seed encode failed');
  return enc.bytes;
}

function seed(store: PersistStore, slot: number, description: string, bytes: Uint8Array) {
  return store
    .saveGame(slot, bytes, {
      description,
      gameInfo: { skill: 1, episode: 1, map: 1, leveltime: 42 },
    })
    .then(() => undefined);
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const sfxLog: string[] = [];
const msgLog: { text: string; awaiting: string }[] = [];

beforeEach(async () => {
  resetGameFlow();
  resetFlowStubHits();
  resetSaveFlow();
  resetCaptureLog();
  resetGameactionLog();
  resetSfxStubLog();
  resetPlatFlatCopies();
  registerCaptureSink(null);
  setPendingLoad(null);
  registerGameFlowHooks({ levelLoader: () => scenarioMap() });
  resetSaveLoad();
  sfxLog.length = 0;
  msgLog.length = 0;
  setSeams({
    sfx: (n) => sfxLog.push(n),
    message: (t, a) => msgLog.push({ text: t, awaiting: a }),
  });
  bindStore(null);
  await flushWrites();
});

const keydown = (data1: number): { type: 'keydown'; data1: number } => ({
  type: 'keydown',
  data1,
});

/** Type a printable run through the editor. */
function typeString(s: GameState, text: string): void {
  for (const c of text) saveStringResponder(s, keydown(c.charCodeAt(0)));
}

/** select row → type → Enter (the F2 flow through SaveDef). */
async function saveViaEditor(
  s: GameState,
  slot: number,
  text: string
): Promise<void> {
  selectSaveSlot(slot);
  typeString(s, text);
  saveStringResponder(s, keydown(KEY_ENTER));
  await flushWrites(); // capture→codec→put lands in the write chain
}

/* ------------------------------------------------------------------ */
/* 1. Label rendering matrix (empty / filled / error)                   */
/* ------------------------------------------------------------------ */

describe('slot label matrix (§0.4, M_ReadSaveStrings :511-536)', () => {
  it('ten rows, EMPTYSTRING defaults with no store; six are menu rows', () => {
    const rows = slotRows();
    expect(rows.length).toBe(SLOT_COUNT); // 10 (m_menu.c:132)
    expect(LOAD_END).toBe(6); // six exposed rows (m_menu.c:451-460)
    for (const r of rows) {
      expect(r.empty).toBe(true);
      expect(r.description).toBe('empty slot'); // d_englsh.h:75
      expect(r.error).toBeNull();
    }
  });

  it('refresh renders empty/filled faces; holes NEVER read undefined', async () => {
    const store = await memoryStore();
    await seed(store, 2, 'mid-run', validBytes());
    await seed(store, 5, '', validBytes()); // legal empty description
    bindStore(store);
    await new Promise<void>((r) => setTimeout(r, 0));
    const rows = slotRows();
    expect(rows[2]!.empty).toBe(false);
    expect(rows[2]!.description).toBe('mid-run');
    expect(rows[2]!.error).toBeNull();
    expect(rows[5]!.empty).toBe(false);
    expect(rows[5]!.description).toBe('');
    expect(rows[0]!.empty).toBe(true);
    expect(rows[0]!.description).toBe('empty slot');
  });

  it('error rows: corrupt record displays as EMPTYSTRING + tagged error', async () => {
    const { factory, saves } = sharedIdb();
    const store = await openStore({ factory });
    // A record failing the store-shape validation (asSaveRecord ⇒ null ⇒
    // loadGame corrupt-record lane).
    saves.set(4, { notARecord: true });
    bindStore(store);
    await new Promise<void>((r) => setTimeout(r, 0));
    const rows = slotRows();
    expect(rows[4]!.error).toBe('corrupt-record');
    expect(rows[4]!.description).toBe('empty slot'); // the open-fail lane
    expect(rows[4]!.empty).toBe(true);
    expect(rows[3]!.error).toBeNull();
  });

  it('error rows: codec-invalid bytes list filled, tag codec ON LOAD ATTEMPT', async () => {
    const store = await memoryStore();
    await seed(store, 1, 'rotten', new Uint8Array([9, 9, 9, 9]));
    bindStore(store);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotRows()[1]!.error).toBeNull(); // listing is description-only
    const s = boot();
    const out = await loadSlot(s, 1);
    expect(out.action).toBe('clear-menus'); // vanilla clears regardless
    expect(s.gameaction).not.toBe(GA.loadgame); // silent arm-blocked (no load)
    expect(slotRows()[1]!.error).toBe('codec');
  });

  it('async-safe refresh: the generation moves only on row swaps', async () => {
    const store = await memoryStore();
    const g0 = labelsGeneration();
    bindStore(store);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(labelsGeneration()).toBeGreaterThan(g0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Save/load round-trip (memory store) + page-reload simulation      */
/* ------------------------------------------------------------------ */

describe('save/load round-trip through the store', () => {
  it('editor save → drain capture → store.put → label refresh', async () => {
    const store = await memoryStore();
    bindStore(store);
    registerCaptureSink(createCaptureHandler(store));
    const s = boot();
    runIn(s, 20);

    saveMenuOpener(s); // F2 route: guards + open-save-def + refresh
    await saveViaEditor(s, 3, 'e1m1 run');
    // Enter armed gSaveGame; TWO tics: pack (tic 1) + drain (tic 2).
    gTicker(s, walkIn());
    gTicker(s, walkIn());
    await flushWrites();

    expect(saveFlow.savesDone).toBe(1);
    const rec = await store.loadGame(3);
    expect(rec.ok).toBe(true);
    if (rec.ok) {
      expect(rec.value.description).toBe('E1M1 RUN'); // typed face, no auto strings
      expect(rec.value.bytes[0]).toBe(0x45); // 'E' — the 24B desc field
    }
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotRows()[3]!.description).toBe('E1M1 RUN');
  });

  it('load restores the world: hash(load drain + 1 tic) == hash(reference + 1 tic)', async () => {
    const store = await memoryStore();
    bindStore(store);
    registerCaptureSink(createCaptureHandler(store));
    const a = boot();
    runIn(a, 30);
    const hashAt = hashState(a);

    saveMenuOpener(a);
    await saveViaEditor(a, 0, 'checkpoint');
    gTicker(a, walkIn()); // pack
    gTicker(a, walkIn()); // drain ⇒ capture; tic also advances a ONE tic
    await flushWrites();

    const b = boot(); // fresh blank world (G_InitNew runs in the drain)
    const out = await loadSlot(b, 0);
    expect(out.action).toBe('clear-menus');
    expect(b.gameaction).toBe(GA.loadgame);
    gTicker(b, walkIn()); // the drain executes G_DoLoadGame, then ticks

    // a's drain tic IS snapshot+1 tic; b's load-drain tic likewise
    // (the pSaveg golden property, reused).
    expect(hashState(b)).toBe(hashState(a));
    expect(hashState(b)).not.toBe(hashAt); // the world moved (the tic ticked)
  });

  it('PAGE RELOAD: fresh store hydrate over the same bytes → load → restore', async () => {
    const { factory } = sharedIdb();
    const storeA = await openStore({ factory });
    bindStore(storeA);
    registerCaptureSink(createCaptureHandler(storeA));

    const a = boot();
    runIn(a, 25);
    saveMenuOpener(a);
    await saveViaEditor(a, 7, 'pre-reload');
    gTicker(a, walkIn()); // pack
    gTicker(a, walkIn()); // drain
    await flushWrites();

    // ---- the reload: reset EVERYTHING, then boot with a FRESH store ----
    resetSaveLoad();
    resetGameFlow();
    resetSaveFlow();
    registerCaptureSink(null);
    registerGameFlowHooks({ levelLoader: () => scenarioMap() });

    const storeB = await openStore({ factory }); // hydrate — same bytes
    bindStore(storeB);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(slotRows()[7]!.description).toBe('PRE-RELOAD'); // rows survived (typed UPPER)

    const b = boot();
    await loadSlot(b, 7);
    gTicker(b, walkIn()); // load drain + one tic

    // a finished its drain tic ⇒ snapshot + 1 tic ≡ b
    expect(hashState(b)).toBe(hashState(a));
  });

  it('empty-slot load is a silent no-op — no sfx, no gameaction, menus clear', async () => {
    const store = await memoryStore();
    bindStore(store);
    const s = boot();
    const out = await loadSlot(s, 2);
    expect(out.action).toBe('clear-menus'); // M_ClearMenus is unconditional
    expect(out.message).toBeUndefined(); // and SILENT (:578-590 plays none)
    expect(s.gameaction).toBe(GA.nothing);
    expect(sfxLog).toEqual([]); // no sfx either
  });

  it('capture ledger: store failures never throw, counted', async () => {
    const broken = {
      saveGame: async () => ({
        ok: false as const,
        error: { code: 'quota-exceeded' as const, message: 'full' },
      }),
    } as unknown as PersistStore;
    registerCaptureSink(createCaptureHandler(broken));
    const s = boot();
    runIn(s, 5);
    doSave(s, 2);
    gTicker(s, walkIn()); // pack
    gTicker(s, walkIn()); // drain ⇒ sink fires, the put fails
    await flushWrites(); // nothing throws across the boundary
    expect(captureErrors()).toContain('store: quota-exceeded');
  });

});

/* ------------------------------------------------------------------ */
/* 3. String editor (char switch :1450-1490)                            */
/* ------------------------------------------------------------------ */

describe('save-name editor (M_SaveSelect + M_Responder char switch)', () => {
  it('typing: lowercase→UPPER, HU-font filter, caps at 22 chars/176px', () => {
    const s = boot();
    selectSaveSlot(1);
    expect(saveStringState()).toMatchObject({ active: true, slot: 1, text: '' });
    typeString(s, 'abc xyz');
    expect(saveStringState().text).toBe('ABC XYZ'); // toupper; space kept
    // '~' (126) is outside the HU font ('!'..'_' bound) ⇒ rejected.
    typeString(s, '~');
    expect(saveStringState().text).toBe('ABC XYZ');
    // Width cap: 22 chars total ((SAVESTRINGSIZE-2)*8 px).
    const s2 = boot();
    selectSaveSlot(2);
    typeString(s2, 'ABCDEFGHIJKLMNOPQRSTUVWX'); // 24 chars
    expect(saveStringState().text.length).toBe(22);
  });

  it('backspace decrements; ESC reverts to the snapshot; empty Enter = no save', () => {
    const s = boot();
    selectSaveSlot(0);
    typeString(s, 'HELLO');
    saveStringResponder(s, keydown(KEY_BACKSPACE));
    expect(saveStringState().text).toBe('HELL');
    saveStringResponder(s, keydown(KEY_ESCAPE));
    expect(saveStringState().active).toBe(false);
    expect(saveStringState().text).toBe('empty slot'); // reverted (pre-edit face)
    // Enter on an EMPTY edit never saves (vanilla :1469 checks [0]).
    selectSaveSlot(0); // EMPTYSTRING ⇒ blanked for editing
    const out = saveStringResponder(s, keydown(KEY_ENTER));
    expect(out.consumed).toBe(true);
    expect(out.outcome.action).toBe('none');
    gTicker(s, walkIn());
    gTicker(s, walkIn());
    expect(saveFlow.savesDone).toBe(0);
    // keyup is NOT consumed (ch stays -1 ⇒ :1441 fall-through).
    expect(
      saveStringResponder(s, { type: 'keyup', data1: 65 }).consumed
    ).toBe(false);
  });

  it('editing a FILLED slot pre-selects its text; ESC restores it', async () => {
    const store = await memoryStore();
    await seed(store, 1, 'KEEPME', validBytes());
    bindStore(store);
    await new Promise<void>((r) => setTimeout(r, 0));
    const s = boot();
    selectSaveSlot(1);
    expect(saveStringState().text).toBe('KEEPME');
    expect(saveStringState().charIndex).toBe(6);
    typeString(s, '-X');
    expect(saveStringState().text).toBe('KEEPME-X');
    saveStringResponder(s, keydown(KEY_ESCAPE));
    expect(saveStringState().text).toBe('KEEPME'); // :1463 strcpy(saveOldString)
  });
});

/* ------------------------------------------------------------------ */
/* 4. F-key paths: F2/F3 openers + guards, F6/F9 quickslot              */
/* ------------------------------------------------------------------ */

describe('menu openers + guards (M_SaveGame :644-657, M_LoadGame :594-603)', () => {
  it('F2 route: !usergame ⇒ SAVEDEAD (no open); mid-level ⇒ open-save-def', () => {
    const title = boot();
    title.usergame = false;
    const out = saveMenuOpener(title);
    expect(out.message).toBe(SAVEDEAD);
    expect(out.action).toBe('none');
    expect(msgLog.at(-1)?.awaiting).toBe('ack');

    const s = boot();
    expect(saveMenuOpener(s).action).toBe('open-save-def');
  });

  it('F2 route: gamestate != GS_LEVEL ⇒ silent no-open', () => {
    const s = boot();
    s.gamestate = 1; // GS_INTERMISSION
    const out = saveMenuOpener(s);
    expect(out.action).toBe('none');
    expect(out.message).toBeUndefined();
  });

  it('F3 route: netgame ⇒ LOADNET; else open-load-def', async () => {
    const s = boot();
    setSeams({ isNetgame: () => true });
    expect(loadMenuOpener(s).message).toBe(LOADNET);
    setSeams({ isNetgame: () => false });
    expect(loadMenuOpener(s).action).toBe('open-load-def');
  });
});

describe('quicksave/quickload (F6 :685-712, F9 :729-745)', () => {
  it('quickSave with no slot opens SaveDef and arms the -2 sentinel; the slot picked becomes the quickslot', async () => {
    const store = await memoryStore();
    bindStore(store);
    registerCaptureSink(createCaptureHandler(store));
    const s = boot();
    expect(getQuickSaveSlot()).toBe(-1); // M_Init :1858
    expect(quickSave(s).action).toBe('open-save-def');
    expect(getQuickSaveSlot()).toBe(-2); // :706 "pick a slot now"
    await saveViaEditor(s, 4, 'qs');
    expect(getQuickSaveSlot()).toBe(4); // M_DoSave capture :704-706
    gTicker(s, walkIn());
    gTicker(s, walkIn());
    await flushWrites();
    expect(saveFlow.savesDone).toBe(1);
  });

  it('quickSave with a slot ⇒ QSPROMPT with the label; y saves, n cancels', async () => {
    const store = await memoryStore();
    bindStore(store);
    registerCaptureSink(createCaptureHandler(store));
    const s = boot();
    setQuickSaveSlot(1);
    // The label interpolates the slot string (sprintf :709).
    await seed(store, 1, 'TARGET', validBytes());
    await refresh();
    const out = quickSave(s);
    expect(out.prompt).toBe('quicksave');
    expect(out.promptText).toBe(QSPROMPT.replace('%s', 'TARGET'));
    expect(msgLog.at(-1)?.awaiting).toBe('yesno');
    // 'n' cancels silently.
    expect(quickPromptResponse(s, 110, 'quicksave').action).toBe('none');
    gTicker(s, walkIn());
    gTicker(s, walkIn());
    await flushWrites();
    expect(saveFlow.savesDone).toBe(0);
    // 'y' acts (lowercase only — vanilla compares the raw char).
    expect(quickPromptResponse(s, 89, 'quicksave').action).toBe('none'); // 'Y' no
    expect(quickPromptResponse(s, 121, 'quicksave').action).toBe('clear-menus');
    expect(sfxLog).toContain('sfx_swtchx'); // :681
    gTicker(s, walkIn());
    gTicker(s, walkIn());
    await flushWrites();
    expect(saveFlow.savesDone).toBe(1);
  });

  it('quickSave guards: !usergame ⇒ sfx_oof only; intermission ⇒ silent', () => {
    const title = boot();
    title.usergame = false;
    expect(quickSave(title).action).toBe('none');
    expect(sfxLog).toContain('sfx_oof'); // :688-691 — NO message
    expect(msgLog.length).toBe(0);
    const s = boot();
    s.gamestate = 1;
    expect(quickSave(s).action).toBe('none');
  });

  it('quickLoad: no slot ⇒ QSAVESPOT; netgame ⇒ QLOADNET; slot ⇒ QLPROMPT + y loads', async () => {
    const store = await memoryStore();
    bindStore(store);
    const s = boot();
    expect(quickLoad(s).message).toBe(QSAVESPOT);
    setQuickSaveSlot(2);
    setSeams({ isNetgame: () => true });
    expect(quickLoad(s).message).toBe(QLOADNET);
    setSeams({ isNetgame: () => false });
    await seed(store, 2, 'SPOT', validBytes());
    await refresh();
    const out = quickLoad(s);
    expect(out.prompt).toBe('quickload');
    expect(out.promptText).toBe(QLPROMPT.replace('%s', 'SPOT'));
    expect(quickPromptResponse(s, 121, 'quickload').action).toBe('clear-menus');
    await new Promise<void>((r) => setTimeout(r, 0)); // let loadSlot land
    // The payload is JSON '{}' — NOT a snapshot ⇒ silent codec lane, no arm.
    gTicker(s, walkIn());
    expect(s.gameaction).not.toBe(GA.loadgame);
  });

  it('quickLoad y over a REAL save restores the world', async () => {
    const store = await memoryStore();
    bindStore(store);
    registerCaptureSink(createCaptureHandler(store));
    const a = boot();
    runIn(a, 20);
    setQuickSaveSlot(5); // pretend F6 ran earlier this session
    selectSaveSlot(5); // type nothing — Enter blocked by the empty check;
    saveStringResponder(a, keydown(KEY_ESCAPE));
    // quicksave-response path (bypasses the editor):
    quickPromptResponse(a, 121, 'quicksave');
    gTicker(a, walkIn());
    gTicker(a, walkIn());
    await flushWrites();
    expect(saveFlow.savesDone).toBe(1);

    const b = boot();
    setQuickSaveSlot(5);
    quickLoad(b);
    quickPromptResponse(b, 121, 'quickload');
    await new Promise<void>((r) => setTimeout(r, 0)); // async loadSlot arms
    expect(b.gameaction).toBe(GA.loadgame);
    gTicker(b, walkIn()); // load drain + one tic == a's post-drain state
    expect(hashState(b)).toBe(hashState(a));
  });

  it('quickSaveSlot is an injectable seam (menu.ts owns the global)', () => {
    const mirror: { v: number } = { v: -1 };
    bindQuickSlot({ get: () => mirror.v, set: (v) => (mirror.v = v) });
    const s = boot();
    quickSave(s);
    expect(mirror.v).toBe(-2); // menu.ts's variable received the sentinel
    mirror.v = 3;
    expect(getQuickSaveSlot()).toBe(3);
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

async function refresh(): Promise<void> {
  // Re-run M_ReadSaveStrings against the bound store and let the store's
  // microtask I/O land.
  await refreshSlotLabels();
  await new Promise<void>((r) => setTimeout(r, 0));
}


/* ------------------------------------------------------------------ */
/* 5. menu.ts glue (M11-03 seam contract, menu.ts:203-212)              */
/* ------------------------------------------------------------------ */

describe('createMenuGlue — mounts menu.ts saveRows/requestLoadSlot', () => {
  it('install feeds the last-known rows; requestLoadSlot arms a real load', async () => {
    const store = await memoryStore();
    registerCaptureSink(null);
    // Seed a real world save through the sim path for slot 1.
    const a = boot();
    runIn(a, 10);
    const sinkStore = createCaptureHandler(store);
    registerCaptureSink(sinkStore);
    doSave(a, 1);
    gTicker(a, walkIn());
    gTicker(a, walkIn());
    await flushWrites();
    registerCaptureSink(null);

    const b = boot();
    const glue = createMenuGlue(store, { getState: () => b });
    glue.install();
    await new Promise<void>((r) => setTimeout(r, 0)); // hydrate the view
    const view = menuSeams.saveRows!();
    expect(view.length).toBe(SLOT_COUNT);
    // doSave passed slotText verbatim — the vanilla M_DoSave quirk: the
    // un-named slot saves WITH the literal "empty slot" string.
    expect(view[1]).toEqual({ empty: false, description: 'empty slot' });
    expect(view[0]!.empty).toBe(true);

    menuSeams.requestLoadSlot!(1); // the mLoadSelect half (async)
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(b.gameaction).toBe(GA.loadgame);
    gTicker(b, walkIn());
    expect(hashState(b)).toBe(hashState(a)); // a ran its drain tic too

    glue.uninstall();
    expect(menuSeams.saveRows).toBeUndefined();
    expect(menuSeams.requestLoadSlot).toBeUndefined();
  });

  it('error lanes face the EMPTYSTRING read-view (open-fail rule)', async () => {
    const { factory, saves } = sharedIdb();
    const store = await openStore({ factory });
    saves.set(4, { junk: 1 }); // corrupt record lane
    const glue = createMenuGlue(store, { getState: () => null });
    glue.install();
    await new Promise<void>((r) => setTimeout(r, 0));
    const view = menuSeams.saveRows!();
    expect(view[4]!.empty).toBe(true);
    expect(view[4]!.description).toBe('empty slot');
    glue.uninstall();
  });
});
