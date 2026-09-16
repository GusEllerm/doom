/**
 * TEXTURE1 / TEXTURE2 / PNAMES decoders — M1-06.
 *
 * Byte layouts pinned by R02 §7 / R01 §14 (verified byte-for-byte against
 * freedoom1.wad TEXTURE1, `AASTINKY` record):
 *
 *   PNAMES:    int32 count + count × 8-byte NUL-padded names — STRIDE 8.
 *              (Some secondary docs claim a 16-byte "name+reserved" pair;
 *              R01 §14 disproves it empirically: freedoom1 PNAMES size is
 *              4 + 8·1049 = 8396 exact, and r_data.c:446 reads `i*8`.)
 *   TEXTUREn:  int32 numtextures + int32 offsets (relative to lump start),
 *              then texture records at those offsets:
 *                0  char[8]   name (NUL-padded)
 *                8  int32     on-disk `boolean masked` struct-copy slot —
 *                             always 0 in real lumps and NEVER read by
 *                             vanilla (r_data.c copies only name/width/
 *                             height/patchcount, r_data.c:522-530); masked-
 *                             ness is derived from the composed columns
 *                             (M1-plan §M1-06 sentinel scan), so the M1-01
 *                             TextureDef contract carries no masked field.
 *                12 int16     width   (power of two in practice, R02 §7)
 *                14 int16     height
 *                16 int32     obsolete columndirectory (ignored)
 *                20 int16     patchcount
 *                22 10 bytes each: int16 originx, originy, patch, stepdir,
 *                   colormap — only the first three are real; vanilla copies
 *                   exactly those (r_data.c:536-538). `patch` is a plain
 *                   signed PNAMES index: R02 has NO 0x8000 semantics here
 *                   (0x8000/FF_FULLBRIGHT is the sprite-frame flag, R02 §10
 *                   fact 6, p_pspr.h).
 *
 * Patch-name resolution (R02 §1 row "Patches (walls)"): PNAMES entries are
 * resolved with the GLOBAL last-match-wins, case-insensitive lookup
 * (`W_CheckNumForName` scans the whole directory backwards, w_wad.c:376-388)
 * — NOT restricted to the P_START..P_END range; the S_START/S_END strings in
 * R_InitTextures only feed a progress print. A name resolving nowhere is
 * vanilla's `I_Error("Missing patch")` (r_data.c:446-453) → MissingPatchError.
 *
 * Compositing (r_data.c:228-284 R_GenerateComposite): patches are drawn in
 * TABLE ORDER for every texture — R02 §7 does NOT distinguish masked
 * textures in the composite loop (verified in the released code: one plain
 * `for (i=0; i<tex->patchcount; i++)`), so there is no "masked overlays
 * last" rule; the on-disk masked flag only selects a column renderer later.
 * Later patches overwrite earlier ones inside painted post runs. Out-of-
 * range placement CLIPS, it does not wrap: x is clamped to [0,width) before
 * indexing the patch (r_data.c:255-265) and R_DrawColumnInCache clips rows
 * at both edges (r_data.c:204-211); the `col &= widthmask` of R_GetColumn
 * (r_data.c:393) is renderer-side sampling of an already-built column, not
 * compositing. Transparent = 0: pixels a patch does not cover (post holes)
 * stay 0; given the M1-01 `DecodedPatch` representation (0 = transparent)
 * this matches vanilla on real lumps, whose post runs never contain 0 bytes.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { decodePatch } from './patch';
import type { DecodedPatch, TextureDef, TexturePatch } from './types';
import type { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Constants + typed errors                                            */
/* ------------------------------------------------------------------ */

/** PNAMES name stride in bytes (R02 §7, r_data.c:446 `i*8`). */
export const PNAME_STRIDE = 8;

/** Bytes of a texture record before its patch rows (R02 §7). */
export const TEXTURE_RECORD_BYTES = 22;

/** Bytes per mappatch row: 5 × int16 (R02 §7). */
export const TEXTURE_PATCH_BYTES = 10;

const NAME_FIELD = 8;

/** Base class for every malformed-texture condition. */
export class TextureDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** PNAMES missing/truncated or holding an impossible count. */
export class PnamesError extends TextureDecodeError {}

/** TEXTURE lump absent, truncated, or with a bad header/offset table. */
export class TextureOffsetError extends TextureDecodeError {}

/** A record is truncated or holds impossible width/height/patchcount. */
export class TextureRecordError extends TextureDecodeError {}

/** mappatch `patch` index outside [0, pnames.length). */
export class TexturePatchIndexError extends TextureDecodeError {}

/** A PNAMES name resolves to no lump (vanilla `I_Error("Missing patch")`). */
export class MissingPatchError extends TextureDecodeError {}

/* ------------------------------------------------------------------ */
/* decodePnames                                                        */
/* ------------------------------------------------------------------ */

/** Trim trailing NUL (and space) padding from a fixed-width lump name. */
function trimName(raw: string): string {
  const nul = raw.indexOf('\u0000');
  return (nul >= 0 ? raw.slice(0, nul) : raw).trimEnd();
}

/**
 * Decode a PNAMES lump: int32 count + count × 8-byte NUL-padded names,
 * returned trimmed and UPPERCASED (vanilla compares patch names case-
 * insensitively through W_CheckNumForName; uppercase is the canonical key).
 */
export function decodePnames(bytes: Uint8Array): string[] {
  if (bytes.length < 4) {
    throw new PnamesError(`PNAMES truncated: ${bytes.length} bytes < 4`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getInt32(0, true);
  if (count < 0 || 4 + count * PNAME_STRIDE > bytes.length) {
    throw new PnamesError(
      `PNAMES count ${count} inconsistent with lump size ${bytes.length}`,
    );
  }
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let raw = '';
    for (let c = 0; c < PNAME_STRIDE; c += 1) {
      raw += String.fromCharCode(bytes[4 + i * PNAME_STRIDE + c] as number);
    }
    names.push(trimName(raw).toUpperCase());
  }
  return names;
}

/* ------------------------------------------------------------------ */
/* decodeTextures / texturesFromWad                                    */
/* ------------------------------------------------------------------ */

/**
 * Decode one TEXTURE-format lump ('TEXTURE1' by default) into name-keyed
 * (UPPERCASE, first occurrence wins — vanilla's
 * R_CheckTextureNumForName scans the list forwards) fully composed
 * {@link TextureDef}s. PNAMES is read from `wad`; every referenced patch
 * lump is decoded once (cache keyed by lump number) and composited into
 * `columns` per the file-header rules.
 *
 * Throws a {@link TextureDecodeError} subclass for malformed lumps and a
 * {@link PatchDecodeError} for malformed patch lumps.
 */
export function decodeTextures(wad: WadFile, lumpName = 'TEXTURE1'): Map<string, TextureDef> {
  if (!wad.has(lumpName)) {
    throw new TextureOffsetError(`texture lump '${lumpName}' absent`);
  }
  if (!wad.has('PNAMES')) {
    throw new PnamesError("PNAMES lump absent (required by '" + lumpName + "')");
  }
  const pnames = decodePnames(wad.readLumpByName('PNAMES'));
  const bytes = wad.readLumpByName(lumpName);
  if (bytes.length < 4) {
    throw new TextureOffsetError(`${lumpName} truncated: ${bytes.length} bytes < 4`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getInt32(0, true);
  if (count < 0 || 4 + count * 4 > bytes.length) {
    throw new TextureOffsetError(`${lumpName} count ${count} inconsistent with size ${bytes.length}`);
  }

  const out = new Map<string, TextureDef>();
  const patchCache = new Map<number, DecodedPatch>();
  for (let i = 0; i < count; i += 1) {
    const off = view.getInt32(4 + i * 4, true);
    if (off < 0 || off + TEXTURE_RECORD_BYTES > bytes.length) {
      throw new TextureOffsetError(
        `${lumpName} record ${i} offset ${off} out of bounds (lump ${bytes.length} B)`,
      );
    }
    const rec = bytes.subarray(off);
    const recView = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
    let rawName = '';
    for (let c = 0; c < NAME_FIELD; c += 1) rawName += String.fromCharCode(rec[c] as number);
    const name = trimName(rawName);
    const key = name.toUpperCase();
    const width = recView.getInt16(12, true);
    const height = recView.getInt16(14, true);
    const patchcount = recView.getInt16(20, true); // width@12, height@14, pc@20 (R02 §7)
    if (patchcount < 0 || off + TEXTURE_RECORD_BYTES + patchcount * TEXTURE_PATCH_BYTES > bytes.length) {
      throw new TextureRecordError(
        `${lumpName} record '${name}' patchcount ${patchcount} runs past the lump`,
      );
    }
    if (width <= 0 || height <= 0) {
      throw new TextureRecordError(`${lumpName} record '${name}': impossible size ${width}x${height}`);
    }

    const entries: TexturePatch[] = [];
    const pixels: { originX: number; originY: number; patch: DecodedPatch }[] = [];
    for (let j = 0; j < patchcount; j += 1) {
      const at = TEXTURE_RECORD_BYTES + j * TEXTURE_PATCH_BYTES;
      const originX = recView.getInt16(at, true);
      const originY = recView.getInt16(at + 2, true);
      const palnump = recView.getInt16(at + 4, true); // int16 index; no flag bits (see header)
      if (palnump < 0 || palnump >= pnames.length) {
        throw new TexturePatchIndexError(
          `${lumpName} '${name}' patch ${j} index ${palnump} outside PNAMES (${pnames.length})`,
        );
      }
      const pname = pnames[palnump] as string;
      const lumpnum = wad.lumpNumByName(pname); // global last-match (R02 §1)
      if (lumpnum < 0) {
        throw new MissingPatchError(`${lumpName} '${name}': patch '${pname}' (PNAMES[${palnump}]) not in WAD`);
      }
      let patch = patchCache.get(lumpnum);
      if (patch === undefined) {
        patch = decodePatch(wad.readLump(lumpnum));
        patchCache.set(lumpnum, patch);
      }
      entries.push({ originX, originY, patchNum: lumpnum });
      pixels.push({ originX, originY, patch });
    }

    if (!out.has(key)) {
      // First duplicate name wins: R_CheckTextureNumForName scans forwards (r_data.c:692-727).
      out.set(key, { name, width, height, patches: entries, columns: compose(pixels, width, height) });
    }
  }
  return out;
}

/**
 * Decode the WAD's texture list: TEXTURE1, then TEXTURE2 appended with
 * TEXTURE1 entries winning on duplicate names — vanilla concatenates the
 * two lumps into one array and looks names up forwards (r_data.c:461-472,
 * 692-727). Lumps that are absent are skipped (PWADs may hold only one).
 */
export function texturesFromWad(wad: WadFile): Map<string, TextureDef> {
  const out = new Map<string, TextureDef>();
  for (const lump of ['TEXTURE1', 'TEXTURE2'] as const) {
    if (!wad.has(lump)) continue; // skip-if-missing
    for (const [key, def] of decodeTextures(wad, lump)) {
      if (!out.has(key)) out.set(key, def);
    }
  }
  return out;
}

/**
 * Paint patches onto zero-filled columns in TABLE ORDER (r_data.c:252-256 —
 * no masked re-ordering, see file header); later pixels overwrite earlier
 * ones, 0 (never painted / post holes) stays transparent, out-of-texture
 * placement clips (r_data.c:255-265, 204-211).
 */
function compose(
  patches: readonly { originX: number; originY: number; patch: DecodedPatch }[],
  width: number,
  height: number,
): Uint8Array[] {
  const columns: Uint8Array[] = [];
  for (let x = 0; x < width; x += 1) columns.push(new Uint8Array(height));
  for (const { originX, originY, patch } of patches) {
    const firstCol = Math.max(0, -originX);
    const lastCol = Math.min(patch.width, width - originX);
    const firstRow = Math.max(0, -originY);
    const lastRow = Math.min(patch.height, height - originY);
    for (let c = firstCol; c < lastCol; c += 1) {
      const src = patch.columns[c] as Uint8Array;
      const dst = columns[originX + c] as Uint8Array;
      for (let r = firstRow; r < lastRow; r += 1) {
        const v = src[r] as number;
        if (v !== 0) dst[originY + r] = v;
      }
    }
  }
  return columns;
}
