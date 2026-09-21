/**
 * ui/humessage.ts — HU centered/top-line message machine (M9-06, plan
 * §M9-06 + §0.8): the hu_stuff.c ticker/widget/drawer mirror and the
 * FIRST consumer of `player.message` (src/sim/player.ts:145 — written by
 * pickups/refusals/cheat-adjacent sites since M6/M7, drained nowhere
 * until this module pops it, plan §M9-06 "fills the consumer").
 *
 * SOURCE TRUTH (linuxdoom-1.10, grepped this pass — id-Software/DOOM):
 *  - HU_Ticker (hu_stuff.c:505-533): tick the counter; when it reaches 0
 *    clear `message_on`/`message_nottobefuckedwith`; then — gated by
 *    `showMessages || message_dontfuckwithme` (:518) — pop
 *    `plr->message` into the 1-line `w_message` widget, CLEAR
 *    `plr->message`, arm `HU_MSGTIMEOUT = 4*TICRATE = 140` tics
 *    (hu_stuff.h:44). The pending slot IS `player.message` itself
 *    (1-deep queue, newest write wins): a PLAIN pop sets
 *    `message_nottobefuckedwith = message_dontfuckwithme` = FALSE
 *    (:529) ⇒ a newer message pops and REPLACES the line on the NEXT
 *    tic (fresh 140-tic window); only a PRIORITY pop (dontfuckwithme,
 *    e.g. "Picked up a medikit that you REALLY need!") holds the slot
 *    for its full 140 tics, the pending message waiting for the expiry
 *    tic. HU_MSGHEIGHT = 1 (hu_stuff.h:42) ⇒ NO 4-line scroll queue in
 *    1.10: HU_MAXLINES=4 (hu_lib.h:36) only sizes the static buffers,
 *    `HUlib_addLineToSText` (hu_lib.c:200) with h=1 wraps `cl` 0→0 —
 *    every pop REPLACES the single line. The plan wording "older rows
 *    scroll per scrollTextLine" is superseded by this grep (same
 *    §0.1-correction idiom).
 *  - message_dontfuckwithme (hu_stuff.c:99): non-static, READ by the
 *    ticker gate; in this release NO .c file ever SETS it (grep of all
 *    62 files — the "REALLY need!"/secret priority of DOOM 1.9-era/
 *    later sources is vestigial in 1.10). The one WRITE SITE the merged
 *    tree reaches through is m_menu.c:1010-1021 M_ChangeMessages
 *    (mirrored in src/ui/menu.ts, which today COUNTS the latch as a
 *    seam stub — menu.ts:536-537); `huSetDontFuckWithMe` here is the
 *    latch that seam (and future sites) should call.
 *  - Widget strings: the merged SIM writes d_englsh.h MACRO NAMES into
 *    player.message (p_inter_pickup.ts GOT.* ids, pdoors.ts/pswitch.ts
 *    PD_* ids — the messageSlot-log convention, p_switch.c:227 etc.
 *    wrote the literal strings; here the id rides the field and this
 *    consumer translates via HU_MESSAGE_STRINGS, the d_englsh.h table
 *    pinned byte-exact: :80-120 GOT*, :125-130 PD*). Literal passthrough
 *    (menu.ts MSGON/MSGOFF :135-136, gammamsg :142-148) rides the same
 *    pop path unchanged. SECRET: d_englsh.h has NO GOTSECRET in 1.10 —
 *    secret FOUNDNESS surfaces on the intermission text only
 *    (d_englsh.h:512, M9-07/10); pspec.ts:619 documents the missing
 *    message ("no message in 1.10, R05 §5") — census finding, not a gap.
 *  - hu_lib.c: message line = 1×(HU_MAXLINELENGTH=80 + NUL) char buffer
 *    (hu_lib.h:36-37,53); addChar drops past 80 (:74); draw = toupper,
 *    per-char `V_DrawPatchDirect` with width advance, space/out-of-range
 *    +4px, right-edge break at SCREENWIDTH (:100-135). Font =
 *    STCFN%.3d lumps '!'(33).. '_'(95), HU_FONTSIZE=63 (hu_stuff.c:
 *    405-410, hu_stuff.h:30-34) — menu.ts's text primitives are
 *    module-private, so the loader/drawer below are the local minimal
 *    mirror (same lump names, same +4 idiom).
 *  - HU_Responder message path (:659-664): Enter (HU_MSGREFRESH,
 *    hu_stuff.h:38) re-shows the current line for a fresh 140 tics,
 *    eating the key; everything else SP-passthrough (chat = registered
 *    no-op, plan §4 — `HU_INPUTTOGGLE` 't' is `netgame`-gated in the
 *    source and unreachable in this build).
 *  - HU_Drawer (:486-492): message line when `message_on`; the map-title
 *    line (w_title, HU_TITLEX=0, HU_TITLEY=167-hu_font[0]->height) ONLY
 *    over the automap. Title text = mapnames[(ep-1)*9+map-1] copied at
 *    HU_Start (hu_stuff.c:459-478) — table in sim/mapnames.ts.
 *  - Layering/erase (§0.11, §M9-06 acceptance 4): the drawer writes raw
 *    palette indices straight to screens[0] (FG) with V_DrawPatchDirect
 *    semantics — NO alpha, NO CRANG. "Timed erase" = the counter expels
 *    `message_on`, and the D_Display recompose (M9-09) repaints the
 *    region from the scene; HU_Erase (hu_stuff.c:495-501) is therefore
 *    the recompose no-op below.
 *
 * RNG: ZERO draws in this module's call graph (hu_stuff.c/hu_lib.c
 * contain no M_Random/P_Random site — grep) ⇒ no random-sites ledger
 * line. No sim edits: the consumer writes `player.message` ONLY through
 * the readback interface (the pop clear), zero player.ts changes.
 *
 * SEAMS: the per-tic hook for GS_LEVEL tickers (ST_Ticker/HU_Ticker
 * after P_Ticker, g_game.c:729-734) is NOT yet in game.ts — see
 * HU_FLOW_WIRING at the bottom; the drawer reaches the frame through
 * M9-09's D_Display composition. `huRegisterMenu()` wires the F8
 * showMessages getter/setter into menuSeams (menu.ts:194-195 — the flag
 * LIVES HERE, plan §M9-06; default 1 = ON, m_menu.c defaults
 * {"showMessages",&showMessages,1}).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { WadFile } from '../wad/wadfile';
import { lumpPatch, vDrawPatchDirect, FG, type VPatch } from '../render/vvideo';
import { GAME_MODE, type GameMode } from '../sim/gamemode';
import { huTitle } from '../sim/mapnames';
import { menuSeams } from './menu';
import { KEY_ENTER } from '../input/keyboard';

/* ------------------------------------------------------------------ */
/* hu_stuff.h constants                                                 */
/* ------------------------------------------------------------------ */

export const HU_FONTSTART = 33; // '!' (hu_stuff.h:30)
export const HU_FONTEND = 95; // '_' (hu_stuff.h:31)
export const HU_FONTSIZE = HU_FONTEND - HU_FONTSTART + 1; // 63

export const HU_MSGREFRESH = KEY_ENTER; // hu_stuff.h:38 (13)
export const HU_INPUTTOGGLE = 116; // 't' (hu_stuff.h:55) — netgame-gated
export const HU_MSGX = 0; // hu_stuff.h:39
export const HU_MSGY = 0; // :40
export const HU_MSGWIDTH = 64; // :41 (chars; unused by the 1.10 drawer)
export const HU_MSGHEIGHT = 1; // :42 — THE queue depth (1 line, see header)
export const HU_MSGTIMEOUT = 4 * 35; // hu_stuff.h:44 (TICRATE)

export const HU_MAXLINELENGTH = 80; // hu_lib.h:37
export const HU_MAXLINES = 4; // hu_lib.h:36 — static buffer size only

export const HU_TITLEX = 0; // hu_stuff.c:53
export const HU_TITLEY_BASE = 167; // :54 (167 - hu_font[0]->height)

const SCREENWIDTH = 320;

/* ------------------------------------------------------------------ */
/* d_englsh.h message table (the pop-time translation)                  */
/* ------------------------------------------------------------------ */

/**
 * d_englsh.h strings keyed by the macro NAME the merged sim writes into
 * player.message (GOT.* ids from p_inter_pickup.ts's exported GOT
 * table, PD_* ids from pswitch.ts). Byte-exact against d_englsh.h
 * :80-120 / :125-130 (id-Software/DOOM linuxdoom-1.10, fetched pass).
 * NO GOTSECRET key: the released 1.10 d_englsh.h has none — the secret
 * text is intermission-only (d_englsh.h:512; pspec.ts:619 census note).
 */
export const HU_MESSAGE_STRINGS: Readonly<Record<string, string>> = Object.freeze({
  // d_englsh.h:80-87
  GOTARMOR: 'Picked up the armor.',
  GOTMEGA: 'Picked up the MegaArmor!',
  GOTHTHBONUS: 'Picked up a health bonus.',
  GOTARMBONUS: 'Picked up an armor bonus.',
  GOTSTIM: 'Picked up a stimpack.',
  GOTMEDINEED: 'Picked up a medikit that you REALLY need!',
  GOTMEDIKIT: 'Picked up a medikit.',
  GOTSUPER: 'Supercharge!',
  // :89-94
  GOTBLUECARD: 'Picked up a blue keycard.',
  GOTYELWCARD: 'Picked up a yellow keycard.',
  GOTREDCARD: 'Picked up a red keycard.',
  GOTBLUESKUL: 'Picked up a blue skull key.',
  GOTYELWSKUL: 'Picked up a yellow skull key.',
  GOTREDSKULL: 'Picked up a red skull key.',
  // :96-102
  GOTINVUL: 'Invulnerability!',
  GOTBERSERK: 'Berserk!',
  GOTINVIS: 'Partial Invisibility',
  GOTSUIT: 'Radiation Shielding Suit',
  GOTMAP: 'Computer Area Map',
  GOTVISOR: 'Light Amplification Visor',
  GOTMSPHERE: 'MegaSphere!',
  // :104-112
  GOTCLIP: 'Picked up a clip.',
  GOTCLIPBOX: 'Picked up a box of bullets.',
  GOTROCKET: 'Picked up a rocket.',
  GOTROCKBOX: 'Picked up a box of rockets.',
  GOTCELL: 'Picked up an energy cell.',
  GOTCELLBOX: 'Picked up an energy cell pack.',
  GOTSHELLS: 'Picked up 4 shotgun shells.',
  GOTSHELLBOX: 'Picked up a box of shotgun shells.',
  GOTBACKPACK: 'Picked up a backpack full of ammo!',
  // :114-120
  GOTBFG9000: 'You got the BFG9000!  Oh, yes.',
  GOTCHAINGUN: 'You got the chaingun!',
  GOTCHAINSAW: 'A chainsaw!  Find some meat!',
  GOTLAUNCHER: 'You got the rocket launcher!',
  GOTPLASMA: 'You got the plasma gun!',
  GOTSHOTGUN: 'You got the shotgun!',
  GOTSHOTGUN2: 'You got the super shotgun!',
  // :125-130 (id-form writes; the merged pswitch.ts literal table
  // pswitch.ts:101-106 pins the same strings — parity tested)
  PD_BLUEO: 'You need a blue key to activate this object',
  PD_REDO: 'You need a red key to activate this object',
  PD_YELLOWO: 'You need a yellow key to activate this object',
  PD_BLUEK: 'You need a blue key to open this door',
  PD_REDK: 'You need a red key to open this door',
  PD_YELLOWK: 'You need a yellow key to open this door',
});

/** Pop-time translation: known d_englsh.h macro name → its string;
 * anything else (menu.ts MSGON/MSGOFF, gammamsg, future literals) is a
 * literal and passes through (vanilla wrote the literals directly, so
 * lookup-else-identity reproduces `HUlib_addMessageToSText(w_message,
 * 0, plr->message)` exactly). */
export function huTranslateMessage(msg: string): string {
  return HU_MESSAGE_STRINGS[msg] ?? msg;
}

/* ------------------------------------------------------------------ */
/* write-site census (pinned by humessage.test.ts §census)              */
/* ------------------------------------------------------------------ */

export interface HuWriteSite {
  readonly file: string;
  readonly line: number;
  readonly writes: string;
  readonly origin: string;
}

/** EVERY `player.message` write site in the merged tree (grep
 * `\.message *=` src/ — this table is the census; the test re-derives
 * the set from the sources so a NEW site trips it). */
export const HU_WRITE_SITES: readonly HuWriteSite[] = [
  { file: 'src/sim/p_inter_pickup.ts', line: 658, writes: 'GOT.* id (37 values, HU_MESSAGE_STRINGS keys)', origin: 'p_inter.c:373-647 (P_TouchSpecialThing message = GOTXXX)' },
  { file: 'src/sim/pdoors.ts', line: 567, writes: "PD_BLUEK | PD_YELLOWK | PD_REDK", origin: 'p_doors.c:378/392/405 (locked-use refusal, + sfx_oof :568)' },
  { file: 'src/sim/pswitch.ts', line: 365, writes: 'PD_BLUEO | PD_REDO | PD_YELLOWO', origin: 'p_switch.c:227/239/252 (refuse(), :339/:346/:353)' },
  { file: 'src/sim/pplayer.ts', line: 310, writes: "'' (clear)", origin: "P_SpawnPlayerFromStart — port-side clear (vanilla P_SpawnPlayer writes no message; the spawn-time wipe mirrors g_game.c:816's memset clearing message; line drifted 308→310 at M9-08 G_DoReborn merge)" },
  { file: 'src/sim/pplayer.ts', line: 367, writes: "'' (clear)", origin: 'G_PlayerReborn (g_game.c:800-831, the memset clears player->message; line drifted 365→367 at M9-08 reborn.ts split)' },
  { file: 'src/ui/menu.ts', line: 534, writes: "MSGON 'Messages ON' | MSGOFF 'Messages OFF' (literals)", origin: 'M_ChangeMessages (m_menu.c:979-990, F8)' },
  { file: 'src/ui/menu.ts', line: 1033, writes: 'gammamsg[usegamma] (literal)', origin: 'F11 gamma cycle (m_menu.c:1766-1777)' },
  { file: 'src/ui/humessage.ts', line: 0, writes: "'' (pop-clear, consumer side)", origin: 'HU_Ticker: plr->message = 0 (hu_stuff.c:525)' },
] as const;

/* ------------------------------------------------------------------ */
/* HU font (hu_stuff.c:392-414 loader; menu.ts's twin is private)       */
/* ------------------------------------------------------------------ */

let wad: WadFile | null = null;
const huFont: (VPatch | null)[] = new Array<VPatch | null>(HU_FONTSIZE).fill(null);

export function huSetWad(w: WadFile | null): void {
  wad = w;
  huFont.fill(null);
}

/** HU_Init's font cache (STCFN%.3d, '!'..'_' — lazy decode). */
function fontChar(c: number): VPatch | null {
  if (wad === null) return null;
  const idx = c - HU_FONTSTART;
  if (idx < 0 || idx >= HU_FONTSIZE) return null;
  let p = huFont[idx];
  if (p === undefined || p === null) {
    p = lumpPatch(wad, `STCFN${String(c).padStart(3, '0')}`);
    huFont[idx] = p;
  }
  return p;
}

/* ------------------------------------------------------------------ */
/* hu_lib.c stext widget mirror (h = HU_MSGHEIGHT = 1)                  */
/* ------------------------------------------------------------------ */

export interface HuTextLine {
  x: number;
  y: number;
  len: number;
  l: string;
}

/** w_message — hu_stext_t with h=1, so its single line stands for the
 * whole widget (hu_lib.c:200-212: addLine wraps cl 0→0 at h=1 and
 * clears; the HUlib 4-line scroll is never reached at this height). */
export const wMessage: HuTextLine = { x: HU_MSGX, y: HU_MSGY, len: 0, l: '' };
/** w_title (HUlib_initTextLine, cleared and refilled per HU_Start,
 * hu_stuff.c:442-446 + 476-477). */
export const wTitle: HuTextLine = { x: HU_TITLEX, y: -1, len: 0, l: '' };

/** HUlib_clearTextLine (hu_lib.c:46-50). */
function clearTextLine(t: HuTextLine): void {
  t.len = 0;
  t.l = '';
}

/** HUlib_addCharToTextLine (hu_lib.c:74-86): drop at HU_MAXLINELENGTH. */
function addCharToTextLine(t: HuTextLine, ch: string): boolean {
  if (t.len === HU_MAXLINELENGTH) return false;
  t.l += ch;
  t.len += 1;
  return true;
}

/** HUlib_addLineToSText (hu_lib.c:200-212) at h=1: wrap cl (0→0),
 * clear the single line. */
function addLineToSText(): void {
  clearTextLine(wMessage);
}

/** HUlib_addMessageToSText (hu_lib.c:217-229), prefix = 0 (SP — the
 * chat-name prefix path belongs to the netgame M11 chat no-op). */
function addMessageToSText(msg: string): void {
  addLineToSText();
  for (let i = 0; i < msg.length; i++) addCharToTextLine(wMessage, msg[i]!);
}

/** HUlib_drawTextLine (hu_lib.c:100-135): toupper, in-range glyphs
 * blit via V_DrawPatchDirect with width advance, space/out-of-range
 * advance 4, right-edge break at SCREENWIDTH. */
function drawTextLine(t: HuTextLine): void {
  let x = t.x;
  for (let i = 0; i < t.len; i++) {
    let c = t.l.charCodeAt(i);
    if (c >= 97 && c <= 122) c -= 32; // toupper
    if (c !== 32 && c >= HU_FONTSTART && c <= HU_FONTEND) {
      const p = fontChar(c);
      const w = p?.width ?? 0;
      if (x + w > SCREENWIDTH) break;
      if (p) vDrawPatchDirect(x, t.y, FG, p);
      x += w;
    } else {
      x += 4;
      if (x >= SCREENWIDTH) break;
    }
  }
}

/* ------------------------------------------------------------------ */
/* hu_stuff.c state (globals at :98-105 + showMessages)                 */
/* ------------------------------------------------------------------ */

export const huState = {
  /** static boolean message_on (hu_stuff.c:98) — THE drawer gate. */
  messageOn: false,
  /** boolean message_dontfuckwithme (:99) — non-static in C: settable
   * through huSetDontFuckWithMe (see header for the no-SETTER-in-1.10
   * census + the menu.ts:536 seam). */
  dontFuckWithMe: false,
  /** static boolean message_nottobefuckedwith (:100). */
  notToBeFuckedWith: false,
  /** static int message_counter (:103). */
  counter: 0,
  /** m_menu.c:79 `int showMessages` — default 1 (defaults table
   * {"showMessages",&showMessages,1}); owned HERE (plan §M9-06 F8),
   * toggled by menu.ts through the menuSeams registered below. */
  showMessages: true,
  /** static boolean headsupactive (hu_stuff.c:111). */
  headsupActive: false,
};

/** The consoleplayer slice the ticker consumes: `player_t *message`
 * (player.ts:143-145). Readback interface — no player.ts edit, the pop
 * clears the field in place (`plr->message = 0`, hu_stuff.c:525; '' is
 * this port's falsy equivalent of NULL). */
export interface HUPlayer {
  message: string;
}

/** HU_Ticker (hu_stuff.c:505-533) — the message half verbatim; the
 * netgame chat-scan tail (:535-575) is the registered no-op (plan §4).
 * Call per GS_LEVEL tic, after P_Ticker (g_game.c:729-733), paused or
 * not — the source lines sit OUTSIDE the paused gate. */
export function huTicker(plr: HUPlayer): void {
  // tick down message counter if message is up (:512-516)
  if (huState.counter !== 0 && --huState.counter === 0) {
    huState.messageOn = false;
    huState.notToBeFuckedWith = false;
  }

  // (:518) — showMessages off ⇒ ordinary pops SKIPPED (the field keeps
  // the message; re-enabling with F8 pops it fresh). dontfuckwithme
  // priority lines punch through the gate.
  if (huState.showMessages || huState.dontFuckWithMe) {
    // (:522-523)
    if (plr.message !== '' && (!huState.notToBeFuckedWith || huState.dontFuckWithMe)) {
      addMessageToSText(huTranslateMessage(plr.message));
      plr.message = ''; // :525 — THE player.message drain
      huState.messageOn = true;
      huState.counter = HU_MSGTIMEOUT;
      huState.notToBeFuckedWith = huState.dontFuckWithMe;
      huState.dontFuckWithMe = false;
    }
  }
}

/** The vestigial-but-exported latch (hu_stuff.c:99 declares it
 * non-static for exactly this cross-module set; 1.10 sites: none —
 * menu.ts's F8 latch counts until it calls this). */
export function huSetDontFuckWithMe(on: boolean): void {
  huState.dontFuckWithMe = on;
}

/** HU_Init + HU_Start (hu_stuff.c:395-484): reset the latch trio,
 * create the widgets, copy HU_TITLE into w_title ONCE per level start
 * (:476-477). `HU_Start` runs from G_InitNew/G_DoLoadLevel; repeated
 * starts stop the old one first (:419-420). */
export function huStart(
  gameepisode: number,
  gamemap: number,
  gamemode: GameMode = GAME_MODE,
): void {
  if (huState.headsupActive) huState.headsupActive = false; // HU_Stop
  huState.messageOn = false;
  huState.dontFuckWithMe = false;
  huState.notToBeFuckedWith = false;
  huState.counter = 0;
  clearTextLine(wMessage);

  clearTextLine(wTitle);
  wTitle.y = HU_TITLEY_BASE - (fontChar(HU_FONTSTART)?.height ?? 8);
  const title = huTitle(gamemode, gameepisode, gamemap);
  for (let i = 0; i < title.length; i++) addCharToTextLine(wTitle, title[i]!);

  huState.headsupActive = true;
}

/** HU_Stop (hu_stuff.c:415-418). */
export function huStop(): void {
  huState.headsupActive = false;
}

/** HU_Responder (:620-664, message half): the ENTER refresh line —
 * re-show the CURRENT w_message for a fresh HU_MSGTIMEOUT, eat the
 * key; every other event passes (chat is a registered no-op; the 't'
 * and destination-key branches are `netgame`-gated in the source and
 * never taken here). keyup NEVER reaches the body (:641-643 shape). */
export interface HUEvent {
  type: string; // 'keydown' | 'keyup'
  data1: number;
}

export function huResponder(ev: HUEvent): boolean {
  if (ev.type !== 'keydown') return false; // :655-657
  // !chat_on (SP always) — HU_MSGREFRESH (:659-664)
  if (ev.data1 === HU_MSGREFRESH) {
    huState.messageOn = true;
    huState.counter = HU_MSGTIMEOUT;
    return true;
  }
  return false;
}

/** HU_Drawer (hu_stuff.c:486-492): the message line while
 * `message_on` (HUlib_drawSText returns early off-state, hu_lib.c:238),
 * and the map title ONLY over the automap. Chat: registered no-op. */
export function huDrawer(automapactive = false): void {
  if (huState.messageOn) drawTextLine(wMessage); // h=1 ⇒ line cl=0 only
  if (automapactive) drawTextLine(wTitle);
}

/** HU_Erase (hu_stuff.c:495-501): in this canvas-recomposed port the
 * FG re-blit behind the overlay IS the erase (§0.11, plan "redraw
    behind") — recompose hook, no pixels written here. */
export function huErase(): void {
  // no-op: the M9-09 D_Display recompose redraws FG beneath the overlay
}

/** Test/debug read of the widget line (what the drawer would show). */
export function huMessageText(): string {
  return wMessage.l;
}

/** Test seam: full module reset (per-case hygiene; mirrors mReset's
 * resetGameFlow + flag-init idiom). */
export function huReset(): void {
  huState.messageOn = false;
  huState.dontFuckWithMe = false;
  huState.notToBeFuckedWith = false;
  huState.counter = 0;
  huState.showMessages = true;
  huState.headsupActive = false;
  clearTextLine(wMessage);
  clearTextLine(wTitle);
  wTitle.y = -1;
}

/* ------------------------------------------------------------------ */
/* wiring                                                               */
/* ------------------------------------------------------------------ */

/** Menu flag seam: menuSeams.showMessages/setShowMessages
 * (menu.ts:194-195, "M9-06 owns the flag"). Call at boot alongside
 * mRegisterFlow(). */
export function huRegisterMenu(): void {
  menuSeams.showMessages = () => huState.showMessages;
  menuSeams.setShowMessages = (on: boolean) => {
    huState.showMessages = on;
  };
}

/**
 * HU_FLOW_WIRING — SEAM GAP REPORT (no game.ts/main.ts edits allowed
 * here): vanilla drives HU_Ticker from G_Ticker's GS_LEVEL case AFTER
 * P_Ticker (g_game.c:729-733 `P_Ticker(); ST_Ticker(); AM_Ticker();
 * HU_Ticker();`), i.e. every GS_LEVEL tic including paused ones. The
 * merged game.ts GS_LEVEL case ends at `state.leveltime++` (line 459,
 * `break;` line 460) with no optional ticker hook. Needed, ONE line:
 * add `levelTickers?: FlowActFn` to GameFlowHooks (:157) and insert
 * after game.ts:459 `state.leveltime++;`:
 *     `flowHooks.levelTickers?.(state); // g_game.c:731-734`
 * then boot registers `huTicker(state.players[0])` there (plus M9-05's
 * ST_Ticker — same slot). Until then call `huTicker` from the sim-loop
 * owner; `huDrawer` composes inside M9-09's D_Display (FG overlay
 * AFTER the 3D pass, BEFORE the statusbar diff per §0.11 layers).
 */
