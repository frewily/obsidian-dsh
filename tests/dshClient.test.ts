import { afterEach, describe, expect, it, vi } from "vitest";
import { DshClient, DshRpcError } from "../src/dshClient";

/** 可手动驱动的假 WebSocket。 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn(() => {
    this.onclose?.();
  });

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  emitOpen(): void {
    this.onopen?.();
  }
  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
  emitClose(): void {
    this.onclose?.();
  }
  emitError(): void {
    this.onerror?.();
  }
}

function jsonResponse(obj: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => obj } as Response;
}

function makeClient(events: Parameters<typeof DshClient.prototype.constructor>[1] = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const reply = (value: unknown) => jsonResponse({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } });
    switch (body.method) {
      case "host.describe":
        return reply({ version: "test" });
      case "session.create":
        return reply({ sessionId: "session-test-1", agentPreset: "standard" });
      case "session.prompt":
        return reply({ accepted: true });
      default:
        return reply(undefined);
    }
  });
  const client = new DshClient(
    { baseUrl: "http://127.0.0.1:1", backoffBaseMs: 10 },
    events,
    { fetchImpl: fetchMock as never, WebSocketImpl: FakeWebSocket as never, randomUUID: () => "rpc-1" }
  );
  return { client, fetchMock };
}

/** 让连接进入 connected：依次打开两个 WS（mux 先于 host 创建）+ 握手。 */
async function connectThrough(client: DshClient): Promise<void> {
  const p = client.connect();
  while (FakeWebSocket.instances.length < 1) await new Promise((r) => setTimeout(r, 10));
  FakeWebSocket.instances[0].emitOpen();
  while (FakeWebSocket.instances.length < 2) await new Promise((r) => setTimeout(r, 10));
  FakeWebSocket.instances[1].emitOpen();
  await p;
}

afterEach(() => {
  FakeWebSocket.reset();
  vi.useRealTimers();
});

describe("DshClient RPC", () => {
  it("call 成功返回 result.value", async () => {
    const { client, fetchMock } = makeClient();
    const value = await client.call("session.create", { cwd: "/tmp" });
    expect(value).toEqual({ sessionId: "session-test-1", agentPreset: "standard" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1/api/session.create");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({ type: "client-request", rpcId: "rpc-1", method: "session.create", payload: { cwd: "/tmp" } });
  });

  it("call 失败抛 DshRpcError（含 code/message）", async () => {
    const { client, fetchMock } = makeClient();
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return jsonResponse({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: false, error: { code: "not-found", message: "no such session", details: {} } },
      });
    });
    await expect(client.call("session.prompt", {})).rejects.toMatchObject({ name: "DshRpcError", code: "not-found", message: "no such session" });
    await expect(client.call("session.prompt", {})).rejects.toBeInstanceOf(DshRpcError);
  });

  it("respondQuestion 发送 client-response 信封并回显 rpcId", async () => {
    const { client, fetchMock } = makeClient();
    await client.respondQuestion("q-rpc-1", "session-test-1", {
      answers: [{ id: "q1", selected: ["奶茶"] }],
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:1/api/respond");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toEqual({
      type: "client-response",
      rpcId: "q-rpc-1",
      result: { ok: true, value: { sessionId: "session-test-1", answer: { answers: [{ id: "q1", selected: ["奶茶"] }] } } },
    });
  });
});

describe("DshClient 连接与事件分发", () => {
  it("connect → 打开 mux/host 双通道 → 握手 → connected", async () => {
    const states: string[] = [];
    const { client } = makeClient({ onStateChange: (s) => states.push(s) });
    await connectThrough(client);
    expect(client.isConnected()).toBe(true);
    expect(states).toContain("connected");
    expect(FakeWebSocket.instances.map((w) => w.url)).toEqual([
      "ws://127.0.0.1:1/api/events.mux",
      "ws://127.0.0.1:1/api/events.host",
    ]);
  });

  it("mux 帧分发：question/requested 到达 onMuxFrame", async () => {
    const frames: unknown[] = [];
    const { client } = makeClient({ onMuxFrame: (f) => frames.push(f) });
    await connectThrough(client);
    FakeWebSocket.instances[0].emitMessage(
      JSON.stringify({
        type: "server-request",
        rpcId: "q-1",
        method: "question/requested",
        payload: { type: "question/requested", sessionId: "s1", questions: [{ id: "q1", question: "今天想喝什么？" }] },
      })
    );
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { payload: { type: string; questions: Array<{ id: string }> } };
    expect(frame.payload.type).toBe("question/requested");
    expect(frame.payload.questions[0].id).toBe("q1");
  });

  it("mux 断开 → reconnecting → 重连成功", async () => {
    const states: string[] = [];
    const { client } = makeClient({ onStateChange: (s) => states.push(s) });
    await connectThrough(client);

    // 断开 mux
    FakeWebSocket.instances[0].emitClose();
    await vi.waitFor(() => expect(states).toContain("reconnecting"));

    // 退避后重连：新 mux 先创建，open 后新 host 才创建
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(3));
    FakeWebSocket.instances[2].emitOpen();
    await vi.waitFor(() => expect(FakeWebSocket.instances.length).toBe(4));
    FakeWebSocket.instances[3].emitOpen();
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));
  });

  it("disconnect 停止循环并断开", async () => {
    const { client } = makeClient();
    await connectThrough(client);
    await client.disconnect();
    expect(client.getState()).toBe("disconnected");
    expect(client.isConnected()).toBe(false);
  });
});
