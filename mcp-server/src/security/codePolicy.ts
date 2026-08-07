import type { Config } from "../config.js";

export type CodeDecision =
  | { allowed: true; code: string; bytes: number }
  | { allowed: false; reason: string };

/** Lua marks precompiled chunks with ESC. `load(..., 't')` refuses them client-side too. */
const LUA_BYTECODE_MARKER = 0x1b;
const NUL = 0x00;

/**
 * Gate for fivem_run_code. Unlike a console command a snippet is *meant* to
 * contain newlines and quotes, so this only checks what would break the
 * transport or the client-side load(): size, emptiness and binary input. What
 * the snippet then does is the same trust question as the F8 console.
 */
export function checkCode(input: string, policy: Config["code"]): CodeDecision {
  // No code.enabled check: index.ts only registers fivem_run_code when the flag
  // is on, so a disabled tool cannot be called in the first place.
  const code = input.trim();
  if (code.length === 0) {
    return { allowed: false, reason: "The snippet is empty." };
  }

  if (code.charCodeAt(0) === LUA_BYTECODE_MARKER) {
    return {
      allowed: false,
      reason: "The snippet looks like precompiled Lua bytecode; send source text instead.",
    };
  }

  for (let i = 0; i < code.length; i += 1) {
    if (code.charCodeAt(i) === NUL) {
      return { allowed: false, reason: "The snippet contains NUL bytes and would not compile." };
    }
  }

  const bytes = Buffer.byteLength(code, "utf8");
  if (bytes > policy.maxBytes) {
    return {
      allowed: false,
      reason:
        `The snippet is ${bytes} bytes, the limit is ${policy.maxBytes}. Send something ` +
        "smaller, or raise code.maxBytes in fivem-mcp.config.json.",
    };
  }

  return { allowed: true, code, bytes };
}
