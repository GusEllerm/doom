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
  /** M8-02 damage-bridge wiring (NOT an event log — resetHookSlots never
   * clears it; fresh per level because gInitGame builds fresh slots). */
  bridge: DamageBridgeSlots;
  /** M8-fix static-dummy seam (NOT an event log — resetHookSlots never
   * clears it; fresh per level because gInitGame builds fresh slots):
   * a fixture-installed gate consulted ONLY by the MOBJ-domain state-row
   * action dispatch of p_mobj.ts P_SetMobjState, and there ONLY for the
   * two AI-churn ids A_Look (29) / A_Chase (30). When set and the call
   * returns true, that dispatch is SKIPPED: the state fields themselves
   * still advance exactly like production (the STND row keeps re-entering
   * STND; sprite/tics unchanged), but the monster never sight- or
   * sound-wakes and never walks — the fixture's planted dummies stay
   * STATIC at their spawn geometry, reproducing the pre-M8-12 world
   * where these bodies were unregistered in the test bundle. When unset
   * (production, and every suite that WANTS AI live) behavior is
   * bit-identical to today: the gate is not even called.
   * Coverage is PRECISELY {A_Look, A_Chase}: pain/death/damage actions
   * are state actions too but are NOT gated — A_Pain/A_Scream/A_Fall
   * still run when a gated dummy is hurt or killed, and the P_DamageMobj
   * bridge is the damageSlot path, not this one. The monster ATTACK
   * actions (A_PosAttack family, A_FaceTarget, ...) are likewise NOT
   * gated; they stay unreachable while the gate is on because their only
   * entries are A_Chase's missile/melee states and A_Look's wake
   * transition — both gated out. */
  aiGate: AiGateFn | null;
}

/* ------------------------------------------------------------------ */
/* Damage bridge (M8-02, M8-plan §M8-02/§0.13)                          */
/* ------------------------------------------------------------------ */

/** Structural stand-in for the mobj runtime's live object — typed here so
 * hooks.ts keeps importing NOTHING (A-06); p_mobj.ts's resolver satisfies
 * it (Mobj.isMobj). */
export interface MobjRef {
  readonly isMobj: true;
}

/** ThingLinks slot → live mobj (undefined when the slot has no mobj bound:
 * unmapped decor slots, freed slots). Registered by p_mobj.ts on every
 * runtime create (createMobjRuntime wires it to rt.slotMobjs). */
export type MobjResolverFn = (slot: number) => MobjRef | undefined;

/** p_inter.c `P_DamageMobj(target, inflictor, source, damage)` — the real
 * body (M8-05 registers it here) receives RESOLVED mobj refs; the record
 * into h.damage above stays the L2 event log (M8-plan §0.13: no call-site
 * churn in the seven damageSlot call sites). source resolves to undefined
 * for world damage (crushers, damage floors, null source). */
export type DamageBridgeFn = (
  target: MobjRef,
  amount: number,
  source: MobjRef | undefined,
  tic: number,
) => void;

export interface DamageBridgeSlots {
  mobjFromSlot?: MobjResolverFn;
  damageBridge?: DamageBridgeFn;
}

/** Register (or with null, clear) the P_DamageMobj body. The dispatch
 * below only fires while BOTH the body and the slot resolver are present,
 * so pre-M8-05 behavior (record-only) is bit-identical. */
export function registerDamageBridge(h: HookSlots, fn: DamageBridgeFn | null): void {
  h.bridge.damageBridge = fn ?? undefined;
}

/** Resolve a damageSlot slot id to its live mobj (undefined when nothing
 * is bound or no resolver is registered). The M8-05 bridge body uses this
 * for inflictor/source slots the signature does not pre-resolve. */
export function mobjFromSlot(h: HookSlots, slot: number): MobjRef | undefined {
  return h.bridge.mobjFromSlot?.(slot);
}

/* ------------------------------------------------------------------ */
/* Mobj AI gate (M8-fix static-dummy seam)                             */
/* ------------------------------------------------------------------ */

/** AI-gate probe: true ⇒ the mobj-domain A_Look/A_Chase dispatches skip
 * their bodies this tic (see HookSlots.aiGate). Plain callback, no sim
 * import — same discipline as the damage bridge above. */
export type AiGateFn = () => boolean;

/** Register (or with null, clear) the mobj AI gate. Fixture/test only —
 * production never calls this, so the seam costs nothing there. */
export function registerAiGate(h: HookSlots, fn: AiGateFn | null): void {
  h.aiGate = fn;
}

export function createHookSlots(): HookSlots {
  return {
    damage: { count: 0, entries: [] },
    sfx: { count: 0, entries: [], byId: new Map() },
    message: { count: 0, entries: [], byId: new Map() },
    exit: { count: 0, entries: [] },
    bridge: {},
    aiGate: null
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
  // M8-02 bridge: record FIRST (the L2 log never depends on the bridge),
  // then dispatch to the P_DamageMobj body when one is registered AND the
  // target slot resolves to a live mobj (unresolved slots — plain decor
  // under a crusher — stay record-only, exactly the pre-M8 behavior).
  const body = h.bridge.damageBridge;
  if (body !== undefined) {
    const target = h.bridge.mobjFromSlot?.(thing);
    if (target !== undefined) {
      body(
        target,
        amount,
        source === null ? undefined : h.bridge.mobjFromSlot?.(source),
        tic,
      );
    }
  }
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
