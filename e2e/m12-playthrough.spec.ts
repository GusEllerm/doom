/**
 * e2e M12-03 — L4 scripted playthroughs (docs/design/M12-plan.md §M12-03).
 *
 * Three maps, each on a FRESH page, each route SIM-CLOCKED IN BULK (no rAF):
 * the live stepper is paused and every route tic is __doom.sim.runTics (the
 * m9-flow stage-6 convention), with the SAME trigger chains + the SAME
 * front-side geometry the L2 suite asserts (tests/fixtures/m12Routes.ts is
 * the single source of truth — this spec passes its tables into ONE
 * page.evaluate per map and re-derives the movement ledger in-page).
 *
 *  - E1M1 — full playthrough → exit switch → LIVE intermission (WI stats).
 *  - E1M2 — the B-11 map (its blazing plat, tag 14, is an explicit ledger
 *    step: the run is only green if that sector visibly moves).
 *  - E1M8 — the boss map. MAP-DATA FINDING (documented in the route table):
 *    the pinned Freedoom E1M8 carries ZERO barons and ZERO sector-special-11
 *    sectors — the vanilla "sector-11 finale math" does not apply to this
 *    WAD; the finale trigger is the W1-exit ring around the central chamber,
 *    and (faithful Doom-1 G_DoCompleted) clearing E1M8 goes STRAIGHT to the
 *    finale (ga_victory), not the tally.
 *
 * Endings: E1M1/E1M2 in the WI StatCount page, E1M8 in GS_FINALE — each with
 * ZERO console errors (pageerror + console.error both watched from goto on).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

import { CARD_SLOT, M12_ROUTES, type RouteTrigger } from '../tests/fixtures/m12Routes';
import { enterPlay } from './playstart';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

/** Bulk-route one map IN-PAGE: pause, god, cards, per-trigger warp + scripted
 * USE/WALK segments with the per-tic movement ledger, then hand the loop back
 * so the wiring drains exitRequest (main.ts stepTic parity). */
async function runRouteInPage(page: Page, mapName: string): Promise<{
  exit: string;
  segs: { line: number; fired: boolean; moved: number[] }[];
}> {
  const triggers = M12_ROUTES[mapName]!.triggers;
  const cards = triggers.flatMap((t) => (t.card ? [CARD_SLOT[t.card]] : []));
  const plain = triggers.map((t) => ({ line: t.line, special: t.special, kind: t.kind, tag: t.tag, stand: t.stand }));
  const out = await page.evaluate(
    ([trigs, cardSlots]) => {
      const api = window.__doom!;
      const FL = 65536;
      api.pause(true);
      api.popInput();
      api.god(true);
      const s = api.sim.getState()!;
      for (const slot of cardSlots as number[]) s.players[0]!.cards[slot] = 1;
      // drift guards (the L2 suite pins the same table)
      for (const t of trigs) {
        if (s.map.lines.special[t.line] !== t.special) {
          throw new Error(`route drift: ${s.map.name} L${t.line} special=${s.map.lines.special[t.line]} want=${t.special}`);
        }
      }
      const tagSecs = (tag: number): number[] => {
        const r: number[] = [];
        for (let i = 0; i < s.map.sectors.tag.length; i++) if (s.map.sectors.tag[i] === tag) r.push(i);
        return r;
      };
      const segs: { line: number; fired: boolean; moved: number[] }[] = [];
      const numSectors = s.sectors.floorZ.length;
      for (const t of trigs) {
        const isExit = t.kind === 'exit-use' || t.kind === 'exit-cross';
        const expected =
          t.tag !== undefined
            ? tagSecs(t.tag)
            : isExit
              ? []
              : [s.map.lines.sectorBack[t.line]! >= 0 ? s.map.lines.sectorBack[t.line]! : s.map.lines.sectorFront[t.line]!];
        const f0 = Int32Array.from(s.sectors.floorZ);
        const c0 = Int32Array.from(s.sectors.ceilingZ);
        const moved = new Set<number>();
        const scan = (): void => {
          for (let i = 0; i < numSectors; i++) {
            if (!moved.has(i) && (s.sectors.floorZ[i]! !== f0[i]! || s.sectors.ceilingZ[i]! !== c0[i]!)) moved.add(i);
          }
        };
        const goal = (): boolean =>
          isExit ? s.exitRequest !== 'none' : expected.some((sec) => moved.has(sec));
        scan();
        const v1x = s.map.verticesX[s.map.lines.v1[t.line]!]! / FL;
        const v1y = s.map.verticesY[s.map.lines.v1[t.line]!]! / FL;
        const v2x = s.map.verticesX[s.map.lines.v2[t.line]!]! / FL;
        const v2y = s.map.verticesY[s.map.lines.v2[t.line]!]! / FL;
        const dx = v2x - v1x, dy = v2y - v1y;
        const len = Math.hypot(dx, dy) || 1;
        const offsets = t.kind === 'cross' || t.kind === 'exit-cross' ? [64, 96] : [48, 16];
        for (const off of offsets) {
          const mx = (v1x + v2x) / 2, my = (v1y + v2y) / 2;
          const px = (t.stand?.x ?? mx + (dy / len) * off) * FL;
          const py = (t.stand?.y ?? my + (-dx / len) * off) * FL;
          const ang = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
          api.sim.warp(Math.round(px), Math.round(py), undefined, ang);
          api.sim.runTics(2);
          scan();
          if (t.kind === 'use' || t.kind === 'exit-use') {
            for (let press = 0; press < 16; press++) {
              api.sim.runTics(1, { use: true });
              api.sim.runTics(1);
              scan();
              if (goal()) break;
            }
          } else {
            for (let tic = 0; tic < 100; tic++) {
              api.sim.runTics(1, { forward: true });
              scan();
              if (goal()) break;
            }
          }
          if (goal()) break;
        }
        segs.push({ line: t.line, fired: isExit ? s.exitRequest !== 'none' : expected.some((sec) => moved.has(sec)), moved: [...moved].sort((a, b) => a - b) });
      }
      const exit = s.exitRequest;
      api.pause(false); // wiring drains exitRequest on the next live tic
      return { exit, segs };
    },
    [plain as { line: number; special: number; kind: RouteTrigger['kind']; tag?: number; stand?: { x: number; y: number } }[], cards] as const
  );
  return out;
}

async function gotoBoot(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
  await enterPlay(page);
}

test.describe('M12-03 L4 playthroughs', () => {
  test('E1M1 full playthrough → live intermission (WI stats), zero console errors', async ({ page }) => {
    const errors = watchErrors(page);
    await gotoBoot(page);
    const r = await runRouteInPage(page, 'E1M1');
    expect(r.exit).toBe('normal');
    for (const seg of r.segs) expect(seg.fired, `L${seg.line} must fire with movement`).toBe(true);
    await page.waitForFunction(
      () => {
        const u = window.__doom!.ui()!;
        return u.screen.gamestate === 1 && u.wi !== null && u.wi.active && u.wi.phase === 'StatCount';
      },
      null,
      { timeout: 15_000 }
    );
    const u = await page.evaluate(() => window.__doom!.ui()!);
    expect(u.wi!.next, 'tally hands to E1M2').toBe(1);
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('E1M2 route (B-11 blazing plat is a ledger step) → live intermission, zero console errors', async ({ page }) => {
    const errors = watchErrors(page);
    await gotoBoot(page);
    // real-key cheat lane to E1M2 (M11-09 idclev seam), then settle
    await page.evaluate(() => window.__doom!.typeChars('idclev12'));
    await page.waitForFunction(() => window.__doom!.sim.getState()!.map.name === 'E1M2', null, { timeout: 15_000 });
    const r = await runRouteInPage(page, 'E1M2');
    expect(r.exit).toBe('normal');
    for (const seg of r.segs) expect(seg.fired, `L${seg.line} must fire with movement (B-11 teeth)`).toBe(true);
    const platSeg = r.segs.find((x) => x.line === 350)!;
    expect(platSeg.moved, 'tag-14 blazing plat (sec 124) must have moved').toContain(124);
    await page.waitForFunction(
      () => {
        const u = window.__doom!.ui()!;
        return u.screen.gamestate === 1 && u.wi !== null && u.wi.active && u.wi.phase === 'StatCount';
      },
      null,
      { timeout: 15_000 }
    );
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });

  test('E1M8 boss-map route → straight to GS_FINALE (Doom-1 ga_victory), zero console errors', async ({ page }) => {
    const errors = watchErrors(page);
    await gotoBoot(page);
    await page.evaluate(() => window.__doom!.typeChars('idclev18'));
    await page.waitForFunction(() => window.__doom!.sim.getState()!.map.name === 'E1M8', null, { timeout: 15_000 });
    const r = await runRouteInPage(page, 'E1M8');
    expect(r.exit, 'W1 exit-ring cross latches the normal exit').toBe('normal');
    for (const seg of r.segs) expect(seg.fired, `L${seg.line} must fire with movement`).toBe(true);
    await page.waitForFunction(() => window.__doom!.ui()!.screen.gamestate === 2, null, { timeout: 15_000 });
    expect(errors, `console errors: ${errors.join('\n')}`).toEqual([]);
  });
});
