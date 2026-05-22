// Procedurally generated 64x64 textures and sprites. CC0.

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
    noise(g, 64, 64, [115, 55, 45], 20);
    // mortar lines + brick highlights
    g.strokeStyle = 'rgba(0,0,0,0.55)';
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
    // subtle bright highlights on top of bricks
    g.fillStyle = 'rgba(255,200,160,0.08)';
    for (let y = 0; y < 64; y += 16) {
      const off = (y / 16) % 2 === 0 ? 0 : 16;
      for (let x = off; x < 64; x += 32) g.fillRect(x + 1, y + 1, 30, 2);
    }
    // weathering streaks
    g.fillStyle = 'rgba(0,0,0,0.18)';
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(Math.random() * 64);
      g.fillRect(x, 0, 1, 64);
    }
  }),
  metal: () => makeImage((g) => {
    noise(g, 64, 64, [85, 88, 100], 14);
    g.strokeStyle = 'rgba(0,0,0,0.65)';
    g.lineWidth = 1;
    for (let y = 4; y < 64; y += 12) {
      g.beginPath(); g.moveTo(0, y); g.lineTo(64, y); g.stroke();
    }
    g.fillStyle = '#5a5a66';
    for (let y = 8; y < 64; y += 12) for (let x = 8; x < 64; x += 12) {
      g.fillRect(x, y, 2, 2);
    }
    // shine band
    g.fillStyle = 'rgba(220,230,255,0.08)';
    g.fillRect(0, 20, 64, 3);
  }),
  door: () => makeImage((g) => {
    noise(g, 64, 64, [130, 95, 35], 12);
    g.strokeStyle = 'rgba(0,0,0,0.6)';
    g.lineWidth = 2;
    g.strokeRect(2, 2, 60, 60);
    g.strokeRect(8, 8, 48, 24);
    g.strokeRect(8, 36, 48, 20);
    // handle
    g.fillStyle = '#222';
    g.fillRect(48, 30, 4, 6);
    // hazard stripes
    g.fillStyle = 'rgba(255,210,0,0.45)';
    for (let i = 0; i < 64; i += 8) {
      g.fillRect(i, 60, 4, 4);
    }
  }),
  exit: () => makeImage((g) => {
    g.fillStyle = '#003800'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#0c0'; g.fillRect(2, 2, 60, 60);
    g.fillStyle = '#003800';
    g.font = 'bold 16px monospace';
    g.fillText('EXIT', 14, 36);
    g.strokeStyle = '#0f0'; g.lineWidth = 2; g.strokeRect(2, 2, 60, 60);
    // glow dots
    g.fillStyle = '#9f9';
    for (let i = 0; i < 4; i++) g.fillRect(8 + i * 16, 56, 4, 4);
  }),
};

// Enemy sprite generator. Slightly different pose between frames so they
// look like they're walking instead of teleport-shuffling.
function makeEnemy(
  color: [number, number, number],
  variant: 'front' | 'frontA' | 'frontB' | 'attack' | 'dying',
): HTMLImageElement {
  return makeImage((g) => {
    g.clearRect(0, 0, 64, 64);
    const [r, gn, b] = color;
    const body = `rgb(${r},${gn},${b})`;
    const dark = `rgb(${Math.floor(r * 0.6)},${Math.floor(gn * 0.6)},${Math.floor(b * 0.6)})`;
    const skin = '#d6c19a';
    const skinDark = '#8e7050';

    if (variant === 'dying') {
      // gore pile
      g.fillStyle = '#4a0a0a';
      g.beginPath(); g.ellipse(32, 52, 26, 9, 0, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#8a1010';
      g.fillRect(18, 46, 28, 10);
      g.fillStyle = '#b22020';
      for (let i = 0; i < 5; i++) {
        const x = 14 + i * 9 + (Math.random() * 4 - 2);
        const y = 44 + Math.random() * 8;
        g.fillRect(x, y, 3, 3);
      }
      // skull
      g.fillStyle = '#cccccc';
      g.beginPath(); g.arc(32, 46, 5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#000';
      g.fillRect(29, 45, 2, 2); g.fillRect(33, 45, 2, 2);
      return;
    }

    // shadow
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath(); g.ellipse(32, 60, 16, 3, 0, 0, Math.PI * 2); g.fill();

    // Legs offset depending on frame (walk cycle)
    let legL = 54, legR = 54;
    let legXL = 24, legXR = 34;
    if (variant === 'frontA') { legL = 52; legXL = 22; }
    else if (variant === 'frontB') { legR = 52; legXR = 36; }

    // legs
    g.fillStyle = dark;
    g.fillRect(legXL, 44, 6, legL - 44 + 8);
    g.fillRect(legXR, 44, 6, legR - 44 + 8);

    // torso
    g.fillStyle = body;
    g.fillRect(20, 24, 24, 24);
    // torso shading on the right side (light from left)
    g.fillStyle = dark;
    g.fillRect(38, 24, 6, 24);

    // belt
    g.fillStyle = '#222';
    g.fillRect(20, 42, 24, 3);

    // arms
    g.fillStyle = body;
    if (variant === 'attack') {
      // arms up, claws extended
      g.fillRect(8, 22, 12, 6);
      g.fillRect(44, 22, 12, 6);
      g.fillStyle = skinDark;
      g.fillRect(4, 22, 6, 8);
      g.fillRect(54, 22, 6, 8);
    } else {
      g.fillRect(12, 28, 8, 18);
      g.fillRect(44, 28, 8, 18);
      g.fillStyle = skin;
      g.fillRect(12, 44, 8, 6);
      g.fillRect(44, 44, 8, 6);
    }

    // head
    g.fillStyle = skin;
    g.beginPath(); g.arc(32, 18, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = skinDark;
    g.beginPath(); g.arc(36, 18, 5, 0, Math.PI * 2); g.fill();

    // horns
    g.fillStyle = '#1a1a1a';
    g.beginPath(); g.moveTo(24, 12); g.lineTo(20, 4); g.lineTo(26, 10); g.closePath(); g.fill();
    g.beginPath(); g.moveTo(40, 12); g.lineTo(44, 4); g.lineTo(38, 10); g.closePath(); g.fill();

    // eyes
    g.fillStyle = variant === 'attack' ? '#ff2010' : '#ff0';
    g.fillRect(27, 16, 3, 3);
    g.fillRect(34, 16, 3, 3);

    // mouth — angrier when attacking
    g.fillStyle = '#1a0000';
    if (variant === 'attack') {
      g.fillRect(26, 22, 12, 4);
      g.fillStyle = '#fff';
      for (let i = 0; i < 6; i++) g.fillRect(27 + i * 2, 22, 1, 2);
    } else {
      g.fillRect(28, 23, 8, 2);
    }
  }, 64, 64);
}

export const sprite = {
  imp_front:  () => makeEnemy([170, 60, 60], 'front'),
  imp_frontA: () => makeEnemy([170, 60, 60], 'frontA'),
  imp_frontB: () => makeEnemy([170, 60, 60], 'frontB'),
  imp_attack: () => makeEnemy([200, 70, 60], 'attack'),
  imp_dying:  () => makeEnemy([170, 60, 60], 'dying'),

  grunt_front:  () => makeEnemy([100, 130, 80], 'front'),
  grunt_frontA: () => makeEnemy([100, 130, 80], 'frontA'),
  grunt_frontB: () => makeEnemy([100, 130, 80], 'frontB'),
  grunt_attack: () => makeEnemy([110, 145, 80], 'attack'),
  grunt_dying:  () => makeEnemy([100, 130, 80], 'dying'),

  pickup_health: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#fff'; g.fillRect(4, 4, 24, 24);
    g.fillStyle = '#e00'; g.fillRect(12, 8, 8, 16); g.fillRect(8, 12, 16, 8);
    g.strokeStyle = '#000'; g.lineWidth = 1; g.strokeRect(4, 4, 24, 24);
  }, 32, 32),
  pickup_armor: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#08f';
    g.beginPath();
    g.moveTo(16, 4); g.lineTo(28, 10); g.lineTo(28, 22); g.lineTo(16, 28); g.lineTo(4, 22); g.lineTo(4, 10);
    g.closePath(); g.fill();
    g.strokeStyle = '#0bf'; g.lineWidth = 1; g.stroke();
  }, 32, 32),
  pickup_pistol_ammo: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#ca0'; g.fillRect(8, 12, 16, 10);
    g.fillStyle = '#fd0'; g.fillRect(10, 14, 12, 6);
    g.fillStyle = '#000'; g.font = 'bold 6px monospace';
    g.fillText('9MM', 11, 19);
  }, 32, 32),
  pickup_shotgun_ammo: () => makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    g.fillStyle = '#a00'; g.fillRect(6, 10, 20, 14);
    g.fillStyle = '#fd0';
    g.fillRect(8, 12, 4, 10);
    g.fillRect(14, 12, 4, 10);
    g.fillRect(20, 12, 4, 10);
  }, 32, 32),
  pistol: () => makeImage((g) => {
    g.clearRect(0, 0, 96, 64);
    // grip
    g.fillStyle = '#3a3a3a';
    g.fillRect(40, 26, 16, 30);
    g.fillStyle = '#222';
    g.fillRect(42, 50, 12, 6);
    // body
    g.fillStyle = '#444';
    g.fillRect(30, 8, 38, 20);
    // barrel highlight
    g.fillStyle = '#666';
    g.fillRect(34, 12, 30, 8);
    // sight
    g.fillStyle = '#111';
    g.fillRect(60, 4, 4, 6);
    // trigger guard
    g.strokeStyle = '#111'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(40, 28); g.lineTo(48, 36); g.lineTo(48, 28); g.stroke();
  }, 96, 64),
  shotgun: () => makeImage((g) => {
    g.clearRect(0, 0, 128, 64);
    // stock
    g.fillStyle = '#3a2a18';
    g.fillRect(48, 32, 36, 18);
    g.fillStyle = '#5a3a20';
    g.fillRect(50, 34, 32, 4);
    // receiver
    g.fillStyle = '#222';
    g.fillRect(28, 20, 60, 14);
    // barrel
    g.fillStyle = '#555';
    g.fillRect(16, 22, 70, 6);
    // barrel hole
    g.fillStyle = '#000';
    g.beginPath(); g.arc(18, 25, 3, 0, Math.PI * 2); g.fill();
    // pump
    g.fillStyle = '#666';
    g.fillRect(34, 30, 18, 5);
  }, 128, 64),
  // Face portraits — 8 small sprites the HUD picks between based on state.
  face_100: () => makeFace('healthy', false),
  face_75:  () => makeFace('healthy', false, true),
  face_50:  () => makeFace('hurt', false),
  face_25:  () => makeFace('hurt', false, true),
  face_10:  () => makeFace('critical', false),
  face_hurt: () => makeFace('healthy', true),
  face_dead: () => makeFace('dead', false),
};

function makeFace(mood: 'healthy' | 'hurt' | 'critical' | 'dead', screaming = false, scratched = false) {
  return makeImage((g) => {
    g.clearRect(0, 0, 32, 32);
    // head
    g.fillStyle = mood === 'dead' ? '#5b6e72' : '#d6c19a';
    g.beginPath(); g.arc(16, 16, 12, 0, Math.PI * 2); g.fill();
    g.fillStyle = mood === 'dead' ? '#3a4a4e' : '#8e7050';
    g.beginPath(); g.arc(20, 18, 8, 0, Math.PI * 2); g.fill();
    // hair
    g.fillStyle = '#3a2010';
    g.fillRect(6, 4, 20, 6);
    // brows
    g.fillStyle = '#000';
    if (mood === 'critical' || mood === 'dead') {
      g.fillRect(7, 12, 7, 2); g.fillRect(18, 12, 7, 2); // straight angry brows
    } else {
      g.fillRect(7, 11, 6, 2); g.fillRect(19, 11, 6, 2);
    }
    // eyes
    if (mood === 'dead') {
      g.fillStyle = '#000'; g.fillRect(9, 15, 3, 1); g.fillRect(20, 15, 3, 1);
    } else {
      g.fillStyle = '#fff'; g.fillRect(8, 14, 4, 4); g.fillRect(20, 14, 4, 4);
      g.fillStyle = '#000'; g.fillRect(10, 15, 2, 2); g.fillRect(22, 15, 2, 2);
    }
    // mouth
    g.fillStyle = '#3a0000';
    if (screaming) {
      g.fillRect(11, 22, 10, 5);
      g.fillStyle = '#fff';
      g.fillRect(12, 22, 2, 2); g.fillRect(15, 22, 2, 2); g.fillRect(18, 22, 2, 2);
    } else if (mood === 'critical') {
      g.fillRect(10, 22, 12, 3);
    } else if (mood === 'dead') {
      g.fillRect(11, 22, 10, 1);
    } else {
      g.fillRect(11, 22, 10, 2);
    }
    // scratches if hurt variant
    if (scratched) {
      g.strokeStyle = '#7a1010'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(10, 8); g.lineTo(14, 22); g.stroke();
      g.beginPath(); g.moveTo(20, 10); g.lineTo(22, 24); g.stroke();
    }
  }, 32, 32);
}
