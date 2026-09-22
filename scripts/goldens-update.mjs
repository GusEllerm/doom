#!/usr/bin/env node
/**
 * M2-10 golden updater/checker (M2-plan §M2-10).
 *
 *   node scripts/goldens-update.mjs --reason "why"   → REGEN: run the
 *       automap golden pipeline (vitest dump mode), write blessed PNGs +
 *       index shas into tests/render/goldens/automap/, recording the
 *       REQUIRED --reason into meta.json (entry.reason + history[]).
 *   node scripts/goldens-update.mjs --check          → DRIFT: run the
 *       pipeline and fail (exit 1) on ANY difference vs the committed
 *       goldens (index sha AND decoded PNG pixels), plus the vitest sha
 *       asserts themselves. Fresh PNGs land in test-results/goldens/automap
 *       for review; committed goldens are never rewritten in check mode.
 *
 * M3-08 additive `--set walls|automap` (default automap — M2 invocations
 * unchanged): `--set walls` swaps the pipeline to tests/render/walls.test.ts
 * and the goldens/review trees to tests/render/goldens/walls and
 * test-results/goldens/walls. PNG colorization: dumps may embed a
 * `paletteRgb` (768 ints — walls.test.ts ships PLAYPAL palette 0 for iwad
 * scenes, a gray ramp for fixtures); without one the automap color-family
 * mapping below applies. The tEXt sha + pixel-compare provenance machinery
 * is shared unchanged.
 *
 * PNGs are minimal indexed-color-converted RGB files (own writer below:
 * signature + IHDR + tEXt(doom-index-sha256) + IDAT (node:zlib deflate) +
 * IEND, filter byte 0 per row). The tEXt chunk pins the index-buffer sha, so
 * --check can prove a PNG's provenance even across zlib-build byte variance
 * (bytes may differ across machines; decoded pixels + the tEXt sha may not).
 *
 * Colors follow R09 §5 automap families (am_map.c color bases): 176..191
 * reds (one-sided/special walls), 231 yellows (ceiling change), 64..79
 * browns (floor change), 96..111 grays (grid/crosshair), 112..127 greens
 * (things — post-M2), 209 WHITE player arrow; anything else a gray ramp.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** M3-08: per-set wiring — `--set` picks the pipeline + goldens tree. */
const SETS = {
  automap: {
    testFile: join('tests', 'render', 'automap.test.ts'),
    pipeline:
      'FIXMAP/E1M1 -> gInitGame -> scripted Tab/tics/moves (amResponder+gTicker+amTicker, main.ts stepTic order) -> drawAutomap -> sha256(fb.indices)'
  },
  walls: {
    testFile: join('tests', 'render', 'walls.test.ts'),
    // M4-08 (plan §M4-08 deviation recorded): the set name stays `walls`
    // although the scenes are FULL frames since the M4 re-bless, and the
    // walls.test.ts scene table now boots THREE map sources — WALLFIX
    // (M3), the M4-06 fixture maps (buildM4SceneWad: MASKFIX/SKYFIX/
    // THINGSFIX/PANFIX, wad-free) and freedoom1 E1M1 (skipIf no wad).
    // Consumption is scene-table driven: the dumps ARE the set, so no
    // per-set fixture source flag is needed here (the automap set is
    // untouched).
    pipeline:
      'WALLFIX / M4FIX(mask,sky,things,pan) / E1M1 -> gInitGame -> warp (viewpoints.ts) -> renderFrame x2 full frame (planes+masked+statics; byte-equal) -> sha256(fb.indices), hom + visplane/vissprite/opening/drawseg overflow asserted 0'
  },
  weapons: {
    // M7-10 weapon visual pack (plan §M7-10 + D016 visual gate):
    // tests/weapons/visual.test.ts — M7 firing-range fixture maps (no
    // graphics) rendered with the freedoom sprite/patch tables, live-sim
    // psprite rows through the src/pspriteview.ts seam (gun raised +
    // muzzle flash), plus ONE labelled contact sheet that TILES the
    // scene frames themselves (M7-11 montage rework: 3 columns x 5 rows,
    // each 320x200 scene nearest-neighbour x2 with a 5x7-font label band;
    // the M7-10 version enumerated state-table sprite frames instead and
    // proved nothing about the rendered frame). WAD-GATED
    // (skipIf no wad, like the E1M1 wall scenes): without a wad the set
    // dumps nothing and committed goldens stay untouched.
    testFile: join('tests', 'weapons', 'visual.test.ts'),
    pipeline:
      'M7FIX weapon range -> gInitGame + give/weaponKey/attack script (live sim tics) -> renderFrame x2 (world + psprite pass via pspriteview seam; byte-equal) + montage (scene frames tiled 3x5 at 2x, 2x 5x7 labels) -> sha256(indices), hom + overflow counters asserted 0'
  },
  screens: {
    // M9-10 title/finale page pack (plan §M9-10 acceptance 4 + D016
    // montage): tests/render/screens.test.ts — the D_Display
    // GS_DEMOSCREEN/GS_FINALE drawer seams (dPageDrawer = TITLEPIC via
    // D_StartTitle + one tic block; fDrawer stage 0 = FLOOR4_8 flood +
    // E1TEXT reveal at F_Ticker x200; stage 1 = HELP2 after the exact
    // 1571-tic flip). WAD-GATED (all graphics lumps come from the pinned
    // freedoom1.wad; no wad ⇒ no dumps, committed goldens untouched).
    testFile: join('tests', 'render', 'screens.test.ts'),
    pipeline:
      'E1M1 gInitGame -> [dInit + gFlowTic | fStartFinale + F_Ticker xN] -> drawer seam (screens[FG], no framebuffer) double-draw byte-equal -> sha256(screens[FG].data) + montage (3 pages tiled 3x2 at 2x, 5x7 labels)'
  },
  m9: {
    // M9-11 L3 golden corpus (plan §M9-11): THREE test files, one set —
    // tests/render/m9hud.test.ts (statusbar 8-variant matrix + HU message
    // strip + sb9/sb11 viewport pair), m9menus.test.ts (TITLEPIC page +
    // MainDef/NewGame/OptionsMenu screens) and m9wi.test.ts (intermission
    // tallies 0/50/100 % + par/sucks time pages + ShowNextLoc blink pair +
    // finale 3 phases). Every frame is the FULL production composition:
    // the main.ts rAF driver (gFlowTic + gTicker + HU/ST tickers) then
    // displayFrame (D_Display draw order, d_main.c:193-330) onto ONE shared
    // framebuffer; 3D-bearing frames pin hom == 0. WAD-GATED like screens.
    testFile: [
      join('tests', 'render', 'm9hud.test.ts'),
      join('tests', 'render', 'm9menus.test.ts'),
      join('tests', 'render', 'm9wi.test.ts')
    ],
    pipeline:
      'E1M1 gInitGame -> scripted player/wminfo state + tics (main.ts tic order) -> displayFrame D_Display composition (3D + crop + borders + ST bar + HU + WI/menu/finale drawers) x2-run byte-equal -> sha256(fb.indices), hom asserted 0 on every 3D frame'
  }
};

/* ------------------------------------------------------------------ */
/* args                                                                */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
let check = false;
let reason = null;
let setName = 'automap';
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') check = true;
  else if (a === '--reason') reason = argv[++i] ?? '';
  else if (a.startsWith('--reason=')) reason = a.slice('--reason='.length);
  else if (a === '--set') setName = argv[++i] ?? '';
  else if (a.startsWith('--set=')) setName = a.slice('--set='.length);
  else die(`unknown argument: ${a} (usage: [--set walls|automap] --reason "text" | --check)`);
}
if (!Object.hasOwn(SETS, setName)) die(`unknown --set ${JSON.stringify(setName)} (have: ${Object.keys(SETS).join(', ')})`);
if (check && reason !== null) die('--check takes no --reason');
if (!check && (reason === null || reason.trim() === '')) {
  die('REGENERATION requires a reason: --reason "why the goldens change" (meta.json records it)');
}

const SET = SETS[setName];
const GOLDENS = join(ROOT, 'tests', 'render', 'goldens', setName);
const META = join(GOLDENS, 'meta.json');
const REVIEW = join(ROOT, 'test-results', 'goldens', setName);
// M9-11: a set may span several test files (m9 = m9hud + m9menus + m9wi);
// dumps from ALL files merge into the shared dump dir (unique scene names).
const TEST_FILES: string[] = Array.isArray(SET.testFile)
  ? SET.testFile
  : [SET.testFile];
if (check && !existsSync(META)) die(`no committed goldens to check against: ${META}`);

function die(msg) {
  console.error(`goldens-update: ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* run the golden pipeline (vitest) into a temp dump dir               */
/* ------------------------------------------------------------------ */

const dumpDir = mkdtempSync(join(tmpdir(), 'goldens-dump-'));
const vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
for (const testFile of TEST_FILES) {
  const run = spawnSync(
    process.execPath,
    [vitestBin, 'run', testFile],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        GOLDENS_DUMP_DIR: dumpDir,
        GOLDENS_MODE: check ? 'check' : 'update'
      }
    }
  );
  if (run.status !== 0) {
    rmSync(dumpDir, { recursive: true, force: true });
    die(`golden pipeline run failed (${testFile}: vitest exit ${run.status ?? 'signal'})`);
  }
}

/* ------------------------------------------------------------------ */
/* dumps → scenes                                                       */
/* ------------------------------------------------------------------ */

const dumps = {};
for (const f of readdirSorted(join(dumpDir))) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(readFileSync(join(dumpDir, f), 'utf8'));
  j.bin = readFileSync(join(dumpDir, `${j.name}.bin`));
  const sha = sha256(j.bin);
  if (sha !== j.indexSha256) die(`${j.name}: dump bin/sha mismatch (corrupt dump)`);
  dumps[j.name] = j;
}
function readdirSorted(d) {
  return existsSync(d) ? readdirSync(d).sort() : [];
}

const meta = existsSync(META)
  ? JSON.parse(readFileSync(META, 'utf8'))
  : {
      schema: 1,
      generator: 'scripts/goldens-update.mjs',
      set: setName,
      pipeline: SET.pipeline,
      scenes: {}
    };

let failed = false;
const today = new Date().toISOString().slice(0, 10);
const names = [...new Set([...Object.keys(dumps), ...Object.keys(meta.scenes ?? {})])].sort();
if (!check) mkdirp(GOLDENS); // a brand-new --set tree has no goldens dir yet

for (const name of names) {
  const dump = dumps[name];
  const entry = meta.scenes?.[name];
  if (!dump) {
    console.log(`skip   ${name} — pipeline skipped it (no wad?) — committed golden left untouched`);
    continue;
  }
  if (!entry) {
    if (check) {
      console.error(`DRIFT  ${name} — present in pipeline, missing from meta.json`);
      failed = true;
      continue;
    }
  } else if (check) {
    if (entry.indexSha256 !== dump.indexSha256) {
      console.error(`DRIFT  ${name} index sha\n  committed: ${entry.indexSha256}\n  current  : ${dump.indexSha256}`);
      failed = true;
      continue;
    }
    const pngPath = join(GOLDENS, entry.png ?? `${name}.png`);
    if (!existsSync(pngPath)) {
      console.error(`DRIFT  ${name} blessed PNG missing: ${pngPath}`);
      failed = true;
      continue;
    }
    const fresh = pngFromIndexed(dump.width, dump.height, dump.bin, dump.indexSha256, dump.paletteRgb);
    const committed = readFileSync(pngPath);
    if (!committed.equals(fresh)) {
      // bytes may legitimately differ across zlib builds — prove pixel +
      // provenance equality before calling drift.
      const ok =
        readTextChunk(committed, 'doom-index-sha256') === dump.indexSha256 &&
        decodePng(committed).pixels.equals(decodePng(fresh).pixels);
      if (!ok) {
        console.error(`DRIFT  ${name} PNG pixels/provenance differ from ${entry.png}`);
        failed = true;
        continue;
      }
      console.log(`ok*    ${name} (PNG bytes differ across zlib builds; pixels + sha match)`);
    } else {
      console.log(`ok     ${name}`);
    }
    continue;
  }

  // update (or new scene in update mode)
  const pngName = entry?.png ?? `${name}.png`;
  const prev = meta.scenes?.[name];
  meta.scenes[name] = {
    kind: dump.kind,
    script: dump.script,
    ...(dump.viewpoint ? { viewpoint: dump.viewpoint } : {}),
    ...(dump.hom !== undefined ? { hom: dump.hom } : {}),
    width: dump.width,
    height: dump.height,
    indexSha256: dump.indexSha256,
    png: pngName,
    ...(dump.kind === 'iwad' ? { wad: { file: 'freedoom1.wad', sha256: dump.wadSha256 } } : {}),
    reason,
    updatedAt: today,
    history: [...(prev?.history ?? []), { reason, at: today, indexSha256: dump.indexSha256 }]
  };
  writeFileSync(join(GOLDENS, pngName), pngFromIndexed(dump.width, dump.height, dump.bin, dump.indexSha256, dump.paletteRgb));
  console.log(`bless  ${name} → ${pngName}`);
}

if (!check) {
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
  console.log(`meta   ${META}`);
}

/* review copies (M2-10 acceptance 4: PNGs written for review) */
mkdirp(REVIEW);
for (const name of names) {
  const dump = dumps[name];
  if (!dump) continue;
  const png = pngFromIndexed(dump.width, dump.height, dump.bin, dump.indexSha256, dump.paletteRgb);
  writeFileSync(join(REVIEW, `${name}.png`), png);
}
console.log(`review ${REVIEW}`);

rmSync(dumpDir, { recursive: true, force: true });
if (failed) die('drift detected — regenerate with: npm run goldens:update -- --reason "..."');
console.log(check ? 'goldens: no drift' : `goldens: updated (${names.filter((n) => dumps[n]).length} scenes), reason: ${reason}`);

/* ------------------------------------------------------------------ */
/* minimal PNG writer/reader (RGB8, filter 0, node:zlib)                */
/* ------------------------------------------------------------------ */

/** CRC32 with lazily built table (module bottom — main flow runs first). */
function crc32(buf) {
  const table = (crc32.t ??= (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Palette index → RGB (R09 §5 families; see header). */
function indexRgb(i) {
  if (i === 0) return [0, 0, 0];
  if (i >= 176 && i <= 191) return [176 + (i - 176) * 5, 0, 0]; // WALLCOLORS reds
  if (i === 231 || (i >= 231 && i <= 238)) return [255, 255, 0]; // CDWALLCOLORS
  if (i >= 64 && i <= 79) return [128 + (i - 64) * 2, 72 + (i - 64), 0]; // FDWALLCOLORS browns
  if (i >= 96 && i <= 111) return Array(3).fill(96 + (i - 96) * 8); // GRAYS grid/xhair
  if (i >= 112 && i <= 127) return [0, 128 + (i - 112) * 8, 0]; // GREENS things
  if (i >= 208 && i <= 210) return [255, 255, 255]; // WHITE arrow
  return Array(3).fill(i); // gray ramp fallback
}

function pngFromIndexed(width, height, indices, sha, paletteRgb) {
  // M3-08: a dump-provided palette (768 RGB ints) wins; else the automap
  // color-family mapping below.
  const rgbOf =
    paletteRgb === undefined
      ? indexRgb
      : (i) => [paletteRgb[i * 3], paletteRgb[i * 3 + 1], paletteRgb[i * 3 + 2]];
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbOf(indices[y * width + x]);
      raw[p++] = r;
      raw[p++] = g;
      raw[p++] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.concat([Buffer.from('doom-index-sha256\0', 'ascii'), Buffer.from(sha, 'ascii')])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Decode OUR writer's output (filter 0 only). {width,height,pixels}. */
function decodePng(png) {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    raw.copy(pixels, y * stride, y * (1 + stride) + 1, y * (1 + stride) + 1 + stride);
  }
  return { width, height, pixels };
}

function readTextChunk(png, keyword) {
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'tEXt') {
      const data = png.subarray(pos + 8, pos + 8 + len);
      const nul = data.indexOf(0);
      if (data.toString('ascii', 0, nul) === keyword) return data.toString('ascii', nul + 1);
    }
    pos += 12 + len;
  }
  return null;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function mkdirp(d) {
  mkdirSync(d, { recursive: true });
}
