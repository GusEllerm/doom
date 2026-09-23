/**
 * sim/hooks — M8-02 damage-bridge acceptance tests (M8-plan §M8-02 item 4):
 * the damageBridge slot SIGNATURE + registerDamageBridge + the
 * mobjFromSlot resolver live here; p_mobj.ts fills the resolver at runtime
 * create, M8-05 registers the P_DamageMobj BODY. hooks.ts itself imports
 * NOTHING (A-06) — the pure section drives it with fake refs; the
 * integration section boots a fixture and demands REAL Mobj identity.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MT } from '../wad/info/mobjinfo';

import { buildMapFromData } from './map';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame } from './game';
import type { GameState } from './state';
import {
  createHookSlots,
  damageSlot,
  mobjFromSlot,
  registerDamageBridge,
  resetHookSlots,
  type MobjRef,
} from './hooks';
/** Fake "mobjs" — hooks.ts must never care what a ref IS (A-06). */
const fake = (n: number): MobjRef => ({ isMobj: true, n } as unknown as MobjRef);

/* ------------------------------------------------------------------ */
/* Pure slot mechanics                                                  */
/* ------------------------------------------------------------------ */

describe('damageBridge slots (M8-02 acceptance 4, pure)', () => {
  it('no bridge registered: damageSlot is record-only, byte-identical to M6', () => {
    const h = createHookSlots();
    damageSlot(h, 7, 10, 3, 5);
    expect(h.damage.count).toBe(1);
    expect(h.damage.entries[0]).toEqual({ thing: 7, amount: 10, source: 3, tic: 5 });
    expect(h.bridge.damageBridge).toBeUndefined();
    expect(h.bridge.mobjFromSlot).toBeUndefined();
    expect(mobjFromSlot(h, 7)).toBeUndefined();
  });

  it('registered body receives RESOLVED refs (target + source), records stay first', () => {
    const h = createHookSlots();
    const refs = new Map<number, MobjRef>([
      [7, fake(7)],
      [3, fake(3)],
    ]);
    h.bridge.mobjFromSlot = (slot) => refs.get(slot);
    const seen: unknown[] = [];
    registerDamageBridge(h, (target, amount, source, tic) => {
      seen.push([target, amount, source, tic]);
    });
    damageSlot(h, 7, 10, 3, 5);
    expect(h.damage.count).toBe(1); // L2 event log untouched by the bridge
    expect(seen.length).toBe(1);
    const [target, amount, source, tic] = seen[0] as [MobjRef, number, MobjRef, number];
    expect(target).toBe(refs.get(7));
    expect(amount).toBe(10);
    expect(source).toBe(refs.get(3));
    expect(tic).toBe(5);
  });

  it('world damage (source null) resolves to undefined; unresolved TARGET skips the body', () => {
    const h = createHookSlots();
    h.bridge.mobjFromSlot = (slot) => (slot === 7 ? fake(7) : undefined);
    const seen: unknown[] = [];
    registerDamageBridge(h, (_t, _a, source) => seen.push(source));
    damageSlot(h, 7, 20, null, 9);
    expect(seen).toEqual([undefined]); // crusher/floor damage: source undefined
    seen.length = 0;
    damageSlot(h, 8, 20, null, 9); // unresolved slot ⇒ record-only
    expect(seen.length).toBe(0);
    expect(h.damage.count).toBe(2);
  });

  it('registerDamageBridge(h, null) un-registers; resetHookSlots keeps the wiring', () => {
    const h = createHookSlots();
    h.bridge.mobjFromSlot = (slot) => fake(slot);
    let calls = 0;
    registerDamageBridge(h, () => calls++);
    damageSlot(h, 1, 1, null, 0);
    expect(calls).toBe(1);
    registerDamageBridge(h, null);
    damageSlot(h, 1, 1, null, 0);
    expect(calls).toBe(1); // body gone — back to record-only
    expect(h.damage.count).toBe(2);
    // wiring survives an event-log reset (it is wiring, not events)
    registerDamageBridge(h, () => calls++);
    resetHookSlots(h);
    expect(h.damage.count).toBe(0);
    damageSlot(h, 1, 1, null, 0);
    expect(calls).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* Integration: the resolver p_mobj.createMobjRuntime registers         */
/* ------------------------------------------------------------------ */

function bootFixture(things: RectMapSpec['things']): GameState {
  const spec: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
    things: [{ x: 32, y: 32, angle: 0, type: 1 }, ...(things ?? [])],
  };
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 2);
}

describe('damageBridge resolver wiring (M8-02 acceptance 4, integration)', () => {
  it('bridge body gets the REAL Mobj objects the slots bind to (identity)', () => {
    const s = bootFixture([{ x: 200, y: 200, angle: 0, type: 2035 }]);
    const target = s.mobjs.mobjs.find((m) => m.type === MT.MT_BARREL)!;
    const source = s.mobjs.mobjs.find((m) => m.type === MT.MT_PLAYER)!;
    let got: { target: unknown; source: unknown; amount: number; tic: number } | undefined;
    registerDamageBridge(s.hooks, (t, amount, src, tic) => {
      got = { target: t, source: src, amount, tic };
    });
    damageSlot(s.hooks, target.linkSlot, 15, source.linkSlot, 42);
    expect(got).toBeDefined();
    expect(got!.target).toBe(target); // resolved Mobj, not a slot id
    expect(got!.source).toBe(source);
    expect(got!.amount).toBe(15);
    expect(got!.tic).toBe(42);
    expect(s.hooks.damage.count).toBe(1); // L2 log still written
  });
});

/* ================================================================== */
/* M10-04 — sfxSink/musicSlot seams, live listeners, site scan, and   */
/* the E1M1 scripted-combat EVENT-LEDGER determinism double-run.      */
/* ================================================================== */

import {
  musicLog,
  musicSlot,
  registerLiveMusic,
  registerLiveSfx,
  resetSfxStubLog,
  setSfxEventClock,
  sfxSink,
  sfxStubLog,
  SFX_UI_SITE_LEDGER,
  uiSfxLog,
} from './hooks';
import { installPsprSfxSlot, sStartSound, SFX_ID } from './psound_stub';
import { attachPsprFields, psprHooks, resetPsprHooks, AM_CLIP, WP_CHAINGUN } from './p_pspr';
import { createPlayer } from './player';
import { gTicker } from './game';
import { hashState } from './state';
import { asMobj, ONFLOORZ, pSpawnMobj, type Mobj } from './p_mobj';
import { emptyInput, type GameInput } from './ticcmd';
import { FRACUNIT } from '../core/constants';
import { registerEnemyHooks } from './p_enemy';
import { registerFamilyAActions } from './amon_poss';
import { registerFamilyCActions } from './amon_bruiser';
import { registerDeathActions } from './pdeath';

const fx = (n: number): number => (n * FRACUNIT) | 0;

/** djb2 over the JSON event list — the ledger hash under test. */
function hashJson(v: unknown): number {
  const s = JSON.stringify(v);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

describe('M10-04 sfxSink: counted counter + per-tic ledger + live listener', () => {
  it('keeps the legacy sfxStubLog counters EXACTLY (D-list swap, zero test churn)', () => {
    resetSfxStubLog();
    sfxSink('sfx_stnmov');
    sfxSink('sfx_stnmov');
    sfxSink('sfx_oof');
    expect(sfxStubLog.count).toBe(3);
    expect(sfxStubLog.byName.get('sfx_stnmov')).toBe(2);
    expect(sfxStubLog.byName.get('sfx_oof')).toBe(1);
    // same keys land in the new event ledger, in order, tic-stamped.
    expect(uiSfxLog.count).toBe(3);
    expect(uiSfxLog.entries.map((e) => e.sfx)).toEqual(['sfx_stnmov', 'sfx_stnmov', 'sfx_oof']);
    resetSfxStubLog();
    expect(sfxStubLog.count).toBe(0);
    expect(uiSfxLog.count).toBe(0);
  });

  it('NULL-origin rule + clock: coords 0/0/0, tic from the registered clock', () => {
    setSfxEventClock(() => 4211);
    sfxSink('sfx_pistol');
    expect(uiSfxLog.entries[0]).toEqual({ sfx: 'sfx_pistol', x: 0, y: 0, z: 0, tic: 4211 });
    // origin read-view form (menu has none today; the seam carries it).
    sfxSink('sfx_oof', { x: 64 * FRACUNIT, y: -128 * FRACUNIT, z: FRACUNIT, o: 9 });
    expect(uiSfxLog.entries[1]).toEqual({
      sfx: 'sfx_oof', x: 64 * FRACUNIT, y: -128 * FRACUNIT, z: FRACUNIT, tic: 4211,
    });
    setSfxEventClock(null);
    resetSfxStubLog();
  });

  it('live listener: install/replace/clear is idempotent and survives BOTH resets', () => {
    const got: Array<[unknown, unknown]> = [];
    const rec = (sfx: number | string, origin: unknown): void => { got.push([sfx, origin]); };
    registerLiveSfx(rec);
    registerLiveSfx(rec); // replace = idempotent (same fn ⇒ same effect)
    sfxSink('sfx_swtchn');
    expect(got.length).toBe(1);
    const h = createHookSlots();
    resetHookSlots(h);
    resetSfxStubLog();
    sfxSink('sfx_swtchx');
    expect(got.length, 'listener survives resetHookSlots + resetSfxStubLog').toBe(2);
    registerLiveSfx(null);
    sfxSink('sfx_noway');
    expect(got.length, 'null clears').toBe(2);
    resetSfxStubLog();
  });

  it('menu stnmov arrives by NAME with 0/0/0 coords; sim emits arrive by ID', () => {
    const seen: Array<{ sfx: unknown; x: number; tic: number; ref: unknown }> = [];
    registerLiveSfx((sfx, origin, x, _y, _z, tic) => { seen.push({ sfx, x, tic, ref: origin }); });
    sfxSink('sfx_stnmov');
    const h = createHookSlots();
    sStartSound(h, SFX_ID.sfx_doropn, { x: fx(128), y: fx(64), z: 0, o: 17 }, 33);
    registerLiveSfx(null);
    expect(seen[0]).toEqual({ sfx: 'sfx_stnmov', x: 0, tic: 0, ref: null });
    expect(seen[1]).toEqual({ sfx: 20, x: fx(128), tic: 33, ref: { x: fx(128), y: fx(64), z: 0, o: 17 } });
    // record FIRST in the sim slot: the h.sfx log is byte-shape-unchanged.
    expect(h.sfx.entries[0]).toEqual({ id: 20, x: fx(128), y: fx(64), z: 0, tic: 33 });
    resetSfxStubLog();
  });

  it('a scripted weapon-fire forwards the LIVE p.mo ref (same-origin identity)', () => {
    const h = createHookSlots();
    installPsprSfxSlot(h, () => 21);
    const p = attachPsprFields(createPlayer());
    p.mo.x = 64 * FRACUNIT;
    p.mo.y = 128 * FRACUNIT;
    p.mo.z = 0;
    let ev: [number, unknown, number, number, number, number] | null = null;
    registerLiveSfx((sfx, origin, x, y, z, tic) => { ev = [sfx as number, origin, x, y, z, tic]; });
    psprHooks.startSound(p, SFX_ID.sfx_pistol);
    registerLiveSfx(null);
    expect(ev).not.toBe(null);
    const [id, origin, x, y, z, tic] = ev as unknown as [number, Mobj, number, number, number, number];
    expect(id).toBe(1);
    expect(origin).toBe(p.mo); // THE live mobj, not a coordinate copy
    expect([x, y, z, tic]).toEqual([64 * FRACUNIT, 128 * FRACUNIT, 0, 21]);
    expect(h.sfx.entries[0]).toEqual({ id: 1, x: 64 * FRACUNIT, y: 128 * FRACUNIT, z: 0, tic: 21 });
    resetPsprHooks();
    resetSfxStubLog();
  });
});

describe('M10-04 musicSlot: music ledger + live listener (consumer M10-08)', () => {
  it('records kind/loop/tic, notifies once per call, resets with the sfx counters', () => {
    setSfxEventClock(() => 101);
    const got: unknown[] = [];
    registerLiveMusic((kind, loop, tic) => { got.push([kind, loop, tic]); });
    musicSlot('intermission', true);
    musicSlot('title', false); // §0.6: title music is ONE-SHOT
    musicSlot('finale', true);
    registerLiveMusic(null);
    expect(got).toEqual([['intermission', true, 101], ['title', false, 101], ['finale', true, 101]]);
    expect(musicLog.count).toBe(3);
    expect(musicLog.byId?.get('title')).toBe(1);
    expect(musicLog.entries[1]).toEqual({ kind: 'title', loop: false, tic: 101 });
    resetSfxStubLog();
    expect(musicLog.count).toBe(0);
    setSfxEventClock(null);
  });
});

describe('M10-04 UI site scan: SFX_UI_SITE_LEDGER is the auto-checked manifest', () => {
  const ROOT = fileURLToPath(new URL('.', import.meta.url));

  function scanDir(dir: string): Record<string, { sfx: number; music: number }> {
    const found: Record<string, { sfx: number; music: number }> = {};
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      if (name === 'hooks.ts') continue; // the seam definitions themselves
      const src = readFileSync(`${dir}/${name}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '') // comments are not call sites
        .replace(/\/\/.*$/gm, '');
      const sfx = (src.match(/(^|[^A-Za-z0-9_])sfxSink\(/g)?.length ?? 0);
      const music = (src.match(/(^|[^A-Za-z0-9_])musicSlot\(/g)?.length ?? 0);
      if (sfx || music) found[name] = { sfx, music };
    }
    return found;
  }

  it('both directions: every emitter is listed, no stale entry survives', () => {
    const found = { ...scanDir(ROOT), ...scanDir(fileURLToPath(new URL('../ui/', import.meta.url))) };
    expect(found).toEqual({ ...SFX_UI_SITE_LEDGER });
    // D-list closure: zero sfxStub( call sites anywhere outside hooks.ts.
    const offenders: string[] = [];
    for (const dir of [ROOT, fileURLToPath(new URL('../ui/', import.meta.url)),
                       fileURLToPath(new URL('../render/', import.meta.url))]) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'hooks.ts') continue;
        const src = readFileSync(`${dir}/${name}`, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        if (/(^|[^A-Za-z0-9_])sfxStub\(/.test(src)) offenders.push(`${dir}/${name}`);
      }
    }
    expect(offenders, 'sfxStub( must live ONLY in hooks.ts (sfxSink counts it)').toEqual([]);
  });
});

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('M10-04 E1M1 scripted combat: event-ledger determinism double-run', () => {
  /** Same staging as the M8-11 marathon (chaingun given, 5 reinforcements,
   * 400-HP tank) WITHOUT the damage bridge (we certify the LEDGER, not the
   * retaliation stats): 300 tics of fire must not touch the sim stream. */
  function combatState(): GameState {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    registerEnemyHooks();
    registerFamilyAActions();
    registerFamilyCActions();
    registerDeathActions();
    const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
    installPsprSfxSlot(s.hooks, () => s.leveltime);
    setSfxEventClock(() => s.gametic);
    const p = attachPsprFields(s.players[0]!);
    p.weaponowned[WP_CHAINGUN] = 1;
    p.ammo[AM_CLIP] = 20;
    const mo = asMobj(s.players[0]!.mo as never)!;
    mo.health = s.players[0]!.health = 400;
    pSpawnMobj(s.mobjs, fx(-256), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(-256), fx(352), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(-160), fx(192), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(64), fx(256), ONFLOORZ, MT.MT_TROOP);
    pSpawnMobj(s.mobjs, fx(64), fx(352), ONFLOORZ, MT.MT_TROOP);
    return s;
  }

  function ledgerSignature(s: GameState): string {
    return `${hashJson(s.hooks.sfx.entries)}:${s.hooks.sfx.count}:${hashJson(s.hooks.sfx.byId?.size)}:${hashState(s)}`;
  }

  function combatRun(s: GameState): void {
    for (let t = 0; t < 300; t++) {
      const inp: GameInput = {
        ...emptyInput(),
        weaponKey: t === 5 ? 3 : undefined,
        attack: t >= 20,
      };
      gTicker(s, inp);
    }
  }

  it('double run: exact event-list hash, sim hash UNMOVED (zero-PRNG proof)', () => {
    // build→run INTERLEAVED (the p_shoot/pmap bound-singleton rule).
    const a = combatState();
    combatRun(a);
    const sigA = ledgerSignature(a);
    expect(a.hooks.sfx.count).toBeGreaterThan(50); // real combat sounds fired

    const b = combatState();
    combatRun(b);
    expect(ledgerSignature(b)).toBe(sigA);
    // UNMOVED STREAM: run b's state hash equals run a's (identical
    // worlds) and the rng indices match — the emission path draws ZERO
    // randoms (direct proof below).
    expect(hashState(b)).toBe(hashState(a));
    expect(b.rng.prndindex).toBe(a.rng.prndindex);

    // silent-mode equality: hammering the seams on a LIVE state cannot
    // perturb the sim — its hash stays the untouched twin's hash exactly.
    const c = combatState();
    const d = combatState();
    for (let i = 0; i < 500; i++) {
      sfxSink('sfx_swtchn');
      sfxSink(SFX_ID.sfx_pistol, { x: fx(1), y: fx(2), z: 0, o: i });
      musicSlot('title', false);
      sStartSound(c.hooks, SFX_ID.sfx_dshtgn, { x: fx(8), y: fx(4), z: 0, o: 3 }, c.leveltime);
    }
    expect(hashState(c)).toBe(hashState(d));
    expect(c.rng.prndindex).toBe(d.rng.prndindex);
    resetSfxStubLog();
    setSfxEventClock(null);
  });
});
