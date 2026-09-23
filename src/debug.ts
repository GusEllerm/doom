/**
 * Installs window.__doom (ARCHITECTURE §7). Active in dev builds or when the
 * page URL contains ?test=1.
 *
 * M2-07 wiring: the `sim` sub-API drives the deterministic core directly —
 * import rule for this entry: sim + types ONLY (eslint zones leave src/
 * root unrestricted; the discipline is manual here: no platform, no render,
 * no input imports — keyboard wiring belongs to main.ts/platform).
 * loadMap stays a stub: boot (wadload → G_InitGame → attach) is main.ts
 * wiring (M2-plan lists main.ts under M2-07 but this branch's ownership
 * excludes it — see DEVIATIONS); until then headless/tests attach states
 * directly.
 * M3-07: the render half arrives WITHOUT breaking that discipline —
 * {@link attachRenderDebug} takes a STRUCTURAL source (live fb.indices + a
 * counters getter) that main.ts wires from render/solidsegs; capture()
 * copies the real framebuffer and state().render.hom is live (no more −1
 * stub once attached; −1 remains the pre-boot value).
 * M11-10 (this file, ADDITIVE): persistence seams inside state()/commands —
 * `state().persist = {lastSaveTic, savesCount, settingsLoaded}` (sim saveFlow
 * + the main.ts-mounted store snapshot) and the __doom seam commands
 * save(slot, desc?) / load(slot) / settings(patch?) / recordDemo(name?) /
 * playDemo(bytes) / demoStatus() / typeChars(text) (the L4 cheat-injection
 * hook). NO new globals: the commands ride the existing debugApi object;
 * the async/store halves arrive through {@link attachPersistDebug} (the
 * attachRenderDebug/attachUiDebug discipline — src/persist imports live in
 * the composer, this file keeps sim+types plus the audio precedent).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { gSaveGame, runHeadless, GS, saveFlow } from './sim/game';
import {
  demoBytes,
  demoPlaying,
  demoRecording,
  gDeferedPlayDemo,
  gStartRecordDemo
} from './sim/pDemo';
import { pTeleportMove } from './sim/pmap';
import {
  CF_GODMODE,
  CF_NOCLIP,
  MF_NOCLIP,
  MF_NOGRAVITY,
  NUMCARDS
} from './sim/player';
import { hashState, type GameState } from './sim/state';
import { thinkerCount } from './sim/ptick';
import { asMobj } from './sim/p_mobj';
import { MF, MT } from './wad/info/mobjinfo';
import type { DebugMonsters, DebugMonsterView } from './types/debug';
import { type InventoryFields, type PickupPlayer } from './sim/p_inter_inventory';
import { P_GiveWeapon } from './sim/p_inter_pickup';
import { pPlayerDamage } from './sim/pplayer';
import type { PsprFields } from './sim/p_pspr';
import { emptyInput, type GameInput } from './sim/ticcmd';
// M10-09: audio composer seam. debug.ts is a wiring ENDPOINT (eslint zones
// leave src/ root unrestricted); the ui/menu import is TRANSITIVE via
// wiring.ts (its read-only thermos pump), never direct here. main.ts owns
// the production install (M10-06's installAudio site) — until that lands
// this file installs the wiring for dev/test boots only.
import { audioWiringState, installAudioWiring, installSfxBridges } from './audio/wiring';
import type {
  CaptureResult,
  DebugGamestateName,
  DebugScreenRead,
  DebugStateLive,
  DebugStateSnapshot,
  DebugUiRead,
  DoomDebugApi,
  SimDebugApi
} from './types/debug';

const RENDER_WIDTH = 320;
const RENDER_HEIGHT = 200;

/** Live state driven by this entry (attached by platform boot or tests). */
let attached: GameState | null = null;
/** Sticky e2e input override (null = per-call/empty input). */
let inputOverride: GameInput | null = null;
let paused = false;

/**
 * M3-07 render seam: structural (no render import from this file — see
 * header). `indices` is the LIVE framebuffer index store (read per capture;
 * main.ts passes `fb.indices`, never a copy); `counters` returns the live
 * render health counters (M4-07: renderer.ts getFrameCounters wired in
 * main.ts — hom plus the four vanilla-cap overflow counters, all −1 while
 * detached).
 */
export interface RenderDebugSource {
  readonly indices: Uint8Array;
  counters(): {
    hom: number;
    visplaneOverflow: number;
    visspriteOverflow: number;
    openingOverflow: number;
    drawsegOverflow: number;
  };
  /** B-07/B-08: optional sprite-pass fingerprint source (renderer.ts
   * getSpritePassStats; state().render.sprites, absent ⇒ zeros). */
  sprites?(): {
    drawn: number;
    sumX: number;
    sumY: number;
  };
}

let renderSource: RenderDebugSource | null = null;

/**
 * M5-08 mouse-injection seam: main.ts registers a raw-delta injector feeding
 * the SAME ev_mouse accumulator the pointer-lock mousemove path feeds
 * (input/mouse.ts `motion`) — the event-queue seam M5-plan §5.4/§6 puts the
 * load on, since headless-chromium pointer lock is unreliable. No sim import
 * here: the injector is a plain (dx,dy)=>void callback.
 */
let mouseInjector: ((dx: number, dy: number) => void) | null = null;

export function attachMouseInjection(fn: ((dx: number, dy: number) => void) | null): void {
  mouseInjector = fn;
}

/**
 * M6-13 FINDING 3 seam: main.ts registers the input-DRAIN hook feeding
 * {@link DoomDebugApi.popInput} — the same vanilla D_ProcessEvents queue
 * stepTic drains once per tic, plus the raw mouse accumulator. Plain
 * callback (no platform import here, same discipline as the mouse seam).
 */
export type PopInputFn = () => { events: number; mouse: { x: number; y: number } };

let popInputHook: PopInputFn | null = null;

export function attachPopInput(fn: PopInputFn | null): void {
  popInputHook = fn;
}

/**
 * M8-12 monster roll-up (M8-plan §M8-12 `state().mobjs`): iterate the
 * level's mobj roster, keep MF_COUNTKILL thinkers (MT_BARREL tallied
 * separately by TYPE — this port's MT_BARREL row carries no MF_COUNTKILL
 * bit (mobjinfo flags 0x80006), so a flags-only scan would never see it;
 * barrels are not "monsters" for the e2e census), corpses included while
 * un-removed so the e2e can watch the A_Fall SOLID-clear. Pure READ — no
 * sim call, nothing hashed.
 */
function monstersSnapshot(state: GameState): DebugMonsters {
  const playerMo = asMobj(state.players[0]!.mo);
  const byType: Record<number, number> = {};
  const views: DebugMonsterView[] = [];
  let barrels = 0;
  for (const m of state.mobjs.mobjs) {
    if (m.removed) continue;
    if (m.type === MT.MT_BARREL) {
      if (m.health > 0) barrels++;
      continue; // this table's MT_BARREL carries NO MF_COUNTKILL bit
    }
    if ((m.flags & MF.MF_COUNTKILL) === 0) continue;
    if (views.length < 128) {
      views.push({
        type: m.type,
        thinkerId: m.thinker.id,
        x: m.x,
        y: m.y,
        health: m.health,
        state: m.state,
        movedir: m.movedir,
        movecount: m.movecount,
        flags: m.flags,
        flagsLite: {
          solid: (m.flags & MF.MF_SOLID) !== 0,
          shootable: (m.flags & MF.MF_SHOOTABLE) !== 0,
          shadow: (m.flags & MF.MF_SHADOW) !== 0,
          ambush: (m.flags & MF.MF_AMBUSH) !== 0,
          corpse: (m.flags & MF.MF_CORPSE) !== 0
        },
        targetSlot: m.target ? m.target.linkSlot : null,
        targetPlayer: m.target !== undefined && m.target === playerMo
      });
    }
    if (m.health > 0) byType[m.type] = (byType[m.type] ?? 0) + 1;
  }
  const alive = Object.values(byType).reduce((a, b) => a + b, 0);
  return { alive, byType, barrels, killcount: state.players[0]!.killcount, first: views[0] ?? null, mobjs: views };
}

/** The documented counter subset (extra source fields like solidsegDrops are
 * deliberately not echoed into the §7 snapshot shape). */
function pickCounters(c: {
  hom: number;
  visplaneOverflow: number;
  visspriteOverflow: number;
  openingOverflow: number;
  drawsegOverflow: number;
}): Omit<DebugStateLive['render'], 'sprites'> {
  return {
    hom: c.hom,
    visplaneOverflow: c.visplaneOverflow,
    visspriteOverflow: c.visspriteOverflow,
    openingOverflow: c.openingOverflow,
    drawsegOverflow: c.drawsegOverflow,
  };
}

const UNATTACHED_COUNTERS: DebugStateLive['render'] = {
  hom: -1,
  visplaneOverflow: -1,
  visspriteOverflow: -1,
  openingOverflow: -1,
  drawsegOverflow: -1,
  sprites: { drawn: 0, sumX: 0, sumY: 0 },
};

/** Wire (or detach with null) the render source; called by main.ts once the
 * framebuffer exists. */
export function attachRenderDebug(src: RenderDebugSource | null): void {
  renderSource = src;
}

function requireState(): GameState {
  if (!attached) throw new Error('no simulation attached (loadMap/main boot pending)');
  return attached;
}

/** BAM (u32) → degrees [0,360), exact via the 2^32 circle. */
export function bamToDeg(bam: number): number {
  return ((bam >>> 0) / 4294967296) * 360;
}

/** Degrees → BAM (floor on the 2^32 circle; debug warp is exact-deg, not
 * the THINGS ANG45*(deg/45) quantization of p_mobj.c). */
export function degToBam(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return Math.floor((d / 360) * 4294967296) >>> 0;
}

function setNoclipOnPlayer(state: GameState, enabled: boolean): boolean {
  const p = state.players[0]!;
  if (enabled) p.cheats |= CF_NOCLIP;
  else p.cheats &= ~CF_NOCLIP;
  // mirror the per-tic p_user.c sync so the flag reads back before a tic
  if (p.cheats & CF_NOCLIP) p.mo.flags |= MF_NOCLIP | MF_NOGRAVITY;
  else p.mo.flags &= ~(MF_NOCLIP | MF_NOGRAVITY);
  return (p.cheats & CF_NOCLIP) !== 0;
}

/**
 * M9-12 UI-read seam: main.ts registers a plain closure producing the
 * menu/HUD/title/finale/WI read bundle — the SAME structural discipline
 * as attachRenderDebug/attachPopInput (no ui/platform import lands in
 * this file; the sim+types-only rule of this module's header stands).
 */
export type UiReadFn = () => DebugUiRead | null;

let uiRead: UiReadFn | null = null;

export function attachUiDebug(fn: UiReadFn | null): void {
  uiRead = fn;
}

/* ------------------------------------------------------------------ */
/* M11-10 persistence seams (plan §M11-10)                             */
/* ------------------------------------------------------------------ */

/** The additive `state().persist` block (types/debug.ts untouched — the
 * live snapshot is widened HERE; consumers read it through the
 * intersection, exactly like every earlier additive state field). */
export interface DebugPersistRead {
  /** gametic of the last EXECUTED save (ga_savegame drain) — -1 = none. */
  lastSaveTic: number;
  /** non-empty slots of the mounted store snapshot (0 while detached) */
  savesCount: number;
  /** settings.ts hydrate completed (fail-closed: false until then) */
  settingsLoaded: boolean;
}

/** The `__doom.settings()` echo (settings.ts SettingsView, plain data). */
export interface DebugSettingsEcho {
  loaded: boolean;
  vars: Record<string, number>;
  keys: Record<string, number>;
}

/** The `__doom.demoStatus()` echo (pDemo flags + last recording size). */
export interface DebugDemoStatus {
  recording: boolean;
  playing: boolean;
  bytes: number;
}

/** The additive command surface riding the existing __doom object
 * (plan §M11-10: save/load/settings/recordDemo/playDemo + the L4
 * cheat-injection hook; no new globals). */
export interface DebugPersistApi {
  /** Arm G_SaveGame(slot, desc) and AWAIT the drain + store write
   * (durability for save→reload e2e). true = landed in the store. */
  save(slot: number, desc?: string): Promise<boolean>;
  /** store.get → decode → ga_loadgame (executes in the NEXT drain).
   * true = armed; false = empty slot / no wiring (silent vanilla lane). */
  load(slot: number): Promise<boolean>;
  /** Read the settings echo; with a patch, setMany() first (write-on-
   * change → debounced store.put happens inside settings.ts). */
  settings(patch?: Readonly<Record<string, unknown>>): DebugSettingsEcho;
  /** G_RecordDemo + G_BeginRecording on the attached state. */
  recordDemo(name?: string): boolean;
  /** queue ga_playdemo over the bytes (G_DeferedPlayDemo). */
  playDemo(bytes: Uint8Array): boolean;
  demoStatus(): DebugDemoStatus;
  /** Push typed characters through the real D_ProcessEvents queue (the
   * cheat-sequence injection hook for L4); false when unmounted. */
  typeChars(text: string): boolean;
}

/** The seam object main.ts's M11-10 composer mounts. The SIM halves
 * (G_SaveGame arm, demo arms, saveFlow reads) run HERE via sim imports;
 * the store/settings/event-queue halves (load, echoes, typeChars) ride
 * this object — the same split as popInput/aiGate (no persist import
 * lands in this file). */
export interface PersistDebugSource {
  /** non-empty-slot count of the last-known store snapshot */
  savesCount(): number;
  /** settings controller hydrate state */
  settingsLoaded(): boolean;
  settingsView(): DebugSettingsEcho;
  /** setMany() through the live controller; returns applied names */
  settingsApply(patch: Readonly<Record<string, unknown>>): string[];
  /** menuSaveLoad.loadSlot against the LIVE state (async drain arming);
   * false = no state / no store (the silent vanilla-faithful lane) */
  loadSlot(slot: number): boolean;
  /** await every queued store write (e2e durability hop) */
  flushWrites(): Promise<void>;
  /** push a typed character sequence through the D_ProcessEvents queue
   * (the L4 cheat-injection hook — real keydown/keyup-shaped packets) */
  typeChars(text: string): void;
}

let persistSrc: PersistDebugSource | null = null;

/** Mount (null detaches) the persistence seam — main.ts composer only. */
export function attachPersistDebug(src: PersistDebugSource | null): void {
  persistSrc = src;
}

function persistRead(): DebugPersistRead {
  return {
    lastSaveTic: saveFlow.lastSaveTic,
    savesCount: persistSrc === null ? 0 : persistSrc.savesCount(),
    settingsLoaded: persistSrc === null ? false : persistSrc.settingsLoaded()
  };
}

/**
 * M12-04 perf-read seam (plan §M12-04b): main.ts registers a plain closure
 * over the LOOP's own timing rings (performance.now deltas captured around
 * stepTic()/render() — timing stays PLATFORM-side, the sim never sees
 * performance/Date: A-06 holds). Structural discipline as attachUiDebug —
 * no platform import lands in this file; the read is pure data.
 */
export interface DebugPerfRead {
  /** total sim tics timed since boot (monotone) */
  tics: number;
  /** total render frames timed since boot (monotone) */
  frames: number;
  /** ring capacity (samples retained oldest→newest in the arrays) */
  capacity: number;
  /** per-tic ms (stepTic wall cost), oldest→newest, ≤ capacity entries */
  ticMs: number[];
  /** per-frame ms (render() wall cost incl. blit), oldest→newest */
  frameMs: number[];
}

export type PerfReadFn = () => DebugPerfRead;

let perfSrc: PerfReadFn | null = null;

/** Mount (null detaches) the perf read closure — main.ts composer only. */
export function attachPerfDebug(fn: PerfReadFn | null): void {
  perfSrc = fn;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** gamestate number → the §7 name (M9: all four states live). */
function gamestateName(gs: number): DebugGamestateName {
  switch (gs) {
    case GS.INTERMISSION:
      return 'GS_INTERMISSION';
    case GS.FINALE:
      return 'GS_FINALE';
    case GS.DEMOSCREEN:
      return 'GS_DEMOSCREEN';
    default:
      return 'GS_LEVEL';
  }
}

/** Pure GameState field reads (no ui import — the debug.ts zone rule). */
export function screenRead(state: GameState): DebugScreenRead {
  return {
    gamestate: state.gamestate,
    gameaction: state.gameaction,
    paused: state.paused,
    usergame: state.usergame,
    advancedemo: state.advancedemo,
    viewactive: state.viewactive,
    gameepisode: state.gameepisode,
    gamemap: state.gamemap,
    gameskill: state.gameskill
  };
}

/** The §7 live snapshot (raw `screen` flags added by the M9-12 seam). */
function liveSnapshot(state: GameState): DebugStateLive {
  const p = state.players[0]!;
  // M7 attaches these field packs in place (initPlayerInventory /
  // attachPsprFields) — read them structurally, never assume attach.
  const inv = p as Partial<InventoryFields>;
  const psprF = p as Partial<PsprFields>;
  return {
    ready: true,
    gametic: state.gametic,
    leveltime: state.leveltime,
    map: state.map.name,
    gamestate: gamestateName(state.gamestate),
    player: {
      x: p.mo.x,
      y: p.mo.y,
      z: p.mo.z,
      // M5-08 read-out: the live P_CalcHeight outputs (viewz is the 0-pin
      // until the first tic; see sim/player.ts spawn pin note).
      viewz: p.viewz,
      bob: p.bob,
      angleDeg: bamToDeg(p.mo.angle),
      health: p.health,
      // M7-11c (direct): G9-era pinned defaults REPLACED by live fields —
      // the inventory/pspr attaches (initPlayerInventory, attachPsprFields,
      // G_PlayerReborn) populate them; before any attach they read zero.
      armor: inv.armorpoints ?? 0,
      ammo: inv.ammo ? Array.from(inv.ammo) : [],
      weapons: inv.weaponowned
        ? inv.weaponowned.reduce((acc: number, v: number, i: number) => acc | (v << i), 0)
        : 0,
      powerups: inv.powers
        ? Object.fromEntries(Array.from<number>(inv.powers).map((v, i) => [`p${i}`, v]))
        : {},
      onGroundSector: -1,
      noclip: (p.cheats & CF_NOCLIP) !== 0,
      // M6-11: live card inventory (IT_* slot order; giveCard until M7).
      cards: Array.from(p.cards),
      readyweapon: inv.readyweapon ?? 0,
      pendingweapon: inv.pendingweapon ?? 0,
      pspr: psprF.psprites
        ? psprF.psprites.map((s, slot) => ({ slot, state: s.state, sx: s.sx, sy: s.sy }))
        : []
    },
    sectors: { count: state.map.sectors.count },
    // M8-12: live monster census + per-monster views (roll-up above).
    monsters: monstersSnapshot(state),
    // live arena census (M7-11c: G9-era pinned 0 replaced — the -1 the
    // reviewer spotted originated here).
    thinkers: { count: thinkerCount(state.thinkers) },
    // M3-07/M4-07: live renderer counters (−1 only pre-boot / pre-attach).
    // Shaped explicitly: the render source carries more (solidsegDrops),
    // state().render documents exactly hom + the four overflow caps.
    render:
      renderSource === null
        ? { ...UNATTACHED_COUNTERS }
        : {
          ...pickCounters(renderSource.counters()),
          sprites: renderSource.sprites ? renderSource.sprites() : UNATTACHED_COUNTERS.sprites,
        },
    screen: screenRead(state),
    // M10-09 seam: live audio read-view (pure reads; pumps the menu thermos
    // first so L4 volume moves are observable on the same read).
    audio: audioWiringState(),
    hash: hashState(state)
  };
}

/** Exported singleton (tests/headless attach states directly; the browser
 * gets the same object via window.__doom.sim once installed). */
export const debugSim: SimDebugApi = {
  attach(state: GameState): GameState {
    attached = state;
    // M10-10-3: the headless/dev attach path installs the SAME sfx bridges
    // production does (the shared wiring.ts export — bridge parity between
    // the main.ts boot and every state attached here; idempotent when
    // main.ts already installed them on this same state).
    installSfxBridges(state);
    return state;
  },
  detach(): void {
    attached = null;
    inputOverride = null;
  },
  getState(): GameState | null {
    return attached;
  },
  setNoclip(enabled: boolean): boolean {
    return setNoclipOnPlayer(requireState(), enabled);
  },
  getNoclip(): boolean {
    return ((requireState().players[0]?.cheats ?? 0) & CF_NOCLIP) !== 0;
  },
  killPlayer(): 'ok' {
    // Death-by-damage debug channel (M7-11c): P_DamageMobj with a lethal
    // hit — the vanilla-faithful route (P_KillMobj alone only decrements
    // health; every real death arrives through the damage entry point).
    const state = requireState();
    pPlayerDamage(state.players[0]!.mo as never, null, null, 1000);
    return 'ok';
  },
  giveWeapon(weapon: number): boolean {
    // P_GiveWeapon debug channel (M7-11c): scripted weapon tests without
    // routing item mobjs; real gameplay uses P_TouchSpecialThing.
    const state = requireState();
    return P_GiveWeapon(state.players[0] as unknown as PickupPlayer, weapon, false);
  },
  giveCard(index: number): number[] {
    // P_GiveCard debug channel (D013(f), M6-plan §0.6/§M6-11): M7's real
    // pickups (doomednum 5/6/13 → P_TouchSpecialThing) replace this.
    if (!Number.isInteger(index) || index < 0 || index >= NUMCARDS) {
      throw new RangeError(`giveCard: card index ${index} outside 0..${NUMCARDS - 1}`);
    }
    const p = requireState().players[0]!;
    p.cards[index] = 1;
    return Array.from(p.cards);
  },
  runTics(tics: number, input?: Partial<GameInput> | null): number {
    const state = requireState();
    const snap: GameInput | undefined = input ? { ...emptyInput(), ...input } : inputOverride ?? undefined;
    return runHeadless(state, tics, snap ? () => ({ ...snap }) : undefined);
  },
  setInput(input: Partial<GameInput> | null): void {
    inputOverride = input ? { ...emptyInput(), ...input } : null;
  },
  getInput(): GameInput | null {
    return inputOverride ? { ...inputOverride } : null;
  },
  warp(x: number, y: number, z?: number, angleDeg?: number): void {
    const st = requireState();
    const p = st.players[0]!;
    if (angleDeg !== undefined) p.mo.angle = degToBam(angleDeg);
    // M5-06: real teleport semantics — P_TeleportMove relinks and refreshes
    // floorz/ceilingz (the physics reads them the very next tic), then the
    // ONFLOORZ-default resolves to the destination floor (p_mobj.c:522).
    pTeleportMove(st.pmap, p.mo, x | 0, y | 0);
    p.mo.z = z === undefined ? p.mo.floorz : z | 0;
    // teleport semantics (§7): reactiontime lockout deliberately NOT set —
    // debug warps must not silently swallow the tics a test steps next.
  },
  injectMouse(dx: number, dy: number): void {
    requireState();
    if (mouseInjector === null) {
      throw new Error('injectMouse: main.ts mouse wiring not registered');
    }
    mouseInjector(dx | 0, dy | 0);
  }
};

/** The same singleton installed as window.__doom by installDebugApi().
 * M11-10: DoomDebugApi & DebugPersistApi — the additive persistence
 * commands ride the SAME object (plan: no new globals). */
export const debugApi: DoomDebugApi & DebugPersistApi = {
  sim: debugSim,
  loadMap(mapName: string): void {
    throw new Error(
      `loadMap(${mapName}): main.ts sim boot is pending (M2-07 DEVIATIONS); ` +
        `attach a state via __doom.sim.attach(state) in the meantime`
    );
  },
  warp(x: number, y: number, z?: number, angleDeg?: number): void {
    debugSim.warp(x, y, z, angleDeg);
  },
  god(enabled?: boolean): boolean {
    if (attached) {
      const p = attached.players[0]!;
      if (enabled !== undefined) {
        if (enabled) p.cheats |= CF_GODMODE;
        else p.cheats &= ~CF_GODMODE;
      }
      return (p.cheats & CF_GODMODE) !== 0;
    }
    return false;
  },
  noclip(enabled?: boolean): boolean {
    if (!attached) return false;
    if (enabled === undefined) return debugSim.getNoclip();
    return debugSim.setNoclip(enabled);
  },
  step(tics: number): number {
    // §7: run exactly n tics with empty input (pause state irrelevant —
    // step is the explicit driver), return the post-run hash.
    return debugSim.runTics(tics);
  },
  pause(next?: boolean): boolean {
    if (next !== undefined) paused = next;
    return paused;
  },
  state(): DebugStateSnapshot {
    if (!attached) return { ready: false, note: 'no simulation attached yet' };
    // M11-10 ADDITIVE: the persist block joins the live snapshot; every
    // pre-existing field rides untouched (assertion = the widening seam).
    // M12-04 ADDITIVE: `perf` (attachPerfDebug closure; absent ⇒ field
    // missing, e.g. headless attaches without the loop wiring).
    return {
      ...liveSnapshot(attached),
      persist: persistRead(),
      ...(perfSrc !== null ? { perf: perfSrc() } : {})
    } as DebugStateSnapshot;
  },

  /* ---- M11-10 persistence seam commands (plan §M11-10) ---- */

  async save(slot: number, desc?: string): Promise<boolean> {
    if (!attached) return false;
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return false;
    // G_SaveGame = the DEFERRED half (g_game.c:1256, §0.3): the capture +
    // store write land at the NEXT drain (vanilla's tic-boundary site).
    const before = saveFlow.savesDone;
    gSaveGame(slot, desc ?? `${attached.map.name}@${attached.leveltime}`);
    // Wait for the drain (live page: ≤1 tic; headless: the caller's next
    // runTics), then for every queued store write — durability for e2e
    // save→reload flows.
    for (let i = 0; i < 350 && saveFlow.savesDone === before; i++) await sleep(10);
    if (saveFlow.savesDone === before) return false;
    if (persistSrc !== null) await persistSrc.flushWrites();
    return true;
  },
  async load(slot: number): Promise<boolean> {
    if (!attached || persistSrc === null) return false;
    // store.get → decode → gRequestLoadGame (ga_loadgame executes in the
    // NEXT drain — vanilla's deferral; the caller steps/polls to observe).
    return persistSrc.loadSlot(slot);
  },
  settings(patch?: Readonly<Record<string, unknown>>): DebugSettingsEcho {
    if (patch !== undefined && persistSrc !== null) persistSrc.settingsApply(patch);
    return persistSrc === null
      ? { loaded: false, vars: {}, keys: {} }
      : persistSrc.settingsView();
  },
  recordDemo(name?: string): boolean {
    if (!attached) return false;
    // G_RecordDemo + G_BeginRecording at the loop top (d_main.c:356-357);
    // the tics ride gWriteDemoTiccmd inside the drain, the file half
    // arrives via the captureSink ('demo' kind) when it finishes.
    gStartRecordDemo(attached, name);
    return true;
  },
  playDemo(bytes: Uint8Array): boolean {
    if (!attached || !(bytes instanceof Uint8Array) || bytes.length < 13) return false;
    gDeferedPlayDemo(attached, bytes); // ga_playdemo drains NEXT tic
    return true;
  },
  demoStatus(): DebugDemoStatus {
    return {
      recording: demoRecording(),
      playing: demoPlaying(),
      bytes: demoBytes()?.length ?? 0
    };
  },
  typeChars(text: string): boolean {
    if (persistSrc === null) return false;
    persistSrc.typeChars(text);
    return true;
  },
  popInput(): { events: number; mouse: { x: number; y: number } } | null {
    // M6-13 finding 3: scripted e2e phases run under pause(true) via
    // sim.runTics — events queued meanwhile would otherwise flush in one
    // burst on resume. Pop (and report) them between phases.
    return popInputHook === null ? null : popInputHook();
  },
  aiGate(on: boolean): boolean {
    // M8-fix static-dummy seam (popInput precedent: plain wiring, no sim
    // import): flip the hooks.aiGate of the ATTACHED state — true installs
    // "skip A_Look/A_Chase dispatch" (static fixture dummies), false
    // restores production AI. No state attached ⇒ nothing to gate.
    if (!attached) return false;
    attached.hooks.aiGate = on ? () => true : null;
    return on;
  },
  capture(): CaptureResult {
    // M3-07: real framebuffer copy (live fb.indices via the render seam);
    // pre-boot (no source yet) keeps the documented all-zeros contract.
    const src = renderSource === null ? null : renderSource.indices;
    return {
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
      indices:
        src !== null && src.length === RENDER_WIDTH * RENDER_HEIGHT
          ? new Uint8Array(src)
          : new Uint8Array(RENDER_WIDTH * RENDER_HEIGHT),
    };
  },
  ui(): DebugUiRead | null {
    // M9-12: the ui read bundle (attachUiDebug closure; headless/tests
    // without the boot wiring report null, exactly like popInput).
    return uiRead === null ? null : uiRead();
  },
};

declare global {
  interface Window {
    __doom?: DoomDebugApi & DebugPersistApi;
  }
}

export function installDebugApi(): void {
  const wantDebug = import.meta.env.DEV || new URLSearchParams(location.search).has('test');
  if (!wantDebug) return;
  // M10-09: dev/test boots get the audio composer (gesture gate + rAF volume
  // pump + live fan-out dispatcher) without waiting for main.ts's M10-06
  // installAudio call. Idempotent + silent (plan acceptance 4).
  installAudioWiring();
  window.__doom = debugApi;
}
