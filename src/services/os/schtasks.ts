import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type {
  ServiceController,
  InstallOptions,
  InstallResult,
  UninstallOptions,
  UninstallResult,
  ServiceStatus,
} from "./controller.js";
import { ensureLogDir, defaultLogDir } from "./utils.js";
import {
  EXIT_UNCAUGHT_EXCEPTION,
  EXIT_UNHANDLED_REJECTION,
} from "../../helpers/exit-codes.js";

const TASK_NAME = "Ghost";

/**
 * fs.rmSync retry options for Windows. TerminateProcess returns before the
 * OS releases file handles (sqlite WAL, ghost.log, cwd lock when daemon
 * lived in ~/.ghost), so an immediate unlink races into EBUSY. Node's
 * fs.rmSync natively retries on EBUSY / EPERM / EMFILE / ENFILE / ENOTEMPTY
 * with exponential-ish backoff between attempts. 10 × 200ms = up to 2s.
 */
const RM_RETRY_OPTS = { force: true, maxRetries: 10, retryDelay: 200 } as const;

function launcherPath(): string {
  return join(homedir(), ".ghost", "state", "ghost-daemon.cmd");
}

/**
 * Path to the invisible-launcher VBScript. Task Scheduler invokes wscript.exe
 * with this .vbs; the script in turn runs `ghost-daemon.cmd` with a hidden
 * window (style 0), waits for it, and propagates the exit code. Without this
 * wrapper, Task Scheduler launches cmd.exe directly which always allocates a
 * visible console window — closing it kills the daemon.
 */
function invisibleLauncherPath(): string {
  return join(homedir(), ".ghost", "state", "ghost-daemon-invisible.vbs");
}

/**
 * Path to the legacy Startup-folder launcher.
 *
 * Earlier versions of Ghost wrote a fallback launcher here when schtasks
 * registration failed. Schtasks is now the single supported mechanism;
 * this helper exists only so `uninstall()` can clean up files left behind
 * by older installs.
 */
function legacyStartupPath(): string {
  const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
  return join(
    appData,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "Startup",
    "ghost-daemon.cmd",
  );
}

function schtasks(args: readonly string[]): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("schtasks", args, { encoding: "utf8", timeout: 15_000 });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/**
 * Resolve the current Windows user for the task `<UserId>`. Registering the
 * task under the user's own scope (Task Scheduler Library\<user>) avoids the
 * admin elevation that schtasks demands when defaulting to the machine-wide
 * scope. Returns null when USERNAME is not set.
 */
function resolveTaskUser(): string | null {
  const user = process.env.USERNAME?.trim();
  if (!user) return null;
  const domain = process.env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${user}` : user;
}

/** Characters that can break out of double quotes in Windows batch scripts. */
const BATCH_DANGEROUS = /[%!^&|<>]/;

/**
 * Validate that a path does not contain characters dangerous in .cmd batch files.
 * Throws a clear error if the path is unsafe.
 */
function assertBatchSafePath(label: string, value: string): void {
  if (BATCH_DANGEROUS.test(value)) {
    throw new Error(
      `${label} contains batch-unsafe characters (%, !, ^, &, |, <, >): "${value}". ` +
        "Rename the directory or use a path without special characters.",
    );
  }
}

/** Escape a path for use inside a .cmd script (wrap in double quotes). */
function quoteCmdArg(value: string): string {
  // NTFS forbids " in filenames, but guard against malformed input.
  if (value.includes('"')) {
    throw new Error(`Path contains double quotes which are invalid in .cmd scripts: ${value}`);
  }
  return `"${value}"`;
}

/** Escape the five XML predefined entities so values stay inside attributes/text. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Build the batch launcher that Task Scheduler will invoke.
 *
 * `bunPath` is accepted for signature parity with systemd/launchd controllers
 * but unused on Windows: `bun install -g` produces a native `.exe` shim that
 * embeds the bun runtime + JS entry. Running `bun ghost.exe` would parse the
 * PE binary as JavaScript and crash with "Expected ';'" on the MZ header.
 *
 * stdout/stderr are not redirected here. The in-process rotating logger owns
 * the structured log files under `~/.ghost/logs/`. Detached scheduled
 * tasks drop any residual stdout/stderr to NUL by default — no file-locking
 * conflicts with the logger's file handles. A
 * pre-flush crash (before logger init) will not appear in any file — use
 * Event Viewer or run `ghost daemon` from a CMD window to capture it.
 *
 * The launcher is single-shot — cmd.exe exits as soon as ghost.exe exits.
 * This prevents cmd.exe from holding the .cmd file open with FILE_SHARE_READ
 * during reinstall (ERROR_SHARING_VIOLATION). Crash restart is handled by
 * Task Scheduler's RestartOnFailure setting in the task XML.
 *
 * `<nul` redirects stdin to the NUL device. Without it, `process.stdin.isTTY`
 * returns true under schtasks-launched cmd.exe (the task runs InteractiveToken,
 * cmd.exe attaches a console) — and `guardAgainstRunningService` then misfires,
 * showing an `@clack/prompts` menu that waits forever for arrow-key input.
 * NUL stdin closes the loophole: isTTY is false, guard returns early.
 */
export function buildLauncherCmd(_bunPath: string, execPath: string, env?: Record<string, string>): string {
  assertBatchSafePath("execPath", execPath);

  const ghostDir = join(homedir(), ".ghost");

  // Skip PATH — it can be thousands of characters and contain %VARS%,
  // which exceeds batch line limits and breaks variable expansion.
  const setLines = Object.entries(env ?? {})
    .filter(([k, v]) => typeof v === "string" && v.trim() && k.toUpperCase() !== "PATH")
    .map(([k, v]) => {
      assertBatchSafePath(`env var ${k}`, v.trim());
      return `set "${k}=${v.trim()}"`;
    });

  // Trailing `exit /b %ERRORLEVEL%` propagates ghost.exe's non-zero status
  // up to Task Scheduler so RestartOnFailure actually fires on crash.
  return [
    "@echo off",
    "rem Ghost daemon launcher",
    `cd /d "${ghostDir}"`,
    ...setLines,
    `${quoteCmdArg(execPath)} daemon <nul`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");
}

/**
 * Build the VBScript supervisor that runs the launcher .cmd with a hidden
 * window AND restarts it only on JS-level crashes — not on operator stops
 * or OS-level termination.
 *
 * Task Scheduler invokes `wscript.exe ghost-daemon-invisible.vbs` (wscript
 * is the windows-host VBScript runtime — no console allocation), which in
 * turn calls `WScript.Shell.Run("…ghost-daemon.cmd", 0, True)`:
 *
 *  - style `0` = SW_HIDE → cmd.exe runs with no visible window.
 *  - wait `True` → wscript blocks until cmd.exe exits and captures its code
 *    (fire-and-forget `False` returns 0 immediately and breaks the loop).
 *
 * Restart contract — only the daemon's own crash handlers trigger respawn:
 *
 *    0   clean shutdown (SIGINT/SIGTERM)            → exit, stay down
 *    1   external taskkill / OS reap                → exit, stay down
 *    100 JS uncaughtException                       → restart (after backoff)
 *    101 JS unhandledRejection                      → restart (after backoff)
 *    *   anything else                              → exit, stay down
 *
 * If the daemon crash-loops more than 5 times in a row, the supervisor
 * gives up (poison-pill abort) — log noise from a misconfigured install is
 * worse than no daemon.
 *
 * Without this wrapper, Task Scheduler would launch cmd.exe directly and
 * the user would see a visible black System32\\cmd.exe window. Closing the
 * console window kills cmd.exe and the daemon (a child of cmd.exe) along
 * with it. Going through wscript+VBS avoids the console entirely.
 */
export function buildInvisibleVbs(launcherCmdPath: string): string {
  // VBScript string-literal escape: only `"` needs doubling.
  const escaped = launcherCmdPath.replace(/"/g, '""');
  // Exit-code contract lives in src/helpers/exit-codes.ts — keep in sync.
  return [
    `' Ghost daemon — invisible launcher wrapper + crash-restart supervisor`,
    `' Style 0 = hidden window, wait = True so exit code propagates from the daemon.`,
    `Dim shell, exitCode, attempts`,
    `Set shell = CreateObject("WScript.Shell")`,
    `attempts = 0`,
    `Do`,
    `  exitCode = shell.Run("""${escaped}""", 0, True)`,
    `  ' Only JS-level crash handlers (exit ${EXIT_UNCAUGHT_EXCEPTION} / ${EXIT_UNHANDLED_REJECTION}) request a respawn.`,
    `  ' Anything else — clean stop (0), external kill (1), config error,`,
    `  ' bun crash — is treated as the operator's intent. Respect it.`,
    `  If exitCode <> ${EXIT_UNCAUGHT_EXCEPTION} And exitCode <> ${EXIT_UNHANDLED_REJECTION} Then Exit Do`,
    `  attempts = attempts + 1`,
    `  If attempts >= 5 Then Exit Do`,
    `  ' 5s back-off between restart attempts.`,
    `  WScript.Sleep 5000`,
    `Loop`,
    `WScript.Quit exitCode`,
    ``,
  ].join("\r\n");
}

/**
 * Build the Task Scheduler 1.2 XML that registers the Ghost daemon as an
 * ONLOGON task with crash restart.
 *
 * Why XML instead of inline `/SC ONLOGON /RU /IT` args:
 *  - Inline args cannot set `<RestartOnFailure>`, so a crash leaves the task
 *    stopped until next logon. XML can.
 *  - `<Principal><LogonType>InteractiveToken</LogonType></Principal>` is the
 *    XML equivalent of `/IT`. No stored password is required, mirroring the
 *    canonical passwordless `/IT /NP` CLI pair.
 *
 * `userId` is required. Task Scheduler refuses an InteractiveToken principal
 * bound to a group SID — the task would register but never fire on logon. If
 * the caller cannot resolve a user the right answer is to fail `install()`
 * loudly, not to write a dead task. `install()` is the only caller and it
 * validates `resolveTaskUser()` returns non-null before invoking us.
 */
export function buildScheduledTaskXml(invisibleVbs: string, userId: string): string {
  const principal = userId;
  return [
    `<?xml version="1.0" encoding="UTF-16"?>`,
    `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
    `  <RegistrationInfo>`,
    `    <Description>Ghost daemon — Hyperliquid trading companion</Description>`,
    `    <Author>Ghost</Author>`,
    `  </RegistrationInfo>`,
    `  <Triggers>`,
    `    <LogonTrigger>`,
    `      <Enabled>true</Enabled>`,
    `      <UserId>${xmlEscape(principal)}</UserId>`,
    `    </LogonTrigger>`,
    `  </Triggers>`,
    `  <Principals>`,
    `    <Principal id="Author">`,
    `      <UserId>${xmlEscape(principal)}</UserId>`,
    `      <LogonType>InteractiveToken</LogonType>`,
    `      <RunLevel>LeastPrivilege</RunLevel>`,
    `    </Principal>`,
    `  </Principals>`,
    `  <Settings>`,
    `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
    `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
    `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
    `    <AllowHardTerminate>true</AllowHardTerminate>`,
    `    <StartWhenAvailable>true</StartWhenAvailable>`,
    `    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>`,
    `    <AllowStartOnDemand>true</AllowStartOnDemand>`,
    `    <Enabled>true</Enabled>`,
    `    <Hidden>false</Hidden>`,
    `    <RunOnlyIfIdle>false</RunOnlyIfIdle>`,
    `    <WakeToRun>false</WakeToRun>`,
    `    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`,
    `    <Priority>7</Priority>`,
    `    <RestartOnFailure>`,
    `      <Interval>PT1M</Interval>`,
    `      <Count>3</Count>`,
    `    </RestartOnFailure>`,
    `  </Settings>`,
    `  <Actions Context="Author">`,
    `    <Exec>`,
    `      <Command>wscript.exe</Command>`,
    `      <Arguments>"${xmlEscape(invisibleVbs)}"</Arguments>`,
    `    </Exec>`,
    `  </Actions>`,
    `</Task>`,
    ``,
  ].join("\r\n");
}

/**
 * Write the task XML to a temp file as UTF-16 LE with BOM — schtasks.exe
 * /XML expects that encoding and silently misparses anything else.
 */
function writeTaskXml(xml: string): string {
  const xmlPath = join(tmpdir(), `ghost-task-${process.pid}.xml`);
  const bom = Buffer.from([0xff, 0xfe]);
  writeFileSync(xmlPath, Buffer.concat([bom, Buffer.from(xml, "utf16le")]));
  return xmlPath;
}

/**
 * Kill any orphaned wscript / cmd / bun / ghost processes that were spawned
 * by the Ghost scheduled task and survived `schtasks /End`. Three match arms
 * cover the full supervisor chain:
 *
 *   1. VBS launcher:  CommandLine matches `ghost-daemon(-invisible)?.vbs`
 *   2. CMD launcher:  CommandLine matches `ghost-daemon.cmd` or the
 *                     `.ghost\state\` directory prefix
 *   3. ghost.exe:     CommandLine matches `ghost daemon` (with or without
 *                     the `.exe` suffix — cmd.exe's PATH resolution often
 *                     preserves the user-typed `ghost daemon` form in
 *                     Win32_Process.CommandLine, so requiring `.exe` would
 *                     miss foreground invocations)
 *
 * Uses PowerShell because:
 *   - `taskkill /IM <name>` is too coarse (kills every wscript.exe).
 *   - `taskkill /FI` does not support a CommandLine filter.
 *   - `wmic` is deprecated on Windows 11.
 *
 * Failures are swallowed — the kill is best-effort and the rm-rf that
 * follows will surface its own error if a handle is still held.
 */
function killOrphanedSupervisorChain(): void {
  // Arm 3 anchors `ghost` to a path-separator, whitespace, or start-of-line
  // boundary so unrelated processes with `ghost` as a substring (e.g.
  // `C:\Tools\notghost\notghost.exe daemon`) don't get matched and force-killed.
  const ps = `Get-CimInstance Win32_Process -Filter "Name='wscript.exe' OR Name='cmd.exe' OR Name='bun.exe' OR Name='ghost.exe'" | Where-Object { $_.CommandLine -match 'ghost-daemon(-invisible)?\\.(vbs|cmd)' -or $_.CommandLine -match '\\\\.ghost\\\\state\\\\' -or $_.CommandLine -match '(?:^|[\\\\/\\s\\"])ghost(?:\\.exe)?\\"?\\s+daemon\\b' } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }`;
  spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
    { encoding: "utf8", timeout: 10_000 },
  );
}

/**
 * Register the Ghost scheduled task via `schtasks /Create /XML`. The XML
 * carries the LogonTrigger, InteractiveToken principal, and RestartOnFailure
 * settings that inline `/SC ONLOGON /RU /IT` cannot express. The temp XML
 * file is removed regardless of schtasks outcome — leaving it behind is
 * harmless but a temp-cleanup leak on every spawn-failure path.
 */
function createScheduledTask(invisibleVbs: string, taskUser: string): { stdout: string; stderr: string; status: number } {
  const xml = buildScheduledTaskXml(invisibleVbs, taskUser);
  const xmlPath = writeTaskXml(xml);
  try {
    return schtasks(["/Create", "/F", "/TN", TASK_NAME, "/XML", xmlPath]);
  } finally {
    try {
      rmSync(xmlPath, { force: true });
    } catch {
      // ignore — TMP cleanup is not load-bearing
    }
  }
}

export class SchtasksController implements ServiceController {
  // Logger accepted for interface parity with launchd/systemd controllers but
  // schtasks uses spawnSync which writes to its own stdout/stderr; no log needed.
  constructor(_log?: unknown) {}

  async install(opts: InstallOptions): Promise<InstallResult> {
    const taskUser = resolveTaskUser();
    if (!taskUser) {
      return {
        ok: false,
        definitionPath: "",
        warnings: [
          "Cannot register Ghost service: USERNAME environment variable is not set. " +
            "Re-run from a real user logon session (not SYSTEM / service account).",
        ],
      };
    }

    ensureLogDir(opts.logDir);

    const stateDir = join(homedir(), ".ghost", "state");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }

    // Pre-install cleanup of the legacy Startup-folder launcher. Prior
    // versions wrote a fallback launcher there when schtasks registration
    // failed. Without this an upgrade-in-place leaves both the Startup-folder
    // cmd.exe AND the new schtasks task firing on next logon.
    const legacy = legacyStartupPath();
    if (existsSync(legacy)) {
      rmSync(legacy, RM_RETRY_OPTS);
    }

    const launcher = launcherPath();
    writeFileSync(launcher, buildLauncherCmd(opts.bunPath, opts.execPath, opts.env), { encoding: "utf8" });

    const invisibleVbs = invisibleLauncherPath();
    writeFileSync(invisibleVbs, buildInvisibleVbs(launcher), { encoding: "utf8" });

    const create = createScheduledTask(invisibleVbs, taskUser);

    if (create.status !== 0) {
      return {
        ok: false,
        definitionPath: launcher,
        warnings: [`schtasks /Create failed: ${(create.stderr || create.stdout).trim()}`],
      };
    }

    const run = schtasks(["/Run", "/TN", TASK_NAME]);
    if (run.status !== 0) {
      return {
        ok: false,
        definitionPath: launcher,
        warnings: [`schtasks /Run failed: ${(run.stderr || run.stdout).trim()}`],
      };
    }

    return { ok: true, definitionPath: launcher };
  }

  async stop(): Promise<void> {
    // schtasks /End kills only the task's action root (wscript.exe). The
    // descendant ghost.exe (and cmd.exe shim on older launchers) survive as
    // orphans and the gateway stays up on port 15401. Pair every /End with
    // an explicit chain kill so the daemon actually stops.
    // See killOrphanedSupervisorChain() for the match arms.
    const result = schtasks(["/End", "/TN", TASK_NAME]);
    killOrphanedSupervisorChain();
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      // Tolerate "not running" — task is already stopped.
      if (!detail.toLowerCase().includes("not running") && !detail.toLowerCase().includes("not started")) {
        throw new Error(`schtasks /End failed: ${detail}`);
      }
    }
  }

  async restart(): Promise<void> {
    // End the running instance and kill the supervisor chain so the new
    // /Run starts from a clean slate. Without the chain kill, the orphaned
    // ghost.exe from the previous run keeps the port bound and the new
    // task's ghost.exe fails on EADDRINUSE.
    schtasks(["/End", "/TN", TASK_NAME]);
    killOrphanedSupervisorChain();
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    const result = schtasks(["/Run", "/TN", TASK_NAME]);
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout).trim();
      throw new Error(`schtasks /Run failed: ${detail}`);
    }
  }

  async uninstall(opts: UninstallOptions): Promise<UninstallResult> {
    // End running task (swallow errors). `schtasks /End` terminates the
    // task's action root — wscript.exe — but does NOT cascade to descendant
    // processes. The ghost.exe child (spawned by the cmd launcher) remains
    // alive and may still hold the log file open, which can block
    // the rm -rf of ~/.ghost/logs that runs later in this method.
    schtasks(["/End", "/TN", TASK_NAME]);

    // Defence in depth: kill any orphaned launcher chain matching our
    // command lines. PowerShell's Win32_Process.CommandLine filter is the
    // most reliable way to scope the kill — taskkill /IM is too coarse
    // (would terminate every wscript.exe on the machine) and /FI doesn't
    // support command-line matching.
    killOrphanedSupervisorChain();

    // Give Windows ~500ms to release the now-killed processes' file
    // handles on ghost.log / launcher .cmd before rmSync runs. rmSync calls
    // also use RM_RETRY_OPTS for defence-in-depth against late handle release.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));

    // Delete task registration (swallow errors).
    schtasks(["/Delete", "/F", "/TN", TASK_NAME]);

    // Remove launcher cmd file.
    const launcher = launcherPath();
    if (existsSync(launcher)) {
      rmSync(launcher, RM_RETRY_OPTS);
    }

    // Remove invisible-launcher VBScript wrapper.
    const invisibleVbs = invisibleLauncherPath();
    if (existsSync(invisibleVbs)) {
      rmSync(invisibleVbs, RM_RETRY_OPTS);
    }

    // Legacy cleanup: prior versions wrote a fallback launcher into the
    // Startup folder when schtasks registration failed. Remove if present
    // so a clean reinstall does not end up with two competing entry points.
    const legacy = legacyStartupPath();
    if (existsSync(legacy)) {
      rmSync(legacy, RM_RETRY_OPTS);
    }

    // Purge logs if requested.
    if (opts.purgeLogs) {
      const logDir = defaultLogDir();
      if (existsSync(logDir)) {
        rmSync(logDir, { recursive: true, ...RM_RETRY_OPTS });
      }
    }

    return { ok: true };
  }

  async status(): Promise<ServiceStatus> {
    // Use CSV format — machine-readable and locale-independent.
    const query = schtasks(["/Query", "/TN", TASK_NAME, "/V", "/FO", "CSV"]);

    if (query.status !== 0) {
      return "not-installed";
    }

    const output = query.stdout || query.stderr;

    // CSV output has a header row followed by data rows.
    // Find the "Status" column index from the header, then check its value.
    const lines = output.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length >= 2) {
      const headers = lines[0]!.split('","').map((h) => h.replace(/^"|"$/g, ""));
      const statusIdx = headers.findIndex((h) => h.toLowerCase() === "status");
      if (statusIdx >= 0) {
        const values = lines[1]!.split('","').map((v) => v.replace(/^"|"$/g, ""));
        if (values[statusIdx]?.toLowerCase() === "running") {
          return "running";
        }
        return "stopped";
      }
    }

    // Fallback: try English LIST format for older Windows versions.
    const fallback = schtasks(["/Query", "/TN", TASK_NAME, "/V", "/FO", "LIST"]);
    if (fallback.status !== 0) {
      return "not-installed";
    }
    const fallbackOutput = fallback.stdout || fallback.stderr;
    const statusMatch = fallbackOutput.match(/^Status:\s*(.+)$/im);
    if (statusMatch && statusMatch[1]?.trim().toLowerCase() === "running") {
      return "running";
    }

    return "stopped";
  }
}
