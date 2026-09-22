/**
 * e2e M5-08 — live-page physics (docs/design/M5-plan.md §M5-08): the real
 * boot page (index.html → main.ts: 35 Hz accumulator + rAF render, real DOM
 * keyboard + pointer-lock mouse wiring) driven through deterministic
 * capture points.
 *
 * Determinism trick used EVERYWHERE below: `pause(true)` freezes ONLY the
 * tic stepper (ARCHITECTURE §7 — rendering keeps running), so a "run to
 * leveltime N" watcher installed in-page resolves INSIDE one rAF callback,
 * pauses and snapshots — no tic can interleave with the read. The physics
 * curves are re-derived in-test from the pinned constants: thrust =
 * FixedMul(forwardmove*2048, finecosine[0]) with the tables.c HALF-TAP
 * finecosine[0] = 65535 (which is why the engine's first walk step is
 * 51199, not 51200), then per tic: mom += thrust; position += mom;
 * mom = FixedMul(mom, FRICTION 0xe800), STOPSPEED 0x1000 hard stop once no
 * movement input is held (the P_Thrust→P_XYMovement→P_Mover order, dual-
 * checked against tests/headless/movement.test.ts).
 *
 * Routes (E1M1, freedoom1.wad, spawn (-416,256) angle 0 = east):
 *  - east = the long open corridor (no wall within 1000+ units; floor flat
 *    at z 0 for the walked stretch) — the walk/bob/mouse stage;
 *  - west = a wall ~80 units out — the clipped-vs-noclip pair (D012).
 *
 * Pointer lock (plan §6 honesty note): real lock acquisition is NOT gated
 * on (headless chromium flakiness). The wiring IS proven live, at the
 * event seam: a canvas click really calls requestPointerLock (spy), and
 * dispatched pointerlockchange + mousemove{movementX} events flow
 * main.ts's production mouseInput.attach path into ev_mouse; the Esc
 * release is modeled by the same pointerlockchange(→null) event the
 * browser fires natively. Movement itself additionally rides the
 * __doom.sim.injectMouse queue seam (plan §M5-08 owns-list).
 *
 * viewz read-through (M5-06 follow-up, main.ts/view/renderer wiring): the
 * standing byte-identical capture below is its regression — standing
 * viewz == z + 41·FRACUNIT == the old setupView placeholder, so no golden
 * ever moves — and the walking viewz wave + differing crest/trough
 * captures are its proof.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { enterPlay } from './playstart';

/* ------------------------------------------------------------------ */
/* Pinned constants + the in-test derivation oracle                     */
/* ------------------------------------------------------------------ */

const FRACUNIT = 65536;
/** g_game.c forwardmove[0] (walk) × MOVE_THRUST_SCALE (p_user.c). */
const WALK_THRUST = 25 * 2048;
/** tables.c finesine[2048] = finecosine[0]: the half-tap 65535, NOT 65536.
 * FixedMul(51200, 65535) = 51199 is the engine's real first walk step. */
const COS_FINE0 = 65535;
/** tables.c finesine[0] = 25 — the angle-0 thrust y-leak (2 fixed/ms-scale). */
const SINE_FINE0 = 25;
const FRICTION = 0xe800;
const STOPSPEED = 0x1000;
/** view.ts VIEWHEIGHT_FIXED == sim player.ts VIEWHEIGHT: standing
 * viewz = z + this (P_CalcHeight with bob 0, viewheight at rest). */
const VIEW_OFFSET = 41 * FRACUNIT;
/** p_user.c MAXBOB. */
const MAXBOB = 0x100000;

/** Exact-C FixedMul (int64 product >> 16, low 32 bits — floors). */
function fixedMul(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
}

/** Per-tic momentum curve: thrust while held, move, friction/STOPSPEED
 * stop (no blocking — valid on the open east route). */
function deriveDist(heldTics: number, totalTics: number): number {
  let mom = 0;
  let x = 0;
  for (let i = 0; i < totalTics; i++) {
    if (i < heldTics) mom = (mom + fixedMul(WALK_THRUST, COS_FINE0)) | 0;
    x = (x + mom) | 0;
    if (i >= heldTics && mom > -STOPSPEED && mom < STOPSPEED) mom = 0;
    else mom = fixedMul(mom, FRICTION);
  }
  return x;
}

/* ------------------------------------------------------------------ */
/* Page plumbing (walls.spec pattern + the pause/resume watcher)        */
/* ------------------------------------------------------------------ */

async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
}

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

interface Snap {
  leveltime: number;
  x: number;
  y: number;
  z: number;
  viewz: number;
  bob: number;
  /** u32 BAM */
  angle: number;
  momx: number;
  reactiontime: number;
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
  // M9 boot flow: TITLEPIC first — deterministic enter-play
  // (e2e/playstart.ts) or NO world tic (scripted runTics included,
  // gTicker step-5) and no live key would ever reach the player.
  await enterPlay(page);
  await page.waitForTimeout(250); // ≥ ~8 settling tics (spawn reactiontime 0)
}

/** Pause + full-precision read of player 0 (reads are explicit §7: the
 * GameState object itself, since the §7 snapshot shape lacks mom/viewz
 * …viewz IS on the snapshot; mom is not — read the live state). */
function snap(page: Page): Promise<Snap> {
  return page.evaluate(() => {
    window.__doom!.pause(true);
    const st = window.__doom!.sim.getState()!;
    const p = st.players[0]!;
    return {
      leveltime: st.leveltime,
      x: p.mo.x,
      y: p.mo.y,
      z: p.mo.z,
      viewz: p.viewz,
      bob: p.bob,
      angle: p.mo.angle >>> 0,
      momx: p.mo.momx,
      reactiontime: p.mo.reactiontime
    };
  });
}

/**
 * Resume the live loop and stop at the FIRST rAF callback whose leveltime
 * reaches `target`: pause + snapshot happen inside that single callback, so
 * the tic count between two runTo endpoints is exact (at 60 Hz at most one
 * 28.57-ms tic fits a frame, and the watcher sees every frame).
 */
function runTo(page: Page, target: number): Promise<Snap> {
  return page.evaluate(
    (t: number) =>
      new Promise<Snap>((resolve) => {
        const api = window.__doom!;
        const check = (): void => {
          const st = api.sim.getState();
          if (st !== null && st.leveltime >= t) {
            api.pause(true);
            const p = st.players[0]!;
            resolve({
              leveltime: st.leveltime,
              x: p.mo.x,
              y: p.mo.y,
              z: p.mo.z,
              viewz: p.viewz,
              bob: p.bob,
              angle: p.mo.angle >>> 0,
              momx: p.mo.momx,
              reactiontime: p.mo.reactiontime
            });
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

/** SHA-256 of the live capture, in-page (walls.spec pattern). */
function captureSha(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const cap = window.__doom!.capture();
    const digest = await crypto.subtle.digest('SHA-256', cap.indices.slice().buffer as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

/** u32-safe BAM delta. */
function bamDelta(a0: number, a1: number): number {
  return ((a1 - a0) % 4294967296 + 4294967296) % 4294967296;
}

/**
 * Segment-start warp WITH test isolation: vanilla P_TeleportMove (the
 * debug warp, §7) deliberately PRESERVES momentum, but each scripted
 * segment below starts a curve from rest — so the test explicitly zeroes
 * the residual mom through the §7 live-state read handle after warping.
 * (Test-hygiene write only; the movement under test is never touched.)
 */
function warpRest(page: Page, x: number, y: number, deg: number): Promise<void> {
  return page.evaluate(
    (v: { x: number; y: number; d: number }) => {
      window.__doom!.warp(v.x, v.y, undefined, v.d);
      const p = window.__doom!.sim.getState()!.players[0]!;
      p.mo.momx = 0;
      p.mo.momy = 0;
    },
    { x, y, d: deg }
  );
}

/** g_game.c turn chain for one tic: raw dx → sensitivity scale (mouseSensi-
 * tivity 5 ⇒ (5+5)/10 = identity, Math.trunc) → `angleturn -= mousex*0x8`
 * → P_MovePlayer `angle += angleturn << 16`. */
function mouseTurnBam(dx: number): number {
  const scaled = Math.trunc((dx * (5 + 5)) / 10);
  return ((-scaled * 8) << 16) >>> 0;
}

/* ------------------------------------------------------------------ */
/* Tests                                                                */
/* ------------------------------------------------------------------ */

test.describe('live physics (M5-08)', () => {
  test('real KeyW walk: derived curve, decay to stop, ≥300 units, canvas moves', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const errors = trackConsole(page);
    await boot(page);

    // Rest at spawn: reactiontime 0 (MT_PLAYER mobjinfo), mom 0.
    const rest = await snap(page);
    expect(rest.momx).toBe(0);
    expect(rest.reactiontime).toBe(0);

    // REAL keyboard channel: page.keyboard → DOM keydown → input/keyboard
    // held set → G_BuildTiccmd poll once per tic. Flush the dispatch
    // through one rAF while the sim stays PAUSED, so every tic of the
    // window below sees the key held (no down/first-tic boundary race).
    await page.keyboard.down('KeyW');
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));

    const a = await runTo(page, rest.leveltime); // resolves without a tic
    expect(a.leveltime).toBe(rest.leveltime);
    expect(a.momx, 'window starts from rest with the key already held').toBe(0);

    const b = await runTo(page, a.leveltime + 40);
    expect(b.leveltime - a.leveltime).toBe(40);
    await page.keyboard.up('KeyW');

    // (1) 40 held tics from rest == the re-derived curve, EXACT.
    expect(b.x - a.x, 'walk-40 delta vs deriveDist(40,40)').toBe(deriveDist(40, 40));
    expect(deriveDist(40, 40), 'curve dual-pin literal').toBe(16668490);
    // East corridor: no wall; y leak = FixedMul(thrust, finesine[0]=25)
    // per tic stays sub-quantum — the route is straight.
    expect(Math.abs(b.y - a.y), 'y drift on the east route').toBeLessThan(2 * FRACUNIT);

    // (2) Release: friction decay to the hard stop, still exact; then no
    // creep at all.
    const c = await runTo(page, b.leveltime + 100);
    expect(c.x - a.x, 'walk40+coast100 vs derivation').toBe(deriveDist(40, 140));
    expect(deriveDist(40, 140), 'total dual-pin literal').toBe(21806783);
    const d = await runTo(page, c.leveltime + 20);
    expect(d.x, 'stopped: zero further creep').toBe(c.x);

    // (3) ≥300 units of travel from spawn along the corridor.
    expect(c.x - rest.x, 'total travel from spawn ≥ 300 units').toBeGreaterThanOrEqual(300 * FRACUNIT);

    // (4) The canvas followed the player; counters healthy from the moved
    // position (walls sanity at a non-spawn viewpoint).
    await page.waitForTimeout(120);
    const shaWalk = await captureSha(page);
    await page.evaluate(() => {
      const s = window.__doom!.state();
      if (!s.ready) throw new Error('state not ready');
      window.__doom!.warp(s.player.x, s.player.y, undefined, 0); // same pos, fresh capture baseline
    });
    await page.waitForTimeout(120);
    const shaSame = await captureSha(page);
    expect(shaSame, 'warp-to-same-position reproves determinism').toBe(shaWalk);
    await page.evaluate(() => window.__doom!.warp(-416 * 65536, 256 * 65536, undefined, 0));
    await page.waitForTimeout(120);
    const shaSpawn = await captureSha(page);
    expect(shaWalk, 'walking 330+ units MUST change the frame').not.toBe(shaSpawn);
    expect(
      await page.evaluate(() => {
        const s = window.__doom!.state();
        // B-07/B-08: state().render also carries the sprite-pass
        // fingerprint object; this assertion's contract is the 5 counters.
        if (!s.ready) return null;
        const { sprites, ...counters } = s.render;
        void sprites;
        return counters;
      }),
      'render counters live and 0 along the route'
    ).toEqual({ hom: 0, visplaneOverflow: 0, visspriteOverflow: 0, openingOverflow: 0, drawsegOverflow: 0 });

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('bob: walking viewz wave with differing captures; standing byte-equal', async ({ page }) => {
    test.setTimeout(120_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const errors = trackConsole(page);
    await boot(page);
    await page.evaluate(() => {
      window.__doom!.warp(-416 * 65536, 256 * 65536, undefined, 0);
      window.__doom!.pause(true);
    });

    // Settle 40 forward tics (full walking momentum), then walk one tic at
    // a time for 24 tics, capturing the SCREEN per tic (2 rAFs ⇒ the
    // current sim state is painted; sim stays paused between steps).
    await page.evaluate(() => window.__doom!.sim.runTics(40, { forward: true }));
    const rows = await page.evaluate(() =>
      new Promise<{ lt: number; viewz: number; bob: number; sha: string }[]>(async (resolve) => {
        const api = window.__doom!;
        const out: { lt: number; viewz: number; bob: number; sha: string }[] = [];
        for (let i = 0; i < 24; i++) {
          api.sim.runTics(1, { forward: true });
          await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
          const cap = api.capture();
          const digest = await crypto.subtle.digest('SHA-256', cap.indices.slice().buffer as ArrayBuffer);
          const st = api.sim.getState()!;
          out.push({
            lt: st.leveltime,
            viewz: st.players[0]!.viewz,
            bob: st.players[0]!.bob,
            sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
          });
        }
        resolve(out);
      })
    );
    const z0 = await page.evaluate(() => window.__doom!.sim.getState()!.players[0]!.mo.z);
    const base = z0 + VIEW_OFFSET; // standing eye height == render placeholder

    // P_CalcHeight wave LIVE: bob capped at MAXBOB walking, viewz swings a
    // ±(bob/2)·finesine wave around z + 41<<16, and the frames at the wave
    // crest vs trough are DIFFERENT captures — the bob is on screen (the
    // viewz read-through is wired), not just sim-side.
    expect(Math.max(...rows.map((r) => r.bob)), 'bob reaches MAXBOB walking').toBe(MAXBOB);
    const vmax = Math.max(...rows.map((r) => r.viewz));
    const vmin = Math.min(...rows.map((r) => r.viewz));
    // Wave amplitude is bob/2 = 4·FRACUNIT = 8 px (MAXBOB/2, p_user.c);
    // 24 consecutive samples of the ≈20-tic wave always land within ~1°
    // of both extremes.
    expect(vmax - base, 'crest above standing eye (>4.5 px)').toBeGreaterThan(300_000);
    expect(base - vmin, 'trough below standing eye (>4.5 px)').toBeGreaterThan(300_000);
    expect(vmax - vmin, 'peak-to-peak > 9 px').toBeGreaterThan(600_000);
    expect(Math.max(...rows.map((r) => Math.abs(r.viewz - base))), 'wave within MAXBOB/2 = 8 px').toBeLessThanOrEqual(MAXBOB / 2);
    const iMax = rows.findIndex((r) => r.viewz === vmax);
    const iMin = rows.findIndex((r) => r.viewz === vmin);
    expect(rows[iMax]!.sha, 'crest vs trough captures differ mid-walk').not.toBe(rows[iMin]!.sha);
    // tic-offset pair (Δtic = 8): mid-walk captures differ.
    expect(rows[0]!.sha, 'two captures Δtic=8 apart mid-walk differ').not.toBe(rows[8]!.sha);
    expect(rows[23]!.lt - rows[0]!.lt, 'all samples are consecutive mid-walk tics').toBe(23);

    // Standing still (the byte-equality half): viewz EXACTLY the old
    // placeholder z + 41·FRACUNIT, bob 0, and two captures 150 ms / ≥8
    // render frames apart byte-equal — the read-through moved NOTHING for
    // a resting player, so frame-0/warp goldens stay put.
    await page.evaluate(() => window.__doom!.sim.runTics(60, { forward: false }));
    const still = await snap(page);
    expect(still.momx, 'coasted to a full stop').toBe(0);
    expect(still.viewz, 'standing viewz == z + 41·FRACUNIT').toBe(still.z + VIEW_OFFSET);
    expect(still.bob, 'standing bob == 0').toBe(0);
    await page.waitForTimeout(150);
    const s1 = await captureSha(page);
    await page.waitForTimeout(150);
    const s2 = await captureSha(page);
    expect(s2, 'standing captures are byte-equal').toBe(s1);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('mouse: injected ev_mouse turn/move == sensitivity math ±0, consumed once', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const errors = trackConsole(page);
    await boot(page);
    await page.evaluate(() => window.__doom!.pause(true));

    // (1) turn right: injectMouse(+37,0) over exactly ONE tic ⇒
    // Δangle == (-37*8)<<16 BAM, bit-exact (odd dx pins truncation-free
    // sensitivity: (37*(5+5))/10 = 37).
    const a0 = await snap(page);
    expect(a0.angle).toBe(0); // spawn faces east
    await page.evaluate(() => window.__doom!.sim.injectMouse(37, 0));
    const a1 = await runTo(page, a0.leveltime + 1);
    expect(bamDelta(a0.angle, a1.angle), 'mouse-x turn BAM delta (dx=37)').toBe(mouseTurnBam(37));

    // (2) mouse-y == FORWARD (1.10: `forward += mousey`, NO pitch): one
    // kick tic from rest moves x by FixedMul(-50*2048, finecosine[0])
    // (move happens BEFORE the friction fold), y by the half-tap leak.
    await warpRest(page, -416 * 65536, 256 * 65536, 0);
    const b0 = await snap(page);
    await page.evaluate(() => window.__doom!.sim.injectMouse(0, -50));
    const b1 = await runTo(page, b0.leveltime + 1);
    expect(b1.x - b0.x, 'mousey(-50) one-tic x delta == one thrust step').toBe(
      fixedMul(-50 * 2048, COS_FINE0)
    );
    expect(b1.y - b0.y, 'y == FixedMul(thrust, finesine[0])').toBe(fixedMul(-50 * 2048, SINE_FINE0));

    // (3) consumed-once (g_game.c:411): a +50 kick then ONE more tic with no
    // new event — the second step is the FRICTION-decayed momentum only,
    // never a repeated kick.
    await warpRest(page, -416 * 65536, 256 * 65536, 0);
    const c0 = await snap(page);
    await page.evaluate(() => window.__doom!.sim.injectMouse(0, 50));
    const c1 = await runTo(page, c0.leveltime + 1);
    const kick = fixedMul(50 * 2048, COS_FINE0);
    expect(c1.x - c0.x, 'forward kick == +thrust').toBe(kick);
    const c2 = await runTo(page, c1.leveltime + 1);
    expect(c2.x - c1.x, 'next tic: friction decay only — no double-apply').toBe(fixedMul(kick, FRICTION));

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('pointer-lock wiring live: click→requestPointerLock, lock-gated mousemove, unlock drops deltas', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const errors = trackConsole(page);
    await boot(page);
    await page.evaluate(() => {
      window.__doom!.pause(true);
      // requestPointerLock spy: main.ts's canvas click handler must call
      // it; the spy keeps headless lock acquisition out of the test.
      (window as unknown as { __lockCalls: number }).__lockCalls = 0;
      const canvas = document.getElementById('game') as HTMLCanvasElement;
      canvas.requestPointerLock = () => {
        const w = window as unknown as { __lockCalls: number };
        w.__lockCalls += 1;
        return Promise.resolve();
      };
      // Fakeable lock state driving the pointerlockchange MIRROR — the
      // browser fires that very event on the native Esc release, so
      // dispatching it with the element removed models Esc (plan §6,
      // documented L4 substitution through the production handler).
      (window as unknown as { __fakeLock: boolean }).__fakeLock = false;
      Object.defineProperty(document, 'pointerLockElement', {
        configurable: true,
        get: () =>
          ((window as unknown as { __fakeLock: boolean }).__fakeLock
            ? document.getElementById('game')
            : null) as Element | null
      });
    });

    // (1) canvas click → requestPointerLock was called (live wiring).
    await page.click('#game', { timeout: 5_000 }).catch(() => undefined);
    const calls = await page.evaluate(() => (window as unknown as { __lockCalls: number }).__lockCalls);
    expect(calls, 'canvas click must request the pointer lock').toBeGreaterThanOrEqual(1);

    // (2) LOCKED mousemove.movementX through main.ts's attach → exact turn
    // (real DOM events — NO injectMouse in this test).
    const a0 = await snap(page);
    await page.evaluate(() => {
      (window as unknown as { __fakeLock: boolean }).__fakeLock = true;
      document.dispatchEvent(new Event('pointerlockchange'));
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 64, movementY: 0, bubbles: true }));
    });
    const a1 = await runTo(page, a0.leveltime + 1);
    expect(bamDelta(a0.angle, a1.angle), 'locked mousemove turn == sensitivity math').toBe(mouseTurnBam(64));

    // (3) unlocked ("Esc"): pointerlockchange→null, then mousemoves are
    // dropped — zero turn over the next two tics.
    const mid = await page.evaluate(() => {
      (window as unknown as { __fakeLock: boolean }).__fakeLock = false;
      document.dispatchEvent(new Event('pointerlockchange'));
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: 100, movementY: 30, bubbles: true }));
      return window.__doom!.sim.getState()!.players[0]!.mo.angle >>> 0;
    });
    expect(mid, 'unlock alone must not touch the angle').toBe(a1.angle);
    const a3 = await runTo(page, a1.leveltime + 2);
    expect(a3.angle, 'unlocked deltas never reach the tic').toBe(a1.angle);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('noclip regression: wall flush vs same-curve pass-through (D012)', async ({ page }) => {
    test.setTimeout(90_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const errors = trackConsole(page);
    await boot(page);

    // Scripted (runTics while paused) so both runs consume identical tic
    // streams: warp west-facing at spawn, 40 forward tics.
    const goWest = (noclip: boolean): Promise<number> =>
      page.evaluate(
        (nc: boolean) => {
          const api = window.__doom!;
          api.pause(true);
          api.noclip(nc);
          api.warp(-416 * 65536, 256 * 65536, undefined, 180);
          const st = api.sim.getState()!;
          // teleport preserves momentum (faithful) — isolate the segment.
          st.players[0]!.mo.momx = 0;
          st.players[0]!.mo.momy = 0;
          const x0 = st.players[0]!.mo.x;
          api.sim.runTics(40, { forward: true });
          return st.players[0]!.mo.x - x0;
        },
        noclip
      );

    const blocked = await goWest(false);
    expect(blocked, 'clipped west: flushed against the wall (dual-pinned)').toBe(-5241503);
    expect(blocked, '≈80 units of wall').toBeGreaterThan(-100 * FRACUNIT);

    const passed = await goWest(true);
    expect(
      await page.evaluate(() => (window.__doom!.noclip() ? 1 : 0)),
      'noclip flag live'
    ).toBe(1);
    expect(passed, 'noclip west passes the SAME wall (dual-pinned)').toBe(-16317626);
    expect(passed, 'through — ≥3× the clipped distance').toBeLessThan(3 * blocked);

    // D012 identity on open ground (east): clip vs noclip run the SAME
    // thrust/friction curve byte-for-byte — 40 held + 100 coast tics.
    const stream = (noclip: boolean): Promise<number> =>
      page.evaluate(
        (nc: boolean) => {
          const api = window.__doom!;
          api.noclip(nc);
          api.warp(-416 * 65536, 256 * 65536, undefined, 0);
          const st = api.sim.getState()!;
          st.players[0]!.mo.momx = 0;
          st.players[0]!.mo.momy = 0;
          const x0 = st.players[0]!.mo.x;
          api.sim.runTics(40, { forward: true });
          api.sim.runTics(100, { forward: false });
          return st.players[0]!.mo.x - x0;
        },
        noclip
      );
    const noclipTotal = await stream(true);
    const clipTotal = await stream(false);
    expect(noclipTotal, 'noclip == clipped momentum on open ground (D012)').toBe(clipTotal);
    expect(clipTotal, 'and that is the re-derived curve').toBe(deriveDist(40, 140));

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('determinism: identical scripted stream on two page loads ⇒ identical hash incl. viewz/bob', async ({ page, browser }) => {
    test.setTimeout(120_000);
    const p2 = await browser.newPage();
    try {
      test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
      const errors = trackConsole(page);
      const errors2 = trackConsole(p2);

      // Both pages boot independently; the in-page watcher parks each at
      // EXACTLY leveltime 40 (boot jitter stays out — the watcher catches
      // the first frame ≥ 40 and pauses).
      const prep = async (p: Page): Promise<number> => {
        await boot(p);
        const s = await runTo(p, 40);
        expect(s.leveltime).toBe(40);
        return p.evaluate(() => {
          const api = window.__doom!;
          api.warp(-416 * 65536, 256 * 65536, undefined, 0);
          api.sim.runTics(35, { forward: true }); // walk segment (bob live)
          api.sim.runTics(1, { mouseX: 100 }); // + one mouse-turn tic
          const s = api.state();
          if (!s.ready) throw new Error('state not ready');
          return s.hash;
        });
      };
      const h1 = await prep(page);
      const h2 = await prep(p2);
      expect(h2, 'same stream, two boots ⇒ identical hashState (physics+viewz+bob hashed)').toBe(h1);

      const views = await Promise.all([
        page.evaluate(() => {
          const s = window.__doom!.state();
          return s.ready ? { viewz: s.player.viewz, bob: s.player.bob } : null;
        }),
        p2.evaluate(() => {
          const s = window.__doom!.state();
          return s.ready ? { viewz: s.player.viewz, bob: s.player.bob } : null;
        })
      ]);
      expect(views[1]).toEqual(views[0]);
      expect(views[0], 'viewz read-out live on the §7 snapshot').not.toBeNull();

      expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
      expect(errors2, `console errors: ${errors2.join(' | ')}`).toEqual([]);
    } finally {
      await p2.close();
    }
  });
});
