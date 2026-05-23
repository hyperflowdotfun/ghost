import { describe, test, expect } from "bun:test";
import { buildUnit, type UnitOptions } from "../../src/services/os/systemd-unit.js";

const BASE_OPTS: UnitOptions = {
  description: "Ghost AI Trading Companion",
  execStart: "/home/user/.bun/bin/ghost daemon",
  workingDir: "/home/user/.bun/bin",
  env: {},
};

describe("buildUnit", () => {
  test("produces all three INI sections", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("[Unit]");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("[Install]");
  });

  test("includes Description from options", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("Description=Ghost AI Trading Companion");
  });

  test("includes After and Wants for network-online.target", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("After=network-online.target");
    expect(unit).toContain("Wants=network-online.target");
  });

  test("includes ExecStart from options", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("ExecStart=/home/user/.bun/bin/ghost daemon");
  });

  test("includes Restart=always and RestartSec=5", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
  });

  test("includes timeout and exit status settings", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("TimeoutStopSec=30");
    expect(unit).toContain("TimeoutStartSec=30");
    expect(unit).toContain("SuccessExitStatus=0 143");
  });

  test("includes KillMode=control-group", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("KillMode=control-group");
  });

  test("includes WorkingDirectory from options", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("WorkingDirectory=/home/user/.bun/bin");
  });

  test("does not emit StandardOutput or StandardError directives (defaults to journald)", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).not.toContain("StandardOutput");
    expect(unit).not.toContain("StandardError");
  });

  test("includes WantedBy=default.target", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).toContain("WantedBy=default.target");
  });

  test("renders Environment lines for each env entry", () => {
    const unit = buildUnit({
      ...BASE_OPTS,
      env: {
        GHOST_LOG_DIR: "/home/user/.ghost/logs",
        NODE_ENV: "production",
      },
    });
    expect(unit).toContain('Environment="GHOST_LOG_DIR=/home/user/.ghost/logs"');
    expect(unit).toContain('Environment="NODE_ENV=production"');
  });

  test("omits env entries with empty values", () => {
    const unit = buildUnit({
      ...BASE_OPTS,
      env: {
        KEEP: "yes",
        EMPTY: "",
        BLANK: "   ",
      },
    });
    expect(unit).toContain('Environment="KEEP=yes"');
    expect(unit).not.toContain("EMPTY");
    expect(unit).not.toContain("BLANK");
  });

  test("produces no Environment lines when env is empty", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit).not.toContain("Environment=");
  });

  test("throws when description contains newline", () => {
    expect(() =>
      buildUnit({ ...BASE_OPTS, description: "line1\nline2" }),
    ).toThrow(/must not contain CR or LF/);
  });

  test("throws when env key contains newline", () => {
    expect(() =>
      buildUnit({ ...BASE_OPTS, env: { "BAD\nKEY": "val" } }),
    ).toThrow(/must not contain CR or LF/);
  });

  test("throws when env value contains carriage return", () => {
    expect(() =>
      buildUnit({ ...BASE_OPTS, env: { KEY: "val\rmore" } }),
    ).toThrow(/must not contain CR or LF/);
  });

  test("ends with a trailing newline", () => {
    const unit = buildUnit(BASE_OPTS);
    expect(unit.endsWith("\n")).toBe(true);
  });
});
