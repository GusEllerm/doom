// Playwright-driven playtest harness.
//
// Boots `vite preview` in a child process, opens the game in headless Chromium
// with ?headless=1, runs scenario scripts, and writes a JSON report.
//
// Run: npm run playtest
// Or:  npx tsx playtest/harness.ts

import { chromium, type Browser, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios, type ScenarioResult } from './scenarios';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, 'results');
const PORT = 5174;
const URL = `http://127.0.0.1:${PORT}/?headless=1`;

async function waitForServer(url: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server at ${url} did not start within ${timeoutMs}ms`);
}

function startPreview(): ChildProcess {
  const proc = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  return proc;
}

async function runAll(): Promise<ScenarioResult[]> {
  mkdirSync(RESULTS_DIR, { recursive: true });
  // 1. Build the project (preview serves dist/).
  await new Promise<void>((resolve, reject) => {
    const b = spawn('npx', ['vite', 'build'], { cwd: join(__dirname, '..'), stdio: 'inherit' });
    b.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`vite build exited ${code}`)));
  });

  const preview = startPreview();
  let browser: Browser | null = null;
  const results: ScenarioResult[] = [];
  try {
    await waitForServer(URL);
    browser = await chromium.launch({ headless: true });

    for (const scenario of scenarios) {
      const context = await browser.newContext({ viewport: { width: 800, height: 500 } });
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

      const tStart = Date.now();
      let result: ScenarioResult;
      try {
        await page.goto(URL, { waitUntil: 'networkidle' });
        // Wait for game boot
        await page.waitForFunction(() => !!(window as any).__game);
        // Run scenario
        result = await scenario.run(page);
        if (consoleErrors.length > 0 && result.ok) {
          result = {
            ...result,
            ok: false,
            error: `console errors: ${consoleErrors.join(' | ')}`,
          };
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const screenshotPath = join(RESULTS_DIR, `${scenario.name}.fail.png`);
        try { await page.screenshot({ path: screenshotPath }); } catch { /* */ }
        result = { name: scenario.name, ok: false, error: msg, screenshot: screenshotPath };
      }
      result.durationMs = Date.now() - tStart;
      if (consoleErrors.length > 0) result.consoleErrors = consoleErrors;
      results.push(result);
      console.log(`[${result.ok ? 'PASS' : 'FAIL'}] ${scenario.name}  (${result.durationMs}ms)${result.error ? '  — ' + result.error : ''}`);
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    preview.kill();
  }
  return results;
}

(async () => {
  const results = await runAll();
  writeFileSync(join(RESULTS_DIR, 'report.json'), JSON.stringify(results, null, 2));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(2); });
