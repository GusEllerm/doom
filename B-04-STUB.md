# B-04 — live E1M1 elevators: "glitches the screen; lifts don't stay down"

Branch task/BUG-lifts-t2. FIXED. Gates: `npm run check` exit 0 (143 files /
2821 tests), goldens `--check` + motion + mechanics strips: no drift,
full e2e 38 passed (3× gauntlet).

## SPECIALS AUDIT (freedoom1.wad 0.13 E1M1, loader-scanned, pinned in tests)
Lift lines EXACTLY: special 88 (GR DWUS) lines 593/595/596/618/1078 +
special 62 (SR DWUS) lines 594/620/1064/1075 → tag 1 = sector 98 (big hall
lift, floor 12 → lowest-surrounding −124, ceil 128) and tag 2 = sector 103
(136 → 8). No W1/S1-only plats, no plat sector-types (1.10 has no
P_SpawnPlat). 1.10 has NO "downAndWait/stayDown" plat — that's later-source
naming; DWUS "stay" = the sector KEEPS its final height after the thinker
self-removes (p_plats.c:68-77 `case downWaitUpStay: P_RemoveActivePlat`).

## ROOT CAUSES
(a) NOT pplats — T_PlatRaise/EV_DoPlat traced EXACT (down PLATSPEED*4,
    wait 35*PLATWAIT=105 p_spec.h:304, specialdata-skip re-fire
    p_plats.c:167-175, GR never clears / SR useAgain=1). The stateful
    failure was DISPLAY-SIDE: main.ts keyed the per-map render rebuild on
    `state.map.name`, but gSetupLevel (game.ts:320) REPLACES state.map AND
    state.sectors with the name equal (New Game / reborn E1M1→E1M1) — the
    world kept reading the boot-time sector SoA: sim lift moved, screen
    never did ("not stateful").
(b) Mid-ride glitch = same stale binding: the live viewz (player z) rides
    below/above the frozen floor planes → camera-under-floor inverted
    plane bands (measured 2k–46k px garbage, rows 0..199). NOT visplane
    HOM, NOT dup planes, NOT light — all five render counters 0 on the
    glitching frames; harness mid-transit renders are byte-exact vs
    per-frame static references (renderer innocent).

## FIXES
1. main.ts: rebuild keyed on state.map IDENTITY (Boot.simMap; mirrors
   stepTic's lastLevelMap detector).
2. main.ts: per-IWAD texture/flat decode hoisted to boot (reload hitch
   66→0 ms; removed the m9-flow stage-8 live-timing flake my fix exposed).

## EVIDENCE
tests/headless/lifts.test.ts (8): roster pin; per-route phase tables
(593/594 → 98, 618/620 → 103) incl. exact-105 wait + turnaround-tic-parks;
500-tic persistence + retrigger-hammer (plat never replaced, wait never
extended, 88/62 lines stay armed); identity-reload guard; 8 mid-transit
frames byte==static-ref, hom/overflows 0, STALE-clone negative control.
e2e/lifts.spec.ts: live ride + stable-frame sync probe — verified RED on
the pre-fix name key ("canvas frozen"), GREEN on identity.

## FOLLOW-UPS
- docs/BUGS.md B-04 status (docs forbidden here): set FIXED, and retest
  B-05-adjacent sector-light specials (12/7/9 sectors) — the same stale
  binding froze them until the first map change; now fixed as a side effect.
- pInitSwitchList never called live (switch-texture swap/button sfx
  cosmetic half pending — sim reuse semantics verified).
- Wipe advances per-draw (vanilla per-I_Time) — noted in spec comments.
