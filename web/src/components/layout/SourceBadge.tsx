import type { PriceSourceId } from "./symbol-utils";
import hyperliquidLogoSvg from "@/assets/hype.svg";
import binanceLogoSvg from "@/assets/binance.svg";

const SOURCE_LOGO: Record<PriceSourceId, string> = {
  hyperliquid: hyperliquidLogoSvg,
  binance: binanceLogoSvg,
};

interface SourceBadgeProps {
  source: PriceSourceId;
  size?: number;
  className?: string;
}

/**
 * Tiny per-row icon distinguishing Hyperliquid USDC perp rows from Binance
 * USDⓈ-M perp rows. Uses the same SVG assets as the watchlist add drawer so
 * the venue marker stays visually consistent across the app.
 */
export function SourceBadge({ source, size = 14, className = "" }: SourceBadgeProps) {
  const isHL = source === "hyperliquid";
  const label = isHL ? "Hyperliquid USDC perp" : "Binance USDⓈ-M perp";

  return (
    <img
      src={SOURCE_LOGO[source]}
      alt=""
      role="img"
      aria-label={label}
      title={label}
      width={size}
      height={size}
      draggable={false}
      className={`block shrink-0 select-none ${className}`}
    />
  );
}
