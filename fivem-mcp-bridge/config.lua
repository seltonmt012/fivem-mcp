--[[
    Server-side configuration for the fivem-mcp loader.

    Listed under server_scripts only, so this file never reaches a client.
]]

Config = {}

--- Developers are authorized through authorized.txt in the resource root: one
--- identifier per line, #-comments allowed, e.g.
--- "license:0123456789abcdef0123456789abcdef01234567". The file is gitignored
--- and re-read on every request, so edits apply without a resource restart.
---
--- Find yours with `status` in the server console, or print
--- GetPlayerIdentifiers(source) once. "license:" is the most stable one.

--- Alternative to authorized.txt: anyone holding this ACE gets the payload.
--- In server.cfg:  add_ace group.admin fivem-mcp.dev allow
--- Set to false to disable the ACE path entirely.
Config.aceObject = 'fivem-mcp.dev'

--- Where the MCP server's WebSocket bridge listens. Must match host/port in
--- mcp-server/fivem-mcp.config.json.
Config.bridgeUrl = 'ws://127.0.0.1:39271'

--- Minimum gap between two payload requests from the same player, in ms.
Config.requestCooldownMs = 2000

--- Server-side eval for fivem_server_run_code. Off by default on purpose: when
--- false, the HTTP handler in server/eval.lua is never even registered. Enable
--- it here AND set serverEval.enabled in mcp-server/fivem-mcp.config.json, then
--- refresh + restart the resource. The handler only answers loopback requests
--- carrying the bridge token.
Config.serverEval = false
