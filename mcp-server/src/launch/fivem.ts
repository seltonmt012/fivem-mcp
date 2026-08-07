import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { Config } from "../config.js";
import { log } from "../logger.js";
import { runTool, type ToolRunResult } from "../runTool.js";

/**
 * Starts the FiveM launcher with a `+connect` argument.
 *
 * Like the screen capture this is an operating-system concern rather than a
 * game one, so it never touches the bridge: the whole point is to be useful
 * when nothing is running yet. It only ever connects at process start -- the
 * in-game `connect` console command stays denylisted, so an already-running
 * session cannot be pulled onto another server behind the user's back.
 */

export class FiveMLaunchUnavailable extends Error {}

/** A server address that could not be read as one. Carries its own advice. */
export class InvalidServerAddress extends Error {}

/** Port assumed when an address carries none. FiveM's own default. */
export const DEFAULT_SERVER_PORT = 30_120;

export interface ServerAddress {
  /** Exactly what goes after `+connect`. */
  value: string;
  host: string;
  /** null for a cfx.re join code, which carries no port. */
  port: number | null;
  /** False when the port came from DEFAULT_SERVER_PORT rather than the caller. */
  explicitPort: boolean;
}

export interface RunningProcess {
  name: string;
  pid: number;
}

export interface LaunchResult {
  exe: string;
  argv: string[];
  pid: number;
}

/** `cfx.re/join/<code>` — a hosting-list shortcut FiveM resolves itself. */
const CFX_JOIN = /^(?:https?:\/\/)?cfx\.re\/join\/([0-9a-z]+)$/i;

/** Hostname or IPv4. Deliberately narrow: no spaces, quotes or shell metacharacters get through. */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

const BRACKETED_IPV6 = /^\[[0-9a-fA-F:.]+\]$/;

/** The registry value of the fivem:// handler: `"C:\...\FiveM.exe" "%1"`. */
const REG_COMMAND = /REG_(?:EXPAND_)?SZ\s+(.+)$/m;

export class FiveMLauncher {
  /**
   * @param baseDir Root that a relative launch.executablePath resolves against
   *   -- the package directory, for the same reason loadConfig takes one.
   */
  constructor(
    private readonly config: Config,
    private readonly baseDir: string,
  ) {}

  /** False on anything but Windows -- FiveM is a Windows client. */
  get available(): boolean {
    return process.platform === "win32";
  }

  /**
   * Where the launcher lives: the configured path, the standard install, then
   * whatever registered itself as the fivem:// protocol handler.
   */
  async resolveExecutable(): Promise<string> {
    const configured = this.config.launch.executablePath;
    if (configured) {
      const path = isAbsolute(configured) ? configured : resolve(this.baseDir, configured);
      if (!existsSync(path)) {
        throw new FiveMLaunchUnavailable(
          `"launch.executablePath" in fivem-mcp.config.json points at ${path}, which does not ` +
            "exist. Correct it, or set it back to null to auto-detect the install.",
        );
      }
      return path;
    }

    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData) {
      const candidate = join(localAppData, "FiveM", "FiveM.exe");
      if (existsSync(candidate)) return candidate;
    }

    const registered = await this.fromProtocolHandler();
    if (registered) return registered;

    throw new FiveMLaunchUnavailable(
      "Could not find FiveM.exe. It is not at " +
        `${localAppData ? join(localAppData, "FiveM", "FiveM.exe") : "%LOCALAPPDATA%\\FiveM\\FiveM.exe"} ` +
        'and no fivem:// protocol handler is registered. Set "launch.executablePath" in ' +
        "fivem-mcp.config.json to the full path of FiveM.exe.",
    );
  }

  /**
   * Which FiveM processes are up right now.
   *
   * @returns null when the lookup itself failed -- an absent or refused
   *   tasklist means "unknown", never "nothing is running".
   */
  async findRunning(): Promise<RunningProcess[] | null> {
    const attempt = await this.capture("tasklist.exe", ["/FO", "CSV", "/NH"]);
    // A refused tasklist (non-zero exit) is as inconclusive as an absent one.
    if (attempt === null || attempt.timedOut || attempt.code !== 0) return null;

    const patterns = this.config.launch.processNames.map(globToRegExp);
    const found: RunningProcess[] = [];

    for (const line of attempt.stdout.split(/\r?\n/)) {
      const fields = line.match(/"([^"]*)"/g);
      if (!fields || fields.length < 2) continue;

      const name = unquote(fields[0]!);
      const pid = Number.parseInt(unquote(fields[1]!), 10);
      if (!Number.isInteger(pid)) continue;
      if (patterns.some((pattern) => pattern.test(name))) found.push({ name, pid });
    }

    return found;
  }

  /**
   * Starts the launcher and lets go of it: detached and unref'd, so the game
   * outlives this server and a shutdown here never kills someone's session.
   */
  launch(exe: string, argv: string[]): Promise<LaunchResult> {
    return new Promise((settle, fail) => {
      const child = spawn(exe, argv, {
        cwd: dirname(exe),
        detached: true,
        stdio: "ignore",
      });

      child.once("spawn", () => {
        child.unref();
        settle({ exe, argv, pid: child.pid ?? -1 });
      });

      child.once("error", (err) => {
        fail(
          new FiveMLaunchUnavailable(
            `Could not start ${exe}: ${err.message}. Check that the path is right and that this ` +
              'account may run it, or point "launch.executablePath" somewhere else.',
          ),
        );
      });
    });
  }

  /** `reg query` against the handler the FiveM installer writes. */
  private async fromProtocolHandler(): Promise<string | null> {
    const keys = [
      "HKCU\\Software\\Classes\\fivem\\shell\\open\\command",
      "HKCR\\fivem\\shell\\open\\command",
    ];

    for (const key of keys) {
      const attempt = await this.capture("reg.exe", ["query", key, "/ve"]);
      if (attempt === null || attempt.timedOut || attempt.code !== 0) continue;

      const value = REG_COMMAND.exec(attempt.stdout)?.[1];
      if (!value) continue;

      // `"C:\...\FiveM.exe" "%1"` -- the quoted head, or the bare first token.
      const path = /^"([^"]+)"/.exec(value.trim())?.[1] ?? value.trim().split(/\s+/)[0];
      if (path && existsSync(path)) {
        log.debug(`Found FiveM through the ${key} protocol handler: ${path}`);
        return path;
      }
    }

    return null;
  }

  /**
   * Runs a short-lived console tool and collects its stdout.
   *
   * @returns null when the tool could not be started at all. Every caller
   *   treats that as inconclusive rather than fatal.
   */
  private async capture(exe: string, argv: string[]): Promise<ToolRunResult | null> {
    const result = await runTool(exe, argv, { timeoutMs: this.config.launch.probeTimeoutMs });
    if ("spawnError" in result) {
      log.debug(`${exe} could not be started: ${result.spawnError.message}`);
      return null;
    }
    return result;
  }
}

/**
 * Reads a server address the way a human would write one.
 *
 * Accepts `host`, `host:port`, `[::1]:port`, a `fivem://connect/...` link and a
 * `cfx.re/join/<code>` shortcut. Anything else throws rather than being handed
 * to the launcher: the spawn is argv-based so there is no shell to inject into,
 * but a typo that silently becomes a different server is its own hazard.
 */
export function parseServerAddress(input: string, defaultPort = DEFAULT_SERVER_PORT): ServerAddress {
  let raw = input.trim();
  if (raw === "") {
    throw new InvalidServerAddress("The server address is empty.");
  }

  raw = raw.replace(/^fivem:\/\/connect\//i, "").replace(/\/+$/, "").trim();

  const joinCode = CFX_JOIN.exec(raw);
  if (joinCode) {
    const code = joinCode[1]!;
    return { value: `cfx.re/join/${code}`, host: `cfx.re/join/${code}`, port: null, explicitPort: false };
  }

  const bracketed = /^(\[[0-9a-fA-F:.]+\])(?::(\d+))?$/.exec(raw);
  const plain = /^([^:]+)(?::(\d+))?$/.exec(raw);
  const parts = bracketed ?? plain;

  if (!parts) {
    throw new InvalidServerAddress(
      `"${input}" is not a server address. Expected host:port, for example ` +
        "127.0.0.1:30120 or dev.example.com:30120.",
    );
  }

  const host = parts[1]!;
  if (!(BRACKETED_IPV6.test(host) || HOSTNAME.test(host))) {
    throw new InvalidServerAddress(
      `"${host}" is not a usable host. Use an IPv4 address, a hostname, or an IPv6 address in ` +
        "square brackets.",
    );
  }

  const explicitPort = parts[2] !== undefined;
  const port = explicitPort ? Number.parseInt(parts[2]!, 10) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidServerAddress(`"${parts[2]}" is not a port number (1-65535).`);
  }

  return { value: `${host}:${port}`, host, port, explicitPort };
}

/**
 * Whether an address passes launch.allowedAddresses.
 *
 * An entry without a port allows every port on that host, which is what a dev
 * box with several servers on it needs. An empty list allows everything.
 */
export function isAddressAllowed(address: ServerAddress, allowed: string[]): boolean {
  if (allowed.length === 0) return true;

  return allowed.some((entry) => {
    let candidate: ServerAddress;
    try {
      // The port only matters for entries that spell one out, so any valid
      // stand-in does for the rest.
      candidate = parseServerAddress(entry, address.port ?? 30_120);
    } catch {
      log.warn(`Ignoring unreadable "launch.allowedAddresses" entry: ${entry}`);
      return false;
    }
    return candidate.explicitPort
      ? candidate.value.toLowerCase() === address.value.toLowerCase()
      : candidate.host.toLowerCase() === address.host.toLowerCase();
  });
}

/** tasklist reports image names; the config lists them with `*` wildcards. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function unquote(field: string): string {
  return field.slice(1, -1);
}
