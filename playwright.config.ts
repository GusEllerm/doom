// SPDX-License-Identifier: GPL-2.0-or-later
import { defineConfig } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:5173';

// M12-08 (plan §M12-08, D-12e): CI stays chromium. The multi-engine projects
// below are opt-in EXPERIMENTS, never part of the default `npm run e2e` run:
//   PW_EXTRA_BROWSERS=firefox  npx playwright test   # firefox smoke, if installed
//   PW_EXTRA_BROWSERS=firefox,webkit  npx playwright test
// Only LIST engines you have already installed (`npx playwright install
// firefox` / `… webkit`) — these are big downloads this project deliberately
// never pulls in CI or on a plain `npm ci` (D-12e: "multi-engine CI triples
// wall-time for near-zero signal"). Each added project runs the SMOKE subset
// only (below) and is documented non-blocking in docs/reports/M12-browser-matrix.md.
const EXTRA_ENGINES = ['firefox', 'webkit'] as const;
type ExtraEngine = (typeof EXTRA_ENGINES)[number];
const extraBrowsers: ExtraEngine[] = (process.env.PW_EXTRA_BROWSERS ?? '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter((s): s is ExtraEngine => (EXTRA_ENGINES as readonly string[]).includes(s));

// Smoke subset: canvas.spec.ts = boot/titlepic render + zero-console-errors +
// debug-seam presence (the raw engine surface); lifts.spec.ts = one
// playstart-entered PLAY check (world ticks + canvas state) per engine.
// Everything heavier (audio flags, build project, soak, perf budgets) is
// chromium-pinned by design and excluded here.
const EXTRA_SMOKE = /(canvas|lifts)\.spec\.ts/;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    headless: true
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
      // M12-06: the production-build spec is the `build` project's only
      // member — it runs vite build/preview inside the spec (Playwright
      // 1.63 has no project-level webServer; a second ROOT webServer would
      // build on every chromium run, disturbing them). Excluded here so
      // the catch-all project doesn't double-run it against the dev server.
      testIgnore: /build\.spec\.ts/
    },
    {
      // M10-11 (plan §M10-11): the UNMUTED audio profile. Deliberately NOT
      // added to the default project: the pre-M10 suites' contract is the
      // muted/boot-silent regression (m10-audio.spec.ts runs that half
      // under `chromium`). Flags, per the plan's "unmuted … audio actually
      // runs headless-chromium — null sink keeps it real-but-unheard":
      //   * --autoplay-policy=user-gesture-required — the REAL browser
      //     autoplay gate, pinned (Chromium CI defaults drift toward
      //     allowing autoplay; NOTE the singular 'gesture' — a wrong enum
      //     value hard-fails chromium startup).
      //   * mute truth (measured this task): Playwright's headless launch
      //     appends --mute-audio UNCONDITIONALLY and it is a presence-only
      //     switch, so project args can neither pass "unmute" nor cancel
      //     it. It is acoustically identical to the plan's null sink — the
      //     AudioContext runs REAL (nodes created/started, synth pumps;
      //     m10-10's green census proves it); nothing merely *scheduled*
      //     would survive — only the speakers stay silent. What the audio
      //     project genuinely UNMUTES against is the muted-BOOT profile
      //     (gesture-gated master gain), which is the regression the
      //     chromium project protects.
      // testMatch: only the audio spec (its unmuted tests self-gate on
      // project name; the muted half skips here — see the spec header).
      name: 'audio',
      use: {
        browserName: 'chromium',
        launchOptions: {
          args: ['--autoplay-policy=user-gesture-required']
        }
      },
      testMatch: /m10-audio\.spec\.ts/
    },
    {
      // M12-06 (plan §M12-06): production-build e2e — `vite build` +
      // `vite preview` booted INSIDE the spec (see e2e/build.spec.ts header
      // for why not a webServer entry); the root dev webServer is unused by
      // this project (every navigation is an absolute preview URL).
      name: 'build',
      use: { browserName: 'chromium' },
      testMatch: /build\.spec\.ts/
    },
    // M12-08 experimental engines (see header): absent from the array unless
    // PW_EXTRA_BROWSERS names them, so the default project list — and every
    // CI wall-clock — is unchanged.
    ...extraBrowsers.map((engine) => ({
      name: `experimental-${engine}`,
      use: { browserName: engine },
      testMatch: EXTRA_SMOKE,
      retries: 1 as const // experimental: flaky-by-honesty, never blocking
    }))
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000
  }
});
