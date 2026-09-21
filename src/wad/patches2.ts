/**
 * patches2.ts — the named-lump UI patch table (M9-01, plan §M9-01 + §0.12).
 *
 * The 1.10 interface graphics the M9 UI layers (menu, statusbar, HU font,
 * intermission, title/finale screens) load BY NAME, transcribed as families
 * from the vanilla loader call sites and cross-checked lump-for-lump
 * against the pinned freedoom1.wad (the §0.12 measured census — "ALL
 * 1.10-required M9 graphics are PRESENT"). Decoding + caching live in
 * src/render/vvideo.ts `lumpPatch`; this module is wad-zone data only
 * (render imports wad, never the reverse).
 *
 * Two family shapes:
 *  - `names`: explicit lump names — used for everything with a fixed
 *    vanilla call-site name, INCLUDING the M_* menu set, which is explicit
 *    on purpose: freedoom ships a Crispy-style SUPERSET of 82 M_* lumps
 *    (M_VIDEO/M_WAD/M_CRISPY/…, §0.12 GOTCHA) and the port must render the
 *    VANILLA menu graph only, so "every M_* lump" is deliberately NOT the
 *    census.
 *  - `pattern`: regex over the wad directory — the WIA* intermission
 *    animation frames, whose vanilla names are built at runtime
 *    (`sprintf("WIA%d%.2d%.2d", epsd, anim, frame)`, wi_stuff.c:745 area)
 *    and exist 58-strong in the pinned wad; auditing them by prefix is
 *    the honest census.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { WadFile } from './wadfile';

/** UI consumers (one M9 task each): statusbar (M9-05), HU font (M9-06),
 * WI screens (M9-07), menus (M9-04), title/finale (M9-10). */
export type UiPatchGroup = 'statusbar' | 'faces' | 'font' | 'menu' | 'intermission' | 'screens';

export interface UiPatchFamily {
  group: UiPatchGroup;
  /** Human label for audit messages. */
  what: string;
  /** Fixed lump names (census is exactly these). */
  names?: readonly string[];
  /** Regex census over the wad directory (all matches must decode). */
  pattern?: RegExp;
  /** Expected match count in the pinned freedoom1.wad (audit assertion). */
  count: number;
}

const digits = (prefix: string): string[] => Array.from({ length: 10 }, (_, d) => `${prefix}${d}`);

/**
 * Face lumps, generated with the SAME name shapes ST_loadData builds
 * (st_stuff.c:~290-360: `sprintf("STFST%d%d", p, s)` etc.):
 * 15 straight (5 pain x 3) + 5 turn-left + 5 turn-right + 5 evilgrin +
 * 5 ouch + 5 kill + 1 dead + 1 god = 42 (st_stuff.h ST_NUMFACES), +4
 * facebacks STFB0-3 (STF* census = 46 measured, §0.12).
 */
function faceNames(): string[] {
  const out: string[] = [];
  for (let pain = 0; pain < 5; pain += 1) {
    for (let straight = 0; straight < 3; straight += 1) out.push(`STFST${pain}${straight}`);
    out.push(`STFTL${pain}0`, `STFTR${pain}0`);
    out.push(`STFEVL${pain}`, `STFOUCH${pain}`, `STFKILL${pain}`);
  }
  out.push('STFDEAD0', 'STFGOD0');
  return out;
}

/** STCFN033-096: the hu_font printable range audited in §0.12 (the wad
 * carries a few extra STCFN lumps beyond 096 — ignored, like vanilla). */
function stcfnNames(): string[] {
  const out: string[] = [];
  for (let ch = 33; ch <= 96; ch += 1) out.push(`STCFN${String(ch).padStart(3, '0')}`);
  return out;
}

/** WILV e0m1-8 across the four episodes (data present for all, §0.12). */
function wilvNames(): string[] {
  const out: string[] = [];
  for (let epsd = 0; epsd < 4; epsd += 1) {
    for (let map = 0; map <= 8; map += 1) out.push(`WILV${epsd}${map}`);
  }
  return out;
}

/** The vanilla M9 UI census, grouped by consumer. */
export const UI_PATCH_FAMILIES: readonly UiPatchFamily[] = [
  /* ---- statusbar (st_stuff.c ST_loadData) ---- */
  { group: 'statusbar', what: 'STBAR', names: ['STBAR'], count: 1 },
  { group: 'statusbar', what: 'faceback', names: ['STFB0', 'STFB1', 'STFB2', 'STFB3'], count: 4 },
  { group: 'statusbar', what: 'STARMS', names: ['STARMS'], count: 1 },
  { group: 'statusbar', what: 'STKEYS', names: [0, 1, 2, 3, 4, 5].map((i) => `STKEYS${i}`), count: 6 },
  { group: 'statusbar', what: 'short nums', names: digits('STTNUM'), count: 10 },
  { group: 'statusbar', what: 'tall nums', names: digits('STYSNUM'), count: 10 },
  { group: 'statusbar', what: 'tall red nums', names: digits('STGNUM'), count: 10 },
  { group: 'statusbar', what: 'STTPRCNT', names: ['STTPRCNT'], count: 1 },
  { group: 'statusbar', what: 'STTMINUS', names: ['STTMINUS'], count: 1 },
  /* ---- faces (42, st_stuff.c) ---- */
  { group: 'faces', what: 'face set', names: faceNames(), count: 42 },
  /* ---- hu_font (hu_stuff.c / m_menu.c STCFN) ---- */
  { group: 'font', what: 'STCFN 33-96', names: stcfnNames(), count: 64 },
  /* ---- menus (m_menu.c lumps[] tables; vanilla subset ONLY — see header
       re the Crispy superset in the wad) ---- */
  {
    group: 'menu',
    what: 'M_ vanilla set',
    names: [
      'M_DOOM',
      'M_SKULL1',
      'M_SKULL2',
      'M_NGAME',
      'M_NEWG',
      'M_EPISOD',
      'M_EPI1',
      'M_EPI2',
      'M_EPI3',
      'M_EPI4',
      'M_SKILL',
      'M_JKILL',
      'M_ROUGH',
      'M_HURT',
      'M_ULTRA',
      'M_NMARE',
      'M_OPTION',
      'M_LOADG',
      'M_SAVEG',
      'M_RDTHIS',
      'M_QUITG',
      'M_PAUSE',
      'M_THERMO',
      'M_THERML',
      'M_THERMM',
      'M_THERMR',
      'M_SVOL',
      'M_SFXVOL',
      'M_MUSVOL',
    ],
    count: 29,
  },
  /* ---- intermission (wi_stuff.c) ---- */
  { group: 'intermission', what: 'WIMAP', names: ['WIMAP0', 'WIMAP1', 'WIMAP2'], count: 3 },
  { group: 'intermission', what: 'WILV', names: wilvNames(), count: 36 },
  { group: 'intermission', what: 'WI anims', pattern: /^WIA\d{5}$/, count: 58 },
  { group: 'intermission', what: 'WIURH', names: ['WIURH0', 'WIURH1'], count: 2 },
  { group: 'intermission', what: 'WI misc', names: ['WISPLAT'], count: 1 },
  {
    group: 'intermission',
    what: 'WI text/nums',
    names: [
      'WIPCNT',
      'WIF',
      'WIENTER',
      'WIOSTK',
      'WIOSTI',
      'WISCRT2',
      'WICOLON',
      'WITIME',
      'WISUCKS',
      'WIPAR',
      'WIMINUS',
      ...digits('WINUM'),
    ],
    count: 20,
  },
  /* ---- title / finale screens (d_main.c F_StartFinale page draws) ---- */
  {
    group: 'screens',
    what: 'full-screen patches',
    names: ['TITLEPIC', 'CREDIT', 'HELP1', 'HELP2', 'ENDPIC', 'VICTORY2'],
    count: 6,
  },
];

/** Fixed-name members of the census, in family order, deduplicated. */
export function uiPatchNames(): string[] {
  const seen = new Set<string>();
  for (const fam of UI_PATCH_FAMILIES) {
    for (const n of fam.names ?? []) seen.add(n.toUpperCase());
  }
  return [...seen];
}

/**
 * Resolve the census against a real wad directory: explicit names must be
 * PRESENT (missing ones are dropped here but asserted by the audit test),
 * pattern families expand to every matching lump. Returns
 * `{name, group, what}` rows in census order.
 */
export function resolveUiPatchLumps(
  wad: WadFile,
): { name: string; group: UiPatchGroup; what: string }[] {
  const dirNames: string[] = [];
  for (let num = 0; wad.lumpNumAt(num) >= 0; num += 1) {
    dirNames.push(wad.lumpName(num).toUpperCase());
  }
  const rows: { name: string; group: UiPatchGroup; what: string }[] = [];
  const seen = new Set<string>();
  for (const fam of UI_PATCH_FAMILIES) {
    const matches =
      fam.pattern !== undefined
        ? dirNames.filter((n) => fam.pattern!.test(n))
        : (fam.names ?? []).filter((n) => wad.has(n));
    for (const n of matches) {
      const key = n.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ name: key, group: fam.group, what: fam.what });
    }
  }
  return rows;
}
