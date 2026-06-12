/**
 * Unit tests for HyperliquidClient.fetchInfo — per-request timeout guard.
 *
 * fetchInfo previously called bare fetch() with no AbortSignal, so a wedged
 * socket would hang the await forever and (because every read RPC flows
 * through here) hold the orchestrator's session lock, freezing all chat.
 * These tests verify the fetch now carries an AbortSignal and that an aborted
 * request propagates as a rejection rather than hanging.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HyperliquidClient } from "../../src/services/live/client";

const noopLogger = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  child: () => noopLogger,
} as any;

function callFetchInfo(client: HyperliquidClient, type: string): Promise<unknown> {
  return (client as any).fetchInfo(type, {}, 0);
}

describe("HyperliquidClient fetchInfo — timeout guard", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("passes an AbortSignal to fetch (timeout is wired)", async () => {
    let seenSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const client = new HyperliquidClient(undefined, noopLogger);
    await callFetchInfo(client, "meta");

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects (does not hang) when the request times out", async () => {
    // Shrink the timeout so the test settles in ms, not 10s.
    const originalTimeout = AbortSignal.timeout;
    (AbortSignal as any).timeout = (_ms: number) => originalTimeout(20);

    // fetch never resolves on its own — only the abort signal settles it,
    // proving the timeout (not the upstream) is what unblocks the await.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("timed out", "TimeoutError")),
        );
      })) as unknown as typeof fetch;

    try {
      const client = new HyperliquidClient(undefined, noopLogger);
      await expect(callFetchInfo(client, "clearinghouseState")).rejects.toThrow();
    } finally {
      (AbortSignal as any).timeout = originalTimeout;
    }
  });
});
