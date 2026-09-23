/**
 * M12-04 perf scenes (docs/design/M12-plan.md §M12-04a) — the FIXED scripted
 * scenes the node-side perf probe measures:
 *
 *   1. `e1m7`  — the heaviest E1 map (§0.1 census: 714 things / 4337 lines),
 *      booted at its player-1 start, live-mobj roster + sprite pass active;
 *   2. `e1m1`  — the baseline scene, same construction on the lightest-boot
 *      map the whole suite already pins (loop.test.ts / the walls goldens);
 *   3. `fire40` — a 40-mobj FIREFIGHT constructed on E1M1's spawn courtyard
 *      via the arena seam (`pSpawnMobj` straight into the level's mobj
 *      runtime — the same slot allocator production spawns use), a mixed
 *      POSS/SHOTGUY/TROOP escort in a ring around player 1, firing held on
 *      the vanilla fire-button cadence, ammo topped up per second (a perf
 *      scene, not a fairness sim: the point is sustained monster AI +
 *      missiles + sprite load on the frame).
 *
 * Every scene exposes: `state` (the live GameState), a production-shaped
 * `renderFrame` deps bundle (world/map/sprites/tables/psprites + the live
 * mobj roster — the main.ts composer's keys, minus the automap), and a
 * deterministic per-tic input function. NO timing here: the measurement
 * (performance.now, percentiles) lives in perf.test.ts / probe.test.ts — the
 * sim stays pure (A-06) and these helpers never call performance/Date.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decodeColormap } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { pSpawnMobj, ONFLOORZ } from '../../src/sim/p_mobj';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { MT } from '../../src/wad/info/mobjinfo';
import type { InventoryFields } from '../../src/sim/p_inter_inventory';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, type FrameDeps } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';
import { buildPspriteFrameInput } from '../../src/pspriteview';

export const WAD_PATH: string | undefined =
  process.env['DOOM_WAD'] ??
  process.env['FREEDOOM1_WAD'] ??
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));

export const hasWad = WAD_PATH !== undefined && existsSync(WAD_PATH);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

/** One IWAD, parsed once per process (the scenes share textures/flats). */
export function openWad(): WadFile {
  if (WAD_PATH === undefined || !existsSync(WAD_PATH)) {
    throw new Error('perf scenes require the pinned freedoom1.wad (hasWad guard)');
  }
  return WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
}

export interface PerfScene {
  readonly name: string;
  readonly state: ReturnType<typeof gInitGame>;
  readonly deps: FrameDeps;
  /** Deterministic ticcmd for live tic `g` (scene script; see module header). */
  ticInput(g: number): GameInput;
  /** Fixed-point units, for the report. */
  readonly mobjsAtBoot: number;
}

interface SharedAssets {
  readonly textures: ReturnType<typeof texturesFromWad>;
  readonly flats: ReturnType<typeof flatsFromWad>;
  readonly tables: ReturnType<typeof initLightTables>;
}

function sharedAssets(wad: WadFile): SharedAssets {
  return {
    textures: texturesFromWad(wad),
    flats: flatsFromWad(wad),
    tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!))
  };
}

/** Boot a scene on map `mapName` with the production-shaped render deps. */
function bootScene(
  wad: WadFile,
  assets: SharedAssets,
  mapName: string,
  tune?: (state: ReturnType<typeof gInitGame>) => void
): PerfScene {
  const md = loadMap(wad, mapName);
  const sim = buildMapFromData(md);
  const state = gInitGame(sim);
  const mapView = buildRenderMapView(md);
  const sprites = buildMapSprites({ md, map: mapView, wad });
  const world = loadRenderWorld(md, assets.textures, assets.flats, state.sectors);
  const fb = new Framebuffer();
  tune?.(state);
  const deps: FrameDeps = {
    fb,
    world,
    map: mapView,
    player: state.players[0]!,
    tables: assets.tables,
    sprites,
    // M9-09 production mode (main.ts:529): the sprite pass walks the LIVE
    // roster, exactly like the browser loop.
    mobjs: state.mobjs.mobjs,
    // main.ts:535 psprite seam (gun/muzzle layer).
    psprites: buildPspriteFrameInput(state.map, state.players[0]!, sprites.sprites)
  };
  return {
    name: mapName.toLowerCase(),
    state,
    deps,
    ticInput: () => emptyInput(),
    mobjsAtBoot: countLive(state)
  };
}

function countLive(state: ReturnType<typeof gInitGame>): number {
  let n = 0;
  for (const m of state.mobjs.mobjs) if (!m.removed) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Scene builders                                                      */
/* ------------------------------------------------------------------ */

/** Scene 1: E1M7 — the heaviest map, booted at its start, no scripting. */
export function sceneE1M7(wad: WadFile, assets: SharedAssets): PerfScene {
  return bootScene(wad, assets, 'E1M7');
}

/** Scene 2: E1M1 — the baseline. */
export function sceneE1M1(wad: WadFile, assets: SharedAssets): PerfScene {
  return bootScene(wad, assets, 'E1M1');
}

/** The 40-mobj ring (13 POSS, 13 SHOTGUY, 14 TROOP — the E1M1-weighted mix
 * from the m8 roster census), placed on a 256..640-unit arc around the
 * E1M1 player-1 start (-416, 256) — angles biased to the front half so the
 * ring wakes with line-of-sight (A_Look fires the sight sound, and the
 * firefight sustains without scripted prodding). */
const FIREFIGHT_RING: readonly { mt: number; x: number; y: number }[] = (() => {
  const cx = -416;
  const cy = 256;
  const ring: { mt: number; x: number; y: number }[] = [];
  const mix = [MT.MT_POSSESSED, MT.MT_SHOTGUY, MT.MT_TROOP] as const;
  const N = 40;
  for (let i = 0; i < N; i++) {
    // front half: -100..+100 degrees around the east-facing spawn angle 0
    const theta = ((i / (N - 1)) * 200 - 100) * (Math.PI / 180);
    const r = 256 + (i % 4) * 128; // staggered 256/384/512/640 rings
    ring.push({
      mt: mix[i % mix.length]!,
      x: Math.round(cx + r * Math.cos(theta)),
      y: Math.round(cy + r * Math.sin(theta))
    });
  }
  return ring;
})();

/** Scene 3: E1M1 spawn + 40 constructed mobjs via the arena seam; the player
 * fires every 4th tic (pistol cycle ~16 tics anyway) with ammo topped up
 * every 35 tics so the gun never runs dry in a 12-second scene. */
export function sceneFire40(wad: WadFile, assets: SharedAssets): PerfScene {
  const scene = bootScene(wad, assets, 'E1M1', (state) => {
    for (const spot of FIREFIGHT_RING) {
      pSpawnMobj(state.mobjs, spot.x << 16, spot.y << 16, ONFLOORZ, spot.mt, -1, {
        skipLastLookRandom: true
      });
    }
    const inv = state.players[0] as Partial<InventoryFields>;
    if (inv.ammo !== undefined) inv.ammo[0] = 255; // pistol clip (scene hygiene)
  });
  return {
    ...scene,
    name: 'fire40',
    ticInput: (g: number): GameInput => {
      if (g > 0 && g % 35 === 0) {
        const inv = scene.state.players[0] as Partial<InventoryFields>;
        if (inv.ammo !== undefined) inv.ammo[0] = 255;
      }
      return { ...emptyInput(), attack: g % 4 === 0 };
    }
  };
}

/** Build all three scenes on ONE parsed wad. */
export function buildScenes(wad?: WadFile): { wad: WadFile; scenes: PerfScene[] } {
  const w = wad ?? openWad();
  const assets = sharedAssets(w);
  return { wad: w, scenes: [sceneE1M7(w, assets), sceneE1M1(w, assets), sceneFire40(w, assets)] };
}
