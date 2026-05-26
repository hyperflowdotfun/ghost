import { useState, useEffect } from "react";
import type { ChartDataResponse } from "@/lib/chartTypes";
import type { PriceSourceId } from "@/components/layout/symbol-utils";

interface UseChartDataResult {
  data: ChartDataResponse | null;
  loading: boolean;
  error: string | null;
}

/** In-memory cache so remounts (e.g. streaming → static mode switch) get instant data. */
const cache = new Map<string, ChartDataResponse>();

function cacheKey(
  symbol: string,
  source: PriceSourceId | undefined,
  interval: string | undefined,
  indicators: string | undefined,
): string {
  return `${source ?? "hyperliquid"}|${symbol}|${interval ?? "4h"}|${indicators ?? ""}`;
}

export function useChartData(
  symbol: string,
  interval: string | undefined,
  indicators: string | undefined,
  source?: PriceSourceId,
): UseChartDataResult {
  const key = cacheKey(symbol, source, interval, indicators);
  const cached = cache.get(key) ?? null;

  const [data, setData] = useState<ChartDataResponse | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // No-op when symbol is empty (e.g. drawer is closed but the hook still
    // runs to preserve hook order). Without this the gateway returns 400.
    if (!symbol) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    // Skip fetch if already cached
    if (cache.has(key)) {
      setData(cache.get(key)!);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchData(): Promise<void> {
      setLoading(true);
      setError(null);

      const params = new URLSearchParams({ symbol });
      if (interval) params.set("interval", interval);
      if (indicators) params.set("indicators", indicators);
      if (source) params.set("source", source);

      try {
        const res = await fetch(`/api/chart-data?${params.toString()}`);
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          const msg =
            body && typeof body === "object" && "error" in body
              ? String((body as { error: unknown }).error)
              : `HTTP ${res.status}`;
          throw new Error(msg);
        }
        const json = (await res.json()) as ChartDataResponse;
        if (!cancelled) {
          cache.set(key, json);
          setData(json);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load chart data");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void fetchData();

    return () => {
      cancelled = true;
    };
  }, [symbol, interval, indicators, source, key]);

  return { data, loading, error };
}
