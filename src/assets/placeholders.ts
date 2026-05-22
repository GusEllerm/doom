// Procedurally generated 64x64 textures. CC0.
// Returned as HTMLImageElement via data URL so they slot into the same
// pipeline as real PNGs.

function makeImage(draw: (g: CanvasRenderingContext2D) => void, w = 64, h = 64): HTMLImageElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  draw(g);
  const img = new Image();
  img.src = c.toDataURL();
  return img;
}

function noise(g: CanvasRenderingContext2D, w: number, h: number, base: [number, number, number], amp: number) {
  const id = g.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const n = (Math.random() * 2 - 1) * amp;
    id.data[i * 4 + 0] = Math.max(0, Math.min(255, base[0] + n));
    id.data[i * 4 + 1] = Math.max(0, Math.min(255, base[1] + n));
    id.data[i * 4 + 2] = Math.max(0, Math.min(255, base[2] + n));
    id.data[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
}

export const tex = {
  brick: () => makeImage((g) => {
    noise(g, 64, 64, [110, 50, 40], 18);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.lineWidth = 2;
    for (let y = 0; y < 64; y += 16) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke();
    }
    for (let y = 0; y < 64; y += 16) {
      const off = (y / 16) % 2 === 0 ? 0 : 16;
      for (let x = off; x < 64; x += 32) {
        g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 16); g.stroke();
      }
    }
  }),
  metal: () => makeImage((g) => {
    noise(g, 64, 64, [90, 90, 100], 12);
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 1;
    for (let y = 4; y < 64; y += 12) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke();
    }
    g.fillStyle = '#555';
    for (let y = 8; y < 64; y += 12) for (let x = 8; x < 64; x += 12) {
      g.fillRect(x, y, 2, 2);
    }
  }),
  door: () => makeImage((g) => {
    noise(g, 64, 64, [120, 90, 30], 10);
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.strokeRect(2, 2, 60, 60);
    g.strokeRect(8, 8, 48, 24);
    g.strokeRect(8, 36, 48, 20);
    g.fillStyle = '#222';
    g.fillRect(48, 30, 4, 6);
  }),
  exit: () => makeImage((g) => {
    g.fillStyle = '#003300'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#0f0'; g.font = 'bold 16px monospace';
    g.fillText('EXIT', 14, 36);
    g.strokeStyle = '#0f0'; g.lineWidth = 2; g.strokeRect(2, 2, 60, 60);
  }),
};

function makeEnemy(color: [number, number, number]): HTMLImageElement {
  return makeImage((g) => {
    g.clearRect(0, 0, 64, 64);
    g.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    // body
    g.fillRect(20, 24, 24, 32);
    // head
    g.beginPath(); g.arc(32, 18, 10, 0, Math.PI * 2); g.fill();
    // eyes
    g.fillStyle = '#ff0';
    g.fillRect(26, 16, 3, 3);
    g.fillRect(35, 16, 3, 3);
    // arms
    g.fillStyle = `rgb(${color[0]},${color[1]},${color[2]})`;
    g.fillRect(12, 28, 8, 20);
    g.fillRect(44, 28, 8, 20);
    // legs
    g.fillRect(22, 54, 8, 10);
    g.fillRect(34, 54, 8, 10);
  }, 64, 64);
}

export const sprite = {
  imp_front: () => makeEnemy([180, 70, 70]),
  grunt_front: () => makeEnemy([110, 130, 80]),
  imp_dying: () => makeImage((g) => {
    g.fillStyle = '#600'; g.beginPath(); g.ellipse(32, 50, 24, 10, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#900'; g.fillRect(20, 44, 24, 12);
  }, 64, 64),
  grunt_dying: () => makeImage((g) => {
    g.fillStyle = '#3a4a2a'; g.beginPath(); g.ellipse(32, 50, 24, 10, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5a6a3a'; g.fillRect(20, 44, 24, 12);
  }, 64, 64),
  pickup_health: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#fff'; g.fillRect(4, 4, 24, 24);
    g.fillStyle = '#e00'; g.fillRect(12, 8, 8, 16); g.fillRect(8, 12, 16, 8);
  }, 32, 32),
  pickup_armor: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#08f'; g.beginPath();
    g.moveTo(16, 4); g.lineTo(28, 10); g.lineTo(28, 22); g.lineTo(16, 28); g.lineTo(4, 22); g.lineTo(4, 10); g.closePath(); g.fill();
  }, 32, 32),
  pickup_pistol_ammo: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#ca0'; g.fillRect(8, 12, 16, 10);
    g.fillStyle = '#fd0'; g.fillRect(10, 14, 12, 6);
  }, 32, 32),
  pickup_shotgun_ammo: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#a00'; g.fillRect(6, 10, 20, 14);
    g.fillStyle = '#fd0'; g.fillRect(8, 12, 4, 10);
    g.fillRect(14, 12, 4, 10);
    g.fillRect(20, 12, 4, 10);
  }, 32, 32),
  pistol: () => makeImage((g) => {
    g.clearRect(0, 0, 96, 64);
    g.fillStyle = '#333';
    g.fillRect(30, 8, 36, 18);
    g.fillRect(40, 26, 16, 30);
    g.fillStyle = '#222';
    g.fillRect(60, 12, 6, 10);
    g.fillStyle = '#555';
    g.fillRect(34, 12, 28, 10);
  }, 96, 64),
  shotgun: () => makeImage((g) => {
    g.clearRect(0, 0, 128, 64);
    g.fillStyle = '#3a2a18';
    g.fillRect(50, 32, 32, 16);
    g.fillStyle = '#444';
    g.fillRect(20, 22, 70, 10);
    g.fillRect(18, 20, 4, 14);
    g.fillStyle = '#666';
    g.fillRect(22, 26, 60, 2);
  }, 128, 64),
};
