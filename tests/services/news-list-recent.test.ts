import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { NewsService } from "../../src/services/news.js";
import { WatchlistService } from "../../src/services/watchlist.js";
import { NOOP_LOGGER } from "../../src/logger.js";
import { initDatabase } from "../../src/core/database.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";

/**
 * Tests for NewsService.listRecentRelevant — the read path the observer's
 * news detector uses.
 *
 * Contract:
 *   - ai_relevant = 1
 *   - ai_duplicate_of IS NULL
 *   - dismissed_at IS NULL
 *   - expires_at > unixepoch()
 *   - published_at > sinceTs (strict)
 *   - ordered by published_at DESC, id DESC
 *   - bounded by limit
 *   (no gate on `summary` — on-demand summarization means relevant rows
 *    should reach the observer detector immediately)
 */

let dir: string;
let db: Database;
let service: NewsService;

beforeEach(() => {
  dir = join(tmpdir(), `ghost-test-news-list-recent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  db = initDatabase(join(dir, "test.db"));
  for (const m of DB_MIGRATIONS) m.up(db);
  // WatchlistService is a required dep but listRecentRelevant doesn't touch it.
  const watchlist = new WatchlistService(db);
  service = new NewsService(db, watchlist, undefined, NOOP_LOGGER);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

interface InsertOptions {
  id?: string;
  publishedAt?: number;          // unix seconds
  expiresInSec?: number;         // expires_at = now + this
  summary?: string | null;
  aiRelevant?: 0 | 1 | null;
  aiDuplicateOf?: string | null;
  dismissedAt?: number | null;
  coins?: string[];
  importance?: "urgent" | "important" | "reference";
}

function insert(opts: InsertOptions = {}): string {
  const id = opts.id ?? crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const published = opts.publishedAt ?? now;
  const expiresAt = now + (opts.expiresInSec ?? 86_400);
  const stmt = db.prepare(`
    INSERT INTO articles
      (id, source_id, external_id, url, title, description, image_url, coins,
       importance, published_at, fetched_at, expires_at, summary,
       ai_relevant, ai_duplicate_of, dismissed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id,
    "coindesk",
    `ext-${id}`,
    `https://example.com/${id}`,
    `Title for ${id}`,
    "description",
    null,
    JSON.stringify(opts.coins ?? ["BTC"]),
    opts.importance ?? "important",
    published,
    now,
    expiresAt,
    opts.summary === undefined ? "summary text" : opts.summary,
    opts.aiRelevant === undefined ? 1 : opts.aiRelevant,
    opts.aiDuplicateOf ?? null,
    opts.dismissedAt ?? null,
  );
  return id;
}

describe("NewsService.listRecentRelevant", () => {
  test("empty DB → empty array", () => {
    expect(service.listRecentRelevant(0)).toEqual([]);
  });

  test("returns relevant + summarized articles published after sinceTs", () => {
    const now = Math.floor(Date.now() / 1000);
    const newId = insert({ publishedAt: now });
    const oldId = insert({ publishedAt: now - 3600 });
    // sinceTs cuts off `old` (strict >)
    const out = service.listRecentRelevant(now - 1800);
    expect(out.map((a) => a.id)).toEqual([newId]);
    expect(out[0].id).not.toBe(oldId);
  });

  test("does NOT gate on summary — observer feeds both summarized and unsummarized rows", () => {
    // Summarization is on-demand now, so listRecentRelevant must surface
    // articles regardless of whether the user has ever clicked Summarize.
    // The observer's news detector falls back to `description` when
    // `summary` is null (see src/observer/detect/news.ts).
    insert({ summary: null });
    insert({ summary: "ready" });
    const out = service.listRecentRelevant(0);
    expect(out).toHaveLength(2);
  });

  test("excludes articles where ai_relevant != 1", () => {
    insert({ aiRelevant: 0 });
    insert({ aiRelevant: null });
    const good = insert({ aiRelevant: 1 });
    const out = service.listRecentRelevant(0);
    expect(out.map((a) => a.id)).toEqual([good]);
  });

  test("excludes duplicates (ai_duplicate_of set) and dismissed articles", () => {
    insert({ aiDuplicateOf: "other-id" });
    insert({ dismissedAt: Math.floor(Date.now() / 1000) });
    const good = insert();
    const out = service.listRecentRelevant(0);
    expect(out.map((a) => a.id)).toEqual([good]);
  });

  test("excludes expired articles", () => {
    insert({ expiresInSec: -1 });    // already expired
    const good = insert({ expiresInSec: 3600 });
    const out = service.listRecentRelevant(0);
    expect(out.map((a) => a.id)).toEqual([good]);
  });

  test("orders newest first by published_at DESC, id DESC", () => {
    const now = Math.floor(Date.now() / 1000);
    const oldest = insert({ id: "a-old", publishedAt: now - 200 });
    const middle = insert({ id: "b-mid", publishedAt: now - 100 });
    const newest = insert({ id: "c-new", publishedAt: now });
    const out = service.listRecentRelevant(0);
    expect(out.map((a) => a.id)).toEqual([newest, middle, oldest]);
  });

  test("limit caps result set", () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 5; i++) insert({ publishedAt: now - i });
    expect(service.listRecentRelevant(0, 3)).toHaveLength(3);
    expect(service.listRecentRelevant(0, 1)).toHaveLength(1);
    expect(service.listRecentRelevant(0).length).toBeLessThanOrEqual(20);
  });

  test("does NOT filter by coins — judge skill cross-references at LLM layer", () => {
    insert({ coins: ["BTC"] });
    insert({ coins: ["ETH"] });
    insert({ coins: [] });   // no tag at all
    const out = service.listRecentRelevant(0);
    expect(out).toHaveLength(3);
  });
});
