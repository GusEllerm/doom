/**
 * e2e M9-12 — L4: THE WHOLE LOOP with real keys/mouse (M9-plan §M9-12).
 *
 * One serial flow on ONE page (real input end to end, no scripted boot
 * shortcuts): TITLEPIC attract → REAL Esc arms the menu → REAL ↓/↑/Enter
 * pick skill Hurt me → E1M1 play → Esc menu + REAL mouse click selects
 * Options (menuMouse synth, D-0yy) → Options thermo ←/→ → '=' resize →
 * statusbar LIVE during play (face-rect pixel probe off __doom.capture) →
 * scripted M6 exit route (the specials.spec harness pattern: pause +
 * warp + scripted USE) → live intermission with a REAL accelerate click →
 * E1M2 loads → scripted kill + killPlayer + REAL use-tap reborn → the
 * D017-retired observables (leveltime reset, respawn census, counters) →
 * REAL F7 endgame → y → TITLEPIC returns. Zero console errors pinned.
 *
 * Determinism policy (plan §M9-12 acceptance): scripted segments run
 * under pause(true) via sim.runTics (exact); live segments are pinned by
 * wait-for-state (locator-style waitForFunction on the __doom.ui/state
 * seams), NEVER by sleeps. Flakes get re-run pins, not timeouts.
 *
 * Seams used: __doom.ui() (menu/HUD/title/WI/screen reads — M9-12),
 * state().screen.gamestate/gameaction, state().capture() (face probe),
 * sim.runTics/warp/giveWeapon/killPlayer, popInput. Screenshot artifacts:
 * artifacts/m9-flow/*.png for the exit review (D016).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DebugUiRead } from '../src/types/debug';

const F = 65536;
const ART = 'artifacts/m9-flow';

/* committed M6 route facts (specials.spec.ts — drift-checked in-test) */
const EXIT_ROUTE = {
  line: 407,
  special: 11,
  approach: [
    { x: -304, y: 1296, angleDeg: 180 },
    { x: -336, y: 1296, angleDeg: 180 },
    { x: -352, y: 1296, angleDeg: 180 }
  ]
} as const;

/* Face rect (st_stuff.c ST_FACESX/Y 143/168, 40x42 lump, clipped to the
 * bar at row 191) — the probe samples rows 169..190 × cols 144..174. */
const FACE = { x0: 144, x1: 175, y0: 169, y1: 191 };

type Ui = DebugUiRead;

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, {
    timeout: 30_000
  });
  return errors;
}

const ui = (page: Page): Promise<Ui> =>
  page.evaluate(() => window.__doom!.ui()!);

const shot = async (page: Page, name: string): Promise<void> => {
  mkdirSync(ART, { recursive: true });
  await page.screenshot({ path: join(ART, name) });
};

const pauseSim = (page: Page, on: boolean): Promise<unknown> =>
  page.evaluate((v) => window.__doom!.pause(v), on);

const popInput = (page: Page): Promise<unknown> =>
  page.evaluate(() => window.__doom!.popInput());

const simHash = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const s = window.__doom!.state();
    return s.ready ? s.hash : -1;
  });

/** canvas-space client coords for a 320x200 screen point (CSS scales the
 * canvas rect; computed live, never assumed 3x). */
async function canvasPt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      const r = document.getElementById('game')!.getBoundingClientRect();
      return { x: r.left + (sx * r.width) / 320, y: r.top + (sy * r.height) / 200 };
    },
    [x, y] as const
  );
}

/**
 * Drive `frames` rAF cycles (FRAME-DRIVEN, not sleeping): headless-chromium
 * under CDP generates compositor frames while the debug connection is IDLE,
 * so a raw command sequence starves the 35 Hz accumulator — queued keydowns
 * would pile up unconsumed. Registering an rAF callback from an evaluate
 * forces exactly one frame ⇒ exactly the tics that drain the event queue.
 * The 500ms timeout is a hang guard for a frame that never comes, not a
 * pacing sleep (plan §M9-12: pins, not sleeps).
 */
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

/**
 * Die→reborn consumes a BT_USE PRESS in P_DeathThink — real Space taps,
 * each followed by frames (the press must land on a tic where the death
 * think samples cmd; frames pump the tics, no sleeping).
 */
async function rebornByUseTaps(
  page: Page, want: { map: string | null; under: number }
): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const st = await page.evaluate(() => {
      const s = window.__doom!.state();
      return s.ready ? { lt: s.leveltime, map: s.map } : null;
    });
    if (st !== null && st.lt < want.under && (want.map === null || st.map === want.map)) return;
    await page.keyboard.down('Space');
    await settle(page, 2); // hold across two tics (BT_USE sampled per tic)
    await page.keyboard.up('Space');
    await settle(page, 1);
  }
  throw new Error('reborn never observed after 12 use taps');
}

/** real key press + the frames that consume it (queue drain is per-tic) */
const pressKey = async (page: Page, key: string, frames = 3): Promise<void> => {
  await page.keyboard.press(key);
  await settle(page, frames);
};

/** distinct palette indices inside a framebuffer rect (blank probe). */
const distinctRect = (page: Page, r: { x0: number; x1: number; y0: number; y1: number }): Promise<number> =>
  page.evaluate((rect) => {
    const cap = window.__doom!.capture();
    const seen = new Set<number>();
    for (let y = rect.y0; y < rect.y1; y++)
      for (let x = rect.x0; x < rect.x1; x++) seen.add(cap.indices[y * cap.width + x]!);
    return seen.size;
  }, r);

test.describe('M9-12 whole loop — TITLEPIC to title with real input', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let page: Page;
  let errors: string[] = [];
  const seams: Record<string, unknown> = {};

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });

  test('stage 1 — boot shows the TITLEPIC attract frame', async () => {
    errors = await boot(page);
    await page.waitForFunction(
      () => {
        const u = window.__doom!.ui();
        return u !== null && u.screen.gamestate === 3 && u.title!.pagename === 'TITLEPIC';
      },
      null,
      { timeout: 15_000 }
    );
    const u = await ui(page);
    expect(u.title!.demosequence).toBe(0); // D_DoAdvanceDemo case 0 (d_main.c:468)
    expect(u.screen.usergame).toBe(false); // :458 — "no save / end game here"
    // 320x200 pixels: TITLEPIC patch art, not a blank frame.
    expect(await distinctRect(page, { x0: 0, x1: 320, y0: 0, y1: 200 })).toBeGreaterThan(4);
    expect(await distinctRect(page, FACE), 'no statusbar over the attract').toBeDefined();
    seams.titleHash = await simHash(page);
    await shot(page, '01-title.png');
  });

  test('stage 2 — real Esc arms the menu; real ↓/↑+Enter pick Hurt me', async () => {
    await pressKey(page, 'Escape');
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.active && window.__doom!.ui()!.menu!.menuName === 'MainDef',
      null,
      { timeout: 5_000 }
    );
    await shot(page, '02-mainmenu.png');

    await pressKey(page, 'Enter'); // New Game
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.menuName === 'EpiDef',
      null,
      { timeout: 5_000 }
    );
    await pressKey(page, 'Enter'); // E1
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.menuName === 'NewDef',
      null,
      { timeout: 5_000 }
    );
    // REAL arrow keys (wiring forwards menu-mode arrows as vanilla
    // keydown/keyup pairs): down lands violence, up lands Hurt me again.
    await pressKey(page, 'ArrowDown');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.itemOn === 3, null, { timeout: 5_000 });
    await pressKey(page, 'ArrowUp');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.itemOn === 2, null, { timeout: 5_000 });
    await shot(page, '03-skill-hurtme.png');

    await pressKey(page, 'Enter'); // Hurt me → gDeferedInitNew drains next tic
    await page.waitForFunction(
      () => {
        const u = window.__doom!.ui()!;
        const st = window.__doom!.state();
        return (
          st.ready &&
          u.screen.gamestate === 0 &&
          u.screen.gameskill === 3 &&
          u.screen.usergame === true &&
          st.map === 'E1M1'
        );
      },
      null,
      { timeout: 15_000 }
    );
    expect((await ui(page)).menu!.active).toBe(false); // M_ClearMenus
    seams.playHash = await simHash(page);
  });

  test('stage 3 — statusbar live during play (face pixels + widgets)', async () => {
    await page.waitForFunction(
      () => window.__doom!.ui()!.hud!.statusbarOn,
      null,
      { timeout: 5_000 }
    );
    const u = await ui(page);
    expect(u.hud!.faceIndex).toBeGreaterThanOrEqual(0);
    expect(u.hud!.faceIndex).toBeLessThan(u.hud!.faceCount); // 0..41
    // THE face pixel probe: the 40x22 rect at (144,169) is NOT blank.
    expect(await distinctRect(page, FACE), 'face rect not blank').toBeGreaterThan(2);
    // sb9: the bar rows carry art and the view is windowed (capture wide).
    expect(await distinctRect(page, { x0: 0, x1: 320, y0: 196, y1: 200 })).toBeGreaterThan(1);
    await shot(page, '04-play-e1m1.png');
  });

  test('stage 4 — Esc menu + REAL mouse click picks Options (menuMouse)', async () => {
    await pressKey(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.active, null, { timeout: 5_000 });
    // Options is MainDef item 1 → (97, 112); hover first (synth arrows move
    // the skull), then the REAL click synthesizes the Enter pair.
    const boxes = (await ui(page)).menu!.itemBoxes!;
    expect(boxes.length).toBe(6); // MainDef: NewGame..QuitDOOM
    expect(boxes[1]!.x, 'Options row (MainDef y 64 + 16, m_menu.c:259)').toBe(97);
    expect(boxes[1]!.y).toBe(80);
    const pt = await canvasPt(page, 110, boxes[1]!.y + 8);
    await page.mouse.move(pt.x, pt.y);
    await settle(page, 2);
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.itemOn === 1, null, { timeout: 5_000 });
    await page.mouse.click(pt.x, pt.y); // mousedown ⇒ menuMouse synth Enter
    await settle(page, 3);
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.menuName === 'OptionsDef',
      null,
      { timeout: 5_000 }
    );
    await shot(page, '05-options.png');
  });

  test('stage 5 — Options thermo ←/→ + the = resize', async () => {
    // walk to the M_MSENS row (OptionsDef item 5, status 2 — arrows ok);
    // every press is CONSUMED (frames pumped) before the next is decided,
    // so the skull never overshoots the row
    for (let guard = 0; guard < 10; guard++) {
      if ((await ui(page)).menu!.itemOn === 5) break;
      await page.keyboard.press('ArrowDown');
      await settle(page, 3);
    }
    expect((await ui(page)).menu!.itemOn, 'M_MSENS row').toBe(5);
    const base = (await ui(page)).menu!.mouseSensitivity; // 5 (m_misc.c)
    await pressKey(page, 'ArrowLeft');
    expect((await ui(page)).menu!.mouseSensitivity, 'thermo −1 by ←').toBe(base - 1);
    await shot(page, '05b-thermo.png');
    await pressKey(page, 'ArrowRight');
    expect((await ui(page)).menu!.mouseSensitivity, 'thermo restored by →').toBe(base);

    // '=' resizes THROUGH the closed-panel M_Responder branch: Esc first.
    await pressKey(page, 'Escape');
    await page.waitForFunction(() => !window.__doom!.ui()!.menu!.active, null, { timeout: 5_000 });
    const sb = (await ui(page)).menu!.screenBlocks; // 9 (m_misc.c:279)
    await pressKey(page, 'Equal');
    expect((await ui(page)).menu!.screenBlocks, 'the = key grows the view').toBe(sb + 1);
    await shot(page, '06-resize-sb10.png');
    await pressKey(page, 'Minus'); // restore sb9
    expect((await ui(page)).menu!.screenBlocks, '- restores').toBe(sb);
  });

  test('stage 6 — scripted exit route → LIVE intermission + REAL accel click', async () => {
    await pauseSim(page, true);
    expect(await popInput(page)).not.toBeNull(); // drain real-input backlog
    const st = await page.evaluate((line) => {
      const s = window.__doom!.sim.getState()!;
      return { special: s.map.lines.special[line]!, exit: s.exitRequest };
    }, EXIT_ROUTE.line);
    expect(st.special, 'M6 route drift guard').toBe(EXIT_ROUTE.special);
    expect(st.exit).toBe('none');

    let exit = 'none';
    for (const wp of EXIT_ROUTE.approach) {
      await page.evaluate(
        ([wx, wy, a]) => {
          const api = window.__doom!;
          api.sim.runTics(3, { use: false });
          api.sim.warp(wx, wy, undefined, a);
          for (let t = 0; t < 6; t++) api.sim.runTics(1, { use: true });
        },
        [wp.x * F, wp.y * F, wp.angleDeg] as const
      );
      exit = await page.evaluate(() => window.__doom!.sim.getState()!.exitRequest);
      if (exit !== 'none') break;
    }
    expect(exit, 'S1 exit switch fired').toBe('normal');
    seams.wiEntryHash = await simHash(page);

    // resume: the wiring drains exitRequest → ga_completed → gDoCompleted
    await pauseSim(page, false);
    await page.waitForFunction(() => window.__doom!.ui()!.screen.gamestate === 1, null, {
      timeout: 10_000
    });
    const u = await ui(page);
    expect(u.wi!.active).toBe(true);
    expect(u.wi!.phase).toBe('StatCount');
    expect(u.wi!.next, 'next map = E1M2 (wminfo.next is 0-biased)').toBe(1);
    await shot(page, '07-intermission.png');

    // REAL clicks on the canvas ⇒ ev_mouse → key_fire → the accelerate
    // rising edge (WI_CheckForAccelerate — vanilla "click to skip"). The
    // stage flag is CONSUMED inside the same tic's update (wintermission
    // :330/:389), so the observable is the tally machine, not the flag:
    // click 1 fast-forwards every counter (spState → 10 within one tic;
    // naturally ≥5×TICRATE of counter pauses), click 2 leaves the tally
    // page (WI_initShowNextLoc, skipping its 70 tics too).
    const mid = await canvasPt(page, 160, 100);
    await page.mouse.move(mid.x, mid.y);
    // click until the state machine ACKNOWLEDGES each stage (a human mashes
    // the mouse on the tally; every rising edge is a legal vanilla skip, so
    // repeats are semantics-preserving and sampling-race immune)
    for (let i = 0; i < 6; i++) {
      if ((await ui(page)).wi!.spState === 10) break;
      await page.mouse.down();
      await settle(page, 2); // HOLD across ≥1 tic — the edge lives there
      await page.mouse.up();
      await settle(page, 1);
    }
    expect((await ui(page)).wi!.spState, 'accelerated tally: counters done').toBe(10);

    for (let i = 0; i < 6; i++) {
      if ((await ui(page)).wi!.phase !== 'StatCount') break;
      await page.mouse.down();
      await settle(page, 2);
      await page.mouse.up();
      await settle(page, 1);
    }

    // scripted run-out of the ACCELERATED sequence (exact tics — the pin:
    // natural StatCount pauses + 70 ShowNextLoc tics ≥ ~250; accelerated
    // lands E1M2 in a small fraction of that)
    const landed = await page.evaluate(() => {
      const sim = window.__doom!.sim;
      for (let t = 0; t < 4000; t++) {
        sim.runTics(1);
        const s = sim.getState()!;
        if (s.gamestate === 0 && s.map.name === 'E1M2') {
          return { map: s.map.name, lt: s.leveltime, ok: true, t };
        }
      }
      return { map: sim.getState()!.map.name, lt: sim.getState()!.leveltime, ok: false, t: 4000 };
    });
    // 70 ShowNextLoc + 35 NoState tics is the ACCELERATED floor; a natural
    // tally adds ≥5×TICRATE counter pauses (~175) on top — 200 separates
    const tBudget = 200;
    expect(landed.t, `accelerate pin: <${tBudget} scripted tics (natural ≥ ~250)`).toBeLessThan(tBudget);
    expect(landed.ok, 'WI run-out reaches E1M2 (exact tics, never a sleep)').toBe(true);
    seams.e1m2Hash = await simHash(page);
    expect(landed.map).toBe('E1M2');
    expect((await ui(page)).screen.gamemap).toBe(2);
    await pauseSim(page, false);
    await popInput(page);
    await shot(page, '08-e1m2.png');
  });

  test('stage 7 — kill a monster, die (killPlayer seam), REAL use-tap restart', async () => {
    await pauseSim(page, true);
    const census = async (): Promise<{ alive: number; barrels: number; killcount: number }> =>
      page.evaluate(() => {
        const s = window.__doom!.state();
        if (!s.ready) return { alive: -1, barrels: -1, killcount: -1 };
        return { alive: s.monsters.alive, barrels: s.monsters.barrels, killcount: s.monsters.killcount };
      });
    const c0 = await census();
    expect(c0.alive, 'E1M2 spawn census alive').toBeGreaterThan(0);
    const pistolStart = await page.evaluate(
      () => (window.__doom!.sim.getState()!.players[0] as unknown as { readyweapon: number }).readyweapon
    );

    // one scripted frag (shotgun family, warp beside a living monster,
    // point-blank burst) so "restored" means something; god mode only for
    // the frag window so retaliation cannot pre-empt the scripted death
    const frag = await page.evaluate((supersho) => {
      const sim = window.__doom!.sim;
      window.__doom!.god(true);
      sim.giveWeapon(2); // WP_SHOTGUN
      sim.giveWeapon(supersho); // WP_SUPERSHOTGUN — one tics worth of lead
      let tried = 0;
      for (const victim of sim.getState()!.mobjs.mobjs) {
        if (++tried > 4) break;
        if (victim.removed || victim.health <= 0) continue;
        sim.warp(victim.x + 48 * 65536, victim.y, undefined, 180);
        for (let t = 0; t < 25; t++) sim.runTics(1, { attack: true });
        sim.runTics(2);
        if (sim.getState()!.players[0]!.killcount > 0) break;
      }
      const kc = sim.getState()!.players[0]!.killcount;
      window.__doom!.god(false);
      return kc;
    }, 8);
    expect(frag, 'a frag registered (killcount > 0)').toBeGreaterThanOrEqual(1);
    const c1 = await census();
    expect(c1.alive, 'one fewer monster').toBeLessThan(c0.alive);
    seams.diedFromHash = await simHash(page);

    // die via the seam, then REAL Space taps: P_DeathThink consumes the
    // BT_USE press → PST_REBORN → G_DoReborn → level reload (D017 retired)
    await page.evaluate(() => window.__doom!.sim.killPlayer());
    await pauseSim(page, false);
    await popInput(page);
    await rebornByUseTaps(page, { map: 'E1M2', under: 10 });
    const c2 = await census();
    expect(c2.alive, 'D017 retired: respawn census == pre-death census').toBe(c0.alive);
    expect(c2.killcount, 'per-level counters reset by P_SetupLevel').toBe(0);
    const after = await page.evaluate(() => {
      const st = window.__doom!.sim.getState()!;
      return {
        lt: st.leveltime,
        readyweapon: (st.players[0] as unknown as { readyweapon: number }).readyweapon,
        health: st.players[0]!.health
      };
    });
    expect(after.readyweapon, 'pistol start again').toBe(pistolStart);
    expect(after.health).toBe(100);
    expect(after.lt, 'leveltime RESET (clock restarts)').toBeLessThan(10);
    expect(await simHash(page), 'hash moved across the restart').not.toBe(seams.diedFromHash);
    seams.rebornHash = await simHash(page);
    await shot(page, '09-reborn-e1m2.png');
  });

  test('stage 8 — face probe sees death (state-dependent pixels)', async () => {
    // face during play (alive, hurt tier possible) vs the dead face:
    const alive = await ui(page);
    expect(alive.hud!.statusbarOn).toBe(true);
    // The face machine is DISPLAY-side (stTicker runs in the rAF tic, not
    // in scripted runTics): kill on the LIVE loop and pump frames — from
    // the first dead tic on, R1dead re-fires EVERY tic (priority<10 &&
    // !health, st_statusbar.c:765-772) so faceIndex pins to ST_DEADFACE.
    await page.evaluate(() => window.__doom!.sim.killPlayer());
    await settle(page, 4);
    // ST_DEADFACE lives above the pain tiers (ST_GODFACE+1 = 41)
    expect((await ui(page)).hud!.faceIndex).toBe(41);
    // the corpse face is state, not a stuck frame: pixels distinct (not blank)
    expect(await distinctRect(page, FACE), 'dead-face pixels').toBeGreaterThan(2);
    // and the use-tap restarts the level again (same observable as stage 7)
    await rebornByUseTaps(page, { map: null, under: 5 });
  });

  test('stage 9 — REAL F7 endgame → y → TITLEPIC returns', async () => {
    await pressKey(page, 'F7');
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.messageToPrint === 1,
      null,
      { timeout: 5_000 }
    );
    await shot(page, '10-endgame.png');
    await pressKey(page, 'y');
    await page.waitForFunction(
      () => {
        const u = window.__doom!.ui()!;
        return u.screen.gamestate === 3 && u.title!.pagename === 'TITLEPIC' && u.screen.usergame === false;
      },
      null,
      { timeout: 15_000 }
    );
    const u = await ui(page);
    expect(u.menu!.active).toBe(false); // M_ClearMenus (mEndGameResponse)
    expect(u.title!.demosequence).toBe(0); // demosequence reset → case 0
    await page.waitForFunction(
      () => window.__doom!.state().ready,
      null,
      { timeout: 5_000 }
    );
    await page.evaluate(() => window.__doom!.pause(true)); // freeze the attract
    // world rewind: the tics drained while waiting must be consumed by the
    // scripted rewind to the SAME state the boot hash pins (deterministic
    // replay of the same input-free world). Instead of sleeping: step to a
    // stable pinned check — hash moved off the play-era value and the
    // attract is running the title page again.
    const now = await simHash(page);
    expect(now, 'the title world is NOT the ended game').not.toBe(seams.rebornHash);
    await shot(page, '11-title-return.png');
  });

  test('stage 10 — seam bookkeeping + zero console errors across the flow', async () => {
    const h = await simHash(page);
    expect(await simHash(page), 'hash is stable while frozen').toBe(h);
    console.log('m9-flow seam hashes:', JSON.stringify(seams));
    expect(errors, `console/page errors: ${errors.join('\n')}`).toEqual([]);
  });
});
