/**
 * Tests for ui/humessage.ts — M9-06 (plan §M9-06 acceptance 1-2 + the
 * write-site census / lifetime-timing / string-exactness gates).
 *
 * Every timing claim traces to hu_stuff.c:512-531 + hu_stuff.h:44
 * (HU_MSGTIMEOUT = 4*TICRATE = 140) and the h=1 widget fact
 * (HU_MSGHEIGHT=1, hu_stuff.h:42 — the pop REPLACES the single line;
 * the "4-slot scroll queue" reading is superseded by the
 * HUlib_addLineToSText hu_lib.c:200-212 wrap at h=1, module header).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildPatchFromColumns } from '../wad/patch';
import { WadFile } from '../wad/wadfile';
import { WadBuilder } from '../../tests/fixtures/wadWriter';
import { FG, screens, vInit, vMemset, vVideoStats } from '../render/vvideo';
import { GOT } from '../sim/p_inter_pickup';
import { PD_BLUEK, PD_BLUEO, PD_REDK, PD_REDO, PD_YELLOWK, PD_YELLOWO } from '../sim/pswitch';
import { GAME_MODE } from '../sim/gamemode';
import { menuSeams } from './menu';
import { KEY_ENTER, KEY_ESCAPE } from '../input/keyboard';

import {
  HU_FONTSTART,
  HU_MESSAGE_STRINGS,
  HU_MSGTIMEOUT,
  HU_WRITE_SITES,
  huDrawer,
  huErase,
  huMessageText,
  huRegisterMenu,
  huReset,
  huResponder,
  huSetDontFuckWithMe,
  huSetWad,
  huStart,
  huState,
  huTicker,
  huTranslateMessage,
  wTitle,
} from './humessage';
import { huTitle, MAPNAMES, MAPNAMES2 } from '../sim/mapnames';

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function solidPatch(w: number, h: number, fill: number): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c++) cols.push(new Array(h).fill(fill % 256));
  return buildPatchFromColumns(cols, 0, 0);
}

/** STCFN033-095: 5x8 uniform-fill glyphs (fill 73 — never the 0 clear). */
function fontWad(): WadFile {
  const b = new WadBuilder('IWAD');
  for (let c = 33; c <= 95; c++) {
    b.addLump(`STCFN${String(c).padStart(3, '0')}`, solidPatch(5, 8, 73));
  }
  const bytes = b.build();
  return WadFile.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

const WAD = fontWad();

const screenHash = (): string => createHash('sha256').update(screens[FG]!.data).digest('hex');
const inkCount = (): number => {
  let n = 0;
  const d = screens[FG]!.data;
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) n++;
  return n;
};
const rowHasInk = (row: number): boolean => {
  const d = screens[FG]!.data;
  for (let x = 0; x < 320; x++) if (d[row * 320 + x] !== 0) return true;
  return false;
};

function plr(message = ''): { message: string } {
  return { message };
}

/** Pop `m`, run N tics (the pop tic INCLUDED counts as visible #1). */
function popAndRun(message: string, tics: number): boolean[] {
  const p = plr(message);
  const vis: boolean[] = [];
  for (let i = 0; i < tics; i++) {
    huTicker(p);
    vis.push(huState.messageOn);
  }
  return vis;
}

beforeEach(() => {
  vInit();
  vMemset(FG, 0);
  huSetWad(WAD);
  huReset();
});

/* ------------------------------------------------------------------ */
/* 1. WRITE-SITE CENSUS — every player.message write in the merged tree */
/* ------------------------------------------------------------------ */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function listSources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e === 'node_modules') continue;
      listSources(p, out);
    } else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const WRITE_RE = /([A-Za-z_][\w.[\]0-9]*)\.message\s*=[^=]/;

describe('write-site census (plan §M9-06 acceptance: every sim msg site in the table)', () => {
  it('every `X.message =` assignment in src/ appears in HU_WRITE_SITES', () => {
    const found = new Map<string, number[]>();
    for (const f of listSources(SRC_ROOT)) {
      const lines = readFileSync(f, 'utf8').split('\n');
      const hits: number[] = [];
      lines.forEach((l, i) => {
        // strip line comments so doc examples never match
        if (WRITE_RE.test(l.replace(/\/\/.*$/, ''))) hits.push(i + 1);
      });
      if (hits.length) found.set(relative(SRC_ROOT, f).replaceAll('\\', '/'), hits);
    }
    // humessage.ts's own pop-clear is the consumer row (line: 0)
    const consumer = found.get('ui/humessage.ts');
    expect(consumer).toBeDefined(); // consumer pop-clear row present
    found.delete('ui/humessage.ts');
    const tabled = new Map<string, number[]>();
    for (const s of HU_WRITE_SITES) {
      if (s.line === 0) continue;
      const key = s.file.replace(/^src\//, '');
      tabled.set(key, [...(tabled.get(key) ?? []), s.line]);
    }
    expect([...found.keys()].sort()).toEqual([...tabled.keys()].sort());
    for (const [f, lines] of found) {
      expect([...lines].sort((a, b) => a - b)).toEqual(
        [...(tabled.get(f) ?? [])].sort((a, b) => a - b),
      );
    }
  });

  it('census rows name the real write sites at their exact lines', () => {
    for (const s of HU_WRITE_SITES) {
      if (s.line === 0) {
        expect(readFileSync(join(SRC_ROOT, 'ui/humessage.ts'), 'utf8')).toContain(
          "plr.message = ''; // :525 — THE player.message drain",
        );
        continue;
      }
      const src = readFileSync(join(SRC_ROOT, '..', s.file), 'utf8').split('\n');
      expect(src[s.line - 1] ?? '').toMatch(/\.message\s*=[^=]/); // ${s.file}:${s.line}
    }
  });

  it('every GOT/PD id the sim can write has a d_englsh.h string', () => {
    for (const id of Object.values(GOT)) {
      expect(HU_MESSAGE_STRINGS[id], `GOT id ${id}`).toBeTypeOf('string');
    }
    for (const id of [PD_BLUEO, PD_REDO, PD_YELLOWO, PD_BLUEK, PD_REDK, PD_YELLOWK]) {
      expect(HU_MESSAGE_STRINGS[id], `PD id ${id}`).toBeTypeOf('string');
    }
  });

  it('secret-found: 1.10 truth — no HUD message site, no GOTSECRET (census finding)', () => {
    // p_spec.c/p_setup.c/p_doors.c in linuxdoom-1.10 write NO secret
    // message (docs/research/05-specials.md §"no ... message": surfaces
    // on the intermission screen only, d_englsh.h:512 — M9-07/10); the
    // merged pspec.ts:619 carries the same finding.
    expect('GOTSECRET' in HU_MESSAGE_STRINGS).toBe(false);
    expect('GOTSECRET2' in HU_MESSAGE_STRINGS).toBe(false);
    const pspec = readFileSync(join(SRC_ROOT, 'sim/pspec.ts'), 'utf8');
    expect(pspec).not.toMatch(/\.message\s*=[^=]/);
    expect(pspec).toMatch(/no message in 1.10/);
    // priority MECHANISM still verbatim (hu_stuff.c:518/529): the latch
    // is settable and punches the showMessages gate — tested in §4.
  });
});

/* ------------------------------------------------------------------ */
/* 2. d_englsh.h string exactness                                      */
/* ------------------------------------------------------------------ */

describe('d_englsh.h strings (byte-exact, linuxdoom-1.10 :80-130)', () => {
  it('medikit (GOTMEDINEED condition at health<25 is p_inter_pickup.ts:515)', () => {
    const p = plr(GOT.GOTMEDIKIT);
    huTicker(p);
    expect(huMessageText()).toBe('Picked up a medikit.');
    const p2 = plr(GOT.GOTMEDINEED);
    huTicker(p2);
    expect(huMessageText()).toBe('Picked up a medikit that you REALLY need!');
  });

  it('representative pins + all 43 keys', () => {
    expect(HU_MESSAGE_STRINGS.GOTARMOR).toBe('Picked up the armor.');
    expect(HU_MESSAGE_STRINGS.GOTMEGA).toBe('Picked up the MegaArmor!');
    expect(HU_MESSAGE_STRINGS.GOTHTHBONUS).toBe('Picked up a health bonus.');
    expect(HU_MESSAGE_STRINGS.GOTSUIT).toBe('Radiation Shielding Suit');
    expect(HU_MESSAGE_STRINGS.GOTSUPER).toBe('Supercharge!');
    expect(HU_MESSAGE_STRINGS.GOTBFG9000).toBe('You got the BFG9000!  Oh, yes.');
    expect(HU_MESSAGE_STRINGS.GOTCHAINSAW).toBe('A chainsaw!  Find some meat!');
    expect(HU_MESSAGE_STRINGS.GOTBLUECARD).toBe('Picked up a blue keycard.');
    expect(HU_MESSAGE_STRINGS.PD_BLUEK).toBe('You need a blue key to open this door');
    expect(Object.keys(HU_MESSAGE_STRINGS).length).toBe(43); // 37 GOT + 6 PD
  });

  it('literal passthrough (menu.ts writes literals directly)', () => {
    expect(huTranslateMessage('Messages ON')).toBe('Messages ON');
    expect(huTranslateMessage('Gamma correction level 3')).toBe('Gamma correction level 3');
  });
});

/* ------------------------------------------------------------------ */
/* 3. LIFETIME / QUEUE (acceptance 1) — HU_MSGTIMEOUT + the h=1 queue   */
/* ------------------------------------------------------------------ */

describe('HU_Ticker lifetime (hu_stuff.c:512-531, hu_stuff.h:44)', () => {
  it('HU_MSGTIMEOUT is 4*35 = 140', () => {
    expect(HU_MSGTIMEOUT).toBe(140);
  });

  it('a message is visible for EXACTLY 140 tics, then off', () => {
    const vis = popAndRun(GOT.GOTSTIM, 142);
    expect(vis.slice(0, 140).every(Boolean)).toBe(true);
    expect(vis.slice(140)).toEqual([false, false]);
  });

  it('pop clears player.message and arms the counter', () => {
    const p = plr(GOT.GOTSTIM);
    huTicker(p);
    expect(p.message).toBe(''); // hu_stuff.c:525 — the drain
    expect(huState.counter).toBe(140);
    expect(huMessageText()).toBe('Picked up a stimpack.');
  });

  it('plain pop is UNprotected (:529=false): next message pops next tic', () => {
      const p = plr(GOT.GOTSTIM);
      huTicker(p); // tic 1: pops stimpack
      expect(huState.notToBeFuckedWith).toBe(false); // :529 plain ⇒ false
      p.message = GOT.GOTCLIP; // queued in the 1-deep field
      huTicker(p); // tic 2: pops NOW, replaces the line, counter re-armed
      expect(p.message).toBe('');
      expect(huMessageText()).toBe('Picked up a clip.');
      expect(huState.counter).toBe(140);
      expect(huState.messageOn).toBe(true);
      // and the REPLACED message now lives its own 140 tics:
      for (let i = 0; i < 139; i++) {
        huTicker(p);
        expect(huState.messageOn).toBe(true);
      }
      huTicker(p); // expiry tic of the clip
      expect(huState.messageOn).toBe(false);
    });

  it('queue is the 1-deep field: mid-flight overwrite ⇒ newest pops', () => {
    const p = plr(GOT.GOTSTIM);
    huTicker(p);
    p.message = GOT.GOTROCKET;
    p.message = GOT.GOTCELL; // newest wins (string field = hu_stuff's char*)
    huTicker(p); // next tic pops the newest
    expect(huMessageText()).toBe('Picked up an energy cell.');
  });

  it('h=1 widget: each pop REPLACES the line (HU_MSGHEIGHT=1, hu_lib.c:200)', () => {
    const p = plr(GOT.GOTSTIM);
    huTicker(p);
    huSetDontFuckWithMe(true); // priority bypasses the nottfuck latch's
    huTicker(p); // protection only via the dontfuckwithme arm (:523)
    expect(huState.messageOn).toBe(true); // still up; counter ticking down
    p.message = GOT.GOTCLIP; // protected: stays
    huSetDontFuckWithMe(true);
    p.message = GOT.GOTROCKET;
    huTicker(p); // dontfuckwithme ⇒ replace the single line at once
    expect(huMessageText()).toBe('Picked up a rocket.');
  });

  it('80-char line cap (HU_MAXLINELENGTH, hu_lib.c:74)', () => {
    const p = plr('x'.repeat(95));
    huTicker(p);
    expect(huMessageText().length).toBe(80);
  });
});

/* ------------------------------------------------------------------ */
/* 4. showMessages gate + priority (acceptance 2, hu_stuff.c:518)       */
/* ------------------------------------------------------------------ */

describe('showMessages gate (default ON; priority punch-through)', () => {
  it('flag defaults true and is seam-owned here', () => {
    expect(huState.showMessages).toBe(true);
    huRegisterMenu();
    expect(menuSeams.showMessages?.()).toBe(true);
    menuSeams.setShowMessages?.(false);
    expect(huState.showMessages).toBe(false);
    huState.showMessages = true;
  });

  it('OFF ⇒ message NOT consumed (stays pending), re-ON pops it fresh', () => {
    huState.showMessages = false;
    const p = plr(GOT.GOTSTIM);
    for (let i = 0; i < 10; i++) huTicker(p);
    expect(p.message).toBe(GOT.GOTSTIM); // gate skipped the whole block
    expect(huState.messageOn).toBe(false);
    huState.showMessages = true;
    huTicker(p);
    expect(p.message).toBe('');
    expect(huState.counter).toBe(140);
  });

  it('OFF mid-flight: pending survives expiry while off, pops on next on-tic', () => {
    const p = plr(GOT.GOTSTIM);
    huTicker(p);
    huState.showMessages = false;
    p.message = GOT.GOTCLIP;
    for (let i = 0; i < 140; i++) huTicker(p); // expiry at the last call
    expect(huState.messageOn).toBe(false);
    expect(p.message).toBe(GOT.GOTCLIP); // gate closed at the expiry tic
    huState.showMessages = true;
    huTicker(p);
    expect(huMessageText()).toBe('Picked up a clip.');
  });

  it("priority (dontfuckwithme) lines punch the OFF gate (:518 ':529')", () => {
    huState.showMessages = false;
    huSetDontFuckWithMe(true);
    const p = plr(GOT.GOTMEDINEED);
    huTicker(p);
    expect(p.message).toBe('');
    expect(huState.messageOn).toBe(true);
    expect(huState.notToBeFuckedWith).toBe(true);
    expect(huState.dontFuckWithMe).toBe(false); // :530 consumed
    // protected while up, even with messages OFF:
    p.message = GOT.GOTCLIP;
    for (let i = 0; i < 139; i++) huTicker(p);
    expect(p.message).toBe(GOT.GOTCLIP);
  });
});

/* ------------------------------------------------------------------ */
/* 5. HU_Responder — the ENTER refresh row (hu_stuff.c:659-664)         */
/* ------------------------------------------------------------------ */

describe('HU_Responder message half', () => {
  it('Enter re-shows the current line for a fresh 140 tics and eats the key', () => {
    popAndRun(GOT.GOTSTIM, 141); // run past expiry
    expect(huState.messageOn).toBe(false);
    expect(huMessageText()).toBe('Picked up a stimpack.'); // line kept
    expect(huResponder({ type: 'keydown', data1: KEY_ENTER })).toBe(true);
    expect(huState.messageOn).toBe(true);
    expect(huState.counter).toBe(140);
  });

  it('keyup never eaten; other keys pass through (SP, chat no-op)', () => {
    expect(huResponder({ type: 'keyup', data1: KEY_ENTER })).toBe(false);
    expect(huResponder({ type: 'keydown', data1: KEY_ESCAPE })).toBe(false);
    expect(huResponder({ type: 'keydown', data1: 't'.charCodeAt(0) })).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Drawer over vvideo (STCFN mirror + automap-only title)            */
/* ------------------------------------------------------------------ */

describe('HU_Drawer (hu_stuff.c:486-492 over hu_lib.c:100-135)', () => {
  it('message pixels land at (0,0) while on; zero writes when off', () => {
    const p = plr(GOT.GOTSTIM);
    huTicker(p);
    huDrawer();
    expect(inkCount()).toBeGreaterThan(0);
    expect(rowHasInk(0)).toBe(true); // HU_MSGY = 0
    const h = screenHash();
    for (let i = 0; i < 139; i++) huTicker(p);
    huTicker(p); // expiry
    huDrawer(); // must scribble NOTHING (erase = recompose, HU_Erase)
    expect(screenHash()).toBe(h);
    vMemset(FG, 0);
    huErase();
    expect(inkCount()).toBe(0);
  });

  it('long lines stop at the right edge, no RANGECHECK hits', () => {
    const p = plr('W'.repeat(80)); // 80 × 5px = 400 > 320
    huTicker(p);
    const before = vVideoStats.rangeCheckIgnored;
    huDrawer();
    expect(vVideoStats.rangeCheckIgnored).toBe(before);
    expect(inkCount()).toBeGreaterThan(0);
  });

  it('map title: E1M1 copy at HU_Start, drawn ONLY over the automap', () => {
    huStart(1, 1);
    expect(wTitle.l).toBe('E1M1: Hangar');
    expect(wTitle.y).toBe(167 - 8); // STCFN033 height 8
    huDrawer(false);
    expect(rowHasInk(159)).toBe(false);
    huDrawer(true);
    expect(rowHasInk(159)).toBe(true);
  });

  it('HU_Start resets the machine (per level start, :425-429)', () => {
    popAndRun(GOT.GOTSTIM, 10);
    huStart(1, 2);
    expect(huState.messageOn).toBe(false);
    expect(huState.counter).toBe(0);
    expect(huMessageText()).toBe('');
    expect(wTitle.l).toBe('E1M2: Nuclear Plant');
  });
});

/* ------------------------------------------------------------------ */
/* 7. mapnames.ts (table census + HU_TITLE indexing, hu_stuff.c:49/115) */
/* ------------------------------------------------------------------ */

describe('mapnames (hu_stuff.c:115-215, d_englsh.h:142-216)', () => {
  it('episodic table: 4×9 vanilla titles + 9 NEWLEVEL guards', () => {
    expect(MAPNAMES).toHaveLength(45);
    expect(MAPNAMES[0]).toBe('E1M1: Hangar');
    expect(MAPNAMES[35]).toBe('E4M9: Fear');
    expect(MAPNAMES[36]).toBe('NEWLEVEL');
    expect(MAPNAMES2).toHaveLength(32);
    expect(MAPNAMES2[0]).toBe('level 1: entryway');
    expect(MAPNAMES2[31]).toBe('level 32: grosse');
  });

  it('HU_TITLE indexing: (ep-1)*9+map-1 episodic, map-1 commercial', () => {
    expect(huTitle('shareware', 1, 1)).toBe('E1M1: Hangar');
    expect(huTitle('retail', 3, 9)).toBe('E3M9: Warrens');
    expect(huTitle('commercial', 1, 15)).toBe('level 15: industrial zone');
    expect(huTitle('shareware', 5, 1)).toBe('NEWLEVEL');
    expect(GAME_MODE).toBe('shareware'); // this build's mode (title default)
  });

  it('HU_FONTSTART is STCFN033 (hu_stuff.h:30)', () => {
    expect(HU_FONTSTART).toBe(33);
  });
});
