// ui/statusbar.ts — the 320x32 STATUS BAR: lump load, the widget table,
// the FACE MACHINE and the tic/display hooks (M9-05; docs/design/M9-plan.md
// §M9-05 + §0.8, mirroring st_stuff.c). Widgets themselves live in
// ui/stlib.ts (st_lib.c). Composition into the presented frame is M9-09's
// (this module exports stDrawer/stTicker/stStart and never touches
// renderer.ts).
//
// Faithfulness map (linuxdoom-1.10 st_stuff.c; verified line-by-line against
// /tmp/DOOM-master/linuxdoom-1.10 this session):
//   consts          :78-250 — every coordinate below is transcribed.
//   ST_refreshBackground :497-514  STBAR(+faceback if netgame)→BG, BG→FG.
//   ST_calcPainOffset    :733-746  ST_FACESTRIDE * ((100-min(h,100))*5/101),
//                                memoised on the clamped health.
//   ST_updateFaceWidget  :752-899  the priority-latched precedence machine
//                                (see stUpdateFaceWidget below for the rule
//                                ledger).
//   ST_updateWidgets     :901-960  ready-ammo pointer (1994 "n/a"), keyboxes,
//                                face update, armson/fragson/fragscount,
//                                the st_msgcounter chat decay.
//   ST_Ticker            :962-971  st_clock++; st_randomnumber = M_Random();
//                                ST_updateWidgets(); st_oldhealth = health.
//   ST_doPaletteStuff    :975-1028 → sim/ppalette.paletteBand (M7-06), same
//                                bank math; the `!= st_palette` change gate.
//   ST_drawWidgets       :1030-1066 update order (ready, ammo/maxammo ×4,
//                                health, armor, armsbg, arms ×6, faces,
//                                keyboxes ×3, frags).
//   ST_Drawer            :1085-1106  st_statusbaron = !fullscreen||automap;
//                                firsttime/refresh ⇒ full redraw else diff.
//   ST_loadGraphics      :1124-1197  the lump census (stLoadGraphics below).
//   ST_initData          :1266-1296  the widget-table statics reset.
//   ST_createWidgets     :1298-1444  the widget table (exact coordinates).
//   ST_Start/Stop/Init   :1446-1471
//
// FACE MACHINE LEDGER (st_stuff.c:752-899) — 10 rules, transcribed with the
// exact `priority` latches (a rule that fires SETS priority; later rules are
// gated on `priority < N`, so a fired higher rule suppresses lower ones until
// the latch is released by the idle timeout at the tail):
//   R1 dead        priority<10 && !health          ⇒ 9, DEADFACE(41), cnt 1   :765-772
//   R2 evil grin   priority<9 && bonuscount && a weaponowned[i] DELTA ⇒ 8,
//                  painOffset+ST_EVILGRINOFFSET(6), cnt 70                     :775-795
//   R3 attacked    priority<8 && damagecount && attacker && attacker!=mo ⇒ 7,
//                  health-oldhealth > 20 ⇒ OUCH(5) cnt 35, else the
//                  R_PointToAngle2 turn branch (:818-836 "confusing, aint it?")
//                  diffang<ANG45 ⇒ RAMPAGE(7) else i⇒RIGHT(3)/LEFT(4), cnt 35
//   R4 self-hurt   priority<7 && damagecount ⇒ 7|6 (OUCH cnt 35 / RAMPAGE cnt 35) :847-864
//   R5 rapid fire  priority<6 && attackdown: first tic arms 70, then each tic
//                  decrements; hitting 0 ⇒ priority 5, RAMPAGE, cnt 1, and the
//                  latch is SET TO 1 (so it re-fires every tic while held)   :867-882
//   R6 god/invul   priority<5 && (CF_GODMODE || powers[pw_invulnerability])
//                  ⇒ 4, GODFACE(40), cnt 1                                    :885-895
//   R7 idle tail   !facecount ⇒ painOffset + st_randomnumber%3, cnt 17,
//                  priority = 0 (the ONLY latch release; also runs in the tic
//                  AFTER a 1-tic face, so R1/R5/R6 re-latch every tic)        :897-903
//   R8 pain offset = 8 * ((100 - min(health,100)) * 5 / 101), memoised        :733-746
//   R9 facecount-- TAIL: unconditional decrement every tic                     :904
//   R10 weaponowned→oldweaponsowned sync happens ONLY inside R2 (and at
//      ST_initData), so a weapon picked up with bonuscount == 0 stays
//      "new" until some later bonus tic fires the grin                          :779-786
//
// FINDINGS (data-vs-brief, reported in the M9-05 report):
//   * st_stuff.c:752's comment ("dead > evil grin > turned head > straight
//     ahead") UNDERSTATES the machine: the code is the 10-rule ladder above,
//     and the rapid-fire rule RE-FIRES every tic once its 70-tic delay lands
//     (`lastattackdown = 1` at :877), which the comment never mentions.
//   * The turn-direction `i` at :818-830 compares `diffang` against ANG180
//     with DIFFERENT operators per branch (`>` vs `<=`), so the left/right
//     choice is `i = (badguy>angle) ? diffang>ANG180 : diffang<=ANG180`;
//     transcribed verbatim rather than "simplified".
//   * freedoom1.wad ships a SUPERSET of the statusbar lumps (STGNUM8/9,
//     STKEYS6-8, STFB1-3 exist); vanilla references 78 lumps in
//     ST_loadGraphics + STTMINUS in STlib_init = 79, and this module
//     references exactly those 79 (the §0.12 audit's "all present" holds).
//     The M9-05 brief's "81 names" count is NOT reachable from the source —
//     78 (+STTMINUS) is the audited number, asserted by census AND against
//     the real IWAD in statusbar.test.ts.
//   * ST_Stop (:1456-1465) calls I_SetPalette(base) but does NOT reset
//     st_palette — the change gate is left stale (harmless only because
//     ST_initData's st_palette = -1 runs on the next ST_Start). Transcribed.
//   * ST_createWidgets seeds w_ready.num with `&plyr->ammo[am_noammo]` — an
//     out-of-bounds read in C for the fists/chainsaw (weaponinfo.ammo == 5).
//     Modelled as the 1994 sentinel: ST_updateWidgets re-points the widget
//     BEFORE any draw, so no frame can tell the difference.
//   * `priority` and `lastattackdown` are FUNCTION-statics (:759-760) and
//     ST_initData does not reset them, so a latch can survive a level change
//     mid-game; only the R7 idle tail clears them. stResetAll (process start)
//     is the only place this module clears them.
//
// Seam shape (plan §M9-05 "face lookup from the LIVE player, no sim state
// import"): the live player arrives through {@link StContext.player} — a
// structural read view (the render/automap.ts idiom) satisfied by
// sim/player.Player + the attached p_pspr/inventory fields, so THIS file
// imports no sim state singleton and mutates nothing. The two sanctioned
// sim edges are `prng.mRandom` (a LEDGER-VISIBLE draw site — plan §M9-05
// requires the call site to live in a module the random-sites scan can see
// and reconcile) and `ppalette.paletteBand` (plan §M9-05: "hooked to the
// existing palette-band module"), both pure functions over passed-in state.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG180, ANG45, TICRATE } from '../core/constants';
import { lumpPatch, BG, FG, ST_HEIGHT, ST_WIDTH, screens, vCopyRect, vDrawPatch, type VPatch } from '../render/vvideo';
import { mRandom, type PrngState } from '../sim/prng';
import { paletteBand } from '../sim/ppalette';
import { AMMO, NUMWEAPONS, weaponinfo } from '../wad/info/weaponinfo';
import type { WadFile } from '../wad/wadfile';
import {
  ST_Y,
  stLibInit,
  stLibInitBinIcon,
  stLibInitMultIcon,
  stLibInitNum,
  stLibInitPercent,
  stLibUpdateBinIcon,
  stLibUpdateMultIcon,
  stLibUpdateNum,
  stLibUpdatePercent,
  stBinIcon,
  stMultIcon,
  stNumber,
  stPercent,
  type StBinIcon,
  type StMultIcon,
  type StNumber,
  type StPercent,
} from './stlib';

/* ------------------------------------------------------------------ */
/* Constants (st_stuff.c:96-215, st_stuff.h:32-34)                      */
/* ------------------------------------------------------------------ */

/** ST_X (st_stuff.c:96) — the bar's left edge inside BG. */
export const ST_X = 0;
/** ST_X2 (st_stuff.c:97) — the arms-background column. */
export const ST_X2 = 104;
/** ST_FX (st_stuff.c:98) — the netgame face-background column. */
export const ST_FX = 143;
/** ST_FY (st_stuff.c:99) — unused in 1.10 (the widget uses ST_FACESX/Y). */
export const ST_FY = 169;

/** ST_NUMPAINFACES (st_stuff.c:101). */
export const ST_NUMPAINFACES = 5;
/** ST_NUMSTRAIGHTFACES (:102). */
export const ST_NUMSTRAIGHTFACES = 3;
/** ST_NUMTURNFACES (:103). */
export const ST_NUMTURNFACES = 2;
/** ST_NUMSPECIALFACES (:104) — ouch + evil grin + rampage. */
export const ST_NUMSPECIALFACES = 3;
/** ST_FACESTRIDE = 3+2+3 = 8 (:105-106). */
export const ST_FACESTRIDE = ST_NUMSTRAIGHTFACES + ST_NUMTURNFACES + ST_NUMSPECIALFACES;
/** ST_NUMEXTRAFACES (:108) — god + dead. */
export const ST_NUMEXTRAFACES = 2;
/** ST_NUMFACES = 8*5+2 = 42 (:109-110). */
export const ST_NUMFACES = ST_FACESTRIDE * ST_NUMPAINFACES + ST_NUMEXTRAFACES;

/** ST_TURNOFFSET (:112): within a stride, index 3 is "look right". */
export const ST_TURNOFFSET = ST_NUMSTRAIGHTFACES;
/** ST_OUCHOFFSET (:113) = 5. */
export const ST_OUCHOFFSET = ST_TURNOFFSET + ST_NUMTURNFACES;
/** ST_EVILGRINOFFSET (:114) = 6. */
export const ST_EVILGRINOFFSET = ST_OUCHOFFSET + 1;
/** ST_RAMPAGEOFFSET (:115) = 7. */
export const ST_RAMPAGEOFFSET = ST_EVILGRINOFFSET + 1;
/** ST_GODFACE (:116) = 40. */
export const ST_GODFACE = ST_NUMPAINFACES * ST_FACESTRIDE;
/** ST_DEADFACE (:117) = 41. */
export const ST_DEADFACE = ST_GODFACE + 1;

/** ST_FACESX/Y (:119-120) — the face widget's anchor. */
export const ST_FACESX = 143;
export const ST_FACESY = 168;

/** ST_EVILGRINCOUNT = 2*TICRATE = 70 (:122). */
export const ST_EVILGRINCOUNT = 2 * TICRATE;
/** ST_STRAIGHTFACECOUNT = TICRATE/2 = 17 (:123) — the idle redraw period. */
export const ST_STRAIGHTFACECOUNT = Math.floor(TICRATE / 2);
/** ST_TURNCOUNT = 35 (:124). */
export const ST_TURNCOUNT = 1 * TICRATE;
/** ST_OUCHCOUNT (:125) — declared, never referenced (turn/ouch share 35). */
export const ST_OUCHCOUNT = 1 * TICRATE;
/** ST_RAMPAGEDELAY = 70 (:126). */
export const ST_RAMPAGEDELAY = 2 * TICRATE;
/** ST_MUCHPAIN (:128). */
export const ST_MUCHPAIN = 20;

/* Widget geometry (st_stuff.c:136-215) — transcribed, §0.8. */
export const ST_AMMOWIDTH = 3;
export const ST_AMMOX = 44;
export const ST_AMMOY = 171;
export const ST_HEALTHWIDTH = 3;
export const ST_HEALTHX = 90;
export const ST_HEALTHY = 171;
export const ST_ARMSX = 111;
export const ST_ARMSY = 172;
export const ST_ARMSBGX = 104;
export const ST_ARMSBGY = 168;
export const ST_ARMSXSPACE = 12;
export const ST_ARMSYSPACE = 10;
export const ST_FRAGSX = 138;
export const ST_FRAGSY = 171;
export const ST_FRAGSWIDTH = 2;
export const ST_ARMORWIDTH = 3;
export const ST_ARMORX = 221;
export const ST_ARMORY = 171;
export const ST_KEY0WIDTH = 8;
export const ST_KEY0HEIGHT = 5;
export const ST_KEY0X = 239;
export const ST_KEY0Y = 171;
export const ST_KEY1X = 239;
export const ST_KEY1Y = 181;
export const ST_KEY2X = 239;
export const ST_KEY2Y = 191;
export const ST_AMMO0WIDTH = 3;
export const ST_AMMO0HEIGHT = 6;
export const ST_AMMO0X = 288;
export const ST_AMMO0Y = 173;
export const ST_AMMO1Y = 179;
export const ST_AMMO2Y = 191;
export const ST_AMMO3Y = 185;
export const ST_MAXAMMO0WIDTH = 3;
export const ST_MAXAMMO0HEIGHT = 5;
export const ST_MAXAMMO0X = 314;
export const ST_MAXAMMO0Y = 173;
export const ST_MAXAMMO1Y = 179;
export const ST_MAXAMMO2Y = 191;
export const ST_MAXAMMO3Y = 185;

/** d_player.h MAXPLAYERS (p_mobj.ts is the authority; local copy so this UI
 * module holds no sim edge beyond prng/ppalette). */
export const MAXPLAYERS = 4;
/** d_player.h CF_GODMODE. */
export const CF_GODMODE = 2;
/** doomdef.h powertype_t pw_invulnerability (p_inter_pickup.PW agrees). */
export const PW_INVULNERABILITY = 0;
/** doomdef.h NUMCARDS (blue/yellow/red card + skull). */
export const NUMCARDS = 6;
/** st_stuff.c:901 `static int largeammo = 1994` — the "n/a" sentinel the
 * STlib number widgets skip (:120). */
export const ST_LARGE_AMMO = 1994;

/* ------------------------------------------------------------------ */
/* Live-player read view + context (see the header's "Seam shape")      */
/* ------------------------------------------------------------------ */

/** mobj_t read slice for the face machine's attacker geometry (fixed x/y,
 * u32 BAM angle). sim/player.MobjStub and pmove.MoveMobj both satisfy it. */
export interface StMobjView {
  readonly x: number;
  readonly y: number;
  readonly angle: number;
}

/** The d_player.h player_t fields st_stuff.c reads. Every field is live —
 * the widgets hold closures over THIS object, which must be the same
 * instance the sim mutates (the C `plyr = &players[consoleplayer]`). */
export interface StPlayerView {
  readonly health: number;
  readonly bonuscount: number;
  readonly damagecount: number;
  readonly readyweapon: number;
  readonly attackdown: boolean;
  readonly cheats: number;
  readonly powers: ArrayLike<number>;
  readonly ammo: ArrayLike<number>;
  readonly maxammo: ArrayLike<number>;
  readonly weaponowned: ArrayLike<number>;
  readonly cards: ArrayLike<number>;
  readonly armorpoints: number;
  readonly frags: ArrayLike<number>;
  readonly mo: StMobjView;
  /** `player_t *attacker` — the identity compare against `mo` is the C
   * `plyr->attacker != plyr->mo` pointer test, so pass the LIVE mobj. */
  readonly attacker: StMobjView | null;
}

/** R_PointToAngle2 (r_main.c:314-372) — the angle seam. The wave-3 consumer
 * wires `sim/p_shoot.rPointToAngle2` (the ui zone holds no sim edge for the
 * heavy p_shoot module graph; the tests use the real function). */
export type PointToAngle2 = (x1: number, y1: number, x2: number, y2: number) => number;

/** The per-frame context (vanilla's implicit globals). */
export interface StContext {
  /** PRNG state for the M_Random face draw (sim's state.rng). */
  readonly rng: PrngState;
  /** The LIVE consoleplayer object. */
  readonly player: StPlayerView;
  /** `automapactive` (am_map.c) — §0.8: the bar stays on over the automap. */
  automapActive?: boolean;
  /** `netgame` (this port: false, §0.4) — gates the face background. */
  netgame?: boolean;
  /** `deathmatch` (this port: false) — gates armson/fragson. */
  deathmatch?: boolean;
  /** `consoleplayer` (single-player 0) — picks the STFB<n> background. */
  consoleplayer?: number;
  /** R_PointToAngle2 seam (see {@link PointToAngle2}). */
  pointToAngle2?: PointToAngle2;
  /** I_SetPalette consumer: receives the PLAYPAL bank index on CHANGE only
   * (the `palette != st_palette` gate, st_stuff.c:1043-1047). */
  setPaletteBand?: (band: number) => void;
}

/* ------------------------------------------------------------------ */
/* Lump load (ST_loadGraphics, st_stuff.c:1124-1197)                    */
/* ------------------------------------------------------------------ */

/** The 42 face lumps, generated with the SAME name shapes ST_loadGraphics
 * sprintf builds (:1178-1195): per pain tier 0..4 — STFST<p>0/1/2, STFTR<p>0,
 * STFTL<p>0, STFOUCH<p>, STFEVL<p>, STFKILL<p> — then STFGOD0, STFDEAD0.
 * Index within a stride = ST_TURNOFFSET..ST_RAMPAGEOFFSET, matching the face
 * machine's offsets; a 9-char "STTFSTT00"-style name never appears (§0.12). */
export function stFaceLumpNames(): string[] {
  const out: string[] = [];
  for (let i = 0; i < ST_NUMPAINFACES; i += 1) {
    for (let j = 0; j < ST_NUMSTRAIGHTFACES; j += 1) out.push(`STFST${i}${j}`);
    out.push(`STFTR${i}0`);
    out.push(`STFTL${i}0`);
    out.push(`STFOUCH${i}`);
    out.push(`STFEVL${i}`);
    out.push(`STFKILL${i}`);
  }
  out.push('STFGOD0');
  out.push('STFDEAD0');
  return out;
}

/** Every lump name stLoadGraphics references, in load order (78 entries:
 * 10 tall + 10 short + STTPRCNT + 6 keys + STARMS + 6 STGNUM + 1 faceback +
 * STBAR + 42 faces). STTMINUS is STlib_init's (:1266-1280 → st_lib.c:49). */
export function stLumpNames(consoleplayer = 0): string[] {
  const out: string[] = [];
  for (let i = 0; i < 10; i += 1) out.push(`STTNUM${i}`); // tallnum
  for (let i = 0; i < 10; i += 1) out.push(`STYSNUM${i}`); // shortnum
  out.push('STTPRCNT');
  for (let i = 0; i < NUMCARDS; i += 1) out.push(`STKEYS${i}`);
  out.push('STARMS');
  for (let i = 0; i < 6; i += 1) out.push(`STGNUM${i + 2}`); // gray weapon nums
  out.push(`STFB${consoleplayer}`); // faceback (consoleplayer-coloured)
  out.push('STBAR');
  out.push(...stFaceLumpNames());
  return out;
}

/** The loaded graphics set (st_stuff.c's file-scope patch pointers). */
export interface StGraphics {
  tallnum: VPatch[];
  shortnum: VPatch[];
  tallpercent: VPatch;
  keys: VPatch[];
  faces: VPatch[];
  faceback: VPatch;
  armsbg: VPatch;
  arms: [VPatch, VPatch][];
  sbar: VPatch;
}

let graphics: StGraphics | null = null;

/** ST_loadGraphics (st_stuff.c:1124-1197): cache every statusbar lump by
 * name (vvideo.lumpPatch is the W_CacheLumpName equivalent). The census
 * (stLumpNames) is asserted against the IWAD by statusbar.test.ts. */
export function stLoadGraphics(wad: WadFile, consoleplayer = 0): StGraphics {
  const tallnum: VPatch[] = [];
  const shortnum: VPatch[] = [];
  for (let i = 0; i < 10; i += 1) {
    tallnum.push(lumpPatch(wad, `STTNUM${i}`));
    shortnum.push(lumpPatch(wad, `STYSNUM${i}`));
  }
  const tallpercent = lumpPatch(wad, 'STTPRCNT');

  const keys: VPatch[] = [];
  for (let i = 0; i < NUMCARDS; i += 1) keys.push(lumpPatch(wad, `STKEYS${i}`));

  const armsbg = lumpPatch(wad, 'STARMS');

  const arms: [VPatch, VPatch][] = [];
  for (let i = 0; i < 6; i += 1) {
    arms.push([lumpPatch(wad, `STGNUM${i + 2}`), shortnum[i + 2]!]); // yellow = short num
  }

  const faceback = lumpPatch(wad, `STFB${consoleplayer}`);
  const sbar = lumpPatch(wad, 'STBAR');

  const faces: VPatch[] = [];
  for (const name of stFaceLumpNames()) faces.push(lumpPatch(wad, name));

  graphics = { tallnum, shortnum, tallpercent, keys, faces, faceback, armsbg, arms, sbar };
  return graphics;
}

/** The loaded set (null before stInit/stLoadGraphics). */
export function stGraphics(): StGraphics | null {
  return graphics;
}

/* ------------------------------------------------------------------ */
/* File-scope state (st_stuff.c:268-390 — the widget-table statics)      */
/* ------------------------------------------------------------------ */

/** st_firsttime (st_stuff.c:270). */
let stFirsttime = true;
/** st_clock (:276). */
let stClock = 0;
/** st_msgcounter (:279) — chat-window decay (chat is deferred; the decay is
 * transcribed so the counter stays honest if the HU layer ever feeds it). */
let stMsgCounter = 0;
/** st_chat / st_oldchat (:285/:288) — inert without the chat layer. */
let stChat = false;
let stOldChat = false;
/** st_statusbaron (:294). */
let stStatusbaron = true;
/** st_notdeathmatch (:306). */
let stNotdeathmatch = true;
/** st_armson (:309). */
let stArmson = true;
/** st_fragson (:312). */
let stFragson = false;
/** st_fragscount (:333). */
let stFragscount = 0;
/** st_oldhealth (:336) — the face machine's damage delta basis. */
let stOldhealth = -1;
/** oldweaponsowned[] (:339) — evil-grin delta basis (R10: synced ONLY in R2
 * and stInitData). */
let oldWeaponsOwned = new Int32Array(NUMWEAPONS);
/** st_facecount (:342). */
let stFacecount = 0;
/** st_faceindex (:345) — the value w_faces reads. */
let stFaceindex = 0;
/** keyboxes[] (:348) — the value w_keyboxes[0..2] read. */
const keyboxes = new Int32Array(3).fill(-1);
/** st_randomnumber (:351) — one M_Random draw per tic. */
let stRandomnumber = 0;
/** st_palette (:1030) — the I_SetPalette change gate. */
let stPalette = 0;
/** ST_calcPainOffset's memo pair (:735-736). NOT reset by ST_initData in
 * vanilla either (a `static`), which is behaviourally invisible (the memo
 * value is a pure function of health). */
let painLastcalc = 0;
let painOldhealth = -1;
/** st_stuff.c:873 `static int lastattackdown = -1` — NOT reset by ST_Start. */
let lastAttackDown = -1;
/** st_stuff.c:874 `static int priority = 0` — NOT reset by ST_Start: the
 * latch survives a level restart (faithful; the idle tail releases it). */
let facePriority = 0;
/** st_stopped (:1446). */
let stStopped = true;

/** The bound context (vanilla's implicit `plyr` + global flags). */
let ctx: StContext | null = null;

/** Widget table (st_stuff.c:315-330). */
const wReady: StNumber = stNumber();
const wFrags: StNumber = stNumber();
const wHealth: StPercent = stPercent();
const wArmor: StPercent = stPercent();
const wArmsbg: StBinIcon = stBinIcon();
const wArms: StMultIcon[] = [stMultIcon(), stMultIcon(), stMultIcon(), stMultIcon(), stMultIcon(), stMultIcon()];
const wFaces: StMultIcon = stMultIcon();
const wKeyboxes: StMultIcon[] = [stMultIcon(), stMultIcon(), stMultIcon()];
const wAmmo: StNumber[] = [stNumber(), stNumber(), stNumber(), stNumber()];
const wMaxAmmo: StNumber[] = [stNumber(), stNumber(), stNumber(), stNumber()];

/** Counters — the observable evidence channel (vanilla had none). */
export const stStats = {
  /** ST_Ticker calls (= M_Random draws; the `st_face` ledger reconciliation). */
  tickerCalls: 0,
  /** ST_Drawer full-refresh path taken (st_firsttime/refresh). */
  refreshDraws: 0,
  /** ST_Drawer incremental path taken. */
  diffDraws: 0,
  /** ST_refreshBackground BG→FG slams. */
  backgroundRefreshes: 0,
  /** I_SetPalette-equivalent band changes. */
  paletteChanges: 0,
  /** Face-machine rule hits, keyed R1..R7 (test/telemetry only). */
  faceRules: { R1dead: 0, R2grin: 0, R3attacked: 0, R4selfhurt: 0, R5rapid: 0, R6god: 0, R7idle: 0 },
};

export function stResetStats(): void {
  stStats.tickerCalls = 0;
  stStats.refreshDraws = 0;
  stStats.diffDraws = 0;
  stStats.backgroundRefreshes = 0;
  stStats.paletteChanges = 0;
  for (const k of Object.keys(stStats.faceRules) as (keyof typeof stStats.faceRules)[]) {
    stStats.faceRules[k] = 0;
  }
}

/* ------------------------------------------------------------------ */
/* Accessors (test seams + the M9-09 display layer)                     */
/* ------------------------------------------------------------------ */

/** st_faceindex — the face the w_faces widget shows. */
export function stFaceIndex(): number {
  return stFaceindex;
}
/** st_facecount (pre-decrement view). */
export function stFaceCount(): number {
  return stFacecount;
}
/** The machine's `priority` latch. */
export function stFacePriority(): number {
  return facePriority;
}
/** st_randomnumber — this tic's M_Random value. */
export function stRandomNumber(): number {
  return stRandomnumber;
}
/** st_clock. */
export function stClockValue(): number {
  return stClock;
}
/** keyboxes[0..2] (a copy). */
export function stKeyboxes(): number[] {
  return [keyboxes[0]!, keyboxes[1]!, keyboxes[2]!];
}
/** st_statusbaron. */
export function stStatusbarOn(): boolean {
  return stStatusbaron;
}
/** st_chat — the chat-window flag the st_msgcounter decay restores. The chat
 * layer itself is deferred (§M9-05 "cheat/chat layer deferred"), so this is
 * the only readback; it stays false for the whole of M9. */
export function stChatOn(): boolean {
  return stChat;
}
/** st_fragscount. */
export function stFrags(): number {
  return stFragscount;
}
/** The PLAYPAL bank the last ST_doPaletteStuff selected. */
export function stPaletteBand(): number {
  return stPalette;
}
/** The widget table (read-only view for the coordinate census test). */
export function stWidgets() {
  return { wReady, wFrags, wHealth, wArmor, wArmsbg, wArms, wFaces, wKeyboxes, wAmmo, wMaxAmmo };
}

/* ------------------------------------------------------------------ */
/* Pain offset (ST_calcPainOffset, st_stuff.c:733-746)                  */
/* ------------------------------------------------------------------ */

export interface StPlayerHolder {
  readonly player: StPlayerView;
}

/** ST_calcPainOffset: `ST_FACESTRIDE * (((100 - health) * ST_NUMPAINFACES) / 101)`
 * with health clamped to ≤100 and the C `static` memo. Tiers: 100..80 → 0,
 * 79..60 → 8, 59..40 → 16, 39..20 → 24, 19..0 → 32. */
export function stCalcPainOffset(p: StPlayerView): number {
  const health = p.health > 100 ? 100 : p.health;

  if (health !== painOldhealth) {
    painLastcalc = ST_FACESTRIDE * Math.floor(((100 - health) * ST_NUMPAINFACES) / 101);
    painOldhealth = health;
  }
  return painLastcalc;
}

/* ------------------------------------------------------------------ */
/* The face machine (ST_updateFaceWidget, st_stuff.c:752-905)           */
/* ------------------------------------------------------------------ */

/**
 * ST_updateFaceWidget — the 10-rule ladder documented in the header.
 * `c.player` is the LIVE player; `c.pointToAngle2` is the R_PointToAngle2
 * seam (R3's turn branch). `st_randomnumber` (one M_Random draw per tic, set
 * by {@link stTicker}) drives the idle tail.
 */
export function stUpdateFaceWidget(c: StContext): void {
  const plyr = c.player;
  let i: number;
  let badguyangle = 0;
  let diffang = 0;
  let doevilgrin: boolean;

  if (facePriority < 10) {
    // dead
    if (!plyr.health) {
      facePriority = 9;
      stFaceindex = ST_DEADFACE;
      stFacecount = 1;
      stStats.faceRules.R1dead += 1;
    }
  }

  if (facePriority < 9) {
    if (plyr.bonuscount) {
      // picking up bonus
      doevilgrin = false;

      for (i = 0; i < NUMWEAPONS; i += 1) {
        const owned = plyr.weaponowned[i] ?? 0;
        if (oldWeaponsOwned[i] !== owned) {
          doevilgrin = true;
          oldWeaponsOwned[i] = owned;
        }
      }
      if (doevilgrin) {
        // evil grin if just picked up weapon
        facePriority = 8;
        stFacecount = ST_EVILGRINCOUNT;
        stFaceindex = stCalcPainOffset(plyr) + ST_EVILGRINOFFSET;
        stStats.faceRules.R2grin += 1;
      }
    }
  }

  if (facePriority < 8) {
    if (plyr.damagecount && plyr.attacker && plyr.attacker !== plyr.mo) {
      // being attacked
      facePriority = 7;
      stStats.faceRules.R3attacked += 1;

      if (plyr.health - stOldhealth > ST_MUCHPAIN) {
        stFacecount = ST_TURNCOUNT;
        stFaceindex = stCalcPainOffset(plyr) + ST_OUCHOFFSET;
      } else {
        if (c.pointToAngle2 === undefined) {
          throw new Error('ST_updateFaceWidget: context.pointToAngle2 (R_PointToAngle2) is not wired');
        }
        badguyangle = c.pointToAngle2(plyr.mo.x, plyr.mo.y, plyr.attacker.x, plyr.attacker.y);

        if (badguyangle > plyr.mo.angle) {
          // whether right or left
          diffang = (badguyangle - plyr.mo.angle) >>> 0;
          i = diffang > ANG180 ? 1 : 0;
        } else {
          // whether left or right
          diffang = (plyr.mo.angle - badguyangle) >>> 0;
          i = diffang <= ANG180 ? 1 : 0;
        } // confusing, aint it?

        stFacecount = ST_TURNCOUNT;
        stFaceindex = stCalcPainOffset(plyr);

        if (diffang < ANG45) {
          // head-on
          stFaceindex += ST_RAMPAGEOFFSET;
        } else if (i) {
          // turn face right
          stFaceindex += ST_TURNOFFSET;
        } else {
          // turn face left
          stFaceindex += ST_TURNOFFSET + 1;
        }
      }
    }
  }

  if (facePriority < 7) {
    // getting hurt because of your own damn stupidity
    if (plyr.damagecount) {
      stStats.faceRules.R4selfhurt += 1;
      if (plyr.health - stOldhealth > ST_MUCHPAIN) {
        facePriority = 7;
        stFacecount = ST_TURNCOUNT;
        stFaceindex = stCalcPainOffset(plyr) + ST_OUCHOFFSET;
      } else {
        facePriority = 6;
        stFacecount = ST_TURNCOUNT;
        stFaceindex = stCalcPainOffset(plyr) + ST_RAMPAGEOFFSET;
      }
    }
  }

  if (facePriority < 6) {
    // rapid firing
    if (plyr.attackdown) {
      if (lastAttackDown === -1) lastAttackDown = ST_RAMPAGEDELAY;
      else if (!--lastAttackDown) {
        facePriority = 5;
        stFaceindex = stCalcPainOffset(plyr) + ST_RAMPAGEOFFSET;
        stFacecount = 1;
        lastAttackDown = 1; // :877 — re-fires EVERY tic from here on
        stStats.faceRules.R5rapid += 1;
      }
    } else lastAttackDown = -1;
  }

  if (facePriority < 5) {
    // invulnerability
    if ((plyr.cheats & CF_GODMODE) || plyr.powers[PW_INVULNERABILITY]) {
      facePriority = 4;

      stFaceindex = ST_GODFACE;
      stFacecount = 1;
      stStats.faceRules.R6god += 1;
    }
  }

  // look left or look right if the facecount has timed out
  if (!stFacecount) {
    stFaceindex = stCalcPainOffset(plyr) + (stRandomnumber % ST_NUMSTRAIGHTFACES);
    stFacecount = ST_STRAIGHTFACECOUNT;
    facePriority = 0;
    stStats.faceRules.R7idle += 1;
  }

  stFacecount -= 1;
}

/* ------------------------------------------------------------------ */
/* Widget table refresh (ST_updateWidgets, st_stuff.c:901-960)          */
/* ------------------------------------------------------------------ */

/** The `static int largeammo = 1994` pointer target (st_stuff.c:901). */
const largeAmmo = (): number => ST_LARGE_AMMO;

/** ST_updateWidgets (st_stuff.c:901-960). */
export function stUpdateWidgets(c: StContext): void {
  const plyr = c.player;

  // must redirect the pointer if the ready weapon has changed.
  const ammoType = weaponinfo[plyr.readyweapon]!.ammo;
  if (ammoType === AMMO.am_noammo) wReady.num = largeAmmo;
  else wReady.num = (): number => plyr.ammo[ammoType] ?? 0;

  wReady.data = plyr.readyweapon;

  // update keycard multiple widgets
  for (let i = 0; i < 3; i += 1) {
    keyboxes[i] = plyr.cards[i] ? i : -1;

    if (plyr.cards[i + 3]) keyboxes[i] = i + 3;
  }

  // refresh everything if this is him coming back to life
  stUpdateFaceWidget(c);

  // used by the w_armsbg widget
  stNotdeathmatch = !(c.deathmatch ?? false);

  // used by w_arms[] widgets
  stArmson = stStatusbaron && !(c.deathmatch ?? false);

  // used by w_frags widget
  stFragson = (c.deathmatch ?? false) && stStatusbaron;
  stFragscount = 0;

  for (let i = 0; i < MAXPLAYERS; i += 1) {
    if (i !== (c.consoleplayer ?? 0)) stFragscount += plyr.frags[i] ?? 0;
    else stFragscount -= plyr.frags[i] ?? 0;
  }

  // get rid of chat window if up because of message
  stMsgCounter -= 1;
  if (!stMsgCounter) stChat = stOldChat;
}

/* ------------------------------------------------------------------ */
/* ST_Ticker (st_stuff.c:962-971)                                       */
/* ------------------------------------------------------------------ */

/**
 * ST_Ticker — the 4-step tic sequence: clock++, the M_Random face draw,
 * ST_updateWidgets(), st_oldhealth = health.
 *
 * LEDGER LINE `st_face` (plan §M9-05 / §0.8): exactly ONE mRandom() draw per
 * call, unconditional, every GS_LEVEL tic — the new permanent
 * MENU-stream ledger line `statusbar.ts` / site `st_face`
 * (src/sim/random-sites.ts, MRANDOM_SITE_CALLS — the same ledger M9-07 opened
 * for wi_anim; the stream is SHARED, plan §0.9).
 */
export function stTicker(c: StContext): void {
  stClock += 1; // st_stuff.c:964
  stRandomnumber = mRandom(c.rng); // :965 — THE st_face draw
  stStats.tickerCalls += 1;
  stUpdateWidgets(c); // :966
  stOldhealth = c.player.health; // :967
}

/* ------------------------------------------------------------------ */
/* ST_doPaletteStuff (st_stuff.c:973-1028)                              */
/* ------------------------------------------------------------------ */

/** The bank math is sim/ppalette.paletteBand (M7-06 — the same STARTREDPALS
 * 1..8 / STARTBONUSPALS 9..12 / RADIATIONPAL 13 gates, damage > bonus >
 * radiation precedence and the berserk `bzc` lift); this function is vanilla's
 * change gate + the I_SetPalette call. */
export function stDoPaletteStuff(c: StContext): void {
  const palette = paletteBand(c.player);

  if (palette !== stPalette) {
    stPalette = palette;
    stStats.paletteChanges += 1;
    c.setPaletteBand?.(stPalette);
  }
}

/* ------------------------------------------------------------------ */
/* Drawing (st_stuff.c:497-514, 1030-1106)                              */
/* ------------------------------------------------------------------ */

/** ST_refreshBackground (:497-514): STBAR (+ faceback when netgame) into the
 * BG canvas, then slam BG→FG. screens[4] is the canvas (M9-01's ST_Init). */
export function stRefreshBackground(c: StContext): void {
  const g = graphics;
  if (g === null) throw new Error('ST_refreshBackground: stLoadGraphics has not run');
  if (stStatusbaron) {
    vDrawPatch(ST_X, 0, BG, g.sbar);

    if (c.netgame ?? false) vDrawPatch(ST_FX, 0, BG, g.faceback);

    vCopyRect(ST_X, 0, BG, ST_WIDTH, ST_HEIGHT, ST_X, ST_Y, FG);
    stStats.backgroundRefreshes += 1;
  }
}

/** ST_drawWidgets (:1030-1066) — the update order is transcribed. */
export function stDrawWidgets(refresh: boolean): void {
  const g = graphics;
  if (g === null) throw new Error('ST_drawWidgets: stLoadGraphics has not run');

  // used by w_arms[] widgets
  stArmson = stStatusbaron && stNotdeathmatch;
  // used by w_frags widget
  stFragson = !stNotdeathmatch && stStatusbaron;

  stLibUpdateNum(wReady, refresh);

  for (let i = 0; i < 4; i += 1) {
    stLibUpdateNum(wAmmo[i]!, refresh);
    stLibUpdateNum(wMaxAmmo[i]!, refresh);
  }

  stLibUpdatePercent(wHealth, refresh);
  stLibUpdatePercent(wArmor, refresh);

  stLibUpdateBinIcon(wArmsbg, refresh);

  for (let i = 0; i < 6; i += 1) stLibUpdateMultIcon(wArms[i]!, refresh);

  stLibUpdateMultIcon(wFaces, refresh);

  for (let i = 0; i < 3; i += 1) stLibUpdateMultIcon(wKeyboxes[i]!, refresh);

  stLibUpdateNum(wFrags, refresh);
}

/** ST_doRefresh (:1068-1078). */
export function stDoRefresh(c: StContext): void {
  stFirsttime = false;

  stRefreshBackground(c);
  stDrawWidgets(true);
  stStats.refreshDraws += 1;
}

/** ST_diffDraw (:1080-1085). */
export function stDiffDraw(): void {
  stDrawWidgets(false);
  stStats.diffDraws += 1;
}

/**
 * ST_Drawer (st_stuff.c:1085-1106). `fullscreen` ⇔ viewheight==200 from
 * D_Display (M9-09 passes it); `refresh` forces a full redraw (level start,
 * automap exit, wipe).
 */
export function stDrawer(c: StContext, fullscreen: boolean, refresh: boolean): void {
  stStatusbaron = !fullscreen || (c.automapActive ?? false);
  stFirsttime = stFirsttime || refresh;

  stDoPaletteStuff(c);

  if (stFirsttime) stDoRefresh(c);
  else stDiffDraw();
}

/* ------------------------------------------------------------------ */
/* ST_initData / ST_createWidgets / ST_Start / ST_Stop / ST_Init         */
/* ------------------------------------------------------------------ */

/** ST_initData (st_stuff.c:1266-1296). */
export function stInitData(c: StContext): void {
  stFirsttime = true;

  stClock = 0;
  stMsgCounter = 0;
  stChat = false;
  stOldChat = false;

  stStatusbaron = true;

  stFaceindex = 0;
  stPalette = -1;

  stOldhealth = -1;

  for (let i = 0; i < NUMWEAPONS; i += 1) oldWeaponsOwned[i] = c.player.weaponowned[i] ?? 0;

  for (let i = 0; i < 3; i += 1) keyboxes[i] = -1;

  if (stLibMinusWad === null) throw new Error('ST_initData: no WAD for STlib_init (STTMINUS)');
  stLibInit(stLibMinusWad);
}

/** The WAD handle STlib_init needs for STTMINUS (ST_Init's, st_stuff.c:1467). */
let stLibMinusWad: WadFile | null = null;

/** ST_createWidgets (st_stuff.c:1298-1444) — the widget table, coordinates
 * transcribed from st_stuff.c:136-215 (the §0.8 layout). */
export function stCreateWidgets(c: StContext): void {
  const g = graphics;
  if (g === null) throw new Error('ST_createWidgets: stLoadGraphics has not run');
  const plyr = c.player;
  const on = (): boolean => stStatusbaron;

  // ready weapon ammo
  stLibInitNum(
    wReady,
    ST_AMMOX,
    ST_AMMOY,
    g.tallnum,
    (): number => {
      const t = weaponinfo[plyr.readyweapon]!.ammo;
      return t === AMMO.am_noammo ? ST_LARGE_AMMO : (plyr.ammo[t] ?? 0);
    },
    on,
    ST_AMMOWIDTH,
  );

  // the last weapon type
  wReady.data = plyr.readyweapon;

  // health percentage
  stLibInitPercent(wHealth, ST_HEALTHX, ST_HEALTHY, g.tallnum, (): number => plyr.health, on, g.tallpercent);

  // arms background
  stLibInitBinIcon(
    wArmsbg,
    ST_ARMSBGX,
    ST_ARMSBGY,
    g.armsbg,
    () => stNotdeathmatch,
    on,
  );

  // weapons owned
  for (let i = 0; i < 6; i += 1) {
    stLibInitMultIcon(
      wArms[i]!,
      ST_ARMSX + (i % 3) * ST_ARMSXSPACE,
      ST_ARMSY + Math.floor(i / 3) * ST_ARMSYSPACE,
      g.arms[i]!,
      (): number => plyr.weaponowned[i + 1] ?? 0,
      () => stArmson,
    );
  }

  // frags sum
  stLibInitNum(wFrags, ST_FRAGSX, ST_FRAGSY, g.tallnum, () => stFragscount, () => stFragson, ST_FRAGSWIDTH);

  // faces
  stLibInitMultIcon(wFaces, ST_FACESX, ST_FACESY, g.faces, () => stFaceindex, on);

  // armor percentage
  stLibInitPercent(wArmor, ST_ARMORX, ST_ARMORY, g.tallnum, (): number => plyr.armorpoints, on, g.tallpercent);

  // keyboxes 0-2
  stLibInitMultIcon(wKeyboxes[0]!, ST_KEY0X, ST_KEY0Y, g.keys, () => keyboxes[0]!, on);
  stLibInitMultIcon(wKeyboxes[1]!, ST_KEY1X, ST_KEY1Y, g.keys, () => keyboxes[1]!, on);
  stLibInitMultIcon(wKeyboxes[2]!, ST_KEY2X, ST_KEY2Y, g.keys, () => keyboxes[2]!, on);

  // ammo count (all four kinds)
  const ammoY = [ST_AMMO0Y, ST_AMMO1Y, ST_AMMO2Y, ST_AMMO3Y];
  for (let i = 0; i < 4; i += 1) {
    stLibInitNum(
      wAmmo[i]!,
      ST_AMMO0X,
      ammoY[i]!,
      g.shortnum,
      (): number => plyr.ammo[i] ?? 0,
      on,
      ST_AMMO0WIDTH,
    );
  }

  // max ammo count (all four kinds)
  const maxAmmoY = [ST_MAXAMMO0Y, ST_MAXAMMO1Y, ST_MAXAMMO2Y, ST_MAXAMMO3Y];
  for (let i = 0; i < 4; i += 1) {
    stLibInitNum(
      wMaxAmmo[i]!,
      ST_MAXAMMO0X,
      maxAmmoY[i]!,
      g.shortnum,
      (): number => plyr.maxammo[i] ?? 0,
      on,
      ST_MAXAMMO0WIDTH,
    );
  }
}

/**
 * ST_Init (st_stuff.c:1465-1471): ST_loadData + the screens[4] allocation.
 * The allocation is vInit's (M9-01: screens[4] is the 320x32 BG canvas), so
 * this is loadGraphics + the STlib_init WAD handle. Asserts the canvas exists.
 */
export function stInit(wad: WadFile, consoleplayer = 0): StGraphics {
  if (screens[BG] === null || screens[BG]!.height !== ST_HEIGHT) {
    throw new Error('ST_Init: screens[BG] is not the 320x32 canvas (call vInit first)');
  }
  stLibMinusWad = wad;
  return stLoadGraphics(wad, consoleplayer);
}

/** ST_Start (st_stuff.c:1448-1456): binds the context, resets the widget
 * statics and rebuilds the widget table. */
export function stStart(c: StContext): void {
  if (!stStopped) stStop();

  ctx = c;
  stInitData(c);
  stCreateWidgets(c);
  stStopped = false;
}

/** ST_Stop (st_stuff.c:1458-1466): the base-palette restore goes through the
 * same setPaletteBand seam as ST_doPaletteStuff. */
export function stStop(): void {
  if (stStopped) return;

  // I_SetPalette(PLAYPAL+0) — and, exactly as in C, st_palette is LEFT STALE:
  // the next ST_doPaletteStuff that recomputes the band already in st_palette
  // will then NOT reprogram the palette (ST_initData's -1 is what papers over
  // it after a real ST_Start). Transcribed, not fixed.
  stStats.paletteChanges += 1;
  ctx?.setPaletteBand?.(0);

  stStopped = true;
}

/** The bound context (null before stStart). */
export function stContext(): StContext | null {
  return ctx;
}

/** Test seam: forget the bound context + every widget-table static, exactly
 * as a fresh process would have them (vanilla keeps `lastattackdown`/
 * `priority`/the pain-offset memo across ST_Start calls — those are reset
 * here ONLY because this function models process start, never from
 * stStart/stInitData). */
export function stResetAll(): void {
  ctx = null;
  stFirsttime = true;
  stClock = 0;
  stMsgCounter = 0;
  stChat = false;
  stOldChat = false;
  stStatusbaron = true;
  stNotdeathmatch = true;
  stArmson = true;
  stFragson = false;
  stFragscount = 0;
  stOldhealth = -1;
  oldWeaponsOwned = new Int32Array(NUMWEAPONS);
  stFacecount = 0;
  stFaceindex = 0;
  keyboxes.fill(-1);
  stRandomnumber = 0;
  stPalette = 0;
  painLastcalc = 0;
  painOldhealth = -1;
  lastAttackDown = -1;
  facePriority = 0;
  stStopped = true;
  graphics = null;
  stLibMinusWad = null;
  stResetStats();
}
