/**
 * useWallet — multi-provider wallet connect + API wallet (ApproveAgent) flow.
 *
 * Step 1: connectWallet(provider) → extension popup → store as watch-only
 * Step 2: addApiWallet(address) → generate keypair → sign ApproveAgent → enable trading
 */

import { useState, useCallback, useEffect } from "react";
import { createWalletClient, custom, parseSignature, defineChain, type Chain } from "viem";
import { arbitrum } from "viem/chains";
import { useWalletProviders, type WalletProvider } from "./useWalletProviders";

const hyperliquidTestnetChain: Chain = defineChain({
  id: 998,
  name: "Hyperliquid Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.hyperliquid-testnet.xyz/evm"] } },
});

interface WalletInfo {
  address: string;
  testnet: boolean;
  isDefault: boolean;
  source: string;
  status: "watch" | "trading";
  apiWalletAddress: string | null;
  addedAt: string;
}

export type SigningPhase = "generating" | "switching-chain" | "signing" | "submitting" | "confirming";

export function useWallet() {
  const [wallets, setWallets] = useState<WalletInfo[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [signingAddress, setSigningAddress] = useState<string | null>(null);
  const [signingPhase, setSigningPhase] = useState<SigningPhase | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const { providers, getProviderByRdns } = useWalletProviders();

  const fetchWallets = useCallback(async () => {
    try {
      const res = await fetch("/api/wallets");
      if (res.ok) setWallets(await res.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchWallets(); }, [fetchWallets]);

  useEffect(() => {
    const handler = () => { fetchWallets(); };
    window.addEventListener("ghost-wallet-changed", handler);
    return () => window.removeEventListener("ghost-wallet-changed", handler);
  }, [fetchWallets]);

  /** Connect wallet via a specific provider → watch-only */
  const connectWallet = useCallback(async (wp: WalletProvider) => {
    setConnecting(true);
    setError(null);
    setInfo(null);
    try {
      const client = createWalletClient({ transport: custom(wp.provider) });
      let accounts: string[];
      try {
        // wallet_requestPermissions is MetaMask-specific, not wrapped by viem
        await wp.provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
        accounts = await client.getAddresses();
      } catch {
        accounts = await client.requestAddresses();
      }
      if (accounts.length === 0) throw new Error("No account selected");

      const source = wp.info.rdns;
      const newAddresses: string[] = [];

      for (const address of accounts) {
        const res = await fetch("/api/wallet/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, testnet: false, source }),
        });
        if (res.ok) {
          const data = await res.json();
          if (data.isNew) newAddresses.push(address);
        }
      }

      await fetchWallets();
      if (newAddresses.length === 0) {
        const addrs = accounts.map((a) => `${a.slice(0, 6)}…${a.slice(-4)}`).join(", ");
        const prefix = accounts.length === 1 ? "This wallet address" : "Wallet addresses";
        setInfo(`${prefix} ${addrs} already connected. Switch account in your extension to add a different one.`);
        return null;
      }
      if (newAddresses.length === 1) {
        const a = newAddresses[0];
        setInfo(`Wallet connected: ${a.slice(0, 6)}…${a.slice(-4)}`);
      } else {
        setInfo(`${newAddresses.length} wallets connected`);
      }
      return newAddresses[0];
    } catch (e: unknown) {
      const raw = (e as Error)?.message || "Failed to connect wallet";
      setError(raw.length > 120 ? raw.slice(0, 120) + "…" : raw);
      return null;
    } finally {
      setConnecting(false);
    }
  }, [fetchWallets]);

  /** Generate API wallet + sign ApproveAgent on Hyperliquid */
  const addApiWallet = useCallback(async (walletAddress: string) => {
    setSigningAddress(walletAddress);
    setSigningPhase("generating");
    setError(null);
    setInfo(null);
    try {
      const wallet = wallets.find((w) => w.address.toLowerCase() === walletAddress.toLowerCase());
      const provider = wallet?.source ? getProviderByRdns(wallet.source) : null;
      if (!provider) throw new Error("Wallet extension not found. Reconnect the wallet.");

      const genRes = await fetch("/api/wallet/generate-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: walletAddress }),
      });
      const genData = await genRes.json();
      if (!genRes.ok) throw new Error(genData.error || "Failed to generate API wallet");
      const { agentAddress, nonce, chainId, signatureChainId, hyperliquidChain, exchangeUrl } = genData;

      const signChain: Chain = chainId === hyperliquidTestnetChain.id ? hyperliquidTestnetChain : arbitrum;
      const client = createWalletClient({ chain: signChain, transport: custom(provider) });

      const action = {
        type: "approveAgent",
        hyperliquidChain,
        signatureChainId,
        agentAddress,
        agentName: "ghost",
        nonce,
      };

      setSigningPhase("switching-chain");
      const currentChainId = await client.getChainId();
      if (currentChainId !== signChain.id) {
        try {
          await client.switchChain({ id: signChain.id });
        } catch (switchErr: unknown) {
          if ((switchErr as { code?: number })?.code === 4902) {
            await client.addChain({ chain: signChain });
          } else {
            throw switchErr;
          }
        }
      }

      const accounts = await client.getAddresses();
      const account = accounts.find((a) => a.toLowerCase() === walletAddress.toLowerCase());
      if (!account) {
        throw new Error(
          `Please switch to account ${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)} in your wallet extension before signing.`
        );
      }

      const domain = {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId,
        verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
      } as const;

      const types = {
        "HyperliquidTransaction:ApproveAgent": [
          { name: "hyperliquidChain", type: "string" },
          { name: "agentAddress", type: "address" },
          { name: "agentName", type: "string" },
          { name: "nonce", type: "uint64" },
        ],
      } as const;

      const message = {
        hyperliquidChain,
        agentAddress: agentAddress as `0x${string}`,
        agentName: "ghost",
        nonce: BigInt(nonce),
      };

      setSigningPhase("signing");
      const signature = await client.signTypedData({
        account,
        domain,
        types,
        primaryType: "HyperliquidTransaction:ApproveAgent",
        message,
      });

      if (currentChainId !== signChain.id) {
        client.switchChain({ id: currentChainId }).catch(() => {});
      }

      setSigningPhase("submitting");
      const { r, s, v } = parseSignature(signature);
      const hlRes = await fetch(exchangeUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          nonce,
          signature: { r, s, v: Number(v) },
        }),
      });

      let hlErrMsg = "ApproveAgent transaction failed on Hyperliquid";
      if (!hlRes.ok) {
        const errBody = await hlRes.text().catch(() => "");
        console.error("[addApiWallet] Hyperliquid response:", hlRes.status, errBody);
        try { hlErrMsg = JSON.parse(errBody)?.error || hlErrMsg; } catch {}
        // Cancel pending agent on server
        await fetch("/api/wallet/confirm-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: walletAddress }),
        });
        throw new Error(hlErrMsg);
      }

      setSigningPhase("confirming");
      const confirmRes = await fetch("/api/wallet/confirm-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: walletAddress, signature }),
      });
      if (!confirmRes.ok) {
        const data = await confirmRes.json().catch(() => ({}));
        throw new Error(data.error || "Server rejected agent approval");
      }

      await fetchWallets();
      window.dispatchEvent(new Event("ghost-wallet-changed"));
      return true;
    } catch (e: unknown) {
      const code = (e as { code?: number })?.code;
      if (code === 4001 || code === 4100) return false;
      const raw = (e as Error)?.message || "Failed to add API wallet";
      setError(raw.length > 120 ? raw.slice(0, 120) + "…" : raw);
      return false;
    } finally {
      setSigningAddress(null);
      setSigningPhase(null);
    }
  }, [fetchWallets, wallets, getProviderByRdns]);

  const removeWallet = useCallback(async (address: string) => {
    const res = await fetch("/api/wallet/remove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Failed to remove wallet");
    }
    await fetchWallets();
    window.dispatchEvent(new Event("ghost-wallet-changed"));
  }, [fetchWallets]);

  const setDefaultWallet = useCallback(async (address: string) => {
    const res = await fetch("/api/wallet/set-default", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (res.ok) await fetchWallets();
    else {
      const data = await res.json();
      setError(data.error || "Failed to set default");
    }
  }, [fetchWallets]);

  const clearMessages = useCallback(() => { setError(null); setInfo(null); }, []);

  return {
    wallets,
    connecting,
    signingAddress,
    signingPhase,
    error,
    info,
    providers,
    connectWallet,
    addApiWallet,
    removeWallet,
    setDefaultWallet,
    clearMessages,
    refreshWallets: fetchWallets,
  };
}
