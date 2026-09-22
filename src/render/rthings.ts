/**
 * M4-03 — Static thing/sprite tables (r_things.c R_InitSprites + the
 * info.c `sprnames`/`mobjinfo` static subset).
 *
 * Source mapping (linuxdoom-1.10, re-read for this task):
 *
 *  * `R_InitSprites(namelist)` (r_things.c:299-309) is just
 *    `R_InitSpriteDefs` + the `negonearray` init (that array lives with the
 *    draw path, M4-04/05). {@link installSprites} is our `R_InitSpriteDefs`
 *    (r_things.c:177-280) with ONE structural change: instead of scanning
 *    every `S_START..S_END` lump per sprite name (r_things.c:216-237), it
 *    consumes the already-built {@link SpriteCensus} from `wad/sprites.ts`,
 *    whose `buildSpriteDefs` performed exactly the same
 *    `R_InstallSpriteLump` (r_things.c:106-156) control flow — rot-0 lump
 *    fills all 8 slots with `rotate=false`; digits 1..8 fill slot
 *    `digit-1` (zero-based, r_things.c:149-153) with `rotate=true`; the
 *    chars 6-7 mirror pair of an 8-char name installs **the same lump**
 *    into its own slot with `flip=1` (r_things.c:228-234 — no slot copying,
 *    which is why bilateral sprites name 5 lumps for 8 views). Where
 *    vanilla `I_Error`s (multip rot=0, rot0 mixed with digits, two lumps in
 *    one slot, missing rotations, frame holes) the census records a warning
 *    and first-install-wins (sprites.ts header); {@link installSprites}
 *    additionally flags any rotate frame left with a −1 slot.
 *  * vanilla orders `sprites[]` by the `sprnames[]` list (info.c:40-58);
 *    the census orders by first lump seen. Sprite numbers are only ever an
 *    internal index (`sprites[thing->sprite]`, r_things.c:517) and every
 *    use here resolves names at build time, so the order difference is
 *    unobservable; `name4` keeps it inspectable.
 *  * Thing → sprite/frame: vanilla spawns every map thing through
 *    `P_SpawnMapThing` (p_mobj.c:711-800) into an mobj whose
 *    `sprite`/`frame` are its `spawnstate` in `states[]` (info.c). M4 has
 *    no mobjs (plan §0.8/§4): {@link THING_TYPES} below is the static
 *    subset of `mobjinfo[]` — doomednum → spawnstate sprite 4CC + frame
 *    (`frame & FF_FRAMEMASK`, r_things.h FF_FULLBRIGHT 0x8000 masked off —
 *    fullbright handling stays deferred per plan §4). M9-09 FLIP (D018): /
 *    monsters are NO LONGER excluded — KIND_MONSTER THINGS draw their
 *    spawnstate frame (the live-mobj path supersedes them when a roster
 *    drives the frame, {@link createMobjOverlay}); invisible
 *    `MF_NOSECTOR` markers 14/87/89
 *    (they never enter a `sec->thinglist`, so R_AddSprites can never see
 *    them); player starts 1-4 and DM starts 11 (handled before the table
 *    lookup); and the plan's marker exclusions 2001-2005 (see DEVIATION
 *    note on {@link THING_KIND}).
 *  * Spawn filter: same checks in the same order as P_SpawnMapThing —
 *    type 11 → deathmatch start (collected, not spawned); type ≤ 4 →
 *    player start; `!netgame && options & 16` → skip; `!(options & bit)`
 *    with `bit = 1 << (gameskill - 1)` → skip (d_main.c:961 default
 *    `startskill = sk_medium` ⇒ bit 2 ⇒ {@link DEFAULT_SKILL} 3). Thing
 *    angle: `mobj->angle = ANG45 * (mthing->angle/45)` (p_mobj.c:794,
 *    integer division truncates toward zero) — {@link thingAngleDegrees}.
 *  * Thing z: `z = ONFLOORZ` resolves in `P_TeleportMove` to the
 *    containing subsector's `floorheight` (plan §0.8; p_mobj.c:776-781
 *    `x = mthing->x << FRACBITS` / `z = ONFLOORZ`); we take it directly
 *    via {@link bspSubsectorAt} → `subsectors.sector[s]` →
 *    `sectors.floorLh << FRACBITS` (the merged BSP point locator
 *    `subsectorAt` of src/sim/bsp.ts cannot be imported here — the
 *    A-INT1 zone rule (eslint doom/zones/render, ARCHITECTURE §1.3)
 *    forbids render → sim; {@link bspSubsectorAt} therefore reuses
 *    `pointOnSideXY` from render/bsp.ts, the GAP G11 bit-identical port
 *    of that same `R_PointOnSide` ("same placement, cited twin"), so the
 *    semantics are the merged sim/bsp point-loc verbatim.
 *  * Per-sector linked list: vanilla `R_AddSprites(sec)` walks
 *    `sec->thinglist` via `snext` (r_things.c:690-715); mobj-less, we
 *    prebuild the same singly-linked structure once per map
 *    ({@link StaticThings.next}/{@link StaticThings.sectorHead}, prepend
 *    = descending-thing order per sector; R_SortVisSprites fixes draw
 *    order, plan §4). Sources: r_things.c:613-642 (walk), p_maputl.c
 *    P_ChangeSector/P_SetThingPosition (list maintenance, M5+).
 *  * Sprite view selection (`R_ProjectSprite`, r_things.c:452-560):
 *    rotate frames use `ang = R_PointToAngle(thing->x, thing->y)` and
 *    `rot = (ang - thingangle + (unsigned)(ANG45/2)*9) >> 29`
 *    (r_things.c:522-523; `R_PointToAngle(x,y)` is `R_PointToAngle2(viewx,
 *    viewy, x, y)` per r_main.h — the view-origin form already lives in
 *    render/view.ts `pointToAngle`); non-rotate frames always use slot 0.
 *    {@link rotationFromAngles} implements the arithmetic; consumers do the
 *    table read with {@link frameLump}/{@link frameFlip}.
 *
 * Zero-allocation contract: {@link installSprites} and
 * {@link buildStaticThings} run once at map load; every per-frame path
 * (`lookupFrame`, `frameRotates`, `frameLump`, `frameFlip`,
 * `rotationFromAngles`, the sector list walk) only reads typed arrays and
 * returns scalars.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { SpriteCensus } from '../wad/sprites';
import type { MapData } from '../wad/types';
import { thingAt, thingCount } from '../wad/mapdata';
import { NF_SUBSECTOR, type RenderMapView } from './view';
import { pointOnSideXY } from './bsp';
import { ANG45 } from '../core/constants';
import { sprnames } from '../wad/info/sprnames';
import { FF_FRAMEMASK } from '../wad/info/states';
import { MF } from '../wad/info/mobjinfo';

/* ------------------------------------------------------------------ */
/* Sprite tables (R_InitSpriteDefs output, SoA)                         */
/* ------------------------------------------------------------------ */

/** Views per rotating frame (`sprframe_t.lump[8]`, r_things.c:134-138). */
export const NUM_ROTATIONS = 8;

/**
 * `sprites[]`/`spriteframes[]` flattened: sprite `s` owns global frame
 * indices `[frameStart[s], frameStart[s+1])`; frame `g` owns lump/flip slot
 * range `[g*8, g*8+8)` (`-1` = slot never installed).
 */
export interface InstalledSprites {
  /** Sprite count (`numsprites`). */
  readonly count: number;
  /** spriteNum → 4CC (vanilla `sprnames[i]`). */
  readonly name4: readonly string[];
  /** Prefix sums into the frame arrays; length `count + 1`. */
  readonly frameStart: Int32Array;
  /** Per global frame: 1 = 8-view rotation table, 0 = slot 0 only. */
  readonly frameRotate: Uint8Array;
  /** Per (global frame, rotation slot): sprite lump num or −1. */
  readonly lump: Int32Array;
  /** Per (global frame, rotation slot): horizontal-mirror flag. */
  readonly flip: Uint8Array;
  /** Census tolerance notes + install findings (missing rotation slots). */
  readonly warnings: readonly string[];
  /** name4 → spriteNum (build-time resolution only). */
  readonly indexOf: ReadonlyMap<string, number>;
}

/**
 * `R_InitSprites`/`R_InitSpriteDefs` over the merged census (see header
 * mapping). Table contents equal the census `frames` tables — the census
 * already ran the `R_InstallSpriteLump` grammar + tolerance.
 */
export function installSprites(census: SpriteCensus): InstalledSprites {
  const warnings = [...census.warnings];
  const sprites = census.sprites;
  const count = sprites.length;
  let totalFrames = 0;
  for (const s of sprites) totalFrames += s.frames.length;

  const name4 = new Array<string>(count);
  const indexOf = new Map<string, number>();
  const frameStart = new Int32Array(count + 1);
  const frameRotate = new Uint8Array(totalFrames);
  const lump = new Int32Array(totalFrames * NUM_ROTATIONS).fill(-1);
  const flip = new Uint8Array(totalFrames * NUM_ROTATIONS);

  let g = 0;
  for (let s = 0; s < count; s++) {
    const def = sprites[s]!;
    name4[s] = def.name4;
    indexOf.set(def.name4, s);
    frameStart[s] = g;
    for (let f = 0; f < def.frames.length; f++, g++) {
      const fr = def.frames[f]!;
      frameRotate[g] = fr.rotate ? 1 : 0;
      const base = g * NUM_ROTATIONS;
      for (let r = 0; r < NUM_ROTATIONS; r++) {
        lump[base + r] = fr.lump[r] as number;
        flip[base + r] = fr.flip[r] as number;
      }
      if (fr.rotate) {
        // vanilla "is missing rotations" (r_things.c:251-270 I_Error);
        // census already warned — keep one consolidated source below.
        for (let r = 0; r < NUM_ROTATIONS; r++) {
          if (lump[base + r] === -1) {
            const note =
              `sprite ${def.name4}: frame ${String.fromCharCode(65 + f)} ` +
              `is missing rotation ${r + 1}`;
            if (!warnings.includes(note)) warnings.push(note);
          }
        }
      }
    }
  }
  frameStart[count] = g;
  return { count, name4, frameStart, frameRotate, lump, flip, warnings, indexOf };
}

/** Global frame index for (sprite, frame letter), −1 if out of range. Zero-alloc. */
export function lookupFrame(t: InstalledSprites, spriteNum: number, frame: number): number {
  if (spriteNum < 0 || spriteNum >= t.count) return -1;
  if (frame < 0 || frame >= t.frameStart[spriteNum + 1]! - t.frameStart[spriteNum]!) return -1;
  return t.frameStart[spriteNum]! + frame;
}

/** `sprframe->rotate` — 1 = pick per-view slot by rotation, 0 = slot 0. Zero-alloc. */
export function frameRotates(t: InstalledSprites, globalFrame: number): number {
  return t.frameRotate[globalFrame]!;
}

/** `sprframe->lump[rot]` (−1 = absent). Zero-alloc. */
export function frameLump(t: InstalledSprites, globalFrame: number, rot: number): number {
  return t.lump[globalFrame * NUM_ROTATIONS + rot]!;
}

/** `sprframe->flip[rot]`. Zero-alloc. */
export function frameFlip(t: InstalledSprites, globalFrame: number, rot: number): number {
  return t.flip[globalFrame * NUM_ROTATIONS + rot]!;
}

/* ------------------------------------------------------------------ */
/* Rotation selection (r_things.c:522-523)                              */
/* ------------------------------------------------------------------ */

/** `(unsigned)(ANG45/2)*9` = 9 half-octants (r_things.c:523), u32-exact. */
export const ROTATION_BIAS = 0x90000000;

/**
 * `rot = (ang - thingangle + ROTATION_BIAS) >>> 29` where `ang` is
 * `R_PointToAngle(thing->x, thing->y)` (u32 BAM from the view origin;
 * render/view.ts `pointToAngle` is exactly `R_PointToAngle2(viewx,viewy,
 * x,y)` — r_main.h). Unsigned wrap handled by `>>>` (ToUint32 mod 2^32 =
 * C unsigned arithmetic). Rotation 0 faces the viewer; 1 steps CLOCKWISE
 * (r_things.c:59-65 comment block). Zero-alloc.
 */
export function rotationFromAngles(angFromViewToThing: number, thingAngle: number): number {
  return (angFromViewToThing - thingAngle + ROTATION_BIAS) >>> 29;
}

/**
 * `mobj->angle = ANG45 * (mthing->angle/45)` (p_mobj.c:802) — C integer
 * division truncates toward zero, so 44° maps to 0 and −44° to −0 = 0,
 * while −45° maps to −ANG45 (≡ 0xE0000000).
 */
export function thingAngleDegrees(deg: number): number {
  return (Math.trunc(deg / 45) * ANG45) >>> 0;
}

/* ------------------------------------------------------------------ */
/* THING table: doomednum → sprite 4CC + frame (info.c mobjinfo subset) */
/* ------------------------------------------------------------------ */

/** `THING_TYPES` entry classes. */
export const KIND_STATIC = 0; // drawable static (item/decoration/weapon pickup), spawnstate frame
export const KIND_MARKER = 1; // never drawn: MF_NOSECTOR markers + plan-listed 2001-2005
/**
 * M9-09 FLIP (D018 retirement, plan §M9-09): monster THINGS are DRAWN
 * (spawnstate frames via the M4 sprite tables + 8-rotation projection/
 * clipping). The kind stays as the classifier for the live-mobj overlay
 * ({@link createMobjOverlay}): when a live mobj roster drives the frame,
 * the map-thing rows are superseded and the mobjs draw instead — the
 * vanilla thinglist truth.
 */
export const KIND_MONSTER = 2;

/**
 * Sorted doomednums the table answers for (everything spawnable by type
 * id in a DOOM-format map, minus player/DM-start ids 1-4/11 which
 * P_SpawnMapThing handles before the table scan and which therefore never
 * appear here). Binary-search target; {@link thingTypeIndex} is zero-alloc.
 *
 * DEVIATION (plan §M4-03 "markers … 2001-2005"): source-wise 2001-2005 are
 * weapon pickups (`MF_SPECIAL`, p_mobj/info.c) that vanilla DOES draw; the
 * plan lists them as excluded until pickups exist (M7+), so they carry
 * {@link KIND_MARKER} and warn like unknowns.
 */
export const THING_TYPES = new Int32Array([
  5, 6, 7, 8, 9, 10, 12, 13, 14, 15,
  16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
  26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
  36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
  46, 47, 48, 49, 50, 51, 52, 53, 54, 55,
  56, 57, 58, 59, 60, 61, 62, 63, 64, 65,
  66, 67, 68, 69, 70, 71, 72, 73, 74, 75,
  76, 77, 78, 79, 80, 81, 82, 83, 84, 85,
  86, 87, 88, 89, 2001, 2002, 2003, 2004, 2005, 2006,
  2007, 2008, 2010, 2011, 2012, 2013, 2014, 2015, 2018, 2019,
  2022, 2023, 2024, 2025, 2026, 2028, 2035, 2045, 2046, 2047,
  2048, 2049, 3001, 3002, 3003, 3004, 3005, 3006,
]);

/** Sprite 4CC of the doomednum's spawnstate (info.c `states[]` SPR_*). */
export const THING_SPRITE4: readonly string[] = [
  'BKEY', 'YKEY', 'SPID', 'BPAK', 'SPOS', 'PLAY', 'PLAY', 'RKEY', 'TROO', 'PLAY',
  'CYBR', 'CELP', 'POSS', 'SPOS', 'TROO', 'SARG', 'HEAD', 'SKUL', 'POL5', 'POL1',
  'POL6', 'POL4', 'POL2', 'POL3', 'COL1', 'COL2', 'COL3', 'COL4', 'CAND', 'CBRA',
  'COL5', 'COL6', 'RSKU', 'YSKU', 'BSKU', 'CEYE', 'FSKU', 'TRE1', 'TBLU', 'TGRN',
  'TRED', 'SMIT', 'ELEC', 'GOR1', 'GOR2', 'GOR3', 'GOR4', 'GOR5', 'TRE2', 'SMBT',
  'SMGT', 'SMRT', 'SARG', 'GOR2', 'GOR4', 'GOR3', 'GOR5', 'GOR1', 'VILE', 'CPOS',
  'SKEL', 'FATT', 'BSPI', 'BOS2', 'FCAN', 'PAIN', 'KEEN', 'HDB1', 'HDB2', 'HDB3',
  'HDB4', 'HDB5', 'HDB6', 'POB1', 'POB2', 'BRS1', 'SGN2', 'MEGA', 'SSWV', 'TLMP',
  'TLP2', 'TROO', 'BBRN', 'SSWV', 'SHOT', 'MGUN', 'LAUN', 'PLAS', 'CSAW', 'BFUG',
  'CLIP', 'SHEL', 'ROCK', 'STIM', 'MEDI', 'SOUL', 'BON1', 'BON2', 'ARM1', 'ARM2',
  'PINV', 'PSTR', 'PINS', 'SUIT', 'PMAP', 'COLU', 'BAR1', 'PVIS', 'BROK', 'CELL',
  'AMMO', 'SBOX', 'TROO', 'SARG', 'BOSS', 'POSS', 'HEAD', 'SKUL',
];

/**
 * Spawnstate frame = `state frame & FF_FRAMEMASK` (r_things.h: FF_FULLBRIGHT
 * 0x8000 dropped — fullbright handling deferred, plan §4). `'A' + value` is
 * the lump frame letter; static approximation = spawnstate frame always
 * (no state ticking, plan §0.8).
 */
export const THING_FRAMES = new Uint8Array([
  0, 0, 0, 0, 0, 22, 22, 0, 0, 13,
  0, 0, 11, 11, 12, 13, 11, 10, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

/** {@link KIND_STATIC} | {@link KIND_MARKER} | {@link KIND_MONSTER}. */
export const THING_KINDS = new Uint8Array([
  0, 0, 2, 0, 2, 0, 0, 0, 1, 0,
  2, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 2, 0, 0, 0, 0, 0, 2, 2,
  2, 2, 2, 2, 0, 2, 2, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 2, 0,
  0, 1, 2, 1, 1, 1, 1, 1, 1, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 2, 2, 2, 2, 2, 2,
]);

/**
 * Binary search {@link THING_TYPES}; table row index or −1. Zero-alloc.
 * (Ids are sparse — doomednum jumps to 2001..3006 — so a flat Int32Array
 * of 3007 entries would be 99% holes; 118 sorted rows binary-search in ≤ 7
 * compares, all scalar reads.)
 */
export function thingTypeIndex(type: number): number {
  let lo = 0;
  let hi = THING_TYPES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = THING_TYPES[mid]!;
    if (v === type) return mid;
    if (v < type) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* BSP point location (render-zone twin of sim/bsp.ts subsectorAt)     */
/* ------------------------------------------------------------------ */

/**
 * `R_PointInSubsector(x, y)` (r_main.c:800-824) over the render BSP view:
 * root = last node, descend `children[side]` (raw u16 refs, NF_SUBSECTOR
 * bit marks subsector leaves) via the G11 twin {@link pointOnSideXY} —
 * bit-identical to the merged sim/bsp.ts port, which the zone rule keeps
 * unimportable here. Zero nodes ⇒ the one-subsector map (vanilla reads
 * nodes[-1]; same answer on every real map, minus the UB). Zero-alloc.
 */
export function bspSubsectorAt(view: RenderMapView, x: number, y: number): number {
  const nodes = view.nodes;
  if (nodes.count === 0) return 0;
  let i = nodes.count - 1;
  let side = pointOnSideXY(x, y, nodes, i);
  for (let guard = nodes.count; ; guard--) {
    const ref = (side === 0 ? nodes.child0[i] : nodes.child1[i])!;
    if ((ref & NF_SUBSECTOR) !== 0) return ref & ~NF_SUBSECTOR;
    if (guard < 0) {
      throw new Error(`rthings: BSP walk cycle at node ${i} after ${nodes.count} steps`);
    }
    i = ref;
    side = pointOnSideXY(x, y, nodes, i);
  }
}

/* ------------------------------------------------------------------ */
/* Static thing list (per-map, built once)                              */
/* ------------------------------------------------------------------ */

/** Default vanilla skill for the spawn filter (d_main.c:961 `sk_medium`). */
export const DEFAULT_SKILL = 3;

/**
 * `sec->thinglist`/`snext` for the mobj-less world (R_AddSprites walk
 * target, r_things.c:613-642). All arrays are length `count` unless noted;
 * `thing === -1` terminates the list for a sector head.
 */
export interface StaticThings {
  readonly count: number;
  /** fixed = mapunit << 16 (p_mobj.c:776-777 `x = mthing->x << FRACBITS`). */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** BAM u32; {@link thingAngleDegrees} of the THINGS angle field. */
  readonly angle: Uint32Array;
  /** Index into {@link InstalledSprites} (never −1: unresolvable rows skipped). */
  readonly spriteNum: Int32Array;
  /** Frame index (`'A'`-based) — {@link THING_FRAMES} row. */
  readonly frame: Uint8Array;
  /** fixed; subsector's sector floorheight (ONFLOORZ resolution, plan §0.8). */
  readonly floorZ: Int32Array;
  /** Map THINGS record index (debug/traceability). */
  readonly thing: Int32Array;
  /** Next static in the same sector (sector list), −1 = end. */
  readonly next: Int32Array;
  /** sector → first static, length `sectors.length`, −1 = empty sector. */
  readonly sectorHead: Int32Array;
  /** P_SpawnMapThing classification counts (sum === thingCount(md)). */
  readonly skipped: Readonly<{
    playerStart: number;
    dmStart: number;
    solo: number;
    skill: number;
    monster: number;
    marker: number;
    unknown: number;
    missingSprite: number;
  }>;
  /** Sorted distinct unknown doomednums encountered (warn once each). */
  readonly unknownTypes: readonly number[];
  /** Human-readable warnings (one per unknown id + unresolvable sprites). */
  readonly warnings: readonly string[];
}

export interface BuildStaticThingsOptions {
  /** Menu skill 1..5 (bit `1 << (skill - 1)`; d_main/p_mobj). Default 3. */
  readonly skill?: number;
  /** Vanilla single-player: `!netgame` ⇒ `options & 16` things skipped. */
  readonly netgame?: boolean;
}

/**
 * Spawn the map's THINGS into the static draw list — the M4 stand-in for
 * `P_SpawnMapThing` + the mobj state table's first frame (plan §0.8).
 * Checks run in P_SpawnMapThing order (p_mobj.c:717-795): DM starts,
 * player starts, solo bit, skill bit, then the doomednum table.
 */
export function buildStaticThings(
  md: MapData,
  view: RenderMapView,
  sprites: InstalledSprites,
  options: BuildStaticThingsOptions = {},
): StaticThings {
  const skill = options.skill ?? DEFAULT_SKILL;
  const netgame = options.netgame ?? false;
  // P_SpawnMapThing p_mobj.c:743-749: gameskill = menu skill - 1; bit = 1
  // for sk_baby, 4 for sk_nightmare, else 1 << (gameskill - 1).
  const gameskill = skill - 1;
  const skillBit = gameskill === 0 ? 1 : gameskill === 4 ? 4 : 1 << (gameskill - 1);

  const num = thingCount(md);
  const xs = new Int32Array(num);
  const ys = new Int32Array(num);
  const angles = new Uint32Array(num);
  const spriteNums = new Int32Array(num);
  const frames = new Uint8Array(num);
  const floorZs = new Int32Array(num);
  const thingIdx = new Int32Array(num);
  const next = new Int32Array(num);
  const sectorHead = new Int32Array(md.sectors.length).fill(-1);

  const unknownSeen = new Set<number>();
  const unknown: number[] = [];
  const warnings: string[] = [];
  const skipped = {
    playerStart: 0,
    dmStart: 0,
    solo: 0,
    skill: 0,
    monster: 0,
    marker: 0,
    unknown: 0,
    missingSprite: 0,
  };

  let count = 0;
  for (let i = 0; i < num; i++) {
    const t = thingAt(md, i);

    if (t.type === 11) {
      skipped.dmStart += 1; // deathmatchstart, never spawned (p_mobj.c:717-726)
      continue;
    }
    if (t.type <= 4) {
      skipped.playerStart += 1; // playerstart (p_mobj.c:729-737)
      continue;
    }
    if (!netgame && (t.flags & 16) !== 0) {
      skipped.solo += 1; // "not in single player" (p_mobj.c:740-742)
      continue;
    }
    if ((t.flags & skillBit) === 0) {
      skipped.skill += 1; // wrong skill (p_mobj.c:743-752)
      continue;
    }

    const row = thingTypeIndex(t.type);
    if (row < 0) {
      skipped.unknown += 1; // vanilla: I_Error "Unknown type" — we warn once
      if (!unknownSeen.has(t.type)) {
        unknownSeen.add(t.type);
        unknown.push(t.type);
        warnings.push(`unknown thing type ${t.type} at (${t.x}, ${t.y})`);
      }
      continue;
    }
    const kind = THING_KINDS[row]!;
    // M9-09: KIND_MONSTER is NO LONGER excluded (D018 flip) — monster
    // THINGS draw their spawnstate frame like any static thing; skipped
    // .monster stays at 0 (the field is kept for shape stability).
    if (kind === KIND_MARKER) {
      skipped.marker += 1; // MF_NOSECTOR / plan-listed ids
      continue;
    }

    const name4 = THING_SPRITE4[row]!;
    const sprite = sprites.indexOf.get(name4);
    if (sprite === undefined) {
      // The IWAD has no lumps for this sprite 4CC — nothing to draw.
      skipped.missingSprite += 1;
      warnings.push(`thing type ${t.type}: sprite ${name4} not in WAD`);
      continue;
    }

    const fx = (t.x << 16) | 0;
    const fy = (t.y << 16) | 0;
    const ss = bspSubsectorAt(view, fx, fy);
    const sector = view.subsectors.sector[ss]!;

    const k = count++;
    xs[k] = fx;
    ys[k] = fy;
    angles[k] = thingAngleDegrees(t.angle);
    spriteNums[k] = sprite;
    frames[k] = THING_FRAMES[row]!;
    floorZs[k] = (md.sectors[sector]!.floorLh << 16) | 0;
    thingIdx[k] = i;
    next[k] = sectorHead[sector]!; // prepend; draw order fixed by R_SortVisSprites
    sectorHead[sector] = k;
  }

  return {
    count,
    x: xs.subarray(0, count),
    y: ys.subarray(0, count),
    angle: angles.subarray(0, count),
    spriteNum: spriteNums.subarray(0, count),
    frame: frames.subarray(0, count),
    floorZ: floorZs.subarray(0, count),
    thing: thingIdx.subarray(0, count),
    next,
    sectorHead,
    skipped,
    unknownTypes: unknown.sort((a, b) => a - b),
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Live-mobj thinglist overlay (M9-09 — D018 flip, the production      */
/* live-sprite pass the M8-13 finding left test-side)                   */
/* ------------------------------------------------------------------ */

/**
 * The per-frame mobj fields R_AddSprites/R_ProjectSprite need (p_mobj.h
 * `mobj_t` subset, structurally satisfied by the sim Mobj rows — the
 * render zone reads mobj data ONLY through this shape, A-INT1). `sprite`
 * is the sprnames index (m.sprite), `frame` the raw states[] frame word
 * (the FF_FULLBRIGHT/rot bits are masked here, matching the static
 * table's mask-off deviation).
 */
export interface LiveMobjView {
  /** fixed */
  readonly x: number;
  readonly y: number;
  /** fixed; the mobj's live z (already ONFLOORZ-resolved by the sim). */
  readonly z: number;
  /** BAM u32 */
  readonly angle: number;
  /** sprnames index */
  readonly sprite: number;
  /** states.ts frame word */
  readonly frame: number;
  /** MF_* bits (mobjinfo.ts); only MF_NOSECTOR is consulted (the thing
   * list gate, r_things.c R_AddSprites walk precondition). */
  readonly flags?: number;
  /** P_RemoveMobj done — vanilla frees the mobj and the thinglist link
   * unlinks it; the roster keeps it flagged, we skip it. */
  readonly removed?: boolean;
  /** Present on PLAYER mobjs (the sim's back-reference). Single-player
   * truth: skipping them all matches vanilla — the display player is at
   * the view origin (never projected), there are no other players. */
  readonly playerRef?: unknown;
}

/** update() classification counters. */
export interface MobjOverlayStats {
  drawn: number;
  skippedRemoved: number;
  skippedNosector: number;
  skippedPlayer: number;
  skippedMissingSprite: number;
}

export interface MobjOverlay {
  /** Stable identity to hand the sprite pass (renderer.ts); the fields
   * are swapped/rewritten per frame — vissprites.ts reads every array
   * through property access at draw time, never destructured. */
  readonly things: StaticThings;
  /** Rebuild the thinglist FROM the live roster (vanilla truth: with
   * mobjs in the world the sector thinglists ARE the mobjs — every map
   * thing was spawned through P_SpawnMapThing, so the static census rows
   * are superseded, never merged: no double-draw). */
  update(mobjs: Iterable<LiveMobjView>): MobjOverlayStats;
  /** Restore the base static census (the mobj-less golden mode). */
  useStatic(): void;
}

type MutableStaticThings = { -readonly [K in keyof StaticThings]: StaticThings[K] };

/**
 * Build the overlay around a once-built base list. `sprites` resolves
 * sprnames 4CCs; capacity growth reallocs the live rows (the pass sees
 * the swap through the stable `things` identity).
 */
export function createMobjOverlay(
  base: StaticThings,
  view: RenderMapView,
  sprites: InstalledSprites,
  options: { readonly capacity?: number } = {},
): MobjOverlay {
  const headLen = base.sectorHead.length;
  const st: MutableStaticThings = {
    count: base.count,
    x: base.x,
    y: base.y,
    angle: base.angle,
    spriteNum: base.spriteNum,
    frame: base.frame,
    floorZ: base.floorZ,
    thing: base.thing,
    next: base.next,
    sectorHead: base.sectorHead,
    skipped: base.skipped,
    unknownTypes: base.unknownTypes,
    warnings: base.warnings,
  };

  let cap = Math.max(options.capacity ?? 128, 16);
  let lx = new Int32Array(cap);
  let ly = new Int32Array(cap);
  let lz = new Int32Array(cap);
  let la = new Uint32Array(cap);
  let ls = new Int32Array(cap);
  let lf = new Uint8Array(cap);
  let lnext = new Int32Array(cap);
  const head = new Int32Array(headLen);
  let live = false;

  function grow(n: number): void {
    while (cap <= n) cap *= 2;
    const nx = new Int32Array(cap);
    nx.set(lx);
    lx = nx;
    const ny = new Int32Array(cap);
    ny.set(ly);
    ly = ny;
    const nz = new Int32Array(cap);
    nz.set(lz);
    lz = nz;
    const na = new Uint32Array(cap);
    na.set(la);
    la = na;
    const ns = new Int32Array(cap);
    ns.set(ls);
    ls = ns;
    const nf = new Uint8Array(cap);
    nf.set(lf);
    lf = nf;
    const nn = new Int32Array(cap);
    nn.set(lnext);
    lnext = nn;
  }

  return {
    things: st,

    update(mobjs: Iterable<LiveMobjView>): MobjOverlayStats {
      const stats: MobjOverlayStats = {
        drawn: 0,
        skippedRemoved: 0,
        skippedNosector: 0,
        skippedPlayer: 0,
        skippedMissingSprite: 0,
      };
      head.fill(-1);
      let n = 0;
      for (const m of mobjs) {
        if (m.removed === true) {
          stats.skippedRemoved += 1;
          continue;
        }
        if (m.playerRef !== undefined) {
          stats.skippedPlayer += 1;
          continue;
        }
        if ((m.flags ?? 0) & MF.MF_NOSECTOR) {
          stats.skippedNosector += 1;
          continue;
        }
        const name4 = sprnames[m.sprite] ?? '';
        const sn = name4 === '' ? undefined : sprites.indexOf.get(name4);
        if (sn === undefined) {
          stats.skippedMissingSprite += 1; // bullets/puffs w/o lumps etc.
          continue;
        }
        if (n >= cap) grow(n);
        lx[n] = m.x | 0;
        ly[n] = m.y | 0;
        lz[n] = m.z | 0;
        la[n] = m.angle >>> 0;
        ls[n] = sn;
        lf[n] = (m.frame & FF_FRAMEMASK) & 0xff;
        const sector = view.subsectors.sector[bspSubsectorAt(view, m.x | 0, m.y | 0)]!;
        lnext[n] = head[sector]!; // prepend; sort pass fixes draw order
        head[sector] = n;
        n += 1;
        stats.drawn = n;
      }
      st.count = n;
      st.x = lx;
      st.y = ly;
      st.angle = la;
      st.spriteNum = ls;
      st.frame = lf.subarray(0, n);
      st.floorZ = lz;
      st.thing = EMPTY_THING_IDX;
      st.next = lnext;
      st.sectorHead = head;
      live = true;
      return stats;
    },

    useStatic(): void {
      if (!live) return;
      st.count = base.count;
      st.x = base.x;
      st.y = base.y;
      st.angle = base.angle;
      st.spriteNum = base.spriteNum;
      st.frame = base.frame;
      st.floorZ = base.floorZ;
      st.thing = base.thing;
      st.next = base.next;
      st.sectorHead = base.sectorHead;
      live = false;
    },
  };
}

/** StaticThings.thing placeholder for live rows (no THINGS record; the
 * field is debug/traceability-only in vissprites' draw path). */
const EMPTY_THING_IDX = new Int32Array(0);
