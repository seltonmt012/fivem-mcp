# Debugging FiveM scripts through the bridge

## Triage ladder

Work top to bottom; each rung tells you whether the problem is below it.

1. **`fivem_bridge_status`** — is a client connected at all, how fresh is the heartbeat, what
   did the bridge resource last log? If `fivem_run_code` behaves as if a stale payload were
   running, run `/fivem_reload` via `fivem_execute_command`. If nothing is connected, the game may
   be down — `fivem_launch` (and `fivem_read_crash` still works with the game dead).
2. **`fivem_read_log`** with a `filter` — client-side script errors look like:

   ```
   SCRIPT ERROR: @myres/client.lua:12: attempt to index a nil value (global 'Config')
   ```

   Filter on your resource name, `SCRIPT ERROR`, or a unique tag you printed. The filter is
   applied before the tail, so it searches deeper than the last N lines.
3. **`fivem_server_console`** — server-side errors, resource start/stop history, deploy
   feedback. Every response ends with `Next cursor: <n>`; pass it back to read only what's
   new instead of re-reading the buffer.
4. **`fivem_read_crash`** — when the client died. Call it with no arguments for the latest
   dump plus the crash reason correlated from the logs. Sections (e.g. `POOL INFO`) are large;
   always pair `section` with `filter`.

## Failure signatures

| Symptom | Likely cause |
|---|---|
| `ensure <name>`: "couldn't find resource" | New folder/link without `refresh` first |
| Newly added file silently not running after `restart` | Manifest edited without `refresh` (restart serves cached manifest metadata) |
| `fivem_run_code` times out but the game is fine | Snippet blocks instead of returning — move the waiting part into `ctx.thread(...)` |
| Log lines from your loop appear 2x/3x after reloads | Long-running loop without a `ctx.alive()` check — old copies survive payload reloads |
| Game freezes on a snippet, then a runaway-instruction error | Hot loop without `Wait(0)`; the guard only saved you on the main coroutine |
| Screenshot is a black frame | Exclusive fullscreen — ask the user to switch to borderless windowed |
| Command "did nothing" | Check the `registered:` field in the `fivem_execute_command` response — unregistered verb vs. silent success are different bugs |
| Empty capture from a server command | Ran silently, doesn't exist, or txAdmin account lacks *Console: Write* — cross-check with a probe |
| Marker/text visible for one frame only | Draw natives render a single frame; they must be called every frame from a `Wait(0)` loop |
| `attempt to index a nil value (global 'Config')` | Load order: `config.lua` missing from `shared_scripts` or listed after its consumer |

This table is curated. When nothing here matches, check `references/lessons.md` — the
accumulation layer where new surprises land; lessons that prove stable graduate into rows
here.

## When the bridge looks dead

Do **not** stop/start the bridge resource to "fix" it — `stop` is blocked, and the loader
reconnects on its own with no startup-order requirement (it retries until the MCP server is
there). In order: wait a few seconds and re-check `fivem_bridge_status`; then `/fivem_reload`
in-game; then, with the user aware, `fivem_launch` with `force: true` to relaunch the game.
After a **server** restart the same applies — the client reconnects to the server and the
bridge follows by itself.
