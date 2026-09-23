/**
 * LIVE-SOAK harness (task/BUG-display, M12 seed) — a vitest-level REAL-TIME-LIKE
 * loop driver: ONE live game.ts instance advanced EXACTLY the way src/main.ts
 * drives the browser rAF loop, for N tics, with the full D_Display composition
 * (render/renderer.displayFrame) + palette blit math on every cycle. This is
 * the layer the unit/headless suites structurally cannot cover: they render
 * one frame per scene or one displayFrame per scripted tic, never a LONG
 * tic+display soak on a single instance with the display-block FILE STATICS
 * (d_fullscreen/oldgamestate/borderdrawcount/viewactive, the ST widget diff
 * statics, the st_palette change gate, the setsizeneeded latch) carried
 * forward frame after frame — exactly the class B-01/B-05/B-06 live in.
 *
 * Parity contract with src/main.ts (KEEP IN SYNC — M12 extends this file):
 *  stepTic() mirrors main.ts stepTic in order:
 *    (eventQueue drain — no DOM events here; emptyInput ticcmd) →
 *    exitRequest drain → gFlowTic → gTicker → amTicker →
 *    [GS_LEVEL] stTicker + automapActive mirror → [GS_LEVEL] huTicker →
 *    ST_Start/HU_Start on level change, ST_Stop/HU_Stop on LEVEL exit.
 *  display() mirrors main.ts render(): level-rebuild guard (no-op here —
 *    single map), takeWipeRequest, deps bundle, displayFrame, then the
 *    per-render `luts.setBank(paletteBand(player))` half (the stDrawer hook
 *    runs the same ST_doPaletteStuff gate INSIDE displayFrame).
 *  bootToPlay() mirrors main.ts afterLoad (gInitGame + attachPowerupFields +
 *    vInit + stInit + stStart + huStart + the M9 boot wiring halves main.ts
 *    does for EVERY live game: mSetWad/mInit/mRegisterFlow, dSetWad/fSetWad,
 *    the wi/finale/page/M drawer hooks) WITHOUT the D_StartTitle attract
 *    (the e2e/playstart.ts deterministic enter-play idea at vitest level:
 *    GS_LEVEL from gInitGame, gametic/leveltime anchored at 0).
 *  M12-05 EXTENSIONS (level rotation + menu visits, still main.ts parity):
 *    - display() runs the SAME level-rebuild guard main.ts:492-501 runs —
 *      key = state.map OBJECT IDENTITY (B-04 rule), rebuilding world/
 *      mapView/sprites from the levelLoader's pendingMd (textures/flats
 *      are per-IWAD, cached like main.ts boot.textures/boot.flats);
 *    - stepTic zeroes the command while the menu panel is open (main.ts
 *      :437 `if (menuState.menuActive()) ticInput = emptyInput()`) and
 *      render mirrors menuState.menuActive() into the deps bundle;
 *    - menuKey(ch) injects an m_menu keyboard event (main.ts's event
 *      queue forwards the SAME packets to mResponder).
 *
 * The stDrawer hook is registered VERBATIM as main.ts registers it today
 * (BG restore + diff draw) — fixing a bug here means fixing the wiring in
 * both places, and this harness is where the fix gets pinned.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { amCreateState, amTicker, type AutomapState } from '../../src/sim/amMap';
import {
  gExitLevel,
  gFlowTic,
  gInitGame,
  gSecretExitLevel,
  gTicker,
  GS,
  registerGameFlowHooks,
  takeWipeRequest
} from '../../src/sim/game';
import { mapNameFor } from '../../src/sim/gamemode';
import { buildMapFromData } from '../../src/sim/map';
import { attachPowerupFields, paletteBand } from '../../src/sim/ppalette';
import type { GameState } from '../../src/sim/state';
import { hashState } from '../../src/sim/state';
import { rPointToAngle2 } from '../../src/sim/p_shoot';
import { loadMap } from '../../src/wad/mapdata';
import { decodeColormap, decodePlaypal } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildRenderMapView } from '../../src/render/view';
import { initLightTables } from '../../src/render/lights';
import {
  buildMapSprites,
  displayFrame,
  registerDisplayHooks,
  resetDisplayHooks,
  resetDisplayStatics,
  type DisplayDeps,
  type DisplayResult,
  type SpriteTables
} from '../../src/render/renderer';
import { Framebuffer, PaletteLuts } from '../../src/render/framebuffer';
import { vInit } from '../../src/render/vvideo';
import { borderStats, resetBorderStats } from '../../src/render/borders';
import { buildPspriteFrameInput } from '../../src/pspriteview';
import {
  huDrawer,
  huSetWad,
  huStart,
  huStop,
  huTicker
} from '../../src/ui/humessage';
import {
  stDrawer,
  stInit,
  stRefreshBackground,
  stStart,
  stStop,
  stTicker,
  stResetAll,
  type StContext
} from '../../src/ui/statusbar';
import { WadFile } from '../../src/wad/wadfile';
import { huRegisterMenu } from '../../src/ui/humessage';
import {
  mDrawer,
  mInit,
  mRegisterFlow,
  mReset,
  mResponder,
  mSetWad,
  menuState
} from '../../src/ui/menu';
import { dPageDrawer, dReset, dSetWad } from '../../src/ui/title';
import { fDrawer, fReset, fSetWad } from '../../src/ui/finale';
import { wiDrawSnapshot } from '../../src/sim/wintermission';
import { wadWiPatches, wiDrawer as wiDrawFrame } from '../../src/render/wiDraw';

export function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

export const WAD_PATH = findWad();
export const hasWad = WAD_PATH !== undefined;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let cachedWad: WadFile | null = null;
export function sharedWad(): WadFile {
  if (cachedWad === null) {
    if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
    cachedWad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
  }
  return cachedWad;
}

// Per-IWAD render inputs (main.ts boot.textures / boot.flats — built ONCE,
// loadRenderWorld only indexes them; M12-05 level rotation re-uses them).
let cachedTextures: ReturnType<typeof texturesFromWad> | null = null;
let cachedFlats: ReturnType<typeof flatsFromWad> | null = null;
function sharedTextures(wad: WadFile): NonNullable<typeof cachedTextures> {
  if (cachedTextures === null) cachedTextures = texturesFromWad(wad);
  return cachedTextures;
}
function sharedFlats(wad: WadFile): NonNullable<typeof cachedFlats> {
  if (cachedFlats === null) cachedFlats = flatsFromWad(wad);
  return cachedFlats;
}

/** A full live-loop cycle: tics tics (main.ts stepTic each), then ONE
 * display (main.ts render). sampleEvery frames are recorded for the
 * pixel-grid invariants. */
export interface SoakFrame {
  readonly tic: number;
  readonly leveltime: number;
  readonly hash: number;
  /** sha256 (first 16 hex chars) of the full 320x200 index buffer. */
  readonly fbSha: string;
  /** sha256 (first 16 hex) of the VIEW-WINDOW rect (crop target region). */
  readonly windowSha: string;
  /** sha256 (first 16 hex) of the statusbar rows 168..199. */
  readonly barSha: string;
  /** sha256 (first 16 hex) of the face well rect (143..174 x 168..199). */
  readonly faceSha: string;
  /** sha256 (first 16 hex) of the 320x200 RGBA blit of the whole screen —
   * the palette-visible surface (what B-05 asserts on). */
  readonly screenRgbaSha: string;
  readonly bank: number;
  readonly borderDraws: number;
  readonly eraseBytes: number;
  readonly display: DisplayResult;
}

export interface LiveSoak {
  readonly state: GameState;
  readonly fb: Framebuffer;
  readonly luts: PaletteLuts;
  readonly frames: SoakFrame[];
  /** One rAF-equivalent cycle: `tics` sim tics (main.ts stepTic order),
   * then ONE display (main.ts render order). */
  cycle(tics?: number): SoakFrame;
  /** Run n cycles (1 tic each) capturing every `sampleEvery`. */
  soak(n: number, sampleEvery?: number): void;
  /** Pixel grid sample of the index buffer: average index per cell of a
   * `cells x cells` partition — the coarse fingerprint B-01 tracks. */
  sampleGrid(cells?: number): number[];
  /** Hash an arbitrary rect of the index buffer. */
  hashRect(x: number, y: number, w: number, h: number): string;
  injectDamage(amount: number): void;
  /** Script the ticcmd for subsequent tics (null = emptyInput). Called
   * ONCE PER TIC from stepTic — M12-05 runs the per-tic invariants there. */
  setInput(fn: ((tic: number) => GameInput) | null): void;
  /** Inject an m_menu keyboard event packet (main.ts event-queue mirror:
   * data1 = ASCII 27 ESC / 13 ENTER / 200 up / 208 down). */
  menuKey(ch: number): void;
  /** FORCE the automap on/off straight on the live am state (the keyboard
   * event path is e2e's job; B-01 pins the automap/skip-crop interaction
   * at this level). The harness mirrors am.automapactive into stCtx and
   * display deps exactly like stepTic/render do. */
  setAutomap(on: boolean): void;
  /** The live automap state (reference for drawAutomap replay checks). */
  readonly am: AutomapState;
}

/** Boot ONE live instance in main.ts order, entering play immediately (no
 * attract), and return the soak driver. Call resetSoakModules() FIRST in a
 * suite so the module statics of independent instances do not bleed. */
export function createLiveSoak(): LiveSoak {
  const wad = sharedWad();

  // ---- main.ts module wiring halves (idempotent per soak) ----
  let pendingMd: ReturnType<typeof loadMap> | null = null;
  registerGameFlowHooks({
    levelLoader: (_state, episode, map) => {
      try {
        const md = loadMap(wad, mapNameFor(episode, map));
        pendingMd = md;
        return buildMapFromData(md);
      } catch {
        return null;
      }
    }
  });

  const md = loadMap(wad, 'E1M1');
  const map = buildMapFromData(md);
  const state = gInitGame(map);
  const palettePlayer = attachPowerupFields(state.players[0]!);
  const luts = new PaletteLuts(decodePlaypal(wad.readLumpByName('PLAYPAL')));

  const fb = new Framebuffer();
  vInit(fb.indices); // screens[0] ALIASES fb.indices (main.ts afterLoad)
  const textures = sharedTextures(wad);
  const flats = sharedFlats(wad);
  let mdRef = md;
  let world = loadRenderWorld(mdRef, textures, flats, state.sectors);
  let mapView = buildRenderMapView(mdRef);
  const tables = initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')));
  let sprites: SpriteTables = buildMapSprites({ md: mdRef, map: mapView, wad });
  let mapRef: unknown = state.map; // B-04 rebuild key: OBJECT identity
  const am = amCreateState();

  // main.ts boot menu/title/finale wiring (afterLoad halves that are NOT
  // attract: the drawer hooks + M_Init + the M_Ticker slot + the HU-menu
  // seam). M12-05 menu visits drive mResponder/mDrawer over LIVE levels.
  const wiSrc = wadWiPatches(wad);
  mSetWad(wad);
  mInit(); // M_Init (+ shareware EpiDef censor) — before mRegisterFlow
  mRegisterFlow(); // the d_main.c:382 M_Ticker slot
  dSetWad(wad);
  fSetWad(wad);
  huRegisterMenu(); // menuSeams.showMessages ↔ huState (main.ts:298)

  stInit(wad);
  const stCtx: StContext = {
    rng: state.rng,
    player: state.players[0] as unknown as StContext['player'],
    automapActive: false,
    pointToAngle2: rPointToAngle2,
    setPaletteBand: (band) => luts.setBank(band)
  };
  huSetWad(wad);

  // The EXACT main.ts stDrawer wiring (the reorder contract hook) + the
  // M9 per-state drawers main.ts registers (M12-05: WI/finale/page frames
  // join the soak once level rotation reaches an intermission).
  resetDisplayHooks();
  registerDisplayHooks({
    stDrawer: (fullscreen, refresh) => {
      if (!fullscreen) stRefreshBackground(stCtx);
      stDrawer(stCtx, fullscreen, refresh);
    },
    huDrawer: (automapactive) => huDrawer(automapactive),
    wiDrawer: () => wiDrawFrame(wiSrc, wiDrawSnapshot()),
    finaleDrawer: () => fDrawer(),
    pageDrawer: () => dPageDrawer(),
    mDrawer: () => mDrawer()
  });
  resetDisplayStatics();

  stStart(stCtx);
  huStart(state.gameepisode, state.gamemap);
  let lastLevelMap: unknown = state.map;
  let lastGamestate = state.gamestate;
  void pendingMd; // (levelLoader feeds the display() rebuild guard below)

  const frames: SoakFrame[] = [];
  let inputFn: ((tic: number) => GameInput) | null = null;

  function stepTic(): void {
    const player = state.players[0]!;

    // (no DOM event queue in the harness — the drained queue stays empty;
    // menuKey() injects m_menu packets straight, mirroring main.ts's queue
    // forward). main.ts:437 parity: vanilla zeroes the command while the
    // menu panel is open (the world keeps ticking — g_game.c:569-573).
    let input = inputFn === null ? emptyInput() : inputFn(state.gametic);
    if (menuState.menuActive()) input = emptyInput();

    if (state.exitRequest !== 'none') {
      const kind = state.exitRequest;
      state.exitRequest = 'none';
      if (kind === 'secret') gSecretExitLevel(state);
      else gExitLevel(state);
    }

    gFlowTic(state);
    gTicker(state, input);
    amTicker(am, player);

    if (state.gamestate === GS.LEVEL) {
      stTicker(stCtx);
      stCtx.automapActive = am.automapactive;
      huTicker(player);
    }
    if (state.gamestate === GS.LEVEL && state.map !== lastLevelMap) {
      lastLevelMap = state.map;
      stStart(stCtx);
      huStart(state.gameepisode, state.gamemap);
    }
    if (state.gamestate !== GS.LEVEL && lastGamestate === GS.LEVEL) {
      stStop();
      huStop();
    }
    lastGamestate = state.gamestate;
  }

  function display(): DisplayResult {
    // main.ts:492-501 level-rebuild guard — key is state.map OBJECT
    // IDENTITY (B-04: a same-map New Game keeps `name` equal).
    if (state.map !== mapRef && pendingMd !== null) {
      mapRef = state.map;
      mdRef = pendingMd;
      pendingMd = null;
      world = loadRenderWorld(mdRef, textures, flats, state.sectors);
      mapView = buildRenderMapView(mdRef);
      sprites = buildMapSprites({ md: mdRef, map: mapView, wad });
    }
    const wipe = takeWipeRequest(state);
    stCtx.automapActive = am.automapactive;
    const deps: DisplayDeps = {
      fb,
      world,
      map: mapView,
      player: state.players[0]!,
      tables,
      sprites,
      automap: { state: am, map: state.map, player: state.players[0]! },
      psprites: buildPspriteFrameInput(state.map, state.players[0]!, sprites.sprites),
      state: {
        gamestate: state.gamestate,
        gametic: state.gametic,
        automapactive: am.automapactive,
        viewactive: state.viewactive,
        paused: state.paused,
        menuActive: menuState.menuActive()
      },
      borders: { wad },
      wipe
    };
    const result = displayFrame(deps);
    luts.setBank(paletteBand(palettePlayer));
    return result;
  }

  function snap(tic: number): SoakFrame {
    fb.blit(luts.lut);
    return {
      tic,
      leveltime: state.leveltime,
      hash: hashState(state),
      fbSha: shortSha(fb.indices),
      windowSha: rectSha(16, 12, 288, 144),
      barSha: rectSha(0, 168, 320, 32),
      faceSha: rectSha(143, 168, 32, 32),
      screenRgbaSha: shortSha(new Uint8Array(fb.pixels.buffer)),
      bank: luts.bank,
      borderDraws: borderStats.drawViewBorder,
      eraseBytes: borderStats.videoEraseBytes,
      display: displaySnapshot(resultRef)
    };
  }

  let resultRef: DisplayResult | undefined;
  let ticCount = 0;

  function cycle(tics = 1): SoakFrame {
    for (let i = 0; i < tics; i += 1) {
      stepTic();
      ticCount += 1;
    }
    resultRef = display();
    const f = snap(ticCount);
    frames.push(f);
    return f;
  }

  function soak(n: number, sampleEvery = 1): void {
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < 1; j += 1) {
        stepTic();
        ticCount += 1;
      }
      resultRef = display();
      if (i % sampleEvery === 0 || i === n - 1) frames.push(snap(ticCount));
    }
  }

  function sampleGrid(cells = 10): number[] {
    const out: number[] = [];
    const cw = Math.floor(320 / cells);
    const ch = Math.floor(200 / cells);
    for (let gy = 0; gy < cells; gy += 1) {
      for (let gx = 0; gx < cells; gx += 1) {
        let sum = 0;
        for (let y = 0; y < ch; y += 1) {
          const row = (gy * ch + y) * 320;
          for (let x = 0; x < cw; x += 1) sum += fb.indices[row + gx * cw + x]!;
        }
        out.push(sum);
      }
    }
    return out;
  }

  function rectSha(x: number, y: number, w: number, h: number): string {
    const row = new Uint8Array(w);
    const h1 = createHash('sha256');
    for (let r = 0; r < h; r += 1) {
      row.set(fb.indices.subarray(y * 320 + x + r * 320, y * 320 + x + r * 320 + w));
      h1.update(row);
    }
    return h1.digest('hex').slice(0, 16);
  }

  function shortSha(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  }

  function injectDamage(amount: number): void {
    // The palette-relevant half of P_DamageMobj (p_inter.c:875-878) — the
    // harness drives the flash WITHOUT staging a live barrel, then the
    // soak asserts the DECAY path p_user.c:355-359 owns.
    const p = state.players[0] as unknown as { damagecount: number };
    p.damagecount = Math.min(100, p.damagecount + amount);
  }

  function setInput(fn: ((tic: number) => GameInput) | null): void {
    inputFn = fn;
  }

  function setAutomap(on: boolean): void {
    am.automapactive = on;
  }

  /** Inject an m_menu keyboard event (event_t.data1 = the ASCII key —
   * 27 ESC / 13 ENTER / 200·208 arrows). keyups are NEVER eaten
   * (g_game.c:571-577) — mResponder ignores them, keydown-only is exact. */
  function menuKey(ch: number): void {
    mResponder(state, { type: 'keydown', data1: ch });
  }

  return {
    state,
    fb,
    luts,
    frames,
    am,
    cycle,
    soak,
    sampleGrid,
    hashRect: rectSha,
    injectDamage,
    setInput,
    setAutomap,
    menuKey
  };
}

function displaySnapshot(r: DisplayResult | undefined): DisplayResult {
  return r ?? { viewheight: 0, fullscreen: false, borderDrawn: false, barRefreshed: false };
}

/** Forget every module static the soak touches — the equivalent of a fresh
 * process (tests in ONE file share the ESM graph). */
export function resetSoakModules(): void {
  stResetAll();
  resetDisplayStatics();
  resetDisplayHooks();
  resetBorderStats();
  huSetWad(null);
  // M12-05: the menu/title/finale statics join the fresh-process contract
  // (createLiveSoak re-runs the main.ts boot wiring on top of these).
  mReset();
  dReset();
  fReset();
}
