# R04 — DOOM Deterministic Simulation Core Research

Primary source: id Software GPL release, `linuxdoom-1.10`
(https://github.com/id-Software/DOOM/tree/master/linuxdoom-1.10).
Every quote below was fetched verbatim from the raw files on 2025-09:
`d_main.c/.h`, `d_net.c/.h`, `d_ticcmd.h`, `d_event.h`, `d_player.h`, `g_game.c/.h`,
`p_user.c`, `p_map.c`, `p_maputl.c`, `p_local.h`, `p_mobj.c`, `p_tick.c`, `p_setup.c`,
`p_enemy.c`, `p_pspr.c`, `p_inter.c`, `m_fixed.c/.h`, `m_random.c`, `m_bbox.c`,
`tables.c/.h`, `r_main.c`, `doomdef.h`, `info.c`.

**Scope corrections vs. the task brief** (the brief used names from the 1994
pre-release/leaked DOOM sources, which differ from the released 1.10):
- There is **no `d_loop.c`** in 1.10 — the loop lives in `d_main.c:D_DoomLoop` + `d_net.c:NetUpdate/TryRunTics`. (Verified: raw fetch of `d_loop.c` returns 404.)
- 1.10 has **no** `P_PointOnDivideSide`/`P_DivideLine` recursive BSP walking in `P_PathTraverse` — path traversal is a **blockmap DDA** (`p_maputl.c:P_PathTraverse`). Divide-line recursion for path traversal belongs to the 1994 source. The `divline_t` type survives only as the trace carrier for `P_InterceptVector`.
- 1.10 has **no** `THRESHOLD` constant, **no** `p_deferedthinkers` deferred-removal list, **no** `bobmove`, **no** `ANG1_X`/512-entry `finecosine`, and `P_TryMove` has **no `dropoff` boolean parameter**. Details and the 1994-source counterparts are flagged per section.

---

## 1. The tic loop at 35 Hz

**Tick rate.** `doomdef.h` (verified):

```c
#define MAXPLAYERS		4          // doomdef.h:119
#define TICRATE		35             // doomdef.h:122
```

**Main loop.** `d_main.c:D_DoomLoop` (verified, ~line 353):

```c
while (1)
{
    // frame syncronous IO operations
    I_StartFrame ();

    // process one or more tics
    if (singletics)
    {
        I_StartTic ();
        D_ProcessEvents ();
        G_BuildTiccmd (&netcmds[consoleplayer][maketic%BACKUPTICS]);
        if (advancedemo)
            D_DoAdvanceDemo ();
        M_Ticker ();
        G_Ticker ();
        gametic++;
        maketic++;
    }
    else
    {
        TryRunTics (); // will run at least one tic
    }

    S_UpdateSounds (players[consoleplayer].mo);// move positional sounds

    // Update display, next frame, with current state.
    D_Display ();
    ...
```

`I_GetTime` contract (`i_system.h:44-45`): "Called by D_DoomLoop, returns current time in tics." (In the Linux port it is derived from wall time scaled to TICRATE; exact platform code not in the repo — see Confidence.)

**Per-tic order inside `G_Ticker`** (`g_game.c:605`, verified):
1. Rebirth pass: players with `PST_REBORN` → `G_DoReborn(i)`.
2. Drain `gameaction` state machine (`ga_loadlevel → G_DoLoadLevel`, `ga_newgame`, `ga_loadgame`, `ga_savegame`, `ga_playdemo`, `ga_completed`, `ga_victory`, `ga_worlddone`, `ga_screenshot`).
3. For each playing player: `memcpy (cmd, &netcmds[i][buf], sizeof(ticcmd_t))` where `buf = (gametic/ticdup)%BACKUPTICS`; then demo read/write; turbo cheat check (`cmd->forwardmove > TURBOTHRESHOLD`); netgame consistancy check (§3).
4. Special buttons (`BT_SPECIAL` → `BTS_PAUSE` / `BTS_SAVEGAME`).
5. Main dispatch:

```c
switch (gamestate)
{
  case GS_LEVEL:
    P_Ticker ();
    ST_Ticker ();
    AM_Ticker ();
    HU_Ticker ();
    break;
  case GS_INTERMISSION: WI_Ticker (); break;
  case GS_FINALE:       F_Ticker (); break;
  case GS_DEMOSCREEN:   D_PageTicker (); break;
}
```

**Level-tic order inside `P_Ticker`** (`p_tick.c`, verified): `if (paused) return;` → single-player menu pause check → `for all playing players: P_PlayerThink(&players[i])` → `P_RunThinkers()` → `P_UpdateSpecials()` → `P_RespawnSpecials()` → `leveltime++`.

**Netgame tic accumulation.**
- `d_net.c:NetUpdate` (line 368, verified): `nowtime = I_GetTime ()/ticdup; newtics = nowtime - gametime;` accumulate; `skiptics` subtracted; then per new tic: `I_StartTic (); D_ProcessEvents ();` and, while `maketic - gameticdiv < BACKUPTICS/2-1`, `G_BuildTiccmd (&localcmds[maketic%BACKUPTICS]); maketic++;`. Packets carry `starttic = resendto[i]`, `numtics = maketic - realstart`, and `resendto[i] = maketic - doomcom->extratics`.
- `d_net.c:GetNetCmd` (~line 285, verified): per-node `nettics[netnode]` = that node's newest maketic; out-of-order packets skipped (`realend <= nettics[netnode]`), gaps set `remoteresend[netnode]=true` and stall until retransmit (`NCMD_RETRANSMIT`, `RESENDCOUNT`), otherwise tics are stored into `netcmds[netconsole][nettics[netnode]%BACKUPTICS]`.
- `d_net.c:TryRunTics` (line ~638, verified): `realtics` from `I_GetTime()/ticdup`; `availabletics = lowtic - gametic/ticdup` where `lowtic = min nettics[i]` over `nodeingame[i]`; run count `counts` = `realtics+1` / `realtics` / `availabletics` (three-way clamp, `counts<1 → 1`); it then *waits* (`while (lowtic < gametic/ticdup + counts) NetUpdate();`) with a 20-realtic escape hatch for the menu; finally runs `counts × ticdup` tics, each: `M_Ticker(); G_Ticker(); gametic++;` and zeroes `chatchar`/special buttons on duplicated tics.
- `#define BACKUPTICS 12` (`d_net.h:49`, verified); `ticdup = doomcom->ticdup; maxsend = BACKUPTICS/(2*ticdup)-1;` (`d_net.c:581-582`). Vanilla Doom 1 (non-UDP-extratic paths aside) runs `ticdup=1`, `extratics=1` (`doomcom->extratics` supplied by the driver).

**Determinism takeaway:** the *sim* advances only inside `G_Ticker`; input enters only via `ticcmd_t` rings (`netcmds[4][12]`). Frame rate ≠ tic rate: any number of render frames per tic, tics run in lockstep (all peers must agree on which tics ran — `lowtic` gating).

Confidence: High (all code quoted from raw files). Uncertainty: the platform `I_GetTime` implementation is not in the released tree.

---

## 2. `ticcmd_t` layout

`d_ticcmd.h` (verified, complete):

```c
typedef struct
{
    char	forwardmove;	// *2048 for move
    char	sidemove;	// *2048 for move
    short	angleturn;	// <<16 for angle delta
    short	consistancy;	// checks for net game
    byte	chatchar;
    byte	buttons;
} ticcmd_t;
```

Demo serialization (`g_game.c:1499-1512`, verified): `angleturn` is stored as `(angleturn+128)>>8`, i.e. **demos only preserve `angleturn` with 8-bit resolution** (`((unsigned char)*demo_p++)<<8` on read).

**Buttons** (`d_event.h:75-98`, verified — the BT_* constants are in `d_event.h`, not `g_game.h`/`d_main.*`):

```c
BT_ATTACK		= 1,
BT_USE			= 2,
BT_CHANGE		= 4,
BT_WEAPONMASK		= (8+16+32),
BT_WEAPONSHIFT	= 3,
BT_SPECIAL		= 128,
BT_SPECIALMASK	= 3,
BTS_PAUSE		= 1,
BTS_SAVEGAME		= 2,
BTS_SAVEMASK		= (4+8+16),
BTS_SAVESHIFT 	= 2,
```

There is **no `BT_FORWARD`** in 1.10.

Confidence: High.

---

## 3. `G_BuildTiccmd` movement constants

`g_game.c:171-179` (verified):

```c
#define MAXPLMOVE		(forwardmove[1])
#define TURBOTHRESHOLD	0x32

fixed_t		forwardmove[2] = {0x19, 0x32};
fixed_t		sidemove[2] = {0x18, 0x28};
fixed_t		angleturn[3] = {640, 1280, 320};	// + slow turn

#define SLOWTURNTICS	6
```

These are **plain integers** added to `cmd->forwardmove` / `cmd->sidemove` (signed char scale), *not* `20<<FRACBITS`. Walk = 0x19 = **25**, run = 0x32 = **50** (`speed = gamekeydown[key_speed]` selects index 1). Side: 0x18 = **24**, run 0x28 = **40**. The brief's "forwardmove=20<<FRACBITS/sidemove=15" is the 1994 source (`#define FWDMOVE 20` era); released 1.10 is as above. (The `fixed_t` type on the array is vestigial — values 0x19/0x18 are used as integers here and multiplied by 2048 later in `P_MovePlayer`; see §7.)

Turning (`g_game.c:G_BuildTiccmd`, verified): two-stage accel turn — `turnheld += ticdup` while turn keys/joystick held; `tspeed = 2` (slow, 320) for `turnheld < SLOWTURNTICS (6)`, else `tspeed = speed` (640 walk / 1280 run). Applied as `cmd->angleturn -= angleturn[tspeed]` (left adds). Since `P_MovePlayer` does `angle += cmd->angleturn<<16` BAM:
- 320<<16 = **1.7578125°/tic** (slow, ≈61.5°/s)
- 640<<16 = **3.515625°/tic** (walk, ≈123.05°/s)
- 1280<<16 = **7.03125°/tic** (run, ≈246.1°/s)
(angle-degree values are trivially derived from ANG360=2^32.)

Mouse: `side += mousex*2` when strafing, else `cmd->angleturn -= mousex*0x8`; `forward += mousey`; double-click (window 20 tics, `dclicktime += ticdup; > 20` resets) synthesizes `BT_USE`. Clamp: `if (forward > MAXPLMOVE) forward = MAXPLMOVE;` (symmetric negatives), then `cmd->forwardmove += forward`.

Chainsaw "walk forward while ripper runs" hack inside `P_PlayerThink` (`p_user.c:252`, verified): `cmd->forwardmove = 0xc800/512;` = **100** (exceeds MAXPLMOVE 50 — internal override, applied when `MF_JUSTATTACKED`).

Consistancy (netgame): `cmd->consistancy = consistancy[consoleplayer][maketic%BACKUPTICS];` (G_BuildTiccmd); in `G_Ticker` each node stores `consistancy[i][buf] = players[i].mo->x` (or `rndindex` if no `mo`) and compares on replay — mismatch → `I_Error ("consistency failure ...")`.

Confidence: High.

---

## 4. Fixed point and binary angles

`m_fixed.h` (verified): `#define FRACBITS 16`, `#define FRACUNIT (1<<FRACBITS)`, `typedef int fixed_t;`

`m_fixed.c` (verified):

```c
fixed_t FixedMul (fixed_t a, fixed_t b)
{
    return ((long long) a * (long long) b) >> FRACBITS;
}

fixed_t FixedDiv (fixed_t a, fixed_t b)
{
    if ( (abs(a)>>14) >= abs(b))
	return (a^b)<0 ? MININT : MAXINT;
    return FixedDiv2 (a,b);
}

fixed_t FixedDiv2 (fixed_t a, fixed_t b)
{
    double c;
    c = ((double)a) / ((double)b) * FRACUNIT;
    if (c >= 2147483648.0 || c < -2147483648.0)
	I_Error("FixedDiv: divide by zero");
    return (fixed_t) c;
}
```

Port notes: `FixedMul` = 32.32 product shifted 16 down (JS: `(a*b)|0` unsafe for 53-bit — use Math.mulmod-free BigInt or 16×16 decomposition to stay exact; on modern V8 `Math.round(a*b/65536)` drifts — do NOT). `FixedDiv` saturates to MININT/MAXINT when `|a|/|b| >= 4`, else is computed **in double** and truncated — reproducible in JS, but note it is *truncation toward zero via cast*, not floor. `m_bbox.c` is just the inline `P_AddToBBox`/`P_BBoxInBBox`/`P_BBoxInBox`/`P_InsideBBox` rectangle helpers (all verified trivial).

`tables.h` (verified):

```c
#define FINEANGLES		8192
#define FINEMASK		(FINEANGLES-1)
// 0x100000000 to 0x2000
#define ANGLETOFINESHIFT	19
// Effective size is 10240.
extern  fixed_t		finesine[5*FINEANGLES/4];
// Re-use data, is just PI/2 pahse shift.
extern  fixed_t*	finecosine;
// Effective size is 4096.
extern fixed_t		finetangent[FINEANGLES/2];
#define ANG45			0x20000000
#define ANG90			0x40000000
#define ANG180		0x80000000
#define ANG270		0xc0000000
```

`angles = unsigned 32-bit; full circle = 2^32` (BAM). `finecosine` is **not a separate 512-entry table** (that's the 1994 source): it is a pointer alias defined in `r_main.c:113` (verified):

```c
fixed_t*		finecosine = &finesine[FINEANGLES/4];
```

`tables.c` actually defines `int finesine[10240]` (line 584; declaration type mismatch `int` vs `fixed_t` is benign) — the table covers 1.25 revolutions so `finesine[x]`, `x & FINEMASK`, and `finecosine[ang>>19]` both work for any angle. First entries (verified): `25,75,125,175,226,276,...` (nonzero at angle 0 — includes the +0.5 rounding bias; transcribe exactly). `finetangent[4096]` also present; last entries `...,170910304`.

`ANGLETOFINESHIFT 19` maps BAM → fine index (`angle>>19` gives 0..8191).

Confidence: High (all tables and constants read directly).

---

## 5. Random numbers: the 256-byte table

`m_random.c` (verified). State: `int rndindex = 0; int prndindex = 0;`

```c
int P_Random (void)   // note source comment: "// Which one is deterministic?"
{
    prndindex = (prndindex+1)&0xff;
    return rndtable[prndindex];
}

int M_Random (void)
{
    rndindex = (rndindex+1)&0xff;
    return rndtable[rndindex];
}

void M_ClearRandom (void) { rndindex = prndindex = 0; }
```

**Full `rndtable[256]`** (transcribed programmatically from the raw `m_random.c`; exactly 256 values, order preserved; indices 0-255):

```
  0:    0   8 109 220 222 241 149 107  75 248 254 140  16  66  74  21
16:   211  47  80 242 154  27 205 128 161  89  77  36  95 110  85  48
32:   212 140 211 249  22  79 200  50  28 188  52 140 202 120  68 145
48:    62  70 184 190  91 197 152 224 149 104  25 178 252 182 202 182
64:   141 197   4  81 181 242 145  42  39 227 156 198 225 193 219  93
80:   122 175 249   0 175 143  70 239  46 246 163  53 163 109 168 135
96:     2 235  25  92  20 145 138  77  69 166  78 176 173 212 166 113
112:   94 161  41  50 239  49 111 164  70  60   2  37 171  75 136 156
128:   11  56  42 146 138 229  73 146  77  61  98 196 135 106  63 197
144:  195  86  96 203 113 101 170 247 181 113  80 250 108   7 255 237
160:  129 226  79 107 112 166 103 241  24 223 239 120 198  58  60  82
176:  128   3 184  66 143 224 145 224  81 206 163  45  63  90 168 114
192:   59  33 159  95  28 139 123  98 125 196  15  70 194 253  54  14
208:  109 226  71  17 161  93 186  87 244 138  20  52 123 251  26  36
224:   17  46  52 231 232  76  31 221  84  37 216 165 212 106 197 242
240:   98  43  39 175 254 145 190  84 118 222 187 136 120 163 236 249
```

**Usage rules (from exhaustive grep of the tree):**
- `M_Random` appears outside `m_random.c` in exactly **three places**, none of which may perturb gameplay state: `s_sound.c:330` `pitch += 8 - (M_Random()&15);` and `s_sound.c:340` `pitch += 16 - (M_Random()&31);` (random sound-pitch variation), and `st_stuff.c:992` `st_randomnumber = M_Random();` (status-bar random face pick).
- `P_Random` (separate index `prndindex`) is used by everything gameplay: `p_enemy.c` 32 sites (aim jitter `(P_Random()-P_Random())<<20/<<21`, movecount, sound selection), `p_pspr.c` 11 (weapon spread `(P_Random()-P_Random())<<18`, damage `(P_Random()%10+1)<<1`, flash-frame `&1`), `p_mobj.c` 10 (`lastlook = P_Random()%MAXPLAYERS`, missile tics, nightmare respawn `P_Random() > 4`), `p_map.c` 4 (`damage = ((P_Random()%8)+1)*info->damage` in PIT_CheckThing ×2), `p_inter.c` 3 (pain chance, radius damage), `p_lights.c` 5, `p_spec.c` 1, `g_game.c` 1 (`i = P_Random() % selections` deathmatch spawn).
- Rationale: the two generators exist so *presentation-only* randomness (sound pitch, evil-grin face) cannot desync the simulation. **Port rule: gameplay code calls only `P_Random` (index `prndindex`); presentation may call `M_Random`; never `Math.random()`; save-states must capture both indices (`M_ClearRandom` zeroes both on new game).**

Confidence: High (table machine-parsed from source; counts from grep).

---

## 6. Player mobj parameters and view height

`info.c` mobjinfo for `MT_PLAYER` (verified):

```c
0,            // doomednum (players are spawned via type<=4 path)
S_PLAY,       100 /*spawnhealth*/, S_PLAY_RUN1 /*seestate*/,
0,            // reactiontime
S_PLAY_PAIN,  255 /*painchance*/, S_PLAY_ATK1 /*missilestate*/,
0,            // speed
16*FRACUNIT,  // radius
56*FRACUNIT,  // height
100,          // mass
MF_SOLID|MF_SHOOTABLE|MF_DROPOFF|MF_PICKUP|MF_NOTDMATCH,
```

- Radius **16*FRACUNIT**, height **56*FRACUNIT** (also `#define PLAYERRADIUS 16*FRACUNIT`, `p_local.h:47`).
- `#define VIEWHEIGHT (41*FRACUNIT)` (`p_local.h:34`). There is no `lookz` in 1.10 — `viewz = mo->z + player->viewheight + bob` (`P_CalcHeight`, `p_user.c:137`), clamped to `mo->ceilingz - 4*FRACUNIT`. Death squats `viewheight` to `6*FRACUNIT` (`P_DeathThink`, `p_user.c`).
- Player mobj angle at spawn: `mobj->angle = ANG45 * (mthing->angle/45);` (`p_mobj.c:P_SpawnPlayer`, verified).

Confidence: High.

---

## 7. Player movement: `P_MovePlayer`, `P_Thrust`, friction, bob

All `p_user.c` / `p_mobj.c` (verified).

```c
// p_user.c:59
void P_Thrust (player_t* player, angle_t angle, fixed_t move)
{
    angle >>= ANGLETOFINESHIFT;
    player->mo->momx += FixedMul(move,finecosine[angle]);
    player->mo->momy += FixedMul(move,finesine[angle]);
}

// p_user.c:P_MovePlayer
cmd = &player->cmd;
player->mo->angle += (cmd->angleturn<<16);
onground = (player->mo->z <= player->mo->floorz);
if (cmd->forwardmove && onground)
    P_Thrust (player, player->mo->angle, cmd->forwardmove*2048);
if (cmd->sidemove && onground)
    P_Thrust (player, player->mo->angle-ANG90, cmd->sidemove*2048);
if ( (cmd->forwardmove || cmd->sidemove)
     && player->mo->state == &states[S_PLAY] )
    P_SetMobjState (player->mo, S_PLAY_RUN1);
```

The `*2048` is the ticcmd `*2048 for move` comment realized: walk thrust = 25*2048 = **51200** (=0xC800), run = **102400**. Air control: none (thrust gated on `onground`). Teleport lockout: `if (player->mo->reactiontime) player->mo->reactiontime--; else P_MovePlayer (player);` (reactiontime 18 set by `P_Teleport` in `p_spec.c`; player mobjinfo reactiontime 0).

**Friction / stopping / speed cap** (`p_mobj.c:P_XYMovement`, verified):

```c
#define STOPSPEED		0x1000
#define FRICTION		0xe800
```

- Momentum capped first: `MAXMOVE = (30*FRACUNIT)` (`p_local.h:54`) per axis; moves greater than half MAXMOVE are split (`ptryx = mo->x + xmove/2` loop).
- Blocked player move → `P_SlideMove(mo)` ("try to slide along it"); blocked missile → `P_ExplodeMissile` (with sky-hack guard via `ceilingline`); blocked other → mom zeroed.
- No friction for `MF_MISSILE|MF_SKULLFLY`, none airborne (`mo->z > mo->floorz`); `MF_CORPSE` doesn't stop sliding halfway off a step (`mom > FRACUNIT/4 && floorz != sector floor`).
- If `|mom| < STOPSPEED (0x1000)` on both axes and (no player or no move keys) → mom = 0 and, if in a `S_PLAY_RUN1..RUN4` state, revert to `S_PLAY`; else `mo->momx = FixedMul (mo->momx, FRICTION);` (FRICTION = 0xe800/0x10000 = **0.90625** per tic). (Derived: terminal walk speed ≈ 51200/(1−0.90625) ≈ 546133 ≈ 8.33 map-units/tic ≈ 291 u/s; run ×2.) **There is no separate "too fast → SlideMove" check** — the brief's `P_IsTooFast` doesn't exist; the MAXMOVE clamp + failed `P_TryMove → P_SlideMove` is the actual mechanism.

**View bob** (`p_user.c:P_CalcHeight`, verified — there is no `P_Bob`; `bobmove`/0x0ccccccd belongs to the 1994 source):

```c
#define MAXBOB	0x100000	// 16 pixels of bob

player->bob = FixedMul (player->mo->momx, player->mo->momx)
              + FixedMul (player->mo->momy,player->mo->momy);
player->bob >>= 2;
if (player->bob>MAXBOB) player->bob = MAXBOB;

angle = (FINEANGLES/20*leveltime)&FINEMASK;
bob = FixedMul ( player->bob/2, finesine[angle]);
...
player->viewz = player->mo->z + player->viewheight + bob;
```

`viewheight` ramps via `deltaviewheight += FRACUNIT/4` per tic between `VIEWHEIGHT/2` and `VIEWHEIGHT`. Landing squat (`p_mobj.c:P_ZMovement`): if `player && momz < -GRAVITY*8` → `player->deltaviewheight = momz>>3; S_StartSound (mo, sfx_oof);`

Confidence: High.

---

## 8. Movement clipping: `P_CheckPosition`, `P_TryMove`, `P_TeleportMove`, sliding

`p_map.c` + `p_maputl.c` (verified). Shared module-static state: `tmbbox[4]`, `tmthing`, `tmflags`, `tmx/tmy`, `floatok`, `tmfloorz`, `tmceilingz`, `tmdropoffz`, `ceilingline`, `spechit[MAXSPECIALCROSS (8)]`, `numspechit`.

**`P_CheckPosition(mobj_t* thing, fixed_t x, fixed_t y)`** — "purely informative, nothing is modified (except things picked up)". Builds radius-box `tmbbox`, `newsubsec = R_PointInSubsector(x,y)`, seeds `tmfloorz = tmdropoffz = sector->floorheight; tmceilingz = sector->ceilingheight;`, `validcount++; numspechit = 0;`. `MF_NOCLIP → return true`. Then **things first** over block range extended by `MAXRADIUS (32*FRACUNIT)` ("mobj_ts are grouped into mapblocks based on their origin point") calling `P_BlockThingsIterator(bx,by,PIT_CheckThing)`, then **lines** over the unextended box via `P_BlockLinesIterator(bx,by,PIT_CheckLine)`. Block grid: `MAPBLOCKUNITS 128`, `MAPBLOCKSHIFT (FRACBITS+7)` (`p_local.h:38-42`). There is **no `BLOCKRADIUS` macro and no `P_IsInsideBlockmap`** in 1.10 — the old `BLOCKRADIUS` loop macros were replaced by the `blocklinks[]`/`blockmaplump` iterators (`p_maputl.c`, `validcount` dedup for lines).

- `PIT_CheckLine`: bbox reject → `P_BoxOnLineSide (tmbbox, ld) != -1` reject → one-sided (`!ld->backsector`) blocks (missiles included); non-missiles also blocked by `ML_BLOCKING`, monsters by `ML_BLOCKMONSTERS`; then `P_LineOpening(ld)` narrows `tmceilingz = min(opentop)`, `tmfloorz = max(openbottom)`, `tmdropoffz = min(lowfloor)`; special lines recorded into `spechit[]` ("specials are NOT sorted by order").
- `PIT_CheckThing`: distance test `abs(thing->x - tmx) >= radius+radius` reject; self-skip; `MF_SKULLFLY` → `damage = ((P_Random()%8)+1)*info->damage` then stop; missiles (over/under check via z+height; same-species rule incl. `MT_KNIGHT↔MT_BRUISER` equivalence; no self-hit); `MF_SPECIAL` + `tmflags&MF_PICKUP` → `P_TouchSpecialThing` (may delete the item); otherwise blocked iff `MF_SOLID`.

**`P_TryMove(mobj_t* thing, fixed_t x, fixed_t y)`** — signature `p_local.h:211` verified; **no dropoff parameter** in 1.10 (the `boolean dropoff` variant is from later id sources). Body:

```c
floatok = false;
if (!P_CheckPosition (thing, x, y))
    return false;		// solid wall or thing
if ( !(thing->flags & MF_NOCLIP) )
{
    if (tmceilingz - tmfloorz < thing->height)
	return false;	// doesn't fit
    floatok = true;
    if ( !(thing->flags&MF_TELEPORT)
	 &&tmceilingz - thing->z < thing->height)
	return false;	// mobj must lower itself to fit
    if ( !(thing->flags&MF_TELEPORT)
	 && tmfloorz - thing->z > 24*FRACUNIT )
	return false;	// too big a step up
    if ( !(thing->flags&(MF_DROPOFF|MF_FLOAT))
	 && tmfloorz - tmdropoffz > 24*FRACUNIT )
	return false;	// don't stand over a dropoff
}
```

then `P_UnsetThingPosition`; set `floorz/ceilingz/x/y`; `P_SetThingPosition`; then for each `spechit` line, if `P_PointOnLineSide` changed between old/new point and `ld->special`, `P_CrossSpecialLine (ld-lines, oldside, thing)`. **The step-up limit is the literal `24*FRACUNIT`** (no `MAXSTEP` define); the ledge/dropoff rule is the `tmfloorz - tmdropoffz > 24*FRACUNIT` test, refused unless `MF_DROPOFF|MF_FLOAT` (players have `MF_DROPOFF`, so they *can* walk off ledges; ordinary monsters cannot). There is no crush/stacking logic here: a monster crushed by a lowering floor is squeezed in `T_VerticalDoor/T_FloorPlat → P_ThingHeightClip` + `P_DamageMobj` callers in `p_floor.c/p_spec.c` (out of scope here). Pushers (`P_PushThings`) exist in `p_spec.c` (E1M6-style) — separate from TryMove.

**`P_TeleportMove(thing, x, y)`** (verified): same box seeding as CheckPosition, but uses `PIT_StompThing` — kills anything `MF_SHOOTABLE` in range: monsters never stomp (except `gamemap == 30`); players `P_DamageMobj (thing, tmthing, tmthing, 10000)`; always links the thing.

**Sliding (`P_SlideMove`, "This is a kludgy mess", verified).** No fixed "8 tics" and no 45° clamp in 1.10 (the `SLIDEFIXANGLE`-style constants belong to the 1994 leak). Actual algorithm:
1. Trace the three leading box corners: `P_PathTraverse (leadx/leady variants + mom, PT_ADDLINES, PTR_SlideTraverse)`.
2. `PTR_SlideTraverse`: one-sided front → blocking; two-sided: block if `openrange < height`, `opentop - z < height`, or `openbottom - z > 24*FRACUNIT`; keep closest blocking intercept `bestslidefrac/bestslideline` (2-best: `secondslidefrac/line` remembered).
3. If nothing hit (`bestslidefrac == FRACUNIT+1`) → **stairstep**: `if (!P_TryMove (mo, mo->x, mo->y + mo->momy)) P_TryMove (mo, mo->x + mo->momx, mo->y);`
4. Else `bestslidefrac -= 0x800` (fudge), move flush via `P_TryMove`, remainder `FRACUNIT-(bestslidefrac+0x800)`, then `P_HitSlideLine(bestslideline)` clips `tmxmove/tmymove` (axis-aligned: zero that component; else project: `newlen = FixedMul (movelen, finecosine[deltaangle]); tmxmove = FixedMul (newlen, finecosine[lineangle]); tmymove = FixedMul (newlen, finesine[lineangle]);`), `P_TryMove(x+tmxmove, y+tmymove)`, on failure `goto retry` — `if (++hitcount == 3) goto stairstep;` ("don't loop forever").

**`P_PathTraverse`** (`p_maputl.c:743`, verified): DDA over the 128-unit block grid (`MAPBLOCKSHIFT`, `FixedDiv(y2-y1, abs(x2-x1))` per-axis steps, `MAXINTERCEPTS 128` array, `validcount++`), accumulating `intercepts[]` sorted by insertion; `PIT_AddLineIntercepts`/`PIT_AddThingIntercepts` use the trace as a `divline_t` and compute crossing fraction with:

```c
// p_maputl.c:230
fixed_t P_InterceptVector (divline_t* v2, divline_t* v1)
{
    den = FixedMul (v1->dy>>8,v2->dx) - FixedMul(v1->dx>>8,v2->dy);
    if (den == 0)
	return 0;
    num = FixedMul ( (v1->x - v2->x)>>8 ,v1->dy )
                +FixedMul ( (v2->y - v1->y)>>8, v1->dx );
    frac = FixedDiv (num , den);
```

(the `>>8` pre-shifts avoid overflow at the cost of precision; `P_BoxOnLineSide` at `p_maputl.c:110` returns −1 when the box straddles, else 0/1 side).

```c
// p_maputl.c:49
fixed_t P_AproxDistance (fixed_t dx, fixed_t dy)
{
    dx = abs(dx); dy = abs(dy);
    if (dx < dy) return dx+dy-(dx>>1);
    return dx+dy-(dy>>1);
}
```

Also `P_TeleportMove`-adjacent: `P_ThingHeightClip` (crush check for sector movement, `p_map.c:536`).

Confidence: High.

---

## 9. Gravity and Z movement

`p_mobj.c:P_ZMovement` + `p_local.h` (verified):

```c
#define GRAVITY		FRACUNIT          // p_local.h:53  (= 1<<16, NOT 1<<15)
#define FLOATSPEED		(FRACUNIT*4)    // p_local.h:30
```

```c
mo->z += mo->momz;
if ( mo->flags & MF_FLOAT && mo->target) {   // float toward target height band
    dist = P_AproxDistance (...); delta =(mo->target->z + (mo->height>>1)) - mo->z;
    if (delta<0 && dist < -(delta*3) ) mo->z -= FLOATSPEED;
    else if (delta>0 && dist < (delta*3) ) mo->z += FLOATSPEED;
}
if (mo->z <= mo->floorz) {
    ...
    if (mo->momz < 0) {
	if (mo->player && mo->momz < -GRAVITY*8) {
	    mo->player->deltaviewheight = mo->momz>>3;   // squat + oof
	    S_StartSound (mo, sfx_oof);
	}
	mo->momz = 0;
    }
    mo->z = mo->floorz;
    ...missiles explode...
}
else if (! (mo->flags & MF_NOGRAVITY) ) {
    if (mo->momz == 0)
	mo->momz = -GRAVITY*2;
    else
	mo->momz -= GRAVITY;
}
if (mo->z + mo->height > mo->ceilingz) { if (mo->momz > 0) mo->momz = 0;
    mo->z = mo->ceilingz - mo->height; ... }
```

**Fall damage: there is NONE in released 1.10.** `A_Fall` (`p_enemy.c:1585`, verified) only does `actor->flags &= ~MF_SOLID;` ("actor is on ground, it can be walked over"). The hard-landing effect is cosmetic (`deltaviewheight` squat + `sfx_oof` above). The brief's "damage = (abs(momz) − 13*FRACUNIT)" is from the 1994/pre-1.5 leak & later 1.9 sources (`P_CheckFallDamage`-era); do **not** implement it if targeting 1.10 demo compatibility.

Confidence: High for 1.10 absence of fall damage; recalled (not verified here): the 1.9-source counterpart formula.

---

## 10. Thinkers

`p_tick.c` (verified). Single doubly-linked circular list headed/tailed by `thinker_t thinkercap;`:

```c
void P_InitThinkers (void) { thinkercap.prev = thinkercap.next = &thinkercap; }

void P_AddThinker (thinker_t* thinker)   // appended at list tail
{
    thinkercap.prev->next = thinker; thinker->next = &thinkercap;
    thinker->prev = thinkercap.prev; thinkercap.prev = thinker;
}

// "Deallocation is lazy -- it will not actually be freed until its thinking turn comes up."
void P_RemoveThinker (thinker_t* thinker) { thinker->function.acv = (actionf_v)(-1); }

void P_RunThinkers (void)
{
    currentthinker = thinkercap.next;
    while (currentthinker != &thinkercap)
    {
	if ( currentthinker->function.acv == (actionf_v)(-1) )
	{   // time to remove it
	    currentthinker->next->prev = currentthinker->prev;
	    currentthinker->prev->next = currentthinker->next;
	    Z_Free (currentthinker);
	}
	else
	{
	    if (currentthinker->function.acp1)
		currentthinker->function.acp1 (currentthinker);
	}
	currentthinker = currentthinker->next;
    }
}
```

Facts for the TS design:
- Removal sentinel is `(actionf_v)(-1)` — **not** NULL-function removal; `P_MobjThinker` re-checks `mobj->thinker.function.acv == (actionf_v) (-1)` after XY/Z movement to bail if freed mid-think.
- **No deferred queue (`p_deferedthinkers`), no `THRESHOLD 0x8000`, no 128-entry `DEVEREDTHINKERQUEUE`** in 1.10 — those are artifacts of the 1994 leak's two-list thinker system. (Confidence: high they are absent here: grep of all .c/.h finds no `defer` and `mobj->threshold` is only the monster aggro timer, `p_enemy.c:680-689` decrement/tick; `#define BASETHRESHOLD 100` `p_local.h:61` is a *chase* constant used in `p_enemy.c`.)
- **No "spawnqueue"** in 1.10. `P_AddThinker` call sites: mobjs (`p_mobj.c:531`) plus plat/floor/light thinker constructors (`p_spec.c:1194,1208`, `p_floor.c`, `p_plat.c`).
- Other thinker kinds share the list: plats, floors, lights, and the invisibility `psprite` helpers run via their own `function.acp1`.

Confidence: High.

---

## 11. `P_MobjThinker` — state timers, movement, respawn

`p_mobj.c:413` (verified, structure):

```c
if (mobj->momx || mobj->momy || (mobj->flags&MF_SKULLFLY) )
    { P_XYMovement (mobj);  if (removed sentinel) return; }
if ( (mobj->z != mobj->floorz) || mobj->momz )
    { P_ZMovement (mobj);   if (removed sentinel) return; }
if (mobj->tics != -1) {
    mobj->tics--;
    if (!mobj->tics)
	if (!P_SetMobjState (mobj, mobj->state->nextstate) )
	    return;		// freed itself
} else {
    // nightmare respawn: MF_COUNTKILL && respawnmonsters
    mobj->movecount++;
    if (mobj->movecount < 12*35) return;
    if ( leveltime&31 ) return;
    if (P_Random () > 4) return;
    P_NightmareRespawn (mobj);
}
```

- The XY move function's real name is **`P_XYMovement`** (not `P_XYMove`), Z is `P_ZMovement` (brief asked; these are the names).
- `P_SetMobjState` loops `do { ... if (st->action.acp1) st->action.acp1(mobj); state = st->nextstate; } while (!mobj->tics);` — multiple states can run in one tic; `S_NULL` → `P_RemoveMobj` (which nulls sector/block links, clears `player->mo->player` refs? — it calls `P_RemoveMobj` → `P_UnsetThingPosition` + `P_RemoveThinker`).
- MF_FLOAT z behaviour is inside `P_ZMovement` (§9), using `P_AproxDistance` distance-to-target bands, not `P_CheckSight`.
- `P_NightmareRespawn` re-spawns at `spawnpoint.x<<FRACBITS` if `P_CheckPosition` passes, with `MT_TFOG` fogs both ends and `mo->angle = ANG45 * (mthing->angle/45)`, `MF_AMBUSH` from `MTF_AMBUSH`, `reactiontime = 18`.
- `MF_SKULLFLY` (managed in `p_enemy.c:A_SPosAttack`/`P_SkullMove`-style code — lossless detail: set on lost-soul melee; XY movement with it set keeps calling `P_XYMovement` even at zero momentum, and `P_MobjThinker` slams damage in `P_MobjCheckPosition` path via PIT_CheckThing §8; when momentum fully stops the flag is cleared and `spawnstate` restored, `p_mobj.c:122-129`).

`P_SpawnMobj` (verified): zeroes memory, `mobj->lastlook = P_Random () % MAXPLAYERS;`, `reactiontime = info->reactiontime` unless `sk_nightmare`, floor/ceilingz from spawn subsector, `z == ONFLOORZ/ONCEILINGZ` resolution, `thinker.function.acp1 = (actionf_p1)P_MobjThinker`, `P_AddThinker`.

Confidence: High (MF_SKULLFLY detail summarized from `p_mobj.c`/`p_map.c`; enemy-side setter not quoted line-by-line).

---

## 12. Level setup and player spawning

`G_DoLoadLevel` (`g_game.c:445`, verified): sky flat (`SKYFLATNAME`) and sky texture selection (commercial: SKY1 `<12`, SKY2 `12..20`, SKY3 `≥21`), `levelstarttic = gametic`, `gamestate = GS_LEVEL`, dead players → `PST_REBORN`, frags cleared → `P_SetupLevel (gameepisode, gamemap, 0, gameskill)` → `displayplayer = consoleplayer; starttime = I_GetTime ();` input-state memsets.

`P_SetupLevel` (**`p_setup.c:584`** — not `g_game.c` in this tree; verified sequence):
1. `totalkills = totalitems = totalsecret = wminfo.maxfrags = 0; wminfo.partime = 180;` per-player kill/item/secret counts 0.
2. `players[consoleplayer].viewz = 1;` ("Initial height of PointOfView will be set by player think" — also used by `P_Ticker`'s menu-pause and `S_StartSound` first-frame guards).
3. `S_Start();` then `Z_FreeTags (PU_LEVEL, PU_PURGELEVEL-1);` then `P_InitThinkers();`
4. `W_Reload();` map lump name (`map%02i` / `E%dM%d`), `leveltime = 0;`
5. **"note: most of this ordering is important"**: `P_LoadBlockMap, P_LoadVertexes, P_LoadSectors, P_LoadSideDefs, P_LoadLineDefs, P_LoadSubsectors, P_LoadNodes, P_LoadSegs;` then `rejectmatrix` lump and `P_GroupLines()` (sector line-lists + sector bboxes with `MAXRADIUS`).
6. `bodyqueslot = 0; deathmatch_p = deathmatchstarts; P_LoadThings(lumpnum+ML_THINGS);`
7. If deathmatch: per in-game player `players[i].mo = NULL; G_DeathMatchSpawnPlayer (i);`
8. `iquehead = iquetail = 0;` (sector special queue), `P_SpawnSpecials();` (re-arms floor/plat/light thinkers, `P_SpawnSpecials` scans lines/sectors in `p_spec.c`), optional `R_PrecacheLevel();`.

There is **no `P_InitTags`** in 1.10 (no `P_ChangeTag` either — tagged sector movers were introduced later); 1.10 line specials look up their sectors directly via `ld->frontsector`/`backsector` and tag-search on demand via `P_FindFirstNonSecureLine`-style loops (out of scope).

**Things → players** (`p_mobj.c:P_SpawnMapThing`, verified): `type == 11` → `deathmatchstarts[]` (max 10); `type <= 4` → `playerstarts[mthing->type-1] = *mthing;` and, when not deathmatch, `P_SpawnPlayer(mthing)`. So **player starts are mapthing types 1-4** (`MT_PLAYER` doomednum is `-1`; the `type-1` indexes `players[]`). Skill filter for monsters: `bit = 1<<(gameskill-1)` (baby=1, nightmare=5→bit 4? exact: baby→bit 1, nightmare→bit 4, else `1<<(gameskill-1)`), `MTF_AMBUSH` (`options & 16`) skipped in non-net games.

`P_SpawnPlayer` (`p_mobj.c:642`, verified): `P_SpawnMobj (x,y,ONFLOORZ, MT_PLAYER)`; `mthing->type > 1` → `mobj->flags |= (mthing->type-1)<<MF_TRANSSHIFT` (`MF_TRANSSHIFT = 26`, `p_mobj.h:201`); `mobj->angle = ANG45*(mthing->angle/45)`; binds `p->mo`, `viewheight = VIEWHEIGHT`, resets `refire/damagecount/bonuscount/extralight/fixedcolormap/message`, `P_SetupPsprites(p)` (gives fists/pistol via first-psprite logic in `p_pspr.c`); deathmatch grants all cards; `ST_Start()/HU_Start()` for console player. Reborn path: `G_DoReborn` (single player reloads level via `ga_loadlevel`; netgame detaches corpse `mo->player = NULL`, body-queue ring `BODYQUESIZE`, `MT_TFOG` at `x+20*finecosine[an], y+20*finesine[an]`, then `P_SpawnPlayer` at `playerstarts[playernum]` / alternates).

Confidence: High.

---

## 13. Struct inventory for the TypeScript port

**`mobj_t`** (`p_mobj.h`, verified field list, in order):
`thinker (function + prev/next)`, `x, y, z (fixed)`, `snext/sprev` (sector render links), `angle (BAM)`, `sprite`, `frame`, `bnext/bprev` (blockmap links), `subsector`, `floorz`, `ceilingz`, `radius`, `height`, `momx`, `momy`, `momz`, `validcount`, `type`, `info*`, `tics`, `state`, `flags`, `health`, `movedir (0-7)`, `movecount`, `target`, `reactiontime`, `threshold`, `player*`, `lastlook`, `spawnpoint (mapthing_t)`, `tracer`.

**`player_t`** (`d_player.h`, verified, condensed): `mo`, `playerstate (PST_LIVE/DEAD/REBORN)`, `cmd (ticcmd_t)`, `viewz`, `viewheight`, `deltaviewheight`, `bob`, `health`, `armorpoints`, `armortype`, `powers[NUMPOWERS]`, `cards[NUMCARDS]`, `backpack`, `frags[4]`, `readyweapon`, `pendingweapon`, `weaponowned[]`, `ammo[]`, `maxammo[]`, `attackdown`, `usedown`, `cheats (CF_NOCLIP=1, CF_GODMODE=2, CF_NOMOMENTUM=4)`, `refire`, `killcount/itemcount/secretcount`, `message`, `damagecount`, `bonuscount`, `attacker`, `extralight`, `fixedcolormap`, `colormap`, `psprites[NUMPSPRITES]`, `didsecret`.

**MF_ flags** (`p_mobj.h`, verified values): `MF_SPECIAL=1, SOLID=2, SHOOTABLE=4, NOSECTOR=8, NOBLOCKMAP=16, AMBUSH=32, JUSTHIT=64, JUSTATTACKED=128, SPAWNCEILING=256, NOGRAVITY=512, DROPOFF=0x400, PICKUP=0x800, NOCLIP=0x1000, SLIDE=0x2000, FLOAT=0x4000, TELEPORT=0x8000, MISSILE=0x10000, DROPPED=0x20000, SHADOW=0x40000, NOBLOOD=0x80000, CORPSE=0x100000, INFLOAT=0x200000, COUNTKILL=0x400000, COUNTITEM=0x800000, SKULLFLY=0x1000000, NOTDMATCH=0x2000000, TRANSSHIFT=26`. (No `MF_MISSILE`-era `MF5`/`MF_COUNTKILL` gaps; no `MF_MISSILE=0x10000` duplicates.)

TS mapping note: `fixed_t` = int32 everywhere; model `angle_t` as `>>>0`-normalized number or BigInt-free int32 with `+0|0` care; `ticcmd_t.forwardmove/sidemove` must round-trip as int8, `angleturn` int16 (demo format keeps only high byte — replicate).

Confidence: High.

---

## 14. Determinism rules for our TypeScript core (synthesis)

1. One function advances sim: `G_Ticker` per 35 Hz game-tic; frames are decoupled (`TryRunTics`). Never advance on wall-clock.
2. Input arrives only as `ticcmd_t` rings `netcmds[4][BACKUPTICS=12]`; consistancy = opponent `mo->x` (or `rndindex`) echoed per tic.
3. All gameplay randomness from `P_Random` (`rndtable[prndindex]`, indices saved/restored); `M_Random` reserved for sound-pitch/status-face. No `Math.random`, no `Date.now` below the tic driver.
4. Arithmetic: exact 32-bit fixed point (emulate `>>` as arithmetic shift, `FixedMul` with 32×32→64 via BigInt or hi/lo split; `FixedDiv` = saturating guard then double-division truncation; `P_InterceptVector`'s `>>8` pre-shifts are part of the *bit-exact* recipe — don't "optimize" them away).
5. Thinker removal via sentinel `(actionf_v)(-1)`, lazy removal at next `P_RunThinkers` visit; `P_SetMobjState` may run several zero-tic states (with action calls) in one tic — replicate the loop.
6. Blockmap is 128-unit cells (`MAPBLOCKSHIFT = FRACBITS+7`); thing queries pad by `MAXRADIUS = 32*FRACUNIT`; line dedup via `validcount++`.

## Sources

All from https://raw.githubusercontent.com/id-Software/DOOM/master/linuxdoom-1.10/ :
`d_main.c`, `d_net.c/.h`, `d_event.h`, `d_ticcmd.h`, `d_player.h`, `doomdef.h`,
`g_game.c/.h`, `p_user.c`, `p_map.c`, `p_maputl.c`, `p_local.h`, `p_mobj.c/.h`,
`p_tick.c`, `p_setup.c`, `p_enemy.c`, `p_pspr.c`, `p_inter.c`, `p_spec.c`,
`m_fixed.c/.h`, `m_bbox.c`, `m_random.c`, `tables.c/.h`, `r_main.c`, `info.c`,
`i_system.h`, `i_video.c`.

Overall confidence: **High** — every constant above was read from fetched source.
Recalled/unverified (flagged inline): platform `I_GetTime` internals; the 1994-leak
counterparts (`THRESHOLD 0x8000`, `p_deferedthinkers`, `bobmove 0x0ccccc d`,
`dropoff` parameter, `SLIDEFIXANGLE`, fall damage `13*FRACUNIT`, `P_IsTooFast`)
which are asserted here only as *absent* from 1.10 (absence verified by grep).
