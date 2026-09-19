// sim/plights.ts — light thinkers (p_lights.c). M6-03 STUB bodies (see
// pdoors.ts header; M6-09 replaces the bodies and refines ONLY the spawn
// cases' internals — the pspec.ts sector-pass wiring stays as landed
// here).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub, recordSectorStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';

/** `EV_LightTurnOn(line, bright)` — bright 0 = brightest surrounding
 * (p_lights.c). */
export function evLightTurnOn(s: SpecWorld, line: number, bright: number): boolean {
  recordLineStub(s, 'evLightTurnOn', line, bright);
  return false;
}

/** `EV_StartLightStrobing(line)` — special 17 (spawns strobers on the
 * tagged sectors). */
export function evStartLightStrobing(s: SpecWorld, line: number): boolean {
  recordLineStub(s, 'evStartLightStrobing', line, 0);
  return false;
}

/** `EV_TurnTagLightsOff(line)` — special 104. */
export function evTurnTagLightsOff(s: SpecWorld, line: number): boolean {
  recordLineStub(s, 'evTurnTagLightsOff', line, 0);
  return false;
}

/** `P_SpawnLightFlash(sector)` — sector special 1 (arg = sector index). */
export function pSpawnLightFlash(s: SpecWorld, sector: number): void {
  recordSectorStub(s, 'pSpawnLightFlash', sector, 0);
}

/** `P_SpawnStrobeFlash(sector, darktime, inSync)` — sector specials
 * 2/3/4/12/13. */
export function pSpawnStrobeFlash(
  s: SpecWorld, sector: number, darktime: number, inSync: number
): void {
  recordSectorStub(s, `pSpawnStrobeFlash(${darktime},${inSync})`, sector, darktime);
}

/** `P_SpawnGlowingLight(sector)` — sector special 8. */
export function pSpawnGlowingLight(s: SpecWorld, sector: number): void {
  recordSectorStub(s, 'pSpawnGlowingLight', sector, 0);
}

/** `P_SpawnFireFlicker(sector)` — sector special 17. */
export function pSpawnFireFlicker(s: SpecWorld, sector: number): void {
  recordSectorStub(s, 'pSpawnFireFlicker', sector, 0);
}
