import { spawn } from "node:child_process";

/** What a finished (or timed-out) tool run looks like. */
export interface ToolRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The tool could not be started at all -- exe missing, refused, unrunnable. */
export interface ToolSpawnFailure {
  spawnError: Error;
}

/**
 * Runs a short-lived console tool, collects its output and kills it at the
 * timeout. Shared by the screenshot worker and the launcher probes; what a
 * spawn failure means -- inconclusive, or fatal with advice -- is the caller's
 * decision, which is why it comes back as a value instead of a rejection.
 */
export function runTool(
  exe: string,
  argv: string[],
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<ToolRunResult | ToolSpawnFailure> {
  return new Promise((settle) => {
    const child = spawn(exe, argv, {
      ...(options.env ? { env: options.env } : {}),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));

    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ spawnError: err });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ code, stdout, stderr, timedOut });
    });
  });
}
