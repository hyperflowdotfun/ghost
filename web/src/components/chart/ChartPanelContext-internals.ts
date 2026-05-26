import { createContext, useContext } from "react";
import type { FocusSpec } from "./ChartWidget-helpers";
import type { PriceSourceId } from "../layout/symbol-utils";

export type { FocusSpec };

export interface ChartPanelRequest {
  symbol: string;
  /** Price source that surfaced this symbol. Defaults to "hyperliquid" when omitted
   *  so legacy callers (clicking a HL row, chart deep-link, etc.) keep working. */
  source?: PriceSourceId;
  interval?: string;
  focus?: FocusSpec;
}

export interface ChartPanelStore {
  request: ChartPanelRequest | null;
  open: (request: ChartPanelRequest) => void;
  close: () => void;
}

export const ChartPanelCtx = createContext<ChartPanelStore | null>(null);

export function useChartPanel(): ChartPanelStore | null {
  return useContext(ChartPanelCtx);
}
