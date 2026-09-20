# M7 P_Random call-site ledger (random-sites artifact)

Plan ownership: `docs/design/random-sites.md` (M7-plan §M7-09). The
orchestrator brief for this branch forbids touching `docs/**`, so the
file sits at the repo root — **orchestrator: move to
`docs/design/random-sites.md` on merge.** Machine-checked surface:
`src/sim/random-sites.ts` (`RANDOM_SITE_CALLS` + `scanRandomSites`,
asserted by `src/sim/random-sites.test.ts`, both directions — adding or
removing any `pRandom(` call site in `src/sim` without a ledger update
fails `npm run check`).

One shared P stream (prndindex) — no per-subsystem RNGs (plan §6 risk 1).
`P_Random()` = `M_RANDOM` = pre-increment into the 256-byte RNDTABLE
(prng.ts). Counts below are **draws per invocation**; the ledger table
stores `pRandom(` SOURCE-OCCURRENCES per module (one statement with
`P_Random()-P_Random()` = 2 occurrences = 2 draws; the BFG 15-dice loop
= 1 occurrence = 15 draws at runtime — pinned behaviourally in
`pradius.test.ts` instead).

## M7-09 projectile sites (this task)

| Site (file:fn) | Action / trigger | Draws | Notes |
|---|---|---|---|
| p_mobj.ts `P_SpawnMobj` | EVERY mobj spawn (lastlook) | 1 | incl. missiles/EXPBFGs; player spawn = documented skip (M7-03) |
| p_mobj.ts `P_ExplodeMissile` | any missile impact | 1 | `tics -= P_Random()&3` (draw even if the deathstate removed the mobj) |
| pmissiles.ts `P_CheckMissileSpawn` | every missile spawn | 1 | same tics formula (spawn-side) |
| pmissiles.ts `P_SpawnMissile` | MF_SHADOW ("fuzzy player") dest only | 2 | `(P_Random()-P_Random())<<20` angle jitter |
| pmissiles.ts `PIT_CheckThing` MF_MISSILE | missile → shootable thing | 1 | direct damage `(P_Random()%8+1)·info->damage` (rocket 20..160) |
| pradius.ts `A_BFGSpray` | S_BFGLAND3, **per HIT ray** | 15 + 1 | 15× `(P_Random()&7)+1` dice + 1 MT_EXTRABFG-spawn lastlook = **16 × hit-rays total, ray order**; MISS rays draw NOTHING (40 aims = 0 draws) |
| p_mobj.ts `P_SpawnPuff` | hitscan wall puff (M7-08) | 3 | z jitter 2 + tics 1 |
| p_mobj.ts `P_SpawnBlood` | hitscan thing blood | 3 | z jitter 2 + tics 1 |
| p_mobj.ts `P_SpawnMapThing` | level load, thing with tics>0 | 1 | `1+rand%tics` desync |
| p_pspr.ts (M7-07/08) | fire actions | see scan | punch 1, saw 3, plasma flash 1, gun shot 3, shotgun 7×… (SBB: supershotgun 20-pellet 6-occ), BFG FIRE = **0** (A_FireBFG draws nothing; spray at impact) |
| pplayer.ts | P_DamageMobj player half | 2 | `&1` fall-forwards + painchance draw |
| pmap.ts / plights.ts / pplats.ts / pspec.ts | M5/M6 hazards, flashers | 4/5/1/1 | unchanged by M7-09 |

## SPLASH TRUTH (1.10 verdict, mirror p_mobj.c/p_map.c/info.c verified)

* `P_ExplodeMissile` performs **NO area damage** — zero/momentum clear,
  deathstate, tics draw, `MF_MISSILE` clear, deathsound. Splash runs from
  the DEATH-STATE action: `A_Explode → P_RadiusAttack(thingy, target, 128)`
  exists on **exactly two states** (info.c grep): `S_EXPLODE1` (MT_ROCKET
  deathstate) and `S_BEXP4` (barrel). **Plasma, monster shots, caco/baron:
  zero splash; BFG: no A_Explode at all — its damage is `A_BFGSpray`
  (S_BFGLAND3), 40 directed 90°-arc hitscan rays** (16*64 range, 15d8
  damage each, MT_EXTRABFG spawn per hit).
* `P_RadiusAttack` falloff = `damage − chebyshev(max(|dx|,|dy|) − radius)`,
  LOS-gated (`P_CheckSight`; this port: reject-table + pathTrace cone walk,
  result-equivalent — deviation pinned in pradius.ts header), bosses
  (cyborg/spider) immune, scan half-width = `damage` units (the
  `(damage+MAXRADIUS)<<FRACBITS` MAXRADIUS term wraps out in C 32-bit —
  kept literally). **P_RadiusAttack itself draws NOTHING** (the damage
  draws belong to P_DamageMobj bodies).
* Rocket-jump fact: 1.10 `A_FireRocket` (A_FireMissile, p_pspr.c:437) has
  NO recoil/momentum write; "rockets never hit shooter" is ONLY the
  PIT_CheckThing same-species `thing == tmthing->target` skip. Splash has
  no source exclusion ⇒ shooting the floor at your feet splash-damages
  you (pinned in pradius.test.ts; full rocket-jump feel needs the M7-05
  damage BODY — the damageSlot log proves the event today).
* Missile spawn offset: NONE in 1.10 (both spawn sites place the missile
  at source x/y, z + 4·8·FRACUNIT — the "20*FRACUNIT offset" question is
  resolved; the only nudge is CheckMissileSpawn's `mom>>1` prestep).

## Stream parity notes

* Rocket fire → wall impact ⇒ draws: lastlook 1 + spawn tics 1 + explode
  tics 1 = 3 (+ direct-hit 1 when a thing is hit, BEFORE the explode draw;
  event order PIT-then-splash).
* BFG spray start = explode tics draw, then 16 × hit-rays.
* Aim probes (P_AimLineAttack, all 3 probe variants) draw NOTHING —
  missile autoaim never shifts the stream (verified).
