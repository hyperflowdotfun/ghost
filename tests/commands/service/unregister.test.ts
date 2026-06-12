import { describe, test, expect, mock } from "bun:test";
import {
  runServiceUnregister,
  type ServiceUnregisterDeps,
} from "../../../src/commands/service/unregister.js";
import type {
  ServiceController,
  ServiceStatus,
  UninstallResult,
} from "../../../src/services/os/controller.js";

function makeDeps(
  overrides: Partial<ServiceUnregisterDeps> & {
    status: ServiceStatus;
    uninstallResult?: UninstallResult | (() => Promise<UninstallResult>);
  },
): {
  deps: ServiceUnregisterDeps;
  logs: string[];
  errs: string[];
  exits: number[];
  controller: ServiceController;
} {
  const logs: string[] = [];
  const errs: string[] = [];
  const exits: number[] = [];
  const fixedResult =
    typeof overrides.uninstallResult === "function" ? undefined : overrides.uninstallResult;
  const uninstallImpl: () => Promise<UninstallResult> =
    typeof overrides.uninstallResult === "function"
      ? overrides.uninstallResult
      : async () => fixedResult ?? { ok: true };
  const controller: ServiceController = {
    install: mock(async () => ({ ok: true, definitionPath: "" })),
    uninstall: mock(uninstallImpl),
    stop: mock(async () => {}),
    restart: mock(async () => {}),
    status: mock(async () => overrides.status),
  };
  const { status: _s, uninstallResult: _r, ...rest } = overrides;
  const deps: ServiceUnregisterDeps = {
    controller,
    isTTY: true,
    yes: false,
    confirm: async () => true,
    log: (m) => logs.push(m),
    err: (m) => errs.push(m),
    exit: (code) => {
      exits.push(code);
      throw new Error(`__EXIT__${code}`);
    },
    ...rest,
  };
  return { deps, logs, errs, exits, controller };
}

describe("runServiceUnregister", () => {
  test("not-installed → nothing to do, uninstall not called", async () => {
    const { deps, logs, controller } = makeDeps({ status: "not-installed" });
    await runServiceUnregister(deps);
    expect(controller.uninstall).toHaveBeenCalledTimes(0);
    expect(logs.some((l) => l.includes("not registered"))).toBe(true);
  });

  test("--yes bypasses confirm → uninstall called, success", async () => {
    const confirm = mock(async () => true);
    const { deps, logs, controller } = makeDeps({ status: "running", yes: true, confirm });
    await runServiceUnregister(deps);
    expect(confirm).toHaveBeenCalledTimes(0);
    expect(controller.uninstall).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.startsWith("✓ Ghost service unregistered"))).toBe(true);
  });

  test("no --yes + non-TTY → errors and exits 1, uninstall not called", async () => {
    const { deps, errs, exits, controller } = makeDeps({
      status: "running",
      isTTY: false,
    });
    await expect(runServiceUnregister(deps)).rejects.toThrow("__EXIT__1");
    expect(exits).toEqual([1]);
    expect(errs.some((e) => e.includes("interactive terminal"))).toBe(true);
    expect(controller.uninstall).toHaveBeenCalledTimes(0);
  });

  test("TTY + decline → uninstall not called", async () => {
    const { deps, controller } = makeDeps({ status: "running", confirm: async () => false });
    await runServiceUnregister(deps);
    expect(controller.uninstall).toHaveBeenCalledTimes(0);
  });

  test("TTY + accept → uninstall called (no purge, data preserved)", async () => {
    const { deps, controller } = makeDeps({ status: "running" });
    await runServiceUnregister(deps);
    expect(controller.uninstall).toHaveBeenCalledTimes(1);
    expect(controller.uninstall).toHaveBeenCalledWith({});
  });

  test("uninstall throws → errors and exits 1", async () => {
    const { deps, errs, exits } = makeDeps({
      status: "stopped",
      yes: true,
      uninstallResult: async () => {
        throw new Error("bootout failed");
      },
    });
    await expect(runServiceUnregister(deps)).rejects.toThrow("__EXIT__1");
    expect(exits).toEqual([1]);
    expect(errs.some((e) => e.includes("bootout failed"))).toBe(true);
  });
});
