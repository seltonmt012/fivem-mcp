# fivem-mcp-bridge

The game side of [fivem-mcp](../README.md). Unlike a normal resource it does **not** ship its
actual client code: every player client holds nothing but a loader. The real code is sent by
the server to registered developers only, and executed there at runtime.

## Why

The tool runs arbitrary F8 commands on the client and compiles Lua snippets there with
`load()`. A mechanism like that has no business sitting on players' machines — and the bridge
token even less so. A file that is neither a `client_script` nor listed in `files {}` is
**never** delivered to a client by FiveM; the server can still read it with `LoadResourceFile`.
The whole construction rests on exactly that.

## Flow

```
client start
   │ TriggerServerEvent('fivem-mcp:requestPayload')     ← no arguments, repeated until answered
   ▼
server/main.lua   cooldown → identifier list OR ACE → otherwise log + reject
   │ LoadResourceFile: payload/client.lua, payload/nui.js, bridge.token
   │ TriggerClientEvent('fivem-mcp:deliverPayload', src, {...})
   ▼
client/loader.lua dispose old payload → load(code)(ctx) → module with dispose()
   │
   ▼
payload/client.lua  handlers: boot | execCommand | evalCode | bridgeLog | ping
   ▲
   │ fetch('https://<res>/fivemMcpBoot')   ← poll until the payload is registered
nui/boot.js  new Function('config', code)(config) → the real bridge code runs
   │
   ▼
payload/nui.js  ws://127.0.0.1:39271 → hello → reconnect until the MCP server is there
```

The NUI page **pulls** its code through a callback instead of having it pushed with
`SendNUIMessage`. That removes the timing race: the loader registers the callback when the
resource starts and answers `ready = false` while no payload is active — so the poll simply
keeps running until there is something to fetch.

Two pieces sit outside this delivery flow. `shared/marshal.lua` is an ordinary
`shared_script` — the value marshalling both snippet tools use for their results; it holds no
secrets and ships to every client. `server/eval.lua` registers the loopback-only `POST /eval`
endpoint behind `fivem_server_run_code`, and only when `Config.serverEval` is `true` — with
the shipped default (`false`) the endpoint does not exist.

## Startup order

There is none. Game client, FiveM server and MCP server start independently, and every
combination has to end up connected — so no step in the chain treats "not there yet" as final:

| Link | What keeps it trying |
|---|---|
| loader → FiveM server | `startRequestLoop` asks every 3 s, backing off to 30 s, **without an attempt limit**. Its request can be lost while the client is still joining, or arrive before `server/main.lua` is registered |
| FiveM server → loader | `onResourceStart` additionally pushes to everyone already in the session, which closes the same race from the other side |
| refusal → loader | A refusal only drops the loop to one request per minute. Identifiers and ACE are not always resolved yet during a join, and a developer can be added to `authorized.txt` at any time — neither should need a rejoin |
| loader → NUI page | Every delivery sends `fivem-mcp:dispose`, so the page re-polls and cannot stay on an older payload than the Lua side |
| NUI page → payload | `nui/boot.js` polls `fivemMcpBoot` for as long as the resource runs |
| payload → MCP server | `payload/nui.js` reconnects with backoff up to 15 s, forever |
| stale token | The token is baked into the payload at delivery, but the MCP server writes a **new** one whenever `bridge.token` is absent. A payload handed out before that can never authenticate, so close code `4001` triggers the `bridgeReauth` callback and the loader fetches a payload carrying the current token |

The practical consequence: start things in whatever order you like. A client that joins while
the MCP server is already running connects within seconds, one that was in the game first
connects as soon as the MCP server comes up.

## Files

| File | Reaches the client? | Contents |
|---|---|---|
| `fxmanifest.lua` | – | Manifest |
| `client/loader.lua` | **yes** | Request, `load()`, dispose, `/fivem_reload` — no tooling |
| `nui/index.html` | **yes** | Invisible NUI shell |
| `nui/boot.js` | **yes** | Poll bootstrap, no bridge logic |
| `shared/marshal.lua` | **yes** | Value marshalling for snippet results — no secrets, no tooling |
| `config.lua` | no | ACE object, bridge URL, request cooldown, server-eval flag |
| `server/main.lua` | no | Gatekeeper and delivery |
| `server/eval.lua` | no | `POST /eval` behind `fivem_server_run_code`; inert unless `Config.serverEval = true` |
| `payload/client.lua` | no | The real client code |
| `payload/nui.js` | no | The real NUI bridge code |
| `bridge.token` | no | Shared secret, written by the MCP server |
| `authorized.txt` | no | Developer identifiers (gitignored, never committed) |

The "no" rows are the security boundary. `npm run check:resource` in `mcp-server/` fails hard
the moment one of those paths becomes client-reachable through the manifest — a mistake that
breaks nothing else and would therefore go unnoticed.

## Setup

**1. Make the resource available.** A link is easiest: the repo folder is then also the
deployed folder, and the token file lands in the right place by itself. (Copying instead
breaks that — the MCP server writes `bridge.token` into the repo folder, and a copy never
sees it.) On Windows:

```bash
cmd /c mklink /J "<fxserver>\resources\[local]\fivem-mcp-bridge" "<repo>\fivem-mcp-bridge"
```

On Linux:

```bash
ln -s "<repo>/fivem-mcp-bridge" "<fxserver>/resources/[local]/fivem-mcp-bridge"
```

Replace `<fxserver>` with your server data directory (on txAdmin installs typically
`<txData>\<profile>`) and `<repo>` with where you cloned this repository. The folder name
inside `resources/` is the resource name; keep it `fivem-mcp-bridge` so the default
`txAdmin.protectedResources` guard in the MCP server matches, and if you set
`allowedResources` in `mcp-server/fivem-mcp.config.json`, it has to match too.

**2. Add to `server.cfg`:**

```
ensure fivem-mcp-bridge
```

**3. Authorize yourself** — preferably in `authorized.txt` in the resource root, one
identifier per line (`#` starts a comment):

```
license:your-identifier-here
```

The file is gitignored — real licenses never reach the repo — and it is re-read on every
payload request, so edits apply without a resource restart. `status` in the server console
shows your own identifier.

Alternatively, grant the ACE in `server.cfg`:

```
add_ace group.admin fivem-mcp.dev allow
```

Any one path is enough. With no entry anywhere and no ACE nobody receives the payload — the
server console says so clearly at startup.

**4. Provide the token.** Nothing to do with the default layout: the MCP server writes
`bridge.token` into this folder by itself when it starts, and the order does not matter — the
client keeps asking, and a token that changed after the payload was delivered is picked up on
its own (see [Startup order](#startup-order)); `/fivem_reload` only shortens the wait. For a
non-standard layout (the `tokenFile` key) or a **remote** FiveM server (a fixed token via
`FIVEM_BRIDGE_TOKEN`), see [The game side](../mcp-server/README.md#the-game-side) in the MCP
server docs.

## Commands

| Command | Effect |
|---|---|
| `/fivem_reload` | Fetch the payload from the server again without restarting the resource. Authorization is re-checked |
| `/fivem_ping` | Prints `pong (payload revision N)` to the F8 console — a target for your first `fivem_execute_command` call. Silence means no payload is loaded yet: check authorization and the server console |

## Hot reload

`RegisterNUICallback` and `RegisterCommand` are built on `AddEventHandler` in FiveM, and event
handlers **accumulate** — they do not replace one another. A payload that registers its own
callbacks leaves every previous instance behind after each reload, and the oldest one answers
first. Hence the contract:

- **Registration happens exclusively in `client/loader.lua`**, which runs exactly once per
  resource start. `payload/client.lua` registers nothing and only returns a `handlers` table
  (`boot`, `execCommand`, `evalCode`, `bridgeLog`, `ping`) that the loader dispatches into. With
  no payload active the loader answers by itself — `ready = false` for `fivemMcpBoot`, a clean
  error for `execCommand` and `evalCode`.
- The payload holds a local `alive`. Long-lived threads have to check it; every `load()` gets
  its own upvalue. Snippets from `fivem_run_code` reach it through `ctx.alive()` — they run in
  the same Lua state and survive a reload just the same.
- The returned module provides `dispose()`, which flips the `alive` flag. The loader calls it
  inside `pcall` before running the new chunk — a broken `dispose` must not block the reload.
- The loader then sends `SendNUIMessage({ type = 'fivem-mcp:dispose' })` unconditionally on
  every delivery, even when no payload was loaded. `nui/boot.js` then calls
  `window.__fivemMcp.dispose()` (closing the WebSocket) and resumes polling, which pulls in the
  new payload automatically.

`npm run check:resource` enforces this: it fails as soon as `payload/client.lua` calls
`RegisterNUICallback` or `RegisterCommand` itself again.

**What needs a resource restart:** changes to `client/loader.lua`, `nui/boot.js`,
`shared/marshal.lua` or `fxmanifest.lua` — those live on the client and are only delivered
when the resource starts — and to `config.lua`, which the server scripts read once at load
(after a manifest or config edit, run `refresh` before `restart`; restart alone serves cached
manifest metadata). Only changes to `payload/` are covered by `/fivem_reload`.

## Trust model

What the gating achieves:

- Bridge code, protocol details and the token sit on no player's hard drive.
- The server establishes identity purely from `source`; the request event carries no arguments
  anyone could forge.
- A per-player cooldown stops anyone firing the event in a loop.
- Every grant is logged to the server console; a denial is logged once per player per session,
  so retrying clients do not flood it.
- Revoked access takes effect at the next `/fivem_reload` or resource start.

What it does **not** achieve:

- This is attack-surface reduction, not cryptography. Anyone who legitimately receives the
  payload can read it — it runs on their machine, after all.
- An authorized developer client can tamper with the payload. The trust model is "I trust my
  development team", not "I trust the client".
- For an authorized client the bridge is not a sandbox: `evalCode` compiles arbitrary Lua in the
  normal client state (`load(..., 't')`, no separate environment, all natives). There is nothing
  a snippet can do that a payload cannot — the boundary is the authorization list in front of
  it, not a restriction behind it.
- Resource-level isolation does not exist on the FiveM server: any other resource on the same
  server can read `bridge.token` with `LoadResourceFile('fivem-mcp-bridge', 'bridge.token')`. Only run
  the resource on servers whose other resources you trust — which, for a development server, is
  the same trust question as above.
- The FiveM server chooses where the bridge connects (`Config.bridgeUrl`). The NUI bridge
  refuses anything that is not a loopback `ws://` address, so a hostile server cannot redirect
  an authorized developer's bridge — and the token in its handshake — to an external endpoint;
  but a server you run the payload from can, by design, execute arbitrary code on your client
  either way.
- The loader itself stays visible to everyone. That this mechanism exists is no secret, and does
  not need to be.

For a production server with real players it still holds: keep `authorized.txt`
short, and only run the resource while you are actually developing against it.
