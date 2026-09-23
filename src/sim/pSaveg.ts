// sim/pSaveg.ts — M11-04: p_saveg.c EQUIVALENT — structured world
// capture/restore (G_DoSaveGame/G_DoLoadGame archive layer, M11-plan
// §M11-04 + §0.1/§0.2/§0.3). STUB: API frozen here, bodies land next
// commit (incremental per protocol).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GameState } from './state';

/** Structured canonical snapshot (the payload M11-02 wraps; bytes are
 * persist's job — this module stays pure sim, D-11b). */
export interface SaveSnapshot {
  format: 1;
  [k: string]: unknown;
}

/** P_ArchivePlayers/World/Thinkers/Specials equivalent (vanilla order). */
export function captureWorld(_state: GameState): SaveSnapshot {
  throw new Error('M11-04: captureWorld not implemented');
}

/** P_UnArchive* equivalent — applies onto an ALREADY rebuilt world (the
 * caller ran gInitNew(skill,ep,map) first, g_game.c:1226 order). */
export function restoreWorld(_state: GameState, _snap: SaveSnapshot): void {
  throw new Error('M11-04: restoreWorld not implemented');
}
