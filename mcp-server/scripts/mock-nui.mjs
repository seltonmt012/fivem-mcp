#!/usr/bin/env node
/**
 * Fake NUI client — stands in for the FiveM resource so the whole bridge can be
 * tested without starting the game.
 *
 *   node scripts/mock-nui.mjs                  connect and acknowledge everything
 *   node scripts/mock-nui.mjs --bad-token      expect close 4001
 *   node scripts/mock-nui.mjs --no-origin      expect close 4003 (unless allowNoOrigin)
 *   node scripts/mock-nui.mjs --bad-origin     expect close 4003
 *   node scripts/mock-nui.mjs --silent         never answer, to test tool timeouts
 *   node scripts/mock-nui.mjs --fail           answer every command with ok:false
 *   node scripts/mock-nui.mjs --delay 2000     answer after 2000 ms
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import WebSocket from "ws";

import { PACKAGE_ROOT } from "./lib.mjs";

const PROTOCOL_VERSION = 1;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const resource = value("resource", "fivem-mcp-bridge");
const url = value("url", `ws://127.0.0.1:${process.env.FIVEM_BRIDGE_PORT ?? 39271}`);
const delay = Number.parseInt(value("delay", "0"), 10);

const token = flag("bad-token") ? "definitely-not-the-token" : readToken();

const headers = {};
if (flag("bad-origin")) {
  headers.Origin = "https://evil.example";
} else if (!flag("no-origin")) {
  headers.Origin = value("origin", `https://cfx-nui-${resource}`);
}

function readToken() {
  const explicit = value("token", null) ?? process.env.FIVEM_BRIDGE_TOKEN;
  if (explicit) return explicit.trim();
  const path = resolve(PACKAGE_ROOT, value("token-file", null) ?? configuredTokenFile());
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    console.error(
      `Could not read a token from ${path}. Start the server once so it generates one, ` +
        "or pass --token <value>.",
    );
    process.exit(1);
  }
}

/**
 * The same tokenFile the server reads, so the mock talks to a server set up
 * per the README (which points tokenFile into the resource folder) without
 * needing --token-file. Falls back to the schema default.
 */
function configuredTokenFile() {
  try {
    const raw = readFileSync(resolve(PACKAGE_ROOT, "fivem-mcp.config.json"), "utf8");
    const tokenFile = JSON.parse(raw).tokenFile;
    if (typeof tokenFile === "string" && tokenFile !== "") return tokenFile;
  } catch {
    /* no config file -- use the default */
  }
  return "../fivem-mcp-bridge/bridge.token";
}

console.error(`Connecting to ${url} as "${resource}" (origin: ${headers.Origin ?? "none"})`);
const ws = new WebSocket(url, { headers });

/** Replies to a request, honouring --silent, --fail and --delay. */
function answer(id, data) {
  if (flag("silent")) {
    console.error("   --silent: not answering");
    return;
  }
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const reply = flag("fail")
      ? { t: "result", id, ok: false, error: "mock failure (--fail)" }
      : { t: "result", id, ok: true, data };
    ws.send(JSON.stringify(reply));
    console.error(`   answered ok=${reply.ok}`);
  }, delay);
}

ws.on("open", () => {
  console.error("Socket open, sending hello");
  ws.send(
    JSON.stringify({
      t: "hello",
      protocol: PROTOCOL_VERSION,
      token,
      resource,
      client: "mock",
    }),
  );
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.error(`Unparseable frame: ${raw.toString().slice(0, 200)}`);
    return;
  }

  switch (msg.t) {
    case "welcome":
      console.error(`Handshake accepted. session=${msg.sessionId} server=${msg.serverVersion}`);
      ws.send(JSON.stringify({ t: "log", level: "info", message: "mock NUI client ready" }));
      break;

    case "ping":
      ws.send(JSON.stringify({ t: "pong", id: msg.id }));
      break;

    case "command":
      console.error(`>> command received: ${msg.command}  (id=${msg.id})`);
      answer(msg.id, { echoed: msg.command, executedBy: "mock-nui" });
      break;

    case "eval":
      console.error(`>> snippet received (${msg.code.length} chars, id=${msg.id})`);
      // No Lua here -- the mock proves the transport, not the interpreter.
      answer(msg.id, {
        payloadRevision: 0,
        durationMs: 0,
        returned: [{ evaluatedBy: "mock-nui", codeLength: msg.code.length }],
      });
      break;

    default:
      console.error(`Unhandled message type: ${msg.t}`);
  }
});

ws.on("close", (code, reason) => {
  console.error(`Socket closed. code=${code} reason=${reason.toString() || "-"}`);
  process.exit(code === 1000 || code === 1005 ? 0 : 1);
});

ws.on("error", (err) => {
  console.error(`Socket error: ${err.message}`);
});

process.on("SIGINT", () => {
  ws.close(1000, "mock shutdown");
});
