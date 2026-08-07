import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "../logger.js";

type TokenSource = "env" | "file" | "generated";

export interface BridgeToken {
  value: string;
  source: TokenSource;
  /** Absolute path of the token file, or null when the token came from the environment. */
  path: string | null;
}

const TOKEN_BYTES = 32;

/**
 * Resolution order: FIVEM_BRIDGE_TOKEN -> existing token file -> freshly generated
 * token persisted to the token file.
 */
export function resolveToken(tokenFilePath: string): BridgeToken {
  const fromEnv = process.env["FIVEM_BRIDGE_TOKEN"]?.trim();
  if (fromEnv) {
    if (fromEnv.length < 16) {
      throw new Error("FIVEM_BRIDGE_TOKEN is too short, use at least 16 characters");
    }
    return { value: fromEnv, source: "env", path: null };
  }

  try {
    const existing = readFileSync(tokenFilePath, "utf8").trim();
    if (existing.length >= 16) {
      // writeFileSync's mode only applies on creation; re-assert it so a file
      // that predates the 0o600 policy is tightened up too. POSIX-only effect.
      try {
        chmodSync(tokenFilePath, 0o600);
      } catch {
        /* best effort -- the token is still usable */
      }
      return { value: existing, source: "file", path: tokenFilePath };
    }
    log.warn(`Token file ${tokenFilePath} held an unusably short token, regenerating`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw new Error(`Could not read token file ${tokenFilePath}: ${String(err)}`);
    }
  }

  const value = randomBytes(TOKEN_BYTES).toString("hex");
  // mode is honoured on POSIX and harmlessly ignored on Windows.
  mkdirSync(dirname(tokenFilePath), { recursive: true, mode: 0o700 });
  writeFileSync(tokenFilePath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  return { value, source: "generated", path: tokenFilePath };
}

/**
 * Constant-time comparison. timingSafeEqual throws on length mismatch, so the
 * length is checked first — that leaks only the length, never the contents.
 */
export function tokenMatches(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== "string") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(candidate, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
