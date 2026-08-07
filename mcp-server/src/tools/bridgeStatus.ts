import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Bridge } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import type { TxAdminClient } from "../txadmin/client.js";
import { text } from "./support.js";

export function registerBridgeStatus(
  server: McpServer,
  bridge: Bridge,
  config: Config,
  txAdmin: TxAdminClient | null,
): void {
  server.registerTool(
    "fivem_bridge_status",
    {
      title: "Inspect the FiveM bridge connection",
      description:
        "Reports whether a FiveM client is connected to the bridge, which resource it belongs " +
        "to, how long it has been connected and what it recently logged. Use this first when a " +
        "command fails or before assuming the game is reachable.",
      inputSchema: {},
    },
    async () => {
      const status = await bridge.getStatus();
      const lines: string[] = [
        `Listening on ${status.listening}`,
        status.role === "host"
          ? `Role: host${status.peers > 0 ? ` (${status.peers} peer fivem-mcp session(s) attached)` : ""}`
          : status.role === "peer"
            ? "Role: peer (requests are proxied through the fivem-mcp session that owns the port)"
            : "Role: none (this session neither owns the bridge port nor is attached to a host yet)",
      ];
      if (status.note) lines.push(`Note: ${status.note}`);

      if (!status.connected) {
        lines.push(
          "Status: not connected -- no FiveM client has completed the handshake.",
          "",
          "To connect: start the game, make sure the bridge resource is running and its NUI page " +
            "is loaded, and that the resource sends the same token the server printed at startup.",
        );

        /*
          The server side usually knows why: the loader resource logs every
          denial, grant and missing-token refusal to the server console. Relay
          the recent ones when the txAdmin stream is already attached -- but
          never dial txAdmin just for this; a status tool should not have a
          login as a side effect.
        */
        if (txAdmin !== null && txAdmin.state.kind === "connected") {
          const clue = /denied payload|granted payload|bridge\.token is missing|no authorized identifiers/i;
          const recent = txAdmin
            .read({ maxBytes: 32_768 })
            .text.split("\n")
            .filter((line) => clue.test(line))
            .slice(-3);
          if (recent.length > 0) {
            lines.push(
              "",
              "Server console clues (via txAdmin, newest last):",
              ...recent.map((line) => `  ${line}`),
              "A grant without a connection points at the token or the NUI bridge; a denial at " +
                "authorized.txt / the ACE.",
            );
          }
        }
      } else {
        lines.push(
          `Status: connected to resource "${status.resource}"`,
          `Session: ${status.sessionId}`,
          `Connected since: ${status.connectedSince}`,
          `Last heartbeat round trip: ${
            status.lastRoundTripMs === null ? "not measured yet" : `${status.lastRoundTripMs} ms`
          }`,
          `Commands sent this session: ${status.commandsSent}`,
          `Requests in flight: ${status.pendingRequests}`,
        );
      }

      lines.push(
        "",
        `Command policy: ${config.commands.mode} (` +
          (config.commands.mode === "denylist"
            ? `blocked: ${config.commands.denylist.join(", ") || "none"}`
            : `allowed: ${config.commands.allowlist.join(", ") || "none"}`) +
          ")",
        `Rate limit: ${status.rateLimitPerMinute} requests/minute`,
        `Run code: ${
          config.code.enabled
            ? `enabled (max ${config.code.maxBytes} bytes, default timeout ${config.code.defaultTimeoutMs} ms)`
            : "disabled (code.enabled = false)"
        }`,
        `Default timeout: ${config.requestTimeoutMs} ms`,
        `Allowed resources: ${
          config.allowedResources.length > 0 ? config.allowedResources.join(", ") : "any cfx-nui origin"
        }`,
      );

      if (txAdmin !== null) {
        lines.push("", txAdmin.describeState());
      }

      if (status.recentLogs.length > 0) {
        lines.push("", `Recent resource logs (${status.recentLogs.length}):`, ...status.recentLogs);
      }

      return text(lines.join("\n"));
    },
  );
}
