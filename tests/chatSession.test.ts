import { describe, expect, it, vi } from "vitest";
import { ChatSession } from "../src/chatSession";
import type { MuxFrame, ServerRequestFrame } from "../src/protocolTypes";

/** mock DshClient：只记录 call，帧由测试直接注入 handleFrame。 */
function makeMockClient() {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const client = {
    call: vi.fn(async (method: string, payload: unknown) => {
      calls.push({ method, payload });
      if (method === "session.create") return { sessionId: "session-test" };
      return { ok: true };
    }),
    addMuxListener: vi.fn(() => () => {}),
  };
  return { client, calls };
}

function frame(payload: MuxFrame, rpcId = "rpc-x"): ServerRequestFrame<MuxFrame> {
  return { type: "server-request", rpcId, method: payload.type, payload };
}

function sessionEvent(event: { type: string; data?: Record<string, unknown> }): ServerRequestFrame<MuxFrame> {
  return frame({ type: "session/event", sessionId: "session-test", event });
}

function chunk(chunk: Record<string, unknown>): ServerRequestFrame<MuxFrame> {
  return sessionEvent({ type: "assistant/chunk", data: { turn: 1, step: 1, chunk } });
}

function makeSession() {
  const { client, calls } = makeMockClient();
  const messages: ReturnType<ChatSession["getMessages"]> = [];
  const states: string[] = [];
  const errors: string[] = [];
  let sessionId: string | null = null;
  const session = new ChatSession(client as never, {
    onMessagesChanged: (m) => messages.push(m),
    onStateChange: (s) => states.push(s),
    onError: (m) => errors.push(m),
    onSessionId: (id) => (sessionId = id),
  });
  return { session, client, calls, messages: () => messages[messages.length - 1] ?? [], states: () => states, errors: () => errors, getSessionId: () => sessionId };
}

describe("ChatSession 会话层", () => {
  it("open 创建会话并回调 sessionId", async () => {
    const { session, calls, getSessionId } = makeSession();
    await session.open("/tmp/vault");
    expect(calls[0]).toEqual({ method: "session.create", payload: { cwd: "/tmp/vault" } });
    expect(getSessionId()).toBe("session-test");
  });

  it("send 以 queue 模式发送文本", async () => {
    const { session, calls } = makeSession();
    await session.open("/tmp/vault");
    await session.send("  你好  ");
    expect(calls[1]).toEqual({
      method: "session.prompt",
      payload: { sessionId: "session-test", mode: "queue", content: [{ type: "text", text: "你好" }] },
    });
  });

  it("用户消息帧 → 追加用户消息", () => {
    const { session, messages } = makeSession();
    session.handleFrame(sessionEvent({ type: "user/message", data: { content: [{ type: "text", text: "你好" }] } }));
    const list = messages();
    expect(list).toHaveLength(1);
    expect(list[0].role).toBe("user");
    expect(list[0].blocks[0]).toEqual({ kind: "text", text: "你好" });
  });

  it("turn/start + text-delta 流式累积 → 完成", () => {
    const { session, messages, states } = makeSession();
    session.handleFrame(sessionEvent({ type: "turn/start" }));
    expect(states()).toEqual(["busy"]);
    session.handleFrame(chunk({ type: "text-delta", text: "你好，" }));
    session.handleFrame(chunk({ type: "text-delta", text: "世界" }));
    session.handleFrame(sessionEvent({ type: "assistant/message" }));
    session.handleFrame(sessionEvent({ type: "turn/end" }));

    const list = messages();
    expect(states()).toEqual(["busy", "idle"]);
    const msg = list[0];
    expect(msg.role).toBe("assistant");
    expect(msg.status).toBe("done");
    expect(msg.blocks).toEqual([{ kind: "text", text: "你好，世界" }]);
  });

  it("reasoning 块：block-start + reasoning-delta 折叠累积", () => {
    const { session, messages } = makeSession();
    session.handleFrame(sessionEvent({ type: "turn/start" }));
    session.handleFrame(chunk({ type: "block-start", blockType: "reasoning" }));
    session.handleFrame(chunk({ type: "reasoning-delta", text: "用户" }));
    session.handleFrame(chunk({ type: "reasoning-delta", text: "想聊天" }));
    session.handleFrame(chunk({ type: "block-end", block: { type: "reasoning", text: "" } }));
    session.handleFrame(chunk({ type: "text-delta", text: "好的！" }));
    session.handleFrame(sessionEvent({ type: "assistant/message" }));

    const msg = messages()[0];
    expect(msg.blocks).toHaveLength(2);
    expect(msg.blocks[0]).toEqual({ kind: "reasoning", text: "用户想聊天" });
    expect(msg.blocks[1]).toEqual({ kind: "text", text: "好的！" });
  });

  it("工具卡片：tool/call → tool/result 更新状态与结果", () => {
    const { session, messages } = makeSession();
    session.handleFrame(sessionEvent({ type: "turn/start" }));
    session.handleFrame(chunk({ type: "text-delta", text: "我来查" }));
    session.handleFrame(
      sessionEvent({ type: "tool/call", data: { name: "bash", arguments: '{"command":"ls"}' } })
    );
    session.handleFrame(
      sessionEvent({
        type: "tool/result",
        data: { message: { content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "file1.txt\nfile2.txt" }] }] } },
      })
    );
    session.handleFrame(sessionEvent({ type: "assistant/message" }));

    const msg = messages()[0];
    expect(msg.blocks).toHaveLength(2);
    const tool = msg.blocks[1];
    expect(tool.kind).toBe("tool");
    if (tool.kind === "tool") {
      expect(tool.toolName).toBe("bash");
      expect(tool.toolStatus).toBe("done");
      expect(tool.toolResult).toContain("file1.txt");
    }
  });

  it("finish/error chunk → 消息标记错误并展示信息（M0 F3 断点回归）", () => {
    const { session, messages } = makeSession();
    session.handleFrame(sessionEvent({ type: "turn/start" }));
    session.handleFrame(
      chunk({ type: "finish", reason: { kind: "error", failure: { message: "llm-deepseek: no API key" } } })
    );
    const msg = messages()[0];
    expect(msg.status).toBe("error");
    expect(msg.error).toContain("no API key");
  });

  it("question/requested → 阶段 3 占位系统提示", () => {
    const { session, messages } = makeSession();
    session.handleFrame(
      frame({ type: "question/requested", sessionId: "s", questions: [{ id: "q1", question: "今天想喝什么？" }] })
    );
    const list = messages();
    expect(list[0].role).toBe("system");
    expect(list[0].blocks[0].text).toContain("今天想喝什么？");
  });

  it("cancel 调用 session.cancel", async () => {
    const { session, calls } = makeSession();
    await session.open("/tmp/vault");
    await session.cancel();
    expect(calls[1]).toEqual({ method: "session.cancel", payload: { sessionId: "session-test" } });
  });

  it("setModel / setReasoningEffort / setPermissionPreset 写入正确 settings ns", async () => {
    const { session, calls } = makeSession();
    await session.setModel("deepseek-v4-pro");
    expect(calls[0]).toEqual({ method: "settings.update", payload: { ns: "agent-default-model", patch: { model: "deepseek-v4-pro" } } });
    await session.setReasoningEffort("max");
    expect(calls[1]).toEqual({ method: "settings.update", payload: { ns: "agent-default-model", patch: { reasoningEffort: "max" } } });
    await session.setPermissionPreset("danger-full-access");
    expect(calls[2]).toEqual({ method: "settings.update", payload: { ns: "permission", patch: { defaultPreset: "danger-full-access" } } });
  });
});
