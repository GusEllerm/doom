/**
 * sim/state.ts tests (M6-01) — the live sector SoA (seeded value-equal to
 * the static load-time copy, independent arrays) and the §3.4 hashState
 * extension: per-sector (floorZ, ceilingZ, light, special), the run
 * globals, and the thinker arena in arena order.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildFixtureMapWad } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData, type RuntimeMap } from './map';
import { gInitGame, runHeadless } from './game';
import { createLiveSectors, hashState, type GameState } from './state';
import { pAddThinker, pRemoveThinker, pRunThinkers } from './ptick';

const SPEC = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 }
  ],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
} as const;

function fixMap(): RuntimeMap {
  const bytes = buildFixtureMapWad(SPEC);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
}

const fresh = (): GameState => gInitGame(fixMap());

/* ------------------------------------------------------------------ */
/* LiveSoA seeding + authority                                         */
/* ------------------------------------------------------------------ */

describe('createLiveSectors', () => {
  it('value-equal to the static map arrays, but distinct storage', () => {
    const map = fixMap();
    const live = createLiveSectors(map);
    expect(live.count).toBe(map.sectors.count);
    expect(Array.from(live.floorZ)).toEqual(Array.from(map.sectors.floorHeight));
    expect(Array.from(live.ceilingZ)).toEqual(Array.from(map.sectors.ceilingHeight));
    expect(Array.from(live.light)).toEqual(Array.from(map.sectors.lightLevel));
    expect(Array.from(live.special)).toEqual(Array.from(map.sectors.special));
    expect(Array.from(live.tag)).toEqual(Array.from(map.sectors.tag));
    expect(live.specialData.every((t) => t === null)).toBe(true);

    live.floorZ[0]! += 64; // mover mutation hits ONLY the live SoA
    expect(map.sectors.floorHeight[0]).not.toBe(live.floorZ[0]);
    expect(live.floorZ).not.toBe(map.sectors.floorHeight);
  });

  it('gInitGame wires the SoA into state identical-while-static', () => {
    const s = fresh();
    expect(Array.from(s.sectors.floorZ)).toEqual(
      Array.from(s.map.sectors.floorHeight)
    );
  });
});

/* ------------------------------------------------------------------ */
/* hashState extension (§3.4)                                          */
/* ------------------------------------------------------------------ */

describe('hashState M6 fields', () => {
  it('is stable for equal states and across a double run', () => {
    const a = fresh();
    const b = fresh();
    expect(hashState(a)).toBe(hashState(b));
    expect(runHeadless(a, 50)).toBe(runHeadless(b, 50));
  });

  it('every live sector field moves the hash', () => {
    const base = hashState(fresh());
    const bump = (f: (s: GameState) => void): number => {
      const s = fresh();
      f(s);
      return hashState(s);
    };
    expect(bump((s) => { s.sectors.floorZ[1]! += 8; })).not.toBe(base);
    expect(bump((s) => { s.sectors.ceilingZ[0]! -= 8; })).not.toBe(base);
    expect(bump((s) => { s.sectors.light[0] = 9; })).not.toBe(base);
    expect(bump((s) => { s.sectors.special[0] = 9; })).not.toBe(base); // secret
  });

  it('tag is NOT part of the hashed quadruple (static copy)', () => {
    const base = hashState(fresh());
    const s = fresh();
    s.sectors.tag[0] = 77;
    expect(hashState(s)).toBe(base);
  });

  it('run globals move the hash', () => {
    const base = hashState(fresh());
    const bump = (f: (s: GameState) => void): number => {
      const s = fresh();
      f(s);
      return hashState(s);
    };
    expect(bump((s) => { s.totalsecret = 2; })).not.toBe(base);
    expect(bump((s) => { s.secretcount = 1; })).not.toBe(base);
    expect(bump((s) => { s.specialexit = true; })).not.toBe(base);
    expect(bump((s) => { s.exitRequest = 'normal'; })).not.toBe(base);
    expect(bump((s) => { s.exitRequest = 'secret'; })).not.toBe(
      bump((s) => { s.exitRequest = 'normal'; })
    );
  });

  it('specialdata back-refs do NOT leak into the hash (pointer slot)', () => {
    const base = hashState(fresh());
    const s = fresh();
    const t = pAddThinker(s.thinkers, null);
    // The added thinker DOES hash (arena membership); clearing only the
    // specialdata pointer of a state without thinkers cannot move it:
    s.sectors.specialData[0] = null;
    expect(hashState(s)).not.toBe(base); // arena entry (id 1, no words)
    pRemoveThinker(t);
    pRunThinkers(s.thinkers);
    expect(hashState(s)).toBe(base); // unlinked ⇒ back to the base hash
  });

  it('thinker payload words hash, and arena ORDER/identity is hashed', () => {
    const base = hashState(fresh());
    const a = fresh();
    const ta = pAddThinker(a.thinkers, null);
    (ta as { hashWords: readonly number[] }).hashWords = [1, 2, 3];
    expect(hashState(a)).not.toBe(base);

    // Same live COUNT and payload, different insertion history ⇒ the ids
    // differ ⇒ different hash (arena order = list position is hashed).
    const b = fresh();
    const x = pAddThinker(b.thinkers, null);
    pRemoveThinker(x);
    pRunThinkers(b.thinkers); // x unlinked
    const y = pAddThinker(b.thinkers, null);
    (y as { hashWords: readonly number[] }).hashWords = [1, 2, 3];
    expect(hashState(b)).not.toBe(hashState(a));
  });

  it('sentinel-pending thinkers are logically dead: hash equals post-swap', () => {
    const s = fresh();
    pAddThinker(s.thinkers, null);
    const t2 = pAddThinker(s.thinkers, null);
    const before = hashState(s);
    pRemoveThinker(t2); // sentinel, not yet swapped
    const mid = hashState(s);
    pRunThinkers(s.thinkers); // lazy unlink
    const after = hashState(s);
    expect(mid).toBe(after); // sentinel invisible to the hash
    expect(before).not.toBe(mid);
  });

  it('a sector mutation survives identically across twin runs (hash order pinned)', () => {
    const script = (s: GameState): number => {
      s.sectors.light[0] = (s.leveltime * 3) & 255;
      return runHeadless(s, 20);
    };
    expect(script(fresh())).toBe(script(fresh()));
  });
});
