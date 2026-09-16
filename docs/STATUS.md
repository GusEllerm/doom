# STATUS

## Current phase
Phase 3, M1 in progress. All 12 research notes committed; ARCHITECTURE.md + M1/M2 plans + roadmap accepted (D008).

## Merged
- T00 scaffold (main green: check/e2e/build/fetch-freedoom)
- R01–R12 research notes (docs/research/)
- M1-01 wad contract types (`src/wad/types.ts`, WadFile skeleton) — merged 89bdb7b

## In flight (branches in worktrees)
| Task | Agent | Note |
|---|---|---|
| A-INT1 eslint zones | 3f60201e | merge after rebase on main |
| A-FX1 core/fixed + oracle | 8b7724cf | self-contained; merge check |
| M1-02 WadFile impl | dad45982 | wave 1 |
| M1-03 PLAYPAL/COLORMAP | a5389860 | wave 1 |
| M1-04 patch decoder | def8e6eb | wave 1 |
| M1-05 fixture WAD builder | cb2f3703 | wave 1 |

## Next actions
1. As each lands: review diff, merge --no-ff, run full check on main, update ledger.
2. M1 wave 2 after M1-04/05 merge: M1-06 (flat+TEXTURE1), M1-07 (sprite loader).
3. Then wave 3: M1-08 debug viewer; wave 4: M1-09 IWAD goldens + e2e; milestone verifier + L5 screenshot review.
4. A-FX1 merge unblocks M2 wave 0 (M2-01 grid BSP splitter).

## Environment quirks
- git via /Library/Developer/CommandLineTools/usr/bin/git until Xcode license accepted by user (D007).
- Infra failure waves have killed agents repeatedly: keep dispatches scoped, write-early, commit-often.
