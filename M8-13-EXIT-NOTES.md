# M8-13 exit notes (task/M8-13-exit)

## Strips (tests/render/goldens/mechanics, `--set mechanics`)
- m8-chase-corner — TROO approaches a solid pillar, sweeps around the SE
  corner (P_NewChaseDir axis scan; D-stat = burned PRNG), fires from the
  corner. Plates = synthetic state-letter sprites (D018); captions carry
  x,y/hp/target + per-frame draw deltas.
- m8-pain-death — POSS hp20: tic40 damage 8 (prndindex pinned < painChance
  200) → pain states 187/188; the pain chain's nextstate = the RUN chase
  chain wakes it (emergent P_LookForPlayers wake — PUFF on the west wall
  at tic 69); tic70 damage 45 → hp -33 < -spawnhealth → XDEATH 194+.
- m8-infight — TROO fireballs catch the SPOS standing in the firing lane
  (p_inter.c:911: target:=source, threshold:=100), the SPOS shotguns back
  through the lane damaging the TROO. FINDING: same-species missiles
  'explode, no damage' (pmissiles.ts:205-215 ← p_map.c:301-315) — the
  plan's "two imps" rig can never infight; species pair is the honest fix.
- Generator: `node scripts/motion-strip.mjs --set mechanics --check`
  regenerates all 7 strips identical; m6 shas byte-identical to before.

## Pacing (tests/headless/m8-pacing.test.ts) — see file header for cites
| assertion | bound | derivation cite |
|---|---|---|
| survival floor (2 POSS @512) | death ≥ 137 (meas. 1577) | ≤15 dmg/hit p_enemy.c:817; 8-call reaction +30-tic cycle (states 184/185/186 + see-row t=4) |
| melee ceiling (6 SARG) | death ≤ 146 (meas. 73) | ≥4 dmg/hit p_enemy.c:946; 24-tic melee chain 485-487, no reaction gate (:724-731) |
| skill monotonicity | melee rig 0>1=2=3=4; missile rig 1=2=3, baby>2 | pplayer.ts:555 sk_baby >>1; no skill-sensitive path for 1–3; p_mobj.ts:325 nightmare reactiontime |
| reaction floor | missile ≥ wake+28, hit ≥ wake+38 | p_enemy.c:677 reactionTime-per-call, :734 movecount gate, states t=4 period |

## Naming verdict
MT_TROOPSHOT canonical (code enum row 31 = doomednum −1/S_TBALL1/damage 3);
MT_FIRE = explosion flame FX (row 4, damage 0); doomednum 58 = MT_SHADOWS.
Only the monsters.test.ts shorthand label + the retracted M8-07 journal
line said otherwise; fixed in 7d35d82 + JOURNAL entry. Zero code changes.

## Exit gates
check 2476 ✅ · e2e 27 ✅ · goldens/motion/mechanics --check ✅ ·
marathon/census/ledger/e2e-monsters (M8-11/12 suites) ✅.

## Follow-ups (report-only)
1. Live-mobj renderer pass (KIND_MONSTER draw exclusion) — M9 render task.
2. DamageBridge player routing (D-m1) production wiring — M9 game loop.
3. G_ExitLevel/A_BossDeath level-exit flow — M9 (plan §3 open decision).
