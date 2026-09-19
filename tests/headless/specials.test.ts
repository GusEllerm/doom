/**
 * M6-13 — L2 PER-SPECIAL SCENARIO CORPUS (M6-plan §M6-13 acceptance 1/2).
 *
 * MACHINE-GENERATED COVERAGE: every id in `registryManifest()` (139 line +
 * 15 sector specials) gets ≥1 scripted scenario asserting its DISPATCH
 * ROUTE produces its LIVE EFFECT CLASS. Nothing here lists ids by hand —
 * the suites iterate the manifest and the fixtures/specialfix.ts
 * registry→geometry translation; adding an id to the registry
 * automatically adds its scenario (a missing scenario fails the census).
 *
 * Effect classes asserted (task §M6-13-1): thinker spawned (arena Δ) /
 * mover REMOVED (crushStop, stopPlat — pre-armed first) / live sector
 * light SoA change (lightOn/lightsOff) / mover MOVED (teleport) /
 * exitRequest + exit-slot (exit) / locked REFUSAL (message+sfx, special
 * stays armed) / scroll PAN (special 48 side offset per tic) / switch
 * TEXTURE + DISARM semantics straight off the registry's
 * gateSwitch/thenSwitch/switchBefore/clear bits.
 *
 * FINDING (M6-13 ledger): the M6-05 door BODY never landed on main —
 * pdoors.ts still carries the stub recorder ("tracked as an M6-13
 * follow-up", pdoors.ts header; TASKS.md says merged but git has no M6-05
 * commit touching pdoors.ts). Door-family ids therefore assert
 * `thinker-spawned XOR stub-recorded`; the locked-id REFUSAL half is live
 * (M6-11) and asserted strictly. When the body re-lands the SAME table
 * passes with zero edits, and the stub-ledger test's family set shrinks
 * to empty.
 *
 * Acceptance 2: EVERY scenario is double-run hash-equal (hashState over
 * the full M6 serialization).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { buildFixtureMapWad, mapSelfCheck } from '../fixtures/mapBuilder';
import { TEX_SWITCH_OFF, TEX_SWITCH_ON } from '../fixtures/m6Fixtures';
import {
  corpusCensus, lineKinds, lineRoute, lineScenarioSpec, lockedCardsFor,
  PRE_ARM_CROSS, sectorScenarioSpec
} from '../fixtures/specialfix';
import { buildMapFromData } from '../../src/sim/map';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { gInitGame, gTicker } from '../../src/sim/game';
import { hashState, type GameState } from '../../src/sim/state';
import { resetHookSlots } from '../../src/sim/hooks';
import {
  lineSpecialList, pCrossSpecialLine, pShootSpecialLine, pUseSpecialLine,
  resetFeetCounts, resetPspecCounts
} from '../../src/sim/pspec';
import { pInitSwitchList, resetPswitchCounts, resetSwitchList } from '../../src/sim/pswitch';
import { thinkerCount } from '../../src/sim/ptick';
import { resetTeleportCounts } from '../../src/sim/ptelept';
import {
  LINE_SPECIALS, registryManifest, resetUnimplementedSpecial,
  SECTOR_SPECIALS, unimplementedSpecial
} from '../../src/sim/specials-table';
import { CF_GODMODE } from '../../src/sim/player';
import { emptyInput } from '../../src/sim/ticcmd';

/* ------------------------------------------------------------------ */
/* harness                                                             */
/* ------------------------------------------------------------------ */

function attach(spec: Parameters<typeof buildFixtureMapWad>[0], name = 'SPECX'): GameState {
  const bytes = buildFixtureMapWad(spec, name);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), name)));
  // fresh-module-state idiom (switches.test.ts precedent); gInitGame →
  // P_SpawnSpecials already re-inited buttonlist/activeplats/activeceilings.
  resetSwitchList();
  pInitSwitchList([TEX_SWITCH_OFF, TEX_SWITCH_ON]);
  resetHookSlots(s.hooks);
  resetUnimplementedSpecial();
  resetPspecCounts();
  resetPswitchCounts();
  resetFeetCounts();
  resetTeleportCounts();
  return s;
}

function findLine(s: GameState, special: number): number {
  const lines = s.map.lines.special;
  for (let i = 0; i < lines.length; i++) if (lines[i] === special) return i;
  return -1;
}

interface Effect {
  thinkerDelta: number;
  /** Δ across the DISPATCH relative to post-pre-arm (stop families). */
  removalDelta?: number;
  /** tagged-sector mover thinker ticking (1) at pre-arm / dispatch. */
  stasisBefore?: number;
  stasisAfter?: number;
  lightChanged: boolean;
  floorChanged: boolean;
  ceilChanged: boolean;
  moverMoved: number;
  exitRequest: string;
  specialexit: boolean;
  messageCount: number;
  sfxCount: number;
  damageCount: number;
  spawnStubHits?: number;
  spawnStubSector?: number;
  lineSpecialAfter: number;
  midTexAfter: string;
  offsetAfter: number;
  stubLineHits: number;
  stubSectorHits: number;
  /** total unimplementedSpecial hits THIS scenario (per-run ledger). */
  hitsTotal: number;
  hash: number;
  s: GameState;
}

function runLine(special: number, giveCards: readonly number[] = []): Effect {
  const { spec } = lineScenarioSpec(special);
  const s = attach(spec);
  const route = lineRoute(special);
  const mo = s.players[0]!.mo;
  for (const c of giveCards) s.players[0]!.cards[c] = 1;

  const preIdx = PRE_ARM_CROSS[special] !== undefined ? findLine(s, PRE_ARM_CROSS[special]!) : -1;
  const trigIdx = findLine(s, special);
  expect(trigIdx, `scenario trigger line for special ${special} exists`).toBeGreaterThanOrEqual(0);

  const thinker0 = thinkerCount(s.thinkers);
  const floor0 = Int32Array.from(s.sectors.floorZ);
  const ceil0 = Int32Array.from(s.sectors.ceilingZ);
  const light0 = Int32Array.from(s.sectors.light);
  const x0 = mo.x, y0 = mo.y;
  const side0 = s.map.lines.sideFront[trigIdx]!;
  const off0 = s.map.sides.offsetX[side0]!;
  void off0;

  if (preIdx >= 0) pCrossSpecialLine(s.pmap, preIdx, 0, mo);
  const thinkerAfterPre = thinkerCount(s.thinkers);
  // stop families: the mover enters STASIS (fn=null, stays linked) —
  // capture the tagged sector's mover thinker before/after dispatch.
  const taggedSec = (() => {
    for (let i = 0; i < s.map.sectors.count; i++) if (s.map.sectors.tag[i] === 7) return i;
    return -1;
  })();
  const stasisBefore = taggedSec >= 0 && s.sectors.specialData[taggedSec] !== null
    ? ((s.sectors.specialData[taggedSec] as { fn: unknown }).fn !== null ? 1 : 0)
    : 0;

  if (route === 'use') pUseSpecialLine(s, mo, trigIdx, 0);
  else if (route === 'cross') pCrossSpecialLine(s.pmap, trigIdx, 0, mo);
  else if (route === 'shoot') pShootSpecialLine(s, mo, trigIdx);
  else if (route === 'scroll') {
    // special 48 has NO dispatcher route: P_SpawnSpecials collects the
    // line, P_UpdateSpecials pans side 0 every tic.
    expect(
      Array.from(lineSpecialList.lines).slice(0, lineSpecialList.count),
      'special 48 collected by P_SpawnSpecials'
    ).toContain(trigIdx);
  }
  // Snapshot the thinker arena RIGHT AT DISPATCH: movers that start and
  // finish inside the following 20 tics still COUNT as spawned (fast
  // floors finish in 16), and stop-family removals are visible here.
  const thinkerAtDispatch = thinkerCount(s.thinkers);
  const stasisAfter = taggedSec >= 0 && s.sectors.specialData[taggedSec] !== null
    ? ((s.sectors.specialData[taggedSec] as { fn: unknown }).fn !== null ? 1 : 0)
    : 0;
  for (let i = 0; i < 20; i++) gTicker(s, emptyInput());

  let lightChanged = false;
  let floorChanged = false;
  let ceilChanged = false;
  for (let i = 0; i < s.sectors.count; i++) {
    if (s.sectors.light[i] !== light0[i] && s.map.sectors.tag[i] === 7) lightChanged = true;
    if (s.sectors.floorZ[i] !== floor0[i]) floorChanged = true;
    if (s.sectors.ceilingZ[i] !== ceil0[i]) ceilChanged = true;
  }
  return {
    thinkerDelta: thinkerAtDispatch - thinker0,
    removalDelta: thinkerAtDispatch - thinkerAfterPre,
    stasisBefore, stasisAfter,
    lightChanged, floorChanged, ceilChanged,
    moverMoved: Math.abs(mo.x - x0) + Math.abs(mo.y - y0),
    exitRequest: s.exitRequest,
    specialexit: s.specialexit,
    messageCount: s.hooks.message.count,
    sfxCount: s.hooks.sfx.count,
    damageCount: s.hooks.damage.count,
    lineSpecialAfter: s.map.lines.special[trigIdx]!,
    midTexAfter: s.map.sides.midTexture[side0]!,
    offsetAfter: s.map.sides.offsetX[side0]!,
    stubLineHits: unimplementedSpecial.byLine[special] ?? 0,
    stubSectorHits: 0,
    hitsTotal: unimplementedSpecial.count,
    hash: hashState(s),
    s
  };
}

function runSector(special: number): Effect {
  const { spec } = sectorScenarioSpec(special);
  // gInitGame RUNS P_SpawnSpecials — the spawn-phase records (door-family
  // stubs) and spawn thinkers must be captured BEFORE the module resets.
  const bytes = buildFixtureMapWad(spec, 'SPECX');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'SPECX')));
  const spawnStubHits = unimplementedSpecial.count;
  const spawnStubSector = unimplementedSpecial.bySector[special] ?? 0;
  const spawnThinkers = thinkerCount(s.thinkers);
  resetSwitchList();
  pInitSwitchList([TEX_SWITCH_OFF, TEX_SWITCH_ON]);
  resetHookSlots(s.hooks);
  resetUnimplementedSpecial();
  resetPspecCounts();
  resetPswitchCounts();
  resetFeetCounts();
  resetTeleportCounts();
  const entry = SECTOR_SPECIALS[special]!;
  const secIdx = 1; // sector 0 = VOID; the special room is rooms[0] → sector 1

  if (entry.feet?.finale) {
    // hp-clamp fixture (M6-12 idiom): the damage SLOT never moves hp
    // pre-M7, so the finale's `health <= 10` gate is driven directly.
    s.players[0]!.health = 10;
    s.players[0]!.cheats |= CF_GODMODE;
  }
  const tics = entry.feet ? 128 : 20;
  for (let i = 0; i < tics; i++) gTicker(s, emptyInput());

  return {
    thinkerDelta: spawnThinkers, // fresh arena pre-spawn ⇒ count == delta
    spawnStubHits,
    spawnStubSector,
    lightChanged: false, floorChanged: false, ceilChanged: false, moverMoved: 0,
    exitRequest: s.exitRequest,
    specialexit: s.specialexit,
    messageCount: s.hooks.message.count,
    sfxCount: s.hooks.sfx.count,
    damageCount: s.hooks.damage.count,
    lineSpecialAfter: s.sectors.special[secIdx]!,
    midTexAfter: '',
    offsetAfter: 0,
    stubLineHits: 0,
    stubSectorHits: spawnStubSector,
    hitsTotal: spawnStubHits,
    hash: hashState(s),
    s
  };
}

/* ------------------------------------------------------------------ */
/* census + exhaustiveness                                             */
/* ------------------------------------------------------------------ */

const census = corpusCensus();
const manifest = registryManifest();

describe('M6-13 corpus census (registry iteration — no manual list)', () => {
  it('manifest: 154 live + 4 reasoned exemptions (2 line-class ids {78,85}, 2 sector ids {6,15})', () => {
    expect(manifest.lineRegistered + manifest.sectorRegistered).toBe(154);
    expect(manifest.lineIds.length).toBe(139);
    expect(manifest.sectorIds.length).toBe(15);
  });

  it('every manifest id has a compilable scenario spec (exhaustiveness)', () => {
    expect(census.lineSpecials.length).toBe(manifest.lineIds.length);
    for (const id of census.lineSpecials) lineScenarioSpec(id); // throws on bad geometry
    for (const id of census.sectorSpecials) sectorScenarioSpec(id);
  });

  it('sampled scenario specs pass the map structural self-check', () => {
    for (const id of census.lineSpecials.slice(0, 6)) {
      mapSelfCheck(buildFixtureMapWad(lineScenarioSpec(id).spec, 'SPECX'), 'SPECX'); // throws on violation
    }
    for (const id of census.sectorSpecials.slice(0, 4)) {
      mapSelfCheck(buildFixtureMapWad(sectorScenarioSpec(id).spec, 'SPECX'), 'SPECX'); // throws on violation
    }
  });
});

/* ------------------------------------------------------------------ */
/* LINE specials — scenario per id, class from the registry DATA       */
/* ------------------------------------------------------------------ */

const lineResults = new Map<number, Effect>();
const lineResults2 = new Map<number, Effect>(); // second run (determinism)

function getLine(special: number): Effect {
  let e = lineResults.get(special);
  if (e === undefined) {
    e = runLine(special);
    lineResults.set(special, e);
    lineResults2.set(special, runLine(special));
  }
  return e;
}

function lineClassTest(special: number): void {
  const kinds = lineKinds(special);
  const kind = kinds[0]?.action ?? 'scroll';
  const route = lineRoute(special);
  const entry = LINE_SPECIALS[special]!;
  const t = entry.use ?? entry.cross ?? entry.shoot;
  const locked = lockedCardsFor(special);
  const doorFamily = census.doorFamilyLineIds.includes(special);

  describe(`L${special} (${route ?? 'spawn'} · ${kind})`, () => {
    if (locked !== null && (kind === 'lockedDoor' || kind === 'verticalDoor')) {
      // Locked ids: TWO runs — refusal WITHOUT the card, effect WITH it.
      it('refusal without the card (message+sfx, special stays armed)', () => {
        const ref = runLine(special);
        expect(ref.messageCount).toBeGreaterThanOrEqual(1);
        expect(ref.sfxCount, 'sfx_oof').toBeGreaterThanOrEqual(1);
        expect(ref.thinkerDelta).toBe(0);
        expect(ref.stubLineHits, 'refusal never reaches the action body').toBe(0);
        expect(ref.lineSpecialAfter).toBe(special);
      });
      it('success with the card', () => {
        const ok = runLine(special, locked);
        expect(ok.messageCount, 'no refusal with the card').toBe(0);
        expect(ok.thinkerDelta + ok.stubLineHits, 'mover spawned OR door-stub hit')
          .toBeGreaterThanOrEqual(1);
        // disarm iff the ACTION returned true (gateSwitch=0 S1) — with the
        // M6-05 body pending the door action still returns false, so the
        // switch faithfully stays armed (pswitch.test's failed-action pin).
        expect(ok.lineSpecialAfter, 'disarm iff gateSwitch=0 AND action fired')
          .toBe(entry.use?.gateSwitch === 0 && ok.thinkerDelta > 0 ? 0 : special);
      });
      it('double-run hash-equal', () => {
        expect(runLine(special, locked).hash).toBe(runLine(special, locked).hash);
      });
      return;
    }

    it(`dispatch produces the ${kind} effect class`, () => {
      const e = getLine(special);
      switch (kind) {
        case 'stairs': case 'floor': case 'plat': case 'ceiling': case 'strobe':
        case 'donut':
          expect(e.thinkerDelta, 'thinker spawned').toBeGreaterThanOrEqual(1);
          break;
        case 'lightOn': case 'lightsOff':
          expect(e.lightChanged, 'live sector light changed').toBe(true);
          break;
        case 'teleport':
          if (t?.monsterOnly) {
            expect(e.moverMoved, 'monster-only teleport: player no-op').toBe(0);
            expect(e.lineSpecialAfter, 'player crossing keeps it armed').toBe(special);
          } else {
            expect(e.moverMoved, 'mover teleported').toBeGreaterThan(0);
          }
          break;
        case 'exit':
          expect(e.exitRequest, 'exitRequest set').not.toBe('none');
          expect(e.specialexit).toBe(kinds[0]!.arg === 1);
          break;
        case 'crushStop': case 'stopPlat': {
          // p_plats/p_ceilings stop semantics: the mover is NOT unlinked
          // — it goes to STASIS (fn=null; pceiling direction 0 / plat
          // plat_stasis). Removal (or continued ticking) is the tick's job.
          expect(e.stasisBefore, 'pre-armed mover ticks before the stop').toBe(1);
          expect(e.stasisAfter, 'stop dispatch puts the mover in stasis').toBe(0);
          break;
        }
        case 'scroll':
          expect(e.offsetAfter, 'side 0 pans per tic').not.toBe(0);
          break;
        case 'door': case 'verticalDoor': case 'lockedDoor':
          expect(
            e.thinkerDelta + e.stubLineHits,
            doorFamily
              ? 'door family: mover OR M6-05 stub (body pending — FINDING)'
              : 'door action dispatched'
          ).toBeGreaterThanOrEqual(1);
          break;
        default:
          expect.fail(`unclassified kind ${kind}`);
      }
    });

    it('line-special lifecycle (clear / switch-disarm) matches the registry bits', () => {
      const e = getLine(special);
      // "fired" = the action returned TRUE (a real mover). Door-family
      // stubs record but return false — the faithful failed-action flow
      // leaves switches armed (pswitch.test pin).
      const fired = e.thinkerDelta > 0;
      let want: number;
      if (route === 'cross') {
        // W1 clear — 125/126 monsterOnly: the clear lives INSIDE the
        // !player branch (125) or not at all (126), never for a player.
        want = t?.clear === true && !t?.monsterOnly ? 0 : special;
      } else if (route === 'shoot') want = entry.shoot?.thenSwitch === 0 ? 0 : special;
      else if (route === 'use') {
        if (entry.use?.switchBefore !== undefined) want = 0; // 11/51: disarm BEFORE the call
        else if (entry.use?.gateSwitch === 0) want = fired ? 0 : special; // S1 iff action true
        else want = special; // SR / manuals / 138-139 (useAgain=1)
      } else want = special;
      expect(e.lineSpecialAfter, 'post-dispatch line special').toBe(want);

      const unconditionalSwap =
        (route === 'use' && entry.use?.thenSwitch !== undefined) ||
        route === 'shoot' || // all three shoot ids carry thenSwitch
        (route === 'use' && entry.use?.switchBefore !== undefined);
      const gatedSwap = route === 'use' && entry.use?.gateSwitch !== undefined &&
        entry.use?.thenSwitch === undefined && entry.use?.switchBefore === undefined;
      if (unconditionalSwap && entry.shoot?.thenSwitch === undefined &&
          entry.use?.thenSwitch === undefined && entry.use?.switchBefore === undefined) {
        expect.fail('shoot route without thenSwitch');
      } else if (unconditionalSwap) {
        expect(e.midTexAfter, 'P_ChangeSwitchTexture swapped unconditionally').toBe(TEX_SWITCH_ON);
      } else if (gatedSwap) {
        expect(e.midTexAfter, 'gated swap iff action fired')
          .toBe(fired ? TEX_SWITCH_ON : TEX_SWITCH_OFF);
      }
    });

    it('double-run hash-equal', () => {
      getLine(special);
      expect(lineResults.get(special)!.hash).toBe(lineResults2.get(special)!.hash);
    });
  });
}

describe('M6-13 line-special scenarios (manifest-driven)', () => {
  for (const id of census.lineSpecials) lineClassTest(id);
});

/* ------------------------------------------------------------------ */
/* SECTOR specials                                                     */
/* ------------------------------------------------------------------ */

describe('M6-13 sector-special scenarios (manifest-driven)', () => {
  for (const id of census.sectorSpecials) {
    const entry = SECTOR_SPECIALS[id]!;
    describe(`S${id} (${entry.name})`, () => {
      it('spawn/feet class', () => {
        const e = runSector(id);
        if (entry.spawn && entry.spawn.action !== 'secretCount') {
          if (census.doorFamilySectorIds.includes(id)) {
            expect(e.thinkerDelta + e.stubSectorHits, 'spawn: thinker OR door-stub (M6-05 pending)')
              .toBeGreaterThanOrEqual(1);
          } else {
            expect(e.thinkerDelta, 'spawn thinker').toBeGreaterThanOrEqual(1);
          }
        }
        if (entry.spawn?.action === 'secretCount') {
          expect(e.s.totalsecret, 'totalsecret++ at load').toBe(1);
          expect(e.spawnStubHits, 'secretCount is not a stub').toBe(0);
        }
        expect(
          e.lineSpecialAfter,
          `sector special → ${entry.feet?.secret ? 0 : (entry.clearTo ?? id)}`
        ).toBe(entry.feet?.secret ? 0 : (entry.clearTo ?? id));

        const feet = entry.feet;
        if (feet?.damage !== undefined) {
          // No ironfeet ⇒ the `!ironfeet ||` half makes the cadence
          // DETERMINISTIC for every damage id (p_spec.c short-circuit —
          // the P_Random draw only matters WITH ironfeet active).
          expect(e.damageCount, '32-tic cadence over 128 tics').toBe(4);
          for (const d of e.s.hooks.damage.entries) {
            expect(d.amount).toBe(feet.damage);
            expect(d.tic % 32).toBe(0);
          }
        }
        if (feet?.secret) {
          expect(e.s.secretcount).toBe(1);
          expect(e.lineSpecialAfter, 'secret special → 0 on find').toBe(0);
        }
        if (feet?.finale) {
          expect(e.exitRequest, 'finale exits at hp<=10').toBe('normal');
          expect((e.s.players[0]!.cheats & CF_GODMODE) === 0, 'godmode cleared').toBe(true);
          expect(e.s.players[0]!.health).toBeLessThanOrEqual(10);
        }
      });
      it('double-run hash-equal', () => {
        expect(runSector(id).hash).toBe(runSector(id).hash);
      });
    });
  }
});

/* ------------------------------------------------------------------ */
/* stub-hit ledger (the M6-05 FINDING pin — zero hits OUTSIDE doors)   */
/* ------------------------------------------------------------------ */

describe('M6-13 stub ledger', () => {
  it('zero unimplementedSpecial hits outside the door family (per-run)', () => {
    for (const id of census.lineSpecials) {
      const e = getLine(id);
      if (!census.doorFamilyLineIds.includes(id)) {
        expect(e.hitsTotal, `L${id} stub hits`).toBe(0);
      }
    }
    for (const id of census.sectorSpecials) {
      const e = runSector(id);
      if (!census.doorFamilySectorIds.includes(id)) {
        expect(e.hitsTotal, `S${id} stub hits`).toBe(0);
      }
    }
  });
});
