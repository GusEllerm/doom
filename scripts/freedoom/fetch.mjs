#!/usr/bin/env node
/**
 * Fetch and verify the pinned Freedoom release (see docs/DECISIONS.md D005).
 * Downloads the release zip, checks its sha256, extracts the requested WADs
 * into wads/, and verifies each WAD's own pinned sha256.
 *
 * Usage:
 *   node scripts/freedoom/fetch.mjs            # fetch required entries (freedoom1.wad)
 *   node scripts/freedoom/fetch.mjs --all      # include optional entries (freedoom2.wad)
 *   node scripts/freedoom/fetch.mjs --local X  # use a local zip or directory instead of download
 *   FREEDOOM_ZIP_LOCAL=/path/to.zip npm run fetch-freedoom
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PIN_FILE = join(ROOT, 'scripts', 'freedoom', 'release.json');

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// ---- minimal ZIP reader (store + deflate) ----
function unzipEntry(zipBuf, wantedPath) {
  // Locate End Of Central Directory.
  let eocd = -1;
  const minPos = Math.max(0, zipBuf.length - 66_000);
  for (let i = zipBuf.length - 22; i >= minPos; i -= 1) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: EOCD not found');
  const cdCount = zipBuf.readUInt16LE(eocd + 10);
  let ptr = zipBuf.readUInt32LE(eocd + 16);
  for (let n = 0; n < cdCount; n += 1) {
    if (zipBuf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = zipBuf.readUInt16LE(ptr + 10);
    const compSize = zipBuf.readUInt32LE(ptr + 20);
    const nameLen = zipBuf.readUInt16LE(ptr + 28);
    const extraLen = zipBuf.readUInt16LE(ptr + 30);
    const commentLen = zipBuf.readUInt16LE(ptr + 32);
    const localOff = zipBuf.readUInt32LE(ptr + 42);
    const name = zipBuf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    if (name === wantedPath) {
      // Parse local header to find data start.
      if (zipBuf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('corrupt local header');
      const lNameLen = zipBuf.readUInt16LE(localOff + 26);
      const lExtraLen = zipBuf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = zipBuf.subarray(dataStart, dataStart + compSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported zip method ${method} for ${wantedPath}`);
    }
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`entry ${wantedPath} not found in zip`);
}

function findZipIn(dir) {
  const hit = readdirSync(dir).find((f) => f.endsWith('.zip'));
  if (!hit) throw new Error(`no .zip found in directory ${dir}`);
  return join(dir, hit);
}

async function download(url, tries = 3) {
  let lastErr;
  for (let i = 1; i <= tries; i += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      const wait = 2000 * i;
      console.error(`download attempt ${i}/${tries} failed (${err.message}); retrying in ${wait}ms`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function main() {
  const args = process.argv.slice(2);
  const wantAll = args.includes('--all');
  const localIdx = args.indexOf('--local');
  const localZip =
    localIdx >= 0 ? args[localIdx + 1] : process.env.FREEDOOM_ZIP_LOCAL ?? null;

  const pin = JSON.parse(readFileSync(PIN_FILE, 'utf8'));
  const entries = pin.entries.filter((e) => e.required || wantAll);

  // Cache check: if every target already matches its pinned hash, skip all work.
  let allCached = true;
  for (const e of entries) {
    const target = join(ROOT, e.target);
    if (!existsSync(target) || sha256(readFileSync(target)) !== e.sha256) {
      allCached = false;
      break;
    }
    console.log(`cache hit: ${e.target} (sha256 ok)`);
  }
  if (allCached) return;

  let zipBuf;
  if (localZip) {
    const p = statSync(localZip).isDirectory() ? findZipIn(localZip) : resolve(localZip);
    console.log(`using local zip: ${p}`);
    zipBuf = readFileSync(p);
  } else {
    console.log(`downloading ${pin.zipUrl}`);
    zipBuf = await download(pin.zipUrl);
  }

  const got = sha256(zipBuf);
  if (localZip) {
    console.log(`local zip in use (sha256 ${got}); skipping zip-hash gate, WAD hashes still enforced`);
  } else if (got !== pin.zipSha256) {
    throw new Error(`zip sha256 mismatch: got ${got}, pinned ${pin.zipSha256}`);
  } else {
    console.log('zip sha256 verified');
  }

  for (const e of entries) {
    const target = join(ROOT, e.target);
    if (existsSync(target) && sha256(readFileSync(target)) === e.sha256) {
      console.log(`skip (already present): ${e.target}`);
      continue;
    }
    const data = unzipEntry(zipBuf, e.zipPath);
    const wadHash = sha256(data);
    if (wadHash !== e.sha256) {
      throw new Error(`${e.zipPath} sha256 mismatch: got ${wadHash}, pinned ${e.sha256}`);
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
    console.log(`extracted ${e.zipPath} -> ${e.target} (${data.length} bytes, sha256 ok)`);
    if (e.size !== undefined && data.length !== e.size) {
      throw new Error(`${e.target} size ${data.length} != pinned ${e.size}`);
    }
  }
}

main().catch((err) => {
  console.error(`fetch-freedoom FAILED: ${err.message}`);
  process.exitCode = 1;
});
