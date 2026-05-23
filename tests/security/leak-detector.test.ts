import { describe, test, expect } from "bun:test";
import { LeakDetector } from "../../src/security/leak-detector.js";

const detector = new LeakDetector();

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function expectDetected(input: string, patternName?: string) {
  const result = detector.scrub(input);
  expect(result.clean).toBe(false);
  if (patternName) {
    expect(result.patterns).toContain(patternName);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Clean input
// ---------------------------------------------------------------------------

describe("LeakDetector — clean input", () => {
  test("returns clean=true for benign string", () => {
    const result = detector.scrub("Hello, world! No secrets here.");
    expect(result.clean).toBe(true);
    expect(result.patterns).toHaveLength(0);
    expect(result.redacted).toBe("Hello, world! No secrets here.");
  });

  test("returns clean=true for empty string", () => {
    const result = detector.scrub("");
    expect(result.clean).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

describe("LeakDetector — Stripe keys", () => {
  // Split prefixes to keep GitHub secret scanner from flagging the test file itself.
  const SK_LIVE = "sk" + "_live";
  const SK_TEST = "sk" + "_test";
  const PK_LIVE = "pk" + "_live";

  test("detects sk_live key", () => {
    const input = `Payment config: ${SK_LIVE}_ABCDEFGHIJKLMNOPQRSTUVWX`;
    const result = expectDetected(input, "stripe");
    expect(result.redacted).not.toContain(`${SK_LIVE}_`);
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects sk_test key", () => {
    const input = `Key: ${SK_TEST}_ABCDEFGHIJKLMNOPQRSTUVWXYZab`;
    const result = expectDetected(input, "stripe");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects pk_live key", () => {
    const input = `pub: ${PK_LIVE}_ABCDEFGHIJKLMNOPQRSTUVWX`;
    const result = expectDetected(input, "stripe");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

describe("LeakDetector — OpenAI keys", () => {
  test("detects OpenAI sk- key (48+ chars)", () => {
    const input = "openai_key=sk-" + "A".repeat(48);
    const result = expectDetected(input, "openai");
    expect(result.redacted).toContain("[REDACTED]");
    expect(result.redacted).not.toContain("sk-" + "A".repeat(48));
  });
});

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

describe("LeakDetector — Anthropic keys", () => {
  test("detects Anthropic sk-ant- key (32+ chars)", () => {
    const input = "key: sk-ant-" + "B".repeat(32);
    const result = expectDetected(input, "anthropic");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Google
// ---------------------------------------------------------------------------

describe("LeakDetector — Google API keys", () => {
  test("detects Google AIza key (35 chars)", () => {
    const input = "GOOGLE_API_KEY=AIza" + "C".repeat(35);
    const result = expectDetected(input, "google");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

describe("LeakDetector — GitHub tokens", () => {
  test("detects gho_ token (36+ chars)", () => {
    const input = "token: gho_" + "D".repeat(36);
    const result = expectDetected(input, "github");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects ghp_ token", () => {
    const input = "GH_TOKEN=ghp_" + "E".repeat(36);
    const result = expectDetected(input, "github");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects github_pat_ token (22+ chars)", () => {
    const input = "pat=github_pat_" + "F".repeat(22);
    const result = expectDetected(input, "github_pat");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------

describe("LeakDetector — AWS credentials", () => {
  test("detects AWS access key (AKIA + 16 chars)", () => {
    const input = "AWS_ACCESS_KEY_ID=AKIA" + "G".repeat(16);
    const result = expectDetected(input, "aws_access_key");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects AWS secret access key", () => {
    const input = "aws_secret_access_key=" + "H".repeat(40);
    const result = expectDetected(input, "aws_secret");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Private key
// ---------------------------------------------------------------------------

describe("LeakDetector — Private keys", () => {
  test("detects RSA private key block", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEowIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const result = expectDetected(input, "private_key");
    expect(result.redacted).toContain("[REDACTED_PRIVATE_KEY]");
    expect(result.redacted).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  test("detects OPENSSH private key block", () => {
    const input = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAA",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const result = expectDetected(input, "private_key");
    expect(result.redacted).toContain("[REDACTED_PRIVATE_KEY]");
  });

  test("detects bare PRIVATE KEY block", () => {
    const input = [
      "-----BEGIN PRIVATE KEY-----",
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const result = expectDetected(input, "private_key");
    expect(result.redacted).toContain("[REDACTED_PRIVATE_KEY]");
  });
});

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

describe("LeakDetector — JWT tokens", () => {
  test("detects JWT token", () => {
    // Valid JWT-like structure: eyJ{10+}.eyJ{10+}.{10+}
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ";
    const sig = "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const input = `Authorization: Bearer ${header}.${payload}.${sig}`;
    const result = expectDetected(input, "jwt");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Database URLs
// ---------------------------------------------------------------------------

describe("LeakDetector — Database URLs", () => {
  test("detects postgres URL with credentials", () => {
    const input = "DATABASE_URL=postgres://user:secret@localhost:5432/mydb";
    const result = expectDetected(input, "db_url");
    expect(result.redacted).toContain("[REDACTED]");
    expect(result.redacted).not.toContain("secret@");
  });

  test("detects postgresql URL", () => {
    const input = "DB=postgresql://admin:pass123@db.example.com/prod";
    const result = expectDetected(input, "db_url");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects mongodb URL with credentials", () => {
    const input = "MONGO_URI=mongodb://root:mongopwd@mongo.example.com:27017/myapp";
    const result = expectDetected(input, "db_url");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects redis URL with credentials", () => {
    const input = "REDIS_URL=redis://default:redispass@cache.example.com:6379";
    const result = expectDetected(input, "db_url");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Generic secrets
// ---------------------------------------------------------------------------

describe("LeakDetector — Generic secrets", () => {
  test("detects api_key assignment", () => {
    const input = "api_key=abcdefghijklmnopqrstu1234567890";
    const result = expectDetected(input, "generic_secret");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects password assignment", () => {
    const input = "password=MyStrongPassword1234567890abc";
    const result = expectDetected(input, "generic_secret");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects secret= assignment", () => {
    const input = "secret=super_secret_value_abcdefghijklmnop";
    const result = expectDetected(input, "generic_secret");
    expect(result.redacted).toContain("[REDACTED]");
  });

  test("detects token= assignment with quoted value", () => {
    const input = `token: 'abcdefghijklmnopqrstuvwxyz1234567890'`;
    const result = expectDetected(input, "generic_secret");
    expect(result.redacted).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Multiple patterns in same string
// ---------------------------------------------------------------------------

describe("LeakDetector — Multiple patterns", () => {
  test("detects multiple secrets in one string", () => {
    const SK_LIVE = "sk" + "_live";
    const input = [
      "openai_key=sk-" + "A".repeat(48),
      `stripe: ${SK_LIVE}_ABCDEFGHIJKLMNOPQRSTUVWX`,
    ].join(" AND ");
    const result = detector.scrub(input);
    expect(result.clean).toBe(false);
    expect(result.patterns.length).toBeGreaterThanOrEqual(2);
    expect(result.patterns).toContain("openai");
    expect(result.patterns).toContain("stripe");
    expect(result.redacted).not.toContain("sk-" + "A".repeat(48));
    expect(result.redacted).not.toContain(`${SK_LIVE}_`);
  });

  test("redacted string contains no original secret values", () => {
    const secretKey = "AKIA" + "X".repeat(16);
    const input = `export AWS_ACCESS_KEY_ID=${secretKey}`;
    const result = detector.scrub(input);
    expect(result.redacted).not.toContain(secretKey);
  });
});
