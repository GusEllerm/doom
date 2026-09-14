# ROADMAP

Status legend: [ ] planned, [~] in progress, [x] done, [!] blocked

Milestone exit criteria will be refined by the architect in Phase 2. Skeleton from PROMPT.md §3/§8:

| # | Milestone | Demonstrable exit | Status |
|---|---|---|---|
| M0 | Research + architecture + scaffold | `npm run check` + `npm run e2e` pass on main; research notes for all 12 topics; ARCHITECTURE.md committed | [~] |
| M1 | WAD and data decoding | Debug viewer page shows any texture, flat, sprite or patch from the IWAD with correct palette | [ ] |
| M2 | Map loading and automap | First map's automap draws; player arrow moves in noclip | [ ] |
| M3 | Wall renderer | BSP walls w/ textures, lighting, occlusion; golden tests at sampled viewpoints | [ ] |
| M4 | Planes, sky, masked, things | Floors/ceilings/sky; masked middles; sprites clipped vs walls | [ ] |
| M5 | Player physics and input | 35 Hz tics, momentum/friction, collision, steps, falling, bob; keyboard + pointer-lock mouse | [ ] |
| M6 | Level mechanics | Doors/keys/lifts/crushers/stairs/switches/teleporters/lights/damage/secrets/exits | [ ] |
| M7 | Items and weapons | All pickups + weapons, hitscan/projectiles, ammo/armor/powerups, palette flashes | [ ] |
| M8 | Monsters | Full roster via state tables, AI, sight/sound, pain/death, infighting, barrels | [ ] |
| M9 | Game flow and UI | Title, menus, skill select, status bar, messages, intermission, episode progression, end screens | [ ] |
| M10 | Audio | SFX priority/attenuation/panning; MUS music; volumes | [ ] |
| M11 | Persistence and options | Save/load, bindings, sensitivity, volumes, persisted | [ ] |
| M12 | Full-episode hardening | Every Phase 1 map loads/renders artifact-free at sampled points; reachable exits; scripted playthroughs | [ ] |
| P4 | Fidelity audits | Audit rounds with no high-severity findings | [ ] |
| P5 | Release + stretch goals | DONE_REPORT.md, README, then demo playback, Doom II/Phase 2, widescreen, mouselook, GM soundfont | [ ] |
