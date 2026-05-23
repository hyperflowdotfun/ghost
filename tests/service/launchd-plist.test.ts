import { describe, test, expect } from "bun:test";
import { buildPlist } from "../../src/services/os/launchd-plist.js";

describe("buildPlist", () => {
  const baseOpts = {
    label: "com.ghost.daemon",
    bunPath: "/usr/local/bin/bun",
    execPath: "/usr/local/bin/ghost",
    workingDir: "/Users/test/.ghost",
    env: {},
  };

  test("produces well-formed XML with correct keys", () => {
    const xml = buildPlist(baseOpts);

    // XML declaration and DOCTYPE
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain("<!DOCTYPE plist");

    // Required keys
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("<string>com.ghost.daemon</string>");
    expect(xml).toContain("<key>RunAtLoad</key>");
    expect(xml).toContain("<true/>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>ThrottleInterval</key>");
    expect(xml).toContain("<integer>10</integer>");
    expect(xml).toContain("<key>ProgramArguments</key>");
    expect(xml).toContain("<string>/usr/local/bin/ghost</string>");
    expect(xml).toContain("<string>daemon</string>");
    expect(xml).toContain("<key>WorkingDirectory</key>");
    expect(xml).toContain("<string>/Users/test/.ghost</string>");

    // Stdout/stderr deliberately unmanaged — launchd uses its default sink.
    expect(xml).not.toContain("<key>StandardOutPath</key>");
    expect(xml).not.toContain("<key>StandardErrorPath</key>");
  });

  test("ProgramArguments contains execPath and 'daemon'", () => {
    const xml = buildPlist(baseOpts);

    // Extract ProgramArguments array content
    const argsMatch = xml.match(
      /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/,
    );
    expect(argsMatch).not.toBeNull();
    const argsBlock = argsMatch![1]!;
    const strings = Array.from(argsBlock.matchAll(/<string>(.*?)<\/string>/g)).map(
      (m) => m[1],
    );
    expect(strings).toEqual(["/usr/local/bin/bun", "/usr/local/bin/ghost", "daemon"]);
  });

  test("does not include EnvironmentVariables when env is empty", () => {
    const xml = buildPlist(baseOpts);
    expect(xml).not.toContain("<key>EnvironmentVariables</key>");
  });

  test("includes EnvironmentVariables dict when env is provided", () => {
    const xml = buildPlist({
      ...baseOpts,
      env: { GHOST_PORT: "15401", NODE_ENV: "production" },
    });

    expect(xml).toContain("<key>EnvironmentVariables</key>");
    expect(xml).toContain("<key>GHOST_PORT</key>");
    expect(xml).toContain("<string>15401</string>");
    expect(xml).toContain("<key>NODE_ENV</key>");
    expect(xml).toContain("<string>production</string>");
  });

  test("escapes XML-unsafe characters in paths", () => {
    const xml = buildPlist({
      ...baseOpts,
      execPath: "/path/to/<ghost>&\"daemon\"",
      workingDir: "/Users/test's dir",
    });

    // The raw special chars should NOT appear unescaped
    expect(xml).not.toContain("<ghost>");
    expect(xml).toContain("&lt;ghost&gt;&amp;&quot;daemon&quot;");
    expect(xml).toContain("test&apos;s dir");
  });

  test("escapes XML-unsafe characters in env keys and values", () => {
    const xml = buildPlist({
      ...baseOpts,
      env: { "KEY<>": "value&\"test\"" },
    });

    expect(xml).toContain("<key>KEY&lt;&gt;</key>");
    expect(xml).toContain("<string>value&amp;&quot;test&quot;</string>");
  });

  test("filters out empty-string env values", () => {
    const xml = buildPlist({
      ...baseOpts,
      env: { KEEP: "yes", EMPTY: "", SPACES: "   " },
    });

    expect(xml).toContain("<key>KEEP</key>");
    expect(xml).not.toContain("<key>EMPTY</key>");
    expect(xml).not.toContain("<key>SPACES</key>");
  });

  test("escapes XML-unsafe characters in label", () => {
    const xml = buildPlist({
      ...baseOpts,
      label: "com.ghost<test>&daemon",
    });

    expect(xml).toContain("<string>com.ghost&lt;test&gt;&amp;daemon</string>");
  });
});
