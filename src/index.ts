import { parseArgs } from "util";
import { join } from "node:path";
import { createRuntime } from "./runtime.js";
import { getConfigPath } from "./config/index.js";
import { OAuthManager } from "./auth/oauth.js";
import { SecretStore } from "./config/secrets.js";
import { CredentialStore } from "./config/credentials.js";
import { runWizard } from "./onboard/index.js";
import { ConfigError } from "./core/errors.js";
import { createRootLogger, type Verbosity } from "./logger.js";
import { formatUpdateHint, getCurrentVersion } from "./update/version.js";
import { readUpdateCache } from "./update/version-cache.js";
import { ChannelId } from "./channels/types.js";
import { TOKEN_KEY as TELEGRAM_TOKEN_KEY } from "./channels/telegram/plugin.js";
import { checkDaemonState } from "./health/daemon-state.js";
import type { Logger } from "pino";

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    config: { type: "string", short: "c" },
    paper: { type: "boolean", short: "p" },
    balance: { type: "string", short: "b" },
    provider: { type: "string" },
    model: { type: "string" },
    models: { type: "string" },
    version: { type: "boolean", short: "V" },
    json: { type: "boolean" },
    channel: { type: "string" },
    token: { type: "string" },
    follow: { type: "boolean", short: "f" },
    lines: { type: "string", short: "n" },
    plain: { type: "boolean" },
    "no-color": { type: "boolean" },
  },
  allowPositionals: true,
  strict: false,
});

/**
 * Narrow a `parseArgs` value to a non-empty string. With `strict: false`,
 * flag values may be `boolean` (when the user passes `--channel` without a
 * value) or `undefined`.
 */
function stringOpt(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Count -v flags: -v=1, -vv=2, clamped to max 2. */
const verbosity = Math.min(
  2,
  Bun.argv.slice(2)
    .filter((a) => /^-v+$/.test(a))
    .reduce((n, a) => n + a.slice(1).length, 0),
) as Verbosity;

// Single root logger for this process — threaded into every subsystem.
// pino-roll daily mode when running as a service; TTY dev runs pretty-print
// to stdout. Async factory required — pino-roll's stream setup is async.
const rootLogger = await createRootLogger(verbosity);

// Print version and exit — probes the registry directly (2s timeout). On
// fetch failure prints current only and exits 0. No cache reads or writes;
// the daemon's VersionCheckService owns the cache that backs `ghost status`.
if (values.version || positionals[0] === "version") {
  const { runVersion } = await import("./commands/version.js");
  await runVersion({ json: Boolean(values.json), logger: rootLogger });
  process.exit(0);
}

const command = positionals[0];

try {
  switch (command) {
    case "status":
      await runStatus({ config: stringOpt(values.config), logger: rootLogger });
      break;
    case "doctor":
      await runDoctor({ config: stringOpt(values.config), logger: rootLogger });
      break;
    case "onboard":
      await runOnboard({
        paper: Boolean(values.paper),
        balance: stringOpt(values.balance),
        provider: stringOpt(values.provider),
        model: stringOpt(values.model),
        logger: rootLogger,
      });
      break;
    case "daemon":
      if (positionals[1] === "stop") {
        const { runDaemonStopCli } = await import("./commands/daemon/stop.js");
        await runDaemonStopCli();
        break;
      }
      await runDaemon({ config: stringOpt(values.config), logger: rootLogger });
      break;
    case "providers":
      await runProviders(positionals.slice(1), values as { models?: string });
      break;
    case "skills":
      await runSkills(positionals.slice(1), { config: stringOpt(values.config) });
      break;
    case "logs": {
      const { runLogs } = await import("./commands/logs/index.js");
      await runLogs({
        follow: Boolean(values.follow),
        lines: stringOpt(values.lines),
        json: Boolean(values.json),
        plain: Boolean(values.plain),
        noColor: Boolean(values["no-color"]),
      });
      break;
    }
    case "update":
      await runUpdate(rootLogger, { channel: stringOpt(values.channel) });
      break;
    case "uninstall": {
      const { runUninstallCli } = await import("./commands/uninstall.js");
      await runUninstallCli();
      break;
    }
    case "channel": {
      const { runChannelCli } = await import("./commands/channel/index.js");
      await runChannelCli(positionals[1], positionals.slice(2), {
        json: Boolean(values.json),
        token: stringOpt(values.token),
      });
      break;
    }
    case "proactive": {
      const action = positionals[1] as string | undefined;
      if (!action || !["on", "off", "status"].includes(action)) {
        console.error("usage: ghost proactive on|off|status");
        process.exit(1);
      }
      await runProactive(action as "on" | "off" | "status", {
        configPath: stringOpt(values.config),
        logger: rootLogger,
      });
      break;
    }
    default:
      printUsage();
      process.exit(command ? 1 : 0);
      break;
  }
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  rootLogger.fatal({ err }, "fatal startup error");
  throw err;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runStatus(opts: { config?: string; logger: Logger }) {
  const configPath = opts.config ?? getConfigPath();
  const { loadConfig } = await import("./config/index.js");
  const config = loadConfig(configPath);

  const { getSecretKeyPath, getCredentialsPath } = await import("./config/paths.js");
  const secretStore = new SecretStore(getSecretKeyPath());
  const credentials = new CredentialStore(
    getCredentialsPath(),
    secretStore,
    opts.logger.child({ module: "credentials" }),
  );
  const oauth = new OAuthManager(credentials);
  await oauth.ensureLoaded();
  const oauthProviders = oauth.listAuthenticated();
  const isUsingOAuth = oauthProviders.includes(config.provider);
  const hasApiKey = await credentials.has("api_key");
  const authDisplay = isUsingOAuth
    ? `OAuth (${config.provider})`
    : hasApiKey
    ? "API Key"
    : "not set";

  const currentVersion = getCurrentVersion();

  // The CLI never performs a blocking network fetch. The daemon's
  // VersionCheckService persists each result to the update cache; we
  // only hint when the persisted snapshot confirms a newer version.
  const hint = formatUpdateHint(currentVersion, readUpdateCache());

  const daemonState = await checkDaemonState({
    host: config.gateway.host,
    port: config.gateway.port,
    logger: opts.logger,
  });

  console.log(`Ghost v${currentVersion}`);
  if (hint) console.log(hint);
  console.log("============");
  console.log(`Provider:    ${config.provider}/${config.model}`);
  console.log(`Auth:        ${authDisplay}`);
  console.log(`Autonomy:    ${config.autonomy.level}`);
  console.log(
    `Gateway:     http://${config.gateway.host}:${config.gateway.port} ` +
      `(${daemonState.gateway.reachable ? "reachable" : "unreachable"})`,
  );
  console.log(`Service:     ${daemonState.service}`);

  const telegramToken = await credentials.has(TELEGRAM_TOKEN_KEY);
  if (!telegramToken) {
    console.log("Telegram:    not configured (run: ghost channel status)");
  } else {
    console.log("Telegram:    connected (details: ghost channel status --json)");
  }
  process.exit(0);
}

async function runDoctor(opts: { config?: string; logger: Logger }) {
  console.log("Ghost Doctor");
  console.log("============");

  try {
    const runtime = await createRuntime({ configPath: opts.config, logger: opts.logger });
    console.log("✓ Config loaded");
    console.log("✓ Database initialized");
    console.log(`✓ Model: ${runtime.config.provider}/${runtime.config.model}`);
    console.log(`✓ Memory: file-based (MEMORY.md + HISTORY.md)`);
    console.log(`✓ Tools registered: ${runtime.tools.names().length}`);
    const memOk = runtime.memoryStore.healthCheck();
    console.log(`✓ Memory health: ${memOk ? "ok" : "degraded"}`);

    // Surface custom providers + any models.json issues so users can spot
    // typos before they hit "Unknown model" at runtime.
    const custom = runtime.customModelRegistry;
    const customList = custom.list();
    if (customList.length > 0) {
      console.log(`✓ Custom providers: ${customList.length}`);
      for (const entry of customList) {
        console.log(`   - ${entry.provider}/${entry.model}`);
      }
    }
    for (const err of custom.loadErrors) {
      console.log(`✗ models.json: ${err}`);
    }

    const daemonState = await checkDaemonState({
      host: runtime.config.gateway.host,
      port: runtime.config.gateway.port,
      logger: opts.logger,
    });
    const gatewayMark = daemonState.gateway.reachable ? "✓" : "✗";
    console.log(
      `${gatewayMark} Gateway: ${daemonState.gateway.reachable ? "reachable" : "unreachable"} ` +
        `on ${daemonState.gateway.host}:${daemonState.gateway.port}`,
    );
    const serviceMark = daemonState.service === "running" ? "✓" : "✗";
    console.log(`${serviceMark} Service: ${daemonState.service}`);

    runtime.db.close();
    // Exit code and summary must agree. models.json errors are treated as
    // failures — a broken registry means the user's config is unusable at
    // runtime. Gateway/service down is operator state, surfaced but not fatal.
    const hasErrors = custom.loadErrors.length > 0;
    console.log(
      hasErrors
        ? "\nChecks FAILED — fix models.json errors above."
        : "\nAll checks passed.",
    );
    process.exit(hasErrors ? 1 : 0);
  } catch (err) {
    console.error(`✗ Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function runOnboard(opts: {
  paper?: boolean; balance?: string; logger: Logger;
  provider?: string; model?: string;
}) {
  const headless = opts.provider && opts.model
    ? {
        provider: opts.provider,
        model: opts.model,
        apiKey: process.env["GHOST_API_KEY"],
      }
    : undefined;

  if (!opts.paper) {
    await runWizard({ logger: opts.logger, headless });
    return;
  }

  const { paperSchema } = await import("./config/schema.js");
  const raw: Record<string, unknown> = { enabled: true };
  if (opts.balance) {
    const balance = parseFloat(opts.balance);
    if (isNaN(balance) || balance <= 0) {
      console.error("Invalid balance. Must be a positive number.");
      process.exit(1);
    }
    raw.initialBalance = balance;
  }
  await runWizard({ paper: paperSchema.parse(raw), logger: opts.logger, headless });
}

async function runProviders(_positionals: string[], values: { models?: string }): Promise<void> {
  const { listProviders, listModels } = await import("./onboard/cli-providers.js");
  if (values.models) {
    listModels(values.models);
  } else {
    listProviders();
  }
}

async function runDaemon(opts: { config?: string; logger: Logger }) {
  const { startDaemon } = await import("./daemon/index.js");
  await startDaemon({ configPath: opts.config, logger: opts.logger });
}

async function runSkills(subArgs: string[], opts: { config?: string }) {
  const subCommand = subArgs[0];

  switch (subCommand) {
    case "list": {
      const { loadConfig, getConfigPath: getPath, expandHome } = await import("./config/index.js");
      const { getWorkspaceDir } = await import("./config/paths.js");
      const { SkillsLoader } = await import("./skills/index.js");
      const configPath = opts.config ?? getPath();
      const config = loadConfig(configPath);
      const workspaceDir = getWorkspaceDir();
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      let builtinDir: string | undefined;
      if (config.skills.builtinSkillsDir) {
        builtinDir = expandHome(config.skills.builtinSkillsDir);
      } else {
        const candidate = join(import.meta.dir, "skills", "builtin");
        if (existsSync(candidate)) builtinDir = candidate;
      }
      const loader = new SkillsLoader(workspaceDir, builtinDir);
      const skills = loader.listSkills();
      if (skills.length === 0) {
        console.log("No skills found.");
      } else {
        for (const s of skills) {
          const meta = loader.getSkillMetadata(s.name);
          const available = meta ? loader.checkRequirements(meta) : true;
          const status = available ? "ok" : "missing deps";
          console.log(`  ${s.name} (${s.source}) [${status}] — ${meta?.description ?? ""}`);
        }
      }
      break;
    }
    default:
      console.log("Usage: ghost skills list");
      break;
  }
}

async function runUpdate(logger: Logger, opts: { channel?: string }): Promise<void> {
  const { runUpdate: execUpdate } = await import("./update/run.js");
  const { exitCode } = await execUpdate({ logger, channel: opts.channel });
  process.exit(exitCode);
}

async function runProactive(
  action: "on" | "off" | "status",
  opts: { configPath?: string; logger: Logger },
): Promise<void> {
  const { loadConfig, saveConfig } = await import("./config/loader.js");
  const { runProactiveCommand } = await import("./commands/proactive.js");
  const { getConfigPath } = await import("./config/paths.js");

  const configPath = opts.configPath ?? getConfigPath();
  const config = loadConfig(configPath);

  const result = await runProactiveCommand(action, {
    config,
    writeConfig: (cfg) => saveConfig(cfg, configPath),
    logger: opts.logger,
  });

  if (action === "status") {
    console.log(JSON.stringify(result, null, 2));
    console.log(
      "Note: setting reflects ~/.ghost/config.json; running daemon picks this up only on restart.",
    );
  } else {
    const newState = action === "on" ? "ON" : "OFF";
    console.log(`Proactive advisor set to ${newState}.`);
    console.log(
      `Restart the daemon (\`ghost daemon restart\` or stop/start the service) for the change to take effect.`,
    );
  }
}

function printUsage() {
  console.log(`
Ghost — AI Trading Companion for Hyperliquid

Usage:
  ghost onboard                   Interactive setup wizard
  ghost onboard --paper           Setup wizard + paper mode (10k USDC)
  ghost onboard --paper -b 50000  Setup wizard + paper mode with custom balance
  ghost onboard --provider <id> --model <id>
                                  Non-interactive setup (use GHOST_API_KEY env for key)
  ghost daemon                    Start gateway + channels + scheduler
  ghost daemon stop               Stop the registered OS service (interactive confirm)
  ghost --version                 Print version and exit (plain text)
  ghost --version --json          Print {current, latest, updateAvailable} as JSON
  ghost status                    Show config and auth summary
  ghost doctor                    Verify config, DB, and provider
  ghost update                    Update Ghost to the latest stable version
  ghost update --channel=rc       Update to the latest pre-release (dev testers)
  ghost uninstall                 Remove OS service + ~/.ghost (interactive confirm)
  ghost logs                      Print last 200 lines of service log and exit
  ghost logs -f                   Follow the service log (Ctrl+C to stop)
  ghost logs -n 50                Print last 50 lines and exit
  ghost logs --json               Emit JSON log lines (machine-readable)
  ghost logs --plain              Plain text (no ANSI), default when piped
  ghost logs --no-color           Disable ANSI colors even in TTY
  ghost providers                 List available LLM providers
  ghost providers --models <id>   List models for a provider
  ghost skills list               List available skills
  ghost channel setup <id>        Configure a channel bot token (interactive)
  ghost channel setup <id> --token=…
                                  Configure non-interactively (scripts/CI)
  ghost channel pair              List pending pairing requests across all channels
  ghost channel pair <channel>    List pending pairing requests for a channel
  ghost channel pair <channel> approve [<code>]
                                  Approve a pairing request (interactive picker if no code)
  ghost channel status            Show active channel state
  ghost proactive on|off|status   Enable/disable proactive advisor (restart required)
  `.trim());
}
