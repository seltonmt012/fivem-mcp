/**
 * Shared harness for the check scripts. Each script is its own process, so the
 * module-level failure counter never leaks between suites.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** mcp-server package directory, so every script works from any working directory. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;

export function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

export function section(title) {
  console.log(`\n${title}`);
}

export function failureCount() {
  return failures;
}

/** Prints the verdict line and exits with 0 (all passed) or 1. */
export function finish() {
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
