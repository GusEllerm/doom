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
| T00 scaffold (Vite/TS/check/e2e/fetch-freedoom/debug stub) | task/00-scaffold | implementer | dispatched |
| R01..R12 research notes | (docs only) | researchers | dispatched |

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
