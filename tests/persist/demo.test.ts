/**
 * persist/demo — M11-08 (task §M11-08-4, "demo+save interplay? per
 * plan"): the plan’s §M11-08 goal list tasks NO demo+save interplay
 * (record→replay identity is M11-06’s own golden), so this file proves
 * the ONE interplay the engine actually has, recorded in game.ts’s
 * G_BuildTiccmd comment: a save requested while RECORDING packs
 * BT_SPECIAL|BTS_SAVEGAME|(slot<<2) into the 4-byte demo ticcmd stream
 * (so a replay re-executes the save drain at the same tic — the sink
 * decides what that means), while a save requested during PLAYBACK is
 * inert (cmds come from the stream, never from G_BuildTiccmd — the
 * faithful vanilla lane: the replay hashes on untouched).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { GA, gSaveGame, gTicker } from '../../src/sim/game';
import { hashState } from '../../src/sim/state';
import { emptyInput } from '../../src/sim/ticcmd';
import {
  DEMO_HEADER_SIZE,
  demoBytes,
  demoPlaying,
  demoRecording,
  gDeferedPlayDemo,
  gRequestStopRecord,
  gStartRecordDemo,
  resetDemo
} from '../../src/sim/pDemo';
import {
  bootCorpus,
  corpusMap,
  registerLoader,
  resetM11,
  walkIn
} from '../fixtures/m11Scenarios';

beforeEach(() => {
  resetM11();
  resetDemo();
  registerLoader(() => corpusMap());
});

const script = (i: number) => ({
  ...walkIn(i),
  turnRight: i % 9 === 4,
  attack: i % 35 < 3
});

describe('M11-08 demo×save interplay (plan-minimal)', () => {
  it('a save requested while RECORDING rides the demo body as the BT_SPECIAL ticcmd', () => {
    const s = bootCorpus();
    gStartRecordDemo(s, 'm11x');
    const saveSlot = 6;
    gSaveGame(saveSlot, 'rides-demo');
    for (let i = 0; i < 30; i++) gTicker(s, script(i));
    gRequestStopRecord();
    gTicker(s, script(30));
    expect(demoRecording()).toBe(false);
    const bytes = demoBytes();
    expect(bytes).not.toBeNull();
    if (!bytes) return;
    // Chain: gSaveGame BEFORE the loop ⇒ the FIRST tic (index 0) PACKS
    // the special buttons (game.ts order: pack → G_WriteDemoTiccmd), the
    // same tic’s DECODE arms ga_savegame ⇒ tic 1 drains the capture.
    // Slot rides the vanilla BTS_SAVEMASK bits 2..4 (game.ts BTS_*).
    const packed = bytes[DEMO_HEADER_SIZE + 0 * 4 + 3]!;
    expect(packed & 0x80).toBe(0x80); // BT_SPECIAL
    expect(packed & 0x03).toBe(2); // BTS_SAVEGAME (port encoding, game.ts BTS_*)
    expect((packed & 0x1c) >> 2).toBe(saveSlot); // slot inside the 3-bit window
    // No other tic carries special buttons.
    for (let t = 1; t < (bytes.length - DEMO_HEADER_SIZE - 1) / 4; t++) {
      expect(bytes[DEMO_HEADER_SIZE + t * 4 + 3]! & 0x80, `tic ${t}`).toBe(0);
    }
  });

  it('a save requested during PLAYBACK is inert — the stream drives, hashes untouched', () => {
    // Record 60 tics (NO save requested: zero special bytes).
    const r = bootCorpus();
    gStartRecordDemo(r, 'm11p');
    const marks = [25, 50];
    const recHashes: number[] = [];
    for (let i = 0; i < 60; i++) {
      gTicker(r, script(i));
      if (marks.includes(i + 1)) recHashes.push(hashState(r));
    }
    gRequestStopRecord();
    gTicker(r, script(60));
    const bytes = demoBytes()!;
    for (let t = 0; t < (bytes.length - DEMO_HEADER_SIZE - 1) / 4; t++) {
      expect(bytes[DEMO_HEADER_SIZE + t * 4 + 3]! & 0x80, `tic ${t}`).toBe(0);
    }

    // Replay into a fresh world; at replay tic 20 request a save — the
    // playback branch never packs ⇒ never decodes ⇒ no drain, no world
    // effect (vanilla: cmds come from the stream, not G_BuildTiccmd).
    resetM11();
    registerLoader(() => corpusMap());
    const p = bootCorpus();
    gDeferedPlayDemo(p, bytes);
    expect(p.gameaction).toBe(GA.playdemo);
    const playHashes: number[] = [];
    for (let i = 0; i < 61; i++) {
      if (i === 19) gSaveGame(2, 'during-playback');
      gTicker(p, emptyInput());
      if (demoPlaying() && marks.includes(i + 1)) playHashes.push(hashState(p));
    }
    expect(demoPlaying()).toBe(false); // marker consumed by the 61st tic
    expect(playHashes).toEqual(recHashes);
  });
});
