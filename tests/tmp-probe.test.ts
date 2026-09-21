import { describe, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { WadFile } from '../src/wad/wadfile';
import { loadMap } from '../src/wad/mapdata';
import { buildMapFromData } from '../src/sim/map';
import { gInitGame, gTicker } from '../src/sim/game';
import { pTeleportMove } from '../src/sim/pmap';
import { emptyInput } from '../src/sim/ticcmd';
const CK = 0x400000;
const AMB = 32;
function boot() {
  const bytes = readFileSync('wads/freedoom1.wad');
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
}
describe('probe11', () => {
  it('noise-wake sweep', () => {
    const out: any[] = [];
    const spots: [number, number, number][] = [
      [944, -450, 270], [944, -450, 90], [848, 500, 270], [896, 1600, 270],
      [752, 700, 270], [1104, -400, 270], [896, 1700, 90], [544, 1000, 270]
    ];
    for (const [x, y, deg] of spots) {
      const s = boot();
      const p = s.players[0]!;
      for (let t = 1; t <= 40; t++) gTicker(s, emptyInput());
      pTeleportMove(s.pmap, p.mo, x << 16, y << 16); p.mo.z = p.mo.floorz;
      p.mo.angle = Math.floor(deg / 360 * 4294967296) >>> 0;
      for (let t = 1; t <= 30; t++) gTicker(s, emptyInput());
      const pre = s.mobjs.mobjs.filter((m) => !m.removed && (m.flags & CK) !== 0 && m.type !== 30 && m.health > 0 && m.target && (m.flags & AMB) === 0);
      for (let t = 1; t <= 80; t++) gTicker(s, { ...emptyInput(), attack: true });
      const post = s.mobjs.mobjs.filter((m) => !m.removed && (m.flags & CK) !== 0 && m.type !== 30 && m.health > 0 && m.target && (m.flags & AMB) === 0 && m.state !== 174 && m.state !== 175 && m.state !== 207 && m.state !== 208 && m.state !== 442 && m.state !== 443 && m.state !== 475 && m.state !== 476);
      out.push({ spot: `${x},${y} d${deg}`, preWake: pre.map((m) => `${m.type}@${m.x >> 16},${m.y >> 16}`), wokeAfterFire: post.map((m) => `${m.type}@${m.x >> 16},${m.y >> 16}s${m.state} md${m.movedir}`), hp: p.health, kills: p.killcount });
    }
    writeFileSync('tmp-probe.json', JSON.stringify(out, null, 1));
  });
});
