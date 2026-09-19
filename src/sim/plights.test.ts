/**
 * sim/plights.ts tests (M6-09) — light thinkers (p_lights.c) verbatim:
 * PRNG-stream goldens per flicker family (exact lightLevel sequence +
 * pinned prndindex deltas), strobe duty tables (sync = ZERO draws,
 * async = (P_Random()&7)+1), the glow sweep (silent), the EV_* line
 * specials, the P_SpawnSpecials sector-light wiring (registry subtable:
 * specials 1/2/3/4/8/12/13/17), live-SoA hash drift, and the silent
 * (no-spawn) sector specials.
 *
 * Renderer seam NOTE (documented, NOT wired here — plan forbids
 * render/** edits): src/render/rdata.ts builds its world tables from its
 * OWN COPY of the static load-time md.sectors, so while the SIM light is
 * live (state.sectors.light, hashed), the 3D frame still shows the
 * load-time light. Gap filed for M6-13 (plan §M6-01 live-view callout).
 *
 * Source mirror: /tmp/DOOM-master/linuxdoom-1.10/p_lights.c (+ p_spec.h
 * constants GLOWSPEED 8 / STROBEBRIGHT 5 / FASTDARK 15 / SLOWDARK 35).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildFixtureMapWad } from '../../tests/fixtures/mapBuilder';
import type { RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from './map';
import { gInitGame, gTicker } from './game';
import { pRunThinkers, pAddThinker, sectorSpecialData } from './ptick';
import { hashState } from './state';
import type { GameState } from './state';
import { RNDTABLE } from './prng';
import { FASTDARK, SLOWDARK } from './specials-table';

import {
  evLightTurnOn, evStartLightStrobing, evTurnTagLightsOff,
  pSpawnStrobeFlash, pSpawnGlowingLight,
  tGlow, LIGHT_THINKER_KINDS, GLOWSPEED, STROBEBRIGHT
} from './plights';
import type { StrobeThinker, FireFlickerThinker } from './plights';

function stateFrom(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

/** Advance the thinker arena (the §3.2 P_RunThinkers slot) n tics. */
function tick(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) pRunThinkers(s.thinkers);
}

/** lightLevel of sector `sec` sampled after each of the next n ticks. */
function sampleLight(s: GameState, sec: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    out.push(s.sectors.light[sec]!);
  }
  return out;
}

function lightThinkers(s: GameState): { kind: string; sector: number }[] {
  const out: { kind: string; sector: number }[] = [];
  for (const t of s.thinkers.entries.values()) {
    if (t.removed) continue;
    const p = t as Partial<StrobeThinker>;
    if (p.kind !== undefined) out.push({ kind: p.kind, sector: p.sector! });
  }
  return out;
}

function lineWithTag(s: GameState, tag: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.tag[i] === tag) return i;
  }
  throw new Error(`no line with tag ${tag}`);
}

/* ------------------------------------------------------------------ */
/* 1) T_FireFlicker — 1 P_Random per 4 tics, minlight clamp            */
/* ------------------------------------------------------------------ */

describe('T_FireFlicker (special 17)', () => {
  // Single FIXMAP room: the M6-02 fixture convention puts the two-sided
  // VOID sector 0 (light 0) behind every void-facing wall, so
  // minSurroundingLight = 0 → minlight = 16 (vanilla maps face SOLID one-
  // sided walls there; the pin arithmetic below is identical either way).
  const s = stateFrom({
    rooms: [{ x: 0, y: 0, w: 256, h: 256, special: 17, lightLevel: 48 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }]
  });

  it('spawn: zero PRNG draws, maxlight = own light, minlight = min surrounding + 16', () => {
    expect(s.rng.prndindex).toBe(0); // P_SpawnFireFlicker never draws
    const f = lightThinkers(s)[0]!;
    expect(f).toEqual({ kind: 'fireflicker', sector: 1 });
    const flick = [...s.thinkers.entries.values()][0] as FireFlickerThinker;
    expect(flick.minlight).toBe(16); // 0 (VOID) + 16 — fixture convention
    expect(flick.maxlight).toBe(48);
    expect(s.sectors.special[1]).toBe(0); // cleared at spawn
    expect(sectorSpecialData(s.sectors, 1)).toBeNull(); // lights never own specialdata
  });

  it('lightLevel golden tics 1..40 + prndindex delta = 10 draws (0.25/tic)', () => {
    // (P_Random()&3)*16 over rndtable[1..10] = 8,109,220,222,241,149,107,
    // 75,248,254 → amounts 0,16,0,32,16,16,48,48,0,32; the clamp arm
    // (current − amount < minlight 16) fires at tics 20..32 (LIGHT_THINKER-
    // independent of the maxlight − amount restore arm).
    const got = sampleLight(s, 1, 40);
    expect(got).toEqual([
      48, 48, 48, 48, 48, 48, 48, 32, 32, 32,
      32, 48, 48, 48, 48, 16, 16, 16, 16, 16,
      16, 16, 16, 16, 16, 16, 16, 16, 16, 16,
      16, 16, 16, 16, 16, 48, 48, 48, 48, 16
    ]);
    expect(s.rng.prndindex).toBe(10);
  });

  it('never below minlight (16) and restores maxlight (48) on &3 == 0 draws', () => {
    const seq = sampleLight(s, 1, 60);
    expect(Math.min(...seq)).toBe(16);
    expect(seq).toContain(48);
  });
});

/* ------------------------------------------------------------------ */
/* 2) T_LightFlash — special 1, one draw per polarity flip             */
/* ------------------------------------------------------------------ */

describe('T_LightFlash (special 1)', () => {
  it('spawn draws ONE ((P_Random()&64)+1 — the maxtime single-bit quirk); golden tics 1..80, prndindex 5', () => {
    const s = stateFrom({
      rooms: [{ x: 0, y: 0, w: 256, h: 256, special: 1, lightLevel: 192 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(s.rng.prndindex).toBe(1);
    // minlight = VOID-adjacent 0 (fixture convention). spawn count =
    // (8&64)+1 = 1 → dark at tic 1; dark length = (109&7)+1 = 6; light
    // length = (220&64)+1 = 65 (the &64 quirk: 1 or 65, NEVER an
    // intermediate value); next dark (222&7)+1 = 7; next light 65.
    expect(sampleLight(s, 1, 80)).toEqual([
      ...Array(6).fill(0), ...Array(65).fill(192), ...Array(7).fill(0),
      ...Array(2).fill(192)
    ]);
    expect(s.rng.prndindex).toBe(5);
  });
});

/* ------------------------------------------------------------------ */
/* 3) T_StrobeFlash — duty tables; sync = zero draws                   */
/* ------------------------------------------------------------------ */

describe('T_StrobeFlash (specials 2/3/12/13)', () => {
  /** Sealed room: minlight == maxlight → minlight 0 (the black-flash fixup). */
  function strobeState(special: number): GameState {
    return stateFrom({
      rooms: [{ x: 0, y: 0, w: 256, h: 256, special, lightLevel: 192 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
  }

  /** Bare world (no sector specials) for direct-spawn pins. */
  const bare = (): GameState => stateFrom({
    rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 192 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }]
  });

  function firstStrobe(s: GameState): StrobeThinker {
    return [...s.thinkers.entries.values()].find(
      (x) => (x as Partial<StrobeThinker>).kind === 'strobe'
    ) as StrobeThinker;
  }

  it('SLOW sync (12): count = 1 at load with ZERO draws; duty 35 dark / 5 bright', () => {
    const s = strobeState(12);
    expect(s.rng.prndindex).toBe(0); // deterministic — plan acceptance 4
    const t = lightThinkers(s)[0]!;
    expect(t.kind).toBe('strobe');
    expect(s.sectors.light[1]).toBe(192);
    const seq = sampleLight(s, 1, 80);
    expect(seq.slice(0, 35).every((v) => v === 0)).toBe(true); // t1..t35 dark
    expect(seq.slice(35, 40).every((v) => v === 192)).toBe(true); // t36..40 bright
    expect(seq.slice(40, 75).every((v) => v === 0)).toBe(true);
    expect(seq.slice(75).every((v) => v === 192)).toBe(true);
    expect(s.rng.prndindex).toBe(0); // ZERO draws over 80 tics — silent
  });

  it('FAST sync (13): duty 15 dark / STROBEBRIGHT 5 bright, silent', () => {
    const s = strobeState(13);
    const seq = sampleLight(s, 1, 40);
    expect(seq.slice(0, 15).every((v) => v === 0)).toBe(true);
    expect(seq.slice(15, 20).every((v) => v === 192)).toBe(true);
    expect(seq.slice(20, 35).every((v) => v === 0)).toBe(true);
    expect(seq.slice(35, 40).every((v) => v === 192)).toBe(true);
    expect(s.rng.prndindex).toBe(0);
  });

  it('async spawn: count = (P_Random()&7)+1 pinned to the table, ONE draw; inSync = count 1, ZERO draws', () => {
    const s = bare();
    s.rng.prndindex = 10;
    pSpawnStrobeFlash(s, 1, FASTDARK, 0);
    expect(s.rng.prndindex).toBe(11); // exactly one draw
    const t = firstStrobe(s);
    expect(t.count).toBe((RNDTABLE[11]! & 7) + 1); // RNDTABLE[11] = 140 → 5
    expect(t.darktime).toBe(FASTDARK);
    expect(t.brighttime).toBe(STROBEBRIGHT);
    // The FIRST flip lands at tic count (5): light holds max for t1..4,
    // dark for darktime 15 (t5..19), bright for brighttime 5 (t20..24).
    const seq = sampleLight(s, 1, 30);
    expect(seq.slice(0, 4).every((v) => v === 192)).toBe(true);
    expect(seq.slice(4, 19).every((v) => v === 0)).toBe(true);
    expect(seq.slice(19, 24).every((v) => v === 192)).toBe(true);
    expect(s.rng.prndindex).toBe(11); // zero draws per tic thereafter
    // inSync twin: no draw at all, count 1.
    const s2 = bare();
    s2.rng.prndindex = 10;
    pSpawnStrobeFlash(s2, 1, FASTDARK, 1);
    expect(s2.rng.prndindex).toBe(10); // ZERO draws
    expect(firstStrobe(s2).count).toBe(1);
  });

  it('minlight == maxlight → minlight 0 fixup (strobe to black)', () => {
    // Realised with the VOID light raised to 255 (so the capped
    // P_FindMinSurroundingLight returns the room's own 192 == maxlight)
    // — the vanilla sealed-room case.
    const s = bare();
    s.sectors.light[0] = 255;
    pSpawnStrobeFlash(s, 1, FASTDARK, 1);
    const t = firstStrobe(s);
    expect(t.minlight).toBe(0);
    tick(s, 1); // first flip lands the sector at full black
    expect(s.sectors.light[1]).toBe(0);
  });

  it('darktime args: special 2/4 → FASTDARK 15, 3/12 → SLOWDARK 35', () => {
    expect(firstStrobe(strobeState(2)).darktime).toBe(FASTDARK);
    expect(firstStrobe(strobeState(3)).darktime).toBe(SLOWDARK);
  });
});

/* ------------------------------------------------------------------ */
/* 4) T_Glow — special 8: SILENT sweep, bounce clamp                   */
/* ------------------------------------------------------------------ */

describe('T_Glow (special 8)', () => {
  const glowState = (): GameState => stateFrom({
    rooms: [{ x: 0, y: 0, w: 256, h: 256, special: 8, lightLevel: 192 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }]
  });

  it('silent: zero PRNG draws ever (spawn + 64 tics)', () => {
    const s = glowState();
    expect(s.rng.prndindex).toBe(0);
    tick(s, 64);
    expect(s.rng.prndindex).toBe(0);
    expect(GLOWSPEED).toBe(8);
  });

  it('sweep golden tics 1..32: DOWN first (direction −1), bounce at min/max', () => {
    const s = glowState();
    // minlight = VOID-adjacent 0 (fixture convention). 192−8/tic: at ≤ 0
    // the arm adds GLOWSPEED back and turns — the min SURFACED is 8
    // (bounce quirk pinned); the max bounce clamps exactly at 192.
    const seq = sampleLight(s, 1, 32);
    expect(seq).toEqual([
      184, 176, 168, 160, 152, 144, 136, 128, 120, 112, 104, 96, 88, 80,
      72, 64, 56, 48, 40, 32, 24, 16, 8, 8, 16, 24, 32, 40, 48, 56, 64, 72
    ]);
  });

  it('direction payload flips at the bounces (hashWords alias)', () => {
    const s = glowState();
    const g = [...s.thinkers.entries.values()].find(
      (t) => (t as { kind?: string }).kind === 'glow'
    )!;
    expect(g.hashWords).toBe((g as unknown as { words: number[] }).words); // same array
    tick(s, 24); // bottom bounce lands at tic 24
    expect(g.hashWords).toEqual([LIGHT_THINKER_KINDS.glow, 1]); // turned UP
    tick(s, 24); // top bounce at tic 47
    expect(g.hashWords).toEqual([LIGHT_THINKER_KINDS.glow, -1]); // DOWN again
  });

  it('tGlow is a no-op for a foreign direction value (default arm absent)', () => {
    const s2 = stateFrom({
      rooms: [{ x: 0, y: 0, w: 128, h: 128, lightLevel: 100 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    pSpawnGlowingLight(s2, 1);
    const g = [...s2.thinkers.entries.values()].find(
      (t) => (t as { kind?: string }).kind === 'glow'
    ) as unknown as { direction: number };
    g.direction = 0; // impossible vanilla value — the switch has no default
    tGlow(s2, g as never);
    expect(s2.sectors.light[1]).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
/* 5) EV_LightTurnOn / EV_TurnTagLightsOff / EV_StartLightStrobing     */
/* ------------------------------------------------------------------ */

describe('EV_LightTurnOn (ids 12/13/35/79/80/81/138/139)', () => {
  /** A(tag 7, 35) | B(tag 0, 128) row; C(tag 7, 0) | D(tag 0, 200) row. */
  const fixture = (): GameState => stateFrom({
    rooms: [
      { x: 0, y: 0, w: 256, h: 256, lightLevel: 35, tag: 7 },
      { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 },
      { x: 0, y: 512, w: 256, h: 256, lightLevel: 0, tag: 7 },
      { x: 256, y: 512, w: 256, h: 256, lightLevel: 200 }
    ],
    triggers: [{ x1: 0, y1: 64, x2: 0, y2: 128, tag: 7 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }]
  });

  it('bright = 0: brightest SURROUNDING of the first tagged sector — and the found value STICKS for later tagged sectors (no rescan, verbatim quirk)', () => {
    const s = fixture();
    evLightTurnOn(s, lineWithTag(s, 7), 0);
    expect(s.sectors.light[1]).toBe(128); // A ← surrounding B(128)
    expect(s.sectors.light[3]).toBe(128); // C gets the SAME bright — NOT its
    expect(s.sectors.light[3]).not.toBe(200); // own brighter surround (200)
    expect(s.sectors.light[2]).toBe(128); // untagged sectors untouched
    expect(s.sectors.light[4]).toBe(200);
  });

  it('bright = 35 / 255: every tagged sector set verbatim', () => {
    const s = fixture();
    expect(evLightTurnOn(s, lineWithTag(s, 7), 35)).toBe(true);
    expect([s.sectors.light[1], s.sectors.light[3]]).toEqual([35, 35]);
    evLightTurnOn(s, lineWithTag(s, 7), 255);
    expect([s.sectors.light[1], s.sectors.light[3]]).toEqual([255, 255]);
    expect(s.sectors.light[2]).toBe(128); // tag mismatch — stays
  });
});

describe('EV_TurnTagLightsOff (id 104)', () => {
  it('each tagged sector drops to min(self, adjoining); one-sided lines skipped', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, lightLevel: 192, tag: 7 },
        { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 },
        { x: 0, y: 512, w: 256, h: 256, lightLevel: 192, tag: 7 },
        { x: 256, y: 512, w: 256, h: 256, lightLevel: 90 }
      ],
      triggers: [{ x1: 0, y1: 64, x2: 0, y2: 128, tag: 7 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    // Raise the VOID dummy sector's light: with the fixture convention's
    // light-0 void neighbor EVERY min would be 0 and the test would prove
    // nothing (vanilla maps face solid walls; the MIN scan below must see
    // only the real adjoining rooms).
    s.sectors.light[0] = 255;
    expect(evTurnTagLightsOff(s, lineWithTag(s, 7))).toBe(true);
    expect(s.sectors.light[1]).toBe(128); // A: min(192, B 128)
    expect(s.sectors.light[3]).toBe(90); // C: min(192, D 90)
    expect(s.sectors.light[2]).toBe(128); // untagged untouched
    expect(s.sectors.light[4]).toBe(90);
  });
});

describe('EV_StartLightStrobing (id 17)', () => {
  it('SLOWDARK async strobers on every tagged sector, ONE draw each; specialdata sectors SKIPPED', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, lightLevel: 192, tag: 7 },
        { x: 0, y: 512, w: 256, h: 256, lightLevel: 192, tag: 7 }
      ],
      triggers: [{ x1: 0, y1: 64, x2: 0, y2: 128, tag: 7 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(s.rng.prndindex).toBe(0); // no sector specials at load
    // Sector 2 busy (a mover owns specialdata) → skipped.
    pAddThinker(s.thinkers, null); // (arena id 1 — the stasis mover)
    s.sectors.specialData[2] = s.thinkers.entries.get(1)!;
    expect(evStartLightStrobing(s, lineWithTag(s, 7))).toBe(true);
    expect(s.rng.prndindex).toBe(1); // ONE draw for the single spawned strober
    const spawned = lightThinkers(s);
    expect(spawned).toEqual([{ kind: 'strobe', sector: 1 }]);
    const t = [...s.thinkers.entries.values()].find(
      (x) => (x as Partial<StrobeThinker>).kind === 'strobe'
    ) as StrobeThinker;
    expect(t.darktime).toBe(SLOWDARK); // p_lights.c:227
    expect(t.brighttime).toBe(5);
    // count = (P_Random()&7)+1 pinned against the table
    expect(t.count).toBe((RNDTABLE[1]! & 7) + 1);
  });
});

/* ------------------------------------------------------------------ */
/* 6) Load wiring / silent sectors / payload hashing / hash drift       */
/* ------------------------------------------------------------------ */

describe('P_SpawnSpecials lights subtable (live registry fill)', () => {
  it('specials 1/2/3/4/8/12/13/17 all spawn their thinker kinds, specials cleared (4 stays 4)', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128, special: 1 },
        { x: 256, y: 0, w: 128, h: 128, special: 2 },
        { x: 512, y: 0, w: 128, h: 128, special: 3 },
        { x: 768, y: 0, w: 128, h: 128, special: 4 },
        { x: 1024, y: 0, w: 128, h: 128, special: 8 },
        { x: 1280, y: 0, w: 128, h: 128, special: 12 },
        { x: 1536, y: 0, w: 128, h: 128, special: 13 },
        { x: 1792, y: 0, w: 128, h: 128, special: 17 }
      ],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(lightThinkers(s).map((t) => t.kind)).toEqual([
      'lightflash', 'strobe', 'strobe', 'strobe', 'glow', 'strobe', 'strobe',
      'fireflicker'
    ]);
    expect(Array.from(s.sectors.special)).toEqual([
      0, 0, 0, 0, 4, 0, 0, 0, 0 // sector 4 (special 4) re-writes 4
    ]);
    // draws at load: 1 (flash) + 3 (async strobes 2/3/4) + 0 (glow/sync/
    // flicker) = 4.
    expect(s.rng.prndindex).toBe(4);
  });

  it('silent sectors: specials 5/7/11/16 spawn NOTHING and draw NOTHING (100 tics)', () => {
    const s = stateFrom({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128, special: 5 },
        { x: 256, y: 0, w: 128, h: 128, special: 7 },
        { x: 512, y: 0, w: 128, h: 128, special: 16 },
        { x: 768, y: 0, w: 128, h: 128, special: 11 }
      ],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(s.thinkers.entries.size).toBe(0);
    const before = s.sectors.light.slice();
    tick(s, 100);
    expect(s.rng.prndindex).toBe(0);
    expect(Array.from(s.sectors.light)).toEqual(Array.from(before));
    expect(Array.from(s.sectors.special)).toEqual([0, 5, 7, 16, 11]);
  });
});

describe('live-SoA light hashing (M6-01 seam)', () => {
  const liveSpec = (): RectMapSpec => ({
    rooms: [
      { x: 0, y: 0, w: 256, h: 256, special: 8, lightLevel: 192 },
      { x: 256, y: 0, w: 256, h: 256, lightLevel: 64 },
      { x: 512, y: 0, w: 256, h: 256, special: 12, lightLevel: 192 }
    ],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }]
  });
  const frozenSpec = (): RectMapSpec => ({
    rooms: [
      { x: 0, y: 0, w: 256, h: 256, lightLevel: 192 },
      { x: 256, y: 0, w: 256, h: 256, lightLevel: 64 },
      { x: 512, y: 0, w: 256, h: 256, lightLevel: 192 }
    ],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }]
  });

  it('double-run determinism: identical 64-tic hashes; light motion drifts the hash tic-to-tic', () => {
    const a = stateFrom(liveSpec());
    const b = stateFrom(liveSpec());
    for (let i = 0; i < 64; i++) {
      gTicker(a);
      gTicker(b);
    }
    expect(hashState(a)).toBe(hashState(b));
  });

  it('live light ≠ static mapdata light (renderer seam gap proof for M6-13)', () => {
    const a = stateFrom(liveSpec());
    tick(a, 20);
    expect(a.sectors.light[1]).not.toBe(a.map.sectors.lightLevel[1]);
    // …while the STATIC copy (what rdata.ts currently consumes) is frozen:
    expect(a.map.sectors.lightLevel[1]).toBe(192);
  });

  it('a lit world hashes differently from the frozen twin', () => {
    const lit = stateFrom(liveSpec());
    const frozen = stateFrom(frozenSpec());
    tick(lit, 3); // glow has moved light[1] to 168
    tick(frozen, 3);
    expect(hashState(lit)).not.toBe(hashState(frozen));
  });

  it('thinker payload words are the hashWords alias (count tracked in place)', () => {
    const s = stateFrom({
      rooms: [{ x: 0, y: 0, w: 256, h: 256, special: 17, lightLevel: 192 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    const f = [...s.thinkers.entries.values()][0] as FireFlickerThinker;
    expect(f.hashWords).toBe(f.words);
    expect(f.words).toEqual([LIGHT_THINKER_KINDS.fireFlicker, 4]);
    tick(s, 1);
    expect(f.words[1]).toBe(3);
  });
});
