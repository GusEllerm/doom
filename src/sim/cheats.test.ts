// sim/cheats.test.ts — M11-09: the cht engine (m_cheat.c), the scrambled
// sequence tables (st_stuff.c:400-464, am_map.c:287), the parameter math
// (idmus/idclev), and the pure-sim effect bodies. The responder wiring +
// messages-through-state + the ledger live in ui/cheatResponder.test.ts.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import {
  CHEAT_AMAP_SEQ,
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
  cheatDecode,
  chtCheckCheat,
  chtGetParam,
  createCheatSeq,
  resolveClev,
  resolveMus,
  scramble,
  type CheatSeq
} from './cheats';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const CHARS = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/** Feed a typed string to a fresh instance of `table`; return the instance
 * and whether the cheat ever completed. */
function type(table: readonly number[], s: string): { cht: CheatSeq; fired: boolean } {
  const cht = createCheatSeq(table);
  let fired = false;
  for (const c of CHARS(s)) if (chtCheckCheat(cht, c)) fired = true;
  return { cht, fired };
}

/* ------------------------------------------------------------------ */
/* SCRAMBLE (m_cheat.h:30-32)                                          */
/* ------------------------------------------------------------------ */

describe('SCRAMBLE', () => {
  it('is an involution over all 256 bytes (self-decoding tables)', () => {
    for (let a = 0; a < 256; a++) expect(scramble(scramble(a))).toBe(a);
  });

  it('matches the hand-computed table entries', () => {
    expect(scramble(0x69)).toBe(0xb2); // 'i'
    expect(scramble(0x64)).toBe(0x26); // 'd'
    expect(scramble(0x71)).toBe(0xaa); // 'q'
    expect(scramble(0x6b)).toBe(0xf2); // 'k'
    expect(scramble(0x66)).toBe(0x66); // 'f'
    expect(scramble(0x61)).toBe(0xa2); // 'a'
    expect(scramble(0x74)).toBe(0x2e); // 't'
    expect(scramble(0x00)).toBe(0x00);
    expect(scramble(0xff)).toBe(0xff);
  });
});

/* ------------------------------------------------------------------ */
/* Table decode — the §0.7 inventory proof (scramble is its own         */
/* inverse, so decoding = scrambling the stored bytes)                  */
/* ------------------------------------------------------------------ */

describe('sequence tables decode to the 1.10 inventory', () => {
  it.each([
    ['iddqd', CHEAT_GOD_SEQ],
    ['idfa', CHEAT_AMMONOKEY_SEQ],
    ['idkfa', CHEAT_AMMO_SEQ],
    ['idmus##', CHEAT_MUS_SEQ],
    ['idspispopd', CHEAT_NOCLIP_SEQ],
    ['idclip', CHEAT_COMMERCIAL_NOCLIP_SEQ],
    ['idchoppers', CHEAT_CHOPPERS_SEQ],
    ['idclev##', CHEAT_CLEV_SEQ],
    ['idmypos', CHEAT_MYPOS_SEQ],
    ['iddt', CHEAT_AMAP_SEQ]
  ] as const)('%s', (name, table) => {
    expect(cheatDecode(table)).toBe(name);
  });

  it('the seven idbehold rows decode with the powerup-letter suffixes', () => {
    const names = ['idbeholdv', 'idbeholds', 'idbeholdi', 'idbeholdr', 'idbeholda', 'idbeholdl', 'idbehold'];
    expect(CHEAT_POWERUP_SEQS.map((s) => cheatDecode(s))).toEqual(names);
  });

  it('codes NOT in the 1.10 tables do not exist (folklore negative)', () => {
    const all = [
      CHEAT_GOD_SEQ,
      CHEAT_AMMO_SEQ,
      CHEAT_AMMONOKEY_SEQ,
      CHEAT_MUS_SEQ,
      CHEAT_NOCLIP_SEQ,
      CHEAT_COMMERCIAL_NOCLIP_SEQ,
      ...CHEAT_POWERUP_SEQS,
      CHEAT_CHOPPERS_SEQ,
      CHEAT_CLEV_SEQ,
      CHEAT_MYPOS_SEQ,
      CHEAT_AMAP_SEQ
    ].map(cheatDecode);
    // "IDK" (health/ammo refill) is DOOM-2-era folklore; the bare word
    // "noclip" the st_stuff.c:624 COMMENT mentions has no sequence;
    // "idkdt"/"mypos" (no-id) never existed; dtent/cockadoodledoo are
    // later sources. None decode to anything in 1.10:
    for (const fake of ['idk', 'noclip', 'idkdt', 'mypos', 'dtent', 'cockadoodledoo']) {
      expect(all).not.toContain(fake);
    }
  });
});

/* ------------------------------------------------------------------ */
/* cht_CheckCheat (m_cheat.c:43-75)                                    */
/* ------------------------------------------------------------------ */

describe('chtCheckCheat matcher semantics', () => {
  it('fires exactly once, on the final character', () => {
    const cht = createCheatSeq(CHEAT_GOD_SEQ);
    const hits = CHARS('iddqd').map((c) => chtCheckCheat(cht, c));
    expect(hits).toEqual([false, false, false, false, true]);
  });

  it('is re-armed after a completion (type it twice, it fires twice)', () => {
    const cht = createCheatSeq(CHEAT_GOD_SEQ);
    for (const c of CHARS('iddqd')) chtCheckCheat(cht, c);
    let fired = 0;
    for (const c of CHARS('iddqd')) if (chtCheckCheat(cht, c)) fired++;
    expect(fired).toBe(1);
  });

  it('a mismatch rewinds to 0 and is NOT retried against seq[0] (:61-64)', () => {
    // 'i' arms; a second 'i' mismatches seq[1] → cursor 0 (NOT re-armed);
    // the remaining 'd','d','q','d' then never line up.
    expect(type(CHEAT_GOD_SEQ, 'i' + 'iddqd').fired).toBe(false);
    expect(type(CHEAT_GOD_SEQ, 'ixddqd').fired).toBe(false);
    expect(type(CHEAT_GOD_SEQ, 'iddq' + 'i' + 'dqd').fired).toBe(false);
  });

  it('there is NO time decay: a paused mid-word sequence still completes', () => {
    // Vanilla m_cheat.c has no timeout of any kind — interleave unrelated
    // keystrokes BETWEEN the words only; word-internal stray chars reset.
    expect(type(CHEAT_GOD_SEQ, 'iddqd').fired).toBe(true);
  });

  it('parameter slots capture the RAW key (no scramble) and complete on the 0xff', () => {
    const { cht, fired } = type(CHEAT_MUS_SEQ, 'idmus12');
    expect(fired).toBe(true);
    expect(chtGetParam(cht)).toBe('12');
  });

  it('non-digit parameter chars are captured raw too (the C buffer is raw)', () => {
    const { cht, fired } = type(CHEAT_CLEV_SEQ, 'idclevab');
    expect(fired).toBe(true);
    expect(chtGetParam(cht)).toBe('ab');
  });

  it('GetParam zeroes the parameter region so the sequence re-arms cleanly (:88-92)', () => {
    const { cht } = type(CHEAT_MUS_SEQ, 'idmus34');
    chtGetParam(cht);
    expect(cht.seq).toEqual([...CHEAT_MUS_SEQ]);
    expect(cht.p).toBe(0);
  });

  it('a never-completed sequence never mutates its table slots', () => {
    const { cht } = type(CHEAT_MUS_SEQ, 'idmus'); // digits never typed
    expect(cht.seq).toEqual([...CHEAT_MUS_SEQ]);
  });

  it('parameterless sequences expose an empty string from GetParam (guarded scan, never called for them)', () => {
    const { cht } = type(CHEAT_GOD_SEQ, 'iddqd');
    expect(chtGetParam(cht)).toBe(''); // vanilla: UB scan; guarded here
  });
});

/* ------------------------------------------------------------------ */
/* idmus math (st_stuff.c:604-621)                                     */
/* ------------------------------------------------------------------ */

describe('resolveMus', () => {
  it('episodic: an <ep><map> PAIR selects mus_e1m1 + (ep-1)*9 + map-1', () => {
    expect(resolveMus('11', 'registered')).toEqual({ song: 1, nomus: false }); // e1m1
    expect(resolveMus('13', 'registered')).toEqual({ song: 3, nomus: false }); // e1m3
    expect(resolveMus('33', 'registered')).toEqual({ song: 21, nomus: false }); // e3m3
    // The source's >31 gate lets e4-pairs ride into the SPECIAL songs:
    expect(resolveMus('44', 'registered')).toEqual({ song: 31, nomus: false }); // victor
    expect(resolveMus('45', 'registered')).toEqual({ song: 32, nomus: false }); // introa
    expect(resolveMus('99', 'registered')).toEqual({ song: 1 + 80, nomus: true });
  });

  it('commercial: runnin + n - 1, n > 35 impossible (code-side, policy-unreached)', () => {
    expect(resolveMus('12', 'commercial')).toEqual({ song: 33 + 12 - 1, nomus: false });
    expect(resolveMus('36', 'commercial')).toMatchObject({ nomus: true });
  });
});

/* ------------------------------------------------------------------ */
/* idclev guards (st_stuff.c:676-723)                                  */
/* ------------------------------------------------------------------ */

describe('resolveClev', () => {
  it('shareware policy: episode 1, maps 1-9 ONLY (the port GAME_MODE)', () => {
    expect(resolveClev('11', 'shareware')).toEqual({ epsd: 1, map: 1 });
    expect(resolveClev('19', 'shareware')).toEqual({ epsd: 1, map: 9 });
    expect(resolveClev('21', 'shareware')).toBeNull(); // epsd>1 (:711-713)
    expect(resolveClev('10', 'shareware')).toBeNull(); // map<1 (:705)
    expect(resolveClev('01', 'shareware')).toBeNull(); // epsd<1 (:702)
    expect(resolveClev('99', 'shareware')).toBeNull();
    expect(resolveClev('ab', 'shareware')).toBeNull(); // 'a'-'0' = 49 → epsd 49 > 1
  });

  it('the mode guard table is the source, per mode', () => {
    expect(resolveClev('41', 'retail')).toEqual({ epsd: 4, map: 1 });
    expect(resolveClev('51', 'retail')).toBeNull();
    expect(resolveClev('39', 'registered')).toEqual({ epsd: 3, map: 9 });
    expect(resolveClev('41', 'registered')).toBeNull();
    // SOURCE BUG, kept: commercial computes epsd=0 and the epsd<1 guard
    // then rejects EVERY commercial idclev (folklore says it worked).
    expect(resolveClev('12', 'commercial')).toBeNull();
    expect(resolveClev('35', 'commercial')).toBeNull();
  });
});
