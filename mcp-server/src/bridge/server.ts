import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

import type { Bridge, BridgeStatus, SendOutcome } from "./bridge.js";
import { bridgeAddress, LOOPBACK_REMOTE_ADDRESSES, MAX_PAYLOAD_BYTES, type Config } from "../config.js";
import { log } from "../logger.js";
import { checkCode } from "../security/codePolicy.js";
import { checkCommand } from "../security/commandPolicy.js";
import { tokenMatches } from "../security/token.js";
import {
  CloseCode,
  PROTOCOL_VERSION,
  parseClientMessage,
  parsePeerMessage,
  type ClientLogMessage,
  type CloseCodeValue,
  type HelloMessage,
  type HostToPeerMessage,
  type PeerRequestMessage,
  type ServerMessage,
} from "./protocol.js";
import {
  BridgeGoneError,
  PendingRequests,
  RateLimiter,
  RequestTimeoutError,
} from "./session.js";

const HANDSHAKE_TIMEOUT_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_GRACE_MS = 30_000;
/** How long a polite close gets during shutdown before sockets are terminated. */
const SHUTDOWN_GRACE_MS = 250;
const LOG_BUFFER_SIZE = 50;

/** Peers connect on this path; everything else is treated as a NUI client. */
export const PEER_PATH = "/peer";

/** Typed so the election in elected.ts can tell "taken" from "broken". */
export class PortInUseError extends Error {
  constructor(port: number) {
    super(`Port ${port} is already in use.`);
    this.name = "PortInUseError";
  }
}

interface Session {
  id: string;
  ws: WebSocket;
  resource: string;
  client: string;
  connectedSince: number;
  lastPongAt: number;
  lastRoundTripMs: number | null;
  commandsSent: number;
  logs: string[];
}

export class BridgeServer implements Bridge {
  private wss: WebSocketServer | null = null;
  private session: Session | null = null;
  /** Peer fivem-mcp processes proxying through this host. Never sessions. */
  private readonly peers = new Set<WebSocket>();
  private heartbeat: NodeJS.Timeout | null = null;
  private pingCounter = 0;
  private lastPingId: number | null = null;
  private lastPingAt = 0;

  private readonly pending = new PendingRequests();
  private readonly rateLimiter: RateLimiter;

  constructor(
    private readonly config: Config,
    private readonly token: string,
    private readonly serverVersion: string,
  ) {
    this.rateLimiter = new RateLimiter(config.rateLimit.commandsPerMinute);
  }

  get address(): string {
    return bridgeAddress(this.config);
  }

  async start(): Promise<void> {
    const wss = new WebSocketServer({
      host: this.config.host,
      port: this.config.port,
      maxPayload: MAX_PAYLOAD_BYTES,
      // Hard boundary: nothing off-loopback ever gets upgraded. Origin and
      // resource checks happen after the upgrade so the client receives a
      // meaningful close code instead of a bare HTTP 403.
      verifyClient: (info, done) => {
        const remote = info.req.socket.remoteAddress ?? "";
        if (!LOOPBACK_REMOTE_ADDRESSES.has(remote)) {
          log.warn(`Rejected upgrade from non-loopback address ${remote}`);
          done(false, 403, "Forbidden");
          return;
        }
        done(true);
      },
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          wss.off("listening", onListening);
          if (err.code === "EADDRINUSE") {
            reject(new PortInUseError(this.config.port));
          } else {
            reject(err);
          }
        };
        const onListening = () => {
          wss.off("error", onError);
          resolve();
        };
        wss.once("error", onError);
        wss.once("listening", onListening);
      });
    } catch (err) {
      // The election retries start() in a loop, so a failed bind must not leak
      // the server -- and a late error emission must find a listener, or it
      // would crash the process.
      wss.on("error", (lateErr) => log.debug("Error from a bridge server that never listened", lateErr));
      wss.close();
      throw err;
    }

    wss.on("error", (err) => log.error("WebSocket server error", err));
    wss.on("connection", (ws, req) => this.onConnection(ws, req));

    this.wss = wss;
    this.heartbeat = setInterval(() => this.tick(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();

    log.info(`Bridge listening on ${this.address}`);
  }

  async close(): Promise<void> {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.dropSession(CloseCode.SHUTDOWN, "server shutdown", "Bridge server is shutting down");

    // Peers treat 4011 as "the host is gone on purpose, re-elect now".
    for (const peer of this.peers) {
      peer.close(CloseCode.SHUTDOWN, "host shutdown");
    }
    this.peers.clear();

    const wss = this.wss;
    this.wss = null;
    if (!wss) return;

    // wss.close() does not call back until every socket is gone. A client that
    // has vanished without closing its TCP connection would hold shutdown for
    // ws's own close timeout, so give the polite close a moment, then pull the
    // plug on whatever is left.
    const closed = new Promise<void>((resolve) => wss.close(() => resolve()));
    const terminator = setTimeout(() => {
      for (const client of wss.clients) client.terminate();
    }, SHUTDOWN_GRACE_MS);
    terminator.unref?.();

    await closed;
    clearTimeout(terminator);
  }

  /**
   * Ends the current session: closes the socket, fails everything waiting on it
   * and forgets it.
   *
   * The session is cleared *before* the close so the "close" handler's
   * `this.session?.ws !== ws` guard makes it a no-op rather than tearing down
   * twice. Skipping this is how a lost heartbeat used to leave the bridge
   * advertised as connected until the socket finally died.
   */
  private dropSession(code: CloseCodeValue, reason: string, rejectMessage: string): void {
    const session = this.session;
    if (!session) return;

    this.session = null;
    this.lastPingId = null;
    session.ws.close(code, reason);
    this.pending.rejectAll(rejectMessage);
  }

  async getStatus(): Promise<BridgeStatus> {
    const session = this.session;
    return {
      listening: this.address,
      connected: session !== null,
      role: "host",
      peers: this.peers.size,
      note: null,
      resource: session?.resource ?? null,
      sessionId: session?.id ?? null,
      connectedSince: session ? new Date(session.connectedSince).toISOString() : null,
      lastRoundTripMs: session?.lastRoundTripMs ?? null,
      commandsSent: session?.commandsSent ?? 0,
      pendingRequests: this.pending.size,
      rateLimitPerMinute: this.rateLimiter.limitPerMinute,
      recentLogs: session ? [...session.logs] : [],
    };
  }

  /**
   * Dispatches a console command to the connected NUI bridge and waits for its
   * result. The command policy is enforced here, at the one chokepoint both the
   * local tools and the /peer proxy path go through -- the tools pre-check the
   * same policy for a friendlier message, this is the backstop.
   */
  async send(command: string, timeoutMs: number): Promise<SendOutcome> {
    const decision = checkCommand(command, this.config.commands);
    if (!decision.allowed) {
      return { kind: "policy-blocked", reason: decision.reason };
    }
    return this.dispatch(timeoutMs, (id) => ({ t: "command", id, command: decision.command, timeoutMs }));
  }

  /**
   * Sends a Lua snippet to the client for `load()` + `pcall()`. Like send(),
   * this enforces the host's code policy so a /peer request cannot sidestep it.
   */
  async runCode(code: string, timeoutMs: number): Promise<SendOutcome> {
    if (!this.config.code.enabled) {
      return {
        kind: "policy-blocked",
        reason: "Running code is disabled on the bridge host (code.enabled = false).",
      };
    }
    const decision = checkCode(code, this.config.code);
    if (!decision.allowed) {
      return { kind: "policy-blocked", reason: decision.reason };
    }
    return this.dispatch(timeoutMs, (id) => ({ t: "eval", id, code: decision.code, timeoutMs }));
  }

  /** Shared request path: session check, rate limit, correlation, settlement. */
  private async dispatch(
    timeoutMs: number,
    build: (id: string) => ServerMessage,
  ): Promise<SendOutcome> {
    const session = this.session;
    if (!session) return { kind: "not-connected" };

    if (!this.rateLimiter.tryConsume()) {
      return { kind: "rate-limited", limitPerMinute: this.rateLimiter.limitPerMinute };
    }

    const id = randomUUID();
    const settled = this.pending.wait(id, timeoutMs);

    this.write(session, build(id));
    session.commandsSent += 1;

    try {
      const result = await settled;
      if (result.ok) {
        return { kind: "ok", data: result.data, roundTripMs: result.roundTripMs };
      }
      return {
        kind: "resource-error",
        error: result.error ?? "The resource reported a failure without a message.",
        roundTripMs: result.roundTripMs,
      };
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        return { kind: "timeout", timeoutMs: err.timeoutMs };
      }
      if (err instanceof BridgeGoneError) {
        return { kind: "disconnected", reason: err.message };
      }
      throw err;
    }
  }

  /* ---------------------------------------------------------------- *
   * connection lifecycle
   * ---------------------------------------------------------------- */

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    // Loopback was already enforced in verifyClient. Peers get their own
    // admission: the NUI origin and resource checks below stay exactly as they
    // are, and never apply to /peer.
    if (pathnameOf(req.url) === PEER_PATH) {
      this.onPeerConnection(ws);
      return;
    }

    const origin = req.headers.origin;
    const originCheck = checkOrigin(origin, this.config);
    if (!originCheck.ok) {
      log.warn(`Rejected connection: ${originCheck.reason}`, { origin: origin ?? null });
      ws.close(originCheck.code, originCheck.closeReason);
      return;
    }

    let authenticated = false;
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        log.warn("Rejected connection: no hello within the handshake window");
        ws.close(CloseCode.BAD_HANDSHAKE, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        ws.close(CloseCode.BAD_HANDSHAKE, "binary frames are not supported");
        return;
      }

      const parsed = parseClientMessage(raw.toString());
      if (!parsed.ok) {
        log.warn(`Discarding malformed message: ${parsed.reason}`);
        if (!authenticated) {
          ws.close(CloseCode.BAD_HANDSHAKE, "malformed handshake");
        }
        return;
      }

      const message = parsed.message;

      if (!authenticated) {
        if (message.t !== "hello") {
          ws.close(CloseCode.BAD_HANDSHAKE, "expected hello first");
          return;
        }
        const accepted = this.authenticate(ws, message, originCheck.resource);
        if (!accepted) return;
        authenticated = true;
        clearTimeout(handshakeTimer);
        return;
      }

      // Ignore traffic from a socket that has already been superseded.
      if (this.session?.ws !== ws) return;

      switch (message.t) {
        case "hello":
          log.warn("Ignoring a second hello on an authenticated session");
          break;
        case "result":
          if (!this.pending.settle(message)) {
            log.debug(`Result for unknown request id ${message.id} (late or duplicate)`);
          }
          break;
        case "pong":
          this.onPong(message.id);
          break;
        case "log":
          this.recordResourceLog(message);
          break;
      }
    });

    ws.on("close", (code, reason) => {
      clearTimeout(handshakeTimer);
      if (this.session?.ws !== ws) return;
      const label = `${this.session.resource} (${this.session.id})`;
      this.session = null;
      this.lastPingId = null;
      this.pending.rejectAll("The FiveM bridge disconnected before the result arrived");
      log.info(`Bridge disconnected: ${label} code=${code} reason=${reason.toString() || "-"}`);
    });

    ws.on("error", (err) => log.warn("Bridge socket error", err));
  }

  /**
   * Admission and message loop for a peer fivem-mcp process. Deliberately never
   * calls authenticate(): a peer hello must not replace the game session, and
   * the origin / allowedResources checks are about NUI pages, not peers. Only
   * the protocol version and the shared token are checked.
   */
  private onPeerConnection(ws: WebSocket): void {
    let admitted = false;
    const handshakeTimer = setTimeout(() => {
      if (!admitted) {
        log.warn("Rejected peer: no hello within the handshake window");
        ws.close(CloseCode.BAD_HANDSHAKE, "handshake timeout");
      }
    }, HANDSHAKE_TIMEOUT_MS);
    handshakeTimer.unref?.();

    ws.on("message", (raw, isBinary) => {
      if (isBinary) {
        ws.close(CloseCode.BAD_HANDSHAKE, "binary frames are not supported");
        return;
      }

      const parsed = parsePeerMessage(raw.toString());
      if (!parsed.ok) {
        log.warn(`Discarding malformed peer message: ${parsed.reason}`);
        if (!admitted) ws.close(CloseCode.BAD_HANDSHAKE, "malformed handshake");
        return;
      }

      const message = parsed.message;

      if (!admitted) {
        if (message.t !== "hello") {
          ws.close(CloseCode.BAD_HANDSHAKE, "expected hello first");
          return;
        }
        if (message.protocol !== PROTOCOL_VERSION) {
          log.warn(`Rejected peer: protocol ${message.protocol}, expected ${PROTOCOL_VERSION}`);
          ws.close(CloseCode.BAD_HANDSHAKE, `expected protocol ${PROTOCOL_VERSION}`);
          return;
        }
        if (!tokenMatches(this.token, message.token)) {
          log.warn("Rejected peer: bad token");
          ws.close(CloseCode.UNAUTHORIZED, "invalid token");
          return;
        }
        admitted = true;
        clearTimeout(handshakeTimer);
        this.peers.add(ws);
        this.writePeer(ws, {
          t: "welcome",
          role: "peer",
          serverVersion: this.serverVersion,
          protocol: PROTOCOL_VERSION,
        });
        log.info(`Peer attached via ${message.client ?? "unknown"} (${this.peers.size} total)`);
        return;
      }

      switch (message.t) {
        case "hello":
          log.warn("Ignoring a second hello from an admitted peer");
          break;
        case "request":
          // The catch is the last line of the "every request settles" promise:
          // should dispatch() ever throw something unexpected, the peer still
          // gets an answer instead of hanging until its grace timeout.
          this.servePeerRequest(ws, message).catch((err) => {
            log.warn("A peer request failed unexpectedly", err);
            this.writePeer(ws, {
              t: "response",
              id: message.id,
              outcome: { kind: "disconnected", reason: "The bridge host failed to serve the request" },
            });
          });
          break;
        case "status-request":
          this.getStatus()
            .then((status) => this.writePeer(ws, { t: "status", id: message.id, status }))
            .catch((err) => log.warn("A peer status request failed unexpectedly", err));
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(handshakeTimer);
      if (this.peers.delete(ws)) {
        log.info(`Peer detached (${this.peers.size} left)`);
      }
    });

    ws.on("error", (err) => log.warn("Peer socket error", err));
  }

  /**
   * The whole point of proxying: the host answers with its *own* send/runCode,
   * so rate limiting and correlation with the game stay in
   * one implementation. Every request settles — dispatch() never throws for
   * bridge-side failures — so the peer always gets its response back.
   */
  private async servePeerRequest(ws: WebSocket, message: PeerRequestMessage): Promise<void> {
    const outcome: SendOutcome =
      message.kind === "command"
        ? await this.send(message.body, message.timeoutMs)
        : await this.runCode(message.body, message.timeoutMs);
    this.writePeer(ws, { t: "response", id: message.id, outcome });
  }

  private writePeer(ws: WebSocket, message: HostToPeerMessage): void {
    ws.send(JSON.stringify(message), (err) => {
      if (err) log.warn(`Failed to send ${message.t} to a peer`, err);
    });
  }

  private authenticate(
    ws: WebSocket,
    hello: HelloMessage,
    originResource: string | null,
  ): boolean {
    if (hello.protocol !== PROTOCOL_VERSION) {
      log.warn(`Rejected connection: protocol ${hello.protocol}, expected ${PROTOCOL_VERSION}`);
      ws.close(CloseCode.BAD_HANDSHAKE, `expected protocol ${PROTOCOL_VERSION}`);
      return false;
    }

    if (!tokenMatches(this.token, hello.token)) {
      log.warn(`Rejected connection from resource "${hello.resource}": bad token`);
      ws.close(CloseCode.UNAUTHORIZED, "invalid token");
      return false;
    }

    if (originResource !== null && originResource !== hello.resource) {
      log.warn(
        `Rejected connection: hello claims "${hello.resource}" but origin says "${originResource}"`,
      );
      ws.close(CloseCode.RESOURCE_REJECTED, "resource does not match origin");
      return false;
    }

    const allowed = this.config.allowedResources;
    if (allowed.length > 0 && !allowed.includes(hello.resource)) {
      log.warn(`Rejected connection: resource "${hello.resource}" is not in allowedResources`);
      ws.close(CloseCode.RESOURCE_REJECTED, "resource not allowed");
      return false;
    }

    if (this.session) {
      log.info(`Replacing bridge session ${this.session.id} with a new connection`);
      this.dropSession(
        CloseCode.REPLACED,
        "replaced by a newer session",
        "The bridge session was replaced by a new connection",
      );
    }

    const now = Date.now();
    const session: Session = {
      id: randomUUID(),
      ws,
      resource: hello.resource,
      client: hello.client ?? "nui",
      connectedSince: now,
      lastPongAt: now,
      lastRoundTripMs: null,
      commandsSent: 0,
      logs: [],
    };
    this.session = session;
    this.lastPingId = null;
    // A new game client must not inherit the budget its predecessor spent.
    this.rateLimiter.reset();

    this.write(session, {
      t: "welcome",
      sessionId: session.id,
      serverVersion: this.serverVersion,
      protocol: PROTOCOL_VERSION,
    });

    log.info(`Bridge connected: ${session.resource} (${session.id}) via ${session.client}`);
    return true;
  }

  private onPong(id: number): void {
    const session = this.session;
    if (!session) return;
    session.lastPongAt = Date.now();
    if (this.lastPingId !== null && id === this.lastPingId) {
      session.lastRoundTripMs = Date.now() - this.lastPingAt;
    }
  }

  private recordResourceLog(message: ClientLogMessage): void {
    const session = this.session;
    if (!session) return;
    const level = message.level ?? "info";
    session.logs.push(`${new Date().toISOString()} [${level}] ${message.message}`);
    if (session.logs.length > LOG_BUFFER_SIZE) {
      session.logs.splice(0, session.logs.length - LOG_BUFFER_SIZE);
    }
  }

  private tick(): void {
    const session = this.session;
    if (!session) return;

    if (Date.now() - session.lastPongAt > HEARTBEAT_GRACE_MS) {
      log.warn(`Bridge ${session.id} missed the heartbeat window, closing`);
      this.dropSession(
        CloseCode.HEARTBEAT_LOST,
        "heartbeat lost",
        "The FiveM bridge stopped answering heartbeats",
      );
      return;
    }

    this.pingCounter += 1;
    this.lastPingId = this.pingCounter;
    this.lastPingAt = Date.now();
    this.write(session, { t: "ping", id: this.pingCounter });
  }

  private write(session: Session, message: ServerMessage): void {
    session.ws.send(JSON.stringify(message), (err) => {
      if (err) log.warn(`Failed to send ${message.t} to the bridge`, err);
    });
  }
}

/* ------------------------------------------------------------------ */

/** Compares by pathname so a stray query string cannot demote a peer to NUI. */
function pathnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

type OriginCheck =
  | { ok: true; resource: string | null }
  | { ok: false; reason: string; code: number; closeReason: string };

/**
 * FiveM NUI pages run on the origin `https://cfx-nui-<resource>`; older builds
 * use `nui://<resource>`. Anything else is not a NUI page.
 */
function checkOrigin(origin: string | undefined, config: Config): OriginCheck {
  if (origin === undefined || origin === "") {
    if (config.allowNoOrigin) return { ok: true, resource: null };
    return {
      ok: false,
      reason: "connection carried no Origin header",
      code: CloseCode.ORIGIN_REJECTED,
      closeReason: "origin required",
    };
  }

  const resource = extractNuiResource(origin);
  if (resource === null) {
    return {
      ok: false,
      reason: `origin "${origin}" is not a FiveM NUI origin`,
      code: CloseCode.ORIGIN_REJECTED,
      closeReason: "origin not allowed",
    };
  }

  if (config.allowedResources.length > 0 && !config.allowedResources.includes(resource)) {
    return {
      ok: false,
      reason: `resource "${resource}" is not in allowedResources`,
      code: CloseCode.RESOURCE_REJECTED,
      closeReason: "resource not allowed",
    };
  }

  return { ok: true, resource };
}

function extractNuiResource(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }

  if (url.protocol === "nui:") {
    return url.hostname || null;
  }
  if (url.protocol === "https:" && url.hostname.startsWith("cfx-nui-")) {
    const name = url.hostname.slice("cfx-nui-".length);
    return name.length > 0 ? name : null;
  }
  return null;
}
