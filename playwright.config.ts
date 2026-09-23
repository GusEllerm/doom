import { defineConfig } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:5173';

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
    }
  ],
  webServer: {
    command: 'npm run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000
  }
});
