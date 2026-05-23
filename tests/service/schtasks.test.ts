import { describe, test, expect } from "bun:test";
import {
  buildLauncherCmd,
  buildInvisibleVbs,
  buildScheduledTaskXml,
  SchtasksController,
} from "../../src/services/os/schtasks.js";

describe("buildLauncherCmd", () => {
  test("contains @echo off header", () => {
    const cmd = buildLauncherCmd("C:\\Users\\trader\\.bun\\bin\\bun.exe", "C:\\Users\\trader\\.bun\\bin\\ghost.exe");
    expect(cmd).toContain("@echo off");
  });

  test("contains cd /d into .ghost directory", () => {
    const cmd = buildLauncherCmd("C:\\Users\\trader\\.bun\\bin\\bun.exe", "C:\\Users\\trader\\.bun\\bin\\ghost.exe");
    expect(cmd).toContain("cd /d");
    expect(cmd).toContain(".ghost");
  });

  test("invokes ghost.exe directly without bun prefix", () => {
    const bunPath = "C:\\Users\\trader\\.bun\\bin\\bun.exe";
    const execPath = "C:\\Users\\trader\\.bun\\bin\\ghost.exe";
    const cmd = buildLauncherCmd(bunPath, execPath);
    // Windows .exe shims embed the runtime — running `bun ghost.exe` parses the
    // PE header as JavaScript and crashes with "Expected ';'".
    expect(cmd).toContain(`"${execPath}" daemon`);
    expect(cmd).not.toContain(bunPath);
  });

  test("does NOT redirect stdout/stderr — in-process logger owns the log file", () => {
    // The cmd launcher no longer contains any stdout/stderr redirect.
    // The in-process rotating logger opens ghost.log directly from the daemon
    // process, avoiding FILE_SHARE_READ lock conflicts. Detached task drops
    // residual stdout to NUL.
    const cmd = buildLauncherCmd("bun.exe", "C:\\ghost.exe");
    expect(cmd).not.toContain("1>>");
    expect(cmd).not.toContain("2>&1");
    expect(cmd).not.toContain("GHOST_LOG");
    expect(cmd).not.toContain("daemon.stdout.log");
    expect(cmd).not.toContain("daemon.stderr.log");
    expect(cmd).not.toContain("2>>");
  });

  test("uses CRLF line endings", () => {
    const cmd = buildLauncherCmd("C:\\bun.exe", "C:\\ghost.exe");
    // Split by \r\n — all lines should be separated this way.
    const lines = cmd.split("\r\n");
    expect(lines.length).toBeGreaterThanOrEqual(4);
  });

  test("contains rem comment with description", () => {
    const cmd = buildLauncherCmd("bun.exe", "ghost.exe");
    expect(cmd).toContain("rem Ghost daemon launcher");
  });

  test("excludes PATH from env set lines", () => {
    const cmd = buildLauncherCmd("bun.exe", "ghost.exe", {
      PATH: "C:\\Windows\\system32;C:\\Windows",
      GHOST_LOG_DIR: "C:\\Users\\test\\.ghost\\logs",
    });
    expect(cmd).not.toContain("set \"PATH=");
    expect(cmd).toContain('set "GHOST_LOG_DIR=C:\\Users\\test\\.ghost\\logs"');
  });

  test("single-shot launcher: env passthrough, NUL stdin, no redirect, no supervisor loop", () => {
    const cmd = buildLauncherCmd(
      "C:\\ignored\\bun.exe",
      "C:\\Users\\test\\.bun\\bin\\ghost.exe",
      { FOO: "bar" },
    );

    // No supervisor loop constructs — cmd.exe exits after ghost.exe returns.
    expect(cmd).not.toContain(":loop");
    expect(cmd).not.toContain("goto loop");
    expect(cmd).not.toContain("timeout /t 5");
    expect(cmd).not.toContain("[supervisor]");

    // Trailing `exit /b %ERRORLEVEL%` propagates ghost.exe's non-zero status
    // to Task Scheduler so RestartOnFailure actually fires on crash.
    expect(cmd).toContain("exit /b %ERRORLEVEL%");

    // `<nul` neutralises process.stdin.isTTY under schtasks-launched cmd.exe
    // so guardAgainstRunningService skips its interactive prompt.
    expect(cmd).toContain("daemon <nul");

    // No stdout/stderr redirect — in-process logger owns the log file.
    expect(cmd).not.toContain("1>>");
    expect(cmd).not.toContain("2>&1");
    expect(cmd).not.toContain("GHOST_LOG");

    // Daemon invocation: just the executable + daemon + NUL stdin.
    expect(cmd).toContain('"C:\\Users\\test\\.bun\\bin\\ghost.exe" daemon <nul');

    // Env passthrough.
    expect(cmd).toContain('set "FOO=bar"');

    // No legacy separate-stream redirects.
    expect(cmd).not.toContain("daemon.stdout.log");
    expect(cmd).not.toContain("daemon.stderr.log");
    expect(cmd).not.toContain("2>>");
  });
});

describe("buildInvisibleVbs", () => {
  const launcher = "C:\\Users\\trader\\.ghost\\state\\ghost-daemon.cmd";

  test("uses WScript.Shell.Run with hidden style and wait", () => {
    const vbs = buildInvisibleVbs(launcher);
    // Style 0 = SW_HIDE, wait = True so exit code propagates. Fire-and-forget
    // (False) would break crash detection.
    expect(vbs).toContain('shell.Run("""' + launcher + '""", 0, True)');
  });

  test("propagates exit code via WScript.Quit", () => {
    const vbs = buildInvisibleVbs(launcher);
    expect(vbs).toContain("WScript.Quit exitCode");
  });

  test("restarts ONLY on JS crash codes 100 and 101", () => {
    const vbs = buildInvisibleVbs(launcher);
    // Loop continues only on uncaughtException (100) / unhandledRejection (101).
    // Operator stop (0), external kill (1), config errors must NOT respawn.
    expect(vbs).toContain("If exitCode <> 100 And exitCode <> 101 Then Exit Do");
  });

  test("poison-pill abort after 5 consecutive crash-restarts", () => {
    const vbs = buildInvisibleVbs(launcher);
    expect(vbs).toContain("attempts >= 5");
  });

  test("5-second back-off between restart attempts", () => {
    const vbs = buildInvisibleVbs(launcher);
    expect(vbs).toContain("WScript.Sleep 5000");
  });

  test("escapes embedded double quotes in launcher path", () => {
    // NTFS forbids " in filenames so this is defensive only.
    const vbs = buildInvisibleVbs('C:\\a"b.cmd');
    expect(vbs).toContain('C:\\a""b.cmd');
  });
});

describe("buildScheduledTaskXml", () => {
  const vbs = "C:\\Users\\trader\\.ghost\\state\\ghost-daemon-invisible.vbs";

  test("declares Task Scheduler 1.2 schema with UTF-16 encoding", () => {
    const xml = buildScheduledTaskXml(vbs, "DESKTOP\\trader");
    expect(xml).toContain(`<?xml version="1.0" encoding="UTF-16"?>`);
    expect(xml).toContain(`<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`);
  });

  test("registers wscript.exe + .vbs as the Exec action (invisible console)", () => {
    const xml = buildScheduledTaskXml(vbs, "DESKTOP\\trader");
    expect(xml).toContain("<Command>wscript.exe</Command>");
    expect(xml).toContain(`<Arguments>"${vbs}"</Arguments>`);
  });

  test("uses LogonTrigger with the resolved UserId — ONLOGON behaviour", () => {
    const xml = buildScheduledTaskXml(vbs, "DESKTOP\\trader");
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<UserId>DESKTOP\\trader</UserId>");
  });

  test("InteractiveToken principal — no stored password (= /IT, no /NP needed)", () => {
    const xml = buildScheduledTaskXml(vbs, "DESKTOP\\trader");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
  });

  test("RestartOnFailure: 3 retries × 1-minute interval — crash recovery", () => {
    const xml = buildScheduledTaskXml(vbs, "DESKTOP\\trader");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Count>3</Count>");
  });

  test("AllowHardTerminate true — schtasks /End actually terminates the daemon", () => {
    const xml = buildScheduledTaskXml(vbs, "DESKTOP\\trader");
    expect(xml).toContain("<AllowHardTerminate>true</AllowHardTerminate>");
  });

  test("escapes XML-unsafe characters in UserId and VBS path", () => {
    const xml = buildScheduledTaskXml('C:\\path\\with&amp.vbs', `DOMAIN\\<weird>"user`);
    expect(xml).toContain(`<Arguments>"C:\\path\\with&amp;amp.vbs"</Arguments>`);
    expect(xml).toContain("<UserId>DOMAIN\\&lt;weird&gt;&quot;user</UserId>");
  });
});

const isWin = process.platform === "win32";

const describeWin = isWin ? describe : describe.skip;

describeWin("SchtasksController (Windows integration)", () => {
  const controller = new SchtasksController();

  test("install creates task and returns ok", async () => {
    const result = await controller.install({
      execPath: "C:\\Users\\test\\.bun\\bin\\ghost.exe",
      bunPath: "C:\\Users\\test\\.bun\\bin\\bun.exe",
      logDir: "C:\\Users\\test\\.ghost\\logs",
    });
    expect(result.ok).toBe(true);
    expect(result.definitionPath).toBeTruthy();
  });

  test("status returns a valid state", async () => {
    const status = await controller.status();
    expect(["running", "stopped", "not-installed"]).toContain(status);
  });

  test("uninstall cleans up and returns ok", async () => {
    const result = await controller.uninstall({ purgeLogs: false });
    expect(result.ok).toBe(true);
  });
});
