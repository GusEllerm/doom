/**
 * TEXTURE1 / TEXTURE2 / PNAMES decoders — M1-06.
 *
 * Facts pinned (R02 §7, R01 §14): PNAMES = int32 count + count x 8-byte
 * names (stride 8, NOT 16); texture records land on the vanilla
 * "struct copied to disk" layout — width@12, height@14, patchcount@20,
 * 10-byte patch rows at @22 (originx, originy, patch, stepdir, colormap).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { TextureDef } from './types';
import type { WadFile } from './wadfile';

/** Base class for malformed texture data. */
export class TextureDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Decode a PNAMES lump into uppercase patch names. Unimplemented (M1-06 WIP). */
export function decodePnames(_bytes: Uint8Array): string[] {
  throw new Error('unimplemented');
}

/** Decode one TEXTURE1/TEXTURE2 lump. Unimplemented (M1-06 WIP). */
export function decodeTextures(_wad: WadFile, _lumpName?: string): Map<string, TextureDef> {
  throw new Error('unimplemented');
}

/** Decode TEXTURE1 + TEXTURE2 (skip missing). Unimplemented (M1-06 WIP). */
export function texturesFromWad(_wad: WadFile): Map<string, TextureDef> {
  throw new Error('unimplemented');
}
