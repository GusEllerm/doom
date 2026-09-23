# M12-06 STUB — Production build e2e + release-surface hygiene (CLAIMED)

Owner: implementer sub-agent (Wave 1). Owns: vite.config.ts, e2e/build.spec.ts, playwright.config.ts.

Plan: docs/design/M12-plan.md §M12-06.
- (a) game build ships index.html only; viewer.html -> dev-only entry (simpler option, documented in vite.config comment)
- (b) new playwright project 'build': vite build + vite preview -> boot -> E1M1 playable over preview; __doom absent WITHOUT ?test=1, present WITH; zero console.error; bundle-size budget pinned-after-measure (<=500 KB gzip proposal, D-12a); dist contents asserted (no viewer-*.js, no sourcemaps).
