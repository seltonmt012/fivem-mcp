/**
 * Static NUI bootstrap -- the JavaScript counterpart of client/loader.lua.
 *
 * This is the only script that ships to every client, and it holds no bridge
 * logic. It polls a NUI callback the loader registers at resource start, which
 * answers `ready = false` until the server has delivered the payload to this
 * client. On a player who is not on the developer list, that is all this file
 * ever does.
 */
(() => {
  "use strict";

  const RESOURCE = window.location.hostname.replace(/^cfx-nui-/, "");
  const POLL_MIN_MS = 1000;
  const POLL_MAX_MS = 5000;

  let pollDelay = POLL_MIN_MS;
  let pollTimer = null;
  let running = false;
  /** True while a poll's fetch is in flight, so two polls can never overlap. */
  let polling = false;
  /**
   * Bumped by every dispose. A poll that was already in flight when the dispose
   * arrived would otherwise install the pre-dispose payload -- and, because it
   * sets `running`, stop polling with that stale bridge pinned in place.
   */
  let generation = 0;

  /**
   * Returns the payload, or null for "not ready yet". The callback is always
   * registered, but a request can still fail while the resource is starting, so
   * a failed request, an empty body and unparseable JSON are treated the same
   * way as an honest `ready = false`.
   */
  async function fetchBoot() {
    const response = await fetch(`https://${RESOURCE}/fivemMcpBoot`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: "{}",
    });
    if (!response.ok) return null;

    const text = await response.text();
    if (!text) return null;

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return null;
    }

    if (!payload || payload.ready !== true) return null;
    if (typeof payload.code !== "string" || payload.code === "") return null;
    return payload;
  }

  function schedulePoll() {
    // No timer while a poll is in flight either: when that poll finishes it
    // schedules the next one itself, so no wakeup is lost.
    if (pollTimer !== null || running || polling) return;
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      void poll();
    }, pollDelay);
    pollDelay = Math.min(Math.round(pollDelay * 1.5), POLL_MAX_MS);
  }

  async function poll() {
    if (running || polling) return;
    polling = true;
    const startedGeneration = generation;

    let payload = null;
    try {
      payload = await fetchBoot();
    } catch {
      payload = null;
    }

    polling = false;

    if (startedGeneration !== generation) {
      // A dispose arrived while the fetch was in flight: whatever it returned
      // belongs to the previous payload. Ask again for the current one.
      schedulePoll();
      return;
    }

    if (!payload) {
      schedulePoll();
      return;
    }

    try {
      // The delivered code is expected to publish window.__fivemMcp = { dispose }.
      new Function("config", payload.code)(payload.config ?? {});
      running = true;
      pollDelay = POLL_MIN_MS;
    } catch (err) {
      console.error(`[fivem-mcp] the delivered bridge code failed to run: ${err}`);
      schedulePoll();
    }
  }

  /** Sent by the payload's dispose() just before a hot reload. */
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.type !== "fivem-mcp:dispose") return;

    const active = window.__fivemMcp;
    window.__fivemMcp = undefined;
    running = false;
    generation += 1;

    if (active && typeof active.dispose === "function") {
      try {
        active.dispose();
      } catch (err) {
        console.warn(`[fivem-mcp] dispose failed: ${err}`);
      }
    }

    // Pick the replacement up as soon as it registers its callback.
    pollDelay = POLL_MIN_MS;
    schedulePoll();
  });

  void poll();
})();
