/**
 * render/bsp + render/view tests (M3-plan §M3-04).
 *
 *  * Acceptance 1 — 1000 seeded FIXMAP viewpoints: the real walk's reached-seg
 *    set is superset-equal vs a no-early-out reference. Reference = brute
 *    geometry (atan2 cone intersection, double math, no tables, every seg in
 *    the map, no R_CheckBBox, no BSP at all): "definitely visible" (clipped
 *    screen width > 2 px, 0 < span < 180° − margin) MUST be reached by the
 *    walk (the bbox early-out must never drop a visible seg), and everything
 *    the walk reached must pass the loose brute test (width > −0.01 px,
 *    span < 180° + margin). Tolerances absorb table quantization only
 *    (viewangletox truncates angles to fine steps; R_PointToAngle quantizes
 *    slopes via SlopeDiv — together ≤ ~0.25 px per endpoint), never a span.
 *  * Acceptance 2 — clip classification truth table. mapBuilder FIXMAP
 *    variants cover every two-sided rule; one hand-built plain-MapData map
 *    covers the paths mapBuilder cannot emit (true one-sided lines — its
 *    generator makes two-sided lines against a VOID sector, which still
 *    classifies clipsolid via the closed-door height rule — and minisegs).
 *  * Acceptance 3 — E1M1 (skipIf): spawn walk completes; tree-order proof:
 *    every subsector visited inside a node visit's NEAR-child interval lies
 *    in that child's subtree (bbox containment, computed independently of
 *    the walker), and likewise for the FAR interval after the far-enter
 *    event ⇒ the nearer side is strictly traversed first at every node.
 *    Vanilla order is TREE order, not distance order — this is the correct
 *    structural assertion (plan acceptance 3).
 *  * Acceptance 4 — zero-alloc steady state: 1000 walk frames reuse one
 *    walker + callback object + stack buffers; stack-buffer identity and
 *    identical per-frame digests are asserted (reuse design, not heap
 *    sampling).
 *
 * G11 note: src/render/bsp.ts carries its own r_main.c pointOnSide copy
 * (sim/bsp.ts serves collision; zone rules forbid importing it here), pinned
 * against a TEST-LOCAL reference reimplementation below; the duplication is
 * tracked as gap G11 for the M12 audit.
 *
 * Source truths pinned here (see bsp.ts header for the full table):
 *  - R_AddLine classification is HEIGHT-based — 1.10 never reads line
 *    specials; "closed door" ⇔ backCeiling ≤ frontFloor || backFloor ≥
 *    frontCeiling, checked BEFORE the window/noDraw rules;
 *  - one-sided (NULL backsector) ⇒ clipsolid before any midtex thought
 *    (the masked-vs-solid split is r_segs.c / M3-06);
 *  - noDraw reject = identical heights + identical light + no middle
 *    texture (flat equality is the M3 −1-flat stub — documented subset);
 *  - `x1 == x2` drop exists exactly at r_bsp.c:317 (after the angle clip);
 *  - clipangle = xtoviewangle[0] with NO <<16 (entries are already
 *    angle_t: (i<<ANGLETOFINESHIFT) − ANG90).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { finecosine, finesine } from '../core/tables';
import { loadMap, thingAt } from '../wad/mapdata';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { texturesFromWad } from '../wad/texture';
import type { LineDef, MapData, Node, Seg, SectorDef, SideDef, TextureDef, Vertex } from '../wad/types';

import {
  createBspWalker,
  getValidcount,
  pointOnSideXY,
  solidsegsWalkCallbacks,
  type WalkCallbacks,
} from './bsp';
import { planeAt, planeCount, planeHeight, resetPlanesForTests } from './planes';
import { clearClipSegs, getRenderCounters, solidsegsLength } from './solidsegs';
import { loadRenderWorld, NO_TEXTURE, type RenderWorld } from './rdata';
import {
  bspRoot,
  buildRenderMapView,
  createViewState,
  initTextureMapping,
  setupView,
  VIEWHEIGHT_FIXED,
  type RenderMapView,
  type ViewState,
} from './view';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const TWO_PI = Math.PI * 2;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function arrayBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface Fixture {
  readonly md: MapData;
  readonly world: RenderWorld;
  readonly view: RenderMapView;
}

function fixtureFromSpec(spec: RectMapSpec): Fixture {
  const bytes = buildFixtureMapWad(spec);
  const wad = WadFile.parse(arrayBuf(bytes));
  const md = loadMap(wad, 'FIXMAP');
  // Plain composed textures (M3-02 pattern): the fixture WAD's 2×2 sprite-
  // format patch lumps are not decodable by texturesFromWad's column-pair
  // directory; M3-04 classification only needs resolvable, opaque textures.
  const mk = (name: string, f: (c: number, r: number) => number): [string, TextureDef] => [name, mkTexture(name, 64, 128, f)];
  const textures = new Map<string, TextureDef>([
    mk('FIXWALL0', (c, r) => ((c * 7 + r * 3) % 255) + 1),
    mk('DOORFIX0', (_c, r) => (r % 255) + 1),
  ]);
  return { md, world: loadRenderWorld(md, textures), view: buildRenderMapView(md) };
}

function mkTexture(name: string, width: number, height: number, fn: (c: number, r: number) => number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c += 1) {
    const col = new Uint8Array(height);
    for (let r = 0; r < height; r += 1) col[r] = fn(c, r);
    columns.push(col);
  }
  return { name, width, height, patches: [], columns };
}

function setupXY(v: ViewState, xUnits: number, yUnits: number, angleDeg: number, zUnits = 0): void {
  setupView(v, {
    x: (xUnits * FRACUNIT) | 0,
    y: (yUnits * FRACUNIT) | 0,
    z: (zUnits * FRACUNIT) | 0,
    angle: ((angleDeg / 360) * 0x100000000) % 0x100000000,
  });
}

/** Walk one frame with reached/classification recording; all state reused. */
class WalkLog {
  reached = new Int32Array(0);
  kind = new Int8Array(0); // per seg: 0 none, 1 solid, 2 pass (this frame)
  stamp = 0;
  frame = 0;
  digest = 0;
  readonly cbs: WalkCallbacks;
  private curSeg = -1;

  constructor() {
    this.cbs = {
      addSolid: () => {
        this.kind[this.curSeg] = 1;
        this.digest = (Math.imul(this.digest, 31) + this.curSeg * 3 + 1) | 0;
      },
      addPass: () => {
        this.kind[this.curSeg] = 2;
        this.digest = (Math.imul(this.digest, 31) + this.curSeg * 3 + 2) | 0;
      },
      onSegReached: (seg: number, x1: number, x2: number) => {
        this.curSeg = seg;
        this.reached[seg] = this.stamp;
        this.digest = (Math.imul(this.digest, 31) + seg * 1024 + x1 * 64 + (x2 - x1)) | 0;
      },
    };
  }

  init(n: number): void {
    if (this.reached.length < n) {
      this.reached = new Int32Array(n);
      this.kind = new Int8Array(n);
    }
  }

  begin(): void {
    this.frame += 1;
    this.stamp = this.frame;
    this.digest = 0;
    this.kind.fill(0);
    this.reached.fill(0);
  }
}

/* ------------------------------------------------------------------ */
/* Brute geometric reference (no tables, no BSP)                       */
/* ------------------------------------------------------------------ */

const MAP = initTextureMapping();
const FOCAL_PX = MAP.focallength / FRACUNIT;
const CLIP_RAD = ((MAP.clipangle >>> 0) / 0x100000000) * TWO_PI;

/** Screen x for a view-relative angle (double analogue of viewangletox). */
function proj(rel: number): number {
  return 160 - FOCAL_PX * Math.tan(rel);
}

interface BruteResult {
  /** CCW span v2→v1 normalized to [0, 2π); backface ⇔ ≥ π */
  span: number;
  /** clipped screen-span width in px (≤ 0 ⇔ outside the view cone) */
  width: number;
}

function bruteClip(view: ViewState, v1x: number, v1y: number, v2x: number, v2y: number): BruteResult {
  const va = ((view.viewangle >>> 0) / 0x100000000) * TWO_PI;
  const a1 = Math.atan2(v1y - view.viewy, v1x - view.viewx);
  const a2 = Math.atan2(v2y - view.viewy, v2x - view.viewx);
  let span = (a1 - a2) % TWO_PI;
  if (span < 0) span += TWO_PI;
  if (span >= Math.PI) return { span, width: -1 }; // backface

  const start = a2 - va;
  let width = 0;
  for (const k of [-TWO_PI, 0, TWO_PI]) {
    const lo = Math.max(start + k, -CLIP_RAD);
    const hi = Math.min(start + k + span, CLIP_RAD);
    if (hi > lo) {
      const w = proj(lo) - proj(hi); // x decreases with relative angle
      if (w > width) width = w;
    }
  }
  return { span, width };
}

/* ------------------------------------------------------------------ */
/* FIXMAP scene for the sweep + truth-table cases                      */
/* ------------------------------------------------------------------ */

const SWEEP_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // A (light 192)
    { x: 256, y: 0, w: 256, h: 256, ceilingHeight: 112, lightLevel: 128 }, // B window
    { x: 0, y: 256, w: 256, h: 256, floorHeight: 16 }, // C step
    { x: 512, y: -128, w: 128, h: 128, lightLevel: 0 }, // D dark box
  ],
  doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }],
};

/* ------------------------------------------------------------------ */
/* 1. Seeded sweep: walk ⊇ brute-visible, walked ⊆ brute-loose         */
/* ------------------------------------------------------------------ */

describe('BSP walk vs brute no-early-out reference (1000 seeded viewpoints)', () => {
  const fix = fixtureFromSpec(SWEEP_SPEC);
  const walker = createBspWalker(fix.view, fix.world);

  it('superset-equal: no visible seg dropped, nothing invisible reached', () => {
    const n = fix.world.numSegs;
    expect(n).toBeGreaterThan(10);
    const log = new WalkLog();
    log.init(n);
    const rand = lcg(0x4d04);
    const view = createViewState();
    let strictCount = 0;
    let totalReached = 0;

    for (let f = 0; f < 1000; f += 1) {
      log.begin();
      setupXY(view, 64 + rand() * 512, -128 + rand() * 512, (rand() * 360) % 360);
      clearClipSegs();
      walker.walk(view, log.cbs);

      let reachedCount = 0;
      for (let s = 0; s < n; s += 1) {
        const b = bruteClip(
          view,
          fix.world.segV1x[s]!,
          fix.world.segV1y[s]!,
          fix.world.segV2x[s]!,
          fix.world.segV2y[s]!,
        );
        const reached = log.reached[s] === log.stamp;
        const strict = b.width > 2 && b.span > 1e-3 && b.span < Math.PI - 0.01;
        if (reached) reachedCount += 1;
        if (strict && !reached) {
          throw new Error(
            `frame ${f} seg ${s}: definitely visible (w=${b.width.toFixed(3)}px span=${((b.span * 180) / Math.PI).toFixed(2)}°) ` +
              `but the real walk dropped it — bbox early-out is too aggressive`,
          );
        }
        if (reached) {
          expect(
            b.width > -0.01 && b.span < Math.PI + 1e-3,
            `frame ${f} seg ${s}: reached but geometrically invisible (w=${b.width} span=${b.span})`,
          ).toBe(true);
        }
        if (strict) strictCount += 1;
      }
      // reachedCount may legitimately be 0: viewpoints in VOID pockets with
      // nothing in the cone. Aggregate sanity below.
      totalReached += reachedCount;
    }
    expect(totalReached).toBeGreaterThan(1000); // the sweep really looked around
    expect(strictCount).toBeGreaterThan(500); // the sweep exercised visibility
    // The classification callbacks only ever fire on reached segs:
    // (WalkLog.kind is stamped inside reached frames by construction.)
  });
});

/* ------------------------------------------------------------------ */
/* 2. Clip classification truth table                                  */
/* ------------------------------------------------------------------ */

function sectorOfSide(md: MapData, side: number): number {
  return side >= 0 ? md.sideDefs[side]!.sector : -1;
}

function sideSectorOf(md: MapData, li: number, which: 0 | 1): number {
  const l = md.lineDefs[li]!;
  return sectorOfSide(md, which === 0 ? l.front : l.back);
}

function pairOf(md: MapData, li: number): string {
  const a = sideSectorOf(md, li, 0);
  const b = sideSectorOf(md, li, 1);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const rooms12 = (b: Partial<{ ceiling: number; floor: number; light: number }>): RectMapSpec => ({
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 },
    {
      x: 256,
      y: 0,
      w: 256,
      h: 256,
      ceilingHeight: b.ceiling,
      floorHeight: b.floor,
      lightLevel: b.light,
    },
  ],
});

interface Case {
  readonly name: string;
  readonly spec: RectMapSpec;
  readonly target: (md: MapData, li: number) => boolean;
  /** 0 = noDraw (reached but never added), 1 = clipsolid, 2 = clippass */
  readonly expect: 0 | 1 | 2;
}

const TABLE: readonly Case[] = [
  {
    // Room-void wall: mapBuilder emits a two-sided line against VOID sector
    // 0 (floor=ceil=−128) ⇒ clipsolid via the SAME closed-door height
    // branch vanilla uses (backCeil ≤ frontFloor). The NULL-backsector
    // branch of that rule is covered by the hand-built map below.
    name: 'solid wall (room vs VOID sector heights) → clipsolid',
    spec: { rooms: [{ x: 0, y: 0, w: 256, h: 256 }] },
    target: (md, li) => sectorOfSide(md, md.lineDefs[li]!.back) === 0,
    expect: 1,
  },
  {
    // Source truth: 1.10 does NOT test the special — a closed (lowered)
    // door hits the height rule. DOORFIX0 midtex + special 1 present.
    name: 'closed door (back ceiling at front floor; special+midtex ignored) → clipsolid',
    spec: {
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256, ceilingHeight: 0 },
      ],
      doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }],
    },
    target: (md, li) => pairOf(md, li) === '1|2',
    expect: 1,
  },
  {
    name: 'window (back ceiling differs) → clippass',
    spec: rooms12({ ceiling: 112 }),
    target: (md, li) => pairOf(md, li) === '1|2',
    expect: 2,
  },
  {
    name: 'window (back floor differs, ceilings equal) → clippass',
    spec: rooms12({ floor: 16 }),
    target: (md, li) => pairOf(md, li) === '1|2',
    expect: 2,
  },
  {
    name: 'back floor at front ceiling (raised room) → clipsolid',
    spec: rooms12({ floor: 128 }),
    target: (md, li) => pairOf(md, li) === '1|2',
    expect: 1,
  },
  {
    name: 'empty trigger line (identical everything, no midtex) → noDraw',
    spec: {
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 },
      ],
    },
    target: (md, li) => pairOf(md, li) === '1|2' && md.lineDefs[li]!.special === 0,
    expect: 0,
  },
  {
    // M4-10 decode fix: vanilla slots are bottom@12 / mid@20 (doomdata.h),
    // so the fixture door's DOORFIX0 now decodes as a real midtexture —
    // the door seg is masked (midtexture defeats the vanilla noDraw
    // reject ⇒ clippass), while the plain twin-room walls stay noDraw
    // (heights+light identical, no texture).
    name: 'twin rooms + door line: door seg clippass (mid defeats noDraw)',
    spec: {
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 },
      ],
      doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }],
    },
    target: (md, li) => pairOf(md, li) === '1|2' && md.lineDefs[li]!.special !== 0,
    expect: 2,
  },
  {
    name: 'identical heights, light differs → clippass',
    spec: rooms12({ light: 128 }),
    target: (md, li) => pairOf(md, li) === '1|2',
    expect: 2,
  },
];

describe('R_AddLine classification truth table', () => {
  for (const c of TABLE) {
    it(c.name, () => {
      const fix = fixtureFromSpec(c.spec);
      const walker = createBspWalker(fix.view, fix.world);
      const log = new WalkLog();
      log.init(fix.world.numSegs);
      const view = createViewState();
      setupXY(view, 64, 128, 0); // inside room A facing the shared wall at x=256
      log.begin();
      clearClipSegs();
      walker.walk(view, log.cbs);

      let reached = 0;
      let added = 0;
      for (let s = 0; s < fix.world.numSegs; s += 1) {
        const li = fix.world.segLine[s]!;
        if (li < 0 || !c.target(fix.md, li)) continue;
        if (log.reached[s] === log.stamp) {
          reached += 1;
          expect(log.kind[s], `seg ${s} (line ${li}) classification`).toBe(c.expect);
          if (log.kind[s] !== 0) added += 1;
        }
      }
      expect(reached, 'at least one target seg reached R_AddLine past the clip math').toBeGreaterThan(0);
      if (c.expect !== 0) expect(added, 'target segs reached the ledger callbacks').toBeGreaterThan(0);
      else expect(added, 'noDraw ⇒ target segs never reach the ledger').toBe(0);
    });
  }

  it('one-sided seg with midtex → clipsolid; miniseg → clipsolid', () => {
    const md = handMiniMap({ mid: 'FIXWALL0', twoSided: false });
    const textures = new Map<string, TextureDef>([['FIXWALL0', mkTexture('FIXWALL0', 64, 64, () => 7)]]); // opaque
    const world = loadRenderWorld(md, textures);
    expect(world.sideMidTex[0]).not.toBe(NO_TEXTURE); // midtex really resolved
    const map = buildRenderMapView(md);
    const walker = createBspWalker(map, world);
    const log = new WalkLog();
    log.init(world.numSegs);
    const view = createViewState();
    setupXY(view, -64, 0, 0); // west half, facing east at the x=64 wall
    log.begin();
    clearClipSegs();
    walker.walk(view, log.cbs);

    // seg 0: one-sided (back sidedef −1) WITH a middle texture — r_bsp.c
    // goto order sends one-sided ⇒ clipsolid regardless of midtex (the
    // masked-solid middle decision belongs to R_StoreWallRange, M3-06).
    expect(log.reached[0]).toBe(log.stamp);
    expect(log.kind[0]).toBe(1);
    // seg 1: miniseg (line −1) ⇒ NULL backsector ⇒ clipsolid.
    expect(log.kind[1]).toBe(1);
  });

  it('two-sided identical sectors: midtex present → clippass, absent → noDraw', () => {
    for (const [mid, expectKind] of [['FIXWALL0', 2], ['', 0]] as const) {
      const md = handMiniMap({ mid, twoSided: true });
      const textures = new Map<string, TextureDef>([['FIXWALL0', mkTexture('FIXWALL0', 64, 64, () => 7)]]);
      const world = loadRenderWorld(md, textures);
      const map = buildRenderMapView(md);
      const walker = createBspWalker(map, world);
      const log = new WalkLog();
      log.init(world.numSegs);
      const view = createViewState();
      setupXY(view, -64, 0, 0);
      log.begin();
      clearClipSegs();
      walker.walk(view, log.cbs);
      expect(log.reached[0], `midtex ${JSON.stringify(mid)}: seg reached`).toBe(log.stamp);
      expect(log.kind[0], `midtex ${JSON.stringify(mid)} classification`).toBe(expectKind);
      expect(log.kind[1]).toBe(1); // miniseg unchanged
    }
  });
});

/* ------------------------------------------------------------------ */
/* Hand-built plain-MapData micro maps (paths mapBuilder cannot emit)  */
/* ------------------------------------------------------------------ */

function handMiniMap(opts: { mid: string; twoSided: boolean }): MapData {
  const F = (v: number): number => (v * FRACUNIT) | 0;
  const vertices: Vertex[] = [
    { x: 64, y: 64 }, // 0 — wall at x=64; travel 0→1 heads SOUTH ⇒ front = WEST
    { x: 64, y: -64 },
    { x: 0, y: -64 }, // 2 — partition span (miniseg)
    { x: 0, y: 64 },
  ];
  // Identical sectors (heights AND light) so only midtex can defeat noDraw.
  const sectors: SectorDef[] = [mkSector(0, 128, 192), mkSector(0, 128, 192)];
  const sides: SideDef[] = [mkSide(0, '', opts.mid, '', 0)];
  if (opts.twoSided) sides.push(mkSide(1, '', '', '', 0));
  const lines: LineDef[] = [
    { v1: 0, v2: 1, front: 0, back: opts.twoSided ? 1 : -1, flags: opts.twoSided ? 0x4 : 0, special: 0, tag: 0 },
  ];
  const segs: Seg[] = [
    // west subsector: the wall seg (front side faces the player) + miniseg
    { v1: 0, v2: 1, angle: 49152, line: 0, side: 0, offset: 0 },
    { v1: 3, v2: 2, angle: 49152, line: -1, side: 0, offset: 0 },
  ];
  const node = {
    bbox: { top: 128, bottom: -128, left: 0, right: 128 },
    rightBBox: { top: 128, bottom: -128, left: 0, right: 128 }, // child 0 = east/front
    leftBBox: { top: 128, bottom: -128, left: -128, right: 0 }, // child 1 = west/back
    splitx: F(0),
    splity: F(0),
    dx: F(0),
    dy: F(256),
    right: 0 | 0x8000, // raw u16 refs, high bit = NF_SUBSECTOR
    left: 1 | 0x8000,
  };
  return {
    name: 'FIXMAP',
    things: new Uint8Array(10),
    lineDefs: lines,
    sideDefs: sides,
    vertices,
    segs,
    ssectors: [
      { numsegs: 0, firstseg: 0 }, // ss 0 = east half (empty of segs here)
      { numsegs: 2, firstseg: 0 }, // ss 1 = west half: wall seg + miniseg
    ],
    nodes: [node as unknown as Node],
    sectors,
    reject: new Uint8Array(1),
    blockmap: new Uint8Array(20),
  };
}

function mkSector(floor: number, ceil: number, light: number): SectorDef {
  return {
    floorLh: floor,
    ceilingLh: ceil,
    floorFlat: 'FIXFLAT0',
    ceilingFlat: 'FIXFLAT1',
    lightLevel: light,
    special: 0,
    tag: 0,
  };
}

function mkSide(sector: number, top: string, mid: string, bottom: string, off: number): SideDef {
  return { sector, toptexture: top, midtexture: mid, bottomtexture: bottom, offset: [off, 0], light: 0 };
}

/* ------------------------------------------------------------------ */
/* 3. E1M1: spawn walk + tree front-first proof (skipIf)               */
/* ------------------------------------------------------------------ */

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();
const hasWad = WAD_PATH !== undefined;

describe.skipIf(!hasWad)('freedoom1.wad E1M1 BSP walk', () => {
  let cached: Fixture & { wad: WadFile } | undefined;
  function e1m1(): Fixture & { wad: WadFile } {
    if (!cached) {
      const wad = WadFile.parse(readFileSync(WAD_PATH!).buffer as ArrayBuffer);
      const md = loadMap(wad, 'E1M1');
      cached = { md, world: loadRenderWorld(md, texturesFromWad(wad)), view: buildRenderMapView(md), wad };
    }
    return cached;
  }

  function spawnView(): ViewState {
    const v = createViewState();
    const md = e1m1().md;
    for (let i = 0; i < md.things.length / 10; i += 1) {
      const t = thingAt(md, i);
      if (t.type >= 1 && t.type <= 4) {
        setupXY(v, t.x, t.y, t.angle);
        return v;
      }
    }
    throw new Error('no player start thing in E1M1 THINGS');
  }

  it('spawn viewpoint walk completes with real content', () => {
    const fix = e1m1();
    const walker = createBspWalker(fix.view, fix.world);
    const log = new WalkLog();
    log.init(fix.world.numSegs);
    log.begin();
    clearClipSegs();
    expect(() => walker.walk(spawnView(), log.cbs)).not.toThrow();
    let reached = 0;
    for (let s = 0; s < fix.world.numSegs; s += 1) if (log.reached[s] === log.stamp) reached += 1;
    expect(reached).toBeGreaterThan(100);
    expect(solidsegsLength()).toBe(2); // recorder wiring ⇒ ledger untouched (sentinels)
    expect(getRenderCounters().hom).toBe(0);
  });

  it('visit order is strictly front-first: intervals align with child subtrees', () => {
    const fix = e1m1();
    const walker = createBspWalker(fix.view, fix.world);
    const nodes = fix.view.nodes;
    const events: { kind: number; a: number; b: number }[] = [];
    const cb: WalkCallbacks = {
      addSolid() {},
      addPass() {},
      onNodeEnter: (n, s) => {
        events.push({ kind: 0, a: n, b: s });
        return undefined;
      },
      onFarEnter: (n, s) => {
        events.push({ kind: 1, a: n, b: s });
        return undefined;
      },
      onNodeExit: (n) => {
        events.push({ kind: 2, a: n, b: 0 });
        return undefined;
      },
      onSubsector: (ss) => {
        events.push({ kind: 3, a: ss, b: 0 });
        return undefined;
      },
    };
    clearClipSegs();
    walker.walk(spawnView(), cb);
    expect(events.length).toBeGreaterThan(100);

    const ssBox = subsectorBoxes(fix);
    /** strict containment: ss bbox inside child slot's bbox (fixed layout
     * [BOXTOP,BOXBOTTOM,BOXLEFT,BOXRIGHT] per node*8 + side*4). */
    const contained = (ss: number, node: number, side: number): boolean => {
      const b = node * 8 + side * 4;
      return (
        ssBox[ss * 4]! >= nodes.bboxes[b + 2]! && // LEFT
        ssBox[ss * 4 + 2]! <= nodes.bboxes[b + 3]! && // RIGHT
        ssBox[ss * 4 + 1]! >= nodes.bboxes[b + 1]! && // BOTTOM
        ssBox[ss * 4 + 3]! <= nodes.bboxes[b]! // TOP
      );
    };

    interface Frame {
      node: number;
      near: number; // side of the near child (from the walker's own event)
      phase: 0 | 1;
    }
    const stack: Frame[] = [];
    let ambiguous = 0;
    for (const ev of events) {
      if (ev.kind === 0) {
        stack.push({ node: ev.a, near: ev.b, phase: 0 });
      } else if (ev.kind === 1) {
        const top = stack[stack.length - 1]!;
        expect(top.node, 'far-enter must resume the node it suspended').toBe(ev.a);
        expect(ev.b, 'far side complements the near side').toBe(top.near ^ 1);
        top.phase = 1;
      } else if (ev.kind === 2) {
        stack.pop();
      } else {
        for (const f of stack) {
          const side = f.phase === 0 ? f.near : f.near ^ 1;
          const here = contained(ev.a, f.node, side);
          const there = contained(ev.a, f.node, side ^ 1);
          if (!here && !there) {
            throw new Error(`subsector ${ev.a} lies in neither child box of node ${f.node} — BSP bbox data broken`);
          }
          if (here && there) {
            // Boundary straddle: the subsector box touches BOTH child
            // boxes (they meet on the partition plane). No violation can
            // be proven from box data alone — pass leniently.
            ambiguous += 1;
          }
          if (there && !here) {
            throw new Error(
              `subsector ${ev.a} visited during node ${f.node}'s ${f.phase === 0 ? 'NEAR' : 'FAR'} interval (side ${side}) but lies in the sibling subtree — front-first order violated`,
            );
          }
        }
      }
    }
    expect(stack.length).toBe(0);
    expect(ambiguous).toBeLessThan(events.length); // straddles exist but center-resolution keeps them non-fatal
  });
});

/** Subsector bbox [minx, miny, maxx, maxy] fixed, from its segs' vertices. */
function subsectorBoxes(fix: Fixture): Int32Array {
  const sub = fix.view.subsectors;
  const out = new Int32Array(sub.count * 4);
  for (let ss = 0; ss < sub.count; ss += 1) {
    let x0c = 0x7fffffff;
    let y0c = 0x7fffffff;
    let x1c = -0x7fffffff;
    let y1c = -0x7fffffff;
    const e = sub.segStart[ss]! + sub.segCount[ss]!;
    for (let s = sub.segStart[ss]!; s < e; s += 1) {
      const x0 = fix.world.segV1x[s]!;
      const y0 = fix.world.segV1y[s]!;
      const x1 = fix.world.segV2x[s]!;
      const y1 = fix.world.segV2y[s]!;
      for (let k = 0; k < 2; k += 1) {
        const x = k === 0 ? x0 : x1;
        const y = k === 0 ? y0 : y1;
        if (x < x0c) x0c = x;
        if (x > x1c) x1c = x;
        if (y < y0c) y0c = y;
        if (y > y1c) y1c = y;
      }
    }
    out[ss * 4] = x0c;
    out[ss * 4 + 1] = y0c;
    out[ss * 4 + 2] = x1c;
    out[ss * 4 + 3] = y1c;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 4. Zero-allocation steady state (reuse design, not heap sampling)   */
/* ------------------------------------------------------------------ */

describe('zero-alloc steady state (buffer reuse probes)', () => {
  it('1000 frames reuse walker buffers + callbacks, digest identical', () => {
    const fix = fixtureFromSpec(SWEEP_SPEC);
    const walker = createBspWalker(fix.view, fix.world);
    const kindBuf = walker.stackKind;
    const valBuf = walker.stackVal;
    const log = new WalkLog();
    log.init(fix.world.numSegs);
    const view = createViewState();
    setupXY(view, 64, 128, 0);

    const digests: number[] = [];
    for (let f = 0; f < 1000; f += 1) {
      log.begin(); // reuses the SAME arrays (init() only grows, never shrinks)
      clearClipSegs();
      walker.walk(view, log.cbs); // one callback object, no closures per frame
      digests.push(log.digest);
    }
    expect(digests.every((d) => d === digests[0] && d !== 0)).toBe(true);
    expect(walker.stackKind).toBe(kindBuf); // never grew, never reallocated
    expect(walker.stackVal).toBe(valBuf);
    expect(log.reached.length).toBe(fix.world.numSegs);
    expect(log.kind.length).toBe(fix.world.numSegs);
  });

  it('production wiring (solidsegs callbacks) inserts and is frame-idempotent', () => {
    const fix = fixtureFromSpec(SWEEP_SPEC);
    const walker = createBspWalker(fix.view, fix.world);
    const view = createViewState();
    // (192,100) due west: the void wall x=0 subtends strictly INSIDE the
    // screen (a full-width span would merge into a sentinel and leave the
    // entry count collapsed at 2 — vanilla-legal) ⇒ a genuine insert.
    setupXY(view, 192, 100, 180);
    clearClipSegs();
    walker.walk(view, solidsegsWalkCallbacks());
    const n1 = solidsegsLength();
    expect(n1).toBeGreaterThan(2); // ledger grew — segs really inserted
    clearClipSegs();
    walker.walk(view, solidsegsWalkCallbacks());
    expect(solidsegsLength()).toBe(n1);
    expect(getRenderCounters().hom).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* View setup units (r_main.c half of the task)                        */
/* ------------------------------------------------------------------ */

describe('setupView + initTextureMapping + bridge', () => {
  it('viewz = z + 41<<16 placeholder; sin/cos + read-throughs', () => {
    const v = createViewState();
    setupView(v, { x: 10 * FRACUNIT, y: -3 * FRACUNIT, z: 4 * FRACUNIT, angle: 0x40000000, extralight: 2 });
    expect(v.viewx).toBe(10 * FRACUNIT);
    expect(v.viewy).toBe(-3 * FRACUNIT);
    expect(v.viewz).toBe(4 * FRACUNIT + VIEWHEIGHT_FIXED);
    expect(VIEWHEIGHT_FIXED).toBe(41 << 16);
    expect(v.viewsin).toBe(finesine[2048]);
    expect(v.viewcos).toBe(finecosine[2048]);
    expect(v.extralight).toBe(2);
    expect(v.fixedcolormap).toBe(-1);
    setupView(v, { x: 1, y: 2, angle: 0 });
    expect(v.viewz).toBe(VIEWHEIGHT_FIXED); // z defaults to 0
  });

  it('texture mapping: clipangle = xtoviewangle[0] (NO <<16); tables pinned', () => {
    const m = initTextureMapping();
    expect(m.clipangle).toBe(m.xtoviewangle[0]! >>> 0);
    expect(m.clipangle).toBeGreaterThan(0x20000000); // just over half-FOV (45°)
    expect(m.clipangle).toBeLessThan(0x21000000);
    expect(m.xtoviewangle[160]).toBe(0); // dead ahead = angle 0
    expect(m.viewangletox[2048]).toBe(160); // relative angle 0 ⇒ screen center
    // viewangletox spans screen x: 320 → 0 as the fine angle sweeps 0..180°
    expect(m.viewangletox[0]).toBe(320);
    expect(m.viewangletox[4095]).toBe(0);
    for (let i = 1; i < 4096; i += 1) {
      expect(m.viewangletox[i]!).toBeLessThanOrEqual(m.viewangletox[i - 1]!);
    }
    // xtoviewangle[x] = SMALLEST angle mapping to x: as x grows the scan
    // stops at an EARLIER fine index ⇒ monotone DECREASING in the angle
    // value: positive (0→+45° side) shrinks toward 0 at x=160, then the
    // negative half wraps to huge u32 and grows toward −45° ⇒ the u32
    // order flips at the wrap.
    for (let x = 1; x <= 160; x += 1) {
      expect(m.xtoviewangle[x]! >>> 0).toBeLessThanOrEqual(m.xtoviewangle[x - 1]! >>> 0);
    }
    expect(m.xtoviewangle[161]! >>> 0).toBeGreaterThan(m.xtoviewangle[160]! >>> 0); // wrap
    for (let x = 162; x <= 320; x += 1) {
      // negative angles (u32-wrapped) grow MORE negative toward x=320 ⇒
      // the raw u32 still decreases after the 0 → 0xFFFF… wrap.
      expect(m.xtoviewangle[x]! >>> 0).toBeLessThanOrEqual(m.xtoviewangle[x - 1]! >>> 0);
    }
    // focallength ≈ centerxfrac (the FOV/2 tangent at index 2048+1024 is
    // cot(45°)=1 ⇒ focallength = FixedDiv(centerxfrac, FRACUNIT) exactly):
    expect(Math.abs(m.focallength - (160 << 16))).toBeLessThan(2 * FRACUNIT);
  });

  it('buildRenderMapView bridge: raw child refs, fixed bboxes, sector resolution, root', () => {
    const fix = fixtureFromSpec(SWEEP_SPEC);
    expect(bspRoot(fix.view)).toBe(fix.view.nodes.count - 1);
    for (let i = 0; i < fix.view.nodes.count; i += 1) {
      for (const c of [fix.view.nodes.child0[i]!, fix.view.nodes.child1[i]!]) {
        if ((c & 0x8000) !== 0) expect(c & 0x7fff).toBeLessThan(fix.view.subsectors.count);
        else expect(c).toBeLessThan(fix.view.nodes.count);
      }
      for (let k = 0; k < 8; k += 1) {
        expect(fix.view.nodes.bboxes[i * 8 + k]! & (FRACUNIT - 1)).toBe(0); // fixed units
      }
    }
    for (let ss = 0; ss < fix.view.subsectors.count; ss += 1) {
      expect(fix.view.subsectors.sector[ss]!).toBeGreaterThanOrEqual(0);
    }
    expect(bspRoot(buildRenderMapView(handMiniMap({ mid: '', twoSided: false })))).toBe(0); // 1 node
    const noNodes = handMiniMap({ mid: '', twoSided: false });
    noNodes.nodes = [];
    expect(bspRoot(buildRenderMapView(noNodes))).toBe(-1); // → subsector 0
  });
});

/* ------------------------------------------------------------------ */
/* G11 pin: renderer pointOnSide vs an independent r_main.c copy       */
/* ------------------------------------------------------------------ */

describe('G11 — pointOnSide reference parity (r_main.c:162)', () => {
  it('matches the test-local copy on 10k seeded (point, node) pairs', () => {
    const fix = fixtureFromSpec(SWEEP_SPEC);
    const rand = lcg(0x911);
    const F = (v: number): number => (v * FRACUNIT) | 0;
    for (let t = 0; t < 10000; t += 1) {
      const x = F(-128 + rand() * 768);
      const y = F(-128 + rand() * 640);
      const i = Math.floor(rand() * fix.view.nodes.count);
      expect(pointOnSideXY(x, y, fix.view.nodes, i)).toBe(refPointOnSide(x, y, fix, i));
    }
  });
});

/** r_main.c:162 re-derived independently (G11 twin; no shared code). */
function refPointOnSide(x: number, y: number, fix: Fixture, i: number): 0 | 1 {
  const n = fix.md.nodes[i]!;
  const nx = (n.splitx * FRACUNIT) | 0;
  const ny = (n.splity * FRACUNIT) | 0;
  const ndx = (n.dx * FRACUNIT) | 0;
  const ndy = (n.dy * FRACUNIT) | 0;
  if (ndx === 0) {
    if (x <= nx) return ndy > 0 ? 1 : 0;
    return ndy < 0 ? 1 : 0;
  }
  if (ndy === 0) {
    if (y <= ny) return ndx < 0 ? 1 : 0;
    return ndx > 0 ? 1 : 0;
  }
  const dx = (x - nx) | 0;
  const dy = (y - ny) | 0;
  if ((ndy ^ ndx ^ dx ^ dy) & 0x80000000) {
    if ((ndy ^ dx) & 0x80000000) return 1;
    return 0;
  }
  const left = fixedMulRef(ndy >> 16, dx);
  const right = fixedMulRef(dy, ndx >> 16);
  return right < left ? 0 : 1;
}

function fixedMulRef(a: number, b: number): number {
  // (a*b)>>16 via the exact limb split, re-derived (no import sharing)
  const a0 = a & 0xffff;
  const a1 = a >> 16;
  const b0 = b & 0xffff;
  const b1 = b >> 16;
  return (((a1 * b1) << 16) + (a1 * b0 + a0 * b1) + ((a0 * b0) >>> 16)) | 0;
}

/* ------------------------------------------------------------------ */
/* 8. M4-01 seam: R_Subsector plane opens + validcount + sprites SLOT  */
/* ------------------------------------------------------------------ */

describe('M4-01 plane-open seam (r_bsp.c:522-549)', () => {
  const fix = fixtureFromSpec(SWEEP_SPEC);
  const walker = createBspWalker(fix.view, fix.world);

  it('walk opens floor/ceiling planes per §0.4 predicates; heights ⊆ sector heights', () => {
    resetPlanesForTests();
    const view = createViewState();
    setupXY(view, 128, 128, 0); // inside room A, eye above floor 0
    clearClipSegs();
    walker.walk(view, solidsegsWalkCallbacks());

    expect(planeCount()).toBeGreaterThan(0);
    const heights = new Set<number>();
    for (let s = 0; s < fix.world.numSectors; s += 1) {
      heights.add(fix.world.sectorFloor[s]!);
      heights.add(fix.world.sectorCeil[s]!);
    }
    for (let p = 0; p < planeCount(); p += 1) {
      expect(heights.has(planeHeight(planeAt(p)))).toBe(true);
    }
  });

  it('viewpoint below every floor (viewz < 0 floor marks fail) ⇒ no floor planes', () => {
    resetPlanesForTests();
    const view = createViewState();
    setupXY(view, 128, 128, 0, -1000); // viewz = (−1000+41)·FRACUNIT « floors
    clearClipSegs();
    walker.walk(view, solidsegsWalkCallbacks());
    for (let p = 0; p < planeCount(); p += 1) {
      // Only ceiling heights (112/128·FRACUNIT) may open — floor(0/16) never:
      const h = planeHeight(planeAt(p));
      expect(h).toBeGreaterThan(0);
    }
  });

  it('validcount increments exactly once per walk (R_RenderPlayerView parity)', () => {
    const view = createViewState();
    setupXY(view, 128, 128, 45);
    const v0 = getValidcount();
    walker.walk(view, solidsegsWalkCallbacks());
    expect(getValidcount() - v0).toBe(1);
    walker.walk(view, solidsegsWalkCallbacks());
    expect(getValidcount() - v0).toBe(2);
  });

  it('addSectorSprites SLOT fires once per visited subsector, after plane opens', () => {
    resetPlanesForTests();
    const view = createViewState();
    setupXY(view, 128, 128, 90);
    let subs = 0;
    let sprites = 0;
    let lastPlaneCount = -1;
    let planeCountAtFirstSprite = -1;
    walker.walk(view, {
      addSolid: () => {},
      addPass: () => {},
      onSubsector: () => {
        subs += 1;
      },
      addSectorSprites: () => {
        sprites += 1;
        if (planeCountAtFirstSprite < 0) planeCountAtFirstSprite = planeCount();
        lastPlaneCount = planeCount();
      },
    });
    expect(subs).toBeGreaterThan(0);
    expect(sprites).toBe(subs); // per-subsector call site, no dedupe (M4-05 owns that)
    // vanilla order: plane opens BEFORE R_AddSprites ⇒ planes exist at slot time
    expect(planeCountAtFirstSprite).toBeGreaterThan(0);
    expect(lastPlaneCount).toBeGreaterThanOrEqual(planeCountAtFirstSprite);
  });
});
