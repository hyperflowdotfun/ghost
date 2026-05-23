import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Initialize the Ghost SQLite database at the given path.
 * Creates parent directories, opens in WAL mode, sets performance pragmas,
 * and creates all tables idempotently.
 */
export function initDatabase(dbPath: string): Database {
  // Ensure parent directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Do NOT use { strict: true } — conflicts with DEFAULT value expressions
  const db = new Database(dbPath);

  // Performance pragmas. busy_timeout MUST be set first — the WAL pragma
  // below can itself raise SQLITE_BUSY when another process holds the
  // reserved lock, and the default busy_timeout in bun:sqlite is 0.
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA mmap_size = 8388608");   // 8MB
  db.run("PRAGMA cache_size = -2048");    // 2MB
  db.run("PRAGMA temp_store = MEMORY");

  // ---------------------------------------------------------------------------
  // Core tables
  // ---------------------------------------------------------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS response_cache (
      cache_key    TEXT PRIMARY KEY,
      response     TEXT NOT NULL,
      model        TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at   INTEGER
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS cost_records (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL DEFAULT '',
      provider      TEXT NOT NULL,
      model         TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL NOT NULL DEFAULT 0.0,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_cost_records_session ON cost_records (session_id);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_cost_records_created ON cost_records (created_at);
  `);

  // ---------------------------------------------------------------------------
  // Device + gateway tables
  // ---------------------------------------------------------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      platform     TEXT NOT NULL DEFAULT '',
      paired_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      last_seen    INTEGER NOT NULL DEFAULT (unixepoch()),
      public_key   TEXT,
      metadata     TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS gateway_sessions (
      id           TEXT PRIMARY KEY,
      device_id    TEXT REFERENCES devices(id),
      token        TEXT NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at   INTEGER,
      last_active  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // ---------------------------------------------------------------------------
  // Trading state tables
  // ---------------------------------------------------------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      symbol       TEXT PRIMARY KEY,
      notes        TEXT,
      added_at     INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS alerts (
      id            TEXT PRIMARY KEY,
      symbol        TEXT NOT NULL,
      condition     TEXT NOT NULL CHECK (condition IN ('above', 'below')),
      price         REAL NOT NULL,
      note          TEXT,
      triggered_at  INTEGER,
      created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      created_price REAL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_alerts_active_symbol
          ON alerts (symbol) WHERE triggered_at IS NULL`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS ux_alerts_active
          ON alerts (symbol, condition, price) WHERE triggered_at IS NULL`);

  db.run(`
    CREATE TABLE IF NOT EXISTS wallets (
      address            TEXT PRIMARY KEY,
      encrypted_key      TEXT NOT NULL DEFAULT '',
      testnet            INTEGER NOT NULL DEFAULT 0,
      is_default         INTEGER NOT NULL DEFAULT 0,
      source             TEXT NOT NULL DEFAULT 'chat',
      status             TEXT NOT NULL DEFAULT 'watch',
      api_wallet_address TEXT,
      added_at           INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // ---------------------------------------------------------------------------
  // News tables
  // ---------------------------------------------------------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS news_sources (
      source_id  TEXT PRIMARY KEY,
      name       TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 0,
      api_key    TEXT,
      custom_url TEXT,
      added_at   INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS articles (
      id              TEXT PRIMARY KEY,
      source_id       TEXT NOT NULL,
      external_id     TEXT NOT NULL,
      url             TEXT NOT NULL,
      title           TEXT NOT NULL,
      snippet         TEXT NOT NULL DEFAULT '',
      image_url       TEXT,
      coins           TEXT NOT NULL DEFAULT '[]',
      importance      TEXT NOT NULL DEFAULT 'reference' CHECK (importance IN ('urgent','important','reference')),
      published_at    INTEGER NOT NULL,
      fetched_at      INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at      INTEGER NOT NULL,
      full_summary    TEXT,
      detailed_summary TEXT,
      ai_relevant     INTEGER DEFAULT NULL,
      ai_duplicate_of TEXT DEFAULT NULL,
      dismissed_at    INTEGER DEFAULT NULL,
      UNIQUE(source_id, external_id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_articles_published ON articles (published_at DESC, id DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_articles_importance ON articles (importance)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_articles_expires ON articles (expires_at)`);

  // Per-(chat, scope) tracking of which articles were already delivered via
  // /news so the next call can show different ones. `scope` is `global` or
  // `symbol:<SYM>` so the user can drain `/news` and `/news BTC`
  // independently. SQLite FKs are off (see PRAGMA at top of file), so rows
  // are pruned alongside articles in NewsService.pruneExpired().
  db.run(`
    CREATE TABLE IF NOT EXISTS news_shown (
      chat_id    TEXT NOT NULL,
      scope      TEXT NOT NULL,
      article_id TEXT NOT NULL,
      shown_at   INTEGER NOT NULL,
      PRIMARY KEY (chat_id, scope, article_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_news_shown_lookup ON news_shown (chat_id, scope)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS tweets (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL,
      tweet_id      TEXT NOT NULL,
      url           TEXT,
      content       TEXT NOT NULL DEFAULT '',
      image_url     TEXT,
      coins         TEXT NOT NULL DEFAULT '[]',
      stats_json    TEXT,
      published_at  INTEGER NOT NULL,
      fetched_at    INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at    INTEGER NOT NULL,
      dismissed_at  INTEGER DEFAULT NULL,
      display_name  TEXT,
      avatar_url    TEXT,
      UNIQUE(username, tweet_id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_tweets_published ON tweets (published_at DESC, id DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tweets_expires ON tweets (expires_at)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_tweets_username ON tweets (username)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS x_follows (
      username     TEXT PRIMARY KEY,
      user_id      TEXT DEFAULT NULL,
      display_name TEXT DEFAULT NULL,
      added_at     INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // ---------------------------------------------------------------------------
  // Skill management tables
  // ---------------------------------------------------------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS skill_states (
      name       TEXT PRIMARY KEY,
      source     TEXT NOT NULL CHECK (source IN ('builtin', 'workspace')),
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ---------------------------------------------------------------------------
  // Pairing tables
  // ---------------------------------------------------------------------------

  db.run(`
    CREATE TABLE IF NOT EXISTS channel_allowlist (
      channel        TEXT NOT NULL,
      identity       TEXT NOT NULL,
      identity_kind  TEXT NOT NULL,
      display_name   TEXT,
      added_at       INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      PRIMARY KEY (channel, identity)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS pairing_requests (
      channel       TEXT NOT NULL,
      sender_id     TEXT NOT NULL,
      code          TEXT NOT NULL UNIQUE,
      username      TEXT,
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      PRIMARY KEY (channel, sender_id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_requests(expires_at)`);

  return db;
}
