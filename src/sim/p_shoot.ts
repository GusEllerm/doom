// sim/p_shoot.ts — hitscan aim/attack/shoot traverse (linuxdoom-1.10
// p_map.c "LINE ATTACK" section, M7-08, M7-plan §M7-08).
//
// MIRROR (62-.c check): /tmp/DOOM-master/linuxdoom-1.10/p_map.c — the
// section p_map.c:785-1096 is THIS file's source of truth:
//   linetarget/shootthing/shootz/la_damage/attackrange/aimslope globals :787-806
//   PTR_AimTraverse      p_map.c:812-905  (verbatim body mirrored below)
//   PTR_ShootTraverse    p_map.c:910-1013 (verbatim body mirrored below)
//   P_AimLineAttack      p_map.c:1020-1053 (verbatim; quoted in R08 §3.1)
//   P_LineAttack         p_map.c:1058-1088 (verbatim; R08 §3.2)
// The autoaim probe SEQUENCE (P_BulletSlope, p_pspr.c:487-505) is p_pspr
// -owned and already lives there (M7-07) — this module supplies the real
// P_AimLineAttack/P_LineAttack it probes through, registering them into
// the p_pspr.ts hook table (psprHooks.aimLineAttack/lineAttack +
// pointToAngle2 for the A_Punch/A_Saw turn-to-face, rmath R_PointToAngle2
// via the pslide.ts R_PointToAngle twin). P_SpawnPuff/P_SpawnBlood live in
// p_mobj.ts (M7-02, R08 §3.4 correction); the state tables are referenced
// only through those helpers.
//
// WIRING (plan §M7-08 "pmaputl thing-intercept CONSUMER — no edit"): the
// deferred M7-02 note ("PT_ADDTHINGS consumers arrive with the shooters")
// is wired HERE — both traversers read the ThingLinks slot grid built by
// pitAddThingIntercepts. The pmap PIT_CheckThing hook slots (missile hit =
// M7-09, MF_SPECIAL touch = M7-04, telefrag/skullfly = M8) are NOT p_map.c
// shoot-traverse call sites and stay with their owners.
//
// P_DamageMobj (p_inter.c, M7-05-era) does not exist yet: the hit branch
// calls the hooks.ts damageSlot with the EXACT vanilla arg shape —
// P_DamageMobj(th, shootthing, shootthing, la_damage) ⇒
// (thing = target's ThingLinks slot id — the same identifier convention as
// every other damageSlot call site: pmap.ts crush, ptelept telefrag,
// pspec damage floors; source = shooter's slot id or null, tic =
// leveltime). When p_inter.ts lands it replaces the SLOT BODY, never this
// call site (hooks.ts rule).
//
// P_ShootSpecialLine dispatch (p_spec.c IMPACT specials, M6-plan §0.10(c)
// contract "M7 adds only the shooting dispatch") calls the LIVE pspec.ts
// body verbatim at the vanilla site — FIRST thing in the line branch,
// BEFORE the two-sided/block test, so every crossed special line fires in
// crossing order.
//
// Vanilla-globals rule (ARCH §3.5.5 / pmaputl.ts idiom): ALL traverser
// state (linetarget, shootthing, shootz, topslope/bottomslope,
// attackrange, aimslope, la_damage) is module-level — one traversal in
// flight, steady-state calls allocate nothing on the traverse path.
// `attackrange` IS p_mobj.ts's shared cell (P_SpawnPuff's MELEERANGE
// variant test reads the same global, p_mobj.c:826).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANGLETOFINESHIFT, FRACBITS, FRACUNIT } from '../core/constants';
import { FixedDiv, FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { damageSlot } from './hooks';
import { pPathTraverse, pLineOpening, pathTrace, opening, PT_ADDLINES, PT_ADDTHINGS, type Intercept } from './pmaputl';
import { MF_SHOOTABLE, MF_NOBLOOD } from './thinglinks';
import type { Mover, PMapWorld } from './pmap';
import { SKYFLATNAME } from './pmove';
import { attackRange, pSpawnBlood, pSpawnPuff, type MobjRuntime } from './p_mobj';
import { pShootSpecialLine } from './pspec';
import { pointToAngleOrigin } from './pslide';
import { ML_TWOSIDED } from './pspec-helpers';
import type { SpecWorld } from './pspec-helpers';
import {
  psprHookCounts,
  registerPsprHook,
  type AimResult,
  type AttackResult,
  type PsprPlayer,
} from './p_pspr';

/* ------------------------------------------------------------------ */
/* The bound level (vanilla: "the current level's sectors/lines")        */
/* ------------------------------------------------------------------ */

/**
 * The bound level = the ONE GameState (constructor back-references
 * excluded). Extending {@link SpecWorld} rather than re-listing map/sectors/
 * thinkers/hooks/rng/leveltime is deliberate: `P_ShootSpecialLine` runs the
 * M6 dispatch tables against the SAME level object (thinker arena, live
 * sector SoA, hook slots), so the cross-referencing cast the earlier draft
 * needed disappears — the traverser hands pspec the level it already holds.
 * `pmap` is M7-02's clipping world (blockmap + ThingLinks grid) — CONSUMED
 * here, never edited (plan §M7-08 "pmaputl thing-intercept consumer").
 */
export interface ShootWorld extends SpecWorld {
  readonly pmap: PMapWorld;
  readonly mobjs: MobjRuntime;
}

let bound: ShootWorld | null = null;

/** gInitGame / fixture boot binds the level (same idiom as
 * bindPsprWorld / bindSpecialsWorld). */
export function bindShootWorld(w: ShootWorld | null): void {
  bound = w;
}

export function boundShootWorld(): ShootWorld | null {
  return bound;
}

function requireWorld(): ShootWorld {
  if (!bound) throw new Error('p_shoot: world not bound (call bindShootWorld)');
  return bound;
}

/* ------------------------------------------------------------------ */
/* p_map.c:787-806 file-scope globals (module statics)                  */
/* ------------------------------------------------------------------ */

/** `mobj_t *linetarget` — who got hit (or NULL). The port keeps the slot
 * id plus the coordinates (A_Punch/A_Saw turn-to-face reads x/y);
 * A_BFGSpray (M7-09/M8) reads `active`. */
export const linetarget = {
  /** false ⇔ vanilla NULL */
  active: false,
  /** ThingLinks slot of the hit mobj (−1 when inactive) */
  slot: -1,
  x: 0,
  y: 0,
};

/** `mobj_t *shootthing` — the mover firing (Mover slice + angle for the
 * missile consumers later; players carry `player: true`). */
let shootThing: Mover | null = null;
/** slot identity of shootthing (`th == shootthing` pointer compare ⇒
 * ThingLinks slot compare, the port's mover-identity convention). */
let shootThingSlot = -1;

/** `fixed_t shootz` — "Height if not aiming up or down ???: use slope
 * for monsters?" */
let shootz = 0;
/** `int la_damage` */
let laDamage = 0;
/** `fixed_t aimslope` */
export const aimslopeG = { value: 0 };
/** `extern fixed_t topslope/bottomslope` (defined in r_main.c; the
 * p_local.h externs p_map.c reads) — the aim cone here, the visplanes
 * there. Local pair (the renderer keeps its own copy). */
let topslope = 0;
let bottomslope = 0;

/** p_map.c:811 `slopes to top and bottom of target` — PTR-local pair
 * re-read per branch; kept module-level for greppability. */
let thingtopslope = 0;
let thingbottomslope = 0;

/** p_local.h ML_TWOSIDED = 0x004 (re-exported by pspec-helpers). */
const ML_TWOSIDED_FLAG = ML_TWOSIDED;

/** Test/debug readout of the globals block (never hashed). */
export function shootGlobals(): Readonly<{
  shootz: number;
  laDamage: number;
  aimslope: number;
  topslope: number;
  bottomslope: number;
  attackrange: number;
}> {
  return {
    shootz,
    laDamage: laDamage,
    aimslope: aimslopeG.value,
    topslope,
    bottomslope,
    attackrange: attackRange.value,
  };
}

/** Reset for cross-world reuse (module globals are per-level in spirit —
 * every value is fully re-written by each P_AimLineAttack/P_LineAttack
 * preamble; this only clears the linetarget residual). */
export function resetShootGlobals(): void {
  linetarget.active = false;
  linetarget.slot = -1;
  linetarget.x = 0;
  linetarget.y = 0;
  shootThing = null;
  shootThingSlot = -1;
  shootz = 0;
  laDamage = 0;
  aimslopeG.value = 0;
}

/* ------------------------------------------------------------------ */
/* Helper: the p_map.c "thing is in the chain" reads                    */
/* ------------------------------------------------------------------ */

/** Thing z/flags/height reads come from the ThingLinks mirror (the grid
 * owns z for static slots; syncMobj keeps dynamic slots current —
 * p_mobj.ts rule). */
function thingFlags(slot: number): number {
  return bound!.pmap.links.flags[slot]!;
}
function thingZ(slot: number): number {
  return bound!.pmap.links.z[slot]!;
}
function thingHeight(slot: number): number {
  return bound!.pmap.links.height[slot]!;
}

/* ------------------------------------------------------------------ */
/* PTR_AimTraverse — p_map.c:812-905 verbatim                           */
/* ------------------------------------------------------------------ */

/**
 * `PTR_AimTraverse` — sets linetarget and aimslope when a target is aimed
 * at. Line branch: !ML_TWOSIDED ⇒ stop (a wall); two-sided ⇒ P_LineOpening
 * narrows the [bottomslope, topslope] band (openbottom >= opentop ⇒ stop —
 * a closed door); floor-height difference can RAISE bottomslope, ceiling
 * difference can LOWER topslope; band collapse (top <= bottom) ⇒ stop.
 * Thing branch: self / non-MF_SHOOTABLE pass over, slope-box vs band,
 * clamp + `aimslope = (thingtopslope+thingbottomslope)/2`, stop.
 */
export function ptrAimTraverse(in_: Intercept): boolean {
  const w = requireWorld();
  let slope: number;

  if (in_.isLine) {
    const line = in_.line;
    const L = w.map.lines;

    if ((L.flags[line]! & ML_TWOSIDED_FLAG) === 0) {
      return false; // stop — a wall
    }
    if (L.sideNumBack[line] === -1) {
      // Deviation (documented): vanilla dereferences a NULL backsector here
      // (crash); the port treats the flag-inconsistent line as a stop.
      return false;
    }

    // Crosses a two sided line.
    // A two sided line will restrict the possible target ranges.
    pLineOpening(w.map, line, w.sectors);

    if (opening.openbottom >= opening.opentop) {
      return false; // stop
    }

    const dist = FixedMul(attackRange.value, in_.frac);

    const f = L.sectorFront[line]!;
    const b = L.sectorBack[line]!;
    const floorF = w.sectors.floorZ[f]!;
    const floorB = w.sectors.floorZ[b]!;
    const ceilF = w.sectors.ceilingZ[f]!;
    const ceilB = w.sectors.ceilingZ[b]!;

    // vanilla compares li->frontsector->floorheight != backsector-> —
    // the LIVE sectors (one-array authority, state.ts).
    if (floorF !== floorB) {
      slope = FixedDiv((opening.openbottom - shootz) | 0, dist);
      if (slope > bottomslope) bottomslope = slope;
    }

    if (ceilF !== ceilB) {
      slope = FixedDiv((opening.opentop - shootz) | 0, dist);
      if (slope < topslope) topslope = slope;
    }

    if (topslope <= bottomslope) {
      return false; // stop
    }

    return true; // shot continues
  }

  // shoot a thing
  const th = in_.thing;
  if (th === shootThingSlot) return true; // can't shoot self

  if ((thingFlags(th) & MF_SHOOTABLE) === 0) return true; // corpse or something

  // check angles to see if the thing can be aimed at
  const dist = FixedMul(attackRange.value, in_.frac);
  thingtopslope = FixedDiv((thingZ(th) + thingHeight(th) - shootz) | 0, dist);

  if (thingtopslope < bottomslope) return true; // shot over the thing

  thingbottomslope = FixedDiv((thingZ(th) - shootz) | 0, dist);

  if (thingbottomslope > topslope) return true; // shot under the thing

  // this thing can be hit!
  if (thingtopslope > topslope) thingtopslope = topslope;
  if (thingbottomslope < bottomslope) thingbottomslope = bottomslope;

  // C: (a+b)/2 on the ROUNDED pair — /2 of two int32s truncates toward
  // zero exactly like FixedDiv(x, 2*FRACUNIT) for same-sign sums.
  aimslopeG.value = ((thingtopslope + thingbottomslope) / 2) | 0;
  linetarget.active = true;
  linetarget.slot = th;
  linetarget.x = w.pmap.links.x[th]!;
  linetarget.y = w.pmap.links.y[th]!;

  return false; // don't go any farther
}

/* ------------------------------------------------------------------ */
/* PTR_ShootTraverse — p_map.c:910-1013 verbatim                        */
/* ------------------------------------------------------------------ */

/**
 * `PTR_ShootTraverse`: line special fires FIRST (every crossed line,
 * before the block test — M6-plan §0.10c contract), !ML_TWOSIDED ⇒
 * hitline; two-sided openness vs aimslope decides continue/hit; hitline
 * pulls the impact back 4 units (`frac − FixedDiv(4*FRACUNIT,
 * attackrange)`), sky-front above-ceiling shots and both-sky "sky hack"
 * walls spawn NO puff; otherwise P_SpawnPuff + stop. Thing branch: self /
 * non-shootable pass; over/under vs aimslope pass; hit pulls back 10,
 * MF_NOBLOOD ⇒ puff else blood(la_damage), then
 * P_DamageMobj(th, shootthing, shootthing, la_damage) when la_damage ≠ 0.
 */
export function ptrShootTraverse(in_: Intercept): boolean {
  const w = requireWorld();

  if (in_.isLine) {
    const line = in_.line;
    const L = w.map.lines;

    if (L.special[line] !== 0) {
      // P_ShootSpecialLine (shootthing = the MOVER; the player branch
      // gates on `thing.player`, pspec.ts).
      pShootSpecialLine(w, shootThing!, line);
    }

    if ((L.flags[line]! & ML_TWOSIDED_FLAG) === 0) {
      // goto hitline
      return hitLine(line, in_.frac);
    }
    if (L.sideNumBack[line] === -1) return hitLine(line, in_.frac); // see aim-side note

    // crosses a two sided line
    pLineOpening(w.map, line, w.sectors);

    const dist = FixedMul(attackRange.value, in_.frac);

    const f = L.sectorFront[line]!;
    const b = L.sectorBack[line]!;

    if (w.sectors.floorZ[f] !== w.sectors.floorZ[b]) {
      const slope = FixedDiv((opening.openbottom - shootz) | 0, dist);
      if (slope > aimslopeG.value) return hitLine(line, in_.frac);
    }

    if (w.sectors.ceilingZ[f] !== w.sectors.ceilingZ[b]) {
      const slope = FixedDiv((opening.opentop - shootz) | 0, dist);
      if (slope < aimslopeG.value) return hitLine(line, in_.frac);
    }

    // shot continues
    return true;

    // hit line — a labeled block, hoisted into the helper below (no
    // gotos in TS; identical control flow).
  }

  // shoot a thing
  const th = in_.thing;
  if (th === shootThingSlot) return true; // can't shoot self

  if ((thingFlags(th) & MF_SHOOTABLE) === 0) return true; // corpse or something

  // check angles to see if the thing can be aimed at
  const dist = FixedMul(attackRange.value, in_.frac);
  thingtopslope = FixedDiv((thingZ(th) + thingHeight(th) - shootz) | 0, dist);

  if (thingtopslope < aimslopeG.value) return true; // shot over the thing

  thingbottomslope = FixedDiv((thingZ(th) - shootz) | 0, dist);

  if (thingbottomslope > aimslopeG.value) return true; // shot under the thing

  // hit thing — position a bit closer
  const frac = (in_.frac - FixedDiv(10 * FRACUNIT, attackRange.value)) | 0;

  const tr = pathTrace();
  const x = (tr.x + FixedMul(tr.dx, frac)) | 0;
  const y = (tr.y + FixedMul(tr.dy, frac)) | 0;
  const z = (shootz + FixedMul(aimslopeG.value, FixedMul(frac, attackRange.value))) | 0;

  // Spawn bullet puffs or blood spots, depending on target type.
  if ((thingFlags(th) & MF_NOBLOOD) !== 0) pSpawnPuff(w.mobjs, x, y, z);
  else pSpawnBlood(w.mobjs, x, y, z, laDamage);

  // P_DamageMobj (th, shootthing, shootthing, la_damage) — the p_inter
  // (M7) body lands in the damageSlot later; arg shape pinned above.
  if (laDamage !== 0) {
    damageSlot(w.hooks, th, laDamage, shooterSourceId(), w.leveltime);
  }

  // NOTE (verbatim 1.10): the SHOOT traverse does NOT write `linetarget` —
  // only PTR_AimTraverse does; the A_Punch `if (linetarget)` turn-to-face
  // reads whatever the preceding P_AimLineAttack left (p_pspr.c:352-380
  // aims first at the same angle/range, so the pairing is consistent).

  // don't go any farther
  return false;
}

/** hitline: (p_map.c:956-984) pull back 4 units, sky tests, puff. */
function hitLine(line: number, inFrac: number): boolean {
  const w = requireWorld();
  const L = w.map.lines;

  // position a bit closer
  const tr = pathTrace();
  const frac = (inFrac - FixedDiv(4 * FRACUNIT, attackRange.value)) | 0;
  const x = (tr.x + FixedMul(tr.dx, frac)) | 0;
  const y = (tr.y + FixedMul(tr.dy, frac)) | 0;
  const z = (shootz + FixedMul(aimslopeG.value, FixedMul(frac, attackRange.value))) | 0;

  const f = L.sectorFront[line]!;
  if (w.map.sectors.ceilingFlat[f] === SKYFLATNAME) {
    // don't shoot the sky!
    if (z > w.sectors.ceilingZ[f]!) return false;

    // it's a sky hack wall (backsector && back ceiling is sky too)
    const b = L.sideNumBack[line];
    if (b !== -1 && w.map.sectors.ceilingFlat[L.sectorBack[line]!] === SKYFLATNAME) {
      return false;
    }
  }

  // Spawn bullet puffs.
  pSpawnPuff(w.mobjs, x, y, z);

  // don't go any farther
  return false;
}

/** `shootthing`'s damageSlot source id: slot id (the identity every
 * damageSlot call site uses), null when the shooter is not in the grid. */
function shooterSourceId(): number | null {
  return shootThingSlot >= 0 ? shootThingSlot : null;
}

/* ------------------------------------------------------------------ */
/* P_AimLineAttack — p_map.c:1020-1053 verbatim (R08 §3.1 quote)        */
/* ------------------------------------------------------------------ */

/**
 * `P_AimLineAttack(t1, angle, distance)` — autoaim: fire an eyebeam from
 * `z + height/2 + 8*FRACUNIT` across `distance`, cone clamped to
 * ±(100*FRACUNIT/160); returns aimslope when a shootable thing was aimed
 * at, else 0 (and leaves linetarget NULL). Writes the shared
 * `attackrange` cell p_mobj.P_SpawnPuff's melee test reads.
 */
export function pAimLineAttack(t1: Mover, angle: number, distance: number): number {
  const w = requireWorld();
  const fine = angle >>> ANGLETOFINESHIFT; // angle_t, unsigned shift

  shootThing = t1;
  shootThingSlot = t1.linkSlot ?? -1;

  const x2 = (t1.x + ((distance >> FRACBITS) * finecosine[fine]!)) | 0;
  const y2 = (t1.y + ((distance >> FRACBITS) * finesine[fine]!)) | 0;
  shootz = (t1.z + (t1.height >> 1) + 8 * FRACUNIT) | 0;

  // can't shoot outside view angles
  topslope = ((100 * FRACUNIT) / 160) | 0;
  bottomslope = ((-100 * FRACUNIT) / 160) | 0;

  attackRange.value = distance;
  linetarget.active = false;
  linetarget.slot = -1;

  pPathTraverse(
    w.map,
    w.pmap.bm,
    t1.x,
    t1.y,
    x2,
    y2,
    PT_ADDLINES | PT_ADDTHINGS,
    ptrAimTraverse,
    w.pmap.links,
  );

  if (linetarget.active) return aimslopeG.value;
  return 0;
}

/* ------------------------------------------------------------------ */
/* P_LineAttack — p_map.c:1058-1088 verbatim                            */
/* ------------------------------------------------------------------ */

/**
 * `P_LineAttack(t1, angle, distance, slope, damage)` — if damage == 0 it
 * is just a test trace that will leave linetarget set.
 */
export function pLineAttack(
  t1: Mover,
  angle: number,
  distance: number,
  slope: number,
  damage: number,
): void {
  const w = requireWorld();
  const fine = angle >>> ANGLETOFINESHIFT;

  shootThing = t1;
  shootThingSlot = t1.linkSlot ?? -1;
  laDamage = damage;

  const x2 = (t1.x + ((distance >> FRACBITS) * finecosine[fine]!)) | 0;
  const y2 = (t1.y + ((distance >> FRACBITS) * finesine[fine]!)) | 0;
  shootz = (t1.z + (t1.height >> 1) + 8 * FRACUNIT) | 0;
  attackRange.value = distance;
  aimslopeG.value = slope;

  // NOTE (verbatim): P_LineAttack does NOT reset `linetarget` (only
  // P_AimLineAttack assigns `linetarget = NULL`); the “test trace leaves
  // linetarget set” comment refers to that retained AIM result.

  pPathTraverse(
    w.map,
    w.pmap.bm,
    t1.x,
    t1.y,
    x2,
    y2,
    PT_ADDLINES | PT_ADDTHINGS,
    ptrShootTraverse,
    w.pmap.links,
  );
}

/* ------------------------------------------------------------------ */
/* R_PointToAngle2 (rmath.h — the A_Punch/A_Saw turn-to-face reads)     */
/* ------------------------------------------------------------------ */

/**
 * `R_PointToAngle2(x1,y1,x2,y2)` = `R_PointToAngle(x2−x1, y2−y1)` — the
 * pslide.ts {@link pointToAngleOrigin} IS the 1.10 R_PointToAngle
 * (tangetable algorithm, `>>8` pre-shifts), applied to the delta.
 */
export function rPointToAngle2(x1: number, y1: number, x2: number, y2: number): number {
  return pointToAngleOrigin((x2 - x1) | 0, (y2 - y1) | 0) >>> 0;
}

/* ------------------------------------------------------------------ */
/* pspr.ts hook registration (module-load; pslide self-register idiom)  */
/* ------------------------------------------------------------------ */

// The A_Fire* bodies (p_pspr.ts, M7-07) call P_AimLineAttack/P_LineAttack/
// R_PointToAngle2 through the typed slots; the bulletSlope PROBE stays
// p_pspr-owned (its own P_BulletSlope shell probes THIS aimLineAttack —
// the 3-probe nesting and probe counts are exact).
const NO_HIT: AimResult = { slope: 0, hit: false };
const NO_TARGET: AttackResult = { hit: false, x: 0, y: 0 };

/** Install the three M7-08 slots (idempotent). Called at module load — the
 * pslide self-registration idiom — and re-callable by tests after a
 * `resetPsprHooks()` restores the counted no-op defaults. `bulletSlope`
 * intentionally stays p_pspr.c's probe shell (p_pspr.c owns P_BulletSlope);
 * it probes OUR aimLineAttack, so the 1/2/3 probe counts are exact. */
export function registerShootPsprHooks(): void {
  registerPsprHook(
    'aimLineAttack',
    (p: PsprPlayer, angle: number, range: number): AimResult => {
      psprHookCounts.aimLineAttack++;
      if (!bound) return NO_HIT;
      return { slope: pAimLineAttack(p.mo, angle, range), hit: linetarget.active };
    },
  );

  registerPsprHook(
    'lineAttack',
    (p: PsprPlayer, angle: number, range: number, slope: number, damage: number): AttackResult => {
      psprHookCounts.lineAttack++;
      if (!bound) return NO_TARGET;
      pLineAttack(p.mo, angle, range, slope, damage);
      return { hit: linetarget.active, x: linetarget.x, y: linetarget.y };
    },
  );

  registerPsprHook('pointToAngle2', (x1: number, y1: number, x2: number, y2: number) => {
    psprHookCounts.pointToAngle2++;
    return rPointToAngle2(x1, y1, x2, y2);
  });
}

registerShootPsprHooks();
