import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Config } from "../config.js";
import { formatLogLine, readRange } from "../logs/clientLog.js";

/**
 * Reader for FiveM client crash dumps.
 *
 * A crash leaves a `<uuid>.dmp` minidump and usually a `<uuid>.dmp.gamelog`
 * text dump in the crashes directory -- but neither holds the crash *reason*.
 * That is written by the DumpServer (running in another FiveM process) into a
 * CitizenFX_log_*.log as a "Process crash captured" block. The dump's uuid
 * never appears in the log, so the block is matched by wall-clock time: the
 * log's filename timestamp plus the line's bracketed ms offset, compared to
 * the dump file's mtime.
 */

const DUMP_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.dmp$/i;
const SECTION_HEADER = /^=+ (.+?) =+$/;
const DUMP_SERVER_LINE = /^\[\s*\d+\]\s+\[\s*DumpServer\]/;
const CRASH_BLOCK_START =
  /^\[\s*(\d+)\]\s+\[\s*DumpServer\]\s+[^/\n]{0,32}\/\s*Process crash captured/;
const LOG_FILE_PATTERN = /^CitizenFX_log_.*\.log$/i;
const LOG_NAME_TIME = /^CitizenFX_log_(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})\.log$/i;

/** How far a block's wall-clock time may sit from the dump's mtime. */
const MATCH_TOLERANCE_MS = 180_000;
/** The capturing log is written at/after crash time; allow a little clock slack. */
const CANDIDATE_LOG_SLACK_MS = 60_000;
const MAX_CANDIDATE_LOGS = 5;
const MAX_LOG_SCAN_BYTES = 16 * 1024 * 1024;
/** Real gamelogs are ~120 KB; anything past this is not worth parsing. */
const MAX_GAMELOG_BYTES = 2 * 1024 * 1024;
/** Real crash blocks are ~12 lines; hard stop against a runaway match. */
const MAX_BLOCK_LINES = 80;
/** Lines returned for one .gamelog section (PACK INFO alone is ~3900). */
const MAX_SECTION_LINES = 400;
/** Byte backstop under the line cap for one gamelog section. */
const MAX_SECTION_BYTES = 64 * 1024;

export interface CrashSummary {
  /** Full uuid, lowercase. */
  id: string;
  /** null when only the .dmp exists. */
  gamelogPath: string | null;
  mtimeMs: number;
  dumpBytes: number;
}

export interface CrashBlock {
  /** Basename of the CitizenFX log the block was found in. */
  logFile: string;
  /** Prefix-stripped: "Exception, unhandled!", the reason, "Stack trace:", frames. */
  lines: string[];
}

export interface SectionSlice {
  name: string;
  lines: string[];
  totalLines: number;
  truncated: boolean;
}

/** The crashes directory cannot be read at all. */
export class CrashDumpsUnavailable extends Error {}

/** The caller named a crash or section that does not exist. */
export class CrashQueryError extends Error {}

export class CrashDumpReader {
  private readonly directory: string | null;

  constructor(
    private readonly config: Config,
    /** The CitizenFX log directory, borrowed from ClientLogReader for correlation. */
    private readonly logDirectory: string | null,
  ) {
    this.directory = config.crashes.directory ?? defaultCrashDirectory();
  }

  get enabled(): boolean {
    return this.config.crashes.enabled && this.directory !== null;
  }

  get directoryPath(): string | null {
    return this.directory;
  }

  /** All known crashes, newest first, capped to crashes.maxCrashes. */
  listCrashes(): CrashSummary[] {
    if (!this.config.crashes.enabled) {
      throw new CrashDumpsUnavailable(
        "Crash dump reading is disabled (crashes.enabled = false in fivem-mcp.config.json).",
      );
    }
    if (this.directory === null) {
      throw new CrashDumpsUnavailable(
        "No FiveM crash directory is configured and none could be detected. Set " +
          '"crashes.directory" in fivem-mcp.config.json.',
      );
    }

    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch (err) {
      throw new CrashDumpsUnavailable(
        `Cannot read the crash directory ${this.directory}: ${(err as Error).message}`,
      );
    }

    const names = new Set(entries);
    const crashes: CrashSummary[] = [];
    for (const entry of entries) {
      const match = DUMP_FILE_PATTERN.exec(entry);
      if (!match || match[1] === undefined) continue;
      const dumpPath = join(this.directory, entry);
      try {
        const stat = statSync(dumpPath);
        const gamelogName = `${entry}.gamelog`;
        crashes.push({
          id: match[1].toLowerCase(),
          gamelogPath: names.has(gamelogName) ? join(this.directory, gamelogName) : null,
          mtimeMs: stat.mtimeMs,
          dumpBytes: stat.size,
        });
      } catch {
        // Deleted between readdir and stat; ignore.
      }
    }

    crashes.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return crashes.slice(0, this.config.crashes.maxCrashes);
  }

  /** Newest crash, or the one whose uuid starts with `idPrefix`. */
  resolveCrash(idPrefix?: string, crashes: CrashSummary[] = this.listCrashes()): CrashSummary {
    const newest = crashes[0];
    if (newest === undefined) {
      throw new CrashQueryError(
        `No crash dumps found in ${this.directory}. The game has not crashed recently.`,
      );
    }
    if (idPrefix === undefined) return newest;

    const prefix = idPrefix.toLowerCase();
    const matches = crashes.filter((c) => c.id.startsWith(prefix));
    const first = matches[0];
    if (first === undefined) {
      throw new CrashQueryError(
        `No crash dump matches "${idPrefix}". Known crashes:\n` +
          crashes.map((c) => `  ${c.id} -- ${formatTimestamp(c.mtimeMs)}`).join("\n"),
      );
    }
    if (matches.length > 1) {
      throw new CrashQueryError(
        `"${idPrefix}" is ambiguous, it matches:\n` +
          matches.map((c) => `  ${c.id} -- ${formatTimestamp(c.mtimeMs)}`).join("\n"),
      );
    }
    return first;
  }

  /**
   * The DumpServer's "Process crash captured" block for this crash, matched by
   * time across the most plausible CitizenFX logs. null when correlation is
   * impossible or nothing lands within tolerance.
   */
  findCrashBlock(crash: CrashSummary): CrashBlock | null {
    if (this.logDirectory === null) return null;

    let entries: string[];
    try {
      entries = readdirSync(this.logDirectory);
    } catch {
      return null;
    }

    const candidates: { path: string; mtimeMs: number; sizeBytes: number }[] = [];
    for (const entry of entries) {
      if (!LOG_FILE_PATTERN.test(entry)) continue;
      const path = join(this.logDirectory, entry);
      try {
        const stat = statSync(path);
        // The capturing session starts before the crash but writes the block
        // at crash time, so its mtime is at/after the dump's -- give or take
        // clock slack.
        if (stat.mtimeMs < crash.mtimeMs - CANDIDATE_LOG_SLACK_MS) continue;
        if (stat.size > MAX_LOG_SCAN_BYTES) continue;
        candidates.push({ path, mtimeMs: stat.mtimeMs, sizeBytes: stat.size });
      } catch {
        // Rotated away between readdir and stat; ignore.
      }
    }
    candidates.sort(
      (a, b) => Math.abs(a.mtimeMs - crash.mtimeMs) - Math.abs(b.mtimeMs - crash.mtimeMs),
    );

    let best: { distanceMs: number; logFile: string; lines: string[] } | null = null;
    for (const candidate of candidates.slice(0, MAX_CANDIDATE_LOGS)) {
      let content: string;
      try {
        content = readRange(candidate.path, 0, candidate.sizeBytes);
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const start = CRASH_BLOCK_START.exec(line);
        if (!start || start[1] === undefined) continue;

        const blockTime = blockWallClock(
          basename(candidate.path),
          Number.parseInt(start[1], 10),
          candidate.mtimeMs,
          crash.mtimeMs,
        );
        const distanceMs = Math.abs(blockTime - crash.mtimeMs);
        if (distanceMs > MATCH_TOLERANCE_MS) continue;
        if (best !== null && distanceMs >= best.distanceMs) continue;

        best = {
          distanceMs,
          logFile: basename(candidate.path),
          lines: extractBlockBody(lines, i + 1),
        };
      }
    }

    return best === null ? null : { logFile: best.logFile, lines: best.lines };
  }

  /** Names and sizes of the .gamelog's debug sections. Empty when there is no gamelog. */
  listSections(crash: CrashSummary): { name: string; lines: number }[] {
    return this.parseGamelog(crash).map((s) => ({ name: s.name, lines: s.lines.length }));
  }

  /** One .gamelog section, optionally filtered, capped by lines and bytes. */
  readSection(crash: CrashSummary, section: string, filter?: string): SectionSlice {
    if (crash.gamelogPath === null) {
      throw new CrashQueryError(
        `Crash ${crash.id} has no .dmp.gamelog, so there are no sections to read.`,
      );
    }
    const sections = this.parseGamelog(crash);
    const found = matchSection(sections, section);

    const matched = filter
      ? found.lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
      : found.lines;

    const capped: string[] = [];
    let bytes = 0;
    for (const line of matched) {
      if (capped.length >= MAX_SECTION_LINES) break;
      bytes += line.length + 1;
      if (bytes > MAX_SECTION_BYTES && capped.length > 0) break;
      capped.push(line);
    }

    return {
      name: found.name,
      lines: capped,
      totalLines: matched.length,
      truncated: capped.length < matched.length,
    };
  }

  private parseGamelog(crash: CrashSummary): { name: string; lines: string[] }[] {
    if (crash.gamelogPath === null) return [];

    let content: string;
    try {
      const size = statSync(crash.gamelogPath).size;
      content = readRange(crash.gamelogPath, 0, Math.min(size, MAX_GAMELOG_BYTES));
    } catch (err) {
      throw new CrashDumpsUnavailable(
        `Cannot read ${crash.gamelogPath}: ${(err as Error).message}`,
      );
    }

    const sections: { name: string; lines: string[] }[] = [];
    let current: { name: string; lines: string[] } | null = null;
    for (const line of content.split(/\r?\n/)) {
      const header = SECTION_HEADER.exec(line);
      if (header && header[1] !== undefined) {
        current = { name: header[1].trim(), lines: [] };
        sections.push(current);
        continue;
      }
      // "###### END OF DEBUG INFO ######" closes the last section.
      if (/^#+ END OF DEBUG INFO #+$/.test(line.trim())) break;
      if (current !== null && line.trim() !== "") current.lines.push(line);
    }
    return sections;
  }
}

/** Case-insensitive exact match, then unique prefix, then unique substring. */
function matchSection(
  sections: { name: string; lines: string[] }[],
  query: string,
): { name: string; lines: string[] } {
  const q = query.trim().toLowerCase();
  const exact = sections.filter((s) => s.name.toLowerCase() === q);
  const byPrefix = sections.filter((s) => s.name.toLowerCase().startsWith(q));
  const bySubstring = sections.filter((s) => s.name.toLowerCase().includes(q));

  const winner =
    exact.length === 1
      ? exact[0]
      : byPrefix.length === 1
        ? byPrefix[0]
        : bySubstring.length === 1
          ? bySubstring[0]
          : undefined;
  if (winner !== undefined) return winner;

  const available = sections.map((s) => s.name).join(", ");
  throw new CrashQueryError(
    (bySubstring.length > 1
      ? `Section "${query}" is ambiguous.`
      : `No gamelog section matches "${query}".`) + ` Available sections: ${available}.`,
  );
}

/**
 * Wall-clock time of a log line: the filename's timestamp plus the bracketed
 * ms offset. Filenames are UTC on the builds seen so far, but that is not
 * documented -- so both interpretations are computed and the one nearer the
 * dump's mtime wins. An unparseable filename falls back to the log's mtime.
 */
function blockWallClock(
  logName: string,
  offsetMs: number,
  logMtimeMs: number,
  dumpMtimeMs: number,
): number {
  const match = LOG_NAME_TIME.exec(logName);
  if (!match) return logMtimeMs;

  const num = (v: string | undefined) => Number.parseInt(v ?? "", 10);
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => num(match[i]));
  if (y === undefined || mo === undefined || d === undefined) return logMtimeMs;
  if (h === undefined || mi === undefined || s === undefined) return logMtimeMs;
  if ([y, mo, d, h, mi, s].some(Number.isNaN)) return logMtimeMs;

  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s) + offsetMs;
  const asLocal = new Date(y, mo - 1, d, h, mi, s).getTime() + offsetMs;
  return Math.abs(asUtc - dumpMtimeMs) <= Math.abs(asLocal - dumpMtimeMs) ? asUtc : asLocal;
}

/**
 * The DumpServer lines following "Process crash captured", prefix-stripped.
 * The block ends at the first empty DumpServer message, the first line from
 * another writer, or the hard line cap.
 */
function extractBlockBody(lines: string[], from: number): string[] {
  const body: string[] = [];
  for (let i = from; i < lines.length && body.length < MAX_BLOCK_LINES; i++) {
    const line = lines[i];
    if (line === undefined || !DUMP_SERVER_LINE.test(line)) break;
    const message = formatLogLine(line, false);
    if (message.trim() === "") break;
    body.push(message);
  }
  return body;
}

export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function defaultCrashDirectory(): string | null {
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) return null;
  return join(localAppData, "FiveM", "FiveM.app", "crashes");
}
