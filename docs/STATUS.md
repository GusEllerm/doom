# STATUS

## Current phase
Phase 3, M10 COMPLETE (sound & music). Merged: T00, R01–R12, M1–M10 all tasks
(plans + ledgers in docs/design, docs/TASKS.md).

## M10 exit state (M10-12)
- Gates (fresh at exit): `npm run check` 163 files / 3086 tests green (3
  long-standing gated skips), `npm run e2e` **53 green**
  (4 project-scoped skips: 3 unmuted specs under `chromium`, 1 muted spec
  under `audio`, by design) — run twice consecutive at M10-11 per convention,
  goldens `--check` drift-free on ALL sets: automap 5 / walls 31 / weapons 15
  / screens 5 / m9 27 / **audio 13** (+motion/mechanics in-suite).
  (/tmp source mirror has decayed to 1 file since M10 planning — mirror
  re-check per the standing rule at next source-touching dispatch.) ZERO golden re-blesses the whole milestone (audio adds,
  never mutates — plan §4-5 held).
- THE BROWSER HAS SOUND: mixerCore (8-channel allocator, priority steal,
  same-origin dedup, 1200/160/1040 attenuation, finesine sep + quadratic L/R
  — spatial.ts/mixerCore.ts), sfxDriver → WebAudio nodes, GM synth + SMF
  player + SMF-OGG-aware musicSelect. **41 silent-M9 sfx sites live IN
  PLACE** (`sfxStub(` grep outside hooks.ts == 0; D019 CLOSED), and music is
  **per-level** — `musicSlot('level', true)` at the P_SetupLevel tail
  (game.ts:389, the ONE new sim-side call address) + title/intermission/
  finale routed per s_sound.c §0.6.
- Zero-stream regression PROVEN (D-10a CLOSED): mRandom call-tree == the M9
  blessed manifest (no new keys; audio zone included), hook-log parity vs
  muted boot — tests/audio/regression.test.ts.
- Music source truth: the pinned WAD carries 41 BSD Freedoom **SMF** lumps
  (MThd everywhere — the correction chain + orchestrator wrong-correction
  lesson are banked in the DECISIONS.md corrections register). MUS stays
  `musDecoder=false`; companion-OGG hook landed unused (zero pinned entries).
- Volumes (L4): thermo ⇒ internal `*8` (D-10d) ⇒ bus gains, e2e-proven by
  the law; 0 ⇒ silent graph. Session-only — persistence rides M11 saves.
- D-10a..f all CLOSED-IMPLEMENTED (DECISIONS.md). Playtest checklist
  (docs/reports/M10-playtest.md) issued; the HUMAN ear session is the one
  exit item still open (D016-style sign-off pending).

## Next actions
1. Human M10 playtest session (checklist sign-off; MUSIC_TRIM +
   audible-distance are the two tunables it exists for).
2. M11 planning (persistence A-10, bindings/cheats, volume persistence,
   pause-latch wiring) — carry-overs in ROADMAP 'M11 preview'.

## Environment quirks
- git via /Library/Developer/CommandLineTools/usr/bin/git until Xcode license accepted by user (D007).
