import { io, type Socket } from "socket.io-client";

import type { Config } from "../config.js";
import { log } from "../logger.js";
import { ConsoleRingBuffer, type ConsoleRead } from "./consoleBuffer.js";
import { resolveTxAdminPassword } from "./credentials.js";

/**
 * Rendered as prose by the tools, like ClientLogUnavailable. The message is
 * always remediation advice, never a bare error code.
 */
export class TxAdminUnavailable extends Error {}

export type TxAdminState =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected"; since: number; sawConsoleData: boolean }
  | { kind: "reconnecting"; attempt: number; lastError: string }
  | { kind: "auth-failed"; message: string }
  | { kind: "misconfigured"; message: string };

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;
/** How long ensureConnected waits for the initial console buffer after the join. */
const FIRST_DATA_GRACE_MS = 2_000;

/**
 * One authenticated socket.io connection to txAdmin's "liveconsole" room,
 * carrying both directions: consoleData events feed the ring buffer, and
 * consoleCommand emits run server console commands.
 *
 * txAdmin has no official public API -- this speaks the same protocol the web
 * panel speaks (password login for a session cookie, then a socket.io
 * handshake carrying it). Constructing does no I/O; the first tool call dials.
 * After that a manual reconnect loop keeps the console stream alive: manual,
 * because a reconnect must re-run the login first -- txAdmin sessions live in
 * memory and die with a panel restart, so replaying the old cookie would loop
 * on "invalid session" forever.
 */
/** In-memory server console ring buffer cap. */
export const CONSOLE_BUFFER_KIB = 1024;

export class TxAdminClient {
  private stateValue: TxAdminState = { kind: "idle" };
  private readonly buffer: ConsoleRingBuffer;
  private socket: Socket | null = null;
  private connectPromise: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private everConnected = false;
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly passwordFilePath: string,
  ) {
    this.buffer = new ConsoleRingBuffer(CONSOLE_BUFFER_KIB * 1024);
  }

  get state(): TxAdminState {
    return this.stateValue;
  }

  cursor(): number {
    return this.buffer.cursor();
  }

  read(opts: { cursor?: number; maxBytes?: number; filter?: string | RegExp }): ConsoleRead {
    return this.buffer.read({
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      maxBytes: opts.maxBytes ?? this.config.txAdmin.defaultReadBytes,
      ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
    });
  }

  /** One line for status output and console-read headers. */
  describeState(): string {
    const url = this.config.txAdmin.url;
    switch (this.stateValue.kind) {
      case "idle":
        return `txAdmin (${url}): not contacted yet -- connects on first use`;
      case "connecting":
        return `txAdmin (${url}): connecting`;
      case "connected": {
        const since = new Date(this.stateValue.since).toISOString();
        return this.stateValue.sawConsoleData
          ? `txAdmin (${url}): connected since ${since}`
          : `txAdmin (${url}): connected since ${since}, but no console data has arrived -- ` +
              'check that the account has the "Console: View" permission';
      }
      case "reconnecting":
        return (
          `txAdmin (${url}): reconnecting (attempt ${this.stateValue.attempt}) after: ` +
          this.stateValue.lastError
        );
      case "auth-failed":
        return `txAdmin (${url}): login rejected -- ${this.stateValue.message}`;
      case "misconfigured":
        return `txAdmin (${url}): not configured -- ${this.stateValue.message}`;
    }
  }

  /**
   * Idempotent: resolves immediately when connected, joins an in-flight
   * attempt, or dials. Throws TxAdminUnavailable with remediation prose after
   * connectTimeoutMs, or immediately for the two states retrying cannot fix.
   */
  async ensureConnected(): Promise<void> {
    if (this.closed) throw new TxAdminUnavailable("This MCP server is shutting down.");
    if (this.stateValue.kind === "connected") return;
    if (this.stateValue.kind === "auth-failed") throw this.authFailedError();
    if (this.stateValue.kind === "misconfigured") throw this.misconfiguredError();

    // A scheduled retry that has not fired yet -- fire it now, the caller is waiting.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.startAttempt();
    }
    const attempt = this.connectPromise ?? this.startAttempt();

    const timeoutMs = this.config.txAdmin.connectTimeoutMs;
    const timedOut = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
      timer.unref?.();
    });

    try {
      const raced = await Promise.race([attempt.then(() => undefined), timeout]);
      if (raced === timedOut) {
        // The attempt keeps running; a later call may find it connected.
        throw new TxAdminUnavailable(this.unreachableMessage(`no connection within ${timeoutMs} ms`));
      }
    } finally {
      clearTimeout(timer);
    }

    // Re-read: the awaited attempt mutated the state, which TS cannot see.
    const state = this.currentState();
    if (state.kind === "auth-failed") throw this.authFailedError();
    if (state.kind === "misconfigured") throw this.misconfiguredError();
    if (state.kind !== "connected") {
      const detail = state.kind === "reconnecting" ? state.lastError : "connection failed";
      throw new TxAdminUnavailable(this.unreachableMessage(detail));
    }
  }

  /** Defeats control-flow narrowing that is stale after awaits mutated the state. */
  private currentState(): TxAdminState {
    return this.stateValue;
  }

  /**
   * Emits the command into the server console. txAdmin sends no acknowledgement
   * -- the only feedback is whatever appears on the console stream, so callers
   * bracket the cursor around this and read the delta.
   */
  sendCommand(command: string): void {
    if (this.stateValue.kind !== "connected" || this.socket === null) {
      throw new TxAdminUnavailable(this.unreachableMessage("the socket is not connected"));
    }
    this.socket.emit("consoleCommand", command);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
  }

  // ---------------------------------------------------------------- internals

  private startAttempt(): Promise<void> {
    const attempt = this.connect().finally(() => {
      this.connectPromise = null;
    });
    this.connectPromise = attempt;
    // ensureConnected surfaces failures; the loop itself must never reject unhandled.
    attempt.catch(() => {});
    return attempt;
  }

  private async connect(): Promise<void> {
    const username = this.config.txAdmin.username;
    const password = resolveTxAdminPassword(this.passwordFilePath);
    if (!username || !password) {
      this.stateValue = {
        kind: "misconfigured",
        message: !username
          ? "txAdmin.username is not set"
          : `no password in FIVEM_TXADMIN_PASSWORD or ${this.passwordFilePath}`,
      };
      return;
    }

    this.stateValue = { kind: "connecting" };

    let cookie: string;
    try {
      cookie = await this.login(username, password.value);
    } catch (err) {
      if (err instanceof AuthRejected) {
        // Sticky on purpose: txAdmin temporarily bans an IP after a handful of
        // failed logins, so retrying wrong credentials would lock everyone out.
        this.stateValue = { kind: "auth-failed", message: err.message };
        log.warn(`txAdmin login rejected: ${err.message}`);
        return;
      }
      this.handleAttemptFailure(err instanceof Error ? err.message : String(err));
      return;
    }

    await this.openSocket(cookie);
  }

  private async login(username: string, password: string): Promise<string> {
    const url = new URL("auth/password", ensureTrailingSlash(this.config.txAdmin.url));
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
        signal: AbortSignal.timeout(this.config.txAdmin.connectTimeoutMs),
      });
    } catch (err) {
      throw new Error(
        `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      /* handled by the checks below */
    }

    const errorField =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : null;
    if (errorField !== null) throw new AuthRejected(errorField);
    if (!response.ok) {
      throw new Error(`login endpoint answered HTTP ${response.status}`);
    }

    const cookies = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0] ?? "")
      .filter((pair) => pair.includes("="));
    if (cookies.length === 0) {
      throw new Error("login succeeded but no session cookie came back");
    }
    return cookies.join("; ");
  }

  private openSocket(cookie: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const socket = io(this.config.txAdmin.url, {
        path: "/socket.io",
        // Polling first, then upgrade: txAdmin's engine.io rejects websocket as
        // the *initial* transport with HTTP 400 {"code":3} -- only the upgrade
        // path is accepted.
        transports: ["polling", "websocket"],
        // Manual reconnection only -- see the class comment.
        reconnection: false,
        // uiVersion is deliberately absent: txAdmin only enforces the panel
        // version match when the query carries one.
        query: { rooms: "liveconsole" },
        extraHeaders: { Cookie: cookie },
        timeout: this.config.txAdmin.connectTimeoutMs,
      });
      this.socket = socket;

      let settled = false;
      let joined = false;
      const settle = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      socket.on("connect", () => {
        joined = true;
        this.reconnectAttempt = 0;
        this.stateValue = { kind: "connected", since: Date.now(), sawConsoleData: false };
        log.info(`txAdmin live console connected (${this.config.txAdmin.url})`);
        // Give the recent-buffer replay a moment so the first read has content.
        const grace = setTimeout(settle, FIRST_DATA_GRACE_MS);
        grace.unref?.();
      });

      socket.on("consoleData", (data: unknown) => {
        if (typeof data !== "string") return;
        const first =
          this.stateValue.kind === "connected" && !this.stateValue.sawConsoleData;
        if (first) {
          this.stateValue = { ...this.stateValue, sawConsoleData: true } as TxAdminState;
          // The join replays txAdmin's recent buffer; after a reconnect much of
          // it is already here, so overlap-trim instead of duplicating.
          if (this.everConnected) {
            this.buffer.appendSnapshot(data);
          } else {
            this.buffer.append(data);
          }
          this.everConnected = true;
          settle();
        } else {
          this.buffer.append(data);
        }
      });

      // txAdmin tells sockets whose session died to log out; the cookie is gone,
      // so only a fresh login helps -- exactly what the reconnect loop does.
      socket.on("logout", () => socket.disconnect());

      socket.on("connect_error", (err: Error) => {
        socket.removeAllListeners();
        socket.disconnect();
        if (this.socket === socket) this.socket = null;
        this.handleAttemptFailure(`socket connect failed: ${err.message}`);
        settle();
      });

      socket.on("disconnect", (reason: string) => {
        socket.removeAllListeners();
        if (this.socket === socket) this.socket = null;
        if (this.closed) return;
        if (joined) {
          this.buffer.appendMarker(
            "connection to txAdmin lost -- console output during the gap is missing",
          );
        }
        this.handleAttemptFailure(`disconnected: ${reason}`);
        settle();
      });
    });
  }

  /** Shared by login failures and socket drops: log, then back off and retry. */
  private handleAttemptFailure(detail: string): void {
    if (this.closed) return;
    this.reconnectAttempt += 1;
    this.stateValue = { kind: "reconnecting", attempt: this.reconnectAttempt, lastError: detail };
    const delay = Math.min(
      RECONNECT_BASE_MS * 2 ** Math.min(this.reconnectAttempt - 1, 10),
      RECONNECT_CAP_MS,
    );
    log.debug(`txAdmin connection attempt failed (${detail}), retrying in ${delay} ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed && this.connectPromise === null) this.startAttempt();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private authFailedError(): TxAdminUnavailable {
    const message =
      this.stateValue.kind === "auth-failed" ? this.stateValue.message : "login rejected";
    return new TxAdminUnavailable(
      `txAdmin at ${this.config.txAdmin.url} rejected the login: ${message}\n` +
        `Check txAdmin.username and the password in FIVEM_TXADMIN_PASSWORD or ` +
        `${this.passwordFilePath}, then restart this MCP server. Login is not retried ` +
        "automatically because repeated failures make txAdmin temporarily ban this address.",
    );
  }

  private misconfiguredError(): TxAdminUnavailable {
    const message =
      this.stateValue.kind === "misconfigured" ? this.stateValue.message : "incomplete configuration";
    return new TxAdminUnavailable(
      `The txAdmin connection is not configured: ${message}.\n` +
        "Create a dedicated txAdmin admin account with only the Console: View and Console: " +
        'Write permissions, set "txAdmin.username" in fivem-mcp.config.json, and put the ' +
        `password in ${this.passwordFilePath} (or FIVEM_TXADMIN_PASSWORD).`,
    );
  }

  private unreachableMessage(detail: string): string {
    return (
      `Could not reach txAdmin at ${this.config.txAdmin.url} (${detail}). ` +
      "Check that the FXServer/txAdmin panel is running and the URL in txAdmin.url is right. " +
      "txAdmin has no official API, so a txAdmin update may also have changed the interface " +
      "this tool speaks."
    );
  }
}

/** A login rejection, as opposed to a network failure -- never auto-retried. */
class AuthRejected extends Error {}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
