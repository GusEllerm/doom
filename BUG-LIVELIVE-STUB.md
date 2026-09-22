# B-07/B-08 stub: monsters frozen/non-attacking + shots never harm in live play

Branch task/BUG-livelive. Plan:
1. Repro in real browser (real rAF, real keys/mouse, NO runTics): compare monster
   VISUAL position vs sim state() positions; fire and watch hp seam.
2. Prime suspect: render sprite pass holds stale mobj array reference (identity class,
   post-M9-09 flip) — monsters think at TRUE positions, renderer draws spawn positions.
3. Fix minimal (roster reference refresh at level setup / New Game).
4. Permanent regression: e2e/live-combat.spec.ts (real rAF seconds, no runTics).
