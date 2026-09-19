// sim/pexit.ts — G_ExitLevel / G_SecretExitLevel proxies (M6-12; g_game.c).
//
// Vanilla source truth (linuxdoom-1.10, fetched 2026-02-19):
//   g_game.c:1002 `G_ExitLevel`  → secretexit = false; gameaction = ga_completed;
//   g_game.c:1009 `G_SecretExitLevel` → commercial-guarded secretexit (see
//         below); gameaction = ga_completed;
// Callers reached in this port (all via the M6-03 registry, FNS 'exit'):
//   cross 52  W1 exit          (p_spec.c:679  G_ExitLevel, no clear),
//   cross 124 W1 secret exit   (p_spec.c:762  G_SecretExitLevel, no clear),
//   use   11  S1 exit          (p_switch.c:362, ChangeSwitchTexture BEFORE),
//   use   51  S1 secret exit   (p_switch.c:434, ChangeSwitchTexture BEFORE),
//   feet  sector special 11    (p_spec.c:1062, E1M8 finale at hp<=10).
//
// Deviation D013(e): `gameaction = ga_completed` is replaced by the typed
// `exitRequest` latch (M6-01 hook, hashed in state.ts); M9 wires the real
// level-change drain. Deviation D013(g): the vanilla commercial guard
// (`gamemode == commercial && W_CheckNumForName("map31") < 0` ⇒ no secret
// exit) is Doom2/Wolf3D-only — Doom-1 mode keeps the plain secret path,
// so gSecretExitLevel is unconditionally secret here.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { exitSlot, type ExitHost } from './hooks';

/** The state slice the exit proxies write (GameState satisfies it). */
export interface ExitWorld extends ExitHost {
  /** g_game.c:1000 `secretexit` — the `specialexit` run-global proxy,
   * hashed (state.ts). */
  specialexit: boolean;
}

/** `G_ExitLevel()` — g_game.c:1002-1006: secretexit=false, level completes
 * normally. Last exit call wins (the exitSlot log counts every call). */
export function gExitLevel(w: ExitWorld): void {
  w.specialexit = false; // g_game.c:1004
  exitSlot(w, 'normal');
}

/** `G_SecretExitLevel()` — g_game.c:1009-1017 minus the Doom2-only guard
 * (deviation D013(g), header). */
export function gSecretExitLevel(w: ExitWorld): void {
  w.specialexit = true; // g_game.c:1015 (Doom-1 path)
  exitSlot(w, 'secret');
}
