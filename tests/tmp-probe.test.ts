import { describe, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { WadFile } from '../src/wad/wadfile';
import { loadMap } from '../src/wad/mapdata';
import { buildMapFromData } from '../src/sim/map';
import { gInitGame, gTicker } from '../src/sim/game';
import { pTeleportMove } from '../src/sim/pmap';
import { emptyInput } from '../src/sim/ticcmd';
import { hashState } from '../src/sim/state';
const ANG0 = 0;
describe('probe6', () => {
  it('fire-at-spawn long run', () => {
    const bytes = readFileSync('wads/freedoom1.wad');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
    const mons = () => s.mobjs.mobjs.filter((m) => !m.removed && m.health > 0 && (m.flags & 0x400000) !== 0 && m.type !== 30);
    const out: any = { fire: [] as any[] };
    for (let t = 1; t <= 1400; t++) {
      gTicker(s, { ...emptyInput(), attack: true });
      const awake = mons().filter((m) => m.target).length;
      if (t % 100 === 0 || (awake > 0 && !out.fireWake)) {
        out.fire.push({ t, hp: s.players[0]!.health, awake, kills: s.players[0]!.killcount, ammo: (s.players[0] as any).ammo?.[0] });
        if (awake > 0 && !out.fireWake) out.fireWake = t;
      }
      if (out.fire.length > 30) break;
    }
    writeFileSync('tmp-probe.json', JSON.stringify(out, null, 1));
  });
  it('close-kill scenario', () => {
    const bytes = readFileSync('wads/freedoom1.wad');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
    const p = s.players[0]!;
    pTeleportMove(s.pmap, p.mo, 640 << 16, 336 << 16);
    p.mo.z = p.mo.floorz;
    p.mo.angle = ANG0;
    const out: any = { t0: { hp: p.health, kills: p.killcount, pos: [p.mo.x >> 16, p.mo.y >> 16] }, log: [] as any[], dead: null as any, hashA: 0, hashB: 0 };
    let killedTic = -1;
    for (let t = 1; t <= 400; t++) {
      gTicker(s, { ...emptyInput(), attack: true });
      const near = s.mobjs.mobjs.filter((m) => !m.removed && m.type === 1 && m.x >> 16 > 500 && m.x >> 16 < 1100 && Math.abs((m.y >> 16) - 336) < 200);
      if (t % 20 === 0) out.log.push({ t, hp: p.health, kills: p.killcount, near: near.map((m) => `${m.x >> 16},${m.y >> 16}s${m.state}h${m.health}`) });
      if (p.killcount > 0 && killedTic < 0) killedTic = t;
      if (killedTic > 0 && t === killedTic + 60) {
        const c = s.mobjs.mobjs.find((m) => m.type === 1 && m.health <= 0 && !m.removed);
        if (c) out.dead = { x: c.x >> 16, y: c.y >> 16, s: c.state, flags: c.flags, h: c.health };
        break;
      }
    }
    out.killedTic = killedTic;
    out.hashA = hashState(s);
    writeFileSync('tmp-probe-kill.json', JSON.stringify(out, null, 1));
  });
});
