import { chmodSync, readFileSync } from "node:fs";

type PasswordSource = "env" | "file";

export interface TxAdminPassword {
  value: string;
  source: PasswordSource;
}

/**
 * Resolution order: FIVEM_TXADMIN_PASSWORD -> password file. Never generated --
 * the password must match an admin account the operator created in txAdmin.
 * null means "not configured"; the tools turn that into setup instructions.
 */
export function resolveTxAdminPassword(passwordFilePath: string): TxAdminPassword | null {
  const fromEnv = process.env["FIVEM_TXADMIN_PASSWORD"]?.trim();
  if (fromEnv) return { value: fromEnv, source: "env" };

  try {
    const fromFile = readFileSync(passwordFilePath, "utf8").trim();
    if (fromFile.length === 0) return null;
    // writeFileSync's mode only applies on creation; re-assert it so a file
    // created loosely is tightened up too. POSIX-only effect.
    try {
      chmodSync(passwordFilePath, 0o600);
    } catch {
      /* best effort -- the password is still usable */
    }
    return { value: fromFile, source: "file" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`Could not read txAdmin password file ${passwordFilePath}: ${String(err)}`);
  }
}
