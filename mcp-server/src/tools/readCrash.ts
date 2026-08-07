import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  CrashDumpsUnavailable,
  CrashQueryError,
  formatTimestamp,
  type CrashDumpReader,
  type CrashSummary,
} from "../crashes/crashDumps.js";
import { formatBytes, text } from "./support.js";

export function registerReadCrash(server: McpServer, reader: CrashDumpReader): void {
  server.registerTool(
    "fivem_read_crash",
    {
      title: "Read recent FiveM client crash dumps",
      description:
        "Returns the most recent FiveM client crash -- when it happened, the unhandled " +
        "exception and stack trace, which engine debug-dump sections are available, and a " +
        "list of older crashes. Reach for this when the game vanished mid-test or " +
        "fivem_bridge_status reports the client gone.\n\n" +
        "The crash reason is correlated from the CitizenFX session logs (the .dmp minidump " +
        "itself carries no readable reason and is not symbolicated -- stack frames are " +
        "module+offset only). Pass `section` to read one section of the crash's .gamelog " +
        "debug dump, e.g. pool or script-thread state at the moment of the crash.\n\n" +
        "Use fivem_read_log for the console output leading up to the crash, and " +
        "fivem_launch to start the game again.",
      inputSchema: {
        id: z
          .string()
          .optional()
          .describe(
            'Crash id (uuid) or unique prefix from the "other recent crashes" list. ' +
              "Default: the most recent crash.",
          ),
        section: z
          .string()
          .optional()
          .describe(
            'A .gamelog debug section to return instead of the overview, e.g. "POOL INFO" ' +
              'or "SCRIPT THREAD INFO". Case-insensitive; a unique prefix like "pool" ' +
              "works. The overview lists what is available.",
          ),
        filter: z
          .string()
          .optional()
          .describe(
            "Case-insensitive substring filter applied to section lines before the line " +
              "cap. Only meaningful together with section.",
          ),
      },
    },
    async ({ id, section, filter }) => {
      try {
        const crashes = reader.listCrashes();
        if (crashes.length === 0 && id === undefined) {
          return text(
            `No crash dumps found in ${reader.directoryPath}. ` +
              "The game has not crashed recently.",
          );
        }

        const crash = reader.resolveCrash(id, crashes);
        if (section !== undefined) {
          return text(renderSection(reader, crash, section, filter));
        }
        return text(renderOverview(reader, crash, crashes));
      } catch (err) {
        if (err instanceof CrashDumpsUnavailable || err instanceof CrashQueryError) {
          return text(err.message, true);
        }
        return text(`Could not read the crash dumps: ${(err as Error).message}`, true);
      }
    },
  );
}

function renderOverview(
  reader: CrashDumpReader,
  crash: CrashSummary,
  crashes: CrashSummary[],
): string {
  const header = [
    `Crash ${crash.id}`,
    `${formatTimestamp(crash.mtimeMs)} (${formatAge(crash.mtimeMs)} ago)`,
    `${formatBytes(crash.dumpBytes)} dump`,
  ].join(" -- ");

  const parts: string[] = [header];

  const block = reader.findCrashBlock(crash);
  if (block !== null && block.lines.length > 0) {
    parts.push(`Exception (from ${block.logFile}):\n${block.lines.join("\n")}`);
  } else {
    parts.push(
      "No matching crash block found in the CitizenFX logs (the capturing log may have " +
        "been rotated away). The crash reason lives only in those logs, not in the .dmp.",
    );
  }

  if (crash.gamelogPath === null) {
    parts.push(
      "This crash has no .dmp.gamelog; only the exception correlation and the binary " +
        "dump exist.",
    );
  } else {
    const sections = reader.listSections(crash);
    if (sections.length > 0) {
      parts.push(
        `Gamelog sections (pass section: "..."): ${sections.map((s) => s.name).join(", ")}`,
      );
    }
  }

  const others = crashes.filter((c) => c.id !== crash.id);
  if (others.length > 0) {
    parts.push(
      "Other recent crashes:\n" +
        others
          .map((c) => {
            const notes = [`${formatAge(c.mtimeMs)} ago`];
            if (c.gamelogPath === null) notes.push("no gamelog");
            return `  ${c.id} -- ${formatTimestamp(c.mtimeMs)} (${notes.join(", ")})`;
          })
          .join("\n"),
    );
  }

  return parts.join("\n\n");
}

function renderSection(
  reader: CrashDumpReader,
  crash: CrashSummary,
  section: string,
  filter: string | undefined,
): string {
  const slice = reader.readSection(crash, section, filter);
  const matching = filter ? ` matching "${filter}"` : "";

  if (slice.lines.length === 0) {
    return filter
      ? `No lines${matching} in section ${slice.name} of crash ${shortId(crash)}.`
      : `Section ${slice.name} of crash ${shortId(crash)} is empty.`;
  }

  const count = slice.truncated
    ? `first ${slice.lines.length} of ${slice.totalLines} line(s)${matching} ` +
      "(truncated; narrow with filter)"
    : `${slice.lines.length} of ${slice.totalLines} line(s)${matching}`;
  const header = [`Crash ${shortId(crash)}`, slice.name, count].join(" -- ");

  return `${header}\n\n${slice.lines.join("\n")}`;
}

function shortId(crash: CrashSummary): string {
  return crash.id.slice(0, 8);
}

function formatAge(mtimeMs: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - mtimeMs) / 60_000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
