import { z } from "zod";

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const memorySchema = z.object({
  contextWindowTokens: z.coerce.number().int().positive().default(65_536),
  maxCompletionTokens: z.coerce.number().int().positive().default(8_192),
  maxConsolidationRounds: z.coerce.number().int().positive().default(5),
});

/** Default gateway port used across service definitions and onboarding. */
export const DEFAULT_GATEWAY_PORT = 15401;

export const gatewaySchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(DEFAULT_GATEWAY_PORT),
  host: z.string().default("127.0.0.1"),
  rateLimitRpm: z.coerce.number().int().positive().default(100),
  /**
   * Explicit opt-in required to bind to a non-loopback address.
   * Gateway has no in-app auth; the only safe defaults are loopback bind
   * OR an explicit acknowledgement of the exposure via this flag.
   */
  allowPublicBind: z.boolean().default(false),
});

export const autonomySchema = z.object({
  level: z.enum(["read_only", "supervised", "full"]).default("supervised"),
  restrictToWorkspace: z.boolean().default(true),
  blockHighRiskCommands: z.boolean().default(true),
  requireApprovalForMediumRisk: z.boolean().default(true),
});

export const securitySchema = z.object({
  allowedCommands: z.array(z.string()).default(["npx", "node", "python3", "deno"]),
  blockedPaths: z.array(z.string()).default(["/etc", "/sys", "/proc"]),
  enableLeakDetection: z.boolean().default(true),
  enableAuditLog: z.boolean().default(true),
  rateLimitWindow: z.coerce.number().int().positive().default(3600),
  rateLimitMax: z.coerce.number().int().positive().default(100),
});

export const agentSchema = z.object({
  maxContextTokens: z.coerce.number().int().positive().default(32000),
  maxHistoryMessages: z.coerce.number().default(50),
  parallelTools: z.boolean().default(false),
  /** Default thinking level for reasoning models. "low" is safe for all providers. */
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high"]).default("low"),
  /** Token budgets per thinking level. Controls how many tokens the model can use for reasoning. */
  thinkingBudgets: z.object({
    minimal: z.coerce.number().int().positive().default(1024),
    low: z.coerce.number().int().positive().default(2048),
    medium: z.coerce.number().int().positive().default(8192),
    high: z.coerce.number().int().positive().default(16384),
  }).default({}),
});

export const cronSchema = z.object({
  enableScheduler: z.boolean().default(true),
  maxConcurrentJobs: z.coerce.number().int().positive().default(5),
});

export const telegramChannelSchema = z.object({
  streaming: z.boolean().default(true),
  replyToMessage: z.boolean().default(false),
  reactEmoji: z.string().default(""),
});

/** Settings for the MessageDispatcher (outbound retry, progress, concurrency). */
export const dispatcherSchema = z.object({
  sendProgress: z.boolean().default(true),
  sendToolHints: z.boolean().default(false),
  sendMaxRetries: z.coerce.number().int().min(0).max(10).default(3),
  maxConcurrentRequests: z.coerce.number().int().positive().default(3),
});

export const skillsSchema = z.object({
  skillsDir: z.string().default("~/.ghost/skills"),
  enableAutoDiscover: z.boolean().default(true),
  builtinSkillsDir: z.string().default(""),
});

export const secretsSchema = z.object({
  keyPath: z.string().default("~/.ghost/.secret_key"),
  encrypt: z.boolean().default(true),
});

export const paperSchema = z.object({
  enabled: z.boolean().default(false),
  initialBalance: z.coerce.number().positive().default(10000),
  priceMonitorInterval: z.coerce.number().int().positive().default(5000),
  /** Taker fee — Hyperliquid tier 0 default: 0.045% */
  takerFee: z.coerce.number().min(0).max(0.01).default(0.00045),
  /** Maker fee — Hyperliquid tier 0 default: 0.015% */
  makerFee: z.coerce.number().min(0).max(0.01).default(0.00015),
});

export const priceFeedSchema = z.object({
  /** Master switch — when false the gateway does not start any price source. */
  enabled: z.boolean().default(true),
  /** Include Binance WebSocket as a priority-2 fallback source. */
  binanceEnabled: z.boolean().default(true),
  /** A source counts as stale if it has not produced a tick within this window. */
  staleThresholdMs: z.coerce.number().int().positive().default(10_000),
  /** How long a higher-priority source must be healthy before it can reclaim primary. */
  stabilityWindowMs: z.coerce.number().int().positive().default(30_000),
  /** HL REST polling interval (only used when this source is active). */
  hlRestIntervalMs: z.coerce.number().int().positive().default(5_000),
});

export const observerSchema = z.object({
  /**
   * Master kill switch for the unified observer loop. Defaults to true —
   * the observer is the ONLY proactive/alert scanner. Set false only as
   * an emergency disable; nothing else will produce proactive output.
   */
  enabled: z.boolean().default(true),
  /**
   * Eval cadence (ms). Every tick reads PriceCache + cached REST snapshot,
   * runs detection, filter, and optionally the judge LLM. In-memory only —
   * cheap. Default 5s.
   */
  tickMs: z.coerce.number().int().positive().default(5_000),
  /**
   * REST sync cadence (ms). Throttles `getPositions` / `getOpenOrders` /
   * `getFillsByTime` / `getHistoricalOrders` polling separately from the
   * eval loop. Eval reuses the cached snapshot between sync intervals.
   * Default 60s — matches HL rate-limit friendliness.
   */
  syncIntervalMs: z.coerce.number().int().positive().default(60_000),
  /**
   * Liquidation risk threshold — fraction of the entry→liq distance the
   * mark price has traveled. Default 0.8 (80%). Leverage-agnostic.
   */
  liquidationProgressThreshold: z.coerce.number().min(0.1).max(0.99).default(0.8),
});

export const tradingMode = z.enum(["live", "testnet", "paper"]);
export type TradingMode = z.infer<typeof tradingMode>;

// ---------------------------------------------------------------------------
// Top-level config schema
// ---------------------------------------------------------------------------

export const configSchema = z.object({
  /**
   * Config schema version. Owned by the config migration runner in
   * src/core/migrations/config.ts. Bumped when a migration reshapes
   * persisted config. Defaults to 1 for fresh installs and for older
   * configs written before this field existed.
   */
  schemaVersion: z.coerce.number().int().positive().default(1),
  mode: tradingMode.default("live"),
  provider: z.string().default("openrouter"),
  model: z.string().default("anthropic/claude-sonnet-4"),
  /** Optional base URL override — used by Ollama and self-hosted endpoints. */
  apiUrl: z.string().optional(),

  memory: memorySchema.default({}),
  gateway: gatewaySchema.default({}),
  autonomy: autonomySchema.default({}),
  security: securitySchema.default({}),
  agent: agentSchema.default({}),
  cron: cronSchema.default({}),
  /** Dispatcher settings (progress, retries, concurrency). */
  dispatcher: dispatcherSchema.default({}),
  /** Telegram channel config — always present with defaults; the credential
   *  store is the source of truth for whether Telegram is actually connected. */
  telegram: telegramChannelSchema.default({}),
  skills: skillsSchema.default({}),
  secrets: secretsSchema.default({}),
  paper: paperSchema.default({}),
  priceFeed: priceFeedSchema.default({}),
  /** Verbosity level: 0=info, 1=debug (-v), 2=trace (-vv). */
  verbosity: z.coerce.number().int().min(0).max(2).default(0).transform((v) => v as 0 | 1 | 2),
  observer: observerSchema.default({}),
});

/** Fully typed config inferred from Zod schema. */
export type Config = z.infer<typeof configSchema>;
export type MemoryConfig = z.infer<typeof memorySchema>;
export type GatewayConfig = z.infer<typeof gatewaySchema>;
export type AutonomyConfig = z.infer<typeof autonomySchema>;
export type SecurityConfig = z.infer<typeof securitySchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type CronConfig = z.infer<typeof cronSchema>;
export type DispatcherConfig = z.infer<typeof dispatcherSchema>;
export type TelegramChannelConfig = z.infer<typeof telegramChannelSchema>;
export type SkillsConfig = z.infer<typeof skillsSchema>;
export type SecretsConfig = z.infer<typeof secretsSchema>;
export type PaperConfig = z.infer<typeof paperSchema>;
export type PriceFeedConfig = z.infer<typeof priceFeedSchema>;
export type ObserverConfig = z.infer<typeof observerSchema>;
