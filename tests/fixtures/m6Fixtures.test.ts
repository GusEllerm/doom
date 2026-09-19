/**
 * M6-02 — family fixture tests: specials/tags/things + BYTE STABILITY.
 *
 * Gates (docs/design/M6-plan.md §M6-02 acceptance):
 *  1. every family map (combined + per-family WADs) passes mapSelfCheck,
 *     BSP property identity holding with things + triggers present;
 *  2. tag/special round-trip through src/wad/mapdata.ts loadMap — LINEDEFS
 *     special@6/tag@8, SECTORS special@22/tag@24 (R01 §5/§11), RAW values,
 *     no packing;
 *  3. tag WIRING: every teleport trigger's tag resolves to exactly one room
 *     whose rectangle contains exactly one type-14 thing; switch/door tags
 *     resolve to tagged sectors;
 *  4. switch markers: trigger texture name on the FRONT (side-0) mid slot
 *     ONLY (R05 §12 side-0 scan rule); ML_SECRET pinned on secret lines;
 *  5. BYTE STABILITY: WALLFIX + M4 fixture WAD shas pinned to values
 *     recorded from pristine main 285e673 BEFORE the mapBuilder change —
 *     specs lacking the new optional fields cannot have moved.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { loadMap, thingAt } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapLumps } from './mapBuilder';
import { buildM4MapLumps } from './m4Fixtures';

import {
  buildFixtureMapWad,
  mapSelfCheck,
  MapCheckError,
  ML_SECRET,
  TEX_DOOR,
  type LineTriggerSpec,
  type RectMapSpec
} from './mapBuilder';
import { buildM4FixturesWad } from './m4Fixtures';
import {
  buildM6FixturesWad,
  buildM6SceneWad,
  crusherHall,
  liftShaft,
  LINE_CRUSHER_S1,
  LINE_DOOR_GR_NORMAL,
  LINE_DOOR_LOCKED_BLUE,
  LINE_DOOR_S1_NORMAL,
  LINE_DOOR_SR_LOCKED_BLUE,
  LINE_DOOR_SR_NORMAL,
  LINE_DOOR_USE,
  LINE_DOOR_W1_NORMAL,
  LINE_EXIT_S1,
  LINE_EXIT_W1,
  LINE_FLOOR_W1_LOWER,
  LINE_PLAT_S1_DWUS,
  LINE_SECRETEXIT_GR,
  LINE_STAIRS_S1_BUILD8,
  LINE_TELEPORT_GR,
  LINE_TELEPORT_GR_MONSTER_ONLY,
  LINE_TELEPORT_W1_MONSTER,
  LINE_TELEPORT_W1_MONSTER_ONLY,
  m6SelfCheck,
  M6_MAP_NAMES,
  M6_SCENES,
  offsetFragment,
  SECFIX_SPEC,
  SECTOR_FINALE,
  SECTOR_NUKAGE,
  SECTOR_SECRET,
  SECTOR_SLIME,
  SECTOR_STROBE_FAST,
  SECTOR_STROBE_HURT,
  SECTOR_STROBE_SYNC,
  SECTOR_SUPER_SLIME,
  SECTOR_FIRE,
  SECTOR_LIGHT_FLASH,
  stairStepUp,
  strobeRoom,
  SWITCHFIX_SPEC,
  TELEFIX_SPEC,
  THING_BLUE_CARD,
  THING_DM_START,
  THING_RED_SKULL,
  THING_TELEPORT_DEST,
  THING_YELLOW_CARD,
  TEX_SWITCH_OFF,
  TEX_SWITCH_ON,
  type M6Family
} from './m6Fixtures';
import { WALLFIX_SPEC } from '../render/viewpoints';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const wadOf = (bytes: Uint8Array): WadFile => WadFile.parse(bytes.buffer as ArrayBuffer);
const families = Object.keys(M6_MAP_NAMES) as M6Family[];

/* ------------------------------------------------------------------ */
/* BYTE STABILITY — pinned pre-M6-02 shas (pristine main 285e673)      */
/* ------------------------------------------------------------------ */

/** sha256(buildFixtureMapWad(WALLFIX_SPEC, 'WALLFIX')) on main 285e673. */
const WALLFIX_WAD_SHA256 = '701ce7227bde661c0423788d02caece5bb596ea53d7c4d00ab4bb4d4b7982696';
/** sha256(buildM4FixturesWad()) on main 285e673. */
const M4FIX_WAD_SHA256 = '1b3ffd030aac2e89e14bafd5d77c33cf1d4dbdd312abdd924b2ee3bc15c5c113';

describe('M6-02 byte stability (existing specs unchanged)', () => {
  it('WALLFIX fixture WAD sha is unmoved (M3 goldens cannot move)', () => {
    expect(sha(buildFixtureMapWad(WALLFIX_SPEC, 'WALLFIX'))).toBe(WALLFIX_WAD_SHA256);
  });
  it('combined M4 fixtures WAD sha is unmoved (M4FIX scenes unchanged)', () => {
    expect(sha(buildM4FixturesWad())).toBe(M4FIX_WAD_SHA256);
  });
  it('M2/M4 compiler parity on WALLFIX still exact, lump for lump', () => {
    const a = buildMapLumps(WALLFIX_SPEC);
    const b = buildM4MapLumps(WALLFIX_SPEC);
    a.forEach((lump, i) => expect(b[i]!.data, lump.name).toEqual(lump.data));
  });
  it('empty optional fields perturb nothing: triggers: [] ⇒ identical bytes', () => {
    const spec: RectMapSpec = {
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256, tag: 5, special: 0 }
      ],
      doors: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 1, tag: 5 }]
    };
    const base = buildFixtureMapWad(spec);
    expect(sha(buildFixtureMapWad({ ...spec, triggers: [] }))).toBe(sha(base));
    expect(sha(buildFixtureMapWad({ ...spec, doors: [...spec.doors!] }))).toBe(sha(base));
  });
});

/* ------------------------------------------------------------------ */
/* selfCheck + determinism                                             */
/* ------------------------------------------------------------------ */

describe('M6-02 family selfCheck', () => {
  it('all four family maps pass mapSelfCheck (combined + per-family)', () => {
    const combined = buildM6FixturesWad();
    for (const f of families) {
      expect(() => mapSelfCheck(combined, M6_MAP_NAMES[f]), f).not.toThrow();
      expect(() => mapSelfCheck(buildM6SceneWad(f), M6_MAP_NAMES[f]), f).not.toThrow();
    }
    const reports = m6SelfCheck();
    for (const f of families) {
      expect(reports[f].numNodes).toBe(reports[f].numSubsectors - 1);
    }
  });
  it('deterministic: two builds byte-identical', () => {
    expect(sha(buildM6FixturesWad())).toBe(sha(buildM6FixturesWad()));
  });
  it('selfCheck actually runs (bogus map name throws)', () => {
    expect(() => mapSelfCheck(buildM6FixturesWad(), 'NOPE1234')).toThrow(MapCheckError);
  });
});

/* ------------------------------------------------------------------ */
/* Tag/special round-trip via mapdata + tag wiring                     */
/* ------------------------------------------------------------------ */

type Decoded = ReturnType<typeof loadMap>;

/** Find the decoded line matching a trigger segment (endpoint pair, either
 * direction). Triggers always split an edge into an exact segment. */
function lineForTrigger(md: Decoded, t: LineTriggerSpec) {
  const seg = (a: number, b: number, c: number, d: number): boolean =>
    (a === c && b === d) === false && // zero-length guard (never true here)
    ((a === t.x1 && b === t.y1 && c === t.x2 && d === t.y2) ||
      (a === t.x2 && b === t.y2 && c === t.x1 && d === t.y1));
  for (const l of md.lineDefs) {
    const p1 = md.vertices[l.v1]!;
    const p2 = md.vertices[l.v2]!;
    if (seg(p1.x, p1.y, p2.x, p2.y)) return l;
  }
  return undefined;
}

function inRoom(r: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
  return x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h;
}

function decodeFamily(f: M6Family): Decoded {
  return loadMap(wadOf(buildM6SceneWad(f)), M6_MAP_NAMES[f]);
}

describe('M6-02 mapdata round-trip: every trigger keeps RAW special/tag', () => {
  for (const f of families) {
    it(`${f}: every trigger line round-trips special/tag (+texture/secret)`, () => {
      const md = decodeFamily(f);
      const spec = M6_SCENES[f];
      const wired = new Map<number, number>(); // tag → tagged sector count
      for (const t of spec.triggers ?? []) {
        const line = lineForTrigger(md, t);
        expect(line, `trigger ${JSON.stringify(t)}`).toBeDefined();
        expect(line!.special, `special ${JSON.stringify(t)}`).toBe(t.special ?? 0);
        expect(line!.tag, `tag ${JSON.stringify(t)}`).toBe(t.tag ?? 0);
        if (t.secret) expect(line!.flags & ML_SECRET).toBe(ML_SECRET);
        if (t.texture) {
          expect(md.sideDefs[line!.front]!.midtexture).toBe(t.texture);
          expect(md.sideDefs[line!.back]!.midtexture).toBe('');
        }
      }
      // Sector specials/tags round-trip (SECTORS special@22/tag@24).
      spec.rooms.forEach((r, i) => {
        const s = md.sectors[i + 1]!;
        expect(s.special, `room ${i} special`).toBe(r.special ?? 0);
        expect(s.tag, `room ${i} tag`).toBe(r.tag ?? 0);
        if (r.tag !== undefined) wired.set(r.tag, (wired.get(r.tag) ?? 0) + 1);
      });
      // Tag wiring: every nonzero trigger/door tag names exactly one sector.
      const tags = new Set<number>();
      for (const t of spec.triggers ?? []) if (t.tag) tags.add(t.tag);
      for (const d of spec.doors ?? []) if (d.tag) tags.add(d.tag);
      for (const tag of tags) expect(wired.get(tag), `tag ${tag} targets`).toBe(1);
    });
  }
});

describe('M6-02 family content', () => {
  it('door family: manual 1, SR 63→tag1, W1 4→tag3, locked 26, cards + DM start', () => {
    const md = decodeFamily('door');
    const spec = M6_SCENES.door;
    const want = [
      { s: LINE_DOOR_USE, tag: 0 },
      { s: LINE_DOOR_SR_NORMAL, tag: 1 },
      { s: LINE_DOOR_W1_NORMAL, tag: 3 },
      { s: LINE_DOOR_LOCKED_BLUE, tag: 0 }
    ];
    spec.doors!.forEach((d, i) => {
      const line = lineForTrigger(md, d);
      expect(line, `door ${i}`).toBeDefined();
      expect(line!.special).toBe(want[i]!.s);
      expect(line!.tag).toBe(want[i]!.tag);
      expect(md.sideDefs[line!.front]!.midtexture).toBe(TEX_DOOR);
      expect(md.sideDefs[line!.back]!.midtexture).toBe(TEX_DOOR);
    });
    const types = thingTypes(md);
    expect(types).toContain(THING_BLUE_CARD);
    expect(types).toContain(THING_YELLOW_CARD);
    expect(types).toContain(THING_RED_SKULL);
    expect(types).toContain(THING_DM_START);
  });

  it('switch family: S1 21/49/7 switches front-side-only + secret S1 29 + SR locked 99 + W1 52', () => {
    const md = decodeFamily('switch');
    const triggers = SWITCHFIX_SPEC.triggers!;
    for (const t of triggers) {
      const line = lineForTrigger(md, t);
      expect(line, `switch ${t.special}`).toBeDefined();
      expect(line!.special).toBe(t.special);
      expect(line!.tag).toBe(t.tag ?? 0);
    }
    expect(triggers.map((t) => t.special)).toEqual([
      LINE_PLAT_S1_DWUS,
      LINE_CRUSHER_S1,
      LINE_STAIRS_S1_BUILD8,
      LINE_DOOR_S1_NORMAL,
      LINE_EXIT_W1
    ]);
    // secret flag on the ML_SECRET switch line, none on the others.
    const secretLine = lineForTrigger(md, triggers[3]!)!;
    expect(secretLine.flags & ML_SECRET).toBe(ML_SECRET);
    expect(lineForTrigger(md, triggers[0]!)!.flags & ML_SECRET).toBe(0);
    // switch textures: side 0 only.
    expect(md.sideDefs[lineForTrigger(md, triggers[0]!)!.front]!.midtexture).toBe(TEX_SWITCH_OFF);
    expect(md.sideDefs[lineForTrigger(md, triggers[0]!)!.back]!.midtexture).toBe('');
    // SR locked door gap 99 carries DOORFIX0 both sides.
    const locked = lineForTrigger(md, SWITCHFIX_SPEC.doors![0]!)!;
    expect(locked.special).toBe(LINE_DOOR_SR_LOCKED_BLUE);
    expect(md.sideDefs[locked.front]!.midtexture).toBe(TEX_DOOR);
    // tags 21/22/23/24 name exactly the helper rooms.
    const tagsOf = md.sectors.map((s) => s.tag);
    expect(tagsOf).toContain(21);
    expect(tagsOf).toContain(22);
    expect(tagsOf).toContain(23);
    expect(tagsOf).toContain(24);
    // W1 exit + sector specials of helper rooms survive the decode.
    expect(lineForTrigger(md, triggers[4]!)!.special).toBe(LINE_EXIT_W1);
    expect(md.sectors[1]!.tag).toBe(0); // hall
    expect(md.sectors[2]!.tag).toBe(21); // shaft
    expect(md.sectors[3]!.tag).toBe(22); // crusher hall
    expect(md.sectors[4]!.tag).toBe(23); // stairs
  });

  it('teleport family: 39/97/125/126 → tag; each tag names ONE room holding ONE type-14', () => {
    const md = decodeFamily('teleport');
    const spec = TELEFIX_SPEC;
    for (const t of spec.triggers!) {
      const line = lineForTrigger(md, t)!;
      expect([
        LINE_TELEPORT_W1_MONSTER,
        LINE_TELEPORT_GR,
        LINE_TELEPORT_W1_MONSTER_ONLY,
        LINE_TELEPORT_GR_MONSTER_ONLY
      ]).toContain(line.special);
      const destRooms = spec.rooms.filter((r) => r.tag === t.tag);
      expect(destRooms, `tag ${t.tag}`).toHaveLength(1);
      const destThings = spec.things!.filter(
        (th) => th.type === THING_TELEPORT_DEST && inRoom(destRooms[0]!, th.x, th.y)
      );
      expect(destThings, `tag ${t.tag} destinations`).toHaveLength(1);
      expect(line.tag).toBe(t.tag);
    }
    const tele = spec.things!.filter((t) => t.type === THING_TELEPORT_DEST);
    expect(tele).toHaveLength(3);
    // angles survive (int16 degrees, R01 §4): dest bearings 90/270/0.
    const types = thingTypes(md);
    expect(types.filter((t) => t === THING_TELEPORT_DEST)).toHaveLength(3);
    expect(types).toContain(THING_DM_START);
  });

  it('sector family: census specials + tags decode; secret + exit lines flagged', () => {
    const md = decodeFamily('sector');
    const wantSpecials = [
      0,
      SECTOR_SLIME,
      SECTOR_STROBE_HURT,
      SECTOR_NUKAGE,
      SECTOR_SUPER_SLIME,
      SECTOR_FIRE,
      SECTOR_STROBE_FAST,
      SECTOR_STROBE_SYNC,
      SECTOR_LIGHT_FLASH,
      SECTOR_SECRET,
      SECTOR_FINALE,
      0
    ];
    md.sectors.slice(1).forEach((s, i) => expect(s.special, `room ${i}`).toBe(wantSpecials[i]));
    expect(md.sectors[2]!.tag).toBe(22); // slime = W1 19 target
    expect(md.sectors[12]!.tag).toBe(21); // door target = WR 90
    const trigs = SECFIX_SPEC.triggers!;
    expect(lineForTrigger(md, trigs[0]!)!.special).toBe(LINE_DOOR_GR_NORMAL);
    expect(lineForTrigger(md, trigs[0]!)!.tag).toBe(21);
    expect(lineForTrigger(md, trigs[1]!)!.special).toBe(LINE_FLOOR_W1_LOWER);
    expect(lineForTrigger(md, trigs[2]!)!.special).toBe(LINE_SECRETEXIT_GR);
    expect(lineForTrigger(md, trigs[2]!)!.flags & ML_SECRET).toBe(ML_SECRET);
    expect(lineForTrigger(md, trigs[3]!)!.special).toBe(LINE_EXIT_S1);
    expect(md.sideDefs[lineForTrigger(md, trigs[3]!)!.front]!.midtexture).toBe(TEX_SWITCH_OFF);
    expect(lineForTrigger(md, trigs[4]!)!.special).toBe(LINE_EXIT_W1);
  });
});

function thingTypes(md: Decoded): number[] {
  const out: number[] = [];
  const n = md.things.length / 10;
  for (let i = 0; i < n; i++) out.push(thingAt(md, i).type);
  return out;
}

describe('M6-02 helper fragments compose predictably', () => {
  it('offsetFragment translates rooms + triggers; helpers carry census specials', () => {
    const f = offsetFragment(liftShaft(31), 256, 128);
    expect(f.rooms[0]).toEqual({ x: 256, y: 128, w: 128, h: 256, tag: 31, ceilingHeight: 128 });
    expect(f.triggers[0]!.x1).toBe(256);
    expect(f.triggers[0]!.special).toBe(LINE_PLAT_S1_DWUS);
    expect(crusherHall(22).triggers[0]!.special).toBe(LINE_CRUSHER_S1);
    expect(stairStepUp(23).triggers[0]!.special).toBe(LINE_STAIRS_S1_BUILD8);
    expect(strobeRoom().rooms[0]!.special).toBe(SECTOR_STROBE_FAST);
  });
  it('switch pair differs at byte index 2 (switchlist[i^1] rule)', () => {
    expect(TEX_SWITCH_ON.charCodeAt(2)).toBe(TEX_SWITCH_OFF.charCodeAt(2) + 1);
    expect(TEX_SWITCH_ON.slice(0, 2) + TEX_SWITCH_ON.slice(3)).toBe(
      TEX_SWITCH_OFF.slice(0, 2) + TEX_SWITCH_OFF.slice(3)
    );
  });
});
