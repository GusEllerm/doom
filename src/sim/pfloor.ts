// sim/pfloor.ts — floors / stairs / donut (p_floor.c). M6-07: REAL bodies
// replacing the M6-03 stubs, signatures unchanged (pspec.ts registry
// dispatch + tests are the only call sites). Parent: M6-plan §M6-07.
// EV_DoDonut lives here even though 1.10 keeps it in p_spec.c — ownership
// carve-out D013(b), same call semantics (body verbatim p_spec.c:1163-1221).
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against linuxdoom-1.10/p_floor.c +
// the donut in p_spec.c this pass)
// ---------------------------------------------------------------------------
//  • Function inventory of p_floor.c — exactly FOUR: `T_MovePlane` (carved
//    to pplane.ts, D013(a)), `T_MoveFloor`, `EV_DoFloor`, `EV_BuildStairs`.
//    There is NO T_FloorMove / T_ChangeFloor / EV_ChangeSpecialFloor /
//    P_SpawnFloor in 1.10 — floor "types" are data on the floormove_t
//    (floor_e), applied at ARRIVAL inside T_MoveFloor. No changeSpecial-
//    Floor exists anywhere in the tree (grep: 0 hits) — manifest note,
//    nothing skipped.
//  • `floor_e` (p_spec.h:533-570): lowerFloor=0, lowerFloorToLowest=1,
//    turboLower=2, raiseFloor=3, raiseFloorToNearest=4, raiseToTexture=5,
//    lowerAndChange=6, raiseFloor24=7, raiseFloor24AndChange=8,
//    raiseFloorCrush=9, raiseFloorTurbo=10, donutRaise=11,
//    raiseFloor512=12 — mirrored by specials-table FLOOR. stair_e:
//    build8=0, turbo16=1. FLOORSPEED = FRACUNIT (p_spec.h:600); there is
//    NO FLOORWAIT — a floor thinker lives only between spawn and arrival.
//  • floormove_t (p_spec.h:584-596): {thinker, type, crush, sector,
//    direction, newspecial, texture(short=floorpic index), floordestheight,
//    speed}. `texture` is a FLAT index — the port's flat channel gap
//    (pplats.ts header, "M6-07 donut shares the gap; FOLLOW-UP"): live
//    floorpic writes go to pplats.floorFlatOverrides (THE shared override
//    map — one channel, the renderer seam picks it up once flats go live)
//    plus the {@link floorsFlatCopies} event log. `newspecial`/`special`
//    ARE applied live.
//  • T_MoveFloor arrival switches (p_floor.c:208-238) verbatim: dir==1
//    applies ONLY for donutRaise; dir==-1 ONLY for lowerAndChange (the
//    `default:` labels are empty fall-throughs, not behavior). Sound:
//    sfx_stnmov every `!(leveltime&7)`, sfx_pstop at removal — the
//    sector-soundorg deviation of pplats does NOT apply here: the port
//    map carries soundOrgX/Y (P_GroupLines), used like pspec.ts sfxButton.
//  • EV_DoFloor: per-tagged-sector loop, `specialdata` refuse (already
//    moving → KEEP GOING), rtn=1 per spawned sector. PIN: raiseFloorCrush
//    sets crush=true and FALLS THROUGH into raiseFloor, then subtracts
//    an extra 8*FRACUNIT (the `(floortype == raiseFloorCrush)` multiplier);
//    every raise floors at dest = min(lowestCeilSurrounding, own ceiling);
//    turboLower dest = highestFloorSurrounding + 8*FRACUNIT WHEN different
//    from the own floor (the +8 quirk); raiseFloor24AndChange copies the
//    USE LINE's frontsector floorpic+special AT TRIGGER TIME; lowerAndChange
//    captures `texture = own flat` then scans lines ascending for the
//    FIRST neighbouring sector whose floor EQUALS the dest (getSide/
//    sector-order per M6-03 §0.4 pin) and copies its floorpic+special
//    into the thinker (applied at arrival, NOT at trigger).
//  • EV_BuildStairs (p_floor.c:437-540): build8 = speed FLOORSPEED/4, step
//    8; turbo16 = speed FLOORSPEED*4, step 16. The chain loop iterates
//    `sec->lines[i]` ASCENDING (P_GroupLines order — §0.4), requires
//    ML_TWOSIDED, front == current sector (so the chain walks FORWARD only
//    over lines the current sector fronts), SAME floorpic as the FIRST
//    tagged sector's (texture captured ONCE before the do-while), and
//    PIN: `height += stairsize` happens BEFORE the `specialdata` continue
//    — a busy neighbour consumes a step and the chain keeps scanning.
//  • EV_DoDonut (p_spec.c:1163-1221): s1 = tagged (specialdata refuse),
//    s2 = getNextSector(s1->lines[0]) — literally the FIRST bordering line
//    of s1 in linedef order, no search; scan s2's lines ascending for the
//    first two-sided line whose BACKSECTOR != s1 (verbatim — NOT "the
//    sector that isn't s1": a line s2 FRONTS with s1 as back is skipped,
//    and a void/garbage backsector is taken as s3 as-is); spawn the ring
//    mover (donutRaise, up, speed FLOORSPEED/2, texture = s3 flat,
//    newspecial = 0, dest = s3 floor) WITHOUT checking s2->specialdata
//    (vanilla overwrites it), then the hole mover (lowerFloor, down, same
//    speed/dest) and BREAK after the first hit.
//  • Deviations logged (M6-plan §4): (a) flat channel per above — the
//    `texture` word is excluded from hashWords (strings are not hashable
//    there; specials ARE hashed); (b) raiseToTexture needs the vanilla
//    `textureheight[]` table — the sim map stores side TEXTURE NAMES and
//    the TEXTURE1 directory is renderer-side (rdata.ts), so heights come
//    from the injectable {@link textureHeights} table (miss = counted,
//    candidate skipped; real WADs wire it from texture.ts when the sim
//    gains a texture directory — FOLLOW-UP). An empty ('') side texture
//    maps to vanilla's bottomtexture == -1 (skipped).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { sfxSlot } from './hooks';
import {
  getNextSector,
  ML_TWOSIDED,
  pFindHighestFloorSurrounding,
  pFindLowestCeilingSurrounding,
  pFindLowestFloorSurrounding,
  pFindNextHighestFloor,
  pFindSectorFromLineTag,
  sectorLineAt,
  twoSided,
  type SpecWorld
} from './pspec-helpers';
import {
  pAddThinker,
  pRemoveThinker,
  sectorSpecialData,
  setSectorSpecialData,
  type Thinker,
  type ThinkerFn
} from './ptick';
import {
  makePlaneContext,
  tMovePlane,
  DIR_DOWN,
  DIR_UP,
  PLANE_FLOOR,
  type PlaneContext,
  type PlaneHost
} from './pplane';
import { floorFlatOverrides } from './pplats';
import { SFX_PSTOP, SFX_STNMOV } from './pplats';
import { FLOOR, STAIR } from './specials-table';

/* ------------------------------------------------------------------ */
/* p_spec.h constants                                                  */
/* ------------------------------------------------------------------ */

/** p_spec.h:600 FLOORSPEED. */
export const FLOORSPEED = FRACUNIT;

/** sounds.h ids via pplats (sfx_stnmov/sfx_pstop shared by all movers). */
export { SFX_PSTOP, SFX_STNMOV };

/* ------------------------------------------------------------------ */
/* flat + texture-height channels (file-header deviations)             */
/* ------------------------------------------------------------------ */

/** Capped event log of floor-family flat applications (sector, source
 * sector, tic) — L2 assertion instrument, same idiom as platFlatCopies. */
export const floorsFlatCopies: {
  count: number;
  entries: { sector: number; from: number; tic: number }[];
} = { count: 0, entries: [] };

export function resetFloorsFlatCopies(): void {
  floorsFlatCopies.count = 0;
  floorsFlatCopies.entries.length = 0;
}

/** LIVE flat of a sector: the shared override map first (floorpic has no
 * SoA channel — pplats.ts header), then the static load-time table. */
export function floorFlatOf(s: SpecWorld, sec: number): string {
  return floorFlatOverrides.get(sec) ?? s.map.sectors.floorFlat[sec]!;
}

/** vanilla `textureheight[t]` (fixed-point). Injectable: name → height;
 * the sim has no TEXTURE1 directory yet (renderer-side rdata.ts). */
export const textureHeights = new Map<string, number>();

export function resetTextureHeights(): void {
  textureHeights.clear();
}

/** Counted bookkeeping (vanilla-crash/corruption slots → counters, same
 * idiom as pplatsCounts). */
export const pfloorCounts = {
  /** raiseToTexture consulted an unregistered texture name (candidate
   * skipped — see deviation (b)). */
  missingTextureHeight: 0
};

export function resetPfloorCounts(): void {
  pfloorCounts.missingTextureHeight = 0;
}

/* ------------------------------------------------------------------ */
/* floormove_t                                                         */
/* ------------------------------------------------------------------ */

/** Vanilla floormove_t payload (thinker embedded at offset 0 — same
 * object in arena AND sector.specialdata; `texture` is a flat NAME, not
 * hashed, per deviation (a)). */
export interface FloorState {
  sector: number;
  type: number; // floor_e
  crush: boolean;
  direction: number; // DIR_UP | DIR_DOWN
  newspecial: number;
  texture: string; // flat to apply at arrival ('' = none)
  dest: number; // floordestheight
  speed: number;
}

export type FloorMove = Thinker & FloorState;

/* ------------------------------------------------------------------ */
/* PlaneContext per world (M6-04 interface contract, pplats idiom)     */
/* ------------------------------------------------------------------ */

const ctxCache = new WeakMap<SpecWorld, PlaneContext>();

function planeContext(s: SpecWorld): PlaneContext {
  let ctx = ctxCache.get(s);
  if (ctx === undefined) {
    const host = s as unknown as PlaneHost;
    if (host.pmap === undefined || host.players === undefined) {
      throw new Error(
        'pfloor: dispatched on a world without pmap/players — ' +
        'unit pmap worlds must not route live floor actions'
      );
    }
    ctx = makePlaneContext(host);
    ctxCache.set(s, ctx);
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* hashWords sync (ARCHITECTURE §3.4 mover payload words)              */
/* ------------------------------------------------------------------ */

function syncFloorHash(f: FloorMove): void {
  const words = [
    f.sector, f.speed, f.dest, f.direction, f.type, f.newspecial,
    f.crush ? 1 : 0
  ];
  const a = f.hashWords as number[];
  for (let i = 0; i < words.length; i++) {
    if (i < a.length) a[i] = words[i]!;
    else a.push(words[i]!);
  }
  if (a.length > words.length) a.length = words.length;
}

/* ------------------------------------------------------------------ */
/* S_StartSound((mobj_t*)&sector->soundorg, id) — soundorg via the     */
/* P_GroupLines centroid the port map already carries (pspec sfxButton  */
/* idiom; z = 0 — vanilla reads stack garbage there, pinned).          */
/* ------------------------------------------------------------------ */

function floorSound(s: SpecWorld, sector: number, id: number): void {
  sfxSlot(
    s.hooks, id, s.map.sectors.soundOrgX[sector]!,
    s.map.sectors.soundOrgY[sector]!, 0, s.leveltime
  );
}

/* ------------------------------------------------------------------ */
/* T_MoveFloor (p_floor.c:198-241)                                     */
/* ------------------------------------------------------------------ */

/** `T_MoveFloor(floor)` — one thinker tic, verbatim. */
export function tMoveFloor(s: SpecWorld, ctx: PlaneContext, f: FloorMove): void {
  const res = tMovePlane(
    ctx, f.sector, f.speed, f.dest, f.crush, PLANE_FLOOR, f.direction
  );

  if (!(s.leveltime & 7)) floorSound(s, f.sector, SFX_STNMOV);

  if (res === 'pastdest') {
    setSectorSpecialData(s.sectors, f.sector, null);

    if (f.direction === DIR_UP) {
      // PIN: ONLY donutRaise applies special/flat on an UP arrival.
      if (f.type === FLOOR.donutRaise) {
        s.sectors.special[f.sector] = f.newspecial;
        applyFlat(s, f);
      }
    } else if (f.direction === DIR_DOWN) {
      // PIN: ONLY lowerAndChange applies on a DOWN arrival.
      if (f.type === FLOOR.lowerAndChange) {
        s.sectors.special[f.sector] = f.newspecial;
        applyFlat(s, f);
      }
    }
    pRemoveThinker(f);
    floorSound(s, f.sector, SFX_PSTOP);
  }
  syncFloorHash(f);
}

/** `sec->floorpic = floor->texture` — the override-channel write
 * (deviation (a)); `from` -1 = flat from the thinker capture site. */
function applyFlat(s: SpecWorld, f: FloorMove, from = -1): void {
  if (f.texture !== '') {
    floorFlatOverrides.set(f.sector, f.texture);
    floorsFlatCopies.count++;
    if (floorsFlatCopies.entries.length < 4096) {
      floorsFlatCopies.entries.push({ sector: f.sector, from, tic: s.leveltime });
    }
  }
}

/* ------------------------------------------------------------------ */
/* EV_DoFloor (p_floor.c:246-430)                                      */
/* ------------------------------------------------------------------ */

/**
 * `EV_DoFloor(line, floor_e)` — returns rtn (1 when any tagged sector got
 * a mover; specialdata-held sectors are skipped, "ALREADY MOVING? IF SO,
 * KEEP GOING...").
 */
export function evDoFloor(s: SpecWorld, line: number, type: number): boolean {
  const ctx = planeContext(s);
  let secnum = -1;
  let rtn = 0;
  while ((secnum = pFindSectorFromLineTag(s, line, secnum)) >= 0) {
    // ALREADY MOVING?  IF SO, KEEP GOING...
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;

    // new floor thinker
    rtn = 1;
    const fn: ThinkerFn = (self) => tMoveFloor(s, ctx, self as FloorMove);
    const thinker = pAddThinker(s.thinkers, fn);
    setSectorSpecialData(s.sectors, secnum, thinker);
    const f = Object.assign(thinker, {
      sector: secnum,
      type,
      crush: false,
      direction: 0,
      newspecial: 0,
      texture: '',
      dest: 0,
      speed: 0
    } as FloorState) as FloorMove;
    f.dest = s.sectors.floorZ[secnum]!;

    switch (type) {
      case FLOOR.lowerFloor:
        f.direction = DIR_DOWN;
        f.speed = FLOORSPEED;
        f.dest = pFindHighestFloorSurrounding(s, secnum);
        break;

      case FLOOR.lowerFloorToLowest:
        f.direction = DIR_DOWN;
        f.speed = FLOORSPEED;
        f.dest = pFindLowestFloorSurrounding(s, secnum);
        break;

      case FLOOR.turboLower: {
        f.direction = DIR_DOWN;
        f.speed = (FLOORSPEED * 4) | 0;
        f.dest = pFindHighestFloorSurrounding(s, secnum);
        // THE +8 QUIRK: only when the dest differs from the own floor.
        if (f.dest !== s.sectors.floorZ[secnum]!) f.dest = (f.dest + 8 * FRACUNIT) | 0;
        break;
      }

      // vanilla: `case raiseFloorCrush: floor->crush = true;` FALLS THROUGH
      // into raiseFloor (p_floor.c:308-320) — expressed as the equivalent
      // shared-label block (TS7029/eslint no-fallthrough safe form).
      case FLOOR.raiseFloorCrush:
      case FLOOR.raiseFloor: {
        if (type === FLOOR.raiseFloorCrush) f.crush = true;
        f.direction = DIR_UP;
        f.speed = FLOORSPEED;
        f.dest = pFindLowestCeilingSurrounding(s, secnum);
        if (f.dest > s.sectors.ceilingZ[secnum]!) f.dest = s.sectors.ceilingZ[secnum]!;
        // (floortype == raiseFloorCrush) multiplier: crush variant −8.
        f.dest = (f.dest - (8 * FRACUNIT * (type === FLOOR.raiseFloorCrush ? 1 : 0))) | 0;
        break;
      }

      case FLOOR.raiseFloorTurbo:
        f.direction = DIR_UP;
        f.speed = (FLOORSPEED * 4) | 0;
        f.dest = pFindNextHighestFloor(s, secnum, s.sectors.floorZ[secnum]!);
        break;

      case FLOOR.raiseFloorToNearest:
        f.direction = DIR_UP;
        f.speed = FLOORSPEED;
        f.dest = pFindNextHighestFloor(s, secnum, s.sectors.floorZ[secnum]!);
        break;

      case FLOOR.raiseFloor24:
        f.direction = DIR_UP;
        f.speed = FLOORSPEED;
        f.dest = (s.sectors.floorZ[secnum]! + 24 * FRACUNIT) | 0;
        break;

      case FLOOR.raiseFloor512:
        f.direction = DIR_UP;
        f.speed = FLOORSPEED;
        f.dest = (s.sectors.floorZ[secnum]! + 512 * FRACUNIT) | 0;
        break;

      case FLOOR.raiseFloor24AndChange: {
        f.direction = DIR_UP;
        f.speed = FLOORSPEED;
        f.dest = (s.sectors.floorZ[secnum]! + 24 * FRACUNIT) | 0;
        // Trigger-time copy from the USE LINE's front sector (flat via
        // the override channel, special live).
        const from = s.map.lines.sectorFront[line]!;
        floorFlatOverrides.set(secnum, floorFlatOf(s, from));
        floorsFlatCopies.count++;
        if (floorsFlatCopies.entries.length < 4096) {
          floorsFlatCopies.entries.push({ sector: secnum, from, tic: s.leveltime });
        }
        s.sectors.special[secnum] = s.sectors.special[from]!;
        break;
      }

      case FLOOR.raiseToTexture: {
        // Shortest bottomtexture around the sector (deviation (b): the
        // height table is injectable; '' side textures are vanilla's
        // bottomtexture == -1). dest is NOT floorheight-clamped, verbatim.
        let minsize = 0x7fffffff; // MAXINT
        for (let i = 0; i < s.map.sectors.lineCount[secnum]!; i++) {
          const ln = sectorLineAt(s.map, secnum, i);
          if (!twoSided(s.map, secnum, i)) continue;
          // getSide(secnum,i,0/1): both sides of a two-sided line.
          for (let side = 0; side < 2; side++) {
            const sideIdx = side === 0
              ? s.map.lines.sideNumFront[ln]!
              : s.map.lines.sideNumBack[ln]!;
            if (sideIdx < 0) continue;
            const tex = s.map.sides.bottomTexture[sideIdx]!;
            if (tex === '') continue; // vanilla: bottomtexture >= 0 gate
            const h = textureHeights.get(tex);
            if (h === undefined) {
              pfloorCounts.missingTextureHeight++;
              continue;
            }
            if (h < minsize) minsize = h;
          }
        }
        f.direction = DIR_UP;
        f.speed = FLOORSPEED;
        f.dest = (s.sectors.floorZ[secnum]! + minsize) | 0;
        break;
      }

      case FLOOR.lowerAndChange: {
        f.direction = DIR_DOWN;
        f.speed = FLOORSPEED;
        f.dest = pFindLowestFloorSurrounding(s, secnum);
        f.texture = floorFlatOf(s, secnum);

        // FIRST neighbour whose floor EQUALS the dest, in ascending
        // linedef order, fronts/backs per the getSide(secnum,i,0)-is-own
        // test of p_floor.c — copies flat AND newspecial (applied at
        // ARRIVAL: the damage floor appears under the lowered slab).
        for (let i = 0; i < s.map.sectors.lineCount[secnum]!; i++) {
          const ln = sectorLineAt(s.map, secnum, i);
          if (!twoSided(s.map, secnum, i)) continue;
          const front = s.map.lines.sectorFront[ln]!;
          const back = s.map.lines.sectorBack[ln]!;
          const other = front === secnum ? back : front;
          if (s.sectors.floorZ[other] === f.dest) {
            f.texture = floorFlatOf(s, other);
            f.newspecial = s.sectors.special[other]!;
            break;
          }
        }
        break;
      }
      default:
        break;
    }
    syncFloorHash(f);
  }
  return rtn !== 0;
}

/* ------------------------------------------------------------------ */
/* EV_BuildStairs (p_floor.c:437-540)                                  */
/* ------------------------------------------------------------------ */

/**
 * `EV_BuildStairs(line, stair_e)` — the classic stepped build: first
 * tagged sector gets dest = floor + stairsize, then the do-while chain
 * follows same-floorpic neighbours FORWARD (lines the current sector
 * fronts) in ascending linedef order, dest += stairsize per hop. PIN:
 * `height += stairsize` BEFORE the specialdata skip (a busy neighbour
 * consumes a step, the scan continues).
 */
export function evBuildStairs(s: SpecWorld, line: number, type: number): boolean {
  const ctx = planeContext(s);
  // PIN: vanilla EV_BuildStairs NEVER sets floor->type (uninitialised
  // Z_Malloc garbage in C; T_MoveFloor's arrival switch could match
  // donutRaise on garbage). The port pins a neutral raiseFloor — stairs
  // never apply special/flat (deterministic resolution of vanilla UB,
  // logged deviation).
  const spawnFloor = (sec: number, height: number, speed: number): void => {
    const fn: ThinkerFn = (self) => tMoveFloor(s, ctx, self as FloorMove);
    const thinker = pAddThinker(s.thinkers, fn);
    setSectorSpecialData(s.sectors, sec, thinker);
    const f = Object.assign(thinker, {
      sector: sec,
      type: FLOOR.raiseFloor,
      crush: false,
      direction: DIR_UP,
      newspecial: 0,
      texture: '',
      dest: height,
      speed
    } as FloorState) as FloorMove;
    syncFloorHash(f);
  };

  let secnum = -1;
  let rtn = 0;
  while ((secnum = pFindSectorFromLineTag(s, line, secnum)) >= 0) {
    // ALREADY MOVING?  IF SO, KEEP GOING...
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;

    // new floor thinker
    rtn = 1;
    let speed: number;
    let stairsize: number;
    if (type === STAIR.build8) {
      speed = (FLOORSPEED / 4) | 0;
      stairsize = 8 * FRACUNIT;
    } else {
      speed = (FLOORSPEED * 4) | 0;
      stairsize = 16 * FRACUNIT;
    }
    let height = (s.sectors.floorZ[secnum]! + stairsize) | 0;
    spawnFloor(secnum, height, speed);

    const texture = floorFlatOf(s, secnum);

    // Find next sector to raise
    // 1. Find 2-sided line with same sector side[0]
    // 2. Other side is the next sector to raise
    // PIN: the chain updates `secnum` itself — the OUTER tag scan
    // resumes from the LAST chained sector (vanilla `secnum = newsecnum`,
    // p_floor.c:525). `texture` is captured ONCE per tagged sector.
    let sec = secnum;
    let ok: number;
    do {
      ok = 0;
      for (let i = 0; i < s.map.sectors.lineCount[sec]!; i++) {
        const ln = sectorLineAt(s.map, sec, i);
        if ((s.map.lines.flags[ln]! & ML_TWOSIDED) === 0) continue;

        const front = s.map.lines.sectorFront[ln]!;
        if (secnum !== front) continue;

        const back = s.map.lines.sectorBack[ln]!;
        if (floorFlatOf(s, back) !== texture) continue;

        height = (height + stairsize) | 0; // PIN: BEFORE the busy check

        if (sectorSpecialData(s.sectors, back) !== null) continue;

        sec = back;
        secnum = back;
        spawnFloor(back, height, speed);
        ok = 1;
        break;
      }
    } while (ok);
  }
  return rtn !== 0;
}

/* ------------------------------------------------------------------ */
/* EV_DoDonut (p_spec.c:1163-1221, D013(b) ownership carve)            */
/* ------------------------------------------------------------------ */

/**
 * `EV_DoDonut(line)` — the two-sector classic: s2 (ring, across s1's
 * FIRST line) rises donutRaise to s3's floor with s3's flat and
 * special→newspecial=0; s1 (hole) lowers to the same dest. Ring mover is
 * spawned WITHOUT the s2 specialdata check (vanilla overwrite pin).
 */
export function evDoDonut(s: SpecWorld, line: number): boolean {
  const ctx = planeContext(s);
  let secnum = -1;
  let rtn = 0;
  while ((secnum = pFindSectorFromLineTag(s, line, secnum)) >= 0) {
    // ALREADY MOVING?  IF SO, KEEP GOING...  (s1 ONLY — pinned)
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;

    rtn = 1;
    const firstLine = sectorLineAt(s.map, secnum, 0);
    const s2 = getNextSector(s.map, firstLine, secnum);
    for (let i = 0; i < s.map.sectors.lineCount[s2]!; i++) {
      const ln = sectorLineAt(s.map, s2, i);
      // verbatim: NOT two-sided → skip; backsector == s1 → skip.
      if ((s.map.lines.flags[ln]! & 0x004) === 0) continue;
      const back = s.map.lines.sectorBack[ln]!;
      if (back === secnum) continue;
      const s3 = back;

      // Spawn rising slime (ring s2 — no specialdata check, pinned).
      spawnDonutMover(
        s, ctx, s2, FLOOR.donutRaise, DIR_UP, floorFlatOf(s, s3),
        s.sectors.floorZ[s3]!
      );
      // Spawn lowering donut-hole (s1).
      spawnDonutMover(
        s, ctx, secnum, FLOOR.lowerFloor, DIR_DOWN, '',
        s.sectors.floorZ[s3]!
      );
      break;
    }
  }
  return rtn !== 0;
}

function spawnDonutMover(
  s: SpecWorld,
  ctx: PlaneContext,
  sector: number,
  type: number,
  direction: number,
  texture: string,
  dest: number
): void {
  const fn: ThinkerFn = (self) => tMoveFloor(s, ctx, self as FloorMove);
  const thinker = pAddThinker(s.thinkers, fn);
  setSectorSpecialData(s.sectors, sector, thinker);
  const f = Object.assign(thinker, {
    sector,
    type,
    crush: false,
    direction,
    newspecial: 0, // donutRaise newspecial=0 (p_spec.c:1203); lowerFloor never reads it
    texture,
    dest,
    speed: (FLOORSPEED / 2) | 0
  } as FloorState) as FloorMove;
  syncFloorHash(f);
}
