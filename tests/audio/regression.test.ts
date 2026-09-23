/**
 * M10-10 — zero-stream-regression proof (M10-plan §M10-10 acceptance 2,
 * §4-exit-2; D-10a proof obligation):
 *
 *  (a) the random-sites manifest is UNCHANGED — an `mRandom(` call-site
 *      scan of the whole src tree (audio zone included) still equals the
 *      M9-blessed MRANDOM_SITE_CALLS_ALL: the audio stack burns ZERO
 *      menu-stream randomness — no existing golden is re-blessed;
 *  (b) audio is a PURE CONSUMER — the same scripted E1M1 5000-tic run
 *      hashes BYTE-EQUAL (i) with the ledger collector attached, (ii) with
 *      the collector PLUS a real mixerCore Mixer consuming the ledger per
 *      tic, and (iii) with no consumer at all (the muted-boot baseline);
 *  (c) hook-log parity — the sfxSlot RECORD ledger (ids/coords/tics +
 *      count) is identical across (b)(i) and (b)(iii): the M10-04
 *      "record first, notify after" contract holds under a live consumer.
 *
 * The plan's "(b) proven by running the existing motion suite unchanged"
 * leg is an exit-audit obligation (tests/render/motion.test.ts green with
 * audio merged — recorded in the M10-10 evidence), not duplicated here.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import {
  MRANDOM_SITE_CALLS_ALL,
  scanCallTree,
} from '../../src/sim/random-sites';
import { scriptedE1M1Run, hasWad } from '../fixtures/m10Scenarios';

describe('M10-10 zero-stream regression (D-10a)', () => {
  it('(a) mRandom call-tree == the M9 blessed manifest (no new keys, audio zone included)', () => {
    expect(scanCallTree('mRandom')).toEqual({ ...MRANDOM_SITE_CALLS_ALL });
  });

  it('(a2) pRandom call-tree is still sim-only', () => {
    for (const key of Object.keys(scanCallTree('pRandom'))) {
      expect(key.startsWith('sim/'), key).toBe(true);
    }
  });

  it.skipIf(!hasWad)(
    '(b)+(c) scripted E1M1 5000-tic run: hash + sfx hook log IDENTICAL across collector-on / collector+mixer / muted boots',
    () => {
      const plan = (tic: number): Record<string, boolean> =>
        tic < 2 ? {} : { attack: true, forward: tic % 140 < 30 };

      const collector = scriptedE1M1Run({ tics: 5000, pistolStart: true, plan });
      const withMixer = scriptedE1M1Run({ tics: 5000, pistolStart: true, plan, mixer: true });
      const muted = scriptedE1M1Run({
        tics: 5000,
        pistolStart: true,
        plan,
        consumer: false,
      });

      expect(collector.events.length).toBeGreaterThan(50); // consumer really attached
      expect(withMixer.events.length).toBe(collector.events.length);
      expect(withMixer.hash).toBe(collector.hash);
      expect(collector.hash).toBe(muted.hash);
      expect(collector.sfxLogHash).toBe(muted.sfxLogHash); // (c)
    },
  );
});
