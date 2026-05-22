import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { renderWalls, BUF_W, BUF_H } from './render/raycaster';
import { renderSprites } from './render/sprites';
import { renderHUD } from './render/hud';
import { renderViewmodel } from './render/viewmodel';
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

const assets = loadAssets(manifest);
const input = new Input();
input.install(canvas);
const audio = new AudioMixer();
const game = new Game(LEVELS);

const depth = new Float32Array(BUF_W);
const textureFor = (tile: number) => assets.texture(tileTextureKey[tile] ?? 'brick');

// Wire audio to game events
game.player.events = {
  onFire: (slot) => audio.playSfx(slot === 0 ? 'pistol' : 'shotgun'),
  onHit: () => audio.playSfx('enemy_hit'),
  onKill: (e) => audio.playSfx(e.kind === 'imp' ? 'enemy_death_imp' : 'enemy_death_grunt'),
  onDryFire: () => audio.playSfx('dryfire'),
};

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
  // Re-wire player events (new Player on restart)
  game.player.events = {
    onFire: (slot) => audio.playSfx(slot === 0 ? 'pistol' : 'shotgun'),
    onHit: () => audio.playSfx('enemy_hit'),
    onKill: (e) => audio.playSfx(e.kind === 'imp' ? 'enemy_death_imp' : 'enemy_death_grunt'),
    onDryFire: () => audio.playSfx('dryfire'),
  };
}

canvas.addEventListener('click', () => audio.init(), { once: true });

startLoop(
  (dt) => {
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
    updatePickups(a.pickups, game.player, { onPickup: () => audio.playSfx('pickup') });
    a.doors.update(dt);

    const exitTile = a.level.tileAt(game.player.x, game.player.y);
    if (exitTile === 100) {
      const before = game.levelIndex;
      const moved = game.advanceLevel();
      if (moved && game.levelIndex !== before) onLevelStart();
      if (!moved) audio.stopMusic();
    }

    if (game.player.health < prevHp) {
      game.damageFlash = 1.0;
      audio.playSfx('player_hurt');
    }
    game.prevHealth = game.player.health;
    game.damageFlash = Math.max(0, game.damageFlash - dt * 2);

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
      drawCenteredScreen('DOOM', 'Click to start  ·  WASD + mouse  ·  LMB fire  ·  E doors  ·  1/2 weapons', '#f44');
    } else if (game.phase === 'win') {
      drawCenteredScreen('YOU WIN', 'Click to return to title', '#4f4');
    } else if (!game.active) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, BUF_W, BUF_H);
    } else {
      const a = game.active;
      renderWalls(ctx, a.level, game.player.x, game.player.y, game.player.angle, {
        depth, textureFor, isSolid: isSolidForRaycast,
      });
      const sprites = [
        ...a.enemies.map((e) => ({ x: e.x, y: e.y, img: assets.sprite(e.spriteKey) })),
        ...a.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, img: assets.sprite(p.spriteKey), vOffset: 0.25 })),
      ];
      renderSprites(ctx, sprites, game.player.x, game.player.y, game.player.angle, depth);
      renderViewmodel(ctx, game.player, game.time, assets);
      renderHUD(ctx, game.player, game.damageFlash);

      if (levelIntroT > 0 && lastLevelIdx === game.levelIndex) {
        const alpha = Math.min(1, levelIntroT);
        ctx.fillStyle = `rgba(0,0,0,${0.4 * alpha})`;
        ctx.fillRect(0, BUF_H / 2 - 22, BUF_W, 30);
        ctx.fillStyle = `rgba(255,255,255,${alpha})`;
        ctx.font = '12px monospace';
        const txt = a.level.name;
        const tw = ctx.measureText(txt).width;
        ctx.fillText(txt, (BUF_W - tw) / 2, BUF_H / 2);
      }

      if (game.phase === 'dead') {
        ctx.fillStyle = 'rgba(60,0,0,0.7)';
        ctx.fillRect(0, 0, BUF_W, BUF_H);
        ctx.fillStyle = '#fff'; ctx.font = 'bold 24px monospace';
        const tw = ctx.measureText('YOU DIED').width;
        ctx.fillText('YOU DIED', (BUF_W - tw) / 2, BUF_H / 2 - 8);
        ctx.font = '10px monospace';
        const sw = ctx.measureText('Click to restart level').width;
        ctx.fillText('Click to restart level', (BUF_W - sw) / 2, BUF_H / 2 + 14);
      } else if (input.paused) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, BUF_W, BUF_H);
        ctx.fillStyle = '#fff'; ctx.font = '12px monospace';
        const tw = ctx.measureText('Click to play').width;
        ctx.fillText('Click to play', (BUF_W - tw) / 2, 100);
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

function drawCenteredScreen(title: string, sub: string, color: string) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, BUF_W, BUF_H);
  ctx.fillStyle = color; ctx.font = 'bold 32px monospace';
  const tw = ctx.measureText(title).width;
  ctx.fillText(title, (BUF_W - tw) / 2, BUF_H / 2 - 8);
  ctx.fillStyle = '#aaa'; ctx.font = '10px monospace';
  const sw = ctx.measureText(sub).width;
  ctx.fillText(sub, (BUF_W - sw) / 2, BUF_H / 2 + 18);
}
