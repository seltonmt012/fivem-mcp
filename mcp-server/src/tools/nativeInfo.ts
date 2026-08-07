import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Bridge } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import {
  formatSignature,
  isClientCapable,
  type NativeCatalog,
  type NativeEntry,
} from "../natives/catalog.js";
import { LUA_IDENTIFIER } from "../security/nativeCheck.js";
import { probeNatives, text } from "./support.js";

/** Long native descriptions are worth having, but not in full for a list of ten. */
const DESCRIPTION_LIMIT = 700;

export function registerNativeInfo(
  server: McpServer,
  bridge: Bridge,
  config: Config,
  catalog: NativeCatalog,
): void {
  server.registerTool(
    "fivem_native_info",
    {
      title: "Look up FiveM natives",
      description:
        "Looks a native up in the FiveM native reference and reports its exact runtime " +
        "spelling, parameters, return type, namespace and whether it is client- or " +
        "server-side. Accepts the Lua name (SetEntityCoords), the reference name " +
        "(SET_ENTITY_COORDS) or a hash (0x06843DA7060A026B); anything that is not an exact " +
        "match is treated as a keyword search.\n\n" +
        "Use this before writing a snippet whenever you are not certain a native exists or " +
        "what it takes -- guessing a plausible-looking name is the most common way for " +
        "fivem_run_code to fail. By default each result is also probed against the connected " +
        "client, which is the only way to tell a documented native apart from one this game " +
        "build actually exposes.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Native name, reference name, hash, or keywords to search for " +
              '(e.g. "SetEntityCoords", "GET_GROUND_Z", "0xF166E48407BAC484", "ped health").',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(25)
          .optional()
          .describe("Maximum number of results for a keyword search (default 8)."),
        probeClient: z
          .boolean()
          .optional()
          .describe(
            "Ask the connected client whether each result actually exists in this build " +
              `(default ${config.natives.probeClient}).`,
          ),
      },
    },
    async ({ query, limit, probeClient }) => {
      const trimmed = query.trim();
      const max = limit ?? 8;

      const exact = resolveExact(catalog, trimmed);
      const results = exact ? [exact] : catalog.search(trimmed, max);

      if (results.length === 0) {
        const suggestions = catalog.suggest(trimmed, 8);
        return text(
          `Nothing in the native reference matches "${trimmed}" (index: ${catalog.size} natives, ` +
            `generated ${catalog.generatedAt}).` +
            (suggestions.length > 0 ? `\n\nClosest names: ${suggestions.join(", ")}` : ""),
          true,
        );
      }

      const wantsProbe = probeClient ?? config.natives.probeClient;
      // probeNatives declines when code.enabled is false -- probing is an eval
      // in the game client, and the operator turned those off.
      const live = wantsProbe
        ? await probeNatives(bridge, config, results.map((entry) => entry.lua))
        : null;
      const probeNote =
        wantsProbe && !config.code.enabled
          ? "\n\n(The connected client was not probed: code.enabled is false, so this is the reference only.)"
          : "";

      // Examples are long. Worth it for the one native the caller asked about,
      // noise in a list of eight.
      const blocks = results.map((entry) =>
        render(entry, live?.get(entry.lua), results.length === 1),
      );

      // A query shaped like a native *name* that did not resolve is a different
      // answer from a keyword search: the name itself is the news. The camelCase
      // hump is what separates the two -- "health" and "GET_GROUND_Z" are
      // searches, "SetControlValueNextFrame" is a name that does not exist.
      const looksLikeName = !exact && LUA_IDENTIFIER.test(trimmed) && /[a-z][A-Z]/.test(trimmed);
      const head = exact
        ? ""
        : looksLikeName
          ? `"${trimmed}" is not a native -- nothing in the reference goes by that name. ` +
            "Closest matches:\n\n"
          : `${results.length} match${results.length === 1 ? "" : "es"} for "${trimmed}"` +
            (results.length === max ? " (more may exist; narrow the query)" : "") +
            "\n\n";

      // Not an MCP error even for a name miss: the closest matches ARE the
      // useful answer, and this tool is the documented recovery path.
      return text(head + blocks.join("\n\n") + probeNote);
    },
  );
}

/** Exact hits, in the order a caller is most likely to mean them. */
function resolveExact(catalog: NativeCatalog, query: string): NativeEntry | null {
  if (/^0[xX][0-9a-fA-F]+$/.test(query)) {
    const byHash = catalog.findByHash(query);
    if (byHash) return byHash;
  }
  return catalog.find(query) ?? catalog.findLoose(query) ?? null;
}

function render(entry: NativeEntry, live: boolean | undefined, withExamples: boolean): string {
  const lines = [formatSignature(entry)];

  const facts = [`${entry.ns}`, entry.hash, entry.apisets.join(" + ")];
  if (entry.ref && entry.ref !== entry.lua) facts.push(`reference name ${entry.ref}`);
  if (entry.ref === null) facts.push("hash-only, no documented name");
  lines.push(`  ${facts.join(" · ")}`);

  if (live === true) lines.push("  present in the connected client");
  if (live === false) {
    lines.push(
      !isClientCapable(entry)
        ? "  NOT present in the connected client (server-side native; snippets run client-side)"
        : "  NOT present in the connected client -- documented, but this game build does not " +
          "expose it. Calling it will fail.",
    );
  }

  if (entry.aliases && entry.aliases.length > 0) {
    lines.push(`  also callable as: ${entry.aliases.join(", ")}`);
  }

  if (entry.desc) {
    const description =
      entry.desc.length > DESCRIPTION_LIMIT
        ? `${entry.desc.slice(0, DESCRIPTION_LIMIT)}…`
        : entry.desc;
    lines.push(...description.split("\n").map((line) => `  ${line}`));
  }

  for (const param of entry.params) {
    if (param.d) lines.push(`  @${param.n}: ${param.d}`);
  }
  if (entry.returns) lines.push(`  returns: ${entry.returns}`);

  const examples = entry.examples ?? [];
  if (examples.length > 0) {
    if (withExamples) {
      for (const example of examples) {
        lines.push(`  example (${example.lang}):`);
        lines.push(...example.code.split("\n").map((line) => `    ${line}`));
      }
    } else {
      lines.push(`  has ${examples.length} example${examples.length === 1 ? "" : "s"} -- ` +
        `look it up by name to see them`);
    }
  }

  return lines.join("\n");
}
