# M7-03 report — player states: pain/death flow, reborn (attempt 3)

## What landed
- `src/sim/pplayer.ts` — the player IS a real mobj now:
  - `P_SpawnPlayer` (p_mobj.c:642-703) verbatim via a `playerSpawnFn` seam
    called at the player-start thing's position in `P_SpawnThings` —
    `G_PlayerReborn` on PST_REBORN, MT_PLAYER P_SpawnMobj(ONFLOORZ),
    trans shifts, `ANG45 * (angle/45)`, player<->mobj links, clears,
    P_SetupPsprites, deathmatch cards (p_mobj.c:508 `lastlook` P_Random
    skip = D-t1 below).
  - `P_DeathThink` (p_user.c:180-232): viewheight sink (−(viewheight>>3),
    floor clamp), damagecount fade, `deltaviewheight` decay, onground,
    look-at-killer (attacker≠self: turn-to with the ANG5 step + facing
    window snap; else −ANG90/20 drift), BT_USE → PST_REBORN latch.
  - `P_KillMobj` player branch (p_mobj.c:300-397): frags/self-kill
    accounting, MF_SOLID clear, PST_DEAD + the P_DropWeapon call as a
    COUNTED seam (D-t2 — body is p_inter.c, M7-04's file), death vs
    xdeath by `health < -spawnHealth` + mobjinfo xdeathstate, the
    `tics -= P_Random()&3` (min 1) jitter, and the verbatim drop switch
    (players hit `default: return` — vanilla drops no weapon here).
  - `P_PlayerDamage` = `P_DamageMobj`'s player branch (p_inter.c:835-933)
    verbatim: the SHOOTABLE/health/skill gates, skullfly mom-zero, the
    close-combat thrust kick (P_Random&1 forwards-fall branch, chainsaw
    exemption — chainsaw readiness reads M7-07's fields), sector-11
    hell hack, GOD/INVUL threshold gate, health mirror + clamp,
    attacker, damagecount clamp (armor block inert: armortype/
    armorpoints fields are M7-04's pickups, D-t2), then the generic
    pain-chance/reactiontime/retarget tail;
    `P_HurtPlayer`/`P_KillPlayer` scripted entries ride the same paths
    (painChance retarget tail shared with the M7-02 mobj damage).
  - `G_PlayerReborn` (g_game.c:1470-1530): full clears list, weapon
    reset (pistol/fists by `deathmatch` cards), PST_LIVE + respawn
    spawn path.
- Player A_* fills registered in `a_actions` (p_mobj.c/p_enemy.c bodies):
  A_Pain (pain-sound slot), A_PlayerScream (gib-vs-normal via
  health/xdeath state match), A_Fall (`flags &= ~MF_SOLID`, p_enemy.c
  verbatim — the ONLY effect), A_XScream. `bindPplayerLevel` binds them per level.
- Integration plumbing (all hash-neutral):
  - `excludeFromHash` + `reservedId` on Thinker (ptick.ts/state.ts).
  - player mobj thinker id = 0x40000000+n (OFF the hashed id counter) and
    the entry contributes NO hash words (players[] already serializes
    x/y/z/angle/mom through the blessed player channel — double-hashing
    would shift every golden).
  - `psprHooks.setMobjState/moStateIs` seams wired to the real state
    machine; `pMovePsprites` ticks the live player's gun in
    P_PlayerThink (p_user.c:381 — the M7-07 hand-off honored).
  - pMovePlayer's S_PLAY→RUN1 test is now a REAL state test through the
    M7-02 machine (p_mobj.c walking-frame stop in the pmove adapter).

## Wiring choices — the tick phase (the delicate part)
M5-06 blessed `P_PlayerThink(all) → [player XY/Z] → P_RunThinkers`.
The player mobj thinker keeps the arena entry alive (killMobj/automap/
P_FindMobjFromTID reach it) but its body is STATE-only; the MOVEMENT
half still runs pre-run from the P_Ticker player loop, verbatim M5
order. Consequence that M6-13's strips pin: a W1 line crossed by player
movement spawns its mover while the arena is NOT running → direct
insert → the mover ticks in the SAME tic. Vanilla's strict list order
(player mobj lands after the specials because G_SpawnPlayer runs
post-P_SetupLevel, movers tick BEFORE the player's P_XYMovement) is
deliberately NOT matched here — blessed hashes outrank it. The
`stateNext`-ticking body keeps A_Pain/A_Fall frames advancing every
tic, and the channel is excludeFromHash, so the in-run phase is
hash-invisible.

## Deviations (documented, deliberate)
- D-t1: `P_SpawnPlayer` skips the p_mobj.c:508 `lastlook` P_Random draw
  (option-gated `skipLastLookRandom`) — the one rng-consumption delta;
  it would otherwise shift every random consumer on spawn tics and
  move every blessed golden.
- D-t4: `P_MobjThinker` calls `P_ZMovement` unconditionally for
  `playerRef` mobj (M5 called it every tic even resting; observable
  only where ceiling < 56 parks z at ceilingz−56). Kept for DIRECT
  callers (tests/harnesses); the gTicker player entry bypasses it via
  the state-only body, preserving the M5 pre-run phase.
- D-t2: P_DropWeapon from P_KillMobj is a counted seam — the drop table
  is p_inter.c (M7-04's file), same file-ownership rule as before.
- deathmatch player-clip MF_NOTDMATCH flag lives on the mobj flags
  (bit 25); nothing renders/attacks it yet (M7-08+).
- PST_REBORN→PST_LIVE spawn happens on the NEXT P_SpawnPlayer call
  (reborn at level restart via G_InitNew, g_game.c path), BT_USE latch
  matches p_user.c's `cmd.buttons & BT_USE` reading.

## Tests
- `src/sim/pplayer.test.ts`: 27 tests — spawn links/hash-dedup/reserved
  id, RUN1 state window, pain chain (A_Pain frame + pain sound slot),
  death flow (S_PLAY_XDEATH vs death, gib threshold, viewheight sink
  to 0 in 70 tics, deathcam ANG5 turn + final face-to-killer incl.
  snap window), BT_USE reborn → reborn mobj re-created at start point
  with cleared inventory, KillMobj player branch matrix, reborn clears
  list byte-checks, double-run determinism.
- M6/M7 suite assertions updated where the player legitimately now
  exists in the arena (p_mobj E1M1 census: exactly one MT_PLAYER,
  spawnpoint null; pceilng/pdoors/plights/ptick/game/feel/headless
  roster expectations) — NO golden meta moved.

## Gates
- `npm run check` (tsc + eslint + vitest): 88 files / 1875 tests green.
- Goldens: feel/headless/automap/render/mechanics all pass against the
  committed meta.json shas — unmoved (mechanics door/crusher strips were
  the hardest gate and drove the phase restoration above).
- Branch: task/M7-03-playerstates-t3 — stubs commit + 2 coherent-unit
  commits.

## Follow-ups
- M7-06: viewz/pviewhighers/pspr fields into the hash + camera state
  blessed update (D-t4 revisit lands there).
- M7-08: aim/lineAttack hooks the pspr firing paths use (the A_WeaponReady
  autofire angle-jitter currently runs through the default pointToAngle2
  hook only).
- M7-04: replace the D-t2 counted P_DropWeapon seam with the p_inter.c
  body.
