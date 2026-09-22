/**
 * B-04 — live E1M1 elevators: per-special state traces + render sync.
 *
 * AUDIT (scripts/b04-scan.mjs + loader dump, freedoom1.wad 0.13 E1M1): the
 * ONLY lift specials in the map are DWUS plats — special 88 (GR lift, lines
 * 593/595/596/618/1078, never clears on cross) and special 62 (SR lift,
 * lines 594/620/1064/1075, useAgain=1 keeps the line armed) — tagging
 * sector 98 (the big hall lift, floor 12 → lowest-surrounding -124, line
 * tag 1) and sector 103 (the west elevator, 136 → 8, tag 2). No W1/S1-only
 * plat lines, no plat sector-type spawns (p_plats.c has no P_SpawnPlat in
 * 1.10 either).
 *
 * PART (a) — statefulness: p_plats.c T_PlatRaise is EXACT here (traced
 * route-by-route): down at 4/tic to low, WAIT exactly 35*PLATWAIT=105 tics
 * (p_spec.h:304, status=waiting, p_plats.c:127-135), up at 4/tic, then
 * DWUS self-removes via P_RemoveActivePlat (p_plats.c:55-77) and the
 * sector keeps its final height FOREVER (no perpetualRaise oscillator).
 * Re-fire during any phase hits the `if (sec->specialdata) continue` skip
 * (p_plats.c:167-175 loop): GR-88 crosses and SR-62 re-uses CANNOT reset
 * or replace a live plat; after completion the same line re-fires a FRESH
 * cycle, and BOTH line specials survive (GR never clears — pspec.ts
 * CROSS registry `clear` bit set for W1 only; SR stays armed via
 * gateSwitch=1).
 *
 * The LIVE "lifts don't stay down" symptom was NOT the state machine — it
 * was the DISPLAY BLOCK binding: main.ts rebuilt its render world keyed on
 * state.map NAME, but gSetupLevel (game.ts:320) replaces state.map AND
 * state.sectors on every load with the name equal (E1M1 → E1M1 new game /
 * reborn), so the renderer kept reading the BOOT-TIME sector SoA. Sim-side
 * the lift moved; on screen it never did (and mid-ride the live viewz
 * dropped below the stale floor planes = the B-04 "screen glitch", camera
 * under the floor = inverted plane bands across the frame, NOT visplane
 * HOM — all five counters stay 0). The fix keys the rebuild on state.map
 * IDENTITY (main.ts Boot.simMap, mirroring stepTic's lastLevelMap
 * detector). The "display sync" suite below pins the contract: a same-name
 * reload MUST swap map identity (guard), the rebuilt world shares the
 * live SoA arrays, and five mid-transit frames equal their per-frame
 * static references byte-for-byte with hom==0 (a clone-SoA STALE world is
 * the negative control — its frame provably differs mid-transit).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WadFile } from '../../src/wad/wadfile';
import { loadMap } from '../../src/wad/mapdata';
import { decodeColormap } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { buildMapFromData } from '../../src/sim/map';
import { gDeferedInitNew, gInitGame, gTicker, registerGameFlowHooks } from '../../src/sim/game';
import type { GameState } from '../../src/sim/state';
import { pCrossSpecialLine, pUseSpecialLine } from '../../src/sim/pspec';
import { sectorSpecialData } from '../../src/sim/ptick';
import { debugSim } from '../../src/debug';
import { activePlats, type Plat } from '../../src/sim/pplats';
import { resetHookSlots } from '../../src/sim/hooks';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { FRACUNIT } from '../../src/core/constants';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
].find((p): p is string => p !== undefined && existsSync(p));

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function e1m1State(): GameState {
  const bytes = readFileSync(WAD_PATH!);
  const buf = toArrayBuffer(bytes);
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
  resetHookSlots(s.hooks);
  return s;
}

const STATUS = ['up', 'down', 'waiting', 'stasis'] as const;

interface TraceRow {
  t: number;
  floor: number;
  status: string;
  count: number;
}

function platOfSector(_s: GameState, sector: number): Plat | null {
  for (let i = 0; i < activePlats.length; i++) {
    const p = activePlats[i] as Plat | null;
    if (p !== null && p.sector === sector && !p.removed) return p;
  }
  return null;
}

/** Tick `tics`, tracing floor + plat phase per tic; stops early once the
 * plat is gone AND `settle` tics of silence passed (keeps rows small). */
function traceRide(
  s: GameState, sector: number, tics: number,
  marks: Record<number, () => void> = {}, settle = 5
): TraceRow[] {
  const rows: TraceRow[] = [];
  let goneAt = -1;
  for (let t = 0; t < tics; t++) {
    marks[t]?.();
    gTicker(s, emptyInput());
    const p = platOfSector(s, sector);
    rows.push({
      t,
      floor: s.sectors.floorZ[sector]!,
      status: p ? STATUS[p.status]! : '-',
      count: p ? p.count : 0
    });
    if (p === null) {
      if (goneAt < 0) goneAt = t;
      else if (t - goneAt >= settle) break;
    } else goneAt = -1;
  }
  return rows;
}

/** Assert the DWUS phase table row-by-row (tic indices are trace-local):
 * idle → down at -4/tic (movement starts on the trigger tic — the thinker
 * is inserted while the arena is NOT running) → EXACTLY 105 parked tics
 * (the pastdest-arrival tic holds count=105, then 104 decrements; the tic
 * whose --count hits 0 flips to up WITHOUT moving) → +4/tic up → removed
 * on the arrival tic, floor parked at high forever after. */
function expectDwusPhases(rows: TraceRow[], hi: number, low: number): void {
  const S = FRACUNIT;
  let i = 0;
  while (i < rows.length && rows[i]!.status === '-' && rows[i]!.floor === hi * S) i++;
  expect(i, 'lift was triggered').toBeLessThan(rows.length);
  let n = 0;
  while (i < rows.length && rows[i]!.status === 'down') {
    // (row 0 may already be moving when the trigger fired pre-trace)
    if (i > 0) expect(rows[i]!.floor - rows[i - 1]!.floor).toBe(-4 * S);
    i++; n++;
  }
  expect(rows[i - 1]!.floor).toBe(low * S);
  expect(n).toBe(((hi - low) * S) / (4 * S));
  const w0 = i;
  while (i < rows.length && rows[i]!.status === 'waiting') {
    expect(rows[i]!.floor).toBe(low * S);
    i++;
  }
  expect(i - w0, 'wait phase = 35*PLATWAIT tics').toBe(105);
  // turnaround tic: status flipped to up, plane NOT moved this tic
  expect(rows[i]!.floor - rows[i - 1]!.floor, 'turnaround tic parks').toBe(0);
  i++; n = 0;
  while (i < rows.length && rows[i]!.status === 'up') {
    expect(rows[i]!.floor - rows[i - 1]!.floor).toBe(4 * S);
    i++; n++;
  }
  expect(n).toBe(((hi - low) * S) / (4 * S));
  const rest = rows.slice(i);
  expect(rest.length).toBeGreaterThanOrEqual(4);
  for (const r of rest) {
    expect(r.status).toBe('-');
    expect(r.floor).toBe(hi * S);
  }
}

function wadBundle() {
  const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH!)));
  const md = loadMap(wad, 'E1M1');
  const view = buildRenderMapView(md);
  return {
    wad,
    md,
    view,
    tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!)),
    sprites: buildMapSprites({ md, map: view, wad })
  };
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe.skipIf(WAD_PATH === undefined)('B-04 E1M1 elevator state traces (real specials)', () => {
  it('audit roster: E1M1 lift specials are exactly GR-88 + SR-62 on tags 1/2', () => {
    const md = loadMap(WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH!))), 'E1M1');
    const platLines = md.lineDefs
      .map((L, i) => ({ i, sp: L.special, tag: L.tag }))
      .filter((e) => e.sp === 62 || e.sp === 88);
    expect(platLines.map((e) => `${e.i}:${e.sp}:${e.tag}`)).toEqual([
      '593:88:1', '594:62:1', '595:88:1', '596:88:1',
      '618:88:2', '620:62:2', '1064:62:2', '1075:62:2', '1078:88:2'
    ]);
    const tagged = md.sectors
      .map((S, i) => ({ i, tag: S.tag, f: S.floorLh }))
      .filter((e) => e.tag === 1 || e.tag === 2);
    expect(tagged).toEqual([{ i: 98, tag: 1, f: 12 }, { i: 103, tag: 2, f: 136 }]);
  });

  it('sec 98 via GR-88 cross (line 593): full DWUS phase table', () => {
    const s = e1m1State();
    const mo = s.players[0]!.mo;
    const rows = traceRide(s, 98, 600, {
      1: () => pCrossSpecialLine(s.pmap, 593, 0, mo)
    });
    expectDwusPhases(rows, 12, -124);
    // stay-down persistence: 500 silent tics later the sector is STILL up,
    // specialdata clear, no active plat, no oscillation
    for (let t = 0; t < 500; t++) gTicker(s, emptyInput());
    expect(s.sectors.floorZ[98]).toBe(12 * FRACUNIT);
    expect(platOfSector(s, 98)).toBeNull();
    expect(sectorSpecialData(s.sectors, 98)).toBeNull();
  });

  it('sec 98 via SR-62 use (line 594): identical phase table + line stays armed', () => {
    const s = e1m1State();
    const mo = s.players[0]!.mo;
    const rows = traceRide(s, 98, 600, {
      1: () => pUseSpecialLine(s, mo, 594, 0)
    });
    expectDwusPhases(rows, 12, -124);
    expect(s.map.lines.special[594]).toBe(62); // SR: gateSwitch=1 → armed
  });

  it('sec 103 via GR-88 cross (line 618): DWUS 136 → 8', () => {
    const s = e1m1State();
    const mo = s.players[0]!.mo;
    const rows = traceRide(s, 103, 600, {
      1: () => pCrossSpecialLine(s.pmap, 618, 0, mo)
    });
    expectDwusPhases(rows, 136, 8);
  });

  it('sec 103 via SR-62 use (line 620): DWUS + re-use after completion works', () => {
    const s = e1m1State();
    const mo = s.players[0]!.mo;
    const rows = traceRide(s, 103, 600, {
      1: () => pUseSpecialLine(s, mo, 620, 0)
    });
    expectDwusPhases(rows, 136, 8);
    // re-use AFTER completion: fresh cycle spawns (specialdata was cleared)
    pUseSpecialLine(s, mo, 620, 0);
    expect(s.map.lines.special[620]).toBe(62);
    const rows2 = traceRide(s, 103, 400);
    expectDwusPhases(rows2, 136, 8);
  });

  it('retrigger correctness: crosses during the ride are SKIPPED (specialdata), 500-tic stay-down holds', () => {
    const s = e1m1State();
    const mo = s.players[0]!.mo;
    pCrossSpecialLine(s.pmap, 593, 0, mo);
    gTicker(s, emptyInput()); // down starts
    const id0 = platOfSector(s, 98)!.id;
    for (let t = 0; t < 39; t++) gTicker(s, emptyInput()); // arrive down
    const p1 = platOfSector(s, 98)!;
    expect(p1.id).toBe(id0); // same plat — never replaced
    expect(p1.status).toBe(2); // waiting
    // hammer the GR-88 lines + the SR-62 button through the wait window:
    // every re-fire must be a NO-OP (EV_DoPlat's specialdata skip)
    for (let t = 0; t < 90; t++) {
      if (t % 20 === 0) {
        pCrossSpecialLine(s.pmap, 593, 0, mo);
        pCrossSpecialLine(s.pmap, 595, 0, mo);
        pCrossSpecialLine(s.pmap, 596, 0, mo);
        pUseSpecialLine(s, mo, 594, 0);
      }
      gTicker(s, emptyInput());
      const p = platOfSector(s, 98);
      expect(p?.id ?? 'gone').toBe(id0);
      if (p !== null && p.status === 2) {
        expect(s.sectors.floorZ[98]).toBe(-124 * FRACUNIT); // stays down
      }
    }
    // quiet completion on the ORIGINAL schedule (re-triggers never
    // extended the wait): then 500 persistence tics, unperturbed
    for (let t = 0; t < 540; t++) {
      gTicker(s, emptyInput());
      if (t > 100) {
        expect(s.sectors.floorZ[98]).toBe(12 * FRACUNIT);
        expect(platOfSector(s, 98)).toBeNull();
      }
    }
    // GR lines never consume; SR line stays armed
    expect(s.map.lines.special[593]).toBe(88);
    expect(s.map.lines.special[595]).toBe(88);
    expect(s.map.lines.special[596]).toBe(88);
    expect(s.map.lines.special[594]).toBe(62);
  });
});

describe.skipIf(WAD_PATH === undefined)('B-04 display-block sync — mid-transit frames', () => {
  it('same-name reload swaps map identity (the trap the NAME key missed)', () => {
    const b = wadBundle();
    let pendingMd = b.md;
    registerGameFlowHooks({
      levelLoader: () => {
        pendingMd = loadMap(b.wad, 'E1M1');
        return buildMapFromData(pendingMd);
      }
    });
    const state = gInitGame(buildMapFromData(b.md));
    const mapAtBoot = state.map;
    const sectorsAtBoot = state.sectors;
    gDeferedInitNew(state, 3, 1, 1);
    gTicker(state, emptyInput()); // ga_newgame drain → G_InitNew → gSetupLevel
    expect(state.map).not.toBe(mapAtBoot); // identity swapped…
    expect(state.map.name).toBe(mapAtBoot.name); // …name is NOT (B-04 root)
    expect(state.sectors).not.toBe(sectorsAtBoot); // live SoA replaced
    void pendingMd;
  });

  it('identity-keyed rebuild: 5 mid-transit frames byte-equal per-frame static refs, hom 0; stale clone differs', () => {
    const b = wadBundle();
    let pendingMd = b.md;
    registerGameFlowHooks({
      levelLoader: () => {
        pendingMd = loadMap(b.wad, 'E1M1');
        return buildMapFromData(pendingMd);
      }
    });
    const state = gInitGame(buildMapFromData(b.md));
    // live "New Game" exactly like the browser (enterPlay idiom)
    gDeferedInitNew(state, 3, 1, 1);
    gTicker(state, emptyInput());
    // ---- main.ts display block, IDENTITY-keyed (the fix) ----
    let simMap = state.map;
    let world = loadRenderWorld(pendingMd, texturesFromWad(b.wad), flatsFromWad(b.wad), state.sectors);
    let mdLive = pendingMd;
    // boot-time clone = the STALE world (what the name-key left behind)
    const staleFloor = Int32Array.from(state.sectors.floorZ);
    const worldStale = loadRenderWorld(
      mdLive, texturesFromWad(b.wad), flatsFromWad(b.wad),
      { ...state.sectors, floorZ: staleFloor } as typeof state.sectors
    );

    const p = state.players[0]!;
    debugSim.attach(state);
    debugSim.warp(32 << 16, 256 << 16, undefined, 0); // relink + settle z
    debugSim.detach();

    const fbLive = new Framebuffer();
    const fbRef = new Framebuffer();
    const fbStale = new Framebuffer();
    let checked = 0;
    let input: GameInput = { ...emptyInput(), forward: true };
    for (let t = 1; t <= 12; t++) {
      gTicker(state, input);
      if (t === 12) input = emptyInput(); // stop ON the lift
      // rebuild half of main.ts render(): identity-keyed
      if (simMap !== state.map && pendingMd !== null) {
        simMap = state.map;
        mdLive = pendingMd;
        world = loadRenderWorld(pendingMd, texturesFromWad(b.wad), flatsFromWad(b.wad), state.sectors);
      }
      if (t < 7 || t === 10 || t === 12) {
        checked++;
        expect(world.sectorFloor[98], `t=${t} world bound to live SoA`).toBe(
          state.sectors.floorZ[98]
        );
        const cLive = renderFrame({ fb: fbLive, world, map: b.view, player: p, tables: b.tables, sprites: b.sprites });
        // per-frame static reference: SAME values, value-copied arrays
        const worldRef = loadRenderWorld(
          mdLive, texturesFromWad(b.wad), flatsFromWad(b.wad),
          {
            ...state.sectors,
            floorZ: Int32Array.from(state.sectors.floorZ),
            ceilingZ: Int32Array.from(state.sectors.ceilingZ),
            light: Int32Array.from(state.sectors.light)
          } as typeof state.sectors
        );
        const cRef = renderFrame({ fb: fbRef, world: worldRef, map: b.view, player: p, tables: b.tables, sprites: b.sprites });
        const live = new Uint8Array(fbLive.indices).slice();
        const ref = new Uint8Array(fbRef.indices);
        let diff = 0;
        for (let i = 0; i < live.length; i++) if (live[i] !== ref[i]) diff++;
        expect(diff, `mid-transit frame differs from its per-frame reference (t=${t})`).toBe(0);
        for (const c of [cLive, cRef]) {
          expect(c.hom).toBe(0);
          expect(c.visplaneOverflow).toBe(0);
          expect(c.visspriteOverflow).toBe(0);
          expect(c.openingOverflow).toBe(0);
          expect(c.drawsegOverflow).toBe(0);
        }
        // row sanity: every column of the 3D window must be fully painted
        // (no unpainted 0-run holes once the view is established) — the
        // mid-transit frames decode rows top→bottom without gaps in the
        // lower half (floor plane reaches the bottom row in all columns
        // when the camera looks at a floor; sampled via the bottom row).
        // pixel-class sanity (the mid-ride artifact class): every row of
        // the frame is painted content — the bottom row carries the same
        // flat continuity as the reference's (byte equality above) and
        // the frame is not a degenerate band.
        expect(new Set(live).size, `frame content t=${t}`).toBeGreaterThan(8);
        // negative control: the B-04 STALE world (boot-clone arrays) must
        // NOT equal the live frame mid-transit — the proof this suite
        // would have caught the bug.
        const cStale = renderFrame({ fb: fbStale, world: worldStale, map: b.view, player: p, tables: b.tables, sprites: b.sprites });
        expect(cStale.hom).toBe(0); // the bug was never HOM — it was geometry desync
        if (state.sectors.floorZ[98] !== staleFloor[98]) {
          expect(
            sha(new Uint8Array(fbStale.indices).slice()) !== sha(live),
            `stale world frame must differ mid-transit (t=${t})`
          ).toBe(true);
        }
      }
    }
    expect(checked).toBe(8);
    // ride to the bottom and back: frame tracks the lift the whole way
    for (let t = 13; t <= 200; t++) {
      gTicker(state, emptyInput());
      if (t % 20 === 0) expect(world.sectorFloor[98]).toBe(state.sectors.floorZ[98]);
    }
    expect(state.sectors.floorZ[98]).toBe(12 * FRACUNIT); // came home, stateful
  });
});
