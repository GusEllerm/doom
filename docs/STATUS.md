# STATUS

> Resume point. Overwrite this file after every dispatch or integration.
> After a context reset: read this, then ROADMAP.md, then the last ~50 lines of JOURNAL.md, then run `git status`, `git worktree list`, `git branch`.

## Current phase
Phase 0 complete → Phase 1 (research) + Phase 2 scaffold starting.

## Milestone
None yet. M1 (WAD/data decoding) begins after research + architecture.

## In-flight tasks
| Task | Branch | Agent | Status |
|---|---|---|---|
| T00 scaffold (Vite/TS/check/e2e/fetch-freedoom/debug stub) | task/00-scaffold (worktree) | 737eb1f6 | dispatched |
| R01 WAD container | docs/research/01-wad-container.md | 0e276728 | dispatched |
| R02 graphics data | docs/research/02-graphics-data.md | 5f502d6e | dispatched |
| R03 BSP renderer | docs/research/03-bsp-renderer.md | 83c8c15f | dispatched |
| R04 simulation core | docs/research/04-simulation-core.md | 12f78be1 | dispatched |
| R05 specials | docs/research/05-specials.md | 74f31a98 | dispatched |
| R06 map objects | docs/research/06-map-objects.md | e598b097 | dispatched |
| R07 monster AI | docs/research/07-monster-ai.md | 4d3dfbfd | dispatched |
| R08 weapons/player | docs/research/08-weapons-player.md | 280374b6 | dispatched |
| R09 UI | docs/research/09-ui.md | bd60b8f1 | dispatched |
| R10 audio | docs/research/10-audio.md | c1415bd2 | dispatched |
| R11 persistence | docs/research/11-persistence.md | 0fc6e230 | dispatched |
| R12 Freedoom | docs/research/12-freedoom.md | 206c8e0c | dispatched |

## Blockers
- None. Network access confirmed; Playwright chromium already installed locally.
- No `origin` remote → local commits only, no pushes (per hard rule 3).

## Next actions
1. Integrate scaffold + research notes onto main.
2. Dispatch architect(s): ARCHITECTURE.md + roadmap refinement.
3. Plan M1 (WAD/data decoding) into leaf tasks; start dispatching.

## Environment facts
- node v22.22.1, npm 10.9.4, git 2.50.1 (macOS)
- Network: YES (github reachable)
- Playwright 1.63 + chromium browsers preinstalled
- Previous attempt: raycaster→three.js; do NOT reuse code. Lessons: invisible-winding bugs and dead menu clicks slipped past unit tests → verify in real browser with screenshot review.
