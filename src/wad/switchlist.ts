// wad/switchlist.ts — switch-texture pair data + P_InitSwitchList scan
// (p_switch.c, M6-11). Pure string/name logic (wad zone: imports nothing).
//
// Vanilla builds `switchlist[MAXSWITCHES*2]` of TEXTURE1 NUMBERS at
// P_SetupLevel: iterate the static `alphSwitchList[]`, keep entries with
// `episode <= episode` (1 = shareware, 2 = registered, 3 = commercial),
// resolve both names through R_TextureNumForName (an I_Error if a kept
// name is missing from the WAD) and append name1,name2 — so the flat
// array alternates OFF,ON and `switchlist[i^1]` is the pair partner
// (p_switch.c P_ChangeSwitchTexture). This port compares side texture
// NAMES instead of numbers (map.ts keeps names; the renderer resolves),
// which is value-equivalent for any WAD whose names match the table.
//
// Freedoom-1 extension (M6-plan §M6-11 "P_InitSwitchList port over
// TEXTURE1 names, Freedoom-1 episode filter"; §4 risk note): the alph
// table alone never matches a WAD with non-vanilla switch names, so the
// scan ALSO pairs any TEXTURE1 name `SW1xxx` whose counterpart `SW2xxx`
// is present in the directory — the naming law every alph pair obeys
// (all 30 vanilla pairs differ ONLY at byte index 2, '1'↔'2'). This
// covers Freedoom's names and the M6-02 fixture pair SW1MTX/SW2MTX
// (tests/fixtures/m6Fixtures.ts, byte idx 2) without fake pairings:
// a pair is emitted ONLY when the counterpart genuinely exists.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** p_spec.h `#define MAXSWITCHES 50` — alph-list scan cap in vanilla
 * (P_InitSwitchList loops `i < MAXSWITCHES`). */
export const MAXSWITCHES = 50;

/** One alphSwitchList row (name1 = OFF/SW1, name2 = ON/SW2). */
export interface SwitchPair {
  readonly name1: string;
  readonly name2: string;
  /** Episode availability: 1 = shareware/E1, 2 = registered E1–E3,
   * 3 = Doom II (commercial). */
  readonly episode: number;
}

/**
 * `alphSwitchList[]` verbatim (p_switch.c:47-90), terminator row dropped
 * (its only effect was `numswitches = index/2` + break — same result as
 * ending the scan here).
 */
export const ALPH_SWITCH_LIST: readonly SwitchPair[] = Object.freeze([
  // Doom shareware episode 1 switches
  ...['BRCOM', 'BRN1', 'BRN2', 'BRNGN', 'BROWN', 'COMM', 'COMP', 'DIRT',
    'EXIT', 'GRAY', 'GRAY1', 'METAL', 'PIPE', 'SLAD', 'STARG', 'STON1',
    'STON2', 'STONE', 'STRTN'].map(
    (s) => ({ name1: `SW1${s}`, name2: `SW2${s}`, episode: 1 })),
  // Doom registered episodes 2&3 switches
  ...['BLUE', 'CMT', 'GARG', 'GSTON', 'HOT', 'LION', 'SATYR', 'SKIN',
    'VINE', 'WOOD'].map(
    (s) => ({ name1: `SW1${s}`, name2: `SW2${s}`, episode: 2 })),
  // Doom II switches
  ...['PANEL', 'ROCK', 'MET2', 'WDMET', 'BRIK', 'MOD1', 'ZIM', 'STON6',
    'TEK', 'MARB', 'SKULL'].map(
    (s) => ({ name1: `SW1${s}`, name2: `SW2${s}`, episode: 3 }))
]);

/** gamemode → episode (P_InitSwitchList: shareware 1 / registered 2 /
 * commercial 3). */
export const EPISODE = { shareware: 1, registered: 2, commercial: 3 } as const;

/**
 * Build the flat switchlist `[off0, on0, off1, on1, ...]` (the port's
 * `switchlist[]` + `numswitches = length/2`, `switchlist[i^1]` pairing
 * rule preserved). `textureNames` is the level's texture-name list
 * (TEXTURE1 directory order — or the fixture's declared names); the
 * result is deterministic: table pass in alph-table order first, then
 * the SW1xxx-name scan in `textureNames` order, duplicates dropped.
 *
 * Pair-emission rule (documented deviation from vanilla's unconditional
 * alph append — vanilla's R_TextureNumForName I_Errors on absent names,
 * so appending only present pairs is the same set minus a crash):
 *  • alph pair kept iff `episode <= episode` AND name1 resolves in the
 *    texture list (name2 accepted unconditionally for it — the table
 *    promises the pairing; a map using it needs the lump anyway);
 *  • plus every `SW1xxx` in the texture list whose `SW2xxx` counterpart
 *    is ALSO in the list (data-driven arm for non-vanilla WADs).
 */
export function buildSwitchList(
  textureNames: readonly string[], episode: number = EPISODE.registered
): string[] {
  const present = new Set(textureNames);
  const out: string[] = [];
  const seen = new Set<string>();

  const add = (name1: string, name2: string): void => {
    if (seen.has(name1)) return;
    seen.add(name1);
    out.push(name1, name2);
  };

  for (const p of ALPH_SWITCH_LIST) {
    if (p.episode > episode) continue;
    // R_TextureNumForName(name1) must resolve (vanilla I_Error guard —
    // here: silently skip a name this WAD does not carry).
    if (!present.has(p.name1) && !present.has(p.name2)) continue;
    add(p.name1, p.name2);
  }
  // Data-driven pass over the texture directory (TEXTURE1 order).
  for (const name of textureNames) {
    if (name.length < 4 || !name.startsWith('SW1') || name[3] === '2') continue;
    const pair = 'SW2' + name.slice(3);
    if (!present.has(pair)) continue;
    add(name, pair);
  }
  return out;
}
