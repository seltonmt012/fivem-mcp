# Deploying and verifying a resource

## Finding the server's resources directory

Resource folders live under the FXServer data directory — on txAdmin installs typically
`<txData>\<profile>\resources`. **Never assume or guess this path.** In order:

1. Check `.fivem-mcp/memory.md` at the repo root. If the row's "Last verified" date is old,
   verify with a cheap probe first — e.g. the `fivem-mcp-bridge` junction exists at that
   path — and bump the date (or delete the row) accordingly.
2. Reuse it if it was already established earlier in this session.
3. Look for hints: `fivem_server_console` startup lines often print resource paths, and the
   existing bridge junction (the `fivem-mcp-bridge` folder inside `resources/`) marks the spot.
4. Ask the user. They know where their server data lives; a wrong guess creates orphaned
   folders on their disk.

Once discovered or confirmed, record it in `.fivem-mcp/memory.md` (gitignored; create the
directory and file from the template below if missing) so the next session skips this
dance. Never write it into a committed file — `npm test` fails if a machine path reaches
`references/lessons.md`.

```markdown
# Machine memory — local only, never commit facts from this file

Update rows in place; bump "Last verified" when a fact is confirmed. A stale fact is
worse than none — re-verify anything that fails once, then fix or delete the row.

| Fact | Value | Last verified |
|---|---|---|
| Server resources dir | <path> | YYYY-MM-DD |
| Server address | <host:port> | YYYY-MM-DD |
| Display / screenshot | <e.g. borderless windowed, monitor 2> | YYYY-MM-DD |
```

Add rows for other machine facts as they surface (txAdmin URL, game install quirks) — one
row per fact, facts get updated, not appended.

## Linking the resource into the server

Same pattern the bridge itself uses: a link, so editing the repo edits the live resource.
Confirm the resolved paths with the user before creating anything. On Windows:

```
cmd /c mklink /J "<resources>\[local]\<name>" "<repo>\scripts\<name>"
```

On Linux: `ln -s "<repo>/scripts/<name>" "<resources>/[local]/<name>"`.

`[local]` is just a category folder — any category (or none) works. Note for shell work:
paths containing `[` need `-LiteralPath` in PowerShell, or `-Path` silently matches nothing.

## The refresh/restart matrix

This is where deployments silently fail. `restart` alone does **not** re-read
`fxmanifest.lua` — it reloads scripts against cached manifest metadata, so a newly added file
simply doesn't run, with no error.

| What changed | Required commands (via `fivem_server_command`) |
|---|---|
| Existing Lua file edited | `restart <name>` |
| `fxmanifest.lua` edited (file added/removed, new section) | `refresh` **then** `restart <name>` |
| Brand-new resource folder / new link | `refresh` **then** `ensure <name>` |
| Bridge payload (`fivem-mcp-bridge`) feels stale | `/fivem_reload` in-game via `fivem_execute_command` — **never** `stop fivem-mcp-bridge` |

Also add the resource to the server permanently only if the user wants it: `ensure` starts it
for this server session; surviving a server restart needs an `ensure <name>` line in
`server.cfg`, which is the user's call.

## Post-deploy checklist

Run after every deploy or restart — a resource can "start" with a broken script:

1. `fivem_server_command('ensure <name>')` (or `restart`) with output capture on — read the
   response for `Started resource <name>` vs. syntax/`script error` lines.
2. `fivem_run_code`: `return GetResourceState('<name>')` — must be `'started'`.
3. `fivem_read_log` with `filter: '<name>'` — client-side script errors name the resource and
   do not surface anywhere else.

## txAdmin caveats

- Server commands return **no acknowledgement** — captured console output is the only
  feedback. An empty capture means: the command ran silently, OR the command doesn't exist,
  OR the txAdmin account lacks *Console: Write*. Cross-check with a probe when it matters.
- `stop fivem-mcp-bridge` is blocked by the MCP server (see the matrix row above).
  `restart fivem-mcp-bridge` is allowed but disconnects the bridge for a few seconds; check
  `fivem_bridge_status` afterwards.
- If the `fivem_server_*` tools are not available at all, txAdmin integration is off — route
  server-side commands through the user instead.
