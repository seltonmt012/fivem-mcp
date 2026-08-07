#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ElectedBridge } from "./bridge/elected.js";
import { ScreenCapture } from "./capture/screen.js";
import { ConfigError, loadConfig } from "./config.js";
import { CrashDumpReader } from "./crashes/crashDumps.js";
import { guardStdout, log } from "./logger.js";
import { FiveMLauncher } from "./launch/fivem.js";
import { ClientLogReader } from "./logs/clientLog.js";
import { NativeCatalog } from "./natives/catalog.js";
import { resolveToken } from "./security/token.js";
import { registerBridgeStatus } from "./tools/bridgeStatus.js";
import { registerCheckResource } from "./tools/checkResource.js";
import { registerExecuteCommand } from "./tools/executeCommand.js";
import { registerLaunchGame } from "./tools/launchGame.js";
import { registerNativeInfo } from "./tools/nativeInfo.js";
import { registerNuiTools } from "./tools/nui.js";
import { registerReadCrash } from "./tools/readCrash.js";
import { registerReadLog } from "./tools/readLog.js";
import { registerRunCode } from "./tools/runCode.js";
import { registerScreenshot } from "./tools/screenshot.js";
import { registerServerCommand } from "./tools/serverCommand.js";
import { registerServerConsole } from "./tools/serverConsole.js";
import { registerServerRunCode } from "./tools/serverRunCode.js";
import { TxAdminClient } from "./txadmin/client.js";

const SERVER_NAME = "fivem-mcp";

/**
 * The mcp-server package directory -- dist/.. when built, src/.. under tsx.
 * Config and token paths resolve against this, never against process.cwd(),
 * because MCP clients spawn this process from wherever they happen to be.
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Index built by scripts/sync-natives.mjs, relative to the package root. */
const NATIVE_INDEX_PATH = "data/natives-index.json";

/** From package.json, so the version on the wire cannot drift from the release. */
const SERVER_VERSION: string = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
).version;

async function main(): Promise<void> {
  guardStdout();

  const { config, sourcePath, tokenFilePath, txAdminPasswordFilePath } = loadConfig(PACKAGE_ROOT);
  log.info(`Config: ${sourcePath ?? "built-in defaults"}`);

  const token = resolveToken(tokenFilePath);
  // Truncated on purpose: stderr ends up in MCP client logs and scrollback,
  // and the token is the only thing gating command execution in the client.
  log.info(`Bridge token (${token.source}): ${token.value.slice(0, 8)}…`);
  if (token.path) log.info(`Token file: ${token.path}`);

  // Host or peer, decided by who binds the port first; see bridge/elected.ts.
  const bridge = await ElectedBridge.open(config, token.value, SERVER_VERSION);

  const clientLog = new ClientLogReader(config);
  if (clientLog.enabled) {
    log.info(`Client log directory: ${clientLog.directoryPath}`);
  } else {
    log.warn("Client log reading is unavailable; command output will not be captured");
  }

  const catalog = config.natives.enabled
    ? NativeCatalog.load(PACKAGE_ROOT, NATIVE_INDEX_PATH)
    : null;
  if (!config.natives.enabled) log.info("Native checking is disabled (natives.enabled = false)");

  // Constructing does no I/O; the first server tool call dials txAdmin. The
  // tools are registered even when username/password are missing so they can
  // explain the setup instead of vanishing -- the screenshot/launch precedent.
  const txAdmin = config.txAdmin.enabled
    ? new TxAdminClient(config, txAdminPasswordFilePath)
    : null;
  if (txAdmin) {
    log.info(`txAdmin target: ${config.txAdmin.url} (connects on first use)`);
  } else {
    log.info(
      "fivem_server_console/fivem_server_command are disabled (txAdmin.enabled = false)",
    );
  }

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerExecuteCommand(server, bridge, clientLog, config);
  if (config.code.enabled) {
    registerRunCode(server, bridge, clientLog, config, catalog);
  } else {
    log.info("fivem_run_code is disabled (code.enabled = false)");
  }
  registerBridgeStatus(server, bridge, config, txAdmin);
  registerReadLog(server, clientLog, config);
  // Unconditional: syntax checking works even without a native index, and the
  // tool explains what is missing instead of vanishing.
  registerCheckResource(server, bridge, config, catalog);
  // frames/snapshot always; click/eval only when code.enabled -- they are code
  // execution with the reach of the NUI page itself.
  registerNuiTools(server, config);
  if (txAdmin) {
    registerServerConsole(server, txAdmin, config);
    registerServerCommand(server, txAdmin, config);
  }
  if (catalog) registerNativeInfo(server, bridge, config, catalog);

  // Off by default on both sides; see serverEval in config.ts. The in-game
  // handler additionally requires serverEval = true in the resource's config.lua.
  if (config.serverEval.enabled) {
    registerServerRunCode(server, config, catalog, token.value);
    log.info(`fivem_server_run_code targets http://${config.serverEval.gameEndpoint}`);
  } else {
    log.info("fivem_server_run_code is disabled (serverEval.enabled = false)");
  }

  // The crash reason lives in the CitizenFX logs, so the reader borrows the
  // log directory -- valid even when clientLog.enabled is false.
  if (config.crashes.enabled) {
    const crashes = new CrashDumpReader(config, clientLog.directoryPath);
    registerReadCrash(server, crashes);
    if (crashes.enabled) {
      log.info(`Crash dump directory: ${crashes.directoryPath}`);
    } else {
      log.warn("Crash dump reading is unavailable; fivem_read_crash will say so");
    }
  } else {
    log.info("fivem_read_crash is disabled (crashes.enabled = false)");
  }

  // Registered even where capture is impossible, so the tool can answer with a
  // reason instead of vanishing -- the same call the log reader makes.
  if (config.screenshot.enabled) {
    const screen = new ScreenCapture(config, PACKAGE_ROOT);
    registerScreenshot(server, screen, config);
    if (!screen.available) {
      log.warn(`Screen capture is unavailable on ${process.platform}; fivem_screenshot will say so`);
    }
  } else {
    log.info("fivem_screenshot is disabled (screenshot.enabled = false)");
  }

  // Same reasoning as the screenshot above: registered even where launching is
  // impossible, so the tool can name the reason instead of disappearing.
  if (config.launch.enabled) {
    const launcher = new FiveMLauncher(config, PACKAGE_ROOT);
    registerLaunchGame(server, launcher, bridge, config);
    if (!launcher.available) {
      log.warn(`Launching FiveM is unavailable on ${process.platform}; fivem_launch will say so`);
    } else if (!config.launch.defaultAddress) {
      log.info("fivem_launch has no default server address; callers must supply one");
    }
  } else {
    log.info("fivem_launch is disabled (launch.enabled = false)");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Shutting down (${signal})`);
    await txAdmin?.close().catch((err) => log.warn("Error while closing the txAdmin client", err));
    await bridge.close().catch((err) => log.warn("Error while closing the bridge", err));
    await server.close().catch((err) => log.warn("Error while closing the MCP server", err));
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await server.connect(new StdioServerTransport());
  log.info(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio`);
}

main().catch((err) => {
  if (err instanceof ConfigError) {
    log.error(err.message);
  } else {
    log.error("Startup failed", err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) log.debug(err.stack);
  }
  process.exit(1);
});
