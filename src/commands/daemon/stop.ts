import type { ServiceController } from "../../services/os/controller.js";

export interface DaemonStopDeps {
  controller: ServiceController;
  isTTY: boolean;
  /** Returns true on confirm, false on decline/cancel. */
  confirm: () => Promise<boolean>;
  log: (msg: string) => void;
  err: (msg: string) => void;
  /** Must not return — callers rely on process.exit-like semantics. */
  exit: (code: number) => never;
}

export async function runDaemonStop(deps: DaemonStopDeps): Promise<void> {
  const status = await deps.controller.status();
  if (status === "not-installed") {
    deps.log("Ghost service is not installed. Nothing to stop.");
    return;
  }
  if (status === "stopped") {
    deps.log("Ghost service is already stopped.");
    return;
  }
  // status === "running"
  if (!deps.isTTY) {
    deps.err("ghost daemon stop requires an interactive terminal.");
    return deps.exit(1);
  }
  const proceed = await deps.confirm();
  if (!proceed) return;
  try {
    await deps.controller.stop();
  } catch (e) {
    deps.err(`Failed to stop Ghost service: ${e instanceof Error ? e.message : String(e)}`);
    return deps.exit(1);
  }
  deps.log("✓ Ghost service stopped.");
}

export async function runDaemonStopCli(): Promise<void> {
  const { resolveServiceController } = await import("../../services/os/controller.js");
  const { createRootLogger } = await import("../../logger.js");
  const { confirm, isCancel } = await import("@clack/prompts");
  const cliLogger = await createRootLogger(0);
  const controller = resolveServiceController(cliLogger.child({ module: "service" }));
  await runDaemonStop({
    controller,
    isTTY: Boolean(process.stdin.isTTY),
    confirm: async () => {
      const r = await confirm({ message: "Stop the Ghost service?", initialValue: false });
      return !isCancel(r) && r === true;
    },
    log: (m) => console.log(m),
    err: (m) => console.error(m),
    exit: (code) => process.exit(code),
  });
}
