/**
 * Binance → Hyperliquid symbol bridge.
 *
 * Hyperliquid's perp universe uses unit-normalized symbols: `kPEPE` represents
 * a perp whose underlying is 1000 PEPE, so the USD price of kPEPE equals
 * 1000 × USD price of PEPE on Binance.
 *
 * `mapBinanceSymbol(sym)` returns the HL-canonical name and price multiplier
 * for `sym`, or `null` when HL doesn't list an equivalent perp. Pure
 * translation — callers drop the tick when this returns null.
 */

export interface SymbolMapping {
  /** HL-canonical symbol (what downstream consumers subscribe to). */
  hlSymbol: string;
  /** Multiplier applied to the Binance price to produce the HL-equivalent price. */
  multiplier: number;
}

/**
 * Binance perp symbol → HL equivalent. Maintained by hand against the HL
 * universe snapshot. Unmapped symbols are dropped silently; add entries
 * below when HL lists a new perp that also trades on Binance.
 *
 * Refreshing the table
 * --------------------
 *   1. Fetch the live HL universe:
 *        curl -s -XPOST https://api.hyperliquid.xyz/info \
 *          -H 'content-type: application/json' -d '{"type":"meta"}' \
 *          | jq -r '.universe[] | select(.isDelisted != true) | .name'
 *   2. Fetch Binance USDⓈ-M perp symbols (matches the price feed source):
 *        curl -s 'https://fapi.binance.com/fapi/v1/exchangeInfo' \
 *          | jq -r '.symbols[] | select(.contractType=="PERPETUAL" and .quoteAsset=="USDT" and .status=="TRADING") | .symbol'
 *   3. For each HL symbol, decide the mapping:
 *        - k-prefixed (kPEPE, kSHIB, …): Binance base has no `k`, so the
 *          Binance symbol is `PEPEUSDT` / `SHIBUSDT` / `LUNCUSDT`. Use
 *          multiplier 1000 (HL `kX` = 1000 × X base units).
 *        - 1000-prefixed (older HL naming, rarely used): same 1000× semantics.
 *        - Plain symbol (BTC, ETH, …): Binance symbol is `<SYM>USDT`,
 *          multiplier 1.
 *   4. Verify each new mapping against `tests/services/price-feed/symbol-mapping.test.ts`
 *      — the drift-detector test will fail if an HL symbol lands in the
 *      universe snapshot without a corresponding mapping (or allow-list entry).
 *
 * Convention
 * ----------
 *   - Direct pairs (HL symbol == Binance base):              multiplier 1
 *   - k-prefix pairs (HL `kX` = 1000× X base units):         multiplier 1000
 *   - 1000-prefix pairs (HL `1000X` = same 1000× as kX):     multiplier 1000
 *
 * References
 * ----------
 *   - HL docs: https://hyperliquid.gitbook.io/hyperliquid-docs/trading/perpetuals
 *   - HL info endpoint: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */
export const BINANCE_TO_HL: Record<string, SymbolMapping> = {
  // --- Majors: HL uses native symbol, Binance appends USDT ---
  BTCUSDT: { hlSymbol: "BTC", multiplier: 1 },
  ETHUSDT: { hlSymbol: "ETH", multiplier: 1 },
  SOLUSDT: { hlSymbol: "SOL", multiplier: 1 },
  XRPUSDT: { hlSymbol: "XRP", multiplier: 1 },
  DOGEUSDT: { hlSymbol: "DOGE", multiplier: 1 },
  AVAXUSDT: { hlSymbol: "AVAX", multiplier: 1 },
  LINKUSDT: { hlSymbol: "LINK", multiplier: 1 },
  ADAUSDT: { hlSymbol: "ADA", multiplier: 1 },
  BNBUSDT: { hlSymbol: "BNB", multiplier: 1 },
  SUIUSDT: { hlSymbol: "SUI", multiplier: 1 },
  APTUSDT: { hlSymbol: "APT", multiplier: 1 },
  ARBUSDT: { hlSymbol: "ARB", multiplier: 1 },
  OPUSDT: { hlSymbol: "OP", multiplier: 1 },
  LTCUSDT: { hlSymbol: "LTC", multiplier: 1 },
  BCHUSDT: { hlSymbol: "BCH", multiplier: 1 },
  ATOMUSDT: { hlSymbol: "ATOM", multiplier: 1 },
  NEARUSDT: { hlSymbol: "NEAR", multiplier: 1 },
  FILUSDT: { hlSymbol: "FIL", multiplier: 1 },
  DOTUSDT: { hlSymbol: "DOT", multiplier: 1 },
  TIAUSDT: { hlSymbol: "TIA", multiplier: 1 },
  INJUSDT: { hlSymbol: "INJ", multiplier: 1 },
  SEIUSDT: { hlSymbol: "SEI", multiplier: 1 },
  RENDERUSDT: { hlSymbol: "RENDER", multiplier: 1 },
  AAVEUSDT: { hlSymbol: "AAVE", multiplier: 1 },
  UNIUSDT: { hlSymbol: "UNI", multiplier: 1 },
  LDOUSDT: { hlSymbol: "LDO", multiplier: 1 },
  CRVUSDT: { hlSymbol: "CRV", multiplier: 1 },
  WLDUSDT: { hlSymbol: "WLD", multiplier: 1 },
  JUPUSDT: { hlSymbol: "JUP", multiplier: 1 },
  PYTHUSDT: { hlSymbol: "PYTH", multiplier: 1 },
  ENAUSDT: { hlSymbol: "ENA", multiplier: 1 },
  ONDOUSDT: { hlSymbol: "ONDO", multiplier: 1 },
  STRKUSDT: { hlSymbol: "STRK", multiplier: 1 },
  WUSDT: { hlSymbol: "W", multiplier: 1 },
  POPCATUSDT: { hlSymbol: "POPCAT", multiplier: 1 },
  WIFUSDT: { hlSymbol: "WIF", multiplier: 1 },
  TRUMPUSDT: { hlSymbol: "TRUMP", multiplier: 1 },
  HYPEUSDT: { hlSymbol: "HYPE", multiplier: 1 },
  FARTCOINUSDT: { hlSymbol: "FARTCOIN", multiplier: 1 },
  PENGUUSDT: { hlSymbol: "PENGU", multiplier: 1 },
  MOODENGUSDT: { hlSymbol: "MOODENG", multiplier: 1 },
  GOATUSDT: { hlSymbol: "GOAT", multiplier: 1 },
  PNUTUSDT: { hlSymbol: "PNUT", multiplier: 1 },
  MEUSDT: { hlSymbol: "ME", multiplier: 1 },
  VIRTUALUSDT: { hlSymbol: "VIRTUAL", multiplier: 1 },
  SPXUSDT: { hlSymbol: "SPX", multiplier: 1 },
  AIXBTUSDT: { hlSymbol: "AIXBT", multiplier: 1 },
  ZEREBROUSDT: { hlSymbol: "ZEREBRO", multiplier: 1 },
  GRIFFAINUSDT: { hlSymbol: "GRIFFAIN", multiplier: 1 },
  SUSDT: { hlSymbol: "S", multiplier: 1 },

  // --- Expanded coverage: popular HL perps that also trade on Binance ---
  TONUSDT: { hlSymbol: "TON", multiplier: 1 },
  ORDIUSDT: { hlSymbol: "ORDI", multiplier: 1 },
  TAOUSDT: { hlSymbol: "TAO", multiplier: 1 },
  PENDLEUSDT: { hlSymbol: "PENDLE", multiplier: 1 },
  EIGENUSDT: { hlSymbol: "EIGEN", multiplier: 1 },
  ENSUSDT: { hlSymbol: "ENS", multiplier: 1 },
  FETUSDT: { hlSymbol: "FET", multiplier: 1 },
  GALAUSDT: { hlSymbol: "GALA", multiplier: 1 },
  SANDUSDT: { hlSymbol: "SAND", multiplier: 1 },
  AXSUSDT: { hlSymbol: "AXS", multiplier: 1 },
  MANTAUSDT: { hlSymbol: "MANTA", multiplier: 1 },
  ALTUSDT: { hlSymbol: "ALT", multiplier: 1 },
  XLMUSDT: { hlSymbol: "XLM", multiplier: 1 },
  ZECUSDT: { hlSymbol: "ZEC", multiplier: 1 },
  DASHUSDT: { hlSymbol: "DASH", multiplier: 1 },
  NEOUSDT: { hlSymbol: "NEO", multiplier: 1 },
  ETCUSDT: { hlSymbol: "ETC", multiplier: 1 },
  ALGOUSDT: { hlSymbol: "ALGO", multiplier: 1 },
  HBARUSDT: { hlSymbol: "HBAR", multiplier: 1 },
  ICPUSDT: { hlSymbol: "ICP", multiplier: 1 },
  MINAUSDT: { hlSymbol: "MINA", multiplier: 1 },
  APEUSDT: { hlSymbol: "APE", multiplier: 1 },
  CAKEUSDT: { hlSymbol: "CAKE", multiplier: 1 },
  SUSHIUSDT: { hlSymbol: "SUSHI", multiplier: 1 },
  CELOUSDT: { hlSymbol: "CELO", multiplier: 1 },
  PAXGUSDT: { hlSymbol: "PAXG", multiplier: 1 },
  DYDXUSDT: { hlSymbol: "DYDX", multiplier: 1 },
  TURBOUSDT: { hlSymbol: "TURBO", multiplier: 1 },
  BOMEUSDT: { hlSymbol: "BOME", multiplier: 1 },
  TRBUSDT: { hlSymbol: "TRB", multiplier: 1 },
  BERAUSDT: { hlSymbol: "BERA", multiplier: 1 },
  MORPHOUSDT: { hlSymbol: "MORPHO", multiplier: 1 },
  ZROUSDT: { hlSymbol: "ZRO", multiplier: 1 },
  ETHFIUSDT: { hlSymbol: "ETHFI", multiplier: 1 },
  POLUSDT: { hlSymbol: "POL", multiplier: 1 },
  JTOUSDT: { hlSymbol: "JTO", multiplier: 1 },
  BSVUSDT: { hlSymbol: "BSV", multiplier: 1 },
  TRXUSDT: { hlSymbol: "TRX", multiplier: 1 },
  IMXUSDT: { hlSymbol: "IMX", multiplier: 1 },
  STXUSDT: { hlSymbol: "STX", multiplier: 1 },
  COMPUSDT: { hlSymbol: "COMP", multiplier: 1 },
  SNXUSDT: { hlSymbol: "SNX", multiplier: 1 },
  RUNEUSDT: { hlSymbol: "RUNE", multiplier: 1 },
  ARUSDT: { hlSymbol: "AR", multiplier: 1 },
  IOTAUSDT: { hlSymbol: "IOTA", multiplier: 1 },
  GMTUSDT: { hlSymbol: "GMT", multiplier: 1 },
  GMXUSDT: { hlSymbol: "GMX", multiplier: 1 },
  BLURUSDT: { hlSymbol: "BLUR", multiplier: 1 },
  MOVEUSDT: { hlSymbol: "MOVE", multiplier: 1 },
  UMAUSDT: { hlSymbol: "UMA", multiplier: 1 },
  RSRUSDT: { hlSymbol: "RSR", multiplier: 1 },
  SAGAUSDT: { hlSymbol: "SAGA", multiplier: 1 },
  SUPERUSDT: { hlSymbol: "SUPER", multiplier: 1 },
  NOTUSDT: { hlSymbol: "NOT", multiplier: 1 },
  HMSTRUSDT: { hlSymbol: "HMSTR", multiplier: 1 },
  PEOPLEUSDT: { hlSymbol: "PEOPLE", multiplier: 1 },
  BANANAUSDT: { hlSymbol: "BANANA", multiplier: 1 },
  ANIMEUSDT: { hlSymbol: "ANIME", multiplier: 1 },
  PUMPUSDT: { hlSymbol: "PUMP", multiplier: 1 },
  ACEUSDT: { hlSymbol: "ACE", multiplier: 1 },
  DYMUSDT: { hlSymbol: "DYM", multiplier: 1 },
  BIGTIMEUSDT: { hlSymbol: "BIGTIME", multiplier: 1 },
  BIOUSDT: { hlSymbol: "BIO", multiplier: 1 },
  IOUSDT: { hlSymbol: "IO", multiplier: 1 },
  MAVUSDT: { hlSymbol: "MAV", multiplier: 1 },
  MEMEUSDT: { hlSymbol: "MEME", multiplier: 1 },
  ARKUSDT: { hlSymbol: "ARK", multiplier: 1 },
  XAIUSDT: { hlSymbol: "XAI", multiplier: 1 },
  CFXUSDT: { hlSymbol: "CFX", multiplier: 1 },
  USTCUSDT: { hlSymbol: "USTC", multiplier: 1 },
  ZKUSDT: { hlSymbol: "ZK", multiplier: 1 },
  ZENUSDT: { hlSymbol: "ZEN", multiplier: 1 },
  SKYUSDT: { hlSymbol: "SKY", multiplier: 1 },
  POLYXUSDT: { hlSymbol: "POLYX", multiplier: 1 },
  TNSRUSDT: { hlSymbol: "TNSR", multiplier: 1 },
  YGGUSDT: { hlSymbol: "YGG", multiplier: 1 },
  NILUSDT: { hlSymbol: "NIL", multiplier: 1 },
  LAYERUSDT: { hlSymbol: "LAYER", multiplier: 1 },
  USUALUSDT: { hlSymbol: "USUAL", multiplier: 1 },
  SYRUPUSDT: { hlSymbol: "SYRUP", multiplier: 1 },
  KAITOUSDT: { hlSymbol: "KAITO", multiplier: 1 },
  MEWUSDT: { hlSymbol: "MEW", multiplier: 1 },
  XMRUSDT: { hlSymbol: "XMR", multiplier: 1 },
  AVNTUSDT: { hlSymbol: "AVNT", multiplier: 1 },
  ASTERUSDT: { hlSymbol: "ASTER", multiplier: 1 },
  AZTECUSDT: { hlSymbol: "AZTEC", multiplier: 1 },
  BABYUSDT: { hlSymbol: "BABY", multiplier: 1 },
  CHIPUSDT: { hlSymbol: "CHIP", multiplier: 1 },
  FOGOUSDT: { hlSymbol: "FOGO", multiplier: 1 },
  FTTUSDT: { hlSymbol: "FTT", multiplier: 1 },
  GASUSDT: { hlSymbol: "GAS", multiplier: 1 },
  HEMIUSDT: { hlSymbol: "HEMI", multiplier: 1 },
  HYPERUSDT: { hlSymbol: "HYPER", multiplier: 1 },
  INITUSDT: { hlSymbol: "INIT", multiplier: 1 },
  LINEAUSDT: { hlSymbol: "LINEA", multiplier: 1 },
  METUSDT: { hlSymbol: "MET", multiplier: 1 },
  NXPCUSDT: { hlSymbol: "NXPC", multiplier: 1 },
  PROVEUSDT: { hlSymbol: "PROVE", multiplier: 1 },
  RESOLVUSDT: { hlSymbol: "RESOLV", multiplier: 1 },
  REZUSDT: { hlSymbol: "REZ", multiplier: 1 },
  SCRUSDT: { hlSymbol: "SCR", multiplier: 1 },
  SOPHUSDT: { hlSymbol: "SOPH", multiplier: 1 },
  TSTUSDT: { hlSymbol: "TST", multiplier: 1 },
  WCTUSDT: { hlSymbol: "WCT", multiplier: 1 },
  WLFIUSDT: { hlSymbol: "WLFI", multiplier: 1 },
  XPLUSDT: { hlSymbol: "XPL", multiplier: 1 },
  "0GUSDT": { hlSymbol: "0G", multiplier: 1 },
  "2ZUSDT": { hlSymbol: "2Z", multiplier: 1 },

  // --- k-prefix: HL `kX` = 1000× Binance X base units ---
  PEPEUSDT: { hlSymbol: "kPEPE", multiplier: 1000 },
  BONKUSDT: { hlSymbol: "kBONK", multiplier: 1000 },
  SHIBUSDT: { hlSymbol: "kSHIB", multiplier: 1000 },
  FLOKIUSDT: { hlSymbol: "kFLOKI", multiplier: 1000 },
  NEIROUSDT: { hlSymbol: "kNEIRO", multiplier: 1000 },
  LUNCUSDT: { hlSymbol: "kLUNC", multiplier: 1000 },
};

/**
 * Translate a Binance symbol to HL-canonical name + price multiplier.
 * Returns `null` when HL doesn't list an equivalent perp — callers drop
 * the tick. Case-sensitive by design: Binance emits upper-case symbols
 * in its streams, so tolerating case would mask upstream bugs.
 */
export function mapBinanceSymbol(binanceSymbol: string): SymbolMapping | null {
  return BINANCE_TO_HL[binanceSymbol] ?? null;
}
