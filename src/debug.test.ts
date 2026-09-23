/**
 * sim-facing debug seams (src/debug.ts) — M6-13 finding 3: popInput; M8-fix
 * static-dummy seam: aiGate. The main.ts input wiring is a plain callback
 * hook; headless asserts the seam contract (null while detached, hook
 * result passthrough, clean detach). SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { attachPopInput, debugApi } from './debug';

describe('debugApi.popInput (M6-13 finding 3 seam)', () => {
  it('null while the main.ts input wiring is detached', () => {
    attachPopInput(null);
    expect(debugApi.popInput()).toBeNull();
  });

  it('passes the drain report through and detaches cleanly', () => {
    let dropped = 3;
    attachPopInput(() => {
      const events = dropped;
      dropped = 0; // popped once — a second call reports an empty drain
      return { events, mouse: { x: -7, y: 2 } };
    });
    expect(debugApi.popInput()).toEqual({ events: 3, mouse: { x: -7, y: 2 } });
    expect(debugApi.popInput()).toEqual({ events: 0, mouse: { x: -7, y: 2 } });
    attachPopInput(null);
    expect(debugApi.popInput()).toBeNull();
  });
});

describe('debugApi.aiGate (M8-fix static-dummy seam)', () => {
  it('nothing to gate while no simulation is attached', () => {
    // Contract mirrors popInput's detached-null: the seam is state wiring,
    // so pre-attach requests report false without throwing.
    expect(debugApi.aiGate(true)).toBe(false);
    expect(debugApi.aiGate(false)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* M8-12: state().monsters monster roll-up seam                         */
/* ------------------------------------------------------------------ */

import { buildFixtureMapWad } from '../tests/fixtures/mapBuilder';
import { buildMapFromData } from './sim/map';
import { loadMap } from './wad/mapdata';
import { WadFile } from './wad/wadfile';
import { gInitGame } from './sim/game';
import { debugSim } from './debug';
import type { DebugStateLive } from './types/debug';

describe('debugApi.state().monsters (M8-12 seam)', () => {
  function attachWithMonster(dx: number): void {
    const bytes = buildFixtureMapWad({
      rooms: [{ x: 0, y: 0, w: 512, h: 256, lightLevel: 200 }],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 }, // player 1 start, facing east
        { x: 64 + dx, y: 128, angle: 180, type: 3004 } // MT_POSSESSED facing the player
      ]
    });
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    debugSim.attach(gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'))));
  }

  it('rolls up the MF_COUNTKILL roster (alive/byType/killcount/first views)', () => {
    attachWithMonster(320);
    const s = debugApi.state() as DebugStateLive;
    expect(s.monsters.alive).toBe(1);
    expect(s.monsters.byType).toEqual({ 1: 1 }); // MT_POSSESSED
    expect(s.monsters.barrels).toBe(0);
    expect(s.monsters.killcount).toBe(0);
    expect(s.monsters.mobjs).toHaveLength(1);
    const m = s.monsters.first!;
    expect(m.type).toBe(1);
    expect(m.health).toBe(20);
    expect(m.flagsLite).toEqual({ solid: true, shootable: true, shadow: false, ambush: false, corpse: false });
    expect(m.targetPlayer).toBe(false);
    expect(m.targetSlot).toBeNull();
    debugSim.detach();
  });

  it('the SIGHT wake shows up as targetPlayer=true + see-state at the exact tic', () => {
    attachWithMonster(200); // LOS on the eye line, facing each other
    let wokeAt = -1;
    for (let t = 1; t <= 40; t++) {
      debugSim.runTics(1);
      const s = debugApi.state() as DebugStateLive;
      if (s.monsters.mobjs[0]!.targetPlayer) {
        wokeAt = t;
        break;
      }
    }
    expect(wokeAt).toBeGreaterThan(0);
    const s = debugApi.state() as DebugStateLive;
    expect(s.monsters.mobjs[0]!.state).toBeGreaterThanOrEqual(176); // ≥ S_POSS_RUN1 (see-state row)
    debugSim.detach();
  });
});

/* ------------------------------------------------------------------ */
/* M11-10: persistence seams (state().persist + save/load/settings/    */
/* demo/typeChars commands). Stubbed-host discipline: the persist      */
/* SOURCE is attached per-test (main.ts composer mounts the live one); */
/* openStore in node = the memory adapter (idb.ts degradation).        */
/* ------------------------------------------------------------------ */

import { attachPersistDebug, debugApi as debugApiM11 } from './debug';
import type { DebugPersistRead } from './debug';
import { resetSaveFlow, saveFlow } from './sim/game';
import { resetDemo } from './sim/pDemo';
import { registerCaptureSink } from './sim/hooks';
import { createSettingsController, DEFAULT_CONFIG_VARS } from './persist/settings';
import { openStore } from './persist/store';
import { setSfxThermo, sfxThermo } from './audio/volumes';
import {
  bindStore as bindSaveLoadStore,
  createCaptureHandler,
  flushWrites as flushSaveLoadWrites,
  loadSlot as persistLoadSlot,
  resetSaveLoad,
  slotRows
} from './ui/menuSaveLoad';

type LiveWithPersist = DebugStateLive & { persist: DebugPersistRead };

function attachPlain(): void {
  const bytes = buildFixtureMapWad({
    rooms: [{ x: 0, y: 0, w: 512, h: 256, lightLevel: 200 }],
    things: [{ x: 64, y: 128, angle: 0, type: 1 }]
  });
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  debugSim.attach(gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'))));
}

function noopPersistSource(over: Partial<Parameters<typeof attachPersistDebug>[0] & object> = {}) {
  const src = {
    savesCount: () => 0,
    settingsLoaded: () => false,
    settingsView: () => ({ loaded: false, vars: {}, keys: {} }),
    settingsApply: () => [] as string[],
    loadSlot: () => false,
    flushWrites: () => Promise.resolve(),
    typeChars: () => undefined
  };
  attachPersistDebug({ ...src, ...over } as never);
  return over;
}

describe('M11-10 persist seams — state().persist', () => {
  it('detached source reports the documented zero shape', () => {
    resetSaveFlow();
    resetSaveLoad();
    attachPersistDebug(null);
    attachPlain();
    const s = debugApiM11.state() as LiveWithPersist;
    expect(s.persist).toEqual({ lastSaveTic: -1, savesCount: 0, settingsLoaded: false });
    debugSim.detach();
  });

  it('boot order: hydrated settings are observable BEFORE the first gTicker', async () => {
    resetSaveFlow();
    const store = await openStore(); // memory adapter in node
    await store.putSettings({
      settings: { schema: 1, vars: { ...DEFAULT_CONFIG_VARS, sfx_volume: 3 }, keys: {} }
    });
    const ctrl = createSettingsController({ store });
    attachPlain();
    noopPersistSource({
      settingsLoaded: () => ctrl.status().loaded,
      settingsView: () => ({
        loaded: ctrl.status().loaded,
        vars: { ...ctrl.view().vars },
        keys: { ...ctrl.view().keys }
      }),
      settingsApply: (patch) => ctrl.setMany(patch)
    });
    // Pre-hydrate (defaults stand, fail-closed): NOT loaded, shipped thermo.
    expect((debugApiM11.state() as LiveWithPersist).persist.settingsLoaded).toBe(false);
    expect(sfxThermo()).toBe(8);
    await ctrl.hydrate();
    const st = debugSim.getState()!;
    expect(st.gametic).toBe(0); // no tic consumed by the IDB read (D-11b)
    const s = debugApiM11.state() as LiveWithPersist;
    expect(s.persist.settingsLoaded).toBe(true);
    expect(sfxThermo()).toBe(3); // volume applied through the merged setter
    // settings(patch?) command: read echo + write-through to the home.
    expect(debugApiM11.settings().vars.sfx_volume).toBe(3);
    debugApiM11.settings({ sfx_volume: 5 });
    expect(sfxThermo()).toBe(5);
    await ctrl.flush();
    attachPersistDebug(null);
    setSfxThermo(8); // restore the module-level home for sibling tests
    debugSim.detach();
  });

  it('commands report inert defaults with no state/source attached', async () => {
    resetSaveFlow();
    attachPersistDebug(null);
    debugSim.detach();
    expect(await debugApiM11.save(0)).toBe(false);
    expect(await debugApiM11.load(0)).toBe(false);
    expect(debugApiM11.settings()).toEqual({ loaded: false, vars: {}, keys: {} });
    expect(debugApiM11.recordDemo()).toBe(false);
    expect(debugApiM11.playDemo(new Uint8Array(20))).toBe(false);
    expect(debugApiM11.typeChars('idkfa')).toBe(false);
    expect(debugApiM11.demoStatus()).toEqual({ recording: false, playing: false, bytes: 0 });
  });

  it('save(slot, desc) arms → drains → lands in the store; load(slot) restores', async () => {
    resetSaveFlow();
    resetSaveLoad();
    const store = await openStore();
    bindSaveLoadStore(store);
    registerCaptureSink(createCaptureHandler(store));
    attachPlain();
    let loadArmed: Promise<unknown> = Promise.resolve();
    noopPersistSource({
      savesCount: () => slotRows().reduce((n, r) => n + (!r.empty && r.error === null ? 1 : 0), 0),
      loadSlot: (slot) => {
        loadArmed = persistLoadSlot(debugSim.getState()!, slot);
        return true;
      },
      flushWrites: flushSaveLoadWrites
    });
    const p = debugApiM11.save(3, 'seam save');
    debugApiM11.step(2); // tic 1: sendsave→cmd→ga_savegame; tic 2: the DRAIN (§0.3)
    expect(await p).toBe(true);
    let s = debugApiM11.state() as LiveWithPersist;
    expect(s.persist.lastSaveTic).toBeGreaterThanOrEqual(1); // the §0.3 drain site
    expect(s.persist.savesCount).toBe(1);
    debugSim.getState()!.players[0]!.health = 55; // post-save mutation
    expect(await debugApiM11.load(3)).toBe(true);
    await loadArmed; // store.get → decode → gRequestLoadGame landed
    debugApiM11.step(1); // the ga_loadgame drain (restoreWorld)
    expect(saveFlow.loadsDone).toBe(1);
    s = debugApiM11.state() as LiveWithPersist;
    expect(s.player.health).toBe(100); // back to the captured world
    registerCaptureSink(null);
    attachPersistDebug(null);
    resetSaveLoad();
    debugSim.detach();
  });

  it('recordDemo/demoStatus ride pDemo; typeChars forwards through the mount', () => {
    resetDemo();
    attachPlain();
    const typed: string[] = [];
    noopPersistSource({ typeChars: (t) => typed.push(t) });
    expect(debugApiM11.recordDemo('seam')).toBe(true);
    expect(debugApiM11.demoStatus().recording).toBe(true);
    expect(debugApiM11.typeChars('idkfa')).toBe(true);
    expect(typed).toEqual(['idkfa']);
    resetDemo();
    expect(debugApiM11.demoStatus().recording).toBe(false);
    attachPersistDebug(null);
    debugSim.detach();
  });
});
