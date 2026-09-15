# STATUS

> UNPAUSED and RE-DISPATCHED 2026-09-14. All agents from the first dispatch were cleaned up by the harness during the pause; only R03's note survived (committed). All 12 remaining work units re-dispatched fresh.

## Current phase
Phase 1 (research) in progress — 5/12 notes committed. Wave 2 re-dispatched after a fleet-wide connection error (2026-09-15).

## Milestone
M0 (research + architecture + scaffold).

## Research done (committed)
R01 wad-container, R02 graphics-data, R03 bsp-renderer, R04 simulation-core, R05 specials — all in docs/research/, verified vs linuxdoom-1.10.

## In-flight (wave 2; IDs refreshed on dispatch)
| Task | Output | Status |
|---|---|---|
| R06 map objects | docs/research/06-map-objects.md | dispatching |
| R07 monster AI | docs/research/07-monster-ai.md | dispatching |
| R08 weapons/player | docs/research/08-weapons-player.md | dispatching |
| R09 UI | docs/research/09-ui.md | dispatching |
| R10 audio | docs/research/10-audio.md | dispatching |
| R11 persistence | docs/research/11-persistence.md | dispatching |
| R12 Freedoom | docs/research/12-freedoom.md | dispatching |
| T00 scaffold | branch task/00-scaffold | dispatching |

## Local caches (use these; network flaky)
- /tmp/DOOM-master — full id GPL source mirror (linuxdoom-1.10/)
- /tmp/doomsrc — 89 loose linuxdoom files
- /tmp/freedoom-0.13.0/ — freedoom1.wad, freedoom2.wad, CREDITS.txt, COPYING.txt (NEVER copy WADs into repo)
- /tmp/chocolate-doom-master

## Blockers
- Flaky connections killed wave 1 (connection errors). Mitigation: offline-first briefs + outline-file-first discipline.
- No `origin` remote → local commits only.

## Next actions
1. Integrate wave-2 outputs as they land (verify → commit → ledger).
2. When 12/12: architect dispatch (ARCHITECTURE.md + M1 breakdown).
3. T00: review branch, run checks, merge to main.
