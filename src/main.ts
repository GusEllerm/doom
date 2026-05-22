import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { renderScene, BUF_W, BUF_H } from './render/raycaster';
import { makeFloorTexture, makeCeilingTexture } from './render/textureCache';
import { renderSprites } from './render/sprites';
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

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
canvas.width = BUF_W;
canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;

const params = new URLSearchParams(location.search);
const HEADLESS = params.get('headless') === '1';
const AUTO_START = params.get('start') === '1' || HEADLESS;

const assets = loadAssets(manifest);
const input = new Input();
input.install(canvas, { headless: HEADLESS });
const audio = new AudioMixer();
const game = new Game(LEVELS);

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

// Menus
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

// Stats accumulator for end screens.
let runStartTime = 0;
let shotsFiredCount = 0;
let shotsHitCount = 0;

declare global {
  interface Window {
    __game?: Game;
    __input?: Input;
    __audio?: AudioMixer;
    __level?: () => unknown;
    __telemetry?: typeof telemetry;
    __events?: () => unknown;
    __metrics?: () => unknown;
    __debugOverlay?: boolean;
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

const depth = new Float32Array(BUF_W);
const frameBuffer = ctx.createImageData(BUF_W, BUF_H);
const floorTex = makeFloorTexture();
const ceilingTex = makeCeilingTexture();
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
// Menu input latches: keys are edge-triggered (must be released before re-firing)
let menuKeyState = { up: false, down: false, confirm: false };

function isSolidForRaycast(x: number, y: number, tile: number): boolean {
  if (tile === 0) return false;
  if (tile === 9) return game.active ? game.active.doors.isBlocking(x, y) : true;
  if (tile >= 100) return false;
  return true;
}

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
  }
}

function startNewRun() {
  game.start();
  hud.killCount = 0;
  hud.pickupFeed = [];
  runStartTime = performance.now() / 1000;
  shotsFiredCount = 0;
  shotsHitCount = 0;
  onLevelStart();
}

if (!HEADLESS) {
  canvas.addEventListener('click', () => audio.init(), { once: true });
}
if (AUTO_START) {
  if (!HEADLESS) audio.init();
  startNewRun();
}

// Menu navigation polling — independent of the game-loop pause/active state so
// menus work even when game logic is suspended.
function pollMenuInput(menu: Menu): 'confirm' | null {
  const up = input.isDown('ArrowUp') || input.isDown('KeyW');
  const down = input.isDown('ArrowDown') || input.isDown('KeyS');
  const confirm = input.isDown('Enter') || input.isDown('Space') || input.isDown('KeyF');
  let result: 'confirm' | null = null;
  if (up && !menuKeyState.up) menu.prev();
  if (down && !menuKeyState.down) menu.next();
  if (confirm && !menuKeyState.confirm) result = 'confirm';
  menuKeyState = { up, down, confirm };
  // Hover-driven selection from the mouse position recorded by the canvas
  // listener below. Click action is set on mousedown and consumed here.
  if (menuMouseRow !== null) {
    menu.select(menuMouseRow);
    if (menuMouseClicked) {
      menuMouseClicked = false;
      result = 'confirm';
    }
  } else if (menuMouseClicked) {
    menuMouseClicked = false;
  }
  return result;
}

// Mouse state for menus. These are updated by listeners on the canvas, then
// consumed by pollMenuInput().
let menuMouseRow: number | null = null;
let menuMouseClicked = false;
function bufCoords(ev: MouseEvent): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width;
  const sy = canvas.height / rect.height;
  return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
}
canvas.addEventListener('mousemove', (ev) => {
  if (!isMenuPhase()) return;
  const { x, y } = bufCoords(ev);
  const menu = activeMenu();
  menuMouseRow = menu ? menu.hitTest(x, y) : null;
});
canvas.addEventListener('mousedown', (ev) => {
  if (ev.button !== 0) return;
  if (!isMenuPhase()) return;
  const { x, y } = bufCoords(ev);
  const menu = activeMenu();
  const row = menu ? menu.hitTest(x, y) : null;
  if (row !== null && menu) {
    menu.select(row);
    menuMouseClicked = true;
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

    // CONTROLS overlay (can open from title or pause). Esc / click closes.
    if (showControls) {
      input.wantsPointerLock = false;
      const closeKey = input.isDown('Escape') || input.isDown('Enter');
      if (closeKey && !menuKeyState.confirm) showControls = false;
      if (menuMouseClicked) { menuMouseClicked = false; showControls = false; }
      menuKeyState = { up: false, down: false, confirm: closeKey };
      return;
    }

    // Title menu
    if (game.phase === 'title') {
      input.wantsPointerLock = false;
      const confirm = pollMenuInput(titleMenu);
      if (confirm === 'confirm') {
        const action = titleMenu.activate();
        if (action === 'play') { audio.init(); startNewRun(); }
        else if (action === 'controls') showControls = true;
      }
      return;
    }

    // Win/dead screens consume any fire key to advance.
    if (game.phase === 'dead') {
      const snap = input.snapshot();
      if (snap.fire) { game.restart(); hud.killCount = 0; runStartTime = performance.now() / 1000; shotsFiredCount = 0; shotsHitCount = 0; onLevelStart(); }
      return;
    }
    if (game.phase === 'win') {
      const snap = input.snapshot();
      if (snap.fire) { audio.stopMusic(); game.toTitle(); }
      return;
    }

    // Pause: input.paused is set on pointer-lock loss. Hand input to the pause menu.
    if (input.paused) {
      input.wantsPointerLock = false;
      const confirm = pollMenuInput(pauseMenu);
      if (confirm === 'confirm') {
        const action = pauseMenu.activate();
        if (action === 'resume') {
          // Re-arm pointer lock so the next canvas click re-grabs the cursor.
          input.wantsPointerLock = true;
        } else if (action === 'restart') {
          game.restart();
          hud.killCount = 0;
          runStartTime = performance.now() / 1000;
          shotsFiredCount = 0;
          shotsHitCount = 0;
          onLevelStart();
        } else if (action === 'controls') {
          showControls = true;
        } else if (action === 'title') {
          audio.stopMusic();
          game.toTitle();
        }
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

    // Only request pointer lock during active play (not in menus / overlays).
    input.wantsPointerLock = game.phase === 'playing' && !showControls && !input.paused && !HEADLESS;
  },
  () => {
    if (game.phase === 'title') {
      renderTitle(ctx, game.time, titleMenu);
    } else if (game.phase === 'win') {
      const a = game.active;
      renderWin(ctx, game.time, makeEndStats(a?.level.name ?? ''));
    } else if (!game.active) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, BUF_W, BUF_H);
    } else {
      const a = game.active;
      renderScene(ctx, a.level, game.player.x, game.player.y, game.player.angle, {
        depth, textureFor, isSolid: isSolidForRaycast,
        doorOpenRatio: (x, y) => a.doors.openRatio(x, y),
        floor: floorTex, ceiling: ceilingTex, frameBuffer,
      });
      const sprites = [
        ...a.enemies.map((e) => ({ x: e.x, y: e.y, img: assets.sprite(e.spriteKey) })),
        ...a.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, img: assets.sprite(p.spriteKey), vOffset: 0.25 })),
      ];
      renderSprites(ctx, sprites, game.player.x, game.player.y, game.player.angle, depth);
      renderViewmodel(ctx, game.player, game.time, assets);
      renderDebug(ctx, a, game.player, depth, Math.PI / 3);
      renderHUD(ctx, game.player, hud, assets, a.level.name, game.time);

      if (levelIntroT > 0 && lastLevelIdx === game.levelIndex && !input.paused && game.phase !== 'dead') {
        renderLevelIntro(ctx, a.level.name, levelIntroT);
      }

      if (game.phase === 'dead') {
        renderDeath(ctx, game.time, makeEndStats(a.level.name));
      } else if (input.paused) {
        renderPause(ctx, pauseMenu);
      }
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
