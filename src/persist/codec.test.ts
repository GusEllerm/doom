/**
 * M11-02 codec tests — acceptance per docs/design/M11-plan.md §M11-02:
 *  1) golden byte-layout table (literal-offset asserts at 24/40/41/42/43/47 +
 *     terminator) + decode∘encode identity;
 *  2) bad version ⇒ typed BadVersion (no throw); non-0x1d tail ⇒ BadMarker;
 *  3) fuzz: random payloads round-trip byte-equal;
 *  4) SAVEGAMESIZE-1 accepted, overrun rejected with typed error.
 */
import { describe, expect, it } from 'vitest';

import {
  CONSISTANCY_MARKER,
  EMPTY_SLOT,
  HEADER_SIZE,
  PAYLOAD_MAGIC,
  PAYLOAD_VERSION,
  SAVEGAMESIZE,
  SAVESTRINGSIZE,
  VERSION,
  VERSIONSIZE,
  VERSION_STRING,
  buildPayload,
  clampDescription,
  decodeSave,
  encodeSave,
  parsePayload,
  saveFileName,
  type SaveHeader,
  ByteReader,
  ByteWriter,
} from './codec';

/** A fixed, fully-populated header (skill 2/HUMP, E2M4, leveltime 0x15CD2). */
const FIXED: SaveHeader = {
  description: 'GO 2 HURT ME 1', // 14 chars, <= 22 cap
  skill: 2,
  episode: 2,
  map: 4,
  playeringame: [1, 0, 0, 0],
  leveltime: 0x15cd2,
};

const FIXED_PAYLOAD = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x7f]);

function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** Deterministic LCG for the fuzz battery (no Math.random — golden-stable). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x;
  };
}

describe('codec constants — source pins', () => {
  it('match the §0.1 truths', () => {
    // doomdef.h:33
    expect(VERSION).toBe(110);
    // g_game.c:75 / :1198 / :74
    expect(SAVESTRINGSIZE).toBe(24);
    expect(VERSIONSIZE).toBe(16);
    expect(SAVEGAMESIZE).toBe(0x2c000);
    // g_game.c:1301
    expect(CONSISTANCY_MARKER).toBe(0x1d);
    // 24+16+1+1+1+4+3
    expect(HEADER_SIZE).toBe(50);
    expect(VERSION_STRING).toBe('version 110');
    // d_englsh.h:75
    expect(EMPTY_SLOT).toBe('empty slot');
  });
});

describe('golden byte layout (plan §0.1, g_game.c:1270-1321)', () => {
  const enc = encodeSave(FIXED, FIXED_PAYLOAD);

  it('encodes with no failure', () => {
    expect(enc.ok).toBe(true);
  });

  it('writes the exact bytes at every pinned offset', () => {
    if (!enc.ok) throw new Error('encode failed');
    const b = enc.bytes;
    // total = header 50 + payload 6 + marker 1
    expect(b.length).toBe(50 + FIXED_PAYLOAD.length + 1);

    // offset 0..23 — description, NUL-padded into the 24B field (:1282).
    expect([...b.subarray(0, 14)]).toEqual(ascii('GO 2 HURT ME 1'));
    expect(b.subarray(14, 24)).toEqual(new Uint8Array(10));

    // offset 24 — "version 110" then NULs to 40 (:1284-1286).
    expect([...b.subarray(24, 35)]).toEqual(ascii('version 110'));
    expect(b.subarray(35, 40)).toEqual(new Uint8Array(5));

    // offset 40/41/42 — gameskill / gameepisode / gamemap (:1288-1290).
    expect(b[40]).toBe(2);
    expect(b[41]).toBe(2);
    expect(b[42]).toBe(4);

    // offset 43 — playeringame[0..3] (:1291).
    expect([...b.subarray(43, 47)]).toEqual([1, 0, 0, 0]);

    // offset 47 — leveltime split >>16, >>8, &0xff (:1292-1294).
    expect(b[47]).toBe(0x01);
    expect(b[48]).toBe(0x5c);
    expect(b[49]).toBe(0xd2);

    // offset 50 — payload verbatim.
    expect(b.subarray(50, 56)).toEqual(FIXED_PAYLOAD);

    // final byte — consistancy marker (:1301).
    expect(b[b.length - 1]).toBe(0x1d);
  });

  it('decodes back to an identical header + payload (decode∘encode == identity)', () => {
    if (!enc.ok) throw new Error('encode failed');
    const dec = decodeSave(enc.bytes);
    expect(dec.ok).toBe(true);
    if (!dec.ok) throw new Error('decode failed');
    expect(dec.header).toEqual(FIXED);
    expect(dec.payload).toEqual(FIXED_PAYLOAD);
    // re-encode is byte-identical
    const again = encodeSave(dec.header, dec.payload);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('re-encode failed');
    expect(again.bytes).toEqual(enc.bytes);
  });

  it('encodes a zero header minimally: 51 bytes, empty description', () => {
    const r = encodeSave(
      { description: '', skill: 0, episode: 1, map: 1, playeringame: [1, 0, 0, 0], leveltime: 0 },
      new Uint8Array(0),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('encode failed');
    expect(r.bytes.length).toBe(51);
    expect(r.bytes[0]).toBe(0); // empty description field
    expect(r.bytes[50]).toBe(0x1d); // marker immediately after header
  });
});

describe('failure modes are typed results, never throws', () => {
  it('bad version string ⇒ badVersion (vanilla silent-return, :1214-1217)', () => {
    const enc = encodeSave(FIXED, FIXED_PAYLOAD);
    if (!enc.ok) throw new Error('encode failed');
    const corrupt = enc.bytes.slice();
    // clobber the version field like a 1.9 file would have it
    corrupt.set([0x64, 0x4f, 0x4f, 0x4d], 24); // "dOOM"
    const dec = decodeSave(corrupt);
    expect(dec.ok).toBe(false);
    if (dec.ok) throw new Error('expected failure');
    expect(dec.failure.kind).toBe('badVersion');
  });

  it('version 104 variant ⇒ badVersion with the found string', () => {
    const enc = encodeSave(FIXED, FIXED_PAYLOAD);
    if (!enc.ok) throw new Error('encode failed');
    const corrupt = enc.bytes.slice();
    corrupt.set([...ascii('version 104'), 0, 0, 0, 0, 0], 24);
    const dec = decodeSave(corrupt);
    expect(!dec.ok && dec.failure.kind === 'badVersion' && dec.failure.found).toBe('version 104');
  });

  it('non-0x1d tail ⇒ badMarker (vanilla I_Error "Bad savegame", :1240)', () => {
    const enc = encodeSave(FIXED, FIXED_PAYLOAD);
    if (!enc.ok) throw new Error('encode failed');
    const corrupt = enc.bytes.slice();
    corrupt[corrupt.length - 1] = 0x1e;
    const dec = decodeSave(corrupt);
    expect(!dec.ok && dec.failure.kind === 'badMarker').toBe(true);
    if (!dec.ok && dec.failure.kind === 'badMarker') expect(dec.failure.found).toBe(0x1e);
  });

  it('truncated inputs ⇒ truncated (every prefix below HEADER_SIZE+1)', () => {
    const enc = encodeSave(FIXED, FIXED_PAYLOAD);
    if (!enc.ok) throw new Error('encode failed');
    for (let n = 0; n < HEADER_SIZE + 1; n++) {
      const dec = decodeSave(enc.bytes.subarray(0, n));
      expect(!dec.ok && dec.failure.kind === 'truncated').toBe(true);
      if (!dec.ok && dec.failure.kind === 'truncated') {
        expect(dec.failure.needed).toBe(HEADER_SIZE + 1);
        expect(dec.failure.have).toBe(n);
      }
    }
  });

  it('truncated mid-header still reports truncated, not garbage', () => {
    const dec = decodeSave(new Uint8Array(HEADER_SIZE));
    expect(!dec.ok && dec.failure.kind === 'truncated' && dec.failure.have).toBe(HEADER_SIZE);
  });

  it('empty input ⇒ truncated', () => {
    const dec = decodeSave(new Uint8Array(0));
    expect(!dec.ok && dec.failure.kind === 'truncated').toBe(true);
  });

  it('garbage of valid length ⇒ typed, never throws', () => {
    const rnd = lcg(0xc0ffee);
    for (let i = 0; i < 64; i++) {
      const junk = new Uint8Array(HEADER_SIZE + 1 + (rnd() % 16));
      for (let j = 0; j < junk.length; j++) junk[j] = rnd() & 0xff;
      const dec = decodeSave(junk);
      if (dec.ok) {
        // If garbage accidentally decoded, it must at least carry the exact
        // version field and marker — re-encode must be byte-identical.
        const again = encodeSave(dec.header, dec.payload);
        expect(again.ok && (again as { bytes: Uint8Array }).bytes).toEqual(junk);
      } else {
        expect(['badVersion', 'badMarker']).toContain(dec.failure.kind);
      }
    }
  });

  it('encode rejects out-of-range header fields with badField', () => {
    const bad: Array<[string, Partial<SaveHeader>]> = [
      ['skill', { skill: 5 }],
      ['skill', { skill: -1 }],
      ['episode', { episode: 0 }],
      ['episode', { episode: 5 }],
      ['map', { map: 0 }],
      ['map', { map: 36 }],
      ['leveltime', { leveltime: 0x1000000 }],
      ['leveltime', { leveltime: 1.5 }],
      ['playeringame[i]', { playeringame: [2, 0, 0, 0] }],
      ['description', { description: 'x'.repeat(SAVESTRINGSIZE - 1) }],
    ];
    for (const [field, patch] of bad) {
      const r = encodeSave({ ...FIXED, ...patch }, FIXED_PAYLOAD);
      expect(!r.ok && r.failure.kind === 'badField' && r.failure.field.startsWith(field)).toBe(true);
    }
  });
});

describe('SAVEGAMESIZE accounting (g_game.c:1303-1305)', () => {
  it('total length SAVEGAMESIZE-1 is accepted', () => {
    const payload = new Uint8Array(SAVEGAMESIZE - 1 - HEADER_SIZE - 1);
    const r = encodeSave(FIXED, payload);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('encode failed');
    expect(r.bytes.length).toBe(SAVEGAMESIZE - 1);
    const dec = decodeSave(r.bytes);
    expect(dec.ok && dec.payload).toEqual(payload);
  });

  it('total length exactly SAVEGAMESIZE is accepted (cap is inclusive)', () => {
    const payload = new Uint8Array(SAVEGAMESIZE - HEADER_SIZE - 1);
    const r = encodeSave(FIXED, payload);
    expect(r.ok).toBe(true);
  });

  it('one byte over ⇒ typed bufferOverrun', () => {
    const payload = new Uint8Array(SAVEGAMESIZE - HEADER_SIZE);
    const r = encodeSave(FIXED, payload);
    expect(!r.ok && r.failure.kind === 'bufferOverrun').toBe(true);
    if (!r.ok && r.failure.kind === 'bufferOverrun') {
      expect(r.failure.length).toBe(SAVEGAMESIZE + 1);
      expect(r.failure.limit).toBe(SAVEGAMESIZE);
    }
  });
});

describe('fuzz: random payloads round-trip byte-equal', () => {
  it('40 random headers x payloads up to 4KB round-trip byte-identically', () => {
    const rnd = lcg(0x110c0dec);
    for (let i = 0; i < 40; i++) {
      const len = rnd() % 4096;
      const payload = new Uint8Array(len);
      for (let j = 0; j < len; j++) payload[j] = rnd() & 0xff;
      const dlen = rnd() % 23;
      let description = '';
      for (let j = 0; j < dlen; j++) description += String.fromCharCode(0x20 + (rnd() % 0x5f));
      const header: SaveHeader = {
        description,
        skill: rnd() % 5,
        episode: 1 + (rnd() % 4),
        map: 1 + (rnd() % 9),
        playeringame: [(rnd() % 2) as number, (rnd() % 2) as number, (rnd() % 2) as number, (rnd() % 2) as number],
        leveltime: rnd() % 0x1000000,
      };
      const enc = encodeSave(header, payload);
      expect(enc.ok).toBe(true);
      if (!enc.ok) throw new Error(`encode failed: ${JSON.stringify(enc.failure)}`);
      const dec = decodeSave(enc.bytes);
      expect(dec.ok).toBe(true);
      if (!dec.ok) throw new Error(`decode failed: ${JSON.stringify(dec.failure)}`);
      expect(dec.header).toEqual(header);
      expect(dec.payload).toEqual(payload);
      const re = encodeSave(dec.header, dec.payload);
      expect(re.ok && (re as { bytes: Uint8Array }).bytes).toEqual(enc.bytes);
    }
  });
});

describe('save name / description derivation (§0.4)', () => {
  it('doomsavN.dsg per SAVEGAMENAME (dstrings.h:41, g_game.c:1277)', () => {
    expect(saveFileName(0)).toBe('doomsav0.dsg');
    expect(saveFileName(5)).toBe('doomsav5.dsg');
    expect(saveFileName(9)).toBe('doomsav9.dsg');
    expect(() => saveFileName(10)).toThrow(RangeError);
    expect(() => saveFileName(-1)).toThrow(RangeError);
  });

  it('description clamps to 22 printable chars (m_menu.c width cap)', () => {
    expect(clampDescription('')).toBe('');
    expect(clampDescription('E1M1 BEFORE THE CYBERDRUM')).toBe('E1M1 BEFORE THE CYBERD'); // 22 cap
    expect(clampDescription('a b\ncd ef')).toBe('a bcd ef'); // NUL/tab stripped, spaces kept
    const capped = clampDescription('y'.repeat(40));
    expect(capped.length).toBe(SAVESTRINGSIZE - 2);
    // clamped descriptions always survive encode∘decode
    const r = encodeSave({ ...FIXED, description: capped }, FIXED_PAYLOAD);
    expect(r.ok).toBe(true);
  });
});

describe('DBP1 payload container (D-11a)', () => {
  it('builds little-endian [MAGIC][version u32][id u8, len u32, bytes]*', () => {
    const s0 = new Uint8Array([1, 2, 3]);
    const s9 = new Uint8Array([0xff]);
    const p = buildPayload([
      { id: 0, bytes: s0 },
      { id: 9, bytes: s9 },
    ]);
    expect([...p.subarray(0, 4)]).toEqual(ascii(PAYLOAD_MAGIC));
    const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    expect(dv.getUint32(4, true)).toBe(PAYLOAD_VERSION); // LE stamp
    // section 0 at offset 8: id u8, len u32LE
    expect(p[8]).toBe(0);
    expect(dv.getUint32(9, true)).toBe(3);
    expect(p.subarray(13, 16)).toEqual(s0);
    expect(p[16]).toBe(9);
    expect(dv.getUint32(17, true)).toBe(1);
    const back = parsePayload(p);
    expect(back.ok).toBe(true);
    if (!back.ok) throw new Error('parse failed');
    expect(back.version).toBe(PAYLOAD_VERSION);
    expect(back.sections).toEqual([
      { id: 0, bytes: s0 },
      { id: 9, bytes: s9 },
    ]);
  });

  it('corrupt container inputs are typed', () => {
    expect(parsePayload(new Uint8Array(7)).ok).toBe(false);
    const noMagic = new Uint8Array(8).fill(0);
    const r = parsePayload(noMagic);
    expect(!r.ok && r.failure.kind === 'badMagic').toBe(true);
    const lying = buildPayload([{ id: 1, bytes: new Uint8Array(4) }]);
    new DataView(lying.buffer, lying.byteOffset, lying.byteLength).setUint32(9, 9999, true);
    const lr = parsePayload(lying);
    expect(!lr.ok && lr.failure.kind === 'badSection').toBe(true);
    // embedded in a save end-to-end:
    const enc = encodeSave(FIXED, buildPayload([{ id: 3, bytes: new Uint8Array([7, 7]) }]));
    expect(enc.ok).toBe(true);
    if (!enc.ok) throw new Error('encode failed');
    const dec = decodeSave(enc.bytes);
    expect(dec.ok).toBe(true);
    if (!dec.ok) throw new Error('decode failed');
    const pp = parsePayload(dec.payload);
    expect(pp.ok && pp.sections.length === 1 && pp.sections[0]!.id).toBe(3);
  });
});

describe('reader/writer primitives (P_ReadLong equivalents, LE)', () => {
  it('long/ulong/short round-trip little-endian', () => {
    const w = new ByteWriter(14);
    w.long(-123456);
    w.ulong(0xffffffff);
    w.short(0x1234);
    const bytes = w.result();
    expect([...bytes.subarray(0, 4)]).toEqual([0xc0, 0x1d, 0xfe, 0xff]); // -123456 = 0xFFFE1DC0 LE
    expect([...bytes.subarray(4, 8)]).toEqual([0xff, 0xff, 0xff, 0xff]);
    expect([...bytes.subarray(8, 10)]).toEqual([0x34, 0x12]); // LE order
    const r = new ByteReader(bytes);
    expect(r.long()).toBe(-123456);
    expect(r.ulong()).toBe(0xffffffff);
    expect(r.short()).toBe(0x1234);
    expect(r.remaining).toBe(0);
  });

  it('fixedString reads until first NUL (strcmp semantics)', () => {
    const w = new ByteWriter(16);
    w.fixedString('version 110', 16);
    expect(new ByteReader(w.result()).fixedString(16)).toBe('version 110');
    expect(() => new ByteWriter(4).fixedString('toolong', 4)).toThrow(RangeError);
  });

  it('out-of-range writes throw RangeError on the spot', () => {
    expect(() => new ByteWriter(8).byte(256)).toThrow(RangeError);
    expect(() => new ByteWriter(8).byte(-1)).toThrow(RangeError);
    expect(() => new ByteWriter(8).long(0x80000000)).toThrow(RangeError);
    expect(() => new ByteWriter(8).short(32768)).toThrow(RangeError);
    expect(() => new ByteReader(new Uint8Array(1)).short()).toThrow(RangeError);
  });
});
