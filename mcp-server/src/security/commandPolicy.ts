import type { Config } from "../config.js";

export type PolicyDecision =
  | { allowed: true; command: string; verb: string }
  | { allowed: false; reason: string };

/** Control characters would let a caller smuggle extra console lines into one command. */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Gate for the genuinely dangerous operations this server exposes: running a
 * console command inside the player's game client, or -- via txAdmin -- in the
 * server console.
 *
 * @param configKey Where the policy lives in fivem-mcp.config.json, so the
 *   rejection tells the operator which knob to turn: "commands" for the client
 *   policy, "txAdmin.commands" for the server one.
 */
export function checkCommand(
  input: string,
  policy: Config["commands"],
  configKey = "commands",
): PolicyDecision {
  const command = input.trim();

  if (command.length === 0) {
    return { allowed: false, reason: "Command is empty." };
  }
  if (hasControlChars(command)) {
    return {
      allowed: false,
      reason: "Command contains control characters (newlines or similar) and was rejected.",
    };
  }

  const verb = (command.split(/\s+/)[0] ?? "").toLowerCase();

  if (policy.mode === "allowlist") {
    const allowed = policy.allowlist.map((c) => c.toLowerCase());
    if (allowed.length === 0) {
      return {
        allowed: false,
        reason:
          `Command policy is "allowlist" but ${configKey}.allowlist is empty, so nothing may ` +
          "run. Add the commands you want to allow to fivem-mcp.config.json.",
      };
    }
    if (!allowed.includes(verb)) {
      return {
        allowed: false,
        reason:
          `"${verb}" is not in the allowlist. Allowed: ${allowed.join(", ")}. ` +
          `Extend ${configKey}.allowlist in fivem-mcp.config.json to permit it.`,
      };
    }
    return { allowed: true, command, verb };
  }

  const denied = policy.denylist.map((c) => c.toLowerCase());
  if (denied.includes(verb)) {
    return {
      allowed: false,
      reason:
        `"${verb}" is on the denylist because it is disruptive -- it can stop the server, ` +
        "disconnect the client, or move it to another server. Remove it from " +
        `${configKey}.denylist in fivem-mcp.config.json to permit it.`,
    };
  }

  return { allowed: true, command, verb };
}
