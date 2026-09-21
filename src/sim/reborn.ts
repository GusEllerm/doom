// sim/reborn.ts — M9-08: faithful G_DoReborn (D017 RETIRED).
//
// Mirrors linuxdoom-1.10 `g_game.c` G_DoReborn (:924-960) and documents the
// full death→reborn chain (M9-plan §0.2/§0.3/§0.5 — the source truths were
// re-read from the raw mirror this pass).
//
// THE CHAIN (single-player, every link verbatim-sourced):
//   1. P_KillMobj player branch (p_mobj.c:486-530 → port pplayer.ts
//      pKillMobjPlayer/pKillPlayer): `player->playerstate = PST_DEAD`
//      (+ corpse flags, P_DropWeapon, S_PLAY_DIE1).
//   2. P_DeathThink (p_user.c:180-232 → port pplayer.ts pDeathThink):
//      dead-camera; `if (player->cmd.buttons & BT_USE)
//      player->playerstate = PST_REBORN;` (:225-227). NO respawn happens
//      here — the latch is all.
//   3. G_Ticker reborn pass (g_game.c:613-614): `playerstate == PST_REBORN
//      ⇒ G_DoReborn(i)` — the consumer lives in game.ts step 1 and calls
//      {@link gDoReborn} HERE (this is where the D017 in-place deviation
//      lived; retired per plan §0.5).
//   4. G_DoReborn (g_game.c:924): `if (!netgame) { gameaction =
//      ga_loadlevel; }` (:926-929) — single-player death RESTARTS THE
//      LEVEL from scratch. The netgame branch (:931-959, corpse
//      dissociation + G_CheckSpot/G_DeathMatchSpawnPlayer/bodyque/
//      teleport-fog) is M12 scope (§4): this port has no netgame storage,
//      `netgame` is a compile-time false constant, so the reload is the
//      ONLY reachable branch and the playernum argument is never read.
//   5. Same-tic gameaction drain (g_game.c G_Ticker :621-649, port
//      gDrainGameAction — it runs AFTER the pass): ga_loadlevel ⇒
//      G_DoLoadLevel (g_game.c:445, port game.ts gDoLoadLevel):
//      wipe-force sentinel (:451), gamestate = GS_LEVEL (:461),
//      `playerstate == PST_DEAD ⇒ PST_REBORN` + frags memset (:477-483 —
//      no-op on the death chain, the pass already left it REBORN),
//      P_SetupLevel (:486; port gSetupLevel — p_setup.c:585 mirror),
//      viewactive = true, input-layer clear (:490-497, main.ts seam).
//   6. P_SetupLevel (p_setup.c:585-708): `totalkills = totalitems =
//      totalsecret = wminfo.maxfrags = 0`, **per-player killcount /
//      secretcount / itemcount = 0** (:595-604), leveltime = 0 (:647),
//      P_InitThinkers (fresh thinker list = this port's fresh arena +
//      fresh mobj runtime: EVERY mobj, item, corpse and special is
//      discarded and re-spawned), then P_LoadThings + P_SpawnSpecials.
//   7. P_LoadThings → P_SpawnMapThing(doomednum 1) → P_SpawnPlayer
//      (p_mobj.c:650-...): `if (player->playerstate == PST_REBORN)
//      G_PlayerReborn(player);` (:656-657) → port pplayer.ts
//      pSpawnPlayerFromStart/pPlayerReborn (g_game.c:800-831 verbatim,
//      M7-03 — the body is UNCHANGED by this task; only the CALLER chain
//      became faithful).
//
// REBORN TABLE (what the restart RESETS vs what the player KEEPS):
//   RESET (P_SetupLevel/G_DoLoadLevel half): every mobj (killed monsters
//   live again at their map spots, taken pickups stand in the world again,
//   corpses gone), all sector specials/movers/floors/ceilings, lights,
//   `totalkills/totalitems/totalsecret` (re-derived by the spawn pass),
//   per-player kill/item/secretcount (p_setup.c:595-604 — ZEROED before
//   P_LoadThings, so G_PlayerReborn's preserve/restore pair (g_game.c:
//   806-819) preserves ZERO on this path; the preservation is observable
//   only when P_SpawnPlayer runs WITHOUT P_SetupLevel, i.e. the netgame
//   respawn branch — M12), leveltime = 0, wipesecret? n/a — the secret
//   FLAGS the player found are per-player `secretcount` ⇒ RESET; the
//   sector's special-9 trigger re-arms with the sector (fresh specials
//   pass). gameaction/input layer (gamekeydown/mouse*/sendpause/
//   sendsave/paused) cleared (:490-497), frags memset (:482), then the
//   wipe-force sentinel + melt (d_main.c).
//   RESET (G_PlayerReborn half, g_game.c:800-831 memset): health = 100
//   (MAXHEALTH, no skill scaling), ALL weapons except fists+pistol
//   (0 fist/1 pistol kept, 2-6 shotgun line + 7-9 plasma/BFG chain
//   CLEARED — the full weaponowned[] memset, only [wp_fist]/[wp_pistol]
//   re-set), ammo all-zero except clips = 50, maxammo = the p_inter.c:33
//   table (backpack flag memset ⇒ double-max LOST), armor 0/0, powers
//   zero (invul/invis/strength/… gone), cards gone, cheats = 0 (the
//   memset kills iddqd/idfa too), message/damagecount/bonuscount/
//   extralight/backpack zero, readyweapon = pendingweapon = wp_pistol,
//   usedown = attackdown = true ("don't do anything immediately"),
//   playerstate = PST_LIVE.
//   KEPT: frags/kill/item/secretcount BY the preserve/restore pair
//   (values already zeroed upstream on this path — see above), view
//   angle? — memset (1.10 does NOT preserve it; later sources added the
//   viewangle save, g_game.c has none), gametic (never reset mid-game),
//   PRNG streams (M_ClearRandom belongs to G_InitNew :1414, NOT to
//   level loads — a reload continues the SAME P_Random/M_Random streams).
//   The mobj: the player is a NEW MT_PLAYER mobj at the 1-player start
//   (fresh arena); the old corpse vanishes with the discarded runtime —
//   vanilla's P_InitThinkers/Z_FreeTags drops it the same way.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GameState } from './state';

/**
 * d_event.h:56 `ga_loadlevel` (gameaction_t ordinal 1 — the GA table
 * lives in game.ts; the literal is repeated HERE, and pinned equal to
 * `GA.loadlevel` by reborn.test.ts, so reborn.ts stays a LEAF of the
 * game-flow cycle (game.ts imports this module, this module imports
 * game.ts types only — zero runtime cycle).
 */
export const GA_LOADLEVEL = 1;

/**
 * `G_DoReborn(playernum)` (g_game.c:924) — single-player truth.
 *
 * g_game.c:926-929: `if (!netgame) { gameaction = ga_loadlevel; }` —
 * that IS the body for this build: `netgame` is a compile-time-false
 * constant of the port (no net code until M12), so the respawn-at-start
 * branch (:931-959: corpse dissociation, G_DeathMatchSpawnPlayer,
 * G_CheckSpot/bodyque/teleport-fog) is unreachable and `playernum`
 * unneeded (players[0] is the invariant consoleplayer, g_game.c:1440
 * usergame path). Setting `gameaction` (NOT loading in place) is the
 * whole point: the SAME gTicker's step-2 drain runs G_DoLoadLevel →
 * P_SetupLevel, so death reloads the level inside the same tic, with
 * the gameaction contract intact (never survives a completed gTicker).
 */
export function gDoReborn(state: GameState): void {
  // g_game.c:928 — the ONE statement the !netgame build reaches.
  state.gameaction = GA_LOADLEVEL;
}
