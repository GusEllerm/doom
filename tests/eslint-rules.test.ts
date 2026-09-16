/**
 * Green/red self-test for the A-INT1 import-boundary zones (eslint.config.js,
 * ARCHITECTURE.md §1.3). Runs the project's real flat config programmatically
 * over inline code with synthetic zone file paths: violating snippets MUST
 * error, legal snippets MUST NOT produce boundary errors. Unused-import and
 * other non-boundary messages are filtered out (irrelevant here).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const BOUNDARY_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-globals',
  'no-restricted-syntax'
]);

const eslint = new ESLint();

/** Lint `code` as if it lived at `filePath`; return boundary-rule ruleIds. */
async function boundary(filePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages
    .filter((m) => m.ruleId !== null && BOUNDARY_RULES.has(m.ruleId))
    .map((m) => m.ruleId as string);
}

const IMPORT = 'no-restricted-imports';
const GLOBALS = 'no-restricted-globals';
const SYNTAX = 'no-restricted-syntax';

describe('sim/ zone (HARD rule: deterministic core, no render/platform/DOM)', () => {
  it('bans importing platform/', async () => {
    expect(
      await boundary(
        'src/sim/evil.ts',
        "import { now } from '../platform/clock';\n"
      )
    ).toEqual([IMPORT]);
  });

  it('bans importing render/', async () => {
    expect(
      await boundary(
        'src/sim/evil.ts',
        "import { drawSegs } from '../render/segs';\n"
      )
    ).toEqual([IMPORT]);
  });

  it('bans importing src/debug.ts', async () => {
    expect(
      await boundary(
        'src/sim/evil.ts',
        "import { installDebugApi } from '../debug';\n"
      )
    ).toEqual([IMPORT]);
  });

  it('bans DOM/wall-clock globals and Math.random', async () => {
    expect(
      await boundary(
        'src/sim/evil.ts',
        'export const a = document.body;\n' +
          'export const b = performance.now();\n' +
          'export const c = Date.now();\n' +
          'export const d = setTimeout(() => {}, 0);\n' +
          'export const e = Math.random();\n'
      )
    ).toEqual([GLOBALS, GLOBALS, GLOBALS, GLOBALS, SYNTAX]);
  });

  it('allows core/ and wad/ imports', async () => {
    expect(
      await boundary(
        'src/sim/g_game.ts',
        "import { FRACUNIT } from '../core/constants';\nimport { WadFile } from '../wad/wadfile';\nexport const z = [FRACUNIT, WadFile];\n"
      )
    ).toEqual([]);
  });

  it('still allows src/types/debug types (pure declarations)', async () => {
    expect(
      await boundary(
        'src/sim/g_game.ts',
        "import type { DebugStateSnapshot } from '../types/debug';\nexport type S = DebugStateSnapshot;\n"
      )
    ).toEqual([]);
  });
});

describe('core/ zone (imports nothing outside core; pure)', () => {
  it.each(['sim/state', 'wad/wadfile', 'render/segs', 'platform/clock'])(
    'bans importing %s',
    async (target) => {
      expect(
        await boundary(
          'src/core/evil.ts',
          `import { x } from '../${target}';\n`
        )
      ).toEqual([IMPORT]);
    }
  );

  it('bans DOM globals and Math.random', async () => {
    expect(
      await boundary(
        'src/core/evil.ts',
        'export const a = window;\nexport const b = Math.random();\n'
      )
    ).toEqual([GLOBALS, SYNTAX]);
  });

  it('allows intra-core imports', async () => {
    expect(
      await boundary(
        'src/core/random.ts',
        "import { FRACUNIT } from './constants';\nexport const z = FRACUNIT;\n"
      )
    ).toEqual([]);
  });
});

describe('wad/ zone (pure decoders)', () => {
  it.each(['sim/g_game', 'render/framebuffer', 'platform/audio/sfx'])(
    'bans importing %s',
    async (target) => {
      expect(
        await boundary(
          'src/wad/evil.ts',
          `import { x } from '../${target}';\n`
        )
      ).toEqual([IMPORT]);
    }
  );

  it('bans DOM globals', async () => {
    expect(
      await boundary('src/wad/evil.ts', 'export const a = document;')
    ).toEqual([GLOBALS]);
  });

  it('allows core/ imports (tables/constants)', async () => {
    expect(
      await boundary(
        'src/wad/mapdata.ts',
        "import { FRACUNIT } from '../core/constants';\nexport const z = FRACUNIT;\n"
      )
    ).toEqual([]);
  });
});

describe('render/ zone (reads sim state; never platform)', () => {
  it('bans importing platform/', async () => {
    expect(
      await boundary(
        'src/render/evil.ts',
        "import { present } from '../platform/canvas';\n"
      )
    ).toEqual([IMPORT]);
  });

  it('bans sim modules other than sim/state (mutators)', async () => {
    expect(
      await boundary(
        'src/render/evil.ts',
        "import { P_SetupLevel } from '../sim/p_setup';\n"
      )
    ).toEqual([IMPORT]);
  });

  it('allows sim/state, core/, wad/ reads', async () => {
    expect(
      await boundary(
        'src/render/renderer.ts',
        "import { world } from '../sim/state';\nimport { finesine } from '../core/tables';\nimport { decodeMap } from '../wad/mapdata';\nexport const z = [world, finesine, decodeMap];\n"
      )
    ).toEqual([]);
  });

  it('bans DOM/wall-clock globals but not Math.random', async () => {
    expect(
      await boundary(
        'src/render/evil.ts',
        'export const a = document.createElement("canvas");\nexport const b = performance.now();\nexport const c = Math.random();\n'
      )
    ).toEqual([GLOBALS, GLOBALS]);
  });
});

describe('platform/ zone (may wire everything except src/debug.ts)', () => {
  it('allows sim/render/core/wad imports and DOM APIs', async () => {
    expect(
      await boundary(
        'src/platform/canvas.ts',
        "import { stepTics } from '../sim/d_main';\nimport { framebuffer } from '../render/framebuffer';\nimport { world } from '../sim/state';\nimport { wad } from '../wad/wadfile';\nimport { FRACUNIT } from '../core/constants';\nexport const el = document.createElement('canvas');\nexport const z = [stepTics, framebuffer, world, wad, FRACUNIT];\n"
      )
    ).toEqual([]);
  });

  it('bans importing src/debug.ts (cycle guard)', async () => {
    expect(
      await boundary(
        'src/platform/evil.ts',
        "import { installDebugApi } from '../debug';\n"
      )
    ).toEqual([IMPORT]);
  });
});
