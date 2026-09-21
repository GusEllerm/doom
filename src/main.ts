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
  gFlowTic,
  gInitGame,
  gTicker,
  registerGameFlowHooks,
  takeWipeRequest,
  TICS_PER_SECOND
} from './sim/game';
import { mapNameFor } from './sim/gamemode';
import { buildMapFromData } from './sim/map';
import type { GameState } from './sim/state';
import { attachRenderDebug, attachMouseInjection, attachPopInput, debugApi, debugSim, installDebugApi } from './debug';
import { blitToCanvas, Framebuffer, PaletteLuts } from './render/framebuffer';
import { attachPowerupFields, paletteBand } from './sim/ppalette';
import { installPickupSfxBridge, installPsprSfxSlot } from './sim/psound_stub';
import { buildMapSprites, getFrameCounters, renderFrame, type FrameDeps, type SpriteTables } from './render/renderer';
import { buildPspriteFrameInput } from './pspriteview';
import { flatsFromWad, loadRenderWorld, type RenderWorld } from './render/rdata';
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

function stepTic(): void {
  if (boot === null) return;
  const { state, am } = boot;
  const player = state.players[0]!;
  const world = { map: state.map, player };

  // D_ProcessEvents half: AM_Responder sees every event first (vanilla
  // d_main.c order); consumed events never reach G_Responder. Movement is
  // the separate polled-GameInput seam (M2-07 design) — DEVIATION, pinned
  // in the task report: in FREE map mode vanilla also swallows the arrow
  // keys from movement, here the polled channel stays live; in FOLLOW mode
  // (the default) behavior matches vanilla because AM_Responder itself
  // returns rc=false for arrows while following.
  while (eventQueue.length > 0) {
    amResponder(am, eventQueue.shift()!, world);
  }

  // M5-07: mouse channels merge into the same per-tic snapshot — vanilla
  // G_BuildTiccmd reads gamekeydown[] and mousex/mousey at ONE point per
  // tic; sample() drains the deltas (consumed-once, g_game.c:411).
  const input = keyboard.sample();
  const mouse = mouseInput.sample();
  input.mouseX = mouse.mouseX;
  input.mouseY = mouse.mouseY;

  // d_main.c:381-383 (tic block, before G_Ticker): advancedemo flag
  // consumer + M_Ticker slot (game.ts gFlowTic; M9-04 registers the
  // skull ticker, M9-10 the attract body — no main.ts re-edit needed).
  gFlowTic(state);

  gTicker(state, input);
  amTicker(am, player); // G_Ticker GS_LEVEL automap item (g_game.c)
}

function render(): void {
  if (boot === null) return;
  const { state, am, palettePlayer } = boot;

  // M9-03 display-block halves (d_main.c:196-222, §0.6):
  // 1) level-change rebuild — G_DoLoadLevel swapped state.map in place;
  //    rebuild the per-map render assets exactly once (the sim-side
  //    loader already stashed pendingMd; M9-09 folds this into the
  //    D_Display composition).
  if (boot.wad !== null && boot.mapName !== state.map.name && pendingMd !== null) {
    boot.mapName = state.map.name;
    boot.world = loadRenderWorld(pendingMd, texturesFromWad(boot.wad), flatsFromWad(boot.wad), state.sectors);
    boot.mapView = buildRenderMapView(pendingMd);
    boot.sprites = buildMapSprites({ md: pendingMd, map: boot.mapView, wad: boot.wad });
  }
  // 2) wipe sentinel — consumed EXACTLY ONCE per gamestate change
  //    (takeWipeRequest returns true on the consuming frame only; the
  //    f_wipe melt body registers via the game.ts `wipe` hook, M9-01/09).
  takeWipeRequest(state);

  // §4.1 frame pipeline (renderer.ts): 3D walls always run; the automap
  // overlays afterwards ONLY when its state is active (Tab toggles the
  // state through amResponder in stepTic — the drawing path is stateless).
  const deps: FrameDeps = {
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
  };
  renderFrame(deps);
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
  while (!(paused || simPaused) && accumulator >= TIC_MS && tics < MAX_CATCHUP_TICS) {
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
  const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad), state.sectors);
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
  boot = { state, am, luts, palettePlayer, world, mapView, tables, sprites, wad, mapName: map.name };
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
