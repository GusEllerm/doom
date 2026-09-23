// persist/demoFile.ts — M11-06 `.lmp` bytes: pure codec + file glue.
// STUB (first-action commit). Format truth (M11-plan §0.5/§M11-06, D-11e):
// 1.10 demo I/O is lump-only; our demos are first-class BYTES — a
// downloadable Blob out, Uint8Array in. Zone rule (D-11g): this module
// duplicates the 13-byte header layout INDEPENDENT of src/sim/pDemo.ts
// (persist may import sim/state only); both codecs are pinned against the
// same §0.5 byte table, cited per field.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { VERSION } from './codec';

/** g_game.c:1489 DEMOMARKER. */
export const DEMOMARKER = 0x80;
/** Header size (g_game.c:1549-1570). */
export const DEMO_HEADER_SIZE = 13;
/** Bytes per playing player per tic (§0.5; SP demos: 4). */
export const DEMO_TICCMD_BYTES = 4;

export interface DemoHeader {
  version: number;
  skill: number;
  episode: number;
  map: number;
  deathmatch: number;
  respawnparm: number;
  fastparm: number;
  nomonsters: number;
  consoleplayer: number;
  playeringame: boolean[];
}

export interface DemoInspect {
  header: DemoHeader | null;
  /** Whole-tics readable after the header (excl. marker). */
  tics: number;
  hasMarker: boolean;
  /** True when bytes end mid-ticcmd (body length % 4 != 0 before marker). */
  truncatedMidTic: boolean;
}

/** 13-byte header encode (byte table §0.5). */
export function encodeDemoHeader(h: DemoHeader): Uint8Array {
  void h; // TODO M11-06
  return new Uint8Array(DEMO_HEADER_SIZE);
}

/** 13-byte header decode (null when shorter than the header). */
export function parseDemoHeader(bytes: Uint8Array): DemoHeader | null {
  void bytes; // TODO M11-06
  return null;
}

/** Size accounting for the acceptance table (marker + tics + truncation). */
export function inspectDemo(bytes: Uint8Array): DemoInspect {
  void bytes; // TODO M11-06
  return { header: null, tics: 0, hasMarker: false, truncatedMidTic: false };
}

/** Blob for download (D-11e: the browser answer to M_WriteFile). */
export function toLmpBlob(bytes: Uint8Array): Blob {
  void bytes; // TODO M11-06
  return new Blob();
}

/** Save-as-file via globalThis (guarded; false when no DOM — node tests). */
export function downloadLmp(bytes: Uint8Array, name = 'doomdemo'): boolean {
  void bytes; void name; // TODO M11-06
  return false;
}

/** File/array/bytes in → Uint8Array out (the -playdemo file half). */
export async function loadLmp(
  src: Uint8Array | ArrayBuffer | { arrayBuffer(): Promise<ArrayBuffer> }
): Promise<Uint8Array> {
  void src; // TODO M11-06
  return new Uint8Array();
}

export { VERSION };
