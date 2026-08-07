import type { Bridge, SendOutcome } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import { formatLogLine, type ClientLogReader, type LogOffset } from "../logs/clientLog.js";
import { buildProbeSnippet } from "../security/nativeCheck.js";

/** Shared by every tool in this folder: MCP text result, optionally an error. */
export function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], ...(isError ? { isError: true } : {}) };
}

/**
 * MCP image result with a caption block after it, so the answer says what the
 * picture shows and not only what it looks like.
 *
 * @param data Bare base64 -- no `data:` URI prefix, the client adds the framing.
 */
export function image(data: string, mimeType: string, caption?: string) {
  return {
    content: [
      { type: "image" as const, data, mimeType },
      ...(caption ? [{ type: "text" as const, text: caption }] : []),
    ],
  };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "512 KB" / "1.2 MB", for tool output that mentions file sizes. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Budget for the which-natives-exist probe; one loopback round trip fits easily. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Asks the connected client which of these globals actually exist, which is the
 * only way to tell a documented native from one this game build exposes.
 *
 * Lives here rather than next to buildProbeSnippet because it needs the bridge
 * and the config, and security/ does not depend on either.
 *
 * @returns null when nothing usable came back -- no client, a failed request, or
 *   an answer that mentions none of the names. Callers fall back to the
 *   reference alone rather than treating silence as "absent".
 */
export async function probeNatives(
  bridge: Bridge,
  config: Config,
  names: string[],
): Promise<Map<string, boolean> | null> {
  if (names.length === 0) return null;

  // The probe is an eval in the game client, however small. An operator who
  // turned running code off has turned this off too; the caller falls back to
  // the reference alone, exactly as if no client had answered.
  if (!config.code.enabled) return null;

  const outcome = await bridge.runCode(buildProbeSnippet(names), PROBE_TIMEOUT_MS);
  if (outcome.kind !== "ok") return null;

  const returned = (outcome.data as { returned?: unknown[] } | undefined)?.returned?.[0];
  if (typeof returned !== "object" || returned === null) return null;

  const present = new Map<string, boolean>();
  for (const [name, value] of Object.entries(returned as Record<string, unknown>)) {
    present.set(name, value === true);
  }
  return names.some((name) => present.has(name)) ? present : null;
}

/**
 * Takes the log position a request's output will be bracketed from, or null
 * when the caller (or the config, or a disabled reader) does not want the
 * output appended.
 */
export function beginLogCapture(
  reader: ClientLogReader,
  config: Config,
  captureLog: boolean | undefined,
): LogOffset | null {
  const wants = (captureLog ?? config.clientLog.captureOnExecute) && reader.enabled;
  return wants ? reader.currentOffset() : null;
}

/**
 * Reads what the client logged since the request was dispatched. Failures here
 * are never fatal -- the request already ran, the log is a bonus.
 *
 * @param offsetBefore Log position taken *before* dispatching, or null when the
 *   caller does not want the output appended.
 */
/** How often the capture re-reads the log while waiting for output. */
const CAPTURE_POLL_MS = 75;
/** Quiet period: once output has started arriving, stop when nothing new came for this long. */
const CAPTURE_SETTLE_MS = 250;
/**
 * How long to wait for a command's *first* output line. The game flushes its
 * log on its own schedule, sometimes well after the command's ack; a capture
 * that gives up too early hands those lines to the next call. Commands that
 * log nothing pay this in full, which is why it stays small.
 */
const CAPTURE_WAIT_MS = 1_000;

export async function captureOutput(
  reader: ClientLogReader,
  offsetBefore: LogOffset | null,
): Promise<string> {
  if (offsetBefore === null) return "";

  /*
    The game flushes its console output to disk asynchronously and on its own
    schedule -- sometimes well after the command's ack. A single fixed sleep
    either wastes time or reports "logged nothing" and leaks the lines into the
    next call's capture window. So poll: wait up to CAPTURE_WAIT_MS for the first
    line, then keep reading until the output has been quiet for CAPTURE_SETTLE_MS.
  */
  try {
    const startedAt = Date.now();
    let lines: string[] = [];
    let lastGrowthAt = startedAt;

    for (;;) {
      await sleep(CAPTURE_POLL_MS);
      const slice = reader.readSince(offsetBefore);
      const now = Date.now();

      // Append-only from a fixed offset, so a changed line count is growth.
      if (slice.lines.length !== lines.length) {
        lines = slice.lines;
        lastGrowthAt = now;
      }

      const settled = lines.length > 0 && now - lastGrowthAt >= CAPTURE_SETTLE_MS;
      if (settled || now - startedAt >= CAPTURE_WAIT_MS) break;
    }

    if (lines.length === 0) {
      return "\n\nThe client logged nothing while this ran.";
    }
    const rendered = lines.map((line) => formatLogLine(line, false)).join("\n");
    return `\n\nClient log during execution (${lines.length} line(s)):\n${rendered}`;
  } catch {
    return "";
  }
}

/** The SendOutcome kinds whose rendering is the same for every bridge request. */
export type FailureOutcome = Exclude<SendOutcome, { kind: "ok" } | { kind: "resource-error" }>;

export interface FailureContext {
  /** How the request reads mid-sentence: "command" or "snippet". */
  noun: "command" | "snippet";
  /** bridge.address, for the not-connected guidance. */
  address: string;
  /** Tool-specific advice appended to the timeout message. */
  timeoutAdvice: string;
}

/**
 * Renders every outcome except "ok" and "resource-error", whose rendering is
 * what actually differs between the tools. One implementation, so the two
 * request tools cannot drift apart in how they explain the same failure.
 */
export function renderFailure(outcome: FailureOutcome, ctx: FailureContext): string {
  switch (outcome.kind) {
    case "not-connected":
      return (
        `No FiveM bridge is connected. The server is listening on ${ctx.address}; ` +
        "start the game, make sure the bridge resource is running and its NUI page is " +
        "loaded, then check fivem_bridge_status."
      );

    case "rate-limited":
      return (
        `Rate limit reached (${outcome.limitPerMinute} requests/minute). Nothing was sent. ` +
        "Wait a moment or raise rateLimit.commandsPerMinute in fivem-mcp.config.json."
      );

    case "timeout":
      return (
        `The ${ctx.noun} was sent but no result arrived within ${outcome.timeoutMs} ms. ` +
        ctx.timeoutAdvice
      );

    case "disconnected":
      return `The ${ctx.noun} could not be completed: ${outcome.reason}`;

    case "policy-blocked":
      return `Blocked by the bridge host's policy: ${outcome.reason}`;
  }
}
