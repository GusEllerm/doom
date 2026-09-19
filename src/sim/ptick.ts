// sim/ptick.ts — thinker arena + P_Ticker pieces (p_tick.c, M6-01).
//
// Vanilla keeps thinkers on a doubly-linked circular list headed by
// `thinkercap` (p_tick.c): P_AddThinker appends at the tail (list order =
// insertion order — ARCHITECTURE §3.5-5), P_RemoveThinker is the LAZY
// sentinel (`thinker->function.acv = (actionf_v)(-1)`; unlinked by the next
// P_RunThinkers visit), and a thinker whose function is null stays linked
// but is not ticked (the p_plats.c stasis idiom).
//
// Port mapping: a `Map` keyed by monotonic id gives the same insertion
// order as the vanilla list for free (iteration-order rule §3.5-6). The
// sentinel is a `removed` flag with the identical lazy-swap timing: removal
// at or after the walker's position unlinks at the NEXT visit.
//
// Documented deviation (ARCHITECTURE §3.2, binding over vanilla): thinkers
// ADDED during a tic tick the NEXT tic. Vanilla appends before the cap and
// the walker visits them in the same tic; this port buffers mid-run adds in
// `pending` and merges after the pass. M6-plan §6 accepts the pinned
// next-tic semantics (add-during-tick scenario tested here).
//
// Sector `specialdata` (p_spec.c idiom: `sector->specialdata` = the active
// mover thinker; doors refuse to move while non-null, movers clear it on
// death) is the parallel array on the LIVE sector SoA in state.ts.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { LiveSectors } from './state';

/* ------------------------------------------------------------------ */
/* Thinker (thinker_t)                                                 */
/* ------------------------------------------------------------------ */

export type ThinkerFn = (self: Thinker) => void;

export interface Thinker {
  /** Stable arena id (monotonic; the Map key, vanilla list position proxy). */
  readonly id: number;
  /** thinker_t.function — null ⇒ linked but not ticked (stasis/plat-idle
   * idiom); must stay non-null-or-null-forever, the removal sentinel is
   * `removed`, NOT a null fn (vanilla -1 sentinel). */
  fn: ThinkerFn | null;
  /** p_tick.c removal sentinel: logically dead, unlinked at next visit. */
  removed: boolean;
  /** Mover/mobj payload words contributed to hashState in arena order
   * (ARCHITECTURE §3.4 "per-live-mobj" fields — mobjs arrive M7, movers
   * M6-03+ fill this; empty while the thinker has no hashed state). */
  hashWords: readonly number[];
}

export interface ThinkerArena {
  /** Insertion-ordered live + sentinel-pending entries = vanilla list. */
  readonly entries: Map<number, Thinker>;
  /** Next id to assign (deterministic counter, never Date/random). */
  nextId: number;
  /** thinkers added while a run is in progress → tick next tic (§3.2). */
  readonly pending: Thinker[];
  /** true while pRunThinkers walks the arena. */
  running: boolean;
}

export function createThinkerArena(): ThinkerArena {
  return { entries: new Map(), nextId: 1, pending: [], running: false };
}

/** P_AddThinker — appends at the list tail. Called DURING a tick, the entry
 * joins `pending` and is merged (ticked) only next tic. */
export function pAddThinker(arena: ThinkerArena, fn: ThinkerFn | null): Thinker {
  const t: Thinker = { id: arena.nextId++, fn, removed: false, hashWords: [] };
  if (arena.running) arena.pending.push(t);
  else arena.entries.set(t.id, t);
  return t;
}

/** P_RemoveThinker — lazy: mark the sentinel, unlink at the next visit. */
export function pRemoveThinker(t: Thinker): void {
  t.removed = true;
}

/** Live (non-sentinel) thinker count. */
export function thinkerCount(arena: ThinkerArena): number {
  let n = 0;
  for (const t of arena.entries.values()) if (!t.removed) n++;
  return n;
}

/**
 * P_RunThinkers over the arena in insertion order. Walker-visible snapshot:
 *  - sentinel entries are unlinked when visited (not ticked);
 *  - fn === null entries are linked but skipped;
 *  - a thinker removed by an earlier thinker is skipped AND unlinked this
 *    run; removed after being visited stays linked until the NEXT run
 *    (vanilla lazy timing);
 *  - adds made during this run tick next tic (§3.2 deviation, header).
 */
export function pRunThinkers(arena: ThinkerArena): void {
  arena.running = true;
  try {
    // Map iteration sees entries set during the run only if inserted into
    // `entries` — mid-run adds go to `pending` (pAddThinker), and deletes
    // during a Map iteration are safe (visited-once semantics), so the live
    // Map itself is the walker.
    for (const t of [...arena.entries.values()]) {
      if (!arena.entries.has(t.id)) continue; // unlinked earlier this run
      if (t.removed) {
        arena.entries.delete(t.id); // vanilla: Z_Free at visit time
        continue;
      }
      if (t.fn !== null) t.fn(t);
    }
  } finally {
    arena.running = false;
  }
  for (const t of arena.pending.splice(0, arena.pending.length)) {
    arena.entries.set(t.id, t); // ticks next run
  }
}

/* ------------------------------------------------------------------ */
/* Sector specialdata (p_spec.c idiom)                                 */
/* ------------------------------------------------------------------ */

/** sector->specialdata read — the active mover thinker of sector `i`. */
export function sectorSpecialData(sectors: LiveSectors, i: number): Thinker | null {
  return sectors.specialData[i] ?? null;
}

/** sector->specialdata write (null clears; movers set it on spawn and
 * clear it when their thinker dies — p_doors.c/p_plats.c idiom). */
export function setSectorSpecialData(
  sectors: LiveSectors, i: number, t: Thinker | null
): void {
  sectors.specialData[i] = t;
}

/* ------------------------------------------------------------------ */
/* P_UpdateSpecials (p_spec.c) — M6-01 placeholder                     */
/* ------------------------------------------------------------------ */

/**
 * P_UpdateSpecials: button ticks + special-48 textureoffset scroll arrive
 * with M6-03 (pspec.ts takes this call site over). Counted here so the
 * tick-order test can prove the SLOT fires in the right tic position.
 */
export const updateSpecialsCounts = { calls: 0 };

export function resetUpdateSpecialsCounts(): void {
  updateSpecialsCounts.calls = 0;
}

export function pUpdateSpecials(): void {
  updateSpecialsCounts.calls++;
  // M6-03: activeplats/ceilings/buttonlist tick + scroll 48 go here.
}
