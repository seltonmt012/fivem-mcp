import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { z } from "zod";

import type { Bridge } from "../bridge/bridge.js";
import type { Config } from "../config.js";
import { formatSignature, isClientCapable, type NativeCatalog } from "../natives/catalog.js";
import { scanChunk, type CallSite } from "../natives/scanCode.js";
import { checkArity, LUA_IDENTIFIER } from "../security/nativeCheck.js";
import { probeNatives, text } from "./support.js";

/**
 * Static lint for a FiveM resource on disk: manifest-aware native resolution,
 * per-file, before anything is deployed. The same catalog and scanner that gate
 * fivem_run_code snippets, pointed at a whole resource -- so a misspelled or
 * invented native surfaces here, not as a SCRIPT ERROR halfway through a
 * handler after the next restart.
 */

/** Which side a manifest entry's code runs on. */
type Side = "client" | "server" | "shared";

interface Finding {
  severity: "error" | "warning";
  line: number;
  message: string;
  suggestions?: string[];
}

interface ScannedFile {
  /** Path relative to the resource root, forward slashes. */
  rel: string;
  side: Side;
  findings: Finding[];
  calls: CallSite[];
}

/** Names a probe snippet can carry without approaching the frame ceiling. */
const PROBE_NAME_CAP = 400;

/**
 * Pulls the string values out of a manifest directive, covering both forms:
 *   client_script 'a.lua'
 *   client_scripts { 'a.lua', 'b.lua' }
 * The same parser scripts/check-resource.mjs uses, ported.
 */
function manifestEntries(manifest: string, directive: string): string[] {
  const entries: string[] = [];
  const pattern = new RegExp(`\\b${directive}\\b\\s*(\\{[^}]*\\}|'[^']*'|"[^"]*")`, "g");
  for (const match of manifest.matchAll(pattern)) {
    const block = (match[1] ?? "")
      .replace(/--\[\[[\s\S]*?\]\]/g, "")
      .replace(/--[^\n]*/g, "");
    for (const str of block.matchAll(/['"]([^'"]+)['"]/g)) {
      if (str[1]) entries.push(str[1]);
    }
  }
  return entries;
}

/** Every file under root, as forward-slash paths relative to it. */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(relative(root, full).replace(/\\/g, "/"));
    }
  };
  visit(root);
  return out;
}

/**
 * Expands one manifest entry against the resource's files. FiveM accepts glob
 * patterns here; `*` stays inside a path segment, `**` crosses them.
 */
function expandEntry(entry: string, allFiles: string[]): string[] {
  const normalised = entry.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalised.includes("*")) {
    return allFiles.includes(normalised) ? [normalised] : [];
  }
  // Placeholders keep the ** expansions from being re-processed by the * pass.
  const regex = new RegExp(
    "^" +
      normalised
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*\//g, "\u0000")
        .replace(/\*\*/g, "\u0001")
        .replace(/\*/g, "[^/]*")
        .replace(/\u0000/g, "(?:.*/)?")
        .replace(/\u0001/g, ".*") +
      "$",
  );
  return allFiles.filter((file) => regex.test(file));
}

export function registerCheckResource(
  server: McpServer,
  bridge: Bridge,
  config: Config,
  catalog: NativeCatalog | null,
): void {
  server.registerTool(
    "fivem_check_resource",
    {
      title: "Statically check a FiveM resource on disk",
      description:
        "Lints a resource folder before it is deployed: parses fxmanifest.lua, classifies " +
        "every Lua file as client, server or shared, syntax-checks each one, and resolves " +
        "every native call against the FiveM native reference with the apiset matching the " +
        "file's side -- the same check fivem_run_code applies to snippets, for a whole " +
        "resource. Functions the resource defines itself (across all its files) are never " +
        "flagged. When a game client is connected, client-side natives are additionally " +
        "probed against the running build.\n\n" +
        "Run this after writing or editing a resource and before restarting it: a misspelled " +
        "or invented native surfaces here as an error with the correct spelling, instead of " +
        "as a SCRIPT ERROR in the client log that halts the handler mid-way.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Absolute path of the resource folder (the one containing fxmanifest.lua)."),
        probeClient: z
          .boolean()
          .optional()
          .describe(
            "Ask the connected game client which client-side names actually exist " +
              "(default true; silently skipped when no client is connected).",
          ),
      },
    },
    async ({ path, probeClient }) => {
      const root = resolve(path);
      let manifest: string;
      try {
        manifest = readFileSync(join(root, "fxmanifest.lua"), "utf8");
      } catch (err) {
        return text(
          `${root} has no readable fxmanifest.lua (${(err as Error).message}). Point this at ` +
            "the resource folder itself, not its parent.",
          true,
        );
      }

      const allFiles = walkFiles(root);
      const notes: string[] = [];

      // Manifest order decides nothing here, but a stable order keeps the
      // report diffable. A file listed on both sides is checked as shared.
      const sides = new Map<string, Set<Side>>();
      const collect = (directives: string[], side: Side) => {
        for (const directive of directives) {
          for (const entry of manifestEntries(manifest, directive)) {
            if (entry.startsWith("@")) {
              notes.push(
                `${entry} comes from another resource and was not checked; globals it defines ` +
                  "are not visible here, so unknown-name findings may be its.",
              );
              continue;
            }
            const matched = expandEntry(entry, allFiles);
            if (matched.length === 0) {
              notes.push(`Manifest entry "${entry}" (${side}) matches no file in the resource.`);
            }
            for (const file of matched) {
              const existing = sides.get(file) ?? new Set<Side>();
              existing.add(side);
              sides.set(file, existing);
            }
          }
        }
      };
      collect(["client_script", "client_scripts"], "client");
      collect(["server_script", "server_scripts"], "server");
      collect(["shared_script", "shared_scripts"], "shared");

      if (sides.size === 0) {
        return text(
          `${basename(root)}: fxmanifest.lua lists no script files at all -- nothing to check.`,
          true,
        );
      }

      const lua54 = /\blua54\s+['"]yes['"]/.test(manifest);

      // Pass 1: parse every listed Lua file, collect its calls and every global
      // the resource defines anywhere -- so FFA-style module tables and
      // cross-file helpers are never flagged as unknown natives.
      const files: ScannedFile[] = [];
      const ownGlobals = new Set<string>();
      for (const [rel, sideSet] of sides) {
        const side: Side =
          sideSet.has("shared") || sideSet.size > 1 ? "shared" : [...sideSet][0] ?? "shared";
        if (!rel.endsWith(".lua")) {
          notes.push(`${rel} is not Lua and was only checked for existence.`);
          continue;
        }
        const file: ScannedFile = { rel, side, findings: [], calls: [] };
        files.push(file);

        let source: string;
        try {
          source = readFileSync(join(root, rel), "utf8");
        } catch (err) {
          file.findings.push({
            severity: "error",
            line: 0,
            message: `cannot be read: ${(err as Error).message}`,
          });
          continue;
        }

        const scan = scanChunk(source);
        if (!scan.ok) {
          file.findings.push({
            severity: "error",
            line: scan.line ?? 0,
            message:
              `does not parse: ${scan.error}` +
              (lua54
                ? " (the manifest enables lua54; this check parses Lua 5.3, so 5.4-only syntax " +
                  "is a false positive here)"
                : ""),
          });
          continue;
        }
        file.calls = scan.calls;
        for (const name of scan.ownGlobals) ownGlobals.add(name);
      }

      // Pass 2: resolve the remaining call sites against the catalog, side-aware.
      if (catalog === null) {
        notes.push(
          "No native index is loaded (run: npm run natives:sync), so only syntax was checked.",
        );
      }

      // One probe for everything client-visible, when a client is there to ask.
      let live: Map<string, boolean> | null = null;
      if (catalog !== null && (probeClient ?? true)) {
        const names = new Set<string>();
        for (const file of files) {
          if (file.side === "server") continue;
          for (const call of file.calls) {
            if (!ownGlobals.has(call.name) && LUA_IDENTIFIER.test(call.name)) names.add(call.name);
          }
        }
        live = await probeNatives(bridge, config, [...names].slice(0, PROBE_NAME_CAP));
      }

      for (const file of files) {
        if (catalog === null) break;
        // First line per name and distinct argument count, like checkNatives.
        const sites = new Map<string, { line: number; args: Map<number, number> }>();
        for (const call of file.calls) {
          if (ownGlobals.has(call.name) || !LUA_IDENTIFIER.test(call.name)) continue;
          const existing = sites.get(call.name);
          if (existing) {
            if (!existing.args.has(call.args)) existing.args.set(call.args, call.line);
          } else {
            sites.set(call.name, { line: call.line, args: new Map([[call.args, call.line]]) });
          }
        }

        for (const [name, site] of sites) {
          const entry = catalog.find(name);
          const exists = file.side === "server" ? undefined : live?.get(name);

          if (!entry) {
            if (exists === true) continue; // another resource's global; the client vouches.
            const loose = catalog.findLoose(name);
            const suggestions = loose ? [loose.lua] : catalog.suggest(name);
            if (loose) {
              file.findings.push({
                severity: "error",
                line: site.line,
                message: `${name} is not a native. The reference spells it "${loose.lua}".`,
                suggestions,
              });
            } else if (suggestions.length > 0) {
              file.findings.push({
                severity: "error",
                line: site.line,
                message:
                  `${name} is not in the native reference and not defined in this resource.` +
                  (exists === false ? " The connected client does not have it either." : ""),
                suggestions,
              });
            } else {
              file.findings.push({
                severity: "warning",
                line: site.line,
                message:
                  `${name} is neither in the native reference nor defined in this resource. ` +
                  "If another resource or an @-include provides it, ignore this.",
              });
            }
            continue;
          }

          const sideOk =
            file.side === "shared" ||
            (file.side === "client" ? isClientCapable(entry) : entry.apisets.includes("server"));
          if (!sideOk) {
            file.findings.push({
              severity: "error",
              line: site.line,
              message:
                `${name} is a ${file.side === "client" ? "server" : "client"}-only native ` +
                `(${entry.ns}, ${entry.hash}), but ${file.rel} is a ${file.side} script: ` +
                `${formatSignature(entry)}`,
            });
            continue;
          }

          if (exists === false && isClientCapable(entry)) {
            file.findings.push({
              severity: "error",
              line: site.line,
              message:
                `${name} is in the reference (${entry.ns}, ${entry.hash}) but the connected ` +
                "client does not have it. The reference covers natives this game build does " +
                "not expose.",
            });
            continue;
          }

          for (const issue of checkArity(entry, name, site)) {
            file.findings.push({
              severity: "warning",
              line: issue.line,
              message: `${issue.name} ${issue.detail}`,
            });
          }
        }
      }

      // Render: verdict first, details after.
      const errors = files.reduce(
        (n, f) => n + f.findings.filter((x) => x.severity === "error").length,
        0,
      );
      const warnings = files.reduce(
        (n, f) => n + f.findings.filter((x) => x.severity === "warning").length,
        0,
      );
      const counts = { client: 0, server: 0, shared: 0 };
      for (const file of files) counts[file.side] += 1;

      const lines: string[] = [
        (errors === 0
          ? warnings === 0
            ? `${basename(root)}: no issues.`
            : `${basename(root)}: no errors, ${warnings} warning(s).`
          : `${basename(root)}: ${errors} error(s), ${warnings} warning(s).`) +
          ` Checked ${files.length} Lua file(s) (${counts.client} client, ${counts.server} server, ` +
          `${counts.shared} shared)` +
          (live !== null
            ? ", client-side names probed against the running game."
            : "; no game client was probed."),
      ];

      for (const file of files) {
        if (file.findings.length === 0) continue;
        lines.push("", `${file.rel} (${file.side}):`);
        for (const finding of file.findings.sort((a, b) => a.line - b.line)) {
          lines.push(
            `  ${finding.severity === "error" ? "ERROR" : "warning"}` +
              `${finding.line > 0 ? ` line ${finding.line}` : ""}: ${finding.message}`,
          );
          if (finding.suggestions && finding.suggestions.length > 0) {
            lines.push(`    did you mean: ${finding.suggestions.join(", ")}`);
          }
        }
      }

      if (notes.length > 0) {
        lines.push("", ...notes.map((note) => `Note: ${note}`));
      }
      if (errors > 0) {
        lines.push(
          "",
          "Fix the errors before restarting the resource; use fivem_native_info to look a " +
            "name up when the suggestion does not convince you.",
        );
      }

      return text(lines.join("\n"), errors > 0);
    },
  );
}
