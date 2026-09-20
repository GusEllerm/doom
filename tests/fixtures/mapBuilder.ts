/**
 * M2-02 — Rectangle-spec fixture map generator + BSP property self-check
 * (ARCHITECTURE A-04 chain pt.2, M2-plan §M2-02).
 *
 * ## DESIGN: RectMapSpec — the rectangle model
 *
 * A fixture map is a list of NON-OVERLAPPING axis-aligned rectangles ("rooms")
 * on the integer grid plus optional door gaps plus an optional thing list.
 * Everything else (all 10 map lumps) is DERIVED, so a spec can never encode
 * an inconsistent map:
 *
 *  - ROOMS. `x,y` is the min corner, `w,h > 0`; rooms may touch along edges
 *    but positive-area overlap is rejected (typed error). Room rectangles are
 *    sectors: sector 0 is the VOID dummy sector (floor = ceiling = -128),
 *    room i is sector i+1. All coordinates are integers within ±8192.
 *  - WALLS = every room's full boundary. A boundary interval shared with
 *    another room's boundary becomes ONE two-sided linedef (deduplicated),
 *    front = the earlier-indexed room; the default for a shared edge is an
 *    OPEN connection (this is the "corridor implied by shared edges" model —
 *    two rooms touching along an overlap are linked by an untextured
 *    two-sided line). Edges facing no room (void) get a two-sided line whose
 *    BACK sidedef points at the VOID sector 0 — the DUMMY-SECTOR convention
 *    documented below.
 *  - DOOR GAPS are explicit wall segments with a door special: an
 *    axis-aligned segment lying on a room-ROOM shared edge; it splits that
 *    edge and its linedef carries `special` (default 1, vanilla "regular
 *    door") + `tag` + midtexture 'DOORFIX0' on both sides. A door on a
 *    room-void edge is a spec error.
 *  - THINGS: default = player starts 1..4 + one dot item (doomednum 2035) at
 *    room 0's center; `spec.things` replaces the list wholesale.
 *  - TRIGGER LINES (M6-02, docs/design/M6-plan.md §M6-02) are `spec.triggers`:
 *    axis-aligned segments lying on a room boundary edge (room-room OR
 *    room-VOID — unlike doors, which need two rooms) that split the edge like
 *    a door gap; the middle linedef(s) carry the RAW int16 `special` + `tag`
 *    exactly as the DOOM1 LINEDEFS record stores them (R01 §5: special SHORT
 *    @ offset 6, tag SHORT @ 8 — offset 12 is sidenum[1]; there are NO args
 *    and NO packing in the DOOM1 WAD format, see the m6Fixtures header).
 *    Optional `texture` writes the name to the FRONT (room-side, sidenum[0])
 *    mid-texture only — the switch-marker convention, because vanilla
 *    P_ChangeSwitchTexture scans side 0's texture slots (R05 §12). Optional
 *    `secret: true` sets ML_SECRET (0x020) on the line (R05 §1.2 monster-use
 *    gate). Doors gained the same optional `secret` flag. EVERY new field is
 *    OPTIONAL: a spec without them compiles BYTE-IDENTICAL to the pre-M6
 *    generator (pinned by the sha goldens in m6Fixtures.test.ts — the M3/M4
 *    render goldens cannot move).
 *
 * ## DUMMY-SECTOR choice for "one-sided-looking" void walls (documented)
 *
 * Vanilla convention for a solid wall is a ONE-SIDED linedef (sidenum[1] =
 * -1). We deliberately do NOT do that for void borders: bspSplit.ts emits no
 * minisegs, so the void region outside the rooms would produce ZERO-SEG
 * subsectors, and `P_GroupLines` derives a subsector's sector from its first
 * seg (R01 §9) — a zero-seg subsector is a crash for every later consumer.
 * Instead every void-facing wall is TWO-SIDED (flags ML_TWOSIDED) with a
 * back sidedef into the dummy VOID sector 0 (floor = ceiling = -128), so
 * every subsector — rooms AND void — has ≥1 seg and exactly one sector.
 * Void solidity comes from geometry: the void's ceiling (-128) is below any
 * room floor (default 0), which vanilla treats as closed (M2 is noclip
 * anyway). SIDEDEF COUNT is therefore 2 per linedef; no sidenum is ever -1
 * in generated maps, but selfCheck ACCEPTS vanilla one-sided lines too.
 *
 * ## Other conventions (all pinned by R01 §3-13)
 *  - Records: THINGS 10 B (skill flags 0x1|0x2|0x4 = 7), LINEDEFS 14 B
 *    (ML_TWOSIDED = 4), SIDEDEFS 30 B (NUL-padded names, empty = all-NUL),
 *    VERTEXES 4 B (deduped by coordinate; the table is bspSplit's, so seg
 *    indices match exactly), SEGS/SSECTORS/NODES from buildGridNodes,
 *    SECTORS 26 B, REJECT = ceil(n²/8) ZERO bytes — REJECT bit set means
 *    NOT visible, so all-zero = fully connected: conservative-correct for
 *    fixtures (P_CheckSight then always falls through to the trace) — and
 *    BLOCKMAP per R01 §13: origin = (minVertex.x − 64, minVertex.y − 64)
 *    (so every vertex lands in-grid: vertex − origin ∈ [64, span+64]),
 *    128-unit blocks, WORD offsets from lump start, lists are int16 line
 *    indices terminated by −1; the list region starts immediately after the
 *    offset table (no padding word), empty blocks all point at one shared
 *    bare [−1] terminator. A linedef is listed in EXACTLY the blocks its
 *    bbox touches (floor((p − origin)/128) per endpoint axis).
 *  - The map is the `name` marker lump (default 'FIXMAP') followed by the
 *    plain-named THINGS..BLOCKMAP data lumps (R01 §3: consumers resolve
 *    them BY INDEX from the marker). Graphics lumps (TEXTURE1/PNAMES, two
 *    4096-byte flats in F_START/F_END, two 2x2 patches in P_START/P_END —
 *    the smallWads helpers) live BEFORE the marker; texture names used by
 *    sidedefs come from the built-in set {FIXWALL0, DOORFIX0}.
 *
 * mapSelfCheck() re-reads the WAD with src/wad/wadfile.ts, decodes every
 * lump strictly (signed −1-safe) and throws typed MapCheckError on: size
 * indivisibility, vertex/side/sector/seg/node index out of range, two-sided
 * bit vs sidenum[1] mismatch, seg direction rule violated, zero-seg
 * subsectors, mixed-sector subsectors, nodes ≠ subsectors − 1, bad child
 * refs (NF_SUBSECTOR handled), short REJECT, and ANY blockmap deviation
 * from "line listed in exactly the blocks its bbox touches, −1-terminated,
 * no duplicates, union == all lines".
 *
 * Deterministic: same spec ⇒ byte-identical WAD. No Math.random, no clock.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { WadFile } from '../../src/wad/wadfile';
import { SEG_TWOSIDED, buildGridNodes, NF_SUBSECTOR } from './bspSplit';
import { WadBuilder } from './wadWriter';
import { patch2x2, synthFlat, synthPnames, synthTexture1 } from './smallWads';

// ---------------------------------------------------------------------------
// Constants (R01 §5 flags, §13 block size; fixture content names)
// ---------------------------------------------------------------------------

/** ML_TWOSIDED (R01 §5): back sidedef exists. */
export const ML_TWOSIDED = 0x004;
/** ML_SECRET (R01 §5): automap-solid; monsters never use the line (R05 §1.2). */
export const ML_SECRET = 0x020;
/** ML_SOUNDBLOCK (R05/p_enemy.c P_RecursiveSound sound-blocked hop). */
export const ML_SOUNDBLOCK = 0x002;
/** MAPBLOCKSIZE: 128 map units per blockmap block (R01 §13). */
export const BLOCK_SIZE = 128;
/** Blockmap origin inset below the minimum vertex (task NOTE). */
export const BLOCKMAP_INSET = 64;
/** Hard coordinate bound (task NOTE). */
export const COORD_LIMIT = 8192;

/** Void sector index: dummy sector behind every void-facing wall. */
export const VOID_SECTOR = 0;
/** Void floor/ceiling height (below any room → geometry-closed). */
export const VOID_HEIGHT = -128;

export const FLAT_FLOOR = 'FIXFLAT0';
export const FLAT_CEIL = 'FIXFLAT1';
export const TEX_WALL = 'FIXWALL0';
export const TEX_DOOR = 'DOORFIX0';

/** Default linedef special on a door gap (vanilla "regular door", W1). */
export const DEFAULT_DOOR_SPECIAL = 1;

// Room defaults (task: optional per-room heights/flats/light/special).
export const DEFAULT_FLOOR_HEIGHT = 0;
export const DEFAULT_CEILING_HEIGHT = 128;
export const DEFAULT_LIGHT = 192;
/** Doomednum of the default "dot" item thing. */
export const DOT_THING = 2035;
/** Skill 1/2/3 spawn bits (R01 §4). */
const SPAWN_FLAGS = 0x1 | 0x2 | 0x4;

const THINGS_REC = 10;
const LINEDEFS_REC = 14;
const SIDEDEFS_REC = 30;
const VERTEXES_REC = 4;
const SECTORS_REC = 26;
/** The 10 data lumps following a map marker, BY ORDER (R01 §3). */
export const MAP_LUMP_ORDER = [
  'THINGS',
  'LINEDEFS',
  'SIDEDEFS',
  'VERTEXES',
  'SEGS',
  'SSECTORS',
  'NODES',
  'SECTORS',
  'REJECT',
  'BLOCKMAP'
] as const;

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export interface RectRoomSpec {
  /** Min corner (integers, |coord| ≤ 8192). */
  readonly x: number;
  readonly y: number;
  /** Positive integer extent. */
  readonly w: number;
  readonly h: number;
  readonly floorHeight?: number; // default 0
  readonly ceilingHeight?: number; // default 128
  readonly floorFlat?: string; // default FIXFLAT0
  readonly ceilingFlat?: string; // default FIXFLAT1
  readonly lightLevel?: number; // default 192, 0..255
  readonly special?: number; // default 0
  readonly tag?: number; // default 0
  /** Sidedef 0 (room-side) toptexture on VOID-facing edges. Default FIXWALL0. */
  readonly wallTexture?: string;
}

/** An explicit door gap: axis-aligned segment on a room-room shared edge. */
export interface DoorGapSpec {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Linedef special; default 1. */
  readonly special?: number;
  readonly tag?: number; // default 0
  /** true ⇒ ML_SECRET flag on the line (M6-02; default false ⇒ byte-identical). */
  readonly secret?: boolean;
  /** M8-01: true ⇒ ML_SOUNDBLOCK on the line (default false ⇒ byte-identical). */
  readonly soundBlock?: boolean;
}

/**
 * M6-02 — a specials/tag LINE on any room boundary edge (room-room or
 * room-void). Splits the edge like a door gap; emits RAW int16 special/tag
 * into the LINEDEFS slots (R01 §5 — DOOM1 format, no args, no packing).
 * `texture` (e.g. a switch marker name) lands on the FRONT side's mid slot
 * only; on a room-room edge front = the earlier-indexed room, on a room-void
 * edge front = the room side. `secret` sets ML_SECRET.
 */
export interface LineTriggerSpec {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Raw linedef special (R05 §2 census; default 0 = plain tagged/secret line). */
  readonly special?: number;
  readonly tag?: number; // default 0
  /** Side-0 mid-texture marker (switch/door name); default none. */
  readonly texture?: string;
  readonly secret?: boolean; // default false
  /** M8-01: true ⇒ ML_SOUNDBLOCK on the line (default false ⇒ byte-identical). */
  readonly soundBlock?: boolean; // default false
}

export interface ThingSpec {
  readonly x: number;
  readonly y: number;
  /** Degrees (0=E 90=N). */
  readonly angle?: number;
  readonly type: number;
  /** Spawn flag bits; default 0x7 (all skills). */
  readonly flags?: number;
}

export interface RectMapSpec {
  readonly rooms: readonly RectRoomSpec[];
  readonly doors?: readonly DoorGapSpec[];
  /** M6-02: specials/tag lines on room boundary edges (optional; absent ⇒
   * byte-identical output to the pre-M6 generator). */
  readonly triggers?: readonly LineTriggerSpec[];
  /** Replaces the default players 1-4 + dot list entirely when present. */
  readonly things?: readonly ThingSpec[];
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class MapSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Every violation reported by mapSelfCheck. */
export class MapCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// ---------------------------------------------------------------------------
// Compilation: spec → plain record tables
// ---------------------------------------------------------------------------

interface BuiltSidedef {
  top: string;
  bottom: string;
  mid: string;
  sector: number;
}

interface BuiltLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  flags: number;
  special: number;
  tag: number;
  sides: [BuiltSidedef, BuiltSidedef];
}

interface BuiltThing {
  x: number;
  y: number;
  angle: number;
  type: number;
  flags: number;
}

interface BuiltSector {
  floor: number;
  ceil: number;
  floorFlat: string;
  ceilFlat: string;
  light: number;
  special: number;
  tag: number;
}

interface CompiledSpec {
  things: BuiltThing[];
  lines: BuiltLine[];
  sectors: BuiltSector[];
}

function checkInt(v: number, what: string): void {
  if (!Number.isInteger(v) || v < -COORD_LIMIT || v > COORD_LIMIT) {
    throw new MapSpecError(`${what} must be an integer within ±${COORD_LIMIT}, got ${v}`);
  }
}

function checkName(name: string, what: string): void {
  if (name.length === 0 || name.length > 8) {
    throw new MapSpecError(`${what} must be 1..8 chars, got ${JSON.stringify(name)}`);
  }
}

function validateSpec(spec: RectMapSpec): void {
  if (!Array.isArray(spec.rooms) || spec.rooms.length === 0) {
    throw new MapSpecError('spec.rooms must contain at least one room');
  }
  spec.rooms.forEach((r, i) => {
    checkInt(r.x, `room ${i}.x`);
    checkInt(r.y, `room ${i}.y`);
    checkInt(r.w, `room ${i}.w`);
    checkInt(r.h, `room ${i}.h`);
    if (r.w <= 0 || r.h <= 0) throw new MapSpecError(`room ${i} needs w,h > 0`);
    for (const key of ['floorHeight', 'ceilingHeight'] as const) {
      const v = r[key];
      if (v !== undefined) checkInt(v, `room ${i}.${key}`);
    }
    if (r.floorFlat !== undefined) checkName(r.floorFlat, `room ${i}.floorFlat`);
    if (r.ceilingFlat !== undefined) checkName(r.ceilingFlat, `room ${i}.ceilingFlat`);
    if (r.wallTexture !== undefined) checkName(r.wallTexture, `room ${i}.wallTexture`);
    if (r.lightLevel !== undefined && !(Number.isInteger(r.lightLevel) && r.lightLevel >= 0 && r.lightLevel <= 255)) {
      throw new MapSpecError(`room ${i}.lightLevel must be 0..255, got ${r.lightLevel}`);
    }
  });
  for (let i = 0; i < spec.rooms.length; i++) {
    for (let j = i + 1; j < spec.rooms.length; j++) {
      const a = spec.rooms[i]!;
      const b = spec.rooms[j]!;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) throw new MapSpecError(`rooms ${i} and ${j} overlap in area`);
    }
  }
  (spec.doors ?? []).forEach((d, i) => {
    checkInt(d.x1, `door ${i}.x1`);
    checkInt(d.y1, `door ${i}.y1`);
    checkInt(d.x2, `door ${i}.x2`);
    checkInt(d.y2, `door ${i}.y2`);
    if (d.x1 === d.x2 && d.y1 === d.y2) {
      throw new MapSpecError(`door ${i} is degenerate`);
    }
    if (d.x1 !== d.x2 && d.y1 !== d.y2) {
      throw new MapSpecError(`door ${i} must be axis-aligned`);
    }
  });
  (spec.triggers ?? []).forEach((t, i) => {
    checkInt(t.x1, `trigger ${i}.x1`);
    checkInt(t.y1, `trigger ${i}.y1`);
    checkInt(t.x2, `trigger ${i}.x2`);
    checkInt(t.y2, `trigger ${i}.y2`);
    if (t.x1 === t.x2 && t.y1 === t.y2) {
      throw new MapSpecError(`trigger ${i} is degenerate`);
    }
    if (t.x1 !== t.x2 && t.y1 !== t.y2) {
      throw new MapSpecError(`trigger ${i} must be axis-aligned`);
    }
    if (
      t.special !== undefined &&
      !(Number.isInteger(t.special) && t.special >= 0 && t.special <= 32767)
    ) {
      throw new MapSpecError(`trigger ${i}.special must be int16, got ${t.special}`);
    }
    if (
      t.tag !== undefined &&
      !(Number.isInteger(t.tag) && t.tag >= -32768 && t.tag <= 32767)
    ) {
      throw new MapSpecError(`trigger ${i}.tag must be int16, got ${t.tag}`);
    }
    if (t.texture !== undefined) checkName(t.texture, `trigger ${i}.texture`);
  });
}

/** Room boundary edges in CLOCKWISE order ⇒ front (right of travel) faces inward. */
interface RoomEdge {
  axis: 'v' | 'h';
  /** Wall line coordinate (x for 'v', y for 'h'). */
  c: number;
  /** Span along the wall line. */
  a0: number;
  a1: number;
  /** INWARD unit normal (into the room). */
  nx: number;
  ny: number;
  /** Travel direction (v1→v2) of lines generated on this edge. */
  dx: number;
  dy: number;
}

function roomEdges(r: RectRoomSpec): RoomEdge[] {
  return [
    { axis: 'v', c: r.x, a0: r.y, a1: r.y + r.h, nx: 1, ny: 0, dx: 0, dy: 1 },
    { axis: 'h', c: r.y + r.h, a0: r.x, a1: r.x + r.w, nx: 0, ny: -1, dx: 1, dy: 0 },
    { axis: 'v', c: r.x + r.w, a0: r.y, a1: r.y + r.h, nx: -1, ny: 0, dx: 0, dy: -1 },
    { axis: 'h', c: r.y, a0: r.x, a1: r.x + r.w, nx: 0, ny: 1, dx: -1, dy: 0 }
  ];
}

function doorLine(d: Pick<DoorGapSpec, 'x1' | 'y1' | 'x2' | 'y2'>): {
  axis: 'v' | 'h';
  c: number;
  a0: number;
  a1: number;
} {
  return d.x1 === d.x2
    ? { axis: 'v', c: d.x1, a0: Math.min(d.y1, d.y2), a1: Math.max(d.y1, d.y2) }
    : { axis: 'h', c: d.y1, a0: Math.min(d.x1, d.x2), a1: Math.max(d.x1, d.x2) };
}

/** Overlapping neighbor room (index + interval) on the OUTWARD side of edge e. */
function edgeOverlaps(rooms: readonly RectRoomSpec[], i: number, e: RoomEdge) {
  const out: { room: number; s: number; t: number }[] = [];
  rooms.forEach((r, j) => {
    if (j === i) return;
    let adjacent = false;
    if (e.axis === 'v') {
      // Outward side: x = e.c - nx (a room edge exactly on this line).
      adjacent = e.nx > 0 ? r.x + r.w === e.c : r.x === e.c;
      const s = Math.max(e.a0, r.y);
      const t = Math.min(e.a1, r.y + r.h);
      if (adjacent && s < t) out.push({ room: j, s, t });
    } else {
      adjacent = e.ny > 0 ? r.y + r.h === e.c : r.y === e.c;
      const s = Math.max(e.a0, r.x);
      const t = Math.min(e.a1, r.x + r.w);
      if (adjacent && s < t) out.push({ room: j, s, t });
    }
  });
  return out;
}

function compileSpec(spec: RectMapSpec): CompiledSpec {
  validateSpec(spec);
  const rooms = spec.rooms;

  // Door validity + door lookup per (axis, line coord, interval).
  const doors = (spec.doors ?? []).map((d, i) => ({ ...doorLine(d), spec: d, index: i }));
  const matchedDoors = new Set<number>();
  rooms.forEach((r, i) => {
    for (const e of roomEdges(r)) {
      const overlaps = edgeOverlaps(rooms, i, e);
      for (const d of doors) {
        if (d.axis !== e.axis || d.c !== e.c || d.a0 < e.a0 || d.a1 > e.a1) continue;
        const mid = (d.a0 + d.a1) / 2;
        if (!overlaps.some((o) => o.s <= mid && mid < o.t)) continue; // not on this edge
        matchedDoors.add(d.index);
      }
    }
  });
  for (const d of doors) {
    if (!matchedDoors.has(d.index)) {
      throw new MapSpecError(
        `door ${d.index} must lie on a room-room shared edge ` +
          `(${d.axis} line at ${d.c}, span [${d.a0}, ${d.a1}])`
      );
    }
  }
  // M6-02 triggers: same mechanism, but a room-VOID edge is legal too (a
  // switch on a solid wall). Must sit inside ONE room edge span.
  const trigs = (spec.triggers ?? []).map((t, i) => ({ ...doorLine(t), spec: t, index: i }));
  const matchedTrigs = new Set<number>();
  rooms.forEach((r) => {
    for (const e of roomEdges(r)) {
      for (const t of trigs) {
        if (t.axis !== e.axis || t.c !== e.c) continue;
        if (t.a0 < e.a0 || t.a1 > e.a1) continue;
        matchedTrigs.add(t.index);
      }
    }
  });
  for (const t of trigs) {
    if (!matchedTrigs.has(t.index)) {
      throw new MapSpecError(
        `trigger ${t.index} must lie inside one room boundary edge ` +
          `(${t.axis} line at ${t.c}, span [${t.a0}, ${t.a1}])`
      );
    }
  }
  // No two doors may overlap on the same wall line.
  for (let a = 0; a < doors.length; a++) {
    for (let b = a + 1; b < doors.length; b++) {
      const da = doors[a]!;
      const db = doors[b]!;
      if (da.axis === db.axis && da.c === db.c && Math.min(da.a1, db.a1) > Math.max(da.a0, db.a0)) {
        throw new MapSpecError(`doors ${a} and ${b} overlap on the same wall line`);
      }
    }
  }
  // …and no door/trigger or trigger/trigger overlap either (M6-02).
  for (const d of doors) {
    for (const t of trigs) {
      if (d.axis === t.axis && d.c === t.c && Math.min(d.a1, t.a1) > Math.max(d.a0, t.a0)) {
        throw new MapSpecError(`door ${d.index} and trigger ${t.index} overlap on the same wall line`);
      }
    }
  }
  for (let a = 0; a < trigs.length; a++) {
    for (let b = a + 1; b < trigs.length; b++) {
      const ta = trigs[a]!;
      const tb = trigs[b]!;
      if (ta.axis === tb.axis && ta.c === tb.c && Math.min(ta.a1, tb.a1) > Math.max(ta.a0, tb.a0)) {
        throw new MapSpecError(`triggers ${a} and ${b} overlap on the same wall line`);
      }
    }
  }

  const sectors: BuiltSector[] = [
    {
      floor: VOID_HEIGHT,
      ceil: VOID_HEIGHT,
      floorFlat: FLAT_FLOOR,
      ceilFlat: FLAT_FLOOR,
      light: 0,
      special: 0,
      tag: 0
    }
  ];
  for (const r of rooms) {
    sectors.push({
      floor: r.floorHeight ?? DEFAULT_FLOOR_HEIGHT,
      ceil: r.ceilingHeight ?? DEFAULT_CEILING_HEIGHT,
      floorFlat: r.floorFlat ?? FLAT_FLOOR,
      ceilFlat: r.ceilingFlat ?? FLAT_CEIL,
      light: r.lightLevel ?? DEFAULT_LIGHT,
      special: r.special ?? 0,
      tag: r.tag ?? 0
    });
  }

  const lines: BuiltLine[] = [];
  const seen = new Set<string>();
  rooms.forEach((r, i) => {
    for (const e of roomEdges(r)) {
      const overlaps = edgeOverlaps(rooms, i, e);
      const cuts = new Set<number>([e.a0, e.a1]);
      for (const o of overlaps) {
        cuts.add(o.s);
        cuts.add(o.t);
      }
      const edgeDoors = doors.filter(
        (d) => d.axis === e.axis && d.c === e.c && d.a0 >= e.a0 && d.a1 <= e.a1
      );
      for (const d of edgeDoors) {
        cuts.add(d.a0);
        cuts.add(d.a1);
      }
      const edgeTrigs = trigs.filter(
        (t) => t.axis === e.axis && t.c === e.c && t.a0 >= e.a0 && t.a1 <= e.a1
      );
      for (const t of edgeTrigs) {
        cuts.add(t.a0);
        cuts.add(t.a1);
      }
      const pts = [...cuts].sort((a, b) => a - b);
      for (let p = 0; p + 1 < pts.length; p++) {
        const a0 = pts[p]!;
        const a1 = pts[p + 1]!;
        if (a1 <= a0) continue;
        const mid = (a0 + a1) / 2;
        const key =
          e.axis === 'v'
            ? `v:${e.c}:${Math.min(a0, a1)}:${Math.max(a0, a1)}`
            : `h:${e.c}:${Math.min(a0, a1)}:${Math.max(a0, a1)}`;
        if (seen.has(key)) continue; // shared edge already emitted by the other room
        seen.add(key);
        const neighbor = overlaps.find((o) => o.s <= mid && mid < o.t)?.room ?? null;
        const door = edgeDoors.find((d) => d.a0 <= mid && mid < d.a1);
        const trig = edgeTrigs.find((t) => t.a0 <= mid && mid < t.a1);
        if (door && neighbor === null) {
          throw new MapSpecError(`door ${door.index} on a room-void edge of room ${i}`);
        }
        // Travel direction = the room's clockwise edge direction, so the
        // front side (right of travel) always faces room i.
        const forward = e.dx + e.dy > 0;
        const pt = (t: number): [number, number] =>
          e.axis === 'v' ? [e.c, t] : [t, e.c];
        const [v1x, v1y] = pt(forward ? a0 : a1);
        const [v2x, v2y] = pt(forward ? a1 : a0);
        const front: BuiltSidedef = { top: '', bottom: '', mid: '', sector: i + 1 };
        const back: BuiltSidedef = {
          top: '',
          bottom: '',
          mid: '',
          sector: neighbor === null ? VOID_SECTOR : neighbor + 1
        };
        if (neighbor === null) front.top = r.wallTexture ?? TEX_WALL;
        if (door) {
          front.mid = TEX_DOOR;
          back.mid = TEX_DOOR;
        } else if (trig?.spec.texture) {
          // Side-0-only marker (switch texture etc.): vanilla switch scans
          // read side 0's slots only (R05 §12), so the back stays clear.
          front.mid = trig.spec.texture;
        }
        const secretLine = (door?.spec.secret ?? false) || (trig?.spec.secret ?? false);
        const soundBlockLine = (door?.spec.soundBlock ?? false) || (trig?.spec.soundBlock ?? false);
        lines.push({
          x1: v1x,
          y1: v1y,
          x2: v2x,
          y2: v2y,
          flags: ML_TWOSIDED | (secretLine ? ML_SECRET : 0) | (soundBlockLine ? ML_SOUNDBLOCK : 0),
          special: door
            ? door.spec.special ?? DEFAULT_DOOR_SPECIAL
            : trig?.spec.special ?? 0,
          tag: door ? door.spec.tag ?? 0 : trig?.spec.tag ?? 0,
          sides: [front, back]
        });
      }
    }
  });

  let things: BuiltThing[];
  if (spec.things) {
    things = spec.things.map((t, i) => {
      checkInt(t.x, `thing ${i}.x`);
      checkInt(t.y, `thing ${i}.y`);
      return {
        x: t.x,
        y: t.y,
        angle: t.angle ?? 0,
        type: t.type,
        flags: t.flags ?? SPAWN_FLAGS
      };
    });
  } else {
    const r0 = rooms[0]!;
    const cx = r0.x + (r0.w >> 1);
    const cy = r0.y + (r0.h >> 1);
    things = [1, 2, 3, 4, DOT_THING].map((type) => ({
      x: cx,
      y: cy,
      angle: 0,
      type,
      flags: SPAWN_FLAGS
    }));
  }
  return { things, lines, sectors };
}

// ---------------------------------------------------------------------------
// Lump encoders
// ---------------------------------------------------------------------------

function encodeThings(things: BuiltThing[]): Uint8Array {
  const out = new Uint8Array(things.length * THINGS_REC);
  const v = new DataView(out.buffer);
  things.forEach((t, i) => {
    const o = i * THINGS_REC;
    v.setInt16(o + 0, t.x, true);
    v.setInt16(o + 2, t.y, true);
    v.setInt16(o + 4, t.angle, true);
    v.setInt16(o + 6, t.type, true);
    v.setInt16(o + 8, t.flags, true);
  });
  return out;
}

function encodeVertices(vertices: readonly { x: number; y: number }[]): Uint8Array {
  const out = new Uint8Array(vertices.length * VERTEXES_REC);
  const v = new DataView(out.buffer);
  vertices.forEach((p, i) => {
    v.setInt16(i * VERTEXES_REC, p.x, true);
    v.setInt16(i * VERTEXES_REC + 2, p.y, true);
  });
  return out;
}

function padName(dst: Uint8Array, at: number, name: string): void {
  const upper = name.toUpperCase();
  for (let c = 0; c < upper.length; c++) dst[at + c] = upper.charCodeAt(c); // rest NUL
}

/**
 * LINEDEFS + SIDEDEFS. Vertices are bspSplit's deduped table (seg indices
 * reference it); a line endpoint missing there (defensive; can't happen for
 * grid maps) is appended. Sidenum convention: sidenum[k] = 2*line + k (every
 * generated line is two-sided ⇒ never −1).
 */
function encodeLines(
  lines: BuiltLine[],
  vertices: { x: number; y: number }[]
): { linedefs: Uint8Array; sidedefs: Uint8Array } {
  const vIndex = new Map<string, number>();
  vertices.forEach((p, i) => vIndex.set(`${p.x},${p.y}`, i));
  const vertexOf = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let idx = vIndex.get(key);
    if (idx === undefined) {
      idx = vertices.length;
      vertices.push({ x, y });
      vIndex.set(key, idx);
    }
    return idx;
  };
  const linedefs = new Uint8Array(lines.length * LINEDEFS_REC);
  const sidedefs = new Uint8Array(lines.length * 2 * SIDEDEFS_REC);
  const lv = new DataView(linedefs.buffer);
  const sv = new DataView(sidedefs.buffer);
  lines.forEach((l, i) => {
    const o = i * LINEDEFS_REC;
    lv.setInt16(o + 0, vertexOf(l.x1, l.y1), true);
    lv.setInt16(o + 2, vertexOf(l.x2, l.y2), true);
    lv.setUint16(o + 4, l.flags, true);
    lv.setInt16(o + 6, l.special, true);
    lv.setInt16(o + 8, l.tag, true);
    lv.setInt16(o + 10, 2 * i, true);
    lv.setInt16(o + 12, 2 * i + 1, true);
    l.sides.forEach((s, k) => {
      const so = (2 * i + k) * SIDEDEFS_REC;
      sv.setInt16(so + 0, 0, true); // textureoffset
      sv.setInt16(so + 2, 0, true); // rowoffset
      padName(sidedefs, so + 4, s.top);
      padName(sidedefs, so + 12, s.bottom);
      padName(sidedefs, so + 20, s.mid);
      sv.setInt16(so + 28, s.sector, true);
    });
  });
  return { linedefs, sidedefs };
}

function encodeSectors(sectors: BuiltSector[]): Uint8Array {
  const out = new Uint8Array(sectors.length * SECTORS_REC);
  const v = new DataView(out.buffer);
  sectors.forEach((s, i) => {
    const o = i * SECTORS_REC;
    v.setInt16(o + 0, s.floor, true);
    v.setInt16(o + 2, s.ceil, true);
    padName(out, o + 4, s.floorFlat);
    padName(out, o + 12, s.ceilFlat);
    v.setInt16(o + 20, s.light, true);
    v.setInt16(o + 22, s.special, true);
    v.setInt16(o + 24, s.tag, true);
  });
  return out;
}

/** REJECT: ceil(n²/8) bytes, all zero = fully visible (documented choice). */
function encodeReject(numSectors: number): Uint8Array {
  return new Uint8Array(Math.ceil((numSectors * numSectors) / 8));
}

/** Line indices for every block a (possibly degenerate) bbox touches. */
function blocksTouched(
  minx: number,
  miny: number,
  maxx: number,
  maxy: number,
  originx: number,
  originy: number,
  width: number,
  height: number
): number[] {
  const bx0 = Math.max(0, Math.floor((minx - originx) / BLOCK_SIZE));
  const bx1 = Math.min(width - 1, Math.floor((maxx - originx) / BLOCK_SIZE));
  const by0 = Math.max(0, Math.floor((miny - originy) / BLOCK_SIZE));
  const by1 = Math.min(height - 1, Math.floor((maxy - originy) / BLOCK_SIZE));
  const out: number[] = [];
  for (let by = by0; by <= by1; by++) {
    for (let bx = bx0; bx <= bx1; bx++) out.push(by * width + bx);
  }
  return out;
}

/**
 * BLOCKMAP (R01 §13): origin = minVertex − 64 per axis, word-addressed
 * offsets from lump start, line lists of int16 ending in −1, list region
 * immediately after the offset table, empty blocks share one bare [−1].
 */
function encodeBlockmap(lines: BuiltLine[], vertices: { x: number; y: number }[]): Uint8Array {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const p of vertices) {
    minx = Math.min(minx, p.x);
    miny = Math.min(miny, p.y);
    maxx = Math.max(maxx, p.x);
    maxy = Math.max(maxy, p.y);
  }
  const originx = minx - BLOCKMAP_INSET;
  const originy = miny - BLOCKMAP_INSET;
  const width = Math.floor((maxx - originx) / BLOCK_SIZE) + 1;
  const height = Math.floor((maxy - originy) / BLOCK_SIZE) + 1;
  const nBlocks = width * height;

  const lists: number[][] = Array.from({ length: nBlocks }, () => []);
  lines.forEach((l, i) => {
    for (const b of blocksTouched(
      Math.min(l.x1, l.x2),
      Math.min(l.y1, l.y2),
      Math.max(l.x1, l.x2),
      Math.max(l.y1, l.y2),
      originx,
      originy,
      width,
      height
    )) {
      lists[b]!.push(i);
    }
  });

  // Assemble words: 4 header + offset table + list region (empty blocks all
  // point at one shared terminator appended first).
  const words: number[] = [];
  const u16 = (w: number) => w & 0xffff;
  words.push(u16(originx), u16(originy), u16(width), u16(height));
  const tableStart = 4;
  const nWordsHeader = tableStart + nBlocks;
  for (let b = 0; b < nBlocks; b++) words.push(0); // offset placeholders
  const offsets: number[] = [];
  let cursor = nWordsHeader;
  const sharedPos = cursor; // one shared bare [−1] terminator for empty blocks
  words.push(u16(-1));
  cursor += 1;
  for (const list of lists) {
    if (list.length === 0) {
      offsets.push(sharedPos);
      continue;
    }
    offsets.push(cursor);
    for (const li of list) words.push(u16(li));
    words.push(u16(-1));
    cursor += list.length + 1;
  }
  for (let b = 0; b < nBlocks; b++) words[tableStart + b] = offsets[b]!;

  const out = new Uint8Array(words.length * 2);
  const v = new DataView(out.buffer);
  words.forEach((w, i) => v.setUint16(i * 2, w, true));
  return out;
}

// ---------------------------------------------------------------------------
// Public API: build the fixture WAD
// ---------------------------------------------------------------------------

/** Compile + encode + BSP: the 10 map lumps (order = MAP_LUMP_ORDER). */
export function buildMapLumps(
  spec: RectMapSpec
): { name: string; data: Uint8Array }[] {
  const { things, lines, sectors } = compileSpec(spec);
  const worldBbox: [number, number, number, number] = [
    Math.min(...spec.rooms.map((r) => r.x)),
    Math.min(...spec.rooms.map((r) => r.y)),
    Math.max(...spec.rooms.map((r) => r.x + r.w)),
    Math.max(...spec.rooms.map((r) => r.y + r.h))
  ];
  const nodes = buildGridNodes({
    segments: lines.map((l, i) => ({
      x1: l.x1,
      y1: l.y1,
      x2: l.x2,
      y2: l.y2,
      linedef: i,
      flags: SEG_TWOSIDED
    })),
    sectorCount: sectors.length,
    worldBbox
  });
  const vertices = [...nodes.vertices];
  const { linedefs, sidedefs } = encodeLines(lines, vertices);
  return [
    { name: 'THINGS', data: encodeThings(things) },
    { name: 'LINEDEFS', data: linedefs },
    { name: 'SIDEDEFS', data: sidedefs },
    { name: 'VERTEXES', data: encodeVertices(vertices) },
    { name: 'SEGS', data: nodes.segs },
    { name: 'SSECTORS', data: nodes.ssectors },
    { name: 'NODES', data: nodes.nodes },
    { name: 'SECTORS', data: encodeSectors(sectors) },
    { name: 'REJECT', data: encodeReject(sectors.length) },
    { name: 'BLOCKMAP', data: encodeBlockmap(lines, vertices) }
  ];
}

/**
 * Full fixture WAD: graphics lumps (PNAMES/TEXTURE1 + flats + patches, built
 * from the smallWads helpers), then `name` marker + the 10 map lumps.
 * Deterministic; returns raw bytes.
 */
export function buildFixtureMapWad(spec: RectMapSpec, name = 'FIXMAP'): Uint8Array {
  const mapName = name.toUpperCase();
  if (mapName.length === 0 || mapName.length > 8) {
    throw new MapSpecError(`bad map name ${JSON.stringify(name)}`);
  }
  const mapLumps = buildMapLumps(spec);
  const wad = new WadBuilder('IWAD');
  wad.addLump(
    'TEXTURE1',
    synthTexture1([
      { name: TEX_WALL, width: 64, height: 64, patches: [[0, 0, 0], [32, 0, 1]] },
      { name: TEX_DOOR, width: 64, height: 64, patches: [[0, 0, 1]] }
    ])
  );
  wad.addLump('PNAMES', synthPnames(['FIXP0', 'FIXP1']));
  wad.addLumpMarker('F_START');
  wad.addLump('FIXFLAT0', synthFlat(0xf100));
  wad.addLump('FIXFLAT1', synthFlat(0xf101));
  wad.addLumpMarker('F_END');
  wad.addLumpMarker('P_START');
  wad.addLump('FIXP0', patch2x2(0x5e0));
  wad.addLump('FIXP1', patch2x2(0x5e1));
  wad.addLumpMarker('P_END');
  wad.addLumpMarker(mapName); // 0-size marker DIRECTLY before the data lumps
  for (const lump of mapLumps) wad.addLump(lump.name, lump.data);
  return wad.build();
}

// ---------------------------------------------------------------------------
// mapSelfCheck: strict inline reader + structural invariants
// ---------------------------------------------------------------------------

export interface MapCheckReport {
  numThings: number;
  numLines: number;
  numSidedefs: number;
  numVertexes: number;
  numSegs: number;
  numSubsectors: number;
  numNodes: number;
  numSectors: number;
  rejectBytes: number;
  blockmap: { originx: number; originy: number; width: number; height: number };
}

function fail(msg: string): never {
  throw new MapCheckError(msg);
}

function requireSize(bytes: Uint8Array, rec: number, lump: string): DataView {
  if (bytes.length % rec !== 0) {
    fail(`${lump} length ${bytes.length} not divisible by record size ${rec}`);
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Re-parse `wadBytes`, resolve the 10 lumps BY INDEX from `mapName`, and
 * verify every structural invariant listed at the top of this file. Throws
 * MapCheckError on the first violation; returns the counts otherwise.
 */
export function mapSelfCheck(wadBytes: Uint8Array, mapName = 'FIXMAP'): MapCheckReport {
  const wad = WadFile.parse(wadBytes.buffer as ArrayBuffer);
  const marker = wad.lumpNumByName(mapName);
  if (marker < 0) fail(`map marker '${mapName}' not present`);
  const lump = (k: number): Uint8Array => {
    // BY INDEX (R01 §15.1); a marker with a truncated lump set is an error.
    try {
      return wad.readLump(marker + k);
    } catch (e) {
      fail(`map '${mapName}' lump ${MAP_LUMP_ORDER[k - 1]} unreadable: ${String(e)}`);
    }
  };
  const thingsV = requireSize(lump(1), THINGS_REC, 'THINGS');
  const linesV = requireSize(lump(2), LINEDEFS_REC, 'LINEDEFS');
  const sidesV = requireSize(lump(3), SIDEDEFS_REC, 'SIDEDEFS');
  const vertsV = requireSize(lump(4), VERTEXES_REC, 'VERTEXES');
  const segsV = requireSize(lump(5), 12, 'SEGS');
  const ssecV = requireSize(lump(6), 4, 'SSECTORS');
  const nodesV = requireSize(lump(7), 28, 'NODES');
  const sectV = requireSize(lump(8), SECTORS_REC, 'SECTORS');
  const reject = lump(9);
  const blockmap = lump(10);

  const numThings = thingsV.byteLength / THINGS_REC;
  const numLines = linesV.byteLength / LINEDEFS_REC;
  const numSidedefs = sidesV.byteLength / SIDEDEFS_REC;
  const numVertexes = vertsV.byteLength / VERTEXES_REC;
  const numSegs = segsV.byteLength / 12;
  const numSubsectors = ssecV.byteLength / 4;
  const numNodes = nodesV.byteLength / 28;
  const numSectors = sectV.byteLength / SECTORS_REC;

  // --- linedefs: indices, −1 sentinels, two-sided consistency ---------------
  for (let i = 0; i < numLines; i++) {
    const o = i * LINEDEFS_REC;
    const v1 = linesV.getInt16(o, true);
    const v2 = linesV.getInt16(o + 2, true);
    if (v1 < 0 || v1 >= numVertexes || v2 < 0 || v2 >= numVertexes) {
      fail(`linedef ${i} vertex refs ${v1}/${v2} outside [0, ${numVertexes})`);
    }
    const flags = linesV.getUint16(o + 4, true);
    const s0 = linesV.getInt16(o + 10, true);
    const s1 = linesV.getInt16(o + 12, true);
    if (s0 < 0 || s0 >= numSidedefs) fail(`linedef ${i} sidenum[0]=${s0} invalid`);
    if (s1 >= numSidedefs || s1 < -1) fail(`linedef ${i} sidenum[1]=${s1} invalid`);
    if ((flags & ML_TWOSIDED) !== 0 && s1 < 0) {
      fail(`linedef ${i} sets ML_TWOSIDED but sidenum[1] is ${s1}`);
    }
    if ((flags & ML_TWOSIDED) === 0 && s1 >= 0) {
      fail(`linedef ${i} has sidenum[1]=${s1} without ML_TWOSIDED`);
    }
  }
  // --- sidedefs: sector refs -------------------------------------------------
  for (let i = 0; i < numSidedefs; i++) {
    const s = sidesV.getInt16(i * SIDEDEFS_REC + 28, true);
    if (s < 0 || s >= numSectors) fail(`sidedef ${i} sector ${s} outside [0, ${numSectors})`);
  }
  // --- segs: vertices, linedef refs, direction rule --------------------------
  const sectorOfSide = (line: number, side: number): number =>
    sidesV.getInt16(
      linesV.getInt16(line * LINEDEFS_REC + 10 + side * 2, true) * SIDEDEFS_REC + 28,
      true
    );
  for (let i = 0; i < numSegs; i++) {
    const o = i * 12;
    const v1 = segsV.getInt16(o, true);
    const v2 = segsV.getInt16(o + 2, true);
    if (v1 < 0 || v1 >= numVertexes || v2 < 0 || v2 >= numVertexes) {
      fail(`seg ${i} vertex refs ${v1}/${v2} outside [0, ${numVertexes})`);
    }
    const ld = segsV.getInt16(o + 6, true);
    const side = segsV.getInt16(o + 8, true);
    if (ld >= numLines || ld < -1) fail(`seg ${i} linedef ${ld} outside [-1, ${numLines})`);
    if (side !== 0 && side !== 1) fail(`seg ${i} side ${side} not 0/1`);
    if (ld >= 0) {
      const s = side === 0 ? linesV.getInt16(ld * LINEDEFS_REC + 10, true) : linesV.getInt16(ld * LINEDEFS_REC + 12, true);
      if (s < 0) fail(`seg ${i} references back side of one-sided linedef ${ld}`);
      const sdx = Math.sign(vertsV.getInt16(v2 * 4, true) - vertsV.getInt16(v1 * 4, true));
      const sdy = Math.sign(vertsV.getInt16(v2 * 4 + 2, true) - vertsV.getInt16(v1 * 4 + 2, true));
      const lx1 = vertsV.getInt16(linesV.getInt16(ld * LINEDEFS_REC, true) * 4, true);
      const ly1 = vertsV.getInt16(linesV.getInt16(ld * LINEDEFS_REC, true) * 4 + 2, true);
      const lx2 = vertsV.getInt16(linesV.getInt16(ld * LINEDEFS_REC + 2, true) * 4, true);
      const ly2 = vertsV.getInt16(linesV.getInt16(ld * LINEDEFS_REC + 2, true) * 4 + 2, true);
      const ldx = Math.sign(lx2 - lx1);
      const ldy = Math.sign(ly2 - ly1);
      if (sdx * ldx + sdy * ldy !== (side === 0 ? 1 : -1)) {
        fail(`seg ${i} violates the R01 §8 direction rule on linedef ${ld} side ${side}`);
      }
      // collinearity: seg v1 on the linedef line
      if ((vertsV.getInt16(v1 * 4, true) - lx1) * (ly2 - ly1) !== (vertsV.getInt16(v1 * 4 + 2, true) - ly1) * (lx2 - lx1)) {
        fail(`seg ${i} is off the line of linedef ${ld}`);
      }
    }
  }
  // --- ssectors: seg spans, ≥1 seg, single sector (P_GroupLines rule) --------
  for (let i = 0; i < numSubsectors; i++) {
    const count = ssecV.getInt16(i * 4, true);
    const first = ssecV.getInt16(i * 4 + 2, true);
    if (count <= 0) fail(`subsector ${i} has ${count} segs (zero-seg subsector)`);
    if (first < 0 || first + count > numSegs) {
      fail(`subsector ${i} seg span [${first}, +${count}) outside [0, ${numSegs})`);
    }
    let sect = -1;
    for (let k = 0; k < count; k++) {
      const o = (first + k) * 12;
      const ld = segsV.getInt16(o + 6, true);
      if (ld < 0) continue; // miniseg: skip (freedoom maps have none)
      const s = sectorOfSide(ld, segsV.getInt16(o + 8, true));
      if (sect === -1) sect = s;
      else if (sect !== s) fail(`subsector ${i} mixes sectors ${sect}/${s} (R01 §9)`);
    }
  }
  // --- nodes: BSP identity + child refs --------------------------------------
  if (numNodes !== numSubsectors - 1) {
    fail(`NODES count ${numNodes} != SSECTORS count ${numSubsectors} − 1`);
  }
  for (let i = 0; i < numNodes; i++) {
    for (let c = 0; c < 2; c++) {
      const child = nodesV.getUint16(i * 28 + 24 + c * 2, true);
      if ((child & NF_SUBSECTOR) !== 0) {
        const s = child & 0x7fff;
        if (s >= numSubsectors) fail(`node ${i} child ${c} subsector ${s} outside [0, ${numSubsectors})`);
      } else if (child >= numNodes || child >= i) {
        fail(`node ${i} child ${c} node index ${child} invalid (must be < own index)`);
      }
    }
  }
  // --- REJECT: linear ceil(n²/8) (R01 §12) -----------------------------------
  const rejectWant = Math.ceil((numSectors * numSectors) / 8);
  if (reject.length !== rejectWant) {
    fail(`REJECT size ${reject.length} != ceil(${numSectors}²/8) = ${rejectWant}`);
  }
  // --- BLOCKMAP: layout + exact bbox coverage (R01 §13) ----------------------
  const bm = requireSize(blockmap, 2, 'BLOCKMAP');
  if (bm.byteLength < 8) fail('BLOCKMAP shorter than the 8-byte header');
  const originx = bm.getInt16(0, true);
  const originy = bm.getInt16(2, true);
  const width = bm.getInt16(4, true);
  const height = bm.getInt16(6, true);
  if (width <= 0 || height <= 0) fail(`BLOCKMAP grid ${width}x${height} invalid`);
  const nBlocks = width * height;
  const seen = new Set<number>();
  const coverage = new Map<number, number>(); // line → block count
  for (let b = 0; b < nBlocks; b++) {
    const off = bm.getUint16(8 + b * 2, true);
    if (off < 4 + nBlocks || off * 2 >= bm.byteLength + 2) {
      fail(`block ${b} offset ${off} outside the list region (≥ ${4 + nBlocks})`);
    }
    let at = off * 2;
    const seenHere = new Set<number>();
    for (;;) {
      if (at + 2 > bm.byteLength) fail(`block ${b} list not −1-terminated inside the lump`);
      const li = bm.getInt16(at, true);
      at += 2;
      if (li === -1) break;
      if (li < 0 || li >= numLines) fail(`block ${b} references linedef ${li} < ${numLines}`);
      if (seenHere.has(li)) fail(`block ${b} lists linedef ${li} twice`);
      seenHere.add(li);
      seen.add(li);
      coverage.set(li, (coverage.get(li) ?? 0) + 1);
    }
  }
  for (let i = 0; i < numLines; i++) {
    if (!seen.has(i)) fail(`BLOCKMAP never lists linedef ${i}`);
  }
  for (let i = 0; i < numLines; i++) {
    const o = i * LINEDEFS_REC;
    const x1 = vertsV.getInt16(linesV.getInt16(o, true) * 4, true);
    const y1 = vertsV.getInt16(linesV.getInt16(o, true) * 4 + 2, true);
    const x2 = vertsV.getInt16(linesV.getInt16(o + 2, true) * 4, true);
    const y2 = vertsV.getInt16(linesV.getInt16(o + 2, true) * 4 + 2, true);
    const want = blocksTouched(
      Math.min(x1, x2),
      Math.min(y1, y2),
      Math.max(x1, x2),
      Math.max(y1, y2),
      originx,
      originy,
      width,
      height
    ).length;
    if (coverage.get(i) !== want) {
      fail(`linedef ${i} listed in ${coverage.get(i)} blocks, bbox touches ${want}`);
    }
  }

  return {
    numThings,
    numLines,
    numSidedefs,
    numVertexes,
    numSegs,
    numSubsectors,
    numNodes,
    numSectors,
    rejectBytes: reject.length,
    blockmap: { originx, originy, width, height }
  };
}
