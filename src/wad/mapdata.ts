/**
 * mapdata — map lump decoders THINGS…BLOCKMAP + REJECT (M2-03).
 *
 * Contracts are the §2.2 structs in ./types.ts, implemented exactly; record
 * layouts and every parser quirk follow R01 §3-13/§15:
 *
 *  - Lumps resolve BY INDEX from the map marker (marker+1 … marker+10,
 *    p_setup.c `W_GetNumForName(map)+i+1`, R01 §3/§15.1). Empirically confirmed
 *    on freedoom1.wad: map data lumps carry the PLAIN names THINGS…BLOCKMAP
 *    (no 'E1M1THNG'/'E1M1THINGS' prefix exists anywhere in the dir) and every
 *    one of the 36 maps reuses those same names — name-based resolution of
 *    data lumps is impossible, and decoy later 'THINGS' lumps must not win.
 *  - Both marker patterns work with zero extra code: 'E1M1'…'E4M9' (Doom 1)
 *    and 'MAP01'… (Doom 2, R01 §17) are just zero-size marker lumps whose
 *    following ten lumps form the map.
 *  - −1 sentinels (sidenum[1], seg linedef refs) are read SIGNED (R01 §15.3).
 *    getUint16 is used ONLY on fields that can never be −1: seg BAM angle,
 *    linedef flags, NODES child refs, BLOCKMAP offsets (grep-clean rule).
 *
 * Interpretation notes (deviations/ambiguities in the contract docs):
 *  - NODES child bbox order: R01 §10 says {minx,miny,maxx,maxy}; the actual
 *    bytes are {BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT} = {maxy,miny,minx,maxx}
 *    (vanilla r_main.h `box` enum; verified on E1M1 — under R01's order
 *    208/1362 child boxes violate min<=max, under top/bottom/left/right 0 do).
 *  - Contract `Node.bbox` is a single BBox but vanilla stores one PER CHILD.
 *    `bbox` decodes as the RIGHT (front, child 0) box; the decoded objects
 *    additionally carry `rightBBox` (=== bbox) and `leftBBox` — a structural
 *    superset of Node, so still assignable to `Node[]` (contract gap note).
 *  - `Node.right`/`left` keep the RAW u16 child ref; the subsector marker is
 *    the HIGH bit (0x8000 = NF_SUBSECTOR, R01 §10; §2.2's "low bit" comment
 *    is wrong — E1M1 children 32769/32770 confirm 0x8000). Helpers
 *    {@link nodeRefIsSubsector} / {@link nodeRefIndex} do the split.
 *  - `splitx/splity` are stored as RAW int16 map units, not <<FRACBITS fixed
 *    (R01 §10: "1.10 stores as fixed" — the shift happens in sim setup,
 *    consistent with `Vertex`'s "fixed later" contract note).
 *  - THINGS x/angle/type/flags are read signed per R01 §4 (`mapthing_t` =
 *    5×int16, GPL SHORT()); observed E1M1 angles are only 0…315 so u16 vs
 *    i16 is untestable on the IWAD — signed is the vanilla-faithful choice.
 *  - SECTORS light/special/tag are int16 (R01 §11 verified against
 *    doomdata.h), despite some docs claiming u16.
 *  - Vanilla validates almost nothing at load (P_SetupLevel just points
 *    arrays); this decoder adds typed {@link MapDataError} index/size checks
 *    at the load boundary — early, loud errors instead of vanilla's later
 *    segfaults. Size/offset checks match the task's malformed-data contract.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { BBox, LineDef, MapData, Node, Seg, SectorDef, SideDef, SubsectorDef, Vertex } from './types';
import type { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Constants + typed error                                             */
/* ------------------------------------------------------------------ */

/** ML_THINGS…ML_BLOCKMAP order (p_setup.c `ML_*` enum, R01 §3 table). */
export const MAP_LUMP_NAMES = [
  'THINGS',
  'LINEDEFS',
  'SIDEDEFS',
  'VERTEXES',
  'SEGS',
  'SSECTORS',
  'NODES',
  'SECTORS',
  'REJECT',
  'BLOCKMAP',
] as const;

/** Record sizes, bytes (R01 §4-10). REJECT/BLOCKMAP are variable-size. */
export const RECORD_SIZE = {
  THINGS: 10,
  LINEDEFS: 14,
  SIDEDEFS: 30,
  VERTEXES: 4,
  SEGS: 12,
  SSECTORS: 4,
  NODES: 28,
  SECTORS: 26,
} as const;

/** NODES child high bit: set ⇒ index into SSECTORS (R01 §10, doomdata.h). */
export const NF_SUBSECTOR = 0x8000;

/** Thrown for a missing map or any structurally malformed map lump. */
export class MapDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapDataError';
  }
}

/** True when a NODES child ref points at SSECTORS (bit 15 set). */
export function nodeRefIsSubsector(ref: number): boolean {
  return (ref & NF_SUBSECTOR) !== 0;
}

/** Table index a NODES child ref denotes (masks off NF_SUBSECTOR). */
export function nodeRefIndex(ref: number): number {
  return ref & ~NF_SUBSECTOR & 0xffff;
}

/* ------------------------------------------------------------------ */
/* Extra decoded shapes (supersets of the §2.2 contracts)              */
/* ------------------------------------------------------------------ */

/** Typed view of one raw 10 B THINGS record ({@link thingAt}). */
export interface MapThing {
  x: number;
  y: number;
  /** Degrees, signed per R01 §4 (observed multiples of 45). */
  angle: number;
  /** doomednum. */
  type: number;
  /** MTF_* option bits (skill bits + 0x8 ambush etc., R01 §4). */
  flags: number;
}

/**
 * Decoded NODES record: exactly the §2.2 `Node` fields plus the per-child
 * bboxes vanilla stores (contract has room for only one — `bbox` = right).
 */
export interface MapNode extends Node {
  /** === bbox (right/front child 0). */
  rightBBox: BBox;
  /** Back/left child 1 bounding box. */
  leftBBox: BBox;
}

/** BLOCKMAP header (R01 §13); block size is 128×128 map units. */
export interface BlockmapInfo {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ */
/* loadMap                                                             */
/* ------------------------------------------------------------------ */

/** Little-endian i16. Named helper so the "never read −1-capable fields
 *  unsigned" rule stays verifiable by grepping the call sites. */
function i16(view: DataView, at: number): number {
  return view.getInt16(at, true);
}

/** 8-byte lump-name field → trimmed (NUL+space), uppercased (R01 §2/§6). */
function nameOf(bytes: Uint8Array, at: number): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const c = bytes[at + i]!;
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trimEnd().toUpperCase();
}

/** Fixed-width name field written as ASCII bytes (test fixtures use it too). */
export function encodeNameField(name: string): Uint8Array {
  const out = new Uint8Array(8);
  const upper = name.toUpperCase();
  for (let i = 0; i < upper.length && i < 8; i++) out[i] = upper.charCodeAt(i);
  return out;
}

interface LumpBytes {
  bytes: Uint8Array;
  view: DataView;
}

function mapLump(wad: WadFile, marker: number, slot: number, mapName: string): LumpBytes {
  const num = marker + 1 + slot;
  const total = lumpCount(wad);
  if (num >= total) {
    throw new MapDataError(
      `map ${mapName}: lump '${MAP_LUMP_NAMES[slot]}' missing (lump ${num} past dir end ${total})`,
    );
  }
  const bytes = wad.readLump(num);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { bytes, view };
}

function lumpCount(wad: WadFile): number {
  let n = 0;
  while (wad.lumpNumAt(n) === n) n++;
  return n;
}

/** Record count = size / recSize, erroring on a partial trailing record. */
function records(lump: LumpBytes, slot: number, mapName: string, recSize: number): number {
  if (lump.bytes.byteLength % recSize !== 0) {
    throw new MapDataError(
      `map ${mapName}: ${MAP_LUMP_NAMES[slot]} size ${lump.bytes.byteLength} not a multiple of ${recSize}`,
    );
  }
  return lump.bytes.byteLength / recSize;
}

/**
 * Decode the map `name` ('E1M1'…'E4M9' or 'MAP01'…, R01 §17) out of `wad`.
 * Data lumps resolve BY INDEX from the marker lump (R01 §15.1), never by
 * name. Throws {@link MapDataError} for a missing marker or malformed data.
 */
export function loadMap(wad: WadFile, name: string): MapData {
  const mapName = name.trimEnd().toUpperCase();
  const marker = wad.lumpNumByName(mapName);
  if (marker < 0) {
    throw new MapDataError(`map '${mapName}': marker lump not found`);
  }
  const lump = (slot: number): LumpBytes => mapLump(wad, marker, slot, mapName);

  const thingsLump = lump(0);
  records(thingsLump, 0, mapName, RECORD_SIZE.THINGS); // size validated; kept raw

  const lineLump = lump(1);
  const nLines = records(lineLump, 1, mapName, RECORD_SIZE.LINEDEFS);

  const sideLump = lump(2);
  const nSides = records(sideLump, 2, mapName, RECORD_SIZE.SIDEDEFS);

  const vertLump = lump(3);
  const nVerts = records(vertLump, 3, mapName, RECORD_SIZE.VERTEXES);

  const segLump = lump(4);
  const nSegs = records(segLump, 4, mapName, RECORD_SIZE.SEGS);

  const ssLump = lump(5);
  const nSs = records(ssLump, 5, mapName, RECORD_SIZE.SSECTORS);

  const nodeLump = lump(6);
  const nNodes = records(nodeLump, 6, mapName, RECORD_SIZE.NODES);

  const sectorLump = lump(7);
  const nSectors = records(sectorLump, 7, mapName, RECORD_SIZE.SECTORS);

  const rejectLump = lump(8);
  const blockLump = lump(9);

  /* ---- THINGS: kept RAW (contract §2.2); view via thingAt. ---- */
  const things = new Uint8Array(thingsLump.bytes);

  /* ---- VERTEXES (R01 §7) — decoded before cross-checked refs. ---- */
  const vertices: Vertex[] = [];
  for (let i = 0; i < nVerts; i++) {
    vertices.push({ x: i16(vertLump.view, i * 4), y: i16(vertLump.view, i * 4 + 2) });
  }

  /* ---- SECTORS (R01 §11) — before SIDEDEFS sector refs. ---- */
  const sectors: SectorDef[] = [];
  for (let i = 0; i < nSectors; i++) {
    const o = i * 26;
    sectors.push({
      floorLh: i16(sectorLump.view, o),
      ceilingLh: i16(sectorLump.view, o + 2),
      floorFlat: nameOf(sectorLump.bytes, o + 4),
      ceilingFlat: nameOf(sectorLump.bytes, o + 12),
      lightLevel: i16(sectorLump.view, o + 20),
      special: i16(sectorLump.view, o + 22),
      tag: i16(sectorLump.view, o + 24),
    });
  }

  /* ---- SIDEDEFS (R01 §6, 6). light is unused (Hexen-only field) = 0. ---- */
  const sideDefs: SideDef[] = [];
  for (let i = 0; i < nSides; i++) {
    const o = i * 30;
    const sector = i16(sideLump.view, o + 28);
    if (sector < 0 || sector >= nSectors) {
      throw new MapDataError(
        `map ${mapName}: SIDEDEFS[${i}].sector ${sector} out of range [0, ${nSectors})`,
      );
    }
    sideDefs.push({
      sector,
      // vanilla mapsidedef_t (doomdata.h): top@4, BOTTOM@12, MID@20 (R01 §6).
      // M4-10 FIX: this decode had mid/bottom swapped (mid←12, bot←20), so
      // every real-wad midtexture read as absent → untextured black wall
      // columns + masked lines lost their mask tag (m4Fixtures COMPAT shim).
      toptexture: nameOf(sideLump.bytes, o + 4),
      bottomtexture: nameOf(sideLump.bytes, o + 12),
      midtexture: nameOf(sideLump.bytes, o + 20),
      offset: [i16(sideLump.view, o), i16(sideLump.view, o + 2)],
      light: 0,
    });
  }

  /* ---- LINEDEFS (R01 §5). sidenum signed, −1 = one-sided (R01 §15.3). ---- */
  const lineDefs: LineDef[] = [];
  for (let i = 0; i < nLines; i++) {
    const o = i * 14;
    const v1 = i16(lineLump.view, o);
    const v2 = i16(lineLump.view, o + 2);
    const front = i16(lineLump.view, o + 10);
    const back = i16(lineLump.view, o + 12);
    for (const [what, v] of [['v1', v1], ['v2', v2]] as const) {
      if (v < 0 || v >= nVerts) {
        throw new MapDataError(
          `map ${mapName}: LINEDEFS[${i}].${what} ${v} out of range [0, ${nVerts})`,
        );
      }
    }
    if (front < 0 || front >= nSides) {
      throw new MapDataError(
        `map ${mapName}: LINEDEFS[${i}].sidenum[0] ${front} out of range [0, ${nSides})`,
      );
    }
    if (back !== -1 && (back < 0 || back >= nSides)) {
      throw new MapDataError(
        `map ${mapName}: LINEDEFS[${i}].sidenum[1] ${back} neither -1 nor < ${nSides}`,
      );
    }
    lineDefs.push({
      v1,
      v2,
      front,
      back,
      flags: lineLump.view.getUint16(o + 4, true), // flags: bits, never −1
      special: i16(lineLump.view, o + 6),
      tag: i16(lineLump.view, o + 8),
    });
  }

  /* ---- SEGS (R01 §8). angle is u16 BAM (65536 = 360°); line −1 = miniseg. ---- */
  const segs: Seg[] = [];
  for (let i = 0; i < nSegs; i++) {
    const o = i * 12;
    const v1 = i16(segLump.view, o);
    const v2 = i16(segLump.view, o + 2);
    const line = i16(segLump.view, o + 6);
    for (const [what, v] of [['v1', v1], ['v2', v2]] as const) {
      if (v < 0 || v >= nVerts) {
        throw new MapDataError(
          `map ${mapName}: SEGS[${i}].${what} ${v} out of range [0, ${nVerts})`,
        );
      }
    }
    if (line < -1 || line >= nLines) {
      throw new MapDataError(
        `map ${mapName}: SEGS[${i}].linedef ${line} neither >=-1 nor < ${nLines}`,
      );
    }
    segs.push({
      v1,
      v2,
      angle: segLump.view.getUint16(o + 4, true), // BAM u16, never −1
      line,
      side: i16(segLump.view, o + 8),
      offset: i16(segLump.view, o + 10),
    });
  }

  /* ---- SSECTORS (R01 §9): i16 numsegs, i16 firstseg; segs contiguous. ---- */
  const ssectors: SubsectorDef[] = [];
  for (let i = 0; i < nSs; i++) {
    const numsegs = i16(ssLump.view, i * 4);
    const firstseg = i16(ssLump.view, i * 4 + 2);
    if (numsegs < 0 || firstseg < 0 || firstseg + numsegs > nSegs) {
      throw new MapDataError(
        `map ${mapName}: SSECTORS[${i}] {numsegs:${numsegs},firstseg:${firstseg}} past ${nSegs} segs`,
      );
    }
    ssectors.push({ numsegs, firstseg });
  }

  /* ---- NODES (R01 §10). Children are RAW u16 (bit15 = NF_SUBSECTOR).
   * Child bbox disk order is top,bottom,left,right (see header note). ---- */
  const bboxAt = (view: DataView, o: number): BBox => ({
    left: i16(view, o + 4),
    bottom: i16(view, o + 2),
    right: i16(view, o + 6),
    top: i16(view, o),
  });
  const nodes: MapNode[] = [];
  for (let i = 0; i < nNodes; i++) {
    const o = i * 28;
    const right = nodeLump.view.getUint16(o + 24, true);
    const left = nodeLump.view.getUint16(o + 26, true);
    for (const child of [right, left]) {
      if (nodeRefIsSubsector(child)) {
        if (nodeRefIndex(child) >= nSs) {
          throw new MapDataError(
            `map ${mapName}: NODES[${i}] subsector ref ${child} & 0x7fff out of range [0, ${nSs})`,
          );
        }
      } else if (child >= nNodes) {
        throw new MapDataError(
          `map ${mapName}: NODES[${i}] child ref ${child} out of range [0, ${nNodes})`,
        );
      }
    }
    const rightBBox = bboxAt(nodeLump.view, o + 8);
    const leftBBox = bboxAt(nodeLump.view, o + 16);
    nodes.push({
      bbox: rightBBox,
      rightBBox,
      leftBBox,
      splitx: i16(nodeLump.view, o),
      splity: i16(nodeLump.view, o + 2),
      dx: i16(nodeLump.view, o + 4),
      dy: i16(nodeLump.view, o + 6),
      right,
      left,
    });
  }

  /* ---- REJECT: raw copy; size tolerated (clamped reads, R01 §12). ---- */
  const reject = new Uint8Array(rejectLump.bytes);

  /* ---- BLOCKMAP: raw copy; header + list termination validated (R01 §13). ---- */
  const blockmap = new Uint8Array(blockLump.bytes);
  const bm = blockmapInfo(blockmap, `map ${mapName}: BLOCKMAP`);
  const words = bm.words;
  const tableEnd = 4 + bm.width * bm.height; // word index just past the table
  for (let b = 0; b < bm.width * bm.height; b++) {
    // Offset table entries are u16 WORD offsets from the lump start (R01 §13);
    // list ENTRIES are i16 (−1 terminator) — never read one as the other.
    let w = bm.view.getUint16((4 + b) * 2, true);
    if (w < tableEnd || w * 2 >= blockmap.byteLength) {
      throw new MapDataError(
        `map ${mapName}: BLOCKMAP block ${b} offset ${w} outside the line section`,
      );
    }
    for (;;) {
      if (w * 2 + 2 > blockmap.byteLength) {
        throw new MapDataError(
          `map ${mapName}: BLOCKMAP block ${b} line list runs past the lump end`,
        );
      }
      const v = words[w]!;
      if (v === -1) break;
      if (v < 0 || v >= nLines) {
        throw new MapDataError(
          `map ${mapName}: BLOCKMAP block ${b} references line ${v} out of range [0, ${nLines})`,
        );
      }
      w++;
    }
  }

  return {
    name: mapName,
    things,
    lineDefs,
    sideDefs,
    vertices,
    segs,
    ssectors,
    nodes,
    sectors,
    reject,
    blockmap,
  };
}

/* ------------------------------------------------------------------ */
/* Typed views + REJECT + BLOCKMAP helpers                             */
/* ------------------------------------------------------------------ */

/**
 * Typed view of thing `i` in the raw 10 B THINGS records (R01 §4:
 * i16 x, i16 y, i16 angle, i16 type, i16 flags — all read signed).
 */
export function thingAt(md: MapData, i: number): MapThing {
  const at = i * RECORD_SIZE.THINGS;
  if (i < 0 || at + RECORD_SIZE.THINGS > md.things.byteLength) {
    throw new MapDataError(`thingAt: index ${i} past ${md.name} THINGS (${md.things.byteLength / 10} records)`);
  }
  const view = new DataView(md.things.buffer, md.things.byteOffset, md.things.byteLength);
  return {
    x: i16(view, at),
    y: i16(view, at + 2),
    angle: i16(view, at + 4),
    type: i16(view, at + 6),
    flags: i16(view, at + 8),
  };
}

/** Thing count of `md` (raw THINGS length / 10). */
export function thingCount(md: MapData): number {
  return md.things.byteLength / RECORD_SIZE.THINGS;
}

/**
 * REJECT visibility per vanilla `P_CheckSight` (R01 §12/§15.5): the bit at
 * LINEAR position s1·n + s2 (n = sector count), bit 1 = cannot see. Reads
 * past the stored matrix clamp to 0x00 = visible (short/row-padded pwads).
 */
export function rejectVisible(md: MapData, s1: number, s2: number): boolean {
  const n = md.sectors.length;
  if (s1 < 0 || s2 < 0 || s1 >= n || s2 >= n) return true; // clamped: no bit = visible
  const pnum = s1 * n + s2;
  const byte = pnum >> 3;
  if (byte >= md.reject.byteLength) return true; // clamp (R01 §12)
  return (md.reject[byte]! & (1 << (pnum & 7))) === 0;
}

/**
 * Parse + validate the BLOCKMAP header (R01 §13): i16 origin x/y, then grid
 * dims; block = 128×128 units. Also returns an Int16Array word view for
 * offset math (word offsets are from the LUMP START; ×2 = bytes). Accepts a
 * raw byte array or a decoded {@link MapData}.
 */
export function blockmapInfo(
  src: Uint8Array | MapData,
  what = 'BLOCKMAP',
): BlockmapInfo & { words: Int16Array; view: DataView } {
  const bytes = src instanceof Uint8Array ? src : src.blockmap;
  if (bytes.byteLength < 12) {
    throw new MapDataError(`${what}: ${bytes.byteLength} bytes, too small for the 12-byte header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info = {
    originX: i16(view, 0),
    originY: i16(view, 2),
    width: i16(view, 4),
    height: i16(view, 6),
  };
  if (info.width <= 0 || info.height <= 0 || info.width * info.height > 1_000_000) {
    throw new MapDataError(`${what}: bad grid dims ${info.width}×${info.height}`);
  }
  const words = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  return { ...info, words, view };
}
