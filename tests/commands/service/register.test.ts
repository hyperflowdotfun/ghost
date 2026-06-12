import { describe, test, expect, mock } from "bun:test";
import {
  runServiceRegister,
  type ServiceRegisterDeps,
} from "../../../src/commands/service/register.js";
import type {
  InstallOptions,
  InstallResult,
  ServiceController,
  ServiceStatus,
} from "../../../src/services/os/controller.js";

const INSTALL_OPTS: InstallOptions = {
  execPath: "/home/u/.bun/bin/ghost",
  bunPath: "/home/u/.bun/bin/bun",
  logDir: "/home/u/.ghost/logs",
  env: { PATH: "/usr/bin" },
};

function makeDeps(
  overrides: Partial<ServiceRegisterDeps> & {
    status: ServiceStatus;
    installResult?: InstallResult | (() => Promise<InstallResult>);
  },
): {
  deps: ServiceRegisterDeps;
  logs: string[];
  errs: string[];
  exits: number[];
  controller: ServiceController;
} {
  const logs: string[] = [];
  const errs: string[] = [];
  const exits: number[] = [];
  const fixedResult =
    typeof overrides.installResult === "function" ? undefined : overrides.installResult;
  const installImpl: () => Promise<InstallResult> =
    typeof overrides.installResult === "function"
      ? overrides.installResult
      : async () => fixedResult ?? { ok: true, definitionPath: "/unit" };
  const controller: ServiceController = {
    install: mock(installImpl),
    uninstall: mock(async () => ({ ok: true })),
    stop: mock(async () => {}),
    restart: mock(async () => {}),
    status: mock(async () => overrides.status),
  };
  const { status: _s, installResult: _r, ...rest } = overrides;
  const deps: ServiceRegisterDeps = {
    controller,
    installOpts: INSTALL_OPTS,
    platform: "linux",
    execPath: INSTALL_OPTS.execPath,
    execExists: true,
    enableLinger: undefined,
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

describe("runServiceRegister", () => {
  test("not-installed → installs fresh, no uninstall", async () => {
    const { deps, logs, controller } = makeDeps({ status: "not-installed", platform: "darwin" });
    await runServiceRegister(deps);
    expect(controller.uninstall).toHaveBeenCalledTimes(0);
    expect(controller.install).toHaveBeenCalledTimes(1);
    expect(logs.some((l) => l.startsWith("✓ Ghost service registered"))).toBe(true);
  });

  test("already installed → uninstall then install (idempotent replace)", async () => {
    const { deps, controller } = makeDeps({ status: "running", platform: "darwin" });
    await runServiceRegister(deps);
    expect(controller.uninstall).toHaveBeenCalledTimes(1);
    expect(controller.install).toHaveBeenCalledTimes(1);
  });

  test("already installed but uninstall throws → errors and exits 1, no install", async () => {
    const { deps, errs, exits, controller } = makeDeps({ status: "running", platform: "darwin" });
    (controller.uninstall as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new Error("disable failed");
    });
    await expect(runServiceRegister(deps)).rejects.toThrow("__EXIT__1");
    expect(exits).toEqual([1]);
    expect(errs.some((e) => e.includes("disable failed"))).toBe(true);
    expect(controller.install).toHaveBeenCalledTimes(0);
  });

  test("missing executable → warns but still installs", async () => {
    const { deps, errs, controller } = makeDeps({
      status: "not-installed",
      execExists: false,
      platform: "darwin",
    });
    await runServiceRegister(deps);
    expect(errs.some((e) => e.includes("not found"))).toBe(true);
    expect(controller.install).toHaveBeenCalledTimes(1);
  });

  test("linux + linger not enabled → surfaces warning, still installs", async () => {
    const enableLinger = mock(async () => ({ enabled: false, warning: "linger off" }));
    const { deps, errs, controller } = makeDeps({
      status: "not-installed",
      platform: "linux",
      enableLinger,
    });
    await runServiceRegister(deps);
    expect(enableLinger).toHaveBeenCalledTimes(1);
    expect(errs).toContain("linger off");
    expect(controller.install).toHaveBeenCalledTimes(1);
  });

  test("non-linux does not invoke linger", async () => {
    const enableLinger = mock(async () => ({ enabled: true }));
    const { deps } = makeDeps({ status: "not-installed", platform: "darwin", enableLinger });
    await runServiceRegister(deps);
    expect(enableLinger).toHaveBeenCalledTimes(0);
  });

  test("install throws → errors and exits 1", async () => {
    const { deps, errs, exits } = makeDeps({
      status: "not-installed",
      platform: "darwin",
      installResult: async () => {
        throw new Error("systemctl boom");
      },
    });
    await expect(runServiceRegister(deps)).rejects.toThrow("__EXIT__1");
    expect(exits).toEqual([1]);
    expect(errs.some((e) => e.includes("systemctl boom"))).toBe(true);
  });

  test("install returns ok:false → errors and exits 1", async () => {
    const { deps, exits } = makeDeps({
      status: "not-installed",
      platform: "darwin",
      installResult: { ok: false, definitionPath: "/unit", warnings: ["bad"] },
    });
    await expect(runServiceRegister(deps)).rejects.toThrow("__EXIT__1");
    expect(exits).toEqual([1]);
  });
});
