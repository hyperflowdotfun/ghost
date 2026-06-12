/**
 * Tests for Runner — verifies that concurrent calls to the shared
 * taskAgent are serialized (each call sees its own systemPrompt/messages and
 * runs strictly one at a time), failure isolation holds, and the persist flag
 * correctly appends to the canonical session.
 */

import { describe, test, expect, mock } from "bun:test";
import { Runner } from "../../src/agent/runner.js";
import { NOOP_LOGGER } from "../../src/logger.js";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { ToolRegistry } from "../../src/tools/registry.js";

/** Minimal ToolRegistry stub: empty tool list, sufficient for Runner tests. */
const STUB_REGISTRY = {
  all: () => [],
  taskAgentTools: () => [],
} as unknown as ToolRegistry;

/** Build a ToolRegistry stub whose taskAgentTools() returns the provided sentinel.
 * Runner.call snapshots tools via taskAgentTools(); these tests only need the
 * sentinel identity. */
function registryWithTools(tools: unknown[]): ToolRegistry {
  return {
    all: () => tools,
    taskAgentTools: () => tools,
  } as unknown as ToolRegistry;
}

// ---------------------------------------------------------------------------
// Minimal Agent mock
// ---------------------------------------------------------------------------

interface PromptSnapshot {
  systemPrompt: string;
  message: string;
}

/**
 * Creates a mock Agent whose `prompt()` records the systemPrompt it sees at
 * call time, appends a matching assistant message to state.messages, and
 * resolves after a small delay to make concurrency observable. Runner extracts
 * final text by walking state.messages post-hoc — no event subscription
 * machinery needed.
 */
function createMockAgent(opts: { delayMs?: number; failOnMessage?: string } = {}) {
  const snapshots: PromptSnapshot[] = [];
  const callOrder: string[] = [];

  const state = {
    systemPrompt: "",
    messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
    tools: [],
    errorMessage: undefined as string | undefined,
  };

  const promptFn = mock(async (message: string) => {
    // Record what the caller set up before calling prompt()
    snapshots.push({ systemPrompt: state.systemPrompt, message });
    callOrder.push(message);

    if (opts.failOnMessage && message === opts.failOnMessage) {
      throw new Error(`mock failure for: ${message}`);
    }

    await new Promise((r) => setTimeout(r, opts.delayMs ?? 5));

    state.messages.push({
      role: "assistant",
      content: [{ type: "text", text: `reply-to: ${message}` }],
    });
  });

  const agent = { state, prompt: promptFn } as unknown as Agent;

  return { agent, snapshots, callOrder };
}

// ---------------------------------------------------------------------------
// Minimal SessionManager mock
// ---------------------------------------------------------------------------

function createMockSessionManager() {
  const addMessage = mock((_msg: unknown) => {});
  const session = { addMessage };
  const getOrCreate = mock((_key: string) => session);
  return { getOrCreate, session };
}

// ---------------------------------------------------------------------------
// Sequential calls
// ---------------------------------------------------------------------------

describe("Runner — sequential calls", () => {
  test("each call sees its own systemPrompt and returns its own text", async () => {
    const { agent } = createMockAgent();
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    const r1 = await runner.call({ systemPrompt: "SP-1", message: "msg-1" });
    const r2 = await runner.call({ systemPrompt: "SP-2", message: "msg-2" });

    expect(r1).toBe("reply-to: msg-1");
    expect(r2).toBe("reply-to: msg-2");
  });

  test("systemPrompt is set to the value given per call", async () => {
    const { agent, snapshots } = createMockAgent();
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    await runner.call({ systemPrompt: "SYS-A", message: "hello" });
    await runner.call({ systemPrompt: "SYS-B", message: "world" });

    expect(snapshots[0].systemPrompt).toBe("SYS-A");
    expect(snapshots[1].systemPrompt).toBe("SYS-B");
  });

  test("messages array is cleared before each call", async () => {
    const { agent } = createMockAgent();
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    // After first call there's 1 message in state. Second call must clear it.
    await runner.call({ systemPrompt: "SP", message: "first" });
    await runner.call({ systemPrompt: "SP", message: "second" });

    // The second assistant message should be "reply-to: second", not stacked.
    expect(agent.state.messages).toHaveLength(1);
    expect(((agent.state.messages[0] as { content: Array<{ text: string }> }).content[0]).text).toBe("reply-to: second");
  });
});

// ---------------------------------------------------------------------------
// Concurrent calls — must serialize
// ---------------------------------------------------------------------------

describe("Runner — concurrent calls serialize", () => {
  test("3 concurrent calls run one at a time, each returning its own result", async () => {
    const { agent } = createMockAgent({ delayMs: 10 });
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    // Start all three without awaiting (concurrent enqueue)
    const p1 = runner.call({ systemPrompt: "SP-1", message: "msg-1" });
    const p2 = runner.call({ systemPrompt: "SP-2", message: "msg-2" });
    const p3 = runner.call({ systemPrompt: "SP-3", message: "msg-3" });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toBe("reply-to: msg-1");
    expect(r2).toBe("reply-to: msg-2");
    expect(r3).toBe("reply-to: msg-3");
  });

  test("each concurrent call sees its own systemPrompt (not a later call's)", async () => {
    const { agent, snapshots } = createMockAgent({ delayMs: 10 });
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    const p1 = runner.call({ systemPrompt: "EVAL", message: "eval-prompt" });
    const p2 = runner.call({ systemPrompt: "SUMMARY", message: "summary-prompt" });
    const p3 = runner.call({ systemPrompt: "GATEWAY", message: "gateway-prompt" });

    await Promise.all([p1, p2, p3]);

    // Snapshots captured at prompt() call time — each must match its own SP
    expect(snapshots[0]).toEqual({ systemPrompt: "EVAL", message: "eval-prompt" });
    expect(snapshots[1]).toEqual({ systemPrompt: "SUMMARY", message: "summary-prompt" });
    expect(snapshots[2]).toEqual({ systemPrompt: "GATEWAY", message: "gateway-prompt" });
  });

  test("serialization is strict — prompt() called only after previous resolves", async () => {
    const callStart: string[] = [];
    const callEnd: string[] = [];

    const state = {
      systemPrompt: "",
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
      tools: [],
    };

    const promptFn = mock(async (message: string) => {
      callStart.push(message);
      await new Promise((r) => setTimeout(r, 10));
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `reply-to: ${message}` }],
      });
      callEnd.push(message);
    });

    const agent = { state, prompt: promptFn } as unknown as Agent;
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    const p1 = runner.call({ systemPrompt: "SP", message: "A" });
    const p2 = runner.call({ systemPrompt: "SP", message: "B" });
    const p3 = runner.call({ systemPrompt: "SP", message: "C" });

    await Promise.all([p1, p2, p3]);

    // All started and ended in order (no interleaving)
    expect(callStart).toEqual(["A", "B", "C"]);
    expect(callEnd).toEqual(["A", "B", "C"]);
    expect(promptFn).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Failure isolation — chain must not break on error
// ---------------------------------------------------------------------------

describe("Runner — failure isolation", () => {
  test("a failed call throws but the next call still runs", async () => {
    const { agent } = createMockAgent({ failOnMessage: "bad-msg", delayMs: 5 });
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    // First call fails
    await expect(runner.call({ systemPrompt: "SP", message: "bad-msg" })).rejects.toThrow(
      "mock failure for: bad-msg",
    );

    // Second call runs normally despite the chain having a failed predecessor
    const result = await runner.call({ systemPrompt: "SP", message: "good-msg" });
    expect(result).toBe("reply-to: good-msg");
  });

  test("failure in middle call does not affect calls before or after it", async () => {
    const { agent } = createMockAgent({ failOnMessage: "fail", delayMs: 5 });
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    const p1 = runner.call({ systemPrompt: "SP", message: "first" });
    const p2 = runner.call({ systemPrompt: "SP", message: "fail" });
    const p3 = runner.call({ systemPrompt: "SP", message: "third" });

    const r1 = await p1;
    await expect(p2).rejects.toThrow("mock failure for: fail");
    const r3 = await p3;

    expect(r1).toBe("reply-to: first");
    expect(r3).toBe("reply-to: third");
  });
});

// ---------------------------------------------------------------------------
// persist flag
// ---------------------------------------------------------------------------

describe("Runner — persist flag", () => {
  test("persist: true + non-empty text → sessionManager.getOrCreate('main').addMessage called", async () => {
    const { agent } = createMockAgent();
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    await runner.call({ systemPrompt: "SP", message: "hello", persist: true });

    expect(sm.getOrCreate).toHaveBeenCalledWith("main");
    expect(sm.session.addMessage).toHaveBeenCalledTimes(1);
    const msg = sm.session.addMessage.mock.calls[0][0] as {
      role: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(msg.role).toBe("assistant");
    expect(msg.content[0].type).toBe("text");
    expect(msg.content[0].text).toBe("reply-to: hello");
  });

  test("persist omitted → no session writes", async () => {
    const { agent } = createMockAgent();
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    await runner.call({ systemPrompt: "SP", message: "hello" });

    expect(sm.session.addMessage).not.toHaveBeenCalled();
  });

  test("persist: true + empty text → no session write", async () => {
    // Agent produces only a thinking block — extractFinalAssistantText filters
    // non-text blocks, so finalText stays "" and no session write occurs.
    const state = {
      systemPrompt: "",
      messages: [] as Array<{ role: string; content: unknown[] }>,
      tools: [],
    };
    const promptFn = mock(async (_message: string) => {
      state.messages.push({
        role: "assistant",
        content: [{ type: "thinking", thinking: "internal" }],
      });
    });
    const agent = { state, prompt: promptFn } as unknown as Agent;
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    const result = await runner.call({ systemPrompt: "SP", message: "msg", persist: true });

    expect(result).toBe("");
    expect(sm.session.addMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tool snapshot refresh regression
// ---------------------------------------------------------------------------

describe("Runner — tool snapshot refresh", () => {
  test("agent.state.tools is set to registry.taskAgentTools() on each call", async () => {
    // Use unknown[] sentinels — we only care about reference identity, not the
    // actual AgentTool shape. The type cast lets us avoid stubbing 4+ fields.
    // Runner snapshots via taskAgentTools() (not all()) so background loops
    // never see write/exec tools that would trigger a confirm card.
    const sentinelA = [{ name: "tool-a" }] as unknown[];
    const sentinelB = [{ name: "tool-b" }] as unknown[];

    const state = {
      systemPrompt: "",
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
      tools: [] as unknown[],
    };
    const promptFn = mock(async (message: string) => {
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `reply-${message}` }],
      });
    });
    const agent = { state, prompt: promptFn } as unknown as Agent;
    const sm = createMockSessionManager();

    // First call uses sentinelA
    let currentSentinel = sentinelA;
    const registry = {
      all: () => currentSentinel,
      taskAgentTools: () => currentSentinel,
    } as unknown as ToolRegistry;
    const runner = new Runner(agent, sm as never, registry, NOOP_LOGGER);

    await runner.call({ systemPrompt: "SP", message: "first" });
    expect(agent.state.tools as unknown[]).toBe(sentinelA);

    // Switch sentinel — next call must pick up the new snapshot
    currentSentinel = sentinelB;
    await runner.call({ systemPrompt: "SP", message: "second" });
    expect(agent.state.tools as unknown[]).toBe(sentinelB);
  });

  test("OriginAware tools have their origin cleared before each call", async () => {
    const setOriginCalls: Array<[string, string]> = [];

    const originAwareTool = {
      name: "cron",
      setOrigin(channel: string, chatId: string) {
        setOriginCalls.push([channel, chatId]);
      },
    };

    const state = {
      systemPrompt: "",
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
      tools: [] as unknown[],
    };
    const promptFn = mock(async (message: string) => {
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `reply-${message}` }],
      });
    });
    const agent = { state, prompt: promptFn } as unknown as Agent;
    const sm = createMockSessionManager();
    const registry = registryWithTools([originAwareTool]);
    const runner = new Runner(agent, sm as never, registry, NOOP_LOGGER);

    await runner.call({ systemPrompt: "SP", message: "bg-job" });

    // setOrigin should have been called with empty strings to clear context
    expect(setOriginCalls.length).toBeGreaterThanOrEqual(1);
    expect(setOriginCalls[0]).toEqual(["", ""]);
  });
});

// ---------------------------------------------------------------------------
// Call timeout — a hung agent.prompt must not freeze the mutex forever
// ---------------------------------------------------------------------------

describe("Runner — call timeout", () => {
  test("rejects on timeout, aborts the agent, and frees the mutex for the next call", async () => {
    let abortCalled = false;
    const state = {
      systemPrompt: "",
      messages: [] as Array<{ role: string; content: Array<{ type: string; text: string }> }>,
      tools: [] as unknown[],
    };
    let hangs = true;
    const promptFn = mock(async (message: string) => {
      if (hangs) {
        // Resolve only when aborted — mirrors a stalled stream / stuck tool.
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (abortCalled) {
              clearInterval(check);
              resolve();
            }
          }, 1);
        });
        return;
      }
      state.messages.push({
        role: "assistant",
        content: [{ type: "text", text: `reply-to: ${message}` }],
      });
    });
    const abort = mock(() => {
      abortCalled = true;
    });
    const agent = { state, prompt: promptFn, abort } as unknown as Agent;
    const sm = createMockSessionManager();
    const runner = new Runner(agent, sm as never, STUB_REGISTRY, NOOP_LOGGER);

    // First call hangs; a short override timeout forces the watchdog to fire.
    await expect(
      runner.call({ systemPrompt: "SP", message: "hang", timeoutMs: 30 }),
    ).rejects.toThrow(/exceeded/);
    expect(abort).toHaveBeenCalledTimes(1);

    // Mutex must be free: a subsequent normal call still runs.
    hangs = false;
    const result = await runner.call({ systemPrompt: "SP", message: "next" });
    expect(result).toBe("reply-to: next");
  });
});
