import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { CONSOLE_BUFFER_KIB, TxAdminUnavailable, type TxAdminClient } from "../txadmin/client.js";
import { compilePatterns, WAIT_TIMEOUT_CAP_MS, WAIT_TIMEOUT_DEFAULT_MS } from "./readLog.js";
import { sleep, text } from "./support.js";

/** How often a waitFor poll re-reads the console buffer. */
const WAIT_POLL_MS = 250;

export function registerServerConsole(
  server: McpServer,
  txAdmin: TxAdminClient,
  config: Config,
): void {
  server.registerTool(
    "fivem_server_console",
    {
      title: "Read the FiveM server console",
      description:
        "Returns recent output of the FiveM *server* console, streamed live through txAdmin -- " +
        "resource prints, script errors, joins and leaves, exactly what the txAdmin Live " +
        "Console shows. The counterpart to fivem_read_log, which only sees the game client. " +
        "Each answer ends with a cursor; pass it back to read only what happened since. To " +
        "wait for something specific (a round ending, a player joining), pass waitFor: the " +
        "call then blocks until a matching line arrives or the timeout passes -- one call " +
        "instead of a sleep-and-poll loop.",
      inputSchema: {
        cursor: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Return only output that arrived after this position, taken from a previous ' +
              'answer\'s "Next cursor". Omit for the recent tail.',
          ),
        maxBytes: z
          .number()
          .int()
          .min(256)
          .max(65_536)
          .optional()
          .describe(`Cap on the returned text (default ${config.txAdmin.defaultReadBytes} bytes).`),
        filter: z
          .string()
          .optional()
          .describe(
            'Filter applied per line: a case-insensitive substring (e.g. a resource name), or ' +
              "a regular expression when filterRegex is true.",
          ),
        filterRegex: z
          .boolean()
          .optional()
          .describe("Treat filter as a case-insensitive regular expression instead of a substring."),
        waitFor: z
          .string()
          .optional()
          .describe(
            "Case-insensitive regular expression to wait for. The call polls the console " +
              "(from the cursor if given, otherwise from now) and returns as soon as a line " +
              "matches, or when waitTimeoutMs passes. The filter still applies to the " +
              "returned text.",
          ),
        waitTimeoutMs: z
          .number()
          .int()
          .min(100)
          .max(WAIT_TIMEOUT_CAP_MS)
          .optional()
          .describe(
            `How long waitFor may block (default ${WAIT_TIMEOUT_DEFAULT_MS} ms, ` +
              `cap ${WAIT_TIMEOUT_CAP_MS} ms).`,
          ),
      },
    },
    async ({ cursor, maxBytes, filter, filterRegex, waitFor, waitTimeoutMs }) => {
      const patterns = compilePatterns({ filter, filterRegex, waitFor });
      if ("error" in patterns) return text(patterns.error, true);

      try {
        await txAdmin.ensureConnected();
      } catch (err) {
        if (err instanceof TxAdminUnavailable) return text(err.message, true);
        throw err;
      }

      let matched: boolean | null = null;
      let startCursor = cursor;

      if (patterns.waitFor !== undefined) {
        // Waiting starts at the supplied cursor, or at "now" without one --
        // waitFor asks about what happens, not what already happened.
        startCursor = cursor ?? txAdmin.cursor();
        const deadline = Date.now() + (waitTimeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS);
        const wanted = patterns.waitFor;

        for (;;) {
          // Unfiltered by the display filter: waitFor must see every new line.
          const probe = txAdmin.read({ cursor: startCursor, maxBytes: 65_536, filter: wanted });
          matched = probe.text.trim().length > 0;
          if (matched || Date.now() >= deadline) break;
          await sleep(WAIT_POLL_MS);
        }
      }

      const slice = txAdmin.read({
        ...(startCursor !== undefined ? { cursor: startCursor } : {}),
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(patterns.filter !== undefined ? { filter: patterns.filter } : {}),
      });

      const notes: string[] = [txAdmin.describeState()];
      if (matched === true) notes.push(`waitFor /${waitFor}/ matched.`);
      if (matched === false) {
        notes.push(
          `waitFor /${waitFor}/ did not match within ${waitTimeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS} ms; ` +
            "showing what arrived instead.",
        );
      }
      if (slice.cursorInvalid) {
        notes.push(
          `Cursor ${startCursor} has aged out of the ${CONSOLE_BUFFER_KIB} KiB console ` +
            "buffer; showing the recent tail instead.",
        );
      }
      if (slice.truncated) {
        notes.push("Output was cut at the front to fit maxBytes; raise it or pass a filter.");
      }

      const body =
        slice.text.trim().length === 0
          ? filter !== undefined
            ? `No console lines match "${filter}".`
            : startCursor !== undefined && !slice.cursorInvalid
              ? "No new console output since that cursor."
              : "No console output buffered yet."
          : slice.text;

      return text(`${notes.join("\n")}\n\n${body}\n\nNext cursor: ${slice.nextCursor}`);
    },
  );
}
