/**
 * M11-11 — reload-persistence e2e: the milestone money shot (plan §M11-11,
 * ROADMAP M11 exit 1/5/6 at L4).
 *
 * THE identity design (why the hash equality is EXACT, §0.1/§M11-04):
 * the payload rides gametic + leveltime + rndindex/prndindex, and BOTH sides
 * of every comparison get the SAME treatment:
 *   page A: …live history… → pause(true) → scripted drain of the save arm
 *           (runTics(2): tic 1 sendsave→cmd, tic 2 the ga_savegame capture
 *           INSIDE the drain + one post-restore world tic) → REFERENCE
 *           (hash, fields, pixels, 100-tic trajectory) computed from
 *           snapshot+1 tic;
 *   page B (after page.reload(), IDB surviving): pause(true) → load(slot)
 *           armed → runTics(1) drains ga_loadgame (restore + the SAME one
 *           post-restore world tic) → the state is snapshot+1 tic AGAIN —
 *           byte-identical hash, byte-identical framebuffer, and the same
 *           100-tic continuation trajectory.
 * Live history before the save (real clicks, menu tics) is irrelevant by
 * construction — the snapshot is the zero point. No sleeps decide an
 * outcome: every wait is a waitForFunction on a seam.
 *
 * IDB contract proved here (plan §M11-01/§0.4): a FRESH browser context
 * starts EMPTY (Playwright's per-test context isolation = the "new tab
 * after crash" analogue — asserted, not assumed), a page RELOAD keeps the
 * stores (the persistence claim itself), and nothing bleeds across tests.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { enterPlay } from './playstart';

/* ------------------------------------------------------------------ */
/* platform helpers (m9-flow idioms: FRAME-DRIVEN settles, live CSS     */
/* canvas mapping, ui()/state() seam reads)                              */
/* ------------------------------------------------------------------ */

const ui = (page: Page) => page.evaluate(() => window.__doom!.ui()!);

const state = (page: Page) => page.evaluate(() => window.__doom!.state() as any);

/** Boot with the console-error collector (m9-flow boot idiom). */
async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
  return errors;
}

/** Drive `frames` rAF cycles (frame-driven, never a pacing sleep). */
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

/** canvas-space client coords for a 320x200 screen point (m9-flow). */
async function canvasPt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      const r = document.getElementById('game')!.getBoundingClientRect();
      return { x: r.left + (sx * r.width) / 320, y: r.top + (sy * r.height) / 200 };
    },
    [x, y] as const
  );
}

/** Real-click a menu row: hover (skull moves) + click (menuMouse synth Enter). */
async function clickRow(page: Page, box: { x: number; y: number }): Promise<void> {
  const pt = await canvasPt(page, box.x + 30, box.y + 8);
  await page.mouse.move(pt.x, pt.y);
  await settle(page, 2);
  await page.mouse.click(pt.x, pt.y);
  await settle(page, 3);
}

/** Wait for the store-backed `doom` DB (main.ts opens it at boot; NEVER open
 * it before main.ts — a premature bare open() would create a store-less DB
 * that the versioned open would then not upgrade). */
async function idbReady(page: Page): Promise<void> {
  await page.waitForFunction(
    async () =>
      await new Promise<boolean>((res) => {
        const r = indexedDB.open('doom');
        r.onsuccess = () => {
          const db = r.result;
          const ok = db.objectStoreNames.contains('saves') && db.objectStoreNames.contains('settings');
          db.close();
          res(ok);
        };
        r.onerror = () => res(false);
        r.onupgradeneeded = () => {
          // We must never be the creator — but if we somehow are, do NOT
          // create stores (main.ts owns the schema); just let it land.
        };
      }),
    null,
    { timeout: 15_000 }
  );
}

const idbKeys = (page: Page, store: 'saves' | 'settings'): Promise<(string | number)[]> =>
  page.evaluate(
    async (s) =>
      await new Promise<(string | number)[]>((res, rej) => {
        const r = indexedDB.open('doom');
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction(s, 'readonly').objectStore(s).getAllKeys();
          q.onsuccess = () => {
            db.close();
            res(q.result as (string | number)[]);
          };
          q.onerror = () => rej(q.error);
        };
        r.onerror = () => rej(r.error);
      }),
    store
  );

const idbGet = (page: Page, store: 'saves' | 'settings', key: string | number): Promise<any> =>
  page.evaluate(
    async ([s, k]) =>
      await new Promise<any>((res, rej) => {
        const r = indexedDB.open('doom');
        r.onsuccess = () => {
          const db = r.result;
          const q = db.transaction(s, 'readonly').objectStore(s).get(k);
          q.onsuccess = () => {
            db.close();
            res(q.result ?? null);
          };
          q.onerror = () => rej(q.error);
        };
        r.onerror = () => rej(r.error);
      }),
    [store, key] as const
  );

/** SHA-256 of the LIVE 320x200 framebuffer index buffer (walls/physics
 * spec idiom — the PIXEL surface, not a screenshot of the CSS page). */
const frameDigest = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const cap = window.__doom!.capture();
    const digest = await crypto.subtle.digest('SHA-256', cap.indices.slice().buffer as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  });

/** REAL menu-click route: title → MainDef → New Game (click) → episode 1
 * (click) → Hurt me (click) → live E1M1 (the "real game", not the scripted
 * playstart drain). Live tics before the save point are irrelevant to the
 * identity proofs (see header). */
async function playViaClicks(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const u = window.__doom!.ui();
    return u !== null && u.title?.pagename === 'TITLEPIC';
  }, null, { timeout: 15_000 });
  await pressKey(page, 'Escape');
  await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5_000 });
  await clickRow(page, (await ui(page)).menu!.itemBoxes![0]!); // New Game
  await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'EpiDef', null, { timeout: 5_000 });
  await clickRow(page, (await ui(page)).menu!.itemBoxes![0]!); // Episode 1
  await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'NewDef', null, { timeout: 5_000 });
  await clickRow(page, (await ui(page)).menu!.itemBoxes![2]!); // Hurt me
  await page.waitForFunction(
    () => {
      const s = window.__doom!.state();
      return s.ready && s.gamestate === 'GS_LEVEL' && s.map === 'E1M1' && s.screen.usergame === true;
    },
    null,
    { timeout: 15_000 }
  );
}

/* ------------------------------------------------------------------ */
/* 1 — THE money shot: save → page.reload() → load, byte-exact world    */
/* ------------------------------------------------------------------ */

test.describe('M11-11 save → RELOAD → load identity', () => {
  test('hash + pixels + 100-tic continuation match across a real reload', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await boot(page);
    await idbReady(page);

    // FRESH CONTEXT ⇒ EMPTY STORES (the "reload keeps IDB, new context
    // starts empty" contract — asserted, not assumed).
    expect(await idbKeys(page, 'saves')).toEqual([]);
    expect(await idbKeys(page, 'settings')).toEqual([]);

    await playViaClicks(page);

    // Freeze, fire a few scripted shots (ammo moves), drain the save arm
    // on scripted tics (tic 1 = sendsave cmd, tic 2 = the capture inside
    // the ga_savegame drain), take the REFERENCE, run the 100-tic
    // trajectory half (pre-reload).
    const ref = await page.evaluate(async () => {
      const api = window.__doom!;
      api.pause(true);
      api.popInput();
      api.sim.runTics(30, { attack: true });
      api.sim.runTics(12);
      api.sim.runTics(30, { attack: true });
      api.sim.runTics(40);
      const preAmmo = Array.from((api.sim.getState()!.players[0] as any).ammo ?? []);
      const p = api.save(0, 'm11-money'); // arms synchronously
      api.sim.runTics(2); // the scripted save drain (snapshot + 1 world tic)
      const ok = await p; // resolves once savesDone moved + store flushed
      const at = api.state() as any;
      const reference = { hash: at.hash, leveltime: at.leveltime, gametic: at.gametic, player: at.player, monsters: at.monsters };
      const traj: number[] = [];
      for (let i = 0; i < 100; i++) traj.push(api.sim.runTics(1));
      return { ok, preAmmo, reference, traj };
    });
    expect(ref.ok).toBe(true);
    expect(ref.preAmmo[1]!).toBeLessThan(50); // shots FIRED (ammo moved)
    const refPixels = await frameDigest(page);

    // The save is ON DISK and survives the reload itself:
    expect(await idbKeys(page, 'saves')).toEqual([0]);
    await page.reload();
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
    expect(await idbKeys(page, 'saves')).toEqual([0]); // RELOAD KEEPS IDB

    // Re-load slot 0: arm (store.get async), wait for ga_loadgame, drain on
    // ONE scripted tic (restore + the symmetric one post-restore world tic).
    const post = await page.evaluate(async () => {
      const api = window.__doom!;
      api.pause(true);
      api.popInput();
      const ok = await api.load(0);
      for (let i = 0; i < 300 && api.sim.getState()!.gameaction !== 3; i++)
        await new Promise((r) => setTimeout(r, 10));
      const armed = api.sim.getState()!.gameaction === 3; // ga_loadgame
      api.sim.runTics(1); // the load drain
      const s = api.state() as any;
      const traj: number[] = [];
      for (let i = 0; i < 100; i++) traj.push(api.sim.runTics(1));
      return { ok, armed, hash: s.hash, leveltime: s.leveltime, gametic: s.gametic, player: s.player, monsters: s.monsters, traj };
    });
    expect(post.ok).toBe(true);
    expect(post.armed).toBe(true);

    // THE exit line: state().hash EQUALS the pre-reload reference.
    expect(post.hash).toBe(ref.reference.hash);
    expect(post.player).toEqual(ref.reference.player); // ammo/pos/weapons/pspr
    expect(post.monsters).toEqual(ref.reference.monsters); // full census
    expect([post.leveltime, post.gametic]).toEqual([ref.reference.leveltime, ref.reference.gametic]);

    // PIXEL identity at the restored viewpoint (raw framebuffer digest).
    const postPixels = await frameDigest(page);
    expect(postPixels).toBe(refPixels);

    // 100-frame continuation: the post-reload trajectory is tick-for-tick
    // the pre-reload one (RNG counters rode the payload; zero divergence).
    expect(post.traj).toEqual(ref.traj);
    expect(post.traj[99]).not.toBe(ref.reference.hash); // the world MOVED

    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 2 — settings survival across a reload (ROADMAP exit 5, L4)           */
/* ------------------------------------------------------------------ */

test.describe('M11-11 settings across reload', () => {
  test('volumes + sensitivity: write-on-change → RELOAD → applied', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await boot(page);
    await idbReady(page);
    expect(await idbKeys(page, 'settings')).toEqual([]); // fresh context EMPTY

    const defaults = await page.evaluate(() => window.__doom!.settings());
    expect(defaults.loaded).toBe(false); // nothing stored yet ⇒ defaults stand
    expect(defaults.vars.sfx_volume).toBe(8);
    expect(defaults.vars.mouse_sensitivity).toBe(5);

    await page.evaluate(() => window.__doom!.settings({ sfx_volume: 3, music_volume: 1, mouse_sensitivity: 8 }));
    // write-on-change (D-11b, debounce): the RECORD lands without a reload
    await page.waitForFunction(
      async () => {
        const rec = await new Promise<any>((res) => {
          const r = indexedDB.open('doom');
          r.onsuccess = () => {
            const q = r.result.transaction('settings', 'readonly').objectStore('settings').get('settings');
            q.onsuccess = () => {
              r.result.close();
              res(q.result ?? null);
            };
          };
          r.onerror = () => res(null);
        });
        return rec?.vars?.sfx_volume === 3 && rec?.vars?.mouse_sensitivity === 8;
      },
      null,
      { timeout: 10_000 }
    );

    await page.reload();
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
    const after = await page.evaluate(() => window.__doom!.settings());
    expect(after.loaded).toBe(true);
    expect([after.vars.sfx_volume, after.vars.music_volume, after.vars.mouse_sensitivity]).toEqual([3, 1, 8]);
    // APPLIED, not just stored: the audio thermo consumer landed pre-tick.
    await page.waitForFunction(() => (window.__doom!.state() as any).audio?.sfxVolume === 3, null, { timeout: 10_000 });

    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3 — the MENU route: real clicks (New Game→Save→Load rows) + the      */
/*     name editor typed with REAL keys (plan §M11-11)                  */
/* ------------------------------------------------------------------ */

test.describe('M11-11 menu save/load with real input', () => {
  test('click Save-Game row → type name → slot row rides LoadDef → load', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await boot(page);
    await idbReady(page);
    await playViaClicks(page); // the REAL click route into E1M1 again

    // Esc → MainDef → REAL click the Save Game row (index 3: New Game,
    // Options, Load Game, SAVE GAME, Read This, Quit).
    await pressKey(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5_000 });
    await clickRow(page, (await ui(page)).menu!.itemBoxes![3]!);
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'SaveDef', null, { timeout: 5_000 });

    // Slot 0 (ArrowUp clamps at 0 — no wrap in 1.10), Enter ⇒ the string
    // editor ("intercepting all chars", m_menu.c:656).
    for (let i = 0; i < 7; i++) await pressKey(page, 'ArrowUp', 1);
    expect((await ui(page)).menu!.itemOn).toBe(0);
    await pressKey(page, 'Enter');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.messageToPrint === 1, null, { timeout: 5_000 });

    // TYPE THE NAME with real keys (every char intercepted), Enter ⇒
    // M_DoSave → G_SaveGame → the NEXT live drain.
    for (const ch of 'm11save') await pressKey(page, ch, 1);
    await pressKey(page, 'Enter', 4);
    await page.waitForFunction(() => (window.__doom!.state() as any).gamestate === 'GS_LEVEL', null, { timeout: 10_000 });
    await expect
      .poll(async () => (await idbGet(page, 'saves', 0))?.description ?? '', { timeout: 10_000 })
      .toBe('m11save'); // the 24B description = EXACTLY what was typed
    await page.waitForFunction(() => window.__doom!.ui()!.hud?.message === 'game saved.', null, { timeout: 10_000 });
    const savedLt = (await state(page)).leveltime; // rides the payload header

    // Live-play past the save point, then REAL-click the Load Game row and
    // confirm the typed name is the slot ROW's stored string (LoadDef rows
    // come from listSaves — verified through the store, the menu's source).
    await settle(page, 60);
    expect((await state(page)).leveltime).toBeGreaterThan(savedLt);
    await pressKey(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5_000 });
    await clickRow(page, (await ui(page)).menu!.itemBoxes![2]!); // Load Game
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'LoadDef', null, { timeout: 5_000 });
    expect((await idbGet(page, 'saves', 0))?.description).toBe('m11save');

    for (let i = 0; i < 7; i++) await pressKey(page, 'ArrowUp', 1);
    await pressKey(page, 'Enter', 4); // M_LoadSelect ⇒ G_LoadGame (no prompt)
    await page.waitForFunction(
      (lt: number) => (window.__doom!.state() as any).leveltime <= lt + 2,
      savedLt,
      { timeout: 10_000 }
    );
    expect((await state(page)).gamestate).toBe('GS_LEVEL'); // BACK in time, still PLAYING

    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 4 — F6/F9 quicksave/quickload: the -1 sentinel, the -2 slot-pick     */
/*     arming, the QLPROMPT y/n and the round-trip                      */
/* ------------------------------------------------------------------ */

test.describe('M11-11 F6/F9 quicksave round-trip', () => {
  test('QSAVESPOT sentinel → F6 arms -2 pick → type → F9 y restores ammo', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await boot(page);
    await idbReady(page);
    await enterPlay(page); // deterministic E1M1 (m9 harness)

    // quickSaveSlot == -1 (never picked): F9 must only message (QSAVESPOT)
    // and 'y' must do NOTHING (no load, clock untouched).
    await pressKey(page, 'F9');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.messageToPrint === 1, null, { timeout: 5_000 });
    const lt0 = (await state(page)).leveltime;
    await pressKey(page, 'y', 4);
    expect((await state(page)).leveltime).toBeGreaterThan(lt0); // world RAN on — no load

    // F6 with the fresh sentinel: opens SaveDef and arms quickSaveSlot = -2
    // ("pick a slot now", m_menu.c:706) — the SaveDef open IS the -2 face.
    await pressKey(page, 'F6');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'SaveDef', null, { timeout: 5_000 });
    for (let i = 0; i < 7; i++) await pressKey(page, 'ArrowUp', 1);
    await pressKey(page, 'Enter'); // editor
    await pressKey(page, 'q');
    await pressKey(page, 'u');
    await pressKey(page, 'i');
    await pressKey(page, 'c');
    await pressKey(page, 'k');
    await pressKey(page, 'Enter', 4);
    await expect
      .poll(async () => (await idbGet(page, 'saves', 0))?.description ?? '', { timeout: 10_000 })
      .toBe('quick');
    await page.waitForFunction(() => window.__doom!.ui()!.hud?.message === 'game saved.', null, { timeout: 10_000 });
    const ammoSaved = (await state(page)).player.ammo[1];

    // Live REAL-key shot: ammo moves BELOW the saved value, then F9 + 'y'
    // (quickSaveSlot >= 0 ⇒ QLPROMPT face) restores it exactly.
    await page.keyboard.down('Space');
    await settle(page, 20);
    await page.keyboard.up('Space');
    await settle(page, 20);
    expect((await state(page)).player.ammo[1]).toBeLessThan(ammoSaved);

    await pressKey(page, 'F9');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.messageToPrint === 1, null, { timeout: 5_000 });
    await pressKey(page, 'y', 4);
    await page.waitForFunction(
      (a: number) => ((window.__doom!.state() as any).player.ammo?.[1] ?? -1) === a,
      ammoSaved,
      { timeout: 10_000 }
    );
    expect((await state(page)).gamestate).toBe('GS_LEVEL');

    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 5 — cheats by REAL keys, live on the page (first L4 cheat proof)     */
/* ------------------------------------------------------------------ */

test.describe('M11-11 live cheat typing', () => {
  test('iddqd typed as real keys toggles god; idfa fills armor (ledger L4)', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await boot(page);
    await enterPlay(page);
    expect(await page.evaluate(() => window.__doom!.god())).toBe(false); // OFF baseline

    for (const ch of 'iddqd') await pressKey(page, ch, 2); // THE real-key cheat
    expect(await page.evaluate(() => window.__doom!.god())).toBe(true);
    await page.waitForFunction(() => window.__doom!.ui()!.hud?.message === 'Degreelessness Mode On', null, {
      timeout: 5_000
    });
    for (const ch of 'iddqd') await pressKey(page, ch, 2);
    expect(await page.evaluate(() => window.__doom!.god())).toBe(false); // toggle closes

    for (const ch of 'idfa') await pressKey(page, ch, 2);
    await page.waitForFunction(() => (window.__doom!.state() as any).player.armor === 200, null, { timeout: 5_000 });
    await page.waitForFunction(() => window.__doom!.ui()!.hud?.message === 'Ammo (no keys) Added', null, {
      timeout: 5_000
    });

    expect(errors).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 6 — demo PLAYBACK on the page: a crafted zero-cmd .lmp drives the    */
/*     sim through the NORMAL tick path and lands on the byte-identical */
/*     world a plain scripted run of the same tics builds (M11-06's     */
/*     record→replay identity, the L4 face; hashes cannot share an      */
/*     absolute (leveltime,gametic) clock across a G_DoPlayDemo         */
/*     re-setup, so the WORLD fields are the comparison)               */
/* ------------------------------------------------------------------ */

test.describe('M11-11 demo playback at L4', () => {
  test('playDemo over 60 zero tics rebuilds the plain-run world; marker ends it', async ({ page }) => {
    test.setTimeout(120_000);
    const errors = await boot(page);
    const TICS = 60;
    // Byte-exact 1.10 demo (g_game.c:1549-1570): 13B header + 4B/tic zero
    // cmds + DEMOMARKER 0x80 — TICS-1 recorded tics so the MARKER READ
    // lands inside the TICS-th tic (the last world tic runs the retained
    // zero cmd, vanilla's localcmds retention) — built here, fed to the
    // seam (the answer to the lump-only 1.10 demo I/O, D-11e).
    const lmp = new Uint8Array(13 + (TICS - 1) * 4 + 1);
    lmp.set([110, 3, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0]); // v110, hurt, E1, M1, 1P
    lmp[lmp.length - 1] = 0x80;

    // Half A: the plain reference — fresh E1M1, TICS tics of NOTHING.
    await enterPlay(page); // deterministic (1,1) entry
    const plain = await page.evaluate((n: number) => {
      const api = window.__doom!;
      api.pause(true);
      api.popInput();
      api.sim.runTics(n - 1); // == TICS tics since this level's setup
      const s = api.state() as any;
      return { leveltime: s.leveltime, player: s.player, monsters: s.monsters, map: s.map };
    }, TICS);

    // Half B: the replay — fresh entry re-armed, input REPLACED by the
    // demo bytes at the G_Ticker mount (never a bypass loop, D-11e).
    const res = await page.evaluate(
      async ([n, bytes]) => {
        const api = window.__doom!;
        api.pause(true);
        api.popInput();
        // Re-run the deterministic new-game drain (enterPlay idiom) — the
        // G_DoPlayDemo drain's own G_InitNew makes the clock absolute-
        // gametic-shifted, but its level state starts byte-identically.
        const st = api.sim.getState()!;
        st.gametic = 0;
        st.advancedemo = false;
        st.gameskill = 3;
        st.gameepisode = 1;
        st.gamemap = 1;
        st.gameaction = 2; // ga_newgame
        api.sim.runTics(1);
        api.playDemo(new Uint8Array(bytes as number[])); // ga_playdemo NEXT
        for (let i = 0; i < 300 && api.sim.getState()!.gameaction !== 5; i++)
          await new Promise((r) => setTimeout(r, 10)); // 5 = ga_playdemo
        const armed = api.sim.getState()!.gameaction === 5;
        const playing = api.demoStatus().playing;
        api.sim.runTics(n); // n tics: demo READS replace input at the mount
        const after = api.demoStatus(); // tic n's read hit the marker
        const s = api.state() as any;
        return {
          armed,
          playing,
          ended: !after.playing,
          world: { leveltime: s.leveltime, player: s.player, monsters: s.monsters, map: s.map }
        };
      },
      [TICS, Array.from(lmp)] as const
    );
    expect(res.armed).toBe(true);
    expect(res.playing).toBe(true);
    expect(res.ended).toBe(true); // DEMOMARKER consumed ⇒ playback off
    // The WORLD the replay builds == the world the plain run builds
    // (leveltime, pos, ammo, pspr, monster census — field-for-field).
    expect(res.world).toEqual(plain);

    // The faithful post-demo route (advancedemo flag, D023 ⇒ attract) is
    // consumed by the LIVE tic-block preamble — hand the loop back.
    await page.evaluate(() => {
      const api = window.__doom!;
      api.popInput();
      api.pause(false);
    });
    await page.waitForFunction(
      () => (window.__doom!.state() as any).gamestate !== 'GS_LEVEL' || window.__doom!.sim.getState()!.advancedemo,
      null,
      { timeout: 8_000 }
    );
    expect(errors).toEqual([]);
  });
});
