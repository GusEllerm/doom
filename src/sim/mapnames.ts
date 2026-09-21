/**
 * sim/mapnames.ts — the compiled-in `mapnames[]`/`mapnames2[]` arrays of
 * hu_stuff.c:115-215 verbatim (M9-06, plan §M9-06 "Owns").
 *
 * These are id's vanilla level titles, compiled into the EXE as the
 * HUSTR_ExMy / HUSTR_n macros of d_englsh.h — NOT WAD lumps (the §0.12
 * lump census never looks for them). The HU map-title widget
 * (`HU_TITLE = mapnames[(gameepisode-1)*9+gamemap-1]`, hu_stuff.c:49,
 * copied into `w_title` once per HU_Start) reads MAPNAMES in the
 * episodic/registered/retail modes and MAPNAMES2 in commercial
 * (hu_stuff.c:459-471 switch; the pack_plut/pack_tnt branches are an
 * `/* FIXME *\/` comment block in the released source — not compiled).
 *
 * DATA-vs-CODE TRUTH (plan §M9-06 finding): this port's IWAD is
 * Freedoom, whose map TITLE lump (TEXTURE1 "mapname" convention does not
 * exist in 1.10; the DOOM-2-era TITLEMAP lump is out of scope) is not
 * read by 1.10 code — the shipped pixels therefore render VANILLA
 * strings ("E1M1: Hangar") over Freedoom maps. Recorded for the D016/exit
 * review; zero code change either way.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** hu_stuff.c:115-167 `mapnames[]` — DOOM shareware/registered/retail
 * (Ultimate) names: 4 episodes × 9 maps (HUSTR_E1M1..HUSTR_E4M9,
 * d_englsh.h:142-180) + 9 "NEWLEVEL" out-of-range guards. */
export const MAPNAMES: readonly string[] = [
  'E1M1: Hangar',
  'E1M2: Nuclear Plant',
  'E1M3: Toxin Refinery',
  'E1M4: Command Control',
  'E1M5: Phobos Lab',
  'E1M6: Central Processing',
  'E1M7: Computer Station',
  'E1M8: Phobos Anomaly',
  'E1M9: Military Base',

  'E2M1: Deimos Anomaly',
  'E2M2: Containment Area',
  'E2M3: Refinery',
  'E2M4: Deimos Lab',
  'E2M5: Command Center',
  'E2M6: Halls of the Damned',
  'E2M7: Spawning Vats',
  'E2M8: Tower of Babel',
  'E2M9: Fortress of Mystery',

  'E3M1: Hell Keep',
  'E3M2: Slough of Despair',
  'E3M3: Pandemonium',
  'E3M4: House of Pain',
  'E3M5: Unholy Cathedral',
  'E3M6: Mt. Erebus',
  'E3M7: Limbo',
  'E3M8: Dis',
  'E3M9: Warrens',

  'E4M1: Hell Beneath',
  'E4M2: Perfect Hatred',
  'E4M3: Sever The Wicked',
  'E4M4: Unruly Evil',
  'E4M5: They Will Repent',
  'E4M6: Against Thee Wickedly',
  'E4M7: And Hell Followed',
  'E4M8: Unto The Cruel',
  'E4M9: Fear',

  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
  'NEWLEVEL',
] as const;

/** hu_stuff.c:169-215 `mapnames2[]` — DOOM 2 names (HUSTR_1..HUSTR_32,
 * d_englsh.h:182-216). Commercial mode only. */
export const MAPNAMES2: readonly string[] = [
  'level 1: entryway',
  'level 2: underhalls',
  'level 3: the gantlet',
  'level 4: the focus',
  'level 5: the waste tunnels',
  'level 6: the crusher',
  'level 7: dead simple',
  'level 8: tricks and traps',
  'level 9: the pit',
  'level 10: refueling base',
  "level 11: 'o' of destruction!",

  'level 12: the factory',
  'level 13: downtown',
  'level 14: the inmost dens',
  'level 15: industrial zone',
  'level 16: suburbs',
  'level 17: tenements',
  'level 18: the courtyard',
  'level 19: the citadel',
  'level 20: gotcha!',

  'level 21: nirvana',
  'level 22: the catacombs',
  "level 23: barrels o' fun",
  'level 24: the chasm',
  'level 25: bloodfalls',
  'level 26: the abandoned mines',
  'level 27: monster condo',
  'level 28: the spirit world',
  'level 29: the living end',
  'level 30: icon of sin',

  'level 31: wolfenstein',
  'level 32: grosse',
] as const;

/** HU_TITLE / HU_TITLE2 (hu_stuff.c:49-50). Episodic indexing is
 * (gameepisode-1)*9+gamemap-1 over MAPNAMES; commercial indexes
 * MAPNAMES2[gamemap-1]. Out-of-range episodic indices land on the
 * "NEWLEVEL" guard cells (hu_stuff.c:159-167). */
export function huTitle(
  gamemode: 'shareware' | 'registered' | 'retail' | 'commercial',
  gameepisode: number,
  gamemap: number,
): string {
  if (gamemode === 'commercial') {
    return MAPNAMES2[gamemap - 1] ?? MAPNAMES2[MAPNAMES2.length - 1]!;
  }
  const idx = (gameepisode - 1) * 9 + gamemap - 1;
  return MAPNAMES[idx] ?? MAPNAMES[MAPNAMES.length - 1]!;
}
