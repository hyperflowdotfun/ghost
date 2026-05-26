/**
 * News types, constants, and preset source definitions.
 */

// ---------------------------------------------------------------------------
// Article & source interfaces
// ---------------------------------------------------------------------------

export interface NewsArticle {
  id: string;
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  description: string;
  imageUrl: string | null;
  coins: string[];
  importance: Importance;
  publishedAt: number;
  fetchedAt: number;
  expiresAt: number;
  body: string | null;
  summary: string | null;
  aiRelevant: boolean | null;
  aiDuplicateOf: string | null;
}

export type Importance = "urgent" | "important" | "reference";

export interface NewsSource {
  sourceId: string;
  name: string;
  enabled: number;
  apiKey: string | null;
  customUrl: string | null;
  addedAt: number;
}

// ---------------------------------------------------------------------------
// Coin tagging map — top ~50 coins with common aliases
// ---------------------------------------------------------------------------

export const COIN_MAP: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"],
  ETH: ["ethereum", "ether", "eth"],
  SOL: ["solana", "sol"],
  BNB: ["binance", "bnb"],
  XRP: ["ripple", "xrp"],
  ADA: ["cardano", "ada"],
  DOGE: ["dogecoin", "doge"],
  AVAX: ["avalanche", "avax"],
  DOT: ["polkadot", "dot"],
  LINK: ["chainlink", "link"],
  MATIC: ["polygon", "matic"],
  UNI: ["uniswap", "uni"],
  SHIB: ["shiba", "shib"],
  LTC: ["litecoin", "ltc"],
  ATOM: ["cosmos", "atom"],
  FIL: ["filecoin", "fil"],
  APT: ["aptos", "apt"],
  ARB: ["arbitrum", "arb"],
  OP: ["optimism"],
  NEAR: ["near protocol", "near"],
  SUI: ["sui"],
  SEI: ["sei"],
  INJ: ["injective", "inj"],
  TIA: ["celestia", "tia"],
  JUP: ["jupiter", "jup"],
  AAVE: ["aave"],
  MKR: ["maker", "mkr"],
  CRV: ["curve", "crv"],
  LDO: ["lido", "ldo"],
  PEPE: ["pepe"],
  WIF: ["dogwifhat", "wif"],
  FET: ["fetch.ai", "fet"],
  RENDER: ["render", "rndr"],
  STX: ["stacks", "stx"],
  IMX: ["immutable", "imx"],
  HYPE: ["hyperliquid", "hype"],
  TRX: ["tron", "trx"],
  TON: ["toncoin", "ton"],
  BCH: ["bitcoin cash", "bch"],
  ALGO: ["algorand", "algo"],
  FTM: ["fantom", "ftm"],
  SAND: ["sandbox", "sand"],
  MANA: ["decentraland", "mana"],
  GRT: ["the graph", "grt"],
  SNX: ["synthetix", "snx"],
  ENS: ["ens"],
  COMP: ["compound", "comp"],
  RUNE: ["thorchain", "rune"],
  PENDLE: ["pendle"],
  WLD: ["worldcoin", "wld"],
};

// ---------------------------------------------------------------------------
// Urgency keywords — matched case-insensitively
// ---------------------------------------------------------------------------

export const URGENT_KEYWORDS: string[] = [
  "hack",
  "exploit",
  "sec ",
  "delist",
  "rug pull",
  "halt",
  "crash",
  "bankrupt",
  "freeze",
  "lawsuit",
  "indictment",
];

// ---------------------------------------------------------------------------
// Crypto relevance keywords — used for rule-based pre-filter (Tier 1)
// Article must contain at least one keyword OR have a coin tag to pass.
// ---------------------------------------------------------------------------

export const CRYPTO_KEYWORDS: string[] = [
  "bitcoin", "btc", "ethereum", "eth", "crypto", "cryptocurrency",
  "blockchain", "defi", "nft", "token", "stablecoin", "altcoin",
  "exchange", "binance", "coinbase", "kraken", "bybit", "okx", "hyperliquid",
  "mining", "miner", "hashrate", "halving",
  "whale", "liquidation", "liquidated", "margin", "leverage",
  "sec", "cftc", "regulation", "regulatory",
  "airdrop", "staking", "yield", "vault", "tvl",
  "layer 2", "l2", "rollup", "zk-proof",
  "wallet", "ledger", "metamask", "seed phrase",
  "dex", "cex", "amm", "liquidity pool",
  "smart contract", "solidity", "web3",
  "memecoin", "meme coin",
];

// ---------------------------------------------------------------------------
// News source presets
// ---------------------------------------------------------------------------

export interface NewsSourcePreset {
  sourceId: string;
  name: string;
  type: "api" | "rss";
  needsApiKey: boolean;
  defaultUrl?: string;
}

export const NEWS_SOURCE_PRESETS: NewsSourcePreset[] = [
  { sourceId: "cryptopanic", name: "CryptoPanic", type: "api", needsApiKey: true },
  { sourceId: "coindesk", name: "CoinDesk", type: "rss", needsApiKey: false, defaultUrl: "https://www.coindesk.com/arc/outboundfeeds/rss" },
  { sourceId: "theblock", name: "The Block", type: "rss", needsApiKey: false, defaultUrl: "https://www.theblock.co/rss.xml" },
  { sourceId: "decrypt", name: "Decrypt", type: "rss", needsApiKey: false, defaultUrl: "https://decrypt.co/feed" },
  { sourceId: "cointelegraph", name: "CoinTelegraph", type: "rss", needsApiKey: false, defaultUrl: "https://cointelegraph.com/rss" },
  // { sourceId: "coingecko", name: "CoinGecko", type: "api", needsApiKey: false },
];

// ---------------------------------------------------------------------------
// TTL constants (seconds)
// ---------------------------------------------------------------------------

/** 30 days */
export const URGENT_TTL = 2_592_000;
/** 7 days */
export const IMPORTANT_TTL = 604_800;
/** 3 days */
export const REFERENCE_TTL = 259_200;

// ---------------------------------------------------------------------------
// Stopwords for dedup title comparison
// ---------------------------------------------------------------------------

export const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "and", "but", "or",
  "nor", "not", "so", "yet", "both", "either", "neither", "each",
  "every", "all", "any", "few", "more", "most", "other", "some", "such",
  "no", "only", "own", "same", "than", "too", "very", "just", "about",
  "its", "it", "this", "that", "these", "those", "what", "which", "who",
]);
