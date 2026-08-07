import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import type { NativeCatalog } from "../natives/catalog.js";
import { checkCode } from "../security/codePolicy.js";
import { checkNatives, formatReport, type NativeMode } from "../security/nativeCheck.js";
import { text } from "./support.js";

/** The bridge resource's HTTP mount on the game endpoint. */
const RESOURCE_MOUNT = "fivem-mcp-bridge";

interface EvalAnswer {
  ok?: boolean;
  error?: string;
  data?: {
    durationMs?: number;
    returned?: unknown[];
    logs?: string[];
  };
  logs?: string[];
}

export function registerServerRunCode(
  server: McpServer,
  config: Config,
  catalog: NativeCatalog | null,
  token: string,
): void {
  server.registerTool(
    "fivem_server_run_code",
    {
      title: "Run a Lua snippet on the FiveM server",
      description:
        "Runs a Lua snippet inside the FiveM *server*, with the server-side native API " +
        "available, and returns whatever the snippet returns plus whatever it logged via " +
        "ctx.log. The counterpart to fivem_run_code, which reaches the game client. Use it " +
        "to assert server state directly -- GetResourceState, routing buckets, player lists, " +
        "another resource's exports -- instead of compiling throwaway debug commands into the " +
        "resource under test.\n\n" +
        "The snippet runs in the bridge resource's own server Lua state: other resources' " +
        "globals are NOT visible. Interact with another resource via exports" +
        "['name'], TriggerEvent, or a console command. The snippet may Wait(); the call " +
        "returns when it finishes or the timeout passes.\n\n" +
        "The snippet is compiled with load() and called with one argument, ctx:\n" +
        "  ctx.resource   name of the bridge resource\n" +
        "  ctx.log(fmt, ...) prints to the server console AND collects the line into this " +
        "tool's answer.\n\n" +
        "This tool only works when server eval is enabled on both sides: serverEval.enabled " +
        "in fivem-mcp.config.json (which registered this tool) and serverEval = true in the " +
        "bridge resource's config.lua (refresh + restart the resource after changing it).",
      inputSchema: {
        code: z
          .string()
          .min(1)
          .describe(
            "Lua source, server-side context. Receives ctx as its only argument (`local ctx " +
              "= ...`). Example: `return GetResourceState('ffa'), GetNumPlayerIndices()`.",
          ),
        timeoutMs: z
          .number()
          .int()
          .min(100)
          .max(30_000)
          .optional()
          .describe(
            `How long to wait for the result (default ${config.serverEval.defaultTimeoutMs} ` +
              "ms). The snippet keeps running on the server even if this expires.",
          ),
        nativeCheck: z
          .enum(["strict", "warn", "off"])
          .optional()
          .describe(
            'How to handle natives that do not resolve (default "warn"). Server natives ' +
              "cannot be probed live, so the reference alone decides -- which is why the " +
              'default is "warn" rather than "strict".',
          ),
      },
    },
    async ({ code, timeoutMs, nativeCheck }) => {
      const decision = checkCode(code, config.code);
      if (!decision.allowed) {
        return text(`Snippet rejected: ${decision.reason}`, true);
      }

      // No live probe exists server-side, so the reference alone decides;
      // that is why the default mode is warn, not strict.
      const mode: NativeMode = config.natives.enabled ? (nativeCheck ?? "warn") : "off";
      const report = await checkNatives(decision.code, catalog, mode, null, "server");
      const rendered = formatReport(report, mode);

      if (mode === "strict" && report.issues.some((issue) => issue.severity === "error")) {
        return text(rendered, true);
      }
      const preface = rendered.length > 0 ? `${rendered}\n\n` : "";

      const url = `http://${config.serverEval.gameEndpoint}/${RESOURCE_MOUNT}/eval`;
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fivem-Mcp-Token": token,
          },
          body: JSON.stringify({ code: decision.code }),
          signal: AbortSignal.timeout(timeoutMs ?? config.serverEval.defaultTimeoutMs),
        });
      } catch (err) {
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        return text(
          timedOut
            ? `The snippet was sent but no result arrived within ` +
                `${timeoutMs ?? config.serverEval.defaultTimeoutMs} ms. Either it is still ` +
                "running (a Wait() loop? check fivem_server_console for what it printed), or " +
                "serverEval was turned off in the resource's config.lua after having been on: " +
                "FXServer then leaves the resource's HTTP mount hanging instead of answering " +
                "404 until the whole server restarts."
            : `Could not reach the server eval endpoint at ${url}: ` +
                `${err instanceof Error ? err.message : String(err)}. Is the FXServer running ` +
                "and serverEval.gameEndpoint pointing at its game port?",
          true,
        );
      }

      if (response.status === 404) {
        return text(
          `The server answered 404 for ${url}: the eval handler is not registered. Set ` +
            `serverEval = true in ${RESOURCE_MOUNT}/config.lua, then run "refresh" and ` +
            `"restart ${RESOURCE_MOUNT}" on the server.`,
          true,
        );
      }
      if (response.status === 401 || response.status === 403) {
        return text(
          `The server refused the request (HTTP ${response.status}): ` +
            (response.status === 401
              ? "the bridge token did not match. The resource re-reads bridge.token per " +
                "request -- check that this MCP server and the resource share the same file."
              : "the request did not arrive from loopback."),
          true,
        );
      }

      let answer: EvalAnswer;
      try {
        answer = (await response.json()) as EvalAnswer;
      } catch {
        return text(
          `The server eval endpoint answered HTTP ${response.status} with a body that is ` +
            "not JSON. A proxy in front of the game port, or a txAdmin page, may be " +
            "answering instead of the resource.",
          true,
        );
      }

      const logs = answer.data?.logs ?? answer.logs ?? [];
      const logBlock =
        logs.length > 0 ? `\n\nctx.log output (${logs.length} line(s)):\n${logs.join("\n")}` : "";

      if (answer.ok !== true) {
        return text(
          `${preface}The snippet failed: ${answer.error ?? `HTTP ${response.status}`}${logBlock}`,
          true,
        );
      }

      const returned = answer.data?.returned;
      const body =
        Array.isArray(returned) && returned.length > 0
          ? returned.length === 1
            ? `\nReturned: ${JSON.stringify(returned[0], null, 2)}`
            : `\nReturned ${returned.length} values: ${JSON.stringify(returned, null, 2)}`
          : "\nThe snippet returned nothing.";
      const duration =
        typeof answer.data?.durationMs === "number"
          ? ` (${answer.data.durationMs} ms on the server)`
          : "";

      return text(
        `${preface}Server snippet ran (${decision.bytes} bytes)${duration}.${body}${logBlock}`,
      );
    },
  );
}
