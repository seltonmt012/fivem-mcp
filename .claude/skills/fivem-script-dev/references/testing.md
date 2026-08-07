# Testing and verification patterns

The standard of done: **a feature is finished when a log line, a screenshot, or a
`fivem_run_code` probe proves it works in the running game — not when the code looks right.**
Every increment gets verified before you build the next one on top of it.

## Pattern 1: prototype-first

Never integrate an unverified native or approach into a script file. Verify it live first:

1. `fivem_native_info` with the name or keywords (`probeClient` defaults to true, so a single
   exact hit also confirms the native exists on the connected client). This catches invented
   names and wrong parameter orders before anything runs.
2. Run the risky part as a one-shot snippet with `fivem_run_code`. The snippet runs in the real
   client script environment with all natives available.
3. Only once the probe behaves, write the verified code into the script file. If an
   approach failed for a reason worth warning the next session about, record it in
   `references/lessons.md` before moving on.

Synchronous probe — the return value is the answer:

```lua
local ped = PlayerPedId()
local pos = GetEntityCoords(ped)
return { ped = ped, x = pos.x, y = pos.y, z = pos.z, dead = IsEntityDead(ped) }
```

Anything that waits (model loading, animations, watching state change) goes in `ctx.thread`,
because the snippet itself must return immediately:

```lua
ctx.thread(function()
    local model = `prop_barrel_02a`
    RequestModel(model)
    while not HasModelLoaded(model) do Wait(50) end
    local pos = GetEntityCoords(PlayerPedId())
    local obj = CreateObject(model, pos.x + 2.0, pos.y, pos.z, false, false, false)
    ctx.log('spawned object %s, exists=%s', obj, DoesEntityExist(obj))
end)
return 'spawning in background, check log'
```

### The ctx API (available in every snippet)

| Field | Meaning |
|---|---|
| `ctx.thread(fn)` | Run `fn` on a game thread that may `Wait()` |
| `ctx.alive()` | False once the payload is reloaded — **every long/infinite loop must check it** or the loop survives reloads and stacks up |
| `ctx.log(fmt, ...)` | printf-style line into the client log (captured by `captureLog`) |
| `ctx.resource` | Bridge resource name |

### Snippet limits

- Max 16 KB of source; no bytecode. Big experiments belong in a real (throwaway) resource.
- Unknown natives are rejected before the code is sent (strict mode) with suggestions.
- Return values are sanitized: depth 5, 60 keys per table, strings truncated at 2000 chars;
  `vector3`/functions/userdata come back as descriptive strings; `nil` becomes `'<nil>'`.
- A runaway-instruction guard converts `while true do end` into an error — but only on the
  snippet's own coroutine, so a hot loop inside `ctx.thread` must still `Wait(0)`.

Source of truth: the limits are the `MAX_RESULT_*` constants in
`fivem-mcp-bridge/payload/client.lua` and `code.maxBytes`; the canonical tool doc is the
`fivem_run_code` section of `mcp-server/README.md`.

## Pattern 2: temporary test command

Many features are triggered by something you cannot do from tools — walking into a marker,
pressing a keybind, an NPC interaction. Do not skip verification; give the feature a
temporary command trigger so you can invoke it:

```lua
-- TEMP-TEST: remove before finishing
RegisterCommand('zt_test_fire', function()
    startZoneEffect()          -- the same function the real trigger will call
end, false)
```

Rules for this pattern:

- The temp command calls **the same function** as the real trigger, so passing the test means
  the feature works — only the trigger wiring remains, which you verify separately as far as
  possible (e.g. probe the zone check with `fivem_run_code` at known coords).
- Tag every temporary block with `TEMP-TEST` on its own comment line.
- Invoke it with `fivem_execute_command('zt_test_fire')` — the result tells you whether the
  verb is even registered, which distinguishes "command missing" from "command did nothing".
- Verify the effect (evidence section below).
- **Cleanup is part of the task**: grep the resource for `TEMP-TEST` (must be zero hits),
  remove the blocks, `restart` the resource, then run the command once more — the response
  must now report the verb as unregistered.

The same trick works for parameters: a temp command like `zt_test_tp x y z` lets you test at
arbitrary coordinates without walking there.

## What counts as evidence

After each action, collect at least one of:

- **Log**: `captureLog` on `fivem_run_code`/`fivem_execute_command` returns what the action
  printed; `fivem_read_log` with a `filter` (use your resource name or a unique tag in your
  prints) covers everything else. A clean run of a new script still needs a look at the log —
  script errors don't throw back through the tools.
- **State probe**: `fivem_run_code` asserting the world changed —
  `DoesEntityExist(obj)`, `#(GetEntityCoords(ped) - expected) < 2.0`,
  `GetResourceState('myres') == 'started'`, `IsPedInAnyVehicle(ped, false)`.
- **Screenshot**: `fivem_screenshot` for anything visual — markers, blips, NUI, spawned props,
  text. Look at the image; "the call succeeded" is not evidence the pixels are right.
  (Exclusive fullscreen captures black — ask the user to switch to borderless windowed.)

## Testing server-side logic

The bridge executes code on the **client** only. To exercise `server.lua`:

- Trigger it the way the game would: a client event via a temp command or snippet —
  `TriggerServerEvent('myres:thing', args)`.
- Read the outcome in `fivem_server_console` (server `print()` lands there) and/or via the
  client-side reaction event.
- For pure server state, add a temp server command
  (`RegisterCommand('zt_dump', ..., true)`) and run it with `fivem_server_command`; its output
  is captured from the console. Same `TEMP-TEST` tagging and cleanup rules apply.
