# M12 montage pack — every-map L3 corpus (D016 human-eyes gate)

Task: docs/design/M12-plan.md §M12-02. Corpus: tests/render/viewpointsAllMaps.ts
(117 analytically-derived viewpoints × 9 E1 maps — spawn / key-door / exit / secret-door /
tall / bright / busy / masked / door / lift / corridor families, all coordinates
from WAD structure — see the file header for the derivation discipline).

Pinned WAD sha256: `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` (`wads/freedoom1.wad`).

Every tile is a production full frame (320×200, flats + walls + masked
middles + sprites, PLAYPAL palette 0). Every frame passes HOM == 0, all
overflow counters == 0, and the non-single-color anomaly filter in
`tests/render/allMaps.test.ts`; per-map contact sheets are blessed goldens
(`tests/render/goldens/maps/e1mN-montage.png`, set `maps`).

Review grid (per map, one contact sheet — tiles in table order, 4 columns):


## E1M1 — 13 viewpoints

![E1M1 montage](../render/goldens/maps/e1m1-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m1-spawn` | -416 | 256 | 0° | player1 start thing, designer angle; stand: BSP sec140 L192 f0/c128 AQF054/SLIME14 |
| `e1m1-spawn-alt` | -416 | 256 | 180° | player1 start thing, designer angle; stand: BSP sec140 L192 f0/c128 AQF054/SLIME14 |
| `e1m1-keydoor-0` | 832 | 1608 | 270° | ln421 sp26 standoff perpendicular, facing the line; stand: BSP sec87 L192 f-136/c8 AQF070/AQF012 |
| `e1m1-keydoor-1` | 832 | 1368 | 90° | ln423 sp26 standoff perpendicular, facing the line; stand: BSP sec56 L128 f-128/c64 FLOOR5_2/SLIME14 |
| `e1m1-exit` | -304 | 1296 | 180° | ln407 sp11 standoff perpendicular, facing the line; stand: BSP sec66 L160 f-128/c8 FLAT5_4/FLAT1 |
| `e1m1-far-nook` | 3018 | 2138 | 225° | sec7 centroid walk-back, argmax-contrast angle; stand: BSP sec7 L160 f184/c304 MFLR8_3/MFLR8_3 |
| `e1m1-tall` | 1207 | 853 | 270° | sec0 centroid walk-back, argmax-contrast angle; stand: BSP sec0 L202 f-160/c376 RROCK18/CEIL5_1 |
| `e1m1-bright` | 2537 | 605 | 225° | sec124 centroid walk-back, argmax-contrast angle; stand: BSP sec124 L220 f24/c384 RROCK18/RROCK17 |
| `e1m1-busy` | 2203 | -201 | 135° | sec134 n=21 centroid walk-back, argmax-contrast angle; stand: BSP sec134 L160 f136/c264 CEIL5_1/FLAT1 |
| `e1m1-masked` | 2024 | 1413 | 216° | ln1 midtex standoff perpendicular, facing the line; stand: BSP sec7 L160 f184/c304 MFLR8_3/MFLR8_3 |
| `e1m1-door` | 2160 | -416 | 180° | ln998 sp2 standoff perpendicular, facing the line; stand: BSP sec120 L192 f128/c272 FWATER1/NUKAGE1 |
| `e1m1-lift` | 1428 | -376 | 270° | ln1075 sp62 standoff perpendicular, facing the line; stand: BSP sec144 L160 f-8/c296 AQF024/FWATER1 |
| `e1m1-corridor-0` | 880 | 1808 | 0° | corridor sec87 elongated lit sector, end standoff on the long axis; stand: BSP sec87 L192 f-136/c8 AQF070/AQF012 |


## E1M2 — 12 viewpoints

![E1M2 montage](../render/goldens/maps/e1m2-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m2-spawn` | 608 | 48 | 270° | player1 start thing, designer angle; stand: BSP sec182 L192 f0/c128 FLOOR4_1/CEIL3_5 |
| `e1m2-spawn-alt` | 608 | 48 | 90° | player1 start thing, designer angle; stand: BSP sec182 L192 f0/c128 FLOOR4_1/CEIL3_5 |
| `e1m2-keydoor-0` | 1112 | -160 | 0° | ln151 sp28 standoff perpendicular, facing the line; stand: BSP sec4 L208 f-8/c88 FLOOR0_3/FLAT5_5 |
| `e1m2-keydoor-1` | 832 | -1408 | 0° | ln260 sp26 standoff perpendicular, facing the line; stand: BSP sec59 L144 f128/c256 FLAT5_4/FLAT1 |
| `e1m2-exit` | 1978 | -2184 | 264° | ln1974 sp19 standoff perpendicular, facing the line; stand: BSP sec350 L224 f72/c200 FLAT14/FLAT14 |
| `e1m2-secret` | 584 | -2520 | 90° | ln1854 sp103 standoff perpendicular, facing the line; stand: BSP sec263 L128 f64/c160 FLOOR4_8/CEIL3_5 |
| `e1m2-tall` | 1541 | -10 | 225° | sec178 centroid walk-back, argmax-contrast angle; stand: BSP sec178 L178 f-1024/c-48 SLIME01/CEIL5_3 |
| `e1m2-bright` | 2136 | -2240 | 135° | sec102 centroid walk-back, argmax-contrast angle; stand: BSP sec102 L224 f72/c200 FLAT14/FLAT14 |
| `e1m2-busy` | 216 | -439 | 315° | sec8 n=13 centroid walk-back, argmax-contrast angle; stand: BSP sec8 L224 f0/c320 RROCK19/F_SKY1 |
| `e1m2-masked` | 664 | -896 | 90° | ln0 midtex standoff perpendicular, facing the line; stand: BSP sec11 L144 f-8/c184 FLAT1/FLAT5_5 |
| `e1m2-door` | 720 | -2784 | 0° | ln515 sp2 standoff perpendicular, facing the line; stand: BSP sec269 L144 f64/c320 FLOOR5_2/CEIL5_1 |
| `e1m2-lift` | 1472 | -1408 | 180° | ln219 sp62 standoff perpendicular, facing the line; stand: BSP sec44 L128 f240/c368 STEP2/CEIL5_1 |


## E1M3 — 12 viewpoints

![E1M3 montage](../render/goldens/maps/e1m3-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m3-spawn` | -788 | -216 | 90° | player1 start thing, designer angle; stand: BSP sec0 L180 f0/c120 FLOOR5_2/F_SKY1 |
| `e1m3-spawn-alt` | -788 | -216 | 270° | player1 start thing, designer angle; stand: BSP sec0 L180 f0/c120 FLOOR5_2/F_SKY1 |
| `e1m3-keydoor-0` | -1024 | 104 | 180° | ln708 sp31 standoff perpendicular, facing the line; stand: BSP sec5 L164 f0/c128 FLOOR5_2/CEIL5_2 |
| `e1m3-keydoor-1` | -1264 | 104 | 0° | ln710 sp32 standoff perpendicular, facing the line; stand: BSP sec149 L160 f16/c104 FLOOR5_1/CEIL4_2 |
| `e1m3-exit` | -1296 | 1004 | 225° | ln2024 sp138 standoff perpendicular, facing the line; stand: BSP sec22 L150 f56/c152 FLOOR5_1/CEIL3_5 |
| `e1m3-secret` | -952 | 2152 | 270° | ln361 sp103 standoff perpendicular, facing the line; stand: BSP sec89 L150 f104/c288 FLOOR4_8/CEIL5_1 |
| `e1m3-tall` | -96 | 123 | 135° | sec2 centroid walk-back, argmax-contrast angle; stand: BSP sec2 L164 f-104/c128 NUKAGE1/CEIL5_2 |
| `e1m3-bright` | -505 | 1720 | 225° | sec64 centroid walk-back, argmax-contrast angle; stand: BSP sec64 L255 f-33/c23 FLOOR7_1/FLOOR7_1 |
| `e1m3-busy` | -508 | 290 | 135° | sec5 n=21 centroid walk-back, argmax-contrast angle; stand: BSP sec5 L164 f0/c128 FLOOR5_2/CEIL5_2 |
| `e1m3-masked` | -768 | 152 | 270° | ln6 midtex standoff perpendicular, facing the line; stand: BSP sec20 L196 f0/c168 FLOOR5_2/F_SKY1 |
| `e1m3-door` | -1144 | 848 | 270° | ln149 sp1 standoff perpendicular, facing the line; stand: BSP sec22 L150 f56/c152 FLOOR5_1/CEIL3_5 |
| `e1m3-lift` | -1376 | 1568 | 90° | ln261 sp62 standoff perpendicular, facing the line; stand: BSP sec34 L136 f0/c128 FLOOR4_8/CEIL5_1 |


## E1M4 — 14 viewpoints

![E1M4 montage](../render/goldens/maps/e1m4-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m4-spawn` | 896 | -1760 | 90° | player1 start thing, designer angle; stand: BSP sec21 L160 f-8/c160 FLAT14/F_SKY1 |
| `e1m4-spawn-alt` | 896 | -1760 | 270° | player1 start thing, designer angle; stand: BSP sec21 L160 f-8/c160 FLAT14/F_SKY1 |
| `e1m4-keydoor-0` | 1992 | -704 | 180° | ln267 sp27 standoff perpendicular, facing the line; stand: BSP sec29 L135 f16/c144 FLOOR0_3/CEIL3_5 |
| `e1m4-keydoor-1` | 1752 | -704 | 0° | ln272 sp27 standoff perpendicular, facing the line; stand: BSP sec27 L135 f8/c144 FLOOR0_3/CEIL3_5 |
| `e1m4-exit` | 704 | 2136 | 180° | ln1996 sp11 standoff perpendicular, facing the line; stand: BSP sec141 L160 f-72/c56 FLOOR4_8/FLOOR4_8 |
| `e1m4-secret` | -1120 | -832 | 270° | ln1892 sp126 standoff perpendicular, facing the line; stand: BSP sec46 L145 f-104/c24 FLAT19/FLAT1 |
| `e1m4-tall` | 637 | -236 | 180° | sec151 centroid walk-back, argmax-contrast angle; stand: BSP sec151 L150 f-112/c160 NUKAGE1/CEIL5_2 |
| `e1m4-bright` | 1760 | 813 | 225° | sec201 centroid walk-back, argmax-contrast angle; stand: BSP sec201 L208 f-240/c-128 FLOOR4_8/CEIL5_2 |
| `e1m4-busy` | -1705 | -396 | 45° | sec233 n=27 centroid walk-back, argmax-contrast angle; stand: BSP sec233 L130 f-264/c-136 FLOOR4_6/FLAT1 |
| `e1m4-masked` | 896 | -1344 | 270° | ln1 midtex standoff perpendicular, facing the line; stand: BSP sec1 L130 f0/c144 FLOOR0_3/CEIL3_5 |
| `e1m4-door` | 64 | -488 | 270° | ln79 sp1 standoff perpendicular, facing the line; stand: BSP sec6 L135 f16/c144 FLOOR0_3/CEIL3_5 |
| `e1m4-lift` | -576 | -704 | 180° | ln326 sp62 standoff perpendicular, facing the line; stand: BSP sec33 L165 f0/c160 STEP1/F_SKY1 |
| `e1m4-corridor-0` | 126 | 1600 | 90° | corridor sec184 elongated lit sector, end standoff on the long axis; stand: BSP sec184 L140 f-64/c64 CEIL5_2/CEIL3_5 |
| `e1m4-corridor-1` | -955 | 496 | 90° | corridor sec34 elongated lit sector, end standoff on the long axis; stand: BSP sec34 L165 f-256/c160 FLOOR0_1/F_SKY1 |


## E1M5 — 14 viewpoints

![E1M5 montage](../render/goldens/maps/e1m5-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m5-spawn` | -4768 | 1296 | 0° | player1 start thing, designer angle; stand: BSP sec5 L256 f-16/c56 FLOOR5_2/FLAT2 |
| `e1m5-spawn-alt` | -4768 | 1296 | 180° | player1 start thing, designer angle; stand: BSP sec5 L256 f-16/c56 FLOOR5_2/FLAT2 |
| `e1m5-keydoor-0` | -3312 | 1440 | 180° | ln1156 sp31 standoff perpendicular, facing the line; stand: BSP sec7 L176 f-16/c120 FLOOR5_2/CEIL3_3 |
| `e1m5-keydoor-1` | -3536 | 1440 | 0° | ln1171 sp31 standoff perpendicular, facing the line; stand: BSP sec13 L192 f-16/c240 FLOOR5_2/F_SKY1 |
| `e1m5-exit` | -992 | 1088 | 180° | ln634 sp11 standoff perpendicular, facing the line; stand: BSP sec56 L192 f-16/c176 FLOOR4_8/FLAT19 |
| `e1m5-secret` | -1408 | 1088 | 0° | ln633 sp126 standoff perpendicular, facing the line; stand: BSP sec60 L144 f-32/c112 SLIME01/CEIL5_2 |
| `e1m5-tall` | 352 | 1440 | 180° | sec82 centroid walk-back, argmax-contrast angle; stand: BSP sec82 L256 f-40/c208 FLOOR4_1/TLITE6_6 |
| `e1m5-bright` | -2656 | 1440 | 0° | sec1 centroid walk-back, argmax-contrast angle; stand: BSP sec1 L256 f-16/c176 FLOOR5_2/TLITE6_6 |
| `e1m5-busy` | -861 | 699 | 0° | sec56 n=28 centroid walk-back, argmax-contrast angle; stand: BSP sec56 L192 f-16/c176 FLOOR4_8/FLAT19 |
| `e1m5-masked` | -768 | 416 | 180° | ln4 midtex standoff perpendicular, facing the line; stand: BSP sec56 L192 f-16/c176 FLOOR4_8/FLAT19 |
| `e1m5-door` | 1472 | 1008 | 90° | ln1202 sp1 standoff perpendicular, facing the line; stand: BSP sec127 L192 f-32/c112 FLAT3/CEIL3_3 |
| `e1m5-lift` | 1472 | 1728 | 90° | ln654 sp62 standoff perpendicular, facing the line; stand: BSP sec76 L192 f-16/c112 FLOOR4_8/FLAT19 |
| `e1m5-corridor-0` | 1072 | -281 | 0° | corridor sec163 elongated lit sector, end standoff on the long axis; stand: BSP sec163 L192 f72/c208 CEIL4_1/FLAT19 |
| `e1m5-corridor-1` | -1584 | 1440 | 180° | corridor sec86 elongated lit sector, end standoff on the long axis; stand: BSP sec86 L192 f-16/c112 FLOOR4_8/FLAT19 |


## E1M6 — 14 viewpoints

![E1M6 montage](../render/goldens/maps/e1m6-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m6-spawn` | 0 | -160 | 90° | player1 start thing, designer angle; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3 |
| `e1m6-spawn-alt` | 0 | -160 | 270° | player1 start thing, designer angle; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3 |
| `e1m6-keydoor-0` | -912 | 1024 | 0° | ln118 sp28 standoff perpendicular, facing the line; stand: BSP sec140 L176 f0/c192 FLOOR5_4/FLOOR0_6 |
| `e1m6-keydoor-1` | 1920 | 480 | 180° | ln603 sp32 standoff perpendicular, facing the line; stand: BSP sec232 L208 f-72/c64 FLAT18/CEIL5_2 |
| `e1m6-exit` | -744 | -80 | 0° | ln1546 sp11 standoff perpendicular, facing the line; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3 |
| `e1m6-secret` | 1000 | 480 | 180° | ln1464 sp103 standoff perpendicular, facing the line; stand: BSP sec237 L208 f-72/c96 FLAT18/FLAT14 |
| `e1m6-tall` | -1818 | -1677 | 45° | sec178 centroid walk-back, argmax-contrast angle; stand: BSP sec178 L192 f-512/c128 NUKAGE1/FLOOR0_6 |
| `e1m6-bright` | -780 | 1351 | 315° | sec263 centroid walk-back, argmax-contrast angle; stand: BSP sec263 L224 f72/c176 FLOOR0_3/FLAT5_4 |
| `e1m6-busy` | -801 | -519 | 45° | sec151 n=125 centroid walk-back, argmax-contrast angle; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3 |
| `e1m6-masked` | 296 | -296 | 135° | ln1 midtex standoff perpendicular, facing the line; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3 |
| `e1m6-door` | 992 | 528 | 90° | ln1110 sp1 standoff perpendicular, facing the line; stand: BSP sec154 L160 f-72/c96 FLAT18/FLAT14 |
| `e1m6-lift` | -736 | 448 | 270° | ln512 sp62 standoff perpendicular, facing the line; stand: BSP sec363 L192 f0/c384 STEP2/CEIL3_5 |
| `e1m6-corridor-0` | -2313 | -2416 | 270° | corridor sec193 elongated lit sector, end standoff on the long axis; stand: BSP sec193 L224 f-384/c0 NUKAGE1/F_SKY1 |
| `e1m6-corridor-1` | 459 | 880 | 90° | corridor sec59 elongated lit sector, end standoff on the long axis; stand: BSP sec59 L224 f-32/c288 MFLR8_2/F_SKY1 |


## E1M7 — 14 viewpoints

![E1M7 montage](../render/goldens/maps/e1m7-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m7-spawn` | 0 | -232 | 90° | player1 start thing, designer angle; stand: BSP sec16 L192 f0/c96 FLAT14/CEIL5_2 |
| `e1m7-spawn-alt` | 0 | -232 | 270° | player1 start thing, designer angle; stand: BSP sec16 L192 f0/c96 FLAT14/CEIL5_2 |
| `e1m7-keydoor-0` | -504 | 896 | 0° | ln130 sp27 standoff perpendicular, facing the line; stand: BSP sec693 L192 f0/c128 RROCK03/RROCK03 |
| `e1m7-keydoor-1` | -256 | 896 | 180° | ln131 sp27 standoff perpendicular, facing the line; stand: BSP sec73 L160 f32/c176 FLAT19/FLAT19 |
| `e1m7-exit` | -936 | 704 | 180° | ln3975 sp11 standoff perpendicular, facing the line; stand: BSP sec376 L192 f-256/c160 FLOOR6_2/F_SKY1 |
| `e1m7-secret` | -416 | 1632 | 90° | ln283 sp103 standoff perpendicular, facing the line; stand: BSP sec33 L144 f8/c144 FLOOR4_8/MFLR8_1 |
| `e1m7-tall` | 3153 | 663 | 135° | sec229 centroid walk-back, argmax-contrast angle; stand: BSP sec229 L144 f-248/c256 NUKAGE1/CEIL3_5 |
| `e1m7-bright` | 1408 | 2816 | 315° | sec592 centroid walk-back, argmax-contrast angle; stand: BSP sec592 L255 f296/c360 CEIL3_5/CEIL3_5 |
| `e1m7-busy` | -989 | 2191 | 315° | sec456 n=24 centroid walk-back, argmax-contrast angle; stand: BSP sec456 L208 f0/c144 TLITE6_5/MFLR8_1 |
| `e1m7-masked` | 0 | 256 | 270° | ln3 midtex standoff perpendicular, facing the line; stand: BSP sec5 L192 f0/c128 SLIME13/FLAT1 |
| `e1m7-door` | 0 | -40 | 90° | ln19 sp1 standoff perpendicular, facing the line; stand: BSP sec0 L192 f0/c128 FLAT14/FLAT23 |
| `e1m7-lift` | 1984 | 1152 | 270° | ln645 sp62 standoff perpendicular, facing the line; stand: BSP sec627 L160 f-24/c72 FLOOR0_3/FLAT3 |
| `e1m7-corridor-0` | 619 | -1056 | 270° | corridor sec147 elongated lit sector, end standoff on the long axis; stand: BSP sec147 L192 f-96/c160 CEIL5_2/F_SKY1 |
| `e1m7-corridor-1` | -1261 | -816 | 270° | corridor sec376 elongated lit sector, end standoff on the long axis; stand: BSP sec376 L192 f-256/c160 FLOOR6_2/F_SKY1 |


## E1M8 — 11 viewpoints

![E1M8 montage](../render/goldens/maps/e1m8-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m8-spawn` | 2464 | 360 | 270° | player1 start thing, designer angle; stand: BSP sec83 L224 f-136/c256 STEP1/F_SKY1 |
| `e1m8-spawn-alt` | 2464 | 360 | 90° | player1 start thing, designer angle; stand: BSP sec83 L224 f-136/c256 STEP1/F_SKY1 |
| `e1m8-keydoor-0` | 3232 | -704 | 90° | ln868 sp31 standoff perpendicular, facing the line; stand: BSP sec93 L224 f24/c168 SLIME13/SLIME13 |
| `e1m8-exit` | -124 | 316 | 135° | ln894 sp19 standoff perpendicular, facing the line; stand: BSP sec17 L224 f-16/c256 MFLR8_2/F_SKY1 |
| `e1m8-far-nook` | 132 | -1212 | 45° | sec39 centroid walk-back, argmax-contrast angle; stand: BSP sec39 L128 f0/c112 FLOOR7_2/FLOOR6_2 |
| `e1m8-tall` | 928 | -1575 | 135° | sec32 centroid walk-back, argmax-contrast angle; stand: BSP sec32 L160 f-8/c200 CEIL5_2/FLOOR7_2 |
| `e1m8-bright` | 3228 | -1688 | 135° | sec93 centroid walk-back, argmax-contrast angle; stand: BSP sec93 L224 f24/c168 SLIME13/SLIME13 |
| `e1m8-busy` | 2464 | 320 | 180° | sec83 n=8 centroid walk-back, argmax-contrast angle; stand: BSP sec83 L224 f-136/c256 STEP1/F_SKY1 |
| `e1m8-masked` | -139 | -9 | 336° | ln20 midtex standoff perpendicular, facing the line; stand: BSP sec17 L224 f-16/c256 MFLR8_2/F_SKY1 |
| `e1m8-corridor-0` | 1584 | 50 | 180° | corridor sec54 elongated lit sector, end standoff on the long axis; stand: BSP sec54 L224 f0/c256 RROCK19/F_SKY1 |
| `e1m8-corridor-1` | -464 | 21 | 180° | corridor sec7 elongated lit sector, end standoff on the long axis; stand: BSP sec7 L224 f0/c256 MFLR8_2/F_SKY1 |


## E1M9 — 13 viewpoints

![E1M9 montage](../render/goldens/maps/e1m9-montage.png)

| scene | x | y | ang | derivation |
|---|---:|---:|---:|---|
| `e1m9-spawn` | -216 | -160 | 180° | player1 start thing, designer angle; stand: BSP sec2 L192 f-8/c104 FLAT5/CEIL3_4 |
| `e1m9-spawn-alt` | -216 | -160 | 0° | player1 start thing, designer angle; stand: BSP sec2 L192 f-8/c104 FLAT5/CEIL3_4 |
| `e1m9-keydoor-0` | -416 | 648 | 270° | ln46 sp31 standoff perpendicular, facing the line; stand: BSP sec19 L176 f-72/c184 FLAT10/CEIL3_3 |
| `e1m9-keydoor-1` | -416 | 400 | 90° | ln87 sp31 standoff perpendicular, facing the line; stand: BSP sec10 L176 f-72/c56 FLAT10/CEIL3_3 |
| `e1m9-exit` | 1312 | 720 | 270° | ln1662 sp11 standoff perpendicular, facing the line; stand: BSP sec59 L144 f-8/c136 FLOOR0_3/MFLR8_1 |
| `e1m9-secret` | 8 | 2960 | 90° | ln883 sp103 standoff perpendicular, facing the line; stand: BSP sec163 L160 f120/c232 FLOOR0_5/CEIL3_5 |
| `e1m9-tall` | 1203 | 2328 | 225° | sec145 centroid walk-back, argmax-contrast angle; stand: BSP sec145 L176 f-96/c264 NUKAGE1/CEIL3_5 |
| `e1m9-bright` | 1634 | 1826 | 180° | sec114 centroid walk-back, argmax-contrast angle; stand: BSP sec114 L240 f40/c168 FLOOR0_3/CEIL3_5 |
| `e1m9-busy` | -948 | 3143 | 315° | sec264 n=23 centroid walk-back, argmax-contrast angle; stand: BSP sec264 L160 f112/c240 FLAT5/CEIL3_5 |
| `e1m9-masked` | -352 | -160 | 0° | ln1 midtex standoff perpendicular, facing the line; stand: BSP sec1 L176 f-8/c104 FLAT5/CEIL3_3 |
| `e1m9-door` | 928 | 1536 | 180° | ln344 sp1 standoff perpendicular, facing the line; stand: BSP sec106 L160 f-72/c184 FLAT5/CEIL3_5 |
| `e1m9-lift` | 1056 | 3440 | 180° | ln951 sp62 standoff perpendicular, facing the line; stand: BSP sec194 L160 f-104/c120 FLAT5/F_SKY1 |
| `e1m9-corridor-0` | -368 | 1484 | 180° | corridor sec60 elongated lit sector, end standoff on the long axis; stand: BSP sec60 L160 f-72/c208 FLAT5/F_SKY1 |

## How to re-review (D016 session)

1. `node scripts/goldens-update.mjs --set maps --check` must print
   `goldens: no drift` (any DRIFT on an EXISTING set is a FINDING, never a
   silent re-bless — re-bless only via `--set maps --reason "..."` with the
   reason recorded in meta.json).
2. Open each montage PNG above (or `test-results/goldens/maps/` after a
   review run); tick the VISUAL-REVIEW table: walls textured (not flat
   gray), flats plausible, sprites upright, sky where the derivation says
   F_SKY1, no obvious HOM warp streaks (machine-asserted 0 regardless).
3. Machine gates: `npx vitest run tests/render/allMaps` +
   `node scripts/goldens-update.mjs --check` over every set (existing sets
   byte-identical — this task adds only `maps/`).

