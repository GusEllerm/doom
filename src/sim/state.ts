// sim/state.ts — live-world game state + `hashState()` (ARCHITECTURE §2.4 /
// §3.4). This module is also the read-view surface for render/ (import
// boundary enforced by eslint; §1.3).
//
// M2-06 scope of the state: one dummy player, the runtime map, the tic
// counters and both PRNG indices. Sectors/mobjs/etc. extend this record as
// later tasks land (append-only).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { RuntimeMap } from './map';
import type { Player } from './player';
import type { PrngState } from './prng';
import type { GameInput, TurnheldState } from './ticcmd';

/* ------------------------------------------------------------------ */
/* GameState                                                           */
/* ------------------------------------------------------------------ */

/** doomdef.h `skill_t` {sk_baby=0, sk_easy, sk_medium, sk_hard,
 * sk_nightmare}; g_game.c `d_skill` defaults to sk_medium (2). */
export type Skill = 0 | 1 | 2 | 3 | 4;

export interface GameState {
  readonly map: RuntimeMap;
  /** Single-player: index 0 = consoleplayer. Slots are sparse only if a
   * later netgame task adds them. */
  readonly players: Player[];
  /** g_game.c `gametic` (incremented once per G_Ticker). */
  gametic: number;
  /** p_tick.c `leveltime` (incremented at the end of P_Ticker). */
  leveltime: number;
  /** g_game.c:184 turnheld (accelerative turning; lives with the tic cmd
   * builder but belongs to the run, hence in state). */
  turnheld: number;
  /** Vanilla rndindex/prndindex (§3.3). */
  readonly rng: PrngState;
  skill: Skill;
}

/* ------------------------------------------------------------------ */
/* hashState — FNV-1a over the §3.4 M2 serialization                   */
/* ------------------------------------------------------------------ */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * FNV-1a (32-bit) over the canonical little-endian byte serialization of the
 * M2-scoped state fields: leveltime, gametic, rndindex, prndindex, then per
 * player the fixed fields (x, y, z, angle, momX, momY, viewz, viewheight) +
 * health, cheats, playerstate and the 3 consumed ticcmd fields. int32 fields
 * are written as signed i32; `angle` (BAM, u32) via Uint32 so ANG180-class
 * values hash bit-exactly.
 */
export function hashState(s: GameState): number {
  const playerWords = 14; // see layout below
  const buf = new ArrayBuffer(16 + s.players.length * playerWords * 4);
  const dv = new DataView(buf);
  let o = 0;
  dv.setInt32(o, s.leveltime | 0, true); o += 4;
  dv.setInt32(o, s.gametic | 0, true); o += 4;
  dv.setInt32(o, s.rng.rndindex | 0, true); o += 4;
  dv.setInt32(o, s.rng.prndindex | 0, true); o += 4;
  for (const p of s.players) {
    dv.setInt32(o, p.mo.x, true); o += 4;
    dv.setInt32(o, p.mo.y, true); o += 4;
    dv.setInt32(o, p.mo.z, true); o += 4;
    dv.setUint32(o, p.mo.angle >>> 0, true); o += 4;
    dv.setInt32(o, p.mo.momX, true); o += 4;
    dv.setInt32(o, p.mo.momY, true); o += 4;
    dv.setInt32(o, p.viewz, true); o += 4;
    dv.setInt32(o, p.viewheight, true); o += 4;
    dv.setInt32(o, p.health | 0, true); o += 4;
    dv.setInt32(o, p.cheats | 0, true); o += 4;
    dv.setInt32(o, p.playerstate | 0, true); o += 4;
    dv.setInt32(o, p.cmd.forwardmove | 0, true); o += 4;
    // angleturn+sidemove+buttons share the last word slot economically:
    dv.setInt32(o, p.cmd.sidemove | 0, true); o += 4;
    // (playerWords = 14: the last word carries angleturn & buttons)
    dv.setInt32(o, ((p.cmd.angleturn << 16) | p.cmd.buttons) | 0, true); o += 4;
  }
  const bytes = new Uint8Array(buf);
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** Re-exported so the platform/harness can build inputs without importing
 * the ticcmd mutator module directly through the state seam (§1.3). */
export type { GameInput, TurnheldState };
