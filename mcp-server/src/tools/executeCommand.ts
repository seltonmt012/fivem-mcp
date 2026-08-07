import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Bridge } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import type { ClientLogReader } from "../logs/clientLog.js";
import { checkCommand } from "../security/commandPolicy.js";
import {
  beginLogCapture,
  captureOutput,
  renderFailure,
  text,
  type FailureContext,
} from "./support.js";

export function registerExecuteCommand(
  server: McpServer,
  bridge: Bridge,
  reader: ClientLogReader,
  config: Config,
): void {
  server.registerTool(
    "fivem_execute_command",
    {
      title: "Run a FiveM client console command",
      description:
        "Runs a console command inside the connected FiveM game client, exactly as if it had " +
        "been typed into the F8 console, and returns whatever the client logged while it ran. " +
        "Requires the bridge resource to be running in-game -- check fivem_bridge_status first " +
        "if you are unsure. Client-side only: this does not reach the FiveM server console.",
      inputSchema: {
        command: z
          .string()
          .min(1)
          .describe('The full command line, e.g. "myresource:test" or "say hello".'),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .optional()
          .describe(
            `How long to wait for the resource to acknowledge (default ${config.requestTimeoutMs} ms).`,
          ),
        captureLog: z
          .boolean()
          .optional()
          .describe(
            "Append the console output the command produced, read from the client log " +
              `(default ${config.clientLog.captureOnExecute}). Turn off for chatty commands.`,
          ),
      },
    },
    async ({ command, timeoutMs, captureLog }) => {
      const decision = checkCommand(command, config.commands);
      if (!decision.allowed) {
        return text(`Command blocked by policy: ${decision.reason}`, true);
      }

      // Bracket the command: everything appended past this position is its output.
      const offsetBefore = beginLogCapture(reader, config, captureLog);

      const outcome = await bridge.send(decision.command, timeoutMs ?? config.requestTimeoutMs);

      const failureContext: FailureContext = {
        noun: "command",
        address: bridge.address,
        timeoutAdvice:
          "It may still have run -- check the game. If the resource does work that takes " +
          "longer, pass a larger timeoutMs.",
      };

      switch (outcome.kind) {
        case "ok": {
          const head = `Executed "${decision.command}" (${outcome.roundTripMs} ms).`;
          const body =
            outcome.data === undefined
              ? `${head} The resource acknowledged it without returning data.`
              : `${head} Resource returned:\n${JSON.stringify(outcome.data, null, 2)}`;
          return text(body + (await captureOutput(reader, offsetBefore)));
        }

        case "resource-error":
          return text(
            `The resource rejected "${decision.command}" after ${outcome.roundTripMs} ms: ` +
              outcome.error +
              (await captureOutput(reader, offsetBefore)),
            true,
          );

        case "timeout":
          return text(
            renderFailure(outcome, failureContext) + (await captureOutput(reader, offsetBefore)),
            true,
          );

        default:
          return text(renderFailure(outcome, failureContext), true);
      }
    },
  );
}
