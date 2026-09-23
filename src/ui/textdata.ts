// ui/textdata.ts — compiled-in strings (d_englsh.h; endgame M9-10, the
// M11 save/load block M11-03).
//
// SOURCE TRUTH (plan §0.10, measured): the episode-1 endgame text is a
// COMPILED-IN C string — there is NO "F1TEXT" lump anywhere (neither the
// 1.10 source nor the pinned freedoom1.wad carries one; §0.12 audit).
// f_finale.c:71 simply aliases `char* e1text = E1TEXT;`, so the ONLY
// faithful transcription point is this file.
//
// The value below is the d_englsh.h:359 `#define E1TEXT` multi-literal,
// concatenated exactly as the C preprocessor + linker do (15 literals,
// 440 bytes, 15 '\n'). finale.test.ts pins the byte-transcription with a
// sha256 AND a re-parse of the tracked .refs/d_englsh.h mirror.
//
// E2TEXT/E3TEXT/E4TEXT (d_englsh.h:377/…) and the C*/P*/T* commercial
// sets are §4-deferred: GAME_MODE is pinned 'shareware' (gamemode.ts) and
// G_InitNew clamps gameepisode to 1, so F_StartFinale's ep2-4 arms are
// unreachable (counted stubs in finale.ts, never silent).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** d_englsh.h:359-374 `E1TEXT` verbatim (the "Shores of Hell" ending). */
export const E1TEXT =
  'Once you beat the big badasses and\n' +
  "clean out the moon base you're supposed\n" +
  "to win, aren't you? Aren't you? Where's\n" +
  'your fat reward and ticket home? What\n' +
  "the hell is this? It's not supposed to\n" +
  'end this way!\n' +
  '\n' +
  'It stinks like rotten meat, but looks\n' +
  'like the lost Deimos base.  Looks like\n' +
  "you're stuck on The Shores of Hell.\n" +
  'The only way out is through.\n' +
  '\n' +
  'To continue the DOOM experience, play\n' +
  'The Shores of Hell and its amazing\n' +
  'sequel, Inferno!\n';

/* ------------------------------------------------------------------ */
/* M11-03: the save/load string block (d_englsh.h:42-47, :75, :135)     */
/* ------------------------------------------------------------------ */

/** d_englsh.h:39/:40 message idiom, kept local so the prompts below read
 * like the C block (menu.ts owns the same pair for its own strings). */
const PRESSKEY = 'press a key.';
const PRESSYN = 'press y or n.';

/** d_englsh.h:42 LOADNET (netgame branch unreachable: this build is
 * single-player — netgame is compile-time false, ARCHITECTURE §4). */
export const LOADNET = "you can't do load while in a net game!\n\n" + PRESSKEY;
/** d_englsh.h:43 QLOADNET */
export const QLOADNET = "you can't quickload during a netgame!\n\n" + PRESSKEY;
/** d_englsh.h:44 QSAVESPOT — the quickload face of quickSaveSlot < 0. */
export const QSAVESPOT = "you haven't picked a quicksave slot yet!\n\n" + PRESSKEY;
/** d_englsh.h:45 SAVEDEAD — the !usergame face of M_SaveGame
 * (m_menu.c:645-649) and of M_QuickSave's gamestate guard (:697-700 —
 * the "SAVE-not-here" message). */
export const SAVEDEAD = "you can't save if you aren't playing!\n\n" + PRESSKEY;
/** d_englsh.h:46 QSPROMPT — F6 overwrite prompt; the `%s` is the C
 * sprintf slot name (m_menu.c:709 sprintf(tempstring,QSPROMPT,
 * savegamestrings[quickSaveSlot])). */
export const QSPROMPT = "quicksave over your game named\n\n'%s'?\n\n" + PRESSYN;
/** d_englsh.h:47 QLPROMPT — F9 load-confirm prompt (m_menu.c:741). */
export const QLPROMPT = "do you want to quickload the game named\n\n'%s'?\n\n" + PRESSYN;

/** d_englsh.h:75 EMPTYSTRING — the face of a hole in savegamestrings[]
 * (M_ReadSaveStrings m_menu.c:528; the LoadMenu row is also status-0'd
 * there, :530). */
export const EMPTYSTRING = 'empty slot';

/** d_englsh.h:135 GGSAVED — G_DoSaveGame's post-write message
 * (g_game.c:1317; game.ts messages it via the HU key seam). */
export const GGSAVED = 'game saved.';
