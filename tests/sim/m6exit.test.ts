/**
 * M6-13 — ROADMAP M6 exit verification (mechanical checklist, docs-free;
 * the tests/sim/exit.test.ts M5 idiom applied to the M6 exit lines of
 * docs/ROADMAP.md §M6 + docs/design/M6-plan.md §5).
 *
 * Every check is (a) an imported constant pinned to its exact value,
 * (b) an executable fact about THIS repo (a scripted run booted HERE,
 * goldens/suites participating in this very `vitest run`), or (c) a grep
 * of a committed test NAME (deleting the evidence trips the guard).
 *
 * M6 exit lines mapped:
 *  1. 35 Hz accumulator stepping intact (M5 carry-over)  → TICRATE pins +
 *     main.ts wiring grep + game.test.ts NAME.
 *  2. specials-registered 154 (+2 reasoned exemptions; the 4-exemption
 *     ledger incl. sector {6,15} is the FULL 1.10 census)  → registry
 *     manifest imports + corpus/table NAME guards.
 *  3. E1M1 no-crash scripted run w/ hom == 0              → THIS file
 *     boots E1M1 WITH the M6-13 live-sector render wiring, walks a
 *     scripted 300-tic run, renders, asserts every health counter 0.
 *  4. hash determinism double-run                        → THIS file
 *     replays the identical script and pins hashState equality.
 *  5. R05-tables-100% L2 corpus + L4/L5 evidence         → NAME guards
 *     (corpus suite, census proof, e2e route, mechanics strips).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT, TICRATE } from '../../src/core/constants';
import { gInitGame, gTicker, TICS_PER_SECOND } from '../../src/sim/game';
import { emptyInput } from '../../src/sim/ticcmd';
import { buildMapFromData } from '../../src/sim/map';
import { hashState } from '../../src/sim/state';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildRenderMapView } from '../../src/render/view';
import { decodeColormap } from '../../src/wad/palettes';
import { loadMap } from '../../src/wad/mapdata';
import { texturesFromWad } from '../../src/wad/texture';
import { WadFile } from '../../src/wad/wadfile';
import {
  LINE_SPECIALS_EXCLUDED, registryManifest, SECTOR_SPECIALS_EXCLUDED
} from '../../src/sim/specials-table';

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string): string => readFileSync(at(p), 'utf8');

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    at('../../wads/freedoom1.wad')
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}
const WAD_PATH = findWad();
const hasWad = WAD_PATH !== undefined;

/* ------------------------------------------------------------------ */
/* 1 — 35 Hz intact                                                    */
/* ------------------------------------------------------------------ */

describe('M6 exit 1 — 35 Hz accumulator stepping intact', () => {
  it('TICRATE/TICS_PER_SECOND are exactly 35', () => {
    expect(TICRATE).toBe(35);
    expect(TICS_PER_SECOND).toBe(TICRATE);
  });
  it('main.ts still steps the sim on the 1000/TICS_PER_SECOND accumulator', () => {
    expect(read('../../src/main.ts')).toMatch(
      /while \([^)]*accumulator >= TIC_MS[^)]*MAX_CATCHUP_TICS/
    );
  });
  it('the 35 Hz loop test name exists (green carried by this run)', () => {
    expect(read('../../src/sim/game.test.ts')).toContain("it('runs at 35 Hz");
  });
});

/* ------------------------------------------------------------------ */
/* 2 — specials registered: 154 live + reasoned exemptions             */
/* ------------------------------------------------------------------ */

describe('M6 exit 2 — specials-registered census', () => {
  const m = registryManifest();
  it('154 live specials registered (139 line + 15 sector)', () => {
    expect(m.lineRegistered).toBe(139);
    expect(m.sectorRegistered).toBe(15);
    expect(m.lineRegistered + m.sectorRegistered).toBe(154);
  });
  it('every exemption carries a reason (2 line {78,85} + 2 sector {6,15})', () => {
    const all = [...LINE_SPECIALS_EXCLUDED, ...SECTOR_SPECIALS_EXCLUDED];
    expect(all.map((e) => e.id).sort((a, b) => a - b)).toEqual([6, 15, 78, 85]);
    for (const e of all) expect(e.reason.length, `id ${e.id} reason`).toBeGreaterThan(20);
  });
  it('census + corpus evidence NAMEs exist (green carried by this run)', () => {
    // specials-table.test.ts proves the 139+15 census vs R05 §2/§3 verbatim
    expect(read('../../src/sim/specials-table.test.ts')).toContain('R05');
    // the per-special scenario corpus (M6-13 acceptance 1)
    expect(read('../../tests/headless/specials.test.ts')).toContain(
      'M6-13 line-special scenarios (manifest-driven)'
    );
    expect(read('../../tests/headless/specials.test.ts')).toContain(
      'M6-13 sector-special scenarios (manifest-driven)'
    );
  });
});

/* ------------------------------------------------------------------ */
/* 3+4 — E1M1 scripted run: no crash, hom==0, deterministic hash       */
/* ------------------------------------------------------------------ */

const RUN_TICS = 300;

function e1m1ScriptedRun(): { hash: number; hom: number; overflows: number[] } {
  if (WAD_PATH === undefined) throw new Error('no wad (skipIf guard failed)');
  const bytes = readFileSync(WAD_PATH);
  const wad = WadFile.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
  const md = loadMap(wad, 'E1M1');
  const map = buildMapFromData(md);
  const state = gInitGame(map);
  // M6-13 renderer live-sector wiring ACTIVE on the real map:
  const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad), state.sectors);
  const view = buildRenderMapView(md);
  const tables = initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!));
  const sprites = buildMapSprites({ md, map: view, wad });
  const fb = new Framebuffer();

  // scripted: walk east from spawn (the long open corridor, physics.spec
  // route), USE burst mid-run, glance north/south to sweep the BSP.
  const p = state.players[0]!;
  p.mo.x = -416 * FRACUNIT;
  p.mo.y = 256 * FRACUNIT;
  let hom = 0;
  const overflows: number[] = [];
  for (let t = 0; t < RUN_TICS; t++) {
    gTicker(state, {
      ...emptyInput(),
      forward: t < 220,
      turnRight: t >= 150 && t < 170,
      use: t >= 60 && t < 70
    });
    if (t % 20 === 0 || t === RUN_TICS - 1) {
      const c = renderFrame({
        fb, world, map: view, player: p, tables, sprites
      });
      hom += c.hom;
      overflows.push(
        c.visplaneOverflow, c.visspriteOverflow, c.openingOverflow, c.drawsegOverflow
      );
    }
  }
  return { hash: hashState(state), hom, overflows };
}

describe.skipIf(!hasWad)('M6 exit 3+4 — E1M1 scripted run (300 tics, live-sector render)', () => {
  const a = hasWad ? e1m1ScriptedRun() : null;
  const b = hasWad ? e1m1ScriptedRun() : null;

  it('no crash, hom == 0, every overflow counter 0 across the run', () => {
    expect(a!.hom).toBe(0);
    expect(new Set(a!.overflows)).toEqual(new Set([0]));
  });
  it('double-run hash determinism', () => {
    expect(a!.hash).toBe(b!.hash);
    expect(Number.isInteger(a!.hash)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5 — L4/L5 evidence NAME guards                                      */
/* ------------------------------------------------------------------ */

describe('M6 exit 5 — L4 route + L5 strips evidence', () => {
  it('e2e E1M1 key-route spec exists with the runtime-scan route', () => {
    expect(read('../../e2e/specials.spec.ts')).toContain('key route');
  });
  it('L5 mechanics strips exist (door-through evidence set)', () => {
    const meta = JSON.parse(read('../render/goldens/mechanics/meta.json')) as {
      set: string;
      scenes: Record<string, { reason: string }>;
    };
    expect(meta.set).toBe('mechanics');
    expect(Object.keys(meta.scenes).length).toBeGreaterThanOrEqual(2);
    for (const s of Object.values(meta.scenes)) expect(s.reason.length).toBeGreaterThan(3);
  });
});
