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
