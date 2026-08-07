#!/usr/bin/env node
/**
 * Invariants for the agent-memory files.
 *
 * The important one is the leak check: the committed skill files under
 * .claude/skills/ accumulate portable learnings across sessions (lessons.md
 * foremost, but compaction graduates entries into the other references too),
 * and the whole two-tier design rests on machine facts -- local paths, server
 * addresses, player identifiers -- staying in the gitignored
 * .fivem-mcp/memory.md instead. A leaked path breaks nothing visibly; it just
 * quietly publishes someone's disk layout or license identifier with the next
 * push. So every committed .md under .claude/skills/ is scanned, not only the
 * lessons file.
 *
 * .fivem-mcp/memory.md itself is deliberately unchecked: it may not exist at
 * all (fresh clone -- the directory is created lazily), and whether its facts
 * are still true is something only a probe in a live session can judge. Its
 * hygiene is the "Last verified" column, not this script.
 *
 *   node scripts/check-memory.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

import { check, failureCount, finish, PACKAGE_ROOT, section } from "./lib.mjs";

const REPO_ROOT = resolve(PACKAGE_ROOT, "..");
const SKILLS_DIR = resolve(REPO_ROOT, ".claude/skills");
const LESSONS = resolve(REPO_ROOT, ".claude/skills/fivem-script-dev/references/lessons.md");

const MAX_ENTRIES = 40;
const MAX_LINES = 400;
const COMPACTION = "compact: merge near-duplicates, delete absorbed entries, graduate stable ones into references/debugging.md";

section("Lessons file");
check("lessons.md exists", existsSync(LESSONS), LESSONS);
if (!existsSync(LESSONS)) {
  console.log(`\n${failureCount()} check(s) failed.`);
  process.exit(1);
}

const raw = readFileSync(LESSONS, "utf8");
const lines = raw.split(/\r?\n/);

// Fenced blocks carry the format example, command examples and sanitized
// snippet quotes; they are exempt from every scan below. The array keeps
// 1-based line numbers so failures can name the offending line.
function scannableLines(text) {
  const out = [];
  let inFence = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) out.push({ line, num: i + 1 });
  });
  return out;
}

const scannable = scannableLines(raw);

/* ------------------------------------------------------------------ *
 * leak checks
 * ------------------------------------------------------------------ */

/** IPs that describe the architecture (loopback-only bridge), not a machine. */
const IP_ALLOWLIST = new Set(["127.0.0.1", "0.0.0.0"]);

const LEAKS = [
  {
    name: "no drive-letter paths",
    test: (l) => /\b[A-Za-z]:[\\/]/.test(l),
  },
  {
    name: "no UNC paths",
    test: (l) => /\\\\[A-Za-z0-9_.$-]+\\/.test(l),
  },
  {
    name: "no user-home paths",
    test: (l) => /\b(Users|home)[\\/][A-Za-z0-9_.-]+/.test(l),
  },
  {
    name: "no non-loopback IP addresses",
    test: (l) => {
      const hits = l.match(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g) ?? [];
      return hits.some((hit) => !IP_ALLOWLIST.has(hit.split(":")[0]));
    },
  },
  {
    name: "no player identifiers",
    test: (l) => /\b(license2?|steam|discord|fivem|xbl|live|ip):[0-9a-fA-F]{4,}\b/.test(l),
  },
];

section("Leak checks (machine facts belong in .fivem-mcp/memory.md)");
// Every committed skill doc, not just lessons.md -- compaction graduates
// entries into the other references, and a leak is a leak wherever it lands.
const skillDocs = readdirSync(SKILLS_DIR, { recursive: true })
  .map(String)
  .filter((p) => p.endsWith(".md"))
  .map((p) => resolve(SKILLS_DIR, p));
check("found skill docs to scan", skillDocs.length > 0, SKILLS_DIR);
for (const { name, test } of LEAKS) {
  const offending = [];
  for (const file of skillDocs) {
    const rel = relative(REPO_ROOT, file).replaceAll("\\", "/");
    for (const { line, num } of scannableLines(readFileSync(file, "utf8"))) {
      if (test(line)) offending.push(`${rel}:${num}`);
    }
  }
  check(`${name} (${skillDocs.length} skill docs)`, offending.length === 0, offending.join(", "));
}

/* ------------------------------------------------------------------ *
 * structure
 * ------------------------------------------------------------------ */

section("Structure");
check("starts with the # Lessons heading", /^# Lessons/.test(lines[0] ?? ""));
const entriesIdx = scannable.findIndex(({ line }) => /^## Entries\s*$/.test(line));
check("has an ## Entries heading", entriesIdx !== -1);
check(
  `stays under ${MAX_LINES} lines`,
  lines.length <= MAX_LINES,
  `${lines.length} lines -- ${COMPACTION}`,
);

// Entries: everything after ## Entries, split at ### headings.
const body = entriesIdx === -1 ? [] : scannable.slice(entriesIdx + 1);
const entries = [];
for (const item of body) {
  if (/^### /.test(item.line)) entries.push({ title: item.line, num: item.num, text: "" });
  else if (entries.length > 0) entries[entries.length - 1].text += `${item.line}\n`;
}

check(
  `stays under ${MAX_ENTRIES} entries`,
  entries.length <= MAX_ENTRIES,
  `${entries.length} entries -- ${COMPACTION}`,
);

const REQUIRED_FIELDS = ["**Date**", "**Tried**", "**Happened**", "**Instead**"];
for (const entry of entries) {
  const missing = REQUIRED_FIELDS.filter((field) => !entry.text.includes(field));
  check(
    `entry at line ${entry.num} has all fields`,
    missing.length === 0,
    `missing ${missing.join(", ")}`,
  );
  check(
    `entry at line ${entry.num} has an ISO date`,
    /\*\*Date\*\*:\s*\d{4}-\d{2}-\d{2}/.test(entry.text),
  );
}
if (entries.length === 0) {
  console.log("  (no entries yet -- field checks are vacuous)");
}

/* ------------------------------------------------------------------ *
 * machine-local hygiene
 * ------------------------------------------------------------------ */

section("Machine-local tier stays out of git");
const gitignore = readFileSync(resolve(REPO_ROOT, ".gitignore"), "utf8");
check(
  ".gitignore covers .fivem-mcp/",
  gitignore.split(/\r?\n/).some((line) => line.trim() === ".fivem-mcp/"),
);

// Defense in depth against a force-add: nothing under .fivem-mcp/ is tracked.
try {
  const tracked = execFileSync("git", ["ls-files", ".fivem-mcp"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  })
    .toString()
    .trim();
  check("no .fivem-mcp/ file is tracked by git", tracked === "", tracked);
} catch {
  console.log("  PASS  no .fivem-mcp/ file is tracked by git (git unavailable, skipped)");
}

finish();
