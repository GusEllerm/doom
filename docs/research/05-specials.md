# R05 — Line & Sector Specials (id linuxdoom-1.10)

All facts below were verified against raw id GPL source (linuxdoom-1.10) fetched on this session:
`p_spec.c/h`, `p_switch.c`, `p_plats.c`, `p_doors.c`, `p_ceilng.c` (note: spelled `p_ceilng.c`, not `p_ceiling.c`),
`p_floor.c`, `p_lights.c`, `p_telept.c`, `p_map.c`, `p_setup.c`, `g_game.c`, `doomdef.h`, `d_englsh.h`, `dstrings.h`, `p_user.c`, `p_inter.c`, `info.c`.

**Key structural fact:** 1.10 has **no special-number data table** (no `specials[]` array, no W1/WR/S1/SR/G1/GR class field).
Every special is a hardcoded `case` inside one of three dispatch functions:
`P_UseSpecialLine` (p_switch.c), `P_CrossSpecialLine` (p_spec.c), `P_ShootSpecialLine` (p_spec.c).
The classic "class" names below are *our reconstruction* from observed behavior (clearing of `line->special`, use vs cross).
There is also **no `P_FindSectorsOnSides`/tag==0 fallback** in 1.10 — all tagged effects use `P_FindSectorFromLineTag`
(p_spec.c) which scans `sectors[i].tag == line->tag` only. Tagless effects (manual doors `EV_VerticalDoor`, switch
texture swaps) act on the line's own sides directly.

Dispatch call sites (p_map.c):
- Cross: `P_TryMove` — after move, for each `spechit` line, if `side != oldside` → `P_CrossSpecialLine(ld-lines, oldside, thing)` (only if `!(flags & (MF_TELEPORT|MF_NOCLIP))`).
- Use: `PTR_UseTraverse` → `P_UseSpecialLine(usething, line, side)`; "can't use for more than one special line in a row" (`return false`).
- Shoot: `P_LineAttack` traverse → `if (li->special) P_ShootSpecialLine(shootthing, li);`

---

## 1. Trigger class semantics

### 1.1 Cross triggers ("W" = one-shot, "R" = retriggerable)

`P_CrossSpecialLine(int linenum, int side, mobj_t* thing)` — p_spec.c:

```c
// Things that should NOT trigger specials... (p_spec.c)
case MT_ROCKET: case MT_PLASMA: case MT_BFG:
case MT_TROOPSHOT: case MT_HEADSHOT: case MT_BRUISERSHOT: return;
// Non-player things may ONLY activate: 39, 97, 125, 126 (teleports),
// 4 (RAISE DOOR), 10 & 88 (PLAT DOWN-WAIT-UP-STAY); else return.
```

One-shot ("W1") = the case body ends with `line->special = 0;`. Retrigger ("WR") = no clear.
**Exception:** case 52 (exit) and 124 (secret exit) do NOT clear `line->special` (level changes anyway).
Crossed from either side (side passed = `oldside`); teleports only fire when `side == 0` (see §9).

### 1.2 Use triggers (S1/SR + manual doors)

`P_UseSpecialLine(mobj_t* thing, line_t* line, int side)` — p_switch.c:

```c
if (side) { switch(line->special) { case 124: break; default: return false; } }
if (!thing->player) {
    if (line->flags & ML_SECRET) return false;   // never open secret doors
    switch (line->special) {
      case 1: case 32: case 33: case 34: break;  // monsters may use these
      default: return false;
    }
}
```

- `S1` = switch case calls `P_ChangeSwitchTexture(line, 0)` → inside: `if (!useAgain) line->special = 0;`
  Important: for most S1s the swap happens **only if the action returned true** (`if (EV_DoX(...)) P_ChangeSwitchTexture(line,0);`) — a failed action (e.g. target already moving) leaves the switch armed.
- `SR` = `P_ChangeSwitchTexture(line, 1)` → special never cleared; the button texture reverts after `BUTTONTIME`.
- Manual door cases (1, 26–28, 31–34, 117, 118) call `EV_VerticalDoor(line, thing)` and never touch `line->special`, EXCEPT "open"-type doors: in `EV_VerticalDoor`, `case 31/32/33/34/118: door->type = open; line->special = 0;` (open-once doors lose their special).

### 1.3 Shoot triggers

`P_ShootSpecialLine(mobj_t* thing, line_t* line)` — p_spec.c. Non-player shooters only for special 46.

```c
case 24: EV_DoFloor(line,raiseFloor);        P_ChangeSwitchTexture(line,0); break; // one-shot
case 46: EV_DoDoor(line,open);               P_ChangeSwitchTexture(line,1); break; // stays armed (button anim)
case 47: EV_DoPlat(line,raiseToNearestAndChange,0); P_ChangeSwitchTexture(line,0); break;
```

Confidence: High (all direct code reads).

---

## 2. Complete Doom 1 special table (transcribed from the switch statements)

### 2.1 Use-side specials (p_switch.c `P_UseSpecialLine`)

| # | Class | Action | Notes |
|---|-------|--------|-------|
| 1 | door (reusable) | `EV_VerticalDoor(line, thing)` | Manual raise/lower door; no tag |
| 7 | S1 | `EV_BuildStairs(line,build8)` | |
| 9 | S1 | `EV_DoDonut(line)` | |
| 11 | S1 | `P_ChangeSwitchTexture(line,0); G_ExitLevel()` | exit-switch sound quirk, §12 |
| 14 / 15 | S1 | `EV_DoPlat(line,raiseAndChange,32 or 24)` | raise 32 / 24 units |
| 18 | S1 | `EV_DoFloor(line,raiseFloorToNearest)` | |
| 20 | S1 | `EV_DoPlat(line,raiseToNearestAndChange,0)` | |
| 21 | S1 | `EV_DoPlat(line,downWaitUpStay,0)` | lift |
| 23 | S1 | `EV_DoFloor(line,lowerFloorToLowest)` | |
| 26 / 27 / 28 | door locked blue/yellow/red (reusable) | `EV_VerticalDoor` | |
| 29 | S1 | `EV_DoDoor(line,normal)` | |
| 31 / 32 / 33 / 34 | door open plain/blue/red/yellow | `EV_VerticalDoor` | type `open`; special cleared; 32–34 monster-usable |
| 41 | S1 | `EV_DoCeiling(line,lowerToFloor)` | |
| 42 | SR | `EV_DoDoor(line,close)` | |
| 43 | SR | `EV_DoCeiling(line,lowerToFloor)` | |
| 45 | SR | `EV_DoFloor(line,lowerFloor)` | |
| 49 | S1 | `EV_DoCeiling(line,crushAndRaise)` | |
| 50 | S1 | `EV_DoDoor(line,close)` | |
| 51 | S1 | `P_ChangeSwitchTexture(line,0); G_SecretExitLevel()` | see §10 |
| 55 | S1 | `EV_DoFloor(line,raiseFloorCrush)` | |
| 60 | SR | `EV_DoFloor(line,lowerFloorToLowest)` | |
| 61 | SR | `EV_DoDoor(line,open)` | |
| 62 | SR | `EV_DoPlat(line,downWaitUpStay,1)` | |
| 63 | SR | `EV_DoDoor(line,normal)` | |
| 64 | SR | `EV_DoFloor(line,raiseFloor)` | |
| 65 | SR | `EV_DoFloor(line,raiseFloorCrush)` | |
| 66 / 67 | SR | `EV_DoPlat(line,raiseAndChange,24 or 32)` | |
| 68 | SR | `EV_DoPlat(line,raiseToNearestAndChange,0)` | |
| 69 | SR | `EV_DoFloor(line,raiseFloorToNearest)` | |
| 70 | SR | `EV_DoFloor(line,turboLower)` | |
| 71 | S1 | `EV_DoFloor(line,turboLower)` | |
| 101 | S1 | `EV_DoFloor(line,raiseFloor)` | |
| 102 | S1 | `EV_DoFloor(line,lowerFloor)` | |
| 103 | S1 | `EV_DoDoor(line,open)` | |
| 111 / 112 / 113 | S1 | `EV_DoDoor(line, blazeRaise / blazeOpen / blazeClose)` | blazing door raise/open/close |
| 114 / 115 / 116 | SR | `EV_DoDoor(line, blazeRaise / blazeOpen / blazeClose)` | |
| 117 | door blazing raise (reusable) | `EV_VerticalDoor` | |
| 118 | door blazing open (→0) | `EV_VerticalDoor` | cleared inside EV_VerticalDoor |
| 122 | S1 | `EV_DoPlat(line,blazeDWUS,0)` | |
| 123 | SR | `EV_DoPlat(line,blazeDWUS,0)` | |
| 127 | S1 | `EV_BuildStairs(line,turbo16)` | |
| 131 | S1 / 132 SR | `EV_DoFloor(line,raiseFloorTurbo)` | |
| 133 / 135 / 137 | S1 locked blue/red/yellow | `EV_DoLockedDoor(line,blazeOpen,thing)` | |
| 99 / 134 / 136 | SR locked blue/red/yellow | `EV_DoLockedDoor(line,blazeOpen,thing)` | |
| 138 | SR | `EV_LightTurnOn(line,255)` | texture swap with useAgain=1 |
| 139 | SR | `EV_LightTurnOn(line,35)` | |
| 140 | S1 | `EV_DoFloor(line,raiseFloor512)` | |

Lock-check pairing inside `EV_DoLockedDoor`: `case 99/133` blue, `134/135` red, `136/137` yellow.

### 2.2 Cross specials (p_spec.c `P_CrossSpecialLine`) — W1 (one-shot) then GR (rearmable)

W1 (each also sets `line->special = 0` unless marked):

| # | Action | | # | Action |
|---|--------|-|---|--------|
| 2 | `EV_DoDoor(line,open)` | | 56 | `EV_DoFloor(line,raiseFloorCrush)` |
| 3 | `EV_DoDoor(line,close)` | | 57 | `EV_CeilingCrushStop(line)` |
| 4 | `EV_DoDoor(line,normal)` (monster-allowed) | | 58 | `EV_DoFloor(line,raiseFloor24)` |
| 5 | `EV_DoFloor(line,raiseFloor)` | | 59 | `EV_DoFloor(line,raiseFloor24AndChange)` |
| 6 | `EV_DoCeiling(line,fastCrushAndRaise)` | | 100 | `EV_BuildStairs(line,turbo16)` |
| 8 | `EV_BuildStairs(line,build8)` | | 104 | `EV_TurnTagLightsOff(line)` |
| 10 | `EV_DoPlat(line,downWaitUpStay,0)` (monster) | | 108 | `EV_DoDoor(line,blazeRaise)` |
| 12 | `EV_LightTurnOn(line,0)` (brightest near) | | 109 | `EV_DoDoor(line,blazeOpen)` |
| 13 | `EV_LightTurnOn(line,255)` | | 110 | `EV_DoDoor(line,blazeClose)` |
| 16 | `EV_DoDoor(line,close30ThenOpen)` | | 119 | `EV_DoFloor(line,raiseFloorToNearest)` |
| 17 | `EV_StartLightStrobing(line)` | | 121 | `EV_DoPlat(line,blazeDWUS,0)` |
| 19 | `EV_DoFloor(line,lowerFloor)` | | 124 | `G_SecretExitLevel()` — NOT cleared |
| 22 | `EV_DoPlat(line,raiseToNearestAndChange,0)` | | 125 | teleport monster-only: `if (!thing->player) EV_Teleport(...)` then clear |
| 25 | `EV_DoCeiling(line,crushAndRaise)` | | 130 | `EV_DoFloor(line,raiseFloorTurbo)` |
| 30 | `EV_DoFloor(line,raiseToTexture)` | | 141 | `EV_DoCeiling(line,silentCrushAndRaise)` |
| 35 | `EV_LightTurnOn(line,35)` ("very dark") | | 40 | `EV_DoCeiling(line,raiseToHighest); EV_DoFloor(line,lowerFloorToLowest)` |
| 36 | `EV_DoFloor(line,turboLower)` | | 44 | `EV_DoCeiling(line,lowerAndCrush)` |
| 37 | `EV_DoFloor(line,lowerAndChange)` | | 52 | `G_ExitLevel()` — special NOT cleared |
| 38 | `EV_DoFloor(line,lowerFloorToLowest)` | | 53 | `EV_DoPlat(line,perpetualRaise,0)` |
| 39 | `EV_Teleport(line,side,thing)` (monster) | | 54 | `EV_StopPlat(line)` |

GR (identical effect, no clear): 72=`lowerAndCrush`, 73=`crushAndRaise`, 74=`EV_CeilingCrushStop`, 75=`close`,
76=`close30ThenOpen`, 77=`fastCrushAndRaise`, 79=`LightTurnOn(35)`, 80=`LightTurnOn(0)`, 81=`LightTurnOn(255)`,
82=`lowerFloorToLowest`, 83=`lowerFloor`, 84=`lowerAndChange`, 86=`open`, 87=`perpetualRaise`,
88=`downWaitUpStay` (monster-allowed), 89=`EV_StopPlat`, 90=`normal`, 91=`raiseFloor`, 92=`raiseFloor24`,
93=`raiseFloor24AndChange`, 94=`raiseFloorCrush`, 95=`raiseToNearestAndChange`, 96=`raiseToTexture`,
97=`EV_Teleport` (monster-allowed), 98=`turboLower`, 105=`blazeRaise`, 106=`blazeOpen`, 107=`blazeClose`,
120=`blazeDWUS`, 126=teleport monster-only, 128=`raiseFloorToNearest`, 129=`raiseFloorTurbo`.

Special 48 (`scroll wall, side 1`) is not in the dispatcher: `P_SpawnSpecials` collects it into `linespeciallist[]` and `P_UpdateSpecials` (p_spec.c) does `sides[line->sidenum[0]].textureoffset += FRACUNIT;` per tic. The whole sliding-door system (special 124-as-slide) is `#if 0`'d in 1.10.

Confidence: High (verbatim transcription). Cross-check: specials 24/46/47 are shoot; no 78, 85, 101? (101 exists as S1 only), 142+ absent.

---

## 3. Sector specials

### 3.1 Spawn-time (p_spec.c `P_SpawnSpecials`, at map load)

```c
switch (sector->special) {
  case 1: P_SpawnLightFlash(sector); break;               // FLICKERING LIGHTS
  case 2: P_SpawnStrobeFlash(sector,FASTDARK,0); break;   // STROBE FAST
  case 3: P_SpawnStrobeFlash(sector,SLOWDARK,0); break;   // STROBE SLOW
  case 4: P_SpawnStrobeFlash(sector,FASTDARK,0);
          sector->special = 4; break;                     // STROBE FAST/DEATH SLIME (stays 4!)
  case 8: P_SpawnGlowingLight(sector); break;             // GLOWING LIGHT
  case 9: totalsecret++; break;                           // SECRET SECTOR (stays 9)
  case 10: P_SpawnDoorCloseIn30(sector); break;           // DOOR CLOSE IN 30 SECONDS
  case 12: P_SpawnStrobeFlash(sector,SLOWDARK,1); break;  // SYNC STROBE SLOW
  case 13: P_SpawnStrobeFlash(sector,FASTDARK,1); break;  // SYNC STROBE FAST
  case 14: P_SpawnDoorRaiseIn5Mins(sector,i); break;      // DOOR RAISE IN 5 MINUTES
  case 17: P_SpawnFireFlicker(sector); break;             // FIRELIGHT
}
```

All spawner functions (p_lights.c / p_doors.c) set `sector->special = 0` after spawning (except special 4 which re-writes 4 and 9 which is untouched).

### 3.2 Per-tic, standing-on-ground (p_spec.c `P_PlayerInSpecialSector(player_t*)`)

Called from `P_PlayerThink` (p_user.c) every tic. Exact code:

```c
sector = player->mo->subsector->sector;
if (player->mo->z != sector->floorheight) return;   // falling, not all the way down yet?
switch (sector->special) {
  case 5:  // HELLSLIME DAMAGE
    if (!player->powers[pw_ironfeet])
      if (!(leveltime&0x1f)) P_DamageMobj (player->mo, NULL, NULL, 10);
    break;
  case 7:  // NUKAGE DAMAGE
    if (!player->powers[pw_ironfeet])
      if (!(leveltime&0x1f)) P_DamageMobj (player->mo, NULL, NULL, 5);
    break;
  case 16: // SUPER HELLSLIME DAMAGE
  case 4:  // STROBE HURT
    if (!player->powers[pw_ironfeet] || (P_Random()<5))
      if (!(leveltime&0x1f)) P_DamageMobj (player->mo, NULL, NULL, 20);
    break;
  case 9:  player->secretcount++; sector->special = 0; break;  // SECRET SECTOR
  case 11: // EXIT SUPER DAMAGE! (for E1M8 finale)
    player->cheats &= ~CF_GODMODE;
    if (!(leveltime&0x1f)) P_DamageMobj (player->mo, NULL, NULL, 20);
    if (player->health <= 10) G_ExitLevel();
    break;
  default:
    I_Error("P_PlayerInSpecialSector: unknown special %i", sector->special);
}
```

**Damage formula (exact):** `!(leveltime & 0x1f)` = every 32 tics (~0.914 s); fixed amounts: special 7 = 5 dmg, special 5 = 10 dmg, specials 4/16 = 20 dmg. For 4/16 the guard is OR-ed with `P_Random()<5` (P_Random ∈ [0,255] → ~5/256 extra ticks where damage applies even with radSuit). NO health/17 formula in 1.10 (that is Boom). Monsters standing in damage sectors: NOT handled here (players only in 1.10).

Confidence: High.

---

## 4. Vertical doors (p_doors.c)

### 4.1 Types and constants

```c
typedef enum { top, middle, bottom } bwhere_e;           // (button placement)
typedef enum { normal, close30ThenOpen, close, open,
               raiseIn5Mins, blazeRaise, blazeOpen, blazeClose } vldoor_e;  // p_spec.h
#define VDOORSPEED  FRACUNIT*2   // 2 units/tic
#define VDOORWAIT   150          // tics to wait at top (normal/blazeRaise)
```

Blaze types override: `door->speed = VDOORSPEED * 4;` (8 units/tic).
`close30ThenOpen` re-wait at bottom: `door->topcountdown = 35*30;` (1050 tics).
`topheight = P_FindLowestCeilingSurrounding(sec) - 4*FRACUNIT;` (all raise/open types).
`close`/`blazeClose` also use `topheight = lowestCeilingSurrounding - 4*FRACUNIT` as the bottom target and drive `direction = -1`.

`vldoor_t` fields: `type, sector, topheight, speed, direction (1 up, 0 wait at top, -1 down; 2 = initial wait for raiseIn5Mins), topwait, topcountdown`.

### 4.2 `T_VerticalDoor` per-tic (tight pseudocode, verbatim-faithful)

```
case direction 0 (WAITING):  if !--topcountdown:
    blazeRaise|normal -> direction=-1, sound sfx_bdcls/sfx_dorcls
    close30ThenOpen   -> direction=1,  sound sfx_doropn
case direction 2 (INITIAL WAIT): if !--topcountdown: raiseIn5Mins -> direction=1, type=normal, sfx_doropn
case direction -1 (DOWN): res = T_MovePlane(sector, speed, sector->floorheight, crush=false, CEILING, -1)
    pastdest: blazeRaise|blazeClose|normal|close -> remove thinker (free)
              close30ThenOpen -> direction=0, topcountdown=35*30
    crushed:  blazeClose|close -> DO NOT GO BACK UP (stay down)
              else -> direction=1, sfx_doropn
case direction 1 (UP): res = T_MovePlane(..., topheight, false, CEILING, 1)
    pastdest: blazeRaise|normal -> direction=0, topcountdown=topwait
              close30ThenOpen|blazeOpen|open -> remove thinker (stay open)
```

### 4.3 Manual / locked doors `EV_VerticalDoor(line, thing)`

- Target sector = `sides[line->sidenum[side^1]].sector` (the back side's sector — no tag lookup).
- If sector already has `specialdata` and special is 1/26/27/28/117: toggling: `if (door->direction == -1) door->direction = 1; else if (!thing->player) return; else door->direction = -1;` ("bad guys never close doors"). Only RAISE-type doors toggle; open-types don't.
- Lock check before anything: 26/32 blue, 27/34 yellow, 28/33 red → `player->message = PD_BLUEK/PD_YELLOWK/PD_REDK; S_StartSound(NULL, sfx_oof); return;`
- New thinker: `direction=1, speed=VDOORSPEED, topwait=VDOORWAIT`; special 117 → `type=blazeRaise, speed*4`; 118 → `type=blazeOpen, speed*4, line->special=0`; 31–34 → `type=open, line->special=0`.

### 4.4 Sector-spawned doors (p_doors.c)

```c
P_SpawnDoorCloseIn30: direction=0, type=normal, speed=VDOORSPEED, topcountdown=30*35, sector->special=0
P_SpawnDoorRaiseIn5Mins: direction=2, type=raiseIn5Mins, topcountdown=5*60*35 (=10500 tics)
```

Confidence: High.

---

## 5. Keys / locked doors

`card_t` enum (doomdef.h):

```c
typedef enum { it_bluecard, it_yellowcard, it_redcard,
               it_blueskull, it_yellowskull, it_redskull, NUMCARDS } card_t;
```

All 6 exist in `player_t.cards[NUMCARDS]`. Pickup in `P_TouchSpecialThing` (p_inter.c) dispatches **by sprite name**, not mobj type: `case SPR_BKEY: P_GiveCard(player, it_bluecard)` … `case SPR_BSKU: … it_blueskull` (all six handled in shared code; mobjs are `MT_MISCn` entries in info.c, doomednum 38/39/40 = skull items, cards nearby — doomednum mapping belongs to the mapthings doc). In practice Doom 1 maps place only card sprites; skull keys are a Doom 2 thing. The lock check accepts card OR skull:

- `EV_VerticalDoor` (doors): 26/32 `!cards[it_bluecard] && !cards[it_blueskull]` → `PD_BLUEK`; 27/34 yellow → `PD_YELLOWK`; 28/33 red → `PD_REDK`.
- `EV_DoLockedDoor` (blazing button doors, 99/133, 134/135, 136/137): messages `PD_BLUEO` etc.

Exact strings (d_englsh.h lines 125–130):

```c
#define PD_BLUEO   "You need a blue key to activate this object"
#define PD_REDO    "You need a red key to activate this object"
#define PD_YELLOWO "You need a yellow key to activate this object"
#define PD_BLUEK   "You need a blue key to open this door"
#define PD_REDK    "You need a red key to open this door"
#define PD_YELLOWK "You need a yellow key to open this door"
```

Failure feedback = `player->message` + `S_StartSound(NULL, sfx_oof)`. There is no `P_CanUnlock` function in 1.10 — checks are inline in these two functions.

Confidence: High for strings/checks/pickup-by-sprite (all read from source); skull keys' map availability is build/WAD-dependent (Medium; defer doomednum mapping to the mapthings research).

---

## 6. Lifts / plats (p_plats.c, p_spec.h)

```c
typedef enum { up, down, waiting, in_stasis } plat_e;
typedef enum { perpetualRaise, downWaitUpStay, raiseAndChange,
               raiseToNearestAndChange, blazeDWUS } plattype_e;
#define PLATWAIT  3           // seconds
#define PLATSPEED FRACUNIT    // 1 unit/tic baseline
#define MAXPLATS  30
```

`EV_DoPlat(line, type, amount)` — per tagged sector (skip if `sec->specialdata`):

| type | speed | low | high | wait | start |
|------|-------|-----|------|------|-------|
| raiseToNearestAndChange | PLATSPEED/2 | — | `P_FindNextHighestFloor` | 0 | up; copies floorpic from `sides[line->sidenum[0]].sector`; **`sec->special = 0`** ("NO MORE DAMAGE, IF APPLICABLE") |
| raiseAndChange | PLATSPEED/2 | — | `floorheight + amount*FRACUNIT` (24 or 32) | 0 | up; copies floorpic |
| downWaitUpStay | PLATSPEED*4 (4/tic) | lowest surrounding (clamped ≤ own) | own floorheight | `35*PLATWAIT` = 105 | down |
| blazeDWUS | PLATSPEED*8 (8/tic) | same | own floorheight | 105 | down |
| perpetualRaise | PLATSPEED | lowest surrounding | highest surrounding | 105 | `status = P_Random()&1` (random up/down) |

`perpetualRaise` also revives in-stasis plats with matching tag (`P_ActivateInStasis`).
`EV_StopPlat` (special 54/89): sets `oldstatus = status; status = in_stasis; thinker.function = NULL`.

`T_PlatRaise` per tic:

```
status up:      res = T_MovePlane(sector, speed, high, crush=false, 0, 1)
                if raise*AndChange: sfx_stnmov every 8 tics
                if res==crushed && !crush: count=wait; status=down; sfx_pstart
                if res==pastdest: count=wait; status=waiting; sfx_pstop;
                   {blazeDWUS, downWaitUpStay, raiseAndChange, raiseToNearestAndChange} -> P_RemoveActivePlat
status down:    res = T_MovePlane(sector, speed, low, false, 0, -1)
                pastdest -> count=wait; status=waiting; sfx_pstop
status waiting: if !--count: status = (sector->floorheight == low) ? up : down; sfx_pstart
status in_stasis: nothing
```

Note downWaitUpStay never returns up after "stay" — plat removed after reaching top (its normal cycle ends). The `amount` arg matters only for `raiseAndChange`.

Confidence: High.

---

## 7. Floors & stairs (p_floor.c)

```c
typedef enum { lowerFloor, lowerFloorToLowest, turboLower, raiseFloor,
               raiseFloorToNearest, raiseToTexture, lowerAndChange,
               raiseFloor24, raiseFloor24AndChange, raiseFloorCrush,
               raiseFloorTurbo, donutRaise, raiseFloor512 } floor_e;
typedef enum { build8, turbo16 } stair_e;
#define FLOORSPEED FRACUNIT   // 1 unit/tic baseline
```

`EV_DoFloor` destinations (verbatim from switch):

| type | direction | speed | floordestheight |
|------|-----------|-------|-----------------|
| lowerFloor | -1 | FLOORSPEED | `P_FindHighestFloorSurrounding` |
| lowerFloorToLowest | -1 | FLOORSPEED | `P_FindLowestFloorSurrounding` |
| turboLower | -1 | FLOORSPEED*4 | highest surrounding; `if (!= floorheight) dest += 8*FRACUNIT` |
| raiseFloor | +1 | FLOORSPEED | lowest surrounding ceiling, clamped ≤ own ceiling; no crush |
| raiseFloorCrush | +1 | FLOORSPEED | same − `8*FRACUNIT`; `crush = true` (fallthrough sets it) |
| raiseFloorTurbo | +1 | FLOORSPEED*4 | `P_FindNextHighestFloor` |
| raiseFloorToNearest | +1 | FLOORSPEED | `P_FindNextHighestFloor` |
| raiseFloor24 | +1 | FLOORSPEED | `+24*FRACUNIT` |
| raiseFloor512 | +1 | FLOORSPEED | `+512*FRACUNIT` |
| raiseFloor24AndChange | +1 | FLOORSPEED | `+24*FRACUNIT`; `sec->floorpic = line->frontsector->floorpic; sec->special = line->frontsector->special;` |
| raiseToTexture | +1 | FLOORSPEED | own floor + min `textureheight` of all two-sided `bottomtexture`s |
| lowerAndChange | -1 | FLOORSPEED | lowest surrounding; find adjoining sector at that height → `floor->texture = sec->floorpic; floor->newspecial = sec->special;` |
| donutRaise | +1 | FLOORSPEED/2 | built inside `EV_DoDonut` only |

`T_MoveFloor`: `T_MovePlane(...)`; `if (!(leveltime&7)) sfx_stnmov`; on pastdest apply `newspecial`/`texture` for donutRaise (up) / lowerAndChange (down), remove thinker, `sfx_pstop`.

**Stairs `EV_BuildStairs(line, type)`:** per tagged sector chain:

```
build8: speed=FLOORSPEED/4, stairsize=8*FRACUNIT | turbo16: speed=FLOORSPEED*4, stairsize=16*FRACUNIT
first sector dest = floorheight + stairsize; texture = sec->floorpic;
then chain: find 2-sided line whose FRONT side belongs to current sector, backsector
with same floorpic (`texture`), dest += stairsize each hop, one T_MoveFloor thinker per
sector; stop when no candidate. (Simple walk; no rebuild logic in 1.10.)
```

**Donut `EV_DoDonut(line)`** (p_spec.c): tagged sector s1 (the slime ring's center handled per s2):
s2 = `getNextSector(s1->lines[0], s1)`; for each of s2's lines not shared with s1:
spawn two `T_MoveFloor`s — s2 rising `donutRaise` at `FLOORSPEED/2` to s3's floor with s3's floorpic,
and s1 (hole) lowering `lowerFloor` at `FLOORSPEED/2` to s3's floorheight.

**Crushing (`T_MovePlane`, p_floor.c):** floor/ceiling moves `±speed` per tic; each tic calls `P_ChangeSector(sector, crush)`; if a thing no longer fits: with `crush==true` → returns `crushed` and the plane STAYS at the advanced position (crushing continues; `crush==true` planes never revert); with `crush==false` → position rolled back to `lastpos` and `crushed` returned (plats then reverse). Ceiling-up ignores collisions entirely (the crush check is `#if 0`'d).

**Crush damage (p_map.c `PIT_ChangeSector`):** exact:

```c
if (P_ThingHeightClip(thing)) return true;      // still fits
if (thing->health <= 0) { -> S_GIBS; ... }       // crunch bodies to giblets
if (thing->flags & MF_DROPPED) { P_RemoveMobj; return true; }
if (!(thing->flags & MF_SHOOTABLE)) return true;
nofit = true;
if (crushchange && !(leveltime&3)) {
    P_DamageMobj(thing, NULL, NULL, 10);         // 10 dmg every 4 tics while crushed
    // blood spray: mom = (P_Random()-P_Random())<<12
}
```

So Doom 1 crush damage = flat 10 per `!(leveltime&3)` tic for anything stuck (players AND monsters). There is no `8 + P_Random()&7` formula in 1.10.

Confidence: High.

---

## 8. Ceilings (p_ceilng.c — note filename)

```c
typedef enum { lowerToFloor, raiseToHighest, lowerAndCrush, crushAndRaise,
               fastCrushAndRaise, silentCrushAndRaise } ceiling_e;   // p_spec.h
#define CEILSPEED   FRACUNIT     // 1 unit/tic
#define CEILWAIT    150          // (unused in 1.10 logic)
#define MAXCEILINGS 30
```

`EV_DoCeiling` params (verbatim):

| type | crush | topheight | bottomheight | speed | dir |
|------|-------|-----------|--------------|-------|-----|
| fastCrushAndRaise | true | own ceiling | `floorheight + 8*FRACUNIT` | `CEILSPEED*2` (2/tic) | -1 |
| crushAndRaise | true | own ceiling | floorheight + 8 | CEILSPEED | -1 |
| silentCrushAndRaise | true | own ceiling | floorheight + 8 | CEILSPEED | -1 |
| lowerAndCrush | (crush flag from case: `ceiling->crush = false` default — only crush*Raise set true; lowerAndCrush moves with `crush=false` per-tic but slows on contact) | — | floorheight + 8 | CEILSPEED | -1 |
| lowerToFloor | false | — | floorheight | CEILSPEED | -1 |
| raiseToHighest | false | `P_FindHighestCeilingSurrounding` | — | CEILSPEED | +1 |

(Exact code path: `case crushAndRaise:` sets crush=true, topheight, then **falls through** to `case lowerAndCrush: case lowerToFloor:` which set bottomheight (plus 8 unless lowerToFloor) and speed CEILSPEED.)

`T_MoveCeiling` per tic:

```
dir 0: in stasis, nothing
dir 1 (up): T_MovePlane(sector, speed, topheight, crush=false, 1, 1)
  sfx_stnmov every 8 tics unless silentCrushAndRaise
  pastdest: raiseToHighest -> P_RemoveActiveCeiling
            silentCrushAndRaise: sfx_pstop; fallthrough ->
            fastCrushAndRaise|crushAndRaise: direction = -1
dir -1 (down): T_MovePlane(..., bottomheight, crush, 1, -1)
  sfx_stnmov every 8 tics unless silent
  pastdest: silent: sfx_pstop; crushAndRaise: speed = CEILSPEED; fallthrough
            fastCrushAndRaise: direction = 1     (cycle continues)
            lowerAndCrush|lowerToFloor: P_RemoveActiveCeiling
  crushed: silentCrushAndRaise|crushAndRaise|lowerAndCrush -> speed = CEILSPEED/8 (slow crush)
           (fastCrushAndRaise keeps its speed=2 with crush=true)
```

Stasis: `EV_CeilingCrushStop` (57/74) → `olddirection = direction; thinker.function = NULL; direction = 0`;
`P_ActivateInStasisCeiling` reactivates matching-tag ceilings when a crush&raise type re-triggers.

Confidence: High.

---

## 9. Lights (p_lights.c)

Constants (p_spec.h): `GLOWSPEED 8`, `STROBEBRIGHT 5`, `FASTDARK 15`, `SLOWDARK 35`.

Spawn thinker formulas (all read `minlight = P_FindMinSurroundingLight(sector, sector->lightlevel)` unless noted):

```c
// Fire flicker (sector special 17):
amount = (P_Random()&3)*16;
lightlevel = (lightlevel - amount < minlight) ? minlight : maxlight - amount;
count = 4;  minlight = P_FindMinSurroundingLight(...)+16;

// Light flash / flickering (special 1):
maxlight = sector->lightlevel; maxtime = 64; mintime = 7;
toggle: count = (P_Random()&maxtime)+1  (bright->dark uses mintime: (P_Random()&mintime)+1)

// Strobe (specials 2,3,12,13 and EV_StartLightStrobing):
darktime = FASTDARK|SLOWDARK; brighttime = STROBEBRIGHT(5);
if minlight == maxlight: minlight = 0;
count = inSync ? 1 : (P_Random()&7)+1;

// Glow (special 8):
direction = -1 initially;
per tic: lightlevel ±= GLOWSPEED (8), reverse at min/max bounds.
```

**No "lightLevel = 128 + P_Random()" style formulas exist in 1.10** — the well-known flicker tables (`Flickr: sector->lightLevel = 128 + ...`) are Hexen/BOOM-era; Doom1 uses the surrounding-light minimum as the floor.

Line-triggered (p_spec.c dispatch → p_lights.c):
- `EV_LightTurnOn(line, bright)`: all sectors with `tag == line->tag` get `lightlevel = bright`; `bright == 0` → highest surrounding light instead. Used by specials 12/80 (0), 13/81 (255), 35/79/139 (35), 138 (255).
- `EV_StartLightStrobing(line)`: tagged sectors → `P_SpawnStrobeFlash(sec, SLOWDARK, 0)` (special 17).
- `EV_TurnTagLightsOff(line)` (special 104): each tagged sector's lightlevel = min of itself and all adjoining sectors' lightlevels.

Confidence: High.

---

## 10. Exits (p_switch.c / p_spec.c / g_game.c)

Line specials: `11` (S1, use), `52` (W1, cross), `51` (S1 secret), `124` (W1/GR cross secret; also a no-op stub in use dispatch).

```c
// g_game.c
boolean secretexit;
void G_ExitLevel (void)      { secretexit = false; gameaction = ga_completed; }
void G_SecretExitLevel (void) {
    // IF NO WOLF3D LEVELS, NO SECRET EXIT!
    if ((gamemode == commercial) && (W_CheckNumForName("map31") < 0)) secretexit = false;
    else secretexit = true;
    gameaction = ga_completed;
}
```

In `G_DoCompleted` (g_game.c), non-commercial (Doom 1 episodes):

```c
if (gamemap == 8 && gamemode != commercial) { gameaction = ga_victory; return; }  // E1..E3 end
if (gamemap == 9 && gamemode != commercial) for all players players[i].didsecret = true; // returning from E1M9-style secret
wminfo.next:
  secretexit            -> next = 8      (go to secret level)
  gamemap == 9          -> ep1:3, ep2:5, ep3:6, ep4:2  (return from secret)
  else                  -> next = gamemap               (next map = map+1)
commercial: secretexit -> map15:30, map31:31 ; map31/32 -> 15 ; else next = gamemap
```

So in Doom 1, secret exits (special 51/124) route to episode map 8 (`E1M9` etc.); specials 51/124 in Doom1 episodes send `secretexit=true` → next map = 8. There is no `nextsecret`/`fSecretExitPresent` — that is Doom2/Boom lore; 1.10 uses the `secretexit` global above. Map 9 handling is hardcoded, not special-driven.

Confidence: High.

---

## 11. Teleporters (p_telept.c)

`EV_Teleport(line, side, thing)` — exact semantics:

```
if (thing->flags & MF_MISSILE) return 0;          // don't teleport missiles
if (side == 1) return 0;                          // hit back of line -> no teleport (escape hatch)
for each sector i with sectors[i].tag == line->tag:
  for each thinker (mobj only):
    if (m->type != MT_TELEPORTMAN) continue;      // type 14 (#define MO_TELEPORTMAN 14, p_spec.h)
    if (m->subsector->sector - sectors != i) continue;   // must live IN the tagged sector
    if (!P_TeleportMove(thing, m->x, m->y)) return 0;    // blocked dest -> total failure, no fog
    thing->z = thing->floorz;
    if (thing->player) player->viewz = z + viewheight;
    fog = P_SpawnMobj(oldx, oldy, oldz, MT_TFOG); S_StartSound(fog, sfx_telept);
    an = m->angle >> ANGLETOFINESHIFT;
    fog = P_SpawnMobj(m->x + 20*finecosine[an], m->y + 20*finesine[an], thing->z, MT_TFOG);
    S_StartSound(fog, sfx_telept);               // sound at destination fog
    if (thing->player) thing->reactiontime = 18; // "don't move for a bit"
    thing->angle = m->angle;                     // player takes teleport destination angle
    thing->momx = thing->momy = thing->momz = 0;
    return 1;
return 0;
```

No monster-vs-player filter here (that's in the dispatcher: 125/126 monster-only, player crosses fall through harmlessly). Monster teleports 97/126 work fine for players too (players pass the `ok` gate unconditionally). Note: destination fog is offset 20 units *in front of* the teleport destination thing along its angle.

Confidence: High.

---

## 12. Switch texture change & buttons (p_switch.c, p_spec.c)

- `alphSwitchList[]`: ~41 pairs `{SW1xxx, SW2xxx, episode}`; `P_InitSwitchList` builds `switchlist[]` as flat alternating `[tex1,tex2,tex1,tex2,...]` filtered by gamemode (episode 1/2/3); terminates with `switchlist[index] = -1`, `numswitches = index/2`.
- **The pairing trick:** lookup index `i`, replace with `switchlist[i ^ 1]` (xor 1 flips between SW1↔SW2). No `'+'-1` name arithmetic in 1.10 (that's a DeHackEd/texture-list technique; here it is index xor).
- `P_ChangeSwitchTexture(line, useAgain)`: (1) `if (!useAgain) line->special = 0;` ← where S1/W-shoot switches disarm. (2) sound = `sfx_swtchn`, or `sfx_swtchx` if `line->special == 11` — but the clear happens FIRST, so for special 11 the check sees 0 and the exit switch in fact plays `sfx_swtchn`; replicate the quirk if byte-exact. (3) Scan side0's top/mid/bottom textures against `switchlist[0..numswitches*2)`; on match set to `switchlist[i^1]`, `if (useAgain) P_StartButton(line, where, oldTexture, BUTTONTIME)`.
- `P_StartButton` — max `MAXBUTTONS=16` slots; same line already pressed → no-op (keeps original timer). `BUTTONTIME = 35` tics (1 s).
- Button revert tick logic in `P_UpdateSpecials` (p_spec.c): decrement `btimer`; at 0 restore the old texture into the recorded `where` (top/middle/bottom), `S_StartSound(sfx_swtchn)`, `memset` the slot.

Confidence: High (quirk noted from literal statement order in `P_ChangeSwitchTexture`).

---

## 13. Secret detection

- **Line-based:** `ML_SECRET = 32` (doomdata.h) line flag. Only effect in 1.10: `P_UseSpecialLine` blocks monsters (`if (line->flags & ML_SECRET) return false;`) and automap treats secret 2-sided lines specially in p_setup.c (`P_GroupLines`/segs). No gameplay effect otherwise.
- **Sector-based (the real mechanism):** sector special `9`: at load `totalsecret++` (P_SpawnSpecials); when a player stands in it (`P_PlayerInSpecialSector`, z==floor) → `player->secretcount++; sector->special = 0;`. Counted at `G_PlayerFinishLevel` (g_game.c saves/restores `secretcount`). There is **no `sector->special |= 128` bit trick and no "A SECRET IS REVEALED" on-screen message in linuxdoom-1.10** — secrets surface only on the intermission screen ("secrets found"); the only secret strings are intermission texts in d_englsh.h (`"CONGRATULATIONS, YOU'VE FOUND THE SECRET\n"` etc.) and `G_WorldDone` routes to secret episodes via `secretexit`. Doom 1 has no `bonuscount` secret reward tied to specials.
- Monsters never trigger secret sectors (player-only function).

Confidence: High.

---

## 14. Constants summary

| Constant | Value | File |
|----------|-------|------|
| FRACUNIT | 1.0 fixed | m_fixed.h |
| VDOORSPEED / VDOORWAIT | 2×FRACUNIT (blaze ×4) / 150 tics | p_spec.h |
| door waits | close30ThenOpen re-wait 35×30=1050; spawn close-in-30 1050; raise-in-5min 5×60×35=10500 | p_doors.c |
| PLATSPEED / PLATWAIT | FRACUNIT (dwus ×4, blaze ×8, raise&change ÷2) / 35×3=105 tics | p_spec.h, p_plats.c |
| FLOORSPEED | FRACUNIT (turbo ×4, donut ÷2, build8 ÷4, turbo16 ×4) | p_spec.h, p_floor.c |
| stair sizes / turboLower extra / raiseFloorCrush shrink | 8·F / 16·F; dest += 8×F; dest −= 8×F | p_floor.c |
| CEILSPEED / crush slowdown / crush gap | FRACUNIT (fast ×2, crushed ÷8) / floor + 8×FRACUNIT | p_spec.h, p_ceilng.c |
| crush damage | 10 every 4 tics (`!(leveltime&3)`) | p_map.c PIT_ChangeSector |
| sector damage rate | every 32 tics (`!(leveltime&0x1f)`), 5/10/20 dmg | p_spec.c |
| teleport freeze | reactiontime = 18 | p_telept.c |
| BUTTONTIME | 35 tics | p_spec.h |
| MAXBUTTONS / MAXSWITCHES / MAXPLATS / MAXCEILINGS / MAXLINEANIMS | 16 / 50(×2 entries) / 30 / 30 / 64 | p_spec.h |
| GLOWSPEED / STROBEBRIGHT / FASTDARK / SLOWDARK | 8 / 5 / 15 / 35 | p_spec.h |
| strobe sync offset / light flash times / fireflicker | 1 vs (P_Random()&7)+1 / maxtime 64, mintime 7 / (P_Random()&3)*16, count 4, min+16 | p_lights.c |
| scroll wall (48) | textureoffset += FRACUNIT per tic | p_spec.c |
| E1M8 exit special | sector 11: 20 dmg/32tic, exit at health ≤ 10, clears CF_GODMODE | p_spec.c |

## Confidence summary

- Sections 1–4, 6–9, 11–13: **High** — transcribed directly from fetched raw 1.10 sources this session. Section 5 High except skull-key item availability in Doom 1 WADs (Medium).
- Section 2 class labels (W1/WR/S1/SR/G1/GR): **Medium-High** — names are industry-standard labels, the 1.10 source itself has no class taxonomy; every mapping was derived from `line->special = 0` presence/absence and the dispatch function the case lives in.
- Prompt-lore corrections recorded: no health/17 damage formula, no 128+P_Random light formulas, no P_CanUnlock, no P_FindSectorsOnSides tag-0 fallback, no 128-bit secret sector flag, no bonuscount secret bonus, filename `p_ceilng.c`.

## Sources

- https://raw.githubusercontent.com/id-Software/DOOM/master/linuxdoom-1.10/{p_spec.c, p_spec.h, p_switch.c, p_plats.c, p_doors.c, p_ceilng.c, p_floor.c, p_lights.c, p_telept.c, p_map.c, p_user.c, g_game.c, doomdef.h, d_englsh.h, dstrings.h, doomdata.h, p_inter.c, info.c} (raw, verified present; `p_ceiling.c` does not exist — the file is `p_ceilng.c`; strings live in `d_englsh.h` via `dstrings.h`).
