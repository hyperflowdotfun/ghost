/**
 * Dispatcher test — exercises the REAL grammY Composer via bot.handleUpdate.
 *
 * Capturing handlers by filter key (the easy approach) would mask the bug in
 * grammy-middleware-chain-blocks-handlers — namely that an early `return`
 * without `await next()` silently drops subsequent overlap handlers. Driving
 * the bot the same way Telegram drives it ensures any future regression in
 * middleware ordering is caught.
 */

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Update } from "grammy/types";
import { TelegramChannel } from "../../../../src/channels/telegram/index.js";
import type { ApprovalManager } from "../../../../src/gateway/approval.js";
import type { EventBus } from "../../../../src/bus/events.js";
import type { MessageBus } from "../../../../src/bus/queue.js";
import type { Logger } from "pino";
import { initDatabase } from "../../../../src/core/database.js";
import { PairingStore } from "../../../../src/pairing/store.js";
import { NOOP_LOGGER } from "../../../../src/logger.js";
import type { ChartRenderer, ChartSpec } from "../../../../src/channels/telegram/chart-renderer.js";
import {
  makeWalletInfo, makeBalance, makeTicker, makeArticle, makePosition, makeOrder,
  noopLogger,
} from "./helpers.js";

// Minimal PNG header bytes — good enough for the sendPhoto stub.
const STUB_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function mkStubChartRenderer(opts: {
  throws?: boolean;
} = {}): ChartRenderer {
  return {
    snapshot: mock(async (_spec: ChartSpec) => {
      if (opts.throws) throw new Error("webview unavailable");
      return STUB_PNG;
    }),
    close: mock(async () => {}),
    buildUrl: mock(() => ""),
  } as unknown as ChartRenderer;
}

interface ApiCall { method: string; payload: unknown }

function mkBus(): MessageBus {
  return {
    publishInbound: mock(() => {}),
    subscribe: mock(() => () => {}),
  } as unknown as MessageBus;
}

function mkEventBus(): EventBus {
  return { subscribe: mock(() => () => {}), publish: mock(() => {}) } as unknown as EventBus;
}

async function mkChannel(opts: {
  allowFrom?: string[];
  wallets?: ReturnType<typeof makeWalletInfo>[];
} = {}) {
  const calls: ApiCall[] = [];

  const services = {
    tradingClient: {
      getBalance: async () => makeBalance(),
      getPositions: async () => [makePosition()],
      getOpenOrders: async () => [makeOrder()],
      getTicker: async (sym: string) => makeTicker(sym),
    },
    walletStore: {
      listWallets: () => opts.wallets ?? [makeWalletInfo("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")],
    },
    newsService: {
      getArticles: () => [
        makeArticle({ title: "Hello", url: "https://x/y", description: "A great summary." }),
      ],
      // Drain-mode path (default /news) — return the same fixture so the
      // formatter pipeline runs end-to-end regardless of which mode the
      // dispatcher test exercises.
      getUnshownArticles: () => [
        makeArticle({ title: "Hello", url: "https://x/y", description: "A great summary." }),
      ],
      markArticlesShown: () => {},
      getSourceNames: () => new Map<string, string>(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // Drive the allowlist through the real pairing store so the production
  // BaseChannel.getAllowList path is exercised.
  const pairingStore = new PairingStore(initDatabase(":memory:"), NOOP_LOGGER);
  pairingStore.setAllowlist("telegram", opts.allowFrom ?? ["7"]);

  const mockPairingService = { issueChallenge: async () => ({ created: false }), approveRequest: () => ({ approved: false }), revoke: () => {}, listRequests: () => [], listAllowlist: () => [] } as unknown as import("../../../../src/pairing/service.js").PairingService;
  const ch = new TelegramChannel(
    {} as import("../../../../src/config/schema.js").TelegramChannelConfig,
    "123:abc",
    mkBus(),
    noopLogger as Logger,
    mkEventBus(),
    {} as ApprovalManager,
    pairingStore,
    services,
    mockPairingService,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyCh = ch as any;

  // Install a fake bot transport so the Composer runs without network I/O.
  // We swap the bot wholesale (the constructor's stream/auto-retry plugins
  // aren't needed for slash-command path testing).
  const { Bot } = require("grammy") as typeof import("grammy");
  const fakeBot = new Bot("1:stub", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    botInfo: {
      id: 1, is_bot: true, username: "ghostbot", first_name: "ghost",
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    } as any,
  });
  fakeBot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 42, type: "private" } } } as never;
  });
  anyCh.bot = fakeBot;

  // Run the production registration code on the swapped bot — driving the
  // real Composer ensures any future ordering regression (per the
  // grammy-middleware-chain-blocks-handlers skill) is caught here. Call
  // buildHandlerDeps + registerTelegramHandlers (NOT registerBotCommandHandler
  // in isolation) so the message:text handler that sits before the bot_command
  // handler in the Composer is also installed — otherwise tests bypass the exact
  // chain the ordering regression lives in.
  const { registerTelegramHandlers } = await import("../../../../src/channels/telegram/handlers.js");
  registerTelegramHandlers(fakeBot, anyCh.buildHandlerDeps());

  return { ch, fakeBot, calls };
}

function mkCommandUpdate(text: string, opts: { senderId?: number; chatId?: number } = {}): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1, date: 0,
      chat: { id: opts.chatId ?? 42, type: "private", first_name: "trader" },
      from: { id: opts.senderId ?? 7, is_bot: false, first_name: "trader" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }],
    },
  };
}

describe("Telegram slash-command dispatcher (real Composer)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `ghost-tg-slash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env["GHOST_HOME"] = tmpHome;
  });

  afterEach(() => {
    delete process.env["GHOST_HOME"];
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("/portfolio sends an HTML reply through the formatter", async () => {
    const { fakeBot, calls } = await mkChannel();
    await fakeBot.handleUpdate(mkCommandUpdate("/portfolio"));
    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const payload = send!.payload as { text: string; parse_mode?: string };
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("Portfolio");
  });

  it("/news passes through the formatter (HTML escape applied)", async () => {
    const { fakeBot, calls } = await mkChannel();
    await fakeBot.handleUpdate(mkCommandUpdate("/news"));
    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const payload = send!.payload as { text: string };
    // Text contains the LLM summary (not the raw title).
    expect(payload.text).toContain("A great summary.");
  });

  it("/price BTC renders ticker via formatter", async () => {
    const { fakeBot, calls } = await mkChannel();
    await fakeBot.handleUpdate(mkCommandUpdate("/price BTC"));
    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const payload = send!.payload as { text: string };
    expect(payload.text).toContain("BTC");
    expect(payload.text).toContain("Funding");
  });

  it("/price without arg returns usage hint", async () => {
    const { fakeBot, calls } = await mkChannel();
    await fakeBot.handleUpdate(mkCommandUpdate("/price"));
    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const payload = send!.payload as { text: string };
    expect(payload.text.toLowerCase()).toContain("usage");
  });

  it("denies unauthorized senders silently (no API call)", async () => {
    const { fakeBot, calls } = await mkChannel({ allowFrom: ["999"] });
    await fakeBot.handleUpdate(mkCommandUpdate("/portfolio", { senderId: 7 }));
    expect(calls.find((c) => c.method === "sendMessage")).toBeUndefined();
  });

  it("recognizes /cmd@botname forms in group chats", async () => {
    const { fakeBot, calls } = await mkChannel();
    await fakeBot.handleUpdate(mkCommandUpdate("/portfolio@ghostbot"));
    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const payload = send!.payload as { text: string };
    expect(payload.text).toContain("Portfolio");
  });

  // Regression: with message:text registered BEFORE the bot_command
  // handler in production order, an early `return` (no `await next()`) in the
  // text handler silently blocked every slash command. This test installs
  // handlers via registerTelegramHandlers() — the same path start() uses — and
  // proves /portfolio still reaches the slash dispatcher under the full chain.
  // Without the fix this test FAILS (no sendMessage emitted for /portfolio);
  // with the fix it PASSES.
  it("/portfolio reaches dispatcher with message:text registered first", async () => {
    const { fakeBot, calls } = await mkChannel();
    await fakeBot.handleUpdate(mkCommandUpdate("/portfolio"));
    const send = calls.find((c) => c.method === "sendMessage");
    expect(send).toBeDefined();
    const payload = send!.payload as { text: string; parse_mode?: string };
    expect(payload.parse_mode).toBe("HTML");
    expect(payload.text).toContain("Portfolio");
  });
});

// ---------------------------------------------------------------------------
// Chart screenshot integration — drives TelegramChannel.send() directly
// ---------------------------------------------------------------------------

async function mkSendChannel(opts: {
  chartRenderer?: ChartRenderer;
} = {}) {
  const calls: ApiCall[] = [];

  const pairingStore = new PairingStore(initDatabase(":memory:"), NOOP_LOGGER);
  pairingStore.setAllowlist("telegram", ["7"]);

  const mockPairingService = {
    issueChallenge: async () => ({ created: false }),
    approveRequest: () => ({ approved: false }),
    revoke: () => {},
    listRequests: () => [],
    listAllowlist: () => [],
  } as unknown as import("../../../../src/pairing/service.js").PairingService;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const services = {} as any;

  const ch = new TelegramChannel(
    {} as import("../../../../src/config/schema.js").TelegramChannelConfig,
    "123:abc",
    mkBus(),
    noopLogger as Logger,
    mkEventBus(),
    {} as ApprovalManager,
    pairingStore,
    services,
    mockPairingService,
    opts.chartRenderer,
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyCh = ch as any;
  const { Bot } = require("grammy") as typeof import("grammy");
  const fakeBot = new Bot("1:stub", {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    botInfo: {
      id: 1, is_bot: true, username: "ghostbot", first_name: "ghost",
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    } as any,
  });
  fakeBot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload });
    return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: 42, type: "private" } } } as never;
  });
  anyCh.bot = fakeBot;

  return { ch, calls };
}

describe("TelegramChannel.send() — chart screenshot integration", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = join(tmpdir(), `ghost-tg-chart-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpHome, { recursive: true });
    process.env["GHOST_HOME"] = tmpHome;
  });

  afterEach(() => {
    delete process.env["GHOST_HOME"];
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("happy path: sendPhoto is called with PNG and no caption when chartRenderer succeeds", async () => {
    const renderer = mkStubChartRenderer();
    const { ch, calls } = await mkSendChannel({ chartRenderer: renderer });

    await ch.send({
      chatId: "42",
      content: 'Prose here.\n<chart symbol="BTC" interval="4h" />',
      channel: "telegram", media: [], metadata: {},
    });

    const msg = calls.find((c) => c.method === "sendMessage");
    expect(msg).toBeDefined();
    const msgPayload = msg!.payload as { text: string; parse_mode?: string };
    expect(msgPayload.text).toContain("Prose here.");
    expect(msgPayload.parse_mode).toBe("HTML");

    const photo = calls.find((c) => c.method === "sendPhoto");
    expect(photo).toBeDefined();
    expect((photo!.payload as { caption?: string }).caption).toBeUndefined();

    expect(renderer.snapshot).toHaveBeenCalledTimes(1);
  });

  it("renderer failure: silent — no sendPhoto and no fallback sendMessage for the chart", async () => {
    const renderer = mkStubChartRenderer({ throws: true });
    const { ch, calls } = await mkSendChannel({ chartRenderer: renderer });

    await ch.send({
      chatId: "42",
      content: 'Prose here.\n<chart symbol="ETH" interval="1h" />',
      channel: "telegram", media: [], metadata: {},
    });

    expect(calls.find((c) => c.method === "sendPhoto")).toBeUndefined();
    const texts = calls.filter((c) => c.method === "sendMessage").map((m) => (m.payload as { text: string }).text);
    expect(texts.some((t) => t.includes("Prose here."))).toBe(true);
    expect(texts.some((t) => t.includes("chart"))).toBe(false);
  });

  it("no chartRenderer: silent — chart specs do not emit any extra Telegram message", async () => {
    const { ch, calls } = await mkSendChannel();

    await ch.send({
      chatId: "42",
      content: 'Hello.\n<chart symbol="SOL" interval="15m" />',
      channel: "telegram", media: [], metadata: {},
    });

    expect(calls.find((c) => c.method === "sendPhoto")).toBeUndefined();
    const texts = calls.filter((c) => c.method === "sendMessage").map((m) => (m.payload as { text: string }).text);
    expect(texts.some((t) => t.includes("chart"))).toBe(false);
  });

  it("multiple charts: each chart spec triggers one sendPhoto with no caption", async () => {
    const renderer = mkStubChartRenderer();
    const { ch, calls } = await mkSendChannel({ chartRenderer: renderer });

    await ch.send({
      chatId: "42",
      content: 'Prose.\n<chart symbol="BTC" interval="4h" />\n<chart symbol="ETH" interval="1h" />',
      channel: "telegram", media: [], metadata: {},
    });

    const photos = calls.filter((c) => c.method === "sendPhoto");
    expect(photos).toHaveLength(2);
    for (const p of photos) {
      expect((p.payload as { caption?: string }).caption).toBeUndefined();
    }
    expect(renderer.snapshot).toHaveBeenCalledTimes(2);
  });
});
