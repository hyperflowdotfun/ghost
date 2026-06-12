/**
 * Hyperliquid API client — read + write endpoints.
 */

import { ExchangeClient, HttpTransport, WebSocketTransport, SubscriptionClient } from "@nktkas/hyperliquid";
import type { ISubscription } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import type {
  Balance, Position, OpenOrder, Fill, Ticker, Kline, Orderbook,
  PlaceOrderParams, PlaceOrderResult, CancelOrderResult, LeverageResult,
  OrderRecord, TokenInfo,
} from "../interfaces/trading-types.js";
import type { ITradingSubscription } from "../interfaces/trading-client.js";
import type { ITradingClient, AllDexsAssetCtxsEvent } from "../interfaces/trading-client.js";
import type { Logger } from "pino";
import { generateGhostCloid } from "../../helpers/cloid.js";
import { InfoCache, runWithConcurrency } from "./info-cache.js";

const MAINNET_URL = "https://api.hyperliquid.xyz";
const TESTNET_URL = "https://api.hyperliquid-testnet.xyz";

/**
 * Per-request ceiling for /info reads. Bun/Node `fetch` has no default
 * timeout, so a wedged socket would otherwise hang the await forever — and
 * because every read RPC (positions, balance, meta, …) flows through here,
 * one stuck call holds the orchestrator's session lock and freezes all chat.
 * Matches the 10s guard `klines` already applies via Promise.race.
 */
const INFO_REQUEST_TIMEOUT_MS = 10_000;

class BunCompatWebSocket extends WebSocket {
  set binaryType(value: BinaryType) {
    super.binaryType = (value as string) === "blob" ? "arraybuffer" : value;
  }
  get binaryType(): BinaryType {
    return super.binaryType;
  }
}

/** HL k-prefix tokens (1000-unit normalized perps). Stored uppercase here;
 *  resolveSymbol() restores the lowercase `k` prefix on hit. */
const K_PREFIX_TOKENS = new Set([
  "KPEPE", "KBONK", "KSHIB", "KFLOKI", "KNEIRO", "KLUNC",
]);

function mapFill(f: RawFill): Fill {
  return {
    tradeId: String(f.tid),
    symbol: f.coin,
    side: f.side === "B" ? "buy" : "sell",
    price: parseFloat(f.px),
    size: parseFloat(f.sz),
    fee: parseFloat(f.fee),
    feeToken: f.feeToken ?? "USDC",
    realizedPnl: parseFloat(f.closedPnl ?? "0"),
    timestamp: f.time,
    dir: typeof f.dir === "string" ? f.dir : undefined,
    liquidation: f.liquidation != null ? true : undefined,
  };
}

/**
 * Map raw HL `historicalOrders` payload entry to OrderRecord. HL's wire shape
 * nests order fields under `.order` and surfaces lifecycle status at the top
 * level. `oid` ships as a number on the wire but the OrderRecord contract
 * stores it as a string for downstream stability (Task 1 review).
 */
function mapOrderRecord(raw: any): OrderRecord {
  const o = raw.order ?? {};
  const triggerPxStr: string | null = o.triggerPx ?? null;
  return {
    oid: String(o.oid),
    cloid: typeof o.cloid === "string" ? o.cloid : null,
    symbol: String(o.coin),
    side: o.side === "B" ? "buy" : "sell",
    price: parseFloat(o.limitPx ?? "0"),
    triggerPrice: triggerPxStr && triggerPxStr !== "0" && triggerPxStr !== "0.0" && parseFloat(triggerPxStr) > 0
      ? parseFloat(triggerPxStr)
      : null,
    size: parseFloat(o.sz ?? "0"),
    reduceOnly: o.reduceOnly === true,
    // Cast through union; unknown HL statuses pass through — consumers must filter conservatively.
    status: (raw.status ?? "open") as OrderRecord["status"],
    // Use HL-provided timestamps; emit NaN if both are missing so the filter excludes the entry.
    timestamp: Number(raw.statusTimestamp ?? o.timestamp ?? NaN),
  };
}

export interface HyperliquidConfig {
  address?: string;
  privateKey?: string;
  testnet?: boolean;
}

/** Minimal shape returned by the perpDexs info endpoint. */
export interface PerpDexInfo {
  name: string;   // e.g. "xyz", "flx", "vntl"
  fullName: string;
  deployer: string;
  // Optional fields HL also ships — not consumed by Ghost today but typed to avoid `as any` casts later.
  oracleUpdater?: string;
  feeRecipient?: string;
  assetToStreamingOiCap?: Record<string, unknown>;
}

/** Asset metadata shape from universe arrays. */
interface AssetMeta {
  name: string;
  szDecimals?: number;
  /** Surfaced via getMaxLeverage() so callers (gateway, future tools) can render leverage caps without re-fetching meta. */
  maxLeverage?: number;
  /** HL flags markets it has removed; consumers filter these out of token lists/charts. */
  isDelisted?: boolean;
}

/**
 * Parse a symbol into its dex prefix and base name.
 * "xyz:AAPL"  → { dex: "xyz", name: "xyz:AAPL" }
 * "BTC"       → { dex: null,  name: "BTC" }
 * " xyz:AAPL" → trimmed before parsing
 * ":AAPL"     → { dex: null,  name: ":AAPL" }  (empty dex — treat as native lookup, will fail cleanly)
 * "xyz:"      → { dex: null,  name: "xyz:" }   (empty name — treat as native lookup, will fail cleanly)
 */
function parseDex(symbol: string): { dex: string | null; name: string } {
  const trimmed = symbol.trim();
  const colon = trimmed.indexOf(":");
  if (colon === -1) return { dex: null, name: trimmed };
  const dex = trimmed.slice(0, colon);
  const afterColon = trimmed.slice(colon + 1);
  // Reject malformed: empty dex prefix or empty name — treat as native (will fail to resolve cleanly)
  if (!dex || !afterColon) return { dex: null, name: trimmed };
  return { dex, name: trimmed };
}

/**
 * Raw HL wire types — narrowed once at the WS listener boundary.
 * Defined alongside the mapFromRaw helpers that consume them.
 */
interface RawClearinghouse {
  marginSummary?: { accountValue?: string; totalMarginUsed?: string };
  assetPositions?: Array<{
    position: {
      coin: string;
      szi: string;
      entryPx: string;
      positionValue?: string;
      unrealizedPnl: string;
      returnOnEquity?: string;
      leverage?: { value?: string; type?: string };
      marginUsed: string;
      liquidationPx?: string;
    };
  }>;
}

interface RawOpenOrder {
  oid: string | number;
  coin: string;
  side: string;
  orderType?: string;
  limitPx?: string;
  triggerPx?: string | null;
  sz: string;
  origSz?: string;
  reduceOnly?: boolean;
  timestamp?: number;
}

interface RawFill {
  tid: string | number;
  coin: string;
  side: string;
  px: string;
  sz: string;
  fee: string;
  feeToken?: string;
  closedPnl?: string;
  time: number;
  dir?: string;
  liquidation?: unknown;
}

/** Map raw clearinghouseState assetPositions array to Position[]. */
function mapPositionsFromRaw(raw: RawClearinghouse): Position[] {
  const positions: Position[] = [];
  for (const ap of raw.assetPositions ?? []) {
    const pos = ap.position;
    const szi = parseFloat(pos.szi);
    if (szi === 0) continue;
    const entryPx = parseFloat(pos.entryPx);
    const markPx = pos.positionValue ? Math.abs(parseFloat(pos.positionValue) / szi) : entryPx;
    positions.push({
      symbol: pos.coin,
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      entryPrice: entryPx,
      markPrice: markPx,
      liquidationPrice: pos.liquidationPx && pos.liquidationPx !== "0.0" && parseFloat(pos.liquidationPx) > 0 ? parseFloat(pos.liquidationPx) : null,
      unrealizedPnl: parseFloat(pos.unrealizedPnl),
      unrealizedPnlPct: parseFloat(pos.returnOnEquity ?? "0") * 100,
      leverage: parseFloat(pos.leverage?.value ?? "1"),
      marginMode: pos.leverage?.type === "isolated" ? "isolated" : "cross",
      margin: parseFloat(pos.marginUsed),
    });
  }
  return positions;
}

/** Map a raw frontendOpenOrders entry to OpenOrder. */
function mapOpenOrderFromRaw(o: RawOpenOrder): OpenOrder {
  return {
    orderId: String(o.oid),
    symbol: o.coin,
    side: o.side === "B" ? "buy" as const : "sell" as const,
    orderType: o.orderType ?? "Limit",
    price: o.limitPx ? parseFloat(o.limitPx) : null,
    triggerPrice: o.triggerPx && o.triggerPx !== "0.0" ? parseFloat(o.triggerPx) : null,
    size: parseFloat(o.sz),
    filled: parseFloat(o.origSz ?? o.sz) - parseFloat(o.sz),
    reduceOnly: o.reduceOnly ?? false,
    timestamp: o.timestamp ?? Date.now(),
  };
}

/**
 * Map a raw ctx object to a Ticker using the given symbol name.
 */
function ctxToTicker(ctx: any, symbol: string): Ticker {
  const markPx = parseFloat(ctx.markPx ?? "0");
  const prevDay = parseFloat(ctx.prevDayPx ?? "0");
  return {
    symbol,
    markPrice: markPx,
    midPrice: parseFloat(ctx.midPx ?? "0"),
    oraclePrice: parseFloat(ctx.oraclePx ?? "0"),
    volume24h: parseFloat(ctx.dayNtlVlm ?? "0"),
    prevDayPrice: prevDay,
    priceChangePct24h: prevDay > 0 ? ((markPx - prevDay) / prevDay) * 100 : 0,
    openInterest: parseFloat(ctx.openInterest ?? "0"),
    fundingRate: parseFloat(ctx.funding ?? "0"),
  };
}

export class HyperliquidClient implements ITradingClient {
  private baseUrl: string;
  private defaultAddress: string;
  private exchange: ExchangeClient | null = null;
  private readonly log: Logger;
  private readonly testnet: boolean;

  private assetMap: Map<string, number> = new Map();
  private szDecimals: Map<string, number> = new Map();
  private maxLeverage: Map<string, number> = new Map();
  private assets: TokenInfo[] = [];
  private metaLoaded = false;
  // Single-flight promise for concurrent ensureMeta() callers during rebuild.
  private metaInFlight: Promise<void> | null = null;

  // Per-dex universe names keyed by dex name ("" = native).
  // Populated by ensureMeta() and used by getAllTickers() to pair ctxs with symbols.
  private dexUniverses: Map<string, string[]> = new Map();

  // HIP-3 dex list cache (1 hour TTL).
  private dexListCache: PerpDexInfo[] | null = null;
  private dexListCacheAt = 0;
  private readonly DEX_CACHE_TTL_MS = 60 * 60 * 1000;

  // Short-TTL cache for metaAndAssetCtxs calls (3s) to coalesce concurrent callers.
  private readonly infoCache = new InfoCache(3000);

  // ─── WS transport (single socket, lazy-init, shared by all subscribers) ───
  private wsTransport: WebSocketTransport | null = null;
  private wsSubClient: SubscriptionClient | null = null;
  // Single-flight: concurrent first-callers share one init promise.
  private wsLifecycle: Promise<SubscriptionClient> | null = null;

  // Tracks whether the WS client has been disposed so getSubscriptionClient()
  // can refuse to create a zombie transport after closeWs().
  private wsDisposed = false;

  constructor(config: HyperliquidConfig | undefined, logger: Logger) {
    this.defaultAddress = config?.address ?? "";
    this.testnet = config?.testnet ?? false;
    this.baseUrl = this.testnet ? TESTNET_URL : MAINNET_URL;
    this.log = logger;

    if (config?.privateKey) {
      const wallet = privateKeyToAccount(config.privateKey as `0x${string}`);
      const transport = new HttpTransport({ isTestnet: this.testnet });
      this.exchange = new ExchangeClient({ wallet, transport });
    }
  }

  get canWrite(): boolean { return this.exchange !== null; }
  get address(): string { return this.defaultAddress; }

  /** Connect (or reconnect) client at runtime (e.g. when user provides PK via chat). */
  connect(config: HyperliquidConfig): void {
    this.defaultAddress = config.address || this.defaultAddress;
    this.baseUrl = config.testnet ? TESTNET_URL : MAINNET_URL;
    // Allow a fresh WS session after disconnect().
    this.wsDisposed = false;
    if (config.privateKey) {
      const wallet = privateKeyToAccount(config.privateKey as `0x${string}`);
      const transport = new HttpTransport({ isTestnet: config.testnet });
      this.exchange = new ExchangeClient({ wallet, transport });
    }
  }

  /** Disconnect wallet — clears address, exchange client, and WS transport. */
  disconnect(): void {
    this.defaultAddress = "";
    this.exchange = null;
    // Best-effort WS teardown — fire-and-forget so disconnect() stays sync.
    void this.closeWs();
  }

  private requireExchange(): ExchangeClient {
    if (!this.exchange) throw new Error("Write operations require a private key. Use the connect_wallet tool or set hlPrivateKey in config.");
    return this.exchange;
  }

  // ─── HTTP helper ───

  /**
   * POST to /info with retry on 429. Pass `{ cache: true }` to coalesce
   * concurrent identical calls through the short-TTL promise cache —
   * appropriate for read-mostly market-data endpoints (metaAndAssetCtxs)
   * where a slightly-stale shared response is preferable to N parallel
   * weight hits. Default is uncached so account-state reads
   * (clearinghouseState, userFills, …) stay fresh.
   *
   * On 429 the method waits for the server-supplied Retry-After delay (or
   * 250 * 2^attempt ms when the header is absent) plus 0–100 ms jitter,
   * then recurses up to 3 times before giving up. Any other non-2xx status
   * throws immediately with no retry.
   */
  private async info(
    type: string,
    extra: Record<string, unknown> = {},
    options: { cache?: boolean } = {},
  ): Promise<unknown> {
    if (!options.cache) return this.fetchInfo(type, extra, 0);
    const key = `${type}:${JSON.stringify(extra)}`;
    return this.infoCache.get(key, () => this.fetchInfo(type, extra, 0));
  }

  private async fetchInfo(
    type: string,
    extra: Record<string, unknown>,
    attempt: number,
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, ...extra }),
      // Fresh signal per attempt — each recursive retry below gets its own budget.
      signal: AbortSignal.timeout(INFO_REQUEST_TIMEOUT_MS),
    });

    if (res.status === 429 && attempt < 3) {
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfterSec = retryAfterRaw !== null ? Number(retryAfterRaw) : NaN;
      // Cap server-supplied Retry-After at 5s so a hostile or misconfigured
      // upstream can't stall a single info() call for minutes (≤3 retries × cap).
      const MAX_RETRY_AFTER_MS = 5000;
      const baseMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
        ? Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS)
        : 250 * Math.pow(2, attempt); // 250 → 500 → 1000 ms
      const jitterMs = Math.random() * 100;
      this.log.debug({ type, dex: extra.dex, attempt, delayMs: baseMs + jitterMs }, "rate limited — retrying after backoff");
      await new Promise<void>((resolve) => setTimeout(resolve, baseMs + jitterMs));
      return this.fetchInfo(type, extra, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Hyperliquid ${type}: ${res.status} ${text}`);
    }
    return res.json();
  }

  // ─── HIP-3 dex enumeration ───

  /**
   * Return all active HIP-3 builder dexes. Cached for 1h.
   * On error, logs a warning and returns [] so native universe still works.
   *
   * The perpDexs response starts with a null entry (native dex placeholder).
   * We filter it out and return only objects with a string name.
   */
  async listPerpDexes(force = false): Promise<PerpDexInfo[]> {
    if (this.testnet) return [];

    const now = Date.now();
    if (!force && this.dexListCache !== null && now - this.dexListCacheAt < this.DEX_CACHE_TTL_MS) {
      return this.dexListCache;
    }
    try {
      const raw = await this.info("perpDexs"); // as unknown — guarded below
      if (!Array.isArray(raw)) {
        this.log.warn({ raw }, "perpDexs returned non-array — HIP-3 symbols will be unavailable");
        this.dexListCache = [];
        this.dexListCacheAt = now;
        return [];
      }
      const dexes = (raw as Array<unknown>).filter(
        (d): d is PerpDexInfo => d !== null && typeof d === "object" && typeof (d as PerpDexInfo).name === "string",
      );
      this.dexListCache = dexes;
      this.dexListCacheAt = now;
      return dexes;
    } catch (err) {
      this.log.warn({ err }, "listPerpDexes failed — HIP-3 symbols will be unavailable");
      return [];
    }
  }

  // ─── Asset metadata ───

  /**
   * Load universe metadata for native perps + all HIP-3 dexes in parallel.
   * A per-dex failure is skipped with a warning — native universe always loads.
   *
   * metaLoaded is invalidated when the dex list refreshes with new dexes,
   * so a previously-failed dex doesn't stay gone for the daemon's lifetime
   * once its TTL expires and the dex list re-populates.
   *
   * Concurrent callers share a single in-flight rebuild via metaInFlight — the
   * thundering-herd window on cold start and on new-dex detection is collapsed
   * to a single 1+N fan-out regardless of how many callers arrive in parallel.
   *
   * Daemon comes up degraded rather than refusing to start when HL native is
   * partially down — native failure is isolated and logged, HIP-3 still loads.
   */
  async ensureMeta(): Promise<void> {
    if (this.metaLoaded) {
      // Fast path: already loaded. Re-check dex list only to detect new dexes.
      // listPerpDexes is 1 h cached, so this is cheap in steady state.
      const currentDexes = await this.listPerpDexes().catch(() => []);
      const knownDexNames = new Set(this.dexUniverses.keys());
      const hasNewDex = currentDexes.some((d) => !knownDexNames.has(d.name));
      if (!hasNewDex) return;
      // Fall through to rebuild — don't clear metaLoaded here to avoid
      // concurrent fast-path callers seeing a stale false between detection
      // and the start of rebuild (metaLoaded is cleared inside rebuildMeta).
    }

    // Slow path: coalesce all concurrent rebuilders behind one promise.
    if (this.metaInFlight !== null) return this.metaInFlight;

    this.metaInFlight = this.rebuildMeta().finally(() => {
      this.metaInFlight = null;
    });
    return this.metaInFlight;
  }

  private async rebuildMeta(): Promise<void> {
    this.metaLoaded = false;

    // Native universe: failure is isolated — log warn and continue with empty native.
    let nativeUniverse: AssetMeta[] = [];
    try {
      const nativeData = await this.info("meta") as unknown as { universe: AssetMeta[] };
      nativeUniverse = nativeData.universe ?? [];
    } catch (err) {
      this.log.warn({ err }, "Native meta fetch failed — daemon starts degraded (HIP-3 may still load)");
    }

    // HIP-3 dexes — bounded concurrency to avoid burst overloading the IP weight cap.
    const dexes = await this.listPerpDexes().catch(() => []);
    const dexResults = await runWithConcurrency(
      dexes,
      4,
      (d) => this.info("meta", { dex: d.name }) as Promise<{ universe: AssetMeta[] }>,
    );

    let merged: AssetMeta[] = [...nativeUniverse];
    const nativeNames = nativeUniverse.map((a) => a.name);
    this.dexUniverses.set("", nativeNames);

    for (let i = 0; i < dexResults.length; i++) {
      const result = dexResults[i];
      if (result.status === "fulfilled") {
        const dexUniverse = result.value.universe ?? [];
        merged = merged.concat(dexUniverse);
        this.dexUniverses.set(dexes[i].name, dexUniverse.map((a) => a.name));
      } else {
        this.log.warn({ err: result.reason, dex: dexes[i].name }, "HIP-3 dex meta fetch failed — skipping");
      }
    }

    this.assets = merged.map((a) => a.isDelisted ? { symbol: a.name, isDelisted: true } : { symbol: a.name });
    merged.forEach((a, idx) => {
      // Store keys in resolveSymbol canonical form so HIP-3 lookups match.
      // resolveSymbol("xyz:AAPL") → "xyz:AAPL" (lowercase dex, uppercase asset)
      // resolveSymbol("BTC")      → "BTC" (uppercase native)
      const key = this.resolveSymbol(a.name);
      this.assetMap.set(key, idx);
      this.szDecimals.set(key, a.szDecimals ?? 0);
      if (typeof a.maxLeverage === "number" && a.maxLeverage > 0) {
        this.maxLeverage.set(key, a.maxLeverage);
      }
    });
    this.metaLoaded = true;
    this.log.info({ dexCount: dexes.length }, "meta rebuild complete");
  }

  /** Max leverage for a symbol (e.g. BTC → 40). Returns undefined when meta hasn't loaded the asset. */
  getMaxLeverage(symbol: string): number | undefined {
    return this.maxLeverage.get(this.resolveSymbol(symbol));
  }

  /** All asset names across native + HIP-3 dexes as loaded by ensureMeta. */
  getAllAssetNames(): string[] {
    return this.assets.map((a) => a.symbol);
  }

  /** Per-asset meta surface used by callers that need the delisted flag (e.g. token snapshot). */
  getAllAssets(): ReadonlyArray<TokenInfo> {
    return this.assets;
  }

  /** Whether a (resolved) symbol is present in the loaded universe. */
  isKnownSymbol(symbol: string): boolean {
    return this.assetMap.has(this.resolveSymbol(symbol));
  }

  /** Read-only view of per-dex ordered symbol lists. Key "" = native. */
  getDexUniverses(): ReadonlyMap<string, ReadonlyArray<string>> {
    return this.dexUniverses;
  }

  // ─── WS subscription API ───

  /**
   * Lazy-init the shared WS transport. Concurrent first-callers share one
   * init promise so only a single socket is opened regardless of how many
   * consumers call subscribe* simultaneously on cold start.
   */
  private async getSubscriptionClient(): Promise<SubscriptionClient> {
    if (this.wsSubClient !== null) return this.wsSubClient;
    if (this.wsLifecycle !== null) return this.wsLifecycle;

    this.wsLifecycle = (async () => {
      if (this.wsDisposed) throw new Error("trading client disposed");
      const transport = new WebSocketTransport({ isTestnet: this.testnet, reconnect: { WebSocket: BunCompatWebSocket } });
      const client = new SubscriptionClient({ transport });
      // Check disposal again after any async suspension in SDK constructors.
      if (this.wsDisposed) {
        await transport.close().catch(() => {});
        throw new Error("trading client disposed");
      }
      this.wsTransport = transport;
      this.wsSubClient = client;
      return client;
    })().finally(() => { this.wsLifecycle = null; });
    return this.wsLifecycle;
  }

  /**
   * Subscribe to asset contexts for native + every HIP-3 dex in a single
   * WS stream. The SDK multiplexes over one underlying socket per transport
   * instance — no per-dex connection overhead.
   */
  async subscribeAllDexsAssetCtxs(
    listener: (event: AllDexsAssetCtxsEvent) => void,
  ): Promise<ITradingSubscription> {
    const client = await this.getSubscriptionClient();
    // SDK event shape: { ctxs: [dex, ctx[]][] } — map to our interface type.
    const sub: ISubscription = await (client as unknown as {
      allDexsAssetCtxs(l: (e: { ctxs: [string, unknown[]][] }) => void): Promise<ISubscription>;
    }).allDexsAssetCtxs((e) => {
      listener({ ctxs: e.ctxs as AllDexsAssetCtxsEvent["ctxs"] });
    });
    return { unsubscribe: () => sub.unsubscribe() };
  }

  /** Shut down the WS transport. Called from disconnect() and on daemon stop. */
  async closeWs(): Promise<void> {
    this.wsDisposed = true;
    if (this.wsTransport !== null) {
      try { await this.wsTransport.close(); } catch { /* ignore — already closed */ }
    }
    this.wsTransport = null;
    this.wsSubClient = null;
    this.wsLifecycle = null;
  }

  /**
   * Resolve a user-provided symbol to its canonical HL form.
   *
   * For HIP-3 symbols like "XYZ:AAPL": the HL dex param is case-sensitive and
   * must be lowercase (verified: POST /info {"type":"meta","dex":"XYZ"} returns null).
   * So we lowercase only the dex prefix while uppercasing the rest of the symbol,
   * then strip common quote/suffix noise.
   *
   * For native symbols like "btc-usdt": standard uppercase + suffix strip.
   */
  resolveSymbol(symbol: string): string {
    const { dex, name } = parseDex(symbol);
    if (dex !== null) {
      // HIP-3 symbol: lowercase dex prefix, uppercase the part after ":"
      const afterColon = name.slice(dex.length + 1);
      return `${dex.toLowerCase()}:${afterColon.toUpperCase().replace(/[-_/]?(USDT|USDC|USD|PERP)$/i, "")}`;
    }
    const upper = symbol.toUpperCase().replace(/[-_/]?(USDT|USDC|USD|PERP)$/i, "");
    // HL k-prefix tokens (kPEPE, kBONK, ...) use a lowercase `k` by convention.
    // Plain .toUpperCase() mangles them — caller-supplied "kPEPE" round-trips
    // as "KPEPE" which doesn't match HL's actual asset name.
    return K_PREFIX_TOKENS.has(upper) ? "k" + upper.slice(1) : upper;
  }

  async getAssetIndex(symbol: string): Promise<number> {
    await this.ensureMeta();
    const resolved = this.resolveSymbol(symbol);
    const idx = this.assetMap.get(resolved);
    if (idx === undefined) throw new Error(`Unknown asset: ${symbol} (resolved: ${resolved})`);
    return idx;
  }

  // ─── Account data (multi-wallet: address param optional, defaults to primary) ───

  async getBalance(address?: string): Promise<Balance> {
    const user = address ?? this.defaultAddress;
    interface PerpState {
      marginSummary: { accountValue: string; totalMarginUsed: string };
      assetPositions?: Array<{ position: { szi: string; unrealizedPnl: string } }>;
    }
    interface SpotState {
      balances: Array<{ coin: string; total: string; hold?: string }>;
    }

    // No per-call catch on spot / abstraction RPCs: HL returns valid empty
    // payloads ({ balances: [] }, "default") for accounts without spot or
    // non-unified accounts, so a thrown error is genuinely transient (429,
    // network, 5xx). Silently swallowing it used to flip a unified account
    // to perp-only equity for that one fetch, producing the symptom
    // "portfolio value momentarily drops then snaps back". Let the error
    // propagate — every caller already wraps getBalance in try/catch (or
    // Promise.allSettled) and the FE has a guard that holds prior values
    // when a poll returns an error.
    const [perp, spot, abstraction] = await Promise.all([
      this.info("clearinghouseState", { user }) as Promise<PerpState>,
      this.info("spotClearinghouseState", { user }) as Promise<SpotState>,
      this.info("userAbstraction", { user }) as Promise<string>,
    ]);

    const ms = perp.marginSummary;
    const perpAccountValue = parseFloat(ms.accountValue);
    const perpMargin = parseFloat(ms.totalMarginUsed);

    const rawAbstraction = typeof abstraction === "string" ? abstraction : "default";
    const isUnified = rawAbstraction === "unifiedAccount" || rawAbstraction === "portfolioMargin";

    const spotBalances = spot.balances ?? [];
    const spotUsdc = spotBalances.find((b) => b.coin === "USDC");
    const spotUsdcHold = spotUsdc ? parseFloat(spotUsdc.hold ?? "0") : 0;

    let spotValue = 0;
    for (const b of spotBalances) {
      const total = parseFloat(b.total ?? "0");
      if (total <= 0) continue;
      if (b.coin === "USDC" || b.coin === "USDT") { spotValue += total; }
    }

    // Unified: perpAccountValue + spotValue - spotUsdcHold (avoid double-counting)
    // Non-unified: perpAccountValue only (spot is separate)
    const totalEquity = isUnified
      ? perpAccountValue + spotValue - spotUsdcHold
      : perpAccountValue;

    let unrealizedPnl = 0;
    for (const ap of perp.assetPositions ?? []) {
      const szi = parseFloat(ap.position?.szi ?? "0");
      if (szi !== 0) unrealizedPnl += parseFloat(ap.position.unrealizedPnl ?? "0");
    }

    return {
      totalEquity,
      availableBalance: Math.max(0, totalEquity - perpMargin),
      usedMargin: perpMargin,
      unrealizedPnl,
      spotBalance: spotValue,
    };
  }

  async getPositions(address?: string): Promise<Position[]> {
    const user = address ?? this.defaultAddress;
    const data = await this.info("clearinghouseState", { user }) as RawClearinghouse;
    return mapPositionsFromRaw(data);
  }

  async getOpenOrders(address?: string): Promise<OpenOrder[]> {
    const user = address ?? this.defaultAddress;
    const data = await this.info("frontendOpenOrders", { user }) as RawOpenOrder[];
    return data.map(mapOpenOrderFromRaw);
  }

  async getFills(address?: string, limit = 20): Promise<Fill[]> {
    const user = address ?? this.defaultAddress;
    const data = await this.info("userFills", { user }) as RawFill[];
    return data.slice(0, limit).map(mapFill);
  }

  async getFillsByTime(address: string | undefined, startTime: number, endTime?: number): Promise<Fill[]> {
    const user = address ?? this.defaultAddress;
    const params: Record<string, unknown> = { user, startTime };
    if (endTime !== undefined) params.endTime = endTime;
    const data = await this.info("userFillsByTime", params) as RawFill[];
    return data.map(mapFill);
  }

  /**
   * Fetch historical orders for a user. HL's `historicalOrders` info endpoint
   * does not accept a startTime parameter — we filter client-side. HL caps the
   * response at ~last 2000 orders, sufficient for the proactive scan window.
   */
  async getHistoricalOrders(address: string | undefined, startTime: number): Promise<OrderRecord[]> {
    const user = address ?? this.defaultAddress;
    const data = await this.info("historicalOrders", { user }) as any[];
    return data
      .map((raw) => mapOrderRecord(raw))
      .filter((o) => Number.isFinite(o.timestamp) && o.timestamp >= startTime);
  }

  // ─── Market data ───

  /**
   * Get a single ticker. For HIP-3 symbols (e.g. "xyz:AAPL"), queries the
   * dex-scoped metaAndAssetCtxs endpoint. For native symbols, uses no dex param.
   * Prefers the universe array shipped alongside ctxs in the response over the
   * stale dexUniverses snapshot to avoid stale index mismatches.
   */
  async getTicker(symbol: string): Promise<Ticker> {
    await this.ensureMeta();
    const resolved = this.resolveSymbol(symbol);
    const { dex } = parseDex(resolved);

    const extra = dex !== null ? { dex } : {};
    // Single-symbol path stays uncached so order-placement flows that call
    // getTicker() to read midPx see fresh data; the burst case is getAllTickers().
    const data = await this.info("metaAndAssetCtxs", extra) as unknown as any[];
    const ctxs: any[] = data[1] ?? [];

    // Prefer the universe from the current response; fall back to dexUniverses snapshot.
    const responseUniverse: AssetMeta[] = data[0]?.universe ?? [];
    const dexKey = dex ?? "";
    const dexNames: string[] = responseUniverse.length > 0
      ? responseUniverse.map((a) => a.name)
      : (this.dexUniverses.get(dexKey) ?? []);

    const localIdx = dexNames.indexOf(resolved);
    if (localIdx === -1) throw new Error(`Unknown asset: ${symbol}`);

    const ctx = ctxs[localIdx];
    if (!ctx) throw new Error(`No market data for ${resolved}`);

    return ctxToTicker(ctx, resolved);
  }

  /**
   * Get all tickers across native + every HIP-3 dex.
   * Prefers the universe array shipped alongside ctxs in each response
   * (r.value[0].universe) over the stale dexUniverses snapshot so that a
   * partially-failed ensureMeta doesn't produce UNKNOWN symbols.
   * Falls back to dexUniverses only if response universe is missing/empty.
   * Per-dex failures are skipped without UNKNOWN placeholder pollution.
   */
  async getAllTickers(): Promise<Ticker[]> {
    await this.ensureMeta();
    const tickers: Ticker[] = [];

    // Native (no dex param)
    const nativeData = await this.info("metaAndAssetCtxs", {}, { cache: true }) as unknown as any[];
    const nativeCtxs: any[] = nativeData[1] ?? [];
    const responseNativeUniverse: AssetMeta[] = nativeData[0]?.universe ?? [];
    const nativeNames: string[] = responseNativeUniverse.length > 0
      ? responseNativeUniverse.map((a) => a.name)
      : (this.dexUniverses.get("") ?? []);
    for (let i = 0; i < nativeCtxs.length; i++) {
      const name = nativeNames[i];
      if (!name) continue; // skip rather than emit UNKNOWN placeholder
      tickers.push(ctxToTicker(nativeCtxs[i], name));
    }

    // HIP-3 dexes — bounded concurrency to stay within the IP weight bucket.
    const dexes = await this.listPerpDexes().catch(() => []);
    const dexCtxResults = await runWithConcurrency(
      dexes,
      4,
      (d) => this.info("metaAndAssetCtxs", { dex: d.name }, { cache: true }) as Promise<any[]>,
    );

    for (let i = 0; i < dexCtxResults.length; i++) {
      const r = dexCtxResults[i];
      if (r.status !== "fulfilled") {
        this.log.warn({ err: r.reason, dex: dexes[i].name }, "HIP-3 ctxs fetch failed — skipping dex");
        continue;
      }
      const ctxs: any[] = r.value[1] ?? [];
      const responseUniverse: AssetMeta[] = r.value[0]?.universe ?? [];
      const names: string[] = responseUniverse.length > 0
        ? responseUniverse.map((a) => a.name)
        : (this.dexUniverses.get(dexes[i].name) ?? []);
      for (let j = 0; j < ctxs.length; j++) {
        const name = names[j];
        if (!name) continue; // skip rather than emit UNKNOWN placeholder
        tickers.push(ctxToTicker(ctxs[j], name));
      }
    }

    return tickers;
  }

  async getOrderbook(symbol: string, depth = 20): Promise<Orderbook> {
    const resolved = this.resolveSymbol(symbol);
    const data = await this.info("l2Book", { coin: resolved }) as any;
    const levels = data.levels ?? [[], []];

    return {
      symbol: resolved,
      bids: levels[0]?.slice(0, depth).map((l: any) => ({
        price: parseFloat(l.px),
        size: parseFloat(l.sz),
      })) ?? [],
      asks: levels[1]?.slice(0, depth).map((l: any) => ({
        price: parseFloat(l.px),
        size: parseFloat(l.sz),
      })) ?? [],
    };
  }

  async getKlines(symbol: string, interval: string, limit = 100): Promise<Kline[]> {
    const resolved = this.resolveSymbol(symbol);

    const intervalMs: Record<string, number> = {
      "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
      "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
    };
    const ms = intervalMs[interval] ?? 3_600_000;
    // Quantise endTime to 3s buckets so concurrent callers within the same
    // window share one InfoCache entry (3s TTL). Kline boundaries shift by
    // at most 3s which is acceptable for the TA and top-movers flows.
    const QUANTISE_MS = 3_000;
    const endTime = Math.floor(Date.now() / QUANTISE_MS) * QUANTISE_MS;
    const startTime = endTime - limit * ms;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Hyperliquid klines timeout (10s)")), 10_000);
      });
      const data = await Promise.race([
        this.info("candleSnapshot", { req: { coin: resolved, interval, startTime, endTime } }, { cache: true }) as Promise<any[]>,
        timeout,
      ]);

      return (data ?? []).slice(-limit).map((c: any) => ({
        openTime: c.t,
        open: parseFloat(c.o),
        high: parseFloat(c.h),
        low: parseFloat(c.l),
        close: parseFloat(c.c),
        volume: parseFloat(c.v),
      }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getFundingHistory(symbol: string, limit = 20): Promise<unknown[]> {
    const resolved = this.resolveSymbol(symbol);
    const data = await this.info("fundingHistory", {
      coin: resolved,
      startTime: Date.now() - 30 * 86_400_000,
      endTime: Date.now(),
    }) as any[];
    return (data ?? []).slice(-limit);
  }

  // ─── Write operations ───

  private roundSize(symbol: string, size: number): string {
    const resolved = this.resolveSymbol(symbol);
    const decimals = this.szDecimals.get(resolved) ?? 0;
    return size.toFixed(decimals);
  }

  /**
   * Format a price for HL submission. HL enforces TWO independent caps:
   *   - max 5 significant figures
   *   - max (MAX_DECIMALS - szDecimals) decimal places, where MAX_DECIMALS=6 for perps
   * The tighter of the two wins. Symbols with high szDecimals + sub-dollar
   * prices (e.g. APT @ ~$0.93, szDecimals=2 → max 4 decimals) used to silently
   * over-emit decimals through `toPrecision(5)` alone — HL responded "invalid price".
   */
  private formatPrice(symbol: string, price: number): string {
    const resolved = this.resolveSymbol(symbol);
    const szDecimals = this.szDecimals.get(resolved) ?? 0;
    const maxDecimals = Math.max(0, 6 - szDecimals);
    const trimmed = parseFloat(price.toPrecision(5));
    return parseFloat(trimmed.toFixed(maxDecimals)).toString();
  }

  private slippagePrice(symbol: string, midPrice: number, isBuy: boolean, slippagePct: number): string {
    const factor = isBuy ? (1 + slippagePct / 100) : (1 - slippagePct / 100);
    return this.formatPrice(symbol, midPrice * factor);
  }

  async placeOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
    const ex = this.requireExchange();
    await this.ensureMeta();

    const resolved = this.resolveSymbol(params.symbol);
    const assetIdx = this.assetMap.get(resolved);
    if (assetIdx === undefined) throw new Error(`Unknown asset: ${params.symbol}`);

    const isBuy = params.side === "buy";
    const size = this.roundSize(params.symbol, params.size);

    type Tif = "Gtc" | "Ioc" | "Alo" | "FrontendMarket";
    let orderType: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
    let price: string;

    switch (params.orderType) {
      case "market": {
        const ticker = await this.getTicker(params.symbol);
        price = this.slippagePrice(params.symbol, ticker.midPrice, isBuy, params.slippagePct ?? 0.5);
        orderType = { limit: { tif: "Ioc" } };
        break;
      }
      case "limit": {
        if (!params.price) throw new Error("Limit order requires price");
        price = this.formatPrice(params.symbol, params.price);
        orderType = { limit: { tif: params.tif ?? "Gtc" } };
        break;
      }
      case "stop_market": {
        if (!params.price) throw new Error("Stop market order requires trigger price");
        price = this.formatPrice(params.symbol, params.price);
        orderType = { trigger: { isMarket: true, triggerPx: price, tpsl: "sl" } };
        break;
      }
      case "stop_limit": {
        if (!params.price) throw new Error("Stop limit order requires trigger price");
        price = this.formatPrice(params.symbol, params.price);
        orderType = { trigger: { isMarket: false, triggerPx: price, tpsl: "sl" } };
        break;
      }
      case "take_profit": {
        if (!params.price) throw new Error("Take profit order requires trigger price");
        price = this.formatPrice(params.symbol, params.price);
        orderType = { trigger: { isMarket: true, triggerPx: price, tpsl: "tp" } };
        break;
      }
      case "take_profit_limit": {
        if (!params.price) throw new Error("Take profit limit order requires price");
        price = this.formatPrice(params.symbol, params.price);
        orderType = { trigger: { isMarket: false, triggerPx: price, tpsl: "tp" } };
        break;
      }
      default:
        throw new Error(`Unsupported order type: ${params.orderType}`);
    }

    // Capture cloid before submission so it can be returned in the result.
    // Downstream consumers (proactive scan via ghost_get_recent_orders) use
    // the returned cloid to attribute Ghost-placed vs external orders.
    const cloid = generateGhostCloid();
    const res = await ex.order({
      orders: [{ a: assetIdx, b: isBuy, p: price!, s: size, r: params.reduceOnly ?? false, t: orderType!, c: cloid }],
      grouping: "na",
    });

    const status = res.response.data.statuses[0];
    if (!status || typeof status === "string") {
      return { symbol: resolved, side: params.side, orderType: params.orderType, status: (status ?? "unknown") as PlaceOrderResult["status"], cloid };
    }
    if ("error" in status) throw new Error(String((status as { error: unknown }).error));
    if ("filled" in status) {
      return {
        symbol: resolved, side: params.side, orderType: params.orderType, status: "filled",
        orderId: String(status.filled.oid), filledSize: status.filled.totalSz, avgFillPrice: status.filled.avgPx,
        cloid,
      };
    }
    if ("resting" in status) {
      return {
        symbol: resolved, side: params.side, orderType: params.orderType, status: "resting",
        orderId: String(status.resting.oid), price, size,
        cloid,
      };
    }
    return { symbol: resolved, side: params.side, orderType: params.orderType, status: "waitingForTrigger", price, size, cloid };
  }

  async cancelOrder(symbol: string, orderId: string): Promise<CancelOrderResult> {
    const ex = this.requireExchange();
    const assetIdx = await this.getAssetIndex(symbol);
    await ex.cancel({ cancels: [{ a: assetIdx, o: parseInt(orderId) }] });
    return { symbol: this.resolveSymbol(symbol), orderId, status: "cancelled" };
  }

  async cancelAllOrders(symbol?: string): Promise<CancelOrderResult[]> {
    let orders = await this.getOpenOrders();
    if (symbol) {
      const resolved = this.resolveSymbol(symbol);
      // Use resolveSymbol on both sides so HIP-3 "xyz:AAPL" matches correctly.
      orders = orders.filter((o) => this.resolveSymbol(o.symbol) === resolved);
    }
    if (orders.length === 0) return [];
    const results: CancelOrderResult[] = [];
    for (const o of orders) {
      results.push(await this.cancelOrder(o.symbol, o.orderId));
    }
    return results;
  }

  async setLeverage(symbol: string, leverage: number, isCross = true): Promise<LeverageResult> {
    const ex = this.requireExchange();
    const assetIdx = await this.getAssetIndex(symbol);
    await ex.updateLeverage({ asset: assetIdx, isCross, leverage });
    return { symbol: this.resolveSymbol(symbol), leverage, marginMode: isCross ? "cross" : "isolated" };
  }

  async closePosition(symbol: string, slippagePct = 0.5): Promise<PlaceOrderResult> {
    const positions = await this.getPositions();
    const resolved = this.resolveSymbol(symbol);
    // Use resolveSymbol on both sides so HIP-3 "xyz:AAPL" matches correctly.
    const pos = positions.find((p) => this.resolveSymbol(p.symbol) === resolved);
    if (!pos) throw new Error(`No open position for ${resolved}`);

    return this.placeOrder({
      symbol, side: pos.side === "long" ? "sell" : "buy",
      size: pos.size, orderType: "market", reduceOnly: true, slippagePct,
    });
  }

  async partialClose(symbol: string, percentage: number, slippagePct = 0.5): Promise<PlaceOrderResult> {
    const positions = await this.getPositions();
    const resolved = this.resolveSymbol(symbol);
    // Use resolveSymbol on both sides so HIP-3 "xyz:AAPL" matches correctly.
    const pos = positions.find((p) => this.resolveSymbol(p.symbol) === resolved);
    if (!pos) throw new Error(`No open position for ${resolved}`);

    const closeSize = pos.size * (percentage / 100);
    return this.placeOrder({
      symbol, side: pos.side === "long" ? "sell" : "buy",
      size: closeSize, orderType: "market", reduceOnly: true, slippagePct,
    });
  }

  async adjustMargin(symbol: string, amount: number): Promise<{ symbol: string; amount: number }> {
    const ex = this.requireExchange();
    const assetIdx = await this.getAssetIndex(symbol);
    const positions = await this.getPositions();
    const resolved = this.resolveSymbol(symbol);
    // Use resolveSymbol on both sides so HIP-3 "xyz:AAPL" matches correctly.
    const pos = positions.find((p) => this.resolveSymbol(p.symbol) === resolved);
    if (!pos) throw new Error(`No open position for ${resolved}`);

    // ntli is in raw USD (multiplied by 1e6 internally by SDK)
    // isBuy = true means adding margin to long side
    await ex.updateIsolatedMargin({
      asset: assetIdx,
      isBuy: pos.side === "long",
      ntli: Math.round(amount * 1e6),
    });
    return { symbol: resolved, amount };
  }
}
