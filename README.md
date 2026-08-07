# fivem-mcp

**Develop FiveM resources from Claude — and test them inside the running game.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js ≥ 20](https://img.shields.io/badge/Node.js-%E2%89%A5%2020-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-server-8A2BE2)](https://modelcontextprotocol.io/)

Claude gets a bridge into a live FiveM client: it can run console commands, execute Lua in
the client context, read the client log and look up natives — the things you would otherwise
do by hand in the F8 console, except an agent can do them in a loop.

> [!IMPORTANT]
> **This is a local development tool.** The bridge listens on loopback only, and the client
> code is delivered at runtime to authorized developers alone. See [Security](#security).

## Demo

One prompt to Claude, and it scaffolds a shop resource, deploys it to the server, walks the
player over and buys a bottle of water in-game — verifying every step through the bridge:

https://github.com/user-attachments/assets/038029e4-3e48-4cbc-b58a-8433d2725d90

<details>
<summary><b>The prompt used for the demo</b></summary>

```
Build a production-quality FiveM shop resource where players can purchase water. First inspect the existing server setup and integrate with its framework, inventory, and currency systems where available. Create a polished, responsive NUI that works correctly across common screen resolutions and aspect ratios.

Deploy the resource, test the complete purchase flow in the running game, verify the UI at multiple viewport sizes, inspect client and server logs, and fix every issue you encounter. Ensure purchases are validated server-side, prevent exploits and duplicate transactions, and remove all temporary test code before finishing. Provide brief runtime evidence showing that the final implementation works.
```

</details>

## Table of contents

- [Highlights](#highlights)
- [Tools](#tools)
- [Getting started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Install the MCP server](#1-install-the-mcp-server)
  - [2. Register the server with Claude Code](#2-register-the-server-with-claude-code)
  - [3. Install the bridge resource into your FXServer](#3-install-the-bridge-resource-into-your-fxserver)
  - [4. Authorize yourself](#4-authorize-yourself)
  - [5. Optional configuration](#5-optional-configuration)
  - [6. Verify](#6-verify)
- [Platform support](#platform-support)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Security](#security)
- [Documentation](#documentation)
- [Licence](#licence)

## Highlights

- **Full dev loop in-game** — launch the client, deploy a resource, drive the player,
  read logs and screenshots, all from the agent.
- **Native checking before execution** — every native a snippet calls is resolved against
  the FiveM reference *and* the connected client. An invented name comes back as a rejection
  with suggestions instead of failing mid-run as `attempt to call a nil value`.
  Details: [Native checking](mcp-server/README.md#native-checking).
- **NUI testing without OS input** — list frames, snapshot a resource's UI, click elements
  and run JavaScript through CEF DevTools.
- **Server side too (opt-in)** — read the FXServer console and run commands through txAdmin,
  or execute Lua on the server itself.
- **Static linting on disk** — `fivem_check_resource` checks syntax and resolves every
  native call side-aware before anything is deployed.
- **A ready-made agent skill** — [`fivem-script-dev`](.claude/skills/fivem-script-dev/SKILL.md)
  teaches Claude Code the full pipeline: prototype natives live, scaffold a resource under
  `scripts/`, deploy, and verify every step in the running game. It also keeps memory across
  sessions: portable lessons in a committed file, machine facts (server paths, addresses) in a
  gitignored one — with a test-suite check that the two never mix.

## Tools

| Tool | What it does |
|---|---|
| `fivem_execute_command` | Runs a console command in the client, exactly as if typed into F8 |
| `fivem_run_code` | Runs a Lua snippet with the full client-side native API — for anything without a command, like walking somewhere or reading world state |
| `fivem_read_log` | Tails the client log, including `print()` from resources and engine errors |
| `fivem_read_crash` | Reads recent client crash dumps: exception, stack trace and the engine's debug dump at the moment of the crash |
| `fivem_bridge_status` | Reports whether a client is connected, since when, and what it recently logged |
| `fivem_native_info` | Looks a native up in the FiveM reference: exact spelling, parameters, return type, client or server side |
| `fivem_screenshot` | Captures the display the game is on, so a change with a visible effect can actually be looked at |
| `fivem_launch` | Starts FiveM and connects it to a server (`+connect host:port`), so a test cycle does not begin by hand |
| `fivem_server_console` | Reads the FiveM **server** console live through txAdmin — the counterpart to `fivem_read_log` (opt-in, see below) |
| `fivem_server_command` | Runs a command in the **server** console through txAdmin, e.g. `restart myresource` (opt-in, see below) |
| `fivem_check_resource` | Statically lints a resource folder before deploy: syntax plus every native call resolved side-aware against the reference |
| `fivem_server_run_code` | Runs a Lua snippet on the **server** — reads server truth (resource state, routing buckets) directly (opt-in on both sides) |
| `fivem_nui_frames` / `fivem_nui_snapshot` | Lists NUI frames and outlines a resource's UI (optionally with a privacy-safe screenshot of just the NUI layer) |
| `fivem_nui_click` / `fivem_nui_eval` | Clicks elements and runs JavaScript inside a resource's NUI page through CEF DevTools — no OS-level input needed |

<details>
<summary><b>Which tools need a connected client?</b></summary>

Not every tool needs a connected client. `fivem_screenshot`, `fivem_launch` and
`fivem_read_crash` work from the MCP server itself and never talk to the resource, so they work
while the bridge is down — on a crash dialog, a stuck loading screen, the launcher, or with
nothing running at all. `fivem_check_resource` lints on disk (a connected client only sharpens
its answers), and the `fivem_nui_*` tools go through CEF DevTools rather than the bridge. The
server-side tools bypass the client too: `fivem_server_console` and `fivem_server_command` talk
to txAdmin (off by default, dedicated admin account required — setup in
[Server console via txAdmin](mcp-server/README.md#server-console-via-txadmin)), and
`fivem_server_run_code` posts to the FXServer itself (opt-in on both sides). Everything else in
the table needs a connected client.

</details>

Full parameter reference for every tool: [mcp-server/README.md](mcp-server/README.md#tools).

## Getting started

### Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js 20 or newer** | Runs the MCP server |
| **The FiveM client** (Windows) | The game you develop against. Must run on the **same machine** as the MCP server — the bridge is loopback-only by design |
| **An FXServer to test against** | Your own development server, local or remote, Windows or Linux. A [txAdmin](https://txadmin.gg/) install works out of the box; txAdmin itself is only required for the two opt-in `fivem_server_*` tools |
| **Claude Code** | Or any other MCP client |

### 1. Install the MCP server

```bash
git clone https://github.com/juliantsu/fivem-mcp.git
cd fivem-mcp/mcp-server
npm install
npm run build
```

The native index (`data/natives-index.json`) ships with the repository, so a fresh clone works
offline and without extra steps. `npm run natives:sync` rebuilds it from the FiveM reference —
worth doing after a FiveM update.

### 2. Register the server with Claude Code

Nothing to do if you open the repository root as your working directory: Claude Code picks the
server up through [.mcp.json](.mcp.json) automatically (which points at
`mcp-server/dist/index.js` — hence the build step above). The
[`fivem-script-dev`](.claude/skills/fivem-script-dev/SKILL.md) skill is picked up the same way.

To use the tools from *other* projects too, register the server globally with an absolute
path:

```bash
claude mcp add --scope user fivem-mcp -- node "<repo>/mcp-server/dist/index.js"
```

Any other MCP client works the same way: `node <repo>/mcp-server/dist/index.js`, stdio
transport.

### 3. Install the bridge resource into your FXServer

Link — don't copy — the [`fivem-mcp-bridge/`](fivem-mcp-bridge) folder into the server's
`resources/[local]/` directory. With a link, the repo folder *is* the deployed folder, so the bridge
token the MCP server writes there is readable by the resource without any copying. The exact
commands (mklink on Windows, ln on Linux) and the `server.cfg` line are in the
[resource setup](fivem-mcp-bridge/README.md#setup).

### 4. Authorize yourself

The bridge code is only delivered to registered developers. Put your `license:` identifier
into `fivem-mcp-bridge/authorized.txt` (gitignored, one identifier per line, `#` comments) —
`status` in the server console shows it, and edits apply without a restart. Alternative
(ACE permission): [resource setup](fivem-mcp-bridge/README.md#setup).

### 5. Optional configuration

The defaults work for the layout above — the bridge listens on `ws://127.0.0.1:39271` and the
token file lands inside the resource folder by itself. For anything else (ports, command
denylist, txAdmin credentials, remote game server), copy
[`fivem-mcp.config.example.json`](mcp-server/fivem-mcp.config.example.json) to
`mcp-server/fivem-mcp.config.json` (gitignored) and edit; every key and its default is
documented in [Configuration](mcp-server/README.md#configuration). The `fivem_server_*` tools
need the opt-in txAdmin setup described in
[Server console via txAdmin](mcp-server/README.md#server-console-via-txadmin).

### 6. Verify

Everything up to the game can be checked offline — the end-to-end smoke test (a mock client
stands in for the NUI page), the native checks and the static checks of the resource:

```bash
npm test
```

Then the real thing: start your FXServer, ask Claude to launch the game (`fivem_launch`) or
start FiveM and connect yourself, and ask for `fivem_bridge_status` — it should report a
connected client within seconds of reaching the session.

> [!TIP]
> If no client connects, the FiveM server console logs every rejected payload request with the
> reason, and there is a [troubleshooting table](mcp-server/README.md#troubleshooting).

## Platform support

| Part | Where it runs |
|---|---|
| MCP server | Windows, Linux, macOS |
| FiveM client | Windows only, **same machine** as the MCP server (loopback-only bridge) |
| FXServer (game server) | Anywhere — local or remote; the `fivem_server_*` tools reach it over txAdmin HTTP |

On a non-Windows host, `fivem_screenshot`, `fivem_launch` and the client log/crash readers
have nothing local to work with — they stay registered and answer with the reason instead of
failing cryptically. For a remote game server, see the
[token note](mcp-server/README.md#the-game-side) (`FIVEM_BRIDGE_TOKEN`).

## Architecture

```
Claude ──stdio (MCP)──> mcp-server ──ws://127.0.0.1:39271──> NUI page (CEF)
                                                                │ fetch()
                                                                ▼
                                                      client.lua: ExecuteCommand()
                                                                  load(snippet)
```

The MCP server is the WebSocket **server** and the NUI page is the client. It cannot be the
other way round, because CEF cannot open server sockets.

The resource's client code is not shipped with it. It is sent at runtime by the FiveM server to
authorized developers and executed there with `load()`. Details in
[fivem-mcp-bridge/README.md](fivem-mcp-bridge/README.md).

## Repository layout

| Folder | What is in it |
|---|---|
| [`mcp-server/`](mcp-server) | The MCP server (TypeScript/Node). Hosts the local WebSocket bridge and exposes the tools to Claude |
| [`fivem-mcp-bridge/`](fivem-mcp-bridge) | The game side. Player clients only ever receive a loader; the real client code is sent by the server to registered developers only |
| [`scripts/`](scripts) | Where the resources you develop with the agent live; each is linked into the server like the bridge |

## Security

The bridge runs on loopback only, and the payload goes exclusively to players listed in
`fivem-mcp-bridge/authorized.txt` (or authorized via ACE). That reduces the
attack surface but is no substitute for trusting your own team — see
[Trust model](fivem-mcp-bridge/README.md#trust-model) in the resource docs.

## Documentation

- [MCP server](mcp-server/README.md) — tool parameter reference, configuration, native
  checking, txAdmin setup, troubleshooting
- [Bridge resource](fivem-mcp-bridge/README.md) — game-side setup, authorization, trust model
- [Developed resources](scripts/README.md) — how agent-built resources are laid out and linked
- [`fivem-script-dev` skill](.claude/skills/fivem-script-dev/SKILL.md) — the agent workflow,
  plus [portable lessons](.claude/skills/fivem-script-dev/references/lessons.md) accumulated
  across sessions

## Licence

MIT — see [LICENSE](LICENSE). This covers the code in this repository.

**Not** covered is `mcp-server/data/natives-index.json`, the index `npm run natives:sync`
builds from the FiveM native reference. That documentation comes from
[`citizenfx/natives`](https://github.com/citizenfx/natives) and
[`citizenfx/fivem`](https://github.com/citizenfx/fivem), belongs to the CitizenFX Collective and
is subject to their [terms](https://fivem.net/terms). It is committed for convenience — so a
clone works offline — but it remains their content under their terms, not part of the MIT
grant.
