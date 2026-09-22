import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gDeferedInitNew, gInitGame, gTicker, registerGameFlowHooks } from '../../src/sim/game';
import { censusThings } from '../fixtures/m8Fixtures';
import { subsectorAt } from '../../src/sim/bsp';
import { MF } from '../../src/wad/info/mobjinfo';

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

describe('B-10 scratch', () => {
  it('per-skill census + position validity', () => {
    const buf = readFileSync(new URL('../../wads/freedoom1.wad', import.meta.url));
    const wad = WadFile.parse(toArrayBuffer(buf));
    const md = loadMap(wad, 'E1M1');
    const rows: string[] = [];
    for (const internal of [0, 1, 2, 3, 4]) {
      const cen = censusThings(wad, 'E1M1', internal);
      const hostiles = new Map<number, number>();
      for (const [dn, n] of cen.aliveByDoomednum) {
        // monster doomednums present in E1M1 census
        if ([3001, 3002, 3003, 3004, 3005, 3006, 3009, 9, 58, 3001].includes(dn)) hostiles.set(dn, n);
      }
      rows.push(`skill0=${internal} bit=${internal <= 1 ? 1 : internal >= 3 ? 4 : 2} ` + JSON.stringify([...hostiles.entries()].sort((a, b) => a[0] - b[0])));
    }
    console.log('\n' + rows.join('\n'));
    // spawn-position validity at internal 2 (default) and 3 (hard)
    for (const raw of [3, 4]) {
      registerGameFlowHooks({ levelLoader: () => buildMapFromData(md) });
      const st = gInitGame(buildMapFromData(loadMap(wad, 'E1M1')), 2);
      gDeferedInitNew(st, raw, 1, 1);
      gTicker(st);
      let bad = 0, total = 0;
      for (const m of st.mobjs.slotMobjs.values()) {
        if (m.removed || (m.flags & MF.MF_COUNTKILL) === 0) continue;
        total++;
        const ss = subsectorAt(st.map, m.x >> 16, m.y >> 16);
        const sec = st.map.subsectors.sector[ss];
        if (!Number.isFinite(m.x) || !Number.isFinite(m.y) || sec === undefined || ss < 0) bad++;
      }
      console.log(`raw=${raw} monsters=${total} badPos=${bad} unknownDrops=${(st.mobjs as unknown as { unknownDoomednums?: number[] }).unknownDoomednums?.length ?? 'n/a'}`);
    }
    expect(true).toBe(false);
  });
});
