// ui/cheatResponder.test.ts — M11-09 acceptance: each cheat that EXISTS in
// 1.10 (exact trigger → exact state effects + exact d_englsh strings), the
// folklore codes that DO NOT (asserted do-nothing), the sequence cross-talk
// rules, the cheatSink ledger (D-11f), and the iddt-in-AM_Responder fact
// (am_map.c:701 — fixed matcher in sim/amMap.ts).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createPlayer, CF_GODMODE, CF_NOCLIP, MF_NOCLIP, MF_NOGRAVITY } from '../sim/player';
import { initPlayerInventory } from '../sim/p_inter_inventory';
import { INVULNTICS } from '../sim/p_inter_pickup';
import { GS, GA } from '../sim/game';
import type { GameState } from '../sim/state';
import { amCreateState, amResponder, keydown } from '../sim/amMap';
import { cheatLog, resetCheatLog } from '../sim/hooks';
import type { PickupPlayer } from '../sim/p_inter_inventory';

import { cheatResponder, resetCheatResponder } from './cheatResponder';

/* sChangeMusic spy (musicSelect is otherwise the real M10 module). */
const musicSpy = vi.hoisted(() => vi.fn());
vi.mock('../audio/musicSelect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audio/musicSelect')>()),
  sChangeMusic: musicSpy
}));

/* ------------------------------------------------------------------ */
/* Rig                                                                 */
/* ------------------------------------------------------------------ */

function mkState(): GameState {
  const p = createPlayer();
  initPlayerInventory(p);
  const p0 = p as unknown as PickupPlayer;
  p0.ammo[0] = 1; // prove idfa refills
  p0.weaponowned[0] = 1; // fists (the only thing owned before idfa)
  const st = {
    players: [p],
    gamestate: GS.LEVEL,
    gametic: 7,
    gameskill: 3,
    gameepisode: 1,
    gamemap: 1,
    gameaction: GA.nothing
  };
  return st as unknown as GameState;
}

const type = (st: GameState, s: string): void => {
  for (const c of s) expect(cheatResponder(st, { type: 'keydown', data1: c.charCodeAt(0) })).toBe(false);
};
const up = (st: GameState, s: string): void => {
  for (const c of s) cheatResponder(st, { type: 'keyup', data1: c.charCodeAt(0) });
};
const p0 = (st: GameState) => st.players[0] as unknown as PickupPlayer;

beforeEach(() => {
  resetCheatResponder();
  resetCheatLog();
  musicSpy.mockClear();
});

/* ------------------------------------------------------------------ */
/* iddqd — st_stuff.c:549-563                                          */
/* ------------------------------------------------------------------ */

describe('iddqd (exists)', () => {
  it('on: cheats bit, health+mo.health 100, exact message', () => {
    const st = mkState();
    p0(st).health = 13;
    type(st, 'iddqd');
    expect(p0(st).cheats & CF_GODMODE).toBe(CF_GODMODE);
    expect(p0(st).health).toBe(100);
    expect((p0(st).mo as unknown as { health: number }).health).toBe(100);
    expect(p0(st).message).toBe('Degreelessness Mode On');
    type(st, 'iddqd'); // toggle off, no health write
    expect(p0(st).cheats & CF_GODMODE).toBe(0);
    expect(p0(st).message).toBe('Degreelessness Mode Off');
    expect(cheatLog.entries.map((e) => e.effect)).toEqual(['god', 'god']);
    expect(cheatLog.entries[0]).toMatchObject({ tic: 7, params: '' });
  });

  it('"iddq" / "idqd" alone do nothing', () => {
    const st = mkState();
    type(st, 'iddq');
    type(st, 'idqd');
    expect(p0(st).cheats).toBe(0);
    expect(p0(st).message).toBe('');
    expect(cheatLog.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* idfa / idkfa — st_stuff.c:564-594                                   */
/* ------------------------------------------------------------------ */

describe('idfa / idkfa (exist)', () => {
  it('idfa: armor 200/type 2, ALL weapons, ammo to max, NO keys', () => {
    const st = mkState();
    type(st, 'idfa');
    const p = p0(st);
    expect(p.armorpoints).toBe(200);
    expect(p.armortype).toBe(2);
    expect([...p.weaponowned]).toEqual(new Array(9).fill(1));
    expect([...p.ammo]).toEqual([...p.maxammo]);
    expect(p.ammo[0]).toBe(200);
    expect([...p.cards]).toEqual(new Array(6).fill(0)); // NOT-effects (keys)
    expect(p.message).toBe('Ammo (no keys) Added');
  });

  it('idkfa: same + all six cards', () => {
    const st = mkState();
    type(st, 'idkfa');
    expect([...p0(st).cards]).toEqual(new Array(6).fill(1));
    expect(p0(st).message).toBe('Very Happy Ammo Added');
    // exactly ONE effect fired — the idfa cursor reset on the 'k' and did
    // NOT fire alongside (single-key feeding, else-if chain):
    expect(cheatLog.entries.map((e) => e.effect)).toEqual(['kfa']);
  });

  it('"IDK" (DOOM-2-era folklore) does nothing', () => {
    const st = mkState();
    type(st, 'idk');
    expect(p0(st).armorpoints).toBe(0);
    expect(cheatLog.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* noclip — st_stuff.c:625-633 (idspispopd AND idclip; bare "noclip"    */
/* appears only in a source COMMENT — it has NO sequence)              */
/* ------------------------------------------------------------------ */

describe('idspispopd / idclip (exist) — noclip word (does NOT)', () => {
  it.each(['idspispopd', 'idclip'])('%s toggles CF_NOCLIP + mo flags', (word) => {
    const st = mkState();
    type(st, word);
    expect(p0(st).cheats & CF_NOCLIP).toBe(CF_NOCLIP);
    expect(p0(st).mo.flags & (MF_NOCLIP | MF_NOGRAVITY)).toBe(MF_NOCLIP | MF_NOGRAVITY);
    expect(p0(st).message).toBe('No Clipping Mode ON');
    type(st, word);
    expect(p0(st).cheats & CF_NOCLIP).toBe(0);
    expect(p0(st).mo.flags & (MF_NOCLIP | MF_NOGRAVITY)).toBe(0);
    expect(p0(st).message).toBe('No Clipping Mode OFF');
  });

  it('typing "noclip" does nothing (comment-only cheat)', () => {
    const st = mkState();
    type(st, 'noclip');
    expect(p0(st).cheats).toBe(0);
    expect(cheatLog.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* idbehold[V S I R A L] + bare — st_stuff.c:636-656                   */
/* ------------------------------------------------------------------ */

describe('idbehold* (exist)', () => {
  it('letters map to powertype_t order; give → then-set-1; message exact', () => {
    const st = mkState();
    type(st, 'idbeholdv');
    expect(p0(st).powers[0]).toBe(INVULNTICS); // P_GivePower branch
    expect(p0(st).message).toBe('Power-up Toggled');
    type(st, 'idbeholdv');
    expect(p0(st).powers[0]).toBe(1); // already had it → =1 (not strength)
    // the shared "idbehold" prefix fires the HINT message one keystroke
    // earlier — source-faithful double message (:652 vs :638):
    expect(cheatLog.entries.map((e) => e.effect)).toEqual([
      'beholdMenu', 'behold', 'beholdMenu', 'behold'
    ]);
    expect(cheatLog.entries[1]).toMatchObject({ effect: 'behold', params: 'v' });
  });

  it('strength: P_GivePower first, then powers[1]=0 (the off quirk)', () => {
    const st = mkState();
    type(st, 'idbeholds');
    expect(p0(st).powers[1]).toBe(1);
    type(st, 'idbeholds');
    expect(p0(st).powers[1]).toBe(0); // i == pw_strength branch
  });

  it.each(['i', 'r', 'a', 'l'])('letter %s hits its power index', (L) => {
    const st = mkState();
    type(st, 'idbehold' + L);
    const idx = { v: 0, s: 1, i: 2, r: 3, a: 4, l: 5 }[L]!;
    expect(p0(st).powers[idx]).toBeGreaterThan(0);
  });

  it('bare idbehold = hint message ONLY', () => {
    const st = mkState();
    type(st, 'idbehold');
    expect(p0(st).message).toBe('inVuln, Str, Inviso, Rad, Allmap, or Lite-amp');
    expect([...p0(st).powers]).toEqual(new Array(6).fill(0));
  });
});

/* ------------------------------------------------------------------ */
/* idchoppers / idmypos — st_stuff.c:657-673                           */
/* ------------------------------------------------------------------ */

describe('idchoppers (exists)', () => {
  it('chainsaw owned + powers[invuln] = 1 (the `= true` quirk), GM message', () => {
    const st = mkState();
    type(st, 'idchoppers');
    expect(p0(st).weaponowned[7]).toBe(1); // wp_chainsaw (doom1 order)
    expect(p0(st).powers[0]).toBe(1); // ONE unit, not INVULNTICS — verbatim
    expect(p0(st).message).toBe("... doesn't suck - GM");
  });
});

describe('idmypos (exists) — bare "mypos" does NOT', () => {
  it('exact sprintf hex line (two\'s-complement %x)', () => {
    const st = mkState();
    p0(st).mo.angle = 0x40000000;
    p0(st).mo.x = 0x12345;
    p0(st).mo.y = -65536; // %x on a negative fixed_t ⇒ unsigned hex
    type(st, 'idmypos');
    expect(p0(st).message).toBe('ang=0x40000000;x,y=(0x12345,0xffff0000)');
  });

  it('"mypos" without the id prefix does nothing', () => {
    const st = mkState();
    type(st, 'mypos');
    expect(p0(st).message).toBe('');
    expect(cheatLog.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* idmus — st_stuff.c:595-623 (S_ChangeMusic via the M10 musicSelect)   */
/* ------------------------------------------------------------------ */

describe('idmus<ep><map> (exists)', () => {
  it('valid pair: Music Change + S_ChangeMusic(musnum, loop)', () => {
    const st = mkState();
    type(st, 'idmus13');
    expect(p0(st).message).toBe('Music Change');
    expect(musicSpy).toHaveBeenCalledWith(3, true); // e1m3
    expect(cheatLog.entries[0]).toMatchObject({ effect: 'mus', params: '13' });
  });

  it('>31 ⇒ IMPOSSIBLE SELECTION, no switch', () => {
    const st = mkState();
    type(st, 'idmus99');
    expect(p0(st).message).toBe('IMPOSSIBLE SELECTION');
    expect(musicSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* idclev — st_stuff.c:676-723 (checked OUTSIDE the !netgame gate)      */
/* ------------------------------------------------------------------ */

describe('idclev<e><m> (exists, shareware-clamped)', () => {
  it('valid: message + G_DeferedInitNew(gameskill, epsd, map)', () => {
    const st = mkState();
    type(st, 'idclev12');
    expect(p0(st).message).toBe('Changing Level...');
    expect(st.gameaction).toBe(GA.newgame);
    expect(st.gameepisode).toBe(1);
    expect(st.gamemap).toBe(2);
    expect(st.gameskill).toBe(3); // gameskill rides through untouched
  });

  it('shareware guard (epsd>1): silent, no gameaction', () => {
    const st = mkState();
    type(st, 'idclev24');
    expect(p0(st).message).toBe('');
    expect(st.gameaction).toBe(GA.nothing);
    expect(cheatLog.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* iddt — NOT here: it lives in AM_Responder (am_map.c:701)             */
/* ------------------------------------------------------------------ */

describe('iddt (exists — in AM_Responder, automap-open only)', () => {
  it('cycles cheating = (cheating+1)%3 through amResponder', () => {
    const am = amCreateState();
    am.automapactive = true;
    const ctx = { map: undefined, player: createPlayer() } as never;
    const seq = (): void => {
      for (const c of 'iddt') amResponder(am, keydown(c.charCodeAt(0)), ctx);
    };
    seq();
    expect(am.cheating).toBe(1);
    seq();
    seq();
    expect(am.cheating).toBe(0); // 0→1→2→0
    expect(am.cheatCount).toBe(0); // cursor consumed
  });

  it('automap CLOSED: iddt does nothing (cheat check lives in the active branch)', () => {
    const am = amCreateState();
    for (const c of 'iddt') amResponder(am, keydown(c.charCodeAt(0)), { map: undefined, player: createPlayer() } as never);
    expect(am.cheating).toBe(0);
  });

  it('iddt through ST_Responder has NO effect there (correct: different station)', () => {
    const st = mkState();
    type(st, 'iddt');
    expect(cheatLog.count).toBe(0);
    expect(p0(st).message).toBe('');
  });
});

/* ------------------------------------------------------------------ */
/* Cross-talk / matcher reset rules (acceptance) + gates               */
/* ------------------------------------------------------------------ */

describe('sequence cross-talk', () => {
  it('partial "id" + gameplay keys mid-word, then "fa": no fire (reset, no retry)', () => {
    const st = mkState();
    type(st, 'id');
    type(st, 'wasdw'); // forward/strafe gameplay keys reset every cursor
    type(st, 'fa'); // without a fresh "id" these match nothing
    expect(cheatLog.count).toBe(0);
    expect(p0(st).armorpoints).toBe(0);
  });

  it('SOURCE TRUTH (no decay): "id" then the typed continuation completes', () => {
    const st = mkState();
    type(st, 'id'); // two chars of iddqd, then pause (no timeout exists in m_cheat.c)
    type(st, 'dqd');
    expect(p0(st).cheats & CF_GODMODE).toBe(CF_GODMODE);
  });

  it('keyups never fire cheats', () => {
    const st = mkState();
    up(st, 'iddqd');
    expect(cheatLog.count).toBe(0);
  });

  it('non-keydown pump stations / other gamestates: gated (g_game.c:543)', () => {
    const st = mkState();
    st.gamestate = GS.DEMOSCREEN;
    type(st, 'iddqd');
    st.gamestate = GS.FINALE;
    type(st, 'idkfa');
    expect(cheatLog.count).toBe(0);
    expect(p0(st).cheats).toBe(0);
  });

  it('folklore codes do NOTHING: idkdt, dtent, cockadoodledoo, idcockadoodledoo', () => {
    const st = mkState();
    for (const code of ['idkdt', 'dtent', 'cockadoodledoo', 'idcockadoodledoo', 'idk0']) {
      type(st, code);
    }
    expect(cheatLog.count).toBe(0);
    expect(p0(st).cheats).toBe(0);
    expect(p0(st).armorpoints).toBe(0);
  });

  it('DOCUMENTED: keys before a cheat are irrelevant — " iddqd" fires (no prefix state, no decay)', () => {
    const st = mkState();
    type(st, ' iddqd'); // space is not in any table; the word still completes
    expect(p0(st).cheats & CF_GODMODE).toBe(CF_GODMODE);
  });

  it('the ledger never sees a consume: every keystroke answers false', () => {
    const st = mkState();
    expect(cheatResponder(st, { type: 'keydown', data1: 0x69 })).toBe(false); // 'i'
    expect(cheatResponder(st, { type: 'keydown', data1: 0x20 })).toBe(false);
    expect(cheatResponder(st, { type: 'mouse', data1: 1 })).toBe(false);
  });
});
