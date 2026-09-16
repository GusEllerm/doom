/**
 * Installs window.__doom (typed no-op stubs until the engine parts exist).
 * Active in dev builds or when the page URL contains ?test=1.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import type { CaptureResult, DebugStateSnapshot, DoomDebugApi } from './types/debug';

const RENDER_WIDTH = 320;
const RENDER_HEIGHT = 200;

function notReady(note: string): never {
  throw new Error(`debug API not implemented yet: ${note}`);
}

let godMode = false;
let noclip = false;
let paused = false;

const api: DoomDebugApi = {
  loadMap(mapName: string): void {
    notReady(`loadMap(${mapName})`);
  },
  warp(): void {
    notReady('warp()');
  },
  god(enabled?: boolean): boolean {
    if (enabled !== undefined) godMode = enabled;
    return godMode;
  },
  noclip(enabled?: boolean): boolean {
    if (enabled !== undefined) noclip = enabled;
    return noclip;
  },
  step(): void {
    notReady('step()');
  },
  pause(next?: boolean): boolean {
    if (next !== undefined) paused = next;
    return paused;
  },
  state(): DebugStateSnapshot {
    return { ready: false, note: 'scaffold stub: no simulation yet' };
  },
  capture(): CaptureResult {
    return {
      width: RENDER_WIDTH,
      height: RENDER_HEIGHT,
      indices: new Uint8Array(RENDER_WIDTH * RENDER_HEIGHT),
    };
  },
};

declare global {
  interface Window {
    __doom?: DoomDebugApi;
  }
}

export function installDebugApi(): void {
  const wantDebug = import.meta.env.DEV || new URLSearchParams(location.search).has('test');
  if (!wantDebug) return;
  window.__doom = api;
}
