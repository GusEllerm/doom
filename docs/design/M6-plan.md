# M6 Plan — Level mechanics: line/sector specials, movers, keys, teleports, exits

Status: planned. Parent: docs/ROADMAP.md M6. Inputs: ARCHITECTURE.md §3.2/§3.5 (tic order, thinker arena), §5.1 (level-mechanics zone/files), §2.4 (player_t cards/powers, thinker ids), R05 (primary — specials table transcribed from raw linuxdoom-1.10 this-pass + prior), R04 §8 (P_TryMove spechit cross, P_TeleportMove/telefrag), R06 §mobj (MT_TELEPORTMAN doomednum 14; key doomednums 5/6/13 cards, 38/39/40 skulls — skull color pairing cross-check at impl: R05 §5 vs R06 disagree), R08 (P_PlayerInSpecialSector call site p_user.c), M5-plan (the movement/collision stack this consumes verbatim: pmaputl/pmap/pslide/pmove/puser + `pcross.stub.ts` counted stub being replaced).
Exit (from ROADMAP): per-special fixture-map L2 tests — doors/locked keys/lifts/crushers/stairs/switches/teleporters/lights/damage floors/secrets/exits, **R05 tables 100% covered** (all 139 line specials = numbers 1–141 minus unassigned 78/85, plus 15 sector specials); E1M1 integration: reach exit via keys (L4 scripted route).

## 0. Source truths pinned this pass
1. **Source base.** `/tmp/DOOM-master/linuxdoom-1.10/` in this checkout contains ONLY renderer files — the full id tree `/tmp/DOOM-full/` (all 30 p_*.c) was read instead; it is a sibling revision of the same codebase (sliding-door system `#if 0`'d, no polyobjs). **R05 (verified against raw linuxdoom-1.10) stays the arbiter**; DOOM-full diffs found this pass are cosmetic (`-avg/-timer` levelTimer — not ported).
2. **No special tables, three dispatchers** [R05 §1/§2]: `P_UseSpecialLine` (p_switch.c), `P_CrossSpecialLine` + `P_ShootSpecialLine` (p_spec.c). W-class = `line->special = 0` at case end (exits 52/124 exempt); S1 disarm happens **inside** `P_ChangeSwitchTexture` after the action-returned-true gate. Census, 139 line specials, families × counts: **doors 43** (manual/locked-manual 1,26–28,31–34,117,118; tagged 2,3,4,16,29,42,46,50,61,63,75,76,86,90,103,105–116; locked-button 99,133–137) · **plats 21** (10,14,15,20,21,22,47,53,54,62,66,68,87,88,89,95,120–123) · **floors 38 + stairs 4 (7,8,100,127) + donut 1 (9)** · **ceilings 13** (6,25,40,41,43,44,49,57,72–74,77,141) · **lights 10** (12,13,17,35,79–81,104,138,139) · **teleports 4** (39,97,125,126) · **exits 4** (11,51,52,124) · **scroll 1** (48). Non-dispatch: **48** collected by `P_SpawnSpecials` into `linespeciallist[]`, `textureoffset += FRACUNIT` per tic in `P_UpdateSpecials`. No conveyor/sector-rotation specials exist in 1.10.
3. **Registry** = `P_SpawnSpecials` (verified p_spec.c): sector scan (1,2,3,4→spawn-strobe-and-keep-4,8,9→`totalsecret++` keep-9,10,12,13,14,17), line scan for 48, then `activeceilings[]/activeplats[]/buttonlist[]` init. Tag matching is ONLY `P_FindSectorFromLineTag` scanning `sectors[i].tag == line->tag` by ascending sector index, resumable (`start`) — **no tag-0 fallback** [R05 preamble].
4. **Tie-order pin (map-order dependence):** all `P_Find*Surrounding` / `getNextSector` / stairs-chain / `lowerAndChange` texture-source / `raiseToTexture` min-bottomtexture scans iterate `sec->lines[0..linecount)` in **P_GroupLines construction order = ascending linedef index** (our map.ts already links this way). Min/max *values* are order-free, but first-match *sector picks* are not — every helper is written against that exact order; `P_FindNextHighestFloor` keeps the `MAX_ADJOINING_SECTORS` (20) overflow guard as a typed counter (vanilla fprintf+break).
5. **Mover cores**: `T_MovePlane(sector,speed,dest,crush,floorOrCeiling,dir)` is physically in p_floor.c (shared by all four families) — carved to `pplane.ts` for file-disjoint families (deviation D-? noted §4, behavior verbatim). `P_ChangeSector`/`PIT_ChangeSector` live in p_map.c: height-clip ok → gib-dead-path → MF_DROPPED remove → non-SHOOTABLE ok → **10 dmg every `!(leveltime&3)` tic** + blood (M7/M8 slots). crush=false planes roll back to `lastpos`; crush=true planes stay crushed (floor/ceiling-down); ceiling-**up** never checks (the `#if 0` pin) [R05 §7]. 1.10 `crushAndRaise`/`silentCrushAndRaise`/`lowerAndCrush` slow to `CEILSPEED/8` on contact; fastCrush keeps speed=2 [R05 §8]. `EV_DoDonut` is p_spec.c in 1.10 — implemented in pfloor.ts here (ownership cleanliness, same call semantics).
6. **Keys** [R05 §5]: `card_t` 6 slots; `player.cards` exists in ARCHITECTURE §2.4 but not in the M2-era player.ts → added M6-11. Checks are inline (NO `P_CanUnlock`): door 26/32 blue, 27/34 yellow, 28/33 red (`card||skull`), button 99/133, 134/135, 136/137; failure = `player->message = PD_*K/O` (exact d_englsh strings) + `sfx_oof`. Pickups are M7 (`P_TouchSpecialThing`, sprite-name dispatch) → tests/E1M1 route use a **debug `giveCard` hook** (documented; M7 replaces with real pickups + re-runs the route).
7. **Teleport** [R05 §11]: `EV_Teleport(line,side,thing)`: missiles rejected; **`side==1` → no-op**; finds an `MT_TELEPORTMAN` (doomednum 14, flags NOSECTOR|NOBLOCKMAP) **living in the tagged sector**; `P_TeleportMove` (M5-03 shell, telefrag 10000→damage slot) fail ⇒ total fail, else `z=floorz`, `viewz` recompute for players, fog×2 (destination fog 20 units along dest angle), `reactiontime=18`, `angle=dest.angle`, mom=0. Monster-only 125/126 gate lives in the dispatcher; 39/97 fire for players too.
8. **Exits/secrets/damage sectors** [R05 §3.2/§10/§13]: `G_ExitLevel`/`G_SecretExitLevel` set `ga_completed` (+ `secretexit` global) — M9 game flow; M6 lands a typed `exitRequest: none|normal|secret` flag that halts stepping in tests. Sector-9 secrets: `totalsecret++` at load, `secretcount++` + `sector.special=0` when grounded in it (no on-screen message in 1.10). Damage sectors: `!(leveltime&0x1f)` cadence, 5/10/20 dmg, `powers[pw_ironfeet]` gate (always 0 until M7) with the `P_Random()<5` bypass for 4/16; sector 11 (E1M8 finale) clears CF_GODMODE and exits at health ≤ 10 — implemented against the same hook slots. `ML_SECRET` only blocks monster use.
9. **Switches/buttons** [R05 §12]: `P_InitSwitchList` → flat xor-1 pair list (SW1↔SW2, gamemode filter); `P_ChangeSwitchTexture(line,useAgain)`: disarm-first, then the **special-11 quirk** (clear-before-check ⇒ exit switch plays `swtchn` not `swtchx`); `P_StartButton` MAXBUTTONS 16, BUTTONTIME 35, same-line re-press keeps original timer; `P_UseLines` from `A_ReFire`/use button via `P_PathTraverse` at `USEMASK = 8*64*FRACUNIT`, "can't use more than one special line in a row" (first traverse returning false aborts). Texture changes are real sim-side side-texture mutations (renderer re-reads each frame; no push API).
10. **In-tree today** (main = M5-01 merged, M5 wave 2-7 landing in parallel): `pmaputl.ts` + M5's `pmap/pslide/pmove/puser` + `pcross.stub.ts` counted stub (replaced by M6-03); `thinglinks`; hashState hashes **players only** — M6-01 extends per ARCH §3.4 (sector floorZ/ceilingZ/light/special + thinker arena; one-time re-bless, reason recorded). No live sector copy, no thinker arena, no sfx/message/damage emitters → M6-01 adds them as typed slots (M7 `P_DamageMobj`, M9 messages, M10 audio replace the bodies, not the call sites). `mapBuilder` already carries line `special` + door gaps; sector tags/specials and per-line tags are the M6-02 extension.

## 1. Exit criteria (milestone-level, objectively checkable)
1. `npm run check` green: every family suite + the **coverage test**: for all 139 line specials (1–141 ∖ {78,85}) and 15 sector specials, a table entry asserts {dispatcher, class W1/WR/S1/SR/GR/manual, family task} and at least one executed L2 scenario per special id (fixture-based; committed per-scenario hashes) — the "100% covered" claim is machine-checked by `specials-coverage.test.ts`, not prose.
2. Thinker determinism: mover tick order = insertion order (§3.5.5); every fixture scenario golden = sector-height/light hashes at scripted tic marks + double-run equality; PRNG-consuming movers (perpetualRaise init phase, strobes, fireflicker) hashed with prndindex included.
3. Crush + damage-floor cadence proven against the **damage slot log** (thing id, amount, tic) — flat 10 dmg/4 tics and 5/10/20 per 32 tics — no real damage math (M7) or gibbing (M8); slot call counts asserted.
4. E1M1 skipIf L4: scripted route reaches the exit using `giveCard` + real use-button keypresses (special-cleared/locked-door refusals asserted), `exitRequest === normal`; secret-route variant (51/124 if present in fixture; E1M1 route = normal exit) sets `secretexit`.
5. L5: door/plat/crusher animation PNG strips reviewed vs R05 timing constants; `npm run check && npm run e2e` green on integrated main.

## 2. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 1 | M6-01, M6-02 | M5 main (no intra-M6 deps) |
| 2 | M6-03, M6-04 | M6-01 |
| 3 | M6-05, M6-06, M6-07, M6-08, M6-09, M6-10, M6-12 | M6-03, M6-04 (files disjoint by design) |
| 4 | M6-11 | M6-05, M6-09 |
| 5 | M6-13 | all |

Reuses as-is: M5 pmaputl/pmap/pslide/pmove/puser + spechit cross plumbing (the dispatch call site just stops being a stub), thinglinks, blockmap CSR, `runHeadless`/`hashState`/golden machinery, mapBuilder, `__doom.sim.{stepTics,warp,setNoclip}` hooks, motion-strip.mjs (L5).

## 3. Tasks

### M6-01 — Thinker arena + live world + hook slots (p_tick.c + state plumbing)
- Goal: movers have a home — an insertion-ordered thinker arena with sector `specialdata` back-refs, live mutable sector SoA, and typed no-op hook slots (damage/sfx/message/exit) that later milestones fill without touching call sites.
- Owns: `src/sim/ptick.ts`, `src/sim/hooks.ts`, edits `src/sim/state.ts` (live sector SoA {floorZ,ceilingZ,light,special,tags} + `exitRequest` + hash extension per ARCH §3.4), `src/sim/game.ts` (P_Ticker order §3.2: playerThink → runThinkers → updateSpecials → leveltime++).
- Must not touch: `src/render/**` (reads live SoA via the state seam — verify renderer still reads static map data OR diffs to live light/height fields; if render reads switch side textures, they must come from the live side SoA added here), `docs/**`.
- Produces: `addThinker/removeThinker` (deferred swap, sentinel -1, Map-arena order = vanilla list order), `sectorSpecialData(i)` set/get, `damageSlot(thing, dmg, source)` / `sfxSlot(id, x,y,z)` / `messageSlot(str-id)` / counters; `totalsecret/secretcount/specialexit` run globals.
- Acceptance: 1) thinker tick order incl. add-during-tick-next-tic + remove-during-iterate tests; 2) hashState covers sector fields + arena in arena order; M2-06/M5 goldens re-blessed ONCE (reason: "M6 world-state fields"); 3) hook slots count-logged, zero sim→platform imports (A-06); 4) renderer E1M1 skipIf frame identical while sectors static (live-view wiring proof).
- Verify: `npx vitest run src/sim/ptick.test.ts src/sim/state.test.ts`

### M6-02 — Fixture tooling: specials/tags/things in mapBuilder (spec-data only)
- Goal: fixture maps express every family — per-line `tag`, per-room `special`/`tag`, sector floor/ceiling specials, switch-textured use lines, teleport-destination (type 14) and card (5/6/13) things.
- Owns: `tests/fixtures/mapBuilder.ts`, `mapBuilder.test.ts`. Must not touch: `src/**`.
- Acceptance: 1) round-trip tags/specials into LINEDEFS/SECTORS; 2) BSP property test green with things; 3) new fields optional — all existing FIXMAP goldens unchanged (no re-bless); 4) helpers for standard family rooms (lift shaft, crusher hall, stair step-up, strobe room).
- Verify: `npx vitest run tests/fixtures/mapBuilder.test.ts`

### M6-03 — Special registry, dispatch skeleton, P_Find* helpers (p_spec.c)
- Goal: every special number routes to the right dispatcher case with vanilla class semantics from day one — mover bodies behind typed family stubs that later tasks replace.
- Owns: `src/sim/pspec.ts(.test)`, `src/sim/specials-table.ts` (the 139+15 census), stub files `pdoors/pplats/pfloor/pceilng/plights/ptelept/pswitch.ts` exporting `EV_*/P_*` bodies that increment `unimplementedSpecial`. Replaces `pcross.stub.ts`; wires P_CrossSpecialLine (missile gate, monster-allowed {4,10,88,39,97,125,126} rule) + P_ShootSpecialLine (24/46/47 + non-player 46-only) + P_UpdateSpecials (scroll 48, button tick delegation, `levelTimer` NOT ported — noted) + P_SpawnSpecials (sector pass per §0.3, activeplats/ceilings/buttonlist init) called from map setup.
- Deps: M6-01.
- Acceptance: 1) coverage test drives all 139 ids through the real dispatchers (stubs hit once each — the §1.1 skeleton); 2) one-shot clears vs GR keeps vs side==oldside no-fire (uses M5 spechit path); 3) `P_FindSectorFromLineTag` resumable scan order == ascending sector index (order-pin test); 4) cross into a special line fires exactly once per side flip, teleport `side==0` gate; 5) helpers (`P_Find{Lowest,Highest}Floor/CeilingSurrounding`, `NextHighestFloor` with 20-cap counter, `getNextSector`, `P_FindMinSurroundingLight`) vs brute-force reference on seeded fixture + E1M1 skipIf.
- Verify: `npx vitest run src/sim/pspec.test.ts src/sim/specials-table.test.ts`

### M6-04 — T_MovePlane + P_ChangeSector + crush model (p_floor.c core / p_map.c)
- Goal: the shared one-tic plane step — move, contain, crush-or-rollback — is exact for all four families, with damage only via the M6-01 slot.
- Owns: `src/sim/pplane.ts(.test)`, `src/sim/pmap.ts` additions (`pChangeSector`, `pitChangeSector` reusing M5 `pThingHeightClip`).
- Deps: M6-01 (also M5-02/05 clip helpers).
- Acceptance: 1) rollback-vs-stay matrix crush×direction×floor/ceiling incl. the double-`P_ChangeSector` on pastdest; 2) ceiling-up never blocked (`#if 0` pin); 3) crush damage cadence `!(leveltime&3)` slot-log golden with a stuck stub thing + MF_DROPPED-removal + non-shootable pass; 4) pastdest/crushed/ok results vs hand-derived tic tables.
- Verify: `npx vitest run src/sim/pplane.test.ts`

### M6-05 — Vertical doors (p_doors.c) — 37 ids
- Goal: `T_VerticalDoor` + `EV_DoDoor` + manual `EV_VerticalDoor`: normal/close/open/close30ThenOpen/raiseIn5Mins + blazing ×4, waits 150/1050, speeds 2/8.
- Owns: `src/sim/pdoors.ts(.test)` replacing its stub. Deps: M6-03, M6-04.
- Acceptance: 1) fixture timing goldens per type (open 168-unit door = 84 up-tics + 150 wait + 84 down); 2) manual toggle incl. "monsters never close" branch + open-type special-clear inside EV_VerticalDoor; 3) close30ThenOpen 1050-tic re-wait; sector specials 10 (close-in-30) and 14 (raise-in-5-min, 10500) hashed at boundaries; 4) specialdata refuse-while-moving; `topheight = lowestCeilSurrounding − 4·F`.
- Verify: `npx vitest run src/sim/pdoors.test.ts`

### M6-06 — Plats/lifts (p_plats.c) — 21 ids
- Owns: `src/sim/pplats.ts(.test)`. Deps: M6-03/04.
- Goal: `T_PlatRaise` all five types + stasis: `EV_StopPlat`, `P_ActivateInStasis`, `perpetualRaise`'s `P_Random()&1` start phase, downWaitUpStay self-removal after one cycle, `raiseToNearestAndChange` floorpic copy **and `sec->special = 0`** (damage-off quirk), speeds 1/2/4/8, wait 105.
- Acceptance: type×speed tic-count goldens; stasis round-trip (54/89 stop, re-trigger revive, `thinker.function=null` = not ticked); random-phase golden with prndindex; use-vs-cross parity (21 S1 vs 62 SR textures armed/disarmed via M6-11 hook — count-only here).
- Verify: `npx vitest run src/sim/pplats.test.ts`

### M6-07 — Floors, stairs, donut (p_floor.c) — 38+4+1 ids
- Owns: `src/sim/pfloor.ts(.test)` incl. `EV_BuildStairs`/`EV_DoDonut`. Deps: M6-03/04.
- Goal: all 13 `floor_e` destinations + `T_MoveFloor` newspecial/texture application on arrival + build8/turbo16 chains + donut (two-mover ring, `donutRaise` donutRaise speed F/2).
- Acceptance: destination table per §2 of R05 fixture goldens (incl. `turboLower` +8 quirk, `raiseFloorCrush` crush flag → stuck thing damage-slot log, `raiseToTexture` min-bottomtexture pick order); stair chain follows same-floorpic neighbours in linedef order, dest += stairsize/hop (200-unit build8 = 8 sectors, hashed); donut hole+ring swap flats; lowerAndChange copies `newspecial` (damage floor appears under lifted slab — sector 5 damage-slot then fires).
- Verify: `npx vitest run src/sim/pfloor.test.ts`

### M6-08 — Ceilings incl. crushers (p_ceilng.c) — 13 ids
- Owns: `src/sim/pceilng.ts(.test)`. Deps: M6-03/04.
- Goal: crush-and-raise family cycle (down to floor+8, up, repeat), slow-crush CEILSPEED/8, silent variant (no sfxSlot calls — counter assert), `lowerToFloor`/`raiseToHighest` one-shots, 40's paired raiseToHighest+lowerToLowest, stasis via 57/74.
- Acceptance: cycle-timing goldens; crusher kill proven as **damage-slot cadence log on a stuck thing** (defer note: actual death/gibs = M7 damage + M8 state machine — plan-level note per §0.5); stasis/revive; `#if 0` ceiling-up pin.
- Verify: `npx vitest run src/sim/pceilng.test.ts`

### M6-09 — Lights (p_lights.c + sector specials) — 10 ids + spawn specials
- Owns: `src/sim/plights.ts(.test)`; edits `pspec.ts` spawn cases (1,2,3,4,8,12,13,14?,17 — 10/14 belong to pdoors spawners invoked through pspec).
- Goal: fireflicker/flash/strobe(sync+async)/glow thinkers with the exact `P_FindMinSurroundingLight` formulas, `EV_LightTurnOn(0→brightest surrounding|35|255)`, `EV_StartLightStrobing`, `EV_TurnTagLightsOff` (min of self+adjoining); sector 4 keeps special=4.
- Acceptance: 1) PRNG-stream goldens (prndindex in hash) 200 tics per thinker; 2) strobe in-sync count=1 vs `(P_Random()&7)+1`; 3) lightnever-above/never-below clamps; 4) sector 13 sync-strobe at load = deterministic count 1 (no PRNG).
- Verify: `npx vitest run src/sim/plights.test.ts`

### M6-10 — Teleporters (p_telept.c) — 4 ids
- Owns: `src/sim/ptelept.ts(.test)`; teleport-destination list (type-14 things {x,y,angle,sector} built at map load in THINGS order per sector — deviation: NOT thinker-scan mobjs; selection-equivalence proven by §3 acceptance 3).
- Goal: `EV_Teleport` incl. blocked-dest failure (no fog, no move), telefrag through the damage slot (10000 on thing-under), `reactiontime=18`, destination angle, side/missile gates, fog = counted `fogSlot` events (mobj fog sprites arrive M7 — deviation logged).
- Acceptance: route fixtures for 39/97/125/126 incl. monster-only gate (non-player thing crossing 39 teleports, player crossing 125 does NOT); telefrag golden (two players same spot); dest-in-tagged-sector + first-in-THINGS-order pick vs vanilla scan equivalence test.
- Verify: `npx vitest run src/sim/ptelept.test.ts`

### M6-12 — Sector specials at feet: damage floors, secrets, E1M8 finale + exits (p_spec.c/p_user.c/g_game.c)
- Owns: `src/sim/puser.ts` edit (`P_PlayerInSpecialSector` call site, grounded gate `z === floorZ`), `pspec.ts` sector-dispatch section, `src/sim/pexit.ts` (exitRequest).
- Goal: standing in 4/5/7/11/16 logs damage at the 32-tic cadence with the ironfeet/`P_Random()<5` rules; sector 9 counts secrets (both counters hashed); 11 clears godmode and exits at hp≤10; use/cross exits 11/51/52/124 set `exitRequest` with the special-11 sfx quirk and the special-124 use-side no-op.
- Deps: M6-03 (dispatch), M6-01 (slots). Owns-nothing-conflict: puser.ts is exclusive to this task in wave 3 (M6-11 lands in wave 4).
- Acceptance: cadence goldens incl. falling-over-slime-not-triggering (z≠floorZ) and the `default: I_Error(unknown)` → typed throw + counter; `totalsecret` from load + `secretcount` increment + `sector.special→0`; E1M8 finale scripted (health clamp — damage-slot-fed fixture); G_SecretExitLevel commercial-guard simplified to always-secret for Doom-1 mode (deviation note).
- Verify: `npx vitest run src/sim/psectorspecial.test.ts`

### M6-11 — Switches, use lines, locked doors, card inventory (p_switch.c) — 6 locked ids + all S1/SR wiring
- Owns: `src/sim/pswitch.ts(.test)` (P_UseSpecialLine/P_UseLines/PTR_UseTraverse, switchlist/P_ChangeSwitchTexture/P_StartButton/button tick, EV_DoLockedDoor), `player.ts` (`cards: Int32Array(6)`, `useDown`, `message` slot write), `debug.ts`/`types/debug.ts` (`giveCard(i)`, `state().player.cards`), `wad/switchlist.ts` (P_InitSwitchList port over TEXTURE1 names, Freedoom-1 episode filter).
- Deps: M6-05 (EV_VerticalDoor + door lock branches), M6-09 (138/139 EV_LightTurnOn), M6-03.
- Goal: pressing USE reaches the right case through a real PathTraverse at USEMASK, side-1 refusals and the one-special-per-press abort hold, and buttons animate SW1→SW2→(35 tics)→SW1 in sim state the renderer reads.
- Acceptance: 1) reach test: use line at 8·64 exact boundary pass/fail (fixed comparison); 2) two-use-lines-in-line ⇒ only nearest fires + `return false` abort (counter); 3) texture xor-1 round-trip + special-11 sound quirk via sfxSlot log + BUTTONTIME revert golden + same-line re-press timer pin + MAXBUTTONS=16 overflow counter; 4) locked: door 26–28 and button 99/133–137 refusal (message+oof, special NOT armed), success with card, skull-accepts pin; monster use gate {1,32,33,34} + ML_SECRET block; 5) side-texture mutation visible to renderer (one e2e frame diff — button texture flips).
- Verify: `npx vitest run src/sim/pswitch.test.ts`

### M6-13 — L2 fixture corpus + E1M1 key-route e2e + L5 evidence
- Owns: `tests/headless/specials.test.ts` (per-special scenario table consumed by the coverage test — every id ≥1 scenario, hashes over sector SoA + exit/damage/fog slot logs), `tests/fixtures/specialfix.ts` (family rooms incl. switch textures, keyed-door corridor, teleport pair rooms), `e2e/specials.spec.ts` (real-key USE on FIXMAP door; E1M1 skipIf route), `scripts/motion-strip.mjs` extension (door/plat/crusher strips), `docs/DECISIONS.md` (D013: mover-state carve-outs), `docs/TASKS.md`/`JOURNAL.md`.
- E1M1 route derivation (no prior route doc): the spec scans loaded E1M1 at runtime — exit line (special 52 or sector-11), its tag → locked door lines (26–28/117 class), card things by doomednum 5/6/13 — and commits the waypoint list + `giveCard` set once, then replays scripted tic streams (warp→walk→use) asserting locked-refusal BEFORE card and `exitRequest === normal` after (M5 input-injection channel; no mouse needed).
- Acceptance: 1) coverage test: 139/139 line + 15/15 sector specials scenario-executed, zero `unimplementedSpecial` hits; 2) every scenario double-run hash-equal; 3) E1M1 route green under skipIf, refusal path ALSO green (locked door does not open without card); 4) L5 strips (door 1, lift 21, crusher 6) reviewed vs R05 §14 constants; verdict filed.
- Verify: `npx vitest run tests/headless/specials.test.ts && npm run e2e -- e2e/specials.spec.ts`

## 4. Deviations, decisions, gaps found this pass
- **D013 (drafted; M6-13 files)**: (a) `T_MovePlane` carved from p_floor.c to `pplane.ts`; (b) `EV_DoDonut` implemented in pfloor.ts (1.10: p_spec.c); (c) teleport destinations as a per-sector thing list, not MT_TELEPORTMAN thinker mobjs (equivalence-tested); (d) fog/teleport particles = slot events, mobj visuals M7; (e) exits set an `exitRequest` flag instead of `gameaction` (M9 wires the real drain); (f) card acquisition via debug hook until M7 pickups; (g) `G_SecretExitLevel`'s Map31/Wolf3D guard is Doom2-only — Doom1 path kept.
- Crush **kill** deferred: PIT_ChangeSector logs the vanilla 10-dmg/4-tic cadence into the damage slot; death/gibs need M7 damage + M8 states — crusher L2 evidence is slot-log cadence, not corpses.
- Scroll special 48 mutates side `textureoffset` (live side SoA from M6-01); renderer already pans per-frame (M3/M4) — visual scroll is free, verified once in M6-11's frame diff.
- No conveyor/liquid/rotation specials in 1.10 — the ROADMAP "lifts" family = plats; the sector-16 "slime" is a damage special (M6-12), no floor-texture scroll.
- levelTimer/-timer, sliding doors (`#if 0`), `P_InitSlidingDoorFrames` not ported (recorded so nobody "completes" them).
- Skull-key doomednum↔color pairing conflict R05 §5 vs R06: impl-time check against info.c `mobjinfo[]` (38/39/40) recorded in DECISIONS; irrelevant to Freedoom Phase-1 routes (cards only).

## 5. Exit verification (run on integrated main)
1. `npm run check` — all M1–M6 suites; `specials-table.test.ts` proves the 139+15 census matches R05 §2/§3 verbatim (the "100%" claim's machine proof).
2. L2: family goldens + per-special scenario hashes, double-run determinism everywhere; damage/fog/message/exit slot logs assert side effects without M7/M9/M10 code.
3. L4: `e2e/specials.spec.ts` (real-key door open, button texture change frame-diff) + E1M1 skipIf key-route exit (both refusal and success paths); zero console errors.
4. L5: three animation strips + button frame-diff reviewed vs R05 constants; findings → TASKS.
5. Ledger: ROADMAP M6 → [x], D013 merged, M7 brief annotated (cards → real pickups ⇒ re-run E1M1 route with touch-pickup variant).

## 6. Risks
- **Thinker-order hash drift**: a mover created mid-tic vs next-tic changes arena order; mitigated by the §3.5.5 insertion-order tests + add-during-tick scenario in M6-01 and by hashing arena order.
- **P_Find* tie order** (donut rings, stair forks, lowerAndChange flat pick): ascending-linedef order is pinned (§0.4); a helper iterating `sec->lines` in any rebuilt/sorted order silently forks hashes on E1M1 only — E1M1 skipIf scenarios in M6-07 cover multi-candidate sectors.
- **Crush damage timing vs M7/M8**: slot-log cadence must match final `P_DamageMobj` semantics or crusher goldens re-bless twice — the slot signature (thing, amount, source=null, tic) is fixed here and reviewed before wave 3 merges.
- **M5 integration skew**: M6 assumes pmap/pmove/puser landed with the spechit-cross call site; rebase M6-03/04 onto M5-tail main before wiring (pcross.stub replacement is the only merge-conflict hotspot).
- **Locked-door UX without HUD** (M9): refusals are proven via message/sfx slot logs + `cards` state, not on-screen text — L5 reviewers get the checklist note so silence isn't filed as a bug.
- **E1M1 route flakiness** (walk length, corner turns via scripted tic streams): waypoints are committed once from geometry and validated by refusal-path assertions first; if a leg proves brittle, insert `warp()` between legs (documented per-leg) rather than weaken the locked-door proof.
- **Switchlist data availability**: Freedoom1 SW1/SW2 pairs come from TEXTURE1 names — if the built-in `alphSwitchList` misses a Freedoom pair, the fixture switch uses synth textures and the gap is filed (no fake pairings).
