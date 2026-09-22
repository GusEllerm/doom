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
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { runHeadless, GS } from './sim/game';
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
    hash: hashState(state)
  };
}

/** Exported singleton (tests/headless attach states directly; the browser
 * gets the same object via window.__doom.sim once installed). */
export const debugSim: SimDebugApi = {
  attach(state: GameState): GameState {
    attached = state;
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

/** The same singleton installed as window.__doom by installDebugApi(). */
export const debugApi: DoomDebugApi = {
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
    return liveSnapshot(attached);
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
    __doom?: DoomDebugApi;
  }
}

export function installDebugApi(): void {
  const wantDebug = import.meta.env.DEV || new URLSearchParams(location.search).has('test');
  if (!wantDebug) return;
  window.__doom = debugApi;
}
