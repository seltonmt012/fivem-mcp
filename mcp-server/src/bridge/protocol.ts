import { z } from "zod";

import type { BridgeStatus, SendOutcome } from "./bridge.js";

/** Bumped whenever the message shapes below change incompatibly. */
export const PROTOCOL_VERSION = 1;

export const CloseCode = {
  UNAUTHORIZED: 4001,
  BAD_HANDSHAKE: 4002,
  ORIGIN_REJECTED: 4003,
  RESOURCE_REJECTED: 4004,
  REPLACED: 4009,
  HEARTBEAT_LOST: 4010,
  SHUTDOWN: 4011,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/* ------------------------------------------------------------------ *
 * client -> server
 * ------------------------------------------------------------------ */

const helloSchema = z.object({
  t: z.literal("hello"),
  protocol: z.number().int(),
  token: z.string().min(1),
  resource: z.string().min(1).max(128),
  client: z.string().max(32).optional(),
});

const resultSchema = z.object({
  t: z.literal("result"),
  id: z.string().min(1).max(128),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().max(4000).optional(),
});

const pongSchema = z.object({
  t: z.literal("pong"),
  id: z.number().int(),
});

const clientLogSchema = z.object({
  t: z.literal("log"),
  level: z.enum(["debug", "info", "warn", "error"]).optional(),
  message: z.string().max(2000),
});

const clientMessageSchema = z.discriminatedUnion("t", [
  helloSchema,
  resultSchema,
  pongSchema,
  clientLogSchema,
]);

export type HelloMessage = z.infer<typeof helloSchema>;
export type ResultMessage = z.infer<typeof resultSchema>;
export type ClientLogMessage = z.infer<typeof clientLogSchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/* ------------------------------------------------------------------ *
 * server -> client
 * ------------------------------------------------------------------ */

interface WelcomeMessage {
  t: "welcome";
  sessionId: string;
  serverVersion: string;
  protocol: number;
}

interface CommandMessage {
  t: "command";
  id: string;
  command: string;
  timeoutMs: number;
}

interface EvalMessage {
  t: "eval";
  id: string;
  code: string;
  timeoutMs: number;
}

interface PingMessage {
  t: "ping";
  id: number;
}

export type ServerMessage = WelcomeMessage | CommandMessage | EvalMessage | PingMessage;

/* ------------------------------------------------------------------ *
 * peer <-> host
 *
 * A second fivem-mcp process that finds the port taken connects to the host on
 * path /peer and proxies its three Bridge calls through these messages. Peers
 * are not sessions: they present the same hello (token + protocol checked,
 * origin and resource checks do not apply), then speak only request /
 * status-request. The host answers by calling its own send/runCode/getStatus,
 * so rate limiting and timeouts live in one place.
 * ------------------------------------------------------------------ */

const peerRequestSchema = z.object({
  t: z.literal("request"),
  id: z.string().min(1).max(128),
  kind: z.enum(["command", "eval"]),
  body: z.string(),
  // Same ceiling as every tool schema; a peer must not be able to pin a
  // pending request (and its timer) on the host for longer than a tool could.
  timeoutMs: z.number().int().min(1).max(30_000),
});

const peerStatusRequestSchema = z.object({
  t: z.literal("status-request"),
  id: z.string().min(1).max(128),
});

const peerMessageSchema = z.discriminatedUnion("t", [
  helloSchema,
  peerRequestSchema,
  peerStatusRequestSchema,
]);

export type PeerRequestMessage = z.infer<typeof peerRequestSchema>;
export type PeerMessage = z.infer<typeof peerMessageSchema>;

/**
 * The host's answer to a peer hello. `role` is the old-host guard: a host that
 * predates peers would run the NUI admission path instead and, where it accepts
 * at all, answer with a session welcome that has no role — the peer must treat
 * that as "restart the older fivem-mcp" rather than act as the game session.
 */
interface PeerWelcomeMessage {
  t: "welcome";
  role: "peer";
  serverVersion: string;
  protocol: number;
}

interface PeerResponseMessage {
  t: "response";
  id: string;
  outcome: SendOutcome;
}

interface PeerStatusMessage {
  t: "status";
  id: string;
  status: BridgeStatus;
}

export type HostToPeerMessage = PeerWelcomeMessage | PeerResponseMessage | PeerStatusMessage;

const sendOutcomeSchema: z.ZodType<SendOutcome> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ok"), data: z.unknown(), roundTripMs: z.number() }),
  z.object({ kind: z.literal("resource-error"), error: z.string(), roundTripMs: z.number() }),
  z.object({ kind: z.literal("not-connected") }),
  z.object({ kind: z.literal("rate-limited"), limitPerMinute: z.number() }),
  z.object({ kind: z.literal("timeout"), timeoutMs: z.number() }),
  z.object({ kind: z.literal("disconnected"), reason: z.string() }),
  z.object({ kind: z.literal("policy-blocked"), reason: z.string() }),
]);

const bridgeStatusSchema: z.ZodType<BridgeStatus> = z.object({
  listening: z.string(),
  connected: z.boolean(),
  role: z.enum(["host", "peer", "none"]),
  peers: z.number(),
  note: z.string().nullable(),
  resource: z.string().nullable(),
  sessionId: z.string().nullable(),
  connectedSince: z.string().nullable(),
  lastRoundTripMs: z.number().nullable(),
  commandsSent: z.number(),
  pendingRequests: z.number(),
  rateLimitPerMinute: z.number(),
  recentLogs: z.array(z.string()),
});

/** `role` optional on purpose: its absence is how an old host is recognised. */
const hostToPeerSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("welcome"), role: z.literal("peer").optional() }),
  z.object({ t: z.literal("response"), id: z.string(), outcome: sendOutcomeSchema }),
  z.object({ t: z.literal("status"), id: z.string(), status: bridgeStatusSchema }),
]);

export type ParsedHostToPeer = z.infer<typeof hostToPeerSchema>;

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function parseHostToPeerMessage(raw: string): ParsedHostToPeer | null {
  const json = parseJson(raw);
  if (json === undefined) return null;
  const parsed = hostToPeerSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

type ParsedMessage<T> = { ok: true; message: T } | { ok: false; reason: string };

function parseOrExplain<T>(schema: z.ZodType<T>, raw: string, fallback: string): ParsedMessage<T> {
  const json = parseJson(raw);
  if (json === undefined) return { ok: false, reason: "payload is not valid JSON" };

  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "(root)";
    return { ok: false, reason: `${where}: ${issue?.message ?? fallback}` };
  }
  return { ok: true, message: parsed.data };
}

export type ParsedPeerMessage = ParsedMessage<PeerMessage>;

export function parsePeerMessage(raw: string): ParsedPeerMessage {
  return parseOrExplain(peerMessageSchema, raw, "not a peer message");
}

export type ParsedClientMessage = ParsedMessage<ClientMessage>;

export function parseClientMessage(raw: string): ParsedClientMessage {
  return parseOrExplain(clientMessageSchema, raw, "does not match protocol v1");
}
