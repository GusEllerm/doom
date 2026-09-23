/**
 * M12-06 (plan §M12-06b): PRODUCTION-BUILD e2e — runs the REAL release
 * surface end to end: `vite build` then `vite preview`, then boots the game
 * over the PREVIEW server (never the dev server — every navigation here is
 * an absolute preview URL).
 *
 * Why build/preview run INSIDE the spec and not via a webServer entry:
 * Playwright 1.63 has no PROJECT-level webServer (only testConfig-level),
 * and a second root-level webServer would start (and build) for EVERY
 * project — disturbing the untouched chromium+audio runs, which the plan
 * forbids. So the build is this project's own business: spawned via
 * node_modules/vite/bin/vite.js (the very binaries `npm run build`/`npm run
 * preview` run), the port parsed from vite's own banner (4173 per
 * vite.config unless busy), killed in afterAll.
 *
 * Contract asserted (plan §M12-06):
 *  - dist ships the GAME ONLY: index.html + its chunks; no viewer.html, no
 *    viewer-*.js, no source maps (vite's sourcemap default folded off here
 *    — pinned as a CONTENTS assertion, immune to config drift);
 *  - the serveWads middleware DOES run under `vite preview`
 *    (configurePreviewServer — verified): /wads/freedoom1.wad → 200 over the
 *    preview server, so the shipped page boots E1M1 playable with NO static
 *    wad copy into dist (a static deploy still needs the wad served at
 *    /wads — that's §0.6 README truth, not this spec's subject);
 *  - seam leakage: window.__doom is ABSENT without ?test=1 and present WITH
 *    it (debug.ts gates on import.meta.env.DEV || ?test — DEV folds to false
 *    in the build; the no-flag half additionally proves the boot itself is
 *    seam-free: the title screen renders with no debug API anywhere);
 *  - zero console.error / pageerror on both halves;
 *  - bundle budget MEASURED then PINNED (D-12a). Measured at pin time
 *    (2025-09-23, this tree): dist/assets/main-*.js — the ONLY JS in dist —
 *    raw 542,951 B, gzip 181,516 B (vite reporter: 184.42 kB). Cap pinned
 *    at the plan's D-12a proposal: TOTAL gzipped JS in dist ≤ 500,000 B
 *    (≈2.7× the measured value — a regression tripwire, not a
 *    tuned-to-pass ratchet).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { enterPlay } from './playstart';

const ROOT = process.cwd(); // playwright launches from the repo root
const DIST = join(ROOT, 'dist');
const VITE_BIN = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

/** D-12a pinned cap: total gzipped JS shipped in dist (measured 181,516 B
 * at pin time — see header). Hard cap, not a budget to fill. */
const JS_GZIP_CAP = 500_000;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Run the real `vite preview`, resolve once its URL answers 200. */
async function startPreview(): Promise<{ proc: ChildProcess; url: string }> {
  const proc = spawn(process.execPath, [VITE_BIN, 'preview'], { cwd: ROOT, stdio: 'pipe' });
  let banner = '';
  // vite underlines URLs with ANSI styling even on pipes — strip escapes so
  // the port regex can match the plain text.
  const collected = (d: Buffer) => (banner += String(d).replace(/\u001b\[[0-9;]*m/g, ''));
  proc.stdout.on('data', collected);
  proc.stderr.on('data', collected);
  const url = await new Promise<string>((res, rej) => {
    const t = setTimeout(() => rej(new Error(`vite preview banner never showed a URL: ${banner}`)), 20_000);
    const poll = () => {
      const m = /https?:\/\/[\d.]+:\d+/.exec(banner);
      if (m) {
        clearTimeout(t);
        res(m[0]);
        return;
      }
      setTimeout(poll, 50);
    };
    poll();
    proc.once('exit', (c) => rej(new Error(`vite preview exited (${String(c)}): ${banner}`)));
  });
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${url}/`)).ok) return { proc, url };
    } catch {
      /* port not listening yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  proc.kill();
  throw new Error(`vite preview at ${url} never answered 200`);
}

test.describe('production build over vite preview', () => {
  let server: { proc: ChildProcess; url: string } | null = null;

  test.beforeAll(async () => {
    // The real build (`npm run build` is exactly `vite build`).
    execFileSync(process.execPath, [VITE_BIN, 'build'], { cwd: ROOT, stdio: 'pipe' });
    server = await startPreview();
  });

  test.afterAll(() => {
    server?.proc.kill();
    server = null;
  });

  const previewUrl = (): string => {
    if (server === null) throw new Error('preview server not started');
    return server.url;
  };

  test('dist ships the game only — no viewer, no source maps', () => {
    expect(existsSync(join(DIST, 'index.html')), 'dist/index.html shipped').toBe(true);
    const files = walk(DIST);
    expect(files.some((f) => f.endsWith('.js')), 'at least one JS chunk shipped').toBe(true);
    for (const f of files) {
      const rel = f.slice(DIST.length + 1);
      expect(rel, `dist must not ship the dev-only viewer (${rel})`).not.toMatch(/viewer/i);
      expect(rel, `dist must not ship source maps (${rel})`).not.toMatch(/\.map$/);
    }
  });

  test('bundle size within the pinned budget (D-12a)', () => {
    let totalGzip = 0;
    const rows: string[] = [];
    for (const f of walk(DIST).filter((x) => x.endsWith('.js'))) {
      const gz = gzipSync(readFileSync(f)).length;
      totalGzip += gz;
      rows.push(`${f.slice(DIST.length + 1)}: raw ${String(statSync(f).size)} B, gzip ${String(gz)} B`);
    }
    console.log(`[M12-06] dist JS (cap ${String(JS_GZIP_CAP)} B gzip):\n${rows.join('\n')}`);
    expect(totalGzip, `total gzipped JS ${String(totalGzip)} B > cap ${String(JS_GZIP_CAP)} B`).toBeLessThanOrEqual(
      JS_GZIP_CAP
    );
  });

  test('boots to a playable E1M1 over preview; __doom present WITH ?test=1', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`${previewUrl()}/?test=1`);
    // serveWads under preview (configurePreviewServer): the WAD rides the
    // PREVIEW server — asserted directly (plan: "runs there — asserted").
    const wadStatus = await page.evaluate(async () => (await fetch('/wads/freedoom1.wad')).status);
    expect(wadStatus, '/wads/freedoom1.wad over vite preview').toBe(200);

    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
    expect(await page.evaluate(() => typeof window.__doom), '__doom WITH ?test=1').toBe('object');

    // Playable: deterministic new-game drain on E1M1 (shared e2e helper),
    // then 35 scripted tics on the BUILT page — exact delta 35 (the live
    // loop's wall-clock tics between calls are accounted by parking it
    // first, never pinned).
    await enterPlay(page);
    const st = await page.evaluate(() => {
      window.__doom!.pause(true); // park the live stepper — account every tic
      const before = (window.__doom!.state() as unknown as { leveltime: number }).leveltime;
      window.__doom!.sim.runTics(35);
      const s = window.__doom!.state();
      return {
        ready: s.ready,
        map: (s as unknown as { map?: string }).map ?? null,
        tics: (s as unknown as { leveltime: number }).leveltime - before
      };
    });
    expect(st).toEqual({ ready: true, map: 'E1M1', tics: 35 });
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });

  test('production page (no ?test=1): __doom ABSENT, boots clean', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`${previewUrl()}/`);
    // No seam means no state probe — the honest liveness check is PIXELS:
    // the title screen (TITLEPIC from the preview-served wad) replaces the
    // black canvas. Proves the FULL production boot (fetch → parse → render)
    // ran with no debug API installed.
    await page
      .waitForFunction(
        () => {
          const c = document.querySelector('canvas');
          if (!(c instanceof HTMLCanvasElement)) return false;
          const d = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
          if (!d) return false;
          const seen = new Set<string>();
          for (let i = 0; i < d.length; i += 4 * 97) {
            seen.add(`${String(d[i])},${String(d[i + 1])},${String(d[i + 2])}`);
            if (seen.size > 1) return true;
          }
          return false;
        },
        null,
        { timeout: 45_000 }
      )
      .catch(() => {
        throw new Error(
          `canvas stayed blank — production boot over preview did not render; errors: ${errors.join(' | ')}`
        );
      });
    expect(await page.evaluate(() => typeof window.__doom), '__doom WITHOUT ?test=1').toBe('undefined');
    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
