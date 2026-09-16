/**
 * TEXTURE1 / TEXTURE2 / PNAMES texture decoder — M1-06.
 *
 * On-disk layout (r_data.c:69-92 `maptexture_t`/`mappatch_t`, verified
 * byte-for-byte against freedoom1.wad in R02 §7 — the "basetexturewidth
 * bit 0x8000" reading is NOT vanilla: `masked` is a 4-byte `boolean`
 * (doomtype.h:34) sitting at record offset 8, so width stays a plain
 * int16 at 12):
 *
 *   PNAMES   int32 count + count * 8-byte NUL-padded names (stride 8)
 *   TEXTURE* int32 numtextures + int32 offsets[] (from lump start), then
 *     0  char[8]   name
 *     8  int32     masked flag (ignored here; masked-ness is recomputed
 *                  from composed pixels per M1-plan §M1-06 sentinel scan)
 *     12 int16     width
 *     14 int16     height
 *     16 int32     obsolete columndirectory (ignored)
 *     20 int16     patchcount
 *     22 10 each   mappatch: int16 originx, originy, patch (PNAMES index),
 *                  stepdir, colormap (only the first three copied, as in
 *                  r_data.c:536-538)
 *
 * Patch resolution (R02 §1, r_data.c:446-453): PNAMES names go through the
 * GLOBAL lump lookup ("scan backwards so patch lump files take precedence",
 * w_wad.c:376-388) — last-match-wins, NOT restricted to a P_START range; the
 * `"S_START"/"S_END"` strings near r_data.c:493 only drive the startup
 * progress bar. A name that resolves nowhere is vanilla `I_Error`
 * ("R_InitTextures: Missing patch in texture %s") — a typed error here.
 *
 * Compositing replicates R_GenerateComposite/R_DrawColumnInCache
 * (linuxdoom-1.10 r_data.c):
 * - patches composite in directory order, later ones overwrite earlier;
 * - X: `x1 = max(originx,0)` .. `x2 = min(originx+patchWidth, texWidth)` —
 *   CLIPPED at both texture edges, no horizontal wrap (wrap happens at DRAW
 *   time via `col &= texturewidthmask`, r_data.c:385-404, not in composite);
 * - Y: per post, `position = originy + topdelta` with negative-top trim and
 *   bottom clip to `cacheheight` — clipped, never wrapped; in decoded-column
 *   form that is pixel-wise `destRow = srcRow + originy` clipped to
 *   [0, texHeight);
 * - transparency: vanilla memcpies raw post bytes; the G1 contract pins
 *   "0 = transparent" for composed columns, so a source pixel 0 leaves the
 *   destination untouched while non-zero pixels overwrite. For real patches
 *   (opaque inside their post runs) this is pixel-identical to vanilla and
 *   gives masked patches the correct see-through behaviour.
 *
 * TEXTURE2, when present, is appended after TEXTURE1 (r_data.c:461-472);
 * name lookup returns the FIRST match in the concatenated list
 * (R_CheckTextureNumForName, r_data.c:692-727).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { decodePatch } from './patch';
import type { DecodedPatch, TextureDef, TexturePatch } from './types';
import { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Typed errors                                                        */
/* ------------------------------------------------------------------ */

/** Base class for every malformed-texture condition thrown here. */
export class TextureDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** PNAMES lump missing, truncated, or with an impossible count. */
export class PnamesError extends TextureDecodeError {}

/** TEXTURE lump missing/truncated or with a bad offset table (vanilla "bad texture directory"). */
export class TextureLumpError extends TextureDecodeError {}

/** A texture record overruns the lump or holds impossible fields. */
export class TextureRecordError extends TextureDecodeError {}

/** Patch index out of range, patch lump absent, or patch pixels malformed. */
export class TexturePatchError extends TextureDecodeError {}

/* ------------------------------------------------------------------ */
/* Names                                                               */
/* ------------------------------------------------------------------ */

/** Trim trailing NUL (and legacy space) padding from an 8-byte name field. */
function trimName(raw: Uint8Array): string {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] as number) === 0) end -= 1;
  let s = '';
  for (let i = 0; i < end; i += 1) s += String.fromCharCode(raw[i] as number);
  return s.trimEnd(); // some tools space-pad instead (R01 §15.2)
}

/* ------------------------------------------------------------------ */
/* decodePnames                                                        */
/* ------------------------------------------------------------------ */

/**
 * Decode a PNAMES lump: int32 count + count x 8-byte NUL-padded names,
 * stride 8 (R02 §7). Names are returned verbatim (trimmed); resolution to
 * lumps is case-insensitive via {@link WadFile.lumpNumByName}.
 */
export function decodePnames(bytes: Uint8Array): string[] {
  if (bytes.length < 4) {
    throw new PnamesError(`PNAMES lump truncated: ${bytes.length} bytes < 4`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getInt32(0, true);
  if (count < 0) {
    throw new PnamesError(`PNAMES count negative: ${count}`);
  }
  if (4 + count * 8 > bytes.length) {
    throw new PnamesError(
      `PNAMES truncated: ${count} names need ${4 + count * 8} bytes, lump has ${bytes.length}`,
    );
  }
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    names.push(trimName(bytes.subarray(4 + i * 8, 12 + i * 8)));
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* decodeTextures                                                      */
/* ------------------------------------------------------------------ */

const TEXTURE_RECORD_BYTES = 22;
const MAPPATCH_BYTES = 10;

interface RawTexture {
  name: string;
  width: number;
  height: number;
  /** `patchNum` still holds the raw PNAMES index at this point. */
  patches: TexturePatch[];
}

/** Parse one texture record at `offset` (structure only, patches unresolved). */
function parseTextureRecord(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  lumpLen: number,
  index: number,
): RawTexture {
  if (offset + TEXTURE_RECORD_BYTES > lumpLen) {
    throw new TextureRecordError(
      `texture record ${index} at offset ${offset} overruns the lump (${lumpLen} bytes)`,
    );
  }
  const patchcount = view.getInt16(offset + 20, true);
  if (patchcount < 0) {
    throw new TextureRecordError(`texture record ${index}: negative patchcount ${patchcount}`);
  }
  if (offset + TEXTURE_RECORD_BYTES + patchcount * MAPPATCH_BYTES > lumpLen) {
    throw new TextureRecordError(
      `texture record ${index} patches overrun the lump (need ${
        offset + TEXTURE_RECORD_BYTES + patchcount * MAPPATCH_BYTES
      }, have ${lumpLen})`,
    );
  }
  const name = trimName(bytes.subarray(offset, offset + 8));
  const width = view.getInt16(offset + 12, true);
  const height = view.getInt16(offset + 14, true);
  // offset 8: masked flag (4-byte boolean, r_data.c:79 + doomtype.h:34);
  // masked-ness is derived from composed pixels instead (isMaskedTexture).
  // offset 16: obsolete columndirectory, ignored (r_data.c:87).
  if (width <= 0 || height <= 0) {
    throw new TextureRecordError(`texture '${name}': impossible size ${width}x${height}`);
  }
  const patches: TexturePatch[] = [];
  for (let p = 0; p < patchcount; p += 1) {
    const at = offset + TEXTURE_RECORD_BYTES + p * MAPPATCH_BYTES;
    patches.push({
      originX: view.getInt16(at, true),
      originY: view.getInt16(at + 2, true),
      patchNum: view.getInt16(at + 4, true), // PNAMES index until resolution
    });
  }
  return { name, width, height, patches };
}

/**
 * Decode a TEXTURE1/TEXTURE2 lump from `wad` into composed textures.
 *
 * Each texture's patches are resolved PNAMES-index -> patch lump (global
 * last-match-wins lookup, R02 §1) -> decoded patch -> composited into
 * column-major `Uint8Array(height)` strips, 0 = transparent. The exposed
 * {@link TexturePatch.patchNum} is the RESOLVED patch lump number (G1:
 * "patch lump number"); vanilla keeps the PNAMES index internally.
 *
 * Throws a {@link TextureDecodeError} subclass for malformed lumps/records
 * and a {@link TexturePatchError} when a PNAMES entry names no lump (vanilla
 * "R_InitTextures: Missing patch in texture %s") or patch pixels are
 * malformed (cause preserved).
 */
export function decodeTextures(wad: WadFile, lumpName = 'TEXTURE1'): TextureDef[] {
  const bytes = wad.readLumpByName(lumpName);
  const pnames = decodePnames(wad.readLumpByName('PNAMES'));
  const lumpLen = bytes.length;
  if (lumpLen < 4) {
    throw new TextureLumpError(`${lumpName} lump truncated: ${lumpLen} bytes < 4`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numtextures = view.getInt32(0, true);
  if (numtextures < 0) {
    throw new TextureLumpError(`${lumpName} negative texture count ${numtextures}`);
  }
  if (4 + numtextures * 4 > lumpLen) {
    throw new TextureLumpError(
      `${lumpName} offset table truncated: ${numtextures} entries need ${
        4 + numtextures * 4
      } bytes, lump has ${lumpLen}`,
    );
  }

  const textures: TextureDef[] = [];
  const decoded = new Map<number, DecodedPatch>(); // patch-lump cache for this call

  for (let i = 0; i < numtextures; i += 1) {
    const offset = view.getInt32(4 + i * 4, true);
    // vanilla: `if (offset > maxoff) I_Error("bad texture directory")`
    if (offset < 0 || offset > lumpLen) {
      throw new TextureLumpError(
        `${lumpName} texture ${i} offset ${offset} outside lump (${lumpLen} bytes)`,
      );
    }
    const raw = parseTextureRecord(bytes, view, offset, lumpLen, i);
    const columns: Uint8Array[] = [];
    for (let x = 0; x < raw.width; x += 1) columns.push(new Uint8Array(raw.height));

    const patches: TexturePatch[] = [];
    for (const p of raw.patches) {
      if (p.patchNum < 0 || p.patchNum >= pnames.length) {
        throw new TexturePatchError(
          `texture '${raw.name}': patch index ${p.patchNum} outside PNAMES (0..${
            pnames.length - 1
          })`,
        );
      }
      const pname = pnames[p.patchNum] as string;
      const lump = wad.lumpNumByName(pname); // global last-match-wins (R02 §1)
      if (lump < 0) {
        throw new TexturePatchError(
          `texture '${raw.name}': PNAMES[${p.patchNum}] '${pname}' names no lump (vanilla: Missing patch)`,
        );
      }
      patches.push({ originX: p.originX, originY: p.originY, patchNum: lump });

      let patch = decoded.get(lump);
      if (patch === undefined) {
        try {
          patch = decodePatch(wad.readLump(lump));
        } catch (err) {
          throw new TexturePatchError(
            `texture '${raw.name}': patch '${pname}' (lump ${lump}) malformed`,
            { cause: err },
          );
        }
        decoded.set(lump, patch);
      }
      compositePatch(columns, raw.width, raw.height, patch, p.originX, p.originY);
    }
    textures.push({ name: raw.name, width: raw.width, height: raw.height, patches, columns });
  }
  return textures;
}

/* ------------------------------------------------------------------ */
/* Compositing (R_GenerateComposite / R_DrawColumnInCache)             */
/* ------------------------------------------------------------------ */

/** Composite one decoded patch onto the texture's column strips (see file header). */
function compositePatch(
  columns: Uint8Array[],
  texWidth: number,
  texHeight: number,
  patch: DecodedPatch,
  originX: number,
  originY: number,
): void {
  const xStart = Math.max(originX, 0); // R_GenerateComposite x1/x2 clamp
  const xEnd = Math.min(originX + patch.width, texWidth);
  for (let x = xStart; x < xEnd; x += 1) {
    const src = patch.columns[x - originX];
    const dst = columns[x];
    if (src === undefined || dst === undefined) continue;
    for (let r = 0; r < patch.height; r += 1) {
      const v = src[r] as number;
      if (v === 0) continue; // 0 = transparent (G1 contract)
      const y = r + originY; // R_DrawColumnInCache position = originy + topdelta
      if (y >= 0 && y < texHeight) dst[y] = v; // clipped, never wrapped
    }
  }
}

/* ------------------------------------------------------------------ */
/* Multi-lump merge + lookup + masked detection                        */
/* ------------------------------------------------------------------ */

/** TEXTURE1, then TEXTURE2 when present (r_data.c:461-472). */
export function texturesFromWad(wad: WadFile): TextureDef[] {
  const out = decodeTextures(wad, 'TEXTURE1');
  if (wad.has('TEXTURE2')) out.push(...decodeTextures(wad, 'TEXTURE2'));
  return out;
}

/** Case-insensitive name index; FIRST definition wins (R_CheckTextureNumForName). */
export function buildTextureIndex(textures: readonly TextureDef[]): Map<string, TextureDef> {
  const map = new Map<string, TextureDef>();
  for (const t of textures) {
    const key = t.name.toUpperCase();
    if (!map.has(key)) map.set(key, t);
  }
  return map;
}

/**
 * Masked-texture detection (M1-plan §M1-06): masked iff any transparent (0)
 * pixel exists in the composed bounding columns. The on-disk masked flag is
 * advisory only — vanilla never reads it for drawing.
 */
export function isMaskedTexture(texture: TextureDef): boolean {
  for (const col of texture.columns) {
    for (let i = 0; i < col.length; i += 1) {
      if ((col[i] as number) === 0) return true;
    }
  }
  return false;
}
