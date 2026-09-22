/**
 * Scratch trace (task/BUG-display triage) — DELETE after diagnosis.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { screens } from '../../src/render/vvideo';
import { stFaceIndex } from '../../src/ui/statusbar';
import { viewSize } from '../../src/render/view';

writeFileSync('/tmp/doom-trace.txt', '');
const say = (s: string): void => { appendFileSync('/tmp/doom-trace.txt', s + '\n'); };
import { createLiveSoak, hasWad, resetSoakModules } from './harness';

describe.skipIf(!hasWad)('scratch trace', () => {
  beforeAll(() => resetSoakModules());

  it('idle 800-tic soak: window/bar/face hashes + border stats', () => {
    const s = createLiveSoak();
    const rows: string[] = [];
    for (let i = 0; i < 800; i += 1) {
      const f = s.cycle(1);
      if (i % 50 === 0 || i < 6) {
        rows.push(
          `t=${String(f.tic).padStart(3)} bank=${f.bank} border=${f.borderDraws} erase=${f.eraseBytes} ` +
            `fb=${f.fbSha} win=${f.windowSha} bar=${f.barSha} face=${f.faceSha} vh=${f.display.viewheight}`
        );
      }
    }
    say(rows.join('\n'));
    expect(rows.length).toBeGreaterThan(10);
  });

  it('damage flash return over 200 tics', () => {
    const s = createLiveSoak();
    s.cycle(5);
    s.injectDamage(80);
    const banks: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const f = s.cycle(1);
      if (i % 20 === 0) banks.push(`t=${f.tic} bank=${f.bank} rgba=${f.screenRgbaSha.slice(0, 8)}`);
    }
    const p = s.state.players[0] as unknown as { damagecount: number };
    say(banks.join('\n') + '\nfinal damagecount = ' + p.damagecount);
  });

  it('B-06 face probe: face rect vs BG canvas rect across frames', () => {
    const s = createLiveSoak();
    const lines: string[] = [];
    const bg = screens[4]!;
    for (let i = 0; i < 120; i += 1) {
      s.cycle(1);
      if (i % 10 === 0) {
        let diff = 0;
        for (let y = 0; y < 32; y += 1) {
          for (let x = 0; x < 32; x += 1) {
            if (s.fb.indices[(168 + y) * 320 + 143 + x] !== bg.data[y * 320 + x]) diff += 1;
          }
        }
        lines.push(`t=${String(i + 1).padStart(3)} faceDiffersFromBG=${diff}/1024`);
      }
    }
    say(lines.join('\n'));
  });

  it('B-01 moving camera erosion + per-frame face probe', () => {
    const s = createLiveSoak();
    const back = screens[1]!;
    const lines: string[] = [];
    const { viewwindowx: wx, viewwindowy: wy, viewwidth: w, viewheight: h } = viewSize();
    // Largest inset k such that the k-pixel rim INSIDE the window is NOT
    // pure back-screen content (border eating inward shrinks k over time).
    const insetClear = (): number => {
      for (let k = 0; k < Math.min(w, h) / 2; k += 1) {
        let borderish = 0;
        let total = 0;
        for (let y = k; y < h - k; y += 1) {
          for (const x of [k, w - 1 - k]) {
            total += 1;
            if (s.fb.indices[(wy + y) * 320 + wx + x] === back.data[(wy + y) * 320 + wx + x]) borderish += 1;
          }
        }
        for (let x = k; x < w - k; x += 1) {
          for (const y of [k, h - 1 - k]) {
            total += 1;
            if (s.fb.indices[(wy + y) * 320 + wx + x] === back.data[(wy + y) * 320 + wx + x]) borderish += 1;
          }
        }
        if (borderish / total > 0.9) return k;
      }
      return Math.min(w, h) / 2;
    };
    const faceDiff = (): number => {
      const bg = screens[4]!;
      let diff = 0;
      for (let y = 0; y < 32; y += 1) {
        for (let x = 0; x < 32; x += 1) {
          if (s.fb.indices[(168 + y) * 320 + 143 + x] !== bg.data[y * 320 + x]) diff += 1;
        }
      }
      return diff;
    };
    // Walk forward 6 s, turn 6 s, walk back — with REAL boolean inputs.
    s.setInput((t) => ({
      ...{
        turnLeft: false, turnRight: false, forward: false, backward: false,
        strafeLeft: false, strafeRight: false, strafe: false, speed: false,
        attack: false, use: false, mouseX: 0, mouseY: 0
      },
      forward: t < 210 ? true : t > 3000 ? false : false,
      backward: t > 3000,
      turnRight: t >= 210 && t < 420
    }));
    let faceZeroStreak = 0;
    let worstStreak = 0;
    for (let i = 0; i < 4000; i += 1) {
      s.cycle(1);
      const fd = faceDiff();
      if (fd === 0) {
        faceZeroStreak += 1;
        worstStreak = Math.max(worstStreak, faceZeroStreak);
      } else faceZeroStreak = 0;
      if (i % 400 === 0) {
        const f = s.frames[s.frames.length - 1]!;
        const p = s.state.players[0]!;
        lines.push(`t=${String(i).padStart(4)} insetClear=${insetClear()} erase=${f.eraseBytes} bd=${f.borderDraws} win=${f.windowSha} faceDiff=${fd} faceIdx=${stFaceIndex()} px=${p.mo.x >> 16} py=${p.mo.y >> 16}`);
      }
    }
    say(lines.join('\n') + `\nmaxConsecutiveFaceEraseFrames=${worstStreak + 1}`);
  });
});
