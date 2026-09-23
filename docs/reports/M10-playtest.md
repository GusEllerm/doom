# M10 playtest checklist — human session (plan §M10-11, D016-style)

Task: M10-11. Machine-checked halves live in `e2e/m10-audio.spec.ts`
(profiles: muted regression under the `chromium` project, unmuted under the
`audio` project — `npm run e2e` covers both). THIS document is the human
half: the things only ears can sign off. Machine column says whether e2e
already proves the CLAIM or whether it is ear-only.

## How to run

1. `npm run dev` (fetch the pinned wad first if `wads/freedoom1.wad` is
   absent: `npm run fetch-freedoom`).
2. Open the printed URL **in a real browser with sound on**. Headless e2e
   proves the graph runs; only this session proves it SOUNDS right.
3. Work the checklist top to bottom; tick boxes, jot findings in the
   Findings table, then sign at the bottom. Do not fix code mid-session —
   findings first, tuning decisions after (the two tunables this checklist
   exists for are the §0.7 trim constant and audible-distance feel).

## 1. SFX — audible, positioned, attenuated

- [ ] **Pistol shot** audible at own position (fire; each shot = one voiced
      source). Machine: YES (e2e — shot ⇒ `activeVoices > 0`).
- [ ] **Door opens/closes** audible when near, duller from the next room.
      Machine: no — ear-only.
- [ ] **Monster sounds**: a possessed soldier's shot/derp/hurt audible; a
      baron's roar LOWER (the `volume` column, §0.2), not just quieter-pitch.
- [ ] **Player pain sound** audible when hurt; face-view grunt overlaps OK.
- [ ] **Item pickup / weapon get** sounds audible and distinct per type.
- [ ] **Positioning**: face a wall, have a shot happen behind you
      (or run one down an adjacent corridor) ⇒ the sound steers LEFT/RIGHT
      as you turn ~90° (the quadratic sep split, i_sound.c:350-373).
      Machine: pan LAW golden (mixer); the sweep itself is ear-only.
- [ ] **Distance attenuation**: the same shot point-blank vs ~15 mapsq
      ("heard distance" 160) vs across the map (~1040) fades smoothly to
      silence; nothing pops at a boundary. Machine: attenuation table
      golden (1200/160/1040 + map8); the sweep feel is ear-only.

## 2. Priority masking under fire

- [ ] Stand in a stocked baron fight: sounds LAYER (8 channels, D-10c) —
      later low-priority sounds (itemups, footsteps) drop out FIRST,
      shotgun/baron keep through. No clipping wall-of-noise, no truncation
      of the newest loud shot. Machine: allocator goldens (steal/dedup);
      the fight feel is ear-only.
- [ ] **Tic-clock tightness**: rapid fire has no audible stutter/late-batch
      (the D-10f tic-boundary ring + 100 ms lookahead). Spot-check with
      chainsaw vs pistol held fire. Machine: `lastSchedDelta < 1 block`
      logged in the driver census — check it in devtools if stuttering.

## 3. Music lifecycle

- [ ] **Title**: tune starts on first click/keypress (autoplay gate),
      plays ONCE (one-shot `D_INTRO`, d_main.c:477), and RE-ARMS per
      attract-page cycle (§0.6). Machine: YES (e2e title + lifecycle tail).
- [ ] **Per level**: E1M1 plays `D_E1M1` looping; new game after a game
      ⇒ exactly ONE stop + ONE start (no double music, no tempo doubling).
      Machine: YES (e2e lifecycle: same-song guard unit + tail transitions).
- [ ] **Intermission**: exiting E1M1 swaps to `D_INTER` at the tally and it
      LOOPS until the next level lands (`D_E1M2`). Machine: YES (tail).
- [ ] **Finale**: reaching the endgame (E1M8 exit ⇒ `ga_victory`) plays
      `D_VICTOR` under the text. Machine: YES (tail via the scripted
      ga_victory drain; the REAL E1M8 boss-death route is M10-12 exit /
      this session: [ ] kill the Cyberdemon on E1M8 and hear the swap).
- [ ] **Level reload (D017 death-restart)**: same map restarts its song
      cleanly, once. Machine: unit (M10-08 acceptance 3); ear: [ ] die and
      press use-tap restart on E1M1.

## 4. Volume thermos (L4)

- [ ] **Sound menu (F4)** ←/→ on the sfx thermo: immediate loudness change
      mid-game (no re-entry), 0 ⇒ total sfx silence with music still
      playing, 15 ≈ full scale. Machine: YES (e2e: law + `0 ⇒ 0 node
      starts on a live shot` + restore).
- [ ] **Music thermo** same live behavior; at equal thermo settings music
      should sit BELOW sfx (the trim, §5). Machine: gain law YES (volumes
      unit); balance is ear-only.
- [ ] Volumes are **session-only by design** — a reload restores 8/8.
      Persistence is M11 (A-10/`default.cfg`): [ ] confirm reload resets
      (this is expected, not a bug — FINDING template: "M11, not regression").

## 5. Pause halts music — VERIFIED ABSENT → M11 item (NOT a silent pass)

Plan bullet "pause halts music" could not be executed: **the sim has no
in-game pause to halt anything.** Code truth, verified at this task
(implementer, before writing this doc):

* nothing in `src/**` ever writes `state.paused = true` (only the
  false-resetting sites `g_game.c` mirrors: `game.ts:605/:624/:653`);
  the M9 menu carries no pause row;
* vanilla 1.10 itself never calls `S_PauseSound`/`S_ResumeSound` (dead
  code in the reference source — same as our port so far);
* the music HALF exists and is unit-green: `musicSelect.sPauseMusic/
  sResumeMusic` (the `mus_paused` latch, s_sound.c:497-513) +
  `context.suspendForPause/resumeFromPause` (music bus only — already
  scheduled sfx keep playing, per the g_game.c:705-712 split).

So: [ ] NOT testable in this session — `__doom.pause()` is the harness
loop-gate and music correctly KEEPS PLAYING under it. **M11 follow-up:**
wire the latch to a real pause feature (menu row / the M9 menu-pause the
plan assumes) the day the sim grows `paused = true`.

## 6. Trim constant (§0.7) — the playtest notes this checklist exists for

`volumes.ts` ships `MUSIC_TRIM = 0.5` (music bus gain =
`thermo*8/127 * MUSIC_TRIM`). During the session, in a baron fight with
both thermos at 8, note which dominates and record the sweep:

| setting (thermo 8/8) | music vs sfx impression | keep/raise/lower |
|---|---|---|
| MUSIC_TRIM 0.5 (ship default) | ______________________ | ______ |
| MUSIC_TRIM 0.4 | ______________________ | ______ |
| MUSIC_TRIM 0.6 | ______________________ | ______ |

Also record: audible-distance feel ("sounds die too early/late") — the
`160`/`1040`/`1200` constants are the OTHER tunable; changes go with a
mixer-golden re-bless and are a FINDING, not routine.

## 7. Attribution note (plan §0.10(d))

No in-game credits screen is M10 scope. The shipping credits (Freedoom
BSD music/SFX data, CREDITS-MUSIC Phase-1 lines) are a **P5-RELEASE**
item — record it there, not here (D016-adjacent note only).

## Findings

| # | item | observed | severity / disposition |
|---|------|----------|------------------------|
|   |      |          |                        |

Signature / date: ______________________
