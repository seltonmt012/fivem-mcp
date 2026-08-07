#!/usr/bin/env node
/**
 * End-to-end check of the bridge without FiveM: spawns dist/index.js as a real
 * MCP stdio server, drives its tools as a real MCP client, and plays the NUI
 * side with plain WebSocket clients.
 *
 *   npm run build && node scripts/smoke-test.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import process from "node:process";
import { Server as SocketIOServer } from "socket.io";
import WebSocket, { WebSocketServer } from "ws";

import { check, finish, PACKAGE_ROOT, section, sleep } from "./lib.mjs";

const PORT = process.env.SMOKE_PORT ?? "39281";
const TOKEN = "smoke-test-token-0123456789abcdef";
const RESOURCE = "smoke-bridge";
const VERBOSE = process.argv.includes("--verbose");

/** The fake txAdmin panels; offsets keep clear of PORT+1..+4 (extra bridge ports). */
const TX_USER = "smoke-admin";
const TX_PASS = "smoke-txadmin-password";
const TX_PORT = Number(PORT) + 10;
const TX_PORT_NOPERM = Number(PORT) + 11;
const TX_PORT_BADPASS = Number(PORT) + 12;
const TX_PORT_CLOSED = Number(PORT) + 13;

/** Fake endpoints for the server-eval and NUI DevTools tools. */
const EVAL_PORT = Number(PORT) + 14;
const CDP_PORT = Number(PORT) + 15;

/* ------------------------------------------------------------------ *
 * NUI side
 * ------------------------------------------------------------------ */

/** Names this fake client claims to have, for the native probe. */
const MOCK_NATIVES = ["PlayerPedId", "GetEntityCoords", "SetEntityCoords", "GetEntityHealth"];

/**
 * Recognises the snippet the native check sends and returns the names it asks
 * about, so the mock can answer it the way a real client would.
 */
function parseProbe(code) {
  if (!code.startsWith("local names = {")) return null;
  const list = code.slice(code.indexOf("{") + 1, code.indexOf("}"));
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function connectMock({
  token = TOKEN,
  resource = RESOURCE,
  origin,
  omitOrigin = false,
  natives = MOCK_NATIVES,
  port = PORT,
} = {}) {
  const headers = {};
  if (!omitOrigin) headers.Origin = origin ?? `https://cfx-nui-${resource}`;

  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const mock = {
    ws,
    received: [],
    snippets: [],
    probes: [],
    silent: false,
    failNext: false,
    welcomed: false,
    closeCode: null,
    closed: new Promise((resolve) => {
      ws.once("close", (code) => {
        mock.closeCode = code;
        resolve(code);
      });
    }),
  };

  mock.ready = new Promise((resolve) => {
    ws.once("open", () => {
      ws.send(JSON.stringify({ t: "hello", protocol: 1, token, resource, client: "smoke" }));
    });

    const reply = (id, data) => {
      if (mock.silent) return;
      const message = mock.failNext
        ? { t: "result", id, ok: false, error: "mock rejected it" }
        : { t: "result", id, ok: true, data };
      ws.send(JSON.stringify(message));
    };

    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (VERBOSE) console.log(`    [mock<-] ${raw.toString().slice(0, 160)}`);
      if (msg.t === "welcome") {
        mock.welcomed = true;
        resolve(msg);
      } else if (msg.t === "ping") {
        ws.send(JSON.stringify({ t: "pong", id: msg.id }));
      } else if (msg.t === "command") {
        mock.received.push(msg.command);
        reply(msg.id, { echoed: msg.command });
      } else if (msg.t === "eval") {
        mock.snippets.push(msg.code);
        const probed = parseProbe(msg.code);
        if (probed) {
          mock.probes.push(probed);
          const present = Object.fromEntries(probed.map((name) => [name, natives.includes(name)]));
          reply(msg.id, { payloadRevision: 0, durationMs: 1, returned: [present] });
        } else {
          reply(msg.id, { payloadRevision: 0, durationMs: 7, returned: [{ evaluated: msg.code }] });
        }
      }
    });
    ws.once("close", () => resolve(null));
    ws.once("error", () => resolve(null));
  });

  return mock;
}

/* ------------------------------------------------------------------ *
 * txAdmin side
 * ------------------------------------------------------------------ */

/** What a freshly booted fake panel has on its console: ANSI, CRLF and a {§hex-time} marker included. */
const TX_BOOT_BUFFER = "{§693e7d40}\x1b[32m[smoke-tx]\x1b[0m server booted\r\nsmoke-resource started\r\n";

/**
 * A fake txAdmin: POST /auth/password hands out a session cookie, and a
 * socket.io server plays the liveconsole room -- replays its whole console
 * history on join (getRecentBuffer style), streams command echoes, drops
 * commands silently without the write permission. stop()/start() simulate a
 * panel restart: sessions die (they are in-memory in the real one too), the
 * console history survives.
 */
function createMockTxAdmin(port, { consolePermission = true } = {}) {
  const state = {
    loginAttempts: 0,
    commands: [],
    streamed: TX_BOOT_BUFFER,
    sessions: new Set(),
    httpServer: null,
    io: null,
  };

  const start = () =>
    new Promise((resolveStart) => {
      const httpServer = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/auth/password") {
          let body = "";
          req.on("data", (chunk) => (body += chunk));
          req.on("end", () => {
            state.loginAttempts += 1;
            let parsed = {};
            try {
              parsed = JSON.parse(body);
            } catch {}
            if (parsed.username === TX_USER && parsed.password === TX_PASS) {
              const session = `sess-${state.loginAttempts}-${Math.random().toString(36).slice(2)}`;
              state.sessions.add(session);
              res.writeHead(200, {
                "Content-Type": "application/json",
                "Set-Cookie": `tx:session:smoke=${session}; Path=/; HttpOnly; SameSite=Lax`,
              });
              res.end(JSON.stringify({ csrfToken: "smoke-csrf" }));
            } else {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Wrong username or password!" }));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const io = new SocketIOServer(httpServer, {
        serveClient: false,
        // Real txAdmin answers an initial transport=websocket handshake with
        // HTTP 400 {"code":3} -- only the polling-then-upgrade path works. A
        // stock socket.io server accepts both, which would hide a client that
        // dials websocket-first and can never connect to the real panel.
        allowRequest: (req, fn) => {
          const query = new URLSearchParams(req.url.split("?")[1] ?? "");
          const initialWebsocket = query.get("transport") === "websocket" && !query.get("sid");
          fn(initialWebsocket ? "bad request" : null, !initialWebsocket);
        },
      });
      io.on("connection", (socket) => {
        const cookie = String(socket.handshake.headers.cookie ?? "");
        const rooms = String(socket.handshake.query.rooms ?? "").split(",");
        const authed = [...state.sessions].some((session) => cookie.includes(session));
        if (!authed || !rooms.includes("liveconsole")) {
          socket.disconnect(true);
          return;
        }
        if (consolePermission) socket.emit("consoleData", state.streamed);
        socket.on("consoleCommand", (command) => {
          state.commands.push(command);
          if (!consolePermission || command === "silent") return;
          const emit = (output) => {
            state.streamed += output;
            io.emit("consoleData", output);
          };
          if (command === "slow") {
            // Past the settle window but inside captureWaitMs: the capture
            // must wait for a command's *first* output, not just settle.
            setTimeout(() => emit("slow output arrived late\r\n"), 500);
            return;
          }
          emit(`> ${command}\r\n\x1b[33m${command}\x1b[0m output ok\r\n`);
        });
      });

      state.httpServer = httpServer;
      state.io = io;
      httpServer.listen(port, "127.0.0.1", () => resolveStart());
    });

  const stop = async () => {
    state.sessions.clear();
    state.io.disconnectSockets(true);
    await new Promise((r) => state.io.close(() => r()));
    await new Promise((r) => state.httpServer.close(() => r()));
  };

  return { state, start, stop };
}

/* ------------------------------------------------------------------ *
 * MCP side
 * ------------------------------------------------------------------ */

async function callTool(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content ?? [];
  const body = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const images = content.filter((c) => c.type === "image");
  if (VERBOSE) console.log(`    [tool ${name}] isError=${!!res.isError}\n${indent(body)}`);
  return { text: body, images, isError: Boolean(res.isError) };
}

const indent = (s) => s.split("\n").map((l) => `      ${l}`).join("\n");

/** Spawns dist/index.js as another MCP server and returns a connected client. */
async function startClient(configPath, port, extraEnv = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(PACKAGE_ROOT, "dist/index.js")],
    env: {
      ...process.env,
      FIVEM_BRIDGE_PORT: String(port),
      FIVEM_BRIDGE_TOKEN: TOKEN,
      FIVEM_BRIDGE_CONFIG: configPath,
      // Cleared so the developer's real txAdmin setup never leaks in; empty
      // strings are ignored by the overrides, so the fixture config rules.
      FIVEM_TXADMIN_URL: "",
      FIVEM_TXADMIN_USERNAME: "",
      FIVEM_TXADMIN_PASSWORD: "",
      ...extraEnv,
    },
    stderr: VERBOSE ? "inherit" : "ignore",
  });
  const client = new Client({ name: "fivem-mcp-smoke", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

/** Polls fn until it returns something truthy or the budget runs out (then null). */
async function pollUntil(fn, budgetMs, intervalMs = 200) {
  const started = Date.now();
  while (Date.now() - started < budgetMs) {
    const value = await fn();
    if (value) return value;
    await sleep(intervalMs);
  }
  return null;
}

/**
 * Points the server at a fixture log directory instead of the real FiveM one,
 * so these checks neither depend on a running game nor read the user's logs.
 * captureOnExecute stays off to keep the command assertions clean.
 */
const FIXTURE_LINES = [
  "[     1000] [b3751_GTAProce]             MainThrd/ engine noise before",
  "[     1100] [b3751_GTAProce]             MainThrd/ [fivem-mcp-bridge] first marker",
  "[     1200] [b3751_GTAProce]             MainThrd/ unrelated chatter",
  "[     1300] [b3751_GTAProce]             MainThrd/ [fivem-mcp-bridge] second marker",
];

/**
 * Two fixture crashes: A has a gamelog and a matching DumpServer block in a
 * capturing log, B is a bare .dmp with neither. The capturing log's filename
 * is UTC 23:00:00 and the block sits at bracket offset 60000 ms, so its
 * wall-clock time is exactly crash A's mtime -- the correlation the tool does
 * against real FiveM logs, reproduced offline.
 */
const CRASH_A = "11111111-1111-4111-8111-111111111111";
const CRASH_B = "22222222-2222-4222-8222-222222222222";
const CRASH_A_MTIME = new Date("2025-12-31T23:01:00Z");
const CRASH_B_MTIME = new Date("2025-12-30T00:00:00Z");

const CRASH_LOG_LINES = [
  "[     1000] [    DumpServer]                10704/ DumpServer is active and waiting.",
  "[    60000] [    DumpServer]                10704/ Process crash captured. Crash dialog content:",
  "[    60000] [    DumpServer]                10704/ Exception, unhandled!",
  "[    60000] [    DumpServer]                10704/ An unhandled exception (of type smoke::test_error) caused FiveM to stop working.",
  "[    60000] [    DumpServer]                10704/ Stack trace:",
  "[    60000] [    DumpServer]                10704/   smoke-module.dll+DEAD",
  "[    60000] [    DumpServer]                10704/   smoke-module.dll+BEEF",
  "[    60000] [    DumpServer]                10704/ ",
  "[    60001] [    DumpServer]                10704/ chatter after the block",
];

const CRASH_A_GAMELOG = [
  "###### DEBUG INFO ######",
  "",
  "============ SYSTEM INFO ============",
  "Game State : Smoke",
  "System Time (0h 0m 1s)",
  "============ POOL INFO ============",
  "PoolA, 1, 2, 3",
  "PoolB, 4, 5, 6",
  "PoolC, 7, 8, 9",
  "============ PACK INFO ============",
  ...Array.from({ length: 500 }, (_, i) => `pack line ${i + 1}`),
  "###### END OF DEBUG INFO ######",
].join("\n");

function writeFixtures() {
  const root = join(PACKAGE_ROOT, ".smoke-tmp");
  const logs = join(root, "logs");
  const crashes = join(root, "crashes");
  mkdirSync(logs, { recursive: true });
  mkdirSync(crashes, { recursive: true });
  writeFileSync(join(logs, "CitizenFX_log_2026-01-01T000000.log"), `${FIXTURE_LINES.join("\n")}\n`);

  // The capturing log's mtime stays behind the read-log fixture above (which
  // gets "now"), so fivem_read_log keeps resolving the same newest file.
  const crashLog = join(logs, "CitizenFX_log_2025-12-31T230000.log");
  writeFileSync(crashLog, `${CRASH_LOG_LINES.join("\n")}\n`);
  utimesSync(crashLog, CRASH_A_MTIME, new Date("2025-12-31T23:01:05Z"));

  const dumpA = join(crashes, `${CRASH_A}.dmp`);
  writeFileSync(dumpA, "MDMP smoke fixture, not a real minidump");
  writeFileSync(join(crashes, `${CRASH_A}.dmp.gamelog`), CRASH_A_GAMELOG);
  utimesSync(dumpA, CRASH_A_MTIME, CRASH_A_MTIME);
  utimesSync(join(crashes, `${CRASH_A}.dmp.gamelog`), CRASH_A_MTIME, CRASH_A_MTIME);

  const dumpB = join(crashes, `${CRASH_B}.dmp`);
  writeFileSync(dumpB, "MDMP smoke fixture, not a real minidump");
  utimesSync(dumpB, CRASH_B_MTIME, CRASH_B_MTIME);

  writeFileSync(
    join(root, "config.json"),
    JSON.stringify({
      clientLog: { directory: logs, captureOnExecute: false, defaultLines: 20 },
      crashes: { directory: crashes },
      txAdmin: {
        enabled: true,
        url: `http://127.0.0.1:${TX_PORT}`,
        username: TX_USER,
        // Points into the fixture directory so a real password file on the
        // developer's machine can never satisfy the missing-password checks.
        passwordFile: join(root, "txadmin.password"),
        captureSettleMs: 150,
        captureWaitMs: 700,
        connectTimeoutMs: 3000,
      },
      nui: { devtoolsEndpoint: `127.0.0.1:${CDP_PORT}`, timeoutMs: 3000 },
    }),
  );
  // A separate config for the rate-limit checks: a window of 2 is exhausted in
  // two calls instead of a hundred and twenty.
  writeFileSync(
    join(root, "config-ratelimit.json"),
    JSON.stringify({
      rateLimit: { commandsPerMinute: 2 },
      clientLog: { directory: logs, captureOnExecute: false, defaultLines: 20 },
      crashes: { directory: crashes },
    }),
  );
  // Server eval on, pointed at the fake endpoint below.
  writeFileSync(
    join(root, "config-servereval.json"),
    JSON.stringify({
      clientLog: { directory: logs, captureOnExecute: false, defaultLines: 20 },
      crashes: { directory: crashes },
      serverEval: { enabled: true, gameEndpoint: `127.0.0.1:${EVAL_PORT}` },
    }),
  );

  writeCheckResourceFixtures(root);
  return ".smoke-tmp/config.json";
}

/**
 * Two fixture resources for fivem_check_resource: one carrying exactly the
 * mistake classes the tool exists for, one clean. The dirty one's own global
 * (SpawnLobby, defined in shared.lua, called from client/main.lua) must NOT be
 * flagged -- that is the cross-file pass under test.
 */
function writeCheckResourceFixtures(root) {
  const dirty = join(root, "fixture-dirty");
  mkdirSync(join(dirty, "client"), { recursive: true });
  writeFileSync(
    join(dirty, "fxmanifest.lua"),
    [
      "fx_version 'cerulean'",
      "game 'gta5'",
      "client_scripts { 'client/*.lua' }",
      "server_script 'server.lua'",
      "shared_script 'shared.lua'",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dirty, "shared.lua"),
    "FFA = {}\nfunction SpawnLobby()\n    return 1\nend\n",
  );
  writeFileSync(
    join(dirty, "client", "main.lua"),
    [
      "SpawnLobby()",
      "SetControlValueNextFrame(0, 24, 1.0)",
      "SetEntityCoordss(1, 2.0, 3.0, 4.0)",
      "DropPlayer(1, 'bye')",
      "local ped = PlayerPedId()",
      "local c = GetEntityCoords(ped)",
      "",
    ].join("\n"),
  );
  writeFileSync(join(dirty, "server.lua"), "DropPlayer(1, 'bye')\nlocal p = PlayerPedId()\n");

  const clean = join(root, "fixture-clean");
  mkdirSync(clean, { recursive: true });
  writeFileSync(
    join(clean, "fxmanifest.lua"),
    "fx_version 'cerulean'\ngame 'gta5'\nclient_script 'client.lua'\n",
  );
  writeFileSync(
    join(clean, "client.lua"),
    "local ped = PlayerPedId()\nlocal c = GetEntityCoords(ped)\nreturn c\n",
  );
}

/**
 * A fake of the bridge resource's server eval endpoint (server/eval.lua):
 * token-checked POST /fivem-mcp-bridge/eval. mode switches between the answer
 * shapes the real handler produces.
 */
function createMockEval(port) {
  const state = { requests: 0, lastCode: null, mode: "ok", httpServer: null };
  const start = () =>
    new Promise((resolveStart) => {
      const httpServer = createServer((req, res) => {
        const answer = (code, body) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (req.method !== "POST" || req.url !== "/fivem-mcp-bridge/eval" || state.mode === "disabled") {
          answer(404, { ok: false, error: "not found" });
          return;
        }
        if (state.mode === "badtoken" || req.headers["x-fivem-mcp-token"] !== TOKEN) {
          answer(401, { ok: false, error: "bad or missing token" });
          return;
        }
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          state.requests += 1;
          state.lastCode = JSON.parse(body).code;
          answer(200, {
            ok: true,
            data: { durationMs: 3, returned: [{ echoed: state.lastCode }], logs: ["from ctx.log"] },
          });
        });
      });
      state.httpServer = httpServer;
      httpServer.listen(port, "127.0.0.1", () => resolveStart());
    });
  const stop = () => new Promise((r) => state.httpServer.close(() => r()));
  return { state, start, stop };
}

/**
 * A fake CDP endpoint shaped like FiveM's NUI DevTools: /json/list names one
 * page target, and the WebSocket session answers the Page/Runtime calls the
 * NUI tools make. The frame model is the iframe one (resource frames as
 * children of one root target) -- devtools.ts handles both, this pins the
 * mapping logic.
 */
function createMockCdp(port) {
  const state = { httpServer: null, wss: null, evaluated: [] };
  const start = () =>
    new Promise((resolveStart) => {
      const httpServer = createServer((req, res) => {
        if (req.url === "/json/list") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              {
                id: "T1",
                type: "page",
                url: "https://nui-game-internal/root.html",
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T1`,
              },
            ]),
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
      const wss = new WebSocketServer({ server: httpServer });
      wss.on("connection", (ws) => {
        const send = (obj) => ws.send(JSON.stringify(obj));
        ws.on("message", (raw) => {
          const msg = JSON.parse(raw.toString());
          const reply = (result) => send({ id: msg.id, result });
          switch (msg.method) {
            case "Runtime.enable":
              send({
                method: "Runtime.executionContextCreated",
                params: { context: { id: 11, auxData: { frameId: "ROOT", isDefault: true } } },
              });
              send({
                method: "Runtime.executionContextCreated",
                params: { context: { id: 12, auxData: { frameId: "F1", isDefault: true } } },
              });
              reply({});
              break;
            case "Page.getFrameTree":
              reply({
                frameTree: {
                  frame: { id: "ROOT", url: "https://nui-game-internal/root.html" },
                  childFrames: [{ frame: { id: "F1", url: "https://cfx-nui-ffa/index.html" } }],
                },
              });
              break;
            case "Page.createIsolatedWorld":
              reply({ executionContextId: 99 });
              break;
            case "Runtime.evaluate": {
              const expr = msg.params.expression;
              state.evaluated.push({ contextId: msg.params.contextId, expr });
              if (expr.includes("MAX_NODES")) {
                reply({ result: { value: 'div#app\n  button.join "Join" [clickable]' } });
              } else if (expr.startsWith("((sel)")) {
                const sel = JSON.parse(expr.slice(expr.lastIndexOf("(") + 1, -1));
                reply({
                  result: {
                    value:
                      sel === ".join"
                        ? { ok: true, clicked: "button.join", label: "Join" }
                        : { ok: false, candidates: ['button.join -- "Join"'] },
                  },
                });
              } else if (expr.includes("throwPlease")) {
                reply({ exceptionDetails: { text: "Uncaught", exception: { description: "Error: nope" } } });
              } else {
                reply({ result: { value: 42 } });
              }
              break;
            }
            default:
              reply({});
          }
        });
      });
      state.httpServer = httpServer;
      state.wss = wss;
      httpServer.listen(port, "127.0.0.1", () => resolveStart());
    });
  const stop = async () => {
    state.wss.clients.forEach((c) => c.terminate());
    await new Promise((r) => state.wss.close(() => r()));
    await new Promise((r) => state.httpServer.close(() => r()));
  };
  return { state, start, stop };
}

async function main() {
  const configPath = writeFixtures();
  const client = await startClient(configPath, PORT, { FIVEM_TXADMIN_PASSWORD: TX_PASS });
  let clientB = null;
  let clientC = null;
  let txMock = null;

  try {
    section("Tool discovery");
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    check(
      "all fifteen default tools are exposed",
      names.join(",") ===
        "fivem_bridge_status,fivem_check_resource,fivem_execute_command,fivem_launch," +
          "fivem_native_info,fivem_nui_click,fivem_nui_eval,fivem_nui_frames," +
          "fivem_nui_snapshot,fivem_read_crash,fivem_read_log,fivem_run_code," +
          "fivem_screenshot,fivem_server_command,fivem_server_console",
      names.join(","),
    );
    check(
      "fivem_server_run_code is absent while serverEval is off",
      !names.includes("fivem_server_run_code"),
    );

    section("No bridge connected");
    let status = await callTool(client, "fivem_bridge_status");
    check("status reports not connected", status.text.includes("not connected"));
    let exec = await callTool(client, "fivem_execute_command", { command: "say hi" });
    check("execute fails with a clear message", exec.isError && exec.text.includes("No FiveM bridge is connected"));
    let run = await callTool(client, "fivem_run_code", { code: "return 1" });
    check("run_code fails with a clear message", run.isError && run.text.includes("No FiveM bridge is connected"));

    section("Handshake");
    const mock = connectMock();
    check("mock completed the handshake", (await mock.ready) !== null);
    status = await callTool(client, "fivem_bridge_status");
    check("status reports connected", status.text.includes(`connected to resource "${RESOURCE}"`));

    section("Command execution");
    exec = await callTool(client, "fivem_execute_command", { command: "say hello" });
    check("command succeeds", !exec.isError && exec.text.includes('Executed "say hello"'));
    check("resource payload is surfaced", exec.text.includes("echoed"));
    check("mock actually received it", mock.received.includes("say hello"));

    section("Command policy");
    const before = mock.received.length;
    exec = await callTool(client, "fivem_execute_command", { command: "quit" });
    check("denylisted command is blocked", exec.isError && exec.text.includes("blocked by policy"));
    check("nothing was sent over the wire", mock.received.length === before);
    exec = await callTool(client, "fivem_execute_command", { command: "   " });
    check("empty command is rejected", exec.isError);

    section("Resource-reported failure");
    mock.failNext = true;
    exec = await callTool(client, "fivem_execute_command", { command: "say boom" });
    check("ok:false is surfaced as an error", exec.isError && exec.text.includes("mock rejected it"));
    mock.failNext = false;

    section("Timeout");
    mock.silent = true;
    exec = await callTool(client, "fivem_execute_command", { command: "say quiet", timeoutMs: 400 });
    check("timeout is reported", exec.isError && exec.text.includes("no result arrived within 400 ms"));
    mock.silent = false;

    section("Code execution");
    run = await callTool(client, "fivem_run_code", { code: "return PlayerPedId()" });
    check("snippet runs", !run.isError && run.text.includes("Snippet ran"));
    check("return values are surfaced", run.text.includes("Returned:") && run.text.includes("evaluated"));
    check("the payload actually received it", mock.snippets.includes("return PlayerPedId()"));
    run = await callTool(client, "fivem_run_code", { code: "   " });
    check("empty snippet is rejected", run.isError && run.text.includes("Snippet rejected"));
    const snippetsBefore = mock.snippets.length;
    run = await callTool(client, "fivem_run_code", { code: "x".repeat(20_000) });
    check("oversized snippet is rejected", run.isError && run.text.includes("the limit is"));
    run = await callTool(client, "fivem_run_code", { code: `${String.fromCharCode(27)}Lua compiled` });
    check("bytecode is rejected", run.isError && run.text.includes("bytecode"));
    check("nothing rejected went over the wire", mock.snippets.length === snippetsBefore);
    mock.silent = true;
    run = await callTool(client, "fivem_run_code", { code: "while true do end", timeoutMs: 400 });
    check("timeout points at ctx.thread", run.isError && run.text.includes("ctx.thread()"));
    mock.silent = false;

    section("Native checking");
    check("the client was asked which names exist", mock.probes.flat().includes("PlayerPedId"));

    const beforeReject = mock.snippets.length;
    run = await callTool(client, "fivem_run_code", { code: "SetControlValueNextFrame(0, 24, 1.0)" });
    check(
      "an invented native is rejected",
      run.isError && run.text.includes("SetControlValueNextFrame"),
      run.text.slice(0, 120),
    );
    check(
      "and it never reached the game",
      !mock.snippets.some((snippet) => snippet.includes("SetControlValueNextFrame(0, 24")),
      `${mock.snippets.length - beforeReject} snippet(s) sent`,
    );

    run = await callTool(client, "fivem_run_code", { code: "SetEntityCoordss(1, 2, 3)" });
    check("a typo suggests the real name", run.isError && run.text.includes("SetEntityCoords"));

    run = await callTool(client, "fivem_run_code", { code: 'DropPlayer(1, "bye")' });
    check("a server-side native is rejected", run.isError && run.text.includes("server-side"));

    // GetEntityHeading is a real native the mock client claims not to have.
    run = await callTool(client, "fivem_run_code", { code: "return GetEntityHeading(1)" });
    check(
      "documented but absent from this build is rejected",
      run.isError && run.text.includes("does not have it"),
      run.text.slice(0, 140),
    );

    const beforeOff = mock.snippets.length;
    run = await callTool(client, "fivem_run_code", {
      code: "SetControlValueNextFrame(0, 24, 1.0)",
      nativeCheck: "off",
    });
    check('nativeCheck "off" runs it anyway', !run.isError && mock.snippets.length > beforeOff);

    run = await callTool(client, "fivem_run_code", {
      code: "SetControlValueNextFrame(0, 24, 1.0)",
      nativeCheck: "warn",
    });
    check(
      'nativeCheck "warn" runs it and says so',
      !run.isError && run.text.includes("SetControlValueNextFrame"),
    );

    run = await callTool(client, "fivem_run_code", { code: "return PlayerPedId()" });
    check("a clean snippet says nothing about natives", !run.text.includes("Snippet rejected"));

    section("fivem_native_info");
    let info = await callTool(client, "fivem_native_info", { query: "SetEntityCoords" });
    check("exact lookup returns the signature", info.text.includes("SetEntityCoords(entity"));
    check("with namespace and hash", info.text.includes("ENTITY") && info.text.includes("0x"));
    check("and the live verdict", info.text.includes("present in the connected client"));

    info = await callTool(client, "fivem_native_info", { query: "SET_ENTITY_COORDS" });
    check("reference spelling resolves too", info.text.includes("SetEntityCoords("));

    info = await callTool(client, "fivem_native_info", { query: "ped health", limit: 5 });
    // Match the count line exactly: the zero-result body also contains "match"
    // and would almost certainly suggest something with "Ped" in it.
    check(
      "keyword search returns matches",
      !info.isError && /^\d+ matches for "ped health"/.test(info.text),
      info.text.slice(0, 120),
    );

    info = await callTool(client, "fivem_native_info", { query: "SetControlValueNextFrame" });
    // Not isError: the closest matches ARE the useful answer, and this tool is
    // the documented recovery path after a rejected snippet.
    check(
      "an invented name is named as such",
      !info.isError && info.text.includes("is not a native"),
      info.text.slice(0, 100),
    );
    check("and answered with alternatives", info.text.includes("SetControl"));

    info = await callTool(client, "fivem_native_info", { query: "spawn a vehicle" });
    check("intent search finds CreateVehicle", info.text.includes("CreateVehicle("));

    // A single word is the commonest search shape and must not come back as a
    // failure claiming the word is not a native.
    info = await callTool(client, "fivem_native_info", { query: "health" });
    check(
      "a one-word search is an answer, not an error",
      !info.isError && !info.text.includes("is not a native"),
      info.text.slice(0, 120),
    );
    info = await callTool(client, "fivem_native_info", { query: "GET_GROUND_Z" });
    check(
      "and a reference-style prefix stays a search",
      !info.isError && info.text.includes("GetGroundZFor_3dCoord"),
      info.text.slice(0, 120),
    );

    info = await callTool(client, "fivem_native_info", { query: "GetGroundZFor_3dCoord" });
    check("a native with examples shows them", info.text.includes("example ("));

    info = await callTool(client, "fivem_native_info", { query: "GetEntityHeading" });
    check(
      "a native this build lacks is called out",
      info.text.includes("NOT present in the connected client"),
    );

    section("Session replacement");
    const second = connectMock();
    check("second mock connects", (await second.ready) !== null);
    check("first session was closed with 4009", (await mock.closed) === 4009);
    status = await callTool(client, "fivem_bridge_status");
    check("status still reports connected", status.text.includes("connected to resource"));
    exec = await callTool(client, "fivem_execute_command", { command: "say still fine" });
    check("commands work on the replacement session", !exec.isError);

    section("Rejected connections");
    const badToken = connectMock({ token: "wrong-token-value" });
    check("bad token closes with 4001", (await badToken.closed) === 4001);
    const badOrigin = connectMock({ origin: "https://evil.example" });
    check("foreign origin closes with 4003", (await badOrigin.closed) === 4003);
    const noOrigin = connectMock({ omitOrigin: true });
    check("missing origin closes with 4003", (await noOrigin.closed) === 4003);
    const wrongResource = connectMock({ resource: "other-resource", origin: `https://cfx-nui-${RESOURCE}` });
    check("resource/origin mismatch closes with 4004", (await wrongResource.closed) === 4004);

    section("Bridge survives the rejects");
    exec = await callTool(client, "fivem_execute_command", { command: "say still here" });
    check("still able to execute", !exec.isError, exec.text);

    section("Client log reading");
    let logs = await callTool(client, "fivem_read_log");
    check("returns the whole fixture by default", logs.text.includes("first marker") && logs.text.includes("second marker"));
    check("strips the engine prefix", !logs.text.includes("b3751_GTAProce"));
    logs = await callTool(client, "fivem_read_log", { lines: 1 });
    check("honours the line count", logs.text.includes("second marker") && !logs.text.includes("first marker"));
    logs = await callTool(client, "fivem_read_log", { filter: "[fivem-mcp-bridge]" });
    check("filters before taking the tail", logs.text.includes("first marker") && !logs.text.includes("unrelated chatter"));
    logs = await callTool(client, "fivem_read_log", { lines: 1, raw: true });
    check("raw keeps the engine prefix", logs.text.includes("b3751_GTAProce"));
    logs = await callTool(client, "fivem_read_log", { filter: "nothing matches this" });
    check("says so when nothing matches", logs.text.includes("No lines matching"));

    section("Late log flush is still captured");
    {
      // The game flushes on its own schedule: this line lands ~450 ms after the
      // command, past the old fixed 250 ms settle window that used to hand it
      // to the next call. The capture poll has to pick it up in this one.
      const logFile = join(PACKAGE_ROOT, ".smoke-tmp", "logs", "CitizenFX_log_2026-01-01T000000.log");
      const pending = callTool(client, "fivem_execute_command", {
        command: "say flush",
        captureLog: true,
      });
      setTimeout(() => {
        appendFileSync(
          logFile,
          "[     2000] [b3751_GTAProce]             MainThrd/ [fivem-mcp-bridge] late flush line\n",
        );
      }, 450);
      exec = await pending;
      check(
        "a line flushed after the old settle window is captured",
        !exec.isError && exec.text.includes("late flush line"),
        exec.text.slice(0, 300),
      );
    }

    section("Crash dumps");
    let crash = await callTool(client, "fivem_read_crash");
    check("defaults to the newest crash", crash.text.includes(`Crash ${CRASH_A}`));
    check("correlates the exception from the log", crash.text.includes("Exception, unhandled!"));
    check("carries the stack trace", crash.text.includes("smoke-module.dll+DEAD"));
    check("stops at the block terminator", !crash.text.includes("chatter after the block"));
    check("names the capturing log", crash.text.includes("CitizenFX_log_2025-12-31T230000.log"));
    check("lists the gamelog sections", crash.text.includes("SYSTEM INFO, POOL INFO, PACK INFO"));
    check("lists the older crash", crash.text.includes(CRASH_B) && crash.text.includes("no gamelog"));

    crash = await callTool(client, "fivem_read_crash", { id: "22222222" });
    check("a uuid prefix selects an older crash", crash.text.includes(`Crash ${CRASH_B}`));
    check("says when no log block matches", crash.text.includes("No matching crash block"));
    check("says when there is no gamelog", crash.text.includes("has no .dmp.gamelog"));

    crash = await callTool(client, "fivem_read_crash", { section: "PACK INFO" });
    check(
      "a big section is truncated at the line cap",
      crash.text.includes("first 400 of 500 line(s)") && crash.text.includes("pack line 400"),
      crash.text.slice(0, 120),
    );
    crash = await callTool(client, "fivem_read_crash", { section: "pool" });
    check("a section prefix matches case-insensitively", crash.text.includes("POOL INFO") && crash.text.includes("PoolB, 4, 5, 6"));
    crash = await callTool(client, "fivem_read_crash", { section: "pool", filter: "PoolC" });
    check("section filter narrows the lines", crash.text.includes("PoolC") && !crash.text.includes("PoolA"));
    crash = await callTool(client, "fivem_read_crash", { section: "NOPE" });
    check(
      "an unknown section errors with the available names",
      crash.isError && crash.text.includes("Available sections") && crash.text.includes("PACK INFO"),
    );
    crash = await callTool(client, "fivem_read_crash", { id: "ffffffff" });
    check(
      "an unknown id errors with the known crashes",
      crash.isError && crash.text.includes(CRASH_A) && crash.text.includes(CRASH_B),
    );

    // This section takes real screenshots of whoever runs it, at 320 px wide,
    // and keeps nothing: the capture is deleted once it has been returned. It
    // has to pass on a dev box, on a dev box without FiveM, and on a headless
    // agent with no desktop at all -- so every check accepts either a real
    // image or a named, prose failure, never "it worked".
    section("Screenshot");
    const CAPTURE_EXCUSES = [
      "only supported on Windows",
      "could not be started",
      "printed nothing usable",
      "reports no displays",
      "did not finish within",
      "compile its Windows API bindings",
      "LanguageMode",
    ];
    const degradesGracefully = (r) =>
      r.isError && CAPTURE_EXCUSES.some((hint) => r.text.includes(hint));

    let shot = await callTool(client, "fivem_screenshot", {
      display: "primary",
      maxWidth: 320,
      format: "jpeg",
      quality: 60,
    });
    if (shot.images.length === 1) {
      const [picture] = shot.images;
      const bytes = Buffer.from(picture.data, "base64");
      check("mimeType matches the requested format", picture.mimeType === "image/jpeg", picture.mimeType);
      check("the base64 decodes to a JPEG", bytes.subarray(0, 2).toString("hex") === "ffd8");
      check("the data carries no newlines", !picture.data.includes("\n"));
      check("a caption names the display", shot.text.includes("Display "), shot.text.slice(0, 120));
      check("and reports the scaled size", /Returned 320x\d+ JPEG/.test(shot.text), shot.text.slice(0, 160));
      check("and which DPI awareness it got", shot.text.includes("DPI awareness:"));
    } else {
      check("a primary capture degrades gracefully", degradesGracefully(shot), shot.text.slice(0, 200));
    }

    shot = await callTool(client, "fivem_screenshot", { display: "auto", maxWidth: 320 });
    check(
      "auto either captures or explains itself",
      shot.images.length === 1 || degradesGracefully(shot),
      shot.text.slice(0, 200),
    );
    // No FiveM window exists on a test box, so this exercises only the arg
    // plumbing and the fallback path; the window-crop bounds are a live check.
    shot = await callTool(client, "fivem_screenshot", { display: "auto", crop: "display", maxWidth: 320 });
    check(
      "the crop argument is accepted",
      shot.images.length === 1 || degradesGracefully(shot),
      shot.text.slice(0, 200),
    );

    shot = await callTool(client, "fivem_screenshot", { display: 15, maxWidth: 320 });
    check(
      "an impossible display index gets a clear error",
      shot.images.length === 1 ||
        shot.text.includes("There is no display 15") ||
        degradesGracefully(shot),
      shot.text.slice(0, 200),
    );

    // Only the paths that reject *before* anything is spawned -- a smoke test
    // must never start someone's game. The fixture config leaves
    // launch.defaultAddress null, so the missing-address branch is deterministic.
    section("Launch");
    let launch = await callTool(client, "fivem_launch");
    check(
      "no address is refused, not guessed",
      launch.isError && launch.text.includes("Ask the user which server to join"),
      launch.text.slice(0, 160),
    );
    check("and it says where a default would live", launch.text.includes("launch.defaultAddress"));
    launch = await callTool(client, "fivem_launch", { address: "not a server!!" });
    check(
      "a host that could never resolve is rejected",
      launch.isError && launch.text.includes("is not a usable host"),
      launch.text.slice(0, 160),
    );
    launch = await callTool(client, "fivem_launch", { address: "http://example.com/join" });
    check(
      "a malformed address is rejected",
      launch.isError && launch.text.includes("is not a server address"),
      launch.text.slice(0, 160),
    );
    launch = await callTool(client, "fivem_launch", { address: "127.0.0.1:70000" });
    check(
      "an impossible port is rejected",
      launch.isError && launch.text.includes("is not a port number"),
      launch.text.slice(0, 160),
    );

    // The fake panel comes up only now: the earlier sections prove nothing
    // dials txAdmin until a server tool is actually called.
    section("txAdmin: server console");
    txMock = createMockTxAdmin(TX_PORT);
    await txMock.start();
    let sc = await callTool(client, "fivem_server_console");
    check(
      "connects on demand and returns the boot buffer",
      !sc.isError && sc.text.includes("server booted"),
      sc.text.slice(0, 200),
    );
    check("ANSI escapes are stripped", !sc.text.includes("\u001b") && !sc.text.includes("[32m"));
    check("carriage returns are normalized", !sc.text.includes("\r"));
    check(
      "txAdmin time markers are rendered as wall-clock prefixes",
      !sc.text.includes("{§") && /\[\d{2}:\d{2}:\d{2}\] \[smoke-tx\] server booted/.test(sc.text),
      sc.text.slice(0, 200),
    );
    const cursorMatch = sc.text.match(/Next cursor: (\d+)/);
    check("the answer ends with a cursor", cursorMatch !== null);
    const cursorAfterBoot = cursorMatch ? Number(cursorMatch[1]) : 0;
    status = await callTool(client, "fivem_bridge_status");
    check(
      "bridge status carries the txAdmin line",
      status.text.includes("txAdmin (http://127.0.0.1:") && status.text.includes("connected since"),
      status.text.slice(-300),
    );

    section("txAdmin: server command");
    let cmd = await callTool(client, "fivem_server_command", { command: "status" });
    check(
      "the command is dispatched",
      !cmd.isError && cmd.text.includes('Dispatched "status"'),
      cmd.text.slice(0, 200),
    );
    check("output that followed is captured", cmd.text.includes("status output ok"));
    check("the fake panel received it", txMock.state.commands.includes("status"));
    sc = await callTool(client, "fivem_server_console", { cursor: cursorAfterBoot });
    check(
      "a cursor read returns only newer output",
      sc.text.includes("status output ok") && !sc.text.includes("server booted"),
      sc.text.slice(0, 200),
    );
    sc = await callTool(client, "fivem_server_console", { filter: "booted" });
    check(
      "filter narrows to matching lines",
      sc.text.includes("server booted") && !sc.text.includes("status output ok"),
    );
    // One console line longer than the whole read window: the newline-aligned
    // trim must fall back to a fragment, not an empty answer.
    await callTool(client, "fivem_server_command", { command: `status ${"x".repeat(300)}` });
    sc = await callTool(client, "fivem_server_console", { maxBytes: 256 });
    check(
      "a window smaller than the last line keeps a fragment",
      !sc.isError &&
        sc.text.includes("cut at the front") &&
        sc.text.includes("output ok") &&
        !sc.text.includes("No console output buffered"),
      sc.text.slice(0, 300),
    );
    cmd = await callTool(client, "fivem_server_command", { command: "silent" });
    check(
      "a command with no output says so",
      !cmd.isError && cmd.text.includes("No console output followed"),
      cmd.text.slice(0, 200),
    );
    check("and mentions the write permission", cmd.text.includes("Console: Write"));
    cmd = await callTool(client, "fivem_server_command", { command: "quit now" });
    check(
      "the server denylist blocks quit",
      cmd.isError && cmd.text.includes("server command policy"),
      cmd.text.slice(0, 200),
    );
    check("and it never reached txAdmin", !txMock.state.commands.some((c) => c.startsWith("quit")));
    cmd = await callTool(client, "fivem_server_command", { command: "stop fivem-mcp-bridge" });
    check(
      "stopping the bridge resource is blocked",
      cmd.isError && cmd.text.includes("protectedResources"),
      cmd.text.slice(0, 200),
    );
    check("the stop never reached txAdmin", !txMock.state.commands.some((c) => c.startsWith("stop")));
    cmd = await callTool(client, "fivem_server_command", { command: "restart fivem-mcp-bridge" });
    check(
      "restarting it passes, with a bridge warning",
      !cmd.isError && cmd.text.includes("carries the bridge"),
      cmd.text.slice(0, 300),
    );

    section("txAdmin: reconnect after a panel restart");
    await txMock.stop();
    await sleep(200);
    await txMock.start();
    sc = await pollUntil(async () => {
      const read = await callTool(client, "fivem_server_console");
      return !read.isError && read.text.includes("server booted") ? read : null;
    }, 15_000, 400);
    check("the console tool recovers on its own", sc !== null, "no successful read within 15 s");
    if (sc) {
      check("a gap marker was appended", sc.text.includes("[fivem-mcp] connection to txAdmin lost"));
      const bootCount = sc.text.split("server booted").length - 1;
      check("the replayed buffer was deduplicated", bootCount === 1, `saw it ${bootCount} time(s)`);
    }

    section("txAdmin: wrong credentials stay sticky");
    const txBad = createMockTxAdmin(TX_PORT_BADPASS);
    await txBad.start();
    const clientBad = await startClient(configPath, String(Number(PORT) + 2), {
      FIVEM_TXADMIN_URL: `http://127.0.0.1:${TX_PORT_BADPASS}`,
      FIVEM_TXADMIN_PASSWORD: "wrong-password",
    });
    let bad = await callTool(clientBad, "fivem_server_console");
    check(
      "the login rejection is explained",
      bad.isError && bad.text.includes("rejected the login"),
      bad.text.slice(0, 200),
    );
    check("and warns about the ban behavior", bad.text.includes("ban"));
    bad = await callTool(clientBad, "fivem_server_console");
    check("the failure is sticky", bad.isError && bad.text.includes("rejected the login"));
    check(
      "exactly one login was attempted",
      txBad.state.loginAttempts === 1,
      `${txBad.state.loginAttempts} attempt(s)`,
    );
    await clientBad.close().catch(() => {});
    await txBad.stop();

    section("txAdmin: unreachable panel");
    const clientGone = await startClient(configPath, String(Number(PORT) + 3), {
      FIVEM_TXADMIN_URL: `http://127.0.0.1:${TX_PORT_CLOSED}`,
      FIVEM_TXADMIN_PASSWORD: TX_PASS,
    });
    const gone = await callTool(clientGone, "fivem_server_console");
    check(
      "an unreachable panel gets remediation prose",
      gone.isError && gone.text.includes("Could not reach txAdmin"),
      gone.text.slice(0, 200),
    );
    await clientGone.close().catch(() => {});

    section("txAdmin: account without console permissions");
    const txQuiet = createMockTxAdmin(TX_PORT_NOPERM, { consolePermission: false });
    await txQuiet.start();
    const clientQuiet = await startClient(configPath, String(Number(PORT) + 4), {
      FIVEM_TXADMIN_URL: `http://127.0.0.1:${TX_PORT_NOPERM}`,
      FIVEM_TXADMIN_PASSWORD: TX_PASS,
    });
    const quiet = await callTool(clientQuiet, "fivem_server_console");
    check(
      "a joined room without console data warns about Console: View",
      !quiet.isError && quiet.text.includes("Console: View"),
      quiet.text.slice(0, 200),
    );
    await clientQuiet.close().catch(() => {});
    await txQuiet.stop();

    section("txAdmin: capture waits for late output");
    cmd = await callTool(client, "fivem_server_command", { command: "slow" });
    check(
      "output arriving after the settle window is still captured",
      !cmd.isError && cmd.text.includes("slow output arrived late"),
      cmd.text.slice(0, 200),
    );

    section("Server console: waitFor");
    {
      const pendingWait = callTool(client, "fivem_server_console", {
        waitFor: "round ended",
        waitTimeoutMs: 5000,
      });
      setTimeout(() => {
        txMock.state.streamed += "round ended: alpha wins\r\n";
        txMock.state.io.emit("consoleData", "round ended: alpha wins\r\n");
      }, 400);
      sc = await pendingWait;
      check(
        "waitFor returns on the matching line",
        !sc.isError && sc.text.includes("matched") && sc.text.includes("round ended: alpha wins"),
        sc.text.slice(0, 300),
      );
      sc = await callTool(client, "fivem_server_console", {
        waitFor: "never gonna appear",
        waitTimeoutMs: 600,
      });
      check("waitFor timeout says so", !sc.isError && sc.text.includes("did not match"), sc.text.slice(0, 200));
      sc = await callTool(client, "fivem_server_console", { filter: "^> status$", filterRegex: true });
      check(
        "filterRegex narrows to the exact line",
        !sc.isError && sc.text.includes("> status") && !sc.text.includes("output ok"),
        sc.text.slice(0, 300),
      );
      sc = await callTool(client, "fivem_server_console", { filter: "[invalid", filterRegex: true });
      check("a broken filter regex is named", sc.isError && sc.text.includes("not a valid regular expression"));
    }

    section("fivem_check_resource");
    {
      const dirtyPath = join(PACKAGE_ROOT, ".smoke-tmp", "fixture-dirty");
      let lint = await callTool(client, "fivem_check_resource", { path: dirtyPath });
      check("a dirty resource fails the check", lint.isError, lint.text.slice(0, 200));
      check(
        "an invented native is flagged with suggestions",
        lint.text.includes("SetControlValueNextFrame") && lint.text.includes("did you mean"),
        lint.text.slice(0, 400),
      );
      check(
        "a typo suggests the real name",
        lint.text.includes("SetEntityCoordss") && lint.text.includes("SetEntityCoords"),
      );
      check(
        "a server-only native in a client file is flagged",
        /DropPlayer is a server-only native[\s\S]{0,80}client script/.test(lint.text),
        lint.text.slice(0, 600),
      );
      check(
        "a client-only native in a server file is flagged",
        /PlayerPedId is a client-only native/.test(lint.text),
      );
      check(
        "the resource's own cross-file global is not flagged",
        !lint.text.includes("SpawnLobby"),
        lint.text,
      );
      check(
        "the optional-params overlay silences the GetEntityCoords arity warning",
        !lint.text.includes("GetEntityCoords is called"),
        lint.text,
      );
      lint = await callTool(client, "fivem_check_resource", {
        path: join(PACKAGE_ROOT, ".smoke-tmp", "fixture-clean"),
      });
      check("a clean resource passes", !lint.isError && lint.text.includes("no issues"), lint.text.slice(0, 200));
      lint = await callTool(client, "fivem_check_resource", {
        path: join(PACKAGE_ROOT, ".smoke-tmp", "does-not-exist"),
      });
      check(
        "a folder without a manifest is explained",
        lint.isError && lint.text.includes("fxmanifest.lua"),
      );
    }

    section("Client log: cursor and waitFor");
    {
      const logFile = join(PACKAGE_ROOT, ".smoke-tmp", "logs", "CitizenFX_log_2026-01-01T000000.log");
      logs = await callTool(client, "fivem_read_log");
      const cursorMatch1 = logs.text.match(/Next cursor: (\S+)/);
      check("read_log answers with a cursor", cursorMatch1 !== null, logs.text.slice(-120));
      appendFileSync(
        logFile,
        "[     3000] [b3751_GTAProce]             MainThrd/ [fivem-mcp-bridge] cursor line one\n",
      );
      logs = await callTool(client, "fivem_read_log", { cursor: cursorMatch1[1] });
      check(
        "a cursor read returns only newer lines",
        logs.text.includes("cursor line one") && !logs.text.includes("first marker"),
        logs.text.slice(0, 300),
      );
      const cursorMatch2 = logs.text.match(/Next cursor: (\S+)/);
      logs = await callTool(client, "fivem_read_log", { cursor: cursorMatch2[1] });
      check("says when nothing is new", logs.text.includes("No new lines since"), logs.text.slice(0, 200));

      logs = await callTool(client, "fivem_read_log", { filter: "second marker$", filterRegex: true });
      check(
        "filterRegex matches the formatted line",
        logs.text.includes("second marker") && !logs.text.includes("first marker"),
        logs.text.slice(0, 300),
      );

      const pendingWait = callTool(client, "fivem_read_log", {
        waitFor: "round really over",
        waitTimeoutMs: 5000,
      });
      setTimeout(() => {
        appendFileSync(
          logFile,
          "[     4000] [b3751_GTAProce]             MainThrd/ [ffa] round really over\n",
        );
      }, 400);
      logs = await pendingWait;
      check(
        "waitFor returns on the matching line",
        !logs.isError && logs.text.includes("matched") && logs.text.includes("round really over"),
        logs.text.slice(0, 300),
      );
      logs = await callTool(client, "fivem_read_log", { waitFor: "nope never", waitTimeoutMs: 600 });
      check("waitFor timeout says so", !logs.isError && logs.text.includes("did not match"));

      // Rotation last: a NEWER log file appears, and the old cursor must fall
      // back to the tail of the new file with an honest note.
      const rotated = join(PACKAGE_ROOT, ".smoke-tmp", "logs", "CitizenFX_log_2026-01-02T000000.log");
      writeFileSync(
        rotated,
        "[      100] [b3751_GTAProce]             MainThrd/ fresh session line\n",
      );
      logs = await callTool(client, "fivem_read_log", { cursor: cursorMatch2[1] });
      check(
        "a cursor from before a rotation falls back with a note",
        logs.text.includes("rotated") && logs.text.includes("fresh session line"),
        logs.text.slice(0, 300),
      );
    }

    section("Server eval (fivem_server_run_code)");
    {
      const evalMock = createMockEval(EVAL_PORT);
      await evalMock.start();
      const clientEval = await startClient(".smoke-tmp/config-servereval.json", String(Number(PORT) + 5));
      try {
        const { tools: evalTools } = await clientEval.listTools();
        check(
          "the tool is registered when serverEval.enabled",
          evalTools.some((t) => t.name === "fivem_server_run_code"),
        );
        let run = await callTool(clientEval, "fivem_server_run_code", {
          code: "return GetResourceState('ffa')",
        });
        check(
          "a server snippet runs against the eval endpoint",
          !run.isError && run.text.includes("Server snippet ran") && run.text.includes("echoed"),
          run.text.slice(0, 300),
        );
        check("ctx.log output rides along", run.text.includes("from ctx.log"));

        const requestsBefore = evalMock.state.requests;
        run = await callTool(clientEval, "fivem_server_run_code", {
          code: "return PlayerPedId()",
          nativeCheck: "strict",
        });
        check(
          "strict mode rejects a client-only native before sending",
          run.isError && run.text.includes("client") && evalMock.state.requests === requestsBefore,
          run.text.slice(0, 200),
        );
        run = await callTool(clientEval, "fivem_server_run_code", { code: "return PlayerPedId()" });
        check(
          "the default warn mode runs it and says so",
          !run.isError && run.text.includes("PlayerPedId"),
          run.text.slice(0, 300),
        );

        evalMock.state.mode = "badtoken";
        run = await callTool(clientEval, "fivem_server_run_code", { code: "return 1" });
        check("a token mismatch is explained", run.isError && run.text.includes("token"), run.text.slice(0, 200));

        evalMock.state.mode = "disabled";
        run = await callTool(clientEval, "fivem_server_run_code", { code: "return 1" });
        check(
          "a 404 names the resource-side flag",
          run.isError && run.text.includes("serverEval = true"),
          run.text.slice(0, 250),
        );
      } finally {
        await clientEval.close().catch(() => {});
        await evalMock.stop();
      }
    }

    section("NUI tools against a fake CDP endpoint");
    {
      const cdpMock = createMockCdp(CDP_PORT);
      await cdpMock.start();
      try {
        let nui = await callTool(client, "fivem_nui_frames");
        check(
          "frames are mapped to their resource",
          !nui.isError && nui.text.includes("ffa -- https://cfx-nui-ffa/index.html"),
          nui.text.slice(0, 300),
        );
        nui = await callTool(client, "fivem_nui_snapshot", { resource: "ffa" });
        check(
          "the snapshot returns the DOM outline",
          !nui.isError && nui.text.includes("button.join") && nui.text.includes("[clickable]"),
          nui.text.slice(0, 300),
        );
        const snapshotEval = cdpMock.state.evaluated[cdpMock.state.evaluated.length - 1];
        check("the snapshot ran in the isolated world", snapshotEval?.contextId === 99);

        nui = await callTool(client, "fivem_nui_click", { resource: "ffa", selector: ".join" });
        check(
          "a click dispatches through the page",
          !nui.isError && nui.text.includes("Clicked button.join"),
          nui.text.slice(0, 200),
        );
        const clickEval = cdpMock.state.evaluated[cdpMock.state.evaluated.length - 1];
        check("the click ran in the frame's main world", clickEval?.contextId === 12);

        nui = await callTool(client, "fivem_nui_click", { resource: "ffa", selector: "#nope" });
        check(
          "a missed selector answers with the clickable candidates",
          nui.isError && nui.text.includes('button.join -- "Join"'),
          nui.text.slice(0, 300),
        );

        nui = await callTool(client, "fivem_nui_eval", { resource: "ffa", code: "6*7" });
        check("eval returns the value", !nui.isError && nui.text.includes("42"), nui.text.slice(0, 200));
        nui = await callTool(client, "fivem_nui_eval", { resource: "ffa", code: "throwPlease()" });
        check("a page exception is surfaced", nui.isError && nui.text.includes("nope"), nui.text.slice(0, 200));

        nui = await callTool(client, "fivem_nui_click", { resource: "ghost", selector: ".x" });
        check(
          "an unknown resource lists the ones that exist",
          nui.isError && nui.text.includes("ffa"),
          nui.text.slice(0, 200),
        );
      } finally {
        await cdpMock.stop();
      }
      const gone2 = await callTool(client, "fivem_nui_frames");
      check(
        "an unreachable DevTools endpoint gets remediation prose",
        gone2.isError && gone2.text.includes("Could not reach FiveM's NUI DevTools"),
        gone2.text.slice(0, 200),
      );
    }

    // Everything below runs two (then three) real MCP server processes against
    // the same port; the sections build on each other in order.
    section("Multi-session: a second server attaches as a peer");
    clientB = await startClient(configPath, PORT);
    const { tools: toolsB } = await clientB.listTools();
    check(
      "the second server exposes the same tools instead of dying on EADDRINUSE",
      toolsB.map((t) => t.name).sort().join(",") === names.join(","),
      toolsB.map((t) => t.name).join(","),
    );
    // clientB got no txAdmin password (startClient clears the env, the fixture
    // passwordFile does not exist) -- the tool must explain the setup.
    const misconfigured = await callTool(clientB, "fivem_server_console");
    check(
      "a missing password explains the txAdmin setup",
      misconfigured.isError && misconfigured.text.includes("not configured"),
      misconfigured.text.slice(0, 200),
    );
    let statusB = await callTool(clientB, "fivem_bridge_status");
    check("peer status reports the connected game", statusB.text.includes(`connected to resource "${RESOURCE}"`));
    check("and names its role", statusB.text.includes("Role: peer"));
    status = await callTool(client, "fivem_bridge_status");
    check("host status counts the attached peer", status.text.includes("Role: host (1 peer"));

    section("Multi-session: peer requests reach the one game client");
    exec = await callTool(clientB, "fivem_execute_command", { command: "say via peer" });
    check("a command via the peer succeeds", !exec.isError && exec.text.includes('Executed "say via peer"'));
    check("the same single mock received it", second.received.includes("say via peer"));

    section("Multi-session: both sessions at once");
    const [fromA, fromB] = await Promise.all([
      callTool(client, "fivem_execute_command", { command: "say from host" }),
      callTool(clientB, "fivem_execute_command", { command: "say from peer" }),
    ]);
    check(
      "the host-side command settles with its own reply",
      !fromA.isError && fromA.text.includes("say from host") && !fromA.text.includes("say from peer"),
    );
    check(
      "the peer-side command settles with its own reply",
      !fromB.isError && fromB.text.includes("say from peer") && !fromB.text.includes("say from host"),
    );
    check(
      "the game received both",
      second.received.includes("say from host") && second.received.includes("say from peer"),
    );

    section("Multi-session: peer admission is not a hole");
    const badPeer = new WebSocket(`ws://127.0.0.1:${PORT}/peer`);
    badPeer.on("open", () =>
      badPeer.send(
        JSON.stringify({ t: "hello", protocol: 1, token: "wrong-token", resource: "mcp", client: "mcp" }),
      ),
    );
    const badPeerClose = await new Promise((r) => badPeer.once("close", (code) => r(code)));
    check("a peer with a bad token closes with 4001", badPeerClose === 4001);
    const stillBadOrigin = connectMock({ origin: "https://evil.example" });
    check("a foreign NUI origin still closes with 4003", (await stillBadOrigin.closed) === 4003);

    section("Multi-session: proxied not-connected");
    second.ws.close(1000, "done");
    await second.closed;
    await sleep(150);
    exec = await callTool(clientB, "fivem_execute_command", { command: "say nobody home" });
    check(
      "the peer reports not connected once the game is gone",
      exec.isError && exec.text.includes("No FiveM bridge is connected"),
    );

    section("Multi-session: the peer takes over when the host exits");
    await client.close();
    const promoted = await pollUntil(async () => {
      const s = await callTool(clientB, "fivem_bridge_status");
      return s.text.includes("Role: host") ? s : null;
    }, 10_000);
    check("the surviving server became the host", promoted !== null);
    // The real payload reconnects on its own; this raw mock has to redial.
    const third = connectMock();
    check("a game client reaches the new host", (await third.ready) !== null);
    exec = await callTool(clientB, "fivem_execute_command", { command: "say new host" });
    check(
      "commands work on the new host",
      !exec.isError && third.received.includes("say new host"),
      exec.text.slice(0, 160),
    );
    third.ws.close(1000, "done");

    section("Rate-limit reset on session replacement");
    const RL_PORT = String(Number(PORT) + 1);
    clientC = await startClient(".smoke-tmp/config-ratelimit.json", RL_PORT);
    const rl1 = connectMock({ port: RL_PORT });
    check("rate-limit mock connects", (await rl1.ready) !== null);
    exec = await callTool(clientC, "fivem_execute_command", { command: "say one" });
    check("first command fits the window", !exec.isError);
    exec = await callTool(clientC, "fivem_execute_command", { command: "say two" });
    check("second command fills it", !exec.isError);
    exec = await callTool(clientC, "fivem_execute_command", { command: "say three" });
    check("the third is rate-limited", exec.isError && exec.text.includes("Rate limit reached"));
    const rl2 = connectMock({ port: RL_PORT });
    check("a replacement session connects", (await rl2.ready) !== null);
    check("the old one was closed with 4009", (await rl1.closed) === 4009);
    exec = await callTool(clientC, "fivem_execute_command", { command: "say fresh window" });
    check(
      "the new session starts with a fresh budget",
      !exec.isError && rl2.received.includes("say fresh window"),
      exec.text.slice(0, 160),
    );
    rl2.ws.close(1000, "done");
    await sleep(100);
  } finally {
    await client.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
    if (clientC) await clientC.close().catch(() => {});
    if (txMock) await txMock.stop().catch(() => {});
  }

  finish();
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
