/**
 * `ghost logs` entry point. Reads the active pino-roll log file from
 * ~/.ghost/logs/ and renders pino JSON lines in three modes:
 *   - tail-and-exit: bare `ghost logs` prints last N and exits
 *   - follow:        `ghost logs -f` polls with cursor every POLL_INTERVAL_MS
 *
 * Active file detection: each poll resolves the current ghost.YYYY-MM-DD.<N>.log
 * by scanning the log directory. When the file changes between polls (midnight
 * rotation or within-day size cap roll), the cursor resets to 0 and a notice
 * is emitted.
 *
 * EPIPE on stdout (e.g. `ghost logs --json | head -1`) exits cleanly.
 */

import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_MAX_BYTES, readLogTail } from "./tail.js";
import { defaultLogDir, findActiveLogFile } from "../../services/os/utils.js";
import { parsePinoLine } from "./parse.js";
import { formatPlain, formatPretty, formatRawLine } from "./format.js";

export interface LogsOptions {
  follow: boolean;
  lines?: string;
  json: boolean;
  plain: boolean;
  noColor: boolean;
}

const POLL_INTERVAL_MS = 1_000;

function parsePositiveInt(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

interface Writers {
  logLine(text: string): void;
  errorLine(text: string): void;
  emitJson(payload: Record<string, unknown>, toStderr?: boolean): void;
}

function createWriters(): Writers {
  const write = (stream: NodeJS.WriteStream, text: string): void => {
    try {
      stream.write(text);
    } catch (err) {
      // EPIPE = downstream closed (e.g. `| head -1`). Exit clean.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPIPE") process.exit(0);
      throw err;
    }
  };
  return {
    logLine: (text) => write(process.stdout, `${text}\n`),
    errorLine: (text) => write(process.stderr, `${text}\n`),
    emitJson: (payload, toStderr = false) =>
      write(toStderr ? process.stderr : process.stdout, `${JSON.stringify(payload)}\n`),
  };
}

function emitLine(
  writers: Writers,
  jsonMode: boolean,
  pretty: boolean,
  rich: boolean,
  raw: string,
): void {
  const parsed = parsePinoLine(raw);
  if (jsonMode) {
    if (parsed) {
      writers.emitJson({
        type: "log",
        time: parsed.time,
        level: parsed.level,
        name: parsed.name,
        msg: parsed.msg,
        ...(parsed.extras ?? {}),
      });
    } else {
      writers.emitJson({ type: "raw", raw });
    }
    return;
  }
  if (parsed) {
    writers.logLine(pretty ? formatPretty(parsed, { rich }) : formatPlain(parsed));
  } else {
    writers.logLine(formatRawLine(raw));
  }
}

function emitNotice(writers: Writers, jsonMode: boolean, message: string): void {
  if (jsonMode) writers.emitJson({ type: "notice", message }, true);
  else writers.errorLine(message);
}

export async function runLogs(opts: LogsOptions): Promise<void> {
  const jsonMode = opts.json;
  const pretty = !jsonMode && Boolean(process.stdout.isTTY) && !opts.plain;
  const rich = pretty && !opts.noColor;
  const lineCount = parsePositiveInt(opts.lines, 200);
  const writers = createWriters();
  const logDir = defaultLogDir();

  let cursor: number | undefined;
  let first = true;
  let activeFile: string | null = null;

  process.once("SIGINT", () => process.exit(0));

  while (true) {
    // Re-resolve the active log file each iteration so midnight rotations and
    // within-day size-cap rolls are detected without restarting the follow loop.
    const resolvedFile = findActiveLogFile(logDir);

    if (!resolvedFile) {
      // No log file written yet — daemon hasn't started or nothing logged.
      if (first) {
        emitNotice(writers, jsonMode, "No log file found yet. Waiting…");
      }
      first = false;
      if (!opts.follow) {
        // Tail-and-exit: nothing to show.
        return;
      }
      await delay(POLL_INTERVAL_MS);
      continue;
    }

    // Detect file change between polls (rotation to new date or new number).
    const fileChanged = activeFile !== null && resolvedFile !== activeFile;
    if (fileChanged) {
      emitNotice(writers, jsonMode, `Active log file changed: ${resolvedFile}`);
      cursor = 0;
    }
    activeFile = resolvedFile;

    const payload = await readLogTail({
      file: resolvedFile,
      cursor,
      limit: lineCount,
      maxBytes: DEFAULT_MAX_BYTES,
    });

    if (first && jsonMode) {
      writers.emitJson({
        type: "meta",
        file: payload.file,
        cursor: payload.cursor,
        size: payload.size,
      });
    }

    for (const line of payload.lines) emitLine(writers, jsonMode, pretty, rich, line);

    if (payload.truncated) emitNotice(writers, jsonMode, "Log tail truncated.");
    // Only show cursor-reset notice when the file itself didn't change — avoids
    // a double notice when filename rotation and cursor-reset occur together.
    if (payload.reset && !fileChanged) emitNotice(writers, jsonMode, "Log cursor reset (file rotated).");

    cursor = payload.cursor;
    first = false;

    if (!opts.follow) return;
    await delay(POLL_INTERVAL_MS);
  }
}
