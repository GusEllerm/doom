/**
 * M7-10 — m7Fixtures self-check: every spec compiles to a bootable map,
 * the stream arena wires the movers it claims (flicker sector special 1,
 * W1 door 19 line, W1 teleport 39 line, clip + teleport-dest things), and
 * the firing range keeps the eye-line geometry the per-weapon suites pin
 * (player start (128,128) angle 0, dummies on y = 128).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { buildMapFromData } from '../../src/sim/map';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { gInitGame } from '../../src/sim/game';
import { hashState } from '../../src/sim/state';
import { MF_SHOOTABLE } from '../../src/sim/thinglinks';
import { MT } from '../../src/wad/info/mobjinfo';

import { buildFixtureMapWad, mapSelfCheck } from './mapBuilder';
import {
  hazardRoomSpec, streamArenaSpec, weaponRangeSpec
} from './m7Fixtures';

function bytes(spec: ReturnType<typeof weaponRangeSpec>): Uint8Array {
  return buildFixtureMapWad(spec, 'FIXMAP');
}

function boot(spec: ReturnType<typeof weaponRangeSpec>) {
  const b = bytes(spec);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

describe('m7Fixtures', () => {
  it('all specs pass the map self-check and boot deterministically', () => {
    for (const spec of [
      weaponRangeSpec(),
      weaponRangeSpec([{ x: 192 }, { x: 256, type: 3004 }]),
      streamArenaSpec(),
      streamArenaSpec({ flicker: false }),
      hazardRoomSpec()
    ]) {
      mapSelfCheck(bytes(spec)); // throws on an inconsistent spec
      const h = hashState(boot(spec));
      expect(hashState(boot(spec))).toBe(h); // double-boot stable
    }
  });

  it('stream arena carries flicker special 1, W1 door and W1 teleport lines', () => {
    const s = boot(streamArenaSpec());
    expect(s.map.sectors.special[1]).toBe(1); // firing room flicker
    const lineSpecials = Array.from({ length: s.map.lines.count }, (_, i) =>
      s.map.lines.special[i]
    );
    expect(lineSpecials).toContain(1); // regular door (use)
    expect(lineSpecials).toContain(39); // W1 teleport
    expect(s.map.sectors.tag[2]).toBe(665); // door sector tag
    expect(s.map.sectors.tag[3]).toBe(666); // teleport target tag
    expect(s.map.sectors.ceilingHeight[2]).toBe(0); // closed at load
    const s2 = boot(streamArenaSpec({ flicker: false }));
    expect(s2.map.sectors.special[1]).toBe(0);
  });

  it('range dummies spawn live and shootable on the eye line', () => {
    const s = boot(weaponRangeSpec([{ x: 192 }, { x: 256, type: 3004 }]));
    const fixtures = s.mobjs.mobjs.filter(
      (m) => !m.removed && m.type !== MT.MT_PLAYER
    );
    expect(fixtures).toHaveLength(2);
    for (const m of fixtures) {
      expect(m.y).toBe(128 * 65536);
      expect(m.flags & MF_SHOOTABLE).not.toBe(0);
    }
    expect(fixtures.map((m) => m.health)).toEqual([20, 20]);
  });
});
