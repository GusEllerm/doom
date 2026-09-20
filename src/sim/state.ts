// sim/state.ts — live-world game state + `hashState()` (ARCHITECTURE §2.4 /
// §3.4). This module is also the read-view surface for render/ (import
// boundary enforced by eslint; §1.3).
//
// M2-06 scope of the state: one dummy player, the runtime map, the tic
// counters and both PRNG indices. Sectors/mobjs/etc. extend this record as
// later tasks land (append-only).
//
// M6-01 adds the LIVE WORLD: the mutable sector SoA (floorZ/ceilingZ/light/
// special + static tag copy + `specialdata` thinker back-refs), the thinker
// arena (ptick.ts), the hook slots (hooks.ts), `exitRequest` and the
// totalsecret/secretcount/specialexit run globals. hashState extends per
// ARCHITECTURE §3.4 (per-sector floorZ/ceilingZ/light/special + arena in
// arena order) — ONE-TIME re-bless, reason "M6 world-state fields".
//
// SECTOR AUTHORITY (M6-01 design call, pinned here): `state.sectors` is the
// SIM-side authority — movers mutate ONLY these arrays. It is seeded at
// gInitGame as a value copy of the static load-time SoA (`map.sectors`), so
// until the first mover lands (M6-03+) the two are value-identical while
// static. The renderer keeps reading the STATIC load-time copy it already
// consumes: the 3D pass gets heights/lights through loadRenderWorld's own
// copy of `md.sectors` (render/rdata.ts) and automap through its
// structural map.sectors read-view — src/render may import sim/state only,
// and no live accessor may be added to sim/map.ts, which is outside this
// task's owns list. Frame output is therefore provably UNCHANGED
// (tests/render/liveview.test.ts: E1M1 goldens unmoved + live==static
// assertion). GAP FOR M6-03+: once movers mutate heights/lights the render
// side (rdata world tables) must be re-pointed at the live arrays exposed
// HERE (state.ts is the sanctioned seam) — logged as a follow-up; no
// render/** edit was in scope for M6-01.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { PMapWorld } from './pmap';
import type { RuntimeMap } from './map';
import type { Player } from './player';
import type { PrngState } from './prng';
import type { GameInput, TurnheldState } from './ticcmd';
import type { HookSlots, ExitKind } from './hooks';
import type { Thinker, ThinkerArena } from './ptick';
import type { MobjRuntime } from './p_mobj';

/* ------------------------------------------------------------------ */
/* GameState                                                           */
/* ------------------------------------------------------------------ */

/** doomdef.h `skill_t` {sk_baby=0, sk_easy, sk_medium, sk_hard,
 * sk_nightmare}; g_game.c `d_skill` defaults to sk_medium (2). */
export type Skill = 0 | 1 | 2 | 3 | 4;

/**
 * LIVE mutable sector SoA (M6-01) — parallel arrays mirroring
 * `map.sectors` (fixed-point heights, same units). `floorZ/ceilingZ/light/
 * special` are mutated by movers/lights/damage-clears (M6-03+); `tag` is a
 * value copy that must NEVER be mutated (read convenience so specials read
 * the same record the hash covers); `specialData` holds the p_spec.c
 * mover back-refs and is NOT hashed (pointer slot — the arena hashes the
 * thinkers themselves).
 */
export interface LiveSectors {
  readonly count: number;
  readonly floorZ: Int32Array;
  readonly ceilingZ: Int32Array;
  readonly light: Int32Array;
  readonly special: Int32Array;
  readonly tag: Int32Array;
  readonly specialData: (Thinker | null)[];
}

/** Load-time copy (fresh-level semantics): value-copy the static SoA; every
 * sector starts live==static. */
export function createLiveSectors(map: RuntimeMap): LiveSectors {
  const n = map.sectors.count;
  return {
    count: n,
    floorZ: new Int32Array(map.sectors.floorHeight),
    ceilingZ: new Int32Array(map.sectors.ceilingHeight),
    light: new Int32Array(map.sectors.lightLevel),
    special: new Int32Array(map.sectors.special),
    tag: new Int32Array(map.sectors.tag),
    specialData: new Array<(Thinker | null)>(n).fill(null)
  };
}

/** hashState exitRequest enum code (canonical serialization). */
const EXIT_CODE: Record<'none' | ExitKind, number> = { none: 0, normal: 1, secret: 2 };

export interface GameState {
  readonly map: RuntimeMap;
  /** M5-06: the clipping world (blockmap + thinglinks) the shared mover
   * path (P_TryMove/P_XYMovement/P_ZMovement) runs on. Built once per
   * level by gInitGame; NOT part of the hashState serialization. */
  readonly pmap: PMapWorld;
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
  /** M6-01 live mutable sector SoA — sim-side authority, seeded from
   * map.sectors (see file header for the renderer seam story). */
  readonly sectors: LiveSectors;
  /** M6-01 thinker arena (p_tick.c thinkercap; fresh per level =
   * P_InitThinkers at load). */
  readonly thinkers: ThinkerArena;
  /** M6-01 typed side-effect slots (damage/sfx/message/exit no-ops). */
  readonly hooks: HookSlots;
  /** g_game.c G_ExitLevel/G_SecretExitLevel proxy until M9 (D013(e)). */
  exitRequest: 'none' | ExitKind;
  /** g_game.c:125 `totalsecret` — counted at load by P_SpawnSpecials
   * (sector special 9 pass, M6-03); hashed. */
  totalsecret: number;
  /** d_player.h `player->secretcount` proxy — single-player lives on the
   * run (p_spec.c:1050); hashed. */
  secretcount: number;
  /** g_game.c `specialexit` flag (G_SecretExitLevel marker); hashed. */
  specialexit: boolean;
  /** M7-02 mobj runtime (p_mobj.c globals + the live mobj roster). Its
   * HASH contribution flows through the thinker-arena payload words
   * (ARCHITECTURE §3.4 per-live-mobj [x,y,z,stateId,tics,flags,health,
   * targetIndex] in arena order — p_mobj.syncMobj refreshes them at spawn
   * and every thinker pass), so hashState needed no new serialization
   * block; the once-per-level re-bless reason is "mobjs in world state
   * (M7-02)". Assigned right after the state literal (constructor
   * back-reference); never null after gInitGame returns. */
  mobjs: MobjRuntime;
}

/* ------------------------------------------------------------------ */
/* hashState — FNV-1a over the §3.4 M2 serialization                   */
/* ------------------------------------------------------------------ */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * FNV-1a (32-bit) over the canonical little-endian byte serialization of
 * the §3.4 fields: leveltime, gametic, rndindex, prndindex; the M6 run
 * globals (totalsecret, secretcount, specialexit, exitRequest code); per
 * player the fixed fields (x, y, z, angle, momx, momy, viewz, viewheight) +
 * health, cheats, playerstate and the 3 consumed ticcmd fields; per SECTOR
 * in index order the live SoA quadruple (floorZ, ceilingZ, light, special);
 * then the thinker ARENA in arena (insertion) order: live count, then per
 * live thinker its id and payload words. int32 fields are written as
 * signed i32; `angle` (BAM, u32) via Uint32 so ANG180-class values hash
 * bit-exactly. Re-blessed ONCE at M6-01, reason "M6 world-state fields".
 */
export function hashState(s: GameState): number {
  const playerWords = 14; // see layout below
  // Arena words: live count + per live thinker (id, wordCount, words).
  let arenaWords = 1;
  for (const t of s.thinkers.entries.values()) {
    if (!t.removed) arenaWords += 2 + t.hashWords.length;
  }
  const buf = new ArrayBuffer(
    (8 + s.players.length * playerWords + s.sectors.count * 4 + arenaWords) * 4
  );
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
    dv.setInt32(o, p.mo.momx, true); o += 4;
    dv.setInt32(o, p.mo.momy, true); o += 4;
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
  // M6 run globals.
  dv.setInt32(o, s.totalsecret | 0, true); o += 4;
  dv.setInt32(o, s.secretcount | 0, true); o += 4;
  dv.setInt32(o, s.specialexit ? 1 : 0, true); o += 4;
  dv.setInt32(o, EXIT_CODE[s.exitRequest], true); o += 4;
  // Per-sector live quadruple, sector-index order (§3.4).
  for (let i = 0; i < s.sectors.count; i++) {
    dv.setInt32(o, s.sectors.floorZ[i]!, true); o += 4;
    dv.setInt32(o, s.sectors.ceilingZ[i]!, true); o += 4;
    dv.setInt32(o, s.sectors.light[i]!, true); o += 4;
    dv.setInt32(o, s.sectors.special[i]!, true); o += 4;
  }
  // Thinker arena in arena (insertion) order; sentinel-pending entries are
  // logically dead and excluded (they never tick either).
  const arenaCountPos = o;
  o += 4; // reserved for the live count
  let live = 0;
  for (const t of s.thinkers.entries.values()) {
    if (t.removed) continue;
    live++;
    dv.setInt32(o, t.id | 0, true); o += 4;
    dv.setInt32(o, t.hashWords.length | 0, true); o += 4;
    for (const w of t.hashWords) {
      dv.setInt32(o, w | 0, true); o += 4;
    }
  }
  dv.setInt32(arenaCountPos, live, true);
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
