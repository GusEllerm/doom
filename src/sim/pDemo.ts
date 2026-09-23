// sim/pDemo.ts — G_RecordDemo/G_BeginRecording/G_ReadDemoTiccmd/
// G_WriteDemoTiccmd/G_CheckDemoStatus/G_DeferedPlayDemo/G_DoPlayDemo —
// the g_game.c:1489-1688 port (M11-plan §M11-06, format truth §0.5).
//
// FORMAT (§0.5, pinned): header = 13 bytes written by G_BeginRecording
// (g_game.c:1549-1570): VERSION(=110), gameskill, gameepisode, gamemap,
// deathmatch, respawnparm, fastparm, nomonsters, consoleplayer,
// playeringame[0..3]. Body = 4 bytes per PLAYING player per tic:
// forwardmove (int8), sidemove (int8), (angleturn+128)>>8 (u8), buttons
// (u8) — G_ReadDemoTiccmd (:1491-1503); terminator DEMOMARKER=0x80
// (:1489). NO per-tic checksum, NO desync detection in 1.10 (D-11c — the
// consistancy[] machinery :685-697 guards NETGAME netcmds only).
//
// THE RECORD/REPLAY IDENTITY TRICK (:1506-1523, verbatim): recording does
// write-4 / rewind-4 / G_ReadDemoTiccmd-re-read — so the LIVE recorded run
// consumes the byte-QUANTIZED ticcmd (angleturn is stored with 1/256-turn
// resolution: write `(angleturn+128)>>8`, read `byte<<8` with int16 wrap),
// and playback reads the same 4 bytes ⇒ record ⇒ replay hash identity BY
// CONSTRUCTION, at whatever price in turn quantization. Quantization is
// therefore present on BOTH runs (this is why the golden property passes
// even though a raw G_BuildTiccmd angleturn never equals its demo bytes).
//
// INPUT MOUNT (the plan's "how does our input architecture accept demo
// cmds"): game.ts gTicker step 3 — PLAYBACK skips G_BuildTiccmd entirely
// and reads the cmd from the demo bytes (the faithful g_game.c:650-666
// half: `if (demoplayback) G_ReadDemoTiccmd(cmd); else { G_BuildTiccmd;
// if (demorecording) G_WriteDemoTiccmd; }`). The platform input snapshot
// is ignored while demoplayback; no bypass loop (D-11e: playback steps
// through the normal tick path).
//
// MODULE STATICs mirror the g_game.c file-scope globals (same idiom as
// game.ts's saveGameslot — the vanilla single-run globals; resetDemo()
// clears them with the counters for tests). NOT hashed (A-02: pure I/O
// state, zero sim-stream effect besides the ticcmd injection above).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { emitCapture } from './hooks';
import type { GameState } from './state';
import { type Ticcmd } from './ticcmd';

/* ------------------------------------------------------------------ */
/* Constants (g_game.c / doomdef.h)                                    */
/* ------------------------------------------------------------------ */

/** doomdef.h:33 VERSION (= the savegame header's, persist/codec.ts). */
export const VERSION = 110;
/** g_game.c:1489 `#define DEMOMARKER 0x80`. */
export const DEMOMARKER = 0x80;
/** Header size = the 13 single-byte fields of G_BeginRecording. */
export const DEMO_HEADER_SIZE = 13;
/** g_game.c:1538 `maxdemo = 0x20000` default (`-maxdemo` KB override —
 * our debug-seam option, no cmdline; D-11e). */
export const MAXDEMO = 0x20000;
/** MAXPLAYERS (doomdef.h:57). */
export const MAXPLAYERS = 4;

/** Outcome of one gWriteDemoTiccmd call (g_game.c:1506-1523 lanes). */
export type WriteOutcome = 'ok' | 'quit' | 'full';
/** Outcome of one gReadDemoTiccmd call (g_game.c:1491-1503 lanes). */
export type ReadOutcome = 'ok' | 'end';
/** What gCheckDemoStatus just ended (g_game.c:1647-1688 branches). */
export type CheckOutcome = 'none' | 'recorded' | 'playend';

/** The 13-byte header as a struct (§0.5). */
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

/* ------------------------------------------------------------------ */
/* Module statics (g_game.c:1477-1487 file-scope globals)              */
/* ------------------------------------------------------------------ */

let demorecording = false; // g_game.c:1479
let demoplayback = false; // g_game.c:1480
let netdemo = false; // g_game.c:1481 (:1611-1615 ⇒ playback-only)
let demoname = 'demosave1'; // :1477 demoname[16] + ".lmp" (M_WriteFile)
let recordBuf: Uint8Array | null = null; // demobuffer (Z_Malloc :1542)
let recordP = 0; // demo_p
let recordEnd = 0; // demoend
let playBuf: Uint8Array | null = null; // the "lump" (bytes in; D-11e)
let playP = 0; // demo_p during playback
let pendingDemoBytes: Uint8Array | null = null; // G_DeferedPlayDemo carrier
let lastDemoOut: Uint8Array | null = null; // the "M_WriteFile" product
// Header-set flags (g_game.c deathmatch/respawnparm/fastparm/nomonsters/
// consoleplayer/playeringame — this build's truth values are all 0/false
// except playeringame[0]=true, consoleplayer=0; gDoPlayDemo overwrites
// them, gCheckDemoStatus restores; recorded headers carry the defaults).
const demoParams = {
  deathmatch: 0,
  respawnparm: 0,
  fastparm: 0,
  nomonsters: 0,
  consoleplayer: 0,
  playeringame: [true, false, false, false] as boolean[]
};

/** Observability counters (NEVER hashed; M11-10 mirrors into
 * state().persist). `versionWarnings` = the :1589-1595 warn lane. */
export const demoFlow = {
  recordsDone: 0,
  playsDone: 0,
  lastRecordTic: -1,
  lastPlayEndTic: -1,
  versionWarnings: 0
};

export function resetDemo(): void {
  demorecording = false;
  demoplayback = false;
  netdemo = false;
  demoname = 'demosave1';
  recordBuf = null;
  recordP = 0;
  recordEnd = 0;
  playBuf = null;
  playP = 0;
  pendingDemoBytes = null;
  lastDemoOut = null;
  demoParams.deathmatch = 0;
  demoParams.respawnparm = 0;
  demoParams.fastparm = 0;
  demoParams.nomonsters = 0;
  demoParams.consoleplayer = 0;
  demoParams.playeringame = [true, false, false, false];
  demoFlow.recordsDone = 0;
  demoFlow.playsDone = 0;
  demoFlow.lastRecordTic = -1;
  demoFlow.lastPlayEndTic = -1;
  demoFlow.versionWarnings = 0;
}

export function demoRecording(): boolean {
  return demorecording;
}

export function demoPlaying(): boolean {
  return demoplayback;
}

/** netdemo (g_game.c:1615) — TRUE ONLY on a playback whose header has
 * playeringame[1]; this single-player build never spawns slot 1, so the
 * flag is a documented faithful carry (M12 netgames consume it). */
export function netDemo(): boolean {
  return netdemo;
}

/** Live view of the header-set flags (playback only; defaults otherwise). */
export function demoParamsLive(): Readonly<typeof demoParams> {
  return demoParams;
}

/** Last finished recording's bytes (the M_WriteFile product), or null. */
export function demoBytes(): Uint8Array | null {
  return lastDemoOut;
}

/* ------------------------------------------------------------------ */
/* Recording (g_game.c:1530-1570)                                      */
/* ------------------------------------------------------------------ */

/** G_RecordDemo (g_game.c:1530-1546): demoname += ".lmp", maxdemo buffer
 * (`maxdemoKb` ≡ the `-maxdemo` cmdline option — the debug seam passes
 * it; no in-game record key exists in 1.10, §0.5), demorecording=true.
 * BeginRecording follows at the loop top (d_main.c:356-357) — use
 * {@link gStartRecordDemo} for the pair. */
export function gRecordDemo(name = 'demosave1', maxdemoKb?: number): void {
  demoname = `${name}.lmp`; // :1536 strcat(demoname,".lmp")
  const max = maxdemoKb === undefined ? MAXDEMO : maxdemoKb * 1024; // :1538-1540
  recordBuf = new Uint8Array(max); // Z_Malloc(PU_STATIC) :1542
  recordP = 0;
  recordEnd = max;
  demorecording = true; // :1545
}

/** G_BeginRecording (g_game.c:1549-1570): write the 13-byte header. The
 * flag fields are the build constants (single-player: deathmatch/
 * respawn/fast/nomonsters = 0, consoleplayer = 0, playeringame[0] = the
 * state's slot count — this port always has exactly one playing slot). */
export function gBeginRecording(state: GameState): void {
  if (recordBuf === null) return;
  recordP = 0;
  const b = recordBuf;
  b[recordP++] = VERSION; // :1553
  b[recordP++] = state.gameskill; // :1554 (1-based deferred-init domain)
  b[recordP++] = state.gameepisode; // :1555
  b[recordP++] = state.gamemap; // :1556
  b[recordP++] = demoParams.deathmatch; // :1557
  b[recordP++] = demoParams.respawnparm; // :1558
  b[recordP++] = demoParams.fastparm; // :1559
  b[recordP++] = demoParams.nomonsters; // :1560
  b[recordP++] = demoParams.consoleplayer; // :1561
  for (let i = 0; i < MAXPLAYERS; i++) {
    b[recordP++] = demoParams.playeringame[i] ? 1 : 0; // :1563-1565
  }
  void state.players.length; // invariant: playeringame[0] ⇔ players[0]
}

/** d_main.c:356-357 (the -record pair at the loop top). */
export function gStartRecordDemo(
  state: GameState, name?: string, maxdemoKb?: number
): void {
  gRecordDemo(name, maxdemoKb);
  gBeginRecording(state);
}

/** The `gamekeydown['q']` mount (g_game.c:1508): 1.10 polls the raw key
 * state INSIDE G_WriteDemoTiccmd — the sim has no key array, so the
 * platform (key responder / M11-10 debug seam) calls THIS and the flag
 * is consumed at the identical site next tic. */
let recordStopRequested = false;
export function gRequestStopRecord(): void {
  recordStopRequested = true;
}

/** G_WriteDemoTiccmd (g_game.c:1506-1523) — the write-rewind-read trick.
 * The 4 bytes go out FIRST, then demo_p rewinds and gReadDemoTiccmd
 * RE-READS them into cmd (net advance stays 4/tic) — cmd is MUTATED to
 * its byte-quantized form, which is what makes the recorded run and any
 * replay bit-identical (see header comment). Returns the vanilla stop
 * lane ('quit' = 'q' pressed :1508-1512, 'full' = buffer guard at
 * demoend-16 :1514-1517); the caller runs gCheckDemoStatus on either. */
export function gWriteDemoTiccmd(state: GameState, cmd: Ticcmd): WriteOutcome {
  if (recordStopRequested) {
    // if (gamekeydown['q']) { G_CheckDemoStatus(); return; }  (:1508)
    recordStopRequested = false;
    return 'quit';
  }
  const b = recordBuf;
  if (b === null) return 'ok';
  if (recordP > recordEnd - 16) {
    // if (demo_p > demoend - 16) — no more space (:1514-1517)
    return 'full';
  }
  b[recordP++] = cmd.forwardmove & 0xff; // :1519 (int8 field)
  b[recordP++] = cmd.sidemove & 0xff; // :1520
  b[recordP++] = ((cmd.angleturn + 128) >> 8) & 0xff; // :1521
  b[recordP++] = cmd.buttons & 0xff; // :1522
  // demo_p -= 4; G_ReadDemoTiccmd(cmd);  — the trick, inlined (the re-read
  // advances the SAME 4, net 4/tic). state is unused on this path but the
  // signature mirrors the read side (call-site symmetry in game.ts).
  void state;
  demoBytesInto(cmd, b, () => recordP++);
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* The 4-byte ticcmd codec (g_game.c:1491-1503 read side)              */
/* ------------------------------------------------------------------ */

/** Read the DEMOMARKER-excluded 4 bytes at `at()` into cmd — shared by
 * G_ReadDemoTiccmd and the write-rewind-read re-read. Byte semantics
 * verbatim: forwardmove/sidemove SIGNED chars; angleturn = (unsigned
 * char)*demo_p++ << 8 with the C `short` assignment wrap; buttons
 * unsigned. */
function demoBytesInto(cmd: Ticcmd, b: Uint8Array, at: () => number): void {
  cmd.forwardmove = (b[at()]! << 24) >> 24; // ((signed char)*demo_p++)
  cmd.sidemove = (b[at()]! << 24) >> 24;
  cmd.angleturn = (((b[at()]! & 0xff) << 8) << 16) >> 16; // u8<<8 → int16 wrap
  cmd.buttons = b[at()]! & 0xff;
}

/** G_ReadDemoTiccmd (g_game.c:1491-1503): DEMOMARKER ⇒ 'end' with cmd
 * UNCHANGED (vanilla calls G_CheckDemoStatus and returns before touching
 * cmd — the caller keeps last tic's command, the localcmds retention).
 * FAITHFUL-ADJACENT: 1.10 has NO bounds check on the lump (it cannot —
 * W_CacheLumpName is sealed at a marker); a truncated byte stream is
 * therefore given the SAME lane as the marker (end-of-bytes ⇒ 'end',
 * graceful per the M11-06 acceptance line; vanilla would read past the
 * buffer). Multi-player (netdemo) bodies carry 4 bytes per playing slot
 * — single-player reads the consoleplayer slot only; M12 loops
 * playeringame[] here. */
export function gReadDemoTiccmd(state: GameState, cmd: Ticcmd): ReadOutcome {
  const b = playBuf;
  if (b === null) {
    // Unarmed playback — demo params say "playing", bytes do not:
    // treat as end-of-stream (same lane as the marker).
    void state;
    return 'end';
  }
  if (playP >= b.length || b[playP] === DEMOMARKER) return 'end';
  demoBytesInto(cmd, b, () => playP++);
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* Stop / end (g_game.c:1647-1688)                                     */
/* ------------------------------------------------------------------ */

/** G_CheckDemoStatus (g_game.c:1647-1688).
 * RECORD branch (:1650-1657): demorecording=false, append DEMOMARKER,
 * "M_WriteFile(demoname, demobuffer, demo_p-demobuffer)" → the bytes go
 * to captureSink kind 'demo' (D-11e; the persist layer owns the Blob /
 * download — demoFile.ts). The vanilla I_Error("Demo %s recorded")
 * (:1683) success announcement becomes the ledger record (an I_Error
 * exit is the one unfaithful-lane we refuse; counted, not silent).
 * PLAYBACK branch (:1658-1675): demoplayback=false, reset ALL header
 * flags to this build's truth values, return 'playend' — the caller
 * routes the vanilla D_AdvanceDemo() half (game.ts arms
 * state.advancedemo → the M9-10 attract/title consumer, D023). */
export function gCheckDemoStatus(state: GameState): CheckOutcome {
  if (demorecording) {
    demorecording = false;
    const b = recordBuf;
    if (b !== null && recordP < recordEnd) b[recordP++] = DEMOMARKER; // :1652
    lastDemoOut = b === null ? new Uint8Array(0) : b.slice(0, recordP); // :1653
    emitCapture({
      kind: 'demo',
      slot: -1,
      description: demoname, // :1653 demoname rides as the description
      snapshot: lastDemoOut,
      tic: state.gametic
    });
    demoFlow.recordsDone++;
    demoFlow.lastRecordTic = state.gametic;
    recordBuf = null; // vanilla's Z_Free half of M_WriteFile teardown
    return 'recorded';
  }
  if (!demoplayback) return 'none';
  demoplayback = false;
  netdemo = false; // :1660-1662 half
  demoParams.deathmatch = 0; // :1663-1667 flag reset
  demoParams.respawnparm = 0;
  demoParams.fastparm = 0;
  demoParams.nomonsters = 0;
  demoParams.consoleplayer = 0;
  demoParams.playeringame = [true, false, false, false];
  playBuf = null;
  playP = 0;
  state.usergame = true; // :1616's inverse (usergame=false armed playback)
  demoFlow.playsDone++;
  demoFlow.lastPlayEndTic = state.gametic;
  return 'playend';
}

/* ------------------------------------------------------------------ */
/* Playback (g_game.c:1576-1625)                                       */
/* ------------------------------------------------------------------ */

/** G_DeferedPlayDemo (g_game.c:1576-1580): store the bytes (the
 * defdemoname "lump" of :1578 becomes first-class BYTES, D-11e — the
 * browser answer to lump-only I/O, §0.5 FINDING) and arm ga_playdemo;
 * G_DoPlayDemo runs in the NEXT drain (never mid-tic, §0.3 idiom). */
export function gDeferedPlayDemo(state: GameState, bytes: Uint8Array): void {
  pendingDemoBytes = bytes;
  state.gameaction = 5; // GA.playdemo — literal (game.ts owns the enum;
  // importing GA would cycle game.ts ⇄ pDemo.ts).
}

/** G_DoPlayDemo (g_game.c:1582-1625) — the ga_playdemo drain body.
 * `initNew` is game.ts's gInitNew INJECTED (the import graph stays
 * acyclic: game.ts imports pDemo.ts, never the reverse). Order:
 *  1. take the bytes (the W_CacheLumpName half :1588);
 *  2. VERSION guard (:1589-1595): mismatch ⇒ the vanilla
 *     WarnConsole("unhandled version") lane + return with ga_nothing
 *     (the drain already cleared gameaction) — demo is DROPPED, the
 *     current game keeps running; counted in demoFlow.versionWarnings
 *     (console stays clean for the zero-console gates);
 *  3. header → demoParams + state.gameskill/gameepisode/gamemap
 *     (:1600-1610); playeringame[1] ⇒ netdemo (:1611-1615);
 *  4. precache=false (no-op in this port — no WAD precache lane);
 *  5. G_InitNew(gameskill, gameepisode, gamemap) (:1618) — the FULL
 *     level rebuild incl. M_ClearRandom; the WRONG-SKILL/EPISODE guard
 *     site is inside it: gamemode.ts clampNewGame (g_game.c:1367-1398
 *     clamp table — skill 6→5, ep 0/4→1 etc.).
 *  6. demoplayback=true, usergame=false (:1617/:1620 halves — saves and
 *     cheats are demo-inhibited downstream via state.usergame).
 * Returns true when playback armed. */
export function gDoPlayDemo(
  state: GameState,
  initNew: (s: GameState, skill: number, ep: number, map: number) => void
): boolean {
  const bytes = pendingDemoBytes;
  pendingDemoBytes = null;
  if (bytes === null) return false;
  if (bytes.length < DEMO_HEADER_SIZE) {
    demoFlow.versionWarnings++; // too-short = unusable, same drop lane
    return false;
  }
  if (bytes[0] !== VERSION) {
    // :1589-1595 `if (*demop != VERSION) fprintf(stderr, "G_DoPlayDemo:
    // unhandled version %d\n", *demop), gameaction = ga_nothing, return`.
    demoFlow.versionWarnings++;
    return false;
  }
  demoParams.deathmatch = bytes[4]!;
  demoParams.respawnparm = bytes[5]!;
  demoParams.fastparm = bytes[6]!;
  demoParams.nomonsters = bytes[7]!;
  demoParams.consoleplayer = bytes[8]!;
  for (let i = 0; i < MAXPLAYERS; i++) demoParams.playeringame[i] = bytes[9 + i] !== 0 && bytes[9 + i] !== undefined;
  state.gameskill = bytes[1]!;
  state.gameepisode = bytes[2]!;
  state.gamemap = bytes[3]!;
  if (demoParams.playeringame[1]) {
    netdemo = true; // :1611-1615 (netgame=true half is M12; see netDemo())
    demoParams.consoleplayer = 0;
  }
  // precache = false;  (:1617 — no-op here, documented)
  initNew(state, state.gameskill, state.gameepisode, state.gamemap); // :1618
  demoplayback = true; // :1620
  state.usergame = false; // :1617 (usergame=false ⇒ save/cheat inhibit)
  playBuf = bytes;
  playP = DEMO_HEADER_SIZE;
  return true;
}
