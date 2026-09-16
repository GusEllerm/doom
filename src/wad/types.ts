/**
 * Shared WAD/graphics contract types (M1-01).
 *
 * These are the typed contracts the parallel M1 decoders build against.
 * Field-level shapes are derived verbatim from ARCHITECTURE.md §2.1/§2.2,
 * plus the decoded-graphics types of gap G1 (docs/design/M1-plan.md §M1-01)
 * that §2 does not define. Do not change names or shapes without a new ADR.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* ------------------------------------------------------------------ */
/* §2.1 WAD access (ARCHITECTURE §2.1; class skeleton in ./wadfile.ts) */
/* ------------------------------------------------------------------ */

export interface LumpInfo {
  name: string;
  lumpnum: number;
}

/* ------------------------------------------------------------------ */
/* §2.2 Map data — decoded structs (ARCHITECTURE §2.2, sizes R01 §4-13) */
/* Declared here so M2 needs no contract re-open (M1-plan §M1-01).     */
/* ------------------------------------------------------------------ */

export interface MapData {
  /** 'E1M1' or 'MAP01'; both patterns accepted (R01 §17). */
  name: string;
  /** Raw 10 B records; typed view helpers live with the mapdata decoder. */
  things: Uint8Array;
  lineDefs: LineDef[];
  sideDefs: SideDef[];
  vertices: Vertex[];
  segs: Seg[];
  ssectors: SubsectorDef[];
  nodes: Node[];
  sectors: SectorDef[];
  /** reject = linear n²-bit packing (R01 §12). */
  reject: Uint8Array;
  blockmap: Uint8Array;
}

/** Fixed later (i32 raw units). */
export interface Vertex {
  x: number;
  y: number;
}

export interface SideDef {
  sector: number;
  toptexture: string;
  midtexture: string;
  bottomtexture: string;
  offset: [number, number];
  /** Unused. */
  light: number;
}

export interface LineDef {
  v1: number;
  v2: number;
  front: number;
  back: number;
  flags: number;
  special: number;
  tag: number;
}

export interface Seg {
  v1: number;
  v2: number;
  /** BAM, u32-as-number. */
  angle: number;
  line: number;
  side: number;
  offset: number;
}

export interface SubsectorDef {
  numsegs: number;
  firstseg: number;
}

/** Axis-aligned bounding box of a BSP node (R01 §10 / m_bbox.c). */
export interface BBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Low bit of `right`/`left` = subsector flag. */
export interface Node {
  bbox: BBox;
  /** fixed */
  splitx: number;
  splity: number;
  dx: number;
  dy: number;
  right: number;
  left: number;
}

export interface SectorDef {
  floorLh: number;
  ceilingLh: number;
  floorFlat: string;
  ceilingFlat: string;
  lightLevel: number;
  special: number;
  tag: number;
}

/* ------------------------------------------------------------------ */
/* Gap G1 — decoded graphics types (M1-plan §M1-01)                    */
/* ------------------------------------------------------------------ */

/** PLAYPAL + COLORMAP decoded: 14 palettes × 256 RGBA entries, 34 colormap rows. */
export interface Palettes {
  /** 14*256 RGBA entries. */
  base: Uint32Array;
  /** 34*256 colormaps. */
  colormapRows: Uint8Array;
}

/** Patch (PKCMAP/post format) decoded to per-column aligned post runs. */
export interface DecodedPatch {
  width: number;
  height: number;
  leftOffset: number;
  topOffset: number;
  /** Per column, aligned post runs (ARCHITECTURE §4.3). */
  columns: Uint8Array[];
}

/** 64×64 flat, row-major — bytes are verbatim 64 rows of 64 (R02 §6; corrected via M1-06: the earlier "column-major" note was wrong for flats — textures, not flats, are column-major in vanilla). */
export interface DecodedFlat {
  name: string;
  /** 64*64 = 4096 palette indices. */
  pixels: Uint8Array;
}

/** One composition patch entry of a TEXTURE1 texture directory row. */
export interface TexturePatch {
  /** Origin x within the texture (originx). */
  originX: number;
  /** Origin y within the texture (originy). */
  originY: number;
  /** Patch lump number / DecodedPatch index (patch). */
  patchNum: number;
}

/** Texture composed from patches; column-major, 0 = transparent. */
export interface TextureDef {
  name: string;
  width: number;
  height: number;
  patches: TexturePatch[];
  /** Composed, column-major, 0 = transparent. */
  columns: Uint8Array[];
}

/** S_START Sxyy block decoded (spriteframe_t per frame, rotated 8-way or single). */
export interface SpriteDef {
  /** 4-char sprite name, e.g. 'PLAY'. */
  name4: string;
  frames: {
    rotate: boolean;
    /** Lump indices per rotation slot (−1 = absent); length 8. */
    lump: [number, number, number, number, number, number, number, number];
    /** Per-slot flip flag (0/1); length 8. */
    flip: Uint8Array;
  }[];
}
