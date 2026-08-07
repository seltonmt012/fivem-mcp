/**
 * The tool-facing surface of the bridge, implemented twice: by BridgeServer
 * when this process owns the port (host), and by the peer transport in
 * elected.ts when another fivem-mcp process does. Tools depend only on this.
 */

export interface BridgeStatus {
  listening: string;
  connected: boolean;
  /**
   * Whether this process owns the port ("host"), proxies through the one that
   * does ("peer"), or currently has neither -- the election is still trying
   * ("none").
   */
  role: "host" | "peer" | "none";
  /** Peer fivem-mcp processes attached to the host. */
  peers: number;
  /** One line of operator guidance when the bridge is degraded, else null. */
  note: string | null;
  resource: string | null;
  sessionId: string | null;
  connectedSince: string | null;
  lastRoundTripMs: number | null;
  commandsSent: number;
  pendingRequests: number;
  rateLimitPerMinute: number;
  recentLogs: string[];
}

export type SendOutcome =
  | { kind: "ok"; data: unknown; roundTripMs: number }
  | { kind: "resource-error"; error: string; roundTripMs: number }
  | { kind: "not-connected" }
  | { kind: "rate-limited"; limitPerMinute: number }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "disconnected"; reason: string }
  /**
   * Refused by the host's command/code policy before anything was sent. The
   * tools pre-check the same policy for a friendlier message; this is the
   * backstop that also covers requests arriving over /peer.
   */
  | { kind: "policy-blocked"; reason: string };

export interface Bridge {
  readonly address: string;
  /** Dispatches a console command to the game client and waits for its result. */
  send(command: string, timeoutMs: number): Promise<SendOutcome>;
  /** Sends a Lua snippet to the game client for load() + pcall(). */
  runCode(code: string, timeoutMs: number): Promise<SendOutcome>;
  /**
   * Async because a peer has to ask the host — a synchronous answer could only
   * be stale.
   */
  getStatus(): Promise<BridgeStatus>;
  close(): Promise<void>;
}
