import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import {
  ClientLogUnavailable,
  formatLogLine,
  lineMatches,
  type ClientLogReader,
  type CursorRead,
  type LineFilter,
} from "../logs/clientLog.js";
import { sleep, text } from "./support.js";

/** How often a waitFor poll re-reads the log. */
const WAIT_POLL_MS = 250;
export const WAIT_TIMEOUT_DEFAULT_MS = 30_000;
export const WAIT_TIMEOUT_CAP_MS = 120_000;

/**
 * Compiles the caller's filter/waitFor patterns, or explains which one is
 * broken. Shared with fivem_server_console, which takes the same inputs.
 */
export function compilePatterns(opts: {
  filter?: string | undefined;
  filterRegex?: boolean | undefined;
  waitFor?: string | undefined;
}): { filter?: LineFilter; waitFor?: RegExp } | { error: string } {
  const out: { filter?: LineFilter; waitFor?: RegExp } = {};
  if (opts.filter !== undefined) {
    if (opts.filterRegex) {
      try {
        out.filter = new RegExp(opts.filter, "i");
      } catch (err) {
        return { error: `filter is not a valid regular expression: ${(err as Error).message}` };
      }
    } else {
      out.filter = opts.filter;
    }
  }
  if (opts.waitFor !== undefined) {
    try {
      out.waitFor = new RegExp(opts.waitFor, "i");
    } catch (err) {
      return { error: `waitFor is not a valid regular expression: ${(err as Error).message}` };
    }
  }
  return out;
}

export function registerReadLog(
  server: McpServer,
  reader: ClientLogReader,
  config: Config,
): void {
  server.registerTool(
    "fivem_read_log",
    {
      title: "Read the FiveM client console log",
      description:
        "Returns the tail of the running FiveM client's log file -- the same output the F8 " +
        "console shows, including print() from resources and engine errors. Use this to find " +
        "out what a command actually did, since fivem_execute_command can only confirm that a " +
        "command was dispatched, not that it existed or succeeded.\n\n" +
        "Each answer ends with a cursor; pass it back to read only what the client logged " +
        "since, instead of re-reading overlapping tails. To wait for something specific " +
        '(a round ending, a resource starting), pass waitFor: the call then blocks until a ' +
        "matching line arrives or the timeout passes -- one call instead of a sleep-and-poll " +
        "loop.",
      inputSchema: {
        lines: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(`How many trailing lines to return (default ${config.clientLog.defaultLines}).`),
        cursor: z
          .string()
          .optional()
          .describe(
            'Return only lines the client logged after this position, taken from a previous ' +
              'answer\'s "Next cursor". Omit for the recent tail. A cursor from before a log ' +
              "rotation falls back to the tail and says so.",
          ),
        filter: z
          .string()
          .optional()
          .describe(
            'Filter applied per line before taking the last lines: a case-insensitive ' +
              'substring, or a regular expression when filterRegex is true -- e.g. ' +
              '"^\\\\[ffa\\\\]" with filterRegex to match only lines a resource prefixed itself.',
          ),
        filterRegex: z
          .boolean()
          .optional()
          .describe("Treat filter as a case-insensitive regular expression instead of a substring."),
        waitFor: z
          .string()
          .optional()
          .describe(
            "Case-insensitive regular expression to wait for. The call polls the log (from " +
              "the cursor if given, otherwise from now) and returns as soon as a line matches, " +
              "or when waitTimeoutMs passes. The filter still applies to the returned lines.",
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
        raw: z
          .boolean()
          .optional()
          .describe(
            "Keep the engine's [timestamp] [process] thread/ prefix. Off by default, which " +
              "makes lines read like the F8 console.",
          ),
      },
    },
    async ({ lines, cursor, filter, filterRegex, waitFor, waitTimeoutMs, raw }) => {
      const patterns = compilePatterns({ filter, filterRegex, waitFor });
      if ("error" in patterns) return text(patterns.error, true);
      const lineCap = lines ?? config.clientLog.defaultLines;

      try {
        let slice: CursorRead;
        let matched: boolean | null = null;

        // Filters and waitFor run against the *formatted* lines -- what the
        // caller sees -- so a pattern like ^\[ffa\] works without knowing the
        // engine's raw prefix.
        const render = (line: string) => formatLogLine(line, raw ?? false);

        if (patterns.waitFor === undefined) {
          slice = reader.readFromCursor(cursor);
        } else {
          // Waiting starts at the supplied cursor, or at "now" without one --
          // waitFor asks about what happens, not what already happened.
          const startCursor = cursor ?? reader.readFromCursor(undefined).nextCursor;
          const deadline = Date.now() + (waitTimeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS);
          const wanted = patterns.waitFor;

          for (;;) {
            slice = reader.readFromCursor(startCursor);
            matched = slice.lines.some((line) => wanted.test(render(line)));
            if (matched || Date.now() >= deadline) break;
            await sleep(WAIT_POLL_MS);
          }
        }

        const rendered = slice.lines
          .map(render)
          .filter((line) => lineMatches(line, patterns.filter));
        const shown = rendered.slice(-lineCap);
        const overCap = rendered.length > lineCap;

        const header = [
          `${slice.file}`,
          `${shown.length} line(s)${filter ? ` matching "${filter}"` : ""}`,
        ].join(" -- ");

        const notes: string[] = [];
        if (matched === true) notes.push(`waitFor /${waitFor}/ matched.`);
        if (matched === false) {
          notes.push(
            `waitFor /${waitFor}/ did not match within ${waitTimeoutMs ?? WAIT_TIMEOUT_DEFAULT_MS} ms; ` +
              "showing what arrived instead.",
          );
        }
        if (slice.cursorNote) notes.push(slice.cursorNote);
        if (overCap) {
          notes.push(`More lines matched than the ${lineCap}-line cap; raise "lines" or narrow the filter.`);
        }

        const body =
          shown.length === 0
            ? filter
              ? `No lines matching "${filter}".`
              : cursor !== undefined && !slice.cursorNote
                ? "No new lines since that cursor."
                : `${slice.file} is empty.`
            : shown.join("\n");

        return text(
          [header, notes.join("\n"), body, `Next cursor: ${slice.nextCursor}`]
            .filter((part) => part.length > 0)
            .join("\n\n"),
        );
      } catch (err) {
        if (err instanceof ClientLogUnavailable) return text(err.message, true);
        return text(`Could not read the client log: ${(err as Error).message}`, true);
      }
    },
  );
}
