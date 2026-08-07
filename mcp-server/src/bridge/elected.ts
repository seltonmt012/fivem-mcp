import { randomUUID } from "node:crypto";
import WebSocket from "ws";

import type { Bridge, BridgeStatus, SendOutcome } from "./bridge.js";
import { bridgeAddress, type Config } from "../config.js";
import { log } from "../logger.js";
import {
  CloseCode,
  PROTOCOL_VERSION,
  parseHostToPeerMessage,
  type ParsedHostToPeer,
} from "./protocol.js";
import { BridgeServer, PEER_PATH, PortInUseError } from "./server.js";

const PEER_HANDSHAKE_TIMEOUT_MS = 3_000;
const STATUS_TIMEOUT_MS = 3_000;
/**
 * The host settles every request itself (its own timeout comes back as a
 * `timeout` outcome), so the peer only adds this on top to catch a host that
 * has stopped answering entirely.
 */
const RESPONSE_GRACE_MS = 5_000;

/** Re-election is jittered so peers racing for a dead host's port spread out. */
const REELECT_MIN_MS = 100;
const REELECT_JITTER_MS = 500;
/** Ceiling for the backoff while the port is held by something unusable. */
const RETRY_MAX_MS = 5_000;

/**
 * The multi-session front door: the first fivem-mcp process to bind the port
 * hosts the bridge, every later one attaches to it as a peer, and when the
 * host goes away a peer takes over. Tools talk to this and never notice which
 * of the two is underneath.
 */
export class ElectedBridge implements Bridge {
  private inner: BridgeServer | PeerBridge | null = null;
  private closed = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  /** Why there is currently no bridge, phrased for the operator. */
  private note: string | null = null;

  private constructor(
    private readonly config: Config,
    private readonly token: string,
    private readonly serverVersion: string,
  ) {}

  /**
   * Always resolves: when neither hosting nor attaching works (say the port is
   * held by an unrelated process), the server still comes up with its tools
   * answering "not connected" plus a note, and the election keeps retrying in
   * the background. That is the whole improvement over exiting on EADDRINUSE.
   */
  static async open(config: Config, token: string, serverVersion: string): Promise<ElectedBridge> {
    const bridge = new ElectedBridge(config, token, serverVersion);
    await bridge.elect();
    return bridge;
  }

  get address(): string {
    return bridgeAddress(this.config);
  }

  async send(command: string, timeoutMs: number): Promise<SendOutcome> {
    return this.inner ? this.inner.send(command, timeoutMs) : { kind: "not-connected" };
  }

  async runCode(code: string, timeoutMs: number): Promise<SendOutcome> {
    return this.inner ? this.inner.runCode(code, timeoutMs) : { kind: "not-connected" };
  }

  async getStatus(): Promise<BridgeStatus> {
    if (this.inner) return this.inner.getStatus();
    // "none", not "peer": this process neither owns the port nor is attached
    // to the process that does -- the election is still working on it.
    return emptyStatus(
      this.address,
      this.config,
      "none",
      this.note ?? "No bridge host is up yet; still trying.",
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const inner = this.inner;
    this.inner = null;
    if (inner) await inner.close();
  }

  /** One full attempt: bind, else attach. Failure schedules the next attempt. */
  private async elect(): Promise<void> {
    if (this.closed || this.inner !== null) return;

    const server = new BridgeServer(this.config, this.token, this.serverVersion);
    try {
      await server.start();
      this.becameBridge(server, "This process is now the bridge host");
      return;
    } catch (err) {
      if (!(err instanceof PortInUseError)) {
        // EACCES and friends: not recoverable by electing, but a live server
        // with a note beats a dead one. Keep retrying slowly.
        this.recordFailure(`The bridge could not bind ${this.address}: ${(err as Error).message}`);
        this.scheduleElection();
        return;
      }
    }

    try {
      const peer = await PeerBridge.connect(this.config, this.token);
      peer.onDown = (reason) => {
        if (this.closed || this.inner !== peer) return;
        this.inner = null;
        log.info(`The bridge host went away (${reason}), re-electing`);
        this.scheduleElection();
      };
      this.becameBridge(peer, `Attached as a peer to the bridge host at ${this.address}`);
    } catch (err) {
      this.recordFailure(
        err instanceof PeerConnectError
          ? err.guidance
          : `Could not attach to the bridge host: ${(err as Error).message}`,
      );
      this.scheduleElection();
    }
  }

  private becameBridge(inner: BridgeServer | PeerBridge, message: string): void {
    // close() may have run while start()/connect() was in flight.
    if (this.closed) {
      void inner.close();
      return;
    }
    this.inner = inner;
    this.note = null;
    this.consecutiveFailures = 0;
    log.info(message);
  }

  private recordFailure(note: string): void {
    this.consecutiveFailures += 1;
    if (this.note !== note) {
      this.note = note;
      log.warn(note);
    }
  }

  private scheduleElection(): void {
    if (this.closed || this.retryTimer) return;
    const backoff = Math.min(REELECT_MIN_MS * 2 ** this.consecutiveFailures, RETRY_MAX_MS);
    const delay = backoff + Math.floor(Math.random() * REELECT_JITTER_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.elect().catch((err) => {
        this.recordFailure(`Election attempt failed: ${(err as Error).message}`);
        this.scheduleElection();
      });
    }, delay);
    this.retryTimer.unref?.();
  }
}

/* ------------------------------------------------------------------ *
 * peer transport
 * ------------------------------------------------------------------ */

class PeerConnectError extends Error {
  constructor(
    message: string,
    /** What to tell the operator when this state persists. */
    public readonly guidance: string,
  ) {
    super(message);
    this.name = "PeerConnectError";
  }
}

interface PendingReply {
  settle: (message: ParsedHostToPeer) => void;
  fail: () => void;
  timer: NodeJS.Timeout;
}

/**
 * Pure transport: forwards the three Bridge calls to the host over one
 * WebSocket and hands back whatever outcome the host produced. All policy —
 * rate limits, game timeouts — runs on the host.
 */
class PeerBridge implements Bridge {
  private readonly pending = new Map<string, PendingReply>();
  private disposed = false;

  /** Set by ElectedBridge; fired once when the host connection is lost. */
  onDown: ((reason: string) => void) | null = null;

  private constructor(
    private readonly ws: WebSocket,
    private readonly config: Config,
  ) {
    ws.on("message", (raw) => {
      const message = parseHostToPeerMessage(raw.toString());
      if (message === null || message.t === "welcome") return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.settle(message);
    });

    ws.on("close", (code, reason) => {
      for (const [id, entry] of this.pending) {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        entry.fail();
      }
      if (this.disposed) return;
      this.disposed = true;
      const why =
        code === CloseCode.SHUTDOWN
          ? "host shut down"
          : `connection closed (code ${code}${reason.toString() ? `: ${reason.toString()}` : ""})`;
      this.onDown?.(why);
    });

    ws.on("error", () => {
      // The close handler runs right after and owns the teardown.
    });
  }

  /**
   * Dials the host and completes the peer handshake, or rejects with a
   * PeerConnectError that says what the port's owner turned out to be.
   */
  static connect(config: Config, token: string): Promise<PeerBridge> {
    const url = `${bridgeAddress(config)}${PEER_PATH}`;
    return new Promise<PeerBridge>((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;

      const fail = (err: PeerConnectError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        ws.terminate();
        reject(err);
      };

      const timer = setTimeout(() => {
        fail(
          new PeerConnectError(
            "no welcome within the handshake window",
            `Port ${config.port} is in use, but its owner did not complete a fivem-mcp ` +
              `handshake. If it is not another fivem-mcp, set "port" in fivem-mcp.config.json ` +
              "or FIVEM_BRIDGE_PORT to a free port.",
          ),
        );
      }, PEER_HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();

      ws.on("error", (err) => {
        fail(
          new PeerConnectError(
            `could not connect: ${err.message}`,
            `Port ${config.port} is in use, but nothing answers WebSocket connections on it. ` +
              `If it is not another fivem-mcp, set "port" in fivem-mcp.config.json or ` +
              "FIVEM_BRIDGE_PORT to a free port.",
          ),
        );
      });

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            t: "hello",
            protocol: PROTOCOL_VERSION,
            token,
            resource: "mcp",
            client: "mcp",
          }),
        );
      });

      ws.on("close", (code) => {
        fail(
          code === CloseCode.UNAUTHORIZED
            ? new PeerConnectError(
                "the host rejected the token",
                "Another fivem-mcp owns the port but uses a different bridge token. All " +
                  "sessions must share one token (same token file or FIVEM_BRIDGE_TOKEN).",
              )
            : new PeerConnectError(
                `the host closed the handshake (code ${code})`,
                "Another process owns the port but refused the peer handshake -- most likely " +
                  "an older fivem-mcp that predates multi-session support. Restart that " +
                  "session on the current version.",
              ),
        );
      });

      ws.on("message", (raw) => {
        const message = parseHostToPeerMessage(raw.toString());
        if (message?.t !== "welcome") return;
        if (message.role !== "peer") {
          // An old host running the NUI path just accepted us as the game
          // session. Back out before we displace the real game client.
          fail(
            new PeerConnectError(
              "the host answered with a session welcome, not a peer welcome",
              "Another fivem-mcp owns the port but predates multi-session support. Restart " +
                "that session on the current version.",
            ),
          );
          return;
        }
        settled = true;
        clearTimeout(timer);
        ws.removeAllListeners();
        resolve(new PeerBridge(ws, config));
      });
    });
  }

  get address(): string {
    return bridgeAddress(this.config);
  }

  async send(command: string, timeoutMs: number): Promise<SendOutcome> {
    return this.request("command", command, timeoutMs);
  }

  async runCode(code: string, timeoutMs: number): Promise<SendOutcome> {
    return this.request("eval", code, timeoutMs);
  }

  async getStatus(): Promise<BridgeStatus> {
    const id = randomUUID();
    const reply = await this.roundTrip({ t: "status-request", id }, id, STATUS_TIMEOUT_MS);
    if (reply === null || reply.t !== "status") {
      return emptyStatus(
        this.address,
        this.config,
        "peer",
        "The bridge host did not answer a status request.",
      );
    }
    // The host reported itself; this process is a peer of it.
    return { ...reply.status, role: "peer" };
  }

  async close(): Promise<void> {
    this.disposed = true;
    try {
      this.ws.close(1000, "peer shutdown");
    } catch {
      /* already closing */
    }
  }

  private async request(
    kind: "command" | "eval",
    body: string,
    timeoutMs: number,
  ): Promise<SendOutcome> {
    const id = randomUUID();
    const reply = await this.roundTrip(
      { t: "request", id, kind, body, timeoutMs },
      id,
      timeoutMs + RESPONSE_GRACE_MS,
    );
    if (reply === null) {
      return { kind: "disconnected", reason: "The bridge host stopped answering" };
    }
    if (reply.t !== "response") {
      return { kind: "disconnected", reason: "The bridge host answered with the wrong message" };
    }
    return reply.outcome;
  }

  /** Resolves with the host's reply, or null on timeout / connection loss. */
  private roundTrip(
    message: object,
    id: string,
    timeoutMs: number,
  ): Promise<ParsedHostToPeer | null> {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { settle: resolve, fail: () => resolve(null), timer });
      this.ws.send(JSON.stringify(message), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          resolve(null);
        }
      });
    });
  }
}

/** What getStatus reports while there is no live path to a host. */
function emptyStatus(
  address: string,
  config: Config,
  role: BridgeStatus["role"],
  note: string,
): BridgeStatus {
  return {
    listening: address,
    connected: false,
    role,
    peers: 0,
    note,
    resource: null,
    sessionId: null,
    connectedSince: null,
    lastRoundTripMs: null,
    commandsSent: 0,
    pendingRequests: 0,
    rateLimitPerMinute: config.rateLimit.commandsPerMinute,
    recentLogs: [],
  };
}
