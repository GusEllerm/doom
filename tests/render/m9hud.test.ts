/**
 * M9-11 — L3 golden corpus: statusbar + message strip + viewport pair
 * (plan §M9-11, goldens set `m9`).
 *
 * Every scene is a FULL 320×200 production frame composed by displayFrame
 * (the same rAF-frame driver main.ts runs: gFlowTic/gTicker/HU/ST tickers,
 * then the D_Display draw order incl. the sb9 windowed crop + FLOOR7_2/
 * brdr borders) over the pinned E1M1 — captured twice per goldenScene
 * (byte-equal) with HOM=0 asserted on every 3D+bar frame.
 *
 * a) BAR — the 8-variant matrix: health tiers × face states × keys ×
 *    weapon/ammo widgets, scripted through the LIVE player object the
 *    face machine reads (st_stuff.c:752-905 rules): pain tiers 0..3,
 *    evil grin (R2), attacked turn (R3), god face (R6), dead (R1).
 * b) MSG — the HU message strip: shown / held / expired (HU_MSGTIMEOUT
 *    140 tics, hu_stuff.h:44), the player.message drain proven live.
 * c) VIEW — the sb9 (288×144 windowed + bar) vs sb11 (fullscreen)
 *    viewport pair at one camera.
 *
 * WAD-GATED (skipIf no wad, walls/screens pattern): without a wad nothing
 * dumps and committed goldens stay untouched.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, it } from 'vitest';

import { displayStubHits } from '../../src/render/renderer';
import type { PickupPlayer } from '../../src/sim/p_inter_inventory';
import { M9Driver, VIEWPOINTS, bundle_, goldenScene, m9Describe } from '../fixtures/m9Scenarios';

// The LIVE player object carries the inventory slice (p_inter_inventory);
// sim/state's view type splits the fields across interfaces, so the
// scripted mutations bind through this (type-only) intersection.
type Player = PickupPlayer;

const SCRIPT_BAR =
  'E1M1 gInitGame -> warp spawn-east -> [per-tic scripted player state] x5 (gFlowTic+gTicker+HU/ST tickers) -> displayFrame (3D + crop + borders + ST bar) x2 byte-equal, hom asserted 0';
const SCRIPT_MSG =
  'E1M1 gInitGame -> warp spawn-east -> player.message=GOTMEDINEED @tic2 -> [HU/ST tickers] xN -> displayFrame (3D + bar + HU message strip @0,0) x2 byte-equal, hom 0';
const SCRIPT_VIEW =
  'E1M1 gInitGame -> warp spawn-east -> 5 empty tics -> displayFrame (sb variant) x2 byte-equal, hom 0';

/** Script the LIVE player through the widget/face-machine reads; the
 * mutate runs EVERY tic before the tickers so the scripted state survives
 * whatever the (deterministic) world does in between. */
function barScene(
  tics: number,
  mutate: (p: Player, tic: number) => void,
): () => { bytes: Uint8Array; hom?: number } {
  return () => {
    const b = bundle_();
    const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb: 9 });
    for (let t = 0; t < tics; t++) {
      mutate(d.state.players[0] as Player, t);
      d.tic();
    }
    const frame = d.frame();
    expectNoMissingDrawer();
    return frame;
  };
}

function expectNoMissingDrawer(): void {
  expect(displayStubHits.count, 'all D_Display drawers registered').toBe(0);
}

/* ================================================================== */
/* a) statusbar 8-variant matrix                                       */
/* ================================================================== */

m9Describe('M9-11 m9hud — statusbar variant matrix (goldens/m9)', () => {
  const variants: readonly (readonly [string, number, (p: Player, t: number) => void])[] = [
    // health tier 0 + all six keys + pistol/shotgun/chaigun, shells+cells
    [
      'bar-100-keys-arsenal',
      5,
      (p) => {
        p.health = 100;
        p.cards.fill(1);
        p.weaponowned[0] = 1;
        p.weaponowned[1] = 1;
        p.weaponowned[2] = 1;
        p.weaponowned[3] = 1;
        p.readyweapon = 2;
        p.ammo[1] = 36;
        p.ammo[2] = 120;
        p.armorpoints = 50;
      },
    ],
    // tier 1 (75) + green armor + full bullets (chaingun ready)
    [
      'bar-075-armor-clip',
      5,
      (p) => {
        p.health = 75;
        p.armorpoints = 100;
        p.weaponowned[1] = 1;
        p.weaponowned[3] = 1;
        p.readyweapon = 3;
        p.ammo[0] = 50;
      },
    ],
    // tier 2 (50) + plasma rifle + cells (maxammo widget nonzero)
    [
      'bar-050-cells',
      5,
      (p) => {
        p.health = 50;
        p.weaponowned[1] = 1;
        p.weaponowned[5] = 1;
        p.readyweapon = 5;
        p.ammo[2] = 12;
        p.maxammo[2] = 300;
      },
    ],
    // tier 3 (25) + shotgun, 8 shells (low-ammo widget)
    [
      'bar-025-shells',
      5,
      (p) => {
        p.health = 25;
        p.weaponowned[1] = 1;
        p.weaponowned[2] = 1;
        p.readyweapon = 2;
        p.ammo[1] = 8;
      },
    ],
    // evil grin (face rule R2): bonuscount + freshly-owned weapon
    [
      'bar-grin-weapon',
      5,
      (p, t) => {
        p.health = 100;
        if (t >= 2) p.weaponowned[2] = 1; // ownership flip after ST_Start
        p.bonuscount = 11;
      },
    ],
    // attacked turn face (R3): tier 3 + live attacker off to the left
    [
      'bar-attacked-left',
      4,
      (p) => {
        p.health = 25;
        p.damagecount = 50;
        p.attacker = {
          x: p.mo.x - 128 * 65536,
          y: p.mo.y + 128 * 65536,
          angle: 0,
        } as unknown as Player['attacker'];
      },
    ],
    // god face (R6): invulnerability power + rocket launcher, rockets 5
    [
      'bar-god-invul',
      5,
      (p) => {
        p.health = 100;
        p.powers[0] = 2000; // pw_invulnerability
        p.weaponowned[1] = 1;
        p.weaponowned[4] = 1;
        p.readyweapon = 4;
        p.ammo[3] = 5;
      },
    ],
    // dead face (R1): health 0, fist ready (the post-death bar)
    [
      'bar-dead-fist',
      5,
      (p) => {
        p.health = 0;
        p.weaponowned[0] = 1;
        p.readyweapon = 0;
      },
    ],
  ] as const;

  for (const [name, tics, mutate] of variants) {
    it(`${name}: full frame (bar composited, double-run equal, sha vs meta)`, () => {
      goldenScene(name, SCRIPT_BAR, barScene(tics, mutate));
    });
  }
});

/* ================================================================== */
/* b) HU message strip                                                 */
/* ================================================================== */

m9Describe('M9-11 m9hud — HU message strip (goldens/m9)', () => {
  function msgScene(captureAt: number): () => { bytes: Uint8Array; hom?: number } {
    return () => {
      const b = bundle_();
      const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb: 9 });
      for (let t = 0; t < captureAt; t++) {
        if (t === 2) d.state.players[0]!.message = 'GOTMEDINEED';
        d.tic();
      }
      const frame = d.frame();
      expectNoMissingDrawer();
      return frame;
    };
  }

  // The strip pixels exist ONLY while the drawer says "messageOn" —
  // pin the queue state at each captured frame (hu_stuff.c:505-533).
  it('msg-show (tic 4): message drawn at (0,0)', () => {
    goldenScene('msg-show-t4', SCRIPT_MSG, msgScene(4));
  });
  it('msg-hold (tic 105): still inside HU_MSGTIMEOUT', () => {
    goldenScene('msg-hold-t105', SCRIPT_MSG, msgScene(105));
  });
  it('msg-gone (tic 144): timeout expired, 3D-only frame', () => {
    goldenScene('msg-gone-t144', SCRIPT_MSG, msgScene(144));
  });
});

/* ================================================================== */
/* c) sb9 / sb11 viewport pair                                          */
/* ================================================================== */

m9Describe('M9-11 m9hud — screenblocks viewport pair (goldens/m9)', () => {
  for (const sb of [9, 11] as const) {
    it(`view-sb${sb}: E1M1 spawn-east full frame (D_Display composition)`, () => {
      goldenScene(`view-sb${sb}-spawn-east`, SCRIPT_VIEW, () => {
        const b = bundle_();
        const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb });
        for (let t = 0; t < 5; t++) d.tic();
        const frame = d.frame();
        expectNoMissingDrawer();
        return frame;
      });
    });
  }
});
