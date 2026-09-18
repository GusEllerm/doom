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
import { clearDrawsegs, clearClipArrays, getDrawsegs } from "./drawsegs";
import { clearClipSegs } from "./solidsegs";
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

/** One-sided wall at x=0, y in [64,192]; front sector floor 0, ceiling `ceil`. */
function oneSidedWorld(ceil: number): RenderWorld {
  const vertices: Vertex[] = [{ x: 0, y: 64 }, { x: 0, y: 192 }];
  const sectors: SectorDef[] = [
    { floorLh: 0, ceilingLh: ceil, floorFlat: "F", ceilingFlat: "F", lightLevel: 192, special: 0, tag: 0 },
  ];
  const sideDefs: SideDef[] = [
    { sector: 0, toptexture: "", midtexture: WALL_TEX, bottomtexture: "", offset: [0, 0], light: 0 },
  ];
  const lineDefs: LineDef[] = [{ v1: 0, v2: 1, front: 0, back: -1, flags: 0, special: 0, tag: 0 }];
  const segs: Seg[] = [{ v1: 0, v2: 1, angle: (0x40000000 >>> 16) & 0xffff, line: 0, side: 0, offset: 0 }];
  const md: MapData = {
    name: "SEGFIX", things: new Uint8Array(0), lineDefs, sideDefs, vertices, segs,
    ssectors: [], nodes: [], sectors, reject: new Uint8Array(0), blockmap: new Uint8Array(0),
  };
  return loadRenderWorld(md, new Map([[WALL_TEX, mkTex(64, 128)]]));
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
      const cb = createSegCallbacks(fb, oneSidedWorld(vp.ceil ?? 128), view);
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
