import { describe, test, expect } from "bun:test";
import pkg from "../../package.json" with { type: "json" };

describe("package.json shape", () => {
  test("exposes ghost bin pointing at dist/index.js", () => {
    expect(pkg.bin).toEqual({ ghost: "dist/index.js" });
  });

  test("files field ships dist, LICENSE, and README", () => {
    expect(pkg.files).toEqual(["dist", "LICENSE", "README.md"]);
  });

  test("declares Bun engine >=1.1.0", () => {
    expect(pkg.engines?.bun).toMatch(/^>=1\.1\./);
  });

  test("runtime dependencies are empty (all inlined via bundler)", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  test("scripts include build pipeline", () => {
    expect(pkg.scripts["build:web"]).toBeDefined();
    expect(pkg.scripts["build:bundle"]).toContain("bun build");
    expect(pkg.scripts["build:bundle"]).toContain("--target bun");
    expect(pkg.scripts["build:bundle"]).toContain("--banner");
    expect(pkg.scripts["build:assets"]).toContain("copy-assets");
    expect(pkg.scripts["build"]).toContain("build:web");
    expect(pkg.scripts["build"]).toContain("build:bundle");
    expect(pkg.scripts["build"]).toContain("build:assets");
    expect(pkg.scripts.prepack).toBe("bun run build");
  });
});
