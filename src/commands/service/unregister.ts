/**
 * `ghost service unregister` — remove the OS service registration only.
 *
 * Unlike `ghost uninstall` (which also deletes ~/.ghost and the bun package),
 * this surgically unregisters the platform service and leaves all config, data,
 * and credentials intact. Pure core (`runServiceUnregister`) is injectable; the
 * `…Cli` wrapper wires the real controller and confirm prompt.
 */

import type { ServiceController, UninstallResult } from "../../services/os/controller.js";

export interface ServiceUnregisterDeps {
  controller: ServiceController;
  isTTY: boolean;
  /** Bypass the interactive confirm (for scripts / non-interactive use). */
  yes: boolean;
  /** Returns true on confirm, false on decline/cancel. */
  confirm: () => Promise<boolean>;
  log: (msg: string) => void;
  err: (msg: string) => void;
  /** Must not return — callers rely on process.exit-like semantics. */
  exit: (code: number) => never;
}

export async function runServiceUnregister(deps: ServiceUnregisterDeps): Promise<void> {
  const status = await deps.controller.status();
  if (status === "not-installed") {
    deps.log("Ghost service is not registered. Nothing to unregister.");
    return;
  }

  if (!deps.yes) {
    if (!deps.isTTY) {
      deps.err("ghost service unregister requires an interactive terminal (or pass --yes).");
      return deps.exit(1);
    }
    const proceed = await deps.confirm();
    if (!proceed) return;
  }

  let result: UninstallResult;
  try {
    result = await deps.controller.uninstall({});
  } catch (e) {
    deps.err(`Failed to unregister Ghost service: ${e instanceof Error ? e.message : String(e)}`);
    return deps.exit(1);
  }

  for (const w of result.warnings ?? []) deps.err(w);
  if (!result.ok) {
    deps.err("Ghost service unregistration failed. Run 'ghost doctor' for details.");
    return deps.exit(1);
  }

  deps.log("✓ Ghost service unregistered. Config and data in ~/.ghost are preserved.");
}

export async function runServiceUnregisterCli(opts: { yes: boolean }): Promise<void> {
  const { resolveServiceController } = await import("../../services/os/controller.js");
  const { createRootLogger } = await import("../../logger.js");
  const { confirm, isCancel } = await import("@clack/prompts");

  const cliLogger = await createRootLogger(0);
  let controller: ServiceController;
  try {
    controller = resolveServiceController(cliLogger.child({ module: "service" }));
  } catch (e) {
    console.error(
      `Service management is not available on this platform: ${e instanceof Error ? e.message : String(e)}`,
    );
    return process.exit(1);
  }

  await runServiceUnregister({
    controller,
    isTTY: Boolean(process.stdin.isTTY),
    yes: opts.yes,
    confirm: async () => {
      const r = await confirm({
        message: "Unregister the Ghost service? (config and data are preserved)",
        initialValue: false,
      });
      return !isCancel(r) && r === true;
    },
    log: (m) => console.log(m),
    err: (m) => console.error(m),
    exit: (code) => process.exit(code),
  });
}
