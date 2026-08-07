import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import type { Config } from "../config.js";
import { log } from "../logger.js";

/**
 * Reader for the FiveM client log -- the file behind the F8 console.
 *
 * The game appends to this file while we read it, so every call re-resolves the
 * newest file and re-stats it. Reads are tail-only: these files reach megabytes
 * and only the end is ever interesting.
 */

const LOG_FILE_PATTERN = /^CitizenFX_log_.*\.log$/i;
const MAX_TAIL_BYTES = 512 * 1024;

/** Strips "[  12345] [b3751_GTAProce]     MainThrd/ " down to the message. */
const LINE_PREFIX = /^\[\s*\d+\]\s+\[[^\]]*\]\s+(?:[^/\n]{0,32}\/\s?)?/;

export interface LogSlice {
  file: string;
  lines: string[];
}

/**
 * A bracketing position: the file it was taken in *and* the offset. Carrying
 * the file through readSince() means a rotation between the two calls returns
 * an honest empty slice instead of an arbitrary window of the new file.
 */
export interface LogOffset {
  file: string;
  offset: number;
}

/**
 * Drops the partial first line of a window that starts mid-file. No newline at
 * all means the window is one long fragment and holds no complete line.
 */
function dropLeadingFragment(text: string): string {
  const firstBreak = text.indexOf("\n");
  return firstBreak === -1 ? "" : text.slice(firstBreak + 1);
}

export class ClientLogUnavailable extends Error {}

/**
 * The tool-facing cursor: "<logfileBasename>:<byteOffset>". Opaque to callers,
 * carried between fivem_read_log calls so a session reads each line once.
 *
 * Lines come back unfiltered and raw: the tool formats them first and filters
 * afterwards, so a filter or waitFor pattern matches what the caller actually
 * sees, not the engine's [timestamp] [process] prefix.
 */
export interface CursorRead {
  file: string;
  lines: string[];
  nextCursor: string;
  /** Set when a supplied cursor could not be used and the tail was read instead. */
  cursorNote: string | null;
}

/** A filter for log lines: case-insensitive substring, or a regex. */
export type LineFilter = string | RegExp;

export function lineMatches(line: string, filter: LineFilter | undefined): boolean {
  if (filter === undefined) return true;
  if (typeof filter === "string") return line.toLowerCase().includes(filter.toLowerCase());
  return filter.test(line);
}

export class ClientLogReader {
  private readonly directory: string | null;

  constructor(private readonly config: Config) {
    this.directory = config.clientLog.directory ?? defaultLogDirectory();
  }

  get enabled(): boolean {
    return this.config.clientLog.enabled && this.directory !== null;
  }

  get directoryPath(): string | null {
    return this.directory;
  }

  /** Newest CitizenFX_log_*.log, i.e. the session currently running. */
  private resolveFile(): string {
    if (!this.config.clientLog.enabled) {
      throw new ClientLogUnavailable(
        "Client log reading is disabled (clientLog.enabled = false in fivem-mcp.config.json).",
      );
    }
    if (this.directory === null) {
      throw new ClientLogUnavailable(
        "No FiveM log directory is configured and none could be detected. Set " +
          '"clientLog.directory" in fivem-mcp.config.json.',
      );
    }

    let entries: string[];
    try {
      entries = readdirSync(this.directory);
    } catch (err) {
      throw new ClientLogUnavailable(
        `Cannot read the log directory ${this.directory}: ${(err as Error).message}`,
      );
    }

    let newest: { path: string; mtime: number } | null = null;
    for (const entry of entries) {
      if (!LOG_FILE_PATTERN.test(entry)) continue;
      const path = join(this.directory, entry);
      try {
        const mtime = statSync(path).mtimeMs;
        if (newest === null || mtime > newest.mtime) newest = { path, mtime };
      } catch {
        // Rotated away between readdir and stat; ignore.
      }
    }

    if (newest === null) {
      throw new ClientLogUnavailable(
        `No CitizenFX_log_*.log found in ${this.directory}. Has the game been started?`,
      );
    }
    return newest.path;
  }

  /** Current end of the active log, for bracketing a command's output. */
  currentOffset(): LogOffset | null {
    try {
      const file = this.resolveFile();
      return { file, offset: statSync(file).size };
    } catch (err) {
      if (err instanceof ClientLogUnavailable) return null;
      log.debug("Could not stat the client log", err);
      return null;
    }
  }

  /**
   * The read behind fivem_read_log: without a cursor, the tail of the active
   * log; with one, everything appended to that file since -- unless the log
   * rotated or shrank in between, where the cursor is honestly discarded and
   * the tail returned instead (the txAdmin cursorInvalid semantics).
   */
  readFromCursor(cursor: string | undefined): CursorRead {
    const file = this.resolveFile();
    const size = statSync(file).size;
    const nextCursor = `${basename(file)}:${size}`;

    let start = Math.max(0, size - MAX_TAIL_BYTES);
    let cursorNote: string | null = null;
    let tailMode = true;

    if (cursor !== undefined) {
      const parsed = parseCursor(cursor);
      if (parsed === null) {
        cursorNote = `Cursor "${cursor}" is not one this tool handed out; showing the recent tail instead.`;
      } else if (parsed.file !== basename(file)) {
        cursorNote =
          `Cursor points into ${parsed.file}, but the active log is now ${basename(file)} ` +
          "(the game restarted and rotated its log); showing the recent tail of the new file.";
      } else if (parsed.offset > size) {
        cursorNote =
          `Cursor offset ${parsed.offset} is past the end of ${basename(file)} (${size} bytes); ` +
          "showing the recent tail instead.";
      } else {
        start = Math.max(parsed.offset, size - MAX_TAIL_BYTES);
        tailMode = false;
        if (start > parsed.offset) {
          cursorNote = `More than ${MAX_TAIL_BYTES} bytes arrived since that cursor; the front was skipped.`;
        }
      }
    }

    const text = readRange(file, start, size);
    // A window that starts mid-file almost certainly lands mid-line: drop the
    // fragment -- except when it starts exactly at a valid cursor, which by
    // construction sits at the previous read's end.
    const dropFragment = tailMode ? start > 0 : cursorNote !== null && start > 0;

    return {
      file,
      lines: splitLines(dropFragment ? dropLeadingFragment(text) : text),
      nextCursor,
      cursorNote,
    };
  }

  /** The last `lines` lines of the active log. */
  readTail(lines: number, filter?: string): LogSlice {
    const file = this.resolveFile();
    const size = statSync(file).size;
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const text = readRange(file, start, size);

    // A non-zero start almost certainly lands mid-line; drop that fragment.
    const all = splitLines(start > 0 ? dropLeadingFragment(text) : text);
    const matched = filter ? all.filter((l) => l.toLowerCase().includes(filter.toLowerCase())) : all;

    return { file, lines: matched.slice(-lines) };
  }

  /** Everything appended to the bracketed file since `position`, capped to the tail window. */
  readSince(position: LogOffset): LogSlice {
    // The file the offset was taken in, NOT the newest one: if the game rotated
    // logs in between, the newest file's size says nothing about the offset and
    // the window would be an arbitrary slice of an unrelated file.
    const { file, offset } = position;
    const size = statSync(file).size;

    if (size <= offset) {
      return { file, lines: [] };
    }

    const start = Math.max(offset, size - MAX_TAIL_BYTES);
    const text = readRange(file, start, size);
    return {
      file,
      lines: splitLines(start > offset ? dropLeadingFragment(text) : text),
    };
  }
}

/** Splits "<basename>:<offset>" at the last colon; null when it is not that shape. */
function parseCursor(cursor: string): { file: string; offset: number } | null {
  const split = cursor.lastIndexOf(":");
  if (split <= 0) return null;
  const file = cursor.slice(0, split);
  const offset = Number.parseInt(cursor.slice(split + 1), 10);
  if (!Number.isInteger(offset) || offset < 0 || !LOG_FILE_PATTERN.test(file)) return null;
  return { file, offset };
}

/** Drops the engine's timestamp/thread prefix so lines read like the F8 console. */
export function formatLogLine(line: string, raw: boolean): string {
  return raw ? line : line.replace(LINE_PREFIX, "");
}

function defaultLogDirectory(): string | null {
  const localAppData = process.env["LOCALAPPDATA"];
  if (!localAppData) return null;
  return join(localAppData, "FiveM", "FiveM.app", "logs");
}

/** Reads a byte range with a shared handle, so the game can keep writing. */
export function readRange(file: string, start: number, end: number): string {
  const length = end - start;
  if (length <= 0) return "";

  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(file, "r");
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function splitLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "");
}
