/**
 * persist/demoFile tests — M11-06 (§0.5 format truth, D-11e): header
 * roundtrip BYTE-EXACT against an independent literal of the §0.5 table
 * (the SAME literal pDemo.test.ts pins from the sim side — both codecs
 * stand alone per the D-11g zone rule), size accounting (plan §4-4: the
 * DEMOMARKER + %4 structure proves NO checksum bytes), the marker-is-
 * only-at-tic-boundaries rule (buttons byte 128+ is data), truncation
 * flag, and the file glue under node (no DOM ⇒ downloadLmp false).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import {
  DEMOMARKER,
  DEMO_HEADER_SIZE,
  VERSION,
  downloadLmp,
  encodeDemoHeader,
  inspectDemo,
  lmpFileName,
  loadLmp,
  parseDemoHeader,
  toLmpBlob
} from './demoFile';

const HDR = {
  version: 110, skill: 5, episode: 1, map: 1,
  deathmatch: 0, respawnparm: 0, fastparm: 0, nomonsters: 0, consoleplayer: 0,
  playeringame: [true, false, false, false]
};

describe('demoFile header codec (§0.5 byte table)', () => {
  it('encode is the 13-byte literal (independent of the sim codec)', () => {
    expect(Array.from(encodeDemoHeader(HDR))).toEqual([
      110, 5, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0
    ]);
    expect(VERSION).toBe(110); // doomdef.h:33 — the savegame shares it
    expect(DEMO_HEADER_SIZE).toBe(13);
  });

  it('roundtrip byte-exact (incl. deathmatch/respawn/fast/nomonsters bits)', () => {
    const h = { ...HDR, skill: 3, episode: 2, map: 7, deathmatch: 2,
      respawnparm: 1, fastparm: 1, nomonsters: 1, consoleplayer: 0,
      playeringame: [true, true, false, true] };
    const b = encodeDemoHeader(h);
    expect(parseDemoHeader(b)).toEqual(h);
    expect(Array.from(b)).toEqual([110, 3, 2, 7, 2, 1, 1, 1, 0, 1, 1, 0, 1]);
  });

  it('parse: too short ⇒ null; wrong version SURFACED for the caller guard', () => {
    expect(parseDemoHeader(new Uint8Array(12))).toBeNull();
    const b = encodeDemoHeader({ ...HDR, version: 109 });
    expect(parseDemoHeader(b)!.version).toBe(109); // guard site: sim gDoPlayDemo
  });
});

describe('demoFile size accounting (plan §4-4)', () => {
  const body = (n: number, per = [1, 2, 3, 4]) =>
    Uint8Array.from([...encodeDemoHeader(HDR), ...Array.from({ length: n }, () => per).flat()]);

  it('clean demo: N whole tics + marker; (len-14)%4 == 0 ⇒ NO checksum bytes', () => {
    const b = Uint8Array.from([...body(10), DEMOMARKER]);
    expect(inspectDemo(b)).toEqual({
      header: HDR, tics: 10, hasMarker: true, truncatedMidTic: false
    });
    expect((b.length - (DEMO_HEADER_SIZE + 1)) % 4).toBe(0);
  });

  it('marker byte is only TESTED at tic boundaries (buttons 0x80 = data)', () => {
    // BT_SPECIAL-class buttons byte 128 sits at offset+3 — never a marker.
    const b = Uint8Array.from([...body(1, [0, 0, 0, 128]), DEMOMARKER, 9, 9, 9, 9]);
    const ins = inspectDemo(b);
    expect(ins.hasMarker).toBe(true);
    expect(ins.tics).toBe(1);
  });

  it('truncation mid-tic and missing marker are flagged (graceful sim lane)', () => {
    const b = Uint8Array.from([...body(3), 9, 9]); // +2 bytes mid-tic
    expect(inspectDemo(b)).toMatchObject({ tics: 3, hasMarker: false, truncatedMidTic: true });
    expect(inspectDemo(new Uint8Array(5)).header).toBeNull();
  });
});

describe('demoFile glue (D-11e)', () => {
  it('toLmpBlob carries the exact bytes (application/octet-stream)', () => {
    const b = Uint8Array.from([...encodeDemoHeader(HDR), DEMOMARKER]);
    const blob = toLmpBlob(b);
    expect(blob.size).toBe(b.length);
    expect(blob.type).toBe('application/octet-stream');
  });

  it('downloadLmp: no DOM in node ⇒ false (browser half = globalThis)', () => {
    expect(downloadLmp(new Uint8Array([110]), 'x')).toBe(false);
    expect(lmpFileName('doomdemo')).toBe('doomdemo.lmp'); // g_game.c:1536
    expect(lmpFileName('a.LMP')).toBe('a.LMP');
  });

  it('loadLmp accepts bytes / ArrayBuffer / File-like (the -playdemo file)', async () => {
    const b = Uint8Array.from([110, 3]);
    expect(await loadLmp(b)).toBe(b);
    expect(Array.from(await loadLmp(b.slice().buffer))).toEqual([110, 3]);
    expect(Array.from(await loadLmp({ arrayBuffer: async () => b.slice().buffer }))).toEqual([110, 3]);
  });
});
