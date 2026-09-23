// SPDX-License-Identifier: GPL-2.0-or-later
// sim/plights.ts — light thinkers (p_lights.c). M6-09 REPLACES the M6-03
// stub bodies verbatim from /tmp/DOOM-master/linuxdoom-1.10/p_lights.c.
// Parent: M6-plan §M6-09. Registry wiring (sector specials 1/2/3/4/8/12/13/17
// → these spawners, line ids 12/13/17/35/79/80/81/104/138/139 → the EV_*
// entry points) is the pspec.ts/specials-table.ts data table from M6-03 —
// NOTHING here routes special numbers.
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against p_lights.c this pass)
// ---------------------------------------------------------------------------
// THINKERS (never removed — they live for the level; sector->specialdata is
// NEVER set by a light mover, p_lights.c touches it nowhere; EV_StartLight-
// Strobing merely SKIPS sectors where some other mover owns it):
//   • T_FireFlicker (special 17): `if (--count) return;` — ONE P_Random per
//     4 tics (count re-armed to 4): amount = (P_Random()&3)*16; light =
//     maxlight − amount, floored at minlight = surroundings-min + 16.
//     SPAWN: ZERO draws (count = 4 fixed).
//   • T_LightFlash (special 1): one P_Random per polarity FLIP only:
//     going dark count = (P_Random()&mintime=7)+1 ∈ 1..8 (low nibble),
//     going bright count = (P_Random()&maxtime=64)+1 ∈ {1, 65} — the
//     single-bit mask 64 (NOT 7/63): the lit phase lasts 1 tic half the
//     time and 65 tics the other half (vanilla quirk kept).
//     SPAWN: ONE draw (count = (P_Random()&64)+1, the maxtime mask).
//   • T_StrobeFlash (specials 2/3/4/12/13): ZERO draws per tic; duty =
//     brighttime = STROBEBRIGHT = 5 lit / darktime = FASTDARK 15 (2/4/13)
//     or SLOWDARK 35 (3/12) dark (p_spec.h:176-179). The `== minlight`
//     test means a sector that is neither at min nor max (only possible
//     via the min==max→0 fixup below) takes the DARK branch on its first
//     flip — reproduced. SPAWN: inSync 1 → count = 1, ZERO draws;
//     inSync 0 → count = (P_Random()&7)+1, ONE draw.
//   • T_Glow (special 8): SILENT (zero P_Random ever), no count: every tic
//     light ∓= GLOWSPEED = 8 with the bounce arm `light ±= GLOWSPEED;
//     direction = ∓1` — the level is clamped to exactly min/max at the
//     turn. SPAWN: ZERO draws, direction = −1 (starts DOWN).
//     Total steady-state draw rate: fireflicker 0.25/tic, flash 1 per flip,
//     strobe 0/tic (1 at spawn unless sync), glow 0 — the ONLY load-time
//     draws from the sector pass are one per special-1 and one per
//     NON-sync strobe (2/3/4) sector; specials 8/12/13/17 never touch the
//     P_Random stream (plan acceptance 4: sync-strobe load is
//     deterministic, count = 1).
// SECTOR special CLEAR: the spawn bodies clear `sector.special = 0` at the
// vanilla call-site position (p_lights.c: "nothing special about it during
// gameplay"); pspec.ts then re-writes the registry `clearTo` AFTER the
// spawn call — value-identical in every case, and case 4's
// clear-then-rewrite-4 order (p_spec.c) is preserved exactly (pspec.ts
// header note honoured).
// LIGHT WRITES go straight to the live sector SoA (state.sectors.light —
// the M6-01 seam; there is no sectorSetLight function in the tree, the
// Int32Array IS the accessor). RENDERER GAP (documented, NOT wired — the
// plan forbids render/** edits here): src/render/rdata.ts still consumes
// its OWN COPY of the static load-time md.sectors, so live light changes
// are invisible to the 3D frame until the render side re-points at the
// state.sectors seam (M6-01 header callout; M6-13 follow-up).
//
// HASHED PAYLOAD (state.ts hashes thinker.hashWords in arena order): each
// light thinker carries words = [kind, count|direction] updated in place
// (the light level itself hashes via the sector SoA; kind+count carry what
// the SoA cannot: time-until-next-flip and the glow phase).
// KIND codes (payload census words, fixed forever):
import { SLOWDARK } from './specials-table';
import {
  pFindMinSurroundingLight, pFindSectorFromLineTag, getNextSector
} from './pspec-helpers';
import type { SpecWorld } from './pspec-helpers';
import { pAddThinker, sectorSpecialData } from './ptick';
import type { Thinker } from './ptick';
import { pRandom } from './prng';

export const LIGHT_THINKER_KINDS = Object.freeze({
  fireFlicker: 1, lightFlash: 2, strobe: 3, glow: 4
} as const);

// p_spec.h:176-177.
export const GLOWSPEED = 8;
export const STROBEBRIGHT = 5;

/* ------------------------------------------------------------------ */
/* thinker payloads (fireflicker_t / lightflash_t / strobe_t / glow_t)  */
/* ------------------------------------------------------------------ */

export interface FireFlickerThinker extends Thinker {
  readonly kind: 'fireflicker';
  sector: number; maxlight: number; minlight: number; count: number;
  words: number[];
}
export interface LightFlashThinker extends Thinker {
  readonly kind: 'lightflash';
  sector: number; maxlight: number; minlight: number;
  maxtime: number; mintime: number; count: number;
  words: number[];
}
export interface StrobeThinker extends Thinker {
  readonly kind: 'strobe';
  sector: number; maxlight: number; minlight: number;
  darktime: number; brighttime: number; count: number;
  words: number[];
}
export interface GlowThinker extends Thinker {
  readonly kind: 'glow';
  sector: number; minlight: number; maxlight: number; direction: number;
  words: number[];
}
export type LightThinker =
  FireFlickerThinker | LightFlashThinker | StrobeThinker | GlowThinker;

/** Allocate a payload-backed thinker: the payload object IS the arena
 * entry (vanilla Z_Malloc + P_AddThinker(&s->thinker)), and its `words`
 * pair is the hashed payload (aliased onto Thinker.hashWords — the same
 * array, mutated in place, zero per-tic allocation). */
function addLightThinker(
  s: SpecWorld, fn: (self: Thinker) => void, kind: LightThinker['kind'],
  words: number[]
): Thinker & { kind: LightThinker['kind']; words: number[] } {
  const t = pAddThinker(s.thinkers, fn) as
    Thinker & { kind: LightThinker['kind']; words: number[] };
  t.kind = kind;
  t.words = words;
  t.hashWords = words;
  return t;
}

/* ------------------------------------------------------------------ */
/* T_* thinker bodies (registered via closures over the world)          */
/* ------------------------------------------------------------------ */

/** `T_FireFlicker` — p_lights.c:39-55. 1 P_Random / 4 tics. */
export function tFireFlicker(s: SpecWorld, self: Thinker): void {
  const flick = self as unknown as FireFlickerThinker;
  flick.count--;
  flick.words[1] = flick.count; // hashed countdown (port bookkeeping)
  if (flick.count) return;

  const amount = (pRandom(s.rng) & 3) * 16;

  const li = s.sectors.light;
  if (li[flick.sector]! - amount < flick.minlight) li[flick.sector] = flick.minlight;
  else li[flick.sector] = flick.maxlight - amount;

  flick.count = 4;
  flick.words[1] = flick.count;
}

/** `T_LightFlash` — p_lights.c:90-105. One P_Random per polarity flip. */
export function tLightFlash(s: SpecWorld, self: Thinker): void {
  const flash = self as unknown as LightFlashThinker;
  flash.count--;
  flash.words[1] = flash.count; // hashed countdown (port bookkeeping)
  if (flash.count) return;

  const li = s.sectors.light;
  if (li[flash.sector] === flash.maxlight) {
    li[flash.sector] = flash.minlight;
    flash.count = (pRandom(s.rng) & flash.mintime) + 1;
  } else {
    li[flash.sector] = flash.maxlight;
    flash.count = (pRandom(s.rng) & flash.maxtime) + 1;
  }
  flash.words[1] = flash.count;
}

/** `T_StrobeFlash` — p_lights.c:162-175. Silent (no draws). */
export function tStrobeFlash(s: SpecWorld, self: Thinker): void {
  const flash = self as unknown as StrobeThinker;
  flash.count--;
  flash.words[1] = flash.count; // hashed countdown (port bookkeeping)
  if (flash.count) return;

  const li = s.sectors.light;
  if (li[flash.sector] === flash.minlight) {
    li[flash.sector] = flash.maxlight;
    flash.count = flash.brighttime;
  } else {
    li[flash.sector] = flash.minlight;
    flash.count = flash.darktime;
  }
  flash.words[1] = flash.count;
}

/** `T_Glow` — p_lights.c:313-340. Silent, no count; bounce-clamped ±8. */
export function tGlow(s: SpecWorld, self: Thinker): void {
  const g = self as unknown as GlowThinker;
  const li = s.sectors.light;
  switch (g.direction) {
    case -1: // DOWN
      li[g.sector] = li[g.sector]! - GLOWSPEED;
      if (li[g.sector]! <= g.minlight) {
        li[g.sector] = li[g.sector]! + GLOWSPEED;
        g.direction = 1;
      }
      break;
    case 1: // UP
      li[g.sector] = li[g.sector]! + GLOWSPEED;
      if (li[g.sector]! >= g.maxlight) {
        li[g.sector] = li[g.sector]! - GLOWSPEED;
        g.direction = -1;
      }
      break;
  }
  g.words[1] = g.direction;
}

/* ------------------------------------------------------------------ */
/* P_Spawn* — the sector-special spawners (P_SpawnSpecials sector pass) */
/* ------------------------------------------------------------------ */

/** `P_SpawnFireFlicker(sector)` — p_lights.c:60-81; sector special 17.
 * ZERO P_Random draws (count = 4). minlight = min surrounding + 16. */
export function pSpawnFireFlicker(s: SpecWorld, sector: number): void {
  const light = s.sectors.light[sector]!;
  const t = addLightThinker(
    s, (self) => tFireFlicker(s, self), 'fireflicker',
    [LIGHT_THINKER_KINDS.fireFlicker, 4]
  ) as unknown as FireFlickerThinker;
  t.sector = sector;
  t.maxlight = light;
  t.minlight = pFindMinSurroundingLight(s, sector, light) + 16;
  t.count = 4;
  // Note that we are resetting sector attributes.
  s.sectors.special[sector] = 0;
}

/** `P_SpawnLightFlash(sector)` — p_lights.c:110-134; sector special 1.
 * ONE P_Random draw at spawn (count = (P_Random()&64)+1 — the maxtime
 * mask, pinned). */
export function pSpawnLightFlash(s: SpecWorld, sector: number): void {
  const light = s.sectors.light[sector]!;
  const t = addLightThinker(
    s, (self) => tLightFlash(s, self), 'lightflash',
    [LIGHT_THINKER_KINDS.lightFlash, 0]
  ) as unknown as LightFlashThinker;
  t.sector = sector;
  t.maxlight = light;
  t.minlight = pFindMinSurroundingLight(s, sector, light);
  t.maxtime = 64;
  t.mintime = 7;
  t.count = (pRandom(s.rng) & t.maxtime) + 1;
  t.words[1] = t.count;
  // nothing special about it during gameplay
  s.sectors.special[sector] = 0;
}

/** `P_SpawnStrobeFlash(sector, fastOrSlow, inSync)` — p_lights.c:180-211;
 * sector specials 2/3/4 (inSync 0 → ONE draw) and 12/13 (inSync 1 → ZERO
 * draws, count = 1 — plan acceptance 4). min==max → min = 0 (the sealed
 * room strobes to black). */
export function pSpawnStrobeFlash(
  s: SpecWorld, sector: number, darktime: number, inSync: number
): void {
  const light = s.sectors.light[sector]!;
  const t = addLightThinker(
    s, (self) => tStrobeFlash(s, self), 'strobe',
    [LIGHT_THINKER_KINDS.strobe, 0]
  ) as unknown as StrobeThinker;
  t.sector = sector;
  t.darktime = darktime;
  t.brighttime = STROBEBRIGHT;
  t.maxlight = light;
  t.minlight = pFindMinSurroundingLight(s, sector, light);

  if (t.minlight === t.maxlight) t.minlight = 0;

  // nothing special about it during gameplay
  s.sectors.special[sector] = 0;

  t.count = inSync === 0 ? (pRandom(s.rng) & 7) + 1 : 1;
  t.words[1] = t.count;
}

/** `P_SpawnGlowingLight(sector)` — p_lights.c:342-357; sector special 8.
 * SILENT: zero draws, direction = −1. */
export function pSpawnGlowingLight(s: SpecWorld, sector: number): void {
  const light = s.sectors.light[sector]!;
  const t = addLightThinker(
    s, (self) => tGlow(s, self), 'glow',
    [LIGHT_THINKER_KINDS.glow, -1]
  ) as unknown as GlowThinker;
  t.sector = sector;
  t.minlight = pFindMinSurroundingLight(s, sector, light);
  t.maxlight = light;
  t.direction = -1;
  s.sectors.special[sector] = 0;
}

/* ------------------------------------------------------------------ */
/* EV_* — line-special entry points (registry routes 12/13/17/35/79/
/* 80/81/104/138/139 here; return values are inert today — no light
/* action sits behind a gateSwitch, see specials-table.ts)              */
/* ------------------------------------------------------------------ */

/** Per-fn call counters: the M6-03 coverage tests in pspec.test.ts swap
 * their `unimplementedSpecial` stub-hit assertions for these once the
 * light family goes live (registry subtable fill). */
export const plightsCalls = {
  evLightTurnOn: 0, evStartLightStrobing: 0, evTurnTagLightsOff: 0
};
export function resetPlightsCalls(): void {
  plightsCalls.evLightTurnOn = 0;
  plightsCalls.evStartLightStrobing = 0;
  plightsCalls.evTurnTagLightsOff = 0;
}

/** `EV_LightTurnOn(line, bright)` — p_lights.c:252-291. bright 0 ⇒
 * brightest SURROUNDING of the FIRST tagged sector — and the found value
 * sticks for every later tagged sector (the `bright` local is never
 * re-zeroed; quirk reproduced verbatim). Tag matches include tag 0 =
 * every untaged sector (vanilla loop, no special case). */
export function evLightTurnOn(s: SpecWorld, line: number, bright: number): boolean {
  plightsCalls.evLightTurnOn++;
  const tag = s.map.lines.tag[line]!;
  const tags = s.sectors.tag;
  const li = s.sectors.light;
  for (let i = 0; i < s.sectors.count; i++) {
    if (tags[i] === tag) {
      // bright = 0 means to search for the highest light level
      // surrounding this sector.
      if (!bright) {
        const L = s.map.sectors.lineStart;
        const C = s.map.sectors.lineCount;
        const idx = s.map.sectorLineIndex;
        for (let j = L[i]!, n = L[i]! + C[i]!; j < n; j++) {
          const temp = getNextSector(s.map, idx[j]!, i);
          if (temp < 0) continue;
          if (li[temp]! > bright) bright = li[temp]!;
        }
      }
      li[i] = bright;
    }
  }
  return true;
}

/** `EV_StartLightStrobing(line)` — p_lights.c:216-229; line special 17.
 * Tagged sectors with an existing mover (specialdata) are SKIPPED; the
 * rest get an out-of-sync strobe (SLOWDARK, ONE draw each). */
export function evStartLightStrobing(s: SpecWorld, line: number): boolean {
  plightsCalls.evStartLightStrobing++;
  let secnum = -1;
  while ((secnum = pFindSectorFromLineTag(s, line, secnum)) >= 0) {
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;
    pSpawnStrobeFlash(s, secnum, SLOWDARK, 0);
  }
  return true;
}

/** `EV_TurnTagLightsOff(line)` — p_lights.c:234-258; line special 104.
 * Each tagged sector drops to min(self, adjoining); one-sided lines do
 * not participate. */
export function evTurnTagLightsOff(s: SpecWorld, line: number): boolean {
  plightsCalls.evTurnTagLightsOff++;
  const tag = s.map.lines.tag[line]!;
  const tags = s.sectors.tag;
  const li = s.sectors.light;
  for (let j = 0; j < s.sectors.count; j++) {
    if (tags[j] === tag) {
      let min = li[j]!;
      const L = s.map.sectors.lineStart;
      const C = s.map.sectors.lineCount;
      const idx = s.map.sectorLineIndex;
      for (let i = L[j]!, n = L[j]! + C[j]!; i < n; i++) {
        const tsec = getNextSector(s.map, idx[i]!, j);
        if (tsec < 0) continue;
        if (li[tsec]! < min) min = li[tsec]!;
      }
      li[j] = min;
    }
  }
  return true;
}
