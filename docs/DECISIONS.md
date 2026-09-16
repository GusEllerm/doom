# DECISIONS

Numbered decision records: context, options, choice, why.

## D001 — License: GPL-2.0-or-later
Context: PROMPT.md §2 pre-decides this so that porting/adapting id's GPL DOOM source and Chocolate Doom references is permitted.
Choice: LICENSE = GPL-2.0-or-later from the first commit. Any file adapting GPL source gets a provenance header.

## D002 — Environment facts (Phase 0)
- node v22.22.1, npm 10.9.4, git 2.50.1 on macOS.
- Network access: YES (github reachable over HTTPS). Researchers may use web sources.
- Playwright 1.63.0 with chromium + headless-shell + ffmpeg preinstalled — e2e layer is viable.
- No git remote named `origin` → all milestones are local commits; do NOT create a remote (hard rule 3).
- Free disk space and home directory writable — worktrees can live under `.worktrees/` (git-ignored).

## D003 — Previous attempt is not reused
Context: git history before `5ff94ec` holds a raycaster→three.js game. PROMPT.md forbids building on it (three.js violates the software-renderer rule).
Choice: treat it purely as lesson material. Known past failures to defend against: invisible walls (winding) and dead menu clicks slipping past unit tests → mandate real-browser e2e + screenshot review (PROMPT §9 layers 4–5).

## D004 — Worktree location
Implementer worktrees live in `.worktrees/<task-id>` (git-ignored). Keeps repo root clean; branches follow `task/<id>-<slug>`.

## D005 — Freedoom pinned release (orchestrator-verified 2026-09-14)
Context: releases ship no per-WAD assets; guessing .../download/<tag>/freedoom1.wad 404s (explains R01's sandbox 404s).
Pinned facts (queried from api.github.com now): repo freedoom/freedoom, tag v0.13.0.
- zip: https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip (24,143,781 B)
- zip sha256 (from signed CHECKSUM file): 3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
Choice: fetch-freedoom downloads the zip, verifies its sha256, extracts freedoom1.wad (+ freedoom2.wad for stretch) into wads/, records the extracted WAD's sha256 in release.json. PGP sig verification is a future option, noted.

## D006 — T00 fallback: orchestrator builds scaffold directly
Context: two T00 dispatches lost purely to harness infra failures (never started). Rule prefers delegation, but §10 says move on when blocked.
Choice: third dispatch attempt now. If it fails again, orchestrator implements the scaffold itself on branch task/00-scaffold and notes it in JOURNAL.

## D007 — git binary workaround for Xcode license gate
Context: after a macOS update (Tahoe 26.6.2), /usr/bin/git aborts with "You have not agreed to the Xcode license agreements" because xcode-select points to Xcode.app whose license is unaccepted. brew is gated too.
Choice: invoke git as /Library/Developer/CommandLineTools/usr/bin/git (works, v2.50.1) until the user runs `sudo xcodebuild -license accept` (recommended) or `sudo xcode-select --switch /Library/Developer/CommandLineTools`.

## D008 — Architecture ADRs A-01..A-10 ACCEPTED
Chosen: int32-as-number + limb-split FixedMul (BigInt oracle-tested, A-01); minimal DEHACKED fullbright parser in M8 (A-02); subtractive-lite GM synth, SMF-first, MUS behind flag (A-03); grid-splitter fixture maps, no general node builder (A-04); 8-voice SFX pool (A-05); eslint import-boundary enforcement (A-06); platform-side SFX randomness, sim-side M-stream for face only (A-07); plain accumulator (A-08); WASD+vanilla-compat defaults (A-09); IDB only via platform, raw-buffer sim tests (A-10). Details: docs/design/ARCHITECTURE.md §9.

## D009 — M2 noclip is direct ticcmd integration (deviation, M5 revisits)
- Context: M2-07 found GPL 1.10 has no "straight noclip" motion path — P_MovePlayer always thrusts/momentum; MF_NOCLIP only bypasses p_map line checks. Plan §M2-07 needs collisionless flight before physics exists.
- Decision: M2 implements per-tic direct FixedMul integration of ticcmd moves (P_Thrust scale constants, friction/momentum untouched, MF_NOCLIP|MF_NOGRAVITY); flagged as deviation; M5 replaces with real P_Thrust/friction physics, keeping noclip = same motion + skipped collisions (vanilla semantics).
- Also recorded: 1.10 has NO ev_turn — keyboard turn is per-tic gamekeydown[] polling in G_BuildTiccmd (input layer implements polling, not turn events).
