import { accessSync, constants, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** Check if a file exists and is executable. */
function isExecutable(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Escape the five XML entities (for plist and any XML payload). */
export function escapeXml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Resolve the absolute path to the `ghost` executable installed by bun.
 * Service definitions embed an absolute path — never rely on PATH resolution
 * at service-start time.
 */
export function resolveGhostExecPath(): string {
  const candidates = [
    join(homedir(), ".bun", "bin", process.platform === "win32" ? "ghost.exe" : "ghost"),
    join(homedir(), ".local", "bin", "ghost"),
    "/usr/local/bin/ghost",
  ];
  for (const c of candidates) {
    if (isExecutable(c)) {
      try {
        return realpathSync(c);
      } catch {
        return c;
      }
    }
  }
  // If nothing resolved, return the first candidate — caller decides whether
  // to fail. We don't throw here because unit tests on CI may not have a real install.
  return candidates[0]!;
}

/**
 * Resolve the absolute path to the `bun` runtime binary.
 * Service definitions must use absolute paths — systemd/launchd/schtasks
 * don't inherit the user's login shell PATH, so `#!/usr/bin/env bun` fails.
 */
export function resolveBunPath(): string {
  const candidates = [
    join(homedir(), ".bun", "bin", process.platform === "win32" ? "bun.exe" : "bun"),
    "/usr/local/bin/bun",
    "/usr/bin/bun",
  ];
  for (const c of candidates) {
    if (isExecutable(c)) {
      try {
        return realpathSync(c);
      } catch {
        return c;
      }
    }
  }
  return candidates[0]!;
}

/** Ensure a directory exists; idempotent. */
export function ensureLogDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Default log directory used by all controllers. Honors GHOST_LOG_DIR so
 * service installers (systemd / schtasks) can override the path via the
 * environment they inject into the daemon process.
 */
export function defaultLogDir(): string {
  const override = process.env.GHOST_LOG_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".ghost", "logs");
}

/**
 * Pattern for pino-roll daily log files: ghost.YYYY-MM-DD.<N>.log
 * Matches e.g. "ghost.2026-05-21.1.log", "ghost.2026-05-21.2.log"
 */
const DAILY_LOG_RE = /^ghost\.(\d{4}-\d{2}-\d{2})\.(\d+)\.log$/;

/**
 * Scan the log directory and return the path to the most-recent active log
 * file produced by pino-roll daily mode. Sorts by (date desc, number desc)
 * so the newest file within the newest calendar day wins.
 *
 * Returns null when the directory does not exist or contains no matching files.
 */
export function findActiveLogFile(dir: string): string | null {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  type Candidate = { date: string; num: number; name: string };
  const candidates: Candidate[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const m = DAILY_LOG_RE.exec(name);
    if (!m) continue;
    candidates.push({ date: m[1]!, num: parseInt(m[2]!, 10), name });
  }

  if (candidates.length === 0) return null;

  // Sort: newest date first, highest number first within same date.
  candidates.sort((a, b) => {
    const dateCmp = b.date.localeCompare(a.date);
    return dateCmp !== 0 ? dateCmp : b.num - a.num;
  });

  return join(dir, candidates[0]!.name);
}
