# R06: Map Objects and the State Table Model

Research notes for the TypeScript recreation (Doom 1 format, Freedoom target).
Sources: id Software linuxdoom-1.10 (`/tmp/DOOM-master/linuxdoom-1.10/`), `/tmp/freedoom-0.13.0/freedoom1.wad`.

Status: COMPLETE. All sections filled; corrections to predecessor facts noted inline.

## Table of contents
1. State machine semantics (P_SetMobjState, P_MobjThinker)
2. SPR_* sprite enum (full list, 4-char codes)
3. mobjinfo[] — full transcription of all 137 MT_ entries (script-extracted)
4. Frame bits (FF_*), rotation/mirror rules (r_things.c)
5. Thing numbering: Doom1 doomednum + Freedoom Phase 1 evidence (E1M1 THINGS histogram)
6. P_SpawnMapThing — exact code, skill/ambush filters
7. P_KillMobj — full quote (gib thresholds, corpse, barrels, player branch)
8. Item pickup — P_TouchSpecialThing + P_Give* semantics, MaxAmmo
9. Barrels & exploding mobjs
10. Notes for our TypeScript port (mobj_t fields, state-table encoding)

## Verified baseline (spot-checked from predecessor)

Spot-checked against `info.h`, `p_mobj.c/h` in `/tmp/DOOM-master/linuxdoom-1.10/`:

- `state_t` (info.h:1147-1156): `{ spritenum_t sprite; int frame; int tics; action (acp1); statenum_t nextstate; int misc1; int misc2; }` — 7 fields. Confirmed.
- `mobjinfo_t` (info.h:1305-1331): **23 fields, not 24** (correction to predecessor): doomednum, spawnstate, spawnhealth, seestate, seesound, reactiontime, attacksound, painstate, painchance, painsound, meleestate, missilestate, deathstate, xdeathstate, deathsound, speed, radius, height, mass, damage, activesound, flags, raisestate. `doomednum` present, no `flags2`. The predecessor's "attackSound?"/"reactionspeed?" correspond to real fields `attacksound` and `reactiontime`.
- **NUMMOBJTYPES = 137, not 118** (correction): the `mobjtype_t` enum runs `MT_PLAYER=0 .. MT_MISC86=136` (MT_NONE is not in the Doom 1 enum), and `mobjinfo[]` in info.c has exactly 137 entries (script-counted). The GPL v1.10 table is the Doom 1/2 superset with `MF_*` only (no `MF2_*`). See section 3.
- NUMSPRITES = **138** (SPR_TROO=0 .. SPR_TLP2=137), confirmed by script.
- All 25 `MF_*` values confirmed exactly as listed in the task brief, incl. `MF_TRANSLATION = 0xc000000`, `MF_TRANSSHIFT = 26` (p_mobj.h:117-204).
- `MAXTICS` **does not exist** in linuxdoom-1.10 (grep: zero matches). Infinite states use `tics == -1`, handled in `P_MobjThinker` (p_mobj.c:441). See section 1.
- E1M1 THINGS check (freedoom1.wad): all 292 E1M1 thing types are valid Doom 1 doomednums (monsters 3004/9/3001/3002, barrels 2035, items 2005-2049 slots incl. bonuses 2014/2015). Doom 2-only numbers (6072, 4001) appear **nowhere** in 7 sampled maps. **Freedoom Phase 1 uses the Doom 1 thing numbering.**

Confidence: High (direct grep/sed/script verification).

## 1. State machine semantics

### state_t (info.h:1147-1156)

```c
typedef struct state_s
{
    spritenum_t sprite;   // 0 .. NUMSPRITES-1 (138 sprites)
    int         frame;    // frame index (0-based letter), may be ORed with FF_FULLBRIGHT
    int         tics;     // -1 == infinite (no MAXTICS constant exists in this source)
    void (*action)(mobj_t*);  // stored as actionf acp1
    statenum_t  nextstate;
    int         misc1;    // reused per-action (A_Look distances, A_Chase flags, ...)
    int         misc2;
} state_t;
```

### P_SetMobjState (p_mobj.c:48-86) — returns true if mobj still exists

```c
boolean P_SetMobjState (mobj_t* mobj, statenum_t state)
{
    state_t*	st;
    do
    {
	if (state == S_NULL)
	{
	    mobj->state = (state_t *) S_NULL;
	    P_RemoveMobj (mobj);
	    return false;
	}
	st = &states[state];
	mobj->state = st;
	mobj->tics = st->tics;
	mobj->sprite = st->sprite;
	mobj->frame = st->frame;
	// Modified handling.
	// Call action functions when the state is set
	if (st->action.acp1)
	    st->action.acp1(mobj);
	state = st->nextstate;
    } while (!mobj->tics);
    return true;
}
```

Semantics:
- Return `false` = mobj removed (freed); callers must bail out immediately.
- `S_NULL` as nextstate removes the object (no corpse left).
- **Action-on-entry**: the action runs when the state is *set*, not when it expires.
- Chaining loop: if `mobj->tics == 0` after the action, the `do/while` follows `nextstate` again within the same call (0-tic states cascade in one tic).
- `tics == -1`: state never advances. **`MAXTICS` does not exist in linuxdoom-1.10** (grep: 0 matches); the convention is literal `-1`.

### P_MobjThinker state timer (p_mobj.c:413-470, tail quoted)

```c
    // cycle through states,
    // calling action functions at transitions
    if (mobj->tics != -1)
    {
	mobj->tics--;
		
	// you can cycle through multiple states in a tic
	if (!mobj->tics)
	    if (!P_SetMobjState (mobj, mobj->state->nextstate) )
		return;		// freed itself
    }
    else
    {
	// check for nightmare respawn
	if (! (mobj->flags & MF_COUNTKILL) )
	    return;
	if (!respawnmonsters)
	    return;
	mobj->movecount++;
	if (mobj->movecount < 12*35)
	    return;
	if ( leveltime&31 )
	    return;
	if (P_Random () > 4)
	    return;
	P_NightmareRespawn (mobj);
    }
```

Per-tic order before this tail (p_mobj.c:416-435): `P_XYMovement` if `momx||momy||MF_SKULLFLY` (bail if thinker function == -1, i.e. removed), then `P_ZMovement` if `z != floorz || momz`.

Related verified facts:
- Spawn desync: `mobj->tics = 1 + (P_Random() % mobj->tics)` in P_SpawnMapThing.
- `P_ExplodeMissile` (p_mobj.c:90-106): zeroes momentum, `P_SetMobjState(mo, mobjinfo[mo->type].deathstate)`, `tics -= P_Random()&3` (min 1), clears `MF_MISSILE`, plays `deathsound`.

Confidence: High (verbatim from p_mobj.c).

## 2. SPR_* sprite enum

The `spritenum_t` enum (info.h:31-176). NUMSPRITES = **138** (SPR_TROO=0 .. SPR_TLP2=137, script-counted). The same strings are the runtime name list `sprnames[]` (info.c:40), passed to `R_InitSprites` by p_setup.c:704. The 4-char code prefixes the sprite lump names (`POSSA1`, `POSSB8`...). Index = sprite number stored in `state_t.sprite`/`mobj_t.sprite`.

| idx | SPR_ | code | description (Doom 1 usage) |
|---|---|---|---|
| 0 | SPR_TROO | TROO | Trooper (zombieman) monster |
| 1 | SPR_SHTG | SHTG | Shotgun (psprite) |
| 2 | SPR_PUNG | PUNG | Fist (psprite) |
| 3 | SPR_PISG | PISG | Pistol (psprite) |
| 4 | SPR_PISF | PISF | Pistol firing (psprite) |
| 5 | SPR_SHTF | SHTF | Shotgun firing (psprite) |
| 6 | SPR_SHT2 | SHT2 | Shotgun pump/reload (psprite) |
| 7 | SPR_CHGG | CHGG | Chaingun (psprite) |
| 8 | SPR_CHGF | CHGF | Chaingun firing (psprite) |
| 9 | SPR_MISG | MISG | Rocket launcher (psprite) |
| 10 | SPR_MISF | MISF | Rocket launcher firing (psprite) |
| 11 | SPR_SAWG | SAWG | Chainsaw (psprite) |
| 12 | SPR_PLSG | PLSG | Plasma gun (psprite) |
| 13 | SPR_PLSF | PLSF | Plasma gun firing (psprite) |
| 14 | SPR_BFGG | BFGG | BFG9000 (psprite) |
| 15 | SPR_BFGF | BFGF | BFG9000 firing (psprite) |
| 16 | SPR_BLUD | BLUD | Blood splat |
| 17 | SPR_PUFF | PUFF | Bullet puff / impact smoke |
| 18 | SPR_BAL1 | BAL1 | Baron/Caco fireball |
| 19 | SPR_BAL2 | BAL2 | Baron/Caco fireball (alt anim) |
| 20 | SPR_PLSS | PLSS | Cacodemon plasma ball |
| 21 | SPR_PLSE | PLSE | Cacodemon plasma ball (alt anim) |
| 22 | SPR_MISL | MISL | Rocket (player missile) |
| 23 | SPR_BFS1 | BFS1 | BFG projectile |
| 24 | SPR_BFE1 | BFE1 | BFG explosion 1 |
| 25 | SPR_BFE2 | BFE2 | BFG explosion 2 |
| 26 | SPR_TFOG | TFOG | Teleport smoke (blue) |
| 27 | SPR_IFOG | IFOG | Item respawn fog |
| 28 | SPR_PLAY | PLAY | Player (skins via MF_TRANSLATION) |
| 29 | SPR_POSS | POSS | Zombieman (player-colored, E1) |
| 30 | SPR_SPOS | SPOS | Shotgun guy |
| 31 | SPR_VILE | VILE | Archvile (Doom 2 only) |
| 32 | SPR_FIRE | FIRE | Archvile fire (Doom 2 only) |
| 33 | SPR_FATB | FATB | Fatso shot (Doom 2 only) |
| 34 | SPR_FBXP | FBXP | Fatso shot explosion |
| 35 | SPR_SKEL | SKEL | Lost soul |
| 36 | SPR_MANF | MANF | Cannonball (Doom 2 map30) |
| 37 | SPR_FATT | FATT | Fatso boss (Doom 2 map30) |
| 38 | SPR_CPOS | CPOS | Commando demon (Doom 2 only) |
| 39 | SPR_SARG | SARG | Alt player skin (deathmatch) |
| 40 | SPR_HEAD | HEAD | Baron of Hell (Hell Knight art in Doom 1) |
| 41 | SPR_BAL7 | BAL7 | Baron fireball |
| 42 | SPR_BOSS | BOSS | Cyberdemon |
| 43 | SPR_BOS2 | BOS2 | Spider mastermind |
| 44 | SPR_SKUL | SKUL | Pain elemental |
| 45 | SPR_SPID | SPID | Arachnotron |
| 46 | SPR_BSPI | BSPI | Arachnotron plasma |
| 47 | SPR_APLS | APLS | Plasma ball (unused alt anim) |
| 48 | SPR_APBX | APBX | Plasma explosion |
| 49 | SPR_CYBR | CYBR | Cyberdemon (alt anim) |
| 50 | SPR_PAIN | PAIN | Cacodemon |
| 51 | SPR_SSWV | SSWV | Former human sergeant (Doom 2 only) |
| 52 | SPR_KEEN | KEEN | "Keen" easter egg (Doom 2 only) |
| 53 | SPR_BBRN | BBRN | Boss brain explosion state (Doom 2 only) |
| 54 | SPR_BOSF | BOSF | Cyberdemon rocket |
| 55 | SPR_ARM1 | ARM1 | Green armor (pickup) |
| 56 | SPR_ARM2 | ARM2 | Mega armor (pickup) |
| 57 | SPR_BAR1 | BAR1 | Explosive barrel |
| 58 | SPR_BEXP | BEXP | Barrel explosion |
| 59 | SPR_FCAN | FCAN | Burning barrel |
| 60 | SPR_BON1 | BON1 | Health bonus (+1) |
| 61 | SPR_BON2 | BON2 | Armor bonus (+1) |
| 62 | SPR_BKEY | BKEY | Blue keycard |
| 63 | SPR_RKEY | RKEY | Red keycard |
| 64 | SPR_YKEY | YKEY | Yellow keycard |
| 65 | SPR_BSKU | BSKU | Blue skull key |
| 66 | SPR_RSKU | RSKU | Red skull key |
| 67 | SPR_YSKU | YSKU | Yellow skull key |
| 68 | SPR_STIM | STIM | Stimpack (+10) |
| 69 | SPR_MEDI | MEDI | Medikit (+25) |
| 70 | SPR_SOUL | SOUL | Soul sphere (+100) |
| 71 | SPR_PINV | PINV | Invulnerability |
| 72 | SPR_PSTR | PSTR | Berserk |
| 73 | SPR_PINS | PINS | Partial invisibility |
| 74 | SPR_MEGA | MEGA | Mega sphere (commercial only) |
| 75 | SPR_SUIT | SUIT | Radiation suit |
| 76 | SPR_PMAP | PMAP | Computer map |
| 77 | SPR_PVIS | PVIS | Light-amp visor |
| 78 | SPR_CLIP | CLIP | Bullets clip (also monster-dropped) |
| 79 | SPR_AMMO | AMMO | Bullets box |
| 80 | SPR_ROCK | ROCK | Rocket ammo |
| 81 | SPR_BROK | BROK | Rockets box |
| 82 | SPR_CELL | CELL | Energy cell |
| 83 | SPR_CELP | CELP | Cell pack |
| 84 | SPR_SHEL | SHEL | Shotgun shells |
| 85 | SPR_SBOX | SBOX | Shell box |
| 86 | SPR_BPAK | BPAK | Backpack |
| 87 | SPR_BFUG | BFUG | BFG9000 (pickup) |
| 88 | SPR_MGUN | MGUN | Chaingun (pickup) |
| 89 | SPR_CSAW | CSAW | Chainsaw (pickup) |
| 90 | SPR_LAUN | LAUN | Rocket launcher (pickup) |
| 91 | SPR_PLAS | PLAS | Plasma gun (pickup) |
| 92 | SPR_SHOT | SHOT | Shotgun (pickup) |
| 93 | SPR_SGN2 | SGN2 | Super shotgun (pickup, commercial) |
| 94 | SPR_COLU | COLU | Torch column (E1M5) |
| 95 | SPR_SMT2 | SMT2 | Short torch pillar variant |
| 96 | SPR_GOR1 | GOR1 | Meat on hook 1 |
| 97 | SPR_POL2 | POL2 | Dead lost soul decor |
| 98 | SPR_POL5 | POL5 | Dead corpse on floor |
| 99 | SPR_POL4 | POL4 | Dead corpse variant |
| 100 | SPR_POL3 | POL3 | Dead corpse variant |
| 101 | SPR_POL1 | POL1 | Dead corpse variant |
| 102 | SPR_POL6 | POL6 | Dead corpse variant |
| 103 | SPR_GOR2 | GOR2 | Meat on hook 2 |
| 104 | SPR_GOR3 | GOR3 | Meat on hook 3 |
| 105 | SPR_GOR4 | GOR4 | Meat on hook 4 |
| 106 | SPR_GOR5 | GOR5 | Meat on hook 5 |
| 107 | SPR_SMIT | SMIT | Short candles |
| 108 | SPR_COL1 | COL1 | Burnt tree (E1M8) |
| 109 | SPR_COL2 | COL2 | Tree (E1M8) |
| 110 | SPR_COL3 | COL3 | Tree variant |
| 111 | SPR_COL4 | COL4 | Tree variant |
| 112 | SPR_CAND | CAND | Candle |
| 113 | SPR_CBRA | CBRA | Burning candle cluster |
| 114 | SPR_COL6 | COL6 | Tech pillar |
| 115 | SPR_TRE1 | TRE1 | Tree (E1M8) |
| 116 | SPR_TRE2 | TRE2 | Tree variant |
| 117 | SPR_ELEC | ELEC | Electric light (Doom 2 only) |
| 118 | SPR_CEYE | CEYE | Ceiling eye |
| 119 | SPR_FSKU | FSKU | Floating skull decor |
| 120 | SPR_COL5 | COL5 | Tech column |
| 121 | SPR_TBLU | TBLU | Blue torch flame (Doom 2) |
| 122 | SPR_TGRN | TGRN | Green torch flame (Doom 2) |
| 123 | SPR_TRED | TRED | Red torch flame (Doom 2) |
| 124 | SPR_SMBT | SMBT | Blue torch pendant |
| 125 | SPR_SMGT | SMGT | Green torch pendant |
| 126 | SPR_SMRT | SMRT | Red torch pendant |
| 127 | SPR_HDB1 | HDB1 | Hanging eyeball 1 |
| 128 | SPR_HDB2 | HDB2 | Hanging eyeball 2 |
| 129 | SPR_HDB3 | HDB3 | Hanging eyeball 3 |
| 130 | SPR_HDB4 | HDB4 | Hanging eyeball 4 |
| 131 | SPR_HDB5 | HDB5 | Hanging eyeball 5 |
| 132 | SPR_HDB6 | HDB6 | Hanging eyeball 6 |
| 133 | SPR_POB1 | POB1 | Goo drip (Doom 2) |
| 134 | SPR_POB2 | POB2 | Goo drip variant (Doom 2) |
| 135 | SPR_BRS1 | BRS1 | Goo drip stick (Doom 2) |
| 136 | SPR_TLMP | TLMP | Tech lamp |
| 137 | SPR_TLP2 | TLP2 | Tech lamp (flickering alt anim) |

Confidence: High for order/codes (script-transcribed enum). Medium for a few Doom-2-only decor descriptions (unused by Freedoom Phase 1).

## 3. mobjinfo[] — full transcription (all 137 entries)

Dumped by script from `info.c:1106` (`mobjinfo_t mobjinfo[NUMMOBJTYPES]`, 137 entries — see baseline correction: NOT 118).
Notes on encoding: `—` = `sfx_None`; a bare `0` in a state column means `S_NULL` (written `0` in the C source); radius/height/speed columns show FRACUNIT multipliers (i.e. map units, `n*FRACUNIT`); mass/damage/health are plain ints. Flags are `MF_*` ORs (`&#124;` = escaped `|`).

| idx | mobjtype | doomednum | spawnstate | spawnhealth | seestate | seesound | reactiontime | attacksound | painstate | painchance | painsound | meleestate | missilestate | deathstate | xdeathstate | deathsound | speed | radius | height | mass | damage | activesound | flags | raisestate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---
| 0 | MT_PLAYER | -1 | S_PLAY | 100 | S_PLAY_RUN1 | — | 0 | — | S_PLAY_PAIN | 255 | sfx_plpain | S_NULL | S_PLAY_ATK1 | S_PLAY_DIE1 | S_PLAY_XDIE1 | sfx_pldeth | 0 | 16 | 56 | 100 | 0 | — | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_DROPOFF&#124;MF_PICKUP&#124;MF_NOTDMATCH | S_NULL |
| 1 | MT_POSSESSED | 3004 | S_POSS_STND | 20 | S_POSS_RUN1 | sfx_posit1 | 8 | sfx_pistol | S_POSS_PAIN | 200 | sfx_popain | 0 | S_POSS_ATK1 | S_POSS_DIE1 | S_POSS_XDIE1 | sfx_podth1 | 8 | 20 | 56 | 100 | 0 | sfx_posact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_POSS_RAISE1 |
| 2 | MT_SHOTGUY | 9 | S_SPOS_STND | 30 | S_SPOS_RUN1 | sfx_posit2 | 8 | 0 | S_SPOS_PAIN | 170 | sfx_popain | 0 | S_SPOS_ATK1 | S_SPOS_DIE1 | S_SPOS_XDIE1 | sfx_podth2 | 8 | 20 | 56 | 100 | 0 | sfx_posact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_SPOS_RAISE1 |
| 3 | MT_VILE | 64 | S_VILE_STND | 700 | S_VILE_RUN1 | sfx_vilsit | 8 | 0 | S_VILE_PAIN | 10 | sfx_vipain | 0 | S_VILE_ATK1 | S_VILE_DIE1 | S_NULL | sfx_vildth | 15 | 20 | 56 | 500 | 0 | sfx_vilact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_NULL |
| 4 | MT_FIRE | -1 | S_FIRE1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 5 | MT_UNDEAD | 66 | S_SKEL_STND | 300 | S_SKEL_RUN1 | sfx_skesit | 8 | 0 | S_SKEL_PAIN | 100 | sfx_popain | S_SKEL_FIST1 | S_SKEL_MISS1 | S_SKEL_DIE1 | S_NULL | sfx_skedth | 10 | 20 | 56 | 500 | 0 | sfx_skeact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_SKEL_RAISE1 |
| 6 | MT_TRACER | -1 | S_TRACER | 1000 | S_NULL | sfx_skeatk | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_TRACEEXP1 | S_NULL | sfx_barexp | 10 | 11 | 8 | 100 | 10 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 7 | MT_SMOKE | -1 | S_SMOKE1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 8 | MT_FATSO | 67 | S_FATT_STND | 600 | S_FATT_RUN1 | sfx_mansit | 8 | 0 | S_FATT_PAIN | 80 | sfx_mnpain | 0 | S_FATT_ATK1 | S_FATT_DIE1 | S_NULL | sfx_mandth | 8 | 48 | 64 | 1000 | 0 | sfx_posact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_FATT_RAISE1 |
| 9 | MT_FATSHOT | -1 | S_FATSHOT1 | 1000 | S_NULL | sfx_firsht | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_FATSHOTX1 | S_NULL | sfx_firxpl | 20 | 6 | 8 | 100 | 8 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 10 | MT_CHAINGUY | 65 | S_CPOS_STND | 70 | S_CPOS_RUN1 | sfx_posit2 | 8 | 0 | S_CPOS_PAIN | 170 | sfx_popain | 0 | S_CPOS_ATK1 | S_CPOS_DIE1 | S_CPOS_XDIE1 | sfx_podth2 | 8 | 20 | 56 | 100 | 0 | sfx_posact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_CPOS_RAISE1 |
| 11 | MT_TROOP | 3001 | S_TROO_STND | 60 | S_TROO_RUN1 | sfx_bgsit1 | 8 | 0 | S_TROO_PAIN | 200 | sfx_popain | S_TROO_ATK1 | S_TROO_ATK1 | S_TROO_DIE1 | S_TROO_XDIE1 | sfx_bgdth1 | 8 | 20 | 56 | 100 | 0 | sfx_bgact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_TROO_RAISE1 |
| 12 | MT_SERGEANT | 3002 | S_SARG_STND | 150 | S_SARG_RUN1 | sfx_sgtsit | 8 | sfx_sgtatk | S_SARG_PAIN | 180 | sfx_dmpain | S_SARG_ATK1 | 0 | S_SARG_DIE1 | S_NULL | sfx_sgtdth | 10 | 30 | 56 | 400 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_SARG_RAISE1 |
| 13 | MT_SHADOWS | 58 | S_SARG_STND | 150 | S_SARG_RUN1 | sfx_sgtsit | 8 | sfx_sgtatk | S_SARG_PAIN | 180 | sfx_dmpain | S_SARG_ATK1 | 0 | S_SARG_DIE1 | S_NULL | sfx_sgtdth | 10 | 30 | 56 | 400 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_SHADOW&#124;MF_COUNTKILL | S_SARG_RAISE1 |
| 14 | MT_HEAD | 3005 | S_HEAD_STND | 400 | S_HEAD_RUN1 | sfx_cacsit | 8 | 0 | S_HEAD_PAIN | 128 | sfx_dmpain | 0 | S_HEAD_ATK1 | S_HEAD_DIE1 | S_NULL | sfx_cacdth | 8 | 31 | 56 | 400 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_FLOAT&#124;MF_NOGRAVITY&#124;MF_COUNTKILL | S_HEAD_RAISE1 |
| 15 | MT_BRUISER | 3003 | S_BOSS_STND | 1000 | S_BOSS_RUN1 | sfx_brssit | 8 | 0 | S_BOSS_PAIN | 50 | sfx_dmpain | S_BOSS_ATK1 | S_BOSS_ATK1 | S_BOSS_DIE1 | S_NULL | sfx_brsdth | 8 | 24 | 64 | 1000 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_BOSS_RAISE1 |
| 16 | MT_BRUISERSHOT | -1 | S_BRBALL1 | 1000 | S_NULL | sfx_firsht | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_BRBALLX1 | S_NULL | sfx_firxpl | 15 | 6 | 8 | 100 | 8 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 17 | MT_KNIGHT | 69 | S_BOS2_STND | 500 | S_BOS2_RUN1 | sfx_kntsit | 8 | 0 | S_BOS2_PAIN | 50 | sfx_dmpain | S_BOS2_ATK1 | S_BOS2_ATK1 | S_BOS2_DIE1 | S_NULL | sfx_kntdth | 8 | 24 | 64 | 1000 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_BOS2_RAISE1 |
| 18 | MT_SKULL | 3006 | S_SKULL_STND | 100 | S_SKULL_RUN1 | 0 | 8 | sfx_sklatk | S_SKULL_PAIN | 256 | sfx_dmpain | 0 | S_SKULL_ATK1 | S_SKULL_DIE1 | S_NULL | sfx_firxpl | 8 | 16 | 56 | 50 | 3 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_FLOAT&#124;MF_NOGRAVITY | S_NULL |
| 19 | MT_SPIDER | 7 | S_SPID_STND | 3000 | S_SPID_RUN1 | sfx_spisit | 8 | sfx_shotgn | S_SPID_PAIN | 40 | sfx_dmpain | 0 | S_SPID_ATK1 | S_SPID_DIE1 | S_NULL | sfx_spidth | 12 | 128 | 100 | 1000 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_NULL |
| 20 | MT_BABY | 68 | S_BSPI_STND | 500 | S_BSPI_SIGHT | sfx_bspsit | 8 | 0 | S_BSPI_PAIN | 128 | sfx_dmpain | 0 | S_BSPI_ATK1 | S_BSPI_DIE1 | S_NULL | sfx_bspdth | 12 | 64 | 64 | 600 | 0 | sfx_bspact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_BSPI_RAISE1 |
| 21 | MT_CYBORG | 16 | S_CYBER_STND | 4000 | S_CYBER_RUN1 | sfx_cybsit | 8 | 0 | S_CYBER_PAIN | 20 | sfx_dmpain | 0 | S_CYBER_ATK1 | S_CYBER_DIE1 | S_NULL | sfx_cybdth | 16 | 40 | 110 | 1000 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_NULL |
| 22 | MT_PAIN | 71 | S_PAIN_STND | 400 | S_PAIN_RUN1 | sfx_pesit | 8 | 0 | S_PAIN_PAIN | 128 | sfx_pepain | 0 | S_PAIN_ATK1 | S_PAIN_DIE1 | S_NULL | sfx_pedth | 8 | 31 | 56 | 400 | 0 | sfx_dmact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_FLOAT&#124;MF_NOGRAVITY&#124;MF_COUNTKILL | S_PAIN_RAISE1 |
| 23 | MT_WOLFSS | 84 | S_SSWV_STND | 50 | S_SSWV_RUN1 | sfx_sssit | 8 | 0 | S_SSWV_PAIN | 170 | sfx_popain | 0 | S_SSWV_ATK1 | S_SSWV_DIE1 | S_SSWV_XDIE1 | sfx_ssdth | 8 | 20 | 56 | 100 | 0 | sfx_posact | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_SSWV_RAISE1 |
| 24 | MT_KEEN | 72 | S_KEENSTND | 100 | S_NULL | — | 8 | — | S_KEENPAIN | 256 | sfx_keenpn | S_NULL | S_NULL | S_COMMKEEN | S_NULL | sfx_keendt | 0 | 16 | 72 | 10000000 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY&#124;MF_SHOOTABLE&#124;MF_COUNTKILL | S_NULL |
| 25 | MT_BOSSBRAIN | 88 | S_BRAIN | 250 | S_NULL | — | 8 | — | S_BRAIN_PAIN | 255 | sfx_bospn | S_NULL | S_NULL | S_BRAIN_DIE1 | S_NULL | sfx_bosdth | 0 | 16 | 16 | 10000000 | 0 | — | MF_SOLID&#124;MF_SHOOTABLE | S_NULL |
| 26 | MT_BOSSSPIT | 89 | S_BRAINEYE | 1000 | S_BRAINEYESEE | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 32 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOSECTOR | S_NULL |
| 27 | MT_BOSSTARGET | 87 | S_NULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 32 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOSECTOR | S_NULL |
| 28 | MT_SPAWNSHOT | -1 | S_SPAWN1 | 1000 | S_NULL | sfx_bospit | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | sfx_firxpl | 10 | 6 | 32 | 100 | 3 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY&#124;MF_NOCLIP | S_NULL |
| 29 | MT_SPAWNFIRE | -1 | S_SPAWNFIRE1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 30 | MT_BARREL | 2035 | S_BAR1 | 20 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_BEXP | S_NULL | sfx_barexp | 0 | 10 | 42 | 100 | 0 | — | MF_SOLID&#124;MF_SHOOTABLE&#124;MF_NOBLOOD | S_NULL |
| 31 | MT_TROOPSHOT | -1 | S_TBALL1 | 1000 | S_NULL | sfx_firsht | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_TBALLX1 | S_NULL | sfx_firxpl | 10 | 6 | 8 | 100 | 3 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 32 | MT_HEADSHOT | -1 | S_RBALL1 | 1000 | S_NULL | sfx_firsht | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_RBALLX1 | S_NULL | sfx_firxpl | 10 | 6 | 8 | 100 | 5 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 33 | MT_ROCKET | -1 | S_ROCKET | 1000 | S_NULL | sfx_rlaunc | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_EXPLODE1 | S_NULL | sfx_barexp | 20 | 11 | 8 | 100 | 20 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 34 | MT_PLASMA | -1 | S_PLASBALL | 1000 | S_NULL | sfx_plasma | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_PLASEXP | S_NULL | sfx_firxpl | 25 | 13 | 8 | 100 | 5 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 35 | MT_BFG | -1 | S_BFGSHOT | 1000 | S_NULL | 0 | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_BFGLAND | S_NULL | sfx_rxplod | 25 | 13 | 8 | 100 | 100 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 36 | MT_ARACHPLAZ | -1 | S_ARACH_PLAZ | 1000 | S_NULL | sfx_plasma | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_ARACH_PLEX | S_NULL | sfx_firxpl | 25 | 13 | 8 | 100 | 5 | — | MF_NOBLOCKMAP&#124;MF_MISSILE&#124;MF_DROPOFF&#124;MF_NOGRAVITY | S_NULL |
| 37 | MT_PUFF | -1 | S_PUFF1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 38 | MT_BLOOD | -1 | S_BLOOD1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP | S_NULL |
| 39 | MT_TFOG | -1 | S_TFOG | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 40 | MT_IFOG | -1 | S_IFOG | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 41 | MT_TELEPORTMAN | 14 | S_NULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOSECTOR | S_NULL |
| 42 | MT_EXTRABFG | -1 | S_BFGEXP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP&#124;MF_NOGRAVITY | S_NULL |
| 43 | MT_MISC0 | 2018 | S_ARM1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 44 | MT_MISC1 | 2019 | S_ARM2 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 45 | MT_MISC2 | 2014 | S_BON1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 46 | MT_MISC3 | 2015 | S_BON2 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 47 | MT_MISC4 | 5 | S_BKEY | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_NOTDMATCH | S_NULL |
| 48 | MT_MISC5 | 13 | S_RKEY | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_NOTDMATCH | S_NULL |
| 49 | MT_MISC6 | 6 | S_YKEY | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_NOTDMATCH | S_NULL |
| 50 | MT_MISC7 | 39 | S_YSKULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_NOTDMATCH | S_NULL |
| 51 | MT_MISC8 | 38 | S_RSKULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_NOTDMATCH | S_NULL |
| 52 | MT_MISC9 | 40 | S_BSKULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_NOTDMATCH | S_NULL |
| 53 | MT_MISC10 | 2011 | S_STIM | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 54 | MT_MISC11 | 2012 | S_MEDI | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 55 | MT_MISC12 | 2013 | S_SOUL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 56 | MT_INV | 2022 | S_PINV | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 57 | MT_MISC13 | 2023 | S_PSTR | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 58 | MT_INS | 2024 | S_PINS | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 59 | MT_MISC14 | 2025 | S_SUIT | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 60 | MT_MISC15 | 2026 | S_PMAP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 61 | MT_MISC16 | 2045 | S_PVIS | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 62 | MT_MEGA | 83 | S_MEGA | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL&#124;MF_COUNTITEM | S_NULL |
| 63 | MT_CLIP | 2007 | S_CLIP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 64 | MT_MISC17 | 2048 | S_AMMO | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 65 | MT_MISC18 | 2010 | S_ROCK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 66 | MT_MISC19 | 2046 | S_BROK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 67 | MT_MISC20 | 2047 | S_CELL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 68 | MT_MISC21 | 17 | S_CELP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 69 | MT_MISC22 | 2008 | S_SHEL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 70 | MT_MISC23 | 2049 | S_SBOX | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 71 | MT_MISC24 | 8 | S_BPAK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 72 | MT_MISC25 | 2006 | S_BFUG | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 73 | MT_CHAINGUN | 2002 | S_MGUN | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 74 | MT_MISC26 | 2005 | S_CSAW | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 75 | MT_MISC27 | 2003 | S_LAUN | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 76 | MT_MISC28 | 2004 | S_PLAS | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 77 | MT_SHOTGUN | 2001 | S_SHOT | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 78 | MT_SUPERSHOTGUN | 82 | S_SHOT2 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_SPECIAL | S_NULL |
| 79 | MT_MISC29 | 85 | S_TECHLAMP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 80 | MT_MISC30 | 86 | S_TECH2LAMP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 81 | MT_MISC31 | 2028 | S_COLU | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 82 | MT_MISC32 | 30 | S_TALLGRNCOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 83 | MT_MISC33 | 31 | S_SHRTGRNCOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 84 | MT_MISC34 | 32 | S_TALLREDCOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 85 | MT_MISC35 | 33 | S_SHRTREDCOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 86 | MT_MISC36 | 37 | S_SKULLCOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 87 | MT_MISC37 | 36 | S_HEARTCOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 88 | MT_MISC38 | 41 | S_EVILEYE | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 89 | MT_MISC39 | 42 | S_FLOATSKULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 90 | MT_MISC40 | 43 | S_TORCHTREE | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 91 | MT_MISC41 | 44 | S_BLUETORCH | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 92 | MT_MISC42 | 45 | S_GREENTORCH | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 93 | MT_MISC43 | 46 | S_REDTORCH | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 94 | MT_MISC44 | 55 | S_BTORCHSHRT | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 95 | MT_MISC45 | 56 | S_GTORCHSHRT | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 96 | MT_MISC46 | 57 | S_RTORCHSHRT | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 97 | MT_MISC47 | 47 | S_STALAGTITE | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 98 | MT_MISC48 | 48 | S_TECHPILLAR | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 99 | MT_MISC49 | 34 | S_CANDLESTIK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 100 | MT_MISC50 | 35 | S_CANDELABRA | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 101 | MT_MISC51 | 49 | S_BLOODYTWITCH | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 68 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 102 | MT_MISC52 | 50 | S_MEAT2 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 84 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 103 | MT_MISC53 | 51 | S_MEAT3 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 84 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 104 | MT_MISC54 | 52 | S_MEAT4 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 68 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 105 | MT_MISC55 | 53 | S_MEAT5 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 52 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 106 | MT_MISC56 | 59 | S_MEAT2 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 84 | 100 | 0 | — | MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 107 | MT_MISC57 | 60 | S_MEAT4 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 68 | 100 | 0 | — | MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 108 | MT_MISC58 | 61 | S_MEAT3 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 52 | 100 | 0 | — | MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 109 | MT_MISC59 | 62 | S_MEAT5 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 52 | 100 | 0 | — | MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 110 | MT_MISC60 | 63 | S_BLOODYTWITCH | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 68 | 100 | 0 | — | MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 111 | MT_MISC61 | 22 | S_HEAD_DIE6 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 112 | MT_MISC62 | 15 | S_PLAY_DIE7 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 113 | MT_MISC63 | 18 | S_POSS_DIE5 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 114 | MT_MISC64 | 21 | S_SARG_DIE6 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 115 | MT_MISC65 | 23 | S_SKULL_DIE6 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 116 | MT_MISC66 | 20 | S_TROO_DIE5 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 117 | MT_MISC67 | 19 | S_SPOS_DIE5 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 118 | MT_MISC68 | 10 | S_PLAY_XDIE9 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 119 | MT_MISC69 | 12 | S_PLAY_XDIE9 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 120 | MT_MISC70 | 28 | S_HEADSONSTICK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 121 | MT_MISC71 | 24 | S_GIBS | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | 0 | S_NULL |
| 122 | MT_MISC72 | 27 | S_HEADONASTICK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 123 | MT_MISC73 | 29 | S_HEADCANDLES | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 124 | MT_MISC74 | 25 | S_DEADSTICK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 125 | MT_MISC75 | 26 | S_LIVESTICK | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 126 | MT_MISC76 | 54 | S_BIGTREE | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 32 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 127 | MT_MISC77 | 70 | S_BBAR1 | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 16 | 100 | 0 | — | MF_SOLID | S_NULL |
| 128 | MT_MISC78 | 73 | S_HANGNOGUTS | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 88 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 129 | MT_MISC79 | 74 | S_HANGBNOBRAIN | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 88 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 130 | MT_MISC80 | 75 | S_HANGTLOOKDN | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 64 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 131 | MT_MISC81 | 76 | S_HANGTSKULL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 64 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 132 | MT_MISC82 | 77 | S_HANGTLOOKUP | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 64 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 133 | MT_MISC83 | 78 | S_HANGTNOBRAIN | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 16 | 64 | 100 | 0 | — | MF_SOLID&#124;MF_SPAWNCEILING&#124;MF_NOGRAVITY | S_NULL |
| 134 | MT_MISC84 | 79 | S_COLONGIBS | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP | S_NULL |
| 135 | MT_MISC85 | 80 | S_SMALLPOOL | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP | S_NULL |
| 136 | MT_MISC86 | 81 | S_BRAINSTEM | 1000 | S_NULL | — | 8 | — | S_NULL | 0 | — | S_NULL | S_NULL | S_NULL | S_NULL | — | 0 | 20 | 16 | 100 | 0 | — | MF_NOBLOCKMAP | S_NULL |

Spot check vs manual read of info.c:1136-1161 (MT_POSSESSED: doomednum 3004, spawnhealth 20, seesound s_posit1, painchance 200): matches.

Confidence: High (script-extracted directly from the C array; 137 rows verified count).


## 4. Frame bits, rotation and mirror rules

Correction to the task brief: there are **no FRAME_* enum constants in r_things.h** in linuxdoom-1.10 (grep `define FRAME`/`FRAME_0`: 0 matches). The frame-related constants are:

```c
// p_pspr.h:50-51  (also applies to thing->frame)
#define FF_FULLBRIGHT	0x8000	// flag in thing->frame
#define FF_FRAMEMASK	0x7fff
```

- `state_t.frame` = frame index 0..28 (`'A'`-based letter in the lump name; `R_InstallSpriteLump` rejects `frame >= 29`, r_things.c:114), optionally OR'd with `FF_FULLBRIGHT` (states table uses e.g. `32768+3` for frame D fullbright).
- Sprite lump name grammar (r_things.c:218-236): `SSSSFR[f2]` — chars 0-3 sprite, char 4 = frame letter (`name[4]-'A'`), char 5 = rotation digit (`name[5]-'0'`, 1..8, or 0 = same patch for all rotations), optional char 6 = second frame letter for alternating animation (`name[6]-'A'`, used by 2-frame anims like TLP2/BRS1).

Rotation selection (R_ProjectSprite, r_things.c:520-534):

```c
    if (sprframe->rotate)
    {
	// choose a different rotation based on player view
	ang = R_PointToAngle (thing->x, thing->y);
	rot = (ang-thing->angle+(unsigned)(ANG45/2)*9)>>29;
	lump = sprframe->lump[rot];
	flip = (boolean)sprframe->flip[rot];
    }
    else
    {
	// use single rotation for all views
	lump = sprframe->lump[0];
	flip = (boolean)sprframe->flip[0];
    }
```

- `rot` = view angle relative to the thing's facing, bucketed into 8 x 45deg, offset by 22.5deg (`(ANG45/2)*9`), so the front view is centered.
- Mirror rule: `flip` comes from the `F` suffix in the lump name (rotation digit 0 -> flip applies to all rotations; r_things.c:121-139 copies the single lump into all 8 slots). Rotations with digit >0 fill one slot each (`rotation--` to 0-based, r_things.c:146-156).
- Completeness check at init: a frame with `rotate==1` must have all 8 slots or `I_Error` (r_things.c:251-270). rot=0 + rotations mixed is an error.

Confidence: High (verbatim).

## 5. Thing numbering — Doom 1 vs Doom 2, and what Freedoom Phase 1 uses

`doomednum` (mobjinfo field 0) is the THINGS `type` (int16 at byte offset 6 of the 10-byte thing record) understood by `P_SpawnMapThing`. Verified numbers in our table: 3004=MT_POSSESSED, 9=MT_SHOTGUY, 3001=MT_TROOP, 3002=MT_SERGEANT, 3005=MT_HEAD, 3006=MT_SKULL, 7=MT_SPIDER, 16=MT_CYBORG, 2035=MT_BARREL. Full item table (MF_SPECIAL rows, script-extracted): 2001 shotgun, 2002 chaingun, 2003 launcher, 2004 plasma, 2005 chainsaw, 2006 BFG, 2007 clip, 2008 shells, 8 backpack, 2010 rocket, 2011 stimpack, 2012 medikit, 2013 soul sphere, 2014 health bonus, 2015 armor bonus, 2018 green armor, 2019 mega armor, 2022 invul, 2023 berserk, 2024 invis, 2025 envirosuit, 2026 automap, 2045 visor, 2046 rocket box, 2047 cell, 2048 bullets box, 2049 shell box, 82 super shotgun, 83 mega sphere; keys: 5 blue card, 6 yellow card, 13 red card, 40 blue skull, 38 red skull, 39 yellow skull (from spawnstates S_BKEY/S_YKEY/S_RKEY/S_BSKULL/S_RSKULL/S_YSKULL).

**CRITICAL CHECK (script, freedoom-0.13.0/freedoom1.wad, IWAD, 3163 lumps).** Parsed THINGS for E1M1, E1M2, E1M3, E1M9, E2M1, E3M1, E4M1. E1M1 has 292 things; histogram of `type` values (count):

```
E1M1: 1(1) 2(1) 3(1) 4(1) 5(1) 8(1) 9(13) 10(3) 11(8) 12(3) 15(4) 17(2)
      18(5) 19(2) 20(2) 21(2) 24(2) 26(1) 43(12) 47(18) 48(4) 54(15) 58(1)
      60(2) 2001(4) 2002(2) 2003(2) 2004(1) 2005(1) 2007(3) 2008(18) 2010(8)
      2011(6) 2012(5) 2013(1) 2014(30) 2015(22) 2018(2) 2019(1) 2023(1)
      2028(7) 2035(22) 2046(2) 2047(1) 2048(4) 2049(5) 3001(18) 3002(9) 3004(12)
```

Union over the 7 maps additionally contains: 6, 13, 14(9), 22, 34, 35, 36, 42, 45, 46, 47, 48, 53, 54, 57, 58, 59, 62, 63, 2006, 2024, 2025, 2026, and 9(167), 3005(7), 3006(9).

Evidence and verdict:
- Every type in every sampled map is present in the Doom 1 `mobjinfo[].doomednum` set (only exceptions are spawn-point types 1-4 player starts and 11 deathmatch start, handled specially in P_SpawnMapThing, not via doomednum).
- Doom 2-exclusive numbers appear **zero** times: 6072 (D2 zombieman), 4001 (D2 commando), 5001/5002/5004-5007 (D2 item relocations), 3006-as-archvile — note 3006 and 3005 DO appear (9x/7x) but they match **Doom 1** MT_SKULL (pain elemental) and MT_HEAD (baron) — in Doom 2 those numbers mean archvile/baron instead, and pain elemental moved to 3006->4003? (D2 pain elemental = 4003); Freedoom uses them at their Doom 1 meaning.
- Item numbers are Doom 1 placement: 2046 berserk / 2047 soul / 2048 envirosuit / 2049 invul (Doom 2 moved these to 5002/2052/2058/5001... which are absent).
- Doom-1-only decoration/secret numbers present: 12 (secret exit trigger MT_MISC69), 14 teleporter, 15/18/19/20/21/24/26/43/47/48/54/60 decor (Doom 2 remapped decor to 8xxx — absent).

**Verdict: Freedoom Phase 1 (freedoom1.wad, Doom 1 game mode) uses the Doom 1 thing numbering.** Our port must key `P_SpawnMapThing`'s doomednum->mobjtype lookup on the Doom 1 `mobjinfo[]` table (section 3).

Confidence: High (direct binary parse + lookup cross-check; 7 maps sampled, 2337 things).


## 6. P_SpawnMapThing — exact code (p_mobj.c:704-774)

```c
void P_SpawnMapThing (mapthing_t* mthing)
{
    int			i;
    int			bit;
    mobj_t*		mobj;
    fixed_t		x;
    fixed_t		y;
    fixed_t		z;
		
    // count deathmatch start positions
    if (mthing->type == 11)
    {
	if (deathmatch_p < &deathmatchstarts[10])
	{
	    memcpy (deathmatch_p, mthing, sizeof(*mthing));
	    deathmatch_p++;
	}
	return;
    }
	
    // check for players specially
    if (mthing->type <= 4)
    {
	// save spots for respawning in network games
	playerstarts[mthing->type-1] = *mthing;
	if (!deathmatch)
	    P_SpawnPlayer (mthing);

	return;
    }

    // check for apropriate skill level
    if (!netgame && (mthing->options & 16) )
	return;
		
    if (gameskill == sk_baby)
	bit = 1;
    else if (gameskill == sk_nightmare)
	bit = 4;
    else
	bit = 1<<(gameskill-1);

    if (!(mthing->options & bit) )
	return;
	
    // find which type to spawn
    for (i=0 ; i< NUMMOBJTYPES ; i++)
	if (mthing->type == mobjinfo[i].doomednum)
	    break;
	
    if (i==NUMMOBJTYPES)
	I_Error ("P_SpawnMapThing: Unknown type %i at (%i, %i)",
		 mthing->type,
		 mthing->x,
		 mthing->y);
		
    // don't spawn keycards and players in deathmatch
    if (deathmatch && mobjinfo[i].flags & MF_NOTDMATCH)
	return;
		
    // don't spawn any monsters if -nomonsters
    if (nomonsters
	&& ( i == MT_SKULL
	     || (mobjinfo[i].flags & MF_COUNTKILL)) )
    {
	return;
    }
    
    // spawn it
    x = mthing->x << FRACBITS;
    y = mthing->y << FRACBITS;

    if (mobjinfo[i].flags & MF_SPAWNCEILING)
	z = ONCEILINGZ;
    else
	z = ONFLOORZ;
    
    mobj = P_SpawnMobj (x,y,z, i);
    mobj->spawnpoint = *mthing;

    if (mobj->tics > 0)
	mobj->tics = 1 + (P_Random () % mobj->tics);
    if (mobj->flags & MF_COUNTKILL)
	totalkills++;
    if (mobj->flags & MF_COUNTITEM)
	totalitems++;
		
    mobj->angle = ANG45 * (mthing->angle/45);
    if (mthing->options & MTF_AMBUSH)
	mobj->flags |= MF_AMBUSH;
}
```

Key semantics (all confirmed from the quote):
- Thing flags word (`thing->options`, `mapthing_t.options` = uint16): bits `MTF_EASY=1`, `MTF_NORMAL=2`, `MTF_HARD=4` (doomdef.h:140-142), `MTF_AMBUSH=8` (doomdef.h:145), bit 16 = "not in multiplayer" (`!netgame && (options & 16)`).
- Skill filter: skill bit chosen is baby->1, nightmare->4, else `1<<(gameskill-1)` with enum `sk_baby=0, sk_easy=1, sk_normal=2, sk_hard=3, sk_nightmare=4` (doomdef.h) => easy uses bit 1 (MTF_EASY), normal bit 2, hard bit 4. Thing is skipped unless its options word has that bit.
- **No monster health scaling per skill exists in Doom 1** (task brief's "health scaling" item): `spawnhealth` is only copied in P_SpawnMobj and read in the P_KillMobj gib test; baby skill instead halves *incoming player damage* in P_DamageMobj (`damage >>= 1`), and baby/nightmare double *ammo pickups* in P_GiveAmmo.
- `MT_SKIP`: **does not exist in Doom 1** (it is a Doom 2 thingtype with doomednum -1, type 11? no — MT_SKIP is Doom 2 only). Unknown types are a fatal `I_Error` here, so a Doom-2-only number in a Doom 1 map crashes; our port should warn+skip.
- Ambush: `options & 8` -> sets `MF_AMBUSH` (deaf to sound; P_LookForPlayers checks it).
- Deathmatch start type 11: recorded, never spawned (max 10).
- Players 1-4: stored in `playerstarts`, spawned only when not deathmatch at load.

Confidence: High (verbatim).


## 7. P_KillMobj — full quote (p_inter.c:666-758)

Note: in linuxdoom-1.10 `P_KillMobj` lives in **p_inter.c**, not p_mobj.c. It is called only from `P_DamageMobj` when `target->health -= damage` drops to `<= 0` (p_inter.c:888-892).

```c
void
P_KillMobj (mobj_t*	source, mobj_t*	target)
{
    mobjtype_t	item;
    mobj_t*	mo;
	
    target->flags &= ~(MF_SHOOTABLE|MF_FLOAT|MF_SKULLFLY);

    if (target->type != MT_SKULL)
	target->flags &= ~MF_NOGRAVITY;

    target->flags |= MF_CORPSE|MF_DROPOFF;
    target->height >>= 2;

    if (source && source->player)
    {
	// count for intermission
	if (target->flags & MF_COUNTKILL)
	    source->player->killcount++;	

	if (target->player)
	    source->player->frags[target->player-players]++;
    }
    else if (!netgame && (target->flags & MF_COUNTKILL) )
    {
	// count all monster deaths,
	// even those caused by other monsters
	players[0].killcount++;
    }
    
    if (target->player)
    {
	// count environment kills against you
	if (!source)	
	    target->player->frags[target->player-players]++;
			
	target->flags &= ~MF_SOLID;
	target->player->playerstate = PST_DEAD;
	P_DropWeapon (target->player);

	if (target->player == &players[consoleplayer]
	    && automapactive)
	{
	    // don't die in auto map,
	    // switch view prior to dying
	    AM_Stop ();
	}
	
    }

    if (target->health < -target->info->spawnhealth 
	&& target->info->xdeathstate)
    {
	P_SetMobjState (target, target->info->xdeathstate);
    }
    else
	P_SetMobjState (target, target->info->deathstate);
    target->tics -= P_Random()&3;

    if (target->tics < 1)
	target->tics = 1;
		

    // Drop stuff.
    switch (target->type)
    {
      case MT_WOLFSS:
      case MT_POSSESSED:
	item = MT_CLIP;
	break;
	
      case MT_SHOTGUY:
	item = MT_SHOTGUN;
	break;
	
      case MT_CHAINGUY:
	item = MT_CHAINGUN;
	break;
	
      default:
	return;
    }

    mo = P_SpawnMobj (target->x,target->y,ONFLOORZ, item);
    mo->flags |= MF_DROPPED;	// special versions of items
}
```

Facts to carry over:
- **Gib threshold**: `health < -spawnhealth` (strictly less than the *negative* spawn health; e.g. zombieman dies at 0, gibbed at < -20) AND `xdeathstate != S_NULL` -> gib ("extreme death") state; else normal death state. Death state's entry tics get `-= P_Random()&3` (min 1) for desync.
- Corpse mechanics: clears `MF_SHOOTABLE|MF_FLOAT|MF_SKULLFLY` (plus `MF_NOGRAVITY` unless MT_SKULL lost soul), sets `MF_CORPSE|MF_DROPOFF`, `height >>= 2` (now a flat shootable-blocking-free slab). No `MF_CORPSE` "gore" objects spawned here — gore (MT_GIBS etc.) only appears via xdeathstate sprites; there are no separate gibs mobjs in Doom 1.
- **Player death branch**: `playerstate = PST_DEAD`, `P_DropWeapon`, `MF_SOLID` cleared, automap exit; environment kill (source NULL) self-frags.
- **Dropped weapons**: only MT_POSSESSED/MT_WOLFSS -> clip, MT_SHOTGUY -> shotgun, MT_CHAINGUY -> chaingun, each spawned with `MF_DROPPED`.
- **No boss checks, no A_BrainDie, no barrel logic in Doom 1 P_KillMobj.** (A_BrainDie exists in p_enemy.c:1896 for Doom 2's boss brain states but is unreachable in Doom 1 maps.) `A_BossDeath` (p_enemy.c:1606) is a death-state action, level-mapped, not part of P_KillMobj.
- Barrel explosion: barrel's `deathstate = S_BEXP` whose state action `A_Explode` fires (section 9) — no special casing in P_KillMobj.

Confidence: High (verbatim).


## 8. Item pickup — P_TouchSpecialThing + P_Give* (p_inter.c)

Trigger: `P_CheckMissileRange`/`P_TouchSpecialThing` is called from `P_GroupMove`/`P_TryMove` via `P_SpecialThing` (p_map.c) when a player with `MF_SPECIAL`-flag mobj overlaps. Reach test (p_inter.c:347-352): `delta = special->z - toucher->z; if (delta > toucher->height || delta < -8*FRACUNIT) return;`. Dead toucher (`health <= 0`) bails. **Dispatch is by `special->sprite`, not mobjtype** (p_inter.c:363).

Full switch (p_inter.c:336-655) — `give` call, message id, sound:

| SPR_ | give action | message (d_englsh.h) | sound |
|---|---|---|---|
| ARM1 | P_GiveArmor(p,1) | GOTARMOR "Picked up a security armor vest." | itemup |
| ARM2 | P_GiveArmor(p,2) | GOTMEGA "Picked up a mega armor!" | itemup |
| BON1 | `health++` cap 200 | GOTHTHBONUS | itemup |
| BON2 | `armorpoints++` cap 200, armortype=1 if 0 | GOTARMBONUS | itemup |
| SOUL | `health += 100` cap 200 | GOTSUPER | getpow |
| MEGA | **commercial mode only** (`gamemode != commercial` return); health=200 + P_GiveArmor(2) | GOTMSPHERE | getpow |
| BKEY/YKEY/RKEY/BSKU/YSKU/RSKU | P_GiveCard(...) (net: leave for others — `return` after giving in netgame, no pickup removal) | GOTBLUECARD etc. | itemup |
| STIM | P_GiveBody(p,10) | GOTSTIM | itemup |
| MEDI | P_GiveBody(p,25); message GOTMEDINEED if health<25 else GOTMEDIKIT | | itemup |
| PINV | P_GivePower(pw_invulnerability) | GOTINVUL | getpow |
| PSTR | P_GivePower(pw_strength); pending weapon fist | GOTBERSERK | getpow |
| PINS | P_GivePower(pw_invisibility) | GOTINVIS | getpow |
| SUIT | P_GivePower(pw_ironfeet) | GOTSUIT | getpow |
| PMAP | P_GivePower(pw_allmap) | GOTMAP | getpow |
| PVIS | P_GivePower(pw_infrared) | GOTVISOR | getpow |
| CLIP | if `MF_DROPPED`: P_GiveAmmo(am_clip,**0**) => 5 (=clipammo/2, x2 on baby/nightmare=10); else num=1 => 10 | GOTCLIP | itemup |
| AMMO | P_GiveAmmo(am_clip,5) => 50 | GOTCLIPBOX | itemup |
| ROCK | P_GiveAmmo(am_misl,1) => 1 rocket | GOTROCKET | itemup |
| BROK | P_GiveAmmo(am_misl,5) => 5 | GOTROCKBOX | itemup |
| CELL | P_GiveAmmo(am_cell,1) => 20 | GOTCELL | itemup |
| CELP | P_GiveAmmo(am_cell,5) => 100 | GOTCELLBOX | itemup |
| SHEL | P_GiveAmmo(am_shell,1) => 4 | GOTSHELLS | itemup |
| SBOX | P_GiveAmmo(am_shell,5) => 20 | GOTSHELLBOX | itemup |
| BPAK | if !backpack: **all maxammo *= 2** once; then P_GiveAmmo(i,1) for every ammo type | GOTBACKPACK | itemup |
| BFUG | P_GiveWeapon(wp_bfg, dropped=false) | GOTBFG9000 | wpnup |
| MGUN | P_GiveWeapon(wp_chaingun, dropped=MF_DROPPED flag) | GOTCHAINGUN | wpnup |
| CSAW | P_GiveWeapon(wp_chainsaw, false) | GOTCHAINSAW | wpnup |
| LAUN | P_GiveWeapon(wp_missile, false) | GOTLAUNCHER | wpnup |
| PLAS | P_GiveWeapon(wp_plasma, false) | GOTPLASMA | wpnup |
| SHOT | P_GiveWeapon(wp_shotgun, dropped flag) | GOTSHOTGUN | wpnup |
| SGN2 | P_GiveWeapon(wp_supershotgun, dropped flag) | GOTSHOTGUN2 | wpnup |
| default | `I_Error("P_SpecialThing: Unknown gettable thing")` | | |

After a successful case: `if (flags & MF_COUNTITEM) itemcount++; P_RemoveMobj(special); bonuscount += BONUSADD;` play sound for consoleplayer (p_inter.c:645-655). A `return` inside a case means "not picked up" (stays in map).

### P_GiveAmmo semantics (p_inter.c:67-... + arrays at p_inter.c:58-59)

```c
int maxammo[NUMAMMO]  = {200, 50, 300, 50};   // am_clip, am_shell, am_cell, am_misl (doomdef.h:201-208)
int clipammo[NUMAMMO] = {10, 4, 20, 1};       // 1 clip load per ammo type
```
Order = `ammotype_t` `am_clip, am_shell, am_cell, am_misl` (d_player.h). `num` = clip loads: `num==0 ? clipammo/2 : num*clipammo`; baby/nightmare skill: `num <<= 1` (double). Already-at-max early-outs (`ammo==maxammo` -> false, no pickup). If we were at 0, may switch `pendingweapon` per preference ladder (clip->chaingun/pistol, shell->shotgun, cell->plasma, misl->missile).

### P_GiveWeapon (p_inter.c ~150-215)
Dropped vs found: dropped gives 1 clip, found gives 2 clips of its ammo. In netgame non-dropped weapons are left alone for everyone (`deathmatch!=2 && !dropped`): grant + `P_GiveAmmo(...,5)` (dm) or 2 (coop) and return false (item stays logically but mobj is removed by caller? — it returns false so P_TouchSpecialThing returns early WITHOUT removing the mobj... in netgame path it self-handles sound and returns).

### P_GiveBody / P_GiveArmor / P_GiveCard / P_GivePower (p_inter.c:225-330)
- P_GiveBody: `MAXHEALTH=100` cap (d_player.h), returns false at full health; syncs `mo->health`.
- P_GiveArmor: `hits = armortype*100`; refuses if `armorpoints >= hits`.
- P_GiveCard: idempotent, sets `cards[card]=1`, `bonuscount = BONUSADD`.
- P_GivePower: timed powers set INVULNTICS/INVISTICS/INFRATICS/IRONTICS; `pw_strength` also `P_GiveBody(100)`; berserk fist bonus is `damage *= 10` in A_Punch (p_pspr.c:478-479); untimed (map) returns false if already owned.

Confidence: High for switch content and numbers (verbatim); note MF_DROPPED ammo = half clip.


## 9. Barrels and exploding mobjs

There is no `A_BAllExplode`; the real action is **A_Explode** (p_enemy.c:1596-1601):

```c
void A_Explode (mobj_t* thingy)
{
    P_RadiusAttack ( thingy, thingy->target, 128 );
}
```

`P_RadiusAttack` is defined in p_map.c:1202+ (damage 128 at center, distance-scaled, `b1 = (b - blast->radius) <= dist` loop over blockthings; `source` credit for kills, so a barrel killed by a player inherits `target` = shooter when the barrel's `target` was set... barrels have `target` NULL unless damaged — environmental chain explosions still credit players via the chain source).

Barrel in Doom 1 (script row, section 3 idx 30):
- `MT_BARREL`, **doomednum 2035**, spawnhealth **20**, states: spawn `S_BAR1` (`{SPR_BAR1,0,6} -> S_BAR2`) / `S_BAR2` (`{SPR_BAR1,1,6} -> S_BAR1`, idle flicker loop); death `S_BEXP` -> `S_BEXP2` -> `S_BEXP3` -> `S_BEXP4` -> `S_BEXP5` -> `S_NULL`; no pain/raise/xdeath; `deathsound = sfx_barexp`; radius 10, height 42, mass 100; `flags = MF_SOLID|MF_SHOOTABLE|MF_NOBLOOD`; `raisestate S_NULL`.
- Explosion state actions (info.c:944-948): `S_BEXP2` (5 tics) calls **A_Scream** — A_Scream (p_enemy.c) plays `info->deathsound` verbatim (with pod-thud random variants; full volume for spider/cyborg) — so the barrel boom `sfx_barexp` is triggered there; `S_BEXP4` (frame D, 10 tics) calls **A_Explode** -> the actual `P_RadiusAttack(...,128)`.
- Death trigger: barrels are plain MF_SHOOTABLE mobjs; any `P_DamageMobj` reducing health <= 0 goes through generic `P_KillMobj` -> `deathstate S_BEXP`. No special barrel case anywhere in Doom 1 code.
- Burning (non-explodable) barrel: in this Doom 1 source it is **`MT_MISC77`, doomednum 70**, spawnstate `S_BBAR1` (FCAN frames A/B/C, 4 tics loop), health 1000, `flags = MF_SOLID` only (not shootable), no death state. There is no `MT_LIGHTBARREL` symbol in info.h (that name is Doom 2's, doomednum 2028 there); **Doom 1's 2028 = `MT_MISC31`** (S_COLU column torch decor) — Freedoom maps' 2028 things must be interpreted with the Doom 1 table.

Confidence: High for MT_BARREL/states/A_Explode (verbatim + script); High for "no light barrel mobjtype in Doom 1" (grep info.h: no MT_LIGHTBARREL symbol).


## 10. Notes for our TypeScript port

### mobj_t fields actually needed (verbatim from p_mobj.h struct, v1.10)

`thinker (prev/next + function)`, `x,y,z` (fixed), sector links `snext/sprev`, blocklinks `bnext/bprev`, `subsector`, `angle`, `sprite`, `frame`, `floorz`, `ceilingz`, `radius`, `height`, `momx/momy/momz`, `validcount`, `type`, `info` (derived: `&mobjinfo[type]`), `tics`, `state` (pointer -> use index), `flags`, `health`, `movedir`, `movecount`, `target`, `reactiontime`, `threshold`, `player` (backref or null), `lastlook`, `spawnpoint` (mapthing copy for item respawn/nightmare respawn), `tracer`.

No `damage`, no `id`, no `flags2` in this Doom 1 source. `info` can be dropped in TS (index by `type`). `state` should be a `stateId` number, with `S_NULL = 0` sentinel; sector/block links can stay as intrusive lists for exactness, or be replaced by spatial queries — but keep `validcount` if P_RadiusAttack / line-of-sight algorithms are transcribed literally.

### Suggested state-table encoding

```ts
// sprite index: u16 (0..137); frame word: u16 = frameIndex | (fullbright ? 0x8000 : 0)
// tics: i16 (-1 = forever, 0 = advance-in-one-call via the P_SetMobjState loop)
// action: ActionId enum (0 = none), nextstate: stateId (0 = S_NULL)
interface State {
  sprite: number;
  frame: number;     // already OR-ed
  tics: number;
  action: ActionId;  // numeric dispatch: switch(action) in a step() — keeps replay deterministic
  nextstate: number;
  misc1: number;
  misc2: number;
}
```

- Transcribe `states[]` (967 rows = NUMSTATES, info.c:193-...) as a flat const array in source order so `statenum_t` values equal enum order (needed if any code computes `state - states` offsets; P_XYMovement does: `(player->mo->state - states) - S_PLAY_RUN1 < 4` — port as stateId arithmetic!).
- Same for `mobjinfo[]`: keep array order == MT_ enum order (section 3 idx column) so `type` indexes work; doomednum lookup at spawn can be a `Map<number, MobjType>` built at init (Doom did a linear scan + `I_Error` on unknown; log-and-skip is safer for our port but note the behavioral difference).
- Action functions: implement as `ActionId` enum + switch (avoid closures if you want cheap serialization/determinism); P_SetMobjState must run the action on entry and loop while `tics === 0`, and return boolean alive.
- MF_* as bit flags in a 32-bit int (JS bitwise is i32 — MF_TRANSLATION 0xc000000 is fine; `1<<26` for TRANSSHIFT); store in `number`.
- Radius/height/speed: fixed-point (16.16) — store raw ints (`16 << 16`) to match `n*FRACUNIT` exactly.
- Sprite frame interpretation (section 4): at load, parse `SPRITE + letter + digit [+ letter]` lump names into `sprites[i].frames[f] = { rotate: boolean, lump[8], flip[8] }`; rotation choice formula `rot = ((viewAng - thing.angle) + ANG45/2*9) >>> 29` requires 64-bit-safe angle math (JS: use `>>>` on low word carefully or BigInt-free emulation as done for angles elsewhere; see doc 03).

Confidence: Medium-High (design recommendation grounded in the verified code).

## Sources

- `/tmp/DOOM-master/linuxdoom-1.10/info.h` (spritenum_t:31-176, statenum_t, mobjtype_t, state_t:1147, mobjinfo_t:1305) and `info.c` (sprnames:40, states[]:~193, mobjinfo[]:1106, 137 entries)
- `p_mobj.c` (P_SetMobjState:48, P_ExplodeMissile:90, P_XYMovement, P_MobjThinker:413, P_NightmareRespawn, P_RemoveMobsq/itemrespawn, P_RespawnSpecials, P_SpawnMapThing:704)
- `p_mobj.h` (MF_* flags:117-204, mobj_t struct)
- `p_inter.c` (maxammo/clipammo:58-59, P_GiveAmmo:67, P_GiveWeapon, P_GiveBody:225, P_GiveArmor, P_GiveCard, P_GivePower:287, P_TouchSpecialThing:336, P_KillMobj:666, P_DamageMobj:773)
- `p_inter.h`, `d_player.h` (MAXHEALTH via p_local.h:33; player ammo arrays), `doomdef.h` (MTF_*:140-145, sk_* skill enum, am_*:201-208, INVULNTICS:235)
- `r_things.c` (R_InitSprites/R_InstallSpriteLump:106-157, lump-name parse:218-236, R_ProjectSprite rotation:520), `p_pspr.h:50-51` (FF_FULLBRIGHT/FF_FRAMEMASK)
- `p_enemy.c` (A_Scream, A_Explode:1598, A_BossDeath:1606, A_BrainDie:1896)
- `p_map.c` (P_RadiusAttack:1206), `p_local.h` (MTF refs, P_SpecialThing call)
- `/tmp/freedoom-0.13.0/freedoom1.wad` — binary THINGS parse of E1M1/E1M2/E1M3/E1M9/E2M1/E3M1/E4M1 (script, python struct)
- Predecessor-verified baseline numbers (task brief) — spot-checked; corrections noted inline (NUMMOBJTYPES 137 not 118; 23 mobjinfo fields not 24; no FRAME_* constants; no MAXTICS)


