// sim/random-sites.test.ts — M7-09 acceptance 5: the random-sites ledger
// reviewed against code (scan, not prose — plan §6 risk 1: "regression =
// ledger diff, not silent re-bless").
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { RANDOM_SITE_CALLS, scanRandomSites } from './random-sites';

describe('P_Random call-site ledger (random-sites.md)', () => {
  it('the scan enumerates EVERY emitter module, both directions', () => {
    // An unlisted `pRandom(` site fails; a stale ledger entry fails too.
    expect(scanRandomSites()).toEqual({ ...RANDOM_SITE_CALLS });
  });

  it('M7-09 projectile sites match the documented per-invocation counts', () => {
    // pmissiles.ts: CheckMissileSpawn 1, MF_SHADOW jitter 2, PIT dice 1
    // (occurrence counts — the BFG 15-dice LOOP is ONE occurrence in
    // pradius.ts, 15 draws at runtime: pinned behaviourally in
    // pradius.test.ts stream tests, not by this scan).
    const s = scanRandomSites();
    expect(s['pmissiles.ts']).toBe(4);
    expect(s['pradius.ts']).toBe(1);
    // p_mobj.ts explode lastlook-family sites unchanged by M7-09:
    expect(s['p_mobj.ts']).toBe(RANDOM_SITE_CALLS['p_mobj.ts']);
  });
});
