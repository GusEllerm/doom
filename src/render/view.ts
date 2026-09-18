// render/view.ts — view setup + texture-mapping tables (M3-plan §M3-04).
//
// Zone discipline (A-INT1 / eslint doom/zones/render): imports core + wad
// TYPES only — `RenderMapView` is a STRUCTURAL read-view (M2-09 pattern), so
// nothing in src/sim/** is referenced. The bridge {@link buildRenderMapView}
// converts a decoded MapData into the SoA subset the walk needs, replicating
// the p_setup.c/P_GroupLines numbers (coords <<FRACBITS, subsector→sector).
//
// Vanilla mapping (linuxdoom-1.10 r_main.c; R03 = docs/research/03-bsp-
// renderer.md):
//   R_ExecuteSetViewSize (r_main.c:671-741) — viewscale path `setblocks==11`
//     ⇒ scaledviewwidth=SCREENWIDTH, viewheight=SCREENHEIGHT; detailshift=0
//     ⇒ viewwidth=320, viewheight=200, centery=viewheight/2=100,
//     centerx=160, centerxfrac=160<<16, projection=centerxfrac. Fixed here;
//     no screen-size menu in M3 (viewscale = 1, plan §M3-04). M4-01 extends
//     the same init with the plane tables yslope[200]/distscale[320] and
//     the psprite scales (r_main.c:718-740, §M4-01).
//   R_InitTextureMapping (r_main.c:544-603) — ported verbatim; see
//     {@link initTextureMapping} for the focallength / viewangletox /
//     xtoviewangle / clipangle math. clipangle source truth: 1.10 assigns
//     `clipangle = xtoviewangle[0]` with NO extra shift — the xtoviewangle
//     entries are already angle_t (`(i<<ANGLETOFINESHIFT)-ANG90`,
//     ANGLETOFINESHIFT=19).
//   R_SetupFrame (r_main.c:830-843) — viewx/viewy = mo.x/mo.y, viewangle =
//     mo.angle (+viewangleoffset = 0), extralight/fixedcolormap read-through,
//     viewsin/viewcos from finesine/finecosine.
//   viewz placeholder — `viewz = mo.z + 41*FRACUNIT` (VIEWHEIGHT).
//     DOCUMENTED DEVIATION: P_CalcHeight/bob/tilt are M5 (plan §3); M3 uses
//     the eye-height constant only.
//   R_PointToAngle (r_main.c:283-372) — octant + SlopeDiv/tantoangle port,
//     result u32 (C angle_t).
//
// m_bbox.h enum order (source truth for R_CheckBBox / checkcoord):
//   BOXTOP=0, BOXBOTTOM=1, BOXLEFT=2, BOXRIGHT=3 — bbox flat layout is
//   {top,bottom,left,right}, NOT the common {left,right,top,bottom} guess.
//   The flat codes are exported from here for bsp.ts's R_CheckBBox port.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  ANG90,
  ANG180,
  ANG270,
  ANGLETOFINESHIFT,
  FINEANGLES,
  FRACBITS,
  FRACUNIT,
} from '../core/constants';
import { FixedDiv, FixedMul, angToFine } from '../core/fixed';
import { finecosine, finesine, finetangent, SlopeDiv, tantoangle } from '../core/tables';
import type { MapData } from '../wad/types';
import type { MapNode } from '../wad/mapdata';

/* ------------------------------------------------------------------ */
/* View-size constants (R_ExecuteSetViewSize, setblocks=11, detail=0)  */
/* ------------------------------------------------------------------ */

/** viewwidth = scaledviewwidth>>detailshift = 320 (screensize.c "full"). */
export const VIEWWIDTH = 320;
/** viewheight = SCREENHEIGHT = 200. */
export const VIEWHEIGHT = 200;
/** centerx = viewwidth/2. */
export const CENTERX = 160;
/** centerxfrac = centerx<<FRACBITS. */
export const CENTERXFRAC = CENTERX << FRACBITS;
/** centery = viewheight/2 — derived 100 (r_main.c:695). */
export const CENTERY = VIEWHEIGHT / 2;
/** projection = centerxfrac (r_main.c:700). */
export const PROJECTION = CENTERXFRAC;
/** r_main.h:48 — fineangles in the SCREENWIDTH-wide window (2048 = 45°). */
export const FIELDOFVIEW = 2048;
/** VIEWHEIGHT eye offset for the viewz placeholder, fixed (41<<16). */
export const VIEWHEIGHT_FIXED = 41 * FRACUNIT;

/* m_bbox.h boxcoord codes (flat index into the [top,bottom,left,right]
 * layout of a node child bbox; R_CheckBBox's checkcoord table indexes them
 * directly). Source truth: m_bbox.h enum, NOT the intuitive ordering. */
export const BOXTOP = 0;
export const BOXBOTTOM = 1;
export const BOXLEFT = 2;
export const BOXRIGHT = 3;

/* ------------------------------------------------------------------ */
/* RenderMapView — structural read-view of one map for the renderer    */
/* ------------------------------------------------------------------ */

/** node_t mirror (r_data.c/r_bsp.c consumer view). Children keep the RAW
 * u16 NODES refs: high bit (NF_SUBSECTOR = 0x8000) ⇒ subsector index. */
export interface RenderNodeSoA {
  readonly count: number;
  /** Partition origin + delta, fixed. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly dx: Int32Array;
  readonly dy: Int32Array;
  /** children[0] = right/front, children[1] = left/back (raw u16 refs). */
  readonly child0: Int32Array;
  readonly child1: Int32Array;
  /** Child bboxes, fixed units, m_bbox.h order [top,bottom,left,right]
   * per child → 8 slots per node: [t,b,l,r | t,b,l,r] (side 0 then 1).
   * Identical flat layout to `node_t::bbox[2][4]`. */
  readonly bboxes: Int32Array;
}

/** subsector_t mirror: seg range + sector (P_GroupLines resolution). */
export interface RenderSubsectorSoA {
  readonly count: number;
  readonly segStart: Int32Array;
  readonly segCount: Int32Array;
  readonly sector: Int32Array;
}

/** Everything M3-04…M3-07 need geometrically from a map, as typed arrays.
 * A RuntimeMap-shaped subset (M2-09 structural pattern): the sim's runtime
 * map may be bridged via {@link buildRenderMapView} (from the MapData it was
 * built from) WITHOUT importing any src/sim type. Seg geometry itself lives
 * in RenderWorld (M3-02) — this view carries the BSP topology. */
export interface RenderMapView {
  readonly mapName: string;
  readonly numVertices: number;
  readonly verticesX: Int32Array;
  readonly verticesY: Int32Array;
  readonly nodes: RenderNodeSoA;
  readonly subsectors: RenderSubsectorSoA;
}

/** NF_SUBSECTOR as stored in the raw u16 NODES child refs (R01 §10). */
export const NF_SUBSECTOR = 0x8000;

/** Root child for {@link renderBspNode}: last node (vanilla numnodes-1), or
 * the `bspnum == -1` empty-tree marker when the map has zero nodes
 * (r_bsp.c R_RenderBSPNode routes −1 to subsector 0). */
export function bspRoot(map: RenderMapView): number {
  return map.nodes.count > 0 ? map.nodes.count - 1 : -1;
}

/**
 * Bridge: decoded {@link MapData} → {@link RenderMapView}. p_setup.c order
 * mirrors sim/map.ts (buildMapFromData) but owns its own arrays:
 *  - vertices/splits: raw units <<FRACBITS (P_LoadVertexes / P_LoadNodes);
 *  - children: raw u16 refs with the NF_SUBSECTOR bit, kept as decoded
 *    (mapdata.ts "Node.right/left keep the RAW u16 child ref");
 *  - bboxes: [BOXTOP,BOXBOTTOM,BOXLEFT,BOXRIGHT] per child (m_bbox.h),
 *    rightBBox = child 0, leftBBox = child 1 (mapdata.ts MapNode note);
 *  - subsector→sector: P_GroupLines — first seg's front-side sector, with
 *    miniseg subsectors carrying the previous subsector's sector forward
 *    (p_setup.c: `if (!ss->sector) ss->sector = sector;`).
 */
export function buildRenderMapView(md: MapData): RenderMapView {
  const numVertices = md.vertices.length;
  const verticesX = new Int32Array(numVertices);
  const verticesY = new Int32Array(numVertices);
  for (let i = 0; i < numVertices; i += 1) {
    const v = md.vertices[i]!;
    verticesX[i] = (v.x * FRACUNIT) | 0;
    verticesY[i] = (v.y * FRACUNIT) | 0;
  }

  /* ---- nodes (P_LoadNodes; per-child bbox lives in mapdata's MapNode
   * extension of the contract Node type) ---- */
  const nodeCount = md.nodes.length;
  const nx = new Int32Array(nodeCount);
  const ny = new Int32Array(nodeCount);
  const ndx = new Int32Array(nodeCount);
  const ndy = new Int32Array(nodeCount);
  const child0 = new Int32Array(nodeCount);
  const child1 = new Int32Array(nodeCount);
  const bboxes = new Int32Array(nodeCount * 8);
  for (let i = 0; i < nodeCount; i += 1) {
    const n = md.nodes[i]! as MapNode; // mapdata decodes MapNode (rightBBox/leftBBox)
    nx[i] = (n.splitx * FRACUNIT) | 0; // P_LoadNodes: units <<FRACBITS
    ny[i] = (n.splity * FRACUNIT) | 0;
    ndx[i] = (n.dx * FRACUNIT) | 0;
    ndy[i] = (n.dy * FRACUNIT) | 0;
    child0[i] = n.right & 0xffff;
    child1[i] = n.left & 0xffff;
    const b0 = i * 8;
    putBBox(bboxes, b0, n.rightBBox);
    putBBox(bboxes, b0 + 4, n.leftBBox);
  }

  /* ---- subsectors: seg range + P_GroupLines sector ---- */
  const ssCount = md.ssectors.length;
  const segStart = new Int32Array(ssCount);
  const segCount = new Int32Array(ssCount);
  const ssSector = new Int32Array(ssCount);
  let carriedSector = 0; // P_GroupLines `sector` variable, ss 0 fallback
  for (let i = 0; i < ssCount; i += 1) {
    const ss = md.ssectors[i]!;
    segStart[i] = ss.firstseg;
    segCount[i] = ss.numsegs;
    let sector = -1;
    for (let s = ss.firstseg; s < ss.firstseg + ss.numsegs && sector < 0; s += 1) {
      const sg = md.segs[s];
      if (sg === undefined || sg.line < 0) continue; // miniseg: keep looking
      const line = md.lineDefs[sg.line]!;
      const side = sg.side === 0 ? line.front : line.back;
      if (side >= 0) sector = md.sideDefs[side]!.sector;
    }
    if (sector < 0) sector = carriedSector; // all-miniseg subsector: carry
    carriedSector = sector;
    ssSector[i] = sector;
  }

  return {
    mapName: md.name,
    numVertices,
    verticesX,
    verticesY,
    nodes: { count: nodeCount, x: nx, y: ny, dx: ndx, dy: ndy, child0, child1, bboxes },
    subsectors: { count: ssCount, segStart, segCount, sector: ssSector },
  };
}

function putBBox(
  dst: Int32Array,
  at: number,
  b: { top: number; bottom: number; left: number; right: number },
): void {
  dst[at + BOXTOP] = (b.top * FRACUNIT) | 0;
  dst[at + BOXBOTTOM] = (b.bottom * FRACUNIT) | 0;
  dst[at + BOXLEFT] = (b.left * FRACUNIT) | 0;
  dst[at + BOXRIGHT] = (b.right * FRACUNIT) | 0;
}

/* ------------------------------------------------------------------ */
/* ViewState — the r_main.c view globals (one object, reused per frame) */
/* ------------------------------------------------------------------ */

/** r_main.c globals viewx/viewy/viewz/viewangle/viewsin/viewcos/
 * extralight/fixedcolormap. All fixed except viewangle (u32 BAM). */
export interface ViewState {
  viewx: number;
  viewy: number;
  viewz: number;
  /** angle_t as u32-as-number. */
  viewangle: number;
  viewsin: number;
  viewcos: number;
  extralight: number;
  /** −1 = NULL (normal lighting); a light-table row index when set
   * (R_SetupFrame fixedcolormap read-through; fullcolormap cases are M4+). */
  fixedcolormap: number;
}

/** Per-frame view config: player position fixed, angle u32 BAM. `z` is the
 * thing/eye-origin height fixed (default 0) — viewz = z + 41<<16 placeholder
 * (file header deviation). */
export interface ViewConfig {
  readonly x: number;
  readonly y: number;
  readonly z?: number;
  readonly angle: number;
  readonly extralight?: number;
  readonly fixedcolormap?: number;
}

export function createViewState(): ViewState {
  return {
    viewx: 0,
    viewy: 0,
    viewz: VIEWHEIGHT_FIXED,
    viewangle: 0,
    viewsin: 0,
    viewcos: FRACUNIT,
    extralight: 0,
    fixedcolormap: -1,
  };
}

/** R_SetupFrame (minus psprite/interpolation, M4/M5): mutates `v` in place
 * — zero allocation when called per frame on a reused ViewState. */
export function setupView(v: ViewState, cfg: ViewConfig): void {
  v.viewx = cfg.x | 0;
  v.viewy = cfg.y | 0;
  v.viewz = ((cfg.z ?? 0) | 0) + VIEWHEIGHT_FIXED; // placeholder, see header
  v.viewangle = cfg.angle >>> 0;
  v.viewsin = finesine[angToFine(v.viewangle)]!;
  v.viewcos = finecosine[angToFine(v.viewangle)]!;
  v.extralight = cfg.extralight ?? 0;
  v.fixedcolormap = cfg.fixedcolormap ?? -1;
}

/* ------------------------------------------------------------------ */
/* R_PointToAngle (r_main.c:283-372)                                   */
/* ------------------------------------------------------------------ */

/**
 * Angle (u32 BAM) from the view point to (x,y). Octant switch verbatim;
 * tantoangle is Int32Array (C fixed_t) but every entry is a small positive
 * angle, so the `>>> 0` results reproduce C's implicit int→unsigned casts.
 */
export function pointToAngle(view: ViewState, x: number, y: number): number {
  let px = (x - view.viewx) | 0;
  let py = (y - view.viewy) | 0;

  if (px === 0 && py === 0) return 0;

  if (px >= 0) {
    if (py >= 0) {
      if (px > py) return tantoangle[SlopeDiv(py, px)]! >>> 0; // octant 0
      return (ANG90 - 1 - tantoangle[SlopeDiv(px, py)]!) >>> 0; // octant 1
    }
    py = -py;
    if (px > py) return (-tantoangle[SlopeDiv(py, px)]!) >>> 0; // octant 8
    return (ANG270 + tantoangle[SlopeDiv(px, py)]!) >>> 0; // octant 7
  }
  px = -px;
  if (py >= 0) {
    if (px > py) return (ANG180 - 1 - tantoangle[SlopeDiv(py, px)]!) >>> 0; // octant 3
    return (ANG90 + tantoangle[SlopeDiv(px, py)]!) >>> 0; // octant 2 (no −1: verbatim)
  }
  py = -py;
  if (px > py) return (ANG180 + tantoangle[SlopeDiv(py, px)]!) >>> 0; // octant 4 (no +1: verbatim)
  return (ANG270 - 1 - tantoangle[SlopeDiv(px, py)]!) >>> 0; // octant 5
}

/* ------------------------------------------------------------------ */
/* R_InitTextureMapping (r_main.c:544-603) — once, viewwidth 320       */
/* ------------------------------------------------------------------ */

export interface TextureMapping {
  /** Screen-x (plain pixels) for each of the FINEANGLES/2 relative-angle
   * fine indices ((angle+ANG90)>>19). -1/viewwidth+1 fenceposts removed per
   * the third C loop ⇒ always in [0, viewwidth]. */
  readonly viewangletox: Int32Array;
  /** Smallest angle_t (u32) mapping to x — angle_t already (i<<19)-ANG90. */
  readonly xtoviewangle: Uint32Array;
  /** xtoviewangle[0] — NO extra shift in 1.10 (source truth, header note). */
  readonly clipangle: number;
  readonly focallength: number;
  /** R_ExecuteSetViewSize "planes" loop (r_main.c:729-734, M4-01): per-row
   * slope `yslope[i] = FixedDiv(centerxfrac, |((i-viewheight/2)<<16)
   * + FRACUNIT/2|)` (detailshift = 0 ⇒ viewwidth<<detailshift = 320).
   * Consumed by planes.ts R_MapPlane. */
  readonly yslope: Int32Array;
  /** R_ExecuteSetViewSize (r_main.c:736-740, M4-01): per-column diagonal
   * correction `distscale[i] = FixedDiv(FRACUNIT, |finecosine[
   * xtoviewangle[i]>>ANGLETOFINESHIFT]|)`. xtoviewangle entries are exact
   * multiples of 2^19, so the >>>19 index (0..8191) stays inside the
   * 8192-long finecosine view of the 10240-entry finesine table. */
  readonly distscale: Int32Array;
  /** pspritescale = FRACUNIT*viewwidth/SCREENWIDTH = FRACUNIT (detail 0). */
  readonly pspritescale: number;
  /** pspriteiscale = FRACUNIT*SCREENWIDTH/viewwidth = FRACUNIT (detail 0);
   * sky `dc_iscale = pspriteiscale>>detailshift` (r_plane.c R_DrawPlanes). */
  readonly pspriteiscale: number;
}

const FINEHALF = FINEANGLES / 2; // 4096

let mapping: TextureMapping | undefined;

/** Idempotent R_InitTextureMapping: builds once (vanilla calls it from
 * R_Init / R_ExecuteSetViewSize); later calls return the same frozen-shape
 * tables without recomputing. No allocation in steady state. */
export function initTextureMapping(): TextureMapping {
  if (mapping !== undefined) return mapping;

  // focallength = FixedDiv(centerxfrac, finetangent[FINEANGLES/4 +
  //                 FIELDOFVIEW/2]);
  const focallength = FixedDiv(CENTERXFRAC, finetangent[FINEANGLES / 4 + FIELDOFVIEW / 2]!);

  const viewangletox = new Int32Array(FINEHALF);
  for (let i = 0; i < FINEHALF; i += 1) {
    const tan = finetangent[i]!;
    let t: number;
    if (tan > FRACUNIT * 2) t = -1;
    else if (tan < -FRACUNIT * 2) t = VIEWWIDTH + 1;
    else {
      t = FixedMul(tan, focallength);
      t = (CENTERXFRAC - t + FRACUNIT - 1) >> FRACBITS;
      if (t < -1) t = -1;
      else if (t > VIEWWIDTH + 1) t = VIEWWIDTH + 1;
    }
    viewangletox[i] = t;
  }

  const xtoviewangle = new Uint32Array(VIEWWIDTH + 1);
  for (let x = 0; x <= VIEWWIDTH; x += 1) {
    let i = 0;
    while (viewangletox[i]! > x) i += 1;
    // (i<<ANGLETOFINESHIFT)-ANG90 as angle_t; u32 wrap via Uint32Array.
    xtoviewangle[x] = ((i << ANGLETOFINESHIFT) - ANG90) >>> 0;
  }

  // Take out the fencepost cases from viewangletox (the C `t = centerx - t`
  // line in this loop is dead code in 1.10 and intentionally not ported).
  for (let i = 0; i < FINEHALF; i += 1) {
    if (viewangletox[i] === -1) viewangletox[i] = 0;
    else if (viewangletox[i] === VIEWWIDTH + 1) viewangletox[i] = VIEWWIDTH;
  }

  /* ---- R_ExecuteSetViewSize plane/psprite tables (r_main.c:718-740,
   * M4-01; setblocks=11 + detailshift=0 constants at file top) ---- */
  const yslope = new Int32Array(VIEWHEIGHT);
  for (let i = 0; i < VIEWHEIGHT; i += 1) {
    // dy = ((i-viewheight/2)<<FRACBITS)+FRACUNIT/2; dy = abs(dy);
    // yslope[i] = FixedDiv((viewwidth<<detailshift)/2*FRACUNIT, dy)
    //           = FixedDiv(CENTERXFRAC, dy) at the fixed 320-wide view.
    let dy = (((i - VIEWHEIGHT / 2) << FRACBITS) + FRACUNIT / 2) | 0;
    if (dy < 0) dy = -dy; // C abs — |dy| « 2^31, no MININT wrap
    yslope[i] = FixedDiv(CENTERXFRAC, dy);
  }

  const distscale = new Int32Array(VIEWWIDTH);
  for (let i = 0; i < VIEWWIDTH; i += 1) {
    const cosadj = Math.abs(finecosine[xtoviewangle[i]! >>> ANGLETOFINESHIFT]!);
    distscale[i] = FixedDiv(FRACUNIT, cosadj);
  }

  mapping = {
    viewangletox,
    xtoviewangle,
    clipangle: xtoviewangle[0]! >>> 0, // source truth: no <<16 (header)
    focallength,
    yslope,
    distscale,
    // psprite scales (r_main.c:718-719): viewwidth == SCREENWIDTH at the
    // fixed full-res view ⇒ both exactly FRACUNIT.
    pspritescale: (FRACUNIT * VIEWWIDTH) / VIEWWIDTH,
    pspriteiscale: (FRACUNIT * VIEWWIDTH) / VIEWWIDTH,
  };
  return mapping;
}

/** Current half-FOV clip angle (angle_t u32). Ensures the mapping exists. */
export function getClipangle(): number {
  return initTextureMapping().clipangle;
}
