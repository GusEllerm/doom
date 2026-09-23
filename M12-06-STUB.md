# M12-06 STUB — Production build e2e + release-surface hygiene (CLAIMED)

Owner: implementer sub-agent (Wave 1). Owns: vite.config.ts, e2e/build.spec.ts, playwright.config.ts.

Plan: docs/design/M12-plan.md §M12-06.
- (a) game build ships index.html only; viewer.html -> dev-only entry (simpler option, documented in vite.config comment)
- (b) new playwright project 'build': vite build + vite preview -> boot -> E1M1 playable over preview; __doom absent WITHOUT ?test=1, present WITH; zero console.error; bundle-size budget pinned-after-measure (<=500 KB gzip proposal, D-12a); dist contents asserted (no viewer-*.js, no sourcemaps).

## EXIT NOTES
- (a) viewer.html removed from build input (dev-only via dev-server html serving; simpler option chosen, documented in vite.config.ts comment).
- (b) 'build' project added: spec runs real vite build+preview in-process (Playwright 1.63 has no project-level webServer; root webServer addition would disturb chromium/audio). serveWads middleware VERIFIED under vite preview (configurePreviewServer works) — no static wad copy needed; boot over preview asserts /wads fetch 200 + playable E1M1.
- Sizes at pin (2025-09-23): single chunk main-*.js raw 542,951 B / gzip 182,203 B (vite reporter 184.42 kB). Cap pinned: total gzip JS ≤ 500,000 B (D-12a).
- Seam leakage: __doom ABSENT without ?test=1, present WITH — debug.ts unchanged (DEV||?test gate already correct; DEV folds false in build). No src/** edits.
