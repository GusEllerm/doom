# R10: Audio Research — Sound Lumps, MUS Format, Channel Allocation

> Research for a from-scratch TypeScript recreation of DOOM (Web Audio API, Doom 1 WAD format, Freedoom target).
> Sources: id GPL source `/tmp/DOOM-master/linuxdoom-1.10/`, Chocolate Doom `/tmp/chocolate-doom-master/`, `/tmp/freedoom-0.13.0/freedoom1.wad`.

## Table of Contents
1. [Sound lump format (DS* lumps)](#1-sound-lump-format-ds-lumps)
   - [1.1 Header layout](#11-header-layout)
   - [1.2 Sample data encoding and 0x7F..0x7F wrapping](#12-sample-data-encoding-and-0x7f0x7f-wrapping)
   - [1.3 EMPIRICAL: DS lump stats from freedoom1.wad](#13-empirical-ds-lump-stats-from-freedoom1wad)
2. [sfxinfo table and sound playback path](#2-sfxinfo-table-and-sound-playback-path)
   - [2.1 sfxinfo_t struct and sfx_atomatten enums](#21-sfxinfo_t-struct-and-sfx_atomatten-enums)
   - [2.2 sfxinfo table (transcribed)](#22-sfxinfo-table-transcribed)
   - [2.3 S_StartSound call sites and mixing](#23-s_startsound-call-sites-and-mixing)
   - [2.4 Distance attenuation, panning, priority](#24-distance-attenuation-panning-priority)
3. [MUS format](#3-mus-format)
   - [3.1 Header layout](#31-header-layout)
   - [3.2 Event encoding](#32-event-encoding)
   - [3.3 Channel map (mus_chandata)](#33-channel-map-mus_chandata)
   - [3.4 Tempo and timing](#34-tempo-and-timing)
4. [Decoding pipeline design for us](#4-decoding-pipeline-design-for-us)
5. [Music selection and looping](#5-music-selection-and-looping)
6. [Sound retrigger / priority policy (8-16 channel allocator)](#6-sound-retrigger--priority-policy)
7. [Volume model](#7-volume-model)
8. [Freedoom audio license / attribution](#8-freedoom-audio-license--attribution)
9. [Confidence and sources](#9-confidence-and-sources)

## 1. Sound lump format (DS* lumps)
(TBD)

## 2. sfxinfo table and sound playback path
(TBD)

## 3. MUS format
(TBD)

## 4. Decoding pipeline design for us
(TBD)

## 5. Music selection and looping
(TBD)

## 6. Sound retrigger / priority policy
(TBD)

## 7. Volume model
(TBD)

## 8. Freedoom audio license / attribution
(TBD)

## 9. Confidence and sources
(TBD)
