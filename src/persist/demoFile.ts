// persist/demoFile.ts — M11-06 `.lmp` demo bytes: pure codec + file glue.
//
// FORMAT TRUTH (M11-plan §0.5, D-11e): 1.10 demo I/O is LUMP-only
// (G_DoPlayDemo's W_CacheLumpName, g_game.c:1588 — FILE demo loading does
// not exist in linuxdoom-1.10) and the pinned WAD ships ZERO DEMO lumps
// (D023). Our demos are therefore FIRST-CLASS BYTES: the recorded `.lmp`
// is a downloadable Blob (this module = the browser answer to
// M_WriteFile, g_game.c:1653), playback consumes Uint8Array from
// playDemo(bytes) or a loaded File (the `-playdemo file.lmp` half,
// d_main.c:1135-1141).
//
// ZONE RULE (D-11g): persist/ may import sim only through sim/state —
// so the 13-byte header layout is implemented HERE independently of
// src/sim/pDemo.ts. BOTH codecs are pinned against the SAME §0.5 byte
// table (cited per field below and in pDemo.ts); the tests pin each
// against an independent literal, and the sim-side record→replay golden
// (pDemo.test.ts) certifies the sim half end-to-end.
//
// Byte table (G_BeginRecording, g_game.c:1549-1570; 13 bytes total):
//   0  VERSION (=110, doomdef.h:33 — NOT 104/1.9)
//   1  gameskill        :1554   (1-based deferred-init domain)
//   2  gameepisode      :1555
//   3  gamemap          :1556
//   4  deathmatch       :1557
//   5  respawnparm      :1558
//   6  fastparm         :1559
//   7  nomonsters       :1560
//   8  consoleplayer    :1561
//   9..12  playeringame[0..3]  :1563-1565
// BODY: 4 bytes per playing player per tic — forwardmove int8, sidemove
// int8, (angleturn+128)>>8 u8, buttons u8 (:1491-1503/:1519-1522);
// terminator DEMOMARKER = 0x80 (:1489). NO checksum anywhere (D-11c).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { VERSION } from './codec'; // doomdef.h:33 (same constant)

/** g_game.c:1489 `#define DEMOMARKER 0x80`. */
export const DEMOMARKER = 0x80;
/** Header size (the 13 single-byte fields, g_game.c:1549-1570). */
export const DEMO_HEADER_SIZE = 13;
/** Bytes per PLAYING player per tic (§0.5; SP demos: 4). */
export const DEMO_TICCMD_BYTES = 4;
/** dstrings.h-idiom suffix (G_RecordDemo's strcat, g_game.c:1536). */
export const LMP_SUFFIX = '.lmp';

/** The 13-byte header as a struct. */
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

/** Size accounting (the acceptance row "DEMOMARKER + size accounting"). */
export interface DemoInspect {
  /** null when the buffer is shorter than a header. */
  header: DemoHeader | null;
  /** Whole tics readable after the header (body bytes / 4, excl. marker). */
  tics: number;
  /** True when a DEMOMARKER byte terminates the body (clean ending). */
  hasMarker: boolean;
  /** True when the stream ends mid-ticcmd (body % 4 != 0, no marker) —
   * the graceful truncation lane of gReadDemoTiccmd. */
  truncatedMidTic: boolean;
}

/** 13-byte header encode (byte table above). */
export function encodeDemoHeader(h: DemoHeader): Uint8Array {
  const b = new Uint8Array(DEMO_HEADER_SIZE);
  b[0] = h.version & 0xff;
  b[1] = h.skill & 0xff;
  b[2] = h.episode & 0xff;
  b[3] = h.map & 0xff;
  b[4] = h.deathmatch & 0xff;
  b[5] = h.respawnparm & 0xff;
  b[6] = h.fastparm & 0xff;
  b[7] = h.nomonsters & 0xff;
  b[8] = h.consoleplayer & 0xff;
  for (let i = 0; i < 4; i++) b[9 + i] = h.playeringame[i] ? 1 : 0;
  return b;
}

/** 13-byte header decode; null when shorter than the header. A wrong
 * VERSION byte is surfaced on `header.version` for the CALLER's guard —
 * the sim-side guard site is gDoPlayDemo (g_game.c:1589-1595). */
export function parseDemoHeader(bytes: Uint8Array): DemoHeader | null {
  if (bytes.length < DEMO_HEADER_SIZE) return null;
  return {
    version: bytes[0]!,
    skill: bytes[1]!,
    episode: bytes[2]!,
    map: bytes[3]!,
    deathmatch: bytes[4]!,
    respawnparm: bytes[5]!,
    fastparm: bytes[6]!,
    nomonsters: bytes[7]!,
    consoleplayer: bytes[8]!,
    playeringame: [bytes[9]! !== 0, bytes[10]! !== 0, bytes[11]! !== 0, bytes[12]! !== 0]
  };
}

/** Size accounting: body split at the first DEMOMARKER (the body never
 * contains 0x80 as a *forwardmove-position* byte in practice, but the
 * marker is only ever TESTED at a tic boundary — exactly like
 * gReadDemoTiccmd (:1493), which checks `*demo_p` after every 4-byte
 * group. A mid-tic 0x80 (buttons/angleturn byte) is data, not a marker. */
export function inspectDemo(bytes: Uint8Array): DemoInspect {
  const header = parseDemoHeader(bytes);
  const out = { header, tics: 0, hasMarker: false, truncatedMidTic: false };
  if (header === null) return out;
  let p = DEMO_HEADER_SIZE;
  while (p < bytes.length) {
    if (bytes[p] === DEMOMARKER) {
      out.hasMarker = true;
      return out;
    }
    if (p + DEMO_TICCMD_BYTES > bytes.length) {
      out.truncatedMidTic = true;
      return out;
    }
    p += DEMO_TICCMD_BYTES;
    out.tics++;
  }
  return out;
}

/** Blob for download (D-11e; the Blob global is zone-legal — only the
 * PLATFORM_ONLY_GLOBALS list is restricted). */
export function toLmpBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes.slice().buffer], { type: 'application/octet-stream' });
}

/** `name` → `name.lmp` (G_RecordDemo's suffix rule, g_game.c:1536). */
export function lmpFileName(name: string): string {
  return name.toLowerCase().endsWith(LMP_SUFFIX) ? name : name + LMP_SUFFIX;
}

/** Save-as-file WITHOUT importing `document` (zone-restricted global):
 * the DOM handles are reached through globalThis, runtime-guarded —
 * false in node/tests, true in the browser. */
export function downloadLmp(bytes: Uint8Array, name = 'doomdemo'): boolean {
  const g = globalThis as unknown as {
    document?: {
      createElement(tag: string): {
        href: string; download: string; style: { display: string };
        click(): void; textContent: string;
      };
      body?: { appendChild(el: unknown): unknown; removeChild(el: unknown): unknown };
    };
    URL?: {
      createObjectURL(blob: Blob): string;
      revokeObjectURL?(url: string): void;
    };
  };
  const doc = g.document;
  const url = g.URL;
  if (doc === undefined || url === undefined || doc.body === undefined) return false;
  const href = url.createObjectURL(toLmpBlob(bytes));
  const a = doc.createElement('a');
  a.href = href;
  a.download = lmpFileName(name);
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  url.revokeObjectURL?.(href);
  return true;
}

/** File / ArrayBuffer / bytes in → Uint8Array out (the `-playdemo` file
 * half, d_main.c:1135-1141). Anything with arrayBuffer() (File/Blob) is
 * read through it; plain bytes pass through unchanged. */
export async function loadLmp(
  src: Uint8Array | ArrayBuffer | { arrayBuffer(): Promise<ArrayBuffer> }
): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return src;
  if (src instanceof ArrayBuffer) return new Uint8Array(src);
  return new Uint8Array(await src.arrayBuffer());
}

export { VERSION };
