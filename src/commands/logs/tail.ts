import fs from "node:fs/promises";

export const DEFAULT_LIMIT = 200;
export const DEFAULT_MAX_BYTES = 250_000;
export const MAX_LIMIT = 5000;
export const MAX_BYTES = 1_000_000;

export type LogTailPayload = {
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
};

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

export async function readLogTail(params: {
  file: string;
  cursor?: number;
  limit?: number;
  maxBytes?: number;
}): Promise<LogTailPayload> {
  const file = params.file;
  const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
  const maxBytes = clamp(params.maxBytes ?? DEFAULT_MAX_BYTES, 1, MAX_BYTES);

  const stat = await fs.stat(file).catch(() => null);
  if (!stat) {
    return { file, cursor: 0, size: 0, lines: [], truncated: false, reset: false };
  }

  const size = stat.size;
  let cursor =
    typeof params.cursor === "number" && Number.isFinite(params.cursor)
      ? Math.max(0, Math.floor(params.cursor))
      : undefined;
  let reset = false;
  let truncated = false;
  let start = 0;

  if (cursor !== undefined) {
    if (cursor > size) {
      // File rotated or shrank — re-seed from tail.
      reset = true;
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        // Caller lagged further than maxBytes — drop the gap, re-seed.
        reset = true;
        truncated = true;
        start = Math.max(0, size - maxBytes);
      }
    }
  } else {
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  }

  if (size === 0 || size <= start) {
    return { file, cursor: size, size, lines: [], truncated, reset };
  }

  const handle = await fs.open(file, "r");
  try {
    // Read 1 byte before `start` to know whether we landed mid-line.
    // If the prefix byte is not "\n", drop the first split element — it is a
    // partial line owned by the previous chunk.
    let prefix = "";
    if (start > 0) {
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }

    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");
    if (start > 0 && prefix !== "\n") {
      lines = lines.slice(1);
    }
    // Trailing empty element from a final newline — drop it.
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }

    return { file, cursor: size, size, lines, truncated, reset };
  } finally {
    await handle.close();
  }
}
