# fivem-mcp

MCP server + FiveM bridge resource that let Claude develop and test FiveM scripts inside a
running game. Components: [`mcp-server/`](mcp-server/README.md) (TypeScript, the MCP tools)
and [`fivem-mcp-bridge/`](fivem-mcp-bridge/README.md) (the in-game bridge).

**When building, testing, or debugging a FiveM script, use the `fivem-script-dev` skill** —
it carries the full pipeline (prototype live → scaffold under `scripts/` → deploy → verify
with the MCP tools).

Two traps worth knowing even outside the skill:

- Never `stop` the bridge resource (`fivem-mcp-bridge`) — it severs the bridge with nothing
  in-game left to restore it. Use `/fivem_reload` or `restart` instead.
- After editing any `fxmanifest.lua`, run `refresh` before `restart` — restart alone serves
  cached manifest metadata, and new resource folders need `refresh` before `ensure` sees them.

Sessions accumulate memory: portable lessons (what didn't work and why) live in
[`references/lessons.md`](.claude/skills/fivem-script-dev/references/lessons.md) — worth a
read before FiveM work even outside the skill — and machine facts (resources dir, server
address) in gitignored `.fivem-mcp/memory.md`. `npm test` enforces that machine facts never
reach the committed file.

For changes to the MCP server or bridge resource themselves: `cd mcp-server && npm test`
runs the build, native checks, resource invariants, and the end-to-end smoke test (no FiveM
needed).
