/**
 * M9-11 — shared L3 golden-corpus harness (plan §M9-11).
 *
 * Everything the three m9*.test.ts files need to produce FULL production
 * frames — the same rAF-driver shape main.ts runs (tic block gFlowTic →
 * gTicker → ST/HU tickers → displayFrame composition, d_main.c:193-330)
 * — plus the screens/walls-style dump-or-assert plumbing against the
 * `m9` goldens set (tests/render/goldens/m9/meta.json, driven by
 * scripts/goldens-update.mjs --set m9).
 *
 * Modes (identical convention to walls/screens.test.ts):
 *   GOLDENS_MODE=update + GOLDENS_DUMP_DIR → dump bin/json, skip sha
 *   GOLDENS_MODE=check or unset            → assert sha vs meta.json
 * WAD-GATED: every scene draws real freedoom1.wad art (ST, WI, M_ and
 * TITLEPIC patches, E1M1 textures), so without a wad nothing dumps and
 * committed goldens stay untouched.
 *
 * Buffer discipline (M9-09 composition contract, renderer.ts header):
 * ONE shared Framebuffer per test file — vInit binds screens[0] to it and
 * every drawer (ST widgets, HU messages, WI pages, menu, page/finale)
 * draws through the aliased layers. vInit is therefore called ONCE per
 * process (videoInitOnce): re-running it would reallocate screens[1] (the
 * FillBackScreen/WI back buffer) under cached graphics. WI scenes dodge
 * the wiLoadData cache entirely by passing a FRESH wadWiPatches source per
 * frame (documented in the wiDraw.ts seam contract).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap, decodePlaypal } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { buildMapFromData, type RuntimeMap } from '../../src/sim/map';
import {
  gFlowTic,
  gInitGame,
  gTicker,
  registerGameFlowHooks,
  resetGameFlow,
  type GameFlowHooks,
} from '../../src/sim/game';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { rPointToAngle2 } from '../../src/sim/p_shoot';
import type { GameState } from '../../src/sim/state';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld, type RenderWorld } from '../../src/render/rdata';
import {
  buildMapSprites,
  displayFrame,
  registerDisplayHooks,
  resetDisplayHooks,
  resetDisplayStatics,
  resetDisplayStubHits,
  type DisplayHooks,
  type DisplayState,
  type SpriteTables,
} from '../../src/render/renderer';
import { buildRenderMapView, executeSetViewSize, setViewSize } from '../../src/render/view';
import { resetBorderStats } from '../../src/render/borders';
import { vInit } from '../../src/render/vvideo';
import {
  stDrawer,
  stInit,
  stRefreshBackground,
  stResetAll,
  stStart,
  stTicker,
  type StContext,
} from '../../src/ui/statusbar';
import { huDrawer, huSetWad, huStart, huTicker } from '../../src/ui/humessage';
import type { LightTables } from '../../src/render/lights';
import type { RenderMapView } from '../../src/render/view';

import { degToBam } from '../render/viewpoints';

/* ------------------------------------------------------------------ */
/* wad discovery + shared bundle                                        */
/* ------------------------------------------------------------------ */

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

export const WAD_PATH = findWad();
export const hasWad = WAD_PATH !== undefined;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function iwad(): WadFile {
  if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
  return WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
}

export interface Bundle {
  readonly wad: WadFile;
  readonly sim: RuntimeMap;
  readonly world: RenderWorld;
  readonly view: RenderMapView;
  readonly tables: LightTables;
  readonly sprites: SpriteTables;
  /** PLAYPAL palette 0 as 768 RGB ints (patches are full-bright). */
  readonly paletteRgb: number[];
}

let bundle: Bundle | null = null;

export function bundle_(): Bundle {
  if (bundle === null) {
    const wad = iwad();
    const md = loadMap(wad, 'E1M1');
    const view = buildRenderMapView(md);
    const playpal = decodePlaypal(wad.readLumpByName('PLAYPAL')!);
    const paletteRgb: number[] = [];
    for (let i = 0; i < 256; i++) {
      const rgba = playpal[i]!;
      paletteRgb.push(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff);
    }
    bundle = {
      wad,
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad)),
      view,
      tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!)),
      sprites: buildMapSprites({ md, map: view, wad }),
      paletteRgb,
    };
  }
  return bundle;
}

/* ------------------------------------------------------------------ */
/* shared framebuffer + one-time video init                             */
/* ------------------------------------------------------------------ */

export const sharedFb = new Framebuffer();

let videoReady = false;
export function videoInitOnce(): void {
  if (videoReady) return;
  vInit(sharedFb.indices);
  videoReady = true;
}

/* ------------------------------------------------------------------ */
/* golden plumbing (dump / sha-vs-meta)                                 */
/* ------------------------------------------------------------------ */

export const META_PATH = fileURLToPath(new URL('../render/goldens/m9/meta.json', import.meta.url));
export const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
export const MODE = process.env['GOLDENS_MODE'] ?? '';

export function sha256Of(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface SceneFrame {
  /** the captured 320×200 index buffer */
  readonly bytes: Uint8Array;
  /** hom of the LAST 3D pass (undefined ⇒ frame had no 3D pass) */
  readonly hom?: number;
  /** extra provenance for meta.json */
  readonly viewpoint?: string;
}

/**
 * Run a scene TWICE (fresh driver each run — every module-static reset
 * lives inside M9Driver/the scene body) and:
 *   1. assert byte-equality (determinism pin),
 *   2. assert hom === 0 on every frame that carried a 3D pass,
 *   3. dump (update mode) or sha-assert vs goldens/m9/meta.json.
 */
export function goldenScene(name: string, script: string, run: () => SceneFrame): void {
  const a = run();
  const b = run();
  expect(sha256Of(b.bytes), `${name}: double-run determinism`).toBe(sha256Of(a.bytes));
  if (a.hom !== undefined) {
    expect(a.hom, `${name}: HOM (3D pass)`).toBe(0);
  }
  const sha = sha256Of(a.bytes);
  if (DUMP_DIR !== null) {
    const { paletteRgb } = bundle_();
    writeFileSync(`${DUMP_DIR}/${name}.bin`, a.bytes);
    writeFileSync(
      `${DUMP_DIR}/${name}.json`,
      JSON.stringify(
        {
          name,
          kind: 'iwad-frame',
          script,
          ...(a.viewpoint === undefined ? {} : { viewpoint: a.viewpoint }),
          ...(a.hom === undefined ? {} : { hom: a.hom }),
          width: 320,
          height: 200,
          indexSha256: sha,
          paletteRgb,
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (MODE !== 'update') {
    const meta = existsSync(META_PATH)
      ? (JSON.parse(readFileSync(META_PATH, 'utf8')) as {
          scenes?: Record<string, { indexSha256?: string }>;
        })
      : {};
    expect(meta.scenes?.[name]?.indexSha256, `${name}: sha vs committed golden`).toBe(sha);
  }
}

/* ------------------------------------------------------------------ */
/* The frame driver                                                     */
/* ------------------------------------------------------------------ */

export interface Warp {
  readonly x: number;
  readonly y: number;
  readonly deg: number;
}

/** renderer.test.ts a2 viewpoints (same sampled E1M1 camera set). */
export const VIEWPOINTS = {
  'spawn-east': { x: -416, y: 256, deg: 0 },
  'busy-mix': { x: 2400, y: 1152, deg: 180 },
  atrium: { x: 1472, y: 1088, deg: 270 },
  'vista-corridor': { x: 960, y: -192, deg: 0 },
} as const satisfies Record<string, Warp>;

export interface LevelOpts {
  /** screenblocks (production default 9, m_misc.c:279) */
  readonly sb?: number;
  /** register ST_Drawer + tick ST_Ticker (default true) */
  readonly bar?: boolean;
  /** register HU_Drawer + tick HU_Ticker (default true) */
  readonly hu?: boolean;
  /** extra flow hooks (wiTicker/doCompleted/mTicker/…) */
  readonly flow?: Partial<GameFlowHooks>;
}

/**
 * One scripted level boot through the production driver. Per tic (main.ts
 * stepTic order): gFlowTic (tic block) → gTicker (sim) → HU/ST tickers
 * (g_game.c:729-733 sites); displayFrame composes D_Display on demand.
 */
export class M9Driver {
  readonly state: GameState;
  readonly ctx: StContext;
  private readonly b: Bundle;
  private readonly withBar: boolean;
  private readonly withHu: boolean;

  constructor(b: Bundle, warp: Warp, opts: LevelOpts = {}) {
    this.b = b;
    this.withBar = opts.bar ?? true;
    this.withHu = opts.hu ?? true;

    resetGameFlow();
    if (opts.flow !== undefined) registerGameFlowHooks(opts.flow);
    resetDisplayStatics();
    resetDisplayHooks();
    resetDisplayStubHits();
    resetBorderStats();
    videoInitOnce();

    const st = gInitGame(b.sim);
    const mo = st.players[0]!.mo;
    mo.x = (warp.x * FRACUNIT) | 0;
    mo.y = (warp.y * FRACUNIT) | 0;
    mo.angle = degToBam(warp.deg);

    setViewSize(opts.sb ?? 9, 0);
    executeSetViewSize();

    // The sim's runtime player object carries the full d_player.h shape;
    // the sim/state TYPE splits it across interfaces, so the structural
    // read-view bind needs the (type-only) cast — zero runtime effect.
    const livePlayer = st.players[0] as unknown as StContext['player'];
    if (this.withBar) {
      stResetAll(); // wipe cross-scene widget/face statics FIRST
      stInit(b.wad); // (stResetAll clears the STTMINUS/graphics binds)
      this.ctx = {
        rng: st.rng,
        player: livePlayer,
        pointToAngle2: rPointToAngle2,
      };
      stStart(this.ctx);
    } else {
      this.ctx = { rng: st.rng, player: livePlayer };
    }
    if (this.withHu) {
      huSetWad(b.wad);
      huStart(st.gameepisode, st.gamemap);
    }

    const hooks: DisplayHooks = {};
    if (this.withBar) {
      // REORDER CONTRACT (renderer.ts DisplayHooks.stDrawer): the 3D pass
      // dirties the bar rows, so restore BG→FG every windowed frame —
      // vanilla's ST_refreshBackground copy, refresh flag stays vanilla.
      hooks.stDrawer = (fullscreen, refresh) => {
        if (!fullscreen) stRefreshBackground(this.ctx);
        stDrawer(this.ctx, fullscreen, refresh);
      };
    }
    if (this.withHu) hooks.huDrawer = (automapactive) => huDrawer(automapactive);
    registerDisplayHooks(hooks);

    this.state = st;
  }

  /** One production tic (NO render). */
  tic(input: GameInput = emptyInput()): void {
    gFlowTic(this.state);
    gTicker(this.state, input);
    if (this.withHu) huTicker(this.state.players[0]!);
    if (this.withBar) stTicker(this.ctx);
  }

  /** Tic-block half ONLY (M_Ticker/advancedemo) — the menu-open shape:
   * vanilla G_Ticker skips the sim half while menuactive (g_game.c:651). */
  flowTic(): void {
    gFlowTic(this.state);
  }

  /** D_Display half: compose one full frame (NO tic advance). */
  display(over: Partial<DisplayState> = {}): ReturnType<typeof displayFrame> {
    const st = this.state;
    return displayFrame({
      fb: sharedFb,
      world: this.b.world,
      map: this.b.view,
      player: st.players[0]!,
      tables: this.b.tables,
      sprites: this.b.sprites,
      borders: { wad: this.b.wad },
      state: {
        gamestate: st.gamestate,
        gametic: st.gametic,
        automapactive: false,
        viewactive: st.viewactive,
        paused: st.paused,
        ...over,
      },
    });
  }

  /** tic + display + capture */
  frame(input: GameInput = emptyInput(), over: Partial<DisplayState> = {}): SceneFrame {
    this.tic(input);
    const r = this.display(over);
    return {
      bytes: sharedFb.indices.slice(),
      ...(r.counters === undefined ? {} : { hom: r.counters.hom }),
    };
  }

  capture(): SceneFrame {
    return { bytes: sharedFb.indices.slice() };
  }
}

/* ------------------------------------------------------------------ */
/* describe helper                                                      */
/* ------------------------------------------------------------------ */

export function m9Describe(name: string, fn: () => void): void {
  describe.skipIf(!hasWad)(name, fn);
}
