// sim/gamemode.ts — the gamemode policy constant + G_InitNew clamps
// (g_game.c:1365-1420, M9-plan §0.4 / §0.12).
//
// §0.12 TRUTH: wads/freedoom1.wad carries ALL 36 maps (E1M1..E4M9), so
// "shareware = episode 1 only" is a POLICY choice of this port, not a data
// constraint — the lever is exactly the GAME_MODE constant plus the
// episodic episode clamp below (M9-plan §0.12). With retail-like semantics
// the same code reaches E2+ (the M12 corpus decides).
//
// SKILL DOMAIN: the deferred-init API (gDeferedInitNew, the M9-04 menu's
// `gDeferedInitNew(5, epi + 1, 1)` call) uses the vanilla DEBUG/menu 1-based
// skill numbers (1 = very easy .. 5 = nightmare); the internal 0-based
// `Skill` (state.ts) is skillToInternal(raw) = raw - 1. The g_game.c clamp
// "`> sk_nightmare ⇒ sk_nightmare`" therefore reads `raw > 5 ⇒ 5` in this
// domain (M9-03 acceptance 4: skill=6→5).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* ------------------------------------------------------------------ */
/* Policy constant (§0.12)                                             */
/* ------------------------------------------------------------------ */

export type GameMode = 'shareware' | 'registered' | 'retail' | 'commercial';

/** THE pinned policy of this port (M9-plan §0.12): shareware-episodic —
 * episode 1 only; the retail data stays reachable only by flipping this
 * constant (M12 corpus). */
export const GAME_MODE: GameMode = 'shareware';

/** Episodic upper bound per mode (g_game.c G_InitNew: retail≤4,
 * shareware≤1, else≤3 — §0.4). */
export function maxEpisode(mode: GameMode = GAME_MODE): number {
  if (mode === 'retail') return 4;
  if (mode === 'shareware') return 1;
  return 3;
}

/** Upper bound of the 1-based deferred-init skill domain (sk_nightmare). */
export const SKILL_MAX = 5;

/** Upper map number, episodic (g_game.c `map > 9 ⇒ map = 9`; the
 * commercial 30-map branch is §4-unreached under GAME_MODE=shareware). */
export const MAP_MAX_EPISODIC = 9;

export interface NewGameParams {
  /** clamped 1-based skill (1..5) */
  readonly skill: number;
  readonly episode: number;
  readonly map: number;
}

/**
 * G_InitNew's clamp block (g_game.c:1365+, §0.4) — pure, so the table is
 * directly testable (M9-03 acceptance 4):
 *   skill  > 5 ⇒ 5        (sk_nightmare clamp, 1-based domain)
 *   skill  < 1 ⇒ 1        (domain floor; vanilla has no sk_0 below 1 here)
 *   episode< 1 ⇒ 1; episode > maxEpisode(mode) ⇒ max
 *   map    < 1 ⇒ 1; map > 9 ⇒ 9 (episodic)
 */
export function clampNewGame(
  skill: number, episode: number, map: number, mode: GameMode = GAME_MODE
): NewGameParams {
  let s = skill;
  if (s > SKILL_MAX) s = SKILL_MAX;
  if (s < 1) s = 1;
  let e = episode;
  if (e < 1) e = 1;
  const eMax = maxEpisode(mode);
  if (e > eMax) e = eMax;
  let m = map;
  if (m < 1) m = 1;
  if (mode !== 'commercial' && m > MAP_MAX_EPISODIC) m = MAP_MAX_EPISODIC;
  return { skill: s, episode: e, map: m };
}

/** 1-based deferred-init skill → internal 0-based Skill (state.ts).
 * Caller passes a clampNewGame()-clamped value. */
export function skillToInternal(raw1based: number): number {
  return raw1based - 1;
}

/* ------------------------------------------------------------------ */
/* Episodic map naming (g_game.c G_DoLoadLevel nextmap math)           */
/* ------------------------------------------------------------------ */

/** `E<ep>M<map>` (g_game.c:459-463 episodic nextmap sprintf half). */
export function mapNameFor(episode: number, map: number): string {
  return `E${episode}M${map}`;
}

/** Parse an episodic map name; null for anything else (FIXMAP, MAPxx). */
export function parseMapName(name: string): { episode: number; map: number } | null {
  const m = /^E(\d)M(\d)$/.exec(name);
  if (!m) return null;
  return { episode: Number(m[1]), map: Number(m[2]) };
}

/* ------------------------------------------------------------------ */
/* Par times (wi_stuff.c pars table via g_game.c:978, §0.3)            */
/* ------------------------------------------------------------------ */

/** E1 par row, MINUTES (g_game.c:978 `pars[4][10]`, §0.3 verbatim:
 * {30,75,120,90,165,180,180,30,165}). partime = 35 × par. The E2-E4 rows
 * are §4-unreached under the shareware policy — M12 transcribes them. */
export const PARS_EP1: readonly number[] = [30, 75, 120, 90, 165, 180, 180, 30, 165];

/** pars row for an episode (shareware policy ⇒ always the E1 row). */
export function parsFor(episode: number, mode: GameMode = GAME_MODE): readonly number[] {
  void episode;
  void mode;
  return PARS_EP1;
}
