/**
 * Unit tests for the cron delivery handler.
 *
 * Tests inject a real `PairingStore` backed by an in-memory `bun:sqlite`
 * Database instead of writing JSON fixtures into a temp `GHOST_HOME`. The
 * DB is the actual production code path so behaviour like identityKind
 * classification is exercised authentically.
 *
 * Cron delivery runs through `runner.call` + `contextBuilder` (not
 * `orchestrator.prompt`). Tests use RunnerStub + ContextBuilderStub.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createCronDeliveryHandler,
} from "../../src/scheduler/delivery.js";
import type { CronDeliveryDeps } from "../../src/scheduler/delivery.js";
import type { CronJob } from "../../src/scheduler/types.js";
import { PairingStore } from "../../src/pairing/store.js";
// resolvePrimaryChannel was deleted from delivery.ts; getOutboundChannels is
// the canonical resolver. Tests exercise getOutboundChannels directly.
import { getOutboundChannels } from "../../src/channels/index.js";

// ---------------------------------------------------------------------------
// Helpers / stubs
// ---------------------------------------------------------------------------

function makeJob(name = "morning-briefing", message = "run the briefing"): CronJob {
  return {
    id: "test-id",
    name,
    enabled: true,
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    payload: { kind: "agent_turn", message, deliver: true },
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      runHistory: [],
    },
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    deleteAfterRun: false,
  };
}

function makeManager(telegramActive: boolean) {
  return { isActive: (id: string) => id === "telegram" && telegramActive } as never;
}

function makeLogger() {
  return {
    warn: () => {},
    info: () => {},
    debug: () => {},
    error: () => {},
    child: () => makeLogger(),
  };
}

/**
 * Create an in-memory PairingStore with the schema that runtime/initDatabase
 * provides. Pre-seed `telegramAllowlist` to control resolver behaviour.
 * Order in the array becomes the insertion order — the resolver picks the
 * most-recent (last) numeric entry.
 */
function makePairingStore(telegramAllowlist: string[] = []): PairingStore {
  const db = new Database(":memory:");
  db.run(`
    CREATE TABLE channel_allowlist (
      channel        TEXT NOT NULL,
      identity       TEXT NOT NULL,
      identity_kind  TEXT NOT NULL,
      display_name   TEXT,
      added_at       INTEGER NOT NULL,
      PRIMARY KEY (channel, identity)
    )
  `);
  db.run(`
    CREATE TABLE pairing_requests (
      channel       TEXT NOT NULL,
      sender_id     TEXT NOT NULL,
      code          TEXT NOT NULL UNIQUE,
      username      TEXT,
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      PRIMARY KEY (channel, sender_id)
    )
  `);
  const store = new PairingStore(db, makeLogger() as never);
  if (telegramAllowlist.length > 0) {
    store.setAllowlist("telegram", telegramAllowlist);
  }
  return store;
}

class BusSpy {
  readonly outbound: Array<{
    channel: string; chatId: string; content: string; metadata: Record<string, unknown>;
  }> = [];

  publishOutbound(msg: { channel: string; chatId: string; content: string; media: unknown[]; metadata: Record<string, unknown> }) {
    this.outbound.push({ channel: msg.channel, chatId: msg.chatId, content: msg.content, metadata: msg.metadata });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  consumeOutbound(): any { return null; }
  get outboundSize() { return this.outbound.length; }
}

class EventBusSpy {
  readonly published: Array<{ type: string; payload: unknown }> = [];

  publish(e: { type: string; payload: unknown }) {
    this.published.push(e);
  }

  subscribe() { return () => {}; }
}

class CronToolStub {
  readonly name = "cron";
  /** Tracks "enter" (true) and "exit" (false) calls in order. */
  readonly contextCalls: boolean[] = [];

  enterCron() {
    this.contextCalls.push(true);
  }

  exitCron() {
    this.contextCalls.push(false);
  }
}

class ToolRegistryStub {
  private readonly _map: Map<string, unknown>;

  constructor(entries: Record<string, unknown> = {}) {
    this._map = new Map(Object.entries(entries));
  }

  get(name: string): unknown {
    return this._map.get(name);
  }
}

/** Replaces OrchestratorStub — records runner.call() invocations. */
class RunnerStub {
  private _responseText: string;
  readonly calls: Array<{ systemPrompt: string; message: string; persist?: boolean }> = [];

  constructor(responseText = "Good morning! Here is your briefing...") {
    this._responseText = responseText;
  }

  setResponseText(text: string) {
    this._responseText = text;
  }

  async call(opts: { systemPrompt: string; message: string; persist?: boolean }): Promise<string> {
    this.calls.push(opts);
    return this._responseText;
  }
}

/** Minimal stub — buildFullPrompt returns a deterministic string so tests can assert on it. */
class ContextBuilderStub {
  buildFullPrompt(channel: string, chatId: string): string {
    return `[system:${channel}:${chatId}]`;
  }
}

/**
 * Minimal SessionManager stub — surfaces a pre-canned message array so the
 * delivery handler can build its language-reference block.
 *
 * `shape` toggles between the array-of-blocks form (pi-ai canonical) and the
 * plain-string form that `Orchestrator.runPrompt` actually persists for
 * inbound user messages. Both must produce the same language reference.
 */
class SessionManagerStub {
  constructor(
    private readonly userTexts: string[] = [],
    private readonly shape: "array" | "string" = "array",
  ) {}

  getOrCreate(_key: string): { messages: Array<{ role: string; content: unknown }> } {
    void _key;
    return {
      messages: this.userTexts.map((t) => ({
        role: "user",
        content: this.shape === "string"
          ? t
          : [{ type: "text", text: t }],
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// getOutboundChannels — fanout resolver (replaces resolvePrimaryChannel)
// ---------------------------------------------------------------------------

describe("getOutboundChannels — channelManager + allowlist branching (shared fanout resolver)", () => {
  test("telegram inactive → web-only (regardless of allowlist content)", () => {
    const pairingStore = makePairingStore(["123", "456"]);
    const channels = getOutboundChannels({
      channelManager: makeManager(false),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].kind).toBe("web");
  });

  test("telegram active, empty allowlist → web-only", () => {
    const pairingStore = makePairingStore();
    const channels = getOutboundChannels({
      channelManager: makeManager(true),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].kind).toBe("web");
  });

  test('only-wildcard ["*"] → web-only (cannot deliver to wildcard)', () => {
    const pairingStore = makePairingStore(["*"]);
    const channels = getOutboundChannels({
      channelManager: makeManager(true),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].kind).toBe("web");
  });

  test('mixed ["*", "123"] → web + telegram chatId="123" (fanout)', () => {
    const pairingStore = makePairingStore(["*", "123"]);
    const channels = getOutboundChannels({
      channelManager: makeManager(true),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels).toHaveLength(2);
    expect(channels[0].kind).toBe("web");
    expect(channels[1]).toEqual({ kind: "telegram", chatId: "123" });
  });

  test('username-only ["@alice"] → web-only (usernames are not delivery targets)', () => {
    const pairingStore = makePairingStore(["@alice"]);
    const channels = getOutboundChannels({
      channelManager: makeManager(true),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].kind).toBe("web");
  });

  test("multiple numeric ids → web + telegram with most-recently added chatId", () => {
    const pairingStore = makePairingStore(["111", "222"]);
    const channels = getOutboundChannels({
      channelManager: makeManager(true),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels).toHaveLength(2);
    expect(channels[1]).toEqual({ kind: "telegram", chatId: "222" });
  });

  test("adding a new channel kind to the resolver propagates through cron-delivery without changing delivery.ts", () => {
    // delivery.ts calls getOutboundChannels and dispatchOutbound — any new
    // channel kind added to the resolver automatically flows through cron delivery.
    const pairingStore = makePairingStore(["999"]);
    const channels = getOutboundChannels({
      channelManager: makeManager(true),
      pairingStore,
      logger: makeLogger() as never,
    });
    expect(channels.map((c) => c.kind)).toEqual(["web", "telegram"]);
  });
});

// ---------------------------------------------------------------------------
// createCronDeliveryHandler — full pipeline tests
// ---------------------------------------------------------------------------

describe("createCronDeliveryHandler — web delivery (no telegram pairing)", () => {
  let bus: BusSpy;
  let eventBus: EventBusSpy;
  let runner: RunnerStub;
  let contextBuilder: ContextBuilderStub;
  let cronTool: CronToolStub;
  let deps: CronDeliveryDeps;

  beforeEach(() => {
    bus = new BusSpy();
    eventBus = new EventBusSpy();
    runner = new RunnerStub("Morning briefing text here");
    contextBuilder = new ContextBuilderStub();
    cronTool = new CronToolStub();
    deps = {
      runner: runner as never,
      contextBuilder: contextBuilder as never,
      bus: bus as never,
      eventBus: eventBus as never,
      tools: new ToolRegistryStub({ cron: cronTool }) as never,
      channelManager: makeManager(false),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    };
  });

  test("calls runner with internal channel and cron-prefixed chatId via contextBuilder", async () => {
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob("morning-briefing"));
    expect(runner.calls).toHaveLength(1);
    // contextBuilder.buildFullPrompt("internal", "cron-morning-briefing") is what we expect
    expect(runner.calls[0].systemPrompt).toBe("[system:internal:cron-morning-briefing]");
  });

  test("runner.call is invoked with persist: true", async () => {
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob("morning-briefing"));
    expect(runner.calls[0].persist).toBe(true);
  });

  test("runner message contains all four contract phrases and job.payload.message", async () => {
    const job = makeJob("morning-briefing", "run the briefing");
    const handler = createCronDeliveryHandler(deps);
    await handler(job);
    const message = runner.calls[0].message;
    expect(message).toContain("natural message");
    expect(message).toContain("no narration");
    expect(message).toContain("no status chatter");
    expect(message).toContain("no meta-reasoning");
    expect(message).toContain(job.payload.message);
  });

  test("publishes to eventBus with type=chat.proactive", async () => {
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    expect(eventBus.published).toHaveLength(1);
    expect(eventBus.published[0].type).toBe("chat.proactive");
  });

  test("eventBus payload contains source, content, and ts", async () => {
    const handler = createCronDeliveryHandler(deps);
    const before = Date.now();
    await handler(makeJob("morning-briefing"));
    const after = Date.now();
    const ev = eventBus.published[0]!;
    const payload = ev.payload as { source: string; content: string; ts: number };
    expect(payload.source).toBe("morning-briefing");
    expect(payload.content).toBe("Morning briefing text here");
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });

  test("bus.publishOutbound is NOT called when no telegram pairing exists", async () => {
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    expect(bus.outbound).toHaveLength(0);
  });

  test("returns the response text", async () => {
    const handler = createCronDeliveryHandler(deps);
    const result = await handler(makeJob());
    expect(result).toBe("Morning briefing text here");
  });

  test("empty session → English fallback directive (no recent-messages block)", async () => {
    // Default deps use SessionManagerStub() with no user texts. Runner.call
    // clears state.messages, so without an explicit directive the model
    // would infer language from the UTC offset in runtime context — landing
    // on whatever language the offset's region speaks. The fallback
    // short-circuits that inference.
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    const message = runner.calls[0].message;
    expect(message).toContain("Respond in English");
    expect(message).not.toContain("Recent user messages");
    // English fallback must precede the reminder/task content.
    expect(message.indexOf("Respond in English")).toBeLessThan(message.indexOf("natural message"));
  });

  test("session with user messages → prepended language-reference block (verbatim pass-through)", async () => {
    const first = "how is my APT position doing?";
    const second = "open a SUI short for me";
    deps.sessionManager = new SessionManagerStub([first, second]) as never;
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    const message = runner.calls[0].message;
    expect(message).toContain("Recent user messages");
    expect(message).toContain(first);
    expect(message).toContain(second);
    // The lang-ref block must appear before the REMINDER_NOTE_PREFIX content.
    expect(message.indexOf("Recent user messages")).toBeLessThan(message.indexOf("natural message"));
  });
  // BUG-0151 — user messages persisted with `content: string` (the dominant
  // shape from Orchestrator.runPrompt) must also surface in the language
  // reference. The pre-fix filter dropped them silently and recap defaulted
  // to English.
  test("string-shape user content → language-reference block populated", async () => {
    const vi = "vị thế ETH của tôi đang lỗ bao nhiêu?";
    deps.sessionManager = new SessionManagerStub([vi], "string") as never;
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    const message = runner.calls[0].message;
    expect(message).toContain("Recent user messages");
    expect(message).toContain(vi);
  });
});

describe("createCronDeliveryHandler — empty/whitespace response", () => {
  function makeDeps(text: string): CronDeliveryDeps {
    return {
      runner: new RunnerStub(text) as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: new BusSpy() as never,
      eventBus: new EventBusSpy() as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(false),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    };
  }

  test("returns null when runner responds with empty string", async () => {
    const handler = createCronDeliveryHandler(makeDeps(""));
    expect(await handler(makeJob())).toBeNull();
  });

  test("returns null when runner responds with whitespace only", async () => {
    const handler = createCronDeliveryHandler(makeDeps("   \n  "));
    expect(await handler(makeJob())).toBeNull();
  });

  test("does not publish to eventBus on empty response", async () => {
    const eventBus = new EventBusSpy();
    const deps: CronDeliveryDeps = {
      ...makeDeps(""),
      eventBus: eventBus as never,
    } as CronDeliveryDeps;
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    expect(eventBus.published).toHaveLength(0);
  });
});

describe("createCronDeliveryHandler — CronTool context wrapping", () => {
  test("sets cron context true before runner.call and false after", async () => {
    const cronTool = new CronToolStub();
    const deps: CronDeliveryDeps = {
      runner: new RunnerStub("some text") as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: new BusSpy() as never,
      eventBus: new EventBusSpy() as never,
      tools: new ToolRegistryStub({ cron: cronTool }) as never,
      channelManager: makeManager(false),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    };
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob());
    expect(cronTool.contextCalls).toEqual([true, false]);
  });

  test("resets cron context to false even when runner throws", async () => {
    const cronTool = new CronToolStub();
    const failingRunner = {
      call: async () => { throw new Error("agent crashed"); },
    };
    const deps: CronDeliveryDeps = {
      runner: failingRunner as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: new BusSpy() as never,
      eventBus: new EventBusSpy() as never,
      tools: new ToolRegistryStub({ cron: cronTool }) as never,
      channelManager: makeManager(false),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    };
    const handler = createCronDeliveryHandler(deps);
    await expect(handler(makeJob())).rejects.toThrow("agent crashed");
    expect(cronTool.contextCalls).toEqual([true, false]);
  });

  test("no CronTool registered → handler does not throw", async () => {
    const deps: CronDeliveryDeps = {
      runner: new RunnerStub("text") as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: new BusSpy() as never,
      eventBus: new EventBusSpy() as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(false),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    };
    const handler = createCronDeliveryHandler(deps);
    await expect(handler(makeJob())).resolves.toBe("text");
  });
});

describe("createCronDeliveryHandler — telegram delivery (paired allowlist)", () => {
  // Drives getOutboundChannels through its telegram branch via a real
  // in-memory PairingStore — no GHOST_HOME juggling needed since the
  // SQLite-backed store accepts a Database directly.

  test("publishes to telegram bus AND eventBus (web is always notified)", async () => {
    const eventBus = new EventBusSpy();
    const bus = new BusSpy();
    const handler = createCronDeliveryHandler({
      runner: new RunnerStub("Briefing text") as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: bus as never,
      eventBus: eventBus as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(true),
      pairingStore: makePairingStore(["111", "222"]),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    });
    await handler(makeJob());

    // Telegram bus: most-recent numeric entry ("222") gets the message.
    expect(bus.outbound).toHaveLength(1);
    expect(bus.outbound[0]).toMatchObject({
      channel: "telegram",
      chatId: "222",
      content: "Briefing text",
      metadata: { _proactive: true, _source: "morning-briefing" },
    });

    // Web event: dashboard always gets a chat.proactive — even when
    // Telegram is the primary push target.
    expect(eventBus.published).toHaveLength(1);
    expect(eventBus.published[0].type).toBe("chat.proactive");
    expect(eventBus.published[0].payload).toMatchObject({
      source: "morning-briefing",
      content: "Briefing text",
    });
  });

  test("runner.call always uses internal channel + cron-prefixed chatId in systemPrompt", async () => {
    const runner = new RunnerStub("text");
    const handler = createCronDeliveryHandler({
      runner: runner as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: new BusSpy() as never,
      eventBus: new EventBusSpy() as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(true),
      pairingStore: makePairingStore(["111", "222"]),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    });
    await handler(makeJob("morning-briefing"));
    // ContextBuilderStub encodes channel+chatId in the system prompt string
    expect(runner.calls[0]?.systemPrompt).toBe("[system:internal:cron-morning-briefing]");
  });

  test("falls back to web-only when allowlist is empty", async () => {
    const bus = new BusSpy();
    const eventBus = new EventBusSpy();
    const handler = createCronDeliveryHandler({
      runner: new RunnerStub("text") as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: bus as never,
      eventBus: eventBus as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(true),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    });
    await handler(makeJob());

    expect(bus.outbound).toHaveLength(0);
    expect(eventBus.published).toHaveLength(1);
  });

  test('falls back to web when allowlist is only wildcards: ["*"]', async () => {
    const bus = new BusSpy();
    const eventBus = new EventBusSpy();
    const handler = createCronDeliveryHandler({
      runner: new RunnerStub("text") as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: bus as never,
      eventBus: eventBus as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(true),
      pairingStore: makePairingStore(["*"]),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address: "0xtest" } as never,
      logger: makeLogger() as never,
    });
    await handler(makeJob());

    expect(bus.outbound).toHaveLength(0);
    expect(eventBus.published).toHaveLength(1);
  });
});

describe("createCronDeliveryHandler — wallet gate", () => {
  // Recap reviews today's trades + open positions → strictly needs a wallet.
  // Briefing covers news + market signals + watchlist → runs without a wallet
  // (still useful to a not-yet-onboarded user).

  function makeWalletDeps(address: string): CronDeliveryDeps {
    return {
      runner: new RunnerStub("text") as never,
      contextBuilder: new ContextBuilderStub() as never,
      bus: new BusSpy() as never,
      eventBus: new EventBusSpy() as never,
      tools: new ToolRegistryStub() as never,
      channelManager: makeManager(false),
      pairingStore: makePairingStore(),
      sessionManager: new SessionManagerStub() as never,
      tradingClient: { address } as never,
      logger: makeLogger() as never,
    };
  }

  test("evening-recap skipped when address is empty", async () => {
    const deps = makeWalletDeps("");
    const runner = deps.runner as unknown as RunnerStub;
    const handler = createCronDeliveryHandler(deps);
    const out = await handler(makeJob("evening-recap"));
    expect(out).toBeNull();
    expect(runner.calls).toHaveLength(0);
  });

  test("evening-recap does not publish to eventBus when no wallet is connected", async () => {
    const deps = makeWalletDeps("");
    const eventBus = deps.eventBus as unknown as EventBusSpy;
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob("evening-recap"));
    expect(eventBus.published).toHaveLength(0);
  });

  test("evening-recap proceeds when wallet is connected", async () => {
    const deps = makeWalletDeps("0xabc");
    const runner = deps.runner as unknown as RunnerStub;
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob("evening-recap"));
    expect(runner.calls).toHaveLength(1);
  });

  test("morning-briefing proceeds even without a wallet (news + market work)", async () => {
    const deps = makeWalletDeps("");
    const runner = deps.runner as unknown as RunnerStub;
    const handler = createCronDeliveryHandler(deps);
    await handler(makeJob("morning-briefing"));
    expect(runner.calls).toHaveLength(1);
  });
});

