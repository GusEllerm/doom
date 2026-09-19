#!/usr/bin/env node
/**
 * M5-10 motion-strip generator (M5-plan §M5-10 — plan owns this path).
 *
 *   node scripts/motion-strip.mjs --reason "why"  → REGEN: run the motion
 *       pipeline (vitest dump mode, tests/render/motion.test.ts), bless the
 *       labelled strip PNGs + per-frame stats into
 *       tests/render/goldens/motion/ (meta.json records the REQUIRED
 *       --reason, like goldens-update.mjs).
 *   node scripts/motion-strip.mjs --check        → DRIFT: run the pipeline
 *       and fail on ANY difference vs the committed goldens (strip index
 *       sha AND decoded PNG pixels; the pipeline's own sha asserts run too).
 *
 * The PNG writer is the SAME minimal writer as scripts/goldens-update.mjs
 * (signature + IHDR + tEXt(doom-index-sha256) + filter-0 IDAT + IEND);
 * goldens-update.mjs itself is deliberately NOT edited by M5-10 (scripts
 * are additive-only this task), so the writer is carried verbatim here —
 * extraction into a shared module is a noted follow-up.
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
// M6-13: optional --set <name> (default "motion"). The mechanics set
// (tests/render/mechanics.test.ts → tests/render/goldens/mechanics) is the
// L5 SPECIALS-driven strip set; the protocol (dump JSON + bin, meta with
// REQUIRED --reason + history, PNG writer) is byte-for-byte identical.
let SET = 'motion';
const SETS = {
  motion: { test: join('tests', 'render', 'motion.test.ts') },
  mechanics: { test: join('tests', 'render', 'mechanics.test.ts') }
};
const PIPELINE =
  'FIXMAP fixture (mapBuilder, f0 | +24 step) -> gInitGame -> warp (debug convention) -> scripted 70 tics (walk + turn ramp held 10s + straighten; feel-09 turnheld) -> renderFrame per tic 0..70 with P_CalcHeight viewz -> 8 labelled frames (tics 0/10/../70, 3x5-font stats) blitted into one indexed strip -> sha256(strip indices)';

const argv = process.argv.slice(2);
let check = false;
let reason = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--check') check = true;
  else if (a === '--set') {
    SET = argv[++i] ?? '';
    if (!(SET in SETS)) die(`unknown set '${SET}' (known: ${Object.keys(SETS).join(', ')})`);
  } else if (a === '--reason') reason = argv[++i] ?? '';
  else if (a.startsWith('--reason=')) reason = a.slice('--reason='.length);
  else die(`unknown argument: ${a} (usage: [--set motion|mechanics] --reason "text" | --check)`);
}
const GOLDENS_DIR = join(ROOT, 'tests', 'render', 'goldens', SET);
const META = join(GOLDENS_DIR, 'meta.json');
const REVIEW = join(ROOT, 'test-results', 'goldens', SET);
const TEST_FILE = SETS[SET].test;
if (check && reason !== null) die('--check takes no --reason');
if (!check && (reason === null || reason.trim() === '')) {
  die('REGENERATION requires a reason: --reason "why the strips change" (meta.json records it)');
}
if (check && !existsSync(META)) die(`no committed strips to check against: ${META}`);

function die(msg) {
  console.error(`motion-strip: ${msg}`);
  process.exit(1);
}

/* run the pipeline (vitest) into a temp dump dir */
const dumpDir = mkdtempSync(join(tmpdir(), 'motion-dump-'));
const vitestBin = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const run = spawnSync(process.execPath, [vitestBin, 'run', TEST_FILE], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, GOLDENS_DUMP_DIR: dumpDir, GOLDENS_MODE: check ? 'check' : 'update' }
});
if (run.status !== 0) {
  rmSync(dumpDir, { recursive: true, force: true });
  die(`motion pipeline failed (vitest exit ${run.status ?? 'signal'})`);
}

const dumps = {};
for (const f of readdirSorted(dumpDir)) {
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
  : { schema: 1, generator: 'scripts/motion-strip.mjs', set: SET, pipeline: PIPELINE, scenes: {} };

let failed = false;
const today = new Date().toISOString().slice(0, 10);
const names = [...new Set([...Object.keys(dumps), ...Object.keys(meta.scenes ?? {})])].sort();
if (!check) mkdirp(GOLDENS_DIR);

for (const name of names) {
  const dump = dumps[name];
  const entry = meta.scenes?.[name];
  if (!dump) {
    console.log(`skip   ${name} — pipeline skipped it — committed strip left untouched`);
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
    const pngPath = join(GOLDENS_DIR, entry.png ?? `${name}.png`);
    if (!existsSync(pngPath)) {
      console.error(`DRIFT  ${name} blessed PNG missing: ${pngPath}`);
      failed = true;
      continue;
    }
    const fresh = pngFromIndexed(dump.width, dump.height, dump.bin, dump.indexSha256, dump.paletteRgb);
    const committed = readFileSync(pngPath);
    if (!committed.equals(fresh)) {
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

  const pngName = entry?.png ?? `${name}.png`;
  const prev = meta.scenes?.[name];
  meta.scenes[name] = {
    kind: dump.kind,
    script: dump.script,
    reason,
    updatedAt: today,
    png: pngName,
    width: dump.width,
    height: dump.height,
    frameTics: dump.frameTics,
    frames: dump.frames,
    indexSha256: dump.indexSha256,
    history: [...(prev?.history ?? []), { reason, at: today, indexSha256: dump.indexSha256 }]
  };
  writeFileSync(join(GOLDENS_DIR, pngName), pngFromIndexed(dump.width, dump.height, dump.bin, dump.indexSha256, dump.paletteRgb));
  console.log(`bless  ${name} → ${pngName}`);
}

if (!check) {
  writeFileSync(META, JSON.stringify(meta, null, 2) + '\n');
  console.log(`meta   ${META}`);
}

mkdirp(REVIEW);
for (const name of names) {
  const dump = dumps[name];
  if (!dump) continue;
  writeFileSync(join(REVIEW, `${name}.png`), pngFromIndexed(dump.width, dump.height, dump.bin, dump.indexSha256, dump.paletteRgb));
}
console.log(`review ${REVIEW}`);

rmSync(dumpDir, { recursive: true, force: true });
if (failed) die('drift detected — regenerate with: node scripts/motion-strip.mjs --reason "..."');
console.log(check ? 'motion strips: no drift' : `motion strips: updated (${names.filter((n) => dumps[n]).length} strips), reason: ${reason}`);

/* ------- minimal PNG writer/reader (verbatim goldens-update.mjs) ----- */

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

function pngFromIndexed(width, height, indices, sha, paletteRgb) {
  const rgbOf = (i) => [paletteRgb[i * 3], paletteRgb[i * 3 + 1], paletteRgb[i * 3 + 2]];
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.concat([Buffer.from('doom-index-sha256\0', 'ascii'), Buffer.from(sha, 'ascii')])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function decodePng(png) {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = data_width(png, pos);
      height = png.subarray(pos + 8, pos + 8 + 13).readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(Buffer.from(png.subarray(pos + 8, pos + 8 + len)));
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
const data_width = (png, pos) => png.subarray(pos + 8, pos + 8 + 13).readUInt32BE(0);

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
