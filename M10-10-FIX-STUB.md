# M10-10 FIX STUB (fixer session)

Fixing three logged issues:
1. M10-10-A: production music install (main.ts install site; flip e2e/m10-10-audio.spec.ts expected-fail to PASS).
2. M10-10-3: exported headless sfx-bridge installer in src/audio/wiring.ts (installHeadlessSfxBridges), used by m10Scenarios + debug.ts identically to main.ts.
3. walls.spec.ts:176 Tab-overlay flake: replace fixed sleeps with a state predicate wait.

Stub-first commit; docs untouched.
