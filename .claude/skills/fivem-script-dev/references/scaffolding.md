# Scaffolding a FiveM resource

## Where new resources live

Create each resource as its own folder under `scripts/` in this repo:

```
scripts/<resource-name>/
```

The folder is then linked (junction/symlink) into the FiveM server's `resources/` directory so
editing the repo edits the live resource — see `deploy-verify.md`. The repo copy is the source
of truth and is tracked in git.

Naming: lowercase, digits and hyphens only (`ping-marker`, `zone-alarm`). No spaces, no
brackets — `[brackets]` folders are category folders in FiveM and are ignored as resources.

## fxmanifest.lua template

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'you'
description 'What this resource does'
version '0.1.0'

shared_scripts {
    'config.lua',        -- only if the resource has one; shared loads first on both sides
}

client_scripts {
    'client.lua',
}

server_scripts {
    'server.lua',        -- only if the resource has a server side
}
```

Only list the sections you actually use — an empty `server_scripts {}` is noise. Every file a
script list names must exist, or the resource fails to start. Remember: **any edit to
fxmanifest.lua requires `refresh` before `restart`** (see `deploy-verify.md`).

## Structure by complexity tier

Start at the smallest tier that fits and move up only when the code forces you to.

### Tier 1 — single file

One `client.lua` (or `server.lua` for pure server logic). Right for one command, one effect,
one loop. Most requests land here; don't scaffold more than this without a reason.

### Tier 2 — client + server split

Add `server.lua` the moment state must be **authoritative, persistent, or visible to other
players**. Rule of thumb:

- **Client**: rendering (markers, blips, DrawText), input, camera, peds/props/vehicles the
  player sees, anything reading the local world.
- **Server**: money, inventory, cooldowns, permissions, anything a modified client could forge,
  anything that must synchronize across players.

The two sides talk through events — this is the whole pattern:

```lua
-- client.lua
TriggerServerEvent('myres:buy', itemId)
RegisterNetEvent('myres:bought', function(ok, reason)
    -- react to the server's verdict
end)

-- server.lua
RegisterNetEvent('myres:buy', function(itemId)
    local src = source          -- capture immediately; 'source' is not valid after a Wait()
    local ok = tryBuy(src, itemId)
    TriggerClientEvent('myres:bought', src, ok, ok and '' or 'not enough cash')
end)
```

Never trust event arguments from clients on the server — validate everything.

### Tier 3 — configurable

When the script has tunables (coords, models, colors, timings, keybinds), extract them into
`config.lua` as a `shared_scripts` entry exposing a `Config` table:

```lua
Config = {}
Config.MarkerColor = { r = 255, g = 80, b = 0, a = 120 }
Config.ZoneCenter  = vector3(215.9, -810.1, 30.7)
Config.CooldownMs  = 5000
```

Adding `config.lua` means editing the manifest → `refresh` then `restart`.

### Tier 4 — multi-module

When one side grows past roughly 300 lines or the resource has more than two distinct features,
split into folders with one concern per file:

```
scripts/<name>/
├── fxmanifest.lua
├── shared/config.lua
├── client/main.lua       -- wiring: commands, events, thread startup
├── client/markers.lua    -- one feature per file
├── client/zones.lua
└── server/main.lua
```

The manifest lists files **in load order** — a file can only use globals defined by files
listed before it. Keep `main.lua` last on each side so it can wire up what the feature files
defined.

## Minimal working example (tier 1)

`scripts/hello-marker/fxmanifest.lua`:

```lua
fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'dev'
description 'Draws a marker at the player for a few seconds'
version '0.1.0'

client_scripts { 'client.lua' }
```

`scripts/hello-marker/client.lua`:

```lua
RegisterCommand('hello-marker', function()
    local pos = GetEntityCoords(PlayerPedId())
    local until_ = GetGameTimer() + 5000
    CreateThread(function()
        while GetGameTimer() < until_ do
            DrawMarker(1, pos.x, pos.y, pos.z - 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
                1.5, 1.5, 1.0, 255, 80, 0, 120, false, false, 2, false, nil, nil, false)
            Wait(0)          -- DrawMarker draws for one frame; it must run every frame
        end
    end)
end, false)
```

Deploy it with the checklist in `deploy-verify.md`, then verify per `testing.md`.
