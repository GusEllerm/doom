# Credits and licensing

SPDX-License-Identifier: GPL-2.0-or-later

## Engine

This project is free software under the GNU General Public License,
version 2 or later (see `LICENSE`). It is a from-scratch TypeScript port
of the 1993 DOOM engine: no id Software content is shipped with or
embedded in this repository (no id assets of any kind — sprite, map,
sound, music, or graphic bytes). Runtime content comes from WAD files
supplied by the user at run time and are never committed (`wads/` is
gitignored and asserted empty by `scripts/license-audit.mjs`).

### GPL source offer (GPLv2 §3)

This program comes with ABSOLUTELY NO WARRANTY; it is distributed in
the hope that it will be useful, under GPL-2.0-or-later terms. Per
GPLv2 §3, the complete corresponding machine-readable **source offer**
for anyone receiving builds of this program (including the compiled
`dist/` bundle served from any deployment of this project) is: the full
source tree of this repository at the matching version tag, available
from this repository's public origin, reproducible with
`npm ci && npm run build` (Node LTS + the pinned devDependencies).
This offer is valid for at least three years from the date of the
corresponding release and is stated here in lieu of a physical medium.

## Game content

No id Software content is distributed with this project. All gameplay
content is fetched at run time from user-supplied WAD files (default:
Freedoom, below). Lump names that appear as string constants in the
source are WAD-format protocol identifiers or by-name references
resolved against those user files — see the documented allowlist in
`scripts/license-audit.mjs` for the classification of every such name.

### Freedoom

The default content is [Freedoom](https://freedoom.github.io/),
(c) the Freedoom contributors, distributed under the
**BSD-3-Clause license** — see the pinned release below. The complete
attribution text is reproduced verbatim from the release's
`COPYING.txt`:

```
Copyright © 2001-2024
Contributors to the Freedoom project.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
  * Neither the name of the Freedoom project nor the names of its
    contributors may be used to endorse or promote products derived from
    this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED
TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A
PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

For a list of contributors to the Freedoom project, see the file
CREDITS.
```

The full contributor records ship inside the pinned release: the zip's
`CREDITS.txt` (per-contributor `N:/S:/E:/W:/D:` records) and
`CREDITS-MUSIC.txt` (per-track music authorship) — both inside the
zipball below and never mirrored here.

#### Pinned release (D005; machine-readable: `scripts/freedoom/release.json`)

| Pin | Value |
|---|---|
| Release tag | [v0.13.0](https://github.com/freedoom/freedoom/releases/tag/v0.13.0) |
| zip sha256 | `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59` |
| `freedoom1.wad` sha256 | `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` |
| `freedoom2.wad` sha256 | `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b` |

Fetch is via `npm run fetch-freedoom` (`scripts/freedoom/fetch.mjs`),
which verifies every sha256 above before writing into the gitignored
`wads/` directory; the WADs themselves are never committed.

## Derived source

Some constants and behaviors are transcribed from the id Software DOOM
GPL source release and/or Chocolate Doom; files closely adapting them
carry a provenance header (see PROMPT.md §2). Verbatim reference
copies live under `.refs/` (source-text for transcription audits only;
not shipped in builds).

## Tooling credits

Development-only toolchain (MIT/Apache-2.0 licensed; not shipped in the
game bundle — `dist/` contains only our compiled source):

- [TypeScript](https://www.typescriptlang.org/) — Apache-2.0
- [Vite](https://vite.dev/) (esbuild + Rollup) — MIT
- [Vitest](https://vitest.dev/) — MIT
- [Playwright](https://playwright.dev/) — Apache-2.0
- [ESLint](https://eslint.org/) + typescript-eslint — MIT
- [Node.js](https://nodejs.org/) — MIT (runtime for scripts/tests only)

Verification goldens under `tests/**/goldens/` are binary test
artifacts DERIVED at bless-time from Freedoom bytes fetched at run
time; they are regenerable (`npm run goldens:update`) and reviewed as
test evidence, not content redistribution (see
`scripts/license-audit.mjs` check 3).
