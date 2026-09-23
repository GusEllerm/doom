// sim/wintermission.ts — wi_stuff.c single-player intermission state
// machine (M9-plan §M9-07 / §0.9), sim-side. DOOM 1.9/1.10 wi_stuff.c
// transcribed: WI_Start/:1838, WI_initVariables/:1796, WI_initStats/:1318,
// WI_updateStats/:1330, WI_init/update/drawShowNextLoc/:752-812 (update
// half), WI_init/updateNoState/:730-748, WI_checkForAccelerate/:1470,
// WI_Ticker/:1503, WI_Drawer dispatch STATE (:1772) — plus the
// G_DoCompleted g_game.c:1020-1141 routing/fill half (M9-07 wires what the
// WI math needs; M9-08 owns the level-transition handoff and may wrap
// {@link gDoCompleted}).
//
// STATE MAP (sp_state, wi_stuff.c:1318/:1330):
//   1 pause(35) → 2 kills +=2/tic → 3 pause → 4 items → 5 pause →
//   6 secrets → 7 pause → 8 time(+3)/par(+3) → 9 pause(35) →
//   10 wait-accelerate ⇒ WI_initShowNextLoc (episodic; the commercial
//   WI_initNoState branch is §4-unreached under GAME_MODE=shareware) →
//   ShowNextLoc cnt=4*35 → NoState cnt=10 ⇒ WI_End + G_WorldDone.
// Percent math is INTEGER TRUNCATING division of the live counters
// ((kills*100)/maxkills etc.); the divide-by-zero guard is the
// WI_initVariables clamp maxkills/items/secret >= 1 (wi_stuff.c:1826-1833).
//
// DEVIATIONS (documented):
//  * netgame/deathmatch paths (WI_initDeathmatchStats/WI_initNetgameStats)
//    are §4-unreached — WI_Start always takes WI_initStats (single
//    player, plan §0.9).
//  * wminfo.didsecret / plrs[me].stime have no Wminfo-carrier field
//    (M9-03 pinned the shape); they live on this module's session state
//    ({@link wiPeek}) — faithful values, different mailbox.
//  * player_t.didsecret has no Player field either; the session-persistent
//    mirror `didsecretPlayer` lives here. Vanilla clears it via the
//    G_InitNew player memset (g_game.c:1385); this port clears it in
//    {@link wiResetPlayerFlags} — M9-08 (G_InitNew/level-transition
//    plumbing) calls it from the new-game path.
//  * `if (automapactive) AM_Stop()` (g_game.c:1026) is a no-op here: the
//    automap lives outside GameState (main.ts wiring, M9-09 display seam).
//  * S_ChangeMusic(mus_inter) (wi_stuff.c:1509-1514) lands on the music
//    ledger via hooks.musicSlot('intermission', true) (M10-04; consumer
//    M10-08); the S_StartSound dots land in hooks.sfxSink (counted +
//    per-tic event emission, uiSfxLog keys 'sfx_pistol'/'sfx_barexp'/
//    'sfx_sgcock'; live playback M10-06).
//  * G_PlayerFinishLevel (g_game.c:779-792) runs verbatim through the
//    attached InventoryFields view (p_inter_inventory.ts) — powers, cards,
//    MF_SHADOW, extralight, fixedcolormap, damagecount, bonuscount.
//
// PRNG LEDGER: WI_initAnimatedBack draws M_Random() once per ANIM_ALWAYS/
// ANIM_RANDOM anim at EVERY state entry (wi_stuff.c:517/:521) — episode 0
// (NUMANIMS=10, all ANIM_ALWAYS period TICRATE/3) ⇒ 10 menu-stream draws
// per entry, TWO entries per tally (initStats + initShowNextLoc) = 20.
// The WI_updateAnimatedBack ANIM_RANDOM loop draw (:560) exists in source
// but no epsd table uses ANIM_RANDOM — 0 runtime draws. See
// random-sites.ts MRANDOM_SITE_CALLS (`wi_anim`).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { GA, GS, gWorldDone, registerGameFlowHooks } from './game';
import { parsFor, GAME_MODE } from './gamemode';
import { mRandom } from './prng';
import { musicSlot, sfxSink } from './hooks';
import type { PickupPlayer } from './p_inter_inventory';
import type { GameState } from './state';
import type { GameInput } from './ticcmd';
import { MF_SHADOW } from './thinglinks';

/** d_player.h TICRATE (core/constants; mirrored for the math tables). */
const TICRATE = 35;

/* ------------------------------------------------------------------ */
/* wi_stuff.c:177-288 tables (lnodes live render-side — wiDraw.ts)      */
/* ------------------------------------------------------------------ */

const ANIM_ALWAYS = 0;
const ANIM_RANDOM = 1;
const ANIM_LEVEL = 2;

export interface WiAnimDef {
  readonly type: number;
  readonly period: number;
  readonly nanims: number;
  readonly x: number;
  readonly y: number;
  readonly data1: number;
  readonly data2: number;
}

const A = (
  type: number, period: number, nanims: number, x: number, y: number,
  data1 = 0, data2 = 0
): WiAnimDef => ({ type, period, nanims, x, y, data1, data2 });

/** epsd0animinfo (wi_stuff.c:229-240) — all ANIM_ALWAYS period 35/3=11. */
const EPSD0_ANIMS: readonly WiAnimDef[] = [
  A(ANIM_ALWAYS, 11, 3, 224, 104),
  A(ANIM_ALWAYS, 11, 3, 184, 160),
  A(ANIM_ALWAYS, 11, 3, 112, 136),
  A(ANIM_ALWAYS, 11, 3, 72, 112),
  A(ANIM_ALWAYS, 11, 3, 88, 96),
  A(ANIM_ALWAYS, 11, 3, 64, 48),
  A(ANIM_ALWAYS, 11, 3, 192, 40),
  A(ANIM_ALWAYS, 11, 3, 136, 16),
  A(ANIM_ALWAYS, 11, 3, 80, 16),
  A(ANIM_ALWAYS, 11, 3, 64, 24)
];

/** epsd1animinfo (wi_stuff.c:242-253) — ANIM_LEVEL; entry 8 is the
 * "HACK ALERT!" alias of entry 4's frames (wi_stuff.c:1611-1620). */
const EPSD1_ANIMS: readonly WiAnimDef[] = [
  A(ANIM_LEVEL, 11, 1, 128, 136, 1),
  A(ANIM_LEVEL, 11, 1, 128, 136, 2),
  A(ANIM_LEVEL, 11, 1, 128, 136, 3),
  A(ANIM_LEVEL, 11, 1, 128, 136, 4),
  A(ANIM_LEVEL, 11, 1, 128, 136, 5),
  A(ANIM_LEVEL, 11, 1, 128, 136, 6),
  A(ANIM_LEVEL, 11, 1, 128, 136, 7),
  A(ANIM_ALWAYS, 11, 3, 192, 144, 8),
  A(ANIM_LEVEL, 11, 1, 128, 136, 8)
];

/** epsd2animinfo (wi_stuff.c:255-262); entry 5 period TICRATE/4 = 8. */
const EPSD2_ANIMS: readonly WiAnimDef[] = [
  A(ANIM_ALWAYS, 11, 3, 104, 168),
  A(ANIM_ALWAYS, 11, 3, 40, 136),
  A(ANIM_ALWAYS, 11, 3, 160, 96),
  A(ANIM_ALWAYS, 11, 3, 104, 80),
  A(ANIM_ALWAYS, 11, 3, 120, 32),
  A(ANIM_ALWAYS, 8, 3, 40, 0)
];

/** anims[] / NUMANIMS (wi_stuff.c:276-288). Exported for the DRAWER
 * (wiDraw.ts resolves frame patches WIA<epsd><nn><nn> from it). */
export const WI_EPSD_ANIMS: readonly (readonly WiAnimDef[])[] = [
  EPSD0_ANIMS, EPSD1_ANIMS, EPSD2_ANIMS
];

/* ------------------------------------------------------------------ */
/* module state (wi_stuff.c statics: state/sp_state/cnt/bcnt/cnt_*)     */
/* ------------------------------------------------------------------ */

export type WiPhase = 'StatCount' | 'ShowNextLoc' | 'NoState';

interface WiAnimRuntime {
  ctr: number;
  nexttic: number;
}

const wi = {
  active: false,
  phase: 'StatCount' as WiPhase,
  spState: 1,
  accelerateStage: 0,
  cnt: 0,
  bcnt: 0,
  firstRefresh: 1,
  me: 0,
  cntKills: -1,
  cntItems: -1,
  cntSecret: -1,
  cntTime: -1,
  cntPar: -1,
  cntPause: 0,
  snlPointerOn: false,
  /** wbs->didsecret for THIS tally (G_DoCompleted copy half). */
  didsecret: false,
  /** players[0].didsecret mirror (persists across tallies; see header). */
  didsecretPlayer: false,
  /** plrs[me].stime (leveltime snapshot at G_DoCompleted). */
  stime: 0,
  epsd: 0,
  last: 0,
  next: 0,
  partime: 0,
  anim: [] as WiAnimRuntime[],
  /** WI_End call counter (the WI_unloadData seam — the render-side
   * decoded-patch cache is PU_CACHE-like and survives). */
  endCount: 0
};

/** Session peek (tests + the M9-08 handoff; the drawer uses
 * {@link wiDrawSnapshot}). */
export function wiPeek(): Readonly<typeof wi> {
  return wi;
}

/** Clear the players[].didsecret mirror — vanilla does it through the
 * G_InitNew memset (g_game.c:1385); M9-08 calls this from the new-game
 * path (also a test-isolation seam). */
export function wiResetPlayerFlags(): void {
  wi.didsecretPlayer = false;
}

/* ------------------------------------------------------------------ */
/* WI_initVariables (wi_stuff.c:1796-1834)                              */
/* ------------------------------------------------------------------ */

function wiInitVariables(state: GameState): void {
  const wbs = state.wminfo;

  wi.accelerateStage = 0;
  wi.cnt = 0;
  wi.bcnt = 0;
  wi.firstRefresh = 1;
  wi.me = wbs.p;

  // divide-by-zero guard = the 100% denominator (§0.9)
  if (!wbs.maxkills) wbs.maxkills = 1;
  if (!wbs.maxitems) wbs.maxitems = 1;
  if (!wbs.maxsecret) wbs.maxsecret = 1;

  if (GAME_MODE !== 'retail') {
    if (wbs.epsd > 2) wbs.epsd -= 3;
  }

  wi.didsecret = wi.didsecretPlayer; // wminfo.didsecret carrier gap — header
  wi.epsd = wbs.epsd;
  wi.last = wbs.last;
  wi.next = wbs.next;
  wi.partime = wbs.partime;
}

/* ------------------------------------------------------------------ */
/* animated background (wi_stuff.c:503-580)                             */
/* ------------------------------------------------------------------ */

function animTable(): readonly WiAnimDef[] {
  return WI_EPSD_ANIMS[wi.epsd] ?? [];
}

/** WI_initAnimatedBack (:503) — EVERY state entry; LEDGERED mRandom draws
 * (ANIM_ALWAYS/ANIM_RANDOM, wi_stuff.c:517/:521). */
function wiInitAnimatedBack(state: GameState): void {
  if (GAME_MODE === 'commercial') return;
  if (wi.epsd > 2) return;

  wi.anim = animTable().map((a) => {
    const rt: WiAnimRuntime = { ctr: -1, nexttic: 0 };
    if (a.type === ANIM_ALWAYS) {
      rt.nexttic = wi.bcnt + 1 + (mRandom(state.rng) % a.period); // wi_anim draw
    } else if (a.type === ANIM_RANDOM) {
      rt.nexttic = wi.bcnt + 1 + a.data2 + (mRandom(state.rng) % a.data1); // wi_anim draw
    } else if (a.type === ANIM_LEVEL) {
      rt.nexttic = wi.bcnt + 1;
    }
    return rt;
  });
}

/** WI_updateAnimatedBack (:532) — the ANIM_RANDOM loop draw (:560) has no
 * table member in any episode (measured), but transcribes verbatim. */
function wiUpdateAnimatedBack(state: GameState): void {
  if (GAME_MODE === 'commercial') return;
  if (wi.epsd > 2) return;

  const table = animTable();
  for (let i = 0; i < table.length; i++) {
    const a = table[i]!;
    const rt = wi.anim[i]!;
    if (wi.bcnt === rt.nexttic) {
      switch (a.type) {
        case ANIM_ALWAYS:
          if (++rt.ctr >= a.nanims) rt.ctr = 0;
          rt.nexttic = wi.bcnt + a.period;
          break;
        case ANIM_RANDOM:
          rt.ctr++;
          if (rt.ctr === a.nanims) {
            rt.ctr = -1;
            rt.nexttic = wi.bcnt + a.data2 + (mRandom(state.rng) % a.data1); // wi_anim draw
          } else rt.nexttic = wi.bcnt + a.period;
          break;
        case ANIM_LEVEL:
          // gawd-awful hack for level anims
          if (!(wi.phase === 'StatCount' && i === 7) && wi.next === a.data1) {
            rt.ctr++;
            if (rt.ctr === a.nanims) rt.ctr--;
            rt.nexttic = wi.bcnt + a.period;
          }
          break;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* WI_Start / state inits (wi_stuff.c:730-768, :1318, :1838)            */
/* ------------------------------------------------------------------ */

function wiInitStats(state: GameState): void {
  wi.phase = 'StatCount';
  wi.accelerateStage = 0;
  wi.spState = 1;
  wi.cntKills = wi.cntItems = wi.cntSecret = -1;
  wi.cntTime = wi.cntPar = -1;
  wi.cntPause = TICRATE;

  wiInitAnimatedBack(state);
}

/** WI_Start (:1838) — SP branch only (deathmatch/netgame §4-unreached).
 * The WI_loadData half is render-side (wiDraw.wiLoadData — screens[1]
 * slam source + patch cache). */
export function wiStart(state: GameState): void {
  wi.active = true;
  wiInitVariables(state);
  wiInitStats(state);
}

function wiInitShowNextLoc(state: GameState): void {
  wi.phase = 'ShowNextLoc';
  wi.accelerateStage = 0;
  wi.cnt = 4 * TICRATE; // SHOWNEXTLOCDELAY (wi_stuff.c:299)

  wiInitAnimatedBack(state);
}

function wiInitNoState(): void {
  wi.phase = 'NoState';
  wi.accelerateStage = 0;
  wi.cnt = 10;
}

/* ------------------------------------------------------------------ */
/* WI_updateStats (wi_stuff.c:1330-1434) — integer-truncating math      */
/* ------------------------------------------------------------------ */

/** C `/` on non-negative ints = truncate. */
const itrunc = (n: number): number => Math.trunc(n);

function wiUpdateStats(state: GameState): void {
  const wbs = state.wminfo;

  wiUpdateAnimatedBack(state);

  if (wi.accelerateStage !== 0 && wi.spState !== 10) {
    wi.accelerateStage = 0;
    wi.cntKills = itrunc((wbs.ls.kills * 100) / wbs.maxkills);
    wi.cntItems = itrunc((wbs.ls.items * 100) / wbs.maxitems);
    wi.cntSecret = itrunc((wbs.ls.secret * 100) / wbs.maxsecret);
    wi.cntTime = itrunc(wi.stime / TICRATE);
    wi.cntPar = itrunc(wbs.partime / TICRATE);
    sfxSink('sfx_barexp');
    wi.spState = 10;
  }

  if (wi.spState === 2) {
    wi.cntKills += 2;

    if (!(wi.bcnt & 3)) sfxSink('sfx_pistol');

    if (wi.cntKills >= itrunc((wbs.ls.kills * 100) / wbs.maxkills)) {
      wi.cntKills = itrunc((wbs.ls.kills * 100) / wbs.maxkills);
      sfxSink('sfx_barexp');
      wi.spState++;
    }
  } else if (wi.spState === 4) {
    wi.cntItems += 2;

    if (!(wi.bcnt & 3)) sfxSink('sfx_pistol');

    if (wi.cntItems >= itrunc((wbs.ls.items * 100) / wbs.maxitems)) {
      wi.cntItems = itrunc((wbs.ls.items * 100) / wbs.maxitems);
      sfxSink('sfx_barexp');
      wi.spState++;
    }
  } else if (wi.spState === 6) {
    wi.cntSecret += 2;

    if (!(wi.bcnt & 3)) sfxSink('sfx_pistol');

    if (wi.cntSecret >= itrunc((wbs.ls.secret * 100) / wbs.maxsecret)) {
      wi.cntSecret = itrunc((wbs.ls.secret * 100) / wbs.maxsecret);
      sfxSink('sfx_barexp');
      wi.spState++;
    }
  } else if (wi.spState === 8) {
    if (!(wi.bcnt & 3)) sfxSink('sfx_pistol');

    wi.cntTime += 3;

    if (wi.cntTime >= itrunc(wi.stime / TICRATE)) wi.cntTime = itrunc(wi.stime / TICRATE);

    wi.cntPar += 3;

    if (wi.cntPar >= itrunc(wbs.partime / TICRATE)) {
      wi.cntPar = itrunc(wbs.partime / TICRATE);

      if (wi.cntTime >= itrunc(wi.stime / TICRATE)) {
        sfxSink('sfx_barexp');
        wi.spState++;
      }
    }
  } else if (wi.spState === 10) {
    if (wi.accelerateStage !== 0) {
      sfxSink('sfx_sgcock');

      // commercial ⇒ WI_initNoState (§4-unreached, shareware policy)
      wiInitShowNextLoc(state);
    }
  } else if (wi.spState & 1) {
    if (!--wi.cntPause) {
      wi.spState++;
      wi.cntPause = TICRATE;
    }
  }
}

function wiUpdateShowNextLoc(state: GameState): void {
  wiUpdateAnimatedBack(state);

  if (!--wi.cnt || wi.accelerateStage !== 0) wiInitNoState();
  else wi.snlPointerOn = (wi.cnt & 31) < 20;
}

function wiUpdateNoState(state: GameState): void {
  wiUpdateAnimatedBack(state);

  if (!--wi.cnt) {
    wi.active = false; // WI_End (:724): the WI_unloadData half is the
    wi.endCount++;    // render-side cache (PU_CACHE-like, survives)
    // G_WorldDone (g_game.c:1147-1152): the didsecret half is here
    // because the Player field does not exist (header DEVIATIONS).
    if (state.specialexit) wi.didsecretPlayer = true;
    gWorldDone(state);
  }
}

/* ------------------------------------------------------------------ */
/* WI_checkForAccelerate (:1470) + WI_Ticker (:1503)                    */
/* ------------------------------------------------------------------ */

/** Vanilla reads players[i].cmd.buttons (the CURRENT ticcmd) and latches
 * the edges on player->attackdown/usedown — the same fields
 * P_PlayerThink uses (G_PlayerReborn resets both to true, §0.5). */
function wiCheckForAccelerate(state: GameState, input: GameInput): void {
  const p = state.players[0] as PickupPlayer | undefined;
  if (!p) return; // playeringame[0]

  if (input.attack) {
    if (!p.attackdown) wi.accelerateStage = 1;
    p.attackdown = true;
  } else p.attackdown = false;

  if (input.use) {
    if (!p.usedown) wi.accelerateStage = 1;
    p.usedown = true;
  } else p.usedown = false;
}

/** WI_Ticker (wi_stuff.c:1503-1536) — the GS_INTERMISSION tic body
 * (M9-03 registrable hook; registered at module load, bottom of file). */
export function wiTicker(state: GameState, input: GameInput): void {
  if (!wi.active) return; // post-WI_End tics (drain fixes gamestate next tic)

  wi.bcnt++;

  if (wi.bcnt === 1) {
    // intermission music (S_ChangeMusic(mus_inter, true) — M10-04 swap,
    // music ledger; consumer M10-08)
    musicSlot('intermission', true);
  }

  wiCheckForAccelerate(state, input);

  switch (wi.phase) {
    case 'StatCount':
      wiUpdateStats(state);
      break;
    case 'ShowNextLoc':
      wiUpdateShowNextLoc(state);
      break;
    case 'NoState':
      wiUpdateNoState(state);
      break;
  }
}

/** WI_Responder (wi_stuff.c:415-419 + the cheat half is doom2-only):
 * always returns false — no event is consumed. */
export function wiResponder(): boolean {
  return false;
}

/* ------------------------------------------------------------------ */
/* G_DoCompleted (g_game.c:1020-1141) — episodic halves + WI handoff.   */
/* M9-08 owns the level-transition plumbing around this (G_PlayerReborn */
/* / PST_REBORN / load paths); export it so M9-08 can wrap/compose.     */
/* ------------------------------------------------------------------ */

export function gDoCompleted(state: GameState): void {
  const p = state.players[0] as PickupPlayer | undefined;
  if (p) {
    // G_PlayerFinishLevel (g_game.c:779-792): take away cards and stuff
    p.powers.fill(0);
    p.cards.fill(0);
    p.mo.flags &= ~MF_SHADOW; // cancel invisibility
    p.extralight = 0; // cancel gun flashes
    p.fixedcolormap = 0; // cancel irgogles
    p.damagecount = 0; // no palette changes
    p.bonuscount = 0;
  }

  // gamemode != commercial (shareware policy) — g_game.c:1033-1043
  if (state.gamemap === 8) {
    state.gameaction = GA.victory; // ga_victory (E1M8 ⇒ finale, §0.3)
    return;
  }
  if (state.gamemap === 9) {
    wi.didsecretPlayer = true; // "exit secret level" marker
  }

  const wbs = state.wminfo;
  // wminfo.didsecret = players[0].didsecret — carried on wi (header)
  wbs.epsd = state.gameepisode - 1;
  wbs.last = state.gamemap - 1;

  // wminfo.next is 0 biased, unlike gamemap — episodic branch (:1092-1117)
  if (state.specialexit) {
    wbs.next = 8; // go to secret level
  } else if (state.gamemap === 9) {
    // returning from secret level
    switch (state.gameepisode) {
      case 1:
        wbs.next = 3;
        break;
      case 2:
        wbs.next = 5;
        break;
      case 3:
        wbs.next = 6;
        break;
      case 4:
        wbs.next = 2;
        break;
      default:
        break;
    }
  } else {
    wbs.next = state.gamemap; // go to next level
  }

  wbs.maxkills = state.mobjs.totalkills;
  wbs.maxitems = state.mobjs.totalitems;
  wbs.maxsecret = state.totalsecret;
  wbs.partime = TICRATE * parsFor(state.gameepisode)[state.gamemap - 1]!;
  wbs.p = 0; // wminfo.pnum = consoleplayer
  wbs.type = 'sp';

  wbs.ls.kills = p ? p.killcount : 0; // wminfo.plyr[0].skills
  wbs.ls.items = p ? p.itemcount : 0; //            .sitems
  wbs.ls.secret = state.secretcount; //             .ssecret (state proxy)

  wi.stime = state.leveltime; // wminfo.plyr[0].stime (carrier gap — header)

  state.gamestate = GS.INTERMISSION;
  state.viewactive = false;

  wiStart(state); // WI_Start(&wminfo)
}

/* ------------------------------------------------------------------ */
/* draw snapshot (wiDraw.ts consumes; verbatim counter values)          */
/* ------------------------------------------------------------------ */

export interface WiAnimSnapshot {
  readonly x: number;
  readonly y: number;
  /** lastdrawn frame index (anim_t ctr; -1 = nothing drawn yet) */
  readonly ctr: number;
}

export interface WiDrawSnapshot {
  readonly phase: WiPhase;
  readonly spState: number;
  readonly cntKills: number;
  readonly cntItems: number;
  readonly cntSecret: number;
  readonly cntTime: number;
  readonly cntPar: number;
  readonly snlPointerOn: boolean;
  readonly didsecret: boolean;
  readonly epsd: number;
  readonly last: number;
  readonly next: number;
  readonly anims: readonly WiAnimSnapshot[];
}

export function wiDrawSnapshot(): WiDrawSnapshot {
  const table = animTable();
  return {
    phase: wi.phase,
    spState: wi.spState,
    cntKills: wi.cntKills,
    cntItems: wi.cntItems,
    cntSecret: wi.cntSecret,
    cntTime: wi.cntTime,
    cntPar: wi.cntPar,
    snlPointerOn: wi.snlPointerOn,
    didsecret: wi.didsecret,
    epsd: wi.epsd,
    last: wi.last,
    next: wi.next,
    anims: table.map((a, i) => ({ x: a.x, y: a.y, ctr: wi.anim[i]?.ctr ?? -1 }))
  };
}

/* ------------------------------------------------------------------ */
/* M9-03 registrable-hook registration (side-effect at module load —   */
/* game.ts imports NOTHING of this file; whoever imports WI arms the   */
/* GS_INTERMISSION route + the ga_completed body, M8-family idiom).    */
/* ------------------------------------------------------------------ */

registerGameFlowHooks({
  wiTicker,
  doCompleted: gDoCompleted
});
