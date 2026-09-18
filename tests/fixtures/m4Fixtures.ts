/**
 * M4-06 — Fixture extension: sky, flats, fences, things, panning
 * (docs/design/M4-plan.md §M4-06).
 *
 * ADDITIVE BY CONSTRUCTION: nothing in mapBuilder.ts / smallWads.ts changes;
 * the WALLFIX bytes the M3 goldens depend on are untouched. This file adds a
 * superset rectangle model (M4MapSpec) whose compiler mirrors mapBuilder's
 * documented conventions line-for-line — the byte-parity test in
 * m4Fixtures.test.ts proves `buildM4MapLumps(WALLFIX_SPEC)` equals
 * `buildMapLumps(WALLFIX_SPEC)` exactly, i.e. no convention drifted.
 *
 * ## What M4MapSpec adds over RectMapSpec (all optional; absent ⇒ identical
 * bytes to the M2 compiler):
 *  - `skyCeiling: true`      ⇒ sector ceilingFlat = 'F_SKY1' (M4-01/02 sky
 *    collapse + drawPlanes sky branch); the lump helper {@link skyFlatLump}
 *    supplies the id-style 1024-byte never-drawn dummy.
 *  - `midTexture`            ⇒ mid-texture on the room-side sidedef of the
 *    room's TWO-SIDED edges (shared room-room edges AND the dummy-VOID
 *    edges, which are two-sided here — mapBuilder header). Conflicting
 *    values on a shared edge are a spec error. Door gaps keep DOORFIX0.
 *    The name is ALSO written to the bottom-texture slot (dual-write
 *    shim for the mapdata.ts bottom/mid decode swap — see the compile
 *    comment; equal-height masked edges ⇒ never drawn either way).
 *  - `wallOffsetX/Y`         ⇒ sidedef textureoffset/rowoffset (int16) on
 *    every sidedef referencing that room — closes the M3 "panned sidedef
 *    not expressible" gap note (viewpoints.ts header). PINNED TRUTH: rdata
 *    models textureoffset only (`sideOffsetX`); rowoffset lands in the
 *    SIDEDEFS bytes but the renderer currently ignores it (segs.ts seam
 *    note) — round-trip asserts the BYTES, not renderer behavior.
 *  - `things`                ⇒ unchanged RectMapSpec.things (angle field
 *    exists: int16 DEGREES, R01 §4; R_AddSprites reads it in M4-03/05).
 *
 * ## Content lumps (all deterministic; shas committed in *_SHA256 below)
 *  - FLATFIX flats, 64×64 row-major (row 0 = NORTH, flat[(y<<6)+x]):
 *      FLTRAMP0 px = x            (texture-column mirror/transpose tell)
 *      FLTCHK0   8px checker      (144 / 208)
 *      FLTEDG0   fill 64 + corner codes NW=1 NE=2 SE=3 SW=4 (a flipped or
 *                transposed flat shows as swapped codes).
 *  - MASKFIX0 texture 64×64: solid cols 0–15 & 48–63 (all 200), masked
 *    middle cols 16–47 COLUMN PARITY: EVEN texture columns opaque (200),
 *    ODD columns fully transparent (post-less ⇒ composed 0). Occlusion
 *    tests expect drawn masked pixels at even parity only.
 *  - SKY1 texture 256×128 (DEVIATION: freedoom SKY1 is 1024 wide — 256
 *    keeps the power-of-2 column mask of rdata.getSkyColumn while halving
 *    fixture bytes): column marker is a ROW-SPLIT pair because a
 *    bijection 0..255 → 1..255 (0 = transparent) is impossible:
 *      row < 64  ⇒ px = (c & 15) + 1        (low nibble, 1..16)
 *      row ≥ 64  ⇒ px = 250 - ((c >> 4) * 8) (column/16, 250..130)
 *      decode    ⇒ c = ((250 - hi) / 8) * 16 + (lo - 1)
 *  - F_SKY1 flat: 1024 NUL bytes (id-style; M4-02 pins "never drawn").
 *
 * WALL PATCH NOTE: FIXP0/FIXP1 here are 32×64 real-post patches (wallPatch
 * below) — the M2 fixture WADs' 2×2 synthPatch lumps are NOT decodable by
 * src/wad/patch (rdata.test.ts note), which would break every
 * texturesFromWad-based golden. Same PNAMES names, valid posts.
 *
 * Maps (marker names ≤ 8 chars): M4FLAT, M4MASK, M4SKY, M4THNG, M4PAN —
 * per-scene WAD builders plus one combined {@link buildM4FixturesWad}.
 * Every map passes mapSelfCheck.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { buildPatchFromColumns } from '../../src/wad/patch';
import { buildGridNodes, SEG_TWOSIDED } from './bspSplit';
import {
  mapSelfCheck,
  BLOCK_SIZE,
  BLOCKMAP_INSET,
  COORD_LIMIT,
  DEFAULT_CEILING_HEIGHT,
  DEFAULT_DOOR_SPECIAL,
  DEFAULT_FLOOR_HEIGHT,
  DEFAULT_LIGHT,
  DOT_THING,
  FLAT_CEIL,
  FLAT_FLOOR,
  MapSpecError,
  ML_TWOSIDED,
  TEX_DOOR,
  TEX_WALL,
  VOID_HEIGHT,
  VOID_SECTOR,
  type MapCheckReport,
  type DoorGapSpec,
  type RectRoomSpec,
  type ThingSpec
} from './mapBuilder';
import { synthFlat, synthPnames, synthTexture1 } from './smallWads';
import { WadBuilder } from './wadWriter';

// ---------------------------------------------------------------------------
// Content names
// ---------------------------------------------------------------------------

/** Column-ramp flat (px = x). */
export const FLAT_RAMP = 'FLTRAMP0';
/** 8-pixel checker flat. */
export const FLAT_CHECKER = 'FLTCHK0';
/** Edge-tagged-corner flat (orientation tell). */
export const FLAT_EDGETAG = 'FLTEDG0';
/** Vanilla sky sector ceiling flat name (rdata SKY_FLAT_NAME). */
export const FLAT_SKY = 'F_SKY1';
/** Masked fence texture (solid|parity-holed|solid). */
export const TEX_MASKED = 'MASKFIX0';
/** Sky texture name rdata resolves for sky columns (DEFAULT_SKY_TEXTURE_NAME). */
export const TEX_SKY = 'SKY1';

// ---------------------------------------------------------------------------
// Flat generators (64×64, row-major, row 0 = NORTH)
// ---------------------------------------------------------------------------

export const FLAT_SIZE = 64;

/** px[y*64+x] = x — texture-column readout (mirror/transpose detectors). */
export function synthFlatRamp(): Uint8Array {
  const out = new Uint8Array(FLAT_SIZE * FLAT_SIZE);
  for (let y = 0; y < FLAT_SIZE; y++) {
    for (let x = 0; x < FLAT_SIZE; x++) out[y * FLAT_SIZE + x] = x;
  }
  return out;
}

/** 8×8-cell checker: cells alternate {@link FLAT_CHK_A}/{@link FLAT_CHK_B}. */
export const FLAT_CHK_A = 144;
export const FLAT_CHK_B = 208;
export function synthFlatChecker(): Uint8Array {
  const out = new Uint8Array(FLAT_SIZE * FLAT_SIZE);
  for (let y = 0; y < FLAT_SIZE; y++) {
    for (let x = 0; x < FLAT_SIZE; x++) {
      out[y * FLAT_SIZE + x] = ((x >> 3) ^ (y >> 3)) & 1 ? FLAT_CHK_B : FLAT_CHK_A;
    }
  }
  return out;
}

/** Fill flat with 2×2 corner codes: NW=1 NE=2 SE=3 SW=4 (row 0 = north). */
export const FLAT_EDGE_FILL = 64;
export const FLAT_CORNER_NW = 1;
export const FLAT_CORNER_NE = 2;
export const FLAT_CORNER_SE = 3;
export const FLAT_CORNER_SW = 4;
export function synthFlatEdgeTags(): Uint8Array {
  const out = new Uint8Array(FLAT_SIZE * FLAT_SIZE).fill(FLAT_EDGE_FILL);
  const tag = (row: number, col: number, v: number): void => {
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) out[(row + dy) * FLAT_SIZE + col + dx] = v;
  };
  tag(0, 0, FLAT_CORNER_NW);
  tag(0, FLAT_SIZE - 2, FLAT_CORNER_NE);
  tag(FLAT_SIZE - 2, FLAT_SIZE - 2, FLAT_CORNER_SE);
  tag(FLAT_SIZE - 2, 0, FLAT_CORNER_SW);
  return out;
}

/** id-style F_SKY1 dummy: 1024 NUL bytes, never drawn (M4-02 pins this). */
export function skyFlatLump(): Uint8Array {
  return new Uint8Array(1024);
}

// ---------------------------------------------------------------------------
// Masked / sky patch + texture builders
// ---------------------------------------------------------------------------

const SOLID_FILL = 200; // != 0 (opaque) and (v & 96) != 32 (no sky-hack range)

/**
 * 32×64 wall patch with a deterministic NON-ZERO raster (a holed texture
 * would flip rdata's texMasked flag — solid fixtures must stay unmasked).
 * POSTS ARE ENCODED BY buildPatchFromColumns: the legacy smallWads
 * `synthPatch` layout is NOT decodable by src/wad/patch.decodePatch (the
 * rdata.test.ts note), so every patch referenced through TEXTURE1 in an
 * M4 fixture WAD uses the real post encoder.
 */
export function wallPatch(mult: number): Uint8Array {
  return buildPatchFromColumns(
    Array.from({ length: 32 }, (_, c) => {
      const col = new Uint8Array(64);
      for (let r = 0; r < 64; r++) col[r] = ((c * mult + r) % 200) + 1;
      return col;
    })
  );
}

/** 16×64 solid patch (MASKFIX0 shoulders). */
export function solidPatch16(): Uint8Array {
  return buildPatchFromColumns(
    Array.from({ length: 16 }, () => new Uint8Array(64).fill(SOLID_FILL))
  );
}

/**
 * 32×64 column-parity patch: patch column j (== texture column 16+j) is
 * opaque iff j is EVEN; odd columns carry no posts (fully transparent).
 */
export function parityPatch32(): Uint8Array {
  return buildPatchFromColumns(
    Array.from({ length: 32 }, (_, j) =>
      new Uint8Array(64).fill(j % 2 === 0 ? SOLID_FILL : 0)
    )
  );
}

/** Sky column marker pair: [low nibble row value, high row value], both ≥ 1. */
export function skyColumnMarker(c: number): [number, number] {
  return [(c & 15) + 1, 250 - ((c >> 4) & 15) * 8];
}

/** Inverse of {@link skyColumnMarker} (test helper). */
export function skyColumnDecode(lo: number, hi: number): number {
  return ((250 - hi) / 8) * 16 + (lo - 1);
}

export const SKY_TEX_WIDTH = 256; // deviation: freedoom SKY1 is 1024 wide
export const SKY_TEX_HEIGHT = 128;

/** One 64-wide sky patch (patchIndex 0..3); absolute column = 64*i + j. */
export function skyPatch(patchIndex: number): Uint8Array {
  if (!(patchIndex >= 0 && patchIndex < 4)) throw new MapSpecError(`sky patch index ${patchIndex}`);
  return buildPatchFromColumns(
    Array.from({ length: 64 }, (_, j) => {
      const [lo, hi] = skyColumnMarker(patchIndex * 64 + j);
      const col = new Uint8Array(SKY_TEX_HEIGHT);
      for (let r = 0; r < SKY_TEX_HEIGHT; r++) col[r] = r < SKY_TEX_HEIGHT / 2 ? lo : hi;
      return col;
    })
  );
}

// ---------------------------------------------------------------------------
// Committed SHA-256 goldens (sha256 of raw flat bytes; MASKFIX/SKY of the
// COMPOSED texture raster = per-texture-column Uint8Arrays concatenated in
// column order — what rdata samples). Recomputed + asserted in
// m4Fixtures.test.ts via node:crypto over THIS file's generators.
// ---------------------------------------------------------------------------

export const FLATFIX_SHA256: Readonly<Record<string, string>> = {
  [FLAT_RAMP]: '803655837a9c988af92b9d3fc705d9d8fc52ca741fb9f5dc8d5d5c6351565a44',
  [FLAT_CHECKER]: '2dcb72dfbdf5b7dcb62d4549786a7cdd18574a6711c4be7a52f5d153eb7b2563',
  [FLAT_EDGETAG]: '51723a50556ed269172c6e0cce95d36dc60c79914913f042766b10215bf4c51a'
};
/** sha256 of rasterBytes(MASKFIX0.columns) — see FLATFIX_SHA256 note. */
export const MASKFIX_COMPOSED_SHA256 =
  'dcd036760408827b6b49a9d8e175dde2f6d56389ae4d74d731fc06af685bc839';
/** sha256 of rasterBytes(SKY1.columns). */
export const SKYFIX_COMPOSED_SHA256 =
  '4d32c3a8dfdb4c0ddd557923a75a1a762d1f8e62938dad7a17bc4716d1484bc4';

// ---------------------------------------------------------------------------
// M4MapSpec — superset of RectMapSpec
// ---------------------------------------------------------------------------

export interface M4RoomSpec extends RectRoomSpec {
  /** true ⇒ ceilingFlat 'F_SKY1' (sugar; conflicts with a different
   * explicit ceilingFlat ⇒ spec error). */
  readonly skyCeiling?: boolean;
  /** Mid texture on the sidedefs referencing THIS room (two-sided edges
   * only — every generated edge here is two-sided except never a miniseg).
   * Must agree on both sides of a shared edge; door gaps keep DOORFIX0. */
  readonly midTexture?: string;
  /** SIDEDEF textureoffset (renderer-consumed, rdata sideOffsetX). int16. */
  readonly wallOffsetX?: number;
  /** SIDEDEF rowoffset (byte-only: renderer ignores it — segs.ts seam). int16. */
  readonly wallOffsetY?: number;
}

export interface M4MapSpec {
  readonly rooms: readonly M4RoomSpec[];
  readonly doors?: readonly DoorGapSpec[];
  readonly things?: readonly ThingSpec[];
}

// ---------------------------------------------------------------------------
// Scene specs + map names
// ---------------------------------------------------------------------------

export const M4_MAP_NAMES = {
  flats: 'M4FLAT',
  masked: 'M4MASK',
  sky: 'M4SKY',
  things: 'M4THNG',
  panning: 'M4PAN'
} as const;

export type M4Scene = keyof typeof M4_MAP_NAMES;

/** Three rooms, one per FLATFIX flat — plane-orientation/column tests. */
export const FLATFIX_SPEC: M4MapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, floorFlat: FLAT_RAMP },
    { x: 256, y: 0, w: 256, h: 256, floorFlat: FLAT_CHECKER, ceilingFlat: FLAT_EDGETAG },
    { x: 0, y: 256, w: 256, h: 256, floorFlat: FLAT_EDGETAG }
  ]
};

/** Two same-height rooms joined by a MASKFIX0 fence (parity holes). */
export const MASKFIX_SPEC: M4MapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, midTexture: TEX_MASKED },
    { x: 256, y: 0, w: 256, h: 256, midTexture: TEX_MASKED }
  ]
};

/** Sky room (low light ⇒ sky must stay fullbright) + normal neighbor. */
export const SKYFIX_SPEC: M4MapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 512, skyCeiling: true, lightLevel: 32 },
    { x: 512, y: 0, w: 512, h: 512, lightLevel: 160 }
  ]
};

/** Octant ring of 8 things (radius 160, diagonals (±113,±113), |r−160|<1)
 * with angle = octant bearing, plus a tall(3001)/short(2035) pair and the
 * player start. Thing heights live in SPRITE lumps, not the spec — FINDING. */
export const THINGS_RING_CENTER: readonly [number, number] = [256, 256];
export const THINGS_RING_RADIUS = 160;
export const THING_TALL = 3001; // barrel-family doomednum (static, tall)
export const THING_SHORT = DOT_THING; // 2035 (short item)
function thingsRing(): ThingSpec[] {
  const [cx, cy] = THINGS_RING_CENTER;
  const d = Math.round(THINGS_RING_RADIUS / Math.SQRT2); // 113
  const off: [number, number][] = [
    [THINGS_RING_RADIUS, 0], [d, d], [0, THINGS_RING_RADIUS], [-d, d],
    [-THINGS_RING_RADIUS, 0], [-d, -d], [0, -THINGS_RING_RADIUS], [d, -d]
  ];
  return off.map(([ox, oy], i) => ({
    x: cx + ox,
    y: cy + oy,
    angle: i * 45,
    type: i === 0 ? THING_TALL : THING_SHORT
  }));
}
export const THINGSFIX_SPEC: M4MapSpec = {
  rooms: [{ x: 0, y: 0, w: 512, h: 512 }],
  things: [
    { x: 256, y: 256, angle: 0, type: 1 }, // player 1 start
    ...thingsRing(),
    { x: 64, y: 64, angle: 90, type: THING_TALL },
    { x: 448, y: 64, angle: 270, type: THING_SHORT }
  ]
};

/** Three light-variant rooms (0/128/255) with panned sidedefs. Room B
 * carries a rowoffset ONLY (renderer-blind axis — byte round-trip). */
export const PANFIX_SPEC: M4MapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 0, wallOffsetX: 40, wallOffsetY: 8 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128, wallOffsetX: 64 },
    { x: 0, y: 256, w: 256, h: 256, lightLevel: 255, wallOffsetY: 24 }
  ]
};

export const M4_SCENES: Readonly<Record<M4Scene, M4MapSpec>> = {
  flats: FLATFIX_SPEC,
  masked: MASKFIX_SPEC,
  sky: SKYFIX_SPEC,
  things: THINGSFIX_SPEC,
  panning: PANFIX_SPEC
};

// ---------------------------------------------------------------------------
// Compiler (mirrors mapBuilder.compileSpec/encoders; extensions noted)
// ---------------------------------------------------------------------------

const THINGS_REC = 10;
const LINEDEFS_REC = 14;
const SIDEDEFS_REC = 30;
const VERTEXES_REC = 4;
const SECTORS_REC = 26;
const SPAWN_FLAGS = 0x1 | 0x2 | 0x4;

interface M4Sidedef {
  top: string;
  bottom: string;
  mid: string;
  sector: number;
  offset: [number, number];
}

interface M4Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  flags: number;
  special: number;
  tag: number;
  sides: [M4Sidedef, M4Sidedef];
}

interface M4Thing {
  x: number;
  y: number;
  angle: number;
  type: number;
  flags: number;
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

function roomCeilFlat(r: M4RoomSpec): string {
  if (r.skyCeiling) {
    if (r.ceilingFlat !== undefined && r.ceilingFlat !== FLAT_SKY) {
      throw new MapSpecError(`skyCeiling conflicts with ceilingFlat=${r.ceilingFlat}`);
    }
    return FLAT_SKY;
  }
  return r.ceilingFlat ?? FLAT_CEIL;
}

function validateM4Spec(spec: M4MapSpec): void {
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
    if (r.midTexture !== undefined) checkName(r.midTexture, `room ${i}.midTexture`);
    for (const key of ['wallOffsetX', 'wallOffsetY'] as const) {
      const v = r[key];
      if (v !== undefined && !(Number.isInteger(v) && v >= -32768 && v <= 32767)) {
        throw new MapSpecError(`room ${i}.${key} must be int16, got ${v}`);
      }
    }
    if (r.lightLevel !== undefined &&
        !(Number.isInteger(r.lightLevel) && r.lightLevel >= 0 && r.lightLevel <= 255)) {
      throw new MapSpecError(`room ${i}.lightLevel must be 0..255, got ${r.lightLevel}`);
    }
    roomCeilFlat(r);
  });
  for (let i = 0; i < spec.rooms.length; i++) {
    for (let j = i + 1; j < spec.rooms.length; j++) {
      const a = spec.rooms[i]!;
      const b = spec.rooms[j]!;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0) throw new MapSpecError(`rooms ${i} and ${j} overlap in area`);
      if (a.midTexture !== undefined && b.midTexture !== undefined &&
          a.midTexture !== b.midTexture) {
        // adjacent rooms (shared line segment) must agree on the mid texture
        const touchV =
          (a.x + a.w === b.x || b.x + b.w === a.x) &&
          Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
        const touchH =
          (a.y + a.h === b.y || b.y + b.h === a.y) &&
          Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x);
        if (touchV || touchH) {
          throw new MapSpecError(
            `rooms ${i}/${j} disagree on midTexture (${a.midTexture} vs ${b.midTexture})`
          );
        }
      }
    }
  }
  (spec.doors ?? []).forEach((d, i) => {
    checkInt(d.x1, `door ${i}.x1`);
    checkInt(d.y1, `door ${i}.y1`);
    checkInt(d.x2, `door ${i}.x2`);
    checkInt(d.y2, `door ${i}.y2`);
    if (d.x1 === d.x2 && d.y1 === d.y2) throw new MapSpecError(`door ${i} is degenerate`);
    if (d.x1 !== d.x2 && d.y1 !== d.y2) throw new MapSpecError(`door ${i} must be axis-aligned`);
  });
}

interface RoomEdge {
  axis: 'v' | 'h';
  c: number;
  a0: number;
  a1: number;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
}

function roomEdges(r: M4RoomSpec): RoomEdge[] {
  return [
    { axis: 'v', c: r.x, a0: r.y, a1: r.y + r.h, nx: 1, ny: 0, dx: 0, dy: 1 },
    { axis: 'h', c: r.y + r.h, a0: r.x, a1: r.x + r.w, nx: 0, ny: -1, dx: 1, dy: 0 },
    { axis: 'v', c: r.x + r.w, a0: r.y, a1: r.y + r.h, nx: -1, ny: 0, dx: 0, dy: -1 },
    { axis: 'h', c: r.y, a0: r.x, a1: r.x + r.w, nx: 0, ny: 1, dx: -1, dy: 0 }
  ];
}

function doorLine(d: DoorGapSpec): { axis: 'v' | 'h'; c: number; a0: number; a1: number } {
  return d.x1 === d.x2
    ? { axis: 'v', c: d.x1, a0: Math.min(d.y1, d.y2), a1: Math.max(d.y1, d.y2) }
    : { axis: 'h', c: d.y1, a0: Math.min(d.x1, d.x2), a1: Math.max(d.x1, d.x2) };
}

function edgeOverlaps(rooms: readonly M4RoomSpec[], i: number, e: RoomEdge) {
  const out: { room: number; s: number; t: number }[] = [];
  rooms.forEach((r, j) => {
    if (j === i) return;
    let adjacent = false;
    if (e.axis === 'v') {
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

function compileM4Spec(spec: M4MapSpec): {
  things: M4Thing[];
  lines: M4Line[];
  sectors: { floor: number; ceil: number; floorFlat: string; ceilFlat: string; light: number; special: number; tag: number }[];
} {
  validateM4Spec(spec);
  const rooms = spec.rooms;

  const doors = (spec.doors ?? []).map((d, i) => ({ ...doorLine(d), spec: d, index: i }));
  const matchedDoors = new Set<number>();
  rooms.forEach((r, i) => {
    for (const e of roomEdges(r)) {
      const overlaps = edgeOverlaps(rooms, i, e);
      for (const d of doors) {
        if (d.axis !== e.axis || d.c !== e.c || d.a0 < e.a0 || d.a1 > e.a1) continue;
        const mid = (d.a0 + d.a1) / 2;
        if (!overlaps.some((o) => o.s <= mid && mid < o.t)) continue;
        matchedDoors.add(d.index);
      }
    }
  });
  for (const d of doors) {
    if (!matchedDoors.has(d.index)) {
      throw new MapSpecError(`door ${d.index} must lie on a room-room shared edge`);
    }
  }
  for (let a = 0; a < doors.length; a++) {
    for (let b = a + 1; b < doors.length; b++) {
      const da = doors[a]!;
      const db = doors[b]!;
      if (da.axis === db.axis && da.c === db.c && Math.min(da.a1, db.a1) > Math.max(da.a0, db.a0)) {
        throw new MapSpecError(`doors ${a} and ${b} overlap on the same wall line`);
      }
    }
  }

  const sectors = [
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
      ceilFlat: roomCeilFlat(r),
      light: r.lightLevel ?? DEFAULT_LIGHT,
      special: r.special ?? 0,
      tag: r.tag ?? 0
    });
  }

  const sideOffsets = (r: M4RoomSpec): [number, number] => [
    r.wallOffsetX ?? 0,
    r.wallOffsetY ?? 0
  ];

  const lines: M4Line[] = [];
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
        if (seen.has(key)) continue;
        seen.add(key);
        const neighbor = overlaps.find((o) => o.s <= mid && mid < o.t)?.room ?? null;
        const door = edgeDoors.find((d) => d.a0 <= mid && mid < d.a1);
        if (door && neighbor === null) {
          throw new MapSpecError(`door ${door.index} on a room-void edge of room ${i}`);
        }
        const forward = e.dx + e.dy > 0;
        const pt = (t: number): [number, number] => (e.axis === 'v' ? [e.c, t] : [t, e.c]);
        const [v1x, v1y] = pt(forward ? a0 : a1);
        const [v2x, v2y] = pt(forward ? a1 : a0);
        const backRoom = neighbor === null ? null : rooms[neighbor]!;
        const front: M4Sidedef = {
          top: '',
          bottom: '',
          mid: '',
          sector: i + 1,
          offset: sideOffsets(r)
        };
        const back: M4Sidedef = {
          top: '',
          bottom: '',
          mid: '',
          sector: neighbor === null ? VOID_SECTOR : neighbor + 1,
          offset: backRoom === null ? [0, 0] : sideOffsets(backRoom)
        };
        if (neighbor === null) front.top = r.wallTexture ?? TEX_WALL;
        const mids = [r.midTexture, backRoom?.midTexture].filter(
          (m): m is string => m !== undefined
        );
        if (mids.length > 0) {
          if (mids[0] !== mids[mids.length - 1]) {
            throw new MapSpecError(`midTexture mismatch on line at ${key}`);
          }
          front.mid = mids[0]!;
          back.mid = mids[0]!;
          // COMPAT SHIM (FINDING for M4-07): src/wad/mapdata.ts decodes
          // "midtexture" from byte 12 — vanilla's bottomtexture slot
          // (doomdata.h mapsidedef_t: top@4, bottom@12, mid@20; R01 §6
          // agrees). Until that swap is fixed the renderer's sideMasked
          // only fires off byte 12. Dual-writing the masked name into the
          // BOTTOM slot keeps today's renderer masked AND leaves vanilla
          // bytes intact; the bottom texel never gets a span because M4
          // masked edges join equal-height sectors. Door gaps deliberately
          // keep mapBuilder's byte-identical single-write convention.
          front.bottom = mids[0]!;
          back.bottom = mids[0]!;
        }
        if (door) {
          front.mid = TEX_DOOR;
          back.mid = TEX_DOOR;
        }
        lines.push({
          x1: v1x,
          y1: v1y,
          x2: v2x,
          y2: v2y,
          flags: ML_TWOSIDED,
          special: door ? door.spec.special ?? DEFAULT_DOOR_SPECIAL : 0,
          tag: door?.spec.tag ?? 0,
          sides: [front, back]
        });
      }
    }
  });

  let things: M4Thing[];
  if (spec.things) {
    things = spec.things.map((t, i) => {
      checkInt(t.x, `thing ${i}.x`);
      checkInt(t.y, `thing ${i}.y`);
      return { x: t.x, y: t.y, angle: t.angle ?? 0, type: t.type, flags: t.flags ?? SPAWN_FLAGS };
    });
  } else {
    const r0 = rooms[0]!;
    things = [1, 2, 3, 4, DOT_THING].map((type) => ({
      x: r0.x + (r0.w >> 1),
      y: r0.y + (r0.h >> 1),
      angle: 0,
      type,
      flags: SPAWN_FLAGS
    }));
  }
  return { things, lines, sectors };
}

// --- encoders (mirror mapBuilder; sidedef offsets are the only delta) ------

function encodeThings(things: M4Thing[]): Uint8Array {
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
  for (let c = 0; c < upper.length; c++) dst[at + c] = upper.charCodeAt(c);
}

function encodeLines(
  lines: M4Line[],
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
      sv.setInt16(so + 0, s.offset[0], true); // textureoffset (renderer axis)
      sv.setInt16(so + 2, s.offset[1], true); // rowoffset (byte-only axis)
      padName(sidedefs, so + 4, s.top);
      padName(sidedefs, so + 12, s.bottom);
      padName(sidedefs, so + 20, s.mid);
      sv.setInt16(so + 28, s.sector, true);
    });
  });
  return { linedefs, sidedefs };
}

function encodeSectors(
  sectors: { floor: number; ceil: number; floorFlat: string; ceilFlat: string; light: number; special: number; tag: number }[]
): Uint8Array {
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

function encodeReject(numSectors: number): Uint8Array {
  return new Uint8Array(Math.ceil((numSectors * numSectors) / 8));
}

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

function encodeBlockmap(lines: M4Line[], vertices: { x: number; y: number }[]): Uint8Array {
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

  const words: number[] = [];
  const u16 = (w: number) => w & 0xffff;
  words.push(u16(originx), u16(originy), u16(width), u16(height));
  const tableStart = 4;
  const nWordsHeader = tableStart + nBlocks;
  for (let b = 0; b < nBlocks; b++) words.push(0);
  const offsets: number[] = [];
  let cursor = nWordsHeader;
  const sharedPos = cursor;
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

/** Compile + encode + BSP: the 10 map lumps of one M4 map. */
export function buildM4MapLumps(spec: M4MapSpec): { name: string; data: Uint8Array }[] {
  const { things, lines, sectors } = compileM4Spec(spec);
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

// ---------------------------------------------------------------------------
// WAD assembly
// ---------------------------------------------------------------------------

/** PNAMES order shared by TEXTURE1 below. */
export const M4_PNAMES = [
  'FIXP0',
  'FIXP1',
  'SOLIDP0',
  'MASKP0',
  'SKYP0',
  'SKYP1',
  'SKYP2',
  'SKYP3'
] as const;

/** Add TEXTURE1/PNAMES + all flats (F_START range) + all patches (P_START
 * range). FIXWALL0/DOORFIX0 match mapBuilder's fixture compositions. */
export function addM4Graphics(wad: WadBuilder): void {
  wad.addLump(
    'TEXTURE1',
    synthTexture1([
      { name: TEX_WALL, width: 64, height: 64, patches: [[0, 0, 0], [32, 0, 1]] },
      { name: TEX_DOOR, width: 64, height: 64, patches: [[0, 0, 1]] },
      {
        name: TEX_MASKED,
        width: 64,
        height: 64,
        patches: [
          [0, 0, 2],
          [16, 0, 3],
          [48, 0, 2]
        ]
      },
      {
        name: TEX_SKY,
        width: SKY_TEX_WIDTH,
        height: SKY_TEX_HEIGHT,
        patches: [
          [0, 0, 4],
          [64, 0, 5],
          [128, 0, 6],
          [192, 0, 7]
        ]
      }
    ])
  );
  wad.addLump('PNAMES', synthPnames([...M4_PNAMES]));
  wad.addLumpMarker('F_START');
  wad.addLump(FLAT_FLOOR, synthFlat(0xf100)); // FIXFLAT0 (mapBuilder parity)
  wad.addLump(FLAT_CEIL, synthFlat(0xf101)); // FIXFLAT1 (mapBuilder parity)
  wad.addLump(FLAT_RAMP, synthFlatRamp());
  wad.addLump(FLAT_CHECKER, synthFlatChecker());
  wad.addLump(FLAT_EDGETAG, synthFlatEdgeTags());
  wad.addLump(FLAT_SKY, skyFlatLump()); // F_SKY1: tag-only 1024-byte dummy
  wad.addLumpMarker('F_END');
  wad.addLumpMarker('P_START');
  wad.addLump('FIXP0', wallPatch(1));
  wad.addLump('FIXP1', wallPatch(3));
  wad.addLump('SOLIDP0', solidPatch16());
  wad.addLump('MASKP0', parityPatch32());
  for (let i = 0; i < 4; i++) wad.addLump(`SKYP${i}`, skyPatch(i));
  wad.addLumpMarker('P_END');
}

/** Canonical raster serialization of a composed texture: the per-texture-
 * column Uint8Arrays concatenated in column order (what the sha goldens
 * cover — rdata samples exactly these `TextureDef.columns`). */
export function rasterBytes(columns: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of columns) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of columns) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Round-trip selfCheck of every M4 map in the combined WAD (the M2
 * mapSelfCheck, keyed by scene). Throws MapCheckError on any violation. */
export function m4SelfCheck(): Record<M4Scene, MapCheckReport> {
  const bytes = buildM4FixturesWad();
  const out = {} as Record<M4Scene, MapCheckReport>;
  for (const scene of Object.keys(M4_MAP_NAMES) as M4Scene[]) {
    out[scene] = mapSelfCheck(bytes, M4_MAP_NAMES[scene]);
  }
  return out;
}

function addMap(wad: WadBuilder, name: string, spec: M4MapSpec): void {
  wad.addLumpMarker(name);
  for (const lump of buildM4MapLumps(spec)) wad.addLump(lump.name, lump.data);
}

/** One scene's WAD (graphics + that single map). */
export function buildM4SceneWad(scene: M4Scene): Uint8Array {
  const wad = new WadBuilder('IWAD');
  addM4Graphics(wad);
  addMap(wad, M4_MAP_NAMES[scene], M4_SCENES[scene]);
  return wad.build();
}

/** The combined fixture WAD: graphics + all five maps. */
export function buildM4FixturesWad(): Uint8Array {
  const wad = new WadBuilder('IWAD');
  addM4Graphics(wad);
  for (const scene of Object.keys(M4_MAP_NAMES) as M4Scene[]) {
    addMap(wad, M4_MAP_NAMES[scene], M4_SCENES[scene]);
  }
  return wad.build();
}
