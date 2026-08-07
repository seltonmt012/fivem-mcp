import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Config } from "../config.js";
import { NuiDevtools, NuiDevtoolsUnavailable, type CdpSession, type NuiFrame } from "../nui/devtools.js";
import { image, text } from "./support.js";

/**
 * NUI debugging through FiveM's CEF DevTools endpoint. The read-only pair
 * (frames, snapshot) is always registered; click and eval are code execution
 * with the same reach as the NUI page itself -- they can trigger that
 * resource's NUI callbacks -- so they ride the same code.enabled flag as
 * fivem_run_code.
 */

/**
 * The DOM outline walker, evaluated in an isolated world so it works whatever
 * the page's own JavaScript state is. Caps mirror the Lua sanitize(): the
 * outline is for orientation, not for archiving the DOM.
 */
const SNAPSHOT_SCRIPT = `(() => {
  const MAX_NODES = 350, MAX_TEXT = 80, MAX_DEPTH = 12;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'NOSCRIPT', 'TEMPLATE']);
  const CLICK_TAGS = new Set(['A', 'BUTTON', 'SELECT', 'TEXTAREA', 'LABEL']);
  const lines = [];
  let count = 0, truncated = false;

  const describe = (el) => {
    let d = el.tagName.toLowerCase();
    if (el.id) d += '#' + el.id;
    if (el.classList && el.classList.length) d += '.' + [...el.classList].slice(0, 4).join('.');
    if (el.tagName === 'INPUT') d += '[type=' + (el.type || 'text') + ']';
    let clickable = CLICK_TAGS.has(el.tagName) || el.tagName === 'INPUT' ||
      typeof el.onclick === 'function' || el.hasAttribute('onclick') ||
      el.getAttribute('role') === 'button';
    if (!clickable) {
      try { clickable = getComputedStyle(el).cursor === 'pointer'; } catch {}
    }
    const own = [...el.childNodes]
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim())
      .filter(Boolean)
      .join(' ');
    let line = d;
    if (own) line += ' "' + (own.length > MAX_TEXT ? own.slice(0, MAX_TEXT) + '…' : own) + '"';
    if (clickable) line += ' [clickable]';
    try {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') line += ' [hidden]';
    } catch {}
    return line;
  };

  const walk = (el, depth) => {
    if (count >= MAX_NODES) { truncated = true; return; }
    if (SKIP.has(el.tagName)) return;
    count += 1;
    lines.push('  '.repeat(depth) + describe(el));
    if (depth >= MAX_DEPTH) return;
    for (const child of el.children) walk(child, depth + 1);
  };

  if (document.body) walk(document.body, 0);
  else lines.push('(the frame has no <body> yet)');
  if (truncated) lines.push('… outline capped at ' + MAX_NODES + ' nodes');
  return lines.join('\\n');
})()`;

/** Collects clickable candidates, for the click tool's miss answer. */
const CANDIDATES_SCRIPT = `(() => {
  const out = [];
  for (const el of document.querySelectorAll(
    'a, button, input, select, textarea, [onclick], [role="button"]'
  )) {
    if (out.length >= 30) break;
    let sel = el.tagName.toLowerCase();
    if (el.id) sel += '#' + el.id;
    else if (el.classList.length) sel += '.' + [...el.classList].slice(0, 3).join('.');
    const label = (el.textContent || el.value || '').trim().slice(0, 60);
    out.push(sel + (label ? ' -- "' + label + '"' : ''));
  }
  return out;
})()`;

function clickScript(selector: string): string {
  return `((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { ok: false, candidates: ${CANDIDATES_SCRIPT} };
    const label = (el.textContent || el.value || '').trim().slice(0, 80);
    el.click();
    return { ok: true, clicked: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), label };
  })(${JSON.stringify(selector)})`;
}

const RESOURCE_INPUT = z
  .string()
  .min(1)
  .describe('The resource owning the NUI frame, e.g. "ffa". fivem_nui_frames lists them.');

/**
 * Resolves the context to evaluate in. Main world sees the page's own
 * functions and dispatches through its real event handlers; the isolated
 * world always exists and is the reliable DOM-only path.
 */
async function contextFor(
  session: CdpSession,
  frame: NuiFrame,
  world: "main" | "isolated",
): Promise<number> {
  if (world === "isolated") return session.isolatedWorldContext(frame.frameId);
  const context = await session.mainWorldContext(frame.frameId);
  if (context === null) {
    throw new NuiDevtoolsUnavailable(
      "DevTools announced no main-world execution context for that frame. Retry, or use " +
        'world: "isolated" -- it always exists, but only sees the DOM, not the page\'s own ' +
        "JavaScript.",
    );
  }
  return context;
}

function asToolError(err: unknown) {
  if (err instanceof NuiDevtoolsUnavailable) return text(err.message, true);
  return text(`The NUI DevTools call failed: ${err instanceof Error ? err.message : String(err)}`, true);
}

export function registerNuiTools(server: McpServer, config: Config): void {
  const devtools = new NuiDevtools(config);

  server.registerTool(
    "fivem_nui_frames",
    {
      title: "List the game's NUI frames",
      description:
        "Lists every NUI (CEF) frame the running game client has, with the resource that owns " +
        "it and its URL -- the starting point for the other fivem_nui_* tools. Read-only; " +
        "needs the game running, nothing else.",
      inputSchema: {},
    },
    async () => {
      try {
        const frames = await devtools.listFrames();
        const resourceFrames = frames.filter((frame) => frame.resource !== null);
        const lines = [
          `${resourceFrames.length} resource NUI frame(s) (${frames.length} frame(s) total):`,
          "",
          ...frames.map(
            (frame) =>
              `  ${frame.resource ?? "(not a resource frame)"} -- ${frame.url || "(no url)"}`,
          ),
        ];
        return text(lines.join("\n"));
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "fivem_nui_snapshot",
    {
      title: "Outline a resource's NUI page",
      description:
        "Returns a compact DOM outline of a resource's NUI frame -- tags, ids, classes, " +
        "visible text, and which elements are clickable -- optionally plus a screenshot of " +
        "the NUI layer itself. The screenshot shows only the UI (transparent where the page " +
        "draws nothing), never the game or anything else on screen, so it is the " +
        "privacy-safe way to look at a UI. Read-only.",
      inputSchema: {
        resource: RESOURCE_INPUT,
        screenshot: z
          .boolean()
          .optional()
          .describe("Also capture a PNG of the NUI layer (default false)."),
      },
    },
    async ({ resource, screenshot }) => {
      try {
        return await devtools.withResourceFrame(resource, async (session, frame) => {
          const contextId = await contextFor(session, frame, "isolated");
          const outline = await session.evaluate<string>(SNAPSHOT_SCRIPT, contextId);
          const caption = `NUI frame of "${resource}" (${frame.url}):\n\n${outline}`;
          if (screenshot) {
            const data = await session.captureScreenshot();
            return image(data, "image/png", caption);
          }
          return text(caption);
        });
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  if (!config.code.enabled) {
    // Click and eval are code execution in the page; the operator turned that off.
    return;
  }

  server.registerTool(
    "fivem_nui_click",
    {
      title: "Click an element in a resource's NUI page",
      description:
        "Clicks an element in a resource's NUI frame by CSS selector, dispatching through " +
        "the page's real event handlers -- exactly what a mouse click on the UI does, " +
        "without OS-level input. Use fivem_nui_snapshot first to see what is there. When " +
        "the selector matches nothing, the answer lists the clickable elements the frame " +
        "actually has.",
      inputSchema: {
        resource: RESOURCE_INPUT,
        selector: z
          .string()
          .min(1)
          .describe('CSS selector of the element to click, e.g. ".arena .join" or "#startBtn".'),
      },
    },
    async ({ resource, selector }) => {
      try {
        return await devtools.withResourceFrame(resource, async (session, frame) => {
          const contextId = await contextFor(session, frame, "main");
          const result = await session.evaluate<{
            ok: boolean;
            clicked?: string;
            label?: string;
            candidates?: string[];
          }>(clickScript(selector), contextId);

          if (!result?.ok) {
            const candidates = result?.candidates ?? [];
            return text(
              `Nothing in "${resource}"'s frame matches ${JSON.stringify(selector)}.` +
                (candidates.length > 0
                  ? `\n\nClickable elements in the frame right now:\n${candidates
                      .map((candidate) => `  ${candidate}`)
                      .join("\n")}`
                  : "\n\nThe frame currently has no clickable elements at all."),
              true,
            );
          }
          return text(
            `Clicked ${result.clicked}${result.label ? ` ("${result.label}")` : ""} in ` +
              `"${resource}"'s NUI frame. Verify the effect with fivem_nui_snapshot, ` +
              "fivem_read_log, or the server console.",
          );
        });
      } catch (err) {
        return asToolError(err);
      }
    },
  );

  server.registerTool(
    "fivem_nui_eval",
    {
      title: "Run JavaScript in a resource's NUI page",
      description:
        "Evaluates a JavaScript expression in a resource's NUI frame and returns its value. " +
        'world: "main" (default) runs alongside the page\'s own code -- its functions and ' +
        'state are callable directly; world: "isolated" runs in a separate world that sees ' +
        "the DOM but not the page's JavaScript, and always exists. Promises are awaited. " +
        "This has the same reach as the page itself, including its NUI callbacks to the " +
        "game client.",
      inputSchema: {
        resource: RESOURCE_INPUT,
        code: z
          .string()
          .min(1)
          .describe(
            "JavaScript expression to evaluate, e.g. " +
              '"document.querySelectorAll(\'.arena\').length" or "window.updateScores([])".',
          ),
        world: z
          .enum(["main", "isolated"])
          .optional()
          .describe('Which execution world to evaluate in (default "main").'),
      },
    },
    async ({ resource, code, world }) => {
      try {
        return await devtools.withResourceFrame(resource, async (session, frame) => {
          const contextId = await contextFor(session, frame, world ?? "main");
          try {
            const value = await session.evaluate(code, contextId);
            return text(
              value === undefined
                ? "The expression evaluated to undefined."
                : `Evaluated:\n${JSON.stringify(value, null, 2)}`,
            );
          } catch (err) {
            if (err instanceof NuiDevtoolsUnavailable) throw err;
            return text(
              `The page threw: ${err instanceof Error ? err.message : String(err)}`,
              true,
            );
          }
        });
      } catch (err) {
        return asToolError(err);
      }
    },
  );
}
