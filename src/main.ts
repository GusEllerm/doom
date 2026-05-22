import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { renderScene, BUF_W, BUF_H } from './render/raycaster';
import { makeFloorTexture, makeCeilingTexture } from './render/textureCache';
import { renderSprites } from './render/sprites';
import { renderHUD, type HUDState } from './render/hud';
import { renderViewmodel } from './render/viewmodel';
import { fireHitscan } from './entities/weapons';
import { renderTitle, renderDeath, renderWin, renderPause, renderLevelIntro } from './render/screens';
import { telemetry } from './engine/telemetry';
import { debug, recordFrame, renderDebug } from './render/debug';
import { loadAssets } from './engine/assets';
import { manifest, tileTextureKey } from './assets/manifest';
import { Game } from './game/state';
import { LEVELS } from './world/levels';
import { updatePickups } from './world/triggers';
import { AudioMixer } from './engine/audio';

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


// Debug hooks for the playtest harness. Exposed unconditionally — they're
// read-only references and the overhead is zero.
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
  }
}
window.__game = game;
window.__input = input;
window.__audio = audio;
window.__telemetry = telemetry;
window.__events = () => telemetry.all();
window.__metrics = () => telemetry.derive();
window.__debug = debug;
addEventListener('keydown', (e) => {
  if (e.code === 'F1') { debug.enabled = !debug.enabled; e.preventDefault(); }
  // In headless mode, allow toggling via Q (function keys are reserved by the browser).
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
      // Default to "miss → wall spark" — overridden below on hit.
      hud.wallSparkT = 0.18;
    },
    onHit: () => {
      audio.playSfx('enemy_hit');
      hud.hitMarkerT = 0.25;
      hud.wallSparkT = 0; // suppress the miss spark if we connected
    },
    onKill: (e) => { audio.playSfx(e.kind === 'imp' ? 'enemy_death_imp' : 'enemy_death_grunt'); hud.killCount++; },
    onDryFire: () => audio.playSfx('dryfire'),
  };
}
wirePlayerEvents();

let frames = 0, fps = 0, fpsAcc = 0;
let levelIntroT = 0;
let lastLevelIdx = -1;

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
    // Re-bind enemy events to record source on damage.
    for (const e of game.active.enemies) {
      e['events'] = { onPlayerHit: (d: number) => game.player.takeDamage(d, e.kind) } as any;
    }
  }
}

if (!HEADLESS) {
  canvas.addEventListener('click', () => audio.init(), { once: true });
}

if (AUTO_START) {
  if (!HEADLESS) audio.init();
  game.start();
  onLevelStart();
}

let lastFrameStart = 0;
let renderStart = 0;

startLoop(
  (dt) => {
    const frameStart = performance.now();
    if (lastFrameStart > 0) {
      const gap = frameStart - lastFrameStart;
      recordFrame(gap);
      if (gap > 33) telemetry.push({ type: 'frame_slow', t: frameStart / 1000, ms: gap });
    }
    lastFrameStart = frameStart;
    renderStart = frameStart;
    game.time += dt;
    if (levelIntroT > 0) levelIntroT -= dt;

    if (input.paused) return;
    const snap = input.snapshot();

    if (game.phase === 'title') {
      if (snap.fire) {
        audio.init();
        game.start();
        onLevelStart();
      }
      return;
    }
    if (game.phase === 'dead') {
      if (snap.fire) { game.restart(); onLevelStart(); }
      return;
    }
    if (game.phase === 'win') {
      if (snap.fire) { audio.stopMusic(); game.toTitle(); }
      return;
    }

    const a = game.active!;
    const prevHp = game.player.health;
    game.player.update(dt, snap, a.level, a.enemies, a.doors);
    if (snap.interact) {
      // Door interact already handled in player.update; play sound if any door is opening
      // (cheap approach: just play on E press when near a door)
      // No-op here; door open sfx triggers via observing doors below.
    }
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
    // Tick pickup feed
    for (const m of hud.pickupFeed) m.t -= dt;
    hud.pickupFeed = hud.pickupFeed.filter((m) => m.t > 0);
    hud.hurtFlashT = Math.max(0, hud.hurtFlashT - dt * 2);
    hud.hitMarkerT = Math.max(0, hud.hitMarkerT - dt * 4);
    hud.wallSparkT = Math.max(0, hud.wallSparkT - dt * 6);

    // Detect hovered enemy at the crosshair for HUD feedback.
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

    // Detect newly-opening doors → play sound (poll once per tick)
    // Simpler: play door SFX on interact key press when one opens. Wired via game.active.doors events: not implemented for terseness;
    // sound on interact press is good enough.
    if (snap.interact) audio.playSfx('door');
  },
  () => {
    if (game.phase === 'title') {
      renderTitle(ctx, game.time);
    } else if (game.phase === 'win') {
      renderWin(ctx, game.time, hud.killCount);
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

      if (levelIntroT > 0 && lastLevelIdx === game.levelIndex) {
        renderLevelIntro(ctx, a.level.name, levelIntroT);
      }

      if (game.phase === 'dead') {
        renderDeath(ctx, game.time, hud.killCount, a.level.name);
      } else if (input.paused) {
        renderPause(ctx);
      }
    }

    ctx.fillStyle = '#0f0';
    ctx.font = '10px monospace';
    ctx.fillText(`FPS ${fps}`, 4, 12);
    frames++;
    fpsAcc += 1 / 60;
    if (fpsAcc >= 1) { fps = frames; frames = 0; fpsAcc = 0; }
  },
);

