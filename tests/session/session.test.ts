import { describe, test, expect } from "bun:test";
import { Session } from "../../src/session/session.js";
import type { Message, UserMessage, AssistantMessage, ToolResultMessage, ToolCall, TextContent } from "@earendil-works/pi-ai";

function userMsg(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function assistantMsg(text: string, toolCalls: ToolCall[] = []): AssistantMessage {
  const content: (TextContent | ToolCall)[] = [{ type: "text", text }];
  content.push(...toolCalls);
  return {
    role: "assistant",
    content,
    api: "openai" as never,
    provider: "openai" as never,
    model: "gpt-4",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolCall(id: string, name: string): ToolCall {
  return { type: "toolCall", id, name, arguments: {} };
}

function toolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

describe("Session", () => {
  describe("addMessage()", () => {
    test("appends messages", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("hello"));
      s.addMessage(assistantMsg("hi"));
      expect(s.messages).toHaveLength(2);
    });

    test("updates updatedAt", () => {
      const s = new Session({ key: "test" });
      const before = s.updatedAt;
      s.addMessage(userMsg("hello"));
      expect(s.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe("lastActiveAt", () => {
    test("is null on construction with no opts", () => {
      const s = new Session({ key: "test" });
      expect(s.lastActiveAt).toBeNull();
    });

    test("updates when role:user message is added", () => {
      const s = new Session({ key: "test" });
      expect(s.lastActiveAt).toBeNull();
      s.addMessage(userMsg("hello"));
      expect(s.lastActiveAt).not.toBeNull();
      expect(s.lastActiveAt!.getTime()).toBeGreaterThan(0);
    });

    test("does NOT update when assistant message is added", () => {
      const s = new Session({ key: "test" });
      s.addMessage(assistantMsg("hi from agent"));
      expect(s.lastActiveAt).toBeNull();
    });

    test("does NOT update when toolResult message is added", () => {
      const s = new Session({ key: "test" });
      s.addMessage(toolResult("tc-1", "some_tool", "result text"));
      expect(s.lastActiveAt).toBeNull();
    });

    test("constructor lastActiveAt opt is honored", () => {
      const fixedDate = new Date("2025-01-01T12:00:00Z");
      const s = new Session({ key: "test", lastActiveAt: fixedDate });
      expect(s.lastActiveAt).toEqual(fixedDate);
    });

    test("subsequent user messages advance lastActiveAt", async () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("first"));
      const first = s.lastActiveAt!.getTime();
      // Ensure measurable time passes
      await new Promise((r) => setTimeout(r, 5));
      s.addMessage(userMsg("second"));
      expect(s.lastActiveAt!.getTime()).toBeGreaterThanOrEqual(first);
    });
  });

  describe("getHistory()", () => {
    test("returns all messages when under maxMessages", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("a"));
      s.addMessage(assistantMsg("b"));
      expect(s.getHistory()).toHaveLength(2);
    });

    test("returns only unconsolidated messages", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("old"));
      s.addMessage(assistantMsg("old reply"));
      s.lastConsolidated = 2;
      s.addMessage(userMsg("new"));
      s.addMessage(assistantMsg("new reply"));
      const history = s.getHistory();
      expect(history).toHaveLength(2);
      expect((history[0] as UserMessage).content).toBe("new");
    });

    test("limits to maxMessages", () => {
      const s = new Session({ key: "test" });
      for (let i = 0; i < 10; i++) {
        s.addMessage(userMsg(`msg ${i}`));
        s.addMessage(assistantMsg(`reply ${i}`));
      }
      const history = s.getHistory(4);
      expect(history).toHaveLength(4);
    });

    test("drops leading non-user messages", () => {
      const s = new Session({ key: "test" });
      s.addMessage(assistantMsg("orphan assistant"));
      s.addMessage(userMsg("real user msg"));
      s.addMessage(assistantMsg("real reply"));
      const history = s.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].role).toBe("user");
    });

    test("returns empty when no user messages", () => {
      const s = new Session({ key: "test" });
      s.addMessage(assistantMsg("orphan"));
      expect(s.getHistory()).toHaveLength(0);
    });

    test("removes orphan tool results", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("do something"));
      // Orphan tool result — no matching assistant tool call
      s.addMessage(toolResult("orphan-id", "some_tool", "result"));
      s.addMessage(assistantMsg("reply"));
      const history = s.getHistory();
      expect(history).toHaveLength(2); // user + assistant (orphan dropped)
    });

    test("keeps matched tool results", () => {
      const s = new Session({ key: "test" });
      const tc = toolCall("tc-1", "shell");
      s.addMessage(userMsg("run ls"));
      s.addMessage(assistantMsg("", [tc]));
      s.addMessage(toolResult("tc-1", "shell", "file1\nfile2"));
      s.addMessage(assistantMsg("found 2 files"));
      const history = s.getHistory();
      expect(history).toHaveLength(4); // user + assistant(toolcall) + toolresult + assistant
    });

    test("handles multiple tool calls in one assistant message", () => {
      const s = new Session({ key: "test" });
      const tc1 = toolCall("tc-1", "shell");
      const tc2 = toolCall("tc-2", "file_read");
      s.addMessage(userMsg("do two things"));
      s.addMessage(assistantMsg("", [tc1, tc2]));
      s.addMessage(toolResult("tc-1", "shell", "ok"));
      s.addMessage(toolResult("tc-2", "file_read", "content"));
      s.addMessage(assistantMsg("done"));
      const history = s.getHistory();
      expect(history).toHaveLength(5);
    });

    // --- tool_use/tool_result pairing repair (HTTP 400 dangling-pair guard) ---

    test("strips an unanswered tool_use but keeps the assistant text", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("go"));
      // tool_use never answered (turn aborted before the result was persisted)
      s.addMessage(assistantMsg("let me check", [toolCall("tc-x", "shell")]));
      s.addMessage(userMsg("still there?"));
      const history = s.getHistory();
      // No toolResult, and the dangling tool_use block must be gone.
      expect(history.some((m) => m.role === "toolResult")).toBe(false);
      const assistant = history.find((m) => m.role === "assistant") as AssistantMessage;
      expect(assistant.content.some((p) => (p as ToolCall).type === "toolCall")).toBe(false);
      expect(assistant.content.some((p) => (p as TextContent).type === "text")).toBe(true);
    });

    test("drops an assistant whose only content was an unanswered tool_use", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("go"));
      // assistant with NO text, just the unanswered tool call
      s.addMessage({ ...assistantMsg(""), content: [toolCall("tc-x", "shell")] });
      s.addMessage(userMsg("ping"));
      const history = s.getHistory();
      expect(history.every((m) => m.role === "user")).toBe(true);
      expect(history.some((m) => m.role === "toolResult")).toBe(false);
    });

    test("drops a tool_result orphaned by an intervening assistant (adjacency)", () => {
      const s = new Session({ key: "test" });
      // assistant(X) is never answered before assistant(Y) appears; results
      // arrive afterwards. Replaying this verbatim is the HTTP 400 shape:
      // tool_result X's previous message would be assistant(Y), not assistant(X).
      s.addMessage(userMsg("go"));
      s.addMessage(assistantMsg("a", [toolCall("tc-x", "shell")]));
      s.addMessage(assistantMsg("b", [toolCall("tc-y", "file_read")]));
      s.addMessage(toolResult("tc-x", "shell", "x out"));
      s.addMessage(toolResult("tc-y", "file_read", "y out"));
      const history = s.getHistory();
      // Only the adjacent, fully-paired group survives: assistant(Y) + result Y.
      const results = history.filter((m) => m.role === "toolResult") as ToolResultMessage[];
      expect(results.map((r) => r.toolCallId)).toEqual(["tc-y"]);
      // Every surviving tool_result is immediately preceded by an assistant that declares it.
      for (let i = 0; i < history.length; i++) {
        if (history[i].role !== "toolResult") continue;
        const prev = history[i - 1] as AssistantMessage | undefined;
        const id = (history[i] as ToolResultMessage).toolCallId;
        expect(prev?.role).toBe("assistant");
        expect(prev!.content.some((p) => (p as ToolCall).type === "toolCall" && (p as ToolCall).id === id)).toBe(true);
      }
    });

    test("drops a tool_result not directly following its assistant", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("go"));
      s.addMessage(assistantMsg("plain reply"));
      s.addMessage(toolResult("tc-z", "shell", "stray"));
      s.addMessage(assistantMsg("more"));
      const history = s.getHistory();
      expect(history.some((m) => m.role === "toolResult")).toBe(false);
    });
  });

  describe("clear()", () => {
    test("resets messages and lastConsolidated", () => {
      const s = new Session({ key: "test" });
      s.addMessage(userMsg("hello"));
      s.lastConsolidated = 1;
      s.clear();
      expect(s.messages).toHaveLength(0);
      expect(s.lastConsolidated).toBe(0);
    });
  });
});
