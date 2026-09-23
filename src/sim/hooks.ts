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

/** S_StartSound stand-in. M10-04: the RECORD half is unchanged (entry
 * shape byte-identical); ADDITIVELY it now notifies the optional live
 * listener (below) AFTER recording, carrying the optional origin read-
 * ref `origin` (psound_stub.ts passes the SfxOrigin through; direct sfxSlot
 * call sites keep 6 args and arrive with origin = null + world coords).
 * With no listener registered the behavior is byte-identical to M9. */
export function sfxSlot(
  h: HookSlots, id: number, x: number, y: number, z: number, tic: number,
  origin?: LiveSfxOrigin | null
): void {
  record(h.sfx, { id, x, y, z, tic }, id);
  liveSfx?.(id, origin ?? null, x, y, z, tic);
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

/* ------------------------------------------------------------------ */
/* M9-03 ADDITIVE: sfx stub counter + gameaction log                   */
/* ------------------------------------------------------------------ */

/** sfxStub counter state (module-level: these are d_main.c/m_menu.c/
 * wi_stuff.c UI-side S_StartSound sites, OUTSIDE the per-state sim hook
 * slots above and OUTSIDE the hash; M10 replaces the BODY, not the call
 * sites — the same doctrine as sfxSlot above). */
export interface SfxStubLog {
  count: number;
  byName: Map<string, number>;
}

export const sfxStubLog: SfxStubLog = { count: 0, byName: new Map() };

/** Silent-M9 S_StartSound body for UI-side call sites (menu skull moves,
 * quit-screen `quitsounds[(gametic>>2)&7]`, WI tally dots …). Keys are the
 * sfx_* names the M9 plan pins (sfx_pstop/sfx_stnmov/sfx_swtchn/sfx_swtchx/
 * sfx_pistol/…). */
export function sfxStub(name: string): void {
  sfxStubLog.count++;
  sfxStubLog.byName.set(name, (sfxStubLog.byName.get(name) ?? 0) + 1);
}

export function resetSfxStubLog(): void {
  sfxStubLog.count = 0;
  sfxStubLog.byName.clear();
  // M10-04: the sink ledgers are reset with the counter they replace.
  uiSfxLog.count = 0;
  uiSfxLog.entries.length = 0;
  uiSfxLog.byId?.clear();
  musicLog.count = 0;
  musicLog.entries.length = 0;
  musicLog.byId?.clear();
}

/* ------------------------------------------------------------------ */
/* M10-04 ADDITIVE: the sfxSink/musicSlot seams + live listeners       */
/* (D-0xx closure: the 41 UI sfxStub bodies become EVENT EMISSION)     */
/* ------------------------------------------------------------------ */

/** Origin read-view for the live seam — structurally satisfied by the
 * mobj runtime objects and by psound_stub.ts's SfxOrigin (hooks.ts
 * imports NOTHING, A-06). `o` is the thinker-arena id when the emitter
 * carries one (S_StartSound origin identity for the M10-05 allocator's
 * one-sound-per-mobj rule); absent ⇒ position-only origin. */
export interface LiveSfxOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly o?: number;
}

/** Live SFX listener — the playback half (M10-06 driver, M10-05 mixer).
 * `sfx` is the NUMERIC id for sim-side emits (sounds.h sfxenum via
 * psound_stub) and the `sfx_*` NAME for UI-side emits (m_menu.c /
 * wi_stuff.c sites carry the symbol; the consumer resolves it through the
 * sfxinfo table — src/audio/sfxinfo.ts). Coords follow the NULL-origin
 * rule: 0/0/0 = listener position (s_sound.c S_StartSound). */
export type LiveSfxFn = (
  sfx: number | string, origin: LiveSfxOrigin | null,
  x: number, y: number, z: number, tic: number,
) => void;

/** d_ssound.h-ish music kinds for the M10-08 consumer (s_sound.c:649-703
 * S_ChangeMusic sites). 'level' is reserved for M10-08's S_Start site
 * (p_setup.c:607) — no call site exists before that task. */
export type MusicKind = 'level' | 'intermission' | 'finale' | 'title';

/** s_sound.c S_ChangeMusic/S_StartMusic event: WHICH song-role started
 * and whether it loops (§0.6: level/inter/finale loop, title is
 * ONE-SHOT per d_main.c:477 S_StartMusic). */
export interface MusicEvent {
  readonly kind: MusicKind;
  readonly loop: boolean;
  readonly tic: number;
}

/** Live music listener (consumer M10-08's musicSelect/driver). */
export type LiveMusicFn = (kind: MusicKind, loop: boolean, tic: number) => void;

/* Module-level seams (UI sites have no GameState handle at the call —
 * same module-scope idiom as sfxStubLog above). NOT cleared by
 * resetHookSlots or resetSfxStubLog — audio-owned, M8 aiGate idiom;
 * register(… , null) clears. Registration is REPLACE = idempotent. */
let liveSfx: LiveSfxFn | null = null;
let liveMusic: LiveMusicFn | null = null;
let sfxClock: (() => number) | null = null;

/** Install (or with null, clear) the live SFX listener. Idempotent. */
export function registerLiveSfx(fn: LiveSfxFn | null): void {
  liveSfx = fn;
}

/** Install (or with null, clear) the live music listener. Idempotent. */
export function registerLiveMusic(fn: LiveMusicFn | null): void {
  liveMusic = fn;
}

/** Source of the CURRENT tic for UI-side events (gametic / menu tic —
 * the s_sound.c S_StartSound envelope stamps `leveltime`/gametic at the
 * call). Wired by main.ts's M10-06 audio plumbing; unset ⇒ tic 0. */
export function setSfxEventClock(getTic: (() => number) | null): void {
  sfxClock = getTic;
}

/** Deterministic per-tic RECORD ledger for UI-zone S_StartSound events
 * (the sfxStub COUNTER stays as the legacy counting layer; this is the
 * event half the M10 driver/ledgers consume). `sfx` keeps the raw name
 * or id (resolution is the audio side's job — sfxinfo table). */
export interface UiSfxEvent {
  readonly sfx: string | number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly tic: number;
}

export const uiSfxLog: SlotLog<UiSfxEvent> = { count: 0, entries: [], byId: new Map() };

/** The music event ledger (consumer M10-08). Same SlotLog discipline. */
export const musicLog: SlotLog<MusicEvent> = { count: 0, entries: [], byId: new Map() };

/**
 * The ONE function the UI files call for S_StartSound (replaces the
 * silent-M9 sfxStub bodies AT THEIR ADDRESSES — M6-plan §0.10 doctrine).
 * Order: legacy counter (menu/wintermission count tests untouched) →
 * uiSfxLog record → live listener. Zero PRNG, zero platform (A-06).
 */
export function sfxSink(sfx: string | number, origin?: LiveSfxOrigin | null): void {
  const tic = sfxClock !== null ? sfxClock() : 0;
  const x = origin ? origin.x : 0;
  const y = origin ? origin.y : 0;
  const z = origin ? origin.z : 0;
  sfxStub(typeof sfx === 'string' ? sfx : `sfx#${sfx}`);
  record(uiSfxLog, { sfx, x, y, z, tic }, sfx);
  liveSfx?.(sfx, origin ?? null, x, y, z, tic);
}

/**
 * The ONE function the UI files call for S_ChangeMusic/S_StartMusic
 * (wintermission mus_inter, title mus_intro, finale mus_victor — the
 * 3 former sfxStub music addresses). Records to musicLog, notifies the
 * live listener. NOT a sim-stream sound ⇒ no sfxStub/uiSfxLog entry.
 */
export function musicSlot(kind: MusicKind, loop: boolean): void {
  const tic = sfxClock !== null ? sfxClock() : 0;
  record(musicLog, { kind, loop, tic }, kind);
  liveMusic?.(kind, loop, tic);
}

/**
 * Auto-scan manifest for the UI-side emission sites (the sim-side
 * authority stays psound_stub.ts's SFX_SITE_LEDGER, unchanged — drift
 * there is red via ppalette.test.ts). Counts per NON-TEST source file:
 * `sfxSink(` calls and `musicSlot(` calls. hooks.ts itself (the seam
 * definitions) is skipped by the scan. The numbers mirror m_menu.c /
 * wi_stuff.c / d_main.c / f_finale.c per M10-plan §0.9; a call site
 * added/removed anywhere fails hooks.test.ts's scan, both directions.
 */
export const SFX_UI_SITE_LEDGER: Readonly<Record<string, { sfx: number; music: number }>> = {
  // m_menu.c's S_StartSound sites (30 textual; our quit sites collapse
  // the quitsounds[] pair, the read-this arms share M_ReadThis routines)
  // ⇒ 28 emit statements after M9-05/M9-06 transcription.
  'menu.ts': { sfx: 28, music: 0 },
  // wi_stuff.c: the 10 sfx_barexp/pistol/sgcock tally sites + the ONE
  // S_ChangeMusic(mus_inter,true) site (:1509-1514).
  'wintermission.ts': { sfx: 10, music: 1 },
  // d_main.c:477/:498 S_StartMusic(mus_intro) — ONE site (case 0).
  'title.ts': { sfx: 0, music: 1 },
  // f_finale.c:114 S_ChangeMusic(mus_victor,true).
  'finale.ts': { sfx: 0, music: 1 }
};

/** g_game.c G_Ticker gameaction-drain record (d_event.h gameaction_t
 * value + the gametic it drained at). */
export interface GameactionEvent {
  readonly action: number;
  readonly gametic: number;
}

export const gameactionLog: SlotLog<GameactionEvent> = { count: 0, entries: [] };

/** game.ts's drain logs EVERY drained action here (cap via `record`, so
 * long scripted flows cannot blow memory but cadence assertions stay
 * exact). */
export function recordGameaction(action: number, gametic: number): void {
  record(gameactionLog, { action, gametic });
}

export function resetGameactionLog(): void {
  gameactionLog.count = 0;
  gameactionLog.entries.length = 0;
}
