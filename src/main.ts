import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { BUF_W, BUF_H } from './render/raycaster';
import { makeFloorTexture, makeCeilingTexture } from './render/textureCache';
import { renderHUD, type HUDState } from './render/hud';
import { renderViewmodel } from './render/viewmodel';
import { fireHitscan } from './entities/weapons';
import { renderTitle, renderDeath, renderWin, renderPause, renderLevelIntro, tickEmbers, renderControlsOverlay } from './render/screens';
import { telemetry } from './engine/telemetry';
import { debug, recordFrame, renderDebug } from './render/debug';
import { loadAssets } from './engine/assets';
import { manifest, tileTextureKey } from './assets/manifest';
import { Game } from './game/state';
import { LEVELS } from './world/levels';
import { updatePickups } from './world/triggers';
import { AudioMixer } from './engine/audio';
import { Menu } from './game/menu';
import { createWorld } from './render3d/world';
import { SpritePool } from './render3d/sprites';

const world = document.getElementById('world') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = overlay.getContext('2d')!;
overlay.width = BUF_W;
overlay.height = BUF_H;
ctx.imageSmoothingEnabled = false;

const params = new URLSearchParams(location.search);
const HEADLESS = params.get('headless') === '1';
const AUTO_START = params.get('start') === '1' || HEADLESS;

const assets = loadAssets(manifest);
const input = new Input();
// All input listens on the overlay canvas so cursor/pointer-lock is consistent.
input.install(overlay, { headless: HEADLESS });
const audio = new AudioMixer();
const game = new Game(LEVELS);

const renderer3d = createWorld(world);
const spritePool = new SpritePool(renderer3d.spriteLayer);

// Convert the procedural floor/ceiling buffers into HTMLImageElements
// (the three.js renderer takes <img>, not raw pixel arrays).
function rawToImage(raw: { w: number; h: number; data: Uint8ClampedArray }): HTMLImageElement {
  const c = document.createElement('canvas');
  c.width = raw.w; c.height = raw.h;
  const g = c.getContext('2d')!;
  const id = g.createImageData(raw.w, raw.h);
  id.data.set(raw.data);
  g.putImageData(id, 0, 0);
  const img = new Image();
  img.src = c.toDataURL();
  return img;
}
const floorImg = rawToImage(makeFloorTexture());
const ceilingImg = rawToImage(makeCeilingTexture());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer3d.setSize(w, h);
}
addEventListener('resize', resize);
resize();

const hud: HUDState = {
  damageFlash: 0,
  pickupFeed: [],
  hurtFlashT: 0,
  hoveredEnemy: false,
  killCount: 0,
  hitMarkerT: 0,
  wallSparkT: 0,
};

const PICKUP_LABEL: Record<string, string> = {
  health: '+25 HEALTH',
  armor: '+25 ARMOR',
  pistol_ammo: '+20 BULLETS',
  shotgun_ammo: '+6 SHELLS',
};

type TitleAction = 'play' | 'controls';
type PauseAction = 'resume' | 'restart' | 'controls' | 'title';
const titleMenu = new Menu<TitleAction>([
  { label: 'NEW GAME', action: 'play' },
  { label: 'CONTROLS', action: 'controls' },
]);
const pauseMenu = new Menu<PauseAction>([
  { label: 'RESUME',         action: 'resume' },
  { label: 'RESTART LEVEL',  action: 'restart' },
  { label: 'CONTROLS',       action: 'controls' },
  { label: 'QUIT TO TITLE',  action: 'title' },
]);
let showControls = false;

let runStartTime = 0;
let shotsFiredCount = 0;
let shotsHitCount = 0;
let activeLevelIndex = -1;

declare global {
  interface Window {
    __game?: Game;
    __input?: Input;
    __audio?: AudioMixer;
    __level?: () => unknown;
    __telemetry?: typeof telemetry;
    __events?: () => unknown;
    __metrics?: () => unknown;
    __debug?: typeof debug;
    __menu?: { title: Menu; pause: Menu };
  }
}
window.__game = game;
window.__input = input;
window.__audio = audio;
window.__telemetry = telemetry;
window.__events = () => telemetry.all();
window.__metrics = () => telemetry.derive();
window.__debug = debug;
window.__menu = { title: titleMenu, pause: pauseMenu };

addEventListener('keydown', (e) => {
  if (e.code === 'F1') { debug.enabled = !debug.enabled; e.preventDefault(); }
  if (e.code === 'KeyQ' && HEADLESS) { debug.enabled = !debug.enabled; }
});

window.__level = () => game.active ? {
  name: game.active.level.name,
  width: game.active.level.width,
  height: game.active.level.height,
  enemiesAlive: game.active.enemies.length,
  pickupsRemaining: game.active.pickups.filter((p) => !p.taken).length,
} : null;

const depth = new Float32Array(BUF_W); // legacy slot for debug overlay

const textureFor = (tile: number) => assets.texture(tileTextureKey[tile] ?? 'brick');

function wirePlayerEvents() {
  game.player.events = {
    onFire: (slot) => {
      audio.playSfx(slot === 0 ? 'pistol' : 'shotgun');
      hud.wallSparkT = 0.18;
      shotsFiredCount++;
    },
    onHit: () => {
      audio.playSfx('enemy_hit');
      hud.hitMarkerT = 0.25;
      hud.wallSparkT = 0;
      shotsHitCount++;
    },
    onKill: (e) => { audio.playSfx(e.kind === 'imp' ? 'enemy_death_imp' : 'enemy_death_grunt'); hud.killCount++; },
    onDryFire: () => audio.playSfx('dryfire'),
  };
}
wirePlayerEvents();

let fps = 0, frames = 0, fpsAcc = 0;
let levelIntroT = 0;
let lastLevelIdx = -1;
let menuKeyState = { up: false, down: false, confirm: false };

function onLevelStart() {
  lastLevelIdx = game.levelIndex;
  levelIntroT = 2.5;
  audio.startMusic();
  wirePlayerEvents();
  if (game.active) {
    telemetry.push({
      type: 'level_start',
      t: performance.now() / 1000,
      level: game.active.level.name,
      index: game.levelIndex,
    });
    for (const e of game.active.enemies) {
      e['events' as never] = { onPlayerHit: (d: number) => game.player.takeDamage(d, e.kind) } as never;
    }
    if (activeLevelIndex !== game.levelIndex) {
      activeLevelIndex = game.levelIndex;
      renderer3d.setLevel(game.active.level, game.active.doors, {
        textureFor,
        floor: floorImg,
        ceiling: ceilingImg,
      });
      spritePool.clear();
    }
  }
}

function startNewRun() {
  game.start();
  hud.killCount = 0;
  hud.pickupFeed = [];
  runStartTime = performance.now() / 1000;
  shotsFiredCount = 0;
  shotsHitCount = 0;
  activeLevelIndex = -1; // force scene rebuild
  onLevelStart();
}

if (!HEADLESS) {
  overlay.addEventListener('click', () => audio.init(), { once: true });
}
if (AUTO_START) {
  if (!HEADLESS) audio.init();
  startNewRun();
  if (HEADLESS) input.paused = false;
}

function enterPlay() {
  input.wantsPointerLock = true;
  if (!HEADLESS) {
    input.paused = false;
    try { overlay.requestPointerLock(); } catch { /* */ }
  }
}

// Menu input
function pollMenuInput(menu: Menu): 'confirm' | null {
  const up = input.isDown('ArrowUp') || input.isDown('KeyW');
  const down = input.isDown('ArrowDown') || input.isDown('KeyS');
  const confirm = input.isDown('Enter') || input.isDown('Space') || input.isDown('KeyF');
  let result: 'confirm' | null = null;
  if (up && !menuKeyState.up) menu.prev();
  if (down && !menuKeyState.down) menu.next();
  if (confirm && !menuKeyState.confirm) result = 'confirm';
  menuKeyState = { up, down, confirm };
  if (menuMouseRow !== null) {
    menu.select(menuMouseRow);
    if (menuMouseClicked) { menuMouseClicked = false; result = 'confirm'; }
  } else if (menuMouseClicked) {
    menuMouseClicked = false;
  }
  return result;
}

let menuMouseRow: number | null = null;
let menuMouseClicked = false;
function bufCoords(ev: MouseEvent): { x: number; y: number } {
  const rect = overlay.getBoundingClientRect();
  const sx = overlay.width / rect.width;
  const sy = overlay.height / rect.height;
  return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
}
overlay.addEventListener('mousemove', (ev) => {
  if (!isMenuPhase()) return;
  const { x, y } = bufCoords(ev);
  const menu = activeMenu();
  menuMouseRow = menu ? menu.hitTest(x, y) : null;
});
overlay.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (!isMenuPhase()) return;
  const { x, y } = bufCoords(ev);
  const menu = activeMenu();
  const row = menu ? menu.hitTest(x, y) : null;
  if (row !== null && menu) {
    menu.select(row);
    menuMouseClicked = true;
    const action = menu.list[row]?.action;
    if ((action === 'play' || action === 'resume' || action === 'restart') && !HEADLESS) {
      try { overlay.requestPointerLock(); } catch { /* */ }
    }
  }
});

function isMenuPhase(): boolean {
  if (showControls) return true;
  if (game.phase === 'title') return true;
  if (input.paused && game.phase === 'playing') return true;
  return false;
}
function activeMenu(): Menu | null {
  if (showControls) return null;
  if (game.phase === 'title') return titleMenu;
  if (input.paused && game.phase === 'playing') return pauseMenu;
  return null;
}

function makeEndStats(levelName: string) {
  return {
    killCount: hud.killCount,
    shotsFired: shotsFiredCount,
    shotsHit: shotsHitCount,
    timeSeconds: performance.now() / 1000 - runStartTime,
    levelName,
  };
}

let lastFrameStart = 0;

// Sync the three.js camera to player state.
function syncCamera() {
  if (!game.active) return;
  renderer3d.camera.position.set(game.player.x, 0.5, game.player.y);
  // World yaw: in our 2D math, angle=0 means facing +x. In three.js, we want
  // the camera to look along +x at angle 0 too. Camera yaw in YXZ order with
  // y rotation: -π/2 looks along +x. So camera.rotation.y = -angle - π/2.
  renderer3d.camera.rotation.set(game.player.pitch, -game.player.angle - Math.PI / 2, 0);
}

startLoop(
  (dt) => {
    const frameStart = performance.now();
    if (lastFrameStart > 0) {
      const gap = frameStart - lastFrameStart;
      recordFrame(gap);
      if (gap > 33) telemetry.push({ type: 'frame_slow', t: frameStart / 1000, ms: gap });
    }
    lastFrameStart = frameStart;
    game.time += dt;
    tickEmbers(dt);
    if (levelIntroT > 0) levelIntroT -= dt;

    if (showControls) {
      input.wantsPointerLock = false;
      const closeKey = input.isDown('Escape') || input.isDown('Enter');
      if (closeKey && !menuKeyState.confirm) showControls = false;
      if (menuMouseClicked) { menuMouseClicked = false; showControls = false; }
      menuKeyState = { up: false, down: false, confirm: closeKey };
      return;
    }

    if (game.phase === 'title') {
      input.wantsPointerLock = false;
      const confirm = pollMenuInput(titleMenu);
      if (confirm === 'confirm') {
        const action = titleMenu.activate();
        if (action === 'play') { audio.init(); startNewRun(); enterPlay(); }
        else if (action === 'controls') showControls = true;
      }
      return;
    }
    if (game.phase === 'dead') {
      const snap = input.snapshot();
      if (snap.fire) {
        game.restart();
        hud.killCount = 0; runStartTime = performance.now() / 1000;
        shotsFiredCount = 0; shotsHitCount = 0;
        activeLevelIndex = -1;
        onLevelStart();
      }
      return;
    }
    if (game.phase === 'win') {
      const snap = input.snapshot();
      if (snap.fire) { audio.stopMusic(); game.toTitle(); }
      return;
    }
    if (input.paused) {
      input.wantsPointerLock = false;
      const confirm = pollMenuInput(pauseMenu);
      if (confirm === 'confirm') {
        const action = pauseMenu.activate();
        if (action === 'resume') enterPlay();
        else if (action === 'restart') {
          game.restart();
          hud.killCount = 0; runStartTime = performance.now() / 1000;
          shotsFiredCount = 0; shotsHitCount = 0;
          activeLevelIndex = -1;
          onLevelStart();
          enterPlay();
        } else if (action === 'controls') showControls = true;
        else if (action === 'title') { audio.stopMusic(); game.toTitle(); }
      }
      return;
    }

    const snap = input.snapshot();
    const a = game.active!;
    const prevHp = game.player.health;
    game.player.update(dt, snap, a.level, a.enemies, a.doors);
    for (const e of a.enemies) e.update(dt, a.level, game.player, a.doors);
    for (let i = a.enemies.length - 1; i >= 0; i--) {
      if (a.enemies[i]!.dead) a.enemies.splice(i, 1);
    }
    updatePickups(a.pickups, game.player, {
      onPickup: (kind) => {
        audio.playSfx('pickup');
        hud.pickupFeed.push({ text: PICKUP_LABEL[kind] ?? kind, t: 2.0 });
      },
    });
    for (const m of hud.pickupFeed) m.t -= dt;
    hud.pickupFeed = hud.pickupFeed.filter((m) => m.t > 0);
    hud.hurtFlashT = Math.max(0, hud.hurtFlashT - dt * 2);
    hud.hitMarkerT = Math.max(0, hud.hitMarkerT - dt * 4);
    hud.wallSparkT = Math.max(0, hud.wallSparkT - dt * 6);

    {
      const dxLook = Math.cos(game.player.angle), dyLook = Math.sin(game.player.angle);
      const hit = fireHitscan(a.level, a.enemies, game.player.x, game.player.y, dxLook, dyLook);
      hud.hoveredEnemy = !!hit.enemy && hit.enemy.state !== 'dying';
    }
    a.doors.update(dt);
    renderer3d.updateDoors();

    const exitTile = a.level.tileAt(game.player.x, game.player.y);
    if (exitTile === 100) {
      const before = game.levelIndex;
      const moved = game.advanceLevel();
      if (moved && game.levelIndex !== before) {
        telemetry.push({ type: 'level_advance', t: performance.now() / 1000, from: before, to: game.levelIndex });
        onLevelStart();
      }
      if (!moved) audio.stopMusic();
    }

    if (game.player.health < prevHp) {
      hud.damageFlash = 1.0;
      hud.hurtFlashT = 0.5;
      audio.playSfx('player_hurt');
    }
    game.prevHealth = game.player.health;
    hud.damageFlash = Math.max(0, hud.damageFlash - dt * 2);

    if (game.player.health <= 0) {
      game.phase = 'dead';
      audio.stopMusic();
    }

    if (snap.interact) audio.playSfx('door');

    input.wantsPointerLock = game.phase === 'playing' && !showControls && !input.paused && !HEADLESS;
  },
  () => {
    // 3D world pass
    if (game.active && (game.phase === 'playing' || game.phase === 'dead')) {
      syncCamera();
      // Update sprite billboards
      const a = game.active;
      const entries: Array<{ id: string; x: number; y: number; img: HTMLImageElement; height: number; baseY?: number }> = [];
      a.enemies.forEach((e, i) => {
        entries.push({ id: `enemy-${i}`, x: e.x, y: e.y, img: assets.sprite(e.spriteKey), height: 0.85, baseY: 0.45 });
      });
      a.pickups.forEach((p, i) => {
        if (!p.taken) entries.push({ id: `pickup-${i}`, x: p.x, y: p.y, img: assets.sprite(p.spriteKey), height: 0.4, baseY: 0.25 });
      });
      spritePool.update(entries);
      renderer3d.render();
    } else {
      // Render a static black background through three.js so the world canvas
      // isn't stale/garbage on menu screens.
      renderer3d.renderer.clear();
    }

    // 2D overlay pass (HUD / viewmodel / screens)
    ctx.clearRect(0, 0, BUF_W, BUF_H);
    if (game.phase === 'title') {
      renderTitle(ctx, game.time, titleMenu);
    } else if (game.phase === 'win') {
      const a = game.active;
      renderWin(ctx, game.time, makeEndStats(a?.level.name ?? ''));
    } else if (game.active) {
      const a = game.active;
      renderViewmodel(ctx, game.player, game.time, assets);
      // The 2D debug overlay still works (minimap + frame graph) but the
      // hitbox circles are stale (they referenced raycaster screen coords).
      // Keep the minimap + frame graph; skip hitboxes inside the dispatcher
      // by passing an empty depth array — renderDebug handles that.
      renderDebug(ctx, a, game.player, depth, Math.PI / 3);
      renderHUD(ctx, game.player, hud, assets, a.level.name, game.time);
      if (levelIntroT > 0 && lastLevelIdx === game.levelIndex && !input.paused && game.phase !== 'dead') {
        renderLevelIntro(ctx, a.level.name, levelIntroT);
      }
      if (game.phase === 'dead') renderDeath(ctx, game.time, makeEndStats(a.level.name));
      else if (input.paused) renderPause(ctx, pauseMenu);
    }
    if (showControls) renderControlsOverlay(ctx);

    if (debug.enabled) {
      ctx.fillStyle = '#0f0';
      ctx.font = '10px monospace';
      ctx.fillText(`FPS ${fps}`, 4, 12);
    }
    frames++;
    fpsAcc += 1 / 60;
    if (fpsAcc >= 1) { fps = frames; frames = 0; fpsAcc = 0; }
  },
);
