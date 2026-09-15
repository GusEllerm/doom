# STATUS

> UNPAUSED and RE-DISPATCHED 2026-09-14. All agents from the first dispatch were cleaned up by the harness during the pause; only R03's note survived (committed). All 12 remaining work units re-dispatched fresh.

## Current phase
Phase 1 (research) + Phase 2 scaffold, in progress.

## Milestone
M0 (research + architecture + scaffold). M1 starts after architect pass.

## In-flight tasks (agent IDs for get_subagent_result)
| Task | Output | Agent | Status |
|---|---|---|---|
| R01 WAD container | docs/research/01-wad-container.md | bf9d13fd-4ac4-468 | running |
| R02 graphics data | docs/research/02-graphics-data.md | 7fd0fc27-d38c-474 | running |
| R03 BSP renderer | docs/research/03-bsp-renderer.md | — | DONE, committed 9187736 |
| R04 simulation core | docs/research/04-simulation-core.md | aeafe550-4b94-4c0 | running/queued |
| R05 specials | docs/research/05-specials.md | 95fb9480-4260-401 | queued |
| R06 map objects | docs/research/06-map-objects.md | f35ed03a-136b-42b | queued |
| R07 monster AI | docs/research/07-monster-ai.md | 10a87a80-3ee9-439 | queued |
| R08 weapons/player | docs/research/08-weapons-player.md | 12c44d88-ce4c-4ab | queued |
| R09 UI | docs/research/09-ui.md | 79e5040d-5ca1-4b1 | queued |
| R10 audio | docs/research/10-audio.md | d2ac3cd0-5f69-44f | queued |
| R11 persistence | docs/research/11-persistence.md | 0ecad421-5fe9-4dc | queued |
| R12 Freedoom | docs/research/12-freedoom.md | 7dd7d4c5-6ee3-44b | queued |
| T00 scaffold | branch task/00-scaffold (worktree) | 4976fe0c-acf1-410 | queued |

Harness concurrency cap: 3. When an agent completes: review its note, commit docs/research/<file>, mark TASKS.md, dispatch the next planned work.

## Blockers
- None. No `origin` remote → local commits only.

## Next actions
1. On each research/T00 completion: verify (file exists, checks pass), commit, update TASKS.md.
2. When all research notes in: dispatch architect → docs/design/ARCHITECTURE.md + M1 task breakdown.
3. Integrate T00 branch onto main after review + full checks; then plan M1 leaves (WAD reader core first).

## Verified leads carried over from first dispatch (survivor reports)
- id source path: raw.githubusercontent.com/id-Software/DOOM/master/linuxdoom-1.10/ (no d_loop.c in 1.10).
- MF_* flags verified (see R06 brief). mobjinfo has doomednum in Doom1; state_t uses misc1/misc2; NUMMOBJTYPES=118.
- Freedoom release hint: v0.13.0 (T00/R12 pinning + verifying).
- PLAYPAL=14x768, COLORMAP=34x256.
