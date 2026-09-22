/**
 * B-10 regression — the REAL menu path, all five skills, live browser.
 *
 * The field report claimed "live E1M1 via New Game menu spawns ~1 monster"
 * while the harness boot (default skill) showed full rosters — pointing at
 * the menu→skill plumbing. Vanilla truth: M_ChooseSkill passes the menu
 * choice index 0..4 straight to G_DeferedInitNew (m_menu.c:915) where
 * gameskill = skill (g_game.c:1450); the spawn bit is then
 * `bit = 1<<(gameskill-1)` with sk_baby→1 / sk_nightmare→4 specials
 * (p_mobj.c:741-748). This spec drives that exact route with REAL keys
 * (Esc → New Game → E1 → arrows → Enter, + 'y' on the nightmare verify)
 * for EVERY skill row and asserts the seam pair
 * (state().screen.gameskill, state().monsters) against the WAD-measured
 * E1M1_ALIVE-BY-SKILL table (tests/fixtures/m8Roster.ts, same rows the
 * sim-level table test pins in tests/headless/spawn-skill.test.ts).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

import type { DebugMonsters } from '../src/types/debug';
import { MT } from '../src/wad/info/mobjinfo';
import { E1M1_SKILL_ALIVE } from '../tests/fixtures/m8Roster';

// doomednum → MT_ index of the tracked monster rows (mobjinfo order,
// same pairs the fixture documents): for the byType cross-check.
const DN_TO_MT: Readonly<Record<number, number>> = {
  3004: MT.MT_POSSESSED,
  9: MT.MT_SHOTGUY,
  3001: MT.MT_TROOP,
  3002: MT.MT_SERGEANT,
  58: MT.MT_SHADOWS
};

async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
}

/** Real key press + the frames that consume it (m9-flow pressKey idiom —
 * the queue drain is per-tic, so a bare press can be swallowed). */
async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
  );
}

/** Walk the live menu (fresh page ⇒ title attract) to the skill row
 * `row` (0..4) with REAL keys and fire M_ChooseSkill. */
async function pickSkill(page: Page, row: number): Promise<void> {
  await press(page, 'Escape'); // arm the menu on the attract
  await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5_000 });
  await press(page, 'Enter'); // New Game → EpiDef (NEWGAME, episodic)
  await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'EpiDef', null, { timeout: 5_000 });
  await press(page, 'Enter'); // E1 → NewDef (skill menu)
  await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'NewDef', null, { timeout: 5_000 });
  for (let guard = 0; ; ) {
    const cur = await page.evaluate(() => window.__doom!.ui()!.menu!.itemOn);
    if (cur === row) break;
    if (++guard > 10) throw new Error(`skill-menu nav stuck at ${cur}`);
    await press(page, cur < row ? 'ArrowDown' : 'ArrowUp');
  }
  await press(page, 'Enter');
  if (row === 4) {
    // M_VerifyNightmare: only 'y' fires the deferred init (m_menu.c:895).
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.messageToPrint === 1, null, { timeout: 5_000 });
    await press(page, 'y');
  }
  await page.waitForFunction(
    () => {
      const st = window.__doom!.state();
      return !!st.ready && st.screen.gamestate === 0 && st.map === 'E1M1' && st.leveltime > 2;
    },
    null,
    { timeout: 15_000 }
  );
}

test.describe('B-10 live New Game menu → E1M1 census, every skill', () => {
  for (const row of [0, 1, 2, 3, 4]) {
    test(`skill row ${row} (gameskill ${row + 1}) spawns the WAD census`, async ({ page }) => {
      test.skip(await wadMissing(page));
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto('/', { waitUntil: 'load' });
      await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60_000 });
      await pickSkill(page, row);
      const out = await page.evaluate(() => {
        const st = window.__doom!.state();
        return { gameskill: st.screen.gameskill, monsters: (st as unknown as { monsters: DebugMonsters }).monsters };
      });
      const truth = E1M1_SKILL_ALIVE[row]!;
      expect(out.gameskill, `state().screen.gameskill at menu row ${row}`).toBe(row + 1);
      expect(out.monsters.alive, `E1M1 monsters alive at menu row ${row}`).toBe(truth.monsters);
      expect(out.monsters.mobjs.length, `mobjs list length`).toBe(truth.monsters);
      expect(out.monsters.barrels, `E1M1 barrels at menu row ${row}`).toBe(truth.barrels);
      for (const [dn, mt] of Object.entries(DN_TO_MT)) {
        expect(out.monsters.byType[mt] ?? 0, `byType[MT ${mt}] (doomednum ${dn}) at row ${row}`).toBe(
          truth.byDoomednum[Number(dn)] ?? 0
        );
      }
      expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
    });
  }
});
