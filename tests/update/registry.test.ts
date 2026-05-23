import { describe, test, expect } from "bun:test";
import {
  DEFAULT_REGISTRY_URL,
  PACKAGE_NAME,
  getRegistryUrl,
} from "../../src/update/registry.js";

describe("registry", () => {
  test("DEFAULT_REGISTRY_URL points at the public npm registry", () => {
    expect(DEFAULT_REGISTRY_URL).toBe("https://registry.npmjs.org/");
  });

  test("PACKAGE_NAME is the scoped package name", () => {
    expect(PACKAGE_NAME).toBe("@hyperflow.fun/ghost");
  });

  test("getRegistryUrl returns the default when env is unset", () => {
    expect(getRegistryUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_REGISTRY_URL);
  });

  test("getRegistryUrl prefers GHOST_REGISTRY when set", () => {
    const url = getRegistryUrl({
      GHOST_REGISTRY: "https://example.test/api/v4/projects/42/packages/npm/",
    } as unknown as NodeJS.ProcessEnv);
    expect(url).toBe("https://example.test/api/v4/projects/42/packages/npm/");
  });

  test("getRegistryUrl normalizes a missing trailing slash", () => {
    const url = getRegistryUrl({
      GHOST_REGISTRY: "https://example.test/api/v4/projects/42/packages/npm",
    } as unknown as NodeJS.ProcessEnv);
    expect(url.endsWith("/")).toBe(true);
  });

  test("getRegistryUrl treats blank GHOST_REGISTRY as unset", () => {
    const url = getRegistryUrl({
      GHOST_REGISTRY: "  ",
    } as unknown as NodeJS.ProcessEnv);
    expect(url).toBe(DEFAULT_REGISTRY_URL);
  });
});
