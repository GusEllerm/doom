# M7 Plan — Items & weapons: state tables, pickups, hitscan/projectiles, powerups (the SHOOT milestone)

Status: planned. Parent: docs/ROADMAP.md M7. Inputs: ARCHITECTURE.md §2.3 (state/mobj tables), §3.3 (PRNG discipline), §5.2-5.3 (AI/weapons seams, random-sites artifact), R08 (primary; re-read this pass: §1 pspr machine, §2 tables+fire actions, §3 hitscan/projectiles, §4 ammo, §5 switching, §6 powerups, §7 damage), R06 §1 (state semantics), §6 (P_SpawnMapThing), §7 (P_KillMobj), §8 (pickup switch verbatim), §10 (TS encoding), R07 §9 (missile collision, P_ExplodeMissile, P_RadiusAttack), R05 (M6 specials adjacency), R12 (Freedoom parity/DEHACKED). Predecessors: M5-plan (pmap/thinglinks/pmove seams), M6-plan **absent on main** — see §0.0.
Exit (from ROADMAP): every pickup + weapon via state tables; hitscan/projectile/autoaim/splash L2 goldens; powerups + palette flashes visible (L3 viewpoint diffs, L4 fire-weapon keys).

## 0. Source truths pinned this pass
0.0. **M6-plan.md does not exist on main** (commit 922e532 says its planner is in flight). Coarse assumptions, to be reconciled at dispatch: (a) M6 delivers `p_cross`/specials dispatch, sector movers as thinkers, and (ideally) the thinker arena + P_RunThinkers wiring in `p_tick.ts` — if M6 ships no mobj/state infra, M7-01 stands as written (its own claim says "absorb if M6 landed one first"); (b) teleporters/level mechanics don't consume the P_Random stream beyond what M6 pins — the shared-stream tests in M7-10 re-pin whatever M6 leaves; (c) M6 fills the `P_CrossSpecialLine` call site (M5-03 stub) — M7 adds only the *shooting* dispatch (`P_ShootSpecialLine` from `PTR_ShootTraverse`, R08 §3.3: every crossed line with a special fires **before** the block test); (d) `ga_loadlevel` (death restart, M7-03) exists via g_game.
1. **Local source tree is partial**: /tmp/DOOM-master/linuxdoom-1.10 holds only r_*/g_game.c — p_mobj/p_pspr/p_inter/p_map/p_user/info.c are NOT on disk. Research notes R06/R07/R08 quote them verbatim with line refs; they are the arbiter. Anything ambiguous gets an **empirical Freedoom fixture** (L2 behavior test), not folklore.
2. **State machine (R06 §1)**: action-on-entry; `P_SetMobjState` loops while `tics===0` (0-tic cascades in one call), `S_NULL`=0 removes (`return false` ⇒ callers bail), `tics===-1` forever (no MAXTICS); `states[]` 967 rows in info.c order so `state - states` arithmetic works — **P_XYMovement uses it**: `(mo->state - states) - S_PLAY_RUN1 < 4` ⇒ player-walking test; spawn desync `tics = 1 + P_Random() % tics` (P_SpawnMapThing R06 §6); P_MobjThinker = XY-move (if mom≠0) → Z-move (if z≠floorz or momz) → tic-decrement+nextstate; **ZMISC movers** (puff/blood/mist: momx=momy=0) only ever Z-move + state-advance; `P_ExplodeMissile` (p_mobj.c:90): mom zeroed, deathstate, `tics -= P_Random()&3` (min 1), clears MF_MISSILE, deathsound.
3. **Damage formulas pinned exact (R08 §2.2, R07 §9.1)**: P_GunShot `5*(P_Random()%3+1)` (5/10/15), angle jitter `(P_Random()-P_Random())<<18` iff !accurate; fist `((P_Random()%10+1)<<1)` (2..20 even; berserk ×10); saw `2*(P_Random()%10+1)`; **shotgun = 7 pellets** (all !accurate); **supershotgun = 20 pellets**, damage `5*(P_Random()%3+1)`, jitter `<<19` plus vertical `slope + ((P_Random()-P_Random())<<5)`, ammo −2; rocket **direct** `=(P_Random()%8+1)*info->damage` (20..160); plasma direct 5, BFG direct 100. **Splash = A_Explode → P_RadiusAttack(…,128) from exactly two states (S_EXPLODE1, S_BEXP4 — R07 §9.2): rockets + barrels. Plasma/caco/baron do NO splash** (brief's "caco 10 / rocket 20 splash" wrong; the damage column is the direct factor). Falloff = `damage − chebyshev(dist−radius)`, needs P_CheckSight, bosses immune (M8 roster). **Brief corrections**: no alt-fire exists anywhere in 1.10; **no pain elemental in Doom 1/Freedoom Phase 1** (that's Doom 2 — R07 §14/15) — "pain alt = bouncing fireballs" is out of scope; plasma "spread" doesn't exist (single spawn + random flash sprite `flashstate+(P_Random()&1)`).
4. **Ammo economy (R08 §4)**: `maxammo={200,50,300,50}`, `clipammo={10,4,20,1}` (clip/shell/cell/misl); `num` param = clip loads, `num?num*clipammo:clipammo/2` (dropped clip = **5**, dropped rocket = **0**); baby/nightmare `num<<=1`; backpack doubles maxammo once + 1 load each; P_CheckAmmo fallback ladder exact order **plasma(c>0)→ssg(s>2,Doom2-gated)→chaingun→shotgun→pistol→chainsaw→missile→BFG(c>40)→fist**, then force downstate; BFG costs 40 (BFGCELLS). Pickups per R06 §8 sprite-dispatch table (CLIP 1/AMMO 5/SHEL 1/SBOX 5/CELL 1/CELP 5/ROCK 1/BROK 5; BON1/BON2/SOUL cap 200 direct; MEGA **commercial-only → never in our target IWAD**, pin the early-return; PSTR: berserk heals via P_GiveBody(100) → **cap 100**, forces fist).
5. **Psudo-aim (R08 §3)**: shot z = `z + height/2 + 8*FRACUNIT` (player: +36); cone `topslope=100*FRACUNIT/160`, bottom = −; P_AimLineAttack range 16·64·FRACUNIT returns aimslope (else 0); P_BulletSlope probes an+`1<<26`, an−`2<<26` (5.625° steps); hitscan uses MISSILERANGE=2048·FRACUNIT; impact pull-back: walls `frac − FixedDiv(4*FRACUNIT,attackrange)`, things `− FixedDiv(10*FRACUNIT,…)`; puff/blood live in **p_mobj.c** (R08 §3.4: z jitter `<<10`, puff momz=FRACUNIT tics−(0..3) min 1, attackrange==MELEERANGE ⇒ S_PUFF3; blood momz=2·FRACUNIT, damage<9→S_BLOOD3, 9..12→S_BLOOD2); MF_SHOOTABLE/over-under tests per PTR_* quotes.
6. **Missile spawn (R08 §3.6, R07 §9.4)**: spawn z = `source->z + 4*8*FRACUNIT`; P_CheckMissileSpawn: `tics -= P_Random()&3`, nudge `mom>>1` each axis then P_TryMove (blocked ⇒ explode immediately); P_SpawnPlayerMissile = BulletSlope-style probes + extra fallback (an=source angle, slope=0), `momz = FixedMul(speed, aimslope)`; monster P_SpawnMissile aims at dest with `dist = P_AproxDistance/speed; if(dist<1)dist=1; momz=(dest.z-source.z)/dist` + MF_SHADOW jitter `<<20`. **No P_SpawnMissileAngle/BADANGLE in 1.10** — callbacks are PTR_AimTraverse/PTR_ShootTraverse via P_PathTraverse (exists: pmaputl.pathTrace; **PT_ADDTHINGS currently throws** — M7-02 fills thing intercepts).
7. **Psprite machine (R08 §1)**: LOWERSPEED=RAISESPEED=**FRACUNIT*6**; WEAPONBOTTOM 128 → WEAPONTOP 32 ⇒ raise/lower exactly **16 tics**; P_SetPsprite loops while tics==0 (0-tic S_CHAIN3/S_MISSILE3/S_SAW3 cascade A_ReFire in-tic — same-tic double-fire guard = attackdown latch + P_CheckAmmo, never a re-dispatch of A_WeaponReady in the same tic); fire = `P_SetMobjState(mo, S_PLAY_ATK1)` + atkstate + P_NoiseAlert stub-slot (M8); bob **only in A_WeaponReady**: `sx = FRACUNIT + FixedMul(bob, finecosine[(128*leveltime)&FINEMASK])`, `sy = WEAPONTOP + FixedMul(bob, finesine[(128*leveltime)&(FINEANGLES/2-1)])` — reuses player.bob (M5); no A_WeaponBob/P_CheckNoRecoil; P_CalcSwing dead code; flash psprite copies sx/sy at end of P_MovePsprites; A_Light0/1/2 → `player.extralight` (exists render-side); full 9-weapon chains incl. flash states = R08 §2.1 table (d_items.c weaponinfo {ammo,up,down,ready,atk,flash}).
8. **Switching/refire (R08 §5, §1.5)**: BT_ATTACK=1, BT_USE=2, BT_CHANGE=4, BT_WEAPONSHIFT=3; keys '1'..'8' in G_BuildTiccmd (exists: ticcmd.ts) — **no cycling loop**; slot-upgrade (fist→chainsaw, +ssg Doom2-gate) in P_PlayerThink; missile/BFG attackdown latch but **A_ReFire has no latch ⇒ holding fire DOES refire rockets (~20 tics) / BFG (~60)**; `refire` counter: only the first shot of a hold is `accurate`. Reborn defaults: fists+pistol+50 bullets, usedown=attackdown=true (R08 §10).
9. **Powerups + palette (R08 §6/§7, R02 §2)**: INVULNTICS 1050 / INVISTICS 2100 / INFRATICS 4200 / IRONTICS 2100; invuln ⇒ fixedcolormap **32 (INVERSECOLORMAP — inverted, not red)** gated `>4*32 || &8`; infrared ⇒ fixedcolormap 1; invisibility sets/clears MF_SHADOW on expiry (fuzz renderer exists); berserk counts *up* (ST fade `12-(p>>6)` is M9 UI); damagecount/bonuscount decay −1/tic in P_PlayerThink. **The red/pickup flash is PLAYPAL bank selection** — red = `(cnt+7)>>3 + 1` (banks 1..8), bonus = `+9` (9..12), radiation suit bank 13 flicker — currently **not wired in framebuffer** (LUT machinery exists, bank is constant 0): M7-06 adds sim-side `paletteBand` computation + render bank select (ST_doPaletteStuff itself → M9). pw_* consumers that M7 owns: ironfeet=enviro damage skip (M6 hazard sectors), allmap = automap flag read (exists).
10. **In-tree assets**: prng (pRandom/mRandom, A-07/D008 split — **one shared P stream**; random-sites artifact per ARCH §5.2 planned-but-absent → M7-09 files `docs/design/random-sites.md`); PIT_CheckThing MF_SPECIAL slot = TODO-counter (M5-02) → filled by M7-05; thinglinks skeleton on an M5 branch — **absorb, don't recreate**; psprites.ts render module absent; rthings/vissprites/colormap/fuzz live; no wad/info/ dir yet; golden/viewpoint + fixture-map harnesses live.

## 1. Exit criteria (milestone-level)
1. `npm run check` green: states-table transcription L1 (row count 967, spot vectors vs R06/R08 dumps), pickup/weapon/damage suites, paletteBand unit.
2. L2 per-weapon suites: each weapon fires at a known dummy target under a seeded stream — assert **damage ranges + ammo deltas + tic timing** (ranges where math allows, exact hashes otherwise) + full-level seeded determinism incl. thinker interleaving (§6 R1).
3. L3 goldens: psprite frames (≥4 weapons mid-cycle), palette-diff pairs (pain flash, pickup flash, invuln inverse, infrared bright), pickup-route before/after.
4. L4: real fire-key + weapon-slot-key e2e (ammo decrements, psprite moves), pickup-walk route (health/armor/ammo/weapon/powerup collected, HUD messages deferred M9), death → press-use → level reload.
5. HOM=0 on psprite frames; determinism 1000-tic golden re-blessed once (mobj thinkers live), reason recorded.

## 2. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 1 | M7-01, M7-07 | M5/M6 main (cross-repo M6 assumptions §0.0) |
| 2 | M7-02, M7-03 | M7-01 |
| 3 | M7-04, M7-05, M7-06, M7-08 | M7-02 (+M7-03 for 05) |
| 4 | M7-09 | M7-06, M7-08 |
| 5 | M7-10 | M7-04..09 |
| 6 | M7-11 | M7-10 |

Disjointness: thinglinks/PIT_CheckThing/pathTrace-things owned by M7-02 only (04/05/08/09 consume); pplayer.ts by M7-03 only; pmap.ts merge conflicts with M6 expected — serialize merges with the orchestrator.

## 3. Tasks

### M7-01 — State-table infra + ActionId registry
- Goal: the 967-row states[] + mobjinfo[] + weaponinfo[] as typed flat tables with numeric action dispatch, no closures in hot paths.
- Owns: `src/wad/info/{states,mobjinfo,weaponinfo,sprnames}.ts`, `src/sim/a_actions.ts` (ActionId enum + switch, bodies registered by later tasks), `states.test.ts`.
- Consumes: R06 §1/§3, R08 §2.1. Produces: `State{sprite,frame(FF_FULLBRIGHT 0x8000),tics i16,action,nextstate,misc1,misc2}` in info.c order (S_PLAY_RUN1+n arithmetic valid), doomednum→MT_ Map (warn+skip unknown, R12), MF_* bit constants.
- Acceptance: 1) row count + statenum spot vectors (S_EXPLODE1, S_BEXP4, S_PUFF3, S_PLAY_ATK2=32773-style frame values) vs research dumps; 2) action ids unique, switch total (unknown id throws in tests); 3) absorbed-if-M6 check: if M6 already landed a table task, this task extends instead (file-ownership note in commit).
- Verify: `npx vitest run src/wad/info/states.test.ts`

### M7-02 — mobj runtime + ZMISC mover + thinglinks fill
- Goal: real mobjs live in the thinker arena — spawn/remove/state-set, P_MobjThinker, and the blockmap thing links every collision/splash/shoot path needs.
- Owns: `src/sim/p_mobj.ts` (or sim/p_mobj.ts naming per A-06), `p_mobj.test.ts`, thinglinks fill in `src/sim/map.ts`/`pmap.ts` (absorb M5 skeleton), **pathTrace PT_ADDTHINGS** in `pmaputl.ts` (PIT_AddThingIntercepts + intercept thing field −1→index).
- Consumes: M7-01, M5 thinker arena (§0.0a), P_XYMovement/P_ZMovement (M5-05). Produces: `pSpawnMobj/pRemoveMobj/pSetMobjState` (R06 §1 semantics verbatim incl. 0-tic loop + boolean alive), `pMobjThinker`, `pSetThingPosition/unset` (link-only re-insert, §3.5.5 rule), pSpawnMapThing (MTF skill filters, deathstarts/deathdrops off in SP, spawn tics desync), `pExplodeMissile`, `pKillMobj` shell (player branch + drop table; monsters M8), PSpecialThing **hook slot** (typed no-op counter; M7-05 registers).
- Acceptance: 1) state cascade truth table (0-tic chain executes N actions in one set; S_NULL removes mid-tic and caller bails); 2) ZMISC puff rises via momz with no XY, dies at state end; 3) thinglinks round-trip under move/split-MAXMOVE (wall test from M5-05 unchanged); 4) pathTrace PT_ADDTHINGS hits a planted dummy in the same intercept order as a brute-force reference; 5) hashState extended (mobj fields per ARCH §3.4) + zero steady-alloc.
- Verify: `npx vitest run src/sim/p_mobj.test.ts`

### M7-03 — Player states, pain/death flow, reborn
- Goal: the player is a state-table mobj: walk anim via velocity test (not flags), pain, death by the p_inter rules, press-use reload.
- Owns: `src/sim/pplayer.ts`, `pplayer.test.ts`, `player.ts` extension (powers/cards/ammo/weaponOwned/psprites/refire/attackdown/usedown/extraLight/fixedColormap/attacker fields), g_game.ts reborn hook.
- Consumes: M7-01/02. Produces: S_PLAY_* wiring (RUN via state−S_PLAY_RUN1 arithmetic §0.2, ATK1/ATK2 set by fire actions), P_Pain (painchance 255 ⇒ always, SKULLFLY exempt M8), P_KillMobj player branch (MF_SOLID off, PST_DEAD, P_DropWeapon), `pDeathThink` (viewheight −FRACUNIT to 6·FRACUNIT, turn-to-attacker ANG90/18, **BT_USE ⇒ PST_REBORN ⇒ ga_loadlevel**), G_PlayerReborn defaults §0.8, `pPlayerThink` full body (powers countdown, damagecount/bonuscount decay, fixedcolormap select per R08 §6.2, weapon-change block §0.8, MF_NOGRAVITY/CF_* sync kept from M5).
- Acceptance: 1) walk anim cycles iff RUN-state window (§0.2 test) + firing sets ATK1 and it returns; 2) death: weapon lowers and stays down (A_Lower PST_DEAD early-return exercised via 07), viewheight lands 6·FRACUNIT, use ⇒ level reload identical to fresh spawn hash; 3) pain state doesn't interrupt momentum (physics regression tie-in); 4) reborn: fists+pistol+50, usedown/attackdown true.
- Verify: `npx vitest run src/sim/pplayer.test.ts`

### M7-04 — Pickups + inventory (M5 callback slots finally filled)
- Goal: P_TouchSpecialThing dispatches by sprite exactly (R06 §8 table), with reach test, counts, and every P_Give* rule.
- Owns: `src/sim/p_inter_pickup.ts`(+test), registers PSpecialThing slot (M7-02), pmap PIT_CheckThing MF_SPECIAL branch (touch ⇒ call hook, still non-blocking).
- Consumes: M7-02 (+M7-03 for health/dead bail + berserk fist pending). Produces: reach rule (`delta > height || delta < -8*FRACUNIT` skip; dead toucher bail), dispatch incl. dropped-weapon MF_DROPPED half-ammo, keys→cards (SP: removed; netgame branch dead), backpack double-max once, MF_COUNTITEM/bonuscount+=BONUSADD, MEGA commercial-gate, itemcount/secretcount fields land for M9.
- Acceptance: 1) full sprite-table matrix (fixture per class: health/armor/ammo/powers/weapons/keys) asserting inventory deltas + mobj removal + false-cases (full health stim stays put, armor-at-max); 2) dropped clip = 5, dropped weapon = 1 load; 3) pickup of a thing while at max ammo leaves it in map (touch counter vs removal assert); 4) E1M1 skipIf census: every MF_SPECIAL thing maps to a handled sprite (no I_Error path reachable).
- Verify: `npx vitest run src/sim/p_inter_pickup.test.ts`

### M7-05 — Ammo economy + weapon switching + P_CheckAmmo
- Goal: the ownership/ammo layer between pickups (04) and the psprite machine (07): give/choose/switch with the exact §0.4 ladder and slot semantics.
- Owns: `src/sim/p_ammo.ts`(+test): P_GiveAmmo/GiveWeapon/GiveBody/GiveArmor/GiveCard/GivePower, `pCheckAmmo`, `pPickupWeapon` selection rules; feeds 04's give calls and 07's fire-cost checks.
- Consumes: M7-01 tables; parallel-safe with 02/03 (pure player-field logic).
- Acceptance: 1) ladder order matrix incl. plasma/BFG Doom-1 gates + "only from fist" auto-upgrade; 2) backpack once-semantics + rocket half-load=0 pin; 3) P_CheckAmmo costs incl. BFG 40/SSG 2 and forced downstate side-effect (counter from 07 slot); 4) powerup durations + MF_SHADOW on/expire-off (R08 §6.2 verbatim branches incl. berserk cap-100 heal).
- Verify: `npx vitest run src/sim/p_ammo.test.ts`

### M7-06 — Powerup render effects + palette bands + sfx slots
- Goal: powerups and flashes become *visible*: fixedcolormap plumbing (already render-side) driven by sim, PLAYPAL bank selection, and sfx-enqueue slots (no audio until M10).
- Owns: `src/sim/ppalette.ts`(+test: `paletteBand(player)` — red/bonus/radiation math §0.9), `src/render/view.ts`+`framebuffer.ts` (bank select read), `src/sim/psound_stub.ts` (typed S_StartSound enqueue counter ring; M10 replaces), player.ts damagecount/bonuscount/extraLight wiring checks.
- Must not touch: p_mobj/pmap/p_pspr.
- Acceptance: 1) band math goldens (damagecount 1/8/64/100 → banks; radiation flicker `>4*32||&8`); 2) L3 pair frames: invuln inverse + infrared + pain flash + pickup flash on a fixed viewpoint (skipIf wads, fixture fallback); 3) sfx slot called once per canonical event (fire/pickup/explode sites enumerated, counts asserted); 4) framebuffer bank = 0 everywhere pre-powerup (regression: all M3/M4 goldens unchanged).
- Verify: `npx vitest run src/sim/ppalette.test.ts tests/render/`

### M7-07 — psprite state machine + weapon view layer
- Goal: P_SetPsprite/P_MovePsprites/raise/lower/ready/refire per §0.7 + real weapon sprites on the framebuffer.
- Owns: `src/sim/p_pspr.ts`(+test), `src/render/psprites.ts`(+test) — pspr states from M7-01 weaponinfo table; `sim.injectButtons` debug hook; render reads psprite state + sx/sy → vissprites (fixed screen pos, no clipping vs world, drawn before world sprites).
- Consumes: M7-01; independent of 02-06 (fire actions arrive as registry slots).
- Acceptance: 1) raise/lower exactly 16 tics, sy per-tic golden; 2) ready-state bob formulas re-derived vs player.bob streams; 3) 0-tic A_ReFire cascade pins one P_FireWeapon per tic max (ammo counters per tic); 4) missile/BFG latch semantics §0.8 (press-release cycles; **hold refires** — tic-20 rocket assert); 5) L3: PISTOL/SGUN/CHAIN/MISSILE mid-anim frames incl. flash + extralight frame (HOM=0).
- Verify: `npx vitest run src/sim/p_pspr.test.ts src/render/psprites.test.ts`

### M7-08 — Hitscan: aim/attack/shoot traverse + impact states
- Goal: P_AimLineAttack/P_LineAttack/PTR_AimTraverse/PTR_ShootTraverse + P_BulletSlope (§0.5) bit-faithful on the existing pathTrace, incl. P_ShootSpecialLine dispatch into M6 specials.
- Owns: `src/sim/p_shoot.ts`(+test); pmaputl thing-intercept consumer (no edit — M7-02 owns); spawnPuff/spawnBlood live here? **No** — puff/blood *mobj states* exist via 01/02; spawn helpers live here, states referenced only.
- Acceptance: 1) cone math: targets at slope edges ±(100/160) accepted/rejected, two-sided narrowing through a window fixture; 2) BulletSlope 3-probe order pinned (fixture where probe-2 target differs from probe-1); 3) wall-hit z incl. frac pull-back 4-unit and sky-wall no-puff; thing hit: over/under, pull-back 10, blood variant by damage; 4) shot through two special lines fires P_ShootSpecialLine twice in crossing order (M6 interplay assert); 5) zero allocation in traverse (module-static shootz/linetarget/la_damage state per vanilla globals rule).
- Verify: `npx vitest run src/sim/p_shoot.test.ts`

### M7-09 — Projectiles + splash + random-sites artifact
- Goal: spawnMissile/P_SpawnPlayerMissile/P_CheckMissileSpawn, missile branch of PIT_CheckThing, A_Explode/P_RadiusAttack — and the P_Random call-site ledger.
- Owns: projectile spawn code (p_mobj extension), PIT_CheckThing MF_MISSILE branch (consume M7-02 links), `src/sim/pradius.ts`, `docs/design/random-sites.md` (every M7 pRandom site: action → calls-per-invocation table; feeds ARCH §5.2 parity + demo stretch).
- Acceptance: 1) rocket flight: mom from speed+angle, momz from slope, P_CheckMissileSpawn nudge/explode-if-blocked; 2) direct hit `(P_Random()%8+1)*20` range asserted under seeded stream; 3) splash matrix: wall impact → 128-falloff with LOS (fixture: wall-blocked victim takes 0); plasma impact → direct damage only (§0.3); 4) rocket never hits its shooter, damage-type immunity matrix vs targets; 5) random-sites doc reviewed against code (test greps pRandom( call count per module = ledger sum).
- Verify: `npx vitest run src/sim/pradius.test.ts src/sim/p_mobj.test.ts`

### M7-10 — L2 weapon suites + shared-stream determinism
- Goal: the evidence milestone — per-weapon scripted-shot goldens and the P_Random shared-stream discipline vs M6 thinkers.
- Owns: `tests/headless/weapons.test.ts`, `tests/headless/pickups.test.ts`, fixture maps (`tests/fixtures/m7Fixtures.ts`: firing range with dummies, pickup loop, hazard+ironfeet room).
- Acceptance: 1) per-weapon scenario: fire until X tics, assert ammo curve, damage-on-dummy **range** from the pinned formula + prnd index, shot tic (R08 §2.1 "fire occurs at" column); 2) same scenario at two M6-thinker loads (doors moving vs idle) — damage hashes differ **only** per ledger-explained interleaving (documented deltas, not silence — §6 R1); 3) full 967-state tables driven 2000 tics with mixed fire+pickup+splash: hash golden + double-run determinism; 4) 1000-tic baseline re-bless once (thinkers live), old tables moved not deleted; 5) berserk/invuln/ironfeet interaction shots (berserk punch ×10 range, invuln walk on hazard = 0 damage).
- Verify: `npx vitest run tests/headless/weapons.test.ts tests/headless/pickups.test.ts tests/headless/loop.test.ts`

### M7-11 — L4 e2e + exit sweep
- Goal: real keys on the real page: fire, switch, kill a target-less wall (puffs visible), walk a pickup route, die and press-use.
- Owns: `e2e/weapons.spec.ts`, `e2e/pickups.spec.ts`, `src/debug.ts`/`types/debug.ts` extension (`sim.setWeapon`, `sim.fire(nTics)` via scripted buttons through the real ticcmd path — not a direct P_FireWeapon call; `state().player.{ammo,weapons,powers,psprite}`), `docs/TASKS.md`/`JOURNAL.md`, DECISIONS edit (**D012-DRAFT cross-ref + D-0xx: palette-band-in-M7, ST_doPaletteStuff-in-M9 split**).
- Acceptance: 1) Key1/Key3 + space/mouse-fire: `state()` ammo drops, psprite state advances, pixel region of the weapon changes; 2) pickup route on FIXMAP: health/ammo/weapon/powers readout changes in walk order; E1M1 skipIf: pistol→shotgun reachable route sanity; 3) noclip-free death (hazard fixture) → press-use → respawn hash equals fresh-level hash; 4) zero console errors; full `npm run check && npm run e2e && goldens --check` green.
- Verify: `npm run e2e -- e2e/weapons.spec.ts e2e/pickups.spec.ts`

## 4. Deviations, decisions, gaps found this pass
- **D-0xx draft (M7-11 files)**: palette-band selection lives sim-side in M7 (deterministic, hashed); ST_doPaletteStuff/`cnt` presentation stays M9 — split point pinned here so M6/M9 planners don't double-implement.
- DEHACKED fullbright deferred M8 per A-02/D008 (D002 is env facts, not this) ⇒ fullbright pickup sprites render dark in light-0 fixtures — accepted, L5 note only.
- M6-plan absence (§0.0): all cross-milestone seams above are the contract; if M6 lands different file names, M7-01/02 absorb at rebase — orchestrator serializes pmap.ts/p_tick.ts merges.
- P_NoiseAlert call sites present but counted stubs (M8); monster-side give/damage branches of p_inter (infighting swap) untouched; pain/death of non-player mobjs stubs (M8 roster) — P_KillMobj drop table dormant.
- `hashState` grows: psprites, ammo/powers/weapon fields, mobj arena rows → one-time re-bless (M7-10), reason recorded; psprite tics/state hashed (L2 firing goldens depend on it).
- Local-source absence (§0.1): any fact not in R06/R07/R08 quotes needs an empirical fixture before code; no web-lore imports.

## 5. Exit verification (run on integrated main)
1. `npm run check` — tables L1, all M7 sim suites, psprites render suite, zero-console everywhere.
2. L2: M7-10 suites (per-weapon matrices, splash matrix, pickup census, shared-stream deltas explained), re-blessed 1000-tic golden.
3. L3: psprite/palette pair goldens green incl. E1M1 skipIf set; HOM=0 assert on all psprite frames.
4. L4: weapons + pickups specs (real keys), death/use-restart route; debug API additions typed.
5. L5: screenshot pack — firing frames ×4 weapons, invuln/infrared/flash pairs, pickup route strip; reviewed vs R08 §2.1 chain table; findings → TASKS.md; random-sites.md merged (feeds M8 + demo stretch).

## 6. Risks
1. **P_Random shared-stream coupling (top)**: weapon damage *is* prnd-index arithmetic — any M6/M8 thinker adding pRandom calls between shots changes every weapon golden. Discipline: single stream (no per-subsystem RNGs — rejected as non-vanilla), `random-sites.md` ledger with a call-count test, L2 scenarios run on *idle* levels (thinker-free) for point hashes and on loaded levels for range asserts; regression = ledger diff, not silent re-bless.
2. **Thinker-arena ordering vs M5/M6 (determinism rule §3.5.5)**: missiles spawning/removing mid-tic inside P_RunThinkers (deferred-swap rule) must not perturb player think order — covered by double-run + moved-not-deleted goldens; item death-removal (P_RemoveMobj during PIT traversal!) tested explicitly (touch-and-remove happens *inside* P_TryMove traversal — vanilla does it next-tic via P_MobjThinker? pin the actual order from R06 §8 trigger path in M7-04 acceptance 3).
3. **Firing-while-moving coupling**: P_FireWeapon sets S_PLAY_ATK1 (state change ≠ physics), saw lunge writes cmd.forwardmove, psprite bob reads player.bob — a physics regression from M5 (bob/thrust) shows up as psprite-golden drift; scenario matrix runs shots while walking/turning, not just standing.
4. **Psprite tics vs 0-tic cascades**: the "double press same tic" exploit question degenerates in 1.10 (latch + cascade already pin one shot/tic); the real hazard is our SetPsprite loop re-running A_WeaponReady — pinned by M7-07 acceptance 3 ammo-count-per-tic assert.
5. **Freedoom parity surprises**: sprite names/chains differ from doom1 (R12) — weapon behavior isn't dehacked-touched but *graphics naming + fullbright* are; M7-07 golden blesses against Freedoom lumps only, L1 transcription tests run on synthetic dumps (wadds rule); supershotgun stays dead-coded with a pin comment (Doom-2 gate).
6. **pmap.ts/p_tick.ts merge collisions with M6** (§2 note): schedule M7-02 merges only on a quiet main; re-run E1M1 skipIf physics suite after each to catch link-order regressions.
