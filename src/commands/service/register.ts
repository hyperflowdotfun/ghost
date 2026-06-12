/**
 * `ghost service register` — register Ghost as an OS auto-start service.
 *
 * Surgical counterpart to the onboard wizard's service step: it installs the
 * platform service (systemd / launchd / schtasks) without re-running onboard or
 * touching config. Registration is idempotent — if a service is already
 * registered it is removed first, then installed fresh, so the registration
 * always reflects the currently resolved exec/bun paths. Pure core
 * (`runServiceRegister`) is fully injectable; the `…Cli` wrapper wires the real
 * controller, path resolution, and prompts.
 */

import type { InstallOptions, InstallResult, ServiceController } from "../../services/os/controller.js";

export interface ServiceRegisterDeps {
  controller: ServiceController;
  installOpts: InstallOptions;
  platform: NodeJS.Platform;
  /** Absolute path to the resolved `ghost` executable (for the missing-binary warning). */
  execPath: string;
  /** Whether `execPath` exists on disk. */
  execExists: boolean;
  /**
   * Enable systemd lingering (Linux only, best-effort). Resolves to whether
   * linger is active plus an optional warning. Omitted on non-Linux platforms.
   */
  enableLinger?: () => Promise<{ enabled: boolean; warning?: string }>;
  log: (msg: string) => void;
  err: (msg: string) => void;
  /** Must not return — callers rely on process.exit-like semantics. */
  exit: (code: number) => never;
}

export async function runServiceRegister(deps: ServiceRegisterDeps): Promise<void> {
  // Idempotent: a prior registration is torn down first so install always
  // picks up the freshly resolved exec/bun paths.
  const status = await deps.controller.status();
  if (status !== "not-installed") {
    deps.log("Replacing the existing Ghost service registration...");
    try {
      await deps.controller.uninstall({});
    } catch (e) {
      deps.err(
        `Failed to remove the existing Ghost service: ${e instanceof Error ? e.message : String(e)}`,
      );
      return deps.exit(1);
    }
  }

  if (!deps.execExists) {
    deps.err(`Ghost executable not found at ${deps.execPath} — service may fail to start.`);
  }

  // Linux linger is best-effort: without it systemd kills the user service on
  // logout. A failure here never blocks registration (service still runs while
  // the user is logged in).
  if (deps.platform === "linux" && deps.enableLinger) {
    const linger = await deps.enableLinger();
    if (!linger.enabled && linger.warning) {
      deps.err(linger.warning);
    }
  }

  let result: InstallResult;
  try {
    result = await deps.controller.install(deps.installOpts);
  } catch (e) {
    deps.err(`Failed to register Ghost service: ${e instanceof Error ? e.message : String(e)}`);
    return deps.exit(1);
  }

  for (const w of result.warnings ?? []) deps.err(w);
  if (!result.ok) {
    deps.err("Ghost service registration failed. Run 'ghost doctor' for details.");
    return deps.exit(1);
  }

  deps.log("✓ Ghost service registered. Run 'ghost status' to verify it is running.");
}

export async function runServiceRegisterCli(): Promise<void> {
  const { existsSync } = await import("node:fs");
  const { resolveServiceController } = await import("../../services/os/controller.js");
  const { resolveGhostExecPath, resolveBunPath, defaultLogDir } = await import(
    "../../services/os/utils.js"
  );
  const { createRootLogger } = await import("../../logger.js");

  const cliLogger = await createRootLogger(0);
  let controller: ServiceController;
  try {
    controller = resolveServiceController(cliLogger.child({ module: "service" }));
  } catch (e) {
    console.error(
      `Service registration is not available on this platform: ${e instanceof Error ? e.message : String(e)}`,
    );
    return process.exit(1);
  }

  const execPath = resolveGhostExecPath();

  const enableLinger =
    process.platform === "linux"
      ? async () => {
          const { enableLinger: doEnableLinger } = await import(
            "../../services/os/systemd-linger.js"
          );
          const { confirm, isCancel } = await import("@clack/prompts");
          const isTTY = Boolean(process.stdin.isTTY);
          const r = await doEnableLinger({
            confirmSudo: async () => {
              // Non-interactive: skip the sudo phase rather than hang.
              if (!isTTY) return false;
              const answer = await confirm({
                message:
                  "Enable systemd lingering (keeps Ghost running after logout)? May require sudo.",
                initialValue: true,
              });
              return !isCancel(answer) && answer === true;
            },
          });
          return { enabled: r.enabled, warning: r.warning };
        }
      : undefined;

  await runServiceRegister({
    controller,
    installOpts: {
      execPath,
      bunPath: resolveBunPath(),
      logDir: defaultLogDir(),
      env: {
        // Service managers don't inherit the login shell PATH — inject it so
        // tools the daemon shells out to (e.g. `claude` CLI) stay findable.
        PATH: process.env.PATH ?? "",
      },
    },
    platform: process.platform,
    execPath,
    execExists: existsSync(execPath),
    enableLinger,
    log: (m) => console.log(m),
    err: (m) => console.error(m),
    exit: (code) => process.exit(code),
  });
}
