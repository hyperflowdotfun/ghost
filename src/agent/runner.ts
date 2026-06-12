/**
 * Runner — serializes all calls to the shared `taskAgent`.
 *
 * Pi-agent-core's `Agent` is stateful: `prompt()` reads and writes
 * `state.systemPrompt` and `state.messages`. Without serialization,
 * concurrent callers (background summarize/evaluate loops + gateway HTTP
 * endpoints) silently corrupt each other's results — evaluate parses a
 * summary string, gateway returns mixed text, etc.
 *
 * The mutex is a private `inFlight` promise chain. Each call owns the agent
 * for the duration of its `prompt()` call. The chain never poisons — a failed
 * call's rejection is caught before it becomes the chain anchor, so subsequent
 * callers still run.
 *
 * Text extraction: after `prompt()` resolves, walk `state.messages` from the
 * end and return the last assistant turn's text content. Unlike Orchestrator
 * the Runner doesn't forward events anywhere, so streaming via `subscribe`
 * would just be extra machinery.
 *
 * `persist: true` appends the agent's final text as an assistant message to
 * the canonical session (MAIN_SESSION_KEY). Cron delivery uses this
 * so scheduled responses appear in the user's main chat history.
 */

import type { Agent } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import type { SessionManager } from "../session/manager.js";
import { MAIN_SESSION_KEY } from "../session/session.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isOriginAware } from "../tools/context-aware.js";

/**
 * Default ceiling for a single taskAgent run. Without it, a stalled LLM
 * stream or a tool that never returns would hang `agent.prompt` forever and,
 * because the Runner serializes on one mutex, freeze every later background
 * call (consolidation, news summarize, cron delivery) behind it. Generous
 * enough never to clip a legitimate multi-tool run.
 */
const RUNNER_CALL_TIMEOUT_MS = 180_000;

export interface RunnerCallOpts {
  systemPrompt: string;
  message: string;
  /**
   * When true, append the agent's final text as an assistant message to
   * the canonical session (MAIN_SESSION_KEY). News/summarize callers
   * omit (default false); cron delivery passes true so the scheduled response
   * appears in the user's main chat history.
   */
  persist?: boolean;
  /** Override the per-call timeout. Defaults to RUNNER_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
}

interface ContentBlock {
  type: string;
  text?: unknown;
}

export class Runner {
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly agent: Agent,
    private readonly sessionManager: SessionManager,
    private readonly registry: ToolRegistry,
    private readonly logger: Logger,
  ) {}

  /**
   * Queue a call to the shared taskAgent.
   *
   * Sets systemPrompt and clears messages before calling prompt(), then
   * extracts the final text from `state.messages`. Concurrent calls are
   * queued and run strictly one at a time. When `persist` is true and
   * text is non-empty, appends the result as an assistant message to
   * the canonical session.
   */
  async call(opts: RunnerCallOpts): Promise<string> {
    const next = this.inFlight.then(async () => {
      // Refresh the agent's tool snapshot for symmetry with Orchestrator.runPrompt
      // so that any post-boot tool registrations are visible to this call.
      // Filter to taskAgent-safe tools — background loops (news summarize,
      // event judge, tweet evaluate, cron delivery, …) must never trigger
      // a confirm card or run a write/exec tool. Allowed set =
      // `READ_TOOLS` ∪ {save_memory, cron} (see ToolRegistry.taskAgentTools).
      const tools = this.registry.taskAgentTools();
      this.agent.state.tools = tools;

      // Clear any channel/chatId context that a previous Orchestrator call may
      // have left on OriginAware tools.  Runner calls (background jobs, cron)
      // are not initiated by an inbound message, so they must not inherit a
      // prior chat session's origin.
      // Invariant: Orchestrator sets origin per inbound; Runner clears it per call.
      // (See also: src/tools/context-aware.ts)
      for (const tool of tools) {
        if (isOriginAware(tool)) tool.setOrigin("", "");
      }

      this.agent.state.systemPrompt = opts.systemPrompt;
      this.agent.state.messages = [];

      await this.runPromptWithTimeout(opts.message, opts.timeoutMs ?? RUNNER_CALL_TIMEOUT_MS);

      const finalText = extractFinalAssistantText(this.agent.state.messages);

      if (!finalText) {
        // Distinguish "agent decided silent" from "agent was cut off mid-stream".
        // A turn that called a tool but never produced a following text turn is
        // the cut-off signature; no tool calls + no text is a deliberate silent.
        const sawToolCall = hasToolCall(this.agent.state.messages);
        this.logger.warn(
          { cutOff: sawToolCall, messageCount: this.agent.state.messages.length },
          sawToolCall
            ? "runner: agent produced no final text — tool calls made but no follow-up text (likely truncated)"
            : "runner: agent produced no final text — agent decided silent or empty response",
        );
      }

      if (opts.persist && finalText) {
        const session = this.sessionManager.getOrCreate(MAIN_SESSION_KEY);
        // pi-ai AssistantMessage's required fields (api/provider/model/usage/stopReason)
        // are elided — these synthetic turns are persisted to session JSONL only
        // and never round-trip through pi-ai consumers. If a future codepath
        // rehydrates messages from JSONL and feeds them back to pi-ai, check
        // metadata.synthetic === true to skip synthetic turns.
        session.addMessage({
          role: "assistant",
          content: [{ type: "text", text: finalText }],
          timestamp: Date.now(),
          // synthetic: true — do not feed back into pi-ai (missing required api/
          // provider/model/usage/stopReason fields that pi-ai AssistantMessage needs).
        } as Message);
      }

      return finalText;
    });
    // Anchor chain on success or failure — subsequent calls still queue.
    this.inFlight = next.catch(() => undefined);
    return next;
  }

  /**
   * Run `agent.prompt` with a hard ceiling. On timeout, abort the agent so
   * the loop unwinds and the mutex is freed, then reject. The next queued
   * call resets `state.messages`/`state.systemPrompt`, so an aborted run
   * leaves no dirty state behind.
   */
  private async runPromptWithTimeout(message: string, timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.agent.abort();
        reject(new Error(`runner: agent run exceeded ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const run = this.agent.prompt(message);
    // On timeout `run` is abandoned but still settles later (abort rejects the
    // stream). Swallow that so it never surfaces as a fatal unhandled rejection.
    void run.catch(() => undefined);
    try {
      await Promise.race([run, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * Walk messages from the end and return the last assistant turn's text.
 * Returns "" when no assistant turn produced any text-bearing content.
 */
function extractFinalAssistantText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: string; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    let text = "";
    for (const block of msg.content as ContentBlock[]) {
      if (block?.type === "text" && typeof block.text === "string") {
        text += block.text;
      }
    }
    if (text.trim().length > 0) return text;
  }
  return "";
}

/** True when any assistant message in the buffer issued a tool call. */
function hasToolCall(messages: unknown[]): boolean {
  for (const m of messages) {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
    for (const block of msg.content as ContentBlock[]) {
      if (block?.type === "toolCall") return true;
    }
  }
  return false;
}
