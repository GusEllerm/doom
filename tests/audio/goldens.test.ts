/**
 * M10-10 — L1 audio golden corpus (M10-plan §M10-10). Committed under
 * tests/audio/goldens/ (meta.json + per-scene `<name>.bin` little-endian
 * Int16 artifacts; big streams bless the sha ONLY — the plan's
 * "renderMix → Int16 hash" wording).
 *
 * Coverage (task §M10-10 1+2, plan acceptance 1):
 *   A. offline-mix scenes ×8: attenuation bands (near / linear-falloff /
 *      far+clip-out), the E1M8 clip-exempt band, the priority kick (+ "Sorry,
 *      Charlie" drop + same-origin steal), the loop start→stop cut, the
 *      multi-source sum (clamp law), the pan/separation sweep;
 *   B. the E1M1 scripted FIREFIGHT mix: 2000-tic recorded live-sfx ledger
 *      (real sim + real DS lumps) → renderMix (IWAD-gated skipIf);
 *   C. SMF→synth golden songs (hand-built smfBuild fixtures): decode
 *      canonical + EXACT plan dump + offline-render checksum (double-run
 *      byte-equal). The plan's D_E1M1/D_INTER/D_VICTOR "decode+plan" line
 *      is superseded by the M10-08 correction chain — those lumps are
 *      embedded OGGs, never SMFs — so the IWAD-gated music golden here is
 *      the D_* sha census (OGG magic + the three named rows).
 *
 * Determinism: EVERY scene renders twice and the bytes must be equal
 * BEFORE any comparison to the blessed corpus. Modes mirror the m9 set:
 * GOLDENS_MODE=update + GOLDENS_DUMP_DIR dumps (bless via
 * `node scripts/goldens-update.mjs --set audio --reason "..."`), otherwise
 * the sha asserts run (`… --check`, and plain `vitest run tests/audio`).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { renderMix, toFloat32, type MixSfxData } from '../../src/audio/mixerCore';
import { SFX_INFO } from '../../src/audio/sfxinfo';
import { buildSmf, type BuildEvent } from '../fixtures/smfBuild';
import {
  audioGolden,
  e1m1Firefight,
  firefightScript,
  hasWad,
  iwad,
  iwadSha256,
  mixHash,
  mkBuf,
  mixToBytes,
  musicGolden,
  peakAbs,
  renderScript,
  sha256Of,
} from '../fixtures/m10Scenarios';

const FU = 65_536;
const SR = 22_050; // exact 35-tic division (630 frames/tic) — tic-aligned grids

/* ------------------------------------------------------------------ */
/* Synthetic exact-binary buffers (no transcendental anywhere)          */
/* ------------------------------------------------------------------ */

const BUF = new Map<number, MixSfxData>();
const put = (id: number, d: MixSfxData): void => void BUF.set(id, d);
put(1, mkBuf('sq', SR, 11_025, 96, 88)); // pistol — 0.5 s
put(4, mkBuf('sq', SR, 11_025, 96, 101)); // dshtgn
put(20, mkBuf('tri', SR, 22_050, 80, 220)); // doropn — 1 s
put(22, mkBuf('tri', SR, 66_150, 96, 331)); // stnmov — 3 s (the loop stand-in)
put(25, mkBuf('sq', SR, 11_025, 112, 75)); // plpain
put(32, mkBuf('tri', SR, 22_050, 64, 150)); // itemup (jitter-free row)
put(35, mkBuf('tri', SR, 88_200, 96, 420)); // telept — 4 s (channel filler)
put(82, mkBuf('sq', SR, 22_050, 128, 64)); // barexp — full-scale loud

/* ------------------------------------------------------------------ */
/* A. offline-mix scenes                                               */
/* ------------------------------------------------------------------ */

describe('audio goldens — offline-mix corpus (fixtures)', () => {
  audioGolden({
    name: 'm10-att-near',
    kind: 'fixture',
    script:
      'pistol(id1) @ dist 128 (<S_CLOSE_DIST 160), origin 100, tic 1 → full snd_SfxVolume band (s_sound.c:796-799)',
    sampleRate: SR,
    render: () =>
      renderMix(
        { events: [{ tic: 1, id: 1, x: 128 * FU, y: 0, origin: 100 }], buffers: BUF, frames: SR },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-att-linear',
    kind: 'fixture',
    script:
      'pistol @ dist 600 (mid 160..1200) → linear falloff law :810-813 vs the near band',
    sampleRate: SR,
    render: () =>
      renderMix(
        { events: [{ tic: 1, id: 1, x: 600 * FU, y: 0, origin: 101 }], buffers: BUF, frames: SR },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-att-far-clipout',
    kind: 'fixture',
    script:
      'pistol @ dist 1100 (audible, faint) AND dshtgn @ dist 1300 (> S_CLIPPING_DIST ⇒ start returns false, :773-777 clip-out) — the band edge',
    sampleRate: SR,
    render: () =>
      renderMix(
        {
          events: [
            { tic: 1, id: 1, x: 1100 * FU, y: 0, origin: 102 },
            { tic: 1, id: 4, x: -1300 * FU, y: 0, origin: 103 },
          ],
          buffers: BUF,
          frames: SR,
        },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-att-map8-clip-exempt',
    kind: 'fixture',
    script:
      'gamemap 8: doropn @ 1300 (clip-out geometry) audible via the :800-808 15+ law + plpain @ 600 (same law, other branch)',
    sampleRate: SR,
    render: () =>
      renderMix(
        {
          gamemap: 8,
          events: [
            { tic: 1, id: 20, x: 1300 * FU, y: 0, origin: 104 },
            { tic: 1, id: 25, x: 0, y: -600 * FU, origin: 105 },
          ],
          buffers: BUF,
          frames: SR,
        },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-priority-kick',
    kind: 'fixture',
    script:
      '8× telept(prio 32, origins 10..17) fill the pool; tic 3 pistol(64) → S_getChannel finds no priority>=64 ⇒ Sorry-Charlie DROP (silence); ' +
      'tic 10 telept(origin 41) kicks the FIRST channel (prio 32>=32); tic 20 telept(origin 12) same-origin steal (s_sound.c:827-875)',
    sampleRate: SR,
    render: () =>
      renderMix(
        {
          events: [
            ...Array.from({ length: 8 }, (_, i) => ({ tic: 1, id: 35, x: 0, y: 0, origin: 10 + i })),
            { tic: 3, id: 1, x: 0, y: 0, origin: 40 },
            { tic: 10, id: 35, x: 0, y: 0, origin: 41 },
            { tic: 20, id: 35, x: 0, y: 0, origin: 12 },
          ],
          buffers: BUF,
          frames: SR,
        },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-loop-start-stop',
    kind: 'fixture',
    script:
      'renderScript: stnmov(origin 70) + plpain(origin 71) at tic 1; S_StopSound(origin 70/71) keys at tic 35 — hard cut mid-buffer (loop start/stop); engine == renderMix on stop-free scripts (asserted below)',
    sampleRate: SR,
    render: () =>
      renderScript(
        {
          events: [
            { tic: 1, id: 22, x: 0, y: 0, origin: 70 },
            { tic: 1, id: 25, x: 64 * FU, y: 0, origin: 71 },
          ],
          stops: [
            { tic: 35, origin: 70 },
            { tic: 35, origin: 71 },
          ],
          buffers: BUF,
          frames: SR,
        },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-multisum-clamp',
    kind: 'fixture',
    script:
      '8 loud sources (ids 1,4,20,22,25,32,35,82; origins 50..57) at the listener — multi-source sum drives the clamp law (±0x7fff / −0x8000 asymmetry, i_sound.c:617-627; both extremes asserted below)',
    sampleRate: SR,
    render: () =>
      renderMix(
        {
          events: [1, 4, 20, 22, 25, 32, 35, 82].map((id, i) => ({
            tic: 1,
            id,
            x: 0,
            y: 0,
            origin: 50 + i,
          })),
          buffers: BUF,
          frames: SR,
        },
        SR,
      ),
  });

  audioGolden({
    name: 'm10-pan-sweep',
    kind: 'fixture',
    script:
      'listener angle keyframes 0/90/180/270° (tics 1/11/21/31) × four 512-unit sources (front doropn, left stnmov, rear plpain, right telept) → sep law 128−(FixedMul(S_STEREO_SWING,finesine)>>16) across all quadrants (:793)',
    sampleRate: SR,
    render: () =>
      renderMix(
        {
          events: [
            { tic: 1, id: 20, x: 512 * FU, y: 0, origin: 60 },
            { tic: 1, id: 22, x: 0, y: 512 * FU, origin: 61 },
            { tic: 1, id: 25, x: -512 * FU, y: 0, origin: 62 },
            { tic: 1, id: 35, x: 0, y: -512 * FU, origin: 63 },
          ],
          listener: [
            { tic: 1, x: 0, y: 0, angle: 0 },
            { tic: 11, x: 0, y: 0, angle: 0x4000_0000 },
            { tic: 21, x: 0, y: 0, angle: 0x8000_0000 },
            { tic: 31, x: 0, y: 0, angle: 0xc000_0000 },
          ],
          buffers: BUF,
          frames: SR,
        },
        SR,
      ),
  });
});

/* ------------------------------------------------------------------ */
/* B. the E1M1 scripted firefight (real sim ledger + real DS lumps)     */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('audio goldens — E1M1 scripted firefight (IWAD-gated)', () => {
  audioGolden({
    name: 'm10-e1m1-firefight',
    kind: 'iwad',
    script:
      'E1M1 gInitGame (freedoom1) → pistol start, held-fire 2000 tics (gTicker, real p_pspr/P_NoiseAlert) → live-sfx ledger (tic-stamped sfxSlot events, stable origin ids) + listener track → renderMix @ 8000 Hz; sha-only artifact (plan Int16-hash wording)',
    sampleRate: 8000,
    artifact: 'none',
    render: () => renderMix(firefightScript(e1m1Firefight()), 8000),
  });

  it('the firefight ledger is non-trivial (pistol shots, ids, tics)', () => {
    const run = e1m1Firefight();
    expect(run.events.length).toBeGreaterThan(10);
    expect(run.events.every((e) => e.id >= 1 && e.tic >= 0 && e.tic < 2000)).toBe(true);
    const shots = run.events.filter((e) => e.id === 1).length;
    expect(shots).toBeGreaterThanOrEqual(50); // 2000 tics / 15-tic refire
    expect(run.listener.length).toBeGreaterThanOrEqual(1);
  });

  it('every firefight sfx id resolves through the real sfxinfo table', () => {
    const run = e1m1Firefight();
    for (const e of run.events) {
      expect(SFX_INFO[e.id], `event id ${e.id}`).toBeDefined();
    }
  });
});

/* ------------------------------------------------------------------ */
/* C. SMF → synth golden songs (hand-built fixtures)                    */
/* ------------------------------------------------------------------ */

const SMF_SR = 22_050;

const fanfare: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
    { delta: 0, type: 'timeSignature', numerator: 4, denominatorPow: 2 },
    { delta: 0, type: 'program', channel: 0, program: 81 },
    { delta: 0, type: 'cc', channel: 0, controller: 7, value: 100 },
    { delta: 0, type: 'cc', channel: 0, controller: 10, value: 96 },
    { delta: 0, type: 'cc', channel: 0, controller: 11, value: 120 },
    { delta: 0, type: 'noteOn', channel: 0, note: 72, velocity: 110 },
    { delta: 480, type: 'noteOff', channel: 0, note: 72, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 0, note: 76, velocity: 96 },
    { delta: 480, type: 'noteOff', channel: 0, note: 76, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 0, note: 79, velocity: 104 },
    { delta: 480, type: 'noteOff', channel: 0, note: 79, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 0, note: 84, velocity: 127 },
    { delta: 960, type: 'noteOff', channel: 0, note: 84, velocity: 0 },
    { delta: 0, type: 'eot' },
  ],
];

const rock: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 428_571 },
    { delta: 0, type: 'program', channel: 0, program: 38 },
    { delta: 0, type: 'cc', channel: 0, controller: 7, value: 88 },
    { delta: 0, type: 'cc', channel: 0, controller: 10, value: 64 },
    { delta: 0, type: 'noteOn', channel: 0, note: 40, velocity: 100 },
    { delta: 240, type: 'noteOff', channel: 0, note: 40, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 0, note: 40, velocity: 90 },
    { delta: 240, type: 'noteOff', channel: 0, note: 40, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 0, note: 45, velocity: 100 },
    { delta: 480, type: 'noteOff', channel: 0, note: 45, velocity: 0 },
    { delta: 0, type: 'pitchBend', channel: 0, value: 8192 + 64 },
    { delta: 480, type: 'pitchBend', channel: 0, value: 8192 },
    { delta: 0, type: 'eot' },
  ],
  [
    { delta: 0, type: 'program', channel: 9, program: 0 },
    { delta: 0, type: 'noteOn', channel: 9, note: 36, velocity: 127 },
    { delta: 240, type: 'noteOn', channel: 9, note: 42, velocity: 80 },
    { delta: 0, type: 'noteOn', channel: 9, note: 38, velocity: 100 },
    { delta: 240, type: 'noteOn', channel: 9, note: 42, velocity: 70 },
    { delta: 0, type: 'noteOn', channel: 9, note: 36, velocity: 110 },
    { delta: 240, type: 'noteOn', channel: 9, note: 42, velocity: 80 },
    { delta: 0, type: 'noteOn', channel: 9, note: 38, velocity: 96 },
    { delta: 240, type: 'noteOn', channel: 9, note: 42, velocity: 70 },
    { delta: 0, type: 'eot' },
  ],
];

const loopSong: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
    { delta: 0, type: 'program', channel: 1, program: 12 }, // marimba → tri family
    { delta: 0, type: 'noteOn', channel: 1, note: 64, velocity: 90 },
    { delta: 240, type: 'noteOff', channel: 1, note: 64, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 1, note: 67, velocity: 88 },
    { delta: 240, type: 'noteOff', channel: 1, note: 67, velocity: 0 },
    { delta: 0, type: 'noteOn', channel: 1, note: 71, velocity: 92 },
    { delta: 480, type: 'noteOff', channel: 1, note: 71, velocity: 0 },
    { delta: 0, type: 'tempo', usPerQuarter: 400_000 }, // mid-loop tempo map
    { delta: 0, type: 'eot' },
  ],
];

describe('audio goldens — SMF→synth golden songs (fixtures)', () => {
  const songs: [string, BuildEvent[][], number, number][] = [
    ['m10-song-fanfare', fanfare, 2.5, 1],
    ['m10-song-rock', rock, 3.5, 1],
    ['m10-song-loop2', loopSong, 4, 2],
  ];
  for (const [name, tracks, secs, loops] of songs) {
    musicGolden({
      name,
      kind: 'fixture',
      script: `hand-built SMF (smfBuild) → decodeSmf → planMusic → renderPlanOffline (${loops} cycle${loops > 1 ? 's' : ''}) @ ${SMF_SR} Hz; canonical+plan+checksum record`,
      smf: () => buildSmf({ format: 1, division: 480, tracks }),
      seconds: secs,
      sampleRate: SMF_SR,
      loops,
    });
  }
});

/* ------------------------------------------------------------------ */
/* C2. IWAD-gated music census (M10-08 correction: D_* are EMBEDDED     */
/*     OGGs — the golden is the lump census, not an SMF decode)         */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('audio goldens — IWAD music lump census (skipIf no wad)', () => {
  it('D_* census: named songs present', () => {
    const wad = iwad();
    for (const song of ['D_E1M1', 'D_INTER', 'D_VICTOR']) {
      expect(wad.has(song), song).toBe(true);
    }
  });

  audioGolden({
    name: 'm10-iwad-music-census',
    kind: 'iwad',
    script:
      'freedoom1.wad D_* lumps (dir order, zero-size excluded) → per-lump name/size/sha256/OGG-magic record; the M10-08-corrected music-in-WAD golden (SMF decode N/A — OGG containers)',
    sampleRate: 1,
    artifact: 'none',
    render: () => encodeRecord(dLumpCensus()),
  });
});

function dLumpCensus(): string {
  const wad = iwad();
  const lines: string[] = [];
  for (let i = 0; ; i++) {
    const num = wad.lumpNumAt(i);
    if (num < 0) break;
    const name = wad.lumpName(num);
    if (!name.startsWith('D_')) continue;
    const b = wad.readLump(num);
    if (b.length === 0) continue;
    const ogg = b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53;
    lines.push(`${i}\t${name}\t${b.length}\t${sha256Of(b)}\t${ogg ? 'OGGS' : 'RAW'}`);
  }
  lines.push(`wad=${iwadSha256()}`);
  return lines.join('\n');
}

/** Lossless text → Int16 artifact encoding (NUL-terminated). */
function encodeRecord(text: string): Int16Array {
  const bytes = Buffer.from(text + '\u0000', 'utf8');
  const mix = new Int16Array(Math.ceil(bytes.length / 2));
  new Uint8Array(mix.buffer).set(bytes);
  return mix;
}

/* ------------------------------------------------------------------ */
/* Engine self-checks (not goldens — law/consistency assertions)        */
/* ------------------------------------------------------------------ */

describe('audio goldens — engine self-checks', () => {
  it('renderScript reproduces renderMix byte-for-byte on a stop-free scene', () => {
    const script = {
      events: [
        { tic: 1, id: 20, x: 512 * FU, y: 0, origin: 60 },
        { tic: 7, id: 1, x: 0, y: -300 * FU, origin: 61 },
      ],
      listener: [
        { tic: 1, x: 0, y: 0, angle: 0 },
        { tic: 10, x: FU, y: FU, angle: 0x2000_0000 },
      ],
      buffers: BUF,
      frames: SR,
    };
    const a = renderScript(script, SR);
    const b = renderMix(script, SR);
    expect(mixToBytes(a).equals(mixToBytes(b))).toBe(true);
    expect(mixHash(a)).toBe(mixHash(b));
  });

  it('the multi-sum scene hits BOTH clamp extremes (0x7fff and −0x8000)', () => {
    const mix = renderMix(
      {
        events: [1, 4, 20, 22, 25, 32, 35, 82].map((id, i) => ({
          tic: 1,
          id,
          x: 0,
          y: 0,
          origin: 50 + i,
        })),
        buffers: BUF,
        frames: 4096,
      },
      SR,
    );
    const p = peakAbs(mix);
    expect(p.max).toBe(0x7fff);
    expect(p.min).toBe(-0x8000);
  });

  it('toFloat32 is the exact /32768 view of the Int16 golden bytes', () => {
    const mix = renderMix(
      { events: [{ tic: 1, id: 1, x: 0, y: 0, origin: 90 }], buffers: BUF, frames: 2048 },
      SR,
    );
    const f = toFloat32(mix);
    for (let i = 0; i < mix.length; i += 977) expect(f[i]).toBe(mix[i]! / 32768);
  });

  it('mixHash is FNV-1a over the little-endian Int16 bytes', () => {
    const mix = renderMix(
      { events: [{ tic: 1, id: 25, x: 0, y: 0, origin: 91 }], buffers: BUF, frames: 1024 },
      SR,
    );
    expect(mixHash(mix)).toBe(fnvRef(mixToBytes(mix)));
  });
});

function fnvRef(bytes: Buffer): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
