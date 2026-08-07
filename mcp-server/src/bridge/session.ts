import type { ResultMessage } from "./protocol.js";

/** Sliding-window limiter for outbound commands. */
export class RateLimiter {
  private readonly windowMs = 60_000;
  private readonly hits: number[] = [];

  constructor(private readonly limit: number) {}

  /** Records a hit and returns true, or returns false when the window is full. */
  tryConsume(): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    while (this.hits.length > 0 && (this.hits[0] ?? 0) <= cutoff) {
      this.hits.shift();
    }
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }

  /** Forgets the spent window, so a new game session starts with a full budget. */
  reset(): void {
    this.hits.length = 0;
  }

  get limitPerMinute(): number {
    return this.limit;
  }
}

interface PendingResolution {
  ok: boolean;
  data?: unknown;
  error?: string;
  roundTripMs: number;
}

export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`No result from the bridge within ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
  }
}

export class BridgeGoneError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BridgeGoneError";
  }
}

interface PendingEntry {
  resolve: (value: PendingResolution) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  sentAt: number;
}

/**
 * Correlates outbound `command` messages with inbound `result` messages by id,
 * and guarantees every caller settles — on result, on timeout, or when the
 * session disappears.
 */
export class PendingRequests {
  private readonly entries = new Map<string, PendingEntry>();

  wait(id: string, timeoutMs: number): Promise<PendingResolution> {
    return new Promise<PendingResolution>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.entries.delete(id);
        reject(new RequestTimeoutError(timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.entries.set(id, { resolve, reject, timer, sentAt: Date.now() });
    });
  }

  /** Returns false when the id is unknown (late or duplicated result). */
  settle(message: ResultMessage): boolean {
    const entry = this.entries.get(message.id);
    if (!entry) return false;
    this.entries.delete(message.id);
    clearTimeout(entry.timer);
    entry.resolve({
      ok: message.ok,
      data: message.data,
      error: message.error,
      roundTripMs: Date.now() - entry.sentAt,
    });
    return true;
  }

  /** Fails everything still in flight, e.g. when the socket closes. */
  rejectAll(reason: string): void {
    for (const [id, entry] of this.entries) {
      this.entries.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new BridgeGoneError(reason));
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
