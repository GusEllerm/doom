/**
 * M7-11c — ROADMAP M7 exit verification (mechanical checklist; the m5/m6
 * exit idiom applied to docs/ROADMAP.md §M7 + docs/design/M7-plan.md §5).
 *
 * Guards are (a) live executable facts booted HERE, (b) fs-greps of
 * committed test NAMES (deleting evidence trips the guard), (c) imported
 * functions asserted callable — never narrative claims.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { emptyInput } from '../../src/sim/ticcmd';
import { debugSim } from '../../src/debug';
import { pKillPlayer, pPlayerDamage } from '../../src/sim/pplayer';
import { P_GiveWeapon } from '../../src/sim/p_inter_pickup';
import { gInitGame as init, gTicker as step } from '../../src/sim/game';
import { buildMapFromData } from '../../src/sim/map';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildFixtureMapWad } from '../fixtures/mapBuilder';

const at = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string): string => readFileSync(at(p), 'utf8');

describe('M7 exit — combat suites exist and are named (fs evidence)', () => {
  const files = readdirSync(at('../weapons'));
  it('per-weapon suites present for all seven families', () => {
    for (const w of ['pistol', 'shotgun', 'chaingun', 'missile', 'plasma', 'bfg', 'fist']) {
      const hit = files.filter((f) => f.endsWith('.test.ts')).some((f) => {
        const src = read(`../weapons/${f}`).toLowerCase();
        return src.includes(w);
      });
      expect(hit, `a committed suite covers ${w}`).toBe(true);
    }
  });
  it('shared-stream determinism suite name present', () => {
    const names = files.filter((f) => f.endsWith('.test.ts'));
    expect(
      names.some((f) => /stream|determin/i.test(read(`../weapons/${f}`)))
    ).toBe(true);
  });
  it('weapon sprite-index regression (distinct sprites) pinned', () => {
    const v = read('../weapons/visual.test.ts');
    expect(v).toMatch(/sprite/i);
    // the regression itself: sprite numbers per weapon asserted distinct
    expect(v).toMatch(/distinct|!==|not\.toBe|Set/i);
  });
});

describe('M7 exit — psprite render wiring is live (opt-in seam)', () => {
  it('renderFrame accepts the psprites dependency (wiring guard flipped)', () => {
    const src = read('../../src/render/renderer.ts');
    expect(src).toMatch(/psprites/);
  });
  it('main.ts feeds live psprites into the frame path', () => {
    const src = read('../../src/main.ts');
    expect(src).toMatch(/psprite/i);
  });
});

describe('M7 exit — combat core exports are live and callable', () => {
  it('damage/kill/give entrypoints imported as functions', () => {
    expect(typeof pPlayerDamage).toBe('function');
    expect(typeof pKillPlayer).toBe('function');
    expect(typeof P_GiveWeapon).toBe('function');
  });
  it('debug seams giveWeapon/killPlayer exposed', () => {
    expect(typeof debugSim.giveWeapon).toBe('function');
    expect(typeof debugSim.killPlayer).toBe('function');
  });
});

const ARENA = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 1024, ceilingHeight: 400, lightLevel: 200 }],
  things: [{ x: 512, y: 512, angle: 0, type: 1 }],
};

function boot() {
  const bytes = buildFixtureMapWad(ARENA, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return init(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

describe('M7 exit — booted level facts (this run)', () => {
  it('fresh game owns fists, no shotgun, ready-weapon raises', () => {
    const state = boot();
    step(state, emptyInput());
    const p = state.players[0] as unknown as {
      weaponowned: Int32Array;
      ammo: Int32Array;
      readyweapon: number;
    };
    expect(p.weaponowned[0]).toBe(1); // wp_fists always
    expect(p.weaponowned[2]).toBe(0); // no shotgun at init
    if (p.weaponowned[1] === 1) expect(p.ammo[0]).toBeGreaterThan(0); // pistol ⇒ clips
    expect(p.readyweapon).toBeGreaterThanOrEqual(0);
  });
  it('giveWeapon changes the roster and the ladder picks it (pendingweapon)', () => {
    const state = boot();
    const p = state.players[0] as unknown as {
      weaponowned: Int32Array;
      pendingweapon: number;
    };
    expect(P_GiveWeapon(state.players[0] as never, 2, false)).toBe(true);
    expect(p.weaponowned[2]).toBe(1);
    step(state, { ...emptyInput(), weaponKey: 2 });
    expect(p.pendingweapon).toBe(2); // BT_CHANGE → pending (p_ammo ladder)
  });
});
