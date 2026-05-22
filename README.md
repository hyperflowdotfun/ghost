# Ghost

> Trade better WITH AI beside you.

AI companion for Hyperliquid perpetual contract traders. Not a dashboard. Not a bot. A companion that helps you manage risk, maintain discipline, and trade with emotional awareness.

## What Ghost Does

- **Trading Access** — View portfolio, place orders, manage positions, set SL/TP — all through chat
- **Pre-Trade Advisory** — Market context, risk assessment, and behavioral pattern detection before every trade
- **Market Intelligence** — News aggregation, whale tracking, cross-exchange analysis — filtered to what matters to you
- **Technical Analysis** — Chart patterns, indicators, and multi-timeframe analysis on demand

## Quick Start

Requires **[Bun](https://bun.sh) >= 1.1**:

```bash
# Install Bun (if you don't have it)
curl -fsSL https://bun.sh/install | bash             # macOS / Linux
powershell -c "irm bun.sh/install.ps1 | iex"         # Windows
```

**1. Install Ghost**

```bash
bun install -g "@hyperflow.fun/ghost"
```

Or one-line install via the bundled script (bootstraps Bun if missing,
then runs `ghost onboard`):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/hyperflowdotfun/ghost/main/install.sh | bash

# Windows (PowerShell)
powershell -c "irm https://raw.githubusercontent.com/hyperflowdotfun/ghost/main/install.ps1 | iex"
```

**2. Onboard**

```bash
ghost onboard
```

You'll be asked to pick:

- **Trading Mode** — Paper (virtual funds, no wallet) or Live (real trades on Hyperliquid)
- **LLM Model** — Claude Code, Anthropic, OpenAI, Gemini, OpenRouter, or a custom endpoint
- **Install Ghost service** — Select **Yes** to keep Ghost running in the background

> **Paper trading?** Pick **Paper** during onboard for a simulated 10,000 USDC
> balance — no wallet, no real trades. Set a custom balance with
> `ghost daemon --paper -b 50000`.

**3. Open the dashboard**

Visit **http://localhost:15401** and start trading.

## Commands

```bash
ghost daemon          # Start Ghost in the foreground
ghost status          # Show config and auth summary
ghost doctor          # Full diagnostic
ghost update          # Check for a new version and reinstall in place
ghost uninstall       # Remove service + ~/.ghost
```

See the [User Guide](USER_GUIDE.md) for the full reference.

## Telegram (optional)

Chat with Ghost from Telegram instead of (or alongside) the dashboard.

**From the dashboard** — click the **Telegram icon** in the top bar and follow
the in-app steps. Most users only need this.

**From the CLI** — same flow, scripted:

```bash
ghost channel setup    # Create the bot + bind it to your account
ghost channel pair     # Pair another device to the same channel
ghost channel status   # Show channel + pairing state
```

Once connected, Ghost mirrors trade prompts, alerts, and confirmations to
Telegram.

## Documentation

| Document | Purpose |
|----------|---------|
| [User Guide](USER_GUIDE.md) | Install, setup, daily commands, update, uninstall, troubleshooting |
| [Install & Onboard Guide](INSTALL_GUIDE.md) | Step-by-step onboard flow for AI agents |
| [Developer Guide](CLAUDE.md) | Architecture, tech stack, conventions, development pipeline |

## Data Storage

All data stored in `~/.ghost/` (config, credentials, database, memory, sessions). Nothing leaves your machine.

## Security

The Ghost gateway has no built-in authentication layer. By default it binds to
loopback only (`gateway.host=127.0.0.1`), so the dashboard is reachable from
the same machine but invisible to the network — safe to leave as-is for local
use.

To reach the dashboard from another device, put an authenticated tunnel
(Tailscale Serve, ngrok OAuth, mTLS proxy) in front of `127.0.0.1:15401`.
See [docs/security/network-exposure.md](docs/security/network-exposure.md).

## License

Open source.
