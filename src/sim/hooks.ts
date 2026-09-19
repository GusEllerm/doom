// sim/hooks.ts — typed side-effect hook SLOTS (M6-01, M6-plan §M6-01).
//
// The vanilla side-effect calls that live BELOW this sim (P_DamageMobj →
// p_inter.c, S_StartSound → s_sound.c, player->message → HU, G_ExitLevel →
// g_game.c gameaction) do not exist yet in this port (M7 damage, M9 messages
// /game flow, M10 audio). Rather than let later milestones invent call sites,
// M6-01 fixes the SIGNATURES here as counted, no-op slot loggers: the SPECIAL
// code calls the slot today; M7/M9/M10 replace the slot BODIES, not the call
// sites (M6-plan §0.10). The slot signature (thing, amount, source, tic) is
// pinned by M6-plan §6 (crush-damage cadence goldens must not re-bless twice).
//
// A-06 (ARCHITECTURE §1.3, DECISIONS D008): this module imports NOTHING —
// no platform, no render, no node. Pure in-memory counters + capped entry
// logs so L2 tests can assert side effects (thing id, amount, tic) without
// speakers, strings, or a gamestate.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* ------------------------------------------------------------------ */
/* Event records                                                       */
/* ------------------------------------------------------------------ */

/** p_inter.c `P_DamageMobj(target, inflictor, source, damage)` — `thing` is
 * the target's thinker-arena id (ptick.ts), `source` the inflictors' arena
 * id or null (world damage: crushers, damage floors). `tic` = leveltime. */
export interface DamageEvent {
  readonly thing: number;
  readonly amount: number;
  readonly source: number | null;
  readonly tic: number;
}

/** s_sound.c `S_StartSound(origin, sfx_id)` — coords are the origin mobj's
 * fixed x/y/z at emit time (origin = null ⇒ listener position, coords 0).
 * `id` is the sfxenum number (info.c instances[]; M10 decodes it). */
export interface SfxEvent {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tic: number;
}

/** d_englsh.h / p_local.h `player->message = PD_*` — `id` is the message
 * key (M9 maps it to the exact d_englsh string). */
export interface MessageEvent {
  readonly id: string;
  readonly tic: number;
}

/** g_game.c `G_ExitLevel` / `G_SecretExitLevel` — M6 sets the typed
 * `exitRequest` flag instead of a gameaction drain (deviation D013(e));
 * M9 wires the real level-change. */
export type ExitKind = 'normal' | 'secret';

export interface ExitEvent {
  readonly kind: ExitKind;
  readonly tic: number;
}

/* ------------------------------------------------------------------ */
/* Slot logs                                                           */
/* ------------------------------------------------------------------ */

/** Capped entry log: `count` counts EVERY call (never truncates, so
 * cadence assertions cannot be fooled by the cap); `entries` keeps the
 * first HOOK_LOG_CAP events for exact-order assertions. */
export interface SlotLog<E> {
  count: number;
  entries: E[];
  /** per-key call counts (sfx id / message id); unused logs omit it. */
  byId?: Map<string | number, number>;
}

/** Memory guard for long headless runs (log is a test instrument, not a
 * gameplay buffer): the first N events are kept, every call still counts. */
export const HOOK_LOG_CAP = 4096;

export interface HookSlots {
  damage: SlotLog<DamageEvent>;
  sfx: SlotLog<SfxEvent>;
  message: SlotLog<MessageEvent>;
  exit: SlotLog<ExitEvent>;
}

export function createHookSlots(): HookSlots {
  return {
    damage: { count: 0, entries: [] },
    sfx: { count: 0, entries: [], byId: new Map() },
    message: { count: 0, entries: [], byId: new Map() },
    exit: { count: 0, entries: [] }
  };
}

/** Reset in place (parity with the pcross.stub.ts counter-reset idiom —
 * tests reuse a booted state; gInitGame always builds fresh slots). */
export function resetHookSlots(h: HookSlots): void {
  for (const log of [h.damage, h.sfx, h.message, h.exit]) {
    log.count = 0;
    log.entries.length = 0;
    log.byId?.clear();
  }
}

function record<E>(log: SlotLog<E>, e: E, key?: string | number): void {
  log.count++;
  if (key !== undefined && log.byId) log.byId.set(key, (log.byId.get(key) ?? 0) + 1);
  if (log.entries.length < HOOK_LOG_CAP) log.entries.push(e);
}

/* ------------------------------------------------------------------ */
/* Slot call sites (counted no-ops until M7/M9/M10 fill the bodies)    */
/* ------------------------------------------------------------------ */

/** P_DamageMobj stand-in — p_inter.c arrives in M7; crusher cadence
 * (`!(leveltime&3)` × 10) and damage floors call THIS (M6-plan §6 pin). */
export function damageSlot(
  h: HookSlots, thing: number, amount: number, source: number | null, tic: number
): void {
  record(h.damage, { thing, amount, source, tic });
}

/** S_StartSound stand-in (M10 audio replaces the body). */
export function sfxSlot(
  h: HookSlots, id: number, x: number, y: number, z: number, tic: number
): void {
  record(h.sfx, { id, x, y, z, tic }, id);
}

/** player->message stand-in (M9 HUD/messages replace the body). */
export function messageSlot(h: HookSlots, id: string, tic: number): void {
  record(h.message, { id, tic }, id);
}

/** Structural view of GameState the exit slot writes through — kept
 * structural so hooks.ts imports nothing (A-06 header note). GameState
 * satisfies it by construction. */
export interface ExitHost {
  exitRequest: 'none' | ExitKind;
  hooks: HookSlots;
  leveltime: number;
}

/** G_ExitLevel / G_SecretExitLevel stand-in: records the event AND latches
 * `exitRequest` (halts stepping in tests; M9 drains into a real level
 * change). Idempotent-on-record: later exits still log, last kind wins. */
export function exitSlot(host: ExitHost, kind: ExitKind): void {
  record(host.hooks.exit, { kind, tic: host.leveltime });
  host.exitRequest = kind;
}
