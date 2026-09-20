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

/** Resolve one frame's psprite bundle (vanilla psp loop order = array
 * order: weapon then flash, NUMPSPRITES rows). */
export function buildPspriteFrameInput(
  map: RuntimeMap,
  player: PsprViewPlayer
): PspriteFrameInput {
  const views: (PspriteView | null)[] = [];
  for (const psp of player.psprites ?? []) {
    if (psp.state === 0) {
      views.push(null); // S_NULL ⇒ inactive (never drawn)
      continue;
    }
    views.push({
      sprite: stateSprite[psp.state]!,
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
