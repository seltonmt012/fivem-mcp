import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Bridge } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import {
  DEFAULT_SERVER_PORT,
  FiveMLaunchUnavailable,
  InvalidServerAddress,
  isAddressAllowed,
  parseServerAddress,
  type FiveMLauncher,
  type RunningProcess,
} from "../launch/fivem.js";
import { sleep, text } from "./support.js";

/** Upper bound for the optional wait, matching the schema. */
const MAX_WAIT_MS = 180_000;
const POLL_INTERVAL_MS = 1_000;

export function registerLaunchGame(
  server: McpServer,
  launcher: FiveMLauncher,
  bridge: Bridge,
  config: Config,
): void {
  const settings = config.launch;

  server.registerTool(
    "fivem_launch",
    {
      title: "Start FiveM and connect it to a server",
      description:
        "Starts the FiveM client and joins a server straight away, so a test cycle no longer " +
        "needs the user to launch the game and pick the server by hand. Use it when nothing is " +
        "connected and you need a running client to test against.\n\n" +
        (settings.defaultAddress
          ? `Without an "address" this connects to the configured development server ` +
            `(${settings.defaultAddress}). Pass "address" to go somewhere else.\n\n`
          : 'This needs the address of the server. **If you do not know it, ask the user for ' +
            'it** -- "which server should I connect to (host:port)?" -- and never guess or ' +
            "invent an IP: a wrong address wastes a full game start on a server nobody is " +
            "testing.\n\n") +
        "The game is launched detached and keeps running after this server stops. Reaching the " +
        "server takes a minute or two, so the answer comes back before the client is in: poll " +
        "fivem_bridge_status until it reports connected, or pass \"waitMs\" to have this tool " +
        "wait. fivem_screenshot shows what the client is doing while it loads.",
      inputSchema: {
        address: z
          .string()
          .optional()
          .describe(
            "Server to join, as host:port -- for example 127.0.0.1:30120 or dev.example.com:30120. " +
              `The port defaults to ${DEFAULT_SERVER_PORT}. A fivem://connect/... link and a ` +
              "cfx.re/join/<code> shortcut work too. " +
              (settings.defaultAddress
                ? `Defaults to ${settings.defaultAddress}.`
                : "Required: ask the user which server to use rather than guessing one."),
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Launch even though FiveM already seems to be running. Off by default, because a " +
              "second launcher usually does nothing while the first client is up.",
          ),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WAIT_MS)
          .optional()
          .describe(
            "Wait up to this long for the client to reach the bridge before answering (default " +
              `0, which returns as soon as the process is up; ${MAX_WAIT_MS} ms maximum). A cold ` +
              "start commonly takes 60-120 seconds.",
          ),
      },
    },
    async ({ address, force, waitMs }) => {
      const requested = address ?? settings.defaultAddress;
      if (!requested) {
        return text(
          "No server address was given and none is configured, so there is nothing to connect " +
            "to. Ask the user which server to join -- the host and port of their test or " +
            "development server, for example 127.0.0.1:30120 -- and call this tool again with " +
            '"address". Do not guess an address.\n\n' +
            'To stop being asked every time, set "launch.defaultAddress" in ' +
            "fivem-mcp.config.json.",
          true,
        );
      }

      let target;
      try {
        target = parseServerAddress(requested);
      } catch (err) {
        if (err instanceof InvalidServerAddress) {
          return text(
            `${err.message}\n\nAsk the user for the server address if you are unsure of it.`,
            true,
          );
        }
        throw err;
      }

      if (!isAddressAllowed(target, settings.allowedAddresses)) {
        return text(
          `Connecting to ${target.value} is not allowed. "launch.allowedAddresses" in ` +
            `fivem-mcp.config.json permits: ${settings.allowedAddresses.join(", ")}. Ask the user ` +
            "to add this server there if it really is the one to test against.",
          true,
        );
      }

      if (!launcher.available) {
        return text(
          `FiveM can only be launched on Windows, and this server is running on ${process.platform}. ` +
            'Set "launch.enabled" to false in fivem-mcp.config.json to stop offering the tool.',
          true,
        );
      }

      const running = await launcher.findRunning();
      if (running !== null && running.length > 0 && force !== true) {
        return text(describeRunning(running), true);
      }

      let result;
      try {
        const exe = await launcher.resolveExecutable();
        result = await launcher.launch(exe, ["+connect", target.value]);
      } catch (err) {
        if (err instanceof FiveMLaunchUnavailable) return text(err.message, true);
        return text(`The launch failed: ${(err as Error).message}`, true);
      }

      const lines = [
        `Started ${result.exe} ${result.argv.join(" ")} (pid ${result.pid}).`,
        `It should connect to ${target.value}${
          target.explicitPort || target.port === null
            ? ""
            : ` (port ${DEFAULT_SERVER_PORT} assumed, as none was given)`
        }.`,
      ];

      if (running === null) {
        lines.push(
          "Whether FiveM was already running could not be checked, so this may have started a " +
            "second launcher that does nothing.",
        );
      } else if (running.length > 0) {
        lines.push(
          `FiveM was already running (${running.map((p) => `${p.name} pid ${p.pid}`).join(", ")}) ` +
            "and this was launched anyway because force was set.",
        );
      }

      if (waitMs !== undefined && waitMs > 0) {
        const waited = await waitForBridge(bridge, waitMs);
        // Explicitly against null: 0 ms is a hit -- a client that was already
        // connected -- and must not read as a miss.
        lines.push(
          waited !== null
            ? `The client reached the bridge after about ${Math.round(waited / 1000)} s.`
            : `No client reached the bridge within ${Math.round(waitMs / 1000)} s. The process is ` +
              "up, so this is normal for a cold start -- keep polling fivem_bridge_status, and " +
              "use fivem_screenshot if it looks stuck.",
        );
      } else {
        lines.push(
          "Loading takes a minute or two. Poll fivem_bridge_status until it reports connected; " +
            "fivem_screenshot shows the launcher or the loading screen in the meantime.",
        );
      }

      return text(lines.join("\n"));
    },
  );
}

/** Why a second launcher is refused, and what to do about it. */
function describeRunning(running: RunningProcess[]): string {
  const list = running.map((p) => `${p.name} (pid ${p.pid})`).join(", ");
  return (
    `FiveM already appears to be running: ${list}. A second launcher normally does nothing ` +
    "while the first client is up, so nothing was started.\n\n" +
    "If that client is already on the right server, use it -- fivem_bridge_status says whether " +
    "the bridge resource has connected. Otherwise ask the user to close the game (the in-game " +
    '"connect" command is blocked by policy on purpose), or call this tool again with ' +
    '"force": true to launch regardless.'
  );
}

/**
 * Polls the bridge until a client completes the handshake.
 *
 * @returns Roughly how long it took, or null when the budget ran out. A miss is
 *   not a failure: the game may simply still be loading.
 */
async function waitForBridge(bridge: Bridge, budgetMs: number): Promise<number | null> {
  const started = Date.now();

  // The last sleep is trimmed to the budget, so the final status check lands
  // right at expiry instead of a full interval (plus one extra round trip,
  // which for a peer crosses the host) past it.
  for (;;) {
    if ((await bridge.getStatus()).connected) return Date.now() - started;
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) return null;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }
}
