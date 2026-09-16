/**
 * WadFile — WAD container access (M1-01 contract skeleton).
 *
 * Signatures are byte-identical to ARCHITECTURE.md §2.1. Every method throws
 * a typed `unimplemented` error until M1-02 completes this class; parse is
 * the only construction path once implemented.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

// §2.1 declares LumpInfo alongside WadFile in this file; the type lives in
// ./types.ts so decoders can import all contracts from one module.
export type { LumpInfo } from './types';

export class WadFile {
  /** 'IWAD'/'PWAD' header + dir (R01 §1-2). Implemented in M1-02. */
  static parse(buf: ArrayBuffer): WadFile {
    void buf;
    throw new Error('unimplemented');
  }

  /** Container kind from the 4-byte header identification. */
  declare readonly identification: 'IWAD' | 'PWAD';

  /** Last-match wins, -1 absent (R01 §15). */
  lumpNumByName(name: string): number {
    void name;
    throw new Error('unimplemented');
  }

  /** By dir index (for range scans). */
  lumpNumAt(index: number): number {
    void index;
    throw new Error('unimplemented');
  }

  lumpName(num: number): string {
    void num;
    throw new Error('unimplemented');
  }

  /** Skips zero-size markers (R12 §9.7). */
  lumpRange(startMarker: string, endMarker: string): number[] {
    void startMarker;
    void endMarker;
    throw new Error('unimplemented');
  }

  /** Zero-copy subarray. */
  readLump(num: number): Uint8Array {
    void num;
    throw new Error('unimplemented');
  }

  readLumpByName(name: string): Uint8Array {
    void name;
    throw new Error('unimplemented');
  }

  has(name: string): boolean {
    void name;
    throw new Error('unimplemented');
  }
}
