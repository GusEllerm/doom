// sim/pplane.ts — T_MovePlane (p_floor.c core, D013(a) carve-out) + the
// crush model call path through P_ChangeSector (p_map.c) — M6-04.
//
// STUB (task bootstrap). See M6-plan §M6-04; interface contract for the
// four consumer families (pdoors/pplats/pfloor/pceilng, M6-05..08) lands
// with the implementation.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** doomdef.h result_e {ok, pastdest, crushed}. */
export type ResultE = 'ok' | 'crushed' | 'pastdest';

export function tMovePlane(): ResultE {
  throw new Error('M6-04 stub');
}
