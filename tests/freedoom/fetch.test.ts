// tests/freedoom/fetch.test.ts — M10-08 fetch-script discipline
// (task acceptance: "fetch script test — checksum verify fail = hard stop").
// Drives scripts/freedoom/fetch.mjs against synthetic local zips + pins
// (--pin/--root/--local seams): extract+hash gate happy path, tampered
// entry = hard stop, and the --verify-music matrix (ok / tampered / stray /
// missing). Plus the real release.json sanity guards.
// SPDX-License-Identifier: GPL-2.0-or-later

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../../scripts/freedoom/fetch.mjs', import.meta.url));
const RELEASE_JSON = fileURLToPath(
  new URL('../../scripts/freedoom/release.json', import.meta.url)
);

const sha = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/* ---- minimal STORE-method zip writer (fetch.mjs reads method 0) ---- */
interface ZipEntry {
  name: string;
  data: Buffer;
}

function cstring(s: string): Buffer {
  return Buffer.from(s, 'utf8');
}

function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = cstring(e.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method 0 = store
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + e.data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ---- harness ---- */

function makeSandbox(wadContent: Buffer, oggContent: Buffer): {
  dir: string;
  zipPath: string;
  pinPath: string;
  root: string;
  wadHash: string;
  oggHash: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'freedoom-fetch-'));
  const root = join(dir, 'root');
  mkdirSync(root, { recursive: true });
  const zipPath = join(dir, 'rel.zip');
  writeFileSync(
    zipPath,
    buildZip([
      { name: 'rel/freedoom1.wad', data: wadContent },
      { name: 'rel/music/d_e1m1.ogg', data: oggContent }
    ])
  );
  const pinPath = join(dir, 'pin.json');
  writeFileSync(
    pinPath,
    JSON.stringify({
      repo: 'fake/freedoom',
      tag: 'v0.0.0',
      zipUrl: 'https://example.invalid/rel.zip',
      zipSha256: sha(readFileSync(zipPath)),
      entries: [
        {
          zipPath: 'rel/freedoom1.wad',
          target: 'wads/freedoom1.wad',
          sha256: sha(wadContent),
          size: wadContent.length,
          required: true
        }
      ],
      musicDir: 'wads/music',
      musicEntries: [
        {
          zipPath: 'rel/music/d_e1m1.ogg',
          target: 'wads/music/d_e1m1.ogg',
          sha256: sha(oggContent),
          size: oggContent.length,
          required: true
        }
      ]
    })
  );
  return { dir, zipPath, pinPath, root, wadHash: sha(wadContent), oggHash: sha(oggContent) };
}

function run(sb: ReturnType<typeof makeSandbox>, extra: string[]): {
  code: number;
  out: string;
} {
  try {
    const out = execFileSync(
      process.execPath,
      [
        SCRIPT,
        '--pin',
        sb.pinPath,
        '--root',
        sb.root,
        '--local',
        sb.zipPath,
        ...extra
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
    );
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const WAD = Buffer.from('IWAD' + 'x'.repeat(512), 'binary');
const OGG = Buffer.concat([Buffer.from('OggS', 'latin1'), Buffer.alloc(60, 7)]);

describe('M10-08 fetch.mjs OGG pin + checksum discipline', () => {
  it('happy path: --music extracts wad + companion ogg with hashes verified', () => {
    const sb = makeSandbox(WAD, OGG);
    const r = run(sb, ['--music']);
    expect(r.code).toBe(0);
    expect(existsSync(join(sb.root, 'wads/freedoom1.wad'))).toBe(true);
    const ogg = readFileSync(join(sb.root, 'wads/music/d_e1m1.ogg'));
    expect(sha(ogg)).toBe(sb.oggHash);
  });

  it('tampered companion entry in the zip: HARD STOP (exit 1, mismatch msg)', () => {
    const sb = makeSandbox(WAD, OGG);
    // Re-pack the zip with the ogg bytes altered (pin unchanged).
    writeFileSync(
      sb.zipPath,
      buildZip([
        { name: 'rel/freedoom1.wad', data: WAD },
        { name: 'rel/music/d_e1m1.ogg', data: Buffer.alloc(64, 9) }
      ])
    );
    const r = run(sb, ['--music']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('sha256 mismatch');
    expect(existsSync(join(sb.root, 'wads/music/d_e1m1.ogg'))).toBe(false);
  });

  it('cache hit: pinned files present ⇒ zero zip reads', () => {
    const sb = makeSandbox(WAD, OGG);
    mkdirSync(join(sb.root, 'wads/music'), { recursive: true });
    writeFileSync(join(sb.root, 'wads/freedoom1.wad'), WAD);
    writeFileSync(join(sb.root, 'wads/music/d_e1m1.ogg'), OGG);
    const r = run(sb, ['--music']);
    expect(r.code).toBe(0); // cache check precedes any zip access
    expect(r.out).toContain('cache hit');
  });
});

describe('M10-08 fetch.mjs --verify-music (verify-not-commit gate)', () => {
  function prepared(): ReturnType<typeof makeSandbox> {
    const sb = makeSandbox(WAD, OGG);
    mkdirSync(join(sb.root, 'wads/music'), { recursive: true });
    return sb;
  }
  const verify = (sb: ReturnType<typeof makeSandbox>): { code: number; out: string } => {
    try {
      const out = execFileSync(
        process.execPath,
        [SCRIPT, '--pin', sb.pinPath, '--root', sb.root, '--verify-music'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }
      );
      return { code: 0, out };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  it('matching files verify clean', () => {
    const sb = prepared();
    writeFileSync(join(sb.root, 'wads/music/d_e1m1.ogg'), OGG);
    const r = verify(sb);
    expect(r.code).toBe(0);
    expect(r.out).toContain('verified');
  });

  it('TAMPERED file: HARD STOP', () => {
    const sb = prepared();
    writeFileSync(join(sb.root, 'wads/music/d_e1m1.ogg'), Buffer.alloc(64, 1));
    const r = verify(sb);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MISMATCH');
  });

  it('UNPINNED stray file in wads/music: HARD STOP', () => {
    const sb = prepared();
    writeFileSync(join(sb.root, 'wads/music/d_e1m1.ogg'), OGG);
    writeFileSync(join(sb.root, 'wads/music/d_bogus.ogg'), OGG);
    const r = verify(sb);
    expect(r.code).toBe(1);
    expect(r.out).toContain('stray');
  });

  it('missing pinned file: HARD STOP', () => {
    const sb = prepared();
    const r = verify(sb);
    expect(r.code).toBe(1);
    expect(r.out).toContain('missing pinned file');
  });
});

describe('M10-08 real release.json (pinned 0.13.0) guards', () => {
  it('parses; music slot present and EMPTY for the audited tag', () => {
    const pin = JSON.parse(readFileSync(RELEASE_JSON, 'utf8')) as {
      entries: { target: string; sha256: string; zipPath: string }[];
      musicDir: string;
      musicEntries: unknown[];
    };
    // The v0.13.0 zip audit (this task): 11 entries, ZERO .ogg — the pin
    // documents that; the music lives in the WAD as 41 SMF lumps.
    expect(pin.musicDir).toBe('wads/music');
    expect(pin.musicEntries).toEqual([]);
    expect(pin.entries[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
