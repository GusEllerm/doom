/**
 * M5-10 — ROADMAP M5 exit verification (mechanical checklist; docs-free).
 *
 * Asserts the M5 exit lines of ROADMAP.md as machine-checkable facts about
 * THIS repo — pragmatic guards, not re-implementations: every check either
 * (a) imports a config constant and pins its value, (b) asserts the
 * relevant evidence file exists AND participates in this very run (a red
 * suite fails `npm run check`, so "exists + green" is carried by the run
 * itself — the comment in each test says who carries the green), or
 * (c) greps a committed test NAME so deleting/renaming the evidence trips.
 *
 * §M5-10 exit checklist mapped:
 *  1. 35 Hz accumulator stepping constant (M5-01)      → TICRATE import +
 *     main.ts `1000 / TICS_PER_SECOND` wiring + game.test.ts name guard.
 *  2. scripted goldens suite present (M5-09/L2)        → feel suite file
 *     exists + ≥10 scenarios + the physics/puser suites exist and run.
 *  3. noclip momentum parity (D012, M5-06/09)          → test NAME exists
 *     in feel.test.ts / puser.test.ts / e2e physics spec.
 *  4. mouse sensitivity exactness (M5-05/08, L4)       → exactness test
 *     NAMES exist in src/input/mouse.test.ts + e2e physics spec.
 *  5. motion evidence (this task)                     → motion goldens +
 *     suite pass in this run.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TICRATE } from '../../src/core/constants';
import { TICS_PER_SECOND } from '../../src/sim/game';

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/** Run a vitest suite in-process-equivalent: the `vitest list` of it (name
 * extraction) plus THIS run's own result carries green. */
function read(p: string): string {
  return readFileSync(at(p), 'utf8');
}

describe('M5 exit checklist 1 — 35 Hz accumulator stepping', () => {
  it('TICRATE/TICS_PER_SECOND are exactly 35', () => {
    expect(TICRATE).toBe(35);
    expect(TICS_PER_SECOND).toBe(TICRATE);
  });
  it('main.ts steps the sim on a 1000/TICS_PER_SECOND accumulator (max 4 catch-up)', () => {
    const main = read('../../src/main.ts');
    expect(main).toContain('const TIC_MS = 1000 / TICS_PER_SECOND;');
    expect(main).toMatch(/while \([^)]*accumulator >= TIC_MS[^)]*MAX_CATCHUP_TICS/);
  });
  it('a named 35 Hz test exists in the loop suite (green carried by this run)', () => {
    // The suite itself runs (and must be green) in the same `vitest run`
    // that runs THIS file — name-existence here only guards deletions.
    expect(read('../../src/sim/game.test.ts')).toContain("it('runs at 35 Hz");
  });
});

describe('M5 exit checklist 2 — scripted-tic goldens suites present (L2)', () => {
  it('feel suite exists with >= 10 scenarios', () => {
    const feel = read('../sim/feel.test.ts');
    expect(existsSync(at('../sim/feel.test.ts'))).toBe(true);
    expect([...feel.matchAll(/^describe\('feel-/gm)].length).toBeGreaterThanOrEqual(10);
    // every scenario file is dual-run deterministic (M5-09 acceptance 3)
    expect(feel).toContain('runHeadlessDoubleRun');
  });
  it('physics (movement) + puser suites exist and are non-trivial', () => {
    // green is carried by this run: both files match the vitest include.
    const movement = read('../headless/movement.test.ts');
    const puser = read('../../src/sim/puser.test.ts');
    expect(movement).toContain('D009 fly stub is GONE'); // M5-06 physics-ON pin
    expect([...puser.matchAll(/\bit\(/g)].length).toBeGreaterThanOrEqual(15);
    expect([...movement.matchAll(/\bit\(/g)].length).toBeGreaterThanOrEqual(10);
  });
});

describe('M5 exit checklist 3 — noclip momentum parity (D012)', () => {
  it('noclip parity test NAMES exist (feel + puser + e2e)', () => {
    expect(read('../sim/feel.test.ts')).toContain("describe('feel-10 noclip momentum parity (D012)'");
    expect(read('../../src/sim/puser.test.ts')).toContain('noclip keeps the SAME curve');
    expect(read('../../e2e/physics.spec.ts')).toContain('noclip regression: wall flush vs same-curve pass-through');
  });
});

describe('M5 exit checklist 4 — mouse sensitivity exactness', () => {
  it('unit-level exactness test NAMES exist (mouse.test.ts)', () => {
    const m = read('../../src/input/mouse.test.ts');
    expect(m).toContain('default sensitivity 5 ⇒ identity');
    expect(m).toContain('sum BEFORE scaling'); // accumulation-before-scale exactness
  });
  it('browser-level exactness test NAME exists (e2e physics spec)', () => {
    expect(read('../../e2e/physics.spec.ts')).toContain('== sensitivity math ±0');
  });
});

describe('M5 exit checklist 5 — L5 motion evidence + gates wired', () => {
  it('motion goldens + meta exist (reason: M5-10 motion evidence)', () => {
    const meta = JSON.parse(read('../render/goldens/motion/meta.json')) as {
      scenes: Record<string, { reason: string; png: string; frames?: unknown[] }>;
    };
    const scenes = Object.values(meta.scenes);
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    for (const s of scenes) {
      expect(s.reason).toBe('M5-10 motion evidence');
      expect(existsSync(at(`../render/goldens/motion/${s.png}`))).toBe(true);
      expect((s.frames ?? []).length).toBeGreaterThanOrEqual(8);
    }
    // The strip suite passes IN THIS RUN (sha assert in motion.test.ts);
    // an extra independent spawn guards against file-ordering luck. The
    // spawn writes its review copies to a distinct dir so the two runs
    // never touch the same output file concurrently.
    const out = spawnSync(
      process.execPath,
      [at('../../node_modules/vitest/vitest.mjs'), 'run', 'tests/render/motion.test.ts'],
      {
        cwd: at('../..'),
        encoding: 'utf8',
        timeout: 240_000,
        env: { ...process.env, MOTION_RESULTS_DIR: 'test-results/motion-strip-exitcheck' }
      }
    );
    expect(out.status, out.stdout + out.stderr).toBe(0);
  });
});
