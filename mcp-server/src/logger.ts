/**
 * stderr-only logger.
 *
 * This process speaks MCP over stdio. Anything written to stdout that is not a
 * JSON-RPC frame corrupts the stream and the client drops the connection, so
 * every diagnostic in this project goes to stderr — no exceptions.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveThreshold(): number {
  const raw = process.env["FIVEM_BRIDGE_LOG_LEVEL"]?.toLowerCase();
  // Object.hasOwn, not `in`: "constructor" must not resolve to a threshold.
  if (raw && Object.hasOwn(RANK, raw)) return RANK[raw as LogLevel];
  return RANK.info;
}

const threshold = resolveThreshold();

function write(level: LogLevel, message: string, detail?: unknown): void {
  if (RANK[level] < threshold) return;
  const stamp = new Date().toISOString();
  let line = `${stamp} [${level.toUpperCase()}] ${message}`;
  if (detail !== undefined) {
    line += ` ${formatDetail(detail)}`;
  }
  process.stderr.write(`${line}\n`);
}

function formatDetail(detail: unknown): string {
  if (detail instanceof Error) return `${detail.name}: ${detail.message}`;
  if (typeof detail === "string") return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

export const log = {
  debug: (message: string, detail?: unknown) => write("debug", message, detail),
  info: (message: string, detail?: unknown) => write("info", message, detail),
  warn: (message: string, detail?: unknown) => write("warn", message, detail),
  error: (message: string, detail?: unknown) => write("error", message, detail),
};

/**
 * Defensive guard: reroute console.* to stderr so a stray console.log in any
 * dependency cannot corrupt the MCP stdio stream.
 */
export function guardStdout(): void {
  console.log = (...args: unknown[]) => write("info", args.map(formatDetail).join(" "));
  console.info = console.log;
  console.debug = (...args: unknown[]) => write("debug", args.map(formatDetail).join(" "));
  console.warn = (...args: unknown[]) => write("warn", args.map(formatDetail).join(" "));
  console.error = (...args: unknown[]) => write("error", args.map(formatDetail).join(" "));
}
