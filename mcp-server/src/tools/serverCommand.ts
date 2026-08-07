import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { checkCommand } from "../security/commandPolicy.js";
import { TxAdminUnavailable, type TxAdminClient } from "../txadmin/client.js";
import { sleep, text } from "./support.js";

/** Verbs that take a resource name and can take a running resource down. */
const RESOURCE_VERBS = new Set(["stop", "restart", "ensure"]);

/** How often the capture re-reads the console ring buffer while waiting. */
const CAPTURE_POLL_MS = 100;
/** Ceiling for the whole capture, so a command that streams forever still answers. */
const CAPTURE_CAP_MS = 3_000;

/**
 * Waits for the command's console output the same way the client-log capture in
 * support.ts does: up to captureWaitMs for the first output, then until the
 * stream has been quiet for captureSettleMs. Faster than a fixed sleep for
 * chatty commands, and it still catches output that arrives late.
 */
async function captureConsoleOutput(
  txAdmin: TxAdminClient,
  cursorBefore: number,
  config: Config,
): Promise<ReturnType<TxAdminClient["read"]>> {
  const startedAt = Date.now();
  let seen = 0;
  let lastGrowthAt = startedAt;

  for (;;) {
    await sleep(CAPTURE_POLL_MS);
    // Reading from the fixed bracket cursor is idempotent, so each poll sees
    // the whole output so far and a changed length is growth.
    const length = txAdmin.read({ cursor: cursorBefore }).text.length;
    const now = Date.now();

    if (length !== seen) {
      seen = length;
      lastGrowthAt = now;
    }

    const settled = seen > 0 && now - lastGrowthAt >= config.txAdmin.captureSettleMs;
    const gaveUp = seen === 0 && now - startedAt >= config.txAdmin.captureWaitMs;
    if (settled || gaveUp || now - startedAt >= CAPTURE_CAP_MS) break;
  }

  return txAdmin.read({ cursor: cursorBefore });
}

/**
 * The protected resource this command targets, or null. Matched against every
 * argument rather than just the first: "stop a b c" stops all three.
 */
function protectedTarget(verb: string, command: string, protectedResources: string[]): string | null {
  if (!RESOURCE_VERBS.has(verb)) return null;
  const args = command.split(/\s+/).slice(1).map((arg) => arg.toLowerCase());
  return protectedResources.find((name) => args.includes(name.toLowerCase())) ?? null;
}

export function registerServerCommand(
  server: McpServer,
  txAdmin: TxAdminClient,
  config: Config,
): void {
  server.registerTool(
    "fivem_server_command",
    {
      title: "Run a FiveM server console command",
      description:
        "Runs a command in the FiveM *server* console through txAdmin, as if typed into the " +
        'Live Console -- e.g. "restart myresource", "ensure myresource" or "status". The ' +
        "counterpart to fivem_execute_command, which only reaches the game client. txAdmin " +
        "sends no acknowledgement, so the answer reports the console output that followed; " +
        "use fivem_server_console with the returned cursor to poll for late output. After " +
        'editing a resource\'s fxmanifest.lua, run "refresh" before "restart" -- restart ' +
        "alone reloads the scripts but serves the cached manifest metadata.",
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe('The server console command line, e.g. "restart myresource" or "status".'),
        captureOutput: z
          .boolean()
          .optional()
          .describe(
            "Append the console output that followed the command (default true; waits up to " +
              `${config.txAdmin.captureWaitMs} ms for the first output, then until it has ` +
              `been quiet for ${config.txAdmin.captureSettleMs} ms). Turn off for chatty commands.`,
          ),
      },
    },
    async ({ command, captureOutput }) => {
      const decision = checkCommand(command, config.txAdmin.commands, "txAdmin.commands");
      if (!decision.allowed) {
        return text(`Command blocked by the server command policy: ${decision.reason}`, true);
      }

      /*
        The one server command that can strand this very server: stopping the
        bridge resource kills the in-game side of the connection, and with the
        resource down nothing is left in the game to ask for it back.
      */
      const protectedHit = protectedTarget(
        decision.verb,
        decision.command,
        config.txAdmin.protectedResources,
      );
      if (protectedHit !== null && decision.verb === "stop") {
        return text(
          `"${decision.command}" is blocked: "${protectedHit}" is the bridge this server talks ` +
            "to the game through, and stopping it severs the connection with nothing left " +
            'in-game to bring it back. Use "restart" if a reload is the goal, or remove the ' +
            "resource from txAdmin.protectedResources in fivem-mcp.config.json to permit this.",
          true,
        );
      }
      const protectedNote =
        protectedHit !== null
          ? `\nNote: "${protectedHit}" carries the bridge -- expect fivem_bridge_status to show ` +
            "not connected until the loader has re-requested the payload (a few seconds)."
          : "";

      try {
        await txAdmin.ensureConnected();
      } catch (err) {
        if (err instanceof TxAdminUnavailable) return text(err.message, true);
        throw err;
      }

      // Bracket the command: everything appended past here is its output.
      const cursorBefore = txAdmin.cursor();
      try {
        txAdmin.sendCommand(decision.command);
      } catch (err) {
        if (err instanceof TxAdminUnavailable) return text(err.message, true);
        throw err;
      }

      const head = `Dispatched "${decision.command}" to the server console via txAdmin.${protectedNote}`;

      if (captureOutput === false) {
        return text(
          `${head} Output capture was turned off; read it with fivem_server_console, ` +
            `cursor ${cursorBefore}.`,
        );
      }

      const slice = await captureConsoleOutput(txAdmin, cursorBefore, config);

      if (slice.text.trim().length === 0) {
        return text(
          `${head} No console output followed within ${config.txAdmin.captureWaitMs} ms. ` +
            "The command may still have run silently, may not exist, or the txAdmin account " +
            'may lack the "Console: Write" permission -- txAdmin drops the command without an ' +
            `error in that case. Check later with fivem_server_console, cursor ${cursorBefore}.`,
        );
      }

      return text(
        `${head}\n\nConsole output that followed:\n${slice.text}\n\nNext cursor: ${slice.nextCursor}`,
      );
    },
  );
}
