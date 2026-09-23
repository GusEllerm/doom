// sim/cheats.ts — the m_cheat.c sequence engine + the 1.10 sequence tables
// + the ST_Responder effect bodies that are pure-sim (M11-09, M11-plan §0.7).
//
// GROUND TRUTH (verified against linuxdoom-1.10, not folklore):
//   * Engine: cht_CheckCheat (m_cheat.c:43-75) / cht_GetParam (:78-99), the
//     bit-permutation SCRAMBLE macro (m_cheat.h:30-32). Sequences are stored
//     SCRAMBLED, 0xff ends a sequence, the byte `1` marks "parameter data
//     starts at the next slot", a slot holding `0` captures the NEXT typed
//     key RAW into the sequence buffer (that is how idclev##/idmus## digits
//     are carried). There is NO time decay: the cursor is per-sequence,
//     advanced/reset by EVERY keydown the responder feeds it — vanilla has
//     no "escape" rule, so a stray key that mismatches merely rewinds that
//     one cursor to 0 (m_cheat.c:64 `cht->p = cht->sequence`) and is NOT
//     retried against seq[0] (m_cheat.c:57-60 stores/matches, the else at
//     :61-64 resets without re-lookahead).
//   * SCRAMBLE is its own inverse (the macro permutes bit pairs
//     0<->7, 1<->6, 3<->4 and keeps bits 2 and 5 — see the decode test), so
//     the tables can be decoded for the ledger with scramble() itself.
//   * d_main.c contains ZERO cheat code in 1.10; the responders that feed
//     the engine are ST_Responder (st_stuff.c:515-724 → cheatResponder.ts)
//     and AM_Responder's iddt (am_map.c:287/:701 → amMap.ts).
//
// The effect bodies below are the st_stuff.c mutation blocks verbatim; the
// responder (src/ui/cheatResponder.ts) keeps vanilla's if/else-if feeding
// order and fires the hooks.cheatSink ledger for each effect (D-11f).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GameState } from './state';
import { CF_GODMODE, CF_NOCLIP, MF_NOCLIP, MF_NOGRAVITY, NUMCARDS } from './player';
import {
  INVULNTICS, P_GivePower, PW, WP, NUMAMMO, NUMWEAPONS
} from './p_inter_pickup';
import type { PickupPlayer } from './p_inter_inventory';
import { GAME_MODE, type GameMode } from './gamemode';

/* ------------------------------------------------------------------ */
/* SCRAMBLE (m_cheat.h:30-32), verbatim                                */
/* ------------------------------------------------------------------ */

/** The cheat_xlate_table entry for a typed byte (m_cheat.c:54-58 builds the
 * table as SCRAMBLE(i) for all 256 bytes; we compute it directly — the
 * table is a pure function). Involution: scramble(scramble(x)) === x. */
export function scramble(a: number): number {
  return (
    (((a & 1) << 7) +
      ((a & 2) << 5) +
      (a & 4) +
      ((a & 8) << 1) +
      ((a & 16) >> 1) +
      (a & 32) +
      ((a & 64) >> 5) +
      ((a & 128) >> 7)) &
    0xff
  );
}

/* ------------------------------------------------------------------ */
/* cheatseq_t (m_cheat.h:34-38) — sequence buffer + cursor             */
/* ------------------------------------------------------------------ */

/** Vanilla `cheatseq_t { unsigned char *sequence; unsigned char *p; }`: the
 * pointer `p` is modeled as an index. The buffer is MUTABLE because
 * cht_CheckCheat writes typed parameter bytes into the `0` slots and
 * cht_GetParam zeroes them again (m_cheat.c:57/:88-92). */
export interface CheatSeq {
  seq: number[];
  p: number;
}

/** Fresh instance from a table (deep copy — parameter writes must not
 * poison the shared table). Vanilla statics init `p = 0` lazily. */
export function createCheatSeq(table: readonly number[]): CheatSeq {
  return { seq: [...table], p: 0 };
}

/** cht_CheckCheat (m_cheat.c:43-75), line-for-line. `key` is ev->data1
 * (lowercase ASCII for printables, input/keyboard.ts). Returns true once,
 * on the keystroke that lands the 0xff. */
export function chtCheckCheat(cht: CheatSeq, key: number): boolean {
  let rc = 0;
  if (cht.seq[cht.p] === 0) {
    cht.seq[cht.p] = key; // parameter slot: store the RAW key
    cht.p++;
  } else if (scramble(key) === cht.seq[cht.p]) {
    cht.p++;
  } else {
    cht.p = 0;
  }
  if (cht.seq[cht.p] === 1) {
    cht.p++; // parameter-start marker: skipped on the way through
  } else if (cht.seq[cht.p] === 0xff) {
    cht.p = 0;
    rc = 1;
  }
  return rc === 1;
}

/** cht_GetParam (m_cheat.c:78-99). Reads the parameter region (the bytes
 * after the `1` marker), zeroing it so the sequence is re-usable; returns
 * the captured string (usually 2 chars). Deviation guard: vanilla scans
 * past the end for a `1` in parameterless sequences (never happens —
 * GetParam is only called after a successful idmus/idclev); here the scan
 * stops at the buffer end and returns '' (documented, unreachable). */
export function chtGetParam(cht: CheatSeq): string {
  let p = 0;
  while (p < cht.seq.length && cht.seq[p] !== 1) p++; // while (*(p++) != 1)
  let out = '';
  let c = 0;
  do {
    c = cht.seq[p] ?? 0;
    out += String.fromCharCode(c);
    cht.seq[p] = 0;
    p++;
  } while (c !== 0 && (cht.seq[p] ?? 0xff) !== 0xff);
  return out; // the trailing `if (*p==0xff) *buffer = 0` is the NUL — implicit in a string
}

/* ------------------------------------------------------------------ */
/* The sequence tables (st_stuff.c:400-464, am_map.c:287) — scrambled  */
/* bytes VERBATIM; decoded names verified by the decode test.          */
/* ------------------------------------------------------------------ */

/** st_stuff.c:400-403 — `idmus<ep><map>` (two raw digit slots). */
export const CHEAT_MUS_SEQ: readonly number[] = [0xb2, 0x26, 0xb6, 0xae, 0xea, 1, 0, 0, 0xff];
/** st_stuff.c:405-408 — `idchoppers`. */
export const CHEAT_CHOPPERS_SEQ: readonly number[] = [
  0xb2, 0x26, 0xe2, 0x32, 0xf6, 0x2a, 0x2a, 0xa6, 0x6a, 0xea, 0xff
];
/** st_stuff.c:410-413 — `iddqd`. */
export const CHEAT_GOD_SEQ: readonly number[] = [0xb2, 0x26, 0x26, 0xaa, 0x26, 0xff];
/** st_stuff.c:415-418 — `idkfa`. */
export const CHEAT_AMMO_SEQ: readonly number[] = [0xb2, 0x26, 0xf2, 0x66, 0xa2, 0xff];
/** st_stuff.c:420-423 — `idfa`. */
export const CHEAT_AMMONOKEY_SEQ: readonly number[] = [0xb2, 0x26, 0x66, 0xa2, 0xff];
/** st_stuff.c:427-431 — `idspispopd` (the "noclip" the source COMMENT
 * mentions has NO sequence in 1.10: only this and idclip exist). */
export const CHEAT_NOCLIP_SEQ: readonly number[] = [
  0xb2, 0x26, 0xea, 0x2a, 0xb2, 0xea, 0x2a, 0xf6, 0x2a, 0x26, 0xff
];
/** st_stuff.c:434-437 — `idclip`. */
export const CHEAT_COMMERCIAL_NOCLIP_SEQ: readonly number[] = [
  0xb2, 0x26, 0xe2, 0x36, 0xb2, 0x2a, 0xff
];
/** st_stuff.c:441-451 — `idbehold[v s i r a l]`, then bare `idbehold` [6].
 * Index i == the powertype_t index it toggles (doomdef.h:213-223). */
export const CHEAT_POWERUP_SEQS: readonly (readonly number[])[] = [
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0x6e, 0xff], // idbeholdv → pw_invulnerability
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0xea, 0xff], // idbeholds → pw_strength
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0xb2, 0xff], // idbeholdi → pw_invisibility
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0x6a, 0xff], // idbeholdr → pw_ironfeet
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0xa2, 0xff], // idbeholda → pw_allmap
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0x36, 0xff], // idbeholdl → pw_infrared
  [0xb2, 0x26, 0x62, 0xa6, 0x32, 0xf6, 0x36, 0x26, 0xff] // idbehold  → menu hint message
];
/** st_stuff.c:453-457 — `idclev<ep><map>`. */
export const CHEAT_CLEV_SEQ: readonly number[] = [0xb2, 0x26, 0xe2, 0x36, 0xa6, 0x6e, 1, 0, 0, 0xff];
/** st_stuff.c:460-462 — `idmypos`. */
export const CHEAT_MYPOS_SEQ: readonly number[] = [0xb2, 0x26, 0xb6, 0xba, 0x2a, 0xf6, 0xea, 0xff];
/** am_map.c:287 — `iddt` (automap overlay cycle; fed by AM_Responder, NOT
 * by ST_Responder — see amMap.ts's chtCheckCheat). */
export const CHEAT_AMAP_SEQ: readonly number[] = [0xb2, 0x26, 0x26, 0x2e, 0xff];

/** Ledger helper: decode a scrambled table to its typed string ('.' for the
 * 1/0/0xff structural bytes; digits shown as '#' for the parameter slots). */
export function cheatDecode(table: readonly number[]): string {
  let out = '';
  for (const b of table) {
    if (b === 0xff || b === 1 || b === 0) continue;
    out += String.fromCharCode(scramble(b));
  }
  const params = table.filter((b) => b === 0).length;
  return out + '#'.repeat(params);
}

/* ------------------------------------------------------------------ */
/* STSTR_* — the cheat messages, d_englsh.h:339-355 (exact strings)    */
/*                                                                     */
/* TEXTDATA PATCH-LIST (M11-03 owns src/ui/textdata.ts): these strings  */
/* belong there per plan §M11-09; until M11-03 merges they live HERE so */
/* this module is self-contained — MOVE, do not duplicate.              */
/* ------------------------------------------------------------------ */

export const STSTR = {
  MUS: 'Music Change', // d_englsh.h:339
  NOMUS: 'IMPOSSIBLE SELECTION', // :340
  DQDON: 'Degreelessness Mode On', // :341
  DQDOFF: 'Degreelessness Mode Off', // :342
  KFAADDED: 'Very Happy Ammo Added', // :344
  FAADDED: 'Ammo (no keys) Added', // :345
  NCON: 'No Clipping Mode ON', // :347
  NCOFF: 'No Clipping Mode OFF', // :348
  BEHOLD: 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp', // :350
  BEHOLDX: 'Power-up Toggled', // :351
  CHOPPERS: "... doesn't suck - GM", // :353
  CLEV: 'Changing Level...' // :354
} as const;

/* ------------------------------------------------------------------ */
/* Effect bodies (the st_stuff.c:549-723 mutation blocks, verbatim)    */
/* ------------------------------------------------------------------ */

const plr = (state: GameState) => state.players[0]!;
const inv = (state: GameState) => state.players[0] as unknown as PickupPlayer;

/** st_stuff.c:549-563 — `iddqd`. */
export function cheatGod(state: GameState): void {
  const p = plr(state);
  p.cheats ^= CF_GODMODE;
  if (p.cheats & CF_GODMODE) {
    // `if (plyr->mo) plyr->mo->health = 100` — the live player mo is the
    // M7 arena mobj (pplayer.ts mirrors m.health = p.health); the M2
    // fixture stub carries no health field, so the write is duck-typed.
    if (p.mo) (p.mo as unknown as { health: number }).health = 100;
    p.health = 100;
    p.message = STSTR.DQDON;
  } else {
    p.message = STSTR.DQDOFF;
  }
}

/** st_stuff.c:564-577 (`idfa`, cheat_ammonokey) and :578-594 (`idkfa`,
 * cheat_ammo) share the body; kfa adds the cards loop. NOTE vanilla sets
 * NO armor-bonus beyond armorpoints/armortype and does NOT touch
 * readyweapon — replicated, not "improved". */
export function cheatArsenal(state: GameState, withKeys: boolean): void {
  const p = inv(state);
  p.armorpoints = 200;
  p.armortype = 2;
  for (let i = 0; i < NUMWEAPONS; i++) p.weaponowned[i] = 1;
  for (let i = 0; i < NUMAMMO; i++) p.ammo[i] = p.maxammo[i]!;
  if (withKeys) {
    const cards = (plr(state) as unknown as { cards: Int32Array }).cards;
    for (let i = 0; i < NUMCARDS; i++) cards[i] = 1;
  }
  p.message = withKeys ? STSTR.KFAADDED : STSTR.FAADDED;
}

/** st_stuff.c:625-633 — `idspispopd` / `idclip` (two sequences, one
 * effect). The CF_NOCLIP ↔ mobj-flag sync (MF_NOCLIP|MF_NOGRAVITY) follows
 * the port's D012 model (debug.ts noclip — pTryMove reads the flags). */
export function cheatNoclip(state: GameState): void {
  const p = plr(state);
  p.cheats ^= CF_NOCLIP;
  if (p.cheats & CF_NOCLIP) {
    p.mo.flags |= MF_NOCLIP | MF_NOGRAVITY;
    p.message = STSTR.NCON;
  } else {
    p.mo.flags &= ~(MF_NOCLIP | MF_NOGRAVITY);
    p.message = STSTR.NCOFF;
  }
}

/** st_stuff.c:636-651 — `idbehold<letter>`; `i` is the powerup index ==
 * the sequence row (cheat_powerup_seq[0..5]). The strength branch's
 * "power-off" (powers[1] = 0) is a 1.10 quirk — kept. */
export function cheatBehold(state: GameState, i: number): void {
  const p = inv(state);
  if (!p.powers[i]) P_GivePower(p, i);
  else if (i !== PW.pw_strength) p.powers[i] = 1;
  else p.powers[i] = 0;
  p.message = STSTR.BEHOLDX;
}

/** st_stuff.c:652-656 — bare `idbehold`: the hint message ONLY (no menu
 * exists in 1.10 despite the comment). */
export function cheatBeholdMenu(state: GameState): void {
  plr(state).message = STSTR.BEHOLD;
}

/** st_stuff.c:657-663 — `idchoppers`. Quirk kept: `powers[pw_invulnerability]
 * = true` sets ONE tic (not INVULNTICS) — the source spells `= true`. */
export function cheatChoppers(state: GameState): void {
  const p = inv(state);
  p.weaponowned[WP.wp_chainsaw] = 1;
  p.powers[PW.pw_invulnerability] = 1;
  p.message = STSTR.CHOPPERS;
}

/** st_stuff.c:664-673 — `idmypos`. sprintf("ang=0x%x;x,y=(0x%x,0x%x)") —
 * %x on unsigned/signed 32-bit: model with >>>0 (two's-complement hex,
 * matching gcc x86 of the era). Reads players[consoleplayer] — same slot
 * in singleplayer. */
export function cheatMypos(state: GameState): void {
  const p = plr(state);
  const hex = (v: number) => (v >>> 0).toString(16);
  p.message = `ang=0x${hex(p.mo.angle)};x,y=(0x${hex(p.mo.x)},0x${hex(p.mo.y)})`;
}

/* ------------------------------------------------------------------ */
/* idmus / idclev parameter math (pure)                              */
/* ------------------------------------------------------------------ */

/** The two digits as char codes (missing ⇒ 0, the C buffer's zero fill). */
function digitPair(param: string): [number, number] {
  return [param.codePointAt(0) ?? 0, param.codePointAt(1) ?? 0]; // absent byte = C's zero fill
}

/** st_stuff.c:595-623 math. Episodic (`mus_e1m1 + (b0-'1')*9 + (b1-'1')`):
 * an <ep><map> PAIR, not a track index — >31 ⇒ NOMUS. The commercial
 * branch exists for fidelity (unreached under the shareware policy,
 * gamemode.ts). Returns the S_music index and whether the selection is
 * impossible (caller: STSTR_MUS is written BEFORE this, st_stuff.c:600). */
export function resolveMus(
  param: string,
  mode: GameMode = GAME_MODE
): { readonly song: number; readonly nomus: boolean } {
  const [b0, b1] = digitPair(param);
  if (mode === 'commercial') {
    const n = (b0 - 0x30) * 10 + (b1 - 0x30); // buf - '0'
    return { song: 33 + n - 1, nomus: n > 35 }; // mus_runnin = 33 (sounds.h/sounds.c)
  }
  const n = (b0 - 0x31) * 9 + (b1 - 0x31); // buf - '1'
  return { song: 1 + n, nomus: n > 31 }; // mus_e1m1 = 1
}

/** st_stuff.c:676-723 guards. NOTE the source bug kept verbatim: the
 * commercial branch computes epsd = 0 and the `epsd < 1` guard then
 * REJECTS it — in 1.10 idclev does nothing under gamemode commercial
 * (folklore says it "worked"; the source says otherwise — shareware policy
 * makes this branch unreachable anyway). Null ⇒ every vanilla `return
 * false` lane (no message, no gameaction). */
export function resolveClev(
  param: string,
  mode: GameMode = GAME_MODE
): { readonly epsd: number; readonly map: number } | null {
  const [b0, b1] = digitPair(param);
  let epsd: number;
  let map: number;
  if (mode === 'commercial') {
    epsd = 0;
    map = (b0 - 0x30) * 10 + (b1 - 0x30);
  } else {
    epsd = b0 - 0x30;
    map = b1 - 0x30;
  }
  if (epsd < 1) return null;
  if (map < 1) return null;
  if (mode === 'retail' && (epsd > 4 || map > 9)) return null;
  if (mode === 'registered' && (epsd > 3 || map > 9)) return null;
  if (mode === 'shareware' && (epsd > 1 || map > 9)) return null;
  if (mode === 'commercial' && (epsd > 1 || map > 34)) return null;
  return { epsd, map };
}

/** The INVULNTICS import is used only through P_GivePower; referenced here
 * to keep the constant pinned next to the choppers quirk note. */
export const CHEAT_INVULNTICS = INVULNTICS;
