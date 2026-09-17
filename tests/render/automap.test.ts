/**
 * M2-10 — golden automap frames (M2-plan §M2-10, milestone evidence).
 *
 * Deterministic full pipeline per scene:
 *   FIXMAP (or freedoom1 E1M1) bytes → WadFile.parse → loadMap →
 *   buildMapFromData → gInitGame → scripted AutomapEvents (Tab etc. through
 *   amResponder, drained per-tic exactly like src/main.ts stepTic) →
 *   gTicker + amTicker ×N → drawAutomap → sha256(fb.indices).
 *
 * Goldens live in tests/render/goldens/automap/meta.json and are
 * regenerated ONLY via `npm run goldens:update -- --reason "..."`
 * (scripts/goldens-update.mjs, which also blesses PNGs). Every scene runs
 * TWICE here — identical sha required — so a flaky pipeline can never
 * bless a golden.
 *
 * Dumps: when GOLDENS_DUMP_DIR is set the raw index buffers (+ per-scene
 * json) are written there for the update/check script. That is the ONLY
 * write path; the test itself never mutates goldens (record/check modes
 * below are script-driven conveniences).
 *   GOLDENS_MODE=update  → dump, skip meta asserts (regen run)
 *   GOLDENS_MODE=check   → dump AND assert (--check drift mode)
 *
 * E1M1 scenes are skipIf(!hasWad): the wad is located via $DOOM_WAD,
 * $FREEDOOM1_WAD, or <repo>/wads/freedoom1.wad (report says ran/skipped).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData, type RuntimeMap } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { CF_NOCLIP } from '../../src/sim/player';
import type { GameState } from '../../src/sim/state';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import {
  AM_FOLLOWKEY,
  AM_PANRIGHTKEY,
  AM_STARTKEY,
  AM_ZOOMINKEY,
  amCreateState,
  amResponder,
  amTicker,
  keydown,
  keyup,
  type AutomapEvent,
  type AutomapState
} from '../../src/sim/amMap';
import { drawAutomap } from '../../src/render/automap';
import { Framebuffer } from '../../src/render/framebuffer';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';

/* ------------------------------------------------------------------ */
/* Paths + wad discovery                                               */
/* ------------------------------------------------------------------ */

const GOLDENS_DIR = fileURLToPath(new URL('./goldens/automap/', import.meta.url));
const META_PATH = `${GOLDENS_DIR}meta.json`;
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';

/** Candidate IWAD paths, first existing wins (worktrees may lack wads/). */
function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();
const hasWad = WAD_PATH !== undefined;

/* ------------------------------------------------------------------ */
/* Scene model                                                          */
/* ------------------------------------------------------------------ */

/** One tic's scripted inputs, applied in the main.ts stepTic order:
 * events drained (D_ProcessEvents) → gTicker(input) → amTicker. */
interface TicScript {
  readonly events?: readonly AutomapEvent[];
  readonly input?: GameInput;
  readonly noclip?: boolean;
}

interface Scene {
  readonly name: string;
  readonly kind: 'fixture' | 'iwad';
  /** Human-readable script, mirrored into meta.json for review. */
  readonly script: string;
  readonly map: () => RuntimeMap;
  /** One entry per tic to run; length = tic count. */
  readonly tics: readonly TicScript[];
}

/** Two-room FIXMAP: floor-change divider (brown), door gap, void walls
 * (two-sided onto dummy sector 0 ⇒ also floor-change brown per R09 §5). */
const FIX_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 192 },
    { x: 256, y: 0, w: 256, h: 256, floorHeight: 8, lightLevel: 200 }
  ],
  doors: [{ x1: 256, y1: 64, x2: 256, y2: 128, special: 1 }]
};

function fixtureMap(): RuntimeMap {
  const bytes = buildFixtureMapWad(FIX_SPEC);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
}

let wadBuf: ArrayBuffer | null = null;
function iwadMap(): RuntimeMap {
  if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
  if (wadBuf === null) {
    const bytes = readFileSync(WAD_PATH);
    wadBuf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  }
  return buildMapFromData(loadMap(WadFile.parse(wadBuf), 'E1M1'));
}

const noInput = emptyInput();
const fwd: GameInput = { ...emptyInput(), forward: true };
/** Tab down+up opening the automap at tic 0. */
const tabOpen: readonly AutomapEvent[] = [keydown(AM_STARTKEY), keyup(AM_STARTKEY)];
const k = (data1: number): readonly AutomapEvent[] => [keydown(data1), keyup(data1)];

const SCENES: readonly Scene[] = [
  {
    name: 'fix-tab-20tics',
    kind: 'fixture',
    script: 'TAB open (tic 0) + 20 empty tics, follow mode, grid off',
    map: fixtureMap,
    tics: [{ events: tabOpen }, ...Array.from({ length: 19 }, () => ({}))]
  },
  {
    name: 'fix-follow-noclip-forward-35',
    kind: 'fixture',
    script: 'TAB open + 35 tics hold-forward with noclip (follow recenter + arrow travel)',
    map: fixtureMap,
    tics: [
      { events: tabOpen },
      ...Array.from({ length: 34 }, () => ({ input: fwd, noclip: true }))
    ]
  },
  {
    name: 'fix-free-panzoom-31',
    kind: 'fixture',
    script:
      "TAB open t0; 'f' free mode t5; hold '=' t6..15 (zoom in); keydown RIGHT t20 (pan), keyup t30; 31 tics total",
    map: fixtureMap,
    tics: Array.from({ length: 31 }, (_, t) => {
      if (t === 0) return { events: tabOpen };
      if (t === 5) return { events: k(AM_FOLLOWKEY) };
      if (t === 6) return { events: [keydown(AM_ZOOMINKEY)] };
      if (t === 16) return { events: [keyup(AM_ZOOMINKEY)] };
      if (t === 20) return { events: [keydown(AM_PANRIGHTKEY)] };
      if (t === 30) return { events: [keyup(AM_PANRIGHTKEY)] };
      return {};
    })
  },
  {
    name: 'e1m1-spawn-tab-20tics',
    kind: 'iwad',
    script: 'freedoom1 E1M1: TAB open (tic 0) + 20 empty tics (spawn follow view)',
    map: iwadMap,
    tics: [{ events: tabOpen }, ...Array.from({ length: 19 }, () => ({}))]
  },
  {
    name: 'e1m1-follow-noclip-forward-35',
    kind: 'iwad',
    script: 'freedoom1 E1M1: TAB open + 35 tics hold-forward with noclip',
    map: iwadMap,
    tics: [
      { events: tabOpen },
      ...Array.from({ length: 34 }, () => ({ input: fwd, noclip: true }))
    ]
  }
];

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

/** main.ts stepTic twin: drain events (AM_Responder first), gTicker, amTicker. */
function stepTic(state: GameState, am: AutomapState, script: TicScript): void {
  const player = state.players[0]!;
  if (script.noclip) player.cheats |= CF_NOCLIP;
  const world = { map: state.map, player };
  for (const ev of script.events ?? []) amResponder(am, ev, world);
  gTicker(state, script.input ?? noInput);
  amTicker(am, player);
}

function renderScene(scene: Scene): Framebuffer {
  const map = scene.map();
  const state = gInitGame(map);
  const am = amCreateState();
  for (const script of scene.tics) stepTic(state, am, script);
  const fb = new Framebuffer();
  expect(drawAutomap(fb, am, state.map, state.players[0]!), `${scene.name}: automap active on draw`).toBe(true);
  return fb;
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface MetaFile {
  schema?: number;
  scenes?: Record<string, { indexSha256?: string; kind?: string; script?: string }>;
}

function readMeta(): MetaFile {
  if (!existsSync(META_PATH)) {
    throw new Error(`goldens meta missing: ${META_PATH} — run npm run goldens:update -- --reason "..."`);
  }
  return JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile;
}

function wadSha256(): string | null {
  if (WAD_PATH === undefined) return null;
  return sha256Of(readFileSync(WAD_PATH));
}

function dump(scene: Scene, fb: Framebuffer): void {
  if (DUMP_DIR === null) return;
  const base = `${DUMP_DIR}/${scene.name}`;
  writeFileSync(`${base}.bin`, fb.indices);
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        name: scene.name,
        kind: scene.kind,
        script: scene.script,
        width: fb.width,
        height: fb.height,
        indexSha256: sha256Of(fb.indices),
        wadPath: scene.kind === 'iwad' ? (WAD_PATH ?? null) : null,
        wadSha256: scene.kind === 'iwad' ? wadSha256() : null
      },
      null,
      2
    ) + '\n'
  );
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('automap goldens — deterministic fixture pipeline', () => {
  for (const scene of SCENES.filter((s) => s.kind === 'fixture')) {
    it(`${scene.name}: index-buffer sha256 matches the committed golden`, () => {
      const fbA = renderScene(scene);
      const fbB = renderScene(scene); // determinism: same script twice
      const shaA = sha256Of(fbA.indices);
      expect(shaA, `${scene.name}: pipeline must be deterministic across runs`).toBe(sha256Of(fbB.indices));
      dump(scene, fbA);
      if (MODE !== 'update') {
        const meta = readMeta();
        const golden = meta.scenes?.[scene.name];
        expect(golden, `golden '${scene.name}' missing from meta.json`).toBeDefined();
        expect(shaA, `${scene.name}: index sha drifted from meta.json`).toBe(golden!.indexSha256);
      }
    });
  }
});

describe.skipIf(!hasWad)('automap goldens — freedoom1 E1M1 (skipIf no wad)', () => {
  for (const scene of SCENES.filter((s) => s.kind === 'iwad')) {
    it(`${scene.name}: index-buffer sha256 matches the committed golden`, () => {
      const fbA = renderScene(scene);
      const fbB = renderScene(scene);
      const shaA = sha256Of(fbA.indices);
      expect(shaA, `${scene.name}: pipeline must be deterministic across runs`).toBe(sha256Of(fbB.indices));
      dump(scene, fbA);
      if (MODE !== 'update') {
        const meta = readMeta();
        const golden = meta.scenes?.[scene.name];
        expect(golden, `golden '${scene.name}' missing from meta.json`).toBeDefined();
        expect(shaA, `${scene.name}: index sha drifted from meta.json`).toBe(golden!.indexSha256);
      }
    });
  }
});

describe('golden harness self-checks', () => {
  it('fixture scene frames are non-empty (background + walls + arrow)', () => {
    const fb = renderScene(SCENES[1]!);
    const counts = new Map<number, number>();
    for (const i of fb.indices) counts.set(i, (counts.get(i) ?? 0) + 1);
    const colors = [...counts.keys()].filter((c) => c !== 0);
    expect(colors.length, 'at least one non-background color drawn').toBeGreaterThan(0);
    // player arrow WHITE (209) present (render/automap.ts AM_drawPlayers)
    expect(counts.get(209) ?? 0, 'WHITE arrow pixels').toBeGreaterThan(0);
  });

  it.skipIf(!hasWad)('IWAD scenes run against a discovered wad', () => {
    expect(WAD_PATH).toBeDefined();
  });
});
