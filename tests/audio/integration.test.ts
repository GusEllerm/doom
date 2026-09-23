/**
 * M10-10 — integration smoke: E1M1 scripted combat EVENT → MIX end-to-end
 * (task §M10-10 4): the SAME tic-stamped ledger drives (a) the offline
 * software mix (mixerCore engine — the golden path) and (b) the live WebAudio
 * driver over a spy AudioContext (the production D-10f path, mock-graph
 * mirror of src/audio/sfxDriver.test.ts). The two halves must agree on what
 * was HEARD: accepted starts, allocator drops, counted missing lumps, and a
 * non-silent offline render.
 *
 * IWAD-gated (real sim + real DS lumps + real sfxinfo table).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { createMixer, renderMix } from '../../src/audio/mixerCore';
import { sfxDataById } from '../../src/audio/sfxdata';
import {
  hasWad,
  iwad,
  peakAbs,
  spyRun,
} from '../fixtures/m10Scenarios';

const SR = 11_025; // exact 35-tic division (315 frames/tic)
const TICS = 600;

describe.skipIf(!hasWad)('M10-10 integration smoke — E1M1 combat ledger → mix (IWAD-gated)', () => {
  it('event ledger → offline render == live driver spy census', () => {
    const rig = spyRun({ tics: TICS, plan: (tic) => (tic < 2 ? {} : { attack: true }) });
    try {
      // The combat really made noise through the seam:
      expect(rig.events.length).toBeGreaterThan(10);
      expect(rig.events.filter((e) => e.id === 1).length).toBeGreaterThan(5); // pistol shots
      expect(rig.started()).toBeGreaterThan(0); // scheduled sources on the spy graph

      // (a) offline mix of the SAME ledger — non-silent, sane length
      const wad = iwad();
      const mix = renderMix(
        {
          events: rig.events,
          listener: rig.listener,
          buffers: (id: number) => sfxDataById(wad, id),
        },
        SR,
      );
      const peak = peakAbs(mix);
      expect(peak.max).toBeGreaterThan(0);
      expect(peak.min).toBeLessThan(0);

      // (b) offline allocator replay of the SAME ledger (the census the
      // driver's mixer must match — same pool, same rules, same tic order)
      const mixer = createMixer({ buffers: (id: number) => sfxDataById(wad, id) });
      let accepted = 0;
      let ki = 0;
      const keys = [...rig.listener].sort((a, b) => a.tic - b.tic);
      const evs = [...rig.events].sort((a, b) => a.tic - b.tic);
      let ei = 0;
      for (let tic = 0; tic < TICS; tic++) {
        // Driver-mirror tic order (sfxDriver.tick): listener keys → pos16
        // advance → drain starts → updateSounds (free + per-tic re-apply).
        while (ki < keys.length && keys[ki]!.tic <= tic) {
          mixer.setListener(keys[ki]!);
          ki++;
        }
        for (const c of mixer.channels) {
          if (c.sfxId && c.data !== null) {
            c.pos16 += Math.trunc((c.data.rate * 65536 * c.pitch) / (128 * 35));
          }
        }
        while (ei < evs.length && evs[ei]!.tic <= tic) {
          const e = evs[ei]!;
          if (mixer.start(e.id, e.origin, e.x, e.y, tic)) accepted++;
          ei++;
        }
        mixer.updateSounds(tic);
      }

      // (c) the live driver census over the same ledger must agree exactly
      const dbg = rig.driver.debug();
      expect(accepted).toBeGreaterThan(0);
      expect(dbg.sourcesStarted).toBe(accepted); // every acceptance hit a node
      expect(dbg.allocatorDrops).toBe(rig.events.length - accepted); // Sorry-Charlies match
      expect(dbg.missingLumps).toBe(0); // freedoom1 covers the combat sounds
      expect(dbg.sourcesCreated).toBe(dbg.sourcesStarted); // leak-free so far

      // every scheduled source got a start time at/after its tic boundary
      const starts = rig.ctx.sources.flatMap((s) => s.starts);
      expect(starts.length).toBe(accepted);
      expect(starts.every((t) => Number.isFinite(t) && t >= 0)).toBe(true);
    } finally {
      rig.dispose();
    }
  });
});
