/**
 * sim/map — runtime map setup, the `p_setup.c` equivalent (M2-04).
 *
 * Turns a decoded {@link MapData} (src/wad/mapdata.ts, M2-03) into the live
 * world model: linked, mutable, fixed-point runtime arrays built in the
 * vanilla load order (R04 §12 pt.5: vertexes → sectors → sidedefs → linedefs
 * → subsectors → nodes → segs, then the P_GroupLines linking pass). The raw
 * MapData is read-only input; everything derived here lives in fixed point
 * (map units << FRACBITS) so all later sim math can use FixedMul/FixedDiv
 * directly (R04 §4).
 *
 * Layout decision (task M2-04 pt.5 / ARCHITECTURE §2.5): STRUCTURE-OF-ARRAYS.
 * Every hot field is a plain typed array indexed by element index — mirrors
 * "array of structs" in cache-line terms only when the renderer/sim iterate
 * one field at a time, which is exactly what R_PointOnSide, blockmap line
 * loops and sector iteration do. AOS with JS objects would put megamorphic
 * property access on the hot path; SoA keeps every loop monomorphic and
 * JIT-friendly. Reference-style links (line→sector, node→subsector) are
 * integer indices or small tagged unions, never live object graphs, so
 * save/load (§5.6) can memcpy them. Exceptions, documented: texture/flat
 * NAMES stay `string[]` (used only at init/lookup), node child refs are a
 * tagged-union array ({kind,index}) per the task contract — M2-05 may pack
 * them into Int32Arrays (high bit = NF_SUBSECTOR) if the walk profiles hot.
 *
 * Faithfulness notes vs vanilla p_setup.c (behaviour from R04 §12/§13):
 *  - Line bbox carries NO MAXRADIUS padding (verified 1.10 P_LoadLineDefs);
 *    sector bbox does, in the blockbox conversion (P_GroupLines tail).
 *  - Sector soundorg = bbox centre; blockbox = bbox clamped into the block
 *    grid with MAXRADIUS margin (P_GroupLines).
 *  - A two-sided line whose two sides reference the SAME sector is counted
 *    ONCE per sector (vanilla `backsector != frontsector` guard), and
 *    sector line lists enumerate lines in ascending linedef order.
 *  - Subsector→sector resolution = frontsector of the FIRST seg
 *    (P_GroupLines), with a P_CheckSectors-style consistency pass over the
 *    remaining segs (later-source hardening; vanilla would misrender).
 *  - lightlevel is clamped to 0..255 at setup (P_CheckSectors-style range
 *    check); `soundtraversed` scratch arrays (per-sector, validcount domain)
 *    are allocated here for the future sound flood (R07 §5).
 *  - 1.10 has no P_InitTags; tag indexes built here are pure load-order
 *    conveniences (ARCHITECTURE §5.1 "never rebuilt from sorting").
 *
 * Extensions beyond 1.10 (documented deviations, no gameplay effect):
 *  - Map bbox from vertices (1.10 derives it from BLOCKMAP; PrBoom derives it
 *    from vertices — we keep the vertex version as the task dictates).
 *  - validcount-domain guards throw typed {@link MapSetupError} where vanilla
 *    would `I_Error("Wad has too many…")` / silently corrupt memory.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { FixedDiv, FRACBITS, FRACUNIT } from '../core/fixed';
import { MAPBLOCKSIZE, MAXINT } from '../core/constants';
import {
  blockmapInfo,
  nodeRefIndex,
  nodeRefIsSubsector,
  thingAt,
  thingCount,
  type MapNode,
  type MapThing,
} from '../wad/mapdata';
import type { MapData } from '../wad/types';

/* ------------------------------------------------------------------ */
/* Constants (p_local.h / r_def.h equivalents, 1.10 spellings)          */
/* ------------------------------------------------------------------ */

/** Slope classification, ST_* (p_local.h slopetype_t). */
export const ST_VERTICAL = 0;
export const ST_HORIZONTAL = 1;
export const ST_POSITIVE = 2;
export const ST_NEGATIVE = 3;

/** Thing collision radius padding used by P_GroupLines' blockbox math. */
export const MAXRADIUS = 32 * FRACUNIT;

/** Blockmap cell shift: 128 map units (p_local.h MAPBLOCKSHIFT). */
export const MAPBLOCKSHIFT = FRACBITS + 7; // Math.log2(MAPBLOCKSIZE * FRACUNIT)

/**
 * Line-count guard: vanilla P_GroupLines errors with
 * `I_Error("P_GroupLines: numlines too many")` when the sector line-buffer
 * sizing could overflow; the underlying domain limit for us is the int32
 * validcount dedup (R04 §14 pt.6) that M2-05 stamps onto lines, so anything
 * at or past 2^23 linedefs is refused as a malformed wad instead.
 */
const MAX_SUPPORTED_LINES = 1 << 23;

/* ------------------------------------------------------------------ */
/* Typed error                                                         */
/* ------------------------------------------------------------------ */

/** Thrown when decoded MapData cannot become a consistent live world. */
export class MapSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapSetupError';
  }
}

/* ------------------------------------------------------------------ */
/* Runtime structs (SoA field groups; R04 §13 field subset for          */
/* geometry + the sector/effect fields M2-06..M2-09 need listed below) */
/* ------------------------------------------------------------------ */

/** Axis-aligned fixed-point box (indices into the parallel arrays). */
export interface FixedBBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * line_t mirror (p_local.h): v1/v2/side refs are INDICES, dx/dy/bbox fixed.
 * `special`/`tag` feed P_UseSpecialLine etc. (R05 §2); `valid` is the
 * validcount dedup slot (M2-05 blockmap iteration); specialdata thinkers
 * (M2-06) are NOT allocated yet — M2-06 adds a side table keyed by line index.
 */
export interface LineArrays {
  readonly count: number;
  readonly v1: Int32Array;
  readonly v2: Int32Array;
  /** fixed */
  readonly dx: Int32Array;
  readonly dy: Int32Array;
  readonly slopetype: Uint8Array;
  /** fixed, no MAXRADIUS padding in 1.10 */
  readonly bboxLeft: Int32Array;
  readonly bboxRight: Int32Array;
  readonly bboxTop: Int32Array;
  readonly bboxBottom: Int32Array;
  /** ML_* flags (doomdata.h). */
  readonly flags: Int32Array;
  readonly special: Int32Array;
  readonly tag: Int32Array;
  /** side indices; back is −1 for one-sided (sidenum[1] sentinel kept). */
  readonly sideFront: Int32Array;
  readonly sideBack: Int32Array;
  /** sector indices; backSector is −1 when one-sided. */
  readonly sectorFront: Int32Array;
  readonly sectorBack: Int32Array;
  /** validcount stamp (0 at setup; M2-05 bumps the global counter). */
  readonly valid: Int32Array;
  /** sidenum[0]/[1] raw, −1 sentinel — kept for automap/thinker code later. */
  readonly sideNumFront: Int32Array;
  readonly sideNumBack: Int32Array;
}

/**
 * side_t mirror. Offsets are fixed (texture panning, R03 §wall tex midifies);
 * names stay strings until M2-0x texture lookup tables replace them.
 */
export interface SideArrays {
  readonly count: number;
  readonly sector: Int32Array;
  readonly offsetX: Int32Array;
  readonly offsetY: Int32Array;
  readonly topTexture: readonly string[];
  readonly bottomTexture: readonly string[];
  readonly midTexture: readonly string[];
}

/**
 * sector_t mirror (geometry subset + M2+ effect fields):
 * floor/ceiling heights are the thinker-mutated fields (R05 §4-9),
 * `special` feeds P_SpawnSpecials/P_PlayerInSpecialSector (R05 §3),
 * lightLevel feeds light strobers (R05 §lights) and r_segs bucketing;
 * `soundtraversed` is the per-setup sound-flood stamp (M2 later);
 * floorCeiling/specialData/crushchange/thing list links arrive with M2-06.
 */
export interface SectorArrays {
  readonly count: number;
  /** fixed */
  readonly floorHeight: Int32Array;
  readonly ceilingHeight: Int32Array;
  readonly lightLevel: Int32Array;
  readonly special: Int32Array;
  readonly tag: Int32Array;
  readonly floorFlat: readonly string[];
  readonly ceilingFlat: readonly string[];
  /** P_GroupLines: number of linedefs bordering the sector. */
  readonly lineCount: Int32Array;
  /** CSR slice bounds into {@link RuntimeMap.sectorLineIndex}. */
  readonly lineStart: Int32Array;/** fixed bbox of all bordered linedef vertices. */
  readonly bboxLeft: Int32Array;
  readonly bboxRight: Int32Array;
  readonly bboxTop: Int32Array;
  readonly bboxBottom: Int32Array;
  /** fixed sound origin = bbox centre (P_GroupLines soundorg). */
  readonly soundOrgX: Int32Array;
  readonly soundOrgY: Int32Array;
  /** block-grid clamped bbox (P_GroupLines blockbox, MAXRADIUS margin). */
  readonly blockBoxLeft: Int32Array;
  readonly blockBoxRight: Int32Array;
  readonly blockBoxTop: Int32Array;
  readonly blockBoxBottom: Int32Array;
  /** validcount-domain stamp for sound traversal; 0 at setup. */
  readonly soundTraversed: Int32Array;
  /** M8-01 sector_t soundtarget (p_enemy.c:140): ThingLinks slot id of the
   * mobj that noise-alerted this sector; {@link psight} SOUND_TARGET_NONE
   * (−1) = the vanilla NULL mobj_t*. Filled with the sentinel at every level
   * build (fresh RuntimeMap per warp ⇒ the vanilla P_SpawnMapThing-time
   * “zeroed at load” semantics); written through the psight
   * setSectorSoundTarget seam when P_NoiseAlert lands (M8-04). */
  readonly soundTarget: Int32Array;
  /** validcount-domain stamp for P_ChangeSector etc.; 0 at setup. */
  readonly valid: Int32Array;
}

/** Node child: tagged union per the task contract. */
export type NodeChild =
  | { readonly kind: 'node'; readonly index: number }
  | { readonly kind: 'subsector'; readonly index: number };

/** node_t mirror; children keep the {kind,index} tagged refs. */
export interface NodeArrays {
  readonly count: number;
  /** fixed (split line origin + delta) */
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly dx: Int32Array;
  readonly dy: Int32Array;
  /** child 0 (right/front) */
  readonly rightBBoxLeft: Int32Array;
  readonly rightBBoxRight: Int32Array;
  readonly rightBBoxTop: Int32Array;
  readonly rightBBoxBottom: Int32Array;
  /** child 1 (left/back) */
  readonly leftBBoxLeft: Int32Array;
  readonly leftBBoxRight: Int32Array;
  readonly leftBBoxTop: Int32Array;
  readonly leftBBoxBottom: Int32Array;
  readonly right: readonly NodeChild[];
  readonly left: readonly NodeChild[];
}

/** subsector_t mirror: seg range + resolved sector (P_GroupLines). */
export interface SubsectorArrays {
  readonly count: number;
  readonly segCount: Int32Array;
  readonly segStart: Int32Array;
  readonly sector: Int32Array;
}

/** The live map: everything p_setup would own for one level. */
export interface RuntimeMap {
  readonly name: string;

  readonly numVertexes: number;
  /** fixed */
  readonly verticesX: Int32Array;
  readonly verticesY: Int32Array;
  /** Map bounds from vertices (fixed) — automap zoom / blockmap init use. */
  readonly mapBBox: FixedBBox;

  readonly lines: LineArrays;
  readonly sides: SideArrays;
  readonly sectors: SectorArrays;
  readonly nodes: NodeArrays;
  readonly subsectors: SubsectorArrays;

  /** P_GroupLines sector line tables: line indices per sector slice, in
   * ascending linedef order (sector s → [lineStart[s], lineStart[s]+lineCount[s])). */
  readonly sectorLineIndex: Int32Array;

  /**
   * Render-side SEGS stay in MapData (plan: renderer derives its own seg
   * walk state); only the resolved front/back sector per seg is mirrored
   * here because P_GroupLines + the subsector consistency pass need them.
   */
  readonly numSegs: number;
  readonly segSectorFront: Int32Array;
  readonly segSectorBack: Int32Array;
  /** M8-01: seg → linedef index (SEGS record field; minisegs are refused at
   * build). Needed by the p_sight.c:126 P_CrossSubsector line dedup /
   * ML_TWOSIDED / geometry reads. */
  readonly segLine: Int32Array;

  /** Raw THINGS records; view with {@link thingAt} (wad) / {@link mapThingAt}. */
  readonly things: Uint8Array;
  readonly numThings: number;
  /** playerstarts[0..3] ← doomednum 1..4 (p_mobj.c P_SpawnMapThing). */
  readonly playerStarts: readonly (MapThing | null)[];
  /** deathmatchstarts ← doomednum 11, THINGS order. */
  readonly deathmatchStarts: readonly MapThing[];

  /** tag → sector indices, ascending sector order (ARCHITECTURE §5.1). */
  readonly sectorsByTag: ReadonlyMap<number, readonly number[]>;
  /** tag → linedef indices, linedef-scan order. */
  readonly linesByTag: ReadonlyMap<number, readonly number[]>;

  /** BLOCKMAP header (lists stay raw; M2-05 builds the iterator). */
  readonly blockmapOriginX: number;
  readonly blockmapOriginY: number;
  readonly blockmapWidth: number;
  readonly blockmapHeight: number;
  /** Raw reject lump (n²-bit linear, R01 §12); rejectVisible stays in wad. */
  readonly reject: Uint8Array;
  readonly blockmap: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* buildMapFromData                                                    */
/* ------------------------------------------------------------------ */

function toFixed(units: number): number {
  return (units << FRACBITS) | 0;
}

/** Arithmetic-shift-equivalent block index (vanilla `v >> MAPBLOCKSHIFT`). */
function blockIndex(delta: number): number {
  return Math.floor(delta / (MAPBLOCKSIZE * FRACUNIT));
}

/**
 * Build the live-world model from decoded map data. Throws
 * {@link MapSetupError} on any inconsistency vanilla would I_Error (or, in
 * 1.10, silently corrupt memory) on.
 */
export function buildMapFromData(md: MapData): RuntimeMap {
  /* ---- P_LoadVertexes: units → fixed, map bbox from vertices. ---- */
  const numVertexes = md.vertices.length;
  const verticesX = new Int32Array(numVertexes);
  const verticesY = new Int32Array(numVertexes);
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (let i = 0; i < numVertexes; i++) {
    const v = md.vertices[i]!;
    const x = toFixed(v.x);
    const y = toFixed(v.y);
    verticesX[i] = x;
    verticesY[i] = y;
    if (x < bx0) bx0 = x;
    if (x > bx1) bx1 = x;
    if (y < by0) by0 = y;
    if (y > by1) by1 = y;
  }
  if (numVertexes === 0) {
    throw new MapSetupError('Wad has no vertices to bound the map');
  }

  /* ---- P_LoadSectors (lightlevel range check per P_CheckSectors). ---- */
  const numSectors = md.sectors.length;
  const sFloorH = new Int32Array(numSectors);
  const sCeilH = new Int32Array(numSectors);
  const sLight = new Int32Array(numSectors);
  const sSpecial = new Int32Array(numSectors);
  const sTag = new Int32Array(numSectors);
  const sFloorFlat: string[] = [];
  const sCeilFlat: string[] = [];
  for (let i = 0; i < numSectors; i++) {
    const sd = md.sectors[i]!;
    sFloorH[i] = toFixed(sd.floorLh);
    sCeilH[i] = toFixed(sd.ceilingLh);
    sLight[i] = sd.lightLevel < 0 ? 0 : sd.lightLevel > 255 ? 255 : sd.lightLevel;
    sSpecial[i] = sd.special;
    sTag[i] = sd.tag;
    sFloorFlat.push(sd.floorFlat);
    sCeilFlat.push(sd.ceilingFlat);
  }

  /* ---- P_LoadSideDefs. ---- */
  const numSides = md.sideDefs.length;
  const sideSector = new Int32Array(numSides);
  const sideOffX = new Int32Array(numSides);
  const sideOffY = new Int32Array(numSides);
  const sideTop: string[] = [];
  const sideBottom: string[] = [];
  const sideMid: string[] = [];
  for (let i = 0; i < numSides; i++) {
    const sd = md.sideDefs[i]!;
    sideSector[i] = sd.sector;
    sideOffX[i] = toFixed(sd.offset[0]);
    sideOffY[i] = toFixed(sd.offset[1]);
    sideTop.push(sd.toptexture);
    sideBottom.push(sd.bottomtexture);
    sideMid.push(sd.midtexture);
  }

  /* ---- P_LoadLineDefs: deltas, slopetype, bbox, sector backlinks. ---- */
  const numLines = md.lineDefs.length;
  if (numLines >= MAX_SUPPORTED_LINES) {
    throw new MapSetupError(`Wad has too many linedefs (${numLines})`);
  }
  const lines: LineArrays = {
    count: numLines,
    v1: new Int32Array(numLines),
    v2: new Int32Array(numLines),
    dx: new Int32Array(numLines),
    dy: new Int32Array(numLines),
    slopetype: new Uint8Array(numLines),
    bboxLeft: new Int32Array(numLines),
    bboxRight: new Int32Array(numLines),
    bboxTop: new Int32Array(numLines),
    bboxBottom: new Int32Array(numLines),
    flags: new Int32Array(numLines),
    special: new Int32Array(numLines),
    tag: new Int32Array(numLines),
    sideFront: new Int32Array(numLines),
    sideBack: new Int32Array(numLines),
    sectorFront: new Int32Array(numLines),
    sectorBack: new Int32Array(numLines),
    valid: new Int32Array(numLines),
    sideNumFront: new Int32Array(numLines),
    sideNumBack: new Int32Array(numLines),
  };
  for (let i = 0; i < numLines; i++) {
    const ld = md.lineDefs[i]!;
    const x1 = verticesX[ld.v1]!;
    const y1 = verticesY[ld.v1]!;
    const x2 = verticesX[ld.v2]!;
    const y2 = verticesY[ld.v2]!;
    const dx = (x2 - x1) | 0;
    const dy = (y2 - y1) | 0;
    lines.v1[i] = ld.v1;
    lines.v2[i] = ld.v2;
    lines.dx[i] = dx;
    lines.dy[i] = dy;
    lines.slopetype[i] =
      dx === 0
        ? ST_VERTICAL
        : dy === 0
          ? ST_HORIZONTAL
          : FixedDiv(dy, dx) > 0
            ? ST_POSITIVE
            : ST_NEGATIVE;
    lines.bboxLeft[i] = x1 < x2 ? x1 : x2;
    lines.bboxRight[i] = x1 < x2 ? x2 : x1;
    lines.bboxBottom[i] = y1 < y2 ? y1 : y2;
    lines.bboxTop[i] = y1 < y2 ? y2 : y1;
    lines.flags[i] = ld.flags;
    lines.special[i] = ld.special;
    lines.tag[i] = ld.tag;
    lines.sideNumFront[i] = ld.front;
    lines.sideNumBack[i] = ld.back;
    lines.sideFront[i] = ld.front; // decoder guarantees front sidenum != -1
    lines.sideBack[i] = ld.back;
    lines.sectorFront[i] = sideSector[ld.front]!;
    lines.sectorBack[i] = ld.back === -1 ? -1 : sideSector[ld.back]!;
  }

  /* ---- P_LoadNodes: child refs → tagged unions, fields → fixed. ---- */
  const numNodes = md.nodes.length;
  const nX = new Int32Array(numNodes);
  const nY = new Int32Array(numNodes);
  const nDx = new Int32Array(numNodes);
  const nDy = new Int32Array(numNodes);
  const nr = {
    l: new Int32Array(numNodes),
    r: new Int32Array(numNodes),
    t: new Int32Array(numNodes),
    b: new Int32Array(numNodes),
  };
  const nl = {
    l: new Int32Array(numNodes),
    r: new Int32Array(numNodes),
    t: new Int32Array(numNodes),
    b: new Int32Array(numNodes),
  };
  const nRight: NodeChild[] = [];
  const nLeft: NodeChild[] = [];
  const child = (mapName: string, nodeIdx: number, side: string, ref: number, leaves: number): NodeChild => {
    if (nodeRefIsSubsector(ref)) {
      const idx = nodeRefIndex(ref);
      if (idx >= leaves) {
        throw new MapSetupError(
          `map ${mapName}: NODES[${nodeIdx}].${side} subsector ${idx} out of range [0, ${leaves})`,
        );
      }
      return { kind: 'subsector', index: idx };
    }
    if (ref >= numNodes) {
      throw new MapSetupError(
        `map ${mapName}: NODES[${nodeIdx}].${side} node ${ref} out of range [0, ${numNodes})`,
      );
    }
    return { kind: 'node', index: ref };
  };
  for (let i = 0; i < numNodes; i++) {
    // mapdata.loadMap always emits MapNode (decoder superset of Node).
    const nd = md.nodes[i]! as MapNode;
    nX[i] = toFixed(nd.splitx);
    nY[i] = toFixed(nd.splity);
    nDx[i] = toFixed(nd.dx);
    nDy[i] = toFixed(nd.dy);
    [nr, nl].forEach((box, side) => {
      const bb = side === 0 ? nd.rightBBox : nd.leftBBox;
      box.l[i] = toFixed(bb.left);
      box.r[i] = toFixed(bb.right);
      box.t[i] = toFixed(bb.top);
      box.b[i] = toFixed(bb.bottom);
    });
    nRight.push(child(md.name, i, 'right', nd.right, md.ssectors.length));
    nLeft.push(child(md.name, i, 'left', nd.left, md.ssectors.length));
  }

  /* ---- P_GroupLines pt.1: subsector → sector via first seg (+check). ---- */
  const numSegs = md.segs.length;
  const segFront = new Int32Array(numSegs);
  const segBack = new Int32Array(numSegs);
  const segLine = new Int32Array(numSegs);
  for (let i = 0; i < numSegs; i++) {
    const seg = md.segs[i]!;
    if (seg.line < 0) {
      throw new MapSetupError(
        `map ${md.name}: SEGS[${i}] miniseg (line ${seg.line}) not supported`,
      );
    }
    if (seg.side !== 0 && seg.side !== 1) {
      throw new MapSetupError(`map ${md.name}: SEGS[${i}].side ${seg.side} not 0/1`);
    }
    const ln = md.lineDefs[seg.line]!;
    const sideNum = seg.side === 0 ? ln.front : ln.back;
    if (sideNum < 0) {
      throw new MapSetupError(
        `map ${md.name}: SEGS[${i}] references ${seg.side === 0 ? 'missing' : 'second'} sidenum (-1) of linedef ${seg.line}`,
      );
    }
    segLine[i] = seg.line;
    segFront[i] = md.sideDefs[sideNum]!.sector;
    // Fidelity note: vanilla picks the seg backsector from the ML_TWOSIDED
    // flag (P_LoadSegs); we key off the −1 sidenum sentinel, which is what
    // P_LoadLineDefs uses for line->backsector and what sane wads agree on.
    const other = seg.side === 0 ? ln.back : ln.front;
    segBack[i] = other === -1 ? -1 : md.sideDefs[other]!.sector;
  }

  const numSs = md.ssectors.length;
  const ssCount = new Int32Array(numSs);
  const ssStart = new Int32Array(numSs);
  const ssSector = new Int32Array(numSs);
  for (let i = 0; i < numSs; i++) {
    const ss = md.ssectors[i]!;
    ssCount[i] = ss.numsegs;
    ssStart[i] = ss.firstseg;
    if (ss.numsegs === 0) {
      throw new MapSetupError(`map ${md.name}: SSECTORS[${i}] has no segs`);
    }
    const sector = segFront[ss.firstseg]!;
    ssSector[i] = sector;
    for (let j = 1; j < ss.numsegs; j++) {
      if (segFront[ss.firstseg + j] !== sector) {
        throw new MapSetupError(
          `map ${md.name}: SSECTORS[${i}] segs disagree on front sector (${sector} vs ${segFront[ss.firstseg + j]})`,
        );
      }
    }
  }

  /* ---- P_GroupLines pt.2: sector line lists (CSR), bbox, blockbox. ---- */
  const lineCount = new Int32Array(numSectors);
  for (let i = 0; i < numLines; i++) {
    lineCount[lines.sectorFront[i]!]!++;
    const back = lines.sectorBack[i]!;
    if (back !== -1 && back !== lines.sectorFront[i]!) lineCount[back]!++;
  }
  const lineStart = new Int32Array(numSectors + 1);
  for (let i = 0; i < numSectors; i++) lineStart[i + 1] = (lineStart[i] ?? 0) + lineCount[i]!;
  const total = lineStart[numSectors]!;
  const sectorLineIndex = new Int32Array(total);
  const fill = new Int32Array(numSectors); // per-sector write cursor
  const sBBox = {
    l: new Int32Array(numSectors),
    r: new Int32Array(numSectors),
    t: new Int32Array(numSectors),
    b: new Int32Array(numSectors),
  };
  for (let i = 0; i < numSectors; i++) {
    sBBox.l[i] = MAXINT; // M_ClearBox
    sBBox.r[i] = -MAXINT;
    sBBox.t[i] = -MAXINT;
    sBBox.b[i] = MAXINT;
  }
  for (let i = 0; i < numLines; i++) {
    const f = lines.sectorFront[i]!;
    const b = lines.sectorBack[i]!;
    const sectorsOfLine = b === -1 || b === f ? [f] : [f, b];
    for (const sec of sectorsOfLine) {
      const at = (lineStart[sec] ?? 0) + (fill[sec] ?? 0);
      sectorLineIndex[at] = i;
      fill[sec] = (fill[sec] ?? 0) + 1;
    }
    for (const sec of sectorsOfLine) {
      for (const v of [lines.v1[i]!, lines.v2[i]!]) {
        const x = verticesX[v]!;
        const y = verticesY[v]!;
        if (x < sBBox.l[sec]!) sBBox.l[sec] = x;
        if (x > sBBox.r[sec]!) sBBox.r[sec] = x;
        if (y > sBBox.t[sec]!) sBBox.t[sec] = y;
        if (y < sBBox.b[sec]!) sBBox.b[sec] = y;
      }
    }
  }

  const bm = blockmapInfo(md.blockmap, `map ${md.name}: BLOCKMAP`);
  const orgX = toFixed(bm.originX);
  const orgY = toFixed(bm.originY);
  const sSoundX = new Int32Array(numSectors);
  const sSoundY = new Int32Array(numSectors);
  const sBlock = {
    l: new Int32Array(numSectors),
    r: new Int32Array(numSectors),
    t: new Int32Array(numSectors),
    b: new Int32Array(numSectors),
  };
  for (let i = 0; i < numSectors; i++) {
    if ((fill[i] ?? 0) !== lineCount[i]!) {
      throw new MapSetupError(
        `map ${md.name}: P_GroupLines miscounted for sector ${i} (${fill[i]} != ${lineCount[i]})`,
      );
    }
    sSoundX[i] = (((sBBox.r[i]! + sBBox.l[i]!) / 2) | 0);
    sSoundY[i] = (((sBBox.t[i]! + sBBox.b[i]!) / 2) | 0);
    sBlock.t[i] = Math.min(Math.max(blockIndex((sBBox.t[i]! - orgY + MAXRADIUS) | 0), 0), bm.height - 1);
    sBlock.b[i] = Math.min(Math.max(blockIndex((sBBox.b[i]! - orgY - MAXRADIUS) | 0), 0), bm.height - 1);
    sBlock.r[i] = Math.min(Math.max(blockIndex((sBBox.r[i]! - orgX + MAXRADIUS) | 0), 0), bm.width - 1);
    sBlock.l[i] = Math.min(Math.max(blockIndex((sBBox.l[i]! - orgX - MAXRADIUS) | 0), 0), bm.width - 1);
  }

  /* ---- Tag indexes (load order; ARCHITECTURE §5.1). ---- */
  const pushTag = (index: Map<number, number[]>, tag: number, elem: number): void => {
    const list = index.get(tag);
    if (list) list.push(elem);
    else index.set(tag, [elem]);
  };
  const sectorsByTag = new Map<number, number[]>();
  for (let i = 0; i < numSectors; i++) {
    const t = sTag[i]!;
    if (t !== 0) pushTag(sectorsByTag, t, i);
  }
  const linesByTag = new Map<number, number[]>();
  for (let i = 0; i < numLines; i++) {
    const t = lines.tag[i]!;
    if (t !== 0) pushTag(linesByTag, t, i);
  }

  /* ---- P_LoadThings (starts only; monster spawning is M2-08). ---- */
  const numThings = thingCount(md);
  const playerStarts: (MapThing | null)[] = [null, null, null, null];
  const deathmatchStarts: MapThing[] = [];
  for (let i = 0; i < numThings; i++) {
    const t = thingAt(md, i);
    if (t.type === 11) deathmatchStarts.push(t);
    else if (t.type >= 1 && t.type <= 4) playerStarts[t.type - 1] = t;
  }

  return {
    name: md.name,
    numVertexes,
    verticesX,
    verticesY,
    mapBBox: { left: bx0, right: bx1, top: by1, bottom: by0 },
    lines,
    sides: {
      count: numSides,
      sector: sideSector,
      offsetX: sideOffX,
      offsetY: sideOffY,
      topTexture: sideTop,
      bottomTexture: sideBottom,
      midTexture: sideMid,
    },
    sectors: {
      count: numSectors,
      floorHeight: sFloorH,
      ceilingHeight: sCeilH,
      lightLevel: sLight,
      special: sSpecial,
      tag: sTag,
      floorFlat: sFloorFlat,
      ceilingFlat: sCeilFlat,
      lineCount,
      lineStart,
      bboxLeft: sBBox.l,
      bboxRight: sBBox.r,
      bboxTop: sBBox.t,
      bboxBottom: sBBox.b,
      soundOrgX: sSoundX,
      soundOrgY: sSoundY,
      blockBoxLeft: sBlock.l,
      blockBoxRight: sBlock.r,
      blockBoxTop: sBlock.t,
      blockBoxBottom: sBlock.b,
      soundTraversed: new Int32Array(numSectors),
      soundTarget: new Int32Array(numSectors).fill(-1),
      valid: new Int32Array(numSectors),
    },
    nodes: {
      count: numNodes,
      x: nX,
      y: nY,
      dx: nDx,
      dy: nDy,
      rightBBoxLeft: nr.l,
      rightBBoxRight: nr.r,
      rightBBoxTop: nr.t,
      rightBBoxBottom: nr.b,
      leftBBoxLeft: nl.l,
      leftBBoxRight: nl.r,
      leftBBoxTop: nl.t,
      leftBBoxBottom: nl.b,
      right: nRight,
      left: nLeft,
    },
    subsectors: { count: numSs, segCount: ssCount, segStart: ssStart, sector: ssSector },
    sectorLineIndex,
    numSegs,
    segSectorFront: segFront,
    segSectorBack: segBack,
    segLine,
    things: md.things,
    numThings,
    playerStarts,
    deathmatchStarts,
    sectorsByTag,
    linesByTag,
    blockmapOriginX: orgX,
    blockmapOriginY: orgY,
    blockmapWidth: bm.width,
    blockmapHeight: bm.height,
    reject: md.reject,
    blockmap: md.blockmap,
  };
}

/* ------------------------------------------------------------------ */
/* Convenience views                                                   */
/* ------------------------------------------------------------------ */

/**
 * Thing `i` as a typed record. Same 5×i16 layout mapdata.ts `thingAt` uses
 * (R01 §4), re-read from the runtime copy so the map is self-contained.
 */
export function mapThingAt(map: RuntimeMap, i: number): MapThing {
  if (i < 0 || i >= map.numThings) {
    throw new MapSetupError(`thing ${i} out of range [0, ${map.numThings})`);
  }
  const view = new DataView(map.things.buffer, map.things.byteOffset, map.things.byteLength);
  const o = i * 10;
  return {
    x: view.getInt16(o, true),
    y: view.getInt16(o + 2, true),
    angle: view.getInt16(o + 4, true),
    type: view.getInt16(o + 6, true),
    flags: view.getInt16(o + 8, true),
  };
}

/** Sectors carrying `tag`, ascending sector index (empty array if none). */
export function sectorsWithTag(map: RuntimeMap, tag: number): readonly number[] {
  return map.sectorsByTag.get(tag) ?? EMPTY;
}

const EMPTY: readonly number[] = [];
