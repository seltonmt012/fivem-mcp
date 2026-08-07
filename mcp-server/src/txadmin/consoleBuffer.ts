/**
 * In-memory tail of the server console as streamed by txAdmin. Pure -- no I/O.
 *
 * Cursors are byte positions in the *raw* stream (ANSI escapes included), so
 * appends never have to re-measure anything. They are monotonic and never
 * reused: trimming the front advances baseCursor instead of resetting it, so a
 * caller-held cursor either still points into the buffer or is honestly
 * reported as aged out.
 */

/** CSI and OSC sequences, then any stray escape. xterm-oriented, like txAdmin's own panel. */
const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b./g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "").replace(/\r\n?/g, "\n");
}

/**
 * txAdmin stamps the stream with `{§<hex unix seconds>}` markers at the start
 * of each burst. Rendered as a wall clock rather than stripped: knowing *when*
 * a console line happened is exactly what correlating with the client log or a
 * crash dump needs.
 */
const TIMESTAMP_MARKER = /\{§([0-9a-fA-F]{8,12})\}/g;

function renderTimestampMarkers(value: string): string {
  return value.replace(TIMESTAMP_MARKER, (_match, hex: string) => {
    const date = new Date(parseInt(hex, 16) * 1000);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `[${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}] `;
  });
}

export interface ConsoleRead {
  /** Console text: ANSI stripped, txAdmin time markers rendered as [HH:MM:SS]. */
  text: string;
  /** Pass this back as `cursor` to read only what comes after. */
  nextCursor: number;
  /** True when maxBytes cut the front off the requested range. */
  truncated: boolean;
  /** True when the requested cursor aged out of the buffer; text is the tail instead. */
  cursorInvalid: boolean;
}

export class ConsoleRingBuffer {
  private buffer = "";
  /** Absolute position of buffer[0] in the raw stream. */
  private baseCursor = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: string): void {
    if (chunk.length === 0) return;
    this.buffer += chunk;
    const excess = this.buffer.length - this.maxBytes;
    if (excess > 0) {
      this.buffer = this.buffer.slice(excess);
      this.baseCursor += excess;
    }
  }

  /** An out-of-band note from this MCP, marked so it cannot pass as console output. */
  appendMarker(note: string): void {
    const lead = this.buffer.length === 0 || this.buffer.endsWith("\n") ? "" : "\n";
    this.append(`${lead}[fivem-mcp] ${note}\n`);
  }

  /**
   * Appends txAdmin's recent-buffer replay after a rejoin without duplicating
   * the lines already held: the longest suffix of the buffer that is a prefix
   * of the snapshot is treated as overlap and skipped. The scan is bounded, so
   * a pathological snapshot costs little and at worst duplicates output rather
   * than losing any.
   */
  appendSnapshot(snapshot: string): void {
    // Markers are ours, never part of the server's replay, and a disconnect
    // leaves one at the very end -- so match against the buffer as it looked
    // before any trailing marker lines, or the scan would never find overlap.
    let content = this.buffer;
    for (;;) {
      const lastLineStart = content.lastIndexOf("\n", content.length - 2) + 1;
      const lastLine = content.slice(lastLineStart);
      if (!lastLine.startsWith("[fivem-mcp] ") || !lastLine.endsWith("\n")) break;
      content = content.slice(0, lastLineStart);
    }

    const window = Math.min(content.length, snapshot.length, 16 * 1024);
    for (let overlap = window; overlap > 0; overlap -= 1) {
      if (content.endsWith(snapshot.slice(0, overlap))) {
        this.append(snapshot.slice(overlap));
        return;
      }
    }
    this.append(snapshot);
  }

  /** The position just past everything appended so far. */
  cursor(): number {
    return this.baseCursor + this.buffer.length;
  }

  read(opts: { cursor?: number; maxBytes: number; filter?: string | RegExp }): ConsoleRead {
    const end = this.cursor();
    let cursorInvalid = false;
    let start: number;

    if (opts.cursor === undefined) {
      start = this.baseCursor;
    } else if (opts.cursor > end) {
      // A cursor from before a restart of this process; the stream restarted too.
      cursorInvalid = true;
      start = this.baseCursor;
    } else if (opts.cursor < this.baseCursor) {
      cursorInvalid = true;
      start = this.baseCursor;
    } else {
      start = opts.cursor;
    }

    let text = renderTimestampMarkers(stripAnsi(this.buffer.slice(start - this.baseCursor)));

    if (opts.filter !== undefined && (typeof opts.filter !== "string" || opts.filter.length > 0)) {
      const filter = opts.filter;
      const keep =
        typeof filter === "string"
          ? (line: string) => line.toLowerCase().includes(filter.toLowerCase())
          : (line: string) => filter.test(line);
      text = text.split("\n").filter(keep).join("\n");
    }

    let truncated = false;
    if (text.length > opts.maxBytes) {
      text = text.slice(text.length - opts.maxBytes);
      // Resume at the next line so the caller never sees half a line first --
      // unless no complete line fits the window (a single line can outgrow
      // maxBytes), where a leading fragment beats an empty answer.
      const aligned = text.slice(text.indexOf("\n") + 1);
      if (aligned.trim().length > 0) text = aligned;
      truncated = true;
    }

    return { text, nextCursor: end, truncated, cursorInvalid };
  }
}
