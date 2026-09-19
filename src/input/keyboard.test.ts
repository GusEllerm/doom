/**
 * input/keyboard tests (M2-07): held-key semantics — the faithful model of
 * g_game.c gamekeydown[] (keydown sets, keyup clears, repeats are harmless
 * re-stores of true; G_BuildTiccmd polls per tic). Also multi-binding
 * release safety, focus-loss clear and attach/detach wiring.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { createKeyboardInput, type KeyboardEventLike } from './keyboard';
import { gBuildTiccmd } from '../sim/ticcmd';
import type { KeyBinding } from './mapping';

/** Minimal event bus satisfying KeyboardTargetLike in the node env. */
class FakeTarget {
  private readonly handlers = new Map<string, ((e: KeyboardEventLike) => void)[]>();
  readonly prevented: string[] = [];

  addEventListener(type: 'keydown' | 'keyup', h: (e: KeyboardEventLike) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(h);
    this.handlers.set(type, list);
  }
  removeEventListener(type: 'keydown' | 'keyup', h: (e: KeyboardEventLike) => void): void {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(type, list.filter((g) => g !== h));
  }
  emit(type: 'keydown' | 'keyup', code: string, repeat = false): void {
    let prevented = false;
    const e: KeyboardEventLike = {
      code,
      repeat,
      preventDefault: () => {
        prevented = true;
      }
    };
    for (const h of this.handlers.get(type) ?? []) h(e);
    if (prevented) this.prevented.push(code);
  }
  get listenerCount(): number {
    let n = 0;
    for (const list of this.handlers.values()) n += list.length;
    return n;
  }
}

describe('createKeyboardInput held-key state', () => {
  it('keydown sets the action, keyup clears it', () => {
    const k = createKeyboardInput();
    k.keyDown('KeyW');
    expect(k.isDown('forward')).toBe(true);
    expect(k.sample().forward).toBe(true);
    k.keyUp('KeyW');
    expect(k.isDown('forward')).toBe(false);
    expect(k.sample().forward).toBe(false);
  });

  it('auto-repeat keydowns are no-ops (vanilla re-store of gamekeydown=true)', () => {
    const k = createKeyboardInput();
    k.keyDown('ArrowRight');
    k.keyDown('ArrowRight'); // OS repeat
    k.keyDown('ArrowRight');
    expect(k.downCount()).toBe(1);
    k.keyUp('ArrowRight');
    expect(k.isDown('turnRight')).toBe(false);
  });

  it('sample() feeds G_BuildTiccmd: held keys become exact ticcmd fields', () => {
    const k = createKeyboardInput();
    k.keyDown('ArrowRight');
    k.keyDown('KeyW');
    const turn = { turnheld: 0 };
    const cmd1 = gBuildTiccmd(k.sample(), turn);
    expect(cmd1.forwardmove).toBe(25); // FORWARDMOVE[0]
    expect(cmd1.angleturn).toBe(-320); // ANGLETURN[2] slow ramp (turnheld 1 < 6)
    for (let i = 0; i < 5; i++) gBuildTiccmd(k.sample(), turn); // turnheld → 6
    const cmd2 = gBuildTiccmd(k.sample(), turn);
    expect(cmd2.angleturn).toBe(-640); // ramp done: normal turn speed, right = negative
    k.keyUp('ArrowRight');
    k.keyDown('ShiftRight');
    expect(gBuildTiccmd(k.sample(), turn).forwardmove).toBe(50); // run
  });

  it('unbound codes are ignored entirely', () => {
    const k = createKeyboardInput();
    k.keyDown('KeyQ');
    k.keyUp('KeyQ');
    expect(k.downCount()).toBe(0);
    expect(k.sample()).toEqual({
      forward: false,
      backward: false,
      turnLeft: false,
      turnRight: false,
      strafeLeft: false,
      strafeRight: false,
      strafe: false,
      speed: false,
      attack: false,
      use: false,
      // M5-07: keyboard-only snapshot ⇒ mouse channels idle (0 deltas).
      mouseX: 0,
      mouseY: 0
    });
  });

  it('two keys sharing an action: releasing one keeps the action held', () => {
    const k = createKeyboardInput();
    k.keyDown('KeyW');
    k.keyDown('ArrowUp'); // both bind `forward`
    k.keyUp('KeyW');
    expect(k.isDown('forward')).toBe(true);
    expect(k.downCount()).toBe(1);
    k.keyUp('ArrowUp');
    expect(k.isDown('forward')).toBe(false);
  });

  it('clear() zeroes everything (focus loss / level start)', () => {
    const k = createKeyboardInput();
    k.keyDown('KeyW');
    k.keyDown('ArrowRight');
    k.clear();
    expect(k.downCount()).toBe(0);
    expect(k.isDown('forward')).toBe(false);
    expect(k.isDown('turnRight')).toBe(false);
  });

  it('sample() feeds gBuildTiccmd-style consumers: arrows→turn, comma→strafe', () => {
    const k = createKeyboardInput();
    k.keyDown('ArrowRight');
    k.keyDown('Comma');
    const s = k.sample();
    expect(s.turnRight).toBe(true);
    expect(s.strafeLeft).toBe(true);
    expect(s.strafe).toBe(false); // modifier untouched
  });

  it('custom binding table overrides the defaults', () => {
    const bindings: readonly KeyBinding[] = [{ code: 'KeyE', action: 'use' }];
    const k = createKeyboardInput({ bindings });
    k.keyDown('KeyE');
    expect(k.isDown('use')).toBe(true);
    k.keyDown('Space'); // no longer bound
    expect(k.downCount()).toBe(1);
  });
});

describe('attach/detach', () => {
  it('routes real keydown/keyup events; bound codes get preventDefault', () => {
    const t = new FakeTarget();
    const k = createKeyboardInput();
    const detach = k.attach(t);
    t.emit('keydown', 'ArrowLeft');
    t.emit('keydown', 'KeyQ');
    expect(k.isDown('turnLeft')).toBe(true);
    expect(t.prevented).toEqual(['ArrowLeft']); // unbound not prevented
    t.emit('keyup', 'ArrowLeft');
    expect(k.isDown('turnLeft')).toBe(false);
    detach();
    expect(t.listenerCount).toBe(0);
  });

  it('detach clears stale held keys and stops routing', () => {
    const t = new FakeTarget();
    const k = createKeyboardInput();
    const off = k.attach(t);
    t.emit('keydown', 'KeyW');
    expect(k.isDown('forward')).toBe(true);
    off();
    expect(t.listenerCount).toBe(0);
    t.emit('keydown', 'KeyW');
    expect(k.isDown('forward')).toBe(false); // detached: no routing, state cleared
  });

  it('options.target auto-attaches at construction', () => {
    const t = new FakeTarget();
    const k = createKeyboardInput({ target: t });
    t.emit('keydown', 'KeyD');
    expect(k.isDown('strafeRight')).toBe(true);
  });
});
