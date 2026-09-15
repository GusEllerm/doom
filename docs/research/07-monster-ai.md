# R07: Monster AI (reference: id GPL linuxdoom-1.10)

All quotes transcribed and verified line-by-line from `/tmp/DOOM-master/linuxdoom-1.10/`
(p_enemy.c, p_map.c, p_maputl.c, p_sight.c, p_inter.c, p_mobj.c, p_pspr.c, info.c, g_game.c).
Important: the v1.10 GPL tree is the Doom1/Doom2 **shared** codebase — it contains Doom2-only
branches (MT_VILE, MT_UNDEAD, MT_FATSO, MT_PAIN, brain etc.). For our Doom1-format port we keep
the shared paths and drop the non-Doom1 type checks (marked **[Doom2]** below).

## Table of contents
1. A_Look — wake logic
2. A_Chase — combat movement
3. P_LookForPlayers
4. P_CheckSight (p_sight.c, NOT p_maputl.c)
5. P_NoiseAlert and callers
6. Attack functions per monster
7. Infighting (target swap in P_DamageMobj)
8. Pain behavior
9. Projectiles, missile collision, P_ExplodeMissile, P_RadiusAttack
10. Lost Soul / MF_SKULLFLY
11. Bosses: Cyberdemon & Spider
12. A_BossDeath
13. Barrels
14. What is NOT in Doom1
15. Roster tables
16. Confidence & sources

---

## 1. A_Look — wake logic

`p_enemy.c` (A_Look, ~line 595). Monsters spawn with `target = NULL, threshold = 0`
(header comment: "Enemies are allways spawned with targetplayer = -1, threshold = 0").

```c
void A_Look (mobj_t* actor)
{
    mobj_t*	targ;
	
    actor->threshold = 0;	// any shot will wake up
    targ = actor->subsector->sector->soundtarget;

    if (targ
	&& (targ->flags & MF_SHOOTABLE) )
    {
	actor->target = targ;

	if ( actor->flags & MF_AMBUSH )
	{
	    if (P_CheckSight (actor, actor->target))
		goto seeyou;
	}
	else
	    goto seeyou;
    }
	
	
    if (!P_LookForPlayers (actor, false) )
	return;
		
    // go into chase state
  seeyou:
    if (actor->info->seesound)
    {
	int		sound;
		
	switch (actor->info->seesound)
	{
	  case sfx_posit1:
	  case sfx_posit2:
	  case sfx_posit3:
	    sound = sfx_posit1+P_Random()%3;
	    break;

	  case sfx_bgsit1:
	  case sfx_bgsit2:
	    sound = sfx_bgsit1+P_Random()%2;
	    break;

	  default:
	    sound = actor->info->seesound;
	    break;
	}

	if (actor->type==MT_SPIDER
	    || actor->type == MT_CYBORG)
	{
	    // full volume
	    S_StartSound (NULL, sound);
	}
	else
	    S_StartSound (actor, sound);
    }

    P_SetMobjState (actor, actor->info->seestate);
}
```

Facts:
- Wake sources: (a) `sector->soundtarget` set by `P_NoiseAlert` flood-fill (sound-propagated);
  (b) direct `P_LookForPlayers(actor, false)` — front 180° cone only.
- `MF_AMBUSH` (flag value 32, p_mobj.h:131; set from map thing option `MTF_AMBUSH = 8`,
  doomdef.h:145, applied in `P_SpawnMapThing`, p_mobj.c:796) means a *sound* wake still requires
  `P_CheckSight` before entering the seestate; without it the monster wakes and chases blind.
- Seestate (e.g. `S_POSS_RUN1`) already runs `A_Chase` on its first frame (info.c states).
- `A_Wander` does **not exist** in v1.10 (grep: zero hits). Idle monsters only run `A_Look`
  in their STND frames.

---

## 2. A_Chase — combat movement

`p_enemy.c` A_Chase (~line 660) — full quote:

```c
void A_Chase (mobj_t*	actor)
{
    int		delta;

    if (actor->reactiontime)
	actor->reactiontime--;
				
    // modify target threshold
    if  (actor->threshold)
    {
	if (!actor->target
	    || actor->target->health <= 0)
	{
	    actor->threshold = 0;
	}
	else
	    actor->threshold--;
    }
    
    // turn towards movement direction if not there yet
    if (actor->movedir < 8)
    {
	actor->angle &= (7<<29);
	delta = actor->angle - (actor->movedir << 29);
	
	if (delta > 0)
	    actor->angle -= ANG90/2;
	else if (delta < 0)
	    actor->angle += ANG90/2;
    }

    if (!actor->target
	|| !(actor->target->flags&MF_SHOOTABLE))
    {
	// look for a new target
	if (P_LookForPlayers(actor,true))
	    return; 	// got a new target
	
	P_SetMobjState (actor, actor->info->spawnstate);
	return;
    }
    
    // do not attack twice in a row
    if (actor->flags & MF_JUSTATTACKED)
    {
	actor->flags &= ~MF_JUSTATTACKED;
	if (gameskill != sk_nightmare && !fastparm)
	    P_NewChaseDir (actor);
	return;
    }
    
    // check for melee attack
    if (actor->info->meleestate
	&& P_CheckMeleeRange (actor))
    {
	if (actor->info->attacksound)
	    S_StartSound (actor, actor->info->attacksound);

	P_SetMobjState (actor, actor->info->meleestate);
	return;
    }
    
    // check for missile attack
    if (actor->info->missilestate)
    {
	if (gameskill < sk_nightmare
	    && !fastparm && actor->movecount)
	{
	    goto nomissile;
	}
	
	if (!P_CheckMissileRange (actor))
	    goto nomissile;
	
	P_SetMobjState (actor, actor->info->missilestate);
	actor->flags |= MF_JUSTATTACKED;
	return;
    }

    // ?
  nomissile:
    // possibly choose another target
    if (netgame
	&& !actor->threshold
	&& !P_CheckSight (actor, actor->target) )
    {
	if (P_LookForPlayers(actor,true))
	    return;	// got a new target
    }
    
    // chase towards player
    if (--actor->movecount<0
	|| !P_Move (actor))
    {
	P_NewChaseDir (actor);
    }
    
    // make active sound
    if (actor->info->activesound
	&& P_Random () < 3)
    {
	S_StartSound (actor, actor->info->activesound);
    }
}
```

`MF_JUSTHIT` is *consumed* in `P_CheckMissileRange`, not A_Chase (see below).
`MF_JUSTATTACKED` (128, p_mobj.h:135): set when a missile state is entered; suppresses the next
tick's attack and forces only a direction change.

### 2.1 P_CheckMeleeRange (p_enemy.c ~line 168)

```c
    pl = actor->target;
    dist = P_AproxDistance (pl->x-actor->x, pl->y-actor->y);

    if (dist >= MELEERANGE-20*FRACUNIT+pl->info->radius)
	return false;
	
    if (! P_CheckSight (actor, actor->target) )
	return false;
							
    return true;
```

with `MELEERANGE = (64*FRACUNIT)` (p_local.h:57), `MISSILERANGE = (32*64*FRACUNIT)` (p_local.h:58).
So melee reach = `44 + target.radius` map units (P_AproxDistance is the chebyshev-ish
max+min/2 metric, p_maputl.c).

### 2.2 P_CheckMissileRange (p_enemy.c ~line 190) — full quote

```c
boolean P_CheckMissileRange (mobj_t* actor)
{
    fixed_t	dist;
	
    if (! P_CheckSight (actor, actor->target) )
	return false;
	
    if ( actor->flags & MF_JUSTHIT )
    {
	// the target just hit the enemy,
	// so fight back!
	actor->flags &= ~MF_JUSTHIT;
	return true;
    }
	
    if (actor->reactiontime)
	return false;	// do not attack yet
		
    // OPTIMIZE: get this from a global checksight
    dist = P_AproxDistance ( actor->x-actor->target->x,
			     actor->y-actor->target->y) - 64*FRACUNIT;
    
    if (!actor->info->meleestate)
	dist -= 128*FRACUNIT;	// no melee attack, so fire more

    dist >>= 16;

    if (actor->type == MT_VILE)		// [Doom2 — drop]
    {
	if (dist > 14*64)	
	    return false;	// too far away
    }
	
    if (actor->type == MT_UNDEAD)	// [Doom2 — drop]
    {
	if (dist < 196)	
	    return false;	// close for fist attack
	dist >>= 1;
    }
	
    if (actor->type == MT_CYBORG
	|| actor->type == MT_SPIDER
	|| actor->type == MT_SKULL)
    {
	dist >>= 1;
    }
    
    if (dist > 200)
	dist = 200;
		
    if (actor->type == MT_CYBORG && dist > 160)
	dist = 160;
		
    if (P_Random () < dist)
	return false;
		
    return true;
}
```

- reactiontime decrement is at the top of `A_Chase` (quoted above), *not* in this function;
  `reactiontime` is initialized from `mobjinfo` (`8` for all monsters) on spawn via
  `P_SpawnMobj`/`mobj->reactiontime = info->reactiontime`, and zeroed in `P_DamageMobj`
  ("we're awake now...").
- Random gate: `P_Random() < dist` where `dist ≈ (aproxDist-64[(-128 if no melee)])>>16`,
  clamped ≤200 (≤160 for cyber; halved for cyber/spider/skull). i.e. closer ⇒ higher fire chance,
  max ~200/256 per attempt. **[Doom2]** MT_VILE/MT_UNDEAD branches: exclude from Doom1 port.

### 2.3 Movement: P_Move, P_TryWalk, P_NewChaseDir

**Correction to the brief:** there is **no `move = (P_Random()&7)`** anywhere in v1.10's
A_Chase/P_Move (grep: the only `&7` uses are A_BrainScream/A_BrainExplode tics and BFG).
Direction selection is the octant LUT + `P_NewChaseDir` fallback tree below.

P_Move (p_enemy.c ~line 250):

```c
fixed_t	xspeed[8] = {FRACUNIT,47000,0,-47000,-FRACUNIT,-47000,0,47000};
fixed_t	ysspeed[8] = {0,47000,FRACUNIT,47000,0,-47000,-FRACUNIT,-47000};

    if (actor->movedir == DI_NODIR)
	return false;
		
    if ((unsigned)actor->movedir >= 8)
	I_Error ("Weird actor->movedir!");
		
    tryx = actor->x + actor->info->speed*xspeed[actor->movedir];
    tryy = actor->y + actor->info->speed*yspeed[actor->movedir];

    try_ok = P_TryMove (actor, tryx, tryy);

    if (!try_ok)
    {
	// open any specials
	if (actor->flags & MF_FLOAT && floatok)
	{
	    // must adjust height
	    if (actor->z < tmfloorz)
		actor->z += FLOATSPEED;
	    else
		actor->z -= FLOATSPEED;

	    actor->flags |= MF_INFLOAT;
	    return true;
	}
		
	if (!numspechit)
	    return false;
			
	actor->movedir = DI_NODIR;
	good = false;
	while (numspechit--)
	{
	    ld = spechit[numspechit];
	    // if the special is not a door
	    // that can be opened,
	    // return false
	    if (P_UseSpecialLine (actor, ld,0))
		good = true;
	}
	return good;
    }
    else
    {
	actor->flags &= ~MF_INFLOAT;
    }
	
	
    if (! (actor->flags & MF_FLOAT) )	
	actor->z = actor->floorz;
    return true; 
```

(Both arrays verbatim from p_enemy.c; `47000 ≈ FixedMul(FRACUNIT, cos 45°)`.)

- **Chase speed:** step per tick is `actor->info->speed * xspeed[dir]` — `speed` is the raw
  mobjinfo value (8 for zombieman/shotgunner/caco/baron, 10 sergeant, 12 spider, 16 cyber).
  There is **no `(info->speed>>1)`, no `*2` for `player->cheats`, and no `MF_FAST` in v1.10**
  (grep: zero matches). Fast monsters (nightmare/-fast) are done by (a) halving *state tics* of
  the sergeant run/pain chain and doubling monster projectile speeds at level start (g_game.c):

```c
    if (fastparm || (skill == sk_nightmare && gameskill != sk_nightmare) )
    { 
	for (i=S_SARG_RUN1 ; i<=S_SARG_PAIN2 ; i++) 
	    states[i].tics >>= 1; 
	mobjinfo[MT_BRUISERSHOT].speed = 20*FRACUNIT; 
	mobjinfo[MT_HEADSHOT].speed = 20*FRACUNIT; 
	mobjinfo[MT_TROOPSHOT].speed = 20*FRACUNIT; 
    } 
```
  (plus A_Chase's `fastparm || gameskill == sk_nightmare` branches that skip JUSTATTACKED
  direction change and the movecount gate for missiles), and (b) `respawnmonsters` (g_game.c:
  `if (skill == sk_nightmare || respawnparm) respawnmonsters = true;`).

- **Stuck handling** — there is *no "5 fails → reverse" counter*. Stuckness is handled by
  `movecount` and the `P_NewChaseDir` try-order (p_enemy.c ~lines 340–500):

```c
boolean P_TryWalk (mobj_t* actor)
{	
    if (!P_Move (actor))
    {
	return false;
    }

    actor->movecount = P_Random()&15;
    return true;
}
```

`P_NewChaseDir` order: (1) diagonal toward target (`diags[((deltay<0)<<1)+(deltax>0)]`,
±10-unit dead zone, skipping the turnaround); (2) with `P_Random() > 200 || abs(deltay)>abs(deltax)`
swap preferred axis; (3) axis d[1], then d[2] (turnaround replaced by DI_NODIR); (4) previous
direction; (5) full 8-way sweep in a direction chosen by `P_Random()&1`; (6) finally the
turnaround as last resort; else `actor->movedir = DI_NODIR; // can not move`.

**MF_FLOAT flying in P_Move/P_ZMovement** (A_Chase itself has no z block in v1.10 — correction):
- `P_Move`'s `floatok` block (quoted above) steps z by `FLOATSPEED = FRACUNIT*4` (p_local.h:30)
  when a float mobj's move is blocked but the step is only a height difference.
- Continuous hovering is in `P_ZMovement` (p_mobj.c ~line 260):

```c
    if ( mo->flags & MF_FLOAT
	 && mo->target)
    {
	// float down towards target if too close
	if ( !(mo->flags & MF_SKULLFLY)
	     && !(mo->flags & MF_INFLOAT) )
	{
	    dist = P_AproxDistance (mo->x - mo->target->x,
				    mo->y - mo->target->y);
	    
	    delta =(mo->target->z + (mo->height>>1)) - mo->z;

	    if (delta<0 && dist < -(delta*3) )
		mo->z -= FLOATSPEED;
	    else if (delta>0 && dist < (delta*3) )
		mo->z += FLOATSPEED;			
	}
    }
```

  Doom1 mobjs with `MF_FLOAT` in this table: **MT_HEAD (cacodemon)** and **MT_SKULL (lost soul)**
  (both also MF_NOGRAVITY). Flagged as uncertainty for Doom1-exact data below.

---

## 3. P_LookForPlayers (p_enemy.c ~line 490) — full quote

```c
boolean
P_LookForPlayers
( mobj_t*	actor,
  boolean	allaround )
{
    int		c;
    int		stop;
    player_t*	player;
    sector_t*	sector;
    angle_t	an;
    fixed_t	dist;
		
    sector = actor->subsector->sector;
	
    c = 0;
    stop = (actor->lastlook-1)&3;
	
    for ( ; ; actor->lastlook = (actor->lastlook+1)&3 )
    {
	if (!playeringame[actor->lastlook])
	    continue;
			
	if (c++ == 2
	    || actor->lastlook == stop)
	{
	    // done looking
	    return false;	
	}
	
	player = &players[actor->lastlook];

	if (player->health <= 0)
	    continue;		// dead

	if (!P_CheckSight (actor, player->mo))
	    continue;		// out of sight
			
	if (!allaround)
	{
	    an = R_PointToAngle2 (actor->x,
				  actor->y, 
				  player->mo->x,
				  player->mo->y)
		- actor->angle;
	    
	    if (an > ANG90 && an < ANG270)
	    {
		dist = P_AproxDistance (player->mo->x - actor->x,
					player->mo->y - actor->y);
		// if real close, react anyway
		if (dist > MELEERANGE)
		    continue;	// behind back
	    }
	}
		
	actor->target = player->mo;
	return true;
    }

    return false;
}
```

- Round-robin over `actor->lastlook` (`(lastlook+1)&3`, 4 player slots); bails after checking
  2 candidates or wrapping to `stop`.
- Facing test when `allaround==false` (used only from A_Look): relative angle `an` in
  `(ANG90, ANG270)` = behind ⇒ ignored unless within MELEERANGE. A_Chase's re-targeting calls
  pass `allaround = true` (look all directions).
- Only players can be targeted (`players[]` array); **monsters never target monsters** —
  there is no P_LookForTargets in v1.10 (grep: zero hits). See §7 for how infighting arises.

---

## 4. P_CheckSight — p_sight.c (NOT p_maputl.c)

Full quote (p_sight.c:300):

```c
boolean
P_CheckSight
( mobj_t*	t1,
  mobj_t*	t2 )
{
    int		s1;
    int		s2;
    int		pnum;
    int		bytenum;
    int		bitnum;
    
    // First check for trivial rejection.

    // Determine subsector entries in REJECT table.
    s1 = (t1->subsector->sector - sectors);
    s2 = (t2->subsector->sector - sectors);
    pnum = s1*numsectors + s2;
    bytenum = pnum>>3;
    bitnum = 1 << (pnum&7);

    // Check in REJECT table.
    if (rejectmatrix[bytenum]&bitnum)
    {
	sightcounts[0]++;

	// can't possibly be connected
	return false;	
    }

    // An unobstructed LOS is possible.
    // Now look from eyes of t1 to any part of t2.
    sightcounts[1]++;

    validcount++;
	
    sightzstart = t1->z + t1->height - (t1->height>>2);
    topslope = (t2->z+t2->height) - sightzstart;
    bottomslope = (t2->z) - sightzstart;
	
    strace.x = t1->x;
    strace.y = t1->y;
    t2x = t2->x;
    t2y = t2->y;
    strace.dx = t2->x - t1->x;
    strace.dy = t2->y - t1->y;

    // the head node is the last node output
    return P_CrossBSPNode (numnodes-1);	
}
```

- Sector-index math uses **subsector→sector**; reject bit index is `s1*numsectors+s2`.
- Z handling: eye height `sightzstart = t1->z + t1->height - (t1->height>>2)` (¾ of height —
  not a fixed 32); view cone to target's full z extent via `topslope`/`bottomslope`.
- The BSP walk (`P_CrossBSPNode` → `P_CrossSubsector`) blocks on non-two-sided lines and does
  the two-sided z-slope squeeze:

```c
	// quick test for totally closed doors
	if (openbottom >= opentop)	
	    return false;		// stop
	...
	if (topslope <= bottomslope)
	    return false;		// stop
```

---

## 5. P_NoiseAlert and its callers

p_enemy.c:159:

```c
void
P_NoiseAlert
( mobj_t*	target,
  mobj_t*	emmiter )
{
    soundtarget = target;
    validcount++;
    P_RecursiveSound (emmiter->subsector->sector, 0);
}
```

`P_RecursiveSound` floods adjacent sectors through two-sided lines with `openrange > 0`;
`ML_SOUNDBLOCK` lines are traversable only at depth 0 (i.e. it leaks *one* sector past a
sound-blocking line: `if (!soundblocks) P_RecursiveSound (other, 1);`). It sets
`sec->soundtarget = soundtarget` for every reached sector, which A_Look consumes.

Call sites (grep across tree): **exactly one** — `p_pspr.c:256`, at the end of
`P_FireWeapon()`:

```c
    P_SetPsprite (player, ps_weapon, newstate);
    P_NoiseAlert (player->mo, player->mo);
```

So in v1.10 only *player gunfire* wakes sound-aware sleeping monsters. Monster attacks and
explosions do **not** call P_NoiseAlert; other monsters join fights only via the P_DamageMobj
revenge logic (§7) and, for pain elementals/etc. [Doom2], spawning.

---

## 6. Attack functions (p_enemy.c) — per monster, exact names

### Zombieman (MT_POSSESSED) — A_PosAttack (hitscan)
```c
void A_PosAttack (mobj_t* actor)
{
    ...
    A_FaceTarget (actor);
    angle = actor->angle;
    slope = P_AimLineAttack (actor, angle, MISSILERANGE);

    S_StartSound (actor, sfx_pistol);
    angle += (P_Random()-P_Random())<<20;
    damage = ((P_Random()%5)+1)*3;	// 3..15
    P_LineAttack (actor, angle, MISSILERANGE, slope, damage);
}
```
No melee state (`meleestate 0`); missilestate `S_POSS_ATK1` (ATK2 carries A_PosAttack).

### Shotgun guy (MT_SHOTGUY, sprite SPOS, doomednum 9) — A_SPosAttack: **fires 3 pellets-shots**
```c
void A_SPosAttack (mobj_t* actor)
{
    ...
    S_StartSound (actor, sfx_shotgn);
    A_FaceTarget (actor);
    bangle = actor->angle;
    slope = P_AimLineAttack (actor, bangle, MISSILERANGE);

    for (i=0 ; i<3 ; i++)
    {
	angle = bangle + ((P_Random()-P_Random())<<20);
	damage = ((P_Random()%5)+1)*3;	// 3..15 each, x3
	P_LineAttack (actor, angle, MISSILERANGE, slope, damage);
    }
}
```
It's 3 iterations (not 2) of 3-shot-spread hitscan — verified `for (i=0 ; i<3 ; i++)`.
(Also reused verbatim by the Doom1 spider, §11, and A_CPosAttack/A_CPosRefire [Doom2]).

### Sergeant (MT_SERGEANT) — A_SargAttack: melee only
```c
    A_FaceTarget (actor);
    if (P_CheckMeleeRange (actor))
    {
	damage = ((P_Random()%10)+1)*4;	// 4..40
	P_DamageMobj (actor->target, actor, actor, damage);
    }
```
`meleestate = S_SARG_ATK1`, `missilestate = 0`; attacksound `sfx_sgtatk` played by A_Chase.

### Imp (MT_TROOP) — A_TroopAttack: melee fire-or-missile
```c
    A_FaceTarget (actor);
    if (P_CheckMeleeRange (actor))
    {
	S_StartSound (actor, sfx_claw);
	damage = (P_Random()%8+1)*3;	// 3..24
	P_DamageMobj (actor->target, actor, actor, damage);
	return;
    }
    
    // launch a missile
    P_SpawnMissile (actor, actor->target, MT_TROOPSHOT);
```
`meleestate = missilestate = S_TROO_ATK1` (single 3-state chain; A_TroopAttack at S_TROO_ATK3).

### Cacodemon (MT_HEAD) — A_HeadAttack
```c
    A_FaceTarget (actor);
    if (P_CheckMeleeRange (actor))
    {
	damage = (P_Random()%6+1)*10;	// 10..60
	P_DamageMobj (actor->target, actor, actor, damage);
	return;
    }
    
    // launch a missile
    P_SpawnMissile (actor, actor->target, MT_HEADSHOT);
```
Fireball `MT_HEADSHOT`: speed `10*FRACUNIT`, damage factor 5 (§15 table).

### Baron of Hell / Hell Knight (MT_BRUISER / [Doom2] MT_KNIGHT) — A_BruisAttack
```c
    if (P_CheckMeleeRange (actor))
    {
	S_StartSound (actor, sfx_claw);
	damage = (P_Random()%8+1)*10;	// 10..80
	P_DamageMobj (actor->target, actor, actor, damage);
	return;
    }
    
    // launch a missile
    P_SpawnMissile (actor, actor->target, MT_BRUISERSHOT);
```
(Note: no A_FaceTarget — states S_BOSS_ATK1/2 do the facing.) `MT_BRUISERSHOT`: speed
`15*FRACUNIT`, damage factor 8. Real name is **A_BruisAttack** (spelling in source).

### Lost soul (MT_SKULL)
No melee/missile *damage* function in the classic sense: `missilestate = S_SKULL_ATK1` →
A_FaceTarget → S_SKULL_ATK2 runs **A_SkullAttack** (§10). attacksound `sfx_sklatk`.

### Functions that are NOT part of the Doom1 roster
A_CPosAttack / A_CPosRefire (MT_CHAINGUY), A_VileChase/A_VileTarget/A_VileAttack, A_SkelFist/
A_SkelMissile/A_SkelWhoosh/A_Tracer, A_FatAttack1-3, A_PainAttack/A_PainShootSkull/A_PainDie,
A_BspiAttack (fires MT_ARACHPLAZ; no state in the Doom1 set calls it), A_KeenDie, A_Brain* /
A_SpawnFly — all Doom2-only (their mobjtypes' doomednums 58?, 64-71, 6072 never appear in Doom1
maps; MT_SHADOWS=58 is the doomed demo's invisible sergeant).

---

## 7. Infighting — P_DamageMobj target-swap (p_inter.c ~line 900)

```c
    if ( (!target->threshold || target->type == MT_VILE)	 // MT_VILE part [Doom2]
	 && source && source != target
	 && source->type != MT_VILE)
    {
	// if not intent on another player,
	// chase after this one
	target->target = source;
	target->threshold = BASETHRESHOLD;
	if (target->state == &states[target->info->spawnstate]
	    && target->info->seestate != S_NULL)
	    P_SetMobjState (target, target->info->seestate);
    }
```

- `BASETHRESHOLD = 100` (p_local.h:61). A damaged monster whose threshold is 0 (not currently
  shooting at someone) turns on `source`. If it *was* shooting (threshold>0), no swap → the
  1-tic-per-hit rule means only hits **while not already attacking** redirect aggression;
  shots that miss never call this. Both the infighting trigger and wake-up (spawnstate→seestate)
  live here.
- `threshold` is set to 0 in A_Look on waking and decremented each A_Chase tick; it's nonzero
  after being attacked (BASETHRESHOLD) for up to 100 tics.
- Note there is **no P_LookForTargets**: monsters can *only* ever aim at players; infighting is
  purely "shoot whoever shot me" via this swap. A monster hits another monster only by friendly
  fire of projectiles/attacks that pass the PIT_CheckThing same-type test (§9).

---

## 8. Pain behavior (p_inter.c P_DamageMobj, ~line 885)

```c
    // do the damage	
    target->health -= damage;	
    if (target->health <= 0)
    {
	P_KillMobj (source, target);
	return;
    }

    if ( (P_Random () < target->info->painchance)
	 && !(target->flags&MF_SKULLFLY) )
    {
	target->flags |= MF_JUSTHIT;	// fight back!
	
	P_SetMobjState (target, target->info->painstate);
    }
			
    target->reactiontime = 0;		// we're awake now...	
```

- Pain state enters only if `P_Random() < painchance` (per-monster, 0-255; see roster) and the
  monster isn't mid-skull-charge. Pain sound is played by **A_Pain** in the pain state's 2nd
  frame (`S_*_PAIN2`), using `info->painsound`.
- `MF_JUSTHIT` (64) is set **here in P_DamageMobj** (p_inter.c:897), *not* in P_Move. Consumed
  in P_CheckMissileRange (§2.2) forcing an immediate return shot, and by the pain state itself
  (monster goes back to RUN1).
- Player-only branch above it handles armor (`saved = damage/3` green, `/2` red), GOD/invul,
  `I_Tactile`; irrelevant to monsters except that a hit player is the same function.

---

## 9. Projectiles & monsters: collision, explosion, radius damage

### 9.1 Where missiles collide (there is no P_CheckMissileMissile / P_MobjBlockmapMove)
Path: `P_MobjThinker` → `P_XYMovement` (momentum) → `P_TryMove` → `P_CheckPosition` →
`P_BlockThingsIterator(PIT_CheckThing)` (p_map.c). Blocked XY move for `MF_MISSILE` in
`P_XYMovement` → sky-hack (`ceilingline->backsector->ceilingpic == skyflatnum` removes it)
else → `P_ExplodeMissile`. Z blocking (floor/ceiling) in `P_ZMovement` → `P_ExplodeMissile`.

Thing-hit logic, `PIT_CheckThing` (p_map.c:252), missile branch:

```c
    // missiles can hit other things
    if (tmthing->flags & MF_MISSILE)
    {
	// see if it went over / under
	if (tmthing->z > thing->z + thing->height)
	    return true;		// overhead
	if (tmthing->z+tmthing->height < thing->z)
	    return true;		// underneath
		
	if (tmthing->target && (
	    tmthing->target->type == thing->type || 
	    (tmthing->target->type == MT_KNIGHT && thing->type == MT_BRUISER)||
	    (tmthing->target->type == MT_BRUISER && thing->type == MT_KNIGHT) ) )
	{
	    // Don't hit same species as originator.
	    if (thing == tmthing->target)
		return true;

	    if (thing->type != MT_PLAYER)
	    {
		// Explode, but do no damage.
		// Let players missile other players.
		return false;
	    }
	}
	
	if (! (thing->flags & MF_SHOOTABLE) )
	{
	    // didn't do any damage
	    return !(thing->flags & MF_SOLID);	
	}
	
	// damage / explode
	damage = ((P_Random()%8)+1)*tmthing->info->damage;
	P_DamageMobj (thing, tmthing, tmthing->target, damage);

	// don't traverse any more
	return false;				
    }
```

**Direct-hit damage = `(P_Random()%8 + 1) * info->damage`** (1-8 × damage factor), and missiles
of type X never damage monsters of the shooter's same mobjtype (this, not a targeting rule, is
what limits some infighting). MT_KNIGHT/MT_BRUISER cross-check is [Doom2].

### 9.2 P_ExplodeMissile (p_mobj.c:90) — full quote

```c
void P_ExplodeMissile (mobj_t* mo)
{
    mo->momx = mo->momy = mo->momz = 0;

    P_SetMobjState (mo, mobjinfo[mo->type].deathstate);

    mo->tics -= P_Random()&3;

    if (mo->tics < 1)
	mo->tics = 1;

    mo->flags &= ~MF_MISSILE;

    if (mo->info->deathsound)
	S_StartSound (mo, mo->info->deathsound);
}
```

Splash damage comes from the death-state chain, **not** from P_ExplodeMissile: only states
`S_EXPLODE1` (rocket explosion: `{SPR_MISL,32769,8,{A_Explode},...}`) and `S_BEXP4` (barrel)
run **A_Explode** (grep of info.c states — exactly those two):

```c
void A_Explode (mobj_t* thingy)
{
    P_RadiusAttack ( thingy, thingy->target, 128 );
}
```

So: **rockets and barrels do radius 128 splash; caco balls, baron fireballs, imp fireballs,
plasma (speed 25? — MT_PLASMA 25*FRACUNIT, dmg 5) and BFG (dmg 100) do none on wall impact**
— only direct hits damage (the task brief's "caco ball 10 / rocket 20 splash" is wrong for
this source; the damage column values are the direct-hit factors, §15).

### 9.3 P_RadiusAttack (p_map.c:1206 — NOT p_inter.c)

```c
boolean PIT_RadiusAttack (mobj_t* thing)
{
    ...
    if (!(thing->flags & MF_SHOOTABLE) )
	return true;

    // Boss spider and cyborg
    // take no damage from concussion.
    if (thing->type == MT_CYBORG
	|| thing->type == MT_SPIDER)
	return true;	
		
    dx = abs(thing->x - bombspot->x);
    dy = abs(thing->y - bombspot->y);
    
    dist = dx>dy ? dx : dy;
    dist = (dist - thing->radius) >> FRACBITS;

    if (dist < 0)
	dist = 0;

    if (dist >= bombdamage)
	return true;	// out of range

    if ( P_CheckSight (thing, bombspot) )
    {
	// must be in direct path
	P_DamageMobj (thing, bombspot, bombsource, bombdamage - dist);
    }
    
    return true;
}

void P_RadiusAttack (mobj_t* spot, mobj_t* source, int damage)
{
    ...
    dist = (damage+MAXRADIUS)<<FRACBITS;   /* MAXRADIUS = 32*FRACUNIT */
    ...scan blockmap boxes around spot...
    bombspot = spot; bombsource = source; bombdamage = damage;
    for (y=yl ; y<=yh ; y++)
	for (x=xl ; x<=xh ; x++)
	    P_BlockThingsIterator (x, y, PIT_RadiusAttack );
}
```

- Damage is linear falloff `damage - chebyshevDist(from surface)`, **not mass-scaled**
  (the task brief's "mass-scaled damage" is wrong; mass only appears in the *thrust* of
  P_DamageMobj: `thrust = damage*(FRACUNIT>>3)*100/target->info->mass`, p_inter.c, plus the
  "make fall forwards sometimes" kick `thrust *= 4` when `damage < 40 && damage > health &&
  target->z - inflictor->z > 64*FRACUNIT && (P_Random()&1)`).
- Splash needs LOS from victim to blast spot; bosses immune.

### 9.4 P_SpawnMissile (p_mobj.c:889)

```c
    th = P_SpawnMobj (source->x,
		      source->y,
		      source->z + 4*8*FRACUNIT, type);
    ...
    th->target = source;	// where it came from
    an = R_PointToAngle2 (source->x, source->y, dest->x, dest->y);	
    ...
    th->momx = FixedMul (th->info->speed, finecosine[an]);
    th->momy = FixedMul (th->info->speed, finesine[an]);
	
    dist = P_AproxDistance (dest->x - source->x, dest->y - source->y);
    dist = dist / th->info->speed;
    if (dist < 1)
	dist = 1;
    th->momz = (dest->z - source->z) / dist;
    P_CheckMissileSpawn (th);
```

`P_CheckMissileSpawn`: `tics -= P_Random()&3` (min 1), prestep `x += momx>>1 ...`, then
`P_TryMove` — explodes immediately if spawned inside something.

---

## 10. Skull (lost soul) — MF_SKULLFLY state machine

States (info.c): `S_SKULL_STND A_Look` ↔ `S_SKULL_RUN1 A_Chase` (2 frames, 6 tics),
`S_SKULL_ATK1 A_FaceTarget (10) → ATK2 A_SkullAttack (4) → ATK3/ATK4 (4,4 alternating) → back
to ATK3` — but once airborne the states keep cycling while mom keeps it moving (it "attacks"
forever; only a hit or P_XYMovement zero-momentum resets it).

Launch, `A_SkullAttack` (p_enemy.c ~line 1420):

```c
#define	SKULLSPEED		(20*FRACUNIT)

    dest = actor->target;	
    actor->flags |= MF_SKULLFLY;

    S_StartSound (actor, actor->info->attacksound);
    A_FaceTarget (actor);
    an = actor->angle >> ANGLETOFINESHIFT;
    actor->momx = FixedMul (SKULLSPEED, finecosine[an]);
    actor->momy = FixedMul (SKULLSPEED, finesine[an]);
    dist = P_AproxDistance (dest->x - actor->x, dest->y - actor->y);
    dist = dist / SKULLSPEED;
    
    if (dist < 1)
	dist = 1;
    actor->momz = (dest->z+(dest->height>>1) - actor->z) / dist;
```

Hit: in `PIT_CheckThing` (p_map.c:275):

```c
    // check for skulls slamming into things
    if (tmthing->flags & MF_SKULLFLY)
    {
	damage = ((P_Random()%8)+1)*tmthing->info->damage;	// info->damage == 3 → 3..24
	
	P_DamageMobj (thing, tmthing, tmthing, damage);
	
	tmthing->flags &= ~MF_SKULLFLY;
	tmthing->momx = tmthing->momy = tmthing->momz = 0;
	
	P_SetMobjState (tmthing, tmthing->info->spawnstate);
	
	return false;		// stop moving
    }
```

Wall/floor/ceiling bounce and stall:
- `P_ZMovement` (p_mobj.c): on floor or ceiling contact with MF_SKULLFLY: `mo->momz = -mo->momz;`
  (bounce).
- `P_XYMovement` (p_mobj.c): blocked move with zero momentum & MF_SKULLFLY:

```c
	if (mo->flags & MF_SKULLFLY)
	{
	    // the skull slammed into something
	    mo->flags &= ~MF_SKULLFLY;
	    mo->momx = mo->momy = mo->momz = 0;

	    P_SetMobjState (mo, mo->info->spawnstate);
	}
```

- While skullflying: no friction (P_XYMovement early-returns for MF_MISSILE|MF_SKULLFLY),
  no pain state (P_DamageMobj skips `flags&MF_SKULLFLY`), and its damage hits **any** thing
  (even same-type, since the PIT branch precedes the same-species missile check).
- P_KillMobj clears MF_SKULLFLY and MF_FLOAT/MF_NOGRAVITY (except keeps ~NOGRAVITY for MT_SKULL
  death? — code: `if (target->type != MT_SKULL) target->flags &= ~MF_NOGRAVITY;`).

---

## 11. Bosses (Doom1: MT_CYBORG doomednum 16 "boss1", MT_SPIDER doomednum 7 "boss2";
MT_BABY/MT_BOSS*brain* are Doom2)

### Cyberdemon — A_CyberAttack
States: `S_CYBER_ATK1 (4, A_FaceTarget) → ATK2 (12, A_CyberAttack) → ATK3 (12, A_FaceTarget) →
ATK4 (12, A_CyberAttack) → ATK5 (12, A_FaceTarget) → ATK6 (12, A_CyberAttack) → RUN1`.
So **3 rockets per volley**, re-aimed between each. Function itself:

```c
void A_CyberAttack (mobj_t* actor)	
{	
    if (!actor->target)
	return;
		
    A_FaceTarget (actor);
    P_SpawnMissile (actor, actor->target, MT_ROCKET);
}
```

No angular offsets in v1.10 (brief's "3 rockets offsets" — the offsetting is in the states'
face-target timing, not the code). Rocket: damage 20 direct factor, A_Explode 128 splash.
Walking sound: A_Hoof (sfx_hoof) + A_Metal (footstep) interleaved in RUN states.
painchance 20 (can be staggered), immune to splash (§9.3 PIT_RadiusAttack).

### Spider — hitscan, A_SPosAttack + A_SpidRefire
States: `S_SPID_ATK1 (20, A_FaceTarget) → ATK2 (4, A_SPosAttack) → ATK3 (4, A_SPosAttack) →
ATK4 (1, A_SpidRefire) → ATK2 ...`. So **3-pellet shotgun hitscan × 3-15 damage every 4 tics**
(≈6 bursts/sec region), no projectile:

```c
void A_SpidRefire (mobj_t* actor)
{	
    // keep firing unless target got out of sight
    A_FaceTarget (actor);

    if (P_Random () < 10)
	return;

    if (!actor->target
	|| actor->target->health <= 0
	|| !P_CheckSight (actor, actor->target) )
    {
	P_SetMobjState (actor, actor->info->seestate);
    }
}
```

Each 1-tic frame it has 10/256 chance to keep firing even if healthy+sighted — geometric burst
end (~26 tics avg). Walking: A_Metal on 3 of 12 RUN frames. attacksound sfx_shotgn (from
A_SPosAttack), painchance 40, splash-immune. A_BspiAttack/A_SpidAttack names from the brief:
only **A_BspiAttack** exists (fires MT_ARACHPLAZ, [Doom2], unused in Doom1 states);
A_SpidAttack/A_BrainSpray do not exist.

### A_CyberAttack vs brief
`A_Hoof`, `A_Metal`, `A_BabyMetal` = sound+`A_Chase` wrappers (p_enemy.c ~1745).

---

## 12. A_BossDeath (p_enemy.c ~line 1605) — conditions verbatim

```c
    if ( gamemode == commercial)
    {
	if (gamemap != 7)
	    return;
		
	if ((mo->type != MT_FATSO)
	    && (mo->type != MT_BABY))
	    return;
    }
    else
    {
	switch(gameepisode)
	{
	  case 1:
	    if (gamemap != 8)
		return;

	    if (mo->type != MT_BRUISER)
		return;
	    break;
	    
	  case 2:
	    if (gamemap != 8)
		return;

	    if (mo->type != MT_CYBORG)
		return;
	    break;
	    
	  case 3:
	    if (gamemap != 8)
		return;
	    
	    if (mo->type != MT_SPIDER)
		return;
	    
	    break;
	    
	  case 4:
	    switch(gamemap)
	    {
	      case 6:
		if (mo->type != MT_CYBORG)
		    return;
		break;
		
	      case 8: 
		if (mo->type != MT_SPIDER)
		    return;
		break;
		
	      default:
		return;
		break;
	    }
	    break;
	    
	  default:
	    if (gamemap != 8)
		return;
	    break;
	}
		
    }
```

Then: (1) require ≥1 living player, (2) scan thinkers — all same-`type` bosses must be dead;
then the victory action — E1: `junk.tag = 666; EV_DoFloor(&junk, lowerFloorToLowest);`
(**the E1M8 baron special** — the floor that lowers is tag 666, and E1M8's boss check is
MT_BRUISER i.e. barons), E2: `G_ExitLevel()`, E4-6: tag 666 `blazeOpen` door, E4-8/E3:
`lowerFloorToLowest` tag 666 or `G_ExitLevel()` (exact branches in the quote's tail).
Attached to the final death frame of MT_BRUISER (`S_BOSS_DIE7 {A_BossDeath}`), MT_CYBORG
(`S_CYBER_DIE10`), MT_SPIDER (`S_SPID_DIE11`) with tics -1.

---

## 13. Barrels (MT_BARREL, info.c:1888)

```
doomednum 2035 | S_BAR1 | spawnhealth 20 | seestate S_NULL (never "wakes")
deathstate S_BEXP | deathsound sfx_barexp | radius 10*FRACUNIT | height 42*FRACUNIT
mass 100 | damage 0 | flags MF_SOLID|MF_SHOOTABLE|MF_NOBLOOD
```

Chain: any hitscan/missile damage → `P_DamageMobj` (barrel is MF_SHOOTABLE; MF_NOBLOOD → no
blood puff, `P_KillMobj` uses `deathstate` since damage ≤ health... ) → `P_SetMobjState(S_BEXP)`
→ `S_BEXP2 A_Scream` (plays deathsound sfx_barexp — generic A_Scream `default:` branch) →
`S_BEXP4 {A_Explode}` → `P_RadiusAttack (thingy, thingy->target, 128)`. `mo->target` is NULL
for map-spawned barrels → environmental damage (`source == NULL`): full ≤128-distance falloff,
and **no infighting attribution** (§7's `source &&` guard fails). Radius: box half-size
`(128+32)` units scanned; damage at center 128 → 0 at 128 units. No seestate/painstate means
barrels can't be provoked. (The brief's "20?" refers to its health; explosion is 128.)

---

## 14. Confirmed-absent in v1.10 (grep-verified, zero matches)

`A_Wander`, `P_LookForTargets`, `A_Recoil`, `MF_FAST`, `MF_JUSTHIT` in p_map.c (it's in
p_inter.c), `move = (P_Random()&7)` chase jitter, `(info->speed>>1)` chasespeed lines,
P_CheckMissileMissile, P_MobjBlockmapMove, A_BrainSpray, friendlies/MBF-style team code,
`MF_COUNTKILL` checks in A_Chase (killcount only in P_KillMobj), `A_Skel*` in Doom1 states,
`tics`/`MAXTICS` cap. `P_LookForPlayers` is the only target-finding function.

---

## 15. Roster tables (Doom1 subset of info.c)

### 15.1 Monsters (mobjinfo + states)

| MT_ | doomednum | spr | speed | hp | painchance | melee state (dmg) | missile state (dmg / projectile) | pain snd | death snd | see snd / act snd | flags (info.c 1.10) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MT_POSSESSED | 3004 | POSS | 8 | 20 | 200 | — | POSS_ATK1, hitscan 3-15 | popain | podth1-3 | posit1(rnd/3) / posact | SOLID\|SHOOTABLE\|COUNTKILL |
| MT_SHOTGUY | 9 | SPOS | 8 | 30 | 170 | — | SPOS_ATK1, hitscan 3×(3-15) | popain | podth2 | posit2 / posact | same |
| MT_TROOP (imp) | 3001 | TROO | 8 | 60 | 200 | TROO_ATK1 claw 3-24 | same chain → MT_TROOPSHOT (spd 10, dmg fac 3) | popain | bgdth1-2(rnd/2) | bgsit1-2(rnd/2) / bgact | same |
| MT_SERGEANT | 3002 | SARG | 10 | 150 | 180 | SARG_ATK1 4-40 | — (missilestate 0) | dmpain | sgtdth | sgtsit / dmact | same |
| MT_HEAD (caco) | 3005 | HEAD | 8 | 400 | 128 | — (melee 0) | HEAD_ATK1 → MT_HEADSHOT (spd 10, dmg fac 5) | dmpain | cacdth | cacsit / dmact | SOLID\|SHOOTABLE\|**FLOAT**\|NOGRAVITY\|COUNTKILL |
| MT_BRUISER (baron) | 3003 | BOSS | 8 | 1000 | 50 | BOSS_ATK1 claw 10-80 | same chain → MT_BRUISERSHOT (spd 15, dmg fac 8) | dmpain | brsdth | brssit / dmact | SOLID\|SHOOTABLE\|COUNTKILL |
| MT_SKULL (lost soul) | 3006 | SKUL | 8 | 100 | 256 | — | SKULL_ATK1 → A_SkullAttack (dmg fac 3 → 3-24) | dmpain | firxpl | (none) / dmact | SOLID\|SHOOTABLE\|**FLOAT**\|NOGRAVITY (**no COUNTKILL**) |
| MT_SPIDER | 7 | SPID | 12 | 3000 | 40 | — | SPID_ATK1 hitscan 3×(3-15) + A_SpidRefire | dmpain | spidth | spisit (full vol) / dmact | SOLID\|SHOOTABLE\|COUNTKILL |
| MT_CYBORG | 16 | CYBR | 16 | 4000 | 20 | — | CYBER_ATK ×3 → MT_ROCKET | dmpain | cybdth | cybsit (full vol) / dmact | SOLID\|SHOOTABLE\|COUNTKILL |
| MT_BARREL | 2035 | BAR1 | 0 | 20 | 0 | — | — | — | barexp | — | SOLID\|SHOOTABLE\|NOBLOOD |

All reactiontime = 8. Run-state tics: POSS 4, SPOS/TROO/BOSS 3, SARG 2, HEAD 3, SKUL 6,
SPID/CYBR 3 (× A_Metal/A_Hoof); death chains 5-8 tics/frame (SPID 20/10s, CYBR 10s — long
boss deaths ending in A_BossDeath tics=-1). xdeath exists for POSS/SPOS/TROO only
(others S_NULL). All have raisestate (nightmare raise) except bosses/skull/barrel (S_NULL).

### 15.2 Doom1 projectiles (mobjinfo)

| MT_ | spawned by | speed | dmg factor (direct hit `(1+P_Random()%8)*fac`) | splash (A_Explode 128?) |
|---|---|---|---|---|
| MT_TROOPSHOT (spr BAL1) | imp | 10*FRACUNIT | 3 → 3-24 | no |
| MT_HEADSHOT (spr BAL2) | caco | 10*FRACUNIT | 5 → 5-40 | no |
| MT_BRUISERSHOT (BAL7) | baron | 15*FRACUNIT (20 fast) | 8 → 8-64 | no |
| MT_ROCKET | player & cyberdemon | 20*FRACUNIT | 20 → 20-160 | **yes** (S_EXPLODE1 A_Explode 128) |
| MT_PLASMA | player | 25*FRACUNIT | 5 → 5-40 | no |
| MT_BFG | player | 25*FRACUNIT | 100 → 100-800 | no A_Explode; uses **A_BFGSpray** in S_BFGLAND3 (P_BFGSpray in p_map.c — 40 directed hitscan sprays, deferred to R08) |

Radius all 6 (rocket 11, plasma/bfg 13)*FRACUNIT, height 8, flags NOBLOCKMAP|MISSILE|DROPOFF|
NOGRAVITY; all spawn `z + 32` above shooter, `target = source`.

---

## 16. Confidence & sources

**Verified (read directly this session, exact quotes):** A_Look, A_Chase, P_CheckMeleeRange,
P_CheckMissileRange, P_Move/P_TryWalk/P_NewChaseDir, P_LookForPlayers, P_CheckSight,
P_CrossSubsector z-tests, P_NoiseAlert/P_RecursiveSound + sole p_pspr.c caller,
A_PosAttack/A_SPosAttack/A_CPos*/A_TroopAttack/A_SargAttack/A_HeadAttack/A_BruisAttack/
A_CyberAttack/A_SpidRefire/A_SkullAttack/A_Pain/A_Scream/A_Fall/A_Explode/A_BossDeath,
P_DamageMobj pain+revenge blocks, PIT_CheckThing missile/skull blocks, PIT_RadiusAttack,
P_RadiusAttack, P_ExplodeMissile, P_SpawnMissile/P_CheckMissileSpawn, MT_ roster + all
quoted mobjinfo/state rows (script-extracted), g_game.c fast/nightmare table hacks,
flag values in p_mobj.h, constants in p_local.h/doomdef.h.

**Corrections to the task brief (all grep-verified absences):** `move = (P_Random()&7)`;
`(info->speed>>1)`/cheats×2 chasespeed; MF_FAST; "5 failed moves → reverse";
`A_Skel*`/`A_SkelMissile`/`A_Wander`/`P_LookForTargets`/`A_Recoil`/`A_BrainSpray`;
P_CheckSight is in p_sight.c not p_maputl.c; P_RadiusAttack is in p_map.c not p_inter.c;
MF_JUSTHIT set in P_DamageMobj not P_Move; A_SPosAttack fires 3 not 2; splash on rockets and
barrels only.

**Uncertainties:**
1. v1.10 info.c is the Doom1/Doom2 superset; Doom1-1.9's own table (BFG doom1 source /
   doom1.exe data) may differ on MT_HEAD having MF_FLOAT — behavior (floating cacos) matches,
   flag as HIGH confidence but verify against doom1.wad behavior; MT_SHADOWS (58) is the
   doomed-demo only variant. (Confidence: high on all Doom1 states/mobjinfo above.)
2. BFG explosion = A_BFGSpray (S_BFGLAND3, confirmed in info.c:255; function body is
   P_BFGSpray in p_map.c) — out of scope here, defer detail to R08.
3. Doom2 MT_ rows (VILE/UNDEAD/FATSO/KNIGHT/PAIN/BABY/WOLFSS/BRAIN) present in table but
   irrelevant for our Doom1-format port.

**Sources:** `/tmp/DOOM-master/linuxdoom-1.10/{p_enemy,p_map,p_maputl,p_sight,p_inter,
p_mobj,p_pspr,g_game,info}.c`, `{doomdef,p_local,p_mobj,info}.h`. No network used.
