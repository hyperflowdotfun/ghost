// Split a canonical symbol into its dex prefix (HIP-3) and base name.
// "xyz:WTIOIL" → { dex: "xyz", base: "WTIOIL" }
// "BTC"        → { dex: null,  base: "BTC" }
export function splitSymbol(sym: string): { dex: string | null; base: string } {
  const colon = sym.indexOf(':');
  if (colon === -1) return { dex: null, base: sym };
  return { dex: sym.slice(0, colon), base: sym.slice(colon + 1) };
}

export type PriceSourceId = "hyperliquid" | "binance";

/**
 * Format a (symbol, source) pair into a row display:
 *   - `chip`: small HIP-3 dex tag (e.g. "XYZ") when present, else null.
 *   - `notation`: pair label "BTCUSDC" / "BTCUSDT" / "WTIOIL".
 *
 * Binance entries render the source-native symbol as-is and carry no chip.
 * Hyperliquid native rows get a USDC suffix; HIP-3 rows split into chip + base.
 * The Perp/Spot contract type is conveyed by a separate chip in the row, so
 * the legacy ".P" suffix is omitted here.
 */
export function formatSymbolDisplay(
  symbol: string,
  source: PriceSourceId,
): { chip: string | null; notation: string } {
  // `.P` suffix dropped — the Perp chip next to the notation already
  // signals contract type, so the duplicate marker just adds visual noise.
  if (source === "binance") {
    return { chip: null, notation: symbol };
  }
  const colon = symbol.indexOf(":");
  if (colon === -1) return { chip: null, notation: `${symbol}USDC` };
  // Title-case the dex prefix ("hyna" → "Hyna") so the chip reads as a
  // name rather than shouting at the user.
  const raw = symbol.slice(0, colon);
  return {
    chip: raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase(),
    notation: symbol.slice(colon + 1),
  };
}

export type MarketType = "Perp" | "Spot";

const SOURCE_LABELS: Record<PriceSourceId, string> = {
  hyperliquid: "Hyperliquid",
  binance: "Binance",
};

export function sourceLabel(source: PriceSourceId): string {
  return SOURCE_LABELS[source];
}
