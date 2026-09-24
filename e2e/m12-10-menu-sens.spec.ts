/**
 * M12-10 — OPTIONS-menu mouse_sensitivity: REAL menu keys → LIVE apply →
 * RELOAD persistence (the M12-09 gap-list fix; complements the m11-persist
 * API-path settings-survival test, which stays untouched).
 *
 * The gap: menu.ts's mChangeSensitivity (m_menu.c:1112-1125) moved a
 * MENU-LOCAL row — nothing reached settings.ts (no store write) and
 * nothing reached mouse.ts (mountMouse only remounted on settings-change
 * notifies, main.ts applySettingsView). Vanilla truth: the menu row IS
 * the config variable M_SaveDefaults writes — changing it persists.
 *
 * The fix being pinned: the main.ts composer's law pump
 * (pumpMenuSensitivity, M10-09 wiring.ts thermos-pump precedent) polls
 * menuState.mouseSensitivity() on the rAF cadence and, WRITE-ON-CHANGE
 * (same semantics as the volumes), pushes it through
 * settings().setVar('mouse_sensitivity', …) — one call ⇒ dirty+debounced
 * IDB write AND the notify ⇒ applySettingsView ⇒ mountMouse REMOUNT with
 * the new (mouseSensitivity+5)/10 law (g_game.c:579-580, mouse.ts:7-8).
 *
 * Observability WITHOUT any API write:
 *   * live apply — the physics.spec turn math: injectMouse(+10,0) over
 *     exactly ONE tic turns `(-scale(10,sens)*8)<<16` BAM, where
 *     scale(d,s) = trunc(d*(s+5)/10) (C integer division, g_game.c:579).
 *     sens 5 ⇒ 10 ⇒ 0xFFF80000-class delta; sens 8 ⇒ 13 (the change).
 *   * store — the debounce-quiescence poll (m11-persist idiom: expect.
 *     poll on status().dirty/writePending/lastWrite — async predicates do
 *     NOT work with waitForFunction, playwright 1.63), then RELOAD, then
 *     settings() echo + the SAME turn math pre-first-live-tick (D-11b:
 *     hydrate is awaited before afterLoad, so a mounted mouseInput is a
 *     fact once a state exists — no menu interaction after the reload).
 *
 * Known-and-cited display law (same gap class as the audio thermos,
 * main.ts pumpAudioWiring note): the menu DISPLAY keeps the shipped row
 * until touched; the pump is primed at the menu's shipped 5, so a
 * hydrated 8 is never echoed back and clobbered.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { enterPlay } from './playstart';

/* helpers: m9-flow/m11-persist idioms (frame-driven settles, seam waits —
 * no pacing sleeps decide an outcome) */

const ui = (page: Page) => page.evaluate(() => window.__doom!.ui()!);

async function settle(page: Page, frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(
      () =>
        Promise.race([
          new Promise((r) => requestAnimationFrame(() => r(1))),
          new Promise((r) => setTimeout(() => r(0), 500))
        ])
    );
  }
}

const pressKey = async (page: Page, key: string, frames = 3): Promise<void> => {
  await page.keyboard.press(key);
  await settle(page, frames);
};

/** g_game.c:579-580 sensitivity law + the one-tic turn chain (physics.spec
 * mouseTurnBam, generalized to an explicit sens): mousex = trunc(d*(s+5)/10),
 * angleturn -= mousex*0x8, P_MovePlayer angle += angleturn<<16. */
function turnBam(dx: number, sens: number): number {
  const scaled = Math.trunc((dx * (sens + 5)) / 10);
  return ((-scaled * 8) << 16) >>> 0;
}

function bamDelta(a0: number, a1: number): number {
  return ((a1 - a0) % 4294967296 + 4294967296) % 4294967296;
}

/** Pause + the two channels the turn math needs (physics.spec snap half). */
function snap(page: Page): Promise<{ leveltime: number; angle: number }> {
  return page.evaluate(() => {
    window.__doom!.pause(true);
    const st = window.__doom!.sim.getState()!;
    return { leveltime: st.leveltime, angle: st.players[0]!.mo.angle >>> 0 };
  });
}

/** Resume and stop at the FIRST frame reaching `target` leveltime — pause +
 * read inside the SAME callback make the tic count exact (physics.spec). */
function runTo(page: Page, target: number): Promise<{ leveltime: number; angle: number }> {
  return page.evaluate(
    (t: number) =>
      new Promise<{ leveltime: number; angle: number }>((resolve) => {
        const api = window.__doom!;
        const check = (): void => {
          const st = api.sim.getState();
          if (st !== null && st.leveltime >= t) {
            api.pause(true);
            resolve({ leveltime: st.leveltime, angle: st.players[0]!.mo.angle >>> 0 });
          } else {
            requestAnimationFrame(() => check());
          }
        };
        api.pause(false);
        check();
      }),
    target
  );
}

/** injectMouse(dx,0) — the raw ev_mouse accumulator seam (scaling, drain
 * and the consumed-once rule stay on the REAL per-tic path). */
const injectRight = (page: Page, dx: number): Promise<unknown> =>
  page.evaluate((d: number) => window.__doom!.sim.injectMouse(d, 0), dx);

/** Turn probe: snap → inject → resume to the FIRST frame with
 * leveltime ≥ a0+1. The BAM delta is EXACT at ≥1 tic regardless of a small
 * resume backlog (≤ MAX_CATCHUP): the injected delta is consumed-once
 * (g_game.c:411 — the drain lives in sample()), and every later tic's
 * angleturn is 0 with no momentum carry on the ANGLE channel. Physics's
 * runTo mechanics, with the strict +1 pin relaxed to ≥1: an evaluate hop
 * can legally straddle two 28.57-ms tics (the first run measured 2). */
async function oneTurnBam(page: Page, dx: number): Promise<number> {
  const a0 = await snap(page);
  await injectRight(page, dx);
  const a1 = await runTo(page, a0.leveltime + 1);
  return bamDelta(a0.angle, a1.angle);
}

/** Walk the CURRENT menu to item `want` with real ArrowDowns (m9-flow
 * stage-5 guard pattern: every press is consumed before the next). */
async function walkTo(page: Page, want: number): Promise<void> {
  for (let guard = 0; guard < 12; guard++) {
    if ((await ui(page)).menu!.itemOn === want) return;
    await pressKey(page, 'ArrowDown');
  }
  throw new Error(`itemOn never reached ${want}`);
}

/** Settings-controller QUIESCE poll (m11-persist durability hop: the
 * write-on-change put is debounced 200 ms; reload only after it COMMITTED).
 * expect.poll, not waitForFunction — async predicates resolve instantly. */
async function settingsQuiesced(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          // NON-literal specifier (m11-persist idiom): vite dev serves
          // /src/** and the same-URL import returns the SAME module
          // instance main.ts already evaluated; a literal would be
          // type-resolved (and fail) in the node tsc pass.
          const url = '/src/persist/settings.ts';
          const m = await import(url);
          const s = m.settings().status();
          return s.dirty === false && s.writePending === false && s.lastWrite?.ok === true;
        }),
      { timeout: 10_000 }
    )
    .toBe(true);
}

test.describe('M12-10 menu mouse_sensitivity → live → store → reload', () => {
  test.setTimeout(120_000);

  test('real menu keys change sens: live remount + persist across reload', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__doom!.settings().loaded === true, null, { timeout: 10_000 });
    expect((await page.evaluate(() => window.__doom!.settings())).vars.mouse_sensitivity).toBe(5);
    await enterPlay(page);

    // (1) BASELINE at the shipped row: dx=10, sens 5 ⇒ ×1 identity.
    expect(await oneTurnBam(page, 10), 'baseline turn == sens-5 identity').toBe(turnBam(10, 5));

    // (2) THE MENU, with REAL keys only (no API): Esc → Options → walk to
    // the M_MSENS row (OptionsDef item 5) → three ArrowRights: 5 ⇒ 8.
    await page.evaluate(() => window.__doom!.pause(false)); // runTo parked it
    await pressKey(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.active, null, { timeout: 5_000 });
    await walkTo(page, 1); // MainDef: Options
    await pressKey(page, 'Enter');
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.menuName === 'OptionsDef',
      null,
      { timeout: 5_000 }
    );
    await walkTo(page, 5); // options_e.mousesens (m_menu.c:337-347)
    expect((await ui(page)).menu!.mouseSensitivity, 'menu row ships at 5').toBe(5);
    for (let i = 0; i < 3; i++) {
      await pressKey(page, 'ArrowRight');
      expect((await ui(page)).menu!.mouseSensitivity).toBe(6 + i);
    }
    await pressKey(page, 'Escape');
    await page.waitForFunction(() => !window.__doom!.ui()!.menu!.active, null, { timeout: 5_000 });

    // (3) LIVE APPLIED without any API call: dx=10 now scales to 13
    // (10*(8+5)/10, C trunc) — the mountMouse remount the pump's setVar
    // notify performed. The OLD wiring (menu-local) would read sens-5.
    expect(await oneTurnBam(page, 10), 'menu change reached mouse.ts live').toBe(turnBam(10, 8));

    // (4) STORED write-on-change: the debounced commit quiesced…
    await settingsQuiesced(page);
    // …and the record itself says 8 (read-your-writes is fine HERE — the
    // quiesce above already proved the tx committed).
    const rec = await page.evaluate(async () =>
      new Promise<unknown>((res) => {
        const r = indexedDB.open('doom');
        r.onsuccess = () => {
          const q = r.result.transaction('settings', 'readonly').objectStore('settings').get('settings');
          q.onsuccess = () => {
            r.result.close();
            res(q.result ?? null);
          };
          r.onerror = () => res(null);
        };
        r.onerror = () => res(null);
      })
    );
    expect((rec as { vars?: { mouse_sensitivity?: number } }).vars?.mouse_sensitivity).toBe(8);

    // (5) RELOAD (the vanilla default.cfg reload law): applied PRE-first-
    // tick (hydrate is awaited before afterLoad — D-11b), so the turn math
    // reads 13 again with NO menu interaction on this second boot.
    await page.reload();
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
    const after = await page.evaluate(() => window.__doom!.settings());
    expect(after.loaded).toBe(true);
    expect(after.vars.mouse_sensitivity).toBe(8);
    await enterPlay(page);
    expect(await oneTurnBam(page, 10), 'rehydrated sens applied pre-tick (mountMouse)').toBe(turnBam(10, 8));

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
