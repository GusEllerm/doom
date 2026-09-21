/**
 * sim/gamemode.test.ts — M9-03: the shareware-episodic policy constant +
 * the G_InitNew clamp table (g_game.c:1365+, M9-plan §0.4/§0.12) and the
 * pars/naming helpers the wminfo carrier boots from (§0.3).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  clampNewGame,
  GAME_MODE,
  mapNameFor,
  maxEpisode,
  parsFor,
  parseMapName,
  PARS_EP1,
  skillToInternal
} from './gamemode';

describe('GAME_MODE policy constant (§0.12)', () => {
  it('this port is pinned shareware-episodic', () => {
    expect(GAME_MODE).toBe('shareware');
    expect(maxEpisode()).toBe(1); // default arg = GAME_MODE
    expect(maxEpisode('retail')).toBe(4);
    expect(maxEpisode('registered')).toBe(3); // §0.4 "else ≤3"
  });
});

describe('clampNewGame — the acceptance table (acceptance 4)', () => {
  it('ep=5 → 1 (shareware clamp)', () => {
    expect(clampNewGame(3, 5, 1)).toEqual({ skill: 3, episode: 1, map: 1 });
  });

  it('map=0 → 1', () => {
    expect(clampNewGame(3, 1, 0)).toEqual({ skill: 3, episode: 1, map: 1 });
  });

  it('map=12 → 9 (episodic MAP_MAX)', () => {
    expect(clampNewGame(3, 1, 12)).toEqual({ skill: 3, episode: 1, map: 9 });
  });

  it('skill=6 → 5 (sk_nightmare, 1-based deferred-init domain)', () => {
    expect(clampNewGame(6, 1, 1).skill).toBe(5);
    expect(skillToInternal(5)).toBe(4); // internal Skill: nightmare
  });

  it('in-range values pass through untouched', () => {
    expect(clampNewGame(1, 1, 9)).toEqual({ skill: 1, episode: 1, map: 9 });
    expect(clampNewGame(5, 1, 1)).toEqual({ skill: 5, episode: 1, map: 1 });
  });

  it('mode-aware episode ceiling (retail-like data reaches E2+, §0.12 note)', () => {
    expect(clampNewGame(3, 5, 1, 'retail').episode).toBe(4);
    expect(clampNewGame(3, 5, 1, 'registered').episode).toBe(3);
    expect(clampNewGame(3, 0, 1, 'retail').episode).toBe(1); // <1 ⇒ 1 first
  });

  it('episode < 1 → 1 and skill < 1 → 1 (domain floors)', () => {
    const c = clampNewGame(0, -2, 5);
    expect(c).toEqual({ skill: 1, episode: 1, map: 5 });
  });
});

describe('episodic naming + pars (§0.3)', () => {
  it('mapNameFor / parseMapName round-trip; non-episodic names rejected', () => {
    expect(mapNameFor(1, 9)).toBe('E1M9');
    expect(parseMapName('E1M1')).toEqual({ episode: 1, map: 1 });
    expect(parseMapName('E3M7')).toEqual({ episode: 3, map: 7 });
    expect(parseMapName('FIXMAP')).toBeNull();
    expect(parseMapName('MAP01')).toBeNull();
    expect(parseMapName('E12M1')).toBeNull();
  });

  it('PARS_EP1 verbatim §0.3: {30,75,120,90,165,180,180,30,165}', () => {
    expect(PARS_EP1).toEqual([30, 75, 120, 90, 165, 180, 180, 30, 165]);
    expect(parsFor(1)).toBe(PARS_EP1);
    // shareware policy: every episode asks for the E1 row (M12 transcribes
    // the retail table — §0.12 data-vs-policy split).
    expect(parsFor(4)).toBe(PARS_EP1);
  });
});
