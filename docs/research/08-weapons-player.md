# R08: Weapons and the Player

Research notes for the TypeScript from-scratch recreation, based on the id Software GPL reference source (`linuxdoom-1.10`, i.e. the DOOM 1.9-era source drop). All facts below were read directly from local source in `/tmp/DOOM-master/linuxdoom-1.10/`.

## Table of contents

1. [Weapon state machine (p_pspr.c)](#1-weapon-state-machine-ppsprc)
2. [Per-weapon data and fire actions](#2-per-weapon-data-and-fire-actions)
3. [Hitscan and projectiles](#3-hitscan-and-projectiles)
4. [Ammo economy](#4-ammo-economy)
5. [Weapon switching and fire-hold](#5-weapon-switching-and-fire-hold)
6. [Powerups](#6-powerups)
7. [Damage & armor](#7-damage--armor--kickback)
8. [Player states, viewheight, death flow](#8-player-states-viewheight-death-flow)
9. [Cheats](#9-cheats)
10. [Player defaults](#10-player-defaults--g_playerreborn)
11. [Confidence](#11-confidence)
12. [Sources](#12-sources)

---

## 1. Weapon state machine (p_pspr.c)

### 1.1 Core constants (p_pspr.c:44-54)

```c
#define LOWERSPEED		FRACUNIT*6
#define RAISESPEED		FRACUNIT*6

#define WEAPONBOTTOM	128*FRACUNIT
#define WEAPONTOP		32*FRACUNIT

// plasma cells for a bfg attack
#define BFGCELLS		40
```

**Correction to task assumption:** lowering/raising speed is `FRACUNIT*6` per tic (6 units/tic), NOT `FRACUNIT/8`. The weapon travels from y=128 to y=32 (96 units), so lower/raise each take exactly **16 tics** (96/6).

### 1.2 P_SetPsprite (p_pspr.c:59-102)

Sets `psp->state/tics`, applies `misc1/misc2` coordinates if nonzero (the `x/y` fields in the state table), then calls the state's `action.acp2(player, psp)` and loops **while `psp->tics == 0`** ("an initial state of 0 could cycle through"). This is why 0-tic states like `S_CHAIN3`/`S_MISSILE3`/`S_SAW3` immediately execute their action (`A_ReFire`).

### 1.3 Raise/lower flow

- `P_BringUpWeapon` (p_pspr.c:135-152): if `pendingweapon == wp_nochange` it reuses `readyweapon`; plays `sfx_sawup` for the chainsaw; sets `psprites[ps_weapon].sy = WEAPONBOTTOM` and enters `weaponinfo[pendingweapon].upstate` (the `*_UP` state whose action is `A_Raise`).
- `A_Raise` (p_pspr.c:433-451): `psp->sy -= RAISESPEED;` returns while `sy > WEAPONTOP`; on arrival clamps `sy = WEAPONTOP` and transitions to `weaponinfo[readyweapon].readystate`.
- `A_Lower` (p_pspr.c:389-428): `psp->sy += LOWERSPEED;` returns while `sy < WEAPONBOTTOM`. At the bottom: if `playerstate == PST_DEAD` clamp and **do not bring back up**; if `!health` → `P_SetPsprite(player, ps_weapon, S_NULL)`; else `readyweapon = pendingweapon; P_BringUpWeapon(player)`.
- `P_FireWeapon` (p_pspr.c:196-209):

```c
void P_FireWeapon (player_t* player)
{
    statenum_t	newstate;

    if (!P_CheckAmmo (player))
	return;

    P_SetMobjState (player->mo, S_PLAY_ATK1);
    newstate = weaponinfo[player->readyweapon].atkstate;
    P_SetPsprite (player, ps_weapon, newstate);
    P_NoiseAlert (player->mo, player->mo);
}
```

So firing = player mobj goes to `S_PLAY_ATK1`, psprite jumps to the weapon's attack state chain (which ends in `A_ReFire` or `A_WeaponReady`), and the shot wakes monsters (`P_NoiseAlert`).

- `P_DropWeapon` (p_pspr.c:215-221): on death, just enters `downstate` (A_Lower keeps it down).

### 1.4 A_WeaponReady (p_pspr.c:234-296) — refire check + bob

```c
    // check for change
    //  if player is dead, put the weapon away
    if (player->pendingweapon != wp_nochange || !player->health)
    {
	newstate = weaponinfo[player->readyweapon].downstate;
	P_SetPsprite (player, ps_weapon, newstate);
	return;	
    }
    
    // check for fire
    //  the missile launcher and bfg do not auto fire
    if (player->cmd.buttons & BT_ATTACK)
    {
	if ( !player->attackdown
	     || (player->readyweapon != wp_missile
		 && player->readyweapon != wp_bfg) )
	{
	    player->attackdown = true;
	    P_FireWeapon (player);		
	    return;
	}
    }
    else
	player->attackdown = false;
    
    // bob the weapon based on movement speed
    angle = (128*leveltime)&FINEMASK;
    psp->sx = FRACUNIT + FixedMul (player->bob, finecosine[angle]);
    angle &= FINEANGLES/2-1;
    psp->sy = WEAPONTOP + FixedMul (player->bob, finesine[angle]);
```

Out-of-ammo handling is **not** in A_WeaponReady itself — it goes through `P_CheckAmmo` inside `P_FireWeapon` (which, on failure, sets `pendingweapon` and forces the `downstate`, so the next `A_WeaponReady`/`A_ReFire` sees `pendingweapon != wp_nochange` and lowers, then raises the new weapon). Missile launcher and BFG require releasing+repressing fire (`attackdown` latch).

**Bob formula (exact):** horizontal `sx = FRACUNIT + FixedMul(player->bob, finecosine[(128*leveltime)&FINEMASK])`; vertical `sy = WEAPONTOP + FixedMul(player->bob, finesine[(128*leveltime) & (FINEANGLES/2-1)])`. `player->bob` is momentum-derived (see §8.3). The bob is only applied in `A_WeaponReady` — there is **no `A_WeaponBob` function in DOOM 1.10** (that is Heretic), and no recoil-check function (`P_CheckNoRecoil` does not exist).

`P_CalcSwing` (p_pspr.c:107-127) with `swingx/swingy` and `angle = (FINEANGLES/70*leveltime)&FINEMASK` exists but is **dead code in 1.10** (no callers; `swingx/swingy` referenced nowhere else — verified by grep).

The flash psprite always mirrors the weapon psprite position: at the end of `P_MovePsprites` (p_pspr.c:872-875): `player->psprites[ps_flash].sx = player->psprites[ps_weapon].sx;` (same for `sy`).

### 1.5 A_ReFire (p_pspr.c:302-324)

```c
void A_ReFire (player_t* player, pspdef_t* psp)
{
    // check for fire
    //  (if a weaponchange is pending, let it go through instead
    //   instead of refire)
    if ( (player->cmd.buttons & BT_ATTACK) 
	 && player->pendingweapon == wp_nochange
	 && player->health)
    {
	player->refire++;
	P_FireWeapon (player);
    }
    else
    {
	player->refire = 0;
	P_CheckAmmo (player);
    }
}
```

`player->refire` counts held-fire repetitions; accuracy is `!player->refire` (only the first shot of a hold is accurate — see `P_GunShot`, §2). `refire` is reset to 0 when fire is released. `A_CheckReload` (p_pspr.c:326-337) just calls `P_CheckAmmo` (used by the super shotgun reload frames).

---

## 2. Per-weapon data and fire actions

`weaponinfo[NUMWEAPONS]` (d_items.c:42-138): `{ammo, upstate, downstate, readystate, atkstate, flashstate}`. Weapon enum order (doomdef.h): fist, pistol, shotgun, chaingun, missile, plasma, bfg, chainsaw, supershotgun; `wp_nochange = 9`.

State chain template: `READY(action A_WeaponReady) → DOWN(A_Lower) / UP(A_Raise)`; firing enters `atkstate`, last frame typically `A_ReFire` back to `atkstate` (hold) or `READY`.

### 2.1 State/tic tables (info.c states[] lines 138-225)

Format: sprite frame, tics, action. Ready/raise/lower frames are 1 tic each (chainsaw ready alternates S_SAW/S_SAWB at 4 tics).

| Weapon | Attack chain (frame,tics,action) | Full cycle tics | Fire occurs at |
|---|---|---|---|
| fist | PUNCH1(1,4) PUNCH2(2,4,**A_Punch**) PUNCH3(3,5) PUNCH4(2,4) PUNCH5(1,5,A_ReFire) | 22 | t=4 |
| pistol | PISTOL1(0,4) PISTOL2(1,6,**A_FirePistol**) PISTOL3(2,4) PISTOL4(1,5,A_ReFire) | 19 | t=4 |
| shotgun | SGUN1(0,3) SGUN2(0,7,**A_FireShotgun**) SGUN3-8(5,5,4,5,5,3) SGUN9(0,7,A_ReFire) | 44 | t=3 |
| chaingun | CHAIN1(0,4,**A_FireCGun**) CHAIN2(1,4,**A_FireCGun**) CHAIN3(1,0,A_ReFire) | 8 (2 shots) | t=0,4 |
| missile | MISSILE1(1,8,**A_GunFlash**) MISSILE2(1,12,**A_FireMissile**) MISSILE3(1,0,A_ReFire) | 20 | t=8 |
| plasma | PLASMA1(0,3,**A_FirePlasma**) PLASMA2(1,20,A_ReFire) | 23 | t=0 |
| bfg | BFG1(0,20,**A_BFGsound**) BFG2(1,10,A_GunFlash) BFG3(1,10,**A_FireBFG**) BFG4(1,20,A_ReFire) | 60 | t=30 |
| chainsaw | SAW1(0,4,**A_Saw**) SAW2(1,4,**A_Saw**) SAW3(1,0,A_ReFire) | 8 (2 bites) | t=0,4 |
| super sg | DSGUN1(0,3) DSGUN2(0,7,**A_FireShotgun2**) DSGUN3(1,7) DSGUN4(2,7,A_CheckReload) DSGUN5(3,7,A_OpenShotgun2) DSGUN6(4,7) DSGUN7(5,7,A_LoadShotgun2) DSGUN8(6,6) DSGUN9(7,6,A_CloseShotgun2) DSGUN10(0,5,A_ReFire) | 57 | t=3 |

Flash states: pistolflash(7), sgun flash1/2 (4+3), chainflash 5, missile flash 3+4+4+4, plasmaflash(4), bfgflash 11+6; every flash chain ends at `S_LIGHTDONE` = `{SPR_SHTG,4,0,{A_Light0},S_NULL}` which clears `extralight` (p_pspr.c:640-652: `A_Light0/1/2` set `player->extralight = 0/1/2` — muzzle flash lighting). The super shotgun reload sounds actions `A_OpenShotgun2`/`A_LoadShotgun2`/`A_CloseShotgun2` are defined in **p_enemy.c:1778-1805** (not p_pspr.c); `A_CloseShotgun2` plays `sfx_dbcls` then **calls `A_ReFire(player,psp)`** — the reload cycle can chain directly into another shot.

### 2.2 Fire actions (all p_pspr.c)

**A_Punch** (p_pspr.c:352-380): `damage = (P_Random()%10+1)<<1;` (2–20, even numbers); if `powers[pw_strength]` then `damage *= 10` (berserk: 20–200). Angle jitter `angle += (P_Random()-P_Random())<<18;`, `slope = P_AimLineAttack(mo, angle, MELEERANGE)` (MELEERANGE = `64*FRACUNIT`, p_local.h:57), then `P_LineAttack(...)`. On hit: `sfx_punch` and the player turns to face the target (`R_PointToAngle2`).

**A_Saw** (p_pspr.c:385-432): `damage = 2*(P_Random()%10+1)` (2–20); uses `MELEERANGE+1` ("so the puff doesn't skip the flash"). On hit (`sfx_sawhit`) it rotates the player toward the target by at most `ANG90/20` per bite (with `ANG90/21` snap fallback) and sets `MF_JUSTATTACKED` — which in `P_PlayerThink` (p_user.c:250-257) forces a forward move of `0xc800/512` so you lunge onto the sawn enemy. No pain-force formula exists in the player saw code itself; the knockback comes generically from `P_DamageMobj` thrust (§7).

**A_FirePistol** (p_pspr.c:525-544): sound `sfx_pistol`; `P_SetMobjState(player->mo, S_PLAY_ATK2)`; ammo −1; sets flash psprite; `P_BulletSlope(mo)` then `P_GunShot(mo, !player->refire)`.

**A_FireShotgun** (p_pspr.c:549-572): `sfx_shotgn`; ammo −1; flash; then

```c
    P_BulletSlope (player->mo);
    for (i=0 ; i<7 ; i++)
	P_GunShot (player->mo, false);
```

7 pellets, all unspread? No — `accurate=false` → each pellet gets `(P_Random()-P_Random())<<18` angle jitter.

**A_FireShotgun2** (p_pspr.c:577-610): ammo −= 2; 20 pellets; per-pellet `damage = 5*(P_Random()%3+1)`, angle jitter `<<19` (half the pistol/shotgun spread), plus vertical jitter `bulletslope + ((P_Random()-P_Random())<<5)`.

**A_FireCGun** (p_pspr.c:615-638): `sfx_pistol`; early-out `if (!player->ammo[...]) return;`; ammo −1; **flash state variant trick:** `P_SetPsprite(player, ps_flash, weaponinfo[...].flashstate + psp->state - &states[S_CHAIN1]);` — picks CHAINFLASH1/2 depending on whether the shot came from CHAIN1 or CHAIN2. Then `P_BulletSlope` + `P_GunShot(mo, !player->refire)`.

**A_FireMissile** (p_pspr.c:437-444): ammo −1; `P_SpawnPlayerMissile(mo, MT_ROCKET)`.

**A_FirePlasma** (p_pspr.c:465-480): ammo −1; flash sprite variant `flashstate+(P_Random()&1)` (PLASMAFLASH1 or 2); `P_SpawnPlayerMissile(mo, MT_PLASMA)`.

**A_FireBFG** (p_pspr.c:453-460): `ammo -= BFGCELLS` (40 cells); `P_SpawnPlayerMissile(mo, MT_BFG)`.

**P_GunShot** (p_pspr.c:505-519):

```c
    damage = 5*(P_Random ()%3+1);	// 5, 10 or 15
    angle = mo->angle;
    if (!accurate)
	angle += (P_Random()-P_Random())<<18;
    P_LineAttack (mo, angle, MISSILERANGE, bulletslope, damage);
```

MISSILERANGE = `32*64*FRACUNIT` (2048 units). Note hitscan weapons use `P_BulletSlope`'s auto-aim but full `MISSILERANGE` travel.

**A_BFGSpray** (p_pspr.c:657-689, full quote) — called by `S_BFGLAND3` (info.c:255):

```c
void A_BFGSpray (mobj_t* mo) 
{
    int			i; int j; int damage; angle_t an;
	
    // offset angles from its attack angle
    for (i=0 ; i<40 ; i++)
    {
	an = mo->angle - ANG90/2 + ANG90/40*i;

	// mo->target is the originator (player)
	//  of the missile
	P_AimLineAttack (mo->target, an, 16*64*FRACUNIT);

	if (!linetarget)
	    continue;

	P_SpawnMobj (linetarget->x, linetarget->y,
		     linetarget->z + (linetarget->height>>2), MT_EXTRABFG);
	
	damage = 0;
	for (j=0;j<15;j++)
	    damage += (P_Random()&7) + 1;

	P_DamageMobj (linetarget, mo->target, mo->target, damage);
    }
}
```

40 rays over a 90° arc (2.25° apart), range 1024 units, damage = 15 dice of 1–8 (mean ~67.5) per ray target.

### 2.3 Projectile stat block (info.c mobjinfo)

| Type | speed | radius | height | damage | notes |
|---|---|---|---|---|---|
| MT_ROCKET | 20*FRACUNIT | 11 | 8 | 20 | MF_MISSILE\|MF_DROPOFF\|MF_NOGRAVITY, seesound sfx_rlaunc |
| MT_PLASMA | 25*FRACUNIT | 13 | 8 | 5 | |
| MT_BFG | 25*FRACUNIT | 13 | 8 | 100 | death S_BFGLAND → A_BFGSpray |
| MT_PUFF | 0 | 20 | 16 | 0 | MF_NOBLOCKMAP\|MF_NOGRAVITY |
| MT_BLOOD | 0 | 20 | 16 | 0 | MF_NOBLOCKMAP (gravity) |

Area damage for rockets/plasma/BFG is done in `P_RadiusAttack` (p_enemy.c, covered in R07).

---

## 3. Hitscan and projectiles

**Naming correction:** in linuxdoom-1.10 there are no `P_AimTraverse`/`P_ShootTraverse` and **no `BADANGLE`** (those are Heretic/Boom-era names). The 1.10 traversal is generic: `P_PathTraverse(x1,y1,x2,y2,flags,trav)` (p_maputl.c:736+) walking BSP intercepts, with callbacks `PTR_AimTraverse` / `PTR_ShootTraverse` (p_map.c) selected by the caller.

### 3.1 P_AimLineAttack (p_map.c:1020-1053, full quote)

```c
fixed_t P_AimLineAttack (mobj_t* t1, angle_t angle, fixed_t distance)
{
    fixed_t	x2; fixed_t y2;
	
    angle >>= ANGLETOFINESHIFT;
    shootthing = t1;
    
    x2 = t1->x + (distance>>FRACBITS)*finecosine[angle];
    y2 = t1->y + (distance>>FRACBITS)*finesine[angle];
    shootz = t1->z + (t1->height>>1) + 8*FRACUNIT;

    // can't shoot outside view angles
    topslope = 100*FRACUNIT/160;	
    bottomslope = -100*FRACUNIT/160;
    
    attackrange = distance;
    linetarget = NULL;
	
    P_PathTraverse ( t1->x, t1->y, x2, y2,
		     PT_ADDLINES|PT_ADDTHINGS, PTR_AimTraverse );
		
    if (linetarget)
	return aimslope;
    return 0;
}
```

Autoaim cone: slope in ±(100/160) = ±0.625 (≈ ±32°). Shot origin z = `z + height/2 + 8*FRACUNIT` (player: +36). `PTR_AimTraverse` (p_map.c:812-905) narrows the visible [bottomslope, topslope] band through two-sided gaps (`P_LineOpening`) and, on a `MF_SHOOTABLE` thing whose slope range intersects the band, sets `aimslope = (thingtopslope+thingbottomslope)/2` and stops.

### 3.2 P_LineAttack (p_map.c:1058-1088)

Same setup (`shootz`, `aimslope = slope`, `la_damage = damage`, `attackrange = distance`) then `P_PathTraverse(..., PT_ADDLINES|PT_ADDTHINGS, PTR_ShootTraverse)`. `damage == 0` means a test trace.

### 3.3 PTR_ShootTraverse (p_map.c:910-1013, key excerpts)

- Lines: **`if (li->special) P_ShootSpecialLine (shootthing, li);`** — every line crossed gets its shooting-special fired (doors/switches) before the block test. Two-sided openness test vs `aimslope` decides continue/hit. On hit: `frac = in->frac - FixedDiv (4*FRACUNIT,attackrange);` (impact point pulled back 4 units), `z = shootz + FixedMul(aimslope, FixedMul(frac, attackrange))`; sky walls suppress puffs (also "sky hack" both-sides-sky); then `P_SpawnPuff(x,y,z)` and stop.
- Things: skip self / non-`MF_SHOOTABLE`; over/under tests vs `aimslope`; on hit `frac = in->frac - FixedDiv (10*FRACUNIT,attackrange)` (10 units closer); `MF_NOBLOOD ? P_SpawnPuff : P_SpawnBlood(x,y,z,la_damage)`; `if (la_damage) P_DamageMobj(th, shootthing, shootthing, la_damage);`.

### 3.4 P_SpawnPuff / P_SpawnBlood

**Note:** `P_SpawnPuff`/`P_SpawnBlood` are defined in **p_mobj.c** (not p_map.c, where they are only called). Quotes (p_mobj.c:807-860):

```c
void P_SpawnPuff (fixed_t x, fixed_t y, fixed_t z)
{
    z += ((P_Random()-P_Random())<<10);
    th = P_SpawnMobj (x,y,z, MT_PUFF);
    th->momz = FRACUNIT;
    th->tics -= P_Random()&3;
    if (th->tics < 1) th->tics = 1;
    // don't make punches spark on the wall
    if (attackrange == MELEERANGE)
	P_SetMobjState (th, S_PUFF3);
}

void P_SpawnBlood (fixed_t x, fixed_t y, fixed_t z, int damage)
{
    z += ((P_Random()-P_Random())<<10);
    th = P_SpawnMobj (x,y,z, MT_BLOOD);
    th->momz = FRACUNIT*2;
    th->tics -= P_Random()&3;
    if (th->tics < 1) th->tics = 1;
    if (damage <= 12 && damage >= 9)
	P_SetMobjState (th,S_BLOOD2);
    else if (damage < 9)
	P_SetMobjState (th,S_BLOOD3);
}
```

z jitter: `(P_Random()-P_Random())<<10` (±~2 units). Puff rises (`momz = FRACUNIT`), blood launches upward faster (`2*FRACUNIT`, gravity applies). Small-damage blood uses the smaller sprites (S_BLOOD2/3).

### 3.5 P_BulletSlope (p_pspr.c:487-505)

```c
    an = mo->angle;
    bulletslope = P_AimLineAttack (mo, an, 16*64*FRACUNIT);
    if (!linetarget) {
	an += 1<<26;
	bulletslope = P_AimLineAttack (mo, an, 16*64*FRACUNIT);
	if (!linetarget) {
	    an -= 2<<26;
	    bulletslope = P_AimLineAttack (mo, an, 16*64*FRACUNIT);
	}
    }
```

Three traces: straight, +1/16 rev? (`1<<26` of 2^32 = 5.625°), then −2×. If nothing found, `bulletslope` stays 0.

### 3.6 Projectiles (p_mobj.c)

**P_SpawnMissile** (p_mobj.c:886-925, monster-style aim at a dest thing):

```c
    th = P_SpawnMobj (source->x, source->y,
		      source->z + 4*8*FRACUNIT, type);   // z = z + 32
    ...
    th->target = source;
    an = R_PointToAngle2 (source->x, source->y, dest->x, dest->y);
    // fuzzy player
    if (dest->flags & MF_SHADOW)
	an += (P_Random()-P_Random())<<20;
    th->angle = an;
    an >>= ANGLETOFINESHIFT;
    th->momx = FixedMul (th->info->speed, finecosine[an]);
    th->momy = FixedMul (th->info->speed, finesine[an]);
    dist = P_AproxDistance (dest->x - source->x, dest->y - source->y);
    dist = dist / th->info->speed;
    if (dist < 1) dist = 1;
    th->momz = (dest->z - source->z) / dist;
    P_CheckMissileSpawn (th);
```

(There is **no `P_SpawnMissileAngle` in 1.10** — that name is from later sources; the angle/slope variant is `P_SpawnPlayerMissile`.)

**P_SpawnPlayerMissile** (p_mobj.c:931-980): auto-aims exactly like P_BulletSlope but over `16*64*FRACUNIT`, with an extra fallback `if (!linetarget after both tries) { an = source->angle; slope = 0; }`. Spawn z again `source->z + 4*8*FRACUNIT`; **momz = `FixedMul( th->info->speed, slope)`** — this is how player rockets inherit the aim slope. `P_CheckMissileSpawn` (p_mobj.c:863-880) randomizes tics −(0..3), nudges position by `mom>>1` and `P_TryMove`s (exploding if blocked).

---

## 4. Ammo economy

### 4.1 Tables (p_inter.c:55-58)

```c
// a weapon is found with two clip loads,
// a big item has five clip loads
int	maxammo[NUMAMMO] = {200, 50, 300, 50};
int	clipammo[NUMAMMO] = {10, 4, 20, 1};
```

Indexed `am_clip, am_shell, am_cell, am_misl`:

| Ammo | Max (default) | Max (backpack) | Clip load | Half clip (dropped clip pickup) |
|---|---|---|---|---|
| Bullets (am_clip) | 200 | 400 | 10 | 5 |
| Shells (am_shell) | 50 | 100 | 4 | 2 |
| Cells (am_cell) | 300 | 600 | 20 | 10 |
| Rockets (am_misl) | 50 | 100 | 1 | 0 (`clipammo/2` = 0!) |

There is **no separate "reserve" pool** in DOOM — one carrying count per ammo type (the reserve/carrying split is a Doom 64/Heretic concept). Backpack pickup (p_inter.c:620-633): first time doubles `player->maxammo[i]` for all 4 types, then gives 1 clip load of each.

### 4.2 P_GiveAmmo (p_inter.c:75-152)

`num` is **clip loads**, not units: `num ? num *= clipammo[ammo] : num = clipammo[ammo]/2`. In `sk_baby`/`sk_nightmare`, `num <<= 1` (double pickups). Clamped to `player->maxammo[ammo]`; returns false immediately if already at max. If ammo went 0→nonzero, may auto-select a better weapon (`am_clip`: fist→chaingun/pistol; `am_shell`: fist/pistol→shotgun; `am_cell`: fist/pistol→plasma; `am_misl`: fist→missile — auto-upgrade only from the fist, never interrupting a shooting weapon. Source quirk: the `am_misl` case lacks its own `break` and falls into `default: break;` — harmless since it is the last case).

Ammo pickup amounts by sprite (P_TouchSpecialThing): CLIP = 1 load (dropped CLIP = half, i.e. `num=0`), AMMO box = 5 loads, SHEL = 1, SBOX = 5, CELL = 1, CELP = 5, ROCK = 1, BROK = 5.

### 4.3 P_CheckAmmo (p_pspr.c:159-236, quoted in §1 context)

Cost per shot check: BFG needs `BFGCELLS`(40) cells, super shotgun 2 shells, others 1. When out of ammo it sets `pendingweapon` in this exact preference order: **plasma (cell>0, not shareware) → supershotgun (shell>2, commercial only) → chaingun (clip) → shotgun (shell) → pistol (clip) → chainsaw (owned) → missile (misl) → BFG (cell>40, not shareware) → fist**. Then forces the current weapon's `downstate`. Note pistol needs no `weaponowned` check (it is the fallback weapon) — see source: `else if (player->ammo[am_clip]) player->pendingweapon = wp_pistol;`.

---

## 5. Weapon switching and fire-hold

### 5.1 Keys 1-7/8 (g_game.c G_BuildTiccmd, lines 341-347)

```c
    // chainsaw overrides 
    for (i=0 ; i<NUMWEAPONS-1 ; i++)        
	if (gamekeydown['1'+i]) 
	{ 
	    cmd->buttons |= BT_CHANGE; 
	    cmd->buttons |= i<<BT_WEAPONSHIFT; 
	    break; 
	}
```

`NUMWEAPONS-1 = 8` → keys '1'..'8' map to weapon indices 0..7 (fist..chainsaw). **There is no cycle-to-next-usable loop in 1.10** — the "for (i=0…)" above is the key-to-slot encoder; the "press 1 again for chainsaw" behavior is instead handled in `P_PlayerThink` (p_user.c:297-305): pressing fist-slot upgrades to chainsaw if owned (unless already chainsaw with berserk). Similarly in Doom 2, slot 2 upgrades shotgun→supershotgun (p_user.c:307-314). Buttons layout (d_event.h:75-92): `BT_ATTACK=1, BT_USE=2, BT_CHANGE=4, BT_WEAPONMASK=(8+16+32), BT_WEAPONSHIFT=3`. The actual switch happens in `P_PlayerThink` (p_user.c:291-323): if `weaponowned[newweapon] && newweapon != readyweapon` (and not plasma/BFG in shareware) → `player->pendingweapon = newweapon`; psprite lowering/raising is deferred to `A_WeaponReady`.

### 5.2 Fire-hold interplay

- `G_BuildTiccmd` sets `BT_ATTACK` whenever fire key/mouse held (g_game.c:331-333).
- `A_WeaponReady`: the `attackdown` latch makes non-missile weapons refire on hold; for missile/BFG the latch only blocks firing *directly from the ready state* (`!attackdown || (readyweapon != wp_missile && != wp_bfg)`). Once a shot has been fired, the animation reaches `S_MISSILE3`/`S_BFG4` (0-tic) and `A_ReFire` — which has no latch — refires while `BT_ATTACK` stays held, so in vanilla holding fire DOES keep launching rockets/BFG (every ~20/60 tics). Releasing fire clears `attackdown` (`else player->attackdown = false;`).
- `player->attackdown`/`usedown` mirror last-tic button state (d_player.h comment "True if button down last tic").
- Mouse double-click forwards/strafe synthesizes `BT_USE` (g_game.c:350-395), unrelated to weapons.

---

## 6. Powerups

### 6.1 Enum (doomdef.h:213-222; the powers array is declared in d_player.h `int powers[NUMPOWERS]` — the enum itself lives in doomdef.h, NOT d_player.h)

```c
typedef enum
{
    pw_invulnerability,
    pw_strength,
    pw_invisibility,
    pw_ironfeet,
    pw_allmap,
    pw_infrared,
    NUMPOWERS
} powertype_t;
```

Durations (doomdef.h:235-238): `INVULNTICS = 30*TICRATE` (1050), `INVISTICS = 60*TICRATE` (2100), `INFRATICS = 120*TICRATE` (4200), `IRONTICS = 60*TICRATE` (2100); TICRATE=35.

### 6.2 P_GivePower (p_inter.c:330-371)

```c
    if (power == pw_invulnerability) { player->powers[power] = INVULNTICS; return true; }
    if (power == pw_invisibility) { player->powers[power] = INVISTICS;
                                    player->mo->flags |= MF_SHADOW; return true; }
    if (power == pw_infrared)  { player->powers[power] = INFRATICS; return true; }
    if (power == pw_ironfeet)  { player->powers[power] = IRONTICS;  return true; }
    if (power == pw_strength)  { P_GiveBody (player, 100);
                                 player->powers[power] = 1; return true; }
    if (player->powers[power]) return false;	// already got it
    player->powers[power] = 1;
    return true;
```

Note: berserk heals via `P_GiveBody(player,100)` which **caps health at MAXHEALTH = 100** in 1.10 (health does not jump to 200 here; bonuses/soulsphere use direct `+100` with a 200 cap). Berserk also force-selects the fist: in `P_TouchSpecialThing` SPR_PSTR case, `if (player->readyweapon != wp_fist) player->pendingweapon = wp_fist;` (p_inter.c:493-499).

Countdown/expiration per tic (p_user.c:320-337): strength counts *up* (used for the fade-out flash `12 - (powers[pw_strength]>>6)` in ST_doPaletteStuff); invisibility expiry clears `MF_SHADOW`; fixedcolormap selection in `P_PlayerThink` (p_user.c:348-372):

```c
    if (player->powers[pw_invulnerability]) {
	if (player->powers[pw_invulnerability] > 4*32
	    || (player->powers[pw_invulnerability]&8) )
	    player->fixedcolormap = INVERSECOLORMAP;   // #define INVERSECOLORMAP 32
	else player->fixedcolormap = 0;
    }
    else if (player->powers[pw_infrared]) { ... fixedcolormap = 1; ... }
    else player->fixedcolormap = 0;
```

### 6.3 Rendering effects

- **fixedcolormap consumption** (r_main.c:847-859): `fixedcolormap = colormaps + player->fixedcolormap*256*sizeof(lighttable_t);` and everything (walls via r_bsp/r_segs, floors r_plane, sprites r_things:583,722) uses it. So invulnerability is **colormap index 32 = INVERSECOLORMAP (negative/inverted colors)** — NOT a red map; the "red" pain flash is a *palette* effect (ST_doPaletteStuff, §7). Infrared uses colormap 1 (near-full-bright ramp).
- **Invisibility fuzz** (r_things.c:578-583 + r_draw.c:263-362): `if (thing->flags & MF_SHADOW) vis->colormap = NULL;` → `R_DrawMaskedColumn` fuzz path `*dest = colormaps[6*256+dest[fuzzoffset[fuzzpos]]];` — a 128-entry `fuzzoffset` jitter table cycling per column, using translation table 6. Monsters also miss a fuzzed player: `P_SpawnMissile` adds `(P_Random()-P_Random())<<20` angle jitter (p_mobj.c).
- **Infrared also** brightens via `fixedcolormap`; `extralight` (gun flashes, A_Light0/1/2) is a separate additive light-level bump: `lightnum = (sector->lightlevel >> LIGHTSEGSHIFT)+extralight` (r_segs.c:122, r_things.c:628).
- **allmap** is not a cheat flag: automap `AM_drawLines` checks `else if (plr->powers[pw_allmap])` (am_map.c:1160) to show lines not yet in `ML_MAPPED` (respecting `LINE_NEVERSEE` unless `cheating`).

---

## 7. Damage & armor

### 7.1 Player branch of P_DamageMobj (p_inter.c:780-838, full quote)

```c
    player = target->player;
    if (player && gameskill == sk_baby)
	damage >>= 1; 	// take half damage in trainer mode

    // (thrust block, see 7.2)

    // player specific
    if (player)
    {
	// end of game hell hack
	if (target->subsector->sector->special == 11
	    && damage >= target->health)
	{
	    damage = target->health - 1;
	}
	
	// Below certain threshold,
	// ignore damage in GOD mode, or with INVUL power.
	if ( damage < 1000
	     && ( (player->cheats&CF_GODMODE)
		  || player->powers[pw_invulnerability] ) )
	{
	    return;
	}
	
	if (player->armortype)
	{
	    if (player->armortype == 1)
		saved = damage/3;
	    else
		saved = damage/2;
	    
	    if (player->armorpoints <= saved)
	    {
		// armor is used up
		saved = player->armorpoints;
		player->armortype = 0;
	    }
	    player->armorpoints -= saved;
	    damage -= saved;
	}
	player->health -= damage; 	// mirror mobj health here for Dave
	if (player->health < 0)
	    player->health = 0;
	
	player->attacker = source;
	player->damagecount += damage;	// add damage after armor / invuln

	if (player->damagecount > 100)
	    player->damagecount = 100;	// teleport stomp does 10k points...
	
	temp = damage < 100 ? damage : 100;

	if (player == &players[consoleplayer])
	    I_Tactile (40,10,40+temp*2);
    }
```

- Green armor (armortype 1, 100 pts): absorbs 1/3; Mega (type 2, 200 pts): 1/2. Armor points consumed = saved; running out zeroes `armortype` (visual armor icon disappears).
- God mode flag: **`CF_GODMODE = 2`** (d_player.h cheat_t: `CF_NOCLIP=1, CF_GODMODE=2, CF_NOMOMENTUM=4`). The task's "GF_GODMODE" is a Boom/Heretic name.
- Invulnerability absorbs all damage < 1000 (same return path). Sector special 11 = "10+ damages you to 1 health" end-game hack.
- Red flash: `damagecount` (1..100) decays −1/tic in `P_PlayerThink`; `ST_doPaletteStuff` (st_stuff.c:1000-1045): `palette = (cnt+7)>>3; if (palette >= NUMREDPALS(8)) palette = NUMREDPALS-1; palette += STARTREDPALS(1);` → red PLAYPAL ranges 1-8; pickup flash: `(bonuscount+7)>>3 + STARTBONUSPALS(9)` (4 palettes); radiation suit: palette 13 (RADIATIONPAL) flicker condition `> 4*32 || &8`.
- Pain: `P_DamageMobj` bottom (p_inter.c:881-890): if `P_Random() < painchance` (MT_PLAYER painchance **255**, so always, unless SKULLFLY) → `P_SetMobjState(target, painstate)` = `S_PLAY_PAIN` (4+4 tics, `A_Pain` on frame 2 plays `sfx_plpain` — p_enemy.c:1577-1581 `A_Pain` is just `S_StartSound(actor, info->painsound)`).

### 7.2 Kickback / thrust (p_inter.c:748-778)

```c
	ang = R_PointToAngle2 (inflictor->x, inflictor->y,
			       target->x, target->y);
	thrust = damage*(FRACUNIT>>3)*100/target->info->mass;

	// make fall forwards sometimes
	if ( damage < 40
	     && damage > target->health
	     && target->z - inflictor->z > 64*FRACUNIT
	     && (P_Random ()&1) )
	{
	    ang += ANG180;
	    thrust *= 4;
	}
		
	ang >>= ANGLETOFINESHIFT;
	target->momx += FixedMul (thrust, finecosine[ang]);
	target->momy += FixedMul (thrust, finesine[ang]);
```

**Note:** the task's `FixedDiv(P_AproxDistance(...))` kickback formula is **not** in 1.10; this is it (`damage * 0.125 * 100 / mass`; player mass 100 → thrust = damage/8 in fixed units). Applied to any mobj (players included) when `inflictor` present and source weapon isn't the chainsaw; skipped when target has MF_NOCLIP.

---

## 8. Player states, viewheight, death flow

### 8.1 MT_PLAYER + S_PLAY_* (info.c)

MT_PLAYER (info.c:1108-1134): radius 16, height 56, mass 100, spawnhealth 100, painchance 255, painsound sfx_plpain, death S_PLAY_DIE1, xdeath S_PLAY_XDIE1, flags `MF_SOLID|MF_SHOOTABLE|MF_DROPOFF|MF_PICKUP|MF_NOTDMATCH`.

States (info.c:285-305):

| State | frame | tics | action | next |
|---|---|---|---|---|
| S_PLAY (stand) | 0 | **-1** | — | S_NULL (freeze) |
| S_PLAY_RUN1..4 | 0,1,2,3 | 4 each | — | loops |
| S_PLAY_ATK1 | 4 | 12 | — | S_PLAY_ATK2 |
| S_PLAY_ATK2 | 32773 | 6 | — | S_PLAY_ATK1 |
| S_PLAY_PAIN/2 | 6 | 4,4 | —, A_Pain | → S_PLAY |
| S_PLAY_DIE1..7 | 7..13 | 10 each (DIE2 A_PlayerScream, DIE3 A_Fall; DIE7 tics -1) | | |
| S_PLAY_XDIE1.. | 14.. | 5 each (XDIE2 A_XScream, XDIE3 A_Fall) | | |

No `A_Light*` in player walk states — walking frames have no action.

### 8.2 Viewheight

`VIEWHEIGHT = 41*FRACUNIT` (p_local.h:34). Player mobj spawn sets `p->viewheight = VIEWHEIGHT` (p_mobj.c:683). Movement: `P_CalcHeight` (p_user.c:78-137) — bob `player->bob = (momx²+momy²) >> 2` capped at `MAXBOB = 0x100000`; bob wave `angle = (FINEANGLES/20*leveltime)&FINEMASK; bob = FixedMul(player->bob/2, finesine[angle])`; squat via `deltaviewheight += FRACUNIT/4` recovering `viewheight` between `VIEWHEIGHT` and `VIEWHEIGHT/2`; `viewz = z + viewheight + bob` clamped to `ceilingz-4*FRACUNIT`. Landing/step-down adjust viewheight in p_mobj.c:254-257 (`viewheight -= floorz - z; deltaviewheight = (VIEWHEIGHT - viewheight)>>3`).

### 8.3 Death flow

- `P_KillMobj` (p_inter.c:690-706): `playerstate = PST_DEAD`, `flags &= ~MF_SOLID`, `P_DropWeapon` (weapon psprite lowers and stays down — `A_Lower` returns early on `PST_DEAD`), automap stopped if active. `A_PlayerScream` (p_enemy.c:1994-2008, called by S_PLAY_DIE2) **only plays the sound** (`sfx_pdiehi` if commercial and health < -50); it does NOT drop the view.
- The view dropping is in `P_DeathThink` (p_user.c:168-201, called from `P_PlayerThink` when `PST_DEAD`): `if (player->viewheight > 6*FRACUNIT) player->viewheight -= FRACUNIT;` floor at `6*FRACUNIT` ("fall on your face"); turns toward `player->attacker` at `ANG5 = ANG90/18` per tic, fading `damagecount` once facing killer; **`if (player->cmd.buttons & BT_USE) player->playerstate = PST_REBORN;`** ("press use to restart").
- `G_Ticker` (g_game.c:613-614): `if (playeringame[i] && players[i].playerstate == PST_REBORN) G_DoReborn(i);` → single player: `gameaction = ga_loadlevel` — **the level reloads from scratch** (g_game.c:927-931). `G_DoCompleted` has no death special-casing; in 1.10 single player you cannot finish a level dead — you must press use to reload (no automatic "you died" screen).

---

## 9. Cheats

In 1.10 cheats live in **st_stuff.c** (`ST_Responder` + `cht_CheckCheat` from m_cheat.c) and one in **am_map.c** — **not** d_main.c/g_game.c (there is no `G_DoCommand`; `G_Responder` merely forwards events to `ST_Responder`, g_game.c:544-546). Most are gated `if (!netgame)`.

| Cheat (decoded) | Where | Effect (verbatim semantics) |
|---|---|---|
| iddqd | st_stuff.c:412,565 | `cheats ^= CF_GODMODE` (=2); on: mo->health=player->health=100 |
| idfa | st_stuff.c:422,577 | armorpoints=200, armortype=2, all weapons owned, ammo=maxammo (no keys) |
| idkfa | st_stuff.c:417,591 | idfa + all `cards[i]=true` |
| idspispopd / idclip (commercial) | st_stuff.c:427-438 | `cheats ^= CF_NOCLIP` (=1) |
| idmus## | st_stuff.c:400 | change music |
| idchoppers (id...+3 keys) | st_stuff.c:405,657 | chainsaw owned + `powers[pw_invulnerability]=1` |
| beholdv/s/i/r/a/l | st_stuff.c:437-444,626 | toggle power: if 0 → `P_GivePower(i)`, else non-strength → `powers[i]=1` (restart countdown edge), strength → 0 |
| idclev## | st_stuff.c | level warp (both modes) |
| idmypos | st_stuff.c:665 | prints `ang=0x…;x,y=(0x…,0x…)` |
| iddt | am_map.c:287 (`{0xb2,0x26,0x26,0x2e}`), 701 | **exists**, automap-only: `cheating = (cheating+1) % 3` (0 normal, 1 all non-secret lines, 2 all incl. secrets); disabled in deathmatch |

noclip effect: `P_PlayerThink` sets/clears `MF_NOCLIP` per tic (p_user.c:241-245). god = `CF_GODMODE=2` (d_player.h) consumed in P_DamageMobj (§7.1).

---

## 10. Player defaults / G_PlayerReborn

First level load forces `players[i].playerstate = PST_REBORN` (G_InitNew, g_game.c:1440-1442), so every fresh game runs `G_DoReborn` → `G_PlayerReborn` (g_game.c:820-836, full quote):

```c
    memcpy (frags,players[player].frags,sizeof(frags)); 
    killcount = ...; itemcount = ...; secretcount = ...;
    p = &players[player]; 
    memset (p, 0, sizeof(*p)); 
    // restore frags/counts ...
    p->usedown = p->attackdown = true;	// don't do anything immediately 
    p->playerstate = PST_LIVE;       
    p->health = MAXHEALTH;                 // 100
    p->readyweapon = p->pendingweapon = wp_pistol; 
    p->weaponowned[wp_fist] = true; 
    p->weaponowned[wp_pistol] = true; 
    p->ammo[am_clip] = 50; 
    for (i=0 ; i<NUMAMMO ; i++) 
	p->maxammo[i] = maxammo[i];
```

Starting equipment: **fists + pistol, 50 bullets**, all else zeroed. No skill-based starting ammo in 1.10 (skill affects drops: `P_GiveAmmo` doubles pickups in baby/nightmare; baby halves incoming damage; nightmare also respawns monsters via `respawnmonsters`, g_game.c:1415-1418).

Movement input constants for context (g_game.c:175-177): `forwardmove[2] = {0x19, 0x32}; sidemove[2] = {0x18, 0x28}; angleturn[3] = {640, 1280, 320};` then `P_Thrust(..., cmd->forwardmove*2048)` (p_user.c:163).

---

## 11. Confidence

| Area | Confidence | Notes |
|---|---|---|
| p_pspr.c state machine, all constants (§1) | High | read full file |
| Weapon state tics / chains (§2.1) | High | transcribed from info.c lines 138-225 |
| Fire actions + damage formulas (§2.2) | High | direct quotes |
| Hitscan/autoaim (§3) | High | direct quotes from p_map.c; callback names verified PTR_* |
| Puff/Blood location | Medium-High | confirmed defined in p_mobj.c §807+; noted task's wrong file guess |
| Ammo economy (§4) | High | p_inter.c + p_pspr.c |
| Switching/fire-hold (§5) | High | g_game.c/p_user.c; "no cycling loop" verified by full grep of ev_key weapon handling |
| Powerups (§6) | High | enum in doomdef.h (task said d_player.h — corrected) |
| Damage/armor (§7) | High | full player branch quoted |
| Player states/viewheight/death (§8) | High | info.c + p_user.c + g_game.c cross-checked |
| Cheats (§9) | High | cheat sequences in st_stuff.c/am_map.c decoded (comments in source + keyboard-scan-code mapping b2='i', 26='d', 2e='t', …); iddt present only in automap module |
| Defaults (§10) | High | G_PlayerReborn quote |

### Deviations found vs. task assumptions (important corrections)

1. `A_Lower`/`A_Raise` speed is `FRACUNIT*6` per tic, not `FRACUNIT/8`; no `A_WeaponBob`/`P_CheckNoRecoil` exist — bob lives inside `A_WeaponReady` (constants quoted exactly, §1.4).
2. No `BADANGLE`, no `P_AimTraverse`/`P_ShootTraverse` in 1.10: it's `P_PathTraverse` + `PTR_AimTraverse`/`PTR_ShootTraverse`; cone = ±`100*FRACUNIT/160`.
3. No `P_SpawnMissileAngle`; player variant is `P_SpawnPlayerMissile` (`momz = FixedMul(speed, slope)`).
4. Kickback is `thrust = damage*(FRACUNIT>>3)*100/mass`, not a `P_AproxDistance` formula.
5. God mode flag is `CF_GODMODE` (=2), not `GF_GODMODE`; powers enum lives in doomdef.h.
6. Invulnerability colormap is **index 32 (inverted colors)**, not red; red = pain palette (ST_doPaletteStuff).
7. Cheats are in st_stuff.c + am_map.c, not d_main.c/g_game.c; `iddt` DOES exist (automap-only, 3-state); no "cycle weapon" loop in ticcmd builder (slot-upgrade handled in P_PlayerThink).
8. `P_CalcSwing` is dead code in 1.10.
9. Berserk heals only to 100 (`P_GiveBody(player,100)` cap MAXHEALTH).
10. Single-player death: `G_DoCompleted` does nothing special; death is resolved by PST_REBORN (press use) → full level reload in `G_DoReborn`.

## 12. Sources

All paths relative to `/tmp/DOOM-master/linuxdoom-1.10/`:

- p_pspr.c — constants (44-54), P_SetPsprite (59), P_BringUpWeapon (135), P_CheckAmmo (159), P_FireWeapon (196), A_WeaponReady (234), A_ReFire (302), A_Lower (389), A_Raise (433), A_GunFlash (446), A_Punch (352), A_Saw (385), A_FireMissile (437), A_FireBFG (453), A_FirePlasma (465), P_BulletSlope (487), P_GunShot (505), A_FirePistol (525), A_FireShotgun (549), A_FireShotgun2 (577), A_FireCGun (615), A_Light0/1/2 (640-652), A_BFGSpray (657), P_MovePsprites (847)
- d_items.c:42 — weaponinfo table
- info.c — states[] 137-262 (weapon/player/puff states), mobjinfo MT_PLAYER 1108, MT_ROCKET 1966, MT_PUFF 2070, MT_BLOOD 2096
- d_player.h — player_t (57-176), cheat_t CF_* (47-55), playerstate_t PST_* (38-46)
- doomdef.h — weapontype/ammotype/powertype enums (170-222), durations (231-239)
- p_inter.c — maxammo/clipammo (56-57), P_GiveAmmo (75), P_GiveWeapon (159), P_GiveBody (217), P_GiveArmor (235), P_GivePower (330), P_TouchSpecialThing (375-651), P_KillMobj (657), P_DamageMobj (700-918)
- p_map.c — PTR_AimTraverse (812), PTR_ShootTraverse (910), P_AimLineAttack (1020), P_LineAttack (1058), P_UseLines (1120)
- p_maputl.c:736 — P_PathTraverse
- p_mobj.c — P_SpawnPuff (812), P_SpawnBlood (839), P_CheckMissileSpawn (863), P_SpawnMissile (889), P_SpawnPlayerMissile (935), P_SpawnPlayer viewheight (683), floorz viewheight hook (254)
- p_user.c — P_Thrust (55), P_CalcHeight (78), P_MovePlayer (143), P_DeathThink (171), P_PlayerThink (235)
- p_enemy.c — A_Pain (1577), A_Fall (1585), A_PlayerScream (1994), A_Open/Load/CloseShotgun2 (1778-1805)
- p_local.h — VIEWHEIGHT (34), MAXHEALTH (33), MELEERANGE/MISSILERANGE (57-58), USERANGE (56)
- g_game.c — G_BuildTiccmd (237-400), G_Responder (504), G_Ticker reborn check (613), G_PlayerReborn (820), G_DoReborn (924), G_DoCompleted (1021), G_InitNew (1408-1460)
- d_event.h — BT_* buttons (70-95)
- st_stuff.c — cheat sequences (398-465), ST_Responder cheats (555-670), ST_doPaletteStuff (1000-1045)
- am_map.c — cheat_amap iddt (287, 701), pw_allmap draw hook (1160)
- r_main.c — fixedcolormap (838-859); r_draw.c — fuzz table (263-362); r_things.c — MF_SHADOW draw (578)
