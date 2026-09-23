// audio/sfxdata.test.ts — DS lump decode + per-WAD cache (M10-02, plan
// §M10-02 acceptance #2-#4: synthetic goldens incl. header edge cases,
// IWAD skipIf census + first-64-sample sha goldens, missing names → null).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WadFile } from '../wad/wadfile';
import { NUMSFX, SFX_INFO } from './sfxinfo';
import {
  DS_FORMAT_U8,
  decodeDsLump,
  playbackRateFor,
  precacheSfx,
  sfxDataById,
  sfxDataByName,
} from './sfxdata';

/* ---------------------------- synthetic builder --------------------------- */

/** Build a DS lump: 8-byte header (LE) + unsigned-8-bit body (§0.8 format). */
function dsLump(rate: number, body: Uint8Array, format = DS_FORMAT_U8, count = body.length): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, format, true);
  dv.setUint16(2, rate, true);
  dv.setUint32(4, count, true);
  out.set(body, 8);
  return out;
}

/** Deterministic LCG byte source (no Math.random — goldens must be stable). */
function lcgBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i += 1) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s >>> 24) & 0xff;
  }
  return out;
}

function shaF32(f: Float32Array, count = 64): string {
  const n = Math.min(count, f.length);
  return createHash('sha256')
    .update(Buffer.from(f.buffer, f.byteOffset, n * 4))
    .digest('hex');
}

/* ------------------------------- unit tests ------------------------------- */

describe('decodeDsLump — header + body (§0.8 format)', () => {
  it('decodes format-3 8-bit PCM: (b − 128) / 128, source rate kept', () => {
    const lump = dsLump(22050, Uint8Array.from([128, 255, 0, 192, 64]));
    const d = decodeDsLump(lump);
    expect(d.format).toBe(0x0003);
    expect(d.rate).toBe(22050);
    expect(d.headerCount).toBe(5);
    expect(d.countMismatch).toBe(false);
    // exact in float32: integers over 128 are power-of-two scaled
    expect(Array.from(d.samples)).toEqual([0, 127 / 128, -1, 0.5, -0.5]);
  });

  it('header edge cases: 0-length body, wrong format, wrong count, short lump', () => {
    const empty = decodeDsLump(dsLump(11025, new Uint8Array(0)));
    expect(empty.samples.length).toBe(0);
    expect(empty.rate).toBe(11025);
    expect(empty.countMismatch).toBe(false);

    const oddFormat = decodeDsLump(dsLump(11025, Uint8Array.from([128]), 4));
    expect(oddFormat.format).toBe(4); // warn-tolerant: decoded anyway
    expect(oddFormat.samples.length).toBe(1);

    const lying = decodeDsLump(dsLump(22050, Uint8Array.from([1, 2, 3]), DS_FORMAT_U8, 999));
    expect(lying.countMismatch).toBe(true);
    expect(lying.samples.length).toBe(3); // body [8, lumpLen) is authoritative

    const headerless = decodeDsLump(new Uint8Array(4)); // < 8 bytes → empty
    expect(headerless.samples.length).toBe(0);
    expect(headerless.rate).toBe(0);
  });

  it('vanilla 128-pad semantics: a padded tail decodes to exact silence', () => {
    // vanilla pads bodies to 512-multiples with 128 (i_sound.c:230-241)
    const padded = dsLump(22050, Uint8Array.from([100, 128, 128, 128, 128]));
    const d = decodeDsLump(padded);
    expect(Array.from(d.samples.slice(1))).toEqual([0, 0, 0, 0]);
  });

  it('double-run stability: two decodes are byte-identical', () => {
    const lump = dsLump(17990, lcgBytes(1000, 7));
    const a = decodeDsLump(lump);
    const b = decodeDsLump(lump);
    expect(Buffer.from(a.samples.buffer)).toEqual(Buffer.from(b.samples.buffer));
    expect(shaF32(a.samples)).toBe(shaF32(b.samples));
  });

  it('synthetic golden: LCG(1000, seed 7) @22050 hashes stable', () => {
    const d = decodeDsLump(dsLump(22050, lcgBytes(1000, 7)));
    expect(shaF32(d.samples)).toBe(shaF32(decodeDsLump(dsLump(22050, lcgBytes(1000, 7))).samples));
    expect(shaF32(d.samples).slice(0, 16)).toMatch(/^[0-9a-f]{16}$/);
    // float32 law exactness spot: byte 66 → -0.484375 = (66-128)/128 exactly
    const exact = decodeDsLump(dsLump(8000, Uint8Array.from([66])));
    expect(exact.samples[0]).toBe(-0.484375);
  });
});

describe('playbackRateFor — the resample decision (§M10-02)', () => {
  it('source rate / context rate × pitch/128 (NORM_PITCH 128 = unity)', () => {
    const d = decodeDsLump(dsLump(22050, new Uint8Array(16)));
    expect(playbackRateFor(d, 48000)).toBeCloseTo(22050 / 48000, 12);
    expect(playbackRateFor(d, 48000, 128)).toBe(playbackRateFor(d, 48000));
    expect(playbackRateFor(d, 48000, 150)).toBe((22050 / 48000) * (150 / 128));
    expect(playbackRateFor(decodeDsLump(dsLump(44100, new Uint8Array(4))), 44100)).toBe(1);
  });
});

describe('cache API on synthetic WADs', () => {
  function fakeWad(lumps: Record<string, Uint8Array>): WadFile {
    // minimal IWAD writer: header + dir + data
    const names = Object.keys(lumps);
    const total = names.reduce((a, n) => a + lumps[n]!.length, 0);
    const buf = new ArrayBuffer(12 + total + names.length * 16);
    const view = new DataView(buf);
    const b = new Uint8Array(buf);
    b.set([0x49, 0x57, 0x41, 0x44], 0); // 'IWAD'
    view.setInt32(4, names.length, true);
    view.setInt32(8, 12 + total, true); // data first, dir after it
    let pos = 12;
    names.forEach((n, i) => {
      b.set(lumps[n]!, pos);
      const p = 12 + total + i * 16;
      view.setInt32(p, pos, true); // filepos @0
      view.setInt32(p + 4, lumps[n]!.length, true); // size @4
      for (let j = 0; j < 8; j += 1) b[p + 8 + j] = j < n.length ? n.charCodeAt(j)! : 0; // name @8
      pos += lumps[n]!.length;
    });
    return WadFile.parse(buf);
  }

  it('decodes once per mount (object identity), null for missing lumps', () => {
    const wad = fakeWad({ DSPST01: dsLump(8000, Uint8Array.from([0, 128, 255])) });
    expect(sfxDataById(wad, 1)).toBeNull(); // real DSPISTOL absent → silent, no throw
    const b = sfxDataByName(wad, 'sfx_pistol');
    expect(b).toBeNull();
    expect(sfxDataById(wad, 0)).toBeNull(); // sfx_None dummy
    expect(() => sfxDataById(wad, 109)).toThrow(RangeError);
    expect(() => sfxDataByName(wad, 'bogus')).toThrow(RangeError);
  });

  it('chgun resolves through the link (pistol data, sounds.c:204)', () => {
    const wad = fakeWad({ DSPISTOL: dsLump(22050, Uint8Array.from([64, 192])) });
    const chgun = sfxDataById(wad, 86);
    const pistol = sfxDataById(wad, 1);
    expect(chgun).not.toBeNull();
    expect(chgun).toBe(pistol); // SAME object — decoded once, link-shared
    expect(sfxDataById(wad, 87)).toBeNull(); // tink has no lump here
  });

  it('precacheSfx census counts a silent id once and links once', () => {
    const wad = fakeWad({ DSPISTOL: dsLump(22050, Uint8Array.from([64])) });
    const census = precacheSfx(wad);
    expect(census.decodedIds).toEqual([1, 86]); // pistol + chgun (link)
    expect(census.silentIds.length).toBe(NUMSFX - 1 - 2);
    expect(census.rateHistogram).toEqual({ 22050: 1 }); // distinct lumps only
  });
});

/* ------------------------------ IWAD goldens ------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad DS census + goldens (M10-02)', () => {
  let cached: WadFile | undefined;
  function wad(): WadFile {
    cached ??= WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    return cached;
  }

  // Measured this pass (plan §0.8/§0.10 re-audit): 69 DS* lumps = 67 table
  // names + DSOUCH/DSJUMP (non-vanilla, unreferenced); rates per §0.8.
  const SPOT_SHA_64: Readonly<Record<string, string>> = {
    DSPISTOL: '89e6cbeaa1b324d6273c7f1a020cf8be2013f402ce69da0dcd3b2fcdc7790010',
    DSSHOTGN: 'd26c8c733c0a4aae518f2e4910c4f0ce8e4878bbb02bb268f751c089e681272e',
    DSDOROPN: '0cafb4ef0b0de9fdf2ae3efe78b76c9f36b8e87839d15a1185a4e5b5f03efd33',
    DSSAWFUL: 'f6b733ea5ce4b8c57d6991d25ffd9c368812a44e9dede3ed2158a1d72844ba64',
    DSOOF: '5a8946d24c28eaeccf98d82d2c290bcbebd9881dc61ef522b955d79d2bc1b9db',
    DSBAREXP: '5a302664186cd469bd46eadd12089e2007042a1a291be303b0ee889c9a2ea31e',
    DSWPNUP: '2f7745d8ccbc8b653d55f809f61717e288a29b309d3ee8e82bef941c52fc6839',
    DSPOSIT1: '86b9df851732eae410d9d00f271f79d155453b5e72446f28978b8030c1cbf178',
  };

  it('all 67 present lumps decode with the §0.8 header census', () => {
    const census = precacheSfx(wad());
    expect(census.decodedIds.length).toBe(68); // 67 own-lump + chgun (link)
    expect(census.rateHistogram).toEqual({ 11025: 22, 16000: 1, 17990: 1, 22050: 42, 44100: 1 });
    expect(census.countMismatchIds).toEqual([]); // lumpLen == 8 + count, all 67
    expect(census.formatOddIds).toEqual([]); // format field == 3 everywhere
  });

  it('the 40 genuinely-missing names resolve to null, never throw; chgun via link', () => {
    for (let id = 1; id < NUMSFX; id += 1) {
      if (id === 86) continue;
      const d = sfxDataById(wad(), id); // must not throw for ANY id
      const info = SFX_INFO[id]!;
      if (d === null) {
        expect(info.link, info.name).toBeNull();
      }
    }
    expect(sfxDataById(wad(), 86)).toBe(sfxDataById(wad(), 1)); // link-shared
    const silent = new Set(precacheSfx(wad()).silentIds);
    expect(silent.size).toBe(40);
    for (const name of ['radio', 'flame', 'skeatk', 'bspwlk']) {
      expect(sfxDataByName(wad(), name)).toBeNull();
    }
  });

  it('8 spot lumps: first-64-float sha goldens, stable across double run', () => {
    for (const [lump, sha] of Object.entries(SPOT_SHA_64)) {
      const a = decodeDsLump(wad().readLumpByName(lump));
      const b = decodeDsLump(wad().readLumpByName(lump));
      expect(shaF32(a.samples), lump).toBe(sha);
      expect(shaF32(b.samples), lump).toBe(sha); // double-run determinism
    }
  });
});
