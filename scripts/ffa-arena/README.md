# ffa-arena

A complete free-for-all deathmatch: a lobby you join from, an arena in its own routing
bucket, random spawn points, a fixed loadout, server-authoritative kill/death tracking,
automatic respawn and a NUI scoreboard.

## How it plays

1. You start in the **lobby** (Legion Square). A blip and an orange marker mark the entry
   point — walk into it and press **E**, or type `/arena`.
2. You are moved into the **arena** (Sandy Shores Airfield) in routing bucket 50, so lobby
   players are in a different world: they cannot be seen or shot from inside.
3. You spawn at one of eight random points, with 100 armour and the configured weapons, and
   are invincible for 3 s (`SPAWN PROTECTION` on the HUD).
4. Every death is reported to the server, which decides whether it counts and who — if
   anyone — gets the kill. The scoreboard updates for everyone in the arena.
5. After 4 s you respawn automatically at a fresh random point. The server prefers the spawn
   furthest from the living opposition, so you never materialise in front of a rifle.
6. The first player to **15 kills** wins the round. A banner shows for 6 s, then all scores
   reset and everybody respawns.
7. `/arenaleave` puts you back in the lobby, without weapons.

## Commands

| Command | Effect |
|---|---|
| `/arena` | Join the arena (same path as the lobby marker) |
| `/arenaleave` | Return to the lobby |

## Layout

```
ffa-arena/
├── fxmanifest.lua
├── config.lua        -- shared: arena, lobby, spawns, loadout, timings
├── client/main.lua   -- lobby marker, entry/exit, loadout, death detection, respawn, NUI
├── server/main.lua   -- participants, spawn choice, kill/death scoring, rounds, buckets
└── html/             -- the scoreboard (HUD only, never takes NUI focus)
```

## Trust boundary

Clients report only *that they died* and who they believe killed them. The server takes the
victim from the event source (which cannot be forged), credits a kill only if the claimed
killer is actually in the arena and is not the victim, and drops death reports that arrive
less than `Config.MinDeathReportGapMs` apart.

## Notes

- `spawnmanager`'s auto spawn is switched off while in the arena and restored on leave and
  on resource stop, otherwise it respawns you on a map spawn point instead of an arena one.
- Ambient population is disabled in the arena bucket, so the airfield stays empty.
- Spawn protection uses `SetPlayerInvincible`, not `SetEntityInvincible` — only the player
  flag is reported by `GetPlayerInvincible`.
- `Config.Loadout` ammo is capped by the engine's per-weapon maximum (250 for the carbine).
