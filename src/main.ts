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
  amCreateState,
  amResponder,
  amTicker,
  keydown,
  keyup,
  type AutomapEvent
} from './sim/amMap';
import { gInitGame, gTicker, TICS_PER_SECOND } from './sim/game';
import { buildMapFromData } from './sim/map';
import type { GameState } from './sim/state';
import { attachRenderDebug, debugApi, debugSim, installDebugApi } from './debug';
import { blitToCanvas, buildLut, Framebuffer } from './render/framebuffer';
import { buildMapSprites, getFrameCounters, renderFrame, type FrameDeps, type SpriteTables } from './render/renderer';
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
  readonly am: ReturnType<typeof amCreateState>;
  readonly lut: Uint32Array;
  /** Render world + BSP view + light tables: built ONCE here (M3-07 "load
   * render world once"), reused by every frame's deps bundle. */
  readonly world: RenderWorld;
  readonly mapView: RenderMapView;
  readonly tables: LightTables;
  /** M4-07: the once-per-map static thing/sprite tables (rthings census +
   * decoded patches); the frame's sprite pass caches off these. */
  readonly sprites: SpriteTables;
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

  gTicker(state, keyboard.sample());
  amTicker(am, player); // G_Ticker GS_LEVEL automap item (g_game.c)
}

function render(): void {
  if (boot === null) return;
  const { state, am } = boot;
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
  };
  renderFrame(deps);
  blitToCanvas(ctx, fb, boot.lut);
}

function loop(nowMs: number): void {
  requestAnimationFrame(loop);
  if (lastFrameMs === 0) lastFrameMs = nowMs;
  accumulator += nowMs - lastFrameMs;
  lastFrameMs = nowMs;
  const paused = debugApi.pause(); // __doom.pause() gates the live sim (§7)
  let tics = 0;
  while (!paused && accumulator >= TIC_MS && tics < MAX_CATCHUP_TICS) {
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
/* WAD boot + 404 → file-picker fallback (viewer pattern)               */
/* ------------------------------------------------------------------ */

function afterLoad(buf: ArrayBuffer, src: string): void {
  const wad = WadFile.parse(buf);
  const md = loadMap(wad, 'E1M1');
  const map = buildMapFromData(md);
  const state = gInitGame(map);
  const lut = buildLut(decodePlaypal(wad.readLumpByName('PLAYPAL')), 0);

  // Render world built ONCE (M3-07): SoA tables + BSP view + wad light
  // tables (R_InitColormaps half: COLORMAP lump → scalelight rows). M4-07
  // adds the two data halves the full frame needs: the F_START/F_END flats
  // (R_InitFlats — planes/sky never touch names) and the once-per-map sprite
  // tables (census → lump decode → the mobj-less static thing list).
  const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad));
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
  boot = { state, am, lut, world, mapView, tables, sprites };
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
