// audio/sfxinfo.test.ts — S_sfx[] census mirror audit (M10-02, plan §M10-02
// acceptance #1: "109 rows, priorities byte-match a fresh grep of sounds.c;
// SFX_ID names == ids").
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { NUMSFX, SFX_ID } from '../sim/psound_stub';
import {
  DEDUP_SFX_IDS,
  DS_MISSING_NAMES,
  NUMSFX as MIRROR_NUMSFX,
  SFX_INFO,
  dsLumpName,
  sfxIdForName,
} from './sfxinfo';

const MIRROR_C = '/tmp/DOOM-master/linuxdoom-1.10/sounds.c';

describe('S_sfx mirror — table census (sounds.c:117-226)', () => {
  it('has NUMSFX rows, index == id, cites strictly ascending in [117, 226]', () => {
    expect(SFX_INFO.length).toBe(109);
    expect(NUMSFX).toBe(109);
    expect(MIRROR_NUMSFX).toBe(109);
    let prevLine = 0;
    SFX_INFO.forEach((row, id) => {
      expect(row.id).toBe(id);
      expect(row.soundsCLine).toBeGreaterThan(prevLine);
      expect(row.soundsCLine).toBeGreaterThanOrEqual(117);
      expect(row.soundsCLine).toBeLessThanOrEqual(226);
      prevLine = row.soundsCLine;
    });
  });

  it('priority census: 15-level histogram over range [0..120], dummy row 0', () => {
    const hist: Record<number, number> = {};
    for (const r of SFX_INFO) {
      hist[r.priority] = (hist[r.priority] ?? 0) + 1;
    }
    expect(hist).toEqual({
      0: 1, // S_sfx[0] dummy
      32: 13, // telept, player deaths, bruiser/cybie/spider + Doom-2 deaths
      60: 4, // barexp, tink, getpow, radio
      64: 15, // default weapon/weapon-ish rows + chgun link
      70: 33, // attacks/deaths/misc family default
      78: 6, // swtchn/x, slop, itemup, wpnup, noway
      90: 6, // *sit slow family
      92: 1, // cybsit
      94: 1, // brssit
      96: 7, // pains + oof
      98: 7, // posit*/bgsit*/sgtsit/cacsit
      100: 10, // plats, doors, *act rows, bdopn/bdcls/itmbk
      118: 1, // sawidl
      119: 1, // stnmov
      120: 3, // posact, bgact, dmact
    });
    expect(Math.max(...SFX_INFO.map((r) => r.priority))).toBe(120);
    expect(SFX_INFO[0]!.priority).toBe(0);
  });

  it('spot rows vs sounds.c cites', () => {
    expect(SFX_INFO[1]).toMatchObject({ name: 'pistol', priority: 64, soundsCLine: 119 });
    expect(SFX_INFO[11]).toMatchObject({ name: 'sawidl', priority: 118, soundsCLine: 129 });
    expect(SFX_INFO[22]).toMatchObject({ name: 'stnmov', priority: 119, soundsCLine: 140 });
    expect(SFX_INFO[35]).toMatchObject({ name: 'telept', priority: 32, looping: false });
    expect(SFX_INFO[86]).toMatchObject({
      name: 'chgun',
      priority: 64,
      link: 1,
      linkPitch: 150,
      soundsCLine: 204,
    });
  });

  it('looping column: exactly 23 true rows (plan §0.4)', () => {
    expect(SFX_INFO.filter((r) => r.looping).map((r) => r.name)).toEqual([
      'itemup', 'wpnup',
      'posit1', 'posit2', 'posit3', 'bgsit1', 'bgsit2', 'sgtsit', 'cacsit', 'brssit',
      'cybsit', 'spisit', 'bspsit', 'kntsit', 'vilsit', 'mansit', 'pesit',
      'posact', 'bgact', 'dmact', 'bspact', 'bspwlk', 'vilact',
    ]);
  });

  it('links: the ONLY link row is chgun → pistol @ pitch 150', () => {
    const links = SFX_INFO.filter((r) => r.link !== null);
    expect(links.length).toBe(1);
    expect(links[0]).toMatchObject({ name: 'chgun', link: 1, linkPitch: 150 });
  });

  it('SFX_ID (sounds.h enum, sim-side canonical) == mirror, both directions', () => {
    for (const [key, id] of Object.entries(SFX_ID)) {
      const row = SFX_INFO[id];
      expect(row, key).toBeDefined();
      expect(row!.name).toBe(key.toLowerCase().slice(4));
    }
    for (const row of SFX_INFO) {
      const key = `sfx_${row.name[0]!.toUpperCase()}${row.name.slice(1)}`;
      expect((SFX_ID as Record<string, number>)[key] ?? (SFX_ID as Record<string, number>)[`sfx_${row.name}`]).toBe(row.id);
    }
  });

  it('module-load drift guard: name collision check is sound', () => {
    expect(new Set(SFX_INFO.map((r) => r.name)).size).toBe(SFX_INFO.length);
  });
});

describe('sfxinfo — lookups and sets', () => {
  it('sfxIdForName: table name, sfx_* token, any case; unknown → undefined', () => {
    expect(sfxIdForName('pistol')).toBe(1);
    expect(sfxIdForName('sfx_pistol')).toBe(1);
    expect(sfxIdForName('SFX_OOF')).toBe(34);
    expect(sfxIdForName('none')).toBe(0);
    expect(sfxIdForName('radio')).toBe(108);
    expect(sfxIdForName('nope')).toBeUndefined();
    expect(sfxIdForName('')).toBeUndefined();
  });

  it('dsLumpName mirrors sprintf("ds%s") (i_sound.c:451-456)', () => {
    expect(dsLumpName(1)).toBe('DSPISTOL');
    expect(dsLumpName(34)).toBe('DSOOF');
    expect(dsLumpName(86)).toBe('DSCHGUN'); // resolvable name; lump absent (§0.10)
    expect(() => dsLumpName(109)).toThrow(RangeError);
    expect(() => dsLumpName(-1)).toThrow(RangeError);
  });

  it('DEDUP_SFX_IDS == the addsfx hardcoded six (i_sound.c:285-290)', () => {
    expect(DEDUP_SFX_IDS).toEqual([10, 11, 12, 13, 22, 1]);
  });

  it('DS_MISSING_NAMES: 41 table names, all real, incl. the chgun alias', () => {
    expect(DS_MISSING_NAMES.length).toBe(41);
    const names = new Set(SFX_INFO.slice(1).map((r) => r.name));
    for (const n of DS_MISSING_NAMES) {
      expect(names.has(n), n).toBe(true);
    }
    expect(new Set(DS_MISSING_NAMES).size).toBe(41);
    expect(DS_MISSING_NAMES).toContain('chgun');
    expect(DS_MISSING_NAMES).toContain('radio');
  });
});

describe.skipIf(!existsSync(MIRROR_C))(
  'row-by-row diff vs the sounds.c mirror (fresh parse)',
  () => {
    it('every transcription field equals a fresh grep of sounds.c', () => {
      const src = readFileSync(MIRROR_C, 'utf8').split('\n');
      const re =
        /\{\s*"(\w+)",\s*(true|false),\s*(\d+),\s*(0|&S_sfx\[sfx_(\w+)\]),\s*(-?\d+),\s*(-?\d+)/;
      const parsed: { name: string; loop: boolean; prio: number; link: string | null; pitch: number; line: number }[] = [];
      src.forEach((ln, i) => {
        const m = ln.match(re);
        if (m) {
          parsed.push({
            name: m[1]!,
            loop: m[2] === 'true',
            prio: Number(m[3]),
            link: m[5] ?? null,
            pitch: m[5] ? Number(m[6]) : 0,
            line: i + 1,
          });
        }
      });
      expect(parsed.length).toBe(SFX_INFO.length);
      parsed.forEach((p, id) => {
        const row = SFX_INFO[id]!;
        expect(row.id, `id ${id}`).toBe(id);
        expect(row.name, `name @${p.line}`).toBe(p.name);
        expect(row.looping, `looping @${p.line}`).toBe(p.loop);
        expect(row.priority, `priority @${p.line}`).toBe(p.prio);
        expect(row.link, `link @${p.line}`).toBe(p.link === null ? null : sfxIdForName(p.link));
        expect(row.linkPitch, `linkPitch @${p.line}`).toBe(p.pitch);
        expect(row.soundsCLine, `cite @${p.line}`).toBe(p.line);
      });
    });
  },
);
