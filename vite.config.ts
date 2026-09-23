// SPDX-License-Identifier: GPL-2.0-or-later
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Serve `wads/` (the fetch-freedoom output; git-ignored, so not a publicDir
 * we could commit) under the `/wads/` URL path in BOTH the dev and the
 * preview server. Minimal alternative to copying the 28 MB IWAD into a
 * committed public dir; documented in the M1-08 report. Missing files get a
 * hard 404 (no SPA fallback), so the viewer's 404 → file-picker branch is
 * actually exercised when the WAD was never fetched.
 */
function serveWads(): Plugin {
  const dir = resolve(process.cwd(), 'wads');
  const types: Record<string, string> = { '.wad': 'application/octet-stream' };
  const middleware = (
    req: { url?: string },
    res: { statusCode: number; setHeader: (k: string, v: string) => void; end: (s?: string) => void },
    next: () => void,
  ) => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!url.startsWith('/wads/')) return next();
    const file = join(dir, url.slice('/wads/'.length));
    if (!file.startsWith(dir + '/') || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const type = types[extname(file)] ?? 'application/octet-stream';
    res.setHeader('content-type', type);
    createReadStream(file).pipe(res as unknown as NodeJS.WritableStream);
  };
  return {
    name: 'doom/serve-wads',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}

export default defineConfig({
  plugins: [serveWads()],
  build: {
    // M12-06 (plan §M12-06a): the PRODUCTION build ships the GAME ONLY
    // (index.html). The dev-only WAD viewer (M1-08) is not a build entry —
    // it stays reachable in `vite dev` only, where the dev server serves
    // any root .html on request (viewer.spec.ts runs against dev, so no
    // `build:viewer` companion script is needed — the simpler option the
    // plan allows). Consequence asserted in e2e/build.spec.ts: dist carries
    // no viewer.html and no viewer-*.js.
    rollupOptions: {
      input: {
        main: resolve(process.cwd(), 'index.html'),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
});
