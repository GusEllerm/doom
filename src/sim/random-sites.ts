// sim/random-sites.ts — the M7 P_Random call-site LEDGER (M7-plan §M7-09:
// "every M7 pRandom site: action → calls-per-invocation table; feeds ARCH
// §5.2 parity + demo stretch"). The prose/derivation lives in the repo
// artifact `random-sites.md` (the plan's docs/design/random-sites.md —
// the orchestrator brief bars this branch from docs/**, move on merge);
// THIS module owns the machine-checked table: random-sites.test.ts scans
// every src/sim module for `pRandom(` call occurrences (comments
// stripped) and asserts equality with RANDOM_SITE_CALLS IN BOTH
// DIRECTIONS (the psound_stub SFX_SITE_LEDGER idiom), so a new draw site
// anywhere in the sim trips the test until the ledger is updated, and a
// removed site trips it too.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Per-module `pRandom(` CALL-OCCURRENCE counts (occurrences, not lines:
 * `(P_Random()-P_Random())<<18` = 2). prng.ts is the definition, skipped. */
export const RANDOM_SITE_CALLS: Readonly<Record<string, number>> = {
  // M8-04 AI core: TryWalk reload, NewChaseDir swap+search, A_Look seesound
  // posit/bgsit (2 sites), A_Chase activesound, A_FaceTarget shadow(2),
  // P_CheckMissileRange dice.
  'p_enemy.ts': 9, // M8-04 p_enemy.c draws
  'p_mobj.ts': 9, // spawn lastlook, explode tics, mapthing tics, puff(3), blood(3)
  'p_pspr.ts': 15, // punch 1, saw 3, plasma flash 1, gunshot 3, shotgun(3), ssgun(6)
  'plights.ts': 5, // M6 light flashers (P_Random & …)
  'pmap.ts': 4, // crusher blood momentum draws (M5/M6 pre-drawn)
  'pmissiles.ts': 4, // CheckMissileSpawn tics, shadow jitter(2), direct-hit dice
  'pplats.ts': 1, // M6 plat go/stop jitter
  'pplayer.ts': 2, // thrust &1, painchance (M8-05: death-state tics clamp moved to p_inter_damage.ts)
  'p_inter_damage.ts': 3, // M8-05: thrust &1, painchance, kill tics clamp
  'pradius.ts': 1, // A_BFGSpray 15-dice LOOP (15 draws per hit ray!)
  'pspec.ts': 1, // M6 damage-floor 1/5 bypass
};

/** Files the scan EXCLUDES (definitions/mechanics, not call sites). */
export const RANDOM_SITE_SCAN_SKIP: readonly string[] = [
  'prng.ts', // pRandom/mRandom definitions + the tables
];

/** Scan src/sim for pRandom call occurrences (test helper). */
export function scanRandomSites(dir = fileURLToPath(new URL('.', import.meta.url))): Record<string, number> {
  const found: Record<string, number> = {};
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    if (RANDOM_SITE_SCAN_SKIP.includes(name)) continue;
    const src = readFileSync(`${dir}/${name}`, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    const n = (src.match(/\bpRandom\(/g) ?? []).length;
    if (n > 0) found[name] = n;
  }
  return found;
}
