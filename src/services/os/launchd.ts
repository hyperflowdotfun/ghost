import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ServiceController,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
  ServiceStatus,
} from "./controller.js";
import { ensureLogDir, defaultLogDir } from "./utils.js";
import { buildPlist } from "./launchd-plist.js";
import type { Logger } from "pino";

const LABEL = "com.ghost.daemon";

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function guiDomain(): string {
  if (!process.getuid) {
    throw new Error("LaunchAgent requires a POSIX system with process.getuid()");
  }
  const uid = process.getuid();
  return `gui/${uid}`;
}

function launchctl(args: readonly string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("launchctl", args, { encoding: "utf8", timeout: 15_000 });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function isAlreadyLoaded(): boolean {
  const domain = guiDomain();
  const result = launchctl(["print", `${domain}/${LABEL}`]);
  return result.status === 0;
}

function isUnsupportedGuiDomain(detail: string): boolean {
  const lower = detail.toLowerCase();
  return (
    lower.includes("domain does not support specified action") ||
    lower.includes("bootstrap failed: 125")
  );
}

export class LaunchdController implements ServiceController {
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    ensureLogDir(opts.logDir);

    const definitionPath = plistPath();
    // Daemon stdout/stderr are unmanaged — launchd writes them to its default
    // sink (unified logging on modern macOS). Pino-roll owns ghost.log
    // in-process; pre-flush crash output is not captured to a Ghost-owned file.
    const plist = buildPlist({
      label: LABEL,
      bunPath: opts.bunPath,
      execPath: opts.execPath,
      workingDir: join(homedir(), ".ghost"),
      env: opts.env ?? {},
    });

    // Atomic write — write to temp then rename would be ideal, but
    // for a user-scoped LaunchAgent, direct writeFileSync is acceptable.
    writeFileSync(definitionPath, plist, { encoding: "utf8", mode: 0o644 });

    const domain = guiDomain();
    // getuid is guaranteed to exist — guiDomain() throws if not.
    const uid = process.getuid?.() ?? 0;
    const serviceTarget = `${domain}/${LABEL}`;

    // Enable the service (clears any "disabled" state from prior bootout).
    launchctl(["enable", serviceTarget]);

    // If already loaded, bootout first so bootstrap can re-register.
    if (isAlreadyLoaded()) {
      launchctl(["bootout", domain, definitionPath]);
    }

    // Bootstrap into the GUI domain.
    const boot = launchctl(["bootstrap", domain, definitionPath]);
    if (boot.status !== 0) {
      const detail = (boot.stderr || boot.stdout).trim();
      if (isUnsupportedGuiDomain(detail)) {
        const msg =
          `LaunchAgent install requires a logged-in macOS GUI session (gui/${uid}). ` +
          "Run this command from a desktop terminal, not SSH or sudo.";
        this.log.error({ stderr: boot.stderr, stdout: boot.stdout }, msg);
        throw new Error(msg);
      }
      const msg = `launchctl bootstrap failed: ${detail}`;
      this.log.error({ stderr: boot.stderr, stdout: boot.stdout }, msg);
      throw new Error(msg);
    }

    return { ok: true, definitionPath };
  }

  async stop(): Promise<void> {
    const domain = guiDomain();
    const definition = plistPath();
    const result = launchctl(["bootout", domain, definition]);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      // Tolerate "not loaded" — service is already stopped.
      if (!detail.toLowerCase().includes("not loaded") && !detail.toLowerCase().includes("no such process")) {
        const msg = `launchctl bootout failed: ${detail}`;
        this.log.error({ stderr: result.stderr, stdout: result.stdout }, msg);
        throw new Error(msg);
      }
    }
  }

  async restart(): Promise<void> {
    const domain = guiDomain();
    const serviceTarget = `${domain}/${LABEL}`;
    // kickstart -k kills the running instance and restarts it immediately.
    const result = launchctl(["kickstart", "-k", serviceTarget]);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      const msg = `launchctl kickstart failed: ${detail}`;
      this.log.error({ stderr: result.stderr, stdout: result.stdout }, msg);
      throw new Error(msg);
    }
  }

  async uninstall(opts: UninstallOptions): Promise<UninstallResult> {
    const domain = guiDomain();
    const definition = plistPath();

    // Bootout — swallow errors (service may not be loaded).
    launchctl(["bootout", domain, definition]);

    // Delete plist file if present.
    if (existsSync(definition)) {
      unlinkSync(definition);
    }

    // Purge logs if requested.
    if (opts.purgeLogs) {
      const logDir = defaultLogDir();
      if (existsSync(logDir)) {
        rmSync(logDir, { recursive: true, force: true });
      }
    }

    return { ok: true };
  }

  async status(): Promise<ServiceStatus> {
    const domain = guiDomain();
    const result = launchctl(["print", `${domain}/${LABEL}`]);

    if (result.status !== 0) {
      return "not-installed";
    }

    // Parse "state = running" from launchctl print output.
    const stateMatch = (result.stdout || result.stderr).match(/state\s*=\s*(\S+)/i);
    if (stateMatch && stateMatch[1]?.toLowerCase() === "running") {
      return "running";
    }

    return "stopped";
  }
}
