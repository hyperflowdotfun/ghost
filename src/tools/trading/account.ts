/**
 * Account tools: connect wallet, balance, positions, orders, multi-wallet management
 * Wallet stored in SQLite (brain.db) via WalletStore (encrypted)
 */

import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { defineTool } from "./types.js";
import type { ITradingClient } from "../../services/interfaces/trading-client.js";
import type { IWalletStore } from "../../services/interfaces/wallet-store.js";
import { textResult, errorResult, getErrorMessage } from "../../helpers/result.js";
import { formatPositions, formatBalance, formatOrder } from "../../helpers/formatters.js";
import { resolveReadAddress } from "./ensure-connected.js";

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Classify an open order into a coarse kind the agent can target.
 * Handles both Hyperliquid live strings ("Stop Market", "Take Profit Market")
 * and paper engine strings ("stop_market", "take_profit") via startsWith
 * after normalizing whitespace/underscores.
 */
export function classifyOrderKind(o: { orderType: string; reduceOnly: boolean }): "sl" | "tp" | "entry_limit" | "pending_limit" {
  const t = o.orderType.toLowerCase().replace(/[\s_]+/g, "_");
  if (o.reduceOnly && t.startsWith("stop")) return "sl";
  if (o.reduceOnly && t.startsWith("take_profit")) return "tp";
  if (t === "limit" && !o.reduceOnly) return "entry_limit";
  return "pending_limit";
}

export interface AccountToolDeps {
  hl: ITradingClient;
  walletStore: IWalletStore;
  testnet: boolean;
  saveWalletConfig?: (address: string, privateKey: string) => Promise<void>;
  disconnectWallet?: () => Promise<{ address: string } | null>;
}

export function createAccountTools(deps: AccountToolDeps): AgentTool[] {
  const { hl, walletStore, testnet, saveWalletConfig, disconnectWallet } = deps;
  return [
    defineTool({
      name: "ghost_connect_wallet",
      label: "Connect Wallet",
      description:
        "Connect a Hyperliquid wallet for trading. Requires address and API wallet private key. " +
        "This enables read+write operations (placing orders, setting leverage, etc). " +
        "ALWAYS call this tool when user provides address + key, even if the wallet appears connected — " +
        "it may have been disconnected via UI. Do NOT prompt for the private key — it should already be in the message.",
      parameters: Type.Object({
        address: Type.String({ description: "Hyperliquid wallet address (0x...)" }),
        privateKey: Type.String({ description: "Wallet private key (0x...)" }),
      }),
      async execute(_toolCallId, params) {
        try {
          hl.connect({
            address: params.address,
            privateKey: params.privateKey,
            testnet,
          });
          if (saveWalletConfig) {
            await saveWalletConfig(params.address, params.privateKey);
          }
          return textResult(
            `Wallet connected (${testnet ? "testnet" : "mainnet"}, read+write).\n` +
            `Address: ${truncateAddress(params.address)}\n` +
            `Wallet saved (encrypted) — will reconnect on restart.`
          );
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_get_balance",
      label: "Get Balance",
      description: "Get portfolio balance: equity, available margin, margin used, unrealized PnL. Optionally specify a wallet address.",
      parameters: Type.Object({
        address: Type.Optional(Type.String({ description: "Wallet address to query. If omitted, uses default wallet." })),
      }),
      async execute(_toolCallId, params) {
        try {
          const address = params.address ?? await resolveReadAddress(hl, walletStore);
          if (!address) return errorResult("No wallet connected. Use ghost_connect_wallet to connect.");
          const bal = await hl.getBalance(address);
          const positions = await hl.getPositions(address);
          const prefix = params.address ? `Wallet ${truncateAddress(address)}:\n` : "";
          return textResult(prefix + formatBalance({
            equity: bal.totalEquity, availableMargin: bal.availableBalance,
            totalMarginUsed: bal.usedMargin, unrealizedPnl: bal.unrealizedPnl,
            positionCount: positions.length,
          }));
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_get_positions",
      label: "Get Positions",
      description: "Get all open positions with entry, mark, liq price, PnL, leverage. Optionally specify a wallet address.",
      parameters: Type.Object({
        address: Type.Optional(Type.String({ description: "Wallet address to query. If omitted, uses default wallet." })),
      }),
      async execute(_toolCallId, params) {
        try {
          const address = params.address ?? await resolveReadAddress(hl, walletStore);
          if (!address) return errorResult("No wallet connected. Use ghost_connect_wallet to connect.");
          const prefix = params.address ? `Wallet ${truncateAddress(address)}:\n` : "";
          return textResult(prefix + formatPositions(await hl.getPositions(address)));
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_get_orders",
      label: "Get Open Orders",
      description: "Get all pending orders with type, price, size, and trigger conditions. Optionally specify a wallet address.",
      parameters: Type.Object({
        address: Type.Optional(Type.String({ description: "Wallet address to query. If omitted, uses default wallet." })),
      }),
      async execute(_toolCallId, params) {
        try {
          const address = params.address ?? await resolveReadAddress(hl, walletStore);
          if (!address) return errorResult("No wallet connected. Use ghost_connect_wallet to connect.");
          const orders = await hl.getOpenOrders(address);
          if (orders.length === 0) return textResult("No open orders.");
          const lines = orders.map((o) => {
            const kind = classifyOrderKind(o);
            const row = formatOrder({
              symbol: o.symbol, side: o.side, type: o.orderType,
              size: o.size, price: o.price ?? undefined, triggerPrice: o.triggerPrice ?? undefined,
            });
            return `#${o.orderId} [${kind}] ${row}`;
          });
          const prefix = params.address ? `Wallet ${truncateAddress(address)}:\n` : "";
          return textResult(`${prefix}${orders.length} open order(s):\n${lines.join("\n")}`);
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_disconnect_wallet",
      label: "Disconnect Wallet",
      description:
        "Disconnect a wallet. If no address specified, disconnects the currently active wallet. " +
        "Removes stored credentials (address, private key). ",
      parameters: Type.Object({
        address: Type.Optional(Type.String({ description: "Wallet address to disconnect. If omitted, disconnects current active wallet." })),
      }),
      async execute(_toolCallId, params) {
        try {
          if (params.address) {
            // Disconnect specific wallet
            const wallet = walletStore.getWallet(params.address);
            if (!wallet) return errorResult("Wallet not found.");
            const removed = await walletStore.remove(params.address);
            if (!removed) return errorResult("Failed to remove wallet.");
            // If we disconnected the active wallet, clear trading client
            if (hl.address === params.address) hl.disconnect();
            return textResult(
              `Wallet disconnected.\n` +
              `Address removed: ${truncateAddress(params.address)}\n` +
              `Credentials cleared.`
            );
          }
          // Disconnect current active wallet
          if (!hl.address) return errorResult("No wallet connected. Nothing to disconnect.");
          if (!disconnectWallet) return errorResult("Disconnect not available.");
          const result = await disconnectWallet();
          if (!result) return errorResult("No wallet connected. Nothing to disconnect.");
          return textResult(
            `Wallet disconnected.\n` +
            `Address removed: ${truncateAddress(result.address)}\n` +
            `Credentials cleared. Trading features unavailable until you connect a wallet.`
          );
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_list_wallets",
      label: "List Wallets",
      description: "List all connected wallets with address, status (watch/trading), and default flag.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const wallets = walletStore.listWallets();
          if (wallets.length === 0) return textResult("No wallets connected.");
          const lines = wallets.map((w) => {
            const flags = [
              w.status === "trading" ? "trading" : "watch-only",
              w.isDefault ? "default" : "",
              w.testnet ? "testnet" : "mainnet",
            ].filter(Boolean).join(", ");
            return `• ${w.address} (${flags})`;
          });
          return textResult(`${wallets.length} wallet(s):\n${lines.join("\n")}`);
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
    defineTool({
      name: "ghost_set_default_wallet",
      label: "Set Default Wallet",
      description: "Set a wallet as the default for trading. Wallet must have trading enabled (API wallet connected).",
      parameters: Type.Object({
        address: Type.String({ description: "Wallet address to set as default" }),
      }),
      async execute(_toolCallId, params) {
        try {
          const wallet = walletStore.getWallet(params.address);
          if (!wallet) return errorResult("Wallet not found. Use ghost_list_wallets to see connected wallets.");
          if (wallet.status !== "trading") {
            return errorResult("Wallet is watch-only — trading not enabled.");
          }
          walletStore.setDefault(params.address);
          // Reconnect trading client to new default
          const data = await walletStore.load();
          if (data) hl.connect(data);
          return textResult(`Default wallet set to ${truncateAddress(params.address)}.`);
        } catch (e: unknown) {
          return errorResult(getErrorMessage(e));
        }
      },
    }),
  ];
}
