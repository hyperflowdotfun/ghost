/**
 * Session — append-only conversation history with smart retrieval.
 *
 * Messages are APPEND-ONLY for LLM cache efficiency.
 * Consolidation writes to MEMORY.md/HISTORY.md but never mutates messages.
 */
import type { Message, AssistantMessage, ToolResultMessage, ToolCall } from "@earendil-works/pi-ai";

/**
 * Canonical session key for the single Ghost user session. Used by Orchestrator,
 * Runner, and any tool that needs to read/write the user's chat history.
 * Defined here (not in Orchestrator) so peers don't have to import the
 * orchestrator just to address its session.
 */
export const MAIN_SESSION_KEY = "main";

export interface SessionSummary {
  key: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

/** Callback invoked when a message is appended to a session. */
export type OnAppendCallback = (message: Message) => void;

export class Session {
  readonly key: string;
  readonly messages: Message[] = [];
  readonly createdAt: Date;
  updatedAt: Date;
  /**
   * Timestamp of the most recent role:"user" message.
   * Null when no user has sent a message yet (fresh session or assistant-only session).
   * Updated only on user messages so background writes (cron, proactive) do not reset it.
   */
  lastActiveAt: Date | null;
  metadata: Record<string, unknown>;
  /** Index of first unconsolidated message. getHistory() returns messages from here onward. */
  lastConsolidated: number;
  /** Optional callback for append-only persistence. Set by SessionManager. */
  onAppend?: OnAppendCallback;

  constructor(opts: {
    key: string;
    messages?: Message[];
    createdAt?: Date;
    updatedAt?: Date;
    lastActiveAt?: Date | null;
    metadata?: Record<string, unknown>;
    lastConsolidated?: number;
    onAppend?: OnAppendCallback;
  }) {
    this.key = opts.key;
    if (opts.messages) this.messages.push(...opts.messages);
    this.createdAt = opts.createdAt ?? new Date();
    this.updatedAt = opts.updatedAt ?? new Date();
    // Explicit null means "no user message ever" — undefined means caller didn't set it
    this.lastActiveAt = opts.lastActiveAt !== undefined ? opts.lastActiveAt : null;
    this.metadata = opts.metadata ?? {};
    this.lastConsolidated = opts.lastConsolidated ?? 0;
    this.onAppend = opts.onAppend;
  }

  /** Append a message. Triggers onAppend callback for immediate persistence. */
  addMessage(message: Message): void {
    this.messages.push(message);
    this.updatedAt = new Date();
    // Track user-only activity so proactive and briefing skills can measure real absence.
    // Background writes (cron delivery, proactive assistant turns) do not reset this.
    if (message.role === "user") {
      this.lastActiveAt = new Date();
    }
    this.onAppend?.(message);
  }

  /**
   * Get history for LLM context — unconsolidated messages with legal boundaries.
   *
   * 1. Slice from lastConsolidated
   * 2. Take recent maxMessages
   * 3. Align to user turn (drop leading non-user messages)
   * 4. Repair tool_use / tool_result pairing so the window is API-valid
   */
  getHistory(maxMessages = 500): Message[] {
    const unconsolidated = this.messages.slice(this.lastConsolidated);
    const recent = unconsolidated.slice(-maxMessages);

    // Align to user turn: drop leading non-user messages
    const userAligned = dropLeadingNonUser(recent);

    // Repair tool_use / tool_result pairing
    return sanitizeToolPairing(userAligned);
  }

  /** Reset session to initial state. */
  clear(): void {
    this.messages.length = 0;
    this.lastConsolidated = 0;
    this.updatedAt = new Date();
  }
}

/** Drop messages until the first user message. */
function dropLeadingNonUser(messages: Message[]): Message[] {
  const firstUser = messages.findIndex(m => m.role === "user");
  if (firstUser < 0) return [];
  return messages.slice(firstUser);
}

/**
 * Repair tool_use / tool_result pairing so the window satisfies the LLM API
 * contract: every assistant `tool_use` must be answered by a `tool_result` in
 * the immediately following run of toolResult messages, and every
 * `tool_result` must answer a `tool_use` in the assistant right before it.
 *
 * Walks the window keeping only fully-paired, adjacent groups:
 * - Unanswered tool_use blocks are stripped from the assistant message (its
 *   text is preserved; the message is dropped only if nothing remains).
 * - tool_result messages that don't answer the immediately-preceding
 *   assistant — orphans, or any toolResult not directly after an assistant —
 *   are dropped.
 *
 * This self-heals histories left malformed by aborted turns, context pruning,
 * or consolidation that split a tool_use/tool_result pair — the shapes that
 * otherwise make the provider reject the whole request (HTTP 400).
 */
function sanitizeToolPairing(messages: Message[]): Message[] {
  const out: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    if (msg.role === "assistant") {
      const useIds = toolUseIds(msg as AssistantMessage);
      if (useIds.size === 0) {
        out.push(msg);
        i += 1;
        continue;
      }

      // Gather the run of tool results that immediately follows this assistant.
      let j = i + 1;
      const run: ToolResultMessage[] = [];
      while (j < messages.length && messages[j].role === "toolResult") {
        run.push(messages[j] as ToolResultMessage);
        j += 1;
      }
      const resultIds = new Set(run.map((r) => r.toolCallId));

      // Keep only tool_use blocks that have a matching result in the run.
      const keptUseIds = new Set([...useIds].filter((id) => resultIds.has(id)));
      const trimmed = trimAssistantToolCalls(msg as AssistantMessage, keptUseIds);
      if (trimmed) out.push(trimmed);
      for (const r of run) {
        if (keptUseIds.has(r.toolCallId)) out.push(r);
      }

      i = j; // skip the consumed result run (any unmatched results are dropped)
    } else if (msg.role === "toolResult") {
      // A tool result not directly after its assistant tool_use — orphan, drop.
      i += 1;
    } else {
      out.push(msg);
      i += 1;
    }
  }

  return out;
}

/** Collect the ids of every `tool_use` block declared by an assistant message. */
function toolUseIds(msg: AssistantMessage): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(msg.content)) return ids;
  for (const part of msg.content) {
    if (isToolCall(part)) ids.add(part.id);
  }
  return ids;
}

/**
 * Return the assistant message with only the kept tool_use blocks (all
 * non-toolCall content is preserved). Returns null when nothing remains — e.g.
 * an assistant whose sole content was an unanswered tool_use.
 */
function trimAssistantToolCalls(
  msg: AssistantMessage,
  keptUseIds: Set<string>,
): AssistantMessage | null {
  if (!Array.isArray(msg.content)) return msg;
  const content = msg.content.filter(
    (part) => !isToolCall(part) || keptUseIds.has((part as ToolCall).id),
  );
  if (content.length === 0) return null;
  return { ...msg, content };
}

function isToolCall(part: unknown): part is ToolCall {
  return typeof part === "object" && part !== null && (part as ToolCall).type === "toolCall";
}
