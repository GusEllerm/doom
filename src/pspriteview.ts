// pspriteview.ts — the sim→render psprite seam (M7-10 wiring of the M7-07
// render/psprites.ts layer, which shipped "dark": nothing called it).
//
// psprites.ts's contract (its header) is that the CALLER resolves the sim
// psprite STATE rows into {sprite, frame} pairs — the render zone may not
// import sim modules, and debug.ts's entry discipline forbids render
// imports there. src/ root sits outside the zones, so the resolution lives
// here: main.ts's render() passes it to renderFrame's optional
// deps.psprites, and the M7-10 visual suite (tests/weapons/visual.test.ts)
// consumes the SAME seam in the golden pipeline.
//
// Mirror facts (linuxdoom-1.10, re-read for this wiring):
//  * r_things.c:764-790 R_DrawPlayerSprites loops psprites[] drawing rows
//    whose `state != S_NULL` (state 0 = inactive here — sim/p_pspr.ts
//    PspDef).
//  * state_t.sprite/frame come from the 967-row states table (info.c); the
//    sx/sy travel on the pspdef itself (P_SetPsprite/BFG/LowerUp logic).
//  * The spritelights row is (sector->lightlevel >> LIGHTSEGSHIFT) +
//    extralight, clamped (r_things.c:769-778) — sector = the player's
//    subsector's sector (P_PointInSubsector; the extralight half rides the
//    FramePlayer read-through, NOT this bundle).
//  * Invisibility gate r_things.c:712: powers[pw_invisibility]
//    (doomdef.h powertype_t index 2).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { sectorAtPoint } from './sim/bsp';
import type { RuntimeMap } from './sim/map';
import { stateFrame, stateSprite } from './wad/info/states';
import { sprnames } from './wad/info/sprnames';
import type { PspriteFrameInput } from './render/renderer';
import type { PspriteView } from './render/psprites';

/** doomdef.h:214-223 powertype_t — powers[pw_invisibility]. */
const PW_INVISIBILITY = 2;

/** Structural read-view of the sim player this seam reads (the sim Player
 * satisfies it once p_pspr's fields are attached; `psprites` absent/empty
 * ⇒ no rows — a player the psprite machine never touched). */
export interface PsprViewPlayer {
  readonly mo: { readonly x: number; readonly y: number };
  readonly psprites?: readonly {
    readonly state: number;
    readonly sx: number;
    readonly sy: number;
  }[];
  readonly powers?: readonly number[];
}

/**
 * THE SPRITE-NUMBER TRAP this seam exists to defuse (M7-11 root-cause fix).
 * `stateSprite[]` carries the info.h `spritenum_t` — the index INTO
 * `sprnames[]` — because vanilla's `R_InitSprites(sprnames)` orders
 * `sprites[]` by exactly that list (r_things.c:186-239). This port's
 * {@link InstalledSprites} is built from the WAD lump CENSUS instead
 * (rthings.ts header: "vanilla orders sprites[] by the sprnames[] list;
 * the census orders by first lump seen"), where the same number means a
 * DIFFERENT sprite — index 3 is SPOS (the possessed soldier) there, not
 * PISG. Feeding the raw table number to `lookupFrame` therefore drew one
 * small monster sprite at the gun's screen position for EVERY weapon
 * (the M7-10 visual-gate finding); the states table itself is faithful
 * (all 967 rows verified row-by-row against the mirror, misc1/misc2
 * included — the 1.10 weapon rows really are `0,0`, the psprite sx/sy
 * come from A_WeaponReady/A_Raise, never from the table). So the number
 * crosses the boundary BY NAME, exactly like `buildMapSprites` resolves
 * thing sprites (`sprites.indexOf.get(name4)`); a 4CC the WAD has no
 * lumps for draws nothing (vanilla's I_Error case, same rule as the
 * static roster's `skipped.missingSprite`).
 *
 * `SpriteIndex` is the structural minimum this seam needs (the
 * 4CC → spriteNum map `InstalledSprites.indexOf` already is), so the
 * name-resolution contract is unit-testable without a WAD.
 */
export interface SpriteIndex {
  readonly indexOf: ReadonlyMap<string, number>;
}

export function buildPspriteFrameInput(
  map: RuntimeMap,
  player: PsprViewPlayer,
  sprites: SpriteIndex
): PspriteFrameInput {
  const views: (PspriteView | null)[] = [];
  for (const psp of player.psprites ?? []) {
    if (psp.state === 0) {
      views.push(null); // S_NULL ⇒ inactive (never drawn)
      continue;
    }
    const name4 = sprnames[stateSprite[psp.state]!];
    const spriteNum = name4 === undefined ? undefined : sprites.indexOf.get(name4);
    if (spriteNum === undefined) {
      views.push(null); // no lumps for this 4CC in this WAD
      continue;
    }
    views.push({
      sprite: spriteNum,
      frame: stateFrame[psp.state]!,
      sx: psp.sx,
      sy: psp.sy,
    });
  }
  return {
    views,
    sectorLight: map.sectors.lightLevel[sectorAtPoint(map, player.mo.x, player.mo.y)]!,
    invisibility: player.powers?.[PW_INVISIBILITY] ?? 0,
  };
}
