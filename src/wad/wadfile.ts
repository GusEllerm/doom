/**
 * WadFile — WAD container access (M1-02 implementation of the M1-01 skeleton).
 *
 * Signatures are byte-identical to ARCHITECTURE.md §2.1. Facts pinned from
 * R01 §1-3 (12-byte header, 16-byte dir entries), R01 §15.2 (names trimmed of
 * trailing NUL *and* space padding, case-insensitive compare, last-match
 * wins, -1 absent) and R12 §9.7 (ranges may contain zero-size markers —
 * nested P1_START/F1_START-style — which lumpRange must skip).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// §2.1 declares LumpInfo alongside WadFile in this file; the type lives in
// ./types.ts so decoders can import all contracts from one module.
export type { LumpInfo } from './types';
import type { LumpInfo } from './types';

/** Typed error for malformed container bytes (bad ident, dir past EOF, ...). */
export class WadParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WadParseError';
  }
}

/** Header = 4-byte ident + 2×int32 (R01 §1); dir entry = int32 pos, int32 size, 8-byte name (R01 §2). */
const HEADER_SIZE = 12;
const DIR_ENTRY_SIZE = 16;
const LUMP_NAME_SIZE = 8;

interface LumpEntry {
  /** Absolute data offset in the source buffer. */
  readonly filepos: number;
  /** Byte count; 0 = marker lump. */
  readonly size: number;
  /** Name with trailing 0x00/0x20 padding trimmed (R01 §15.2). */
  readonly name: string;
  /** Uppercase form used for case-insensitive lookups. */
  readonly nameUpper: string;
}

/** Trim trailing NUL *and* space padding (freedoom pads NUL, older tools space). */
function trimLumpName(name: string): string {
  const nul = name.indexOf('\u0000');
  return (nul >= 0 ? name.slice(0, nul) : name).trimEnd();
}

/** Canonical lookup key: trimmed + uppercased (R01 §2/§15.2). */
function lumpKey(name: string): string {
  return trimLumpName(name).toUpperCase();
}

export class WadFile {
  /** 'IWAD'/'PWAD' header + dir (R01 §1-2). */
  static parse(buf: ArrayBuffer): WadFile {
    if (buf.byteLength < HEADER_SIZE) {
      throw new WadParseError(`file too short for a WAD header (${buf.byteLength} bytes)`);
    }
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const ident = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
    if (ident !== 'IWAD' && ident !== 'PWAD') {
      throw new WadParseError(`bad identification '${ident}' (expected IWAD/PWAD)`);
    }
    const numLumps = view.getInt32(4, true);
    const dirOfs = view.getInt32(8, true);
    if (numLumps < 0 || dirOfs < 0) {
      throw new WadParseError(`negative numlumps (${numLumps}) or dir offset (${dirOfs})`);
    }
    if (dirOfs > buf.byteLength) {
      throw new WadParseError(`dir offset ${dirOfs} past EOF (${buf.byteLength} bytes)`);
    }
    if (dirOfs + numLumps * DIR_ENTRY_SIZE > buf.byteLength) {
      throw new WadParseError(
        `lump directory of ${numLumps} entries past EOF (${buf.byteLength} bytes)`,
      );
    }

    const entries: LumpEntry[] = [];
    const byName = new Map<string, number>();
    for (let i = 0; i < numLumps; i++) {
      const ofs = dirOfs + i * DIR_ENTRY_SIZE;
      const filepos = view.getInt32(ofs, true);
      const size = view.getInt32(ofs + 4, true);
      if (filepos < 0 || size < 0 || filepos + size > buf.byteLength) {
        throw new WadParseError(
          `lump ${i} data range [${filepos}, +${size}) past EOF (${buf.byteLength} bytes)`,
        );
      }
      let raw = '';
      for (let c = 0; c < LUMP_NAME_SIZE; c++) {
        raw += String.fromCharCode(bytes[ofs + 8 + c]!);
      }
      const name = trimLumpName(raw);
      const nameUpper = name.toUpperCase();
      entries.push({ filepos, size, name, nameUpper });
      // Scan forwards setting each name: the LAST definition wins (R01 §15.2).
      byName.set(nameUpper, i);
    }
    return new WadFile(buf, ident, entries, byName);
  }

  declare readonly identification: 'IWAD' | 'PWAD';

  private readonly buf: ArrayBuffer;
  private readonly entries: readonly LumpEntry[];
  private readonly byName: ReadonlyMap<string, number>;

  private constructor(
    buf: ArrayBuffer,
    identification: 'IWAD' | 'PWAD',
    entries: readonly LumpEntry[],
    byName: ReadonlyMap<string, number>,
  ) {
    this.buf = buf;
    this.identification = identification;
    this.entries = entries;
    this.byName = byName;
  }

  /** Last-match wins, -1 absent (R01 §15). */
  lumpNumByName(name: string): number {
    return this.byName.get(lumpKey(name)) ?? -1;
  }

  /** By dir index (for range scans). */
  lumpNumAt(index: number): number {
    return index >= 0 && index < this.entries.length ? index : -1;
  }

  lumpName(num: number): string {
    return this.entryAt(num).name;
  }

  /** Name + index of a lump by number. */
  lumpInfo(num: number): LumpInfo {
    this.entryAt(num);
    return { name: this.lumpName(num), lumpnum: num };
  }

  /**
   * Lumps between two markers, end-exclusive, zero-size markers skipped
   * (nested P1_START/F1_START etc., R12 §9.7). [] if the start marker is
   * absent; scans stop at the first end-marker match (or EOF).
   */
  lumpRange(startMarker: string, endMarker: string): number[] {
    const start = this.lumpNumByName(startMarker);
    if (start < 0) {
      return [];
    }
    const endKey = lumpKey(endMarker);
    const out: number[] = [];
    for (let i = start + 1; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      if (entry.nameUpper === endKey) {
        break;
      }
      if (entry.size > 0) {
        out.push(i);
      }
    }
    return out;
  }

  /** Zero-copy subarray. */
  readLump(num: number): Uint8Array {
    const entry = this.entryAt(num);
    return new Uint8Array(this.buf, entry.filepos, entry.size);
  }

  readLumpByName(name: string): Uint8Array {
    const num = this.lumpNumByName(name);
    if (num < 0) {
      throw new RangeError(`unknown lump '${name}'`);
    }
    return this.readLump(num);
  }

  has(name: string): boolean {
    return this.lumpNumByName(name) >= 0;
  }

  private entryAt(num: number): LumpEntry {
    const entry = Number.isInteger(num) ? this.entries[num] : undefined;
    if (entry === undefined) {
      throw new RangeError(`lump number ${num} out of range [0, ${this.entries.length})`);
    }
    return entry;
  }
}
