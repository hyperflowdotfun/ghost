import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CronService } from "../../src/scheduler/service.js";
import {
  buildBuiltInJobs,
  BRIEFING_PROMPT,
  RECAP_PROMPT,
  detectUserTimezone,
  type DefaultJobSpec,
} from "../../src/scheduler/defaults.js";
import { DB_MIGRATIONS } from "../../src/core/migrations/registry.js";

function makeDb(): Database {
  const db = new Database(":memory:");
  // CronService only needs cron_jobs — run that migration directly.
  const m = DB_MIGRATIONS.find((x) => x.version === 10)!;
  (m.up as (db: Database) => void)(db);
  return db;
}

// ---------------------------------------------------------------------------
// detectUserTimezone
// ---------------------------------------------------------------------------

describe("detectUserTimezone", () => {
  test("returns a non-empty string under normal conditions", () => {
    const tz = detectUserTimezone();
    expect(typeof tz).toBe("string");
    expect(tz.length).toBeGreaterThan(0);
  });

  test("falls back to UTC when Intl.DateTimeFormat throws", () => {
    const original = globalThis.Intl;
    try {
      globalThis.Intl = {
        ...original,
        DateTimeFormat: (() => { throw new Error("no Intl support"); }) as unknown as typeof Intl.DateTimeFormat,
      };
      const tz = detectUserTimezone();
      expect(tz).toBe("UTC");
    } finally {
      globalThis.Intl = original;
    }
  });

  test("falls back to UTC when resolvedOptions().timeZone is empty", () => {
    const original = globalThis.Intl;
    try {
      globalThis.Intl = {
        ...original,
        DateTimeFormat: (() => ({
          resolvedOptions: () => ({ timeZone: "" } as Intl.ResolvedDateTimeFormatOptions),
          format: () => "",
          formatToParts: () => [],
          formatRange: () => "",
          formatRangeToParts: () => [],
        })) as unknown as typeof Intl.DateTimeFormat,
      };
      const tz = detectUserTimezone();
      expect(tz).toBe("UTC");
    } finally {
      globalThis.Intl = original;
    }
  });
});

// ---------------------------------------------------------------------------
// buildBuiltInJobs
// ---------------------------------------------------------------------------

describe("buildBuiltInJobs", () => {
  test("returns two jobs", () => {
    const jobs = buildBuiltInJobs("Asia/Tokyo");
    expect(jobs).toHaveLength(2);
  });

  test("both jobs carry the supplied timezone", () => {
    const jobs = buildBuiltInJobs("America/New_York");
    for (const j of jobs) {
      expect(j.schedule.tz).toBe("America/New_York");
    }
  });

  test("first job is morning-briefing at 08:00", () => {
    const jobs = buildBuiltInJobs("UTC");
    expect(jobs[0]!.name).toBe("morning-briefing");
    expect(jobs[0]!.schedule.expr).toBe("0 8 * * *");
  });

  test("second job is evening-recap at 21:00", () => {
    const jobs = buildBuiltInJobs("UTC");
    expect(jobs[1]!.name).toBe("evening-recap");
    expect(jobs[1]!.schedule.expr).toBe("0 21 * * *");
  });
});

// ---------------------------------------------------------------------------
// buildBuiltInJobs shape (host-TZ snapshot used here matches production path)
// ---------------------------------------------------------------------------

describe("buildBuiltInJobs — shape", () => {
  const jobs = buildBuiltInJobs(detectUserTimezone());

  test("first entry is morning-briefing", () => {
    expect(jobs[0]!.name).toBe("morning-briefing");
  });

  test("morning-briefing uses BRIEFING_PROMPT", () => {
    expect(jobs[0]!.message).toBe(BRIEFING_PROMPT);
  });

  test("BRIEFING_PROMPT is non-empty and mentions morning briefing", () => {
    expect(BRIEFING_PROMPT.length).toBeGreaterThan(0);
    expect(BRIEFING_PROMPT.toLowerCase()).toContain("morning briefing");
  });

  test("morning-briefing schedule is cron at 08:00", () => {
    const spec = jobs[0]!;
    expect(spec.schedule.kind).toBe("cron");
    expect(spec.schedule.expr).toBe("0 8 * * *");
    expect(spec.schedule.tz).toBeTruthy();
  });

  test("morning-briefing has deliver=true", () => {
    expect(jobs[0]!.deliver).toBe(true);
  });

  test("second entry is evening-recap", () => {
    expect(jobs[1]!.name).toBe("evening-recap");
  });

  test("evening-recap uses RECAP_PROMPT", () => {
    expect(jobs[1]!.message).toBe(RECAP_PROMPT);
  });

  test("RECAP_PROMPT is non-empty and mentions recap", () => {
    expect(RECAP_PROMPT.length).toBeGreaterThan(0);
    expect(RECAP_PROMPT.toLowerCase()).toContain("recap");
  });

  test("evening-recap schedule is cron at 21:00", () => {
    const spec = jobs[1]!;
    expect(spec.schedule.kind).toBe("cron");
    expect(spec.schedule.expr).toBe("0 21 * * *");
    expect(spec.schedule.tz).toBeTruthy();
  });

  test("evening-recap has deliver=true", () => {
    expect(jobs[1]!.deliver).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CronService.start({ defaults }) — seeding behaviour
// ---------------------------------------------------------------------------

describe("CronService seeding", () => {
  test("seeds morning-briefing on first start", () => {
    const svc = new CronService(makeDb());
    svc.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const briefing = svc.listJobs(true).find((j) => j.name === "morning-briefing");
    expect(briefing).toBeDefined();
    expect(briefing!.enabled).toBe(true);
    svc.stop();
  });

  test("seeding is idempotent — stop/start does not duplicate", () => {
    const db = makeDb();
    const svc1 = new CronService(db);
    svc1.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    svc1.stop();

    const svc2 = new CronService(db);
    svc2.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const jobs = svc2.listJobs(true).filter((j) => j.name === "morning-briefing");
    expect(jobs).toHaveLength(1);
    svc2.stop();
  });

  test("pre-existing user-customised morning-briefing is preserved", () => {
    const db = makeDb();
    const svc1 = new CronService(db);
    svc1.start({ defaults: [] });
    svc1.addJob({
      name: "morning-briefing",
      schedule: { kind: "cron", expr: "30 9 * * *", tz: "Asia/Tokyo" },
      message: "custom briefing prompt",
    });
    svc1.stop();

    const svc2 = new CronService(db);
    svc2.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const briefings = svc2.listJobs(true).filter((j) => j.name === "morning-briefing");
    expect(briefings).toHaveLength(1);
    expect(briefings[0]!.schedule.expr).toBe("30 9 * * *");
    expect(briefings[0]!.schedule.tz).toBe("Asia/Tokyo");
    svc2.stop();
  });

  test("start with empty defaults seeds nothing", () => {
    const svc = new CronService(makeDb());
    svc.start({ defaults: [] });
    expect(svc.listJobs(true)).toHaveLength(0);
    svc.stop();
  });

  test("custom DefaultJobSpec is seeded correctly", () => {
    const custom: DefaultJobSpec = {
      name: "test-job",
      schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
      message: "test message",
      deliver: true,
    };
    const svc = new CronService(makeDb());
    svc.start({ defaults: [custom] });
    const job = svc.listJobs(true).find((j) => j.name === "test-job");
    expect(job).toBeDefined();
    expect(job!.payload.message).toBe("test message");
    svc.stop();
  });

  test("seeds evening-recap on first start", () => {
    const svc = new CronService(makeDb());
    svc.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const recap = svc.listJobs(true).find((j) => j.name === "evening-recap");
    expect(recap).toBeDefined();
    expect(recap!.enabled).toBe(true);
    expect(recap!.schedule.expr).toBe("0 21 * * *");
    svc.stop();
  });

  test("seeding evening-recap is idempotent", () => {
    const db = makeDb();
    const svc1 = new CronService(db);
    svc1.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    svc1.stop();

    const svc2 = new CronService(db);
    svc2.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const jobs = svc2.listJobs(true).filter((j) => j.name === "evening-recap");
    expect(jobs).toHaveLength(1);
    svc2.stop();
  });

  test("disabled morning-briefing is not re-enabled on restart", () => {
    const db = makeDb();
    const svc1 = new CronService(db);
    svc1.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const job = svc1.listJobs(true).find((j) => j.name === "morning-briefing");
    expect(job).toBeDefined();
    svc1.enableJob(job!.id, false);
    svc1.stop();

    const svc2 = new CronService(db);
    svc2.start({ defaults: buildBuiltInJobs(detectUserTimezone()) });
    const briefings = svc2.listJobs(true).filter((j) => j.name === "morning-briefing");
    expect(briefings).toHaveLength(1);
    expect(briefings[0]!.enabled).toBe(false);
    svc2.stop();
  });
});

// ---------------------------------------------------------------------------
// BRIEFING_PROMPT / RECAP_PROMPT — language anchor + context anchor
// ---------------------------------------------------------------------------

describe("BRIEFING_PROMPT", () => {
  test("instructs the agent to start by calling ghost_chat_history", () => {
    expect(BRIEFING_PROMPT).toContain("ghost_chat_history");
    // Strong wording — the model must call the tool, not "consider" calling it.
    expect(BRIEFING_PROMPT.toLowerCase()).toMatch(/start by calling|call .* first/);
  });

  test("tells the agent to match the trader's language from chat history", () => {
    expect(BRIEFING_PROMPT.toLowerCase()).toContain("language");
  });

  test("provides an empty-history fallback (reply in English)", () => {
    expect(BRIEFING_PROMPT.toLowerCase()).toContain("english");
  });

  test("does not hardcode a message count — LLM decides", () => {
    // Tool schema is 1-200. Prompt must NOT pin a specific count like
    // "messages=10" because briefing vs recap need different windows.
    expect(BRIEFING_PROMPT).not.toMatch(/messages\s*=\s*\d/);
  });
});

describe("RECAP_PROMPT", () => {
  test("instructs the agent to start by calling ghost_chat_history", () => {
    expect(RECAP_PROMPT).toContain("ghost_chat_history");
    expect(RECAP_PROMPT.toLowerCase()).toMatch(/start by calling|call .* first/);
  });

  test("tells the agent to match the trader's language from chat history", () => {
    expect(RECAP_PROMPT.toLowerCase()).toContain("language");
  });

  test("provides an empty-history fallback (reply in English)", () => {
    expect(RECAP_PROMPT.toLowerCase()).toContain("english");
  });

  test("does not hardcode a message count — LLM decides", () => {
    expect(RECAP_PROMPT).not.toMatch(/messages\s*=\s*\d/);
  });
});
