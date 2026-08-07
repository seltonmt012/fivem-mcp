---
name: fivem-script-dev
description: >-
  Build, test, and debug FiveM (GTA V) scripts and resources against a live game client and
  server using the fivem-mcp MCP tools (fivem_run_code, fivem_execute_command,
  fivem_server_command, ...). Use when creating or modifying a FiveM resource, writing Lua
  game scripts, working with fxmanifest.lua or GTA natives, testing in-game features, or
  debugging a FiveM client or txAdmin server.
---

# FiveM script development with the fivem-mcp bridge

You have a live GTA V client and FiveM server at your fingertips. The workflow that makes
this valuable: **verify in the running game before you integrate, and verify again after.**
Code that "should work" is a hypothesis; a log line, state probe, or screenshot is a result.

## Preflight

Start every scripting session with `fivem_bridge_status`. If no client is connected, launch
one with `fivem_launch` — if no default address is configured, **ask the user for the server
address; never guess an IP**. Cold start takes 60–120 s, so pass a generous `waitMs` and
re-check status afterwards.

Then read your memory: `references/lessons.md` (what past sessions learned the hard way)
and, if it exists, `.fivem-mcp/memory.md` at the repo root (facts about this machine —
resources dir, server address, display quirks). Trust a machine fact only as far as its
"Last verified" date; a quick probe beats a stale path.

## The pipeline

1. **Understand & size it.** Decide client-only vs client+server and the structure tier
   (single file → split → config → modules) — see `references/scaffolding.md`.
2. **Prototype before you write files.** Verify natives with `fivem_native_info`, then test
   the risky parts live with `fivem_run_code` on the client. Only integrate what you have
   seen work — see `references/testing.md`.
3. **Scaffold** the resource under `scripts/<name>/` in this repo (manifest template in
   `references/scaffolding.md`).
4. **Link** it into the server's `resources/` directory (junction/symlink). Discover or ask
   for that directory — never assume a path — see `references/deploy-verify.md`.
5. **Deploy**: new resource → `refresh` then `ensure <name>`; Lua edits → `restart <name>`;
   manifest edits → `refresh` then `restart <name>` (all via `fivem_server_command`).
6. **Implement incrementally.** One capability at a time; after each deploy, prove it with a
   captured log, a `fivem_run_code` state probe, or a screenshot. If the real trigger is a
   marker, keybind, or interaction you can't perform, add a `TEMP-TEST`-tagged temporary
   command that calls the same function, and drive it with `fivem_execute_command` — see
   `references/testing.md`.
7. **Clean up.** Grep the resource for `TEMP-TEST` (zero hits), remove debug prints,
   restart, and confirm the temp verbs are gone (`fivem_execute_command` reports
   unregistered verbs).
8. **Final check.** Full restart, exercise the real path as far as possible, read the log
   for errors, screenshot anything visual.

When something misbehaves, follow the triage ladder in `references/debugging.md`.

## Hard rules

- **Never `stop` the bridge resource** (`fivem-mcp-bridge`) — it severs your own connection
  with nothing in-game to restore it (the tool blocks it). Reload its payload with
  `/fivem_reload` via `fivem_execute_command`; `restart fivem-mcp-bridge` works but drops the
  bridge for a few seconds.
- **`refresh` before `restart`** after any `fxmanifest.lua` change, and **`refresh` before
  `ensure`** for any new resource folder. `restart` alone serves cached manifest metadata —
  new files silently don't run.
- **No hardcoded machine paths.** The server's resources directory differs per machine —
  recall it from `.fivem-mcp/memory.md`, discover it, or ask; never commit it.
- **`fivem_run_code` is synchronous.** The snippet's return value is the answer; anything
  that waits belongs in `ctx.thread(function() ... end)`, and long loops must check
  `ctx.alive()` or they pile up across reloads.
- **Evidence over vibes.** Don't report a feature done without a log line, probe result, or
  screenshot from the running game backing it.
- Some FXServer builds lack `status`/`clients` — their absence doesn't mean the server is
  broken. Exclusive-fullscreen screenshots come back black — ask for borderless windowed.

## Memory

Two files persist what sessions learn, split by portability:

- `references/lessons.md` (committed) — portable lessons: failed approaches, surprising
  native/FiveM behavior. Record one the moment a debugging detour resolves to a non-obvious
  cause or a prototyped approach fails for an undocumented reason — not at session end,
  when the detail has faded. Don't record typos, transient flakes, or what the references
  already say.
- `.fivem-mcp/memory.md` (gitignored, at the repo root) — facts about this machine. Create
  it (and the `.fivem-mcp/` directory) if missing — template in
  `references/deploy-verify.md` — and update rows in place when a machine fact is
  discovered or turns out stale. **Machine facts never go into committed files** —
  `npm test` enforces the split.

## Tool cheatsheet

| Tool | Purpose — and the one thing to remember |
|---|---|
| `fivem_bridge_status` | Connection health, recent bridge log — first call of the session |
| `fivem_run_code` | Lua on the live **client**; sync return, `ctx.thread`/`ctx.alive`/`ctx.log`, 16 KB max |
| `fivem_execute_command` | Client console command; response says whether the verb is registered |
| `fivem_read_log` | Tail client log; `filter` is applied before the tail, so it digs deep |
| `fivem_screenshot` | Captures the monitor the game is on; look at the image, don't just take it |
| `fivem_native_info` | Native lookup by name/hash/keywords, probes the client for existence |
| `fivem_server_command` | txAdmin console command (`ensure`/`restart`/`refresh`); no ack — captured output is the only feedback |
| `fivem_server_console` | Server console ring buffer; pass back `Next cursor` to read only what's new |
| `fivem_launch` | Start game + connect; never guess an address; cold start 60–120 s |
| `fivem_read_crash` | Crash dumps + correlated reason; works with the game dead; pair `section` with `filter` |

## References

- `references/scaffolding.md` — resource layout by complexity tier, fxmanifest template, client/server split rules
- `references/testing.md` — prototype-first and temp-test-command patterns, ctx API, evidence standard
- `references/deploy-verify.md` — resources-dir discovery, linking, refresh/restart matrix, post-deploy checklist
- `references/debugging.md` — triage ladder and failure-signature table
- `references/lessons.md` — accumulated runtime lessons; read at preflight, append when a
  surprise resolves
