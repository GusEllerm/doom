# STATUS

> UNPAUSED and RE-DISPATCHED 2026-09-14. All agents from the first dispatch were cleaned up by the harness during the pause; only R03's note survived (committed). All 12 remaining work units re-dispatched fresh.

## Current phase
T00 scaffold MERGED (main green: check/e2e/build/fetch-freedoom).
Phase 1 (research) in progress — 5/12 notes committed. Wave 3 dispatched 2026-09-15 after infra 500-wave killed R09-R12+T00 (outlines survived; briefs say: fill existing outline, write-per-section).

## Milestone
M0 (research + architecture + scaffold).

## Research done (committed)
R01 wad-container, R02 graphics-data, R03 bsp-renderer, R04 simulation-core, R05 specials — all in docs/research/, verified vs linuxdoom-1.10.

## In-flight (wave 2; IDs refreshed on dispatch)
| Task | Output | Status |
|---|---|---|
| R06 map objects | docs/research/06-map-objects.md | agent cb9238ff |
| R07 monster AI | docs/research/07-monster-ai.md | agent 91b5256e |
| R08 weapons/player | docs/research/08-weapons-player.md | agent ef0455de |
| R09 UI | agent bc0cbf4d | agent e52fa8f5 |
| R10 audio | agent 694352f8 | agent 0f436ab9 |
| R11 persistence | agent 89da8ab8 | agent 69b48644 |
| R12 Freedoom | agent f7bdc557 | agent ba7ff0f7 |
| T00 scaffold | agent 288dff5b | agent 59c9c7e2 |

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
