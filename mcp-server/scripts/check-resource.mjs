#!/usr/bin/env node
/**
 * Static checks for ../fivem-mcp-bridge.
 *
 * The important one is the manifest invariant: the whole loader concept rests
 * on payload/, config.lua and bridge.token being absent from files{} and from
 * every client script list. Adding one of them there breaks nothing visibly --
 * it just quietly ships the tooling and the shared secret to every player.
 *
 *   node scripts/check-resource.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import luaparse from "luaparse";

import { check, finish, PACKAGE_ROOT, section } from "./lib.mjs";

const RESOURCE_ROOT = resolve(PACKAGE_ROOT, "../fivem-mcp-bridge");

/** Paths that must never be reachable by a client. */
const SERVER_ONLY = ["payload/", "server/", "config.lua", "bridge.token", "authorized.txt"];

function read(relPath) {
  return readFileSync(join(RESOURCE_ROOT, relPath), "utf8");
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * fxmanifest
 * ------------------------------------------------------------------ */

/**
 * Pulls the string values out of a manifest directive, covering both forms:
 *   client_script 'a.lua'
 *   client_scripts { 'a.lua', 'b.lua' }
 */
function manifestEntries(manifest, directive) {
  const entries = [];
  const pattern = new RegExp(`\\b${directive}\\b\\s*(\\{[^}]*\\}|'[^']*'|"[^"]*")`, "g");

  for (const match of manifest.matchAll(pattern)) {
    const block = match[1];
    // Strip Lua line comments so commented-out paths do not count.
    const cleaned = block.replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--[^\n]*/g, "");
    for (const str of cleaned.matchAll(/['"]([^'"]+)['"]/g)) {
      entries.push(str[1]);
    }
  }
  return entries;
}

const manifest = read("fxmanifest.lua");
// The trailing block comment documents the invariant; it must not be scanned.
const manifestCode = manifest.replace(/--\[\[[\s\S]*?\]\]/g, "");

const clientReachable = [
  ...manifestEntries(manifestCode, "files"),
  ...manifestEntries(manifestCode, "file"),
  ...manifestEntries(manifestCode, "client_script"),
  ...manifestEntries(manifestCode, "client_scripts"),
  ...manifestEntries(manifestCode, "shared_script"),
  ...manifestEntries(manifestCode, "shared_scripts"),
];

section("Manifest invariant (server-only files must stay unreachable)");
for (const secret of SERVER_ONLY) {
  const leaked = clientReachable.filter((entry) => {
    const normalised = entry.replace(/\\/g, "/").replace(/^\.\//, "");
    return secret.endsWith("/") ? normalised.startsWith(secret) : normalised === secret;
  });
  check(`"${secret}" is not reachable by clients`, leaked.length === 0, leaked.join(", "));
}
check(
  "no wildcard in files{} could sweep server-only paths in",
  !clientReachable.some((entry) => entry.includes("*")),
  clientReachable.filter((e) => e.includes("*")).join(", "),
);

section("Manifest wiring");
check("ui_page is set", /\bui_page\s*['"]nui\/index\.html['"]/.test(manifestCode));
check("files{} ships nui/index.html", clientReachable.includes("nui/index.html"));
check("files{} ships nui/boot.js", clientReachable.includes("nui/boot.js"));
check(
  "client/loader.lua is the only client script",
  manifestEntries(manifestCode, "client_script").length +
    manifestEntries(manifestCode, "client_scripts").length ===
    1 && clientReachable.includes("client/loader.lua"),
  clientReachable.join(", "),
);
const serverScripts = [
  ...manifestEntries(manifestCode, "server_script"),
  ...manifestEntries(manifestCode, "server_scripts"),
];
check("server_scripts includes config.lua", serverScripts.includes("config.lua"));
check("server_scripts includes server/main.lua", serverScripts.includes("server/main.lua"));
check("server_scripts includes server/eval.lua", serverScripts.includes("server/eval.lua"));
check(
  "config.lua loads before server/eval.lua (the eval gate reads Config)",
  serverScripts.indexOf("config.lua") < serverScripts.indexOf("server/eval.lua"),
);
const sharedScripts = [
  ...manifestEntries(manifestCode, "shared_script"),
  ...manifestEntries(manifestCode, "shared_scripts"),
];
check("shared_scripts includes shared/marshal.lua", sharedScripts.includes("shared/marshal.lua"));

/* ------------------------------------------------------------------ *
 * syntax
 * ------------------------------------------------------------------ */

section("Lua syntax");
for (const file of walk(RESOURCE_ROOT).filter((f) => f.endsWith(".lua"))) {
  const rel = relative(RESOURCE_ROOT, file).replace(/\\/g, "/");
  try {
    luaparse.parse(readFileSync(file, "utf8"), { luaVersion: "5.3" });
    check(rel, true);
  } catch (err) {
    check(rel, false, err.message);
  }
}

section("JavaScript syntax");
for (const rel of ["nui/boot.js", "payload/nui.js"]) {
  try {
    execFileSync(process.execPath, ["--check", join(RESOURCE_ROOT, rel)], { stdio: "pipe" });
    check(rel, true);
  } catch (err) {
    check(rel, false, String(err.stderr ?? err).split("\n").slice(0, 3).join(" "));
  }
}

/* ------------------------------------------------------------------ *
 * hot-reload contract
 * ------------------------------------------------------------------ */

section("Hot-reload contract between the halves");
const bootJs = read("nui/boot.js");
const payloadJs = read("payload/nui.js");
const payloadLua = read("payload/client.lua");
const loaderLua = read("client/loader.lua");

check("payload/nui.js publishes window.__fivemMcp", /window\.__fivemMcp\s*=/.test(payloadJs));
check("payload/nui.js exposes dispose()", /dispose\s*\(\)\s*\{/.test(payloadJs));
check("nui/boot.js reads window.__fivemMcp", /window\.__fivemMcp/.test(bootJs));
check("nui/boot.js listens for fivem-mcp:dispose", /fivem-mcp:dispose/.test(bootJs));
check("client/loader.lua sends fivem-mcp:dispose", /fivem-mcp:dispose/.test(loaderLua));
check("payload/client.lua returns a dispose table", /return\s*\{[\s\S]*dispose\s*=/.test(payloadLua));
check("payload/client.lua returns a handlers table", /return\s*\{[\s\S]*handlers\s*=/.test(payloadLua));

/*
 * The registration invariant, learned the hard way: RegisterNUICallback and
 * RegisterCommand build on AddEventHandler, which ACCUMULATES handlers instead
 * of replacing them. A payload that registers its own callbacks leaves every
 * previous instance answering after a reload, oldest first. Registration must
 * happen once, in the loader.
 */
// Comments are allowed to name these -- the file documents why it must not
// call them -- so only actual code is inspected.
const payloadCode = payloadLua.replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--[^\n]*/g, "");

check(
  "payload/client.lua registers no NUI callbacks of its own",
  !/RegisterNUICallback/.test(payloadCode),
);
check(
  "payload/client.lua registers no commands of its own",
  !/RegisterCommand/.test(payloadCode),
);

for (const callback of ["fivemMcpBoot", "execCommand", "evalCode", "bridgeLog", "bridgeReauth"]) {
  check(
    `client/loader.lua owns the "${callback}" registration`,
    new RegExp(`RegisterNUICallback\\('${callback}'`).test(loaderLua),
  );
}
check(
  "nui/boot.js polls the callback the loader registers",
  /fivemMcpBoot/.test(bootJs) && /RegisterNUICallback\('fivemMcpBoot'/.test(loaderLua),
);
check(
  "the loader dispatches into the payload's handlers table",
  /active\.handlers/.test(loaderLua),
);

/*
 * Order independence: the two sides start on independent schedules, so neither
 * may give up on the other. The loader must keep asking the FiveM server for
 * the payload, and a payload whose token the MCP server rejects must be able to
 * ask for a newer one instead of reconnecting with a token that can never work.
 */
check(
  "client/loader.lua has no attempt limit on the payload request",
  !/attempts\s*<\s*MAX_ATTEMPTS/.test(loaderLua) && !/\bMAX_ATTEMPTS\b/.test(loaderLua),
  "a bounded request loop leaves the client unconnected if it starts before the server",
);
// Comments are stripped first — the handler explains at length why it must not
// call stopRequestLoop, and that explanation must not read as a violation.
const deniedHandler = loaderLua
  .match(/AddEventHandler\('fivem-mcp:denied'[\s\S]*?\n^end\)/m)?.[0]
  ?.replace(/--\[\[[\s\S]*?\]\]/g, "")
  .replace(/--[^\n]*/g, "");
check(
  "a refusal only slows the loader's request loop down, it does not end it",
  Boolean(deniedHandler) &&
    /deniedGeneration\s*=\s*requestGeneration/.test(deniedHandler) &&
    !/stopRequestLoop/.test(deniedHandler),
  deniedHandler ? "the handler still calls stopRequestLoop" : "handler not found",
);
check(
  "payload/nui.js asks for a fresh token on close code 4001",
  /4001/.test(payloadJs) && /"bridgeReauth"/.test(payloadJs),
);

/* ------------------------------------------------------------------ *
 * code execution
 * ------------------------------------------------------------------ */

section("Code execution (fivem_run_code)");
check("payload/client.lua provides handlers.evalCode", /function handlers\.evalCode/.test(payloadCode));
check(
  "payload/client.lua marshals results through the shared AgentMarshal",
  /AgentMarshal/.test(payloadCode),
);
check(
  "snippets are compiled in text mode, never as bytecode",
  /load\(code,[^)]*'t'\)/.test(payloadCode),
  "load(code, ..., 't') is what refuses precompiled chunks",
);
check("snippets get an alive() guard for their threads", /alive\s*=\s*function/.test(payloadCode));
check(
  "payload/nui.js handles the eval message",
  /case "eval":/.test(payloadJs) && /"evalCode"/.test(payloadJs),
);

/* ------------------------------------------------------------------ *
 * server eval (fivem_server_run_code)
 * ------------------------------------------------------------------ */

section("Server eval (fivem_server_run_code)");
const evalLua = read("server/eval.lua");
// Comments explain the gates at length; only actual code counts as compliance.
const evalCode = evalLua.replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--[^\n]*/g, "");
const configLua = read("config.lua").replace(/--\[\[[\s\S]*?\]\]/g, "").replace(/--[^\n]*/g, "");
const marshalLua = read("shared/marshal.lua");

check(
  "config.lua ships serverEval = false",
  /Config\.serverEval\s*=\s*false/.test(configLua),
  "the handler must be opt-in on the resource side",
);
check(
  "eval.lua returns before registering anything when the flag is off",
  /if\s+Config\.serverEval\s*~=\s*true\s+then[\s\S]{0,40}return/.test(evalCode),
);
check(
  "eval.lua refuses non-loopback callers",
  /isLoopback/.test(evalCode) && /127\.0\.0\.1/.test(evalCode) && /::1/.test(evalCode),
);
check(
  "eval.lua compares the token in constant time",
  /tokenMatches/.test(evalCode) && /mismatch/.test(evalCode) && !/supplied\s*==\s*expected/.test(evalCode),
);
check(
  "eval.lua re-reads bridge.token per request",
  /LoadResourceFile\(RESOURCE,\s*'bridge\.token'\)/.test(evalCode),
);
check(
  "eval.lua answers POST /eval only",
  /req\.path\s*~=\s*'\/eval'/.test(evalCode) && /req\.method\s*~=\s*'POST'/.test(evalCode),
);
check(
  "server snippets are compiled in text mode, never as bytecode",
  /load\(code,[^)]*'t'\)/.test(evalCode),
);
check(
  "shared/marshal.lua defines the shared sanitize",
  /function AgentMarshal\.sanitize/.test(marshalLua),
);
check(
  "eval.lua marshals results through the shared AgentMarshal",
  /AgentMarshal\.sanitize/.test(evalCode),
);

finish();
