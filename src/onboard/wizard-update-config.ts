import type { Config, TradingMode } from "../config/schema.js";

export interface UpdateModeOverlay {
  provider: string;
  model: string;
  mode?: TradingMode;
  paperBalance?: number;
}

export function applyUpdateModeChanges(
  existing: Config,
  overlay: UpdateModeOverlay,
): Config {
  const next: Config = {
    ...existing,
    provider: overlay.provider,
    model: overlay.model,
  };
  if (overlay.mode) {
    next.mode = overlay.mode;
    if (overlay.mode === "paper" && overlay.paperBalance !== undefined) {
      next.paper = { ...existing.paper, initialBalance: overlay.paperBalance };
    }
  }
  return next;
}
