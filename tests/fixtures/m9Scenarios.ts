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
  gExitLevel,
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
  displayStubHits,
  registerDisplayHooks,
  resetDisplayHooks,
  resetDisplayStatics,
  resetDisplayStubHits,
  type DisplayHooks,
  type DisplayState,
  type SpriteTables,
} from '../../src/render/renderer';
import { wadWiPatches, wiDrawer } from '../../src/render/wiDraw';
import {
  mDrawer,
  mResponder,
  mReset,
  mStartControlPanel,
  mTicker,
} from '../../src/ui/menu';
import { dInit, dPageDrawer, dRegisterFlow, dReset, dSetWad } from '../../src/ui/title';
import { fDrawer, fReset, fSetWad, fStartFinale, fTicker } from '../../src/ui/finale';
import {
  gDoCompleted,
  wiDrawSnapshot,
  wiPeek,
  wiResetPlayerFlags,
  wiTicker,
} from '../../src/sim/wintermission';
import type { PickupPlayer } from '../../src/sim/p_inter_inventory';
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

/* ------------------------------------------------------------------ */
/* M9-13 SCENE LIBRARY (D016 montage pack support)                       */
/*                                                                      */
/* The m9*.test.ts scene builders, lifted VERBATIM to this shared        */
/* fixture so the M9-13 exit montage tiles the EXACT blessed scenes      */
/* (provenance: cell region hash == blessed scene sha). Behaviour,       */
/* statics resets and draw order are unchanged — the golden corpus       */
/* re-hashes byte-identical after the move.                              */
/* ------------------------------------------------------------------ */

/** No D_Display drawer hook was missing during the composed frame. */
export function expectNoMissingDrawer(): void {
  expect(displayStubHits.count, 'all D_Display drawers registered').toBe(0);
}

/** The LIVE player object carries the inventory slice (p_inter_inventory);
 * sim/state's view type splits the fields across interfaces, so scripted
 * mutations bind through this (type-only) intersection. */
export type ScenePlayer = PickupPlayer;

export type BarMutator = (p: ScenePlayer, t: number) => void;

/** statusbar 8-variant matrix (m9hud scene table; order == bless order). */
export const BAR_VARIANTS: readonly (readonly [string, number, BarMutator])[] = [
  // health tier 0 + all six keys + pistol/shotgun/chaigun, shells+cells
  [
    'bar-100-keys-arsenal',
    5,
    (p) => {
      p.health = 100;
      p.cards.fill(1);
      p.weaponowned[0] = 1;
      p.weaponowned[1] = 1;
      p.weaponowned[2] = 1;
      p.weaponowned[3] = 1;
      p.readyweapon = 2;
      p.ammo[1] = 36;
      p.ammo[2] = 120;
      p.armorpoints = 50;
    },
  ],
  // tier 1 (75) + green armor + full bullets (chaingun ready)
  [
    'bar-075-armor-clip',
    5,
    (p) => {
      p.health = 75;
      p.armorpoints = 100;
      p.weaponowned[1] = 1;
      p.weaponowned[3] = 1;
      p.readyweapon = 3;
      p.ammo[0] = 50;
    },
  ],
  // tier 2 (50) + plasma rifle + cells (maxammo widget nonzero)
  [
    'bar-050-cells',
    5,
    (p) => {
      p.health = 50;
      p.weaponowned[1] = 1;
      p.weaponowned[5] = 1;
      p.readyweapon = 5;
      p.ammo[2] = 12;
      p.maxammo[2] = 300;
    },
  ],
  // tier 3 (25) + shotgun, 8 shells (low-ammo widget)
  [
    'bar-025-shells',
    5,
    (p) => {
      p.health = 25;
      p.weaponowned[1] = 1;
      p.weaponowned[2] = 1;
      p.readyweapon = 2;
      p.ammo[1] = 8;
    },
  ],
  // evil grin (face rule R2): bonuscount + freshly-owned weapon
  [
    'bar-grin-weapon',
    5,
    (p, t) => {
      p.health = 100;
      if (t >= 2) p.weaponowned[2] = 1; // ownership flip after ST_Start
      p.bonuscount = 11;
    },
  ],
  // attacked turn face (R3): tier 3 + live attacker off to the left
  [
    'bar-attacked-left',
    4,
    (p) => {
      p.health = 25;
      p.damagecount = 50;
      p.attacker = {
        x: p.mo.x - 128 * 65536,
        y: p.mo.y + 128 * 65536,
        angle: 0,
      } as unknown as ScenePlayer['attacker'];
    },
  ],
  // god face (R6): invulnerability power + rocket launcher, rockets 5
  [
    'bar-god-invul',
    5,
    (p) => {
      p.health = 100;
      p.powers[0] = 2000; // pw_invulnerability
      p.weaponowned[1] = 1;
      p.weaponowned[4] = 1;
      p.readyweapon = 4;
      p.ammo[3] = 5;
    },
  ],
  // dead face (R1): health 0, fist ready (the post-death bar)
  [
    'bar-dead-fist',
    5,
    (p) => {
      p.health = 0;
      p.weaponowned[0] = 1;
      p.readyweapon = 0;
    },
  ],
];

/** Script the LIVE player through the widget/face-machine reads; the
 * mutate runs EVERY tic before the tickers so the scripted state survives
 * whatever the (deterministic) world does in between. */
export function barScene(
  tics: number,
  mutate: BarMutator,
): () => SceneFrame {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb: 9 });
    for (let t = 0; t < tics; t++) {
      mutate(d.state.players[0] as ScenePlayer, t);
      d.tic();
    }
    const frame = d.frame();
    expectNoMissingDrawer();
    return frame;
  };
}

/** HU message strip: player.message set @tic2, captured at captureAt. */
export function msgScene(captureAt: number): () => SceneFrame {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb: 9 });
    for (let t = 0; t < captureAt; t++) {
      if (t === 2) d.state.players[0]!.message = 'GOTMEDINEED';
      d.tic();
    }
    const frame = d.frame();
    expectNoMissingDrawer();
    return frame;
  };
}

/** sb-variant viewport pair (and the monster-pixel strip via a warp). */
export function viewScene(sb: number, warp: Warp = VIEWPOINTS['spawn-east']): () => SceneFrame {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, warp, { sb });
    for (let t = 0; t < 5; t++) d.tic();
    const frame = d.frame();
    expectNoMissingDrawer();
    return frame;
  };
}

/** TITLEPIC page through the D_Display demoscreen branch (no 3D pass). */
export function titleScene(): () => SceneFrame {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { bar: false, hu: false });
    dReset(b.wad);
    dRegisterFlow();
    dSetWad(b.wad);
    dInit(d.state); // D_StartTitle arms advancedemo
    d.flowTic(); // the tic block consumes it -> TITLEPIC page (d_main.c:454)
    registerDisplayHooks({ pageDrawer: dPageDrawer });
    const r = d.display();
    expect(r.counters, 'demoscreen draws no 3D pass').toBeUndefined();
    expectNoMissingDrawer();
    return d.capture(); // pageDrawer draws the full 320x200 page, no 3D
  };
}

/** Boot, open the control panel, run a key script, settle 6 skull tics,
 * capture the composed frame (menu drawn LAST over the live level). */
export function menuScene(keys: readonly number[]): () => SceneFrame {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb: 9 });
    for (let t = 0; t < 5; t++) d.tic();
    mReset(b.wad); // full cross-scene reset (menu table statics,
    // lastOn cursors, screenblocks) + mInit inside
    registerGameFlowHooks({ mTicker: (st) => mTicker(st) });
    registerDisplayHooks({ mDrawer });
    mStartControlPanel(d.state);
    for (const k of keys) {
      mResponder(d.state, { type: 'keydown', data1: k });
      mResponder(d.state, { type: 'keyup', data1: k });
    }
    for (let t = 0; t < 6; t++) d.flowTic(); // M_Ticker ONLY (sim frozen)
    const r = d.display({ menuActive: true });
    expectNoMissingDrawer();
    return {
      ...d.capture(),
      ...(r.counters === undefined ? {} : { hom: r.counters.hom }),
    };
  };
}

export interface Tally {
  readonly kills?: number;
  readonly items?: number;
  readonly secrets?: number;
  readonly leveltime?: number;
  readonly totalkills?: number;
  readonly totalitems?: number;
  readonly totalsecret?: number;
}

/** Boot E1M1, stage the census the way P_SetupLevel would, exit; the
 * returned driver sits in GS_INTERMISSION with the wiDrawer hook wired
 * (FRESH wadWiPatches source per frame — sidesteps the wiLoadData back-
 * buffer cache across scenes, see the wiDraw.ts seam contract). */
export function wiBoot(tally: Tally): M9Driver {
  const b: Bundle = bundle_();
  const d = new M9Driver(b, VIEWPOINTS['spawn-east'], {
    bar: false,
    hu: false,
    flow: { wiTicker, doCompleted: gDoCompleted },
  });
  wiResetPlayerFlags();
  const p = d.state.players[0]!;
  d.state.mobjs.totalkills = tally.totalkills ?? 100;
  d.state.mobjs.totalitems = tally.totalitems ?? 100;
  d.state.totalsecret = tally.totalsecret ?? 1;
  p.killcount = tally.kills ?? 0;
  p.itemcount = tally.items ?? 0;
  d.state.secretcount = tally.secrets ?? 0;
  if (tally.leveltime !== undefined) d.state.leveltime = tally.leveltime;
  gExitLevel(d.state);
  d.tic(); // the drain tic: G_DoCompleted -> WI_Start (BCNT=1)
  registerDisplayHooks({
    wiDrawer: () => wiDrawer(wadWiPatches(b.wad), wiDrawSnapshot()),
  });
  return d;
}

/** No-3D capture of the shared framebuffer (WI/finale pages). */
export function wiCapture(d: M9Driver): SceneFrame {
  const r = d.display();
  expect(r.counters, 'this state draws no 3D pass').toBeUndefined();
  expect(displayStubHits.count, 'all D_Display drawers registered').toBe(0);
  return { bytes: sharedFb.indices.slice() };
}

/** StatCount page at tic `tics` of the tally. */
export function wiTallyScene(tally: Tally, tics: number): () => SceneFrame {
  return () => {
    const d = wiBoot(tally);
    for (let t = 1; t < tics; t++) d.tic();
    return wiCapture(d);
  };
}

/** Final StatCount page (run until spState 10 — par/sucks pair). */
export function wiTimeScene(tally: Tally): () => SceneFrame {
  return () => {
    const d = wiBoot(tally);
    let guard = 0;
    while (wiPeek().spState !== 10 && guard++ < 4000) d.tic();
    expect(wiPeek().spState, 'reached the final StatCount state').toBe(10);
    return wiCapture(d);
  };
}

/** Finale page after `tics` of F_Ticker (reveal / hold / HELP2). */
export function finaleScene(tics: number): () => SceneFrame {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { bar: false, hu: false });
    fReset(b.wad);
    fSetWad(b.wad);
    fStartFinale(d.state); // ga_victory case body (f_finale.c:96-135)
    for (let t = 0; t < tics; t++) fTicker(d.state, emptyInput());
    registerDisplayHooks({ finaleDrawer: fDrawer });
    return wiCapture(d);
  };
}
