// render/rdata.ts — render-side world load: the renderer's OWN numeric
// SoA tables for segs / linedefs / sidedefs / sectors / textures
// (M3-plan §M3-02). Hot loops (M3-04…M3-07) never touch strings, Maps or
// sim objects — everything they read is an Int32Array/Uint32Array slot.
//
// Zone discipline (A-INT1 / eslint doom/zones/render): imports core + wad
// TYPES only; `MapData` is consumed as a structural read-view (M2-09
// pattern) — no sim import, no mutation of anything.
//
// Vanilla mapping (linuxdoom-1.10; R03 = docs/research/03-bsp-renderer.md):
//   R_LoadSegs            — NOT in 1.10: the released renderer consumes the
//     seg/linedef/sidedef structs P_SetupLevel built in place (p_setup.c
//     P_LoadSegs/P_LoadLines/P_LoadSides). The SoA build here is the DOOM 3
//     sb_bsp.c R_LoadSegs analogue named by the plan; every derived number
//     matches what p_setup.c would have stored:
//       v1/v2 coords   = vertices[i].{x,y} << FRACBITS (p_setup.c:170)
//       seg angle      = (u16 BAM from the SEGS lump, R01 §8) << FRACBITS —
//                        NO atan2 recomputation (p_setup.c `li->angle =
//                        (SHORT(head->angle))<<FRACBITS`; the signed-int16
//                        shift and our (u16)*0x10000 agree bit-for-bit in
//                        u32). Stored in segAngle (Uint32Array).
//       seg offset       = offset << FRACBITS (p_setup.c; unused by the
//                          1.10 wall loop — kept for parity/debug).
//       sidedef offset   = offset[0] << FRACBITS (p_setup.c P_LoadSides).
//   R_InitTextures (r_data.c:400-540) — we do NOT rebuild composites: M1-06
//     (wad/texture) already delivers composed TextureDef.columns; texture
//     index = iteration order of the passed Map = TEXTURE1-then-TEXTURE2
//     directory order = vanilla texturenum (r_data.c:461-472). The name→idx
//     map replaces texturetranslation + R_TextureNumForName (r_data.c:692).
//     MISSING names: vanilla silently substitutes texture 0 — and names
//     starting with '-' are the "NoTexture" marker, returning 0 WITHOUT any
//     lookup (R_CheckTextureNumForName, r_data.c:692-727, R02 §1 row
//     "Textures"; freedoom E1M1 sidedefs use '-' exactly this way). Here
//     blank AND '-'-prefixed names ⇒ −1 with NO miss record; any other
//     unmatched name becomes −1 and is recorded in `missingTextures`
//     (committed, warning-tolerant list) — deviation D-a, deterministic and
//     visible.
//   R_InitFlats / R_FlatNumForName (r_data.c:579-594, 669-686) — flatNum()
//     reads the raw F_START/F_END directory range (numflats = F_END−F_START−1
//     directory entries, INCLUDING any zero-size ones) with the identity
//     translation flattranslation[i] = i. Vanilla's lookup is
//     W_CheckNumForName(name) − firstflat: a REVERSE scan of the whole
//     WAD directory; for conforming wads (all flat names live inside the
//     F_ markers) that equals "last match inside the range", which is what
//     we do (deviation D-c: names duplicated OUTSIDE the range would give
//     vanilla an out-of-range index; we stay in-range and −1 instead).
//     Unknown name: vanilla I_Error (r_data.c:683) — here −1 + a record in
//     `missingFlats` (committed warn list, same pattern as missingTextures).
//   Sky wiring (g_game.c G_DoLoadLevel:454-467, r_sky.h:32/35, r_plane.c
//   R_DrawPlanes:395-417) — skyflatnum = R_FlatNumForName("F_SKY1"): a
//     TAG-ONLY index; the F_SKY1 lump is never drawn (r_plane.c:396 tests
//     `picnum == skyflatnum` and draws the sky TEXTURE instead), so a
//     non-4096-byte F_SKY1 dummy (id's WADs carry 128/1024-byte ones;
//     freedoom1's is 4096) must never break loading — getFlatPixels
//     tolerates it with the zero sentinel. skyTextureNum = texture index
//     of "SKY1"; episode-variant SKY2/SKY3 selection (g_game.c:457-467) is
//     M9 game-flow territory — deviation D-d, default SKY1.
//     getSkyColumn(angle1024) is the r_plane.c:413-415 pair
//     `angle = (…) >> ANGLETOSKYSHIFT(22); R_GetColumn(skytexture, angle)`:
//     the caller supplies the 0…1023 angle bucket, we apply vanilla's
//     `col &= texturewidthmask`. TRUTH PINNED (freedoom1.wad): SKY1 is
//     256 wide (id's DOOM.WAD SKY1 is 1024) — mask = 255, still a power
//     of two, so the AND wrap is vanilla-identical and never OOB.
//   R_GetColumn (r_data.c:381-399) — getWallColumn(): `col &= widthmask`
//     wrap returning the composed column (patch stitch already done in
//     M1-06's compose; the single-patch raw-patch fast path with its 128-tall
//     assumption is skipped — composed columns are uniform, deviation D-b).
//     Mask = width−1 exactly like texturewidthmask (r_data.c:429): wrap is
//     only CORRECT for power-of-two widths (vanilla-identical assumption,
//     all shipped textures qualify) but NEVER out-of-bounds for any width,
//     because col & (width−1) ≤ width−1 for every bit pattern.
//   masked middle (r_bsp.c R_AddLine / r_segs.c, R03 §12) — 1.10 has no
//     masked field in texture_t and picks the masked pass by MIDDLE-TEXTURE
//     PRESENCE on a two-sided line. The plan (M3-02 §Produces, R02 §7)
//     asks for the transparent-column scan instead, so:
//       texMasked[t]   = 1 iff the composite contains any transparent
//                        (0-sentinel, M1-01) pixel — "columns may have
//                        holes" (R02 §7 byte-table row 8);
//       sideMasked[s]  = midtex ≠ −1 && texMasked[midtex].
//     M3-06 path rule (documented there): two-sided && sideMasked ⇒ record
//     into maskedtexturecol; one-sided midtex ⇒ solid full-column; two-sided
//     midtex with sideMasked=0 ⇒ full-column draw (visually identical to
//     vanilla's masked pass — a hole-free texture paints every column).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { decodeFlat, FLAT_BYTES } from '../wad/flat';
import type { WadFile } from '../wad/wadfile';
import type { MapData, TextureDef } from '../wad/types';

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

/** −1 sentinel for "no texture" (vanilla substitutes texture 0 — see D-a). */
export const NO_TEXTURE = -1;

/** ML_TWOSIDED (R01 §5): the line has a back sidedef. */
export const ML_TWOSIDED = 0x0004;

/** Row height of the defensive sentinel column (vanilla textures are
 * 128-tall composites; r_data.c masks texture rows with &127). */
export const WALLCOLUMN_SENTINEL_HEIGHT = 128;

/* ---- M4-02 flat/sky wiring (r_data.c R_InitFlats + g_game.c sky init) ---- */

/** SKYFLATNAME (r_sky.h:32): the dummy flat naming the sky (g_game.c:454). */
export const SKY_FLAT_NAME = 'F_SKY1';

/** Default sky texture name (g_game.c episode<3 branch; episode variants
 * SKY2/SKY3 selection deferred to M9 game flow — documented deviation). */
export const DEFAULT_SKY_TEXTURE_NAME = 'SKY1';

/** F_START/F_END marker lump names (r_data.c:585-586). */
export const FLAT_START_MARKER = 'F_START';
export const FLAT_END_MARKER = 'F_END';

/** −1 sentinel for "no flat" (vanilla I_Errs instead — see D-a/D-c). */
export const NO_FLAT = -1;

/* ------------------------------------------------------------------ */
/* FlatSource — raw F_START/F_END lump view                            */
/* ------------------------------------------------------------------ */

/** One raw flat lump: directory name + bytes, position in the array =
 * vanilla flatnum (lumpnum − firstflat, identity flattranslation). */
export interface FlatSource {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Collect the F_START/F_END lumps in RAW directory order (R_InitFlats,
 * r_data.c:585-586: firstflat = F_START+1, lastflat = F_END−1 — every
 * directory entry between the markers counts, zero-size ones included, so
 * array position == vanilla flatnum even on wads with stray empty lumps;
 * `WadFile.lumpRange` deliberately skips those and would shift indices).
 * Missing or inverted markers ⇒ empty list (flatNum degrades to −1 for
 * everything — the pre-M4 placeholder behaviour). Last duplicate wins,
 * mirroring vanilla's reverse directory scan (W_CheckNumForName).
 */
export function flatsFromWad(wad: WadFile): readonly FlatSource[] {
  const first = wad.lumpNumByName(FLAT_START_MARKER) + 1;
  const last = wad.lumpNumByName(FLAT_END_MARKER) - 1;
  if (first <= 0 || last < first) return [];
  const out: FlatSource[] = [];
  for (let num = first; num <= last; num += 1) {
    out.push({ name: wad.lumpName(num), bytes: wad.readLump(num) });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* RenderWorld — the renderer's numeric view of one map               */
/* ------------------------------------------------------------------ */

/** Numeric (SoA) render view of one decoded map. Field groups: segs,
 * lines, sides, sectors, textures — all table-indexed, all built once by
 * {@link loadRenderWorld}, never mutated hereafter. */
export interface RenderWorld {
  /** Map marker name ('E1M1', 'FIXMAP', …). */
  readonly mapName: string;

  /* ---- SEGS SoA (one slot per md.segs entry) ---- */
  readonly numSegs: number;
  /** Start/end vertex coords, map units << FRACBITS (p_setup.c). */
  readonly segV1x: Int32Array;
  readonly segV1y: Int32Array;
  readonly segV2x: Int32Array;
  readonly segV2y: Int32Array;
  /** BAM angle u32 = SEGS-lump u16 << 16 (see file header; never `|0`). */
  readonly segAngle: Uint32Array;
  /** Owning linedef index; −1 = miniseg (R01 §8). */
  readonly segLine: Int32Array;
  /** Sidedef index the seg draws through: line.front (side 0) / line.back
   * (side 1); −1 when that sidenum is absent (miniseg / one-sided back). */
  readonly segSide: Int32Array;
  /** seg offset << FRACBITS (p_setup.c parity; unused by the wall loop). */
  readonly segOffset: Int32Array;

  /* ---- LINEDEFS SoA ---- */
  readonly numLines: number;
  readonly lineX1: Int32Array;
  readonly lineY1: Int32Array;
  readonly lineX2: Int32Array;
  readonly lineY2: Int32Array;
  /** Sidedef indices, −1 = absent (back −1 ⇔ one-sided). */
  readonly lineFront: Int32Array;
  readonly lineBack: Int32Array;
  /** Raw LINEDEF flags (ML_*; ML_TWOSIDED = {@link ML_TWOSIDED}). */
  readonly lineFlags: Uint16Array;
  readonly lineSpecial: Int32Array;
  readonly lineTag: Int32Array;

  /* ---- SIDEDEFS SoA ---- */
  readonly numSides: number;
  /** Texture indices, {@link NO_TEXTURE} = absent/unresolvable. */
  readonly sideTopTex: Int32Array;
  readonly sideMidTex: Int32Array;
  readonly sideBotTex: Int32Array;
  /** Sidedef x-offset << FRACBITS (rw_offset base in R_StoreWallRange). */
  readonly sideOffsetX: Int32Array;
  /** Owning sector index per sidedef. */
  readonly sideSector: Int32Array;
  /** 1 = masked middle (midtex resolves AND its composite has
   * transparent pixels; see file header reconciliation). */
  readonly sideMasked: Uint8Array;

  /* ---- SECTORS SoA ---- */
  readonly numSectors: number;
  /** floor/ceiling height << FRACBITS. */
  readonly sectorFloor: Int32Array;
  readonly sectorCeil: Int32Array;
  /** Raw 0…255 light level (wallLightNum from M3-01 consumes it). */
  readonly sectorLight: Int32Array;
  /** floorpic/ceilingpic flatnums (M4-04; R_FindPlane args + the
   * two-sided markfloor/markceiling flat comparisons in R_StoreWallRange,
   * r_segs.c:537-558). Resolved DIRECTLY against the F_START list — a
   * miss is −1 and is NOT recorded in missingFlats (vanilla: I_Error at
   * P_SetupLevel map load, not a per-name runtime miss). −1 = unresolved
   * (no flats shipped / unknown name): the pic comparisons then treat
   * every sector as flat-equal, the pre-M4 behaviour. */
  readonly sectorFloorPic: Int32Array;
  readonly sectorCeilPic: Int32Array;

  /* ---- Textures ---- */
  /** Directory order = input Map iteration order = vanilla texturenum. */
  readonly numTextures: number;
  readonly textureNames: readonly string[];
  readonly texWidth: Int32Array;
  /** width − 1 (vanilla texturewidthmask, r_data.c:429). */
  readonly texWidthMask: Int32Array;
  readonly texHeight: Int32Array;
  /** 1 = composite contains transparent (0) pixels ("columns may have
   * holes", R02 §7 row 8). */
  readonly texMasked: Uint8Array;
  /** Composed columns per texture index (columns[i] = texture i's column
   * list), verbatim from TextureDef.columns — no copy. */
  readonly texColumns: readonly Uint8Array[][];

  /** Uppercase texture names referenced by sidedefs but absent from the
   * texture Map — de-duplicated, first-reference order (committed list). */
  readonly missingTextures: readonly string[];

  /** vanilla numflats (r_data.c:587): raw F_START/F_END directory count. */
  readonly numFlats: number;
  /** Uppercase flat names in vanilla flatnum order (identity
   * flattranslation; raw F_START/F_END directory positions). */
  readonly flatNames: readonly string[];
  /** Uppercase flat names requested via {@link RenderWorld.flatNum} but
   * absent from the flat list — de-duplicated, first-reference order
   * (vanilla I_Errs here; we return −1 and record — deviation D-a pattern). */
  readonly missingFlats: readonly string[];
  /** skyflatnum (g_game.c:454 R_FlatNumForName(SKYFLATNAME)): TAG-ONLY —
   * the lump is never drawn (r_plane.c:396 sky guard); −1 if F_SKY1 is
   * absent (vanilla would I_Error). Not counted as a missingFlat. */
  readonly skyflatnum: number;
  /** skytexture (g_game.c:457-467): index of {@link
   * DEFAULT_SKY_TEXTURE_NAME} in the texture table; −1 when the texture
   * is absent (sentinel column draws). SKY2/SKY3 episode selection: M9. */
  readonly skyTextureNum: number;

  /** R_GetColumn analogue: composed column view at `col & widthmask`.
   * Never out of bounds for ANY col/width; an invalid tex index (e.g.
   * NO_TEXTURE) yields a shared all-zero 128-tall sentinel column. */
  getWallColumn(tex: number, col: number): Uint8Array;

  /** R_FlatNumForName (r_data.c:672): flatnum for a flat name, −1 + a
   * {@link RenderWorld.missingFlats} record when unresolvable (vanilla:
   * I_Error). Case-insensitive; last duplicate in the F_ range wins. */
  flatNum(name: string): number;

  /** Cached flat pixels (row-major 4096 B, decodeFlat contract — raw
   * passthrough copy) for a flatnum; out-of-range ⇒ zero sentinel. A
   * lump that is not a valid 4096-byte flat (the F_SKY1 dummy in id
   * WADs) tolerates decode failure with the zero sentinel: the sky
   * guard means it is never drawn (r_plane.c:225/396). */
  getFlatPixels(num: number): Uint8Array;

  /** r_plane.c:413-415 sky sample: `R_GetColumn(skytexture, angle1024)`
   * with the vanilla `col &= texturewidthmask` wrap — angle1024 is the
   * `(viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT(22)` bucket, any int (negative included)
   * and never out of bounds. See SKY1-width truth in the file header. */
  getSkyColumn(angle1024: number): Uint8Array;
}

/* ------------------------------------------------------------------ */
/* loadRenderWorld                                                    */
/* ------------------------------------------------------------------ */

/** Zero-filled defensive column (NO_TEXTURE samples; see D-a note). */
const SENTINEL_COLUMN = new Uint8Array(WALLCOLUMN_SENTINEL_HEIGHT);

/** Zero-filled defensive flat (undrawable/absent flats; see sky note). */
const SENTINEL_FLAT = new Uint8Array(FLAT_BYTES);

function toFixedUnits(units: number): number {
  // Raw int16 map units (R01 §4) never near 2^15, so the |0 keeps the
  // exact two's-complement fixed value.
  return (units * FRACUNIT) | 0;
}

/**
 * Build the renderer's numeric tables from decoded map data + composed
 * textures + (optionally) the F_START/F_END flat lumps ({@link
 * {@link flatsFromWad}). Pure read of all inputs (no mutation),
 * deterministic, and independent of anything in sim/**. Omitting `flats`
 * keeps the pre-M4 behaviour: every flatNum is −1.
 */
export function loadRenderWorld(
  md: MapData,
  textures: ReadonlyMap<string, TextureDef>,
  flats: readonly FlatSource[] = [],
): RenderWorld {
  /* ---------------- textures (vanilla texturenum = directory order) -- */
  const textureNames: string[] = [];
  const texByName = new Map<string, number>();
  const texColumns: Uint8Array[][] = [];
  const texWidths: number[] = [];
  const texHeights: number[] = [];
  const texMaskedFlags: number[] = [];
  for (const [key, def] of textures) {
    if (texByName.has(key)) continue; // first wins, like R_CheckTextureNumForName
    const idx = textureNames.length;
    textureNames.push(def.name);
    texByName.set(key, idx);
    texColumns.push(def.columns);
    texWidths.push(def.width);
    texHeights.push(def.height);
    // Transparent-column scan (R02 §7 "columns may have holes"; M1-06
    // sentinel: 0 = never painted / post hole).
    let holes = 0;
    for (const col of def.columns) {
      for (let i = 0; i < col.length; i += 1) {
        if (col[i] === 0) {
          holes = 1;
          break;
        }
      }
      if (holes !== 0) break;
    }
    texMaskedFlags.push(holes);
  }

  const missing: string[] = [];
  const missingSet = new Set<string>();
  /** Name → texture index; '' = no texture, and any '-'-prefixed name is
   * vanilla's NoTexture marker (r_data.c:692-727) — NEITHER is a miss. */
  const texNum = (name: string): number => {
    if (name === '' || name.charCodeAt(0) === 0x2d /* '-' */) return NO_TEXTURE;
    const idx = texByName.get(name);
    if (idx !== undefined) return idx;
    if (!missingSet.has(name)) {
      missingSet.add(name);
      missing.push(name);
    }
    return NO_TEXTURE;
  };

  /* ---------------- sectors ---------------------------------------- */
  const numSectors = md.sectors.length;
  const sectorFloor = new Int32Array(numSectors);
  const sectorCeil = new Int32Array(numSectors);
  const sectorLight = new Int32Array(numSectors);
  for (let i = 0; i < numSectors; i += 1) {
    const s = md.sectors[i]!;
    sectorFloor[i] = toFixedUnits(s.floorLh);
    sectorCeil[i] = toFixedUnits(s.ceilingLh);
    sectorLight[i] = s.lightLevel;
  }

  /* ---------------- sidedefs --------------------------------------- */
  const numSides = md.sideDefs.length;
  const sideTopTex = new Int32Array(numSides).fill(NO_TEXTURE);
  const sideMidTex = new Int32Array(numSides).fill(NO_TEXTURE);
  const sideBotTex = new Int32Array(numSides).fill(NO_TEXTURE);
  const sideOffsetX = new Int32Array(numSides);
  const sideSector = new Int32Array(numSides);
  for (let i = 0; i < numSides; i += 1) {
    const sd = md.sideDefs[i]!;
    sideTopTex[i] = texNum(sd.toptexture);
    sideMidTex[i] = texNum(sd.midtexture);
    sideBotTex[i] = texNum(sd.bottomtexture);
    sideOffsetX[i] = toFixedUnits(sd.offset[0]);
    sideSector[i] = sd.sector;
  }

  /* ---------------- linedefs --------------------------------------- */
  const numLines = md.lineDefs.length;
  const lineX1 = new Int32Array(numLines);
  const lineY1 = new Int32Array(numLines);
  const lineX2 = new Int32Array(numLines);
  const lineY2 = new Int32Array(numLines);
  const lineFront = new Int32Array(numLines).fill(NO_TEXTURE);
  const lineBack = new Int32Array(numLines).fill(NO_TEXTURE);
  const lineFlags = new Uint16Array(numLines);
  const lineSpecial = new Int32Array(numLines);
  const lineTag = new Int32Array(numLines);
  for (let i = 0; i < numLines; i += 1) {
    const ld = md.lineDefs[i]!;
    const v1 = md.vertices[ld.v1]!;
    const v2 = md.vertices[ld.v2]!;
    lineX1[i] = toFixedUnits(v1.x);
    lineY1[i] = toFixedUnits(v1.y);
    lineX2[i] = toFixedUnits(v2.x);
    lineY2[i] = toFixedUnits(v2.y);
    lineFront[i] = ld.front;
    lineBack[i] = ld.back;
    lineFlags[i] = ld.flags & 0xffff;
    lineSpecial[i] = ld.special;
    lineTag[i] = ld.tag;
  }

  /* ---------------- masked-middle flag (needs line geometry) -------- */
  // A sidedef's middle reads as masked iff it resolves to a holed texture
  // AND some TWO-SIDED line references it (one-sided midtex = solid path,
  // r_segs.c one-sided branch). "Two-sided" = back sidenum present, which
  // is what decides `backsector != NULL` in the renderer (flags' ML_TWOSIDED
  // agrees on conforming maps; the sidenum is the vanilla-authoritative
  // signal — p_setup.c P_LoadLines sets backsector from it).
  const sideMasked = new Uint8Array(numSides);
  for (let s = 0; s < numSides; s += 1) {
    const mid = sideMidTex[s]!;
    if (mid === NO_TEXTURE || texMaskedFlags[mid] === 0) continue;
    for (let l = 0; l < numLines; l += 1) {
      const twoSided = lineBack[l]! >= 0;
      if (twoSided && (lineFront[l] === s || lineBack[l] === s)) {
        sideMasked[s] = 1;
        break;
      }
    }
  }

  /* ---------------- segs ------------------------------------------- */
  const numSegs = md.segs.length;
  const segV1x = new Int32Array(numSegs);
  const segV1y = new Int32Array(numSegs);
  const segV2x = new Int32Array(numSegs);
  const segV2y = new Int32Array(numSegs);
  const segAngle = new Uint32Array(numSegs);
  const segLine = new Int32Array(numSegs).fill(NO_TEXTURE);
  const segSide = new Int32Array(numSegs).fill(NO_TEXTURE);
  const segOffset = new Int32Array(numSegs);
  for (let i = 0; i < numSegs; i += 1) {
    const sg = md.segs[i]!;
    const v1 = md.vertices[sg.v1]!;
    const v2 = md.vertices[sg.v2]!;
    segV1x[i] = toFixedUnits(v1.x);
    segV1y[i] = toFixedUnits(v1.y);
    segV2x[i] = toFixedUnits(v2.x);
    segV2y[i] = toFixedUnits(v2.y);
    segAngle[i] = (sg.angle & 0xffff) * 0x10000; // BAM u16 << FRACBITS
    const li = sg.line;
    segLine[i] = li;
    if (li >= 0) {
      segSide[i] = sg.side === 0 ? lineFront[li]! : lineBack[li]!;
    }
    segOffset[i] = toFixedUnits(sg.offset);
  }

  /* ---------------- flats (r_data.c R_InitFlats; identity translation) - */
  // numflats = raw directory entries between the markers (R_InitFlats
  // counts positions, not decodable payloads); flattranslation[i] = i.
  const numFlats = flats.length;
  const flatNames: string[] = [];
  const flatByName = new Map<string, number>();
  for (let i = 0; i < numFlats; i += 1) {
    const key = flats[i]!.name.toUpperCase();
    flatNames.push(key);
    flatByName.set(key, i); // last wins = vanilla reverse dir scan
  }
  const missingFlats: string[] = [];
  const missingFlatSet = new Set<string>();
  const flatCache: (Uint8Array | undefined)[] = new Array<Uint8Array | undefined>(numFlats);

  function flatNum(name: string): number {
    const key = name.toUpperCase();
    const idx = flatByName.get(key);
    if (idx !== undefined) return idx;
    if (!missingFlatSet.has(key)) {
      missingFlatSet.add(key);
      missingFlats.push(key);
    }
    return NO_FLAT;
  }

  function getFlatPixels(num: number): Uint8Array {
    if (!(num >= 0 && num < numFlats)) return SENTINEL_FLAT;
    let px = flatCache[num];
    if (px === undefined) {
      try {
        px = decodeFlat(flats[num]!.bytes, flatNames[num]!).pixels;
      } catch {
        // Non-4096 dummy (e.g. an id-style F_SKY1): tag-only, never drawn
        // — sky guard r_plane.c:396 — so tolerate with the zero sentinel.
        px = SENTINEL_FLAT;
      }
      flatCache[num] = px;
    }
    return px;
  }

  // skyflatnum: g_game.c:454 — a direct lookup, deliberately NOT routed
  // through flatNum(): its absence is a load-time fatal in vanilla
  // (I_Error), not a per-sector miss, so it must not pollute missingFlats.
  const skyflatnum = flatByName.get(SKY_FLAT_NAME) ?? NO_FLAT;
  // skytexture: g_game.c:457-467 (episode<3 ⇒ "SKY1"); likewise a system
  // lookup, not a sidedef miss — no missingTextures record.
  const skyTextureNum = texByName.get(DEFAULT_SKY_TEXTURE_NAME) ?? NO_TEXTURE;

  // Sector flatnums (M4-04): direct flatByName lookups — same no-pollute
  // rationale as skyflatnum above (see the RenderWorld field docs).
  const sectorFloorPic = Int32Array.from(
    md.sectors,
    (s) => flatByName.get(s.floorFlat.toUpperCase()) ?? NO_FLAT
  );
  const sectorCeilPic = Int32Array.from(
    md.sectors,
    (s) => flatByName.get(s.ceilingFlat.toUpperCase()) ?? NO_FLAT
  );

  /* ---------------- world object ----------------------------------- */
  const texWidth = Int32Array.from(texWidths);
  const texWidthMask = Int32Array.from(texWidths, (w) => w - 1);
  const texHeight = Int32Array.from(texHeights);

  function getWallColumn(tex: number, col: number): Uint8Array {
    if (!(tex >= 0 && tex < texColumns.length)) return SENTINEL_COLUMN;
    const columns = texColumns[tex]!;
    // Vanilla R_GetColumn: col &= texturewidthmask (r_data.c:393). The AND
    // of ANY int32 col with width−1 is ≤ width−1 ⇒ never OOB even for the
    // (vanilla-assumed-power-of-two) non-conforming widths; the `??` is a
    // type-level guard that a conforming table can never reach.
    return columns[col & texWidthMask[tex]!] ?? SENTINEL_COLUMN;
  }

  return {
    mapName: md.name,
    numSegs,
    segV1x,
    segV1y,
    segV2x,
    segV2y,
    segAngle,
    segLine,
    segSide,
    segOffset,
    numLines,
    lineX1,
    lineY1,
    lineX2,
    lineY2,
    lineFront,
    lineBack,
    lineFlags,
    lineSpecial,
    lineTag,
    numSides,
    sideTopTex,
    sideMidTex,
    sideBotTex,
    sideOffsetX,
    sideSector,
    sideMasked,
    numSectors,
    sectorFloor,
    sectorCeil,
    sectorLight,
    sectorFloorPic,
    sectorCeilPic,
    numTextures: textureNames.length,
    textureNames,
    texWidth,
    texWidthMask,
    texHeight,
    texMasked: Uint8Array.from(texMaskedFlags),
    texColumns,
    missingTextures: missing,
    numFlats,
    flatNames,
    missingFlats,
    skyflatnum,
    skyTextureNum,
    getWallColumn,
    flatNum,
    getFlatPixels,
    getSkyColumn(angle1024: number): Uint8Array {
      // R_GetColumn(skytexture, angle) — the widthmask AND wrap inside
      // getWallColumn handles any int32 bucket (freedoom1 SKY1 width is
      // 256, id's 1024; both powers of two — file header truth note).
      return getWallColumn(skyTextureNum, angle1024);
    },
  };
}
