/**
 * M6-02 — Fixture tooling specials/tags/things: the FAMILY SPECS
 * (docs/design/M6-plan.md §M6-02).
 *
 * ADDITIVE BY CONSTRUCTION: mapBuilder.ts gained ONLY optional spec fields
 * (`triggers`, door/trigger `secret`, the LineTriggerSpec type); specs
 * without them compile BYTE-IDENTICAL — pinned by the committed WALLFIX/
 * M4FIX WAD shas in m6Fixtures.test.ts (recorded from pristine main 285e673
 * BEFORE this change). Nothing in src/** is touched; render goldens never
 * consume these maps.
 *
 * ## DOOM1 LINEDEFS FORMAT (verified — task item "args? / packing?")
 *
 * R01 §5 (verbatim doomdata.h lineDef, empirically confirmed on E1M1): the
 * 14-byte DOOM1 linedef is `int16 v1, v2; int16 flags; int16 special;
 * int16 tag; int16 sidenum[2]` — special is the SHORT at offset **6**, tag
 * at offset **8**; offset 12 is sidenum[1], NOT a special. There are NO
 * args and NO packing in the DOOM1 container: every trigger class
 * (W1/WR/S1/SR/G1/GR) is a plain literal special number switched on
 * directly by the dispatchers (R05 §1: "1.10 has no special-number data
 * table… hardcoded case inside one of three dispatch functions"; census
 * R05 §2 — e.g. W1 door 4, GR door 90, S1 lift 21, teleports 39/97/125/126).
 * The "alpha*256 + tag*16" packing hypothesis is FALSE for DOOM1 WAD bytes —
 * `P_UnpackLineType`-style decoding is Hexen-format only (16-byte linedef
 * with args[5]); DOOM1 has no equivalent call site (p_setup.c
 * P_LoadLineDefs copies the shorts raw). Any W1↔W2/+1 pairing semantics are
 * SIM-side dispatch behavior (M6-03); the fixtures therefore emit RAW
 * specials — exactly what vanilla would load.
 *
 * ## Families (map markers ≤ 8 chars, every map mapSelfCheck-green)
 *  - M6DOOR — door use-lines with tags: manual 1 (no tag), SR 63 → tag 1,
 *    W1 4 → tag 3, locked-blue 26; card items 5/6/13 + DM start 11.
 *  - M6SWCH — switch use-lines with side-0 switch-texture markers (SW1MTX):
 *    S1 plat 21 / crusher 49 / stairs 7 → sector tags 21/22/23, secret
 *    ML_SECRET S1 door 29 → tag 24, SR locked-blue 99 (door mechanism),
 *    W1 exit 52; lift-shaft / crusher-hall / stair-step-up helper rooms.
 *  - M6TELE — teleport cross lines 39/97/125/126 → destination-sector tags
 *    31/32/33; teleport-destination things (doomednum 14) inside the tagged
 *    rooms; DM starts 11.
 *  - M6SECT — sector special+tag rooms with R05 §3 census exemplars:
 *    damage 5/7/16/4, secret 9, finale 11, strobes 2/12, flash 1, fire 17;
 *    line targets WR 90 → tag 21, W1 19 → tag 22, GR secret exit 124,
 *    S1 exit 11, W1 exit 52; strobe-room helper.
 *
 * ## Conventions
 *  - A LineTriggerSpec (mapBuilder) writes `special`/`tag` RAW into the
 *    LINEDEFS slots (R01 §5 offsets 6/8) and, with `texture`, names the
 *    FRONT-side mid slot only (vanilla P_ChangeSwitchTexture scans side 0
 *    textures — R05 §12). `secret` sets ML_SECRET (0x020, R05 §1.2).
 *  - SWITCH PAIR: SW1MTX ↔ SW2MTX differ at byte index 2 ('1'→'2'), the
 *    vanilla switchlist[i^1] pair rule. M6-11 registers this pair in its
 *    switchlist hook (follow-up); the fixtures only pin the bytes.
 *  - Fragment helpers ({@link liftShaft} etc.) return rooms+triggers at the
 *    origin with the attach edge WEST (stairs: SOUTH); {@link offsetFragment}
 *    translates. The host room must come FIRST in `rooms` — on a shared
 *    edge the earlier-indexed room's side is side 0, so the switch faces
 *    the host.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { buildPatchFromColumns } from '../../src/wad/patch';
import {
  buildMapLumps,
  FLAT_CEIL,
  FLAT_FLOOR,
  mapSelfCheck,
  TEX_DOOR,
  TEX_WALL,
  type LineTriggerSpec,
  type MapCheckReport,
  type RectRoomSpec,
  type RectMapSpec,
  type ThingSpec
} from './mapBuilder';
import { synthFlat, synthPnames, synthTexture1 } from './smallWads';
import { WadBuilder } from './wadWriter';
import { wallPatch } from './m4Fixtures';

// ---------------------------------------------------------------------------
// R05 census constants (docs/research/05-specials.md §2/§3) — RAW specials.
// ---------------------------------------------------------------------------

/** Door use-door, reusable, no tag (R05 §2.1 manual). */
export const LINE_DOOR_USE = 1;
/** W1 door open (R05 §2.2). */
export const LINE_DOOR_W1_OPEN = 2;
/** W1 door normal → tagged sector (R05 §2.2). */
export const LINE_DOOR_W1_NORMAL = 4;
/** S1 door normal → tagged sector (R05 §2.1). */
export const LINE_DOOR_S1_NORMAL = 29;
/** Manual door, blue-card locked (R05 §2.1). */
export const LINE_DOOR_LOCKED_BLUE = 26;
/** SR door normal → tagged sector (R05 §2.1). */
export const LINE_DOOR_SR_NORMAL = 63;
/** SR blue-card locked blazing open (R05 §2.1). */
export const LINE_DOOR_SR_LOCKED_BLUE = 99;
/** S1 plat down-wait-up-stay → tagged shaft (R05 §2.1). */
export const LINE_PLAT_S1_DWUS = 21;
/** S1 crusher (crushAndRaise) → tagged hall (R05 §2.1). */
export const LINE_CRUSHER_S1 = 49;
/** S1 stairs build8 → tagged stair sector (R05 §2.1). */
export const LINE_STAIRS_S1_BUILD8 = 7;
/** W1 lowerFloor → tagged sector (R05 §2.2). */
export const LINE_FLOOR_W1_LOWER = 19;
/** GR door normal → tagged sector, "wr" exemplar (R05 §2.2 GR). */
export const LINE_DOOR_GR_NORMAL = 90;
/** S1 exit switch (sound quirk R05 §12). */
export const LINE_EXIT_S1 = 11;
/** W1 cross exit, special NOT cleared (R05 §2.2). */
export const LINE_EXIT_W1 = 52;
/** GR secret exit, NOT cleared (R05 §2.2). */
export const LINE_SECRETEXIT_GR = 124;
/** W1 teleport, monsters only (R05 §2.2). */
export const LINE_TELEPORT_W1_MONSTER = 39;
/** GR teleport, players AND monsters (R05 §2.2). */
export const LINE_TELEPORT_GR = 97;
/** W1 teleport, monster-only fire-then-clear (R05 §2.2). */
export const LINE_TELEPORT_W1_MONSTER_ONLY = 125;
/** GR teleport, monster-only (players fall through — R05 §11). */
export const LINE_TELEPORT_GR_MONSTER_ONLY = 126;

/** Sector special: lightflash (R05 §3.1 spawn). */
export const SECTOR_LIGHT_FLASH = 1;
/** Sector special: strobe fast (R05 §3.1). */
export const SECTOR_STROBE_FAST = 2;
/** Sector special: strobe fast + 20-dmg hurt (R05 §3.1/§3.2 — stays 4). */
export const SECTOR_STROBE_HURT = 4;
/** Sector special: slime 10-dmg (R05 §3.2). */
export const SECTOR_SLIME = 5;
/** Sector special: nukage 5-dmg (R05 §3.2). */
export const SECTOR_NUKAGE = 7;
/** Sector special: secret, totalsecret++ then 0 (R05 §3.2). */
export const SECTOR_SECRET = 9;
/** Sector special: E1M8 finale damage + exit (R05 §3.2). */
export const SECTOR_FINALE = 11;
/** Sector special: strobe slow, sync (R05 §3.1). */
export const SECTOR_STROBE_SYNC = 12;
/** Sector special: super slime 20-dmg (R05 §3.2). */
export const SECTOR_SUPER_SLIME = 16;
/** Sector special: fire flicker (R05 §3.1). */
export const SECTOR_FIRE = 17;

/** Blue card (R06; consumed by locked specials 26/99/…). */
export const THING_BLUE_CARD = 5;
/** Yellow card. */
export const THING_YELLOW_CARD = 6;
/** Red skull key. */
export const THING_RED_SKULL = 13;
/** Teleport destination (R05 §11: P_EvTeleport picks a MT_TELEPORTMAN by tag). */
export const THING_TELEPORT_DEST = 14;
/** Deathmatch start (optional in these fixtures). */
export const THING_DM_START = 11;

/** Switch OFF marker (side 0 mid only; pair rule: index 2 '1'↔'2'). */
export const TEX_SWITCH_OFF = 'SW1MTX';
/** Switch ON marker. */
export const TEX_SWITCH_ON = 'SW2MTX';

// ---------------------------------------------------------------------------
// Family helpers — standard rooms (M6-plan §M6-02 acceptance 4)
// ---------------------------------------------------------------------------

/** Rooms + trigger lines + (optional) things produced by a family helper. */
export interface SpecFragment {
  readonly rooms: readonly RectRoomSpec[];
  readonly triggers: readonly LineTriggerSpec[];
  readonly things?: readonly ThingSpec[];
}

/** Translate a fragment (pure data — spec objects stay plain/serializable). */
export function offsetFragment(f: SpecFragment, dx: number, dy: number): SpecFragment {
  return {
    rooms: f.rooms.map((r) => ({ ...r, x: r.x + dx, y: r.y + dy })),
    triggers: f.triggers.map((t) => ({
      ...t,
      x1: t.x1 + dx,
      y1: t.y1 + dy,
      x2: t.x2 + dx,
      y2: t.y2 + dy
    })),
    things: (f.things ?? []).map((t) => ({ ...t, x: t.x + dx, y: t.y + dy }))
  };
}

/** Lift shaft: 128×256 tagged shaft room, S1 21 switch on its WEST edge.
 *  Attach: place at the host room's east wall (host indexed first). */
export function liftShaft(tag = 21): SpecFragment {
  return {
    rooms: [{ x: 0, y: 0, w: 128, h: 256, tag, ceilingHeight: 128 }],
    triggers: [
      { x1: 0, y1: 96, x2: 0, y2: 160, special: LINE_PLAT_S1_DWUS, tag, texture: TEX_SWITCH_OFF }
    ]
  };
}

/** Crusher hall: 256×256 tagged hall, S1 49 switch on its WEST edge. */
export function crusherHall(tag = 22): SpecFragment {
  return {
    rooms: [{ x: 0, y: 0, w: 256, h: 256, tag, ceilingHeight: 128 }],
    triggers: [
      { x1: 0, y1: 96, x2: 0, y2: 160, special: LINE_CRUSHER_S1, tag, texture: TEX_SWITCH_OFF }
    ]
  };
}

/** Stair step-up: 256×256 tagged room floor +64, S1 7 build8 switch on its
 *  SOUTH edge. Attach: place below the host room (host indexed first). */
export function stairStepUp(tag = 23): SpecFragment {
  return {
    rooms: [{ x: 0, y: 0, w: 256, h: 256, tag, floorHeight: 64 }],
    triggers: [
      { x1: 96, y1: 0, x2: 160, y2: 0, special: LINE_STAIRS_S1_BUILD8, tag, texture: TEX_SWITCH_OFF }
    ]
  };
}

/** Strobe room: 256×256 sector special 2 (spawn strobe, R05 §3.1). */
export function strobeRoom(): SpecFragment {
  return { rooms: [{ x: 0, y: 0, w: 256, h: 256, special: SECTOR_STROBE_FAST }], triggers: [] };
}

// ---------------------------------------------------------------------------
// Family specs
// ---------------------------------------------------------------------------

/** M6DOOR — five rooms in a row, four door use-lines, cards + DM start. */
export const DOORFIX_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, tag: 1 },
    { x: 256, y: 0, w: 256, h: 256 },
    { x: 512, y: 0, w: 256, h: 256, tag: 3 },
    { x: 768, y: 0, w: 256, h: 256 },
    { x: 1024, y: 0, w: 256, h: 256 }
  ],
  doors: [
    { x1: 256, y1: 96, x2: 256, y2: 160, special: LINE_DOOR_USE },
    { x1: 512, y1: 96, x2: 512, y2: 160, special: LINE_DOOR_SR_NORMAL, tag: 1 },
    { x1: 768, y1: 96, x2: 768, y2: 160, special: LINE_DOOR_W1_NORMAL, tag: 3 },
    { x1: 1024, y1: 96, x2: 1024, y2: 160, special: LINE_DOOR_LOCKED_BLUE }
  ],
  things: [
    { x: 128, y: 128, angle: 0, type: 1 },
    { x: 128, y: 128, angle: 0, type: 2 },
    { x: 128, y: 128, angle: 0, type: 3 },
    { x: 128, y: 128, angle: 0, type: 4 },
    { x: 64, y: 64, angle: 0, type: THING_BLUE_CARD },
    { x: 96, y: 64, angle: 0, type: THING_YELLOW_CARD },
    { x: 128, y: 64, angle: 0, type: THING_RED_SKULL },
    { x: 192, y: 128, angle: 0, type: 2035 },
    { x: 640, y: 128, angle: 90, type: THING_DM_START }
  ]
};

/** M6SWCH — hall + lift shaft (tag 21) + crusher hall (tag 22) + stairs
 *  (tag 23) via the helper fragments; secret-flag S1 door switch → tag 24;
 *  SR locked 99 as a door gap; W1 exit 52 on a void wall. */
export const SWITCHFIX_SPEC: RectMapSpec = (() => {
  const hall: RectRoomSpec = { x: 0, y: 0, w: 256, h: 512 };
  const shaft = offsetFragment(liftShaft(21), 256, 0);
  const crusher = offsetFragment(crusherHall(22), 256, 256);
  const stairs = offsetFragment(stairStepUp(23), 0, 512);
  return {
    rooms: [
      hall,
      ...shaft.rooms,
      ...crusher.rooms,
      ...stairs.rooms,
      // tag 24 target of the secret switch (dark room north of the hall).
      { x: 0, y: -256, w: 256, h: 256, tag: 24, lightLevel: 35 }
    ],
    doors: [
      // SR blue-card locked door (99) on the hall|shaft shared edge.
      { x1: 256, y1: 192, x2: 256, y2: 256, special: LINE_DOOR_SR_LOCKED_BLUE, tag: 0 }
    ],
    triggers: [
      ...shaft.triggers,
      ...crusher.triggers,
      ...stairs.triggers,
      // secret S1 door switch on the hall WEST void edge → tag 24.
      {
        x1: 0,
        y1: 64,
        x2: 0,
        y2: 128,
        special: LINE_DOOR_S1_NORMAL,
        tag: 24,
        texture: TEX_SWITCH_OFF,
        secret: true
      },
      // W1 exit on the hall WEST void edge (no texture — cross trigger).
      { x1: 0, y1: 416, x2: 0, y2: 480, special: LINE_EXIT_W1 }
    ],
    things: [
      { x: 64, y: 128, angle: 0, type: 1 },
      { x: 64, y: 128, angle: 0, type: 2 },
      { x: 64, y: 128, angle: 0, type: 3 },
      { x: 64, y: 128, angle: 0, type: 4 },
      { x: 64, y: 192, angle: 0, type: THING_BLUE_CARD },
      { x: 64, y: 256, angle: 0, type: THING_YELLOW_CARD },
      { x: 64, y: 320, angle: 0, type: THING_RED_SKULL },
      { x: 128, y: 64, angle: 0, type: THING_DM_START }
    ]
  } satisfies RectMapSpec;
})();

/** M6TELE — teleports 97/39/126/125 → destination tags 31/32/33 with
 *  type-14 things inside; DM starts. */
export const TELEFIX_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // 1: start
    { x: 256, y: 0, w: 256, h: 256 }, // 2: trigger ring
    { x: 0, y: 256, w: 256, h: 256, tag: 31 }, // dest of 97
    { x: 256, y: 256, w: 256, h: 256, tag: 32 }, // dest of 39 + 125
    { x: 512, y: 0, w: 256, h: 256, tag: 33 } // dest of 126
  ],
  triggers: [
    { x1: 256, y1: 96, x2: 256, y2: 160, special: LINE_TELEPORT_GR, tag: 31 },
    { x1: 0, y1: 96, x2: 0, y2: 160, special: LINE_TELEPORT_W1_MONSTER, tag: 32 },
    { x1: 512, y1: 96, x2: 512, y2: 160, special: LINE_TELEPORT_GR_MONSTER_ONLY, tag: 33 },
    { x1: 320, y1: 256, x2: 384, y2: 256, special: LINE_TELEPORT_W1_MONSTER_ONLY, tag: 32 }
  ],
  things: [
    { x: 128, y: 128, angle: 0, type: 1 },
    { x: 128, y: 128, angle: 0, type: 2 },
    { x: 128, y: 128, angle: 0, type: 3 },
    { x: 128, y: 128, angle: 0, type: 4 },
    { x: 128, y: 384, angle: 90, type: THING_TELEPORT_DEST },
    { x: 384, y: 384, angle: 270, type: THING_TELEPORT_DEST },
    { x: 640, y: 128, angle: 0, type: THING_TELEPORT_DEST },
    { x: 64, y: 64, angle: 0, type: THING_DM_START },
    { x: 640, y: 192, angle: 180, type: THING_DM_START }
  ]
};

/** M6SECT — twelve census rooms + line targets (helper: strobeRoom). */
export const SECFIX_SPEC: RectMapSpec = (() => {
  const strobe = offsetFragment(strobeRoom(), 0, 512);
  return {
    rooms: [
      { x: 0, y: 0, w: 256, h: 256 }, // 1 hall
      { x: 256, y: 0, w: 256, h: 256, special: SECTOR_SLIME, tag: 22 }, // 2
      { x: 512, y: 0, w: 256, h: 256, special: SECTOR_STROBE_HURT }, // 3
      { x: 0, y: 256, w: 256, h: 256, special: SECTOR_NUKAGE }, // 4
      { x: 256, y: 256, w: 256, h: 256, special: SECTOR_SUPER_SLIME }, // 5
      { x: 512, y: 256, w: 256, h: 256, special: SECTOR_FIRE }, // 6
      ...strobe.rooms, // 7 strobe fast (special 2)
      { x: 256, y: 512, w: 256, h: 256, special: SECTOR_STROBE_SYNC }, // 8
      { x: 512, y: 512, w: 256, h: 256, special: SECTOR_LIGHT_FLASH }, // 9
      { x: 0, y: 768, w: 256, h: 256, special: SECTOR_SECRET }, // 10
      { x: 256, y: 768, w: 256, h: 256, special: SECTOR_FINALE }, // 11
      { x: 512, y: 768, w: 256, h: 256, tag: 21 } // 12 door target
    ],
    triggers: [
      // WR door 90 → tagged room 12 (hall west void wall).
      { x1: 0, y1: 64, x2: 0, y2: 128, special: LINE_DOOR_GR_NORMAL, tag: 21 },
      // W1 lowerFloor 19 → tagged slime room (tag 22).
      { x1: 0, y1: 128, x2: 0, y2: 192, special: LINE_FLOOR_W1_LOWER, tag: 22 },
      // GR secret exit 124, ML_SECRET, on the hall|nukage shared edge.
      { x1: 64, y1: 256, x2: 128, y2: 256, special: LINE_SECRETEXIT_GR, secret: true },
      // S1 exit switch on the strobe|secret shared edge (faces the strobe room).
      { x1: 128, y1: 768, x2: 192, y2: 768, special: LINE_EXIT_S1, texture: TEX_SWITCH_OFF },
      // W1 exit 52 on the finale|doorTarget shared edge.
      { x1: 512, y1: 832, x2: 512, y2: 896, special: LINE_EXIT_W1 }
    ],
    things: [
      { x: 64, y: 64, angle: 0, type: 1 },
      { x: 64, y: 64, angle: 0, type: 2 },
      { x: 64, y: 64, angle: 0, type: 3 },
      { x: 64, y: 64, angle: 0, type: 4 },
      { x: 128, y: 64, angle: 0, type: 2035 },
      { x: 384, y: 128, angle: 0, type: THING_DM_START }
    ]
  } satisfies RectMapSpec;
})();

// ---------------------------------------------------------------------------
// Map names + scene table
// ---------------------------------------------------------------------------

export const M6_MAP_NAMES = {
  door: 'M6DOOR',
  switch: 'M6SWCH',
  teleport: 'M6TELE',
  sector: 'M6SECT'
} as const;

export type M6Family = keyof typeof M6_MAP_NAMES;

export const M6_SCENES: Readonly<Record<M6Family, RectMapSpec>> = {
  door: DOORFIX_SPEC,
  switch: SWITCHFIX_SPEC,
  teleport: TELEFIX_SPEC,
  sector: SECFIX_SPEC
};

// ---------------------------------------------------------------------------
// Graphics (TEXTURE1/PNAMES + flats + patches; switch textures included)
// ---------------------------------------------------------------------------

/** 16×64 solid-post patch (switch texture building block). */
export function solidPatch16(fill: number): Uint8Array {
  return buildPatchFromColumns(
    Array.from({ length: 16 }, () => new Uint8Array(64).fill(fill))
  );
}

/** PNAMES order used by the M6 TEXTURE1 below. */
export const M6_PNAMES = ['FIXP0', 'FIXP1', 'SOLIDP0', 'SOLIDP1'] as const;

const SOLID_ON = 200; // SW2MTX fill ("lit" switch)
const SOLID_OFF = 84; // SW1MTX fill

/** Graphics lumps: FIXWALL0/DOORFIX0 (mapBuilder parity) + SW1MTX/SW2MTX,
 * each 4× a solid 16-wide patch; FIXP0/1 are the DECODABLE wallPatch form
 * (m4Fixtures note: the 2×2 synthPatch lumps are not). */
export function addM6Graphics(wad: WadBuilder): void {
  wad.addLump(
    'TEXTURE1',
    synthTexture1([
      { name: TEX_WALL, width: 64, height: 64, patches: [[0, 0, 0], [32, 0, 1]] },
      { name: TEX_DOOR, width: 64, height: 64, patches: [[0, 0, 1]] },
      {
        name: TEX_SWITCH_OFF,
        width: 64,
        height: 64,
        patches: [
          [0, 0, 2],
          [16, 0, 2],
          [32, 0, 2],
          [48, 0, 2]
        ]
      },
      {
        name: TEX_SWITCH_ON,
        width: 64,
        height: 64,
        patches: [
          [0, 0, 3],
          [16, 0, 3],
          [32, 0, 3],
          [48, 0, 3]
        ]
      }
    ])
  );
  wad.addLump('PNAMES', synthPnames([...M6_PNAMES]));
  wad.addLumpMarker('F_START');
  wad.addLump(FLAT_FLOOR, synthFlat(0xf100)); // FIXFLAT0 (mapBuilder parity)
  wad.addLump(FLAT_CEIL, synthFlat(0xf101)); // FIXFLAT1 (mapBuilder parity)
  wad.addLumpMarker('F_END');
  wad.addLumpMarker('P_START');
  wad.addLump('FIXP0', wallPatch(1));
  wad.addLump('FIXP1', wallPatch(3));
  wad.addLump('SOLIDP0', solidPatch16(SOLID_OFF));
  wad.addLump('SOLIDP1', solidPatch16(SOLID_ON));
  wad.addLumpMarker('P_END');
}

function addMap(wad: WadBuilder, name: string, spec: RectMapSpec): void {
  wad.addLumpMarker(name);
  for (const lump of buildMapLumps(spec)) wad.addLump(lump.name, lump.data);
}

/** One family's WAD (graphics + that single map). */
export function buildM6SceneWad(family: M6Family): Uint8Array {
  const wad = new WadBuilder('IWAD');
  addM6Graphics(wad);
  addMap(wad, M6_MAP_NAMES[family], M6_SCENES[family]);
  return wad.build();
}

/** The combined fixture WAD: graphics + all four family maps. */
export function buildM6FixturesWad(): Uint8Array {
  const wad = new WadBuilder('IWAD');
  addM6Graphics(wad);
  for (const family of Object.keys(M6_MAP_NAMES) as M6Family[]) {
    addMap(wad, M6_MAP_NAMES[family], M6_SCENES[family]);
  }
  return wad.build();
}

/** Round-trip selfCheck of every family map in the combined WAD. */
export function m6SelfCheck(): Record<M6Family, MapCheckReport> {
  const bytes = buildM6FixturesWad();
  const out = {} as Record<M6Family, MapCheckReport>;
  for (const family of Object.keys(M6_MAP_NAMES) as M6Family[]) {
    out[family] = mapSelfCheck(bytes, M6_MAP_NAMES[family]);
  }
  return out;
}
