import type { Database } from "bun:sqlite";
import type { Config } from "../../config/schema.js";

export interface Migration<T> {
  version: number;
  label: string;
  /** May be sync or async — runners `await` the result. */
  up: (ctx: T) => void | Promise<void>;
}

const baselineDbMigration: Migration<Database> = {
  version: 1,
  label: "baseline",
  up: () => {
    /* no-op: tables are created idempotently by initDatabase */
  },
};

// Kept even though v3 drops the table — v2-only installs must still land
// on a valid schema before v3 runs.
const proactiveCooldownsMigration: Migration<Database> = {
  version: 2,
  label: "proactive-cooldowns",
  up: (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS proactive_cooldowns (
        topic         TEXT    NOT NULL,
        symbol        TEXT    NOT NULL,
        kind          TEXT    NOT NULL DEFAULT '',
        last_fired_at INTEGER NOT NULL,
        PRIMARY KEY (topic, symbol, kind)
      );
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_proactive_cooldowns_fired ON proactive_cooldowns(last_fired_at);`);
  },
};

const dropProactiveCooldownsMigration: Migration<Database> = {
  version: 3,
  label: "drop-proactive-cooldowns",
  up: (db) => {
    db.run("DROP TABLE IF EXISTS proactive_cooldowns");
  },
};

const alertsKindPayloadMigration: Migration<Database> = {
  version: 4,
  label: "alerts-kind-payload",
  up: (db) => {
    db.run(`ALTER TABLE alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'price_target'`);
    db.run(`ALTER TABLE alerts ADD COLUMN payload TEXT`);
    db.run(
      `CREATE INDEX IF NOT EXISTS idx_alerts_kind_symbol
       ON alerts (kind, symbol) WHERE triggered_at IS NOT NULL`,
    );
  },
};

const addSettingsKvMigration: Migration<Database> = {
  version: 5,
  label: "add_settings_kv",
  up: (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS settings_kv (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  },
};

const addTweetsAiRelevantMigration: Migration<Database> = {
  version: 6,
  label: "add_tweets_ai_relevant",
  up: (db) => {
    db.run(`ALTER TABLE tweets ADD COLUMN ai_relevant INTEGER DEFAULT NULL`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tweets_ai_relevant ON tweets (ai_relevant)`);
  },
};

const addObserverStateMigration: Migration<Database> = {
  version: 7,
  label: "add_observer_state",
  up: (db) => {
    // Single-row-per-key JSON store for the unified observer loop. Holds
    // last-tick position/order snapshot, last-seen fill timestamp, and the
    // anti-spam liquidation-risk flag set (reset when a position closes).
    db.run(`
      CREATE TABLE IF NOT EXISTS observer_state (
        key         TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);
  },
};

// v8: Split the legacy `alerts` table into two cleanly-separated tables.
//
// The legacy schema mixed two unrelated lifecycles in one row:
//   - "user rule"   — a price target the user asked Ghost to watch
//   - "notification"— a fired event the bell-dropdown should display
// and abused `condition: "below"`, `price: 0` sentinels to shoehorn
// non-price kinds (liquidation, tp_hit, position_closed, ...) into the
// price-target schema.
//
// This migration drops the table and recreates as two domain tables.
// DESTRUCTIVE: existing alerts + fired history are deleted. Acceptable
// because the unified-observer branch is pre-release; no production
// installs.
const splitAlertsMigration: Migration<Database> = {
  version: 8,
  label: "split_alerts_into_rules_and_notifications",
  up: (db) => {
    db.run("DROP INDEX IF EXISTS ux_alerts_active");
    db.run("DROP INDEX IF EXISTS idx_alerts_active_symbol");
    db.run("DROP INDEX IF EXISTS idx_alerts_kind_symbol");
    db.run("DROP TABLE IF EXISTS alerts");

    // User-entered price-target rules. `fired_at` marks the rule as
    // consumed — kept in-table for short-term history; old rows are
    // archived/pruned outside this migration.
    db.run(`
      CREATE TABLE alert_rules (
        id            TEXT PRIMARY KEY,
        symbol        TEXT NOT NULL,
        condition     TEXT NOT NULL CHECK (condition IN ('above', 'below')),
        price         REAL NOT NULL,
        note          TEXT,
        created_price REAL,
        created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
        fired_at      INTEGER
      )
    `);
    db.run(`
      CREATE INDEX idx_alert_rules_active_symbol
        ON alert_rules (symbol) WHERE fired_at IS NULL
    `);
    db.run(`
      CREATE UNIQUE INDEX ux_alert_rules_active
        ON alert_rules (symbol, condition, price) WHERE fired_at IS NULL
    `);

    // Fired event log. Powers the bell-dropdown + survives restart.
    // `kind` discriminates rendering (price_target / liquidation_risk /
    // position_closed / tp_hit / sl_hit / order_filled / ...).
    // `payload` is opaque JSON shaped per kind. `body` is the user-facing
    // text composed by the judge skill at fire time.
    db.run(`
      CREATE TABLE notifications (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        symbol       TEXT,
        body         TEXT NOT NULL,
        payload      TEXT,
        ts           INTEGER NOT NULL DEFAULT (unixepoch()),
        dismissed_at INTEGER
      )
    `);
    db.run(`CREATE INDEX idx_notifications_ts ON notifications (ts DESC)`);
    db.run(`
      CREATE INDEX idx_notifications_active
        ON notifications (ts DESC) WHERE dismissed_at IS NULL
    `);
  },
};

// v9: Add per-account `enabled` flag and `source` marker to `x_follows` so the
// web "Manage follower" modal can mute individual accounts without unfollowing,
// and so bulk re-toggle of the X.com Following list can distinguish auto-imported
// rows (`source = 'following'`) from manually added ones (`source = 'manual'`).
// Existing rows pre-date the multi-select UX — backfill them as enabled + manual
// so behaviour is unchanged until the user touches the new modal.
const addXFollowsEnabledSourceMigration: Migration<Database> = {
  version: 9,
  label: "add_x_follows_enabled_source",
  up: (db) => {
    db.run(`ALTER TABLE x_follows ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
    db.run(
      `ALTER TABLE x_follows ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'
         CHECK (source IN ('following', 'manual'))`,
    );
    // Tracks an explicit per-user disable. Survives bulk re-toggle of the
    // X.com Following list — without it, flipping bulk ON would clobber the
    // user's individual unchecks recorded while bulk was OFF.
    db.run(`ALTER TABLE x_follows ADD COLUMN user_disabled INTEGER NOT NULL DEFAULT 0`);
    // Explicit backfill — column DEFAULT only applies to new inserts on some
    // SQLite versions when added via ALTER. Pre-existing rows are manual.
    db.run(`UPDATE x_follows SET enabled = 1 WHERE enabled IS NULL`);
    db.run(`UPDATE x_follows SET source = 'manual' WHERE source IS NULL`);
    db.run(`UPDATE x_follows SET user_disabled = 0 WHERE user_disabled IS NULL`);
  },
};

const addCronJobsMigration: Migration<Database> = {
  version: 10,
  label: "add_cron_jobs",
  up: (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id                TEXT    PRIMARY KEY,
        name              TEXT    NOT NULL,
        enabled           INTEGER NOT NULL DEFAULT 1,
        schedule_kind     TEXT    NOT NULL,
        schedule_at_ms    INTEGER,
        schedule_every_ms INTEGER,
        schedule_expr     TEXT,
        schedule_tz       TEXT,
        payload_kind      TEXT    NOT NULL DEFAULT 'agent_turn',
        payload_message   TEXT    NOT NULL,
        payload_deliver   INTEGER NOT NULL DEFAULT 1,
        payload_channel   TEXT,
        payload_to        TEXT,
        next_run_at_ms    INTEGER,
        last_run_at_ms    INTEGER,
        last_status       TEXT,
        last_error        TEXT,
        run_history       TEXT    NOT NULL DEFAULT '[]',
        created_at_ms     INTEGER NOT NULL,
        updated_at_ms     INTEGER NOT NULL,
        delete_after_run  INTEGER NOT NULL DEFAULT 0
      );
    `);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cron_jobs_name ON cron_jobs(name);`);
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled_next
        ON cron_jobs(enabled, next_run_at_ms) WHERE enabled = 1;
    `);
  },
};

const reshapeArticlesMigration: Migration<Database> = {
  version: 11,
  label: "article_schema_cleanup",
  up: (db) => {
    db.run(`ALTER TABLE articles RENAME COLUMN snippet TO description`);
    db.run(`ALTER TABLE articles RENAME COLUMN full_summary TO summary`);
    db.run(`ALTER TABLE articles DROP COLUMN detailed_summary`);
    db.run(`ALTER TABLE articles ADD COLUMN body TEXT`);
  },
};

export const DB_MIGRATIONS: ReadonlyArray<Migration<Database>> = [
  baselineDbMigration,
  proactiveCooldownsMigration,
  dropProactiveCooldownsMigration,
  alertsKindPayloadMigration,
  addSettingsKvMigration,
  addTweetsAiRelevantMigration,
  addObserverStateMigration,
  splitAlertsMigration,
  addXFollowsEnabledSourceMigration,
  addCronJobsMigration,
  reshapeArticlesMigration,
];

// ---------------------------------------------------------------------------
// Config migrations
// ---------------------------------------------------------------------------
//
// Zod's default `.strip()` removes unknown keys at parse time, so pure field
// deletions are handled transparently and do not need migrations. Add entries
// here only when (a) renaming a field requires lifting old values, (b)
// reshaping nested data that Zod cannot transparently coerce, or (c) a nested
// block must be explicitly deleted before Zod sees the config.

export const CONFIG_MIGRATIONS: ReadonlyArray<Migration<Config>> = [];

export function assertUniqueVersions<T>(
  sorted: ReadonlyArray<Migration<T>>,
): void {
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.version === sorted[i - 1]!.version) {
      throw new Error(`Duplicate migration version: ${sorted[i]!.version}`);
    }
  }
}

// Pre-check before any up() runs so a malformed registry cannot mutate
// storage before being rejected.
export function assertValidVersions<T>(
  sorted: ReadonlyArray<Migration<T>>,
): void {
  for (const m of sorted) {
    if (!Number.isInteger(m.version) || m.version <= 0) {
      throw new Error(`Invalid migration version: ${m.version}`);
    }
  }
}
