// audio/sfxinfo.ts — the S_sfx[] census mirror (M10-02, M10-plan §M10-02 / §0.4).
//
// Row-by-row transcription of linuxdoom-1.10 sounds.c:117-226 (`S_sfx[NUMSFX]`,
// NUMSFX = 109: dummy row 0 + 108 entries; struct at sounds.h:32-62). Every row
// below carries its sounds.c line number as the audit cite; sfxinfo.test.ts
// re-parses the mirror table (when /tmp/DOOM-master is mounted) and diffs
// row-for-row against this transcription.
//
// Column mapping (sfxinfo_t field order, sounds.h:32-62). The 2nd field is
// NAMED `singularity` in 1.10's sounds.h (tracked under its Chocolate-era name
// `looping` by plan §0.4); NEITHER name is read anywhere in 1.10 code (grep
// empty) — we transcribe the column anyway for the M10-05+ consumers:
//   { "name", singularity/looping, priority, link, pitch, volume, usefulness }
// * priority (column 3) is consulted ONLY by S_getChannel eviction (s_sound.c:
//   850-865 — `>=` comparison, kick out the FIRST such channel, "Otherwise,
//   kick out lower priority"); the play path's local `priority = NORM_PRIORITY
//   (64)` is dead (s_sound.c:264/:286) and linuxdoom's I_StartSound IGNORES the
//   passed priority outright (i_sound.c:474-481, "priority = 0").
//   Observed range: 0 (dummy) / 32 (telept, deaths) ... 120 (posact/bgact/
//   dmact), weapon-default 64; histogram audited in sfxinfo.test.ts.
// * the ONLY link row is chgun → pistol @ pitch 150 (sounds.c:204):
//   S_StartSoundAtVolume's link branch (s_sound.c:283-299) retargets the sfx
//   pointer to the LINK, so chgun plays the pistol DATA (I_InitSound's
//   pre-cache link branch, i_sound.c:803-810) — no DSCHGUN lump is ever looked
//   up. volume field 0 ⇒ `volume += 0` (s_sound.c:288).
// * looping's 23 true rows: itemup/wpnup + the 16 *sit rows + the 5 *act rows
//   (plan §0.4); the field is decorative in 1.10.
//
// Lump naming: vanilla resolves `sprintf("ds%s", sfx->name)` (I_GetSfxLumpNum,
// i_sound.c:451-456) ⇒ `DS`+NAME lumps; dsLumpName() mirrors that (WAD name
// lookup is case-insensitive, R01 §15.2).
//
// Id source of truth stays src/sim/psound_stub.ts SFX_ID (the sounds.h enum,
// sfx_None = 0 ... sfx_radio = 108). This module cross-checks the NAME of every
// row against SFX_ID at module load (dev-time throw) and sfxinfo.test.ts
// asserts full equality both directions; the names here are the sounds.c
// table names (lowercase, sans the sfx_ prefix; row 0 = 'none').
//
// Zone rule (A-06): audio imports sim read-views only — here just the
// psound_stub constant tables. No AudioContext, no wad I/O (that is
// sfxdata.ts).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { NUMSFX, SFX_ID } from '../sim/psound_stub';

/** One S_sfx row (sounds.h:32-62). */
export interface SfxInfo {
  /** Enum id (sounds.h; == SFX_ID value). */
  readonly id: number;
  /** sounds.c table name, lowercase sans 'sfx_' (e.g. 'pistol'). */
  readonly name: string;
  /** sounds.c column 2 (`singularity` in 1.10 sounds.h; never read, §0.4). */
  readonly looping: boolean;
  /** sounds.c column 3; S_getChannel eviction precedence ONLY (§0.4). */
  readonly priority: number;
  /** Linked sound id — chgun→pistol is the ONLY link (sounds.c:204), else null. */
  readonly link: number | null;
  /** Link pitch (150 for chgun, sounds.c:204); 0 when unlinked. */
  readonly linkPitch: number;
  /** sounds.c line of this row (mirror /tmp/DOOM-master/linuxdoom-1.10). */
  readonly soundsCLine: number;
}

/** Raw [id, name, looping, priority, linkName, linkPitch, soundsCLine] rows,
 * generated from sounds.c:117-226 this pass; the audit test re-diffs vs the
 * mirror when mounted (row-by-row, cite-for-cite). */
const ROWS: readonly (readonly [number, string, boolean, number, string | null, number, number])[] = [
  [0, 'none', false, 0, null, 0, 117],
  [1, 'pistol', false, 64, null, 0, 119],
  [2, 'shotgn', false, 64, null, 0, 120],
  [3, 'sgcock', false, 64, null, 0, 121],
  [4, 'dshtgn', false, 64, null, 0, 122],
  [5, 'dbopn', false, 64, null, 0, 123],
  [6, 'dbcls', false, 64, null, 0, 124],
  [7, 'dbload', false, 64, null, 0, 125],
  [8, 'plasma', false, 64, null, 0, 126],
  [9, 'bfg', false, 64, null, 0, 127],
  [10, 'sawup', false, 64, null, 0, 128],
  [11, 'sawidl', false, 118, null, 0, 129],
  [12, 'sawful', false, 64, null, 0, 130],
  [13, 'sawhit', false, 64, null, 0, 131],
  [14, 'rlaunc', false, 64, null, 0, 132],
  [15, 'rxplod', false, 70, null, 0, 133],
  [16, 'firsht', false, 70, null, 0, 134],
  [17, 'firxpl', false, 70, null, 0, 135],
  [18, 'pstart', false, 100, null, 0, 136],
  [19, 'pstop', false, 100, null, 0, 137],
  [20, 'doropn', false, 100, null, 0, 138],
  [21, 'dorcls', false, 100, null, 0, 139],
  [22, 'stnmov', false, 119, null, 0, 140],
  [23, 'swtchn', false, 78, null, 0, 141],
  [24, 'swtchx', false, 78, null, 0, 142],
  [25, 'plpain', false, 96, null, 0, 143],
  [26, 'dmpain', false, 96, null, 0, 144],
  [27, 'popain', false, 96, null, 0, 145],
  [28, 'vipain', false, 96, null, 0, 146],
  [29, 'mnpain', false, 96, null, 0, 147],
  [30, 'pepain', false, 96, null, 0, 148],
  [31, 'slop', false, 78, null, 0, 149],
  [32, 'itemup', true, 78, null, 0, 150],
  [33, 'wpnup', true, 78, null, 0, 151],
  [34, 'oof', false, 96, null, 0, 152],
  [35, 'telept', false, 32, null, 0, 153],
  [36, 'posit1', true, 98, null, 0, 154],
  [37, 'posit2', true, 98, null, 0, 155],
  [38, 'posit3', true, 98, null, 0, 156],
  [39, 'bgsit1', true, 98, null, 0, 157],
  [40, 'bgsit2', true, 98, null, 0, 158],
  [41, 'sgtsit', true, 98, null, 0, 159],
  [42, 'cacsit', true, 98, null, 0, 160],
  [43, 'brssit', true, 94, null, 0, 161],
  [44, 'cybsit', true, 92, null, 0, 162],
  [45, 'spisit', true, 90, null, 0, 163],
  [46, 'bspsit', true, 90, null, 0, 164],
  [47, 'kntsit', true, 90, null, 0, 165],
  [48, 'vilsit', true, 90, null, 0, 166],
  [49, 'mansit', true, 90, null, 0, 167],
  [50, 'pesit', true, 90, null, 0, 168],
  [51, 'sklatk', false, 70, null, 0, 169],
  [52, 'sgtatk', false, 70, null, 0, 170],
  [53, 'skepch', false, 70, null, 0, 171],
  [54, 'vilatk', false, 70, null, 0, 172],
  [55, 'claw', false, 70, null, 0, 173],
  [56, 'skeswg', false, 70, null, 0, 174],
  [57, 'pldeth', false, 32, null, 0, 175],
  [58, 'pdiehi', false, 32, null, 0, 176],
  [59, 'podth1', false, 70, null, 0, 177],
  [60, 'podth2', false, 70, null, 0, 178],
  [61, 'podth3', false, 70, null, 0, 179],
  [62, 'bgdth1', false, 70, null, 0, 180],
  [63, 'bgdth2', false, 70, null, 0, 181],
  [64, 'sgtdth', false, 70, null, 0, 182],
  [65, 'cacdth', false, 70, null, 0, 183],
  [66, 'skldth', false, 70, null, 0, 184],
  [67, 'brsdth', false, 32, null, 0, 185],
  [68, 'cybdth', false, 32, null, 0, 186],
  [69, 'spidth', false, 32, null, 0, 187],
  [70, 'bspdth', false, 32, null, 0, 188],
  [71, 'vildth', false, 32, null, 0, 189],
  [72, 'kntdth', false, 32, null, 0, 190],
  [73, 'pedth', false, 32, null, 0, 191],
  [74, 'skedth', false, 32, null, 0, 192],
  [75, 'posact', true, 120, null, 0, 193],
  [76, 'bgact', true, 120, null, 0, 194],
  [77, 'dmact', true, 120, null, 0, 195],
  [78, 'bspact', true, 100, null, 0, 196],
  [79, 'bspwlk', true, 100, null, 0, 197],
  [80, 'vilact', true, 100, null, 0, 198],
  [81, 'noway', false, 78, null, 0, 199],
  [82, 'barexp', false, 60, null, 0, 200],
  [83, 'punch', false, 64, null, 0, 201],
  [84, 'hoof', false, 70, null, 0, 202],
  [85, 'metal', false, 70, null, 0, 203],
  [86, 'chgun', false, 64, 'pistol', 150, 204],
  [87, 'tink', false, 60, null, 0, 205],
  [88, 'bdopn', false, 100, null, 0, 206],
  [89, 'bdcls', false, 100, null, 0, 207],
  [90, 'itmbk', false, 100, null, 0, 208],
  [91, 'flame', false, 32, null, 0, 209],
  [92, 'flamst', false, 32, null, 0, 210],
  [93, 'getpow', false, 60, null, 0, 211],
  [94, 'bospit', false, 70, null, 0, 212],
  [95, 'boscub', false, 70, null, 0, 213],
  [96, 'bossit', false, 70, null, 0, 214],
  [97, 'bospn', false, 70, null, 0, 215],
  [98, 'bosdth', false, 70, null, 0, 216],
  [99, 'manatk', false, 70, null, 0, 217],
  [100, 'mandth', false, 70, null, 0, 218],
  [101, 'sssit', false, 70, null, 0, 219],
  [102, 'ssdth', false, 70, null, 0, 220],
  [103, 'keenpn', false, 70, null, 0, 221],
  [104, 'keendt', false, 70, null, 0, 222],
  [105, 'skeact', false, 70, null, 0, 223],
  [106, 'skesit', false, 70, null, 0, 224],
  [107, 'skeatk', false, 70, null, 0, 225],
  [108, 'radio', false, 60, null, 0, 226],
];

function buildInfos(): SfxInfo[] {
  return ROWS.map(([id, name, looping, priority, link, linkPitch, soundsCLine]) => {
    let linkId: number | null = null;
    if (link !== null) {
      const resolved = sfxIdForName(link);
      if (resolved === undefined) {
        throw new RangeError(`S_sfx link target '${link}' is not a table name`);
      }
      linkId = resolved;
    }
    return { id, name, looping, priority, link: linkId, linkPitch, soundsCLine };
  });
}

const BY_NAME = new Map<string, number>(ROWS.map(([, name], i) => [name, i]));

/** Name (table name or sfx_* token, any case) → enum id; undefined unknown. */
export function sfxIdForName(name: string): number | undefined {
  const lower = name.toLowerCase();
  const bare = lower.startsWith('sfx_') ? lower.slice(4) : lower;
  return BY_NAME.get(bare);
}

/** The 109-row mirror, index == sfx id (S_sfx[0] = dummy, sounds.c:117). */
export const SFX_INFO: readonly SfxInfo[] = buildInfos();

// Module-load cross-check vs the canonical sim-side enum (psound_stub SFX_ID,
// the sounds.h order): every `sfx_<NAME>` key must equal the row's id and the
// case-insensitive name. Catches transcription drift at import time.
{
  const enumEntries = Object.entries(SFX_ID) as [string, number][];
  if (enumEntries.length !== ROWS.length) {
    throw new RangeError(`S_sfx mirror: ${ROWS.length} rows vs SFX_ID ${enumEntries.length} keys`);
  }
  for (const [key, id] of enumEntries) {
    const row = ROWS[id];
    const bare = key.toLowerCase().slice(4);
    if (row === undefined || row[0] !== id || row[1] !== bare) {
      throw new RangeError(`S_sfx mirror drift at id ${id}: ${key} vs ${row?.[1]}`);
    }
  }
}

/** sounds.h NUMSFX (re-exported from the canonical sim table). */
export { NUMSFX };

/** The vanilla DS lump name for a sound: 'DS'+NAME — mirrors
 * sprintf("ds%s", sfx->name) (I_GetSfxLumpNum, i_sound.c:451-456). */
export function dsLumpName(id: number): string {
  const info = SFX_INFO[id];
  if (info === undefined) {
    throw new RangeError(`sfx id ${id} out of range [0, ${NUMSFX})`);
  }
  return `DS${info.name.toUpperCase()}`;
}

/** addsfx hardcoded mutual-exclusion set (i_sound.c:285-290): an
 * already-active instance of ANY of these ids is unconditionally killed and the
 * slot reused — independent of origin (the chainsaw-dupe fix; also why menu
 * spam of stnmov/pistol never layers). Plan §0.5; consumed by M10-05. */
export const DEDUP_SFX_IDS: readonly number[] = [
  'sawup',
  'sawidl',
  'sawful',
  'sawhit',
  'stnmov',
  'pistol',
].map((name) => sfxIdForName(name) as number);

/**
 * The 41 table names (ids 1..108) whose OWN `DS<name>` lump is ABSENT from the
 * pinned freedoom1.wad — measured this pass (directory scan: 69 DS* lumps = 67
 * table-covered names + 2 non-vanilla extras DSOUCH/DSJUMP that no S_sfx row
 * references). This supersedes plan §0.10's "39" census: the plan counted
 * lumps-to-names over the 69, but DSOUCH/DSJUMP cover NO table row, so
 * 108 − 67 = 41. Of these, `chgun` needs no lump at runtime (the link branch
 * retargets to pistol, §0.2 rule 1), leaving 40 genuinely silent — all
 * Doom-2/Keyed/cheat-only sounds plus the chat-only `radio` (M11), i.e.
 * unreachable under our shareware policy. Vanilla would I_Error through
 * W_GetNumForName on the lazy path (s_sound.c:364-365 → i_sound.c:451-456);
 * getsfx's boot path instead silently substitutes dspistol
 * (i_sound.c:215-219). Our policy (plan §0.10): resolve to null = SILENT,
 * never throw; sfxdata.test.ts re-audits this exact set against the WAD.
 */
export const DS_MISSING_NAMES: readonly string[] = [
  'dshtgn', 'dbopn', 'dbcls', 'dbload', 'vipain', 'mnpain', 'pepain',
  'bspsit', 'kntsit', 'vilsit', 'mansit', 'pesit', 'skepch', 'vilatk',
  'skeswg', 'bspdth', 'vildth', 'kntdth', 'pedth', 'skedth', 'bspact',
  'bspwlk', 'vilact', 'chgun', 'flame', 'flamst', 'bospit', 'boscub',
  'bossit', 'bospn', 'bosdth', 'manatk', 'mandth', 'sssit', 'ssdth',
  'keenpn', 'keendt', 'skeact', 'skesit', 'skeatk', 'radio',
];
