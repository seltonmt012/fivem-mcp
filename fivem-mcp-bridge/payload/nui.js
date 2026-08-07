/**
 * The real NUI bridge. Never shipped with the resource -- the server sends this
 * to authorized developers, where nui/boot.js runs it via new Function().
 *
 * Receives `config` ({ url, token, resource }) from boot.js and must publish
 * window.__fivemMcp = { dispose } so a hot reload can tear it down.
 *
 * Protocol v1 -- see mcp-server/README.md for the full message table.
 */
(() => {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const RECONNECT_MIN_MS = 1000;
  const RECONNECT_MAX_MS = 15000;
  /** CloseCode.UNAUTHORIZED in mcp-server/src/bridge/protocol.ts. */
  const CLOSE_UNAUTHORIZED = 4001;

  const RESOURCE = config.resource || window.location.hostname.replace(/^cfx-nui-/, "");
  // No fallback URL: the server always supplies Config.bridgeUrl, and a silent
  // default would only mask a delivery bug. connect() refuses an unusable one.
  const BRIDGE_URL = typeof config.url === "string" ? config.url : "";
  const TOKEN = config.token || "";

  /**
   * The bridge lives on the developer's own machine by definition. Refusing
   * anything but a loopback ws:// URL means a hostile or compromised FiveM
   * server cannot point this socket -- and the token in its hello frame -- at
   * an arbitrary endpoint.
   */
  function isLoopbackWsUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (url.protocol !== "ws:") return false;
    const host = url.hostname;
    return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  }

  let socket = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let disposed = false;

  async function nuiCallback(name, body) {
    const response = await fetch(`https://${RESOURCE}/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body ?? {}),
    });
    if (!response.ok) {
      throw new Error(`NUI callback "${name}" returned HTTP ${response.status}`);
    }
    return response.json();
  }

  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message));
    }
  }

  function report(message) {
    // Visible in the NUI devtools and, via bridgeLog, in the game console.
    console.warn(`[fivem-mcp] ${message}`);
    nuiCallback("bridgeLog", { message }).catch(() => {});
  }

  /**
   * Hands a request to the Lua side and answers with a `result` either way --
   * the server correlates by id, so a request that never settles would sit in
   * its pending map until it times out.
   */
  async function forward(id, callbackName, body) {
    let result;
    try {
      const answer = await nuiCallback(callbackName, body);
      result = {
        t: "result",
        id,
        ok: answer.ok !== false,
        data: answer.data,
        error: answer.error,
      };
    } catch (err) {
      result = { t: "result", id, ok: false, error: String(err) };
    }
    send(result);
  }

  function scheduleReconnect() {
    if (disposed || reconnectTimer !== null) return;
    reconnectTimer = window.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  function connect() {
    if (disposed) return;

    // An empty token means this payload was delivered while bridge.token was
    // missing on the FiveM server. Opening the socket would only earn a 4001,
    // so ask for a payload that carries a real token instead -- and keep the
    // retry alive, because giving up here is unrecoverable without a reload.
    if (!TOKEN) {
      report("No token was delivered, asking the server for a payload that has one");
      nuiCallback("bridgeReauth", {}).catch(() => {});
      reconnectDelay = RECONNECT_MAX_MS;
      scheduleReconnect();
      return;
    }

    // No retry here: the URL is frozen into this payload, so reconnecting
    // cannot fix it. A corrected config.lua arrives with the next delivery,
    // which replaces this bridge wholesale.
    if (!isLoopbackWsUrl(BRIDGE_URL)) {
      report(`Refusing to connect: bridge URL is not a loopback ws:// address (${BRIDGE_URL || "missing"})`);
      return;
    }

    if (socket) {
      // A connect() while an older socket is still around (however unlikely)
      // must not leak it -- and its close event must not null the new one.
      const superseded = socket;
      socket = null;
      try {
        superseded.close(1000, "superseded");
      } catch {
        /* already closing */
      }
    }

    const ws = new WebSocket(BRIDGE_URL);
    socket = ws;

    ws.addEventListener("open", () => {
      send({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        token: TOKEN,
        resource: RESOURCE,
        client: "nui",
      });
    });

    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      switch (message.t) {
        case "welcome":
          reconnectDelay = RECONNECT_MIN_MS;
          send({ t: "log", level: "info", message: `NUI bridge ready in ${RESOURCE}` });
          break;
        case "ping":
          send({ t: "pong", id: message.id });
          break;
        case "command":
          void forward(message.id, "execCommand", { command: message.command });
          break;
        case "eval":
          void forward(message.id, "evalCode", { code: message.code });
          break;
        default:
          break;
      }
    });

    ws.addEventListener("close", (event) => {
      // Only the socket that currently owns the bridge may clear the slot and
      // reconnect; a stale close would otherwise null the live socket.
      if (socket !== ws) return;
      socket = null;
      if (disposed) return;

      // 4001/4003/4004 are configuration problems that reconnecting will not
      // fix, but keep retrying slowly so a corrected config recovers on its
      // own. 4009 means another game client owns the bridge: retrying fast
      // would just make the two clients replace each other forever.
      if ((event.code >= 4001 && event.code <= 4004) || event.code === 4009) {
        report(`Bridge refused the connection (code ${event.code}: ${event.reason || "no reason"})`);
        reconnectDelay = RECONNECT_MAX_MS;
      }

      // 4001 means the token is wrong, and TOKEN was frozen into this payload
      // when the FiveM server delivered it. The MCP server generates a new one
      // whenever bridge.token is absent, so a payload handed out before that
      // can never authenticate again, no matter how long it reconnects. Ask the
      // loader to fetch a fresh payload; it re-reads the file from the server.
      if (event.code === CLOSE_UNAUTHORIZED) {
        nuiCallback("bridgeReauth", {}).catch(() => {});
      }

      scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // The close handler runs right after and owns the reconnect.
    });
  }

  window.__fivemMcp = {
    dispose() {
      disposed = true;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        const closing = socket;
        socket = null;
        try {
          closing.close(1000, "payload reloaded");
        } catch {
          /* already closing */
        }
      }
    },
  };

  connect();
})();
