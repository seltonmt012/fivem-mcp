import WebSocket from "ws";

import type { Config } from "../config.js";

/**
 * Minimal Chrome DevTools Protocol client for FiveM's CEF remote-debugging
 * endpoint -- the officially documented NUI debugging port (13172).
 *
 * Deliberately connectionless at the tool level: every tool call discovers the
 * targets over HTTP, opens one WebSocket session, does its work and closes.
 * On loopback that costs a few tens of milliseconds and buys freedom from every
 * staleness bug a cached session invites (the game restarting, CEF recreating
 * its targets on every NUI reload).
 *
 * Two target models exist in the wild and both are handled: all NUI frames as
 * iframes of one root target, or resource frames as separate targets. Frames
 * are mapped to resources by URL -- nui://<resource>/... or
 * https://cfx-nui-<resource>/... -- via Page.getFrameTree per target.
 */

export class NuiDevtoolsUnavailable extends Error {}

export interface NuiFrame {
  /** Owning resource, or null when the URL is not a NUI resource URL. */
  resource: string | null;
  frameId: string;
  url: string;
  /** The target whose session reaches this frame. */
  targetWsUrl: string;
}

interface CdpTarget {
  id?: string;
  type?: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

const RESOURCE_URL = /^(?:nui:\/\/|https?:\/\/cfx-nui-)([^/.:]+)/i;

export function resourceOfUrl(url: string): string | null {
  return RESOURCE_URL.exec(url)?.[1]?.toLowerCase() ?? null;
}

interface FrameTreeNode {
  frame: { id: string; url: string };
  childFrames?: FrameTreeNode[];
}

/** One WebSocket CDP session against one target. */
export class CdpSession {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  /** frameId -> main-world execution context id, from executionContextCreated. */
  readonly mainWorldContexts = new Map<string, number>();

  private constructor(
    private readonly ws: WebSocket,
    private readonly timeoutMs: number,
  ) {
    ws.on("message", (raw) => this.onMessage(String(raw)));
    ws.on("close", () => this.failAll(new Error("the DevTools connection closed")));
    ws.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))));
  }

  static connect(wsUrl: string, timeoutMs: number): Promise<CdpSession> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { handshakeTimeout: timeoutMs });
      const timer = setTimeout(
        () => reject(new NuiDevtoolsUnavailable(`DevTools did not accept the session within ${timeoutMs} ms`)),
        timeoutMs,
      );
      ws.once("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(ws, timeoutMs));
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(new NuiDevtoolsUnavailable(`DevTools session failed: ${err.message}`));
      });
    });
  }

  private onMessage(raw: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: { context?: { id?: number; auxData?: { frameId?: string; isDefault?: boolean } } };
      result?: unknown;
      error?: { message?: string };
    };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? "DevTools call failed"));
      else waiter.resolve(msg.result);
      return;
    }

    if (msg.method === "Runtime.executionContextCreated") {
      const context = msg.params?.context;
      const frameId = context?.auxData?.frameId;
      if (context?.id !== undefined && frameId && context.auxData?.isDefault) {
        this.mainWorldContexts.set(frameId, context.id);
      }
    }
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, ...(params ? { params } : {}) });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new NuiDevtoolsUnavailable(`DevTools did not answer ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  /** Enables Page + Runtime, which also replays the existing execution contexts. */
  async prepare(): Promise<void> {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  async frameTree(): Promise<Array<{ frameId: string; url: string }>> {
    const result = await this.send<{ frameTree?: FrameTreeNode }>("Page.getFrameTree");
    const out: Array<{ frameId: string; url: string }> = [];
    const walk = (node: FrameTreeNode | undefined) => {
      if (!node?.frame) return;
      out.push({ frameId: node.frame.id, url: node.frame.url });
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(result.frameTree);
    return out;
  }

  /**
   * The main-world execution context of a frame. Contexts are announced by
   * Runtime.enable, but the replay races the enable response -- so poll
   * briefly instead of concluding "no context" from a cold cache.
   */
  async mainWorldContext(frameId: string, deadlineMs = 1_500): Promise<number | null> {
    const startedAt = Date.now();
    for (;;) {
      const context = this.mainWorldContexts.get(frameId);
      if (context !== undefined) return context;
      if (Date.now() - startedAt >= deadlineMs) return null;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async isolatedWorldContext(frameId: string): Promise<number> {
    const result = await this.send<{ executionContextId?: number }>("Page.createIsolatedWorld", {
      frameId,
      worldName: "fivem-mcp",
    });
    if (typeof result.executionContextId !== "number") {
      throw new NuiDevtoolsUnavailable("DevTools created no isolated world for that frame");
    }
    return result.executionContextId;
  }

  /**
   * Runtime.evaluate with the sharp edges pre-handled: values come back by
   * value, promises are awaited, and an exception is surfaced as an Error with
   * the page's own message.
   */
  async evaluate<T = unknown>(expression: string, contextId: number): Promise<T> {
    const result = await this.send<{
      result?: { value?: unknown; type?: string; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      contextId,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "the page threw";
      throw new Error(detail);
    }
    return result.result?.value as T;
  }

  async captureScreenshot(): Promise<string> {
    const result = await this.send<{ data?: string }>("Page.captureScreenshot", {
      format: "png",
    });
    if (!result.data) throw new NuiDevtoolsUnavailable("DevTools returned no screenshot data");
    return result.data;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this.failAll(new Error("session closed"));
  }

  private failAll(err: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(err);
    this.pending.clear();
  }
}

export class NuiDevtools {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(config: Config) {
    this.endpoint = config.nui.devtoolsEndpoint;
    this.timeoutMs = config.nui.timeoutMs;
  }

  private async targets(): Promise<CdpTarget[]> {
    let response: Response;
    try {
      response = await fetch(`http://${this.endpoint}/json/list`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new NuiDevtoolsUnavailable(
        `Could not reach FiveM's NUI DevTools at http://${this.endpoint} ` +
          `(${err instanceof Error ? err.message : String(err)}). The game is probably not ` +
          "running -- start it with fivem_launch. If it IS running, this build may gate the " +
          "DevTools port; nui.devtoolsEndpoint in fivem-mcp.config.json names the port to probe.",
      );
    }
    if (!response.ok) {
      throw new NuiDevtoolsUnavailable(
        `The DevTools endpoint at http://${this.endpoint} answered HTTP ${response.status}.`,
      );
    }
    const targets = (await response.json()) as CdpTarget[];
    return targets.filter(
      (target) =>
        (target.type === "page" || target.type === "iframe") && target.webSocketDebuggerUrl,
    );
  }

  /**
   * Every NUI frame across every debuggable target. Non-resource frames (the
   * CEF root page, chrome:// pages) come along with resource: null so the
   * answer shows the whole picture.
   */
  async listFrames(): Promise<NuiFrame[]> {
    const targets = await this.targets();
    if (targets.length === 0) {
      throw new NuiDevtoolsUnavailable(
        `DevTools at http://${this.endpoint} lists no debuggable pages. The game may still ` +
          "be starting, or no NUI has been created yet.",
      );
    }

    const frames: NuiFrame[] = [];
    const seen = new Set<string>();
    for (const target of targets) {
      const wsUrl = target.webSocketDebuggerUrl as string;
      let session: CdpSession | null = null;
      try {
        session = await CdpSession.connect(wsUrl, this.timeoutMs);
        await session.prepare();
        for (const frame of await session.frameTree()) {
          if (seen.has(frame.frameId)) continue;
          seen.add(frame.frameId);
          frames.push({
            resource: resourceOfUrl(frame.url),
            frameId: frame.frameId,
            url: frame.url,
            targetWsUrl: wsUrl,
          });
        }
      } catch {
        // A target that vanished between /json/list and the attach; skip it.
      } finally {
        session?.close();
      }
    }
    return frames;
  }

  /**
   * Opens a session on the target owning `resource`'s frame and hands both to
   * the callback. Closing is handled here, whatever the callback does.
   */
  async withResourceFrame<T>(
    resource: string,
    fn: (session: CdpSession, frame: NuiFrame) => Promise<T>,
  ): Promise<T> {
    const frames = await this.listFrames();
    const wanted = resource.toLowerCase();
    const frame = frames.find((candidate) => candidate.resource === wanted);
    if (!frame) {
      const known = [...new Set(frames.map((f) => f.resource).filter(Boolean))] as string[];
      throw new NuiDevtoolsUnavailable(
        `No NUI frame belongs to resource "${resource}". ` +
          (known.length > 0
            ? `Resources with a NUI frame right now: ${known.join(", ")}.`
            : "No resource frames exist right now -- has the resource created its NUI page?"),
      );
    }

    const session = await CdpSession.connect(frame.targetWsUrl, this.timeoutMs);
    try {
      await session.prepare();
      return await fn(session, frame);
    } finally {
      session.close();
    }
  }
}
