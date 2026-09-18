/**
 * M3-06b acceptance matrix — seg renderer (R_StoreWallRange / R_RenderSegLoop).
 *
 * Acceptance 1: analytic screen spans. Each viewpoint's expected first/last
 * painted rows are hand-derived from the vanilla fixed-point chain and were
 * cross-verified against a byte-exact chain replica (fixed-point dumps of
 * rw_distance / rw_scale / topfrac / bottomfrac):
 *
 *   scale       = R_ScaleFromGlobalAngle(viewangle + xtoviewangle[x])
 *                 (r_segs.c:418-425 -> r_main.c:447-505: scale =
 *                 FixedDiv(160<<16 * sineb, rw_distance * sinea), clamped)
 *   worldtop    = frontsector->ceilingheight - viewz   (r_segs.c:450)
 *   worldbottom = frontsector->floorheight  - viewz    (r_segs.c:451)
 *   topfrac     = (centeryfrac>>4) - FixedMul(worldtop,    rw_scale)  (r_segs.c:684)
 *   bottomfrac  = (centeryfrac>>4) - FixedMul(worldbottom, rw_scale)  (r_segs.c:687)
 *   yl = (topfrac + HEIGHTUNIT-1) >> HEIGHTBITS        (r_segs.c:222, ceil)
 *   yh =  bottomfrac >> HEIGHTBITS                     (r_segs.c:243, floor)
 *
 * i.e. screen row = CENTERY(=100) - h*rw_scale with h = world height relative
 * to the eye (the centery - h*scale chain). One-sided lines are terminal and
 * span the FRONT sector's full floor..ceiling range (r_segs.c:456-459),
 * independent of the 128-high texture's own height.
 *
 * Test worlds: one-sided vertical wall on line x=0, y in [64,192], front
 * sector floor 0 / ceiling 128, eye viewz = z + 41<<16 (view.ts VIEWHEIGHT_FIXED).
 */
import { describe, expect, it } from "vitest";

import { ANG180, FRACUNIT } from "../core/constants";
import type { LineDef, MapData, Seg, SectorDef, SideDef, TextureDef, Vertex } from "../wad/types";

import { Framebuffer } from "./framebuffer";
import { createSegCallbacks } from "./segs";
import { loadRenderWorld, type RenderWorld } from "./rdata";
import { clearDrawsegs, clearClipArrays, ceilingclip, clipValue, drawsegAdd, drawsegCount, floorclip, getDrawsegs, maskedTexturecol, openingsUsed, snapshotOpenings, CLIP_NEGONE, CLIP_NULL, CLIP_SCREEN, MAXSHORT, SIL_NONE } from "./drawsegs";
import { clearClipSegs, getRenderCounters, resetRenderCounters } from "./solidsegs";
import { createViewState, setupView, VIEWHEIGHT } from "./view";

const WALL_TEX = "FIXWALL";

function mkTex(width: number, height: number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c++) {
    const col = new Uint8Array(height);
    for (let r = 0; r < height; r++) col[r] = ((c * 3 + r * 5) % 255) + 1; // never 0
    columns.push(col);
  }
  return { name: WALL_TEX, width, height, patches: [], columns } as unknown as TextureDef;
}

/**
 * One-sided wall at x=0, y in [64,192]; front sector floor 0, ceiling `ceil`,
 * midtexture `texH` tall (pegging semantics need a sub-sector height),
 * linedef `flags` (0x10 = ML_DONTPEGBOTTOM).
 */
function oneSidedWorld(ceil = 128, texH = 128, flags = 0): RenderWorld {
  const vertices: Vertex[] = [{ x: 0, y: 64 }, { x: 0, y: 192 }];
  const sectors: SectorDef[] = [
    { floorLh: 0, ceilingLh: ceil, floorFlat: "F", ceilingFlat: "F", lightLevel: 192, special: 0, tag: 0 },
  ];
  const sideDefs: SideDef[] = [
    { sector: 0, toptexture: "", midtexture: WALL_TEX, bottomtexture: "", offset: [0, 0], light: 0 },
  ];
  const lineDefs: LineDef[] = [{ v1: 0, v2: 1, front: 0, back: -1, flags, special: 0, tag: 0 }];
  const segs: Seg[] = [{ v1: 0, v2: 1, angle: (0x40000000 >>> 16) & 0xffff, line: 0, side: 0, offset: 0 }];
  const md: MapData = {
    name: "SEGFIX", things: new Uint8Array(0), lineDefs, sideDefs, vertices, segs,
    ssectors: [], nodes: [], sectors, reject: new Uint8Array(0), blockmap: new Uint8Array(0),
  };
  return loadRenderWorld(md, new Map([[WALL_TEX, mkTex(64, texH)]]));
}

interface Viewpoint {
  name: string;
  x: number;
  y: number;
  z?: number; // added to viewz = 41<<16 (view.ts setupView)
  angle: number;
  ceil?: number; // front sector ceiling height (default 128)
  a: number; // store range start column
  b: number; // store range end column
  scale1: number; // expected ds.scale1 (r_segs.c:419-420)
  spans: Record<number, [number, number]>; // col -> inclusive painted [yl, yh]
  blank?: number[]; // columns inside (a-1..) that must stay unpainted
}

const VIEWPOINTS: Viewpoint[] = [
  {
    // Perpendicular, d = rw_distance = 160 -> scale = 160/160 = 1.0.
    // top = 100 - (128-41)*1 = 13 ; bottom = 100 + 41*1 = 141.
    name: "perpendicular d=160, screen center col 160",
    x: 160, y: 128, angle: ANG180, a: 160, b: 160, scale1: 65536,
    spans: { 160: [13, 141] },
  },
  {
    // Twice as close, front ceiling lowered to 72: scale = 160/80 = 2.0.
    // One-sided span follows the FRONT sector heights (r_segs.c:450-451):
    // top = 100 - (72-41)*2 = 38 ; bottom = 100 + 41*2 = 182.
    name: "near wall d=80 (scale 2.0), ceiling 72",
    x: 80, y: 128, angle: ANG180, ceil: 72, a: 160, b: 160, scale1: 131072,
    spans: { 160: [38, 182] },
  },
  {
    // Off-axis: eye (160,0) at 45deg to the wall normal; rw_distance = 160
    // (perpendicular distance to plane x=0), sinea/sineb give
    // scale = 7417280/10485599 = 46358 = 0.707367 (r_main.c:483-493).
    // top = 100 - 87*0.707367 -> yl = ceil(38.44) = 39;
    // bottom = 100 + 41*0.707367 = 129.002 -> yh = 129.
    name: "off-axis 45deg viewpoint (160,0)",
    x: 160, y: 0, angle: 0x60000000, a: 160, b: 160, scale1: 46358,
    spans: { 160: [39, 129] },
  },
  {
    // Higher eye: setupView adds VIEWHEIGHT_FIXED, so z=40*FRACUNIT -> viewz=81.
    // top = 100 - (128-81)*1 = 53 ; bottom = 100 + 81*1 = 181.
    name: "eye height 81 (z offset +40)",
    x: 160, y: 128, z: 40 * FRACUNIT, angle: ANG180, a: 160, b: 160, scale1: 65536,
    spans: { 160: [53, 181] },
  },
  {
    // Off-center column of the same perpendicular wall: rw_distance is the
    // plane distance so scale stays 1.0 -> identical span, no x-dependence.
    name: "perpendicular d=160, off-center col 96",
    x: 160, y: 128, angle: ANG180, a: 96, b: 96, scale1: 65536,
    spans: { 96: [13, 141] },
  },
  {
    // Multi-column store: every column in [140,180] paints the same span
    // (scale1 == scale2 == 65536, scalestep 0); col 139 stays untouched.
    name: "perpendicular d=160, range 140..180",
    x: 160, y: 128, angle: ANG180, a: 140, b: 180, scale1: 65536,
    spans: { 140: [13, 141], 160: [13, 141], 180: [13, 141] },
    blank: [139],
  },
];

function spanAt(fb: Framebuffer, x: number): [number, number] {
  let lo = -1;
  let hi = -1;
  for (let y = 0; y < VIEWHEIGHT; y++) {
    if (fb.indices[y * 320 + x] !== 0) {
      if (lo === -1) lo = y;
      hi = y;
    }
  }
  return [lo, hi];
}

describe("segs (M3-06b acceptance 1): analytic screen spans", () => {
  for (const vp of VIEWPOINTS) {
    it(`one-sided wall span: ${vp.name}`, () => {
      const fb = new Framebuffer();
      const view = createViewState();
      setupView(view, { x: vp.x * FRACUNIT, y: vp.y * FRACUNIT, z: vp.z, angle: vp.angle });
      const cb = createSegCallbacks(fb, oneSidedWorld(vp.ceil ?? 128, 128), view);
      clearClipSegs(320);
      clearDrawsegs();
      clearClipArrays(VIEWHEIGHT);
      cb.onSegReached?.(0, vp.a, vp.b);
      cb.addSolid(vp.a, vp.b);

      const ds = getDrawsegs();
      expect(ds.scale1[0]).toBe(vp.scale1); // r_segs.c:419-420

      for (const [col, want] of Object.entries(vp.spans)) {
        expect(spanAt(fb, Number(col))).toEqual(want);
      }
      for (const x of vp.blank ?? []) {
        expect(fb.indices[100 * 320 + x]).toBe(0); // never painted outside [a,b]
      }
      // Range interior must be solid (no gaps between yl and yh).
      for (const [col, [yl, yh]] of Object.entries(vp.spans)) {
        for (let y = yl; y <= yh; y++) expect(fb.indices[y * 320 + Number(col)]).not.toBe(0);
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* Acceptance 4: one-sided occlusion (pixel probe through the ledger). */
/* ------------------------------------------------------------------ */

/**
 * Two-line world for occlusion: one-sided wall `seg0` at x=0 (same geometry
 * as acceptance 1) plus a two-sided line `seg1` at x=-64 (y 64..192) whose
 * back sector (floor `backFloor`, ceiling 128) leaves a lower opening; the
 * bottomtexture rides the FRONT sidedef (r_segs.c:445 `sidedef[side]`).
 * Sidedef indices: 0 = line0 front, 1 = line1 front (corridor, sector 0),
 * 2 = line1 back (sector 1) — the salvage scratch used out-of-range
 * front:2/back:3 here, which silently degenerates; corrected.
 */
function occlWorld(backFloor: number): RenderWorld {
  const vertices: Vertex[] = [
    { x: 0, y: 64 }, { x: 0, y: 192 }, { x: -64, y: 64 }, { x: -64, y: 192 },
  ];
  const flat = (floorLh: number): SectorDef =>
    ({ floorLh, ceilingLh: 128, floorFlat: "F", ceilingFlat: "F", lightLevel: 192, special: 0, tag: 0 });
  const sectors: SectorDef[] = [flat(0), flat(backFloor)];
  const sideDefs: SideDef[] = [
    { sector: 0, toptexture: "", midtexture: WALL_TEX, bottomtexture: "", offset: [0, 0], light: 0 },
    { sector: 0, toptexture: "", midtexture: "", bottomtexture: WALL_TEX, offset: [0, 0], light: 0 },
    { sector: 1, toptexture: "", midtexture: "", bottomtexture: "", offset: [0, 0], light: 0 },
  ];
  const lineDefs: LineDef[] = [
    { v1: 0, v2: 1, front: 0, back: -1, flags: 0, special: 0, tag: 0 },
    { v1: 2, v2: 3, front: 1, back: 2, flags: 4, special: 0, tag: 0 }, // ML_TWOSIDED
  ];
  const ANG90SEG = (0x40000000 >>> 16) & 0xffff;
  const segs: Seg[] = [
    { v1: 0, v2: 1, angle: ANG90SEG, line: 0, side: 0, offset: 0 },
    { v1: 2, v2: 3, angle: ANG90SEG, line: 1, side: 0, offset: 0 },
  ];
  const md: MapData = {
    name: "SEGOCCL", things: new Uint8Array(0), lineDefs, sideDefs, vertices, segs,
    ssectors: [], nodes: [], sectors, reject: new Uint8Array(0), blockmap: new Uint8Array(0),
  };
  return loadRenderWorld(md, new Map([[WALL_TEX, mkTex(64, 128)]]));
}

function snapshotRegion(fb: Framebuffer, x1: number, x2: number): number[] {
  const out: number[] = [];
  for (let x = x1; x <= x2; x++) for (let y = 0; y < VIEWHEIGHT; y++) out.push(fb.indices[y * 320 + x]!);
  return out;
}

function changedCount(fb: Framebuffer, x1: number, x2: number, snap: number[]): number {
  let n = 0;
  let k = 0;
  for (let x = x1; x <= x2; x++) for (let y = 0; y < VIEWHEIGHT; y++) if (fb.indices[y * 320 + x] !== snap[k++]) n++;
  return n;
}

function paintedCount(fb: Framebuffer, x: number): number {
  let n = 0;
  for (let y = 0; y < VIEWHEIGHT; y++) if (fb.indices[y * 320 + x] !== 0) n++;
  return n;
}

describe("segs (M3-06b acceptance 4): one-sided occlusion pixel probe", () => {
  const fresh = () => {
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, occlWorld(16), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();
    return { fb, cb };
  };

  it("pass seg behind a one-sided wall splits around it; covered pixels untouched", () => {
    const { fb, cb } = fresh();
    cb.onSegReached?.(0, 140, 180);
    cb.addSolid(140, 180); // terminal one-sided wall, full-height ledger block
    const snap = snapshotRegion(fb, 140, 180);

    cb.onSegReached?.(1, 100, 220);
    cb.addPass(100, 220); // two-sided lower band, wider than the wall

    const ds = getDrawsegs();
    expect(drawsegCount()).toBe(3); // wall + 2 fragments (R_AddLine clip split)
    expect([ds.x1[1], ds.x2[1]]).toEqual([100, 139]);
    expect([ds.x1[2], ds.x2[2]]).toEqual([181, 220]);
    expect(changedCount(fb, 140, 180, snap)).toBe(0); // pixel probe: zero behind wall
    expect(paintedCount(fb, 120)).toBeGreaterThan(0); // fragments outside DO draw
    expect(paintedCount(fb, 200)).toBeGreaterThan(0);
    expect(spanAt(fb, 140)).toEqual([13, 141]); // wall pixels intact (acceptance 1 d=160)
    expect(getRenderCounters()).toEqual({ hom: 0, drawsegOverflow: 0, solidsegDrops: 0 });
  });

  it("fully occluded pass seg stores nothing and changes no pixels", () => {
    const { fb, cb } = fresh();
    cb.onSegReached?.(0, 100, 220);
    cb.addSolid(100, 220); // wall covers the whole pass range
    const snap = snapshotRegion(fb, 140, 180);

    cb.onSegReached?.(1, 140, 180);
    cb.addPass(140, 180);

    expect(drawsegCount()).toBe(1); // R_AddLine clipsegs ate the seg entirely
    expect(changedCount(fb, 140, 180, snap)).toBe(0);
    expect(getRenderCounters()).toEqual({ hom: 0, drawsegOverflow: 0, solidsegDrops: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 5: drawsegs overflow — the 257th store is counted, not   */
/* stored (vanilla I_Error at r_segs.c:385-387 -> counter + silent     */
/* return here).                                                        */
/* ------------------------------------------------------------------ */

describe("segs (M3-06b acceptance 5): drawseg overflow (257th)", () => {
  it("257th drawseg request increments the overflow counter and draws nothing", () => {
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, oneSidedWorld(128), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();

    for (let i = 0; i < 256; i++) expect(drawsegAdd(0)).toBe(i); // MAXDRAWSEGS full
    cb.onSegReached?.(0, 160, 160); // the 257th store
    cb.addSolid(160, 160);

    expect(drawsegCount()).toBe(256); // overflow seg NOT stored
    expect(getRenderCounters().drawsegOverflow).toBe(1);
    expect(paintedCount(fb, 160)).toBe(0); // bailed before the pixel loop
  });

  it("control: same store with headroom draws and does not overflow", () => {
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, oneSidedWorld(128), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();

    cb.onSegReached?.(0, 160, 160);
    cb.addSolid(160, 160);

    expect(drawsegCount()).toBe(1);
    expect(getRenderCounters().drawsegOverflow).toBe(0);
    expect(spanAt(fb, 160)).toEqual([13, 141]);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 3: texture pegging — ML_DONTPEGBOTTOM re-anchors the     */
/* midtexture band. One-sided: plain pegs the texture TOP to the       */
/* ceiling (r_segs.c:467-469 else-branch, rw_midtexturemid = ceiling  */
/* - viewz); DONTPEGBOTTOM puts the texture BOTTOM at the floor via    */
/* vtop = floorheight + texheight (r_segs.c:461-465). With a 64-tall   */
/* texture in a 128-tall sector the two 64-row bands are disjoint.     */
/* ------------------------------------------------------------------ */

describe("segs (M3-06b acceptance 3): pegging rows differ", () => {
  const ML_DONTPEGBOTTOM = 0x10;

  function pegStore(flags: number): Framebuffer {
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, oneSidedWorld(128, 64, flags), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();
    cb.onSegReached?.(0, 160, 160);
    cb.addSolid(160, 160);
    return fb;
  }

  it("plain pegging: texture top at ceiling — rows 13..76, floor line clear", () => {
    const fb = pegStore(0);
    expect(spanAt(fb, 160)).toEqual([13, 76]); // 100-87 .. 13+64-1
    expect(fb.indices[13 * 320 + 160]).not.toBe(0);
    expect(fb.indices[141 * 320 + 160]).toBe(0); // band does not reach the floor
  });

  it("ML_DONTPEGBOTTOM: texture bottom at floor — rows 77..141", () => {
    const fb = pegStore(ML_DONTPEGBOTTOM);
    expect(spanAt(fb, 160)).toEqual([77, 141]); // vtop = 0+64 -> 100-23 .. 100+41
    expect(fb.indices[13 * 320 + 160]).toBe(0);
    expect(fb.indices[141 * 320 + 160]).not.toBe(0);
  });

  it("the two peggings paint disjoint rows and differ pixel-for-pixel", () => {
    const plain = pegStore(0);
    const pegged = pegStore(ML_DONTPEGBOTTOM);
    expect(spanAt(plain, 160)).not.toEqual(spanAt(pegged, 160));
    for (let y = 0; y < VIEWHEIGHT; y++) {
      const a = plain.indices[y * 320 + 160] !== 0;
      const b = pegged.indices[y * 320 + 160] !== 0;
      if (y >= 13 && y <= 141) expect(a).not.toBe(b); // inside the union: exactly one band
      else expect(a || b).toBe(false); // outside: neither
    }
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 6: masked two-sided midtexture — RECORD only (M4 draws). */
/* maskedtexturecol filled (≠ MAXSHORT), zero pixels, clip arrays      */
/* untouched (back sector differs on both planes ⇒ markfloor/          */
/* markceiling false, r_segs.c:440-443/495-520).                       */
/* ------------------------------------------------------------------ */

/** Two-sided masked line at x=0 (y 64..192): BOTH sectors identical (floor
 * 0/ceil 128, classic masked door-track case) ⇒ markfloor/markceiling
 * false (r_segs.c:541-559) ⇒ clips untouched; midtexture on the FRONT
 * sidedef (r_segs.c:445/608) ⇒ masked recording. */
function maskedWorld(): RenderWorld {
  const vertices: Vertex[] = [{ x: 0, y: 64 }, { x: 0, y: 192 }];
  const flat = (): SectorDef =>
    ({ floorLh: 0, ceilingLh: 128, floorFlat: "F", ceilingFlat: "F", lightLevel: 192, special: 0, tag: 0 });
  const sectors: SectorDef[] = [flat(), flat()];
  const sideDefs: SideDef[] = [
    { sector: 0, toptexture: "", midtexture: WALL_TEX, bottomtexture: "", offset: [0, 0], light: 0 },
    { sector: 1, toptexture: "", midtexture: "", bottomtexture: "", offset: [0, 0], light: 0 },
  ];
  const lineDefs: LineDef[] = [{ v1: 0, v2: 1, front: 0, back: 1, flags: 4, special: 0, tag: 0 }];
  const segs: Seg[] = [{ v1: 0, v2: 1, angle: (0x40000000 >>> 16) & 0xffff, line: 0, side: 0, offset: 0 }];
  const md: MapData = {
    name: "SEGMASK", things: new Uint8Array(0), lineDefs, sideDefs, vertices, segs,
    ssectors: [], nodes: [], sectors, reject: new Uint8Array(0), blockmap: new Uint8Array(0),
  };
  return loadRenderWorld(md, new Map([[WALL_TEX, mkTex(64, 128)]]));
}

describe("segs (M3-06b acceptance 6): masked texturecol recording", () => {
  it("stores texturecolumns, draws no pixels, leaves clips alone", () => {
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, maskedWorld(), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();
    const ceilBefore = Array.from(ceilingclip.slice(140, 181));
    const floorBefore = Array.from(floorclip.slice(140, 181));

    cb.onSegReached?.(0, 150, 170);
    cb.addSolid(150, 170); // masked segs travel the solid path (R_AddLine)

    const ds = getDrawsegs();
    expect(drawsegCount()).toBe(1);
    expect([ds.x1[0], ds.x2[0]]).toEqual([150, 170]);
    // Masked finalization forces SIL_BOTH with open ±MAXINT/MININT heights
    // and snapshots both clip arrays (r_segs.c:716-743).
    expect(ds.silhouette[0]).toBe(3 /* SIL_BOTH */);
    expect(ds.tsilheight[0]).toBe(-2147483648);
    expect(ds.bsilheight[0]).toBe(2147483647);
    // Pool advanced by all three snapshots; FIX-M3-06c keeps the signed
    // column-refs (base - start, vanilla pointer arithmetic): the clip
    // snapshots live at pool 21 and 42, start 150.
    expect(ds.sprtopclip[0]).toBe(21 - 150);
    expect(ds.sprbottomclip[0]).toBe(42 - 150);

    // maskedtexturecol: perpendicular d=160 wall ⇒ tc(x) = x - 97 fixed
    // (exact chain: tc(160) = 63, verified against the fixed-point replica;
    // +1/column by symmetry). FIX-M3-06c write-back: 150..170 hold tc (see
    // the FIX-M3-06c test).
    expect(maskedTexturecol(0, 149)).toBe(MAXSHORT); // outside the store range:
    // ref lands below pool slot 0 (undefined → MAXSHORT). At x=171 the shared
    // pool means the address hits the NEXT block (the ceilingclip snapshot,
    // seeded −1), so the honest probe there is −1, not MAXSHORT.
    expect(maskedTexturecol(0, 171)).toBe(-1);
    expect(ds.maskedcol[0]).toBe(-150); // pool base shifted by start column

    for (let x = 140; x <= 180; x++) expect(paintedCount(fb, x)).toBe(0); // RECORD ONLY
    expect(Array.from(ceilingclip.slice(140, 181))).toEqual(ceilBefore);
    expect(Array.from(floorclip.slice(140, 181))).toEqual(floorBefore);
    // 21 maskedtexturecol + 21 ceilingclip + 21 floorclip snapshot shorts
    expect(openingsUsed()).toBe(63);
    expect(getRenderCounters()).toEqual({ hom: 0, drawsegOverflow: 0, solidsegDrops: 0 });
  });

  it("FIX-M3-06c: masked record keeps negative-base openings refs", () => {
    // Two symptoms, one class. Vanilla uses pointer arithmetic where a base
    // BELOW the indexed column is normal:
    //   ds_p->maskedtexturecol = lastopening - rw_x   (r_segs.c:611),
    //   maskedtexturecol[rw_x] = texturecolumn        (r_segs.c:356),
    //   ds_p->sprtopclip = lastopening - start        (r_segs.c:716-733).
    // segs.ts guarded `maskedBase >= 0` and `if (ref >= 0)` before
    // writing/keeping the ref, so whenever the pool base < start column
    // (i.e. almost always) the texturecolumns stayed MAXSHORT and the clip
    // snapshots were lost even though openings were consumed. Refs are
    // signed pool offsets (base - start); only allocation FAILURE skips.
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, maskedWorld(), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();
    cb.onSegReached?.(0, 150, 170);
    cb.addSolid(150, 170);
    const ds = getDrawsegs();
    // Pool layout after the record: [0..20] maskedtexturecol,
    // [21..41] ceilingclip snapshot, [42..62] floorclip snapshot; every ref
    // is the vanilla signed `base - start` (maskedcol -150, clips -129/-108).
    expect(ds.maskedcol[0]).toBe(-150);
    for (let x = 150; x <= 170; x++) {
      expect(maskedTexturecol(0, x)).toBe(x - 97); // tc(160) = 63, ≠ MAXSHORT
    }
    expect(ds.sprtopclip[0]).not.toBe(CLIP_NULL);
    expect(ds.sprbottomclip[0]).not.toBe(CLIP_NULL);
    expect(clipValue(ds.sprtopclip[0]!, 160, VIEWHEIGHT)).toBe(-1);
    expect(clipValue(ds.sprbottomclip[0]!, 160, VIEWHEIGHT)).toBe(VIEWHEIGHT);
    expect(maskedTexturecol(0, 149)).toBe(MAXSHORT); // below pool slot 0
    expect(openingsUsed()).toBe(63);
    expect(getRenderCounters()).toEqual({ hom: 0, drawsegOverflow: 0, solidsegDrops: 0 });
  });

  it("FIX-M3-06c vector: positive-base refs (water mark past start) unchanged", () => {
    // Push the pool water mark ABOVE the start column first — base-start is
    // then >= 0 and the pre-fix `>= 0` guards happened to work. Same green
    // values either way: the fix must not regress the positive case.
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, maskedWorld(), view);
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);
    resetRenderCounters();
    snapshotOpenings(new Int16Array(320).fill(-5), 0, 200); // base >= start
    cb.onSegReached?.(0, 150, 170);
    cb.addSolid(150, 170);
    const ds = getDrawsegs();
    expect(ds.maskedcol[0]).toBe(50); // 200 - 150
    for (let x = 150; x <= 170; x++) expect(maskedTexturecol(0, x)).toBe(x - 97);
    expect(clipValue(ds.sprtopclip[0]!, 160, VIEWHEIGHT)).toBe(-1);
    expect(clipValue(ds.sprbottomclip[0]!, 160, VIEWHEIGHT)).toBe(VIEWHEIGHT);
    expect(openingsUsed()).toBe(263); // 200 filler + 3 x 21
  });
});

/* ------------------------------------------------------------------ */
/* drawsegs unit basics (SoA allocation, openings pool, clip refs).    */
/* ------------------------------------------------------------------ */

describe("drawsegs (M3-06b) unit basics", () => {
  it("drawsegAdd initialises the vanilla sentinels and advances the cursor", () => {
    clearDrawsegs();
    resetRenderCounters();
    expect(drawsegAdd(7)).toBe(0);
    expect(drawsegAdd(9)).toBe(1);
    expect(drawsegCount()).toBe(2);
    const ds = getDrawsegs();
    expect([ds.seg[0], ds.seg[1]]).toEqual([7, 9]);
    expect([ds.x1[0], ds.x2[0]]).toEqual([0, 0]);
    expect(ds.silhouette[0]).toBe(SIL_NONE);
    expect(ds.bsilheight[0]).toBe(-2147483648); // MININT pre-set (see drawsegs header
    expect(ds.tsilheight[0]).toBe(2147483647); // deviation vs vanilla stale carry-over;
    // one-sided stores overwrite to MAXINT/MININT (r_segs.c:479-480)
    expect([ds.sprtopclip[0], ds.sprbottomclip[0], ds.maskedcol[0]]).toEqual([CLIP_NULL, CLIP_NULL, CLIP_NULL]);
    clearDrawsegs();
    expect(drawsegCount()).toBe(0);
    expect(openingsUsed()).toBe(0); // water mark resets with the segs
  });

  it("snapshotOpenings base is start-adjusted so refs index by column", () => {
    clearDrawsegs();
    const src = new Int16Array(320);
    for (let x = 0; x < 320; x++) src[x] = x - 100;
    const ref = snapshotOpenings(src, 100, 30);
    expect(ref).toBe(-100); // base(0) - start(100) — signed ref, FIX-M3-06c
    expect(clipValue(ref!, 100, 200)).toBe(0);
    expect(clipValue(ref!, 129, 200)).toBe(29);
    expect(openingsUsed()).toBe(30);
  });

  it("clipValue resolves the three static sentinels", () => {
    expect(clipValue(CLIP_SCREEN, 5, 200)).toBe(200); // screenheightarray
    expect(clipValue(CLIP_NEGONE, 5, 200)).toBe(-1); // negonearray
    expect(clipValue(CLIP_NULL, 5, 200)).toBe(0); // never consulted
  });
});
