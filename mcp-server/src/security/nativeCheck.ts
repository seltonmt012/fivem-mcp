import type { NativeCatalog, NativeEntry } from "../natives/catalog.js";
import { formatSignature, isClientCapable } from "../natives/catalog.js";
import { scanForNativeCalls } from "../natives/scanCode.js";

export type NativeMode = "strict" | "warn" | "off";

export interface NativeIssue {
  kind: "unknown" | "server-only" | "client-only" | "missing-at-runtime" | "arity";
  severity: "error" | "warning";
  name: string;
  /** First line in the snippet where the name is called. */
  line: number;
  detail: string;
  suggestions?: string[];
}

export interface NativeCheckReport {
  /** Distinct identifiers that were resolved against the reference. */
  checked: number;
  /** True when the connected client was asked which names actually exist. */
  probed: boolean;
  issues: NativeIssue[];
  /** Set when the check could not run at all; the snippet is then let through. */
  skipped?: string;
}

/**
 * Asks the game whether these globals exist. Returns null when no client is
 * connected or the probe itself failed -- the caller then falls back to the
 * reference alone.
 */
export type NativeProbe = (names: string[]) => Promise<Map<string, boolean> | null>;

/** One Lua identifier; shared with fivem_native_info's name detection. */
export const LUA_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Resolves every native a snippet calls before it is sent to the game.
 *
 * Two sources, because neither alone is sufficient: the reference knows
 * signatures and apisets but lags game builds, and the running client knows
 * exactly which globals exist but nothing about what they take. A name is only
 * accepted when at least one source vouches for it and neither rules it out.
 */
export async function checkNatives(
  code: string,
  catalog: NativeCatalog | null,
  mode: NativeMode,
  probe: NativeProbe | null,
  /** Which context the snippet runs in; decides the acceptable apisets. */
  side: "client" | "server" = "client",
): Promise<NativeCheckReport> {
  const empty: NativeCheckReport = { checked: 0, probed: false, issues: [] };
  if (mode === "off") return { ...empty, skipped: "native checking is off for this call" };
  if (!catalog) {
    return { ...empty, skipped: "no native index is loaded (run: npm run natives:sync)" };
  }

  const scan = scanForNativeCalls(code);
  if (!scan.ok) {
    // A snippet that does not parse cannot be scanned. It will fail in the game
    // with a better message than anything invented here, so let it through.
    return {
      ...empty,
      skipped: `the snippet could not be parsed${scan.line ? ` (line ${scan.line})` : ""}: ${scan.error}`,
    };
  }

  // One entry per distinct name: the first line it appears on, plus the first
  // line of every distinct argument count -- so an arity warning points at the
  // call that is actually wrong, not merely the first call of that name.
  const sites = new Map<string, { line: number; args: Map<number, number> }>();
  for (const call of scan.calls) {
    if (!LUA_IDENTIFIER.test(call.name)) continue;
    const existing = sites.get(call.name);
    if (existing) {
      if (!existing.args.has(call.args)) existing.args.set(call.args, call.line);
    } else {
      sites.set(call.name, { line: call.line, args: new Map([[call.args, call.line]]) });
    }
  }

  if (sites.size === 0) return { ...empty, checked: 0 };

  const names = [...sites.keys()];
  const live = probe ? await probe(names) : null;

  const issues: NativeIssue[] = [];

  for (const [name, site] of sites) {
    const entry = catalog.find(name);
    const exists = live?.get(name);

    if (!entry) {
      if (exists === true) {
        // Not documented, but the client has it: another resource's global, or
        // a runtime helper the reference does not cover. Nothing to complain about.
        continue;
      }
      const loose = catalog.findLoose(name);
      const suggestions = loose ? [loose.lua] : catalog.suggest(name);
      issues.push({
        kind: "unknown",
        severity: "error",
        name,
        line: site.line,
        // A loose hit always differs in spelling: had it matched exactly,
        // catalog.find() above would have resolved it.
        detail: loose
          ? `not a native. The reference spells it "${loose.lua}".`
          : exists === false
            ? "is neither in the native reference nor defined in the running client."
            : "is not in the native reference.",
        ...(suggestions.length > 0 ? { suggestions } : {}),
      });
      continue;
    }

    const capable = side === "client" ? isClientCapable(entry) : entry.apisets.includes("server");
    if (!capable) {
      issues.push({
        kind: side === "client" ? "server-only" : "client-only",
        severity: "error",
        name,
        line: site.line,
        detail:
          side === "client"
            ? `is a server-side native (${entry.ns}, ${entry.hash}). Snippets run in the ` +
              "client context, where it does not exist."
            : `is a client-side native (${entry.ns}, ${entry.hash}). Server snippets run in ` +
              "the server context, where it does not exist.",
      });
      continue;
    }

    if (exists === false) {
      const alternatives = catalog.suggest(name, 3).filter((s) => s !== name);
      issues.push({
        kind: "missing-at-runtime",
        severity: "error",
        name,
        line: site.line,
        detail:
          `is in the reference (${entry.ns}, ${entry.hash}) but the connected client does not ` +
          "have it. The reference covers natives this game build does not expose.",
        ...(alternatives.length > 0 ? { suggestions: alternatives } : {}),
      });
      continue;
    }

    for (const issue of checkArity(entry, name, site)) issues.push(issue);
  }

  return { checked: sites.size, probed: live !== null, issues };
}

/**
 * Lua does not receive the reference's output parameters -- they come back as
 * extra return values -- so the acceptable argument count is a range, not a
 * number. Anything inside it passes silently; this only ever warns.
 *
 * Exported for fivem_check_resource, which reaches different verdicts on
 * unknown names but asks exactly this question about known ones.
 */
export function checkArity(
  entry: NativeEntry,
  name: string,
  site: { line: number; args: Map<number, number> },
): NativeIssue[] {
  const max = entry.params.length;
  // char* is an input string; every other pointer is an output the caller omits.
  // The curated overlay wins where present: it names natives whose trailing
  // parameters are optional in practice (GetEntityCoords' alive flag).
  const computed = entry.params.filter((param) => !isOutputParam(param.t)).length;
  const min = entry.minArgs !== undefined ? Math.min(entry.minArgs, computed) : computed;

  const issues: NativeIssue[] = [];
  for (const [args, line] of site.args) {
    // -1 is the scanner saying the count expands at runtime; nothing to check.
    if (args < 0 || (args >= min && args <= max)) continue;
    issues.push({
      kind: "arity",
      severity: "warning",
      name,
      line,
      detail:
        `is called with ${args} argument${args === 1 ? "" : "s"}, but the reference lists ` +
        `${min === max ? `${max}` : `${min}-${max}`}: ${formatSignature(entry)}`,
    });
  }
  return issues;
}

function isOutputParam(type: string): boolean {
  return type.endsWith("*") && type !== "char*";
}

/**
 * Builds the probe snippet. Indexing _G is what resolves a native binding in
 * the FiveM Lua runtime, so this is the same question the snippet itself asks.
 */
export function buildProbeSnippet(names: string[]): string {
  const list = names
    .filter((name) => LUA_IDENTIFIER.test(name))
    .map((name) => `"${name}"`)
    .join(",");
  return [
    "local names = {" + list + "}",
    "local present = {}",
    "for _, n in ipairs(names) do present[n] = (type(_G[n]) == \"function\") end",
    "return present",
  ].join("\n");
}

/** Renders a report for the agent, in the order it should act on it. */
export function formatReport(report: NativeCheckReport, mode: NativeMode): string {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");
  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push(
      mode === "strict"
        ? `Snippet rejected: ${errors.length} of the ${report.checked} natives it calls ` +
          "will not work in the client."
        : `Warning: ${errors.length} of the ${report.checked} natives this snippet calls ` +
          "look wrong.",
    );
    for (const issue of errors) {
      lines.push(`  line ${issue.line}: ${issue.name} ${issue.detail}`);
      if (issue.suggestions && issue.suggestions.length > 0) {
        lines.push(`    did you mean: ${issue.suggestions.join(", ")}`);
      }
    }
  }

  if (warnings.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Argument counts worth checking (${warnings.length}):`);
    for (const issue of warnings) {
      lines.push(`  line ${issue.line}: ${issue.name} ${issue.detail}`);
    }
  }

  if (errors.length > 0) {
    lines.push(
      "",
      "Look the names up with fivem_native_info before trying again. " +
        (report.probed
          ? "The connected client was asked directly, so this is what the game actually has."
          : "No client answered, so this is the reference only."),
    );
    if (mode === "strict") {
      lines.push('To run it anyway (a native the reference does not know yet), pass nativeCheck: "warn".');
    }
  }

  return lines.join("\n");
}
