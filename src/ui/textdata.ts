// ui/textdata.ts — compiled-in endgame strings (d_englsh.h, M9-10).
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
