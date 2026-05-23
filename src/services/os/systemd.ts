/**
 * Linux systemd user service controller.
 *
 * Manages `~/.config/systemd/user/ghost.service`:
 *   install  → write unit, daemon-reload, enable, start
 *   uninstall → disable --now, remove unit, daemon-reload
 *   status   → is-active probe
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { buildUnit } from "./systemd-unit.js";
import type { Logger } from "pino";

const SERVICE_NAME = "ghost.service";

function unitPath(): string {
  return join(homedir(), ".config", "systemd", "user", SERVICE_NAME);
}

// ---------------------------------------------------------------------------
// systemctl helpers
// ---------------------------------------------------------------------------

function systemctl(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    ok: !result.error && (result.status === 0 || result.status === 3),
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function systemctlStrict(...args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("systemctl", ["--user", ...args], {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function assertSystemdAvailable(): void {
  const probe = systemctl("status");
  // exit 0 = running, exit 3 = "no units active" — both mean systemd is available
  if (!probe.ok) {
    const detail = `${probe.stderr} ${probe.stdout}`.trim();
    throw new Error(`Systemd user services unavailable${detail ? `: ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export class SystemdController implements ServiceController {
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  async install(opts: InstallOptions): Promise<InstallResult> {
    assertSystemdAvailable();

    // Ensure log directory exists
    ensureLogDir(opts.logDir);

    const path = unitPath();
    const dir = dirname(path);

    // Ensure systemd user config dir exists
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Back up existing unit file
    if (existsSync(path)) {
      copyFileSync(path, `${path}.bak`);
    }

    // Build and write unit file
    const unit = buildUnit({
      description: "Ghost AI Trading Companion",
      execStart: `${opts.bunPath} ${opts.execPath} daemon`,
      workingDir: join(homedir(), ".ghost"),
      env: {
        ...opts.env,
        GHOST_LOG_DIR: opts.logDir,
      },
    });
    writeFileSync(path, unit, "utf8");

    // Reload, enable, start
    const reload = systemctlStrict("daemon-reload");
    if (!reload.ok) {
      const msg = `daemon-reload failed: ${reload.stderr || reload.stdout}`;
      this.log.error({ stderr: reload.stderr, stdout: reload.stdout }, msg);
      throw new Error(msg);
    }

    const enable = systemctlStrict("enable", SERVICE_NAME);
    if (!enable.ok) {
      const msg = `enable failed: ${enable.stderr || enable.stdout}`;
      this.log.error({ stderr: enable.stderr, stdout: enable.stdout }, msg);
      throw new Error(msg);
    }

    const start = systemctlStrict("start", SERVICE_NAME);
    if (!start.ok) {
      const msg = `start failed: ${start.stderr || start.stdout}`;
      this.log.error({ stderr: start.stderr, stdout: start.stdout }, msg);
      throw new Error(msg);
    }

    return { ok: true, definitionPath: path };
  }

  async stop(): Promise<void> {
    // Use lenient helper — tolerates exit code 3 (service already stopped).
    const result = systemctl("stop", SERVICE_NAME);
    if (!result.ok) {
      const msg = `stop failed: ${result.stderr || result.stdout}`;
      this.log.error({ stderr: result.stderr, stdout: result.stdout }, msg);
      throw new Error(msg);
    }
  }

  async restart(): Promise<void> {
    const result = systemctlStrict("restart", SERVICE_NAME);
    if (!result.ok) {
      const msg = `restart failed: ${result.stderr || result.stdout}`;
      this.log.error({ stderr: result.stderr, stdout: result.stdout }, msg);
      throw new Error(msg);
    }
  }

  async uninstall(opts: UninstallOptions): Promise<UninstallResult> {
    const path = unitPath();
    const warnings: string[] = [];

    // Disable and stop in one command (tolerates unit not found)
    const disable = systemctlStrict("disable", "--now", SERVICE_NAME);
    if (!disable.ok) {
      warnings.push(`disable --now: ${disable.stderr || disable.stdout}`);
    }

    // Remove unit file and backup
    for (const file of [path, `${path}.bak`]) {
      try {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } catch {
        warnings.push(`Could not remove ${file}`);
      }
    }

    // Reload after removal
    systemctlStrict("daemon-reload");

    // Optionally purge logs
    if (opts.purgeLogs) {
      const logDir = defaultLogDir();
      try {
        if (existsSync(logDir)) {
          rmSync(logDir, { recursive: true, force: true });
        }
      } catch {
        warnings.push(`Could not remove log directory ${logDir}`);
      }
    }

    return { ok: true, warnings: warnings.length > 0 ? warnings : undefined };
  }

  async status(): Promise<ServiceStatus> {
    const result = spawnSync("systemctl", ["--user", "is-active", SERVICE_NAME], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const stdout = (result.stdout ?? "").trim();
    if (stdout === "active") {
      return "running";
    }

    // If the unit file exists but service is not active → stopped
    if (existsSync(unitPath())) {
      return "stopped";
    }

    return "not-installed";
  }
}
