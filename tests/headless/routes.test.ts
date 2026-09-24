/**
 * M12-03 — L2 scripted reachable-exit ROUTES for all nine E1 maps
 * (docs/design/M12-plan.md §M12-03). Deterministic, seeded-input (fixed
 * PRNG boot via gInitGame + fully scripted GameInput), sim-clocked in bulk
 * (no rAF, no rendering): each route is a chain of trigger segments; the
 * runner warps the player to the FRONT-side stand point of each trigger line
 * (geometry-derived, m9-flow stage-6 convention), drives scripted USE /
 * WALK-FORWARD inputs, and maintains a SECTOR-MOVEMENT LEDGER: every tick of
 * every segment records which sectors deviated from their segment-start
 * heights, and every non-exit trigger MUST show movement in its expected
 * sector set (tagged sectors, or the door's own back sector). That ledger is
 * the anti-B-11 teeth — a trigger that "fires" but moves nothing is red.
 *
 * Terminal assertion per map: the route's own inputs latch exitRequest
 * (never a direct gExitLevel call), the wiring drain (consume → gExitLevel →
 * GA.completed → G_DoCompleted) puts the game into GS_INTERMISSION with the
 * WI tally in its StatCount state — and `unimplementedSpecial.count === 0`
 * for the WHOLE run. Determinism: each route runs twice in-process and must
 * exit on the same gametic with the same ledger.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData, sectorsWithTag, type RuntimeMap } from '../../src/sim/map';
import {
  gExitLevel,
  gFlowTic,
  gInitGame,
  gSecretExitLevel,
  gTicker,
  GS,
  registerGameFlowHooks
} from '../../src/sim/game';
import { pTeleportMove } from '../../src/sim/pmap';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { CF_GODMODE } from '../../src/sim/player';
import { resetHookSlots } from '../../src/sim/hooks';
import {
  resetUnimplementedSpecial,
  unimplementedSpecial
} from '../../src/sim/specials-table';
import { gDoCompleted, wiPeek, wiTicker } from '../../src/sim/wintermission';
import { fRegisterFlow, fSetWad } from '../../src/ui/finale';
import type { GameState } from '../../src/sim/state';
import { CARD_SLOT, E1_ROUTE_MAPS, frontStand, M12_ROUTES, type RouteTrigger } from '../fixtures/m12Routes';

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
].find((p): p is string => p !== undefined && existsSync(p));

let cachedWad: WadFile | undefined;
function wad(): WadFile {
  if (cachedWad === undefined) {
    const bytes = readFileSync(WAD_PATH!);
    cachedWad = WadFile.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  }
  return cachedWad;
}

const F = FRACUNIT;
/** degrees → BAM (floor on the 2^32 circle, debug.ts degToBam semantics). */
const degToBam = (deg: number): number => Math.floor((deg * 0x100000000) / 360) >>> 0;

/* ------------------------------------------------------------------ */
/* the route runner                                                    */
/* ------------------------------------------------------------------ */

interface SegmentResult {
  readonly line: number;
  readonly special: number;
  readonly kind: string;
  readonly fired: boolean;
  readonly moved: readonly number[]; // sectors that deviated during the segment
  readonly expected: readonly number[];
}

interface RouteResult {
  readonly exitTic: number;
  readonly segments: readonly SegmentResult[];
  readonly exitKind: string; // 'normal' | 'secret'
}

function warp(s: GameState, x: number, y: number, angleDeg: number): void {
  const mo = s.players[0]!.mo;
  mo.angle = degToBam(angleDeg);
  pTeleportMove(s.pmap, mo, Math.round(x * F), Math.round(y * F));
  mo.z = mo.floorz;
}

/** sectors a trigger is EXPECTED to move: tag set, else the door line's own
 * back sector (manual/locked door idiom), else the front sector. */
function expectedSectors(map: RuntimeMap, trig: RouteTrigger): number[] {
  if (trig.tag !== undefined) return [...sectorsWithTag(map, trig.tag)];
  if (trig.kind === 'use') {
    const back = map.lines.sectorBack[trig.line]!;
    return [back >= 0 ? back : map.lines.sectorFront[trig.line]!];
  }
  return [];
}

function heights(s: GameState): { floor: Int32Array; ceil: Int32Array } {
  return { floor: Int32Array.from(s.sectors.floorZ), ceil: Int32Array.from(s.sectors.ceilingZ) };
}

/** run tics until stop() or budget; return sectors deviating from `base` */
function runTics(
  s: GameState, tics: number, input: (tic: number) => GameInput,
  base: { floor: Int32Array; ceil: Int32Array }, moved: Set<number>,
  stop: () => boolean
): void {
  for (let t = 0; t < tics; t++) {
    gFlowTic(s);
    gTicker(s, input(t));
    for (let i = 0; i < s.sectors.floorZ.length; i++) {
      if (!moved.has(i) && (s.sectors.floorZ[i] !== base.floor[i] || s.sectors.ceilingZ[i] !== base.ceil[i])) {
        moved.add(i);
      }
    }
    if (stop()) return;
  }
}

const IN = { ...emptyInput() };
const USE = { ...emptyInput(), use: true };
const FWD = { ...emptyInput(), forward: true };

function execSegment(s: GameState, map: RuntimeMap, trig: RouteTrigger): SegmentResult {
  const expected = expectedSectors(map, trig);
  const isExit = trig.kind === 'exit-use' || trig.kind === 'exit-cross' || trig.kind === 'secret-use';
  const moved = new Set<number>();
  const base = heights(s);
  const offsets = trig.kind === 'cross' || trig.kind === 'exit-cross' ? [64, 96] : [48, 16];
  const lx1 = map.verticesX[map.lines.v1[trig.line]!]! / F;
  const ly1 = map.verticesY[map.lines.v1[trig.line]!]! / F;
  const lx2 = map.verticesX[map.lines.v2[trig.line]!]! / F;
  const ly2 = map.verticesY[map.lines.v2[trig.line]!]! / F;

  for (const off of offsets) {
    const stand = frontStand(lx1, ly1, lx2, ly2, off, trig.stand);
    warp(s, stand.x, stand.y, stand.angleDeg);
    if (trig.kind === 'use' || trig.kind === 'exit-use' || trig.kind === 'secret-use') {
      runTics(s, 2, () => IN, base, moved, () => false);
      // 16 USE press/release cycles (rising edges), early-out when fired
      for (let press = 0; press < 16; press++) {
        runTics(s, 1, () => USE, base, moved, () => false);
        runTics(s, 1, () => IN, base, moved, () =>
          isExit ? s.exitRequest !== 'none' : expected.length > 0 && expected.some((sec) => moved.has(sec))
        );
        if (isExit ? s.exitRequest !== 'none' : expected.length > 0 && expected.some((sec) => moved.has(sec))) break;
      }
    } else {
      runTics(s, 2, () => IN, base, moved, () => false);
      runTics(s, 100, () => FWD, base, moved, () =>
        isExit ? s.exitRequest !== 'none' : expected.length > 0 && expected.some((sec) => moved.has(sec))
      );
    }
    if (isExit ? s.exitRequest !== 'none' : expected.length === 0 || expected.some((sec) => moved.has(sec))) break;
  }
  const firedOk = isExit
    ? s.exitRequest !== 'none'
    : expected.length === 0
      ? moved.size > 0
      : expected.some((sec) => moved.has(sec));
  return {
    line: trig.line, special: map.lines.special[trig.line] ?? trig.special, kind: trig.kind,
    fired: firedOk, moved: [...moved].sort((a, b) => a - b), expected
  };
}

/** Run one map route end to end. `secret` replaces the terminal exit with
 * the bonus secret trigger (documented, E1M3 only). */
function runRoute(mapName: string, useSecret = false): RouteResult {
  const route = M12_ROUTES[mapName]!;
  const map = buildMapFromData(loadMap(wad(), mapName));
  registerGameFlowHooks({ wiTicker, doCompleted: gDoCompleted });
  fRegisterFlow(); // E1M8 clears to ga_victory (G_DoCompleted) — the finale route must exist
  fSetWad(wad());
  const s = gInitGame(map);
  resetHookSlots(s.hooks);
  resetUnimplementedSpecial();
  // Route-driving conveniences (documented, NOT gameplay): god mode so
  // monsters cannot end the run (suite convention, amon_bruiser et al.),
  // and the card inventory pre-granted for locked doors (the M6-11 giveCard
  // channel at sim level — door MOVEMENT is the assertion, key-grabbing is
  // not the subject of this suite).
  s.players[0]!.cheats |= CF_GODMODE;
  for (const trig of route.triggers) {
    if (trig.card !== undefined) s.players[0]!.cards[CARD_SLOT[trig.card]] = 1;
  }

  const segments: SegmentResult[] = [];
  const chain = [...route.triggers];
  if (useSecret) {
    chain.pop(); // drop the terminal exit; the secret trigger is the terminal
    chain.push(route.secret!);
  }
  for (const trig of chain) {
    segments.push(execSegment(s, map, trig));
  }
  if (!useSecret) expect(s.exitRequest, `${mapName}: route must latch a normal exit`).toBe('normal');
  const exitTic = s.gametic;
  const exitKind = s.exitRequest;

  // the wiring drain (main.ts stepTic parity): consume → G_*ExitLevel →
  // next tic's gameaction drain → G_DoCompleted → WI_Start
  s.exitRequest = 'none';
  if (exitKind === 'secret') gSecretExitLevel(s);
  else gExitLevel(s);
  for (let t = 0; t < 12 && s.gamestate === GS.LEVEL; t++) {
    gFlowTic(s);
    gTicker(s, IN);
  }
  if (mapName === 'E1M8') {
    // Doom-1 E1M8 clears STRAIGHT to the finale (ga_victory, g_game.c:1031)
    expect(s.gamestate, `${mapName}: finale entered`).toBe(GS.FINALE);
    expect(unimplementedSpecial.count, `${mapName}: zero unimplemented specials`).toBe(0);
    return { exitTic, segments, exitKind };
  }
  expect(s.gamestate, `${mapName}: intermission entered`).toBe(GS.INTERMISSION);
  expect(wiPeek().active, `${mapName}: WI active`).toBe(true);
  expect(wiPeek().phase, `${mapName}: tally is in StatCount`).toBe('StatCount');
  expect(unimplementedSpecial.count, `${mapName}: zero unimplemented specials`).toBe(0);

  return { exitTic, segments, exitKind };
}

/* ------------------------------------------------------------------ */
/* the suite                                                           */
/* ------------------------------------------------------------------ */

describe('M12-03 reachable-exit routes', () => {
  describe.skipIf(WAD_PATH === undefined)('live WAD', () => {
    for (const mapName of E1_ROUTE_MAPS) {
      it(`${mapName}: scripted route reaches the exit, ledger shows every touched trigger moving`, () => {
        const route = M12_ROUTES[mapName]!;
        // drift guards (m9-flow EXIT_ROUTE convention, whole-route)
        const map = buildMapFromData(loadMap(wad(), mapName));
        for (const trig of route.triggers) {
          expect(map.lines.special[trig.line], `${mapName} L${trig.line} special drift`).toBe(trig.special);
        }

        const r = runRoute(mapName);
        for (const seg of r.segments) {
          expect(seg.fired, `${mapName} L${seg.line} (${seg.kind}) must FIRE with visible sector movement (ledger: moved=[${seg.moved}] expected=[${seg.expected}])`).toBe(true);
        }
        console.log(`M12-03 ${mapName}: exit ${r.exitKind} @tic ${r.exitTic}, triggers fired ${r.segments.filter((x) => x.fired).length}/${r.segments.length}`);
      });

      it(`${mapName}: route is deterministic (double run, identical tic + ledger)`, () => {
        const a = runRoute(mapName);
        const b = runRoute(mapName);
        expect(b.exitTic).toBe(a.exitTic);
        expect(b.segments.map((x) => x.moved)).toEqual(a.segments.map((x) => x.moved));
      });
    }

    it('E1M3 secret-exit bonus: the scripted route can reach the S1 secret (documented, not gated by plan)', () => {
      const r = runRoute('E1M3', true);
      expect(r.exitKind).toBe('secret');
      const last = r.segments[r.segments.length - 1]!;
      expect(last.fired).toBe(true);
    });
  });
});
