// ui/cheatResponder.ts — ST_Responder's cheat layer (st_stuff.c:515-724),
// ported at the SAME precedence (M11-09, M11-plan §0.7/§M11-09).
//
// WHERE IT SITS (g_game.c G_Responder:504-559 + d_main.c D_ProcessEvents:173):
// vanilla feeds every event M_Responder FIRST (menu eats what it has an
// alphaKey for; non-shortcut letters fall THROUGH to the sim), then
// G_Responder runs HU → ST → AM inside GS_LEVEL. In this port's pump
// (main.ts stepTic, M9-12 order) the station that must precede this one is
// the menu (`mResponder`) and it must precede the HU half — i.e. wire it as
// `if (cheatResponder(state, ev)) continue;` between mResponder and
// huResponder (registration is M11-10's one composer edit). Fidelity notes:
//   * ST_Responder NEVER consumes: its last line (st_stuff.c:724) is
//     `return false`, so this responder always returns false (typed letters
//     keep flowing exactly like vanilla — gamekeydown/g_HU see them too).
//   * The GS_LEVEL gate is g_game.c:543 (ST is only called in a level);
//     enforced here because our pump calls every station.
//   * `netgame` is a compile-time false of this port (game.ts §G_DoNewGame),
//     so the :543 `if (!netgame)` block ALWAYS runs and idclev's outside-the-
//     block position (st_stuff.c:676, the "works in netgame too" quirk) is
//     structurally preserved but behaviorally identical.
//   * Known order deviation (INHERITED, not invented here): our pump runs
//     amResponder FIRST, so while the AUTOMAP is open the automap-bound
//     letters c/f/g/m/'0' are eaten before this station sees them — vanilla
//     feeds ST before AM (g_game.c:546 before :548), so e.g. idmus typed
//     with the map open would also set a mark. Ledgered in
//     docs/reports/M11-cheats.md.
//   * iddt is NOT here: it lives in AM_Responder (am_map.c:701) and is
//     handled by sim/amMap.ts's chtCheckCheat (fixed in this task — the
//     prior port compared RAW bytes to the scrambled table and could never
//     match; m_cheat.c:62 translates via cheat_xlate_table).
//
// Effects mutate through the sim/cheats.ts exports (sim-side code) and are
// LEDGERED through hooks.cheatSink in the event-pump phase — pre-tic, so a
// toggle gates the NEXT tic and carries no hash delta (D-11f).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { GS, gDeferedInitNew } from '../sim/game';
import type { GameState } from '../sim/state';
import { cheatSink } from '../sim/hooks';
import {
  CHEAT_AMMO_SEQ,
  CHEAT_AMMONOKEY_SEQ,
  CHEAT_CLEV_SEQ,
  CHEAT_CHOPPERS_SEQ,
  CHEAT_COMMERCIAL_NOCLIP_SEQ,
  CHEAT_GOD_SEQ,
  CHEAT_MUS_SEQ,
  CHEAT_MYPOS_SEQ,
  CHEAT_NOCLIP_SEQ,
  CHEAT_POWERUP_SEQS,
  STSTR,
  chtCheckCheat,
  chtGetParam,
  cheatArsenal,
  cheatBehold,
  cheatBeholdMenu,
  cheatChoppers,
  cheatGod,
  cheatMypos,
  cheatNoclip,
  createCheatSeq,
  resolveClev,
  resolveMus,
  type CheatSeq
} from '../sim/cheats';
import { sChangeMusic } from '../audio/musicSelect';

/* ------------------------------------------------------------------ */
/* The cheatseq_t statics (st_stuff.c:467-487)                         */
/* ------------------------------------------------------------------ */

interface Trackers {
  god: CheatSeq;
  ammo: CheatSeq;
  ammokey: CheatSeq;
  mus: CheatSeq;
  noclip: CheatSeq;
  commercialNoclip: CheatSeq;
  powerup: CheatSeq[];
  choppers: CheatSeq;
  clev: CheatSeq;
  mypos: CheatSeq;
}

let trackers: Trackers | null = null;

/** The cheat_powerup_seq[0..5] final letters (v/s/i/r/a/l, st_stuff.c:441-451)
 * — ledger payload only. */
const BEHOLD_LETTERS = 'vsiral';

function theTrackers(): Trackers {
  if (trackers === null) {
    trackers = {
      god: createCheatSeq(CHEAT_GOD_SEQ),
      ammo: createCheatSeq(CHEAT_AMMO_SEQ),
      ammokey: createCheatSeq(CHEAT_AMMONOKEY_SEQ),
      mus: createCheatSeq(CHEAT_MUS_SEQ),
      noclip: createCheatSeq(CHEAT_NOCLIP_SEQ),
      commercialNoclip: createCheatSeq(CHEAT_COMMERCIAL_NOCLIP_SEQ),
      powerup: CHEAT_POWERUP_SEQS.map(createCheatSeq),
      choppers: createCheatSeq(CHEAT_CHOPPERS_SEQ),
      clev: createCheatSeq(CHEAT_CLEV_SEQ),
      mypos: createCheatSeq(CHEAT_MYPOS_SEQ)
    };
  }
  return trackers;
}

/** Test seam ONLY (vanilla resets these nowhere — the statics outlive
 * levels and even new games; production never calls this). */
export function resetCheatResponder(): void {
  trackers = null;
}

/* ------------------------------------------------------------------ */
/* ST_Responder                                                        */
/* ------------------------------------------------------------------ */

/** ev_keydown/ev_keyup shaped like the pump's events (data1 = vanilla
 * ev->data1, lowercase ASCII for printables). */
export interface CheatResponderEvent {
  readonly type: 'keydown' | 'keyup' | 'mouse';
  readonly data1: number;
}

export function cheatResponder(
  state: GameState,
  ev: CheatResponderEvent
): boolean {
  // st_stuff.c:520-537: the ONLY keyup branch is the AM_MSGHEADER
  // automap-state tracking — unrepresentable here (data1 is a plain
  // doomkey; the automap stations read state), so every keyup falls
  // through, as it does in vanilla. Mouse/joystick: not keydown, skipped.
  if (ev.type !== 'keydown') return false;
  // g_game.c:543 — ST_Responder is called only when gamestate == GS_LEVEL.
  if (state.gamestate !== GS.LEVEL) return false;

  const t = theTrackers();
  const k = ev.data1;
  const tic = state.gametic;

  // st_stuff.c:543 `if (!netgame)` — netgame is false in this build.
  // 'dqd' cheat for toggleable god mode (:549)
  if (chtCheckCheat(t.god, k)) {
    cheatGod(state);
    cheatSink('god', '', tic);
  }
  // 'fa' cheat for killer fucking arsenal (:564)
  else if (chtCheckCheat(t.ammokey, k)) {
    cheatArsenal(state, false);
    cheatSink('fa', '', tic);
  }
  // 'kfa' cheat for key full ammo (:578)
  else if (chtCheckCheat(t.ammo, k)) {
    cheatArsenal(state, true);
    cheatSink('kfa', '', tic);
  }
  // 'mus' cheat for changing music (:595)
  else if (chtCheckCheat(t.mus, k)) {
    state.players[0]!.message = STSTR.MUS; // :600 — BEFORE GetParam (:602)
    const param = chtGetParam(t.mus);
    const { song, nomus } = resolveMus(param);
    if (nomus) {
      state.players[0]!.message = STSTR.NOMUS; // :610/:619
      cheatSink('mus', param, tic);
    } else {
      sChangeMusic(song, true); // S_ChangeMusic(musnum, 1)
      cheatSink('mus', param, tic);
    }
  }
  // Simplified, accepting both "noclip" and "idspispopd" — the source
  // COMMENT lies: only idspispopd and idclip have sequences (st_stuff.c:
  // 625-626, tables :427-437).
  else if (chtCheckCheat(t.noclip, k) || chtCheckCheat(t.commercialNoclip, k)) {
    cheatNoclip(state);
    cheatSink('noclip', '', tic);
  }
  // 'behold?' power-up cheats (:635-651) — a for loop, NOT part of the
  // else-if chain: all six matchers see the key unless the chain above
  // matched (then the loop still runs — it is a separate statement).
  for (let i = 0; i < 6; i++) {
    if (chtCheckCheat(t.powerup[i]!, k)) {
      cheatBehold(state, i);
      cheatSink('behold', BEHOLD_LETTERS[i]!, tic);
    }
  }
  // 'behold' power-up menu (:652-656) — its own if/else-if chain start.
  if (chtCheckCheat(t.powerup[6]!, k)) {
    cheatBeholdMenu(state);
    cheatSink('beholdMenu', '', tic);
  }
  // 'choppers' invulnerability & chainsaw (:657-663)
  else if (chtCheckCheat(t.choppers, k)) {
    cheatChoppers(state);
    cheatSink('choppers', '', tic);
  }
  // 'mypos' for player position (:664-673)
  else if (chtCheckCheat(t.mypos, k)) {
    cheatMypos(state);
    cheatSink('mypos', '', tic);
  }

  // 'clev' change-level cheat (:676) — OUTSIDE the !netgame gate (:675's
  // brace closes before this if).
  if (chtCheckCheat(t.clev, k)) {
    const param = chtGetParam(t.clev);
    const target = resolveClev(param);
    if (target !== null) {
      state.players[0]!.message = STSTR.CLEV; // :720
      gDeferedInitNew(state, state.gameskill, target.epsd, target.map); // :721
      cheatSink('clev', param, tic);
    }
    // Every guard failure is vanilla's `return false` (:697-717): no
    // message, no gameaction — and the function ends (:724 returns false).
  }

  return false; // st_stuff.c:724 — ST_Responder never eats the event
}
