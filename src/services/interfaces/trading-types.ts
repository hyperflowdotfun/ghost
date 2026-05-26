/**
 * Shared data models for Ghost trading extension.
 */

/**
 * Per-asset metadata exposed by the trading client. `isDelisted` is sparse —
 * present only on entries HL has flagged removed. Source-tagging for the
 * multi-source watchlist payload lives at the snapshot layer (see
 * `tokens-snapshot.ts SnapshotTokenInfo`), not here — trading-internal types
 * stay HL-centric.
 */
export interface TokenInfo {
  symbol: string;
  isDelisted?: boolean;
}

export interface Balance {
  totalEquity: number;
  availableBalance: number;
  usedMargin: number;
  unrealizedPnl: number;
  spotBalance?: number;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  size: number;
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number | null;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  leverage: number;
  marginMode: "isolated" | "cross";
  margin: number;
}

export interface OpenOrder {
  orderId: string;
  symbol: string;
  side: "buy" | "sell";
  orderType: string;
  price: number | null;
  triggerPrice: number | null;
  size: number;
  filled: number;
  reduceOnly: boolean;
  timestamp: number;
}

export interface Fill {
  tradeId: string;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee: number;
  feeToken: string;
  realizedPnl: number;
  timestamp: number;
  /** Human-readable HL direction string. Examples: "Open Long", "Close Short",
   *  "Liquidated Isolated Long", "Buy", "Sell". Used by the observer loop to
   *  classify fills (TP / SL / liquidation / entry). Optional because paper
   *  trading does not synthesize this string. */
  dir?: string;
  /** True when HL marks this fill as a liquidation event. Set when the raw
   *  fill carries a `liquidation` object. Observer-only field. */
  liquidation?: boolean;
}

export interface Ticker {
  symbol: string;
  markPrice: number;
  midPrice: number;
  oraclePrice: number;
  volume24h: number;
  prevDayPrice: number;
  priceChangePct24h: number;
  openInterest: number;
  fundingRate: number;
}

export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderbookLevel {
  price: number;
  size: number;
}

export interface Orderbook {
  symbol: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
}

// ─── Write operation types ───

export interface PlaceOrderParams {
  symbol: string;
  side: "buy" | "sell";
  size: number;
  price?: number;
  orderType: "market" | "limit" | "stop_market" | "stop_limit" | "take_profit" | "take_profit_limit";
  reduceOnly?: boolean;
  slippagePct?: number;
  tif?: "Gtc" | "Ioc" | "Alo";
}

export interface PlaceOrderResult {
  symbol: string;
  side: "buy" | "sell";
  orderType: string;
  status: "filled" | "resting" | "waitingForTrigger";
  orderId?: string;
  filledSize?: string;
  avgFillPrice?: string;
  price?: string;
  size?: string;
  /** Ghost cloid stamped on this order for origin tracking (proactive external-trade-review topic). */
  cloid?: string;
}

export interface CancelOrderResult {
  symbol: string;
  orderId: string;
  status: "cancelled";
}

export interface LeverageResult {
  symbol: string;
  leverage: number;
  marginMode: "cross" | "isolated";
}

/**
 * Historical order record returned by HL `historicalOrders` info endpoint.
 * Preserves cloid (for Ghost-vs-external attribution) and trigger fields
 * (for kind classification: position vs protection).
 */
export interface OrderRecord {
  oid: string;
  /** Client order id. `null` when no cloid was attached at placement time.
   *  Ghost-placed orders carry the prefix `0x67686f7374...` (see helpers/cloid.ts). */
  cloid: string | null;
  symbol: string;
  side: "buy" | "sell";
  price: number;
  triggerPrice: number | null;
  size: number;
  reduceOnly: boolean;
  /** HL order status. */
  status: "open" | "filled" | "canceled" | "liquidatedCanceled" | "triggered" | "marginCanceled" | "scheduledCancel" | "selfTradeCanceled";
  /** Order placement timestamp (ms). */
  timestamp: number;
}
