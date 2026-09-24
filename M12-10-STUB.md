# M12-10 STUB (fixer)

Two verified M12-09 gaps:

1. OPTIONS-menu `mouse_sensitivity` change does not persist across sessions.
   - menu.ts keeps mouseSensitivity local; nothing pumps menu -> settings.
   - FIX: extend the law-pump pattern so menu sensitivity writes settings AND
     the live mountMouse applies.
2. CONTROLS.md omits `iddt` (exists via AM_Responder path in amMap.ts).
   - Add row (automap OPEN, cycles 0->1->2), cite am_map.c:287/:701 + amMap.ts.
   - Align docs/reports/M11-cheats.md wording.

Gates: targeted spec green, npm run e2e green, npm run check green,
streams/goldens unmoved.
