/**
 * PreferenceStore — generic key/value persistence over the settings_kv table.
 *
 * YAGNI: no namespace registry, no per-key schema validation. Typed accessors
 * are added only for keys consumed by existing features. New preferences get a
 * dedicated typed pair here; callers that need raw access use get/set directly.
 */

import type { Database, Statement } from "bun:sqlite";
import type { Logger } from "pino";

export const TWEET_FILTER_PROMPT_KEY = "tweets.filter_prompt";
export const NEWS_FILTER_PROMPT_KEY = "news.filter_prompt";
export const TWEET_FILTER_ENABLED_KEY = "tweets.filter_enabled";
export const NEWS_FILTER_ENABLED_KEY = "news.filter_enabled";
export const USER_TIMEZONE_KEY = "user.timezone";

interface Stmts {
  get: Statement;
  upsert: Statement;
  delete: Statement;
}

export class PreferenceStore {
  private readonly log: Logger;
  private readonly stmts: Stmts;

  constructor(private readonly db: Database, logger: Logger) {
    this.log = logger;
    this.stmts = {
      get: db.prepare(`SELECT value FROM settings_kv WHERE key = ?`),
      upsert: db.prepare(`
        INSERT INTO settings_kv (key, value, updated_at)
        VALUES (?, ?, unixepoch())
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
      `),
      delete: db.prepare(`DELETE FROM settings_kv WHERE key = ?`),
    };
  }

  get(key: string): string | null {
    const row = this.stmts.get.get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    this.stmts.upsert.run(key, value);
    this.log.debug({ key }, "preference set");
  }

  delete(key: string): void {
    this.stmts.delete.run(key);
    this.log.debug({ key }, "preference deleted");
  }

  getTweetFilterPrompt(): string | null {
    return this.get(TWEET_FILTER_PROMPT_KEY);
  }

  // Empty string clears the override so the default selector reactivates.
  setTweetFilterPrompt(prompt: string): void {
    if (prompt.length === 0) this.delete(TWEET_FILTER_PROMPT_KEY);
    else this.set(TWEET_FILTER_PROMPT_KEY, prompt);
  }

  getNewsFilterPrompt(): string | null {
    return this.get(NEWS_FILTER_PROMPT_KEY);
  }

  setNewsFilterPrompt(prompt: string): void {
    if (prompt.length === 0) this.delete(NEWS_FILTER_PROMPT_KEY);
    else this.set(NEWS_FILTER_PROMPT_KEY, prompt);
  }

  getTimezone(): string | null {
    return this.get(USER_TIMEZONE_KEY);
  }

  // Empty string deletes so the runtime falls back to "UTC" on next read.
  setTimezone(tz: string): void {
    if (tz.length === 0) this.delete(USER_TIMEZONE_KEY);
    else this.set(USER_TIMEZONE_KEY, tz);
  }

  // Absence == OFF: deleting the key restores the default.

  getNewsFilterEnabled(): boolean {
    return this.get(NEWS_FILTER_ENABLED_KEY) === "1";
  }

  setNewsFilterEnabled(enabled: boolean): void {
    if (enabled) this.set(NEWS_FILTER_ENABLED_KEY, "1");
    else this.delete(NEWS_FILTER_ENABLED_KEY);
  }

  getTweetFilterEnabled(): boolean {
    return this.get(TWEET_FILTER_ENABLED_KEY) === "1";
  }

  setTweetFilterEnabled(enabled: boolean): void {
    if (enabled) this.set(TWEET_FILTER_ENABLED_KEY, "1");
    else this.delete(TWEET_FILTER_ENABLED_KEY);
  }
}
