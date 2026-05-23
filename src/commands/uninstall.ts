import { existsSync as fsExistsSync, readFileSync, writeFileSync, unlinkSync, rmSync as fsRmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ServiceController } from "../services/os/controller.js";
import { DEFAULT_GATEWAY_PORT } from "../config/schema.js";
import { getConfigPath } from "../config/paths.js";
import { loadConfig } from "../config/loader.js";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface UninstallDeps {
  controller: ServiceController;
  /** Absolute path to the Ghost data directory (typically ~/.ghost). */
  dataDir: string;
  /** Absolute path to the user's home directory (for shell rc / .npmrc / ~/.bun/bin resolution). */
  home: string;
  /** Platform discriminator (injectable for tests). */
  platform: NodeJS.Platform;
  /**
   * Resolved gateway port for daemon detection. Caller resolves from
   * config.json / GHOST_GATEWAY_PORT env / DEFAULT_GATEWAY_PORT.
   */
  gatewayPort: number;
  isTTY: boolean;
  confirm: () => Promise<boolean>;
  existsSync: (path: string) => boolean;
  readFile: (path: string) => string;
  writeFile: (path: string, content: string) => void;
  unlink: (path: string) => void;
  rmSync: (path: string) => void;
  spawn: (cmd: string, args: string[]) => SpawnResult;
  log: (msg: string) => void;
  err: (msg: string) => void;
  exit: (code: number) => never;
}

export async function runUninstall(deps: UninstallDeps): Promise<void> {
  if (!deps.isTTY) {
    deps.err("ghost uninstall requires an interactive terminal.");
    return deps.exit(1);
  }

  const status = await deps.controller.status();
  const proceed = await deps.confirm();
  if (!proceed) return;

  let failures = 0;
  let anyProgress = false;

  // 1. Kill foreground daemons FIRST — they hold ~/.ghost/* file handles
  //    (sqlite WAL, session jsonl, etc.) which would make the service
  //    controller's `purgeLogs` fail with EBUSY on Windows, and `rmSync`
  //    fail later for the whole dataDir. Order matters: stop everything
  //    that could hold the directory, THEN tear down.
  try {
    const r = await stopForegroundGhostDaemons({
      home: deps.home,
      platform: deps.platform,
      spawn: deps.spawn,
      currentPid: process.pid,
      gatewayPort: deps.gatewayPort,
    });
    if (r.killed > 0) {
      deps.log(`✓ Stopped ${r.killed} foreground Ghost daemon process${r.killed === 1 ? "" : "es"}`);
      anyProgress = true;
    }
  } catch (e) {
    deps.err(`Failed to stop foreground daemons: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }

  // 2. Service teardown (OS-managed service only — launchers already handled by adapter).
  if (status !== "not-installed") {
    try {
      const r = await deps.controller.uninstall({ purgeLogs: true });
      if (r.ok) {
        deps.log("✓ Removed Ghost background service");
        anyProgress = true;
      } else {
        deps.err(`Service uninstall reported issues: ${r.warnings?.join("; ") ?? "unknown"}`);
        failures++;
      }
    } catch (e) {
      deps.err(`Failed to remove service: ${e instanceof Error ? e.message : String(e)}`);
      failures++;
    }
  }

  // 3. Remove data directory.
  if (deps.existsSync(deps.dataDir)) {
    try {
      deps.rmSync(deps.dataDir);
      deps.log(`✓ Removed ${deps.dataDir}`);
      anyProgress = true;
    } catch (e) {
      deps.err(`Failed to remove ${deps.dataDir}: ${e instanceof Error ? e.message : String(e)}`);
      failures++;
    }
  }

  // 4. Strip persistent PATH entry (shell rc on POSIX, User registry on Windows).
  try {
    const r = await stripPersistentPath({
      home: deps.home,
      platform: deps.platform,
      existsSync: deps.existsSync,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      unlink: deps.unlink,
      spawn: deps.spawn,
    });
    if (r.changed) {
      deps.log(deps.platform === "win32"
        ? "✓ Removed ~/.bun/bin from User PATH"
        : "✓ Removed Ghost PATH entries from shell rc");
      anyProgress = true;
    }
    for (const w of r.warnings) deps.err(w);
  } catch (e) {
    deps.err(`Failed to strip PATH entry: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }

  // 5. Strip ~/.npmrc sentinel block.
  try {
    const r = await stripNpmrcBlock({
      home: deps.home,
      existsSync: deps.existsSync,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      unlink: deps.unlink,
    });
    if (r.deleted) {
      deps.log(`✓ Removed empty ${deps.home}/.npmrc`);
      anyProgress = true;
    } else if (r.changed) {
      deps.log(`✓ Removed Ghost scope entry from ${deps.home}/.npmrc`);
      anyProgress = true;
    }
    for (const w of r.warnings ?? []) deps.err(w);
  } catch (e) {
    deps.err(`Failed to strip .npmrc: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }

  // 6. Remove bun global package.
  try {
    const r = await removeBunPackage({ packageName: "@hyperflow.fun/ghost", spawn: deps.spawn });
    if (r.ok) {
      deps.log(`✓ ${r.info}`);
      anyProgress = true;
    } else {
      deps.err(r.info);
      failures++;
    }
  } catch (e) {
    deps.err(`Failed to remove bun package: ${e instanceof Error ? e.message : String(e)}`);
    failures++;
  }

  // Summary.
  if (!anyProgress && failures === 0) {
    deps.log("Nothing to remove — Ghost was already uninstalled.");
    return;
  }

  deps.log("");
  if (failures > 0) {
    deps.err("Uninstall completed with errors — review messages above.");
    deps.log("(bun is kept — you may need it for other projects.)");
    return deps.exit(1);
  }
  deps.log("✓ Ghost fully uninstalled.");
  deps.log("(bun is kept — you may need it for other projects.)");
}

// ---------- Helper: stopForegroundGhostDaemons ----------

/**
 * Delay between SIGTERM and SIGKILL. Tests use mock.module to override this
 * module and set SIGKILL_DELAY_MS to 0, avoiding 1s waits per test case.
 */
export let SIGKILL_DELAY_MS = 1000;

/**
 * Delay after the final kill on Windows so the OS releases file handles
 * (sqlite WAL, ghost.log) before the caller's `rmSync`. Without this, the
 * unlink races TerminateProcess and fails with EBUSY even though the
 * process is already gone. POSIX releases handles synchronously, so this
 * is Windows-only.
 */
export let WIN_HANDLE_RELEASE_MS = 500;

export interface StopDaemonsDeps {
  home: string;
  platform: NodeJS.Platform;
  spawn: UninstallDeps["spawn"];
  /** Current process pid — must be excluded from the kill list so we don't self-terminate. */
  currentPid: number;
  /**
   * Ghost gateway port — used for port-owner-based daemon detection on
   * Windows (defence-in-depth against cmdline-substring matcher misses).
   * Caller resolves it from config.json / env / DEFAULT_GATEWAY_PORT.
   */
  gatewayPort: number;
}

export interface StopDaemonsResult {
  /** Number of pids we attempted to kill (not guaranteed dead — SIGKILL race is best-effort). */
  killed: number;
}

/**
 * Kill foreground Ghost daemon processes so they release file handles on
 * ~/.ghost/* before we remove the directory. Mirrors the installer's
 * `stop_ghost_daemon` / `Stop-GhostDaemon` behaviour.
 *
 * Two deliberate parity choices inherited from the shell installers:
 * 1. Command-line needle matching is substring-based (`includes`) — same as
 *    `pgrep -f`. A rare false-positive on an unrelated process that mentions
 *    `~/.bun/bin/ghost` or `~/.ghost/` in its command line is accepted as the
 *    price of not reinventing a narrower matcher that could miss real daemons.
 * 2. Kill errors are silently swallowed — mirrors `kill $pids 2>/dev/null || true`.
 *    In practice the most common error is ESRCH (process already exited); EPERM
 *    would only surface under cross-user setups that `install.sh --uninstall`
 *    also doesn't handle.
 */
export async function stopForegroundGhostDaemons(deps: StopDaemonsDeps): Promise<StopDaemonsResult> {
  const pids = deps.platform === "win32"
    ? findGhostDaemonPidsWindows(deps)
    : findGhostDaemonPidsPosix(deps);

  if (pids.length === 0) return { killed: 0 };

  if (deps.platform === "win32") {
    // taskkill /T tree-kills the process AND every descendant. Needed because
    // Bun's --watch mode spawns a child for each restart and only the parent
    // is in `pids`; process.kill on the parent leaves the child holding
    // ~/.ghost/* file handles. /F forces termination (TerminateProcess).
    for (const pid of pids) {
      deps.spawn("taskkill", ["/F", "/T", "/PID", String(pid)]);
    }
    // TerminateProcess returns before the OS releases the dead process's
    // file handles. A trailing sleep gives the kernel time to close them
    // so the caller's rmSync doesn't race into EBUSY.
    await Bun.sleep(WIN_HANDLE_RELEASE_MS);
    return { killed: pids.length };
  }

  // POSIX: SIGTERM, wait, then SIGKILL the survivors.
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already dead or not ours — parity w/ shell kill */ }
  }
  await Bun.sleep(SIGKILL_DELAY_MS);
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead or not ours — parity w/ shell kill */ }
  }
  return { killed: pids.length };
}

function findGhostDaemonPidsPosix(deps: StopDaemonsDeps): number[] {
  const result = deps.spawn("ps", ["-ax", "-o", "pid=,command="]);
  if (result.exitCode !== 0) return [];
  const needle1 = `${deps.home}/.bun/bin/ghost`;
  const needle2 = `${deps.home}/.ghost/`;
  const pids: number[] = [];
  for (const line of result.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!m) continue;
    const pid = parseInt(m[1]!, 10);
    if (!Number.isFinite(pid) || pid === deps.currentPid) continue;
    const cmdline = m[2]!;
    if (cmdline.includes(needle1) || cmdline.includes(needle2)) {
      pids.push(pid);
    }
  }
  return pids;
}

function findGhostDaemonPidsWindows(deps: StopDaemonsDeps): number[] {
  // PowerShell unified script — union of cmdline matches AND port owners.
  // Catches cases the cmdline-substring matcher misses — most importantly
  // `bun --watch src/index.ts daemon` invocations from a source checkout
  // whose cwd is not `~/.ghost` and whose argv0 is not `~/.bun/bin/ghost`.
  // Port number is injected at call time (resolved from config.json / env /
  // DEFAULT_GATEWAY_PORT) so non-default ports still get caught.
  const script = [
    "$ids = New-Object 'System.Collections.Generic.HashSet[int]';",
    `try { Get-NetTCPConnection -LocalPort ${deps.gatewayPort} -ErrorAction SilentlyContinue | ForEach-Object { [void]$ids.Add([int]$_.OwningProcess) } } catch {};`,
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '\\\\.bun\\\\bin\\\\ghost|\\\\.ghost\\\\' } | ForEach-Object { [void]$ids.Add([int]$_.ProcessId) };",
    "$ids",
  ].join(" ");
  const result = deps.spawn("powershell", ["-NoProfile", "-Command", script]);
  if (result.exitCode !== 0) return [];
  const pids = new Set<number>();
  for (const raw of result.stdout.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const pid = parseInt(trimmed, 10);
    if (!Number.isFinite(pid) || pid === deps.currentPid) continue;
    pids.add(pid);
  }
  return [...pids];
}

// ---------- Helper: removeBunPackage ----------

export interface RemoveBunPackageDeps {
  packageName: string;
  spawn: UninstallDeps["spawn"];
}

export interface RemoveBunPackageResult {
  ok: boolean;
  info: string;
}

export async function removeBunPackage(deps: RemoveBunPackageDeps): Promise<RemoveBunPackageResult> {
  const ls = deps.spawn("bun", ["pm", "ls", "-g"]);
  if (ls.exitCode !== 0) {
    const msg = (ls.stderr || ls.stdout).trim();
    // "Lockfile not found" = bun has never had any global install; benign.
    // Treat as "package absent" so a fresh-machine uninstall doesn't false-fail.
    if (/lockfile not found/i.test(msg)) {
      return { ok: true, info: `${deps.packageName} not found in bun global registry — nothing to remove` };
    }
    return { ok: false, info: `bun pm ls -g failed (exit ${ls.exitCode}): ${msg}` };
  }
  // Match the package name followed by '@' (versioned entry), end-of-line, or whitespace.
  // e.g. "├── @hyperflow.fun/ghost@0.0.2"
  const escaped = deps.packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const present = new RegExp(`${escaped}(@|$|\\s)`, "m").test(ls.stdout);
  if (!present) {
    return { ok: true, info: `${deps.packageName} not found in bun global registry — nothing to remove` };
  }
  const rm = deps.spawn("bun", ["remove", "-g", deps.packageName]);
  if (rm.exitCode !== 0) {
    return { ok: false, info: `bun remove -g ${deps.packageName} failed (exit ${rm.exitCode})` };
  }
  return { ok: true, info: `Removed ${deps.packageName}` };
}

// ---------- Helper: stripPersistentPath ----------

export interface StripPersistentPathDeps {
  home: string;
  platform: NodeJS.Platform;
  existsSync: UninstallDeps["existsSync"];
  readFile: UninstallDeps["readFile"];
  writeFile: UninstallDeps["writeFile"];
  unlink: UninstallDeps["unlink"];
  spawn: UninstallDeps["spawn"];
}

export interface StripPathResult {
  changed: boolean;
  warnings: string[];
}

const GHOST_RC_BEGIN = "# GHOST-BEGIN";
const GHOST_RC_END = "# GHOST-END";
const LEGACY_RC_MARKER = "# Ghost (Bun global bin)";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function stripPersistentPath(deps: StripPersistentPathDeps): Promise<StripPathResult> {
  if (deps.platform === "win32") {
    return stripWindowsUserPath(deps);
  }
  return stripPosixShellRcBlocks(deps);
}

function stripPosixShellRcBlocks(deps: StripPersistentPathDeps): StripPathResult {
  const rcFiles = [".bashrc", ".zshrc", ".profile"].map(f => `${deps.home}/${f}`);
  const warnings: string[] = [];
  let changed = false;

  for (const rcPath of rcFiles) {
    if (!deps.existsSync(rcPath)) continue;
    const original = deps.readFile(rcPath);
    const hasSentinel = original.includes(GHOST_RC_BEGIN);
    const hasLegacy = original.includes(LEGACY_RC_MARKER);
    if (!hasSentinel && !hasLegacy) continue;

    let cleaned = original;
    // Strip the full sentinel block (non-greedy, across lines).
    cleaned = cleaned.replace(
      new RegExp(`^${escapeRe(GHOST_RC_BEGIN)}[\\s\\S]*?^${escapeRe(GHOST_RC_END)}\\n?`, "gm"),
      "",
    );
    // Strip the legacy single-marker line.
    cleaned = cleaned.replace(new RegExp(`^.*${escapeRe(LEGACY_RC_MARKER)}.*\\n?`, "gm"), "");
    // Strip any direct `export PATH="…/.bun/bin:$PATH"` left behind.
    cleaned = cleaned.replace(
      new RegExp(`^export PATH="${escapeRe(deps.home)}/\\.bun/bin:\\$PATH"\\n?`, "gm"),
      "",
    );

    if (cleaned !== original) {
      deps.writeFile(rcPath, cleaned);
      changed = true;
    } else {
      // Residual marker remained (unmatched GHOST-BEGIN without END, etc.).
      warnings.push(`residual GHOST-managed text in ${rcPath} (user-edited?)`);
      continue;
    }

    // Verification pass (mirrors install.sh invariant).
    const verify = deps.readFile(rcPath);
    if (verify.includes(GHOST_RC_BEGIN) || verify.includes(LEGACY_RC_MARKER) ||
        verify.includes(`${deps.home}/.bun/bin:$PATH`)) {
      warnings.push(`Cleaned ${rcPath} but some Ghost-managed lines remain`);
    }
  }

  return { changed, warnings };
}

function stripWindowsUserPath(deps: StripPersistentPathDeps): StripPathResult {
  const bunBin = `${deps.home}\\.bun\\bin`;
  // Inline PowerShell — reads HKCU\Environment\Path, removes the bunBin entry
  // (exact match, case-insensitive comparison), writes back. Symmetric with
  // how install.ps1 writes the entry during install.
  const jsonBun = JSON.stringify(bunBin);   // safely quoted for PS
  const script = [
    `$bunBin = ${jsonBun}`,
    `$userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')`,
    `if (-not $userPath) { exit 0 }`,
    `$entries = ($userPath -split ';') | Where-Object { $_ -and ($_ -ne $bunBin) }`,
    `[Environment]::SetEnvironmentVariable('PATH', ($entries -join ';'), 'User')`,
    `exit 0`,
  ].join("; ");

  const result = deps.spawn("powershell", ["-NoProfile", "-Command", script]);
  if (result.exitCode !== 0) {
    const msg = (result.stderr || result.stdout).trim();
    return { changed: false, warnings: [`PowerShell PATH strip failed (exit ${result.exitCode}): ${msg}`] };
  }
  return { changed: true, warnings: [] };
}

// ---------- Helper: stripNpmrcBlock ----------

export interface StripNpmrcDeps {
  home: string;
  existsSync: UninstallDeps["existsSync"];
  readFile: UninstallDeps["readFile"];
  writeFile: UninstallDeps["writeFile"];
  unlink: UninstallDeps["unlink"];
}

export interface StripNpmrcResult {
  changed: boolean;
  deleted: boolean;
  warnings?: string[];
}

const GHOST_NPMRC_BEGIN = "# GHOST-NPMRC-BEGIN";
const GHOST_NPMRC_END = "# GHOST-NPMRC-END";

export async function stripNpmrcBlock(deps: StripNpmrcDeps): Promise<StripNpmrcResult> {
  const path = `${deps.home}/.npmrc`;
  if (!deps.existsSync(path)) return { changed: false, deleted: false };

  const original = deps.readFile(path);
  if (!original.includes(GHOST_NPMRC_BEGIN)) return { changed: false, deleted: false };

  const cleaned = original.replace(
    new RegExp(`^${escapeRe(GHOST_NPMRC_BEGIN)}[\\s\\S]*?^${escapeRe(GHOST_NPMRC_END)}\\n?`, "gm"),
    "",
  );
  if (cleaned === original) {
    // Unmatched BEGIN without END — leave untouched.
    return { changed: false, deleted: false };
  }
  if (cleaned.trim() === "") {
    deps.unlink(path);
    return { changed: true, deleted: true };
  }
  deps.writeFile(path, cleaned);
  return { changed: true, deleted: false };
}

/**
 * Resolve the gateway port for daemon detection. Reuses loadConfig() so
 * env overrides, schema validation, and migrations all apply identically
 * to the runtime daemon. Any failure (missing config, parse error, etc.)
 * falls through to the schema default — uninstall must work even if the
 * config is broken or absent.
 */
export function resolveGatewayPortForUninstall(): number {
  try {
    return loadConfig(getConfigPath()).gateway.port;
  } catch {
    return DEFAULT_GATEWAY_PORT;
  }
}

export async function runUninstallCli(): Promise<void> {
  const { resolveServiceController } = await import("../services/os/controller.js");
  const { createRootLogger } = await import("../logger.js");
  const { confirm, isCancel } = await import("@clack/prompts");
  const cliLogger = await createRootLogger(0);
  const controller = resolveServiceController(cliLogger.child({ module: "service" }));
  const home = homedir();
  const dataDir = join(home, ".ghost");
  const gatewayPort = resolveGatewayPortForUninstall();

  // Print the pre-confirm summary. Probe status so the summary only lists
  // items that actually exist.
  const status = await controller.status();
  console.log("");
  console.log("Ghost uninstall will remove:");
  if (status !== "not-installed") {
    console.log("  · The Ghost background service");
  }
  if (fsExistsSync(dataDir)) {
    console.log(`  · All data in ${dataDir} (config, database, memory, sessions, logs, credentials)`);
  }
  console.log("");

  await runUninstall({
    controller,
    dataDir,
    home,
    platform: process.platform,
    gatewayPort,
    isTTY: Boolean(process.stdin.isTTY),
    confirm: async () => {
      const r = await confirm({
        message: "Proceed with uninstall? This cannot be undone.",
        initialValue: false,
      });
      return !isCancel(r) && r === true;
    },
    existsSync: fsExistsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    writeFile: (p, content) => writeFileSync(p, content, "utf8"),
    unlink: (p) => unlinkSync(p),
    // Retry on Windows EBUSY: sqlite WAL / cwd locks / pino log handles
    // sometimes survive a few hundred ms after the holding process exits.
    // fs.rmSync's native retry loop is more reliable than a single attempt.
    rmSync: (p) => fsRmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
    spawn: (cmd, args) => {
      const r = Bun.spawnSync([cmd, ...args], { stdout: "pipe", stderr: "pipe" });
      return {
        exitCode: r.exitCode ?? -1,
        stdout: new TextDecoder().decode(r.stdout),
        stderr: new TextDecoder().decode(r.stderr),
      };
    },
    log: (m) => console.log(m),
    err: (m) => console.error(m),
    exit: (code) => process.exit(code),
  });
}
