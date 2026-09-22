/**
 * Platform entry point (M2-09 boot, M3-07 frame pipeline switch): boots the
 * real game — fetch /wads/freedoom1.wad → WadFile.parse → loadMap('E1M1') →
 * buildMapFromData → gInitGame, attaches the sim to __doom.sim (additive
 * debug wiring), builds the render world ONCE (loadRenderWorld /
 * buildRenderMapView / light tables — the M3-07 "load once" cache; the
 * renderer caches the walker/callbacks per map), and runs the rAF loop:
 * A-08 accumulator stepping G_Ticker at 35 Hz (max 4 catch-up tics), then
 * renderFrame — the §4.1 walls pipeline. The 3D view is now the DEFAULT
 * frame (M2's automap-by-default boot is dropped); the automap stays
 * exactly vanilla: Tab (KEY_MAPENTER, KEY_TAB=9, am_map.c
 * AM_STARTKEY/AM_ENDKEY) toggles the amMap STATE through the responder and
 * renderFrame draws the automap OVER the 3D pass when that state is active
 * (ARCHITECTURE §4.1.9).
 *
 * WAD 404 falls back to the viewer's file-picker pattern (src/viewer):
 * status text + <input type="file">, no console-error noise on that path.
 *
 * M4-07 (full-frame pipeline): the boot additionally installs the F_START
 * flats (flatsFromWad → loadRenderWorld: flatnums + sky indices) and the
 * once-per-map static thing/sprite tables (renderer.ts buildMapSprites),
 * and the debug seam now exposes ALL render counters. The frame order lives
 * in src/render/renderer.ts (pinned to r_main.c R_RenderPlayerView).
 *
 * Zone note: src/ root sits outside the import zones — this file is the
 * sim↔render bridge: it hands render's structural read-view interfaces the
 * real sim/amMap + sim/map + sim/player objects. They satisfy the shapes by
 * construction and the typecheck HERE is the enforcement point (A-INT1).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createKeyboardInput } from './input/keyboard';
import {
  KEY_DOWNARROW,
  KEY_LEFTARROW,
  KEY_RIGHTARROW,
  KEY_UPARROW
} from './input/keyboard';
import { createMenuMouse } from './input/menuMouse';
import { createMouseInput } from './input/mouse';
import {
  amCreateState,
  amResponder,
  amTicker,
  keydown,
  keyup,
  type AutomapEvent
} from './sim/amMap';
import {
  gExitLevel,
  gFlowTic,
  gInitGame,
  gSecretExitLevel,
  gTicker,
  GS,
  registerGameFlowHooks,
  takeWipeRequest,
  TICS_PER_SECOND
} from './sim/game';
import { mapNameFor } from './sim/gamemode';
import { buildMapFromData } from './sim/map';
import { rPointToAngle2 } from './sim/p_shoot';
import type { GameState } from './sim/state';
import { emptyInput, type GameInput } from './sim/ticcmd';
import { wiDrawSnapshot, wiPeek } from './sim/wintermission';
import { attachRenderDebug, attachMouseInjection, attachPopInput, attachUiDebug, debugApi, debugSim, installDebugApi, screenRead } from './debug';
import { blitToCanvas, Framebuffer, PaletteLuts } from './render/framebuffer';
import { attachPowerupFields, paletteBand } from './sim/ppalette';
import { installPickupSfxBridge, installPsprSfxSlot } from './sim/psound_stub';
import { buildMapSprites, displayFrame, getFrameCounters, registerDisplayHooks, type DisplayDeps, type SpriteTables } from './render/renderer';
import { setViewSize } from './render/view';
import { vInit } from './render/vvideo';
import { wadWiPatches, wiDrawer as wiDrawFrame, type WiPatchSource } from './render/wiDraw';
import {
  menuSeams,
  menuState,
  mDrawer,
  mInit,
  mRegisterFlow,
  mResponder,
  mSetWad
} from './ui/menu';
import {
  huDrawer,
  huRegisterMenu,
  huResponder,
  huSetWad,
  huStart,
  huState,
  huStop,
  huTicker,
  huMessageText
} from './ui/humessage';
import {
  stDrawer,
  stFaceIndex,
  stInit,
  stRefreshBackground,
  stStart,
  stStatusbarOn,
  stStop,
  stTicker,
  ST_NUMFACES,
  type StContext,
  type StPlayerView
} from './ui/statusbar';
import { dInit, dPageDrawer, dSetWad, gResponderDemo, titleState } from './ui/title';
import { fDrawer, fResponder, fSetWad, finaleState } from './ui/finale';
import { buildPspriteFrameInput } from './pspriteview';
import { flatsFromWad, loadRenderWorld, type FlatSource, type RenderWorld } from './render/rdata';
import { buildRenderMapView, type RenderMapView } from './render/view';
import { initLightTables, type LightTables } from './render/lights';
import { fetchWad, WadLoadError } from './platform/wadload';
import { loadMap } from './wad/mapdata';
import { decodeColormap, decodePlaypal } from './wad/palettes';
import { texturesFromWad } from './wad/texture';
import { WadFile } from './wad/wadfile';

/* ------------------------------------------------------------------ */
/* DOM                                                                  */
/* ------------------------------------------------------------------ */

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('missing <canvas id="game">');
}
const ctxOrNull = canvas.getContext('2d');
if (ctxOrNull === null) {
  throw new Error('2D canvas context unavailable');
}
const ctx: CanvasRenderingContext2D = ctxOrNull;
if (canvas.width !== 320 || canvas.height !== 200) {
  throw new Error('canvas must be 320x200');
}

/** WAD URL override (?wad=...), same convention as the viewer page. */
const wadUrl = new URLSearchParams(location.search).get('wad') ?? '/wads/freedoom1.wad';

/** Typed alias of the guarded canvas element (closure-friendly). */
const canvasEl: HTMLCanvasElement = canvas;

const status = document.createElement('div');
status.dataset['testId'] = 'boot-status';
status.style.cssText =
  'position:fixed;top:0;left:0;color:#0f0;background:#000;font:12px monospace;padding:2px 6px;z-index:10';
document.body.appendChild(status);

const picker = document.createElement('input');
picker.type = 'file';
picker.accept = '.wad';
picker.dataset['testId'] = 'wad-file';
picker.hidden = true;
document.body.appendChild(picker);

/* ------------------------------------------------------------------ */
/* Boot state + loop (A-08 accumulator: sim at 35 Hz, render per rAF)   */
/* ------------------------------------------------------------------ */

interface Boot {
  readonly state: GameState;
  /** M9-03: kept for the level-reload path (G_DoLoadLevel rebuilds the
   * per-map render assets when `state.map` changes identity). */
  wad: WadFile | null;
  mapName: string;
  /** B-04 FIX: the RuntimeMap OBJECT the current world/mapView/sprites
   * were built for. gSetupLevel (game.ts:320) REPLACES state.map AND
   * state.sectors on every load (G_InitNew/G_DoLoadLevel/reborn), so the
   * rebuild key MUST be object identity — a same-map New Game (E1M1 →
   * E1M1) keeps `name` equal and the old name-keyed check left the world
   * bound to the boot-time SoA (lifts never moved on screen; mid-ride the
   * live viewz fell under the stale floor planes = the B-04 glitch).
   * Mirrors stepTic's identity detector (`state.map !== lastLevelMap`). */
  simMap: GameState['map'];
  readonly am: ReturnType<typeof amCreateState>;
  /** PLAYPAL banks + the current selection (M7-06: the I_SetPalette half —
   * the band index itself is computed sim-side, see sim/ppalette.ts). */
  readonly luts: PaletteLuts;
  /** The player read as a palette/powerup source (fields attached once). */
  readonly palettePlayer: ReturnType<typeof attachPowerupFields>;
  /** Render world + BSP view + light tables: built ONCE here (M3-07 "load
   * render world once"), reused by every frame's deps bundle. M9-03:
   * world/mapView/sprites are per-MAP and rebuilt by the display block
   * when a level load changes state.map; tables/luts are per-IWAD. */
  world: RenderWorld;
  /** B-04 perf: the PER-IWAD texture/flat decode, computed once at boot.
   * loadRenderWorld only indexes these (texByName is per-world), so a
   * same-map reload (death reborn) re-decodes ~66 ms of TEXTURE1/2 lumps
   * for zero change — hoisting keeps the reload hitch at ~30 ms (the
   * per-MAP halves only). */
  readonly textures: ReturnType<typeof texturesFromWad>;
  readonly flats: readonly FlatSource[];
  mapView: RenderMapView;
  readonly tables: LightTables;
  /** M4-07: the once-per-map static thing/sprite tables (rthings census +
   * decoded patches); the frame's sprite pass caches off these. */
  sprites: SpriteTables;
}

let boot: Boot | null = null;
const fb = new Framebuffer();

const MAX_CATCHUP_TICS = 4;
const TIC_MS = 1000 / TICS_PER_SECOND;
let accumulator = 0;
let lastFrameMs = 0;

/** Key events queued between tics, drained ONCE per tic like vanilla
 * D_ProcessEvents (d_main.c tic loop) — event handling never depends on the
 * rAF rate. */
const eventQueue: AutomapEvent[] = [];

/** M9-03 G_DoLoadLevel map source (game.ts `levelLoader` hook): episodic
 * naming (mapNameFor, shareware policy pins ep=1 via the G_InitNew
 * clamps); the loaded MapData is stashed for the display-block render
 * rebuild. Null ⇒ unresolved map (game.ts counts the stub). */
let wadFile: WadFile | null = null;
let pendingMd: ReturnType<typeof loadMap> | null = null;
registerGameFlowHooks({
  levelLoader: (_state, episode, map) => {
    if (wadFile === null) return null;
    try {
      const md = loadMap(wadFile, mapNameFor(episode, map));
      pendingMd = md;
      return buildMapFromData(md);
    } catch {
      return null; // gDoLoadLevel counts `level-load-fail`; never throws into the tic
    }
  }
});

/* ------------------------------------------------------------------ */
/* M9 UI-stack wiring (M9-plan §M9-03 "main.ts wiring" half — the      */
/* responder chain, D_Display drawer registration and the boot→title    */
/* call landed HERE in M9-12; the modules were merged wired-for-this).  */
/* ------------------------------------------------------------------ */

/** Menu-mode mouse→key synth (D-0yy): hover/click feed the SAME event
 * queue the physical keyboard feeds (vanilla d_loop.c D_ProcessEvents
 * side); the synthesizer arms from menuState.itemBoxes() via
 * menuSeams.mouseArm. */
const menuMouse = createMenuMouse({
  onEvent: (ev) => eventQueue.push(ev),
  currentIndex: () => menuState.itemOn()
});
menuSeams.setViewSize = (blocks, detail) => setViewSize(blocks, detail);
menuSeams.automapActive = () => boot?.am.automapactive ?? false;
menuSeams.mouseArm = (boxes, current) => {
  if (boxes === null || boxes.length === 0) menuMouse.setItems([]);
  else {
    menuMouse.setItems(boxes);
    menuMouse.setIndex(current());
  }
};
huRegisterMenu(); // menuSeams.showMessages ↔ huState (M9-06 wiring note)

/** Statusbar context (per-Level ST_Start; the LIVE rng/player objects). */
let stCtx: StContext | null = null;
let wiSrc: WiPatchSource | null = null;
/** Level-reload detector (ST_Start/HU_Start per G_DoLoadLevel, vanilla
 * g_game.c:759/:795 — identity change of state.map = a fresh P_SetupLevel). */
let lastLevelMap: unknown = null;
let lastGamestate = -1;
/** ev_mouse BUTTON mirror (g_game.c:579-580 eats mouse buttons into
 * gamekeydown[key_fire]; the polled channel models held keys — this flag
 * is that model's mouse half: true between mousedown/mouseup). Drives
 * the intermission accelerate rising edge (WI_CheckForAccelerate) and
 * firing in play, exactly like the fire key. */
let mouseFireDown = false;

/** Menu-mode arrow forwarding: bound movement codes NEVER fire event_t
 * packets (keyboard.ts held-channel model) — vanilla's menu arrows ARE
 * those events, so while the menu panel is open the wiring forwards
 * DOM arrow keydown/keyup pairs into the queue (keyup never eaten,
 * g_game.c:571). Typematic repeats fire pairs exactly like the DOS
 * keyboard repeat the vanilla menu relies on. */
const MENU_ARROW_KEYS: Readonly<Record<string, number>> = {
  ArrowUp: KEY_UPARROW,
  ArrowDown: KEY_DOWNARROW,
  ArrowLeft: KEY_LEFTARROW,
  ArrowRight: KEY_RIGHTARROW
};
window.addEventListener('keydown', (e) => {
  if (!menuState.menuActive()) return;
  const key = MENU_ARROW_KEYS[e.code ?? ''];
  if (key !== undefined) eventQueue.push(keydown(key), keyup(key));
});

/** Canvas coords → the 320×200 screen space the menu boxes live in. */
function toScreen(e: MouseEvent): { x: number; y: number } {
  const r = canvasEl.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) * 320) / r.width,
    y: ((e.clientY - r.top) * 200) / r.height
  };
}
canvas.addEventListener('mousemove', (e) => {
  if (!menuState.menuActive()) return;
  const p = toScreen(e);
  menuMouse.hover(p.x, p.y);
});
canvas.addEventListener('mousedown', (e) => {
  const st = boot?.state;
  if (menuState.menuActive()) {
    const p = toScreen(e);
    menuMouse.click(p.x, p.y, e.button);
    return;
  }
  if (st !== undefined && st.gamestate === GS.DEMOSCREEN) {
    // G_Responder demo branch on ev_mouse button-down (g_game.c:524-529)
    // — any mouse button arms the control panel over the attract screen.
    if (gResponderDemo(st, { type: 'mouse', data1: 1 << e.button })) return;
  }
  if (e.button === 0) mouseFireDown = true; // ev_mouse → key_fire mirror
});
// The pointer-lock 'click' half (input/mouse.ts attach, canvas listener)
// only makes sense over a LIVE level; outside it (menu panel, WI, attract)
// a lock request is pure noise — headless chromium even rejects it with a
// console error (WrongDocumentError), which would poison the zero-error
// gate. Registered FIRST (this block runs before mouseInput.attach below)
// so stopImmediatePropagation can silence it exactly when the wiring owns
// the click. Play-state clicks keep the M5 lock behavior untouched.
canvas.addEventListener('click', (e) => {
  const st = boot?.state;
  if (st === undefined) return;
  if (menuState.menuActive() || st.gamestate !== GS.LEVEL) e.stopImmediatePropagation();
});
window.addEventListener('mouseup', (e) => {
  if (e.button === 0) mouseFireDown = false;
});

function stepTic(): void {
  if (boot === null) return;
  const { state, am } = boot;
  const player = state.players[0]!;
  const world = { map: state.map, player };

  // D_ProcessEvents half — the FULL G_Responder chain (d_main.c:326-355,
  // M9-12 wiring): automap first (vanilla d_main.c order; every event, AM
  // eats only its own keys while GS_LEVEL), then the G_Responder demo
  // branch (title.ts — any key arms the control panel on the attract
  // screen), the finale passthrough (f_finale.c:198 — false until the
  // absent cast), the menu stack, then the HU responder (Enter refreshes
  // a message). Consumed events never reach the later stations; keyups
  // are forwarded everywhere (g_game.c:571 never-eat line).
  while (eventQueue.length > 0) {
    const ev = eventQueue.shift()!;
    if (amResponder(am, ev, world)) continue;
    // The demo-screen branch arms the panel on the FIRST key (g_game.c
    // :522-535); once the panel is open the branch must stop eating or
    // the menu would never receive keys (the same net effect vanilla
    // reaches via demoplayback stopping when the panel takes over).
    if (!menuState.menuActive() && gResponderDemo(state, ev)) continue;
    if (state.gamestate === GS.FINALE && fResponder()) continue;
    if (mResponder(state, ev)) continue;
    huResponder(ev);
  }

  // M5-07: mouse channels merge into the same per-tic snapshot — vanilla
  // G_BuildTiccmd reads gamekeydown[] and mousex/mousey at ONE point per
  // tic; sample() drains the deltas (consumed-once, g_game.c:411).
  const input = keyboard.sample();
  const mouse = mouseInput.sample();
  input.mouseX = mouse.mouseX;
  input.mouseY = mouse.mouseY;
  // ev_mouse button mirror (g_game.c:579: mouse1 → gamekeydown[key_fire]).
  if (mouseFireDown) input.attack = true;
  // Menu panel open ⇒ the ticcmd is blank (d_loop.c D_LocalUser2Cmd —
  // vanilla zeroes the command while menuactive; the world itself keeps
  // ticking, matching gTicker — the menu never freezes the sim here).
  let ticInput: GameInput = input;
  if (menuState.menuActive()) ticInput = emptyInput();

  // D013(e) drain (M6 hooks.ts: "M9 drains it into a real level change"
  // — the wiring seam game.ts never grew): the latched exitRequest becomes
  // the real gameaction at the TOP of the next tic, exactly where vanilla
  // G_ExitLevel would have left ga_completed for the gTicker step-2 drain.
  if (state.exitRequest !== 'none') {
    const kind = state.exitRequest;
    state.exitRequest = 'none';
    if (kind === 'secret') gSecretExitLevel(state);
    else gExitLevel(state);
  }

  // d_main.c:381-383 (tic block, before G_Ticker): advancedemo flag
  // consumer + M_Ticker slot (game.ts gFlowTic; M9-04 registers the
  // skull ticker, M9-10 the attract body — no main.ts re-edit needed).
  gFlowTic(state);

  gTicker(state, ticInput);
  amTicker(am, player); // G_Ticker GS_LEVEL automap item (g_game.c)

  // G_Ticker's UI tick halves (g_game.c:729-733: ST_Ticker/HU_Ticker run
  // OUTSIDE the paused gate, every GS_LEVEL tic — the st_face M_Random
  // draw lives in stTicker and is LEDGERED (M9-plan §0.8): exactly ONE
  // call per GS_LEVEL tic, never outside it.
  if (state.gamestate === GS.LEVEL && stCtx !== null) {
    stTicker(stCtx);
    stCtx.automapActive = am.automapactive;
  }
  if (state.gamestate === GS.LEVEL) huTicker(state.players[0]!);

  // ST_Start/HU_Start per G_DoLoadLevel (g_game.c:759/:795) + ST_Stop/
  // HU_Stop when the level ends (G_DoCompleted/S_* leave GS_LEVEL).
  if (state.gamestate === GS.LEVEL && state.map !== lastLevelMap && stCtx !== null) {
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

function render(): void {
  if (boot === null) return;
  const { state, am, palettePlayer } = boot;

  // M9-03 display-block halves (d_main.c:196-222, §0.6):
  // 1) level-change rebuild — G_DoLoadLevel swapped state.map in place;
  //    rebuild the per-map render assets exactly once (the sim-side
  //    loader already stashed pendingMd; M9-09 folds this into the
  //    D_Display composition).
  if (boot.wad !== null && boot.simMap !== state.map && pendingMd !== null) {
    boot.mapName = state.map.name;
    boot.simMap = state.map;
    boot.world = loadRenderWorld(pendingMd, boot.textures, boot.flats, state.sectors);
    boot.mapView = buildRenderMapView(pendingMd);
    boot.sprites = buildMapSprites({ md: pendingMd, map: boot.mapView, wad: boot.wad });
  }
  // §4.1 frame pipeline — M9-09 D_Display composition (displayFrame runs
  // the 3D pass + automap overlay, the window crop, the border halves and
  // the per-state/ST/HU/M drawers through the hooks registered in
  // afterLoad; d_main.c:193-330).
  const wipe = takeWipeRequest(state);
  if (stCtx !== null) stCtx.automapActive = am.automapactive;
  const deps: DisplayDeps = {
    fb,
    world: boot.world,
    map: boot.mapView,
    player: state.players[0]!,
    tables: boot.tables,
    sprites: boot.sprites,
    automap: { state: am, map: state.map, player: state.players[0]! },
    // M7-10: the live psprite layer (gun + muzzle flash over the world,
    // r_things.c R_DrawPlayerSprites) — resolved from the live sim rows
    // through the src/pspriteview.ts seam (same one the goldens use).
    psprites: buildPspriteFrameInput(state.map, state.players[0]!, boot.sprites.sprites),
    state: {
      gamestate: state.gamestate,
      gametic: state.gametic,
      automapactive: am.automapactive,
      viewactive: state.viewactive,
      paused: state.paused,
      menuActive: menuState.menuActive()
    },
    borders: boot.wad !== null ? { wad: boot.wad } : undefined,
    wipe
  };
  displayFrame(deps);
  // ST_doPaletteStuff half (st_stuff.c:1000-1050): the band is a sim value,
  // the LUT swap is the I_SetPalette — and, like vanilla, only on a change.
  boot.luts.setBank(paletteBand(palettePlayer));
  blitToCanvas(ctx, fb, boot.luts.lut);
}

function loop(nowMs: number): void {
  requestAnimationFrame(loop);
  if (lastFrameMs === 0) lastFrameMs = nowMs;
  accumulator += nowMs - lastFrameMs;
  lastFrameMs = nowMs;
  const paused = debugApi.pause(); // __doom.pause() gates the live sim (§7)
  // M9-03 pause gate: the in-game `state.paused` (g_game.c run global,
  // set by the menu layer from M9-04) rides the SAME plumbing — while
  // either is set no tics are pumped (the sim-side p_tick.c:140 guard in
  // gTicker is the headless-path half; harness parity documented).
  const simPaused = boot !== null && boot.state.paused;
  let tics = 0;
  while (!paused && !simPaused && accumulator >= TIC_MS && tics < MAX_CATCHUP_TICS) {
    stepTic();
    accumulator -= TIC_MS;
    tics++;
  }
  if (accumulator > TIC_MS * MAX_CATCHUP_TICS) accumulator = 0; // drop backlog
  render();
}

/* ------------------------------------------------------------------ */
/* Keyboard                                                             */
/* ------------------------------------------------------------------ */

const keyboard = createKeyboardInput({
  target: window,
  // KEY_MAPENTER wiring (additive keyboard.ts feature): event-level keys
  // (Tab ⇒ doomdef.h KEY_TAB = 9) arrive as vanilla event_t pairs; queue
  // them for the per-tic D_ProcessEvents drain.
  onEvent: (ev) => {
    eventQueue.push(ev.type === 'keydown' ? keydown(ev.data1) : keyup(ev.data1));
  }
});

/* ------------------------------------------------------------------ */
/* Mouse (M5-07) — pointer-lock translation seam                        */
/* ------------------------------------------------------------------ */

// Canvas click captures the pointer (browser-native; Esc releases it —
// UI-only, no sim state). mousemove.movementX/Y feed the raw ev_mouse
// accumulator ONLY while locked; sensitivity scaling + once-per-tic drain
// live in input/mouse.ts (translation seam, unit-tested with FAKE
// pointer-lock events — headless-chromium pointer lock is unreliable,
// M5-plan §6, so real-lock behavior is an honest L4 subset, not gated on).
// M5-08: the lock mirror reads `document.pointerLockElement` (the DOM
// property lives on document, NOT window — the M5-07 window target would
// have read undefined and locked OUT every real lock change); e2e drives
// the same seam with dispatched pointerlockchange/mousemove events.
const mouseInput = createMouseInput();
mouseInput.attach(
  document as unknown as Parameters<typeof mouseInput.attach>[0],
  canvas
);
// __doom.sim.injectMouse(dx,dy) (M5-08, plan §M5-08 owns-list): feed the
// SAME raw ev_mouse accumulator the locked mousemove path feeds, bypassing
// only the lock GATE (headless pointer lock is unreliable — §6). Scaling,
// accumulation across tics and the consumed-once drain stay on the real
// per-tic sample() path.
attachMouseInjection((dx, dy) => {
  const was = mouseInput.locked();
  mouseInput.setLocked(true);
  mouseInput.motion(dx, dy);
  mouseInput.setLocked(was);
});

// M6-13 finding 3 seam: __doom.popInput() — drain the D_ProcessEvents
// queue (stepTic's once-per-tic half, main.ts eventQueue) and the raw
// mouse accumulator, returning what was dropped. e2e phases that drive
// sim.runTics under pause(true) call it between phases so queued events
// never flood the first live tics after pause(false).
attachPopInput(() => {
  const events = eventQueue.length;
  eventQueue.length = 0;
  const mouse = mouseInput.pending();
  mouseInput.sample(); // drain the accumulator (consumed-once; discarded)
  return { events, mouse };
});

/* ------------------------------------------------------------------ */
/* WAD boot + 404 → file-picker fallback (viewer pattern)               */
/* ------------------------------------------------------------------ */

function afterLoad(buf: ArrayBuffer, src: string): void {
  const wad = WadFile.parse(buf);
  wadFile = wad; // M9-03 levelLoader seam (registered above, reads it lazily)
  const md = loadMap(wad, 'E1M1');
  pendingMd = md;
  const map = buildMapFromData(md);
  const state = gInitGame(map);
  // M7-06: damagecount is the one palette/powerup field the merged inventory
  // attach (p_inter_inventory) does not carry; P_DamageMobj (M7 damage) owns
  // the writes, this attach only makes the field exist from frame 0.
  const palettePlayer = attachPowerupFields(state.players[0]!);
  // M7-06 sfx slots: the two sites that can fire today (the p_inter.c pickup
  // tail and p_pspr.c's ten S_StartSound(player->mo, …) lines) enqueue into
  // the M6-01 hook ring; M10 replaces the slot BODIES, never these call
  // sites (psound_stub.ts holds the complete site ledger for the audio port).
  installPickupSfxBridge(state.hooks, () => state.leveltime);
  installPsprSfxSlot(state.hooks, () => state.leveltime);
  const luts = new PaletteLuts(decodePlaypal(wad.readLumpByName('PLAYPAL')));

  // Render world built ONCE (M3-07): SoA tables + BSP view + wad light
  // tables (R_InitColormaps half: COLORMAP lump → scalelight rows). M4-07
  // adds the two data halves the full frame needs: the F_START/F_END flats
  // (R_InitFlats — planes/sky never touch names) and the once-per-map sprite
  // tables (census → lump decode → the mobj-less static thing list).
  // M6-13 live-sector wiring (M6-09 gap, plan §3.5 state-seam read): the
  // render world's floor/ceiling/light arrays ARE the live SoA — movers
  // and light thinkers mutate state.sectors in place, every frame sees
  // them with zero copy. Static frames stay byte-identical (live ==
  // static until a special runs; liveview/walls goldens unmoved).
  const textures = texturesFromWad(wad);
  const flats = flatsFromWad(wad);
  const world = loadRenderWorld(md, textures, flats, state.sectors);
  const mapView = buildRenderMapView(md);
  const tables = initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')));
  const sprites = buildMapSprites({ md, map: mapView, wad });

  const am = amCreateState();
  // M3-07: automap starts OFF — the 3D walls view owns the frame; Tab
  // toggles the amMap state (renderFrame overlays when active).

  debugSim.attach(state); // __doom.sim drives the same live state
  // M4-07: the full counter set (hom + the four overflow counters) feeds
  // state().render (renderer.ts getFrameCounters seam).
  attachRenderDebug({ indices: fb.indices, counters: getFrameCounters });
  boot = { state, am, luts, palettePlayer, world, textures, flats, mapView, tables, sprites, wad, mapName: map.name, simMap: map };

  // ---- M9 UI-stack boot (M9-12 wiring; see the wiring block above) ----
  // vInit BEFORE stInit (the BG 320×32 canvas requirement, st_init) and
  // BEFORE the FG alias binding displayFrame re-checks every frame.
  vInit(fb.indices);
  mSetWad(wad);
  mInit(); // M_Init (+ shareware EpiDef censor) — before mRegisterFlow
  mRegisterFlow(); // the d_main.c:382 M_Ticker slot
  dSetWad(wad);
  fSetWad(wad);
  huSetWad(wad);
  stInit(wad); // ST_loadGraphics (faces/widgets/numbers) — per-IWAD, once
  const st: StContext = {
    rng: state.rng,
    // The LIVE player object: initPlayerInventory/attachPsprFields/gInitGame
    // attach the StPlayerView field pack in place (debug.ts reads the same
    // fields structurally) — the cast is the typing seam, not a copy.
    player: state.players[0] as unknown as StPlayerView,
    automapActive: false,
    pointToAngle2: rPointToAngle2,
    setPaletteBand: (band) => luts.setBank(band) // I_SetPalette half
  };
  stCtx = st;
  wiSrc = wadWiPatches(wad);
  registerDisplayHooks({
    // REORDER CONTRACT (renderer.ts DisplayHooks): the 3D pass covers the
    // bar rows, so the wiring restores BG→FG every windowed frame — what
    // vanilla's ST_refreshBackground copy does (widget diff/erase stays
    // byte-faithful; forcing refresh here would not).
    stDrawer: (fullscreen, refresh) => {
      if (stCtx === null) return;
      if (!fullscreen) stRefreshBackground(stCtx);
      stDrawer(stCtx, fullscreen, refresh);
    },
    huDrawer: (automapactive) => huDrawer(automapactive),
    wiDrawer: () => {
      if (wiSrc !== null) wiDrawFrame(wiSrc, wiDrawSnapshot());
    },
    finaleDrawer: () => fDrawer(),
    pageDrawer: () => dPageDrawer(),
    mDrawer: () => mDrawer()
    // pausedPatch (M_PAUSE stamp) unregistered: freedoom carries no
    // M_PAUSE and no M9 module owns the stamp — d_main.c:310-316 visual,
    // M10+ (displayStubHits never counts an undefined hook).
  });
  attachUiDebug(() => {
    const st = boot?.state;
    if (st === undefined) return null;
    const w = wiPeek();
    return {
      screen: screenRead(st),
      menu: {
        active: menuState.menuActive(),
        inHelpScreens: menuState.inHelpScreens(),
        menuName: menuState.currentMenuName(),
        itemOn: menuState.itemOn(),
        whichSkull: menuState.whichSkull(),
        messageToPrint: menuState.messageToPrint(),
        screenBlocks: menuState.screenBlocks(),
        mouseSensitivity: menuState.mouseSensitivity(),
        detailLevel: menuState.detailLevel(),
        itemBoxes: menuState.itemBoxes()
      },
      hud: {
        faceIndex: stFaceIndex(),
        faceCount: ST_NUMFACES,
        message: huMessageText(),
        showMessages: huState.showMessages,
        statusbarOn: stStatusbarOn()
      },
      title: {
        demosequence: titleState.demosequence(),
        pagetic: titleState.pagetic(),
        pagename: titleState.pagename()
      },
      finale: { stage: finaleState.finalestage(), count: finaleState.finalecount() },
      wi: {
        active: w.active,
        phase: w.phase,
        bcnt: w.bcnt,
        epsd: w.epsd,
        accelerateStage: w.accelerateStage,
        spState: w.spState,
        last: w.last,
        next: w.next
      }
    };
  });
  // Vanilla boot order mirror: G_InitNew (ST_Start + HU_Start happened
  // inside gInitGame's path for the loaded E1M1) BEFORE D_StartTitle, the
  // D_DoomMain tail (d_main.c:1166) — the attract takes over on the FIRST
  // consumed tic (gFlowTic → D_DoAdvanceDemo → TITLEPIC, pagetic 170).
  stStart(st);
  huStart(state.gameepisode, state.gamemap);
  lastLevelMap = state.map;
  lastGamestate = state.gamestate;
  dInit(state);

  status.hidden = true;
  picker.hidden = true;
  console.info(`doom-ts: booted ${map.name} from ${src}`);
}

function showPicker(why: string): void {
  status.textContent = `${why} — pick a WAD file:`;
  picker.hidden = false;
}

picker.addEventListener('change', () => {
  const file = picker.files?.[0];
  if (file === undefined) return;
  status.textContent = `loading ${file.name}…`;
  void file.arrayBuffer().then(
    (buf) => afterLoad(buf, `file:${file.name}`),
    (err: unknown) => showPicker(String(err))
  );
});

installDebugApi();
void fetchWad(wadUrl).then(
  (buf) => afterLoad(buf, wadUrl),
  (err: unknown) => {
    if (err instanceof WadLoadError) showPicker(`${wadUrl} not available`);
    else throw err; // decoder bugs must stay visible
  }
);
requestAnimationFrame(loop);
