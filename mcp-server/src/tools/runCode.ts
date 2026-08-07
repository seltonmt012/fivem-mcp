import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Bridge } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import type { ClientLogReader } from "../logs/clientLog.js";
import type { NativeCatalog } from "../natives/catalog.js";
import { checkCode } from "../security/codePolicy.js";
import {
  checkNatives,
  formatReport,
  type NativeMode,
  type NativeProbe,
} from "../security/nativeCheck.js";
import {
  beginLogCapture,
  captureOutput,
  probeNatives,
  renderFailure,
  text,
  type FailureContext,
} from "./support.js";

/**
 * Kept next to the tool description because it is the part an agent gets wrong:
 * the snippet runs inside the NUI callback, so anything that waits must be
 * handed to ctx.thread instead of blocking the reply.
 */
const CONTRACT = [
  "The snippet is compiled with load() and called with one argument, ctx:",
  "  ctx.resource   name of the bridge resource",
  "  ctx.alive()    false once the payload was reloaded or stopped",
  "  ctx.thread(fn) starts a background thread that reports its own errors",
  "  ctx.log(fmt, ...) prints to the client console with the resource prefix",
  "",
  "Everything the snippet returns comes back, serialised. Return values are",
  "flattened to plain data: tables are walked to a limited depth, cycles and",
  "non-serialisable values (functions, userdata, vectors) become descriptive",
  "strings.",
].join("\n");

export function registerRunCode(
  server: McpServer,
  bridge: Bridge,
  reader: ClientLogReader,
  config: Config,
  catalog: NativeCatalog | null,
): void {
  /**
   * Anything that goes wrong in the probe is reported as "could not probe"
   * rather than as a rejection: the reference still has an opinion, and a broken
   * probe must not block the snippet.
   */
  const probe: NativeProbe = async (names) =>
    config.natives.probeClient ? probeNatives(bridge, config, names) : null;

  server.registerTool(
    "fivem_run_code",
    {
      title: "Run a Lua snippet in the FiveM client",
      description:
        "Runs a Lua snippet inside the connected FiveM game client, with the full client-side " +
        "native API available, and returns whatever the snippet returns plus whatever it " +
        "logged. This is the general-purpose escape hatch: use it for anything the other " +
        "tools do not cover -- walking or teleporting the player, reading world and entity " +
        "state, spawning things, poking at another resource's exports.\n\n" +
        "The snippet runs in the bridge resource's own Lua state: another resource's globals " +
        "are NOT visible and read as nil. Interact with another resource via its exports, its " +
        "events, or its registered commands instead.\n\n" +
        "Prefer fivem_execute_command when a console command already does the job; use this " +
        "when there is no command for what you want.\n\n" +
        "The snippet runs synchronously and its return value is the answer, so keep it short. " +
        "Anything that has to wait (walking somewhere, polling for a condition) belongs in " +
        "ctx.thread(function() ... end): the tool then returns immediately, and you read the " +
        "outcome afterwards with fivem_read_log or a second snippet. A long loop must check " +
        "ctx.alive() so it stops when the payload is reloaded.\n\n" +
        "Every native the snippet calls is resolved against the FiveM native reference and " +
        "against the connected client before anything runs, so a misremembered name comes back " +
        "as a rejection with the correct spelling instead of a nil-value error mid-run. Use " +
        "fivem_native_info to look up a native's signature when you are unsure of it.\n\n" +
        CONTRACT,
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe(
            "Lua source, client-side context. Receives ctx as its only argument (`local ctx = " +
              "...`). Example: `local p = PlayerPedId() local c = GetEntityCoords(p) return " +
              "{ x = c.x, y = c.y, z = c.z }`.",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .optional()
          .describe(
            `How long to wait for the result (default ${config.code.defaultTimeoutMs} ms). ` +
              "The snippet keeps running in the game even if this expires.",
          ),
        captureLog: z
          .boolean()
          .optional()
          .describe(
            "Append what the client logged while the snippet ran, read from the client log " +
              `(default ${config.clientLog.captureOnExecute}).`,
          ),
        nativeCheck: z
          .enum(["strict", "warn", "off"])
          .optional()
          .describe(
            `How to handle natives that do not resolve (default ${config.natives.mode}). ` +
              '"strict" refuses to run the snippet, "warn" runs it and reports them, "off" ' +
              "skips the check. Lower it only for a native the reference does not know yet -- " +
              "if a name came back as a typo, fix the name instead.",
          ),
      },
    },
    async ({ code, timeoutMs, captureLog, nativeCheck }) => {
      const decision = checkCode(code, config.code);
      if (!decision.allowed) {
        return text(`Snippet rejected: ${decision.reason}`, true);
      }

      // Config sets the ceiling: a caller may relax the check per call, but a
      // request for a stricter mode than the operator configured is clamped
      // back down -- the documented "lower it only" contract, enforced.
      const mode: NativeMode = config.natives.enabled
        ? clampNativeMode(nativeCheck, config.natives.mode)
        : "off";
      const report = await checkNatives(decision.code, catalog, mode, probe);
      const rendered = formatReport(report, mode);

      if (mode === "strict" && report.issues.some((issue) => issue.severity === "error")) {
        return text(rendered, true);
      }

      // Anything the check still has to say rides along with the result.
      const notes = [
        rendered,
        report.skipped ? `Natives were not checked: ${report.skipped}` : "",
      ].filter(Boolean);
      const preface = notes.length > 0 ? `${notes.join("\n")}\n\n` : "";

      // Bracket the snippet: everything appended past this position is its output.
      const offsetBefore = beginLogCapture(reader, config, captureLog);

      const outcome = await bridge.runCode(
        decision.code,
        timeoutMs ?? config.code.defaultTimeoutMs,
      );

      const failureContext: FailureContext = {
        noun: "snippet",
        address: bridge.address,
        timeoutAdvice:
          "It is probably still running -- a snippet that waits should do so in ctx.thread() " +
          "instead of blocking the reply. Check fivem_read_log for what it printed.",
      };

      switch (outcome.kind) {
        case "ok": {
          const head = `Snippet ran (${decision.bytes} bytes, ${outcome.roundTripMs} ms round trip).`;
          return text(
            preface +
              head +
              describeResult(outcome.data) +
              (await captureOutput(reader, offsetBefore)),
          );
        }

        case "resource-error":
          // Compile and runtime errors both arrive here, already labelled by the payload.
          return text(
            `The snippet failed after ${outcome.roundTripMs} ms: ${outcome.error}` +
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

/** off < warn < strict; the per-call request may only move down from the config. */
const MODE_RANK: Record<NativeMode, number> = { off: 0, warn: 1, strict: 2 };

function clampNativeMode(requested: NativeMode | undefined, ceiling: NativeMode): NativeMode {
  if (requested === undefined) return ceiling;
  return MODE_RANK[requested] <= MODE_RANK[ceiling] ? requested : ceiling;
}

/** Renders the payload's answer: return values first, then the run's metadata. */
function describeResult(data: unknown): string {
  if (data === undefined || data === null || typeof data !== "object") {
    return " The client acknowledged it without returning data.";
  }

  const record = data as Record<string, unknown>;
  const returned = record["returned"];
  const parts: string[] = [];

  if (Array.isArray(returned) && returned.length > 0) {
    parts.push(
      returned.length === 1
        ? `\nReturned: ${JSON.stringify(returned[0], null, 2)}`
        : `\nReturned ${returned.length} values: ${JSON.stringify(returned, null, 2)}`,
    );
  } else {
    parts.push("\nThe snippet returned nothing.");
  }

  const meta: string[] = [];
  if (typeof record["durationMs"] === "number") meta.push(`took ${record["durationMs"]} ms in-game`);
  if (typeof record["payloadRevision"] === "number") {
    meta.push(`payload revision ${record["payloadRevision"]}`);
  }
  if (meta.length > 0) parts.push(`\n(${meta.join(", ")})`);

  return parts.join("");
}
