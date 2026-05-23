import pino from "pino";
import pinoPretty from "pino-pretty";
import pinoRoll from "pino-roll";
import { join } from "node:path";
import { defaultLogDir } from "./services/os/utils.js";

export type Verbosity = 0 | 1 | 2;

/** No-op logger for optional logger parameters. */
export const NOOP_LOGGER: pino.Logger = pino({ level: "silent" });

/**
 * Truncate a string for safe inclusion in log fields. Defaults to 200 chars
 * so noisy model outputs don't flood aggregators. Appends the original length
 * in brackets when truncated so operators can tell how much was dropped.
 *
 * Not a PII scrubber — callers that embed user content in prompts should
 * still audit what the model is given.
 */
export function redactForLog(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}…[${text.length} chars]`;
}

/**
 * Scrub Telegram bot tokens from a string.
 *
 * Tokens appear as `<numeric_id>:<35+_char_secret>` and often surface inside
 * grammY error messages as part of the API URL:
 *   https://api.telegram.org/bot<TOKEN>/getMe
 *
 * The regex matches both the bare token form and the `bot<TOKEN>` URL form.
 * Applied in the pino `err` serializer so ALL `{ err }` log payloads (message
 * + stack) are scrubbed without needing per-call-site redaction.
 */
export function redactBotToken(s: string): string {
  // Matches: bot123456789:ABCdef-ghijkLMNOP_qrstUVWX0123456  (URL form)
  //      or: 123456789:ABCdef-ghijkLMNOP_qrstUVWX0123456     (bare form)
  return s.replace(/\bbot(\d+:[A-Za-z0-9_-]{30,})/g, "bot<redacted>")
          .replace(/\b(\d+:[A-Za-z0-9_-]{30,})/g, "<redacted>");
}

/** Pino `err` serializer that scrubs bot tokens from message + stack. */
function serializeErr(err: unknown): unknown {
  // Let pino's built-in errSerializer run first by returning a plain object
  // with the same shape, but with message and stack redacted.
  if (err instanceof Error) {
    return {
      type: err.constructor?.name ?? "Error",
      message: redactBotToken(err.message),
      stack: err.stack ? redactBotToken(err.stack) : err.stack,
    };
  }
  if (typeof err === "string") return redactBotToken(err);
  return err;
}

const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

/**
 * Create the root pino logger for this process.
 *
 * Always writes to ~/.ghost/logs/ghost.YYYY-MM-DD.<N>.log via pino-roll
 * (rotates at midnight or 10 MB within a day, keeps 5 most-recent files,
 * ~50 MB total cap). When stdout is a TTY, ALSO mirrors to pretty-printed
 * stdout — same record, two destinations — via pino.multistream.
 *
 * Why always-to-file (no isTTY branching): under Windows schtasks the
 * supervisor runs the daemon under a hidden cmd console. The console still
 * makes `process.stdout.isTTY` report true even though no user can see it,
 * so an either/or branch silently routed every log line to NUL. Multistream
 * sidesteps the heuristic entirely — the file is always the source of truth,
 * pretty stdout is just a developer-comfort mirror.
 *
 * Supervisor stdout sinks (unmanaged — only catches pre-flush crashes):
 *   systemd  → journald
 *   launchd  → unified logging
 *   schtasks → hidden console (effectively NUL)
 */
export async function createRootLogger(verbosity: Verbosity = 0): Promise<pino.Logger> {
  const envLevel = process.env.LOG_LEVEL;
  const level: pino.Level =
    verbosity >= 2
      ? "trace"
      : verbosity >= 1
        ? "debug"
        : (envLevel && VALID_LEVELS.has(envLevel) ? (envLevel as pino.Level) : "info");

  const opts: pino.LoggerOptions = {
    level,
    serializers: {
      // Override pino's default err serializer to scrub bot tokens before
      // the log record is flushed to any transport (journald, syslog, etc.).
      // Covers `{ err }` log sites in channels/ and gateway/.
      err: serializeErr,
      // Also cover `rmErr` field used in manager.activate rollback log.
      rmErr: serializeErr,
    },
  };

  // 1. Always set up the rotating file destination. Failure here is fatal
  //    for the file path; we still surface logs via stdout (if TTY) and
  //    stderr (one-liner diagnostic).
  // No symlink: pino-roll's createSymlink is called without await, causing
  // an unhandled EPERM rejection on Windows (no Developer Mode), which triggers
  // the unhandledRejection handler → exit 101 → supervisor restart loop.
  const streams: pino.StreamEntry[] = [];
  try {
    const fileStream = await pinoRoll({
      file: join(defaultLogDir(), "ghost"),
      frequency: "daily",
      dateFormat: "yyyy-MM-dd",
      size: "10m",
      extension: ".log",
      limit: { count: 5, removeOtherLogFiles: true },
      mkdir: true,
    });
    streams.push({ stream: fileStream, level });
  } catch (err) {
    // Log rotation setup failed (EACCES on ~/.ghost/logs, disk full, etc.).
    // Fall back to stderr so the CLI stays usable — `ghost doctor` is the
    // user's escape hatch and it must not crash on the same condition.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[ghost] log rotation init failed (${msg}); falling back to stderr\n`);
    streams.push({ stream: process.stderr, level });
  }

  // 2. If a real interactive terminal is attached (developer running
  //    `bun run dev daemon`), mirror the same records to a pretty-printed
  //    stdout. In service contexts stdout goes to a hidden console / journald
  //    / NUL — the file stream above is the source of truth.
  if (process.stdout.isTTY) {
    streams.push({ stream: pinoPretty({ colorize: true }), level });
  }

  return pino(opts, pino.multistream(streams));
}
