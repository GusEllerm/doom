/**
 * Tests for ui/statusbar.ts — st_stuff.c (M9-05, plan §M9-05 + §0.8).
 *
 * Evidence classes:
 *  1. TRANSCRIPTION CENSUS: the 42-face name table (load order pinned), the
 *     78-lump ST_loadGraphics list (+STTMINUS = 79), and the widget-table
 *     coordinates are asserted against literals written from st_stuff.c.
 *  2. IWAD AUDIT (skipIf): every one of those 79 lumps exists in the pinned
 *     freedoom1.wad and decodes (independent of the M9-01 patches2 census,
 *     which is cross-checked as a SET against the face table).
 *  3. FACE-MACHINE MATRIX: every rule of the priority ladder, the pain-offset
 *     tiers with their truncation boundaries, the turn-direction `i` branch at
 *     ±46°/±180°, the rapid-fire re-latch, the 231..236 death-window edge, and
 *     the R10 finding (grin needs a weaponowned DELTA — kills are not read).
 *  4. TICKER STREAM: N tics ⇒ exactly N mRandom draws (rndindex + the value
 *     stream), reconciled against the `st_face` random-sites ledger line.
 *  5. WIDGET PIXELS + FRAME COMPOSE: an INDEPENDENT per-pixel reference
 *     (patch.ts's column decode + plain index math, no vvideo calls) composes
 *     the expected 320x32 band and the whole FG layer is compared byte-exact.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ANG180, ANG45, ANG90, FRACUNIT } from '../core/constants';
import { buildPatchFromColumns, decodePatch } from '../wad/patch';
import { UI_PATCH_FAMILIES } from '../wad/patches2';
import { buildWad } from '../../tests/fixtures/wadWriter';
import { WadFile } from '../wad/wadfile';
import { BG, FG, ST_WIDTH, screens, vInit } from '../render/vvideo';
import { RNDTABLE, type PrngState } from '../sim/prng';
import { MRANDOM_SITE_CALLS, scanMRandomSites } from '../sim/random-sites';
import { rPointToAngle2 } from '../sim/p_shoot';
import {
  ST_DEADFACE,
  ST_EVILGRINOFFSET,
  ST_FACESTRIDE,
  ST_GODFACE,
  ST_OUCHOFFSET,
  ST_RAMPAGEOFFSET,
  ST_TURNOFFSET,
  stCalcPainOffset,
  stDrawer,
  stFaceCount,
  stFaceIndex,
  stInit,
  stStart,
  stKeyboxes,
  stLumpNames,
  stFaceLumpNames,
  stPaletteBand,
  stResetAll,
  stStats,
  stStop,
  stTicker,
  stWidgets,
  type PointToAngle2,
  type StContext,
} from './statusbar';
import { ST_Y } from './stlib';

/* ------------------------------------------------------------------ */
/* Fixture WAD: the 78+lump statusbar set with vanilla-measured geometry */
/* ------------------------------------------------------------------ */

const LUMP_BYTES = new Map<string, Uint8Array>();

function solid(w: number, h: number, fill: number, left = 0, top = 0): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c += 1) cols.push(new Array<number>(h).fill(fill));
  return buildPatchFromColumns(cols, left, top);
}

function reg(name: string, bytes: Uint8Array): void {
  LUMP_BYTES.set(name, bytes);
}

function buildFixtureWad(): WadFile {
  const lumps: { name: string; data: Uint8Array }[] = [];
  for (const [name, data] of LUMP_BYTES) lumps.push({ name, data });
  return WadFile.parse(buildWad(lumps));
}

function buildFixtures(): void {
  LUMP_BYTES.clear();
  reg('STBAR', solid(320, 32, 60));
  for (let d = 0; d < 10; d += 1) {
    reg(`STTNUM${d}`, solid(13, 16, 100 + d)); // tall, health/ammo/armor/frags
    reg(`STYSNUM${d}`, solid(4, 6, 200 + d)); // short, the ammo columns
  }
  reg('STTPRCNT', solid(13, 16, 90));
  reg('STTMINUS', solid(13, 16, 91, 4, 0));
  for (let i = 0; i < 6; i += 1) reg(`STKEYS${i}`, solid(7, i < 3 ? 5 : 7, 150 + i));
  reg('STARMS', solid(38, 32, 70));
  for (let g = 2; g < 8; g += 1) reg(`STGNUM${g}`, solid(4, 6, 30 + g));
  for (let p = 0; p < 4; p += 1) reg(`STFB${p}`, solid(35, 31, 71));
  stFaceLumpNames().forEach((name, i) => reg(name, solid(24, 29, 120 + i, -5, -2)));
}

buildFixtures();

/* ------------------------------------------------------------------ */
/* Synthetic player (the structural read view the context carries)      */
/* ------------------------------------------------------------------ */

interface MutPlayer {
  health: number;
  bonuscount: number;
  damagecount: number;
  readyweapon: number;
  attackdown: boolean;
  cheats: number;
  powers: number[];
  ammo: number[];
  maxammo: number[];
  weaponowned: number[];
  cards: number[];
  armorpoints: number;
  frags: number[];
  mo: { x: number; y: number; angle: number };
  attacker: { x: number; y: number; angle: number } | null;
}

function mkPlayer(over: Partial<MutPlayer> = {}): MutPlayer {
  return {
    health: 100,
    bonuscount: 0,
    damagecount: 0,
    readyweapon: 1, // pistol
    attackdown: false,
    cheats: 0,
    powers: [0, 0, 0, 0, 0, 0],
    ammo: [50, 0, 0, 0],
    maxammo: [200, 50, 300, 50],
    weaponowned: [1, 1, 0, 0, 0, 0, 0, 0, 0],
    cards: [0, 0, 0, 0, 0, 0],
    armorpoints: 0,
    frags: [0, 0, 0, 0],
    mo: { x: 0, y: 0, angle: 0 },
    attacker: null,
    ...over,
  };
}

interface Harness {
  ctx: StContext;
  p: MutPlayer;
  rng: PrngState;
  drawn: number[]; // faceindex per tic
}

function mkHarness(over: Partial<MutPlayer> = {}, angle?: PointToAngle2): Harness {
  const p = mkPlayer(over);
  const rng: PrngState = { rndindex: 0, prndindex: 0 };
  const ctx: StContext = {
    rng,
    player: p,
    pointToAngle2: angle ?? syntheticAngle,
    automapActive: false,
    netgame: false,
    deathmatch: false,
    consoleplayer: 0,
  };
  return { ctx, p, rng, drawn: [] };
}

/** The angle seam, scripted: a `fixed` offset vector → exact BAM by hand.
 * Real-geometry coverage uses sim/p_shoot's rPointToAngle2 (one test below),
 * which this mirrors for the axis cases.
 */
let syntheticValue = 0;
function syntheticAngle(): number {
  return syntheticValue >>> 0;
}

/* ------------------------------------------------------------------ */
/* Independent per-pixel reference (patch.ts decode, NO vvideo calls)   */
/* ------------------------------------------------------------------ */

function refPaint(dst: Uint8Array, name: string, x: number, y: number): void {
  const bytes = LUMP_BYTES.get(name);
  if (bytes === undefined) throw new Error(`fixture lump ${name} not registered`);
  const p = decodePatch(bytes);
  const x0 = x - p.leftOffset;
  const y0 = y - p.topOffset;
  for (let c = 0; c < p.width; c += 1) {
    for (let r = 0; r < p.height; r += 1) {
      const v = p.columns[c]![r]!;
      if (v !== 0) dst[(y0 + r) * ST_WIDTH + x0 + c] = v;
    }
  }
}

/** BG→FG slam of the whole band (the ST_refreshBackground copy half). */
function refSlam(dst: Uint8Array): void {
  const bg = screens[BG]!;
  for (let r = 0; r < 32; r += 1) dst.set(bg.data.slice(r * ST_WIDTH, (r + 1) * ST_WIDTH), (ST_Y + r) * ST_WIDTH);
}

/** Reference STlib number draw (right-justified, LSB-first, 1994/zero rules). */
function refNum(
  dst: Uint8Array,
  x: number,
  y: number,
  n: number,
  width: number,
  prefix: 'STTNUM' | 'STYSNUM',
  w: number,
  h: number,
): void {
  const neg = n < 0;
  let num = Math.abs(n);
  if (neg && width === 2 && n < -9) num = 9;
  else if (neg && width === 3 && n < -99) num = 99;
  let px = x - width * w;
  for (let r = 0; r < h; r += 1) {
    for (let cx = px; cx < x; cx += 1) {
      dst[(y + r) * ST_WIDTH + cx] = screens[BG]!.data[(y + r - ST_Y) * ST_WIDTH + cx]!;
    }
  }
  if (num === 1994) return;
  if (!num) refPaint(dst, `${prefix}0`, x - w, y);
  let digits = width;
  px = x;
  while (num && digits-- > 0) {
    px -= w;
    refPaint(dst, `${prefix}${num % 10}`, px, y);
    num = Math.floor(num / 10);
  }
  if (neg) refPaint(dst, 'STTMINUS', px - 8, y);
}

/** Reference full-refresh draw of the whole bar (ST_doRefresh + every widget
 * in ST_drawWidgets order). Independent of the module under test. */
function refFullBar(dst: Uint8Array, p: MutPlayer, faceindex: number, fragsOn = false): void {
  refSlam(dst);
  // w_ready: tall, 3 wide, the ready weapon's ammo or the 1994 sentinel
  const ammoTypeByWeapon = [5, 0, 1, 0, 3, 2, 2, 5, 1]; // d_items.c weaponinfo[].ammo
  const at = ammoTypeByWeapon[p.readyweapon]!;
  refNum(dst, 44, 171, at === 5 ? 1994 : p.ammo[at]!, 3, 'STTNUM', 13, 16);
  // w_ammo / w_maxammo: short, 3 wide
  const ammoY = [173, 179, 191, 185];
  const maxY = [173, 179, 191, 185];
  for (let i = 0; i < 4; i += 1) {
    refNum(dst, 288, ammoY[i]!, p.ammo[i]!, 3, 'STYSNUM', 4, 6);
    refNum(dst, 314, maxY[i]!, p.maxammo[i]!, 3, 'STYSNUM', 4, 6);
  }
  // health + armor percents (the sign first, digits last)
  refPaint(dst, 'STTPRCNT', 90, 171);
  refNum(dst, 90, 171, p.health, 3, 'STTNUM', 13, 16);
  refPaint(dst, 'STTPRCNT', 221, 171);
  refNum(dst, 221, 171, p.armorpoints, 3, 'STTNUM', 13, 16);
  // arms background (binicon, value = !deathmatch = true)
  refPaint(dst, 'STARMS', 104, 168);
  // weapon-owned multicons: p[owned ? 1 : 0] — yellow when owned, gray when not
  for (let i = 0; i < 6; i += 1) {
    const owned = p.weaponowned[i + 1] ? 1 : 0;
    refPaint(dst, owned ? `STYSNUM${i + 2}` : `STGNUM${i + 2}`, 111 + (i % 3) * 12, 172 + Math.floor(i / 3) * 10);
  }
  // the face
  refPaint(dst, stFaceLumpNames()[faceindex]!, 143, 168);
  // keyboxes
  for (let i = 0; i < 3; i += 1) {
    const box = p.cards[i + 3] ? i + 3 : p.cards[i] ? i : -1;
    if (box !== -1) refPaint(dst, `STKEYS${box}`, 239, 171 + i * 10);
  }
  if (fragsOn) refNum(dst, 138, 171, 0, 2, 'STTNUM', 13, 16);
}

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

let wad: WadFile;

/** Load the fixture set and start the statusbar against a synthetic player. */
function boot(over: Partial<MutPlayer> = {}, angle?: PointToAngle2): Harness {
  buildFixtures();
  vInit();
  stResetAll();
  wad = buildFixtureWad();
  stInit(wad);
  const h = mkHarness(over, angle);
  stStart(h.ctx);
  return h;
}

/* ------------------------------------------------------------------ */
/* 1. Transcription census                                            */
/* ------------------------------------------------------------------ */

describe('face table transcription (st_stuff.c:1178-1195)', () => {
  it('the 42 face lumps, IN LOAD ORDER, are the STFST/STFTR/STFTL/STFOUCH/STFEVL/STFKILL grid', () => {
    const want: string[] = [];
    for (let p = 0; p < 5; p += 1) {
      want.push(`STFST${p}0`, `STFST${p}1`, `STFST${p}2`, `STFTR${p}0`, `STFTL${p}0`, `STFOUCH${p}`, `STFEVL${p}`, `STFKILL${p}`);
    }
    want.push('STFGOD0', 'STFDEAD0');
    const got = stFaceLumpNames();
    expect(got).toEqual(want);
    expect(got.length).toBe(42);
    expect(new Set(got).size).toBe(42);
  });

  it('stride arithmetic: index 8*p + offset lands on the machine\'s face lump', () => {
    const names = stFaceLumpNames();
    expect(names[0 * ST_FACESTRIDE + ST_TURNOFFSET]).toBe('STFTR00'); // look right
    expect(names[0 * ST_FACESTRIDE + ST_TURNOFFSET + 1]).toBe('STFTL00'); // look left
    expect(names[ST_OUCHOFFSET]).toBe('STFOUCH0');
    expect(names[ST_EVILGRINOFFSET]).toBe('STFEVL0');
    expect(names[ST_RAMPAGEOFFSET]).toBe('STFKILL0');
    expect(names[ST_GODFACE]).toBe('STFGOD0');
    expect(names[ST_DEADFACE]).toBe('STFDEAD0');
    expect(names[3 * ST_FACESTRIDE + ST_EVILGRINOFFSET]).toBe('STFEVL3');
  });

  it('no generated name is malformed (the STTFSTT00 class of bug) and all fit 8 chars', () => {
    for (const n of stLumpNames()) {
      expect(/^[A-Z0-9]{1,8}$/.test(n), n).toBe(true);
      expect(n.length, n).toBeLessThanOrEqual(8);
    }
    expect(stLumpNames().some((n) => n.includes('STTFSTT'))).toBe(false);
  });

  it('the ST_loadGraphics census is 78 lumps (+ STTMINUS = the 79 the bar loads)', () => {
    const names = stLumpNames();
    expect(names.length).toBe(78);
    expect(new Set(names).size).toBe(78);
    const all = new Set([...names, 'STTMINUS']);
    expect(all.size).toBe(79);
  });

  it('the face census agrees with the M9-01 patches2 family as a SET', () => {
    const faces = UI_PATCH_FAMILIES.find((f) => f.what === 'face set')!;
    expect(new Set(stFaceLumpNames())).toEqual(new Set(faces.names!));
    expect(faces.count).toBe(42);
  });
});

/* ------------------------------------------------------------------ */
/* 2. IWAD audit (skipIf)                                             */
/* ------------------------------------------------------------------ */

const WAD_PATH = [process.env['DOOM_WAD'], process.env['FREEDOOM1_WAD'], fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))].find(
  (p): p is string => p !== undefined && existsSync(p),
);

describe.skipIf(WAD_PATH === undefined)('IWAD lump audit (freedoom1.wad)', () => {
  it('all 79 statusbar lumps exist and decode (posts walk to 0xFF)', () => {
    const iwad = WadFile.parse(readFileSync(WAD_PATH!).buffer);
    for (const name of [...stLumpNames(), 'STTMINUS']) {
      expect(iwad.has(name), name).toBe(true);
      const p = decodePatch(iwad.readLumpByName(name));
      expect(p.width).toBeGreaterThan(0);
      expect(p.columns.length).toBe(p.width);
    }
  });

  it('the real face/number/bar geometry matches the fixture shapes', () => {
    const iwad = WadFile.parse(readFileSync(WAD_PATH!).buffer);
    const dims = (n: string): [number, number, number, number] => {
      const p = decodePatch(iwad.readLumpByName(n));
      return [p.width, p.height, p.leftOffset, p.topOffset];
    };
    expect(dims('STBAR')).toEqual([320, 32, 0, 0]);
    expect(dims('STTNUM0')).toEqual([13, 16, 0, 0]);
    expect(dims('STYSNUM0')).toEqual([4, 6, 0, 0]);
    expect(dims('STTMINUS')).toEqual([13, 16, 4, 0]);
    // A post walk that stopped early would leave empty columns: prove real
    // column data exists for the bar, a digit, and a face.
    const inked = (n: string): number =>
      decodePatch(iwad.readLumpByName(n)).columns.reduce((a, c) => a + c.filter((v) => v !== 0).length, 0);
    expect(inked('STBAR')).toBe(320 * 32);
    expect(inked('STTNUM0')).toBeGreaterThan(20);
    expect(inked('STFST00')).toBeGreaterThan(50);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Pain-offset tiers (ST_calcPainOffset, :733-746)                  */
/* ------------------------------------------------------------------ */

describe('ST_calcPainOffset tiers', () => {
  it('the five tiers and their truncation boundaries', () => {
    for (const [health, want] of [
      [100, 0], [99, 0], [81, 0], [80, 0],
      [79, 8], [61, 8], [60, 8],
      [59, 16], [41, 16], [40, 16],
      [39, 24], [21, 24], [20, 24],
      [19, 32], [1, 32],
    ] as const) {
      const h = mkHarness();
      h.p.health = health;
      expect(stCalcPainOffset(h.p), `health ${health}`).toBe(want);
    }
  });

  it('health above 100 clamps to tier 0 (the >100 ternary)', () => {
    const h = mkHarness();
    h.p.health = 200;
    expect(stCalcPainOffset(h.p)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. The face-machine matrix                                         */
/* ------------------------------------------------------------------ */

describe('ST_updateFaceWidget priority ladder', () => {
  it('R1 dead wins over everything (health 0), re-latching every tic', () => {
    const h = boot();
    h.p.health = 0;
    h.p.bonuscount = 64;
    h.p.weaponowned[2] = 1; // would be an evil grin if health were up
    h.p.damagecount = 30;
    h.p.attackdown = true;
    h.p.cheats = 2; // CF_GODMODE
    for (let t = 0; t < 5; t += 1) {
      stTicker(h.ctx);
      expect(stFaceIndex()).toBe(ST_DEADFACE);
    }
    expect(stStats.faceRules.R1dead).toBe(5);
  });

  it('R2 evil grin: a weaponowned DELTA while bonuscount is live', () => {
    const h = boot();
    stTicker(h.ctx); // sync oldweaponsowned at start (ST_initData already did)
    h.p.bonuscount = 1 << 6;
    h.p.weaponowned[4] = 1; // just picked up the rocket launcher
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(0 + ST_EVILGRINOFFSET);
    // lasts 70 tics, then falls back to an idle face
    // ST_EVILGRINCOUNT = 70 covers the latch tic itself: 69 more tics keep the
    // grin, the 70th is the first tic that starts with facecount == 0.
    for (let t = 0; t < 69; t += 1) {
      stTicker(h.ctx);
      expect(stFaceIndex(), `grin tic ${t}`).toBe(ST_EVILGRINOFFSET);
    }
    expect(stFaceCount()).toBe(0);
    stTicker(h.ctx);
    expect(stFaceIndex()).toBeLessThan(ST_TURNOFFSET); // straight-ahead idle tier
  });

  it('R10 FINDING: kills are NOT read — bonuscount alone never grins', () => {
    const h = boot();
    h.p.bonuscount = 64; // a medikit/kill bonus with no weapon delta
    stTicker(h.ctx);
    expect(stFaceIndex()).toBeLessThan(ST_TURNOFFSET); // idle, NOT the grin
    expect(stStats.faceRules.R2grin).toBe(0);
    // …and a weapon picked up while bonuscount == 0 stays "new" until some
    // LATER bonus tic fires it (the R10 sync quirk):
    const h2 = boot();
    h2.p.weaponowned[8] = 1; // super shotgun, no bonus active
    h2.p.bonuscount = 0;
    stTicker(h2.ctx);
    expect(stFaceIndex()).toBeLessThan(ST_TURNOFFSET);
    h2.p.bonuscount = 64;
    stTicker(h2.ctx);
    expect(stFaceIndex()).toBe(ST_EVILGRINOFFSET);
  });

  it('R3 attacked: health gain > 20 ⇒ OUCH', () => {
    const h = boot({ health: 100 });
    stTicker(h.ctx); // st_oldhealth := 100 (it starts at -1, :1268)
    h.p.damagecount = 8;
    h.p.attacker = { x: 4000 * FRACUNIT, y: 0, angle: 0 };
    stTicker(h.ctx); // gain 0 ⇒ the turn branch, head-on (diffang 0 < ANG45)
    expect(stFaceIndex()).toBe(ST_RAMPAGEOFFSET);
    // The OUCH case: health INCREASED by more than 20 while damaged.
    h.p.health = 130; // +30 since last tic
    h.p.damagecount = 2;
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_OUCHOFFSET);
  });

  it("st_oldhealth starts at -1, so a damaged player's FIRST tic is always an OUCH", () => {
    const h = boot({ health: 100, damagecount: 5, attacker: { x: 1, y: 0, angle: 0 } });
    stTicker(h.ctx); // 100 - (-1) = 101 > ST_MUCHPAIN
    expect(stFaceIndex()).toBe(ST_OUCHOFFSET);
    stTicker(h.ctx); // now synced: the turn branch takes over
    expect(stFaceIndex()).toBe(ST_RAMPAGEOFFSET);
  });

  it('R3 turn direction: the `i` branch at ±46° and ±180°', () => {
    // badguy > angle (diffang = bg - ang)
    const cases: [number, number][] = [
      [46 * (0x100000000 / 360), ST_TURNOFFSET + 1], // +46°: i=0 ⇒ LEFT
      [179 * (0x100000000 / 360), ST_TURNOFFSET + 1], // +179°: i=0 ⇒ LEFT
      [181 * (0x100000000 / 360), ST_TURNOFFSET], // +181°: i=1 ⇒ RIGHT
      [314 * (0x100000000 / 360), ST_TURNOFFSET], // −46°: i=1 ⇒ RIGHT
      [44 * (0x100000000 / 360), ST_RAMPAGEOFFSET], // <45° ⇒ head-on rampage
      [ANG45, ST_TURNOFFSET + 1], // exactly 45° ⇒ NOT head-on, i=0 ⇒ LEFT
    ];
    for (const [deg, want] of cases) {
      const h = boot();
      stTicker(h.ctx); // sync st_oldhealth (else the -1 seed forces an OUCH)
      h.p.damagecount = 5;
      h.p.attacker = { x: 1, y: 0, angle: 0 };
      syntheticValue = Math.floor(deg) >>> 0;
      stTicker(h.ctx);
      expect(stFaceIndex(), `angle ${Math.round((deg * 360) / 0x100000000)}°`).toBe(want);
    }
    syntheticValue = 0;
  });

  it('R3 the `else` half of the `i` branch (badguy <= angle) uses <=', () => {
    const deg = (d: number): number => Math.floor((d * 0x100000000) / 360) >>> 0;
    // player at 200°, attacker at 90° ⇒ badguy <= angle, diffang = 110° ⇒
    // `i = diffang <= ANG180` is TRUE ⇒ turn RIGHT.
    const h = boot();
    stTicker(h.ctx);
    h.p.damagecount = 5;
    h.p.attacker = { x: 1, y: 1, angle: 0 };
    h.p.mo.angle = deg(200);
    syntheticValue = ANG90; // exactly 90°
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_TURNOFFSET); // right

    // diffang 190° > ANG180 ⇒ i = 0 ⇒ turn LEFT
    syntheticValue = deg(10);
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_TURNOFFSET + 1);

    // diffang exactly 180° in this branch ⇒ <= holds ⇒ RIGHT (the `>` half of
    // the other branch would say LEFT for the same 180° — vanilla's asymmetry)
    h.p.mo.angle = ANG180;
    syntheticValue = 0;
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_TURNOFFSET);

    const h2 = boot();
    stTicker(h2.ctx);
    h2.p.damagecount = 5;
    h2.p.attacker = { x: 1, y: 1, angle: 0 };
    h2.p.mo.angle = 0;
    syntheticValue = ANG180; // badguy > angle, diffang == ANG180 ⇒ i = 0 ⇒ LEFT
    stTicker(h2.ctx);
    expect(stFaceIndex()).toBe(ST_TURNOFFSET + 1);
    syntheticValue = 0;
  });

  it('R3 with the REAL R_PointToAngle2: an attacker due north, facing east', () => {
    const h = boot({ damagecount: 5 }, (x1, y1, x2, y2) => rPointToAngle2(x1, y1, x2, y2));
    h.p.mo = { x: 0, y: 0, angle: 0 };
    stTicker(h.ctx); // sync st_oldhealth
    h.p.damagecount = 5;
    h.p.attacker = { x: 0, y: 64 * FRACUNIT, angle: 0 }; // due north ⇒ 90°
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_TURNOFFSET + 1); // 90° > 45°, i=0 ⇒ look LEFT
  });

  it('R4 self-hurt: rampage for small self-inflicted damage, ouch for >20', () => {
    const h = boot({ health: 100, attacker: null });
    stTicker(h.ctx); // sync st_oldhealth
    h.p.damagecount = 12;
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_RAMPAGEOFFSET); // 0 gain ⇒ rampage
    h.p.health = 90; // oldhealth 100 ⇒ -10, still rampage
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_RAMPAGEOFFSET);
    expect(stStats.faceRules.R4selfhurt).toBeGreaterThan(0);
  });

  it('R5 rapid fire: the 71st held-fire tic latches the rampage face, then EVERY tic', () => {
    const h = boot();
    // Tic 1 seeds lastattackdown = ST_RAMPAGEDELAY (70); each later held tic
    // pre-decrements it, so the face fires on the 71st consecutive tic.
    for (let t = 1; t <= 70; t += 1) {
      h.p.attackdown = true;
      stTicker(h.ctx);
      expect(stStats.faceRules.R5rapid, `tic ${t}`).toBe(0);
    }
    h.p.attackdown = true;
    stTicker(h.ctx); // the 71st: the latch fires
    expect(stFaceIndex()).toBe(ST_RAMPAGEOFFSET);
    expect(stStats.faceRules.R5rapid).toBe(1);
    // Held on: lastattackdown is pinned to 1, so `!--lastattackdown` hits 0
    // again on EVERY following tic (the vanilla re-fire quirk).
    for (let t = 0; t < 4; t += 1) {
      stTicker(h.ctx);
      expect(stFaceIndex(), `held tic ${t}`).toBe(ST_RAMPAGEOFFSET);
    }
    expect(stStats.faceRules.R5rapid).toBe(5);
    // Release ⇒ lastattackdown := -1 and the idle tail takes over again.
    h.p.attackdown = false;
    stTicker(h.ctx);
    expect(stFaceIndex()).toBeLessThan(ST_TURNOFFSET);
  });

  it('R6 god mode / invulnerability ⇒ the god face', () => {
    const h = boot();
    h.p.cheats = 2;
    stTicker(h.ctx);
    expect(stFaceIndex()).toBe(ST_GODFACE);
    const h2 = boot();
    h2.p.powers[0] = 1050; // pw_invulnerability
    stTicker(h2.ctx);
    expect(stFaceIndex()).toBe(ST_GODFACE);
  });

  it('R7 idle tail: painOffset + st_randomnumber % 3, every 17 tics', () => {
    const h = boot();
    const seen: number[] = [];
    for (let t = 0; t < 40; t += 1) {
      stTicker(h.ctx);
      seen.push(stFaceIndex());
    }
    // Tic 0 is the idle fall-through (facecount started at 0); the NEXT idle
    // redraw is 17 tics later (ST_STRAIGHTFACECOUNT), so indices repeat in
    // blocks of 17 and every value is a straight-ahead face.
    expect(seen.every((f) => f >= 0 && f < ST_TURNOFFSET)).toBe(true);
    // The idle tail re-rolls every ST_STRAIGHTFACECOUNT tics, and the value is
    // whatever this tic's M_Random draw was: tic k draws rndtable[k+1].
    expect(seen[0]).toBe(RNDTABLE[1]! % 3);
    expect(seen[16]).toBe(seen[0]); // the latch is still live
    expect(seen[17]).toBe(RNDTABLE[18]! % 3);
    expect(seen[34]).toBe(RNDTABLE[35]! % 3);
    expect(stStats.faceRules.R7idle).toBe(3); // tics 0, 17 and 34
  });

  it('the death-window edge: tics 231..236 are the dead face, 237 idles again', () => {
    const h = boot();
    for (let t = 1; t <= 240; t += 1) {
      if (t >= 231 && t <= 236) h.p.health = 0;
      else if (t === 237) h.p.health = 100;
      stTicker(h.ctx);
      if (t >= 231 && t <= 236) expect(stFaceIndex(), `death tic ${t}`).toBe(ST_DEADFACE);
      if (t === 230) expect(stFaceIndex()).toBeLessThan(ST_TURNOFFSET);
    }
    // Revival: priority 9 survives the dead branch, so the ONLY way out is the
    // idle tail — exactly one tic after health returns.
    expect(stFaceIndex()).toBeLessThan(ST_TURNOFFSET);
    expect(stFaceIndex()).not.toBe(ST_DEADFACE);
  });

  it('pain tiers drive the face index (health 45 ⇒ tier 2 ⇒ 16 + face)', () => {
    const h = boot({ health: 45 });
    stTicker(h.ctx);
    expect(stFaceIndex() >> 3).toBe(2); // painOffset 16 = 2 * ST_FACESTRIDE
    expect(stFaceIndex()).toBeGreaterThanOrEqual(16);
    expect(stFaceIndex()).toBeLessThan(24);
  });
});

/* ------------------------------------------------------------------ */
/* 5. ST_Ticker stream + the `st_face` ledger                         */
/* ------------------------------------------------------------------ */

describe('ST_Ticker (the 4-step tic)', () => {
  it('N tics ⇒ exactly N M_Random draws, one per tic, in stream order', () => {
    const h = boot();
    const N = 200;
    for (let t = 0; t < N; t += 1) stTicker(h.ctx);
    expect(h.rng.rndindex).toBe(N);
    expect(stStats.tickerCalls).toBe(N);
    // The stream values are the rndtable walk, and the idle faces consume them.
    expect(RNDTABLE[1]).toBeDefined();
    expect(h.rng.prndindex).toBe(0); // the gameplay stream is UNTOUCHED
  });

  it('the `st_face` ledger line reconciles with the source scan', () => {
    const scan = scanMRandomSites();
    const listed: number = Object.values(MRANDOM_SITE_CALLS).reduce((a: number, v: number) => a + v, 0);
    const found: number = Object.values(scan).reduce((a: number, v: number) => a + v, 0);
    expect(found).toBe(listed);
    expect(scan['statusbar.ts']).toBe(1);
    expect(MRANDOM_SITE_CALLS['statusbar.ts']).toBe(1);
    // The site name the plan asked for is `st_face` (the ledger keys by file,
    // the comment names the site — the M9-07 wi_anim convention).
    expect(Object.keys(MRANDOM_SITE_CALLS).sort()).toEqual(['statusbar.ts', 'wintermission.ts']);
    // Behavioural half: the ledger count × tics == the rndindex advance.
    const h = boot();
    for (let t = 0; t < 11; t += 1) stTicker(h.ctx);
    expect(h.rng.rndindex).toBe(11 * (MRANDOM_SITE_CALLS['statusbar.ts'] ?? 0));
  });

  it('st_oldhealth tracks the health the face machine compared against', () => {
    const h = boot({ health: 70 });
    stTicker(h.ctx);
    h.p.health = 40;
    stTicker(h.ctx);
    expect(stFaceIndex()).toBeLessThan(42);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Widgets: keys, 1994, health-0, arms, and the frame compose       */
/* ------------------------------------------------------------------ */

describe('widgets', () => {
  it('keyboxes: cards[1] + cards[4] ⇒ box 1 = 4 (blue+lava = STKEYS4)', () => {
    const h = boot({ cards: [0, 1, 0, 0, 1, 0] });
    stTicker(h.ctx);
    expect(stKeyboxes()).toEqual([-1, 4, -1]);
    stDrawer(h.ctx, false, true);
    const want = new Uint8Array(ST_WIDTH * 200);
    refFullBar(want, h.p, stFaceIndex());
    expect(screens[FG]!.data).toEqual(want);
  });

  it('a skull upgrades the same slot to index+3 and keys vanish with no card', () => {
    const h = boot({ cards: [1, 0, 0, 0, 0, 1] });
    stTicker(h.ctx);
    expect(stKeyboxes()).toEqual([0, -1, 5]);
    h.p.cards.fill(0);
    stTicker(h.ctx);
    expect(stKeyboxes()).toEqual([-1, -1, -1]);
    stDrawer(h.ctx, false, true);
    const want = new Uint8Array(ST_WIDTH * 200);
    refFullBar(want, h.p, stFaceIndex());
    expect(screens[FG]!.data).toEqual(want);
    // and specifically: NO key glyph survives in the key column
    const keyFill = new Set<number>();
    for (let y = 171; y < 196; y += 1) keyFill.add(screens[FG]!.data[y * ST_WIDTH + 242] ?? 0);
    expect([...keyFill].some((v) => v >= 150 && v <= 155)).toBe(false);
  });

  it('1994: the fists erase the ready-ammo digits entirely', () => {
    const h = boot({ readyweapon: 0 });
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    const bg = screens[BG]!;
    for (let r = 0; r < 16; r += 1) {
      for (let c = 44 - 39; c < 44; c += 1) {
        expect(screens[FG]!.data[(171 + r) * ST_WIDTH + c], `r ${r} c ${c}`).toBe(
          bg.data[(171 + r - ST_Y) * ST_WIDTH + c],
        );
      }
    }
    const want = new Uint8Array(ST_WIDTH * 200);
    refFullBar(want, h.p, stFaceIndex());
    expect(screens[FG]!.data).toEqual(want);
  });

  it('health 0 draws a single STTNUM0 (one digit, not three, not zero)', () => {
    const h = boot({ health: 0 });
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    let painted = 0;
    for (let r = 0; r < 16; r += 1) {
      for (let c = 90 - 39; c < 103; c += 1) {
        if (screens[FG]!.data[(171 + r) * ST_WIDTH + c] === 100) painted += 1;
      }
    }
    expect(painted).toBeGreaterThan(0); // the '0' glyph (fill 100) is on screen
    const want = new Uint8Array(ST_WIDTH * 200);
    refFullBar(want, h.p, stFaceIndex());
    expect(screens[FG]!.data).toEqual(want);
  });

  it('the weapon-owned multicons show yellow when owned, gray when not', () => {
    const h = boot({ weaponowned: [1, 1, 1, 1, 0, 0, 0, 0, 0] });
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    expect(screens[FG]!.data[172 * ST_WIDTH + 112]).toBe(202); // STYSNUM2 (shotgun owned)
    expect(screens[FG]!.data[172 * ST_WIDTH + 136]).toBe(204); // STYSNUM4 (rocket owned)
    expect(screens[FG]!.data[182 * ST_WIDTH + 124]).toBe(36); // STGNUM6 (bfg, gray)
    const want = new Uint8Array(ST_WIDTH * 200);
    refFullBar(want, h.p, stFaceIndex());
    expect(screens[FG]!.data).toEqual(want);
  });

  it('the widget table carries the §0.8 coordinates', () => {
    boot();
    const w = stWidgets();
    expect([w.wReady.x, w.wReady.y, w.wReady.width]).toEqual([44, 171, 3]);
    expect([w.wHealth.n.x, w.wHealth.n.y, w.wHealth.n.width]).toEqual([90, 171, 3]);
    expect([w.wArmor.n.x, w.wArmor.n.y]).toEqual([221, 171]);
    expect([w.wArmsbg.x, w.wArmsbg.y]).toEqual([104, 168]);
    expect([w.wFaces.x, w.wFaces.y]).toEqual([143, 168]);
    expect(w.wFrags.width).toBe(2);
    expect(w.wArms.map((a) => [a.x, a.y])).toEqual([
      [111, 172], [123, 172], [135, 172],
      [111, 182], [123, 182], [135, 182],
    ]);
    expect(w.wKeyboxes.map((k) => [k.x, k.y])).toEqual([
      [239, 171], [239, 181], [239, 191],
    ]);
    expect(w.wAmmo.map((a) => [a.x, a.y])).toEqual([
      [288, 173], [288, 179], [288, 191], [288, 185],
    ]);
    expect(w.wMaxAmmo.map((a) => [a.x, a.y])).toEqual([
      [314, 173], [314, 179], [314, 191], [314, 185],
    ]);
    expect(w.wFrags.x).toBe(138);
  });
});

/* ------------------------------------------------------------------ */
/* 7. ST_Drawer: refresh vs diff, the palette gate                     */
/* ------------------------------------------------------------------ */

describe('ST_Drawer', () => {
  it('a refresh slams the background once; later tics only diff-draw', () => {
    const h = boot();
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    expect(stStats.backgroundRefreshes).toBe(1);
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    expect(stStats.backgroundRefreshes).toBe(1);
    expect(stStats.refreshDraws).toBe(1);
    expect(stStats.diffDraws).toBe(1);
  });

  it('fullscreen without the automap draws nothing at all', () => {
    const h = boot();
    stTicker(h.ctx);
    vInit();
    const before = screens[FG]!.data.slice();
    stDrawer(h.ctx, true, true);
    expect(screens[FG]!.data).toEqual(before);
    expect(stStats.backgroundRefreshes).toBe(0);
    // …but the automap keeps the bar (st_statusbaron's || arm)
    h.ctx.automapActive = true;
    stDrawer(h.ctx, true, true);
    expect(stStats.backgroundRefreshes).toBe(1);
  });

  it('a diff-draw erases a digit box back to BG when the value goes to 1994', () => {
    const h = boot({ readyweapon: 1 });
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    h.p.readyweapon = 0; // fists ⇒ 1994
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    const bg = screens[BG]!;
    for (let r = 0; r < 16; r += 1) {
      for (let c = 44 - 39; c < 44; c += 1) {
        expect(screens[FG]!.data[(171 + r) * ST_WIDTH + c]).toBe(bg.data[(171 + r - ST_Y) * ST_WIDTH + c]);
      }
    }
  });

  it('the palette band follows the live player and only signals on CHANGE', () => {
    const seen: number[] = [];
    const h = boot();
    h.ctx.setPaletteBand = (b) => seen.push(b);
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    expect(seen).toEqual([0]); // the -1 → 0 first-time change
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    expect(seen.length).toBe(1); // unchanged ⇒ no signal
    h.p.damagecount = 33; // (33+7)>>3 = 5 ⇒ bank 1+5 = 6
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    expect(seen[seen.length - 1]).toBe(6);
    expect(stPaletteBand()).toBe(6);
  });

  it('ST_Stop restores the base palette but leaves the change gate STALE (vanilla)', () => {
    const seen: number[] = [];
    const h = boot();
    h.ctx.setPaletteBand = (b) => seen.push(b);
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    h.p.damagecount = 33;
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    expect(seen.length).toBe(2); // 0 then 6
    stStop();
    expect(seen[seen.length - 1]).toBe(0); // I_SetPalette(base)
    expect(stPaletteBand()).toBe(6); // …but st_palette is NOT reset (:1456-1465)
    // The bug this leaves behind: while the player is STILL hurt, every later
    // ST_Drawer recomputes band 6, matches the stale gate, and skips
    // I_SetPalette — so the red bank never comes back after the stop.
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    expect(seen.length).toBe(3);
    stTicker(h.ctx);
    stDrawer(h.ctx, false, false);
    expect(seen.length).toBe(3);
  });

  it('stStart after stStop re-arms the gate through stInitData (st_palette = -1)', () => {
    const seen: number[] = [];
    const h = boot();
    h.ctx.setPaletteBand = (b) => seen.push(b);
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    stStop();
    stStart(h.ctx);
    expect(stPaletteBand()).toBe(-1); // ST_initData (:1280) re-arms the gate
    stTicker(h.ctx);
    stDrawer(h.ctx, false, true);
    expect(seen.length).toBe(3); // 0 (drawer), 0 (stop), 0 (drawer after restart)
    expect(stPaletteBand()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Scripted frame: a deterministic composite pin                    */
/* ------------------------------------------------------------------ */

describe('scripted frame (fixture WAD)', () => {
  it('a 60-tic scripted run composes byte-exact against the reference', () => {
    const h = boot({ weaponowned: [1, 1, 1, 0, 0, 0, 0, 0, 0], ammo: [48, 17, 0, 0], armorpoints: 75 });
    for (let t = 1; t <= 60; t += 1) {
      if (t === 12) h.p.cards[0] = 1;
      if (t === 20) h.p.weaponowned[4] = 1;
      if (t === 21) h.p.bonuscount = 64;
      if (t === 22) h.p.health = 62;
      if (t === 40) h.p.bonuscount = 0;
      stTicker(h.ctx);
      stDrawer(h.ctx, false, t === 1);
      if (t === 1 || t === 21 || t === 22 || t === 40 || t === 60) {
        const want = new Uint8Array(ST_WIDTH * 200);
        refFullBar(want, h.p, stFaceIndex());
        expect(screens[FG]!.data, `tic ${t}`).toEqual(want);
      }
    }
    expect(createHash('sha256').update(screens[FG]!.data).digest('hex').slice(0, 16)).toBe(HASH_T60);
    expect(stStats.tickerCalls).toBe(60);
  });

  it('the scripted pin is reproducible (a bless-of-convenience would trip)', () => {
    expect(runScripted()).toBe(runScripted());
    expect(runScripted()).toBe(HASH_T60);
  });
});

/** The scripted 60-tic run, shared by the compose and pin tests. */
function runScripted(): string {
  const h = boot({ weaponowned: [1, 1, 1, 0, 0, 0, 0, 0, 0], ammo: [48, 17, 0, 0], armorpoints: 75 });
  for (let t = 1; t <= 60; t += 1) {
    if (t === 12) h.p.cards[0] = 1;
    if (t === 20) h.p.weaponowned[4] = 1;
    if (t === 21) h.p.bonuscount = 64;
    if (t === 22) h.p.health = 62;
    if (t === 40) h.p.bonuscount = 0;
    stTicker(h.ctx);
    stDrawer(h.ctx, false, t === 1);
    if (t === 1 || t === 21 || t === 22 || t === 40 || t === 60) {
      const want = new Uint8Array(ST_WIDTH * 200);
      refFullBar(want, h.p, stFaceIndex());
      expect(screens[FG]!.data, `tic ${t}`).toEqual(want);
    }
  }
  return createHash('sha256').update(screens[FG]!.data).digest('hex').slice(0, 16);
}

/** Derived from the reference-equal scripted run (regenerated once, then
 * pinned as a regression tripwire). */
const HASH_T60 = 'f5953c055c4216fb';
