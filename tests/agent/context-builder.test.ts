import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextBuilder, StructuredPrompt } from "../../src/agent/context-builder.js";
import { SkillsLoader } from "../../src/skills/loader.js";
import type { MemoryStore } from "../../src/memory/store.js";

const emptyMemory = { getMemoryContext: () => "" } as unknown as MemoryStore;
const emptySkills = { getAlwaysSkills: () => [], loadSkillsForContext: () => "", buildSkillsSummary: () => "", listSkills: () => [] } as unknown as SkillsLoader;

let tmpDir: string;
let workspaceDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `ghost-cb-${Date.now()}`);
  workspaceDir = join(tmpDir, "workspace");
  mkdirSync(workspaceDir, { recursive: true });
});
afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

describe("ContextBuilder", () => {
  test("buildSystemPrompt returns non-empty string", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt.length).toBeGreaterThan(0);
  });

  test("identity section includes Ghost branding", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("ghost");
  });

  test("loads bootstrap files from workspace", () => {
    writeFileSync(join(workspaceDir, "SOUL.md"), "I am friendly.");
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("I am friendly.");
  });

  test("skips missing bootstrap files gracefully", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    expect(() => cb.buildSystemPrompt()).not.toThrow();
  });

  test("injects memory section when memoryStore provided", () => {
    const mockMemory = { getMemoryContext: () => "## Long-term Memory\n\nUser prefers dark mode." };
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, mockMemory as never, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("Long-term Memory");
    expect(prompt).toContain("User prefers dark mode.");
  });

  test("omits memory section when memory is empty", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).not.toContain("Long-term Memory");
  });

  test("includes always-skills when skillsLoader provided", () => {
    const skillsDir = join(workspaceDir, "skills", "mem");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: mem\ndescription: Memory\nalways: true\n---\n# Memory Instructions");
    const loader = new SkillsLoader(workspaceDir);
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, loader);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("Active Skills");
    expect(prompt).toContain("Memory Instructions");
  });

  test("includes skills summary XML", () => {
    const skillsDir = join(workspaceDir, "skills", "gh");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: gh\ndescription: GitHub CLI\n---\nContent");
    const loader = new SkillsLoader(workspaceDir);
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, loader);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("<skills>");
    expect(prompt).toContain("<name>gh</name>");
  });

  test("sections joined with --- separators", () => {
    writeFileSync(join(workspaceDir, "SOUL.md"), "soul content");
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("---");
  });

  test("StructuredPrompt.set replaces existing section by key", () => {
    const sp = new StructuredPrompt();
    sp.add("memory", "Old memory");
    sp.add("identity", "Ghost identity");
    expect(sp.toString()).toContain("Old memory");
    sp.set("memory", "New memory");
    expect(sp.toString()).toContain("New memory");
    expect(sp.toString()).not.toContain("Old memory");
    expect(sp.toString()).toContain("Ghost identity");
  });

  test("StructuredPrompt.set with empty string removes section", () => {
    const sp = new StructuredPrompt();
    sp.add("memory", "Some memory");
    sp.add("identity", "Ghost");
    sp.set("memory", "");
    expect(sp.toString()).not.toContain("Some memory");
    expect(sp.toString()).toContain("Ghost");
  });

  test("enforceCapAt protects memory and SOUL, truncating bulky skill sections first", () => {
    const sp = new StructuredPrompt();
    sp.add("identity", "ID");
    sp.add("memory", "## Long-term Memory\n\nMEM_KEEP");
    sp.add("bootstrap", "## SOUL.md\n\nSOUL_KEEP");
    sp.add("activeSkills", "A".repeat(1000));
    sp.add("skillsSummary", "S".repeat(1000));

    sp.enforceCapAt(1600);

    expect(sp.toString().length).toBeLessThanOrEqual(1600);
    // Irreplaceable sections survive intact.
    expect(sp.get("memory")).toContain("MEM_KEEP");
    expect(sp.get("bootstrap")).toContain("SOUL_KEEP");
    // The bulky, re-derivable section absorbed the truncation.
    expect((sp.get("skillsSummary") ?? "").length).toBeLessThan(1000);
  });

  test("buildFullPrompt includes runtime context and fresh memory", () => {
    const mockMemory = { getMemoryContext: () => "## Long-term Memory\n\nUser prefers dark mode." };
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, mockMemory as never, emptySkills);
    const full = cb.buildFullPrompt("web", "client-1");
    expect(full).toContain("User prefers dark mode.");
    expect(full).toContain("Runtime Context");
    expect(full).toContain("Channel: web");
    expect(full).toContain("Chat ID: client-1");
  });

  test("buildRuntimeContext includes time and channel info", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const ctx = cb.buildRuntimeContext("telegram", "123");
    expect(ctx).toContain("Runtime Context");
    expect(ctx).toContain("Channel: telegram");
    expect(ctx).toContain("Chat ID: 123");
  });

  test("buildRuntimeContext works without channel info", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const ctx = cb.buildRuntimeContext();
    expect(ctx).toContain("Runtime Context");
    expect(ctx).not.toContain("Channel:");
  });

  test("buildRuntimeContext does not leak UTC offset", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const ctx = cb.buildRuntimeContext();
    // A trailing (UTC±HH:MM) suffix on the Current Time line was read by
    // the model as a region cue, biasing reply language. Runtime Context
    // is metadata only; no language cues belong here.
    expect(ctx).not.toMatch(/\(UTC[+-]\d{2}:\d{2}\)/);
    expect(ctx).toContain("Current Time:");
  });

  test("identity section includes model name", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "claude-3-opus" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("claude-3-opus");
  });

  test("identity section omits Host and OS — they have no value for the LLM and add noise", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "claude-test" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).not.toMatch(/^Host: /m);
    expect(prompt).not.toContain("| OS: ");
    // Model identifier still useful — it lets the LLM tailor reasoning to its own size.
    expect(prompt).toContain("claude-test");
  });

  test("buildCliSystemPrompt inlines active skill bodies so CLI invokes always-on skills in -p mode", () => {
    const skillsDir = join(workspaceDir, "skills", "mem");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: mem\ndescription: Memory\nalways: true\n---\n# Memory Instructions");
    const loader = new SkillsLoader(workspaceDir);
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, loader);
    const cliPrompt = cb.buildCliSystemPrompt();
    expect(cliPrompt).toContain("# Active Skills");
    expect(cliPrompt).toContain("Memory Instructions");
  });

  test("buildCliSystemPrompt includes skills summary XML so CLI sees names + locations", () => {
    const skillsDir = join(workspaceDir, "skills", "gh");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "SKILL.md"), "---\nname: gh\ndescription: GitHub CLI\n---\nContent");
    const loader = new SkillsLoader(workspaceDir);
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, loader);
    const cliPrompt = cb.buildCliSystemPrompt();
    expect(cliPrompt).toContain("<skills>");
    expect(cliPrompt).toContain("<name>gh</name>");
  });

  test("buildCliSystemPrompt prefixes tool names with mcp__ghost__ to match Claude CLI's MCP namespace", () => {
    const cb = new ContextBuilder(
      { workspaceDir, model: "test-model", tools: [{ name: "ghost_list_wallets", description: "List wallets" }] },
      emptyMemory,
      emptySkills,
    );
    const cliPrompt = cb.buildCliSystemPrompt();
    expect(cliPrompt).toContain("## Tooling");
    expect(cliPrompt).toContain("mcp__ghost__ghost_list_wallets");
  });

  test("buildSystemPrompt uses unprefixed tool names (native in-process registration)", () => {
    const cb = new ContextBuilder(
      { workspaceDir, model: "test-model", tools: [{ name: "ghost_list_wallets", description: "List wallets" }] },
      emptyMemory,
      emptySkills,
    );
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("- ghost_list_wallets:");
    expect(prompt).not.toContain("mcp__ghost__");
  });

  test("buildCliSystemPrompt omits Tooling section when no tools are registered", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const cliPrompt = cb.buildCliSystemPrompt();
    expect(cliPrompt).not.toContain("## Tooling");
  });

  test("buildCliSystemPrompt identity uses bare ghost_list_wallets (no TOOL NAMING meta-directive)", () => {
    // A prose 'TOOL NAMING: tools are exposed as mcp__ghost__<name>' directive
    // confused Claude CLI and silently broke write-tool invocation in place-order
    // flows. Identity now uses bare tool names (matching SOUL.md/SKILL.md); the
    // Tooling section still lists prefixed names so the model sees both forms.
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const cliPrompt = cb.buildCliSystemPrompt();
    expect(cliPrompt).toContain("ALWAYS call ghost_list_wallets");
    expect(cliPrompt).not.toContain("TOOL NAMING");
    // The identity bullet itself must be bare — no mcp__ghost__ prefix on the guideline line.
    const guidelineLine = cliPrompt.split("\n").find((l) => l.includes("ALWAYS call"));
    expect(guidelineLine).not.toContain("mcp__ghost__ghost_list_wallets");
  });

  test("buildSystemPrompt identity uses bare tool names (no MCP prefix, no TOOL NAMING)", () => {
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const prompt = cb.buildSystemPrompt();
    expect(prompt).toContain("ALWAYS call ghost_list_wallets");
    expect(prompt).not.toContain("TOOL NAMING");
  });

  test("buildCliSystemPrompt still includes identity, safety, and bootstrap", () => {
    writeFileSync(join(workspaceDir, "SOUL.md"), "soul content");
    const cb = new ContextBuilder({ workspaceDir, model: "test-model" }, emptyMemory, emptySkills);
    const cliPrompt = cb.buildCliSystemPrompt();
    expect(cliPrompt).toContain("Ghost");
    expect(cliPrompt).toContain("Safety");
    expect(cliPrompt).toContain("soul content");
  });
});
