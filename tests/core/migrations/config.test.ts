import { describe, test, expect } from "bun:test";
import { runConfigMigrations } from "../../../src/core/migrations/config.js";
import { configSchema, type Config } from "../../../src/config/schema.js";
import { CONFIG_MIGRATIONS, type Migration } from "../../../src/core/migrations/registry.js";

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): Config {
  return configSchema.parse(overrides);
}

describe("runConfigMigrations", () => {
  test("empty list with fresh config returns dirty=false", async () => {
    const cfg = makeConfig();
    const result = await runConfigMigrations(cfg, []);
    expect(result.dirty).toBe(false);
    expect(result.config.schemaVersion).toBe(1);
  });

  test("applies single pending migration and returns dirty=true", async () => {
    const cfg = makeConfig({ schemaVersion: 1 });
    const migrations: Migration<Config>[] = [
      {
        version: 2,
        label: "add-foo",
        up: (c) => {
          // Simulate a mutation that only the migration owns
          (c as unknown as Record<string, unknown>)["foo"] = "bar";
        },
      },
    ];
    const result = await runConfigMigrations(cfg, migrations);
    expect(result.dirty).toBe(true);
    expect(result.config.schemaVersion).toBe(2);
    expect(
      (result.config as unknown as Record<string, unknown>)["foo"],
    ).toBe("bar");
    // Input must not be mutated
    expect(cfg.schemaVersion).toBe(1);
    expect(
      (cfg as unknown as Record<string, unknown>)["foo"],
    ).toBeUndefined();
  });

  test("applies multiple migrations in ascending order", async () => {
    const cfg = makeConfig({ schemaVersion: 1 });
    const order: number[] = [];
    const migrations: Migration<Config>[] = [
      { version: 3, label: "c", up: () => { order.push(3); } },
      { version: 2, label: "b", up: () => { order.push(2); } },
    ];
    const result = await runConfigMigrations(cfg, migrations);
    expect(order).toEqual([2, 3]);
    expect(result.config.schemaVersion).toBe(3);
    expect(result.dirty).toBe(true);
  });

  test("skips migrations already applied", async () => {
    const cfg = makeConfig({ schemaVersion: 2 });
    const applied: number[] = [];
    const migrations: Migration<Config>[] = [
      { version: 1, label: "a", up: () => { applied.push(1); } },
      { version: 2, label: "b", up: () => { applied.push(2); } },
      { version: 3, label: "c", up: () => { applied.push(3); } },
    ];
    const result = await runConfigMigrations(cfg, migrations);
    expect(applied).toEqual([3]);
    expect(result.config.schemaVersion).toBe(3);
  });

  test("rethrows with wrapped message on failure", async () => {
    const cfg = makeConfig({ schemaVersion: 1 });
    const migrations: Migration<Config>[] = [
      {
        version: 2,
        label: "broken",
        up: () => {
          throw new Error("boom");
        },
      },
    ];
    await expect(runConfigMigrations(cfg, migrations)).rejects.toThrow(
      /\[migration config v1→v2 broken\] boom/,
    );
  });

  test("rejects duplicate version numbers", async () => {
    const cfg = makeConfig();
    const migrations: Migration<Config>[] = [
      { version: 2, label: "a", up: () => {} },
      { version: 2, label: "b", up: () => {} },
    ];
    await expect(runConfigMigrations(cfg, migrations)).rejects.toThrow(
      /Duplicate migration version: 2/,
    );
  });

  describe("v2: lift paper.enabled to mode", () => {
    test("paper.enabled === true → mode = 'paper'", async () => {
      const cfg = makeConfig({ schemaVersion: 1, paper: { enabled: true } });
      const result = await runConfigMigrations(cfg, CONFIG_MIGRATIONS);
      expect(result.dirty).toBe(true);
      expect(result.config.mode).toBe("paper");
      expect(result.config.schemaVersion).toBeGreaterThanOrEqual(2);
    });

    test("paper.enabled === false → mode = 'live'", async () => {
      const cfg = makeConfig({ schemaVersion: 1, paper: { enabled: false } });
      const result = await runConfigMigrations(cfg, CONFIG_MIGRATIONS);
      expect(result.config.mode).toBe("live");
    });

    test("missing paper block → mode = 'live'", async () => {
      const cfg = makeConfig({ schemaVersion: 1 });
      const result = await runConfigMigrations(cfg, CONFIG_MIGRATIONS);
      expect(result.config.mode).toBe("live");
    });

    test("idempotent — re-running on already-migrated config is a no-op", async () => {
      const cfg = makeConfig({ schemaVersion: 1, paper: { enabled: true } });
      const first = await runConfigMigrations(cfg, CONFIG_MIGRATIONS);
      const second = await runConfigMigrations(first.config, CONFIG_MIGRATIONS);
      expect(second.dirty).toBe(false);
      expect(second.config.mode).toBe("paper");
      expect(second.config.schemaVersion).toBe(first.config.schemaVersion);
    });
  });

  test("awaits async migration bodies", async () => {
    const cfg = makeConfig({ schemaVersion: 1 });
    const migrations: Migration<Config>[] = [
      {
        version: 2,
        label: "async-body",
        up: async (c) => {
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          (c as unknown as Record<string, unknown>)["asyncField"] = "set";
        },
      },
    ];
    const result = await runConfigMigrations(cfg, migrations);
    expect(result.dirty).toBe(true);
    expect(result.config.schemaVersion).toBe(2);
    expect(
      (result.config as unknown as Record<string, unknown>)["asyncField"],
    ).toBe("set");
  });
});
